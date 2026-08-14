/**
 * Cycle de vie commercial d'un client : essai, activation, suspension,
 * expiration — et encaissement.
 *
 * L'état affiché n'est jamais lu tel quel en base : il est TOUJOURS recalculé
 * à partir des dates. Un essai terminé coupe le widget même si personne n'a
 * lancé de tâche planifiée, et une réactivation ne demande qu'à repousser une
 * date. C'est ce qui rend le bouton marche/arrêt fiable.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { nowIso } = require('./db.js');

const FORMULES = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'formules.json'), 'utf8')
);

/*
 * Anciens identifiants de la grille. Sans cette table, un client resté en
 * « pro » ou « reseau » ne serait plus reconnu et retomberait sur la première
 * formule de la liste — c'est-à-dire, depuis l'ajout du palier gratuit, sur une
 * formule sans Google Solar et à cinq leads par mois. Un client payant dégradé
 * en silence : la migration v6 renomme les valeurs en base, cette table couvre
 * ce que la migration n'aurait pas vu.
 */
const ALIAS = { pro: 'agence', reseau: 'agence' };

function formule(id) {
  const cherche = ALIAS[id] || id;
  return FORMULES.formules.filter((f) => f.id === cherche)[0] || FORMULES.formules[0];
}

/**
 * La formule à proposer sur la page d'abonnement.
 *
 * Un client au palier gratuit ne s'abonne pas à zéro euro : on lui présente la
 * première formule payante. Un client déjà payant reste sur la sienne.
 */
function formuleAAbonner(id) {
  const f = formule(id);
  if (!f.gratuite) return f;
  return FORMULES.formules.filter((x) => !x.gratuite)[0] || f;
}

function joursEntre(depuis, jusqu) {
  return Math.ceil((new Date(jusqu).getTime() - new Date(depuis).getTime()) / 86400000);
}

/**
 * Quota mensuel de leads d'une formule. 0 signifie « illimité » — jamais
 * « aucun », sans quoi une formule payante mal renseignée bloquerait ses leads.
 */
function quotaLeads(formuleId) {
  const f = formule(formuleId);
  const q = ((f || {}).limites || {}).leadsParMois;
  return q > 0 ? q : 0;
}

/** La détection Google Solar est-elle ouverte à cette formule ? */
function googleSolarOuvert(formuleId) {
  const f = formule(formuleId);
  return ((f || {}).limites || {}).googleSolar !== false;
}

/**
 * Le lead dépasse-t-il le quota du mois ?
 *
 * Dépasser ne fait jamais perdre le lead : la personne a rempli le formulaire,
 * elle existe, et la refuser priverait l'installateur d'un client réel pour une
 * question de facturation. Le lead est enregistré et retenu — coordonnées
 * masquées dans la console — puis libéré rétroactivement au passage payant.
 * Rien n'est détruit, et le plafond était connu d'avance.
 */
function leadRetenu(formuleId, dejaCeMois) {
  const q = quotaLeads(formuleId);
  return q > 0 && dejaCeMois >= q;
}

/** Premier jour du mois courant, en ISO — borne du compteur de quota. */
function debutDuMois(maintenant) {
  const d = maintenant ? new Date(maintenant) : new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

/**
 * État réel d'un client, recalculé à chaque appel.
 * @returns { actif, statut, motif, joursRestants, formule }
 */
function etat(client, maintenant) {
  const t = maintenant || nowIso();
  if (!client) return { actif: false, statut: 'inconnu', motif: 'client inconnu', joursRestants: null };

  if (client.statut === 'suspendu') {
    return { actif: false, statut: 'suspendu', motif: 'widget désactivé par l’éditeur', joursRestants: null, formule: client.formule };
  }
  if (client.statut === 'actif') {
    if (client.abonnement_fin && client.abonnement_fin < t) {
      return { actif: false, statut: 'expire', motif: 'abonnement expiré le ' + client.abonnement_fin.slice(0, 10), joursRestants: 0, formule: client.formule };
    }
    return {
      actif: true, statut: 'actif', motif: '',
      joursRestants: client.abonnement_fin ? joursEntre(t, client.abonnement_fin) : null,
      formule: client.formule
    };
  }
  if (client.statut === 'essai') {
    if (!client.essai_fin) {
      return { actif: false, statut: 'essai', motif: 'essai non démarré', joursRestants: null, formule: client.formule };
    }
    if (client.essai_fin < t) {
      return { actif: false, statut: 'expire', motif: 'essai terminé le ' + client.essai_fin.slice(0, 10), joursRestants: 0, formule: client.formule };
    }
    return {
      actif: true, statut: 'essai', motif: '',
      joursRestants: joursEntre(t, client.essai_fin), formule: client.formule
    };
  }
  return { actif: false, statut: client.statut || 'expire', motif: 'abonnement inactif', joursRestants: 0, formule: client.formule };
}

function dansNJours(n, depuis) {
  const d = depuis ? new Date(depuis) : new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString();
}

function dansNMois(n, depuis) {
  const d = depuis ? new Date(depuis) : new Date();
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString();
}

/* ------------------------------------------------------------------ */
/* Encaissement                                                        */
/* ------------------------------------------------------------------ */

/**
 * Deux modes, choisis par la configuration :
 *
 * - `stripe` si STRIPE_SECRET_KEY est défini : création d'une session Checkout
 *   par appel HTTP direct (l'API Stripe est du form-encodé, aucun SDK requis),
 *   puis activation à la réception du webhook signé.
 * - `bon_de_commande` sinon : la commande est enregistrée « en attente », le
 *   client reçoit ses instructions de virement et un opérateur (ou un agent
 *   Hermès ayant la portée abonnement:gerer) confirme le paiement.
 *
 * Aucun paiement n'est jamais simulé : sans clé Stripe, rien ne prétend
 * encaisser.
 */
function creerPaiement(options) {
  const cfg = options || {};
  const cle = cfg.stripeKey || process.env.STRIPE_SECRET_KEY || '';
  const base = cfg.stripeBase || process.env.STRIPE_API_BASE || 'https://api.stripe.com';
  const secretWebhook = cfg.stripeWebhookSecret || process.env.STRIPE_WEBHOOK_SECRET || '';

  return {
    mode: cle ? 'stripe' : 'bon_de_commande',

    async session({ client, formuleId, urlSucces, urlAnnulation }) {
      const f = formule(formuleId);
      if (!cle) {
        return {
          mode: 'bon_de_commande',
          montantHT: f.prixHTAn,
          instructions: 'Commande enregistrée. Vous recevez la facture par e-mail ; ' +
            'le widget est activé dès réception du règlement.'
        };
      }
      const corps = new URLSearchParams({
        mode: 'payment',
        success_url: urlSucces,
        cancel_url: urlAnnulation,
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': (FORMULES.devise || 'EUR').toLowerCase(),
        'line_items[0][price_data][unit_amount]': String(Math.round(f.prixHTAn * 100)),
        'line_items[0][price_data][product_data][name]':
          'Simulateur photovoltaïque — formule ' + f.nom + ' (12 mois)',
        'client_reference_id': client.cle,
        'metadata[client]': client.cle,
        'metadata[formule]': f.id
      }).toString();

      const rep = await requete(base + '/v1/checkout/sessions', corps, cle);
      if (rep.status !== 200) {
        throw new Error('Stripe a répondu ' + rep.status + ' : ' + rep.body.slice(0, 200));
      }
      const j = JSON.parse(rep.body);
      return { mode: 'stripe', url: j.url, id: j.id, montantHT: f.prixHTAn };
    },

    /**
     * Vérifie la signature d'un webhook Stripe (schéma t=…,v1=…).
     * Sans secret configuré, on refuse : un webhook non vérifié qui active des
     * abonnements serait une porte ouverte.
     */
    verifierWebhook(entete, corpsBrut, toleranceS) {
      if (!secretWebhook) return { ok: false, raison: 'aucun secret de webhook configuré' };
      const parts = {};
      String(entete || '').split(',').forEach((p) => {
        const i = p.indexOf('=');
        if (i > 0) parts[p.slice(0, i).trim()] = p.slice(i + 1).trim();
      });
      if (!parts.t || !parts.v1) return { ok: false, raison: 'en-tête de signature illisible' };
      const attendu = crypto.createHmac('sha256', secretWebhook)
        .update(parts.t + '.' + corpsBrut).digest('hex');
      const a = Buffer.from(attendu), b = Buffer.from(parts.v1);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return { ok: false, raison: 'signature invalide' };
      }
      const age = Math.abs(Date.now() / 1000 - Number(parts.t));
      if (age > (toleranceS || 300)) return { ok: false, raison: 'signature expirée' };
      return { ok: true, evenement: JSON.parse(corpsBrut) };
    }
  };

  function requete(url, corps, cleApi) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const client = u.protocol === 'https:' ? https : http;
      const req = client.request({
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          'Authorization': 'Bearer ' + cleApi,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(corps)
        }
      }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.setTimeout(15000, () => req.destroy(new Error('délai dépassé')));
      req.on('error', reject);
      req.end(corps);
    });
  }
}

module.exports = {
  FORMULES, formule, etat, dansNJours, dansNMois, joursEntre, creerPaiement,
  quotaLeads, googleSolarOuvert, leadRetenu, debutDuMois, formuleAAbonner
};
