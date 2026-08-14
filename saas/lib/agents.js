/*
 * Pilotage de la flotte d'agents Hermès.
 *
 * Deux tables :
 *   - agent_etat       : l'interrupteur actif/pause, et la trace de la dernière
 *                        tâche (pour reprendre où l'on s'était arrêté) ;
 *   - agent_executions : le journal de chaque passage (type, fiches traitées,
 *                        tokens LLM consommés, détail), qui alimente le panneau.
 */
'use strict';

const { nowIso } = require('./db.js');

function creerAgents(db) {
  const st = {
    parProfil: db.prepare('SELECT * FROM agent_etat WHERE profil = ?'),
    inserer: db.prepare(`INSERT INTO agent_etat(profil, actif, derniere_tache, derniere_activite, maj_le)
                         VALUES(?,1,'','',?)`),
    basculer: db.prepare('UPDATE agent_etat SET actif = ?, maj_le = ? WHERE profil = ?'),
    toucher: db.prepare('UPDATE agent_etat SET derniere_tache = ?, derniere_activite = ?, maj_le = ? WHERE profil = ?'),
    insererExec: db.prepare('INSERT INTO agent_executions(profil, type, taches, tokens, detail, cree_le) VALUES(?,?,?,?,?,?)'),
    listerExec: db.prepare('SELECT * FROM agent_executions ORDER BY id DESC LIMIT ?'),
    listerExecProfil: db.prepare('SELECT * FROM agent_executions WHERE profil = ? ORDER BY id DESC LIMIT ?'),
    sommeTokens: db.prepare('SELECT COALESCE(SUM(tokens),0) n FROM agent_executions'),
    nbSites: db.prepare('SELECT COUNT(*) n FROM prospects WHERE inspecte_le IS NOT NULL'),
    nbEnrichies: db.prepare("SELECT COUNT(*) n FROM prospects WHERE enseigne != '' OR couleur != '' OR simulateur_niveau IS NOT NULL")
  };

  function etat(profil) {
    let e = st.parProfil.get(profil);
    if (!e) {
      st.inserer.run(profil, nowIso());
      e = st.parProfil.get(profil);
    }
    return e;
  }

  return {
    etat,

    basculer(profil, actif) {
      etat(profil);
      st.basculer.run(actif ? 1 : 0, nowIso(), profil);
      return etat(profil);
    },

    journaliser(profil, type, taches, tokens, detail) {
      const t = nowIso();
      st.insererExec.run(profil, String(type || 'tache'), Number(taches) || 0,
        Number(tokens) || 0, JSON.stringify(detail || {}), t);
      st.toucher.run(String(type || 'tache'), t, t, profil);
      return true;
    },

    executions(profil, limite) {
      const l = Number(limite) || 100;
      return profil ? st.listerExecProfil.all(profil, l) : st.listerExec.all(l);
    },

    kpis() {
      return {
        tokens: st.sommeTokens.get().n,
        sitesAnalyses: st.nbSites.get().n,
        fichesEnrichies: st.nbEnrichies.get().n
      };
    }
  };
}

module.exports = { creerAgents };
