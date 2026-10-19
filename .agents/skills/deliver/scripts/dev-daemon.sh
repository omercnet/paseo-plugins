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
# The CLI comes from the plugin, the repo root, the bun store, or the first plugin that has it.
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
id=$(jq -er .id "$dir/paseo-plugin.json")

# `bun install` links the CLI into the plugins that depend on it, not the repo root.
cli=
shopt -s nullglob
for c in "$dir/node_modules/.bin/paseo" "$root/node_modules/.bin/paseo" \
  "$root"/node_modules/.bun/@getpaseo+cli@*/node_modules/@getpaseo/cli/bin/paseo \
  "$root"/*/node_modules/.bin/paseo; do
  [ -x "$c" ] && { cli=$c; break; }
done
shopt -u nullglob
[ -n "$cli" ] || { echo "paseo CLI not found: run bun install at the repo root" >&2; exit 1; }

# Ambient agent, daemon and provider variables must not leak into the dev daemon or its agents.
# PASEO_DEV_DAEMON_STATE marks everything launched here; `down` uses it to find leftovers by ownership.
clean() {
  env -u PASEO_AGENT_ID -u PASEO_AGENT_CWD -u PASEO_WORKSPACE_ID -u PASEO_HOST -u PASEO_HOME \
    -u CONTEXT_MODE_DIR -u CONTEXT_MODE_DATA_DIR -u CONTEXT_MODE_PLATFORM \
    -u CLAUDE_CONFIG_DIR -u CODEX_HOME -u COPILOT_HOME -u XDG_CONFIG_HOME -u PI_CODING_AGENT_DIR \
    HOME="$state/fakehome" PASEO_DEV_DAEMON_STATE="$state" "$@"
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
    clean "$cli" plugin reload "$id" --host "$(dev_host)"
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
    # Plugin supervisors and browsers can outlive the daemon. Stop only processes whose environment
    # carries this exact marker, never this script or its ancestors. Needs /proc: without it (macOS)
    # only the daemon stop above runs.
    if [ -d /proc/self ] && [[ $state == /*/deliver-* && ${state##*/} == deliver-[!/]* ]]; then
      keep=" "; p=$$
      while [ "${p:-0}" -gt 1 ]; do
        keep+="$p "
        p=$(sed -n 's/^PPid:[[:space:]]*//p' "/proc/$p/status" 2>/dev/null) || true
      done
      pids=()
      for e in /proc/[0-9]*/environ; do
        pid=${e#/proc/}; pid=${pid%/environ}
        [[ $keep != *" $pid "* ]] || continue
        grep -qzxF "PASEO_DEV_DAEMON_STATE=$state" "$e" 2>/dev/null || continue
        pids+=("$pid")
        echo "stopping leftover $pid $(cat "/proc/$pid/comm" 2>/dev/null)"
      done
      if [ ${#pids[@]} -gt 0 ]; then
        kill -TERM "${pids[@]}" 2>/dev/null || true
        sleep 2
        kill -KILL "${pids[@]}" 2>/dev/null || true
      fi
    fi
    rm -rf "$state"
    ;;
  *)
    echo "unknown command: $cmd" >&2
    exit 1
    ;;
esac
