/*!
 * RDF-SOLAR — Moteur de calcul du simulateur photovoltaïque
 * Géométrie (calepinage des panneaux) + estimation de production solaire (France métropolitaine
 * et pays limitrophes francophones) + calculs financiers.
 *
 * Fichier autonome, sans dépendance. Utilisable dans le navigateur (window.RDFSolarEngine)
 * ou sous Node.js (module.exports) pour les tests.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.RDFSolarEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Géométrie plane                                                     */
  /* ------------------------------------------------------------------ */

  // Conversion lat/lng -> mètres locaux (projection équirectangulaire, valable à l'échelle d'un toit)
  function toLocalMeters(latlngs, origin) {
    var lat0 = origin.lat * Math.PI / 180;
    var kx = 111320 * Math.cos(lat0);
    var ky = 110574;
    return latlngs.map(function (p) {
      return {
        x: (p.lng - origin.lng) * kx,
        y: (p.lat - origin.lat) * ky
      };
    });
  }

  function toLatLng(pt, origin) {
    var lat0 = origin.lat * Math.PI / 180;
    var kx = 111320 * Math.cos(lat0);
    var ky = 110574;
    return {
      lat: origin.lat + pt.y / ky,
      lng: origin.lng + pt.x / kx
    };
  }

  function polygonArea(pts) {
    var a = 0;
    for (var i = 0, n = pts.length; i < n; i++) {
      var j = (i + 1) % n;
      a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    return Math.abs(a) / 2;
  }

  function pointInPolygon(pt, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      var intersect = ((yi > pt.y) !== (yj > pt.y)) &&
        (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // Azimut (boussole, 0 = Nord, 90 = Est…) perpendiculaire à l'arête la plus longue du polygone.
  // C'est en général la gouttière du toit : les panneaux "regardent" perpendiculairement à elle.
  // On retourne l'orientation la plus proche du sud parmi les deux perpendiculaires possibles.
  function suggestedAzimuth(ptsMeters) {
    if (!ptsMeters || ptsMeters.length < 2) return 180;
    var best = 0, bestLen = -1;
    for (var i = 0; i < ptsMeters.length; i++) {
      var j = (i + 1) % ptsMeters.length;
      var dx = ptsMeters[j].x - ptsMeters[i].x;
      var dy = ptsMeters[j].y - ptsMeters[i].y;
      var len = dx * dx + dy * dy;
      if (len > bestLen) {
        bestLen = len;
        best = Math.atan2(dx, dy) * 180 / Math.PI; // azimut de l'arête
      }
    }
    var a1 = norm360(best + 90);
    var a2 = norm360(best - 90);
    return (angleFromSouth(a1) <= angleFromSouth(a2)) ? a1 : a2;
  }

  function norm360(a) { return ((a % 360) + 360) % 360; }
  function angleFromSouth(az) {
    var d = Math.abs(norm360(az) - 180);
    return d > 180 ? 360 - d : d;
  }

  /* ------------------------------------------------------------------ */
  /* Calepinage : remplissage du polygone du toit avec des panneaux      */
  /* ------------------------------------------------------------------ */
  /**
   * @param {Object} opts
   *   roof        : [{x,y}]        polygone du toit en mètres locaux
   *   obstacles   : [[{x,y}], …]   zones d'exclusion (cheminées, velux…)
   *   azimuth     : degrés boussole vers lesquels le toit est orienté (180 = sud)
   *   tiltDeg     : inclinaison du toit en degrés (raccourcit la projection au sol)
   *   panelW/H    : dimensions du panneau en mètres (largeur × hauteur, mode portrait)
   *   landscape   : true = panneaux posés en paysage
   *   margin      : marge de sécurité au bord du toit (m)
   *   gap         : espacement entre panneaux (m)
   * @returns [{corners:[{x,y}×4], row, col}]
   */
  function layoutPanels(opts) {
    var roof = opts.roof;
    if (!roof || roof.length < 3) return [];
    var obstacles = opts.obstacles || [];
    var tilt = (opts.tiltDeg || 0) * Math.PI / 180;
    var margin = opts.margin != null ? opts.margin : 0.3;
    var gap = opts.gap != null ? opts.gap : 0.02;

    // Dimensions du panneau vues du ciel : la dimension le long de la pente
    // est raccourcie par cos(inclinaison).
    var across = opts.landscape ? opts.panelH : opts.panelW;       // le long de la gouttière
    var along = (opts.landscape ? opts.panelW : opts.panelH) * Math.cos(tilt); // le long de la pente

    // Repère local du toit : u = le long de la gouttière, v = le long de la pente (vers l'azimut)
    var azRad = (opts.azimuth || 180) * Math.PI / 180;
    var vDir = { x: Math.sin(azRad), y: Math.cos(azRad) };  // direction "vers laquelle regarde" le toit
    var uDir = { x: vDir.y, y: -vDir.x };

    function toUV(p) { return { u: p.x * uDir.x + p.y * uDir.y, v: p.x * vDir.x + p.y * vDir.y }; }
    function fromUV(u, v) {
      return { x: u * uDir.x + v * vDir.x, y: u * uDir.y + v * vDir.y };
    }

    var uv = roof.map(toUV);
    var minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    uv.forEach(function (p) {
      if (p.u < minU) minU = p.u;
      if (p.u > maxU) maxU = p.u;
      if (p.v < minV) minV = p.v;
      if (p.v > maxV) maxV = p.v;
    });
    minU += margin; maxU -= margin; minV += margin; maxV -= margin;

    var panels = [];
    var stepU = across + gap, stepV = along + gap;
    var cols = Math.floor((maxU - minU + gap) / stepU);
    var rows = Math.floor((maxV - minV + gap) / stepV);
    if (cols < 1 || rows < 1) return [];

    // Centrage de la grille dans la boîte englobante
    var offU = minU + ((maxU - minU) - (cols * stepU - gap)) / 2;
    var offV = minV + ((maxV - minV) - (rows * stepV - gap)) / 2;

    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var u0 = offU + c * stepU, v0 = offV + r * stepV;
        var cornersUV = [
          { u: u0, v: v0 },
          { u: u0 + across, v: v0 },
          { u: u0 + across, v: v0 + along },
          { u: u0, v: v0 + along }
        ];
        // Points de contrôle : 4 coins + milieux d'arêtes + centre, tous dans le toit, hors obstacles
        var checks = cornersUV.concat([
          { u: u0 + across / 2, v: v0 },
          { u: u0 + across / 2, v: v0 + along },
          { u: u0, v: v0 + along / 2 },
          { u: u0 + across, v: v0 + along / 2 },
          { u: u0 + across / 2, v: v0 + along / 2 }
        ]);
        var ok = checks.every(function (q) {
          var p = fromUV(q.u, q.v);
          if (!pointInPolygon(p, roof)) return false;
          for (var o = 0; o < obstacles.length; o++) {
            if (obstacles[o].length >= 3 && pointInPolygon(p, obstacles[o])) return false;
          }
          return true;
        });
        if (ok) {
          panels.push({
            corners: cornersUV.map(function (q) { return fromUV(q.u, q.v); }),
            row: r,
            col: c
          });
        }
      }
    }
    return panels;
  }

  /* ------------------------------------------------------------------ */
  /* Harmonisation d'un toit à deux versants                             */
  /* ------------------------------------------------------------------ */
  /**
   * Les emprises de pans issues de détections automatiques (boîtes englobantes
   * Google Solar) présentent souvent de légers décalages : faîtages disjoints,
   * largeurs différentes, orientations pas exactement opposées — d'où des
   * bâtiments « biscornus » en 3D. Or un toit à deux versants est symétrique :
   * cette fonction reconnaît une paire de pans opposés et adjacents, puis
   *   1. aligne les deux pans sur un axe de faîtage commun (orientations
   *      rendues exactement opposées) ;
   *   2. soude le faîtage (arête commune) et unit leurs largeurs ;
   *   3. accorde les pentes pour que les deux versants atteignent la même
   *      hauteur de faîtage (chaque pan garde sa profondeur réelle).
   *
   * @param {Object} a  { poly: [{x,y}] en mètres, azimuth (°), tilt (°) }
   * @param {Object} b  idem
   * @returns { a, b, ridgeRise } harmonisés, ou null si la paire ne forme pas
   *          un toit à deux versants (orientations non opposées, pans éloignés
   *          ou sans recouvrement latéral).
   */
  function harmonizeGablePair(a, b) {
    var diff = norm360(b.azimuth - a.azimuth);
    if (Math.abs(diff - 180) > 25) return null; // pas des versants opposés

    // Axe harmonisé : moyenne des deux orientations (b ramené à l'opposé de a)
    var axis = norm360(a.azimuth + (diff - 180) / 2);
    var rad = axis * Math.PI / 180;
    var vDir = { x: Math.sin(rad), y: Math.cos(rad) };   // vers l'aval du pan a
    var uDir = { x: vDir.y, y: -vDir.x };                // le long du faîtage

    function proj(poly) {
      var u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      poly.forEach(function (p) {
        var u = p.x * uDir.x + p.y * uDir.y;
        var v = p.x * vDir.x + p.y * vDir.y;
        if (u < u0) u0 = u; if (u > u1) u1 = u;
        if (v < v0) v0 = v; if (v > v1) v1 = v;
      });
      return { u0: u0, u1: u1, v0: v0, v1: v1 };
    }
    var A = proj(a.poly), B = proj(b.poly);

    // a descend vers +v : son faîtage est en v0 ; b, opposé, a le sien en v1
    if (Math.abs(A.v0 - B.v1) > 3) return null; // faîtages trop éloignés : pas le même toit
    var overlap = Math.min(A.u1, B.u1) - Math.max(A.u0, B.u0);
    if (overlap < 0.5 * Math.min(A.u1 - A.u0, B.u1 - B.u0)) return null;

    var R = (A.v0 + B.v1) / 2;                    // position du faîtage commun
    var u0 = Math.min(A.u0, B.u0), u1 = Math.max(A.u1, B.u1); // largeur unifiée
    var dA = Math.max(1, A.v1 - R);               // profondeur du versant a
    var dB = Math.max(1, R - B.v0);               // profondeur du versant b

    // Même hauteur de faîtage pour les deux versants (moyenne des élévations)
    var rise = (dA * Math.tan(a.tilt * Math.PI / 180) +
                dB * Math.tan(b.tilt * Math.PI / 180)) / 2;
    function tiltFor(depth) {
      return Math.max(5, Math.min(60, Math.round(Math.atan(rise / depth) * 180 / Math.PI)));
    }
    function rect(vMin, vMax) {
      return [
        { u: u0, v: vMin }, { u: u1, v: vMin },
        { u: u1, v: vMax }, { u: u0, v: vMax }
      ].map(function (q) {
        return { x: q.u * uDir.x + q.v * vDir.x, y: q.u * uDir.y + q.v * vDir.y };
      });
    }
    return {
      a: { poly: rect(R, R + dA), azimuth: norm360(axis), tilt: tiltFor(dA) },
      b: { poly: rect(R - dB, R), azimuth: norm360(axis + 180), tilt: tiltFor(dB) },
      ridgeRise: rise
    };
  }

  /* ------------------------------------------------------------------ */
  /* Gisement solaire                                                    */
  /* ------------------------------------------------------------------ */

  // Irradiation globale horizontale annuelle (kWh/m²/an) — valeurs moyennes long terme
  // (ordres de grandeur PVGIS/Météo-France). Interpolation par distance inverse.
  var GHI_POINTS = [
    { lat: 50.63, lng: 3.06, ghi: 1075 },  // Lille
    { lat: 49.90, lng: 2.30, ghi: 1090 },  // Amiens
    { lat: 49.26, lng: 4.03, ghi: 1115 },  // Reims
    { lat: 49.18, lng: -0.36, ghi: 1120 }, // Caen
    { lat: 48.85, lng: 2.35, ghi: 1150 },  // Paris
    { lat: 48.69, lng: 6.18, ghi: 1145 },  // Nancy
    { lat: 48.57, lng: 7.75, ghi: 1160 },  // Strasbourg
    { lat: 48.39, lng: -4.49, ghi: 1090 }, // Brest
    { lat: 48.11, lng: -1.68, ghi: 1180 }, // Rennes
    { lat: 47.90, lng: 1.90, ghi: 1200 },  // Orléans
    { lat: 47.39, lng: 0.69, ghi: 1230 },  // Tours
    { lat: 47.32, lng: 5.04, ghi: 1250 },  // Dijon
    { lat: 47.24, lng: 6.02, ghi: 1230 },  // Besançon
    { lat: 47.22, lng: -1.55, ghi: 1260 }, // Nantes
    { lat: 46.58, lng: 0.34, ghi: 1270 },  // Poitiers
    { lat: 46.16, lng: -1.15, ghi: 1350 }, // La Rochelle
    { lat: 45.83, lng: 1.26, ghi: 1290 },  // Limoges
    { lat: 45.78, lng: 3.08, ghi: 1300 },  // Clermont-Ferrand
    { lat: 45.76, lng: 4.84, ghi: 1300 },  // Lyon
    { lat: 45.19, lng: 5.72, ghi: 1330 },  // Grenoble
    { lat: 44.93, lng: 4.89, ghi: 1400 },  // Valence
    { lat: 44.84, lng: -0.58, ghi: 1350 }, // Bordeaux
    { lat: 43.60, lng: 1.44, ghi: 1400 },  // Toulouse
    { lat: 43.61, lng: 3.88, ghi: 1560 },  // Montpellier
    { lat: 43.30, lng: 5.37, ghi: 1620 },  // Marseille
    { lat: 43.70, lng: 7.27, ghi: 1580 },  // Nice
    { lat: 43.30, lng: -0.37, ghi: 1350 }, // Pau
    { lat: 42.70, lng: 2.90, ghi: 1610 },  // Perpignan
    { lat: 42.70, lng: 9.45, ghi: 1600 },  // Bastia
    { lat: 41.92, lng: 8.74, ghi: 1660 },  // Ajaccio
    { lat: 50.85, lng: 4.35, ghi: 1020 },  // Bruxelles
    { lat: 49.61, lng: 6.13, ghi: 1120 },  // Luxembourg
    { lat: 46.20, lng: 6.14, ghi: 1280 }   // Genève
  ];

  function ghiAt(lat, lng) {
    var num = 0, den = 0;
    for (var i = 0; i < GHI_POINTS.length; i++) {
      var p = GHI_POINTS[i];
      var d2 = Math.pow((p.lat - lat) * 110.6, 2) + Math.pow((p.lng - lng) * 78, 2); // km²
      if (d2 < 1) return p.ghi;
      var w = 1 / Math.pow(d2, 1.2);
      num += w * p.ghi;
      den += w;
    }
    return den > 0 ? num / den : 1250;
  }

  // Facteur de transposition plan incliné / horizontal, typique des latitudes françaises.
  // Lignes : inclinaison 0/15/30/45/60/90°. Colonnes : écart à l'azimut sud 0/45/90/135/180°.
  var TRANSPOSITION = [
    [1.00, 1.00, 1.00, 1.00, 1.00],
    [1.08, 1.06, 1.00, 0.94, 0.91],
    [1.13, 1.09, 0.98, 0.86, 0.80],
    [1.13, 1.07, 0.93, 0.77, 0.68],
    [1.09, 1.02, 0.87, 0.68, 0.55],
    [0.88, 0.82, 0.68, 0.48, 0.35]
  ];
  var TILT_STEPS = [0, 15, 30, 45, 60, 90];
  var AZ_STEPS = [0, 45, 90, 135, 180];

  function transpositionFactor(tiltDeg, azimuthDeg) {
    var t = Math.max(0, Math.min(90, tiltDeg));
    var a = angleFromSouth(azimuthDeg);
    var ti = 0;
    while (ti < TILT_STEPS.length - 2 && t > TILT_STEPS[ti + 1]) ti++;
    var ai = 0;
    while (ai < AZ_STEPS.length - 2 && a > AZ_STEPS[ai + 1]) ai++;
    var tf = (t - TILT_STEPS[ti]) / (TILT_STEPS[ti + 1] - TILT_STEPS[ti]);
    var af = (a - AZ_STEPS[ai]) / (AZ_STEPS[ai + 1] - AZ_STEPS[ai]);
    var v00 = TRANSPOSITION[ti][ai], v01 = TRANSPOSITION[ti][ai + 1];
    var v10 = TRANSPOSITION[ti + 1][ai], v11 = TRANSPOSITION[ti + 1][ai + 1];
    return (v00 * (1 - tf) + v10 * tf) * (1 - af) + (v01 * (1 - tf) + v11 * tf) * af;
  }

  // Répartition mensuelle de la production (profil moyen France, normalisé à 1)
  var MONTHLY_PROFILE = [0.037, 0.052, 0.082, 0.104, 0.116, 0.121, 0.124, 0.113, 0.094, 0.066, 0.046, 0.035];

  function monthlyProduction(annualKwh) {
    var sum = MONTHLY_PROFILE.reduce(function (a, b) { return a + b; }, 0);
    return MONTHLY_PROFILE.map(function (m) { return annualKwh * m / sum; });
  }

  /**
   * Production annuelle estimée.
   * @param {Object} o { kwc, lat, lng, tiltDeg, azimuthDeg, performanceRatio }
   * @returns {Object} { annualKwh, monthly, ghi, factor, specificYield }
   */
  function estimateProduction(o) {
    var ghi = o.ghi != null ? o.ghi : ghiAt(o.lat, o.lng);
    var factor = transpositionFactor(o.tiltDeg, o.azimuthDeg);
    var pr = o.performanceRatio != null ? o.performanceRatio : 0.80;
    var annual = o.kwc * ghi * factor * pr;
    return {
      annualKwh: annual,
      monthly: monthlyProduction(annual),
      ghi: ghi,
      factor: factor,
      specificYield: o.kwc > 0 ? annual / o.kwc : 0
    };
  }

  /* ------------------------------------------------------------------ */
  /* Autoconsommation & finances                                         */
  /* ------------------------------------------------------------------ */

  // Taux d'autoconsommation estimé (sans pilotage) selon le ratio production/consommation.
  // Courbe empirique : plus on produit par rapport à ce qu'on consomme, plus la part
  // autoconsommée diminue. Une batterie remonte ce taux.
  function selfConsumptionRate(productionKwh, consumptionKwh, batteryKwh) {
    if (productionKwh <= 0 || consumptionKwh <= 0) return 0;
    var x = productionKwh / consumptionKwh;
    var base = 0.20 + 0.62 * Math.exp(-0.9 * x);
    if (batteryKwh > 0) {
      var dailyProd = productionKwh / 365;
      var boost = Math.min(0.35, 0.28 * batteryKwh / Math.max(dailyProd, 1));
      base += boost;
    }
    return Math.min(0.95, base);
  }

  // Prime à l'autoconsommation (€/kWc) par tranche de puissance — valeurs configurables.
  function autoconsumptionBonus(kwc, tiers) {
    tiers = tiers || [
      { maxKwc: 3, eurPerKwc: 80 },
      { maxKwc: 9, eurPerKwc: 80 },
      { maxKwc: 36, eurPerKwc: 180 },
      { maxKwc: 100, eurPerKwc: 90 }
    ];
    for (var i = 0; i < tiers.length; i++) {
      if (kwc <= tiers[i].maxKwc) return kwc * tiers[i].eurPerKwc;
    }
    return 0;
  }

  /**
   * Bilan financier annuel + retour sur investissement.
   * @param {Object} o
   *   productionKwh, consumptionKwh, batteryKwh,
   *   gridPrice (€/kWh acheté), feedInTariff (€/kWh surplus vendu),
   *   installCost (€ TTC), bonusTiers, kwc
   */
  function financials(o) {
    var rate = selfConsumptionRate(o.productionKwh, o.consumptionKwh, o.batteryKwh || 0);
    var selfKwh = Math.min(o.productionKwh * rate, o.consumptionKwh);
    var surplus = Math.max(0, o.productionKwh - selfKwh);
    var savings = selfKwh * o.gridPrice + surplus * o.feedInTariff;
    var bonus = autoconsumptionBonus(o.kwc, o.bonusTiers);
    var netCost = Math.max(0, o.installCost - bonus);
    return {
      selfConsumptionRate: rate,
      selfConsumedKwh: selfKwh,
      surplusKwh: surplus,
      annualSavings: savings,
      bonus: bonus,
      netCost: netCost,
      paybackYears: savings > 0 ? netCost / savings : Infinity,
      co2SavedKg: o.productionKwh * 0.055 // vs mix électrique FR (~55 g CO2/kWh)
    };
  }

  return {
    toLocalMeters: toLocalMeters,
    toLatLng: toLatLng,
    polygonArea: polygonArea,
    pointInPolygon: pointInPolygon,
    suggestedAzimuth: suggestedAzimuth,
    angleFromSouth: angleFromSouth,
    norm360: norm360,
    layoutPanels: layoutPanels,
    harmonizeGablePair: harmonizeGablePair,
    ghiAt: ghiAt,
    transpositionFactor: transpositionFactor,
    monthlyProduction: monthlyProduction,
    estimateProduction: estimateProduction,
    selfConsumptionRate: selfConsumptionRate,
    autoconsumptionBonus: autoconsumptionBonus,
    financials: financials
  };
});
