#requires -Version 7.5
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourcePath = Join-Path $PSScriptRoot '../scripts/load/start-aws-rollout-supervisor.ps1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'Supervisor source must parse.' }
$assertions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Assert-HealthyMonitorArmingHeartbeat' }, $true))
$loops = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.WhileStatementAst] -and $node.Condition.Extent.Text -match '\$armedHeartbeat' -and $node.Extent.Text -match 'Assert-HealthyMonitorArmingHeartbeat' }, $true))
if ($assertions.Count -ne 1 -or $loops.Count -ne 1) { throw 'Supervisor arming assertion and actual caller must be unambiguous.' }
. ([scriptblock]::Create($assertions[0].Extent.Text))
$actualLoop = $loops[0].Extent.Text
$legacyLoop = $actualLoop.Replace('-Now ([DateTimeOffset]::UtcNow) -StaleSeconds $monitorHeartbeatStaleSeconds', '-Now $now -StaleSeconds $monitorHeartbeatStaleSeconds')
if ($legacyLoop -ceq $actualLoop) { throw 'The actual caller must observe time after reading the heartbeat.' }

function Invoke-ArmingCase {
    param([string]$Name, [string]$Loop, [hashtable]$Changes, [int]$ReadDelayMilliseconds, [bool]$ExpectedPass)
    $directory = Join-Path ([IO.Path]::GetTempPath()) ('arming-clock-' + [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($directory)
    try {
        $runId = 'arming-clock-test'
        $config = [pscustomobject]@{ phase='PublicEcs' }
        $monitorStartedAt = [DateTimeOffset]::UtcNow.AddSeconds(-20)
        $monitorHeartbeatStaleSeconds = 5
        $armedDeadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
        $armedHeartbeat = $null
        $lastArmingHeartbeatWrite = [DateTimeOffset]::MinValue
        $heartbeatPath = Join-Path $directory 'supervisor.json'
        $monitorHeartbeatPath = Join-Path $directory 'monitor.json'
        $SupervisionKind = 'Load'
        $monitor = [pscustomobject]@{ Id=1; HasExited=$false }
        $harness = [pscustomobject]@{ Id=2; HasExited=$false }
        $monitor | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
        $harness | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
        [IO.File]::WriteAllText($monitorHeartbeatPath, '{}')
        function Write-AtomicJson { param([string]$Path, $Value) [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Compress)) }
        function Read-AtomicJson {
            param([string]$Path)
            if ($ReadDelayMilliseconds) { Start-Sleep -Milliseconds $ReadDelayMilliseconds }
            $readAt = [DateTimeOffset]::UtcNow
            $value = @{ runId=$runId; phase='PublicEcs'; triggered=$false; iteration=1; timestamp=$readAt.ToString('o') }
            foreach ($key in $Changes.Keys) {
                $value[$key] = if ($key -eq 'timestampOffset') { $readAt.AddSeconds($Changes[$key]).ToString('o') } else { $Changes[$key] }
            }
            if ($Changes.ContainsKey('timestampOffset')) { $value.timestamp=$value.timestampOffset; $value.Remove('timestampOffset') }
            [IO.File]::WriteAllText($Path, ($value | ConvertTo-Json -Compress))
            return [IO.File]::ReadAllText($Path) | ConvertFrom-Json -DateKind String
        }
        $passed = $true
        try { . ([scriptblock]::Create($Loop)) }
        catch { $passed = $false }
        if ($passed -ne $ExpectedPass -or ($passed -and $null -eq $armedHeartbeat) -or (-not $passed -and $null -ne $armedHeartbeat)) { throw "Arming case failed: $Name" }
    }
    finally {
        # The fixture owns only these two files and its fresh temporary leaf.
        foreach ($filename in @('monitor.json','supervisor.json')) { $path=Join-Path $directory $filename; if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) } }
        [IO.Directory]::Delete($directory)
    }
}

# Exercise the actual caller and assertion with a read that outlasts the existing
# five-second future-clock allowance. The old caller rejects the same fresh data.
Invoke-ArmingCase 'delayed-read-current-caller' $actualLoop @{} 6200 $true
Invoke-ArmingCase 'delayed-read-legacy-caller' $legacyLoop @{} 6200 $false
Invoke-ArmingCase 'healthy' $actualLoop @{} 0 $true
Invoke-ArmingCase 'stale' $actualLoop @{ timestampOffset=-6 } 0 $false
Invoke-ArmingCase 'future' $actualLoop @{ timestampOffset=6 } 0 $false
Invoke-ArmingCase 'wrong-run' $actualLoop @{ runId='other' } 0 $false
Invoke-ArmingCase 'wrong-phase' $actualLoop @{ phase='NatRemoved' } 0 $false
Invoke-ArmingCase 'triggered' $actualLoop @{ triggered=$true } 0 $false
Invoke-ArmingCase 'zero-iteration' $actualLoop @{ iteration=0 } 0 $false
Invoke-ArmingCase 'before-monitor-start' $actualLoop @{ timestampOffset=-21 } 0 $false
Invoke-ArmingCase 'invalid-timestamp' $actualLoop @{ timestamp='invalid' } 0 $false
Write-Host 'Supervisor arming clock: 11 actual-caller cases passed; thresholds unchanged.'
