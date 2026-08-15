/*!
 * EVASIMU — Page de vente B2B : conversion, tarifs et mesure
 *
 * Capture les leads SaaS : les INSTALLATEURS qui demandent leur simulateur.
 * À ne pas confondre avec les « leads visiteurs » du widget (src/evasimu-sim.js),
 * qui sont les particuliers et appartiennent à l'installateur client.
 *
 * L'identification de l'entreprise s'appuie sur l'API publique
 * « Recherche d'entreprises » (annuaire-entreprises.data.gouv.fr) : gratuite,
 * sans clé, sans quota déclaré, CORS ouvert — donc appelable directement depuis
 * le navigateur, comme le reste du projet qui refuse les dépendances payantes.
 * Toute panne de cette API doit rester sans conséquence sur la conversion :
 * le prospect peut à tout moment basculer en saisie manuelle.
 *
 * Deux principes tiennent tout le fichier :
 *   1. Le prospect obtient quelque chose AVANT qu'on lui demande quoi que ce
 *      soit de plus. La soumission ouvre son simulateur à son enseigne ; le
 *      téléphone n'est demandé qu'après, à quelqu'un qui a déjà vu le produit.
 *   2. Aucun lead ne se perd : endpoint HTTP si configuré, repli e-mail sinon,
 *      et la panne d'un service tiers ne bloque jamais le tunnel.
 */
(function () {
  'use strict';

  /* ===================== Configuration ===================== */
  var CONFIG = {
    // Où partent les leads installateurs. Renseignez une URL (CRM, Formspree,
    // Make, n8n…) qui accepte un POST JSON : c'est ce qui rend la page
    // réellement convertissante. Tant que c'est vide, on bascule sur un
    // e-mail pré-rempli — fonctionnel, mais qui perd une partie des prospects
    // (webmails et mobiles gèrent mal « mailto: »).
    leadEndpoint: '',
    // ⚠ evasimu.fr n'a ni enregistrement A ni MX : une adresse à ce domaine
    // renverrait les demandes dans le vide. Le domaine qui résout est eviatek.fr.
    contactEmail: 'contact@eviatek.fr',
    // Numéro WhatsApp commercial, au format international sans « + ».
    // Vidé, le bouton flottant renverrait vers le formulaire d'essai plutôt que
    // vers un numéro inexistant.
    whatsapp: '33614746975',
    whatsappMessage: 'Bonjour EVASIMU ! Je suis installateur photovoltaïque et je souhaite en savoir plus sur le simulateur.',
    apiUrl: 'https://recherche-entreprises.api.gouv.fr/search',
    apiTimeoutMs: 8000,
    minChars: 3,
    debounceMs: 320,
    // Page d'aperçu ouverte immédiatement après la soumission, à l'enseigne
    // du prospect. C'est elle qui rend vraie la promesse « 60 secondes ».
    apercuUrl: 'demo.html'
  };

  // Surcharge sans toucher au code, sur le modèle de `window.EVASIMU_LOCAL`
  // utilisé pour les clés API : déclarez `window.EVASIMU_VENTE = { leadEndpoint: '…' }`
  // avant ce script (ou dans un config/local.js non commité).
  var override = window.EVASIMU_VENTE || {};
  Object.keys(override).forEach(function (k) {
    if (Object.prototype.hasOwnProperty.call(CONFIG, k)) CONFIG[k] = override[k];
  });

  /* ===================== Utilitaires ===================== */
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function digits(s) { return String(s || '').replace(/\D/g, ''); }
  function euros(n) {
    return Math.round(n).toLocaleString('fr-FR').replace(/ | /g, ' ') + ' €';
  }

  /* ===================== Mesure ======================
   * Aucun cookie, aucun identifiant persistant : on se contente de pousser
   * l'événement dans une file que l'outil d'analytique (Plausible, Matomo)
   * consomme s'il est présent. Sans outil, les appels ne coûtent rien et la
   * page fonctionne à l'identique.
   */
  var mesures = {};
  function suivre(nom, props) {
    try {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push(Object.assign({ event: nom }, props || {}));
      if (typeof window.plausible === 'function') window.plausible(nom, { props: props || {} });
      if (window._paq && window._paq.push) window._paq.push(['trackEvent', 'evasimu', nom, JSON.stringify(props || {})]);
    } catch (e) { /* la mesure ne casse jamais la page */ }
  }
  /** Un événement qui ne doit être compté qu'une fois par visite. */
  function suivreUneFois(nom, props) {
    if (mesures[nom]) return;
    mesures[nom] = 1;
    suivre(nom, props);
  }

  /* ===================== Habillage de la page ===================== */
  function initChrome() {
    var reduit = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Bouton WhatsApp flottant : réel si un numéro est configuré, sinon il
    // ramène au formulaire plutôt que de pointer dans le vide.
    var wa = $('#float-wa');
    if (wa && CONFIG.whatsapp) {
      wa.href = 'https://wa.me/' + digits(CONFIG.whatsapp) +
        '?text=' + encodeURIComponent(CONFIG.whatsappMessage);
      wa.target = '_blank';
      wa.rel = 'noopener';
      wa.setAttribute('aria-label', 'Nous écrire sur WhatsApp');
      var lbl = $('.label-wa', wa);
      if (lbl) lbl.textContent = 'WhatsApp';
    } else if (wa) {
      wa.setAttribute('aria-label', 'Aller au formulaire de création du simulateur');
    }

    var nav = $('#nav'), top = $('#float-top'), mobar = $('#mobar');
    var haut = $('#top');

    function onScroll() {
      var y = window.pageYOffset || document.documentElement.scrollTop;
      if (nav) nav.classList.toggle('is-stuck', y > 8);
      if (top) top.classList.toggle('is-on', y > window.innerHeight);
      // La barre mobile n'apparaît qu'une fois le hero passé : sur le hero,
      // les CTA sont déjà à l'écran et elle ne ferait que masquer du contenu.
      if (mobar) {
        var seuil = haut ? haut.offsetHeight * 0.8 : 500;
        mobar.classList.toggle('is-on', y > seuil);
      }
      var doc = document.documentElement;
      var atteint = (y + window.innerHeight) / Math.max(doc.scrollHeight, 1);
      if (atteint > 0.5) suivreUneFois('scroll_50');
      if (atteint > 0.9) suivreUneFois('scroll_90');
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    if (top) top.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: reduit ? 'auto' : 'smooth' });
    });

    // Mesure des CTA : un seul écouteur, la position est portée par le HTML.
    document.addEventListener('click', function (ev) {
      var a = ev.target.closest && ev.target.closest('[data-ev]');
      if (!a) return;
      suivre(a.getAttribute('data-ev'), { position: a.getAttribute('data-pos') || '' });
    });

    // Apparition progressive des blocs. Sans IntersectionObserver (ou en
    // mouvement réduit), tout est affiché d'emblée : jamais de contenu masqué.
    var blocs = $$('.reveal');
    if (reduit || !('IntersectionObserver' in window)) {
      blocs.forEach(function (b) { b.classList.add('is-in'); });
      return;
    }
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('is-in'); obs.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
    blocs.forEach(function (b, i) {
      b.style.transitionDelay = (Math.min(i % 4, 3) * 70) + 'ms';
      obs.observe(b);
    });
  }

  /* ===================== Menu mobile =====================
   * Panneau plein écran sous 1024 px : fermeture par Échap, par tap hors zone
   * et par choix d'un lien ; focus piégé tant qu'il est ouvert, sinon la
   * tabulation part derrière le voile et l'utilisateur au clavier se perd.
   */
  function initMenu() {
    var burger = $('#nav-burger'), panneau = $('#nav-panel'), fermer = $('#nav-close');
    if (!burger || !panneau) return;
    var dernierFocus = null;

    function ouvrir() {
      dernierFocus = document.activeElement;
      panneau.classList.add('is-on');
      burger.setAttribute('aria-expanded', 'true');
      document.body.style.overflow = 'hidden';
      var premier = panneau.querySelector('a, button');
      if (premier) premier.focus();
    }
    function ferme() {
      panneau.classList.remove('is-on');
      burger.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
      if (dernierFocus && dernierFocus.focus) dernierFocus.focus();
    }

    burger.addEventListener('click', ouvrir);
    if (fermer) fermer.addEventListener('click', ferme);
    panneau.addEventListener('click', function (ev) {
      if (ev.target === panneau) ferme();               // tap sur le voile
      if (ev.target.closest && ev.target.closest('a')) ferme();
    });
    document.addEventListener('keydown', function (ev) {
      if (!panneau.classList.contains('is-on')) return;
      if (ev.key === 'Escape') { ferme(); return; }
      if (ev.key !== 'Tab') return;
      var cibles = $$('a[href], button', panneau).filter(function (n) { return n.offsetParent !== null; });
      if (!cibles.length) return;
      var premier = cibles[0], dernier = cibles[cibles.length - 1];
      if (ev.shiftKey && document.activeElement === premier) { ev.preventDefault(); dernier.focus(); }
      else if (!ev.shiftKey && document.activeElement === dernier) { ev.preventDefault(); premier.focus(); }
    });
  }

  /* ===================== Tarifs =====================
   * Le bascule mensuel/annuel ne calcule rien : les deux montants sont écrits
   * dans le HTML (data-mois / data-an). Un prix affiché doit être un prix
   * décidé, pas le résultat d'une multiplication faite dans le navigateur.
   */
  function initTarifs() {
    var bMois = $('#t-mois'), bAn = $('#t-an'), note = $('#prix-note');
    if (bMois && bAn) {
      var appliquer = function (annuel) {
        bMois.setAttribute('aria-pressed', String(!annuel));
        bAn.setAttribute('aria-pressed', String(annuel));
        $$('#prix-grid .prix-n').forEach(function (n) {
          var v = n.getAttribute(annuel ? 'data-an' : 'data-mois');
          if (v) n.textContent = v;
        });
        $$('#prix-grid .prix-ann').forEach(function (n) {
          var t = n.getAttribute('data-an-note') || '';
          n.textContent = annuel && t ? t : ' ';
        });
        if (note) {
          note.textContent = annuel
            ? 'Prix HT mensuel équivalent, facturé une fois par an : dix mois payés pour douze.'
            : 'Prix HT par mois, sans engagement, résiliation en un clic.';
        }
        suivre('pricing_toggle', { periode: annuel ? 'annuel' : 'mensuel' });
      };
      bMois.addEventListener('click', function () { appliquer(false); });
      bAn.addEventListener('click', function () { appliquer(true); });
    }

    // Indicateurs de position du carrousel mobile : sans repère visuel, deux
    // formules sur cinq ne sont jamais vues.
    var grille = $('#prix-grid'), points = $('#prix-points');
    if (grille && points) {
      var cartes = $$('.prix', grille);
      cartes.forEach(function () { points.appendChild(el('span')); });
      var majPoints = function () {
        var centre = grille.scrollLeft + grille.clientWidth / 2;
        var actif = 0, min = Infinity;
        cartes.forEach(function (c, i) {
          var d = Math.abs(c.offsetLeft + c.offsetWidth / 2 - centre);
          if (d < min) { min = d; actif = i; }
        });
        $$('span', points).forEach(function (p, i) { p.classList.toggle('is-on', i === actif); });
      };
      grille.addEventListener('scroll', majPoints, { passive: true });
      window.addEventListener('resize', majPoints);
      majPoints();
    }

    // Comparateur d'économies. Référence : Essentiel, 79 € HT par mois.
    var nb = $('#eco-nb'), prix = $('#eco-prix');
    if (nb && prix) {
      var sortieN = $('#eco-n'), sortieL = $('#eco-l'), sortieD = $('#eco-d');
      var ESSENTIEL_AN = 79 * 12;
      var calcul = function () {
        var n = Math.max(0, Math.min(500, parseFloat(nb.value) || 0));
        var p = Math.max(0, Math.min(500, parseFloat(prix.value) || 0));
        var achat = n * p * 12;
        var ecart = achat - ESSENTIEL_AN;
        if (ecart > 0) {
          sortieN.textContent = euros(ecart);
          sortieL.textContent = 'économisés la première année';
          sortieD.textContent = euros(achat) + ' d’achat de leads contre ' +
            euros(ESSENTIEL_AN) + ' d’abonnement annuel.';
        } else {
          // Honnêteté : à faible volume, l'abonnement ne fait pas économiser
          // d'argent. On le dit, et on déplace l'argument sur l'exclusivité.
          sortieN.textContent = euros(achat);
          sortieL.textContent = 'dépensés par an en leads non exclusifs';
          sortieD.textContent = 'À ce volume, l’Essentiel ne vous fera pas économiser d’argent — ' +
            'il vous donnera des leads qui n’existent nulle part ailleurs. La formule à 9 € le lead, ' +
            'plafonnée à 79 €, est sans doute la bonne porte d’entrée.';
        }
      };
      ['input', 'change'].forEach(function (ev) {
        nb.addEventListener(ev, calcul);
        prix.addEventListener(ev, calcul);
      });
      nb.addEventListener('change', function () { suivre('eco_calcul', { leads: nb.value, prix: prix.value }); });
      calcul();
    }
  }

  /* ===================== Formulaire ===================== */

  // Tranches d'effectif INSEE → libellé lisible
  var EFFECTIF = {
    NN: 'effectif non renseigné', '00': '0 salarié', '01': '1 à 2 salariés',
    '02': '3 à 5 salariés', '03': '6 à 9 salariés', '11': '10 à 19 salariés',
    '12': '20 à 49 salariés', '21': '50 à 99 salariés', '22': '100 à 199 salariés',
    '31': '200 à 249 salariés', '32': '250 à 499 salariés', '41': '500 à 999 salariés',
    '42': '1 000 à 1 999 salariés', '51': '2 000 à 4 999 salariés',
    '52': '5 000 à 9 999 salariés', '53': '10 000 salariés et plus'
  };

  // Lecture défensive : l'API peut faire évoluer sa forme, une absence de champ
  // ne doit jamais casser le tunnel de conversion.
  function normalise(r) {
    if (!r || typeof r !== 'object') return null;
    var siege = r.siege || {};
    var ville = siege.libelle_commune || siege.commune || '';
    var cp = siege.code_postal || '';
    return {
      nom: r.nom_complet || r.nom_raison_sociale || r.sigle || '(raison sociale inconnue)',
      siren: r.siren || '',
      siret: siege.siret || '',
      adresse: siege.adresse || '',
      ville: ville,
      codePostal: cp,
      villeLigne: [cp, ville].filter(Boolean).join(' '),
      ape: r.activite_principale || siege.activite_principale || '',
      apeLibelle: r.libelle_activite_principale || siege.libelle_activite_principale || '',
      effectif: EFFECTIF[r.tranche_effectif_salarie] || '',
      creation: r.date_creation || '',
      ferme: r.etat_administratif === 'C'
    };
  }

  function initFormulaire() {
    var form = $('#form-essai');
    if (!form) return;

    var qInput = $('#f-entreprise');
    var results = $('#f-results');
    var spin = $('#f-spin');
    var companyBox = $('#f-company');
    var manualBtn = $('#f-manuel');
    var errBox = $('#f-erreur');
    var submitBtn = $('#f-submit');

    var state = { company: null, manuel: false, items: [], actif: -1 };
    var timer = null, ctrl = null;

    /* ---------- Recherche d'entreprise ---------- */
    function closeResults() {
      results.innerHTML = '';
      results.style.display = 'none';
      state.items = []; state.actif = -1;
    }

    function showResults(list) {
      results.innerHTML = '';
      if (!list.length) {
        results.appendChild(el('div', {
          class: 'result-m', style: 'padding:11px 12px',
          text: 'Aucune entreprise trouvée. Vérifiez l’orthographe, ou saisissez vos informations à la main.'
        }));
        results.style.display = 'block';
        return;
      }
      state.items = list;
      list.forEach(function (c) {
        results.appendChild(el('button', {
          class: 'result', type: 'button',
          onclick: function () { select(c); }
        }, [
          el('span', { class: 'result-n', text: c.nom + (c.ferme ? ' (établissement fermé)' : '') }),
          el('span', {
            class: 'result-m',
            text: [c.villeLigne, c.siret ? 'SIRET ' + c.siret : ''].filter(Boolean).join(' · ')
          })
        ]));
      });
      results.style.display = 'block';
      state.actif = -1;
    }

    function search(q) {
      if (ctrl) ctrl.abort();
      ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      spin.style.display = 'block';

      var timeout = setTimeout(function () { if (ctrl) ctrl.abort(); }, CONFIG.apiTimeoutMs);
      var url = CONFIG.apiUrl + '?q=' + encodeURIComponent(q) + '&per_page=6&page=1';

      fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (json) {
          clearTimeout(timeout);
          spin.style.display = 'none';
          var list = (json && json.results ? json.results : []).map(normalise).filter(Boolean);
          showResults(list);
        })
        .catch(function (e) {
          clearTimeout(timeout);
          spin.style.display = 'none';
          if (e && e.name === 'AbortError') return;   // requête remplacée : on ignore
          // L'annuaire est indisponible : on ne bloque pas le prospect.
          results.innerHTML = '';
          results.appendChild(el('div', { class: 'result-m', style: 'padding:11px 12px' }, [
            el('span', { text: 'Recherche indisponible pour le moment. ' }),
            el('button', {
              class: 'company-x', type: 'button', text: 'Saisir mes informations à la main',
              onclick: function () { passerEnManuel(); }
            })
          ]));
          results.style.display = 'block';
        });
    }

    qInput.addEventListener('input', function () {
      state.company = null;
      renderCompany();
      suivreUneFois('form_start');
      var q = qInput.value.trim();
      clearTimeout(timer);
      if (state.manuel) return;                     // saisie libre : pas de recherche
      if (q.length < CONFIG.minChars) { closeResults(); spin.style.display = 'none'; return; }
      timer = setTimeout(function () { search(q); }, CONFIG.debounceMs);
    });

    // Navigation clavier dans la liste (accessibilité + confort desktop)
    qInput.addEventListener('keydown', function (ev) {
      var btns = results.querySelectorAll('.result');
      if (!btns.length) return;
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        state.actif += (ev.key === 'ArrowDown' ? 1 : -1);
        if (state.actif < 0) state.actif = btns.length - 1;
        if (state.actif >= btns.length) state.actif = 0;
        for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('is-active', i === state.actif);
      } else if (ev.key === 'Enter' && state.actif >= 0) {
        ev.preventDefault();
        btns[state.actif].click();
      } else if (ev.key === 'Escape') {
        closeResults();
      }
    });

    document.addEventListener('click', function (ev) {
      if (!results.contains(ev.target) && ev.target !== qInput) closeResults();
    });

    function select(c) {
      state.company = c;
      state.manuel = false;
      qInput.value = c.nom;
      closeResults();
      renderCompany();
      suivre('form_siret_resolved', { siret: c.siret ? 'oui' : 'non' });
      $('#f-mail').focus();
    }

    function passerEnManuel() {
      state.manuel = true;
      state.company = null;
      closeResults();
      renderCompany();
      qInput.placeholder = 'Nom de votre entreprise';
      qInput.focus();
    }

    manualBtn.addEventListener('click', function (ev) { ev.preventDefault(); passerEnManuel(); });

    function renderCompany() {
      companyBox.innerHTML = '';
      if (!state.company) { companyBox.style.display = 'none'; return; }
      var c = state.company;
      var lignes = [];
      if (c.siret) lignes.push('SIRET ' + c.siret);
      else if (c.siren) lignes.push('SIREN ' + c.siren);
      if (c.adresse) lignes.push(c.adresse);
      else if (c.villeLigne) lignes.push(c.villeLigne);
      if (c.ape) lignes.push('Code APE ' + c.ape + (c.apeLibelle ? ' — ' + c.apeLibelle : ''));
      if (c.effectif) lignes.push(c.effectif);

      companyBox.appendChild(el('div', { class: 'company-top' }, [
        el('span', { class: 'company-n', text: '✓ ' + c.nom }),
        el('button', {
          class: 'company-x', type: 'button', text: 'Changer',
          onclick: function () { state.company = null; renderCompany(); qInput.value = ''; qInput.focus(); }
        })
      ]));
      companyBox.appendChild(el('div', { class: 'company-d', text: lignes.join(' · ') }));
      if (c.ferme) {
        companyBox.appendChild(el('div', {
          class: 'company-d', style: 'color:#92400e',
          text: '⚠ Cet établissement est indiqué comme fermé dans l’annuaire — vérifiez la sélection.'
        }));
      }
      companyBox.style.display = 'block';
    }

    /* ---------- Validation ---------- */
    function erreurChamp(input, message) {
      input.classList.add('is-err');
      var p = input.parentNode.querySelector('.err');
      if (!p) { p = el('p', { class: 'err' }); input.parentNode.appendChild(p); }
      p.textContent = message;
      return false;
    }
    function okChamp(input) {
      input.classList.remove('is-err');
      var p = input.parentNode.querySelector('.err');
      if (p) p.remove();
      return true;
    }

    function valider() {
      var ok = true;
      var mail = $('#f-mail');

      if (!state.company && !(state.manuel && qInput.value.trim().length > 1)) {
        ok = erreurChamp(qInput, 'Sélectionnez votre entreprise dans la liste, ou saisissez-la à la main.');
      } else okChamp(qInput);

      // Volontairement permissif : un motif trop strict recale des adresses valides
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(mail.value.trim())) {
        ok = erreurChamp(mail, 'Indiquez un e-mail professionnel valide.');
      } else okChamp(mail);

      return ok;
    }

    /* ---------- Envoi ---------- */
    function payload(extra) {
      var c = state.company;
      return Object.assign({
        type: 'creation_simulateur',
        source: 'page de vente EVASIMU',
        formule: 'decouverte',
        entreprise: {
          raisonSociale: c ? c.nom : qInput.value.trim(),
          siret: c ? c.siret : '',
          siren: c ? c.siren : '',
          adresse: c ? c.adresse : '',
          codePostal: c ? c.codePostal : '',
          ville: c ? c.ville : '',
          codeApe: c ? c.ape : '',
          libelleApe: c ? c.apeLibelle : '',
          effectif: c ? c.effectif : '',
          dateCreation: c ? c.creation : '',
          saisieManuelle: !c
        },
        contact: {
          email: $('#f-mail').value.trim(),
          telephone: '',
          siteWeb: ''
        }
      }, extra || {});
    }

    function texteLead(d) {
      var e = d.entreprise, ct = d.contact;
      return [
        'DEMANDE DE CRÉATION DE SIMULATEUR (formule Découverte, gratuite)',
        '',
        '— Entreprise —',
        'Raison sociale : ' + e.raisonSociale + (e.saisieManuelle ? '  (saisie manuelle)' : ''),
        'SIRET : ' + (e.siret || '—') + '   SIREN : ' + (e.siren || '—'),
        'Adresse : ' + ([e.adresse, [e.codePostal, e.ville].filter(Boolean).join(' ')].filter(Boolean).join(' — ') || '—'),
        'Activité : ' + ((e.codeApe ? e.codeApe + (e.libelleApe ? ' — ' + e.libelleApe : '') : '') || '—'),
        'Effectif : ' + (e.effectif || '—') + '   Création : ' + (e.dateCreation || '—'),
        '',
        '— Contact —',
        'E-mail : ' + ct.email,
        'Téléphone : ' + (ct.telephone || '—'),
        'Site web : ' + (ct.siteWeb || '—')
      ].join('\n');
    }

    function envoyer(d) {
      if (!CONFIG.leadEndpoint) return Promise.reject(new Error('sans endpoint'));
      return fetch(CONFIG.leadEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(d)
      }).then(function (r) { if (!r.ok) throw new Error(r.status); return r; });
    }

    function lienMailto(d) {
      return 'mailto:' + CONFIG.contactEmail +
        '?subject=' + encodeURIComponent('[SaaS] Simulateur à créer — ' + d.entreprise.raisonSociale) +
        '&body=' + encodeURIComponent(texteLead(d));
    }

    /* ---------- Écran de sortie ----------
     * C'est ici que la promesse « 60 secondes » devient vraie : le prospect
     * repart avec un simulateur ouvert à son enseigne et ses trois lignes de
     * code, pas avec un « nous revenons vers vous sous 24 h ».
     */
    function apercuUrl(d) {
      return CONFIG.apercuUrl + '?e=' + encodeURIComponent(d.entreprise.raisonSociale);
    }

    var SNIPPET = [
      '<link rel="stylesheet" href="evasimu.css">',
      '<script src="evasimu.js"><\/script>',
      '<div id="simulateur"><\/div>',
      '<script>EvasimuSim.mount(\'#simulateur\', { offersUrl: \'mes-offres.json\' });<\/script>'
    ].join('\n');

    function succes(d, parMail) {
      suivre('form_submit', { canal: parMail ? 'mailto' : 'endpoint' });
      suivre('simulator_generated', {});

      var url = apercuUrl(d);
      var bloc = el('div', { class: 'form-ok essai-ok' });

      bloc.appendChild(el('div', { class: 'form-ok-ico' }, [
        (function () {
          var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          s.setAttribute('class', 'icon');
          var u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
          u.setAttribute('href', '#i-check');
          s.appendChild(u);
          return s;
        })()
      ]));
      bloc.appendChild(el('h3', { text: 'Votre simulateur est ouvert' }));
      bloc.appendChild(el('p', {
        class: 'muted',
        text: 'Il porte l’enseigne « ' + d.entreprise.raisonSociale + ' ». Le catalogue affiché est ' +
          'un catalogue de départ : le vôtre le remplacera, et votre logo sera posé sous 24 h ouvrées. ' +
          'Rien ne vous est facturé, et aucune carte bancaire ne nous a été confiée.'
      }));

      var lien = el('a', {
        class: 'btn btn-primary btn-block btn-lg', href: url, target: '_blank', rel: 'noopener',
        text: 'Ouvrir mon simulateur ', 'data-ev': 'apercu_open'
      });
      bloc.appendChild(lien);

      bloc.appendChild(el('p', {
        class: 'form-etape', style: 'margin-top:26px', text: 'Vos trois lignes de code'
      }));
      bloc.appendChild(el('pre', { class: 'snippet', text: SNIPPET }));
      var copier = el('button', {
        class: 'btn btn-line btn-block', type: 'button', text: 'Copier le code',
        onclick: function () {
          var fini = function () {
            copier.textContent = 'Code copié ✓';
            copier.classList.add('copie-ok');
            suivre('snippet_copied', {});
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(SNIPPET).then(fini, function () { fini(); });
          } else { fini(); }
        }
      });
      bloc.appendChild(copier);

      // Le téléphone se demande ici : à quelqu'un qui a vu le produit, et
      // jamais comme condition d'accès.
      var champTel = el('input', {
        class: 'input', type: 'tel', id: 'f-tel-apres', autocomplete: 'tel',
        inputmode: 'tel', placeholder: '06 12 34 56 78'
      });
      var etat = el('p', { class: 'hint' });
      var envoiTel = el('button', {
        class: 'btn btn-line', type: 'button', text: 'Être rappelé',
        onclick: function () {
          if (digits(champTel.value).length < 9) { etat.textContent = 'Indiquez un numéro valide.'; return; }
          // Copie de la demande déjà partie : les champs du formulaire ont été
          // remplacés par cet écran, `payload()` n'a plus rien à lire.
          var d2 = JSON.parse(JSON.stringify(d));
          d2.contact.telephone = champTel.value.trim();
          d2.type = 'rappel_demande';
          suivre('rappel_demande', {});
          envoyer(d2).then(function () {
            etat.textContent = 'C’est noté : nous vous rappelons sous 24 h ouvrées.';
          }, function () {
            window.location.href = lienMailto(d2);
            etat.textContent = 'Votre messagerie s’est ouverte avec la demande pré-remplie.';
          });
          envoiTel.disabled = true;
        }
      });
      var blocTel = el('div', { class: 'field', style: 'margin-top:26px' }, [
        el('label', { class: 'label', for: 'f-tel-apres', text: 'Vous préférez qu’on en parle ? (facultatif)' }),
        champTel, envoiTel, etat
      ]);
      bloc.appendChild(blocTel);

      if (parMail) {
        bloc.appendChild(el('p', { class: 'form-note' }, [
          el('span', { text: 'Votre messagerie s’est ouverte avec la demande pré-remplie : il ne reste qu’à l’envoyer pour que nous préparions votre catalogue. ' }),
          el('a', { href: lienMailto(d), text: 'Renvoyer par e-mail' })
        ]));
      } else {
        bloc.appendChild(el('p', {
          class: 'form-note',
          text: 'Demande enregistrée. Une question d’ici là : ' + CONFIG.contactEmail
        }));
      }

      form.innerHTML = '';
      form.appendChild(bloc);
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      errBox.style.display = 'none';
      if ($('#f-piege').value) return;              // pot de miel : robot détecté
      if (!valider()) {
        var premier = form.querySelector('.is-err');
        if (premier) premier.focus();
        return;
      }

      var d = payload();
      submitBtn.disabled = true;
      submitBtn.textContent = 'Génération…';

      envoyer(d).then(function () {
        succes(d, false);
      }, function () {
        // Aucun lead ne se perd : l'écran de sortie s'affiche d'abord, la
        // messagerie s'ouvre ensuite — dans cet ordre, sinon la navigation
        // « mailto: » emporte la page avant que le prospect ait vu son aperçu.
        succes(d, true);
        setTimeout(function () { window.location.href = lienMailto(d); }, 400);
      });
    });
  }

  /* ===================== Initialisation ===================== */
  document.addEventListener('DOMContentLoaded', function () {
    suivre('landing_view', { page: document.title });
    initChrome();
    initMenu();
    initTarifs();
    initFormulaire();
  });
})();
