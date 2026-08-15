/**
 * Clients (locataires du SaaS) : création, personnalisation, cycle de vie.
 *
 * La configuration d'un client est un JSON unique qui recouvre trois choses :
 *   theme      — logo, couleurs, arrondis, police
 *   marque     — coordonnées, horaires, promesses, mentions RGE / RGPD
 *   catalogue  — surcharge partielle du catalogue d'offres du simulateur
 * Tout ce qui n'est pas surchargé retombe sur le catalogue de référence
 * (config/offers.json), y compris les barèmes réglementaires : quand un arrêté
 * change, la mise à jour vaut pour tous les clients d'un coup.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { nowIso, idPublic, slugifier, json } = require('./db.js');
const billing = require('./billing.js');

const CATALOGUE_REFERENCE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'offers.json'), 'utf8')
);

const THEME_DEFAUT = {
  couleurPrincipale: '#0f2a43',
  couleurAccent: '#f59e0b',
  couleurFond: '#f6f8fa',
  arrondi: 12,
  police: 'system-ui, Segoe UI, Arial, sans-serif',
  logoUrl: '',
  afficherSoleil: true
};

/* ---------- Couleurs : validation et dérivations ---------- */

function hex(valeur, secours) {
  const v = String(valeur || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    return ('#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3]).toLowerCase();
  }
  return secours;
}

function melanger(couleur, vers, part) {
  const c = parseInt(couleur.slice(1), 16), d = parseInt(vers.slice(1), 16);
  const canal = (dec, i) => (dec >> (16 - 8 * i)) & 255;
  let out = '#';
  for (let i = 0; i < 3; i++) {
    const v = Math.round(canal(c, i) * (1 - part) + canal(d, i) * part);
    out += Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
  }
  return out;
}

const eclaircir = (c, p) => melanger(c, '#ffffff', p);
const assombrir = (c, p) => melanger(c, '#000000', p);

// Luminance relative (WCAG) — sert à choisir une couleur de texte lisible sur
// l'accent choisi par le client : un accent jaune vif exige du texte foncé.
function luminance(c) {
  const v = [0, 1, 2].map((i) => {
    const x = parseInt(c.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}

function contraste(a, b) {
  const l1 = luminance(a), l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function texteLisibleSur(fond) {
  return contraste(fond, '#ffffff') >= 4.5 ? '#ffffff' : '#16202b';
}

function normaliserTheme(brut) {
  const t = Object.assign({}, THEME_DEFAUT, brut || {});
  t.couleurPrincipale = hex(t.couleurPrincipale, THEME_DEFAUT.couleurPrincipale);
  t.couleurAccent = hex(t.couleurAccent, THEME_DEFAUT.couleurAccent);
  t.couleurFond = hex(t.couleurFond, THEME_DEFAUT.couleurFond);
  t.arrondi = Math.max(0, Math.min(28, parseInt(t.arrondi, 10) || THEME_DEFAUT.arrondi));
  t.police = String(t.police || THEME_DEFAUT.police).slice(0, 200);
  t.logoUrl = urlSure(t.logoUrl);
  t.afficherSoleil = t.afficherSoleil !== false;
  return t;
}

// Seules http(s) et les images en data: sont acceptées : pas de javascript:
function urlSure(u) {
  const v = String(u || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v.slice(0, 500);
  if (/^data:image\/(png|jpeg|jpg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/i.test(v)) return v.slice(0, 400000);
  return '';
}

/** Variables CSS injectées dans la page du widget. */
function cssDuTheme(theme) {
  const t = normaliserTheme(theme);
  const principale = t.couleurPrincipale;
  const accent = t.couleurAccent;
  return [
    '.evasimu{',
    '--evasimu-navy:' + principale + ';',
    '--evasimu-navy-2:' + eclaircir(principale, 0.12) + ';',
    '--evasimu-accent:' + accent + ';',
    '--evasimu-accent-deep:' + assombrir(accent, 0.28) + ';',
    '--evasimu-accent-clair:' + eclaircir(accent, 0.45) + ';',
    '--evasimu-bg:' + t.couleurFond + ';',
    '--evasimu-radius:' + t.arrondi + 'px;',
    '--evasimu-sur-accent:' + texteLisibleSur(accent) + ';',
    'font-family:' + t.police + ';',
    '}',
    // Le texte des boutons d'accent suit l'accent choisi : un jaune clair
    // reçoit du texte foncé, un bleu profond du texte blanc.
    '.evasimu .evasimu-btn-primary{color:var(--evasimu-sur-accent)}',
    '.evasimu .evasimu-cta-call{color:var(--evasimu-sur-accent)}'
  ].join('');
}

/* ---------- Fusion du catalogue ---------- */

function fusionner(base, surcharge) {
  if (!surcharge || typeof surcharge !== 'object' || Array.isArray(surcharge)) {
    return surcharge === undefined ? base : surcharge;
  }
  const out = Object.assign({}, base);
  Object.keys(surcharge).forEach((k) => {
    out[k] = (base && typeof base[k] === 'object' && !Array.isArray(base[k]))
      ? fusionner(base[k], surcharge[k]) : surcharge[k];
  });
  return out;
}

/**
 * Catalogue effectif servi au widget d'un client : référence + surcharges.
 * Les barèmes réglementaires restent ceux de la référence sauf surcharge
 * explicite — un client ne se retrouve pas figé sur un arrêté périmé.
 */
function catalogueEffectif(client) {
  const cfg = json(client.config, {}) || {};
  const cat = fusionner(CATALOGUE_REFERENCE, cfg.catalogue || {});
  cat.brand = fusionner(cat.brand, cfg.marque || {});
  if (!cat.brand.name) cat.brand.name = client.nom;
  const theme = normaliserTheme(cfg.theme);
  if (theme.logoUrl) cat.brand.logoUrl = theme.logoUrl;
  cat.brand.afficherSoleil = theme.afficherSoleil;
  return cat;
}

/* ---------- Dépôt ---------- */

function creerDepot(db) {
  const st = {
    parCle: db.prepare('SELECT * FROM clients WHERE cle = ?'),
    parSlug: db.prepare('SELECT * FROM clients WHERE slug = ?'),
    parId: db.prepare('SELECT * FROM clients WHERE id = ?'),
    lister: db.prepare('SELECT * FROM clients ORDER BY maj_le DESC'),
    creer: db.prepare(`INSERT INTO clients(cle, slug, nom, statut, formule, essai_fin,
      domaines, config, cree_le, maj_le, prospect_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`),
    majConfig: db.prepare('UPDATE clients SET config = ?, maj_le = ? WHERE id = ?'),
    majChamps: db.prepare(`UPDATE clients SET nom = ?, domaines = ?, formule = ?, maj_le = ? WHERE id = ?`),
    majStatut: db.prepare(`UPDATE clients SET statut = ?, essai_fin = ?, abonnement_fin = ?, maj_le = ? WHERE id = ?`),
    supprimer: db.prepare('DELETE FROM clients WHERE id = ?'),
    slugPris: db.prepare('SELECT 1 FROM clients WHERE slug = ?'),
    clePrise: db.prepare('SELECT 1 FROM clients WHERE cle = ?'),
    leadsLiberer: db.prepare('UPDATE leads SET retenu = 0 WHERE client_id = ? AND retenu = 1')
  };

  function slugLibre(base) {
    let s = slugifier(base), n = 1;
    while (st.slugPris.get(s)) { s = slugifier(base) + '-' + (++n); }
    return s;
  }
  function cleLibre() {
    let c = idPublic(10);
    while (st.clePrise.get(c)) c = idPublic(10);
    return c;
  }

  return {
    lister() {
      return st.lister.all().map((c) => Object.assign({}, c, { etat: billing.etat(c) }));
    },
    parCle(cle) {
      const c = st.parCle.get(cle);
      return c ? Object.assign({}, c, { etat: billing.etat(c) }) : null;
    },
    parSlug(slug) {
      const c = st.parSlug.get(slug);
      return c ? Object.assign({}, c, { etat: billing.etat(c) }) : null;
    },
    parId(id) {
      const c = st.parId.get(id);
      return c ? Object.assign({}, c, { etat: billing.etat(c) }) : null;
    },

    creer({ nom, formule, essaiJours, domaines, config, prospectId }) {
      if (!nom || !String(nom).trim()) { const e = new Error('nom requis'); e.code = 400; throw e; }
      const jours = essaiJours === 0 ? 0
        : (essaiJours || billing.FORMULES.essaiJoursDefaut);
      const t = nowIso();
      const cle = cleLibre();
      st.creer.run(
        cle, slugLibre(nom), String(nom).trim(),
        jours > 0 ? 'essai' : 'suspendu',
        billing.formule(formule).id,
        jours > 0 ? billing.dansNJours(jours) : null,
        normaliserDomaines(domaines),
        JSON.stringify(normaliserConfig(config)),
        t, t, prospectId || null
      );
      return this.parCle(cle);
    },

    majConfig(client, patch) {
      const actuelle = json(client.config, {}) || {};
      const fusion = normaliserConfig(fusionner(actuelle, patch || {}));
      st.majConfig.run(JSON.stringify(fusion), nowIso(), client.id);
      return this.parId(client.id);
    },

    majChamps(client, { nom, domaines, formule }) {
      const nouvelle = formule !== undefined ? billing.formule(formule).id : client.formule;
      st.majChamps.run(
        nom !== undefined ? String(nom).trim() : client.nom,
        domaines !== undefined ? normaliserDomaines(domaines) : client.domaines,
        nouvelle, nowIso(), client.id
      );
      // Passage à une formule sans quota : les leads retenus pendant le palier
      // gratuit sont rendus. Un installateur qui s'abonne récupère tout, y
      // compris les contacts arrivés avant qu'il paie.
      if (billing.quotaLeads(nouvelle) === 0 && billing.quotaLeads(client.formule) > 0) {
        st.leadsLiberer.run(client.id);
      }
      return this.parId(client.id);
    },

    /* --- le bouton marche/arrêt et ses variantes --- */
    demarrerEssai(client, jours) {
      const j = billing.FORMULES.essaiJoursProposables.indexOf(jours) !== -1
        ? jours : billing.FORMULES.essaiJoursDefaut;
      st.majStatut.run('essai', billing.dansNJours(j), null, nowIso(), client.id);
      return this.parId(client.id);
    },
    activer(client, mois) {
      const m = mois || billing.FORMULES.abonnementMois;
      // Prolongation : on repart de la fin en cours si elle est future, pour ne
      // pas offrir de mois au client qui renouvelle en avance.
      const base = (client.abonnement_fin && client.abonnement_fin > nowIso())
        ? client.abonnement_fin : nowIso();
      st.majStatut.run('actif', client.essai_fin, billing.dansNMois(m, base), nowIso(), client.id);
      return this.parId(client.id);
    },
    suspendre(client) {
      st.majStatut.run('suspendu', client.essai_fin, client.abonnement_fin, nowIso(), client.id);
      return this.parId(client.id);
    },
    reprendre(client) {
      // On rend au client l'état auquel ses dates lui donnent droit
      const cible = (client.abonnement_fin && client.abonnement_fin > nowIso()) ? 'actif'
        : ((client.essai_fin && client.essai_fin > nowIso()) ? 'essai' : 'expire');
      st.majStatut.run(cible, client.essai_fin, client.abonnement_fin, nowIso(), client.id);
      return this.parId(client.id);
    },
    supprimer(client) { st.supprimer.run(client.id); },

    catalogueEffectif,
    cssDuTheme,
    normaliserTheme,
    CATALOGUE_REFERENCE
  };
}

function normaliserDomaines(d) {
  const liste = Array.isArray(d) ? d : String(d || '').split(/[\s,;]+/);
  return liste
    .map((x) => String(x).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter((x) => /^[a-z0-9.*-]+\.[a-z]{2,}$/.test(x))
    .slice(0, 20).join(',');
}

function normaliserConfig(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const out = {
    theme: normaliserTheme(c.theme),
    marque: {},
    catalogue: c.catalogue && typeof c.catalogue === 'object' ? c.catalogue : {},
    seo: c.seo && typeof c.seo === 'object' ? c.seo : {}
  };
  const m = c.marque || {};
  // Liste blanche : la marque finit dans des pages HTML, on ne recopie pas
  // n'importe quelle clé venue du réseau.
  ['name', 'contactEmail', 'phone', 'whatsapp', 'devisEndpoint', 'droneBookingUrl',
    'promesseRappel', 'rgeMention', 'politiqueConfidentialiteUrl', 'consentementVersion',
    'accroche'].forEach((k) => {
    if (m[k] !== undefined) out.marque[k] = String(m[k]).slice(0, 500);
  });
  if (m.rge !== undefined) out.marque.rge = !!m.rge;
  if (m.horaires && typeof m.horaires === 'object') out.marque.horaires = m.horaires;
  if (out.marque.devisEndpoint && !/^https:\/\//i.test(out.marque.devisEndpoint)) {
    delete out.marque.devisEndpoint;   // un webhook CRM en clair enverrait des données personnelles
  }
  ['villes', 'titre', 'description', 'ogImage', 'zone'].forEach((k) => {
    if (c.seo && c.seo[k] !== undefined) out.seo[k] = c.seo[k];
  });
  if (out.seo.ogImage) out.seo.ogImage = urlSure(out.seo.ogImage);
  return out;
}

module.exports = {
  creerDepot, catalogueEffectif, cssDuTheme, normaliserTheme, normaliserConfig,
  normaliserDomaines, fusionner, hex, eclaircir, assombrir, contraste, texteLisibleSur,
  urlSure, THEME_DEFAUT, CATALOGUE_REFERENCE
};
