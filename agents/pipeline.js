/*!
 * Hermès — Pipeline commercial : l'état de chaque prospect, et sa mémoire
 *
 * Sans état persistant, une flotte d'agents redémarre à zéro à chaque
 * exécution : elle recontacte les mêmes entreprises, relance ceux qui ont déjà
 * répondu, et redémarche ceux qui ont demandé qu'on les laisse tranquilles.
 * Ce module est donc la pièce qui rend le reste utilisable.
 *
 * Il porte trois choses :
 *   1. l'ÉTAT de chaque prospect et ses transitions autorisées ;
 *   2. l'HISTORIQUE daté de ce qui a été fait — indispensable pour justifier
 *      une prise de contact et pour ne pas relancer deux fois le même jour ;
 *   3. le REGISTRE D'OPPOSITION. Une demande de désinscription doit être
 *      respectée immédiatement et définitivement : c'est une obligation légale,
 *      et l'exclusion est vérifiée avant toute rédaction.
 *
 * Le fichier d'état est un simple JSON, lisible et versionnable.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const VERSION = 1;

/* ===================== États et transitions ===================== */

const ETATS = {
  nouveau: 'jamais contacté',
  contacte: 'premier message envoyé',
  relance1: 'première relance envoyée',
  relance2: 'seconde relance envoyée',
  repondu: 'a répondu, à traiter',
  rdv: 'rendez-vous fixé',
  essai: 'essai gratuit en cours',
  gagne: 'client',
  perdu: 'a décliné',
  exclu: 'opposition enregistrée'
};

// Les transitions interdites ne sont pas de la rigidité : elles empêchent
// qu'un agent relance quelqu'un qui a déjà répondu ou s'est désinscrit.
const TRANSITIONS = {
  nouveau: ['contacte', 'exclu', 'perdu'],
  contacte: ['relance1', 'repondu', 'exclu', 'perdu'],
  relance1: ['relance2', 'repondu', 'exclu', 'perdu'],
  relance2: ['repondu', 'exclu', 'perdu'],
  repondu: ['rdv', 'essai', 'perdu', 'exclu', 'gagne'],
  rdv: ['essai', 'gagne', 'perdu', 'exclu'],
  essai: ['gagne', 'perdu', 'exclu'],
  gagne: ['perdu'],
  perdu: ['nouveau'],      // réactivation possible après une saison
  exclu: []                // définitif
};

const TERMINAUX = ['gagne', 'perdu', 'exclu'];

/* ===================== Chargement et écriture ===================== */

function vide() {
  return {
    version: VERSION,
    exclusions: { emails: [], domaines: [], sirens: [] },
    prospects: {}
  };
}

function charger(chemin) {
  if (!fs.existsSync(chemin)) return vide();
  const brut = JSON.parse(fs.readFileSync(chemin, 'utf8'));
  const store = Object.assign(vide(), brut);
  store.exclusions = Object.assign(vide().exclusions, brut.exclusions || {});
  store.prospects = brut.prospects || {};
  return store;
}

function enregistrer(store, chemin) {
  const dossier = path.dirname(chemin);
  if (dossier && dossier !== '.') fs.mkdirSync(dossier, { recursive: true });
  // Écriture atomique : une interruption ne doit pas laisser un état tronqué,
  // ce qui reviendrait à perdre l'historique de toute la prospection.
  const tmp = chemin + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, chemin);
  return chemin;
}

/* ===================== Registre d'opposition ===================== */

const domaineDe = (email) => String(email || '').split('@')[1] || '';

function estExclu(store, fiche) {
  const e = store.exclusions;
  if (fiche.siren && e.sirens.includes(fiche.siren)) return 'siren';
  for (const m of fiche.emails || []) {
    if (e.emails.includes(String(m).toLowerCase())) return 'email';
    if (e.domaines.includes(domaineDe(m).toLowerCase())) return 'domaine';
  }
  return null;
}

/**
 * Enregistre une opposition. On accepte aussi un domaine entier : quand un
 * interlocuteur demande à ne plus être contacté, c'est rarement pour sa seule
 * adresse nominative.
 */
function exclure(store, { email, domaine, siren }, motif, maintenant) {
  const date = (maintenant || new Date()).toISOString().slice(0, 10);
  const e = store.exclusions;
  if (email && !e.emails.includes(email.toLowerCase())) e.emails.push(email.toLowerCase());
  if (domaine && !e.domaines.includes(domaine.toLowerCase())) e.domaines.push(domaine.toLowerCase());
  if (siren && !e.sirens.includes(siren)) e.sirens.push(siren);

  // Bascule immédiate de tous les prospects concernés, y compris en cours.
  let touches = 0;
  for (const p of Object.values(store.prospects)) {
    const concerne =
      (siren && p.siren === siren) ||
      (email && (p.emails || []).some((m) => m.toLowerCase() === email.toLowerCase())) ||
      (domaine && (p.emails || []).some((m) => domaineDe(m).toLowerCase() === domaine.toLowerCase()));
    if (!concerne || p.etat === 'exclu') continue;
    p.etat = 'exclu';
    p.historique.push({ date, evenement: 'exclusion', detail: motif || 'opposition reçue' });
    touches++;
  }
  return touches;
}

/* ===================== Intégration des fiches ===================== */

const CHAMPS_FICHE = [
  'nom', 'siren', 'siret', 'codePostal', 'ville', 'departement', 'effectif',
  'siteWeb', 'emails', 'telephones', 'qualifPV', 'rge', 'aSimulateur', 'score', 'sources',
  // Résultat de la visite du site : niveau du simulateur existant, données
  // qu'il réclame, identité visuelle. C'est ce qui nourrit l'accroche.
  'inspection', 'identite',
  // Identifiant de la fiche correspondante dans le CRM du SaaS. C'est lui qui
  // permet de remonter un envoi dans la console ; sans lui, un agent travaille
  // en aveugle et rien n'est visible côté humain.
  'saasId'
];

/**
 * Ajoute les nouvelles fiches et rafraîchit les données des existantes SANS
 * toucher à leur état ni à leur historique : une recapture ne doit jamais
 * remettre à zéro une relation commerciale en cours.
 */
function integrer(store, fiches, maintenant) {
  const date = (maintenant || new Date()).toISOString().slice(0, 10);
  const bilan = { ajoutes: 0, actualises: 0, exclus: 0 };

  for (const f of fiches) {
    const cle = f.siren || f.siret || f.nom;
    if (!cle) continue;
    const motif = estExclu(store, f);

    if (!store.prospects[cle]) {
      const p = { etat: motif ? 'exclu' : 'nouveau', relances: 0, historique: [] };
      for (const c of CHAMPS_FICHE) p[c] = f[c];
      p.historique.push({ date, evenement: 'capture', detail: (f.sources || []).join('+') });
      if (motif) {
        p.historique.push({ date, evenement: 'exclusion', detail: 'déjà au registre (' + motif + ')' });
        bilan.exclus++;
      }
      store.prospects[cle] = p;
      bilan.ajoutes++;
      continue;
    }

    const p = store.prospects[cle];
    let change = false;
    for (const c of CHAMPS_FICHE) {
      if (c === 'emails' || c === 'telephones') {
        const avant = (p[c] || []).length;
        p[c] = [...new Set([...(p[c] || []), ...(f[c] || [])])];
        if (p[c].length !== avant) change = true;
      } else if (f[c] !== undefined && f[c] !== '' && f[c] !== p[c]) {
        p[c] = f[c]; change = true;
      }
    }
    if (change) {
      p.historique.push({ date, evenement: 'actualisation', detail: 'fiche enrichie' });
      bilan.actualises++;
    }
    // Une exclusion peut apparaître après coup : on la fait respecter ici aussi.
    if (motif && p.etat !== 'exclu') {
      p.etat = 'exclu';
      p.historique.push({ date, evenement: 'exclusion', detail: 'registre (' + motif + ')' });
      bilan.exclus++;
    }
  }
  return bilan;
}

/* ===================== Transitions ===================== */

function marquer(store, cle, etat, detail, maintenant) {
  const p = store.prospects[cle];
  if (!p) throw new Error('Prospect inconnu : ' + cle);
  if (!ETATS[etat]) throw new Error('État inconnu : ' + etat);
  if (p.etat === etat) return p;
  const permis = TRANSITIONS[p.etat] || [];
  if (!permis.includes(etat)) {
    throw new Error(`Transition interdite : ${p.etat} → ${etat} (autorisé : ${permis.join(', ') || 'aucune'})`);
  }
  const date = (maintenant || new Date()).toISOString().slice(0, 10);
  p.historique.push({ date, evenement: 'etat', detail: p.etat + ' → ' + etat + (detail ? ' · ' + detail : '') });
  p.etat = etat;
  p.derniereAction = date;
  if (etat === 'relance1' || etat === 'relance2') p.relances++;
  return p;
}

/* ===================== Sélection du travail à faire ===================== */

const jours = (a, b) => Math.floor((new Date(a) - new Date(b)) / 86400000);

/**
 * Qui doit être contacté maintenant.
 *   - `nouveau`   → premier message, s'il est joignable
 *   - `contacte`  → première relance après `delaiRelance1` jours de silence
 *   - `relance1`  → seconde relance après `delaiRelance2` jours
 * Les états terminaux et « repondu » ne sont jamais repris automatiquement :
 * quelqu'un qui a répondu mérite une réponse humaine, pas une séquence.
 */
function aTraiter(store, opts = {}) {
  const {
    delaiRelance1 = 7, delaiRelance2 = 14, maintenant = new Date(),
    exigerEmail = true, scoreMin = 0, limite = Infinity
  } = opts;
  const aujourdhui = maintenant.toISOString().slice(0, 10);
  const out = [];

  for (const [cle, p] of Object.entries(store.prospects)) {
    if (TERMINAUX.includes(p.etat) || p.etat === 'repondu' || p.etat === 'rdv' || p.etat === 'essai') continue;
    if ((p.score || 0) < scoreMin) continue;
    if (exigerEmail && !(p.emails || []).length) continue;
    // L'inspection du site a pu conclure que ce prospect n'est pas une cible —
    // typiquement un installateur déjà doté d'un simulateur plus avancé que le
    // nôtre. Lui écrire ne rapporte rien et consomme du quota d'envoi.
    if (p.inspection && p.inspection.cible === false) continue;

    let etape = null;
    if (p.etat === 'nouveau') etape = 'premier';
    else if (p.etat === 'contacte' && jours(aujourdhui, p.derniereAction) >= delaiRelance1) etape = 'relance1';
    else if (p.etat === 'relance1' && jours(aujourdhui, p.derniereAction) >= delaiRelance2) etape = 'relance2';
    if (!etape) continue;

    out.push({ cle, etape, prospect: p });
    if (out.length >= limite) break;
  }
  // Les meilleurs prospects d'abord : si le quota d'envoi est limité, autant
  // qu'il serve aux entreprises les plus susceptibles de convertir.
  return out.sort((a, b) => (b.prospect.score || 0) - (a.prospect.score || 0)).slice(0, limite);
}

function statistiques(store) {
  const parEtat = {};
  for (const e of Object.keys(ETATS)) parEtat[e] = 0;
  let joignables = 0;
  for (const p of Object.values(store.prospects)) {
    parEtat[p.etat] = (parEtat[p.etat] || 0) + 1;
    if ((p.emails || []).length || (p.telephones || []).length) joignables++;
  }
  const total = Object.keys(store.prospects).length;
  const contactes = parEtat.contacte + parEtat.relance1 + parEtat.relance2 +
    parEtat.repondu + parEtat.rdv + parEtat.essai + parEtat.gagne + parEtat.perdu;
  const reponses = parEtat.repondu + parEtat.rdv + parEtat.essai + parEtat.gagne;
  return {
    total, joignables, parEtat, contactes, reponses,
    tauxReponse: contactes ? Math.round((reponses / contactes) * 1000) / 10 : 0,
    exclusions: store.exclusions.emails.length + store.exclusions.domaines.length + store.exclusions.sirens.length
  };
}

module.exports = {
  VERSION, ETATS, TRANSITIONS, TERMINAUX,
  vide, charger, enregistrer,
  estExclu, exclure, integrer, marquer, aTraiter, statistiques
};
