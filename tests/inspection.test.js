/**
 * Tests de l'inspection de sites — node tests/inspection.test.js
 *
 * Deux risques dominent ici. Le premier est de mal juger : classer « déjà
 * équipé » un installateur qui n'a qu'un formulaire fait perdre un prospect,
 * et l'inverse fait écrire un message ridicule à quelqu'un de mieux outillé
 * que nous. Le second est de mal se tenir chez les autres : `robots.txt` n'est
 * pas une formalité quand on visite systématiquement des sites tiers.
 */
'use strict';

const I = require('../agents/inspection.js');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const page = (html, url = 'https://exemple.fr/') => [{ url, html }];

/* ===================== robots.txt ===================== */
console.log('Respect de robots.txt');
{
  const r = I.analyserRobots('User-agent: *\nDisallow: /admin\nDisallow: /prive\n', 'HermesInspection/1.0');
  check('groupe générique lu', r.length === 2, JSON.stringify(r));
  check('chemin interdit refusé', !I.cheminAutorise(r, '/admin/x'));
  check('chemin libre autorisé', I.cheminAutorise(r, '/simulateur'));

  const propre = I.analyserRobots(
    'User-agent: *\nDisallow: /\n\nUser-agent: hermesinspection\nDisallow: /interne\n',
    'HermesInspection/1.0 (+https://x)');
  check('notre groupe l’emporte sur le générique', I.cheminAutorise(propre, '/simulateur'),
    JSON.stringify(propre));
  check('mais ses propres règles s’appliquent', !I.cheminAutorise(propre, '/interne'));

  const tout = I.analyserRobots('User-agent: *\nDisallow: /\n', 'HermesInspection/1.0');
  check('« Disallow: / » interdit tout', !I.cheminAutorise(tout, '/'));

  const vide = I.analyserRobots('User-agent: *\nDisallow:\n', 'HermesInspection/1.0');
  check('« Disallow: » vide n’interdit rien', I.cheminAutorise(vide, '/x'));

  const allow = I.analyserRobots('User-agent: *\nDisallow: /outils\nAllow: /outils/simulateur\n', 'H');
  check('Allow plus spécifique l’emporte', I.cheminAutorise(allow, '/outils/simulateur'));
  check('le reste du dossier reste interdit', !I.cheminAutorise(allow, '/outils/interne'));

  check('commentaires ignorés',
    I.analyserRobots('# rien\nUser-agent: *\nDisallow: /a # note\n', 'H')[0].chemin === '/a');
  check('fichier vide → tout permis', I.cheminAutorise(I.analyserRobots('', 'H'), '/'));
}

/* ===================== Niveau du simulateur ===================== */
console.log('\nDétection et graduation du simulateur');
{
  const vitrine = `<html><head><title>Dupont Énergie</title></head><body>
    <h1>Installateur photovoltaïque à Vernon</h1>
    <p>Demandez votre devis gratuit.</p>
    <form><input name="nom"><input type="email" name="email"><input type="tel" name="tel"></form>
    </body></html>`;
  const a = I.analyserSimulateur(page(vitrine));
  check('site vitrine : aucun simulateur', !a.present && a.niveau === 0, JSON.stringify(a));
  check('« photovoltaïque » ne déclenche pas Otovo', a.editeurs.length === 0, a.editeurs.join(','));
  check('champs du formulaire relevés',
    a.donnees.includes('nom') && a.donnees.includes('e-mail') && a.donnees.includes('téléphone'),
    a.donnees.join(','));

  const annonce = `<h2>Simulez votre projet solaire</h2><p>Estimation gratuite en ligne.</p>`;
  check('annonce seule → niveau 1', I.analyserSimulateur(page(annonce)).niveau === 1);

  const calcul = `<h2>Calculez vos économies</h2>
    <form><input name="facture"><input name="conso_kwh"></form>
    <p>Production estimée : 4200 kWh/an, retour sur investissement en 9 ans.</p>`;
  const c = I.analyserSimulateur(page(calcul));
  check('calculateur d’économies → niveau 2', c.niveau === 2, JSON.stringify(c));
  check('capacité financière relevée', c.capacites.includes('volet financier'));
  check('consommation demandée relevée', c.donnees.includes('consommation ou facture'));

  const carto = `<h2>Simulateur solaire</h2><script src="/js/leaflet.js"></script>
    <p>Saisissez votre adresse</p><p>Puissance crête estimée</p>`;
  check('carte + adresse → niveau 3', I.analyserSimulateur(page(carto)).niveau === 3);

  const avance = `<h2>Simulez votre installation</h2><script src="three.js"></script>
    <p>Dessinez votre toiture sur la photo aérienne.</p><p>Calcul d'ombrage via PVGIS.</p>`;
  const av = I.analyserSimulateur(page(avance));
  check('3D + photo aérienne → niveau 4', av.niveau === 4, JSON.stringify(av));
  check('capacités cumulées',
    av.capacites.includes('vue 3D') && av.capacites.includes('photo aérienne') &&
    av.capacites.includes('appui PVGIS'), av.capacites.join(', '));

  const tiers = `<h2>Simulateur solaire</h2><iframe src="https://widget.otovo.fr/x"></iframe>
    <p>Saisissez votre adresse</p><script src="mapbox-gl.js"></script>`;
  check('éditeur tiers identifié', I.analyserSimulateur(page(tiers)).editeurs[0] === 'Otovo');

  // Le simulateur vit rarement sur l'accueil : les capacités doivent se cumuler.
  const multi = I.analyserSimulateur([
    { url: 'https://x.fr/', html: '<a href="/simulateur">Simulez votre projet</a>' },
    { url: 'https://x.fr/simulateur', html: '<h1>Simulez votre projet solaire</h1><script src="three.js"></script><p>photo aérienne</p>' }
  ]);
  check('analyse cumulée sur plusieurs pages', multi.niveau === 4, JSON.stringify(multi));
  check('l’URL retenue est celle du simulateur, pas l’accueil',
    multi.url === 'https://x.fr/simulateur', multi.url);

  check('aucune page → rapport vide sans planter', I.analyserSimulateur([]).niveau === 0);
  check('page vide tolérée', I.analyserSimulateur([{ url: 'x', html: '' }]).present === false);
}

/* ===================== Verdict commercial ===================== */
console.log('\nÀ qui écrire, et à qui ne pas écrire');
{
  check('sans simulateur : cible prioritaire', I.verdict({ present: false, niveau: 0 }).cible === true);
  check('simulateur avancé : on n’écrit pas',
    I.verdict({ present: true, niveau: 4, libelle: 'x' }).cible === false);
  check('le refus est motivé', /avancé/.test(I.verdict({ present: true, niveau: 4, libelle: 'x' }).raison));
  check('simulateur rudimentaire : cible',
    I.verdict({ present: true, niveau: 1, libelle: 'formulaire de devis seulement' }).cible === true);
  check('cartographique : cible, avec l’angle d’attaque',
    /vue du toit/.test(I.verdict({ present: true, niveau: 3, libelle: 'x' }).raison));
}

/* ===================== Identité visuelle ===================== */
console.log('\nNom d’enseigne');
{
  check('og:site_name prioritaire',
    I.nomEnseigne('<meta property="og:site_name" content="Dupont Énergie"><title>Accueil - Autre</title>') === 'Dupont Énergie');
  check('titre « Sujet – Enseigne »',
    I.nomEnseigne('<title>Nos réalisations | Solaire du Vexin</title>') === 'Solaire du Vexin');
  check('titre simple',
    I.nomEnseigne('<title>Toitures Martin</title>') === 'Toitures Martin');
  check('dernier segment trop long → premier segment retenu',
    I.nomEnseigne('<title>Martin | Installateur photovoltaïque certifié RGE dans toute la Normandie</title>') === 'Martin');
  check('sans titre → chaîne vide', I.nomEnseigne('<html></html>') === '');
}

console.log('\nCouleurs');
{
  check('hex court développé', I.hexVersRvb('#f80')[0] === 255);
  check('hex invalide → null', I.hexVersRvb('bonjour') === null);
  check('aller-retour RVB/TSL fidèle', (() => {
    const [t, s, l] = I.rvbVersTsl([37, 99, 235]);
    return I.tslVersHex(t, s, l) === '#2563eb';
  })(), I.tslVersHex(...I.rvbVersTsl([37, 99, 235])));

  check('gris écarté', I.estNeutre('#888888'));
  check('blanc écarté', I.estNeutre('#ffffff'));
  check('noir écarté', I.estNeutre('#000000'));
  check('bleu de marque conservé', !I.estNeutre('#2563eb'));

  const c = I.extraireCouleurs([
    { type: 'html', texte: '<meta name="theme-color" content="#2563eb">' },
    { type: 'css', texte: 'a{color:#ff6600}b{color:#ff6600}c{color:#ff6600}' }
  ]);
  check('theme-color l’emporte sur la fréquence', c[0].hex === '#2563eb', JSON.stringify(c));

  const v = I.extraireCouleurs([{ type: 'css', texte: ':root{--brand-primary:#e11d48}p{color:#123456}' }]);
  check('variable CSS nommée priorisée', v[0].hex === '#e11d48', JSON.stringify(v));

  const g = I.extraireCouleurs([{ type: 'css', texte: 'a{color:#ffffff}b{color:#f5f5f5}c{color:#111}' }]);
  check('une page en niveaux de gris ne rend aucune couleur', g.length === 0, JSON.stringify(g));

  check('rgb() reconnu',
    I.extraireCouleurs([{ type: 'css', texte: 'a{color:rgb(225, 29, 72)}' }])[0].hex === '#e11d48');
}

console.log('\nCouleur approchée — proche, jamais identique');
{
  for (const src of ['#2563eb', '#e11d48', '#ff6600', '#16a34a', '#7c3aed']) {
    const a = I.approcher(src);
    const [t1] = I.rvbVersTsl(I.hexVersRvb(src));
    const [t2] = I.rvbVersTsl(I.hexVersRvb(a));
    const ecart = Math.min(Math.abs(t1 - t2), 360 - Math.abs(t1 - t2));
    check(src + ' → ' + a + ' : différente de l’originale', a !== src);
    check(src + ' : teinte décalée de 5 à 20°', ecart >= 5 && ecart <= 20, String(Math.round(ecart)));
    check(src + ' : reste une couleur valide', /^#[0-9a-f]{6}$/.test(a), a);
    check(src + ' : ni délavée ni noire', !I.estNeutre(a), a);
  }
  check('déterministe', I.approcher('#2563eb') === I.approcher('#2563eb'));
  check('entrée invalide → chaîne vide', I.approcher('rien') === '');
}

console.log('\nIdentité complète');
{
  const html = `<html><head><title>Solaire du Vexin</title>
    <meta name="theme-color" content="#0a6ed1"></head><body></body></html>`;
  const id = I.identiteVisuelle(page(html), [':root{--accent:#f59e0b}']);
  check('nom relevé', id.nom === 'Solaire du Vexin');
  check('couleur principale relevée', id.principale === '#0a6ed1', id.principale);
  check('couleur secondaire relevée', id.secondaire === '#f59e0b', id.secondaire);
  check('l’aperçu n’utilise PAS la couleur exacte',
    id.apercuPrincipale !== id.principale && id.apercuPrincipale !== '', id.apercuPrincipale);
  check('l’aperçu secondaire est décalé aussi',
    id.apercuSecondaire !== id.secondaire && id.apercuSecondaire !== '');
  check('site sans couleur : pas d’aperçu inventé',
    I.identiteVisuelle(page('<title>X</title>'), []).apercuPrincipale === '');
}

/* ===================== Exploration ===================== */
console.log('\nExploration du site');
{
  const html = `<a href="/simulateur">Simulez votre projet</a>
    <a href="/contact">Contact</a>
    <a href="https://ailleurs.fr/simulateur">Simulateur du voisin</a>
    <link rel="stylesheet" href="/css/style.css">`;
  const liens = I.liensCandidats(html, 'https://exemple.fr/');
  check('lien de simulateur repéré', liens.includes('https://exemple.fr/simulateur'), liens.join(','));
  check('lien sans rapport ignoré', !liens.some((l) => /contact/.test(l)));
  check('lien externe écarté', !liens.some((l) => /ailleurs/.test(l)), liens.join(','));
  check('feuille de style résolue en absolu',
    I.feuillesDeStyle(html, 'https://exemple.fr/')[0] === 'https://exemple.fr/css/style.css');

  check('adresse sans schéma complétée', I.normaliserUrl('exemple.fr') === 'https://exemple.fr/');
  check('adresse vide → chaîne vide', I.normaliserUrl('') === '');
}

/* ===================== Visite complète ===================== */
console.log('\nVisite complète, sans réseau');
(async () => {
  /** Faux serveur : une table chemin → contenu. */
  function serveur(table) {
    const vus = [];
    const f = async (url) => {
      vus.push(url);
      const chemin = new URL(url).pathname;
      if (table[chemin] === undefined) return { ok: false, status: 404, url, text: async () => '' };
      return { ok: true, status: 200, url, text: async () => table[chemin] };
    };
    return { fetch: f, vus };
  }

  {
    const s = serveur({
      '/robots.txt': 'User-agent: *\nDisallow: /admin\n',
      '/': `<html><head><title>Dupont Énergie</title><meta name="theme-color" content="#c2410c">
            <link rel="stylesheet" href="/s.css"></head>
            <body><a href="/simulateur">Simulez votre projet</a></body></html>`,
      '/simulateur': `<h1>Simulez votre projet solaire</h1><script src="three.js"></script>
            <p>Dessinez votre toiture sur la photo aérienne</p>
            <form><input type="email" name="email"><input name="adresse"></form>`,
      '/s.css': ':root{--brand:#0369a1}'
    });
    const r = await I.visiter('dupont-energie.fr', { fetch: s.fetch, sansPause: true });
    check('site joignable', r.joignable === true, r.erreur);
    check('robots.txt consulté en premier', /robots\.txt$/.test(s.vus[0]), s.vus[0]);
    check('la page du simulateur a été suivie',
      r.pagesVues.some((u) => /simulateur/.test(u)), r.pagesVues.join(' '));
    check('niveau 4 détecté', r.simulateur.niveau === 4, JSON.stringify(r.simulateur));
    check('URL du simulateur remontée', /\/simulateur$/.test(r.simulateur.url), r.simulateur.url);
    check('données réclamées relevées',
      r.simulateur.donnees.includes('e-mail') && r.simulateur.donnees.includes('adresse'),
      r.simulateur.donnees.join(','));
    check('identité relevée', r.identite.nom === 'Dupont Énergie' && r.identite.principale === '#c2410c',
      JSON.stringify(r.identite));
    check('couleur de la feuille de style relevée aussi',
      r.identite.couleurs.includes('#0369a1'), r.identite.couleurs.join(','));
    check('verdict : ne pas écrire', r.verdict.cible === false, r.verdict.raison);
    check('faits citables produits', r.faits.length >= 3, JSON.stringify(r.faits));
    check('page interdite jamais demandée', !s.vus.some((u) => /\/admin/.test(u)));
  }

  {
    const s = serveur({ '/robots.txt': 'User-agent: *\nDisallow: /\n', '/': '<title>X</title>' });
    const r = await I.visiter('bloque.fr', { fetch: s.fetch, sansPause: true });
    check('robots.txt fermé : aucune page visitée', r.joignable === false && !r.robotsRespecte, r.erreur);
    check('la page d’accueil n’a même pas été demandée',
      !s.vus.some((u) => u.endsWith('bloque.fr/')), s.vus.join(' '));
    check('le refus est expliqué', /robots\.txt/.test(r.erreur), r.erreur);
  }

  {
    const s = serveur({});   // tout en 404
    const r = await I.visiter('mort.fr', { fetch: s.fetch, sansPause: true });
    check('site injoignable : rapport propre, pas d’exception',
      r.joignable === false && /injoignable/.test(r.erreur), r.erreur);
  }

  {
    const r = await I.visiter('', { fetch: async () => { throw new Error('ne doit pas être appelé'); } });
    check('adresse vide : aucun appel réseau', /inexploitable/.test(r.erreur), r.erreur);
  }

  {
    const s = { fetch: async () => { throw new Error('ECONNRESET'); } };
    const r = await I.visiter('casse.fr', { fetch: s.fetch, sansPause: true });
    check('réseau en échec : rapport, pas de plantage', r.joignable === false && !!r.erreur, r.erreur);
  }

  /* ===================== Report sur la fiche ===================== */
  console.log('\nEnrichissement de la fiche');
  {
    const s = serveur({
      '/robots.txt': '',
      '/': '<title>Toitures Martin</title><meta name="theme-color" content="#15803d"><p>Demandez un devis</p>'
    });
    const r = await I.visiter('toitures-martin.fr', { fetch: s.fetch, sansPause: true });
    const f = I.enrichir({ nom: 'TOITURES MARTIN SARL', emails: ['a@b.fr'] }, r);
    check('aSimulateur reste booléen pour la notation existante', f.aSimulateur === false);
    check('détail rangé dans inspection', f.inspection.niveau === 0 && f.inspection.cible === true,
      JSON.stringify(f.inspection));
    check('identité rattachée', f.identite.principale === '#15803d');
    check('le nom déjà connu n’est pas écrasé', f.nom === 'TOITURES MARTIN SARL');
    check('le nom manquant est complété',
      I.enrichir({ emails: [] }, r).nom === 'Toitures Martin');

    const ko = I.enrichir({ nom: 'X' }, { joignable: false, erreur: 'site injoignable' });
    check('site injoignable : aSimulateur reste inconnu', ko.aSimulateur === undefined);
    check('l’échec est daté et motivé', !!ko.inspection.date && /injoignable/.test(ko.inspection.erreur));
  }

  console.log('\n' + passed + ' tests réussis, ' + failed + ' échec(s)');
  process.exit(failed ? 1 : 0);
})();
