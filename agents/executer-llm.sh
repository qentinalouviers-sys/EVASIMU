#!/usr/bin/env bash
# Exécuteur de la flotte Hermès — travail déterministe + raisonnement DeepSeek.
#
# Tourne sous systemd (User=ubuntu) : ubuntu a accès au CLI hermes et à
# state.db, et sudo pour la partie déterministe (qui écrit le pipeline,
# propriété evasimu).
#
# Déroulé :
#   1. lit l'interrupteur (actif/pause) ;
#   2. synchro + inspection (déterministe, 0 token) ;
#   3. raisonnement DeepSeek (relit le pipeline et tranche) ;
#   4. lit la conso réelle (input+output tokens, coût USD) dans state.db ;
#   5. la remonte dans le panneau via /agent/executions.
set -euo pipefail

RACINE=/opt/evasimu
HERMES=/home/ubuntu/.local/bin/hermes
STATE_DB=/home/ubuntu/.hermes/profiles/web-dev/state.db

# Identifiants (fichier root 600 — lu par sudo)
EVASIMU_URL="$(sudo grep -oP '^EVASIMU_URL=\K.*' /etc/evasimu-prospection.env)"
EVASIMU_JETON="$(sudo grep -oP '^EVASIMU_JETON=\K.*' /etc/evasimu-prospection.env)"

# 1. Interrupteur : en pause, on ne touche à rien.
if ! curl -sS -H "Authorization: Bearer $EVASIMU_JETON" "$EVASIMU_URL/api/v1/agent/etat" | grep -q '"actif":1'; then
  echo "En pause — l'agent ne travaille pas."
  exit 0
fi

# 2. Travail déterministe (synchro + inspection), en tant que evasimu.
sudo -u evasimu env EVASIMU_URL="$EVASIMU_URL" EVASIMU_JETON="$EVASIMU_JETON" \
  /opt/node22/bin/node "$RACINE/agents/executer.js" >/tmp/agent-deterministe.log 2>&1 || true

# 3. Raisonnement DeepSeek : relit le pipeline et tranche.
"$HERMES" chat -q "Tu es l'agent de prospection EVASIMU. Analyse le fichier /opt/evasimu/data/pipeline.json (prospects inspectés). Donne un résumé factuel de 5 lignes : nombre de cibles (sans simulateur), les 3 entreprises les plus prometteuses à contacter en priorité et pourquoi (1 phrase chacune). En français, concis." \
  --source prospection --profile web-dev >/tmp/agent-raisonnement.txt 2>&1 || true

# 4. Lire la conso DeepSeek de la session qui vient de tourner.
LIGNE="$(python3 -c "
import sqlite3
db = sqlite3.connect('$STATE_DB')
r = db.execute(\"SELECT COALESCE(input_tokens,0)+COALESCE(output_tokens,0), COALESCE(estimated_cost_usd,0), COALESCE(input_tokens,0), COALESCE(output_tokens,0) FROM sessions WHERE source='prospection' ORDER BY started_at DESC LIMIT 1\").fetchone()
print(' '.join(str(x) for x in (r or (0,0,0,0))))
")"
read -r TOKENS COUT IN OUT <<< "$LIGNE"

# 5. Remonter la conso dans le panneau.
if [ "${TOKENS:-0}" -gt 0 ] 2>/dev/null; then
  curl -sS -X POST -H "Authorization: Bearer $EVASIMU_JETON" -H "Content-Type: application/json" \
    -d "{\"type\":\"raisonnement\",\"taches\":1,\"tokens\":$TOKENS,\"detail\":{\"cout_usd\":$COUT,\"input\":$IN,\"output\":$OUT}}" \
    "$EVASIMU_URL/api/v1/agent/executions" >/dev/null 2>&1 || true
  echo "Raisonnement DeepSeek : $TOKENS tokens (~$COUT USD)."
else
  echo "Aucun token DeepSeek mesuré."
fi
