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
// Le domaine doit être RÉEL et résoudre : un destinataire qui reçoit un message
// signé d'un domaine inexistant le classe en indésirable avant même d'en lire le
// contenu, et l'identification de l'émetteur exigée par la loi est alors fausse.
// `rdf-solar.fr`, utilisé ici auparavant, n'a ni enregistrement A ni MX.
const EMETTEUR = {
  societe: 'RDF-SOLAR',
  entite: 'Tekotek',                         // entité derrière la marque
  email: process.env.HERMES_EMAIL || 'contact@eviatek.fr',
  telephone: '+33 6 14 74 69 75',
  // La page de vente publique, déployée par la CI sur GitHub Pages.
  site: process.env.HERMES_SITE || 'https://qentinalouviers-sys.github.io/RDF-SOLAR/',
  adresse: '20 rue Maréchal Foch, 27400 Louviers',
  // Le simulateur lui-même, en accès libre. C'est ce lien que citent les
  // relances : « voyez-le tourner » vaut mieux qu'un argumentaire, mais
  // seulement si la page existe vraiment.
  demo: process.env.HERMES_DEMO || 'https://qentinalouviers-sys.github.io/RDF-SOLAR/demo.html'
};

/*
 * Les chiffres de l'offre, au même endroit qu'ailleurs dans le projet.
 * La page de vente les répète à quatre endroits ; les messages ne doivent pas
 * devenir un cinquième endroit à corriger séparément, sinon un prospect
 * recevra un tarif que la page dément.
 */
const GRILLE = JSON.parse(
  require('fs').readFileSync(
    require('path').join(__dirname, '..', 'saas', 'config', 'formules.json'), 'utf8')
);
const parFormule = (id) => GRILLE.formules.filter((f) => f.id === id)[0] || {};

const OFFRE = {
  // Lus dans la grille du SaaS, pas recopiés : la page de vente, la console et
  // les messages annonçaient déjà deux tarifs différents (89 €/mois d'un côté,
  // 590 €/an de l'autre). Un prospect qui compare le message au devis ne doit
  // jamais y trouver deux chiffres.
  prixEntree: parFormule('essentiel').prixHTMois + ' € HT/mois',
  prixPro: parFormule('agence').prixHTMois + ' € HT/mois',
  leadsGratuits: (parFormule('decouverte').limites || {}).leadsParMois,
  prixLead: GRILLE.prixLeadHT + ' € HT',
  miseEnLigne: '5 minutes',
  lignesCode: 'trois lignes de HTML'
};

/** Le lien mis dans les relances : la démo si elle existe, le site sinon. */
function lienDemo() {
  return EMETTEUR.demo || EMETTEUR.site;
}

/* ===================== Fragments de personnalisation ===================== */

/**
 * Ce que l'agent a observé, transformé en une phrase qui le prouve.
 *
 * L'ordre est celui de la force de preuve. Une observation tirée de
 * l'inspection du site passe avant tout le reste : citer ce que leur propre
 * simulateur réclame au visiteur, ou ce qu'il ne montre pas, se vérifie en
 * trois secondes — là où « nous travaillons avec des installateurs » ne prouve
 * rien et se lit comme un publipostage.
 */
function accroche(p) {
  const insp = p.inspection || {};
  const site = domaineLisible(p.siteWeb || '');

  if (insp.niveau >= 1 && insp.niveau <= 2 && site) {
    const reclame = (insp.donnees || []).length
      ? ` Il réclame ${listeFr(champsParlants(insp.donnees))} avant d’afficher le moindre résultat.` : '';
    return `J’ai regardé ${site} : vous proposez déjà une estimation en ligne, mais le visiteur ` +
      `n’y voit à aucun moment sa propre toiture.${reclame}`;
  }
  if (insp.niveau === 3 && site) {
    return `J’ai regardé votre simulateur sur ${site} : il place bien le visiteur sur une carte, ` +
      `mais s’arrête avant le calepinage — il ne voit pas ses panneaux posés sur son toit.`;
  }
  if (insp.niveau === 0 && site) {
    return `En regardant ${site}, j’ai vu que vos visiteurs peuvent demander un devis, ` +
      `mais pas visualiser leur toiture équipée avant de le faire.`;
  }
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

// Nom, e-mail et téléphone : tous les formulaires les demandent, les citer ne
// prouve rien. C'est la facture, la surface ou le budget réclamés d'entrée qui
// font mouche — on les fait donc remonter avant de tronquer la liste.
const CHAMPS_BANALS = ['nom', 'e-mail', 'téléphone'];

function champsParlants(donnees, max = 3) {
  const l = (donnees || []).filter(Boolean);
  return l.slice()
    .sort((a, b) => (CHAMPS_BANALS.includes(a) ? 1 : 0) - (CHAMPS_BANALS.includes(b) ? 1 : 0))
    .slice(0, max);
}

/** « a, b et c » — une énumération qui se lit, pas une liste à virgules. */
function listeFr(items) {
  const l = (items || []).filter(Boolean);
  if (l.length <= 1) return l[0] || '';
  return l.slice(0, -1).join(', ') + ' et ' + l[l.length - 1];
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

Nous éditons un simulateur photovoltaïque que vous posez sur votre site, à votre marque : le visiteur saisit son adresse, voit la photo aérienne réelle de son toit, y place vos panneaux, et découvre sa production et ses économies. Quand il demande un devis, vous recevez ses coordonnées avec tout le projet — adresse, nombre de panneaux, kWc, production estimée, offre choisie.

Concrètement, vos commerciaux arrêtent de rappeler à l’aveugle, et les toitures trop petites ou mal orientées ne vous coûtent plus un déplacement.

Les photos aériennes sont celles de l’IGN, à 20 cm de résolution, partout en France ; la production estimée tient dans les 10 % de l’écart avec PVGIS sur une toiture sans ombrage proche.

L’installation tient en ${OFFRE.lignesCode}, et nous configurons vos offres pour vous. La formule Découverte est gratuite sans limite de durée, ${OFFRE.leadsGratuits} leads par mois inclus ; au-delà, ${OFFRE.prixEntree} en illimité, sans engagement.

Est-ce que ça vaut un échange de dix minutes ?`
    },
    {
      objet: () => `Un simulateur solaire à votre marque, en ligne cet après-midi`,
      corps: (p) => `${civilite(p)}

${accroche(p)}

Le principe : un simulateur photovoltaïque à vos couleurs, posé sur votre site en ${OFFRE.lignesCode}. Comptez ${OFFRE.miseEnLigne} de mise en ligne — votre webmaster colle le bout de code, c’est tout. Votre visiteur dessine sa toiture sur la vraie photo aérienne, choisit parmi VOS offres, et découvre sa production. Sa demande de devis vous arrive avec le projet complet.

Vous gardez tout : vos leads partent directement dans votre CRM, aucune coordonnée ne transite chez nous, aucune commission sur ce que vous signez — et les leads déjà générés restent les vôtres, y compris si vous arrêtez.

Vous commencez gratuitement : ${OFFRE.leadsGratuits} leads par mois, sans limite de durée et sans carte bancaire. Nous configurons votre catalogue sous 24 h. Ensuite, ${OFFRE.prixEntree} en illimité, sans engagement.

Un créneau cette semaine pour en parler ?`
    },
    {
      objet: (p) => `Question rapide sur vos demandes de devis${p.ville ? ' — ' + p.ville : ''}`,
      corps: (p) => `${civilite(p)}

${accroche(p)}

La question que je me pose : sur dix demandes de devis reçues par votre site, combien débouchent sur une visite technique utile ?

Notre simulateur déplace ce tri en amont. Le visiteur passe deux minutes à dessiner son toit sur la photo aérienne et à choisir parmi vos offres ; vous recevez sa demande avec la surface, l’orientation, le nombre de panneaux et la production estimée. Les toitures inexploitables ne remontent plus, et le premier appel sert enfin à vendre plutôt qu’à qualifier.

C’est à votre marque, avec vos prix. Gratuit jusqu’à ${OFFRE.leadsGratuits} leads par mois, sans limite de durée ; ${OFFRE.prixEntree} en illimité, sans engagement.

Dix minutes au téléphone pour vous montrer ?`
    }
  ],

  relance1: [
    {
      objet: () => `Re : votre simulateur solaire`,
      corps: (p) => `${civilite(p)}

Je me permets de revenir vers vous — mon message précédent est peut-être passé au mauvais moment.

Le plus simple est sans doute de le voir tourner plutôt que d’en parler : la démonstration est publique, sans inscription ni e-mail à laisser.

${lienDemo()}

Si le sujet n’est pas d’actualité, dites-le-moi d’un mot, je n’insisterai pas.`
    },
    {
      objet: (p) => `${p.nom ? p.nom + ' — ' : ''}la démo, en accès libre`,
      corps: (p) => `${civilite(p)}

Un mot de suivi sur le simulateur photovoltaïque en marque blanche dont je vous parlais.

Plutôt qu’un argumentaire : dessinez un toit, ouvrez la vue 3D, regardez ce que reçoit le commercial à la fin. Deux minutes suffisent.

${lienDemo()}

Pour situer, puisque la question vient toujours : gratuit jusqu’à ${OFFRE.leadsGratuits} leads par mois, puis ${OFFRE.prixEntree} en illimité, sans engagement. À comparer aux 45 à 150 € que coûte aujourd’hui un lead exclusif acheté — sauf que ceux-là sont les vôtres.

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

const MOIS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const JOURS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Date au format RFC 5322. Un message sans en-tête `Date` est suspect. */
function dateRfc5322(d) {
  const n = (v) => String(v).padStart(2, '0');
  return `${JOURS[d.getUTCDay()]}, ${n(d.getUTCDate())} ${MOIS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${n(d.getUTCHours())}:${n(d.getUTCMinutes())}:${n(d.getUTCSeconds())} +0000`;
}

const domaineEmetteur = (de) => String(de || EMETTEUR.email).split('@')[1] || 'localhost';

/**
 * Identifiant de message, déterministe à partir du prospect et de l'étape :
 * rejouer la commande ne fabrique pas un nouvel identifiant pour le même
 * message, ce qui éviterait les doublons chez le destinataire.
 */
function messageId(message, de) {
  let h = 0;
  for (const c of [message.siren, message.etape, message.destinataire].join('|')) {
    h = (h * 31 + c.charCodeAt(0)) % 0xffffffff;
  }
  return '<hermes-' + h.toString(36) + '-' + message.etape + '@' + domaineEmetteur(de) + '>';
}

/**
 * Assemblage du message.
 *
 * Les en-têtes ne sont pas de la décoration : `Date`, `Message-ID` et
 * `Reply-To` sont attendus de tout expéditeur légitime, et `List-Unsubscribe`
 * est lu par Gmail comme un signal favorable — il affiche son propre bouton de
 * désinscription au lieu de proposer « signaler comme spam ».
 *
 * À l'inverse, les en-têtes maison `X-Hermes-*` qui figuraient ici signaient un
 * envoi automatisé en masse : ils ont été retirés.
 */
function versEml(message, de, maintenant) {
  const corps = Buffer.from(message.corps, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const expediteur = de || EMETTEUR.email;
  return [
    'Date: ' + dateRfc5322(maintenant || new Date()),
    'From: ' + expediteur,
    'To: ' + message.destinataire,
    'Reply-To: ' + expediteur,
    'Subject: ' + encoderEntete(message.objet),
    'Message-ID: ' + messageId(message, expediteur),
    'List-Unsubscribe: <mailto:' + expediteur + '?subject=STOP>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
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
  EMETTEUR, OFFRE, MODELES, rediger, accroche, choisirVariante, pied, lienDemo, listeFr, champsParlants,
  versEml, versCsv, encoderEntete, nomFichier, domaineLisible,
  dateRfc5322, messageId, run
};
