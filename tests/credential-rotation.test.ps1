#requires -Version 7.0

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$script:Assertions = 0

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    $script:Assertions++
    if (-not $Condition) { throw $Message }
}

function Assert-Throws {
    param([scriptblock]$Action, [string]$Message)
    $script:Assertions++
    $threw = $false
    try { & $Action }
    catch { $threw = $true }
    if (-not $threw) { throw $Message }
}

function Get-PlaintextForTest {
    param([securestring]$Value)
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        if ($pointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
    }
}

function Get-TestHash {
    param([string]$Value)
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    try { return Get-Sha256HexFromBytes -Bytes $bytes }
    finally { [Security.Cryptography.CryptographicOperations]::ZeroMemory($bytes) }
}

function New-TestSsmSnapshot {
    param([int64]$Version, [string]$Ciphertext, [string]$Plaintext)
    return [pscustomobject]@{
        Name = [string]$global:RotationTestState.ParameterName
        Version = $Version
        CiphertextHash = Get-TestHash -Value $Ciphertext
        PlaintextHash = Get-TestHash -Value $Plaintext
        KeyId = "alias/aws/ssm"
        Tier = "Standard"
        DataType = "text"
    }
}

function Set-MockedSsmState {
    param([int64]$Version, [string]$Ciphertext, [string]$Plaintext, [string]$Scenario = "read-only")
    $global:RotationTestState.SsmVersion = $Version
    $global:RotationTestState.SsmCiphertext = $Ciphertext
    $global:RotationTestState.SsmPlaintext = $Plaintext
    $global:RotationTestState.WriteScenario = $Scenario
}

function Write-GateEvidenceFixture {
    param(
        [string]$Path,
        [string]$Phase,
        $Manifest,
        [hashtable]$Checks,
        [hashtable]$Additional = @{},
        [int]$TtlMinutes = 30
    )
    $createdAt = [DateTimeOffset]::UtcNow
    $record = [ordered]@{
        schemaVersion = 1
        phase = $Phase
        runId = [string]$Manifest.runId
        manifestHash = [string]$Manifest.manifestHash
        createdAt = $createdAt.ToString("o")
        expiresAt = $createdAt.AddMinutes($TtlMinutes).ToString("o")
        approved = $true
        checks = $Checks
    }
    foreach ($key in $Additional.Keys) { $record[$key] = $Additional[$key] }
    [IO.File]::WriteAllText($Path, ($record | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    Set-OwnerOnlyAcl -Path $Path
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$scriptPath = Join-Path $repositoryRoot "scripts\security\rotate-production-credential.ps1"
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = Join-Path $tempBase ("schoolpilot-credential-rotation-test-" + [Guid]::NewGuid().ToString("N"))
$priorImport = $env:SCHOOLPILOT_CREDENTIAL_ROTATION_IMPORT_ONLY
$priorTestMode = $env:SCHOOLPILOT_CREDENTIAL_ROTATION_TEST_MODE

try {
    [void][IO.Directory]::CreateDirectory($testRoot)
    $tokens = $null
    $errors = $null
    [void][Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors)
    Assert-Condition ($errors.Count -eq 0) "Credential rotation script must parse."

    $source = [IO.File]::ReadAllText($scriptPath)
    Assert-Condition ($source.Contains("--with-decryption")) "Plan/Validate must read live SSM plaintext only in memory."
    Assert-Condition ($source.Contains("--no-with-decryption")) "Rotation must capture a ciphertext hash independently."
    Assert-Condition (-not $source.Contains("secrets.auto.tfvars")) "Rotation must not access a repository secret source."
    Assert-Condition (-not ($source -match '(?i)tfvar|SecretsFile|Get-TargetedTfvarSecret|New-TfvarsStagingFile')) "Legacy local-secret parsing/updating must be absent."
    Assert-Condition (-not ($source -match '(?i)deploy\.sh|Invoke-CleanBackendDeploy')) "Secret-only cutover must not invoke the build/deploy/migration pipeline."
    Assert-Condition ($source.Contains("register-task-definition")) "Secret-only cutover must clone ECS task definitions."
    Assert-Condition ($source.Contains('Kill($true)')) "Timed-out external commands must terminate their process tree."
    Assert-Condition ($source.Contains("--untracked-files=all")) "Clean-tree gate must include untracked files."
    Assert-Condition (-not ($source -match '(?i)Write-Host\s+.*(secret|password|token|credential)')) "Rotation must not print credential-bearing variables."
    Assert-Condition ($source.Contains('aws_cutover_pending_provider_validation')) "Unverified provider cutovers must remain pending."

    $env:SCHOOLPILOT_CREDENTIAL_ROTATION_IMPORT_ONLY = "I_UNDERSTAND_CREDENTIAL_ROTATION_TEST_ONLY"
    $env:SCHOOLPILOT_CREDENTIAL_ROTATION_TEST_MODE = "I_UNDERSTAND_CREDENTIAL_ROTATION_TEST_ONLY"
    . $scriptPath -Mode Plan -Phase google

    $catalog = Get-RotationPhaseCatalog
    $expectedPhases = @("google", "sendgrid", "stripe-api", "stripe-webhook", "openai", "session", "jwt", "student", "database", "pin-key")
    Assert-Condition ($catalog.Count -eq $expectedPhases.Count) "Phase catalog must contain exactly the reviewed phases."
    foreach ($name in $expectedPhases) {
        Assert-Condition ($catalog.Contains($name)) "Phase catalog is missing $name."
        Assert-Condition ([string]$catalog[$name].terraformResourceName -ne "") "$name must map to one nonsecret Terraform resource name."
        Assert-Condition ([string]$catalog[$name].parameterSuffix -ne "") "$name must map to one SSM suffix."
        Assert-Condition ([string]$catalog[$name].runtimeSecretName -ne "") "$name must map to one exact ECS runtime secret name."
    }
    Assert-Condition (-not $catalog.openai.applySupported) "Unused OpenAI credential must remain removal-oriented and apply-blocked."
    Assert-Condition (-not $catalog.session.applySupported) "Session rolling rotation must remain blocked."
    Assert-Condition (-not $catalog.jwt.applySupported) "JWT rolling rotation must remain blocked."
    Assert-Condition (-not $catalog.database.applySupported) "Database rotation must remain a separate cutover."
    Assert-Condition (-not $catalog.'pin-key'.applySupported) "PIN-key rotation must remain a staged migration."
    Assert-Condition (-not $catalog.student.applySupported) "Student-token rotation must remain a specialized registration cutover."

    $secureRoot = Initialize-SecureWorkDirectory -Path (Join-Path $testRoot "external") -RepoRoot $repositoryRoot
    Assert-OwnerOnlyAcl -Path $secureRoot
    Assert-Throws {
        Initialize-SecureWorkDirectory -Path (Join-Path $repositoryRoot ".credential-test-must-not-exist") -RepoRoot $repositoryRoot
    } "Work material inside the repository must be rejected."

    $dpapiMarker = "dpapi-marker-" + [Guid]::NewGuid().ToString("N")
    $dpapiSecure = ConvertTo-SecureString -String $dpapiMarker -AsPlainText -Force
    $dpapiPath = Join-Path $secureRoot "rollback.dpapi"
    Protect-RollbackSecret -Value $dpapiSecure -Path $dpapiPath -EntropyText "test-entropy"
    $protectedText = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($dpapiPath))
    Assert-Condition (-not $protectedText.Contains($dpapiMarker)) "DPAPI rollback file must not contain plaintext."
    $roundTrip = Unprotect-RollbackSecret -Path $dpapiPath -EntropyText "test-entropy"
    try { Assert-Condition ((Get-PlaintextForTest -Value $roundTrip) -ceq $dpapiMarker) "DPAPI rollback material must round-trip." }
    finally { $roundTrip.Dispose(); $dpapiSecure.Dispose() }

    $evidencePath = Join-Path $secureRoot "evidence.jsonl"
    Write-SanitizedEvidenceEvent -EvidencePath $evidencePath -RunId "run-test" -PhaseName "google" -Event "unit" -Details @{ ssmVersion = 3; hashPrefix = "0123456789ab" }
    Assert-Throws {
        Write-SanitizedEvidenceEvent -EvidencePath $evidencePath -RunId "run-test" -PhaseName "google" -Event "unit" -Details @{ unexpected = "field" }
    } "Evidence must enforce an event-specific field allowlist."
    Assert-Throws {
        Write-SanitizedEvidenceEvent -EvidencePath $evidencePath -RunId "run-test" -PhaseName "google" -Event "unknown" -Details @{}
    } "Evidence must reject unknown events."

    $manifestPath = Join-Path $secureRoot "integrity-plan.json"
    $manifest = [pscustomobject][ordered]@{
        schemaVersion = 1
        runId = "run-test"
        phase = "google"
        environment = "production"
        status = "planned"
        createdAt = [DateTimeOffset]::UtcNow.AddMinutes(-1).ToString("o")
        repositoryRoot = $repositoryRoot
        repositoryGitSha = ("a" * 40)
    }
    Write-RotationManifest -Manifest $manifest -Path $manifestPath
    $loaded = Read-RotationManifest -Path $manifestPath
    Assert-Condition ($loaded.phase -ceq "google") "Manifest must round-trip."
    $tampered = [IO.File]::ReadAllText($manifestPath).Replace('"google"', '"sendgrid"')
    [IO.File]::WriteAllText($manifestPath, $tampered)
    Assert-OwnerOnlyAcl -Path $manifestPath
    Assert-Throws { Read-RotationManifest -Path $manifestPath } "Tampered manifests must fail integrity checks."

    $global:RotationTestState = [ordered]@{
        Calls = [Collections.Generic.List[string]]::new()
        GitSha = ("a" * 40)
        ParameterName = "/schoolpilot/production/SESSION_SECRET"
        SsmVersion = 7
        SsmCiphertext = "encrypted-ciphertext-v7"
        SsmPlaintext = "live-ssm-prior-" + [Guid]::NewGuid().ToString("N")
        DesiredPlaintext = "replacement-secret-" + [Guid]::NewGuid().ToString("N")
        WriteScenario = "read-only"
        ApiArn = "arn:aws:ecs:us-east-1:000000000000:task-definition/schoolpilot-production-api:10"
        WorkerArn = "arn:aws:ecs:us-east-1:000000000000:task-definition/schoolpilot-production-scheduler-worker:11"
        RegisteredCount = 20
        RuntimeSecretName = "SESSION_SECRET"
        SourceTaskSecretScenario = "valid"
        ClonedTaskSecretScenario = "valid"
        TaskSecretScenarioTarget = "both"
        LogMode = "empty"
        LogEventOutput = ""
    }
    $global:SchoolPilotCredentialRotationTestHandler = {
        param([string]$Command, [string[]]$Arguments)
        $state = $global:RotationTestState
        $state.Calls.Add($Command + " " + ($Arguments -join " "))
        if ($Command -ceq "timeout-fixture") {
            return [pscustomobject]@{ ExitCode = 0; StdOut = ""; StdErr = ""; TimedOut = $true }
        }
        if ($Command -ceq "git") {
            if ($Arguments -contains "rev-parse") { return [pscustomobject]@{ ExitCode = 0; StdOut = [string]$state.GitSha; StdErr = "" } }
            if ($Arguments -contains "branch") { return [pscustomobject]@{ ExitCode = 0; StdOut = "main"; StdErr = "" } }
            if ($Arguments -contains "status") { return [pscustomobject]@{ ExitCode = 0; StdOut = ""; StdErr = "" } }
        }
        if ($Command -ceq "terraform" -and $Arguments -contains "list") {
            return [pscustomobject]@{ ExitCode = 0; StdOut = "module.ecs.aws_ssm_parameter.redis_url`n"; StdErr = "" }
        }
        if ($Command -ceq "aws" -and $Arguments[0] -ceq "ssm" -and $Arguments[1] -ceq "get-parameter") {
            $value = if ($Arguments -contains "--with-decryption") { [string]$state.SsmPlaintext } else { [string]$state.SsmCiphertext }
            return [pscustomobject]@{
                ExitCode = 0
                StdOut = (@{ Parameter = @{ Name = [string]$state.ParameterName; Type = "SecureString"; Version = [int64]$state.SsmVersion; Value = $value } } | ConvertTo-Json -Compress)
                StdErr = ""
            }
        }
        if ($Command -ceq "aws" -and $Arguments[0] -ceq "ssm" -and $Arguments[1] -ceq "describe-parameters") {
            return [pscustomobject]@{
                ExitCode = 0
                StdOut = (@{ Parameters = @(@{ Name = [string]$state.ParameterName; Type = "SecureString"; Version = [int64]$state.SsmVersion; KeyId = "alias/aws/ssm"; Tier = "Standard"; DataType = "text" }) } | ConvertTo-Json -Depth 6 -Compress)
                StdErr = ""
            }
        }
        if ($Command -ceq "aws" -and $Arguments[0] -ceq "ssm" -and $Arguments[1] -ceq "put-parameter") {
            $next = [int64]$state.SsmVersion + 1
            switch ([string]$state.WriteScenario) {
                "failed-after-write" {
                    $state.SsmVersion = $next; $state.SsmCiphertext = "cipher-intended-$next"; $state.SsmPlaintext = [string]$state.DesiredPlaintext
                    return [pscustomobject]@{ ExitCode = 1; StdOut = ""; StdErr = "mock failure" }
                }
                "timeout-after-write" {
                    $state.SsmVersion = $next; $state.SsmCiphertext = "cipher-intended-$next"; $state.SsmPlaintext = [string]$state.DesiredPlaintext
                    return [pscustomobject]@{ ExitCode = 0; StdOut = ""; StdErr = ""; TimedOut = $true }
                }
                "unchanged-failure" {
                    return [pscustomobject]@{ ExitCode = 1; StdOut = ""; StdErr = "mock failure" }
                }
                "concurrent-advance" {
                    $state.SsmVersion = $next + 1; $state.SsmCiphertext = "cipher-concurrent"; $state.SsmPlaintext = "concurrent-value"
                    return [pscustomobject]@{ ExitCode = 1; StdOut = ""; StdErr = "mock failure" }
                }
                "post-write-gate-failure" {
                    $state.SsmVersion = $next; $state.SsmCiphertext = "cipher-wrong"; $state.SsmPlaintext = "wrong-value"
                    return [pscustomobject]@{ ExitCode = 0; StdOut = (@{ Version = $next } | ConvertTo-Json -Compress); StdErr = "" }
                }
                "success-from-request" {
                    $fileArg = @($Arguments | Where-Object { $_ -like "file://*" })[0].Substring(7)
                    $request = Get-Content -LiteralPath $fileArg -Raw | ConvertFrom-Json -Depth 10
                    $state.SsmVersion = $next
                    $state.SsmCiphertext = "cipher-success-$next"
                    $state.SsmPlaintext = [string]$request.Value
                    return [pscustomobject]@{ ExitCode = 0; StdOut = (@{ Version = $next } | ConvertTo-Json -Compress); StdErr = "" }
                }
                default { throw "Unexpected mocked SSM write scenario." }
            }
        }
        if ($Command -ceq "aws" -and $Arguments[0] -ceq "ecs" -and $Arguments[1] -ceq "describe-services") {
            $apiArn = [string]$state.ApiArn; $workerArn = [string]$state.WorkerArn
            return [pscustomobject]@{
                ExitCode = 0
                StdOut = (@{
                    failures = @()
                    services = @(
                        @{ serviceName = "schoolpilot-production-api"; desiredCount = 1; runningCount = 1; pendingCount = 0; taskDefinition = $apiArn; deployments = @(@{ status = "PRIMARY"; rolloutState = "COMPLETED"; taskDefinition = $apiArn }); loadBalancers = @(@{ targetGroupArn = "arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/test/abc" }) },
                        @{ serviceName = "schoolpilot-production-scheduler-worker"; desiredCount = 1; runningCount = 1; pendingCount = 0; taskDefinition = $workerArn; deployments = @(@{ status = "PRIMARY"; rolloutState = "COMPLETED"; taskDefinition = $workerArn }); loadBalancers = @() }
                    )
                } | ConvertTo-Json -Depth 12 -Compress)
                StdErr = ""
            }
        }
        if ($Command -ceq "aws" -and $Arguments[0] -ceq "ecs" -and $Arguments[1] -ceq "describe-task-definition") {
            $arnIndex = [Array]::IndexOf($Arguments, "--task-definition") + 1
            $arn = $Arguments[$arnIndex]
            $container = if ($arn -match 'scheduler-worker') { "scheduler-worker" } else { "api" }
            $family = if ($container -ceq "api") { "schoolpilot-production-api" } else { "schoolpilot-production-scheduler-worker" }
            $isSource = $arn -in @([string]$state.ApiArn, [string]$state.WorkerArn)
            $scenario = if ($isSource) { [string]$state.SourceTaskSecretScenario } else { [string]$state.ClonedTaskSecretScenario }
            $targetMatches = [string]$state.TaskSecretScenarioTarget -in @("both", $container)
            if (-not $targetMatches) { $scenario = "valid" }
            $expectedSsmArn = "arn:aws:ssm:us-east-1:000000000000:parameter$($state.ParameterName)"
            $secretReferences = @(@{ name = [string]$state.RuntimeSecretName; valueFrom = $expectedSsmArn })
            $environment = @()
            switch ($scenario) {
                "valid" { }
                "wrong-arn" { $secretReferences[0].valueFrom = $expectedSsmArn.Replace(":000000000000:", ":999999999999:") }
                "missing" { $secretReferences = @() }
                "duplicate" { $secretReferences += @{ name = [string]$state.RuntimeSecretName; valueFrom = $expectedSsmArn } }
                "inline" { $environment = @(@{ name = [string]$state.RuntimeSecretName; value = "synthetic-inline-placeholder" }) }
                default { throw "Unexpected mocked task-secret scenario." }
            }
            $containerDefinition = @{
                name = $container
                image = ("repo@sha256:" + ("b" * 64))
                essential = $true
                secrets = $secretReferences
                environment = $environment
            }
            $definition = @{
                taskDefinitionArn = $arn
                family = $family
                networkMode = "awsvpc"
                requiresCompatibilities = @("FARGATE")
                cpu = "512"
                memory = "1024"
                containerDefinitions = @($containerDefinition)
            }
            if ($Arguments -contains "--query") {
                $query = $Arguments[[Array]::IndexOf($Arguments, "--query") + 1]
                if ($query.Contains("environmentNames:environment[].name")) {
                    $projected = @{
                        taskDefinitionArn = $arn
                        containerDefinitions = @(@{
                            name = $container
                            secrets = $secretReferences
                            environmentNames = @($environment | ForEach-Object { $_.name })
                        })
                    }
                    return [pscustomobject]@{ ExitCode = 0; StdOut = ($projected | ConvertTo-Json -Depth 10 -Compress); StdErr = "" }
                }
                return [pscustomobject]@{ ExitCode = 0; StdOut = ($definition | ConvertTo-Json -Depth 8 -Compress); StdErr = "" }
            }
            return [pscustomobject]@{ ExitCode = 0; StdOut = (@{ taskDefinition = $definition; tags = @(@{ key = "Project"; value = "SchoolPilot" }) } | ConvertTo-Json -Depth 12 -Compress); StdErr = "" }
        }
        if ($Command -ceq "aws" -and $Arguments[0] -ceq "ecs" -and $Arguments[1] -ceq "register-task-definition") {
            $fileArg = @($Arguments | Where-Object { $_ -like "file://*" })[0].Substring(7)
            $request = Get-Content -LiteralPath $fileArg -Raw | ConvertFrom-Json -Depth 30
            $state.RegisteredCount = [int]$state.RegisteredCount + 1
            $arn = "arn:aws:ecs:us-east-1:000000000000:task-definition/$($request.family):$($state.RegisteredCount)"
            return [pscustomobject]@{ ExitCode = 0; StdOut = (@{ taskDefinition = @{ taskDefinitionArn = $arn } } | ConvertTo-Json -Compress); StdErr = "" }
        }
        if ($Command -ceq "aws" -and $Arguments[0] -ceq "ecs" -and $Arguments[1] -ceq "update-service") {
            $service = $Arguments[[Array]::IndexOf($Arguments, "--service") + 1]
            $task = $Arguments[[Array]::IndexOf($Arguments, "--task-definition") + 1]
            if ($service -ceq "schoolpilot-production-api") { $state.ApiArn = $task }
            elseif ($service -ceq "schoolpilot-production-scheduler-worker") { $state.WorkerArn = $task }
            else { throw "Unexpected mocked ECS service update." }
            return [pscustomobject]@{ ExitCode = 0; StdOut = (@{ service = @{ serviceName = $service; taskDefinition = $task } } | ConvertTo-Json -Compress); StdErr = "" }
        }
        if ($Command -ceq "aws" -and $Arguments[0] -ceq "ecs" -and $Arguments[1] -ceq "wait") {
            return [pscustomobject]@{ ExitCode = 0; StdOut = ""; StdErr = "" }
        }
        if ($Command -ceq "aws" -and $Arguments[0] -ceq "logs" -and $Arguments[1] -ceq "filter-log-events") {
            if ([string]$state.LogMode -ceq "direct") {
                return [pscustomobject]@{ ExitCode = 0; StdOut = [string]$state.LogEventOutput; StdErr = "" }
            }
            if ([string]$state.LogMode -ceq "rollback-success") {
                $pattern = $Arguments[[Array]::IndexOf($Arguments, "--filter-pattern") + 1].Trim('"')
                $output = switch ($pattern) {
                    "prewarmed" { "api-page-one`napi-page-two" }
                    "WorkerHeartbeat" { "worker-page-one`nworker-page-two" }
                    default { "None" }
                }
                return [pscustomobject]@{ ExitCode = 0; StdOut = $output; StdErr = "" }
            }
            return [pscustomobject]@{ ExitCode = 0; StdOut = "None"; StdErr = "" }
        }
        if ($Command -ceq "aws" -and $Arguments[0] -ceq "elbv2") {
            return [pscustomobject]@{ ExitCode = 0; StdOut = '{"TargetHealthDescriptions":[{"TargetHealth":{"State":"healthy"}}]}'; StdErr = "" }
        }
        throw "Unexpected mocked command: $Command"
    }
    $global:SchoolPilotCredentialRotationHealthHandler = {
        param([string]$Uri)
        return [pscustomobject]@{ StatusCode = 200; Content = '{"status":"ok"}' }
    }

    Assert-Throws { Invoke-ExternalCommand -Command "timeout-fixture" -TimeoutSeconds 1 } "Mocked bounded timeout must fail closed."

    $before = New-TestSsmSnapshot -Version 7 -Ciphertext "encrypted-ciphertext-v7" -Plaintext ([string]$global:RotationTestState.SsmPlaintext)
    $same = New-TestSsmSnapshot -Version 7 -Ciphertext "encrypted-ciphertext-v7" -Plaintext ([string]$global:RotationTestState.SsmPlaintext)
    Assert-Condition ((Get-SsmMutationDisposition -Before $before -Current $same -DesiredPlaintextHash "unused") -ceq "unchanged") "Exact prior snapshot must classify unchanged."
    $intended = New-TestSsmSnapshot -Version 8 -Ciphertext "cipher-v8" -Plaintext ([string]$global:RotationTestState.DesiredPlaintext)
    Assert-Condition ((Get-SsmMutationDisposition -Before $before -Current $intended -DesiredPlaintextHash $intended.PlaintextHash) -ceq "intended") "Exact next version/hash must classify intended."
    $concurrent = New-TestSsmSnapshot -Version 9 -Ciphertext "cipher-v9" -Plaintext "other"
    Assert-Condition ((Get-SsmMutationDisposition -Before $before -Current $concurrent -DesiredPlaintextHash $intended.PlaintextHash) -ceq "indeterminate") "Concurrent version advance must classify indeterminate."

    $replacement = ConvertTo-SecureString -String ([string]$global:RotationTestState.DesiredPlaintext) -AsPlainText -Force
    $desiredHash = Get-SecureStringHash -Value $replacement
    foreach ($case in @(
        @{ Scenario = "failed-after-write"; Expected = "intended" },
        @{ Scenario = "timeout-after-write"; Expected = "intended" },
        @{ Scenario = "unchanged-failure"; Expected = "unchanged" },
        @{ Scenario = "concurrent-advance"; Expected = "indeterminate" },
        @{ Scenario = "post-write-gate-failure"; Expected = "indeterminate" }
    )) {
        Set-MockedSsmState -Version 7 -Ciphertext "encrypted-ciphertext-v7" -Plaintext ([string]$before.PlaintextHash) -Scenario ([string]$case.Scenario)
        # Restore the actual prior plaintext; the snapshot hash below is regenerated for exact comparison.
        $global:RotationTestState.SsmPlaintext = "prior-for-$($case.Scenario)"
        $caseBefore = New-TestSsmSnapshot -Version 7 -Ciphertext "encrypted-ciphertext-v7" -Plaintext ([string]$global:RotationTestState.SsmPlaintext)
        $write = Invoke-SsmSecretWrite `
            -ParameterName ([string]$global:RotationTestState.ParameterName) `
            -Value $replacement `
            -Directory $secureRoot `
            -AwsRegion "us-east-1" `
            -BeforeSnapshot $caseBefore `
            -DesiredPlaintextHash $desiredHash
        Assert-Condition ([string]$write.Disposition -ceq [string]$case.Expected) "SSM scenario $($case.Scenario) must reconcile as $($case.Expected)."
    }
    $replacement.Dispose()
    Assert-Condition ($script:MutationStarted) "SSM mutation attempt must be marked before the command."
    Assert-Condition (-not (($global:RotationTestState.Calls -join "`n").Contains([string]$global:RotationTestState.DesiredPlaintext))) "External command arguments must not contain plaintext."

    $global:RotationTestState.LogMode = "direct"
    $global:RotationTestState.LogEventOutput = "event-page-one`nevent-page-two`tevent-page-three"
    $logCallsBefore = $global:RotationTestState.Calls.Count
    $multiPageCount = Get-CloudWatchFilterCount `
        -LogGroup "/ecs/schoolpilot-production-api" `
        -StreamPrefix "api" `
        -FilterPattern "prewarmed" `
        -StartTimeMs 1 `
        -AwsRegion "us-east-1"
    Assert-Condition ($multiPageCount -eq 3) "CloudWatch event IDs from every paginator page must aggregate locally."
    $logCall = @($global:RotationTestState.Calls | Select-Object -Skip $logCallsBefore | Where-Object { $_ -match 'logs filter-log-events' })
    Assert-Condition ($logCall.Count -eq 1 -and $logCall[0].Contains("events[].eventId")) "CloudWatch queries must project only event IDs."
    Assert-Condition (-not $logCall[0].Contains("length(events)")) "CloudWatch pagination must not use one scalar length per page."
    $global:RotationTestState.LogEventOutput = "None"
    Assert-Condition ((Get-CloudWatchFilterCount -LogGroup "/ecs/test" -StreamPrefix "" -FilterPattern "none" -StartTimeMs 1 -AwsRegion "us-east-1") -eq 0) "CloudWatch empty text projection must count as zero."
    $global:RotationTestState.LogEventOutput = "valid-event`nNone"
    Assert-Throws {
        Get-CloudWatchFilterCount -LogGroup "/ecs/test" -StreamPrefix "" -FilterPattern "invalid" -StartTimeMs 1 -AwsRegion "us-east-1"
    } "Mixed invalid CloudWatch paginator output must fail closed."
    $global:RotationTestState.LogMode = "empty"

    $contractSnapshot = [pscustomobject]@{
        ApiTaskDefinitionArn = [string]$global:RotationTestState.ApiArn
        WorkerTaskDefinitionArn = [string]$global:RotationTestState.WorkerArn
    }
    Assert-ServiceRuntimeSecretContract `
        -ServiceSnapshot $contractSnapshot `
        -RuntimeSecretName "SESSION_SECRET" `
        -ParameterName ([string]$global:RotationTestState.ParameterName) `
        -AwsRegion "us-east-1"
    foreach ($case in @(
        @{ Scenario = "wrong-arn"; Target = "api" },
        @{ Scenario = "missing"; Target = "scheduler-worker" },
        @{ Scenario = "duplicate"; Target = "api" },
        @{ Scenario = "inline"; Target = "scheduler-worker" }
    )) {
        $global:RotationTestState.SourceTaskSecretScenario = [string]$case.Scenario
        $global:RotationTestState.TaskSecretScenarioTarget = [string]$case.Target
        $updatesBefore = @($global:RotationTestState.Calls | Where-Object { $_ -match 'ecs update-service' }).Count
        Assert-Throws {
            Assert-ServiceRuntimeSecretContract `
                -ServiceSnapshot $contractSnapshot `
                -RuntimeSecretName "SESSION_SECRET" `
                -ParameterName ([string]$global:RotationTestState.ParameterName) `
                -AwsRegion "us-east-1"
        } "Source task secret scenario $($case.Scenario) on $($case.Target) must fail closed."
        $updatesAfter = @($global:RotationTestState.Calls | Where-Object { $_ -match 'ecs update-service' }).Count
        Assert-Condition ($updatesAfter -eq $updatesBefore) "Source contract failure must occur before any service update."
    }
    $global:RotationTestState.SourceTaskSecretScenario = "valid"
    $global:RotationTestState.TaskSecretScenarioTarget = "both"

    Set-MockedSsmState -Version 7 -Ciphertext "encrypted-ciphertext-v7" -Plaintext ("live-plan-prior-" + [Guid]::NewGuid().ToString("N"))
    $livePlanMarker = [string]$global:RotationTestState.SsmPlaintext
    $planResult = New-CredentialRotationPlan `
        -PhaseName "session" `
        -Configuration $catalog.session `
        -EnvironmentName "production" `
        -ProjectName "schoolpilot" `
        -AwsRegion "us-east-1" `
        -RepoRoot $repositoryRoot `
        -ExternalRoot $secureRoot
    Assert-Condition ([IO.File]::Exists($planResult.PlanPath)) "Mocked Plan must write its private manifest."
    $planManifest = Read-RotationManifest -Path $planResult.PlanPath
    Assert-Condition ([int]$planManifest.prior.ssm.Version -eq 7) "Plan must capture the prior SSM version."
    Assert-Condition ([string]$planManifest.prior.ssm.PlaintextHash -ceq (Get-TestHash -Value $livePlanMarker)) "Plan must hash live SSM plaintext."
    Assert-Condition ([string]$planManifest.terraformResourceName -ceq "session_secret") "Plan must retain only the nonsecret Terraform resource mapping."
    Assert-Condition (-not ($planManifest.PSObject.Properties.Name -contains "secretsFilePath")) "Plan must not reference a repository secret file."
    $planPrior = Unprotect-RollbackSecret -Path ([string]$planManifest.rollbackBlobPath) -EntropyText "$($planManifest.runId)|session|$($planManifest.parameterName)"
    try { Assert-Condition ((Get-PlaintextForTest -Value $planPrior) -ceq $livePlanMarker) "Plan DPAPI rollback must round-trip from mocked live SSM." }
    finally { $planPrior.Dispose() }
    $null = Assert-CurrentPlanState -Manifest $planManifest -AwsRegion "us-east-1"
    $planEvidence = [IO.File]::ReadAllText($planResult.EvidencePath)
    $planJson = [IO.File]::ReadAllText($planResult.PlanPath)
    Assert-Condition (-not $planEvidence.Contains($livePlanMarker)) "Plan evidence must not contain live SSM plaintext."
    Assert-Condition (-not $planJson.Contains($livePlanMarker)) "Plan manifest must not contain live SSM plaintext."
    Assert-Condition (@($global:RotationTestState.Calls | Where-Object { $_ -match 'ssm put-parameter|ecs update-service|register-task-definition' }).Count -eq 5) "Only the five explicit mocked SSM-write unit scenarios may mutate; Plan/Validate must not."

    $global:RotationTestState.GitSha = ("c" * 40)
    Assert-Throws { Assert-CurrentPlanState -Manifest $planManifest -AwsRegion "us-east-1" } "Validate must require exact manifest Git SHA equality."
    $global:RotationTestState.GitSha = ("a" * 40)

    $cutoverManifest = [pscustomobject]@{
        phase = "session"
        parameterName = [string]$global:RotationTestState.ParameterName
        cluster = "schoolpilot-production-cluster"
        apiService = "schoolpilot-production-api"
        workerService = "schoolpilot-production-scheduler-worker"
        prior = [pscustomobject]@{
            apiTaskDefinitionArn = [string]$global:RotationTestState.ApiArn
            workerTaskDefinitionArn = [string]$global:RotationTestState.WorkerArn
            imageDigest = "sha256:" + ("b" * 64)
        }
    }
    $cutoverSsm = New-TestSsmSnapshot `
        -Version ([int64]$global:RotationTestState.SsmVersion) `
        -Ciphertext ([string]$global:RotationTestState.SsmCiphertext) `
        -Plaintext ([string]$global:RotationTestState.SsmPlaintext)
    foreach ($case in @(
        @{ Scenario = "wrong-arn"; Target = "api" },
        @{ Scenario = "missing"; Target = "scheduler-worker" },
        @{ Scenario = "duplicate"; Target = "api" },
        @{ Scenario = "inline"; Target = "scheduler-worker" }
    )) {
        $global:RotationTestState.ClonedTaskSecretScenario = [string]$case.Scenario
        $global:RotationTestState.TaskSecretScenarioTarget = [string]$case.Target
        $updatesBefore = @($global:RotationTestState.Calls | Where-Object { $_ -match 'ecs update-service' }).Count
        Assert-Throws {
            Invoke-SecretOnlyTaskCutover `
                -Manifest $cutoverManifest `
                -ExpectedSsmSnapshot $cutoverSsm `
                -RunDirectory $secureRoot `
                -AwsRegion "us-east-1"
        } "Cloned task secret scenario $($case.Scenario) on $($case.Target) must fail closed."
        $updatesAfter = @($global:RotationTestState.Calls | Where-Object { $_ -match 'ecs update-service' }).Count
        Assert-Condition ($updatesAfter -eq $updatesBefore) "Cloned contract failure must occur before any service update."
    }
    $global:RotationTestState.ClonedTaskSecretScenario = "valid"
    $global:RotationTestState.TaskSecretScenarioTarget = "both"

    $rollbackPriorPlaintext = "rollback-prior-" + [Guid]::NewGuid().ToString("N")
    $rollbackCurrentPlaintext = "rollback-current-" + [Guid]::NewGuid().ToString("N")
    Set-MockedSsmState -Version 40 -Ciphertext "rollback-cipher-v40" -Plaintext $rollbackCurrentPlaintext -Scenario "success-from-request"
    $rollbackExpectedSsm = New-TestSsmSnapshot -Version 40 -Ciphertext "rollback-cipher-v40" -Plaintext $rollbackCurrentPlaintext
    $rollbackPriorSsm = New-TestSsmSnapshot -Version 39 -Ciphertext "rollback-cipher-v39" -Plaintext $rollbackPriorPlaintext
    $rollbackApiArn = "arn:aws:ecs:us-east-1:000000000000:task-definition/schoolpilot-production-api:10"
    $rollbackWorkerArn = "arn:aws:ecs:us-east-1:000000000000:task-definition/schoolpilot-production-scheduler-worker:11"
    $global:RotationTestState.ApiArn = "arn:aws:ecs:us-east-1:000000000000:task-definition/schoolpilot-production-api:30"
    $global:RotationTestState.WorkerArn = "arn:aws:ecs:us-east-1:000000000000:task-definition/schoolpilot-production-scheduler-worker:31"
    $global:RotationTestState.LogMode = "rollback-success"
    $rollbackManifest = [pscustomobject]@{
        parameterName = [string]$global:RotationTestState.ParameterName
        cluster = "schoolpilot-production-cluster"
        apiService = "schoolpilot-production-api"
        workerService = "schoolpilot-production-scheduler-worker"
        project = "schoolpilot"
        environment = "production"
        prior = [pscustomobject]@{
            ssm = $rollbackPriorSsm
            apiTaskDefinitionArn = $rollbackApiArn
            workerTaskDefinitionArn = $rollbackWorkerArn
            imageDigest = "sha256:" + ("b" * 64)
        }
    }
    $rollbackPriorSecret = ConvertTo-SecureString -String $rollbackPriorPlaintext -AsPlainText -Force
    try {
        $rollbackResult = Invoke-CredentialRollbackCore `
            -Manifest $rollbackManifest `
            -Configuration $catalog.google `
            -AwsRegion "us-east-1" `
            -RunDirectory $secureRoot `
            -ExpectedCurrentSsmSnapshot $rollbackExpectedSsm `
            -PriorSecret $rollbackPriorSecret `
            -LogStartTimeMs 1
        Assert-Condition ($rollbackResult.Services.ApiTaskDefinitionArn -ceq $rollbackApiArn) "Rollback must restore the captured API task definition."
        Assert-Condition ($rollbackResult.Services.WorkerTaskDefinitionArn -ceq $rollbackWorkerArn) "Rollback must restore the captured worker task definition."
        Assert-Condition ([string]$rollbackResult.Ssm.PlaintextHash -ceq [string]$rollbackPriorSsm.PlaintextHash) "Rollback must restore the prior SSM plaintext hash."
    }
    finally { $rollbackPriorSecret.Dispose() }
    $global:RotationTestState.LogMode = "empty"

    $cloneCallsBefore = $global:RotationTestState.Calls.Count
    $expectedCloneRevision = [int]$global:RotationTestState.RegisteredCount + 1
    $clonedArn = Register-ClonedTaskDefinition -TaskDefinitionArn ([string]$global:RotationTestState.ApiArn) -Directory $secureRoot -AwsRegion "us-east-1"
    Assert-Condition ($clonedArn -match ":$expectedCloneRevision`$") "Task clone must register a distinct revision."
    $cloneCalls = @($global:RotationTestState.Calls | Select-Object -Skip $cloneCallsBefore)
    Assert-Condition (@($cloneCalls | Where-Object { $_ -match 'ecs register-task-definition' }).Count -eq 1) "Task clone must perform exactly one registration."
    Assert-Condition (@($cloneCalls | Where-Object { $_ -match '(?i)bash|docker|ecr|migration|deploy\.sh' }).Count -eq 0) "Task clone must not build, push, or run migrations."

    $gateManifest = [pscustomobject][ordered]@{
        runId = "stripe-run"
        phase = "stripe-api"
        createdAt = [DateTimeOffset]::UtcNow.AddMinutes(-1).ToString("o")
        manifestHash = "manifest-bound-hash"
    }
    $stripeKey = ConvertTo-SecureString -String "stripe-test-placeholder-without-secret-shape" -AsPlainText -Force
    $global:StripeAccountForTest = "acct_same123"
    $global:SchoolPilotStripeIdentityTestHandler = { return [string]$global:StripeAccountForTest }
    $sameAccount = Assert-StripeReplacementIdentity -PhaseName "stripe-api" -PriorAccountId "acct_same123" -Replacement $stripeKey -RepoRoot $repositoryRoot -Manifest $gateManifest
    Assert-Condition ($sameAccount -ceq "acct_same123") "Same-account Stripe key must pass the read-only identity gate."
    $global:StripeAccountForTest = "acct_new456"
    Assert-Throws {
        Assert-StripeReplacementIdentity -PhaseName "stripe-api" -PriorAccountId "acct_old123" -Replacement $stripeKey -RepoRoot $repositoryRoot -Manifest $gateManifest
    } "Cross-account Stripe replacement must require private evidence."
    $crossEvidence = Join-Path $secureRoot "stripe-cross-account.json"
    Write-GateEvidenceFixture -Path $crossEvidence -Phase "stripe-api" -Manifest $gateManifest -Checks @{
        activeSubscriptions = 0
        unresolvedProductionDbStripeReferences = 0
        targetChargesReady = $true
        targetPayoutsReady = $true
        targetBusinessReady = $true
        old42DispositionConfirmed = $true
        webhookRecreationReady = $true
        webhookRecreationReviewed = $true
        reviewed = $true
    } -Additional @{ oldAccountId = "acct_old123"; newAccountId = "acct_new456" }
    $crossAccount = Assert-StripeReplacementIdentity -PhaseName "stripe-api" -PriorAccountId "acct_old123" -Replacement $stripeKey -EvidencePath $crossEvidence -RepoRoot $repositoryRoot -Manifest $gateManifest
    Assert-Condition ($crossAccount -ceq "acct_new456") "Complete exact cross-account evidence must pass."

    $webhookManifest = [pscustomobject][ordered]@{
        runId = "stripe-webhook-run"
        phase = "stripe-webhook"
        createdAt = [DateTimeOffset]::UtcNow.AddMinutes(-1).ToString("o")
        manifestHash = "webhook-bound-hash"
    }
    Assert-Throws {
        Assert-StripeReplacementIdentity -PhaseName "stripe-webhook" -PriorAccountId "acct_new456" -RepoRoot $repositoryRoot -Manifest $webhookManifest
    } "Stripe webhook cutover must require exact target-account evidence."
    $webhookEvidence = Join-Path $secureRoot "stripe-webhook.json"
    Write-GateEvidenceFixture -Path $webhookEvidence -Phase "stripe-webhook" -Manifest $webhookManifest -Checks @{
        webhookRecreationReady = $true
        endpointOwnershipReviewed = $true
    } -Additional @{ oldAccountId = "acct_new456"; targetAccountId = "acct_new456" }
    $webhookAccount = Assert-StripeReplacementIdentity -PhaseName "stripe-webhook" -PriorAccountId "acct_new456" -EvidencePath $webhookEvidence -RepoRoot $repositoryRoot -Manifest $webhookManifest
    Assert-Condition ($webhookAccount -ceq "acct_new456") "Webhook evidence must bind the exact target account."

    $wrongBinding = (Get-Content -LiteralPath $webhookEvidence -Raw | ConvertFrom-Json -Depth 20)
    $wrongBinding.runId = "wrong-run"
    [IO.File]::WriteAllText($webhookEvidence, ($wrongBinding | ConvertTo-Json -Depth 20))
    Set-OwnerOnlyAcl -Path $webhookEvidence
    Assert-Throws {
        Read-GateEvidence -Path $webhookEvidence -ExpectedPhase "stripe-webhook" -RepoRoot $repositoryRoot -Manifest $webhookManifest
    } "Gate evidence must bind the exact run ID and manifest hash."
    $stripeKey.Dispose()

    Assert-Throws {
        Assert-PhaseApplyGate -PhaseName "google" -Configuration $catalog.google -RepoRoot $repositoryRoot -Manifest $gateManifest
    } "Provider phases must require overlap confirmation."
    Assert-PhaseApplyGate -PhaseName "google" -Configuration $catalog.google -RepoRoot $repositoryRoot -Manifest $gateManifest -OverlapConfirmed
    Assert-Throws {
        Assert-PhaseApplyGate -PhaseName "session" -Configuration $catalog.session -RepoRoot $repositoryRoot -Manifest $gateManifest -DisruptiveConfirmed
    } "Unsafe session rolling rotation must remain blocked even with acknowledgement."
    Assert-Throws {
        Assert-PhaseApplyGate -PhaseName "jwt" -Configuration $catalog.jwt -RepoRoot $repositoryRoot -Manifest $gateManifest -DisruptiveConfirmed
    } "Unsafe JWT rolling rotation must remain blocked even with acknowledgement."
    Assert-Throws {
        Assert-PhaseApplyGate -PhaseName "openai" -Configuration $catalog.openai -RepoRoot $repositoryRoot -Manifest $gateManifest -OverlapConfirmed
    } "Unused OpenAI phase must remain removal-oriented."

    Write-Host "Credential rotation parser/unit tests: PASS ($script:Assertions assertions)"
}
finally {
    $env:SCHOOLPILOT_CREDENTIAL_ROTATION_IMPORT_ONLY = $priorImport
    $env:SCHOOLPILOT_CREDENTIAL_ROTATION_TEST_MODE = $priorTestMode
    Remove-Variable -Name SchoolPilotCredentialRotationTestHandler -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name SchoolPilotCredentialRotationHealthHandler -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name SchoolPilotStripeIdentityTestHandler -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name StripeAccountForTest -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name RotationTestState -Scope Global -ErrorAction SilentlyContinue
    if ([IO.Directory]::Exists($testRoot) -and (Test-IsPathWithin -Candidate $testRoot -Parent $tempBase)) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
