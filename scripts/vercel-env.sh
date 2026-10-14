#!/usr/bin/env bash
# Carga las variables de entorno de producción en el proyecto de Vercel `willfolks-be`.
# Los valores salen de .env (claves de cadena), de un archivo con la DATABASE_URL de Neon
# y de archivos con las claves de TilcAI (opcionales). No imprime ningún secreto.
#
#   bash scripts/vercel-env.sh database_url.txt [tilcai_api_key.txt] [tilcai_relayer_key.txt]
#
# Requisitos: `vercel` con sesión iniciada y el proyecto enlazado (`vercel link`).
set -euo pipefail
cd "$(dirname "$0")/.."

SCOPE="${VERCEL_SCOPE:-will-folks}"
DB_FILE="${1:?uso: bash scripts/vercel-env.sh database_url.txt [tilcai_api_key.txt] [tilcai_relayer_key.txt]}"
TILCAI_KEY_FILE="${2:-}"
RELAYER_KEY_FILE="${3:-}"
# URL pública del túnel de ngrok; TilcAI (testnet) vive bajo /tilcai.
NGROK_BASE="${NGROK_BASE:?define NGROK_BASE con la URL pública del túnel de ngrok}"

set_var() { # nombre valor [--sensitive]
  local name="$1" value="$2" flag="${3:-}"
  # shellcheck disable=SC2086
  printf '%s' "$value" | vercel --scope "$SCOPE" env add "$name" production --force --yes $flag >/dev/null
  echo "ok  $name${flag:+ (sensitive)}"
}

from_env() { # nombre -> valor de .env
  grep -E "^$1=" .env | head -n1 | cut -d= -f2- | sed -E "s/^[\"']|[\"']\$//g"
}

# --- configuración -----------------------------------------------------------
set_var DATABASE_POOL_MAX 3
set_var UPLOADS_DIR /tmp/uploads
set_var CHAIN_SWEEP_MS 0
# AUTH_DEV_LOGIN=true: la app solo tiene inicio de sesión por correo. Cualquiera que alcance
# la API puede entrar como cualquier usuario. Solo para testnet; ponlo en false al añadir Google.
set_var AUTH_DEV_LOGIN true
set_var AI_VERIFIER_MODE auto-approve

for name in CHAIN_ENABLED CHAIN_NAME CHAIN_ID CHAIN_RPC_URL CHAIN_EXPLORER_URL USDC_ADDRESS ESCROW_ADDRESS \
            FAUCET_USDC FAUCET_GAS_MON CHAIN_GOAL_SECONDS FIAT_DEPOSIT_USDC; do
  value="$(from_env "$name" || true)"
  [ -n "$value" ] && set_var "$name" "$value"
done

# --- TilcAI (por ngrok) ------------------------------------------------------
set_var TILCAI_ENABLED true
set_var TILCAI_NETWORK testnet
set_var TILCAI_API_URL "$NGROK_BASE/tilcai"
# Relayer de OpenZeppelin (:8080) bajo /relayer. Con él, resolve/claim/reclaim salen del relayer
# de TilcAI (el veredicto lo sigue firmando este backend). El juez de IA por x402 queda apagado
# salvo que definas TILCAI_AI_JUDGE=true.
set_var TILCAI_RELAYER_URL "$NGROK_BASE/relayer"
set_var TILCAI_RELAYER_ID "${TILCAI_RELAYER_ID:-monad-testnet-relayer}"
if [ -n "$TILCAI_KEY_FILE" ]; then set_var TILCAI_API_KEY "$(tr -d '\n' < "$TILCAI_KEY_FILE")" --sensitive; fi
if [ -n "$RELAYER_KEY_FILE" ]; then set_var TILCAI_RELAYER_API_KEY "$(tr -d '\n' < "$RELAYER_KEY_FILE")" --sensitive; fi

# --- secretos ----------------------------------------------------------------
set_var DATABASE_URL "$(tr -d '\n' < "$DB_FILE")" --sensitive
set_var JWT_SECRET "$(openssl rand -hex 32)" --sensitive
set_var CRON_SECRET "$(openssl rand -hex 32)" --sensitive
for name in ATTESTOR_PRIVATE_KEY TREASURY_PRIVATE_KEY; do
  value="$(from_env "$name" || true)"
  if [ -n "$value" ]; then set_var "$name" "$value" --sensitive; else echo "FALTA $name en .env"; fi
done

echo "Listo. Despliega con: vercel --scope $SCOPE deploy --prod"
