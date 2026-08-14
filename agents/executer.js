#!/usr/bin/env node
/*
 * Exécuteur de la flotte Hermès — tourne sous une minuterie.
 *
 *   RDF_SAAS_URL=… RDF_SAAS_JETON=… node agents/executer.js
 *
 * Lit l'interrupteur (actif/pause) avant de travailler : en pause, il ne fait
 * rien et n'écrit rien dans le journal. Actif, il enchaîne la journée type en
 * lots, re-vérifie l'interrupteur avant chaque lot (arrêt propre), et remonte
 * chaque passage (type, fiches, tokens) dans la console.
 */
'use strict';

const API = require('./api.js');
const { COMMANDES } = require('./hermes.js');

const TAILLE_LOT = 25;      // sites inspectés par lot
const MAX_LOTS = 4;         // 100 sites au plus par passage de la minuterie

async function principal() {
  const client = API.creerClient();

  // 1. Interrupteur : en pause, on ne touche à rien.
  const { etat } = await client.agentEtat();
  if (!etat || !etat.actif) {
    console.log('En pause — l’agent ne travaille pas.');
    return;
  }

  // 2. Synchronisation : les prospects du CRM descendent dans le pipeline.
  const s = await COMMANDES.synchro({});
  await client.signaler('synchro', s ? (s.lus || 0) : 0, 0, {
    ajoutes: s ? (s.ajoutes || 0) : 0,
    actualises: s ? (s.actualises || 0) : 0
  });

  // 3. Inspection en lots, avec re-vérification de l'interrupteur avant chacun.
  for (let lot = 0; lot < MAX_LOTS; lot++) {
    const { etat: e } = await client.agentEtat();
    if (!e.actif) { console.log('Mis en pause en cours de route — arrêt propre.'); break; }

    const r = await COMMANDES.inspection({ limite: TAILLE_LOT });
    const traitees = r ? (r.cibles || 0) + (r.ecartes || 0) + (r.muets || 0) : 0;
    if (r) await client.signaler('inspection', traitees, 0, r);
    if (!r || traitees === 0) break;   // plus rien à inspecter
  }
}

if (require.main === module) {
  principal()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('Échec de l’exécuteur :', e.message);
      process.exit(1);
    });
}

module.exports = { principal };
