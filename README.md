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

**Chiffres à jour du marché français (août 2026).** Le simulateur applique le cadre en vigueur, pas celui d'avant la réforme :

| | Avant | Appliqué par le simulateur |
|---|---|---|
| Prime à l'autoconsommation | 80–180 €/kWc | **0 €** — supprimée par l'arrêté publié au JO le 4 juin 2026 pour toute demande de raccordement déposée à partir de cette date |
| Rachat du surplus | 4 c€/kWh | **1,1 c€/kWh HT**, tarif unique jusqu'à 100 kWc, contrat 20 ans indexé 2 %/an |
| Vente totale ≤ 9 kWc | possible | **interdite** : le résidentiel est en autoconsommation + vente du surplus |
| TVA | 10 % / 20 % | **5,5 %** si les 5 conditions cumulatives sont réunies, **20 %** sinon |
| Prix du kWh réseau | — | 0,2001 €/kWh (tarif réglementé option base au 1er août 2026) |

Conséquence assumée dans tout le parcours : **la rentabilité ne vient plus de la revente mais de l'autoconsommation.** Les résultats décomposent donc explicitement « ce que vous ne payez plus à votre fournisseur » et « ce que vous vendez au réseau » — le second poste ne pesant plus que quelques dizaines d'euros par an.

### Éligibilité à la TVA à 5,5 % — vérifiée et expliquée en direct

Les cinq conditions sont **cumulatives** (une seule manquante = 20 %) et le simulateur les affiche cochées ou non : puissance ≤ 9 kWc · local à usage d'habitation · pose par une entreprise RGE · modules à bilan carbone conforme · **gestionnaire d'énergie (EMS) pilotant au moins 2 usages**. Quand seul l'EMS manque, un bouton l'ajoute d'un clic en affichant le calcul : *« le pilotage coûte 728 € TTC et fait baisser la TVA de 1 293 € : l'opération vous rapporte 565 € »*. C'est l'argument de vente le plus solide qui reste sur le marché résidentiel — et il est chiffré, pas déclamé.

### Dimensionnement conseillé plutôt que « toit rempli »

Couvrir tout le toit n'est plus le bon réflexe : le surplus ne vaut presque plus rien et dépasser 9 kWc fait basculer la TVA à 20 %. Le simulateur classe donc les emplacements du plus au moins productif (ombrage compris), puis retient **le nombre de panneaux qui maximise le gain net sur 25 ans**. Sur une toiture de 12 × 8 m à Lyon avec 4 500 kWh de consommation : 21 panneaux retenus sur 36 possibles, 8,93 kWc — juste sous le seuil de TVA — soit un retour à 14,6 ans au lieu de 19,9 ans si l'on remplit tout. Le visiteur garde la main (« 🏠 Remplir tout le toit », ou clic sur un emplacement libre pour l'ajouter).

### ⚖ Conformité du démarchage téléphonique (depuis le 11 août 2026)

La loi du 30 juin 2025 a réécrit l'article L. 223-1 du code de la consommation : **Bloctel a disparu et le silence vaut refus**. Aucun consommateur ne peut être appelé sans consentement préalable libre, éclairé, spécifique et révocable — valable 1 an, avec **preuve conservée 3 ans**.

Tous les formulaires du widget (rappel, visite drone, demande de devis) comportent donc une case **non pré-cochée** qui bloque l'envoi tant qu'elle n'est pas validée, et transmettent au CRM une preuve exploitable :

```json
"consentement": {
  "donne": true,
  "finalite": "Être recontacté par téléphone au sujet d’un projet photovoltaïque",
  "texte": "J’accepte d’être contacté par téléphone par RDF-SOLAR …",
  "version": "2026-08-11-v1",
  "horodatage": "2026-08-13T13:32:36.305Z",
  "fuseau": "Europe/Paris",
  "dureeValiditeMois": 12,
  "page": "https://www.rdf-solar.fr/simulateur",
  "userAgent": "…",
  "baseLegale": "Article L. 223-1 du code de la consommation (version en vigueur au 11 août 2026)"
}
```

Chaque demande porte aussi une **référence** (`SIM-20260813-1332-C9P4`) affichée au visiteur, et le **détail chiffré de la simulation** (kWc, production, taux de TVA applicable, conditions manquantes, coût HT/TTC) : le conseiller rappelle en connaissant le dossier. La demande de devis passe par le même formulaire que les autres — sans nom ni téléphone, un lead n'est pas exploitable.

### Décrocher à tout moment

À chaque instant du parcours, le visiteur pressé peut décrocher via la **barre de contact permanente** (téléphone cliquable aussi dans l'en-tête) :

- **📞 Appel direct** (`tel:`) — numéro configuré dans `offers.json` → `brand.phone` ;
- **💬 WhatsApp** — le message part pré-rempli avec le contexte de la simulation (adresse, nombre de panneaux, kWc, production, offre choisie) ;
- **⏱ Être rappelé** — formulaire nom + téléphone, promesse « rappel sous 30 min » pendant les horaires ouvrés (détectés côté navigateur, configurables dans `brand.horaires`), « dès l'ouverture » sinon — l'indicateur vert/gris de disponibilité est affiché en permanence ;
- **🚁 Visite technique drone** — réservation d'une visite avec prise de vue aérienne : lien de réservation externe (`brand.droneBookingUrl`, ex. Calendly) ou formulaire intégré avec choix de créneau.

Chaque lead part vers votre CRM (`brand.devisEndpoint`, POST JSON `{type, reference, nom, telephone, email, creneau, contexte, simulation, consentement}`) avec **le résumé complet de la simulation en cours**. Sans endpoint configuré — ou si l'envoi échoue — repli automatique en e-mail pré-rempli, preuve de consentement comprise : un lead ne se perd jamais.

## 3. Le parcours utilisateur

1. **Adresse** — autocomplétion, puis zoom automatique sur la vue aérienne. **L'adresse n'a pas besoin d'être parfaite** : dès que la carte est zoomée sur le quartier, les emprises de tous les bâtiments (BD TOPO IGN) apparaissent, **en surbrillance au survol** — un clic/toucher sur sa maison la sélectionne comme toiture (même si le point géocodé est tombé à côté), relance la détection Google Solar au centre du bâtiment choisi, et d'autres bâtiments peuvent être cumulés de la même façon.
2. **Toiture, pan par pan** — le visiteur dessine un pan en quelques clics, puis **en ajoute autant qu'il veut** (autres pans, annexe, garage, second bâtiment) : chaque pan a **sa propre inclinaison et sa propre orientation**, et tout se cumule dans le calcul. Trois façons de créer un pan : dessin à la main, **« Contour du bâtiment »** (emprise exacte via la BD TOPO de l'IGN, gratuit), ou détection Google Solar (option). Panneaux placés automatiquement (dimensions réelles, marge, portrait/paysage, azimut auto-aligné sur la gouttière), zones à éviter (cheminée, velux) et retrait de panneaux au clic. Liste des pans éditable : sélection, réglage, suppression. Outil **🌳 Arbre** : le visiteur plante les arbres voisins (5/8/12 m, retrait au clic) pour **visualiser leur ombre réelle sur les panneaux dans la vue 3D**, heure par heure et saison par saison — les ombrages Google (`dataLayers`) étant des rasters à traiter côté serveur, cette approche interactive donne le même service sans coût.
3. **Offre & équipements** — cartes d'offres RDF-SOLAR + personnalisation panneau / onduleur / **pilotage (EMS)** / batterie ; le toit et le dimensionnement conseillé se mettent à jour en direct. Saisie de la consommation annuelle et de la nature du local (condition de TVA).
4. **Résultats** — production annuelle et mensuelle, taux d'autoconsommation, décomposition des économies (autoconsommé / surplus), **éligibilité TVA 5,5 % détaillée condition par condition**, coût HT / TVA / TTC, retour sur investissement calculé en cumulé sur 25 ans, gain net à l'horizon, CO₂ évité — puis **demande de devis** avec consentement horodaté (e-mail pré-rempli ou envoi vers votre CRM).

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
| `pvgisProxyUrl` | `null` | Réservé : le proxy `server/pvgis-proxy.js` est fourni et fonctionnel, mais **le widget ne l'interroge pas encore** — la production reste calculée par le moteur embarqué |
| `googleSolarApiKey` | `null` | Clé API Google Solar → détection automatique des pans de toit (voir ci-dessous) |

### Option : détection automatique du toit (API Google Solar)

Sans rien configurer, le visiteur dessine son toit à la main (gratuit, fonctionne partout). Si vous fournissez une clé [Google Solar API](https://developers.google.com/maps/documentation/solar) (`googleSolarApiKey`), le simulateur interroge `buildingInsights:findClosest` après la saisie de l'adresse et liste les **pans détectés**, enrichis des données Google : surface, orientation, pente, **ensoleillement médian (h/an)** et **potentiel de panneaux** du pan. Chaque pan s'ajoute d'un clic et se **cumule** avec les autres (détectés ou dessinés). À savoir : API **payante** (facturation Google Cloud), couverture incomplète en France ; hors couverture, en cas d'erreur ou au-delà de 8 s sans réponse, le simulateur retombe silencieusement sur le dessin manuel.

**Harmonisation automatique des toits à deux versants.** Les boîtes englobantes de Google présentent de légers décalages (faîtages disjoints, largeurs différentes, orientations pas exactement opposées) qui donnent des bâtiments « biscornus » en 3D. Quand deux pans détectés forment un toit à deux versants (orientations quasi opposées, faîtages à moins de 3 m, recouvrement latéral ≥ 50 %), le simulateur les harmonise automatiquement : axe de faîtage commun, arête soudée, largeurs unifiées, orientations rendues exactement opposées et **pentes accordées pour une même hauteur de faîtage** (chaque versant garde sa profondeur réelle). Les pans harmonisés portent le badge ⚖, et la 3D affiche un toit propre.

**Ombres du voisinage intégrées au calcul.** Google modélise le quartier en 3D (bâtiments voisins, arbres, relief) : pour chaque pan ajouté depuis la détection, la production est calculée en **mode précision** — la production annuelle de chaque panneau du calepinage optimal de Google (ombres incluses) est rattachée au panneau le plus proche de notre calepinage, mise à l'échelle de la puissance réelle du panneau choisi et convertie DC→AC selon l'onduleur. Les panneaux notablement ombragés sont **colorés sur la carte** (orange < 85 %, rouge < 65 % du meilleur panneau du pan, avec infobulle) pour être retirés d'un clic. Repli si les données par panneau manquent : **facteur d'ombrage** dérivé de l'ensoleillement médian du pan rapporté au maximum du bâtiment (borné à −45 %). Les pans dessinés à la main restent sur le modèle régional, et le niveau d'intégration de l'ombrage est affiché dans les résultats, le récapitulatif et l'étude imprimable.

Limite à connaître : `buildingInsights` ne fournit **pas les contours exacts** des pans — uniquement des boîtes englobantes (les contours fins n'existent que sous forme d'images raster dans `dataLayers`, inexploitables directement dans un navigateur). C'est pourquoi le bouton **« Contour du bâtiment »** s'appuie plutôt sur la **BD TOPO de l'IGN** (WFS `data.geopf.fr`, gratuit, sans clé) : emprise exacte du bâtiment en un clic, que le visiteur peut ensuite affiner ou découper en pans.

**Gestion sécurisée de la clé** — la clé ne doit jamais être commitée :

1. `cp config/local.example.js config/local.js` puis renseignez-y la clé — `config/local.js` est dans `.gitignore`, il reste sur votre machine/serveur.
2. `index.html` charge ce fichier s'il existe ; `node build-demo.js --local` produit une démo personnelle avec clé (`dist/rdf-solar-demo-personnelle.html`, ignorée par Git elle aussi).
3. Une clé utilisée dans un navigateur est par nature visible des visiteurs : ce qui la protège, ce sont les **restrictions côté Google Cloud Console** → *Credentials* → votre clé : « Application restrictions » = HTTP referrers limités à votre domaine (`https://www.rdf-solar.fr/*`), et « API restrictions » = Solar API uniquement.
4. Si la clé renvoie `403 API_KEY_SERVICE_BLOCKED` : activez « Solar API » dans *APIs & Services → Library* (facturation active requise) et vérifiez que les restrictions d'API de la clé incluent bien Solar API.
5. Une clé qui a circulé en clair (mail, chat…) doit être considérée comme exposée : régénérez-la dans la console après avoir posé les restrictions.

## 4. Personnaliser vos offres — `config/offers.json`

Tout le commercial est dans ce fichier, modifiable sans toucher au code. **Les prix du catalogue sont des prix HT** (`tarifs.prixHT`) : la TVA est ajoutée par le simulateur au taux réellement applicable.

- **`brand`** : nom, e-mail de contact, `devisEndpoint` (URL POST vers votre CRM), `rge` (indispensable au taux réduit), `politiqueConfidentialiteUrl` et `consentementVersion` (versionne le texte de consentement — à incrémenter à chaque modification du texte, la preuve conservée y fait référence).
- **`tarifs`** : prix du kWh réseau, tarif de rachat du surplus et son indexation, barème de TVA, hypothèses de projection (inflation de l'électricité, dégradation des modules, remplacement d'onduleur, horizon), `bareme` et `dateMaj` — *repris tels quels dans l'étude imprimable pour la rendre opposable*. `primeAutoconsommation` est un **tableau vide** depuis le 4 juin 2026 ; il suffirait d'y remettre des tranches si un dispositif était rétabli.
- **`panneaux`** : puissance, **dimensions réelles** (calepinage) et `basCarbone` (condition de TVA à 5,5 %).
- **`onduleurs`** : le `performanceRatio` de chaque type alimente le calcul de production.
- **`pilotage`** : les gestionnaires d'énergie — `ems: true` valide la condition de TVA, `gainAutoconsommation` chiffre le gain de taux d'autoconsommation apporté par le pilotage.
- **`batteries`** : capacité (améliore le taux d'autoconsommation simulé) et prix.
- **`offres`** : composition (panneau + onduleur + pilotage + batterie), prix HT (`forfaitBase` + `prixParPanneau`), prestations incluses.

> ⚠ Les tarifs et barèmes bougent à chaque arrêté. Mettez à jour `tarifs` **et** `tarifs.dateMaj` : la date s'affiche dans l'étude remise au client.

## 5. Précision des estimations

Le moteur embarqué (`src/rdf-solar-engine.js`) utilise :

- une grille d'irradiation annuelle France/Belgique/Suisse/Luxembourg (interpolation par distance inverse, ordres de grandeur PVGIS) ;
- une table de transposition inclinaison × orientation (interpolation bilinéaire) ;
- le performance ratio de l'onduleur choisi ;
- une courbe empirique d'autoconsommation fonction du ratio production/consommation, bonifiée par la batterie **et par le pilotage (EMS)** ;
- une **projection année par année sur 25 ans** : dégradation des modules (0,4 %/an), inflation du prix du kWh réseau (3 %/an), indexation du tarif d'achat (2 %/an sur 20 ans), maintenance et remplacement d'onduleur si configurés. Le retour sur investissement affiché est celui du **cumul de trésorerie**, pas le ratio « coût / économies de l'année 1 » (qui reste disponible sous `simplePaybackYears`).

Résultat typique : ± 10 % par rapport à PVGIS pour une toiture sans ombrage proche.

⚠️ Les résultats restent **indicatifs et non contractuels** (le widget l'affiche) : ombrages proches, masques lointains, profils de consommation horaires et évolution des tarifs ne sont pas modélisés. La mention du barème appliqué et sa date figurent dans les résultats et dans l'étude imprimable.

**Limites connues du modèle, par ordre d'importance :**

1. Le taux d'autoconsommation vient d'une courbe empirique annuelle, pas d'une simulation horaire (8 760 h) avec profil de charge : c'est désormais le paramètre qui détermine la rentabilité, il mérite un modèle horaire.
2. Les arbres plantés par le visiteur servent à la visualisation 3D mais **ne sont pas déduits du calcul** (seules les ombres Google Solar le sont, quand la détection automatique est activée).
3. Le performance ratio est porté par le type d'onduleur, ce qui donne aux micro-onduleurs un avantage uniforme, alors qu'il ne se matérialise réellement qu'en présence d'ombrage.
4. La saisonnalité de la production suit un profil national fixe, identique quelle que soit l'orientation du pan.

## 6. Structure du projet

```
index.html                  Page de démonstration
src/rdf-solar-engine.js     Moteur : géométrie, calepinage, gisement solaire, finances (testé)
src/rdf-solar-sim.js        Widget : carte, dessin, étapes, offres, résultats, devis
src/rdf-solar-sim.css       Styles (préfixés .rdfsim, sans conflit avec le site hôte)
config/offers.json          Catalogue d'offres, tarifs, barèmes TVA et hypothèses financières
vendor/leaflet/             Leaflet 1.9.4 embarqué (aucun CDN requis)
server/pvgis-proxy.js       Proxy PVGIS (fourni, pas encore branché sur le widget)
tests/engine.test.js        60 tests du moteur : node tests/engine.test.js
```

## 7. Pistes d'évolution

- **Moteur horaire (8 760 h)** avec profils de charge (chauffage électrique, PAC, ECS, véhicule électrique) et simulation du pilotage : c'est ce qui rendrait le taux d'autoconsommation défendable devant un client.
- **Ombrage réellement calculé** à partir des arbres et bâtiments placés par le visiteur — la scène 3D et le soleil astronomique existent déjà, il manque le lancer de rayons et l'injection du facteur dans le calcul.
- **Alerte urbanisme** : périmètre Monument Historique / site patrimonial remarquable (avis ABF obligatoire, contraintes de teinte, +2 mois de délai), détectable via les données de la Géoplateforme.
- **Dossier administratif pré-rempli** : déclaration préalable (Cerfa 13703), demande de raccordement Enedis (ou ELD), attestation Consuel jaune (15-062).
- **Financement** : mensualité de crédit affecté comparée à l'économie mensuelle.
- Masques lointains via l'API horizon de PVGIS, derrière le proxy.

---

Sources consultées pour l'analyse concurrentielle : [Potentielsolaire](https://www.potentielsolaire.com/), [simulateur Hellio](https://particulier.hellio.com/guide-solaire/fonctionnement/rendement-panneau-solaire/simulation), [calepinage Potentielsolaire](https://www.potentielsolaire.com/calepinage-photovoltaique), [PVGIS — API non interactive](https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/getting-started-pvgis/api-non-interactive-service_en), [PVGIS 5.2](https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/pvgis-releases/pvgis-52_en).

Sources réglementaires des barèmes appliqués (à revérifier à chaque arrêté) : [arrêté tarifaire 2026 — tarif unique 1,1 c€/kWh](https://larevuetech.fr/arrete-tarifaire-photovoltaique-2026-tarif-unique-a-11-ce-kwh-et-nouvelles-regles/), [suppression de la prime à l'autoconsommation](https://www.les-energies-renouvelables.eu/article/actualites/energies/photovoltaique-prime-autoconsommation-supprimee-et-le-tarif-de-rachat-763/), [cadre S21 2026](https://pv-solaire-energie.com/arrete-s21-2026-nouveau-cadre-tarifaire-photovoltaique-pour-lautoconsommation-et-la-vente-du-surplus/), [conditions de la TVA à 5,5 %](https://www.sunethic.fr/tva-panneaux-solaires-5-5-en-2026/), [article L. 223-1 du code de la consommation au 11 août 2026](https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000006069565/LEGISCTA000032221441/2026-08-11).
