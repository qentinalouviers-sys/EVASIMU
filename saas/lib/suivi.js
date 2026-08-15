/**
 * Suivi des messages de prospection : jetons signés, ouvertures, clics.
 *
 * ── Pourquoi le jeton ne transporte pas d'URL ────────────────────────────
 * Un lien de redirection qui accepte une destination libre (`/r?u=<url>`) est
 * une redirection ouverte : n'importe qui peut fabriquer un lien qui part de
 * notre domaine et arrive sur le sien. C'est l'outil de phishing idéal, et
 * c'est notre réputation d'expéditeur qui paie. Le jeton porte donc un
 * identifiant de destination pris dans une liste fermée ; l'URL réelle est
 * reconstruite côté serveur à partir de la fiche du prospect.
 *
 * ── Pourquoi le jeton est signé ──────────────────────────────────────────
 * Sans signature, incrémenter l'identifiant d'un jeton suffit à parcourir les
 * prospects et à falsifier leurs statistiques. La signature est un HMAC
 * tronqué : assez court pour tenir dans une URL lisible, assez long pour
 * qu'un tirage au hasard n'aboutisse pas.
 *
 * Sans `EVASIMU_SUIVI_SECRET`, aucun lien suivi n'est fabriqué — les messages
 * partent avec les URL directes. Un suivi à moitié branché qui perd
 * silencieusement les clics vaut moins que pas de suivi du tout.
 */
'use strict';

const crypto = require('crypto');

/** Destinations autorisées. Toute autre valeur est refusée à la vérification. */
const DESTINATIONS = ['apercu', 'demo', 'vente'];

function secret() {
  return process.env.EVASIMU_SUIVI_SECRET || '';
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function deB64url(s) {
  const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(t + '='.repeat((4 - (t.length % 4)) % 4), 'base64').toString('utf8');
}

function empreinte(charge, cle) {
  return b64url(crypto.createHmac('sha256', cle).update(charge).digest()).slice(0, 22);
}

/**
 * Fabrique un jeton pour (prospect, étape, destination).
 * Renvoie '' si le secret n'est pas configuré — l'appelant retombe alors sur
 * l'URL directe plutôt que d'émettre un lien qui ne mènera nulle part.
 */
function signer(prospectId, etape, destination) {
  const cle = secret();
  if (!cle) return '';
  if (!DESTINATIONS.includes(destination)) throw new Error('destination inconnue : ' + destination);
  const id = Number(prospectId);
  if (!Number.isInteger(id) || id <= 0) return '';
  const charge = [id, String(etape || '').slice(0, 20), destination].join('.');
  return b64url(charge) + '.' + empreinte(charge, cle);
}

/**
 * Vérifie un jeton et renvoie son contenu, ou null.
 *
 * Comparaison à temps constant : une comparaison de chaînes ordinaire fuit,
 * par sa durée, le nombre de caractères initiaux corrects — de quoi
 * reconstituer une signature octet par octet.
 */
function verifier(jeton) {
  const cle = secret();
  if (!cle) return null;
  const parts = String(jeton || '').split('.');
  if (parts.length !== 2) return null;

  let charge;
  try { charge = deB64url(parts[0]); } catch (e) { return null; }
  const attendue = Buffer.from(empreinte(charge, cle));
  const fournie = Buffer.from(parts[1]);
  if (attendue.length !== fournie.length) return null;
  if (!crypto.timingSafeEqual(attendue, fournie)) return null;

  const [id, etape, destination] = charge.split('.');
  if (!DESTINATIONS.includes(destination)) return null;
  const prospectId = Number(id);
  if (!Number.isInteger(prospectId) || prospectId <= 0) return null;
  return { prospectId, etape: etape || '', destination };
}

/** Le lien complet mis dans un message. '' si le suivi n'est pas configuré. */
function lien(base, prospectId, etape, destination) {
  const j = signer(prospectId, etape, destination);
  if (!j) return '';
  return String(base || '').replace(/\/+$/, '') + '/r/' + j;
}

/** Le pixel d'ouverture. Voir la note sur sa fiabilité dans le serveur. */
function lienPixel(base, prospectId, etape) {
  const j = signer(prospectId, etape, 'demo');
  if (!j) return '';
  return String(base || '').replace(/\/+$/, '') + '/o/' + j + '.gif';
}

/*
 * Ce que vaut chaque signal, en points d'engagement.
 *
 * L'écart entre l'ouverture et le reste n'est pas un réglage : une ouverture
 * est très largement du bruit (voir la note sur le pixel dans le serveur),
 * alors qu'une simulation menée jusqu'aux résultats est un prospect qui a
 * passé plusieurs minutes dans le produit. Les traiter à égalité ferait
 * remonter les mauvaises fiches en tête de liste d'appel.
 */
const POIDS = {
  ouverture: 1,
  clic: 15,
  apercu_vu: 20,
  apercu_simulation: 35,
  apercu_resultats: 50
};

const LIBELLES = {
  ouverture: 'a ouvert le message',
  clic: 'a cliqué dans le message',
  apercu_vu: 'a ouvert son aperçu personnalisé',
  apercu_simulation: 'a dessiné une toiture dans son aperçu',
  apercu_resultats: 'est allé jusqu’aux résultats de son aperçu'
};

/** Score plafonné à 100 : au-delà, c'est un appel à passer, pas un classement. */
function score(signaux) {
  const s = signaux || {};
  let total = 0;
  for (const [type, poids] of Object.entries(POIDS)) {
    if (s[type]) total += poids * Math.min(3, s[type]);
  }
  return Math.min(100, total);
}

/** Trois paliers, pour que la console dise quoi faire plutôt que d'afficher un nombre. */
function temperature(score) {
  if (score >= 50) return { cle: 'chaud', libelle: 'À appeler maintenant' };
  if (score >= 15) return { cle: 'tiede', libelle: 'A montré de l’intérêt' };
  if (score > 0) return { cle: 'froid', libelle: 'A vu le message' };
  return { cle: 'aucun', libelle: 'Aucun signal' };
}

module.exports = {
  DESTINATIONS, POIDS, LIBELLES,
  signer, verifier, lien, lienPixel, score, temperature, actif: () => !!secret()
};
