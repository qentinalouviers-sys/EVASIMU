/**
 * Tests du pont Hermès ↔ SaaS — node tests/api.test.js
 *
 * Le risque de ce module n'est pas de planter : c'est d'écraser silencieusement
 * une relation commerciale en cours, ou de démarcher quelqu'un qui est déjà
 * client. Les cas ci-dessous portent donc surtout sur ce qui NE doit PAS
 * bouger lors d'une synchronisation.
 */
'use strict';

const A = require('../agents/api.js');
const P = require('../agents/pipeline.js');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

/** Client dont chaque appel est enregistré, sans réseau. */
function fauxClient(reponses = {}) {
  const appels = [];
  const rep = (chemin) => reponses[chemin] !== undefined ? reponses[chemin] : {};
  return {
    appels,
    base: 'https://test',
    moi: async () => ({ profil: 'prospection' }),
    prospects: async (f) => { appels.push(['prospects', f]); return rep('prospects'); },
    toutesLesFiches: async (f) => { appels.push(['toutes', f]); return rep('prospects'); },
    creer: async (l) => { appels.push(['creer', l]); return { crees: l.length, doublons: 0 }; },
    majProspect: async (id, v) => { appels.push(['maj', id, v]); return {}; },
    journaliser: async (id, t, c) => { appels.push(['activite', id, t, c]); return {}; }
  };
}

const fiche = (o) => Object.assign({ id: 1, entreprise: 'X', statut: 'nouveau', score: 0 }, o);

/* ===================== Conversion ===================== */
console.log('Conversion des fiches');
{
  const f = A.versFiche(fiche({
    id: 7, entreprise: 'SOLAIRE DU VEXIN', siret: '81234567800019',
    email: 'contact@solaire-vexin.fr', telephone: '02 32 21 00 00',
    site: 'solaire-vexin.fr', ville: 'Vernon', departement: '27', score: 92
  }));
  check('entreprise → nom', f.nom === 'SOLAIRE DU VEXIN');
  check('SIRET conservé', f.siret === '81234567800019', f.siret);
  check('SIREN dérivé du SIRET', f.siren === '812345678', f.siren);
  check('e-mail → tableau', Array.isArray(f.emails) && f.emails[0] === 'contact@solaire-vexin.fr');
  check('téléphone → tableau', f.telephones[0] === '02 32 21 00 00');
  check('site préfixé', f.siteWeb === 'https://solaire-vexin.fr', f.siteWeb);
  check('identifiant CRM conservé', f.saasId === 7);
  check('score repris', f.score === 92);

  check('SIREN seul reconnu', A.versFiche(fiche({ siret: '812345678' })).siren === '812345678');
  check('identifiant aberrant ignoré', A.versFiche(fiche({ siret: '123' })).siren === '');
  check('site déjà en https non redoublé',
    A.versFiche(fiche({ site: 'https://a.fr' })).siteWeb === 'https://a.fr');
  check('sans e-mail → tableau vide', A.versFiche(fiche({})).emails.length === 0);

  /*
   * L'inspection doit redescendre du CRM jusqu'à la rédaction.
   *
   * Sans ce remontage, les deux moitiés fonctionnent parfaitement et le
   * résultat est quand même faux : `accroche()` ne trouve pas de `p.inspection`,
   * retombe sur sa formule générique, et le message redevient le publipostage
   * que l'inspection sert précisément à éviter. Le défaut ne se lit pas dans le
   * code, il se lit dans l'e-mail produit — d'où un test qui va jusque-là.
   */
  const R = require('../agents/redaction.js');
  const inspecte = A.versFiche(fiche({
    entreprise: 'Solaire du Vexin', site: 'solaire-vexin.fr', ville: 'Magny-en-Vexin',
    simulateur_niveau: 2, simulateur_url: 'https://solaire-vexin.fr/estimation',
    cible: 1, inspecte_le: '2026-08-12', enseigne: 'Solaire du Vexin',
    couleur: '#1e5aa8', couleur_apercu: '#1a63b4',
    enrichissement: { libelle: 'Estimation en ligne', donnees: ['consommation ou facture', 'e-mail', 'téléphone'] }
  }));
  check('le niveau du simulateur redescend', inspecte.inspection.niveau === 2,
    JSON.stringify(inspecte.inspection));
  check('les champs réclamés aussi',
    inspecte.inspection.donnees.includes('consommation ou facture'));
  check('les couleurs d’approche suivent',
    inspecte.inspection.couleur === '#1e5aa8' && inspecte.inspection.couleurApercu === '#1a63b4');

  const corps = R.rediger(inspecte, 'premier', '0').corps;
  check('l’accroche cite le site réellement visité', /solaire-vexin\.fr/.test(corps));
  check('elle cite ce que leur simulateur réclame',
    /consommation ou facture/.test(corps), corps.split('\n')[2]);
  check('elle n’est plus la formule générique',
    !/Nous travaillons avec des installateurs/.test(corps),
    'accroche générique = inspection perdue en route');

  const jamaisVu = A.versFiche(fiche({ entreprise: 'Y', site: 'y.fr' }));
  check('une fiche jamais inspectée n’invente pas d’inspection',
    jamaisVu.inspection === undefined, JSON.stringify(jamaisVu.inspection));

  const p = A.versProspect({ nom: 'A', emails: ['a@b.fr'], telephones: ['0102030405'],
    siteWeb: 'a.fr', ville: 'Lyon', codePostal: '69003', siren: '812345678', score: 40, etat: 'rdv' });
  check('nom → entreprise', p.entreprise === 'A');
  check('premier e-mail retenu', p.email === 'a@b.fr');
  check('département déduit du code postal', p.departement === '69', p.departement);
  check('source marquée hermes', p.source === 'hermes');
  check('état rdv → statut demo', p.statut === 'demo', p.statut);
  check('état inconnu → nouveau', A.versProspect({ nom: 'A', etat: 'zzz' }).statut === 'nouveau');
}

/* ===================== Correspondance des états ===================== */
console.log('\nCorrespondance des états');
{
  check('les relances restent « contacté » côté CRM',
    A.VERS_CRM.relance1 === 'contacte' && A.VERS_CRM.relance2 === 'contacte');
  check('gagne → client', A.VERS_CRM.gagne === 'client');
  check('exclu → perdu (le CRM n’a pas d’état d’opposition)', A.VERS_CRM.exclu === 'perdu');
  check('tout état Hermès a une correspondance',
    Object.keys(P.ETATS).every((e) => A.VERS_CRM[e]));
  check('toute étape du CRM a une correspondance',
    ['nouveau', 'a_contacter', 'contacte', 'demo', 'essai', 'client', 'perdu']
      .every((e) => A.DEPUIS_CRM[e]));
}

/* ===================== Client HTTP ===================== */
console.log('\nClient HTTP');
(async () => {
  let erreur = '';
  try { A.creerClient({ jeton: '' }); } catch (e) { erreur = e.message; }
  check('jeton absent → message qui dit quoi faire',
    /console/.test(erreur) && /EVASIMU_JETON/.test(erreur), erreur);

  const reponse = (statut, corps) => ({
    ok: statut < 400, status: statut, text: async () => JSON.stringify(corps)
  });

  let vues = null;
  const c = A.creerClient({
    base: 'https://app.eviatek.fr/', jeton: 'hs_test',
    fetch: async (url, o) => { vues = { url, o }; return reponse(200, { prospects: [fiche({})] }); }
  });
  check('barre finale retirée de la base', c.base === 'https://app.eviatek.fr', c.base);
  const l = await c.prospects({ limite: 10, statut: '' });
  check('jeton envoyé en Bearer', vues.o.headers.Authorization === 'Bearer hs_test');
  check('filtres vides omis de l’URL',
    vues.url === 'https://app.eviatek.fr/api/v1/prospects?limite=10', vues.url);
  check('liste renvoyée', l.length === 1);

  const c401 = A.creerClient({ jeton: 'x', fetch: async () => reponse(401, {}) });
  await c401.prospects().catch((e) => check('401 → « jeton refusé »', /refusé/.test(e.message), e.message));

  const c403 = A.creerClient({ jeton: 'x', fetch: async () => reponse(403, {}) });
  await c403.prospects().catch((e) =>
    check('403 → explique la portée manquante', /prospection/.test(e.message), e.message));

  const cKo = A.creerClient({ jeton: 'x', fetch: async () => { throw new Error('ECONNREFUSED'); } });
  await cKo.prospects().catch((e) =>
    check('réseau coupé → dit quelle URL est injoignable', /injoignable/.test(e.message), e.message));

  /* ===================== Descente CRM → pipeline ===================== */
  console.log('\nDescente : le CRM alimente le pipeline');
  {
    const store = P.vide();
    const client = fauxClient({ prospects: [
      fiche({ id: 1, entreprise: 'Neuve', siret: '81234567800019', email: 'a@neuve.fr' }),
      fiche({ id: 2, entreprise: 'Déjà cliente', siret: '52345678900012', email: 'b@cli.fr', statut: 'client' }),
      fiche({ id: 3, entreprise: 'En essai', siret: '63456789000013', email: 'c@ess.fr', statut: 'essai' })
    ] });
    const bilan = await A.descendre(store, client);
    check('toutes les fiches lues', bilan.lus === 3 && bilan.ajoutes === 3, JSON.stringify(bilan));
    check('identifiant CRM posé sur chaque fiche',
      Object.values(store.prospects).every((p) => p.saasId),
      JSON.stringify(Object.values(store.prospects).map((p) => p.saasId)));
    check('un prospect neuf reste « nouveau »', store.prospects['812345678'].etat === 'nouveau');
    check('un client existant n’est PAS démarché',
      store.prospects['523456789'].etat === 'gagne', store.prospects['523456789'].etat);
    check('un essai en cours est repris tel quel',
      store.prospects['634567890'].etat === 'essai');
    check('la reprise d’état est tracée',
      store.prospects['523456789'].historique.some((h) => h.evenement === 'synchro'));

    // Deuxième passage : rien ne doit rembobiner.
    P.marquer(store, '812345678', 'contacte', 'premier message');
    const b2 = await A.descendre(store, client);
    check('une resynchro ne rembobine pas un état en cours',
      store.prospects['812345678'].etat === 'contacte', store.prospects['812345678'].etat);
    check('resynchro : aucun ajout', b2.ajoutes === 0, JSON.stringify(b2));
    check('resynchro : aucun état repris à tort', b2.repris === 0);
  }

  {
    const store = P.vide();
    P.exclure(store, { email: 'a@neuve.fr' }, 'STOP reçu');
    const client = fauxClient({ prospects: [
      fiche({ id: 1, entreprise: 'Neuve', siret: '81234567800019', email: 'a@neuve.fr', statut: 'contacte' })
    ] });
    await A.descendre(store, client);
    check('le registre d’opposition prime sur le statut du CRM',
      store.prospects['812345678'].etat === 'exclu', store.prospects['812345678'].etat);
  }

  {
    const store = P.vide();
    const client = fauxClient({ prospects: [fiche({ id: 9, entreprise: '' })] });
    const b = await A.descendre(store, client);
    check('fiche sans nom écartée sans planter', b.ajoutes === 0 && b.lus === 1, JSON.stringify(b));
  }

  /* ===================== Remontée pipeline → CRM ===================== */
  console.log('\nRemontée : la console voit ce que l’agent a fait');
  {
    const client = fauxClient();
    const r = await A.remonter(client, { saasId: 12 }, { type: 'email', corps: 'objet', etat: 'contacte' });
    check('statut mis à jour', client.appels.some((a) => a[0] === 'maj' && a[1] === 12 && a[2].statut === 'contacte'));
    check('activité datée écrite', client.appels.some((a) => a[0] === 'activite' && a[1] === 12));
    check('bilan renvoyé', r.statut === 'contacte' && r.activite === 'email');

    const c2 = fauxClient();
    const r2 = await A.remonter(c2, { saasId: 5 }, { type: 'note', corps: 'x' });
    check('sans état demandé : activité seule, pas de PATCH',
      c2.appels.length === 1 && c2.appels[0][0] === 'activite', JSON.stringify(c2.appels));
    check('activité écrite quand même', r2.activite === 'note');

    const c3 = fauxClient();
    const r3 = await A.remonter(c3, { nom: 'orpheline' }, { type: 'email' });
    check('fiche non liée au CRM : rien n’est appelé', c3.appels.length === 0 && !!r3.ignore);
  }

  console.log('\nPagination : un agent doit voir TOUTE la base');
  {
    // Le serveur plafonne une réponse à 500 fiches. Un agent qui s'arrête là
    // travaille sur 8 % d'une base de 6 000 sans jamais le signaler — le pire
    // des cas, puisque la campagne semble tourner normalement.
    const base = Array.from({ length: 1250 }, (_, i) => fiche({ id: i + 1, entreprise: 'E' + i }));
    const urls = [];
    const cl = A.creerClient({
      jeton: 'x',
      fetch: async (url) => {
        urls.push(url);
        const u = new URL(url);
        const lim = parseInt(u.searchParams.get('limite'), 10);
        const off = parseInt(u.searchParams.get('offset'), 10);
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ prospects: base.slice(off, off + lim), total: base.length })
        };
      }
    });
    const tout = await cl.toutesLesFiches();
    check('toutes les fiches remontées', tout.length === 1250, String(tout.length));
    check('trois pages demandées', urls.length === 3, String(urls.length));
    check('les décalages s’enchaînent',
      urls.every((u, i) => u.includes('offset=' + i * 500)), urls.join(' '));
    check('aucun doublon entre les pages',
      new Set(tout.map((p) => p.id)).size === 1250);

    const avecTotal = [];
    await cl.toutesLesFiches({}, { progression: (lus, total) => avecTotal.push(lus + '/' + total) });
    check('la progression est rapportée', avecTotal[0] === '500/1250', avecTotal.join(' '));

    const plafonne = await cl.toutesLesFiches({}, { maximum: 600 });
    check('un plafond explicite est respecté', plafonne.length <= 1000 && plafonne.length >= 600,
      String(plafonne.length));

    // Une réponse sans « total » (ancienne version du serveur) ne doit pas
    // faire boucler : la page incomplète suffit à conclure.
    const vieux = A.creerClient({
      jeton: 'x',
      fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ prospects: [fiche({})] }) })
    });
    check('serveur sans total : on s’arrête à la page incomplète',
      (await vieux.toutesLesFiches()).length === 1);
  }

  console.log('\nRemontée d’une inspection de site');
  {
    const rapport = {
      joignable: true, pagesVues: ['https://x.fr/', 'https://x.fr/simulateur'],
      simulateur: {
        present: true, niveau: 2, url: 'https://x.fr/simulateur',
        libelle: 'calculateur d’économies', capacites: ['estimation de production'],
        donnees: ['nom', 'e-mail'], editeurs: ['Otovo']
      },
      identite: {
        nom: 'Solaire du Vexin', couleurs: ['#0b7285', '#f76707'],
        principale: '#0b7285', secondaire: '#f76707',
        apercuPrincipale: '#129292', apercuSecondaire: '#f0a523'
      },
      faits: ['simulateur en place'],
      verdict: { cible: true, raison: 'simulateur rudimentaire' }
    };
    const c = A.versInspection(rapport);
    check('le niveau monte en colonne', c.niveau === 2);
    check('la cible monte en colonne', c.cible === true);
    check('l’enseigne et la couleur montent en colonne',
      c.enseigne === 'Solaire du Vexin' && c.couleur === '#0b7285');
    check('la couleur d’aperçu est celle décalée, pas l’originale',
      c.couleurApercu === '#129292' && c.couleurApercu !== c.couleur);
    // Ce qui évoluera à chaque amélioration du détecteur reste en JSON : une
    // nouvelle capacité détectée ne doit pas coûter une migration de schéma.
    check('les capacités restent dans le détail',
      c.detail.capacites[0] === 'estimation de production' && c.niveau !== undefined);
    check('les éditeurs restent dans le détail', c.detail.editeurs[0] === 'Otovo');
    check('les pages visitées sont tracées', c.detail.pagesVues.length === 2);

    const ko = A.versInspection({ joignable: false, erreur: 'site injoignable (HTTP 500)' });
    check('site injoignable : la charge dit pourquoi', /injoignable/.test(ko.erreur));
    check('et n’invente aucun niveau', ko.niveau === undefined);
    check('rapport absent toléré', !!A.versInspection(null).erreur);

    const cl = fauxClient();
    cl.inspection = async (id, charge) => { cl.appels.push(['inspection', id, charge]); return {}; };
    const r = await A.remonterInspection(cl, { saasId: 7 }, rapport);
    check('la fiche du CRM est bien appelée',
      cl.appels.some((a) => a[0] === 'inspection' && a[1] === 7) && r.inspection === true);

    const cl2 = fauxClient();
    cl2.inspection = async () => { throw new Error('ne doit pas être appelé'); };
    const r2 = await A.remonterInspection(cl2, { nom: 'orpheline' }, rapport);
    check('fiche non liée : aucun appel', !!r2.ignore);
  }

  console.log('\n' + passed + ' tests réussis, ' + failed + ' échec(s)');
  process.exit(failed ? 1 : 0);
})();
