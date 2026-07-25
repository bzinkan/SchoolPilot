#requires -Version 7.5

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$deployPath = Join-Path $repoRoot 'scripts/deploy.sh'
$source = [IO.File]::ReadAllText($deployPath).Replace("`r`n", "`n")
$boundary = $source.IndexOf('# --- Preflight checks ---', [StringComparison]::Ordinal)
if ($boundary -le 0) {
    throw 'deploy.sh does not expose its helper library before preflight execution.'
}
$library = $source.Substring(0, $boundary)

$bashCandidates = @(
    'C:\Program Files\Git\bin\bash.exe',
    'C:\Program Files\Git\usr\bin\bash.exe',
    'C:\Program Files (x86)\Git\bin\bash.exe'
)
$bash = @($bashCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }) | Select-Object -First 1
if ([string]::IsNullOrWhiteSpace([string]$bash)) {
    throw 'The Windows rollout runner does not expose the required Git Bash executable.'
}

$probe = @"
$library
tzif_path=`$(production_eastern_tzif_path) || exit 91
printf 'tzif=%s\n' "`$tzif_path"
printf 'winter=%s\n' "`$(production_tzif_date_at_epoch "`$tzif_path" "1768478400" '+%u %H%M %z %Z')"
printf 'summer=%s\n' "`$(production_tzif_date_at_epoch "`$tzif_path" "1784116800" '+%u %H%M %z %Z')"
printf 'now=%s\n' "`$(production_eastern_weekday_hhmm)"
"@

$output = @($probe | & $bash -s 2>&1)
$exitCode = $LASTEXITCODE
$text = ($output | ForEach-Object { [string]$_ }) -join "`n"
if ($exitCode -ne 0) {
    throw "The Git Bash Eastern-clock probe failed closed (exit=$exitCode)."
}
if ($text -notmatch '(?m)^tzif=/(?:usr|mingw64)/share/zoneinfo/America/New_York$' -or
    $text -notmatch '(?m)^winter=4 0700 -0500 EST$' -or
    $text -notmatch '(?m)^summer=3 0800 -0400 EDT$' -or
    $text -notmatch '(?m)^now=[1-7] [0-2][0-9][0-5][0-9]$') {
    throw 'The Git Bash deployment clock did not bind verified America/New_York TZif data.'
}

Write-Output 'Git Bash production Eastern clock test: PASS'
