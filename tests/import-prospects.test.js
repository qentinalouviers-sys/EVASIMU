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

/* ===================== Fichiers réels : intitulés anglais ===================== */
console.log('\nIntitulés anglais — le cas d’un vrai fichier de 8 741 fiches');
{
  // Ces noms de colonnes viennent d'un fichier réel produit par un agent de
  // recherche. « name » manquait à la table : la raison sociale partait en
  // notes, le nom était redéduit du domaine, et 37 % du fichier était rejeté
  // faute d'entreprise — alors que la donnée était bien là.
  const attendus = {
    name: 'entreprise', email: 'email', phone: 'telephone', website: 'site',
    city: 'ville', postal_code: 'codePostal', department: 'departement',
    activity: 'metier', certifications: 'metier', company_size: 'effectif',
    score: 'score', source: 'source', status: 'statut', notes: 'notes'
  };
  Object.entries(attendus).forEach(([col, canon]) => {
    check('« ' + col + ' » → ' + canon, I.champCanonique(col) === canon,
      String(I.champCanonique(col)));
  });

  const fiche = {
    name: 'IN AUV ENERGIES', email: 'accueil@inauv-energies.fr', phone: '04 71 73 58 48',
    website: 'https://www.inauv-energies.fr', city: 'Lafeuillade-en-Vézie',
    postal_code: '15130', department: '15', region: 'Auvergne-Rhône-Alpes',
    company_size: '1-10', certifications: ['RGE', 'QualiPV'],
    activity: 'Installation de panneaux solaires photovoltaïques', score: 100
  };
  const p = p1([fiche]);
  check('la raison sociale est celle du fichier, pas une déduction',
    p.entreprise === 'IN AUV ENERGIES', p.entreprise);
  check('aucun avertissement de déduction',
    !I.analyser([fiche]).lignes[0].avertissements.some((a) => /déduit/.test(a)));
  check('département repris tel quel', p.departement === '15', p.departement);
  // Deux colonnes visent le métier : la première ne doit pas effacer l'autre.
  check('certifications ET activité conservées, dans un champ interrogeable',
    /RGE/.test(p.metier) && /QualiPV/.test(p.metier) && /panneaux solaires/.test(p.metier),
    p.metier);
  check('les valeurs de métier ne sont pas répétées',
    I.analyser([{ name: 'A', certifications: ['RGE', 'RGE'], activity: 'RGE' }])
      .lignes[0].prospect.metier === 'RGE');
  check('la région, sans colonne dédiée, reste en notes', /Auvergne/.test(p.notes));
}

/* ===================== Enregistrements sur plusieurs lignes ===================== */
console.log('\nCSV dont un champ contient un retour à la ligne');
{
  const csv = 'Raison sociale;Adresse;E-mail\n' +
    'Solaire du Vexin;"12 rue des Lilas\n27200 Vernon";contact@sv.fr\n' +
    'Toitures Martin;3 av. Foch;contact@tm.fr';
  const r = I.analyser(csv);
  check('deux fiches, pas trois', r.resume.total === 2, JSON.stringify(r.resume));
  check('les colonnes ne se décalent pas',
    r.lignes[0].prospect.email === 'contact@sv.fr', r.lignes[0].prospect.email);
  check('la seconde fiche est intacte', r.lignes[1].prospect.email === 'contact@tm.fr');
  check('guillemets doublés préservés',
    I.analyser('nom;notes\nA;"il a dit ""oui"""').lignes[0].prospect.notes.includes('oui'));
  check('découpe brute inchangée sans guillemets',
    I.decouperEnregistrements('a\nb\nc').length === 3);
}

/* ===================== Fichiers qui ne sont pas du texte ===================== */
console.log('\nUn classeur glissé par erreur');
{
  const xlsx = 'PK  ' + ' '.repeat(50);
  const r = I.analyser(xlsx);
  check('un .xlsx ne devient pas des fiches remplies d’octets',
    r.format === 'binaire' && !r.lignes.length, r.format + ' / ' + r.resume.total);
  check('le message dit quoi faire', /Enregistrer sous/.test(r.erreurGlobale), r.erreurGlobale);
  check('le format est nommé', /classeur Excel/.test(r.erreurGlobale));
  check('un PDF est reconnu aussi', /PDF/.test(I.analyser('%PDF-1.7\n' + ''.repeat(300)).erreurGlobale));
  check('un export UTF-16 est écarté plutôt que lu de travers',
    I.analyser(Buffer.from('Nom;Ville\nSolaire;Vernon', 'utf16le').toString('utf8')).format === 'binaire');
  check('un CSV normal n’est jamais pris pour du binaire',
    I.analyser('Raison sociale;Ville\nÉnergies Nouvelles;Évreux').format === 'csv');
  check('un JSON accentué non plus',
    I.analyser('[{"nom":"Énergies","ville":"Évreux"}]').format === 'json');
  check('estBinaire tolère une entrée vide', I.estBinaire('') === false);
}

/* ===================== Découpe en lots ===================== */
console.log('\nCe qui permet d’envoyer un gros fichier par tranches');
{
  const avec = I.analyser('Raison sociale;E-mail\nA;a@b.fr\nB;b@c.fr');
  check('CSV à intitulés : signalé', avec.enTete === true);
  check('séparateur signalé', avec.separateur === ';', avec.separateur);
  const sans = I.analyser('A;a@b.fr\nB;b@c.fr');
  check('CSV sans intitulés : signalé aussi', sans.enTete === false);
  check('JSON : pas d’intitulés', I.analyser('[{"nom":"A"}]').enTete === false);
  // Un lot rejoué avec sa ligne d'intitulés doit donner exactement la même
  // fiche que le fichier entier — c'est la garantie du découpage.
  const entier = I.analyser('Raison sociale;E-mail\nA;a@b.fr\nB;b@c.fr');
  const lot2 = I.analyser('Raison sociale;E-mail\nB;b@c.fr');
  check('un lot avec son intitulé produit la même fiche',
    JSON.stringify(lot2.lignes[0].prospect) === JSON.stringify(entier.lignes[1].prospect));
}

console.log('\n' + passed + ' tests réussis, ' + failed + ' échec(s)');
process.exit(failed ? 1 : 0);
