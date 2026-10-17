#!/bin/sh
# Builds libmp3lame.0.dylib, the MP3 encoder (LAME 3.100), for Wave: arm64,
# macOS 13.4 and later, the library only (no command-line tool, no decoder).
#
# Wave loads it at run time from Wave.app/Contents/Frameworks (tauri.conf.json
# bundles it there), so LAME stays a separate library that can be replaced,
# as its licence (the LGPL) asks of a program that isn't under the LGPL itself.
#
#   src-tauri/vendor/lame/build.sh [path/to/lame-3.100.tar.gz]
#
# Without a path it downloads the release from SourceForge. Either way the
# file has to match the SHA-256 below, the one Homebrew's formula pins.
set -eu

VERSION=3.100
URL="https://downloads.sourceforge.net/project/lame/lame/$VERSION/lame-$VERSION.tar.gz"
SHA256=ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

TARBALL=${1:-}
if [ -z "$TARBALL" ]; then
  TARBALL="$WORK/lame-$VERSION.tar.gz"
  curl -sSL --fail -o "$TARBALL" "$URL"
fi
echo "$SHA256  $TARBALL" | shasum -a 256 -c -

tar -xzf "$TARBALL" -C "$WORK"
cd "$WORK/lame-$VERSION"

# The export list names functions this build doesn't have: lame_init_old (gone
# from the source; Homebrew removes it too) and the decoder's (hip_*,
# lame_decode*), since Wave only encodes.
sed -i '' -E '/^(lame_init_old|hip_|lame_decode)/d' include/libmp3lame.sym

# Only the target: configure picks the optimisation (-O3), as for Homebrew.
export MACOSX_DEPLOYMENT_TARGET=13.4
CC=clang CFLAGS="-arch arm64 -mmacosx-version-min=13.4" LDFLAGS="-arch arm64 -mmacosx-version-min=13.4" \
  ./configure --disable-dependency-tracking --disable-debug --disable-frontend --disable-decoder \
              --enable-shared --disable-static --prefix=/nonexistent > "$WORK/build.log" 2>&1 \
  || { tail -30 "$WORK/build.log"; exit 1; }
# LAME 3.100 compiles with a page of warnings from today's clang; they're
# kept in the log, shown only if the build fails.
make -j"$(sysctl -n hw.ncpu)" >> "$WORK/build.log" 2>&1 || { tail -30 "$WORK/build.log"; exit 1; }

OUT="$HERE/libmp3lame.0.dylib"
cp libmp3lame/.libs/libmp3lame.0.dylib "$OUT"
# Named for where it lives in the app. Renaming voids the linker's signature,
# so sign it again (ad hoc; signing the app signs it properly).
install_name_tool -id @rpath/libmp3lame.0.dylib "$OUT"
codesign --force --sign - "$OUT"
cp COPYING LICENSE "$HERE/"

vtool -show-build "$OUT" | grep -E 'minos'
echo "Built $OUT"
