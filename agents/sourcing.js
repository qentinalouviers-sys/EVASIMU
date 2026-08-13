/*!
 * Hermès — Agent de sourcing d'installateurs photovoltaïques
 *
 * Constitue une liste de prospects B2B pour le SaaS RDF-SOLAR, à partir de
 * sources publiques et réutilisables. Aucune dépendance npm : Node 18+ suffit.
 *
 * Chaîne de traitement :
 *   1. Recherche d'entreprises (annuaire officiel, gratuit, sans clé)
 *        → raison sociale, SIRET, adresse, effectif — mais AUCUN contact
 *   2. Recoupement facultatif avec l'annuaire RGE (open data ADEME, fichier local)
 *   3. Découverte du site web de l'entreprise
 *   4. Lecture des pages Contact et Mentions légales — la loi française impose
 *      d'y publier les coordonnées, c'est donc la source la plus fiable
 *   5. Détection d'un simulateur déjà en place → c'est l'argumentaire commercial
 *   6. Notation et export CSV + JSON
 *
 * Ce que cet agent ne fait PAS, volontairement :
 *   - il n'interroge ni Google Maps ni aucun moteur de recherche : leurs
 *     conditions interdisent de constituer un fichier de prospection ;
 *   - il n'envoie rien. Il produit une liste ; la prise de contact est un
 *     autre agent, avec validation humaine.
 *
 * Cadre légal (prospection B2B en France) :
 *   - e-mail : licite au titre de l'intérêt légitime si l'offre concerne le
 *     métier du destinataire, avec émetteur identifiable et désinscription ;
 *   - téléphone : Bloctel ne couvre que les particuliers, démarcher un
 *     professionnel est licite ;
 *   - l'agent respecte robots.txt, s'annonce, et espace ses requêtes.
 *
 * Usage :
 *   node agents/sourcing.js --ape 43.22B --departement 69 --pages 3
 *   node agents/sourcing.js --ape 43.21A,43.22B --departement 69,42 --rge rge.csv
 *   node agents/sourcing.js --help
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ===================== Configuration ===================== */

const CONFIG = {
  apiUrl: 'https://recherche-entreprises.api.gouv.fr/search',
  // Identifie le robot et donne un moyen de nous joindre : c'est ce qu'on
  // attend d'un crawler sérieux, et ça évite d'être bloqué à vue.
  userAgent: 'HermesSourcing/1.0 (+https://www.rdf-solar.fr ; contact@rdf-solar.fr)',
  delaiEntreRequetesMs: 1200,   // politesse : un site à la fois, sans rafale
  timeoutMs: 12000,
  pagesParDefaut: 2,
  parPage: 25,
  // Pages où les coordonnées sont légalement ou usuellement publiées
  cheminsContact: [
    '/contact', '/contact.html', '/contactez-nous', '/nous-contacter',
    '/mentions-legales', '/mentions-legales.html', '/mentions', '/legal'
  ]
};

// Codes APE qui couvrent l'installation photovoltaïque en France. À ajuster :
// beaucoup d'installateurs sont déclarés sous l'un ou l'autre selon leur origine
// (électricien, chauffagiste, couvreur).
const APE_PHOTOVOLTAIQUE = ['43.21A', '43.22B', '43.99C', '42.22Z'];

/* ===================== Utilitaires ===================== */

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...a) { if (!process.env.HERMES_SILENCE) console.log(...a); }

async function recuperer(url, options) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CONFIG.timeoutMs);
  try {
    return await fetch(url, Object.assign({
      signal: ctrl.signal,
      headers: { 'User-Agent': CONFIG.userAgent, 'Accept-Language': 'fr' },
      redirect: 'follow'
    }, options || {}));
  } finally {
    clearTimeout(t);
  }
}

/* ===================== 1. Annuaire des entreprises ===================== */

// Tranches d'effectif INSEE → libellé et borne basse exploitable pour le tri
const EFFECTIF = {
  NN: ['non renseigné', 0], '00': ['0 salarié', 0], '01': ['1 à 2 salariés', 1],
  '02': ['3 à 5 salariés', 3], '03': ['6 à 9 salariés', 6], '11': ['10 à 19 salariés', 10],
  '12': ['20 à 49 salariés', 20], '21': ['50 à 99 salariés', 50], '22': ['100 à 199 salariés', 100],
  '31': ['200 à 249 salariés', 200], '32': ['250 à 499 salariés', 250], '41': ['500 à 999 salariés', 500],
  '42': ['1 000 à 1 999 salariés', 1000], '51': ['2 000 à 4 999 salariés', 2000],
  '52': ['5 000 à 9 999 salariés', 5000], '53': ['10 000 et plus', 10000]
};

/**
 * Lecture défensive d'un résultat de l'API. Le format peut évoluer : une
 * absence de champ ne doit jamais interrompre la collecte.
 */
function normaliserEntreprise(r) {
  if (!r || typeof r !== 'object') return null;
  const siege = r.siege || {};
  const eff = EFFECTIF[r.tranche_effectif_salarie] || ['non renseigné', 0];
  const nom = r.nom_complet || r.nom_raison_sociale || r.sigle || '';
  if (!nom) return null;
  return {
    nom,
    siren: r.siren || '',
    siret: siege.siret || '',
    adresse: siege.adresse || '',
    codePostal: siege.code_postal || '',
    ville: siege.libelle_commune || siege.commune || '',
    departement: siege.departement || (siege.code_postal || '').slice(0, 2),
    ape: r.activite_principale || siege.activite_principale || '',
    apeLibelle: r.libelle_activite_principale || siege.libelle_activite_principale || '',
    effectif: eff[0],
    effectifMin: eff[1],
    dateCreation: r.date_creation || '',
    active: r.etat_administratif !== 'C',
    siteWeb: (r.complements && r.complements.site_web) || '',
    // remplis par les étapes suivantes
    rge: false, emails: [], telephones: [], aSimulateur: null, indices: [], score: 0
  };
}

async function chercherEntreprises({ ape, departement, page = 1, parPage = CONFIG.parPage }) {
  const p = new URLSearchParams({ page: String(page), per_page: String(parPage) });
  if (ape) p.set('activite_principale', ape);
  if (departement) p.set('departement', departement);
  // L'API exige un `q` : on cible le métier, les filtres font le reste.
  p.set('q', 'photovoltaique');
  const rep = await recuperer(CONFIG.apiUrl + '?' + p.toString());
  if (!rep.ok) throw new Error('Annuaire entreprises : HTTP ' + rep.status);
  const json = await rep.json();
  return {
    total: json.total_results || 0,
    pages: json.total_pages || 1,
    entreprises: (json.results || []).map(normaliserEntreprise).filter(Boolean)
  };
}

/* ===================== 2. Recoupement RGE (fichier local) ===================== */

/**
 * L'annuaire RGE est de l'open data, mais son schéma varie selon le millésime.
 * On ne suppose donc aucun nom de colonne : on repère les SIRET/SIREN par leur
 * forme, et on récupère e-mail et téléphone si des colonnes y ressemblent.
 */
function chargerRge(cheminCsv) {
  const brut = fs.readFileSync(cheminCsv, 'utf8');
  const lignes = brut.split(/\r?\n/).filter((l) => l.trim());
  if (!lignes.length) return new Map();

  const sep = (lignes[0].match(/;/g) || []).length >= (lignes[0].match(/,/g) || []).length ? ';' : ',';
  const entetes = decouperCsv(lignes[0], sep).map((h) => h.toLowerCase().trim());
  const iMail = entetes.findIndex((h) => /mail/.test(h));
  const iTel = entetes.findIndex((h) => /t[ée]l|phone/.test(h));

  const index = new Map();
  for (let i = 1; i < lignes.length; i++) {
    const cols = decouperCsv(lignes[i], sep);
    // Un SIRET fait 14 chiffres, un SIREN 9 : on prend la première colonne qui colle.
    let cle = '';
    for (const c of cols) {
      const d = String(c).replace(/\D/g, '');
      if (d.length === 14) { cle = d.slice(0, 9); break; }
      if (d.length === 9 && !cle) cle = d;
    }
    if (!cle) continue;
    const fiche = index.get(cle) || { rge: true, emails: [], telephones: [] };
    if (iMail >= 0 && cols[iMail]) fiche.emails.push(...extraireEmails(cols[iMail]));
    if (iTel >= 0 && cols[iTel]) fiche.telephones.push(...extraireTelephones(cols[iTel]));
    index.set(cle, fiche);
  }
  return index;
}

// Découpage CSV tolérant aux guillemets, sans dépendance
function decouperCsv(ligne, sep) {
  const out = [];
  let cur = '', dansGuillemets = false;
  for (let i = 0; i < ligne.length; i++) {
    const c = ligne[i];
    if (c === '"') {
      if (dansGuillemets && ligne[i + 1] === '"') { cur += '"'; i++; }
      else dansGuillemets = !dansGuillemets;
    } else if (c === sep && !dansGuillemets) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/* ===================== 3. Découverte du site ===================== */

const MOTS_VIDES = new Set([
  'sarl', 'sas', 'sasu', 'eurl', 'sa', 'sci', 'ets', 'etablissements', 'ste', 'societe',
  'et', 'de', 'du', 'des', 'la', 'le', 'les', 'entreprise'
]);

/** Réduit une raison sociale à des candidats de nom de domaine plausibles. */
function deviserDomaines(nom) {
  const mots = String(nom || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // accents
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((m) => m && !MOTS_VIDES.has(m));
  if (!mots.length) return [];
  const colle = mots.join('');
  const tiret = mots.join('-');
  const candidats = new Set();
  for (const base of [colle, tiret]) {
    if (base.length < 3 || base.length > 40) continue;
    candidats.add(base + '.fr');
    candidats.add(base + '.com');
  }
  return [...candidats];
}

/**
 * Vérifie qu'un hôte répond et renvoie l'URL retenue.
 * On essaie « www » puis le domaine nu, en HTTPS puis en HTTP : une partie des
 * sites d'artisans est encore servie en clair, et les ignorer reviendrait à
 * écarter des prospects parfaitement valables.
 */
async function tenterDomaine(hote) {
  const h = String(hote || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!h) return null;
  const candidats = [];
  // « www » n'a de sens que pour un vrai nom de domaine (ni port, ni adresse IP)
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(h) && !/^www\./i.test(h) && !/^\d+\./.test(h)) {
    candidats.push('https://www.' + h, 'http://www.' + h);
  }
  candidats.push('https://' + h, 'http://' + h);

  for (const url of candidats) {
    try {
      const rep = await recuperer(url, { method: 'GET' });
      if (rep.ok) {
        const html = await rep.text();
        // Un parking de domaine n'est pas un site d'entreprise
        if (/domaine (est )?(à vendre|réservé)|this domain is for sale|parking/i.test(html.slice(0, 4000))) continue;
        return { url: rep.url || url, html };
      }
    } catch (_) { /* injoignable dans cette combinaison : on essaie la suivante */ }
  }
  return null;
}

/* ===================== 4. Extraction des coordonnées ===================== */

const EXT_FICHIER = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ttf|ico|pdf)$/i;
const DOMAINES_BRUIT = /(sentry|wixpress|example|domain|votredomaine|votresite|monsite|email|adresse)\.(io|com|fr|net|org)$/i;

function extraireEmails(texte, domaineSite) {
  const out = new Map();   // conserve l'ordre et déduplique
  const re = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
  let m;
  while ((m = re.exec(String(texte || ''))) !== null) {
    const brut = m[0].replace(/\.$/, '');
    const mail = brut.toLowerCase();
    if (EXT_FICHIER.test(mail)) continue;                    // logo@2x.png & co
    if (DOMAINES_BRUIT.test(mail)) continue;                 // exemples de gabarit
    if (/^[0-9a-f]{16,}@/.test(mail)) continue;              // empreintes techniques
    if (mail.length > 80) continue;
    out.set(mail, true);
  }
  let liste = [...out.keys()];
  // Une adresse sur le domaine de l'entreprise vaut mieux qu'une adresse tierce
  if (domaineSite) {
    const racine = domaineSite.replace(/^www\./, '');
    liste.sort((a, b) => (b.endsWith('@' + racine) ? 1 : 0) - (a.endsWith('@' + racine) ? 1 : 0));
  }
  return liste;
}

function extraireTelephones(texte) {
  const out = new Set();
  // Un SIRET (14 chiffres) ne doit pas être pris pour un numéro : les
  // délimiteurs interdisent qu'un chiffre colle avant ou après.
  const re = /(?<!\d)(?:(?:\+|00)33[\s.\-]?(?:\(0\)[\s.\-]?)?|0)[1-9](?:[\s.\-]?\d{2}){4}(?!\d)/g;
  let m;
  while ((m = re.exec(String(texte || ''))) !== null) {
    // Le « (0) » de « +33 (0)4 … » est un chiffre en trop : il doit disparaître
    // AVANT le comptage, sinon le numéro est rejeté comme trop long.
    let d = m[0].replace(/\(0\)/g, '').replace(/\D/g, '');
    if (d.startsWith('0033')) d = d.slice(4);
    else if (d.startsWith('33') && d.length === 11) d = d.slice(2);
    else if (d.startsWith('0')) d = d.slice(1);
    if (d.length !== 9 || d[0] === '0') continue;
    out.add('0' + d);
  }
  return [...out];
}

/* ===================== 5. Détection d'un simulateur ===================== */

const INDICES_SIMULATEUR = [
  [/simulateur\s+(solaire|photovolta|d.autoconsommation)/i, 'simulateur solaire annoncé'],
  [/simulez\s+(votre|vos)\s+(projet|économies|installation)/i, 'invitation à simuler'],
  [/calculez\s+(votre|vos)\s+(production|économies)/i, 'calculateur de production'],
  [/estimation\s+en\s+ligne/i, 'estimation en ligne'],
  // Bornes de mot indispensables : « photovoltaïque » contient « otovo », et
  // sans \b tout site d'installateur serait marqué comme déjà équipé.
  [/\b(otovo|sunbooster|likewatt|archelios|project\s*sunroof)\b/i, 'outil tiers identifié']
];

function detecterSimulateur(html) {
  const indices = [];
  for (const [re, libelle] of INDICES_SIMULATEUR) if (re.test(html)) indices.push(libelle);
  return { aSimulateur: indices.length > 0, indices };
}

/* ===================== 6. Notation ===================== */

/**
 * Score sur 100. La logique commerciale est explicite ici, à ajuster librement :
 * un prospect joignable, actif, de taille pertinente et SANS simulateur est le
 * meilleur candidat — c'est précisément à lui que l'argumentaire s'adresse.
 */
function scorer(f) {
  let s = 0;
  const racine = (f.siteWeb || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  const mailPropre = f.emails.some((m) => racine && m.endsWith('@' + racine));

  if (mailPropre) s += 35;
  else if (f.emails.length) s += 20;
  if (f.telephones.length) s += 25;
  if (f.siteWeb) s += 10;
  if (f.rge) s += 10;
  if (f.aSimulateur === false) s += 15;      // l'opportunité est là
  else if (f.aSimulateur === true) s -= 10;  // déjà équipé : plus difficile
  if (f.effectifMin >= 3 && f.effectifMin <= 49) s += 5;   // cœur de cible
  if (!f.active) s -= 40;

  return Math.max(0, Math.min(100, s));
}

/* ===================== Enrichissement d'une fiche ===================== */

async function enrichir(f) {
  let site = null;

  if (f.siteWeb) {
    site = await tenterDomaine(f.siteWeb.replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
  }
  if (!site) {
    for (const d of deviserDomaines(f.nom)) {
      site = await tenterDomaine(d);
      if (site) break;
      await attendre(CONFIG.delaiEntreRequetesMs);
    }
  }
  if (!site) return f;

  f.siteWeb = site.url;
  const origine = new URL(site.url).origin;
  const racine = new URL(site.url).hostname.replace(/^www\./, '');

  const autorise = await robotsAutorise(origine);
  if (!autorise) { f.indices.push('robots.txt interdit l’exploration'); return f; }

  let texte = site.html;
  const det = detecterSimulateur(site.html);
  f.aSimulateur = det.aSimulateur;
  f.indices.push(...det.indices);

  // Les mentions légales sont obligatoires en France et portent les coordonnées
  for (const chemin of CONFIG.cheminsContact) {
    if (f.emails.length && f.telephones.length) break;
    await attendre(CONFIG.delaiEntreRequetesMs);
    try {
      const rep = await recuperer(origine + chemin);
      if (rep.ok) {
        const h = await rep.text();
        texte += '\n' + h;
        f.indices.push('coordonnées lues sur ' + chemin);
      }
    } catch (_) { /* page absente : normal */ }
    f.emails = extraireEmails(texte, racine);
    f.telephones = extraireTelephones(texte);
  }

  f.emails = extraireEmails(texte, racine);
  f.telephones = extraireTelephones(texte);
  return f;
}

async function robotsAutorise(origine) {
  try {
    const rep = await recuperer(origine + '/robots.txt');
    if (!rep.ok) return true;                       // pas de robots.txt = autorisé
    const txt = await rep.text();
    // Lecture volontairement simple : on ne cherche qu'un blocage global.
    const blocs = txt.split(/user-agent:/i).slice(1);
    for (const b of blocs) {
      const cible = b.split(/\r?\n/)[0].trim();
      if (cible !== '*') continue;
      if (/^\s*disallow:\s*\/\s*$/im.test(b)) return false;
    }
    return true;
  } catch (_) { return true; }
}

/* ===================== Export ===================== */

const COLONNES = [
  'score', 'nom', 'siret', 'ville', 'codePostal', 'departement', 'effectif',
  'siteWeb', 'email', 'emailsSecondaires', 'telephone', 'telephonesSecondaires',
  'aSimulateur', 'rge', 'ape', 'apeLibelle', 'indices'
];

function versCsv(fiches) {
  const echapper = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lignes = [COLONNES.join(';')];
  for (const f of fiches) {
    lignes.push([
      f.score, f.nom, f.siret, f.ville, f.codePostal, f.departement, f.effectif,
      f.siteWeb, f.emails[0] || '', f.emails.slice(1).join(' '),
      f.telephones[0] || '', f.telephones.slice(1).join(' '),
      f.aSimulateur === null ? 'inconnu' : (f.aSimulateur ? 'oui' : 'non'),
      f.rge ? 'oui' : 'non', f.ape, f.apeLibelle, f.indices.join(' | ')
    ].map(echapper).join(';'));
  }
  return lignes.join('\n');
}

function dedupe(fiches) {
  const vus = new Set();
  return fiches.filter((f) => {
    const cle = f.siren || f.siret || f.nom.toLowerCase();
    if (vus.has(cle)) return false;
    vus.add(cle);
    return true;
  });
}

/* ===================== Orchestration ===================== */

async function run(opts) {
  const apes = opts.ape ? String(opts.ape).split(',') : APE_PHOTOVOLTAIQUE;
  const departements = opts.departement ? String(opts.departement).split(',') : [null];
  const pages = Number(opts.pages) || CONFIG.pagesParDefaut;
  const rge = opts.rge ? chargerRge(opts.rge) : null;
  if (rge) log('Annuaire RGE chargé : ' + rge.size + ' entreprises');

  let fiches = [];
  for (const dep of departements) {
    for (const ape of apes) {
      for (let p = 1; p <= pages; p++) {
        try {
          const r = await chercherEntreprises({ ape, departement: dep, page: p });
          log(`  APE ${ape}${dep ? ' · dép. ' + dep : ''} · page ${p}/${Math.min(pages, r.pages)} → ${r.entreprises.length} entreprise(s) sur ${r.total}`);
          fiches.push(...r.entreprises);
          if (p >= r.pages) break;
        } catch (e) {
          log(`  ⚠ APE ${ape}${dep ? ' · dép. ' + dep : ''} page ${p} : ${e.message}`);
        }
        await attendre(CONFIG.delaiEntreRequetesMs);
      }
    }
  }

  fiches = dedupe(fiches).filter((f) => f.active);
  log(`\n${fiches.length} entreprise(s) après déduplication. Enrichissement…`);

  let n = 0;
  for (const f of fiches) {
    if (rge) {
      const r = rge.get(f.siren);
      if (r) {
        f.rge = true;
        f.emails.push(...r.emails);
        f.telephones.push(...r.telephones);
        f.indices.push('qualifiée RGE');
      }
    }
    try { await enrichir(f); }
    catch (e) { f.indices.push('enrichissement échoué : ' + e.message); }
    f.emails = [...new Set(f.emails)];
    f.telephones = [...new Set(f.telephones)];
    f.score = scorer(f);
    n++;
    if (n % 10 === 0) log(`  ${n}/${fiches.length}…`);
  }

  fiches.sort((a, b) => b.score - a.score);

  const base = opts.sortie ? String(opts.sortie).replace(/\.(csv|json)$/i, '') : 'prospects';
  const dossier = path.dirname(base);
  if (dossier && dossier !== '.') fs.mkdirSync(dossier, { recursive: true });
  fs.writeFileSync(base + '.csv', versCsv(fiches), 'utf8');
  fs.writeFileSync(base + '.json', JSON.stringify(fiches, null, 2), 'utf8');

  const joignables = fiches.filter((f) => f.emails.length || f.telephones.length);
  log(`\n✓ ${fiches.length} fiches écrites dans ${base}.csv et ${base}.json`);
  log(`  ${joignables.length} joignables (e-mail ou téléphone)`);
  log(`  ${fiches.filter((f) => f.aSimulateur === false).length} sans simulateur détecté — la cible prioritaire`);
  return fiches;
}

/* ===================== Ligne de commande ===================== */

function lireArguments(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const cle = argv[i].slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    o[cle] = val;
  }
  return o;
}

const AIDE = `
Hermès — agent de sourcing d'installateurs photovoltaïques

  --ape 43.22B,43.21A     Codes APE à balayer (défaut : ${APE_PHOTOVOLTAIQUE.join(', ')})
  --departement 69,42     Départements (défaut : toute la France)
  --pages 3               Pages d'annuaire par combinaison (défaut : ${CONFIG.pagesParDefaut}, 25 par page)
  --rge fichier.csv       Annuaire RGE local, pour marquer les qualifiées et récupérer leurs contacts
  --sortie dossier/nom    Préfixe des fichiers produits (défaut : prospects)
  --help                  Affiche cette aide

Exemple :
  node agents/sourcing.js --ape 43.22B --departement 69 --pages 3 --sortie data/lyon
`;

if (require.main === module) {
  const opts = lireArguments(process.argv.slice(2));
  if (opts.help) { console.log(AIDE); process.exit(0); }
  run(opts).catch((e) => { console.error('Échec :', e.message); process.exit(1); });
}

module.exports = {
  normaliserEntreprise, chercherEntreprises, chargerRge, decouperCsv,
  deviserDomaines, extraireEmails, extraireTelephones, detecterSimulateur,
  scorer, dedupe, versCsv, enrichir, robotsAutorise, run,
  CONFIG, APE_PHOTOVOLTAIQUE
};
