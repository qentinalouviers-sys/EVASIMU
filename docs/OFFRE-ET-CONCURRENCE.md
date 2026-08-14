# Concurrence et construction de l'offre

Analyse au 14 août 2026. Objectif : une offre que les concurrents ne peuvent
pas égaler sans casser leur propre modèle économique.

> Avertissement sur les sources. Les prix des logiciels sont publics et
> vérifiables. Les prix des leads viennent en grande partie de blogs d'agences
> qui vendent ces leads : ce sont des sources intéressées, à lire comme des
> ordres de grandeur, pas comme des tarifs de référence. Les fourchettes citées
> se recoupent entre plusieurs sources indépendantes, ce qui les rend crédibles
> — mais elles restent des fourchettes.

## 1. Ce qu'un installateur paie aujourd'hui

Trois lignes de budget distinctes, que personne ne réunit :

| Ligne | Ce qu'il paie | Ce qu'il obtient |
|---|---|---|
| **Leads achetés** | 25–120 € le lead. Exclusif avec numéro vérifié et fiche projet complète : 80–150 €. Lead brut mutualisé : 15–40 € | Un contact loué, souvent revendu à trois concurrents. 15–20 % de RDV sur les leads exclusifs |
| **Logiciel d'étude et de devis** | SolarPro 69 €/mois (Business 199 €), XT-ERP 159 €/mois, Aurora Solar 135–259 $/utilisateur/mois | Un outil interne. Aucun lead |
| **Simulateur sur son site** | Likewatt Optiwize Leads : sur devis, avec « développement personnalisé » et du temps de ses équipes | Des leads qui lui appartiennent — mais après un projet |

La ligne qui fait mal est la première. Vingt leads par mois à 45 € font
**900 €/mois** pour des contacts que l'installateur ne possède pas, qu'il
partage avec ses concurrents, et qui disparaissent le jour où il arrête de
payer. C'est là qu'est le budget, et c'est là qu'il faut attaquer.

## 2. Les concurrents et leur faiblesse structurelle

**Likewatt (Optiwize Leads)** — le plus proche de nous. Simulateur
d'autoconsommation en marque blanche, rapport PDF au prospect, lead enrichi
remonté dans leur outil Optiwize Pro. C'est un bon produit, positionné bureaux
d'études et grands comptes. *Faiblesse* : tarif sur devis, mise en place par
« développement personnalisé » mobilisant les équipes du client. Chaque
nouveau client leur coûte des jours-homme. Ils ne peuvent ni afficher un prix,
ni offrir la mise en service, ni servir un artisan de trois personnes.

**SolarGen** — positionnement quasi identique au nôtre : simulateur intégré en
dix minutes, leads pré-qualifiés avec le contexte pour le premier appel. C'est
le concurrent à surveiller de près. Tarif non public à ce jour.

**SolarPro** — 69 €/mois en entrée, 199 €/mois en Business. PVGIS intégré,
devis automatisés, MaPrimeRénov', Consuel, OAuth Enedis. *Faiblesse* : c'est un
logiciel de production de devis, pas un générateur de leads. Il travaille sur
des prospects que l'installateur a déjà.

**Aurora Solar** — 135 à 259 $ par utilisateur et par mois. Référence mondiale
de l'étude solaire. *Faiblesse* : le prix par utilisateur. Un installateur de
six commerciaux paie six fois. Et le produit ne s'adresse pas au particulier.

**OpenSolar** — gratuit, financé par les partenaires matériel et financement,
avec depuis avril 2026 une facturation sur les sorties de données (API, connecteurs).
*Faiblesse* : le gratuit est payé par les fabricants, donc le catalogue est
orienté. Un installateur qui veut ses propres prix et ses propres marques n'est
pas le client de ce modèle. Mais **OpenSolar prouve que le gratuit prend le
marché** : c'est la leçon à retenir.

**Les places de marché de leads** (Hellio, Effy, agences d'acquisition) — elles
ne sont pas des concurrents logiciels, ce sont *le vrai concurrent*, parce
qu'elles occupent le budget. *Faiblesse* : elles louent, elles ne transmettent
rien. L'installateur ne construit aucun actif.

## 3. Pourquoi notre structure de coûts n'est pas la leur

Ce que coûte un client de plus, chez nous :

- **Mise en service** — un agent visite le site du prospect, en extrait le nom,
  les couleurs et les offres, et génère le simulateur personnalisé avant même
  le premier appel (`agents/inspection.js`). Coût humain : zéro. Chez Likewatt,
  c'est un projet de développement.
- **Analyse de toiture** — Google Solar API `buildingInsights:findClosest`,
  avec un plafond gratuit de 10 000 requêtes par mois. C'est le seul appel
  payant du simulateur, et il est gratuit jusqu'à 10 000 toits analysés par
  mois, tous clients confondus. La production vient de PVGIS (Commission
  européenne, gratuit) et le fond de carte de l'IGN (gratuit).
- **Hébergement** — widget statique, serveur Node sans dépendance, SQLite.
  Quelques euros de VPS pour l'ensemble du parc.
- **Prospection, relances, rédaction, support de premier niveau** — agents.

Le coût marginal d'un client supplémentaire est de l'ordre de quelques
centimes par mois. Celui d'un concurrent à mise en service humaine se compte en
centaines d'euros. **C'est la seule asymétrie qui compte**, et toute l'offre
doit être construite pour l'exploiter.

## 4. L'offre recommandée

Le principe : **ne pas se battre sur le prix du logiciel, se battre sur le prix
du lead.** Un installateur ne compare pas 79 € à 69 €. Il compare 79 € à ce que
lui coûtent ses leads.

### Le message d'entrée

> Un lead exclusif vous coûte entre 45 et 150 €. Notre abonnement complet coûte
> moins que deux leads par mois — et les leads qu'il produit sont les vôtres,
> depuis votre site, à votre marque. Le jour où vous arrêtez de payer, ils
> continuent d'arriver.

### La grille

| | **Découverte** | **Essentiel** | **Agence** |
|---|---|---|---|
| Prix | **0 €** | **79 € HT/mois** | **199 € HT/mois** |
| Leads | 5 par mois | **illimités** | illimités |
| Sites | 1 | 1 | jusqu'à 5 + multi-agences |
| Utilisateurs | illimités | illimités | illimités |
| Simulateur marque blanche | ✓ | ✓ | ✓ + personnalisation avancée |
| CRM, relances, exports | — | ✓ | ✓ + API |
| Veille réglementaire | ✓ | ✓ | ✓ |
| Engagement | aucun | aucun | aucun |

Trois choix structurants dans cette grille, et chacun exploite l'asymétrie :

**Aucune tarification par utilisateur.** Aurora facture par siège. Chez nous
l'installateur inscrit ses six commerciaux sans réfléchir. Ça ne nous coûte
rien et ça retire un frein à chaque embauche chez lui.

**Un palier gratuit qui n'expire pas.** Cinq leads par mois, livrés
complètement — pas de lead flouté, pas de fausse générosité. Un installateur
qui a posé le widget sur son site ne le retire pas ; il passe payant le mois où
il dépasse. C'est la leçon d'OpenSolar, appliquée sans dépendre des fabricants.

**Une alternative à l'abonnement : 9 € le lead qualifié, sans abonnement.**
Contre 45 à 150 € sur le marché. C'est l'offre qu'aucun concurrent ne peut
suivre : eux ont un coût humain par client, donc ils ont besoin d'un plancher
d'abonnement. Nous non. Au-delà de neuf leads par mois, l'illimité devient plus
avantageux et l'installateur bascule de lui-même.

Un lead n'est « qualifié » que s'il est objectivement chiffré : toiture
calepinée, puissance et production calculées, coordonnées renseignées. Le
simulateur refuse déjà d'envoyer un devis sur une simulation vide — la
définition est tenue par le code, pas par une clause.

### Les quatre arguments que la concurrence ne peut pas copier

1. **Votre simulateur est en ligne avant le premier appel.** L'agent visite le
   site du prospect, en tire son nom, ses couleurs et ses offres, et lui envoie
   le lien de *son* simulateur. Likewatt vend un projet de développement ; nous
   livrons la démonstration avant la vente. Sur un devis, cet écart est
   incompréhensible pour le client — ce qui est exactement l'effet recherché.

2. **Vos chiffres sont à jour le jour où l'arrêté paraît.** Le photovoltaïque
   français change de règles en permanence : TVA à 5,5 % sous condition de
   pilotage, effondrement du tarif de rachat du surplus à 1,1 c€/kWh depuis
   l'arrêté du 4 juin 2026. Un simulateur qui affiche des chiffres périmés
   expose l'installateur — il annonce à un particulier une rentabilité qui
   n'existe plus. Maintenir cette veille demande un humain chez un concurrent ;
   chez nous c'est un agent. **C'est le point le plus défendable de toute
   l'offre** : ce n'est pas une fonctionnalité, c'est une réduction de risque
   juridique, et ça se paie.

3. **Pas facturé tant que ça ne produit pas.** Le premier mois n'est facturé
   que si le simulateur a produit au moins cinq leads qualifiés. Notre coût
   marginal étant nul, cette garantie ne nous coûte presque rien ; pour un
   concurrent à mise en service humaine, elle est intenable.

4. **Les leads sont à vous, et exportables.** Export complet à tout moment,
   sans négociation. C'est l'inverse exact du modèle des places de marché, et
   ça se dit en une phrase.

## 5. Ce que ça change dans le code

- `agents/redaction.js`, bloc `OFFRE` — les prix actuels (89 € / 179 €) et la
  formulation « 30 jours d'essai » ne correspondent plus à cette grille. C'est
  ce bloc qui alimente tous les e-mails des agents : il est la source unique.
- La page de vente (`index.html`) — même grille, même vocabulaire.
- Le palier gratuit et le comptage des leads n'existent pas encore côté SaaS :
  il faut un quota par client et un compteur mensuel dans `saas/lib/`.
- Le déclenchement de la facturation à cinq leads suppose de compter les leads
  qualifiés par client et par mois — même compteur.

Rien de tout cela n'est engagé : les prix restent une proposition tant qu'ils
ne sont pas validés.

## 6. Ce qui reste à trancher

- **Les niveaux de prix.** 79 € et 199 € sont calés sur SolarPro (69 € / 199 €)
  et sur le prix de deux leads. À valider.
- **Le pay-per-lead à 9 €.** C'est l'arme la plus forte et la plus risquée :
  revenus imprévisibles, et elle cannibalise l'abonnement chez les petits
  volumes. À n'ouvrir que si l'on assume cette imprévisibilité.
- **Le palier gratuit à 5 leads.** Trop haut, il tue l'abonnement chez les
  artisans qui font trois chantiers par mois. Trop bas, il ne sert pas de
  cheval de Troie. Cinq est un pari, pas un calcul.

## Sources

Prix des logiciels : [SolarPro et comparatif](https://awema.fr/blog/logiciel-gestion-projet-solaire-comparatif/),
[Aurora Solar](https://www.heavengreenenergy.com/blog/aurora-solar-pricing),
[Aurora vs OpenSolar](https://www.heavengreenenergy.com/blog/aurora-vs-opensolar),
[XT-ERP](https://www.adlertechnologies.eu/logiciel-installateur-photovoltaique),
[Likewatt Optiwize Leads](https://likewatt.com/optiwize-leads/),
[SolarGen](https://solargen.app/blog/generer-leads-qualifies-installateur-solaire).

Prix des leads (sources intéressées) : [Sunleads](https://sunleads.fr/prix-lead-qualifie/),
[Webofly](https://webofly.com/acheter-des-leads-panneaux-solaires-le-guide-complet-2026/),
[MEG Business](https://megbusiness360.com/blog/lead-photovoltaique),
[ScaleCity](https://scalecity.fr/barometre-cout-par-lead/).

Coûts techniques : [Google Solar API — usage et facturation](https://developers.google.com/maps/documentation/solar/usage-and-billing).

Marché : [prix d'une installation en 2026](https://www.potentielsolaire.com/prix-panneaux-solaires).
