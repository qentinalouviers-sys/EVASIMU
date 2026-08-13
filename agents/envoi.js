/*!
 * Hermès — envoi des messages
 *
 * Le maillon manquant : jusqu'ici la flotte rédigeait des `.eml` qu'il fallait
 * importer à la main. Ce module les expédie — mais l'essentiel de son code
 * n'est pas le transport, c'est ce qui l'entoure.
 *
 * Envoyer cent messages d'un coup depuis une adresse neuve, c'est griller le
 * domaine en une soirée : les filtres ne jugent pas un message isolé, ils
 * jugent un rythme. D'où les garde-fous, tous actifs par défaut :
 *
 *   - RAMPE DE CHAUFFE  — 5 messages le premier jour, +5 par jour, plafond 25 ;
 *   - HEURES OUVRABLES  — rien la nuit ni le week-end, ce sont des signaux ;
 *   - PAUSES ALÉATOIRES — un envoi toutes les 45 s à 4 min, pas une rafale ;
 *   - CONTRÔLE MX       — une adresse dont le domaine n'a pas de serveur de
 *                         courrier rebondit, et les rebonds coûtent plus cher
 *                         en réputation que le message ne rapporte ;
 *   - REGISTRE D'OPPOSITION — revérifié juste avant l'envoi, pas seulement à la
 *                         rédaction ;
 *   - SEUIL DE REBONDS  — au-delà, la campagne s'arrête d'elle-même.
 *
 * Et surtout : **rien ne part sans `--envoyer`**. Par défaut c'est une
 * simulation, qui affiche exactement ce qui serait expédié.
 *
 * Identifiants SMTP par variables d'environnement, jamais dans le dépôt :
 *   RDF_SMTP_HOTE (défaut smtp.gmail.com), RDF_SMTP_PORT (465),
 *   RDF_SMTP_UTILISATEUR, RDF_SMTP_MOTDEPASSE (mot de passe d'application).
 *
 *   node agents/hermes.js envoi --limite 10            # simulation
 *   node agents/hermes.js envoi --limite 10 --envoyer  # pour de vrai
 */
'use strict';

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const dns = require('dns').promises;
const P = require('./pipeline.js');
const R = require('./redaction.js');

const DEFAUT_JOURNAL = 'data/envois.json';

const CONFIG = {
  hote: process.env.RDF_SMTP_HOTE || 'smtp.gmail.com',
  port: Number(process.env.RDF_SMTP_PORT) || 465,
  utilisateur: process.env.RDF_SMTP_UTILISATEUR || '',
  motDePasse: process.env.RDF_SMTP_MOTDEPASSE || '',

  quotaInitial: 5,        // premier jour
  quotaIncrement: 5,      // par jour supplémentaire
  quotaMax: 25,           // plafond par boîte et par jour
  heureDebut: 8,
  heureFin: 18,
  pauseMinS: 45,
  pauseMaxS: 240,
  rebondsMaxPct: 5,       // au-delà, arrêt de la campagne
  rebondsMinPourJuger: 5  // en dessous, l'échantillon ne veut rien dire
};

/* ===================== Journal des envois ===================== */

/*
 * Le quota ne peut pas se déduire du pipeline : deux exécutions dans la même
 * journée doivent partager le même compteur. Le journal est donc la mémoire de
 * la cadence, distincte de la mémoire de la relation commerciale.
 */
function journalVide() {
  return { version: 1, premierJour: null, jours: {}, envois: [] };
}

function chargerJournal(chemin) {
  if (!fs.existsSync(chemin)) return journalVide();
  return Object.assign(journalVide(), JSON.parse(fs.readFileSync(chemin, 'utf8')));
}

function enregistrerJournal(journal, chemin) {
  const dossier = path.dirname(chemin);
  if (dossier && dossier !== '.') fs.mkdirSync(dossier, { recursive: true });
  const tmp = chemin + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(journal, null, 2), 'utf8');
  fs.renameSync(tmp, chemin);
}

const jourDe = (d) => d.toISOString().slice(0, 10);

function compteurDuJour(journal, jour) {
  if (!journal.jours[jour]) journal.jours[jour] = { envoyes: 0, rebonds: 0 };
  return journal.jours[jour];
}

/* ===================== Politique d'envoi ===================== */

/**
 * Quota autorisé aujourd'hui. La rampe démarre au premier envoi réel, pas à
 * l'installation : une boîte qui n'a rien envoyé depuis un mois reprend là où
 * la montée en charge en était, elle ne redémarre pas à zéro.
 */
function quotaDuJour(config, journal, maintenant) {
  const jour = jourDe(maintenant);
  if (!journal.premierJour) return config.quotaInitial;
  const ecoules = Math.max(0, Math.floor(
    (new Date(jour) - new Date(journal.premierJour)) / 86400000));
  return Math.min(config.quotaMax, config.quotaInitial + ecoules * config.quotaIncrement);
}

/** Heures ouvrables, jours ouvrés. Un envoi à 3 h du matin est un signal. */
function dansLesHeures(d, config) {
  const jour = d.getDay();
  if (jour === 0 || jour === 6) return false;
  const h = d.getHours();
  return h >= config.heureDebut && h < config.heureFin;
}

/** Taux de rebond du jour, en pourcentage. */
function tauxRebonds(compteur) {
  const total = compteur.envoyes + compteur.rebonds;
  return total ? Math.round((compteur.rebonds / total) * 1000) / 10 : 0;
}

function tropDeRebonds(compteur, config) {
  return compteur.rebonds >= config.rebondsMinPourJuger &&
    tauxRebonds(compteur) > config.rebondsMaxPct;
}

/* ===================== Contrôle des adresses ===================== */

/**
 * Le domaine du destinataire accepte-t-il du courrier ? Un rebond dur abîme la
 * réputation bien plus qu'un message ignoré, et les listes issues d'annuaires
 * en contiennent toujours.
 *
 * Le cache est fourni par l'appelant, et `run` en crée un par campagne : une
 * mémoire qui survivrait au processus finirait par affirmer qu'un domaine
 * n'existe pas des semaines après qu'il a été rétabli.
 */
async function verifierMx(email, resolveur, cache) {
  const domaine = String(email || '').split('@')[1];
  if (!domaine) return { ok: false, raison: 'adresse sans domaine' };
  if (cache && cache.has(domaine)) return cache.get(domaine);

  let r;
  try {
    const mx = await (resolveur || dns.resolveMx)(domaine);
    r = mx && mx.length
      ? { ok: true }
      : { ok: false, raison: 'aucun serveur de courrier déclaré sur ' + domaine };
  } catch (e) {
    r = { ok: false, raison: 'domaine ' + domaine + ' introuvable (' + (e.code || e.message) + ')' };
  }
  if (cache) cache.set(domaine, r);
  return r;
}

/* ===================== Transport SMTP ===================== */

/*
 * Un client SMTP minimal sur TLS implicite (port 465), écrit directement sur
 * `node:tls` : le dépôt n'a aucune dépendance et ce n'est pas ici qu'on va en
 * introduire une. Seul le strict nécessaire est implémenté — EHLO, AUTH LOGIN,
 * MAIL/RCPT/DATA — ce qui couvre Gmail, Microsoft 365 et OVH.
 */
function creerDialogue(socket) {
  let tampon = '';
  let attente = null;

  function verifier() {
    if (!attente) return;
    const m = tampon.match(/^(?:\d{3}-[^\n]*\n)*(\d{3})(?: [^\n]*)?\r?\n/);
    if (!m) return;
    const reponse = { code: Number(m[1]), texte: tampon.slice(0, m[0].length).trim() };
    tampon = tampon.slice(m[0].length);
    const a = attente;
    attente = null;
    a.resoudre(reponse);
  }

  socket.setEncoding('utf8');
  socket.on('data', (d) => { tampon += d; verifier(); });

  // Un seul écouteur d'erreur pour toute la conversation : en poser un par
  // attente en ajoutait une douzaine par message et faisait fuir la socket.
  let panne = null;
  socket.on('error', (e) => {
    panne = e;
    if (attente) { const a = attente; attente = null; a.rejeter(e); }
  });

  return {
    attendre() {
      if (panne) return Promise.reject(panne);
      return new Promise((resoudre, rejeter) => {
        attente = { resoudre, rejeter };
        verifier();
      });
    },
    ecrire(ligne) { socket.write(ligne + '\r\n'); }
  };
}

/** Les lignes commençant par un point doivent être doublées (RFC 5321 § 4.5.2). */
function protegerPoints(contenu) {
  return contenu.replace(/\r\n\./g, '\r\n..').replace(/^\./, '..');
}

async function envoyerSmtp(config, message, connecteur) {
  const socket = await new Promise((ok, ko) => {
    const s = (connecteur || tls.connect)({
      host: config.hote, port: config.port, servername: config.hote
    }, () => ok(s));
    s.once('error', ko);
  });

  const d = creerDialogue(socket);
  const b64 = (v) => Buffer.from(String(v), 'utf8').toString('base64');

  async function etape(commande, attendus) {
    if (commande !== null) d.ecrire(commande);
    const r = await d.attendre();
    if (!attendus.includes(r.code)) {
      const e = new Error('SMTP ' + r.code + ' : ' + r.texte);
      e.code = r.code;
      // Un 5xx sur RCPT TO est un refus définitif du destinataire : c'est un
      // rebond, à compter comme tel et non comme une panne du serveur.
      e.rebond = r.code >= 500 && r.code < 600;
      throw e;
    }
    return r;
  }

  try {
    await etape(null, [220]);
    await etape('EHLO ' + (String(message.de).split('@')[1] || 'localhost'), [250]);
    await etape('AUTH LOGIN', [334]);
    await etape(b64(config.utilisateur), [334]);
    await etape(b64(config.motDePasse), [235]);
    await etape('MAIL FROM:<' + message.de + '>', [250]);
    await etape('RCPT TO:<' + message.a + '>', [250, 251]);
    await etape('DATA', [354]);
    socket.write(protegerPoints(message.contenu) + '\r\n.\r\n');
    await etape(null, [250]);
    try { await etape('QUIT', [221]); } catch (e) { /* la déconnexion peut couper avant */ }
  } finally {
    socket.destroy();
  }
  return { envoye: true };
}

/* ===================== Orchestration ===================== */

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(opts = {}) {
  const log = (...a) => { if (!process.env.HERMES_SILENCE) console.log(...a); };
  const config = Object.assign({}, CONFIG, opts.config || {});
  const maintenant = opts.maintenant || new Date();
  const reel = !!opts.envoyer;

  const cheminPipeline = opts.pipeline || 'data/pipeline.json';
  const cheminJournal = opts.journal || DEFAUT_JOURNAL;
  const store = P.charger(cheminPipeline);
  const journal = chargerJournal(cheminJournal);
  const jour = jourDe(maintenant);
  const compteur = compteurDuJour(journal, jour);

  const bilan = { simulation: !reel, envoyes: 0, rebonds: 0, ignores: [], quota: 0, reste: 0 };
  const cacheMx = new Map();

  if (reel && (!config.utilisateur || !config.motDePasse)) {
    throw new Error('Identifiants SMTP absents. Exportez RDF_SMTP_UTILISATEUR et ' +
      'RDF_SMTP_MOTDEPASSE (mot de passe d’application, pas le mot de passe du compte).');
  }
  if (reel && !opts.forcer && !dansLesHeures(maintenant, config)) {
    log('Hors des heures d’envoi (' + config.heureDebut + 'h–' + config.heureFin +
      'h, jours ouvrés). Rien n’est envoyé — --forcer pour passer outre.');
    return bilan;
  }
  if (tropDeRebonds(compteur, config)) {
    log('Arrêt : ' + tauxRebonds(compteur) + ' % de rebonds aujourd’hui (seuil ' +
      config.rebondsMaxPct + ' %). Vérifiez la qualité de la liste avant de reprendre.');
    return bilan;
  }

  bilan.quota = quotaDuJour(config, journal, maintenant);
  bilan.reste = Math.max(0, bilan.quota - compteur.envoyes);
  const limite = Math.min(bilan.reste, Number(opts.limite) || bilan.reste);
  if (limite <= 0) {
    log('Quota du jour atteint (' + compteur.envoyes + '/' + bilan.quota + '). Reprise demain.');
    return bilan;
  }

  const lot = P.aTraiter(store, {
    limite, maintenant,
    scoreMin: Number(opts.score) || 0,
    delaiRelance1: Number(opts['delai-relance1']) || 7,
    delaiRelance2: Number(opts['delai-relance2']) || 14
  });
  if (!lot.length) { log('Rien à envoyer aujourd’hui.'); return bilan; }

  log((reel ? 'Envoi' : 'SIMULATION') + ' — quota du jour ' + bilan.quota +
    ', déjà envoyés ' + compteur.envoyes + ', ' + lot.length + ' message(s) retenus\n');

  for (const { cle, etape, prospect } of lot) {
    const destinataire = (prospect.emails || [])[0] || '';
    const etiquette = (prospect.nom || cle) + ' <' + (destinataire || 'sans adresse') + '>';

    // Ceinture et bretelles : le registre a pu s'enrichir depuis la capture.
    const motif = P.estExclu(store, prospect);
    if (motif) { bilan.ignores.push({ cle, raison: 'registre d’opposition (' + motif + ')' }); continue; }
    if (!destinataire) { bilan.ignores.push({ cle, raison: 'aucune adresse' }); continue; }

    const mx = await verifierMx(destinataire, opts.resolveur, cacheMx);
    if (!mx.ok) {
      compteur.rebonds++;
      bilan.rebonds++;
      bilan.ignores.push({ cle, raison: mx.raison });
      log('  ✗ ' + etiquette + ' — ' + mx.raison);
      if (tropDeRebonds(compteur, config)) {
        log('\nArrêt : trop de rebonds (' + tauxRebonds(compteur) + ' %). La liste est à nettoyer.');
        break;
      }
      continue;
    }

    const message = R.rediger(prospect, etape, cle);
    const contenu = R.versEml(message, config.utilisateur || R.EMETTEUR.email, maintenant);

    if (!reel) {
      log('  · ' + etiquette + ' — ' + etape + ' — « ' + message.objet + ' »');
      bilan.envoyes++;
      continue;
    }

    try {
      await envoyerSmtp(config, {
        de: config.utilisateur, a: destinataire, contenu
      }, opts.connecteur);
    } catch (e) {
      if (e.rebond) { compteur.rebonds++; bilan.rebonds++; }
      bilan.ignores.push({ cle, raison: e.message });
      log('  ✗ ' + etiquette + ' — ' + e.message);
      if (tropDeRebonds(compteur, config)) {
        log('\nArrêt : trop de rebonds (' + tauxRebonds(compteur) + ' %).');
        break;
      }
      continue;
    }

    // L'état n'avance qu'après un envoi réussi : en cas de coupure, le prospect
    // reste à traiter plutôt que d'être marqué contacté sans l'avoir été.
    P.marquer(store, cle, etape === 'premier' ? 'contacte' : etape, 'message envoyé', maintenant);
    compteur.envoyes++;
    bilan.envoyes++;
    journal.premierJour = journal.premierJour || jour;
    journal.envois.push({ jour, cle, etape, destinataire, objet: message.objet });
    P.enregistrer(store, cheminPipeline);
    enregistrerJournal(journal, cheminJournal);
    log('  ✓ ' + etiquette + ' — ' + etape);

    // Remontée dans la console, si le pont est configuré. Un échec ici ne doit
    // pas interrompre la campagne : le message est parti, c'est le fait établi.
    if (opts.client) {
      try {
        const API = require('./api.js');
        await API.remonter(opts.client, prospect, {
          type: 'email',
          corps: message.objet,
          etat: etape === 'premier' ? 'contacte' : etape
        });
      } catch (e) {
        log('    (non remonté dans la console : ' + e.message + ')');
      }
    }

    if (bilan.envoyes < lot.length) {
      const pause = config.pauseMinS + Math.random() * (config.pauseMaxS - config.pauseMinS);
      if (!opts.sansPause) await dormir(pause * 1000);
    }
  }

  if (!reel) {
    log('\nSimulation : rien n’a été envoyé, le pipeline n’a pas bougé.');
    log('  → ajoutez --envoyer quand le contenu vous convient.');
  } else {
    enregistrerJournal(journal, cheminJournal);
    log('\n✓ ' + bilan.envoyes + ' envoyé(s) · ' + bilan.rebonds + ' rebond(s) · ' +
      'quota ' + compteur.envoyes + '/' + bilan.quota);
  }
  if (bilan.ignores.length) {
    log('  ' + bilan.ignores.length + ' écarté(s) :');
    bilan.ignores.slice(0, 10).forEach((i) => log('    ' + i.cle + ' — ' + i.raison));
  }
  return bilan;
}

module.exports = {
  CONFIG, DEFAUT_JOURNAL,
  journalVide, chargerJournal, enregistrerJournal, compteurDuJour, jourDe,
  quotaDuJour, dansLesHeures, tauxRebonds, tropDeRebonds,
  verifierMx, creerDialogue, protegerPoints, envoyerSmtp, run
};
