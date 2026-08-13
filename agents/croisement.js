/*!
 * Hermès — Outil de capture de prospects par croisement de sources
 *
 * Réconcilie plusieurs sources publiques en une fiche unique par entreprise,
 * en gardant la trace de qui a fourni quoi.
 *
 *   annuaire des entreprises  →  identité officielle (SIRET, APE, effectif), zéro contact
 *   annuaire RGE (ADEME)      →  qualification Quali'PV + souvent e-mail et téléphone
 *   site web de l'entreprise  →  contacts à jour + présence d'un simulateur concurrent
 *
 * Le croisement fait deux choses qu'aucune source ne fait seule :
 *   1. il complète — le RGE apporte le contact que l'annuaire n'a pas ;
 *   2. il confirme — une entreprise présente dans les trois sources, qualifiée
 *      Quali'PV et sans simulateur, est un prospect qualifié, pas une ligne de fichier.
 *
 * Produit trois fichiers : CSV, JSON, et un tableau de bord HTML autonome pour
 * trier, filtrer et sélectionner les prospects à travailler.
 *
 * Usage :
 *   node agents/croisement.js --departement 69 --pages 3 --sortie data/lyon
 *   node agents/croisement.js --departement 69 --rge-csv rge.csv --sans-site
 *   node agents/croisement.js --help
 */
'use strict';

const fs = require('fs');
const path = require('path');
const S = require('./sourcing.js');
const RGE = require('./rge.js');

/* ===================== Normalisation des noms ===================== */

const FORMES_JURIDIQUES = /\b(sarl|sas|sasu|eurl|sa|sci|scop|snc|ei|eirl|ets?|etablissements?|societe|ste|entreprise|groupe)\b/g;

/** Réduit une raison sociale à sa forme comparable : c'est la clé du rapprochement flou. */
function normaliserNom(nom) {
  return RGE.sansAccents(nom || '')
    .replace(/_/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    // « S.A.S. » devient « s a s » une fois la ponctuation retirée : on recolle
    // les suites de lettres isolées, sinon la forme juridique survit au filtre
    // et deux fiches de la même entreprise ne se rapprochent plus.
    .replace(/\b(?:[a-z] ){1,}[a-z]\b/g, (m) => m.replace(/\s+/g, ''))
    .replace(FORMES_JURIDIQUES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Similarité de Dice sur les mots : 1 = identique, 0 = rien en commun. */
function similariteNoms(a, b) {
  const ta = new Set(normaliserNom(a).split(' ').filter(Boolean));
  const tb = new Set(normaliserNom(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let communs = 0;
  for (const m of ta) if (tb.has(m)) communs++;
  return (2 * communs) / (ta.size + tb.size);
}

/* ===================== Appariement ===================== */

const SEUIL_NOM = 0.7;

/**
 * Regroupe les fiches de toutes les sources qui désignent la même entreprise.
 * Trois niveaux, du plus sûr au plus permissif :
 *   1. SIREN identique      — certitude
 *   2. SIRET identique      — certitude
 *   3. nom proche ET même code postal — faute de SIREN dans une des sources
 */
function apparier(fiches) {
  const groupes = [];
  const parSiren = new Map();

  for (const f of fiches) {
    if (!f) continue;
    const siren = f.siren || (f.siret ? String(f.siret).slice(0, 9) : '');

    if (siren) {
      const g = parSiren.get(siren);
      if (g) { g.push(f); continue; }
      const nouveau = [f];
      parSiren.set(siren, nouveau);
      groupes.push(nouveau);
      continue;
    }

    // Pas d'identifiant : on tente le rapprochement par nom + code postal.
    const proche = groupes.find((g) => g.some((x) =>
      x.codePostal && f.codePostal && x.codePostal === f.codePostal &&
      similariteNoms(x.nom, f.nom) >= SEUIL_NOM));
    if (proche) proche.push(f);
    else groupes.push([f]);
  }
  return groupes;
}

/* ===================== Fusion ===================== */

// Qui fait autorité sur quel champ. L'annuaire officiel prime sur l'identité,
// le site de l'entreprise prime sur les contacts (il est à jour), le RGE prime
// sur les qualifications puisqu'il en est la source.
const AUTORITE = {
  nom: ['entreprises', 'rge', 'site'],
  siret: ['entreprises', 'rge'],
  adresse: ['entreprises', 'rge'],
  codePostal: ['entreprises', 'rge'],
  ville: ['entreprises', 'rge'],
  ape: ['entreprises'],
  apeLibelle: ['entreprises'],
  effectif: ['entreprises'],
  dateCreation: ['entreprises'],
  siteWeb: ['site', 'entreprises', 'rge']
};

function meilleurChamp(groupe, champ) {
  for (const source of AUTORITE[champ] || ['entreprises', 'rge', 'site']) {
    const f = groupe.find((x) => (x.source || 'entreprises') === source && x[champ]);
    if (f) return { valeur: f[champ], source };
  }
  const f = groupe.find((x) => x[champ]);
  return f ? { valeur: f[champ], source: f.source || 'entreprises' } : { valeur: '', source: '' };
}

/**
 * Fusionne un groupe en une fiche unique. Chaque champ retenu garde sa
 * provenance : sans ça, impossible de savoir plus tard d'où sort un téléphone
 * erroné, ni quelle source corriger.
 */
function fusionner(groupe) {
  const out = {
    nom: '', siren: '', siret: '', adresse: '', codePostal: '', ville: '', departement: '',
    ape: '', apeLibelle: '', effectif: '', effectifMin: 0, dateCreation: '', active: true,
    siteWeb: '', emails: [], telephones: [],
    rge: false, qualifications: [], qualifPV: false,
    aSimulateur: null, indices: [], sources: [], provenance: {}, score: 0
  };

  for (const champ of Object.keys(AUTORITE)) {
    const { valeur, source } = meilleurChamp(groupe, champ);
    if (valeur) { out[champ] = valeur; out.provenance[champ] = source; }
  }

  out.siren = (groupe.find((f) => f.siren) || {}).siren ||
    (out.siret ? String(out.siret).slice(0, 9) : '');

  // Contacts : union de toutes les sources, jamais un choix — on préfère deux
  // numéros à vérifier qu'un seul, arbitrairement retenu, qui ne répond pas.
  for (const f of groupe) {
    for (const m of f.emails || []) if (!out.emails.includes(m)) out.emails.push(m);
    for (const t of f.telephones || []) if (!out.telephones.includes(t)) out.telephones.push(t);
    for (const q of f.qualifications || []) {
      if (!out.qualifications.some((x) => x.nom === q.nom && x.domaine === q.domaine)) out.qualifications.push(q);
    }
    for (const i of f.indices || []) if (!out.indices.includes(i)) out.indices.push(i);
    const src = f.source || 'entreprises';
    if (!out.sources.includes(src)) out.sources.push(src);
    if (f.rge) out.rge = true;
    if (f.aSimulateur !== null && f.aSimulateur !== undefined) out.aSimulateur = f.aSimulateur;
    if (f.effectifMin) out.effectifMin = Math.max(out.effectifMin, f.effectifMin);
    if (f.active === false) out.active = false;
  }

  out.qualifPV = out.qualifications.some((q) => q.photovoltaique);
  out.departement = out.codePostal ? out.codePostal.slice(0, 2) : '';
  // Le contact issu du site de l'entreprise passe devant : c'est le plus frais.
  const racine = (out.siteWeb || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  if (racine) out.emails.sort((a, b) => (b.endsWith('@' + racine) ? 1 : 0) - (a.endsWith('@' + racine) ? 1 : 0));
  return out;
}

/* ===================== Notation ===================== */

/**
 * Le croisement change la note : une entreprise confirmée par plusieurs sources
 * et qualifiée Quali'PV vaut bien plus qu'une ligne d'annuaire joignable.
 */
function scorerCroise(f) {
  let s = 0;
  const racine = (f.siteWeb || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];

  // Les poids sont calibrés pour qu'un prospect parfait atteigne exactement 100 :
  // au-delà, le plafond écraserait les signaux faibles (nombre de sources,
  // effectif) et deux prospects très différents afficheraient la même note.
  if (f.emails.some((m) => racine && m.endsWith('@' + racine))) s += 28;
  else if (f.emails.length) s += 16;
  if (f.telephones.length) s += 20;
  if (f.siteWeb) s += 7;

  if (f.qualifPV) s += 22;            // installe du photovoltaïque, c'est certifié
  else if (f.rge) s += 7;             // qualifiée, mais sur un autre domaine

  if (f.aSimulateur === false) s += 13;
  else if (f.aSimulateur === true) s -= 12;

  if (f.sources.length >= 3) s += 5;  // recoupée par trois sources
  else if (f.sources.length === 2) s += 3;

  if (f.effectifMin >= 3 && f.effectifMin <= 49) s += 5;
  if (!f.active) s -= 40;

  return Math.max(0, Math.min(100, s));
}

/* ===================== Exports ===================== */

const COLONNES = [
  'score', 'nom', 'siren', 'siret', 'codePostal', 'ville', 'departement', 'effectif',
  'qualifPV', 'qualifications', 'rge', 'siteWeb', 'aSimulateur',
  'email', 'emailsSecondaires', 'telephone', 'telephonesSecondaires',
  'ape', 'sources', 'provenanceContact', 'indices'
];

function versCsv(fiches) {
  const ech = (v) => {
    const t = v === null || v === undefined ? '' : String(v);
    return /[";\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  const lignes = [COLONNES.join(';')];
  for (const f of fiches) {
    lignes.push([
      f.score, f.nom, f.siren, f.siret, f.codePostal, f.ville, f.departement, f.effectif,
      f.qualifPV ? 'oui' : 'non',
      f.qualifications.map((q) => q.nom || q.domaine).filter(Boolean).join(' + '),
      f.rge ? 'oui' : 'non', f.siteWeb,
      f.aSimulateur === null ? 'inconnu' : (f.aSimulateur ? 'oui' : 'non'),
      f.emails[0] || '', f.emails.slice(1).join(' '),
      f.telephones[0] || '', f.telephones.slice(1).join(' '),
      f.ape, f.sources.join('+'), f.provenance.siteWeb || '', f.indices.join(' | ')
    ].map(ech).join(';'));
  }
  return lignes.join('\n');
}

/* ===================== Tableau de bord ===================== */

function versTableauDeBord(fiches, titre) {
  const donnees = JSON.stringify(fiches).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titre} — prospects Hermès</title>
<style>
 :root{--navy:#0f2a43;--ink:#16202b;--ink2:#51606f;--line:#e3e8ee;--bg:#f6f8fa;--ok:#15803d;--accent:#f59e0b}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif}
 header{background:var(--navy);color:#fff;padding:18px 22px}
 header h1{margin:0 0 4px;font-size:20px}
 header p{margin:0;color:#a9c2d8;font-size:14px}
 .barre{position:sticky;top:0;z-index:5;background:#fff;border-bottom:1px solid var(--line);padding:12px 22px;display:flex;gap:14px;flex-wrap:wrap;align-items:center}
 .barre label{font-size:14px;color:var(--ink2);display:flex;gap:6px;align-items:center}
 input[type=search],select{padding:7px 10px;border:1px solid var(--line);border-radius:7px;font:inherit}
 button{padding:8px 14px;border:0;border-radius:7px;background:var(--navy);color:#fff;font:inherit;font-weight:600;cursor:pointer}
 button.sec{background:#fff;color:var(--navy);border:1px solid var(--line)}
 .compte{margin-left:auto;color:var(--ink2);font-size:14px}
 table{border-collapse:collapse;width:100%;background:#fff}
 th,td{padding:9px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
 th{background:#f2f6fa;font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:var(--ink2);cursor:pointer;white-space:nowrap;position:sticky;top:57px}
 tr:hover td{background:#fafcfe}
 .score{font-weight:700;font-size:16px}
 .s-haut{color:var(--ok)}.s-moyen{color:#b45309}.s-bas{color:#8a97a5}
 .puce{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;margin:1px 2px 1px 0;white-space:nowrap}
 .p-pv{background:#eaf7ee;color:#14532d}.p-rge{background:#eef2f6;color:#334}
 .p-sim{background:#fdeaea;color:#b42318}.p-libre{background:#fff5e0;color:#6b4c11}
 .p-src{background:#f2f6fa;color:#51606f}
 a{color:#1e4066}
 td.contact{white-space:nowrap;font-variant-numeric:tabular-nums}
 .vide{padding:40px;text-align:center;color:var(--ink2)}
 @media(max-width:820px){.masq{display:none}}
</style></head><body>
<header>
  <h1>Prospects — ${titre}</h1>
  <p>Croisement annuaire des entreprises × annuaire RGE × sites web. Cliquez un en-tête pour trier.</p>
</header>

<div class="barre">
  <input type="search" id="q" placeholder="Nom, ville, code postal…" style="min-width:210px">
  <label>Score ≥ <select id="fScore"><option value="0">0</option><option value="40">40</option><option value="60" selected>60</option><option value="75">75</option></select></label>
  <label><input type="checkbox" id="fMail"> avec e-mail</label>
  <label><input type="checkbox" id="fTel"> avec téléphone</label>
  <label><input type="checkbox" id="fPV"> Quali'PV</label>
  <label><input type="checkbox" id="fLibre" checked> sans simulateur</label>
  <button class="sec" id="btnCsv">Exporter la sélection</button>
  <span class="compte" id="compte"></span>
</div>

<table id="t">
  <thead><tr>
    <th><input type="checkbox" id="tout"></th>
    <th data-c="score">Score</th>
    <th data-c="nom">Entreprise</th>
    <th data-c="ville" class="masq">Ville</th>
    <th data-c="effectif" class="masq">Effectif</th>
    <th>Qualifications</th>
    <th>Contact</th>
    <th class="masq">Sources</th>
  </tr></thead>
  <tbody id="corps"></tbody>
</table>
<div class="vide" id="vide" hidden>Aucun prospect ne correspond à ces filtres.</div>

<script>
const FICHES = ${donnees};
const $ = (s) => document.querySelector(s);
let tri = { col: 'score', desc: true };
const selection = new Set();

const classeScore = (n) => n >= 70 ? 's-haut' : (n >= 45 ? 's-moyen' : 's-bas');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

function filtrer() {
  const q = $('#q').value.trim().toLowerCase();
  const min = +$('#fScore').value;
  return FICHES.filter((f) => {
    if (f.score < min) return false;
    if ($('#fMail').checked && !f.emails.length) return false;
    if ($('#fTel').checked && !f.telephones.length) return false;
    if ($('#fPV').checked && !f.qualifPV) return false;
    if ($('#fLibre').checked && f.aSimulateur === true) return false;
    if (q) {
      const blob = (f.nom + ' ' + f.ville + ' ' + f.codePostal + ' ' + f.siren).toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => {
    const va = a[tri.col], vb = b[tri.col];
    const c = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb), 'fr');
    return tri.desc ? -c : c;
  });
}

function dessiner() {
  const l = filtrer();
  $('#compte').textContent = l.length + ' / ' + FICHES.length + ' prospects · ' + selection.size + ' sélectionné(s)';
  $('#vide').hidden = l.length > 0;
  $('#corps').innerHTML = l.map((f) => {
    const mail = f.emails[0] || '';
    const tel = f.telephones[0] || '';
    const sujet = encodeURIComponent('Votre simulateur solaire — ' + f.nom);
    return '<tr>' +
      '<td><input type="checkbox" data-siren="' + esc(f.siren) + '"' + (selection.has(f.siren) ? ' checked' : '') + '></td>' +
      '<td class="score ' + classeScore(f.score) + '">' + f.score + '</td>' +
      '<td><b>' + esc(f.nom) + '</b>' + (f.siteWeb ? '<br><a href="' + esc(f.siteWeb) + '" target="_blank" rel="noopener">' + esc(f.siteWeb.replace(/^https?:\\/\\//, '')) + '</a>' : '') + '</td>' +
      '<td class="masq">' + esc(f.ville) + '<br><span style="color:#8a97a5">' + esc(f.codePostal) + '</span></td>' +
      '<td class="masq">' + esc(f.effectif) + '</td>' +
      '<td>' +
        (f.qualifPV ? '<span class="puce p-pv">Quali\\'PV</span>' : (f.rge ? '<span class="puce p-rge">RGE</span>' : '')) +
        (f.aSimulateur === true ? '<span class="puce p-sim">simulateur en place</span>' : '') +
        (f.aSimulateur === false ? '<span class="puce p-libre">pas de simulateur</span>' : '') +
      '</td>' +
      '<td class="contact">' +
        (mail ? '<a href="mailto:' + esc(mail) + '?subject=' + sujet + '">' + esc(mail) + '</a><br>' : '') +
        (tel ? '<a href="tel:' + esc(tel) + '">' + esc(tel) + '</a>' : '') +
        (!mail && !tel ? '<span style="color:#8a97a5">—</span>' : '') +
      '</td>' +
      '<td class="masq">' + f.sources.map((s) => '<span class="puce p-src">' + esc(s) + '</span>').join('') + '</td>' +
    '</tr>';
  }).join('');
}

document.addEventListener('input', (e) => {
  if (e.target.matches('#q,#fScore,#fMail,#fTel,#fPV,#fLibre')) dessiner();
});
document.addEventListener('change', (e) => {
  if (e.target.matches('[data-siren]')) {
    const s = e.target.dataset.siren;
    e.target.checked ? selection.add(s) : selection.delete(s);
    $('#compte').textContent = $('#compte').textContent.replace(/\\d+ sélectionné/, selection.size + ' sélectionné');
  }
  if (e.target.id === 'tout') {
    filtrer().forEach((f) => e.target.checked ? selection.add(f.siren) : selection.delete(f.siren));
    dessiner();
  }
});
document.querySelectorAll('th[data-c]').forEach((th) => th.addEventListener('click', () => {
  const c = th.dataset.c;
  tri = { col: c, desc: tri.col === c ? !tri.desc : true };
  dessiner();
}));
$('#btnCsv').addEventListener('click', () => {
  const l = (selection.size ? FICHES.filter((f) => selection.has(f.siren)) : filtrer());
  const cols = ['score','nom','siren','ville','codePostal','siteWeb','email','telephone','qualifPV'];
  const lignes = [cols.join(';')].concat(l.map((f) => [
    f.score, f.nom, f.siren, f.ville, f.codePostal, f.siteWeb,
    f.emails[0] || '', f.telephones[0] || '', f.qualifPV ? 'oui' : 'non'
  ].map((v) => /[";]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v).join(';')));
  const url = URL.createObjectURL(new Blob(['\\ufeff' + lignes.join('\\n')], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'prospects-selection.csv'; a.click();
  URL.revokeObjectURL(url);
});
dessiner();
</script>
</body></html>`;
}

/* ===================== Orchestration ===================== */

async function run(opts) {
  const departements = opts.departement ? String(opts.departement).split(',') : [null];
  const apes = opts.ape ? String(opts.ape).split(',') : S.APE_PHOTOVOLTAIQUE;
  const pages = Number(opts.pages) || 2;
  const log = (...a) => { if (!process.env.HERMES_SILENCE) console.log(...a); };

  /* --- Source 1 : annuaire officiel --- */
  const brutes = [];
  log('Source 1/2 — annuaire des entreprises');
  for (const dep of departements) {
    for (const ape of apes) {
      for (let p = 1; p <= pages; p++) {
        try {
          const r = await S.chercherEntreprises({ ape, departement: dep, page: p });
          r.entreprises.forEach((e) => { e.source = 'entreprises'; });
          brutes.push(...r.entreprises);
          log(`  APE ${ape}${dep ? ' · dép. ' + dep : ''} p.${p} → ${r.entreprises.length}`);
          if (p >= r.pages) break;
        } catch (e) { log(`  ⚠ ${ape} p.${p} : ${e.message}`); }
      }
    }
  }

  /* --- Source 2 : annuaire RGE --- */
  log('Source 2/2 — annuaire RGE');
  let rge = [];
  try {
    if (opts['rge-csv']) {
      rge = await RGE.depuisCsv(opts['rge-csv']);
      log(`  fichier local → ${rge.length} entreprise(s) qualifiée(s)`);
    } else {
      for (const dep of departements) {
        const r = await RGE.depuisApi({ departement: dep });
        rge.push(...r);
      }
      rge = RGE.regrouper(rge);
      log(`  API ADEME → ${rge.length} entreprise(s) qualifiée(s)`);
    }
  } catch (e) {
    log(`  ⚠ RGE indisponible (${e.message}) — on continue sans. Repli possible : --rge-csv fichier.csv`);
  }

  /* --- Croisement --- */
  const groupes = apparier([...brutes, ...rge]);
  let fiches = groupes.map(fusionner).filter((f) => f.nom && f.active);
  const croisees = fiches.filter((f) => f.sources.length > 1).length;
  log(`\nCroisement : ${groupes.length} entreprise(s) distinctes, dont ${croisees} confirmée(s) par plusieurs sources`);

  /* --- Source 3 : leur site web --- */
  if (!opts['sans-site']) {
    log('Source 3/3 — sites web (contacts à jour + détection de simulateur)');
    let n = 0;
    for (const f of fiches) {
      try {
        const avant = { emails: [...f.emails], telephones: [...f.telephones] };
        await S.enrichir(f);
        if (f.emails.length > avant.emails.length || f.telephones.length > avant.telephones.length) {
          if (!f.sources.includes('site')) f.sources.push('site');
          f.provenance.contact = 'site';
        }
      } catch (e) { f.indices.push('site : ' + e.message); }
      if (++n % 10 === 0) log(`  ${n}/${fiches.length}…`);
    }
  }

  fiches.forEach((f) => { f.score = scorerCroise(f); });
  fiches.sort((a, b) => b.score - a.score);

  /* --- Écriture --- */
  const base = opts.sortie ? String(opts.sortie).replace(/\.(csv|json|html)$/i, '') : 'prospects';
  const dossier = path.dirname(base);
  if (dossier && dossier !== '.') fs.mkdirSync(dossier, { recursive: true });
  const titre = (departements.filter(Boolean).join(', ') || 'France') + ' — ' + new Date().toISOString().slice(0, 10);
  fs.writeFileSync(base + '.csv', '﻿' + versCsv(fiches), 'utf8');
  fs.writeFileSync(base + '.json', JSON.stringify(fiches, null, 2), 'utf8');
  fs.writeFileSync(base + '.html', versTableauDeBord(fiches, titre), 'utf8');

  const joignables = fiches.filter((f) => f.emails.length || f.telephones.length);
  log(`\n✓ ${fiches.length} prospects → ${base}.csv, ${base}.json, ${base}.html`);
  log(`  ${joignables.length} joignables · ${fiches.filter((f) => f.qualifPV).length} Quali'PV · ${fiches.filter((f) => f.aSimulateur === false).length} sans simulateur`);
  log(`  Ouvrez ${base}.html pour trier et sélectionner.`);
  return fiches;
}

/* ===================== Ligne de commande ===================== */

const AIDE = `
Hermès — capture de prospects par croisement de sources

  --departement 69,42     Départements à balayer
  --ape 43.22B,43.21A     Codes APE (défaut : ${S.APE_PHOTOVOLTAIQUE.join(', ')})
  --pages 3               Pages d'annuaire par combinaison (25 par page)
  --rge-csv fichier.csv   Annuaire RGE local, au lieu de l'API ADEME
  --sans-site             Ne visite pas les sites web (plus rapide, moins de contacts)
  --sortie data/lyon      Préfixe des fichiers produits
  --help

Produit un CSV, un JSON et un tableau de bord HTML autonome.
`;

if (require.main === module) {
  const o = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const cle = argv[i].slice(2);
    o[cle] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  if (o.help) { console.log(AIDE); process.exit(0); }
  run(o).catch((e) => { console.error('Échec :', e.message); process.exit(1); });
}

module.exports = {
  normaliserNom, similariteNoms, apparier, fusionner, meilleurChamp,
  scorerCroise, versCsv, versTableauDeBord, run, AUTORITE, SEUIL_NOM
};
