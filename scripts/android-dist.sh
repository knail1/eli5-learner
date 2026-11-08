#!/usr/bin/env bash
# Copy the Android release APK to release/android/ and verify it (spec/tech/16 §11, acceptance 6):
# print its signing certificates, and fail if the APK contains anything shaped like a secret or an
# OAuth client ID. Build it first: (cd android && ./gradlew :app:assembleRelease).
# Usage: scripts/android-dist.sh [--help]
set -euo pipefail

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
apk_in="$root/android/app/build/outputs/apk/release/app-release.apk"
out_dir="$root/release/android"
apk_out="$out_dir/eli5-learner-release.apk"

if [[ ! -f "$apk_in" ]]; then
  echo "android-dist: no release APK at android/app/build/outputs/apk/release/; run ./gradlew :app:assembleRelease in android/ first" >&2
  exit 1
fi

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/opt/homebrew/share/android-commandlinetools}}"
build_tools="$(ls -d "$sdk"/build-tools/* 2>/dev/null | sort -V | tail -n 1 || true)"
if [[ -z "$build_tools" || ! -x "$build_tools/apksigner" ]]; then
  echo "android-dist: apksigner not found under $sdk/build-tools; install build-tools with sdkmanager" >&2
  exit 1
fi

mkdir -p "$out_dir"
cp "$apk_in" "$apk_out"

echo "== Signature"
"$build_tools/apksigner" verify --print-certs "$apk_out" | grep -E 'Signer.*certificate (DN|SHA-256 digest|SHA-1 digest)|^Verified using v[23] ' || true
"$build_tools/apksigner" verify "$apk_out"
if "$build_tools/apksigner" verify --print-certs "$apk_out" | grep -q 'CN=Android Debug'; then
  # A fresh clone falls back to the debug key (16 §11). Such an APK cannot later be updated in place
  # by one signed with the release key, so say so loudly.
  echo "android-dist: WARNING: signed with the debug key; set the ELI5_ANDROID_* properties (android/SETUP.md) for a release key" >&2
fi

echo "== Secret scan"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
unzip -q -o "$apk_out" -d "$work/apk"
# Resource strings may be stored as UTF-16 inside resources.arsc; aapt2 prints them decoded.
"$build_tools/aapt2" dump strings "$apk_out" >"$work/strings.txt" 2>/dev/null || true

# Same shapes as scripts/check-hygiene.ts and the publish scanner, plus any OAuth client host and
# private keys. Patterns are split so this script never matches itself.
patterns=(
  'GOCSPX''-[A-Za-z0-9_-]{20,}'
  'apps''\.googleusercontent\.com'
  'sk-ant''-[A-Za-z0-9_-]{20,}'
  'sk-''(proj-)?[A-Za-z0-9_-]{32,}'
  'AIza''[0-9A-Za-z_-]{35}'
  '1//''0[0-9A-Za-z_-]{30,}'
  'ya29''\.[0-9A-Za-z_-]{20,}'
  '-----BEGIN [A-Z ]*PRIVATE ''KEY-----'
)
hits=0
for p in "${patterns[@]}"; do
  if LC_ALL=C grep -r -a -l -E -e "$p" "$work/apk" "$work/strings.txt" >"$work/hit" 2>/dev/null; then
    echo "android-dist: secret-shaped content ($p) in: $(sed "s#$work/##" "$work/hit" | tr '\n' ' ')" >&2
    hits=$((hits + 1))
  fi
done
if [[ $hits -gt 0 ]]; then
  rm -f "$apk_out"
  echo "android-dist: FAILED ($hits pattern(s) matched); the APK was not kept" >&2
  exit 1
fi
echo "No secret-shaped content."

echo "== Done"
echo "release/android/eli5-learner-release.apk ($(du -h "$apk_out" | cut -f1 | tr -d ' '))"
echo "Install: adb install -r release/android/eli5-learner-release.apk"
