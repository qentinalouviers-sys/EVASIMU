/**
 * RDF-SOLAR SaaS — base de données (SQLite, sans dépendance)
 *
 * Utilise `node:sqlite`, intégré à Node ≥ 22.5 : pas de paquet à installer,
 * un seul fichier à sauvegarder. Le schéma est versionné et migré au démarrage.
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const MIGRATIONS = [
  // v1 — socle : opérateurs, clients (tenants), abonnements, CRM, leads
  `
  CREATE TABLE operateurs (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    nom TEXT NOT NULL DEFAULT '',
    mot_de_passe TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    cree_le TEXT NOT NULL
  );

  CREATE TABLE sessions (
    jeton TEXT PRIMARY KEY,
    operateur_id INTEGER NOT NULL REFERENCES operateurs(id) ON DELETE CASCADE,
    expire_le TEXT NOT NULL,
    cree_le TEXT NOT NULL
  );

  -- Jetons d'API pour les agents Hermès : un jeton = un profil (prospection,
  -- ventes, dev, secrétariat) avec ses portées.
  CREATE TABLE jetons_api (
    id INTEGER PRIMARY KEY,
    libelle TEXT NOT NULL,
    profil TEXT NOT NULL,
    portees TEXT NOT NULL,
    empreinte TEXT NOT NULL UNIQUE,
    prefixe TEXT NOT NULL,
    cree_le TEXT NOT NULL,
    derniere_utilisation TEXT,
    revoque INTEGER NOT NULL DEFAULT 0
  );

  -- Un client = une entreprise qui affiche le widget sur son site
  CREATE TABLE clients (
    id INTEGER PRIMARY KEY,
    cle TEXT NOT NULL UNIQUE,           -- identifiant public du widget
    slug TEXT NOT NULL UNIQUE,          -- identifiant de la page hébergée
    nom TEXT NOT NULL,
    statut TEXT NOT NULL DEFAULT 'essai', -- essai | actif | suspendu | expire
    formule TEXT NOT NULL DEFAULT 'essentiel',
    essai_fin TEXT,
    abonnement_fin TEXT,
    domaines TEXT NOT NULL DEFAULT '',  -- domaines autorisés à charger le widget
    config TEXT NOT NULL DEFAULT '{}',  -- thème, marque, catalogue, tarifs
    cree_le TEXT NOT NULL,
    maj_le TEXT NOT NULL,
    prospect_id INTEGER
  );

  -- Pages hébergées (SEO local) : une par ville / zone d'intervention
  CREATE TABLE pages (
    id INTEGER PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    slug TEXT NOT NULL UNIQUE,
    ville TEXT NOT NULL DEFAULT '',
    departement TEXT NOT NULL DEFAULT '',
    titre TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    contenu TEXT NOT NULL DEFAULT '{}',
    publiee INTEGER NOT NULL DEFAULT 1,
    cree_le TEXT NOT NULL,
    maj_le TEXT NOT NULL
  );

  -- Notre pipeline commercial : les entreprises à qui l'on vend le widget
  CREATE TABLE prospects (
    id INTEGER PRIMARY KEY,
    entreprise TEXT NOT NULL,
    contact TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    telephone TEXT NOT NULL DEFAULT '',
    site TEXT NOT NULL DEFAULT '',
    ville TEXT NOT NULL DEFAULT '',
    departement TEXT NOT NULL DEFAULT '',
    metier TEXT NOT NULL DEFAULT '',
    siret TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manuel',
    statut TEXT NOT NULL DEFAULT 'nouveau',
    score INTEGER NOT NULL DEFAULT 0,
    proprietaire TEXT NOT NULL DEFAULT '',
    prochaine_action TEXT,
    notes TEXT NOT NULL DEFAULT '',
    consentement TEXT,
    cree_le TEXT NOT NULL,
    maj_le TEXT NOT NULL
  );

  CREATE TABLE activites (
    id INTEGER PRIMARY KEY,
    prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    corps TEXT NOT NULL DEFAULT '',
    auteur TEXT NOT NULL DEFAULT '',
    cree_le TEXT NOT NULL
  );

  -- Leads captés par les widgets, propriété du client
  CREATE TABLE leads (
    id INTEGER PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    reference TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT '',
    nom TEXT NOT NULL DEFAULT '',
    telephone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    charge TEXT NOT NULL DEFAULT '{}',
    statut TEXT NOT NULL DEFAULT 'nouveau',
    cree_le TEXT NOT NULL
  );

  -- Journal d'usage : sert aux statistiques et à la preuve de valeur en fin d'essai
  CREATE TABLE evenements (
    id INTEGER PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}',
    jour TEXT NOT NULL,
    cree_le TEXT NOT NULL
  );

  CREATE TABLE commandes (
    id INTEGER PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    formule TEXT NOT NULL,
    montant_ht INTEGER NOT NULL,
    devise TEXT NOT NULL DEFAULT 'EUR',
    statut TEXT NOT NULL DEFAULT 'en_attente',
    moyen TEXT NOT NULL DEFAULT '',
    reference_externe TEXT NOT NULL DEFAULT '',
    cree_le TEXT NOT NULL,
    paye_le TEXT
  );

  CREATE INDEX idx_leads_client ON leads(client_id, cree_le);
  CREATE INDEX idx_evt_client ON evenements(client_id, jour);
  CREATE INDEX idx_prospects_statut ON prospects(statut, maj_le);
  CREATE INDEX idx_activites_prospect ON activites(prospect_id, cree_le);
  `,

  // v2 — enrichissement des fiches par les agents d'inspection.
  //
  // Deux natures de données, deux traitements. Ce sur quoi on filtre et on trie
  // mérite une colonne — « montre-moi les prospects sans simulateur du 27 » doit
  // rester une requête SQL, pas un parcours de JSON en mémoire. Le détail, lui,
  // va dans `enrichissement` : les capacités détectées évolueront à chaque
  // amélioration du détecteur, et chacune ne peut pas coûter une migration.
  //
  // NULL a du sens ici et n'est pas remplacé par une valeur par défaut :
  // `simulateur_niveau NULL` veut dire « jamais inspecté », ce qui n'est pas
  // « inspecté, aucun simulateur trouvé » (niveau 0).
  `
  ALTER TABLE prospects ADD COLUMN simulateur_niveau INTEGER;
  ALTER TABLE prospects ADD COLUMN simulateur_url TEXT NOT NULL DEFAULT '';
  ALTER TABLE prospects ADD COLUMN cible INTEGER;
  ALTER TABLE prospects ADD COLUMN inspecte_le TEXT;
  ALTER TABLE prospects ADD COLUMN enseigne TEXT NOT NULL DEFAULT '';
  ALTER TABLE prospects ADD COLUMN couleur TEXT NOT NULL DEFAULT '';
  ALTER TABLE prospects ADD COLUMN couleur_apercu TEXT NOT NULL DEFAULT '';
  ALTER TABLE prospects ADD COLUMN enrichissement TEXT NOT NULL DEFAULT '{}';

  CREATE INDEX idx_prospects_cible ON prospects(cible, simulateur_niveau);
  CREATE INDEX idx_prospects_inspecte ON prospects(inspecte_le);
  `
];

function nowIso() { return new Date().toISOString(); }
function jour() { return new Date().toISOString().slice(0, 10); }

function open(fichier) {
  const chemin = fichier || process.env.RDF_SAAS_DB || path.join(__dirname, '..', 'data', 'saas.db');
  if (chemin !== ':memory:') fs.mkdirSync(path.dirname(chemin), { recursive: true });
  const db = new DatabaseSync(chemin);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrer(db);
  return db;
}

function migrer(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  let v = db.prepare('SELECT version FROM schema_version').get();
  if (!v) {
    db.prepare('INSERT INTO schema_version(version) VALUES(0)').run();
    v = { version: 0 };
  }
  for (let i = v.version; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]);
    db.prepare('UPDATE schema_version SET version = ?').run(i + 1);
  }
}

/* ---------- Utilitaires partagés ---------- */

// Identifiant public court, sans caractères ambigus (lecture au téléphone,
// recopie depuis un e-mail : on évite 0/O et 1/l/I).
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function idPublic(longueur) {
  const octets = crypto.randomBytes(longueur || 12);
  let out = '';
  for (const o of octets) out += ALPHABET[o % ALPHABET.length];
  return out;
}

function slugifier(texte, secours) {
  const s = String(texte || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || (secours || idPublic(8));
}

function json(valeur, secours) {
  if (valeur === null || valeur === undefined) return secours;
  try { return JSON.parse(valeur); } catch (e) { return secours; }
}

module.exports = { open, migrer, nowIso, jour, idPublic, slugifier, json, MIGRATIONS };
