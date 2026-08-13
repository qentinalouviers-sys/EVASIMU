/**
 * RDF-SOLAR — Proxy PVGIS (Node.js, sans dépendance)
 *
 * PVGIS (Commission européenne) fournit des estimations de production issues de
 * données satellitaires réelles — et prend en compte le RELIEF (masques lointains)
 * ainsi que la température des modules mois par mois. Mais PVGIS bloque
 * volontairement les appels depuis un navigateur (pas d'en-tête CORS) : ce petit
 * serveur relaie la requête depuis votre backend.
 *
 * Le simulateur l'interroge automatiquement dès que `pvgisProxyUrl` est fourni,
 * et retombe silencieusement sur son moteur embarqué en cas d'indisponibilité.
 *
 *   Lancement :  node server/pvgis-proxy.js        (port 8787 par défaut)
 *   Santé :      curl http://localhost:8787/health
 *   Test :       curl "http://localhost:8787/api/pvgis?lat=45.76&lon=4.84&peakpower=1&angle=30&aspect=0"
 *   Widget :     RDFSolarSim.mount('#sim', { pvgisProxyUrl: '/api/pvgis' })
 *
 * Variables d'environnement (toutes facultatives) :
 *   PORT                 port d'écoute                                (8787)
 *   PVGIS_BASE_URL       endpoint PVcalc amont                        (PVGIS v5.2)
 *   PVGIS_ALLOWED_ORIGIN origines autorisées, séparées par des virgules, ou *   (*)
 *   PVGIS_CACHE_TTL_MS   durée de vie du cache                        (30 jours)
 *   PVGIS_CACHE_MAX      nombre d'entrées en cache                    (5000)
 *   PVGIS_RATE_PER_MIN   requêtes par minute et par IP                (120)
 *   PVGIS_TIMEOUT_MS     délai d'attente amont                        (10 s)
 *   PVGIS_MAX_INFLIGHT   appels simultanés vers PVGIS                 (4)
 *
 * PVGIS est un service public gratuit : le cache, la limite de débit et le
 * plafond d'appels simultanés sont là pour en faire un usage correct. Merci de
 * les conserver. Mentionnez la source auprès de vos visiteurs (le widget le fait).
 */
'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const CONFIG = {
  port: parseInt(process.env.PORT, 10) || 8787,
  baseUrl: process.env.PVGIS_BASE_URL || 'https://re.jrc.ec.europa.eu/api/v5_2/PVcalc',
  allowedOrigin: process.env.PVGIS_ALLOWED_ORIGIN || '*',
  cacheTtlMs: parseInt(process.env.PVGIS_CACHE_TTL_MS, 10) || 30 * 24 * 3600 * 1000,
  cacheMax: parseInt(process.env.PVGIS_CACHE_MAX, 10) || 5000,
  ratePerMin: parseInt(process.env.PVGIS_RATE_PER_MIN, 10) || 120,
  timeoutMs: parseInt(process.env.PVGIS_TIMEOUT_MS, 10) || 10000,
  maxInflight: parseInt(process.env.PVGIS_MAX_INFLIGHT, 10) || 4
};

/* ------------------------------------------------------------------ */
/* Validation des paramètres                                           */
/* ------------------------------------------------------------------ */

// Emprise couverte par PVGIS (Europe/Afrique/Asie via SARAH & ERA5). En dehors,
// PVGIS répond une erreur : autant l'attraper ici et laisser le widget garder
// son estimation locale.
const BOUNDS = { latMin: -66, latMax: 66, lonMin: -35, lonMax: 70 };

function num(v, def) {
  if (v === null || v === undefined || v === '') return def;
  const n = parseFloat(v);
  return isFinite(n) ? n : NaN;
}

/**
 * Valide et normalise la requête entrante.
 * Les coordonnées sont arrondies à 4 décimales (~11 m) : deux visiteurs du même
 * toit partagent alors la même entrée de cache, et PVGIS n'est appelé qu'une fois.
 * @returns {{ params: Object }|{ error: string }}
 */
function parseParams(searchParams) {
  const lat = num(searchParams.get('lat'), NaN);
  const lon = num(searchParams.get('lon'), NaN);
  const peakpower = num(searchParams.get('peakpower'), 1);
  const angle = num(searchParams.get('angle'), 30);
  // PVGIS : aspect 0 = sud, -90 = est, +90 = ouest (le widget envoie azimut boussole − 180)
  const aspect = num(searchParams.get('aspect'), 0);
  const loss = num(searchParams.get('loss'), 14);

  if (!isFinite(lat) || !isFinite(lon)) return { error: 'params requis : lat, lon' };
  if (lat < BOUNDS.latMin || lat > BOUNDS.latMax || lon < BOUNDS.lonMin || lon > BOUNDS.lonMax) {
    return { error: 'coordonnées hors de la couverture PVGIS' };
  }
  if (!isFinite(peakpower) || peakpower <= 0 || peakpower > 1000) return { error: 'peakpower invalide (0 → 1000 kWc)' };
  if (!isFinite(angle) || angle < 0 || angle > 90) return { error: 'angle invalide (0 → 90°)' };
  if (!isFinite(aspect) || aspect < -180 || aspect > 180) return { error: 'aspect invalide (−180 → 180°)' };
  if (!isFinite(loss) || loss < 0 || loss > 40) return { error: 'loss invalide (0 → 40 %)' };

  return {
    params: {
      lat: Math.round(lat * 1e4) / 1e4,
      lon: Math.round(lon * 1e4) / 1e4,
      peakpower: Math.round(peakpower * 1000) / 1000,
      angle: Math.round(angle),
      aspect: Math.round(aspect),
      loss: Math.round(loss)
    }
  };
}

// La production PVGIS est proportionnelle à la puissance crête : on interroge
// donc toujours 1 kWc et on met à l'échelle côté widget. La clé de cache ignore
// volontairement peakpower — un toit interrogé pour 6 puis 8 kWc ne consomme
// qu'un seul appel amont.
function cacheKey(p) {
  return [p.lat, p.lon, p.angle, p.aspect, p.loss].join('|');
}

function upstreamUrl(base, p) {
  const u = new URL(base);
  u.searchParams.set('lat', p.lat);
  u.searchParams.set('lon', p.lon);
  u.searchParams.set('peakpower', 1);
  u.searchParams.set('angle', p.angle);
  u.searchParams.set('aspect', p.aspect);
  u.searchParams.set('loss', p.loss);
  u.searchParams.set('mountingplace', 'building'); // modules en toiture : moins ventilés qu'au sol
  u.searchParams.set('outputformat', 'json');
  return u.toString();
}

/**
 * Extrait ce dont le widget a besoin de la réponse PVGIS, et rien d'autre :
 * production annuelle et mensuelle pour 1 kWc.
 */
function shapeResponse(json) {
  const out = json && json.outputs;
  const totals = out && out.totals && out.totals.fixed;
  const monthly = out && out.monthly && out.monthly.fixed;
  if (!totals || !isFinite(totals.E_y) || totals.E_y <= 0) return null;
  return {
    kwhPerKwc: Math.round(totals.E_y * 10) / 10,
    monthlyPerKwc: Array.isArray(monthly) && monthly.length === 12
      ? monthly.map((m) => Math.round(m.E_m * 10) / 10)
      : null,
    // Pertes détaillées renvoyées par PVGIS (angle d'incidence, spectre, température)
    pertes: isFinite(totals.l_total) ? Math.round(Math.abs(totals.l_total) * 10) / 10 : null,
    source: 'PVGIS (Commission européenne)',
    meta: (json.inputs && json.inputs.meteo_data) ? json.inputs.meteo_data : null
  };
}

/* ------------------------------------------------------------------ */
/* Cache mémoire (LRU + TTL)                                           */
/* ------------------------------------------------------------------ */

function createCache(max, ttlMs) {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return null;
      if (Date.now() - hit.t > ttlMs) { map.delete(key); return null; }
      map.delete(key); map.set(key, hit);       // remonte l'entrée : LRU
      return hit.v;
    },
    set(key, value) {
      map.set(key, { t: Date.now(), v: value });
      while (map.size > max) map.delete(map.keys().next().value);
    },
    get size() { return map.size; },
    clear() { map.clear(); }
  };
}

/* ------------------------------------------------------------------ */
/* Limite de débit par IP (seau à jetons)                              */
/* ------------------------------------------------------------------ */

function createRateLimiter(perMin) {
  const buckets = new Map();
  return function allow(ip) {
    if (perMin <= 0) return true;
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b) { b = { tokens: perMin, t: now }; buckets.set(ip, b); }
    b.tokens = Math.min(perMin, b.tokens + ((now - b.t) / 60000) * perMin);
    b.t = now;
    if (buckets.size > 10000) {   // ménage : on oublie les IP inactives
      for (const [k, v] of buckets) if (now - v.t > 300000) buckets.delete(k);
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

/* ------------------------------------------------------------------ */
/* Appel amont                                                         */
/* ------------------------------------------------------------------ */

function fetchUpstream(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'RDF-SOLAR/1.0 (simulateur photovoltaique)' } }, (up) => {
      const chunks = [];
      let size = 0;
      up.on('data', (c) => {
        size += c.length;
        if (size > 2 * 1024 * 1024) { req.destroy(new Error('réponse amont trop volumineuse')); return; }
        chunks.push(c);
      });
      up.on('end', () => resolve({ status: up.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('délai dépassé (' + timeoutMs + ' ms)')));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* Serveur                                                             */
/* ------------------------------------------------------------------ */

function createServer(config) {
  const cfg = Object.assign({}, CONFIG, config || {});
  const cache = createCache(cfg.cacheMax, cfg.cacheTtlMs);
  const allow = createRateLimiter(cfg.ratePerMin);
  const origins = cfg.allowedOrigin.split(',').map((o) => o.trim()).filter(Boolean);
  const stats = { hits: 0, misses: 0, errors: 0, upstream: 0 };
  let inflight = 0;
  const waiting = [];
  const pending = new Map();   // requêtes identiques en cours : une seule sortie amont

  function corsHeaders(req) {
    const origin = req.headers.origin;
    const h = { 'Access-Control-Allow-Origin': 'null', Vary: 'Origin' };
    if (origins.includes('*')) h['Access-Control-Allow-Origin'] = '*';
    else if (origin && origins.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    h['Access-Control-Max-Age'] = '86400';
    return h;
  }

  function send(req, res, status, payload, extra) {
    res.writeHead(status, Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8' },
      corsHeaders(req), extra || {}
    ));
    res.end(JSON.stringify(payload));
  }

  // Plafonne les appels simultanés vers PVGIS (service public : on reste poli)
  function withSlot(fn) {
    return new Promise((resolve, reject) => {
      const run = () => {
        inflight++;
        fn().then(resolve, reject).finally(() => {
          inflight--;
          const next = waiting.shift();
          if (next) next();
        });
      };
      if (inflight < cfg.maxInflight) run();
      else waiting.push(run);
    });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req));
      return res.end();
    }
    if (req.method !== 'GET') return send(req, res, 405, { error: 'méthode non autorisée' });

    if (url.pathname === '/health') {
      return send(req, res, 200, {
        ok: true, upstream: cfg.baseUrl, cache: cache.size, inflight: inflight, stats: stats
      }, { 'Cache-Control': 'no-store' });
    }

    if (url.pathname !== '/api/pvgis') return send(req, res, 404, { error: 'not found' });

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.socket.remoteAddress || 'inconnue';
    if (!allow(ip)) {
      return send(req, res, 429, { error: 'trop de requêtes, réessayez dans une minute' }, { 'Retry-After': '60' });
    }

    const parsed = parseParams(url.searchParams);
    if (parsed.error) return send(req, res, 400, { error: parsed.error });
    const p = parsed.params;
    const key = cacheKey(p);

    const respond = (data, cacheState) => send(req, res, 200, data, {
      'Cache-Control': 'public, max-age=86400',
      'X-Cache': cacheState
    });

    const cached = cache.get(key);
    if (cached) { stats.hits++; return respond(cached, 'HIT'); }
    stats.misses++;

    // Deux visiteurs sur le même toit au même instant : un seul appel amont
    if (pending.has(key)) {
      return pending.get(key).then(
        (data) => respond(data, 'COALESCED'),
        (e) => { stats.errors++; send(req, res, 502, { error: 'PVGIS indisponible : ' + e.message }); }
      );
    }

    const job = withSlot(() => fetchUpstream(upstreamUrl(cfg.baseUrl, p), cfg.timeoutMs))
      .then((up) => {
        stats.upstream++;
        if (up.status !== 200) throw new Error('PVGIS a répondu ' + up.status);
        let json;
        try { json = JSON.parse(up.body); }
        catch (e) { throw new Error('réponse PVGIS illisible'); }
        const shaped = shapeResponse(json);
        if (!shaped) throw new Error('réponse PVGIS sans production exploitable');
        cache.set(key, shaped);
        return shaped;
      })
      .finally(() => pending.delete(key));

    pending.set(key, job);
    job.then(
      (data) => respond(data, 'MISS'),
      (e) => { stats.errors++; send(req, res, 502, { error: 'PVGIS indisponible : ' + e.message }); }
    );
  });

  server.rdfCache = cache;      // exposé pour les tests
  server.rdfStats = stats;
  server.rdfConfig = cfg;
  return server;
}

/* ------------------------------------------------------------------ */

if (require.main === module) {
  const server = createServer();
  server.listen(CONFIG.port, () => {
    console.log('Proxy PVGIS démarré : http://localhost:' + CONFIG.port + '/api/pvgis');
    console.log('  amont   : ' + CONFIG.baseUrl);
    console.log('  origines: ' + CONFIG.allowedOrigin +
      (CONFIG.allowedOrigin === '*' ? '  ⚠ ouvrez seulement à votre domaine en production (PVGIS_ALLOWED_ORIGIN)' : ''));
    console.log('  santé   : http://localhost:' + CONFIG.port + '/health');
  });
  const stop = () => { console.log('\nArrêt du proxy PVGIS…'); server.close(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { createServer, parseParams, cacheKey, upstreamUrl, shapeResponse, createCache, createRateLimiter, CONFIG };
