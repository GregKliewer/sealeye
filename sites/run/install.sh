#!/bin/sh
# seaLeye.run installer: https://sealeye.run/install
#   curl -fsSL https://sealeye.run/install | sh
# Installs the sealeye command from this site, with exactly the libraries the release
# was tested with: the package carries the tested lock file (npm-shrinkwrap.json), which
# a global npm install ignores, so the package is unpacked into a folder of its own,
# installed there with npm ci, and that folder is put on the PATH with npm. Nothing
# else is changed. (Oct 21, 2026: a library released after the lock file broke 2.46.0's
# command on every machine that installed it.)
set -eu

VERSION="{{VERSION}}"
# The tests install a package they packed themselves.
PACKAGE="${SEALEYE_INSTALL_PACKAGE:-https://sealeye.run/sealeye-${VERSION}.tgz}"
HOME_DIR="${SEALEYE_HOME:-$HOME/.sealeye}"
COMMANDS="$HOME_DIR/command"
DIR="$COMMANDS/$VERSION"

say() { printf '  %s\n' "$1"; }
fail() { printf '\n  %s\n\n' "$1" >&2; exit 1; }

echo
say "Installing sealeye ${VERSION}"

command -v node >/dev/null 2>&1 || fail "sealeye needs Node.js 20 or later, and node is not installed. Get it from https://nodejs.org, then run this again."
command -v npm >/dev/null 2>&1 || fail "sealeye installs with npm, which comes with Node.js, and npm is not on your PATH."

MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$MAJOR" -ge 20 ] 2>/dev/null || fail "sealeye needs Node.js 20 or later, and this is Node.js $(node -v). Update it from https://nodejs.org, then run this again."

command -v curl >/dev/null 2>&1 || fail "sealeye downloads with curl, which is not on your PATH."
command -v tar >/dev/null 2>&1 || fail "sealeye unpacks with tar, which is not on your PATH."

# Unpacked and installed beside its final place, then moved in whole, so a half-made
# copy is never the one on the PATH.
mkdir -p "$COMMANDS"
WORK="$(mktemp -d "$COMMANDS/.install.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
curl -fsSL "$PACKAGE" -o "$WORK/sealeye.tgz" || fail "Could not download sealeye ${VERSION} from ${PACKAGE}."
tar -xzf "$WORK/sealeye.tgz" -C "$WORK"
[ -f "$WORK/package/npm-shrinkwrap.json" ] || fail "This package of sealeye ${VERSION} has no record of the libraries it was tested with, so it was not installed. Tell your platform team."
if ! ( cd "$WORK/package" && npm ci --omit=dev --no-audit --no-fund --loglevel=error ); then
  fail "npm could not install the libraries sealeye needs. The message above says why."
fi
rm -rf "$DIR"
mv "$WORK/package" "$DIR"

if ! npm install -g --no-audit --no-fund --loglevel=error "$DIR"; then
  fail "npm could not put sealeye on your PATH. If the message above says EACCES, your global npm folder needs administrator rights: set a folder of your own with 'npm config set prefix ~/.npm-global', add ~/.npm-global/bin to your PATH, and run this again."
fi

# Earlier versions' folders: the one on the PATH now is this one.
for old in "$COMMANDS"/*; do
  [ -d "$old" ] && [ "$old" != "$DIR" ] && rm -rf "$old"
done

command -v sealeye >/dev/null 2>&1 || fail "sealeye is installed but not on your PATH. Add $(npm prefix -g)/bin to your PATH."

echo
say "Done. Sign in with the token your platform team gave you, then run it in your app's folder:"
echo
say "  sealeye login"
say "  sealeye run"
echo
