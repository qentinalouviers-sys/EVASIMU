/**
 * Diffusion du widget : script d'intégration, page iframe, extraits prêts à
 * coller, et page de partage optimisée pour les réseaux sociaux.
 *
 * Le principe : un client ne colle jamais que DEUX lignes sur son site. Tout
 * le reste (thème, catalogue, activation) est piloté côté serveur, donc
 * modifiable sans qu'il ait à retoucher quoi que ce soit.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { echapper } = require('./http.js');
const clients = require('./clients.js');

const RACINE = path.join(__dirname, '..', '..');
const lire = (f) => fs.readFileSync(path.join(RACINE, f), 'utf8');

// Sources du simulateur, chargées une fois et servies concaténées : une seule
// requête pour le visiteur, et rien à déployer chez le client.
let BUNDLE = null;

// Une source inlinée dans <script> ne doit jamais contenir « </script » : la
// balise se fermerait au milieu du code et le reste s'afficherait en clair.
// Même chose pour « </style » dans une feuille inlinée.
const jsSur = (src) => src.replace(/<\/script/gi, '<\\/script');
const cssSur = (src) => src.replace(/<\/style/gi, '<\\/style');

// JSON destiné à un bloc <script> : on neutralise « < », ce qui couvre à la
// fois « </script> » et toute tentative d'injection via une valeur saisie par
// un client (nom de marque, accroche…).
const jsonSur = (o) => JSON.stringify(o).replace(/</g, '\\u003c');

function bundle() {
  if (!BUNDLE) {
    BUNDLE = {
      css: cssSur(lire('vendor/leaflet/leaflet.css') + '\n' + lire('src/evasimu-sim.css')),
      js: jsSur([
        lire('vendor/leaflet/leaflet.js'),
        lire('vendor/three/three.min.js'),
        lire('vendor/three/OrbitControls.js'),
        lire('src/evasimu-engine.js'),
        lire('src/evasimu-3d.js'),
        lire('src/evasimu-sim.js')
      ].join('\n;\n'))
    };
  }
  return BUNDLE;
}

/* ---------- Script d'intégration ---------- */

/**
 * Le script posé sur le site du client. Il crée une iframe, l'ajuste à la
 * hauteur réelle du contenu (postMessage), et ne casse rien si le widget est
 * désactivé : dans ce cas la page reste simplement sans simulateur.
 */
function scriptIntegration(base, cle) {
  const url = base + '/w/' + cle;
  return `(function(){
  var SRC = ${JSON.stringify(url)};
  var script = document.currentScript;
  function monter(){
    var hote = document.getElementById('evasimu-' + ${JSON.stringify(cle)}) ||
      (script && script.parentNode) || document.body;
    if (hote.querySelector && hote.querySelector('iframe[data-evasimu]')) return;
    var f = document.createElement('iframe');
    f.setAttribute('data-evasimu', ${JSON.stringify(cle)});
    f.src = SRC + '?h=' + encodeURIComponent(location.host);
    f.title = 'Simulateur photovoltaïque';
    f.loading = 'lazy';
    f.allow = 'geolocation';
    f.style.cssText = 'width:100%;border:0;display:block;min-height:640px;overflow:hidden';
    f.scrolling = 'no';
    // insertBefore n'est valide que si le script est bien un enfant de l'hôte :
    // avec un <div id="evasimu-…"> dédié, le script en est le voisin, pas le fils.
    if (script && script.parentNode === hote) hote.insertBefore(f, script);
    else hote.appendChild(f);
    addEventListener('message', function(ev){
      if (!ev.data || ev.data.evasimu !== ${JSON.stringify(cle)}) return;
      if (ev.data.hauteur) f.style.height = Math.max(520, ev.data.hauteur) + 'px';
      if (ev.data.defiler && typeof ev.data.defiler === 'number') {
        var y = f.getBoundingClientRect().top + scrollY + ev.data.defiler;
        scrollTo({ top: y, behavior: 'smooth' });
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', monter);
  else monter();
})();`;
}

/* ---------- Page du widget (contenu de l'iframe) ---------- */

function pageWidget({ client, catalogue, base, pvgisProxyUrl, googleSolarApiKey }) {
  const b = bundle();
  // Les leads passent toujours par le SaaS : c'est ce qui permet de les
  // conserver (preuve de valeur en fin d'essai, support) et de les relayer
  // ensuite vers le CRM du client. Son propre webhook reste en configuration.
  catalogue = Object.assign({}, catalogue, {
    brand: Object.assign({}, catalogue.brand, { devisEndpoint: base + '/api/public/lead/' + client.cle })
  });
  const cfg = clients.normaliserTheme((JSON.parse(client.config || '{}') || {}).theme);
  const marque = catalogue.brand || {};
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${echapper(marque.name || client.nom)} — Simulateur photovoltaïque</title>
<style>${b.css}</style>
<style>${clients.cssDuTheme(cfg)}
html,body{margin:0;padding:0;background:transparent;height:100%}
body{font-family:${echapper(cfg.police)}}
#sim{max-width:1180px;margin:0 auto}</style>
</head>
<body>
<div id="sim"></div>
<script>${b.js}</script>
<script>
(function(){
  var CLE = ${jsonSur(client.cle)};
  window.__sim = EvasimuSim.mount('#sim', {
    offers: ${jsonSur(catalogue)},
    pvgisProxyUrl: ${JSON.stringify(pvgisProxyUrl || null)},
    googleSolarApiKey: ${JSON.stringify(googleSolarApiKey || null)}
  });
  // Hauteur transmise au site hôte.
  //
  // On annonce une hauteur CIBLE, pas la hauteur du contenu. Suivre le contenu
  // faisait grandir l'iframe jusqu'à 2 300 px sur mobile : le simulateur ne
  // tenait plus dans aucun écran, et le bouton « suite » se retrouvait 500 px
  // sous le pli à chaque étape. Avec une cible, le cadre est stable et c'est la
  // colonne de contenu qui défile — comme dans n'importe quelle application.
  var derniere = 0;
  function hauteurCible(){
    return innerWidth <= 900 ? 660 : 800;
  }
  function pousser(){
    var h = hauteurCible();
    if (h !== derniere) { derniere = h; parent.postMessage({ evasimu: CLE, hauteur: h }, '*'); }
  }
  addEventListener('load', pousser);
  addEventListener('resize', pousser);
  if (window.ResizeObserver) new ResizeObserver(pousser).observe(document.body);
  setInterval(pousser, 1000);
  // Mesure d'usage, anonyme : ni identifiant visiteur, ni cookie
  function tracer(type, meta){
    try {
      var c = JSON.stringify({ type: type, meta: meta || {} });
      if (navigator.sendBeacon) navigator.sendBeacon(${JSON.stringify(base + '/api/public/evenement/')} + CLE, new Blob([c], {type:'application/json'}));
      else fetch(${JSON.stringify(base + '/api/public/evenement/')} + CLE, { method:'POST', body:c, headers:{'Content-Type':'application/json'}, keepalive:true });
    } catch(e){}
  }
  tracer('affichage');
  var vus = {};
  setInterval(function(){
    var s = window.__sim && window.__sim.state;
    if (s && s.step && !vus['etape' + s.step]) { vus['etape' + s.step] = 1; tracer('etape', { etape: s.step }); }
  }, 1500);
})();
</script>
</body>
</html>`;
}

/* ---------- Page « widget indisponible » ---------- */

function pageInactive(client, base) {
  const etat = client.etat || {};
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Simulateur indisponible</title>
<style>body{font-family:system-ui,Segoe UI,Arial,sans-serif;margin:0;padding:36px 20px;color:#51606f;
background:#f6f8fa;text-align:center}.c{max-width:460px;margin:0 auto;background:#fff;border:1px solid #e3e8ee;
border-radius:12px;padding:26px}h1{font-size:17px;color:#0f2a43;margin:0 0 8px}p{font-size:14px;line-height:1.5}
a{color:#b45309}</style></head><body><div class="c">
<h1>Simulateur momentanément indisponible</h1>
<p>Ce simulateur n'est pas actif pour le moment${etat.motif ? ' (' + echapper(etat.motif) + ')' : ''}.</p>
<p><a href="${echapper(base)}/abonnement/${echapper(client.cle)}">Réactiver mon simulateur</a></p>
</div></body></html>`;
}

/* ---------- Page de partage (réseaux sociaux, QR, bio Instagram) ---------- */

/**
 * Coupe à la fin d'un mot, pas au milieu. « obtenez votre production, vos »
 * laissait la phrase en suspens sous le nom de l'entreprise — le premier
 * élément que voit un visiteur arrivé par un lien partagé.
 */
function tronquerAuMot(texte, max) {
  const t = String(texte || '').trim();
  if (t.length <= max) return t;
  const coupe = t.slice(0, max);
  const espace = coupe.lastIndexOf(' ');
  return (espace > max * 0.6 ? coupe.slice(0, espace) : coupe).replace(/[\s,;:.]+$/, '') + '…';
}

function pagePartage({ client, catalogue, base, seo }) {
  const marque = catalogue.brand || {};
  const nom = marque.name || client.nom;
  const s = seo || {};
  const titre = s.titre || ('Simulez votre installation solaire — ' + nom);
  const desc = s.description ||
    ('Visualisez vos panneaux sur la photo aérienne de votre toit, obtenez votre production, ' +
     'vos économies et votre TVA applicable en 2 minutes. Gratuit et sans engagement.');
  const image = s.ogImage || '';
  const url = base + '/s/' + client.cle;
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${echapper(titre)}</title>
<meta name="description" content="${echapper(desc)}">
<link rel="canonical" href="${echapper(url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${echapper(nom)}">
<meta property="og:title" content="${echapper(titre)}">
<meta property="og:description" content="${echapper(desc)}">
<meta property="og:url" content="${echapper(url)}">
${image ? `<meta property="og:image" content="${echapper(image)}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">` : ''}
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${echapper(titre)}">
<meta name="twitter:description" content="${echapper(desc)}">
<style>
html,body{margin:0;padding:0}
body{font-family:system-ui,Segoe UI,Arial,sans-serif;background:#eef1f5}
.bandeau{background:#0f2a43;color:#fff;padding:14px 18px;display:flex;align-items:center;gap:12px}
.bandeau img{height:34px;width:auto;max-width:150px;object-fit:contain}
.bandeau b{font-size:16px}
.bandeau span{opacity:.8;font-size:13px}
#sim{max-width:1180px;margin:0 auto;padding:14px 10px}
@media (max-width:640px){
  /* Le simulateur porte déjà son propre titre juste en dessous : sur un
     téléphone, ce bandeau ne doit pas manger un tiers du premier écran. */
  .bandeau{padding:11px 14px;gap:9px}
  .bandeau img{height:28px;max-width:110px}
  .bandeau b{font-size:15px}
  .bandeau span{display:none}
  #sim{padding:0}
}
</style>
</head>
<body>
<div class="bandeau">
  ${marque.logoUrl ? `<img src="${echapper(marque.logoUrl)}" alt="${echapper(nom)}">` : ''}
  <div><b>${echapper(nom)}</b><br><span>${echapper(tronquerAuMot(desc, 90))}</span></div>
</div>
<div id="sim"></div>
<script src="${echapper(base)}/w/${echapper(client.cle)}.js"></script>
</body>
</html>`;
}

/* ---------- Extraits prêts à coller ---------- */

function extraits(base, client) {
  const cle = client.cle;
  const scriptUrl = base + '/w/' + cle + '.js';
  return {
    script: {
      titre: 'Site web (recommandé)',
      aide: 'Collez ces deux lignes à l’endroit exact où le simulateur doit apparaître. ' +
        'La hauteur s’ajuste toute seule, sur ordinateur comme sur mobile.',
      code: '<div id="evasimu-' + cle + '"></div>\n<script src="' + scriptUrl + '" async></script>'
    },
    iframe: {
      titre: 'iframe (constructeurs de sites restrictifs)',
      aide: 'Pour Wix, Squarespace ou un CMS qui refuse les scripts. Hauteur fixe : ' +
        'prévoyez large sur mobile.',
      code: '<iframe src="' + base + '/w/' + cle + '" style="width:100%;height:900px;border:0" ' +
        'title="Simulateur photovoltaïque" allow="geolocation" loading="lazy"></iframe>'
    },
    lien: {
      titre: 'Lien direct (réseaux sociaux, QR code, e-mail)',
      aide: 'Bio Instagram, bouton Facebook, fiche Google Business, signature d’e-mail, ' +
        'flyer ou flanc de camionnette via un QR code. La page porte votre logo et ' +
        'un aperçu propre au partage.',
      code: base + '/s/' + cle
    },
    wordpress: {
      titre: 'WordPress',
      aide: 'Bloc « HTML personnalisé » dans l’éditeur de page, puis collez le code du site web.',
      code: '<div id="evasimu-' + cle + '"></div>\n<script src="' + scriptUrl + '" async></script>'
    }
  };
}

module.exports = {
  tronquerAuMot, scriptIntegration, pageWidget, pageInactive, pagePartage, extraits, bundle };
