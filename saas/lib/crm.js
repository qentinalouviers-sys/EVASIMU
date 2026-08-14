/**
 * Mini-CRM : le pipeline commercial de l'éditeur (les installateurs à qui l'on
 * vend le widget), le journal d'activité, et les leads captés par les widgets
 * des clients.
 *
 * Deux notions distinctes qu'il ne faut pas confondre :
 *   prospects — les entreprises que NOUS démarchons ;
 *   leads     — les particuliers captés par le widget d'un client, qui lui
 *               appartiennent (nous ne faisons que les lui transmettre).
 */
'use strict';

const { nowIso, json } = require('./db.js');

const ETAPES = [
  { id: 'nouveau', nom: 'Nouveau', ordre: 1 },
  { id: 'a_contacter', nom: 'À contacter', ordre: 2 },
  { id: 'contacte', nom: 'Contacté', ordre: 3 },
  { id: 'demo', nom: 'Démo faite', ordre: 4 },
  { id: 'essai', nom: 'En essai', ordre: 5 },
  { id: 'client', nom: 'Client', ordre: 6 },
  { id: 'perdu', nom: 'Perdu', ordre: 7 }
];

const CHAMPS = ['entreprise', 'contact', 'email', 'telephone', 'site', 'ville',
  'departement', 'metier', 'siret', 'source', 'statut', 'score', 'proprietaire',
  'prochaine_action', 'notes',
  // Enrichissement par les agents d'inspection. `enrichissement` n'est pas dans
  // cette liste : il se fusionne au lieu de s'écraser, et passe par enrichir().
  'simulateur_niveau', 'simulateur_url', 'cible', 'inspecte_le',
  'enseigne', 'couleur', 'couleur_apercu'];

// Les champs qui ne sont pas du texte libre. Sans cette table, un `cible: false`
// arrivant en JSON devenait la chaîne « false », vraie en SQL comme en JS.
const BORNES = { score: [0, 100], simulateur_niveau: [0, 4] };
const BOOLEENS = ['cible'];

const NIVEAUX = [
  'aucun simulateur', 'formulaire de devis seulement', 'calculateur d’économies',
  'simulateur cartographique', 'simulateur avancé'
];

/** Ce que lira un humain dans le journal de la fiche. */
function resumeInspection(d) {
  if (d.erreur) return 'Site non inspectable : ' + d.erreur;
  const bouts = [];
  const n = parseInt(d.niveau, 10);
  bouts.push(Number.isNaN(n) ? 'site visité' : (NIVEAUX[Math.max(0, Math.min(4, n))] || 'niveau ' + n));
  if (d.url) bouts.push(d.url);
  const det = d.detail || {};
  if ((det.editeurs || []).length) bouts.push('outil : ' + det.editeurs.join(', '));
  if ((det.donnees || []).length) bouts.push('demande : ' + det.donnees.join(', '));
  if (d.cible === false) bouts.push('⚠ écarté du démarchage' + (d.raison ? ' — ' + d.raison : ''));
  return bouts.join(' · ').slice(0, 4000);
}

/**
 * Un numéro s'affiche par paires, comme partout ailleurs dans l'outil. Sans
 * cela, le numéro principal apparaissait « 02 32 21 00 00 » et les secondaires
 * « 0612345678 » sur la même fiche — deux formats côte à côte pour la même
 * information.
 */
function formaterTel(valeur) {
  const brut = String(valeur === null || valeur === undefined ? '' : valeur).trim();
  let d = brut.replace(/\(0\)/g, '').replace(/[^\d]/g, '');
  if (d.startsWith('0033')) d = '0' + d.slice(4);
  else if (d.startsWith('33') && d.length === 11) d = '0' + d.slice(2);
  if (/^0\d{9}$/.test(d)) return d.replace(/(\d{2})(?=\d)/g, '$1 ').trim();
  return brut.replace(/\s+/g, ' ');
}

/**
 * Un lead retenu (arrivé au-delà du quota du palier gratuit) sort de la base
 * sans ses coordonnées.
 *
 * Le masquage se fait à la lecture, pas à l'écriture : la donnée reste entière
 * en base, et le passage payant la rend d'un seul UPDATE. Ce qui subsiste — la
 * date, la ville, la puissance — suffit à montrer à l'installateur ce qu'il
 * laisse passer, ce qui est le but, sans lui livrer un contact qu'il n'a pas
 * encore payé.
 */
function masquerSiRetenu(l) {
  const charge = json(l.charge, {});
  if (!l.retenu) return Object.assign({}, l, { charge: charge });
  const projet = {};
  ['ville', 'codePostal', 'puissanceKwc', 'productionKwhAn', 'economiesAn', 'retourAns', 'offre']
    .forEach((k) => { if (charge[k] !== undefined) projet[k] = charge[k]; });
  return Object.assign({}, l, {
    nom: '', telephone: '', email: '', charge: projet, retenu: 1,
    masque: 'Au-delà des leads inclus dans votre formule — passez à Essentiel pour le débloquer'
  });
}

function creerCrm(db) {
  const st = {
    creer: db.prepare(`INSERT INTO prospects(entreprise, contact, email, telephone, site, ville,
      departement, metier, siret, source, statut, score, proprietaire, prochaine_action, notes,
      cree_le, maj_le) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    parId: db.prepare('SELECT * FROM prospects WHERE id = ?'),
    parSite: db.prepare('SELECT * FROM prospects WHERE site != \'\' AND site = ?'),
    parEmail: db.prepare('SELECT * FROM prospects WHERE email != \'\' AND email = ?'),
    supprimer: db.prepare('DELETE FROM prospects WHERE id = ?'),
    activite: db.prepare('INSERT INTO activites(prospect_id, type, corps, auteur, cree_le) VALUES(?,?,?,?,?)'),
    activites: db.prepare('SELECT * FROM activites WHERE prospect_id = ? ORDER BY cree_le DESC LIMIT 200'),
    parEtape: db.prepare('SELECT statut, COUNT(*) n FROM prospects GROUP BY statut'),
    aFaire: db.prepare(`SELECT * FROM prospects WHERE prochaine_action IS NOT NULL
      AND prochaine_action <= ? AND statut NOT IN ('client','perdu') ORDER BY prochaine_action LIMIT ?`),

    leadCreer: db.prepare(`INSERT INTO leads(client_id, reference, type, nom, telephone, email, charge, cree_le, retenu)
      VALUES(?,?,?,?,?,?,?,?,?)`),
    leadsLiberer: db.prepare('UPDATE leads SET retenu = 0 WHERE client_id = ? AND retenu = 1'),
    leadsClient: db.prepare('SELECT * FROM leads WHERE client_id = ? ORDER BY cree_le DESC LIMIT ?'),
    leadsTous: db.prepare(`SELECT l.*, c.nom nom_client, c.cle FROM leads l JOIN clients c ON c.id = l.client_id
      ORDER BY l.cree_le DESC LIMIT ?`),
    leadStatut: db.prepare('UPDATE leads SET statut = ? WHERE id = ?'),
    compterLeads: db.prepare('SELECT COUNT(*) n FROM leads WHERE client_id = ?'),
    compterLeadsDepuis: db.prepare('SELECT COUNT(*) n FROM leads WHERE client_id = ? AND cree_le >= ?'),

    coordAjouter: db.prepare(`INSERT OR IGNORE INTO coordonnees(prospect_id, type, valeur, libelle, cree_le)
      VALUES(?,?,?,?,?)`),
    coordListe: db.prepare('SELECT * FROM coordonnees WHERE prospect_id = ? ORDER BY type, id'),
    coordUne: db.prepare('SELECT * FROM coordonnees WHERE id = ?'),
    coordSupprimer: db.prepare('DELETE FROM coordonnees WHERE id = ?'),

    evt: db.prepare('INSERT INTO evenements(client_id, type, meta, jour, cree_le) VALUES(?,?,?,?,?)'),
    evtParType: db.prepare(`SELECT type, COUNT(*) n FROM evenements WHERE client_id = ? AND cree_le >= ?
      GROUP BY type`),
    evtParJour: db.prepare(`SELECT jour, COUNT(*) n FROM evenements
      WHERE client_id = ? AND type = 'affichage' AND jour >= ? GROUP BY jour ORDER BY jour`)
  };

  function nettoyer(valeurs) {
    const p = {};
    CHAMPS.forEach((c) => {
      const v = valeurs[c];
      if (v === undefined || v === null) return;
      if (BORNES[c]) {
        const n = parseInt(v, 10);
        if (Number.isNaN(n)) return;
        p[c] = Math.max(BORNES[c][0], Math.min(BORNES[c][1], n));
      } else if (BOOLEENS.includes(c)) {
        // SQLite n'a pas de booléen : on range 0 ou 1, et on accepte les formes
        // qu'un agent ou un formulaire peut réellement envoyer.
        p[c] = (v === true || v === 1 || v === '1' || v === 'true' || v === 'oui') ? 1 : 0;
      } else {
        p[c] = String(v).slice(0, 4000);
      }
    });
    if (p.site) p.site = p.site.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (p.email) p.email = p.email.trim().toLowerCase();
    if (p.statut && !ETAPES.some((e) => e.id === p.statut)) delete p.statut;
    if (p.couleur && !/^#[0-9a-fA-F]{6}$/.test(p.couleur)) delete p.couleur;
    if (p.couleur_apercu && !/^#[0-9a-fA-F]{6}$/.test(p.couleur_apercu)) delete p.couleur_apercu;
    return p;
  }

  /**
   * Les e-mails et téléphones supplémentaires d'une fiche importée. Un export
   * d'Hermès porte `emails[]` et `telephones[]` : seule la première valeur
   * devenait la coordonnée principale, les autres partaient en texte libre.
   */
  function enregistrerContactsSecondaires(prospectId, valeurs, t) {
    const v = valeurs || {};
    (v.emailsSup || []).forEach((e) => {
      if (e && e !== v.email) st.coordAjouter.run(prospectId, 'email', String(e).slice(0, 200), 'importé', t);
    });
    (v.telephonesSup || []).forEach((tel) => {
      if (tel && tel !== v.telephone) {
        st.coordAjouter.run(prospectId, 'telephone', formaterTel(tel).slice(0, 200), 'importé', t);
      }
    });
  }

  return {
    ETAPES,

    /* --- prospects --- */
    creerProspect(valeurs, auteur) {
      const p = nettoyer(valeurs || {});
      if (!p.entreprise) { const e = new Error('entreprise requise'); e.code = 400; throw e; }
      // Dédoublonnage : deux agents qui prospectent la même zone ne doivent pas
      // créer deux fiches pour la même entreprise.
      const existant = (p.site && st.parSite.get(p.site)) || (p.email && st.parEmail.get(p.email));
      if (existant) return { prospect: this.prospect(existant.id), doublon: true };
      const t = nowIso();
      const r = st.creer.run(
        p.entreprise, p.contact || '', p.email || '', p.telephone || '', p.site || '',
        p.ville || '', p.departement || '', p.metier || '', p.siret || '',
        p.source || 'manuel', p.statut || 'nouveau', p.score || 0, p.proprietaire || '',
        p.prochaine_action || null, p.notes || '', t, t
      );
      const id = Number(r.lastInsertRowid);
      st.activite.run(id, 'creation', 'Fiche créée (source : ' + (p.source || 'manuel') + ')', auteur || '', t);
      enregistrerContactsSecondaires(id, valeurs, t);
      return { prospect: this.prospect(id), doublon: false };
    },

    /**
     * Import en lot — le chemin chaud, et le seul qui compte pour un gros
     * fichier. Trois choses le séparent d'une boucle sur `creerProspect` :
     *
     *   1. UNE SEULE TRANSACTION. En WAL, chaque insertion isolée provoque une
     *      synchronisation disque : sur 20 000 lignes, c'est la différence
     *      entre quelques secondes et plusieurs minutes — et donc entre un
     *      import qui passe et une requête qui expire côté proxy.
     *   2. AUCUNE RELECTURE. `creerProspect` renvoie la fiche complète avec
     *      jusqu'à 200 activités ; ici on ne veut qu'un compteur.
     *   3. LE DÉTAIL EST PLAFONNÉ. Un fichier de 50 000 lignes fautives
     *      produirait une réponse JSON plus grosse que le fichier envoyé.
     *
     * Une ligne fautive n'annule jamais le lot : elle est comptée et décrite.
     */
    importerEnLot(lignes, auteur, options) {
      const o = options || {};
      const maxDetails = o.maxDetails || 200;
      const r = { crees: 0, doublons: 0, rejetes: 0, avertis: 0, details: [], detailsTronques: 0 };
      const noter = (d) => {
        if (r.details.length < maxDetails) r.details.push(d);
        else r.detailsTronques++;
      };
      const t = nowIso();

      db.exec('BEGIN');
      try {
        (lignes || []).forEach((l) => {
          if (!l.valide) {
            r.rejetes++;
            noter({ ligne: l.numero, entreprise: (l.prospect || {}).entreprise || '', erreurs: l.erreurs });
            return;
          }
          try {
            const p = nettoyer(l.prospect || {});
            if (!p.entreprise) throw new Error('entreprise requise');
            // Le dédoublonnage voit les lignes déjà insérées dans CETTE
            // transaction : un doublon interne au fichier est donc attrapé.
            if ((p.site && st.parSite.get(p.site)) || (p.email && st.parEmail.get(p.email))) {
              r.doublons++;
            } else {
              const ins = st.creer.run(
                p.entreprise, p.contact || '', p.email || '', p.telephone || '', p.site || '',
                p.ville || '', p.departement || '', p.metier || '', p.siret || '',
                p.source || 'import', p.statut || 'nouveau', p.score || 0, p.proprietaire || '',
                p.prochaine_action || null, p.notes || '', t, t
              );
              const nouvelId = Number(ins.lastInsertRowid);
              st.activite.run(nouvelId, 'creation',
                'Fiche créée (source : ' + (p.source || 'import') + ')', auteur || '', t);
              enregistrerContactsSecondaires(nouvelId, l.prospect, t);
              r.crees++;
            }
            if ((l.avertissements || []).length) {
              r.avertis++;
              noter({ ligne: l.numero, entreprise: p.entreprise, avertissements: l.avertissements });
            }
          } catch (e) {
            r.rejetes++;
            noter({ ligne: l.numero, entreprise: (l.prospect || {}).entreprise || '', erreurs: [e.message] });
          }
        });
        db.exec('COMMIT');
      } catch (e) {
        // Échec du moteur lui-même (disque plein, base verrouillée) : on ne
        // laisse pas une transaction ouverte derrière soi.
        try { db.exec('ROLLBACK'); } catch (_) { /* déjà refermée */ }
        throw e;
      }
      return r;
    },

    majProspect(id, valeurs, auteur) {
      const actuel = st.parId.get(id);
      if (!actuel) return null;
      const p = nettoyer(valeurs || {});
      const champs = Object.keys(p);
      if (!champs.length) return this.prospect(id);
      const sql = 'UPDATE prospects SET ' + champs.map((c) => c + ' = ?').join(', ') +
        ', maj_le = ? WHERE id = ?';
      db.prepare(sql).run(...champs.map((c) => p[c]), nowIso(), id);
      if (p.statut && p.statut !== actuel.statut) {
        st.activite.run(id, 'statut', actuel.statut + ' → ' + p.statut, auteur || '', nowIso());
      }
      return this.prospect(id);
    },

    prospect(id) {
      const p = st.parId.get(id);
      if (!p) return null;
      return Object.assign({}, p, {
        activites: st.activites.all(id),
        coordonnees: st.coordListe.all(id),
        enrichissement: json(p.enrichissement, {})
      });
    },

    /* --- coordonnées secondaires --- */

    /**
     * Ajoute un e-mail ou un téléphone à une fiche. La valeur est normalisée
     * comme la principale, sinon « 06 12 34 56 78 » et « 0612345678 »
     * coexisteraient comme deux contacts distincts.
     */
    ajouterCoordonnee(prospectId, type, valeur, libelle, auteur) {
      if (!st.parId.get(prospectId)) return null;
      const t = type === 'email' ? 'email' : 'telephone';
      const v = t === 'email' ? String(valeur || '').trim().toLowerCase() : formaterTel(valeur);
      if (!v) { const e = new Error('valeur vide'); e.code = 400; throw e; }
      if (t === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) {
        const e = new Error('adresse e-mail invalide'); e.code = 400; throw e;
      }
      st.coordAjouter.run(prospectId, t, v.slice(0, 200), String(libelle || '').slice(0, 60), nowIso());
      st.activite.run(prospectId, 'contact',
        (t === 'email' ? 'E-mail ajouté : ' : 'Téléphone ajouté : ') + v +
        (libelle ? ' (' + libelle + ')' : ''), auteur || '', nowIso());
      return this.prospect(prospectId);
    },

    supprimerCoordonnee(id, auteur) {
      const c = st.coordUne.get(id);
      if (!c) return null;
      st.coordSupprimer.run(id);
      st.activite.run(c.prospect_id, 'contact', 'Contact retiré : ' + c.valeur, auteur || '', nowIso());
      return this.prospect(c.prospect_id);
    },

    /**
     * Promeut une coordonnée secondaire en principale. L'ancienne principale
     * n'est pas jetée : elle redescend dans la liste, sinon désigner le bon
     * interlocuteur ferait perdre l'accueil.
     */
    definirPrincipale(id, auteur) {
      const c = st.coordUne.get(id);
      if (!c) return null;
      const p = st.parId.get(c.prospect_id);
      if (!p) return null;
      const colonne = c.type === 'email' ? 'email' : 'telephone';
      const ancienne = p[colonne];
      db.prepare('UPDATE prospects SET ' + colonne + ' = ?, maj_le = ? WHERE id = ?')
        .run(c.valeur, nowIso(), p.id);
      st.coordSupprimer.run(id);
      if (ancienne) {
        st.coordAjouter.run(p.id, c.type, ancienne, 'ancienne principale', nowIso());
      }
      st.activite.run(p.id, 'contact', 'Contact principal : ' + c.valeur, auteur || '', nowIso());
      return this.prospect(p.id);
    },

    /**
     * Report d'une inspection de site sur la fiche.
     *
     * Deux règles qui expliquent pourquoi ce n'est pas un simple PATCH :
     *
     *   1. le détail se FUSIONNE. Une passe qui n'a pas su lire les couleurs ne
     *      doit pas effacer celles qu'une passe précédente avait trouvées ;
     *   2. l'enrichissement est JOURNALISÉ. Un commercial qui ouvre la fiche
     *      doit voir qu'un agent est passé, quand, et ce qu'il a conclu — sans
     *      quoi les champs changent tout seuls sous ses yeux.
     *
     * Le statut commercial n'est jamais touché : conclure « pas une cible » est
     * une information, décider de l'abandonner est une décision humaine.
     */
    enrichir(id, donnees, auteur) {
      const actuel = st.parId.get(id);
      if (!actuel) return null;
      const d = donnees || {};

      const colonnes = nettoyer({
        simulateur_niveau: d.niveau,
        simulateur_url: d.url,
        cible: d.cible,
        inspecte_le: d.date || nowIso().slice(0, 10),
        enseigne: d.enseigne,
        couleur: d.couleur,
        couleur_apercu: d.couleurApercu
      });
      // Une fiche déjà nommée garde son nom : l'enseigne affichée sur le site
      // complète la raison sociale, elle ne la remplace pas.
      if (!actuel.entreprise && d.enseigne) colonnes.entreprise = String(d.enseigne).slice(0, 4000);

      const fusion = Object.assign(json(actuel.enrichissement, {}), d.detail || {});
      const champs = Object.keys(colonnes);
      db.prepare('UPDATE prospects SET ' + champs.concat('enrichissement', 'maj_le')
        .map((c) => c + ' = ?').join(', ') + ' WHERE id = ?')
        .run(...champs.map((c) => colonnes[c]), JSON.stringify(fusion).slice(0, 60000), nowIso(), id);

      st.activite.run(id, 'inspection', resumeInspection(d), auteur || '', nowIso());
      return this.prospect(id);
    },

    /**
     * Conditions communes à la liste et au comptage. Les deux doivent voir
     * exactement le même jeu de fiches : un total qui ne correspond pas à ce
     * qu'on affiche est pire que pas de total du tout.
     */
    _filtres(f) {
      const ou = [], args = [];
      if (f.statut) { ou.push('statut = ?'); args.push(f.statut); }
      if (f.ville) { ou.push('ville LIKE ?'); args.push('%' + f.ville + '%'); }
      if (f.departement) { ou.push('departement = ?'); args.push(f.departement); }
      if (f.metier) { ou.push('metier LIKE ?'); args.push('%' + f.metier + '%'); }
      if (f.proprietaire) { ou.push('proprietaire = ?'); args.push(f.proprietaire); }
      if (f.avecSite === true) ou.push("site != ''");
      if (f.avecSite === false) ou.push("site = ''");
      // Filtres d'inspection. `inspecte` distingue bien trois états : jamais vu,
      // vu, et — implicitement — vu sans rien trouver (niveau 0).
      if (f.inspecte === true) ou.push('inspecte_le IS NOT NULL');
      if (f.inspecte === false) ou.push('inspecte_le IS NULL');
      if (f.cible === true) ou.push('cible = 1');
      if (f.cible === false) ou.push('cible = 0');
      if (f.niveauMax !== undefined && f.niveauMax !== '') {
        ou.push('simulateur_niveau IS NOT NULL AND simulateur_niveau <= ?');
        args.push(parseInt(f.niveauMax, 10) || 0);
      }
      if (f.q) {
        ou.push('(entreprise LIKE ? OR contact LIKE ? OR email LIKE ? OR ville LIKE ?)');
        const q = '%' + f.q + '%'; args.push(q, q, q, q);
      }
      return { ou: ou.length ? ' WHERE ' + ou.join(' AND ') : '', args };
    },

    /**
     * Une page de prospects.
     *
     * Le plafond de 500 par requête reste : envoyer 6 000 fiches d'un coup
     * fabrique une réponse de plusieurs mégaoctets pour un écran qui en montre
     * vingt. Ce qui manquait, c'est le `offset` — sans lui, tout ce qui dépasse
     * la première page est simplement invisible, et un import de 6 000 fiches
     * donne l'impression d'en avoir importé 100.
     */
    listerProspects(filtres) {
      const f = filtres || {};
      const { ou, args } = this._filtres(f);
      const limite = Math.max(1, Math.min(500, parseInt(f.limite, 10) || 100));
      const offset = Math.max(0, parseInt(f.offset, 10) || 0);
      return db.prepare('SELECT * FROM prospects' + ou + ' ORDER BY maj_le DESC, id DESC LIMIT ? OFFSET ?')
        .all(...args, limite, offset);
    },

    /** Combien de fiches répondent à ces filtres, indépendamment de la page. */
    compterProspects(filtres) {
      const { ou, args } = this._filtres(filtres || {});
      return db.prepare('SELECT COUNT(*) n FROM prospects' + ou).get(...args).n;
    },

    supprimerProspect(id) { st.supprimer.run(id); },

    journaliser(prospectId, type, corps, auteur) {
      st.activite.run(prospectId, String(type || 'note'), String(corps || '').slice(0, 4000),
        auteur || '', nowIso());
      return this.prospect(prospectId);
    },

    aFaire(limite) {
      return st.aFaire.all(nowIso(), Math.min(200, limite || 50));
    },

    pipeline() {
      const compte = {};
      st.parEtape.all().forEach((r) => { compte[r.statut] = r.n; });
      return ETAPES.map((e) => Object.assign({}, e, { total: compte[e.id] || 0 }));
    },

    /* --- leads des clients --- */
    enregistrerLead(clientId, charge, retenu) {
      const c = charge || {};
      const r = st.leadCreer.run(
        clientId, String(c.reference || '').slice(0, 60), String(c.type || '').slice(0, 60),
        String(c.nom || '').slice(0, 200), String(c.telephone || '').slice(0, 40),
        String(c.email || '').slice(0, 200), JSON.stringify(c).slice(0, 60000), nowIso(),
        retenu ? 1 : 0
      );
      return Number(r.lastInsertRowid);
    },

    /** Nombre de leads du client depuis une date — sert au quota du mois. */
    compterLeadsDepuis(clientId, depuis) {
      return st.compterLeadsDepuis.get(clientId, depuis).n;
    },

    /**
     * Passage à une formule sans quota : tous les leads retenus sont libérés.
     * Rétroactif par construction — un installateur qui s'abonne récupère les
     * contacts arrivés pendant qu'il était au palier gratuit.
     */
    libererLeads(clientId) {
      const r = st.leadsLiberer.run(clientId);
      return Number(r.changes || 0);
    },
    leadsDuClient(clientId, limite) {
      return st.leadsClient.all(clientId, Math.min(500, limite || 100)).map(masquerSiRetenu);
    },
    tousLesLeads(limite) {
      return st.leadsTous.all(Math.min(500, limite || 100)).map(masquerSiRetenu);
    },
    majStatutLead(id, statut) { st.leadStatut.run(String(statut || 'nouveau'), id); },

    /* --- usage --- */
    evenement(clientId, type, meta) {
      st.evt.run(clientId || null, String(type || '').slice(0, 40),
        JSON.stringify(meta || {}).slice(0, 2000), nowIso().slice(0, 10), nowIso());
    },

    /**
     * Statistiques d'un client — c'est l'argument de la relance de fin d'essai :
     * « 240 visiteurs, 31 simulations, 6 demandes de devis en 30 jours ».
     */
    statsClient(clientId, depuisJours) {
      const depuis = new Date(Date.now() - (depuisJours || 30) * 86400000).toISOString();
      const parType = {};
      st.evtParType.all(clientId, depuis).forEach((r) => { parType[r.type] = r.n; });
      return {
        periodeJours: depuisJours || 30,
        affichages: parType.affichage || 0,
        simulations: parType.etape || 0,
        leads: st.compterLeadsDepuis.get(clientId, depuis).n,
        leadsTotal: st.compterLeads.get(clientId).n,
        parJour: st.evtParJour.all(clientId, depuis.slice(0, 10))
      };
    }
  };
}

module.exports = { creerCrm, ETAPES, formaterTel };
