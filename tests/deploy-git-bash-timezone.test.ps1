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
# The helper validates winter/summer TZif data before reading the live clock.
# Bracket that work so crossing a minute or day boundary is still valid.
expected_before=`$(TZ=:"`$tzif_path" date '+%u %H%M') || exit 92
actual_now=`$(production_eastern_weekday_hhmm) || exit 93
expected_after=`$(TZ=:"`$tzif_path" date '+%u %H%M') || exit 92
printf 'expectedBefore=%s\n' "`$expected_before"
printf 'now=%s\n' "`$actual_now"
printf 'expectedAfter=%s\n' "`$expected_after"
[[ "`$actual_now" == "`$expected_before" || "`$actual_now" == "`$expected_after" ]] || exit 94
"@

$output = @($probe | & $bash -s 2>&1)
$exitCode = $LASTEXITCODE
$text = ($output | ForEach-Object { [string]$_ }) -join "`n"
if ($exitCode -ne 0) {
    throw "The Git Bash Eastern-clock probe failed closed (exit=$exitCode): $text"
}
if ($text -notmatch '(?m)^tzif=/(?:usr|mingw64|ucrt64)/share/zoneinfo/America/New_York$' -or
    $text -notmatch '(?m)^winter=4 0700 -0500 EST$' -or
    $text -notmatch '(?m)^summer=3 0800 -0400 EDT$' -or
    $text -notmatch '(?m)^expectedBefore=[1-7] [0-2][0-9][0-5][0-9]$' -or
    $text -notmatch '(?m)^expectedAfter=[1-7] [0-2][0-9][0-5][0-9]$' -or
    $text -notmatch '(?m)^now=[1-7] [0-2][0-9][0-5][0-9]$') {
    throw 'The Git Bash deployment clock did not bind verified America/New_York TZif data.'
}

# Exercise the actual helper with only the UCRT64 candidate present, even on
# older Git installations. Redirect only the three fixed lookup paths into an
# owned temporary tree; the real TZif/date validation stays unchanged.
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('schoolpilot-tzif-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($scratch) | Out-Null
try {
    $scratchPosix = (& $bash -c 'cygpath -u "$1"' -- $scratch).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($scratchPosix)) {
        throw 'Could not map the owned TZif fixture directory into Git Bash.'
    }
    $testLibrary = $library
    $apostrophe = [string][char]39
    $escapedApostrophe = $apostrophe + '"' + $apostrophe + '"' + $apostrophe
    foreach ($prefix in @('usr', 'mingw64', 'ucrt64')) {
        $original = '"/' + $prefix + '/share/zoneinfo/America/New_York"'
        if (-not $testLibrary.Contains($original)) { throw "Missing fixed TZif lookup path: $prefix" }
        $candidate = $scratchPosix + '/' + $prefix + '/New_York'
        $literal = $apostrophe + $candidate.Replace($apostrophe, $escapedApostrophe) + $apostrophe
        $testLibrary = $testLibrary.Replace($original, $literal)
    }
    $selected = [regex]::Match($text, '(?m)^tzif=(/[^\r\n]+)').Groups[1].Value
    $gitRoot = Split-Path -Parent (Split-Path -Parent $bash)
    $validTzif = Join-Path $gitRoot $selected.TrimStart('/').Replace('/', [IO.Path]::DirectorySeparatorChar)
    $fixture = Join-Path (Join-Path $scratch 'ucrt64') 'New_York'
    [IO.Directory]::CreateDirectory((Split-Path -Parent $fixture)) | Out-Null
    [IO.File]::Copy($validTzif, $fixture)
    $positiveProbe = $testLibrary + "`nproduction_eastern_tzif_path || exit 91`n"
    $positiveOutput = @($positiveProbe | & $bash -s 2>&1)
    if ($LASTEXITCODE -ne 0 -or ($positiveOutput -join "`n") -cne ($scratchPosix + '/ucrt64/New_York')) {
        throw 'The real Eastern-clock helper did not select the sole verified UCRT64 TZif fixture.'
    }
    foreach ($defect in @('malformed', 'missing')) {
        if ($defect -eq 'malformed') { [IO.File]::WriteAllText($fixture, 'invalid TZif data') }
        else { Remove-Item -LiteralPath $fixture }
        $negativeOutput = @($positiveProbe | & $bash -s 2>&1)
        if ($LASTEXITCODE -ne 91) {
            throw "The real Eastern-clock helper accepted $defect timezone data: $($negativeOutput -join ' ')"
        }
    }
} finally {
    $resolvedScratch = [IO.Path]::GetFullPath($scratch)
    if ((Split-Path -Parent $resolvedScratch) -ne [IO.Path]::GetTempPath().TrimEnd('\', '/') -or
        (Split-Path -Leaf $resolvedScratch) -notmatch '^schoolpilot-tzif-[a-f0-9]{32}$') {
        throw 'Refusing cleanup outside the exact owned TZif test directory.'
    }
    Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
}

Write-Output 'Git Bash production Eastern clock test: PASS'
