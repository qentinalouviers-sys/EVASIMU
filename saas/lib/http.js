/**
 * Socle HTTP minimal : routage, corps de requête, cookies, fichiers statiques.
 * Aucune dépendance — le SaaS s'installe avec un `git clone` et un `node`.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

/* ---------- Routage ---------- */

function creerRouteur() {
  const routes = [];
  const ajouter = (methode, motif, gestionnaire) => {
    // '/api/clients/:cle/leads' → expression régulière + noms de paramètres
    const noms = [];
    const regex = new RegExp('^' + motif
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:([a-zA-Z_]+)/g, (_, n) => { noms.push(n); return '([^/]+)'; })
      .replace(/\*/g, '(.*)') + '$');
    routes.push({ methode, regex, noms, gestionnaire });
  };
  return {
    get: (m, h) => ajouter('GET', m, h),
    post: (m, h) => ajouter('POST', m, h),
    put: (m, h) => ajouter('PUT', m, h),
    patch: (m, h) => ajouter('PATCH', m, h),
    delete: (m, h) => ajouter('DELETE', m, h),
    resoudre(methode, chemin) {
      for (const r of routes) {
        if (r.methode !== methode) continue;
        const m = chemin.match(r.regex);
        if (!m) continue;
        const params = {};
        r.noms.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
        return { gestionnaire: r.gestionnaire, params };
      }
      return null;
    },
    // Une route existe-t-elle sur un autre verbe ? (405 plutôt que 404)
    autreMethode(chemin) {
      return routes.some((r) => r.regex.test(chemin));
    }
  };
}

/* ---------- Réponses ---------- */

function json(res, code, charge, entetes) {
  const corps = JSON.stringify(charge);
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(corps),
    'X-Content-Type-Options': 'nosniff'
  }, entetes || {}));
  res.end(corps);
}

function html(res, code, corps, entetes) {
  res.writeHead(code, Object.assign({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(corps),
    'X-Content-Type-Options': 'nosniff'
  }, entetes || {}));
  res.end(corps);
}

function texte(res, code, corps, type, entetes) {
  res.writeHead(code, Object.assign({
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(corps)
  }, entetes || {}));
  res.end(corps);
}

function redirige(res, url) {
  res.writeHead(302, { Location: url });
  res.end();
}

/* ---------- Requêtes ---------- */

function lireCorps(req, maxOctets) {
  const max = maxOctets || 512 * 1024;
  return new Promise((resolve, reject) => {
    const morceaux = [];
    let taille = 0;
    req.on('data', (c) => {
      taille += c.length;
      if (taille > max) { reject(new Error('corps trop volumineux')); req.destroy(); return; }
      morceaux.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(morceaux).toString('utf8')));
    req.on('error', reject);
  });
}

async function lireJson(req, max) {
  const brut = await lireCorps(req, max);
  if (!brut) return {};
  try { return JSON.parse(brut); }
  catch (e) { const err = new Error('JSON invalide'); err.code = 400; throw err; }
}

function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function poserCookie(res, nom, valeur, options) {
  const o = options || {};
  const parts = [nom + '=' + encodeURIComponent(valeur), 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (o.maxAge) parts.push('Max-Age=' + o.maxAge);
  if (o.secure) parts.push('Secure');
  const deja = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', (deja ? [].concat(deja) : []).concat(parts.join('; ')));
}

/* ---------- Statique ---------- */

function servirStatique(res, racine, sousChemin) {
  // Traversée de répertoire : on résout puis on vérifie qu'on reste sous la racine
  const cible = path.resolve(racine, '.' + path.posix.normalize('/' + sousChemin));
  if (!cible.startsWith(path.resolve(racine))) { json(res, 403, { erreur: 'interdit' }); return true; }
  let st;
  try { st = fs.statSync(cible); } catch (e) { return false; }
  if (!st.isFile()) return false;
  const type = TYPES[path.extname(cible).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Cache-Control': 'public, max-age=300'
  });
  fs.createReadStream(cible).pipe(res);
  return true;
}

/* ---------- Sécurité ---------- */

// Échappement HTML — toute donnée saisie par un client passe par là avant de
// se retrouver dans une page servie (thème, textes de la landing, nom…).
function echapper(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Comparaison à temps constant (jetons, signatures)
function egal(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function ip(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress || 'inconnue';
}

/* ---------- Limitation de débit ---------- */

function limiteur(parMinute) {
  const seaux = new Map();
  return function autorise(cle) {
    if (!parMinute) return true;
    const maintenant = Date.now();
    let s = seaux.get(cle);
    if (!s) { s = { jetons: parMinute, t: maintenant }; seaux.set(cle, s); }
    s.jetons = Math.min(parMinute, s.jetons + ((maintenant - s.t) / 60000) * parMinute);
    s.t = maintenant;
    if (seaux.size > 20000) {
      for (const [k, v] of seaux) if (maintenant - v.t > 600000) seaux.delete(k);
    }
    if (s.jetons < 1) return false;
    s.jetons -= 1;
    return true;
  };
}

module.exports = {
  creerRouteur, json, html, texte, redirige, lireCorps, lireJson,
  cookies, poserCookie, servirStatique, echapper, egal, ip, limiteur, TYPES
};
