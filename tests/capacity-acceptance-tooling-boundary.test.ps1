#requires -Version 7.5

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$baselineSha = "f5759465b5a2ae43d4808c9aa53acc43c3c375b0"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

function Invoke-GitLines {
    param([Parameter(Mandatory)][string[]]$Arguments)

    # Keep Git's platform/line-ending warnings out of the path stream. The
    # exit code remains authoritative and a failure is reported without
    # reinterpreting stderr as a changed filename.
    $output = & git -C $repoRoot @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed while enforcing the capacity-acceptance tooling boundary."
    }
    return @($output | ForEach-Object { [string]$_ } | Where-Object { $_.Length -gt 0 })
}

function Test-AllowedCapacityAcceptancePath {
    param([Parameter(Mandatory)][string]$Path)

    $normalized = $Path.Replace("\", "/")
    if ($normalized.StartsWith("tests/", [StringComparison]::Ordinal)) {
        return $true
    }

    return $normalized -in @(
        ".github/workflows/ci-build.yml",
        "docs/AWS_COST_ROLLOUT_OPERATIONS.md",
        "docs/SCALE_READINESS.md",
        "scripts/deploy.sh",
        "scripts/load/aws-rollout-monitor.ps1",
        "scripts/load/classpilot-load-test.mjs",
        "scripts/load/start-aws-rollout-supervisor.ps1",
        "scripts/load/start-classpilot-capacity-acceptance.ps1"
    )
}

[void](Invoke-GitLines @("cat-file", "-e", "$baselineSha^{commit}"))

$changed = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($path in Invoke-GitLines @("diff", "--name-only", "--diff-filter=ACDMRTUXB", $baselineSha, "--")) {
    [void]$changed.Add($path.Replace("\", "/"))
}
foreach ($path in Invoke-GitLines @("ls-files", "--others", "--exclude-standard")) {
    [void]$changed.Add($path.Replace("\", "/"))
}

if ($changed.Count -eq 0) {
    throw "The capacity-acceptance successor must differ from the frozen baseline."
}

$violations = @($changed | Where-Object { -not (Test-AllowedCapacityAcceptancePath $_) } | Sort-Object)
if ($violations.Count -gt 0) {
    throw ("The capacity-acceptance successor changed files outside the tooling-only boundary:`n" +
        (($violations | ForEach-Object { " - $_" }) -join "`n"))
}

$requiredChanges = @(
    "scripts/deploy.sh",
    "scripts/load/aws-rollout-monitor.ps1",
    "scripts/load/classpilot-load-test.mjs",
    "scripts/load/start-aws-rollout-supervisor.ps1",
    "scripts/load/start-classpilot-capacity-acceptance.ps1"
)
foreach ($required in $requiredChanges) {
    if (-not $changed.Contains($required)) {
        throw "The capacity-acceptance successor is missing required tooling change '$required'."
    }
}

Write-Output ("Capacity-acceptance tooling boundary passed: {0} changed paths, all allowed relative to {1}." -f
    $changed.Count, $baselineSha)
