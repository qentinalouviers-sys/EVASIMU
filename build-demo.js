/**
 * RDF-SOLAR — Construit la démo autonome en un seul fichier HTML
 * (Leaflet + moteur + widget + styles + catalogue d'offres, tout inliné).
 * Usage : node build-demo.js  →  dist/rdf-solar-demo-autonome.html
 * Le fichier produit s'ouvre par double-clic sur n'importe quel poste connecté.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
// "</script>" dans un source inliné terminerait le bloc <script> de la page hôte
const safeJs = (src) => src.replace(/<\/script/gi, '<\\/script');

const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RDF-SOLAR — Simulateur photovoltaïque (démo autonome)</title>
<style>${read('vendor/leaflet/leaflet.css')}</style>
<style>${read('src/rdf-solar-sim.css')}</style>
<style>
  body { margin: 0; padding: 24px 12px; background: #eef1f5; font-family: system-ui, sans-serif; }
  .demo-intro { max-width: 1180px; margin: 0 auto 16px; color: #51606f; }
  .demo-intro h1 { color: #0f2a43; margin: 0 0 6px; font-size: 24px; }
</style>
</head>
<body>
<div class="demo-intro">
  <h1>☀ Simulateur photovoltaïque RDF-SOLAR</h1>
  <p>Démonstration autonome — fichier unique, à ouvrir dans un navigateur connecté à Internet.</p>
</div>
<div id="rdf-solar-sim"></div>
<script>${safeJs(read('vendor/leaflet/leaflet.js'))}</script>
<script>${safeJs(read('vendor/three/three.min.js'))}</script>
<script>${safeJs(read('vendor/three/OrbitControls.js'))}</script>
<script>${safeJs(read('src/rdf-solar-engine.js'))}</script>
<script>${safeJs(read('src/rdf-solar-3d.js'))}</script>
<script>${safeJs(read('src/rdf-solar-sim.js'))}</script>
<script>
  window.__sim = RDFSolarSim.mount('#rdf-solar-sim', { offers: ${read('config/offers.json').trim()} });
</script>
</body>
</html>`;

fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
const out = path.join(__dirname, 'dist', 'rdf-solar-demo-autonome.html');
fs.writeFileSync(out, html);
console.log('Écrit :', out, '(' + Math.round(html.length / 1024) + ' Ko)');
