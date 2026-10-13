import { execFile } from "node:child_process";
import { type Listing, type ProcInfo, readProcs, type Scan } from "./processes";

const TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 64 * 1024 ** 2;
const CLOCK_TICKS = 100;
/** Windows counts CPU time in 100 ns units. */
const FILETIME_PER_TICK = 100_000;
const AGENT_ID_VARIABLE = "PASEO_AGENT_ID=";
/** First line of the Windows output: when the process table was read, in ms after the script started. */
const SNAPSHOT_MARK = "snapshot";

type Run = (file: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<string>;

const run: Run = (file, args, env) => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(
    file,
    args,
    {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
    (error, stdout) => (error ? reject(error) : resolve(stdout)),
  );
  return promise;
};

/** `m:ss.cc` as `ps` prints CPU time (minutes are not capped at 59), in clock ticks. */
export function parseCpuTime(text: string): number | null {
  const match = /^(\d+):(\d+(?:\.\d+)?)$/.exec(text);
  return match ? Math.round((Number(match[1]) * 60 + Number(match[2])) * CLOCK_TICKS) : null;
}

// "Tue Oct 13 06:01:17 2026": `lstart`, whose day is space padded. Pinned to the C locale by the caller.
const LSTART = String.raw`(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)`;
// pid ppid lstart cputime rss comm
const PS_ROW = new RegExp(String.raw`^\s*(\d+)\s+(\d+)\s+${LSTART}\s+(\S+)\s+(\d+)\s+(.+?)\s*$`);
// pid lstart command-and-environment
const PS_ENV_ROW = new RegExp(String.raw`^\s*(\d+)\s+${LSTART}\s(.*)$`);

/**
 * The agent id in one `ps -E` line. The environment follows the arguments, so the last occurrence
 * is the environment's, and arguments that only mention the variable do not count. The whole line
 * is read but only the id is kept; the rest can hold secrets.
 */
export function parsePsAgentId(line: string): string | null {
  let id: string | null = null;
  for (const match of line.matchAll(/(?:^|\s)PASEO_AGENT_ID=(\S+)/g)) id = match[1] ?? null;
  return id;
}

const psKey = (pid: string, started: string) => `${pid}:${started.replace(/\s+/g, " ")}`;

/**
 * macOS: `stats` is `ps -axww -o pid=,ppid=,lstart=,cputime=,rss=,comm=`, `environment` is
 * `ps -axww -E -o pid=,lstart=,command=`. They are separate listings because `-E` appends the
 * environment to the command column only, and a command may hold spaces. Rows are joined on pid
 * and start time, so a pid reused between the two listings is not given the old process's agent.
 */
export function parsePs(stats: string, environment: string): ProcInfo[] {
  const agents = new Map<string, string>();
  for (const line of environment.split("\n")) {
    const match = PS_ENV_ROW.exec(line);
    const id = match && parsePsAgentId(match[3] ?? "");
    if (match && id) agents.set(psKey(match[1] ?? "", match[2] ?? ""), id);
  }
  const procs: ProcInfo[] = [];
  for (const line of stats.split("\n")) {
    const match = PS_ROW.exec(line);
    if (!match) continue;
    const [, pid = "", ppid = "", started = "", cpu = "", rssKib = "", path = ""] = match;
    const ticks = parseCpuTime(cpu);
    if (ticks === null) continue;
    const key = psKey(pid, started);
    procs.push({
      key,
      pid: Number(pid),
      ppid: Number(ppid),
      ticks,
      rss: Number(rssKib) * 1024,
      comm: path.slice(path.lastIndexOf("/") + 1),
      agentId: agents.get(key) ?? null,
    });
  }
  return procs;
}

/**
 * The daemon is always in its own host's process list, so a listing without it is not one: empty
 * or garbled output must fail the scan, not read as a host where nothing is running.
 */
function ownListing<T extends { pid: number }>(procs: T[], self: number): T[] {
  if (!procs.some((proc) => proc.pid === self))
    throw new Error("process list does not include this process");
  return procs;
}

export async function readPsProcs(exec: Run = run, self = process.pid): Promise<ProcInfo[]> {
  // `lstart` follows the locale; the parser reads the C one.
  const env = { LC_ALL: "C" };
  const [stats, environment] = await Promise.all([
    exec("/bin/ps", ["-axww", "-o", "pid=,ppid=,lstart=,cputime=,rss=,comm="], env),
    exec("/bin/ps", ["-axww", "-E", "-o", "pid=,lstart=,command="], env),
  ]);
  return ownListing(parsePs(stats, environment), self);
}

/**
 * Windows has no listing that includes another process's environment, so the script reads it from
 * the process's memory: PEB -> RTL_USER_PROCESS_PARAMETERS -> Environment (64-bit layout; checked
 * on x64 and ARM64). The native calls are declared with Reflection.Emit because compiling C#
 * with Add-Type costs seconds on every start. Only the agent id leaves the script. A process that
 * cannot be opened (another user's, protected) simply has none. Anything that stops the script
 * from working at all, such as a locked-down language mode, exits non-zero.
 */
export const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$clock = [Diagnostics.Stopwatch]::StartNew()
if (-not [Environment]::Is64BitProcess) { exit 3 }
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$type = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object System.Reflection.AssemblyName 'TopNative'), 'Run').DefineDynamicModule('m').DefineType('N', 'Public,Class')
function Import($name, $dll, $return, $params) {
  $method = $type.DefinePInvokeMethod($name, $dll, 'Public,Static,PinvokeImpl', 'Standard', $return, $params, 'Winapi', 'Auto')
  $method.SetImplementationFlags('PreserveSig')
}
Import 'OpenProcess' 'kernel32.dll' ([IntPtr]) @([uint32], [bool], [int])
Import 'CloseHandle' 'kernel32.dll' ([bool]) @([IntPtr])
Import 'ReadProcessMemory' 'kernel32.dll' ([bool]) @([IntPtr], [IntPtr], [byte[]], [IntPtr], [IntPtr])
Import 'NtQueryInformationProcess' 'ntdll.dll' ([int]) @([IntPtr], [int], [byte[]], [int], [IntPtr])
$native = $type.CreateType()
function ReadMemory($handle, [long]$address, [int]$size) {
  $buffer = New-Object byte[] $size
  if ($native::ReadProcessMemory($handle, [IntPtr]$address, $buffer, [IntPtr]$size, [IntPtr]::Zero)) { , $buffer }
}
function AgentId([int]$id) {
  $handle = $native::OpenProcess(0x1010, $false, $id)
  if ($handle -eq [IntPtr]::Zero) { return }
  try {
    $info = New-Object byte[] 48
    if ($native::NtQueryInformationProcess($handle, 0, $info, 48, [IntPtr]::Zero) -ne 0) { return }
    $peb = ReadMemory $handle ([BitConverter]::ToInt64($info, 8) + 0x20) 8
    if (-not $peb) { return }
    $parameters = [BitConverter]::ToInt64($peb, 0)
    $start = ReadMemory $handle ($parameters + 0x80) 8
    $length = ReadMemory $handle ($parameters + 0x3F0) 8
    if (-not $start -or -not $length) { return }
    $size = [int][Math]::Min([BitConverter]::ToInt64($length, 0), 1MB)
    if ($size -le 0) { return }
    $block = ReadMemory $handle ([BitConverter]::ToInt64($start, 0)) $size
    if (-not $block) { return }
    $found = [regex]::Match([Text.Encoding]::Unicode.GetString($block), '(?:^|\\0)${AGENT_ID_VARIABLE}([^\\0\\t\\r\\n]+)')
    if ($found.Success) { $found.Groups[1].Value }
  } catch { return } finally { [void]$native::CloseHandle($handle) }
}
$all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,KernelModeTime,UserModeTime,WorkingSetSize,Name
$snapshotMs = $clock.ElapsedMilliseconds
$lines = foreach ($p in $all) {
  if ($p.ProcessId -eq 0) { continue }
  try {
    @($p.ProcessId, $p.ParentProcessId, ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds(), ([uint64]$p.KernelModeTime + [uint64]$p.UserModeTime), $p.WorkingSetSize, [string](AgentId $p.ProcessId), $p.Name) -join [char]9
  } catch { continue }
}
[Console]::Out.Write((@('${SNAPSHOT_MARK}' + [char]9 + $snapshotMs) + $lines) -join [char]10)
`;

/**
 * The listing also says how long after the script started the table was read, so a slower start
 * of PowerShell on one scan than on the last does not skew the CPU rates. Windows keeps a dead parent's pid on its children, and the number may since belong to an
 * unrelated process. A parent that started after its child cannot be its parent.
 */
export function parseWindows(text: string): Listing {
  const rows: Array<ProcInfo & { started: number }> = [];
  let delayMs = 0;
  for (const line of text.split("\n")) {
    const [pid, ppid, started, cpu, workingSet, agentId, name] = line.trimEnd().split("\t");
    if (pid === SNAPSHOT_MARK) {
      delayMs = Number(ppid) || 0;
      continue;
    }
    const numbers = [pid, ppid, started, cpu, workingSet].map(Number);
    if (name === undefined || !numbers.every(Number.isFinite) || Number(pid) === 0) continue;
    rows.push({
      key: `${pid}:${started}`,
      pid: numbers[0] as number,
      ppid: numbers[1] as number,
      started: numbers[2] as number,
      ticks: Math.floor((numbers[3] as number) / FILETIME_PER_TICK),
      rss: numbers[4] as number,
      comm: name.replace(/\.exe$/i, ""),
      agentId: agentId || null,
    });
  }
  const started = new Map(rows.map((row) => [row.pid, row.started]));
  const procs = rows.map(({ started: at, ...proc }) => {
    const parent = started.get(proc.ppid);
    return parent !== undefined && parent > at ? { ...proc, ppid: 0 } : proc;
  });
  return { procs, delayMs };
}

/**
 * Windows PowerShell 5.1, which every Windows has. A 32-bit Node on a 64-bit Windows would get the
 * 32-bit one from System32, which cannot read 64-bit processes; Sysnative reaches the real one.
 */
export function powershellPath(env: NodeJS.ProcessEnv = process.env, arch = process.arch): string {
  const root = env.SystemRoot ?? "C:\\Windows";
  const folder = arch === "ia32" && env.PROCESSOR_ARCHITEW6432 ? "Sysnative" : "System32";
  return `${root}\\${folder}\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

export async function readWindowsProcs(
  exec: Run = run,
  self = process.pid,
  powershell = powershellPath(),
): Promise<Listing> {
  const output = await exec(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64"),
  ]);
  const listing = parseWindows(output);
  ownListing(listing.procs, self);
  return listing;
}

/**
 * The process lister for this platform. A scan that fails rejects, or returns null. Set
 * `PASEO_TOP_SESSIONS=off` to not list processes at all, which turns per-session load off.
 */
export function defaultScan(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Scan {
  if (env.PASEO_TOP_SESSIONS === "off") return () => null;
  if (platform === "darwin") return () => readPsProcs();
  if (platform === "win32") return () => readWindowsProcs();
  return () => {
    try {
      return readProcs();
    } catch {
      return null;
    }
  };
}
