#requires -Version 7.5

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$script:AssertionCount = 0
$testClock = [Diagnostics.Stopwatch]::StartNew()

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    $script:AssertionCount++
    if (-not $Condition) { throw $Message }
}

function Assert-ExclusiveFileAccess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )
    Assert-Condition (Test-Path -LiteralPath $Path -PathType Leaf) "$Label was not created."
    $probe = [IO.File]::Open(
        $Path,
        [IO.FileMode]::Open,
        [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::None
    )
    $probe.Dispose()
}

function Assert-DirectoryDeletesImmediately {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )
    [IO.Directory]::Delete($Path, $true)
    Assert-Condition (-not (Test-Path -LiteralPath $Path)) "$Label was not deleted immediately."
}

function Get-ContainingFunctionName {
    param(
        [Parameter(Mandatory = $true)]
        [System.Management.Automation.Language.Ast]$Ast
    )
    $ancestor = $Ast.Parent
    while ($null -ne $ancestor) {
        if ($ancestor -is [System.Management.Automation.Language.FunctionDefinitionAst]) {
            return [string]$ancestor.Name
        }
        $ancestor = $ancestor.Parent
    }
    return "<script>"
}

function Test-IsRawProcessStartAst {
    param(
        [Parameter(Mandatory = $true)]
        [System.Management.Automation.Language.Ast]$Ast
    )
    if ($Ast -is [System.Management.Automation.Language.CommandAst]) {
        $commandName = [string]$Ast.GetCommandName()
        if ([string]::IsNullOrWhiteSpace($commandName)) { return $false }
        $commandLeaf = @($commandName -split '\\')[-1]
        return @("Start-Process","saps","start") -icontains $commandLeaf
    }
    if ($Ast -isnot [System.Management.Automation.Language.InvokeMemberExpressionAst] -or
        $Ast.Member -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or
        $Ast.Member.Value -ine "Start") {
        return $false
    }
    if (-not $Ast.Static) {
        # PowerShell's AST cannot reliably infer the receiver type. Ban all
        # instance .Start() calls in guarded files to prevent an easy bypass.
        return $true
    }
    if ($Ast.Expression -isnot [System.Management.Automation.Language.TypeExpressionAst]) {
        return $false
    }
    $resolvedType = $null
    try { $resolvedType = $Ast.Expression.TypeName.GetReflectionType() }
    catch { $resolvedType = $null }
    if ($resolvedType -eq [Diagnostics.Process]) { return $true }
    $typeName = ([string]$Ast.Expression.TypeName.FullName).Trim('[',']')
    return @("Process","Diagnostics.Process","System.Diagnostics.Process") -icontains $typeName
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$ownedProcessHelper = Join-Path $PSScriptRoot "helpers\owned-test-process.ps1"
Assert-Condition (Test-Path -LiteralPath $ownedProcessHelper -PathType Leaf) `
    "The owned-process lifecycle helper is missing."
. $ownedProcessHelper

$pwshPath = (Get-Process -Id $PID).Path
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("schoolpilot-owned-process-test-" + [Guid]::NewGuid().ToString("N"))
$stressRoot = Join-Path $testRoot "stress"
$descendantRoot = Join-Path $testRoot "descendant"
$exitedParentRoot = Join-Path $testRoot "exited-parent"
$argumentRoot = Join-Path $testRoot "arguments"
$combinedFailureRoot = Join-Path $testRoot "combined-failure"
$stressRegistry = [hashtable]::Synchronized(@{})
$topLevelFailure = $null
$topLevelCleanupFailures = [System.Collections.Generic.List[Exception]]::new()

try {
    [void][IO.Directory]::CreateDirectory($stressRoot)
    [void][IO.Directory]::CreateDirectory($descendantRoot)
    [void][IO.Directory]::CreateDirectory($exitedParentRoot)
    [void][IO.Directory]::CreateDirectory($argumentRoot)
    [void][IO.Directory]::CreateDirectory($combinedFailureRoot)

    $normalChildPath = Join-Path $testRoot "normal-child.ps1"
    $timeoutChildPath = Join-Path $testRoot "timeout-child.ps1"
    $grandchildPath = Join-Path $testRoot "grandchild.ps1"
    $descendantChildPath = Join-Path $testRoot "descendant-child.ps1"
    $exitedParentChildPath = Join-Path $testRoot "exited-parent-child.ps1"
    $argumentChildPath = Join-Path $testRoot "argument-child.ps1"

    $normalChildSource = @'
param([string]$ResultPath,[string]$Label)
$ErrorActionPreference = "Stop"
Write-Output "normal-stdout:$Label"
[Console]::Error.WriteLine("normal-stderr:$Label")
[IO.File]::WriteAllText($ResultPath,'{"status":"ok"}',[Text.UTF8Encoding]::new($false))
exit 0
'@
    $timeoutChildSource = @'
param([string]$Label,[string]$ReadyPath = "")
$ErrorActionPreference = "Stop"
Write-Output "timeout-stdout:$Label"
[Console]::Error.WriteLine("timeout-stderr:$Label")
if (-not [string]::IsNullOrWhiteSpace($ReadyPath)) {
    [IO.File]::WriteAllText($ReadyPath,"ready",[Text.UTF8Encoding]::new($false))
}
Start-Sleep -Seconds 60
exit 0
'@
    $grandchildSource = @'
Write-Output "grandchild-stdout"
[Console]::Error.WriteLine("grandchild-stderr")
Start-Sleep -Seconds 60
'@
    $descendantChildSource = @'
param(
    [string]$PwshPath,
    [string]$GrandchildPath,
    [string]$IdentityPath,
    [string]$ResultPath
)
$ErrorActionPreference = "Stop"
$grandchild = Start-Process -FilePath $PwshPath `
    -ArgumentList @("-NoProfile","-File",$GrandchildPath) `
    -PassThru -NoNewWindow
[IO.File]::WriteAllText(
    $IdentityPath,
    "$($grandchild.Id)|$($grandchild.StartTime.ToUniversalTime().Ticks)",
    [Text.UTF8Encoding]::new($false)
)
[IO.File]::WriteAllText($ResultPath,'{"status":"descendant-started"}',[Text.UTF8Encoding]::new($false))
Write-Output "parent-stdout"
[Console]::Error.WriteLine("parent-stderr")
Start-Sleep -Seconds 60
'@
    $exitedParentChildSource = @'
param(
    [string]$PwshPath,
    [string]$GrandchildPath,
    [string]$IdentityPath
)
$ErrorActionPreference = "Stop"
$grandchild = Start-Process -FilePath $PwshPath `
    -ArgumentList @("-NoProfile","-File",$GrandchildPath) `
    -PassThru -NoNewWindow
try {
    [IO.File]::WriteAllText(
        $IdentityPath,
        "$($grandchild.Id)|$($grandchild.StartTime.ToUniversalTime().Ticks)",
        [Text.UTF8Encoding]::new($false)
    )
}
finally {
    $grandchild.Dispose()
}
Write-Output "exited-parent-stdout"
[Console]::Error.WriteLine("exited-parent-stderr")
exit 0
'@
    $argumentChildSource = @'
$ErrorActionPreference = "Stop"
$resultPath = [string]$args[0]
$values = @($args | Select-Object -Skip 1 | ForEach-Object { [string]$_ })
$payload = [ordered]@{ values = [string[]]$values }
[IO.File]::WriteAllText(
    $resultPath,
    ($payload | ConvertTo-Json -Compress),
    [Text.UTF8Encoding]::new($false)
)
Write-Output "argument-stdout"
[Console]::Error.WriteLine("argument-stderr")
exit 0
'@

    foreach ($fixture in @(
        [pscustomobject]@{path=$normalChildPath;source=$normalChildSource},
        [pscustomobject]@{path=$timeoutChildPath;source=$timeoutChildSource},
        [pscustomobject]@{path=$grandchildPath;source=$grandchildSource},
        [pscustomobject]@{path=$descendantChildPath;source=$descendantChildSource},
        [pscustomobject]@{path=$exitedParentChildPath;source=$exitedParentChildSource},
        [pscustomobject]@{path=$argumentChildPath;source=$argumentChildSource}
    )) {
        [IO.File]::WriteAllText($fixture.path, $fixture.source, [Text.UTF8Encoding]::new($false))
    }

    # Each repetition exercises natural exit, the exit watchdog, and the
    # result-and-exit watchdog. A synchronized parent-owned registry keeps any
    # failed worker cleanup reachable after its runspace returns.
    $stressResults = @(1..100 | ForEach-Object -Parallel {
        Set-StrictMode -Version Latest
        $ErrorActionPreference = "Stop"
        . $using:ownedProcessHelper

        function Test-ExclusiveFileAccess([string]$Path) {
            if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
                throw "Redirected path '$Path' was not created."
            }
            $probe = [IO.File]::Open(
                $Path,
                [IO.FileMode]::Open,
                [IO.FileAccess]::ReadWrite,
                [IO.FileShare]::None
            )
            $probe.Dispose()
        }

        $iteration = [int]$_
        $caseRoot = Join-Path $using:stressRoot ("case-{0:D3}" -f $iteration)
        $normalRoot = Join-Path $caseRoot "normal"
        $timeoutRoot = Join-Path $caseRoot "timeout"
        $resultTimeoutRoot = Join-Path $caseRoot "result-timeout"
        [void][IO.Directory]::CreateDirectory($normalRoot)
        [void][IO.Directory]::CreateDirectory($timeoutRoot)
        [void][IO.Directory]::CreateDirectory($resultTimeoutRoot)
        $registry = $using:stressRegistry
        $normalName = "normal-$iteration"
        $timeoutName = "timeout-$iteration"
        $resultTimeoutName = "result-timeout-$iteration"
        $ownedNames = @($normalName,$timeoutName,$resultTimeoutName)
        $failure = $null
        try {
            $normalOut = Join-Path $normalRoot "normal.out"
            $normalErr = Join-Path $normalRoot "normal.err"
            $normalResultPath = Join-Path $normalRoot "result.json"
            $normalResult = Invoke-OwnedTestProcessWithResult `
                -Registry $registry `
                -Name $normalName `
                -FilePath $using:pwshPath `
                -ArgumentList @("-NoProfile","-File",$using:normalChildPath,$normalResultPath,[string]$iteration) `
                -StandardOutputPath $normalOut `
                -StandardErrorPath $normalErr `
                -ResultPath $normalResultPath `
                -WatchdogMilliseconds 30000
            if ($normalResult.exitCode -ne 0 -or -not $normalResult.resultObserved) {
                throw "Normal child returned an invalid lifecycle snapshot."
            }
            if ($registry.Contains($normalName)) {
                throw "Normal child left its owned registry entry behind."
            }
            Test-ExclusiveFileAccess $normalOut
            Test-ExclusiveFileAccess $normalErr
            if ((Get-Content -LiteralPath $normalOut -Raw).Trim() -cne "normal-stdout:$iteration") {
                throw "Normal stdout was not drained exactly for iteration $iteration."
            }
            if ((Get-Content -LiteralPath $normalErr -Raw).Trim() -cne "normal-stderr:$iteration") {
                throw "Normal stderr was not drained exactly for iteration $iteration."
            }
            [IO.Directory]::Delete($normalRoot, $true)
            if (Test-Path -LiteralPath $normalRoot) {
                throw "Normal child directory was not deleted immediately."
            }

            $timeoutOut = Join-Path $timeoutRoot "timeout.out"
            $timeoutErr = Join-Path $timeoutRoot "timeout.err"
            $timeoutReadyPath = Join-Path $timeoutRoot "ready.flag"
            $watchdogRejected = $false
            Start-OwnedTestProcess `
                -Registry $registry `
                -Name $timeoutName `
                -FilePath $using:pwshPath `
                -ArgumentList @("-NoProfile","-File",$using:timeoutChildPath,[string]$iteration,$timeoutReadyPath) `
                -StandardOutputPath $timeoutOut `
                -StandardErrorPath $timeoutErr
            $timeoutReadyDeadline = [DateTimeOffset]::UtcNow.AddSeconds(60)
            while (-not (Test-Path -LiteralPath $timeoutReadyPath -PathType Leaf) -and
                -not (Get-OwnedTestProcessSnapshot -Registry $registry -Name $timeoutName).hasExited -and
                [DateTimeOffset]::UtcNow -lt $timeoutReadyDeadline) {
                Start-Sleep -Milliseconds 50
            }
            if (-not (Test-Path -LiteralPath $timeoutReadyPath -PathType Leaf)) {
                throw "Timeout child did not publish readiness for iteration $iteration."
            }
            try {
                [void](Complete-OwnedTestProcess `
                    -Registry $registry -Name $timeoutName -TimeoutMilliseconds 1000)
            }
            catch {
                $watchdogRejected = $_.Exception.Message -match "exit watchdog"
                if (-not $watchdogRejected) { throw }
            }
            if (-not $watchdogRejected) {
                throw "Timeout child did not trip the owned-process watchdog."
            }
            if ($registry.Contains($timeoutName)) {
                throw "Timeout child left its owned registry entry behind."
            }
            Test-ExclusiveFileAccess $timeoutOut
            Test-ExclusiveFileAccess $timeoutErr
            if ((Get-Content -LiteralPath $timeoutOut -Raw).Trim() -cne "timeout-stdout:$iteration") {
                throw "Timeout stdout was not drained exactly for iteration $iteration."
            }
            if ((Get-Content -LiteralPath $timeoutErr -Raw).Trim() -cne "timeout-stderr:$iteration") {
                throw "Timeout stderr was not drained exactly for iteration $iteration."
            }
            [IO.Directory]::Delete($timeoutRoot, $true)
            if (Test-Path -LiteralPath $timeoutRoot) {
                throw "Timeout child directory was not deleted immediately."
            }

            $resultTimeoutOut = Join-Path $resultTimeoutRoot "result-timeout.out"
            $resultTimeoutErr = Join-Path $resultTimeoutRoot "result-timeout.err"
            $missingResultPath = Join-Path $resultTimeoutRoot "missing-result.json"
            $resultWatchdogRejected = $false
            try {
                [void](Invoke-OwnedTestProcessWithResult `
                    -Registry $registry `
                    -Name $resultTimeoutName `
                    -FilePath $using:pwshPath `
                    -ArgumentList @("-NoProfile","-File",$using:timeoutChildPath,"result-$iteration") `
                    -StandardOutputPath $resultTimeoutOut `
                    -StandardErrorPath $resultTimeoutErr `
                    -ResultPath $missingResultPath `
                    -WatchdogMilliseconds 1000)
            }
            catch {
                $resultWatchdogRejected = $_.Exception.Message -match "result-and-exit watchdog"
                if (-not $resultWatchdogRejected) { throw }
            }
            if (-not $resultWatchdogRejected) {
                throw "Result-timeout child did not trip the result-and-exit watchdog."
            }
            if ($registry.Contains($resultTimeoutName)) {
                throw "Result-timeout child left its owned registry entry behind."
            }
            Test-ExclusiveFileAccess $resultTimeoutOut
            Test-ExclusiveFileAccess $resultTimeoutErr
            [IO.Directory]::Delete($resultTimeoutRoot, $true)
            if (Test-Path -LiteralPath $resultTimeoutRoot) {
                throw "Result-timeout child directory was not deleted immediately."
            }
        }
        catch {
            $failure = $_.Exception.Message
        }
        finally {
            foreach ($ownedName in $ownedNames) {
                if ($registry.Contains($ownedName)) {
                    try { Stop-OwnedTestProcess -Registry $registry -Name $ownedName }
                    catch {
                        $cleanupMessage = "Fallback cleanup failed for '$ownedName': $($_.Exception.Message)"
                        $failure = if ($null -eq $failure) { $cleanupMessage } else { "$failure Cleanup: $cleanupMessage" }
                    }
                }
            }
            $retainedNames = @($ownedNames | Where-Object { $registry.Contains($_) })
            if ($retainedNames.Count -eq 0 -and (Test-Path -LiteralPath $caseRoot)) {
                try { [IO.Directory]::Delete($caseRoot, $true) }
                catch {
                    $cleanupMessage = "Fallback directory cleanup failed: $($_.Exception.Message)"
                    $failure = if ($null -eq $failure) { $cleanupMessage } else { "$failure Cleanup: $cleanupMessage" }
                }
            }
            elseif ($retainedNames.Count -gt 0) {
                $cleanupMessage = "Retained owned process entries '$($retainedNames -join ', ')' and preserved case evidence."
                $failure = if ($null -eq $failure) { $cleanupMessage } else { "$failure Cleanup: $cleanupMessage" }
            }
        }
        [pscustomobject]@{iteration=$iteration;failure=$failure}
    } -ThrottleLimit 8)

    $stressFailures = @($stressResults | Where-Object { $null -ne $_.failure })
    Assert-Condition ($stressResults.Count -eq 100) `
        "The lifecycle stress test did not complete all 100 normal/exit/result-timeout repetitions."
    Assert-Condition ($stressFailures.Count -eq 0) `
        "Owned-process lifecycle stress failed: $((@($stressFailures | Select-Object -First 5 | ForEach-Object { "iteration $($_.iteration): $($_.failure)" })) -join '; ')"
    Assert-Condition ($stressRegistry.Count -eq 0) `
        "Lifecycle stress retained $($stressRegistry.Count) parent-owned process registry entries."
    Assert-Condition (@(Get-ChildItem -LiteralPath $stressRoot -Force).Count -eq 0) `
        "Lifecycle stress left one or more case directories behind."

    # Induce a redirect-persistence failure only after the watchdog terminates
    # the child by using a directory as the stdout destination. The process is
    # still safely killed and disposed, while the surfaced error must retain
    # both the primary timeout identity and the independent cleanup failure.
    $combinedFailureRegistry = [ordered]@{}
    $combinedFailureOutPath = Join-Path $combinedFailureRoot "combined.out"
    $combinedFailureErrorPath = Join-Path $combinedFailureRoot "combined.err"
    $combinedFailureResultPath = Join-Path $combinedFailureRoot "missing-result.json"
    [void][IO.Directory]::CreateDirectory($combinedFailureOutPath)
    $combinedFailureException = $null
    try {
        [void](Invoke-OwnedTestProcessWithResult `
            -Registry $combinedFailureRegistry `
            -Name "combined-watchdog-cleanup-failure" `
            -FilePath $pwshPath `
            -ArgumentList @("-NoProfile","-File",$timeoutChildPath,"combined-failure") `
            -StandardOutputPath $combinedFailureOutPath `
            -StandardErrorPath $combinedFailureErrorPath `
            -ResultPath $combinedFailureResultPath `
            -WatchdogMilliseconds 1000)
    }
    catch {
        $combinedFailureException = $_.Exception
    }
    Assert-Condition ($null -ne $combinedFailureException -and
        $combinedFailureException -isnot [AggregateException]) `
        "Cleanup replaced the primary watchdog with an aggregate exception."
    Assert-Condition ($combinedFailureException.Message -match "exceeded its 1000ms result-and-exit watchdog") `
        "The surfaced failure did not retain the primary watchdog identity: $combinedFailureException"
    Assert-Condition ($combinedFailureException.Data.Contains("CleanupFailures")) `
        "The primary watchdog exception did not expose its cleanup failures separately."
    $combinedCleanupFailures = @($combinedFailureException.Data["CleanupFailures"])
    Assert-Condition ($combinedCleanupFailures.Count -eq 1) `
        "The primary watchdog exception did not expose exactly one cleanup failure."
    Assert-Condition ($combinedCleanupFailures[0].ToString() -match "Redirect drain failed") `
        "The attached cleanup failure was not the redirect persistence error: $($combinedCleanupFailures[0])"
    Assert-Condition ($combinedFailureRegistry.Count -eq 1) `
        "The failed cleanup did not retain exactly one owned registry entry for retry."

    # Turn the deliberately invalid stdout directory into a writable file path,
    # then prove the retained owner can be drained and disposed on retry.
    [IO.Directory]::Delete($combinedFailureOutPath, $true)
    Stop-AllOwnedTestProcesses -Registry $combinedFailureRegistry
    Assert-Condition ($combinedFailureRegistry.Count -eq 0) `
        "Retrying the combined-failure cleanup did not empty the owned registry."
    Assert-ExclusiveFileAccess -Path $combinedFailureOutPath -Label "Combined-failure stdout"
    Assert-ExclusiveFileAccess -Path $combinedFailureErrorPath -Label "Combined-failure stderr"
    Assert-DirectoryDeletesImmediately -Path $combinedFailureRoot -Label "Combined-failure case directory"

    # ProcessStartInfo.ArgumentList must preserve each argument as an exact
    # element; pre-quoting strings would corrupt several of these on Windows.
    $argumentRegistry = [ordered]@{}
    $argumentOut = Join-Path $argumentRoot "argument.out"
    $argumentErr = Join-Path $argumentRoot "argument.err"
    $argumentResultPath = Join-Path $argumentRoot "result.json"
    [string[]]$expectedArguments = @(
        "two words",
        'embedded"quote',
        'C:\path with spaces\',
        "Zażółć gęślą jaźń 😀",
        "-leading-dash",
        ""
    )
    [string[]]$argumentCommand = @("-NoProfile","-File",$argumentChildPath,$argumentResultPath) + $expectedArguments
    $argumentSnapshot = Invoke-OwnedTestProcessWithResult `
        -Registry $argumentRegistry `
        -Name "argument-roundtrip" `
        -FilePath $pwshPath `
        -ArgumentList $argumentCommand `
        -StandardOutputPath $argumentOut `
        -StandardErrorPath $argumentErr `
        -ResultPath $argumentResultPath `
        -WatchdogMilliseconds 30000
    Assert-Condition ($argumentSnapshot.exitCode -eq 0 -and $argumentSnapshot.resultObserved) `
        "The argument-roundtrip child did not complete normally."
    Assert-Condition ($argumentRegistry.Count -eq 0) `
        "The argument-roundtrip child left an owned registry entry behind."
    $actualArguments = @((Get-Content -LiteralPath $argumentResultPath -Raw | ConvertFrom-Json).values |
        ForEach-Object { [string]$_ })
    Assert-Condition ($actualArguments.Count -eq $expectedArguments.Count) `
        "Argument roundtrip changed the element count (expected $($expectedArguments.Count), actual $($actualArguments.Count))."
    for ($argumentIndex = 0; $argumentIndex -lt $expectedArguments.Count; $argumentIndex++) {
        Assert-Condition ($actualArguments[$argumentIndex] -ceq $expectedArguments[$argumentIndex]) `
            "Argument $argumentIndex did not roundtrip exactly (expected '$($expectedArguments[$argumentIndex])', actual '$($actualArguments[$argumentIndex])')."
    }
    Assert-ExclusiveFileAccess -Path $argumentOut -Label "Argument-roundtrip stdout"
    Assert-ExclusiveFileAccess -Path $argumentErr -Label "Argument-roundtrip stderr"
    Assert-DirectoryDeletesImmediately -Path $argumentRoot -Label "Argument-roundtrip case directory"

    # A running parent spawns a grandchild that inherits its redirected
    # handles. Explicit owned cleanup must terminate the whole tree before
    # returning; the 100 deterministic timeout cases above cover watchdogs.
    $descendantRegistry = [ordered]@{}
    $descendantOut = Join-Path $descendantRoot "descendant.out"
    $descendantErr = Join-Path $descendantRoot "descendant.err"
    $descendantIdentityPath = Join-Path $descendantRoot "identity.txt"
    $descendantResultPath = Join-Path $descendantRoot "result.json"
    Start-OwnedTestProcess `
        -Registry $descendantRegistry `
        -Name "descendant-stop" `
        -FilePath $pwshPath `
        -ArgumentList @("-NoProfile","-File",$descendantChildPath,$pwshPath,$grandchildPath,$descendantIdentityPath,$descendantResultPath) `
        -StandardOutputPath $descendantOut `
        -StandardErrorPath $descendantErr
    $descendantReadyDeadline = [DateTimeOffset]::UtcNow.AddSeconds(60)
    while ((-not (Test-Path -LiteralPath $descendantIdentityPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $descendantResultPath -PathType Leaf)) -and
        -not (Get-OwnedTestProcessSnapshot -Registry $descendantRegistry -Name "descendant-stop").hasExited -and
        [DateTimeOffset]::UtcNow -lt $descendantReadyDeadline) {
        Start-Sleep -Milliseconds 50
    }
    Assert-Condition (Test-Path -LiteralPath $descendantIdentityPath -PathType Leaf) `
        "The descendant process never published its PID identity."
    Assert-Condition (Test-Path -LiteralPath $descendantResultPath -PathType Leaf) `
        "The descendant parent never published readiness."
    Stop-OwnedTestProcess -Registry $descendantRegistry -Name "descendant-stop"
    Assert-Condition ($descendantRegistry.Count -eq 0) "Descendant cleanup left an owned registry entry behind."
    $descendantIdentity = (Get-Content -LiteralPath $descendantIdentityPath -Raw).Trim().Split('|')
    Assert-Condition ($descendantIdentity.Count -eq 2) "The descendant PID identity is malformed."
    $descendantProcessId = [int]$descendantIdentity[0]
    $descendantStartedAtUtcTicks = [long]$descendantIdentity[1]
    $remainingDescendant = Get-Process -Id $descendantProcessId -ErrorAction SilentlyContinue
    $sameDescendantRemains = $false
    if ($null -ne $remainingDescendant) {
        try {
            $sameDescendantRemains = $remainingDescendant.StartTime.ToUniversalTime().Ticks -eq $descendantStartedAtUtcTicks
        }
        finally {
            $remainingDescendant.Dispose()
        }
    }
    Assert-Condition (-not $sameDescendantRemains) `
        "The owned timeout left descendant process $descendantProcessId running."
    Assert-ExclusiveFileAccess -Path $descendantOut -Label "Descendant stdout"
    Assert-ExclusiveFileAccess -Path $descendantErr -Label "Descendant stderr"
    Assert-DirectoryDeletesImmediately -Path $descendantRoot -Label "Descendant case directory"

    # The root exits naturally while its long-lived grandchild still owns the
    # inherited stdout/stderr pipes. Cleanup must retain an ownership primitive
    # that can terminate the descendant even after the root PID is gone.
    $exitedParentRegistry = [ordered]@{}
    $exitedParentOut = Join-Path $exitedParentRoot "exited-parent.out"
    $exitedParentErr = Join-Path $exitedParentRoot "exited-parent.err"
    $exitedParentIdentityPath = Join-Path $exitedParentRoot "identity.txt"
    Start-OwnedTestProcess `
        -Registry $exitedParentRegistry `
        -Name "exited-parent" `
        -FilePath $pwshPath `
        -ArgumentList @("-NoProfile","-File",$exitedParentChildPath,$pwshPath,$grandchildPath,$exitedParentIdentityPath) `
        -StandardOutputPath $exitedParentOut `
        -StandardErrorPath $exitedParentErr

    $exitedParentDeadline = [DateTime]::UtcNow.AddSeconds(60)
    $exitedParentSnapshot = $null
    do {
        $exitedParentSnapshot = Get-OwnedTestProcessSnapshot `
            -Registry $exitedParentRegistry -Name "exited-parent"
        if ($exitedParentSnapshot.hasExited -and
            (Test-Path -LiteralPath $exitedParentIdentityPath -PathType Leaf)) { break }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $exitedParentDeadline)
    Assert-Condition (Test-Path -LiteralPath $exitedParentIdentityPath -PathType Leaf) `
        "The naturally exited root never published its grandchild PID identity."
    Assert-Condition ($exitedParentSnapshot.hasExited) `
        "The root did not exit before the descendant-cleanup case began."
    Assert-Condition ([string]::Equals(
        [IO.Path]::GetFullPath($exitedParentSnapshot.path),
        [IO.Path]::GetFullPath($pwshPath),
        [StringComparison]::OrdinalIgnoreCase
    )) "The immutable process snapshot did not retain the executable path used for launch."

    $exitedParentIdentity = (Get-Content -LiteralPath $exitedParentIdentityPath -Raw).Trim().Split('|')
    Assert-Condition ($exitedParentIdentity.Count -eq 2) `
        "The naturally exited root published a malformed grandchild identity."
    $exitedGrandchildId = [int]$exitedParentIdentity[0]
    $exitedGrandchildStartedAtTicks = [long]$exitedParentIdentity[1]
    $exitedParentStopFailure = $null
    $exitedParentRecoveryFailure = $null
    $exitedParentStopClock = [Diagnostics.Stopwatch]::StartNew()
    try {
        Stop-OwnedTestProcess -Registry $exitedParentRegistry -Name "exited-parent"
    }
    catch {
        $exitedParentStopFailure = $_
    }
    finally {
        $exitedParentStopClock.Stop()
        $registryCountAfterInitialStop = $exitedParentRegistry.Count
        if ($null -ne $exitedParentStopFailure -or $registryCountAfterInitialStop -gt 0) {
            # Test-only leak recovery: target the exact captured PID creation
            # identity before retrying the helper's retained owner cleanup.
            try {
                $recoveryProcess = Get-Process -Id $exitedGrandchildId -ErrorAction SilentlyContinue
                if ($null -ne $recoveryProcess) {
                    try {
                        if ($recoveryProcess.StartTime.ToUniversalTime().Ticks -eq $exitedGrandchildStartedAtTicks) {
                            $recoveryProcess.Kill($true)
                            if (-not $recoveryProcess.WaitForExit(10000)) {
                                throw "Timed out terminating leaked descendant $exitedGrandchildId."
                            }
                            $recoveryProcess.WaitForExit()
                        }
                    }
                    finally {
                        $recoveryProcess.Dispose()
                    }
                }
                if ($exitedParentRegistry.Count -gt 0) {
                    Stop-AllOwnedTestProcesses -Registry $exitedParentRegistry
                }
            }
            catch {
                $exitedParentRecoveryFailure = $_
            }
        }
    }
    Assert-Condition ($null -eq $exitedParentRecoveryFailure) `
        "Emergency cleanup of the exited-parent case failed: $([string]$exitedParentRecoveryFailure)"
    Assert-Condition ($null -eq $exitedParentStopFailure) `
        "Owned cleanup could not terminate a descendant after its root exited: $([string]$exitedParentStopFailure)"
    Assert-Condition ($registryCountAfterInitialStop -eq 0) `
        "Exited-parent cleanup retained $registryCountAfterInitialStop owned registry entries."
    Assert-Condition ($exitedParentStopClock.ElapsedMilliseconds -lt 10000) `
        "Exited-parent cleanup took $($exitedParentStopClock.ElapsedMilliseconds)ms instead of promptly terminating the descendant."
    $remainingExitedGrandchild = Get-Process -Id $exitedGrandchildId -ErrorAction SilentlyContinue
    $sameExitedGrandchildRemains = $false
    if ($null -ne $remainingExitedGrandchild) {
        try {
            $sameExitedGrandchildRemains =
                $remainingExitedGrandchild.StartTime.ToUniversalTime().Ticks -eq $exitedGrandchildStartedAtTicks
        }
        finally {
            $remainingExitedGrandchild.Dispose()
        }
    }
    Assert-Condition (-not $sameExitedGrandchildRemains) `
        "Cleanup left grandchild process $exitedGrandchildId alive after its root exited."
    Assert-ExclusiveFileAccess -Path $exitedParentOut -Label "Exited-parent stdout"
    Assert-ExclusiveFileAccess -Path $exitedParentErr -Label "Exited-parent stderr"
    Assert-DirectoryDeletesImmediately -Path $exitedParentRoot -Label "Exited-parent case directory"

    # Fail closed if rollout automation bypasses the ownership helper. The AST
    # deliberately ignores comments and fixture strings, while treating every
    # member .Start() in the main test as unsafe because PowerShell's AST does
    # not provide reliable static type inference for instance expressions.
    $rolloutAutomationPath = Join-Path $PSScriptRoot "aws-rollout-automation.test.ps1"
    $mainTokens = $null
    $mainParseErrors = $null
    $mainAst = [System.Management.Automation.Language.Parser]::ParseFile(
        $rolloutAutomationPath,
        [ref]$mainTokens,
        [ref]$mainParseErrors
    )
    Assert-Condition (@($mainParseErrors).Count -eq 0) `
        "The rollout automation test could not be parsed for process-ownership enforcement: $((@($mainParseErrors | ForEach-Object Message)) -join '; ')"

    $helperTokens = $null
    $helperParseErrors = $null
    $helperAst = [System.Management.Automation.Language.Parser]::ParseFile(
        $ownedProcessHelper,
        [ref]$helperTokens,
        [ref]$helperParseErrors
    )
    Assert-Condition (@($helperParseErrors).Count -eq 0) `
        "The owned-process helper could not be parsed for launch-boundary enforcement: $((@($helperParseErrors | ForEach-Object Message)) -join '; ')"

    $mainRawLaunches = @($mainAst.FindAll({
        param($node)
        Test-IsRawProcessStartAst -Ast $node
    }, $true))
    $mainRawLaunchSites = @($mainRawLaunches | ForEach-Object {
        "line $($_.Extent.StartLineNumber), column $($_.Extent.StartColumnNumber): $($_.Extent.Text)"
    }) -join "; "
    Assert-Condition ($mainRawLaunches.Count -eq 0) `
        "Rollout automation bypasses owned-process helpers at $mainRawLaunchSites"

    $mainRegistryMutations = @($mainAst.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and
            $node.Expression -is [System.Management.Automation.Language.VariableExpressionAst] -and
            $node.Expression.VariablePath.UserPath -ieq "ownedTestProcesses" -and
            $node.Member -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
            @("Add","Remove","Clear") -icontains $node.Member.Value
    }, $true))
    Assert-Condition ($mainRegistryMutations.Count -eq 0) `
        "Rollout automation mutates the owned-process registry outside its helper API."

    $helperRawLaunches = @($helperAst.FindAll({
        param($node)
        Test-IsRawProcessStartAst -Ast $node
    }, $true))
    $approvedRawLaunchFunctions = @("Start-OwnedTestProcessFromStartInfo")
    $approvedFunctionDefinitions = @($helperAst.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -ieq "Start-OwnedTestProcessFromStartInfo"
    }, $true))
    Assert-Condition ($approvedFunctionDefinitions.Count -eq 1) `
        "The ownership helper must define exactly one approved raw-launch boundary."
    Assert-Condition ($helperRawLaunches.Count -eq 1) `
        "The ownership helper must contain exactly one auditable raw launch; found $($helperRawLaunches.Count)."
    $unapprovedHelperLaunches = @($helperRawLaunches | Where-Object {
        $approvedRawLaunchFunctions -inotcontains (Get-ContainingFunctionName -Ast $_)
    })
    $unapprovedHelperLaunchSites = @($unapprovedHelperLaunches | ForEach-Object {
        "line $($_.Extent.StartLineNumber), column $($_.Extent.StartColumnNumber) in $(Get-ContainingFunctionName -Ast $_): $($_.Extent.Text)"
    }) -join "; "
    Assert-Condition ($unapprovedHelperLaunches.Count -eq 0) `
        "A raw process launch escaped the approved ownership boundary: $unapprovedHelperLaunchSites"

    $testClock.Stop()
    Write-Host ("AWS rollout owned-process lifecycle tests: PASS ({0} assertions, {1:N1}s)" -f `
        $script:AssertionCount,$testClock.Elapsed.TotalSeconds)
}
catch {
    $topLevelFailure = $_
}
finally {
    $remainingRegistryEntries = 0
    foreach ($registryVariableName in @(
        "stressRegistry",
        "combinedFailureRegistry",
        "descendantRegistry",
        "argumentRegistry",
        "exitedParentRegistry"
    )) {
        $registryVariable = Get-Variable $registryVariableName -ErrorAction SilentlyContinue
        if ($null -eq $registryVariable) { continue }
        $registryValue = $registryVariable.Value
        if ($registryValue.Count -gt 0) {
            try { Stop-AllOwnedTestProcesses -Registry $registryValue }
            catch {
                $topLevelCleanupFailures.Add([InvalidOperationException]::new(
                    "Final cleanup failed for owned registry '$registryVariableName'.",
                    $_.Exception
                ))
            }
        }
        $remainingRegistryEntries += $registryValue.Count
    }
    if ($remainingRegistryEntries -eq 0 -and (Test-Path -LiteralPath $testRoot)) {
        try { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction Stop }
        catch {
            $topLevelCleanupFailures.Add([InvalidOperationException]::new(
                "Owned-process regression temporary-directory cleanup failed.",
                $_.Exception
            ))
        }
    }
    elseif ($remainingRegistryEntries -gt 0 -and (Test-Path -LiteralPath $testRoot)) {
        $topLevelCleanupFailures.Add([InvalidOperationException]::new(
            "Temporary evidence was retained because $remainingRegistryEntries owned process entries could not be drained."
        ))
    }
    if ($null -ne $topLevelFailure -and $topLevelCleanupFailures.Count -gt 0) {
        Add-OwnedTestProcessCleanupFailures -Exception $topLevelFailure.Exception `
            -CleanupFailures ([Exception[]]$topLevelCleanupFailures.ToArray())
        throw $topLevelFailure
    }
    if ($null -ne $topLevelFailure) { throw $topLevelFailure }
    if ($topLevelCleanupFailures.Count -gt 0) {
        throw [AggregateException]::new(
            "Owned-process regression final cleanup failed.",
            [Exception[]]$topLevelCleanupFailures.ToArray()
        )
    }
}
