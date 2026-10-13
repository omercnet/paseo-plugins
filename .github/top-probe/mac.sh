#!/bin/bash
set -u
node .github/top-probe/spawn.mjs
sleep 4
PIDS=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("top-probe-pids.json","utf8")).map(p=>p.pid).join("|"))')
echo "tree pids: $PIDS"
echo "== sw_vers / arch"; sw_vers; uname -m; sysctl -n hw.ncpu hw.pagesize

echo "== ps keywords, our node tree + header"
ps -axww -o pid,ppid,lstart,time,cputime,utime,stime,rss,comm | awk -v p="^($PIDS)\$" 'NR==1 || $1 ~ p'

echo "== ps -o with '=' headers, as the plugin would parse"
ps -axww -o pid=,ppid=,lstart=,cputime=,rss=,comm= | awk -v p="^($PIDS)\$" '$1 ~ p'

echo "== duration of a full scan (3 runs)"
for i in 1 2 3; do /usr/bin/time -p ps -axww -o pid=,ppid=,lstart=,cputime=,rss=,comm= > /dev/null; done 2>&1

echo "== ps -E: does the environment follow the command column? only the agent id is printed"
ps -axww -E -o pid=,command= | awk -v p="^($PIDS)\$" '$1 ~ p {print $1, ($0 ~ /PASEO_AGENT_ID=probe-agent-[AB]/ ? "tagged" : "no-tag")}' 
ps -axww -E -o pid=,command= | grep -o 'PASEO_AGENT_ID=[^ ]*' | sort | uniq -c

echo "== ps -E with comm: is the env appended to comm?"
ps -axww -E -o pid=,comm= | awk -v p="^($PIDS)\$" '$1 ~ p {print $1, ($0 ~ /PASEO_AGENT_ID/ ? "env-in-comm" : "comm-only")}'

echo "== ps eww form"
ps eww -axo pid=,command= | awk -v p="^($PIDS)\$" '$1 ~ p {print $1, ($0 ~ /PASEO_AGENT_ID=probe-agent-[AB]/ ? "tagged" : "no-tag")}'

echo "== a process of another user (launchd, pid 1): is its environment readable?"
ps -E -p 1 -o pid=,command= | sed -E 's/ [A-Z_]+=.*//' | head -2

echo "== pid 1 ppid of orphan reparenting: ppid of tree"
ps -axww -o pid=,ppid= | awk -v p="^($PIDS)\$" '$1 ~ p'
