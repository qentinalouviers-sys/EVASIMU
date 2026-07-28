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
}

console.log('\n' + passed + ' tests réussis, ' + failed + ' échec(s)');
process.exit(failed ? 1 : 0);
