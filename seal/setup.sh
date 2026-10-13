#!/bin/sh
# Turns sealed mode on, or off, for one user. Run as root, by hand:
#
#   sudo sh seal/setup.sh              seal the log of the user who ran sudo
#   sudo sh seal/setup.sh --log-dir <path>   when the log is not in its usual place
#   sudo sh seal/setup.sh --remove     take the helper and the rule away again
#   sudo sh seal/setup.sh --remove --purge   and delete the seal files
#
# Eventloom never runs this itself. It makes four things, and nothing else:
#   - the system user eventloom-seal, which cannot log in;
#   - /usr/local/libexec/eventloom-seal, the helper, owned by root;
#   - /etc/sudoers.d/eventloom-seal-<user>, letting that user run the helper,
#     and only the helper, as eventloom-seal without a password;
#   - /var/lib/eventloom-seal/<uid>.evtseal, which only eventloom-seal writes.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

SEAL_USER=eventloom-seal
SEAL_DIR=/var/lib/eventloom-seal
HELPER=/usr/local/libexec/eventloom-seal
HERE="$(cd "$(dirname "$0")" && pwd)"

die() { echo "seal setup: $*" >&2; exit 1; }
say() { printf '  %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || die "run this with sudo"
owner="${SUDO_USER:-}"
[ -n "$owner" ] && [ "$owner" != root ] || die "run this with sudo from the account whose log is to be sealed"
printf '%s\n' "$owner" | grep -Eqx '[a-z_][a-z0-9_-]{0,31}' || die "unexpected user name: $owner"
uid="$(id -u "$owner")"
group="$(id -gn "$owner")"
rule="/etc/sudoers.d/eventloom-seal-$owner"
file="$SEAL_DIR/$uid.evtseal"

if [ "${1:-}" = --remove ]; then
  [ "$#" -eq 1 ] || [ "${2:-}" = --purge ] || die "usage: setup.sh --remove [--purge]"
  rm -f "$rule"
  say "removed $rule"
  # the helper and the user stay while any other account is still sealed
  if ! ls /etc/sudoers.d/eventloom-seal-* >/dev/null 2>&1; then
    rm -f "$HELPER"
    say "removed $HELPER"
  fi
  if [ "${2:-}" = --purge ]; then
    rm -f "$file"
    say "deleted $file"
  else
    say "kept $file (delete it with --purge)"
  fi
  exit 0
fi
# A seal is of one log directory, named in the seal file's first line. A log
# kept anywhere else is neither sealed by it nor checked against it.
home="$(getent passwd "$owner" | cut -d: -f6)"
log_dir="$home/.local/state/omarchy/agents/logs"
if [ "${1:-}" = --log-dir ] && [ "$#" -eq 2 ]; then
  log_dir="$2"
elif [ "$#" -ne 0 ]; then
  die "usage: setup.sh [--log-dir <path> | --remove [--purge]]"
fi
case "$log_dir" in
  /*) ;;
  *) die "the log directory must be an absolute path: $log_dir" ;;
esac
[ "$(printf '%s' "$log_dir" | wc -l)" -eq 0 ] || die "the log directory cannot hold a line break"

if ! id "$SEAL_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir "$SEAL_DIR" --shell /usr/bin/nologin "$SEAL_USER"
  say "created the system user $SEAL_USER"
fi

install -d -o root -g root -m 0755 "$(dirname "$HELPER")"
install -o root -g root -m 0755 "$HERE/eventloom-seal" "$HELPER"
say "installed $HELPER"

# Others may pass through the directory to a file they are allowed to read,
# and may not list it.
install -d -o "$SEAL_USER" -g root -m 0711 "$SEAL_DIR"
if [ ! -e "$file" ]; then
  printf 'eventloom-seal %s uid=%s log=%s\n' "$("$HELPER" version)" "$uid" "$log_dir" >"$file"
  say "created $file, the seal of $log_dir"
elif ! head -n 1 "$file" | grep -Fqx "eventloom-seal $("$HELPER" version) uid=$uid log=$log_dir"; then
  die "$file already exists and is the seal of something else: $(head -n 1 "$file"). To start again: setup.sh --remove --purge"
fi
chown "$SEAL_USER:$group" "$file"
chmod 0640 "$file"

# Written beside its place and checked before it is moved there: a sudoers
# file that does not parse would lock sudo for everyone.
pending="$(mktemp /etc/sudoers.d/.eventloom-seal.XXXXXX)"
trap 'rm -f "$pending"' EXIT
printf '%s ALL=(%s) NOPASSWD: %s\n' "$owner" "$SEAL_USER" "$HELPER" >"$pending"
chmod 0440 "$pending"
visudo -cf "$pending" >/dev/null || die "the sudoers rule did not pass visudo; nothing was installed there"
mv "$pending" "$rule"
trap - EXIT
say "installed $rule"

say "sealed mode is on for $owner. Check it with: eventloom seal status"
