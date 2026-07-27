/**
 * RDF-SOLAR — Proxy PVGIS optionnel (Node.js, sans dépendance)
 *
 * PVGIS (Commission européenne) fournit des estimations de production très précises
 * mais interdit les appels directs depuis le navigateur (CORS bloqué volontairement).
 * Ce petit serveur relaie la requête depuis votre backend : le simulateur peut alors
 * remplacer son estimation embarquée par la valeur PVGIS.
 *
 * Lancement :  node server/pvgis-proxy.js   (port 8787 par défaut)
 * Test :       curl "http://localhost:8787/api/pvgis?lat=45.76&lon=4.84&peakpower=6&angle=30&aspect=0"
 *
 * Côté widget :  RDFSolarSim.mount('#rdf-solar-sim', { pvgisProxyUrl: '/api/pvgis' })
 * (en production, servez ce endpoint derrière votre propre domaine / reverse proxy)
 */
'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = process.env.PORT || 8787;
const PVGIS = 'https://re.jrc.ec.europa.eu/api/v5_2/PVcalc';

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/api/pvgis') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'not found' }));
  }

  const lat = parseFloat(url.searchParams.get('lat'));
  const lon = parseFloat(url.searchParams.get('lon'));
  const peakpower = parseFloat(url.searchParams.get('peakpower'));
  const angle = parseFloat(url.searchParams.get('angle') || '30');
  // PVGIS : aspect 0 = sud, -90 = est, 90 = ouest  (le widget envoie azimut boussole - 180)
  const aspect = parseFloat(url.searchParams.get('aspect') || '0');
  const loss = parseFloat(url.searchParams.get('loss') || '14');

  if (!isFinite(lat) || !isFinite(lon) || !isFinite(peakpower)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'params requis : lat, lon, peakpower' }));
  }

  const target = `${PVGIS}?lat=${lat}&lon=${lon}&peakpower=${peakpower}&angle=${angle}&aspect=${aspect}&loss=${loss}&outputformat=json`;

  https.get(target, (up) => {
    let body = '';
    up.on('data', (c) => (body += c));
    up.on('end', () => {
      res.writeHead(up.statusCode || 200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400'
      });
      try {
        const json = JSON.parse(body);
        const totals = json.outputs && json.outputs.totals && json.outputs.totals.fixed;
        const monthly = json.outputs && json.outputs.monthly && json.outputs.monthly.fixed;
        res.end(JSON.stringify({
          annualKwh: totals ? totals.E_y : null,
          monthly: monthly ? monthly.map((m) => m.E_m) : null,
          source: 'PVGIS v5.2'
        }));
      } catch (e) {
        res.end(JSON.stringify({ error: 'réponse PVGIS illisible', raw: body.slice(0, 300) }));
      }
    });
  }).on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'PVGIS injoignable : ' + e.message }));
  });
});

server.listen(PORT, () => {
  console.log(`Proxy PVGIS démarré : http://localhost:${PORT}/api/pvgis`);
});
