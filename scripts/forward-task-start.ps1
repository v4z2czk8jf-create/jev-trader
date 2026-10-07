[CmdletBinding()]
param([Parameter(Mandatory)][string]$ManifestPath, [string]$Approval)
. (Join-Path $PSScriptRoot 'forward-task-common.ps1')
$m=Read-ForwardHostManifest $ManifestPath
Assert-ForwardHostFiles $m
Assert-ForwardBunBinary $m
$required=if ($m.mode -ceq 'Fixture') {'START_HARMLESS_HOST_FIXTURE'} else {'START_NEW_7D_FORWARD_TASK_HOST'}
if ($Approval -cne $required) { throw 'EXPLICIT_SINGLE_RUN_START_APPROVAL_REQUIRED' }
if ($m.mode -ceq 'Forward') {
    . (Join-Path $PSScriptRoot 'forward-diagnostic-launch.ps1')
    Assert-ForwardDiagnosticLaunch $m.campaignId $m.runtimeCommit 'START_NEW_7D_FORWARD_WITH_EXIT_DIAGNOSTICS' $m.repoRoot $m
}
$task=Get-ForwardOwnedTask $m $ManifestPath
if ($task.State -in 2,4 -or $task.GetInstances(0).Count -gt 0) { throw 'TASK_ALREADY_QUEUED_OR_RUNNING' }
$hash=(Get-FileHash -LiteralPath $ManifestPath).Hash.ToLowerInvariant()
# Permanent single-use intent; a failed attempt is not silently retried on the next invocation.
Write-ForwardHostJson (Join-Path $m.logDirectory 'start-permit.json') @{ manifestHash=$hash; approval=$required; requestedAt=[DateTimeOffset]::UtcNow.ToString('o'); requesterPid=$PID }
try {
    $instance=$task.Run($null)
    Write-ForwardHostEvent $m 'TASK_RUN_REQUESTED' @{ taskInstanceId=$instance.InstanceGuid; enginePid=$instance.EnginePID; requesterPid=$PID
        taskState=$instance.State; enginePidIsNotAssumedChildPid=$true }
} catch { [void](Write-ForwardHostEvent $m 'TASK_RUN_REQUEST_FAILED' @{ hresult=$_.Exception.HResult; automaticRetry=$false }); throw }
