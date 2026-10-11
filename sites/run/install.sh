#!/bin/sh
# seaLeye.run installer: https://sealeye.run/install
#   curl -fsSL https://sealeye.run/install | sh
# Installs the sealeye command with npm, from this site. Nothing else is changed.
set -eu

VERSION="{{VERSION}}"
PACKAGE="https://sealeye.run/sealeye-${VERSION}.tgz"

say() { printf '  %s\n' "$1"; }
fail() { printf '\n  %s\n\n' "$1" >&2; exit 1; }

echo
say "Installing sealeye ${VERSION}"

command -v node >/dev/null 2>&1 || fail "sealeye needs Node.js 20 or later, and node is not installed. Get it from https://nodejs.org, then run this again."
command -v npm >/dev/null 2>&1 || fail "sealeye installs with npm, which comes with Node.js, and npm is not on your PATH."

MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$MAJOR" -ge 20 ] 2>/dev/null || fail "sealeye needs Node.js 20 or later, and this is Node.js $(node -v). Update it from https://nodejs.org, then run this again."

if ! npm install -g --no-audit --no-fund --loglevel=error "$PACKAGE"; then
  fail "npm could not install it. If the message above says EACCES, your global npm folder needs administrator rights: set a folder of your own with 'npm config set prefix ~/.npm-global', add ~/.npm-global/bin to your PATH, and run this again."
fi

command -v sealeye >/dev/null 2>&1 || fail "sealeye is installed but not on your PATH. Add $(npm prefix -g)/bin to your PATH."

echo
say "Done. Sign in with the token your platform team gave you, then run it in your app's folder:"
echo
say "  sealeye login"
say "  sealeye run"
echo
