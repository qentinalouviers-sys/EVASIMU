# ☀ SaaS — vendre et exploiter le simulateur

Plateforme multi-clients qui transforme le simulateur en produit vendable : chaque installateur reçoit **son** simulateur à sa marque, qu'on active ou coupe d'un bouton, avec un mini-CRM pour la prospection et une API conçue pour être pilotée par des agents.

```bash
node saas/server.js          # ou : npm run saas
# → http://localhost:8080/console
```

Au premier démarrage, un compte administrateur est créé et son mot de passe **affiché une seule fois**. Aucune dépendance à installer : Node ≥ 22.5 suffit (SQLite intégré), la base est un fichier dans `saas/data/`.

---

## Importer des prospects

L'import n'exige plus de format : il devine le vôtre.

| Ce que vous collez | Reconnu comme |
|---|---|
| `[{"nom":"…","emails":["…"]}]` | JSON (export Hermès inclus) |
| `{"prospects":[…]}` ou un objet seul | JSON |
| `{"nom":"A"}` puis `{"nom":"B"}` sur deux lignes | JSON par ligne |
| `Raison sociale;E-mail;Ville` + lignes | CSV (virgule ou point-virgule) |
| Un copier-coller depuis Excel | Tableur (tabulations) |
| `contact@abc-solaire.fr` par ligne | Liste d'adresses |

**Les noms de colonnes sont reconnus par synonymes** — accents, casse et séparateurs
indifférents. `nom`, `Raison sociale`, `RAISON_SOCIALE`, `nom_entreprise` et `company`
désignent tous l'entreprise ; `emails`, `Courriel` et `E-mail` la même chose. C'est ce qui
permet d'importer un export d'Hermès tel quel, alors qu'il nomme l'entreprise `nom`, les
contacts `emails[]` et le site `siteWeb`.

**Ce qui est réparé plutôt que rejeté :**

- téléphones en `+33`, `0033`, `(0)`, collés ou espacés → format français uniforme ;
- URL avec protocole, `www` ou chemin → domaine seul ;
- code postal → département ;
- SIRET (14 chiffres) préféré au SIREN (9) quand les deux sont fournis ;
- **nom d'entreprise absent → déduit du domaine** (`contact@solaire-du-vexin.fr` →
  « Solaire Du Vexin »), sauf sur un domaine générique type Gmail, où deviner serait faux ;
- e-mails et téléphones secondaires, effectif et colonnes inconnues → conservés en notes
  plutôt que perdus en silence.

**Rien n'est écrit avant que vous ne l'ayez vu.** Le dialogue affiche un aperçu des
premières lignes avec, pour chacune, ce qui a été compris et ce qui a été corrigé ou
rejeté. Une ligne fautive n'empêche jamais les autres de passer, et chaque rejet indique
son numéro de ligne et sa raison.

### Par l'API

```bash
# Aperçu — n'écrit rien
curl -X POST /api/v1/prospects -H 'Content-Type: application/json' \
  -d '{"apercu":true,"texte":"Raison sociale;E-mail\nToitures Sud;contact@ts.fr"}'

# Import réel — le rapport détaille chaque ligne
curl -X POST /api/v1/prospects -H 'Content-Type: application/json' \
  -d '{"texte":"contact@abc-solaire.fr\ninfo@energies-nouvelles.com"}'
```

Le champ `texte` accepte n'importe lequel des formats ci-dessus ; `prospects` accepte un
tableau JSON. Les doublons (même site ou même e-mail) sont ignorés, pas recréés.

## 1. Ce que ça fait

| Surface | Adresse | Pour qui |
|---|---|---|
| Console éditeur | `/console` | vous et vos agents |
| Script d'intégration | `/w/:cle.js` | le site du client |
| Page du widget | `/w/:cle` | contenu de l'iframe |
| Page de partage | `/s/:cle` | réseaux sociaux, QR code, bio |
| Page SEO locale | `/p/:slug` | référencement naturel du client |
| Abonnement | `/abonnement/:cle` | le client qui souscrit |
| API | `/api/v1/*` | opérateurs et agents Hermès |

## 2. Personnalisation

Chaque client a une configuration unique, fusionnée avec le catalogue de référence (`config/offers.json`) :

- **thème** — couleur principale, couleur d'accent, fond, arrondi, logo (URL ou fichier téléversé en `data:`) ;
- **marque** — nom affiché, accroche, téléphone, WhatsApp, e-mail, webhook CRM, mention RGE, politique de confidentialité ;
- **catalogue** — surcharge partielle : ses panneaux, ses onduleurs, ses prix, ses offres.

Trois garde-fous qui comptent :

1. **Ce qui n'est pas surchargé retombe sur la référence**, barèmes réglementaires compris. Quand un arrêté change, une seule mise à jour vaut pour tous les clients — personne ne reste figé sur un tarif périmé.
2. **Les couleurs sont dérivées, pas devinées.** Les déclinaisons foncées et claires sont calculées, et la couleur du texte sur l'accent est choisie par contraste WCAG : un accent jaune vif reçoit du texte foncé, un bleu profond du texte blanc.
3. **Tout ce qui vient d'un client est filtré.** Liste blanche de champs, URL de logo limitée à `https:` et `data:image`, webhook refusé en clair (`http:`), échappement HTML systématique, et neutralisation de `<` dans le JSON injecté — un nom de marque contenant `</script>` ne peut pas s'exécuter.

## 3. Diffusion du widget

La console produit quatre extraits prêts à coller :

| Extrait | Usage |
|---|---|
| `<div>` + `<script>` | site web — l'iframe s'ajuste seule à la hauteur du contenu |
| `<iframe>` | Wix, Squarespace et CMS qui refusent les scripts |
| Lien direct `/s/:cle` | bio Instagram, bouton Facebook, fiche Google Business, signature, QR code sur un flyer ou une camionnette |
| WordPress | bloc « HTML personnalisé » |

Le script tolère les deux placements courants (un `<div>` dédié ou le voisinage direct du script), refuse de monter deux fois, et **ne casse rien quand le widget est coupé** : il ne monte simplement pas.

L'iframe reçoit `frame-ancestors` limité aux domaines déclarés du client : le widget d'un client ne peut pas être embarqué par n'importe qui.

## 4. Référencement local

Une page par ville d'intervention (`/p/nom-du-client-ville`), avec titre et description propres à la ville, `LocalBusiness`, `FAQPage` et `BreadcrumbList` en JSON-LD, Open Graph, maillage entre les villes du client, `sitemap.xml` et `robots.txt` au niveau plateforme.

Une page de client coupé **disparaît du sitemap et cesse d'être servie** : on n'indexe pas ce qu'on ne vend plus.

## 5. Cycle de vie et interrupteur

L'état n'est jamais lu tel quel en base : il est **recalculé à partir des dates** à chaque requête. Un essai terminé coupe le widget sans qu'aucune tâche planifiée n'ait à tourner, et une suspension prime toujours sur un abonnement en cours.

| Action | Effet |
|---|---|
| ⏸ Couper | widget hors ligne immédiatement, dates conservées |
| ▶ Rétablir | rend l'état auquel les dates donnent droit |
| ⏳ Essai | 7, 14 ou 30 jours |
| ✓ Activer 12 mois | prolonge depuis la fin en cours si elle est future |

### Pourquoi 30 jours d'essai par défaut

La valeur du widget se mesure en leads, et le nombre de leads dépend du trafic du site de l'installateur. Un site de TPE reçoit souvent 200 à 800 visites par mois : en 7 jours, cela peut faire **zéro lead**, donc zéro preuve. En 30 jours, il voit ses premiers contacts arriver et peut calculer son retour lui-même — c'est exactement l'argument de la relance de fin d'essai, chiffres d'usage à l'appui.

Le coût d'un essai long est pour nous quasi nul (fichiers statiques et une API légère), et un abonnement annuel prépayé se décide mieux après avoir vu le produit travailler. **7 jours reste disponible** comme levier de conclusion : quand un prospect est déjà convaincu, un essai court crée l'urgence utile.

## 6. Tarifs

| Formule | Prix HT/an | Pour |
|---|---|---|
| Essentiel | **590 €** | le simulateur à sa marque sur son site |
| Pro | **990 €** | + pages SEO locales, suivi des leads, webhook |
| Réseau | **2 490 €** | plusieurs agences, marque blanche, API |

Le positionnement se lit entre deux repères du marché : un ERP métier français comme XT-ERP démarre à 159 €/mois (≈ 1 900 €/an) et fait beaucoup plus ; un widget générique type Elfsight coûte 5 à 25 $/mois et ne fait rien de spécifique. Notre outil ne fait qu'une chose mais la fait pour la France, à jour des arrêtés, avec les leads conformes.

Repère de valeur pour le client : un chantier 8 kWc signé représente environ 3 000 à 4 000 € de marge brute. L'Essentiel est remboursé par **un sixième de chantier**.

Les prix sont dans `saas/config/formules.json`, modifiable sans toucher au code.

## 7. Encaissement

Deux modes, choisis par la configuration — et **aucun paiement n'est jamais simulé** :

- **Stripe** si `STRIPE_SECRET_KEY` est défini : session Checkout créée par appel direct à l'API (pas de SDK), activation sur webhook signé (`STRIPE_WEBHOOK_SECRET`, signature HMAC vérifiée, tolérance 5 min). Sans secret de webhook, le webhook est refusé : un endpoint non vérifié qui active des abonnements serait une porte ouverte.
- **Bon de commande** sinon : la commande est enregistrée « en attente », et un opérateur (ou un agent ayant la portée `abonnement:gerer`) la marque payée, ce qui active 12 mois.

## 8. Leads

Les leads captés par un widget passent toujours par le SaaS — c'est ce qui permet de les conserver, d'en faire la preuve de valeur en fin d'essai, et de dépanner un client. Ils sont ensuite **relayés vers son propre CRM** si un webhook `https` est configuré, signé en HMAC-SHA256 avec sa clé (en-tête `X-RDF-Signature`) pour qu'il puisse vérifier l'origine.

Un lead **sans preuve de consentement est refusé** (400) : depuis le 11 août 2026, un contact non rappelable n'a pas sa place dans la base d'un client.

## 9. Agents Hermès

Un jeton par profil, avec le minimum de portées :

| Profil | Peut | Ne peut pas |
|---|---|---|
| `prospection` | créer et qualifier des prospects, journaliser | activer un abonnement |
| `ventes` | tout le commercial : essais, activations, stats, leads | gérer les jetons |
| `dev` | configurer clients et pages, lire les stats | toucher au CRM |
| `secretariat` | lire, journaliser, consulter les leads | modifier un client |
| `admin` | tout | — |

```bash
curl -H "Authorization: Bearer hrm_vent_…" https://app.exemple.fr/api/v1/tableau-de-bord
```

Seule l'empreinte SHA-256 du jeton est stockée : un vol de base ne donne aucun jeton utilisable. Le jeton n'est affiché qu'à sa création.

**La console n'a aucun privilège particulier** : elle consomme exactement la même API. Tout ce qu'un humain fait ici, un agent peut le faire par API — c'est ce qui rend l'exploitation par agents possible sans double implémentation.

### Import en lot

```bash
curl -X POST -H "Authorization: Bearer hrm_pros_…" -H "Content-Type: application/json" \
  -d '{"prospects":[{"entreprise":"Solaire du Vexin","ville":"Vernon","site":"solaire-vexin.fr"}]}' \
  https://app.exemple.fr/api/v1/prospects
```

Les doublons (même site ou même e-mail) sont détectés et ignorés : deux agents qui prospectent la même zone ne créent pas deux fiches.

## 9 bis. Mise en ligne

Sur un VPS (OVH ou autre), l'installation tient en une commande :

```bash
git clone -b claude/pv-simulator-french-analysis-3s4c41 \
  https://github.com/qentinalouviers-sys/RDF-SOLAR.git /opt/rdf-solar
bash /opt/rdf-solar/deploy/installer.sh app.mondomaine.fr vous@mondomaine.fr
```

Node 22, utilisateur système sans shell, services systemd durcis, nginx, pare-feu, certificat Let's Encrypt et sauvegarde quotidienne. Mise à jour par `deploy/mise-a-jour.sh`, qui teste avant de redémarrer et revient en arrière tout seul en cas d'échec.

Procédure complète, DNS OVH et pièges à éviter : **[deploy/README.md](../deploy/README.md)**.

## 10. Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `8080` | port d'écoute |
| `RDF_SAAS_BASE` | `http://localhost:8080` | URL publique (sert à fabriquer les liens) |
| `RDF_SAAS_DB` | `saas/data/saas.db` | fichier SQLite |
| `RDF_SAAS_ADMIN` | `admin@rdf-solar.fr` | e-mail du premier compte |
| `RDF_SAAS_PVGIS` | — | proxy PVGIS servi aux widgets |
| `RDF_SAAS_GOOGLE_SOLAR` | — | clé Google Solar |
| `STRIPE_SECRET_KEY` | — | active l'encaissement en ligne |
| `STRIPE_WEBHOOK_SECRET` | — | vérification des webhooks |

Servez derrière un reverse proxy TLS et renseignez `RDF_SAAS_BASE` en `https` : le cookie de session passe alors en `Secure`.

## 11. Tests

```bash
node tests/saas.test.js     # 96 tests, base en mémoire, aucun réseau sortant
```

Couvrent le cycle de vie commercial, le thème et ses dérivations, l'interrupteur, les leads et leur exigence de consentement, les pages SEO et leur retrait à la coupure, le partage, l'abonnement, le CRM, les portées des agents (y compris ce qu'un profil **ne doit pas** pouvoir faire), et l'injection de code par un champ client.

## 12. Ce qui reste à faire

- **Recherche automatique de prospects** : la structure est là (source, filtres métier/ville/département/site, dédoublonnage, import en lot). Il manque le connecteur — Google Places, Pages Jaunes, annuaire RGE ou base SIRENE. Rien n'est simulé en attendant : on importe une liste, ou un agent la remplit par API.
- **Envoi d'e-mails** (accusés de réception, relances de fin d'essai) : aucun transport n'est configuré ; les leads partent aujourd'hui par webhook et sont visibles dans la console.
- **Espace client** : aujourd'hui l'installateur ne voit ses leads que via son CRM ou nous. Un accès en lecture à ses propres statistiques serait le premier argument de renouvellement.
- **Génération de QR code** côté serveur (aujourd'hui : lien direct à passer dans un générateur).
