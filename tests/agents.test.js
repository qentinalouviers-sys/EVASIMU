/**
 * Tests du pilotage des agents — exécution : node tests/agents.test.js
 *
 * Couvre la migration v4 et le module agents.js : interrupteur actif/pause,
 * journal des exécutions (fiches, tokens LLM), reprise et KPI.
 */
'use strict';

const dbLib = require('../saas/lib/db.js');
const { creerAgents } = require('../saas/lib/agents.js');

let passed = 0, failed = 0;
function check(nom, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + nom); }
  else { failed++; console.error('  ✗ ' + nom + (detail ? ' — ' + detail : '')); }
}

console.log('\nPilotage des agents');
{
  const db = dbLib.open(':memory:');
  const agents = creerAgents(db);

  // L'état se crée à la première lecture, actif par défaut.
  const e0 = agents.etat('prospection');
  check('état initial actif', e0.actif === 1, 'actif=' + e0.actif);
  check('profil enregistré', e0.profil === 'prospection');

  // Bascule pause ↔ actif.
  check('bascule en pause', agents.basculer('prospection', false).actif === 0);
  check('rebascule en actif', agents.basculer('prospection', true).actif === 1);

  // Journal des exécutions, avec la plus récente en tête.
  agents.journaliser('prospection', 'inspection', 25, 1234, { vagues: 1 });
  agents.journaliser('prospection', 'synchro', 500, 0, {});
  const execs = agents.executions(null, 100);
  check('deux exécutions enregistrées', execs.length === 2, 'n=' + execs.length);
  check('la plus récente en premier', execs[0].type === 'synchro');
  check('tokens cumulés', execs.reduce((s, e) => s + e.tokens, 0) === 1234);

  // Filtre par profil, tous profils confondus sinon.
  agents.journaliser('ventes', 'relance', 3, 42, {});
  check('filtre par profil', agents.executions('prospection', 100).length === 2);
  check('tous profils confondus', agents.executions(null, 100).length === 3);

  // KPI : tokens totaux, et compteurs sur les prospects (toujours des nombres).
  const k = agents.kpis();
  check('kpi tokens totaux', k.tokens === 1276, 'tokens=' + k.tokens);
  check('kpi sites analysés numérique', Number.isInteger(k.sitesAnalyses));
  check('kpi fiches enrichies numérique', Number.isInteger(k.fichesEnrichies));

  // La dernière tâche est tracée dans l'état — c'est ce qui permet de reprendre.
  check('dernière tâche tracée', agents.etat('prospection').derniere_tache === 'synchro');
}

console.log('\n' + passed + ' tests réussis, ' + failed + ' échec(s)');
process.exit(failed ? 1 : 0);
