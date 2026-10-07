[CmdletBinding()]
param([switch]$Scheduler, [ValidateSet('Both','Natural','ManualStop')][string]$SchedulerCase='Both', [switch]$BunFixture)
. (Join-Path $PSScriptRoot 'forward-task-common.ps1')
$script:passed=0
function Assert($Condition,[string]$Name) { if (-not $Condition) { throw "FAIL: $Name" }; $script:passed++; Write-Output "PASS: $Name" }
function Refuses([scriptblock]$Action,[string]$Name) { $refused=$false; try {& $Action | Out-Null} catch {$refused=$true}; Assert $refused $Name }
function Wait-Until([scriptblock]$Condition,[int]$Seconds=60) {
    $clock=[Diagnostics.Stopwatch]::StartNew()
    while ($clock.Elapsed.TotalSeconds -lt $Seconds) {if (& $Condition) {return}; Start-Sleep -Milliseconds 300}
    throw 'BOUNDED_FIXTURE_WAIT_EXPIRED'
}
function Start-ShortLivedLauncher([string]$Path) {
    $info=[Diagnostics.ProcessStartInfo]::new(); $info.FileName=(Get-Process -Id $PID).Path
    $info.UseShellExecute=$false; $info.CreateNoWindow=$true; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
    foreach($arg in @('-NoProfile','-NonInteractive','-File',(Join-Path $PSScriptRoot 'forward-task-start.ps1'),'-ManifestPath',$Path,'-Approval','START_HARMLESS_HOST_FIXTURE')) {[void]$info.ArgumentList.Add($arg)}
    $p=[Diagnostics.Process]::Start($info)
    $out=$p.StandardOutput.ReadToEndAsync(); $err=$p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit(20000)) {throw 'STARTER_NOT_FINISHED_NO_TERMINATION_ATTEMPTED'}
    if ($p.ExitCode -ne 0) {throw ('STARTER_FAILED: ' + $err.GetAwaiter().GetResult())}
    return $p
}

$draft=& (Join-Path $PSScriptRoot 'forward-task-install.ps1') -Mode Fixture -FixtureSeconds 45
$path=$draft.manifestPath; $m=Read-ForwardHostManifest $path
$xml=New-ForwardTaskXml $m $path
Assert ($draft.registered -eq $false) 'definition preparation does not register or start a task'
Assert ([IO.Path]::IsPathFullyQualified($m.bunExecutablePath) -and $m.bunVersion -ceq '1.3.14' -and $m.expectedBunVersion -ceq '1.3.14') 'absolute Bun path and actual/expected version saved'
Assert-ForwardBunBinary $m; Assert $true 'Bun executable SHA256 pinned'
$reread=Read-ForwardHostManifest $path
Assert ($reread.bunExecutablePath -ceq $m.bunExecutablePath -and $reread.bunVersion -ceq $m.bunVersion -and $reread.bunSha256 -ceq $m.bunSha256) 'Bun provenance survives manifest reload'
Assert ([IO.Path]::IsPathFullyQualified($m.gitExecutablePath) -and $m.gitVersion -match '^git version ' -and $m.gitSha256 -match '^[a-f0-9]{64}$') 'absolute Git path/version/SHA256 saved'
Assert ($reread.gitExecutablePath -ceq $m.gitExecutablePath -and $reread.gitVersion -ceq $m.gitVersion -and $reread.gitSha256 -ceq $m.gitSha256) 'Git provenance survives manifest reload'
Refuses {Get-ForwardGitEvidence 'git.exe' $m.repoRoot} 'relative Git path refused'
Refuses {Get-ForwardGitEvidence (Join-Path $m.logDirectory 'missing-git.exe') $m.repoRoot} 'missing Git path refused'
$badGit=$m|ConvertTo-Json -Depth 12|ConvertFrom-Json; $badGit.gitSha256='0'*64
Refuses {Assert-ForwardGitBinary $badGit} 'changed Git binary refused without fallback'
Assert ((Invoke-ForwardPinnedGit $m $m.repoRoot @('rev-parse','HEAD')) -ceq $m.runtimeCommit) 'fixed Git reads runtime HEAD'
Refuses {Get-ForwardBunEvidence 'bun.exe'} 'relative PATH lookup refused'
Refuses {Get-ForwardBunEvidence (Join-Path $m.logDirectory 'missing-bun.exe')} 'nonexistent executable refused'
Refuses {Get-ForwardBunEvidence $m.bunExecutablePath '0.0.0'} 'version mismatch refused without update or reinstall'
$badBun=$m|ConvertTo-Json -Depth 12|ConvertFrom-Json; $badBun.bunSha256='0'*64
Refuses {Assert-ForwardBunBinary $badBun} 'changed Bun binary hash refused'
Assert ($xml.Contains('<WorkingDirectory>' + $m.repoRoot + '</WorkingDirectory>')) 'task working directory explicitly fixed'
Assert ($xml -match '<Triggers />' -and $xml -notmatch 'BootTrigger|LogonTrigger|RestartOnFailure') 'no automatic start or failure restart'
Assert ($xml -match '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>') 'no scheduler default 72 hour cutoff; runner owns deadlines'
Assert ($xml -match '<RunLevel>LeastPrivilege</RunLevel>' -and $xml -match '<LogonType>InteractiveToken</LogonType>') 'current interactive user without highest privileges or password'
Assert ($xml -notmatch 'Password|S4U|HighestAvailable|ExecutionPolicy|Bypass') 'no credential or execution policy bypass'
Assert ($xml -match '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>') 'scheduler rejects overlapping instances'
Assert ($xml -match '<WakeToRun>false' -and $xml -match '<StartWhenAvailable>false') 'no wake or missed-trigger catchup'
Assert-ForwardTaskDefinition $xml $m $path
Assert $true 'generated XML matches fixed task contract'
$normalized=$xml.Replace('<RunOnlyIfIdle>false</RunOnlyIfIdle>','').Replace('<RunLevel>LeastPrivilege</RunLevel>','').Replace('<AllowStartOnDemand>true</AllowStartOnDemand>','')
Assert-ForwardTaskDefinition $normalized $m $path
Assert $true 'scheduler omission of documented defaults is accepted'
Refuses {Assert-ForwardTaskDefinition ($xml.Replace('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>','')) $m $path} 'absent execution limit is refused rather than accepting 72 hour default'
foreach($pair in @(@('PT0S','PT72H'),@('LeastPrivilege','HighestAvailable'),@('IgnoreNew','Parallel'),@('<Triggers />','<Triggers><BootTrigger /></Triggers>'),@('<Triggers />','<Triggers><LogonTrigger /></Triggers>'),@('<Settings>','<Settings><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>'))) {
    $changed=$xml.Replace($pair[0],$pair[1]); Refuses {Assert-ForwardTaskDefinition $changed $m $path} ('definition rejects ' + $pair[1])
}
Assert ($m.ruleCommit -ceq $script:ForwardRuleCommit -and $m.runtimeCommit -match '^[a-f0-9]{40}$') 'rule and runtime provenance retained separately'
Assert ($m.campaignId -like 'fixture-*' -and $m.dryRun -ceq 'true' -and $m.model -ceq 'mock' -and $m.noEnvFile) 'fixture identity and observation safety'
$copy=$m | ConvertTo-Json -Depth 12 | ConvertFrom-Json
$copy.ruleCommit='a'*40; Refuses {Assert-ForwardHostManifest $copy $path} 'changed rule commit refused'
foreach($old in @('kuru-mon-usdc-forward-v1-20260921-01','kuru-mon-usdc-forward-v1-20260922-01')) {
    $copy=$m | ConvertTo-Json -Depth 12 | ConvertFrom-Json; $copy.mode='Forward'; $copy.campaignId=$old
    Refuses {Assert-ForwardHostManifest $copy $path} ('interrupted campaign refused without reading it: ' + $old)
}
Refuses {& (Join-Path $PSScriptRoot 'forward-task-start.ps1') -ManifestPath $path -Approval ''} 'no approval means no scheduler run'
Refuses {& (Join-Path $PSScriptRoot 'forward-task-host.ps1') -ManifestPath $path} 'GUI run without single-use permit cannot start child'
Assert-ForwardHostFiles $m; Assert $true 'host implementation hashes are fixed'
$copy=$m | ConvertTo-Json -Depth 12 | ConvertFrom-Json; $copy.files.'scripts/forward-task-host.ps1'='0'*64
Refuses {Assert-ForwardHostFiles $copy} 'changed host file hash refused'
$proof=Join-Path $m.logDirectory 'exclusive-test.json'; Write-ForwardHostJson $proof @{synthetic=$true}
$before=(Get-FileHash $proof).Hash; Refuses {Write-ForwardHostJson $proof @{synthetic=$false}} 'single-use file cannot be overwritten'
Assert ((Get-FileHash $proof).Hash -eq $before) 'failed duplicate creation preserves original'
$sources=@(Get-ChildItem $PSScriptRoot -Filter 'forward-task-*.ps1')
foreach($file in $sources) { $tokens=$null; $errors=$null; [void][Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$tokens,[ref]$errors); Assert ($errors.Count -eq 0) ('PowerShell parse: '+$file.Name) }
Assert (-not (Test-Path (Join-Path $m.logDirectory 'child'))) 'offline tests did not start a child'

if ($Scheduler) {
    $cases=switch($SchedulerCase) {'Natural' {@('natural')}; 'ManualStop' {@('manual-stop')}; default {@('natural','manual-stop')}}
    foreach($mode in $cases) {
        Write-Output "SCHEDULER_FIXTURE: $mode"
        $fixtureRuntime=if ($BunFixture) {'Bun'} else {'PowerShell'}
        $registration=& (Join-Path $PSScriptRoot 'forward-task-install.ps1') -Mode Fixture -FixtureSeconds 45 -FixtureRuntime $fixtureRuntime -Register -Approval REGISTER_HARMLESS_HOST_FIXTURE
        $path=$registration.manifestPath; $m=Read-ForwardHostManifest $path
        Write-Output "FIXTURE_MANIFEST: $path"
        Refuses {& (Join-Path $PSScriptRoot 'forward-task-install.ps1') -Mode Fixture -Register -Approval REGISTER_HARMLESS_HOST_FIXTURE} 'existing task is not overwritten'
        $launcher=Start-ShortLivedLauncher $path
        # CreateNew makes the pathname visible before the durable JSON write finishes.
        Wait-Until {
            try {
                $startRecord=Get-Content (Join-Path $m.logDirectory 'fixture-start.json') -Raw -ErrorAction Stop | ConvertFrom-Json
                return ($null -ne $startRecord -and $null -ne $startRecord.PSObject.Properties['pid'])
            } catch { return $false }
        } 20
        $child=Get-Content (Join-Path $m.logDirectory 'fixture-start.json') -Raw | ConvertFrom-Json
        if ($BunFixture) {
            Assert ($child.bunExecutablePath -ieq $m.bunExecutablePath -and $child.bunVersion -ceq $m.bunVersion) 'scheduled child is the pinned absolute Bun binary/version'
            Assert ($child.cwd -ieq $m.repoRoot -and $child.dryRun -ceq 'true' -and $child.model -ceq 'mock') 'Bun child has fixed Git root and safe process environment'
            Assert ($child.gitExecutablePath -ceq $m.gitExecutablePath -and $child.gitVersion -ceq $m.gitVersion -and $child.gitSha256 -ceq $m.gitSha256) 'Scheduler child uses pinned Git provenance'
            Assert ($child.gitHead -ceq $m.runtimeCommit -and $child.ruleCommit -ceq $m.ruleCommit -and $child.ruleType -ceq 'commit' -and $child.frozenCount -eq 11) 'Scheduler Git HEAD/rule and frozen hashes verified'
            Assert ($child.workingTreeClean -or $child.dirtyGuard -ceq 'DIRTY_CORRECTLY_REJECTED_FOR_FORWARD') 'Scheduler working tree check never bypassed for real Forward'
        }
        Assert ($launcher.HasExited) 'launching PowerShell session has ended'
        Start-Sleep -Seconds 3
        Assert ($null -ne (Get-Process -Id $child.pid -ErrorAction SilentlyContinue)) 'fixture survives launching shell exit'
        $hostEvents=@(Get-ChildItem $m.logDirectory -Filter 'event-*.json' | ForEach-Object {Get-Content $_.FullName -Raw | ConvertFrom-Json})
        $hostStart=@($hostEvents | Where-Object event -eq 'HOST_STARTED')[0]
        Assert ($child.parentPid -eq $hostStart.detail.hostPid -and $hostStart.detail.parentPid -ne $launcher.Id) 'fixture is owned by scheduler host rather than starter'
        $parent=Get-Process -Id $hostStart.detail.parentPid -ErrorAction SilentlyContinue
        Write-Output ("HOST_PARENT: " + $hostStart.detail.parentPid + ' / ' + $parent.ProcessName)
        Refuses {& (Join-Path $PSScriptRoot 'forward-task-start.ps1') -ManifestPath $path -Approval START_HARMLESS_HOST_FIXTURE} 'duplicate start rejected while running'
        $running=& (Join-Path $PSScriptRoot 'forward-task-status.ps1') -ManifestPath $path -Record
        Assert ($running.instances.Count -eq 1 -and $running.instances[0].instanceId) 'scheduler instance ID and active state recorded'
        if ($mode -eq 'manual-stop') {
            & (Join-Path $PSScriptRoot 'forward-task-stop.ps1') -ManifestPath $path -Approval STOP_OWNED_TASK_FLUSH_NOT_GUARANTEED | Out-Null
        }
        Wait-Until {(Get-ForwardOwnedTask $m $path).GetInstances(0).Count -eq 0} 60
        Wait-Until {$null -eq (Get-Process -Id $child.pid -ErrorAction SilentlyContinue)} 5
        $status=& (Join-Path $PSScriptRoot 'forward-task-status.ps1') -ManifestPath $path -Record
        Assert ($status.lastRunResultIsFinal) 'scheduler terminal result recorded separately from campaign completion'
        if ($mode -eq 'natural') {
            Assert ($status.lastRunResult -eq 0 -and $status.childExit.Count -eq 1 -and $status.childExit[0].exitCode -eq 0) 'natural fixture exit and wrapper exit recorded'
            Assert (Test-Path (Join-Path $m.logDirectory 'fixture-end.json')) 'fixture completed normally after starter exit'
        } else {
            Assert ($null -eq (Get-Process -Id $child.pid -ErrorAction SilentlyContinue)) 'manual task stop leaves no fixture child running'
            Assert (-not (Test-Path (Join-Path $m.logDirectory 'fixture-end.json'))) 'manual termination is not confused with later natural fixture expiry'
            $stopEvents=@(Get-ChildItem $m.logDirectory -Filter 'event-*.json' | ForEach-Object {Get-Content $_.FullName -Raw | ConvertFrom-Json} | Where-Object event -eq 'MANUAL_HOST_STOP_REQUESTED')
            Assert ($stopEvents.Count -eq 1 -and $stopEvents[0].detail.graceful -eq $false) 'manual stop recorded without pretending graceful flush'
        }
        Refuses {& (Join-Path $PSScriptRoot 'forward-task-start.ps1') -ManifestPath $path -Approval START_HARMLESS_HOST_FIXTURE} 'consumed campaign intent cannot be restarted after exit'
        & (Join-Path $PSScriptRoot 'forward-task-stop.ps1') -ManifestPath $path -RemoveCompletedTask -Approval REMOVE_INACTIVE_OWNED_TASK_KEEP_EVIDENCE
        Assert (Test-Path (Join-Path $m.logDirectory 'manifest.json')) 'task cleanup preserves all fixture evidence'
        Write-Output ("SCHEDULER_RESULT: mode=$mode result=" + $status.lastRunResult + " manifest=$path")
    }
}
Write-Output "RESULT: $script:passed passed; Scheduler=$Scheduler; marketRequests=0; no Forward campaign started"
