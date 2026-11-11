#!/bin/sh
# Download a clean Waddle checkout and install a small-server launcher.
set -eu

REPO='wuzzynizzy/Waddle'
REF=${WADDLE_REF:-main}
DEST=${WADDLE_HOME:-"${HOME:?HOME must be set}/.local/share/waddle"}

if ! command -v node >/dev/null 2>&1; then
  echo 'Waddle needs Node.js 20 or newer. Install Node, then run this installer again.' >&2
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1; then
  echo "Waddle needs Node.js 20 or newer; found $(node --version)." >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
  echo 'Waddle installer needs curl and tar.' >&2
  exit 1
fi
case "$REF" in
  ''|*[!A-Za-z0-9._/-]*|*..*) echo 'WADDLE_REF must be a branch name.' >&2; exit 1 ;;
esac
case "$DEST" in
  /*) ;;
  *) echo 'WADDLE_HOME must be an absolute path.' >&2; exit 1 ;;
esac
case "$DEST" in
  //*) echo 'WADDLE_HOME must not use a double-slash path.' >&2; exit 1 ;;
esac
case "$DEST" in
  /|/root|/home|/usr|/usr/local|/opt|/etc|/var|/bin|/sbin|/lib|/lib64|/boot|/dev|/proc|/sys)
    echo 'Choose a dedicated install directory for WADDLE_HOME.' >&2
    exit 1
    ;;
esac

TMP=$(mktemp -d "${TMPDIR:-/tmp}/waddle-install.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$TMP/source" "$DEST"
DEST=$(CDPATH= cd "$DEST" && pwd -P)
case "$DEST" in
  /|/root|/home|/usr|/usr/local|/opt|/etc|/var|/bin|/sbin|/lib|/lib64|/boot|/dev|/proc|/sys)
    echo 'Choose a dedicated install directory for WADDLE_HOME.' >&2
    exit 1
    ;;
esac
if [ -d "$HOME" ] && [ "$DEST" = "$(CDPATH= cd "$HOME" && pwd -P)" ]; then
  echo 'Choose a dedicated install directory for WADDLE_HOME, not your home directory.' >&2
  exit 1
fi
ARCHIVE_URL="https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF"
printf 'Fetching Waddle (%s) from GitHub…\n' "$REF"
curl --fail --location --silent --show-error --retry 2 --connect-timeout 15 "$ARCHIVE_URL" -o "$TMP/source.tar.gz"
tar -xzf "$TMP/source.tar.gz" --strip-components=1 -C "$TMP/source"
cp -R "$TMP/source/." "$DEST/"

cat > "$DEST/run-waddle.sh" <<'RUNNER'
#!/bin/sh
set -eu
cd "$(dirname "$0")"
export WADDLE_PROFILE="${WADDLE_PROFILE:-small}"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=320}"
exec node server.js
RUNNER
chmod +x "$DEST/run-waddle.sh"

printf '\nWaddle is installed in %s\n' "$DEST"
printf 'Start it with: "%s/run-waddle.sh"\n' "$DEST"
printf 'Then open:     http://localhost:8080\n'
printf 'It listens on this machine only by default. Set a strong WADDLE_PASSWORD before exposing it.\n'
