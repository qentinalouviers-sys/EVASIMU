/*!
 * RDF-SOLAR — Formulaire de conversion B2B de la page de vente
 *
 * Capture les leads SaaS : les INSTALLATEURS qui demandent l'essai gratuit.
 * À ne pas confondre avec les « leads visiteurs » du widget (src/rdf-solar-sim.js),
 * qui sont les particuliers et appartiennent à l'installateur client.
 *
 * L'identification de l'entreprise s'appuie sur l'API publique
 * « Recherche d'entreprises » (annuaire-entreprises.data.gouv.fr) : gratuite,
 * sans clé, sans quota déclaré, CORS ouvert — donc appelable directement depuis
 * le navigateur, comme le reste du projet qui refuse les dépendances payantes.
 * Toute panne de cette API doit rester sans conséquence sur la conversion :
 * le prospect peut à tout moment basculer en saisie manuelle.
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
    contactEmail: 'contact@eviatek.fr',
    // Numéro WhatsApp commercial, au format international sans « + ».
    // Vidé, le bouton flottant renverrait vers le formulaire d'essai plutôt que
    // vers un numéro inexistant.
    whatsapp: '33614746975',
    whatsappMessage: 'Bonjour RDF-SOLAR ! Je suis installateur photovoltaïque et je souhaite en savoir plus sur le simulateur.',
    trialDays: 30,
    apiUrl: 'https://recherche-entreprises.api.gouv.fr/search',
    apiTimeoutMs: 8000,
    minChars: 3,
    debounceMs: 320
  };

  // Surcharge sans toucher au code, sur le modèle de `window.RDF_SOLAR_LOCAL`
  // utilisé pour les clés API : déclarez `window.RDF_SOLAR_VENTE = { leadEndpoint: '…' }`
  // avant ce script (ou dans un config/local.js non commité).
  var override = window.RDF_SOLAR_VENTE || {};
  Object.keys(override).forEach(function (k) {
    if (Object.prototype.hasOwnProperty.call(CONFIG, k)) CONFIG[k] = override[k];
  });

  /* ===================== Utilitaires ===================== */
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function digits(s) { return String(s || '').replace(/\D/g, ''); }

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
      wa.setAttribute('aria-label', 'Aller au formulaire d’essai gratuit');
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
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    if (top) top.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: reduit ? 'auto' : 'smooth' });
    });

    // Apparition progressive des blocs. Sans IntersectionObserver (ou en
    // mouvement réduit), tout est affiché d'emblée : jamais de contenu masqué.
    var blocs = document.querySelectorAll('.reveal');
    if (reduit || !('IntersectionObserver' in window)) {
      Array.prototype.forEach.call(blocs, function (b) { b.classList.add('is-in'); });
      return;
    }
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('is-in'); obs.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
    Array.prototype.forEach.call(blocs, function (b, i) {
      b.style.transitionDelay = (Math.min(i % 4, 3) * 70) + 'ms';
      obs.observe(b);
    });
  }

  /* ===================== Initialisation ===================== */
  document.addEventListener('DOMContentLoaded', function () {
    initChrome();

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
      list.forEach(function (c, i) {
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
      $('#f-nom').focus();
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
      var nom = $('#f-nom'), mail = $('#f-mail'), tel = $('#f-tel');

      if (!state.company && !(state.manuel && qInput.value.trim().length > 1)) {
        ok = erreurChamp(qInput, 'Sélectionnez votre entreprise dans la liste, ou saisissez-la à la main.');
      } else okChamp(qInput);

      if (nom.value.trim().length < 2) ok = erreurChamp(nom, 'Indiquez votre nom.');
      else okChamp(nom);

      // Volontairement permissif : un motif trop strict recale des adresses valides
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(mail.value.trim())) {
        ok = erreurChamp(mail, 'Indiquez un e-mail professionnel valide.');
      } else okChamp(mail);

      if (digits(tel.value).length < 9) ok = erreurChamp(tel, 'Indiquez un numéro de téléphone valide.');
      else okChamp(tel);

      return ok;
    }

    /* ---------- Envoi ---------- */
    function payload() {
      var c = state.company;
      return {
        type: 'essai_gratuit_saas',
        source: 'page de vente RDF-SOLAR',
        dureeEssaiJours: CONFIG.trialDays,
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
          nom: $('#f-nom').value.trim(),
          email: $('#f-mail').value.trim(),
          telephone: $('#f-tel').value.trim(),
          siteWeb: $('#f-site').value.trim()
        }
      };
    }

    function texteLead(d) {
      var e = d.entreprise, ct = d.contact;
      return [
        'DEMANDE D’ESSAI GRATUIT (' + d.dureeEssaiJours + ' jours)',
        '',
        '— Entreprise —',
        'Raison sociale : ' + e.raisonSociale + (e.saisieManuelle ? '  (saisie manuelle)' : ''),
        'SIRET : ' + (e.siret || '—') + '   SIREN : ' + (e.siren || '—'),
        'Adresse : ' + ([e.adresse, [e.codePostal, e.ville].filter(Boolean).join(' ')].filter(Boolean).join(' — ') || '—'),
        'Activité : ' + ((e.codeApe ? e.codeApe + (e.libelleApe ? ' — ' + e.libelleApe : '') : '') || '—'),
        'Effectif : ' + (e.effectif || '—') + '   Création : ' + (e.dateCreation || '—'),
        '',
        '— Contact —',
        'Nom : ' + ct.nom,
        'E-mail : ' + ct.email,
        'Téléphone : ' + ct.telephone,
        'Site web : ' + (ct.siteWeb || '—')
      ].join('\n');
    }

    function succes(parMail) {
      form.innerHTML = '';
      form.appendChild(el('div', { class: 'form-ok' }, [
        el('div', { class: 'form-ok-ico', text: '✅' }),
        el('h3', { text: 'Demande enregistrée' }),
        el('p', {
          class: 'muted',
          text: parMail
            ? 'Votre logiciel de messagerie s’est ouvert avec la demande pré-remplie : il ne reste qu’à l’envoyer. Nous revenons vers vous sous 24 h ouvrées.'
            : 'Nous configurons votre simulateur avec vos offres et revenons vers vous sous 24 h ouvrées pour l’installer sur votre site.'
        }),
        el('p', { class: 'muted small', text: 'Une question d’ici là : ' + CONFIG.contactEmail })
      ]));
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function envoyerParMail(d) {
      window.location.href = 'mailto:' + CONFIG.contactEmail +
        '?subject=' + encodeURIComponent('[SaaS] Essai gratuit — ' + d.entreprise.raisonSociale) +
        '&body=' + encodeURIComponent(texteLead(d));
      succes(true);
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
      submitBtn.textContent = 'Envoi…';

      var fini = function () {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Démarrer mon essai gratuit';
      };

      if (!CONFIG.leadEndpoint) { fini(); envoyerParMail(d); return; }

      fetch(CONFIG.leadEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(d)
      })
        .then(function (r) { if (!r.ok) throw new Error(r.status); fini(); succes(false); })
        .catch(function () { fini(); envoyerParMail(d); });   // aucun lead ne se perd
    });
  });
})();
