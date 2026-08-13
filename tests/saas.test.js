/**
 * Tests du SaaS — exécution : node tests/saas.test.js
 *
 * Le serveur est démarré en mémoire (SQLite :memory:) : aucun fichier créé,
 * aucun réseau sortant, exécutable en CI.
 */
'use strict';

const http = require('http');
const assert = require('assert');
const { creerApp } = require('../saas/server.js');
const clientsLib = require('../saas/lib/clients.js');
const billing = require('../saas/lib/billing.js');

let passed = 0, failed = 0;
function check(nom, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + nom); }
  else { failed++; console.error('  ✗ ' + nom + (detail ? ' — ' + detail : '')); }
}

function requete(port, methode, chemin, options) {
  const o = options || {};
  const corps = o.body === undefined ? null
    : (typeof o.body === 'string' ? o.body : JSON.stringify(o.body));
  return new Promise((resolve, reject) => {
    const entetes = Object.assign({}, o.headers);
    if (corps) {
      entetes['Content-Type'] = entetes['Content-Type'] || 'application/json';
      entetes['Content-Length'] = Buffer.byteLength(corps);
    }
    const req = http.request({ host: '127.0.0.1', port, method: methode, path: chemin, headers: entetes },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(b); } catch (e) { /* html */ }
          resolve({ status: res.statusCode, headers: res.headers, json: j, body: b });
        });
      });
    req.on('error', reject);
    if (corps) req.write(corps);
    req.end();
  });
}

(async () => {
  console.log('Formules et cycle de vie');
  {
    const c = { statut: 'essai', essai_fin: billing.dansNJours(5), formule: 'essentiel' };
    check('essai en cours → actif', billing.etat(c).actif && billing.etat(c).statut === 'essai');
    check('jours restants comptés', billing.etat(c).joursRestants === 5, String(billing.etat(c).joursRestants));

    const fini = { statut: 'essai', essai_fin: billing.dansNJours(-1) };
    check('essai terminé → coupé', !billing.etat(fini).actif && billing.etat(fini).statut === 'expire');

    const abo = { statut: 'actif', abonnement_fin: billing.dansNMois(6) };
    check('abonnement en cours → actif', billing.etat(abo).actif);
    const aboFini = { statut: 'actif', abonnement_fin: billing.dansNJours(-2) };
    check('abonnement échu → coupé', !billing.etat(aboFini).actif);

    const susp = { statut: 'suspendu', abonnement_fin: billing.dansNMois(6) };
    check('suspension prime sur l’abonnement', !billing.etat(susp).actif,
      'un client suspendu ne doit pas rester en ligne');

    check('trois formules tarifées', billing.FORMULES.formules.length === 3);
    check('essai par défaut à 30 jours', billing.FORMULES.essaiJoursDefaut === 30);
  }

  console.log('Thème');
  {
    const css = clientsLib.cssDuTheme({ couleurPrincipale: '#123456', couleurAccent: '#ffcc00' });
    check('variables CSS produites', /--rdfsim-navy:#123456/.test(css) && /--rdfsim-accent:#ffcc00/.test(css));
    check('déclinaison foncée de l’accent calculée', /--rdfsim-accent-deep:#[0-9a-f]{6}/.test(css));
    check('couleur invalide → valeur par défaut',
      /--rdfsim-navy:#0f2a43/.test(clientsLib.cssDuTheme({ couleurPrincipale: 'javascript:alert(1)' })));
    check('texte foncé sur accent clair', clientsLib.texteLisibleSur('#ffcc00') === '#16202b');
    check('texte blanc sur accent sombre', clientsLib.texteLisibleSur('#0f2a43') === '#ffffff');
    check('logo javascript: refusé', clientsLib.urlSure('javascript:alert(1)') === '');
    check('logo https accepté', clientsLib.urlSure('https://x.fr/l.png') === 'https://x.fr/l.png');
    check('logo data:image accepté', clientsLib.urlSure('data:image/png;base64,iVBORw0KGgo=') !== '');
    check('webhook http (non chiffré) écarté',
      clientsLib.normaliserConfig({ marque: { devisEndpoint: 'http://x.fr/h' } }).marque.devisEndpoint === undefined);
  }

  console.log('Serveur');
  const app = creerApp({ db: ':memory:', base: 'http://127.0.0.1:0' });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const port = app.address().port;
  app.rdf.cfg.base = 'http://127.0.0.1:' + port;
  app.rdf.auth.creerOperateur('op@test.fr', 'Op', 'mot-de-passe-solide', 'admin');

  let cookie = '';
  {
    const ko = await requete(port, 'POST', '/api/v1/connexion', { body: { email: 'op@test.fr', motDePasse: 'faux' } });
    check('mauvais mot de passe → 401', ko.status === 401);

    const ok = await requete(port, 'POST', '/api/v1/connexion', { body: { email: 'op@test.fr', motDePasse: 'mot-de-passe-solide' } });
    check('connexion → 200 + cookie', ok.status === 200 && /rdf_session=/.test(String(ok.headers['set-cookie'])));
    cookie = String(ok.headers['set-cookie'])[0] === undefined ? '' : String(ok.headers['set-cookie']).split(';')[0];

    const sans = await requete(port, 'GET', '/api/v1/clients');
    check('API protégée sans session → 401', sans.status === 401);
  }
  const auth = { headers: { Cookie: cookie } };

  let cle = null;
  {
    const r = await requete(port, 'POST', '/api/v1/clients',
      Object.assign({ body: { nom: 'Solaire du Vexin', domaines: 'solaire-vexin.fr', essaiJours: 30 } }, auth));
    check('création d’un client → 201', r.status === 201, String(r.status));
    cle = r.json.client.cle;
    check('clé publique générée', /^[a-z2-9]{10}$/.test(cle), cle);
    check('extraits d’intégration fournis', !!r.json.client.extraits.script.code);
    check('l’extrait contient la clé', r.json.client.extraits.script.code.indexOf(cle) !== -1);
    check('client en essai 30 jours', r.json.client.statut === 'essai' && r.json.client.joursRestants === 30,
      r.json.client.statut + '/' + r.json.client.joursRestants);
  }

  {
    const js = await requete(port, 'GET', '/w/' + cle + '.js');
    check('script d’intégration servi', js.status === 200 && /iframe/.test(js.body));
    check('script ouvert à tous les sites (CORS)', js.headers['access-control-allow-origin'] === '*');

    const page = await requete(port, 'GET', '/w/' + cle);
    check('page du widget servie', page.status === 200 && /RDFSolarSim\.mount/.test(page.body));
    check('moteur du simulateur embarqué', /rdf-solar-engine|estimateProduction/.test(page.body));
    check('frame-ancestors limité au domaine déclaré',
      /frame-ancestors[^;]*solaire-vexin\.fr/.test(page.headers['content-security-policy'] || ''),
      page.headers['content-security-policy']);
    check('les leads pointent vers le SaaS',
      page.body.indexOf('/api/public/lead/' + cle) !== -1);

    const cfg = await requete(port, 'GET', '/w/' + cle + '/config.json');
    check('catalogue exposé', cfg.status === 200 && cfg.json.tarifs.tarifRachatSurplus === 0.011);
    check('barème réglementaire hérité de la référence', cfg.json.tarifs.tva.reduit === 0.055);
  }

  console.log('Personnalisation');
  {
    const r = await requete(port, 'PATCH', '/api/v1/clients/' + cle, Object.assign({
      body: {
        config: {
          theme: { couleurPrincipale: '#7c2d12', couleurAccent: '#22c55e', arrondi: 4 },
          marque: { name: 'Vexin Solaire', phone: '02 32 11 22 33', accroche: 'Le solaire dans l’Eure' }
        }
      }
    }, auth));
    check('personnalisation enregistrée → 200', r.status === 200);
    const page = await requete(port, 'GET', '/w/' + cle);
    check('couleurs appliquées à la page', /--rdfsim-navy:#7c2d12/.test(page.body) && /--rdfsim-accent:#22c55e/.test(page.body));
    check('nom de marque dans le catalogue servi', /Vexin Solaire/.test(page.body));
    check('accroche transmise', /Le solaire dans l/.test(page.body));

    const inject = await requete(port, 'PATCH', '/api/v1/clients/' + cle, Object.assign({
      body: { config: { marque: { name: '</script><img src=x onerror=alert(1)>', accroche: '</style><b>x' } } }
    }, auth));
    const p2 = await requete(port, 'GET', '/w/' + cle);
    check('nom injecté échappé dans le titre', p2.body.indexOf('<title></script>') === -1, 'échappement du titre');
    // Le catalogue est injecté dans un bloc <script> : une valeur contenant
    // « </script> » y fermerait la balise et exécuterait ce qui suit.
    check('aucune fermeture de <script> introduite par le catalogue',
      (p2.body.match(/<\/script/gi) || []).length === 2,
      String((p2.body.match(/<\/script/gi) || []).length) + ' fermetures (2 attendues)');
    check('sources du simulateur sans fermeture parasite',
      p2.body.indexOf('<\\/script') !== -1, 'les « </script » du code sont neutralisés');
    check('accroche injectée neutralisée', p2.body.indexOf('</style><b>x') === -1);
    await requete(port, 'PATCH', '/api/v1/clients/' + cle,
      Object.assign({ body: { config: { marque: { name: 'Vexin Solaire' } } } }, auth));
  }

  console.log('Interrupteur du widget');
  {
    await requete(port, 'POST', '/api/v1/clients/' + cle + '/suspendre', Object.assign({ body: {} }, auth));
    const js = await requete(port, 'GET', '/w/' + cle + '.js');
    check('widget coupé : le script ne monte rien', js.status === 200 && !/iframe/.test(js.body));
    const page = await requete(port, 'GET', '/w/' + cle);
    check('page remplacée par un message', /indisponible/i.test(page.body));
    const cfg = await requete(port, 'GET', '/w/' + cle + '/config.json');
    check('catalogue refusé (402)', cfg.status === 402);

    await requete(port, 'POST', '/api/v1/clients/' + cle + '/reprendre', Object.assign({ body: {} }, auth));
    const js2 = await requete(port, 'GET', '/w/' + cle + '.js');
    check('rétablissement immédiat', /iframe/.test(js2.body));

    const act = await requete(port, 'POST', '/api/v1/clients/' + cle + '/activer',
      Object.assign({ body: { mois: 12 } }, auth));
    check('activation 12 mois', act.json.client.statut === 'actif' && act.json.client.joursRestants > 360,
      String(act.json.client.joursRestants));
  }

  console.log('Leads');
  {
    const sansConsentement = await requete(port, 'POST', '/api/public/lead/' + cle,
      { body: { nom: 'Jean', telephone: '0612345678' } });
    check('lead sans consentement refusé', sansConsentement.status === 400, String(sansConsentement.status));

    const ok = await requete(port, 'POST', '/api/public/lead/' + cle, {
      body: {
        type: 'demande_devis', reference: 'SIM-1', nom: 'Jean Dupont', telephone: '0612345678',
        consentement: { donne: true, horodatage: new Date().toISOString() },
        simulation: { kwc: 8.9, productionKwhAn: 10226 }
      }
    });
    check('lead avec consentement accepté', ok.status === 201, String(ok.status));

    const liste = await requete(port, 'GET', '/api/v1/clients/' + cle + '/leads', auth);
    check('lead visible dans la console', liste.json.leads.length === 1 && liste.json.leads[0].nom === 'Jean Dupont');
    check('simulation conservée', liste.json.leads[0].charge.simulation.kwc === 8.9);
  }

  console.log('Pages SEO locales');
  {
    const r = await requete(port, 'POST', '/api/v1/clients/' + cle + '/pages',
      Object.assign({ body: { ville: 'Louviers', departement: 'Eure' } }, auth));
    check('page créée → 201', r.status === 201, String(r.status));
    const slug = r.json.pages[0].slug;
    check('slug lisible', /louviers/.test(slug), slug);

    const page = await requete(port, 'GET', '/p/' + slug);
    check('page servie', page.status === 200);
    check('titre localisé', /<title>[^<]*Louviers/.test(page.body));
    check('meta description présente', /<meta name="description" content="[^"]{60,}"/.test(page.body));
    check('canonique renseignée', /<link rel="canonical"/.test(page.body));
    check('LocalBusiness structuré', /"@type":"LocalBusiness"/.test(page.body));
    check('FAQ structurée', /"@type":"FAQPage"/.test(page.body));
    check('fil d’Ariane structuré', /"@type":"BreadcrumbList"/.test(page.body));
    check('widget intégré à la page', page.body.indexOf('/w/' + cle + '.js') !== -1);
    check('open graph renseigné', /property="og:title"/.test(page.body));

    const sm = await requete(port, 'GET', '/sitemap.xml');
    check('sitemap liste la page', sm.status === 200 && sm.body.indexOf('/p/' + slug) !== -1);
    const rb = await requete(port, 'GET', '/robots.txt');
    check('robots.txt renvoie au sitemap', /Sitemap:/.test(rb.body) && /Disallow: \/console/.test(rb.body));

    // Un client coupé ne doit plus être indexé
    await requete(port, 'POST', '/api/v1/clients/' + cle + '/suspendre', Object.assign({ body: {} }, auth));
    const sm2 = await requete(port, 'GET', '/sitemap.xml');
    check('client coupé : page retirée du sitemap', sm2.body.indexOf('/p/' + slug) === -1);
    const p404 = await requete(port, 'GET', '/p/' + slug);
    check('client coupé : page non servie', p404.status === 404);
    await requete(port, 'POST', '/api/v1/clients/' + cle + '/reprendre', Object.assign({ body: {} }, auth));
  }

  console.log('Partage et abonnement');
  {
    const s = await requete(port, 'GET', '/s/' + cle);
    check('page de partage servie', s.status === 200);
    check('carte sociale complète', /og:title/.test(s.body) && /twitter:card/.test(s.body));

    const a = await requete(port, 'GET', '/abonnement/' + cle);
    check('page d’abonnement servie', a.status === 200 && /590 €/.test(a.body), '590 € attendu');

    const cmd = await requete(port, 'POST', '/api/public/abonnement/' + cle, { body: { formule: 'essentiel' } });
    check('commande enregistrée sans Stripe', cmd.status === 200 && cmd.json.mode === 'bon_de_commande');
    check('aucun paiement simulé', !cmd.json.url && cmd.json.montantHT === 590);

    const liste = await requete(port, 'GET', '/api/v1/commandes', auth);
    check('commande visible en facturation', liste.json.commandes.length === 1);
    const paye = await requete(port, 'POST', '/api/v1/commandes/' + liste.json.commandes[0].id + '/payee',
      Object.assign({ body: {} }, auth));
    check('paiement confirmé → client actif', paye.json.client.statut === 'actif');
  }

  console.log('CRM');
  {
    const r = await requete(port, 'POST', '/api/v1/prospects',
      Object.assign({ body: { entreprise: 'Élec du Bocage', ville: 'Vernon', site: 'https://elec-bocage.fr/' } }, auth));
    check('prospect créé', r.status === 201);
    const id = r.json.prospect.id;
    check('site normalisé', r.json.prospect.site === 'elec-bocage.fr', r.json.prospect.site);

    const doublon = await requete(port, 'POST', '/api/v1/prospects',
      Object.assign({ body: { entreprise: 'Élec du Bocage (bis)', site: 'elec-bocage.fr' } }, auth));
    check('doublon détecté par le site', doublon.json.doublon === true);

    const lot = await requete(port, 'POST', '/api/v1/prospects', Object.assign({
      body: { prospects: [{ entreprise: 'A', site: 'a.fr' }, { entreprise: 'B', site: 'b.fr' }, { site: 'sans-nom.fr' }] }
    }, auth));
    check('import en lot compté', lot.json.crees === 2 && lot.json.erreurs === 1,
      JSON.stringify(lot.json));

    await requete(port, 'PATCH', '/api/v1/prospects/' + id, Object.assign({ body: { statut: 'contacte' } }, auth));
    const fiche = await requete(port, 'GET', '/api/v1/prospects/' + id, auth);
    check('changement de statut journalisé',
      fiche.json.prospect.activites.some((a) => a.type === 'statut' && /contacte/.test(a.corps)));

    const filtre = await requete(port, 'GET', '/api/v1/prospects?statut=contacte', auth);
    check('filtre par statut', filtre.json.prospects.length === 1);
    const recherche = await requete(port, 'GET', '/api/v1/prospects?q=bocage', auth);
    check('recherche plein texte', recherche.json.prospects.length === 1);
  }

  console.log('Agents Hermès');
  {
    const jetons = {};
    for (const profil of ['prospection', 'ventes', 'secretariat']) {
      const r = await requete(port, 'POST', '/api/v1/jetons',
        Object.assign({ body: { libelle: 'Hermès ' + profil, profil } }, auth));
      check('jeton ' + profil + ' créé', r.status === 201 && /^hrm_/.test(r.json.jeton));
      jetons[profil] = r.json.jeton;
    }
    const entete = (j) => ({ headers: { Authorization: 'Bearer ' + j } });

    const moi = await requete(port, 'GET', '/api/v1/moi', entete(jetons.ventes));
    check('agent reconnu', moi.status === 200 && moi.json.type === 'agent' && moi.json.identite.profil === 'ventes');

    const p = await requete(port, 'POST', '/api/v1/prospects',
      Object.assign({ body: { entreprise: 'Toiture & Soleil', ville: 'Évreux' } }, entete(jetons.prospection)));
    check('agent prospection peut créer un prospect', p.status === 201);

    const interdit = await requete(port, 'POST', '/api/v1/clients/' + cle + '/activer',
      Object.assign({ body: { mois: 12 } }, entete(jetons.prospection)));
    check('agent prospection ne peut PAS activer un abonnement', interdit.status === 403, String(interdit.status));

    const permis = await requete(port, 'POST', '/api/v1/clients/' + cle + '/essai',
      Object.assign({ body: { jours: 7 } }, entete(jetons.ventes)));
    check('agent ventes peut démarrer un essai de 7 jours',
      permis.status === 200 && permis.json.client.joursRestants === 7, String(permis.status));

    const sec = await requete(port, 'DELETE', '/api/v1/clients/' + cle, entete(jetons.secretariat));
    check('agent secrétariat ne peut pas supprimer un client', sec.status === 403);

    const faux = await requete(port, 'GET', '/api/v1/clients', entete('hrm_vent_faux'));
    check('jeton inconnu rejeté', faux.status === 401);

    const liste = await requete(port, 'GET', '/api/v1/jetons', auth);
    const idJeton = liste.json.jetons[0].id;
    await requete(port, 'DELETE', '/api/v1/jetons/' + idJeton, auth);
    const apresRevocation = await requete(port, 'GET', '/api/v1/moi', entete(jetons.secretariat));
    check('jeton révoqué inutilisable', apresRevocation.status === 401, String(apresRevocation.status));
  }

  console.log('Tableau de bord');
  {
    const d = await requete(port, 'GET', '/api/v1/tableau-de-bord', auth);
    check('compteurs présents', d.json.clients.total === 1);
    check('pipeline renvoyé', Array.isArray(d.json.pipeline) && d.json.pipeline.length === 7);
    check('revenu annuel calculé', typeof d.json.arrHT === 'number');
    check('derniers leads exposés', d.json.derniersLeads.length === 1);
  }

  console.log('Performance');
  {
    const sans = await requete(port, 'GET', '/w/' + cle);
    const avec = await requete(port, 'GET', '/w/' + cle, { headers: { 'Accept-Encoding': 'gzip' } });
    check('page compressée quand le navigateur l’accepte',
      avec.headers['content-encoding'] === 'gzip', String(avec.headers['content-encoding']));
    check('gain de compression conséquent',
      Number(avec.headers['content-length']) < Number(sans.headers['content-length']) / 3,
      Math.round(sans.headers['content-length'] / 1024) + ' Ko → ' +
      Math.round(avec.headers['content-length'] / 1024) + ' Ko');
    check('Vary: Accept-Encoding annoncé', /Accept-Encoding/i.test(avec.headers.vary || ''));
    check('brotli préféré quand il est proposé',
      (await requete(port, 'GET', '/w/' + cle, { headers: { 'Accept-Encoding': 'br, gzip' } }))
        .headers['content-encoding'] === 'br');
    check('client sans compression servi en clair', !sans.headers['content-encoding']);

    const t0 = Date.now();
    for (let i = 0; i < 5; i++) await requete(port, 'GET', '/w/' + cle, { headers: { 'Accept-Encoding': 'gzip' } });
    check('5 pages servies rapidement (cache par client)', Date.now() - t0 < 3000,
      (Date.now() - t0) + ' ms');
  }

  console.log('Sécurité');
  {
    const trav = await requete(port, 'GET', '/public/../../package.json');
    check('traversée de répertoire bloquée', trav.status === 404 || trav.status === 403, String(trav.status));
    const inconnu = await requete(port, 'GET', '/w/inexistant/config.json');
    check('client inconnu → 404', inconnu.status === 404);
    const methode = await requete(port, 'DELETE', '/robots.txt');
    check('mauvaise méthode → 405', methode.status === 405, String(methode.status));
  }

  app.close();
  console.log('\n' + passed + ' tests réussis, ' + failed + ' échec(s)');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
