/*!
 * Hermès — pont avec le SaaS
 *
 * Jusqu'ici les deux moitiés du système s'ignoraient : les prospects saisis ou
 * importés dans la console vivaient en base SQLite, la flotte d'agents
 * travaillait sur son propre `data/pipeline.json`, et rien ne circulait entre
 * les deux. Concrètement, une liste importée dans le CRM n'était jamais
 * démarchée, et un message envoyé par un agent n'apparaissait nulle part dans
 * la console.
 *
 * Ce module fait la jonction, dans les deux sens :
 *   - DESCENDANT : les prospects du CRM alimentent le pipeline d'Hermès ;
 *   - REMONTANT  : chaque envoi devient un changement de statut et une activité
 *                  datée sur la fiche, visible par un humain dans la console.
 *
 * L'authentification se fait par jeton d'agent (profil `prospection`), créé
 * depuis la console. Le jeton ne doit jamais être écrit dans le dépôt : il se
 * passe par la variable d'environnement RDF_SAAS_JETON.
 *
 *   RDF_SAAS_URL=https://app.eviatek.fr RDF_SAAS_JETON=… node agents/hermes.js synchro
 */
'use strict';

const P = require('./pipeline.js');

const DEFAUT_BASE = 'https://app.eviatek.fr';

/* ===================== Correspondance des états ===================== */

/*
 * Les deux systèmes ne découpent pas le cycle de vente pareil, et c'est
 * volontaire : Hermès distingue les relances (relance1, relance2) parce qu'il
 * doit savoir quel message écrire, là où la console n'a besoin que de savoir
 * que le prospect a été contacté. La correspondance est donc surjective dans un
 * sens, et l'on ne cherche pas à la rendre bijective.
 */
const VERS_CRM = {
  nouveau: 'nouveau', contacte: 'contacte', relance1: 'contacte', relance2: 'contacte',
  repondu: 'contacte', rdv: 'demo', essai: 'essai', gagne: 'client',
  perdu: 'perdu', exclu: 'perdu'
};

const DEPUIS_CRM = {
  nouveau: 'nouveau', a_contacter: 'nouveau', contacte: 'contacte', demo: 'rdv',
  essai: 'essai', client: 'gagne', perdu: 'perdu'
};

/* ===================== Conversion des fiches ===================== */

const chiffres = (v) => String(v || '').replace(/\D/g, '');

/** Fiche du CRM → fiche Hermès (celle qu'attendent `integrer` et la rédaction). */
function versFiche(p) {
  const id = chiffres(p.siret);
  return {
    saasId: p.id,
    nom: p.entreprise || '',
    siret: id.length === 14 ? id : '',
    // Le SIREN sert de clé du pipeline : on le dérive du SIRET quand il n'est
    // pas fourni seul, sinon deux établissements d'une même société créeraient
    // deux fiches concurrentes.
    siren: id.length === 14 ? id.slice(0, 9) : (id.length === 9 ? id : ''),
    ville: p.ville || '',
    departement: p.departement || '',
    siteWeb: p.site ? (/^https?:/.test(p.site) ? p.site : 'https://' + p.site) : '',
    emails: p.email ? [p.email] : [],
    telephones: p.telephone ? [p.telephone] : [],
    score: Number(p.score) || 0,
    sources: ['saas']
  };
}

/** Fiche Hermès → corps accepté par POST /api/v1/prospects. */
function versProspect(f) {
  return {
    entreprise: f.nom || '',
    email: (f.emails || [])[0] || '',
    telephone: (f.telephones || [])[0] || '',
    site: f.siteWeb || '',
    ville: f.ville || '',
    departement: f.departement || (f.codePostal ? String(f.codePostal).slice(0, 2) : ''),
    siret: f.siret || f.siren || '',
    score: Number(f.score) || 0,
    source: 'hermes',
    statut: VERS_CRM[f.etat] || 'nouveau'
  };
}

/* ===================== Client HTTP ===================== */

function creerClient(options = {}) {
  const base = String(options.base || process.env.RDF_SAAS_URL || DEFAUT_BASE).replace(/\/+$/, '');
  const jeton = options.jeton || process.env.RDF_SAAS_JETON || '';
  const appel = options.fetch || globalThis.fetch;
  if (!jeton) {
    throw new Error(
      'Jeton d’agent manquant. Créez-en un dans la console (onglet Jetons, profil ' +
      '« prospection ») puis exportez-le : RDF_SAAS_JETON=hs_…');
  }

  async function requete(methode, chemin, corps) {
    let rep;
    try {
      rep = await appel(base + chemin, {
        method: methode,
        headers: Object.assign(
          { Authorization: 'Bearer ' + jeton, Accept: 'application/json' },
          corps ? { 'Content-Type': 'application/json' } : {}),
        body: corps ? JSON.stringify(corps) : undefined
      });
    } catch (e) {
      throw new Error('SaaS injoignable sur ' + base + ' — ' + e.message);
    }

    // Les deux erreurs qu'on rencontre vraiment méritent mieux qu'un code brut :
    // c'est presque toujours un jeton absent, révoqué, ou d'un profil trop
    // étroit pour l'action demandée.
    if (rep.status === 401) throw new Error('Jeton refusé (401) : révoqué ou incorrect.');
    if (rep.status === 403) {
      throw new Error('Portée insuffisante (403) : ce jeton n’a pas le droit d’écrire ici. ' +
        'Le profil « prospection » est le minimum requis.');
    }
    const texte = await rep.text();
    let donnees = {};
    try { donnees = texte ? JSON.parse(texte) : {}; } catch (e) { /* réponse non JSON */ }
    if (!rep.ok) {
      throw new Error('SaaS ' + rep.status + ' sur ' + chemin + ' — ' + (donnees.erreur || texte.slice(0, 200)));
    }
    return donnees;
  }

  return {
    base,
    /** Vérifie le jeton et renvoie ses portées — à appeler avant tout le reste. */
    moi() { return requete('GET', '/api/v1/moi'); },

    async prospects(filtres = {}) {
      const q = new URLSearchParams();
      Object.entries(filtres).forEach(([k, v]) => { if (v !== undefined && v !== '') q.set(k, String(v)); });
      const r = await requete('GET', '/api/v1/prospects' + (q.toString() ? '?' + q : ''));
      return r.prospects || [];
    },

    creer(fiches) {
      return requete('POST', '/api/v1/prospects',
        { prospects: (Array.isArray(fiches) ? fiches : [fiches]).map(versProspect) });
    },

    majProspect(id, valeurs) { return requete('PATCH', '/api/v1/prospects/' + id, valeurs); },

    inspection(id, charge) { return requete('POST', '/api/v1/prospects/' + id + '/inspection', charge); },

    journaliser(id, type, corps) {
      return requete('POST', '/api/v1/prospects/' + id + '/activite', { type, corps });
    }
  };
}

/* ===================== Sens descendant : CRM → pipeline ===================== */

/**
 * Verse les prospects du CRM dans le pipeline.
 *
 * `integrer` protège délibérément l'état et l'historique des fiches déjà
 * connues : une synchronisation ne doit jamais rembobiner une relation
 * commerciale en cours. En revanche, une fiche qui arrive pour la première fois
 * n'a pas d'historique à protéger — son état initial est repris du CRM plutôt
 * que forcé à « nouveau », sans quoi un prospect déjà en essai côté console
 * recevrait un premier message de démarchage.
 */
async function descendre(store, client, opts = {}) {
  const bruts = await client.prospects({
    limite: opts.limite || 500,
    statut: opts.statut, departement: opts.departement
  });

  const avant = new Set(Object.keys(store.prospects));
  const fiches = bruts.map(versFiche).filter((f) => f.nom);
  const bilan = P.integrer(store, fiches, opts.maintenant);

  const date = (opts.maintenant || new Date()).toISOString().slice(0, 10);
  const parCle = new Map();
  fiches.forEach((f, i) => parCle.set(f.siren || f.siret || f.nom, bruts[i]));

  let repris = 0;
  for (const [cle, p] of Object.entries(store.prospects)) {
    // Le lien vers la fiche du CRM est reposé à chaque passage, y compris sur
    // les prospects déjà présents : sans lui, aucune remontée n'est possible.
    const brut = parCle.get(cle);
    if (brut && p.saasId !== brut.id) p.saasId = brut.id;

    if (avant.has(cle) || !brut) continue;
    const etat = DEPUIS_CRM[brut.statut] || 'nouveau';
    if (etat === 'nouveau' || p.etat === 'exclu') continue;
    p.etat = etat;
    p.derniereAction = date;
    p.historique.push({ date, evenement: 'synchro', detail: 'état repris du CRM (' + brut.statut + ')' });
    repris++;
  }

  return Object.assign(bilan, { lus: bruts.length, repris });
}

/* ===================== Sens remontant : pipeline → CRM ===================== */

/**
 * Reflète dans la console ce qu'un agent vient de faire. L'activité est écrite
 * même si le statut n'a pas bougé : c'est la trace datée qui permet à un humain
 * de reprendre la main sans rappeler quelqu'un qui vient d'être contacté.
 */
async function remonter(client, prospect, { type = 'email', corps = '', etat = null }) {
  if (!prospect.saasId) return { ignore: 'fiche non liée au CRM' };
  const fait = {};
  if (etat && VERS_CRM[etat]) {
    await client.majProspect(prospect.saasId, { statut: VERS_CRM[etat] });
    fait.statut = VERS_CRM[etat];
  }
  await client.journaliser(prospect.saasId, type, corps);
  fait.activite = type;
  return fait;
}

/**
 * Rapport d'inspection → charge attendue par l'API. Le découpage n'est pas
 * arbitraire : ce qui sert à filtrer (niveau, cible) monte en colonne, ce qui
 * ne sert qu'à lire (capacités, données, couleurs) reste dans le détail, où
 * l'ajout d'une nouvelle détection ne coûte pas une migration.
 */
function versInspection(rapport) {
  const r = rapport || {};
  if (!r.joignable) {
    return { date: (new Date()).toISOString().slice(0, 10), erreur: r.erreur || 'site non inspecté' };
  }
  const s = r.simulateur || {};
  const i = r.identite || {};
  return {
    date: (new Date()).toISOString().slice(0, 10),
    niveau: s.niveau,
    url: s.url || '',
    cible: r.verdict ? r.verdict.cible : undefined,
    raison: r.verdict ? r.verdict.raison : '',
    enseigne: i.nom || '',
    couleur: i.principale || '',
    couleurApercu: i.apercuPrincipale || '',
    detail: {
      libelle: s.libelle || '',
      capacites: s.capacites || [],
      donnees: s.donnees || [],
      editeurs: s.editeurs || [],
      couleurs: i.couleurs || [],
      couleurSecondaire: i.secondaire || '',
      couleurApercuSecondaire: i.apercuSecondaire || '',
      pagesVues: r.pagesVues || [],
      faits: r.faits || []
    }
  };
}

/** Écrit le rapport sur la fiche du CRM. Sans identifiant, il n'y a rien à faire. */
async function remonterInspection(client, prospect, rapport) {
  if (!prospect.saasId) return { ignore: 'fiche non liée au CRM' };
  await client.inspection(prospect.saasId, versInspection(rapport));
  return { inspection: true };
}

module.exports = {
  DEFAUT_BASE, VERS_CRM, DEPUIS_CRM,
  creerClient, versFiche, versProspect, descendre, remonter,
  versInspection, remonterInspection
};
