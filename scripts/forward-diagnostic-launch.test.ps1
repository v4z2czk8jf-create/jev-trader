$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'forward-diagnostic-launch.ps1')
$root = Split-Path -Parent $PSScriptRoot
$run = Join-Path $root ('data/forward-diagnostic-fixtures/' + [Guid]::NewGuid().ToString('N'))
$boot = @{ bootId=$null; bootTime='2026-01-01T00:00:00Z'; bootTimeSource='SYNTHETIC_FIXTURE'; wrapperPid=$PID; launcherParentPid=$null }
$identity = @{ provenance='SYNTHETIC_FIXTURE_NOT_FORWARD'; campaignId=$null }
$script:passed=0
function Assert($ok, [string]$name) { if (-not $ok) { throw "FAIL: $name" }; $script:passed++; Write-Output "PASS: $name" }
$cmd = Join-Path $env:SystemRoot 'System32/cmd.exe'
$log0 = Join-Path $run 'exit0'
$code = Invoke-ForwardDiagnosticChild $cmd '/d /c "echo fixture-output & echo fixture-error 1>&2 & exit /b 0"' $root $log0 $identity $boot
$rows = @(Get-Content -LiteralPath (Join-Path $log0 'lifecycle.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
Assert ($code -eq 0 -and $rows[-1].exitCode -eq 0) 'zero exit is recorded'
Assert (($rows.event -join ',') -eq 'LAUNCH_INTENT,CHILD_STARTED,CHILD_EXIT_OBSERVED') 'single launch and ordered durable events'
Assert ($rows[1].childPid -gt 0 -and $rows[1].childPid -eq $rows[2].childPid -and $rows[1].context.parentPid -eq $PID) 'child and parent PID'
Assert ([DateTimeOffset]$rows[1].startedAt -le [DateTimeOffset]$rows[2].endedAt) 'actual start and exit timestamps'
Assert ($rows[1].context.boot.bootId -eq $null -and $rows[1].context.boot.bootTimeSource -eq 'SYNTHETIC_FIXTURE') 'boot identity is not fabricated'
Assert ($rows[-1].cause -eq 'UNKNOWN' -and $rows[-1].campaignCompletion -eq 'NOT_INFERRED_FROM_EXIT_CODE') 'exit zero does not imply campaign completion'
Assert ((Get-Content (Join-Path $log0 'stdout.log') -Raw).Contains('fixture-output') -and (Get-Content (Join-Path $log0 'stderr.log') -Raw).Contains('fixture-error')) 'both output streams drained'
$before = (Get-FileHash (Join-Path $log0 'lifecycle.jsonl')).Hash
$refused=$false; try { Invoke-ForwardDiagnosticChild $cmd '/d /c exit 0' $root $log0 $identity $boot } catch { $refused=$_.Exception.Message -eq 'DIAGNOSTIC_DIRECTORY_EXISTS' }
Assert ($refused -and $before -eq (Get-FileHash (Join-Path $log0 'lifecycle.jsonl')).Hash) 'existing diagnostic evidence is not overwritten'
$log7=Join-Path $run 'exit7'
$code=Invoke-ForwardDiagnosticChild $cmd '/d /c exit /b 7' $root $log7 $identity $boot
$rows=@(Get-Content (Join-Path $log7 'lifecycle.jsonl')|ForEach-Object{$_|ConvertFrom-Json})
Assert ($code -eq 7 -and $rows[-1].exitCode -eq 7 -and @($rows|Where-Object event -eq 'CHILD_STARTED').Count -eq 1) 'nonzero exit is recorded without restart'
$bad=Join-Path $run 'missing-executable';$refused=$false
try { Invoke-ForwardDiagnosticChild (Join-Path $run 'does-not-exist.exe') '' $root $bad $identity $boot } catch {$refused=$true}
$rows=@(Get-Content (Join-Path $bad 'lifecycle.jsonl')|ForEach-Object{$_|ConvertFrom-Json})
Assert ($refused -and $rows[-1].event -eq 'DIAGNOSTIC_FAILURE' -and @($rows|Where-Object event -eq 'CHILD_STARTED').Count -eq 0) 'failed launch is recorded without a false child start'
$refused=$false;try {Assert-ForwardDiagnosticLaunch 'kuru-mon-usdc-forward-v1-20260921-01' ('a'*40) 'START_NEW_7D_FORWARD_WITH_EXIT_DIAGNOSTICS' $root}catch{$refused=$_.Exception.Message -eq 'OLD_CAMPAIGN_MUST_NOT_RESUME'}
Assert $refused 'old campaign is explicitly rejected'
$refused=$false;try {Assert-ForwardDiagnosticLaunch 'kuru-mon-usdc-forward-v1-20260923-01' ('a'*40) '' $root}catch{$refused=$_.Exception.Message -eq 'EXPLICIT_NEW_CAMPAIGN_APPROVAL_REQUIRED'}
Assert $refused 'no approval means no launch'
Write-Output "RESULT: $script:passed passed; fixture artifacts preserved at $run"
