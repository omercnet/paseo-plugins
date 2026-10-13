$ErrorActionPreference = "Continue"
node .github/top-probe/spawn.mjs
Start-Sleep -Seconds 4
$tree = (Get-Content top-probe-pids.json | ConvertFrom-Json)
$pids = @($tree | ForEach-Object { $_.pid })
"tree pids: $($pids -join ',')"
"== os / powershell"
[Environment]::OSVersion.VersionString
$PSVersionTable.PSVersion.ToString()
"arch: $env:PROCESSOR_ARCHITECTURE  cpus: $env:NUMBER_OF_PROCESSORS"

"== CIM scan (3 runs): duration and columns"
for ($i = 0; $i -lt 3; $i++) {
  $t = Measure-Command { $script:all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,KernelModeTime,UserModeTime,WorkingSetSize,Name }
  "run $i : $([int]$t.TotalMilliseconds) ms, $($all.Count) processes"
}
$all | Where-Object { $_.Name -eq "node.exe" } |
  Select-Object ProcessId, ParentProcessId, CreationDate, KernelModeTime, UserModeTime, WorkingSetSize, Name | Format-Table | Out-String -Width 200

"== CIM property types"
$first = $all | Select-Object -First 1
$first.CreationDate.GetType().FullName
$first.KernelModeTime.GetType().FullName
$first.WorkingSetSize.GetType().FullName

"== tab-separated line the plugin would parse"
$all | Where-Object { $_.ProcessId -in $pids } | ForEach-Object {
  "{0}`t{1}`t{2}`t{3}`t{4}`t{5}" -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc(), ($_.KernelModeTime + $_.UserModeTime), $_.WorkingSetSize, $_.Name
}

"== parents that no longer exist (orphans keep a stale ppid on Windows)"
$byPid = @{}; $all | ForEach-Object { $byPid[[int]$_.ProcessId] = $_ }
($all | Where-Object { $_.ParentProcessId -ne 0 -and -not $byPid.ContainsKey([int]$_.ParentProcessId) }).Count

"== PEB environment read via Add-Type (compile cost, then one pass)"
$t = Measure-Command { Add-Type -TypeDefinition (Get-Content .github/top-probe/win-env.cs -Raw) }
"Add-Type compile: $([int]$t.TotalMilliseconds) ms"
$counts = @{}
$t = Measure-Command {
  foreach ($p in $all) {
    $r = [PasoEnv]::AgentId([int]$p.ProcessId)
    if ($r -like "probe-agent-*") { "tagged: pid $($p.ProcessId) -> $r" }
    $key = if ($r -like "error:*") { $r } elseif ($r -eq "none") { "none" } else { "tagged" }
    $counts[$key] = 1 + [int]$counts[$key]
  }
}
"env pass over $($all.Count) processes: $([int]$t.TotalMilliseconds) ms"
$counts.GetEnumerator() | Sort-Object Name | ForEach-Object { "{0} = {1}" -f $_.Name, $_.Value }

"== grandchild with scrubbed env: expected none, ppid should point to the tagged parent"
$tree | ForEach-Object { "{0} id={1}" -f $_.pid, $_.id }
