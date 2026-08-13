/**
 * Sauvegarde de la base du SaaS.
 *
 *   node saas/tools/sauvegarde.js [dossier]
 *
 * Utilise « VACUUM INTO », qui produit une copie COHÉRENTE même pendant que le
 * serveur écrit — contrairement à un simple `cp` du fichier, qui peut capturer
 * une base à moitié écrite et laisser de côté le journal WAL. Aucun outil
 * externe n'est nécessaire : c'est SQLite lui-même qui fait le travail.
 *
 * Les copies sont compressées, et les anciennes purgées (30 jours par défaut).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');

const BASE = process.env.RDF_SAAS_DB || path.join(__dirname, '..', 'data', 'saas.db');
const DOSSIER = process.argv[2] || process.env.RDF_SAAS_SAUVEGARDES ||
  path.join(__dirname, '..', '..', 'sauvegardes');
const RETENTION_JOURS = parseInt(process.env.RDF_SAAS_RETENTION_JOURS, 10) || 30;

function horodatage() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function principal() {
  if (!fs.existsSync(BASE)) {
    console.error('Base introuvable : ' + BASE);
    process.exit(1);
  }
  fs.mkdirSync(DOSSIER, { recursive: true });

  const brut = path.join(DOSSIER, 'saas-' + horodatage() + '.db');
  const db = new DatabaseSync(BASE, { readOnly: true });
  try {
    // Le chemin est interpolé dans du SQL : on refuse tout ce qui pourrait en sortir.
    if (brut.indexOf("'") !== -1) throw new Error('chemin de sauvegarde invalide');
    db.exec("VACUUM INTO '" + brut + "'");
  } finally {
    db.close();
  }

  const comprime = brut + '.gz';
  fs.writeFileSync(comprime, zlib.gzipSync(fs.readFileSync(brut), { level: 9 }));
  fs.unlinkSync(brut);

  // Purge des anciennes copies
  const limite = Date.now() - RETENTION_JOURS * 86400000;
  let purgees = 0;
  fs.readdirSync(DOSSIER).forEach((f) => {
    if (!/^saas-.*\.db\.gz$/.test(f)) return;
    const complet = path.join(DOSSIER, f);
    if (fs.statSync(complet).mtimeMs < limite) { fs.unlinkSync(complet); purgees++; }
  });

  const taille = fs.statSync(comprime).size;
  console.log('Sauvegarde : ' + comprime + ' (' + Math.round(taille / 1024) + ' Ko)' +
    (purgees ? ' — ' + purgees + ' ancienne(s) purgée(s)' : ''));
}

if (require.main === module) principal();
module.exports = { principal };
