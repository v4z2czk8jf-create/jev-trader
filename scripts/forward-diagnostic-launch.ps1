[CmdletBinding()]
param(
    [string]$CampaignId,
    [string]$ExpectedRuntimeCommit,
    [string]$Approval,
    [string]$GitExecutablePath
)
. (Join-Path $PSScriptRoot 'forward-git.ps1')

# Diagnostic only: one child, no retries, restart, keep-awake or campaign mutation.
# Dot sourcing defines the helpers without starting a Forward process.
function Write-ForwardDiagnostic {
    param([System.IO.FileStream]$Stream, $Record)
    $bytes = [Text.Encoding]::UTF8.GetBytes(($Record | ConvertTo-Json -Depth 8 -Compress) + "`n")
    $Stream.Write($bytes, 0, $bytes.Length)
    $Stream.Flush($true)
}

function Get-ForwardBootEvidence {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $self = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop
    [ordered]@{
        bootId = $null # No invented Windows boot ID; boot time is the available evidence.
        bootTime = $os.LastBootUpTime.ToUniversalTime().ToString('o')
        bootTimeSource = 'Win32_OperatingSystem.LastBootUpTime'
        wrapperPid = $PID
        launcherParentPid = $self.ParentProcessId
    }
}

function Invoke-ForwardDiagnosticChild {
    param(
        [string]$Executable, [string]$Arguments, [string]$WorkingDirectory,
        [string]$LogDirectory, $Identity, $BootEvidence,
        [hashtable]$ChildEnvironment = @{}
    )
    if (Test-Path -LiteralPath $LogDirectory) { throw 'DIAGNOSTIC_DIRECTORY_EXISTS' }
    [void][IO.Directory]::CreateDirectory($LogDirectory)
    $journal = $null; $stdout = $null; $stderr = $null; $child = $null
    try {
        $journal = [IO.FileStream]::new((Join-Path $LogDirectory 'lifecycle.jsonl'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        $stdout = [IO.FileStream]::new((Join-Path $LogDirectory 'stdout.log'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        $stderr = [IO.FileStream]::new((Join-Path $LogDirectory 'stderr.log'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        $context = [ordered]@{
            schema = 'forward-exit-diagnostic-v1'; identity = $Identity; boot = $BootEvidence
            parentPid = $PID; automaticRestart = $false; deadlineExtension = $false
        }
        Write-ForwardDiagnostic $journal ([ordered]@{
            event = 'LAUNCH_INTENT'; at = [DateTimeOffset]::UtcNow.ToString('o'); context = $context
            childPid = $null; startedAt = $null; endedAt = $null; exitCode = $null
        })
        $info = [Diagnostics.ProcessStartInfo]::new()
        $info.FileName = $Executable; $info.Arguments = $Arguments
        $info.WorkingDirectory = $WorkingDirectory
        $info.UseShellExecute = $false; $info.CreateNoWindow = $true
        $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
        foreach ($key in $ChildEnvironment.Keys) { $info.EnvironmentVariables[$key] = $ChildEnvironment[$key] }
        $child = [Diagnostics.Process]::new(); $child.StartInfo = $info
        if (-not $child.Start()) { throw 'CHILD_NOT_STARTED' }
        $outCopy = $child.StandardOutput.BaseStream.CopyToAsync($stdout)
        $errCopy = $child.StandardError.BaseStream.CopyToAsync($stderr)
        $startedAt = $child.StartTime.ToUniversalTime().ToString('o')
        Write-ForwardDiagnostic $journal ([ordered]@{
            event = 'CHILD_STARTED'; at = [DateTimeOffset]::UtcNow.ToString('o'); context = $context
            childPid = $child.Id; startedAt = $startedAt; endedAt = $null; exitCode = $null
        })
        $child.WaitForExit() # Wait for this child only; never restart or kill it.
        $exitCode = $child.ExitCode
        $endedAt = $child.ExitTime.ToUniversalTime().ToString('o')
        # Persist the exit observation before waiting for redirected streams to drain.
        Write-ForwardDiagnostic $journal ([ordered]@{
            event = 'CHILD_EXIT_OBSERVED'; at = [DateTimeOffset]::UtcNow.ToString('o'); context = $context
            childPid = $child.Id; startedAt = $startedAt; endedAt = $endedAt; exitCode = $exitCode
            reason = 'PROCESS_EXIT_OBSERVED'; cause = 'UNKNOWN'
            campaignCompletion = 'NOT_INFERRED_FROM_EXIT_CODE'
        })
        [void]$outCopy.GetAwaiter().GetResult(); [void]$errCopy.GetAwaiter().GetResult()
        $stdout.Flush($true); $stderr.Flush($true)
        return $exitCode
    } catch {
        if ($journal) {
            try {
                Write-ForwardDiagnostic $journal ([ordered]@{
                    event = 'DIAGNOSTIC_FAILURE'; at = [DateTimeOffset]::UtcNow.ToString('o')
                    # Do not log command lines, environment variables or exception messages.
                    errorType = $_.Exception.GetType().FullName
                    childPid = if ($child) { try { $child.Id } catch { $null } } else { $null }
                    childTerminationRequested = $false; automaticRestart = $false
                })
            } catch { [Console]::Error.WriteLine('DIAGNOSTIC_LOG_WRITE_FAILED') }
        }
        throw
    } finally {
        if ($stdout) { $stdout.Dispose() }; if ($stderr) { $stderr.Dispose() }
        if ($journal) { $journal.Dispose() }; if ($child) { $child.Dispose() }
    }
}

function Assert-ForwardDiagnosticLaunch {
    param([string]$Id, [string]$Commit, [string]$Consent, [string]$Root, $GitPin)
    if ($Consent -cne 'START_NEW_7D_FORWARD_WITH_EXIT_DIAGNOSTICS') { throw 'EXPLICIT_NEW_CAMPAIGN_APPROVAL_REQUIRED' }
    if ($Id -notmatch '^kuru-mon-usdc-forward-v1-[0-9]{8}-[0-9]{2}$') { throw 'INVALID_CAMPAIGN_ID' }
    if ($Id -eq 'kuru-mon-usdc-forward-v1-20260921-01') { throw 'OLD_CAMPAIGN_MUST_NOT_RESUME' }
    if ($Commit -notmatch '^[0-9a-f]{40}$') { throw 'EXPECTED_RUNTIME_COMMIT_REQUIRED' }
    if (Test-Path -LiteralPath (Join-Path $Root "data/kuru-forward/$Id")) { throw 'CAMPAIGN_ALREADY_EXISTS' }
    if ($env:DRY_RUN -cne 'true' -or $env:MODEL -cne 'mock') { throw 'DRY_RUN_MOCK_REQUIRED' }
    foreach ($name in @('PRIVATE_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY')) {
        if ([Environment]::GetEnvironmentVariable($name)) { throw 'SECRET_ENVIRONMENT_REFUSED_WITHOUT_DISPLAY' }
    }
    if ((Invoke-ForwardPinnedGit $GitPin $Root @('--version')) -cne $GitPin.gitVersion) { throw 'GIT_VERSION_MISMATCH' }
    $head = Invoke-ForwardPinnedGit $GitPin $Root @('rev-parse','HEAD')
    if ($head -cne $Commit) { throw 'RUNTIME_COMMIT_MISMATCH' }
    $status = Invoke-ForwardPinnedGit $GitPin $Root @('status','--porcelain=v1','--untracked-files=all')
    if ($status) { throw 'RUNTIME_WORKTREE_DIRTY' }
}

if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'
    $repo = Split-Path -Parent $PSScriptRoot
    $gitPin=Get-ForwardGitEvidence $GitExecutablePath $repo
    Assert-ForwardDiagnosticLaunch $CampaignId $ExpectedRuntimeCommit $Approval $repo $gitPin
    $boot = Get-ForwardBootEvidence
    $bun = (Get-Command bun.exe -ErrorAction Stop).Source
    $logs = Join-Path $repo ("data/kuru-forward-diagnostics/{0}-{1}" -f $CampaignId, [Guid]::NewGuid().ToString('N'))
    $arguments = "--no-env-file run src/forward-observation/runner.ts --campaign $CampaignId --mode forward --approval START_OR_RESUME_7D_FORWARD --seconds 619200 --max-rpc 1000000"
    $identity = [ordered]@{ campaignId = $CampaignId; runtimeCodeCommit = $ExpectedRuntimeCommit
        ruleSourceCommit = '91e0b07a7638f0c575ceabd8fb770c7e89eda88c'; observationOnly = $true
        gitExecutablePath=$gitPin.gitExecutablePath; gitVersion=$gitPin.gitVersion; gitSha256=$gitPin.gitSha256 }
    $code = Invoke-ForwardDiagnosticChild $bun $arguments $repo $logs $identity $boot @{ DRY_RUN='true'; MODEL='mock'
        FORWARD_GIT_EXECUTABLE=$gitPin.gitExecutablePath; FORWARD_GIT_VERSION=$gitPin.gitVersion; FORWARD_GIT_SHA256=$gitPin.gitSha256; FORWARD_RUNTIME_COMMIT=$ExpectedRuntimeCommit }
    exit $code
}
