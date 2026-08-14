#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$(mktemp /dev/shm/askmandi-development-env.XXXXXX)"

cleanup() {
  rm -f "$env_file"
}
trap cleanup EXIT

cd "$repo_dir"
npx vercel env pull "$env_file" --yes --environment=development >/dev/null

set -a
source "$env_file"
set +a

if [[ ! "${GROQ_API_KEY:-}" =~ ^gsk_[A-Za-z0-9_-]{20,}$ ]]; then
  printf 'GROQ_API_KEY is missing or not in the expected Groq key format.\n' >&2
  exit 1
fi

env HOST="${HOST:-0.0.0.0}" PORT="${PORT:-3040}" npm run dev
