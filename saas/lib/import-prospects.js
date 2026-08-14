'use strict';
/**
 * Import intelligent de prospects.
 *
 * Le problème qu'il résout : l'import n'acceptait qu'un tableau JSON aux noms
 * de champs exacts du CRM. Or un export d'Hermès nomme l'entreprise `nom`, les
 * contacts `emails[]` et `telephones[]`, le site `siteWeb`... aucun ne
 * correspondait, et le champ obligatoire manquant faisait échouer CHAQUE ligne
 * avec « entreprise requise ». Coller un CSV, un export Excel ou une liste
 * d'adresses produisait une erreur de syntaxe JSON incompréhensible.
 *
 * Principes :
 *   1. deviner le format plutôt que l'imposer (JSON, NDJSON, CSV, TSV, liste) ;
 *   2. reconnaître les champs par leurs synonymes usuels, accents et casse
 *      compris, plutôt que d'exiger un nom exact ;
 *   3. réparer ce qui est réparable (téléphone, e-mail, URL, code postal), et
 *      DEDUIRE le nom d'entreprise du domaine quand il manque ;
 *   4. ne jamais tout rejeter pour une ligne fautive : chaque ligne porte son
 *      propre diagnostic, avec son numéro et la raison exacte.
 *
 * Aucune dépendance, aucun accès disque : la fonction est pure et testable.
 */

/* ===================== Synonymes de champs ===================== */

// Les intitulés sont comparés sans accent, sans casse et sans séparateur :
// « Raison sociale », « raison_sociale » et « RAISONSOCIALE » se valent.
// Les intitulés anglais ne sont pas un cas exotique : les fichiers produits par
// un agent, un outil de scraping ou un fournisseur de données en emploient
// presque toujours. « name » absent de cette table faisait partir la raison
// sociale en notes, et 37 % d'un fichier réel étaient rejetés faute
// d'entreprise — alors que la donnée était bien là.
const SYNONYMES = {
  entreprise: ['entreprise', 'nom', 'name', 'nomcomplet', 'raisonsociale', 'nomentreprise',
    'nomdelentreprise', 'denomination', 'societe', 'company', 'companyname', 'companyeName',
    'businessname', 'legalname', 'tradename', 'organisation', 'organization', 'enseigne', 'marque'],
  contact: ['contact', 'nomcontact', 'interlocuteur', 'dirigeant', 'gerant', 'responsable',
    'prenomnom', 'personne', 'contactname', 'contactperson', 'fullname'],
  email: ['email', 'emails', 'mail', 'mails', 'courriel', 'adresseemail', 'adressemail', 'mel',
    'emailaddress', 'contactemail'],
  telephone: ['telephone', 'telephones', 'tel', 'tels', 'phone', 'phones', 'portable', 'mobile',
    'numero', 'numerotelephone', 'fixe', 'phonenumber', 'telephonenumber', 'contactphone'],
  site: ['site', 'siteweb', 'siteinternet', 'url', 'domaine', 'domain', 'website', 'web', 'lien',
    'pagewe', 'weburl', 'homepage'],
  ville: ['ville', 'commune', 'localite', 'libellecommune', 'city', 'town'],
  departement: ['departement', 'department', 'dept', 'codedepartement', 'dep', 'departmentcode'],
  codePostal: ['codepostal', 'cp', 'zip', 'zipcode', 'postalcode', 'postcode'],
  metier: ['metier', 'activite', 'activity', 'activiteprincipale', 'libelleactiviteprincipale',
    'ape', 'naf', 'secteur', 'sector', 'industry', 'qualification', 'qualifications',
    'certification', 'certifications', 'specialite', 'specialty'],
  siret: ['siret', 'siren', 'numerosiret', 'numerosiren', 'identifiant', 'registrationnumber',
    'vatnumber', 'tva'],
  score: ['score', 'note', 'notation', 'priorite', 'priority', 'rating'],
  notes: ['notes', 'note', 'commentaire', 'commentaires', 'remarque', 'remarques', 'observations',
    'indices', 'description', 'comment', 'comments'],
  source: ['source', 'sources', 'origine', 'provenance', 'canal', 'channel'],
  statut: ['statut', 'etat', 'etape', 'stade', 'status', 'stage', 'lifecyclestage'],
  proprietaire: ['proprietaire', 'assigne', 'commercial', 'owner', 'responsablecommercial',
    'assignedto', 'salesrep'],
  effectif: ['effectif', 'effectifs', 'taille', 'size', 'companysize', 'headcount', 'employees',
    'nbsalaries', 'trancheeffectifsalarie']
};

function normaliserCle(k) {
  return String(k)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Index inversé construit une fois : synonyme normalisé → champ canonique
const INDEX_SYNONYMES = {};
Object.keys(SYNONYMES).forEach((canon) => {
  SYNONYMES[canon].forEach((s) => { INDEX_SYNONYMES[normaliserCle(s)] = canon; });
});

function champCanonique(cle) {
  return INDEX_SYNONYMES[normaliserCle(cle)] || null;
}

/* ===================== Détection du format ===================== */

function detecterFormat(texte) {
  const t = String(texte || '').replace(/^﻿/, '').trim();
  if (!t) return 'vide';
  if (t[0] === '[' || t[0] === '{') {
    // Plusieurs objets collés les uns sous les autres = NDJSON
    const lignes = t.split(/\r?\n/).filter((l) => l.trim());
    if (t[0] === '{' && lignes.length > 1 && lignes.every((l) => l.trim().startsWith('{'))) return 'ndjson';
    return 'json';
  }
  const premiere = t.split(/\r?\n/)[0];
  if (premiere.includes('\t')) return 'tsv';
  // Un CSV a un séparateur récurrent ; une liste d'adresses n'en a pas
  if ((premiere.match(/;/g) || []).length >= 1) return 'csv';
  if ((premiere.match(/,/g) || []).length >= 1 && !/^[^,]+@[^,]+$/.test(premiere)) return 'csv';
  return 'liste';
}

/* ===================== Lecteurs ===================== */

function decouperLigne(ligne, sep) {
  const out = [];
  let cur = '', guillemets = false;
  for (let i = 0; i < ligne.length; i++) {
    const c = ligne[i];
    if (c === '"') {
      if (guillemets && ligne[i + 1] === '"') { cur += '"'; i++; }
      else guillemets = !guillemets;
    } else if (c === sep && !guillemets) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

/**
 * Découpe en enregistrements — pas en lignes.
 *
 * La nuance est décisive : un CSV exporté d'un CRM contient couramment une
 * adresse postale sur deux lignes, entre guillemets. Un `split('\n')` coupe cet
 * enregistrement en deux et décale toutes les colonnes suivantes ; le fichier
 * s'importe alors « sans erreur », avec des e-mails dans la case ville. Une
 * corruption silencieuse est pire qu'un refus.
 */
function decouperEnregistrements(texte) {
  const out = [];
  let cur = '', guillemets = false;
  const s = String(texte);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      if (guillemets && s[i + 1] === '"') { cur += '""'; i++; continue; }
      guillemets = !guillemets;
      cur += c;
    } else if (!guillemets && (c === '\n' || c === '\r')) {
      if (c === '\r' && s[i + 1] === '\n') i++;
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Le contenu est-il un fichier binaire lu comme du texte ? Un classeur Excel
 * glissé dans la zone d'import passait jusqu'ici pour du « TSV » et créait des
 * dizaines de fiches remplies d'octets. Mieux vaut refuser en expliquant.
 */
function estBinaire(texte) {
  const s = String(texte || '');
  if (!s) return false;
  if (s.charCodeAt(0) === 0x50 && s.charCodeAt(1) === 0x4b) return 'classeur Excel (.xlsx) ou OpenDocument (.ods)';
  if (s.slice(0, 8) === '\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1') return 'ancien classeur Excel (.xls)';
  if (s.slice(0, 5) === '%PDF-') return 'document PDF';
  const echantillon = s.slice(0, 4000);
  let suspects = 0;
  for (let i = 0; i < echantillon.length; i++) {
    const c = echantillon.charCodeAt(i);
    // Caractères de contrôle hors tabulation, retours et saut de page, plus le
    // caractère de remplacement que produit un décodage raté.
    if ((c < 9 || (c > 13 && c < 32)) || c === 0xfffd) suspects++;
  }
  return suspects / echantillon.length > 0.05 ? 'fichier binaire ou encodage non reconnu' : false;
}

/**
 * Renvoie `{ objets, enTete }`. Savoir si la première ligne a été consommée
 * comme intitulés n'est pas un détail interne : c'est ce qui permet de découper
 * un gros fichier en lots et de rejouer cette ligne en tête de chaque lot. Sans
 * elle, un lot sur deux serait lu en colonnes positionnelles.
 */
function lireTabulaire(texte, sep) {
  const lignes = decouperEnregistrements(String(texte).replace(/^﻿/, '')).filter((l) => l.trim());
  if (!lignes.length) return { objets: [], enTete: false };
  const entetes = decouperLigne(lignes[0], sep);
  // Si aucun intitulé n'est reconnu, la première ligne est probablement une
  // donnée : on retombe sur des colonnes positionnelles usuelles.
  const reconnus = entetes.filter((e) => champCanonique(e)).length;
  if (reconnus === 0) {
    return {
      enTete: false,
      objets: lignes.map((l) => {
        const c = decouperLigne(l, sep);
        return { entreprise: c[0], email: c[1], telephone: c[2], site: c[3], ville: c[4] };
      })
    };
  }
  return {
    enTete: true,
    objets: lignes.slice(1).map((l) => {
      const cols = decouperLigne(l, sep);
      const obj = {};
      entetes.forEach((e, i) => { if (e) obj[e] = cols[i]; });
      return obj;
    })
  };
}

/** Liste brute : une adresse, un domaine ou un nom par ligne. */
function lireListe(texte) {
  return String(texte).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(l)) return { email: l };
    if (/^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(l)) return { site: l };
    return { entreprise: l };
  });
}

/* ===================== Normalisation des valeurs ===================== */

/** Une valeur peut arriver en tableau (Hermès) ou en objet : on l'aplatit. */
function premiereValeur(v) {
  if (Array.isArray(v)) return v.length ? premiereValeur(v[0]) : '';
  if (v && typeof v === 'object') {
    return String(v.nom || v.valeur || v.value || v.label || JSON.stringify(v));
  }
  if (v === null || v === undefined || v === false) return '';
  return String(v);
}

function valeursSupplementaires(v) {
  return Array.isArray(v) && v.length > 1 ? v.slice(1).map(premiereValeur).filter(Boolean) : [];
}

function normaliserEmail(v) {
  const s = premiereValeur(v).trim().toLowerCase();
  if (!s) return '';
  const m = s.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
  return m ? m[0] : '';
}

function normaliserTelephone(v) {
  const brut = premiereValeur(v);
  let d = brut.replace(/\(0\)/g, '').replace(/\D/g, '');
  if (d.startsWith('0033')) d = d.slice(4);
  else if (d.startsWith('33') && d.length === 11) d = d.slice(2);
  else if (d.startsWith('0')) d = d.slice(1);
  if (d.length !== 9 || d[0] === '0') return '';
  return '0' + d.replace(/(\d)(\d{2})(\d{2})(\d{2})(\d{2})/, '$1 $2 $3 $4 $5');
}

function normaliserSite(v) {
  let s = premiereValeur(v).trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').split('/')[0];
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : '';
}

/** « solaire-du-vexin.fr » → « Solaire Du Vexin » : mieux qu'un rejet. */
function nomDepuisDomaine(domaine) {
  if (!domaine) return '';
  const base = domaine.split('.')[0];
  if (!base || base.length < 3) return '';
  if (/^(contact|info|mail|gmail|orange|wanadoo|free|hotmail|outlook|yahoo|laposte|sfr|bbox)$/.test(base)) return '';
  return base.split(/[-_]+/).filter(Boolean)
    .map((m) => m.charAt(0).toUpperCase() + m.slice(1)).join(' ');
}

const DOMAINES_GENERIQUES = /^(gmail|orange|wanadoo|free|hotmail|outlook|yahoo|laposte|sfr|bbox|live|msn|icloud)\./;

/* ===================== Mise en forme d'une fiche ===================== */

function mapper(brut) {
  const p = { notes: [] };
  const inconnus = [];

  Object.keys(brut || {}).forEach((cle) => {
    const canon = champCanonique(cle);
    const valeur = brut[cle];
    if (valeur === undefined || valeur === null || valeur === '') return;
    if (!canon) {
      // Un champ non reconnu n'est pas perdu : il part en notes plutôt que de
      // disparaître en silence — c'est souvent là qu'est l'information utile.
      const plat = premiereValeur(valeur);
      if (plat && plat.length < 200 && typeof valeur !== 'object') inconnus.push(cle + ' : ' + plat);
      return;
    }
    if (canon === 'notes') { const n = premiereValeur(valeur); if (n) p.notes.push(n); return; }
    // SIRET et SIREN partagent le même champ : le premier arrivé ne doit pas
    // gagner, sinon un SIREN à 9 chiffres écrase le SIRET à 14, plus précis
    // (il désigne l'établissement, pas seulement l'entreprise).
    if (canon === 'siret') { (p.__idents = p.__idents || []).push(valeur); return; }
    // Le métier reçoit plusieurs colonnes à la fois — « certifications » et
    // « activity » dans un même fichier. Le premier arrivé ne doit pas faire
    // disparaître les autres : « RGE » est utile, mais perdre au passage
    // « Installation de panneaux photovoltaïques » l'est beaucoup moins.
    if (canon === 'metier') { (p.__metiers = p.__metiers || []).push(valeur); return; }
    if (p[canon] === undefined) p[canon] = valeur;
  });

  const out = {};
  out.entreprise = premiereValeur(p.entreprise).trim().slice(0, 200);
  out.contact = premiereValeur(p.contact).trim().slice(0, 120);
  out.email = normaliserEmail(p.email);
  out.telephone = normaliserTelephone(p.telephone);
  out.site = normaliserSite(p.site);
  out.ville = premiereValeur(p.ville).trim().slice(0, 120);
  // Toutes les valeurs de métier, dédoublonnées et rassemblées : le champ est
  // interrogeable en base (« metier LIKE %QualiPV% »), c'est là qu'elles
  // servent, pas noyées dans les notes.
  out.metier = [...new Set(
    (p.__metiers || [])
      .flatMap((v) => (Array.isArray(v) ? v : [v]))
      .map((v) => String(v === null || v === undefined ? '' : v).trim())
      .filter(Boolean)
  )].join(', ').slice(0, 200);
  out.source = premiereValeur(p.source).trim().slice(0, 80) || 'import';
  out.proprietaire = premiereValeur(p.proprietaire).trim().slice(0, 80);
  out.statut = premiereValeur(p.statut).trim().toLowerCase();

  // Département : repris tel quel, ou déduit du code postal
  const dep = premiereValeur(p.departement).trim();
  const cp = premiereValeur(p.codePostal).replace(/\D/g, '');
  out.departement = /^\d{2,3}$/.test(dep) ? dep : (cp.length === 5 ? cp.slice(0, 2) : dep.slice(0, 3));

  // SIRET (14) préféré au SIREN (9) quand les deux sont fournis
  const idents = (p.__idents || []).map((v) => premiereValeur(v).replace(/\D/g, ''));
  out.siret = idents.find((d) => d.length === 14) || idents.find((d) => d.length === 9) || '';

  const note = parseInt(premiereValeur(p.score), 10);
  out.score = Number.isFinite(note) ? Math.max(0, Math.min(100, note)) : 0;

  // Contacts secondaires et champs inconnus : conservés en notes
  // Les contacts secondaires ressortent en clair plutôt qu'en texte libre dans
  // les notes : rangés là, ils étaient invisibles d'une recherche et il fallait
  // les recopier à la main pour appeler le portable du gérant.
  out.emailsSup = valeursSupplementaires(p.email)
    .map((v) => normaliserEmail(v)).filter(Boolean);
  out.telephonesSup = valeursSupplementaires(p.telephone)
    .map((v) => normaliserTelephone(v)).filter(Boolean);

  const extras = []
    .concat(premiereValeur(p.effectif) ? ['effectif : ' + premiereValeur(p.effectif)] : [])
    .concat(p.notes)
    .concat(inconnus);
  out.notes = extras.join(' · ').slice(0, 4000);

  return out;
}

/* ===================== Validation et réparation ===================== */

function valider(p) {
  const erreurs = [], avertissements = [];

  if (!p.entreprise) {
    // Plutôt que de rejeter, on tente de reconstituer le nom : c'est le cas le
    // plus fréquent d'échec, et le domaine porte presque toujours l'information.
    const depuisSite = nomDepuisDomaine(p.site);
    const domaineMail = p.email && !DOMAINES_GENERIQUES.test(p.email.split('@')[1] + '.')
      ? p.email.split('@')[1] : '';
    const depuisMail = nomDepuisDomaine(domaineMail);
    const devine = depuisSite || depuisMail;
    if (devine) {
      p.entreprise = devine;
      avertissements.push('nom déduit du domaine « ' + (p.site || domaineMail) + ' »');
    } else {
      erreurs.push('nom d’entreprise absent, et impossible à déduire');
    }
  }
  if (!p.email && !p.telephone && !p.site) {
    avertissements.push('aucun moyen de contact : la fiche sera créée mais inexploitable');
  }
  if (!p.site && p.email && !DOMAINES_GENERIQUES.test(p.email.split('@')[1] + '.')) {
    p.site = p.email.split('@')[1];
    avertissements.push('site déduit de l’adresse e-mail');
  }
  return { erreurs, avertissements };
}

/* ===================== Analyse complète ===================== */

/**
 * Point d'entrée unique. Ne lève jamais : tout ce qui ne va pas est décrit
 * ligne par ligne, ce qui permet d'afficher un aperçu avant d'importer.
 */
function analyser(entree) {
  const resultat = {
    format: 'vide', enTete: false, separateur: '', lignes: [],
    resume: { total: 0, valides: 0, rejetes: 0, avertis: 0 }
  };

  let bruts = [];
  if (Array.isArray(entree)) {
    resultat.format = 'json';
    bruts = entree;
  } else if (entree && typeof entree === 'object') {
    resultat.format = 'json';
    bruts = Array.isArray(entree.prospects) ? entree.prospects : [entree];
  } else {
    const texte = String(entree || '');

    // Avant toute interprétation : ce contenu est-il seulement du texte ? Un
    // classeur binaire produisait des fiches remplies d'octets, sans un mot
    // d'avertissement.
    const binaire = estBinaire(texte);
    if (binaire) {
      resultat.format = 'binaire';
      resultat.erreurGlobale =
        'Ce fichier n’est pas du texte : il a été reconnu comme un ' + binaire + '. ' +
        'Ouvrez-le dans votre tableur puis « Enregistrer sous » → CSV UTF-8, ' +
        'et réessayez avec le fichier obtenu.';
      return resultat;
    }

    resultat.format = detecterFormat(texte);
    try {
      if (resultat.format === 'json') {
        // Virgule finale et guillemets typographiques : erreurs de copier-coller
        // trop banales pour mériter un rejet.
        const propre = texte.replace(/^﻿/, '').replace(/,\s*([\]}])/g, '$1').trim();
        const parse = JSON.parse(propre);
        bruts = Array.isArray(parse) ? parse
          : (Array.isArray(parse.prospects) ? parse.prospects : [parse]);
      } else if (resultat.format === 'ndjson') {
        bruts = texte.split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
          try { return JSON.parse(l); } catch (e) { return { __erreur: 'ligne ' + (i + 1) + ' : JSON invalide' }; }
        });
      } else if (resultat.format === 'csv' || resultat.format === 'tsv') {
        const sep = resultat.format === 'tsv' ? '\t'
          : (texte.split(/\r?\n/)[0].includes(';') ? ';' : ',');
        const lu = lireTabulaire(texte, sep);
        bruts = lu.objets;
        resultat.enTete = lu.enTete;
        resultat.separateur = sep;
      } else if (resultat.format === 'liste') {
        bruts = lireListe(texte);
      }
    } catch (e) {
      // Le message brut de JSON.parse (« Expected property name… position 1 »)
      // n'aide personne : on dit ce qui est attendu et ce qu'on a cru lire.
      resultat.erreurGlobale =
        'Contenu illisible. Il a été interprété comme du ' + resultat.format.toUpperCase() +
        ', mais la lecture a échoué. Vérifiez qu’il s’agit bien d’un tableau JSON, ' +
        'd’un CSV avec une ligne d’intitulés, ou d’une simple liste d’adresses — une par ligne. ' +
        '(détail technique : ' + e.message + ')';
      return resultat;
    }
  }

  bruts.forEach((brut, i) => {
    const ligne = { numero: i + 1, erreurs: [], avertissements: [] };
    if (!brut || typeof brut !== 'object') {
      ligne.erreurs.push('entrée ignorée : ce n’est pas une fiche');
      ligne.prospect = {};
    } else if (brut.__erreur) {
      ligne.erreurs.push(brut.__erreur);
      ligne.prospect = {};
    } else {
      ligne.prospect = mapper(brut);
      const v = valider(ligne.prospect);
      ligne.erreurs = v.erreurs;
      ligne.avertissements = v.avertissements;
    }
    ligne.valide = ligne.erreurs.length === 0;
    resultat.lignes.push(ligne);
  });

  resultat.resume.total = resultat.lignes.length;
  resultat.resume.valides = resultat.lignes.filter((l) => l.valide).length;
  resultat.resume.rejetes = resultat.lignes.filter((l) => !l.valide).length;
  resultat.resume.avertis = resultat.lignes.filter((l) => l.avertissements.length).length;
  return resultat;
}

module.exports = {
  decouperEnregistrements, estBinaire,
  analyser, mapper, valider, detecterFormat, champCanonique,
  normaliserEmail, normaliserTelephone, normaliserSite, nomDepuisDomaine,
  lireTabulaire, lireListe, decouperLigne, SYNONYMES
};
