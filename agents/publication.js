/*!
 * Hermès — Agent de publication réseaux sociaux
 *
 * Produit un calendrier de publications prêtes à poster, à partir de faits
 * réels sur le produit. Aucun chiffre inventé : tout ce qui est affirmé ici
 * est vérifiable dans le dépôt (résolution IGN, écart PVGIS, gratuité des
 * sources, délai d'installation).
 *
 * L'agent ne publie pas lui-même, et c'est délibéré :
 *   - LinkedIn interdit l'automatisation par ses CGU, et restreint vite les
 *     comptes qui s'y risquent. Publier sur une **page** via l'API officielle
 *     est en revanche parfaitement admis — mais demande un jeton par réseau ;
 *   - une publication est publique et irrattrapable : elle mérite une relecture.
 *
 * Sortie : un JSON exploitable par un outil de programmation (Buffer, Metricool,
 * n8n…) et un Markdown lisible pour relire le calendrier d'un coup d'œil.
 *
 * Usage :
 *   node agents/publication.js --semaines 4 --debut 2026-09-01 --sortie data/posts
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ===================== Faits vérifiables ===================== */

const FAITS = {
  resolution: '20 cm',
  ecartPvgis: '± 10 %',
  delaiPose: '3 lignes de HTML',
  sources: 'orthophotos IGN et Base Adresse Nationale, gratuites et sans clé API',
  essai: '30 jours sans carte bancaire',
  prixEntree: '89 € HT par mois'
};

/* ===================== Angles éditoriaux ===================== */

// Un calendrier qui ne fait que vendre lasse en trois semaines. On alterne
// quatre registres : utile, démonstratif, métier, puis offre.
const ANGLES = [
  {
    cle: 'pedagogie',
    titre: 'Pédagogie métier',
    reseau: 'linkedin',
    sujets: [
      {
        accroche: 'Pourquoi un devis solaire sur deux ne débouche sur rien',
        corps: `Le visiteur remplit un formulaire. Vous rappelez. Vous découvrez au téléphone la surface du toit, son orientation, la consommation, le budget.

Autrement dit : la qualification commence après le lead, et elle est payée par votre temps commercial.

Le tri peut se faire avant. Quand le particulier a lui-même dessiné sa toiture et choisi ses équipements, la demande qui arrive porte déjà la surface, l’orientation, la puissance et la production estimée.

Ce n’est pas plus de leads. C’est le même nombre, exploitables.`,
        mots: ['photovoltaïque', 'installateur', 'leads']
      },
      {
        accroche: 'La visite technique qui ne donnera jamais de chantier',
        corps: `Toiture trop petite. Mal orientée. Ombragée par le bâtiment d’à côté.

On le découvre sur place, après le déplacement, après le temps passé.

Une partie de ces cas est visible avant : la surface exploitable, l’orientation réelle et les masques proches se lisent sur une photo aérienne et un modèle d’ombrage.

Faire ce filtre en amont ne remplace pas la visite technique. Ça évite celles qui n’avaient aucune chance.`,
        mots: ['photovoltaïque', 'terrain', 'rentabilité']
      },
      {
        accroche: 'Ce que coûte vraiment un lead non qualifié',
        corps: `Un rappel de vingt minutes. Une relance. Parfois un déplacement.

Rapporté au taux de transformation réel, chaque demande de devis vague coûte plus cher que la publicité qui l’a générée.

L’enjeu n’est donc pas d’acheter plus de leads, mais de faire remonter davantage d’informations avec ceux qu’on a déjà.`,
        mots: ['photovoltaïque', 'commercial', 'PME']
      }
    ]
  },
  {
    cle: 'demonstration',
    titre: 'Démonstration produit',
    reseau: 'linkedin',
    sujets: [
      {
        accroche: `Votre client voit son propre toit, en ${FAITS.resolution}`,
        corps: `Pas une maison générique. La sienne.

Les orthophotos de l’IGN couvrent toute la France en ${FAITS.resolution} de résolution, gratuitement et sans clé API. Le visiteur saisit son adresse, reconnaît son jardin et sa rue, et dessine sa toiture au doigt.

À partir de là, les panneaux se posent automatiquement — aux dimensions réelles de votre catalogue, pas à des dimensions moyennes.

Un particulier qui a vu son toit équipé ne compare plus trois devis de la même façon.`,
        mots: ['photovoltaïque', 'IGN', 'simulateur']
      },
      {
        accroche: 'L’ombre de la cheminée sur les panneaux, heure par heure',
        corps: `La vue 3D reconstruit le bâtiment en volume, avec ses panneaux inclinés et ses obstacles, et positionne le soleil astronomiquement.

Le client voit l’ombre de sa cheminée balayer les modules — en juin comme au 21 décembre.

C’est ce moment-là qui fait basculer une décision, bien plus qu’un tableau de production annuelle.`,
        mots: ['photovoltaïque', '3D', 'ombrage']
      },
      {
        accroche: `Précision : ${FAITS.ecartPvgis} par rapport à PVGIS`,
        corps: `PVGIS est la référence de la Commission européenne. Sur une toiture sans ombrage proche, notre moteur en reste à ${FAITS.ecartPvgis}.

Les résultats sont affichés au visiteur comme indicatifs et non contractuels — parce qu’ils le sont, et parce qu’un simulateur qui promet le contraire vous expose.

Pour aller plus loin, le simulateur peut interroger PVGIS directement.`,
        mots: ['photovoltaïque', 'PVGIS', 'production']
      }
    ]
  },
  {
    cle: 'coulisses',
    titre: 'Coulisses et preuve',
    reseau: 'linkedin',
    sujets: [
      {
        accroche: 'On l’utilise nous-mêmes avant de le vendre',
        corps: `RDF-SOLAR édite le simulateur. RDF ENERGIE, notre entreprise d’installation, l’utilise sur son site.

L’outil est né du besoin de nos propres commerciaux : arrêter de rappeler à l’aveugle. Il a été proposé à d’autres installateurs seulement après.

Nous ne publions pas de témoignages : le produit vient d’ouvrir à des clients extérieurs. La démonstration est publique, jugez sur pièces.`,
        mots: ['photovoltaïque', 'produit']
      },
      {
        accroche: 'Vos leads ne passent pas chez nous. Jamais.',
        corps: `Le simulateur s’exécute dans le navigateur de votre visiteur et envoie la demande directement vers votre CRM ou votre boîte mail.

Aucune coordonnée ne transite par nos serveurs. Nous n’en gardons aucune copie et ne revendons rien.

Ce n’est pas une promesse commerciale : c’est une conséquence de l’architecture. Il n’y a pas de serveur chez nous par lequel ça pourrait passer.`,
        mots: ['photovoltaïque', 'RGPD', 'données']
      }
    ]
  },
  {
    cle: 'offre',
    titre: 'Offre',
    reseau: 'linkedin',
    sujets: [
      {
        accroche: `En ligne sur votre site en ${FAITS.delaiPose}`,
        corps: `Vous nous décrivez votre catalogue : dix minutes au téléphone.
Nous configurons votre simulateur : sous 24 h.
Vous collez ${FAITS.delaiPose} : cinq minutes, et c’est en ligne.

WordPress, Wix, Squarespace ou site sur mesure. Aucun plugin, aucun serveur à toucher.

Essai ${FAITS.essai}, puis à partir de ${FAITS.prixEntree}.`,
        mots: ['photovoltaïque', 'installateur', 'SaaS']
      },
      {
        accroche: `${FAITS.essai} — et vos leads restent les vôtres`,
        corps: `Pas de version bridée, pas de jeu de données factice : nous configurons votre catalogue réel et vous l’installez sur votre vrai site.

Vous jugez sur les demandes qui tombent, pas sur une brochure.

Les leads générés pendant l’essai sont à vous sans condition — y compris si vous vous arrêtez là.`,
        mots: ['photovoltaïque', 'essai', 'installateur']
      }
    ]
  }
];

/* ===================== Génération du calendrier ===================== */

const JOURS_PUBLICATION = [2, 4];   // mardi et jeudi : les meilleurs jours B2B

function motsDiese(mots) {
  return mots.map((m) => '#' + m
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')).join(' ');
}

/**
 * Alterne les angles pour qu'aucun ne se répète deux fois de suite, et
 * n'utilise jamais deux fois le même sujet tant que le stock n'est pas épuisé.
 */
function calendrier({ semaines = 4, debut = new Date(), lien = 'https://www.rdf-solar.fr' } = {}) {
  const disponibles = ANGLES.map((a) => ({ angle: a, restants: [...a.sujets] }));
  const posts = [];
  const d0 = new Date(debut);
  let iAngle = 0;

  for (let s = 0; s < semaines; s++) {
    for (const jour of JOURS_PUBLICATION) {
      // On cherche le prochain angle qui a encore un sujet en réserve
      let essais = 0;
      while (!disponibles[iAngle % disponibles.length].restants.length && essais < disponibles.length) {
        iAngle++; essais++;
      }
      const bloc = disponibles[iAngle % disponibles.length];
      if (!bloc.restants.length) return posts;   // stock épuisé : on s'arrête plutôt que de répéter
      const sujet = bloc.restants.shift();
      iAngle++;

      const date = new Date(d0);
      date.setDate(d0.getDate() + s * 7 + ((jour - d0.getDay() + 7) % 7));

      posts.push({
        date: date.toISOString().slice(0, 10),
        reseau: bloc.angle.reseau,
        angle: bloc.angle.cle,
        angleLibelle: bloc.angle.titre,
        accroche: sujet.accroche,
        texte: `${sujet.accroche}\n\n${sujet.corps}\n\n👉 ${lien}\n\n${motsDiese(sujet.mots)}`,
        caracteres: (`${sujet.accroche}\n\n${sujet.corps}`).length,
        statut: 'à relire'
      });
    }
  }
  return posts;
}

/* ===================== Exports ===================== */

function versMarkdown(posts) {
  const lignes = ['# Calendrier de publication — Hermès', '',
    'Relisez chaque texte avant publication. Rien n’est posté automatiquement.', ''];
  let semaine = null;
  for (const p of posts) {
    const s = p.date.slice(0, 7);
    if (s !== semaine) { lignes.push(`## ${s}`, ''); semaine = s; }
    lignes.push(`### ${p.date} · ${p.reseau} · ${p.angleLibelle}`, '', '```', p.texte, '```', '');
  }
  return lignes.join('\n');
}

function run(opts = {}) {
  const log = (...a) => { if (!process.env.HERMES_SILENCE) console.log(...a); };
  const posts = calendrier({
    semaines: Number(opts.semaines) || 4,
    debut: opts.debut ? new Date(opts.debut) : new Date(),
    lien: opts.lien || 'https://www.rdf-solar.fr'
  });
  const base = opts.sortie || 'data/posts';
  const dossier = path.dirname(base);
  if (dossier && dossier !== '.') fs.mkdirSync(dossier, { recursive: true });
  fs.writeFileSync(base + '.json', JSON.stringify(posts, null, 2), 'utf8');
  fs.writeFileSync(base + '.md', versMarkdown(posts), 'utf8');

  const parAngle = posts.reduce((a, p) => (a[p.angleLibelle] = (a[p.angleLibelle] || 0) + 1, a), {});
  log(`✓ ${posts.length} publication(s) → ${base}.json et ${base}.md`);
  log('  ' + Object.entries(parAngle).map(([k, n]) => n + ' × ' + k).join(' · '));
  log('  À relire avant publication : rien n’est posté automatiquement.');
  return posts;
}

if (require.main === module) {
  const o = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const c = argv[i].slice(2);
    o[c] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  run(o);
}

module.exports = { ANGLES, FAITS, calendrier, versMarkdown, motsDiese, run };
