#!/usr/bin/env bash
#
# Installation du SaaS EVASIMU sur un VPS Debian/Ubuntu (OVH ou autre).
#
#   sudo bash deploy/installer.sh app.mondomaine.fr moi@mondomaine.fr
#
# CONÇU POUR COHABITER. Sur une machine qui héberge déjà des applications, le
# script s'interdit tout ce qui pourrait les interrompre :
#
#   - il n'active JAMAIS un pare-feu inactif (cela couperait d'un coup tout
#     port non listé, y compris ceux de vos applications) ;
#   - il ne remplace pas le Node du système : si celui-ci est trop ancien, un
#     Node 22 privé est posé dans /opt/node22 et utilisé par les seuls services
#     EVASIMU ;
#   - il choisit des ports libres au lieu d'imposer 8080 et 8787 ;
#   - il ne supprime le site nginx par défaut que s'il est le seul activé ;
#   - il n'écrase jamais un /etc/evasimu.env existant.
#
# Le script est IDEMPOTENT : on peut le relancer sans rien casser.
set -euo pipefail

DOMAINE="${1:-}"
EMAIL="${2:-}"
DEPOT="${DEPOT:-https://github.com/qentinalouviers-sys/EVASIMU.git}"
# Branche de production : celle par défaut du dépôt (tout le travail y est
# fusionné). Ne pas remettre une branche de travail figée ici.
BRANCHE="${BRANCHE:-claude/solar-panel-simulator-tool-2ka0yk}"
RACINE="/opt/evasimu"
UTILISATEUR="evasimu"
NODE_MIN="22.5"

rouge() { printf '\033[31m%s\033[0m\n' "$*"; }
vert()  { printf '\033[32m%s\033[0m\n' "$*"; }
info()  { printf '\033[36m▸ %s\033[0m\n' "$*"; }
attn()  { printf '\033[33m!  %s\033[0m\n' "$*"; }

if [[ -z "$DOMAINE" ]]; then
  rouge "Usage : sudo bash deploy/installer.sh app.mondomaine.fr moi@mondomaine.fr"
  exit 1
fi
[[ $EUID -eq 0 ]] || { rouge "À lancer en root (sudo)."; exit 1; }

# --- DNS : sans cette vérification, certbot échoue et on perd dix minutes ----
info "Vérification que $DOMAINE pointe bien ici"
IP_SERVEUR="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || echo '')"
IP_DOMAINE="$(getent hosts "$DOMAINE" 2>/dev/null | awk '{print $1}' | head -1 || echo '')"
if [[ -z "$IP_DOMAINE" ]]; then
  rouge "  $DOMAINE ne résout pas. Créez l'enregistrement A avant de continuer."
  exit 1
elif [[ -n "$IP_SERVEUR" && "$IP_SERVEUR" != "$IP_DOMAINE" ]]; then
  rouge "  $DOMAINE → $IP_DOMAINE, or ce serveur est $IP_SERVEUR."
  rouge "  Corrigez l'enregistrement A, attendez la propagation, relancez."
  exit 1
else
  vert "  $DOMAINE → $IP_DOMAINE ✓"
fi

# --- Paquets : rien qui puisse perturber l'existant -------------------------
info "Paquets"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates xz-utils iproute2 >/dev/null
command -v nginx >/dev/null 2>&1 || apt-get install -y -qq nginx >/dev/null

# --- Node : sans jamais toucher à celui du système --------------------------
version_suffisante() {
  local v="$1"
  local maj="${v%%.*}" reste="${v#*.}" min="${reste%%.*}"
  [[ "$maj" -gt 22 ]] && return 0
  [[ "$maj" -eq 22 && "$min" -ge 5 ]] && return 0
  return 1
}

NODE_BIN=""
if command -v node >/dev/null 2>&1 && version_suffisante "$(node -p 'process.versions.node')"; then
  NODE_BIN="$(command -v node)"
  vert "  node $(node -v) du système — réutilisé"
elif [[ -x /opt/node22/bin/node ]]; then
  NODE_BIN=/opt/node22/bin/node
  vert "  node $(/opt/node22/bin/node -v) privé — déjà en place"
else
  # Node privé : les applications déjà installées gardent leur version.
  info "Installation d'un Node 22 privé dans /opt/node22 (le Node système n'est pas touché)"
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64) NARCH=x64 ;;
    aarch64|arm64) NARCH=arm64 ;;
    *) rouge "  Architecture non gérée : $ARCH"; exit 1 ;;
  esac
  NVER="$(curl -fsSL https://nodejs.org/dist/index.json |
    grep -oP '"version":"v22\.\d+\.\d+"' | head -1 | grep -oP 'v[\d.]+')"
  NVER="${NVER:-v22.11.0}"
  TMP="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/$NVER/node-$NVER-linux-$NARCH.tar.xz" -o "$TMP/node.tar.xz"
  rm -rf /opt/node22 && mkdir -p /opt/node22
  tar -xJf "$TMP/node.tar.xz" -C /opt/node22 --strip-components=1
  rm -rf "$TMP"
  NODE_BIN=/opt/node22/bin/node
  vert "  node $($NODE_BIN -v) installé dans /opt/node22"
fi

# --- Ports libres plutôt que ports imposés ----------------------------------
port_libre() {
  local p="$1"
  ! ss -tln 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}\$"
}
choisir_port() {
  local p="$1"
  while ! port_libre "$p"; do p=$((p + 1)); done
  echo "$p"
}
# Un port déjà utilisé PAR NOUS reste le nôtre (relance de l'installateur)
PORT_SAAS="$(grep -oP '^PORT=\K\d+' /etc/evasimu.env 2>/dev/null || true)"
PORT_PVGIS="$(grep -oP '^PORT_PVGIS=\K\d+' /etc/evasimu.env 2>/dev/null || true)"
if [[ -z "$PORT_SAAS" ]]; then PORT_SAAS="$(choisir_port 8080)"; fi
if [[ -z "$PORT_PVGIS" ]]; then PORT_PVGIS="$(choisir_port 8787)"; fi
[[ "$PORT_SAAS" == "8080" ]] || attn "port 8080 occupé — le SaaS écoutera sur $PORT_SAAS"
[[ "$PORT_PVGIS" == "8787" ]] || attn "port 8787 occupé — le proxy PVGIS écoutera sur $PORT_PVGIS"

# --- Utilisateur système, sans shell ----------------------------------------
id "$UTILISATEUR" >/dev/null 2>&1 || {
  info "Création de l'utilisateur $UTILISATEUR"
  useradd --system --home "$RACINE" --shell /usr/sbin/nologin "$UTILISATEUR"
}

# --- Code -------------------------------------------------------------------
if [[ -d "$RACINE/.git" ]]; then
  info "Mise à jour du code"
  # safe.directory : le dépôt appartient à $UTILISATEUR, git tourne en root
  git -c safe.directory="$RACINE" -C "$RACINE" fetch --quiet origin "$BRANCHE"
  git -c safe.directory="$RACINE" -C "$RACINE" checkout --quiet -B deploiement "origin/$BRANCHE"
else
  info "Récupération du code"
  git clone --quiet --branch "$BRANCHE" "$DEPOT" "$RACINE"
fi
mkdir -p "$RACINE/saas/data" "$RACINE/sauvegardes"
chown -R "$UTILISATEUR:$UTILISATEUR" "$RACINE"

# --- Configuration ----------------------------------------------------------
ENV_FICHIER="/etc/evasimu.env"
if [[ ! -f "$ENV_FICHIER" ]]; then
  info "Création de $ENV_FICHIER"
  cat > "$ENV_FICHIER" <<EOF
# Configuration du SaaS EVASIMU — après modification : systemctl restart evasimu-saas
EVASIMU_BASE=https://$DOMAINE
EVASIMU_DB=$RACINE/saas/data/saas.db
EVASIMU_ADMIN=${EMAIL:-admin@$DOMAINE}
PORT=$PORT_SAAS
PORT_PVGIS=$PORT_PVGIS

# Proxy PVGIS local : production sur données satellitaires, relief inclus
EVASIMU_PVGIS=https://$DOMAINE/api/pvgis
PVGIS_ALLOWED_ORIGIN=https://$DOMAINE

# Facultatif : détection automatique des pans de toit (clé Google Solar payante)
# EVASIMU_GOOGLE_SOLAR=

# Facultatif : encaissement en ligne. Sans ces clés, les abonnements passent en
# bon de commande, validés à la main dans la console.
# STRIPE_SECRET_KEY=
# STRIPE_WEBHOOK_SECRET=
EOF
  chmod 600 "$ENV_FICHIER"
else
  vert "  $ENV_FICHIER existe — conservé tel quel (vos secrets)"
fi

# --- Services ---------------------------------------------------------------
info "Services systemd"
poser_unite() {
  sed -e "s#@NODE_BIN@#$NODE_BIN#g" -e "s#@RACINE@#$RACINE#g" \
      -e "s#@UTILISATEUR@#$UTILISATEUR#g" -e "s#@PORT_PVGIS@#$PORT_PVGIS#g" \
      "$RACINE/deploy/$1" > "/etc/systemd/system/$1"
  chmod 644 "/etc/systemd/system/$1"
}
poser_unite evasimu-saas.service
poser_unite evasimu-pvgis.service
poser_unite evasimu-sauvegarde.service
poser_unite evasimu-maj.service
install -m 644 "$RACINE/deploy/evasimu-sauvegarde.timer" /etc/systemd/system/evasimu-sauvegarde.timer
install -m 644 "$RACINE/deploy/evasimu-maj.timer" /etc/systemd/system/evasimu-maj.timer
systemctl daemon-reload
systemctl enable --now evasimu-pvgis.service >/dev/null
systemctl enable evasimu-saas.service >/dev/null
systemctl restart evasimu-saas.service
systemctl enable --now evasimu-sauvegarde.timer >/dev/null
# Mise à jour automatique : le serveur va chercher le code, personne ne le lui
# pousse. C'est le sens qui convient à une machine sans accès entrant — aucune
# clé SSH à confier, aucun port à ouvrir. Le déploiement reste sûr parce que le
# script joue toute la suite de tests avant de redémarrer, et revient à la
# version précédente si quoi que ce soit échoue.
systemctl enable --now evasimu-maj.timer >/dev/null

# --- nginx : sans perturber les sites existants -----------------------------
info "nginx"
CONFLIT="$(grep -rl "server_name.*\b$DOMAINE\b" /etc/nginx/sites-enabled/ 2>/dev/null |
  grep -v 'evasimu' || true)"
if [[ -n "$CONFLIT" ]]; then
  rouge "  Un autre site nginx répond déjà pour $DOMAINE :"
  rouge "    $CONFLIT"
  rouge "  Choisissez un autre sous-domaine, ou retirez ce bloc, puis relancez."
  exit 1
fi
sed -e "s/DOMAINE_A_REMPLACER/$DOMAINE/g" \
    -e "s/PORT_SAAS_A_REMPLACER/$PORT_SAAS/g" \
    -e "s/PORT_PVGIS_A_REMPLACER/$PORT_PVGIS/g" \
    "$RACINE/deploy/nginx-evasimu.conf" > /etc/nginx/sites-available/evasimu
ln -sf /etc/nginx/sites-available/evasimu /etc/nginx/sites-enabled/evasimu

# Le site par défaut n'est retiré que s'il est seul : sur une machine partagée,
# il peut servir un autre projet.
NB_SITES="$(find /etc/nginx/sites-enabled -maxdepth 1 \( -type l -o -type f \) | wc -l)"
if [[ -e /etc/nginx/sites-enabled/default && "$NB_SITES" -le 2 ]]; then
  rm -f /etc/nginx/sites-enabled/default
fi
nginx -t
systemctl reload nginx
vert "  configuration valide, nginx rechargé"

# --- Pare-feu : on n'active jamais un pare-feu inactif -----------------------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | head -1 | grep -q active; then
  info "Pare-feu (déjà actif) : ouverture de 80 et 443"
  ufw allow 'Nginx Full' >/dev/null 2>&1 || { ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; }
else
  attn "Pare-feu inactif : laissé tel quel."
  attn "L'activer maintenant couperait tout port non listé, applications comprises."
  attn "Pour l'activer plus tard, listez d'abord VOS ports :"
  attn "  ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw allow <vos ports> && ufw enable"
fi

# --- TLS --------------------------------------------------------------------
if [[ -n "$EMAIL" ]]; then
  info "Certificat TLS"
  command -v certbot >/dev/null 2>&1 || apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  certbot --nginx -d "$DOMAINE" --non-interactive --agree-tos -m "$EMAIL" --redirect || {
    rouge "  Certbot a échoué — le site reste accessible en http."
    rouge "  Relancez ensuite : certbot --nginx -d $DOMAINE"
  }
else
  attn "Pas d'e-mail fourni : certificat non demandé."
  attn "Lancez : certbot --nginx -d $DOMAINE -m vous@exemple.fr --agree-tos --redirect"
fi

# --- Vérification -----------------------------------------------------------
sleep 2
info "Vérification"
ETAT=0
curl -fsS --max-time 10 "http://127.0.0.1:$PORT_SAAS/api/public/formules" >/dev/null \
  && vert "  SaaS ($PORT_SAAS) : en ligne" || { rouge "  SaaS injoignable — journalctl -u evasimu-saas -n 50"; ETAT=1; }
curl -fsS --max-time 10 "http://127.0.0.1:$PORT_PVGIS/health" >/dev/null \
  && vert "  Proxy PVGIS ($PORT_PVGIS) : en ligne" || { rouge "  Proxy PVGIS injoignable — journalctl -u evasimu-pvgis -n 50"; ETAT=1; }

echo
vert "═══════════════════════════════════════════════════════════"
vert " Console : https://$DOMAINE/console"
echo
echo " Mot de passe du premier compte (affiché une seule fois) :"
echo "   journalctl -u evasimu-saas | grep -A3 'Compte administrateur'"
echo
echo " Ports internes : SaaS $PORT_SAAS · PVGIS $PORT_PVGIS"
echo " Node utilisé   : $NODE_BIN ($($NODE_BIN -v))"
vert "═══════════════════════════════════════════════════════════"
exit $ETAT
