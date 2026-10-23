#!/usr/bin/env bash
# Facts for a Paseo upgrade review: what this repo supports, what Paseo shipped, and where the
# plugins touch the changed surface. Read-only: it only reads this repo, npm, and a clone of
# getpaseo/paseo under ${PASEO_SRC:-/tmp/paseo-src}.
#
#   survey.sh [target]    target is an npm version or tag (default: the newest of dist-tags latest/beta)
set -euo pipefail

root=$(git rev-parse --show-toplevel)
src=${PASEO_SRC:-/tmp/paseo-src}

pin=$(jq -r '.catalog["@getpaseo/plugin"]' "$root/package.json")
latest=$(npm view @getpaseo/plugin dist-tags.latest)
beta=$(npm view @getpaseo/plugin dist-tags.beta)
target=${1:-$(printf '%s\n%s\n' "$latest" "$beta" | sort -V | tail -1)}

echo "== Supported today"
echo "SDK pin (root package.json catalog): $pin"
for m in "$root"/*/paseo-plugin.json; do
  printf '%-24s %s\n' "$(basename "$(dirname "$m")")" "$(jq -r '.requirements.paseo' "$m")"
done
echo
echo "== Paseo releases"
echo "npm latest=$latest beta=$beta target=$target"

if [ ! -d "$src/.git" ]; then
  git clone --quiet --filter=blob:none --no-checkout https://github.com/getpaseo/paseo.git "$src"
fi
git -C "$src" fetch --quiet --tags
from=v${pin}
to=v${target}
git -C "$src" rev-parse --quiet --verify "$from^{commit}" >/dev/null || { echo "no tag $from in $src" >&2; exit 1; }
git -C "$src" rev-parse --quiet --verify "$to^{commit}" >/dev/null || { echo "no tag $to in $src" >&2; exit 1; }

echo
echo "== Commits $from..$to (non-merge: $(git -C "$src" rev-list --no-merges --count "$from..$to"))"
git -C "$src" log --no-merges --format='%h %s' "$from..$to"

echo
echo "== SDK surface diff stat (packages/plugin, packages/protocol)"
git -C "$src" diff --stat "$from" "$to" -- packages/plugin packages/protocol | tail -60

echo
echo "== COMPAT markers added in the range (deprecations with removal dates)"
git -C "$src" diff "$from" "$to" -- packages | grep -E '^\+.*COMPAT\(' | sed 's/^+[[:space:]]*//' | sort -u || true

echo
echo "== Plugin use of deprecated or removed surface"
cd "$root"
grep -rnE "client/react-native|useRevealedText|SettingsGroup|addWorkspacePanel|props\.(context|agentId)|PluginIconProps|server\.on\(" \
  --include='*.ts' --include='*.tsx' --exclude-dir=node_modules --exclude-dir=tests -- */client */server */index.*.ts* 2>/dev/null \
  | cut -c1-200 || true
