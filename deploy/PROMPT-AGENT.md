# Prompt à donner à un agent IA pour le déploiement

Copiez tout ce qui suit la ligne de séparation et donnez-le à l'agent qui a accès au VPS et à l'espace OVH. Remplacez les trois valeurs entre `⟨ ⟩` avant l'envoi.

---

## Mission

Tu déploies le SaaS **EVASIMU** (simulateur photovoltaïque vendu en marque blanche à des installateurs) sur un VPS OVH qui **héberge déjà d'autres applications en production**.

**La contrainte absolue : ne rien interrompre de ce qui tourne déjà.** Un agent Hermès et probablement d'autres services fonctionnent sur cette machine. Toute coupure de leur part est un échec de la mission, même si le SaaS finit par marcher. En cas de doute entre « avancer » et « ne pas risquer l'existant », tu ne risques pas l'existant : tu t'arrêtes et tu demandes.

## Paramètres

| | |
|---|---|
| Domaine | `eviatek.fr` (zone DNS gérée chez OVH) |
| Sous-domaine à créer | `app.eviatek.fr` |
| E-mail (Let's Encrypt + compte admin) | ⟨VOTRE_EMAIL⟩ |
| VPS | ⟨IP_DU_VPS⟩, accès root en SSH |
| Dépôt | `https://github.com/qentinalouviers-sys/EVASIMU.git` |
| Branche | `main` |

Le sous-domaine apparaîtra dans tous les liens remis aux clients (`https://app.eviatek.fr/w/xxx.js` posé sur leur site) : il ne devra plus changer ensuite.

## Étape 1 — État des lieux, avant toute modification

```bash
ssh root@⟨IP_DU_VPS⟩
apt-get update && apt-get install -y git
git clone -b main \
  https://github.com/qentinalouviers-sys/EVASIMU.git /opt/evasimu
bash /opt/evasimu/deploy/diagnostic.sh
```

Ce script **ne modifie rien**. Reporte-moi sa sortie intégrale, puis vérifie ces cinq points et signale-les :

1. **Version de Node** — le SaaS a besoin de ≥ 22.5 (il utilise le SQLite intégré à Node). Si le Node système est plus ancien, **ne le mets pas à jour** : une autre application en dépend peut-être. L'installateur posera un Node 22 privé dans `/opt/node22` et n'utilisera celui-là que pour les services EVASIMU.
2. **Ports 80, 443, 8080, 8787** — s'ils sont occupés, note par quoi. L'installateur choisira automatiquement des ports libres pour ses services internes, mais 80 et 443 doivent revenir à nginx.
3. **nginx** — s'il est déjà installé et sert d'autres sites, relève leurs `server_name`. Si l'un d'eux répond déjà pour `app.eviatek.fr`, arrête-toi et préviens-moi.
4. **`X-Frame-Options`** dans la configuration nginx existante — voir l'avertissement à l'étape 6, c'est important.
5. **Pare-feu** — si `ufw` est inactif, **ne l'active pas**. L'activer sur une machine en service couperait d'un coup tout port non explicitement autorisé, y compris ceux de l'agent Hermès.

## Étape 2 — DNS chez OVH

Dans la zone DNS de `eviatek.fr`, crée :

| Type | Sous-domaine | Cible |
|---|---|---|
| A | `app` | l'IPv4 du VPS |
| AAAA *(seulement si le VPS a une IPv6)* | `app` | l'IPv6 du VPS |

**Ne touche à aucun autre enregistrement** : les MX, TXT, SPF/DKIM et les entrées existantes doivent rester intactes. Si un enregistrement `app` existe déjà, arrête-toi et signale-le-moi.

Attends la propagation avant de continuer :

```bash
dig +short app.eviatek.fr    # doit renvoyer l'IPv4 du VPS
```

L'installateur refuse de démarrer si le DNS ne correspond pas — c'est volontaire, cela évite un échec de certificat dix minutes plus tard.

## Étape 3 — Installation

```bash
bash /opt/evasimu/deploy/installer.sh app.eviatek.fr ⟨VOTRE_EMAIL⟩
```

Le script est idempotent (relançable sans risque) et conçu pour cohabiter :

- il n'active jamais un pare-feu inactif ;
- il ne remplace pas le Node du système ;
- il choisit des ports libres au lieu d'imposer les siens ;
- il ne supprime le site nginx par défaut que s'il est le seul activé ;
- il refuse de continuer si un autre vhost répond déjà pour ce domaine ;
- il n'écrase jamais un `/etc/evasimu.env` existant.

Il installe : un utilisateur système `evasimu` sans shell, trois unités systemd durcies (`evasimu-saas`, `evasimu-pvgis`, sauvegarde quotidienne), un vhost nginx, et le certificat Let's Encrypt.

## Étape 4 — Récupérer le mot de passe administrateur

Il n'est affiché qu'une seule fois, au premier démarrage :

```bash
journalctl -u evasimu-saas | grep -A3 'Compte administrateur'
```

Transmets-le-moi **par un canal sûr**, et ne le laisse pas traîner dans un fichier de log ou un historique de conversation partagé.

## Étape 5 — Vérifications

```bash
# Les services EVASIMU
systemctl is-active evasimu-saas evasimu-pvgis
curl -s https://app.eviatek.fr/api/public/formules | head -c 200
curl -sI https://app.eviatek.fr/console | head -5
curl -s https://app.eviatek.fr/robots.txt

# Le proxy PVGIS, y compris son appel réel au service européen
curl -s http://127.0.0.1:$(grep -oP '^PORT_PVGIS=\K\d+' /etc/evasimu.env)/health
curl -s "http://127.0.0.1:$(grep -oP '^PORT_PVGIS=\K\d+' /etc/evasimu.env)/api/pvgis?lat=49.216&lon=1.156&angle=35&aspect=0"
```

Le dernier appel est le seul point que je n'ai jamais pu tester en conditions réelles : le réseau de mon environnement de développement bloque `re.jrc.ec.europa.eu`. **Rapporte-moi sa réponse exacte.** Attendu : un JSON contenant `kwhPerKwc` (de l'ordre de 1 100 à 1 400 pour la Normandie) et douze valeurs mensuelles. Si tu obtiens un 502, rapporte le message : PVGIS a peut-être changé son schéma de réponse, ce qui se corrige côté code — le simulateur continue entre-temps avec son moteur embarqué, sans panne visible.

**Et surtout : vérifie que tout ce qui tournait avant tourne encore.**

```bash
systemctl list-units --type=service --state=running --no-pager
```

Compare avec la liste du diagnostic de l'étape 1. Toute différence est à signaler immédiatement.

## Étape 6 — Deux pièges à ne pas créer

**N'ajoute jamais `X-Frame-Options` dans la configuration nginx**, ni dans le vhost EVASIMU, ni globalement. Tous les guides de durcissement le recommandent — et ici ce serait fatal : le produit **est** une iframe posée sur le site des clients. Cet en-tête la bloquerait partout, chez tout le monde, d'un coup. Le contrôle d'intégration est déjà assuré par `Content-Security-Policy: frame-ancestors`, que l'application pose client par client selon les domaines déclarés.

Si le diagnostic a révélé un `X-Frame-Options` **global** (dans `nginx.conf` ou un fichier inclus partout), signale-le-moi : il faudra le neutraliser sur ce vhost précis sans y toucher pour les autres sites.

**N'ajoute pas non plus de `Content-Security-Policy` globale** : elle écraserait celle de l'application.

## Étape 7 — Rapport

Rends-moi :

1. la sortie du diagnostic (étape 1) ;
2. les ports finalement retenus et le chemin du Node utilisé (fin de sortie de l'installateur) ;
3. le mot de passe administrateur, par canal sûr ;
4. le résultat de l'appel PVGIS réel ;
5. la confirmation que les services préexistants tournent toujours ;
6. tout ce que tu as dû décider toi-même, avec la raison.

## Si quelque chose échoue

- **Certbot échoue** → le site reste en http, ce n'est pas bloquant. Vérifie le DNS, puis `certbot --nginx -d app.eviatek.fr`.
- **`evasimu-saas` ne démarre pas** → `journalctl -u evasimu-saas -n 50`. Cause la plus probable : Node trop ancien (message parlant de `node:sqlite`).
- **`nginx -t` échoue** → n'applique rien, rapporte l'erreur. La configuration précédente reste active.
- **Une application préexistante tombe** → c'est prioritaire sur tout le reste. `systemctl restart <service>`, et rapporte-moi ce qui s'est passé avant de reprendre.

Pour tout revenir en arrière proprement :

```bash
systemctl disable --now evasimu-saas evasimu-pvgis evasimu-sauvegarde.timer
rm -f /etc/systemd/system/evasimu-{saas,pvgis,sauvegarde}.{service,timer}
rm -f /etc/nginx/sites-enabled/evasimu /etc/nginx/sites-available/evasimu
systemctl daemon-reload && nginx -t && systemctl reload nginx
# /opt/evasimu, /etc/evasimu.env et /opt/node22 peuvent rester : ils ne
# gênent rien. La base de données est dans /opt/evasimu/saas/data/.
```

## Interdits

- Modifier la configuration SSH.
- Activer ou reconfigurer le pare-feu.
- Mettre à jour ou remplacer le Node du système.
- Toucher aux autres vhosts nginx, aux autres services systemd, ou aux enregistrements DNS existants.
- Redémarrer le serveur.
- `apt-get upgrade` global (les paquets nécessaires sont installés un par un par l'installateur).
- Inventer un résultat : si une commande n'a pas été exécutée ou a échoué, dis-le.
