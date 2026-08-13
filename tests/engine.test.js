/**
 * Tests du moteur de calcul RDF-SOLAR — exécution : node tests/engine.test.js
 */
'use strict';

const E = require('../src/rdf-solar-engine.js');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

console.log('Géométrie');
{
  const origin = { lat: 45.76, lng: 4.84 };
  // Carré de ~10 m × 10 m autour de l'origine
  const d = 10 / 110574;
  const dlng = 10 / (111320 * Math.cos(origin.lat * Math.PI / 180));
  const square = [
    { lat: origin.lat, lng: origin.lng },
    { lat: origin.lat + d, lng: origin.lng },
    { lat: origin.lat + d, lng: origin.lng + dlng },
    { lat: origin.lat, lng: origin.lng + dlng }
  ];
  const m = E.toLocalMeters(square, origin);
  check('conversion lat/lng → mètres (carré 10 m)', near(E.polygonArea(m), 100, 0.5), 'aire=' + E.polygonArea(m).toFixed(2));

  const back = E.toLatLng(m[2], origin);
  check('aller-retour toLatLng', near(back.lat, square[2].lat, 1e-9) && near(back.lng, square[2].lng, 1e-9));

  check('pointInPolygon centre', E.pointInPolygon({ x: 5, y: 5 }, m));
  check('pointInPolygon extérieur', !E.pointInPolygon({ x: 15, y: 5 }, m));

  // Calepinage : carré 10×10 m, panneau 1,134 × 1,722 m portrait, toit plat
  const panels = E.layoutPanels({
    roof: m, obstacles: [], azimuth: 180, tiltDeg: 0,
    panelW: 1.134, panelH: 1.722, landscape: false, margin: 0.3, gap: 0.02
  });
  // Attendu : 8 colonnes (10-0.6)/1.154 ≈ 8, 5 rangées (9.4/1.742 ≈ 5) → 40 panneaux
  check('calepinage carré 10×10 → ~40 panneaux', panels.length >= 35 && panels.length <= 42, 'obtenu=' + panels.length);

  // Une inclinaison à 30° raccourcit la projection le long de la pente → au moins autant de panneaux
  const tilted = E.layoutPanels({
    roof: m, obstacles: [], azimuth: 180, tiltDeg: 30,
    panelW: 1.134, panelH: 1.722, landscape: false, margin: 0.3, gap: 0.02
  });
  check('inclinaison 30° → au moins autant de rangées', tilted.length >= panels.length, tilted.length + ' vs ' + panels.length);

  // Obstacle au centre → moins de panneaux
  const withObstacle = E.layoutPanels({
    roof: m, obstacles: [[{ x: 4, y: 4 }, { x: 6, y: 4 }, { x: 6, y: 6 }, { x: 4, y: 6 }]],
    azimuth: 180, tiltDeg: 0, panelW: 1.134, panelH: 1.722, landscape: false, margin: 0.3, gap: 0.02
  });
  check('obstacle central → moins de panneaux', withObstacle.length < panels.length, withObstacle.length + ' vs ' + panels.length);

  // Tous les panneaux dans le toit
  const allInside = panels.every(p => p.corners.every(c => E.pointInPolygon(c, [
    { x: -0.01, y: -0.01 }, { x: 10.01, y: -0.01 }, { x: 10.01, y: 10.01 }, { x: -0.01, y: 10.01 }
  ])));
  check('tous les coins de panneaux dans le toit', allInside);

  // Azimut suggéré : rectangle allongé est-ouest → panneaux orientés sud (~180°)
  const rect = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 5 }, { x: 0, y: 5 }];
  const az = E.suggestedAzimuth(rect);
  check('azimut suggéré ≈ sud pour gouttière est-ouest', near(az, 180, 1), 'az=' + az);
}

console.log('Délimitation « ma maison » (habitat mitoyen)');
{
  // Rangée de 4 maisons accolées : 40 m × 8 m, comme une emprise BD TOPO de lotissement
  const rangee = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 8 }, { x: 0, y: 8 }];
  const opts = {
    roof: rangee, obstacles: [], azimuth: 180, tiltDeg: 30,
    panelW: 1.134, panelH: 1.722, landscape: false, margin: 0.3, gap: 0.02
  };
  const toutLeBloc = E.layoutPanels(opts);
  check('sans délimitation, le calepinage couvre toute la rangée', toutLeBloc.length > 100,
    toutLeBloc.length + ' panneaux');

  // Ma maison : la 2e tranche, de x=10 à x=20
  const maMaison = [{ x: 10, y: -1 }, { x: 20, y: -1 }, { x: 20, y: 9 }, { x: 10, y: 9 }];
  const chezMoi = E.layoutPanels(Object.assign({}, opts, { limit: maMaison }));
  check('avec délimitation, beaucoup moins de panneaux', chezMoi.length < toutLeBloc.length / 3,
    chezMoi.length + ' vs ' + toutLeBloc.length);
  check('aucun panneau ne déborde chez les voisins',
    chezMoi.every((p) => p.corners.every((c) => c.x >= 10 - 1e-9 && c.x <= 20 + 1e-9)),
    'x min=' + Math.min(...chezMoi.flatMap((p) => p.corners.map((c) => c.x))).toFixed(2));
  check('la maison délimitée reste équipée', chezMoi.length > 15, chezMoi.length + ' panneaux');

  // Une limite qui ne recouvre pas le toit ne laisse rien
  const ailleurs = [{ x: 100, y: 100 }, { x: 110, y: 100 }, { x: 110, y: 110 }, { x: 100, y: 110 }];
  check('limite hors du toit → aucun panneau', E.layoutPanels(Object.assign({}, opts, { limit: ailleurs })).length === 0);
  check('limite dégénérée ignorée',
    E.layoutPanels(Object.assign({}, opts, { limit: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })).length === toutLeBloc.length);

  // Maison en L (limite concave) : l'échantillonnage doit rester exact
  const carre = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  check('surface sans limite = surface du polygone', near(E.polygonAreaWithin(carre, null), 100, 1e-9));
  const moitie = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 10 }, { x: 0, y: 10 }];
  check('surface limitée à la moitié ≈ 50 m²', near(E.polygonAreaWithin(carre, moitie), 50, 1),
    E.polygonAreaWithin(carre, moitie).toFixed(2));
  const enL = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 10 }, { x: 0, y: 10 }];
  check('limite concave (maison en L) ≈ 75 m²', near(E.polygonAreaWithin(carre, enL), 75, 1),
    E.polygonAreaWithin(carre, enL).toFixed(2));
  check('limite disjointe → surface nulle', near(E.polygonAreaWithin(carre, ailleurs), 0, 0.01));

  // Une limite concave doit aussi contraindre le calepinage correctement
  const grandToit = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }];
  const limiteL = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 8 }, { x: 8, y: 8 }, { x: 8, y: 20 }, { x: 0, y: 20 }];
  const enForme = E.layoutPanels(Object.assign({}, opts, { roof: grandToit, limit: limiteL }));
  check('aucun panneau dans l’angle exclu par une limite concave',
    enForme.every((p) => p.corners.every((c) => !(c.x > 8.01 && c.y > 8.01))),
    enForme.length + ' panneaux posés');
}

console.log('Harmonisation toit à deux versants');
{
  // Deux versants opposés, légèrement décalés (comme des boîtes Google) :
  // pan sud : faîtage à y=10,05, gouttière à y=4 ; pan nord : faîtage à y=9,7, gouttière à y=16,2
  const south = { poly: [{ x: 0, y: 4 }, { x: 12, y: 4 }, { x: 12, y: 10.05 }, { x: 0, y: 10.05 }], azimuth: 177, tilt: 22 };
  const north = { poly: [{ x: 0.8, y: 9.7 }, { x: 12.6, y: 9.7 }, { x: 12.6, y: 16.2 }, { x: 0.8, y: 16.2 }], azimuth: 359, tilt: 17 };
  const h = E.harmonizeGablePair(south, north);
  check('paire de versants reconnue', !!h);
  if (h) {
    check('orientations rendues exactement opposées', near(E.norm360(h.b.azimuth - h.a.azimuth), 180, 1e-6),
      h.a.azimuth + ' / ' + h.b.azimuth);
    // Faîtage soudé : l'arête haute du pan a et l'arête basse du pan b coïncident
    const rad = h.a.azimuth * Math.PI / 180;
    const vd = { x: Math.sin(rad), y: Math.cos(rad) };
    const vOf = (p) => p.x * vd.x + p.y * vd.y;
    const aRidge = Math.min(...h.a.poly.map(vOf));
    const bRidge = Math.max(...h.b.poly.map(vOf));
    check('faîtage commun soudé', near(aRidge, bRidge, 0.01), aRidge.toFixed(2) + ' vs ' + bRidge.toFixed(2));
    // Largeurs unifiées le long du faîtage
    const ud = { x: vd.y, y: -vd.x };
    const uOf = (p) => p.x * ud.x + p.y * ud.y;
    const widthA = Math.max(...h.a.poly.map(uOf)) - Math.min(...h.a.poly.map(uOf));
    const widthB = Math.max(...h.b.poly.map(uOf)) - Math.min(...h.b.poly.map(uOf));
    check('largeurs unifiées', near(widthA, widthB, 0.01), widthA.toFixed(2) + ' vs ' + widthB.toFixed(2));
    // Même hauteur de faîtage : profondeur × tan(pente) égale des deux côtés (± arrondi des pentes)
    const depth = (z) => Math.max(...z.poly.map(vOf)) - Math.min(...z.poly.map(vOf));
    const riseA = depth(h.a) * Math.tan(h.a.tilt * Math.PI / 180);
    const riseB = depth(h.b) * Math.tan(h.b.tilt * Math.PI / 180);
    check('hauteurs de faîtage accordées (± arrondi)', Math.abs(riseA - riseB) < 0.30, riseA.toFixed(2) + ' vs ' + riseB.toFixed(2));
  }
  // Orientations non opposées → refus
  check('pans perpendiculaires : refus', E.harmonizeGablePair(
    { poly: south.poly, azimuth: 180, tilt: 20 },
    { poly: north.poly, azimuth: 90, tilt: 20 }) === null);
  // Faîtages trop éloignés → refus
  check('pans éloignés : refus', E.harmonizeGablePair(south, {
    poly: north.poly.map(p => ({ x: p.x, y: p.y + 8 })), azimuth: 359, tilt: 17
  }) === null);
  // Pas de recouvrement latéral → refus
  check('pans côte à côte sans recouvrement : refus', E.harmonizeGablePair(south, {
    poly: north.poly.map(p => ({ x: p.x + 14, y: p.y })), azimuth: 359, tilt: 17
  }) === null);
}

console.log('Gisement solaire');
{
  const marseille = E.ghiAt(43.30, 5.37);
  const lille = E.ghiAt(50.63, 3.06);
  check('GHI Marseille > GHI Lille', marseille > lille, marseille + ' vs ' + lille);
  check('GHI Marseille ≈ 1620', near(marseille, 1620, 5));
  const between = E.ghiAt(47.0, 3.0); // centre France
  check('interpolation centre France plausible (1150–1350)', between > 1150 && between < 1350, 'ghi=' + between.toFixed(0));

  check('facteur sud 30° ≈ 1,13', near(E.transpositionFactor(30, 180), 1.13, 0.01));
  check('facteur horizontal = 1', near(E.transpositionFactor(0, 90), 1.0, 0.001));
  check('facteur nord < facteur sud', E.transpositionFactor(30, 0) < E.transpositionFactor(30, 180));
  check('facteur est ≈ ouest (symétrie)', near(E.transpositionFactor(35, 90), E.transpositionFactor(35, 270), 1e-9));

  const prod = E.estimateProduction({ kwc: 6, lat: 45.76, lng: 4.84, tiltDeg: 30, azimuthDeg: 180, performanceRatio: 0.82 });
  // Lyon, 6 kWc plein sud 30° : attendu ~6 800–7 400 kWh/an
  check('production Lyon 6 kWc plausible', prod.annualKwh > 6500 && prod.annualKwh < 7600, Math.round(prod.annualKwh) + ' kWh');
  check('rendement spécifique plausible (1000–1300 kWh/kWc)', prod.specificYield > 1000 && prod.specificYield < 1300, Math.round(prod.specificYield));
  const sumMonthly = prod.monthly.reduce((a, b) => a + b, 0);
  check('somme des mois = annuel', near(sumMonthly, prod.annualKwh, 1));
  check('juillet > décembre', prod.monthly[6] > prod.monthly[11] * 2);
}

console.log('Passerelle PVGIS');
{
  // aspect PVGIS : 0 = sud, −90 = est, +90 = ouest
  check('sud → aspect 0', E.pvgisAspect(180) === 0);
  check('est → aspect −90', E.pvgisAspect(90) === -90);
  check('ouest → aspect +90', E.pvgisAspect(270) === 90);
  check('nord → aspect ±180', Math.abs(E.pvgisAspect(0)) === 180, String(E.pvgisAspect(0)));
  check('sud-ouest → aspect +45', E.pvgisAspect(225) === 45);
  check('aspect toujours dans [−180, 180]', [0, 45, 90, 179, 180, 181, 270, 359, 720]
    .every((a) => E.pvgisAspect(a) >= -180 && E.pvgisAspect(a) <= 180));

  // pertes système : PVGIS modélise déjà température et effets optiques
  check('PR 0,80 → 14 % de pertes système (défaut PVGIS)', E.pvgisLoss(0.80) === 14, String(E.pvgisLoss(0.80)));
  check('micro-onduleurs (PR 0,82) → moins de pertes', E.pvgisLoss(0.82) < E.pvgisLoss(0.78));
  check('pertes bornées', E.pvgisLoss(0.99) >= 5 && E.pvgisLoss(0.30) <= 25,
    E.pvgisLoss(0.99) + ' / ' + E.pvgisLoss(0.30));
  check('PR absent → valeur par défaut', E.pvgisLoss() === 14);

  // profil mensuel fourni par PVGIS
  const profilPvgis = [30, 45, 80, 105, 120, 128, 132, 118, 92, 60, 35, 27];
  const mois = E.monthlyFromProfile(10000, profilPvgis);
  check('somme du profil = production annuelle', near(mois.reduce((a, b) => a + b, 0), 10000, 1e-6));
  check('le profil PVGIS est respecté', mois[6] > mois[0] * 4, mois[6].toFixed(0) + ' vs ' + mois[0].toFixed(0));
  check('profil absent → profil national', near(
    E.monthlyFromProfile(10000, null).reduce((a, b) => a + b, 0), 10000, 1e-6));
  check('profil incomplet → profil national',
    E.monthlyFromProfile(10000, [1, 2, 3]).length === 12);
  check('profil à somme nulle → profil national',
    E.monthlyFromProfile(10000, new Array(12).fill(0)).every((v) => v > 0));
}

console.log('Finances');
{
  const rateSmall = E.selfConsumptionRate(2000, 5000, 0);   // petite installation
  const rateBig = E.selfConsumptionRate(10000, 5000, 0);    // surdimensionnée
  check('autoconsommation décroît quand la production augmente', rateSmall > rateBig, rateSmall.toFixed(2) + ' vs ' + rateBig.toFixed(2));
  check('taux dans [0,2, 0,95]', rateSmall <= 0.95 && rateBig >= 0.2);
  const rateBatt = E.selfConsumptionRate(5000, 5000, 5);
  check('batterie améliore l’autoconsommation', rateBatt > E.selfConsumptionRate(5000, 5000, 0));

  const fin = E.financials({
    productionKwh: 7000, consumptionKwh: 5000, batteryKwh: 0,
    gridPrice: 0.2016, feedInTariff: 0.04, installCost: 12000,
    bonusTiers: [{ maxKwc: 9, eurPerKwc: 80 }, { maxKwc: 36, eurPerKwc: 180 }], kwc: 6
  });
  check('prime 6 kWc = 480 €', near(fin.bonus, 480, 0.01));
  check('économies annuelles > 0', fin.annualSavings > 400, Math.round(fin.annualSavings));
  check('retour sur investissement fini et plausible (5–25 ans)', fin.paybackYears > 5 && fin.paybackYears < 25, fin.paybackYears.toFixed(1));
  check('bilan énergie cohérent', near(fin.selfConsumedKwh + fin.surplusKwh, 7000, 1));

  const finZero = E.financials({ productionKwh: 0, consumptionKwh: 5000, gridPrice: 0.2, feedInTariff: 0.04, installCost: 0, kwc: 0 });
  check('production nulle → pas d’économies', finZero.annualSavings === 0 && finZero.paybackYears === Infinity);

  // Réforme du 4 juin 2026 : plus de prime par défaut
  check('prime supprimée par défaut (arrêté du 4 juin 2026)', E.autoconsumptionBonus(6) === 0);
  check('prime rétablie si un barème est fourni', E.autoconsumptionBonus(6, [{ maxKwc: 9, eurPerKwc: 80 }]) === 480);

  // Décomposition des économies : l'autoconsommation doit écraser le surplus
  const finPost = E.financials({
    productionKwh: 7000, consumptionKwh: 5000, batteryKwh: 0,
    gridPrice: 0.2001, feedInTariff: 0.011, installCost: 12000, kwc: 6
  });
  check('économies = autoconsommation + surplus',
    near(finPost.savingsSelf + finPost.savingsSurplus, finPost.annualSavings, 1e-9));
  check('le surplus ne pèse presque plus rien (< 15 % des gains)',
    finPost.savingsSurplus < 0.15 * finPost.annualSavings,
    Math.round(finPost.savingsSurplus) + ' € vs ' + Math.round(finPost.annualSavings) + ' €');
  check('retour cumulé plus favorable que le retour simple (inflation du kWh)',
    finPost.paybackYears < finPost.simplePaybackYears,
    finPost.paybackYears.toFixed(1) + ' vs ' + finPost.simplePaybackYears.toFixed(1));

  // Le pilotage (EMS) remonte le taux d'autoconsommation
  const finEms = E.financials({
    productionKwh: 7000, consumptionKwh: 5000, batteryKwh: 0, selfConsumptionBoost: 0.10,
    gridPrice: 0.2001, feedInTariff: 0.011, installCost: 12000, kwc: 6
  });
  check('le pilotage améliore l’autoconsommation et les économies',
    finEms.selfConsumptionRate > finPost.selfConsumptionRate && finEms.annualSavings > finPost.annualSavings);
}

console.log('TVA (taux réduit 5,5 % — conditions cumulatives)');
{
  const complet = { kwc: 6, residentiel: true, rge: true, modulesConformes: true, ems: true };
  const ok = E.vatEligibility(complet);
  check('5 conditions réunies → 5,5 %', ok.eligible && near(ok.rate, 0.055, 1e-9));
  check('les 5 conditions sont listées', ok.conditions.length === 5);

  ['residentiel', 'rge', 'modulesConformes', 'ems'].forEach((k) => {
    const ko = E.vatEligibility(Object.assign({}, complet, { [k]: false }));
    check('sans « ' + k +' » → 20 %', !ko.eligible && near(ko.rate, 0.20, 1e-9));
  });

  const trop = E.vatEligibility(Object.assign({}, complet, { kwc: 9.5 }));
  check('au-delà de 9 kWc → 20 %', !trop.eligible && trop.manquantes[0].id === 'puissance');
  check('exactement 9 kWc → 5,5 %', E.vatEligibility(Object.assign({}, complet, { kwc: 9 })).eligible);
  check('seuil configurable', E.vatEligibility(Object.assign({}, complet, { kwc: 12, taux: { seuilKwc: 20 } })).eligible);

  const b = E.vatBreakdown(10000, 0.055);
  check('décomposition HT/TVA/TTC', near(b.vat, 550, 1e-9) && near(b.ttc, 10550, 1e-9));
  const ecart = E.vatBreakdown(10000, 0.20).ttc - b.ttc;
  check('écart 20 % / 5,5 % sur 10 000 € HT = 1 450 €', near(ecart, 1450, 1e-9), ecart.toFixed(2));
}

console.log('Projection pluriannuelle');
{
  const p = E.projection({
    years: 25, selfKwh: 2600, surplusKwh: 4400, gridPrice: 0.2001, feedInTariff: 0.011,
    investment: 12000
  });
  check('25 lignes de trajectoire', p.rows.length === 25);
  check('la production décroît (dégradation des modules)', p.rows[24].production < p.rows[0].production);
  check('les gains croissent malgré la dégradation (inflation du kWh)', p.rows[24].gain > p.rows[0].gain);
  check('retour sur investissement atteint avant 25 ans', isFinite(p.paybackYears) && p.paybackYears < 25, p.paybackYears.toFixed(1));
  check('gain net cumulé positif à 25 ans', p.cumulNet > 0, Math.round(p.cumulNet) + ' €');

  const jamais = E.projection({ years: 25, selfKwh: 10, surplusKwh: 0, gridPrice: 0.2, feedInTariff: 0.011, investment: 20000 });
  check('investissement jamais amorti → Infinity', jamais.paybackYears === Infinity);

  const avecRempl = E.projection({
    years: 25, selfKwh: 2600, surplusKwh: 4400, gridPrice: 0.2001, feedInTariff: 0.011,
    investment: 12000, inverterReplacement: { annee: 15, cout: 1500 }
  });
  check('le remplacement d’onduleur ampute le gain', avecRempl.cumulNet < p.cumulNet - 1400);
}

console.log('\n' + passed + ' tests réussis, ' + failed + ' échec(s)');
process.exit(failed ? 1 : 0);
