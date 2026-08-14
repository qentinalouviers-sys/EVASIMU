/**
 * Tests du SaaS — exécution : node tests/saas.test.js
 *
 * Le serveur est démarré en mémoire (SQLite :memory:) : aucun fichier créé,
 * aucun réseau sortant, exécutable en CI.
 */
'use strict';

const fs = require('fs');
const path = require('path');
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
  console.log('Migration d’une base existante');
  {
    // Le cas qui compte : une base de production au schéma v1, avec des fiches
    // dedans. Une migration qui perdrait ces lignes serait irréparable — il n'y
    // a pas de « annuler » sur un ALTER TABLE joué en production.
    const { DatabaseSync } = require('node:sqlite');
    const { MIGRATIONS, migrer } = require('../saas/lib/db.js');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
    db.exec(MIGRATIONS[0]);
    db.prepare('INSERT INTO schema_version(version) VALUES(1)').run();
    const t = new Date().toISOString();
    for (let i = 1; i <= 114; i++) {
      db.prepare('INSERT INTO prospects(entreprise, email, statut, cree_le, maj_le) VALUES(?,?,?,?,?)')
        .run('Prospect ' + i, 'p' + i + '@x.fr', 'nouveau', t, t);
    }

    migrer(db);
    const colonnes = db.prepare('PRAGMA table_info(prospects)').all().map((c) => c.name);
    check('les fiches existantes survivent',
      db.prepare('SELECT COUNT(*) n FROM prospects').get().n === 114);
    check('le schéma passe en v' + MIGRATIONS.length,
      db.prepare('SELECT version FROM schema_version').get().version === MIGRATIONS.length);
    check('les colonnes d’enrichissement sont là',
      ['simulateur_niveau', 'cible', 'inspecte_le', 'enseigne', 'couleur', 'enrichissement']
        .every((c) => colonnes.includes(c)), colonnes.join(','));
    const p1 = db.prepare('SELECT * FROM prospects WHERE id = 1').get();
    check('les données d’origine sont intactes', p1.entreprise === 'Prospect 1' && p1.email === 'p1@x.fr');
    check('les fiches d’avant sont « jamais inspectées », pas « rien trouvé »',
      p1.simulateur_niveau === null && p1.inspecte_le === null);
    check('le détail par défaut est un JSON valide', p1.enrichissement === '{}');

    migrer(db);
    check('rejouer la migration ne change rien',
      db.prepare('SELECT version FROM schema_version').get().version === MIGRATIONS.length &&
      db.prepare('SELECT COUNT(*) n FROM prospects').get().n === 114);
    db.close();
  }

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

  console.log('Palier gratuit : quota, rétention, libération');
  {
    // Un client au palier Découverte. Le quota se compte sur le mois en cours,
    // et le dépassement ne doit jamais faire perdre la personne qui a rempli
    // le formulaire — c'est un client réel de l'installateur.
    const r = await requete(port, 'POST', '/api/v1/clients',
      Object.assign({ body: { nom: 'Toiture Libre', domaines: 'toiture-libre.fr', formule: 'decouverte' } }, auth));
    const cleG = r.json.client.cle;
    const quota = billing.quotaLeads('decouverte');
    check('le palier gratuit a bien un quota', quota === 5, String(quota));

    async function poser(n) {
      return requete(port, 'POST', '/api/public/lead/' + cleG, {
        body: {
          type: 'demande_devis', nom: 'Visiteur ' + n, telephone: '060000000' + n,
          email: 'v' + n + '@exemple.fr', ville: 'Louviers', puissanceKwc: 6.4,
          consentement: { donne: true, horodatage: new Date().toISOString() }
        }
      });
    }
    const reponses = [];
    for (let i = 1; i <= quota + 2; i++) reponses.push(await poser(i));
    check('aucun lead n’est refusé, même au-delà du quota',
      reponses.every((x) => x.status === 201),
      reponses.map((x) => x.status).join(','));

    const l = (await requete(port, 'GET', '/api/v1/clients/' + cleG + '/leads', auth)).json.leads;
    check('tous les leads sont enregistrés', l.length === quota + 2, String(l.length));
    const retenus = l.filter((x) => x.retenu);
    const livres = l.filter((x) => !x.retenu);
    check('les cinq premiers sont livrés entiers',
      livres.length === quota && livres.every((x) => x.nom && x.telephone),
      livres.length + ' livrés');
    check('les suivants sont retenus', retenus.length === 2, String(retenus.length));
    check('un lead retenu ne livre aucune coordonnée',
      retenus.every((x) => !x.nom && !x.telephone && !x.email));
    check('il montre quand même ce qu’on laisse passer',
      retenus.every((x) => x.charge.ville === 'Louviers' && x.charge.puissanceKwc === 6.4),
      'sans quoi rien n’incite à s’abonner');
    check('la raison est dite, pas devinée',
      retenus.every((x) => /Essentiel/.test(x.masque || '')));

    // Google Solar est le seul appel facturé : il ne doit pas partir chez un
    // client gratuit, sans quoi le palier cesse d'être tenable.
    check('Google Solar est fermé au palier gratuit', billing.googleSolarOuvert('decouverte') === false);
    check('et ouvert aux formules payantes',
      billing.googleSolarOuvert('essentiel') && billing.googleSolarOuvert('agence'));

    // Le passage payant rend les leads retenus : rien n'est détruit.
    await requete(port, 'PATCH', '/api/v1/clients/' + cleG,
      Object.assign({ body: { formule: 'essentiel' } }, auth));
    const apres = (await requete(port, 'GET', '/api/v1/clients/' + cleG + '/leads', auth)).json.leads;
    check('l’abonnement libère les leads retenus rétroactivement',
      apres.every((x) => !x.retenu && x.nom && x.telephone),
      apres.filter((x) => x.retenu).length + ' encore retenus');
    check('la formule sans quota ne retient plus rien', billing.quotaLeads('essentiel') === 0);
  }

  console.log('Refonte de la grille : personne n’est dégradé en silence');
  {
    // « pro » et « reseau » n'existent plus. Un client resté sur ces valeurs
    // tomberait sur la première formule de la liste — le palier gratuit — et
    // perdrait Google Solar et ses leads illimités sans que personne ne le voie.
    check('l’ancien « pro » pointe sur une formule payante',
      billing.formule('pro').id === 'agence' && !billing.formule('pro').gratuite);
    check('l’ancien « reseau » aussi',
      billing.formule('reseau').id === 'agence');
    check('un identifiant inconnu ne donne pas Google Solar par accident',
      billing.googleSolarOuvert('n-importe-quoi') === false);

    const { DatabaseSync } = require('node:sqlite');
    const { MIGRATIONS, migrer } = require('../saas/lib/db.js');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
    for (let i = 0; i < 5; i++) db.exec(MIGRATIONS[i]);
    db.prepare('INSERT INTO schema_version(version) VALUES(5)').run();
    const t = new Date().toISOString();
    ['pro', 'reseau', 'essentiel'].forEach((f, i) => {
      db.prepare(`INSERT INTO clients(cle, slug, nom, statut, formule, domaines, config, cree_le, maj_le)
        VALUES(?,?,?,?,?,?,?,?,?)`).run('cle' + i, 'slug' + i, 'Client ' + i, 'actif', f, '', '{}', t, t);
    });
    migrer(db);
    const formules = db.prepare('SELECT formule FROM clients ORDER BY id').all().map((c) => c.formule);
    check('la migration renomme les formules en base',
      formules.join(',') === 'agence,agence,essentiel', formules.join(','));
    db.close();
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
    check('page d’abonnement servie', a.status === 200 && /790 €/.test(a.body), '790 € attendu');

    const cmd = await requete(port, 'POST', '/api/public/abonnement/' + cle, { body: { formule: 'essentiel' } });
    check('commande enregistrée sans Stripe', cmd.status === 200 && cmd.json.mode === 'bon_de_commande');
    check('aucun paiement simulé', !cmd.json.url && cmd.json.montantHT === 790);

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
    // La troisième fiche n'a pas de nom : elle était rejetée, elle est désormais
    // récupérée en déduisant le nom du domaine — et la déduction est signalée.
    check('nom déduit plutôt que ligne perdue', lot.json.crees === 3 && lot.json.rejetes === 0,
      JSON.stringify(lot.json));
    check('la déduction est tracée dans le rapport',
      (lot.json.details || []).some((d) => (d.avertissements || []).some((a) => /déduit/.test(a))));
    check('« erreurs » reste un alias de « rejetes »', lot.json.erreurs === lot.json.rejetes);
    check('import en lot compté', lot.json.crees === 3 && lot.json.erreurs === 0,
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

  console.log('Import volumineux');
  {
    // Un fichier réel de prospection fait plusieurs milliers de lignes. Sans
    // transaction, chaque insertion provoque une synchronisation disque et
    // l'import expire avant d'aboutir.
    const gros = [];
    for (let i = 1; i <= 3000; i++) {
      gros.push({ name: 'Entreprise ' + i, email: 'c' + i + '@ex' + i + '.fr', city: 'Ville' + i });
    }
    const t0 = Date.now();
    const r = await requete(port, 'POST', '/api/v1/prospects', Object.assign({ body: { prospects: gros } }, auth));
    const duree = Date.now() - t0;
    check('3 000 fiches importées', r.status === 201 && r.json.crees === 3000,
      JSON.stringify({ s: r.status, c: r.json && r.json.crees }));
    check('en moins de 10 s (transaction unique)', duree < 10000, duree + ' ms');

    // Le dédoublonnage doit voir les lignes du même lot, pas seulement celles
    // déjà en base : un fichier qui se répète ne doit pas créer de doublons.
    const rep = await requete(port, 'POST', '/api/v1/prospects', Object.assign({
      body: { prospects: [
        { name: 'Répétée', email: 'r@rep.fr' },
        { name: 'Répétée bis', email: 'r@rep.fr' }
      ] }
    }, auth));
    check('doublon interne au lot attrapé', rep.json.crees === 1 && rep.json.doublons === 1,
      JSON.stringify(rep.json));

    const fautif = [];
    for (let i = 0; i < 500; i++) fautif.push({ rien: 'du tout ' + i });
    const rf = await requete(port, 'POST', '/api/v1/prospects', Object.assign({ body: { prospects: fautif } }, auth));
    check('500 lignes fautives : toutes comptées', rf.json.rejetes === 500, JSON.stringify(rf.json.rejetes));
    check('mais le détail est plafonné', rf.json.details.length <= 200, String(rf.json.details.length));
    check('et le nombre d’omissions est dit', rf.json.detailsTronques === 300,
      String(rf.json.detailsTronques));

    // Les intitulés anglais du fichier réel doivent produire de vraies fiches.
    const en = await requete(port, 'POST', '/api/v1/prospects', Object.assign({
      body: { prospects: [{
        name: 'IN AUV ENERGIES', email: 'accueil@inauv.fr', phone: '04 71 73 58 48',
        website: 'https://www.inauv.fr', city: 'Aurillac', department: '15',
        certifications: ['RGE', 'QualiPV'], activity: 'Panneaux photovoltaïques'
      }] }
    }, auth));
    check('fichier à intitulés anglais : fiche créée', en.json.crees === 1, JSON.stringify(en.json));
    const trouve = await requete(port, 'GET', '/api/v1/prospects?q=IN%20AUV', auth);
    const f = trouve.json.prospects[0];
    check('raison sociale exacte', f && f.entreprise === 'IN AUV ENERGIES', f && f.entreprise);
    check('département en colonne', f && f.departement === '15', f && f.departement);
    check('QualiPV cherchable en base', f && /QualiPV/.test(f.metier), f && f.metier);

    const parMetier = await requete(port, 'GET', '/api/v1/prospects?metier=QualiPV', auth);
    check('filtre par qualification', parMetier.json.prospects.length === 1,
      String(parMetier.json.prospects.length));
  }

  console.log('Coordonnées multiples');
  {
    const lire = async (id) => (await requete(port, 'GET', '/api/v1/prospects/' + id, auth)).json.prospect;
    const cree = await requete(port, 'POST', '/api/v1/prospects', Object.assign({
      body: {
        nom: 'MULTI CONTACTS', emails: ['contact@multi.fr', 'devis@multi.fr', 'sav@multi.fr'],
        telephones: ['0232210000', '0612345678'], siteWeb: 'https://multi.fr'
      }
    }, auth));
    const id = cree.json.prospect.id;
    const p = await lire(id);
    check('la première adresse devient la principale', p.email === 'contact@multi.fr', p.email);
    check('les autres deviennent des coordonnées',
      p.coordonnees.filter((c) => c.type === 'email').length === 2,
      JSON.stringify(p.coordonnees.map((c) => c.valeur)));
    check('les numéros secondaires aussi, au même format que le principal',
      p.coordonnees.some((c) => c.valeur === '06 12 34 56 78'),
      JSON.stringify(p.coordonnees.filter((c) => c.type === 'telephone').map((c) => c.valeur)));
    check('ils ne polluent plus les notes', !/devis@multi/.test(p.notes), p.notes);

    const ajout = await requete(port, 'POST', '/api/v1/prospects/' + id + '/coordonnees',
      Object.assign({ body: { type: 'telephone', valeur: '+33 (0)7 88 99 00 11', libelle: 'gérant' } }, auth));
    check('ajout accepté et normalisé',
      ajout.status === 201 && ajout.json.prospect.coordonnees.some((c) => c.valeur === '07 88 99 00 11'),
      JSON.stringify(ajout.json.prospect.coordonnees.map((c) => c.valeur)));
    check('le libellé est conservé',
      ajout.json.prospect.coordonnees.some((c) => c.libelle === 'gérant'));

    const rebelote = await requete(port, 'POST', '/api/v1/prospects/' + id + '/coordonnees',
      Object.assign({ body: { type: 'telephone', valeur: '0788990011' } }, auth));
    check('le même numéro n’est pas empilé deux fois',
      rebelote.json.prospect.coordonnees.filter((c) => c.valeur === '07 88 99 00 11').length === 1);

    const invalide = await requete(port, 'POST', '/api/v1/prospects/' + id + '/coordonnees',
      Object.assign({ body: { type: 'email', valeur: 'pas une adresse' } }, auth));
    check('une adresse invalide est refusée', invalide.status === 400, String(invalide.status));

    // Promotion : l'ancienne principale ne doit pas disparaître.
    const gerant = (await lire(id)).coordonnees.find((c) => c.valeur === '07 88 99 00 11');
    const promu = await requete(port, 'POST', '/api/v1/coordonnees/' + gerant.id + '/principale', auth);
    check('la coordonnée promue devient principale',
      promu.json.prospect.telephone === '07 88 99 00 11', promu.json.prospect.telephone);
    check('l’ancienne principale redescend dans la liste',
      promu.json.prospect.coordonnees.some((c) => c.valeur === '02 32 21 00 00'),
      JSON.stringify(promu.json.prospect.coordonnees.map((c) => c.valeur)));
    check('la promotion est journalisée',
      promu.json.prospect.activites.some((a) => a.type === 'contact' && /principal/.test(a.corps)));

    const aRetirer = (await lire(id)).coordonnees.find((c) => c.valeur === 'sav@multi.fr');
    const apres = await requete(port, 'DELETE', '/api/v1/coordonnees/' + aRetirer.id, auth);
    check('suppression effective',
      !apres.json.prospect.coordonnees.some((c) => c.valeur === 'sav@multi.fr'));
    const fantome = await requete(port, 'DELETE', '/api/v1/coordonnees/999999', auth);
    check('coordonnée inconnue → 404', fantome.status === 404);

    // Le nettoyage en cascade évite des coordonnées orphelines.
    const compter = () => app.rdf.db.prepare('SELECT COUNT(*) n FROM coordonnees WHERE prospect_id = ?').get(id).n;
    check('coordonnées présentes avant suppression', compter() > 0);
    app.rdf.crm.supprimerProspect(id);
    check('supprimer la fiche emporte ses coordonnées', compter() === 0, String(compter()));
  }

  console.log('Pagination — voir au-delà de la première page');
  {
    const p1 = await requete(port, 'GET', '/api/v1/prospects?limite=50', auth);
    check('le total dépasse la page renvoyée',
      p1.json.total > p1.json.prospects.length && p1.json.prospects.length === 50,
      JSON.stringify({ total: p1.json.total, page: p1.json.prospects.length }));
    check('la page renvoie ses bornes', p1.json.limite === 50 && p1.json.offset === 0);

    const p2 = await requete(port, 'GET', '/api/v1/prospects?limite=50&offset=50', auth);
    check('la page suivante est différente',
      p2.json.prospects[0].id !== p1.json.prospects[0].id);
    check('le total ne change pas d’une page à l’autre', p2.json.total === p1.json.total);

    // Le point critique après un import en lot : toutes les fiches partagent le
    // même `maj_le`. Sans départage stable, la pagination renverrait deux fois
    // les mêmes lignes et en sauterait d'autres — silencieusement.
    const vus = new Set();
    let doublons = 0;
    for (let o = 0; o < 600; o += 200) {
      const p = await requete(port, 'GET', '/api/v1/prospects?limite=200&offset=' + o, auth);
      p.json.prospects.forEach((x) => { if (vus.has(x.id)) doublons++; vus.add(x.id); });
    }
    check('trois pages, aucune fiche vue deux fois', doublons === 0, String(doublons));
    check('trois pages, 600 fiches distinctes', vus.size === 600, String(vus.size));

    const filtre = await requete(port, 'GET', '/api/v1/prospects?statut=nouveau&limite=10', auth);
    check('le total suit les filtres, pas la page',
      filtre.json.total > 10 && filtre.json.prospects.length === 10,
      JSON.stringify({ t: filtre.json.total, n: filtre.json.prospects.length }));
    const vide = await requete(port, 'GET', '/api/v1/prospects?q=zzzinexistantzzz', auth);
    check('aucun résultat → total à zéro', vide.json.total === 0 && vide.json.prospects.length === 0);
    const trop = await requete(port, 'GET', '/api/v1/prospects?limite=99999', auth);
    check('la limite reste plafonnée à 500', trop.json.prospects.length <= 500,
      String(trop.json.prospects.length));
  }

  console.log('Enrichissement des fiches par les agents');
  {
    const creer = async (nom, site) => (await requete(port, 'POST', '/api/v1/prospects',
      Object.assign({ body: { entreprise: nom, site } }, auth))).json.prospect.id;
    const lire = async (id) => (await requete(port, 'GET', '/api/v1/prospects/' + id, auth)).json.prospect;

    const idNu = await creer('Sans Simulateur', 'sans-sim.fr');
    const idEquipe = await creer('Déjà Équipé', 'deja-equipe.fr');

    const vierge = await lire(idNu);
    check('une fiche neuve n’est pas « inspectée sans rien trouver »',
      vierge.inspecte_le === null && vierge.simulateur_niveau === null,
      JSON.stringify({ i: vierge.inspecte_le, n: vierge.simulateur_niveau }));
    check('le détail est un objet, pas une chaîne',
      typeof vierge.enrichissement === 'object', typeof vierge.enrichissement);

    const r1 = await requete(port, 'POST', '/api/v1/prospects/' + idNu + '/inspection', Object.assign({
      body: {
        date: '2026-08-14', niveau: 0, cible: true, raison: 'aucun simulateur',
        enseigne: 'Sans Simulateur SARL', couleur: '#0b7285', couleurApercu: '#129292',
        detail: { capacites: [], donnees: ['nom', 'e-mail'], editeurs: [], pagesVues: ['https://sans-sim.fr/'] }
      }
    }, auth));
    check('inspection acceptée', r1.status === 200, JSON.stringify(r1.json).slice(0, 120));

    const p1 = await lire(idNu);
    check('niveau écrit', p1.simulateur_niveau === 0);
    check('date d’inspection écrite', p1.inspecte_le === '2026-08-14', p1.inspecte_le);
    check('cible stockée en booléen SQLite', p1.cible === 1, String(p1.cible));
    check('couleurs stockées', p1.couleur === '#0b7285' && p1.couleur_apercu === '#129292');
    check('détail rangé en JSON exploitable',
      p1.enrichissement.donnees.join(',') === 'nom,e-mail', JSON.stringify(p1.enrichissement));
    check('la raison sociale connue n’est pas remplacée par l’enseigne',
      p1.entreprise === 'Sans Simulateur', p1.entreprise);
    check('l’enrichissement est journalisé pour l’humain',
      p1.activites.some((a) => a.type === 'inspection'), JSON.stringify(p1.activites.map((a) => a.type)));

    // Une seconde passe muette ne doit rien effacer.
    await requete(port, 'POST', '/api/v1/prospects/' + idNu + '/inspection', Object.assign({
      body: { date: '2026-08-20', niveau: 0, cible: true, detail: { faits: ['revu'] } }
    }, auth));
    const p2 = await lire(idNu);
    check('une seconde passe fusionne au lieu d’écraser',
      p2.enrichissement.donnees.join(',') === 'nom,e-mail' && p2.enrichissement.faits[0] === 'revu',
      JSON.stringify(p2.enrichissement));
    check('mais la date est bien actualisée', p2.inspecte_le === '2026-08-20');
    check('deux passages, deux entrées au journal',
      p2.activites.filter((a) => a.type === 'inspection').length === 2);

    await requete(port, 'POST', '/api/v1/prospects/' + idEquipe + '/inspection', Object.assign({
      body: {
        date: '2026-08-14', niveau: 4, cible: false, raison: 'déjà équipé d’un simulateur avancé',
        url: 'https://deja-equipe.fr/simulateur',
        detail: { editeurs: ['Otovo'], capacites: ['vue 3D', 'photo aérienne'] }
      }
    }, auth));
    const pe = await lire(idEquipe);
    check('non-cible stocké', pe.cible === 0, String(pe.cible));
    check('le statut commercial n’est PAS touché par un agent',
      pe.statut === 'nouveau', pe.statut);
    check('le journal explique le rejet en clair',
      pe.activites.some((a) => a.type === 'inspection' && /écarté du démarchage/.test(a.corps)),
      JSON.stringify(pe.activites.filter((a) => a.type === 'inspection').map((a) => a.corps)));

    const aDemarcher = await requete(port, 'GET', '/api/v1/prospects?cible=true', auth);
    check('filtre « à démarcher »',
      aDemarcher.json.prospects.length === 1 && aDemarcher.json.prospects[0].entreprise === 'Sans Simulateur',
      aDemarcher.json.prospects.map((p) => p.entreprise).join(','));
    const ecartes = await requete(port, 'GET', '/api/v1/prospects?cible=false', auth);
    check('filtre « écartés »', ecartes.json.prospects.length === 1);
    const sansSim = await requete(port, 'GET', '/api/v1/prospects?niveauMax=0', auth);
    check('filtre « sans simulateur »', sansSim.json.prospects.length === 1);
    const jamais = await requete(port, 'GET', '/api/v1/prospects?inspecte=false', auth);
    check('filtre « pas encore inspecté » ignore les fiches déjà vues',
      jamais.json.prospects.length >= 1 && !jamais.json.prospects.some((p) => p.inspecte_le),
      String(jamais.json.prospects.length));

    const introuvable = await requete(port, 'POST', '/api/v1/prospects/999999/inspection',
      Object.assign({ body: { niveau: 0 } }, auth));
    check('fiche inconnue → 404', introuvable.status === 404);

    // Valeurs aberrantes : un agent buggé ne doit pas corrompre la base.
    await requete(port, 'POST', '/api/v1/prospects/' + idNu + '/inspection', Object.assign({
      body: { niveau: 99, couleur: 'javascript:alert(1)', cible: 'oui' }
    }, auth));
    const borne = await lire(idNu);
    check('niveau borné à 4', borne.simulateur_niveau === 4, String(borne.simulateur_niveau));
    check('couleur invalide refusée, l’ancienne conservée', borne.couleur === '#0b7285', borne.couleur);
    check('« oui » compris comme vrai', borne.cible === 1);
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
    // Deux clients : l'installateur d'origine et celui du palier gratuit.
    check('compteurs présents', d.json.clients.total === 2, String(d.json.clients.total));
    check('pipeline renvoyé', Array.isArray(d.json.pipeline) && d.json.pipeline.length === 7);
    check('revenu annuel calculé', typeof d.json.arrHT === 'number');
    // Un lead au départ, plus les sept posés sur le palier gratuit.
    check('derniers leads exposés', d.json.derniersLeads.length === 8,
      String(d.json.derniersLeads.length));
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

  console.log('Affichage mobile');
  {
    // Chaque page servie par le SaaS est consultée depuis un téléphone : la
    // console par un commercial en déplacement, le widget et la page de partage
    // par des particuliers, dont l'essentiel du trafic vient du mobile. Une page
    // sans `viewport` s'affiche dézoomée et illisible ; une feuille de style
    // sans requête média garde une mise en page de bureau sur 390 px.
    const pagesPubliques = [
      ['widget', '/w/' + cle],
      ['partage', '/s/' + cle],
      ['abonnement', '/abonnement/' + cle]
    ];
    for (const [nom, url] of pagesPubliques) {
      const r = await requete(port, 'GET', url);
      check(nom + ' : servie', r.status === 200, String(r.status));
      check(nom + ' : balise viewport',
        /<meta[^>]+name=["']viewport["']/.test(r.body), url);
    }
    const partage = await requete(port, 'GET', '/s/' + cle);
    check('partage : règles mobiles présentes', /@media[^{]*max-width/.test(partage.body));

    const w = await requete(port, 'GET', '/w/' + cle);
    check('widget : règles mobiles présentes', /@media[^{]*max-width/.test(w.body));
    check('widget : contrôles de carte agrandis au doigt',
      /leaflet-control-zoom a\s*\{[^}]*40px/.test(w.body),
      '30 px par défaut, sous le seuil confortable');

    const html = fs.readFileSync(path.join(__dirname, '..', 'saas', 'public', 'console.html'), 'utf8');
    check('console : règles mobiles présentes', /@media[^{]*max-width/.test(html));
    check('console : les tableaux deviennent des cartes',
      /table td::before\{content:attr\(data-l\)/.test(html),
      'sept colonnes sur 390 px imposeraient un défilement horizontal');
    check('console : cibles tactiles agrandies',
      /button,select,input,textarea\{min-height:42px\}/.test(html));

    const js = fs.readFileSync(path.join(__dirname, '..', 'saas', 'public', 'console.js'), 'utf8');
    check('console : chaque cellule porte l’intitulé de sa colonne',
      /'data-l': entetes\[i\]/.test(js),
      'sans quoi la mise en cartes n’a rien à afficher comme libellé');
  }

  console.log('Parcours du simulateur');
  {
    // Le défaut mesuré avant cette refonte : le bouton « suite » était le
    // dernier élément d'un panneau de 950 à 1 300 px, soit 225 à 558 px sous le
    // pli d'un écran de 800 px, à chaque étape. Un visiteur qui doit chercher
    // comment continuer abandonne — et un simulateur qui n'aboutit pas ne
    // produit aucun lead, donc aucun argument pour vendre l'abonnement.
    const sim = fs.readFileSync(path.join(__dirname, '..', 'src', 'rdf-solar-sim.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'rdf-solar-sim.css'), 'utf8');

    check('la colonne sépare contenu défilant et barre d’action',
      /rdfsim-side-scroll/.test(sim) && /rdfsim-side-action/.test(sim));
    check('la barre d’action est collée en bas',
      /\.rdfsim-side-action\s*\{[^}]*position:\s*sticky[^}]*bottom:\s*0/.test(css));
    check('le contenu défile, pas la barre',
      /\.rdfsim-side-scroll\s*\{[^}]*overflow-y:\s*auto/.test(css));
    check('le cadre du simulateur est borné',
      /\.rdfsim\s*\{[^}]*height:\s*100%/.test(css),
      'sans borne, le widget dépasse l’écran et la barre passe sous le pli');

    check('chaque étape a son action', /barre\(1,/.test(sim) && /barre\(2,/.test(sim) &&
      /barre\(3,/.test(sim) && /barre\(4,/.test(sim));
    check('les boutons ne sont plus enfouis dans les panneaux',
      !/rdfsim-btn-primary', type: 'button', text: 'Choisir mon offre/.test(sim) &&
      !/rdfsim-btn-primary', type: 'button', text: 'Voir mes résultats/.test(sim),
      'un CTA dans le panneau retomberait sous le pli');
    check('le bouton est désactivé tant que l’étape n’est pas franchissable',
      /bouton\.disabled = !ok1/.test(sim) && /bouton\.disabled = !ok2/.test(sim));
    check('le résumé suit chaque réglage', /_refreshAction\(\);/.test(sim));

    // L'iframe suivait la hauteur du contenu : elle atteignait 2 300 px sur
    // mobile, et plus rien ne tenait dans un écran.
    const w = fs.readFileSync(path.join(__dirname, '..', 'saas', 'lib', 'widget.js'), 'utf8');
    check('l’hôte reçoit une hauteur cible, pas la hauteur du contenu',
      /function hauteurCible/.test(w) && !/getBoundingClientRect\(\)\.height;\s*\n\s*if \(Math\.abs/.test(w));

    check('l’aide détaillée est repliée, pas affichée d’emblée',
      /el\('details', \{ class: 'rdfsim-aide' \}/.test(sim),
      'huit lignes avant la première action faisaient juger le parcours compliqué');
    check('les réglages d’un pan n’apparaissent pas avant qu’un pan existe',
      /this\.reglagesCard\.style\.display = this\.state\.zones\.length/.test(sim));

    // Un lead sans installation chiffrée fait rappeler quelqu'un dont
    // l'installateur ne sait rien : c'est un lead qui lui coûte du temps.
    check('aucun devis proposé sur une simulation vide',
      /var ok4 = c4\.n > 0;/.test(sim) && /Aucun panneau placé/.test(sim));
    check('le résumé et le bouton sont empilés, pas côte à côte',
      /\.rdfsim-action \{[^}]*flex-direction:\s*column/.test(css),
      'dans une colonne de 390 px, le texte passait sous le bouton');

    // --- Les trois arbitrages éditoriaux du parcours ---------------------

    // 1. Ordre des offres. Laquelle pousser dépend du catalogue de chaque
    //    installateur : le simulateur expose un réglage, il ne choisit pas.
    check('l’offre mise en avant passe en tête',
      /misEnAvant \? 1 : 0/.test(sim),
      'sans tri, l’installateur ne peut pas pousser son offre');
    check('l’offre mise en avant est présélectionnée',
      /catalog\.offres\.filter\(function \(o\) \{ return o\.misEnAvant; \}\)\[0\] \|\| catalog\.offres\[0\]/.test(sim),
      'un visiteur qui ne touche à rien doit repartir sur l’offre poussée');
    check('elle porte un badge lisible',
      /rdfsim-offer-badge/.test(sim) && /\.rdfsim-offer-badge \{/.test(css));
    check('le tri reste stable pour les autres offres',
      /sort` est stable/.test(sim),
      'sinon l’ordre du catalogue de l’installateur serait mélangé');

    // 2. Hiérarchie des résultats. L'économie annuelle en tête : c'est le seul
    //    chiffre dont un particulier a un repère immédiat.
    check('le chiffre de tête est l’économie annuelle',
      /is-hero'.*\n.*rdfsim-kpi-v', html: eur\(c\.fin\.annualSavings\)/.test(sim),
      'des kWh en tête ne parlent qu’aux installateurs');
    check('retour et production suivent, distingués du reste',
      /kpi\(payback, 'retour sur investissement', 'is-fort'\)/.test(sim) &&
      /\.rdfsim-kpi\.is-fort \{/.test(css));
    check('le résumé de l’étape 4 met en avant le même chiffre que la grille',
      /eur\(c4\.fin\.annualSavings\) \+ '\/an estimés/.test(sim),
      'annoncer des kWh sous une grille qui annonce des euros brouille la lecture');
    check('le récap imprimé suit la même hiérarchie',
      /class="hero">Économies estimées/.test(sim),
      'deux hiérarchies différentes entre l’écran et le PDF sèment le doute');

    // 3. Moment de la demande de coordonnées : à la fin, après les chiffres.
    check('les coordonnées sont demandées après les chiffres',
      /_renderResults/.test(sim) &&
      sim.indexOf('rdfsim-results-grid') < sim.lastIndexOf('_requestQuote(c)'),
      'un formulaire avant les chiffres capte du volume, pas des leads qualifiés');

    // Choisir une offre sans en voir le prix, c'est découvrir la note après.
    check('le prix figure dès l’étape du choix d’offre',
      /eur\(c3\.installCost\) \+ ' TTC'/.test(sim));
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
