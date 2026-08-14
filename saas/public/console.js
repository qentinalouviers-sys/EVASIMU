/**
 * Console de l'éditeur — sans framework ni build : le fichier se lit et se
 * modifie directement, ce qui compte quand ce sont des agents qui feront
 * évoluer l'outil.
 */
'use strict';

var etat = { moi: null, vue: 'tableau', client: null, donnees: {} };

/* ---------- utilitaires ---------- */

function h(tag, attrs, enfants) {
  var n = document.createElement(tag);
  Object.keys(attrs || {}).forEach(function (k) {
    if (k === 'class') n.className = attrs[k];
    else if (k === 'html') n.innerHTML = attrs[k];
    else if (k === 'text') n.textContent = attrs[k];
    else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
    else if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
  });
  (enfants || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
  return n;
}
function $(s) { return document.querySelector(s); }
function eur(n) { return (Math.round(n) || 0).toLocaleString('fr-FR') + ' €'; }
function date(s) { return s ? new Date(s).toLocaleDateString('fr-FR') : '—'; }

function toast(msg, erreur) {
  var t = h('div', { class: 'toast', text: msg });
  if (erreur) t.style.background = '#b91c1c';
  document.body.appendChild(t);
  setTimeout(function () { t.remove(); }, 3200);
}

async function api(chemin, options) {
  var o = Object.assign({ headers: {} }, options || {});
  if (o.body && typeof o.body !== 'string') {
    o.body = JSON.stringify(o.body);
    o.headers['Content-Type'] = 'application/json';
  }
  var r = await fetch('/api/v1' + chemin, o);
  var j = null;
  try { j = await r.json(); } catch (e) { /* 204 */ }
  if (!r.ok) throw new Error((j && j.erreur) || ('HTTP ' + r.status));
  return j;
}

function copier(texte, bouton) {
  navigator.clipboard.writeText(texte).then(function () {
    var avant = bouton.textContent;
    bouton.textContent = '✓ Copié';
    setTimeout(function () { bouton.textContent = avant; }, 1600);
  });
}

/* ---------- connexion ---------- */

function vueConnexion(message) {
  var email = h('input', { type: 'email', autocomplete: 'username', placeholder: 'vous@exemple.fr' });
  var mdp = h('input', { type: 'password', autocomplete: 'current-password', placeholder: '••••••••' });
  var err = h('p', { class: 'muted', style: 'color:#b91c1c;display:none' });
  async function envoyer() {
    try {
      await api('/connexion', { method: 'POST', body: { email: email.value, motDePasse: mdp.value } });
      demarrer();
    } catch (e) {
      err.textContent = e.message; err.style.display = 'block';
    }
  }
  mdp.addEventListener('keydown', function (e) { if (e.key === 'Enter') envoyer(); });
  $('#app').innerHTML = '';
  $('#app').appendChild(h('div', { id: 'connexion' }, [
    h('div', { class: 'carte' }, [
      h('h2', { text: '☀ Console simulateur' }),
      h('p', { class: 'muted', text: message || 'Connectez-vous pour gérer vos clients et votre prospection.' }),
      h('label', { text: 'E-mail' }), email,
      h('label', { text: 'Mot de passe' }), mdp,
      err,
      h('div', { style: 'margin-top:14px' }, [
        h('button', { class: 'p', style: 'width:100%', text: 'Se connecter', onclick: envoyer })
      ])
    ])
  ]));
  email.focus();
}

/* ---------- ossature ---------- */

function rendre() {
  var vues = [
    ['tableau', 'Tableau de bord'], ['clients', 'Clients'], ['prospects', 'Prospection'],
    ['leads', 'Leads'], ['facturation', 'Facturation'], ['agents', 'Agents IA']
  ];
  $('#app').innerHTML = '';
  $('#app').appendChild(h('header', {}, [
    h('b', { text: '☀ Console' }),
    h('nav', {}, vues.map(function (v) {
      return h('button', {
        class: etat.vue === v[0] ? 'on' : '', text: v[1],
        onclick: function () { etat.vue = v[0]; etat.client = null; charger(); }
      });
    })),
    h('div', { class: 'sp' }, [
      h('span', { text: (etat.moi && etat.moi.identite.email) || '' }),
      h('button', {
        text: 'Quitter', style: 'background:transparent;border:1px solid rgba(255,255,255,.3);color:#fff',
        onclick: async function () { await api('/deconnexion', { method: 'POST' }); vueConnexion('À bientôt.'); }
      })
    ])
  ]));
  $('#app').appendChild(h('main', { id: 'main' }, [h('p', { class: 'muted', text: 'Chargement…' })]));
}

async function charger() {
  rendre();
  var m = $('#main');
  try {
    if (etat.client) return vueClient(m, etat.client);
    if (etat.vue === 'tableau') return vueTableau(m);
    if (etat.vue === 'clients') return vueClients(m);
    if (etat.vue === 'prospects') return vueProspects(m);
    if (etat.vue === 'leads') return vueLeads(m);
    if (etat.vue === 'facturation') return vueFacturation(m);
    if (etat.vue === 'agents') return vueAgents(m);
  } catch (e) {
    m.innerHTML = '';
    m.appendChild(h('div', { class: 'carte' }, [h('p', { class: 'muted', text: 'Erreur : ' + e.message })]));
  }
}

/* ---------- tableau de bord ---------- */

async function vueTableau(m) {
  var d = await api('/tableau-de-bord');
  m.innerHTML = '';
  m.appendChild(h('div', { class: 'grille g4', style: 'margin-bottom:14px' }, [
    kpi(d.clients.payants, 'clients payants'),
    kpi(d.clients.essai, 'en essai'),
    kpi(eur(d.arrHT), 'revenu annuel HT'),
    kpi(d.derniersLeads.length, 'leads récents')
  ]));

  if (d.essaisQuiFinissent.length) {
    m.appendChild(h('div', { class: 'carte' }, [
      h('h2', { text: '⏳ Essais qui se terminent' }),
      h('p', { class: 'muted', text: 'C’est le moment de sortir les chiffres d’usage : ils font l’argument.' }),
      tableau(['Client', 'Reste', ''], d.essaisQuiFinissent.map(function (c) {
        return [c.nom, c.joursRestants + ' j',
          h('button', { text: 'Ouvrir', onclick: function () { ouvrirClient(c.cle); } })];
      }))
    ]));
  }

  m.appendChild(h('div', { class: 'carte' }, [
    h('h2', { text: 'Pipeline commercial' }),
    h('div', { class: 'ligne' }, d.pipeline.map(function (e) {
      return h('div', { class: 'etape' }, [h('b', { text: String(e.total) }), h('span', { text: e.nom })]);
    }))
  ]));

  if (d.aFaire.length) {
    m.appendChild(h('div', { class: 'carte' }, [
      h('h2', { text: '📞 Relances du jour' }),
      tableau(['Entreprise', 'Ville', 'Prévue le', ''], d.aFaire.map(function (p) {
        return [p.entreprise, p.ville, date(p.prochaine_action),
          h('button', { text: 'Fiche', onclick: function () { ouvrirProspect(p.id); } })];
      }))
    ]));
  }

  m.appendChild(h('div', { class: 'carte' }, [
    h('h2', { text: 'Derniers leads des clients' }),
    d.derniersLeads.length
      ? tableau(['Client', 'Nom', 'Téléphone', 'Type', 'Reçu le'], d.derniersLeads.map(function (l) {
        return [l.nom_client, l.nom, l.telephone, l.type, date(l.cree_le)];
      }))
      : h('p', { class: 'vide', text: 'Aucun lead pour l’instant.' })
  ]));
}

function kpi(valeur, libelle) {
  return h('div', { class: 'kpi' }, [h('b', { text: String(valeur) }), h('span', { text: libelle })]);
}

function tableau(entetes, lignes) {
  return h('table', {}, [
    h('thead', {}, [h('tr', {}, entetes.map(function (e) { return h('th', { text: e }); }))]),
    h('tbody', {}, lignes.map(function (l) {
      return h('tr', {}, l.map(function (c) {
        return h('td', {}, [typeof c === 'object' && c !== null ? c : document.createTextNode(c === null || c === undefined ? '' : String(c))]);
      }));
    }))
  ]);
}

/* ---------- clients ---------- */

async function vueClients(m) {
  var d = await api('/clients');
  m.innerHTML = '';
  m.appendChild(h('div', { class: 'bar' }, [
    h('button', { class: 'p', text: '+ Nouveau client', onclick: dialogueNouveauClient })
  ]));
  m.appendChild(h('div', { class: 'carte' }, [
    d.clients.length ? tableau(
      ['Nom', 'État', 'Formule', 'Domaines', 'Maj', ''],
      d.clients.map(function (c) {
        return [
          h('b', { text: c.nom }),
          h('span', { class: 'pill ' + c.statut, text: c.statut + (c.joursRestants !== null ? ' · ' + c.joursRestants + ' j' : '') }),
          c.formule, c.domaines || '—', date(c.maj_le),
          h('div', { class: 'ligne' }, [
            h('button', { text: 'Gérer', onclick: function () { ouvrirClient(c.cle); } }),
            h('button', {
              text: c.actif ? '⏸ Couper' : '▶ Rétablir',
              onclick: async function () {
                await api('/clients/' + c.cle + '/' + (c.actif ? 'suspendre' : 'reprendre'), { method: 'POST' });
                toast(c.actif ? 'Widget coupé' : 'Widget rétabli'); charger();
              }
            })
          ])
        ];
      })
    ) : h('p', { class: 'vide', text: 'Aucun client. Créez-en un pour générer son widget.' })
  ]));
}

function dialogueNouveauClient() {
  var nom = h('input', { placeholder: 'Solaire du Vexin' });
  var domaines = h('input', { placeholder: 'solaire-du-vexin.fr' });
  var formule = h('select', {}, (etat.moi.formules.formules).map(function (f) {
    return h('option', { value: f.id, text: f.nom + ' — ' + f.prixHTAn + ' € HT/an' });
  }));
  var jours = h('select', {}, etat.moi.formules.essaiJoursProposables.map(function (j) {
    return h('option', { value: j, text: j + ' jours', selected: j === etat.moi.formules.essaiJoursDefaut ? '' : null });
  }));
  jours.value = String(etat.moi.formules.essaiJoursDefaut);
  var dlg = h('dialog', {}, [h('div', { class: 'in' }, [
    h('h2', { text: 'Nouveau client' }),
    h('label', { text: 'Nom de l’entreprise' }), nom,
    h('label', { text: 'Domaine(s) autorisé(s) — séparés par des virgules' }), domaines,
    h('p', { class: 'mini', text: 'Laissez vide pour autoriser tous les sites (pratique en démonstration).' }),
    h('label', { text: 'Formule' }), formule,
    h('label', { text: 'Essai' }), jours,
    h('div', { class: 'ligne', style: 'margin-top:16px;justify-content:flex-end' }, [
      h('button', { text: 'Annuler', onclick: function () { dlg.close(); } }),
      h('button', {
        class: 'p', text: 'Créer et générer le widget',
        onclick: async function () {
          try {
            var r = await api('/clients', {
              method: 'POST',
              body: { nom: nom.value, domaines: domaines.value, formule: formule.value, essaiJours: +jours.value }
            });
            dlg.close(); toast('Client créé'); ouvrirClient(r.client.cle);
          } catch (e) { toast(e.message, true); }
        }
      })
    ])
  ])]);
  document.body.appendChild(dlg);
  dlg.showModal();
  dlg.addEventListener('close', function () { dlg.remove(); });
  nom.focus();
}

function ouvrirClient(cle) { etat.client = cle; charger(); }

async function vueClient(m, cle) {
  var d = (await api('/clients/' + cle)).client;
  var cfg = d.config || {};
  var theme = cfg.theme || {};
  var marque = cfg.marque || {};
  m.innerHTML = '';

  m.appendChild(h('div', { class: 'bar' }, [
    h('button', { text: '← Clients', onclick: function () { etat.client = null; charger(); } }),
    h('span', { class: 'pill ' + d.statut, text: d.statut + (d.joursRestants !== null ? ' · ' + d.joursRestants + ' j' : '') }),
    h('span', { class: 'mini', text: d.motif || '' })
  ]));

  /* -- état commercial -- */
  var joursEssai = h('select', { style: 'width:auto' }, etat.moi.formules.essaiJoursProposables.map(function (j) {
    return h('option', { value: j, text: j + ' j' });
  }));
  joursEssai.value = String(etat.moi.formules.essaiJoursDefaut);
  async function action(a, corps) {
    try { await api('/clients/' + cle + '/' + a, { method: 'POST', body: corps || {} }); toast('Fait'); charger(); }
    catch (e) { toast(e.message, true); }
  }
  m.appendChild(h('div', { class: 'carte' }, [
    h('h2', { text: d.nom }),
    h('div', { class: 'ligne' }, [
      h('button', {
        class: d.actif ? '' : 'p', text: d.actif ? '⏸ Couper le widget' : '▶ Rétablir le widget',
        onclick: function () { action(d.actif ? 'suspendre' : 'reprendre'); }
      }),
      joursEssai,
      h('button', { text: '⏳ (Re)démarrer l’essai', onclick: function () { action('essai', { jours: +joursEssai.value }); } }),
      h('button', { class: 'p', text: '✓ Activer 12 mois', onclick: function () { action('activer', { mois: 12 }); } })
    ]),
    h('p', { class: 'mini', style: 'margin-top:10px' , text:
      'Essai jusqu’au ' + date(d.essai_fin) + ' · abonnement jusqu’au ' + date(d.abonnement_fin) +
      ' · page d’abonnement : ' + d.urls.abonnement })
  ]));

  /* -- usage -- */
  var s = d.stats;
  m.appendChild(h('div', { class: 'carte' }, [
    h('h2', { text: 'Usage sur 30 jours' }),
    h('div', { class: 'grille g4' }, [
      kpi(s.affichages, 'affichages du widget'),
      kpi(s.simulations, 'étapes de simulation'),
      kpi(s.leads, 'leads sur la période'),
      kpi(s.leadsTotal, 'leads au total')
    ]),
    h('p', { class: 'mini', style: 'margin-top:10px', text:
      'Ces chiffres sont l’argument de la relance de fin d’essai : ils disent ce que le widget a rapporté.' })
  ]));

  /* -- intégration -- */
  var extraits = d.extraits;
  m.appendChild(h('div', { class: 'carte' }, [
    h('h2', { text: 'Installer le simulateur' }),
    h('div', { class: 'grille g2' }, Object.keys(extraits).map(function (k) {
      var e = extraits[k];
      return h('div', {}, [
        h('h3', { text: e.titre }),
        h('p', { class: 'mini', text: e.aide }),
        h('pre', { text: e.code }),
        h('button', { text: 'Copier', onclick: function (ev) { copier(e.code, ev.target); } })
      ]);
    })),
    h('div', { class: 'ligne', style: 'margin-top:12px' }, [
      h('a', { href: d.urls.widget, target: '_blank', text: '↗ Voir le widget' }),
      h('a', { href: d.urls.partage, target: '_blank', text: '↗ Page de partage' }),
      h('a', { href: d.urls.abonnement, target: '_blank', text: '↗ Page d’abonnement' })
    ])
  ]));

  /* -- personnalisation -- */
  var champs = {
    couleurPrincipale: h('input', { type: 'color', value: theme.couleurPrincipale || '#0f2a43' }),
    couleurAccent: h('input', { type: 'color', value: theme.couleurAccent || '#f59e0b' }),
    couleurFond: h('input', { type: 'color', value: theme.couleurFond || '#f6f8fa' }),
    arrondi: h('input', { type: 'number', min: 0, max: 28, value: theme.arrondi != null ? theme.arrondi : 12 }),
    logoUrl: h('input', { placeholder: 'https://… ou logo téléversé', value: theme.logoUrl || '' }),
    name: h('input', { value: marque.name || d.nom }),
    accroche: h('input', { value: marque.accroche || '', placeholder: 'Visualisez votre future installation…' }),
    phone: h('input', { value: marque.phone || '', placeholder: '02 32 00 00 00' }),
    contactEmail: h('input', { type: 'email', value: marque.contactEmail || '' }),
    whatsapp: h('input', { value: marque.whatsapp || '', placeholder: '33600000000' }),
    devisEndpoint: h('input', { value: marque.devisEndpoint || '', placeholder: 'https://votre-crm/webhook' }),
    politiqueConfidentialiteUrl: h('input', { value: marque.politiqueConfidentialiteUrl || '' }),
    rgeMention: h('input', { value: marque.rgeMention || '' })
  };
  var fichier = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml' });
  fichier.addEventListener('change', function () {
    var f = fichier.files[0];
    if (!f) return;
    if (f.size > 260000) { toast('Logo trop lourd (260 Ko maximum)', true); return; }
    var fr = new FileReader();
    fr.onload = function () { champs.logoUrl.value = fr.result; toast('Logo chargé — pensez à enregistrer'); };
    fr.readAsDataURL(f);
  });
  var domainesInput = h('input', { value: d.domaines || '', placeholder: 'exemple.fr, www.exemple.fr' });

  m.appendChild(h('div', { class: 'carte' }, [
    h('h2', { text: 'Personnalisation' }),
    h('div', { class: 'grille g3' }, [
      h('div', {}, [h('label', { text: 'Couleur principale' }), champs.couleurPrincipale]),
      h('div', {}, [h('label', { text: 'Couleur d’accent' }), champs.couleurAccent]),
      h('div', {}, [h('label', { text: 'Fond' }), champs.couleurFond]),
      h('div', {}, [h('label', { text: 'Arrondi (px)' }), champs.arrondi])
    ]),
    h('label', { text: 'Logo (URL ou fichier)' }), champs.logoUrl, fichier,
    h('div', { class: 'grille g2' }, [
      h('div', {}, [h('label', { text: 'Nom affiché' }), champs.name]),
      h('div', {}, [h('label', { text: 'Accroche' }), champs.accroche]),
      h('div', {}, [h('label', { text: 'Téléphone' }), champs.phone]),
      h('div', {}, [h('label', { text: 'E-mail de contact' }), champs.contactEmail]),
      h('div', {}, [h('label', { text: 'WhatsApp (indicatif compris)' }), champs.whatsapp]),
      h('div', {}, [h('label', { text: 'Webhook CRM (https)' }), champs.devisEndpoint]),
      h('div', {}, [h('label', { text: 'Politique de confidentialité' }), champs.politiqueConfidentialiteUrl]),
      h('div', {}, [h('label', { text: 'Mention RGE' }), champs.rgeMention]),
      h('div', {}, [h('label', { text: 'Domaines autorisés' }), domainesInput])
    ]),
    h('div', { class: 'ligne', style: 'margin-top:14px' }, [
      h('button', {
        class: 'p', text: 'Enregistrer',
        onclick: async function () {
          try {
            await api('/clients/' + cle, {
              method: 'PATCH',
              body: {
                domaines: domainesInput.value,
                config: {
                  theme: {
                    couleurPrincipale: champs.couleurPrincipale.value,
                    couleurAccent: champs.couleurAccent.value,
                    couleurFond: champs.couleurFond.value,
                    arrondi: +champs.arrondi.value,
                    logoUrl: champs.logoUrl.value
                  },
                  marque: {
                    name: champs.name.value, accroche: champs.accroche.value,
                    phone: champs.phone.value, contactEmail: champs.contactEmail.value,
                    whatsapp: champs.whatsapp.value, devisEndpoint: champs.devisEndpoint.value,
                    politiqueConfidentialiteUrl: champs.politiqueConfidentialiteUrl.value,
                    rgeMention: champs.rgeMention.value
                  }
                }
              }
            });
            toast('Personnalisation enregistrée'); charger();
          } catch (e) { toast(e.message, true); }
        }
      }),
      h('a', { href: d.urls.widget, target: '_blank', text: '↗ Prévisualiser' })
    ])
  ]));

  /* -- pages SEO -- */
  var ville = h('input', { placeholder: 'Louviers' });
  var dept = h('input', { placeholder: 'Eure' });
  m.appendChild(h('div', { class: 'carte' }, [
    h('h2', { text: 'Pages hébergées (SEO local)' }),
    h('p', { class: 'muted', text: 'Une page par ville d’intervention : titre, description, données structurées ' +
      'LocalBusiness et FAQ, maillage entre les villes, et le simulateur intégré.' }),
    d.pages.length ? tableau(['Ville', 'Adresse', ''], d.pages.map(function (p) {
      return [p.ville, h('a', { href: '/p/' + p.slug, target: '_blank', text: '/p/' + p.slug }),
        h('button', {
          class: 'd', text: 'Supprimer',
          onclick: async function () { await api('/pages/' + p.id, { method: 'DELETE' }); charger(); }
        })];
    })) : h('p', { class: 'mini', text: 'Aucune page pour l’instant.' }),
    h('div', { class: 'grille g3', style: 'margin-top:10px' }, [
      h('div', {}, [h('label', { text: 'Ville' }), ville]),
      h('div', {}, [h('label', { text: 'Département' }), dept]),
      h('div', { style: 'display:flex;align-items:flex-end' }, [
        h('button', {
          text: '+ Créer la page',
          onclick: async function () {
            if (!ville.value.trim()) { toast('Indiquez une ville', true); return; }
            try {
              await api('/clients/' + cle + '/pages', { method: 'POST', body: { ville: ville.value, departement: dept.value } });
              toast('Page créée'); charger();
            } catch (e) { toast(e.message, true); }
          }
        })
      ])
    ])
  ]));

  /* -- leads -- */
  try {
    var leads = (await api('/clients/' + cle + '/leads')).leads;
    m.appendChild(h('div', { class: 'carte' }, [
      h('h2', { text: 'Leads reçus (' + leads.length + ')' }),
      leads.length ? tableau(['Reçu le', 'Nom', 'Téléphone', 'Type', 'Projet'], leads.slice(0, 50).map(function (l) {
        var sim = (l.charge && l.charge.simulation) || {};
        return [date(l.cree_le), l.nom, l.telephone, l.type,
          (sim.kwc ? sim.kwc + ' kWc · ' + (sim.productionKwhAn || '?') + ' kWh/an' : '—')];
      })) : h('p', { class: 'vide', text: 'Aucun lead pour l’instant.' })
    ]));
  } catch (e) { /* portée leads:lire absente */ }

  m.appendChild(h('div', { class: 'carte' }, [
    h('h2', { text: 'Zone de danger' }),
    h('button', {
      class: 'd', text: 'Supprimer ce client et ses données',
      onclick: async function () {
        if (!confirm('Supprimer définitivement ' + d.nom + ' ? Leads et pages seront perdus.')) return;
        await api('/clients/' + cle, { method: 'DELETE' });
        toast('Client supprimé'); etat.client = null; charger();
      }
    })
  ]));
}

/* ---------- prospection ---------- */

async function vueProspects(m) {
  var recherche = h('input', { placeholder: 'Rechercher (entreprise, ville, e-mail)…', style: 'max-width:320px' });
  var filtreStatut = h('select', { style: 'width:auto' }, [h('option', { value: '', text: 'Tous les statuts' })]
    .concat(etat.moi.etapes.map(function (e) { return h('option', { value: e.id, text: e.nom }); })));
  // Trois questions qu'on se pose vraiment devant une liste de prospects, et
  // auxquelles seule l'inspection permet de répondre.
  var filtreInsp = h('select', { style: 'width:auto' }, [
    h('option', { value: '', text: 'Tous' }),
    h('option', { value: 'cible=true', text: 'À démarcher' }),
    h('option', { value: 'niveauMax=0', text: 'Sans simulateur' }),
    h('option', { value: 'cible=false', text: 'Écartés (déjà équipés)' }),
    h('option', { value: 'inspecte=false', text: 'Site pas encore inspecté' })
  ]);
  var corps = h('div', {});
  async function rafraichir() {
    var q = [];
    if (recherche.value) q.push('q=' + encodeURIComponent(recherche.value));
    if (filtreStatut.value) q.push('statut=' + filtreStatut.value);
    if (filtreInsp.value) q.push(filtreInsp.value);
    var d = await api('/prospects' + (q.length ? '?' + q.join('&') : ''));
    corps.innerHTML = '';
    corps.appendChild(h('div', { class: 'ligne', style: 'margin-bottom:12px' }, d.pipeline.map(function (e) {
      return h('div', { class: 'etape' }, [h('b', { text: String(e.total) }), h('span', { text: e.nom })]);
    })));
    corps.appendChild(h('div', { class: 'carte' }, [
      d.prospects.length ? tableau(['Entreprise', 'Ville', 'Site', 'Leur simulateur', 'Statut', 'Relance', ''],
        d.prospects.map(function (p) {
          return [
            h('b', { text: p.entreprise }), p.ville,
            p.site ? h('a', { href: 'https://' + p.site, target: '_blank', text: p.site }) : '—',
            celluleSimulateur(p),
            h('span', { class: 'pill ' + (p.statut === 'client' ? 'actif' : 'essai'), text: p.statut }),
            date(p.prochaine_action),
            h('button', { text: 'Fiche', onclick: function () { ouvrirProspect(p.id); } })
          ];
        })) : h('p', { class: 'vide', text: 'Aucun prospect. Importez une liste (JSON, CSV, tableur, adresses) ou laissez un agent la remplir.' })
    ]));
  }
  recherche.addEventListener('input', function () { clearTimeout(recherche._t); recherche._t = setTimeout(rafraichir, 300); });
  filtreStatut.addEventListener('change', rafraichir);
  filtreInsp.addEventListener('change', rafraichir);

  m.innerHTML = '';
  m.appendChild(h('div', { class: 'bar' }, [
    recherche, filtreStatut, filtreInsp,
    h('button', { class: 'p', text: '+ Prospect', onclick: function () { dialogueProspect(null, rafraichir); } }),
    h('button', { text: '⬆ Importer une liste', onclick: function () { dialogueImport(rafraichir); } })
  ]));
  m.appendChild(corps);
  await rafraichir();
}

function dialogueProspect(existant, apres) {
  var p = existant || {};
  var c = {
    entreprise: h('input', { value: p.entreprise || '' }),
    contact: h('input', { value: p.contact || '' }),
    telephone: h('input', { value: p.telephone || '' }),
    email: h('input', { value: p.email || '' }),
    site: h('input', { value: p.site || '' }),
    ville: h('input', { value: p.ville || '' }),
    departement: h('input', { value: p.departement || '' }),
    metier: h('input', { value: p.metier || 'photovoltaïque' }),
    prochaine_action: h('input', { type: 'date', value: (p.prochaine_action || '').slice(0, 10) }),
    notes: h('textarea', { rows: 3 })
  };
  c.notes.value = p.notes || '';
  var statut = h('select', {}, etat.moi.etapes.map(function (e) {
    return h('option', { value: e.id, text: e.nom });
  }));
  statut.value = p.statut || 'nouveau';
  var dlg = h('dialog', {}, [h('div', { class: 'in' }, [
    h('h2', { text: existant ? 'Modifier le prospect' : 'Nouveau prospect' }),
    h('div', { class: 'grille g2' }, [
      h('div', {}, [h('label', { text: 'Entreprise' }), c.entreprise]),
      h('div', {}, [h('label', { text: 'Contact' }), c.contact]),
      h('div', {}, [h('label', { text: 'Téléphone' }), c.telephone]),
      h('div', {}, [h('label', { text: 'E-mail' }), c.email]),
      h('div', {}, [h('label', { text: 'Site web' }), c.site]),
      h('div', {}, [h('label', { text: 'Ville' }), c.ville]),
      h('div', {}, [h('label', { text: 'Département' }), c.departement]),
      h('div', {}, [h('label', { text: 'Métier' }), c.metier]),
      h('div', {}, [h('label', { text: 'Statut' }), statut]),
      h('div', {}, [h('label', { text: 'Prochaine relance' }), c.prochaine_action])
    ]),
    h('label', { text: 'Notes' }), c.notes,
    h('div', { class: 'ligne', style: 'margin-top:16px;justify-content:flex-end' }, [
      h('button', { text: 'Annuler', onclick: function () { dlg.close(); } }),
      h('button', {
        class: 'p', text: 'Enregistrer',
        onclick: async function () {
          var corps = { statut: statut.value };
          Object.keys(c).forEach(function (k) { corps[k] = c[k].value; });
          try {
            if (existant) await api('/prospects/' + existant.id, { method: 'PATCH', body: corps });
            else await api('/prospects', { method: 'POST', body: corps });
            dlg.close(); toast('Enregistré'); if (apres) apres(); else charger();
          } catch (e) { toast(e.message, true); }
        }
      })
    ])
  ])]);
  document.body.appendChild(dlg); dlg.showModal();
  dlg.addEventListener('close', function () { dlg.remove(); });
}

function dialogueImport(apres) {
  // Import guidé : on ne demande plus un format précis, on montre ce qui a été
  // compris avant d'écrire quoi que ce soit. Un import raté est pénible à
  // défaire — mieux vaut le voir venir.
  var zone = h('textarea', {
    rows: 8,
    placeholder: 'Collez ici : un export JSON, un CSV Excel, une liste d’adresses…\n\n' +
      'Exemples acceptés :\n' +
      '  [{"nom":"Solaire du Vexin","emails":["contact@solaire-vexin.fr"]}]\n' +
      '  Raison sociale;E-mail;Téléphone\n' +
      '  contact@abc-solaire.fr'
  });
  var fichier = h('input', { type: 'file', accept: '.json,.csv,.tsv,.txt,.ndjson,.xlsx,.xls', style: 'display:none' });
  var zoneDepot = h('div', { class: 'depot' }, [
    h('span', { text: '📄 Glissez un fichier ici, ou ' }),
    h('button', { class: 'lien', text: 'parcourir', onclick: function () { fichier.click(); } })
  ]);
  var apercu = h('div', { class: 'apercu' });
  var btnImporter = h('button', { class: 'p', text: 'Importer', disabled: true });
  var analyse = null;
  var minuteur = null;
  // Le contenu d'un fichier volumineux ne passe PAS par le textarea : y écrire
  // cinq mégaoctets fige la page une dizaine de secondes pour n'afficher que
  // huit lignes d'aperçu. On le garde ici, et la zone n'en montre qu'un résumé.
  var contenu = '';
  function contenuActuel() { return contenu || zone.value; }

  function ligneResume(r, format) {
    var noms = { json: 'JSON', ndjson: 'JSON par ligne', csv: 'CSV', tsv: 'tableur', liste: 'liste', vide: '—' };
    return (noms[format] || format) + ' · ' + r.total + ' ligne(s) — ' +
      r.valides + ' prête(s)' +
      (r.avertis ? ', ' + r.avertis + ' complétée(s) automatiquement' : '') +
      (r.rejetes ? ', ' + r.rejetes + ' rejetée(s)' : '');
  }

  /**
   * Extrait de quoi montrer un aperçu, sans envoyer tout le fichier.
   *
   * L'aperçu sert à vérifier que les colonnes ont été comprises : quelques
   * centaines de lignes suffisent. Envoyer les cinq mégaoctets pour afficher
   * huit lignes se heurterait à la limite du proxy avant même d'avoir commencé.
   * Renvoie aussi le nombre réel de fiches, compté ici.
   */
  function echantillon(texte) {
    var t = texte.replace(/^﻿/, '').trim();
    if (t[0] === '[' || t[0] === '{') {
      try {
        var j = JSON.parse(t);
        var arr = Array.isArray(j) ? j : (j.prospects || [j]);
        return { corps: { prospects: arr.slice(0, 200) }, total: arr.length, tronque: arr.length > 200 };
      } catch (e) {
        // JSON illisible : on laisse le serveur produire le message d'erreur,
        // qui explique bien mieux que « Unexpected token » ce qui est attendu.
        return { corps: { texte: t.slice(0, 200 * 1024) }, total: 0, tronque: false };
      }
    }
    var lignes = t.split(/\r?\n/).filter(function (l) { return l.trim(); });
    var garde = lignes.slice(0, 201);
    return {
      corps: { texte: garde.join('\n') },
      total: lignes.length,
      tronque: lignes.length > garde.length
    };
  }

  async function analyser() {
    var texte = contenuActuel().trim();
    apercu.innerHTML = '';
    analyse = null;
    btnImporter.disabled = true;
    if (!texte) return;
    try {
      var ech = echantillon(texte);
      var corps = ech.corps;
      corps.apercu = true;
      var r = await api('/prospects', { method: 'POST', body: corps });
      analyse = r;
      // L'aperçu ne porte que sur l'échantillon : le décompte affiché doit être
      // celui du fichier entier, sinon on annonce 200 fiches et on en crée 8741.
      var proportion = r.resume.total ? r.resume.valides / r.resume.total : 0;
      var valablesEstimees = ech.tronque ? Math.round(ech.total * proportion) : r.resume.valides;
      if (ech.tronque) r.resume = { total: ech.total, valides: valablesEstimees, rejetes: 0, avertis: 0, estime: true };
      btnImporter.disabled = valablesEstimees === 0;
      btnImporter.textContent = valablesEstimees
        ? 'Importer ' + valablesEstimees.toLocaleString('fr-FR') + ' prospect(s)'
        : 'Rien à importer';

      apercu.appendChild(h('p', {
        class: 'resume ' + (r.resume.rejetes ? 'attention' : 'ok'),
        text: ligneResume(r.resume, r.format)
      }));

      var lignes = r.lignes.slice(0, 8);
      var tbl = h('table', { class: 'tapercu' }, [
        h('thead', {}, [h('tr', {}, ['Entreprise', 'E-mail', 'Téléphone', 'Ville', ''].map(function (t) {
          return h('th', { text: t });
        }))]),
        h('tbody', {}, lignes.map(function (l) {
          var p = l.prospect || {};
          return h('tr', { class: l.valide ? '' : 'ko' }, [
            h('td', { text: p.entreprise || '—' }),
            h('td', { text: p.email || '—' }),
            h('td', { text: p.telephone || '—' }),
            h('td', { text: p.ville || '—' }),
            h('td', {
              class: 'diag',
              title: (l.erreurs.concat(l.avertissements)).join(' · '),
              text: l.erreurs.length ? '✕ ' + l.erreurs[0]
                : (l.avertissements.length ? '≈ ' + l.avertissements[0] : '✓')
            })
          ]);
        }))
      ]);
      apercu.appendChild(tbl);
      if (r.resume.total > lignes.length) {
        apercu.appendChild(h('p', { class: 'muted',
          text: '… et ' + (r.resume.total - lignes.length).toLocaleString('fr-FR') + ' autre(s)' +
            (r.resume.estime ? ' — l’aperçu porte sur les 200 premières, l’import traitera tout le fichier.' : '.') }));
      }
      if (r.resume.rejetes) {
        apercu.appendChild(h('p', {
          class: 'muted',
          text: 'Les lignes rejetées sont ignorées : les autres seront importées normalement.'
        }));
      }
    } catch (e) {
      apercu.appendChild(h('p', { class: 'resume ko', text: e.message }));
    }
  }

  zone.addEventListener('input', function () {
    contenu = '';                       // saisie manuelle : le fichier est oublié
    zone.readOnly = false;
    clearTimeout(minuteur);
    minuteur = setTimeout(analyser, 350);
  });

  function chargerFichier(f) {
    if (!f) return;
    // L'envoi se fait par lots : la taille du fichier n'est plus une limite.
    // Ce plafond ne protège que contre un glisser-déposer manifestement fautif.
    if (f.size > 64 * 1024 * 1024) { toast('Fichier trop volumineux (64 Mo maximum)', true); return; }
    var fr = new FileReader();
    fr.onload = function () {
      contenu = fr.result;
      var gros = contenu.length > 256 * 1024;
      // Au-delà, on n'affiche que le début : le fichier reste entier en mémoire
      // et c'est lui qui sera envoyé, par lots.
      zone.value = gros
        ? '📄 ' + f.name + ' — ' + Math.round(f.size / 1024) + ' Ko chargés.\n' +
          'Aperçu du début du fichier :\n\n' + contenu.slice(0, 1500) + '\n…'
        : contenu;
      zone.readOnly = gros;
      analyser();
    };
    fr.readAsText(f, 'utf-8');
  }
  fichier.addEventListener('change', function () { chargerFichier(fichier.files[0]); });
  ['dragenter', 'dragover'].forEach(function (ev) {
    zoneDepot.addEventListener(ev, function (e) { e.preventDefault(); zoneDepot.classList.add('survol'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    zoneDepot.addEventListener(ev, function (e) { e.preventDefault(); zoneDepot.classList.remove('survol'); });
  });
  zoneDepot.addEventListener('drop', function (e) { chargerFichier(e.dataTransfer.files[0]); });

  /**
   * Découpe le contenu en lots envoyables.
   *
   * Un fichier de prospects réaliste pèse plusieurs mégaoctets — 8 741 fiches
   * font 5 Mo — là où un proxy accepte couramment 1 ou 2 Mo par requête.
   * Plutôt que de courir après la configuration de chaque serveur, on envoie
   * par tranches : la taille du fichier cesse d'être une limite, chaque requête
   * reste rapide, et l'on peut afficher une progression.
   */
  function decouperEnLots(texte, format, enTete) {
    var LOT_FICHES = 1000;
    var LOT_OCTETS = 700 * 1024;

    if (format === 'json') {
      var tableau = JSON.parse(texte.replace(/^﻿/, ''));
      if (!Array.isArray(tableau)) tableau = tableau.prospects || [tableau];
      var lots = [];
      for (var i = 0; i < tableau.length; i += LOT_FICHES) {
        lots.push({ prospects: tableau.slice(i, i + LOT_FICHES) });
      }
      return lots;
    }

    // Formats en lignes. La ligne d'intitulés, si elle existe, est rejouée en
    // tête de chaque lot : sans elle, les lots suivants seraient relus en
    // colonnes positionnelles et toutes les valeurs se décaleraient.
    var lignes = texte.replace(/^﻿/, '').split(/\r?\n/);
    var entete = enTete ? lignes.shift() : null;
    var lotsTexte = [];
    var courant = [];
    var taille = 0;
    lignes.forEach(function (l) {
      courant.push(l);
      taille += l.length + 1;
      if (courant.length >= LOT_FICHES || taille >= LOT_OCTETS) {
        lotsTexte.push({ texte: (entete ? entete + '\n' : '') + courant.join('\n') });
        courant = []; taille = 0;
      }
    });
    if (courant.join('').trim()) {
      lotsTexte.push({ texte: (entete ? entete + '\n' : '') + courant.join('\n') });
    }
    return lotsTexte;
  }

  btnImporter.addEventListener('click', async function () {
    btnImporter.disabled = true;
    var total = { crees: 0, doublons: 0, rejetes: 0, avertis: 0 };
    try {
      var lots = decouperEnLots(contenuActuel(), analyse.format, analyse.enTete);
      for (var i = 0; i < lots.length; i++) {
        btnImporter.textContent = lots.length > 1
          ? 'Import… lot ' + (i + 1) + '/' + lots.length
          : 'Import…';
        var r = await api('/prospects', { method: 'POST', body: lots[i] });
        total.crees += r.crees || 0;
        total.doublons += r.doublons || 0;
        total.rejetes += r.rejetes || 0;
        total.avertis += r.avertis || 0;
      }
      dlg.close();
      toast(total.crees + ' créé(s), ' + total.doublons + ' doublon(s) ignoré(s)' +
        (total.rejetes ? ', ' + total.rejetes + ' rejeté(s)' : ''));
      if (apres) apres();
    } catch (e) {
      btnImporter.disabled = false;
      btnImporter.textContent = 'Importer';
      // Un échec au milieu d'un envoi par lots n'annule pas les lots déjà
      // passés : le dire évite un second import qui ferait des doublons.
      toast(total.crees
        ? total.crees + ' fiche(s) déjà importée(s), puis échec : ' + e.message
        : e.message, true);
    }
  });

  var dlg = h('dialog', { class: 'large' }, [h('div', { class: 'in' }, [
    h('h2', { text: 'Importer des prospects' }),
    h('p', { class: 'muted', text: 'JSON, CSV, export tableur ou simple liste d’adresses : le format est reconnu tout seul, et les noms de colonnes aussi. Les doublons (même site ou même e-mail) sont ignorés.' }),
    zoneDepot,
    zone,
    fichier,
    apercu,
    h('div', { class: 'ligne', style: 'margin-top:14px;justify-content:flex-end' }, [
      h('button', { text: 'Annuler', onclick: function () { dlg.close(); } }),
      btnImporter
    ])
  ])]);
  document.body.appendChild(dlg); dlg.showModal();
  dlg.addEventListener('close', function () { dlg.remove(); });
}

var NIVEAUX_SIM = ['aucun simulateur', 'formulaire de devis seulement',
  'calculateur d’économies', 'simulateur cartographique', 'simulateur avancé'];
var NIVEAUX_COURT = ['aucun', 'formulaire', 'calculateur', 'cartographique', 'avancé'];

/** Colonne de liste : lisible d'un coup d'œil, détail au survol. */
function celluleSimulateur(p) {
  if (!p.inspecte_le) return h('span', { class: 'muted', text: '—' });
  var n = p.simulateur_niveau;
  if (n === null || n === undefined) return h('span', { class: 'muted', text: 'visité' });
  return h('span', {
    class: 'pill ' + (p.cible === 0 ? 'suspendu' : (n === 0 ? 'actif' : 'essai')),
    title: NIVEAUX_SIM[n] + (p.cible === 0 ? ' — écarté du démarchage' : ''),
    text: NIVEAUX_COURT[n]
  });
}

/**
 * Ce qu'un agent d'inspection a relevé sur le site du prospect.
 *
 * Distinguer « jamais inspecté » de « inspecté, rien trouvé » n'est pas un
 * détail d'affichage : le premier est du travail à faire, le second est un
 * argument de vente. D'où le test sur `inspecte_le` plutôt que sur le niveau.
 */
function blocInspection(p) {
  if (!p.inspecte_le) {
    return h('p', { class: 'mini muted', text: 'Site jamais inspecté — lancez « hermes inspection ».' });
  }
  var d = p.enrichissement || {};
  var niveau = p.simulateur_niveau;
  var lignes = [];

  lignes.push(h('p', {}, [
    h('b', { text: niveau === null || niveau === undefined ? 'Site visité' : NIVEAUX_SIM[niveau] }),
    h('span', { class: 'muted', text: ' · relevé le ' + date(p.inspecte_le) }),
    p.simulateur_url ? h('a', { href: p.simulateur_url, target: '_blank', text: ' voir', style: 'margin-left:8px' }) : null
  ].filter(Boolean)));

  if ((d.editeurs || []).length) {
    lignes.push(h('p', { class: 'mini', text: 'Outil tiers : ' + d.editeurs.join(', ') }));
  }
  if ((d.capacites || []).length) {
    lignes.push(h('p', { class: 'mini', text: 'Sait faire : ' + d.capacites.join(', ') }));
  }
  if ((d.donnees || []).length) {
    lignes.push(h('p', { class: 'mini', text: 'Demande au visiteur : ' + d.donnees.join(', ') }));
  }
  if (p.enseigne || p.couleur) {
    lignes.push(h('p', { class: 'mini' }, [
      h('span', { text: 'Identité : ' + (p.enseigne || '—') + '  ' }),
      p.couleur ? pastille(p.couleur, 'couleur relevée sur leur site') : null,
      p.couleur_apercu ? h('span', { text: ' → ' }) : null,
      p.couleur_apercu ? pastille(p.couleur_apercu, 'couleur de l’aperçu — volontairement décalée') : null
    ].filter(Boolean)));
  }
  if (p.cible === 0) {
    lignes.push(h('p', { class: 'mini', style: 'color:#b45309' },
      [h('b', { text: '⚠ Écarté du démarchage' }),
        h('span', { text: d.raison ? ' — ' + d.raison : ' — déjà bien équipé' })]));
  }
  return h('div', { class: 'carte', style: 'margin:10px 0' },
    [h('h3', { text: 'Ce que l’agent a vu sur leur site' })].concat(lignes));
}

function pastille(hex, titre) {
  return h('span', {
    title: titre || hex,
    style: 'display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:-1px;' +
      'border:1px solid rgba(0,0,0,.25);background:' + hex
  });
}

async function ouvrirProspect(id) {
  var p = (await api('/prospects/' + id)).prospect;
  var note = h('textarea', { rows: 2, placeholder: 'Appel du jour, objection, prochaine étape…' });
  var dlg = h('dialog', {}, [h('div', { class: 'in' }, [
    h('h2', { text: p.entreprise }),
    h('p', { class: 'muted', text: [p.contact, p.telephone, p.email, p.ville].filter(Boolean).join(' · ') }),
    p.site ? h('p', {}, [h('a', { href: 'https://' + p.site, target: '_blank', text: p.site })]) : null,
    blocInspection(p),
    h('div', { class: 'ligne' }, [
      h('button', { text: '✎ Modifier', onclick: function () { dlg.close(); dialogueProspect(p, charger); } }),
      h('button', {
        class: 'p', text: '→ Créer son widget d’essai',
        onclick: async function () {
          try {
            var r = await api('/clients', { method: 'POST', body: { nom: p.entreprise, prospectId: p.id } });
            await api('/prospects/' + p.id, { method: 'PATCH', body: { statut: 'essai' } });
            dlg.close(); toast('Widget d’essai créé'); etat.vue = 'clients'; ouvrirClient(r.client.cle);
          } catch (e) { toast(e.message, true); }
        }
      })
    ]),
    h('h3', { text: 'Journal' }),
    h('div', {}, (p.activites || []).slice(0, 30).map(function (a) {
      return h('p', { class: 'mini', text: date(a.cree_le) + ' · ' + a.type + ' · ' + a.corps + (a.auteur ? ' (' + a.auteur + ')' : '') });
    })),
    note,
    h('div', { class: 'ligne', style: 'margin-top:10px;justify-content:flex-end' }, [
      h('button', {
        text: '+ Ajouter au journal',
        onclick: async function () {
          if (!note.value.trim()) return;
          await api('/prospects/' + p.id + '/activite', { method: 'POST', body: { type: 'note', corps: note.value } });
          dlg.close(); toast('Noté'); ouvrirProspect(id);
        }
      }),
      h('button', { text: 'Fermer', onclick: function () { dlg.close(); } })
    ])
  ])]);
  document.body.appendChild(dlg); dlg.showModal();
  dlg.addEventListener('close', function () { dlg.remove(); });
}

/* ---------- leads, facturation, agents ---------- */

async function vueLeads(m) {
  var d = await api('/tableau-de-bord');
  m.innerHTML = '';
  m.appendChild(h('div', { class: 'carte' }, [
    h('h2', { text: 'Leads reçus par les widgets' }),
    h('p', { class: 'muted', text: 'Ces leads appartiennent à vos clients : ils leur sont transmis. ' +
      'Cette vue sert au support et à la preuve de valeur en fin d’essai.' }),
    d.derniersLeads.length ? tableau(['Client', 'Reçu le', 'Nom', 'Téléphone', 'Type'],
      d.derniersLeads.map(function (l) { return [l.nom_client, date(l.cree_le), l.nom, l.telephone, l.type]; }))
      : h('p', { class: 'vide', text: 'Aucun lead pour l’instant.' })
  ]));
}

async function vueFacturation(m) {
  var d = await api('/commandes');
  m.innerHTML = '';
  m.appendChild(h('div', { class: 'carte' }, [
    h('h2', { text: 'Commandes' }),
    h('p', { class: 'muted', text: 'Mode d’encaissement : ' + d.mode +
      (d.mode === 'bon_de_commande' ? ' — définissez STRIPE_SECRET_KEY pour encaisser en ligne.' : '') }),
    d.commandes.length ? tableau(['Client', 'Formule', 'Montant HT', 'Statut', 'Créée le', ''],
      d.commandes.map(function (c) {
        return [c.nom, c.formule, eur(c.montant_ht),
          h('span', { class: 'pill ' + (c.statut === 'paye' ? 'actif' : 'essai'), text: c.statut }),
          date(c.cree_le),
          c.statut === 'paye' ? '' : h('button', {
            text: 'Marquer payée → activer 12 mois',
            onclick: async function () {
              await api('/commandes/' + c.id + '/payee', { method: 'POST' });
              toast('Client activé'); charger();
            }
          })];
      })) : h('p', { class: 'vide', text: 'Aucune commande.' })
  ]));
  m.appendChild(h('div', { class: 'carte' }, [
    h('h2', { text: 'Grille tarifaire' }),
    h('div', { class: 'grille g3' }, etat.moi.formules.formules.map(function (f) {
      return h('div', { class: 'kpi' }, [
        h('b', { text: f.prixHTAn + ' €' }), h('span', { text: f.nom + ' — ' + f.accroche }),
        h('ul', { class: 'mini' }, f.inclus.map(function (i) { return h('li', { text: i }); }))
      ]);
    }))
  ]));
}

async function vueAgents(m) {
  var d = await api('/jetons');
  var libelle = h('input', { placeholder: 'Hermès — prospection Normandie' });
  var profil = h('select', {}, d.profils.map(function (p) { return h('option', { value: p, text: p }); }));
  m.innerHTML = '';
  m.appendChild(h('div', { class: 'carte' }, [
    h('h2', { text: 'Jetons des agents' }),
    h('p', { class: 'muted', text: 'Un jeton par profil d’agent. Chaque profil ne reçoit que les portées ' +
      'dont il a besoin : un agent de prospection ne peut pas activer un abonnement.' }),
    d.jetons.length ? tableau(['Libellé', 'Profil', 'Portées', 'Préfixe', 'Dernier appel', ''],
      d.jetons.map(function (j) {
        return [j.libelle, j.profil, h('span', { class: 'mini', text: j.portees.join(', ') }),
          h('code', { text: j.prefixe + '…' }), date(j.derniere_utilisation),
          j.revoque ? h('span', { class: 'pill suspendu', text: 'révoqué' }) : h('button', {
            class: 'd', text: 'Révoquer',
            onclick: async function () { await api('/jetons/' + j.id, { method: 'DELETE' }); charger(); }
          })];
      })) : h('p', { class: 'mini', text: 'Aucun jeton.' }),
    h('div', { class: 'grille g3', style: 'margin-top:12px' }, [
      h('div', {}, [h('label', { text: 'Libellé' }), libelle]),
      h('div', {}, [h('label', { text: 'Profil' }), profil]),
      h('div', { style: 'display:flex;align-items:flex-end' }, [
        h('button', {
          class: 'p', text: 'Créer le jeton',
          onclick: async function () {
            try {
              var r = await api('/jetons', { method: 'POST', body: { libelle: libelle.value, profil: profil.value } });
              var dlg = h('dialog', {}, [h('div', { class: 'in' }, [
                h('h2', { text: 'Jeton créé' }),
                h('p', { class: 'muted', text: r.avertissement }),
                h('pre', { text: r.jeton }),
                h('p', { class: 'mini', text: 'Portées : ' + r.portees.join(', ') }),
                h('div', { class: 'ligne', style: 'justify-content:flex-end' }, [
                  h('button', { text: 'Copier', onclick: function (ev) { copier(r.jeton, ev.target); } }),
                  h('button', { class: 'p', text: 'J’ai noté', onclick: function () { dlg.close(); charger(); } })
                ])
              ])]);
              document.body.appendChild(dlg); dlg.showModal();
            } catch (e) { toast(e.message, true); }
          }
        })
      ])
    ])
  ]));
  m.appendChild(h('div', { class: 'carte' }, [
    h('h2', { text: 'Utilisation par un agent' }),
    h('pre', { text: 'curl -H "Authorization: Bearer hrm_vent_…" \\\n     ' + location.origin + '/api/v1/tableau-de-bord' }),
    h('p', { class: 'mini', text: 'Toute la console passe par cette même API : ce que fait un humain ici, ' +
      'un agent peut le faire par API, avec les portées de son profil.' })
  ]));
}

/* ---------- démarrage ---------- */

async function demarrer() {
  try {
    etat.moi = await api('/moi');
    charger();
  } catch (e) {
    vueConnexion();
  }
}
demarrer();
