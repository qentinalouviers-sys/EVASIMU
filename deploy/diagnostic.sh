#!/usr/bin/env bash
#
# État des lieux d'un VPS AVANT installation. Ne modifie rien.
#
#   bash deploy/diagnostic.sh
#
# À lancer en premier sur une machine qui héberge déjà autre chose : le
# rapport dit précisément ce qui occupe la place et ce que l'installateur
# devra contourner.
set -uo pipefail

titre() { printf '\n\033[1;36m── %s\033[0m\n' "$*"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; }
attn()  { printf '  \033[33m!\033[0m %s\n' "$*"; }
info()  { printf '    %s\n' "$*"; }

echo "═══ Diagnostic RDF-SOLAR — $(date -Is) ═══"

titre "Système"
info "$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"
info "noyau $(uname -r) · $(nproc) cœur(s) · $(free -m | awk '/^Mem:/{print $2}') Mo de RAM"
info "disque : $(df -h / | awk 'NR==2{print $4" libres sur "$2}')"

titre "Node.js"
if command -v node >/dev/null 2>&1; then
  V="$(node -p 'process.versions.node')"
  MAJ="$(node -p 'Number(process.versions.node.split(".")[0])')"
  MIN="$(node -p 'Number(process.versions.node.split(".")[1])')"
  if [[ "$MAJ" -gt 22 || ( "$MAJ" -eq 22 && "$MIN" -ge 5 ) ]]; then
    ok "node $V (système) — convient, SQLite intégré disponible"
  else
    attn "node $V (système) — INSUFFISANT (il faut ≥ 22.5 pour node:sqlite)"
    info "L'installateur posera un Node 22 privé dans /opt/node22 sans toucher"
    info "à celui-ci : les applications déjà en place ne bougeront pas."
  fi
  info "chemin : $(command -v node)"
else
  attn "node absent — un Node 22 privé sera installé dans /opt/node22"
fi

titre "Ports occupés"
if command -v ss >/dev/null 2>&1; then
  ss -tlnp 2>/dev/null | awk 'NR>1{print "    "$4"  "$6}' | sed 's/users:((//; s/))//' | sort -u
  for P in 80 443 8080 8787; do
    if ss -tln 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$P\$"; then
      attn "port $P déjà pris"
    else
      ok "port $P libre"
    fi
  done
else
  attn "ss indisponible — installez iproute2 pour l'inventaire des ports"
fi

titre "Services actifs (hors système)"
systemctl list-units --type=service --state=running --no-legend --no-pager 2>/dev/null |
  awk '{print $1}' | grep -viE '^(systemd|dbus|cron|rsyslog|ssh|getty|networkd|resolved|udev|polkit|apparmor|unattended)' |
  sed 's/^/    /' | head -30

titre "nginx"
if command -v nginx >/dev/null 2>&1; then
  ok "installé — $(nginx -v 2>&1 | sed 's/nginx version: //')"
  if [[ -d /etc/nginx/sites-enabled ]]; then
    N="$(find /etc/nginx/sites-enabled -type l -o -type f | wc -l)"
    info "$N site(s) activé(s) :"
    for f in /etc/nginx/sites-enabled/*; do
      [[ -e "$f" ]] || continue
      NOMS="$(grep -hoP 'server_name\s+\K[^;]+' "$f" 2>/dev/null | tr '\n' ' ')"
      info "  - $(basename "$f") → ${NOMS:-(aucun server_name)}"
    done
  fi
  grep -rhoP 'X-Frame-Options[^;]*' /etc/nginx/ 2>/dev/null | head -3 | while read -r l; do
    attn "X-Frame-Options trouvé dans la configuration nginx : « $l »"
    info "Cet en-tête empêcherait le widget de s'afficher chez vos clients."
    info "Il devra être retiré du bloc concerné, ou neutralisé sur ce vhost."
  done
else
  ok "non installé — l'installateur s'en chargera"
fi

titre "Pare-feu"
if command -v ufw >/dev/null 2>&1; then
  ETAT="$(ufw status 2>/dev/null | head -1)"
  info "$ETAT"
  if [[ "$ETAT" == *inactive* ]]; then
    attn "ufw est INACTIF. L'installateur ne l'activera pas :"
    info "l'activer sur une machine déjà en service couperait tout port"
    info "non explicitement autorisé — y compris ceux de vos applications."
  else
    ufw status numbered 2>/dev/null | sed 's/^/    /' | head -20
  fi
else
  info "ufw non installé"
fi
if command -v iptables >/dev/null 2>&1; then
  N="$(iptables -S 2>/dev/null | grep -c '^-A' || echo 0)"
  info "iptables : $N règle(s)"
fi

titre "Certificats existants"
if [[ -d /etc/letsencrypt/live ]]; then
  find /etc/letsencrypt/live -maxdepth 1 -mindepth 1 -type d -printf '    %f\n' 2>/dev/null
else
  info "aucun"
fi

titre "Installation RDF-SOLAR"
if [[ -d /opt/rdf-solar ]]; then
  attn "/opt/rdf-solar existe déjà — l'installateur mettra à jour"
  [[ -f /opt/rdf-solar/saas/data/saas.db ]] && info "base présente : $(du -h /opt/rdf-solar/saas/data/saas.db | cut -f1)"
else
  ok "aucune installation antérieure"
fi
[[ -f /etc/rdf-solar.env ]] && attn "/etc/rdf-solar.env existe — il sera conservé tel quel"

titre "Cohabitation : qui est à nous, qui ne l’est pas"
# La question qu'on se pose vraiment devant un VPS partagé : « si je lance la
# mise à jour, qu'est-ce qui bouge ? ». Cette section y répond nommément.
NOTRES=""
for U in rdf-saas rdf-pvgis rdf-sauvegarde.timer; do
  if systemctl list-unit-files --no-legend --no-pager 2>/dev/null | grep -q "^$U"; then
    ETAT="$(systemctl is-active "$U" 2>/dev/null || echo inconnu)"
    ok "$U — $ETAT   (à nous)"
    NOTRES="$NOTRES $U"
  fi
done
[[ -z "$NOTRES" ]] && info "aucun service RDF-SOLAR installé"

AUTRES="$(systemctl list-units --type=service --state=running --no-legend --no-pager 2>/dev/null |
  awk '{print $1}' |
  grep -viE '^(systemd|dbus|cron|rsyslog|ssh|getty|networkd|resolved|udev|polkit|apparmor|unattended|snapd|multipathd|irqbalance|chrony|ntp|packagekit|accounts-daemon|uuidd|atd|acpid|qemu|walinuxagent|cloud)' |
  grep -v '^rdf-' || true)"
if [[ -n "$AUTRES" ]]; then
  echo
  attn "Autres applications sur cette machine :"
  echo "$AUTRES" | sed 's/^/      /'
  echo
  info "La mise à jour ne redémarre QUE rdf-saas et rdf-pvgis."
  info "Elle ne touche ni à ces services, ni à leurs fichiers, ni à leurs bases."
elif [[ -n "$NOTRES" ]]; then
  echo
  info "Aucune autre application détectée : la machine n’héberge que RDF-SOLAR."
else
  echo
  info "Aucune application détectée — ni RDF-SOLAR, ni autre chose."
fi

echo
echo "═══ Fin du diagnostic — aucune modification effectuée ═══"
