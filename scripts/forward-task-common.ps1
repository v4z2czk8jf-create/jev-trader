Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:ForwardTaskName = 'Kuru-Forward-Observation-v1'
$script:ForwardRuleCommit = '91e0b07a7638f0c575ceabd8fb770c7e89eda88c'
$script:ForwardHostRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'forward-git.ps1')

function Get-ForwardBunEvidence {
    param([string]$ExecutablePath, [string]$ExpectedVersion='1.3.14')
    if (-not [IO.Path]::IsPathFullyQualified($ExecutablePath) -or $ExecutablePath -match '["\r\n]' -or
        -not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) { throw 'ABSOLUTE_EXISTING_BUN_REQUIRED' }
    $resolved=[IO.Path]::GetFullPath($ExecutablePath)
    $sha=(Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant()
    $info=[Diagnostics.ProcessStartInfo]::new()
    $info.FileName=$resolved; $info.Arguments='--no-env-file --version'; $info.WorkingDirectory=$script:ForwardHostRoot
    $info.UseShellExecute=$false; $info.CreateNoWindow=$true; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
    $info.EnvironmentVariables['DRY_RUN']='true'; $info.EnvironmentVariables['MODEL']='mock'
    $probe=[Diagnostics.Process]::Start($info)
    try {
        $stdout=$probe.StandardOutput.ReadToEndAsync(); $stderr=$probe.StandardError.ReadToEndAsync()
        if (-not $probe.WaitForExit(10000)) { $probe.Kill(); [void]$probe.WaitForExit(5000); throw 'BUN_VERSION_PROBE_TIMEOUT' }
        $version=$stdout.GetAwaiter().GetResult().Trim(); [void]$stderr.GetAwaiter().GetResult()
        if ($probe.ExitCode -ne 0 -or $version -cne $ExpectedVersion) { throw 'BUN_VERSION_MISMATCH_OR_NOT_EXECUTABLE' }
        if ((Get-FileHash -LiteralPath $resolved).Hash.ToLowerInvariant() -cne $sha) { throw 'BUN_CHANGED_DURING_VERSION_PROBE' }
        return @{ bunExecutablePath=$resolved; bunVersion=$version; expectedBunVersion=$ExpectedVersion; bunSha256=$sha }
    } finally { $probe.Dispose() }
}
function Assert-ForwardBunBinary {
    param($Manifest)
    if (-not [IO.Path]::IsPathFullyQualified($Manifest.bunExecutablePath) -or $Manifest.bunExecutablePath -match '["\r\n]' -or
        -not (Test-Path -LiteralPath $Manifest.bunExecutablePath -PathType Leaf)) { throw 'ABSOLUTE_EXISTING_BUN_REQUIRED' }
    if ($Manifest.bunVersion -cne $Manifest.expectedBunVersion -or $Manifest.bunVersion -cne '1.3.14') { throw 'BUN_VERSION_PIN_MISMATCH' }
    if ($Manifest.bunSha256 -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $Manifest.bunExecutablePath).Hash.ToLowerInvariant() -cne $Manifest.bunSha256) { throw 'BUN_BINARY_HASH_MISMATCH' }
}

function Write-ForwardHostJson {
    param([string]$Path, $Value)
    # Exclusive creation: evidence, authorization and single-use markers are never replaced.
    $f = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $b = [Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 12 -Compress) + "`n"); $f.Write($b, 0, $b.Length); $f.Flush($true) }
    finally { $f.Dispose() }
}
function Write-ForwardHostEvent {
    param($Manifest, [string]$Event, $Detail)
    $record = [ordered]@{ schema='forward-task-host-event-v1'; event=$Event; at=[DateTimeOffset]::UtcNow.ToString('o')
        taskName=$Manifest.taskName; campaignId=$Manifest.campaignId; runtimeCommit=$Manifest.runtimeCommit
        ruleCommit=$Manifest.ruleCommit; bunExecutablePath=$Manifest.bunExecutablePath; bunVersion=$Manifest.bunVersion
        expectedBunVersion=$Manifest.expectedBunVersion; bunSha256=$Manifest.bunSha256
        gitExecutablePath=$Manifest.gitExecutablePath; gitVersion=$Manifest.gitVersion; gitSha256=$Manifest.gitSha256; detail=$Detail }
    Write-ForwardHostJson (Join-Path $Manifest.logDirectory ("event-" + [Guid]::NewGuid().ToString('N') + '.json')) $record
    return $record
}
function Assert-ForwardHostManifest {
    param($Manifest, [string]$Path)
    if ($Manifest.schema -cne 'forward-task-host-v1' -or $Manifest.taskName -cne $script:ForwardTaskName) { throw 'UNEXPECTED_HOST_MANIFEST' }
    if ($Manifest.ruleCommit -cne $script:ForwardRuleCommit -or $Manifest.runtimeCommit -notmatch '^[a-f0-9]{40}$') { throw 'PROVENANCE_REFUSED' }
    if ($Manifest.mode -cnotin @('Fixture','Forward')) { throw 'UNKNOWN_HOST_MODE' }
    Assert-ForwardGitBinary $Manifest
    if ($Manifest.fixtureRuntime -cnotin @('PowerShell','Bun')) { throw 'UNKNOWN_FIXTURE_RUNTIME' }
    if (-not [IO.Path]::IsPathFullyQualified($Manifest.bunExecutablePath) -or $Manifest.bunVersion -cne $Manifest.expectedBunVersion -or
        $Manifest.bunVersion -cne '1.3.14' -or $Manifest.bunSha256 -notmatch '^[a-f0-9]{64}$') { throw 'BUN_PROVENANCE_REQUIRED' }
    if ($Manifest.campaignId -cin @('kuru-mon-usdc-forward-v1-20260921-01','kuru-mon-usdc-forward-v1-20260922-01')) { throw 'INTERRUPTED_CAMPAIGN_MUST_NOT_RESUME' }
    if ($Manifest.mode -ceq 'Fixture' -and $Manifest.campaignId -notmatch '^fixture-forward-host-[a-f0-9]{32}$') { throw 'FIXTURE_ID_REQUIRED' }
    if ($Manifest.mode -ceq 'Forward' -and $Manifest.campaignId -notmatch '^kuru-mon-usdc-forward-v1-[0-9]{8}-[0-9]{2}$') { throw 'NEW_CAMPAIGN_ID_REQUIRED' }
    if ($Manifest.repoRoot -cne $script:ForwardHostRoot) { throw 'HOST_REPOSITORY_MISMATCH' }
    $parent = [IO.Path]::GetFullPath((Join-Path $script:ForwardHostRoot 'data/forward-task-host')) + [IO.Path]::DirectorySeparatorChar
    $directory = [IO.Path]::GetFullPath($Manifest.logDirectory)
    if (-not $directory.StartsWith($parent, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFullPath($Path) -cne (Join-Path $directory 'manifest.json')) { throw 'HOST_PATH_MISMATCH' }
    if ($Manifest.fixtureSeconds -lt 1 -or $Manifest.fixtureSeconds -gt 120) { throw 'FIXTURE_DURATION_BOUND' }
    foreach ($p in @($Manifest.powerShell, $Manifest.repoRoot, $Path)) {
        if ($p -match '["\r\n]' -or -not [IO.Path]::IsPathFullyQualified($p)) { throw 'UNSAFE_HOST_PATH' }
    }
    if ($Manifest.dryRun -cne 'true' -or $Manifest.model -cne 'mock' -or -not $Manifest.noEnvFile) { throw 'HOST_SAFETY_MISMATCH' }
    if ($Manifest.automaticRestart -or $Manifest.automaticExtension -or $Manifest.automaticResume) { throw 'AUTOMATION_REFUSED' }
}
function Read-ForwardHostManifest {
    param([string]$Path)
    $m = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    Assert-ForwardHostManifest $m $Path
    return $m
}
function Get-ForwardHostArguments {
    param([string]$ManifestPath)
    $ManifestPath=[IO.Path]::GetFullPath($ManifestPath)
    return '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "' + (Join-Path $script:ForwardHostRoot 'scripts/forward-task-host.ps1') + '" -ManifestPath "' + $ManifestPath + '"'
}
function New-ForwardTaskXml {
    param($Manifest, [string]$ManifestPath)
    Assert-ForwardHostManifest $Manifest $ManifestPath
    $escape = { param($s) [Security.SecurityElement]::Escape([string]$s) }
    $exe = & $escape $Manifest.powerShell; $arguments = & $escape (Get-ForwardHostArguments $ManifestPath)
    $root = & $escape $Manifest.repoRoot; $sid = & $escape $Manifest.userSid
    return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Kuru Forward observation host; explicit single-use demand start only.</Description></RegistrationInfo>
  <Triggers />
  <Principals><Principal id="Owner"><UserId>$sid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority>
  </Settings>
  <Actions Context="Owner"><Exec><Command>$exe</Command><Arguments>$arguments</Arguments><WorkingDirectory>$root</WorkingDirectory></Exec></Actions>
</Task>
"@
}
function Assert-ForwardTaskDefinition {
    param([string]$Xml, $Manifest, [string]$ManifestPath)
    [xml]$x = $Xml
    $ns = [Xml.XmlNamespaceManager]::new($x.NameTable); $ns.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    if ($x.SelectNodes('/t:Task/t:Triggers/*', $ns).Count -ne 0 -or $x.SelectNodes('//t:RestartOnFailure', $ns).Count -ne 0) { throw 'TASK_AUTO_START_OR_RESTART_REFUSED' }
    $expected = @{
        '/t:Task/t:Settings/t:MultipleInstancesPolicy'='IgnoreNew'; '/t:Task/t:Settings/t:ExecutionTimeLimit'='PT0S'
        '/t:Task/t:Settings/t:StartWhenAvailable'='false'; '/t:Task/t:Settings/t:WakeToRun'='false'
        '/t:Task/t:Settings/t:AllowStartOnDemand'='true'; '/t:Task/t:Settings/t:Enabled'='true'
        '/t:Task/t:Settings/t:AllowHardTerminate'='true'; '/t:Task/t:Settings/t:RunOnlyIfIdle'='false'
        '/t:Task/t:Settings/t:DisallowStartIfOnBatteries'='true'; '/t:Task/t:Settings/t:StopIfGoingOnBatteries'='false'
        '/t:Task/t:Settings/t:IdleSettings/t:StopOnIdleEnd'='false'; '/t:Task/t:Settings/t:IdleSettings/t:RestartOnIdle'='false'
        '/t:Task/t:Principals/t:Principal/t:RunLevel'='LeastPrivilege'; '/t:Task/t:Principals/t:Principal/t:LogonType'='InteractiveToken'
        '/t:Task/t:Principals/t:Principal/t:UserId'=$Manifest.userSid
        '/t:Task/t:Actions/t:Exec/t:Command'=$Manifest.powerShell
        '/t:Task/t:Actions/t:Exec/t:Arguments'=(Get-ForwardHostArguments $ManifestPath)
        '/t:Task/t:Actions/t:Exec/t:WorkingDirectory'=$Manifest.repoRoot
    }
    if ($x.SelectNodes('/t:Task/t:Actions/*', $ns).Count -ne 1 -or $x.SelectNodes('/t:Task/t:Principals/*', $ns).Count -ne 1) { throw 'EXTRA_TASK_ACTION_OR_PRINCIPAL' }
    # Scheduler exports omit default-valued nodes. Accept only documented defaults;
    # critically, absent ExecutionTimeLimit remains rejected (its default is 72h).
    $defaults=@{
        '/t:Task/t:Settings/t:StartWhenAvailable'='false'; '/t:Task/t:Settings/t:WakeToRun'='false'
        '/t:Task/t:Settings/t:AllowStartOnDemand'='true'; '/t:Task/t:Settings/t:Enabled'='true'
        '/t:Task/t:Settings/t:AllowHardTerminate'='true'; '/t:Task/t:Settings/t:RunOnlyIfIdle'='false'
        '/t:Task/t:Principals/t:Principal/t:RunLevel'='LeastPrivilege'
    }
    foreach ($path in $expected.Keys) {
        $node=$x.SelectSingleNode($path,$ns)
        $value=if ($null -ne $node) {$node.InnerText} elseif ($defaults.ContainsKey($path)) {$defaults[$path]} else {$null}
        if ($value -cne $expected[$path]) { throw "TASK_DEFINITION_MISMATCH: $path" }
    }
}
function Get-ForwardTaskFolder {
    $service = New-Object -ComObject Schedule.Service
    $service.Connect() # Current user only; no password, alternate credentials or remote host.
    return $service.GetFolder('\')
}
function Get-ForwardOwnedTask {
    param($Manifest, [string]$ManifestPath)
    $task = (Get-ForwardTaskFolder).GetTask($Manifest.taskName)
    Assert-ForwardTaskDefinition $task.Xml $Manifest $ManifestPath
    return $task
}
function Assert-ForwardHostFiles {
    param($Manifest)
    foreach ($name in $Manifest.files.PSObject.Properties.Name) {
        $actual = (Get-FileHash -LiteralPath (Join-Path $Manifest.repoRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -cne $Manifest.files.$name) { throw 'HOST_FILE_HASH_MISMATCH' }
    }
}
