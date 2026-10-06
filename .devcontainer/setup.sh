#!/usr/bin/env bash
# One-time setup for GitHub Codespaces (or any dev container): installs Postgres, the npm
# dependencies, a dev database with the schema, and a mock-mode .env.local. No Google,
# OpenAI or Supabase credentials are needed.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Installing PostgreSQL"
sudo apt-get update -y -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql postgresql-client >/dev/null
sudo service postgresql start
sudo -u postgres psql -qc "ALTER USER postgres PASSWORD 'postgres';"

echo "==> Installing npm dependencies"
npm ci --no-audit --no-fund

echo "==> Creating the gaas_dev database"
TEST_DATABASE_NAME=gaas_dev ./scripts/test-db.sh >/dev/null

if [ ! -f .env.local ]; then
  # Codespaces serves port 3000 at https://<codespace>-3000.<forwarding domain>.
  if [ -n "${CODESPACE_NAME:-}" ]; then
    APP_URL="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  else
    APP_URL="http://localhost:3000"
  fi
  rand() { node -e "console.log(require('crypto').randomBytes($1).toString('$2'))"; }
  cat > .env.local <<EOF
APP_URL=${APP_URL}
AUTH_MODE=local
GOOGLE_PROVIDER_MODE=mock
OPENAI_MODE=mock
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/gaas_dev
TOKEN_ENCRYPTION_KEY=$(rand 32 base64)
CRON_SECRET=$(rand 32 hex)
EOF
  echo "==> Wrote .env.local (APP_URL=${APP_URL})"
fi

echo
echo "Setup complete. Start the app with:  npm run dev"
echo "Run the test suite with:            npm test"
