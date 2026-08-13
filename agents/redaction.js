/*!
 * Hermès — Agent de rédaction
 *
 * Transforme une fiche prospect en message personnalisé. La personnalisation
 * n'est pas cosmétique : elle s'appuie sur ce que l'agent de capture a
 * réellement observé — la ville, la qualification Quali'PV, l'absence de
 * simulateur sur leur site. Un installateur reconnaît en trois secondes un
 * publipostage ; il répond à un message qui prouve qu'on a regardé son site.
 *
 * Sortie : des fichiers `.eml` standard, importables comme brouillons dans
 * n'importe quelle messagerie, plus un CSV de publipostage. L'agent
 * **n'envoie rien** : l'envoi reste une décision humaine.
 *
 * Contraintes légales appliquées à chaque message :
 *   - émetteur identifiable (raison sociale, adresse, contact) ;
 *   - objet de la sollicitation explicite ;
 *   - moyen de désinscription en clair, en une phrase, sans formulaire.
 *
 * Usage :
 *   node agents/redaction.js --pipeline data/pipeline.json --sortie data/messages
 */
'use strict';

const fs = require('fs');
const path = require('path');
const P = require('./pipeline.js');

/* ===================== Identité de l'émetteur ===================== */

// Ce bloc apparaît en pied de chaque message : c'est lui qui identifie
// l'émetteur et rend la sollicitation commerciale licite. L'adresse postale
// n'est pas décorative — sans elle, le message est une prospection anonyme.
const EMETTEUR = {
  societe: 'RDF-SOLAR',
  entite: 'Tekotek',                         // entité derrière la marque
  email: 'contact@rdf-solar.fr',
  telephone: '+33 6 14 74 69 75',
  site: 'https://www.rdf-solar.fr',
  adresse: '20 rue Maréchal Foch, 27400 Louviers'
};

/* ===================== Fragments de personnalisation ===================== */

/** Ce que l'agent a observé, transformé en une phrase qui le prouve. */
function accroche(p) {
  if (p.aSimulateur === false && p.siteWeb) {
    return `En regardant ${domaineLisible(p.siteWeb)}, j’ai vu que vos visiteurs peuvent demander un devis, ` +
      `mais pas visualiser leur toiture équipée avant de le faire.`;
  }
  if (p.qualifPV) {
    return `Vous êtes qualifiés Quali’PV${p.ville ? ' sur ' + p.ville : ''} : c’est exactement le profil ` +
      `pour lequel nous avons conçu notre simulateur.`;
  }
  if (p.ville) {
    return `Nous travaillons avec des installateurs photovoltaïques${p.ville ? ' de la région de ' + p.ville : ''}, ` +
      `sur un point précis : la qualité des demandes de devis qui arrivent depuis leur site.`;
  }
  return `Nous travaillons avec des installateurs photovoltaïques sur un point précis : ` +
    `la qualité des demandes de devis qui arrivent depuis leur site.`;
}

function domaineLisible(url) {
  return String(url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}

function civilite(p) {
  return p.nom ? `Bonjour,` : 'Bonjour,';
}

/* ===================== Modèles ===================== */

/**
 * Trois variantes par étape. Deux raisons : un message strictement identique
 * envoyé en masse se fait filtrer comme du publipostage, et deux personnes de
 * la même entreprise qui reçoivent le même texte au mot près, ça se voit.
 * La variante est choisie de façon déterministe à partir du SIREN, pour qu'un
 * même prospect reçoive toujours le même message si l'on relance la commande.
 */
const MODELES = {
  premier: [
    {
      objet: (p) => `Vos visiteurs ${p.ville ? 'à ' + p.ville + ' ' : ''}voient-ils leur toit équipé ?`,
      corps: (p) => `${civilite(p)}

${accroche(p)}

Nous éditons un simulateur photovoltaïque que vous installez sur votre site, à votre marque : le visiteur saisit son adresse, voit la photo aérienne réelle de son toit, y place vos panneaux, et découvre sa production et ses économies. Quand il demande un devis, vous recevez ses coordonnées avec toute la simulation — adresse, nombre de panneaux, kWc, production estimée, offre choisie.

Concrètement, vos commerciaux arrêtent de rappeler à l’aveugle.

L’installation tient en trois lignes de HTML, et nous configurons vos offres pour vous. Essai gratuit 30 jours, sans carte bancaire.

Est-ce que ça vaut un échange de dix minutes ?`
    },
    {
      objet: () => `Un simulateur solaire à votre marque, en ligne cet après-midi`,
      corps: (p) => `${civilite(p)}

${accroche(p)}

Le principe : un simulateur photovoltaïque à vos couleurs, posé sur votre site en trois lignes de HTML. Votre visiteur dessine sa toiture sur la vraie photo aérienne, choisit parmi VOS offres, et découvre sa production. Sa demande de devis vous arrive avec le projet complet.

Vous gardez tout : vos leads partent directement dans votre CRM, aucune coordonnée ne transite chez nous, et il n’y a aucune commission sur ce que vous signez.

Nous configurons votre catalogue sous 24 h, et vous testez 30 jours sans carte bancaire.

Un créneau cette semaine pour en parler ?`
    },
    {
      objet: (p) => `Question rapide sur vos demandes de devis${p.ville ? ' — ' + p.ville : ''}`,
      corps: (p) => `${civilite(p)}

${accroche(p)}

La question que je me pose : sur dix demandes de devis reçues par votre site, combien débouchent sur une visite technique utile ?

Notre simulateur déplace ce tri en amont. Le visiteur passe deux minutes à dessiner son toit sur la photo aérienne et à choisir parmi vos offres ; vous recevez sa demande avec la surface, l’orientation, le nombre de panneaux et la production estimée. Les toitures inexploitables ne remontent plus.

C’est à votre marque, avec vos prix, et gratuit pendant 30 jours sans carte bancaire.

Dix minutes au téléphone pour vous montrer ?`
    }
  ],

  relance1: [
    {
      objet: () => `Re : votre simulateur solaire`,
      corps: (p) => `${civilite(p)}

Je me permets de revenir vers vous — mon message précédent est peut-être passé au mauvais moment.

Le plus simple est sans doute de le voir tourner plutôt que d’en parler : la démonstration est publique, sans inscription ni e-mail à laisser.

${EMETTEUR.site}

Si le sujet n’est pas d’actualité, dites-le-moi d’un mot, je n’insisterai pas.`
    },
    {
      objet: (p) => `${p.nom ? p.nom + ' — ' : ''}la démo, en accès libre`,
      corps: (p) => `${civilite(p)}

Un mot de suivi sur le simulateur photovoltaïque en marque blanche dont je vous parlais.

Plutôt qu’un argumentaire : dessinez un toit, ouvrez la vue 3D, regardez ce que reçoit le commercial à la fin. Deux minutes suffisent.

${EMETTEUR.site}

Et si ce n’est pas le sujet du moment, répondez-moi simplement « non merci ».`
    }
  ],

  relance2: [
    {
      objet: () => `Je clos le sujet`,
      corps: (p) => `${civilite(p)}

Je vous ai écrit deux fois au sujet de notre simulateur photovoltaïque en marque blanche, sans réponse — c’est un signal, et je le respecte.

Je clos le sujet de mon côté. Si la question des demandes de devis revient sur la table cette année, vous savez où me trouver.

Bonne continuation.`
    }
  ]
};

/** Choix déterministe : le même prospect reçoit toujours la même variante. */
function choisirVariante(cle, nombre) {
  let somme = 0;
  for (const c of String(cle)) somme = (somme * 31 + c.charCodeAt(0)) % 100000;
  return somme % nombre;
}

/* ===================== Pied de message obligatoire ===================== */

// Les modèles sont du TEXTE BRUT : pas de markdown. Un « **gras** » écrit ici
// arrive tel quel chez le destinataire et signe le publipostage automatisé.


function pied(p) {
  const id = [EMETTEUR.societe, EMETTEUR.entite].filter(Boolean).join(' — ');
  const coord = [EMETTEUR.email, EMETTEUR.telephone, EMETTEUR.site].filter(Boolean).join(' · ');
  return `
--
${id}
${coord}${EMETTEUR.adresse ? '\n' + EMETTEUR.adresse : ''}

Vous recevez ce message à titre professionnel, au sujet d’un outil destiné aux installateurs photovoltaïques. Pour ne plus être contacté, répondez « STOP » à cet e-mail : votre adresse sera retirée définitivement.`;
}

/* ===================== Rédaction ===================== */

function rediger(prospect, etape, cle) {
  const modeles = MODELES[etape];
  if (!modeles) throw new Error('Étape sans modèle : ' + etape);
  const i = choisirVariante(cle || prospect.siren || prospect.nom, modeles.length);
  const m = modeles[i];
  return {
    destinataire: (prospect.emails || [])[0] || '',
    objet: m.objet(prospect),
    corps: m.corps(prospect) + '\n' + pied(prospect),
    etape,
    variante: i + 1,
    prospect: prospect.nom,
    siren: prospect.siren || ''
  };
}

/* ===================== Écriture au format .eml ===================== */

/** En-tête RFC 2047 : sans ça, un objet accentué arrive en charabia. */
function encoderEntete(texte) {
  return /^[\x20-\x7E]*$/.test(texte)
    ? texte
    : '=?UTF-8?B?' + Buffer.from(texte, 'utf8').toString('base64') + '?=';
}

function versEml(message, de) {
  const corps = Buffer.from(message.corps, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return [
    'From: ' + (de || EMETTEUR.email),
    'To: ' + message.destinataire,
    'Subject: ' + encoderEntete(message.objet),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'X-Hermes-Etape: ' + message.etape,
    'X-Hermes-Siren: ' + message.siren,
    '',
    corps
  ].join('\r\n');
}

function nomFichier(message, index) {
  const base = String(message.prospect || 'prospect')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40);
  return String(index).padStart(3, '0') + '-' + message.etape + '-' + (base || 'prospect') + '.eml';
}

function versCsv(messages) {
  const ech = (v) => /[";\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  return ['destinataire;entreprise;siren;etape;variante;objet;corps']
    .concat(messages.map((m) => [m.destinataire, m.prospect, m.siren, m.etape, m.variante, m.objet, m.corps].map(ech).join(';')))
    .join('\n');
}

/* ===================== Orchestration ===================== */

function run(opts = {}) {
  const log = (...a) => { if (!process.env.HERMES_SILENCE) console.log(...a); };
  const cheminPipeline = opts.pipeline || 'data/pipeline.json';
  const store = P.charger(cheminPipeline);

  const lot = P.aTraiter(store, {
    limite: Number(opts.limite) || 50,
    scoreMin: Number(opts.score) || 0,
    delaiRelance1: Number(opts['delai-relance1']) || 7,
    delaiRelance2: Number(opts['delai-relance2']) || 14
  });

  if (!lot.length) {
    log('Aucun prospect à traiter aujourd’hui. Rien n’est écrit.');
    return [];
  }

  const messages = lot.map(({ cle, etape, prospect }) => rediger(prospect, etape, cle));
  const dossier = opts.sortie || 'data/messages';
  fs.mkdirSync(dossier, { recursive: true });

  messages.forEach((m, i) => {
    fs.writeFileSync(path.join(dossier, nomFichier(m, i + 1)), versEml(m), 'utf8');
  });
  fs.writeFileSync(path.join(dossier, 'publipostage.csv'), '﻿' + versCsv(messages), 'utf8');

  // L'état n'avance QUE si on le demande : par défaut on produit des brouillons
  // à relire, et rien ne prétend avoir été envoyé.
  if (opts.marquer) {
    const date = new Date();
    for (const { cle, etape } of lot) {
      P.marquer(store, cle, etape === 'premier' ? 'contacte' : etape, 'message rédigé', date);
    }
    P.enregistrer(store, cheminPipeline);
    log('Pipeline mis à jour : ' + lot.length + ' prospect(s) marqués comme contactés.');
  }

  const parEtape = messages.reduce((a, m) => (a[m.etape] = (a[m.etape] || 0) + 1, a), {});
  log(`\n✓ ${messages.length} message(s) écrits dans ${dossier}/`);
  log('  ' + Object.entries(parEtape).map(([e, n]) => n + ' × ' + e).join(' · '));
  log('  Relisez-les, puis importez les .eml comme brouillons — ou utilisez publipostage.csv.');
  if (!opts.marquer) log('  ⚠ Le pipeline n’est PAS modifié. Ajoutez --marquer une fois les messages partis.');
  return messages;
}

if (require.main === module) {
  const o = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const c = argv[i].slice(2);
    o[c] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  if (o.help) {
    console.log(`
Hermès — rédaction des messages de prospection

  --pipeline data/pipeline.json  Fichier d'état (défaut : data/pipeline.json)
  --sortie data/messages         Dossier des .eml produits
  --limite 50                    Nombre maximum de messages
  --score 60                     Ne traiter que les prospects au-dessus de ce score
  --marquer                      Avance l'état des prospects (à faire APRÈS envoi)
  --help
`);
    process.exit(0);
  }
  try { run(o); } catch (e) { console.error('Échec :', e.message); process.exit(1); }
}

module.exports = {
  EMETTEUR, MODELES, rediger, accroche, choisirVariante, pied,
  versEml, versCsv, encoderEntete, nomFichier, domaineLisible, run
};
