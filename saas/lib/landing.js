/**
 * Pages hébergées avec référencement local.
 *
 * L'intérêt pour l'installateur : une page par ville d'intervention, qui
 * répond à une requête que ses clients tapent réellement (« panneaux solaires
 * Louviers »), et qui porte le simulateur. Une page utile plutôt qu'une page
 * satellite : contenu propre à la ville, maillage entre les villes, données
 * structurées correctes.
 */
'use strict';

const { echapper } = require('./http.js');

function ldJson(objet) {
  // </script> dans une donnée client terminerait le bloc : on neutralise.
  return JSON.stringify(objet).replace(/</g, '\\u003c');
}

function pageLocale({ client, catalogue, page, autresPages, base }) {
  const marque = catalogue.brand || {};
  const nom = marque.name || client.nom;
  const ville = page.ville || '';
  const dept = page.departement || '';
  const url = base + '/p/' + page.slug;
  const contenu = page.contenu || {};

  const titre = page.titre ||
    ('Panneaux solaires à ' + ville + ' — simulateur gratuit | ' + nom);
  const description = page.description ||
    ('Simulez gratuitement votre installation photovoltaïque à ' + ville +
     ' : production, économies, TVA 5,5 % et retour sur investissement, calculés sur la photo ' +
     'aérienne réelle de votre toit. Devis sans engagement par ' + nom + '.');

  const villesLiees = (autresPages || []).filter((p) => p.slug !== page.slug).slice(0, 12);

  const entreprise = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    '@id': url + '#entreprise',
    name: nom,
    description: 'Installateur photovoltaïque' + (ville ? ' à ' + ville : ''),
    url: url,
    telephone: marque.phone || undefined,
    email: marque.contactEmail || undefined,
    image: marque.logoUrl || undefined,
    areaServed: [ville, dept].filter(Boolean).map((n) => ({ '@type': 'Place', name: n })),
    address: ville ? {
      '@type': 'PostalAddress', addressLocality: ville,
      addressRegion: dept || undefined, addressCountry: 'FR'
    } : undefined,
    makesOffer: {
      '@type': 'Offer',
      itemOffered: { '@type': 'Service', name: 'Installation de panneaux photovoltaïques', areaServed: ville }
    }
  };

  const faqs = (contenu.faq && contenu.faq.length ? contenu.faq : faqParDefaut(ville, nom));
  const faq = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({
      '@type': 'Question', name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.r }
    }))
  };

  const fil = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: nom, item: base + '/p/' + (autresPages[0] ? autresPages[0].slug : page.slug) },
      { '@type': 'ListItem', position: 2, name: ville || 'Simulateur', item: url }
    ]
  };

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${echapper(titre.slice(0, 65))}</title>
<meta name="description" content="${echapper(description.slice(0, 158))}">
<link rel="canonical" href="${echapper(url)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${echapper(titre)}">
<meta property="og:description" content="${echapper(description)}">
<meta property="og:url" content="${echapper(url)}">
<meta property="og:locale" content="fr_FR">
<meta property="og:site_name" content="${echapper(nom)}">
${contenu.ogImage ? `<meta property="og:image" content="${echapper(contenu.ogImage)}">` : ''}
<meta name="twitter:card" content="${contenu.ogImage ? 'summary_large_image' : 'summary'}">
<script type="application/ld+json">${ldJson(entreprise)}</script>
<script type="application/ld+json">${ldJson(faq)}</script>
<script type="application/ld+json">${ldJson(fil)}</script>
<style>
:root{--nav:#0f2a43;--acc:#f59e0b;--ink:#16202b;--ink2:#51606f;--line:#e3e8ee;--bg:#f6f8fa}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:system-ui,Segoe UI,Arial,sans-serif;color:var(--ink);background:#fff;line-height:1.55}
header{background:var(--nav);color:#fff;padding:16px 20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
header img{height:38px;width:auto;max-width:170px;object-fit:contain}
header .n{font-weight:800;font-size:18px}
header a.tel{margin-left:auto;background:#fff;color:var(--nav);padding:9px 15px;border-radius:9px;
  text-decoration:none;font-weight:800;white-space:nowrap}
main{max-width:1180px;margin:0 auto;padding:22px 16px 40px}
h1{font-size:27px;color:var(--nav);margin:6px 0 10px;line-height:1.25}
h2{font-size:20px;color:var(--nav);margin:30px 0 10px}
h3{font-size:16px;margin:18px 0 6px}
p{color:var(--ink2);margin:0 0 12px}
.chapo{font-size:17px;color:var(--ink)}
.grille{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:16px 0}
.carte{border:1px solid var(--line);border-radius:12px;padding:15px;background:var(--bg)}
.carte b{display:block;color:var(--nav);margin-bottom:5px}
.faq{border-top:1px solid var(--line);padding:13px 0}
.faq b{display:block;color:var(--nav);margin-bottom:5px}
.villes{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
.villes a{background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:6px 13px;
  font-size:13.5px;color:var(--nav);text-decoration:none}
.villes a:hover{background:#fff;border-color:var(--acc)}
footer{background:var(--bg);border-top:1px solid var(--line);padding:20px;color:var(--ink2);font-size:13px}
footer a{color:var(--ink2)}
#sim{margin:18px 0}
</style>
</head>
<body>
<header>
  ${marque.logoUrl ? `<img src="${echapper(marque.logoUrl)}" alt="${echapper(nom)}">` : ''}
  <span class="n">${echapper(nom)}</span>
  ${marque.phone ? `<a class="tel" href="tel:${echapper(String(marque.phone).replace(/[^+\d]/g, ''))}">📞 ${echapper(marque.phone)}</a>` : ''}
</header>
<main>
  <h1>Panneaux solaires à ${echapper(ville)} : simulez votre installation en 2 minutes</h1>
  <p class="chapo">${echapper(contenu.chapo || ('Combien produirait votre toit à ' + ville + ' ? Dessinez-le sur la photo aérienne, ' +
    'le simulateur place les panneaux, calcule votre production, vos économies et le taux de TVA auquel vous avez droit. ' +
    'Gratuit, sans inscription et sans engagement.'))}</p>

  <div id="evasimu-${echapper(client.cle)}"></div>
  <script src="${echapper(base)}/w/${echapper(client.cle)}.js" async></script>

  <h2>Pourquoi le solaire à ${echapper(ville)}${dept ? ' (' + echapper(dept) + ')' : ''}</h2>
  <p>${echapper(contenu.pourquoi || ('Depuis l’arrêté tarifaire de juin 2026, le surplus n’est plus racheté que ' +
    '1,1 c€/kWh : la rentabilité d’une installation vient désormais de l’électricité que vous consommez vous-même, ' +
    'pas de la revente. Le dimensionnement compte donc plus que jamais — c’est exactement ce que calcule le simulateur ' +
    'ci-dessus, sur votre toit et votre consommation réelle.'))}</p>

  <div class="grille">
    <div class="carte"><b>TVA à 5,5 %</b>Pour une installation de 9 kWc ou moins sur un logement, posée par une
      entreprise RGE et pilotée par un gestionnaire d’énergie. Le simulateur vérifie les cinq conditions.</div>
    <div class="carte"><b>Sur votre vrai toit</b>Orthophoto IGN à 20 cm, pans dessinés un par un, ombres du
      voisinage prises en compte.</div>
    <div class="carte"><b>Chiffres datés</b>Barème réglementaire et prix du kWh à jour, mentionnés dans l’étude
      que vous pouvez imprimer.</div>
    <div class="carte"><b>${echapper(nom)}</b>${echapper(marque.rgeMention || 'Installateur local, devis gratuit et sans engagement.')}</div>
  </div>

  <h2>Questions fréquentes</h2>
  ${faqs.map((f) => `<div class="faq"><b>${echapper(f.q)}</b><p>${echapper(f.r)}</p></div>`).join('\n  ')}

  ${villesLiees.length ? `<h2>Nous intervenons aussi à</h2>
  <div class="villes">${villesLiees.map((p) =>
    `<a href="${echapper(base)}/p/${echapper(p.slug)}">${echapper(p.ville || p.slug)}</a>`).join('')}</div>` : ''}
</main>
<footer>
  <b>${echapper(nom)}</b>${marque.phone ? ' — ' + echapper(marque.phone) : ''}${marque.contactEmail ? ' — ' + echapper(marque.contactEmail) : ''}<br>
  Simulation indicative et non contractuelle. Fond de carte : orthophotos © IGN.
  ${marque.politiqueConfidentialiteUrl ? ` — <a href="${echapper(marque.politiqueConfidentialiteUrl)}">Politique de confidentialité</a>` : ''}
</footer>
</body>
</html>`;
}

function faqParDefaut(ville, nom) {
  return [
    {
      q: 'Combien coûte une installation photovoltaïque à ' + ville + ' ?',
      r: 'Pour une maison, comptez généralement entre 8 000 et 15 000 € TTC selon la puissance, ' +
        'le type de panneaux et la présence d’une batterie. Le simulateur affiche le prix exact ' +
        'de nos offres pour votre toit, TVA comprise au taux auquel vous avez droit.'
    },
    {
      q: 'Ai-je droit à la TVA à 5,5 % ?',
      r: 'Oui si les cinq conditions sont réunies : puissance inférieure ou égale à 9 kWc, ' +
        'logement d’habitation, pose par une entreprise RGE, modules à bilan carbone conforme, ' +
        'et gestionnaire d’énergie pilotant au moins deux usages. Le simulateur les vérifie une par une.'
    },
    {
      q: 'La prime à l’autoconsommation existe-t-elle encore ?',
      r: 'Non. Elle est supprimée pour toute demande de raccordement déposée depuis le 4 juin 2026. ' +
        'La rentabilité repose désormais sur l’électricité autoconsommée et sur la TVA réduite.'
    },
    {
      q: 'Combien de temps prennent les démarches ?',
      r: 'Comptez deux à quatre mois entre la déclaration préalable en mairie, la demande de ' +
        'raccordement, la pose, l’attestation Consuel et la mise en service. ' + nom +
        ' s’occupe de l’ensemble des démarches.'
    }
  ];
}

/* ---------- sitemap et robots ---------- */

function sitemap(base, entrees) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    entrees.map((e) =>
      '  <url><loc>' + echapper(base + e.chemin) + '</loc>' +
      (e.maj ? '<lastmod>' + e.maj.slice(0, 10) + '</lastmod>' : '') +
      '<changefreq>monthly</changefreq></url>').join('\n') +
    '\n</urlset>\n';
}

function robots(base) {
  return 'User-agent: *\n' +
    'Allow: /p/\n' +
    'Allow: /s/\n' +
    'Disallow: /console\n' +
    'Disallow: /api/\n' +
    'Disallow: /w/\n' +
    'Sitemap: ' + base + '/sitemap.xml\n';
}

module.exports = { pageLocale, faqParDefaut, sitemap, robots };
