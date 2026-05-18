#!/usr/bin/env bash
set -euo pipefail

store="tecompany-dev.myshopify.com"
env_file="${ENV_FILE:-.env.local}"
clean_first=1
localhost=0

usage() {
  cat <<'EOF'
Usage: npm run dev:store [-- --no-clean | --localhost]

Starts Shopify app dev against tecompany-dev.myshopify.com.

Options:
  --no-clean   Skip cleaning Shopify's previous dev preview first.
  --localhost  Use Shopify CLI localhost mode instead of a Cloudflare tunnel.
               This requires a one-time localhost HTTPS certificate setup.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --no-clean)
      clean_first=0
      ;;
    --localhost)
      localhost=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

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

if [[ "$clean_first" -eq 1 ]]; then
  npx shopify app dev clean --store "$store" || true
fi

args=(--store "$store")
if [[ "$localhost" -eq 1 ]]; then
  args+=(--use-localhost)
fi

npm run dev -- "${args[@]}"
