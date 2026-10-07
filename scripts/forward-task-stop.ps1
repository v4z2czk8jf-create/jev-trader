[CmdletBinding()]
param([Parameter(Mandatory)][string]$ManifestPath, [string]$Approval, [switch]$RemoveCompletedTask)
. (Join-Path $PSScriptRoot 'forward-task-common.ps1')
$m=Read-ForwardHostManifest $ManifestPath
$task=Get-ForwardOwnedTask $m $ManifestPath
# Obtain a handle to only the child recorded by this owned task. Never trust a PID alone.
$child=$null
$lifecycle=Join-Path $m.logDirectory 'child/lifecycle.jsonl'
if (Test-Path -LiteralPath $lifecycle) {
    $starts=@(Get-Content -LiteralPath $lifecycle | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object event -eq 'CHILD_STARTED')
    if ($starts.Count -ne 1) { throw 'UNIQUE_CHILD_IDENTITY_REQUIRED' }
    $start=$starts[0]
    if ($start.context.identity.campaignId -cne $m.campaignId -or $start.context.identity.runtimeCodeCommit -cne $m.runtimeCommit) { throw 'CHILD_PROVENANCE_MISMATCH' }
    $child=Get-Process -Id $start.childPid -ErrorAction SilentlyContinue
    if ($child) {
        [void]$child.Handle # Hold the identity-checked process handle across Scheduler.Stop/PID reuse.
        if ($child.StartTime.ToUniversalTime() -ne ([DateTimeOffset]$start.startedAt).UtcDateTime) { throw 'CHILD_PID_REUSED_REFUSE_STOP' }
        $expectedName=if ($m.mode -ceq 'Fixture' -and $m.fixtureRuntime -ceq 'PowerShell') {'pwsh'} else {'bun'}
        if ($child.ProcessName -cne $expectedName) { throw 'CHILD_EXECUTABLE_MISMATCH' }
    }
}
if ($RemoveCompletedTask) {
    if ($Approval -cne 'REMOVE_INACTIVE_OWNED_TASK_KEEP_EVIDENCE') { throw 'CLEANUP_APPROVAL_REQUIRED' }
    if ($task.State -in 2,4 -or $task.GetInstances(0).Count -gt 0) { throw 'RUNNING_TASK_CANNOT_BE_REMOVED' }
    if ($child -and -not $child.HasExited) { throw 'LIVE_CHILD_CANNOT_BE_ORPHANED_BY_CLEANUP' }
    [void](Write-ForwardHostEvent $m 'TASK_REMOVAL_REQUESTED' @{ lastRunResult=$task.LastTaskResult; evidenceRetained=$true })
    (Get-ForwardTaskFolder).DeleteTask($m.taskName,0)
    return
}
if ($Approval -cne 'STOP_OWNED_TASK_FLUSH_NOT_GUARANTEED') { throw 'NON_GRACEFUL_STOP_APPROVAL_REQUIRED' }
if ($task.GetInstances(0).Count -eq 0) { throw 'NO_RUNNING_TASK_TO_STOP' }
if ($null -eq $child) { throw 'CHILD_IDENTITY_NOT_AVAILABLE_INSPECT_BEFORE_STOP' }
[void](Write-ForwardHostEvent $m 'MANUAL_HOST_STOP_REQUESTED' @{ requesterPid=$PID; reason='EXPLICIT_MANUAL_STOP'
    childPid=$child.Id; graceful=$false; checkpointFlush='NOT_GUARANTEED'; automaticResume=$false })
# No arbitrary PID kill and no process-name kill. Stops this verified task and captured child only.
# Existing hidden runner has no externally validated graceful-control channel.
$task.Stop(0)
[void](Write-ForwardHostEvent $m 'SCHEDULER_STOP_RETURNED' @{ taskState=$task.State; lastRunResult=$task.LastTaskResult; terminationCompletion='VERIFY_WITH_CHILD_HANDLE' })
# On this host Task.Stop terminates the wrapper but can leave its child alive.
# Explicit manual stop authorizes terminating that exact captured child, not a tree/name sweep.
if (-not $child.WaitForExit(1000)) {
    [void](Write-ForwardHostEvent $m 'IDENTITY_VERIFIED_CHILD_TERMINATION_REQUESTED' @{ childPid=$child.Id; graceful=$false; checkpointFlush='NOT_GUARANTEED' })
    $child.Kill()
}
if (-not $child.WaitForExit(5000)) { throw 'CHILD_STOP_NOT_CONFIRMED_NO_AUTOMATIC_RETRY' }
Write-ForwardHostEvent $m 'MANUAL_CHILD_EXIT_CONFIRMED' @{ childPid=$child.Id; endedAt=$child.ExitTime.ToUniversalTime().ToString('o'); exitCode=$child.ExitCode
    cause='EXPLICIT_MANUAL_STOP'; graceful=$false; campaignCompletion='INCOMPLETE_NOT_INFERRED_FROM_EXIT_CODE' }
$child.Dispose()
