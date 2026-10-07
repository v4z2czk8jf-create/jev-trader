[CmdletBinding()]
param([Parameter(Mandatory)][string]$ManifestPath, [switch]$Record)
. (Join-Path $PSScriptRoot 'forward-task-common.ps1')
$m=Read-ForwardHostManifest $ManifestPath
$task=Get-ForwardOwnedTask $m $ManifestPath
$instances=@($task.GetInstances(0) | ForEach-Object { @{ instanceId=$_.InstanceGuid; enginePid=$_.EnginePID; state=$_.State } })
$lifecyclePath=Join-Path $m.logDirectory 'child/lifecycle.jsonl'
$life=if (Test-Path -LiteralPath $lifecyclePath) {@(Get-Content -LiteralPath $lifecyclePath | ForEach-Object { $_ | ConvertFrom-Json })} else {@()}
$childStart=@($life | Where-Object event -eq 'CHILD_STARTED'); $childExit=@($life | Where-Object event -eq 'CHILD_EXIT_OBSERVED')
$status=[ordered]@{ checkedAt=[DateTimeOffset]::UtcNow.ToString('o'); taskName=$m.taskName; taskState=$task.State
    instances=$instances; lastRunTime=$task.LastRunTime.ToString('o'); lastRunResult=$task.LastTaskResult
    lastRunResultIsFinal=($instances.Count -eq 0 -and $task.State -notin 2,4); runtimeCommit=$m.runtimeCommit; ruleCommit=$m.ruleCommit; campaignId=$m.campaignId
    childStart=$childStart; childExit=$childExit; exitWithoutRecordIsUnknown=$true; automaticRestart=$false }
if ($Record) { [void](Write-ForwardHostEvent $m 'TASK_STATUS_OBSERVED' $status) }
[pscustomobject]$status
