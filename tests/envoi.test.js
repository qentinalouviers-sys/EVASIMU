/**
 * Tests de l'envoi — node tests/envoi.test.js
 *
 * Ce module peut faire deux dégâts irréversibles : écrire à quelqu'un qui a
 * demandé qu'on le laisse tranquille, et brûler la réputation du domaine en
 * envoyant trop vite. Les tests portent d'abord là-dessus, ensuite seulement
 * sur le fait que le courrier parte.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const E = require('../agents/envoi.js');
const P = require('../agents/pipeline.js');
const R = require('../agents/redaction.js');

process.env.HERMES_SILENCE = '1';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-envoi-'));
const fichier = (n) => path.join(tmp, n);
const mardi = (h) => new Date(2026, 7, 11, h, 0, 0);   // 11 août 2026 = mardi
const samedi = (h) => new Date(2026, 7, 15, h, 0, 0);
const mxOk = async () => [{ exchange: 'mx.test', priority: 10 }];
const mxAbsent = async () => [];

function pipelineDe(prospects) {
  const store = P.vide();
  P.integrer(store, prospects);
  const c = fichier('pipeline-' + Math.random().toString(36).slice(2) + '.json');
  P.enregistrer(store, c);
  return c;
}
const prospect = (o) => Object.assign(
  { nom: 'Test', siren: '812345678', emails: ['contact@exemple.fr'], score: 50 }, o);

/* ===================== Rampe de chauffe ===================== */
console.log('Rampe de chauffe');
{
  const c = E.CONFIG;
  const j = (premierJour) => Object.assign(E.journalVide(), { premierJour });
  check('jamais envoyé → quota initial',
    E.quotaDuJour(c, E.journalVide(), mardi(9)) === 5);
  check('premier jour → 5', E.quotaDuJour(c, j('2026-08-11'), mardi(9)) === 5);
  check('deuxième jour → 10', E.quotaDuJour(c, j('2026-08-10'), mardi(9)) === 10);
  check('cinquième jour → 25', E.quotaDuJour(c, j('2026-08-07'), mardi(9)) === 25);
  check('le plafond ne bouge plus après un mois',
    E.quotaDuJour(c, j('2026-07-01'), mardi(9)) === 25);
  check('la rampe ne redescend jamais sous le quota initial',
    E.quotaDuJour(c, j('2026-08-11'), mardi(9)) >= c.quotaInitial);
}

console.log('\nFenêtre d’envoi');
{
  const c = E.CONFIG;
  check('9 h un mardi : oui', E.dansLesHeures(mardi(9), c));
  check('7 h : trop tôt', !E.dansLesHeures(mardi(7), c));
  check('18 h : trop tard', !E.dansLesHeures(mardi(18), c));
  check('3 h du matin : non', !E.dansLesHeures(mardi(3), c));
  check('samedi 10 h : non', !E.dansLesHeures(samedi(10), c));
}

console.log('\nSeuil de rebonds');
{
  const c = E.CONFIG;
  check('taux calculé sur les tentatives', E.tauxRebonds({ envoyes: 90, rebonds: 10 }) === 10);
  check('aucune tentative → 0 %', E.tauxRebonds({ envoyes: 0, rebonds: 0 }) === 0);
  check('2 rebonds sur 2 : échantillon trop petit pour juger',
    !E.tropDeRebonds({ envoyes: 0, rebonds: 2 }, c));
  check('6 rebonds sur 100 : au-dessus du seuil',
    E.tropDeRebonds({ envoyes: 94, rebonds: 6 }, c));
  check('5 rebonds sur 100 : sous le seuil, on continue',
    !E.tropDeRebonds({ envoyes: 95, rebonds: 5 }, c));
}

/* ===================== Contrôle MX ===================== */
console.log('\nContrôle des adresses');
(async () => {
  check('domaine avec MX accepté', (await E.verifierMx('a@avec-mx.fr', mxOk)).ok);
  const sans = await E.verifierMx('a@sans-mx.fr', mxAbsent);
  check('domaine sans MX refusé, avec motif', !sans.ok && /aucun serveur/.test(sans.raison), sans.raison);
  const ko = await E.verifierMx('a@introuvable.fr', async () => { const e = new Error('x'); e.code = 'ENOTFOUND'; throw e; });
  check('domaine introuvable refusé', !ko.ok && /introuvable/.test(ko.raison), ko.raison);
  const nul = await E.verifierMx('pas-une-adresse', mxOk);
  check('adresse sans @ refusée', !nul.ok);

  /* ===================== Protocole SMTP ===================== */
  console.log('\nProtocole SMTP');
  check('ligne commençant par un point protégée',
    E.protegerPoints('a\r\n.b') === 'a\r\n..b', E.protegerPoints('a\r\n.b'));
  check('point en tout début protégé', E.protegerPoints('.a') === '..a');
  check('texte ordinaire inchangé', E.protegerPoints('a\r\nb') === 'a\r\nb');

  {
    // Réponse multiligne : c'est ce que renvoie tout serveur réel à EHLO.
    const s = new EventEmitter();
    s.setEncoding = () => {};
    const d = E.creerDialogue(s);
    const attente = d.attendre();
    s.emit('data', '250-smtp.test\r\n250-SIZE 35882577\r\n250 AUTH LOGIN\r\n');
    const r = await attente;
    check('réponse multiligne lue en une fois', r.code === 250, JSON.stringify(r));
  }
  {
    // Réponse arrivée avant qu'on l'attende : elle ne doit pas être perdue.
    const s = new EventEmitter();
    s.setEncoding = () => {};
    const d = E.creerDialogue(s);
    s.emit('data', '220 prêt\r\n');
    const r = await d.attendre();
    check('bannière reçue avant l’attente n’est pas perdue', r.code === 220);
  }

  /** Serveur factice : répond dans l'ordre à chaque écriture. */
  function fauxServeur(reponses) {
    const s = new EventEmitter();
    s.ecrits = [];
    s.setEncoding = () => {};
    s.destroy = () => { s.detruit = true; };
    s.write = (d) => { s.ecrits.push(d); setImmediate(() => s.emit('data', reponses.shift() || '')); return true; };
    const connecteur = (o, cb) => { setImmediate(() => { cb(); setImmediate(() => s.emit('data', '220 prêt\r\n')); }); return s; };
    return { socket: s, connecteur };
  }

  const conversationOk = [
    '250-smtp\r\n250 AUTH LOGIN\r\n', '334 VXNlcm5hbWU6\r\n', '334 UGFzc3dvcmQ6\r\n',
    '235 ok\r\n', '250 ok\r\n', '250 ok\r\n', '354 go\r\n', '250 accepté\r\n', '221 bye\r\n'
  ];

  {
    const f = fauxServeur(conversationOk.slice());
    const r = await E.envoyerSmtp(
      { hote: 'x', port: 465, utilisateur: 'moi@eviatek.fr', motDePasse: 'secret' },
      { de: 'moi@eviatek.fr', a: 'cible@exemple.fr', contenu: 'Subject: test\r\n\r\ncorps' },
      f.connecteur);
    check('message accepté', r.envoye === true);
    const dit = f.socket.ecrits.join('');
    check('EHLO avec le domaine de l’expéditeur', /EHLO eviatek\.fr/.test(dit));
    check('identifiants encodés en base64',
      dit.includes(Buffer.from('secret').toString('base64')));
    check('mot de passe jamais en clair sur le fil', !/secret\r\n/.test(dit));
    check('enveloppe correcte',
      /MAIL FROM:<moi@eviatek\.fr>/.test(dit) && /RCPT TO:<cible@exemple\.fr>/.test(dit));
    check('corps terminé par le point isolé', /\r\n\.\r\n/.test(dit));
    check('connexion refermée', f.socket.detruit === true);
  }
  {
    const rep = conversationOk.slice();
    rep[5] = '550 adresse inconnue\r\n';   // refus sur RCPT TO
    const f = fauxServeur(rep);
    let err = null;
    await E.envoyerSmtp({ hote: 'x', port: 465, utilisateur: 'moi@eviatek.fr', motDePasse: 's' },
      { de: 'moi@eviatek.fr', a: 'cible@exemple.fr', contenu: 'x' }, f.connecteur).catch((e) => { err = e; });
    check('destinataire refusé → erreur', !!err && err.code === 550, err && err.message);
    check('un 5xx est compté comme rebond', err.rebond === true);
    check('connexion refermée malgré l’échec', f.socket.detruit === true);
  }
  {
    const rep = conversationOk.slice();
    rep[3] = '535 identifiants refusés\r\n';
    const f = fauxServeur(rep);
    let err = null;
    await E.envoyerSmtp({ hote: 'x', port: 465, utilisateur: 'a@b.fr', motDePasse: 'faux' },
      { de: 'a@b.fr', a: 'c@d.fr', contenu: 'x' }, f.connecteur).catch((e) => { err = e; });
    check('mot de passe refusé → erreur explicite', !!err && /535/.test(err.message), err && err.message);
  }

  /* ===================== Orchestration ===================== */
  console.log('\nSimulation : rien ne part par défaut');
  {
    const pipeline = pipelineDe([prospect({})]);
    const journal = fichier('j1.json');
    const b = await E.run({ pipeline, journal, maintenant: mardi(10), resolveur: mxOk, sansPause: true });
    check('mode simulation par défaut', b.simulation === true);
    check('le message est compté mais pas envoyé', b.envoyes === 1);
    check('aucun journal d’envoi écrit', !fs.existsSync(journal));
    check('le pipeline n’a pas bougé',
      P.charger(pipeline).prospects['812345678'].etat === 'nouveau');
  }

  console.log('\nGarde-fous avant envoi');
  {
    const b = await E.run({
      pipeline: pipelineDe([prospect({})]), journal: fichier('j2.json'),
      maintenant: samedi(10), envoyer: true, resolveur: mxOk, sansPause: true,
      config: { utilisateur: 'a@b.fr', motDePasse: 'x' }
    });
    check('samedi : rien n’est envoyé', b.envoyes === 0);
  }
  {
    const b = await E.run({
      pipeline: pipelineDe([prospect({})]), journal: fichier('j3.json'),
      maintenant: mardi(3), envoyer: true, resolveur: mxOk, sansPause: true,
      config: { utilisateur: 'a@b.fr', motDePasse: 'x' }
    });
    check('3 h du matin : rien n’est envoyé', b.envoyes === 0);
  }
  {
    let err = null;
    await E.run({
      pipeline: pipelineDe([prospect({})]), journal: fichier('j4.json'),
      maintenant: mardi(10), envoyer: true, resolveur: mxOk, sansPause: true,
      config: { utilisateur: '', motDePasse: '' }
    }).catch((e) => { err = e; });
    check('identifiants SMTP absents → refus explicite',
      !!err && /mot de passe d’application/.test(err.message), err && err.message);
  }
  {
    const pipeline = pipelineDe([
      prospect({ siren: '812345678', emails: ['a@un.fr'] }),
      prospect({ siren: '912345678', nom: 'Deux', emails: ['b@deux.fr'] }),
      prospect({ siren: '712345678', nom: 'Trois', emails: ['c@trois.fr'] })
    ]);
    const journal = fichier('j5.json');
    const j = Object.assign(E.journalVide(), { premierJour: '2026-08-11', jours: { '2026-08-11': { envoyes: 4, rebonds: 0 } } });
    E.enregistrerJournal(j, journal);
    const b = await E.run({ pipeline, journal, maintenant: mardi(10), resolveur: mxOk, sansPause: true });
    check('quota du jour respecté : 4 déjà partis sur 5, il en reste 1',
      b.quota === 5 && b.reste === 1 && b.envoyes === 1, JSON.stringify(b));
  }
  {
    const store = P.vide();
    P.integrer(store, [prospect({ emails: ['stop@exemple.fr'] })]);
    P.exclure(store, { email: 'stop@exemple.fr' }, 'STOP');
    // On remet volontairement l'état à « nouveau » pour vérifier que le contrôle
    // fait juste avant l'envoi rattrape ce qu'une sélection laisserait passer.
    store.prospects['812345678'].etat = 'nouveau';
    const pipeline = fichier('p-exclu.json');
    P.enregistrer(store, pipeline);
    const b = await E.run({ pipeline, journal: fichier('j6.json'), maintenant: mardi(10),
      resolveur: mxOk, sansPause: true });
    check('le registre d’opposition est revérifié juste avant l’envoi', b.envoyes === 0, JSON.stringify(b));
    check('le motif du refus est nommé',
      b.ignores.length === 1 && /opposition/.test(b.ignores[0].raison), JSON.stringify(b.ignores));
  }
  {
    const b = await E.run({
      pipeline: pipelineDe([prospect({})]), journal: fichier('j7.json'),
      maintenant: mardi(10), resolveur: mxAbsent, sansPause: true
    });
    check('adresse sans MX : écartée avant l’envoi', b.envoyes === 0 && b.rebonds === 1, JSON.stringify(b));
  }
  {
    const b = await E.run({
      pipeline: pipelineDe([prospect({ emails: [] })]), journal: fichier('j8.json'),
      maintenant: mardi(10), resolveur: mxOk, sansPause: true
    });
    check('prospect sans adresse : ni envoi ni plantage', b.envoyes === 0);
  }

  console.log('\nEnvoi réel');
  {
    const pipeline = pipelineDe([prospect({})]);
    const journal = fichier('j9.json');
    const f = fauxServeur(conversationOk.slice());
    const b = await E.run({
      pipeline, journal, maintenant: mardi(10), envoyer: true, resolveur: mxOk,
      sansPause: true, connecteur: f.connecteur,
      config: { utilisateur: 'moi@eviatek.fr', motDePasse: 'secret' }
    });
    check('message parti', b.envoyes === 1 && b.simulation === false, JSON.stringify(b));
    check('le pipeline avance à « contacte »',
      P.charger(pipeline).prospects['812345678'].etat === 'contacte');
    const j = E.chargerJournal(journal);
    check('la rampe démarre au premier envoi réel', j.premierJour === '2026-08-11', j.premierJour);
    check('le quota du jour est décompté', j.jours['2026-08-11'].envoyes === 1);
    check('l’envoi est tracé', j.envois.length === 1 && j.envois[0].destinataire === 'contact@exemple.fr');

    const contenu = f.socket.ecrits.join('');
    check('en-tête List-Unsubscribe présent', /List-Unsubscribe: <mailto:/.test(contenu));
    check('en-tête Date présent', /\r?\nDate: /.test('\n' + contenu));
    check('aucun en-tête X-Hermes ne fuit', !/X-Hermes/.test(contenu));
  }
  {
    // Une remontée en échec ne doit pas faire échouer un envoi déjà parti.
    const pipeline = pipelineDe([prospect({})]);
    const f = fauxServeur(conversationOk.slice());
    const b = await E.run({
      pipeline, journal: fichier('j10.json'), maintenant: mardi(10), envoyer: true,
      resolveur: mxOk, sansPause: true, connecteur: f.connecteur,
      client: { majProspect: async () => { throw new Error('SaaS injoignable'); },
        journaliser: async () => {} },
      config: { utilisateur: 'moi@eviatek.fr', motDePasse: 's' }
    });
    check('console injoignable : le message part quand même', b.envoyes === 1, JSON.stringify(b));
    check('et l’état reste cohérent',
      P.charger(pipeline).prospects['812345678'].etat === 'contacte');
  }

  console.log('\nCohérence avec la rédaction');
  {
    check('le domaine de l’émetteur résout (plus de rdf-solar.fr)',
      /eviatek\.fr$/.test(R.EMETTEUR.email), R.EMETTEUR.email);
    const m = R.rediger(prospect({}), 'premier', '812345678');
    const eml = R.versEml(m, 'moi@eviatek.fr', mardi(10));
    check('Message-ID stable d’une exécution à l’autre',
      R.versEml(m, 'moi@eviatek.fr', mardi(11)).match(/Message-ID: (\S+)/)[1] ===
      eml.match(/Message-ID: (\S+)/)[1]);
    check('Reply-To renseigné', /Reply-To: moi@eviatek\.fr/.test(eml));
    check('pas de markdown dans le corps',
      !/\*\*/.test(Buffer.from(eml.split('\r\n\r\n')[1], 'base64').toString('utf8')));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + passed + ' tests réussis, ' + failed + ' échec(s)');
  process.exit(failed ? 1 : 0);
})();
