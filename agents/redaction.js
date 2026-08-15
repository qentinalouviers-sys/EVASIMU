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
// `evasimu.fr`, utilisé ici auparavant, n'a ni enregistrement A ni MX.
const EMETTEUR = {
  societe: 'EVASIMU',
  entite: 'Tekotek',                         // entité derrière la marque
  email: process.env.HERMES_EMAIL || 'contact@eviatek.fr',
  telephone: '+33 6 14 74 69 75',
  // La page de vente publique, déployée par la CI sur GitHub Pages.
  site: process.env.HERMES_SITE || 'https://qentinalouviers-sys.github.io/EVASIMU/',
  adresse: '20 rue Maréchal Foch, 27400 Louviers',
  // Le simulateur lui-même, en accès libre. C'est ce lien que citent les
  // relances : « voyez-le tourner » vaut mieux qu'un argumentaire, mais
  // seulement si la page existe vraiment.
  demo: process.env.HERMES_DEMO || 'https://qentinalouviers-sys.github.io/EVASIMU/demo.html'
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

/*
 * Suivi des messages. Le module vit côté SaaS parce que c'est lui qui vérifie
 * les jetons : une deuxième implémentation ici finirait par diverger, et un
 * jeton signé d'un côté que l'autre refuse est un lien mort.
 *
 * Le pixel d'ouverture est FERMÉ PAR DÉFAUT (EVASIMU_SUIVI_PIXEL=1 pour l'ouvrir).
 * Apple Mail Privacy Protection précharge les images de tous les messages :
 * chez ces destinataires, l'ouverture mesurée est fausse. Gmail passe par son
 * proxy. Et un pixel émis par un domaine en cours de chauffe compte contre
 * nous auprès des filtres. Le clic, lui, est un fait.
 */
const SUIVI = require('../saas/lib/suivi.js');
const BASE_SUIVI = process.env.EVASIMU_URL || '';
const PIXEL_ACTIF = process.env.EVASIMU_SUIVI_PIXEL === '1';

/** Le lien mis dans les relances : la démo si elle existe, le site sinon. */
function lienDemo() {
  return EMETTEUR.demo || EMETTEUR.site;
}

/**
 * Le lien d'aperçu préparé pour ce prospect : son enseigne, une couleur
 * approchée de la sienne.
 *
 * C'est la seule chose du message qu'un envoi en masse ne peut pas produire.
 * Un destinataire qui clique voit son nom en haut d'un simulateur qui tourne —
 * plus aucun argumentaire n'est nécessaire.
 *
 * La couleur envoyée est `couleurApercu`, jamais `couleur` : l'inspection en
 * décale la teinte exprès. On ressemble, on ne copie pas, et le logo n'est
 * jamais repris — reprendre l'identité exacte d'une entreprise sans son accord
 * l'expose, et nous expose.
 */
function lienApercu(p, etape) {
  const insp = (p || {}).inspection || {};
  const enseigne = String(insp.enseigne || p.nom || '').trim();
  if (!enseigne) return '';

  // Lien suivi quand c'est possible : il faut le secret partagé ET la fiche
  // correspondante dans le CRM, sinon le clic n'aurait rien où se ranger. À
  // défaut, l'URL directe — mieux vaut un lien qui marche sans mesure qu'une
  // mesure qui casse le lien.
  const suivi = SUIVI.lien(BASE_SUIVI, p.saasId, etape || '', 'apercu');
  if (suivi) return suivi;

  const couleur = insp.couleurApercu || '';
  const q = ['e=' + encodeURIComponent(enseigne)];
  if (/^#[0-9a-fA-F]{6}$/.test(couleur)) q.push('c=' + encodeURIComponent(couleur));
  return lienDemo() + '?' + q.join('&');
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

  // Le nom exact de leur page, quand l'inspection a su le lire. « Votre page
  // “Estimation en ligne” » ne peut pas s'écrire sans avoir ouvert le site :
  // c'est le détail qui distingue une lecture d'un publipostage.
  const page = insp.libelle ? `votre page « ${insp.libelle} »` : `votre estimation en ligne`;

  if (insp.niveau >= 1 && insp.niveau <= 2 && site) {
    const reclame = (insp.donnees || []).length
      ? ` Il réclame ${listeFr(champsParlants(insp.donnees))} avant d’afficher le moindre résultat.` : '';
    return `J’ai regardé ${site}, et notamment ${page} : le visiteur y remplit un formulaire, ` +
      `mais il ne voit à aucun moment sa propre toiture.${reclame}`;
  }
  if (insp.niveau === 3 && site) {
    return `J’ai regardé votre simulateur sur ${site} : il place bien le visiteur sur une carte, ` +
      `mais s’arrête avant le calepinage — il ne voit pas ses panneaux posés sur son toit.`;
  }
  if (insp.niveau === 0 && site) {
    return `J’ai parcouru ${site} : vos visiteurs peuvent vous demander un devis, ` +
      `mais nulle part voir leur toiture équipée avant de le faire.`;
  }
  if (p.aSimulateur === false && p.siteWeb) {
    return `J’ai parcouru ${domaineLisible(p.siteWeb)} : vos visiteurs peuvent vous demander un devis, ` +
      `mais nulle part voir leur toiture équipée avant de le faire.`;
  }
  // Plus aucune observation de site : on ne fait pas semblant d'avoir regardé.
  // Ce qui reste vrai se dit à la première personne et sans emphase — mieux
  // vaut une phrase modeste qu'une accroche générique qui sonne le mailing.
  if (p.qualifPV) {
    return `Vous êtes qualifiés Quali’PV${p.ville ? ' à ' + p.ville : ''}, ` +
      `donc concernés par ce qui suit : ce que voient vos visiteurs avant de vous appeler.`;
  }
  if (p.ville) {
    return `Je m’adresse aux installateurs photovoltaïques ${surLaVille(p.ville)}, sur un point précis : ` +
      `ce que voit un visiteur de votre site avant de décider s’il vous appelle.`;
  }
  return `Je vous écris sur un point précis : ce que voit un visiteur de votre site ` +
    `avant de décider s’il vous appelle.`;
}

/** « à Vire », « au Havre », « aux Sables-d'Olonne » — l'article compte. */
function surLaVille(ville) {
  const v = String(ville || '').trim();
  if (/^Le /i.test(v)) return 'au ' + v.slice(3);
  if (/^Les /i.test(v)) return 'aux ' + v.slice(4);
  if (/^La /i.test(v)) return 'à ' + v;
  return 'à ' + v;
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
  /*
   * Les premiers messages tiennent en une centaine de mots.
   *
   * Un message long se lit comme une brochure, et une brochure se lit comme un
   * envoi en masse. Ce qui reste : ce que l'agent a VU sur leur site, ce que ça
   * leur coûte, le lien de l'aperçu préparé à leur nom, et une question. Les
   * preuves techniques (résolution IGN, écart PVGIS) sont passées en relance :
   * elles rassurent quelqu'un qui s'intéresse, elles alourdissent une première
   * approche.
   */
  premier: [
    {
      objet: (p) => `${p.nom ? p.nom + ' — ' : ''}votre simulateur, à vos couleurs`,
      corps: (p, etape) => `${civilite(p)}

${accroche(p)}

Je vous ai préparé un aperçu : le même simulateur, mais avec votre enseigne et une couleur proche de la vôtre. Le visiteur y saisit son adresse, voit la photo aérienne de son toit, y pose vos panneaux, et découvre sa production. Quand il demande un devis, vous recevez le projet entier — surface, orientation, nombre de panneaux, kWc, production, offre retenue.

${lienApercu(p, etape) || lienDemo()}

Aperçu approché : ni votre logo ni votre charte exacte, et vos vraies offres le remplaceraient.

${OFFRE.leadsGratuits} leads par mois gratuits sans limite de durée, puis ${OFFRE.prixEntree} en illimité — le prix de deux leads achetés.

Ça vaut dix minutes ?`
    },
    {
      objet: (p) => `Ce que voient vos visiteurs${p.ville ? ' à ' + p.ville : ''} avant de vous appeler`,
      corps: (p, etape) => `${civilite(p)}

${accroche(p)}

Le résultat, vous le connaissez mieux que moi : vos commerciaux rappellent sans savoir ce qu’il y a sur le toit, et se déplacent pour des toitures qui ne valaient pas le trajet.

J’ai monté un aperçu à votre nom, pour que vous jugiez sur pièce :

${lienApercu(p, etape) || lienDemo()}

Dessinez un toit, ouvrez la vue 3D, regardez la fiche qui arriverait à votre commercial. La couleur est approchée et le logo n’est pas repris : je ne me sers pas de votre identité sans votre accord.

Gratuit jusqu’à ${OFFRE.leadsGratuits} leads par mois, puis ${OFFRE.prixEntree} en illimité, sans engagement.

Un créneau cette semaine ?`
    },
    {
      objet: (p) => `Question sur vos demandes de devis${p.ville ? ' — ' + p.ville : ''}`,
      corps: (p, etape) => `${civilite(p)}

${accroche(p)}

Ma question tient en une ligne : sur dix demandes reçues par votre site, combien débouchent sur une visite technique utile ?

Le simulateur que j’édite déplace ce tri en amont. Le visiteur dessine sa toiture sur la photo aérienne et choisit parmi vos offres ; vous recevez la surface, l’orientation, le nombre de panneaux et la production estimée. Les toitures inexploitables ne remontent plus.

Voici l’aperçu que j’ai préparé pour vous — votre enseigne, une couleur approchée, aucun logo repris :

${lienApercu(p, etape) || lienDemo()}

${OFFRE.leadsGratuits} leads par mois gratuits sans limite de durée, ${OFFRE.prixEntree} en illimité ensuite.

Dix minutes au téléphone pour en parler ?`
    }
  ],

  relance1: [
    {
      objet: () => `Re : votre simulateur solaire`,
      corps: (p, etape) => `${civilite(p)}

Je me permets de revenir vers vous — mon message précédent est peut-être passé au mauvais moment.

Le plus simple est sans doute de le voir tourner plutôt que d’en parler : la démonstration est publique, sans inscription ni e-mail à laisser.

${lienDemo()}

Si le sujet n’est pas d’actualité, dites-le-moi d’un mot, je n’insisterai pas.`
    },
    {
      objet: (p) => `${p.nom ? p.nom + ' — ' : ''}la démo, en accès libre`,
      corps: (p, etape) => `${civilite(p)}

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
      corps: (p, etape) => `${civilite(p)}

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
  const corps = m.corps(prospect, etape);

  // Le bouton de la version HTML reprend le lien déjà présent dans le texte :
  // une URL nue pour qui lit en texte brut, un bouton pour les autres. Deux
  // destinations différentes seraient deux messages différents.
  const lienBouton = lienApercu(prospect, etape);
  const pixel = PIXEL_ACTIF ? SUIVI.lienPixel(BASE_SUIVI, prospect.saasId, etape) : '';

  return {
    destinataire: (prospect.emails || [])[0] || '',
    objet: m.objet(prospect),
    corps: corps + '\n' + pied(prospect),
    lienBouton,
    lienAffiche: lienBouton,
    libelleBouton: 'Voir mon simulateur',
    pixel,
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
const echapperHtml = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * La version HTML du message : le même texte, plus un bouton.
 *
 * Contraintes propres à l'e-mail, qui expliquent le HTML daté :
 *   - styles EN LIGNE uniquement ; la plupart des clients suppriment <style> ;
 *   - bouton en <table>, parce qu'Outlook ne sait pas mettre de padding sur
 *     un <a> — un bouton en <div> y devient un lien nu ;
 *   - aucune image distante autre que le pixel : chaque image bloquée par
 *     défaut est un trou dans la mise en page ;
 *   - une largeur maximale, pas une largeur fixe, pour le téléphone.
 *
 * Et surtout : la partie texte reste le message complet, lisible seul. Un
 * message dont la version texte est vide ou tronquée est un marqueur de
 * publipostage que les filtres connaissent bien.
 */
function versHtml(message) {
  const [corps, pied] = message.corps.split('\n--\n');
  const lien = message.lienBouton || '';
  const paragraphes = corps.trim().split(/\n{2,}/)
    // L'URL brute est retirée du HTML : elle y est remplacée par le bouton.
    // La laisser en double ferait de la version HTML un texte à trous.
    .filter((b) => !(lien && b.trim() === (message.lienAffiche || '')))
    .map((b) => `<p style="margin:0 0 14px">${echapperHtml(b.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('\n      ');

  const bouton = lien ? `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0">
        <tr><td align="center" bgcolor="#f59e0b" style="border-radius:8px">
          <a href="${echapperHtml(lien)}" style="display:inline-block;padding:14px 26px;font-family:Segoe UI,system-ui,Arial,sans-serif;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px">
            ${echapperHtml(message.libelleBouton || 'Voir mon aperçu')}
          </a>
        </td></tr>
      </table>` : '';

  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f8">
  <div style="max-width:600px;margin:0 auto;padding:24px 20px;font-family:Segoe UI,system-ui,-apple-system,Arial,sans-serif;font-size:15px;line-height:1.55;color:#16202b;background:#ffffff">
      ${paragraphes}${bouton}
    <div style="margin-top:26px;padding-top:14px;border-top:1px solid #e3e8ee;font-size:12px;line-height:1.6;color:#8a97a5">
      ${echapperHtml(String(pied || '').trim()).replace(/\n/g, '<br>')}
    </div>
  </div>${message.pixel ? `<img src="${echapperHtml(message.pixel)}" width="1" height="1" alt="" style="display:block;border:0">` : ''}
</body></html>`;
}

const b64mime = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');

function versEml(message, de, maintenant) {
  const expediteur = de || EMETTEUR.email;
  const entetes = [
    'Date: ' + dateRfc5322(maintenant || new Date()),
    'From: ' + expediteur,
    'To: ' + message.destinataire,
    'Reply-To: ' + expediteur,
    'Subject: ' + encoderEntete(message.objet),
    'Message-ID: ' + messageId(message, expediteur),
    'List-Unsubscribe: <mailto:' + expediteur + '?subject=STOP>',
    'MIME-Version: 1.0'
  ];

  // Sans bouton ni pixel, la version HTML n'apporte rien : on reste en texte
  // seul, qui passe mieux les filtres qu'un HTML sans raison d'être.
  if (!message.lienBouton && !message.pixel) {
    return entetes.concat([
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64mime(message.corps)
    ]).join('\r\n');
  }

  // multipart/alternative : le texte D'ABORD. L'ordre n'est pas décoratif —
  // la norme veut la version la moins riche en premier, et un client qui lit
  // la dernière partie qu'il comprend afficherait sinon le texte brut.
  const f = 'evasimu' + messageId(message, expediteur).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
  return entetes.concat([
    'Content-Type: multipart/alternative; boundary="' + f + '"',
    '',
    '--' + f,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64mime(message.corps),
    '--' + f,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64mime(versHtml(message)),
    '--' + f + '--',
    ''
  ]).join('\r\n');
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
  EMETTEUR, OFFRE, MODELES, rediger, accroche, choisirVariante, pied, lienDemo, lienApercu, listeFr, champsParlants, versHtml,
  versEml, versCsv, encoderEntete, nomFichier, domaineLisible,
  dateRfc5322, messageId, run
};
