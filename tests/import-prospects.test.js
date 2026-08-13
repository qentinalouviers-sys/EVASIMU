/**
 * Tests de l'import intelligent — node tests/import-prospects.test.js
 *
 * Chaque cas part d'une entrée qui produisait une erreur avant : export
 * d'Hermès, CSV Excel, copier-coller de tableur, liste d'adresses, JSON
 * approximatif. La règle de conception est simple : une entrée plausible ne
 * doit jamais renvoyer un message incompréhensible, et jamais faire échouer
 * les lignes correctes à cause d'une ligne fautive.
 */
'use strict';

const I = require('../saas/lib/import-prospects.js');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const p1 = (e) => I.analyser(e).lignes[0].prospect;

/* ===================== Le cas qui échouait ===================== */
console.log('Export Hermès — le cas qui faisait tout échouer');
{
  const hermes = [{
    nom: 'SOLAIRE DU VEXIN', siren: '812345678', siret: '81234567800019',
    codePostal: '27200', ville: 'Vernon',
    emails: ['contact@solaire-vexin.fr', 'devis@solaire-vexin.fr'],
    telephones: ['0232210000', '0612345678'],
    siteWeb: 'https://www.solaire-vexin.fr', qualifPV: true, score: 92,
    effectif: '10 à 19 salariés', sources: ['entreprises', 'rge'],
    qualifications: [{ nom: "Quali'PV 36", domaine: 'Photovoltaïque' }]
  }];
  const r = I.analyser(hermes);
  const p = r.lignes[0].prospect;
  check('la fiche n’est plus rejetée', r.resume.valides === 1 && r.resume.rejetes === 0);
  check('nom → entreprise', p.entreprise === 'SOLAIRE DU VEXIN', p.entreprise);
  check('emails[] → email (le premier)', p.email === 'contact@solaire-vexin.fr', p.email);
  check('telephones[] → telephone formaté', p.telephone === '02 32 21 00 00', p.telephone);
  check('siteWeb → site nettoyé', p.site === 'solaire-vexin.fr', p.site);
  check('codePostal → departement', p.departement === '27', p.departement);
  check('SIRET préféré au SIREN quand les deux sont fournis', p.siret === '81234567800019', p.siret);
  check('SIREN seul accepté en repli', p1([{ nom: 'A', siren: '812345678' }]).siret === '812345678');
  check('score repris', p.score === 92, String(p.score));
  check('contacts secondaires gardés en notes',
    p.notes.includes('devis@solaire-vexin.fr') && p.notes.includes('0612345678'), p.notes);
  check('effectif conservé', p.notes.includes('10 à 19 salariés'));
}

/* ===================== Formats ===================== */
console.log('\nDétection du format');
{
  check('tableau JSON', I.detecterFormat('[{"a":1}]') === 'json');
  check('objet JSON', I.detecterFormat('{"a":1}') === 'json');
  check('JSON par ligne', I.detecterFormat('{"a":1}\n{"a":2}') === 'ndjson');
  check('CSV point-virgule', I.detecterFormat('nom;email\nX;a@b.fr') === 'csv');
  check('CSV virgule', I.detecterFormat('nom,email\nX,a@b.fr') === 'csv');
  check('copier-coller tableur (tabulations)', I.detecterFormat('nom\temail\nX\ta@b.fr') === 'tsv');
  check('liste d’adresses', I.detecterFormat('a@b.fr\nc@d.fr') === 'liste');
  check('vide', I.detecterFormat('   ') === 'vide');
}

console.log('\nLecture des différents formats');
{
  const csv = I.analyser('Raison sociale;E-mail;Téléphone;Ville\nToitures Sud;contact@toitures-sud.fr;+33 4 78 12 34 56;Lyon');
  check('CSV : intitulés accentués reconnus', csv.lignes[0].prospect.entreprise === 'Toitures Sud');
  check('CSV : téléphone international normalisé', csv.lignes[0].prospect.telephone === '04 78 12 34 56',
    csv.lignes[0].prospect.telephone);

  const tsv = I.analyser('nom\tmail\nA\ta@b.fr');
  check('tableur : lu comme du CSV', tsv.lignes[0].prospect.entreprise === 'A');

  const nd = I.analyser('{"nom":"A","mail":"a@b.fr"}\n{"nom":"B","mail":"b@c.fr"}');
  check('JSON par ligne : deux fiches', nd.resume.valides === 2, JSON.stringify(nd.resume));

  const liste = I.analyser('contact@abc-solaire.fr\nwww.energies-nouvelles.com\nToitures Martin');
  check('liste : adresse, domaine et nom distingués',
    liste.lignes[0].prospect.email === 'contact@abc-solaire.fr' &&
    liste.lignes[1].prospect.site === 'energies-nouvelles.com' &&
    liste.lignes[2].prospect.entreprise === 'Toitures Martin',
    JSON.stringify(liste.lignes.map((l) => l.prospect.entreprise)));

  const sansEntete = I.analyser('Toitures Sud;contact@ts.fr;0478123456\nSolaire Est;info@se.fr;0478123457');
  check('CSV sans intitulés : colonnes positionnelles', sansEntete.resume.valides === 2 &&
    sansEntete.lignes[0].prospect.entreprise === 'Toitures Sud',
    JSON.stringify(sansEntete.resume));
}

/* ===================== Tolérance du JSON ===================== */
console.log('\nJSON approximatif');
{
  check('virgule finale tolérée', I.analyser('[{"entreprise":"A","email":"a@b.fr"},]').resume.valides === 1);
  check('BOM en tête toléré', I.analyser('﻿[{"entreprise":"A"}]').resume.valides === 1);
  check('objet unique accepté', I.analyser('{"nom":"Solo"}').resume.valides === 1);
  check('enveloppe {prospects:[…]} acceptée', I.analyser('{"prospects":[{"nom":"A"},{"nom":"B"}]}').resume.total === 2);
  const casse = I.analyser('{ceci n’est pas du json');
  check('JSON vraiment invalide → message clair, pas de pile', !!casse.erreurGlobale && !casse.lignes.length,
    casse.erreurGlobale);
}

/* ===================== Synonymes ===================== */
console.log('\nReconnaissance des noms de colonnes');
{
  check('« Raison sociale »', I.champCanonique('Raison sociale') === 'entreprise');
  check('« RAISON_SOCIALE »', I.champCanonique('RAISON_SOCIALE') === 'entreprise');
  check('« Nom de l’entreprise »', I.champCanonique('Nom de l’entreprise') === 'entreprise');
  check('« Courriel »', I.champCanonique('Courriel') === 'email');
  check('« Tél. »', I.champCanonique('Tél.') === 'telephone');
  check('« Site internet »', I.champCanonique('Site internet') === 'site');
  check('« Code postal »', I.champCanonique('Code postal') === 'codePostal');
  check('colonne inconnue → null', I.champCanonique('Couleur préférée') === null);
  check('une colonne inconnue part en notes',
    p1([{ nom: 'A', 'Couleur préférée': 'bleu' }]).notes.includes('bleu'));
}

/* ===================== Normalisations ===================== */
console.log('\nNormalisation des valeurs');
{
  check('e-mail extrait d’un libellé', I.normaliserEmail('Contact : Jean <JEAN@Exemple.FR>') === 'jean@exemple.fr',
    I.normaliserEmail('Contact : Jean <JEAN@Exemple.FR>'));
  check('e-mail invalide → vide', I.normaliserEmail('pas une adresse') === '');
  check('téléphone collé', I.normaliserTelephone('0478123456') === '04 78 12 34 56');
  check('téléphone +33', I.normaliserTelephone('+33 4 78 12 34 56') === '04 78 12 34 56');
  check('téléphone +33 (0)', I.normaliserTelephone('+33 (0)4 78 12 34 56') === '04 78 12 34 56');
  check('SIRET n’est pas pris pour un téléphone', I.normaliserTelephone('81234567800019') === '',
    I.normaliserTelephone('81234567800019'));
  check('URL nettoyée', I.normaliserSite('HTTPS://WWW.Exemple.fr/contact/') === 'exemple.fr');
  check('URL invalide → vide', I.normaliserSite('bonjour') === '');
  check('score borné', p1([{ nom: 'A', score: 999 }]).score === 100 && p1([{ nom: 'B', score: -5 }]).score === 0);
  check('score non numérique → 0', p1([{ nom: 'A', score: 'élevé' }]).score === 0);
  check('SIREN à 9 chiffres accepté', p1([{ nom: 'A', siren: '812345678' }]).siret === '812345678');
  check('identifiant de longueur aberrante écarté', p1([{ nom: 'A', siret: '123' }]).siret === '');
}

/* ===================== Réparations intelligentes ===================== */
console.log('\nDéduction plutôt que rejet');
{
  const r = I.analyser([{ email: 'contact@solaire-du-vexin.fr' }]);
  check('nom déduit du domaine', r.lignes[0].prospect.entreprise === 'Solaire Du Vexin',
    r.lignes[0].prospect.entreprise);
  check('la déduction est signalée', r.lignes[0].avertissements.some((a) => /déduit/.test(a)));
  check('site déduit de l’e-mail', r.lignes[0].prospect.site === 'solaire-du-vexin.fr');

  const gmail = I.analyser([{ email: 'jean.dupont@gmail.com' }]);
  check('domaine générique : pas de nom inventé', !gmail.lignes[0].valide,
    gmail.lignes[0].prospect.entreprise);
  check('le rejet est motivé', /impossible à déduire/.test(gmail.lignes[0].erreurs[0]));
  check('domaine générique : pas de site déduit', !gmail.lignes[0].prospect.site);

  const muet = I.analyser([{ nom: 'Entreprise Sans Contact' }]);
  check('sans contact : créée mais signalée', muet.lignes[0].valide &&
    muet.lignes[0].avertissements.some((a) => /aucun moyen de contact/.test(a)));
}

/* ===================== Robustesse ligne à ligne ===================== */
console.log('\nUne ligne fautive n’emporte pas les autres');
{
  const r = I.analyser([
    { nom: 'Bonne A', email: 'a@bonne-a.fr' },
    { rien: 'du tout' },
    null,
    'chaîne au lieu d’un objet',
    { nom: 'Bonne B', email: 'b@bonne-b.fr' }
  ]);
  check('les bonnes lignes passent', r.resume.valides === 2, JSON.stringify(r.resume));
  check('les mauvaises sont comptées', r.resume.rejetes === 3);
  check('chaque rejet porte son numéro de ligne',
    r.lignes.filter((l) => !l.valide).every((l) => l.numero > 0));
  check('chaque rejet porte sa raison',
    r.lignes.filter((l) => !l.valide).every((l) => l.erreurs.length > 0));
  check('aucune exception levée', true);

  const vide = I.analyser('');
  check('entrée vide → aucun résultat, aucune erreur', vide.resume.total === 0 && !vide.erreurGlobale);
  check('null → aucun résultat', I.analyser(null).resume.total === 0);
  const ndCasse = I.analyser('{"nom":"A"}\n{ceci est cassé}\n{"nom":"C"}');
  check('JSON par ligne : la ligne cassée est isolée',
    ndCasse.resume.valides === 2 && ndCasse.resume.rejetes === 1, JSON.stringify(ndCasse.resume));
}

console.log('\n' + passed + ' tests réussis, ' + failed + ' échec(s)');
process.exit(failed ? 1 : 0);
