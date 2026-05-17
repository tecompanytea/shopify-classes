#!/usr/bin/env bash
set -euo pipefail

store="${1:-tecompany-dev.myshopify.com}"
env_file="${ENV_FILE:-.env.local}"

if [[ ! -f "$env_file" ]]; then
  echo "Missing $env_file. Create it from .env.example or pull it from Vercel first." >&2
  exit 1
fi

set -a
source "$env_file"
set +a

# Let Shopify CLI inject the active dev tunnel URL. A Vercel URL here can make
# Vite reject the current tunnel host during embedded app preview.
unset SHOPIFY_APP_URL

npm run dev -- --store "$store"
