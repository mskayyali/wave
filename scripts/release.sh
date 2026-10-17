#!/usr/bin/env bash
# Publishes a new version of Wave: the DMG for new users, and a signed update
# that copies of Wave already installed pick up on their own.
#
#   scripts/release.sh 1.1.0 notes.md
#
# notes.md is what's new, in Markdown: it becomes the GitHub release notes, and
# Wave shows it when it offers the update.
#
# Needs the updater's private key (made once with
# `bunx tauri signer generate -w ~/.tauri/wave-updater.key`). Its password is
# read from TAURI_SIGNING_PRIVATE_KEY_PASSWORD, or asked for. Never commit the key.
set -euo pipefail

VERSION="${1:-}"
NOTES="${2:-}"
REPO="mskayyali/wave"
KEY="${WAVE_UPDATER_KEY:-$HOME/.tauri/wave-updater.key}"

die() { echo "release: $*" >&2; exit 1; }

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "give the version as X.Y.Z, e.g. scripts/release.sh 1.1.0 notes.md"
[[ -f "$NOTES" ]] || die "give a Markdown file with what's new as the second argument"
[[ -f "$KEY" ]] || die "no updater key at $KEY (make one with: bunx tauri signer generate -w $KEY)"
command -v gh >/dev/null || die "the GitHub CLI (gh) is needed"
command -v bun >/dev/null || die "bun is needed"

cd "$(dirname "$0")/.."
[[ "$(git branch --show-current)" == "main" ]] || die "release from main"
[[ -z "$(git status --porcelain)" ]] || die "commit or stash your changes first"
git fetch -q origin main
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || die "main isn't in step with GitHub; pull or push first"
git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null && die "v$VERSION already exists"

CURRENT=$(node -p "require('./package.json').version")
[[ "$(printf '%s\n%s\n' "$CURRENT" "$VERSION" | sort -V | tail -1)" == "$VERSION" && "$CURRENT" != "$VERSION" ]] \
  || die "$VERSION isn't newer than $CURRENT"

# The public half goes into the app, which checks every update against it.
# Installed copies only accept updates signed by the key they were built with.
PUBKEY=$(cat "$KEY.pub" 2>/dev/null) || die "no public key at $KEY.pub"
CONFIGURED=$(node -p "require('./src-tauri/tauri.conf.json').plugins.updater.pubkey")
if [[ -z "$CONFIGURED" ]]; then
  node -e '
    const fs = require("fs"), f = "src-tauri/tauri.conf.json";
    const conf = JSON.parse(fs.readFileSync(f, "utf8"));
    conf.plugins.updater.pubkey = process.argv[1];
    fs.writeFileSync(f, JSON.stringify(conf, null, 2) + "\n");
  ' "$PUBKEY"
  echo "Added the updater's public key to tauri.conf.json"
elif [[ "$CONFIGURED" != "$PUBKEY" ]]; then
  die "$KEY isn't the key Wave was built with: installed copies would refuse this update"
fi

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+set}" ]]; then
  read -r -s -p "Password for the updater key: " TAURI_SIGNING_PRIVATE_KEY_PASSWORD; echo
fi
export TAURI_SIGNING_PRIVATE_KEY="$KEY" TAURI_SIGNING_PRIVATE_KEY_PASSWORD

echo "Wave $CURRENT → $VERSION"

# 1. The version, in the three places it lives.
node -e '
  const fs = require("fs"), v = process.argv[1];
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  pkg.version = v;
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  const toml = fs.readFileSync("src-tauri/Cargo.toml", "utf8");
  fs.writeFileSync("src-tauri/Cargo.toml", toml.replace(/^version = ".*"$/m, `version = "${v}"`));
' "$VERSION"
(cd src-tauri && cargo update -q -p wave --precise "$VERSION" 2>/dev/null || cargo metadata -q --format-version 1 >/dev/null)

# 2. Build: the app, the DMG, and the update (Wave.app.tar.gz and its signature).
CI=true bunx tauri build --config '{"bundle":{"createUpdaterArtifacts":true}}'
BUNDLE=src-tauri/target/release/bundle
DMG="$BUNDLE/dmg/Wave_${VERSION}_aarch64.dmg"
UPDATE="$BUNDLE/macos/Wave.app.tar.gz"
[[ -f "$DMG" && -f "$UPDATE" && -f "$UPDATE.sig" ]] || die "the build didn't produce the DMG and the signed update"
codesign --verify --deep --strict "$BUNDLE/macos/Wave.app" || die "the app's signature doesn't verify"

# 3. latest.json: what installed copies read to find the update.
OUT="$BUNDLE/release"
rm -rf "$OUT" && mkdir -p "$OUT"
cp "$DMG" "$UPDATE" "$UPDATE.sig" "$OUT/"
node -e '
  const fs = require("fs");
  const [version, notesFile, sigFile, out, repo] = process.argv.slice(1);
  const notes = fs.readFileSync(notesFile, "utf8").trim();
  const signature = fs.readFileSync(sigFile, "utf8").trim();
  const url = `https://github.com/${repo}/releases/download/v${version}/Wave.app.tar.gz`;
  const manifest = { version, notes, pub_date: new Date().toISOString(), platforms: { "darwin-aarch64": { signature, url } } };
  fs.writeFileSync(`${out}/latest.json`, JSON.stringify(manifest, null, 2) + "\n");
' "$VERSION" "$NOTES" "$UPDATE.sig" "$OUT" "$REPO"

# 4. Commit, tag, push, publish.
git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
git commit -q -m "Wave $VERSION"
git tag "v$VERSION"
git push -q origin main "v$VERSION"
gh release create "v$VERSION" --repo "$REPO" --title "Wave $VERSION" --notes-file "$NOTES" \
  "$OUT/Wave_${VERSION}_aarch64.dmg" "$OUT/Wave.app.tar.gz" "$OUT/Wave.app.tar.gz.sig" "$OUT/latest.json"

echo "Published https://github.com/$REPO/releases/tag/v$VERSION"
echo "Copies of Wave $CURRENT or later will offer the update the next time they check."
