/*!
 * Hermès — Source « annuaire RGE » (entreprises Reconnues Garantes de l'Environnement)
 *
 * C'est la meilleure source pour notre cible : une entreprise qualifiée
 * **Quali'PV** installe du photovoltaïque, c'est écrit noir sur blanc, et
 * l'annuaire porte souvent son téléphone et son e-mail — ce que l'annuaire des
 * entreprises ne donne jamais.
 *
 * Deux modes d'alimentation :
 *   - API ouverte de l'ADEME (data.ademe.fr), sans clé ;
 *   - fichier CSV téléchargé à la main, si l'API change ou tombe.
 *
 * ⚠️ Le schéma exact du jeu de données n'a PAS pu être vérifié depuis
 * l'environnement de développement (domaines externes bloqués). Tout le module
 * est donc écrit **sans supposer aucun nom de colonne** : les champs sont
 * reconnus par la forme de leur intitulé. Un renommage côté ADEME dégrade la
 * collecte, il ne la casse pas.
 */
'use strict';

const fs = require('fs');
const { extraireEmails, extraireTelephones, decouperCsv } = require('./sourcing.js');

const CONFIG = {
  apiUrl: 'https://data.ademe.fr/data-fair/api/v1/datasets/liste-des-entreprises-rge-2/lines',
  parPage: 1000,
  timeoutMs: 20000,
  userAgent: 'HermesSourcing/1.0 (+https://www.eviatek.fr ; contact@eviatek.fr)'
};

/* ===================== Reconnaissance des champs ===================== */

// On cherche la première clé dont l'intitulé correspond, quelle que soit sa casse,
// ses accents ou ses séparateurs. Robuste à un renommage partiel.
const MOTIFS = {
  siret: /^(siret|siret_?etab|numero_?siret)$/,
  siren: /^(siren|numero_?siren)$/,
  nom: /(raison_?sociale|nom_?entreprise|nom_?de_?l_?entreprise|^nom$|denomination)/,
  adresse: /(adresse|voie|rue)/,
  codePostal: /(code_?postal|^cp$)/,
  ville: /(commune|ville|localite)/,
  telephone: /(telephone|^tel$|phone|portable)/,
  email: /(mail|courriel)/,
  siteWeb: /(site_?internet|site_?web|url|www)/,
  qualification: /(nom_?qualification|libelle_?qualification|qualification|certificat)/,
  domaine: /(domaine|meta_?domaine|categorie)/,
  organisme: /(organisme|certificateur)/,
  dateFin: /(date_?fin|fin_?validite|validite)/
};

function sansAccents(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[\s\-']/g, '_');
}

/** Construit une table intitulé-normalisé → clé réelle, une seule fois par jeu. */
function indexerChamps(cles) {
  const index = {};
  const normalisees = cles.map((k) => [sansAccents(k), k]);
  for (const [champ, motif] of Object.entries(MOTIFS)) {
    const trouve = normalisees.find(([n]) => motif.test(n));
    if (trouve) index[champ] = trouve[1];
  }
  return index;
}

const lire = (ligne, index, champ) => {
  const k = index[champ];
  const v = k ? ligne[k] : '';
  return v === null || v === undefined ? '' : String(v).trim();
};

/* ===================== Normalisation d'une ligne ===================== */

/** Une qualification photovoltaïque est le signal le plus fort de notre cible. */
function estPhotovoltaique(texte) {
  return /quali'?\s?pv|photovolta|solaire\s+photovolta/i.test(String(texte || ''));
}

function normaliserLigneRge(ligne, index) {
  const idx = index || indexerChamps(Object.keys(ligne || {}));
  const siretBrut = lire(ligne, idx, 'siret').replace(/\D/g, '');
  const sirenBrut = lire(ligne, idx, 'siren').replace(/\D/g, '');
  const siren = sirenBrut.length === 9 ? sirenBrut : (siretBrut.length === 14 ? siretBrut.slice(0, 9) : '');
  const nom = lire(ligne, idx, 'nom');
  if (!siren && !nom) return null;

  const qualification = lire(ligne, idx, 'qualification');
  const domaine = lire(ligne, idx, 'domaine');

  return {
    source: 'rge',
    nom,
    siren,
    siret: siretBrut.length === 14 ? siretBrut : '',
    adresse: lire(ligne, idx, 'adresse'),
    codePostal: (lire(ligne, idx, 'codePostal').match(/\d{5}/) || [''])[0],
    ville: lire(ligne, idx, 'ville'),
    siteWeb: lire(ligne, idx, 'siteWeb'),
    emails: extraireEmails(lire(ligne, idx, 'email')),
    telephones: extraireTelephones(lire(ligne, idx, 'telephone')),
    rge: true,
    qualifications: qualification || domaine ? [{
      nom: qualification,
      domaine,
      organisme: lire(ligne, idx, 'organisme'),
      dateFin: lire(ligne, idx, 'dateFin'),
      photovoltaique: estPhotovoltaique(qualification + ' ' + domaine)
    }] : []
  };
}

/**
 * Une entreprise apparaît une fois par qualification : on regroupe par SIREN et
 * on cumule les qualifications, sans quoi le croisement compterait des doublons.
 */
function regrouper(fiches) {
  const parCle = new Map();
  for (const f of fiches) {
    if (!f) continue;
    const cle = f.siren || (sansAccents(f.nom) + '|' + f.codePostal);
    const dejaLa = parCle.get(cle);
    if (!dejaLa) { parCle.set(cle, f); continue; }
    dejaLa.emails = [...new Set([...dejaLa.emails, ...f.emails])];
    dejaLa.telephones = [...new Set([...dejaLa.telephones, ...f.telephones])];
    dejaLa.siteWeb = dejaLa.siteWeb || f.siteWeb;
    for (const q of f.qualifications) {
      if (!dejaLa.qualifications.some((x) => x.nom === q.nom && x.domaine === q.domaine)) {
        dejaLa.qualifications.push(q);
      }
    }
  }
  return [...parCle.values()];
}

/* ===================== Alimentation ===================== */

async function depuisCsv(chemin) {
  const brut = fs.readFileSync(chemin, 'utf8');
  const lignes = brut.split(/\r?\n/).filter((l) => l.trim());
  if (!lignes.length) return [];
  const sep = (lignes[0].match(/;/g) || []).length >= (lignes[0].match(/,/g) || []).length ? ';' : ',';
  const entetes = decouperCsv(lignes[0], sep);
  const idx = indexerChamps(entetes);
  const out = [];
  for (let i = 1; i < lignes.length; i++) {
    const cols = decouperCsv(lignes[i], sep);
    const obj = {};
    entetes.forEach((h, j) => { obj[h] = cols[j]; });
    const f = normaliserLigneRge(obj, idx);
    if (f) out.push(f);
  }
  return regrouper(out);
}

async function depuisApi({ departement, qualification = 'photovolta', pages = 5 } = {}) {
  const out = [];
  let idx = null;
  for (let p = 0; p < pages; p++) {
    const params = new URLSearchParams({
      size: String(CONFIG.parPage),
      page: String(p + 1)
    });
    if (qualification) params.set('q', qualification);
    if (departement) params.set('qs', 'code_postal:' + departement + '*');

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), CONFIG.timeoutMs);
    let json;
    try {
      const rep = await fetch(CONFIG.apiUrl + '?' + params.toString(), {
        signal: ctrl.signal,
        headers: { 'User-Agent': CONFIG.userAgent, Accept: 'application/json' }
      });
      if (!rep.ok) throw new Error('HTTP ' + rep.status);
      json = await rep.json();
    } finally { clearTimeout(t); }

    // data-fair renvoie { results: [...] } ; on tolère d'autres enveloppes.
    const lignes = json.results || json.records || json.data || [];
    if (!lignes.length) break;
    if (!idx) idx = indexerChamps(Object.keys(lignes[0]));
    for (const l of lignes) {
      const f = normaliserLigneRge(l.fields || l, idx);
      if (f) out.push(f);
    }
    if (lignes.length < CONFIG.parPage) break;
  }
  return regrouper(out);
}

module.exports = {
  indexerChamps, normaliserLigneRge, regrouper, estPhotovoltaique,
  depuisCsv, depuisApi, sansAccents, CONFIG, MOTIFS
};
