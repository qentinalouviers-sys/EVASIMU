/**
 * Authentification : opérateurs humains (session par cookie) et agents Hermès
 * (jeton Bearer avec profil et portées).
 *
 * Mots de passe : scrypt (node:crypto), sel aléatoire, comparaison à temps
 * constant. Jetons d'API : seule l'empreinte SHA-256 est stockée — un vol de
 * base ne donne aucun jeton utilisable.
 */
'use strict';

const crypto = require('crypto');
const { nowIso, idPublic } = require('./db.js');
const { egal } = require('./http.js');

const DUREE_SESSION_S = 12 * 3600;

/* ---------- Mots de passe ---------- */

function hacher(motDePasse) {
  const sel = crypto.randomBytes(16);
  const cle = crypto.scryptSync(String(motDePasse), sel, 64, { N: 16384, r: 8, p: 1 });
  return 'scrypt$16384$' + sel.toString('hex') + '$' + cle.toString('hex');
}

function verifier(motDePasse, stocke) {
  try {
    const [algo, n, selHex, cleHex] = String(stocke).split('$');
    if (algo !== 'scrypt') return false;
    const cle = crypto.scryptSync(String(motDePasse), Buffer.from(selHex, 'hex'), 64,
      { N: parseInt(n, 10), r: 8, p: 1 });
    return crypto.timingSafeEqual(cle, Buffer.from(cleHex, 'hex'));
  } catch (e) {
    return false;
  }
}

/* ---------- Profils d'agents et portées ---------- */

// Chaque profil Hermès reçoit le minimum dont il a besoin. Un agent de
// prospection ne doit pas pouvoir activer un abonnement, un agent secrétariat
// ne doit pas pouvoir supprimer un client.
const PROFILS = {
  prospection: ['prospects:lire', 'prospects:ecrire', 'activites:ecrire', 'clients:lire'],
  ventes: ['prospects:lire', 'prospects:ecrire', 'activites:ecrire',
    'clients:lire', 'clients:ecrire', 'essai:gerer', 'abonnement:gerer',
    'stats:lire', 'leads:lire'],
  dev: ['clients:lire', 'clients:ecrire', 'pages:ecrire', 'stats:lire', 'systeme:lire'],
  secretariat: ['prospects:lire', 'activites:ecrire', 'clients:lire', 'leads:lire', 'stats:lire'],
  admin: ['*']
};

function porteesDuProfil(profil) {
  return PROFILS[profil] || [];
}

function autorise(portees, requise) {
  if (!portees || !portees.length) return false;
  return portees.indexOf('*') !== -1 || portees.indexOf(requise) !== -1;
}

/* ---------- Contexte d'authentification ---------- */

function creerAuth(db) {
  const st = {
    parEmail: db.prepare('SELECT * FROM operateurs WHERE email = ?'),
    creerSession: db.prepare('INSERT INTO sessions(jeton, operateur_id, expire_le, cree_le) VALUES(?,?,?,?)'),
    session: db.prepare(`SELECT s.*, o.email, o.nom, o.role FROM sessions s
                         JOIN operateurs o ON o.id = s.operateur_id WHERE s.jeton = ?`),
    supprimerSession: db.prepare('DELETE FROM sessions WHERE jeton = ?'),
    purgerSessions: db.prepare('DELETE FROM sessions WHERE expire_le < ?'),
    creerOperateur: db.prepare(`INSERT INTO operateurs(email, nom, mot_de_passe, role, cree_le)
                                VALUES(?,?,?,?,?)`),
    compterOperateurs: db.prepare('SELECT COUNT(*) n FROM operateurs'),
    jetonParEmpreinte: db.prepare('SELECT * FROM jetons_api WHERE empreinte = ? AND revoque = 0'),
    toucherJeton: db.prepare('UPDATE jetons_api SET derniere_utilisation = ? WHERE id = ?'),
    creerJeton: db.prepare(`INSERT INTO jetons_api(libelle, profil, portees, empreinte, prefixe, cree_le)
                            VALUES(?,?,?,?,?,?)`),
    listerJetons: db.prepare('SELECT id, libelle, profil, portees, prefixe, cree_le, derniere_utilisation, revoque FROM jetons_api ORDER BY id DESC'),
    revoquerJeton: db.prepare('UPDATE jetons_api SET revoque = 1 WHERE id = ?')
  };

  function empreinte(jeton) {
    return crypto.createHash('sha256').update(String(jeton)).digest('hex');
  }

  return {
    /* --- opérateurs --- */
    creerOperateur(email, nom, motDePasse, role) {
      st.creerOperateur.run(String(email).toLowerCase().trim(), nom || '',
        hacher(motDePasse), role || 'admin', nowIso());
      return st.parEmail.get(String(email).toLowerCase().trim());
    },
    aucunOperateur() { return st.compterOperateurs.get().n === 0; },

    connecter(email, motDePasse) {
      const op = st.parEmail.get(String(email || '').toLowerCase().trim());
      // On vérifie toujours un hachage, même sans compte : le temps de réponse
      // ne dit pas si l'e-mail existe.
      const reference = op ? op.mot_de_passe : hacher('mot-de-passe-inexistant');
      const ok = verifier(motDePasse, reference);
      if (!op || !ok) return null;
      const jeton = crypto.randomBytes(32).toString('base64url');
      const expire = new Date(Date.now() + DUREE_SESSION_S * 1000).toISOString();
      st.creerSession.run(jeton, op.id, expire, nowIso());
      return { jeton, expire, operateur: { id: op.id, email: op.email, nom: op.nom, role: op.role } };
    },

    session(jeton) {
      if (!jeton) return null;
      st.purgerSessions.run(nowIso());
      const s = st.session.get(jeton);
      if (!s || s.expire_le < nowIso()) return null;
      return {
        type: 'operateur',
        operateur: { id: s.operateur_id, email: s.email, nom: s.nom, role: s.role },
        portees: ['*']
      };
    },
    deconnecter(jeton) { if (jeton) st.supprimerSession.run(jeton); },

    /* --- jetons d'agents --- */
    creerJetonApi(libelle, profil) {
      const portees = porteesDuProfil(profil);
      if (!portees.length) throw new Error('profil inconnu : ' + profil);
      // Le jeton n'est montré qu'une fois : seule son empreinte est conservée.
      const secret = 'hrm_' + profil.slice(0, 4) + '_' + crypto.randomBytes(24).toString('base64url');
      st.creerJeton.run(libelle || profil, profil, portees.join(' '), empreinte(secret),
        secret.slice(0, 12), nowIso());
      return { secret, profil, portees };
    },
    jeton(valeur) {
      if (!valeur) return null;
      const j = st.jetonParEmpreinte.get(empreinte(valeur));
      if (!j) return null;
      st.toucherJeton.run(nowIso(), j.id);
      return {
        type: 'agent',
        agent: { id: j.id, libelle: j.libelle, profil: j.profil },
        portees: j.portees.split(' ').filter(Boolean)
      };
    },
    listerJetons() {
      return st.listerJetons.all().map((j) => Object.assign({}, j, { portees: j.portees.split(' ') }));
    },
    revoquerJeton(id) { st.revoquerJeton.run(id); },

    /* --- résolution d'une requête --- */
    depuisRequete(req, cookiesLus) {
      const entete = req.headers.authorization || '';
      if (/^Bearer /i.test(entete)) {
        const brut = entete.slice(7).trim();
        return this.jeton(brut);
      }
      return this.session((cookiesLus || {}).rdf_session);
    },

    autorise,
    porteesDuProfil,
    PROFILS,
    _egal: egal
  };
}

module.exports = { creerAuth, hacher, verifier, PROFILS, porteesDuProfil, autorise, DUREE_SESSION_S };
