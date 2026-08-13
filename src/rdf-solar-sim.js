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

  // Libellé neutre affiché tant qu'aucun installateur n'est configuré dans
  // `brand.name` : le widget ne doit jamais afficher notre marque chez un client.
  var BRAND_PLACEHOLDER = 'Simulateur solaire';

  // Catalogue de secours si offers.json est inaccessible (ouverture en file://, etc.)
  // Le bloc `brand` est volontairement VIDE : le simulateur est installé chez nos
  // clients installateurs, et les leads du visiteur appartiennent à l'installateur.
  // Un repli sur le nom ou l'adresse RDF-SOLAR ferait atterrir chez nous un lead qui
  // revient à notre client. Sans marque configurée, les canaux de contact concernés
  // ne s'affichent tout simplement pas.
  var FALLBACK_CATALOG = {
    brand: {
      name: '', contactEmail: '', devisEndpoint: '',
      phone: '', whatsapp: '', droneBookingUrl: '',
      horaires: { debut: 9, fin: 18, jours: [1, 2, 3, 4, 5], libelle: 'du lundi au vendredi, 9h–18h' },
      promesseRappel: 'Rappel sous 30 min'
    },
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
      zones: [],              // pans de toiture cumulables : { points: [latlng], tilt, azimuth }
      activeZone: -1,         // pan en cours de réglage
      obstacles: [],          // [[latlng…]] — zones à éviter, communes à tous les pans
      trees: [],              // arbres pour visualiser l'ombrage : { lat, lng, h (m) }
      drawMode: null,         // 'roof' | 'obstacle' | 'tree' | null
      landscape: false,
      excluded: {},           // panneaux retirés à la main, clé "zone:row:col"
      offerId: null,
      panelId: null,
      inverterId: null,
      batteryId: null,
      consumptionKwh: 4500,
      panels: [],             // résultat du calepinage : { zone, corners, row, col }
      origin: null
    };
    this.draftPoints = [];
    this._gsAdded = {};       // pans Google Solar déjà ajoutés (par index de segment)
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
    var first = catalog.offres[0];
    this.state.offerId = first.id;
    this.state.panelId = first.panneauId;
    this.state.inverterId = first.onduleurId;
    this.state.batteryId = first.batterieId || 'none';
    this._applyBrand();
    this._renderOffers();
    this._renderCtaBar();
    this._refresh();
  };

  // Injecte la marque de l'installateur hôte dans les éléments construits une
  // seule fois, avant le chargement du catalogue (logo, titre d'étape, pied).
  Simulator.prototype._applyBrand = function () {
    var name = this._brandName();
    if (this.logoEl) this.logoEl.textContent = name || BRAND_PLACEHOLDER;
    if (this.offerTitle) this.offerTitle.textContent = '3. Votre offre' + this._brandSuffix();
    if (this.footerBrand) {
      this.footerBrand.innerHTML = '';
      if (name) {
        this.footerBrand.appendChild(document.createTextNode('Simulateur '));
        this.footerBrand.appendChild(el('b', { text: name }));
        this.footerBrand.appendChild(document.createTextNode(' — estimation non contractuelle'));
      } else {
        this.footerBrand.textContent = 'Simulateur photovoltaïque — estimation non contractuelle';
      }
    }
  };

  /* --------- Leads visiteurs : barre de contact permanente ---------
   * VOCABULAIRE — dans tout ce fichier, « lead » désigne un LEAD VISITEUR :
   * le particulier qui simule son toit et demande à être recontacté. Ce lead
   * appartient à l'installateur qui a installé le widget (le client du SaaS),
   * jamais à RDF-SOLAR : il part vers `brand.devisEndpoint` / `brand.contactEmail`,
   * tous deux lus dans SON `offers.json`. Nos propres prospects — les
   * installateurs qui souscrivent au SaaS — ne passent pas par ce code.
   *
   * À tout moment du parcours, le visiteur peut décrocher : appel direct,
   * WhatsApp, rappel sous 30 min (jours ouvrés) ou visite technique avec
   * prise de vue drone. Chaque demande part avec le résumé de sa simulation. */

  // Nom commercial de l'installateur hôte ('' s'il n'est pas configuré).
  // Toujours passer par ce point d'entrée : aucun texte vu par le visiteur ne
  // doit coder « RDF-SOLAR » en dur, sinon la marque de notre client est écrasée.
  Simulator.prototype._brandName = function () {
    return String((this.catalog.brand || {}).name || '').trim();
  };

  // « Un conseiller Dupont Énergie » / « Un conseiller » si la marque est absente
  Simulator.prototype._brandSuffix = function () {
    var n = this._brandName();
    return n ? ' ' + n : '';
  };

  Simulator.prototype._isOpenNow = function () {
    var h = (this.catalog.brand || {}).horaires || { debut: 9, fin: 18, jours: [1, 2, 3, 4, 5] };
    var now = new Date();
    return (h.jours || [1, 2, 3, 4, 5]).indexOf(now.getDay()) !== -1 &&
      now.getHours() >= (h.debut != null ? h.debut : 9) &&
      now.getHours() < (h.fin != null ? h.fin : 18);
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
          // Le message part avec le contexte de la simulation en cours, adressé
          // à l'installateur hôte (jamais à RDF-SOLAR)
          var hello = self._brandName() ? 'Bonjour ' + self._brandName() + ' ! ' : 'Bonjour ! ';
          ev.currentTarget.href = 'https://wa.me/' + String(brand.whatsapp).replace(/[^\d]/g, '') +
            '?text=' + encodeURIComponent(hello + self._leadContext());
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

  Simulator.prototype._openLeadModal = function (type) {
    var self = this;
    var brand = this.catalog.brand || {};
    var open = this._isOpenNow();
    if (this._modal) this._modal.remove();

    var isDrone = type === 'drone';
    var title = isDrone ? '🚁 Réserver ma visite technique' : '⏱ Être rappelé par un conseiller';
    var promise = isDrone
      ? 'Un technicien' + this._brandSuffix() + ' se déplace, vérifie la toiture et réalise des prises de vue par drone. Gratuit et sans engagement.'
      : (open
        ? 'Un conseiller vous rappelle sous 30 minutes.'
        : 'Nous sommes actuellement fermés (' + ((brand.horaires || {}).libelle || 'jours ouvrés') + ') : un conseiller vous rappelle dès l’ouverture.');

    var nameInput = el('input', { class: 'rdfsim-input', type: 'text', placeholder: 'Votre nom', autocomplete: 'name' });
    var phoneInput = el('input', { class: 'rdfsim-input', type: 'tel', placeholder: '06 12 34 56 78', autocomplete: 'tel' });
    var slotSel = null;
    if (isDrone) {
      slotSel = el('select', { class: 'rdfsim-input' });
      ['Au plus tôt', 'Plutôt le matin', 'Plutôt l’après-midi', 'Plutôt le samedi'].forEach(function (t) {
        slotSel.appendChild(el('option', { text: t, value: t }));
      });
    }
    var errBox = el('p', { class: 'rdfsim-muted', style: 'color:#b91c1c;margin:8px 0 0;display:none' });

    var card = el('div', { class: 'rdfsim-modal-card' }, [
      el('button', { class: 'rdfsim-modal-close', type: 'button', text: '✕', onclick: function () { self._closeModal(); } }),
      el('h3', { text: title }),
      el('p', { class: 'rdfsim-muted', text: promise }),
      el('label', { class: 'rdfsim-label', text: 'Nom' }), nameInput,
      el('label', { class: 'rdfsim-label', text: 'Téléphone' }), phoneInput,
      isDrone ? el('label', { class: 'rdfsim-label', text: 'Créneau souhaité' }) : null,
      slotSel,
      errBox,
      el('div', { class: 'rdfsim-btn-row' }, [
        el('button', {
          class: 'rdfsim-btn rdfsim-btn-primary', type: 'button',
          text: isDrone ? 'Réserver ma visite' : 'Me faire rappeler',
          onclick: function () {
            var tel = phoneInput.value.replace(/[^+\d]/g, '');
            if (tel.length < 9) {
              errBox.textContent = 'Merci d’indiquer un numéro de téléphone valide.';
              errBox.style.display = 'block';
              return;
            }
            self._submitLead({
              type: isDrone ? 'visite_technique_drone' : 'rappel_30min',
              nom: nameInput.value.trim(),
              telephone: phoneInput.value.trim(),
              creneau: slotSel ? slotSel.value : (open ? 'sous 30 min' : 'dès l’ouverture'),
              contexte: self._leadContext()
            }, card, isDrone);
          }
        })
      ]),
      el('p', { class: 'rdfsim-disclaimer', text: 'Vos coordonnées servent uniquement à vous recontacter au sujet de votre projet solaire.' })
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
    var done = function () {
      card.innerHTML = '';
      card.appendChild(el('h3', { text: '✅ C’est noté !' }));
      card.appendChild(el('p', {
        class: 'rdfsim-muted',
        text: isDrone
          ? 'Votre demande de visite technique est enregistrée : nous vous appelons pour fixer le rendez-vous et organiser la prise de vue par drone.'
          : (self._isOpenNow()
            ? 'Un conseiller' + self._brandSuffix() + ' vous rappelle sous 30 minutes.'
            : 'Un conseiller' + self._brandSuffix() + ' vous rappelle dès l’ouverture.')
      }));
      card.appendChild(el('div', { class: 'rdfsim-btn-row' }, [
        el('button', { class: 'rdfsim-btn rdfsim-btn-ghost', type: 'button', text: 'Fermer', onclick: function () { self._closeModal(); } })
      ]));
    };
    // Aucune destination configurée : ne pas faire croire au visiteur que sa
    // demande est partie, et l'orienter vers le téléphone de l'installateur.
    var failed = function () {
      card.innerHTML = '';
      card.appendChild(el('h3', { text: '⚠ Demande non transmise' }));
      card.appendChild(el('p', {
        class: 'rdfsim-muted',
        text: brand.phone
          ? 'Le formulaire est momentanément indisponible. Appelez-nous directement au ' + brand.phone + '.'
          : 'Le formulaire est momentanément indisponible. Merci de nous contacter directement.'
      }));
      card.appendChild(el('div', { class: 'rdfsim-btn-row' }, [
        el('button', { class: 'rdfsim-btn rdfsim-btn-ghost', type: 'button', text: 'Fermer', onclick: function () { self._closeModal(); } })
      ]));
    };
    // Le lead appartient à l'installateur hôte : il ne part que vers SES coordonnées.
    // Sans destination configurée, on le dit au visiteur plutôt que d'ouvrir un
    // « mailto: » sans destinataire — et surtout jamais vers une adresse RDF-SOLAR.
    var mailtoFallback = function () {
      if (!brand.contactEmail) { failed(); return; }
      window.location.href = 'mailto:' + brand.contactEmail +
        '?subject=' + encodeURIComponent('[LEAD] ' + (isDrone ? 'Visite technique drone' : 'Rappel sous 30 min') + ' — ' + (lead.nom || 'visiteur')) +
        '&body=' + encodeURIComponent('Nom : ' + lead.nom + '\nTéléphone : ' + lead.telephone +
          '\nCréneau : ' + lead.creneau + '\n\n' + lead.contexte);
      done();
    };
    if (brand.devisEndpoint) {
      fetch(brand.devisEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lead)
      }).then(done).catch(mailtoFallback);
    } else {
      mailtoFallback();
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

    // En-tête (le nom de l'installateur et son téléphone sont complétés au
    // chargement du catalogue, cf. _applyBrand)
    this.headerCta = el('div', { class: 'rdfsim-header-cta' });
    this.logoEl = el('div', { class: 'rdfsim-logo', text: BRAND_PLACEHOLDER });
    this.root.appendChild(el('div', { class: 'rdfsim-header' }, [
      el('span', { class: 'rdfsim-logo-sun' }),
      el('div', { style: 'flex:1' }, [
        this.logoEl,
        el('div', { class: 'rdfsim-header-sub', text: 'Visualisez votre future installation photovoltaïque sur votre toit, en conditions réelles' })
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

    // Barre de contact permanente : le visiteur peut décrocher à tout moment du parcours
    this.ctaBar = el('div', { class: 'rdfsim-cta-bar' });
    this.root.appendChild(this.ctaBar);

    // Pied (le nom de l'installateur est injecté par _applyBrand)
    this.footerBrand = el('span', {});
    this.root.appendChild(el('div', { class: 'rdfsim-footer' }, [
      this.footerBrand,
      el('span', { html: 'Fond de carte : orthophotos © <a href="https://www.ign.fr" target="_blank" rel="noopener">IGN</a> · Adresses : Base Adresse Nationale' })
    ]));

    this._buildStepPanels();
    this._applyBrand();   // libellés neutres tant que le catalogue n'est pas chargé
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
        el('p', { class: 'rdfsim-muted', text: 'Particulier ou entreprise : saisissez l’adresse du bâtiment — la vue satellite haute résolution de votre toit s’affiche aussitôt.' }),
        el('div', { class: 'rdfsim-ac' }, [acInput, acList]),
        el('div', { class: 'rdfsim-btn-row' }, [
          el('button', {
            class: 'rdfsim-btn rdfsim-btn-primary', type: 'button', text: 'Continuer vers le dessin du toit →',
            onclick: function () { self._goStep(2); }
          })
        ]),
        el('div', { class: 'rdfsim-btn-row' }, [
          el('button', {
            class: 'rdfsim-btn rdfsim-btn-ghost', type: 'button', text: '📍 Sans adresse : placer la carte moi-même',
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
        el('p', { class: 'rdfsim-muted', html: '<b>1.</b> Votre adresse → vue aérienne réelle de votre toit<br><b>2.</b> Dessinez la toiture, l’outil place les panneaux automatiquement<br><b>3.</b> Choisissez votre offre et vos équipements<br><b>4.</b> Production, économies et demande de devis en 1 clic' })
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
    this.gsBox = el('div', {});    // détection Google Solar (si clé configurée)
    this.zonesBox = el('div', {}); // liste des pans dessinés

    this.panels[2] = el('div', {}, [
      el('div', { class: 'rdfsim-card' }, [
        el('h3', { text: '2. Votre toiture, pan par pan' }),
        el('p', {
          class: 'rdfsim-muted',
          html: this.tap + ' les angles d’un pan de toit sur la carte, puis <b>« ✓ Terminer »</b>. ' +
            'Recommencez pour <b>cumuler d’autres pans ou bâtiments</b>. ' +
            this.tap + ' un panneau posé pour le retirer/remettre.' +
            (this.isTouch ? '' : ' <span style="white-space:nowrap">Clic droit</span> : annuler le dernier point · Échap : quitter le dessin.')
        }),
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
          })
        ])
      ]),
      el('div', { class: 'rdfsim-card' }, [
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

    // Le nom de l'installateur est injecté par _applyBrand
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
      class: 'rdfsim-tool', type: 'button', text: '➕ Ajouter un pan',
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
    this.toolTree.classList.toggle('is-on', mode === 'tree');
    this.treeSizes.style.display = mode === 'tree' ? 'inline-flex' : 'none';
    this._updateDraftTools();
    this._refreshBuildings(); // les bâtiments sélectionnables s'effacent pendant un tracé
    // Sur mobile, le dessin se passe sous les réglages : on amène la carte à l'écran
    if (mode) this._scrollTo(this.mapArea);
  };

  Simulator.prototype._updateDraftTools = function () {
    var drafting = this.state.drawMode === 'roof' || this.state.drawMode === 'obstacle';
    this.toolFinish.style.display = drafting && this.draftPoints.length >= 3 ? '' : 'none';
    this.toolUndo.style.display = drafting && this.draftPoints.length >= 1 ? '' : 'none';
  };

  Simulator.prototype._clearDrawing = function () {
    this.state.zones = [];
    this.state.activeZone = -1;
    this.state.obstacles = [];
    this.state.trees = [];
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
    }
  };

  // Remet l'interface du mode dessin à l'état neutre sans effet de bord (défilement…)
  Simulator.prototype._setDrawModeUi = function () {
    this.draftPoints = [];
    this.layerDraft.clearLayers();
    this.toolRoof.classList.remove('is-on');
    this.toolObstacle.classList.remove('is-on');
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
      var nz = s.panels.filter(function (p) {
        return p.zone === zi && !s.excluded[p.zone + ':' + p.row + ':' + p.col];
      }).length;
      var areaM = E.polygonArea(E.toLocalMeters(z.points, z.points[0])) / Math.cos(z.tilt * Math.PI / 180);
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

    // Obstacles
    s.obstacles.forEach(function (o) {
      L.polygon(o, { color: '#dc2626', weight: 1.5, fillColor: '#dc2626', fillOpacity: 0.25, dashArray: '4 3' })
        .addTo(this.layerRoof);
    }, this);

    var panel = this._panel();
    s.zones.forEach(function (z, zi) {
      var isActive = zi === s.activeZone;
      // Contour du pan (cliquer un pan le sélectionne)
      var poly = L.polygon(z.points, {
        color: isActive ? '#f59e0b' : '#d9b06a',
        weight: isActive ? 2.5 : 1.5,
        fillColor: '#f59e0b',
        fillOpacity: isActive ? 0.10 : 0.04,
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

    s.panels.forEach(function (p) {
      var key = p.zone + ':' + p.row + ':' + p.col;
      var excluded = !!s.excluded[key];
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
      if (!excluded && p.gRel != null && p.gRel < 0.85) {
        poly.bindTooltip((p.gRel < 0.65 ? '🔴 Fortement ombragé' : '🟠 Partiellement ombragé') +
          ' : −' + Math.round((1 - p.gRel) * 100) + ' % vs le meilleur panneau du pan ' +
          '(ombres du voisinage, données Google) — cliquer pour le retirer');
      }
      poly.on('click', function (ev) {
        L.DomEvent.stopPropagation(ev);
        // En mode dessin (obstacle sur le champ de panneaux…), le clic sert à poser un sommet
        if (self.state.drawMode) { self._onMapClick(ev); return; }
        s.excluded[key] = !s.excluded[key];
        self._relayout();
      });
      poly.addTo(self.layerPanels);
    });

    this._renderZones();
    this._refresh();
  };

  Simulator.prototype._activePanels = function () {
    var s = this.state;
    return s.panels.filter(function (p) { return !s.excluded[p.zone + ':' + p.row + ':' + p.col]; });
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
    s.zones.forEach(function (z, zi) {
      var zActive = active.filter(function (p) { return p.zone === zi; });
      var nz = zActive.length;
      var kwcz = nz * panel.puissanceWc / 1000;
      var zAnnual, shading = 'aucune';

      if (z.google && z.google.panels.length && zActive.every(function (p) { return p.gE != null; })) {
        // Mode précision : somme des productions Google des panneaux retenus,
        // mise à l'échelle de la puissance réelle de nos panneaux
        zAnnual = zActive.reduce(function (sum, p) { return sum + p.gE; }, 0) *
          (panel.puissanceWc / z.google.panelWatts) * dcToAc;
        shading = 'précision Google (par panneau)';
      } else if (z.google && z.google.medianSunshine && z.google.maxSunshine) {
        // Repli : facteur d'ombrage du pan (ensoleillement médian / maximum du bâtiment)
        var shade = Math.max(0.55, Math.min(1, z.google.medianSunshine / z.google.maxSunshine));
        zAnnual = E.estimateProduction({
          kwc: kwcz, lat: lat, lng: lng,
          tiltDeg: z.tilt, azimuthDeg: z.azimuth,
          performanceRatio: inverter.performanceRatio
        }).annualKwh * shade;
        shading = 'facteur d’ombrage Google (−' + Math.round((1 - shade) * 100) + ' %)';
      } else {
        // Pan dessiné à la main : modèle régional (sans ombrage du voisinage)
        zAnnual = E.estimateProduction({
          kwc: kwcz, lat: lat, lng: lng,
          tiltDeg: z.tilt, azimuthDeg: z.azimuth,
          performanceRatio: inverter.performanceRatio
        }).annualKwh;
      }

      annual += zAnnual;
      roofArea += E.polygonArea(E.toLocalMeters(z.points, z.points[0])) / Math.cos(z.tilt * Math.PI / 180);
      zonesInfo.push({ n: nz, kwc: kwcz, annualKwh: zAnnual, tilt: z.tilt, azimuth: z.azimuth, shading: shading, isGoogle: !!z.google });
    });
    var googleZones = zonesInfo.filter(function (zin) { return zin.isGoogle; }).length;
    var shadingLevel = !s.zones.length || !googleZones ? 'none'
      : (googleZones === s.zones.length ? 'full' : 'partial');
    var prod = {
      annualKwh: annual,
      monthly: E.monthlyProduction(annual),
      ghi: ghi != null ? ghi : E.ghiAt(lat, lng),
      specificYield: kwc > 0 ? annual / kwc : 0
    };

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

    return {
      n: n, kwc: kwc, prod: prod, fin: fin,
      installCost: installCost,
      roofArea: roofArea,
      zones: zonesInfo,
      shadingLevel: shadingLevel, // 'full' | 'partial' | 'none' : part des pans avec ombrage Google intégré
      panel: panel, inverter: inverter, battery: battery, offer: offer
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

  Simulator.prototype._selectAddress = function (addr) {
    this.state.address = addr;
    this.acInput.value = addr.label;
    this.map.setView([addr.lat, addr.lng], 19);
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

    this.side.innerHTML = '';
    this.side.appendChild(this.panels[n]);
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

    var shadingLabel = c.shadingLevel === 'full'
      ? ' · ombres du voisinage incluses ✓ (Google Solar)'
      : (c.shadingLevel === 'partial' ? ' · ombres incluses sur les pans détectés (Google Solar)' : '');
    var grid = el('div', { class: 'rdfsim-results-grid' }, [
      el('div', { class: 'rdfsim-kpi is-hero' }, [
        el('div', { class: 'rdfsim-kpi-v', html: fmt(c.prod.annualKwh) + ' <small>kWh/an</small>' }),
        el('div', { class: 'rdfsim-kpi-l', text: 'Production annuelle estimée — ' + fmt(c.prod.specificYield) + ' kWh/kWc' + shadingLabel })
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
          (c.shadingLevel === 'full'
            ? 'Les ombres portées par le voisinage (bâtiments, arbres, relief) sont intégrées au calcul via le modèle 3D de Google Solar. '
            : (c.shadingLevel === 'partial'
              ? 'Les ombres du voisinage sont intégrées sur les pans détectés automatiquement ; les pans dessinés à la main utilisent l’ensoleillement régional moyen. '
              : 'Calcul basé sur l’ensoleillement moyen régional, sans les ombres du voisinage. ')) +
          'Les arbres plantés dans le simulateur servent à visualiser l’ombrage en 3D mais ne sont pas déduits du calcul. La visite technique (avec relevé drone) affine précisément ces valeurs. ' +
          (this.catalog.tarifs && this.catalog.tarifs.note ? this.catalog.tarifs.note : '')
      })
    ]);
    box.appendChild(cta);
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
        (c.shadingLevel !== 'none' ? ' — ombres du voisinage intégrées (Google Solar' + (c.shadingLevel === 'partial' ? ', pans détectés' : '') + ')' : ''),
      'Autoconsommation : ' + Math.round(c.fin.selfConsumptionRate * 100) + ' % | Économies : ' + eur(c.fin.annualSavings) + '/an',
      'Coût indicatif : ' + eur(c.installCost) + ' | Prime : ' + eur(c.fin.bonus) + ' | Retour : ' + (isFinite(c.fin.paybackYears) ? fmt(c.fin.paybackYears, 1) + ' ans' : '—')
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
      '<div class="hero">Production annuelle estimée : <b>' + fmt(c.prod.annualKwh) + ' kWh</b>' +
      ' &nbsp;·&nbsp; économies : <b>' + eur(c.fin.annualSavings) + '/an</b>' +
      ' &nbsp;·&nbsp; retour sur investissement : <b>' + payback + '</b></div>' +
      '<h2>Votre installation</h2><table>' +
      kv('Offre', c.offer.nom + ' — ' + (c.offer.accroche || '')) +
      kv('Panneaux', c.n + ' × ' + c.panel.nom + ' (' + fmt(c.kwc, 2) + ' kWc)') +
      kv('Onduleur', c.inverter.nom) +
      kv('Stockage', c.battery.nom) +
      kv('Toiture', fmt(c.roofArea) + ' m² · ' + c.zones.length + ' pan(s) : ' +
        c.zones.map(function (z, i) {
          return 'pan ' + (i + 1) + ' — ' + z.n + ' panneaux, ' + z.tilt + '°, ' + azLabel(z.azimuth) +
            ' (' + fmt(z.annualKwh) + ' kWh/an' + (z.isGoogle ? ', ombrage inclus' : '') + ')';
        }).join(' · ')) +
      kv('Ombres du voisinage', c.shadingLevel === 'full'
        ? 'Intégrées sur tous les pans (modèle 3D Google Solar : bâtiments, arbres, relief)'
        : (c.shadingLevel === 'partial'
          ? 'Intégrées sur les pans détectés automatiquement (Google Solar)'
          : 'Non modélisées — à confirmer lors de la visite technique')) +
      kv('Coût indicatif', eur(c.installCost) + ' — prime à l’autoconsommation déduite : ' + eur(c.fin.netCost)) +
      '</table>' +
      (this._snapshot3d ? '<h2>Visualisation 3D</h2><img class="snap" src="' + this._snapshot3d + '" alt="Vue 3D de l’installation">' : '') +
      '<h2>Production et bilan annuel</h2>' +
      '<div class="cols"><div><table>' +
      kv('Production spécifique', fmt(c.prod.specificYield) + ' kWh/kWc/an') +
      kv('Taux d’autoconsommation', Math.round(c.fin.selfConsumptionRate * 100) + ' %') +
      kv('Énergie autoconsommée', fmt(c.fin.selfConsumedKwh) + ' kWh/an') +
      kv('Surplus revendu', fmt(c.fin.surplusKwh) + ' kWh/an') +
      kv('CO₂ évité', fmt(c.fin.co2SavedKg) + ' kg/an') +
      '</table>' + (chartSvg ? '<div style="margin-top:14px">' + chartSvg.outerHTML + '</div>' : '') +
      '</div><div><table><tr><td><b>Mois</b></td><td style="text-align:right"><b>Production</b></td></tr>' +
      monthRows + '</table></div></div>' +
      '<div class="disc">Estimation indicative et non contractuelle établie par le simulateur ' +
      (brand.name || 'de votre installateur') + ' à partir de l’ensoleillement moyen régional, de l’orientation et de ' +
      'l’inclinaison déclarées. Les ombrages proches, l’état du réseau et l’évolution des tarifs peuvent ' +
      'modifier ces valeurs. Contact : ' + (brand.contactEmail || '') + '</div>' +
      '</body></html>');
    w.document.close();
  };

  // Demande de devis : c'est un lead visiteur, il revient à l'installateur hôte.
  Simulator.prototype._requestQuote = function (c) {
    var brand = this.catalog.brand || {};
    var summary = this._summaryText(c);
    var destinataire = this._brandName() ? ' à ' + this._brandName() : '';
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
        alert('Votre demande a bien été transmise' + destinataire + '. Un conseiller vous recontacte rapidement !');
      }).catch(function () {
        alert('Impossible d’envoyer la demande pour le moment. Réessayez ou contactez-nous directement.');
      });
    } else if (brand.contactEmail) {
      // Repli e-mail : uniquement vers l'adresse de l'installateur, jamais la nôtre
      var subject = encodeURIComponent('Demande de devis — simulation photovoltaïque');
      var body = encodeURIComponent(summary + '\n\nMes coordonnées :\nNom :\nTéléphone :\n');
      window.location.href = 'mailto:' + brand.contactEmail + '?subject=' + subject + '&body=' + body;
    } else {
      alert('Aucune adresse de contact n’est configurée pour ce simulateur.' +
        (brand.phone ? ' Appelez-nous directement au ' + brand.phone + '.' : ''));
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
