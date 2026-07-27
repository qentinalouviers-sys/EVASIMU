/*!
 * RDF-SOLAR — Simulateur d'installation photovoltaïque
 * Widget intégrable : recherche d'adresse → vue satellite haute résolution (IGN) →
 * dessin du toit → calepinage réaliste des panneaux → choix des offres/composants →
 * estimation de production, d'économies et demande de devis.
 *
 * Dépendances : Leaflet (chargé par la page hôte) + rdf-solar-engine.js
 * Intégration :
 *   <div id="rdf-solar-sim"></div>
 *   <script> RDFSolarSim.mount('#rdf-solar-sim', { offersUrl: 'config/offers.json' }); </script>
 */
(function (root) {
  'use strict';

  var E = root.RDFSolarEngine;

  /* ================= Configuration par défaut ================= */
  var DEFAULTS = {
    offersUrl: null,          // URL du catalogue JSON (sinon catalogue embarqué minimal)
    center: [46.6, 2.4],      // France
    zoom: 6,
    maxZoom: 22,
    margin: 0.30,             // marge au bord du toit (m)
    gap: 0.02,                // espacement entre panneaux (m)
    pvgisProxyUrl: null       // optionnel : proxy serveur vers PVGIS pour affiner la production
  };

  // Catalogue de secours si offers.json est inaccessible (ouverture en file://, etc.)
  var FALLBACK_CATALOG = {
    brand: { name: 'RDF-SOLAR', contactEmail: 'contact@rdf-solar.fr', devisEndpoint: '' },
    tarifs: {
      prixKwhReseau: 0.2016,
      tarifRachatSurplus: 0.04,
      primeAutoconsommation: [
        { maxKwc: 9, eurPerKwc: 80 },
        { maxKwc: 36, eurPerKwc: 180 },
        { maxKwc: 100, eurPerKwc: 90 }
      ]
    },
    panneaux: [
      { id: 'topcon425', nom: 'Panneau TOPCon 425 Wc', puissanceWc: 425, largeurM: 1.134, hauteurM: 1.722, description: 'Monocristallin, garantie 25 ans' },
      { id: 'topcon500', nom: 'Panneau TOPCon 500 Wc', puissanceWc: 500, largeurM: 1.134, hauteurM: 1.961, description: 'Haut rendement, full black' }
    ],
    onduleurs: [
      { id: 'micro', nom: 'Micro-onduleurs', performanceRatio: 0.82, description: 'Optimisation panneau par panneau' },
      { id: 'string', nom: 'Onduleur central', performanceRatio: 0.78, description: 'Solution économique' }
    ],
    batteries: [
      { id: 'none', nom: 'Sans batterie', capaciteKwh: 0, prix: 0 },
      { id: 'b5', nom: 'Batterie 5 kWh', capaciteKwh: 5, prix: 3900 }
    ],
    offres: [
      { id: 'essentielle', nom: 'Essentielle', accroche: 'Le solaire au meilleur prix', panneauId: 'topcon425', onduleurId: 'string', batterieId: 'none', forfaitBase: 1900, prixParPanneau: 540, inclus: ['Pose et raccordement', 'Démarches administratives'] },
      { id: 'confort', nom: 'Confort', accroche: 'Micro-onduleurs haut rendement', panneauId: 'topcon500', onduleurId: 'micro', batterieId: 'none', forfaitBase: 2200, prixParPanneau: 640, inclus: ['Pose et raccordement', 'Suivi par panneau'] }
    ]
  };

  var MONTH_LABELS = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];

  /* ================= Utilitaires DOM ================= */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), attrs[k]);
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }
  function fmt(n, dec) {
    return Number(n).toLocaleString('fr-FR', { maximumFractionDigits: dec || 0, minimumFractionDigits: 0 });
  }
  function eur(n) { return fmt(Math.round(n)) + ' €'; }
  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }
  function azLabel(az) {
    var pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
    return pts[Math.round(E.norm360(az) / 22.5) % 16];
  }

  /* ================= Widget ================= */
  function Simulator(container, options) {
    this.cfg = Object.assign({}, DEFAULTS, options || {});
    this.root = typeof container === 'string' ? document.querySelector(container) : container;
    if (!this.root) throw new Error('RDFSolarSim : conteneur introuvable');
    if (!root.L) throw new Error('RDFSolarSim : Leaflet doit être chargé avant le simulateur');

    this.catalog = FALLBACK_CATALOG;
    this.state = {
      step: 1,
      address: null,          // { label, lat, lng }
      roofPoints: [],         // latlngs du polygone en cours de dessin
      roofClosed: false,
      obstacles: [],          // [[latlng…]]
      drawMode: null,         // 'roof' | 'obstacle' | null
      tilt: 30,
      azimuth: 180,
      landscape: false,
      excluded: {},           // panneaux retirés à la main, clé "row:col"
      offerId: null,
      panelId: null,
      inverterId: null,
      batteryId: null,
      consumptionKwh: 4500,
      panels: [],             // résultat du calepinage
      origin: null
    };

    this._buildDom();
    this._initMap();
    this._loadCatalog();
  }

  /* ---------------- Chargement du catalogue d'offres ---------------- */
  Simulator.prototype._loadCatalog = function () {
    var self = this;
    if (this.cfg.offers) { this._applyCatalog(this.cfg.offers); return; } // catalogue passé en direct
    if (!this.cfg.offersUrl) { this._applyCatalog(this.catalog); return; }
    fetch(this.cfg.offersUrl)
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (json) { self._applyCatalog(json); })
      .catch(function () { self._applyCatalog(self.catalog); });
  };

  Simulator.prototype._applyCatalog = function (catalog) {
    this.catalog = catalog;
    var first = catalog.offres[0];
    this.state.offerId = first.id;
    this.state.panelId = first.panneauId;
    this.state.inverterId = first.onduleurId;
    this.state.batteryId = first.batterieId || 'none';
    this._renderOffers();
    this._refresh();
  };

  Simulator.prototype._offer = function () {
    var id = this.state.offerId;
    return this.catalog.offres.filter(function (o) { return o.id === id; })[0] || this.catalog.offres[0];
  };
  Simulator.prototype._panel = function () {
    var id = this.state.panelId;
    return this.catalog.panneaux.filter(function (p) { return p.id === id; })[0] || this.catalog.panneaux[0];
  };
  Simulator.prototype._inverter = function () {
    var id = this.state.inverterId;
    return this.catalog.onduleurs.filter(function (o) { return o.id === id; })[0] || this.catalog.onduleurs[0];
  };
  Simulator.prototype._battery = function () {
    var id = this.state.batteryId;
    return this.catalog.batteries.filter(function (b) { return b.id === id; })[0] || { capaciteKwh: 0, prix: 0, nom: 'Sans batterie' };
  };

  /* ---------------- Construction du DOM ---------------- */
  Simulator.prototype._buildDom = function () {
    var self = this;
    this.root.classList.add('rdfsim');
    this.root.innerHTML = '';

    // En-tête
    this.root.appendChild(el('div', { class: 'rdfsim-header' }, [
      el('span', { class: 'rdfsim-logo-sun' }),
      el('div', {}, [
        el('div', { class: 'rdfsim-logo', text: 'RDF-SOLAR' }),
        el('div', { class: 'rdfsim-header-sub', text: 'Visualisez votre future installation photovoltaïque sur votre toit, en conditions réelles' })
      ])
    ]));

    // Étapes
    var stepDefs = [
      [1, 'Adresse'],
      [2, 'Votre toiture'],
      [3, 'Offre & équipements'],
      [4, 'Résultats']
    ];
    this.stepBtns = {};
    var stepsBar = el('div', { class: 'rdfsim-steps' });
    stepDefs.forEach(function (d) {
      var b = el('button', {
        class: 'rdfsim-step', type: 'button',
        onclick: function () { self._goStep(d[0]); }
      }, [
        el('span', { class: 'rdfsim-step-n', text: String(d[0]) }),
        el('span', { text: d[1] })
      ]);
      self.stepBtns[d[0]] = b;
      stepsBar.appendChild(b);
    });
    this.root.appendChild(stepsBar);

    // Corps
    this.side = el('div', { class: 'rdfsim-side' });
    this.mapArea = el('div', { class: 'rdfsim-maparea' });
    this.mapDiv = el('div', { class: 'rdfsim-map' });
    this.mapHint = el('div', { class: 'rdfsim-map-hint', text: 'Recherchez votre adresse pour commencer' });
    this.mapTools = el('div', { class: 'rdfsim-map-tools' });
    this.mapArea.appendChild(this.mapDiv);
    this.mapArea.appendChild(this.mapHint);
    this.mapArea.appendChild(this.mapTools);
    this.root.appendChild(el('div', { class: 'rdfsim-body' }, [this.side, this.mapArea]));

    // Pied
    this.root.appendChild(el('div', { class: 'rdfsim-footer' }, [
      el('span', { html: 'Simulateur <b>RDF-SOLAR</b> — estimation non contractuelle' }),
      el('span', { html: 'Fond de carte : orthophotos © <a href="https://www.ign.fr" target="_blank" rel="noopener">IGN</a> · Adresses : Base Adresse Nationale' })
    ]));

    this._buildStepPanels();
    this._buildMapTools();
    this._goStep(1);
  };

  Simulator.prototype._buildStepPanels = function () {
    var self = this;
    this.panels = {};

    /* --- Étape 1 : adresse --- */
    var acInput = el('input', {
      class: 'rdfsim-input', type: 'text', placeholder: 'Ex. : 12 rue de la République, Lyon',
      autocomplete: 'off'
    });
    var acList = el('div', { class: 'rdfsim-ac-list', style: 'display:none' });
    acInput.addEventListener('input', debounce(function () { self._searchAddress(acInput.value, acList); }, 280));
    acInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); self._searchAddress(acInput.value, acList); }
    });
    this.acInput = acInput;

    this.panels[1] = el('div', {}, [
      el('div', { class: 'rdfsim-card' }, [
        el('h3', { text: '1. Où se situe votre projet ?' }),
        el('p', { class: 'rdfsim-muted', text: 'Particulier ou entreprise : saisissez l’adresse du bâtiment. La vue satellite haute résolution (20 cm) de l’IGN s’affichera pour dessiner votre toiture.' }),
        el('div', { class: 'rdfsim-ac' }, [acInput, acList]),
        el('div', { class: 'rdfsim-btn-row' }, [
          el('button', {
            class: 'rdfsim-btn rdfsim-btn-primary', type: 'button', text: 'Continuer vers le dessin du toit →',
            onclick: function () { self._goStep(2); }
          })
        ])
      ]),
      el('div', { class: 'rdfsim-card' }, [
        el('h4', { text: 'Comment ça marche ?' }),
        el('p', { class: 'rdfsim-muted', html: '<b>1.</b> Votre adresse → vue aérienne réelle de votre toit<br><b>2.</b> Dessinez la toiture, l’outil place les panneaux automatiquement<br><b>3.</b> Choisissez votre offre RDF-SOLAR et vos équipements<br><b>4.</b> Production, économies et demande de devis en 1 clic' })
      ])
    ]);

    /* --- Étape 2 : toiture --- */
    this.tiltVal = el('span', { class: 'rdfsim-value', text: '30°' });
    var tiltRange = el('input', { type: 'range', min: '0', max: '60', step: '1', value: '30' });
    tiltRange.addEventListener('input', function () {
      self.state.tilt = +tiltRange.value;
      self.tiltVal.textContent = tiltRange.value + '°';
      self._relayout();
    });

    this.azVal = el('span', { class: 'rdfsim-value', text: '180° (S)' });
    var azRange = el('input', { type: 'range', min: '0', max: '359', step: '1', value: '180' });
    azRange.addEventListener('input', function () {
      self.state.azimuth = +azRange.value;
      self.azVal.textContent = azRange.value + '° (' + azLabel(+azRange.value) + ')';
      self._relayout();
    });
    this.azRange = azRange;

    var segPortrait = el('button', { type: 'button', class: 'is-on', text: 'Portrait' });
    var segLandscape = el('button', { type: 'button', text: 'Paysage' });
    segPortrait.addEventListener('click', function () {
      self.state.landscape = false;
      segPortrait.classList.add('is-on'); segLandscape.classList.remove('is-on');
      self._relayout();
    });
    segLandscape.addEventListener('click', function () {
      self.state.landscape = true;
      segLandscape.classList.add('is-on'); segPortrait.classList.remove('is-on');
      self._relayout();
    });

    this.miniStats = el('div', { class: 'rdfsim-mini-stats' });

    this.panels[2] = el('div', {}, [
      el('div', { class: 'rdfsim-card' }, [
        el('h3', { text: '2. Dessinez votre toiture' }),
        el('p', { class: 'rdfsim-muted', html: 'Sur la carte : cliquez sur les angles du pan de toit à équiper, puis <b>recliquez sur le premier point</b> (ou double-cliquez) pour fermer. Les panneaux se placent automatiquement. Cliquez sur un panneau pour le retirer/remettre.' }),
        el('label', { class: 'rdfsim-label' }, [document.createTextNode('Inclinaison du toit : '), this.tiltVal]),
        tiltRange,
        el('p', { class: 'rdfsim-muted', style: 'margin:4px 0 0', text: 'Toit plat ≈ 5–10° (avec bacs lestés) · toit standard ≈ 30° · toit pentu ≈ 45°' }),
        el('label', { class: 'rdfsim-label' }, [document.createTextNode('Orientation (azimut) : '), this.azVal]),
        azRange,
        el('div', { class: 'rdfsim-btn-row' }, [
          el('button', {
            class: 'rdfsim-btn rdfsim-btn-ghost', type: 'button', text: '⟳ Aligner sur le toit',
            title: 'Aligne les panneaux sur l’arête la plus longue du polygone dessiné',
            onclick: function () { self._autoAzimuth(); }
          })
        ]),
        el('label', { class: 'rdfsim-label', text: 'Pose des panneaux' }),
        el('div', { class: 'rdfsim-seg' }, [segPortrait, segLandscape]),
        this.miniStats,
        el('div', { class: 'rdfsim-btn-row' }, [
          el('button', {
            class: 'rdfsim-btn rdfsim-btn-primary', type: 'button', text: 'Choisir mon offre →',
            onclick: function () { self._goStep(3); }
          })
        ])
      ])
    ]);

    /* --- Étape 3 : offre & composants --- */
    this.offersBox = el('div', {});
    this.componentsBox = el('div', {});
    var consInput = el('input', { class: 'rdfsim-input', type: 'number', min: '500', step: '100', value: String(this.state.consumptionKwh) });
    consInput.addEventListener('input', function () {
      self.state.consumptionKwh = Math.max(0, +consInput.value || 0);
      self._refresh();
    });

    this.panels[3] = el('div', {}, [
      el('div', { class: 'rdfsim-card' }, [
        el('h3', { text: '3. Votre offre RDF-SOLAR' }),
        el('p', { class: 'rdfsim-muted', text: 'Les dimensions réelles des panneaux de chaque offre sont utilisées pour le placement sur votre toit.' }),
        this.offersBox
      ]),
      el('div', { class: 'rdfsim-card' }, [
        el('h4', { text: 'Personnaliser les équipements' }),
        this.componentsBox
      ]),
      el('div', { class: 'rdfsim-card' }, [
        el('h4', { text: 'Votre consommation électrique annuelle (kWh)' }),
        consInput,
        el('p', { class: 'rdfsim-muted', style: 'margin:6px 0 0', text: 'Repère : ~2 500 kWh pour un petit logement, ~4 500 kWh pour une maison, ~8 000+ kWh avec chauffage électrique ou véhicule électrique. Ce chiffre figure sur votre facture.' }),
        el('div', { class: 'rdfsim-btn-row' }, [
          el('button', {
            class: 'rdfsim-btn rdfsim-btn-primary', type: 'button', text: 'Voir mes résultats →',
            onclick: function () { self._goStep(4); }
          })
        ])
      ])
    ]);

    /* --- Étape 4 : résultats --- */
    this.resultsBox = el('div', {});
    this.panels[4] = this.resultsBox;
  };

  /* ---------------- Barre d'outils carte ---------------- */
  Simulator.prototype._buildMapTools = function () {
    var self = this;
    this.toolRoof = el('button', {
      class: 'rdfsim-tool', type: 'button', text: '✏ Dessiner le toit',
      onclick: function () { self._setDrawMode(self.state.drawMode === 'roof' ? null : 'roof'); }
    });
    this.toolObstacle = el('button', {
      class: 'rdfsim-tool', type: 'button', text: '⛔ Zone à éviter',
      title: 'Cheminée, velux, ombre portée…',
      onclick: function () { self._setDrawMode(self.state.drawMode === 'obstacle' ? null : 'obstacle'); }
    });
    this.toolClear = el('button', {
      class: 'rdfsim-tool', type: 'button', text: '🗑 Tout effacer',
      onclick: function () { self._clearDrawing(); }
    });
    this.tool3d = el('button', {
      class: 'rdfsim-tool', type: 'button', text: '🧊 Vue 3D',
      title: 'Visualisez le bâtiment et les ombres en 3D',
      onclick: function () { self._open3d(); }
    });
    this.mapTools.appendChild(this.toolRoof);
    this.mapTools.appendChild(this.toolObstacle);
    this.mapTools.appendChild(this.toolClear);
    if (root.RDFSolar3D && root.RDFSolar3D.available()) this.mapTools.appendChild(this.tool3d);
    this.mapTools.style.display = 'none';
  };

  /* ---------------- Carte Leaflet + orthophotos IGN ---------------- */
  Simulator.prototype._initMap = function () {
    var self = this;
    this.map = L.map(this.mapDiv, {
      center: this.cfg.center,
      zoom: this.cfg.zoom,
      maxZoom: this.cfg.maxZoom,
      doubleClickZoom: false,
      attributionControl: false
    });

    // Orthophotos IGN (Géoplateforme) — gratuites, sans clé, résolution 20 cm
    L.tileLayer(
      'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
      '&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM' +
      '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg',
      { maxZoom: this.cfg.maxZoom, maxNativeZoom: 19, tileSize: 256 }
    ).addTo(this.map);

    this.layerRoof = L.layerGroup().addTo(this.map);
    this.layerPanels = L.layerGroup().addTo(this.map);
    this.layerDraft = L.layerGroup().addTo(this.map);

    this.map.on('click', function (ev) { self._onMapClick(ev); });
    this.map.on('dblclick', function () { self._closeCurrentShape(); });
    this.map.on('mousemove', function (ev) { self._onMapMove(ev); });
  };

  Simulator.prototype._setDrawMode = function (mode) {
    this.state.drawMode = mode;
    this.state.roofClosed = this.state.roofClosed && mode !== 'roof' ? this.state.roofClosed : this.state.roofClosed;
    if (mode === 'roof') {
      this.state.roofPoints = [];
      this.state.roofClosed = false;
      this.state.excluded = {};
      this.layerRoof.clearLayers();
      this.layerPanels.clearLayers();
      this.mapHint.textContent = 'Cliquez sur chaque angle du pan de toit, puis recliquez sur le premier point pour fermer';
    } else if (mode === 'obstacle') {
      this.draftPoints = [];
      this.mapHint.textContent = 'Entourez la zone à éviter (cheminée, velux, ombre), recliquez sur le premier point pour fermer';
    } else {
      this.mapHint.textContent = this.state.roofClosed
        ? 'Cliquez sur un panneau pour le retirer / le remettre'
        : 'Activez « Dessiner le toit » pour commencer';
    }
    this.draftPoints = [];
    this.layerDraft.clearLayers();
    this.toolRoof.classList.toggle('is-on', mode === 'roof');
    this.toolObstacle.classList.toggle('is-on', mode === 'obstacle');
  };

  Simulator.prototype._clearDrawing = function () {
    this.state.roofPoints = [];
    this.state.roofClosed = false;
    this.state.obstacles = [];
    this.state.excluded = {};
    this.state.panels = [];
    this.draftPoints = [];
    this.layerRoof.clearLayers();
    this.layerPanels.clearLayers();
    this.layerDraft.clearLayers();
    this._setDrawMode('roof');
    this._refresh();
  };

  Simulator.prototype._onMapClick = function (ev) {
    var mode = this.state.drawMode;
    if (!mode) return;
    var pts = mode === 'roof' ? this.state.roofPoints : (this.draftPoints = this.draftPoints || []);

    // Fermeture si clic proche du premier point
    if (pts.length >= 3) {
      var p0 = this.map.latLngToContainerPoint(pts[0]);
      var pc = this.map.latLngToContainerPoint(ev.latlng);
      if (p0.distanceTo(pc) < 12) { this._closeCurrentShape(); return; }
    }
    pts.push(ev.latlng);
    this._drawDraft(pts);
  };

  Simulator.prototype._onMapMove = function (ev) {
    var mode = this.state.drawMode;
    if (!mode) return;
    var pts = mode === 'roof' ? this.state.roofPoints : (this.draftPoints || []);
    if (pts.length) this._drawDraft(pts, ev.latlng);
  };

  Simulator.prototype._drawDraft = function (pts, cursor) {
    this.layerDraft.clearLayers();
    var line = pts.slice();
    if (cursor) line.push(cursor);
    L.polyline(line, { color: '#f59e0b', weight: 2, dashArray: '6 4' }).addTo(this.layerDraft);
    pts.forEach(function (p, i) {
      L.circleMarker(p, {
        radius: i === 0 ? 7 : 4,
        color: '#fff', weight: 2,
        fillColor: i === 0 ? '#f59e0b' : '#0f2a43', fillOpacity: 1
      }).addTo(this.layerDraft);
    }, this);
  };

  Simulator.prototype._closeCurrentShape = function () {
    var mode = this.state.drawMode;
    if (mode === 'roof' && this.state.roofPoints.length >= 3) {
      this.state.roofClosed = true;
      this._setDrawMode(null);
      this._autoAzimuth(true);
      this._relayout();
    } else if (mode === 'obstacle' && this.draftPoints && this.draftPoints.length >= 3) {
      this.state.obstacles.push(this.draftPoints.slice());
      this._setDrawMode(null);
      this._relayout();
    }
  };

  Simulator.prototype._autoAzimuth = function (silent) {
    if (!this.state.roofClosed) return;
    var origin = this.state.roofPoints[0];
    var m = E.toLocalMeters(this.state.roofPoints, origin);
    var az = Math.round(E.suggestedAzimuth(m));
    this.state.azimuth = az;
    if (this.azRange) {
      this.azRange.value = az;
      this.azVal.textContent = az + '° (' + azLabel(az) + ')';
    }
    if (!silent) this._relayout();
  };

  /* ---------------- Vue 3D (optionnelle, nécessite Three.js) ---------------- */
  Simulator.prototype._open3d = function () {
    if (!this.state.roofClosed) {
      this.mapHint.textContent = 'Dessinez et fermez d’abord votre toiture pour voir la 3D';
      return;
    }
    if (root.RDFSolar3D && root.RDFSolar3D.available()) {
      root.RDFSolar3D.open(this);
    } else {
      this.mapHint.textContent = 'Vue 3D indisponible (Three.js non chargé sur cette page)';
    }
  };

  /* ---------------- Calepinage + rendu des panneaux ---------------- */
  Simulator.prototype._relayout = function () {
    var s = this.state;
    if (this._view3d) this._view3d.close(); // la 3D reflète l'état courant : on la fermera le temps du recalcul
    this.layerRoof.clearLayers();
    this.layerPanels.clearLayers();
    if (!s.roofClosed || s.roofPoints.length < 3) { this._refresh(); return; }

    var origin = s.roofPoints[0];
    s.origin = origin;
    var roofM = E.toLocalMeters(s.roofPoints, origin);
    var obstaclesM = s.obstacles.map(function (o) { return E.toLocalMeters(o, origin); });

    // Toit
    L.polygon(s.roofPoints, {
      color: '#f59e0b', weight: 2.5, fillColor: '#f59e0b', fillOpacity: 0.07,
      className: 'rdfsim-roof-poly'
    }).addTo(this.layerRoof);

    // Obstacles
    s.obstacles.forEach(function (o) {
      L.polygon(o, { color: '#dc2626', weight: 1.5, fillColor: '#dc2626', fillOpacity: 0.25, dashArray: '4 3' })
        .addTo(this.layerRoof);
    }, this);

    // Calepinage avec les dimensions réelles du panneau choisi
    var panel = this._panel();
    s.panels = E.layoutPanels({
      roof: roofM,
      obstacles: obstaclesM,
      azimuth: s.azimuth,
      tiltDeg: s.tilt,
      panelW: panel.largeurM,
      panelH: panel.hauteurM,
      landscape: s.landscape,
      margin: this.cfg.margin,
      gap: this.cfg.gap
    });

    var self = this;
    s.panels.forEach(function (p) {
      var key = p.row + ':' + p.col;
      var excluded = !!s.excluded[key];
      var latlngs = p.corners.map(function (c) { return E.toLatLng(c, origin); });
      var poly = L.polygon(latlngs, excluded ? {
        color: '#94a3b8', weight: 1, fillColor: '#94a3b8', fillOpacity: 0.15, dashArray: '3 3',
        className: 'rdfsim-panel-shape'
      } : {
        color: '#9fc3ff', weight: 1, fillColor: '#16324f', fillOpacity: 0.92,
        className: 'rdfsim-panel-shape'
      });
      poly.on('click', function (ev) {
        L.DomEvent.stopPropagation(ev);
        // En mode dessin (obstacle sur le champ de panneaux…), le clic sert à poser un sommet
        if (self.state.drawMode) { self._onMapClick(ev); return; }
        s.excluded[key] = !s.excluded[key];
        self._relayout();
      });
      poly.addTo(self.layerPanels);
    });

    this._refresh();
  };

  Simulator.prototype._activePanels = function () {
    var s = this.state;
    return s.panels.filter(function (p) { return !s.excluded[p.row + ':' + p.col]; });
  };

  /* ---------------- Calculs agrégés ---------------- */
  Simulator.prototype._compute = function () {
    var s = this.state;
    var panel = this._panel();
    var inverter = this._inverter();
    var battery = this._battery();
    var offer = this._offer();
    var active = this._activePanels();
    var n = active.length;
    var kwc = n * panel.puissanceWc / 1000;

    var lat = s.address ? s.address.lat : (s.origin ? s.origin.lat : 46.6);
    var lng = s.address ? s.address.lng : (s.origin ? s.origin.lng : 2.4);

    var prod = E.estimateProduction({
      kwc: kwc, lat: lat, lng: lng,
      tiltDeg: s.tilt, azimuthDeg: s.azimuth,
      performanceRatio: inverter.performanceRatio
    });

    var tarifs = this.catalog.tarifs || {};
    var installCost = (offer.forfaitBase || 0) + n * (offer.prixParPanneau || 0) + (battery.prix || 0);
    var fin = E.financials({
      productionKwh: prod.annualKwh,
      consumptionKwh: s.consumptionKwh,
      batteryKwh: battery.capaciteKwh || 0,
      gridPrice: tarifs.prixKwhReseau != null ? tarifs.prixKwhReseau : 0.2016,
      feedInTariff: tarifs.tarifRachatSurplus != null ? tarifs.tarifRachatSurplus : 0.04,
      installCost: installCost,
      bonusTiers: tarifs.primeAutoconsommation,
      kwc: kwc
    });

    var roofM = s.roofClosed ? E.toLocalMeters(s.roofPoints, s.roofPoints[0]) : null;
    return {
      n: n, kwc: kwc, prod: prod, fin: fin,
      installCost: installCost,
      roofArea: roofM ? E.polygonArea(roofM) / Math.cos(s.tilt * Math.PI / 180) : 0,
      panel: panel, inverter: inverter, battery: battery, offer: offer
    };
  };

  /* ---------------- Recherche d'adresse (BAN) ---------------- */
  Simulator.prototype._searchAddress = function (q, listBox) {
    var self = this;
    if (!q || q.trim().length < 3) { listBox.style.display = 'none'; return; }
    fetch('https://api-adresse.data.gouv.fr/search/?limit=6&q=' + encodeURIComponent(q))
      .then(function (r) { return r.json(); })
      .then(function (json) {
        listBox.innerHTML = '';
        var feats = (json && json.features) || [];
        if (!feats.length) { listBox.style.display = 'none'; return; }
        feats.forEach(function (f) {
          var c = f.geometry.coordinates;
          var item = el('button', { class: 'rdfsim-ac-item', type: 'button' }, [
            el('span', { text: f.properties.label }),
            el('small', { text: (f.properties.context || '') })
          ]);
          item.addEventListener('click', function () {
            self._selectAddress({ label: f.properties.label, lat: c[1], lng: c[0] });
            listBox.style.display = 'none';
          });
          listBox.appendChild(item);
        });
        listBox.style.display = 'block';
      })
      .catch(function () { listBox.style.display = 'none'; });
  };

  Simulator.prototype._selectAddress = function (addr) {
    this.state.address = addr;
    this.acInput.value = addr.label;
    this.map.setView([addr.lat, addr.lng], 20);
    this.mapHint.textContent = 'Voici votre toit ! Passez à l’étape « Votre toiture » pour dessiner';
    this._refresh();
  };

  /* ---------------- Navigation entre étapes ---------------- */
  Simulator.prototype._updateStepBar = function () {
    var s = this.state;
    Object.keys(this.stepBtns).forEach(function (k) {
      var b = this.stepBtns[k];
      b.classList.toggle('is-active', +k === s.step);
      b.classList.toggle('is-done', +k < s.step);
      b.disabled = (+k >= 2 && !s.address) || (+k >= 3 && !s.roofClosed);
    }, this);
  };

  Simulator.prototype._goStep = function (n) {
    var s = this.state;
    if (n >= 2 && !s.address) { this.mapHint.textContent = 'Choisissez d’abord une adresse'; n = 1; }
    if (n >= 3 && !s.roofClosed) { if (s.address) this.mapHint.textContent = 'Dessinez d’abord votre toiture'; n = Math.min(n, 2); }
    s.step = n;
    this._updateStepBar();

    this.side.innerHTML = '';
    this.side.appendChild(this.panels[n]);
    this.mapTools.style.display = n === 2 ? 'flex' : 'none';

    if (n === 2 && !s.roofClosed && !s.drawMode) this._setDrawMode('roof');
    if (n !== 2 && s.drawMode) this._setDrawMode(null);
    if (n === 3) this.mapHint.textContent = 'Changez d’offre ou de panneau : le calepinage se met à jour en direct';
    if (n === 4) {
      this.mapHint.textContent = 'Votre future installation ☀ — ' + (s.address ? s.address.label : '');
      this._renderResults();
    }

    var mapSelf = this;
    setTimeout(function () { mapSelf.map.invalidateSize(); }, 60);
  };

  /* ---------------- Rendus dynamiques ---------------- */
  Simulator.prototype._renderOffers = function () {
    var self = this;
    this.offersBox.innerHTML = '';
    this.catalog.offres.forEach(function (o) {
      var pan = self.catalog.panneaux.filter(function (p) { return p.id === o.panneauId; })[0] || {};
      var card = el('button', { class: 'rdfsim-offer' + (o.id === self.state.offerId ? ' is-on' : ''), type: 'button' }, [
        el('div', { class: 'rdfsim-offer-head' }, [
          el('span', { class: 'rdfsim-offer-name', text: o.nom }),
          el('span', { class: 'rdfsim-offer-tag', text: (pan.puissanceWc || '?') + ' Wc / panneau' })
        ]),
        el('div', { class: 'rdfsim-offer-desc', text: o.accroche || '' }),
        el('ul', {}, (o.inclus || []).map(function (i) { return el('li', { text: i }); }))
      ]);
      card.addEventListener('click', function () {
        self.state.offerId = o.id;
        self.state.panelId = o.panneauId;
        self.state.inverterId = o.onduleurId;
        self.state.batteryId = o.batterieId || 'none';
        self._renderOffers();
        self._relayout();
      });
      self.offersBox.appendChild(card);
    });
    this._renderComponents();
  };

  Simulator.prototype._renderComponents = function () {
    var self = this;
    this.componentsBox.innerHTML = '';
    function selector(labelText, items, currentId, onChange, describe) {
      var sel = el('select', { class: 'rdfsim-input' });
      items.forEach(function (it) {
        var opt = el('option', { value: it.id, text: it.nom + (describe ? describe(it) : '') });
        if (it.id === currentId) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', function () { onChange(sel.value); });
      self.componentsBox.appendChild(el('label', { class: 'rdfsim-label', text: labelText }));
      self.componentsBox.appendChild(sel);
      var cur = items.filter(function (it) { return it.id === currentId; })[0];
      if (cur && cur.description) {
        self.componentsBox.appendChild(el('p', { class: 'rdfsim-muted', style: 'margin:5px 0 0', text: cur.description }));
      }
    }
    selector('Panneaux', this.catalog.panneaux, this.state.panelId, function (v) {
      self.state.panelId = v; self._renderComponents(); self._relayout();
    }, function (p) { return ' — ' + p.puissanceWc + ' Wc (' + p.hauteurM + '×' + p.largeurM + ' m)'; });
    selector('Onduleur', this.catalog.onduleurs, this.state.inverterId, function (v) {
      self.state.inverterId = v; self._renderComponents(); self._refresh();
    });
    selector('Batterie de stockage', this.catalog.batteries, this.state.batteryId, function (v) {
      self.state.batteryId = v; self._renderComponents(); self._refresh();
    }, function (b) { return b.prix ? ' — +' + fmt(b.prix) + ' €' : ''; });
  };

  Simulator.prototype._refresh = function () {
    this._updateStepBar();
    var c = this._compute();
    // Mini-stats de l'étape 2
    this.miniStats.innerHTML = '';
    var stats = [
      [c.roofArea ? fmt(c.roofArea) + ' m²' : '—', 'surface de toit'],
      [String(c.n), 'panneaux posés'],
      [c.kwc ? fmt(c.kwc, 2) + ' kWc' : '—', 'puissance crête']
    ];
    stats.forEach(function (s) {
      this.miniStats.appendChild(el('div', { class: 'rdfsim-mini-stat' }, [
        el('b', { text: s[0] }),
        el('span', { text: s[1] })
      ]));
    }, this);
    if (this.state.step === 4) this._renderResults();
  };

  /* ---------------- Étape 4 : résultats ---------------- */
  Simulator.prototype._renderResults = function () {
    var self = this;
    var c = this._compute();
    var box = this.resultsBox;
    box.innerHTML = '';

    if (!c.n) {
      box.appendChild(el('div', { class: 'rdfsim-card' }, [
        el('h3', { text: 'Aucun panneau placé' }),
        el('p', { class: 'rdfsim-muted', text: 'Retournez à l’étape « Votre toiture » : la surface dessinée est peut-être trop petite pour les dimensions du panneau choisi, ou tous les panneaux ont été retirés.' })
      ]));
      return;
    }

    var payback = isFinite(c.fin.paybackYears) ? fmt(c.fin.paybackYears, 1) + ' ans' : '—';

    var grid = el('div', { class: 'rdfsim-results-grid' }, [
      el('div', { class: 'rdfsim-kpi is-hero' }, [
        el('div', { class: 'rdfsim-kpi-v', html: fmt(c.prod.annualKwh) + ' <small>kWh/an</small>' }),
        el('div', { class: 'rdfsim-kpi-l', text: 'Production annuelle estimée — ' + fmt(c.prod.specificYield) + ' kWh/kWc sur votre toit' })
      ]),
      kpi(fmt(c.kwc, 2) + ' kWc', c.n + ' panneaux ' + c.panel.puissanceWc + ' Wc'),
      kpi(Math.round(c.fin.selfConsumptionRate * 100) + ' %', 'autoconsommation estimée'),
      kpi(eur(c.fin.annualSavings) + '/an', 'économies + revente du surplus'),
      kpi(payback, 'retour sur investissement'),
      kpi(eur(c.installCost), 'coût indicatif (' + c.offer.nom + (c.battery.capaciteKwh ? ' + batterie' : '') + ')'),
      kpi(eur(c.fin.bonus), 'prime à l’autoconsommation'),
      kpi(fmt(c.fin.co2SavedKg) + ' kg', 'CO₂ évité chaque année'),
      kpi(fmt(c.fin.surplusKwh) + ' kWh', 'surplus revendu au réseau')
    ]);
    function kpi(v, l) {
      return el('div', { class: 'rdfsim-kpi' }, [
        el('div', { class: 'rdfsim-kpi-v', text: v }),
        el('div', { class: 'rdfsim-kpi-l', text: l })
      ]);
    }
    box.appendChild(grid);

    // Graphique de production mensuelle
    var chartCard = el('div', { class: 'rdfsim-card rdfsim-chart-card' }, [
      el('h4', { text: 'Production mensuelle estimée (kWh)' })
    ]);
    chartCard.appendChild(this._buildChart(c.prod.monthly));
    box.appendChild(chartCard);

    // CTA devis
    var brand = this.catalog.brand || {};
    var cta = el('div', { class: 'rdfsim-card' }, [
      el('h3', { text: 'Concrétisez votre projet' }),
      el('p', { class: 'rdfsim-muted', text: 'Recevez une étude personnalisée et un devis gratuit par un conseiller RDF-SOLAR, sur la base de cette simulation.' }),
      el('button', {
        class: 'rdfsim-btn rdfsim-btn-primary', type: 'button', text: '☀ Demander mon devis gratuit',
        onclick: function () { self._requestQuote(c); }
      }),
      el('div', { class: 'rdfsim-btn-row' }, [
        (root.RDFSolar3D && root.RDFSolar3D.available()) ? el('button', {
          class: 'rdfsim-btn rdfsim-btn-ghost', type: 'button', text: '🧊 Voir en 3D',
          onclick: function () { self._open3d(); }
        }) : null,
        el('button', {
          class: 'rdfsim-btn rdfsim-btn-ghost', type: 'button', text: 'Copier le récapitulatif',
          onclick: function (ev) {
            var btn = ev.currentTarget;
            navigator.clipboard.writeText(self._summaryText(c)).then(function () {
              btn.textContent = '✓ Copié !';
              setTimeout(function () { btn.textContent = 'Copier le récapitulatif'; }, 1800);
            });
          }
        })
      ]),
      el('p', { class: 'rdfsim-disclaimer', html: 'Estimation indicative et non contractuelle, calculée à partir de l’ensoleillement moyen de votre région, de l’orientation et de l’inclinaison déclarées. Les ombrages proches (arbres, bâtiments), l’état du réseau et les tarifs en vigueur peuvent modifier ces valeurs. ' + (this.catalog.tarifs && this.catalog.tarifs.note ? this.catalog.tarifs.note : '') })
    ]);
    box.appendChild(cta);
  };

  Simulator.prototype._summaryText = function (c) {
    var s = this.state;
    return [
      '— Simulation photovoltaïque RDF-SOLAR —',
      'Adresse : ' + (s.address ? s.address.label : '—'),
      'Offre : ' + c.offer.nom + ' | Panneau : ' + c.panel.nom + ' | Onduleur : ' + c.inverter.nom + ' | ' + c.battery.nom,
      'Installation : ' + c.n + ' panneaux, ' + fmt(c.kwc, 2) + ' kWc, inclinaison ' + s.tilt + '°, orientation ' + s.azimuth + '° (' + azLabel(s.azimuth) + ')',
      'Production estimée : ' + fmt(c.prod.annualKwh) + ' kWh/an (' + fmt(c.prod.specificYield) + ' kWh/kWc)',
      'Autoconsommation : ' + Math.round(c.fin.selfConsumptionRate * 100) + ' % | Économies : ' + eur(c.fin.annualSavings) + '/an',
      'Coût indicatif : ' + eur(c.installCost) + ' | Prime : ' + eur(c.fin.bonus) + ' | Retour : ' + (isFinite(c.fin.paybackYears) ? fmt(c.fin.paybackYears, 1) + ' ans' : '—')
    ].join('\n');
  };

  Simulator.prototype._requestQuote = function (c) {
    var brand = this.catalog.brand || {};
    var summary = this._summaryText(c);
    if (brand.devisEndpoint) {
      // Envoi vers le back-office / CRM du site (à brancher côté serveur)
      fetch(brand.devisEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adresse: this.state.address,
          offre: c.offer.id,
          nbPanneaux: c.n,
          kwc: c.kwc,
          productionKwh: Math.round(c.prod.annualKwh),
          economiesAn: Math.round(c.fin.annualSavings),
          coutIndicatif: c.installCost,
          resume: summary
        })
      }).then(function () {
        alert('Votre demande a bien été transmise à RDF-SOLAR. Un conseiller vous recontacte rapidement !');
      }).catch(function () {
        alert('Impossible d’envoyer la demande pour le moment. Réessayez ou contactez-nous directement.');
      });
    } else {
      var mail = brand.contactEmail || 'contact@rdf-solar.fr';
      var subject = encodeURIComponent('Demande de devis — simulation photovoltaïque');
      var body = encodeURIComponent(summary + '\n\nMes coordonnées :\nNom :\nTéléphone :\n');
      window.location.href = 'mailto:' + mail + '?subject=' + subject + '&body=' + body;
    }
  };

  /* ---------------- Graphique SVG (12 barres mensuelles) ---------------- */
  Simulator.prototype._buildChart = function (monthly) {
    var W = 340, H = 180;
    var padL = 34, padR = 6, padT = 14, padB = 22;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var max = Math.max.apply(null, monthly);
    var maxIdx = monthly.indexOf(max);
    // Échelle : arrondi au "joli" palier supérieur
    var step = Math.pow(10, Math.floor(Math.log10(max || 1)));
    var top = Math.ceil(max / step) * step;
    if (top / max > 1.6) top = Math.ceil(max * 2 / step) * step / 2;

    var svgNS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Production mensuelle estimée en kilowattheures');

    function sEl(name, attrs) {
      var n = document.createElementNS(svgNS, name);
      Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
      return n;
    }

    // Grille horizontale discrète + graduations (format compact au-delà de 10 000)
    function axisFmt(v) { return top >= 10000 ? fmt(v / 1000, 1) + ' k' : fmt(v); }
    for (var g = 0; g <= 4; g++) {
      var y = padT + plotH - (g / 4) * plotH;
      svg.appendChild(sEl('line', { x1: padL, x2: W - padR, y1: y, y2: y, class: 'rdfsim-grid-line' }));
      var t = sEl('text', { x: padL - 5, y: y + 3.5, 'text-anchor': 'end', class: 'rdfsim-axis-text' });
      t.textContent = axisFmt(top * g / 4);
      svg.appendChild(t);
    }

    var wrap = el('div', { class: 'rdfsim-chart' });
    var tip = el('div', { class: 'rdfsim-chart-tip' });

    var n = monthly.length;
    var band = plotW / n;
    var barW = Math.max(6, band - 6);
    monthly.forEach(function (v, i) {
      var h = top > 0 ? (v / top) * plotH : 0;
      var x = padL + i * band + (band - barW) / 2;
      var y = padT + plotH - h;

      // Barre : coins arrondis en haut uniquement (ancrée à la ligne de base)
      var r = Math.min(4, barW / 2, h);
      var d = 'M' + x + ' ' + (padT + plotH) +
        ' V' + (y + r) +
        ' Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y +
        ' H' + (x + barW - r) +
        ' Q' + (x + barW) + ' ' + y + ' ' + (x + barW) + ' ' + (y + r) +
        ' V' + (padT + plotH) + ' Z';
      var bar = sEl('path', { d: d, class: 'rdfsim-bar' });

      // Zone de survol plus large que la barre
      var hit = sEl('rect', { x: padL + i * band, y: padT, width: band, height: plotH, fill: 'transparent' });
      hit.style.cursor = 'pointer';
      hit.addEventListener('mouseenter', function () {
        bar.classList.add('is-hover');
        tip.textContent = MONTH_LABELS[i] + ' : ' + fmt(v) + ' kWh';
        tip.style.display = 'block';
      });
      hit.addEventListener('mousemove', function (ev) {
        var rect = wrap.getBoundingClientRect();
        tip.style.left = (ev.clientX - rect.left) + 'px';
        tip.style.top = (ev.clientY - rect.top) + 'px';
      });
      hit.addEventListener('mouseleave', function () {
        bar.classList.remove('is-hover');
        tip.style.display = 'none';
      });

      svg.appendChild(bar);
      svg.appendChild(hit);

      // Étiquette directe : uniquement le mois le plus productif
      if (i === maxIdx) {
        var lbl = sEl('text', { x: x + barW / 2, y: y - 4, 'text-anchor': 'middle', class: 'rdfsim-direct-label' });
        lbl.textContent = fmt(v);
        svg.appendChild(lbl);
      }

      // Mois en abscisse
      var m = sEl('text', { x: padL + i * band + band / 2, y: H - 7, 'text-anchor': 'middle', class: 'rdfsim-axis-text' });
      m.textContent = MONTH_LABELS[i].charAt(0);
      svg.appendChild(m);
    });

    // Ligne de base
    svg.appendChild(sEl('line', {
      x1: padL, x2: W - padR, y1: padT + plotH, y2: padT + plotH,
      stroke: '#c3ccd5', 'stroke-width': 1
    }));

    wrap.appendChild(svg);
    wrap.appendChild(tip);
    return wrap;
  };

  /* ================= API publique ================= */
  root.RDFSolarSim = {
    mount: function (container, options) {
      return new Simulator(container, options);
    }
  };
})(typeof window !== 'undefined' ? window : this);
