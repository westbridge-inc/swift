#!/usr/bin/env bash
# Open the Swift Command control app (Mission Control) with the right Node.
#
#   bash ~/swift/scripts/command.sh
#
# Vite 7 needs Node >= 20.19. If your shell's default Node is older (e.g. 18),
# this quietly picks a 20/22 from nvm so you don't have to think about it.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

has_node20() { command -v node >/dev/null 2>&1 && node -e 'process.exit(parseInt(process.versions.node,10) >= 20 ? 0 : 1)' 2>/dev/null; }

if ! has_node20; then
  # Prefer nvm's default resolution, then fall back to the newest 20/22 on disk.
  # shellcheck disable=SC1090
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 && nvm use >/dev/null 2>&1 || true
  if ! has_node20; then
    for v in "$HOME"/.nvm/versions/node/v22.* "$HOME"/.nvm/versions/node/v20.* ; do
      [ -x "$v/bin/node" ] && export PATH="$v/bin:$PATH" && break
    done
  fi
fi

if ! has_node20; then
  echo "Swift Command needs Node 20.19+ and I couldn't find one."
  echo "Fix it once with:  nvm install 20 && nvm use 20"
  exit 1
fi

echo "Using Node $(node -v). Starting Swift Command…"
echo "When it's ready it prints a http://localhost link — open that in your browser and sign in with an admin account."
cd "$ROOT/apps/desktop"
exec pnpm dev
