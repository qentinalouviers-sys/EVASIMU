/**
 * EVASIMU SaaS — serveur.
 *
 *   node saas/server.js                 (port 8080)
 *   EVASIMU_BASE=https://app.exemple.fr node saas/server.js
 *
 * Aucune dépendance : Node ≥ 22.5 suffit (SQLite intégré).
 *
 * Surfaces exposées :
 *   /console            espace éditeur (clients, CRM, statistiques, jetons)
 *   /w/:cle.js          script d'intégration posé sur le site du client
 *   /w/:cle             page du widget (contenu de l'iframe)
 *   /s/:cle             page de partage (réseaux sociaux, QR, bio)
 *   /p/:slug            page hébergée avec référencement local
 *   /abonnement/:cle    page publique d'abonnement
 *   /api/v1/*           API opérateurs et agents Hermès (jeton Bearer)
 *   /api/public/*       endpoints appelés par les widgets (leads, usage)
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');

const dbLib = require('./lib/db.js');
const H = require('./lib/http.js');
const IMPORT = require('./lib/import-prospects.js');
const authLib = require('./lib/auth.js');
const clientsLib = require('./lib/clients.js');
const crmLib = require('./lib/crm.js');
const widgetLib = require('./lib/widget.js');
const landingLib = require('./lib/landing.js');
const billing = require('./lib/billing.js');
const suivi = require('./lib/suivi.js');
const agentsLib = require('./lib/agents.js');

function creerApp(options) {
  const cfg = Object.assign({
    base: process.env.EVASIMU_BASE || 'http://localhost:8080',
    db: process.env.EVASIMU_DB || null,
    pvgisProxyUrl: process.env.EVASIMU_PVGIS || null,
    googleSolarApiKey: process.env.EVASIMU_GOOGLE_SOLAR || null,
    // Page de vente publique : destination des liens suivis des messages.
    pageVente: process.env.EVASIMU_PAGE_VENTE || 'https://qentinalouviers-sys.github.io/EVASIMU/',
    secure: /^https:/i.test(process.env.EVASIMU_BASE || '')
  }, options || {});

  const db = dbLib.open(cfg.db);
  const auth = authLib.creerAuth(db);
  const clients = clientsLib.creerDepot(db);
  const crm = crmLib.creerCrm(db);
  const agents = agentsLib.creerAgents(db);
  const paiement = billing.creerPaiement(cfg);
  const routeur = H.creerRouteur();
  const publicDir = path.join(__dirname, 'public');

  const limiteConnexion = H.limiteur(20);      // tentatives de connexion / min / IP
  const limitePublique = H.limiteur(240);      // endpoints widgets / min / IP

  // Page du widget : route la plus appelée, et la plus coûteuse à produire
  // (≈ 1 Mo de sources concaténées). On la mémorise par client, invalidée
  // automatiquement par sa date de dernière modification.
  const cachePages = new Map();
  function pageWidgetCachee(client) {
    const cle = client.cle + '|' + client.maj_le;
    let html = cachePages.get(cle);
    if (!html) {
      html = widgetLib.pageWidget({
        client,
        catalogue: clients.catalogueEffectif(client),
        base: cfg.base,
        pvgisProxyUrl: cfg.pvgisProxyUrl,
        // Google Solar est le seul appel facturé du simulateur, et il est
        // réservé aux formules payantes. C'est ce qui rend le palier gratuit
        // tenable : sans lui, le coût marginal d'un client gratuit cesse d'être
        // nul et le plafond de 10 000 requêtes mensuelles se vide.
        googleSolarApiKey: billing.googleSolarOuvert(client.formule) ? cfg.googleSolarApiKey : null
      });
      if (cachePages.size > 200) cachePages.clear();
      cachePages.set(cle, html);
    }
    return html;
  }

  /* ---------------- Aides ---------------- */

  function contexte(req) {
    return auth.depuisRequete(req, H.cookies(req));
  }
  function exigerPortee(ctx, portee, res) {
    if (!ctx) { H.json(res, 401, { erreur: 'authentification requise' }); return false; }
    if (!authLib.autorise(ctx.portees, portee)) {
      H.json(res, 403, { erreur: 'portée manquante : ' + portee, profil: (ctx.agent || {}).profil });
      return false;
    }
    return true;
  }
  function acteur(ctx) {
    if (!ctx) return '';
    return ctx.type === 'agent' ? ('agent:' + ctx.agent.profil) : ('op:' + ctx.operateur.email);
  }

  /* ================= Widgets ================= */

  routeur.get('/w/:cle.js', (req, res, p) => {
    const client = clients.parCle(p.cle);
    const entetes = {
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*'
    };
    // Client inconnu ou coupé : le script existe mais ne monte rien. Le site du
    // client ne casse jamais, même si l'on désactive le widget en plein midi.
    const corps = (!client || !client.etat.actif)
      ? '/* simulateur inactif */'
      : widgetLib.scriptIntegration(cfg.base, client.cle);
    H.envoyer(req, res, 200, corps, 'text/javascript; charset=utf-8', entetes);
  });

  routeur.get('/w/:cle', (req, res, p) => {
    const client = clients.parCle(p.cle);
    if (!client) { H.html(res, 404, '<p>Simulateur introuvable.</p>'); return; }
    if (!client.etat.actif) {
      H.html(res, 200, widgetLib.pageInactive(client, cfg.base), { 'Cache-Control': 'no-store' }, req);
      return;
    }
    const html = pageWidgetCachee(client);
    // L'iframe doit pouvoir être intégrée sur le site du client, et seulement là
    // si des domaines ont été déclarés.
    const entetes = { 'Cache-Control': 'public, max-age=120' };
    const domaines = (client.domaines || '').split(',').filter(Boolean);
    entetes['Content-Security-Policy'] = 'frame-ancestors ' +
      (domaines.length ? domaines.map((d) => 'https://' + d + ' https://*.' + d).join(' ') + " 'self'" : '*');
    H.html(res, 200, html, entetes, req);
  });

  routeur.get('/w/:cle/config.json', (req, res, p) => {
    const client = clients.parCle(p.cle);
    if (!client) { H.json(res, 404, { erreur: 'inconnu' }); return; }
    if (!client.etat.actif) { H.json(res, 402, { erreur: 'inactif', motif: client.etat.motif }); return; }
    H.json(res, 200, clients.catalogueEffectif(client), { 'Access-Control-Allow-Origin': '*' });
  });

  routeur.get('/s/:cle', (req, res, p) => {
    const client = clients.parCle(p.cle);
    if (!client) { H.html(res, 404, '<p>Page introuvable.</p>'); return; }
    if (!client.etat.actif) { H.html(res, 200, widgetLib.pageInactive(client, cfg.base)); return; }
    const cfgClient = dbLib.json(client.config, {}) || {};
    H.html(res, 200, widgetLib.pagePartage({
      client, catalogue: clients.catalogueEffectif(client), base: cfg.base, seo: cfgClient.seo
    }), {}, req);
  });

  /* ================= Pages hébergées (SEO local) ================= */

  const stPages = {
    parSlug: db.prepare('SELECT * FROM pages WHERE slug = ? AND publiee = 1'),
    duClient: db.prepare('SELECT * FROM pages WHERE client_id = ? ORDER BY ville'),
    creer: db.prepare(`INSERT INTO pages(client_id, slug, ville, departement, titre, description,
      contenu, publiee, cree_le, maj_le) VALUES(?,?,?,?,?,?,?,?,?,?)`),
    maj: db.prepare(`UPDATE pages SET ville=?, departement=?, titre=?, description=?, contenu=?,
      publiee=?, maj_le=? WHERE id=?`),
    parId: db.prepare('SELECT * FROM pages WHERE id = ?'),
    supprimer: db.prepare('DELETE FROM pages WHERE id = ?'),
    toutesPubliees: db.prepare(`SELECT p.*, c.statut, c.essai_fin, c.abonnement_fin FROM pages p
      JOIN clients c ON c.id = p.client_id WHERE p.publiee = 1`),
    slugPris: db.prepare('SELECT 1 FROM pages WHERE slug = ?')
  };

  routeur.get('/p/:slug', (req, res, p) => {
    const page = stPages.parSlug.get(p.slug);
    if (!page) { H.html(res, 404, '<p>Page introuvable.</p>'); return; }
    const client = clients.parId(page.client_id);
    if (!client || !client.etat.actif) { H.html(res, 404, '<p>Page indisponible.</p>'); return; }
    const html = landingLib.pageLocale({
      client,
      catalogue: clients.catalogueEffectif(client),
      page: Object.assign({}, page, { contenu: dbLib.json(page.contenu, {}) }),
      autresPages: stPages.duClient.all(client.id),
      base: cfg.base
    });
    H.html(res, 200, html, { 'Cache-Control': 'public, max-age=600' }, req);
  });

  routeur.get('/sitemap.xml', (req, res) => {
    const entrees = [];
    stPages.toutesPubliees.all().forEach((p) => {
      if (billing.etat(p).actif) entrees.push({ chemin: '/p/' + p.slug, maj: p.maj_le });
    });
    H.texte(res, 200, landingLib.sitemap(cfg.base, entrees), 'application/xml; charset=utf-8', {}, req);
  });

  routeur.get('/robots.txt', (req, res) => {
    H.texte(res, 200, landingLib.robots(cfg.base));
  });

  /* ================= Endpoints publics appelés par les widgets ================= */

  routeur.post('/api/public/lead/:cle', async (req, res, p) => {
    if (!limitePublique(H.ip(req))) { H.json(res, 429, { erreur: 'trop de requêtes' }); return; }
    const client = clients.parCle(p.cle);
    if (!client) { H.json(res, 404, { erreur: 'inconnu' }); return; }
    if (!client.etat.actif) { H.json(res, 402, { erreur: 'inactif' }); return; }
    const charge = await H.lireJson(req, 200 * 1024);
    // Sans preuve de consentement, on refuse : un lead non rappelable n'a pas
    // sa place dans la base du client (art. L. 223-1).
    if (!charge || !charge.consentement || charge.consentement.donne !== true) {
      H.json(res, 400, { erreur: 'consentement manquant' }, { 'Access-Control-Allow-Origin': '*' });
      return;
    }
    // Quota du palier gratuit. Un dépassement ne refuse jamais le lead : le
    // visiteur a rempli le formulaire, il existe, et le renvoyer priverait
    // l'installateur d'un client réel pour une question de facturation. Le lead
    // est enregistré, retenu, et libéré au passage payant.
    const dejaCeMois = crm.compterLeadsDepuis(client.id, billing.debutDuMois());
    const retenu = billing.leadRetenu(client.formule, dejaCeMois);
    const id = crm.enregistrerLead(client.id, charge, retenu);
    crm.evenement(client.id, 'lead', { type: charge.type || '', retenu: retenu ? 1 : 0 });
    // Réponse immédiate au visiteur ; le relais vers le CRM du client se fait
    // ensuite, et son échec ne lui fait jamais perdre son lead.
    H.json(res, 201, { ok: true, id }, { 'Access-Control-Allow-Origin': '*' });
    // Un lead retenu n'est pas relayé : le webhook livrerait les coordonnées
    // que la console masque, et le masquage ne vaudrait plus rien.
    if (!retenu) relayerLead(client, charge, id);
  });

  routeur.post('/api/public/evenement/:cle', async (req, res, p) => {
    if (!limitePublique(H.ip(req))) { res.writeHead(429); res.end(); return; }
    const client = clients.parCle(p.cle);
    if (!client) { res.writeHead(204); res.end(); return; }
    let corps = {};
    try { corps = await H.lireJson(req, 8 * 1024); } catch (e) { /* mesure best effort */ }
    const type = String(corps.type || '').slice(0, 40);
    if (['affichage', 'etape', 'devis'].indexOf(type) !== -1) {
      crm.evenement(client.id, type, corps.meta);
    }
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    res.end();
  });

  /* ================= Suivi des messages de prospection =================
   *
   * Deux routes publiques, appelées par le destinataire d'un e-mail. Elles ne
   * demandent aucune session : le jeton signé EST l'authentification, et il ne
   * donne accès à rien — juste le droit d'enregistrer un signal et d'être
   * redirigé. Un jeton falsifié ne fait rien du tout.
   */

  /** Clic : on note, puis on emmène là où le message promettait d'emmener. */
  routeur.get('/r/:jeton', (req, res, p) => {
    const t = suivi.verifier(p.jeton);
    // Jeton invalide : on redirige quand même vers la page de vente. Le
    // destinataire a cliqué de bonne foi ; lui afficher une erreur parce que
    // notre signature ne tombe pas juste, c'est perdre un prospect pour un
    // problème qui n'est pas le sien.
    if (!t) { H.redirige(res, cfg.base + '/'); return; }
    const prospect = crm.prospect(t.prospectId);
    crm.signal(t.prospectId, 'clic', 'étape ' + (t.etape || '?') + ' → ' + t.destination);
    H.redirige(res, destinationSuivi(t.destination, prospect, p.jeton));
  });

  /*
   * Ouverture : pixel 1×1.
   *
   * À lire avant de s'y fier. Apple Mail Privacy Protection précharge les
   * images de tous les messages, ouverts ou non : chez ces destinataires, le
   * signal est faux. Gmail passe par son proxy d'images, ce qui rend l'IP et
   * le navigateur inexploitables. Et un pixel de mesure émis par un domaine en
   * cours de chauffe est un signal négatif pour les filtres.
   *
   * C'est pourquoi l'ouverture pèse 1 point quand un clic en pèse 15 : elle
   * sert à repérer une adresse morte, pas à qualifier un prospect. Le pixel
   * n'est inséré dans les messages que si EVASIMU_SUIVI_PIXEL=1 — la route, elle,
   * répond toujours, pour ne pas casser les messages déjà partis.
   */
  routeur.get('/o/:jeton', (req, res, p) => {
    const t = suivi.verifier(String(p.jeton).replace(/\.gif$/, ''));
    if (t) crm.signal(t.prospectId, 'ouverture', 'étape ' + (t.etape || '?'));
    // GIF transparent 1×1, en dur : aucune lecture disque sur une route
    // appelée par chaque destinataire.
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.writeHead(200, {
      'Content-Type': 'image/gif', 'Content-Length': gif.length,
      'Cache-Control': 'no-store, no-cache, must-revalidate, private'
    });
    res.end(gif);
  });

  /**
   * Ce que le prospect fait DANS son aperçu.
   *
   * C'est le signal qui vaut quelque chose. Un clic dit « il a regardé » ;
   * une toiture dessinée et des résultats atteints disent « il a passé quatre
   * minutes dans le produit », et ça se rappelle dans l'heure. Le jeton est
   * celui du lien cliqué : la page d'aperçu le reçoit dans son URL.
   */
  routeur.post('/api/public/signal/:jeton', async (req, res, p) => {
    if (!limitePublique(H.ip(req))) { res.writeHead(429); res.end(); return; }
    const t = suivi.verifier(p.jeton);
    if (!t) { res.writeHead(204, { 'Access-Control-Allow-Origin': '*' }); res.end(); return; }
    let corps = {};
    try { corps = await H.lireJson(req, 4 * 1024); } catch (e) { /* mesure best effort */ }
    // Liste fermée : le corps vient du navigateur du prospect, donc de nulle
    // part de sûr. Un type libre laisserait écrire n'importe quoi dans le
    // journal d'une fiche.
    const type = String((corps || {}).type || '');
    if (type === 'apercu_simulation' || type === 'apercu_resultats') crm.signal(t.prospectId, type);
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    res.end();
  });

  routeur.options('/api/public/signal/:jeton', (req, res) => {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
  });

  /**
   * L'URL réelle derrière une destination. C'est ici — et nulle part dans le
   * jeton — que se décide où va le visiteur.
   */
  function destinationSuivi(destination, prospect, jeton) {
    const vente = cfg.pageVente || 'https://qentinalouviers-sys.github.io/EVASIMU/';
    const demo = vente.replace(/\/+$/, '') + '/demo.html';
    if (destination === 'vente') return vente;
    if (destination === 'apercu' && prospect) {
      const q = ['e=' + encodeURIComponent(prospect.enseigne || prospect.entreprise || '')];
      if (/^#[0-9a-fA-F]{6}$/.test(prospect.couleur_apercu || '')) {
        q.push('c=' + encodeURIComponent(prospect.couleur_apercu));
      }
      // Le jeton et l'adresse du SaaS voyagent jusqu'à la page d'aperçu : elle
      // est hébergée ailleurs (pages statiques) et n'a aucun autre moyen de
      // savoir à qui rattacher ce qu'elle observe.
      if (jeton) q.push('t=' + encodeURIComponent(jeton), 's=' + encodeURIComponent(cfg.base));
      return demo + '?' + q.join('&');
    }
    return demo;
  }

  routeur.get('/api/public/formules', (req, res) => {
    H.json(res, 200, billing.FORMULES, { 'Access-Control-Allow-Origin': '*' });
  });

  /**
   * Relais du lead vers le CRM du client (webhook https déclaré dans sa
   * configuration). Signature HMAC pour qu'il puisse vérifier l'origine.
   */
  function relayerLead(client, charge, id) {
    const marque = (dbLib.json(client.config, {}) || {}).marque || {};
    const url = marque.devisEndpoint;
    if (!url || !/^https:\/\//i.test(url)) return;
    const corps = JSON.stringify(Object.assign({ idSaas: id, client: client.cle }, charge));
    const signature = require('crypto').createHmac('sha256', client.cle).update(corps).digest('hex');
    const u = new URL(url);
    const req = require('https').request({
      method: 'POST', hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(corps),
        'X-EVASIMU-Signature': signature,
        'User-Agent': 'EVASIMU-SaaS/1.0'
      }
    }, (rep) => {
      rep.resume();
      if (rep.statusCode >= 400) {
        crm.evenement(client.id, 'relais_echec', { code: rep.statusCode });
      }
    });
    req.setTimeout(8000, () => req.destroy(new Error('délai dépassé')));
    req.on('error', (e) => crm.evenement(client.id, 'relais_echec', { message: e.message }));
    req.end(corps);
  }

  /* ================= Abonnement (public) ================= */

  const stCommandes = {
    creer: db.prepare(`INSERT INTO commandes(client_id, formule, montant_ht, devise, statut, moyen,
      reference_externe, cree_le) VALUES(?,?,?,?,?,?,?,?)`),
    parClient: db.prepare('SELECT * FROM commandes WHERE client_id = ? ORDER BY cree_le DESC'),
    parReference: db.prepare('SELECT * FROM commandes WHERE reference_externe = ?'),
    payer: db.prepare('UPDATE commandes SET statut = ?, paye_le = ? WHERE id = ?'),
    lister: db.prepare(`SELECT co.*, c.nom, c.cle FROM commandes co JOIN clients c ON c.id = co.client_id
      ORDER BY co.cree_le DESC LIMIT 200`)
  };

  routeur.get('/abonnement/:cle', (req, res, p) => {
    const client = clients.parCle(p.cle);
    if (!client) { H.html(res, 404, '<p>Client introuvable.</p>'); return; }
    H.html(res, 200, pageAbonnement(client), { 'Cache-Control': 'no-store' }, req);
  });

  routeur.post('/api/public/abonnement/:cle', async (req, res, p) => {
    if (!limitePublique(H.ip(req))) { H.json(res, 429, { erreur: 'trop de requêtes' }); return; }
    const client = clients.parCle(p.cle);
    if (!client) { H.json(res, 404, { erreur: 'inconnu' }); return; }
    const corps = await H.lireJson(req);
    const f = billing.formule(corps.formule || client.formule);
    try {
      const session = await paiement.session({
        client, formuleId: f.id,
        urlSucces: cfg.base + '/abonnement/' + client.cle + '?paiement=ok',
        urlAnnulation: cfg.base + '/abonnement/' + client.cle + '?paiement=annule'
      });
      const r = stCommandes.creer.run(client.id, f.id, f.prixHTAn, billing.FORMULES.devise,
        'en_attente', session.mode, session.id || '', dbLib.nowIso());
      H.json(res, 200, Object.assign({ commande: Number(r.lastInsertRowid) }, session));
    } catch (e) {
      H.json(res, 502, { erreur: 'paiement indisponible : ' + e.message });
    }
  });

  // Webhook Stripe : active l'abonnement à la confirmation de paiement
  routeur.post('/api/public/stripe', async (req, res) => {
    const brut = await H.lireCorps(req, 256 * 1024);
    const v = paiement.verifierWebhook(req.headers['stripe-signature'], brut);
    if (!v.ok) { H.json(res, 400, { erreur: v.raison }); return; }
    const ev = v.evenement;
    if (ev.type === 'checkout.session.completed') {
      const obj = ev.data && ev.data.object;
      const cle = obj && (obj.client_reference_id || (obj.metadata || {}).client);
      const client = cle && clients.parCle(cle);
      if (client) {
        clients.activer(client, billing.FORMULES.abonnementMois);
        const cmd = stCommandes.parReference.get(obj.id);
        if (cmd) stCommandes.payer.run('paye', dbLib.nowIso(), cmd.id);
        crm.evenement(client.id, 'abonnement', { source: 'stripe' });
      }
    }
    H.json(res, 200, { recu: true });
  });

  /* ================= API v1 (opérateurs + agents Hermès) ================= */

  routeur.post('/api/v1/connexion', async (req, res) => {
    if (!limiteConnexion(H.ip(req))) { H.json(res, 429, { erreur: 'trop de tentatives' }); return; }
    const { email, motDePasse } = await H.lireJson(req);
    const s = auth.connecter(email, motDePasse);
    if (!s) { H.json(res, 401, { erreur: 'identifiants invalides' }); return; }
    H.poserCookie(res, 'evasimu_session', s.jeton, { maxAge: authLib.DUREE_SESSION_S, secure: cfg.secure });
    H.json(res, 200, { operateur: s.operateur });
  });

  routeur.post('/api/v1/deconnexion', (req, res) => {
    auth.deconnecter(H.cookies(req).evasimu_session);
    H.poserCookie(res, 'evasimu_session', '', { maxAge: 0, secure: cfg.secure });
    H.json(res, 200, { ok: true });
  });

  routeur.get('/api/v1/moi', (req, res) => {
    const ctx = contexte(req);
    if (!ctx) { H.json(res, 401, { erreur: 'non authentifié' }); return; }
    H.json(res, 200, {
      type: ctx.type,
      identite: ctx.operateur || ctx.agent,
      portees: ctx.portees,
      formules: billing.FORMULES,
      etapes: crm.ETAPES
    });
  });

  /* --- clients --- */

  routeur.get('/api/v1/clients', (req, res) => {
    const ctx = contexte(req);
    if (!exigerPortee(ctx, 'clients:lire', res)) return;
    H.json(res, 200, { clients: clients.lister().map(resumeClient) });
  });

  routeur.post('/api/v1/clients', async (req, res) => {
    const ctx = contexte(req);
    if (!exigerPortee(ctx, 'clients:ecrire', res)) return;
    const corps = await H.lireJson(req);
    try {
      const c = clients.creer(corps);
      H.json(res, 201, { client: detailClient(c) });
    } catch (e) {
      H.json(res, e.code || 500, { erreur: e.message });
    }
  });

  routeur.get('/api/v1/clients/:cle', (req, res, p) => {
    const ctx = contexte(req);
    if (!exigerPortee(ctx, 'clients:lire', res)) return;
    const c = clients.parCle(p.cle);
    if (!c) { H.json(res, 404, { erreur: 'inconnu' }); return; }
    H.json(res, 200, { client: detailClient(c) });
  });

  routeur.patch('/api/v1/clients/:cle', async (req, res, p) => {
    const ctx = contexte(req);
    if (!exigerPortee(ctx, 'clients:ecrire', res)) return;
    let c = clients.parCle(p.cle);
    if (!c) { H.json(res, 404, { erreur: 'inconnu' }); return; }
    const corps = await H.lireJson(req, 1024 * 1024);
    if (corps.nom !== undefined || corps.domaines !== undefined || corps.formule !== undefined) {
      c = clients.majChamps(c, corps);
    }
    if (corps.config) c = clients.majConfig(c, corps.config);
    H.json(res, 200, { client: detailClient(c) });
  });

  routeur.delete('/api/v1/clients/:cle', (req, res, p) => {
    const ctx = contexte(req);
    if (!exigerPortee(ctx, 'clients:ecrire', res)) return;
    const c = clients.parCle(p.cle);
    if (!c) { H.json(res, 404, { erreur: 'inconnu' }); return; }
    clients.supprimer(c);
    H.json(res, 200, { ok: true });
  });

  /* --- pages SEO --- */

  routeur.get('/api/v1/clients/:cle/pages', (req, res, p) => {
    const ctx = contexte(req);
    if (!exigerPortee(ctx, 'clients:lire', res)) return;
    const c = clients.parCle(p.cle);
    if (!c) { H.json(res, 404, { erreur: 'inconnu' }); return; }
    H.json(res, 200, { pages: stPages.duClient.all(c.id) });
  });

  routeur.post('/api/v1/clients/:cle/pages', async (req, res, p) => {
    const ctx = contexte(req);
    if (!ctx || !(authLib.autorise(ctx.portees, 'pages:ecrire') ||
        authLib.autorise(ctx.portees, 'clients:ecrire'))) {
      H.json(res, ctx ? 403 : 401, { erreur: 'portée manquante : pages:ecrire' });
      return;
    }
    const c = clients.parCle(p.cle);
    if (!c) { H.json(res, 404, { erreur: 'inconnu' }); return; }
    const corps = await H.lireJson(req, 256 * 1024);
    if (!corps.ville) { H.json(res, 400, { erreur: 'ville requise' }); return; }
    let slug = dbLib.slugifier(c.nom + '-' + corps.ville), n = 1;
    while (stPages.slugPris.get(slug)) slug = dbLib.slugifier(c.nom + '-' + corps.ville) + '-' + (++n);
    const t = dbLib.nowIso();
    stPages.creer.run(c.id, slug, String(corps.ville).slice(0, 80),
      String(corps.departement || '').slice(0, 80), String(corps.titre || '').slice(0, 200),
      String(corps.description || '').slice(0, 400),
      JSON.stringify(corps.contenu || {}), corps.publiee === false ? 0 : 1, t, t);
    H.json(res, 201, { pages: stPages.duClient.all(c.id) });
  });

  routeur.delete('/api/v1/pages/:id', (req, res, p) => {
    const ctx = contexte(req);
    if (!exigerPortee(ctx, 'clients:ecrire', res)) return;
    stPages.supprimer.run(parseInt(p.id, 10));
    H.json(res, 200, { ok: true });
  });

  // Le bouton marche/arrêt, et les leviers commerciaux autour
  routeur.post('/api/v1/clients/:cle/:action', async (req, res, p) => {
    const ctx = contexte(req);
    const c0 = clients.parCle(p.cle);
    if (!c0) { H.json(res, 404, { erreur: 'inconnu' }); return; }
    const corps = await H.lireJson(req).catch(() => ({}));
    let c = c0;
    switch (p.action) {
      case 'essai':
        if (!exigerPortee(ctx, 'essai:gerer', res)) return;
        c = clients.demarrerEssai(c0, parseInt(corps.jours, 10) || billing.FORMULES.essaiJoursDefaut);
        break;
      case 'activer':
        if (!exigerPortee(ctx, 'abonnement:gerer', res)) return;
        c = clients.activer(c0, parseInt(corps.mois, 10) || billing.FORMULES.abonnementMois);
        break;
      case 'suspendre':
        if (!exigerPortee(ctx, 'clients:ecrire', res)) return;
        c = clients.suspendre(c0);
        break;
      case 'reprendre':
        if (!exigerPortee(ctx, 'clients:ecrire', res)) return;
        c = clients.reprendre(c0);
        break;
      default:
        H.json(res, 404, { erreur: 'action inconnue' });
        return;
    }
    crm.evenement(c.id, 'cycle', { action: p.action, par: acteur(ctx) });
    H.json(res, 200, { client: detailClient(c) });
  });

  routeur.get('/api/v1/clients/:cle/stats', (req, res, p) => {
    const ctx = contexte(req);
    if (!exigerPortee(ctx, 'stats:lire', res)) return;
    const c = clients.parCle(p.cle);
    if (!c) { H.json(res, 404, { erreur: 'inconnu' }); return; }
    H.json(res, 200, { stats: crm.statsClient(c.id, 30) });
  });

  routeur.get('/api/v1/clients/:cle/leads', (req, res, p) => {
    const ctx = contexte(req);
    if (!exigerPortee(ctx, 'leads:lire', res)) return;
    const c = clients.parCle(p.cle);
    if (!c) { H.json(res, 404, { erreur: 'inconnu' }); return; }
    H.json(res, 200, { leads: crm.leadsDuClient(c.id, 200) });
  });

  /* --- CRM --- */

  routeur.get('/api/v1/prospects', (req, res) => {
    const ctx = contexte(req);
    if (!exigerPortee(ctx, 'prospects:lire', res)) return;
    const u = new URL(req.url, 'http://x');
    const f = {};
    ['statut', 'ville', 'departement', 'metier', 'proprietaire', 'q', 'limite', 'offset', 'tri'].forEach((k) => {
      if (u.searchParams.get(k)) f[k] = u.searchParams.get(k);
    });
    ['avecSite', 'inspecte', 'cible', 'vetuste'].forEach((k) => {
      if (u.searchParams.get(k)) f[k] = u.searchParams.get(k) === 'true';
    });
    if (u.searchParams.get('niveauMax')) f.niveauMax = u.searchParams.get('niveauMax');
    const page = crm.listerProspects(f);
    // `total` est le nombre de fiches correspondant aux filtres, pas le nombre
    // renvoyé : c'est ce qui permet à un client de savoir qu'il en reste, et à
    // un agent de savoir combien de pages demander.
    H.json(res, 200, {
      prospects: page,
      total: crm.compterProspects(f),
      limite: Math.max(1, Math.min(500, parseInt(f.limite, 10) || 100)),
      offset: Math.max(0, parseInt(f.offset, 10) || 0),
      pipeline: crm.pipeline(),
      compteurs: crm.compteursInspection()
    });
  });

  routeur.post('/api/v1/prospects', async (req, res) => {
    const ctx = contexte(req);
    if (!exigerPortee(ctx, 'prospects:ecrire', res)) return;
    const corps = await H.lireJson(req, 16 * 1024 * 1024);

    // Import en lot. L'entrée est passée à l'analyseur quelle qu'elle soit :
    // tableau JSON, objet unique, ou texte brut (CSV, TSV, NDJSON, liste
    // d'adresses). Les noms de champs sont reconnus par synonymes, donc un
    // export d'Hermès (`nom`, `emails[]`, `siteWeb`) entre sans conversion.
    const enLot = Array.isArray(corps.prospects) || typeof corps.texte === 'string';
    if (enLot) {
      const analyse = IMPORT.analyser(
        typeof corps.texte === 'string' ? corps.texte : corps.prospects);

      if (analyse.erreurGlobale) {
        H.json(res, 400, { erreur: analyse.erreurGlobale, format: analyse.format });
        return;
      }

      // Aperçu : on montre ce qui serait créé sans rien écrire. C'est ce qui
      // évite d'avoir à défaire un import raté.
      if (corps.apercu) {
        H.json(res, 200, {
          apercu: true, format: analyse.format, enTete: analyse.enTete, resume: analyse.resume,
          lignes: analyse.lignes.slice(0, 200)
        });
        return;
      }

      // Une seule transaction pour tout le lot : sur plusieurs milliers de
      // lignes, c'est la différence entre quelques secondes et plusieurs
      // minutes — donc entre un import qui aboutit et une requête qui expire.
      const rapport = Object.assign(
        { format: analyse.format, enTete: analyse.enTete },
        crm.importerEnLot(analyse.lignes, acteur(ctx)));
      // `erreurs` est conservé en alias de `rejetes` : des agents appellent déjà
      // cette API, leur réponse ne doit pas changer de forme sous leurs pieds.
      rapport.erreurs = rapport.rejetes;
      H.json(res, 201, rapport);
      return;
    }

    // Fiche unique : même normalisation, pour que l'API se comporte pareil
    // qu'on lui envoie une fiche ou mille.
    try {
      const analyse = IMPORT.analyser([corps]);
      const l = analyse.lignes[0];
      if (!l || !l.valide) {
        H.json(res, 400, { erreur: (l && l.erreurs.join(', ')) || 'fiche vide' });
        return;
      }
      const r = crm.creerProspect(l.prospect, acteur(ctx));
      H.json(res, r.doublon ? 200 : 201, Object.assign({}, r, { avertissements: l.avertissements }));
    } catch (e) {
      H.json(res, e.code || 500, { erreur: e.message });
    }
  });

  routeur.get('/api/v1/prospects/:id', (req, res, p) => {
    const ctx = contexte(req);
    if (!exigerPortee(ctx, 'prospects:lire', res)) return;
    const pr = crm.prospect(parseInt(p.id, 10));
    if (!pr) { H.json(res, 404, { erreur: 'inconnu' }); return; }
    H.json(res, 200, { prospect: pr });
  });

  routeur.patch('/api/v1/prospects/:id', async (req, res, p) => {
    const ctx = contexte(req);
    if (!exigerPortee(ctx, 'prospects:ecrire', res)) return;
    const corps = await H.lireJson(req);
    const pr = crm.majProspect(parseInt(p.id, 10), corps, acteur(ctx));
    if (!pr) { H.json(res, 404, { erreur: 'inconnu' }); return; }
    H.json(res, 200, { prospect: pr });
  });

  /*
   * Report d'une inspection de site. Route dédiée plutôt que PATCH, pour deux
   * raisons de fond : le détail se fusionne au lieu de s'écraser — une passe
   * muette ne doit pas effacer ce qu'une passe précédente avait trouvé — et
   * l'enrichissement est journalisé, pour qu'un commercial voie qu'un agent est
   * passé plutôt que des champs qui changent tout seuls.
   */
  routeur.post('/api/v1/prospects/:id/inspection', async (req, res, p) => {
    const ctx = contexte(req);
    if (!exigerPortee(ctx, 'prospects:ecrire', res)) return;
    const corps = await H.lireJson(req);
    const pr = crm.enrichir(parseInt(p.id, 10), corps, acteur(ctx));
    if (!pr) { H.json(res, 404, { erreur: 'inconnu' }); return; }
    H.json(res, 200, { prospect: pr });
  });

  /* --- coordonnées secondaires : autres e-mails, autres numéros --- */

  routeur.post('/api/v1/prospects/:id/coordonnees', async (req, res, p) => {
    const ctx = contexte(req);
    if (!exigerPortee(ctx, 'prospects:ecrire', res)) return;
    const corps = await H.lireJson(req);
    try {
      const pr = crm.ajouterCoordonnee(parseInt(p.id, 10), corps.type, corps.valeur,
        corps.libelle, acteur(ctx));
      if (!pr) { H.json(res, 404, { erreur: 'inconnu' }); return; }
      H.json(res, 201, { prospect: pr });
    } catch (e) {
      H.json(res, e.code || 500, { erreur: e.message });
    }
  });

  routeur.delete('/api/v1/coordonnees/:id', (req, res, p) => {
    const ctx = contexte(req);
    if (!exigerPortee(ctx, 'prospects:ecrire', res)) return;
    const pr = crm.supprimerCoordonnee(parseInt(p.id, 10), acteur(ctx));
    if (!pr) { H.json(res, 404, { erreur: 'inconnu' }); return; }
    H.json(res, 200, { prospect: pr });
  });

  routeur.post('/api/v1/coordonnees/:id/principale', (req, res, p) => {
    const ctx = contexte(req);
    if (!exigerPortee(ctx, 'prospects:ecrire', res)) return;
    const pr = crm.definirPrincipale(parseInt(p.id, 10), acteur(ctx));
    if (!pr) { H.json(res, 404, { erreur: 'inconnu' }); return; }
    H.json(res, 200, { prospect: pr });
  });

  routeur.post('/api/v1/prospects/:id/activite', async (req, res, p) => {
    const ctx = contexte(req);
    if (!exigerPortee(ctx, 'activites:ecrire', res)) return;
    const corps = await H.lireJson(req);
    const pr = crm.journaliser(parseInt(p.id, 10), corps.type, corps.corps, acteur(ctx));
    if (!pr) { H.json(res, 404, { erreur: 'inconnu' }); return; }
    H.json(res, 201, { prospect: pr });
  });

  routeur.get('/api/v1/tableau-de-bord', (req, res) => {
    const ctx = contexte(req);
    if (!exigerPortee(ctx, 'clients:lire', res)) return;
    const liste = clients.lister();
    const actifs = liste.filter((c) => c.etat.actif);
    const enEssai = liste.filter((c) => c.etat.statut === 'essai');
    const payants = liste.filter((c) => c.etat.statut === 'actif');
    H.json(res, 200, {
      clients: { total: liste.length, actifs: actifs.length, essai: enEssai.length, payants: payants.length },
      // Revenu annuel récurrent : la somme des formules effectivement payées
      arrHT: payants.reduce((s, c) => s + billing.formule(c.formule).prixHTAn, 0),
      pipeline: crm.pipeline(),
      aFaire: crm.aFaire(20),
      essaisQuiFinissent: enEssai
        .filter((c) => c.etat.joursRestants !== null && c.etat.joursRestants <= 7)
        .map(resumeClient),
      derniersLeads: crm.tousLesLeads(15)
    });
  });

  /* --- jetons d'agents --- */

  routeur.get('/api/v1/jetons', (req, res) => {
    const ctx = contexte(req);
    if (!ctx || ctx.type !== 'operateur') { H.json(res, 403, { erreur: 'réservé aux opérateurs' }); return; }
    H.json(res, 200, { jetons: auth.listerJetons(), profils: Object.keys(authLib.PROFILS) });
  });

  routeur.post('/api/v1/jetons', async (req, res) => {
    const ctx = contexte(req);
    if (!ctx || ctx.type !== 'operateur') { H.json(res, 403, { erreur: 'réservé aux opérateurs' }); return; }
    const corps = await H.lireJson(req);
    try {
      const j = auth.creerJetonApi(corps.libelle, corps.profil);
      H.json(res, 201, { jeton: j.secret, profil: j.profil, portees: j.portees,
        avertissement: 'Ce jeton n’est affiché qu’une fois.' });
    } catch (e) {
      H.json(res, 400, { erreur: e.message });
    }
  });

  routeur.delete('/api/v1/jetons/:id', (req, res, p) => {
    const ctx = contexte(req);
    if (!ctx || ctx.type !== 'operateur') { H.json(res, 403, { erreur: 'réservé aux opérateurs' }); return; }
    auth.revoquerJeton(parseInt(p.id, 10));
    H.json(res, 200, { ok: true });
  });

  /* --- pilotage des agents --- */

  // L'agent lit son propre état avant chaque tâche : actif → il travaille,
  // pause → il termine ce qui est en cours puis s'arrête.
  routeur.get('/api/v1/agent/etat', (req, res) => {
    const ctx = contexte(req);
    if (!ctx) { H.json(res, 401, { erreur: 'non authentifié' }); return; }
    const u = new URL(req.url, 'http://x');
    const profil = ctx.type === 'agent' ? ctx.agent.profil : (u.searchParams.get('profil') || 'prospection');
    H.json(res, 200, { etat: agents.etat(profil) });
  });

  // Bascule actif/pause — réservé aux opérateurs (bouton de la console).
  routeur.post('/api/v1/agent/etat', async (req, res) => {
    const ctx = contexte(req);
    if (!ctx || ctx.type !== 'operateur') { H.json(res, 403, { erreur: 'réservé aux opérateurs' }); return; }
    const corps = await H.lireJson(req);
    const profil = corps.profil || 'prospection';
    H.json(res, 200, { etat: agents.basculer(profil, corps.actif !== false) });
  });

  // L'agent signale un passage : type, fiches traitées, tokens LLM consommés.
  routeur.post('/api/v1/agent/executions', async (req, res) => {
    const ctx = contexte(req);
    if (!exigerPortee(ctx, 'activites:ecrire', res)) return;
    const corps = await H.lireJson(req);
    const profil = ctx.type === 'agent' ? ctx.agent.profil : (corps.profil || 'prospection');
    agents.journaliser(profil, corps.type, corps.taches, corps.tokens, corps.detail);
    H.json(res, 201, { ok: true });
  });

  // Le panneau : KPI + journal des exécutions + état, réservé aux opérateurs.
  routeur.get('/api/v1/agent/tableau', (req, res) => {
    const ctx = contexte(req);
    if (!ctx || ctx.type !== 'operateur') { H.json(res, 403, { erreur: 'réservé aux opérateurs' }); return; }
    H.json(res, 200, {
      kpis: agents.kpis(),
      executions: agents.executions(null, 100),
      etat: agents.etat('prospection')
    });
  });

  routeur.get('/api/v1/commandes', (req, res) => {
    const ctx = contexte(req);
    if (!exigerPortee(ctx, 'abonnement:gerer', res)) return;
    H.json(res, 200, { commandes: stCommandes.lister.all(), mode: paiement.mode });
  });

  routeur.post('/api/v1/commandes/:id/payee', (req, res, p) => {
    const ctx = contexte(req);
    if (!exigerPortee(ctx, 'abonnement:gerer', res)) return;
    const cmd = db.prepare('SELECT * FROM commandes WHERE id = ?').get(parseInt(p.id, 10));
    if (!cmd) { H.json(res, 404, { erreur: 'inconnue' }); return; }
    stCommandes.payer.run('paye', dbLib.nowIso(), cmd.id);
    const c = clients.parId(cmd.client_id);
    if (c) clients.activer(c, billing.FORMULES.abonnementMois);
    H.json(res, 200, { ok: true, client: c ? detailClient(clients.parId(cmd.client_id)) : null });
  });

  /* ================= Console ================= */

  routeur.get('/', (req, res) => H.redirige(res, '/console'));
  routeur.get('/console', (req, res) => {
    const f = path.join(publicDir, 'console.html');
    H.html(res, 200, fs.readFileSync(f, 'utf8'), { 'Cache-Control': 'no-store' }, req);
  });

  /* ================= Assemblage ================= */

  function resumeClient(c) {
    return {
      cle: c.cle, slug: c.slug, nom: c.nom, formule: c.formule, statut: c.etat.statut,
      actif: c.etat.actif, joursRestants: c.etat.joursRestants, motif: c.etat.motif,
      domaines: c.domaines, maj_le: c.maj_le
    };
  }
  function detailClient(c) {
    return Object.assign(resumeClient(c), {
      config: dbLib.json(c.config, {}),
      essai_fin: c.essai_fin,
      abonnement_fin: c.abonnement_fin,
      extraits: widgetLib.extraits(cfg.base, c),
      urls: {
        widget: cfg.base + '/w/' + c.cle,
        script: cfg.base + '/w/' + c.cle + '.js',
        partage: cfg.base + '/s/' + c.cle,
        abonnement: cfg.base + '/abonnement/' + c.cle
      },
      stats: crm.statsClient(c.id, 30),
      pages: stPages.duClient.all(c.id)
    });
  }

  function pageAbonnement(client) {
    const e = H.echapper;
    // Un client au palier gratuit se voit proposer la première formule payante :
    // « s'abonner pour 0 € » n'a pas de sens, et c'est justement lui qu'il faut
    // convertir.
    const f = billing.formuleAAbonner(client.formule);
    const etat = client.etat;
    return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Abonnement — ${e(client.nom)}</title>
<style>body{font-family:system-ui,Segoe UI,Arial,sans-serif;background:#eef1f5;margin:0;padding:28px 16px;color:#16202b}
.c{max-width:640px;margin:0 auto;background:#fff;border:1px solid #e3e8ee;border-radius:14px;padding:26px}
h1{font-size:22px;color:#0f2a43;margin:0 0 6px}.etat{display:inline-block;padding:4px 11px;border-radius:999px;
font-size:12.5px;font-weight:700;background:#fef3c7;color:#92400e}.etat.ok{background:#dcfce7;color:#166534}
.prix{font-size:34px;font-weight:800;color:#0f2a43;margin:16px 0 2px}.prix small{font-size:14px;font-weight:600;color:#51606f}
ul{padding-left:20px;color:#51606f;font-size:14.5px;line-height:1.7}
button{width:100%;padding:14px;font-size:16px;font-weight:800;background:#f59e0b;color:#fff;border:0;
border-radius:10px;cursor:pointer;margin-top:16px}button:hover{background:#d97706}
.note{font-size:12.5px;color:#8a97a5;margin-top:14px;line-height:1.5}
#msg{margin-top:14px;font-size:14px}</style></head><body><div class="c">
<h1>${e(client.nom)}</h1>
<span class="etat ${etat.actif ? 'ok' : ''}">${e(etat.statut)}${etat.joursRestants !== null ? ' — ' + etat.joursRestants + ' j restants' : ''}</span>
<div class="prix">${f.prixHTAn} € <small>HT / an — formule ${e(f.nom)}</small></div>
<p style="color:#51606f;margin:2px 0 0">${e(f.accroche)}</p>
<ul>${f.inclus.map((i) => '<li>' + e(i) + '</li>').join('')}</ul>
<button id="b">S’abonner pour 12 mois</button>
<div id="msg"></div>
<p class="note">Prix HT, reconductible sur décision. Un chantier 8 kWc signé représente environ
3 000 à 4 000 € de marge brute : l’abonnement est remboursé par une fraction de chantier.</p>
</div>
<script>
document.getElementById('b').onclick = async function(){
  this.disabled = true; this.textContent = 'Traitement…';
  var m = document.getElementById('msg');
  try {
    var r = await fetch('/api/public/abonnement/${e(client.cle)}', { method:'POST',
      headers:{'Content-Type':'application/json'}, body: JSON.stringify({ formule: ${JSON.stringify(f.id)} }) });
    var j = await r.json();
    if (j.url) { location.href = j.url; return; }
    m.innerHTML = j.instructions ? '<b>✓ Commande enregistrée.</b><br>' + j.instructions
      : ('Erreur : ' + (j.erreur || 'inconnue'));
  } catch(e){ m.textContent = 'Erreur réseau : ' + e.message; }
  this.disabled = false; this.textContent = 'S’abonner pour 12 mois';
};
</script></body></html>`;
  }

  const serveur = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      const r = routeur.resoudre(req.method, url.pathname);
      if (r) { await r.gestionnaire(req, res, r.params); return; }
      if (url.pathname.indexOf('/public/') === 0) {
        if (H.servirStatique(res, publicDir, url.pathname.slice(8))) return;
      }
      if (routeur.autreMethode(url.pathname)) { H.json(res, 405, { erreur: 'méthode non autorisée' }); return; }
      H.json(res, 404, { erreur: 'introuvable' });
    } catch (e) {
      if (!res.headersSent) H.json(res, e.code || 500, { erreur: e.message || 'erreur interne' });
      else res.end();
    }
  });

  serveur.evasimu = { db, auth, clients, crm, cfg, billing, paiement };
  return serveur;
}

if (require.main === module) {
  const port = parseInt(process.env.PORT, 10) || 8080;
  const app = creerApp();
  // Premier démarrage : on crée un compte administrateur et on affiche son mot
  // de passe une seule fois, plutôt que de livrer un identifiant par défaut.
  if (app.evasimu.auth.aucunOperateur()) {
    const email = process.env.EVASIMU_ADMIN || 'admin@evasimu.fr';
    const mdp = require('crypto').randomBytes(9).toString('base64url');
    app.evasimu.auth.creerOperateur(email, 'Administrateur', mdp, 'admin');
    console.log('\n  Compte administrateur créé');
    console.log('  e-mail        : ' + email);
    console.log('  mot de passe  : ' + mdp + '   ← notez-le, il ne sera plus affiché\n');
  }
  app.listen(port, () => {
    console.log('SaaS EVASIMU démarré : http://localhost:' + port + '/console');
    console.log('  base publique : ' + app.evasimu.cfg.base);
    console.log('  paiement      : ' + app.evasimu.paiement.mode);
  });
  const stop = () => { console.log('\nArrêt…'); app.close(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { creerApp };
