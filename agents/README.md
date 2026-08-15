# Hermès — la flotte d'agents commerciaux

Hermès désigne les agents IA chargés de vendre le SaaS EVASIMU aux installateurs
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
| **Pont SaaS** | `agents/api.js` | les prospects de la console entrent, les envois remontent |
| **Inspection** | `agents/inspection.js` | visite le site du prospect : simulateur, niveau, identité |
| **Rédaction** | `agents/redaction.js` | messages personnalisés → fichiers `.eml` |
| **Envoi** | `agents/envoi.js` | expédition SMTP sous cadence maîtrisée |
| **Publication** | `agents/publication.js` | calendrier de publications réseaux sociaux |
| Sourcing mono-source | `agents/sourcing.js` | plus rapide, sans croisement |
| Source RGE | `agents/rge.js` | annuaire ADEME, API ou CSV |

**Pour confier la flotte à un agent IA : `agents/PROMPT-AGENT.md`.** C'est un brief
autonome à copier-coller — mission, accès, garde-fous, journée type, cadre légal. Des
tests vérifient qu'il ne cite aucune commande disparue ni aucun tarif périmé.

Tout est opérationnel et testé : **432 tests** (`tests/sourcing`, `tests/croisement`,
`tests/pipeline`, `tests/inspection`, `tests/api`, `tests/envoi`).

---

## 1 bis. L'enchaînement complet

```bash
export EVASIMU_URL=https://app.eviatek.fr
export EVASIMU_JETON=hs_…            # console → Jetons → profil « prospection »

# 1. Faire entrer les prospects de la console dans le pipeline
node agents/hermes.js synchro

#    (ou capturer de nouvelles entreprises, puis les pousser dans la console)
node agents/hermes.js capture --departement 69 --pages 3
node agents/hermes.js synchro --pousser

# 2. Regarder leurs sites : simulateur en place ? de quel niveau ?
node agents/hermes.js inspection --limite 25

# 3. Voir où on en est et ce qui est dû aujourd'hui
node agents/hermes.js suivi

# 4. Simuler l'envoi du jour — rien ne part, on relit
node agents/hermes.js envoi --limite 10 --score 60

# 5. Envoyer pour de vrai, à la cadence autorisée
export EVASIMU_SMTP_UTILISATEUR=contact@eviatek.fr
export EVASIMU_SMTP_MOTDEPASSE=…          # mot de passe d'application
node agents/hermes.js envoi --limite 10 --score 60 --envoyer

# Au fil de l'eau
node agents/hermes.js etat 812345678 repondu "veut une démo jeudi"
node agents/hermes.js stop contact@exemple.fr "a répondu STOP"
node agents/hermes.js posts --semaines 4
node agents/hermes.js tableau
```

`messages` reste disponible pour produire des `.eml` à relire ou à importer comme
brouillons — c'est la voie prudente pour les premiers messages d'une campagne.

### Les trois garde-fous

1. **Le registre d'opposition prime sur tout.** Une adresse au registre bascule le prospect
   en « exclu » immédiatement, et **une recapture ne le réactive jamais** — même avec un
   score de 100. C'est la protection la plus importante du système, et elle est testée.
2. **Les transitions d'état sont contraintes.** On ne relance pas quelqu'un qui a répondu,
   on ne saute pas d'étapes, et « exclu » est définitif.
3. **Rien ne part sans le demander explicitement.** `messages` produit des `.eml` à relire
   et n'avance le pipeline qu'avec `--marquer` ; `envoi` simule tant qu'on n'a pas écrit
   `--envoyer`, et n'avance l'état qu'après un envoi réellement réussi.

### Ce que produit la rédaction

Des fichiers `.eml` standard (importables comme brouillons dans n'importe quelle
messagerie) et un `publipostage.csv`. Chaque message :

- **cite ce que l'agent a observé** — « En regardant dupont-energie.fr, j'ai vu que vos
  visiteurs peuvent demander un devis, mais pas visualiser leur toiture équipée » ;
- existe en **plusieurs variantes**, choisies de façon déterministe par SIREN : un texte
  strictement identique envoyé en masse se fait filtrer, et ça se voit ;
- porte un **pied légal** : émetteur identifié, objet de la sollicitation, et
  désinscription en une phrase (« répondez STOP »).

Le bloc `EMETTEUR` en tête de `agents/redaction.js` est renseigné : EVASIMU — Tekotek,
20 rue Maréchal Foch, 27400 Louviers, `contact@eviatek.fr`, +33 6 14 74 69 75. Deux tests
vérifient que l'adresse postale et le téléphone figurent bien dans chaque message : sans
eux, la sollicitation est anonyme.

> Le domaine signé doit **résoudre réellement**. `evasimu.fr`, utilisé jusqu'ici, n'a ni
> enregistrement A ni MX : tout message parti sous cette signature aurait été classé en
> indésirable avant lecture, et son identification d'émetteur était fausse.

---

## 1 ter. L'inspection des sites

La détection précédente tenait en un regex sur la page d'accueil : « oui » ou « non ».
Insuffisant, parce que les deux cas qui comptent commercialement ne sont pas *avec* et
*sans* simulateur :

| Ce qu'on trouve | Ce qu'on en fait |
|---|---|
| aucun simulateur | cible prioritaire — l'argument est le lead qualifié |
| simulateur rudimentaire | cible — l'argument est ce que le sien ne fait pas |
| simulateur avancé | **on n'écrit pas** : on perd son temps et du quota d'envoi |

`agents/inspection.js` visite l'accueil, suit les liens qui sentent le simulateur, teste
quelques chemins usuels, et lit les feuilles de style. Il en rapporte :

- **le simulateur** — présent ou non, son adresse, son niveau technique (0 à 4), ses
  capacités (carte, photo aérienne, 3D, ombrage, PVGIS, PDF, prise de rendez-vous) et les
  **données qu'il réclame au visiteur** ;
- **l'identité visuelle** — enseigne affichée et couleurs dominantes ;
- **des faits citables**, qui rendent l'accroche vérifiable.

Le gain se voit dans le message. Avant : « nous travaillons avec des installateurs
photovoltaïques ». Après :

> J'ai regardé solaire-vexin.fr : vous proposez déjà une estimation en ligne, mais le
> visiteur n'y voit à aucun moment sa propre toiture. Il réclame consommation ou facture,
> nom et e-mail avant d'afficher le moindre résultat.

Les champs banals — nom, e-mail, téléphone — sont volontairement relégués : tous les
formulaires du monde les demandent, les citer ne prouve rien.

### La fiche du CRM, prête à être enrichie

Une inspection ne sert à rien si elle reste dans le `pipeline.json` d'un agent : ce sont
des humains qui décrochent le téléphone. Les résultats remontent donc dans la fiche du
CRM, par `POST /api/v1/prospects/:id/inspection` (portée `prospects:ecrire`).

Le découpage entre colonnes et JSON n'est pas arbitraire :

| Champ | Type | Pourquoi une colonne |
|---|---|---|
| `simulateur_niveau` | 0–4, **NULL = jamais inspecté** | on filtre dessus |
| `simulateur_url` | texte | on clique dessus |
| `cible` | 0/1, NULL inconnu | « montre-moi qui démarcher » |
| `inspecte_le` | date | « qui reste à inspecter » |
| `enseigne` | texte | le nom affiché, pas la raison sociale |
| `couleur` / `couleur_apercu` | `#rrggbb` | la charte relevée, et sa version décalée |
| `enrichissement` | JSON | capacités, données réclamées, éditeurs, pages vues |

Tout ce qui évoluera à chaque amélioration du détecteur vit dans `enrichissement` : une
nouvelle capacité détectée ne doit pas coûter une migration de schéma. Ce sur quoi on
filtre a une colonne, parce que « les prospects sans simulateur du 27 » doit rester une
requête SQL.

Trois règles tenues par les tests :

1. **NULL n'est pas 0.** « Jamais inspecté » et « inspecté, aucun simulateur trouvé » sont
   deux situations opposées : la première est du travail à faire, la seconde un argument
   de vente.
2. **Le détail fusionne, il n'écrase pas.** Une seconde passe qui n'a pas su lire les
   couleurs ne doit pas effacer celles que la première avait trouvées.
3. **Un agent ne touche jamais au statut commercial.** Conclure « pas une cible » est une
   information ; abandonner un prospect est une décision humaine. L'enrichissement est en
   revanche **journalisé** — le commercial voit qu'un agent est passé, quand, et ce qu'il
   a conclu, plutôt que des champs qui changent tout seuls.

Dans la console, la liste gagne une colonne « Leur simulateur » et quatre filtres :
*à démarcher*, *sans simulateur*, *écartés (déjà équipés)*, *site pas encore inspecté*.
La fiche affiche un bloc « Ce que l'agent a vu sur leur site », avec les deux pastilles de
couleur — celle relevée, et celle de l'aperçu.

### Politesse, parce qu'on visite le site de quelqu'un d'autre

- **`robots.txt` est lu et respecté**, groupe propre prioritaire sur le générique, `Allow`
  plus spécifique l'emportant sur `Disallow`. Un `Disallow: /` arrête la visite net.
- Le robot **s'identifie** et donne un moyen de le joindre.
- Une requête à la fois, 1,5 s d'écart, 6 pages maximum par site.

### Couleurs : proches, jamais identiques

`approcher()` décale la teinte relevée de 9° et ajuste saturation et luminosité. C'est
délibéré : reproduire à l'identique la charte d'une entreprise dans un document
commercial que l'on signe soi-même, c'est risquer de laisser croire qu'il en émane. Le
décalage est déterministe — le même prospect obtient toujours le même rendu — et reste
assez proche pour que l'aperçu lui parle. **Aucun logo n'est repris**, jamais.

---

## 1 quater. L'envoi, et pourquoi il est si bridé

`agents/envoi.js` expédie en SMTP direct (`node:tls`, aucune dépendance). Mais l'essentiel
de son code n'est pas le transport : les filtres ne jugent pas un message isolé, ils jugent
un **rythme**. Envoyer cent messages d'un coup depuis une adresse neuve grille le domaine
en une soirée.

| Garde-fou | Réglage par défaut | Pourquoi |
|---|---|---|
| Rampe de chauffe | 5 le 1ᵉʳ jour, +5/jour, plafond 25 | une adresse neuve n'a aucune réputation |
| Heures ouvrables | 8 h–18 h, jours ouvrés | un envoi à 3 h du matin est un signal |
| Pauses aléatoires | 45 s à 4 min entre deux | une rafale régulière signe l'automate |
| Contrôle MX | avant chaque envoi | un rebond coûte plus que le message ne rapporte |
| Registre d'opposition | revérifié juste avant l'envoi | il a pu s'enrichir depuis la rédaction |
| Seuil de rebonds | arrêt au-delà de 5 % | au-delà, c'est la liste qui est en cause |

**Rien ne part sans `--envoyer`.** Par défaut la commande simule et affiche ce qui serait
expédié. L'état d'un prospect n'avance qu'**après** un envoi réussi : une coupure laisse le
prospect à traiter plutôt que faussement marqué contacté.

Les 114 prospects importés en console représentent donc environ **cinq jours ouvrés**, pas
une soirée. C'est le prix de la délivrabilité.

### Ce qui se joue hors du code

Le code ne peut pas tout : la réputation se construit dans le DNS et chez le fournisseur.

- **SPF, DKIM, DMARC** sur le domaine d'envoi, les trois. Sans DMARC, Gmail dégrade même à
  petit volume. Commencer en `p=none`, passer à `p=quarantine` après deux semaines propres.
- **Ne pas envoyer depuis le VPS** : une IP de datacenter n'a aucune réputation et figure
  généralement dans la PBL de Spamhaus. Passer par une vraie boîte (Workspace, 365, OVH).
- **Séparer la prospection du transactionnel.** Si le domaine de prospection brûle, la
  remise des leads aux clients ne doit pas mourir avec.
- **Attention aux CGU** : les fournisseurs transactionnels (Brevo, Mailjet, Scaleway TEM)
  interdisent la prospection à froid. Les garder pour les e-mails du SaaS.

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
- **L'envoi ne passe pas par le connecteur.** Il n'existe aucun outil d'envoi côté Gmail :
  le connecteur dépose des brouillons, un humain clique. Pour l'envoi automatisé, c'est
  `agents/envoi.js` qui parle SMTP à la même boîte — et la délivrabilité se joue de toute
  façon dans le DNS, pas dans l'interface utilisée pour cliquer.
- Le maillon « closing » est complet : l'Agenda peut poser les rendez-vous.

Les deux modes visent la même boîte et se complètent :

| Mode | Par quoi | Pour quoi |
|---|---|---|
| Brouillons | connecteur Gmail, `create_draft` | démarrage, relecture des premiers messages |
| Envoi | `agents/envoi.js` en SMTP | quand la cadence et le contenu sont rodés |

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
