# Mise en ligne sur un VPS OVH

De l'IP nue au SaaS en production, en une commande. Comptez **quinze minutes**, dont dix d'attente sur la propagation DNS.

---

## 1. Ce qu'il vous faut

- Un **VPS** OVH sous Debian 12 ou Ubuntu 24.04. Le plus petit modèle suffit largement : l'application n'a aucune dépendance, la base est un fichier SQLite, et la page du widget est mise en cache. 1 vCore et 2 Go tiennent plusieurs centaines de clients.
- Un **domaine**, chez OVH ou ailleurs.
- Un accès **SSH root** (ou un utilisateur `sudo`).

## 2. Pointer le domaine

Dans l'espace client OVH : **Noms de domaine → votre domaine → Zone DNS → Ajouter une entrée**.

| Type | Sous-domaine | Cible |
|---|---|---|
| A | `app` | l'IPv4 de votre VPS |
| AAAA *(si votre VPS a une IPv6)* | `app` | l'IPv6 de votre VPS |

Vous obtenez `app.mondomaine.fr`. Attendez que ça résolve avant de lancer l'installation — sinon le certificat TLS échouera :

```bash
dig +short app.mondomaine.fr     # doit renvoyer l'IP du VPS
```

L'installateur le vérifie et refuse de continuer si ça ne correspond pas : c'est l'erreur la plus fréquente et elle coûte dix minutes à chaque fois.

> **Quel sous-domaine choisir ?** Il apparaîtra dans tous les liens que verront vos clients (`https://app.mondomaine.fr/w/xxx.js` sur leur site, `https://app.mondomaine.fr/p/ville` pour leurs pages SEO). `app`, `simulateur` ou `solaire` fonctionnent aussi bien. Évitez d'en changer plus tard : les scripts déjà posés chez vos clients cesseraient de fonctionner.

## 2 bis. Machine déjà occupée ? Faites d'abord l'état des lieux

Si le VPS héberge déjà des applications (agent, API, autre site), lancez le diagnostic **avant** d'installer. Il ne modifie rien et dit exactement ce qui occupe la place :

```bash
bash /opt/rdf-solar/deploy/diagnostic.sh
```

L'installateur est conçu pour cohabiter :

| Risque habituel | Ce que fait l'installateur |
|---|---|
| Activer `ufw` coupe les ports des autres applications | **N'active jamais** un pare-feu inactif ; ajoute seulement 80/443 s'il est déjà actif |
| Remplacer le Node système casse une application qui dépend d'une version précise | Réutilise le Node système s'il est ≥ 22.5, sinon pose un **Node 22 privé dans `/opt/node22`** |
| Les ports 8080/8787 sont déjà pris | Choisit automatiquement les premiers ports libres |
| Supprimer le site nginx par défaut casse un autre projet | Ne le retire que s'il est le seul activé |
| Deux vhosts pour le même domaine | Refuse de continuer et le signale |
| Écraser une configuration existante | Ne touche jamais à un `/etc/rdf-solar.env` déjà présent |

## 3. Installer

```bash
ssh root@IP_DU_VPS

apt-get update && apt-get install -y git
git clone -b claude/solar-panel-simulator-tool-2ka0yk \
  https://github.com/qentinalouviers-sys/RDF-SOLAR.git /opt/rdf-solar

bash /opt/rdf-solar/deploy/installer.sh app.mondomaine.fr vous@mondomaine.fr
```

Le script crée un utilisateur système sans shell, met en place les services, configure nginx et demande le certificat Let's Encrypt. Pour Node, il réutilise celui du système s'il est en 22.5 ou plus récent (le SaaS s'appuie sur le SQLite intégré) ; sinon il pose un Node 22 **privé** dans `/opt/node22` sans toucher au vôtre. **Il est relançable sans rien casser**, n'écrase jamais votre fichier de configuration, et n'active pas un pare-feu qui ne l'est pas déjà.

Récupérez le mot de passe du premier compte — il n'est affiché qu'une fois :

```bash
journalctl -u rdf-saas | grep -A3 'Compte administrateur'
```

Puis rendez-vous sur **`https://app.mondomaine.fr/console`**.

## 4. Ce qui tourne

| Service | Port interne | Rôle |
|---|---|---|
| `rdf-saas` | 8080 *(ou le premier libre au-dessus)* | console, widgets, pages SEO, API |
| `rdf-pvgis` | 8787 *(idem)* | proxy PVGIS (production sur données satellitaires) |
| `rdf-sauvegarde.timer` | — | sauvegarde quotidienne à 3 h 20 |

nginx écoute sur 80/443 et relaie ; rien d'autre n'est exposé. Les ports réellement retenus sont affichés en fin d'installation et notés dans `/etc/rdf-solar.env` :

```bash
grep -E '^PORT' /etc/rdf-solar.env
```

```bash
systemctl status rdf-saas
journalctl -u rdf-saas -f
```

## 5. Configuration

Tout est dans `/etc/rdf-solar.env` (droits `600`). Après modification :

```bash
systemctl restart rdf-saas
```

| Variable | Utilité |
|---|---|
| `RDF_SAAS_BASE` | URL publique — sert à fabriquer tous les liens remis aux clients |
| `RDF_SAAS_PVGIS` | déjà pointé sur votre proxy local |
| `RDF_SAAS_GOOGLE_SOLAR` | clé Google Solar, pour la détection automatique des pans |
| `RDF_PAGE_VENTE` | page de vente publique — destination des liens suivis (défaut : GitHub Pages) |
| `RDF_SUIVI_SECRET` | secret qui signe les liens suivis des messages de prospection |
| `RDF_SUIVI_PIXEL` | `1` pour activer le pixel de mesure d'ouverture — **laissez-le fermé** |
| `STRIPE_SECRET_KEY` | active l'encaissement en ligne (sinon : bon de commande) |
| `STRIPE_WEBHOOK_SECRET` | vérification des webhooks Stripe |

### Suivi des messages de prospection

`RDF_SUIVI_SECRET` doit porter **la même valeur ici et chez l'agent Hermès** : le serveur vérifie les jetons que l'agent fabrique. Sans lui, aucun lien suivi n'est produit — les messages partent avec les URL directes et rien n'est mesuré. C'est volontaire : un suivi à moitié branché qui perd les clics vaut moins que pas de suivi.

```bash
printf 'RDF_SUIVI_SECRET=%s\n' "$(openssl rand -base64 32)" >> /etc/rdf-solar.env
systemctl restart rdf-saas
```

Le pixel d'ouverture (`RDF_SUIVI_PIXEL=1`) reste fermé par défaut, et il vaut mieux le laisser ainsi : Apple Mail Privacy Protection précharge les images de tous les messages, ce qui rend l'ouverture mesurée fausse chez ces destinataires ; Gmail passe par son proxy ; un pixel émis par un domaine en cours de chauffe compte contre vous auprès des filtres ; et la CNIL considère ces pixels comme des traceurs relevant de l'article 82. Le clic, lui, est un fait, et il ne pose aucun de ces problèmes.

### Encaisser par Stripe

1. Dans le tableau de bord Stripe, récupérez la clé secrète (`sk_live_…`).
2. Créez un webhook vers `https://app.mondomaine.fr/api/public/stripe`, événement `checkout.session.completed`, et récupérez son secret de signature (`whsec_…`).
3. Renseignez les deux variables, redémarrez.

Sans ces clés, la page d'abonnement enregistre une commande « en attente » que vous validez à la main dans **Facturation** — ce qui active 12 mois. Rien ne prétend encaisser tant que Stripe n'est pas branché.

## 6. Sauvegardes

Une copie compressée par jour dans `/opt/rdf-solar/sauvegardes`, conservée 30 jours. La copie se fait par `VACUUM INTO` : elle reste **cohérente même pendant que le serveur écrit**, contrairement à un `cp` du fichier qui peut en capturer une version à moitié écrite.

```bash
# à la demande
sudo -u rdfsolar node /opt/rdf-solar/saas/tools/sauvegarde.js

# restaurer
systemctl stop rdf-saas
gunzip -c /opt/rdf-solar/sauvegardes/saas-2026-08-13T03-20-00.db.gz \
  > /opt/rdf-solar/saas/data/saas.db
chown rdfsolar:rdfsolar /opt/rdf-solar/saas/data/saas.db
systemctl start rdf-saas
```

**Rapatriez ces copies ailleurs** — une sauvegarde qui vit sur la machine qu'elle sauvegarde ne protège de rien. Depuis votre poste :

```bash
rsync -az root@IP_DU_VPS:/opt/rdf-solar/sauvegardes/ ./sauvegardes-rdf/
```

## 7. Mettre à jour

```bash
sudo bash /opt/rdf-solar/deploy/mise-a-jour.sh
```

Sauvegarde, récupération du code, **exécution des tests avant tout redémarrage**, puis redémarrage et vérification. En cas d'échec des tests ou de service qui ne répond pas, retour automatique à la version précédente.

## 8. Deux pièges à ne pas créer vous-même

**N'ajoutez pas `X-Frame-Options` dans nginx.** Tous les guides de durcissement le recommandent, mais votre produit *est* une iframe posée sur le site de vos clients : cet en-tête la bloquerait partout, chez tout le monde, d'un coup. Le contrôle se fait par `Content-Security-Policy: frame-ancestors`, que l'application pose elle-même client par client selon les domaines déclarés dans la console.

**N'ajoutez pas de `Content-Security-Policy` global** pour la même raison : il écraserait celui de l'application.

La configuration nginx fournie porte déjà les en-têtes de sécurité compatibles avec un produit embarquable.

## 9. Durcissement recommandé

Rien de spécifique au produit, mais à faire une fois :

```bash
apt-get install -y unattended-upgrades fail2ban
dpkg-reconfigure -plow unattended-upgrades
# SSH : désactivez l'authentification par mot de passe une fois votre clé en place
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
```

## 10. Vérifier que tout marche

```bash
curl -s https://app.mondomaine.fr/api/public/formules | head -c 120   # tarifs
curl -s https://app.mondomaine.fr/robots.txt                          # SEO
curl -sI https://app.mondomaine.fr/console | grep -i strict-transport # TLS
curl -s http://127.0.0.1:$(grep -oP '^PORT_PVGIS=\K\d+' /etc/rdf-solar.env)/health  # PVGIS
```

Puis, dans la console : créez un client, personnalisez-le, ouvrez « ↗ Voir le widget ». Si le simulateur s'affiche à vos couleurs, la chaîne complète fonctionne.

**Testez PVGIS une fois en ligne** : c'est le seul élément que je n'ai pas pu vérifier contre le vrai service depuis l'environnement de développement. Un `/health` qui répond et une simulation qui affiche « données PVGIS ✓ (relief inclus) » valident la chaîne.

## 11. Et la démo GitHub Pages ?

Elle reste utile comme vitrine publique : `https://qentinalouviers-sys.github.io/RDF-SOLAR/` montre le simulateur sans compte ni installation. Le VPS, lui, sert les widgets vendus. Les deux cohabitent sans se gêner.

## 12. Faire faire l'installation par un agent IA

Un prompt complet, prêt à copier, est fourni dans **[PROMPT-AGENT.md](PROMPT-AGENT.md)** : contexte, contraintes de cohabitation, étapes vérifiables, rapport attendu, procédure de retour arrière et liste d'interdits.

## 13. Passer la branche en production

L'installateur et la mise à jour suivent `claude/solar-panel-simulator-tool-2ka0yk`, la branche par défaut du dépôt : c'est elle qui porte le travail fusionné. Pour déployer autre chose ponctuellement, passez `BRANCHE=…` en variable d'environnement plutôt que de modifier les scripts.
