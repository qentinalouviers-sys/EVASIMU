#!/usr/bin/env bash
#
# Mise à jour du SaaS en place, avec sauvegarde et retour arrière possible.
#
#   sudo bash /opt/rdf-solar/deploy/mise-a-jour.sh
#
# Les tests tournent AVANT le redémarrage : si quelque chose casse, le service
# en cours n'est pas touché et le code revient à la version précédente.
set -euo pipefail

RACINE="${RACINE:-/opt/rdf-solar}"
# Branche de production : celle par défaut du dépôt, qui porte tout le travail
# fusionné. L'ancienne valeur pointait sur une branche figée 13 commits en
# arrière : une mise à jour ramenait du code périmé sans rien signaler.
BRANCHE="${BRANCHE:-claude/solar-panel-simulator-tool-2ka0yk}"

# Le dépôt appartient à `rdfsolar` (le chown de fin de script s'en assure),
# mais git tourne ici en root : sans cette déclaration, git refuse d'ouvrir le
# dépôt (« detected dubious ownership »). On la porte sur chaque appel plutôt
# que d'écrire dans le ~/.gitconfig de root, qui est un effet de bord durable.
depot() { git -c safe.directory="$RACINE" -C "$RACINE" "$@"; }

rouge() { printf '\033[31m%s\033[0m\n' "$*"; }
vert()  { printf '\033[32m%s\033[0m\n' "$*"; }
info()  { printf '\033[36m▸ %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { rouge "À lancer en root (sudo)."; exit 1; }

info "Sauvegarde de la base avant toute chose"
sudo -u rdfsolar env "RDF_SAAS_DB=${RDF_SAAS_DB:-$RACINE/saas/data/saas.db}" \
  node "$RACINE/saas/tools/sauvegarde.js" "$RACINE/sauvegardes"

AVANT="$(depot rev-parse HEAD)"
info "Version actuelle : ${AVANT:0:8}"

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

info "Récupération"
depot fetch --quiet origin "$BRANCHE"
depot checkout --quiet -B deploiement "origin/$BRANCHE"
APRES="$(depot rev-parse HEAD)"

if [[ "$AVANT" == "$APRES" ]]; then vert "Déjà à jour (${APRES:0:8})."; exit 0; fi
info "Nouvelle version : ${APRES:0:8}"

info "Tests avant redémarrage"
# `npm test` suit package.json : une suite ajoutée est couverte sans toucher
# ici. Les tests utilisent une base en mémoire, la vôtre n'est jamais ouverte.
if ! (cd "$RACINE" && npm test >/dev/null 2>&1); then
  rouge "Tests en échec — retour à ${AVANT:0:8}, le service n'a pas été touché."
  depot checkout --quiet -B deploiement "$AVANT"
  exit 1
fi
vert "  tests au vert"

chown -R rdfsolar:rdfsolar "$RACINE"
info "Redémarrage"
systemctl restart rdf-saas rdf-pvgis
sleep 2

if curl -fsS --max-time 10 http://127.0.0.1:8080/api/public/formules >/dev/null; then
  vert "En ligne sur ${APRES:0:8}."
else
  rouge "Le service ne répond pas — retour à ${AVANT:0:8}."
  depot checkout --quiet -B deploiement "$AVANT"
  chown -R rdfsolar:rdfsolar "$RACINE"
  systemctl restart rdf-saas
  rouge "Journal : journalctl -u rdf-saas -n 50"
  exit 1
fi
