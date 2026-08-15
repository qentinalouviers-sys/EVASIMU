/**
 * Tests du proxy PVGIS — exécution : node tests/pvgis-proxy.test.js
 *
 * PVGIS n'est pas appelé : un serveur amont factice reproduit le format de
 * réponse de PVcalc, ce qui permet de tester le proxy hors ligne (et donc en CI)
 * — cache, coalescence, limite de débit, validation, pannes amont.
 */
'use strict';

const http = require('http');
const { createServer, parseParams, cacheKey, upstreamUrl, shapeResponse } = require('../server/pvgis-proxy.js');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

/* ---------- Réponse PVGIS factice, au format réel de PVcalc ---------- */
function pvgisPayload(lat, angle) {
  const base = 1150 + (46 - lat) * 22 + (angle === 30 ? 40 : 0);   // dépend des paramètres : on vérifie qu'ils circulent
  const brut = [0.037, 0.052, 0.082, 0.104, 0.116, 0.121, 0.124, 0.113, 0.094, 0.066, 0.046, 0.035];
  const somme = brut.reduce((a, b) => a + b, 0);
  const profil = brut.map((f) => f / somme);   // normalisé : la somme des mois fait l'année
  return {
    inputs: { meteo_data: { radiation_db: 'PVGIS-SARAH3' } },
    outputs: {
      monthly: { fixed: profil.map((f, i) => ({ month: i + 1, E_m: base * f })) },
      totals: { fixed: { E_y: base, l_total: -21.4 } }
    }
  };
}

/* ---------- Amont factice : compte les appels, simule pannes et lenteurs ---------- */
function startFakePvgis() {
  const state = { calls: 0, lastQuery: null, mode: 'ok', delayMs: 0 };
  const srv = http.createServer((req, res) => {
    state.calls++;
    const u = new URL(req.url, 'http://localhost');
    state.lastQuery = Object.fromEntries(u.searchParams);
    const reply = () => {
      if (state.mode === 'erreur500') { res.writeHead(500); return res.end('Internal Server Error'); }
      if (state.mode === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>maintenance</html>'); }
      if (state.mode === 'vide') { res.writeHead(200); return res.end(JSON.stringify({ outputs: {} })); }
      const lat = parseFloat(u.searchParams.get('lat'));
      const angle = parseFloat(u.searchParams.get('angle'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(pvgisPayload(lat, angle)));
    };
    if (state.delayMs) setTimeout(reply, state.delayMs); else reply();
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, state, port: srv.address().port }));
  });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (e) { /* corps non JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json: json, body: body });
      });
    }).on('error', reject);
  });
}

(async () => {
  console.log('Fonctions pures');
  {
    const ok = parseParams(new URLSearchParams('lat=45.7612345&lon=4.8412345&angle=30.4&aspect=-12.6&loss=14'));
    check('coordonnées arrondies à 4 décimales', ok.params.lat === 45.7612 && ok.params.lon === 4.8412,
      JSON.stringify(ok.params));
    check('angles arrondis', ok.params.angle === 30 && ok.params.aspect === -13, JSON.stringify(ok.params));

    check('lat/lon obligatoires', !!parseParams(new URLSearchParams('peakpower=6')).error);
    check('hors couverture PVGIS refusé', !!parseParams(new URLSearchParams('lat=80&lon=4')).error);
    check('angle > 90 refusé', !!parseParams(new URLSearchParams('lat=45&lon=4&angle=120')).error);
    check('aspect hors bornes refusé', !!parseParams(new URLSearchParams('lat=45&lon=4&aspect=200')).error);
    check('peakpower négatif refusé', !!parseParams(new URLSearchParams('lat=45&lon=4&peakpower=-3')).error);
    check('valeurs par défaut appliquées',
      parseParams(new URLSearchParams('lat=45&lon=4')).params.angle === 30);

    const a = parseParams(new URLSearchParams('lat=45&lon=4&peakpower=6')).params;
    const b = parseParams(new URLSearchParams('lat=45&lon=4&peakpower=9')).params;
    check('la clé de cache ignore la puissance crête', cacheKey(a) === cacheKey(b));

    const u = upstreamUrl('https://exemple.eu/PVcalc', a);
    check('l’amont est toujours interrogé pour 1 kWc', /peakpower=1(&|$)/.test(u), u);
    check('modules déclarés en toiture', /mountingplace=building/.test(u));
    check('format JSON demandé', /outputformat=json/.test(u));

    const shaped = shapeResponse(pvgisPayload(45.76, 30));
    check('production annuelle extraite', shaped.kwhPerKwc > 1000 && shaped.kwhPerKwc < 1600, String(shaped.kwhPerKwc));
    check('12 mois extraits', shaped.monthlyPerKwc.length === 12);
    check('somme des mois ≈ annuel', near(shaped.monthlyPerKwc.reduce((x, y) => x + y, 0), shaped.kwhPerKwc, 2));
    check('source renseignée', /PVGIS/.test(shaped.source));
    check('réponse sans production → null', shapeResponse({ outputs: {} }) === null);
    check('production nulle → null', shapeResponse({ outputs: { totals: { fixed: { E_y: 0 } } } }) === null);
  }

  console.log('Proxy en fonctionnement');
  const up = await startFakePvgis();
  const proxy = createServer({
    baseUrl: 'http://127.0.0.1:' + up.port + '/PVcalc',
    ratePerMin: 0, timeoutMs: 400, cacheMax: 10   // 0 = pas de limite : elle est testée sur une instance dédiée
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const port = proxy.address().port;

  {
    const r = await get(port, '/api/pvgis?lat=45.76&lon=4.84&angle=30&aspect=0&loss=14');
    check('200 sur une requête valide', r.status === 200, String(r.status));
    check('production renvoyée pour 1 kWc', r.json && r.json.kwhPerKwc > 0, JSON.stringify(r.json));
    check('en-tête X-Cache = MISS au premier appel', r.headers['x-cache'] === 'MISS', r.headers['x-cache']);
    check('CORS ouvert par défaut', r.headers['access-control-allow-origin'] === '*');
    check('paramètres transmis à l’amont',
      up.state.lastQuery.angle === '30' && up.state.lastQuery.aspect === '0' && up.state.lastQuery.peakpower === '1',
      JSON.stringify(up.state.lastQuery));

    const callsAvant = up.state.calls;
    const r2 = await get(port, '/api/pvgis?lat=45.76&lon=4.84&angle=30&aspect=0&loss=14');
    check('deuxième appel servi par le cache', r2.headers['x-cache'] === 'HIT' && up.state.calls === callsAvant,
      r2.headers['x-cache'] + ' / ' + up.state.calls);

    const r3 = await get(port, '/api/pvgis?lat=45.76&lon=4.84&angle=30&aspect=0&loss=14&peakpower=9');
    check('puissance différente : toujours le cache', r3.headers['x-cache'] === 'HIT' && up.state.calls === callsAvant);

    const r4 = await get(port, '/api/pvgis?lat=45.76&lon=4.84&angle=45&aspect=0&loss=14');
    check('inclinaison différente : nouvel appel amont', up.state.calls === callsAvant + 1);
    check('l’inclinaison change la production', r4.json.kwhPerKwc !== r2.json.kwhPerKwc,
      r4.json.kwhPerKwc + ' vs ' + r2.json.kwhPerKwc);
  }

  {
    // Deux visiteurs simultanés sur le même toit → un seul appel amont
    up.state.delayMs = 80;
    const callsAvant = up.state.calls;
    const [a, b, c] = await Promise.all([
      get(port, '/api/pvgis?lat=43.6&lon=1.44&angle=25&aspect=10'),
      get(port, '/api/pvgis?lat=43.6&lon=1.44&angle=25&aspect=10'),
      get(port, '/api/pvgis?lat=43.6&lon=1.44&angle=25&aspect=10')
    ]);
    up.state.delayMs = 0;
    check('requêtes simultanées identiques : un seul appel amont', up.state.calls === callsAvant + 1,
      'appels=' + (up.state.calls - callsAvant));
    check('les trois visiteurs reçoivent la même production',
      a.json.kwhPerKwc === b.json.kwhPerKwc && b.json.kwhPerKwc === c.json.kwhPerKwc);
    check('les requêtes fusionnées sont marquées',
      [a, b, c].filter((r) => r.headers['x-cache'] === 'COALESCED').length === 2,
      [a, b, c].map((r) => r.headers['x-cache']).join(','));
  }

  console.log('Robustesse');
  {
    const r = await get(port, '/api/pvgis?lat=abc&lon=4.84');
    check('paramètres invalides → 400', r.status === 400 && !!r.json.error, String(r.status));

    const r404 = await get(port, '/api/autre');
    check('route inconnue → 404', r404.status === 404);

    const h = await get(port, '/health');
    check('santé → 200 avec compteurs', h.status === 200 && h.json.ok === true && typeof h.json.cache === 'number');
    check('santé non mise en cache', /no-store/.test(h.headers['cache-control'] || ''));

    up.state.mode = 'erreur500';
    const r502 = await get(port, '/api/pvgis?lat=44.1&lon=3.1&angle=20');
    check('panne amont → 502 propre', r502.status === 502 && /PVGIS indisponible/.test(r502.json.error), r502.json.error);

    up.state.mode = 'html';
    const rHtml = await get(port, '/api/pvgis?lat=44.2&lon=3.2&angle=20');
    check('page HTML amont → 502 sans fuite du corps', rHtml.status === 502 && !/html/i.test(rHtml.body),
      rHtml.body.slice(0, 80));

    up.state.mode = 'vide';
    const rVide = await get(port, '/api/pvgis?lat=44.3&lon=3.3&angle=20');
    check('réponse amont sans production → 502', rVide.status === 502);

    up.state.mode = 'ok';
    up.state.delayMs = 900;                       // > timeoutMs (400 ms)
    const rTimeout = await get(port, '/api/pvgis?lat=44.4&lon=3.4&angle=20');
    check('amont trop lent → 502 sans blocage', rTimeout.status === 502 && /délai|socket|dépassé/i.test(rTimeout.json.error),
      rTimeout.json.error);
    up.state.delayMs = 0;

    // Une panne ne doit pas empoisonner le cache
    const rApres = await get(port, '/api/pvgis?lat=44.1&lon=3.1&angle=20');
    check('après rétablissement, la requête aboutit', rApres.status === 200 && rApres.json.kwhPerKwc > 0);
  }

  {
    // Limite de débit : instance dédiée à 5 requêtes/min, toits tous différents
    const bride = createServer({ baseUrl: 'http://127.0.0.1:' + up.port + '/PVcalc', ratePerMin: 5 });
    await new Promise((r) => bride.listen(0, '127.0.0.1', r));
    const bPort = bride.address().port;
    let servies = 0, bloquees = 0, retryAfter = null;
    for (let i = 0; i < 12; i++) {
      const r = await get(bPort, '/api/pvgis?lat=4' + i + '.5&lon=2.5&angle=30');
      if (r.status === 429) { bloquees++; retryAfter = r.headers['retry-after']; }
      else if (r.status === 200) servies++;
    }
    check('les premières requêtes passent', servies >= 5, servies + ' servies');
    check('au-delà du quota : 429', bloquees > 0, bloquees + ' bloquées');
    check('en-tête Retry-After fourni', retryAfter === '60', String(retryAfter));
    bride.close();
  }

  {
    // CORS restreint à un domaine
    const strict = createServer({
      baseUrl: 'http://127.0.0.1:' + up.port + '/PVcalc',
      allowedOrigin: 'https://www.evasimu.fr'
    });
    await new Promise((r) => strict.listen(0, '127.0.0.1', r));
    const sPort = strict.address().port;
    const autorise = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: sPort, path: '/api/pvgis?lat=45.1&lon=4.1',
        headers: { Origin: 'https://www.evasimu.fr' } }, (res) => { res.resume(); resolve(res.headers); });
    });
    const refuse = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: sPort, path: '/api/pvgis?lat=45.1&lon=4.1',
        headers: { Origin: 'https://pirate.example' } }, (res) => { res.resume(); resolve(res.headers); });
    });
    check('origine autorisée acceptée', autorise['access-control-allow-origin'] === 'https://www.evasimu.fr');
    check('origine inconnue refusée', refuse['access-control-allow-origin'] === 'null',
      refuse['access-control-allow-origin']);
    strict.close();
  }

  proxy.close();
  up.srv.close();
  console.log('\n' + passed + ' tests réussis, ' + failed + ' échec(s)');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
