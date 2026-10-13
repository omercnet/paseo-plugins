import { execFile } from "node:child_process";
import { type ProcInfo, readProcs, type Scan } from "./processes";

const TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 64 * 1024 ** 2;
const CLOCK_TICKS = 100;
/** Windows counts CPU time in 100 ns units. */
const FILETIME_PER_TICK = 100_000;
const AGENT_ID_VARIABLE = "PASEO_AGENT_ID=";

type Run = (file: string, args: string[]) => Promise<string>;

const run: Run = (file, args) => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(
    file,
    args,
    { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, encoding: "utf8" },
    (error, stdout) => (error ? reject(error) : resolve(stdout)),
  );
  return promise;
};

/** `[[d-][h:]m:]s[.cc]` as `ps` prints CPU time, in clock ticks. */
export function parseCpuTime(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text);
  if (!match) return null;
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  const total = ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
  return Math.round(total * CLOCK_TICKS);
}

// pid ppid lstart ("Tue Oct 13 06:01:17 2026", the day is space padded) cputime rss comm
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(\S+)\s+(\d+)\s+(.+?)\s*$/;

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

/**
 * macOS: `stats` is `ps -axww -o pid=,ppid=,lstart=,cputime=,rss=,comm=`, `environment` is
 * `ps -axww -E -o pid=,command=`. They are separate listings because `-E` appends the environment
 * to the command column only, and a command path may hold spaces.
 */
export function parsePs(stats: string, environment: string): ProcInfo[] {
  const agents = new Map<number, string>();
  for (const line of environment.split("\n")) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    const id = match && parsePsAgentId(match[2] ?? "");
    if (match && id) agents.set(Number(match[1]), id);
  }
  const procs: ProcInfo[] = [];
  for (const line of stats.split("\n")) {
    const match = PS_ROW.exec(line);
    if (!match) continue;
    const [, pid = "", ppid = "", started = "", cpu = "", rssKib = "", path = ""] = match;
    const ticks = parseCpuTime(cpu);
    if (ticks === null) continue;
    procs.push({
      key: `${pid}:${started.replace(/\s+/g, " ")}`,
      pid: Number(pid),
      ppid: Number(ppid),
      ticks,
      rss: Number(rssKib) * 1024,
      comm: path.slice(path.lastIndexOf("/") + 1),
      agentId: agents.get(Number(pid)) ?? null,
    });
  }
  return procs;
}

export async function readPsProcs(exec: Run = run): Promise<ProcInfo[]> {
  const [stats, environment] = await Promise.all([
    exec("/bin/ps", ["-axww", "-o", "pid=,ppid=,lstart=,cputime=,rss=,comm="]),
    exec("/bin/ps", ["-axww", "-E", "-o", "pid=,command="]),
  ]);
  return parsePs(stats, environment);
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
    $found = [regex]::Match([Text.Encoding]::Unicode.GetString($block), '(?:^|\\0)${AGENT_ID_VARIABLE}([^\\0]+)')
    if ($found.Success) { $found.Groups[1].Value }
  } finally { [void]$native::CloseHandle($handle) }
}
$lines = foreach ($p in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,KernelModeTime,UserModeTime,WorkingSetSize,Name) {
  if ($p.ProcessId -eq 0) { continue }
  try {
    @($p.ProcessId, $p.ParentProcessId, ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds(), ([uint64]$p.KernelModeTime + [uint64]$p.UserModeTime), $p.WorkingSetSize, [string](AgentId $p.ProcessId), $p.Name) -join [char]9
  } catch { continue }
}
[Console]::Out.Write(($lines -join [char]10))
`;

/**
 * Windows keeps a dead parent's pid on its children, and the number may since belong to an
 * unrelated process. A parent that started after its child cannot be its parent.
 */
export function parseWindows(text: string): ProcInfo[] {
  const rows: Array<ProcInfo & { started: number }> = [];
  for (const line of text.split("\n")) {
    const [pid, ppid, started, cpu, workingSet, agentId, name] = line.trimEnd().split("\t");
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
  return rows.map(({ started: at, ...proc }) => {
    const parent = started.get(proc.ppid);
    return parent !== undefined && parent > at ? { ...proc, ppid: 0 } : proc;
  });
}

export async function readWindowsProcs(exec: Run = run): Promise<ProcInfo[]> {
  const root = process.env.SystemRoot ?? "C:\\Windows";
  const output = await exec(`${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64"),
  ]);
  return parseWindows(output);
}

/** The process lister for this platform. A scan that fails rejects, or returns null. */
export function defaultScan(platform: NodeJS.Platform = process.platform): Scan {
  if (platform === "darwin") return readPsProcs;
  if (platform === "win32") return readWindowsProcs;
  return () => {
    try {
      return readProcs();
    } catch {
      return null;
    }
  };
}
