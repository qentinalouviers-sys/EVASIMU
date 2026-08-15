/*!
 * Hermès — inspection du site d'un prospect
 *
 * La détection existante tenait en un regex sur la page d'accueil : elle
 * répondait « oui » ou « non » et s'arrêtait là. Insuffisant pour préparer un
 * message, parce que les deux cas qui comptent commercialement ne sont pas
 * « avec » et « sans » simulateur, mais :
 *
 *   - il n'en a pas          → l'argument est le lead qualifié ;
 *   - il en a un rudimentaire → l'argument est ce que le sien ne fait pas ;
 *   - il en a un excellent   → il ne faut pas lui écrire, on perd son temps.
 *
 * Ce module visite donc quelques pages, et en rapporte trois choses :
 *   1. LE SIMULATEUR — présent ou non, son adresse, son niveau technique, ce
 *      qu'il sait faire et les données qu'il réclame au visiteur ;
 *   2. L'IDENTITÉ VISUELLE — nom d'enseigne et couleurs dominantes, de quoi
 *      préparer un aperçu personnalisé ;
 *   3. DES FAITS CITABLES — ce que la rédaction pourra mentionner pour prouver
 *      qu'on a réellement regardé leur site.
 *
 * Politesse, parce qu'on visite le site de quelqu'un d'autre :
 *   - `robots.txt` est lu et respecté ;
 *   - le robot s'identifie et donne un moyen de le joindre ;
 *   - une requête à la fois, avec un délai, et un plafond de pages par site.
 *
 * Aucun accès réseau n'est nécessaire pour tester ce module : toutes les
 * analyses sont des fonctions pures qui prennent du HTML, et le récupérateur
 * est injectable.
 *
 *   node agents/hermes.js inspection --limite 20
 */
'use strict';

const CONFIG = {
  userAgent: 'HermesInspection/1.0 (+https://qentinalouviers-sys.github.io/EVASIMU/ ; contact@eviatek.fr)',
  timeoutMs: 12000,
  delaiEntrePagesMs: 1500,
  pagesMax: 6,
  cssMax: 3,
  tailleMaxOctets: 1500000
};

// Chemins où un simulateur se trouve quand il existe. Testés seulement si un
// lien de la page d'accueil ne l'a pas déjà révélé.
const CHEMINS_CANDIDATS = [
  '/simulateur', '/simulation', '/simuler', '/estimation', '/estimez',
  '/calculateur', '/calculez', '/etude-gratuite', '/mon-projet'
];

/* ===================== Récupération polie ===================== */

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

function normaliserUrl(brut) {
  const s = String(brut || '').trim();
  if (!s) return '';
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s).toString();
  } catch (e) {
    return '';
  }
}

async function recuperer(url, opts = {}) {
  const appel = opts.fetch || globalThis.fetch;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || CONFIG.timeoutMs);
  try {
    const rep = await appel(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': CONFIG.userAgent, 'Accept-Language': 'fr' },
      redirect: 'follow'
    });
    if (!rep.ok) return { ok: false, statut: rep.status, texte: '', url };
    const texte = (await rep.text()).slice(0, CONFIG.tailleMaxOctets);
    return { ok: true, statut: rep.status, texte, url: rep.url || url };
  } catch (e) {
    return { ok: false, statut: 0, texte: '', url, erreur: e.name === 'AbortError' ? 'délai dépassé' : e.message };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Lecture de `robots.txt`. On ne prend que le groupe qui nous concerne — le
 * nôtre s'il existe, `*` sinon — et on ne retient que les `Disallow`.
 *
 * Volontairement conservateur : un `robots.txt` illisible ou injoignable
 * n'autorise pas tout, il fait juste retomber sur le comportement par défaut
 * (autorisé), qui est celui du protocole. En revanche un `Disallow: /` est
 * respecté sans discussion.
 */
function analyserRobots(texte, agent) {
  const lignes = String(texte || '').split(/\r?\n/);
  const groupes = [];
  let courant = null;
  for (const brute of lignes) {
    const ligne = brute.replace(/#.*$/, '').trim();
    if (!ligne) continue;
    const m = ligne.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const cle = m[1].toLowerCase();
    const val = m[2].trim();
    if (cle === 'user-agent') {
      if (!courant || courant.regles.length) { courant = { agents: [], regles: [] }; groupes.push(courant); }
      courant.agents.push(val.toLowerCase());
    } else if (courant && (cle === 'disallow' || cle === 'allow')) {
      courant.regles.push({ type: cle, chemin: val });
    }
  }
  const nom = String(agent || CONFIG.userAgent).toLowerCase();
  const propre = groupes.find((g) => g.agents.some((a) => a !== '*' && nom.includes(a)));
  const general = groupes.find((g) => g.agents.includes('*'));
  return (propre || general || { regles: [] }).regles;
}

function cheminAutorise(regles, chemin) {
  // La règle la plus spécifique gagne, et `Allow` l'emporte à longueur égale :
  // c'est la convention suivie par les principaux robots.
  let meilleure = null;
  for (const r of regles) {
    if (r.chemin === '') continue;              // « Disallow: » vide = tout permis
    if (!chemin.startsWith(r.chemin)) continue;
    if (!meilleure || r.chemin.length > meilleure.chemin.length ||
        (r.chemin.length === meilleure.chemin.length && r.type === 'allow')) meilleure = r;
  }
  return !meilleure || meilleure.type === 'allow';
}

/* ===================== Détection du simulateur ===================== */

// Éditeurs et outils tiers reconnaissables. Les bornes de mot sont
// indispensables : « photovoltaïque » contient « otovo ».
const EDITEURS = [
  [/\botovo\b/i, 'Otovo'],
  [/\bsunbooster\b/i, 'Sunbooster'],
  [/\blikewatt\b/i, 'Likewatt'],
  [/\barchelios\b/i, 'Archelios'],
  [/\bproject\s*sunroof\b/i, 'Google Project Sunroof'],
  [/\bmon-?devis-?solaire\b/i, 'Mon Devis Solaire'],
  [/\bhellio\b/i, 'Hellio'],
  [/\bsolarcheck\b/i, 'SolarCheck']
];

// Ce que le simulateur sait faire. Chaque capacité est un argument de vente en
// creux : celle qui manque chez eux est celle qu'on met en avant.
const CAPACITES = [
  ['adresse', /(saisissez|entrez|indiquez)\s+(votre\s+)?adresse|autocomplete[^"']*adresse|api-adresse\.data\.gouv|places\.googleapis|algolia.*places/i,
    'saisie d’adresse'],
  ['carte', /leaflet|mapbox|maps\.google|openlayers|maplibre|ign\.fr\/geoportail|geoportail/i,
    'fond cartographique'],
  ['photoAerienne', /orthophoto|photo\s+a[ée]rienne|vue\s+satellite|wmts|ortho-?imagerie/i,
    'photo aérienne'],
  ['dessinToiture', /dessin(ez|er)?\s+(votre\s+)?(toit|toiture|pan)|tracer\s+votre\s+toit|calepinage/i,
    'tracé de la toiture'],
  ['troisD', /three\.?js|webgl|babylon\.?js|vue\s+3d/i, 'vue 3D'],
  ['ombrage', /ombrage|masque\s+solaire|ombre\s+port[ée]e/i, 'calcul d’ombrage'],
  ['production', /kwc\b|kwh\/an|production\s+(estim[ée]e|annuelle)|puissance\s+cr[êe]te/i,
    'estimation de production'],
  ['financier', /retour\s+sur\s+investissement|rentabilit[ée]|amortissement|[ée]conomies\s+annuelles/i,
    'volet financier'],
  ['pvgis', /pvgis/i, 'appui PVGIS'],
  ['pdf', /(t[ée]l[ée]charg\w+|recevez)\s+(votre\s+)?(étude|rapport|pdf)|jspdf/i, 'étude PDF'],
  ['rdv', /calendly|prendre\s+rendez-vous|r[ée]server\s+un\s+cr[ée]neau/i, 'prise de rendez-vous']
];

// Ce que le formulaire réclame au visiteur. Utile à deux titres : mesurer la
// friction qu'ils imposent, et savoir quelles données ils récupèrent déjà.
const CHAMPS = [
  ['nom', /name\s*=\s*["'][^"']*(nom|name|firstname|lastname)[^"']*["']/i, 'nom'],
  ['email', /type\s*=\s*["']email["']|name\s*=\s*["'][^"']*(mail|courriel)[^"']*["']/i, 'e-mail'],
  ['telephone', /type\s*=\s*["']tel["']|name\s*=\s*["'][^"']*(tel|phone|mobile)[^"']*["']/i, 'téléphone'],
  ['adresse', /name\s*=\s*["'][^"']*(adresse|address|rue|street)[^"']*["']/i, 'adresse'],
  ['codePostal', /name\s*=\s*["'][^"']*(cp|code[_-]?postal|zip|postcode)[^"']*["']/i, 'code postal'],
  ['consommation', /name\s*=\s*["'][^"']*(conso|kwh|facture)[^"']*["']/i, 'consommation ou facture'],
  ['surface', /name\s*=\s*["'][^"']*(surface|m2|superficie)[^"']*["']/i, 'surface'],
  ['budget', /name\s*=\s*["'][^"']*budget[^"']*["']/i, 'budget']
];

const ANNONCES = [
  /simulateur\s+(solaire|photovolta|d.autoconsommation)/i,
  /simulez\s+(votre|vos)\s+(projet|économies|installation)/i,
  /calculez\s+(votre|vos)\s+(production|économies)/i,
  /estimation\s+(gratuite\s+)?en\s+ligne/i,
  /[ée]tude\s+(gratuite\s+)?en\s+ligne/i
];

/**
 * Niveau technique, de 0 à 4. La graduation n'est pas cosmétique : c'est elle
 * qui décide s'il faut écrire à ce prospect, et avec quel argument.
 *
 *   0 rien · 1 formulaire de devis · 2 calculateur · 3 cartographique · 4 avancé
 */
function niveauTechnique(cap, annonce) {
  if (cap.troisD || cap.photoAerienne || cap.dessinToiture) return 4;
  if (cap.carte && (cap.adresse || cap.production)) return 3;
  if (cap.production || (annonce && cap.financier)) return 2;
  if (annonce) return 1;
  return 0;
}

const LIBELLE_NIVEAU = [
  'aucun simulateur',
  'formulaire de devis seulement',
  'calculateur d’économies',
  'simulateur cartographique',
  'simulateur avancé'
];

/**
 * Analyse d'une page. `pages` est une liste { url, html } : les capacités sont
 * cumulées sur l'ensemble, car un simulateur vit rarement sur la page d'accueil.
 */
function analyserSimulateur(pages) {
  const cap = {};
  const capacites = [];
  const donnees = [];
  const editeurs = new Set();
  let annonce = false;
  let urlSim = '';

  for (const p of pages || []) {
    const html = String(p.html || '');
    const annoncee = ANNONCES.some((re) => re.test(html));
    if (annoncee) annonce = true;

    for (const [cle, re, libelle] of CAPACITES) {
      if (!cap[cle] && re.test(html)) { cap[cle] = true; capacites.push(libelle); }
    }
    for (const [cle, re, libelle] of CHAMPS) {
      if (!donnees.includes(libelle) && re.test(html)) donnees.push(libelle);
    }
    for (const [re, nom] of EDITEURS) if (re.test(html)) editeurs.add(nom);

    // La page qui porte le simulateur est celle qui l'annonce ET qui montre au
    // moins une capacité : sinon on retiendrait la page d'accueil qui se
    // contente d'y renvoyer.
    if (!urlSim && annoncee && capacites.length) urlSim = p.url || '';
  }

  const niveau = niveauTechnique(cap, annonce);
  return {
    present: niveau > 0,
    url: niveau > 0 ? urlSim : '',
    niveau,
    libelle: LIBELLE_NIVEAU[niveau],
    capacites,
    donnees,
    editeurs: [...editeurs]
  };
}

/* ===================== Identité visuelle ===================== */

function texteEntre(html, re) {
  const m = String(html || '').match(re);
  return m ? m[1].trim() : '';
}

/** Nom d'enseigne tel que le site l'affiche, pas tel que l'INSEE l'enregistre. */
function nomEnseigne(html) {
  const og = texteEntre(html, /<meta[^>]+property\s*=\s*["']og:site_name["'][^>]+content\s*=\s*["']([^"']+)["']/i);
  if (og) return og;
  const appli = texteEntre(html, /<meta[^>]+name\s*=\s*["']application-name["'][^>]+content\s*=\s*["']([^"']+)["']/i);
  if (appli) return appli;
  const titre = texteEntre(html, /<title[^>]*>([^<]+)<\/title>/i);
  if (!titre) return '';
  // Un titre de page est presque toujours « Sujet – Enseigne » : le dernier
  // segment est le bon, sauf s'il est manifestement une accroche.
  const parts = titre.split(/\s+[|–—-]\s+/).map((s) => s.trim()).filter(Boolean);
  const dernier = parts[parts.length - 1] || titre;
  return dernier.length <= 40 ? dernier : parts[0] || titre.slice(0, 40);
}

/* --- Couleurs --- */

function hexVersRvb(hex) {
  let h = String(hex || '').replace('#', '').toLowerCase();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rvbVersHex(r, v, b) {
  const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(v) + c(b);
}

function rvbVersTsl([r, v, b]) {
  const R = r / 255, V = v / 255, B = b / 255;
  const max = Math.max(R, V, B), min = Math.min(R, V, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let t;
  if (max === R) t = ((V - B) / d + (V < B ? 6 : 0)) / 6;
  else if (max === V) t = ((B - R) / d + 2) / 6;
  else t = ((R - V) / d + 4) / 6;
  return [t * 360, s, l];
}

function tslVersHex(t, s, l) {
  const h = ((t % 360) + 360) % 360 / 360;
  if (s === 0) return rvbVersHex(l * 255, l * 255, l * 255);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const canal = (x) => {
    let v = x < 0 ? x + 1 : (x > 1 ? x - 1 : x);
    if (v < 1 / 6) return p + (q - p) * 6 * v;
    if (v < 1 / 2) return q;
    if (v < 2 / 3) return p + (q - p) * (2 / 3 - v) * 6;
    return p;
  };
  return rvbVersHex(canal(h + 1 / 3) * 255, canal(h) * 255, canal(h - 1 / 3) * 255);
}

/** Gris, blancs et noirs : présents partout, ils ne disent rien de la marque. */
function estNeutre(hex) {
  const rvb = hexVersRvb(hex);
  if (!rvb) return true;
  const [, s, l] = rvbVersTsl(rvb);
  return s < 0.15 || l > 0.93 || l < 0.07;
}

/**
 * Couleur « proche mais pas identique ».
 *
 * Reproduire à l'identique la charte d'une entreprise dans un document
 * commercial que l'on signe, c'est risquer de laisser croire qu'il émane
 * d'elle. On décale donc la teinte de quelques degrés et on ajuste la
 * luminosité : l'aperçu reste manifestement à ses couleurs, sans être sa
 * charte. Le décalage est déterministe — le même prospect obtient toujours le
 * même rendu.
 */
function approcher(hex, ecartTeinte = 9) {
  const rvb = hexVersRvb(hex);
  if (!rvb) return '';
  const [t, s, l] = rvbVersTsl(rvb);
  // Le sens du décalage dépend de la teinte : deux marques voisines ne
  // reçoivent pas la même correction, et l'écart reste visible à l'œil expert.
  const sens = Math.round(t) % 2 === 0 ? 1 : -1;
  return tslVersHex(
    t + sens * ecartTeinte,
    Math.max(0.2, Math.min(0.9, s * 0.92)),
    Math.max(0.2, Math.min(0.72, l + (l < 0.5 ? 0.04 : -0.04)))
  );
}

const RE_HEX = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/g;
const RE_RGB = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g;
// Une couleur déclarée dans une variable nommée « primary », « brand » ou
// « accent » est la charte de la marque ; la même couleur croisée dans un
// fichier CSS peut n'être qu'une bordure.
const RE_VARIABLE = /--[\w-]*(primary|principal|brand|marque|accent|main|theme)[\w-]*\s*:\s*(#[0-9a-fA-F]{3,6}|rgba?\([^)]+\))/gi;

/**
 * Couleurs dominantes, par ordre de confiance. Les sources ne se valent pas :
 * `theme-color` est une déclaration explicite de la marque, une variable CSS
 * nommée l'est presque autant, une occurrence isolée dans une feuille de style
 * ne l'est pas du tout.
 */
function extraireCouleurs(sources) {
  const poids = new Map();
  const ajouter = (hex, p) => {
    if (!hex) return;
    const h = hex.toLowerCase();
    const rvb = hexVersRvb(h);
    if (!rvb || estNeutre(h)) return;
    poids.set(rvbVersHex(...rvb), (poids.get(rvbVersHex(...rvb)) || 0) + p);
  };

  for (const src of sources || []) {
    const texte = String(src.texte || '');
    if (src.type === 'html') {
      const theme = texteEntre(texte, /<meta[^>]+name\s*=\s*["']theme-color["'][^>]+content\s*=\s*["']([^"']+)["']/i);
      ajouter(theme, 100);
    }
    let m;
    RE_VARIABLE.lastIndex = 0;
    while ((m = RE_VARIABLE.exec(texte)) !== null) {
      const v = m[2];
      if (v.startsWith('#')) ajouter(v, 40);
      else {
        const n = v.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (n) ajouter(rvbVersHex(+n[1], +n[2], +n[3]), 40);
      }
    }
    RE_HEX.lastIndex = 0;
    while ((m = RE_HEX.exec(texte)) !== null) ajouter(m[0], 1);
    RE_RGB.lastIndex = 0;
    while ((m = RE_RGB.exec(texte)) !== null) ajouter(rvbVersHex(+m[1], +m[2], +m[3]), 1);
  }

  return [...poids.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([hex, p]) => ({ hex, poids: p }));
}

/** Identité exploitable pour un aperçu : nom, couleurs relevées et décalées. */
function identiteVisuelle(pages, feuilles) {
  const html = (pages || [])[0] || {};
  const sources = [{ type: 'html', texte: html.html || '' }]
    .concat((pages || []).slice(1).map((p) => ({ type: 'html', texte: p.html || '' })))
    .concat((feuilles || []).map((f) => ({ type: 'css', texte: f })));

  const couleurs = extraireCouleurs(sources);
  const principale = couleurs.length ? couleurs[0].hex : '';
  const secondaire = couleurs.length > 1 ? couleurs[1].hex : '';
  return {
    nom: nomEnseigne(html.html || ''),
    couleurs: couleurs.map((c) => c.hex),
    principale,
    secondaire,
    // Ce sont ces valeurs-là, et pas les originales, qui servent à l'aperçu.
    apercuPrincipale: principale ? approcher(principale) : '',
    apercuSecondaire: secondaire ? approcher(secondaire, 14) : ''
  };
}

/* ===================== Faits citables ===================== */

/**
 * De quoi écrire une accroche qui prouve qu'on a regardé. Une phrase vague
 * (« j'ai visité votre site ») ne prouve rien ; « votre simulateur demande la
 * facture avant de montrer quoi que ce soit » se vérifie.
 */
function faitsCitables(sim, identite) {
  const faits = [];
  if (!sim.present) faits.push('aucun simulateur détecté sur le site');
  else {
    faits.push('simulateur en place — ' + sim.libelle);
    if (sim.url) faits.push('accessible sur ' + sim.url);
    if (sim.editeurs.length) faits.push('outil tiers : ' + sim.editeurs.join(', '));
    if (sim.niveau <= 2 && !sim.capacites.includes('photo aérienne')) {
      faits.push('pas de visualisation de la toiture réelle');
    }
    if (sim.donnees.length) faits.push('demande au visiteur : ' + sim.donnees.join(', '));
  }
  if (identite.nom) faits.push('enseigne affichée : ' + identite.nom);
  if (identite.principale) faits.push('couleur dominante ' + identite.principale);
  return faits;
}

/**
 * Faut-il écrire à ce prospect ? Un installateur déjà doté d'un simulateur
 * avancé n'est pas une cible : lui écrire abîme la réputation d'envoi pour
 * rien. Le dire explicitement vaut mieux que de le laisser au score.
 */
/*
 * L'obsolescence d'un site est un argument de vente (le nôtre est moderne),
 * mais aussi un signal de priorité : un installateur qui traîne un site vieux
 * a plus de chances de vouloir un outil neuf. Trois signaux objectifs, mesurés
 * sans jugement esthétique :
 *   - pas de viewport → non adapté au mobile ;
 *   - copyright ancien → pas mis à jour ;
 *   - http sans s → pas de HTTPS.
 */
function analyserVetuste(pages, base) {
  const htmls = (pages || []).map((p) => String(p.html || ''));
  const signaux = [];

  if (!htmls.some((h) => /<meta[^>]+name\s*=\s*["']viewport/i.test(h))) {
    signaux.push('pas de viewport mobile');
  }

  let annee = null;
  for (const h of htmls) {
    const m = h.match(/(?:©|&copy;|copyright)\s*(?:20)?(\d{2,4})/i);
    if (m) {
      annee = parseInt(m[1], 10);
      if (annee < 100) annee += 2000;
      break;
    }
  }
  if (annee !== null && annee < new Date().getFullYear() - 5) {
    signaux.push('copyright ' + annee);
  }

  if (/^http:\/\//i.test(base || '')) signaux.push('site en http (pas de HTTPS)');

  return { vetuste: signaux.length >= 2, signaux };
}

function verdict(sim) {
  if (!sim.present) return { cible: true, raison: 'aucun simulateur : cible prioritaire' };
  if (sim.niveau >= 4) return { cible: false, raison: 'déjà équipé d’un simulateur avancé' };
  if (sim.niveau === 3) return { cible: true, raison: 'simulateur cartographique sans vue du toit réel' };
  return { cible: true, raison: 'simulateur rudimentaire (' + sim.libelle + ')' };
}

/* ===================== Visite d'un site ===================== */

/** Liens internes de la page d'accueil qui sentent le simulateur. */
function liensCandidats(html, base) {
  const trouves = [];
  const re = /<a[^>]+href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const texte = m[2].replace(/<[^>]*>/g, ' ');
    if (!/simul|estim|calcul|[ée]tude\s+gratuite|mon\s+projet/i.test(m[1] + ' ' + texte)) continue;
    try {
      const u = new URL(m[1], base);
      if (u.origin !== new URL(base).origin) continue;
      if (!trouves.includes(u.toString())) trouves.push(u.toString());
    } catch (e) { /* href inexploitable */ }
  }
  return trouves;
}

function feuillesDeStyle(html, base) {
  const out = [];
  const re = /<link[^>]+rel\s*=\s*["']stylesheet["'][^>]*>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const href = (m[0].match(/href\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!href) continue;
    try { out.push(new URL(href, base).toString()); } catch (e) { /* ignoré */ }
  }
  return out.slice(0, CONFIG.cssMax);
}

/**
 * Visite complète d'un site : accueil, pages candidates, feuilles de style.
 * Ne lève jamais — un site injoignable renvoie un rapport qui le dit.
 */
async function visiter(siteWeb, opts = {}) {
  const base = normaliserUrl(siteWeb);
  const rapport = {
    site: base, joignable: false, pagesVues: [], robotsRespecte: true,
    simulateur: null, identite: null, faits: [], verdict: null, erreur: ''
  };
  if (!base) { rapport.erreur = 'adresse de site inexploitable'; return rapport; }

  const pause = opts.sansPause ? 0 : (opts.delaiMs || CONFIG.delaiEntrePagesMs);
  const origine = new URL(base).origin;

  const rob = await recuperer(origine + '/robots.txt', opts);
  const regles = rob.ok ? analyserRobots(rob.texte, CONFIG.userAgent) : [];
  const permis = (u) => { try { return cheminAutorise(regles, new URL(u).pathname); } catch (e) { return false; } };

  if (!permis(base)) {
    rapport.robotsRespecte = false;
    rapport.erreur = 'robots.txt interdit la visite de ce site';
    return rapport;
  }

  const accueil = await recuperer(base, opts);
  if (!accueil.ok) {
    rapport.erreur = accueil.erreur || ('site injoignable (HTTP ' + accueil.statut + ')');
    return rapport;
  }
  rapport.joignable = true;
  const pages = [{ url: accueil.url, html: accueil.texte }];

  const aVisiter = liensCandidats(accueil.texte, base)
    .concat(CHEMINS_CANDIDATS.map((c) => origine + c))
    .filter((u, i, t) => t.indexOf(u) === i && u !== accueil.url && permis(u))
    .slice(0, (opts.pagesMax || CONFIG.pagesMax) - 1);

  for (const u of aVisiter) {
    if (pause) await attendre(pause);
    const r = await recuperer(u, opts);
    if (r.ok && r.texte) pages.push({ url: r.url, html: r.texte });
  }

  const feuilles = [];
  for (const u of feuillesDeStyle(accueil.texte, base).filter(permis)) {
    if (pause) await attendre(pause);
    const r = await recuperer(u, opts);
    if (r.ok) feuilles.push(r.texte);
  }

  rapport.pagesVues = pages.map((p) => p.url);
  rapport.simulateur = analyserSimulateur(pages);
  rapport.identite = identiteVisuelle(pages, feuilles);
  rapport.faits = faitsCitables(rapport.simulateur, rapport.identite);
  rapport.verdict = verdict(rapport.simulateur);
  rapport.vetuste = analyserVetuste(pages, base);
  return rapport;
}

/**
 * Report du rapport sur une fiche du pipeline. `aSimulateur` conserve sa
 * sémantique existante — la rédaction et le score s'en servent déjà — et les
 * détails viennent s'ajouter à côté.
 */
function enrichir(fiche, rapport) {
  if (!rapport || !rapport.joignable) {
    fiche.inspection = { date: (new Date()).toISOString().slice(0, 10), erreur: rapport ? rapport.erreur : 'non inspecté' };
    return fiche;
  }
  fiche.aSimulateur = rapport.simulateur.present;
  fiche.inspection = {
    date: (new Date()).toISOString().slice(0, 10),
    niveau: rapport.simulateur.niveau,
    libelle: rapport.simulateur.libelle,
    url: rapport.simulateur.url,
    capacites: rapport.simulateur.capacites,
    donnees: rapport.simulateur.donnees,
    editeurs: rapport.simulateur.editeurs,
    pagesVues: rapport.pagesVues.length,
    cible: rapport.verdict.cible,
    raison: rapport.verdict.raison,
    vetuste: rapport.vetuste.vetuste,
    signauxVetuste: rapport.vetuste.signaux
  };
  fiche.identite = rapport.identite;
  if (!fiche.nom && rapport.identite.nom) fiche.nom = rapport.identite.nom;
  return fiche;
}

module.exports = {
  CONFIG, CHEMINS_CANDIDATS, LIBELLE_NIVEAU,
  normaliserUrl, recuperer, analyserRobots, cheminAutorise,
  analyserSimulateur, niveauTechnique, nomEnseigne,
  hexVersRvb, rvbVersHex, rvbVersTsl, tslVersHex, estNeutre, approcher,
  extraireCouleurs, identiteVisuelle, faitsCitables, analyserVetuste, verdict,
  liensCandidats, feuillesDeStyle, visiter, enrichir
};
