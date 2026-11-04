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
#
# The app and the DMG are signed with a Developer ID and notarized by Apple, so
# Wave opens without a warning. That needs:
#   - the Developer ID Application certificate in the login keychain (Xcode →
#     Settings → Accounts → Manage Certificates → + → Developer ID Application);
#   - an App Store Connect API key (Users and Access → Integrations → Team Keys,
#     Developer access), its file at ~/.appstoreconnect/private_keys/AuthKey_<KEY ID>.p8,
#     and APPLE_API_KEY=<KEY ID> APPLE_API_ISSUER=<Issuer ID> in the environment.
#
# WAVE_UNNOTARIZED=1 keeps the existing Gatekeeper "Open Anyway" flow.
# WAVE_PUBLISH=1 skips the terminal confirmation when publication is already authorized.
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

# Developer ID and notarization are the default. A deliberately unnotarized
# release still requires the configured updater key: installed apps verify it.
if [[ "${WAVE_UNNOTARIZED:-0}" == "1" ]]; then
  IDENTITY="-"
  echo "Building with ad-hoc app signing; users will need macOS Open Anyway."
else
IDENTITY="${APPLE_SIGNING_IDENTITY:-$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)}"
[[ -n "$IDENTITY" ]] || die "no Developer ID Application certificate in the keychain (Xcode → Settings → Accounts → Manage Certificates → + → Developer ID Application)"
[[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_ISSUER:-}" ]] \
  || die "set APPLE_API_KEY (the key's ID) and APPLE_API_ISSUER (the Issuer ID), from App Store Connect → Users and Access → Integrations"
APPLE_API_KEY_PATH="${APPLE_API_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_$APPLE_API_KEY.p8}"
[[ -f "$APPLE_API_KEY_PATH" ]] || die "no API key file at $APPLE_API_KEY_PATH"
export APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
NOTARY=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER")
xcrun notarytool history "${NOTARY[@]}" >/dev/null 2>&1 \
  || die "Apple's notary service didn't accept the API key: check APPLE_API_KEY, APPLE_API_ISSUER and the key file"
fi

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

echo "Wave $CURRENT → $VERSION, signed by $IDENTITY"

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
# Tauri signs the app with the Developer ID and the hardened runtime (which
# notarization requires), has Apple notarize it, staples the ticket, and only
# then packs the DMG and the update, so both carry the notarized app.
CONFIG=$(node -p 'JSON.stringify({ bundle: { createUpdaterArtifacts: true, macOS: { signingIdentity: process.argv[1], hardenedRuntime: process.argv[2] !== "1" } } })' "$IDENTITY" "${WAVE_UNNOTARIZED:-0}")
CI=true bunx tauri build --config "$CONFIG"
BUNDLE=src-tauri/target/release/bundle
APP="$BUNDLE/macos/Wave.app"
DMG="$BUNDLE/dmg/Wave_${VERSION}_aarch64.dmg"
UPDATE="$BUNDLE/macos/Wave.app.tar.gz"
[[ -f "$DMG" && -f "$UPDATE" && -f "$UPDATE.sig" ]] || die "the build didn't produce the DMG and the signed update"
codesign --verify --deep --strict "$APP" || die "the app's signature doesn't verify"
if [[ "${WAVE_UNNOTARIZED:-0}" != "1" ]]; then
codesign -dv "$APP" 2>&1 | grep -q '^CodeDirectory.*flags=.*runtime' || die "the app wasn't signed with the hardened runtime"
xcrun stapler validate -q "$APP" || die "the app has no notarization ticket: did Tauri notarize it? (its log says why not)"
spctl --assess --type execute "$APP" || die "Gatekeeper refuses the app"
# The hardened runtime loads only libraries signed by the same team: LAME must
# be, or MP3 export fails.
TEAM=$(codesign -dv "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p')
LAME_TEAM=$(codesign -dv "$APP/Contents/Frameworks/libmp3lame.0.dylib" 2>&1 | sed -n 's/^TeamIdentifier=//p')
[[ -n "$TEAM" && "$TEAM" == "$LAME_TEAM" ]] || die "LAME isn't signed by the app's team ($TEAM), so MP3 export would fail"

# The DMG is notarized too, and the ticket stapled to it, so it opens without a
# warning even offline.
codesign --verify "$DMG" 2>/dev/null || codesign --force --timestamp --sign "$IDENTITY" "$DMG"
echo "Notarizing the DMG (usually a few minutes)…"
SUBMISSION=$(xcrun notarytool submit "$DMG" "${NOTARY[@]}" --wait --output-format json)
STATUS=$(node -p 'JSON.parse(process.argv[1]).status' "$SUBMISSION")
[[ "$STATUS" == "Accepted" ]] || die "Apple didn't notarize the DMG ($STATUS). Why: xcrun notarytool log $(node -p 'JSON.parse(process.argv[1]).id' "$SUBMISSION") --key … --key-id … --issuer …"
xcrun stapler staple -q "$DMG"
spctl --assess --type open --context context:primary-signature "$DMG" || die "Gatekeeper refuses the DMG"
fi

# 3. The new signing key uses its own feed. Keep the original feed at 1.1.0
# so older copies do not offer a package they cannot authenticate.
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
  fs.writeFileSync(`${out}/latest-v2.json`, JSON.stringify(manifest, null, 2) + "\n");
  const legacy = fs.readFileSync("release-notes/legacy-updater.json", "utf8");
  const previous = JSON.parse(legacy);
  if (previous.version !== "1.1.0" || previous.platforms["darwin-aarch64"].url !== `https://github.com/${repo}/releases/download/v1.1.0/Wave.app.tar.gz`) {
    throw new Error("The legacy update feed must remain pinned to Wave 1.1.0");
  }
  fs.writeFileSync(`${out}/latest.json`, legacy);
' "$VERSION" "$NOTES" "$UPDATE.sig" "$OUT" "$REPO"

# The GitHub release page also tells first-time downloaders how to install,
# which the in-app notes leave out.
SHA=$(shasum -a 256 "$OUT/Wave_${VERSION}_aarch64.dmg" | cut -d' ' -f1)
{
  cat "$NOTES"
  cat <<INSTALL

### Install

Wave runs on Macs with Apple Silicon (M1 or later) and macOS 13.4 or later.

1. Open \`Wave_${VERSION}_aarch64.dmg\` and drag Wave to Applications.
2. Open Wave and choose **Whisper** (1.6 GB) or **Parakeet v3** (681 MB) in Settings.

**Updating from 1.1.0:** install this DMG manually once. Wave 1.2.0 uses a replacement updater signing key; after this installation, future releases can update automatically again. Your projects and downloaded models stay in place.

MP3 export uses LAME 3.100, bundled as a separate library under the LGPL. Its source is at https://sourceforge.net/projects/lame/files/lame/3.100/

SHA-256 of the DMG: \`$SHA\`
INSTALL
} > "$OUT/release-notes.md"
if [[ "${WAVE_UNNOTARIZED:-0}" == "1" ]]; then
  cat >> "$OUT/release-notes.md" <<'INSTALL'

### First launch on macOS

This release has a signed in-app update but is not notarized by Apple. If macOS blocks the first launch, open System Settings → Privacy & Security and choose Open Anyway, then confirm.
INSTALL
fi

# 4. Try it, then commit, tag, push, publish.
echo
if [[ "${WAVE_UNNOTARIZED:-0}" == "1" ]]; then
  echo "Built with signed updater (not notarized): $OUT"
else
  echo "Built and notarized: $OUT"
fi
echo "Try $OUT/Wave_${VERSION}_aarch64.dmg now if you like (open it, drag Wave to Applications, open it)."
if [[ "${WAVE_PUBLISH:-0}" == "1" ]]; then ANSWER=y;
else read -r -p "Publish Wave $VERSION? [y/N] " ANSWER; fi
if [[ ! "$ANSWER" =~ ^[yY] ]]; then
  git checkout -- package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
  echo "Not published. The build stays in $OUT, and the version is back at $CURRENT."
  exit 0
fi
git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
git commit -q -m "Wave $VERSION"
git tag "v$VERSION"
git push -q origin main "v$VERSION"
gh release create "v$VERSION" --repo "$REPO" --title "Wave $VERSION" --notes-file "$OUT/release-notes.md" \
  "$OUT/Wave_${VERSION}_aarch64.dmg" "$OUT/Wave.app.tar.gz" "$OUT/Wave.app.tar.gz.sig" "$OUT/latest-v2.json" "$OUT/latest.json"

echo "Published https://github.com/$REPO/releases/tag/v$VERSION"
echo "Wave 1.1.0 requires one manual installation; 1.2.0 and later use the new signed update feed."
