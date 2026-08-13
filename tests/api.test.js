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
    /console/.test(erreur) && /RDF_SAAS_JETON/.test(erreur), erreur);

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

  console.log('\n' + passed + ' tests réussis, ' + failed + ' échec(s)');
  process.exit(failed ? 1 : 0);
})();
