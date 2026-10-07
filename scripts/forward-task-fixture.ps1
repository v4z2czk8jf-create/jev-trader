param([Parameter(Mandatory)][string]$LogDirectory, [ValidateRange(1,120)][int]$Seconds=45)
. (Join-Path $PSScriptRoot 'forward-task-common.ps1')
$m=Read-ForwardHostManifest (Join-Path $LogDirectory 'manifest.json')
if ($m.mode -cne 'Fixture') { throw 'FIXTURE_ONLY' }
$clock=[Diagnostics.Stopwatch]::StartNew()
$self=Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
Write-ForwardHostJson (Join-Path $LogDirectory 'fixture-start.json') @{ provenance='SYNTHETIC_FIXTURE_NOT_FORWARD'; pid=$PID; parentPid=$self.ParentProcessId; startedAt=[DateTimeOffset]::UtcNow.ToString('o') }
while ($clock.Elapsed.TotalSeconds -lt $Seconds) { Start-Sleep -Milliseconds 200 }
Write-ForwardHostJson (Join-Path $LogDirectory 'fixture-end.json') @{ provenance='SYNTHETIC_FIXTURE_NOT_FORWARD'; pid=$PID; endedAt=[DateTimeOffset]::UtcNow.ToString('o'); elapsedMs=$clock.ElapsedMilliseconds; exitCode=0 }
exit 0
