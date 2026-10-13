// Starts a small process tree for the probe: two tagged agents, one grandchild with a scrubbed
// environment, and one untagged process. Children burn CPU for 2s, then idle for 120s.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const child = `
const {spawn}=require("node:child_process");
if (process.env.SPAWN_GRAND) {
  const env={...process.env}; delete env.PASEO_AGENT_ID; delete env.SPAWN_GRAND;
  spawn(process.execPath,["-e","const e=Date.now()+2000;while(Date.now()<e);setTimeout(()=>{},120000)"],{env,stdio:"ignore"}).unref();
}
const end=Date.now()+2000;while(Date.now()<end);
setTimeout(()=>{},120000);
`;

const start = (id, grand) => {
  const env = { ...process.env, SPAWN_GRAND: grand ? "1" : "" };
  delete env.PASEO_AGENT_ID;
  if (id) env.PASEO_AGENT_ID = id;
  const proc = spawn(process.execPath, ["-e", child], { env, stdio: "ignore", detached: true });
  proc.unref();
  return { id, pid: proc.pid, grand };
};

const started = [start("probe-agent-A", true), start("probe-agent-B", false), start(null, false)];
writeFileSync("top-probe-pids.json", JSON.stringify(started, null, 2));
console.log(JSON.stringify(started));
