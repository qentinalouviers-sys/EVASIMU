/*!
 * Hermès — commande unique de la flotte
 *
 * Enchaîne les agents autour d'un état partagé (`data/pipeline.json`) :
 * capturer, rédiger, marquer, suivre, exclure, publier.
 *
 *   node agents/hermes.js capture --departement 69 --pages 3
 *   node agents/hermes.js messages --limite 20 --score 60
 *   node agents/hermes.js etat 812345678 repondu
 *   node agents/hermes.js stop contact@exemple.fr
 *   node agents/hermes.js suivi
 *   node agents/hermes.js posts --semaines 4
 *   node agents/hermes.js tableau
 */
'use strict';

const fs = require('fs');
const path = require('path');
const P = require('./pipeline.js');
const C = require('./croisement.js');
const R = require('./redaction.js');
const PUB = require('./publication.js');
const API = require('./api.js');
const E = require('./envoi.js');
const INS = require('./inspection.js');

const DEFAUT_PIPELINE = 'data/pipeline.json';
const log = (...a) => { if (!process.env.HERMES_SILENCE) console.log(...a); };

/* ===================== Commandes ===================== */

const COMMANDES = {

  /** Capture des prospects et intégration dans le pipeline, sans écraser l'existant. */
  async capture(opts) {
    const chemin = opts.pipeline || DEFAUT_PIPELINE;
    const sortie = opts.sortie || 'data/capture';
    const fiches = await C.run(Object.assign({}, opts, { sortie }));

    const store = P.charger(chemin);
    const bilan = P.integrer(store, fiches);
    P.enregistrer(store, chemin);

    log(`\nPipeline (${chemin}) :`);
    log(`  ${bilan.ajoutes} nouveau(x) · ${bilan.actualises} actualisé(s) · ${bilan.exclus} écarté(s) par le registre d’opposition`);
    log(`  ${Object.keys(store.prospects).length} prospects au total`);
    return bilan;
  },

  /**
   * Visite les sites des prospects et enrichit leur fiche : simulateur en
   * place ou non, niveau technique, données réclamées au visiteur, nom
   * d'enseigne et couleurs. C'est ce qui rend l'accroche vérifiable — et ce
   * qui écarte les installateurs déjà mieux équipés que nous.
   */
  async inspection(opts) {
    const chemin = opts.pipeline || DEFAUT_PIPELINE;
    const store = P.charger(chemin);
    const rejouer = !!opts.rejouer;

    const aVoir = Object.values(store.prospects)
      .filter((p) => p.siteWeb && p.etat !== 'exclu' && (rejouer || !p.inspection))
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, Number(opts.limite) || 25);

    if (!aVoir.length) {
      log('Aucun site à inspecter. (--rejouer pour repasser sur les fiches déjà vues)');
      return;
    }
    log(`Inspection de ${aVoir.length} site(s) — robots.txt respecté, une requête à la fois\n`);

    let cibles = 0, ecartes = 0, muets = 0;
    for (const p of aVoir) {
      const r = await INS.visiter(p.siteWeb, opts);
      INS.enrichir(p, r);
      P.enregistrer(store, chemin);      // écriture au fil de l'eau : une coupure ne perd rien

      if (!r.joignable) { muets++; log(`  ? ${p.nom} — ${r.erreur}`); continue; }
      if (r.verdict.cible) cibles++; else ecartes++;
      log(`  ${r.verdict.cible ? '✓' : '—'} ${p.nom} — ${r.simulateur.libelle}` +
        (r.simulateur.editeurs.length ? ' (' + r.simulateur.editeurs.join(', ') + ')' : '') +
        (r.identite.principale ? ' · ' + r.identite.principale : ''));
      if (!r.verdict.cible) log(`      écarté : ${r.verdict.raison}`);
    }

    log(`\n${cibles} cible(s) · ${ecartes} écarté(s) · ${muets} site(s) muets`);
    if (ecartes) log('  Les fiches écartées ne seront plus retenues pour l’envoi.');
    return { cibles, ecartes, muets };
  },

  /** Rédaction des messages dus aujourd'hui. N'envoie rien. */
  async messages(opts) {
    return R.run(Object.assign({ pipeline: opts.pipeline || DEFAUT_PIPELINE }, opts));
  },

  /**
   * Synchronisation avec le SaaS : les prospects de la console descendent dans
   * le pipeline, et — avec `--pousser` — les fiches capturées localement
   * remontent dans la console. Sans cette commande, les deux moitiés du système
   * s'ignorent : une liste importée dans le CRM n'est jamais démarchée.
   */
  async synchro(opts) {
    const chemin = opts.pipeline || DEFAUT_PIPELINE;
    const client = API.creerClient({ base: opts.url, jeton: opts.jeton });

    // `/moi` décrit le porteur du jeton : ce qu'on veut voir avant d'écrire
    // quoi que ce soit, c'est le droit d'écriture — un jeton en lecture seule
    // ferait tourner la synchro à vide sans le dire.
    const moi = await client.moi();
    const portees = moi.portees || [];
    const id = moi.identite || {};
    const qui = typeof id === 'string' ? id : (id.libelle || id.email || id.profil || '?');
    log(`Connecté à ${client.base} — ${moi.type || 'agent'} « ${qui} »`);
    if (!portees.includes('*') && !portees.includes('prospects:ecrire')) {
      log('⚠ Ce jeton ne peut pas écrire de prospects (portée « prospects:ecrire » absente).');
    }

    const store = P.charger(chemin);
    const bilan = await API.descendre(store, client, {
      limite: Number(opts.limite) || 500,
      statut: opts.statut, departement: opts.departement
    });

    if (opts.pousser) {
      const locaux = Object.values(store.prospects).filter((p) => !p.saasId && p.etat !== 'exclu');
      if (locaux.length) {
        const r = await client.creer(locaux);
        log(`  ↑ ${locaux.length} fiche(s) locale(s) poussées — ${r.crees} créée(s), ${r.doublons} doublon(s)`);
        // Deuxième descente : les fiches qu'on vient de créer reviennent avec
        // leur identifiant, sans lequel aucun envoi ne serait remonté ensuite.
        await API.descendre(store, client, { limite: Number(opts.limite) || 500 });
      } else log('  ↑ aucune fiche locale à pousser');
    }

    P.enregistrer(store, chemin);
    log(`  ↓ ${bilan.lus} lue(s) — ${bilan.ajoutes} nouvelle(s), ${bilan.actualises} actualisée(s), ` +
      `${bilan.repris} état(s) repris du CRM, ${bilan.exclus} écartée(s) par le registre`);
    log(`  ${Object.keys(store.prospects).length} prospects dans le pipeline`);
    return bilan;
  },

  /**
   * Envoi des messages dus. Simulation par défaut : il faut `--envoyer` pour
   * que quoi que ce soit parte réellement.
   */
  async envoi(opts) {
    let client = null;
    if (!opts['sans-saas']) {
      try { client = API.creerClient({ base: opts.url, jeton: opts.jeton }); }
      catch (e) { log('⚠ Pas de remontée dans la console : ' + e.message + '\n'); }
    }
    return E.run(Object.assign({ pipeline: opts.pipeline || DEFAUT_PIPELINE, client }, opts));
  },

  /** Changement d'état manuel : `hermes etat <siren> <etat> [détail]` */
  async etat(opts, args) {
    const [cle, nouvelEtat, ...reste] = args;
    const chemin = opts.pipeline || DEFAUT_PIPELINE;
    if (!cle || !nouvelEtat) {
      log('Usage : hermes etat <siren> <état> [détail]');
      log('États : ' + Object.keys(P.ETATS).join(', '));
      return;
    }
    const store = P.charger(chemin);
    const p = P.marquer(store, cle, nouvelEtat, reste.join(' '));
    P.enregistrer(store, chemin);
    log(`✓ ${p.nom} → ${nouvelEtat} (${P.ETATS[nouvelEtat]})`);
  },

  /** Opposition : `hermes stop <email|@domaine|siren> [motif]` — effet immédiat. */
  async stop(opts, args) {
    const [cible, ...motif] = args;
    const chemin = opts.pipeline || DEFAUT_PIPELINE;
    if (!cible) { log('Usage : hermes stop <email | @domaine | siren> [motif]'); return; }
    const store = P.charger(chemin);

    let cri;
    if (cible.startsWith('@')) cri = { domaine: cible.slice(1) };
    else if (/^\d{9}$/.test(cible)) cri = { siren: cible };
    else cri = { email: cible };

    const touches = P.exclure(store, cri, motif.join(' ') || 'demande de désinscription');
    P.enregistrer(store, chemin);
    log(`✓ Opposition enregistrée pour ${cible} — ${touches} prospect(s) basculé(s) en « exclu ».`);
    log('  L’exclusion est vérifiée avant chaque rédaction : ce contact ne sera plus jamais sollicité.');
  },

  /** Vue d'ensemble : où en est la prospection, et quoi faire aujourd'hui. */
  async suivi(opts) {
    const chemin = opts.pipeline || DEFAUT_PIPELINE;
    if (!fs.existsSync(chemin)) { log('Aucun pipeline. Lancez d’abord : hermes capture --departement 69'); return; }
    const store = P.charger(chemin);
    const s = P.statistiques(store);

    log(`Pipeline — ${s.total} prospects, ${s.joignables} joignables\n`);
    const large = Math.max(...Object.keys(P.ETATS).map((e) => e.length));
    for (const [etat, libelle] of Object.entries(P.ETATS)) {
      const n = s.parEtat[etat] || 0;
      if (!n) continue;
      const barre = '█'.repeat(Math.min(40, Math.round((n / Math.max(1, s.total)) * 40)));
      log(`  ${etat.padEnd(large)} ${String(n).padStart(4)}  ${barre} ${libelle}`);
    }
    log(`\n  Contactés : ${s.contactes} · Réponses : ${s.reponses} · Taux de réponse : ${s.tauxReponse} %`);
    log(`  Registre d’opposition : ${s.exclusions} entrée(s)`);

    const du = P.aTraiter(store, {
      limite: Number(opts.limite) || 1000,
      scoreMin: Number(opts.score) || 0
    });
    log(`\nÀ traiter aujourd’hui : ${du.length}`);
    const parEtape = du.reduce((a, d) => (a[d.etape] = (a[d.etape] || 0) + 1, a), {});
    for (const [e, n] of Object.entries(parEtape)) log(`  ${n} × ${e}`);
    if (du.length) {
      log('\n  Les mieux notés :');
      for (const d of du.slice(0, 5)) {
        log(`    ${String(d.prospect.score).padStart(3)} ${d.prospect.nom} — ${(d.prospect.emails || [])[0] || 'sans e-mail'} (${d.etape})`);
      }
      log('\n  → hermes messages --limite 20');
    }
  },

  /** Calendrier de publication réseaux sociaux. */
  async posts(opts) {
    return PUB.run(opts);
  },

  /** Régénère le tableau de bord HTML à partir de l'état courant du pipeline. */
  async tableau(opts) {
    const chemin = opts.pipeline || DEFAUT_PIPELINE;
    if (!fs.existsSync(chemin)) { log('Aucun pipeline à afficher.'); return; }
    const store = P.charger(chemin);
    const fiches = Object.values(store.prospects)
      .filter((p) => p.etat !== 'exclu')
      .map((p) => Object.assign({}, p, {
        emails: p.emails || [], telephones: p.telephones || [],
        qualifications: p.qualifications || [], sources: p.sources || [],
        indices: [], provenance: {}, score: p.score || 0
      }))
      .sort((a, b) => (b.score || 0) - (a.score || 0));

    const sortie = (opts.sortie || 'data/prospects') + '.html';
    const dossier = path.dirname(sortie);
    if (dossier && dossier !== '.') fs.mkdirSync(dossier, { recursive: true });
    fs.writeFileSync(sortie, C.versTableauDeBord(fiches, 'Pipeline — ' + new Date().toISOString().slice(0, 10)), 'utf8');
    log(`✓ ${fiches.length} prospects → ${sortie}`);
  }
};

/* ===================== Ligne de commande ===================== */

const AIDE = `
Hermès — flotte d'agents commerciaux RDF-SOLAR

  capture    Croise les sources et alimente le pipeline
             --departement 69 --pages 3 [--rge-csv f.csv] [--sans-site]

  synchro    Échange avec le SaaS : descend les prospects du CRM dans le
             pipeline, et remonte les fiches locales avec --pousser
             [--url https://app.eviatek.fr] [--limite 500] [--pousser]

  inspection Visite les sites des prospects : simulateur en place, niveau
             technique, données réclamées, enseigne et couleurs
             --limite 25 [--rejouer]

  messages   Rédige les messages dus (n'envoie rien)
             --limite 20 --score 60 [--marquer]

  envoi      Envoie les messages dus — SIMULATION par défaut
             --limite 10 [--envoyer] [--score 60] [--forcer] [--sans-saas]

  suivi      Où en est la prospection, et quoi faire aujourd'hui

  etat       Change l'état d'un prospect
             hermes etat <siren> <état> [détail]

  stop       Enregistre une opposition — effet immédiat et définitif
             hermes stop <email | @domaine | siren> [motif]

  posts      Calendrier de publication réseaux sociaux
             --semaines 4 [--debut 2026-09-01]

  tableau    Régénère le tableau de bord HTML du pipeline

Option commune : --pipeline data/pipeline.json

Variables d'environnement (jamais dans le dépôt) :
  RDF_SAAS_URL, RDF_SAAS_JETON              accès à la console
  RDF_SMTP_UTILISATEUR, RDF_SMTP_MOTDEPASSE boîte d'envoi (mot de passe
                                            d'application, pas celui du compte)

Enchaînement type :
  1. hermes synchro                          les prospects du CRM entrent
  2. hermes inspection --limite 25           on regarde leurs sites
  3. hermes suivi                            quoi faire aujourd'hui
  4. hermes envoi --limite 10                simulation : on relit
  5. hermes envoi --limite 10 --envoyer      c'est parti, cadence maîtrisée
`;

async function principal(argv) {
  const commande = argv[0];
  if (!commande || commande === 'help' || commande === '--help') { console.log(AIDE); return 0; }
  if (!COMMANDES[commande]) { console.error('Commande inconnue : ' + commande); console.log(AIDE); return 1; }

  const opts = {};
  const positionnels = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const c = argv[i].slice(2);
      opts[c] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else positionnels.push(argv[i]);
  }

  try {
    await COMMANDES[commande](opts, positionnels);
    return 0;
  } catch (e) {
    console.error('Échec :', e.message);
    return 1;
  }
}

if (require.main === module) {
  principal(process.argv.slice(2)).then((c) => process.exit(c));
}

module.exports = { COMMANDES, principal, AIDE };
