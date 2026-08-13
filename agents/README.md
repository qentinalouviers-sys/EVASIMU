# Hermès — la flotte d'agents commerciaux

Hermès désigne les agents IA chargés de vendre le SaaS RDF-SOLAR aux installateurs
photovoltaïques : trouver les prospects, les qualifier, les contacter, publier sur les
réseaux, poser les rendez-vous.

⚠️ **Rappel de vocabulaire** (cf. README § 0) : les prospects d'Hermès sont des
**installateurs** — nos leads SaaS. Rien à voir avec les **leads visiteurs** du
simulateur, qui sont des particuliers et appartiennent à l'installateur client.

---

## 1. Ce qui est construit

| Agent | Fichier | Rôle |
|---|---|---|
| **Commande unique** | `agents/hermes.js` | enchaîne tout autour d'un état partagé |
| **Capture par croisement** | `agents/croisement.js` | plusieurs sources → une fiche par entreprise |
| **Pipeline** | `agents/pipeline.js` | état, historique, relances, registre d'opposition |
| **Rédaction** | `agents/redaction.js` | messages personnalisés → fichiers `.eml` |
| **Publication** | `agents/publication.js` | calendrier de publications réseaux sociaux |
| Sourcing mono-source | `agents/sourcing.js` | plus rapide, sans croisement |
| Source RGE | `agents/rge.js` | annuaire ADEME, API ou CSV |

Tout est opérationnel et testé : **175 tests** (`tests/sourcing`, `tests/croisement`, `tests/pipeline`).

---

## 1 bis. L'enchaînement complet

```bash
# 1. Capturer et alimenter le pipeline (n'écrase jamais l'existant)
node agents/hermes.js capture --departement 69 --pages 3

# 2. Voir où on en est et ce qui est dû aujourd'hui
node agents/hermes.js suivi

# 3. Rédiger les messages du jour — rien n'est envoyé
node agents/hermes.js messages --limite 20 --score 60

# 4. Relire les .eml, les importer comme brouillons, envoyer

# 5. Marquer les envois pour que les relances se déclenchent au bon moment
node agents/hermes.js messages --limite 20 --score 60 --marquer

# Au fil de l'eau
node agents/hermes.js etat 812345678 repondu "veut une démo jeudi"
node agents/hermes.js stop contact@exemple.fr "a répondu STOP"
node agents/hermes.js posts --semaines 4
node agents/hermes.js tableau
```

### Les trois garde-fous

1. **Le registre d'opposition prime sur tout.** Une adresse au registre bascule le prospect
   en « exclu » immédiatement, et **une recapture ne le réactive jamais** — même avec un
   score de 100. C'est la protection la plus importante du système, et elle est testée.
2. **Les transitions d'état sont contraintes.** On ne relance pas quelqu'un qui a répondu,
   on ne saute pas d'étapes, et « exclu » est définitif.
3. **Aucun agent n'envoie rien.** La rédaction produit des `.eml` à relire. Le pipeline
   n'avance que si vous ajoutez `--marquer`, une fois les messages réellement partis.

### Ce que produit la rédaction

Des fichiers `.eml` standard (importables comme brouillons dans n'importe quelle
messagerie) et un `publipostage.csv`. Chaque message :

- **cite ce que l'agent a observé** — « En regardant dupont-energie.fr, j'ai vu que vos
  visiteurs peuvent demander un devis, mais pas visualiser leur toiture équipée » ;
- existe en **plusieurs variantes**, choisies de façon déterministe par SIREN : un texte
  strictement identique envoyé en masse se fait filtrer, et ça se voit ;
- porte un **pied légal** : émetteur identifié, objet de la sollicitation, et
  désinscription en une phrase (« répondez STOP »).

Le bloc `EMETTEUR` en tête de `agents/redaction.js` est renseigné : RDF-SOLAR — Tekotek,
20 rue Maréchal Foch, 27400 Louviers, `contact@rdf-solar.fr`, +33 6 14 74 69 75. Deux tests
vérifient que l'adresse postale et le téléphone figurent bien dans chaque message : sans
eux, la sollicitation est anonyme.

---

## 2. L'outil de capture par croisement — le principal

```bash
node agents/croisement.js --departement 69 --pages 3 --sortie data/lyon
node agents/croisement.js --departement 69 --rge-csv rge.csv --sans-site
```

Produit **trois fichiers** : `lyon.csv`, `lyon.json`, et `lyon.html` — un tableau de bord
autonome pour trier, filtrer et sélectionner les prospects à travailler.

### Les trois sources et ce que chacune apporte

| Source | Apporte | Ne donne pas |
|---|---|---|
| **Annuaire des entreprises** | SIRET, APE, effectif, adresse, état administratif | aucun contact |
| **Annuaire RGE (ADEME)** | **qualification Quali'PV**, souvent e-mail et téléphone | identité incomplète |
| **Site de l'entreprise** | contacts à jour, présence d'un simulateur concurrent | rien de structuré |

Aucune ne suffit seule. Le croisement fait deux choses :

1. **Il complète** — le RGE apporte le contact que l'annuaire officiel n'a jamais.
2. **Il confirme** — une entreprise vue dans les trois sources, qualifiée Quali'PV et
   sans simulateur, est un prospect qualifié, pas une ligne de fichier.

### Comment les fiches sont rapprochées

Trois niveaux, du plus sûr au plus permissif :

1. **SIREN identique** — certitude ;
2. **SIRET identique** (le SIREN en est déduit) — certitude ;
3. **nom proche + même code postal** — quand une source n'a pas d'identifiant.
   La comparaison retire les formes juridiques (`SARL`, `S.A.S.`…) et les accents,
   puis mesure le recouvrement des mots. Seuil : 0,7.

### Qui fait autorité sur quel champ

L'identité vient de l'**annuaire officiel**, les qualifications du **RGE**, le site web
et les contacts frais du **site**. Les contacts ne sont jamais arbitrés : ils sont
**cumulés** — mieux vaut deux numéros à vérifier qu'un seul, mal choisi, qui ne répond pas.
Chaque champ retenu garde sa **provenance**, sans quoi il serait impossible de savoir plus
tard d'où sort un téléphone erroné.

### La note, recalibrée pour le croisement

```
+28  e-mail sur le domaine de l'entreprise   +13  aucun simulateur détecté
+16  e-mail (autre domaine)                   +5  recoupée par 3 sources
+20  téléphone                                +3  recoupée par 2 sources
+22  qualification Quali'PV                   +5  effectif 3–49
 +7  RGE sur un autre domaine                −12  simulateur déjà en place
 +7  site web trouvé                         −40  entreprise fermée
```

Les poids somment exactement à 100 : au-delà, le plafond écraserait les signaux faibles et
deux prospects très différents afficheraient la même note.

### Le tableau de bord

Fichier HTML autonome, sans dépendance ni ressource externe. Tri par colonne, recherche,
filtres (score, e-mail, téléphone, Quali'PV, sans simulateur), sélection multiple et
export CSV de la sélection. Les e-mails sont des liens `mailto:` au sujet pré-rempli.

---

## 3. L'agent de sourcing (source unique)

```bash
node agents/sourcing.js --ape 43.22B --departement 69 --pages 3 --sortie data/lyon
node agents/sourcing.js --help
```

Produit `data/lyon.csv` et `data/lyon.json`, triés par score décroissant.

### Sa chaîne de traitement

1. **Annuaire officiel des entreprises** (`recherche-entreprises.api.gouv.fr`) — gratuit,
   sans clé. Filtre par code APE et département. Donne raison sociale, SIRET, adresse,
   effectif… mais **aucun contact**.
2. **Annuaire RGE** (facultatif, `--rge fichier.csv`) — open data ADEME. Marque les
   entreprises qualifiées et récupère leurs coordonnées si le fichier en contient.
   Le lecteur ne suppose aucun nom de colonne : il repère les SIRET par leur forme.
3. **Découverte du site** — déduit des noms de domaine plausibles à partir de la raison
   sociale, puis les teste réellement en HTTPS puis HTTP.
4. **Lecture des coordonnées** — visite les pages `/contact` et `/mentions-legales`.
   Les mentions légales sont obligatoires en France et portent les coordonnées : c'est
   la source la plus fiable.
5. **Détection d'un simulateur** — l'entreprise a-t-elle déjà un outil de simulation ?
6. **Notation sur 100** et export.

### La note, et pourquoi elle compte

```
+35  e-mail sur le domaine de l'entreprise      +10  site web trouvé
+20  e-mail (autre domaine)                     +10  qualifiée RGE
+25  téléphone trouvé                            +5  effectif 3–49 (cœur de cible)
+15  AUCUN simulateur détecté                   −10  simulateur déjà en place
                                                −40  entreprise fermée
```

Le signal décisif est **l'absence de simulateur** : c'est un prospect à qui l'argumentaire
s'adresse directement, et son site vous donne l'accroche du message.

### Ce qu'il ne fait pas, volontairement

- **Ni Google Maps ni moteur de recherche.** Leurs conditions interdisent de constituer
  un fichier de prospection à partir de leurs résultats. Bâtir l'acquisition dessus
  serait la rendre résiliable du jour au lendemain.
- **Il n'envoie rien.** Il produit une liste. La prise de contact est un autre agent,
  avec validation humaine.
- Il respecte `robots.txt`, s'annonce par un `User-Agent` identifiable avec une adresse
  de contact, et espace ses requêtes de 1,2 s.

### Limite à connaître

Le code n'a **jamais tourné contre l'API réelle** : l'environnement de développement
bloque les domaines externes. La logique est testée contre un faux site servi en local
(`tests/sourcing.test.js`, 61 tests), mais **la première exécution réelle doit être
vérifiée à la main** — en particulier le schéma de réponse de l'annuaire et le format du
fichier RGE.

---

## 4. Ce que les connecteurs Google permettent — et pas

| Connecteur | Peut | Ne peut pas |
|---|---|---|
| **Gmail** | Chercher, lire, étiqueter, **créer des brouillons** | **Envoyer** — il n'existe aucun outil d'envoi |
| **Google Agenda** | Créer, modifier, chercher des événements | — |
| **Google Drive** | Lire et écrire vos fichiers | — |

Deux conséquences pour l'architecture :

- **Aucun connecteur Google ne fournit de prospects.** Gmail ne fouille que votre propre
  boîte : utile pour réactiver d'anciens contacts, inutile pour acquérir.
- **L'absence d'envoi Gmail est une contrainte utile.** Les agents rédigent, un humain
  valide et envoie. Sur de la prospection automatisée, c'est le garde-fou qu'il faut.
  Le maillon « closing » est en revanche complet : l'Agenda peut poser les rendez-vous.

---

## 5. Cadre légal — prospection B2B en France

- **E-mail** : licite au titre de l'intérêt légitime si l'offre concerne le métier du
  destinataire, avec émetteur identifiable et moyen de se désinscrire. Les adresses
  génériques (`contact@`) sont les plus sûres ; une adresse nominative demande plus de soin.
- **Téléphone** : Bloctel ne couvre que les particuliers. Démarcher un professionnel est
  licite, mais une opposition doit être respectée immédiatement.
- **LinkedIn** : le scraping et l'automatisation des messages sont interdits par les CGU,
  et les comptes sont restreints rapidement. Publier sur **votre page** via l'API
  officielle ne pose en revanche aucun problème.
- **Tenez un registre des oppositions** et excluez-le du sourcing : c'est une obligation,
  et c'est trois lignes de code.

---

## 6. Suite logique

1. **Vérifier le croisement en conditions réelles** sur un département, puis ajuster les
   codes APE — beaucoup d'installateurs sont déclarés en électricien ou en chauffagiste.
   Contrôler en particulier le schéma renvoyé par l'API ADEME (voir la limite ci-dessus).
2. **Agent de rédaction** : à partir d'une fiche, écrire un message qui cite ce que l'agent
   a vu sur leur site. Sortie en brouillon Gmail, jamais en envoi direct.
3. **Agent de publication** : API officielles des pages LinkedIn et Facebook.
4. **Agent de suivi** : `search_threads` pour classer les réponses, `create_draft` pour
   proposer une réponse.
5. **Agent de closing** : `create_event` avec lien Meet quand le prospect accepte.
