[CmdletBinding()]
param([Parameter(Mandatory)][string]$ManifestPath)
. (Join-Path $PSScriptRoot 'forward-task-common.ps1')
$m=Read-ForwardHostManifest $ManifestPath
Assert-ForwardHostFiles $m
Assert-ForwardBunBinary $m
$permit=Get-Content -LiteralPath (Join-Path $m.logDirectory 'start-permit.json') -Raw | ConvertFrom-Json
$required=if ($m.mode -ceq 'Fixture') {'START_HARMLESS_HOST_FIXTURE'} else {'START_NEW_7D_FORWARD_TASK_HOST'}
if ($permit.manifestHash -cne (Get-FileHash -LiteralPath $ManifestPath).Hash.ToLowerInvariant() -or $permit.approval -cne $required) { throw 'START_PERMIT_MISMATCH' }
Write-ForwardHostJson (Join-Path $m.logDirectory 'permit-consumed.json') @{ at=[DateTimeOffset]::UtcNow.ToString('o'); hostPid=$PID }
$task=Get-ForwardOwnedTask $m $ManifestPath
$instances=@($task.GetInstances(0)); $instanceId=if ($instances.Count -eq 1) {$instances[0].InstanceGuid} else {$null}
. (Join-Path $PSScriptRoot 'forward-diagnostic-launch.ps1')
$exitCode=1
try {
    $boot=Get-ForwardBootEvidence
    [void](Write-ForwardHostEvent $m 'HOST_STARTED' @{ taskInstanceId=$instanceId; hostPid=$PID; parentPid=$boot.launcherParentPid
        startedAt=[DateTimeOffset]::UtcNow.ToString('o'); boot=$boot; mode=$m.mode })
    $identity=@{ provenance=if ($m.mode -ceq 'Fixture') {'SYNTHETIC_FIXTURE_NOT_FORWARD'} else {'FORWARD_OBSERVATION'}
        campaignId=$m.campaignId; runtimeCodeCommit=$m.runtimeCommit; ruleSourceCommit=$m.ruleCommit; taskInstanceId=$instanceId
        bunExecutablePath=$m.bunExecutablePath; bunVersion=$m.bunVersion; bunSha256=$m.bunSha256
        gitExecutablePath=$m.gitExecutablePath; gitVersion=$m.gitVersion; gitSha256=$m.gitSha256 }
    $env:DRY_RUN='true'; $env:MODEL='mock'
    if ($m.mode -ceq 'Fixture' -and $m.fixtureRuntime -ceq 'PowerShell') {
        $childArguments='-NoLogo -NoProfile -NonInteractive -File "' + (Join-Path $PSScriptRoot 'forward-task-fixture.ps1') + '" -LogDirectory "' + $m.logDirectory + '" -Seconds ' + $m.fixtureSeconds
        $executable=$m.powerShell
    } elseif ($m.mode -ceq 'Fixture') {
        $childArguments='--no-env-file run "' + (Join-Path $PSScriptRoot 'forward-task-bun-fixture.ts') + '" "' + $ManifestPath + '"'
        $executable=$m.bunExecutablePath
    } else {
        Assert-ForwardDiagnosticLaunch $m.campaignId $m.runtimeCommit 'START_NEW_7D_FORWARD_WITH_EXIT_DIAGNOSTICS' $m.repoRoot $m
        $executable=$m.bunExecutablePath
        $childArguments="--no-env-file run src/forward-observation/runner.ts --campaign $($m.campaignId) --mode forward --approval START_OR_RESUME_7D_FORWARD --seconds 619200 --max-rpc 1000000"
    }
    $exitCode=Invoke-ForwardDiagnosticChild $executable $childArguments $m.repoRoot (Join-Path $m.logDirectory 'child') $identity $boot @{ DRY_RUN='true'; MODEL='mock'; FORWARD_HOST_MANIFEST=$ManifestPath }
    [void](Write-ForwardHostEvent $m 'HOST_CHILD_EXIT_OBSERVED' @{ taskInstanceId=$instanceId; hostPid=$PID; endedAt=[DateTimeOffset]::UtcNow.ToString('o')
        exitCode=$exitCode; underlyingCause='UNKNOWN'; campaignCompletion='NOT_INFERRED_FROM_EXIT_CODE' })
} catch {
    [void](Write-ForwardHostEvent $m 'HOST_FAILED' @{ taskInstanceId=$instanceId; hostPid=$PID; hresult=$_.Exception.HResult; errorType=$_.Exception.GetType().FullName; automaticRestart=$false })
    $exitCode=1
}
exit $exitCode
