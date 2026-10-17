# LAME, Wave's MP3 encoder

Wave writes MP3 with **LAME 3.100** (https://lame.sourceforge.io), which is
licensed under the GNU Lesser General Public License, version 2 or later
(`COPYING`; LAME's own notes are in `LICENSE`). macOS can't write MP3 itself.

LAME is the separate library `libmp3lame.0.dylib`, in
`Wave.app/Contents/Frameworks`. Wave loads it only when you export an MP3
(`src-tauri/src/lame.rs`), so you can replace it with your own build of LAME.
A signed copy of Wave only loads libraries signed by the same developer: after
replacing it, sign the app again (for yourself, `codesign --force --deep -s - Wave.app`).

## Source and build

- Source: `lame-3.100.tar.gz` from
  https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz
  (SHA-256 `ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e`,
  the checksum Homebrew pins).
- Built by `build.sh` in this folder: arm64, macOS 13.4 and later, the library
  only (no command-line tool, no decoder), with configure's own optimisation.
- One change to the source: the library's export list
  (`include/libmp3lame.sym`) drops `lame_init_old`, which the source no longer
  has (Homebrew drops it too), and the decoder's functions (`hip_*`,
  `lame_decode*`), since this build leaves the decoder out.

To rebuild: `src-tauri/vendor/lame/build.sh [path/to/lame-3.100.tar.gz]`. It
downloads the release if no path is given, checks the checksum, and replaces
`libmp3lame.0.dylib` here.

Anyone distributing Wave should offer this source (the tarball above, with
`build.sh`) alongside it, as the LGPL asks.
