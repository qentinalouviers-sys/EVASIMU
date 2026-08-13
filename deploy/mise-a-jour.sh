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
BRANCHE="${BRANCHE:-claude/pv-simulator-french-analysis-3s4c41}"

rouge() { printf '\033[31m%s\033[0m\n' "$*"; }
vert()  { printf '\033[32m%s\033[0m\n' "$*"; }
info()  { printf '\033[36m▸ %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { rouge "À lancer en root (sudo)."; exit 1; }

info "Sauvegarde de la base avant toute chose"
sudo -u rdfsolar env "RDF_SAAS_DB=${RDF_SAAS_DB:-$RACINE/saas/data/saas.db}" \
  node "$RACINE/saas/tools/sauvegarde.js" "$RACINE/sauvegardes"

AVANT="$(git -C "$RACINE" rev-parse HEAD)"
info "Version actuelle : ${AVANT:0:8}"

info "Récupération"
git -C "$RACINE" fetch --quiet origin "$BRANCHE"
git -C "$RACINE" checkout --quiet -B deploiement "origin/$BRANCHE"
APRES="$(git -C "$RACINE" rev-parse HEAD)"

if [[ "$AVANT" == "$APRES" ]]; then vert "Déjà à jour (${APRES:0:8})."; exit 0; fi
info "Nouvelle version : ${APRES:0:8}"

info "Tests avant redémarrage"
if ! (cd "$RACINE" && node tests/engine.test.js >/dev/null && \
      node tests/pvgis-proxy.test.js >/dev/null && node tests/saas.test.js >/dev/null); then
  rouge "Tests en échec — retour à ${AVANT:0:8}, le service n'a pas été touché."
  git -C "$RACINE" checkout --quiet -B deploiement "$AVANT"
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
  git -C "$RACINE" checkout --quiet -B deploiement "$AVANT"
  chown -R rdfsolar:rdfsolar "$RACINE"
  systemctl restart rdf-saas
  rouge "Journal : journalctl -u rdf-saas -n 50"
  exit 1
fi
