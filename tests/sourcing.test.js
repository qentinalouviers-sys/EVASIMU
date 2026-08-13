/**
 * Tests de l'agent de sourcing Hermès — exécution : node tests/sourcing.test.js
 *
 * Les fonctions d'extraction sont testées à sec ; la chaîne d'enrichissement est
 * testée contre un faux site servi en local, ce qui valide le crawler pour de
 * vrai (robots.txt, pages de contact, détection de simulateur) sans dépendre
 * d'Internet ni solliciter le site de qui que ce soit.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../agents/sourcing.js');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const memesElements = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/* ===================== Extraction des e-mails ===================== */
console.log('Extraction des e-mails');
{
  const html = `
    Écrivez à <a href="mailto:Contact@Dupont-Energie.fr">Contact@Dupont-Energie.fr</a>
    ou à commercial@dupont-energie.fr. Partenaire : info@autre-boite.com.
    <img src="logo@2x.png"> <script src="a1b2c3d4e5f60718@sentry.io"></script>
    Gabarit : votre-nom@votredomaine.fr
  `;
  const mails = S.extraireEmails(html, 'dupont-energie.fr');
  check('trouve les adresses réelles', mails.includes('contact@dupont-energie.fr') && mails.includes('info@autre-boite.com'));
  check('normalise en minuscules', !mails.some((m) => /[A-Z]/.test(m)));
  check('écarte les noms de fichiers (logo@2x.png)', !mails.some((m) => m.includes('.png')));
  check('écarte le bruit technique (sentry.io)', !mails.some((m) => m.includes('sentry')));
  check('écarte les adresses de gabarit', !mails.some((m) => m.includes('votredomaine')));
  check('classe le domaine de l’entreprise en premier', mails[0].endsWith('@dupont-energie.fr'), mails[0]);
  check('déduplique', new Set(mails).size === mails.length);
  check('chaîne vide ne casse pas', S.extraireEmails('').length === 0 && S.extraireEmails(null).length === 0);
}

/* ===================== Extraction des téléphones ===================== */
console.log('\nExtraction des téléphones');
{
  const t = S.extraireTelephones('Tél. 04 78 12 34 56 — mobile +33 6 12 34 56 78 — fax 04.78.12.34.57');
  check('formats espacés, +33 et pointés', memesElements(t, ['0478123456', '0612345678', '0478123457']), t.join(' '));
  check('gère +33 (0) espacé', S.extraireTelephones('+33 (0)4 78 12 34 56')[0] === '0478123456',
    JSON.stringify(S.extraireTelephones('+33 (0)4 78 12 34 56')));
  check('gère +33(0) collé', S.extraireTelephones('+33(0)478123456')[0] === '0478123456',
    JSON.stringify(S.extraireTelephones('+33(0)478123456')));
  check('gère 0033', S.extraireTelephones('0033 4 78 12 34 56')[0] === '0478123456');
  check('gère le collé', S.extraireTelephones('0478123456')[0] === '0478123456');

  // Le piège principal : ne pas confondre un identifiant avec un numéro
  check('ignore un SIRET (14 chiffres)', S.extraireTelephones('SIRET 81234567800019').length === 0,
    JSON.stringify(S.extraireTelephones('SIRET 81234567800019')));
  check('ignore un SIREN (9 chiffres)', S.extraireTelephones('SIREN 812345678').length === 0);
  check('ignore un numéro trop long', S.extraireTelephones('047812345678').length === 0);
  check('ignore 00 en tête de ligne', S.extraireTelephones('00 00 00 00 00').length === 0);
  check('déduplique les répétitions', S.extraireTelephones('04 78 12 34 56 et 0478123456').length === 1);
}

/* ===================== Devinette de domaine ===================== */
console.log('\nDevinette de nom de domaine');
{
  const d = S.deviserDomaines('SARL DUPONT ENERGIE');
  check('retire la forme juridique', d.includes('dupontenergie.fr') && !d.some((x) => x.includes('sarl')), d.join(' '));
  check('propose la variante à tiret', d.includes('dupont-energie.fr'));
  check('propose .fr et .com', d.includes('dupontenergie.com'));
  check('retire les accents', S.deviserDomaines('Léonçöt Énergie').includes('leoncotenergie.fr'));
  check('retire les mots vides', !S.deviserDomaines('Etablissements de la Toiture').some((x) => x.startsWith('etablissementsdela')));
  check('nom vide → aucun candidat', S.deviserDomaines('').length === 0 && S.deviserDomaines(null).length === 0);
}

/* ===================== Détection de simulateur ===================== */
console.log('\nDétection d’un simulateur concurrent');
{
  check('repère « simulez votre projet »', S.detecterSimulateur('Simulez votre projet en 2 min').aSimulateur);
  check('repère un outil tiers', S.detecterSimulateur('Propulsé par Otovo').indices.length === 1);
  check('site sans simulateur', !S.detecterSimulateur('Devis gratuit, appelez-nous').aSimulateur);
  check('« photovoltaïque » n’est pas pris pour « Otovo »',
    !S.detecterSimulateur('Votre installateur photovoltaïque en Rhône-Alpes').aSimulateur,
    JSON.stringify(S.detecterSimulateur('installateur photovoltaïque').indices));
  check('la marque Otovo isolée est bien vue', S.detecterSimulateur('Comparez avec Otovo').aSimulateur);
}

/* ===================== Normalisation de l'annuaire ===================== */
console.log('\nNormalisation des fiches entreprise');
{
  const f = S.normaliserEntreprise({
    siren: '812345678', nom_complet: 'DUPONT ENERGIE',
    activite_principale: '43.22B', tranche_effectif_salarie: '12',
    etat_administratif: 'A',
    siege: { siret: '81234567800019', adresse: '12 RUE X 69001 LYON', code_postal: '69001', libelle_commune: 'LYON' }
  });
  check('champs essentiels', f.nom === 'DUPONT ENERGIE' && f.siret === '81234567800019' && f.ville === 'LYON');
  check('effectif traduit', f.effectif === '20 à 49 salariés' && f.effectifMin === 20);
  check('département déduit du code postal', f.departement === '69');
  check('entreprise active', f.active === true);
  check('entreprise fermée détectée', S.normaliserEntreprise({ nom_complet: 'X', etat_administratif: 'C', siege: {} }).active === false);
  check('champs absents tolérés', S.normaliserEntreprise({ nom_complet: 'Y' }).ville === '');
  check('objet vide → null', S.normaliserEntreprise({}) === null && S.normaliserEntreprise(null) === null);
}

/* ===================== Notation ===================== */
console.log('\nNotation des prospects');
{
  const base = { emails: [], telephones: [], siteWeb: '', active: true, effectifMin: 10, aSimulateur: null, rge: false };
  const ideal = Object.assign({}, base, {
    siteWeb: 'https://www.dupont-energie.fr', emails: ['contact@dupont-energie.fr'],
    telephones: ['0478123456'], aSimulateur: false, rge: true, effectifMin: 10
  });
  const equipe = Object.assign({}, ideal, { aSimulateur: true });
  check('prospect idéal bien noté', S.scorer(ideal) >= 90, String(S.scorer(ideal)));
  check('déjà équipé → note plus basse', S.scorer(equipe) < S.scorer(ideal));
  check('injoignable → note faible', S.scorer(base) < 20, String(S.scorer(base)));
  check('fermée → pénalisée', S.scorer(Object.assign({}, ideal, { active: false })) < S.scorer(ideal));
  check('note bornée à 100', S.scorer(ideal) <= 100);
  check('note jamais négative', S.scorer(Object.assign({}, base, { active: false })) >= 0);
  check('adresse hors domaine vaut moins qu’une adresse maison',
    S.scorer(Object.assign({}, ideal, { emails: ['x@gmail.com'] })) < S.scorer(ideal));
}

/* ===================== Déduplication et CSV ===================== */
console.log('\nDéduplication et export');
{
  const l = S.dedupe([
    { siren: '1', nom: 'A' }, { siren: '1', nom: 'A bis' }, { siren: '2', nom: 'B' },
    { siren: '', siret: '', nom: 'C' }, { siren: '', siret: '', nom: 'c' }
  ]);
  check('déduplique par SIREN', l.length === 3, JSON.stringify(l.map((x) => x.nom)));

  const csv = S.versCsv([{
    score: 90, nom: 'Toitures; Sud "Est"', siret: '1', ville: 'Lyon', codePostal: '69001',
    departement: '69', effectif: '10 à 19 salariés', siteWeb: 'https://x.fr',
    emails: ['a@x.fr', 'b@x.fr'], telephones: ['0478123456'], aSimulateur: false,
    rge: true, ape: '43.22B', apeLibelle: 'Travaux', indices: ['qualifiée RGE']
  }]);
  const lignes = csv.split('\n');
  check('en-tête présent', lignes[0].startsWith('score;nom;siret'));
  check('échappe les points-virgules et guillemets', lignes[1].includes('"Toitures; Sud ""Est"""'), lignes[1].slice(0, 60));
  check('adresse principale isolée de la secondaire', lignes[1].includes(';a@x.fr;b@x.fr;'));
  check('booléens lisibles', lignes[1].includes(';non;oui;'), lignes[1]);
}

/* ===================== Lecture de l'annuaire RGE ===================== */
console.log('\nLecture de l’annuaire RGE (schéma inconnu)');
{
  const tmp = path.join(os.tmpdir(), 'rge-test-' + process.pid + '.csv');
  fs.writeFileSync(tmp,
    'nom_entreprise;siret;adresse;email_contact;telephone\n' +
    'DUPONT ENERGIE;81234567800019;Lyon;contact@dupont-energie.fr;04 78 12 34 56\n' +
    'SANS SIRET;;Paris;x@y.fr;01 02 03 04 05\n');
  const idx = S.chargerRge(tmp);
  check('indexe par SIREN', idx.has('812345678'), [...idx.keys()].join(','));
  check('récupère e-mail et téléphone', idx.get('812345678').emails[0] === 'contact@dupont-energie.fr' &&
    idx.get('812345678').telephones[0] === '0478123456');
  check('ignore les lignes sans identifiant', idx.size === 1);
  fs.unlinkSync(tmp);

  check('CSV à virgules aussi accepté', (() => {
    const t2 = path.join(os.tmpdir(), 'rge2-' + process.pid + '.csv');
    fs.writeFileSync(t2, 'nom,siret,mail\nX,81234567800019,a@b.fr\n');
    const r = S.chargerRge(t2).has('812345678');
    fs.unlinkSync(t2);
    return r;
  })());

  check('guillemets CSV respectés', S.decouperCsv('a;"b;c";d', ';').length === 3);
}

/* ===================== Enrichissement contre un vrai serveur ===================== */
console.log('\nEnrichissement de bout en bout (faux site local)');

const PAGES = {
  '/robots.txt': 'User-agent: *\nDisallow: /admin\n',
  '/': `<html><body><h1>Dupont Énergie</h1>
        <p>Installateur photovoltaïque. Devis gratuit.</p>
        <a href="/contact">Contact</a></body></html>`,
  '/contact': `<html><body>
        <p>Téléphone : 04 78 12 34 56</p>
        <p>E-mail : contact@dupont-energie.fr</p>
        <p>SIRET 81234567800019</p></body></html>`
};

const PAGES_BLOQUEES = {
  '/robots.txt': 'User-agent: *\nDisallow: /\n',
  '/': '<html><body>contact@interdit.fr — 04 78 00 00 00</body></html>'
};

function servir(pages) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chemin = req.url.split('?')[0];
      if (pages[chemin] === undefined) { res.writeHead(404); return res.end('non'); }
      res.writeHead(200, { 'Content-Type': chemin.endsWith('.txt') ? 'text/plain' : 'text/html' });
      res.end(pages[chemin]);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

(async () => {
  // On accélère : les délais de politesse n'ont pas de sens contre localhost
  S.CONFIG.delaiEntreRequetesMs = 0;

  {
    const { srv, port } = await servir(PAGES);
    const f = S.normaliserEntreprise({ nom_complet: 'Dupont Energie', siege: {} });
    f.siteWeb = '127.0.0.1:' + port;
    await S.enrichir(f);
    check('lit le téléphone sur la page contact', f.telephones.includes('0478123456'), f.telephones.join(' '));
    check('lit l’e-mail sur la page contact', f.emails.includes('contact@dupont-energie.fr'), f.emails.join(' '));
    check('n’extrait aucun numéro parasite du SIRET', f.telephones.length === 1, f.telephones.join(' '));
    check('détecte l’absence de simulateur', f.aSimulateur === false);
    check('trace la page consultée', f.indices.some((i) => i.includes('/contact')), f.indices.join(' | '));
    srv.close();
  }

  {
    const { srv, port } = await servir(PAGES_BLOQUEES);
    const f = S.normaliserEntreprise({ nom_complet: 'Interdit', siege: {} });
    f.siteWeb = '127.0.0.1:' + port;
    await S.enrichir(f);
    check('robots.txt « Disallow: / » est respecté', f.emails.length === 0 && f.telephones.length === 0,
      f.emails.join(' ') + f.telephones.join(' '));
    check('le refus est tracé', f.indices.some((i) => i.includes('robots.txt')));
    srv.close();
  }

  {
    const f = S.normaliserEntreprise({ nom_complet: 'Injoignable SARL', siege: {} });
    f.siteWeb = '127.0.0.1:1';   // port fermé
    await S.enrichir(f);
    check('site injoignable ne fait pas échouer l’agent', f.emails.length === 0 && f.aSimulateur === null);
  }

  console.log('\n' + passed + ' tests réussis, ' + failed + ' échec(s)');
  process.exit(failed ? 1 : 0);
})();
