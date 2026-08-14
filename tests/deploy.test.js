/**
 * Tests des scripts de déploiement — node tests/deploy.test.js
 *
 * Ces scripts tournent en root sur un serveur de production, et `set -e` les
 * arrête à la première commande inconnue. Une faute de frappe dans un nom de
 * fonction ne se voit donc qu'au moment où elle casse une mise à jour — c'est
 * exactement ce qui est arrivé avec un `attn` appelé dans `mise-a-jour.sh` mais
 * défini seulement dans les deux autres scripts : la mise à jour s'est
 * interrompue juste après la sauvegarde, laissant le serveur sur l'ancienne
 * version sans rien expliquer.
 *
 * Le contrôle porte donc précisément sur ce défaut-là : **un nom qui est une
 * fonction d'aide quelque part dans `deploy/` doit être défini dans le script
 * qui l'appelle**. Vouloir vérifier en plus l'existence de chaque binaire
 * donnerait des faux positifs sans fin — `nginx` ou `certbot` sont absents ici
 * et présents sur le serveur — et masquerait le seul contrôle qui compte.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let passed = 0, failed = 0;
function check(nom, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + nom); }
  else { failed++; console.error('  ✗ ' + nom + (detail ? ' — ' + detail : '')); }
}

const DOSSIER = path.join(__dirname, '..', 'deploy');
const SCRIPTS = fs.readdirSync(DOSSIER).filter((f) => f.endsWith('.sh'));
const source = (f) => fs.readFileSync(path.join(DOSSIER, f), 'utf8');

/** Noms des fonctions définies dans un script. */
function fonctions(texte) {
  const out = new Set();
  const re = /^\s*(?:function\s+)?([A-Za-zÀ-ÿ_][\w-]*)\s*\(\)\s*\{/gm;
  let m;
  while ((m = re.exec(texte)) !== null) out.add(m[1]);
  return out;
}

/**
 * Mots invoqués comme commande. Les substitutions `$(…)` sont retirées : ce
 * qu'elles contiennent est déjà du code analysé par ailleurs, et leur laisser
 * passer `$(git rev-parse …)` ferait croire à un appel de « rev-parse ».
 */
function appels(texte) {
  const out = new Map();
  let heredoc = null;

  texte.split('\n').forEach((brute, i) => {
    if (heredoc !== null) {
      if (brute.trim() === heredoc) heredoc = null;
      return;
    }
    const ouverture = brute.match(/<<-?\s*'?"?([A-Za-z_][A-Za-z0-9_]*)'?"?/);
    if (ouverture) heredoc = ouverture[1];

    const ligne = brute
      .replace(/\$\([^)]*\)/g, ' ')      // substitutions de commande
      .replace(/`[^`]*`/g, ' ')
      .replace(/#.*$/, '')
      .trim();
    if (!ligne) return;

    for (let segment of ligne.split(/(?:\|\||&&|[;|])/)) {
      segment = segment.trim()
        .replace(/^!\s*/, '')
        .replace(/^(?:if|then|else|elif|do|while|until|sudo|command)\s+/, '')
        .replace(/^\w+=\S*\s+/, '');
      const m = segment.match(/^([A-Za-zÀ-ÿ_][\w-]*)(?:\s|$)/);
      if (!m) continue;
      if (new RegExp('^' + m[1] + '\\s*=').test(segment)) continue;
      if (!out.has(m[1])) out.set(m[1], i + 1);
    }
  });
  return out;
}

// L'ensemble des fonctions d'aide du dossier : un nom qui en fait partie et
// qu'un script appelle sans le définir est une erreur, pas un binaire système.
const AIDES = new Set();
SCRIPTS.forEach((f) => fonctions(source(f)).forEach((n) => AIDES.add(n)));

let bashDispo = true;
try { execFileSync('bash', ['-c', 'true']); } catch (e) { bashDispo = false; }

console.log('Scripts de déploiement');
check('des scripts sont présents', SCRIPTS.length > 0, SCRIPTS.join(', '));
check('les fonctions d’aide sont repérées', AIDES.has('attn') && AIDES.has('info'),
  [...AIDES].join(', '));

for (const nom of SCRIPTS) {
  const texte = source(nom);

  if (bashDispo) {
    let erreur = '';
    try { execFileSync('bash', ['-n', path.join(DOSSIER, nom)], { stdio: 'pipe' }); }
    catch (e) { erreur = String(e.stderr || e.message).trim(); }
    check(nom + ' : syntaxe valide', !erreur, erreur.slice(0, 200));
  }

  const definies = fonctions(texte);
  const manquantes = [];
  for (const [mot, ligne] of appels(texte)) {
    if (AIDES.has(mot) && !definies.has(mot)) manquantes.push(mot + ' (l. ' + ligne + ')');
  }
  check(nom + ' : toute fonction d’aide appelée y est définie', manquantes.length === 0,
    manquantes.join(', '));
}

// Un script de diagnostic doit continuer malgré une commande en échec — c'est
// son travail de constater ce qui ne marche pas. Les deux autres agissent sur
// un serveur : ils doivent s'arrêter au premier problème.
for (const nom of ['installer.sh', 'mise-a-jour.sh']) {
  check(nom + ' : arrêt sur erreur activé', /^set -euo pipefail/m.test(source(nom)),
    'sans « set -e », une étape ratée passe inaperçue');
}

console.log('\nLe cas précis qui a cassé une mise à jour');
{
  const maj = source('mise-a-jour.sh');
  const definies = fonctions(maj);
  for (const aide of ['rouge', 'vert', 'info', 'attn', 'depot']) {
    check('mise-a-jour.sh définit « ' + aide + ' »', definies.has(aide));
  }
  // Ce qui compte est que la sauvegarde précède toute MODIFICATION de l'arbre.
  // `fetch` n'en est pas une : il remplit .git sans toucher aux fichiers, et il
  // passe désormais en premier pour savoir s'il y a seulement quelque chose à
  // faire — sans quoi une minuterie sauvegarderait la base toutes les dix
  // minutes. Les deux commandes qui écrivent réellement sont checkout et reset.
  check('la sauvegarde précède le checkout',
    maj.indexOf('sauvegarde.js') < maj.indexOf('depot checkout'),
    'une mise à jour doit rester annulable');
  check('la sauvegarde précède l’effacement des modifications locales',
    maj.indexOf('sauvegarde.js') < maj.indexOf('reset --quiet --hard'));
  check('on ne sauvegarde pas quand il n’y a rien à faire',
    maj.indexOf('depot fetch') < maj.indexOf('sauvegarde.js') &&
    /AVANT" == "\$CIBLE"/.test(maj),
    'sinon une minuterie remplit le disque de sauvegardes identiques');
  check('le port de sonde est lu dans la configuration, pas écrit en dur',
    /\/etc\/rdf-solar\.env/.test(maj) && !/127\.0\.0\.1:8080/.test(maj));
  check('git tourne avec safe.directory (dépôt possédé par un autre utilisateur)',
    /safe\.directory/.test(maj));
  check('les modifications locales sont archivées avant d’être effacées',
    maj.indexOf('.patch') < maj.indexOf('reset --quiet --hard'));

  // Bash lit un script par décalage d'octets, au fil de son exécution. Ce
  // script réécrit son propre fichier (`git checkout`) : sans recopie
  // préalable hors du dépôt, une mise à jour qui change la taille du script
  // fait reprendre l'interpréteur au milieu d'une ligne.
  check('le script se recopie hors du dépôt avant d’y toucher',
    /RDF_MAJ_COPIE/.test(maj) && /exec bash/.test(maj));
  check('la recopie précède le checkout',
    maj.indexOf('RDF_MAJ_COPIE') < maj.indexOf('depot checkout'));
  check('la copie temporaire se supprime en sortant', /trap .*rm -f/.test(maj));
}

console.log('\nMise à jour automatique');
{
  const unites = fs.readdirSync(DOSSIER).filter((f) => /\.(service|timer)$/.test(f));
  check('l’unité et la minuterie existent',
    unites.includes('rdf-maj.service') && unites.includes('rdf-maj.timer'), unites.join(', '));

  const svc = fs.readFileSync(path.join(DOSSIER, 'rdf-maj.service'), 'utf8');
  const tmr = fs.readFileSync(path.join(DOSSIER, 'rdf-maj.timer'), 'utf8');
  check('elle appelle le script de mise à jour en mode silencieux',
    /mise-a-jour\.sh --silencieux/.test(svc), svc);
  check('elle est ponctuelle, pas un service permanent', /Type=oneshot/.test(svc));
  check('elle ne peut pas rester accrochée', /TimeoutStartSec=/.test(svc));
  check('le chemin est substitué à l’installation', /@RACINE@/.test(svc));
  check('la minuterie se répète', /OnUnitActiveSec=/.test(tmr));
  check('avec un décalage aléatoire', /RandomizedDelaySec=/.test(tmr));
  check('sans rattrapage au démarrage', /Persistent=false/.test(tmr),
    'un rattrapage déploierait avant que le réseau soit prêt');

  const inst = source('installer.sh');
  check('l’installeur pose les deux fichiers',
    /poser_unite rdf-maj\.service/.test(inst) &&
    /install .*rdf-maj\.timer.*\/etc\/systemd\/system\/rdf-maj\.timer/.test(inst),
    (inst.match(/.*rdf-maj\.timer.*/) || ['(aucune ligne)'])[0]);
  check('et active la minuterie', /enable --now rdf-maj\.timer/.test(inst));

  // Le mode silencieux ne doit pas rendre les échecs muets : seul le cas
  // « rien à faire » se tait, une panne doit rester visible dans le journal.
  const maj = source('mise-a-jour.sh');
  check('le silence ne couvre que l’absence de nouveauté',
    /discret\(\)/.test(maj) && /rouge "Impossible de joindre le dépôt/.test(maj));
  check('un échec de récupération n’est jamais silencieux',
    maj.indexOf('Impossible de joindre le dépôt') > 0 &&
    !/discret "Impossible/.test(maj));

  // `VAR=1 exec bash …` place la variable dans l'ENVIRONNEMENT, donc dans celui
  // de tous les enfants — `npm test` compris. Sans ce nettoyage, la suite
  // lancée par le script héritait de la sentinelle, le test de recopie ne
  // testait plus rien, et la mise à jour automatique s'annulait elle-même.
  check('la sentinelle de recopie ne fuit pas vers les enfants',
    /unset RDF_MAJ_COPIE/.test(maj), 'sinon npm test hérite de RDF_MAJ_COPIE=1');
  check('le nettoyage précède le lancement des tests',
    maj.indexOf('unset RDF_MAJ_COPIE') < maj.indexOf('&& npm test'));

  // Une unité ajoutée au dépôt doit être enregistrée par la mise à jour, sinon
  // le fichier arrive sur le disque et rien ne le lit — exactement le piège que
  // cette minuterie est censée supprimer.
  check('la mise à jour réenregistre les unités systemd',
    /\/etc\/systemd\/system\/\$u/.test(maj) && /systemctl daemon-reload/.test(maj));
  check('et active la minuterie si elle ne l’était pas',
    /enable --now rdf-maj\.timer/.test(maj));
  check('les unités sont posées avant le redémarrage',
    maj.indexOf('daemon-reload') < maj.indexOf('systemctl restart rdf-saas'));
  check('sans interpréteur identifiable, on ne réécrit rien',
    /-x "\$NODE_BIN"/.test(maj) && /unités laissées telles quelles/.test(maj),
    'réécrire une unité avec un mauvais chemin casserait le service');
}

console.log('\nLe proxy PVGIS ne vole pas le port du SaaS');
{
  // /etc/rdf-solar.env définit PORT (le SaaS) et PORT_PVGIS (le proxy). Comme
  // systemd fait primer EnvironmentFile sur Environment quel que soit l'ordre
  // des directives, un proxy qui lirait PORT se liait sur le port du SaaS :
  // EADDRINUSE, puis 404 à la sonde de déploiement, puis retour arrière.
  const unite = fs.readFileSync(path.join(DOSSIER, 'rdf-pvgis.service'), 'utf8');
  check('l’unité déclare PORT_PVGIS, pas PORT',
    /^Environment=PORT_PVGIS=/m.test(unite) && !/^Environment=PORT=/m.test(unite),
    (unite.match(/^Environment=.*/m) || ["(aucune)"])[0]);
  check('elle n’affirme plus que l’ordre des directives l’emporte',
    !/donc celle-ci l.emporte/.test(unite),
    'un commentaire faux invite à défaire le correctif');

  const proxy = fs.readFileSync(path.join(DOSSIER, '..', 'server', 'pvgis-proxy.js'), 'utf8');
  check('le proxy lit PORT_PVGIS en priorité',
    /process\.env\.PORT_PVGIS \|\| process\.env\.PORT/.test(proxy), 
    'sinon il se lie sur le port du SaaS');
  check('et garde PORT en repli pour les installations d’avant',
    /process\.env\.PORT, 10\) \|\| 8787/.test(proxy));
}

console.log('\nLa recopie résiste à la réécriture du fichier d’origine');
if (bashDispo) {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rdf-maj-'));
  const cible = path.join(tmp, 'script.sh');
  // Le script témoin emprunte l'en-tête réel, mais avec SON PROPRE nom de
  // sentinelle : sinon un `RDF_MAJ_COPIE` déjà présent dans l'environnement
  // ferait croire au témoin que la recopie a eu lieu, et le test ne vérifierait
  // plus rien tout en paraissant passer. C'est exactement ce qui arrivait quand
  // `mise-a-jour.sh` lançait `npm test` depuis sa propre copie.
  const entete = source('mise-a-jour.sh').split('RACINE=')[0]
    .replace(/RDF_MAJ_COPIE/g, 'RDF_TEMOIN_COPIE');
  fs.writeFileSync(cible, entete +
    'echo "DEPUIS:$0"\n' +
    'echo "corrompu et bien plus long qu’avant, de quoi décaler la lecture" > "' + cible + '"\n' +
    'sleep 0.2\n' +
    'echo "VIVANT"\n', 'utf8');

  let sortie = '';
  try { sortie = execFileSync('bash', [cible], { encoding: 'utf8', timeout: 15000 }); }
  catch (e) { sortie = String(e.stdout || '') + String(e.stderr || ''); }

  check('le script s’exécute depuis une copie hors du dépôt',
    /DEPUIS:\/tmp\/rdf-maj-/.test(sortie), sortie.trim().slice(0, 160));
  check('il survit à la réécriture de son propre fichier',
    /VIVANT/.test(sortie), sortie.trim().slice(0, 160));
  check('la copie temporaire ne traîne pas derrière elle',
    (sortie.match(/DEPUIS:(\S+)/) || [])[1] === undefined ||
    !fs.existsSync((sortie.match(/DEPUIS:(\S+)/) || [])[1]));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n' + passed + ' tests réussis, ' + failed + ' échec(s)');
process.exit(failed ? 1 : 0);
