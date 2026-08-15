/**
 * EVASIMU — Construit la démo autonome en un seul fichier HTML
 * (Leaflet + moteur + widget + styles + catalogue d'offres, tout inliné).
 *
 * Usage :
 *   node build-demo.js            → dist/evasimu-demo-autonome.html (sans clé, committable)
 *   node build-demo.js --local    → dist/evasimu-demo-personnelle.html : y inline les clés
 *                                   de config/local.js — fichier IGNORÉ par Git, à ne jamais
 *                                   diffuser publiquement.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const withLocal = process.argv.includes('--local');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
// "</script>" dans un source inliné terminerait le bloc <script> de la page hôte
const safeJs = (src) => src.replace(/<\/script/gi, '<\\/script');

const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>EVASIMU — Simulateur photovoltaïque (démo autonome)</title>
<style>${read('vendor/leaflet/leaflet.css')}</style>
<style>${read('src/evasimu-sim.css')}</style>
<style>
  body { margin: 0; padding: 24px 12px; background: #eef1f5; font-family: system-ui, sans-serif; }
  .demo-intro { max-width: 1180px; margin: 0 auto 16px; color: #51606f; }
  .demo-intro h1 { color: #0f2a43; margin: 0 0 6px; font-size: 24px; }
  .demo-note {
    max-width: 1180px; margin: 0 auto 10px; padding: 11px 14px; border-radius: 8px;
    background: #fff5e0; border: 1px solid #f0d59a; color: #6b4c11; line-height: 1.5;
  }
</style>
</head>
<body>
<div class="demo-intro">
  <h1>☀ EVASIMU — simulateur solaire en marque blanche (démo autonome)</h1>
  <p>Fichier unique, à ouvrir dans un navigateur connecté à Internet. EVASIMU édite ce simulateur et le vend aux installateurs photovoltaïques — <b>nous ne posons pas de panneaux et ne revendons aucun lead</b>.</p>
</div>
<div class="demo-note">
  Le simulateur ci-dessous tourne sur un <b>catalogue de démonstration</b> : c'est exactement ce
  que verraient vos visiteurs, à votre marque et avec vos offres à la place de celles-ci.
  ⚠ <b>Démonstration</b> : aucune coordonnée d'installateur n'est renseignée, les demandes de
  rappel ne sont donc transmises à personne.
</div>
<div id="evasimu-sim"></div>
<script>${safeJs(read('vendor/leaflet/leaflet.js'))}</script>
<script>${safeJs(read('vendor/three/three.min.js'))}</script>
<script>${safeJs(read('vendor/three/OrbitControls.js'))}</script>
<script>${safeJs(read('src/evasimu-engine.js'))}</script>
<script>${safeJs(read('src/evasimu-3d.js'))}</script>
<script>${safeJs(read('src/evasimu-sim.js'))}</script>
${withLocal ? '<script>' + safeJs(read('config/local.js')) + '</script>' : ''}
<script>
  window.__sim = EvasimuSim.mount('#evasimu-sim', {
    offers: ${read('config/offers.json').trim()},
    pvgisProxyUrl: (window.EVASIMU_LOCAL || {}).pvgisProxyUrl || null,
    googleSolarApiKey: (window.EVASIMU_LOCAL || {}).googleSolarApiKey || null
  });
</script>
</body>
</html>`;

fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
const out = path.join(__dirname, 'dist',
  withLocal ? 'evasimu-demo-personnelle.html' : 'evasimu-demo-autonome.html');
fs.writeFileSync(out, html);
console.log('Écrit :', out, '(' + Math.round(html.length / 1024) + ' Ko)' +
  (withLocal ? '  ⚠ contient vos clés : ne pas diffuser' : ''));
