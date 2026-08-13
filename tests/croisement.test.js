/**
 * Tests du croisement de sources — exécution : node tests/croisement.test.js
 *
 * Le cœur du sujet est la réconciliation : une même entreprise vue par
 * l'annuaire officiel, par l'annuaire RGE et par son propre site doit produire
 * UNE fiche, avec le meilleur de chaque source et la trace de sa provenance.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../agents/croisement.js');
const RGE = require('../agents/rge.js');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

/* ===================== Normalisation et similarité ===================== */
console.log('Rapprochement des raisons sociales');
{
  check('retire la forme juridique', C.normaliserNom('SARL Dupont Énergie') === 'dupont energie',
    C.normaliserNom('SARL Dupont Énergie'));
  check('retire accents et ponctuation', C.normaliserNom('Léonçöt & Fils, S.A.S.') === 'leoncot fils',
    C.normaliserNom('Léonçöt & Fils, S.A.S.'));
  check('même entreprise malgré la forme juridique', C.similariteNoms('SARL DUPONT ENERGIE', 'Dupont Énergie') === 1);
  check('entreprises différentes', C.similariteNoms('Dupont Énergie', 'Martin Toiture') === 0);
  check('proximité partielle sous le seuil',
    C.similariteNoms('Dupont Energie Solaire', 'Martin Energie Solaire') < C.SEUIL_NOM,
    String(C.similariteNoms('Dupont Energie Solaire', 'Martin Energie Solaire')));
  check('nom vide ne casse pas', C.similariteNoms('', 'X') === 0 && C.normaliserNom(null) === '');
}

/* ===================== Appariement ===================== */
console.log('\nAppariement des fiches');
{
  const g = C.apparier([
    { source: 'entreprises', siren: '812345678', nom: 'DUPONT ENERGIE', codePostal: '69001' },
    { source: 'rge', siren: '812345678', nom: 'Dupont Énergie', codePostal: '69001' },
    { source: 'entreprises', siren: '999999999', nom: 'MARTIN TOITURE', codePostal: '69002' }
  ]);
  check('regroupe par SIREN identique', g.length === 2 && g[0].length === 2, 'groupes=' + g.length);

  const gSiret = C.apparier([
    { source: 'entreprises', siren: '', siret: '81234567800019', nom: 'A', codePostal: '69001' },
    { source: 'rge', siren: '812345678', nom: 'A', codePostal: '69001' }
  ]);
  check('SIRET et SIREN désignent la même entreprise', gSiret.length === 1, 'groupes=' + gSiret.length);

  const gFlou = C.apparier([
    { source: 'entreprises', siren: '', nom: 'SARL DUPONT ENERGIE', codePostal: '69001' },
    { source: 'rge', siren: '', nom: 'Dupont Énergie', codePostal: '69001' }
  ]);
  check('sans identifiant : rapproche par nom + code postal', gFlou.length === 1, 'groupes=' + gFlou.length);

  const gCp = C.apparier([
    { source: 'entreprises', siren: '', nom: 'Dupont Énergie', codePostal: '69001' },
    { source: 'rge', siren: '', nom: 'Dupont Énergie', codePostal: '13001' }
  ]);
  check('même nom mais code postal différent : ne fusionne pas', gCp.length === 2, 'groupes=' + gCp.length);

  const gAutre = C.apparier([
    { source: 'entreprises', siren: '', nom: 'Dupont Énergie', codePostal: '69001' },
    { source: 'rge', siren: '', nom: 'Martin Toiture', codePostal: '69001' }
  ]);
  check('noms trop éloignés : ne fusionne pas', gAutre.length === 2);
}

/* ===================== Fusion ===================== */
console.log('\nFusion et provenance');
{
  const f = C.fusionner([
    {
      source: 'entreprises', siren: '812345678', siret: '81234567800019',
      nom: 'DUPONT ENERGIE', codePostal: '69001', ville: 'LYON', adresse: '12 rue X',
      ape: '43.22B', apeLibelle: 'Travaux', effectif: '20 à 49 salariés', effectifMin: 20,
      active: true, siteWeb: '', emails: [], telephones: []
    },
    {
      source: 'rge', siren: '812345678', nom: 'Dupont Énergie SARL',
      emails: ['contact@dupont-energie.fr'], telephones: ['0478000000'],
      rge: true, qualifications: [{ nom: "Quali'PV 36", domaine: 'Photovoltaïque', photovoltaique: true }]
    },
    {
      source: 'site', nom: 'Dupont Énergie', siteWeb: 'https://www.dupont-energie.fr',
      emails: ['commercial@dupont-energie.fr'], telephones: ['0478123456'],
      aSimulateur: false, indices: ['coordonnées lues sur /contact']
    }
  ]);

  check('identité prise à l’annuaire officiel', f.nom === 'DUPONT ENERGIE' && f.ape === '43.22B');
  check('provenance de l’identité tracée', f.provenance.nom === 'entreprises', f.provenance.nom);
  check('site web pris au site', f.provenance.siteWeb === 'site', f.provenance.siteWeb);
  check('contacts cumulés, jamais choisis', f.emails.length === 2 && f.telephones.length === 2,
    JSON.stringify(f.emails) + JSON.stringify(f.telephones));
  check('e-mail du domaine de l’entreprise en tête', f.emails[0].endsWith('@dupont-energie.fr'));
  check('qualification RGE reprise', f.qualifPV === true && f.rge === true);
  check('détection de simulateur reprise', f.aSimulateur === false);
  check('trois sources listées', f.sources.length === 3, f.sources.join('+'));
  check('département déduit', f.departement === '69');
  check('SIREN conservé', f.siren === '812345678');
}

/* ===================== Notation croisée ===================== */
console.log('\nNotation après croisement');
{
  const base = {
    emails: [], telephones: [], siteWeb: '', active: true, effectifMin: 10,
    aSimulateur: null, rge: false, qualifPV: false, sources: ['entreprises'], qualifications: []
  };
  const ideal = Object.assign({}, base, {
    siteWeb: 'https://www.x.fr', emails: ['contact@x.fr'], telephones: ['0478123456'],
    aSimulateur: false, rge: true, qualifPV: true, sources: ['entreprises', 'rge', 'site']
  });
  check('prospect recoupé et Quali’PV très bien noté', C.scorerCroise(ideal) >= 90, String(C.scorerCroise(ideal)));
  check('Quali’PV vaut plus que RGE seul',
    C.scorerCroise(ideal) > C.scorerCroise(Object.assign({}, ideal, { qualifPV: false })));
  check('trois sources valent plus qu’une',
    C.scorerCroise(ideal) > C.scorerCroise(Object.assign({}, ideal, { sources: ['entreprises'] })));
  check('déjà équipé pénalisé',
    C.scorerCroise(Object.assign({}, ideal, { aSimulateur: true })) < C.scorerCroise(ideal));
  check('fiche vide mal notée', C.scorerCroise(base) < 20, String(C.scorerCroise(base)));
  check('note bornée', C.scorerCroise(ideal) <= 100 && C.scorerCroise(Object.assign({}, base, { active: false })) >= 0);
}

/* ===================== Source RGE ===================== */
console.log('\nLecture de l’annuaire RGE');
{
  check('reconnaît les intitulés accentués', (() => {
    const i = RGE.indexerChamps(['Nom entreprise', 'SIRET', 'Code postal', 'Téléphone', 'E-mail', 'Nom qualification']);
    return i.nom === 'Nom entreprise' && i.telephone === 'Téléphone' && i.email === 'E-mail';
  })());
  check('reconnaît les intitulés en serpent', (() => {
    const i = RGE.indexerChamps(['raison_sociale', 'siret', 'code_postal', 'tel', 'courriel']);
    return i.nom === 'raison_sociale' && i.telephone === 'tel' && i.email === 'courriel';
  })());

  check('détecte Quali’PV', RGE.estPhotovoltaique("Quali'PV 36") && RGE.estPhotovoltaique('QualiPV'));
  check('détecte le domaine photovoltaïque', RGE.estPhotovoltaique('Solaire photovoltaïque'));
  check('ne confond pas avec QualiPAC', !RGE.estPhotovoltaique('QualiPAC — pompes à chaleur'));

  const ligne = RGE.normaliserLigneRge({
    'Nom entreprise': 'DUPONT ENERGIE', SIRET: '81234567800019', 'Code postal': '69001 LYON',
    Commune: 'LYON', 'Téléphone': '04 78 12 34 56', 'E-mail': 'contact@dupont-energie.fr',
    'Nom qualification': "Quali'PV 36", Domaine: 'Photovoltaïque'
  });
  check('SIREN déduit du SIRET', ligne.siren === '812345678');
  check('code postal isolé du texte', ligne.codePostal === '69001', ligne.codePostal);
  check('contacts extraits', ligne.emails[0] === 'contact@dupont-energie.fr' && ligne.telephones[0] === '0478123456');
  check('qualification photovoltaïque marquée', ligne.qualifications[0].photovoltaique === true);
  check('ligne sans identifiant ni nom ignorée', RGE.normaliserLigneRge({}) === null);

  // Une entreprise apparaît une fois par qualification : le regroupement est vital
  const groupe = RGE.regrouper([
    { siren: '1', nom: 'A', codePostal: '69001', emails: ['a@x.fr'], telephones: [], siteWeb: '', qualifications: [{ nom: 'QualiPV', domaine: 'PV', photovoltaique: true }] },
    { siren: '1', nom: 'A', codePostal: '69001', emails: ['b@x.fr'], telephones: ['0478123456'], siteWeb: '', qualifications: [{ nom: 'QualiPAC', domaine: 'PAC', photovoltaique: false }] }
  ]);
  check('regroupe les qualifications multiples', groupe.length === 1 && groupe[0].qualifications.length === 2);
  check('cumule les contacts au regroupement', groupe[0].emails.length === 2 && groupe[0].telephones.length === 1);

  const tmp = path.join(os.tmpdir(), 'rge-croise-' + process.pid + '.csv');
  fs.writeFileSync(tmp,
    'nom_entreprise;siret;code_postal;telephone;email;nom_qualification;domaine\n' +
    "DUPONT ENERGIE;81234567800019;69001;04 78 12 34 56;contact@dupont-energie.fr;Quali'PV;Photovoltaïque\n" +
    "DUPONT ENERGIE;81234567800019;69001;04 78 12 34 56;contact@dupont-energie.fr;QualiPAC;Pompes à chaleur\n");
  RGE.depuisCsv(tmp).then((l) => {
    check('CSV : une entreprise, deux qualifications', l.length === 1 && l[0].qualifications.length === 2,
      'lignes=' + l.length);
    check('CSV : Quali’PV repéré', l[0].qualifications.some((q) => q.photovoltaique));
    fs.unlinkSync(tmp);
    suite();
  }).catch((e) => { check('CSV lisible', false, e.message); fs.unlinkSync(tmp); suite(); });
}

/* ===================== Exports ===================== */
function suite() {
  console.log('\nExports');
  const fiches = [C.fusionner([
    {
      source: 'entreprises', siren: '812345678', siret: '81234567800019',
      nom: 'Toitures; Sud "Est"', codePostal: '69001', ville: 'LYON',
      ape: '43.22B', effectif: '10 à 19 salariés', effectifMin: 10, active: true, emails: [], telephones: []
    },
    {
      source: 'rge', siren: '812345678', nom: 'Toitures Sud Est', rge: true,
      emails: ['contact@tse.fr'], telephones: ['0478123456'],
      qualifications: [{ nom: "Quali'PV", domaine: 'PV', photovoltaique: true }]
    }
  ])];
  fiches[0].score = C.scorerCroise(fiches[0]);

  const csv = C.versCsv(fiches);
  check('en-tête CSV complet', csv.split('\n')[0].startsWith('score;nom;siren;siret'));
  check('échappe les séparateurs et guillemets', csv.includes('"Toitures; Sud ""Est"""'), csv.split('\n')[1].slice(0, 50));
  check('qualifications lisibles dans le CSV', csv.includes("Quali'PV"));

  const html = C.versTableauDeBord(fiches, 'Test');
  check('tableau de bord autonome', html.startsWith('<!DOCTYPE html>') && html.includes('</html>'));
  check('données inlinées', html.includes('812345678'));
  check('aucune ressource externe', !/src="http|href="http(?!s:\/\/www\.ign)/.test(html.replace(/<a [^>]*target="_blank"[^>]*>/g, '')));
  check('les chevrons des données sont neutralisés', !html.includes('const FICHES = [{"nom":"<'));

  console.log('\n' + passed + ' tests réussis, ' + failed + ' échec(s)');
  process.exit(failed ? 1 : 0);
}
