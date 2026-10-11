#!/usr/bin/env bash
# Isolated Paseo daemon for verifying a plugin in this repo. Never touches ~/.paseo.
#
#   dev-daemon.sh up <plugin> [extra-config.json]   start daemon, install the checkout, print DEV_HOST
#   dev-daemon.sh reload <plugin>                   reload the plugin after edits
#   dev-daemon.sh cli <plugin> <paseo args...>      run the paseo CLI against the dev daemon (adds --host)
#   dev-daemon.sh agents <plugin>                   print provider and context of each recorded agent
#   dev-daemon.sh down <plugin>                     stop the daemon and delete its state
#
# State lives in ${TMPDIR:-/tmp}/deliver-<plugin>. paseo-omp is refused: follow paseo-omp/AGENTS.md.
set -euo pipefail

cmd=${1:?usage: dev-daemon.sh up|reload|cli|agents|down <plugin> ...}
plugin=${2:?plugin directory name required}
shift 2

root=$(git rev-parse --show-toplevel)
dir="$root/$plugin"
[ -f "$dir/paseo-plugin.json" ] || { echo "$plugin is not a plugin directory" >&2; exit 1; }
[ "$plugin" != paseo-omp ] || { echo "paseo-omp has its own workflow: read paseo-omp/AGENTS.md" >&2; exit 1; }

state="${TMPDIR:-/tmp}/deliver-$plugin"
home="$state/home"
cli="$dir/node_modules/.bin/paseo"
[ -x "$cli" ] || cli="$root/node_modules/.bin/paseo"
[ -x "$cli" ] || { echo "paseo CLI missing: run bun install at the repo root" >&2; exit 1; }

# Ambient agent, daemon and provider variables must not leak into the dev daemon or its agents.
clean() {
  env -u PASEO_AGENT_ID -u PASEO_AGENT_CWD -u PASEO_WORKSPACE_ID -u PASEO_HOST -u PASEO_HOME \
    -u CONTEXT_MODE_DIR -u CONTEXT_MODE_DATA_DIR -u CONTEXT_MODE_PLATFORM \
    -u CLAUDE_CONFIG_DIR -u CODEX_HOME -u COPILOT_HOME -u XDG_CONFIG_HOME -u PI_CODING_AGENT_DIR \
    HOME="$state/fakehome" "$@"
}

dev_host() {
  clean "$cli" daemon status --home "$home" --json | jq -er .listen
}

case "$cmd" in
  up)
    extra=${1:-}
    mkdir -p "$state/fakehome" "$state/work" "$home"
    [ -d "$state/work/.git" ] || git -C "$state/work" init -q
    listen=$(tailscale ip -4 2>/dev/null | head -1 || true)
    jq -n --arg listen "${listen:-127.0.0.1}:0" \
      '{version:1,pluginsEnabled:true,features:{webUi:{enabled:true}},daemon:{listen:$listen,relay:{enabled:false}}}' \
      > "$home/config.json"
    if [ -n "$extra" ]; then
      jq -s '.[0] * .[1]' "$home/config.json" "$extra" > "$home/config.json.tmp"
      mv "$home/config.json.tmp" "$home/config.json"
    fi
    clean "$cli" daemon start --home "$home" >/dev/null
    host=$(dev_host)
    clean "$cli" plugin install "$dir" --host "$host" >/dev/null
    echo "DEV_HOST=$host"
    echo "DEV_HOME=$home"
    echo "WORK_DIR=$state/work"
    ;;
  reload)
    clean "$cli" plugin reload "$plugin" --host "$(dev_host)"
    ;;
  cli)
    clean "$cli" "$@" --host "$(dev_host)"
    ;;
  agents)
    for f in "$home"/agents/*/*.json; do
      [ -e "$f" ] || continue
      jq -c '{provider, title, config}' "$f"
    done
    ;;
  down)
    clean "$cli" daemon stop --home "$home" || true
    rm -rf "$state"
    ;;
  *)
    echo "unknown command: $cmd" >&2
    exit 1
    ;;
esac
