#!/usr/bin/env bash
# Build ELI5 Learner into an unsigned macOS app and dmg in release/ (01 §8.3).
# Usage: scripts/build.sh [--check] [--clean] [--open] [--help]
set -euo pipefail

usage() {
  cat <<'EOF'
Build ELI5 Learner for this Mac (unsigned .app and .dmg in release/).

Usage: scripts/build.sh [options]

Options:
  --check   run typecheck, lint and unit tests before building
  --clean   delete out/, build/ and release/ first
  --open    open the built app when done
  --help    show this help

Output:
  release/mac-<arch>/ELI5 Learner.app   the app, runnable as is
  release/ELI5 Learner-<version>-<arch>.dmg   the installer (drag to Applications)

Unsigned builds: on first launch macOS may block the app. Open System Settings >
Privacy & Security and click "Open Anyway".
EOF
}

check=0
clean=0
open_app=0
for arg in "$@"; do
  case "$arg" in
    --check) check=1 ;;
    --clean) clean=1 ;;
    --open) open_app=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "build.sh: unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

# Run from the repository root, wherever the script is called from.
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build.sh: macOS is required to build the app" >&2
  exit 1
fi

# Node 22.12+ (Electron's installer needs it; see README).
if ! command -v node >/dev/null 2>&1; then
  echo "build.sh: node not found; install Node.js 22.12 or newer" >&2
  exit 1
fi
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)'; then
  echo "build.sh: Node $(node -v) is too old; need 22.12 or newer" >&2
  exit 1
fi

# Install dependencies when missing or older than the lockfile.
if [[ ! -d node_modules || package-lock.json -nt node_modules/.package-lock.json ]]; then
  echo "==> Installing dependencies (npm ci)"
  npm ci
fi

if ((clean)); then
  echo "==> Cleaning out/, build/ and release/"
  rm -rf out build release
fi

if ((check)); then
  echo "==> Checks: typecheck, lint, unit tests"
  npm run typecheck
  npm run lint
  npm test
fi

arch="$(node -p process.arch)"
echo "==> Building the unsigned $arch app (npm run package:$arch)"
if [[ "$arch" == "arm64" ]]; then
  npm run package:arm64
else
  CSC_IDENTITY_AUTO_DISCOVERY=false npm run package
fi

version="$(node -p 'require("./package.json").version')"
app="release/mac-$arch/ELI5 Learner.app"
dmg="release/ELI5 Learner-$version-$arch.dmg"
[[ "$arch" == "x64" ]] && app="release/mac/ELI5 Learner.app"

echo
echo "Built:"
[[ -d "$app" ]] && echo "  app: $PWD/$app"
[[ -f "$dmg" ]] && echo "  dmg: $PWD/$dmg"

if ((open_app)) && [[ -d "$app" ]]; then
  open "$app"
fi
