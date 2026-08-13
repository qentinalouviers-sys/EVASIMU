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
const SYNONYMES = {
  entreprise: ['entreprise', 'nom', 'nomcomplet', 'raisonsociale', 'nomentreprise', 'nomdelentreprise',
    'denomination', 'societe', 'company', 'companyname', 'organisation', 'enseigne', 'marque'],
  contact: ['contact', 'nomcontact', 'interlocuteur', 'dirigeant', 'gerant', 'responsable',
    'prenomnom', 'personne', 'contactname'],
  email: ['email', 'emails', 'mail', 'mails', 'courriel', 'adresseemail', 'adressemail', 'mel'],
  telephone: ['telephone', 'telephones', 'tel', 'tels', 'phone', 'portable', 'mobile', 'numero',
    'numerotelephone', 'fixe'],
  site: ['site', 'siteweb', 'siteinternet', 'url', 'domaine', 'website', 'web', 'lien', 'pagewe'],
  ville: ['ville', 'commune', 'localite', 'libellecommune', 'city'],
  departement: ['departement', 'dept', 'codedepartement', 'dep'],
  codePostal: ['codepostal', 'cp', 'zip', 'postalcode'],
  metier: ['metier', 'activite', 'activiteprincipale', 'libelleactiviteprincipale', 'ape', 'naf',
    'secteur', 'qualification', 'qualifications', 'specialite'],
  siret: ['siret', 'siren', 'numerosiret', 'numerosiren', 'identifiant'],
  score: ['score', 'note', 'notation', 'priorite'],
  notes: ['notes', 'note', 'commentaire', 'commentaires', 'remarque', 'remarques', 'observations',
    'indices', 'description'],
  source: ['source', 'sources', 'origine', 'provenance', 'canal'],
  statut: ['statut', 'etat', 'etape', 'stade', 'status'],
  proprietaire: ['proprietaire', 'assigne', 'commercial', 'owner', 'responsablecommercial'],
  effectif: ['effectif', 'effectifs', 'taille', 'nbsalaries', 'trancheeffectifsalarie']
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

function lireTabulaire(texte, sep) {
  const lignes = String(texte).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lignes.length) return [];
  const entetes = decouperLigne(lignes[0], sep);
  // Si aucun intitulé n'est reconnu, la première ligne est probablement une
  // donnée : on retombe sur des colonnes positionnelles usuelles.
  const reconnus = entetes.filter((e) => champCanonique(e)).length;
  if (reconnus === 0) {
    return lignes.map((l) => {
      const c = decouperLigne(l, sep);
      return { entreprise: c[0], email: c[1], telephone: c[2], site: c[3], ville: c[4] };
    });
  }
  return lignes.slice(1).map((l) => {
    const cols = decouperLigne(l, sep);
    const obj = {};
    entetes.forEach((e, i) => { if (e) obj[e] = cols[i]; });
    return obj;
  });
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
    if (p[canon] === undefined) p[canon] = valeur;
  });

  const out = {};
  out.entreprise = premiereValeur(p.entreprise).trim().slice(0, 200);
  out.contact = premiereValeur(p.contact).trim().slice(0, 120);
  out.email = normaliserEmail(p.email);
  out.telephone = normaliserTelephone(p.telephone);
  out.site = normaliserSite(p.site);
  out.ville = premiereValeur(p.ville).trim().slice(0, 120);
  out.metier = premiereValeur(p.metier).trim().slice(0, 200);
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
  const extras = []
    .concat(valeursSupplementaires(p.email).map((v) => 'autre e-mail : ' + v))
    .concat(valeursSupplementaires(p.telephone).map((v) => 'autre tél. : ' + v))
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
  const resultat = { format: 'vide', lignes: [], resume: { total: 0, valides: 0, rejetes: 0, avertis: 0 } };

  let bruts = [];
  if (Array.isArray(entree)) {
    resultat.format = 'json';
    bruts = entree;
  } else if (entree && typeof entree === 'object') {
    resultat.format = 'json';
    bruts = Array.isArray(entree.prospects) ? entree.prospects : [entree];
  } else {
    const texte = String(entree || '');
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
      } else if (resultat.format === 'csv') {
        bruts = lireTabulaire(texte, texte.split(/\r?\n/)[0].includes(';') ? ';' : ',');
      } else if (resultat.format === 'tsv') {
        bruts = lireTabulaire(texte, '\t');
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
  analyser, mapper, valider, detecterFormat, champCanonique,
  normaliserEmail, normaliserTelephone, normaliserSite, nomDepuisDomaine,
  lireTabulaire, lireListe, decouperLigne, SYNONYMES
};
