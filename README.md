# ☀ RDF-SOLAR — Simulateur d'installation photovoltaïque

Un widget intégrable qui permet à un particulier ou une entreprise, à partir de son **adresse**, de **visualiser sa future installation solaire sur la photo aérienne réelle de son toit**, de choisir ses équipements parmi les **offres RDF-SOLAR**, et d'obtenir une estimation de production, d'économies et de retour sur investissement — avant de demander un devis.

![Parcours](docs/screenshots/etape-toiture.png)

---

## 1. Analyse de l'existant (pourquoi cet outil est différent)

Les simulateurs du marché se rangent en trois familles :

| Famille | Exemples typiques | Limites |
|---|---|---|
| **Formulaires de devis** | La plupart des installateurs, Hellio | Aucune visualisation ; l'outil sert surtout à collecter un numéro de téléphone |
| **Vue satellite + estimation automatique** | Google Project Sunroof, Otovo, Potentielsolaire (API Google Solar + PVGIS) | Dépendance à l'API Google Solar (payante, couverture incomplète en France) ; pas de choix réel des composants ; peu interactif |
| **Logiciels pro de calepinage** | archelios, PVsyst, Solar Edge Designer | Réservés aux installateurs, trop complexes pour un visiteur de site web |

**Le créneau exploité ici** : la visualisation interactive « pro » (calepinage réaliste sur la vraie photo du toit) mais accessible à un visiteur en 2 minutes, et pilotée par **votre catalogue d'offres** — les dimensions et puissances réelles de vos panneaux déterminent ce qui est affiché sur le toit.

Choix techniques qui vous rendent autonome (0 € de coût de fonctionnement) :

- **Orthophotos IGN** (Géoplateforme) : résolution 20 cm sur toute la France, **gratuites et sans clé API** — meilleure définition que Google Maps dans la plupart des communes.
- **Base Adresse Nationale** pour l'autocomplétion d'adresse, via le service de géocodage de la Géoplateforme IGN (`data.geopf.fr/geocodage`) : gratuit, sans clé. (L'ancienne `api-adresse.data.gouv.fr` a été décommissionnée fin janvier 2026.) En cas d'indisponibilité, un mode « placer la carte moi-même » permet de continuer sans adresse.
- **Moteur d'estimation embarqué** (irradiation par région, facteurs d'inclinaison/orientation, autoconsommation) : PVGIS interdit les appels directs depuis un navigateur, le widget fonctionne donc sans serveur ; un **proxy PVGIS optionnel** (`server/`) est fourni pour affiner les chiffres.

## 2. Un simulateur orienté génération de leads

Le widget est conçu comme un tunnel de conversion, pas comme un gadget : à chaque instant du parcours, le visiteur pressé peut décrocher via la **barre de contact permanente** (téléphone cliquable aussi dans l'en-tête) :

- **📞 Appel direct** (`tel:`) — numéro configuré dans `offers.json` → `brand.phone` ;
- **💬 WhatsApp** — le message part pré-rempli avec le contexte de la simulation (adresse, nombre de panneaux, kWc, production, offre choisie) ;
- **⏱ Être rappelé** — formulaire nom + téléphone, promesse « rappel sous 30 min » pendant les horaires ouvrés (détectés côté navigateur, configurables dans `brand.horaires`), « dès l'ouverture » sinon — l'indicateur vert/gris de disponibilité est affiché en permanence ;
- **🚁 Visite technique drone** — réservation d'une visite avec prise de vue aérienne : lien de réservation externe (`brand.droneBookingUrl`, ex. Calendly) ou formulaire intégré avec choix de créneau.

Chaque lead part vers votre CRM (`brand.devisEndpoint`, POST JSON `{type, nom, telephone, creneau, contexte}`) avec **le résumé complet de la simulation en cours** — vos commerciaux rappellent en connaissant déjà le projet. Sans endpoint configuré, repli automatique en e-mail pré-rempli : un lead ne se perd jamais.

## 3. Le parcours utilisateur

1. **Adresse** — autocomplétion, puis zoom automatique sur la vue aérienne du toit.
2. **Toiture, pan par pan** — le visiteur dessine un pan en quelques clics, puis **en ajoute autant qu'il veut** (autres pans, annexe, garage, second bâtiment) : chaque pan a **sa propre inclinaison et sa propre orientation**, et tout se cumule dans le calcul. Trois façons de créer un pan : dessin à la main, **« Contour du bâtiment »** (emprise exacte via la BD TOPO de l'IGN, gratuit), ou détection Google Solar (option). Panneaux placés automatiquement (dimensions réelles, marge, portrait/paysage, azimut auto-aligné sur la gouttière), zones à éviter (cheminée, velux) et retrait de panneaux au clic. Liste des pans éditable : sélection, réglage, suppression. Outil **🌳 Arbre** : le visiteur plante les arbres voisins (5/8/12 m, retrait au clic) pour **visualiser leur ombre réelle sur les panneaux dans la vue 3D**, heure par heure et saison par saison — les ombrages Google (`dataLayers`) étant des rasters à traiter côté serveur, cette approche interactive donne le même service sans coût.
3. **Offre & équipements** — cartes d'offres RDF-SOLAR + personnalisation panneau / onduleur / batterie ; le toit se met à jour en direct. Saisie de la consommation annuelle.
4. **Résultats** — production annuelle et mensuelle, taux d'autoconsommation, économies, prime, coût indicatif, retour sur investissement, CO₂ évité — puis **demande de devis** (e-mail pré-rempli ou envoi vers votre CRM).

**Mobile d'abord** : sur téléphone, la mise en page passe en colonne (saisie d'adresse en tête, carte dessous, hauteur de carte adaptée à chaque étape), le parcours défile automatiquement vers la carte quand on dessine puis revient aux réglages quand un pan est validé, et le tracé se termine par un bouton **« ✓ Terminer »** (avec « ↩ Annuler ») plutôt qu'en re-touchant précisément le premier point. Textes d'aide adaptés au tactile (« Touchez… »), cibles tactiles ≥ 44 px, champs à 16 px (pas de zoom intempestif iOS), barre d'étapes défilable, barre de contact en grille 2×2 et modale de rappel en feuille de bas d'écran.

À tout moment après le dessin du toit : bouton **« 🧊 Vue 3D »** (Three.js) — le bâtiment est reconstruit en volume avec ses panneaux inclinés et ses obstacles, **la photo aérienne IGN est plaquée au sol de la scène** (le client reconnaît son jardin et sa rue), un **soleil positionné astronomiquement** (heure + saison au choix, animation de la journée) projette de **vraies ombres portées** : le client voit l'ombre de sa cheminée balayer les panneaux, la course du soleil en été comme au 21 décembre. Le bouton **« 📷 Photo »** télécharge une image de la scène, reprise dans le récapitulatif. La 3D est optionnelle : si Three.js n'est pas chargé sur la page, le bouton n'apparaît pas et le reste du simulateur fonctionne normalement.

Depuis les résultats : **« 🖨 Imprimer / PDF »** génère une étude personnalisée mise en page (installation, bilan annuel, tableau et graphique mensuels, photo 3D) que le prospect enregistre en PDF — idéale à joindre à la demande de devis.

Confort de dessin : clic droit = annuler le dernier point, Échap = quitter le mode dessin.

## 3. Intégrer le widget sur votre site

Copiez les dossiers `src/`, `vendor/` et `config/`, puis :

```html
<link rel="stylesheet" href="vendor/leaflet/leaflet.css">
<script src="vendor/leaflet/leaflet.js"></script>
<link rel="stylesheet" href="src/rdf-solar-sim.css">
<script src="src/rdf-solar-engine.js"></script>
<script src="src/rdf-solar-sim.js"></script>

<div id="rdf-solar-sim"></div>
<script>
  RDFSolarSim.mount('#rdf-solar-sim', { offersUrl: 'config/offers.json' });
</script>
```

`index.html` est une page de démonstration complète : `python3 -m http.server` à la racine puis http://localhost:8000.

### Options de `mount(selector, options)`

| Option | Défaut | Rôle |
|---|---|---|
| `offersUrl` | `null` | URL du catalogue JSON (sinon catalogue embarqué de secours) |
| `margin` | `0.30` | Marge de sécurité au bord du toit (m) |
| `gap` | `0.02` | Espacement entre panneaux (m) |
| `pvgisProxyUrl` | `null` | Endpoint proxy PVGIS pour affiner la production (voir `server/`) |
| `googleSolarApiKey` | `null` | Clé API Google Solar → détection automatique des pans de toit (voir ci-dessous) |

### Option : détection automatique du toit (API Google Solar)

Sans rien configurer, le visiteur dessine son toit à la main (gratuit, fonctionne partout). Si vous fournissez une clé [Google Solar API](https://developers.google.com/maps/documentation/solar) (`googleSolarApiKey`), le simulateur interroge `buildingInsights:findClosest` après la saisie de l'adresse et liste les **pans détectés**, enrichis des données Google : surface, orientation, pente, **ensoleillement médian (h/an)** et **potentiel de panneaux** du pan. Chaque pan s'ajoute d'un clic et se **cumule** avec les autres (détectés ou dessinés). À savoir : API **payante** (facturation Google Cloud), couverture incomplète en France ; hors couverture, en cas d'erreur ou au-delà de 8 s sans réponse, le simulateur retombe silencieusement sur le dessin manuel.

**Ombres du voisinage intégrées au calcul.** Google modélise le quartier en 3D (bâtiments voisins, arbres, relief) : pour chaque pan ajouté depuis la détection, la production est calculée en **mode précision** — la production annuelle de chaque panneau du calepinage optimal de Google (ombres incluses) est rattachée au panneau le plus proche de notre calepinage, mise à l'échelle de la puissance réelle du panneau choisi et convertie DC→AC selon l'onduleur. Les panneaux notablement ombragés sont **colorés sur la carte** (orange < 85 %, rouge < 65 % du meilleur panneau du pan, avec infobulle) pour être retirés d'un clic. Repli si les données par panneau manquent : **facteur d'ombrage** dérivé de l'ensoleillement médian du pan rapporté au maximum du bâtiment (borné à −45 %). Les pans dessinés à la main restent sur le modèle régional, et le niveau d'intégration de l'ombrage est affiché dans les résultats, le récapitulatif et l'étude imprimable.

Limite à connaître : `buildingInsights` ne fournit **pas les contours exacts** des pans — uniquement des boîtes englobantes (les contours fins n'existent que sous forme d'images raster dans `dataLayers`, inexploitables directement dans un navigateur). C'est pourquoi le bouton **« Contour du bâtiment »** s'appuie plutôt sur la **BD TOPO de l'IGN** (WFS `data.geopf.fr`, gratuit, sans clé) : emprise exacte du bâtiment en un clic, que le visiteur peut ensuite affiner ou découper en pans.

**Gestion sécurisée de la clé** — la clé ne doit jamais être commitée :

1. `cp config/local.example.js config/local.js` puis renseignez-y la clé — `config/local.js` est dans `.gitignore`, il reste sur votre machine/serveur.
2. `index.html` charge ce fichier s'il existe ; `node build-demo.js --local` produit une démo personnelle avec clé (`dist/rdf-solar-demo-personnelle.html`, ignorée par Git elle aussi).
3. Une clé utilisée dans un navigateur est par nature visible des visiteurs : ce qui la protège, ce sont les **restrictions côté Google Cloud Console** → *Credentials* → votre clé : « Application restrictions » = HTTP referrers limités à votre domaine (`https://www.rdf-solar.fr/*`), et « API restrictions » = Solar API uniquement.
4. Si la clé renvoie `403 API_KEY_SERVICE_BLOCKED` : activez « Solar API » dans *APIs & Services → Library* (facturation active requise) et vérifiez que les restrictions d'API de la clé incluent bien Solar API.
5. Une clé qui a circulé en clair (mail, chat…) doit être considérée comme exposée : régénérez-la dans la console après avoir posé les restrictions.

## 4. Personnaliser vos offres — `config/offers.json`

Tout le commercial est dans ce fichier, modifiable sans toucher au code :

- **`brand`** : nom, e-mail de contact des devis, `devisEndpoint` (URL POST vers votre CRM — si vide, le bouton devis ouvre un e-mail pré-rempli avec le récapitulatif complet de la simulation).
- **`tarifs`** : prix du kWh, tarif de rachat du surplus, barème de la prime à l'autoconsommation — *à mettre à jour chaque trimestre selon les arrêtés*.
- **`panneaux`** : puissance **et dimensions réelles** (utilisées pour le calepinage sur le toit).
- **`onduleurs`** : le `performanceRatio` de chaque type alimente le calcul de production.
- **`batteries`** : capacité (améliore le taux d'autoconsommation simulé) et prix.
- **`offres`** : composition (panneau + onduleur + batterie), prix (`forfaitBase` + `prixParPanneau`), prestations incluses.

## 5. Précision des estimations

Le moteur embarqué (`src/rdf-solar-engine.js`) utilise :

- une grille d'irradiation annuelle France/Belgique/Suisse/Luxembourg (interpolation par distance inverse, ordres de grandeur PVGIS) ;
- une table de transposition inclinaison × orientation (interpolation bilinéaire) ;
- le performance ratio de l'onduleur choisi ;
- une courbe empirique d'autoconsommation fonction du ratio production/consommation, bonifiée par la batterie.

Résultat typique : ± 10 % par rapport à PVGIS pour une toiture sans ombrage proche.
Pour affiner : lancez `node server/pvgis-proxy.js` derrière votre domaine et passez `pvgisProxyUrl` au widget — les chiffres PVGIS (Commission européenne) remplacent alors l'estimation locale.

⚠️ Les résultats restent **indicatifs et non contractuels** (le widget l'affiche) : ombrages proches, masques lointains et évolution des tarifs ne sont pas modélisés.

## 6. Structure du projet

```
index.html                  Page de démonstration
src/rdf-solar-engine.js     Moteur : géométrie, calepinage, gisement solaire, finances (testé)
src/rdf-solar-sim.js        Widget : carte, dessin, étapes, offres, résultats, devis
src/rdf-solar-sim.css       Styles (préfixés .rdfsim, sans conflit avec le site hôte)
config/offers.json          Catalogue d'offres et tarifs RDF-SOLAR
vendor/leaflet/             Leaflet 1.9.4 embarqué (aucun CDN requis)
server/pvgis-proxy.js       Proxy PVGIS optionnel (Node, sans dépendance)
tests/engine.test.js        28 tests du moteur : node tests/engine.test.js
```

## 7. Pistes d'évolution

- Détection automatique du contour de toit (API Google Solar en option payante, ou bâtiments BD TOPO de l'IGN).
- Multi-pans (plusieurs polygones avec inclinaisons/orientations différentes).
- Étude d'ombrage horaire (masques lointains via l'API horizon de PVGIS, derrière le proxy).
- Export PDF de la simulation jointe à la demande de devis.

---

Sources consultées pour l'analyse : [Potentielsolaire](https://www.potentielsolaire.com/), [simulateur Hellio](https://particulier.hellio.com/guide-solaire/fonctionnement/rendement-panneau-solaire/simulation), [calepinage Potentielsolaire](https://www.potentielsolaire.com/calepinage-photovoltaique), [PVGIS — API non interactive](https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/getting-started-pvgis/api-non-interactive-service_en), [PVGIS 5.2](https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/pvgis-releases/pvgis-52_en).
