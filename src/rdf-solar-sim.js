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
    pvgisProxyUrl: null,      // optionnel : proxy serveur vers PVGIS pour affiner la production
    googleSolarApiKey: null   // optionnel : clé API Google Solar (payante) → détection auto des pans de toit
  };

  // Libellé neutre tant qu'aucun installateur n'est configuré : le widget est
  // posé chez nos clients, il ne doit jamais afficher notre marque à leur place.
  var BRAND_PLACEHOLDER = 'Simulateur solaire';

  // Catalogue de secours si offers.json est inaccessible (ouverture en file://, etc.)
  // Le bloc `brand` est volontairement VIDE : un repli sur le nom ou l'adresse de
  // l'éditeur ferait atterrir chez lui un lead qui revient à l'installateur.
  // Barèmes à jour de l'arrêté tarifaire du 4 juin 2026 et de la TVA 5,5 % (01/10/2025).
  var FALLBACK_CATALOG = {
    brand: {
      name: '', contactEmail: '', devisEndpoint: '',
      phone: '04 00 00 00 00', whatsapp: '33600000000', droneBookingUrl: '',
      horaires: { debut: 9, fin: 18, jours: [1, 2, 3, 4, 5], libelle: 'du lundi au vendredi, 9h–18h' },
      promesseRappel: 'Rappel sous 30 min', rge: true,
      politiqueConfidentialiteUrl: '', consentementVersion: '2026-08-13-v2'
    },
    tarifs: {
      prixHT: true,
      prixKwhReseau: 0.2001,
      tarifRachatSurplus: 0.011,
      indexationRachatAnnuelle: 0.02,
      dureeContratAchatAns: 20,
      primeAutoconsommation: [],   // supprimée depuis le 4 juin 2026
      tva: { reduit: 0.055, normal: 0.20, seuilKwcTauxReduit: 9 },
      inflationElectricite: 0.03,
      degradationAnnuelle: 0.004,
      horizonAns: 25,
      dateMaj: '2026-08-13'
    },
    panneaux: [
      { id: 'topcon425', nom: 'Panneau TOPCon 425 Wc', puissanceWc: 425, largeurM: 1.134, hauteurM: 1.722, basCarbone: true, description: 'Monocristallin, garantie 25 ans' },
      { id: 'topcon500', nom: 'Panneau TOPCon 500 Wc', puissanceWc: 500, largeurM: 1.134, hauteurM: 1.961, basCarbone: true, description: 'Haut rendement, full black' }
    ],
    onduleurs: [
      { id: 'micro', nom: 'Micro-onduleurs', performanceRatio: 0.82, description: 'Optimisation panneau par panneau' },
      { id: 'string', nom: 'Onduleur central', performanceRatio: 0.78, description: 'Solution économique' }
    ],
    pilotage: [
      { id: 'none', nom: 'Sans pilotage', ems: false, prix: 0, gainAutoconsommation: 0, description: 'Ne remplit pas la condition EMS de la TVA à 5,5 %' },
      { id: 'ems2', nom: 'Pilotage intelligent (EMS)', ems: true, prix: 690, gainAutoconsommation: 0.10, description: 'Pilote automatiquement au moins 2 usages — ouvre droit à la TVA à 5,5 %' }
    ],
    batteries: [
      { id: 'none', nom: 'Sans batterie', capaciteKwh: 0, prix: 0 },
      { id: 'b5', nom: 'Batterie 5 kWh', capaciteKwh: 5, prix: 3900 }
    ],
    offres: [
      { id: 'essentielle', nom: 'Essentielle', accroche: 'Le solaire au meilleur prix', panneauId: 'topcon425', onduleurId: 'string', batterieId: 'none', pilotageId: 'ems2', forfaitBase: 1900, prixParPanneau: 540, inclus: ['Pose et raccordement', 'Démarches administratives', 'Pilotage inclus → TVA 5,5 %'] },
      // `misEnAvant` : l'offre que l'installateur pousse. Elle passe en tête de
      // liste, porte un badge et est présélectionnée. C'est un réglage du
      // catalogue, pas une décision du simulateur : chaque installateur sait
      // seul laquelle de ses offres se vend le mieux ou lui rapporte le plus.
      { id: 'confort', nom: 'Confort', accroche: 'Micro-onduleurs haut rendement', misEnAvant: true, badge: 'Le plus choisi', panneauId: 'topcon500', onduleurId: 'micro', batterieId: 'none', pilotageId: 'ems2', forfaitBase: 2200, prixParPanneau: 640, inclus: ['Pose et raccordement', 'Suivi par panneau', 'Pilotage inclus → TVA 5,5 %'] }
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
      zones: [],              // pans de toiture cumulables : { points: [latlng], tilt, azimuth }
      activeZone: -1,         // pan en cours de réglage
      obstacles: [],          // [[latlng…]] — zones à éviter, communes à tous les pans
      limit: null,            // [latlng…] — « ma maison » : aucun panneau posé au-delà
                              // (indispensable en lotissement mitoyen : la BD TOPO
                              //  renvoie une seule emprise pour toute la rangée)
      trees: [],              // arbres pour visualiser l'ombrage : { lat, lng, h (m) }
      drawMode: null,         // 'roof' | 'obstacle' | 'tree' | 'limit' | null
      landscape: false,
      excluded: {},           // panneaux retirés à la main, clé "zone:row:col"
      sizingMode: 'auto',     // 'auto' = dimensionnement conseillé | 'full' = tout le toit | 'manuel'
      autoExcluded: {},       // panneaux écartés par le dimensionnement conseillé
      sizing: null,           // { n, total, kwc, sousSeuilTva } — explication affichée au visiteur
      offerId: null,
      panelId: null,
      inverterId: null,
      batteryId: null,
      pilotageId: null,       // gestionnaire d'énergie (EMS) — condition de la TVA à 5,5 %
      residentiel: true,      // local à usage d'habitation — condition de la TVA à 5,5 %
      consumptionKwh: 4500,
      panels: [],             // résultat du calepinage : { zone, corners, row, col }
      origin: null
    };
    this.draftPoints = [];
    this._gsAdded = {};       // pans Google Solar déjà ajoutés (par index de segment)
    // Cache PVGIS : { cache, pending, failed } indexés par (lat, lng, pente, aspect, pertes)
    this._pvgis = { cache: {}, pending: {}, failed: {}, echecs: 0, off: !this.cfg.pvgisProxyUrl };
    this.treeHeight = 8;      // taille de l'arbre à planter (5 / 8 / 12 m)
    // Adaptation tactile / mobile : vocabulaire, seuils et défilements
    this.isTouch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
    this.tap = this.isTouch ? 'Touchez' : 'Cliquez';
    this.tapLow = this.isTouch ? 'touchez' : 'cliquez';

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
    if (!catalog.pilotage || !catalog.pilotage.length) {
      // Catalogue sans section pilotage : on en crée une pour que la condition EMS
      // de la TVA à 5,5 % reste explicable au visiteur.
      catalog.pilotage = [{ id: 'none', nom: 'Sans pilotage', ems: false, prix: 0, gainAutoconsommation: 0 }];
    }
    // L'offre présélectionnée est celle mise en avant par l'installateur ; à
    // défaut, la première du catalogue. Un visiteur qui ne touche à rien repart
    // avec l'offre que l'installateur veut vendre.
    var first = catalog.offres.filter(function (o) { return o.misEnAvant; })[0] || catalog.offres[0];
    this.state.offerId = first.id;
    this.state.panelId = first.panneauId;
    this.state.inverterId = first.onduleurId;
    this.state.batteryId = first.batterieId || 'none';
    this.state.pilotageId = first.pilotageId || catalog.pilotage[0].id;
    this._renderBrand();
    this._renderOffers();
    this._renderCtaBar();
    this._refresh();
  };

  /* ---------------- Génération de leads : contact permanent ----------------
   * À tout moment du parcours, le visiteur peut décrocher : appel direct,
   * WhatsApp, rappel sous 30 min (jours ouvrés) ou visite technique avec
   * prise de vue drone. Chaque demande part avec le résumé de sa simulation. */

  Simulator.prototype._isOpenNow = function () {
    var h = (this.catalog.brand || {}).horaires || { debut: 9, fin: 18, jours: [1, 2, 3, 4, 5] };
    var now = new Date();
    return (h.jours || [1, 2, 3, 4, 5]).indexOf(now.getDay()) !== -1 &&
      now.getHours() >= (h.debut != null ? h.debut : 9) &&
      now.getHours() < (h.fin != null ? h.fin : 18);
  };

  /* ---------------- Marque du widget (marque blanche) ----------------
   * Nom, accroche et logo viennent du catalogue : le même code sert le
   * simulateur de n'importe quel installateur. */
  // Nom commercial de l'installateur hôte ('' s'il n'est pas configuré).
  // Tout texte vu par le visiteur passe par ici : aucune marque en dur.
  Simulator.prototype._brandName = function () {
    return String((this.catalog.brand || {}).name || '').trim();
  };
  Simulator.prototype._brandSuffix = function () {
    var n = this._brandName();
    return n ? ' ' + n : '';
  };

  Simulator.prototype._renderBrand = function () {
    var brand = this.catalog.brand || {};
    var nom = this._brandName();
    if (this.logoText) this.logoText.textContent = nom || BRAND_PLACEHOLDER;
    if (this.headerSub && brand.accroche) this.headerSub.textContent = brand.accroche;
    if (this.offerTitle) this.offerTitle.textContent = '3. Votre offre' + this._brandSuffix();
    if (this.footerBrand) {
      this.footerBrand.innerHTML = '';
      if (nom) {
        this.footerBrand.appendChild(document.createTextNode('Simulateur '));
        this.footerBrand.appendChild(el('b', { text: nom }));
        this.footerBrand.appendChild(document.createTextNode(' — estimation non contractuelle'));
      } else {
        this.footerBrand.textContent = 'Simulateur photovoltaïque — estimation non contractuelle';
      }
    }
    if (!this.logoBox) return;
    this.logoBox.innerHTML = '';
    if (brand.logoUrl) {
      this.logoBox.appendChild(el('img', {
        class: 'rdfsim-logo-img', src: brand.logoUrl, alt: brand.name || 'logo'
      }));
    } else if (brand.afficherSoleil !== false) {
      this.logoBox.appendChild(el('span', { class: 'rdfsim-logo-sun' }));
    }
  };

  Simulator.prototype._renderCtaBar = function () {
    var self = this;
    var brand = this.catalog.brand || {};
    if (!this.ctaBar) return;
    this.ctaBar.innerHTML = '';

    // Téléphone dans l'en-tête
    if (this.headerCta) {
      this.headerCta.innerHTML = '';
      if (brand.phone) {
        this.headerCta.appendChild(el('a', {
          class: 'rdfsim-header-phone', href: 'tel:' + brand.phone.replace(/[^+\d]/g, ''),
          html: '📞 <b>' + brand.phone + '</b><small>appel gratuit — conseil immédiat</small>'
        }));
      }
    }

    var open = this._isOpenNow();
    this.ctaBar.appendChild(el('span', { class: 'rdfsim-cta-status' + (open ? ' is-open' : '') }, [
      el('span', { class: 'rdfsim-cta-dot' }),
      el('span', {
        text: open
          ? 'Conseillers disponibles — ' + (brand.promesseRappel || 'rappel sous 30 min')
          : 'Fermé actuellement — rappel dès l’ouverture (' + ((brand.horaires || {}).libelle || 'jours ouvrés') + ')'
      })
    ]));

    var btns = el('div', { class: 'rdfsim-cta-btns' });
    if (brand.phone) {
      btns.appendChild(el('a', {
        class: 'rdfsim-cta-btn rdfsim-cta-phone', href: 'tel:' + brand.phone.replace(/[^+\d]/g, ''),
        html: '📞 <b>' + brand.phone + '</b>'
      }));
    }
    if (brand.whatsapp) {
      btns.appendChild(el('a', {
        class: 'rdfsim-cta-btn rdfsim-cta-wa', target: '_blank', rel: 'noopener',
        href: 'https://wa.me/' + String(brand.whatsapp).replace(/[^\d]/g, ''),
        text: '💬 WhatsApp',
        onclick: function (ev) {
          // Le message part avec le contexte de la simulation en cours
          ev.currentTarget.href = 'https://wa.me/' + String(brand.whatsapp).replace(/[^\d]/g, '') +
            '?text=' + encodeURIComponent(
              (self._brandName() ? 'Bonjour ' + self._brandName() + ' ! ' : 'Bonjour ! ') + self._leadContext());
        }
      }));
    }
    btns.appendChild(el('button', {
      class: 'rdfsim-cta-btn rdfsim-cta-call', type: 'button',
      text: '⏱ Être rappelé',
      onclick: function () { self._openLeadModal('rappel'); }
    }));
    btns.appendChild(el('button', {
      class: 'rdfsim-cta-btn rdfsim-cta-drone', type: 'button',
      text: '🚁 Visite technique drone',
      title: 'Un technicien se déplace et photographie votre toiture par drone — gratuit et sans engagement',
      onclick: function () {
        if (brand.droneBookingUrl) window.open(brand.droneBookingUrl, '_blank', 'noopener');
        else self._openLeadModal('drone');
      }
    }));
    this.ctaBar.appendChild(btns);
  };

  // Une ligne de contexte sur la simulation en cours, jointe à chaque prise de contact
  Simulator.prototype._leadContext = function () {
    var s = this.state;
    var c = this._compute();
    var parts = [];
    if (s.address) parts.push('Projet : ' + s.address.label);
    if (c.n) {
      parts.push(c.n + ' panneaux (' + fmt(c.kwc, 1) + ' kWc) sur ' + c.zones.length + ' pan(s), ~' +
        fmt(c.prod.annualKwh) + ' kWh/an, offre ' + c.offer.nom);
    }
    return parts.length ? parts.join(' — ') : 'Je souhaite étudier un projet photovoltaïque.';
  };

  // Référence unique du lead — reprise dans le CRM et dans l'accusé au visiteur
  Simulator.prototype._leadReference = function () {
    var d = new Date();
    var stamp = d.toISOString().slice(0, 10).replace(/-/g, '') + '-' +
      String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
    return 'SIM-' + stamp + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  };

  /**
   * Preuve de consentement au démarchage téléphonique, à conserver 3 ans.
   * Tout ce qui permet de démontrer QUI a consenti, À QUOI, QUAND et OÙ.
   */
  Simulator.prototype._consentProof = function (texte, vue) {
    var brand = this.catalog.brand || {};
    vue = vue || {};
    return {
      donne: true,
      finalite: 'Être recontacté par téléphone au sujet d’un projet photovoltaïque',
      // Texte intégral accepté — c'est lui qui fait foi
      texte: texte,
      // Ce que le visiteur avait sous les yeux, et s'il a déplié les détails
      texteAffiche: vue.affiche || texte,
      texteDetail: vue.detail || '',
      detailsOuverts: !!vue.detailsOuverts,
      version: brand.consentementVersion || '1',
      horodatage: new Date().toISOString(),
      fuseau: (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || '',
      dureeValiditeMois: 12,
      page: typeof location !== 'undefined' ? location.href : '',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      baseLegale: 'Article L. 223-1 du code de la consommation (version en vigueur au 11 août 2026)'
    };
  };

  // Données chiffrées de la simulation, jointes au lead pour que le conseiller
  // rappelle en connaissant déjà le projet (et le taux de TVA applicable).
  Simulator.prototype._leadSimulation = function (computed) {
    var c = computed || this._compute();
    var s = this.state;
    return {
      adresse: s.address ? s.address.label : null,
      lat: s.origin ? s.origin.lat : (s.address ? s.address.lat : null),
      lng: s.origin ? s.origin.lng : (s.address ? s.address.lng : null),
      nbPans: c.zones.length,
      nbPanneaux: c.n,
      kwc: Math.round(c.kwc * 100) / 100,
      productionKwhAn: Math.round(c.prod.annualKwh),
      consommationKwhAn: s.consumptionKwh,
      tauxAutoconsommation: Math.round(c.fin.selfConsumptionRate * 100),
      economiesAn: Math.round(c.fin.annualSavings),
      offre: c.offer.id,
      panneau: c.panel.id,
      onduleur: c.inverter.id,
      batterie: c.battery.id,
      pilotage: c.pilotage ? c.pilotage.id : null,
      coutHT: Math.round(c.cost.ht),
      tauxTva: c.cost.rate,
      coutTTC: Math.round(c.cost.ttc),
      tvaReduiteEligible: c.vat.eligible,
      conditionsTvaManquantes: c.vat.manquantes.map(function (m) { return m.id; }),
      retourAns: isFinite(c.fin.paybackYears) ? Math.round(c.fin.paybackYears * 10) / 10 : null,
      ombrage: c.shadingLevel,
      sourceProduction: c.prod.source,
      maisonDelimitee: !!(this.state.limit && this.state.limit.length >= 3),
      surfaceToitM2: Math.round(c.roofArea),
      bareme: (this.catalog.tarifs || {}).dateMaj || null
    };
  };

  /**
   * Formulaire de prise de contact — trois usages : rappel, visite drone, devis.
   *
   * ⚖ Conformité : depuis le 11 août 2026 (loi du 30 juin 2025 réécrivant
   * l'article L. 223-1 du code de la consommation), aucun consommateur ne peut
   * être appelé sans avoir donné au préalable un consentement libre, éclairé,
   * spécifique et révocable — le silence vaut refus, et Bloctel a disparu.
   * Le consentement doit être PROUVÉ : on transmet donc au CRM le texte exact
   * accepté, sa version, l'horodatage, la page d'origine et une référence.
   * Sans case cochée, l'envoi est bloqué : mieux vaut pas de lead qu'un lead
   * inexploitable.
   */
  Simulator.prototype._openLeadModal = function (type, computed) {
    var self = this;
    var brand = this.catalog.brand || {};
    var open = this._isOpenNow();
    if (this._modal) this._modal.remove();

    var isDrone = type === 'drone';
    var isQuote = type === 'devis';
    var title = isDrone ? '🚁 Réserver ma visite technique'
      : (isQuote ? '☀ Recevoir mon étude et mon devis' : '⏱ Être rappelé par un conseiller');
    var promise = isDrone
      ? 'Un technicien' + this._brandSuffix() + ' se déplace, vérifie la toiture et réalise des prises de vue par drone. Gratuit et sans engagement.'
      : (isQuote
        ? 'Vous recevez votre étude personnalisée (production, économies, TVA applicable) et un devis détaillé, gratuits et sans engagement.'
        : (open
          ? 'Un conseiller vous rappelle sous 30 minutes.'
          : 'Nous sommes actuellement fermés (' + ((brand.horaires || {}).libelle || 'jours ouvrés') + ') : un conseiller vous rappelle dès l’ouverture.'));

    var nameInput = el('input', { class: 'rdfsim-input', type: 'text', placeholder: 'Votre nom', autocomplete: 'name' });
    var phoneInput = el('input', { class: 'rdfsim-input', type: 'tel', placeholder: '06 12 34 56 78', autocomplete: 'tel' });
    var mailInput = isQuote
      ? el('input', { class: 'rdfsim-input', type: 'email', placeholder: 'vous@exemple.fr', autocomplete: 'email' })
      : null;
    var slotSel = null;
    if (isDrone) {
      slotSel = el('select', { class: 'rdfsim-input' });
      ['Au plus tôt', 'Plutôt le matin', 'Plutôt l’après-midi', 'Plutôt le samedi'].forEach(function (t) {
        slotSel.appendChild(el('option', { text: t, value: t }));
      });
    }
    var errBox = el('p', { class: 'rdfsim-muted rdfsim-form-error', style: 'display:none' });

    // Consentement au démarchage téléphonique (art. L. 223-1, en vigueur au 11/08/2026).
    //
    // Le consentement doit être ÉCLAIRÉ : la ligne cochée nomme donc à elle seule
    // qui appelle, par quel canal et pour quoi — le strict nécessaire. Le reste
    // (durée, retrait, sort des données, droits) est disponible d'un tap sous
    // « Détails », replié par défaut pour ne pas noyer le formulaire.
    // La PREUVE transmise au CRM contient l'intégralité du texte, pas seulement
    // la ligne visible : c'est elle qui rend le consentement opposable.
    // Un consentement qui nomme la mauvaise entreprise ne vaut rien : le visiteur
    // n'a pas accepté d'être appelé par elle. On ne se rabat donc JAMAIS sur le nom
    // de l'éditeur — à défaut de marque configurée, la formulation reste générique
    // (et la collecte est de toute façon fermée, faute de destination).
    var marque = this._brandName() || 'l’entreprise';
    var consentCourt = 'J’accepte d’être appelé par ' + marque + ' au sujet de mon projet solaire.';
    var consentDetail = 'Ce consentement ne vaut que pour ce projet, reste valable 1 an et peut être ' +
      'retiré à tout moment sur simple demande. Vos coordonnées servent uniquement à vous recontacter ' +
      'à ce sujet : elles ne sont ni revendues ni cédées. Vous disposez d’un droit d’accès, de ' +
      'rectification et d’effacement' + (brand.contactEmail ? ' (' + brand.contactEmail + ')' : '') + '.';
    var consentText = consentCourt + ' ' + consentDetail;

    var consentCb = el('input', { type: 'checkbox' });
    var consentDetails = el('details', { class: 'rdfsim-consent-more' }, [
      el('summary', { text: 'Détails, durée et vos droits' }),
      el('p', { text: consentDetail })
    ]);
    if (brand.politiqueConfidentialiteUrl) {
      consentDetails.appendChild(el('p', {}, [
        el('a', {
          href: brand.politiqueConfidentialiteUrl, target: '_blank', rel: 'noopener',
          text: 'Politique de confidentialité'
        })
      ]));
    }
    // Le <details> est hors du <label> : ouvrir les détails ne doit pas cocher la case
    var consentLabel = el('div', { class: 'rdfsim-consent' }, [
      el('label', { class: 'rdfsim-check' }, [consentCb, el('span', { text: consentCourt })]),
      consentDetails
    ]);

    var card = el('div', { class: 'rdfsim-modal-card' }, [
      el('button', { class: 'rdfsim-modal-close', type: 'button', text: '✕', onclick: function () { self._closeModal(); } }),
      el('h3', { text: title }),
      el('p', { class: 'rdfsim-muted', text: promise }),
      el('label', { class: 'rdfsim-label', text: 'Nom' }), nameInput,
      el('label', { class: 'rdfsim-label', text: 'Téléphone' }), phoneInput,
      isQuote ? el('label', { class: 'rdfsim-label', text: 'E-mail (pour recevoir l’étude)' }) : null,
      mailInput,
      isDrone ? el('label', { class: 'rdfsim-label', text: 'Créneau souhaité' }) : null,
      slotSel,
      consentLabel,
      errBox,
      el('div', { class: 'rdfsim-btn-row' }, [
        el('button', {
          class: 'rdfsim-btn rdfsim-btn-primary', type: 'button',
          text: isDrone ? 'Réserver ma visite' : (isQuote ? 'Recevoir mon étude' : 'Me faire rappeler'),
          onclick: function () {
            if (nameInput.value.trim().length < 2) {
              errBox.textContent = 'Merci d’indiquer votre nom.';
              errBox.style.display = 'block';
              return;
            }
            var tel = phoneInput.value.replace(/[^+\d]/g, '');
            if (tel.length < 9) {
              errBox.textContent = 'Merci d’indiquer un numéro de téléphone valide.';
              errBox.style.display = 'block';
              return;
            }
            if (mailInput && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mailInput.value.trim())) {
              errBox.textContent = 'Merci d’indiquer une adresse e-mail valide pour recevoir votre étude.';
              errBox.style.display = 'block';
              return;
            }
            if (!consentCb.checked) {
              errBox.textContent = 'La loi nous interdit de vous appeler sans votre accord : merci de cocher la case ci-dessus.';
              errBox.style.display = 'block';
              consentLabel.classList.add('is-required');
              return;
            }
            self._submitLead({
              type: isDrone ? 'visite_technique_drone' : (isQuote ? 'demande_devis' : 'rappel_30min'),
              reference: self._leadReference(),
              nom: nameInput.value.trim(),
              telephone: phoneInput.value.trim(),
              email: mailInput ? mailInput.value.trim() : '',
              creneau: slotSel ? slotSel.value : (open ? 'sous 30 min' : 'dès l’ouverture'),
              contexte: self._leadContext(),
              simulation: self._leadSimulation(computed),
              consentement: self._consentProof(consentText, {
                affiche: consentCourt,
                detail: consentDetail,
                detailsOuverts: !!consentDetails.open
              })
            }, card, isDrone);
          }
        })
      ]),
    ]);

    this._modal = el('div', {
      class: 'rdfsim-modal',
      onclick: function (ev) { if (ev.target === self._modal) self._closeModal(); }
    }, [card]);
    this.root.appendChild(this._modal);
    nameInput.focus();
  };

  Simulator.prototype._closeModal = function () {
    if (this._modal) { this._modal.remove(); this._modal = null; }
  };

  Simulator.prototype._submitLead = function (lead, card, isDrone) {
    var self = this;
    var brand = this.catalog.brand || {};
    var isQuote = lead.type === 'demande_devis';
    var done = function () {
      card.innerHTML = '';
      card.appendChild(el('h3', { text: '✅ C’est noté !' }));
      card.appendChild(el('p', {
        class: 'rdfsim-muted',
        text: isDrone
          ? 'Votre demande de visite technique est enregistrée : nous vous appelons pour fixer le rendez-vous et organiser la prise de vue par drone.'
          : (isQuote
            ? 'Votre étude personnalisée part vers un conseiller' + self._brandSuffix() + ' : vous la recevez, avec votre devis, sous 24 h ouvrées.'
            : (self._isOpenNow()
              ? 'Un conseiller' + self._brandSuffix() + ' vous rappelle sous 30 minutes.'
              : 'Un conseiller' + self._brandSuffix() + ' vous rappelle dès l’ouverture.'))
      }));
      card.appendChild(el('p', { class: 'rdfsim-disclaimer', text: 'Référence de votre demande : ' + lead.reference }));
      card.appendChild(el('div', { class: 'rdfsim-btn-row' }, [
        el('button', { class: 'rdfsim-btn rdfsim-btn-ghost', type: 'button', text: 'Fermer', onclick: function () { self._closeModal(); } })
      ]));
    };
    // Repli e-mail : le lead ne doit jamais se perdre — et la preuve de
    // consentement doit voyager avec lui, sinon le rappel est illicite.
    // Sans destination configurée, on le dit au visiteur plutôt que d'ouvrir un
    // « mailto: » sans destinataire — et surtout jamais vers l'adresse de l'éditeur.
    var failed = function () {
      card.innerHTML = '';
      card.appendChild(el('h3', { text: '⚠ Demande non transmise' }));
      card.appendChild(el('p', {
        class: 'rdfsim-muted',
        text: brand.phone
          ? 'Le formulaire n’est pas disponible pour le moment. Appelez-nous directement au ' + brand.phone + '.'
          : 'Le formulaire n’est pas disponible pour le moment. Merci de nous contacter directement depuis le site.'
      }));
      card.appendChild(el('div', { class: 'rdfsim-btn-row' }, [
        el('button', { class: 'rdfsim-btn rdfsim-btn-ghost', type: 'button', text: 'Fermer', onclick: function () { self._closeModal(); } })
      ]));
    };

    var mailFallback = function () {
      if (!brand.contactEmail) { failed(); return; }
      var cons = lead.consentement || {};
      window.location.href = 'mailto:' + (brand.contactEmail || '') +
        '?subject=' + encodeURIComponent('[LEAD ' + lead.reference + '] ' +
          (isDrone ? 'Visite technique drone' : (isQuote ? 'Demande de devis' : 'Rappel sous 30 min')) +
          ' — ' + (lead.nom || 'visiteur')) +
        '&body=' + encodeURIComponent(
          'Nom : ' + lead.nom + '\nTéléphone : ' + lead.telephone +
          (lead.email ? '\nE-mail : ' + lead.email : '') +
          '\nCréneau : ' + lead.creneau +
          '\n\n' + lead.contexte +
          '\n\n--- Consentement au démarchage téléphonique ---\n' +
          'Accepté le ' + cons.horodatage + ' (' + cons.fuseau + ')\n' +
          'Texte accepté (version ' + cons.version + ') : ' + cons.texte + '\n' +
          'Page : ' + cons.page + '\n' + cons.baseLegale +
          '\n\n--- Simulation ---\n' + JSON.stringify(lead.simulation, null, 2));
      done();
    };
    if (brand.devisEndpoint) {
      fetch(brand.devisEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lead)
      }).then(function (r) {
        if (!r || !r.ok) throw new Error(r && r.status);
        done();
      }).catch(mailFallback);
    } else {
      mailFallback();
    }
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
  Simulator.prototype._pilotage = function () {
    var id = this.state.pilotageId;
    var list = this.catalog.pilotage || [];
    return list.filter(function (p) { return p.id === id; })[0] || list[0] ||
      { id: 'none', nom: 'Sans pilotage', ems: false, prix: 0, gainAutoconsommation: 0 };
  };
  Simulator.prototype._zone = function () {
    return this.state.zones[this.state.activeZone] || null;
  };
  // Écran étroit (mobile / tablette portrait) : la mise en page passe en colonne
  Simulator.prototype._isNarrow = function () {
    return typeof matchMedia !== 'undefined' && matchMedia('(max-width: 900px)').matches;
  };
  Simulator.prototype._scrollTo = function (node) {
    if (this._isNarrow() && node && node.scrollIntoView) {
      node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  /* ---------------- Construction du DOM ---------------- */
  Simulator.prototype._buildDom = function () {
    var self = this;
    this.root.classList.add('rdfsim');
    this.root.innerHTML = '';

    // En-tête (marque, logo et téléphone sont complétés au chargement du catalogue)
    this.headerCta = el('div', { class: 'rdfsim-header-cta' });
    this.logoSun = el('span', { class: 'rdfsim-logo-sun' });
    this.logoBox = el('span', { class: 'rdfsim-logo-box' }, [this.logoSun]);
    this.logoText = el('div', { class: 'rdfsim-logo', text: BRAND_PLACEHOLDER });
    this.headerSub = el('div', { class: 'rdfsim-header-sub', text: 'Visualisez votre future installation photovoltaïque sur votre toit, en conditions réelles' });
    this.root.appendChild(el('div', { class: 'rdfsim-header' }, [
      this.logoBox,
      el('div', { style: 'flex:1' }, [
        this.logoText,
        this.headerSub
      ]),
      this.headerCta
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

    // Corps.
    //
    // Le panneau latéral est scindé en deux : un contenu qui défile, et une
    // barre d'action qui ne bouge jamais. Auparavant le bouton « suite » était
    // le dernier élément d'un panneau de 950 à 1 300 px : sur un écran de
    // 800 px, il tombait 225 à 558 px sous le pli, à chaque étape. Le visiteur
    // devait chercher comment continuer — mesuré, et c'est la première cause
    // d'abandon d'un parcours en plusieurs écrans.
    this.sideScroll = el('div', { class: 'rdfsim-side-scroll' });
    this.sideAction = el('div', { class: 'rdfsim-side-action' });
    this.side = el('div', { class: 'rdfsim-side' }, [this.sideScroll, this.sideAction]);
    this.mapArea = el('div', { class: 'rdfsim-maparea' });
    this.mapDiv = el('div', { class: 'rdfsim-map' });
    this.mapHint = el('div', { class: 'rdfsim-map-hint', text: 'Recherchez votre adresse pour commencer' });
    this.mapTools = el('div', { class: 'rdfsim-map-tools' });
    this.mapArea.appendChild(this.mapDiv);
    this.mapArea.appendChild(this.mapHint);
    this.mapArea.appendChild(this.mapTools);
    this.root.appendChild(el('div', { class: 'rdfsim-body' }, [this.side, this.mapArea]));

    // Barre de contact permanente : le visiteur peut décrocher à tout moment du parcours
    this.ctaBar = el('div', { class: 'rdfsim-cta-bar' });
    this.root.appendChild(this.ctaBar);

    // Pied
    this.footerBrand = el('span', {});
    this.root.appendChild(el('div', { class: 'rdfsim-footer' }, [
      this.footerBrand,
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

    // Géolocalisation : sur mobile, le visiteur simule le plus souvent depuis
    // chez lui — un bouton évite toute la saisie d'adresse.
    this.geoMsg = el('p', { class: 'rdfsim-muted rdfsim-geo-msg', style: 'display:none' });
    var geoBtn = (typeof navigator !== 'undefined' && navigator.geolocation)
      ? el('button', {
        class: 'rdfsim-btn rdfsim-btn-geo', type: 'button', text: '📍 Je suis chez moi — me localiser',
        title: 'Centre la carte sur votre position (votre navigateur vous demandera l’autorisation)',
        onclick: function (ev) { self._useMyPosition(ev.currentTarget); }
      })
      : null;
    this.geoBtn = geoBtn;

    this.panels[1] = el('div', {}, [
      el('div', { class: 'rdfsim-card' }, [
        el('h3', { text: '1. Où se situe votre projet ?' }),
        el('p', { class: 'rdfsim-muted', text: 'Particulier ou entreprise : saisissez l’adresse du bâtiment — ou laissez-vous localiser si vous êtes sur place. La vue satellite haute résolution de votre toit s’affiche aussitôt.' }),
        el('div', { class: 'rdfsim-ac' }, [acInput, acList]),
        geoBtn ? el('div', { class: 'rdfsim-btn-row' }, [geoBtn]) : null,
        this.geoMsg,
        el('div', { class: 'rdfsim-btn-row' }, [
          el('button', {
            class: 'rdfsim-btn rdfsim-btn-ghost', type: 'button', text: '🗺 Sans adresse : placer la carte moi-même',
            title: 'Naviguez sur la carte jusqu’à votre toit, sans passer par la recherche d’adresse',
            onclick: function () {
              var c = self.map.getCenter();
              self.state.address = { label: 'Position choisie sur la carte', lat: c.lat, lng: c.lng, manual: true };
              self.mapHint.textContent = 'Naviguez et zoomez jusqu’à votre toit (molette / boutons +), puis dessinez';
              self._refresh();
              self._goStep(2);
            }
          })
        ])
      ]),
      el('div', { class: 'rdfsim-card' }, [
        el('h4', { text: 'Comment ça marche ?' }),
        el('p', { class: 'rdfsim-muted', html: '<b>1.</b> Votre adresse — ou votre position en un tap → vue aérienne réelle de votre toit<br><b>2.</b> Dessinez la toiture, l’outil place les panneaux automatiquement<br><b>3.</b> Choisissez votre offre et vos équipements<br><b>4.</b> Production, économies et demande de devis en 1 clic' })
      ])
    ]);

    /* --- Étape 2 : toiture (multi-pans) --- */
    this.tiltVal = el('span', { class: 'rdfsim-value', text: '30°' });
    var tiltRange = el('input', { type: 'range', min: '0', max: '60', step: '1', value: '30' });
    tiltRange.addEventListener('input', function () {
      var z = self._zone();
      if (!z) return;
      z.tilt = +tiltRange.value;
      self.tiltVal.textContent = tiltRange.value + '°';
      self._relayout();
    });
    this.tiltRange = tiltRange;

    this.azVal = el('span', { class: 'rdfsim-value', text: '180° (S)' });
    var azRange = el('input', { type: 'range', min: '0', max: '359', step: '1', value: '180' });
    azRange.addEventListener('input', function () {
      var z = self._zone();
      if (!z) return;
      z.azimuth = +azRange.value;
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
    this.sizingBox = el('div', {});   // bandeau « dimensionnement conseillé »
    this.limitBox = el('div', {});    // bandeau « ma maison » (habitat mitoyen)
    this.gsBox = el('div', {});    // détection Google Solar (si clé configurée)
    this.zonesBox = el('div', {}); // liste des pans dessinés

    this.panels[2] = el('div', {}, [
      el('div', { class: 'rdfsim-card' }, [
        el('h3', { text: '2. Votre toiture, pan par pan' }),
        // Une consigne, pas un mode d'emploi. Huit lignes d'explications avant
        // la première action, c'est ce qui faisait juger le parcours
        // « compliqué » : le détail reste disponible, replié, pour qui le
        // cherche — et il n'encombre plus ceux qui n'en ont pas besoin.
        el('p', { class: 'rdfsim-consigne', html: this.tap + ' <b>votre bâtiment</b> sur la carte. ' +
          'Vous pourrez ajouter d’autres pans ensuite.' }),
        el('details', { class: 'rdfsim-aide' }, [
          el('summary', { text: 'Toit complexe, maison mitoyenne, dessin à la main ?' }),
          el('p', {
            class: 'rdfsim-muted',
            html: '<b>Dessiner un pan</b> : ' + this.tap.toLowerCase() + ' les angles du pan, puis <b>« ✓ Terminer »</b>. ' +
              'Recommencez pour cumuler d’autres pans ou bâtiments.<br>' +
              '<b>Maison mitoyenne ou en lotissement</b> : utilisez <b>« ✂️ Délimiter ma maison »</b> — le cadastre ' +
              'décrit une rangée accolée comme un seul bâtiment.<br>' +
              this.tap + ' un panneau posé pour le retirer ou le remettre.' +
              (this.isTouch ? '' : '<br><span style="white-space:nowrap">Clic droit</span> : annuler le dernier point · Échap : quitter le dessin.')
          })
        ]),
        this.gsBox,
        el('label', { class: 'rdfsim-label', text: 'Vos pans de toiture' }),
        this.zonesBox,
        el('div', { class: 'rdfsim-btn-row' }, [
          el('button', {
            class: 'rdfsim-btn rdfsim-btn-ghost', type: 'button', text: '➕ Dessiner un pan',
            onclick: function () { self._setDrawMode('roof'); }
          }),
          el('button', {
            class: 'rdfsim-btn rdfsim-btn-ghost', type: 'button', text: '🏠 Contour du bâtiment',
            title: 'Récupère automatiquement le contour exact du bâtiment (BD TOPO de l’IGN, gratuit)',
            onclick: function () { self._fetchBuildingFootprint(); }
          }),
          el('button', {
            class: 'rdfsim-btn rdfsim-btn-ghost', type: 'button', text: '✂️ Délimiter ma maison',
            title: 'Maison mitoyenne, en bande ou en lotissement : le cadastre ne sépare pas les logements accolés — tracez le vôtre',
            onclick: function () { self._setDrawMode('limit'); }
          })
        ]),
        this.limitBox
      ]),
      this.reglagesCard = el('div', { class: 'rdfsim-card' }, [
        el('h4', { text: 'Réglages du pan sélectionné' }),
        el('label', { class: 'rdfsim-label' }, [document.createTextNode('Inclinaison : '), this.tiltVal]),
        tiltRange,
        el('p', { class: 'rdfsim-muted', style: 'margin:4px 0 0', text: 'Toit plat ≈ 5–10° (avec bacs lestés) · toit standard ≈ 30° · toit pentu ≈ 45°' }),
        el('label', { class: 'rdfsim-label' }, [document.createTextNode('Orientation (azimut) : '), this.azVal]),
        azRange,
        el('div', { class: 'rdfsim-btn-row' }, [
          el('button', {
            class: 'rdfsim-btn rdfsim-btn-ghost', type: 'button', text: '⟳ Aligner sur le pan',
            title: 'Aligne les panneaux sur l’arête la plus longue du pan sélectionné',
            onclick: function () { self._autoAzimuth(); }
          })
        ]),
        el('label', { class: 'rdfsim-label', text: 'Pose des panneaux' }),
        el('div', { class: 'rdfsim-seg' }, [segPortrait, segLandscape]),
        this.miniStats,
        this.sizingBox
      ])
    ]);

    /* --- Étape 3 : offre & composants --- */
    this.offersBox = el('div', {});
    this.componentsBox = el('div', {});
    var consInput = el('input', { class: 'rdfsim-input', type: 'number', min: '500', step: '100', value: String(this.state.consumptionKwh) });
    // La consommation pilote le dimensionnement conseillé : on rafraîchit les
    // chiffres immédiatement, et on recalcule le calepinage une fois la saisie posée.
    var resizeSoon = debounce(function () { self._refreshSizing(); }, 400);
    consInput.addEventListener('input', function () {
      self.state.consumptionKwh = Math.max(0, +consInput.value || 0);
      self._refresh();
      resizeSoon();
    });

    this.offerTitle = el('h3', { text: '3. Votre offre' });
    this.panels[3] = el('div', {}, [
      el('div', { class: 'rdfsim-card' }, [
        this.offerTitle,
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
        el('p', { class: 'rdfsim-muted', style: 'margin:6px 0 0', text: 'Repère : ~2 500 kWh pour un petit logement, ~4 500 kWh pour une maison, ~8 000+ kWh avec chauffage électrique ou véhicule électrique. Ce chiffre figure sur votre facture.' })
      ])
    ]);

    /* --- Étape 4 : résultats --- */
    this.resultsBox = el('div', {});
    this.panels[4] = this.resultsBox;

    this._buildStepActions();
  };

  /**
   * Les barres d'action, une par étape.
   *
   * Deux choses y figurent, et cet ordre compte : à gauche ce que le visiteur
   * vient d'obtenir (« 24 panneaux · 10,2 kWc »), à droite ce qu'il peut faire
   * ensuite. Un bouton seul ne dit pas où l'on en est ; un chiffre qui bouge à
   * chaque réglage donne le sentiment d'avancer, et c'est ce sentiment qui fait
   * aller au bout d'un parcours en quatre écrans.
   */
  Simulator.prototype._buildStepActions = function () {
    var self = this;
    this.actions = {};
    this.actionResume = {};

    function barre(n, libelle, onclick, options) {
      var o = options || {};
      var resume = el('span', { class: 'rdfsim-action-resume' });
      self.actionResume[n] = resume;
      var bouton = el('button', {
        class: 'rdfsim-btn rdfsim-btn-primary rdfsim-action-btn', type: 'button',
        text: libelle, onclick: onclick
      });
      self.actions[n] = el('div', { class: 'rdfsim-action' + (o.classe ? ' ' + o.classe : '') },
        [resume, bouton]);
      self.actions[n].__bouton = bouton;
      return self.actions[n];
    }

    barre(1, 'Continuer vers ma toiture →', function () { self._goStep(2); });
    barre(2, 'Choisir mon offre →', function () { self._goStep(3); });
    barre(3, 'Voir mes résultats →', function () { self._goStep(4); });
    barre(4, '📩 Recevoir mon étude et mon devis', function () { self._requestQuote(self._compute()); });
  };

  /**
   * Met à jour la barre : le résumé, et l'état du bouton.
   *
   * Le bouton est désactivé tant que l'étape n'est pas franchissable, avec la
   * raison affichée juste à côté. C'est plus honnête qu'un bouton qui semble
   * cliquable et renvoie un reproche après coup — et ça évite au visiteur de
   * chercher ce qu'il a oublié.
   */
  Simulator.prototype._refreshAction = function () {
    var n = this.state.step;
    var barre = this.actions && this.actions[n];
    if (!barre) return;
    var resume = this.actionResume[n];
    var bouton = barre.__bouton;
    var s = this.state;

    if (n === 1) {
      var ok1 = !!s.address;
      bouton.disabled = !ok1;
      resume.textContent = ok1 ? s.address.label : 'Saisissez votre adresse pour continuer';
      resume.className = 'rdfsim-action-resume' + (ok1 ? ' is-ok' : '');
    } else if (n === 2) {
      var ok2 = s.zones.length > 0;
      bouton.disabled = !ok2;
      if (!ok2) {
        resume.textContent = 'Sélectionnez ou dessinez votre toiture';
      } else {
        var c2 = this._compute();
        resume.textContent = c2.n + ' panneau' + (c2.n > 1 ? 'x' : '') +
          ' · ' + fmt(c2.kwc, 1) + ' kWc';
      }
      resume.className = 'rdfsim-action-resume' + (ok2 ? ' is-ok' : '');
    } else if (n === 3) {
      var c3 = this._compute();
      bouton.disabled = false;
      // Le prix figure dès l'étape du choix : comparer deux offres sans leur
      // coût, c'est demander de choisir à l'aveugle puis découvrir la note.
      resume.textContent = fmt(c3.kwc, 1) + ' kWc · ' + fmt(c3.prod.annualKwh) + ' kWh/an · ' +
        eur(c3.installCost) + ' TTC';
      resume.className = 'rdfsim-action-resume is-ok';
    } else if (n === 4) {
      var c4 = this._compute();
      // Un lead sans installation chiffrée ne vaut rien pour l'installateur :
      // il rappelle quelqu'un dont il ne sait rien. Mieux vaut renvoyer le
      // visiteur poser ses panneaux que capter une demande vide.
      var ok4 = c4.n > 0;
      bouton.disabled = !ok4;
      // Même chiffre de tête que la grille de résultats juste au-dessus : le
      // résumé ne doit pas mettre en avant autre chose que ce qu'on vient de lire.
      resume.textContent = ok4
        ? eur(c4.fin.annualSavings) + '/an estimés · retour en ' +
          (isFinite(c4.fin.paybackYears) ? fmt(c4.fin.paybackYears, 1) + ' ans' : '—')
        : 'Aucun panneau placé — revenez à l’étape « Votre toiture »';
      resume.className = 'rdfsim-action-resume' + (ok4 ? ' is-ok' : '');
    }
  };

  /* ---------------- Barre d'outils carte ---------------- */
  Simulator.prototype._buildMapTools = function () {
    var self = this;
    this.toolRoof = el('button', {
      class: 'rdfsim-tool', type: 'button', text: '➕ Ajouter un pan',
      onclick: function () { self._setDrawMode(self.state.drawMode === 'roof' ? null : 'roof'); }
    });
    this.toolObstacle = el('button', {
      class: 'rdfsim-tool', type: 'button', text: '⛔ Zone à éviter',
      title: 'Cheminée, velux, ombre portée…',
      onclick: function () { self._setDrawMode(self.state.drawMode === 'obstacle' ? null : 'obstacle'); }
    });
    this.toolLimit = el('button', {
      class: 'rdfsim-tool', type: 'button', text: '✂️ Ma maison',
      title: 'Maison mitoyenne ou en lotissement : délimitez votre logement dans le bâtiment',
      onclick: function () { self._setDrawMode(self.state.drawMode === 'limit' ? null : 'limit'); }
    });
    this.toolClear = el('button', {
      class: 'rdfsim-tool', type: 'button', text: '🗑 Tout effacer',
      onclick: function () { self._clearDrawing(); }
    });
    this.toolTree = el('button', {
      class: 'rdfsim-tool', type: 'button', text: '🌳 Arbre',
      title: 'Plantez les arbres voisins pour visualiser leur ombre sur les panneaux (vue 3D)',
      onclick: function () { self._setDrawMode(self.state.drawMode === 'tree' ? null : 'tree'); }
    });
    // Choix de la taille de l'arbre, affiché uniquement en mode plantation
    this.treeSizes = el('span', { class: 'rdfsim-tree-sizes', style: 'display:none' });
    [['5 m', 5], ['8 m', 8], ['12 m', 12]].forEach(function (t) {
      var b = el('button', {
        class: 'rdfsim-tool rdfsim-tool-size' + (t[1] === self.treeHeight ? ' is-on' : ''),
        type: 'button', text: t[0],
        onclick: function () {
          self.treeHeight = t[1];
          self.treeSizes.querySelectorAll('button').forEach(function (x) { x.classList.remove('is-on'); });
          b.classList.add('is-on');
        }
      });
      self.treeSizes.appendChild(b);
    });
    this.tool3d = el('button', {
      class: 'rdfsim-tool', type: 'button', text: '🧊 Vue 3D',
      title: 'Visualisez le bâtiment et les ombres en 3D',
      onclick: function () { self._open3d(); }
    });
    // Pendant un tracé : valider ou corriger sans viser le premier point (crucial au doigt)
    this.toolFinish = el('button', {
      class: 'rdfsim-tool rdfsim-tool-finish', type: 'button', text: '✓ Terminer',
      style: 'display:none',
      onclick: function () { self._closeCurrentShape(); }
    });
    this.toolUndo = el('button', {
      class: 'rdfsim-tool', type: 'button', text: '↩ Annuler',
      style: 'display:none',
      title: 'Retire le dernier point posé',
      onclick: function () {
        self.draftPoints.pop();
        self.layerDraft.clearLayers();
        if (self.draftPoints.length) self._drawDraft(self.draftPoints);
        self._updateDraftTools();
      }
    });
    this.mapTools.appendChild(this.toolFinish);
    this.mapTools.appendChild(this.toolUndo);
    this.mapTools.appendChild(this.toolRoof);
    this.mapTools.appendChild(this.toolLimit);
    this.mapTools.appendChild(this.toolObstacle);
    this.mapTools.appendChild(this.toolTree);
    this.mapTools.appendChild(this.treeSizes);
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

    this.layerBuildings = L.layerGroup().addTo(this.map); // bâtiments sélectionnables (sous les pans)
    this.layerRoof = L.layerGroup().addTo(this.map);
    this.layerPanels = L.layerGroup().addTo(this.map);
    this.layerTrees = L.layerGroup().addTo(this.map);
    this.layerDraft = L.layerGroup().addTo(this.map);
    this._usedBuildings = {}; // bâtiments déjà transformés en pans

    // Les contours de bâtiments suivent la carte (rafraîchissement différé)
    var refreshBuildings = debounce(function () { self._refreshBuildings(); }, 450);
    this.map.on('moveend', refreshBuildings);
    this.map.on('zoomend', refreshBuildings);

    this.map.on('click', function (ev) { self._onMapClick(ev); });
    this.map.on('dblclick', function () { self._closeCurrentShape(); });
    this.map.on('mousemove', function (ev) { self._onMapMove(ev); });

    // Confort de dessin : clic droit = annuler le dernier point, Échap = quitter le mode dessin
    this.map.on('contextmenu', function (ev) {
      if (!self.state.drawMode) return;
      if (ev.originalEvent) ev.originalEvent.preventDefault();
      self.draftPoints.pop();
      self.layerDraft.clearLayers();
      if (self.draftPoints.length) self._drawDraft(self.draftPoints);
      self._updateDraftTools();
    });
    this._onKeyDown = function (ev) {
      if (ev.key === 'Escape' && self.state.drawMode) self._setDrawMode(null);
    };
    document.addEventListener('keydown', this._onKeyDown);
  };

  Simulator.prototype._setDrawMode = function (mode) {
    this.state.drawMode = mode;
    this.draftPoints = [];
    this.layerDraft.clearLayers();
    if (mode === 'roof') {
      this.mapHint.textContent = this.tap + ' sur chaque angle du pan, puis validez avec « ✓ Terminer »';
    } else if (mode === 'limit') {
      this.mapHint.textContent = '✂️ Entourez VOTRE maison (les angles de votre logement), puis « ✓ Terminer » — ' +
        'les panneaux ne seront posés que chez vous';
    } else if (mode === 'obstacle') {
      this.mapHint.textContent = 'Entourez la zone à éviter (cheminée, velux…), puis « ✓ Terminer »';
    } else if (mode === 'tree') {
      this.mapHint.textContent = '🌳 ' + this.tap + ' pour planter un arbre (ombre visible en 3D) — ' + this.tapLow + ' un arbre pour le retirer';
    } else {
      this.mapHint.textContent = this.state.zones.length
        ? this.tap + ' un panneau pour le retirer/remettre · « Ajouter un pan » pour compléter'
        : 'Activez « Ajouter un pan » pour dessiner votre toiture';
    }
    this.toolRoof.classList.toggle('is-on', mode === 'roof');
    this.toolObstacle.classList.toggle('is-on', mode === 'obstacle');
    this.toolLimit.classList.toggle('is-on', mode === 'limit');
    this.toolTree.classList.toggle('is-on', mode === 'tree');
    this.treeSizes.style.display = mode === 'tree' ? 'inline-flex' : 'none';
    this._updateDraftTools();
    this._refreshBuildings(); // les bâtiments sélectionnables s'effacent pendant un tracé
    // Sur mobile, le dessin se passe sous les réglages : on amène la carte à l'écran
    if (mode) this._scrollTo(this.mapArea);
  };

  Simulator.prototype._updateDraftTools = function () {
    var drafting = this.state.drawMode === 'roof' || this.state.drawMode === 'obstacle' ||
      this.state.drawMode === 'limit';
    this.toolFinish.style.display = drafting && this.draftPoints.length >= 3 ? '' : 'none';
    this.toolUndo.style.display = drafting && this.draftPoints.length >= 1 ? '' : 'none';
  };

  Simulator.prototype._clearDrawing = function () {
    this.state.zones = [];
    this.state.activeZone = -1;
    this.state.obstacles = [];
    this.state.trees = [];
    this.state.limit = null;
    this.state.excluded = {};
    this.state.panels = [];
    this._gsAdded = {};
    this._usedBuildings = {}; // les bâtiments redeviennent sélectionnables
    this.draftPoints = [];
    this.layerDraft.clearLayers();
    this._setDrawMode(null);
    this._renderGoogleSolar();
    this._relayout();
    this._refreshBuildings();
  };

  // Ajoute un pan et le rend actif (utilisé par le dessin, Google Solar et le contour IGN)
  Simulator.prototype._addZone = function (points, tilt, azimuth, autoAlign) {
    var z = { points: points, tilt: tilt != null ? tilt : 30, azimuth: azimuth != null ? azimuth : 180 };
    this.state.zones.push(z);
    this.state.activeZone = this.state.zones.length - 1;
    if (autoAlign) {
      var m = E.toLocalMeters(z.points, z.points[0]);
      z.azimuth = Math.round(E.suggestedAzimuth(m));
    }
    this._syncZoneControls();
    this._relayout();
    return z;
  };

  Simulator.prototype._onMapClick = function (ev) {
    if (!this.state.drawMode) return;
    if (this.state.drawMode === 'tree') {
      // Plantation directe : on reste en mode arbre pour en placer plusieurs
      this.state.trees.push({ lat: ev.latlng.lat, lng: ev.latlng.lng, h: this.treeHeight });
      this._relayout();
      return;
    }
    var pts = this.draftPoints;
    // Fermeture par re-clic sur le premier point (seuil élargi au doigt)
    if (pts.length >= 3) {
      var p0 = this.map.latLngToContainerPoint(pts[0]);
      var pc = this.map.latLngToContainerPoint(ev.latlng);
      if (p0.distanceTo(pc) < (this.isTouch ? 26 : 12)) { this._closeCurrentShape(); return; }
    }
    pts.push(ev.latlng);
    this._drawDraft(pts);
    this._updateDraftTools();
  };

  Simulator.prototype._onMapMove = function (ev) {
    if (!this.state.drawMode) return;
    if (this.draftPoints.length) this._drawDraft(this.draftPoints, ev.latlng);
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
    if (mode === 'roof' && this.draftPoints.length >= 3) {
      var pts = this.draftPoints.slice();
      var prev = this._zone();
      this.state.drawMode = null; // fermer sans re-défiler vers la carte
      this._setDrawModeUi();
      // Le nouveau pan hérite de l'inclinaison du précédent (souvent identique sur un même toit)
      this._addZone(pts, prev ? prev.tilt : 30, null, true);
      this.mapHint.textContent = '✓ Pan ajouté ! Réglez sa pente ci-dessus, ou ajoutez un autre pan';
      this._scrollTo(this.side); // sur mobile : retour aux réglages et à la liste des pans
    } else if (mode === 'obstacle' && this.draftPoints.length >= 3) {
      this.state.obstacles.push(this.draftPoints.slice());
      this.state.drawMode = null;
      this._setDrawModeUi();
      this._relayout();
    } else if (mode === 'limit' && this.draftPoints.length >= 3) {
      this.state.limit = this.draftPoints.slice();
      this.state.excluded = {};   // les panneaux retirés à la main n'ont plus de sens
      this.state.drawMode = null;
      this._setDrawModeUi();
      this.mapHint.textContent = '✓ Votre maison est délimitée : les panneaux ne débordent plus chez les voisins';
      this._relayout();
      this._scrollTo(this.side);
    }
  };

  // Remet l'interface du mode dessin à l'état neutre sans effet de bord (défilement…)
  Simulator.prototype._setDrawModeUi = function () {
    this.draftPoints = [];
    this.layerDraft.clearLayers();
    this.toolRoof.classList.remove('is-on');
    this.toolObstacle.classList.remove('is-on');
    this.toolLimit.classList.remove('is-on');
    this.toolTree.classList.remove('is-on');
    this.treeSizes.style.display = 'none';
    this._updateDraftTools();
  };

  Simulator.prototype._autoAzimuth = function (silent) {
    var z = this._zone();
    if (!z) return;
    var m = E.toLocalMeters(z.points, z.points[0]);
    z.azimuth = Math.round(E.suggestedAzimuth(m));
    this._syncZoneControls();
    if (!silent) this._relayout();
  };

  // Reflète le pan actif dans les curseurs inclinaison / orientation
  Simulator.prototype._syncZoneControls = function () {
    var z = this._zone();
    if (!z || !this.tiltRange) return;
    this.tiltRange.value = z.tilt;
    this.tiltVal.textContent = z.tilt + '°';
    this.azRange.value = z.azimuth;
    this.azVal.textContent = z.azimuth + '° (' + azLabel(z.azimuth) + ')';
  };

  // Liste des pans dans le panneau latéral (sélection, suppression)
  Simulator.prototype._renderZones = function () {
    var self = this, s = this.state;
    if (!this.zonesBox) return;
    this.zonesBox.innerHTML = '';
    if (!s.zones.length) {
      this.zonesBox.appendChild(el('p', {
        class: 'rdfsim-muted', style: 'margin:0',
        text: 'Aucun pan pour l’instant — dessinez sur la carte, utilisez « Contour du bâtiment » ou la détection automatique.'
      }));
      return;
    }
    s.zones.forEach(function (z, zi) {
      // Même décompte que le calcul : hors panneaux retirés à la main ET hors
      // emplacements écartés par le dimensionnement conseillé.
      var nz = self._activePanels().filter(function (p) { return p.zone === zi; }).length;
      var areaM = E.polygonAreaWithin(
        E.toLocalMeters(z.points, z.points[0]),
        s.limit && s.limit.length >= 3 ? E.toLocalMeters(s.limit, z.points[0]) : null
      ) / Math.cos(z.tilt * Math.PI / 180);
      var row = el('div', { class: 'rdfsim-zone' + (zi === s.activeZone ? ' is-on' : '') }, [
        el('button', {
          class: 'rdfsim-zone-main', type: 'button',
          html: '<b>Pan ' + (zi + 1) + '</b> · ' + fmt(areaM) + ' m² · ' + nz + ' panneaux · ' +
            azLabel(z.azimuth) + ' · ' + z.tilt + '°' +
            (z.google ? ' · <span title="Les ombres des bâtiments voisins et arbres sont intégrées au calcul (Google Solar)">☀ ombrage inclus</span>' : '') +
            (z.harmonized ? ' · <span title="Versant harmonisé avec son pan opposé : faîtage commun, largeurs unifiées, pentes accordées">⚖</span>' : ''),
          onclick: function () { s.activeZone = zi; self._syncZoneControls(); self._relayout(); }
        }),
        el('button', {
          class: 'rdfsim-zone-del', type: 'button', text: '🗑', title: 'Supprimer ce pan',
          onclick: function () {
            s.zones.splice(zi, 1);
            s.excluded = {}; // les clés référencent les index de pans : on repart proprement
            s.activeZone = Math.min(s.activeZone, s.zones.length - 1);
            self._syncZoneControls();
            self._relayout();
          }
        })
      ]);
      self.zonesBox.appendChild(row);
    });
  };

  /* ---------------- Vue 3D (optionnelle, nécessite Three.js) ---------------- */
  Simulator.prototype._open3d = function () {
    if (!this.state.zones.length) {
      this.mapHint.textContent = 'Dessinez d’abord au moins un pan de toiture pour voir la 3D';
      return;
    }
    if (root.RDFSolar3D && root.RDFSolar3D.available()) {
      root.RDFSolar3D.open(this);
    } else {
      this.mapHint.textContent = 'Vue 3D indisponible (Three.js non chargé sur cette page)';
    }
  };

  /* ---------------- Calepinage + rendu des panneaux (multi-pans) ---------------- */
  Simulator.prototype._relayout = function () {
    var s = this.state;
    var self = this;
    if (this._view3d) this._view3d.close(); // la 3D reflète l'état courant : on la ferme le temps du recalcul
    // Le repère « vous êtes ici » a fait son office dès qu'un pan est tracé
    if (this.layerMe && s.zones.length) this.layerMe.clearLayers();
    this.layerRoof.clearLayers();
    this.layerPanels.clearLayers();
    this.layerTrees.clearLayers();
    s.panels = [];

    // Arbres : couronne à l'échelle réelle, clic pour retirer (indépendants des pans)
    s.trees.forEach(function (t, ti) {
      var crown = L.circle([t.lat, t.lng], {
        radius: t.h * 0.35,
        color: '#166534', weight: 1.5, fillColor: '#22c55e', fillOpacity: 0.45
      });
      crown.bindTooltip('🌳 ' + t.h + ' m — cliquer pour retirer');
      crown.on('click', function (ev) {
        L.DomEvent.stopPropagation(ev);
        s.trees.splice(ti, 1);
        self._relayout();
      });
      crown.addTo(self.layerTrees);
    });

    if (!s.zones.length) {
      s.origin = null;
      this._renderZones();
      this._refresh();
      return;
    }

    var origin = s.zones[0].points[0];
    s.origin = origin;
    var obstaclesM = s.obstacles.map(function (o) { return E.toLocalMeters(o, origin); });
    // « Ma maison » : limite de pose commune à tous les pans
    var limitM = s.limit && s.limit.length >= 3 ? E.toLocalMeters(s.limit, origin) : null;

    // Obstacles
    s.obstacles.forEach(function (o) {
      L.polygon(o, { color: '#dc2626', weight: 1.5, fillColor: '#dc2626', fillOpacity: 0.25, dashArray: '4 3' })
        .addTo(this.layerRoof);
    }, this);

    // Limite « ma maison » : bien visible, cliquable pour la retirer
    if (s.limit && s.limit.length >= 3) {
      var limitPoly = L.polygon(s.limit, {
        color: '#2563eb', weight: 3, fillColor: '#2563eb', fillOpacity: 0.06,
        className: 'rdfsim-limit-poly'
      });
      limitPoly.bindTooltip('✂️ Votre maison — ' + this.tapLow + ' pour retirer la délimitation');
      limitPoly.on('click', function (ev) {
        L.DomEvent.stopPropagation(ev);
        if (self.state.drawMode) { self._onMapClick(ev); return; }
        self._clearLimit();
      });
      limitPoly.addTo(this.layerRoof);
    }

    var panel = this._panel();
    s.zones.forEach(function (z, zi) {
      var isActive = zi === s.activeZone;
      // Contour du pan (cliquer un pan le sélectionne)
      // Quand une limite « ma maison » est posée, l'emprise du bâtiment n'est plus
      // qu'un repère : on l'estompe pour que le regard aille sur la maison délimitée.
      var poly = L.polygon(z.points, {
        color: isActive ? '#f59e0b' : '#d9b06a',
        weight: limitM ? 1 : (isActive ? 2.5 : 1.5),
        fillColor: '#f59e0b',
        fillOpacity: limitM ? 0.02 : (isActive ? 0.10 : 0.04),
        dashArray: limitM ? '4 4' : null,
        className: 'rdfsim-roof-poly'
      });
      poly.on('click', function (ev) {
        L.DomEvent.stopPropagation(ev);
        if (self.state.drawMode) { self._onMapClick(ev); return; }
        s.activeZone = zi;
        self._syncZoneControls();
        self._relayout();
      });
      poly.addTo(self.layerRoof);

      // Calepinage de ce pan avec sa pente et son orientation propres
      var roofM = E.toLocalMeters(z.points, origin);
      var zonePanels = E.layoutPanels({
        roof: roofM,
        obstacles: obstaclesM,
        limit: limitM,
        azimuth: z.azimuth,
        tiltDeg: z.tilt,
        panelW: panel.largeurM,
        panelH: panel.hauteurM,
        landscape: s.landscape,
        margin: self.cfg.margin,
        gap: self.cfg.gap
      });

      // Pan issu de Google Solar : on rattache à chacun de nos panneaux la production
      // du panneau Google le plus proche (ombres du voisinage incluses) ; à défaut,
      // la médiane du pan. gRel = production relative au meilleur panneau du pan.
      if (z.google && z.google.panels.length) {
        var gM = z.google.panels.map(function (g) {
          var m = E.toLocalMeters([{ lat: g.lat, lng: g.lng }], origin)[0];
          return { x: m.x, y: m.y, e: g.e };
        });
        var energies = gM.map(function (g) { return g.e; }).sort(function (a, b) { return a - b; });
        var median = energies[Math.floor(energies.length / 2)];
        var best = energies[energies.length - 1] || 1;
        zonePanels.forEach(function (p) {
          var cx = 0, cy = 0;
          p.corners.forEach(function (c) { cx += c.x; cy += c.y; });
          cx /= 4; cy /= 4;
          var bestD = Infinity, bestE = null;
          for (var g = 0; g < gM.length; g++) {
            var d = Math.pow(gM[g].x - cx, 2) + Math.pow(gM[g].y - cy, 2);
            if (d < bestD) { bestD = d; bestE = gM[g].e; }
          }
          p.gE = (bestD <= 2.2 * 2.2 && bestE != null) ? bestE : median; // au-delà de ~2 m : pas de correspondance fiable
          p.gRel = p.gE / best;
        });
      }

      zonePanels.forEach(function (p) {
        p.zone = zi;
        s.panels.push(p);
      });
    });

    // Dimensionnement conseillé : écarte les panneaux qui ne se rentabilisent pas
    this._applyAutoSizing();

    s.panels.forEach(function (p) {
      var key = p.zone + ':' + p.row + ':' + p.col;
      var autoOut = !!s.autoExcluded[key];
      var excluded = !!s.excluded[key] || autoOut;
      var latlngs = p.corners.map(function (c) { return E.toLatLng(c, origin); });
      var style;
      if (excluded) {
        style = { color: '#94a3b8', weight: 1, fillColor: '#94a3b8', fillOpacity: 0.15, dashArray: '3 3', className: 'rdfsim-panel-shape' };
      } else if (p.gRel != null && p.gRel < 0.65) {
        style = { color: '#f28b82', weight: 1.5, fillColor: '#5d2626', fillOpacity: 0.92, className: 'rdfsim-panel-shape' };
      } else if (p.gRel != null && p.gRel < 0.85) {
        style = { color: '#f0c36b', weight: 1.5, fillColor: '#4a3a1f', fillOpacity: 0.92, className: 'rdfsim-panel-shape' };
      } else {
        style = { color: '#9fc3ff', weight: 1, fillColor: '#16324f', fillOpacity: 0.92, className: 'rdfsim-panel-shape' };
      }
      var poly = L.polygon(latlngs, style);
      if (autoOut) {
        poly.bindTooltip('Emplacement disponible, non retenu par le dimensionnement conseillé ' +
          '(il produirait surtout du surplus, racheté 1,1 c€/kWh) — cliquer pour l’ajouter quand même');
      } else if (!excluded && p.gRel != null && p.gRel < 0.85) {
        poly.bindTooltip((p.gRel < 0.65 ? '🔴 Fortement ombragé' : '🟠 Partiellement ombragé') +
          ' : −' + Math.round((1 - p.gRel) * 100) + ' % vs le meilleur panneau du pan ' +
          '(ombres du voisinage, données Google) — cliquer pour le retirer');
      }
      poly.on('click', function (ev) {
        L.DomEvent.stopPropagation(ev);
        // En mode dessin (obstacle sur le champ de panneaux…), le clic sert à poser un sommet
        if (self.state.drawMode) { self._onMapClick(ev); return; }
        self._freezeSizing();      // le choix du visiteur prime sur le conseil
        s.excluded[key] = !s.excluded[key];
        self._relayout();
      });
      poly.addTo(self.layerPanels);
    });

    this._renderZones();
    this._refresh();
  };

  /* ---------------- PVGIS (optionnel, via le proxy serveur) ----------------
   * PVGIS (Commission européenne) calcule la production à partir de données
   * satellitaires réelles, en tenant compte du RELIEF (masques lointains) et de
   * la température des modules mois par mois. Le navigateur ne peut pas
   * l'interroger directement (pas de CORS) : on passe par `server/pvgis-proxy.js`,
   * dont l'URL est fournie via l'option `pvgisProxyUrl`.
   *
   * Principe : le calcul reste SYNCHRONE. `_pvgisFor()` ne renvoie que ce qui
   * est déjà en cache ; s'il manque une valeur, une requête part en arrière-plan
   * et le calepinage est relancé à son arrivée. Le visiteur voit donc tout de
   * suite l'estimation régionale, affinée une seconde plus tard sans rien faire.
   * En cas d'indisponibilité, on garde l'estimation locale — jamais d'erreur
   * visible, jamais d'attente. */

  Simulator.prototype._pvgisKey = function (z, lat, lng) {
    return [
      Math.round(lat * 1e4) / 1e4,
      Math.round(lng * 1e4) / 1e4,
      Math.round(z.tilt),
      Math.round(E.pvgisAspect(z.azimuth)),
      E.pvgisLoss(this._inverter().performanceRatio)
    ].join('|');
  };

  Simulator.prototype._pvgisFor = function (z, lat, lng) {
    var self = this;
    var p = this._pvgis;
    if (!this.cfg.pvgisProxyUrl || p.off) return null;

    var key = this._pvgisKey(z, lat, lng);
    var hit = p.cache[key];
    if (hit) return hit;
    if (p.pending[key]) return null;
    // Échec récent sur ce pan : on laisse passer une minute avant de réessayer
    if (p.failed[key] && Date.now() - p.failed[key] < 60000) return null;

    var parts = key.split('|');
    var url = this.cfg.pvgisProxyUrl +
      (this.cfg.pvgisProxyUrl.indexOf('?') === -1 ? '?' : '&') +
      'lat=' + parts[0] + '&lon=' + parts[1] +
      '&angle=' + parts[2] + '&aspect=' + parts[3] + '&loss=' + parts[4] + '&peakpower=1';

    p.pending[key] = true;
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 8000);

    fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (json) {
        if (!json || !(json.kwhPerKwc > 0)) throw new Error('réponse inexploitable');
        p.cache[key] = {
          kwhPerKwc: json.kwhPerKwc,
          monthly: (json.monthlyPerKwc && json.monthlyPerKwc.length === 12) ? json.monthlyPerKwc : null,
          source: json.source || 'PVGIS'
        };
        p.echecs = 0;
        delete p.failed[key];
      })
      .catch(function (e) {
        p.failed[key] = Date.now();
        p.echecs++;
        // Proxy absent ou hors service : on cesse d'insister pour la session
        if (p.echecs >= 3) {
          p.off = true;
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('RDF-SOLAR : proxy PVGIS injoignable (' + e.message +
              ') — le simulateur poursuit avec son moteur embarqué.');
          }
        }
      })
      .then(function () {
        clearTimeout(timer);
        delete p.pending[key];
        // Les chiffres ont changé : on relance le calepinage (le dimensionnement
        // conseillé dépend du rendement de chaque pan).
        if (self.state.zones.length) self._relayout();
      });
    return null;
  };

  /** Y a-t-il encore des appels PVGIS en cours ? (affichage « affinage… ») */
  Simulator.prototype._pvgisPending = function () {
    return Object.keys(this._pvgis.pending).length > 0;
  };

  /**
   * Rendement d'un pan : kWh/kWc/an + profil mensuel.
   * Source PVGIS si disponible, sinon moteur embarqué (grille d'irradiation
   * régionale + table de transposition).
   */
  Simulator.prototype._zoneYield = function (z, lat, lng) {
    var pv = this._pvgisFor(z, lat, lng);
    if (pv) {
      return { perKwc: pv.kwhPerKwc, monthly: pv.monthly, source: 'pvgis' };
    }
    var est = E.estimateProduction({
      kwc: 1, lat: lat, lng: lng,
      tiltDeg: z.tilt, azimuthDeg: z.azimuth,
      performanceRatio: this._inverter().performanceRatio
    });
    return { perKwc: est.annualKwh, monthly: null, source: 'local' };
  };

  Simulator.prototype._activePanels = function () {
    var s = this.state;
    return s.panels.filter(function (p) {
      var k = p.zone + ':' + p.row + ':' + p.col;
      return !s.excluded[k] && !s.autoExcluded[k];
    });
  };

  /* ---------------- Dimensionnement conseillé ----------------
   * Remplir tout le toit n'est plus le bon réflexe : depuis juin 2026 le surplus
   * n'est racheté que 1,1 c€/kWh, et au-delà de 9 kWc la TVA repasse de 5,5 % à
   * 20 %. Un toit entièrement couvert affiche donc un retour sur investissement
   * médiocre — et fait fuir le visiteur.
   *
   * On cherche donc le nombre de panneaux qui maximise le gain net cumulé sur
   * l'horizon retenu : les panneaux sont classés du plus au moins productif
   * (ombrage du voisinage compris quand il est connu), puis on teste chaque
   * taille d'installation avec son coût, son taux de TVA et sa trajectoire. */

  // Production annuelle attendue de chaque panneau posé, dans l'ordre du calepinage.
  Simulator.prototype._panelYields = function () {
    var self = this;
    var s = this.state;
    var panel = this._panel();
    var inverter = this._inverter();
    var lat = s.origin ? s.origin.lat : (s.address ? s.address.lat : 46.6);
    var lng = s.origin ? s.origin.lng : (s.address ? s.address.lng : 2.4);
    var dcToAc = Math.min(0.97, (inverter.performanceRatio || 0.8) + 0.14);
    // Même source de rendement que le calcul final (PVGIS si disponible) :
    // le dimensionnement conseillé doit être cohérent avec les chiffres affichés.
    var perZone = s.zones.map(function (z) {
      var base = self._zoneYield(z, lat, lng).perKwc * panel.puissanceWc / 1000;
      if (z.google && z.google.medianSunshine && z.google.maxSunshine) {
        base *= Math.max(0.55, Math.min(1, z.google.medianSunshine / z.google.maxSunshine));
      }
      return base;
    });
    return s.panels.map(function (p) {
      var kwh = (p.gE != null)
        ? p.gE * (panel.puissanceWc / (s.zones[p.zone].google || {}).panelWatts) * dcToAc
        : perZone[p.zone];
      return { key: p.zone + ':' + p.row + ':' + p.col, kwh: isFinite(kwh) ? kwh : 0 };
    });
  };

  Simulator.prototype._applyAutoSizing = function () {
    var s = this.state;
    s.autoExcluded = {};
    s.sizing = null;
    if (s.sizingMode !== 'auto' || !s.panels.length) return;

    var self = this;
    var panel = this._panel();
    var battery = this._battery();
    var pilotage = this._pilotage();
    var offer = this._offer();
    var tarifs = this.catalog.tarifs || {};
    var brand = this.catalog.brand || {};

    // Les meilleurs panneaux d'abord : les ombragés sont les premiers écartés
    var yields = this._panelYields().sort(function (a, b) { return b.kwh - a.kwh; });

    var fixe = (offer.forfaitBase || 0) + (battery.prix || 0) + (pilotage.prix || 0);
    var best = { n: yields.length, gain: -Infinity };
    var cumul = 0;
    for (var n = 1; n <= yields.length; n++) {
      cumul += yields[n - 1].kwh;
      var kwc = n * panel.puissanceWc / 1000;
      var vat = E.vatEligibility({
        kwc: kwc, residentiel: s.residentiel,
        rge: brand.rge !== false, modulesConformes: panel.basCarbone !== false, ems: !!pilotage.ems,
        taux: tarifs.tva ? { reduit: tarifs.tva.reduit, normal: tarifs.tva.normal, seuilKwc: tarifs.tva.seuilKwcTauxReduit } : null
      });
      var ttc = (fixe + n * (offer.prixParPanneau || 0)) * (1 + vat.rate);
      var fin = E.financials({
        productionKwh: cumul, consumptionKwh: s.consumptionKwh,
        batteryKwh: battery.capaciteKwh || 0,
        selfConsumptionBoost: pilotage.gainAutoconsommation || 0,
        gridPrice: tarifs.prixKwhReseau != null ? tarifs.prixKwhReseau : 0.2001,
        feedInTariff: tarifs.tarifRachatSurplus != null ? tarifs.tarifRachatSurplus : 0.011,
        installCost: ttc, bonusTiers: tarifs.primeAutoconsommation, kwc: kwc,
        horizonYears: tarifs.horizonAns || 25,
        priceInflation: tarifs.inflationElectricite,
        feedInIndexation: tarifs.indexationRachatAnnuelle,
        degradation: tarifs.degradationAnnuelle,
        maintenance: tarifs.maintenanceAnnuelle,
        inverterReplacement: tarifs.remplacementOnduleur
      });
      if (fin.gainNetHorizon > best.gain) best = { n: n, gain: fin.gainNetHorizon, kwc: kwc, eligible: vat.eligible };
    }

    yields.slice(best.n).forEach(function (y) { s.autoExcluded[y.key] = true; });
    s.sizing = {
      n: best.n, total: yields.length,
      kwc: best.kwc, sousSeuilTva: !!best.eligible,
      gain: best.gain
    };
    if (best.n >= yields.length) s.sizing.complet = true;
    return self;
  };

  // Premier clic manuel sur un panneau : on fige le dimensionnement conseillé
  // pour ne pas écraser le choix du visiteur au recalcul suivant.
  Simulator.prototype._freezeSizing = function () {
    var s = this.state;
    if (s.sizingMode !== 'auto') return;
    Object.keys(s.autoExcluded).forEach(function (k) { s.excluded[k] = true; });
    s.autoExcluded = {};
    s.sizingMode = 'manuel';
  };

  Simulator.prototype._setSizingMode = function (mode) {
    this.state.sizingMode = mode;
    this.state.excluded = {};
    this.state.autoExcluded = {};
    this._relayout();
  };

  /* ---------------- « Ma maison » : délimitation en habitat mitoyen ----------------
   * En lotissement, la BD TOPO (comme le cadastre) décrit une rangée de maisons
   * accolées comme UN SEUL bâtiment : sans délimitation, le calepinage s'étale
   * sur les toits des voisins. La limite tracée par le visiteur contraint la
   * pose des panneaux et le calcul de surface. */

  Simulator.prototype._clearLimit = function () {
    this.state.limit = null;
    this.state.excluded = {};
    this.mapHint.textContent = 'Délimitation retirée : le calepinage reprend toute l’emprise du bâtiment';
    this._relayout();
  };

  /**
   * Le bâtiment ressemble-t-il à une rangée de maisons mitoyennes ?
   * Repères : une maison individuelle dépasse rarement 200 m² d'emprise au sol
   * ou 22 m de long ; une rangée de pavillons accolés fait couramment 40 à 60 m.
   */
  Simulator.prototype._looksLikeTerrace = function () {
    var s = this.state;
    if (!s.zones.length) return null;
    var maxArea = 0, maxLen = 0;
    s.zones.forEach(function (z) {
      var m = E.toLocalMeters(z.points, z.points[0]);
      maxArea = Math.max(maxArea, E.polygonArea(m));
      for (var i = 0; i < m.length; i++) {
        for (var j = i + 1; j < m.length; j++) {
          maxLen = Math.max(maxLen, Math.hypot(m[j].x - m[i].x, m[j].y - m[i].y));
        }
      }
    });
    return { suspect: maxArea > 200 || maxLen > 22, area: maxArea, length: maxLen };
  };

  // Bandeau « ma maison » : proposé spontanément quand l'emprise détectée est
  // trop grande pour un logement, rappelé ensuite comme état.
  Simulator.prototype._renderLimitCard = function () {
    var self = this, s = this.state;
    if (!s.zones.length) return null;

    if (s.limit && s.limit.length >= 3) {
      var card = el('div', { class: 'rdfsim-card rdfsim-limit is-set' }, [
        el('h4', { text: '✂️ Votre maison est délimitée' }),
        el('p', {
          class: 'rdfsim-muted', style: 'margin-bottom:8px',
          text: 'Les panneaux ne sont posés que dans la zone bleue : rien ne déborde chez vos voisins, et la surface de toiture retenue ne compte que la vôtre.'
        }),
        el('div', { class: 'rdfsim-btn-row' }, [
          el('button', {
            class: 'rdfsim-btn rdfsim-btn-ghost', type: 'button', text: '✏️ Redessiner',
            onclick: function () { self._setDrawMode('limit'); }
          }),
          el('button', {
            class: 'rdfsim-btn rdfsim-btn-ghost', type: 'button', text: '✕ Retirer',
            onclick: function () { self._clearLimit(); }
          })
        ])
      ]);
      return card;
    }

    var t = this._looksLikeTerrace();
    if (!t || !t.suspect) return null;
    return el('div', { class: 'rdfsim-card rdfsim-limit is-warn' }, [
      el('h4', { text: '🏘 Maison mitoyenne ou en lotissement ?' }),
      el('p', {
        class: 'rdfsim-muted', style: 'margin-bottom:8px',
        text: 'Le bâtiment détecté fait ' + fmt(t.area) + ' m² au sol sur ' + fmt(t.length) +
          ' m de long : il regroupe probablement plusieurs logements accolés (le cadastre ne les sépare pas). ' +
          'Délimitez votre maison pour que les panneaux ne soient posés que chez vous.'
      }),
      el('div', { class: 'rdfsim-btn-row' }, [
        el('button', {
          class: 'rdfsim-btn rdfsim-btn-primary', type: 'button', text: '✂️ Délimiter ma maison',
          onclick: function () { self._setDrawMode('limit'); }
        })
      ])
    ]);
  };

  // Bandeau explicatif : pourquoi tout le toit n'est pas couvert, et comment reprendre la main
  Simulator.prototype._renderSizingCard = function () {
    var self = this, s = this.state;
    if (!s.panels.length) return null;
    var card = el('div', { class: 'rdfsim-card rdfsim-sizing' });
    var toggle = function (label, mode) {
      return el('button', {
        class: 'rdfsim-btn rdfsim-btn-ghost', type: 'button', text: label,
        onclick: function () { self._setSizingMode(mode); }
      });
    };

    if (s.sizingMode === 'auto' && s.sizing && !s.sizing.complet) {
      card.appendChild(el('h4', {
        text: '🎯 Dimensionnement conseillé : ' + s.sizing.n + ' panneaux sur ' + s.sizing.total + ' possibles'
      }));
      card.appendChild(el('p', {
        class: 'rdfsim-muted', style: 'margin-bottom:8px',
        text: 'Soit ' + fmt(s.sizing.kwc, 2) + ' kWc. Couvrir tout le toit produirait surtout du surplus, ' +
          'racheté seulement 1,1 c€/kWh depuis juin 2026' +
          (s.sizing.sousSeuilTva ? ', et ferait passer votre TVA de 5,5 % à 20 % au-delà de 9 kWc' : '') +
          ' : cette taille est celle qui vous rapporte le plus sur ' +
          ((this.catalog.tarifs || {}).horizonAns || 25) + ' ans. Vous pouvez ajouter des panneaux d’un clic sur la carte.'
      }));
      card.appendChild(el('div', { class: 'rdfsim-btn-row' }, [toggle('🏠 Remplir tout le toit', 'full')]));
    } else if (s.sizingMode === 'auto') {
      card.appendChild(el('h4', { text: '🎯 Toute votre toiture est rentable' }));
      card.appendChild(el('p', {
        class: 'rdfsim-muted', style: 'margin-bottom:0',
        text: 'Les ' + s.panels.length + ' emplacements disponibles sont retenus : votre consommation absorbe toute la production.'
      }));
    } else {
      card.appendChild(el('h4', {
        text: s.sizingMode === 'full' ? '🏠 Toiture entièrement couverte' : '✏️ Calepinage ajusté à la main'
      }));
      card.appendChild(el('p', {
        class: 'rdfsim-muted', style: 'margin-bottom:8px',
        text: 'Nous pouvons aussi calculer la taille d’installation la plus rentable pour votre consommation.'
      }));
      card.appendChild(el('div', { class: 'rdfsim-btn-row' }, [toggle('🎯 Dimensionnement conseillé', 'auto')]));
    }
    return card;
  };

  /* ---------------- Calculs agrégés (somme des pans) ---------------- */
  Simulator.prototype._compute = function () {
    var s = this.state;
    var panel = this._panel();
    var inverter = this._inverter();
    var battery = this._battery();
    var offer = this._offer();
    var active = this._activePanels();
    var n = active.length;
    var kwc = n * panel.puissanceWc / 1000;

    // Le gisement solaire est pris à l'endroit réel du toit dessiné (plus fiable
    // que l'adresse, notamment en mode « placer la carte moi-même »)
    var lat = s.origin ? s.origin.lat : (s.address ? s.address.lat : 46.6);
    var lng = s.origin ? s.origin.lng : (s.address ? s.address.lng : 2.4);

    // Chaque pan produit selon sa propre inclinaison / orientation.
    // Pans issus de Google Solar : les ombres du voisinage (bâtiments, arbres, relief)
    // sont intégrées — en priorité via la production par panneau calculée par Google
    // (« mode précision »), sinon via un facteur d'ombrage dérivé de l'ensoleillement du pan.
    // Passage DC Google → AC : rendement onduleur estimé depuis le performance ratio.
    var dcToAc = Math.min(0.97, (inverter.performanceRatio || 0.8) + 0.14);
    var annual = 0, ghi = E.ghiAt(lat, lng), roofArea = 0;
    var zonesInfo = [];
    var monthlyAgg = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    var pvgisZones = 0;
    var self = this;
    s.zones.forEach(function (z, zi) {
      var zActive = active.filter(function (p) { return p.zone === zi; });
      var nz = zActive.length;
      var kwcz = nz * panel.puissanceWc / 1000;
      var zAnnual, shading = 'aucune';

      // Rendement de référence du pan : PVGIS si le proxy répond, sinon moteur embarqué
      var y = self._zoneYield(z, lat, lng);
      if (y.source === 'pvgis') pvgisZones++;

      if (z.google && z.google.panels.length && zActive.every(function (p) { return p.gE != null; })) {
        if (y.source === 'pvgis') {
          // PVGIS fournit le gisement (relief et température inclus), Google
          // l'ombrage de proximité : on applique l'ombrage RELATIF au meilleur
          // panneau du pan pour ne pas superposer deux modèles d'irradiation.
          var rel = zActive.reduce(function (sum, p) {
            return sum + (p.gRel != null ? p.gRel : 1);
          }, 0) / Math.max(1, nz);
          zAnnual = kwcz * y.perKwc * rel;
          shading = 'PVGIS + ombrage Google par panneau (−' + Math.round((1 - rel) * 100) + ' %)';
        } else {
          // Mode précision : somme des productions Google des panneaux retenus,
          // mise à l'échelle de la puissance réelle de nos panneaux
          zAnnual = zActive.reduce(function (sum, p) { return sum + p.gE; }, 0) *
            (panel.puissanceWc / z.google.panelWatts) * dcToAc;
          shading = 'précision Google (par panneau)';
        }
      } else if (z.google && z.google.medianSunshine && z.google.maxSunshine) {
        // Repli : facteur d'ombrage du pan (ensoleillement médian / maximum du bâtiment)
        var shade = Math.max(0.55, Math.min(1, z.google.medianSunshine / z.google.maxSunshine));
        zAnnual = kwcz * y.perKwc * shade;
        shading = 'facteur d’ombrage Google (−' + Math.round((1 - shade) * 100) + ' %)';
      } else {
        // Pan dessiné à la main : pas d'ombrage de proximité modélisé
        zAnnual = kwcz * y.perKwc;
      }

      annual += zAnnual;
      // Saisonnalité : profil mensuel PVGIS propre au pan (une toiture est ne
      // produit pas au même rythme qu'une toiture sud) ; à défaut, profil national.
      var zMonthly = E.monthlyFromProfile(zAnnual, y.monthly);
      for (var m = 0; m < 12; m++) monthlyAgg[m] += zMonthly[m];

      // Surface de toiture réellement retenue : hors des limites, le toit du
      // voisin ne compte pas.
      var zPoly = E.toLocalMeters(z.points, z.points[0]);
      var zLimit = s.limit && s.limit.length >= 3 ? E.toLocalMeters(s.limit, z.points[0]) : null;
      roofArea += E.polygonAreaWithin(zPoly, zLimit) / Math.cos(z.tilt * Math.PI / 180);
      zonesInfo.push({
        n: nz, kwc: kwcz, annualKwh: zAnnual, tilt: z.tilt, azimuth: z.azimuth,
        shading: shading, isGoogle: !!z.google, source: y.source
      });
    });
    var googleZones = zonesInfo.filter(function (zin) { return zin.isGoogle; }).length;
    var shadingLevel = !s.zones.length || !googleZones ? 'none'
      : (googleZones === s.zones.length ? 'full' : 'partial');
    // Origine des données de production, affichée au visiteur et jointe au lead
    var dataSource = !s.zones.length || !pvgisZones ? 'local'
      : (pvgisZones === s.zones.length ? 'pvgis' : 'partial');
    var prod = {
      annualKwh: annual,
      monthly: monthlyAgg,
      ghi: ghi != null ? ghi : E.ghiAt(lat, lng),
      specificYield: kwc > 0 ? annual / kwc : 0,
      source: dataSource,
      pending: this._pvgisPending()
    };

    var tarifs = this.catalog.tarifs || {};
    var pilotage = this._pilotage();

    // Prix catalogue = HT (voir tarifs.prixHT) : la TVA dépend de l'éligibilité au taux réduit.
    var costHT = (offer.forfaitBase || 0) + n * (offer.prixParPanneau || 0) +
      (battery.prix || 0) + (pilotage.prix || 0);

    // TVA 5,5 % (depuis le 01/10/2025) : conditions CUMULATIVES, une seule manquante → 20 %.
    var vat = E.vatEligibility({
      kwc: kwc,
      residentiel: s.residentiel,
      rge: (this.catalog.brand || {}).rge !== false,
      modulesConformes: panel.basCarbone !== false,
      ems: !!pilotage.ems,
      taux: tarifs.tva ? {
        reduit: tarifs.tva.reduit, normal: tarifs.tva.normal, seuilKwc: tarifs.tva.seuilKwcTauxReduit
      } : null
    });
    var cost = E.vatBreakdown(costHT, vat.rate);
    // Ce que coûte (ou rapporte) la condition TVA : écart entre les deux taux
    var ecartTva = costHT * ((vat.normal != null ? vat.normal : 0.20) - (vat.reduit != null ? vat.reduit : 0.055));

    var fin = E.financials({
      productionKwh: prod.annualKwh,
      consumptionKwh: s.consumptionKwh,
      batteryKwh: battery.capaciteKwh || 0,
      selfConsumptionBoost: pilotage.gainAutoconsommation || 0,
      gridPrice: tarifs.prixKwhReseau != null ? tarifs.prixKwhReseau : 0.2001,
      feedInTariff: tarifs.tarifRachatSurplus != null ? tarifs.tarifRachatSurplus : 0.011,
      installCost: cost.ttc,
      bonusTiers: tarifs.primeAutoconsommation,   // vide depuis le 4 juin 2026 → prime = 0
      kwc: kwc,
      horizonYears: tarifs.horizonAns || 25,
      priceInflation: tarifs.inflationElectricite,
      feedInIndexation: tarifs.indexationRachatAnnuelle,
      degradation: tarifs.degradationAnnuelle,
      maintenance: tarifs.maintenanceAnnuelle,
      inverterReplacement: tarifs.remplacementOnduleur
    });

    return {
      n: n, kwc: kwc, prod: prod, fin: fin,
      installCost: cost.ttc,      // ce que paie réellement le client
      cost: cost,                 // { ht, rate, vat, ttc }
      vat: vat,                   // éligibilité TVA 5,5 % + détail des conditions
      ecartTva: ecartTva,
      roofArea: roofArea,
      zones: zonesInfo,
      shadingLevel: shadingLevel, // 'full' | 'partial' | 'none' : part des pans avec ombrage Google intégré
      panel: panel, inverter: inverter, battery: battery, offer: offer, pilotage: pilotage
    };
  };

  /* ---------------- Recherche d'adresse ----------------
   * Géocodage Base Adresse Nationale via la Géoplateforme IGN (gratuit, sans clé).
   * L'ancienne api-adresse.data.gouv.fr a été décommissionnée fin janvier 2026. */
  Simulator.prototype._searchAddress = function (q, listBox) {
    var self = this;
    if (!q || q.trim().length < 3) { listBox.style.display = 'none'; return; }
    fetch('https://data.geopf.fr/geocodage/search?index=address&limit=6&q=' + encodeURIComponent(q))
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (json) {
        listBox.innerHTML = '';
        var feats = (json && json.features) || [];
        if (!feats.length) {
          listBox.appendChild(el('div', {
            class: 'rdfsim-ac-item', style: 'cursor:default',
            text: 'Aucune adresse trouvée — précisez la ville, ou placez la carte manuellement (bouton ci-dessous).'
          }));
          listBox.style.display = 'block';
          return;
        }
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
      .catch(function () {
        listBox.innerHTML = '';
        listBox.appendChild(el('div', {
          class: 'rdfsim-ac-item', style: 'cursor:default',
          text: 'Service d’adresse momentanément indisponible. Vous pouvez placer la carte manuellement (bouton ci-dessous).'
        }));
        listBox.style.display = 'block';
      });
  };

  /* ---------------- Géolocalisation ----------------
   * Cas d'usage principal du simulateur sur mobile : le visiteur est chez lui.
   * Un bouton lui évite de taper son adresse — et le géocodage inverse remplit
   * quand même le champ, pour qu'il vérifie et que le lead porte une adresse
   * exploitable par le commercial. */
  Simulator.prototype._useMyPosition = function (btn) {
    var self = this;
    var msg = this.geoMsg;
    function dire(texte, erreur) {
      msg.textContent = texte;
      msg.style.display = texte ? 'block' : 'none';
      msg.classList.toggle('is-error', !!erreur);
    }
    function rendreBouton() {
      if (!btn) return;
      btn.disabled = false;
      btn.textContent = '📍 Je suis chez moi — me localiser';
    }

    if (!navigator.geolocation) {
      return dire('Votre navigateur ne sait pas vous localiser : saisissez votre adresse ci-dessus.', true);
    }
    // L'API n'est disponible qu'en HTTPS (localhost excepté) : autant l'expliquer
    // plutôt que de laisser le navigateur refuser sans raison apparente.
    if (typeof location !== 'undefined' && location.protocol !== 'https:' &&
      ['localhost', '127.0.0.1', ''].indexOf(location.hostname) === -1) {
      return dire('La localisation nécessite une connexion sécurisée (https). Saisissez votre adresse ci-dessus.', true);
    }

    if (btn) { btn.disabled = true; btn.textContent = '📍 Localisation en cours…'; }
    dire('Recherche de votre position…');

    navigator.geolocation.getCurrentPosition(function (pos) {
      rendreBouton();
      var lat = pos.coords.latitude, lng = pos.coords.longitude;
      var precision = pos.coords.accuracy || 0;
      // Position peu précise (Wi-Fi / réseau plutôt que GPS) : on dézoome un peu
      // et on le dit, plutôt que d'afficher le toit du voisin avec assurance.
      var approx = precision > 100;
      self._selectAddress({
        label: 'Ma position', lat: lat, lng: lng, geolocalisee: true, precisionM: Math.round(precision)
      }, approx ? 18 : 19);
      self._markMyPosition(lat, lng, precision);

      dire('');   // l'étape 1 va disparaître : le message utile va sur la carte

      // Géocodage inverse : remplit le champ adresse pour vérification et pour le lead
      fetch('https://data.geopf.fr/geocodage/reverse?index=address&limit=1&lon=' + lng + '&lat=' + lat)
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (json) {
          var f = (json && json.features && json.features[0]) || null;
          if (!f || !f.properties || !f.properties.label) return;
          self.state.address.label = f.properties.label;
          self.acInput.value = f.properties.label;
          self._refresh();
        })
        .catch(function () { /* sans adresse lisible, la position seule suffit */ });

      // Le message part sur la carte : l'étape 1 n'est plus affichée après _goStep(2)
      self._goStep(2);
      self.mapHint.textContent = approx
        ? '📍 Position approximative (± ' + Math.round(precision) + ' m) : vérifiez que la carte est bien sur VOTRE toit, ' +
          'ajustez-la au doigt, ou revenez à l’étape 1 pour saisir votre adresse'
        : '📍 Vous êtes ici (± ' + Math.round(precision) + ' m) — ' + self.tapLow +
          ' votre bâtiment en surbrillance pour le sélectionner';
    }, function (err) {
      rendreBouton();
      var textes = {
        1: 'Localisation refusée. Autorisez-la dans les réglages de votre navigateur, ou saisissez votre adresse ci-dessus.',
        2: 'Position indisponible pour le moment (GPS ou réseau). Saisissez votre adresse ci-dessus.',
        3: 'La localisation prend trop de temps. Réessayez à l’extérieur, ou saisissez votre adresse ci-dessus.'
      };
      dire(textes[err && err.code] || 'Localisation impossible : saisissez votre adresse ci-dessus.', true);
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  };

  // Repère « vous êtes ici » + cercle de précision, effacé dès qu'un pan est dessiné
  Simulator.prototype._markMyPosition = function (lat, lng, precision) {
    if (!this.layerMe) this.layerMe = L.layerGroup().addTo(this.map);
    this.layerMe.clearLayers();
    if (precision > 5) {
      L.circle([lat, lng], {
        radius: Math.min(precision, 400),
        color: '#2563eb', weight: 1, fillColor: '#2563eb', fillOpacity: 0.10, interactive: false
      }).addTo(this.layerMe);
    }
    L.circleMarker([lat, lng], {
      radius: 6, color: '#fff', weight: 2, fillColor: '#2563eb', fillOpacity: 1, interactive: false
    }).addTo(this.layerMe);
  };

  Simulator.prototype._selectAddress = function (addr, zoom) {
    this.state.address = addr;
    this.acInput.value = addr.label;
    this.map.setView([addr.lat, addr.lng], zoom || 19);
    this.mapHint.textContent = '🏠 ' + this.tap + ' votre bâtiment en surbrillance pour le sélectionner (même si l’adresse est tombée à côté)';
    this._fetchGoogleSolar();
    this._refresh();
    this._refreshBuildings();
  };

  /* ---------------- Google Solar API (optionnel, clé payante) ----------------
   * Si une clé est configurée, on interroge buildingInsights:findClosest pour
   * détecter les pans de toit (contour approché, inclinaison, orientation) et
   * proposer un pré-remplissage en un clic. Sans clé ou hors couverture, le
   * dessin manuel reste le parcours normal. */
  Simulator.prototype._fetchGoogleSolar = function (coords) {
    var self = this;
    this.googleSolar = null;
    this._gsAdded = {}; // nouveaux segments = nouveaux index
    this._renderGoogleSolar();
    var key = this.cfg.googleSolarApiKey;
    // coords : centre d'un bâtiment sélectionné (prioritaire sur le point d'adresse)
    var a = coords || this.state.address;
    if (!key || !a || (a.manual && !coords)) return;
    this.googleSolar = 'loading';
    this._renderGoogleSolar();
    // Abandon après 8 s : hors couverture ou réseau lent, on rebascule sans bruit sur le dessin manuel
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (ctrl) setTimeout(function () { ctrl.abort(); }, 8000);
    fetch('https://solar.googleapis.com/v1/buildingInsights:findClosest' +
      '?location.latitude=' + a.lat + '&location.longitude=' + a.lng +
      '&requiredQuality=MEDIUM&key=' + encodeURIComponent(key), ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (json) {
        var sp = json.solarPotential || {};
        // Potentiel de panneaux par segment, d'après le calepinage optimal de Google
        var panelsBySeg = {};
        (sp.solarPanels || []).forEach(function (p) {
          if (p.segmentIndex != null) panelsBySeg[p.segmentIndex] = (panelsBySeg[p.segmentIndex] || 0) + 1;
        });
        var segs = (sp.roofSegmentStats || [])
          .map(function (seg, i) { return { seg: seg, index: i }; })
          .filter(function (it) { return it.seg.boundingBox && it.seg.stats && it.seg.stats.areaMeters2 > 4; })
          .sort(function (x, y) { return y.seg.stats.areaMeters2 - x.seg.stats.areaMeters2; })
          .slice(0, 6);
        self.googleSolar = segs.length ? {
          segments: segs,
          panelsBySeg: panelsBySeg,
          solarPanels: sp.solarPanels || [],   // calepinage optimal de Google, production par panneau ombres incluses
          maxPanels: sp.maxArrayPanelsCount,
          panelWatts: sp.panelCapacityWatts || 400,
          maxSunshine: sp.maxSunshineHoursPerYear,
          imageryDate: json.imageryDate
        } : null;
        self._renderGoogleSolar();
      })
      .catch(function () { self.googleSolar = null; self._renderGoogleSolar(); });
  };

  Simulator.prototype._renderGoogleSolar = function () {
    var self = this;
    var box = this.gsBox;
    if (!box) return;
    box.innerHTML = '';
    if (!this.cfg.googleSolarApiKey) return;
    if (this.googleSolar === 'loading') {
      box.appendChild(el('p', { class: 'rdfsim-muted', text: '✨ Analyse automatique du toit en cours…' }));
      return;
    }
    var gs = this.googleSolar;
    if (!gs) return;
    box.appendChild(el('label', { class: 'rdfsim-label', text: '✨ Pans détectés automatiquement — ajoutez ceux à équiper' }));
    gs.segments.forEach(function (item, i) {
      var seg = item.seg;
      var az = E.norm360(Math.round(seg.azimuthDegrees || 180));
      var added = !!self._gsAdded[item.index];
      // Ensoleillement médian du pan (heures/an) + potentiel selon Google
      var q = seg.stats.sunshineQuantiles;
      var sunshine = q && q.length ? Math.round(q[Math.floor(q.length / 2)]) : null;
      var potential = gs.panelsBySeg[item.index];
      var line2 = [fmt(seg.stats.areaMeters2) + ' m²'];
      if (sunshine) line2.push('☀ ' + fmt(sunshine) + ' h/an');
      if (potential) line2.push('jusqu’à ' + potential + ' panneaux');
      var b = el('button', {
        class: 'rdfsim-gs-seg' + (added ? ' is-added' : ''), type: 'button',
        html: '<span class="rdfsim-gs-add">' + (added ? '✓' : '➕') + '</span><span>' +
          '<b>Pan ' + (i + 1) + ' — ' + azLabel(az) + ' (' + az + '°) · pente ' + Math.round(seg.pitchDegrees || 0) + '°</b>' +
          '<small>' + line2.join(' · ') + '</small></span>',
        onclick: function () { if (!self._gsAdded[item.index]) self._applyGoogleSegment(item); }
      });
      box.appendChild(b);
    });
    var note = 'Contours approchés (boîtes englobantes) : affinez en redessinant si besoin. Source : API Google Solar';
    if (gs.imageryDate) note += ', imagerie ' + (gs.imageryDate.month || '?') + '/' + (gs.imageryDate.year || '?');
    box.appendChild(el('p', { class: 'rdfsim-muted', style: 'margin:2px 0 10px', text: note + '.' }));
  };

  // Ajoute le segment Google comme un pan supplémentaire (cumulable), en emportant
  // ses données d'ombrage : ensoleillement du pan + production par panneau selon
  // Google (calculée sur le modèle 3D du quartier : bâtiments voisins, arbres, relief).
  Simulator.prototype._applyGoogleSegment = function (item) {
    var seg = item.seg;
    var gs = this.googleSolar || {};
    var sw = seg.boundingBox.sw, ne = seg.boundingBox.ne;
    this._gsAdded[item.index] = true;
    this._setDrawMode(null);
    var q = seg.stats.sunshineQuantiles || [];
    var z = this._addZone([
      { lat: sw.latitude, lng: sw.longitude },
      { lat: sw.latitude, lng: ne.longitude },
      { lat: ne.latitude, lng: ne.longitude },
      { lat: ne.latitude, lng: sw.longitude }
    ], Math.max(0, Math.min(60, Math.round(seg.pitchDegrees || 30))),
      E.norm360(Math.round(seg.azimuthDegrees || 180)));
    z.google = {
      medianSunshine: q.length ? q[Math.floor(q.length / 2)] : null,
      maxSunshine: gs.maxSunshine || null,
      panelWatts: gs.panelWatts || 400,
      panels: (gs.solarPanels || [])
        .filter(function (p) { return p.segmentIndex === item.index && p.center; })
        .map(function (p) { return { lat: p.center.latitude, lng: p.center.longitude, e: p.yearlyEnergyDcKwh }; })
    };
    // Toit à deux versants ? Les boîtes Google sont légèrement décalées : on
    // soude les faîtages, unit les largeurs et accorde les pentes.
    var harmonized = this._harmonizeZones();
    if (harmonized) {
      this.mapHint.textContent = '⚖ Toit symétrique reconnu : faîtage soudé, largeurs unifiées et pentes accordées';
      this._syncZoneControls();
    }
    this._relayout(); // recalcul avec les données d'ombrage attachées au pan
    this._fitAllZones();
    this._renderGoogleSolar();
  };

  // Reconnaît les paires de versants opposés parmi les pans issus de Google
  // et les harmonise (géométrie pure dans le moteur). Idempotent.
  Simulator.prototype._harmonizeZones = function () {
    var s = this.state;
    if (s.zones.length < 2) return 0;
    var origin = s.zones[0].points[0];
    var count = 0;
    for (var i = 0; i < s.zones.length; i++) {
      for (var j = i + 1; j < s.zones.length; j++) {
        var zi = s.zones[i], zj = s.zones[j];
        if (!zi.google || !zj.google) continue;
        var res = E.harmonizeGablePair(
          { poly: E.toLocalMeters(zi.points, origin), azimuth: zi.azimuth, tilt: zi.tilt },
          { poly: E.toLocalMeters(zj.points, origin), azimuth: zj.azimuth, tilt: zj.tilt }
        );
        if (!res) continue;
        zi.points = res.a.poly.map(function (p) { return E.toLatLng(p, origin); });
        zi.azimuth = Math.round(res.a.azimuth);
        zi.tilt = res.a.tilt;
        zj.points = res.b.poly.map(function (p) { return E.toLatLng(p, origin); });
        zj.azimuth = Math.round(res.b.azimuth);
        zj.tilt = res.b.tilt;
        zi.harmonized = zj.harmonized = true;
        count++;
      }
    }
    return count;
  };

  Simulator.prototype._fitAllZones = function () {
    var pts = [];
    this.state.zones.forEach(function (z) { pts = pts.concat(z.points); });
    if (pts.length) this.map.fitBounds(L.latLngBounds(pts), { padding: [70, 70] });
  };

  /* ---------------- Bâtiments sélectionnables (BD TOPO, IGN — gratuit) ----------------
   * L'adresse géocodée tombe parfois à côté de la maison : dès que la carte est
   * zoomée sur le quartier, les emprises des bâtiments s'affichent et se mettent
   * en surbrillance au survol — un clic/toucher sélectionne le bâtiment comme
   * toiture (cumulable), et la détection Google Solar est relancée à son centre. */

  Simulator.prototype._buildingsWanted = function () {
    var s = this.state;
    return !!s.address && !s.drawMode && (s.step === 1 || s.step === 2) &&
      this.map.getZoom() >= 17;
  };

  Simulator.prototype._refreshBuildings = function () {
    var self = this;
    if (!this.layerBuildings) return; // appelé avant l'initialisation de la carte
    this.layerBuildings.clearLayers();
    if (!this._buildingsWanted()) return;
    var b = this.map.getBounds();
    var url = 'https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature' +
      '&TYPENAMES=BDTOPO_V3:batiment&SRSNAME=CRS:84&OUTPUTFORMAT=application/json&COUNT=60' +
      '&BBOX=' + b.getWest() + ',' + b.getSouth() + ',' + b.getEast() + ',' + b.getNorth() + ',CRS:84';
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (ctrl) setTimeout(function () { ctrl.abort(); }, 8000);
    fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (json) {
        if (!self._buildingsWanted()) return; // l'état a pu changer pendant la requête
        (json.features || []).forEach(function (f, fi) {
          if (!f.geometry || (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon')) return;
          var id = (f.properties && f.properties.cleabs) || f.id || ('b' + fi);
          if (self._usedBuildings[id]) return;
          var ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
          var latlngs = ring.map(function (p) { return { lat: p[1], lng: p[0] }; });
          if (latlngs.length > 1 &&
            latlngs[0].lat === latlngs[latlngs.length - 1].lat &&
            latlngs[0].lng === latlngs[latlngs.length - 1].lng) latlngs.pop();
          if (latlngs.length < 3) return;
          var base = { color: '#ffffff', weight: 1.5, dashArray: '4 3', fillColor: '#f59e0b', fillOpacity: 0.07, className: 'rdfsim-building' };
          var hover = { color: '#f59e0b', weight: 3, dashArray: null, fillColor: '#f59e0b', fillOpacity: 0.32 };
          var poly = L.polygon(latlngs, base);
          poly.on('mouseover', function () { poly.setStyle(hover); });
          poly.on('mouseout', function () { poly.setStyle(base); });
          poly.bindTooltip('🏠 ' + self.tap + ' pour sélectionner ce bâtiment', { sticky: true, direction: 'top' });
          poly.on('click', function (ev) {
            L.DomEvent.stopPropagation(ev);
            self._selectBuilding(id, latlngs);
          });
          poly.addTo(self.layerBuildings);
        });
      })
      .catch(function () { /* service indisponible : le dessin manuel reste possible */ });
  };

  Simulator.prototype._selectBuilding = function (id, latlngs) {
    this._usedBuildings[id] = true;
    var prev = this._zone();
    this._addZone(latlngs.slice(), prev ? prev.tilt : 30, null, true);
    // La détection Google repart du centre réel du bâtiment choisi,
    // pas du point d'adresse (qui peut être tombé à côté)
    var cLat = 0, cLng = 0;
    latlngs.forEach(function (p) { cLat += p.lat; cLng += p.lng; });
    this._fetchGoogleSolar({ lat: cLat / latlngs.length, lng: cLng / latlngs.length });
    if (this.state.step === 1) this._goStep(2);
    this.mapHint.textContent = '✓ Bâtiment sélectionné ! Réglez la pente ci-dessus — ' +
      this.tapLow + ' un autre bâtiment pour le cumuler';
    this._refreshBuildings();
  };

  /* ---------------- Contour de bâtiment (BD TOPO, IGN — gratuit) ----------------
   * Google Solar ne fournit pas les contours exacts des pans (seulement des boîtes) ;
   * la BD TOPO de l'IGN fournit, elle, l'emprise précise du bâtiment. On la propose
   * comme point de départ : l'utilisateur la découpe ensuite en pans s'il le souhaite. */
  Simulator.prototype._fetchBuildingFootprint = function () {
    var self = this;
    var a = this.state.address;
    var c = (a && !a.manual) ? a : { lat: this.map.getCenter().lat, lng: this.map.getCenter().lng };
    this.mapHint.textContent = '🏠 Recherche du contour du bâtiment (IGN)…';
    var d = 0.0006; // ~60 m autour du point
    var url = 'https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature' +
      '&TYPENAMES=BDTOPO_V3:batiment&SRSNAME=CRS:84&OUTPUTFORMAT=application/json&COUNT=30' +
      '&BBOX=' + (c.lng - d) + ',' + (c.lat - d) + ',' + (c.lng + d) + ',' + (c.lat + d) + ',CRS:84';
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (ctrl) setTimeout(function () { ctrl.abort(); }, 8000);
    fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (json) {
        var feats = (json.features || []).filter(function (f) {
          return f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon');
        });
        if (!feats.length) throw new Error('vide');
        // Bâtiment contenant le point, sinon celui dont le centre est le plus proche
        function ringOf(f) {
          return f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
        }
        function contains(ring, lng, lat) {
          var inside = false;
          for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            if (((ring[i][1] > lat) !== (ring[j][1] > lat)) &&
              (lng < (ring[j][0] - ring[i][0]) * (lat - ring[i][1]) / (ring[j][1] - ring[i][1]) + ring[i][0])) {
              inside = !inside;
            }
          }
          return inside;
        }
        var pick = feats.filter(function (f) { return contains(ringOf(f), c.lng, c.lat); })[0];
        if (!pick) {
          feats.sort(function (f1, f2) {
            function d2(f) {
              var r = ringOf(f), sx = 0, sy = 0;
              r.forEach(function (p) { sx += p[0]; sy += p[1]; });
              return Math.pow(sx / r.length - c.lng, 2) + Math.pow(sy / r.length - c.lat, 2);
            }
            return d2(f1) - d2(f2);
          });
          pick = feats[0];
        }
        var ring = ringOf(pick);
        var points = ring.map(function (p) { return { lat: p[1], lng: p[0] }; });
        // Le premier et le dernier point d'un anneau GeoJSON sont identiques
        if (points.length > 1 &&
          points[0].lat === points[points.length - 1].lat &&
          points[0].lng === points[points.length - 1].lng) points.pop();
        if (points.length < 3) throw new Error('contour invalide');
        self._setDrawMode(null);
        self._addZone(points, 30, null, true);
        self._fitAllZones();
        self.mapHint.textContent = '🏠 Contour récupéré (IGN BD TOPO) — réglez la pente, ou supprimez-le et découpez en plusieurs pans';
      })
      .catch(function () {
        self.mapHint.textContent = 'Contour de bâtiment indisponible ici — dessinez la toiture à la main';
      });
  };

  /* ---------------- Navigation entre étapes ---------------- */
  Simulator.prototype._updateStepBar = function () {
    var s = this.state;
    Object.keys(this.stepBtns).forEach(function (k) {
      var b = this.stepBtns[k];
      b.classList.toggle('is-active', +k === s.step);
      b.classList.toggle('is-done', +k < s.step);
      b.disabled = (+k >= 2 && !s.address) || (+k >= 3 && !s.zones.length);
    }, this);
  };

  Simulator.prototype._goStep = function (n) {
    var s = this.state;
    if (n >= 2 && !s.address) { this.mapHint.textContent = 'Choisissez d’abord une adresse'; n = 1; }
    if (n >= 3 && !s.zones.length) { if (s.address) this.mapHint.textContent = 'Dessinez d’abord votre toiture'; n = Math.min(n, 2); }
    s.step = n;
    this._updateStepBar();

    // Classe d'étape sur la racine : la mise en page mobile adapte la hauteur de carte
    for (var st = 1; st <= 4; st++) this.root.classList.toggle('rdfsim--step' + st, st === n);

    this.sideScroll.innerHTML = '';
    this.sideScroll.appendChild(this.panels[n]);
    this.sideAction.innerHTML = '';
    if (this.actions[n]) this.sideAction.appendChild(this.actions[n]);
    this.sideScroll.scrollTop = 0;
    this._refreshAction();
    this.mapTools.style.display = n === 2 ? 'flex' : 'none';
    if (this._navigated) this._scrollTo(this.root); // sur mobile : chaque étape repart du haut (jamais au chargement)
    this._navigated = true;

    // À l'arrivée sur l'étape toiture : proposer la sélection de bâtiment plutôt
    // que d'imposer le dessin (le mode dessin reste à un clic sur « Ajouter un pan »)
    if (n === 2 && !s.zones.length && !s.drawMode) {
      this.mapHint.textContent = '🏠 ' + this.tap + ' votre bâtiment en surbrillance — ou « Ajouter un pan » pour dessiner';
    }
    if (n !== 2 && s.drawMode) this._setDrawMode(null);
    this._refreshBuildings();
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
    // Ordre d'affichage : l'offre mise en avant d'abord, le reste dans l'ordre
    // du catalogue. `sort` est stable, donc les non mises en avant ne bougent
    // pas entre elles — l'installateur garde la main sur son propre ordre.
    var ordre = this.catalog.offres.slice().sort(function (a, b) {
      return (b.misEnAvant ? 1 : 0) - (a.misEnAvant ? 1 : 0);
    });
    ordre.forEach(function (o) {
      var pan = self.catalog.panneaux.filter(function (p) { return p.id === o.panneauId; })[0] || {};
      var card = el('button', {
        class: 'rdfsim-offer' + (o.id === self.state.offerId ? ' is-on' : '') +
          (o.misEnAvant ? ' is-mise-en-avant' : ''), type: 'button'
      }, [
        o.misEnAvant ? el('span', { class: 'rdfsim-offer-badge', text: o.badge || 'Recommandé' }) : null,
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
        self.state.pilotageId = o.pilotageId || (self.catalog.pilotage[0] || {}).id;
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
      self.state.inverterId = v; self._renderComponents(); self._refreshSizing();
    });
    selector('Batterie de stockage', this.catalog.batteries, this.state.batteryId, function (v) {
      self.state.batteryId = v; self._renderComponents(); self._refreshSizing();
    }, function (b) { return b.prix ? ' — +' + fmt(b.prix) + ' € HT' : ''; });

    // Le pilotage (EMS) est une CONDITION de la TVA à 5,5 % : on l'affiche comme tel,
    // et il améliore réellement le taux d'autoconsommation — seul levier de rentabilité
    // depuis la suppression de la prime et l'effondrement du tarif de rachat.
    if ((this.catalog.pilotage || []).length > 1) {
      selector('Pilotage de l’autoconsommation', this.catalog.pilotage, this.state.pilotageId, function (v) {
        self.state.pilotageId = v; self._renderComponents(); self._refreshSizing();
      }, function (p) { return p.prix ? ' — +' + fmt(p.prix) + ' € HT' : ''; });
    }

    // Condition « local à usage d'habitation » du taux réduit
    var residCb = el('input', { type: 'checkbox' });
    residCb.checked = this.state.residentiel !== false;
    residCb.addEventListener('change', function () {
      self.state.residentiel = residCb.checked;
      self._refreshSizing();
    });
    var residLabel = el('label', { class: 'rdfsim-check' }, [
      residCb, el('span', { text: 'Installation sur un logement d’habitation (condition de la TVA à 5,5 %)' })
    ]);
    this.componentsBox.appendChild(residLabel);
  };

  // Un changement d'équipement ou de consommation modifie le dimensionnement
  // conseillé : il faut alors repasser par le calepinage, pas seulement par
  // l'affichage des chiffres.
  Simulator.prototype._refreshSizing = function () {
    if (this.state.sizingMode === 'auto' && this.state.panels.length) this._relayout();
    else this._refresh();
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
    if (this.sizingBox) {
      this.sizingBox.innerHTML = '';
      var sizingCard = this._renderSizingCard();
      if (sizingCard) this.sizingBox.appendChild(sizingCard);
    }
    if (this.limitBox) {
      this.limitBox.innerHTML = '';
      var limitCard = this._renderLimitCard();
      if (limitCard) this.limitBox.appendChild(limitCard);
    }
    if (this.state.step === 4) this._renderResults();
    // Régler l'inclinaison d'un pan qui n'existe pas encore n'a aucun sens :
    // la carte de réglages n'apparaît qu'une fois la toiture tracée.
    if (this.reglagesCard) {
      this.reglagesCard.style.display = this.state.zones.length ? '' : 'none';
    }
    // Le résumé de la barre d'action suit chaque réglage : c'est ce chiffre qui
    // bouge qui donne au visiteur le sentiment d'avancer.
    this._refreshAction();
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
    var tarifs = this.catalog.tarifs || {};
    var horizon = tarifs.horizonAns || 25;

    var shadingLabel = c.shadingLevel === 'full'
      ? ' · ombres du voisinage incluses ✓ (Google Solar)'
      : (c.shadingLevel === 'partial' ? ' · ombres incluses sur les pans détectés (Google Solar)' : '');
    var sourceLabel = c.prod.source === 'pvgis'
      ? ' · données PVGIS ✓ (relief inclus)'
      : (c.prod.source === 'partial' ? ' · données PVGIS sur une partie des pans'
        : (c.prod.pending ? ' · affinage PVGIS en cours…' : ''));
    shadingLabel += sourceLabel;
    // Hiérarchie des résultats. Le chiffre en tête est l'économie annuelle, pas
    // la production : personne n'a de repère sur ce que valent 11 000 kWh, tout
    // le monde en a un sur ce que valent 1 400 € par an. La production et le
    // temps de retour suivent immédiatement — le premier justifie le second, et
    // les deux ensemble sont ce que le visiteur ira comparer ailleurs.
    var grid = el('div', { class: 'rdfsim-results-grid' }, [
      el('div', { class: 'rdfsim-kpi is-hero' }, [
        el('div', { class: 'rdfsim-kpi-v', html: eur(c.fin.annualSavings) + ' <small>par an</small>' }),
        el('div', { class: 'rdfsim-kpi-l', text: 'Économies dès la première année — facture évitée et surplus revendu' })
      ]),
      kpi(payback, 'retour sur investissement', 'is-fort'),
      kpi(fmt(c.prod.annualKwh) + ' kWh/an',
        'production estimée — ' + fmt(c.prod.specificYield) + ' kWh/kWc' + shadingLabel, 'is-fort'),
      kpi(eur(c.installCost), 'coût TTC (' + c.offer.nom + ', TVA ' + fmt(c.cost.rate * 100, 1) + ' %)'),
      kpi(fmt(c.kwc, 2) + ' kWc', c.n + ' panneaux ' + c.panel.puissanceWc + ' Wc'),
      kpi(Math.round(c.fin.selfConsumptionRate * 100) + ' %',
        'autoconsommation' + (c.pilotage && c.pilotage.ems ? ' (avec pilotage)' : ' — sans pilotage')),
      kpi(eur(c.fin.gainNetHorizon), 'gain net cumulé sur ' + horizon + ' ans'),
      kpi(fmt(c.fin.co2SavedKg) + ' kg', 'CO₂ évité chaque année'),
      kpi(fmt(c.fin.surplusKwh) + ' kWh', 'surplus injecté sur le réseau')
    ]);
    function kpi(v, l, classe) {
      return el('div', { class: 'rdfsim-kpi' + (classe ? ' ' + classe : '') }, [
        el('div', { class: 'rdfsim-kpi-v', text: v }),
        el('div', { class: 'rdfsim-kpi-l', text: l })
      ]);
    }
    box.appendChild(grid);

    var sizingCard = this._renderSizingCard();
    if (sizingCard) box.appendChild(sizingCard);

    // --- Décomposition des économies : d'où vient l'argent ---------------
    box.appendChild(el('div', { class: 'rdfsim-card' }, [
      el('h4', { text: 'D’où viennent vos ' + eur(c.fin.annualSavings) + ' par an ?' }),
      el('div', { class: 'rdfsim-split' }, [
        el('div', { class: 'rdfsim-split-part is-main' }, [
          el('b', { text: eur(c.fin.savingsSelf) }),
          el('span', { text: fmt(c.fin.selfConsumedKwh) + ' kWh que vous ne payez plus à votre fournisseur (' + fmt((tarifs.prixKwhReseau || 0.2001) * 100, 1) + ' c€/kWh)' })
        ]),
        el('div', { class: 'rdfsim-split-part' }, [
          el('b', { text: eur(c.fin.savingsSurplus) }),
          el('span', { text: fmt(c.fin.surplusKwh) + ' kWh de surplus vendus au réseau (' + fmt((tarifs.tarifRachatSurplus || 0.011) * 100, 1) + ' c€/kWh)' })
        ])
      ]),
      el('p', {
        class: 'rdfsim-muted', style: 'margin:10px 0 0',
        text: 'Depuis l’arrêté du 4 juin 2026, le surplus n’est plus racheté que 1,1 c€/kWh : la rentabilité se joue désormais sur l’électricité que vous consommez vous-même. C’est exactement ce que le pilotage intelligent optimise.'
      })
    ]));

    // --- Éligibilité à la TVA à 5,5 % ------------------------------------
    box.appendChild(this._renderVatCard(c));

    // Graphique de production mensuelle
    var chartCard = el('div', { class: 'rdfsim-card rdfsim-chart-card' }, [
      el('h4', { text: 'Production mensuelle estimée (kWh)' })
    ]);
    chartCard.appendChild(this._buildChart(c.prod.monthly));
    box.appendChild(chartCard);

    // CTA devis — et le moment où on le demande.
    //
    // La demande de coordonnées reste à la fin, après les chiffres. La placer
    // avant le détail financier ferait remonter le volume de leads, mais le
    // produit vendu à l'installateur n'est pas un volume : c'est un contact qui
    // a vu son toit calepiné, son coût et son temps de retour, et qui demande
    // quand même à être rappelé. Un formulaire posé avant les chiffres capte
    // aussi les curieux qui seraient partis en les voyant — l'installateur les
    // rappelle et les perd, et c'est lui qui paie l'abonnement.
    var brand = this.catalog.brand || {};
    var cta = el('div', { class: 'rdfsim-card' }, [
      el('h3', { text: 'Concrétisez votre projet' }),
      el('p', { class: 'rdfsim-muted', text: 'Recevez une étude personnalisée et un devis gratuit par un conseiller' + this._brandSuffix() + ', sur la base de cette simulation.' }),
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
          class: 'rdfsim-btn rdfsim-btn-ghost', type: 'button', text: '🖨 Imprimer / PDF',
          onclick: function () { self._printRecap(c); }
        }),
        el('button', {
          class: 'rdfsim-btn rdfsim-btn-ghost', type: 'button', text: 'Copier le récap',
          onclick: function (ev) {
            var btn = ev.currentTarget;
            navigator.clipboard.writeText(self._summaryText(c)).then(function () {
              btn.textContent = '✓ Copié !';
              setTimeout(function () { btn.textContent = 'Copier le récap'; }, 1800);
            });
          }
        })
      ]),
      el('p', {
        class: 'rdfsim-disclaimer',
        html: 'Estimation indicative et non contractuelle. ' +
          (c.prod.source === 'pvgis'
            ? 'Production calculée par <b>PVGIS</b> (Commission européenne) à partir de données satellitaires long terme, ' +
              'relief environnant (masques lointains) et température des modules inclus. '
            : (c.prod.source === 'partial'
              ? 'Production calculée par PVGIS sur une partie des pans, par le modèle régional embarqué pour les autres. '
              : 'Production calculée par le modèle régional embarqué (± 10 % environ). ')) +
          (c.shadingLevel === 'full'
            ? 'Les ombres portées par le voisinage (bâtiments, arbres, relief) sont intégrées au calcul via le modèle 3D de Google Solar. '
            : (c.shadingLevel === 'partial'
              ? 'Les ombres du voisinage sont intégrées sur les pans détectés automatiquement ; les pans dessinés à la main utilisent l’ensoleillement régional moyen. '
              : 'Calcul basé sur l’ensoleillement moyen régional, sans les ombres du voisinage. ')) +
          'Les arbres plantés dans le simulateur servent à visualiser l’ombrage en 3D mais ne sont pas déduits du calcul. La visite technique (avec relevé drone) affine précisément ces valeurs. ' +
          'Projection sur ' + horizon + ' ans : dégradation des modules ' + fmt((tarifs.degradationAnnuelle || 0.004) * 100, 1) +
          ' %/an, hausse du prix de l’électricité ' + fmt((tarifs.inflationElectricite || 0.03) * 100, 0) +
          ' %/an, tarif d’achat du surplus indexé ' + fmt((tarifs.indexationRachatAnnuelle || 0.02) * 100, 0) + ' %/an sur 20 ans. ' +
          (this.catalog.tarifs && this.catalog.tarifs.note ? this.catalog.tarifs.note : '')
      }),
      el('p', {
        class: 'rdfsim-disclaimer',
        html: '<b>Cadre réglementaire appliqué</b> — ' +
          (this.catalog.tarifs && this.catalog.tarifs.bareme
            ? this.catalog.tarifs.bareme
            : 'Arrêté tarifaire du 4 juin 2026 : prime à l’autoconsommation supprimée, surplus racheté 1,1 c€/kWh HT, vente totale interdite en dessous de 9 kWc. TVA à 5,5 % sous conditions cumulatives.') +
          (this.catalog.tarifs && this.catalog.tarifs.dateMaj ? ' Barème à jour au ' +
            new Date(this.catalog.tarifs.dateMaj).toLocaleDateString('fr-FR') + '.' : '')
      })
    ]);
    box.appendChild(cta);
  };

  /* ---------------- Carte « éligibilité TVA 5,5 % » ----------------
   * Depuis le 1er octobre 2025, les installations ≤ 9 kWc en résidentiel
   * bénéficient du taux réduit — à cinq conditions CUMULATIVES. C'est devenu
   * le principal avantage financier du photovoltaïque résidentiel : autant le
   * rendre lisible, et proposer au visiteur de corriger ce qui manque. */
  Simulator.prototype._renderVatCard = function (c) {
    var self = this;
    var v = c.vat;
    var card = el('div', { class: 'rdfsim-card rdfsim-vat' + (v.eligible ? ' is-ok' : ' is-warn') });

    card.appendChild(el('div', { class: 'rdfsim-vat-head' }, [
      el('span', { class: 'rdfsim-badge' + (v.eligible ? ' is-ok' : ''), text: v.eligible ? '✓ TVA 5,5 %' : 'TVA 20 %' }),
      el('h4', {
        text: v.eligible
          ? 'Votre installation bénéficie de la TVA à 5,5 %'
          : 'Votre installation est actuellement à 20 % de TVA'
      })
    ]));

    card.appendChild(el('p', {
      class: 'rdfsim-muted',
      text: v.eligible
        ? 'Soit ' + eur(c.ecartTva) + ' d’économie par rapport au taux normal de 20 %, déjà déduits du prix affiché.'
        : 'Il manque ' + v.manquantes.length + ' condition' + (v.manquantes.length > 1 ? 's' : '') +
          ' pour bénéficier du taux réduit — soit ' + eur(c.ecartTva) + ' d’écart sur votre projet.'
    }));

    card.appendChild(el('ul', { class: 'rdfsim-elig' }, v.conditions.map(function (cond) {
      return el('li', { class: cond.ok ? 'is-ok' : 'is-ko' }, [
        el('span', { class: 'rdfsim-elig-mark', text: cond.ok ? '✓' : '✗' }),
        el('span', { text: cond.label })
      ]);
    })));

    // Le seul critère que le visiteur peut corriger en un clic : le pilotage (EMS)
    var emsKo = v.manquantes.filter(function (m) { return m.id === 'ems'; }).length > 0;
    var emsOffer = (this.catalog.pilotage || []).filter(function (p) { return p.ems; })[0];
    if (emsKo && emsOffer) {
      var gainNet = c.ecartTva - (emsOffer.prix || 0) * (1 + v.reduit);
      card.appendChild(el('button', {
        class: 'rdfsim-btn rdfsim-btn-primary', type: 'button',
        text: '⚡ Ajouter ' + emsOffer.nom + ' → passer à 5,5 %',
        onclick: function () {
          self.state.pilotageId = emsOffer.id;
          self._renderComponents();
          self._refresh();
        }
      }));
      card.appendChild(el('p', {
        class: 'rdfsim-muted', style: 'margin:8px 0 0',
        text: gainNet > 0
          ? 'Le pilotage coûte ' + eur((emsOffer.prix || 0) * (1 + v.reduit)) + ' TTC et fait baisser la TVA de ' +
            eur(c.ecartTva) + ' : l’opération vous rapporte ' + eur(gainNet) + ' — et augmente votre autoconsommation.'
          : 'Le pilotage augmente votre autoconsommation et ouvre droit au taux réduit de TVA.'
      }));
    }

    if (!v.conditions[0].ok && c.kwc > v.seuilKwc) {
      card.appendChild(el('p', {
        class: 'rdfsim-muted', style: 'margin:8px 0 0',
        text: 'Au-delà de ' + v.seuilKwc + ' kWc, la TVA est de 20 %. Retirez des panneaux sur la carte pour repasser sous le seuil, ou demandez-nous l’étude des deux scénarios.'
      }));
    }
    return card;
  };

  Simulator.prototype._summaryText = function (c) {
    var s = this.state;
    return [
      '— Simulation photovoltaïque' + this._brandSuffix() + ' —',
      'Adresse : ' + (s.address ? s.address.label : '—'),
      'Offre : ' + c.offer.nom + ' | Panneau : ' + c.panel.nom + ' | Onduleur : ' + c.inverter.nom + ' | ' + c.battery.nom,
      'Installation : ' + c.n + ' panneaux, ' + fmt(c.kwc, 2) + ' kWc sur ' + c.zones.length + ' pan(s) — ' +
        c.zones.map(function (z, i) { return 'pan ' + (i + 1) + ' : ' + z.n + ' panneaux, ' + z.tilt + '° ' + azLabel(z.azimuth); }).join(' · '),
      'Production estimée : ' + fmt(c.prod.annualKwh) + ' kWh/an (' + fmt(c.prod.specificYield) + ' kWh/kWc)' +
        (c.prod.source === 'pvgis' ? ' — données PVGIS' : (c.prod.source === 'partial' ? ' — PVGIS partiel' : '')) +
        (c.shadingLevel !== 'none' ? ' — ombres du voisinage intégrées (Google Solar' + (c.shadingLevel === 'partial' ? ', pans détectés' : '') + ')' : ''),
      'Pilotage : ' + (c.pilotage ? c.pilotage.nom : '—'),
      'Autoconsommation : ' + Math.round(c.fin.selfConsumptionRate * 100) + ' % | Économies : ' + eur(c.fin.annualSavings) +
        '/an (dont ' + eur(c.fin.savingsSelf) + ' autoconsommés, ' + eur(c.fin.savingsSurplus) + ' de surplus)',
      'Coût : ' + eur(c.cost.ht) + ' HT + TVA ' + fmt(c.cost.rate * 100, 1) + ' % = ' + eur(c.cost.ttc) + ' TTC' +
        (c.vat.eligible ? ' (TVA réduite : ' + eur(c.ecartTva) + ' économisés)' : ' (taux réduit non atteint : ' +
          c.vat.manquantes.map(function (m) { return m.label; }).join(', ') + ')'),
      'Retour sur investissement : ' + (isFinite(c.fin.paybackYears) ? fmt(c.fin.paybackYears, 1) + ' ans' : '—') +
        ' | Gain net cumulé : ' + eur(c.fin.gainNetHorizon)
    ].join('\n');
  };

  /* ---------------- Récapitulatif imprimable (→ PDF via le navigateur) ---------------- */
  Simulator.prototype._printRecap = function (c) {
    var s = this.state;
    var brand = this.catalog.brand || {};
    var monthsFull = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
      'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
    var chartSvg = this.resultsBox.querySelector('.rdfsim-chart svg');
    var payback = isFinite(c.fin.paybackYears) ? fmt(c.fin.paybackYears, 1) + ' ans' : '—';

    function kv(k, v) { return '<tr><td>' + k + '</td><td><b>' + v + '</b></td></tr>'; }
    var monthRows = c.prod.monthly.map(function (v, i) {
      return '<tr><td>' + monthsFull[i] + '</td><td style="text-align:right">' + fmt(v) + ' kWh</td></tr>';
    }).join('');

    var w = window.open('', '_blank');
    if (!w) { alert('Autorisez les fenêtres pop-up pour générer le récapitulatif.'); return; }
    w.document.write('<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">' +
      '<title>Simulation photovoltaïque — ' + (brand.name || 'Étude solaire') + '</title>' +
      '<style>' +
      'body{font-family:system-ui,Segoe UI,Arial,sans-serif;color:#16202b;margin:0;padding:32px;max-width:820px;margin:0 auto}' +
      '.head{display:flex;align-items:center;gap:14px;background:#0f2a43;color:#fff;padding:18px 22px;border-radius:12px}' +
      '.sun{width:34px;height:34px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#ffd166,#f59e0b)}' +
      'h1{font-size:20px;margin:0}.sub{font-size:13px;opacity:.85}' +
      'h2{font-size:15px;color:#0f2a43;border-bottom:2px solid #f59e0b;padding-bottom:4px;margin:26px 0 10px}' +
      'table{border-collapse:collapse;width:100%;font-size:13.5px}' +
      'td{padding:6px 10px;border-bottom:1px solid #e3e8ee}' +
      '.cols{display:flex;gap:24px;align-items:flex-start}.cols>div{flex:1}' +
      '.hero{background:#f6f8fa;border-radius:10px;padding:14px 18px;margin-top:14px;font-size:14px}' +
      '.hero b{font-size:24px;color:#b45309}' +
      'img.snap{max-width:100%;border-radius:10px;margin-top:8px}' +
      '.disc{font-size:11px;color:#8a97a5;margin-top:26px;line-height:1.5}' +
      '.noprint{margin:18px 0}.noprint button{padding:10px 18px;font-size:14px;font-weight:700;' +
      'background:#f59e0b;color:#fff;border:none;border-radius:8px;cursor:pointer}' +
      '@media print{.noprint{display:none}body{padding:0}}' +
      /* styles du graphique (le SVG est cloné hors du widget) */
      'svg{max-width:100%}.rdfsim-bar{fill:#b45309}.rdfsim-grid-line{stroke:#edf1f5;stroke-width:1}' +
      '.rdfsim-axis-text{fill:#8a97a5;font-size:10.5px}' +
      '.rdfsim-direct-label{fill:#51606f;font-size:10.5px;font-weight:700}' +
      '</style></head><body>' +
      '<div class="head"><span class="sun"></span><div><h1>' + (brand.name || 'Étude solaire') +
      ' — Étude photovoltaïque personnalisée</h1><div class="sub">' +
      (s.address ? s.address.label : '') + ' · ' + new Date().toLocaleDateString('fr-FR') + '</div></div></div>' +
      '<div class="noprint"><button onclick="window.print()">🖨 Imprimer / enregistrer en PDF</button></div>' +
      // Même hiérarchie que l'écran de résultats : l'économie d'abord.
      '<div class="hero">Économies estimées : <b>' + eur(c.fin.annualSavings) + '/an</b>' +
      ' &nbsp;·&nbsp; retour sur investissement : <b>' + payback + '</b>' +
      ' &nbsp;·&nbsp; production : <b>' + fmt(c.prod.annualKwh) + ' kWh/an</b></div>' +
      '<h2>Votre installation</h2><table>' +
      kv('Offre', c.offer.nom + ' — ' + (c.offer.accroche || '')) +
      kv('Panneaux', c.n + ' × ' + c.panel.nom + ' (' + fmt(c.kwc, 2) + ' kWc)') +
      kv('Onduleur', c.inverter.nom) +
      kv('Stockage', c.battery.nom) +
      kv('Toiture', fmt(c.roofArea) + ' m²' +
        (this.state.limit && this.state.limit.length >= 3
          ? ' (logement délimité par le client au sein d’un bâtiment mitoyen)' : '') +
        ' · ' + c.zones.length + ' pan(s) : ' +
        c.zones.map(function (z, i) {
          return 'pan ' + (i + 1) + ' — ' + z.n + ' panneaux, ' + z.tilt + '°, ' + azLabel(z.azimuth) +
            ' (' + fmt(z.annualKwh) + ' kWh/an' + (z.isGoogle ? ', ombrage inclus' : '') + ')';
        }).join(' · ')) +
      kv('Source des données de production', c.prod.source === 'pvgis'
        ? 'PVGIS (Commission européenne) — données satellitaires, relief et température inclus'
        : (c.prod.source === 'partial'
          ? 'PVGIS sur une partie des pans, modèle régional embarqué pour les autres'
          : 'Modèle régional embarqué (grille d’irradiation + transposition)')) +
      kv('Ombres du voisinage', c.shadingLevel === 'full'
        ? 'Intégrées sur tous les pans (modèle 3D Google Solar : bâtiments, arbres, relief)'
        : (c.shadingLevel === 'partial'
          ? 'Intégrées sur les pans détectés automatiquement (Google Solar)'
          : 'Non modélisées — à confirmer lors de la visite technique')) +
      kv('Pilotage de l’autoconsommation', (c.pilotage ? c.pilotage.nom : '—')) +
      kv('Prix', eur(c.cost.ht) + ' HT · TVA ' + fmt(c.cost.rate * 100, 1) + ' % (' + eur(c.cost.vat) + ') · <u>' +
        eur(c.cost.ttc) + ' TTC</u>') +
      kv('Taux de TVA appliqué', c.vat.eligible
        ? 'Taux réduit 5,5 % — les 5 conditions sont réunies (' + eur(c.ecartTva) + ' économisés par rapport à 20 %)'
        : 'Taux normal 20 % — condition(s) manquante(s) : ' +
          c.vat.manquantes.map(function (m) { return m.label; }).join(', ')) +
      '</table>' +
      (this._snapshot3d ? '<h2>Visualisation 3D</h2><img class="snap" src="' + this._snapshot3d + '" alt="Vue 3D de l’installation">' : '') +
      '<h2>Production et bilan annuel</h2>' +
      '<div class="cols"><div><table>' +
      kv('Production spécifique', fmt(c.prod.specificYield) + ' kWh/kWc/an') +
      kv('Taux d’autoconsommation', Math.round(c.fin.selfConsumptionRate * 100) + ' %') +
      kv('Énergie autoconsommée', fmt(c.fin.selfConsumedKwh) + ' kWh/an → ' + eur(c.fin.savingsSelf) + '/an') +
      kv('Surplus revendu', fmt(c.fin.surplusKwh) + ' kWh/an → ' + eur(c.fin.savingsSurplus) + '/an') +
      kv('Gain net cumulé', eur(c.fin.gainNetHorizon) + ' sur ' + ((this.catalog.tarifs || {}).horizonAns || 25) + ' ans') +
      kv('CO₂ évité', fmt(c.fin.co2SavedKg) + ' kg/an') +
      '</table>' + (chartSvg ? '<div style="margin-top:14px">' + chartSvg.outerHTML + '</div>' : '') +
      '</div><div><table><tr><td><b>Mois</b></td><td style="text-align:right"><b>Production</b></td></tr>' +
      monthRows + '</table></div></div>' +
      '<div class="disc">Estimation indicative et non contractuelle établie par le simulateur ' +
      (brand.name || 'Étude solaire') + ' à partir de l’ensoleillement moyen régional, de l’orientation et de ' +
      'l’inclinaison déclarées. Les ombrages proches, l’état du réseau et l’évolution des tarifs peuvent ' +
      'modifier ces valeurs.<br><b>Cadre réglementaire appliqué :</b> ' +
      ((this.catalog.tarifs || {}).bareme || 'arrêté tarifaire du 4 juin 2026 (prime supprimée, surplus 1,1 c€/kWh HT) et TVA 5,5 % sous conditions cumulatives.') +
      ((this.catalog.tarifs || {}).dateMaj ? ' Barème à jour au ' +
        new Date(this.catalog.tarifs.dateMaj).toLocaleDateString('fr-FR') + '.' : '') +
      (brand.contactEmail ? '<br>Contact : ' + brand.contactEmail : '') + '</div>' +
      '</body></html>');
    w.document.close();
  };

  /**
   * Demande de devis — passe par le même formulaire que les autres prises de
   * contact : sans nom ni téléphone, un lead n'est pas exploitable, et sans
   * consentement horodaté il n'est pas rappelable (art. L. 223-1).
   */
  Simulator.prototype._requestQuote = function (c) {
    this._openLeadModal('devis', c);
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
