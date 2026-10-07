# Read-only Git provenance shared by the host and diagnostic wrapper. No PATH changes.
function Assert-ForwardGitBinary {
    param($Pin)
    if (-not $Pin -or -not [IO.Path]::IsPathFullyQualified($Pin.gitExecutablePath) -or
        $Pin.gitExecutablePath -match '["\r\n]' -or -not (Test-Path -LiteralPath $Pin.gitExecutablePath -PathType Leaf)) { throw 'ABSOLUTE_EXISTING_GIT_REQUIRED' }
    if ($Pin.gitVersion -notmatch '^git version [^\r\n]+$' -or $Pin.gitSha256 -notmatch '^[a-f0-9]{64}$' -or
        (Get-FileHash -LiteralPath $Pin.gitExecutablePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Pin.gitSha256) { throw 'GIT_BINARY_PROVENANCE_MISMATCH' }
}
function Invoke-ForwardPinnedGit {
    param($Pin, [string]$Root, [string[]]$Arguments)
    Assert-ForwardGitBinary $Pin
    $info=[Diagnostics.ProcessStartInfo]::new()
    $info.FileName=$Pin.gitExecutablePath; $info.WorkingDirectory=$Root
    $info.UseShellExecute=$false; $info.CreateNoWindow=$true; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
    foreach($arg in (@('--no-optional-locks','-C',$Root)+$Arguments)) {[void]$info.ArgumentList.Add($arg)}
    $p=[Diagnostics.Process]::Start($info)
    try {
        $stdout=$p.StandardOutput.ReadToEndAsync(); $stderr=$p.StandardError.ReadToEndAsync()
        if(-not $p.WaitForExit(10000)){ $p.Kill(); [void]$p.WaitForExit(5000); throw 'GIT_READ_TIMEOUT' }
        $value=$stdout.GetAwaiter().GetResult(); [void]$stderr.GetAwaiter().GetResult()
        if($p.ExitCode -ne 0){throw 'GIT_READ_FAILED'}
        Assert-ForwardGitBinary $Pin
        return $value.TrimEnd()
    } finally {$p.Dispose()}
}
function Get-ForwardGitEvidence {
    param([string]$ExecutablePath, [string]$Root)
    if(-not [IO.Path]::IsPathFullyQualified($ExecutablePath) -or $ExecutablePath -match '["\r\n]' -or
        -not(Test-Path -LiteralPath $ExecutablePath -PathType Leaf)){throw 'ABSOLUTE_EXISTING_GIT_REQUIRED'}
    $pin=[pscustomobject]@{gitExecutablePath=[IO.Path]::GetFullPath($ExecutablePath);gitVersion='git version pending';gitSha256=(Get-FileHash -LiteralPath $ExecutablePath -Algorithm SHA256).Hash.ToLowerInvariant()}
    $pin.gitVersion=Invoke-ForwardPinnedGit $pin $Root @('--version')
    Assert-ForwardGitBinary $pin
    return $pin
}
