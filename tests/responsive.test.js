/**
 * Discipline responsive de la page de vente — node tests/responsive.test.js
 *
 * Ces contrôles ne remplacent pas un œil sur un vrai téléphone : ils gardent
 * les deux fautes qui ont réellement cassé le site, et que rien ne signalait.
 *
 * 1. **Une règle ajoutée à la fin de la feuille.** `src/evasimu-vente.css` est
 *    écrite mobile d'abord : le mobile est la base, les `@media (min-width)`
 *    enrichissent. Une déclaration posée APRÈS le dernier palier s'applique à
 *    toutes les tailles et écrase silencieusement le mobile. C'est comme ça
 *    que le hero s'est retrouvé sur deux colonnes à 390 px, avec des boutons
 *    à 240 px et une illustration réduite à une vignette — sans qu'aucun test
 *    ne bronche, parce que la page ne débordait pas pour autant.
 *
 * 2. **Une page sans navigation mobile.** Sous 1024 px, les liens de la barre
 *    et son bouton sont masqués : une page qui n'a pas le hamburger, son
 *    panneau et la barre d'action du bas ne laisse au visiteur qu'un logo.
 *    Six pages étaient dans ce cas.
 *
 * Ils tournent sans navigateur et sans dépendance, comme le reste de la suite.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(nom, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + nom); }
  else { failed++; console.error('  ✗ ' + nom + (detail ? ' — ' + detail : '')); }
}

const RACINE = path.join(__dirname, '..');
const lire = (f) => fs.readFileSync(path.join(RACINE, f), 'utf8');

/* ===================== La feuille de styles ===================== */

console.log('Feuille de styles : mobile d’abord');
{
  const css = lire('src/evasimu-vente.css');

  // Une media query `max-width` est le signe d'une feuille desktop-first :
  // on part du grand écran et on répare le petit. Ici, c'est l'inverse.
  const maxWidth = (css.match(/@media\s*\(\s*max-width/g) || []).length;
  check('aucune media query « max-width »', maxWidth === 0,
    maxWidth + ' trouvée(s) — la feuille repartirait du desktop');

  // Les paliers doivent être ceux du cahier des charges, et dans l'ordre.
  const paliers = (css.match(/@media\s*\(\s*min-width:\s*(\d+)px/g) || [])
    .map((m) => parseInt(m.match(/(\d+)px/)[1], 10));
  check('les paliers sont 640, 1024 et 1440', paliers.join(',') === '640,1024,1440',
    paliers.join(',') || 'aucun');

  // Le contrôle central : rien ne doit suivre le dernier palier.
  const dernier = css.lastIndexOf('@media (min-width: 1440px)');
  check('le dernier palier existe', dernier !== -1);
  if (dernier !== -1) {
    // On repart de la fin du bloc : accolade fermante de la media query.
    let profondeur = 0, fin = -1;
    for (let i = css.indexOf('{', dernier); i < css.length; i++) {
      if (css[i] === '{') profondeur++;
      else if (css[i] === '}') { profondeur--; if (profondeur === 0) { fin = i; break; } }
    }
    const apres = css.slice(fin + 1).replace(/\/\*[\s\S]*?\*\//g, '').trim();
    check('rien n’est écrit après le dernier palier', apres === '',
      'une règle placée là écraserait le mobile : ' + apres.slice(0, 90));
  }

  // Les cibles tactiles et la taille de police des champs sont les deux
  // réglages qu'on rogne « pour gagner de la place », et qu'il ne faut pas.
  check('les boutons ont une hauteur de cible tactile', /\.btn\s*\{[^}]*min-height:\s*48px/.test(css),
    'sous 48 px, on vise à côté avec un gant');
  check('les champs restent à 16 px', /\.input\s*\{[^}]*font-size:\s*16px/.test(css),
    'sous 16 px, iOS zoome tout seul et décale la page');
  check('le fond de page est réservé pour la barre d’action',
    /body\s*\{[^}]*padding-bottom:\s*calc\(var\(--h-mobar\)/.test(css),
    'sinon la barre fixe recouvre la dernière ligne de chaque page');
}

/* ===================== Les pages ===================== */

// Pages de vente et pages documentaires : toutes portent la même barre.
// `demo.html` a son propre habillage, `404.html` est servie à n'importe quelle
// profondeur d'URL et n'a volontairement ni barre ni menu.
const PAGES = fs.readdirSync(RACINE)
  .filter((f) => f.endsWith('.html'))
  .filter((f) => f !== 'demo.html' && f !== '404.html');

console.log('Pages : navigation mobile');
check('des pages sont trouvées', PAGES.length >= 8, PAGES.length + ' page(s)');

for (const f of PAGES) {
  const html = lire(f);
  const manque = [];
  if (!/id="nav-burger"/.test(html)) manque.push('hamburger');
  if (!/id="nav-panel"/.test(html)) manque.push('panneau de menu');
  if (!/id="mobar"/.test(html)) manque.push('barre d’action');
  if (!/id="i-menu"/.test(html)) manque.push('icône menu');
  if (!/id="i-close"/.test(html)) manque.push('icône fermeture');
  check(f + ' : navigation mobile complète', manque.length === 0, manque.join(', '));

  check(f + ' : viewport déclaré',
    /<meta name="viewport" content="width=device-width, initial-scale=1\.0">/.test(html));
  check(f + ' : feuille et script chargés',
    /src\/evasimu-vente\.css/.test(html) && /src\/evasimu-vente\.js/.test(html));
}

// Le sommaire des pages documentaires défile horizontalement en mobile : il
// lui faut son conteneur, sinon vingt liens empilés poussent le texte hors
// de l'écran avant le premier paragraphe.
console.log('Pages documentaires : sommaire défilant');
for (const f of PAGES) {
  const html = lire(f);
  if (!/class="doc-som"/.test(html)) continue;
  check(f + ' : le sommaire a son conteneur défilant', /class="doc-som-liste"/.test(html));
}

console.log('');
console.log(passed + ' tests réussis, ' + failed + ' échec(s)');
process.exit(failed ? 1 : 0);
