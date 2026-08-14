/**
 * Tests du pipeline commercial et de la rédaction — node tests/pipeline.test.js
 *
 * Ce qui est vérifié en priorité, ce sont les protections : ne pas recontacter
 * quelqu'un qui s'est désinscrit, ne pas relancer qui a répondu, ne pas écraser
 * une relation en cours quand on recapture.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../agents/pipeline.js');
const R = require('../agents/redaction.js');
const PUB = require('../agents/publication.js');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const jour = (s) => new Date(s + 'T12:00:00Z');
const fiche = (o) => Object.assign({
  nom: 'DUPONT ENERGIE', siren: '812345678', ville: 'Lyon', codePostal: '69001',
  emails: ['contact@dupont-energie.fr'], telephones: ['0478123456'],
  qualifPV: true, rge: true, aSimulateur: false, score: 90,
  siteWeb: 'https://www.dupont-energie.fr', sources: ['entreprises', 'rge', 'site']
}, o);

/* ===================== Intégration ===================== */
console.log('Intégration des fiches');
{
  const s = P.vide();
  const b = P.integrer(s, [fiche(), fiche({ siren: '999', nom: 'MARTIN' })], jour('2026-08-01'));
  check('ajoute les nouvelles fiches', b.ajoutes === 2 && Object.keys(s.prospects).length === 2);
  check('état initial « nouveau »', s.prospects['812345678'].etat === 'nouveau');
  check('capture tracée dans l’historique', s.prospects['812345678'].historique[0].evenement === 'capture');

  // Une relance a eu lieu : une recapture ne doit rien réinitialiser
  P.marquer(s, '812345678', 'contacte', 'premier envoi', jour('2026-08-05'));
  const b2 = P.integrer(s, [fiche({ telephones: ['0478123456', '0600000000'] })], jour('2026-08-10'));
  check('une recapture ne réinitialise pas l’état', s.prospects['812345678'].etat === 'contacte');
  check('la recapture enrichit les contacts', s.prospects['812345678'].telephones.length === 2, b2.actualises + ' actualisé(s)');
  check('l’historique est conservé', s.prospects['812345678'].historique.length >= 3);
  check('aucun doublon créé', Object.keys(s.prospects).length === 2);
}

/* ===================== Registre d'opposition ===================== */
console.log('\nRegistre d’opposition');
{
  const s = P.vide();
  P.integrer(s, [fiche()], jour('2026-08-01'));
  P.marquer(s, '812345678', 'contacte', '', jour('2026-08-01'));

  const touches = P.exclure(s, { email: 'contact@dupont-energie.fr' }, 'a répondu STOP', jour('2026-08-03'));
  check('l’opposition bascule le prospect en « exclu »', s.prospects['812345678'].etat === 'exclu', 'touchés=' + touches);
  check('le motif est tracé', s.prospects['812345678'].historique.some((h) => h.detail.includes('STOP')));
  check('l’adresse entre au registre', s.exclusions.emails.includes('contact@dupont-energie.fr'));

  // Le point critique : une recapture ne doit pas ressusciter un exclu
  P.integrer(s, [fiche()], jour('2026-09-01'));
  check('une recapture ne réactive PAS un exclu', s.prospects['812345678'].etat === 'exclu');
  check('un exclu n’est jamais proposé au traitement', P.aTraiter(s, { maintenant: jour('2026-10-01') }).length === 0);

  // Exclusion par domaine, puis par SIREN
  const s2 = P.vide();
  P.integrer(s2, [fiche({ emails: ['jean@exemple.fr'] })], jour('2026-08-01'));
  P.exclure(s2, { domaine: 'exemple.fr' }, 'domaine entier', jour('2026-08-02'));
  check('exclusion par domaine', s2.prospects['812345678'].etat === 'exclu');

  const s3 = P.vide();
  P.exclure(s3, { siren: '812345678' }, '', jour('2026-08-01'));
  P.integrer(s3, [fiche()], jour('2026-08-02'));
  check('une fiche déjà au registre entre directement en « exclu »', s3.prospects['812345678'].etat === 'exclu');
  check('estExclu identifie le motif', P.estExclu(s3, fiche()) === 'siren', String(P.estExclu(s3, fiche())));
}

/* ===================== Transitions ===================== */
console.log('\nTransitions d’état');
{
  const s = P.vide();
  P.integrer(s, [fiche()], jour('2026-08-01'));
  P.marquer(s, '812345678', 'contacte', '', jour('2026-08-01'));
  check('nouveau → contacte autorisé', s.prospects['812345678'].etat === 'contacte');

  let leve = false;
  try { P.marquer(s, '812345678', 'gagne', '', jour('2026-08-02')); } catch (_) { leve = true; }
  check('contacte → gagne interdit (on ne saute pas d’étapes)', leve);

  leve = false;
  P.marquer(s, '812345678', 'repondu', '', jour('2026-08-03'));
  try { P.marquer(s, '812345678', 'relance1', '', jour('2026-08-10')); } catch (_) { leve = true; }
  check('on ne relance pas quelqu’un qui a répondu', leve);

  leve = false;
  P.marquer(s, '812345678', 'exclu', '', jour('2026-08-11'));
  try { P.marquer(s, '812345678', 'contacte', '', jour('2026-08-12')); } catch (_) { leve = true; }
  check('« exclu » est définitif', leve);

  leve = false;
  try { P.marquer(s, 'inconnu', 'contacte'); } catch (_) { leve = true; }
  check('prospect inconnu → erreur explicite', leve);
  leve = false;
  try { P.marquer(s, '812345678', 'zzz'); } catch (_) { leve = true; }
  check('état inconnu → erreur explicite', leve);

  check('les relances sont comptées', (() => {
    const t = P.vide();
    P.integrer(t, [fiche()], jour('2026-08-01'));
    P.marquer(t, '812345678', 'contacte', '', jour('2026-08-01'));
    P.marquer(t, '812345678', 'relance1', '', jour('2026-08-08'));
    return t.prospects['812345678'].relances === 1;
  })());
}

/* ===================== Sélection du travail ===================== */
console.log('\nSélection du travail à faire');
{
  const s = P.vide();
  P.integrer(s, [
    fiche(),
    fiche({ siren: '222', nom: 'B', score: 40 }),
    fiche({ siren: '333', nom: 'C', emails: [] })
  ], jour('2026-08-01'));

  const du = P.aTraiter(s, { maintenant: jour('2026-08-01') });
  check('les nouveaux joignables sont proposés', du.length === 2, 'à traiter=' + du.length);
  check('les prospects sans e-mail sont écartés', !du.some((d) => d.cle === '333'));
  check('les mieux notés d’abord', du[0].prospect.score >= du[1].prospect.score);
  check('étape « premier » pour un nouveau', du[0].etape === 'premier');
  check('le filtre de score s’applique', P.aTraiter(s, { maintenant: jour('2026-08-01'), scoreMin: 60 }).length === 1);
  check('la limite s’applique', P.aTraiter(s, { maintenant: jour('2026-08-01'), limite: 1 }).length === 1);

  P.marquer(s, '812345678', 'contacte', '', jour('2026-08-01'));
  check('pas de relance avant le délai',
    !P.aTraiter(s, { maintenant: jour('2026-08-05') }).some((d) => d.cle === '812345678'));
  const apres = P.aTraiter(s, { maintenant: jour('2026-08-09') }).find((d) => d.cle === '812345678');
  check('relance proposée après 7 jours de silence', apres && apres.etape === 'relance1', apres && apres.etape);

  P.marquer(s, '812345678', 'relance1', '', jour('2026-08-09'));
  check('pas de seconde relance avant 14 jours',
    !P.aTraiter(s, { maintenant: jour('2026-08-15') }).some((d) => d.cle === '812345678'));
  check('seconde relance après 14 jours',
    P.aTraiter(s, { maintenant: jour('2026-08-25') }).some((d) => d.etape === 'relance2'));

  P.marquer(s, '812345678', 'relance2', '', jour('2026-08-25'));
  check('après deux relances, on n’insiste plus',
    !P.aTraiter(s, { maintenant: jour('2026-12-01') }).some((d) => d.cle === '812345678'));
}

/* ===================== Statistiques et persistance ===================== */
console.log('\nStatistiques et persistance');
{
  const s = P.vide();
  P.integrer(s, [fiche(), fiche({ siren: '222', nom: 'B' })], jour('2026-08-01'));
  P.marquer(s, '812345678', 'contacte', '', jour('2026-08-01'));
  P.marquer(s, '812345678', 'repondu', '', jour('2026-08-03'));
  const st = P.statistiques(s);
  check('comptage par état', st.parEtat.repondu === 1 && st.parEtat.nouveau === 1);
  check('taux de réponse calculé', st.tauxReponse === 100, String(st.tauxReponse));
  check('joignables comptés', st.joignables === 2);

  const tmp = path.join(os.tmpdir(), 'pipe-' + process.pid + '.json');
  P.enregistrer(s, tmp);
  const relu = P.charger(tmp);
  check('aller-retour disque fidèle', relu.prospects['812345678'].etat === 'repondu' &&
    relu.prospects['812345678'].historique.length === s.prospects['812345678'].historique.length);
  check('aucun fichier temporaire laissé', !fs.existsSync(tmp + '.tmp'));
  fs.unlinkSync(tmp);
  check('fichier absent → état vide', Object.keys(P.charger(tmp).prospects).length === 0);
}

/* ===================== Rédaction ===================== */
console.log('\nRédaction des messages');
{
  const p = fiche();
  const m = R.rediger(p, 'premier', '812345678');
  check('destinataire renseigné', m.destinataire === 'contact@dupont-energie.fr');
  check('objet non vide', m.objet.length > 10);
  check('le corps cite le site observé', m.corps.includes('dupont-energie.fr'), m.corps.slice(0, 90));
  check('mention de désinscription présente', /STOP/.test(m.corps));
  check('émetteur identifié', m.corps.includes(R.EMETTEUR.societe) && m.corps.includes(R.EMETTEUR.email));
  // Une prospection sans adresse postale ni téléphone identifiables est anonyme :
  // ces champs ne sont pas décoratifs, ils conditionnent la licéité du message.
  check('adresse postale présente dans le pied', R.EMETTEUR.adresse && m.corps.includes(R.EMETTEUR.adresse),
    R.EMETTEUR.adresse || '(vide)');
  check('téléphone présent dans le pied', R.EMETTEUR.telephone && m.corps.includes(R.EMETTEUR.telephone),
    R.EMETTEUR.telephone || '(vide)');
  check('aucun markdown dans un e-mail texte', (() => {
    for (const etape of Object.keys(R.MODELES)) {
      for (let i = 0; i < R.MODELES[etape].length; i++) {
        const c = R.rediger(p, etape, String(i)).corps;
        if (/\*\*|__|\[.+\]\(/.test(c)) return false;
      }
    }
    return true;
  })());

  const sansSite = R.rediger(fiche({ siteWeb: '', aSimulateur: null }), 'premier', '999');
  check('accroche de repli sur Quali’PV', sansSite.corps.includes('Quali'), sansSite.corps.slice(0, 80));
  const nu = R.rediger({ nom: 'X', emails: ['a@b.fr'] }, 'premier', '1');
  check('fiche minimale : message quand même produit', nu.corps.length > 200 && nu.objet.length > 5);

  check('variante déterministe', R.rediger(p, 'premier', '812345678').variante === m.variante);
  const variantes = new Set(['1', '2', '3', '4', '5', '6', '7', '8'].map((k) => R.rediger(p, 'premier', k).variante));
  check('les variantes tournent', variantes.size > 1, [...variantes].join(','));

  check('relance 1 disponible', R.rediger(p, 'relance1', '1').corps.length > 100);
  check('relance 2 clôt le sujet', /clos/i.test(R.rediger(p, 'relance2', '1').corps));

  const eml = R.versEml(m);
  check('en-tête .eml complet', /^From: /m.test(eml) && /^To: /m.test(eml) && /^Subject: /m.test(eml));
  check('objet accentué encodé', R.encoderEntete('Vos économies').startsWith('=?UTF-8?B?'));
  check('objet ASCII laissé tel quel', R.encoderEntete('Hello') === 'Hello');
  check('corps décodable', Buffer.from(eml.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64')
    .toString('utf8').includes('STOP'));
  check('nom de fichier sain', /^001-premier-dupont-energie\.eml$/.test(R.nomFichier(m, 1)), R.nomFichier(m, 1));

  const csv = R.versCsv([m]);
  check('CSV de publipostage', csv.split('\n')[0].startsWith('destinataire;entreprise'));
  check('CSV échappe les retours à la ligne', csv.split('\n').length >= 2 && csv.includes('"'));
}

/* ===================== Exploitation de l'inspection ===================== */
console.log('\nCe que l’inspection change dans l’accroche et la sélection');
{
  const base = { nom: 'X', emails: ['a@b.fr'], siteWeb: 'https://exemple.fr', score: 50 };

  const rudimentaire = R.accroche(Object.assign({}, base, {
    inspection: { niveau: 2, donnees: ['e-mail', 'téléphone', 'consommation ou facture'] }
  }));
  // Le champ distinctif passe devant : « nom, e-mail, téléphone » est demandé
  // par tous les formulaires du monde et ne prouve rien.
  check('simulateur rudimentaire : l’accroche cite d’abord le champ parlant',
    /réclame consommation ou facture,/.test(rudimentaire), rudimentaire);
  check('les champs banals suivent sans être perdus',
    /e-mail et téléphone/.test(rudimentaire));
  check('la liste est tronquée à trois',
    R.champsParlants(['nom', 'e-mail', 'téléphone', 'surface', 'budget']).length === 3);
  check('et garde les plus parlants',
    R.champsParlants(['nom', 'e-mail', 'téléphone', 'surface', 'budget']).join(',') === 'surface,budget,nom');
  check('et pointe ce qu’il ne montre pas', /sa propre toiture/.test(rudimentaire));

  const carto = R.accroche(Object.assign({}, base, { inspection: { niveau: 3, donnees: [] } }));
  check('simulateur cartographique : angle sur le calepinage',
    /calepinage/.test(carto), carto);

  const aucun = R.accroche(Object.assign({}, base, { inspection: { niveau: 0, donnees: [] } }));
  check('aucun simulateur : accroche d’origine conservée',
    /demander un devis/.test(aucun), aucun);

  check('sans inspection, le comportement ne change pas',
    R.accroche({ nom: 'X', aSimulateur: false, siteWeb: 'https://exemple.fr' }).includes('exemple.fr'));

  check('énumération lisible', R.listeFr(['a', 'b', 'c']) === 'a, b et c');
  check('énumération à un élément', R.listeFr(['a']) === 'a');
  check('énumération vide', R.listeFr([]) === '');

  // Un installateur mieux équipé que nous ne doit plus consommer de quota.
  const store = P.vide();
  P.integrer(store, [
    { nom: 'Cible', siren: '812345678', emails: ['a@b.fr'], score: 50 },
    { nom: 'Déjà équipé', siren: '912345678', emails: ['c@d.fr'], score: 90,
      inspection: { niveau: 4, cible: false, raison: 'déjà équipé' } }
  ]);
  const du = P.aTraiter(store, {});
  check('le prospect jugé non-cible est écarté de la sélection',
    du.length === 1 && du[0].prospect.nom === 'Cible',
    du.map((d) => d.prospect.nom).join(','));
  check('malgré un score supérieur', store.prospects['912345678'].score === 90);
  check('l’inspection est bien conservée par le pipeline',
    store.prospects['912345678'].inspection.niveau === 4);
}

/* ===================== Accord avec la page de vente ===================== */
/*
 * Le prix, la durée d'essai et le délai de mise en ligne sont annoncés à la
 * fois sur `index.html` et dans les messages. Rien ne discrédite plus vite un
 * démarchage qu'un tarif que la page dément : ces tests échouent si les deux
 * divergent, plutôt que de laisser partir la contradiction.
 */
console.log('\nAccord entre les messages et la page de vente');
{
  const vente = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const p = fiche();
  const premiers = R.MODELES.premier.map((_, i) => R.rediger(p, 'premier', String(i)).corps);

  check('le prix d’entrée figure bien sur la page de vente',
    vente.includes(R.OFFRE.prixEntree.split(' ')[0]), R.OFFRE.prixEntree);
  check('la formule haute figure bien sur la page de vente',
    vente.includes(R.OFFRE.prixPro.split(' ')[0]), R.OFFRE.prixPro);
  // Le palier gratuit est l'entrée du parcours : s'il diffère entre la page et
  // les messages, le prospect découvre la différence au moment de s'inscrire.
  check('le palier gratuit est le même des deux côtés',
    new RegExp(R.OFFRE.leadsGratuits + '\\s*leads par mois').test(vente),
    String(R.OFFRE.leadsGratuits));
  check('le prix au lead figure sur la page',
    vente.includes(R.OFFRE.prixLead + ' le lead'), R.OFFRE.prixLead);

  // Un premier message qui tait le prix ne récolte qu'une question en retour,
  // quand il récolte quelque chose.
  check('chaque premier message annonce le prix',
    premiers.every((c) => c.includes(R.OFFRE.prixEntree)),
    premiers.map((c) => c.includes(R.OFFRE.prixEntree)).join(','));
  check('chaque premier message annonce le palier gratuit',
    premiers.every((c) => /[Gg]ratuit/.test(c) && c.includes(String(R.OFFRE.leadsGratuits))));

  check('le lien de démonstration pointe vers une page réelle du dépôt',
    fs.existsSync(path.join(__dirname, '..', R.lienDemo().split('/').pop())),
    R.lienDemo());
  check('les relances citent la démonstration',
    R.MODELES.relance1.every((_, i) => R.rediger(p, 'relance1', String(i)).corps.includes(R.lienDemo())));
  check('aucun domaine mort dans les messages',
    !premiers.concat(R.rediger(p, 'relance1', '0').corps).some((c) => /rdf-solar\.fr/.test(c)));

  /* --- Ce qui distingue un message d'un publipostage ------------------- */

  const inspecte = {
    nom: 'Solaire du Vexin', siren: '812345678', emails: ['c@solaire-vexin.fr'],
    siteWeb: 'https://solaire-vexin.fr', ville: 'Magny-en-Vexin',
    inspection: {
      niveau: 2, enseigne: 'Solaire du Vexin', couleur: '#1e5aa8', couleurApercu: '#1a63b4',
      libelle: 'Estimation en ligne', donnees: ['consommation ou facture', 'nom', 'e-mail']
    }
  };
  const corpsInsp = R.MODELES.premier.map((_, i) => R.rediger(inspecte, 'premier', String(i)).corps);

  // L'aperçu à leur nom est la seule chose du message qu'un envoi en masse ne
  // peut pas produire. S'il disparaît, il ne reste qu'un argumentaire.
  check('chaque premier message porte l’aperçu préparé pour eux',
    corpsInsp.every((c) => c.includes('e=Solaire%20du%20Vexin')),
    corpsInsp.map((c) => c.includes('e=Solaire%20du%20Vexin')).join(','));
  check('l’aperçu emporte la couleur approchée',
    corpsInsp.every((c) => c.includes(encodeURIComponent('#1a63b4'))));
  // Reprendre la couleur exacte d'une marque, c'est s'exposer. L'inspection en
  // décale la teinte exprès : encore faut-il envoyer la bonne des deux.
  check('jamais la couleur exacte de la marque',
    corpsInsp.every((c) => !c.includes(encodeURIComponent('#1e5aa8'))),
    'couleurApercu, pas couleur');
  check('le message dit que l’aperçu est approché',
    corpsInsp.every((c) => /approché|approchée/.test(c) && /logo/.test(c)),
    'sans cette mention, l’aperçu se lit comme une usurpation d’identité');

  check('l’accroche cite le nom exact de leur page',
    corpsInsp.every((c) => c.includes('« Estimation en ligne »')),
    'ce détail ne s’écrit pas sans avoir ouvert le site');

  // Un message long se lit comme une brochure, et une brochure se lit comme un
  // publipostage. Le pied légal est exclu du compte : il est incompressible.
  const mots = (c) => c.split('\n--\n')[0].trim().split(/\s+/).length;
  check('les premiers messages restent courts',
    corpsInsp.every((c) => mots(c) <= 210), corpsInsp.map(mots).join(', ') + ' mots');

  // Une apostrophe droite au milieu d'apostrophes typographiques signe le
  // texte généré. C'est exactement ce qu'on cherche à ne pas donner à voir.
  const tous = [].concat(...Object.keys(R.MODELES).map((e) =>
    R.MODELES[e].map((_, i) => R.rediger(inspecte, e, String(i)).corps)));
  check('aucune apostrophe droite dans les messages',
    tous.every((c) => !/'/.test(c)),
    (tous.filter((c) => /'/.test(c))[0] || '').slice(0, 60));

  // Sans enseigne connue, pas de lien bricolé : la démo générique suffit.
  const sansNom = R.rediger({ emails: ['x@y.fr'], ville: 'Vire' }, 'premier', '0').corps;
  check('sans enseigne, le lien reste celui de la démo',
    sansNom.includes(R.lienDemo()) && !sansNom.includes('?e='));
  check('et l’accroche ne prétend pas avoir visité leur site',
    !/J’ai regardé|J’ai parcouru/.test(sansNom),
    'affirmer une visite qui n’a pas eu lieu se retourne au premier appel');

  /* --- La page qui reçoit le clic ------------------------------------- */
  /*
   * Un lien personnalisé qui atterrit sur une page générique est pire que pas
   * de lien : le destinataire constate le bluff. On vérifie donc que demo.html
   * sait lire les deux paramètres que la rédaction lui envoie.
   */
  const demo = fs.readFileSync(path.join(__dirname, '..', 'demo.html'), 'utf8');
  check('la démo lit l’enseigne et la couleur de l’URL',
    /params\.get\('e'\)/.test(demo) && /params\.get\('c'\)/.test(demo));
  check('la couleur est validée avant d’être posée',
    /\^#\[0-9a-fA-F\]\{6\}\$/.test(demo),
    'un paramètre d’URL finit dans une propriété CSS : il vient de n’importe où');
  check('l’enseigne est filtrée avant d’entrer dans le document',
    /replace\(\/\[\^\\p\{L\}/.test(demo));
  check('le logo du prospect n’est jamais repris',
    /brand\.logo = ''/.test(demo),
    'afficher le logo d’une entreprise sans son accord, c’est ce qui expose');
  check('la page dit elle-même que l’aperçu est approché',
    /Aperçu approché, pas votre charte/.test(demo));
}

/* ===================== Le brief donné aux agents ===================== */
/*
 * `agents/PROMPT-AGENT.md` se copie-colle tel quel à un agent IA. Une commande
 * qui n'existe plus, une variable d'environnement renommée ou un tarif périmé
 * s'y verrait donc obéir aveuglément. Un document faux est pire qu'absent.
 */
console.log('\nLe brief des agents ne ment pas');
{
  const brief = fs.readFileSync(path.join(__dirname, '..', 'agents', 'PROMPT-AGENT.md'), 'utf8');
  const { COMMANDES } = require('../agents/hermes.js');
  const citees = [...new Set([...brief.matchAll(/hermes\.js (\w+)/g)].map((m) => m[1]))]
    .filter((c) => c !== 'help');

  check('des commandes sont citées', citees.length >= 5, citees.join(' '));
  check('toutes existent réellement',
    citees.every((c) => COMMANDES[c]), citees.filter((c) => !COMMANDES[c]).join(' ') || 'aucune manquante');

  ['RDF_SAAS_URL', 'RDF_SAAS_JETON', 'RDF_SMTP_UTILISATEUR', 'RDF_SMTP_MOTDEPASSE'].forEach((v) => {
    check('la variable ' + v + ' est documentée', brief.includes(v));
  });

  check('le prix annoncé est celui du code', brief.includes(R.OFFRE.prixEntree), R.OFFRE.prixEntree);
  check('le palier gratuit aussi',
    new RegExp(R.OFFRE.leadsGratuits + ' leads par mois').test(brief));

  // Les garde-fous sont la raison d'être du document : s'ils disparaissent du
  // texte, un agent ne saura pas qu'ils existent.
  ['registre d’opposition', '--envoyer', 'robots.txt', 'plafond 25'].forEach((g) => {
    check('le garde-fou « ' + g + ' » est rappelé', brief.includes(g));
  });
  check('la confusion prospect/lead est traitée d’emblée',
    brief.indexOf('prospect') < brief.indexOf('La journée type') &&
    /jamais à nous/.test(brief));
  check('aucun secret en clair', !/hrm_[A-Za-z0-9]{8}/.test(brief) && /⟨JETON⟩/.test(brief));
}

/* ===================== Publication ===================== */
console.log('\nCalendrier de publication');
{
  const posts = PUB.calendrier({ semaines: 4, debut: jour('2026-09-01') });
  check('génère des publications', posts.length >= 6, String(posts.length));
  check('dates croissantes', posts.every((p, i) => i === 0 || p.date >= posts[i - 1].date));
  check('aucune accroche répétée', new Set(posts.map((p) => p.accroche)).size === posts.length);
  check('deux angles consécutifs différents',
    posts.every((p, i) => i === 0 || p.angle !== posts[i - 1].angle),
    posts.map((p) => p.angle).join(' '));
  check('mots-dièse sans accent ni espace', posts.every((p) => /#[A-Za-z0-9]+/.test(p.texte) && !/#\S*[éàïô]/.test(p.texte)));
  // Le lien par défaut est celui de la page de vente réellement en ligne, pris
  // au bloc émetteur : deux constantes séparées divergent toujours, et une
  // publication qui pointe dans le vide est pire que pas de publication.
  check('lien présent', posts.every((p) => p.texte.includes(R.EMETTEUR.site)), R.EMETTEUR.site);
  check('lien personnalisable',
    PUB.calendrier({ semaines: 1, debut: jour('2026-09-01'), lien: 'https://exemple.fr/demo' })
      .every((p) => p.texte.includes('exemple.fr/demo')));
  check('longueur compatible LinkedIn', posts.every((p) => p.caracteres < 3000));
  check('s’arrête plutôt que de répéter', PUB.calendrier({ semaines: 52, debut: jour('2026-09-01') }).length <= 10);
  check('Markdown lisible', PUB.versMarkdown(posts).startsWith('# Calendrier'));
}

console.log('\n' + passed + ' tests réussis, ' + failed + ' échec(s)');
process.exit(failed ? 1 : 0);
