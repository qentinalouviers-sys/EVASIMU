#!/usr/bin/env bash
#
# Installation du SaaS RDF-SOLAR sur un VPS Debian/Ubuntu (OVH ou autre).
#
#   sudo bash deploy/installer.sh app.mondomaine.fr moi@mondomaine.fr
#
# Le script est IDEMPOTENT : on peut le relancer sans rien casser. Il installe
# Node 22 (nécessaire pour SQLite intégré), crée un utilisateur système sans
# shell, met en place les services systemd, configure nginx et obtient un
# certificat Let's Encrypt.
#
# Ce qu'il ne fait pas, volontairement :
#   - il ne touche pas à votre configuration SSH ;
#   - il n'ouvre aucun port autre que 22, 80 et 443 ;
#   - il n'écrase jamais un fichier .env existant (vos secrets restent à vous).
set -euo pipefail

DOMAINE="${1:-}"
EMAIL="${2:-}"
DEPOT="${DEPOT:-https://github.com/qentinalouviers-sys/RDF-SOLAR.git}"
BRANCHE="${BRANCHE:-claude/pv-simulator-french-analysis-3s4c41}"
RACINE="/opt/rdf-solar"
UTILISATEUR="rdfsolar"

rouge() { printf '\033[31m%s\033[0m\n' "$*"; }
vert()  { printf '\033[32m%s\033[0m\n' "$*"; }
info()  { printf '\033[36m▸ %s\033[0m\n' "$*"; }

if [[ -z "$DOMAINE" ]]; then
  rouge "Usage : sudo bash deploy/installer.sh app.mondomaine.fr moi@mondomaine.fr"
  rouge "Le domaine doit DÉJÀ pointer sur l'IP de ce serveur (enregistrement A)."
  exit 1
fi
if [[ $EUID -ne 0 ]]; then rouge "À lancer en root (sudo)."; exit 1; fi

# --- Vérification DNS : sans elle, certbot échoue et on perd dix minutes -----
info "Vérification que $DOMAINE pointe bien ici"
IP_SERVEUR="$(curl -fsS --max-time 10 https://api.ipify.org || echo '')"
IP_DOMAINE="$(getent hosts "$DOMAINE" | awk '{print $1}' | head -1 || echo '')"
if [[ -n "$IP_SERVEUR" && -n "$IP_DOMAINE" && "$IP_SERVEUR" != "$IP_DOMAINE" ]]; then
  rouge "  $DOMAINE pointe sur $IP_DOMAINE, or ce serveur est $IP_SERVEUR."
  rouge "  Corrigez l'enregistrement A dans l'espace client OVH, attendez la"
  rouge "  propagation, puis relancez. (Continuer maintenant fera échouer le"
  rouge "  certificat TLS.)"
  read -r -p "  Continuer quand même ? [o/N] " reponse
  [[ "$reponse" == "o" || "$reponse" == "O" ]] || exit 1
elif [[ -z "$IP_DOMAINE" ]]; then
  rouge "  $DOMAINE ne résout pas encore. Créez l'enregistrement A avant de continuer."
  exit 1
else
  vert "  $DOMAINE → $IP_DOMAINE ✓"
fi

# --- Paquets ----------------------------------------------------------------
info "Paquets système"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg nginx ufw >/dev/null

# --- Node 22 : le SaaS utilise node:sqlite, absent avant la 22.5 ------------
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".").slice(0,2).map(Number).join(".")')" < "22.5" ]]; then
  info "Installation de Node.js 22 (SQLite intégré requis)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
vert "  node $(node -v)"

# --- Utilisateur système, sans shell ----------------------------------------
if ! id "$UTILISATEUR" >/dev/null 2>&1; then
  info "Création de l'utilisateur $UTILISATEUR"
  useradd --system --home "$RACINE" --shell /usr/sbin/nologin "$UTILISATEUR"
fi

# --- Code -------------------------------------------------------------------
if [[ -d "$RACINE/.git" ]]; then
  info "Mise à jour du code"
  git -C "$RACINE" fetch --quiet origin "$BRANCHE"
  git -C "$RACINE" checkout --quiet -B deploiement "origin/$BRANCHE"
else
  info "Récupération du code"
  git clone --quiet --branch "$BRANCHE" "$DEPOT" "$RACINE"
fi
mkdir -p "$RACINE/saas/data" "$RACINE/sauvegardes"
chown -R "$UTILISATEUR:$UTILISATEUR" "$RACINE"

# --- Configuration ----------------------------------------------------------
ENV_FICHIER="/etc/rdf-solar.env"
if [[ ! -f "$ENV_FICHIER" ]]; then
  info "Création de $ENV_FICHIER"
  cat > "$ENV_FICHIER" <<EOF
# Configuration du SaaS RDF-SOLAR — modifiable, puis : systemctl restart rdf-saas
RDF_SAAS_BASE=https://$DOMAINE
RDF_SAAS_DB=$RACINE/saas/data/saas.db
RDF_SAAS_ADMIN=${EMAIL:-admin@$DOMAINE}
PORT=8080

# Proxy PVGIS local (production sur données satellitaires, relief inclus)
RDF_SAAS_PVGIS=https://$DOMAINE/api/pvgis
PVGIS_ALLOWED_ORIGIN=https://$DOMAINE

# Facultatif : détection automatique des pans de toit (clé Google Solar payante)
# RDF_SAAS_GOOGLE_SOLAR=

# Facultatif : encaissement en ligne. Sans ces clés, les abonnements passent
# en bon de commande et sont validés à la main dans la console.
# STRIPE_SECRET_KEY=
# STRIPE_WEBHOOK_SECRET=
EOF
  chmod 600 "$ENV_FICHIER"
else
  vert "  $ENV_FICHIER existe déjà — laissé intact (vos secrets)"
fi

# --- Services ---------------------------------------------------------------
info "Services systemd"
install -m 644 "$RACINE/deploy/rdf-saas.service" /etc/systemd/system/rdf-saas.service
install -m 644 "$RACINE/deploy/rdf-pvgis.service" /etc/systemd/system/rdf-pvgis.service
install -m 644 "$RACINE/deploy/rdf-sauvegarde.service" /etc/systemd/system/rdf-sauvegarde.service
install -m 644 "$RACINE/deploy/rdf-sauvegarde.timer" /etc/systemd/system/rdf-sauvegarde.timer
systemctl daemon-reload
systemctl enable --now rdf-pvgis.service >/dev/null
systemctl restart rdf-saas.service
systemctl enable rdf-saas.service >/dev/null
systemctl enable --now rdf-sauvegarde.timer >/dev/null

# --- nginx ------------------------------------------------------------------
info "nginx"
sed "s/DOMAINE_A_REMPLACER/$DOMAINE/g" "$RACINE/deploy/nginx-rdf-solar.conf" \
  > /etc/nginx/sites-available/rdf-solar
ln -sf /etc/nginx/sites-available/rdf-solar /etc/nginx/sites-enabled/rdf-solar
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# --- Pare-feu ---------------------------------------------------------------
info "Pare-feu"
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 'Nginx Full' >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true

# --- TLS --------------------------------------------------------------------
if [[ -n "$EMAIL" ]]; then
  info "Certificat TLS (Let's Encrypt)"
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  certbot --nginx -d "$DOMAINE" --non-interactive --agree-tos -m "$EMAIL" --redirect || {
    rouge "  Certbot a échoué. Le site reste accessible en http.";
    rouge "  Vérifiez le DNS puis relancez : certbot --nginx -d $DOMAINE"
  }
else
  rouge "  Pas d'e-mail fourni : certificat TLS non demandé."
  rouge "  Lancez ensuite : certbot --nginx -d $DOMAINE -m vous@exemple.fr --agree-tos"
fi

# --- Vérification -----------------------------------------------------------
sleep 2
info "Vérification"
if curl -fsS --max-time 10 "http://127.0.0.1:8080/api/public/formules" >/dev/null; then
  vert "  SaaS : en ligne"
else
  rouge "  SaaS injoignable — journalctl -u rdf-saas -n 50"
fi
if curl -fsS --max-time 10 "http://127.0.0.1:8787/health" >/dev/null; then
  vert "  Proxy PVGIS : en ligne"
else
  rouge "  Proxy PVGIS injoignable — journalctl -u rdf-pvgis -n 50"
fi

echo
vert "═══════════════════════════════════════════════════════════"
vert " Console : https://$DOMAINE/console"
echo
echo " Le mot de passe du premier compte administrateur n'est"
echo " affiché qu'une fois, dans le journal du service :"
echo
echo "   journalctl -u rdf-saas | grep -A3 'Compte administrateur'"
echo
vert "═══════════════════════════════════════════════════════════"
