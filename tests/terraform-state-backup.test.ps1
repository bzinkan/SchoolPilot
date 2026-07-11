#requires -Version 7.0

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-Condition {
    param(
        [Parameter(Mandatory = $true)]
        [bool]$Condition,

        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Test-BytesEqual {
    param(
        [Parameter(Mandatory = $true)]
        [byte[]]$Left,

        [Parameter(Mandatory = $true)]
        [byte[]]$Right
    )

    if ($Left.Length -ne $Right.Length) {
        return $false
    }
    for ($index = 0; $index -lt $Left.Length; $index++) {
        if ($Left[$index] -ne $Right[$index]) {
            return $false
        }
    }
    return $true
}

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$backupScript = Join-Path $repositoryRoot "scripts\terraform-state-backup.ps1"
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$testRoot = Join-Path $tempRoot ("schoolpilot-state-backup-test-" + [Guid]::NewGuid().ToString("N"))
$statePath = Join-Path $testRoot "fixture.tfstate"
$backupDirectory = Join-Path $testRoot "backups"
$originalOneDrive = $env:OneDrive
$originalOneDriveConsumer = $env:OneDriveConsumer
$testOneDrive = Join-Path $testRoot "OneDrive"
$recoveryDirectory = Join-Path $testOneDrive "SchoolPilot-Recovery"
$recoveryPath = Join-Path $recoveryDirectory "week1-before.aesgcm"
$dpapiRestorePath = Join-Path $testRoot "restores\dpapi.tfstate"
$recoveryRestorePath = Join-Path $testRoot "restores\recovery.tfstate"
$stateMarker = "state-fixture-" + [Guid]::NewGuid().ToString("N")
$passphraseText = [Guid]::NewGuid().ToString("N") + [Guid]::NewGuid().ToString("N")
$securePassphrase = ConvertTo-SecureString -String $passphraseText -AsPlainText -Force

try {
    [void][System.IO.Directory]::CreateDirectory($testRoot)
    [void][System.IO.Directory]::CreateDirectory($backupDirectory)
    [void][System.IO.Directory]::CreateDirectory($recoveryDirectory)
    $env:OneDrive = $testOneDrive
    $env:OneDriveConsumer = $testOneDrive
    $fixtureJson = '{"version":4,"serial":1,"lineage":"' + $stateMarker + '","outputs":{},"resources":[]}'
    [System.IO.File]::WriteAllText(
        $statePath,
        $fixtureJson,
        [System.Text.UTF8Encoding]::new($false)
    )

    $windowsPowerShell = Get-Command powershell.exe -ErrorAction SilentlyContinue
    if ($null -ne $windowsPowerShell) {
        $legacyOutputDirectory = Join-Path $testRoot "legacy-host-must-not-run"
        $legacyOutput = @(
            & $windowsPowerShell.Source `
                -NoProfile `
                -NonInteractive `
                -ExecutionPolicy Bypass `
                -File $backupScript `
                -Mode Backup `
                -StatePath $statePath `
                -OutputDirectory $legacyOutputDirectory `
                -Phase "legacy-host" `
                -Usage Manual 2>&1
        )
        $legacyExitCode = $LASTEXITCODE
        $legacyOutputText = [string]::Join("`n", [string[]]$legacyOutput)

        Assert-Condition (
            $legacyExitCode -ne 0
        ) "Windows PowerShell 5.1 must reject the PowerShell 7-only backup tool."
        Assert-Condition (
            -not [System.IO.Directory]::Exists($legacyOutputDirectory)
        ) "The PowerShell version gate must run before backup filesystem changes."
        Assert-Condition (
            $legacyOutputText.Contains("ScriptRequiresUnmatchedPSVersion") -and
            $legacyOutputText.Contains('"#requires"') -and
            $legacyOutputText -match '(?i)PowerShell\s+7\.0'
        ) "Windows PowerShell rejection should identify the PowerShell 7 requirement."
        Assert-Condition (
            -not $legacyOutputText.Contains($stateMarker)
        ) "Legacy-host rejection must not expose state contents."
        Assert-Condition (
            -not $legacyOutputText.Contains($passphraseText)
        ) "Legacy-host rejection must not expose the recovery passphrase."
    }

    $backupOutput = @(
        & $backupScript `
            -Mode Backup `
            -StatePath $statePath `
            -OutputDirectory $backupDirectory `
            -Phase "week1" `
            -Usage Before `
            -RecoveryPath $recoveryPath `
            -RecoveryPassphrase $securePassphrase 6>&1
    )

    $dpapiBackups = @(Get-ChildItem -LiteralPath $backupDirectory -File -Filter "*.dpapi")
    Assert-Condition ($dpapiBackups.Count -eq 1) "Backup should create exactly one DPAPI file."
    Assert-Condition (
        $dpapiBackups[0].Name -cmatch '^\d{8}T\d{9}Z-[0-9a-f]{12}-week1-before\.dpapi$'
    ) "DPAPI filename should encode the UTC timestamp, Git SHA, phase, and before usage."
    Assert-Condition ([System.IO.File]::Exists($recoveryPath)) "Backup should create the requested AES-GCM recovery copy."

    $outputText = [string]::Join("`n", [string[]]$backupOutput)
    Assert-Condition (-not $outputText.Contains($stateMarker)) "Backup output must not expose state contents."
    Assert-Condition (-not $outputText.Contains($passphraseText)) "Backup output must not expose the recovery passphrase."

    $recoveryBytes = [System.IO.File]::ReadAllBytes($recoveryPath)
    $recoveryPrefixLength = [Math]::Min(512, $recoveryBytes.Length)
    $recoveryPrefix = [System.Text.Encoding]::UTF8.GetString($recoveryBytes, 0, $recoveryPrefixLength)
    Assert-Condition ($recoveryPrefix.Contains('"phase":"week1"')) "Recovery metadata should include the phase."
    Assert-Condition ($recoveryPrefix.Contains('"usage":"before"')) "Recovery metadata should include before usage."

    $dpapiRestoreOutput = @(
        & $backupScript `
            -Mode Restore `
            -BackupPath $dpapiBackups[0].FullName `
            -RestorePath $dpapiRestorePath 6>&1
    )
    $recoveryRestoreOutput = @(
        & $backupScript `
            -Mode Restore `
            -BackupPath $recoveryPath `
            -RestorePath $recoveryRestorePath `
            -RecoveryPassphrase $securePassphrase 6>&1
    )

    $originalBytes = [System.IO.File]::ReadAllBytes($statePath)
    $dpapiBytes = [System.IO.File]::ReadAllBytes($dpapiRestorePath)
    $restoredRecoveryBytes = [System.IO.File]::ReadAllBytes($recoveryRestorePath)
    Assert-Condition (Test-BytesEqual -Left $originalBytes -Right $dpapiBytes) "DPAPI restore should match the source state."
    Assert-Condition (
        Test-BytesEqual -Left $originalBytes -Right $restoredRecoveryBytes
    ) "AES-GCM recovery restore should match the source state."

    $restoreOutputText = [string]::Join(
        "`n",
        [string[]]@($dpapiRestoreOutput + $recoveryRestoreOutput)
    )
    Assert-Condition (-not $restoreOutputText.Contains($stateMarker)) "Restore output must not expose state contents."
    Assert-Condition (-not $restoreOutputText.Contains($passphraseText)) "Restore output must not expose the recovery passphrase."

    $junctionTarget = Join-Path $testRoot "junction-target"
    $junctionPath = Join-Path $testRoot "junction-output"
    [void][System.IO.Directory]::CreateDirectory($junctionTarget)
    New-Item -ItemType Junction -Path $junctionPath -Target $junctionTarget | Out-Null
    & $backupScript -Mode Backup -StatePath $statePath -OutputDirectory $junctionPath -Phase "junction-test" -Usage Manual 2>$null 6>$null | Out-Null
    $junctionExitCode = $LASTEXITCODE
    Assert-Condition ($junctionExitCode -ne 0) "Backup destinations must still reject real junctions."

    & $backupScript -Mode Backup -StatePath $statePath -OutputDirectory $backupDirectory -Phase "missing-recovery" -Usage Before 2>$null 6>$null | Out-Null
    $missingRecoveryExitCode = $LASTEXITCODE
    Assert-Condition ($missingRecoveryExitCode -ne 0) "A rollout Before backup must fail without OneDrive AES recovery."

    Write-Host "Terraform state backup round-trip tests: PASS"
}
finally {
    $env:OneDrive = $originalOneDrive
    $env:OneDriveConsumer = $originalOneDriveConsumer
    if ($null -ne $securePassphrase) {
        $securePassphrase.Dispose()
    }

    $resolvedTestRoot = [System.IO.Path]::GetFullPath($testRoot)
    if (
        [System.IO.Directory]::Exists($resolvedTestRoot) -and
        $resolvedTestRoot.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
        -not [string]::Equals($resolvedTestRoot, $tempRoot, [System.StringComparison]::OrdinalIgnoreCase)
    ) {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
