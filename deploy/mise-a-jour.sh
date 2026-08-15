#!/usr/bin/env bash
#
# Mise à jour du SaaS en place, avec sauvegarde et retour arrière possible.
#
#   sudo bash /opt/evasimu/deploy/mise-a-jour.sh
#
# Les tests tournent AVANT le redémarrage : si quelque chose casse, le service
# en cours n'est pas touché et le code revient à la version précédente.
set -euo pipefail

# Bash lit un script au fil de son exécution, par décalage d'octets. Or ce
# script fait un `git checkout` qui réécrit… ce fichier même. Si sa taille
# change, l'interpréteur reprend sa lecture à un décalage devenu faux et exécute
# une ligne coupée en deux. On se recopie donc hors du dépôt avant d'y toucher.
if [[ "${EVASIMU_MAJ_COPIE:-}" != "1" ]]; then
  COPIE="$(mktemp /tmp/evasimu-maj-XXXXXX.sh)"
  cat "$0" > "$COPIE"
  EVASIMU_MAJ_COPIE=1 exec bash "$COPIE" "$@"
fi
# Ne pas laisser EVASIMU_MAJ_COPIE fuiter dans l'environnement des enfants :
# `npm test` l'hériterait et le test de recopie croirait la copie déjà faite.
unset EVASIMU_MAJ_COPIE
trap 'rm -f "$0"' EXIT

RACINE="${RACINE:-/opt/evasimu}"
# Branche de production : celle par défaut du dépôt, qui porte tout le travail
# fusionné. L'ancienne valeur pointait sur une branche figée 13 commits en
# arrière : une mise à jour ramenait du code périmé sans rien signaler.
BRANCHE="${BRANCHE:-claude/solar-panel-simulator-tool-2ka0yk}"

# Le dépôt appartient à `evasimu` (le chown de fin de script s'en assure),
# mais git tourne ici en root : sans cette déclaration, git refuse d'ouvrir le
# dépôt (« detected dubious ownership »). On la porte sur chaque appel plutôt
# que d'écrire dans le ~/.gitconfig de root, qui est un effet de bord durable.
depot() { git -c safe.directory="$RACINE" -C "$RACINE" "$@"; }

rouge() { printf '\033[31m%s\033[0m\n' "$*"; }
vert()  { printf '\033[32m%s\033[0m\n' "$*"; }
info()  { printf '\033[36m▸ %s\033[0m\n' "$*"; }
attn()  { printf '\033[33m⚠ %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { rouge "À lancer en root (sudo)."; exit 1; }

# En mode silencieux (minuterie systemd), on ne dit rien quand il n'y a rien à
# faire : sinon le journal se remplit de « déjà à jour » toutes les dix minutes
# et plus personne ne lit les vraies alertes.
SILENCIEUX="${SILENCIEUX:-0}"
[[ "${1:-}" == "--silencieux" ]] && SILENCIEUX=1
discret() { [[ "$SILENCIEUX" == "1" ]] || info "$@"; }

# On regarde AVANT de toucher à quoi que ce soit s'il y a seulement quelque
# chose à faire. L'ordre précédent sauvegardait la base à chaque exécution, y
# compris quand rien n'avait changé : acceptable pour une commande lancée à la
# main, ingérable pour une minuterie — 144 sauvegardes par jour.
AVANT="$(depot rev-parse HEAD)"
discret "Version actuelle : ${AVANT:0:8}"
discret "Recherche de nouveautés sur $BRANCHE"
if ! depot fetch --quiet origin "$BRANCHE" 2>/dev/null; then
  rouge "Impossible de joindre le dépôt (réseau ? droits ?) — rien n'a été modifié."
  exit 1
fi
CIBLE="$(depot rev-parse "origin/$BRANCHE")"
if [[ "$AVANT" == "$CIBLE" ]]; then
  [[ "$SILENCIEUX" == "1" ]] || vert "Déjà à jour (${AVANT:0:8})."
  exit 0
fi
info "Nouveauté : ${AVANT:0:8} → ${CIBLE:0:8}"

info "Sauvegarde de la base avant de toucher au code"
sudo -u evasimu env "EVASIMU_DB=${EVASIMU_DB:-$RACINE/saas/data/saas.db}" \
  node "$RACINE/saas/tools/sauvegarde.js" "$RACINE/sauvegardes"

# Un arbre de déploiement doit être conforme au dépôt : une retouche faite sur
# le serveur (essai, correctif à chaud) bloque le checkout et fait échouer la
# mise à jour. On ne la perd pas pour autant — elle est archivée en patch avant
# d'être effacée, et reste rejouable avec « git apply ».
if ! depot diff --quiet HEAD -- 2>/dev/null; then
  PATCH="$RACINE/sauvegardes/modifications-locales-$(date +%Y-%m-%dT%H-%M-%S).patch"
  mkdir -p "$RACINE/sauvegardes"
  depot diff HEAD > "$PATCH" 2>/dev/null || true
  attn "Modifications locales détectées sur des fichiers suivis :"
  depot diff --name-only HEAD | sed 's/^/      /'
  info "Archivées dans $PATCH"
  depot reset --quiet --hard HEAD
  info "Arbre remis conforme au dépôt (vos fichiers non suivis — base, config/local.js — sont intacts)"
fi

depot checkout --quiet -B deploiement "origin/$BRANCHE"
APRES="$(depot rev-parse HEAD)"

info "Tests avant redémarrage"
# `npm test` suit package.json : une suite ajoutée est couverte sans toucher
# ici. Les tests utilisent une base en mémoire, la vôtre n'est jamais ouverte.
if ! (cd "$RACINE" && npm test >/dev/null 2>&1); then
  rouge "Tests en échec — retour à ${AVANT:0:8}, le service n'a pas été touché."
  depot checkout --quiet -B deploiement "$AVANT"
  exit 1
fi
vert "  tests au vert"

chown -R evasimu:evasimu "$RACINE"

# Les unités systemd font partie du code livré. Sans cette étape, une minuterie
# ajoutée au dépôt arrive bien sur le disque mais n'est jamais enregistrée : le
# fichier existe, rien ne le lit, et l'on cherche longtemps pourquoi. Les
# gabarits du dépôt font autorité — c'est déjà l'installeur qui les pose.
NODE_BIN="$(grep -oP '^ExecStart=\K\S+' /etc/systemd/system/evasimu-saas.service 2>/dev/null || true)"
if [[ -n "$NODE_BIN" && -x "$NODE_BIN" ]]; then
  UTILISATEUR="$(grep -oP '^User=\K\S+' /etc/systemd/system/evasimu-saas.service 2>/dev/null || echo evasimu)"
  PORT_PVGIS="$(grep -oP '^PORT_PVGIS=\K\d+' /etc/evasimu.env 2>/dev/null || echo 8787)"
  for u in evasimu-saas.service evasimu-pvgis.service evasimu-sauvegarde.service evasimu-maj.service; do
    [[ -f "$RACINE/deploy/$u" ]] || continue
    sed -e "s#@NODE_BIN@#$NODE_BIN#g" -e "s#@RACINE@#$RACINE#g" \
        -e "s#@UTILISATEUR@#$UTILISATEUR#g" -e "s#@PORT_PVGIS@#$PORT_PVGIS#g" \
        "$RACINE/deploy/$u" > "/etc/systemd/system/$u"
  done
  for t in evasimu-sauvegarde.timer evasimu-maj.timer; do
    [[ -f "$RACINE/deploy/$t" ]] && install -m 644 "$RACINE/deploy/$t" "/etc/systemd/system/$t"
  done
  systemctl daemon-reload
  systemctl enable --now evasimu-maj.timer >/dev/null 2>&1 || true
  info "Unités systemd à jour (mise à jour automatique activée)"
else
  # Sans interpréteur identifiable, réécrire les unités reviendrait à casser le
  # service pour le plaisir : on laisse en l'état et on le dit.
  attn "Interpréteur node introuvable dans evasimu-saas.service — unités laissées telles quelles."
fi

info "Redémarrage"
systemctl restart evasimu-saas evasimu-pvgis
sleep 2

# Le port n'est pas toujours 8080 : quand il est déjà pris à l'installation,
# l'installeur en choisit un autre et l'écrit dans /etc/evasimu.env. Interroger
# 8080 en dur revenait à sonder l'application du voisin — un 404 déclenchait
# alors un retour arrière alors que le service allait parfaitement bien.
PORT_SAAS="$(grep -oP '^PORT=\K\d+' /etc/evasimu.env 2>/dev/null || true)"
PORT_SAAS="${PORT_SAAS:-8080}"
SONDE="http://127.0.0.1:$PORT_SAAS/api/public/formules"
info "Vérification sur le port $PORT_SAAS"

if CODE="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$SONDE" 2>/dev/null)" && [[ "$CODE" == "200" ]]; then
  vert "En ligne sur ${APRES:0:8}."
else
  rouge "Le service ne répond pas correctement sur $SONDE (HTTP ${CODE:-aucune réponse}) — retour à ${AVANT:0:8}."
  depot checkout --quiet -B deploiement "$AVANT"
  chown -R evasimu:evasimu "$RACINE"
  systemctl restart evasimu-saas
  rouge "Journal : journalctl -u evasimu-saas -n 50"
  exit 1
fi
