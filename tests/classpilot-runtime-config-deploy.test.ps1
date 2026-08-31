#requires -Version 7.5

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

function Write-TestJson {
    param([string]$Path, $Value)
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
    if ($null -ne (Get-Command Set-PrivatePathPermissions -ErrorAction SilentlyContinue)) {
        Set-PrivatePathPermissions -Path $Path
    }
}

function Get-ArgumentValue {
    param([string[]]$Arguments, [string]$Name)
    $index = [Array]::IndexOf($Arguments, $Name)
    if ($index -lt 0 -or $index + 1 -ge $Arguments.Count) { throw "Mock call omitted $Name." }
    return [string]$Arguments[$index + 1]
}

function New-TestTaskResponse {
    param(
        [ValidateSet("api", "worker")][string]$Role,
        [string]$Arn,
        [string]$Digest,
        [object[]]$ManagedEnvironment = @(),
        [object[]]$ManagedSecrets = @()
    )
    $isApi = $Role -ceq "api"
    $containerName = if ($isApi) { "api" } else { "scheduler-worker" }
    $family = [string]$Arn.Split("/")[-1].Split(":")[0]
    $cpu = if ($isApi) { "512" } else { "256" }
    $memory = if ($isApi) { "2048" } else { "512" }
    $environment = @([pscustomobject]@{ name = "NODE_ENV"; value = "production" }) + @($ManagedEnvironment)
    $secrets = @([pscustomobject]@{
        name = "REDIS_URL"
        valueFrom = "arn:aws:ssm:us-east-1:135775632425:parameter/schoolpilot/production/REDIS_URL"
    }) + @($ManagedSecrets)
    return [pscustomobject]@{
        taskDefinition = [pscustomobject][ordered]@{
            taskDefinitionArn = $Arn
            revision = [int]($Arn.Split(":")[-1])
            status = "ACTIVE"
            family = $family
            taskRoleArn = "arn:aws:iam::135775632425:role/schoolpilot-production-ecs-task"
            executionRoleArn = "arn:aws:iam::135775632425:role/schoolpilot-production-ecs-execution"
            networkMode = "awsvpc"
            containerDefinitions = @([pscustomobject][ordered]@{
                name = $containerName
                image = "135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api@$Digest"
                essential = $true
                environment = $environment
                secrets = $secrets
                logConfiguration = [pscustomobject]@{
                    logDriver = "awslogs"
                    options = [pscustomobject]@{ "awslogs-group" = "/ecs/$family"; "awslogs-region" = "us-east-1" }
                }
            })
            volumes = @()
            placementConstraints = @()
            requiresCompatibilities = @("FARGATE")
            cpu = $cpu
            memory = $memory
            runtimePlatform = [pscustomobject]@{ cpuArchitecture = "X86_64"; operatingSystemFamily = "LINUX" }
            registeredAt = "2026-08-23T00:00:00Z"
            registeredBy = "arn:aws:iam::135775632425:user/test"
        }
        tags = @([pscustomobject]@{ key = "Environment"; value = "production" })
    }
}

function New-TestService {
    param(
        [ValidateSet("api", "worker")][string]$Role,
        [string]$TaskDefinitionArn,
        [int]$DesiredCount = 1,
        [int]$MinimumHealthyPercent = 100,
        [int]$MaximumPercent = 200,
        $DeploymentConfiguration
    )
    $isApi = $Role -ceq "api"
    $serviceName = if ($isApi) { "schoolpilot-production-api" } else { "schoolpilot-production-scheduler-worker" }
    $desired = $DesiredCount
    if ($null -eq $DeploymentConfiguration) {
        $DeploymentConfiguration = [pscustomobject]@{
            deploymentCircuitBreaker = [pscustomobject]@{ enable = $true; rollback = $true }
            minimumHealthyPercent = $MinimumHealthyPercent
            maximumPercent = $MaximumPercent
            strategy = "ROLLING"
            bakeTimeInMinutes = 0
        }
    }
    $service = [pscustomobject]@{
        serviceName = $serviceName
        status = "ACTIVE"
        desiredCount = $desired
        runningCount = $desired
        pendingCount = 0
        taskDefinition = $TaskDefinitionArn
        deploymentController = [pscustomobject]@{ type = "ECS" }
        deploymentConfiguration = $DeploymentConfiguration
        deployments = @([pscustomobject]@{
            status = "PRIMARY"
            rolloutState = "COMPLETED"
            taskDefinition = $TaskDefinitionArn
            desiredCount = $desired
            runningCount = $desired
            pendingCount = 0
            failedTasks = 0
        })
    }
    if ($isApi) {
        $service | Add-Member -NotePropertyName loadBalancers -NotePropertyValue @(
            [pscustomobject]@{
                targetGroupArn = "arn:aws:elasticloadbalancing:us-east-1:135775632425:targetgroup/schoolpilot-production-api/abcdef0123456789"
            }
        )
    }
    return $service
}

function Copy-RegisteredTask {
    param($Request, [string]$Arn)
    $copy = $Request | ConvertTo-Json -Depth 50 | ConvertFrom-Json -Depth 50
    $tags = if ($copy.PSObject.Properties.Name -contains "tags") { @($copy.tags) } else { @() }
    if ($copy.PSObject.Properties.Name -contains "tags") { $copy.PSObject.Properties.Remove("tags") }
    $copy | Add-Member -NotePropertyName taskDefinitionArn -NotePropertyValue $Arn
    $copy | Add-Member -NotePropertyName revision -NotePropertyValue ([int]($Arn.Split(":")[-1]))
    $copy | Add-Member -NotePropertyName status -NotePropertyValue "ACTIVE"
    $copy | Add-Member -NotePropertyName registeredAt -NotePropertyValue "2026-08-23T00:05:00Z"
    $copy | Add-Member -NotePropertyName registeredBy -NotePropertyValue "arn:aws:iam::135775632425:user/test"
    return [pscustomobject]@{ taskDefinition = $copy; tags = $tags }
}

function Reset-MockDeploymentState {
    param([string]$ApiArn, [string]$WorkerArn, [string]$Digest, [string]$SecretArn)
    $global:RuntimeConfigTestState = [ordered]@{
        ApiSourceArn = $ApiArn
        WorkerSourceArn = $WorkerArn
        ApiCurrentArn = $ApiArn
        WorkerCurrentArn = $WorkerArn
        Digest = $Digest
        AppSha = "a" * 40
        SecretArn = $SecretArn
        TaskResponses = @{
            $ApiArn = New-TestTaskResponse -Role api -Arn $ApiArn -Digest $Digest
            $WorkerArn = New-TestTaskResponse -Role worker -Arn $WorkerArn -Digest $Digest
        }
        NextApiRevision = 70
        NextWorkerRevision = 90
        DynamicIn = $false
        DynamicOut = $false
        Scheduled = $false
        Events = [Collections.Generic.List[string]]::new()
        RegisterCount = 0
        DriftAfterRegistration = $false
        BoundsDriftAfterRegistration = $false
        FailWorkerCandidateOnce = $false
        WorkerCandidateFailureConsumed = $false
        FailRollbackReassertion = $false
        TurnNodeCount = 2
        TurnStatusHealthy = $true
        TurnSecretDeleted = $false
        ApiDesiredCount = 1
        HealthyApiTargetCountOverride = $null
        ApiMinimumHealthyPercent = 100
        ApiMaximumPercent = 200
        WorkerMinimumHealthyPercent = 100
        WorkerMaximumPercent = 200
        ApiDeploymentConfiguration = [pscustomobject]@{
            deploymentCircuitBreaker = [pscustomobject]@{ enable = $true; rollback = $true }
            minimumHealthyPercent = 100; maximumPercent = 200
            strategy = "ROLLING"; bakeTimeInMinutes = 0
        }
        WorkerDeploymentConfiguration = [pscustomobject]@{
            deploymentCircuitBreaker = [pscustomobject]@{ enable = $true; rollback = $true }
            minimumHealthyPercent = 100; maximumPercent = 200
            strategy = "ROLLING"; bakeTimeInMinutes = 0
        }
        ScalingMin = 1
        ScalingMax = 6
        ScheduledActionMaxCapacity = $null
        SimulateScheduledDesiredChangeDuringConvergence = $false
        ScheduledDesiredChangeConsumed = $false
        DelayedScheduledChangeTrigger = ""
        DelayedScheduledChangeConsumed = $false
        FailApiBoundsRestoreOnce = $false
        ApiBoundsRestoreFailureConsumed = $false
        TransitionApiDescribeReadsRemaining = 0
        FailScalingReadbackOnce = $false
        ScalingReadbackFailureConsumed = $false
        RejectEcrLookup = $false
        LockOwner = $null
        LockPlanSha256 = $null
        LockFence = 0L
        LockExpiresAt = 0L
        LockOperationState = $null
    }
    $script:OperationLockHeld = $false
    $script:OperationLockOwner = $null
    $script:OperationLockFence = $null
    $script:OperationLockExpiresAt = 0L
    $script:OperationLockState = $null
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$helperPath = Join-Path $repositoryRoot "scripts\deploy-classpilot-runtime-config.ps1"
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("schoolpilot-runtime-config-test-" + [Guid]::NewGuid().ToString("N"))
$priorTestMode = $env:SCHOOLPILOT_RUNTIME_CONFIG_TEST_MODE
$priorAwsHandlerVariable = Get-Variable -Name SchoolPilotRuntimeConfigAwsHandler -Scope Global -ErrorAction SilentlyContinue
$priorGitHandlerVariable = Get-Variable -Name SchoolPilotRuntimeConfigGitHandler -Scope Global -ErrorAction SilentlyContinue
$priorClockHandlerVariable = Get-Variable -Name SchoolPilotRuntimeConfigClockHandler -Scope Global -ErrorAction SilentlyContinue
$priorSnapshotHandlerVariable = Get-Variable -Name SchoolPilotRuntimeConfigSnapshotReadHandler -Scope Global -ErrorAction SilentlyContinue
$priorLeaseClockHandlerVariable = Get-Variable -Name SchoolPilotRuntimeConfigLeaseClockHandler -Scope Global -ErrorAction SilentlyContinue
$priorResultWriteHandlerVariable = Get-Variable -Name SchoolPilotRuntimeConfigResultWriteHandler -Scope Global -ErrorAction SilentlyContinue
$priorAwsHandler = if ($null -ne $priorAwsHandlerVariable) { $priorAwsHandlerVariable.Value } else { $null }
$priorGitHandler = if ($null -ne $priorGitHandlerVariable) { $priorGitHandlerVariable.Value } else { $null }
$priorClockHandler = if ($null -ne $priorClockHandlerVariable) { $priorClockHandlerVariable.Value } else { $null }
$priorSnapshotHandler = if ($null -ne $priorSnapshotHandlerVariable) { $priorSnapshotHandlerVariable.Value } else { $null }
$priorLeaseClockHandler = if ($null -ne $priorLeaseClockHandlerVariable) { $priorLeaseClockHandlerVariable.Value } else { $null }
$priorResultWriteHandler = if ($null -ne $priorResultWriteHandlerVariable) { $priorResultWriteHandlerVariable.Value } else { $null }

try {
    [void][IO.Directory]::CreateDirectory($testRoot)
    $tokens = $null
    $errors = $null
    [void][Management.Automation.Language.Parser]::ParseFile($helperPath, [ref]$tokens, [ref]$errors)
    Assert-Condition ($errors.Count -eq 0) "Runtime-config deployment helper must parse."

    $source = [IO.File]::ReadAllText($helperPath)
    Assert-Condition ($source.Contains('ExpectedFamily $apiFamily') -and $source.Contains('ExpectedFamily $script:WorkerFamily')) "Helper must patch both exact task families."
    Assert-Condition (-not ($source -match '(?i)docker\s+(build|push)|terraform\s+apply|s3\s+sync|cloudfront\s+create-invalidation')) "Config-only helper must not build, migrate, apply Terraform, or deploy the frontend."
    Assert-Condition (-not ($source -match '(?i)Write-Host\s+.*(schoolId|turn\.Hosts|secretArn|ROLLOUTS_JSON)')) "Operator output must not print private profile inputs."
    Assert-Condition ($source.Contains('$process.Kill($true)') -and $source.Contains('--cli-connect-timeout') -and $source.Contains('--cli-read-timeout')) "Every real AWS call must have bounded connect, read, and process timeouts."
    Assert-Condition ($source.Contains('[int]$MaxWallClockSeconds = 3600') -and $source.Contains('[Diagnostics.Stopwatch]::StartNew()')) "Sequential drain-aware convergence must retain the reviewed one-hour outer deadline."
    Assert-Condition ($source.Contains('$AppSha.Substring(0, 12)')) "Immutable ECR identity must use the repository's reviewed 12-character deployment tag."

    $env:SCHOOLPILOT_RUNTIME_CONFIG_TEST_MODE = "I_UNDERSTAND_TEST_ONLY"
    $global:SchoolPilotRuntimeConfigAwsHandler = $null
    $global:SchoolPilotRuntimeConfigGitHandler = $null
    $global:SchoolPilotRuntimeConfigSnapshotReadHandler = $null
    $global:SchoolPilotRuntimeConfigResultWriteHandler = $null
    $global:RuntimeConfigLeaseClock = 1787486400L
    $global:SchoolPilotRuntimeConfigLeaseClockHandler = { return [long]$global:RuntimeConfigLeaseClock }
    $global:RuntimeConfigClockQueue = [Collections.Generic.Queue[DateTimeOffset]]::new()
    $global:SchoolPilotRuntimeConfigClockHandler = {
        if ($global:RuntimeConfigClockQueue.Count -gt 0) { return $global:RuntimeConfigClockQueue.Dequeue() }
        return [DateTimeOffset]::Parse("2026-08-23T08:30:00-04:00")
    }
    . $helperPath

    Assert-Condition ((Get-ApiFamilyFromTaskDefinitionArn `
        -TaskDefinitionArn "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api:190") `
        -ceq "schoolpilot-production-api") "The guarded helper must accept the normal production API family."
    Assert-Condition ((Get-ApiFamilyFromTaskDefinitionArn `
        -TaskDefinitionArn "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:91") `
        -ceq "schoolpilot-production-api-emergency") "The guarded helper must retain emergency-family compatibility."
    Assert-Throws {
        Get-ApiFamilyFromTaskDefinitionArn `
            -TaskDefinitionArn "arn:aws:ecs:us-east-1:135775632425:task-definition/unreviewed-api:1"
    } "An unreviewed API task family must fail closed."

    $emptyTagsFingerprint = Get-TaskTagsFingerprint -Tags @()
    Assert-Condition ($emptyTagsFingerprint -ceq "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945") `
        "Empty task tags must use the deterministic canonical JSON array fingerprint."
    Assert-Condition ((Get-TaskTagsFingerprint -Tags @()) -ceq $emptyTagsFingerprint) `
        "Repeated empty task tags must retain the same fingerprint."
    $singleTaskTag = @([pscustomobject]@{ key = "Environment"; value = "production" })
    Assert-Condition ((Get-TaskTagsFingerprint -Tags $singleTaskTag) -ceq "16b7339bdbf6c8993a51dec9c7fc339af1a99cc9a4a82e1c50f3522c06b36b26") `
        "The existing single-tag fingerprint must remain unchanged."
    $multipleTaskTags = @(
        [pscustomobject]@{ key = "Project"; value = "SchoolPilot" },
        [pscustomobject]@{ key = "Environment"; value = "production" }
    )
    Assert-Condition ((Get-TaskTagsFingerprint -Tags $multipleTaskTags) -ceq "340b29a98c1a335bc93e4a8c839a9969187d5ce5085211dd01f1ee7446c7ffd5") `
        "The existing sorted multi-tag fingerprint must remain unchanged."

    function Set-MockSourceRuntimeConfiguration {
        param([Parameter(Mandatory = $true)]$RuntimeConfiguration)
        foreach ($contract in @(
            [pscustomobject]@{ Arn = $global:RuntimeConfigTestState.ApiSourceArn; Container = "api" },
            [pscustomobject]@{ Arn = $global:RuntimeConfigTestState.WorkerSourceArn; Container = "scheduler-worker" }
        )) {
            $response = $global:RuntimeConfigTestState.TaskResponses[[string]$contract.Arn]
            $container = @($response.taskDefinition.containerDefinitions | Where-Object name -CEQ $contract.Container)[0]
            $container.environment = @($container.environment | Where-Object { [string]$_.name -cnotin $script:AllowedEnvironmentNames })
            foreach ($entry in $RuntimeConfiguration.Environment.GetEnumerator()) {
                $container.environment += [pscustomobject]@{ name = [string]$entry.Key; value = [string]$entry.Value }
            }
            $container.secrets = @($container.secrets | Where-Object { [string]$_.name -cnotin $script:AllowedSecretNames })
            if ($null -ne $RuntimeConfiguration.Turn) {
                $container.secrets += [pscustomobject]@{
                    name = "CLASSPILOT_TURN_REST_SECRET"
                    valueFrom = [string]$RuntimeConfiguration.Turn.SecretArn
                }
            }
        }
    }

    $sharedInputPath = Join-Path $testRoot "shared-input.json"
    [IO.File]::WriteAllText($sharedInputPath, '{"schemaVersion":1,"mode":"off"}', [Text.UTF8Encoding]::new($false))
    if ($IsWindows) {
        $sharedAcl = Get-Acl -LiteralPath $sharedInputPath
        $sharedAcl.SetAccessRuleProtection($true, $false)
        [void]$sharedAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::WorldSid, $null),
            [Security.AccessControl.FileSystemRights]::Read,
            [Security.AccessControl.AccessControlType]::Allow
        ))
        [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($sharedInputPath), [Security.AccessControl.FileSecurity]$sharedAcl)
    }
    else {
        [IO.File]::SetUnixFileMode($sharedInputPath, [IO.UnixFileMode]::UserRead -bor [IO.UnixFileMode]::UserWrite -bor [IO.UnixFileMode]::GroupRead)
    }
    Assert-Throws {
        Assert-PrivateInputPath -Path $sharedInputPath -RepositoryRoot $repositoryRoot
    } "A group- or world-readable runtime input must fail closed."
    Set-PrivatePathPermissions -Path $sharedInputPath
    Assert-Condition ((Assert-PrivateInputPath -Path $sharedInputPath -RepositoryRoot $repositoryRoot) -ceq [IO.Path]::GetFullPath($sharedInputPath)) "An owner-only external runtime input must be accepted."

    Assert-Throws {
        Assert-PrivateExternalRoot -Root ([IO.Path]::GetPathRoot($testRoot)) -RepositoryRoot $repositoryRoot
    } "A filesystem root must never be accepted as an evidence root."
    Assert-Throws {
        Assert-PrivateExternalRoot -Root (Split-Path -Parent $repositoryRoot) -RepositoryRoot $repositoryRoot
    } "A repository ancestor must never be accepted as an evidence root."
    $unmarkedRoot = Join-Path $testRoot "populated-unmarked-root"
    [void][IO.Directory]::CreateDirectory($unmarkedRoot)
    Set-PrivatePathPermissions -Path $unmarkedRoot -Directory
    $unmarkedFile = Join-Path $unmarkedRoot "unrelated.txt"
    [IO.File]::WriteAllText($unmarkedFile, "unrelated", [Text.UTF8Encoding]::new($false))
    Set-PrivatePathPermissions -Path $unmarkedFile
    Assert-Throws {
        Assert-PrivateExternalRoot -Root $unmarkedRoot -RepositoryRoot $repositoryRoot
    } "A populated unmarked directory must not be claimed as an evidence root."

    $oversizedJsonPath = Join-Path $testRoot "oversized.json"
    [IO.File]::WriteAllText($oversizedJsonPath, '{"value":"' + ("x" * 65536) + '"}', [Text.UTF8Encoding]::new($false))
    Assert-Throws { Read-StrictJson -Path $oversizedJsonPath } "Private JSON inputs above 64 KiB must fail closed."
    $duplicateJsonPath = Join-Path $testRoot "duplicate.json"
    [IO.File]::WriteAllText($duplicateJsonPath, '{"schemaVersion":1,"schemaVersion":1}', [Text.UTF8Encoding]::new($false))
    Assert-Throws { Read-StrictJson -Path $duplicateJsonPath } "Duplicate JSON properties must fail closed."

    $testSchoolId = "123e4567-e89b-42d3-a456-426614174000"
    $turnSecretArn = "arn:aws:secretsmanager:us-east-1:135775632425:secret:/schoolpilot/production/CLASSPILOT_TURN_REST_SECRET-AbCd12"
    $turn = [pscustomobject]@{ hosts = @("turn-b.school-pilot.net", "turn-a.school-pilot.net"); secretArn = $turnSecretArn }
    $testProfile = [pscustomobject]@{
        schemaVersion = 1
        mode = "test-school"
        testSchoolId = $testSchoolId
        enabledCapabilities = @("exactBindingAckV2", "exactTabCloseV2", "authBoundTelemetryV1")
    }
    $testRuntime = ConvertTo-RuntimeConfiguration -Profile $testProfile
    Assert-Condition ($testRuntime.Mode -ceq "test-school") "Test-school mode must be retained."
    Assert-Condition ($testRuntime.SchoolScopeCount -eq 1 -and @($testRuntime.EnabledCapabilities).Count -eq 4) "Test profile must expose only marker plus the ordered prefix."
    Assert-Condition ($testRuntime.Environment.CLASSPILOT_CAP_KIOSK_LAUNCH_TICKET_V1 -ceq "false") "Ticket V1 must remain disabled."
    $testRollouts = $testRuntime.Environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON | ConvertFrom-Json -Depth 10
    Assert-Condition ($testRollouts.scopedAuthorityChecksV1.mode -ceq "on" -and @($testRollouts.scopedAuthorityChecksV1.schoolIds).Count -eq 1) "Marker must be scoped to exactly one test school."
    Assert-Condition ($testRollouts.authBoundTelemetryV1.mode -ceq "on" -and $testRollouts.studentChatIdempotencyV1.mode -ceq "off") "Test capabilities must form the exact cumulative prefix."
    Assert-Condition ($testRollouts.kioskLaunchTicketV1.mode -ceq "off") "Test registry must explicitly keep V1 off."

    $fullTestProfile = [pscustomobject]@{
        schemaVersion = 1; mode = "test-school"; testSchoolId = $testSchoolId
        enabledCapabilities = @($script:ActivationOrder); turn = $turn
    }
    $fullTestRuntime = ConvertTo-RuntimeConfiguration -Profile $fullTestProfile
    $fullTestRollouts = $fullTestRuntime.Environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON | ConvertFrom-Json -Depth 10
    foreach ($capability in $script:RepairedCapabilities) {
        Assert-Condition ($fullTestRollouts.$capability.mode -ceq "on" -and @($fullTestRollouts.$capability.schoolIds).Count -eq 1) "Full test-school profile must keep $capability scoped to one school."
    }

    $globalProfile = [pscustomobject]@{ schemaVersion = 1; mode = "global-on"; turn = $turn }
    $globalRuntime = ConvertTo-RuntimeConfiguration -Profile $globalProfile
    $globalRollouts = $globalRuntime.Environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON | ConvertFrom-Json -Depth 10
    Assert-Condition (@($globalRuntime.EnabledCapabilities).Count -eq 9) "Global profile must enable all nine repaired capabilities."
    foreach ($capability in $script:RepairedCapabilities) {
        Assert-Condition ($globalRollouts.$capability.mode -ceq "on") "Global profile must enable $capability."
        Assert-Condition (-not ($globalRollouts.$capability.PSObject.Properties.Name -contains "schoolIds")) "Global profile must not retain school identifiers."
    }
    Assert-Condition ($globalRuntime.Environment.CLASSPILOT_CAP_SCREENSHOT_TRACKING_WINDOW_LEASE_V1 -ceq "false" -and
        $globalRollouts.screenshotTrackingWindowLeaseV1.mode -ceq "off") `
        "Existing global-on must remain the explicit tracking-window rollback profile."
    Assert-Condition ($globalRuntime.Environment.CLASSPILOT_CAP_STUDENT_AUTH_GATE_PRESENCE_V1 -ceq "false" -and
        $globalRollouts.studentAuthGatePresenceV1.mode -ceq "off") `
        "Existing global-on must explicitly keep student auth-gate presence disabled."
    Assert-Condition ($globalRollouts.kioskLaunchTicketV1.mode -ceq "off") "Global profile must leave superseded V1 off."
    Assert-Condition ($globalRuntime.Turn.Hosts.Count -eq 2 -and $globalRuntime.Turn.Hosts[0] -ceq "turn-a.school-pilot.net") "TURN hosts must normalize to the reviewed pair."

    $trackingPilotProfile = [pscustomobject]@{
        schemaVersion = 2
        mode = "tracking-window-pilot"
        pilotSchoolId = $testSchoolId
    }
    $trackingPilotRuntime = ConvertTo-RuntimeConfiguration -Profile $trackingPilotProfile
    $trackingPilotRollouts = $trackingPilotRuntime.Environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON | ConvertFrom-Json -Depth 10
    Assert-Condition ($trackingPilotRuntime.Mode -ceq "tracking-window-pilot" -and
        $trackingPilotRuntime.SchoolScopeCount -eq 1 -and
        @($trackingPilotRuntime.EnabledCapabilities).Count -eq 10) `
        "Tracking-window pilot must preserve all repaired capabilities and add one scoped capability."
    foreach ($capability in $script:RepairedCapabilities) {
        Assert-Condition ($trackingPilotRollouts.$capability.mode -ceq "on" -and
            -not ($trackingPilotRollouts.$capability.PSObject.Properties.Name -contains "schoolIds")) `
            "Tracking-window pilot must preserve the existing global $capability rollout."
    }
    Assert-Condition ($trackingPilotRuntime.Environment.CLASSPILOT_CAP_SCREENSHOT_TRACKING_WINDOW_LEASE_V1 -ceq "true" -and
        $trackingPilotRollouts.screenshotTrackingWindowLeaseV1.mode -ceq "on" -and
        @($trackingPilotRollouts.screenshotTrackingWindowLeaseV1.schoolIds).Count -eq 1 -and
        [string]$trackingPilotRollouts.screenshotTrackingWindowLeaseV1.schoolIds[0] -ceq $testSchoolId) `
        "Tracking-window pilot must require the kill switch and exactly one rollout school."
    Assert-Condition ($trackingPilotRollouts.screenshotObservationLeaseV1.mode -ceq "on") `
        "Tracking-window pilot must keep the legacy observation lease available."
    Assert-Condition ($null -eq $trackingPilotRuntime.Turn -and
        -not $trackingPilotRuntime.Environment.Contains("CLASSPILOT_TURN_HOSTS") -and
        -not $trackingPilotRuntime.Environment.Contains("CLASSPILOT_STUN_URLS")) `
        "Tracking-window pilot must preserve rather than rewrite the active TURN wiring."

    $trackingGlobalProfile = [pscustomobject]@{
        schemaVersion = 2
        mode = "tracking-window-global-on"
        turn = $turn
    }
    $trackingGlobalRuntime = ConvertTo-RuntimeConfiguration -Profile $trackingGlobalProfile
    $trackingGlobalRollouts = $trackingGlobalRuntime.Environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON | ConvertFrom-Json -Depth 10
    Assert-Condition ($trackingGlobalRuntime.Mode -ceq "tracking-window-global-on" -and
        $trackingGlobalRuntime.SchoolScopeCount -eq 0 -and
        @($trackingGlobalRuntime.EnabledCapabilities).Count -eq 10) `
        "Tracking-window global mode must expose all ten accepted repaired capabilities."
    Assert-Condition ($trackingGlobalRollouts.screenshotTrackingWindowLeaseV1.mode -ceq "on" -and
        -not ($trackingGlobalRollouts.screenshotTrackingWindowLeaseV1.PSObject.Properties.Name -contains "schoolIds")) `
        "Tracking-window global mode must remove the pilot school scope."
    Assert-Condition ($trackingGlobalRollouts.kioskLaunchTicketV1.mode -ceq "off") `
        "Tracking-window global mode must keep superseded kiosk ticket V1 off."

    function New-TransitionSourceTask {
        param($RuntimeConfiguration)
        $environment = @([pscustomobject]@{ name = "NODE_ENV"; value = "production" })
        if ($null -ne $RuntimeConfiguration) {
            $environment += @($RuntimeConfiguration.Environment.GetEnumerator() | ForEach-Object {
                [pscustomobject]@{ name = [string]$_.Key; value = [string]$_.Value }
            })
        }
        return [pscustomobject]@{
            containerDefinitions = @([pscustomobject]@{ name = "api"; environment = $environment })
        }
    }
    $markerRuntime = ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
        schemaVersion = 1; mode = "test-school"; testSchoolId = $testSchoolId; enabledCapabilities = @()
    })
    $firstCapabilityRuntime = ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
        schemaVersion = 1; mode = "test-school"; testSchoolId = $testSchoolId
        enabledCapabilities = @($script:ActivationOrder[0])
    })
    $skippedCapabilityRuntime = ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
        schemaVersion = 1; mode = "test-school"; testSchoolId = $testSchoolId
        enabledCapabilities = @($script:ActivationOrder[0..1])
    })
    $otherSchoolMarkerRuntime = ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
        schemaVersion = 1; mode = "test-school"; testSchoolId = "123e4567-e89b-42d3-a456-426614174111"; enabledCapabilities = @()
    })
    $offTransitionRuntime = ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{ schemaVersion = 1; mode = "off" })
    Assert-AllowedRuntimeTransition -SourceTaskDefinition (New-TransitionSourceTask) -ContainerName "api" -TargetRuntimeConfiguration $markerRuntime
    Assert-AllowedRuntimeTransition -SourceTaskDefinition (New-TransitionSourceTask -RuntimeConfiguration $offTransitionRuntime) -ContainerName "api" -TargetRuntimeConfiguration $markerRuntime
    Assert-AllowedRuntimeTransition -SourceTaskDefinition (New-TransitionSourceTask -RuntimeConfiguration $markerRuntime) -ContainerName "api" -TargetRuntimeConfiguration $firstCapabilityRuntime
    Assert-AllowedRuntimeTransition -SourceTaskDefinition (New-TransitionSourceTask -RuntimeConfiguration $fullTestRuntime) -ContainerName "api" -TargetRuntimeConfiguration $globalRuntime
    Assert-Throws {
        Assert-AllowedRuntimeTransition -SourceTaskDefinition (New-TransitionSourceTask) -ContainerName "api" -TargetRuntimeConfiguration $fullTestRuntime
    } "Baseline runtime must not skip directly to a completed test-school prefix."
    Assert-Throws {
        Assert-AllowedRuntimeTransition -SourceTaskDefinition (New-TransitionSourceTask -RuntimeConfiguration $markerRuntime) -ContainerName "api" -TargetRuntimeConfiguration $skippedCapabilityRuntime
    } "Test-school activation must not skip an ordered capability step."
    Assert-Throws {
        Assert-AllowedRuntimeTransition -SourceTaskDefinition (New-TransitionSourceTask -RuntimeConfiguration $markerRuntime) -ContainerName "api" -TargetRuntimeConfiguration $otherSchoolMarkerRuntime
    } "Staged activation must not change schools."
    Assert-Throws {
        Assert-AllowedRuntimeTransition -SourceTaskDefinition (New-TransitionSourceTask) -ContainerName "api" -TargetRuntimeConfiguration $globalRuntime
    } "Global activation must not start from an empty baseline."
    foreach ($waivedSource in @(
        (New-TransitionSourceTask),
        (New-TransitionSourceTask -RuntimeConfiguration $offTransitionRuntime),
        (New-TransitionSourceTask -RuntimeConfiguration $firstCapabilityRuntime)
    )) {
        Assert-AllowedRuntimeTransition -SourceTaskDefinition $waivedSource -ContainerName "api" `
            -TargetRuntimeConfiguration $globalRuntime -AllowSyntheticOnlyGlobalActivation
    }
    Assert-AllowedRuntimeTransition -SourceTaskDefinition (New-TransitionSourceTask -RuntimeConfiguration $globalRuntime) `
        -ContainerName "api" -TargetRuntimeConfiguration $trackingPilotRuntime
    Assert-AllowedRuntimeTransition -SourceTaskDefinition (New-TransitionSourceTask -RuntimeConfiguration $trackingPilotRuntime) `
        -ContainerName "api" -TargetRuntimeConfiguration $trackingGlobalRuntime
    Assert-AllowedRuntimeTransition -SourceTaskDefinition (New-TransitionSourceTask -RuntimeConfiguration $trackingPilotRuntime) `
        -ContainerName "api" -TargetRuntimeConfiguration $globalRuntime
    Assert-AllowedRuntimeTransition -SourceTaskDefinition (New-TransitionSourceTask -RuntimeConfiguration $trackingGlobalRuntime) `
        -ContainerName "api" -TargetRuntimeConfiguration $globalRuntime
    Assert-Throws {
        Assert-AllowedRuntimeTransition -SourceTaskDefinition (New-TransitionSourceTask -RuntimeConfiguration $globalRuntime) `
            -ContainerName "api" -TargetRuntimeConfiguration $trackingGlobalRuntime
    } "Tracking-window global activation must not skip the school-scoped pilot."
    Assert-Throws {
        Assert-AllowedRuntimeTransition -SourceTaskDefinition (New-TransitionSourceTask -RuntimeConfiguration $fullTestRuntime) `
            -ContainerName "api" -TargetRuntimeConfiguration $trackingPilotRuntime
    } "Tracking-window pilot must start from the completed global repaired-capability profile."

    $fastPreviewPilotIntent = ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
        schemaVersion = 5; mode = "fast-preview-pilot"; pilotSchoolId = $testSchoolId
    })
    Assert-Condition ($fastPreviewPilotIntent.RequiresSourceRuntime -and
        $fastPreviewPilotIntent.Environment.Count -eq 0 -and $null -eq $fastPreviewPilotIntent.Turn) `
        "Fast-preview pilot must be a source-preserving intent."
    $fastPreviewPilotSource = New-TransitionSourceTask -RuntimeConfiguration $trackingGlobalRuntime
    $fastPreviewPilotRuntime = Resolve-SourcePreservingRuntimeConfiguration `
        -RuntimeIntent $fastPreviewPilotIntent -SourceTaskDefinition $fastPreviewPilotSource -ContainerName "api"
    $fastPreviewPilotRollouts = [string]$fastPreviewPilotRuntime.Environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON |
        ConvertFrom-Json -Depth 10
    Assert-Condition ($fastPreviewPilotRuntime.Environment.CLASSPILOT_CAP_SCREENSHOT_ACTIVE_OBSERVATION_CADENCE_V1 -ceq "true" -and
        [string]$fastPreviewPilotRollouts.screenshotActiveObservationCadenceV1.mode -ceq "on" -and
        @($fastPreviewPilotRollouts.screenshotActiveObservationCadenceV1.schoolIds).Count -eq 1 -and
        [string]$fastPreviewPilotRollouts.screenshotActiveObservationCadenceV1.schoolIds[0] -ceq $testSchoolId -and
        [string]$fastPreviewPilotRollouts.screenshotTrackingWindowLeaseV1.mode -ceq "on") `
        "Fast-preview pilot must require both controls for one school while preserving tracking."
    Assert-AllowedRuntimeTransition -SourceTaskDefinition $fastPreviewPilotSource -ContainerName "api" `
        -TargetRuntimeConfiguration $fastPreviewPilotRuntime

    $fastPreviewGlobalIntent = ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
        schemaVersion = 5; mode = "fast-preview-global-on"
    })
    $fastPreviewGlobalSource = New-TransitionSourceTask -RuntimeConfiguration $fastPreviewPilotRuntime
    $fastPreviewGlobalRuntime = Resolve-SourcePreservingRuntimeConfiguration `
        -RuntimeIntent $fastPreviewGlobalIntent -SourceTaskDefinition $fastPreviewGlobalSource -ContainerName "api"
    $fastPreviewGlobalRollouts = [string]$fastPreviewGlobalRuntime.Environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON |
        ConvertFrom-Json -Depth 10
    Assert-Condition ([string]$fastPreviewGlobalRollouts.screenshotActiveObservationCadenceV1.mode -ceq "on" -and
        -not ($fastPreviewGlobalRollouts.screenshotActiveObservationCadenceV1.PSObject.Properties.Name -contains "schoolIds")) `
        "Fast-preview global activation must remove only its pilot school scope."
    Assert-AllowedRuntimeTransition -SourceTaskDefinition $fastPreviewGlobalSource -ContainerName "api" `
        -TargetRuntimeConfiguration $fastPreviewGlobalRuntime

    $fastPreviewOffIntent = ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
        schemaVersion = 5; mode = "fast-preview-off"
    })
    $fastPreviewOffSource = New-TransitionSourceTask -RuntimeConfiguration $fastPreviewGlobalRuntime
    $fastPreviewOffRuntime = Resolve-SourcePreservingRuntimeConfiguration `
        -RuntimeIntent $fastPreviewOffIntent -SourceTaskDefinition $fastPreviewOffSource -ContainerName "api"
    $fastPreviewOffRollouts = [string]$fastPreviewOffRuntime.Environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON |
        ConvertFrom-Json -Depth 10
    Assert-Condition ($fastPreviewOffRuntime.Environment.CLASSPILOT_CAP_SCREENSHOT_ACTIVE_OBSERVATION_CADENCE_V1 -ceq "false" -and
        [string]$fastPreviewOffRollouts.screenshotActiveObservationCadenceV1.mode -ceq "off" -and
        $fastPreviewOffRuntime.Environment.CLASSPILOT_CAP_SCREENSHOT_TRACKING_WINDOW_LEASE_V1 -ceq "true") `
        "Fast-preview rollback must disable only the cadence capability."
    Assert-AllowedRuntimeTransition -SourceTaskDefinition $fastPreviewOffSource -ContainerName "api" `
        -TargetRuntimeConfiguration $fastPreviewOffRuntime
    Assert-Throws {
        $skippedFastPreviewGlobal = Resolve-SourcePreservingRuntimeConfiguration `
            -RuntimeIntent $fastPreviewGlobalIntent -SourceTaskDefinition $fastPreviewPilotSource -ContainerName "api"
        Assert-AllowedRuntimeTransition -SourceTaskDefinition $fastPreviewPilotSource -ContainerName "api" `
            -TargetRuntimeConfiguration $skippedFastPreviewGlobal
    } "Fast-preview global activation must not skip its school-scoped pilot."

    $studentGatePilotIntent = ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
        schemaVersion = 3; mode = "student-gate-pilot"; pilotSchoolId = $testSchoolId
    })
    Assert-Condition ($studentGatePilotIntent.RequiresSourceRuntime -and
        $studentGatePilotIntent.Environment.Count -eq 0 -and
        $null -eq $studentGatePilotIntent.Turn) `
        "Student-gate profiles must be source-preserving intents rather than reconstructed full profiles."
    $studentGatePilotSource = New-TransitionSourceTask -RuntimeConfiguration $trackingPilotRuntime
    $studentGatePilotRuntime = Resolve-SourcePreservingRuntimeConfiguration `
        -RuntimeIntent $studentGatePilotIntent -SourceTaskDefinition $studentGatePilotSource -ContainerName "api"
    $studentGatePilotRollouts = [string]$studentGatePilotRuntime.Environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON |
        ConvertFrom-Json -Depth 10
    Assert-Condition ($studentGatePilotRuntime.Environment.CLASSPILOT_CAP_STUDENT_AUTH_GATE_PRESENCE_V1 -ceq "true" -and
        [string]$studentGatePilotRollouts.studentAuthGatePresenceV1.mode -ceq "on" -and
        @($studentGatePilotRollouts.studentAuthGatePresenceV1.schoolIds).Count -eq 1 -and
        [string]$studentGatePilotRollouts.studentAuthGatePresenceV1.schoolIds[0] -ceq $testSchoolId) `
        "Student-gate pilot must require both controls and exactly one canonical school."
    Assert-Condition ($studentGatePilotRuntime.Environment.CLASSPILOT_CAP_SCREENSHOT_TRACKING_WINDOW_LEASE_V1 -ceq "true" -and
        [string]$studentGatePilotRollouts.screenshotTrackingWindowLeaseV1.mode -ceq "on" -and
        [string]$studentGatePilotRollouts.screenshotTrackingWindowLeaseV1.schoolIds[0] -ceq $testSchoolId) `
        "Student-gate pilot must preserve the current tracking-window screenshot pilot exactly."
    foreach ($capability in @($script:AllCapabilities | Where-Object {
        $_ -cne $script:StudentGatePresenceCapability
    })) {
        $sourceEntry = $trackingPilotRollouts.$capability | ConvertTo-Json -Depth 10 -Compress
        $targetEntry = $studentGatePilotRollouts.$capability | ConvertTo-Json -Depth 10 -Compress
        Assert-Condition ($sourceEntry -ceq $targetEntry) `
            "Student-gate pilot must preserve the existing $capability rollout entry."
        Assert-Condition ([string]$studentGatePilotRuntime.Environment[[string]$script:CapabilityFlags[$capability]] -ceq
            [string]$trackingPilotRuntime.Environment[[string]$script:CapabilityFlags[$capability]]) `
            "Student-gate pilot must preserve the existing $capability kill switch."
    }
    Assert-AllowedRuntimeTransition -SourceTaskDefinition $studentGatePilotSource -ContainerName "api" `
        -TargetRuntimeConfiguration $studentGatePilotRuntime

    $globalStudentGatePilotSource = New-TransitionSourceTask -RuntimeConfiguration $globalRuntime
    $globalStudentGatePilotRuntime = Resolve-SourcePreservingRuntimeConfiguration `
        -RuntimeIntent $studentGatePilotIntent -SourceTaskDefinition $globalStudentGatePilotSource -ContainerName "api"
    Assert-AllowedRuntimeTransition -SourceTaskDefinition $globalStudentGatePilotSource -ContainerName "api" `
        -TargetRuntimeConfiguration $globalStudentGatePilotRuntime
    Assert-AllowedRuntimeTransition `
        -SourceTaskDefinition (New-TransitionSourceTask -RuntimeConfiguration $globalStudentGatePilotRuntime) `
        -ContainerName "api" -TargetRuntimeConfiguration $globalRuntime
    Assert-Throws {
        Assert-AllowedRuntimeTransition -SourceTaskDefinition $globalStudentGatePilotSource -ContainerName "api" `
            -TargetRuntimeConfiguration $globalRuntime
    } "Schema-v1 global-on must not become a general no-op transition."

    $studentGateGlobalIntent = ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
        schemaVersion = 3; mode = "student-gate-global-on"
    })
    $studentGateGlobalSource = New-TransitionSourceTask -RuntimeConfiguration $studentGatePilotRuntime
    $studentGateGlobalRuntime = Resolve-SourcePreservingRuntimeConfiguration `
        -RuntimeIntent $studentGateGlobalIntent -SourceTaskDefinition $studentGateGlobalSource -ContainerName "api"
    $studentGateGlobalRollouts = [string]$studentGateGlobalRuntime.Environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON |
        ConvertFrom-Json -Depth 10
    Assert-Condition ([string]$studentGateGlobalRollouts.studentAuthGatePresenceV1.mode -ceq "on" -and
        -not ($studentGateGlobalRollouts.studentAuthGatePresenceV1.PSObject.Properties.Name -contains "schoolIds")) `
        "Student-gate global activation must remove only its pilot school scope."
    Assert-AllowedRuntimeTransition -SourceTaskDefinition $studentGateGlobalSource -ContainerName "api" `
        -TargetRuntimeConfiguration $studentGateGlobalRuntime

    $globalStudentGateGlobalSource = New-TransitionSourceTask -RuntimeConfiguration $globalStudentGatePilotRuntime
    $globalStudentGateGlobalRuntime = Resolve-SourcePreservingRuntimeConfiguration `
        -RuntimeIntent $studentGateGlobalIntent -SourceTaskDefinition $globalStudentGateGlobalSource -ContainerName "api"
    Assert-AllowedRuntimeTransition -SourceTaskDefinition $globalStudentGateGlobalSource -ContainerName "api" `
        -TargetRuntimeConfiguration $globalStudentGateGlobalRuntime
    Assert-AllowedRuntimeTransition `
        -SourceTaskDefinition (New-TransitionSourceTask -RuntimeConfiguration $globalStudentGateGlobalRuntime) `
        -ContainerName "api" -TargetRuntimeConfiguration $globalRuntime

    $studentGateOffIntent = ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
        schemaVersion = 3; mode = "student-gate-off"
    })
    $studentGateOffSource = New-TransitionSourceTask -RuntimeConfiguration $studentGateGlobalRuntime
    $studentGateOffRuntime = Resolve-SourcePreservingRuntimeConfiguration `
        -RuntimeIntent $studentGateOffIntent -SourceTaskDefinition $studentGateOffSource -ContainerName "api"
    $studentGateOffRollouts = [string]$studentGateOffRuntime.Environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON |
        ConvertFrom-Json -Depth 10
    Assert-Condition ($studentGateOffRuntime.Environment.CLASSPILOT_CAP_STUDENT_AUTH_GATE_PRESENCE_V1 -ceq "false" -and
        [string]$studentGateOffRollouts.studentAuthGatePresenceV1.mode -ceq "off" -and
        $studentGateOffRuntime.Environment.CLASSPILOT_CAP_SCREENSHOT_TRACKING_WINDOW_LEASE_V1 -ceq "true" -and
        [string]$studentGateOffRollouts.screenshotTrackingWindowLeaseV1.mode -ceq "on") `
        "Student-gate rollback must disable only student auth-gate presence and preserve screenshot tracking."
    Assert-AllowedRuntimeTransition -SourceTaskDefinition $studentGateOffSource -ContainerName "api" `
        -TargetRuntimeConfiguration $studentGateOffRuntime
    Assert-Throws {
        Assert-AllowedRuntimeTransition -SourceTaskDefinition $studentGateGlobalSource -ContainerName "api" `
            -TargetRuntimeConfiguration $trackingGlobalRuntime
    } "Tracking-window activation must not silently disable an active student-gate rollout."
    Assert-Throws {
        $skippedStudentGateGlobal = Resolve-SourcePreservingRuntimeConfiguration `
            -RuntimeIntent $studentGateGlobalIntent -SourceTaskDefinition $studentGatePilotSource -ContainerName "api"
        Assert-AllowedRuntimeTransition -SourceTaskDefinition $studentGatePilotSource -ContainerName "api" `
            -TargetRuntimeConfiguration $skippedStudentGateGlobal
    } "Student-gate global activation must not skip its school-scoped pilot."

    $finalLateSignInReleaseTag = [string]$script:ClassPilotReleaseTag
    $finalLateSignInMergeSha = [string]$script:ClassPilotMergeSha
    $finalLateSignInZipSha256 = [string]$script:ClassPilotZipSha256
    $productionClassPilotExtensionId = [string]$script:ClassPilotExtensionId
    Assert-Condition ($finalLateSignInReleaseTag -ceq "v2.7.9") `
        "Late-sign-in release evidence must bind the exact final v2.7.9 tag."
    Assert-Condition ($finalLateSignInMergeSha -ceq "ce4b45d0da67dab8f28e71600528b50ab52bff01") `
        "Late-sign-in release evidence must bind the exact final v2.7.9 merge."
    Assert-Condition ($finalLateSignInZipSha256 -ceq "0a60e83b4e968e0fa5ae36c077ee7715ff19af3f2902c8ea39ce2e4d651b08ac") `
        "Late-sign-in release evidence must bind the exact final v2.7.9 clean-tag ZIP."
    Assert-Condition ($productionClassPilotExtensionId -ceq "iggbfegfcjkfieoemeolfmfnapepalca") `
        "Late-sign-in release evidence must bind the production ClassPilot extension ID."
    $script:ClassPilotReleaseTag = "v2.7.1"
    $script:ClassPilotMergeSha = "a3b096d6a74ab6979f4e4c656d75e2397eb8648f"
    $script:ClassPilotZipSha256 = "40fed2c455d5c50fe3a947d23e3798a0c81832a67e717a2767b62970c024307c"
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
            schemaVersion = 4; mode = "late-signin-pilot"; pilotSchoolId = $testSchoolId
        })
    } "Late-sign-in activation must fail closed while release evidence still identifies v2.7.1."
    $lateSignInOffWithStaleEvidence = ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
        schemaVersion = 4; mode = "late-signin-off"
    })
    Assert-Condition ($lateSignInOffWithStaleEvidence.Mode -ceq "late-signin-off") `
        "Late-sign-in rollback must remain available while release evidence is stale."
    $script:ClassPilotReleaseTag = "v2.7.9-rc.1"
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
            schemaVersion = 4; mode = "late-signin-pilot"; pilotSchoolId = $testSchoolId
        })
    } "Late-sign-in activation must require the exact v2.7.9 release tag."
    $script:ClassPilotReleaseTag = "v2.7.9"
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
            schemaVersion = 4; mode = "late-signin-pilot"; pilotSchoolId = $testSchoolId
        })
    } "Changing only the release tag must not unlock late-sign-in with stale merge and ZIP evidence."
    $script:ClassPilotMergeSha = "7e3c129315d9e7c94ee4f6084e769e759a7e2b6a"
    $script:ClassPilotZipSha256 = $finalLateSignInZipSha256
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
            schemaVersion = 4; mode = "late-signin-pilot"; pilotSchoolId = $testSchoolId
        })
    } "The incomplete auth-only v2.7.9 merge must never unlock late-sign-in."
    $script:ClassPilotMergeSha = $finalLateSignInMergeSha
    $script:ClassPilotZipSha256 = "cd2d9c26f989a64203c52f460a1366d642ea371d7cadbb68aec9ef9a16c1884e"
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
            schemaVersion = 4; mode = "late-signin-pilot"; pilotSchoolId = $testSchoolId
        })
    } "The obsolete auth-only v2.7.9 ZIP must never unlock late-sign-in."
    $script:ClassPilotZipSha256 = $finalLateSignInZipSha256
    $script:ClassPilotExtensionId = "iggbfegfcjkfieoemeolfmfnapepalcb"
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
            schemaVersion = 4; mode = "late-signin-pilot"; pilotSchoolId = $testSchoolId
        })
    } "Late-sign-in release evidence must bind the exact production extension ID."
    $script:ClassPilotReleaseTag = $finalLateSignInReleaseTag
    $script:ClassPilotMergeSha = $finalLateSignInMergeSha
    $script:ClassPilotZipSha256 = $finalLateSignInZipSha256
    $script:ClassPilotExtensionId = $productionClassPilotExtensionId
    $lateSignInPilotIntent = ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
        schemaVersion = 4; mode = "late-signin-pilot"; pilotSchoolId = $testSchoolId
    })
    Assert-Condition ($lateSignInPilotIntent.RequiresSourceRuntime -and
        $lateSignInPilotIntent.Environment.Count -eq 0 -and
        $null -eq $lateSignInPilotIntent.Turn) `
        "Late-sign-in profiles must be source-preserving intents."
    $lateSignInPilotSource = New-TransitionSourceTask -RuntimeConfiguration $studentGatePilotRuntime
    $lateSignInPilotRuntime = Resolve-SourcePreservingRuntimeConfiguration `
        -RuntimeIntent $lateSignInPilotIntent -SourceTaskDefinition $lateSignInPilotSource -ContainerName "api"
    $lateSignInPilotRollouts = [string]$lateSignInPilotRuntime.Environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON |
        ConvertFrom-Json -Depth 10
    Assert-Condition ($lateSignInPilotRuntime.Environment.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1 -ceq "true" -and
        [string]$lateSignInPilotRollouts.lateSignInRestrictionSsoV1.mode -ceq "on" -and
        @($lateSignInPilotRollouts.lateSignInRestrictionSsoV1.schoolIds).Count -eq 1 -and
        [string]$lateSignInPilotRollouts.lateSignInRestrictionSsoV1.schoolIds[0] -ceq $testSchoolId) `
        "Late-sign-in pilot must require both controls and exactly one canonical school."
    Assert-Condition ([string]$lateSignInPilotRuntime.Environment.CLASSPILOT_CAP_STUDENT_AUTH_GATE_PRESENCE_V1 -ceq "true" -and
        [string]$lateSignInPilotRollouts.studentAuthGatePresenceV1.mode -ceq "on" -and
        [string]$lateSignInPilotRollouts.studentAuthGatePresenceV1.schoolIds[0] -ceq $testSchoolId) `
        "Late-sign-in pilot must preserve the exact existing student-gate pilot."
    foreach ($capability in @($script:AllCapabilities | Where-Object {
        $_ -cne $script:LateSignInRestrictionSsoCapability
    })) {
        $sourceEntry = $studentGatePilotRollouts.$capability | ConvertTo-Json -Depth 10 -Compress
        $targetEntry = $lateSignInPilotRollouts.$capability | ConvertTo-Json -Depth 10 -Compress
        Assert-Condition ($sourceEntry -ceq $targetEntry) `
            "Late-sign-in pilot must preserve the existing $capability rollout entry."
        Assert-Condition ([string]$lateSignInPilotRuntime.Environment[[string]$script:CapabilityFlags[$capability]] -ceq
            [string]$studentGatePilotRuntime.Environment[[string]$script:CapabilityFlags[$capability]]) `
            "Late-sign-in pilot must preserve the existing $capability kill switch."
    }
    Assert-AllowedRuntimeTransition -SourceTaskDefinition $lateSignInPilotSource -ContainerName "api" `
        -TargetRuntimeConfiguration $lateSignInPilotRuntime

    $lateSignInOffIntent = ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
        schemaVersion = 4; mode = "late-signin-off"
    })
    $lateSignInOffSource = New-TransitionSourceTask -RuntimeConfiguration $lateSignInPilotRuntime
    $lateSignInOffRuntime = Resolve-SourcePreservingRuntimeConfiguration `
        -RuntimeIntent $lateSignInOffIntent -SourceTaskDefinition $lateSignInOffSource -ContainerName "api"
    $lateSignInOffRollouts = [string]$lateSignInOffRuntime.Environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON |
        ConvertFrom-Json -Depth 10
    Assert-Condition ($lateSignInOffRuntime.Environment.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1 -ceq "false" -and
        [string]$lateSignInOffRollouts.lateSignInRestrictionSsoV1.mode -ceq "off" -and
        $lateSignInOffRuntime.Environment.CLASSPILOT_CAP_STUDENT_AUTH_GATE_PRESENCE_V1 -ceq "true" -and
        [string]$lateSignInOffRollouts.studentAuthGatePresenceV1.mode -ceq "on") `
        "Late-sign-in rollback must disable only late delivery and preserve student-gate state."
    Assert-AllowedRuntimeTransition -SourceTaskDefinition $lateSignInOffSource -ContainerName "api" `
        -TargetRuntimeConfiguration $lateSignInOffRuntime
    Assert-Throws {
        $unsafeGlobalLateSource = New-TransitionSourceTask -RuntimeConfiguration $lateSignInPilotRuntime
        $unsafeGlobalLateEnvironment = @($unsafeGlobalLateSource.containerDefinitions[0].environment)
        $unsafeGlobalLateRolloutEntry = @($unsafeGlobalLateEnvironment | Where-Object name -CEQ "CLASSPILOT_CAPABILITY_ROLLOUTS_JSON")[0]
        $unsafeGlobalLateRollouts = [string]$unsafeGlobalLateRolloutEntry.value | ConvertFrom-Json -Depth 10
        $unsafeGlobalLateRollouts.lateSignInRestrictionSsoV1.PSObject.Properties.Remove("schoolIds")
        $unsafeGlobalLateRolloutEntry.value = $unsafeGlobalLateRollouts | ConvertTo-Json -Depth 10 -Compress
        Get-RuntimeActivationState -Environment $unsafeGlobalLateEnvironment -AllowBaseline
    } "Late-sign-in activation must reject a global rollout."
    $script:ClassPilotReleaseTag = $finalLateSignInReleaseTag
    $script:ClassPilotMergeSha = $finalLateSignInMergeSha
    $script:ClassPilotZipSha256 = $finalLateSignInZipSha256
    $script:ClassPilotExtensionId = $productionClassPilotExtensionId

    $legacyGlobalSource = New-TransitionSourceTask -RuntimeConfiguration $globalRuntime
    $legacyGlobalEnvironment = @($legacyGlobalSource.containerDefinitions[0].environment)
    $legacyGlobalRolloutEntry = @($legacyGlobalEnvironment | Where-Object name -CEQ "CLASSPILOT_CAPABILITY_ROLLOUTS_JSON")[0]
    $legacyGlobalRollout = [string]$legacyGlobalRolloutEntry.value | ConvertFrom-Json -Depth 10
    $legacyGlobalRollout.PSObject.Properties.Remove("screenshotTrackingWindowLeaseV1")
    $legacyGlobalRolloutEntry.value = $legacyGlobalRollout | ConvertTo-Json -Depth 10 -Compress
    $legacyGlobalSource.containerDefinitions[0].environment = @($legacyGlobalEnvironment | Where-Object {
        [string]$_.name -cne "CLASSPILOT_CAP_SCREENSHOT_TRACKING_WINDOW_LEASE_V1"
    })
    $legacyGlobalState = Get-RuntimeActivationState `
        -Environment @($legacyGlobalSource.containerDefinitions[0].environment) -AllowBaseline
    Assert-Condition ($legacyGlobalState.Mode -ceq "global-on") `
        "The exact pre-additive global task shape must be recognized as tracking-window off."
    Assert-AllowedRuntimeTransition -SourceTaskDefinition $legacyGlobalSource -ContainerName "api" `
        -TargetRuntimeConfiguration $trackingPilotRuntime

    $legacyFastPreviewSource = New-TransitionSourceTask -RuntimeConfiguration $trackingGlobalRuntime
    $legacyFastPreviewEnvironment = @($legacyFastPreviewSource.containerDefinitions[0].environment)
    $legacyFastPreviewRolloutEntry = @($legacyFastPreviewEnvironment | Where-Object name -CEQ "CLASSPILOT_CAPABILITY_ROLLOUTS_JSON")[0]
    $legacyFastPreviewRollout = [string]$legacyFastPreviewRolloutEntry.value | ConvertFrom-Json -Depth 10
    $legacyFastPreviewRollout.PSObject.Properties.Remove("screenshotActiveObservationCadenceV1")
    $legacyFastPreviewRolloutEntry.value = $legacyFastPreviewRollout | ConvertTo-Json -Depth 10 -Compress
    $legacyFastPreviewSource.containerDefinitions[0].environment = @($legacyFastPreviewEnvironment | Where-Object {
        [string]$_.name -cne "CLASSPILOT_CAP_SCREENSHOT_ACTIVE_OBSERVATION_CADENCE_V1"
    })
    $legacyFastPreviewState = Get-RuntimeActivationState `
        -Environment @($legacyFastPreviewSource.containerDefinitions[0].environment) -AllowBaseline
    Assert-Condition ($legacyFastPreviewState.Mode -ceq "tracking-window-global-on" -and
        $legacyFastPreviewState.FastPreviewMode -ceq "off") `
        "The exact pre-fast-preview task shape must be recognized as fast preview off."
    $legacyFastPreviewTarget = Resolve-SourcePreservingRuntimeConfiguration `
        -RuntimeIntent $fastPreviewPilotIntent -SourceTaskDefinition $legacyFastPreviewSource -ContainerName "api"
    Assert-AllowedRuntimeTransition -SourceTaskDefinition $legacyFastPreviewSource -ContainerName "api" `
        -TargetRuntimeConfiguration $legacyFastPreviewTarget

    $legacyStudentGateSource = New-TransitionSourceTask -RuntimeConfiguration $trackingPilotRuntime
    $legacyStudentGateEnvironment = @($legacyStudentGateSource.containerDefinitions[0].environment)
    $legacyStudentGateRolloutEntry = @($legacyStudentGateEnvironment | Where-Object name -CEQ "CLASSPILOT_CAPABILITY_ROLLOUTS_JSON")[0]
    $legacyStudentGateRollout = [string]$legacyStudentGateRolloutEntry.value | ConvertFrom-Json -Depth 10
    $legacyStudentGateRollout.PSObject.Properties.Remove("studentAuthGatePresenceV1")
    $legacyStudentGateRolloutEntry.value = $legacyStudentGateRollout | ConvertTo-Json -Depth 10 -Compress
    $legacyStudentGateSource.containerDefinitions[0].environment = @($legacyStudentGateEnvironment | Where-Object {
        [string]$_.name -cne "CLASSPILOT_CAP_STUDENT_AUTH_GATE_PRESENCE_V1"
    })
    $legacyStudentGateState = Get-RuntimeActivationState `
        -Environment @($legacyStudentGateSource.containerDefinitions[0].environment) -AllowBaseline
    Assert-Condition ($legacyStudentGateState.Mode -ceq "tracking-window-pilot" -and
        $legacyStudentGateState.StudentGateMode -ceq "off") `
        "The exact pre-student-gate task shape must be recognized as student-gate off."
    $legacyStudentGateTarget = Resolve-SourcePreservingRuntimeConfiguration `
        -RuntimeIntent $studentGatePilotIntent -SourceTaskDefinition $legacyStudentGateSource -ContainerName "api"
    Assert-AllowedRuntimeTransition -SourceTaskDefinition $legacyStudentGateSource -ContainerName "api" `
        -TargetRuntimeConfiguration $legacyStudentGateTarget

    $partialStudentGateSource = New-TransitionSourceTask -RuntimeConfiguration $trackingPilotRuntime
    $partialStudentGateSource.containerDefinitions[0].environment = @($partialStudentGateSource.containerDefinitions[0].environment | Where-Object {
        [string]$_.name -cne "CLASSPILOT_CAP_STUDENT_AUTH_GATE_PRESENCE_V1"
    })
    Assert-Throws {
        Get-RuntimeActivationState -Environment @($partialStudentGateSource.containerDefinitions[0].environment) -AllowBaseline
    } "An absent student-gate kill switch with a present rollout entry must fail closed."

    $mismatchedStudentGateSource = New-TransitionSourceTask -RuntimeConfiguration $studentGatePilotRuntime
    @($mismatchedStudentGateSource.containerDefinitions[0].environment | Where-Object {
        [string]$_.name -ceq "CLASSPILOT_CAP_STUDENT_AUTH_GATE_PRESENCE_V1"
    })[0].value = "false"
    Assert-Throws {
        Get-RuntimeActivationState -Environment @($mismatchedStudentGateSource.containerDefinitions[0].environment) -AllowBaseline
    } "Student-gate rollout and kill-switch disagreement must fail closed."

    $partialTrackingSource = New-TransitionSourceTask -RuntimeConfiguration $globalRuntime
    $partialTrackingSource.containerDefinitions[0].environment = @($partialTrackingSource.containerDefinitions[0].environment | Where-Object {
        [string]$_.name -cne "CLASSPILOT_CAP_SCREENSHOT_TRACKING_WINDOW_LEASE_V1"
    })
    Assert-Throws {
        Get-RuntimeActivationState -Environment @($partialTrackingSource.containerDefinitions[0].environment) -AllowBaseline
    } "An absent tracking kill switch with a present rollout entry must fail closed."

    $partialFastPreviewSource = New-TransitionSourceTask -RuntimeConfiguration $trackingGlobalRuntime
    $partialFastPreviewSource.containerDefinitions[0].environment = @($partialFastPreviewSource.containerDefinitions[0].environment | Where-Object {
        [string]$_.name -cne "CLASSPILOT_CAP_SCREENSHOT_ACTIVE_OBSERVATION_CADENCE_V1"
    })
    Assert-Throws {
        Get-RuntimeActivationState -Environment @($partialFastPreviewSource.containerDefinitions[0].environment) -AllowBaseline
    } "An absent fast-preview kill switch with a present rollout entry must fail closed."

    $mismatchedFastPreviewSource = New-TransitionSourceTask -RuntimeConfiguration $fastPreviewPilotRuntime
    @($mismatchedFastPreviewSource.containerDefinitions[0].environment | Where-Object {
        [string]$_.name -ceq "CLASSPILOT_CAP_SCREENSHOT_ACTIVE_OBSERVATION_CADENCE_V1"
    })[0].value = "false"
    Assert-Throws {
        Get-RuntimeActivationState -Environment @($mismatchedFastPreviewSource.containerDefinitions[0].environment) -AllowBaseline
    } "Fast-preview rollout and kill-switch disagreement must fail closed."

    $mismatchedTrackingSource = New-TransitionSourceTask -RuntimeConfiguration $trackingPilotRuntime
    @($mismatchedTrackingSource.containerDefinitions[0].environment | Where-Object {
        [string]$_.name -ceq "CLASSPILOT_CAP_SCREENSHOT_TRACKING_WINDOW_LEASE_V1"
    })[0].value = "false"
    Assert-Throws {
        Get-RuntimeActivationState -Environment @($mismatchedTrackingSource.containerDefinitions[0].environment) -AllowBaseline
    } "Tracking-window rollout and kill-switch disagreement must fail closed."

    $normalDeploymentService = New-TestService -Role api `
        -TaskDefinitionArn "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:1"
    Assert-NormalServiceDeploymentConfiguration -Service $normalDeploymentService
    $unsafeMinimumService = $normalDeploymentService | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
    $unsafeMinimumService.deploymentConfiguration.minimumHealthyPercent = 0
    Assert-Throws { Assert-NormalServiceDeploymentConfiguration -Service $unsafeMinimumService } "Normal activation must reject a 0/200 deployment posture."
    $stringCircuitService = $normalDeploymentService | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
    $stringCircuitService.deploymentConfiguration.deploymentCircuitBreaker.enable = "true"
    Assert-Throws { Assert-NormalServiceDeploymentConfiguration -Service $stringCircuitService } "Normal activation must reject string-valued circuit-breaker flags."
    $disabledCircuitService = $normalDeploymentService | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
    $disabledCircuitService.deploymentConfiguration.deploymentCircuitBreaker.rollback = $false
    Assert-Throws { Assert-NormalServiceDeploymentConfiguration -Service $disabledCircuitService } "Normal activation must require rollback-enabled circuit breaking."
    $alarmDeploymentService = $normalDeploymentService | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
    $alarmDeploymentService.deploymentConfiguration | Add-Member -NotePropertyName alarms -NotePropertyValue ([pscustomobject]@{
        alarmNames = @("unexpected"); enable = $true; rollback = $true
    })
    Assert-Throws { Assert-NormalServiceDeploymentConfiguration -Service $alarmDeploymentService } "Normal activation must reject unreviewed ECS alarm configuration."

    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
            schemaVersion = 1; mode = "test-school"; testSchoolId = $testSchoolId
            enabledCapabilities = @("exactTabCloseV2")
        })
    } "A skipped test-school activation step must fail closed."
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{ schemaVersion = 1; mode = "global-on" })
    } "Global activation without TURN inputs must fail closed."
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
            schemaVersion = 1; mode = "global-on"
            turn = [pscustomobject]@{ hosts = @("turn-a.school-pilot.net"); secretArn = $turnSecretArn }
        })
    } "Global activation without exactly two TURN hosts must fail closed."
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
            schemaVersion = 1; mode = "global-on"
            turn = [pscustomobject]@{ hosts = @("turn-a.school-pilot.net", "turn-b.school-pilot.net"); secretArn = "arn:aws:secretsmanager:us-east-1:135775632425:secret:wrong" }
        })
    } "Global activation with the wrong TURN secret shape must fail closed."
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
            schemaVersion = 1; mode = "tracking-window-pilot"; pilotSchoolId = $testSchoolId; turn = $turn
        })
    } "Tracking-window profiles must require the additive schema version."
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
            schemaVersion = 2; mode = "global-on"; turn = $turn
        })
    } "The existing global-on rollback profile must retain schema version 1."
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
            schemaVersion = 2; mode = "tracking-window-pilot"; turn = $turn
        })
    } "Tracking-window pilot must require one school."
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
            schemaVersion = 2; mode = "tracking-window-pilot"; pilotSchoolId = "NOT-A-UUID"; turn = $turn
        })
    } "Tracking-window pilot must reject a malformed school identifier."
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
            schemaVersion = 2; mode = "tracking-window-pilot"; pilotSchoolId = $testSchoolId; turn = $turn
        })
    } "Tracking-window pilot must not rewrite existing TURN wiring."
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
            schemaVersion = 2; mode = "tracking-window-global-on"; pilotSchoolId = $testSchoolId; turn = $turn
        })
    } "Tracking-window global activation must not retain pilot scope."
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
            schemaVersion = 2; mode = "tracking-window-global-on"
        })
    } "Tracking-window global activation must retain verified TURN inputs."
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
            schemaVersion = 2; mode = "tracking-window-pilot"; pilotSchoolId = $testSchoolId
            enabledCapabilities = @("screenshotTrackingWindowLeaseV1"); turn = $turn
        })
    } "Tracking-window pilot must not reuse ordered test-school capability fields."
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
            schemaVersion = 2; mode = "student-gate-pilot"; pilotSchoolId = $testSchoolId
        })
    } "Student-gate profiles must require their independent schema version."
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
            schemaVersion = 3; mode = "student-gate-pilot"; pilotSchoolId = "NOT-A-UUID"
        })
    } "Student-gate pilot must reject malformed school scope."
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
            schemaVersion = 3; mode = "student-gate-global-on"; pilotSchoolId = $testSchoolId
        })
    } "Student-gate global activation must not retain pilot scope."
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
            schemaVersion = 3; mode = "student-gate-off"; turn = $turn
        })
    } "Student-gate rollback must preserve existing TURN wiring."
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
            schemaVersion = 3; mode = "late-signin-pilot"; pilotSchoolId = $testSchoolId
        })
    } "Late-sign-in profiles must require their independent schema version."
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
            schemaVersion = 4; mode = "late-signin-pilot"; pilotSchoolId = "NOT-A-UUID"
        })
    } "Late-sign-in pilot must reject malformed school scope."
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
            schemaVersion = 4; mode = "late-signin-off"; turn = $turn
        })
    } "Late-sign-in rollback must preserve existing TURN wiring."
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{
            schemaVersion = 1; mode = "test-school"; testSchoolId = $testSchoolId
            enabledCapabilities = @($script:ActivationOrder[0..6])
        })
    } "Activation through Live View without TURN inputs must fail closed."
    Assert-Throws {
        ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{ schemaVersion = 1; mode = "off"; turn = $turn })
    } "Off mode must not rewrite TURN wiring."
    foreach ($misCasedMode in @(
        "OFF", "Off", "TEST-SCHOOL", "Test-School", "GLOBAL-ON", "Global-On",
        "TRACKING-WINDOW-PILOT", "Tracking-Window-Pilot",
        "TRACKING-WINDOW-GLOBAL-ON", "Tracking-Window-Global-On",
        "STUDENT-GATE-PILOT", "Student-Gate-Pilot",
        "STUDENT-GATE-GLOBAL-ON", "Student-Gate-Global-On",
        "STUDENT-GATE-OFF", "Student-Gate-Off",
        "LATE-SIGNIN-PILOT", "Late-Signin-Pilot",
        "LATE-SIGNIN-OFF", "Late-Signin-Off"
    )) {
        Assert-Throws {
            $misCasedSchema = if ($misCasedMode -clike "*LATE*" -or $misCasedMode -clike "Late*") {
                4
            } elseif ($misCasedMode -clike "*STUDENT*" -or $misCasedMode -clike "Student*") {
                3
            } elseif ($misCasedMode -clike "*TRACKING*" -or $misCasedMode -clike "Tracking*") { 2 } else { 1 }
            ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{ schemaVersion = $misCasedSchema; mode = $misCasedMode })
        } "Runtime profile modes must use the exact reviewed lowercase spelling."
    }

    $evidencePath = Join-Path $testRoot "turn-evidence.json"
    $evidence = [ordered]@{
        schemaVersion = 2
        validatedAt = [DateTimeOffset]::Parse("2026-08-23T12:00:00Z").ToString("o")
        hostsSha256 = $globalRuntime.Turn.HostsSha256
        secretArnSha256 = $globalRuntime.Turn.SecretArnSha256
        checks = [ordered]@{
            twoHealthyNodes = $true; distinctAvailabilityZones = $true; dnsMatchesElasticIps = $true
            turnUdp3478 = $true; turnTcp3478 = $true; turnsTcp443 = $true; tlsCertificatesCurrent = $true
            relayRangeValidated = $true; aggregateTelemetryHealthy = $true
            syntheticUdpBlockedFallbackPassed = $true; managedUdpBlockedLiveViewPassed = $true
        }
    }
    Write-TestJson -Path $evidencePath -Value $evidence
    $turnEvidence = Assert-TurnEvidence -RuntimeConfiguration $globalRuntime -EvidencePath $evidencePath -Now ([DateTimeOffset]::Parse("2026-08-23T12:30:00Z"))
    Assert-Condition ($turnEvidence.EvidenceSha256 -match '^[0-9a-f]{64}$') "TURN evidence must bind the requested host and secret hashes."
    $completeTurnChecks = $evidence.checks
    $evidence.checks = [ordered]@{}
    Write-TestJson -Path $evidencePath -Value $evidence
    Assert-Throws {
        Assert-TurnEvidence -RuntimeConfiguration $globalRuntime -EvidencePath $evidencePath -Now ([DateTimeOffset]::Parse("2026-08-23T12:30:00Z"))
    } "Empty TURN checks must not satisfy the live activation gate."
    $evidence.checks = [ordered]@{ twoHealthyNodes = $true }
    Write-TestJson -Path $evidencePath -Value $evidence
    Assert-Throws {
        Assert-TurnEvidence -RuntimeConfiguration $globalRuntime -EvidencePath $evidencePath -Now ([DateTimeOffset]::Parse("2026-08-23T12:30:00Z"))
    } "Partial TURN checks must not satisfy the live activation gate."
    $evidence.checks = $completeTurnChecks
    $evidence.checks.twoHealthyNodes = "true"
    Write-TestJson -Path $evidencePath -Value $evidence
    Assert-Throws {
        Assert-TurnEvidence -RuntimeConfiguration $globalRuntime -EvidencePath $evidencePath -Now ([DateTimeOffset]::Parse("2026-08-23T12:30:00Z"))
    } "String TURN checks must not satisfy the live activation gate."
    $evidence.checks.twoHealthyNodes = 1
    Write-TestJson -Path $evidencePath -Value $evidence
    Assert-Throws {
        Assert-TurnEvidence -RuntimeConfiguration $globalRuntime -EvidencePath $evidencePath -Now ([DateTimeOffset]::Parse("2026-08-23T12:30:00Z"))
    } "Numeric TURN checks must not satisfy the live activation gate."
    $evidence.checks.twoHealthyNodes = $true
    $validEvidenceText = $evidence | ConvertTo-Json -Depth 30
    Write-TestJson -Path $evidencePath -Value $evidence
    $validEvidenceSha256 = (Get-FileHash -LiteralPath $evidencePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $swappedEvidence = $validEvidenceText | ConvertFrom-Json -Depth 30
    $swappedEvidence.checks.turnsTcp443 = $false
    $global:RuntimeConfigSnapshotSwapPath = [IO.Path]::GetFullPath($evidencePath)
    $global:RuntimeConfigSnapshotSwapText = $swappedEvidence | ConvertTo-Json -Depth 30
    $global:SchoolPilotRuntimeConfigSnapshotReadHandler = {
        param([string]$SnapshotPath)
        if ($SnapshotPath -ceq $global:RuntimeConfigSnapshotSwapPath) {
            [IO.File]::WriteAllText($SnapshotPath, $global:RuntimeConfigSnapshotSwapText, [Text.UTF8Encoding]::new($false))
            $global:SchoolPilotRuntimeConfigSnapshotReadHandler = $null
        }
    }
    $swappedTurnEvidence = Assert-TurnEvidence -RuntimeConfiguration $globalRuntime -EvidencePath $evidencePath -Now ([DateTimeOffset]::Parse("2026-08-23T12:30:00Z"))
    Assert-Condition ([string]$swappedTurnEvidence.EvidenceSha256 -ceq $validEvidenceSha256) "TURN validation must hash and parse the same captured bytes during path replacement."
    Assert-Condition ((Read-StrictJson -Path $evidencePath).checks.turnsTcp443 -eq $false) "TURN replacement regression must actually exchange the path after the bounded read."
    [IO.File]::WriteAllText($evidencePath, $validEvidenceText, [Text.UTF8Encoding]::new($false))
    $evidence.checks.syntheticUdpBlockedFallbackPassed = $false
    Write-TestJson -Path $evidencePath -Value $evidence
    Assert-Throws {
        Assert-TurnEvidence -RuntimeConfiguration $globalRuntime -EvidencePath $evidencePath -Now ([DateTimeOffset]::Parse("2026-08-23T12:30:00Z"))
    } "Missing UDP-blocked fallback evidence must block activation."
    $evidence.checks.syntheticUdpBlockedFallbackPassed = $true
    Write-TestJson -Path $evidencePath -Value $evidence

    $digest = "sha256:" + ("b" * 64)
    $apiSourceArn = "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api:68"
    $workerSourceArn = "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:83"
    $apiSource = New-TestTaskResponse -Role api -Arn $apiSourceArn -Digest $digest
    $apiRequest = New-RuntimeTaskDefinitionRequest -SourceResponse $apiSource -RuntimeConfiguration $globalRuntime `
        -ExpectedDigest $digest -ExpectedArn $apiSourceArn -ExpectedFamily "schoolpilot-production-api" `
        -ContainerName "api" -ExpectedCpu "512" -ExpectedMemory "2048"
    $apiContainer = @($apiRequest.containerDefinitions | Where-Object name -CEQ "api")[0]
    Assert-Condition (@($apiContainer.environment | Where-Object name -CEQ "NODE_ENV").Count -eq 1) "Unrelated environment must survive the clone."
    Assert-Condition (@($apiContainer.secrets | Where-Object name -CEQ "REDIS_URL").Count -eq 1) "Unrelated secrets must survive the clone."
    Assert-Condition (@($apiContainer.secrets | Where-Object name -CEQ "CLASSPILOT_TURN_REST_SECRET").Count -eq 1) "TURN secret must be a single secret reference."
    Assert-Condition ((Get-TaskFingerprint -TaskDefinition $apiSource.taskDefinition -ContainerName "api") -ceq (Get-TaskFingerprint -TaskDefinition $apiRequest -ContainerName "api")) "Only allowlisted runtime fields may differ."
    $offRuntime = ConvertTo-RuntimeConfiguration -Profile ([pscustomobject]@{ schemaVersion = 1; mode = "off" })
    $turnWiredSource = New-TestTaskResponse -Role api -Arn $apiSourceArn -Digest $digest `
        -ManagedEnvironment @(
            [pscustomobject]@{ name = "CLASSPILOT_TURN_HOSTS"; value = "turn-a.school-pilot.net,turn-b.school-pilot.net" },
            [pscustomobject]@{ name = "CLASSPILOT_STUN_URLS"; value = "stun:turn-a.school-pilot.net:3478,stun:turn-b.school-pilot.net:3478" }
        ) -ManagedSecrets @([pscustomobject]@{ name = "CLASSPILOT_TURN_REST_SECRET"; valueFrom = $turnSecretArn })
    $offRequest = New-RuntimeTaskDefinitionRequest -SourceResponse $turnWiredSource -RuntimeConfiguration $offRuntime `
        -ExpectedDigest $digest -ExpectedArn $apiSourceArn -ExpectedFamily "schoolpilot-production-api" `
        -ContainerName "api" -ExpectedCpu "512" -ExpectedMemory "2048"
    $offContainer = @($offRequest.containerDefinitions | Where-Object name -CEQ "api")[0]
    Assert-Condition (@($offContainer.environment | Where-Object name -CEQ "CLASSPILOT_TURN_HOSTS").Count -eq 1) "Off mode must preserve provisioned TURN hosts."
    Assert-Condition (@($offContainer.secrets | Where-Object name -CEQ "CLASSPILOT_TURN_REST_SECRET").Count -eq 1) "Off mode must preserve the provisioned TURN secret reference."
    $caseVariantSource = New-TestTaskResponse -Role api -Arn $apiSourceArn -Digest $digest `
        -ManagedEnvironment @([pscustomobject]@{ name = "classpilot_cap_exact_tab_close_v2"; value = "unrelated-case-sensitive-value" }) `
        -ManagedSecrets @([pscustomobject]@{ name = "classpilot_turn_rest_secret"; valueFrom = "arn:example:unrelated" })
    $caseVariantRequest = New-RuntimeTaskDefinitionRequest -SourceResponse $caseVariantSource -RuntimeConfiguration $globalRuntime `
        -ExpectedDigest $digest -ExpectedArn $apiSourceArn -ExpectedFamily "schoolpilot-production-api" `
        -ContainerName "api" -ExpectedCpu "512" -ExpectedMemory "2048"
    $caseVariantContainer = @($caseVariantRequest.containerDefinitions | Where-Object name -CEQ "api")[0]
    Assert-Condition (@($caseVariantContainer.environment | Where-Object name -CEQ "classpilot_cap_exact_tab_close_v2").Count -eq 1) "Lowercase unrelated environment names must survive the case-sensitive allowlist."
    Assert-Condition (@($caseVariantContainer.secrets | Where-Object name -CEQ "classpilot_turn_rest_secret").Count -eq 1) "Lowercase unrelated secret names must survive the case-sensitive allowlist."
    $badRequest = $apiRequest | ConvertTo-Json -Depth 50 | ConvertFrom-Json -Depth 50
    $badRequest.memory = "1024"
    Assert-Condition ((Get-TaskFingerprint -TaskDefinition $apiSource.taskDefinition -ContainerName "api") -cne (Get-TaskFingerprint -TaskDefinition $badRequest -ContainerName "api")) "A resource mutation must change the immutable fingerprint."
    $badSource = New-TestTaskResponse -Role api -Arn $apiSourceArn -Digest $digest
    $badSource.taskDefinition.memory = "1024"
    Assert-Throws {
        New-RuntimeTaskDefinitionRequest -SourceResponse $badSource -RuntimeConfiguration $globalRuntime `
            -ExpectedDigest $digest -ExpectedArn $apiSourceArn -ExpectedFamily "schoolpilot-production-api" `
            -ContainerName "api" -ExpectedCpu "512" -ExpectedMemory "2048"
    } "Lower API memory must fail closed."

    Assert-Throws {
        Assert-ProductionDeploymentWindow -NowEastern ([DateTimeOffset]::Parse("2026-08-24T05:00:00-04:00"))
    } "Weekday arrival window must block runtime deployment."
    Assert-ProductionDeploymentWindow -NowEastern ([DateTimeOffset]::Parse("2026-08-24T04:44:59-04:00"))
    Assert-Throws {
        Assert-ProductionDeploymentWindow -NowEastern ([DateTimeOffset]::Parse("2026-08-24T04:45:00-04:00"))
    } "The protected weekday window must begin at exactly 04:45 Eastern."
    Assert-Throws {
        Assert-ProductionDeploymentWindow -NowEastern ([DateTimeOffset]::Parse("2026-08-24T10:14:59-04:00"))
    } "The protected weekday window must include the complete 10:14 minute."
    Assert-ProductionDeploymentWindow -NowEastern ([DateTimeOffset]::Parse("2026-08-24T10:15:00-04:00"))
    Assert-RuntimeConfigMutationWindow -NowEastern ([DateTimeOffset]::Parse("2026-08-24T04:45:00-04:00")) `
        -ConfirmProtectedWindowProductionMutation
    Assert-RuntimeConfigMutationWindow -NowEastern ([DateTimeOffset]::Parse("2026-08-24T10:14:59-04:00")) `
        -ConfirmProtectedWindowProductionMutation
    Assert-Throws {
        Assert-RuntimeConfigMutationWindow -NowEastern ([DateTimeOffset]::Parse("2026-08-24T10:15:00-04:00")) `
            -ConfirmProtectedWindowProductionMutation
    } "Protected confirmation must be rejected outside the weekday protected window."
    Assert-Throws {
        Assert-RuntimeConfigMutationWindow -NowEastern ([DateTimeOffset]::Parse("2026-08-23T06:00:00-04:00")) `
            -ConfirmProtectedWindowProductionMutation
    } "Protected confirmation must be rejected on weekends."
    Assert-ProductionDeploymentWindow -NowEastern ([DateTimeOffset]::Parse("2026-08-23T05:00:00-04:00"))

    $toolSha = "b" * 40
    $global:RuntimeConfigGitState = [ordered]@{ Branch = "main"; Sha = $toolSha; Dirty = "" }
    $global:SchoolPilotRuntimeConfigGitHandler = {
        param([string[]]$Arguments)
        if ($Arguments[0] -ceq "branch") { return $global:RuntimeConfigGitState.Branch }
        if ($Arguments[0] -ceq "status") { return $global:RuntimeConfigGitState.Dirty }
        if ($Arguments[0] -ceq "rev-parse") { return $global:RuntimeConfigGitState.Sha }
        throw "Unexpected mocked git operation."
    }
    [void](Assert-RepositoryIdentity -RepositoryRoot $repositoryRoot -ExpectedSha $toolSha)
    Assert-Throws {
        Assert-RepositoryIdentity -RepositoryRoot $repositoryRoot -ExpectedSha ("a" * 40)
    } "The reviewed runtime-tool SHA must be independent from the deployed application SHA."
    $global:RuntimeConfigGitState.Branch = "feature"
    Assert-Throws {
        Assert-RepositoryIdentity -RepositoryRoot $repositoryRoot -ExpectedSha $toolSha
    } "Runtime deployment must require clean main at the exact reviewed tool SHA."
    $global:RuntimeConfigGitState.Branch = "main"

    Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
    $global:SchoolPilotRuntimeConfigAwsHandler = {
        param([string[]]$Arguments)
        $state = $global:RuntimeConfigTestState
        $operation = "$($Arguments[0]) $($Arguments[1])"
        switch ($operation) {
            "sts get-caller-identity" { return [pscustomobject]@{ Account = "135775632425" } }
            "dynamodb describe-table" {
                return [pscustomobject]@{
                    Table = [pscustomobject]@{
                        TableStatus = "ACTIVE"
                        KeySchema = @([pscustomobject]@{ AttributeName = "LockID"; KeyType = "HASH" })
                    }
                }
            }
            "dynamodb get-item" {
                $item = $null
                if ($null -ne $state.LockOwner) {
                    $item = [pscustomobject]@{
                        LockID = [pscustomobject]@{ S = $script:OperationLockId }
                        OwnerToken = [pscustomobject]@{ S = [string]$state.LockOwner }
                        FenceToken = [pscustomobject]@{ N = [string]$state.LockFence }
                        LeaseExpiresAt = [pscustomobject]@{ N = [string]$state.LockExpiresAt }
                        OperationState = [pscustomobject]@{ S = [string]$state.LockOperationState }
                    }
                }
                return [pscustomobject]@{ Item = $item }
            }
            "dynamodb update-item" {
                $valuesArgument = Get-ArgumentValue -Arguments $Arguments -Name "--expression-attribute-values"
                if (-not $valuesArgument.StartsWith("file://", [StringComparison]::Ordinal)) {
                    throw "Mocked DynamoDB values must use a private JSON file."
                }
                $values = Get-Content -LiteralPath $valuesArgument.Substring("file://".Length) -Raw | ConvertFrom-Json -Depth 20
                $updateExpression = Get-ArgumentValue -Arguments $Arguments -Name "--update-expression"
                $nowValue = [long]$values.":now".N
                if ($updateExpression -like "*ADD FenceToken*") {
                    $takeoverStateAllowed = [string]$state.LockOperationState -cin @("released", "preparing", "terminal_safe")
                    if ($null -ne $state.LockOwner -and
                        ([long]$state.LockExpiresAt -gt $nowValue -or -not $takeoverStateAllowed)) {
                        throw "Mocked conditional lock conflict."
                    }
                    $state.LockOwner = [string]$values.":owner".S
                    $state.LockPlanSha256 = [string]$values.":plan".S
                    $state.LockExpiresAt = [long]$values.":expires".N
                    $state.LockFence = [long]$state.LockFence + 1L
                    $state.LockOperationState = "preparing"
                    $state.Events.Add("lease:acquire:$($state.LockFence)")
                }
                elseif ($updateExpression -like "SET OperationState = :mutating,*") {
                    if ([string]$state.LockOwner -cne [string]$values.":owner".S -or
                        [long]$state.LockFence -ne [long]$values.":fence".N -or
                        [long]$state.LockExpiresAt -le $nowValue -or
                        [string]$state.LockOperationState -cne "preparing") {
                        throw "Mocked conditional mutation-window conflict."
                    }
                    $state.LockExpiresAt = [long]$values.":expires".N
                    $state.LockOperationState = "mutating"
                    $state.Events.Add("lease:mutating:$($state.LockFence)")
                }
                elseif ($updateExpression -like "SET OperationState = :terminal,*") {
                    if ([string]$state.LockOwner -cne [string]$values.":owner".S -or
                        [long]$state.LockFence -ne [long]$values.":fence".N -or
                        [long]$state.LockExpiresAt -le $nowValue -or
                        [string]$state.LockOperationState -cne "mutating") {
                        throw "Mocked conditional terminal-safe conflict."
                    }
                    $state.LockExpiresAt = [long]$values.":expires".N
                    $state.LockOperationState = "terminal_safe"
                    $state.Events.Add("lease:terminal-safe:$($state.LockFence)")
                }
                elseif ($updateExpression -ceq "SET LeaseExpiresAt = :expires") {
                    if ([string]$state.LockOwner -cne [string]$values.":owner".S -or
                        [long]$state.LockFence -ne [long]$values.":fence".N -or
                        [long]$state.LockExpiresAt -le $nowValue -or
                        [string]$state.LockOperationState -cne [string]$values.":state".S) {
                        throw "Mocked conditional lease renewal conflict."
                    }
                    $state.LockExpiresAt = [long]$values.":expires".N
                    $state.Events.Add("lease:renew:$($state.LockFence)")
                }
                elseif ($updateExpression -like "SET OwnerToken = :released,*") {
                    if ([string]$state.LockOwner -cne [string]$values.":owner".S -or
                        [long]$state.LockFence -ne [long]$values.":fence".N -or
                        [long]$state.LockExpiresAt -le $nowValue -or
                        [string]$state.LockOperationState -cne "terminal_safe") {
                        throw "Mocked conditional lease release conflict."
                    }
                    $state.LockOwner = "released"
                    $state.LockPlanSha256 = $null
                    $state.LockExpiresAt = 0L
                    $state.LockOperationState = "released"
                    $state.Events.Add("lease:release:$($state.LockFence)")
                }
                else { throw "Unexpected mocked DynamoDB update expression." }
                return [pscustomobject]@{
                    Attributes = [pscustomobject]@{
                        LockID = [pscustomobject]@{ S = $script:OperationLockId }
                        OwnerToken = [pscustomobject]@{ S = [string]$state.LockOwner }
                        FenceToken = [pscustomobject]@{ N = [string]$state.LockFence }
                        LeaseExpiresAt = [pscustomobject]@{ N = [string]$state.LockExpiresAt }
                        OperationState = [pscustomobject]@{ S = [string]$state.LockOperationState }
                    }
                }
            }
            "ecs describe-services" {
                $delayedAtSourceRecheck = $state.DelayedScheduledChangeTrigger -ceq "source-recheck" -and
                    @($state.Events | Where-Object { $_ -ceq "scaling:hold" }).Count -gt 0 -and
                    @($state.Events | Where-Object { $_ -like "bounds:*" -or $_ -like "update:*" }).Count -eq 0
                $delayedDuringConvergence = $state.DelayedScheduledChangeTrigger -ceq "convergence" -and
                    @($state.Events | Where-Object { $_ -ceq "update:worker:candidate" }).Count -gt 0
                if (-not $state.DelayedScheduledChangeConsumed -and
                    ($delayedAtSourceRecheck -or $delayedDuringConvergence)) {
                    $state.ScalingMin = 6
                    $state.ApiDesiredCount = 6
                    $state.DelayedScheduledChangeConsumed = $true
                    $state.Events.Add("scheduled:delayed:desired:6")
                }
                if ($state.SimulateScheduledDesiredChangeDuringConvergence -and
                    -not $state.ScheduledDesiredChangeConsumed -and -not $state.Scheduled -and
                    @($state.Events | Where-Object { $_ -ceq "bounds:worker:0-100" }).Count -gt 0) {
                    $state.ApiDesiredCount = 6
                    $state.ScheduledDesiredChangeConsumed = $true
                    $state.Events.Add("scheduled:desired:6")
                }
                $apiArn = $state.ApiCurrentArn
                if ($state.DriftAfterRegistration -and $state.RegisterCount -ge 2) {
                    $apiFamily = [string]$state.ApiSourceArn.Split("/")[-1].Split(":")[0]
                    $apiArn = "arn:aws:ecs:us-east-1:135775632425:task-definition/${apiFamily}:999"
                }
                $apiMinimum = $state.ApiMinimumHealthyPercent
                $apiMaximum = $state.ApiMaximumPercent
                if ($state.BoundsDriftAfterRegistration -and $state.RegisterCount -ge 2) {
                    $apiMinimum = 99
                    $apiMaximum = 199
                }
                $apiService = New-TestService -Role api -TaskDefinitionArn $apiArn -DesiredCount $state.ApiDesiredCount `
                    -MinimumHealthyPercent $apiMinimum -MaximumPercent $apiMaximum `
                    -DeploymentConfiguration $state.ApiDeploymentConfiguration
                $apiService.deploymentConfiguration.minimumHealthyPercent = $apiMinimum
                $apiService.deploymentConfiguration.maximumPercent = $apiMaximum
                if ($state.TransitionApiDescribeReadsRemaining -gt 0 -and
                    @($state.Events | Where-Object { $_ -ceq "update:worker:candidate" }).Count -gt 0) {
                    $state.TransitionApiDescribeReadsRemaining--
                    $state.Events.Add("transition:api-stopping")
                    $apiService.deployments = @(
                        [pscustomobject]@{
                            status = "PRIMARY"; rolloutState = "IN_PROGRESS"; taskDefinition = $apiArn
                            desiredCount = $state.ApiDesiredCount; runningCount = [Math]::Max(0, $state.ApiDesiredCount - 1)
                            pendingCount = 0; failedTasks = 0
                        },
                        [pscustomobject]@{
                            status = "ACTIVE"; rolloutState = "IN_PROGRESS"; taskDefinition = $state.ApiSourceArn
                            desiredCount = 0; runningCount = 1; pendingCount = 0; failedTasks = 0
                        }
                    )
                }
                return [pscustomobject]@{
                    failures = @()
                    services = @(
                        $apiService,
                        (New-TestService -Role worker -TaskDefinitionArn $state.WorkerCurrentArn `
                            -MinimumHealthyPercent $state.WorkerMinimumHealthyPercent -MaximumPercent $state.WorkerMaximumPercent `
                            -DeploymentConfiguration $state.WorkerDeploymentConfiguration)
                    )
                }
            }
            "ecs describe-task-definition" {
                $arn = Get-ArgumentValue -Arguments $Arguments -Name "--task-definition"
                if (-not $state.TaskResponses.ContainsKey($arn)) { throw "Unknown mocked task definition." }
                return $state.TaskResponses[$arn]
            }
            "ecs register-task-definition" {
                $input = Get-ArgumentValue -Arguments $Arguments -Name "--cli-input-json"
                $path = $input.Substring("file://".Length)
                $request = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -Depth 50
                if ([string]$request.family -cin $script:AllowedApiFamilies) {
                    $arn = "arn:aws:ecs:us-east-1:135775632425:task-definition/$([string]$request.family):$($state.NextApiRevision)"
                    $state.NextApiRevision++
                    $state.Events.Add("register:api")
                }
                elseif ([string]$request.family -ceq $script:WorkerFamily) {
                    $arn = "arn:aws:ecs:us-east-1:135775632425:task-definition/$($script:WorkerFamily):$($state.NextWorkerRevision)"
                    $state.NextWorkerRevision++
                    $state.Events.Add("register:worker")
                }
                else { throw "Unexpected task family in mocked registration." }
                $response = Copy-RegisteredTask -Request $request -Arn $arn
                $state.TaskResponses[$arn] = $response
                $state.RegisterCount++
                return $response
            }
            "ecs update-service" {
                $service = Get-ArgumentValue -Arguments $Arguments -Name "--service"
                if ($Arguments -contains "--deployment-configuration") {
                    $bounds = Get-ArgumentValue -Arguments $Arguments -Name "--deployment-configuration"
                    if (-not $bounds.StartsWith("file://", [StringComparison]::Ordinal)) {
                        throw "Mocked deployment configuration must use a complete JSON document."
                    }
                    $configuration = Get-Content -LiteralPath $bounds.Substring("file://".Length) -Raw | ConvertFrom-Json -Depth 60
                    if ([string]$configuration.strategy -cne "ROLLING" -or
                        $configuration.deploymentCircuitBreaker.enable -isnot [bool] -or
                        $configuration.deploymentCircuitBreaker.rollback -isnot [bool] -or
                        -not [bool]$configuration.deploymentCircuitBreaker.enable -or
                        -not [bool]$configuration.deploymentCircuitBreaker.rollback -or
                        $null -eq $configuration.bakeTimeInMinutes) {
                        throw "Mocked deployment configuration did not preserve the reviewed rolling contract."
                    }
                    $minimum = [int]$configuration.minimumHealthyPercent
                    $maximum = [int]$configuration.maximumPercent
                    if ($service -ceq $script:ApiService) {
                        if ($minimum -eq 100 -and $maximum -eq 200 -and $state.FailApiBoundsRestoreOnce -and
                            -not $state.ApiBoundsRestoreFailureConsumed -and
                            @($state.Events | Where-Object { $_ -ceq "update:worker:candidate" }).Count -gt 0) {
                            $state.ApiBoundsRestoreFailureConsumed = $true
                            $state.Events.Add("bounds:api:restore-failed")
                            throw "Mocked API deployment-bounds restoration failure."
                        }
                        $state.ApiMinimumHealthyPercent = $minimum
                        $state.ApiMaximumPercent = $maximum
                        $state.ApiDeploymentConfiguration = $configuration
                        $state.Events.Add("bounds:api:$minimum-$maximum")
                    }
                    else {
                        $state.WorkerMinimumHealthyPercent = $minimum
                        $state.WorkerMaximumPercent = $maximum
                        $state.WorkerDeploymentConfiguration = $configuration
                        $state.Events.Add("bounds:worker:$minimum-$maximum")
                    }
                    return [pscustomobject]@{ service = [pscustomobject]@{ serviceName = $service } }
                }
                $arn = Get-ArgumentValue -Arguments $Arguments -Name "--task-definition"
                $isApi = $service -ceq $script:ApiService
                $isSource = $arn -ceq $(if ($isApi) { $state.ApiSourceArn } else { $state.WorkerSourceArn })
                $state.Events.Add("update:" + $(if ($isApi) { "api" } else { "worker" }) + ":" + $(if ($isSource) { "source" } else { "candidate" }))
                if (-not $isApi -and -not $isSource -and $state.FailWorkerCandidateOnce -and -not $state.WorkerCandidateFailureConsumed) {
                    $state.WorkerCandidateFailureConsumed = $true
                    throw "Mocked worker candidate update failure."
                }
                if ($isSource -and $state.FailRollbackReassertion) { throw "Mocked source reassertion failure." }
                if ($isApi) { $state.ApiCurrentArn = $arn } else { $state.WorkerCurrentArn = $arn }
                return [pscustomobject]@{ service = [pscustomobject]@{ taskDefinition = $arn } }
            }
            "ecs list-tasks" {
                $service = Get-ArgumentValue -Arguments $Arguments -Name "--service-name"
                $role = if ($service -ceq $script:ApiService) { "api" } else { "worker" }
                $count = if ($role -ceq "api") { $state.ApiDesiredCount } else { 1 }
                return [pscustomobject]@{ taskArns = @(1..$count | ForEach-Object { "arn:aws:ecs:us-east-1:135775632425:task/mock-$role-$_" }) }
            }
            "ecs describe-tasks" {
                $taskIndex = [Array]::IndexOf($Arguments, "--tasks") + 1
                $regionIndex = [Array]::IndexOf($Arguments, "--region")
                $taskArns = @($Arguments[$taskIndex..($regionIndex - 1)])
                $isApi = [string]$taskArns[0] -like "*mock-api-*"
                return [pscustomobject]@{
                    failures = @()
                    tasks = @($taskArns | ForEach-Object { [pscustomobject]@{
                        taskDefinitionArn = if ($isApi) { $state.ApiCurrentArn } else { $state.WorkerCurrentArn }
                        lastStatus = "RUNNING"
                        healthStatus = if ($isApi) { "HEALTHY" } else { "UNKNOWN" }
                    } })
                }
            }
            "elbv2 describe-target-health" {
                $targetGroupArn = Get-ArgumentValue -Arguments $Arguments -Name "--target-group-arn"
                if ($targetGroupArn -cne "arn:aws:elasticloadbalancing:us-east-1:135775632425:targetgroup/schoolpilot-production-api/abcdef0123456789") {
                    throw "Unexpected mocked target group."
                }
                $count = if ($null -eq $state.HealthyApiTargetCountOverride) {
                    [int]$state.ApiDesiredCount
                } else {
                    [int]$state.HealthyApiTargetCountOverride
                }
                $descriptions = @()
                if ($count -gt 0) {
                    $descriptions = @(1..$count | ForEach-Object {
                        [pscustomobject]@{ TargetHealth = [pscustomobject]@{ State = "healthy" } }
                    })
                }
                return [pscustomobject]@{ TargetHealthDescriptions = $descriptions }
            }
            "ecr describe-images" {
                if ($state.RejectEcrLookup) { throw "ECR lookup must be skipped for emergency off containment." }
                $imageId = Get-ArgumentValue -Arguments $Arguments -Name "--image-ids"
                if ($imageId -cne "imageTag=$([string]$state.AppSha.Substring(0, 12))") { throw "Immutable image lookup did not use the reviewed deployment tag." }
                return [pscustomobject]@{ imageDetails = @([pscustomobject]@{ imageDigest = $state.Digest }) }
            }
            "ec2 describe-instances" {
                $reservations = @(
                    [pscustomobject]@{ Instances = @([pscustomobject]@{ InstanceId = "i-00000000000000001"; Placement = [pscustomobject]@{ AvailabilityZone = "us-east-1a" } }) },
                    [pscustomobject]@{ Instances = @([pscustomobject]@{ InstanceId = "i-00000000000000002"; Placement = [pscustomobject]@{ AvailabilityZone = "us-east-1b" } }) }
                )
                return [pscustomobject]@{ Reservations = @($reservations | Select-Object -First $state.TurnNodeCount) }
            }
            "ec2 describe-instance-status" {
                return [pscustomobject]@{ InstanceStatuses = @(1, 2 | ForEach-Object {
                    [pscustomobject]@{
                        InstanceState = [pscustomobject]@{ Name = "running" }
                        InstanceStatus = [pscustomobject]@{ Status = if ($state.TurnStatusHealthy) { "ok" } else { "impaired" } }
                        SystemStatus = [pscustomobject]@{ Status = "ok" }
                    }
                }) }
            }
            "secretsmanager describe-secret" {
                $secret = [pscustomobject]@{ ARN = $state.SecretArn }
                if ($state.TurnSecretDeleted) { $secret | Add-Member -NotePropertyName DeletedDate -NotePropertyValue "2026-08-23T12:00:00Z" }
                return $secret
            }
            "application-autoscaling describe-scalable-targets" {
                if ($state.FailScalingReadbackOnce -and $state.DynamicIn -and -not $state.ScalingReadbackFailureConsumed) {
                    $state.ScalingReadbackFailureConsumed = $true
                    throw "Mocked scaling readback failure."
                }
                return [pscustomobject]@{ ScalableTargets = @([pscustomobject]@{
                    MinCapacity = $state.ScalingMin; MaxCapacity = $state.ScalingMax
                    SuspendedState = [pscustomobject]@{
                        DynamicScalingInSuspended = $state.DynamicIn
                        DynamicScalingOutSuspended = $state.DynamicOut
                        ScheduledScalingSuspended = $state.Scheduled
                    }
                }) }
            }
            "application-autoscaling register-scalable-target" {
                $state.ScalingMin = [int](Get-ArgumentValue -Arguments $Arguments -Name "--min-capacity")
                $state.ScalingMax = [int](Get-ArgumentValue -Arguments $Arguments -Name "--max-capacity")
                if ($state.ApiDesiredCount -lt $state.ScalingMin) {
                    $state.ApiDesiredCount = $state.ScalingMin
                }
                $suspension = Get-ArgumentValue -Arguments $Arguments -Name "--suspended-state"
                $state.DynamicIn = $suspension.Contains("DynamicScalingInSuspended=true", [StringComparison]::Ordinal)
                $state.DynamicOut = $suspension.Contains("DynamicScalingOutSuspended=true", [StringComparison]::Ordinal)
                $state.Scheduled = $suspension.Contains("ScheduledScalingSuspended=true", [StringComparison]::Ordinal)
                $state.Events.Add($(if ($state.DynamicIn -and $state.DynamicOut) { "scaling:hold" } else { "scaling:restore" }))
                return [pscustomobject]@{}
            }
            "application-autoscaling describe-scheduled-actions" {
                $upTarget = [pscustomobject]@{ MinCapacity = 6 }
                $downTarget = [pscustomobject]@{ MinCapacity = 1 }
                if ($null -ne $state.ScheduledActionMaxCapacity) {
                    $upTarget | Add-Member -NotePropertyName MaxCapacity -NotePropertyValue $state.ScheduledActionMaxCapacity
                    $downTarget | Add-Member -NotePropertyName MaxCapacity -NotePropertyValue $state.ScheduledActionMaxCapacity
                }
                return [pscustomobject]@{ ScheduledActions = @(
                    [pscustomobject]@{
                        ScheduledActionName = "schoolpilot-production-api-arrival-scale-up"
                        Schedule = "cron(45 5 ? * MON-FRI *)"
                        Timezone = "America/New_York"
                        ScalableTargetAction = $upTarget
                    },
                    [pscustomobject]@{
                        ScheduledActionName = "schoolpilot-production-api-arrival-scale-down"
                        Schedule = "cron(0 10 ? * MON-FRI *)"
                        Timezone = "America/New_York"
                        ScalableTargetAction = $downTarget
                    }
                ) }
            }
            default { throw "Unexpected mocked AWS operation: $operation" }
        }
    }

    $global:RuntimeConfigTestState.HealthyApiTargetCountOverride = 0
    $unhealthyApi = (Get-ServiceSnapshot).Api
    Assert-Throws {
        Assert-ApiTargetHealth -ApiService $unhealthyApi -ExpectedDesiredCount 1 -Mode Converging
    } "A one-task runtime mutation must stop rather than accept zero healthy ALB targets."
    $global:RuntimeConfigTestState.HealthyApiTargetCountOverride = 2
    Assert-Throws {
        Assert-ApiTargetHealth -ApiService $unhealthyApi -ExpectedDesiredCount 1 -Mode Exact
    } "An exact runtime health gate must reject extra healthy ALB targets."
    $global:RuntimeConfigTestState.HealthyApiTargetCountOverride = $null

    Acquire-OperationLock -RunId "lease-owner-a" -PlanSha256 ("1" * 64)
    $ownerA = [string]$script:OperationLockOwner
    $fenceA = [long]$script:OperationLockFence
    $expiryA = [long]$script:OperationLockExpiresAt
    $stateA = [string]$script:OperationLockState
    $script:OperationLockHeld = $false
    $script:OperationLockOwner = $null
    $script:OperationLockFence = $null
    $script:OperationLockExpiresAt = 0L
    $script:OperationLockState = $null
    Assert-Throws {
        Acquire-OperationLock -RunId "lease-owner-b-conflict" -PlanSha256 ("2" * 64)
    } "A second process must not acquire an unexpired production operation lease."
    $script:OperationLockHeld = $true
    $script:OperationLockOwner = $ownerA
    $script:OperationLockFence = $fenceA
    $script:OperationLockExpiresAt = $expiryA
    $script:OperationLockState = $stateA
    $global:RuntimeConfigLeaseClock = $expiryA - 179L
    Maintain-OperationLock
    Assert-Condition ($script:OperationLockExpiresAt -gt $expiryA -and $global:RuntimeConfigTestState.Events -contains "lease:renew:$fenceA") "The lease owner must renew before the fencing window becomes unsafe."
    $renewedExpiryA = [long]$script:OperationLockExpiresAt
    $script:OperationLockHeld = $false
    $script:OperationLockOwner = $null
    $script:OperationLockFence = $null
    $script:OperationLockExpiresAt = 0L
    $script:OperationLockState = $null
    $global:RuntimeConfigLeaseClock = $renewedExpiryA + 1L
    Acquire-OperationLock -RunId "lease-owner-b" -PlanSha256 ("2" * 64)
    $ownerB = [string]$script:OperationLockOwner
    $fenceB = [long]$script:OperationLockFence
    $expiryB = [long]$script:OperationLockExpiresAt
    $stateB = [string]$script:OperationLockState
    Assert-Condition ($fenceB -eq ($fenceA + 1L)) "A stale-lease takeover must advance the durable fence token."
    $script:OperationLockHeld = $true
    $script:OperationLockOwner = $ownerA
    $script:OperationLockFence = $fenceA
    $script:OperationLockExpiresAt = $renewedExpiryA
    $script:OperationLockState = $stateA
    Assert-Throws { Maintain-OperationLock } "A fenced-out owner must not renew after takeover."
    Assert-Throws { Release-OperationLock } "A fenced-out owner must not release the new owner's lease."
    $script:OperationLockHeld = $true
    $script:OperationLockOwner = $ownerB
    $script:OperationLockFence = $fenceB
    $script:OperationLockExpiresAt = $expiryB
    $script:OperationLockState = $stateB
    Start-OperationMutationWindow
    Complete-OperationMutationWindow
    Release-OperationLock
    Assert-Condition ($global:RuntimeConfigTestState.LockOwner -ceq "released" -and $global:RuntimeConfigTestState.LockFence -eq $fenceB) "Only the current fenced owner may release the production operation lease."

    Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
    Acquire-OperationLock -RunId "lease-mutating-owner" -PlanSha256 ("4" * 64)
    Start-OperationMutationWindow
    $mutatingOwner = [string]$script:OperationLockOwner
    $mutatingFence = [long]$script:OperationLockFence
    $mutatingExpiry = [long]$script:OperationLockExpiresAt
    $script:OperationLockHeld = $false
    $script:OperationLockOwner = $null
    $script:OperationLockFence = $null
    $script:OperationLockExpiresAt = 0L
    $script:OperationLockState = $null
    $global:RuntimeConfigLeaseClock = $mutatingExpiry + 1L
    Assert-Throws {
        Acquire-OperationLock -RunId "lease-forbidden-takeover" -PlanSha256 ("5" * 64)
    } "An expired mutating operation must require reconciliation and block automatic takeover."
    Assert-Condition ([string]$global:RuntimeConfigTestState.LockOwner -ceq $mutatingOwner -and
        [long]$global:RuntimeConfigTestState.LockFence -eq $mutatingFence -and
        [string]$global:RuntimeConfigTestState.LockOperationState -ceq "mutating") "Failed takeover must leave the durable mutating owner and fence unchanged."
    Assert-Throws { Restore-ScalingHold } "Autoscaling restoration must never report success when this process did not acquire the hold."
    $global:RuntimeConfigLeaseClock = 1787486400L
    Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn

    $profilePath = Join-Path $testRoot "profile.json"
    Write-TestJson -Path $profilePath -Value $globalProfile
    $evidenceRoot = Join-Path $testRoot "private-evidence-$testSchoolId"
    $appSha = "a" * 40
    $now = [DateTimeOffset]::Parse("2026-08-23T12:30:00Z")
    $waiverTurnEvidencePath = Join-Path $testRoot "turn-evidence-synthetic-only.json"
    $waiverTurnEvidence = $evidence | ConvertTo-Json -Depth 30 | ConvertFrom-Json -Depth 30 -DateKind String
    $waiverTurnEvidence.checks.managedUdpBlockedLiveViewPassed = $false
    Write-TestJson -Path $waiverTurnEvidencePath -Value $waiverTurnEvidence
    $waiverTurnSnapshot = Read-StrictJsonSnapshot -Path $waiverTurnEvidencePath
    [void](Assert-TurnEvidence -RuntimeConfiguration $globalRuntime -EvidenceSnapshot $waiverTurnSnapshot `
        -Now $now -SyntheticOnlyWaiver)
    Assert-Throws {
        Assert-TurnEvidence -RuntimeConfiguration $globalRuntime -EvidenceSnapshot $waiverTurnSnapshot -Now $now
    } "Strict global activation must require managed UDP-blocked Live View evidence."
    $managedTurnEvidencePath = Join-Path $testRoot "turn-evidence-managed-only-for-waiver.json"
    Write-TestJson -Path $managedTurnEvidencePath -Value $evidence
    Assert-Throws {
        Assert-TurnEvidence -RuntimeConfiguration $globalRuntime -EvidencePath $managedTurnEvidencePath `
            -Now $now -SyntheticOnlyWaiver
    } "Synthetic-only activation must explicitly record that managed Live View has not passed."

    $syntheticValidationPath = Join-Path $testRoot "synthetic-validation.json"
    $syntheticValidation = [ordered]@{
        schemaVersion = 1
        validatedAt = [DateTimeOffset]::Parse("2026-08-23T12:05:00Z").ToString("o")
        schoolPilotAppSha = $appSha
        schoolPilotImageDigest = $digest
        classPilotTag = "v2.7.9"
        classPilotMergeSha = "ce4b45d0da67dab8f28e71600528b50ab52bff01"
        classPilotExtensionId = "iggbfegfcjkfieoemeolfmfnapepalca"
        classPilotZipSha256 = "0a60e83b4e968e0fa5ae36c077ee7715ff19af3f2902c8ea39ce2e4d651b08ac"
        turnEvidenceSha256 = [string]$waiverTurnSnapshot.Sha256
        checks = [ordered]@{
            crossRepositoryContractPassed = $true
            unpackedZipPassed = $true
            identityTransitions10000Passed = $true
            redisCrossProcessPassed = $true
            allCapabilitiesSimultaneousPassed = $true
            protocol2CompatibilityPassed = $true
            markerless270LegacyPassed = $true
        }
    }
    Write-TestJson -Path $syntheticValidationPath -Value $syntheticValidation
    $validSyntheticValidationText = [IO.File]::ReadAllText($syntheticValidationPath)
    $syntheticValidationSnapshot = Read-StrictJsonSnapshot -Path $syntheticValidationPath
    [void](Assert-SyntheticValidationEvidence -EvidenceSnapshot $syntheticValidationSnapshot `
        -AppSha $appSha -ImageDigest $digest -TurnEvidenceSha256 ([string]$waiverTurnSnapshot.Sha256) -Now $now)
    $invalidSyntheticValidation = $validSyntheticValidationText | ConvertFrom-Json -Depth 30 -DateKind String
    $invalidSyntheticValidation.validatedAt = $now.AddHours(-2).AddSeconds(-1).ToString("o")
    Write-TestJson -Path $syntheticValidationPath -Value $invalidSyntheticValidation
    Assert-Throws {
        Assert-SyntheticValidationEvidence -EvidenceSnapshot (Read-StrictJsonSnapshot -Path $syntheticValidationPath) `
            -AppSha $appSha -ImageDigest $digest -TurnEvidenceSha256 ([string]$waiverTurnSnapshot.Sha256) -Now $now
    } "Synthetic validation evidence older than two hours must fail closed."
    $invalidSyntheticValidation = $validSyntheticValidationText | ConvertFrom-Json -Depth 30 -DateKind String
    $invalidSyntheticValidation.checks.redisCrossProcessPassed = $false
    Write-TestJson -Path $syntheticValidationPath -Value $invalidSyntheticValidation
    Assert-Throws {
        Assert-SyntheticValidationEvidence -EvidenceSnapshot (Read-StrictJsonSnapshot -Path $syntheticValidationPath) `
            -AppSha $appSha -ImageDigest $digest -TurnEvidenceSha256 ([string]$waiverTurnSnapshot.Sha256) -Now $now
    } "A false synthetic validation check must fail closed."
    $invalidSyntheticValidation = $validSyntheticValidationText | ConvertFrom-Json -Depth 30 -DateKind String
    $invalidSyntheticValidation.turnEvidenceSha256 = "9" * 64
    Write-TestJson -Path $syntheticValidationPath -Value $invalidSyntheticValidation
    Assert-Throws {
        Assert-SyntheticValidationEvidence -EvidenceSnapshot (Read-StrictJsonSnapshot -Path $syntheticValidationPath) `
            -AppSha $appSha -ImageDigest $digest -TurnEvidenceSha256 ([string]$waiverTurnSnapshot.Sha256) -Now $now
    } "Synthetic validation must bind the exact TURN evidence hash."
    $invalidSyntheticValidation = $validSyntheticValidationText | ConvertFrom-Json -Depth 30 -DateKind String
    $invalidSyntheticValidation.classPilotExtensionId = "iggbfegfcjkfieoemeolfmfnapepalcb"
    Write-TestJson -Path $syntheticValidationPath -Value $invalidSyntheticValidation
    Assert-Throws {
        Assert-SyntheticValidationEvidence -EvidenceSnapshot (Read-StrictJsonSnapshot -Path $syntheticValidationPath) `
            -AppSha $appSha -ImageDigest $digest -TurnEvidenceSha256 ([string]$waiverTurnSnapshot.Sha256) -Now $now
    } "Synthetic validation must bind the exact production ClassPilot extension ID."
    $invalidSyntheticValidation = $validSyntheticValidationText | ConvertFrom-Json -Depth 30 -DateKind String
    $invalidSyntheticValidation.checks.PSObject.Properties.Remove("markerless270LegacyPassed")
    Write-TestJson -Path $syntheticValidationPath -Value $invalidSyntheticValidation
    Assert-Throws {
        Assert-SyntheticValidationEvidence -EvidenceSnapshot (Read-StrictJsonSnapshot -Path $syntheticValidationPath) `
            -AppSha $appSha -ImageDigest $digest -TurnEvidenceSha256 ([string]$waiverTurnSnapshot.Sha256) -Now $now
    } "Incomplete synthetic validation evidence must fail closed."
    [IO.File]::WriteAllText($syntheticValidationPath, $validSyntheticValidationText, [Text.UTF8Encoding]::new($false))
    Set-PrivatePathPermissions -Path $syntheticValidationPath
    $syntheticValidationSnapshot = Read-StrictJsonSnapshot -Path $syntheticValidationPath

    $managedTestWaiverPath = Join-Path $testRoot "managed-test-waiver.json"
    $managedTestWaiver = [ordered]@{
        schemaVersion = 1
        approvedAt = [DateTimeOffset]::Parse("2026-08-23T12:10:00Z").ToString("o")
        approvedBy = "bzinkan@school-pilot.net"
        reason = "Approved protected completion from the exact synthetic release evidence."
        syntheticValidationSha256 = [string]$syntheticValidationSnapshot.Sha256
        turnEvidenceSha256 = [string]$waiverTurnSnapshot.Sha256
        managedValidation = "waived_not_passed"
        validationLevel = "synthetic_only"
    }
    Write-TestJson -Path $managedTestWaiverPath -Value $managedTestWaiver
    $validManagedTestWaiverText = [IO.File]::ReadAllText($managedTestWaiverPath)
    $managedTestWaiverSnapshot = Read-StrictJsonSnapshot -Path $managedTestWaiverPath
    [void](Assert-ManagedTestWaiverEvidence -EvidenceSnapshot $managedTestWaiverSnapshot `
        -SyntheticValidationSha256 ([string]$syntheticValidationSnapshot.Sha256) `
        -TurnEvidenceSha256 ([string]$waiverTurnSnapshot.Sha256) -Now $now)
    $invalidManagedTestWaiver = $validManagedTestWaiverText | ConvertFrom-Json -Depth 30 -DateKind String
    $invalidManagedTestWaiver.approvedAt = $now.AddHours(-2).AddSeconds(-1).ToString("o")
    Write-TestJson -Path $managedTestWaiverPath -Value $invalidManagedTestWaiver
    Assert-Throws {
        Assert-ManagedTestWaiverEvidence -EvidenceSnapshot (Read-StrictJsonSnapshot -Path $managedTestWaiverPath) `
            -SyntheticValidationSha256 ([string]$syntheticValidationSnapshot.Sha256) `
            -TurnEvidenceSha256 ([string]$waiverTurnSnapshot.Sha256) -Now $now
    } "A stale managed-test waiver must fail closed."
    $invalidManagedTestWaiver = $validManagedTestWaiverText | ConvertFrom-Json -Depth 30 -DateKind String
    $invalidManagedTestWaiver.syntheticValidationSha256 = "8" * 64
    Write-TestJson -Path $managedTestWaiverPath -Value $invalidManagedTestWaiver
    Assert-Throws {
        Assert-ManagedTestWaiverEvidence -EvidenceSnapshot (Read-StrictJsonSnapshot -Path $managedTestWaiverPath) `
            -SyntheticValidationSha256 ([string]$syntheticValidationSnapshot.Sha256) `
            -TurnEvidenceSha256 ([string]$waiverTurnSnapshot.Sha256) -Now $now
    } "Managed-test waiver must bind the exact synthetic validation hash."
    $invalidManagedTestWaiver = $validManagedTestWaiverText | ConvertFrom-Json -Depth 30 -DateKind String
    $invalidManagedTestWaiver.PSObject.Properties.Remove("reason")
    Write-TestJson -Path $managedTestWaiverPath -Value $invalidManagedTestWaiver
    Assert-Throws {
        Assert-ManagedTestWaiverEvidence -EvidenceSnapshot (Read-StrictJsonSnapshot -Path $managedTestWaiverPath) `
            -SyntheticValidationSha256 ([string]$syntheticValidationSnapshot.Sha256) `
            -TurnEvidenceSha256 ([string]$waiverTurnSnapshot.Sha256) -Now $now
    } "Incomplete managed-test waiver evidence must fail closed."
    [IO.File]::WriteAllText($managedTestWaiverPath, $validManagedTestWaiverText, [Text.UTF8Encoding]::new($false))
    Set-PrivatePathPermissions -Path $managedTestWaiverPath
    $global:RuntimeConfigTestState.TurnNodeCount = 1
    Assert-Throws { Assert-TurnAwsReadiness -RuntimeConfiguration $globalRuntime } "Fewer than two live TURN nodes must block activation."
    $global:RuntimeConfigTestState.TurnNodeCount = 2
    $global:RuntimeConfigTestState.TurnStatusHealthy = $false
    Assert-Throws { Assert-TurnAwsReadiness -RuntimeConfiguration $globalRuntime } "An impaired TURN node must block activation."
    $global:RuntimeConfigTestState.TurnStatusHealthy = $true
    $global:RuntimeConfigTestState.TurnSecretDeleted = $true
    Assert-Throws { Assert-TurnAwsReadiness -RuntimeConfiguration $globalRuntime } "A TURN secret pending deletion must block activation."
    $global:RuntimeConfigTestState.TurnSecretDeleted = $false
    $global:RuntimeConfigTestState.ScheduledActionMaxCapacity = 8
    Assert-Throws { Assert-ScheduledScalingContract } "A scheduled action capable of raising the reviewed six-task ceiling must fail closed."
    Assert-Condition (@($global:RuntimeConfigTestState.Events | Where-Object { $_ -like "update:*" -or $_ -like "bounds:*" }).Count -eq 0) "Scheduled-capacity drift must fail before service mutation."
    $global:RuntimeConfigTestState.ScheduledActionMaxCapacity = $null
    $apiSourceContainerForDrift = @($global:RuntimeConfigTestState.TaskResponses[$apiSourceArn].taskDefinition.containerDefinitions | Where-Object name -CEQ "api")[0]
    $apiSourceContainerForDrift.environment += [pscustomobject]@{ name = "CLASSPILOT_PROTOCOL_V3_ENABLED"; value = "true" }
    Assert-Throws {
        Get-ValidatedProductionSnapshot -RepositoryRoot $repositoryRoot -ToolSha $toolSha `
            -AppSha $appSha -ImageDigest $digest `
            -ApiTaskDefinitionArn $apiSourceArn -WorkerTaskDefinitionArn $workerSourceArn `
            -RuntimeConfiguration $globalRuntime -SkipRepositoryCheck
    } "API/worker managed runtime drift must block activation."
    Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
    $global:RuntimeConfigTestState.ApiDesiredCount = 2
    Assert-Throws {
        Wait-ExactServicePairConvergence -ExpectedApiTaskDefinitionArn $apiSourceArn `
            -ExpectedWorkerTaskDefinitionArn $workerSourceArn -ExpectedApiDesiredCount 1 `
            -MaxAttempts 1 -IntervalSeconds 0
    } "Convergence must reject any API desired-count drift from the captured deployment posture."
    $global:RuntimeConfigTestState.ApiDesiredCount = 1
    $preFullTestProfile = [pscustomobject]@{
        schemaVersion = 1; mode = "test-school"; testSchoolId = $testSchoolId
        enabledCapabilities = @($script:ActivationOrder[0..($script:ActivationOrder.Count - 2)])
        turn = $turn
    }
    $preFullTestRuntime = ConvertTo-RuntimeConfiguration -Profile $preFullTestProfile
    Set-MockSourceRuntimeConfiguration -RuntimeConfiguration $preFullTestRuntime

    $testDeployProfilePath = Join-Path $testRoot "test-school-profile-$testSchoolId.json"
    Write-TestJson -Path $testDeployProfilePath -Value $fullTestProfile
    $testDeployPlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot -PrivateProfilePath $testDeployProfilePath `
        -PrivateTurnEvidencePath $evidencePath -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn $apiSourceArn -WorkerTaskDefinitionArn $workerSourceArn -Now $now -SkipRepositoryCheck
    $originalTestPlanText = [IO.File]::ReadAllText($testDeployPlanResult.PlanPath)
    $replacementTestPlan = $originalTestPlanText | ConvertFrom-Json -Depth 30
    $replacementTestPlan.appSha = "f" * 40
    $global:RuntimeConfigSnapshotSwapPath = [IO.Path]::GetFullPath($testDeployPlanResult.PlanPath)
    $global:RuntimeConfigSnapshotSwapText = $replacementTestPlan | ConvertTo-Json -Depth 30
    $global:SchoolPilotRuntimeConfigSnapshotReadHandler = {
        param([string]$SnapshotPath)
        if ($SnapshotPath -ceq $global:RuntimeConfigSnapshotSwapPath) {
            [IO.File]::WriteAllText($SnapshotPath, $global:RuntimeConfigSnapshotSwapText, [Text.UTF8Encoding]::new($false))
            $global:SchoolPilotRuntimeConfigSnapshotReadHandler = $null
        }
    }
    $testDeployPlan = Read-RuntimePlan -Path $testDeployPlanResult.PlanPath -ExpectedSha256 $testDeployPlanResult.PlanSha256
    Assert-Condition ([int]$testDeployPlan.schemaVersion -eq 2 -and
        [string]$testDeployPlan.toolSha -ceq $toolSha -and
        [string]$testDeployPlan.appSha -ceq $appSha -and $toolSha -cne $appSha) `
        "Runtime plans must independently bind the reviewed tool SHA and deployed image application SHA."
    Assert-Condition ([string]$testDeployPlan.appSha -ceq $appSha) "Plan verification must hash and parse the same captured bytes during path replacement."
    Assert-Condition ((Read-StrictJson -Path $testDeployPlanResult.PlanPath).appSha -ceq ("f" * 40)) "Plan replacement regression must actually exchange the path after the bounded read."
    [IO.File]::WriteAllText($testDeployPlanResult.PlanPath, $originalTestPlanText, [Text.UTF8Encoding]::new($false))
    $testDeployPlanText = [IO.File]::ReadAllText($testDeployPlanResult.PlanPath)
    Assert-Condition (-not $testDeployPlanText.Contains($testSchoolId) -and -not $testDeployPlanText.Contains("turn-a.school-pilot.net") -and -not $testDeployPlanText.Contains($turnSecretArn)) "Test-school plan evidence must redact school, TURN host, and secret identifiers."
    Assert-Condition (-not ([string]$testDeployPlanResult.PlanRelativePath).Contains($testSchoolId)) "Operator output must use an identifier-free plan-relative path."
    $testDeployPlanDocument = $testDeployPlanText | ConvertFrom-Json -Depth 30
    Assert-Condition ([string]$testDeployPlanDocument.profileFile -ceq "profile.json" -and [string]$testDeployPlanDocument.turnEvidenceFile -ceq "turn-evidence.json") "The durable plan must reference only neutral private snapshot names."
    $global:RuntimeConfigGitState.Sha = "c" * 40
    Assert-Throws {
        Invoke-RuntimeConfigApply -Plan $testDeployPlan -PlanSha256 $testDeployPlanResult.PlanSha256 -Now $now `
            -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0
    } "Apply must reject a repository that no longer matches the plan's reviewed runtime-tool SHA."
    $global:RuntimeConfigGitState.Sha = $toolSha
    $swappedSchoolId = "123e4567-e89b-42d3-a456-426614174111"
    $swappedTurnSecretArn = "arn:aws:secretsmanager:us-east-1:135775632425:secret:/schoolpilot/production/CLASSPILOT_TURN_REST_SECRET-ZzYy99"
    $replacementTestProfile = [pscustomobject]@{
        schemaVersion = 1; mode = "test-school"; testSchoolId = $swappedSchoolId
        enabledCapabilities = @($script:ActivationOrder)
        turn = [pscustomobject]@{ hosts = @("turn-a.school-pilot.net", "turn-b.school-pilot.net"); secretArn = $swappedTurnSecretArn }
    }
    Write-TestJson -Path $testDeployProfilePath -Value $replacementTestProfile
    $testDeployResult = Invoke-RuntimeConfigApply -Plan $testDeployPlan -PlanSha256 $testDeployPlanResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck
    Assert-Condition ($testDeployResult.status -ceq "applied" -and $testDeployResult.profileMode -ceq "test-school") "Full test-school apply must converge."
    Assert-Condition ([int]$testDeployResult.schemaVersion -eq 2 -and
        [string]$testDeployResult.toolSha -ceq $toolSha -and
        [string]$testDeployResult.appSha -ceq $appSha) `
        "Result evidence must preserve separate reviewed-tool and deployed-image identities."
    foreach ($candidateContract in @(
        [pscustomobject]@{ Arn = [string]$testDeployResult.candidateApiTaskDefinitionArn; Container = "api" },
        [pscustomobject]@{ Arn = [string]$testDeployResult.candidateWorkerTaskDefinitionArn; Container = "scheduler-worker" }
    )) {
        $candidate = $global:RuntimeConfigTestState.TaskResponses[$candidateContract.Arn].taskDefinition
        $candidateContainer = @($candidate.containerDefinitions | Where-Object name -CEQ $candidateContract.Container)[0]
        $rolloutJson = [string]@($candidateContainer.environment | Where-Object name -CEQ "CLASSPILOT_CAPABILITY_ROLLOUTS_JSON")[0].value
        $candidateRollouts = $rolloutJson | ConvertFrom-Json -Depth 10
        Assert-Condition (@($candidateRollouts.exactBindingAckV2.schoolIds).Count -eq 1 -and $candidateRollouts.exactBindingAckV2.schoolIds[0] -ceq $testSchoolId) "Both candidate tasks must contain the exact private test-school scope."
        Assert-Condition (-not $rolloutJson.Contains($swappedSchoolId)) "A swapped test-school profile must not alter the captured deployment authority."
        $candidateTurnSecret = @($candidateContainer.secrets | Where-Object name -CEQ "CLASSPILOT_TURN_REST_SECRET")
        Assert-Condition ($candidateTurnSecret.Count -eq 1 -and [string]$candidateTurnSecret[0].valueFrom -ceq $turnSecretArn) "A swapped TURN secret must not alter the captured deployment authority."
        Assert-Condition ($candidateRollouts.kioskLaunchTicketV1.mode -ceq "off") "Both candidate tasks must keep ticket V1 disabled."
    }
    Assert-Condition ((Read-StrictJson -Path $testDeployProfilePath).testSchoolId -ceq $swappedSchoolId) "Changing the source profile after planning must not alter the neutral private snapshot."
    Write-TestJson -Path $testDeployProfilePath -Value $fullTestProfile
    $testDeployResultText = [IO.File]::ReadAllText([string]$testDeployPlan.resultPath)
    $testDeployCheckpointText = [IO.File]::ReadAllText([string]$testDeployPlan.checkpointPath)
    Assert-Condition (-not $testDeployResultText.Contains($testSchoolId) -and -not $testDeployCheckpointText.Contains($testSchoolId)) "Test-school result and checkpoint evidence must not expose the school ID."
    [void](Invoke-RuntimeConfigRollback -Plan $testDeployPlan -PlanSha256 $testDeployPlanResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0)
    Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn

    Set-MockSourceRuntimeConfiguration -RuntimeConfiguration $globalRuntime
    $trackingPilotProfilePath = Join-Path $testRoot "tracking-window-pilot-profile.json"
    Write-TestJson -Path $trackingPilotProfilePath -Value $trackingPilotProfile
    $trackingPilotPlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot `
        -PrivateProfilePath $trackingPilotProfilePath `
        -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn $apiSourceArn -WorkerTaskDefinitionArn $workerSourceArn `
        -Now $now -SkipRepositoryCheck
    $trackingPilotPlan = Read-RuntimePlan -Path $trackingPilotPlanResult.PlanPath `
        -ExpectedSha256 $trackingPilotPlanResult.PlanSha256
    Assert-Condition ($trackingPilotPlan.profileMode -ceq "tracking-window-pilot" -and
        [int]$trackingPilotPlan.schoolScopeCount -eq 1 -and
        [int]$trackingPilotPlan.enabledCapabilityCount -eq 10 -and
        $null -eq $trackingPilotPlan.turnEvidenceFile -and
        $null -eq $trackingPilotPlan.turnEvidenceSha256 -and
        [string]$trackingPilotPlan.validationLevel -ceq "not_applicable") `
        "Tracking-window pilot plan must retain only identifier-free capability activation metadata."
    $trackingPilotPlanText = [IO.File]::ReadAllText($trackingPilotPlanResult.PlanPath)
    Assert-Condition (-not $trackingPilotPlanText.Contains($testSchoolId) -and
        -not $trackingPilotPlanText.Contains("turn-a.school-pilot.net") -and
        -not $trackingPilotPlanText.Contains($turnSecretArn)) `
        "Tracking-window pilot plan must not expose school or TURN authority."
    $trackingPilotApplyResult = Invoke-RuntimeConfigApply -Plan $trackingPilotPlan `
        -PlanSha256 $trackingPilotPlanResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck
    Assert-Condition ($trackingPilotApplyResult.status -ceq "applied" -and
        $trackingPilotApplyResult.profileMode -ceq "tracking-window-pilot" -and
        $trackingPilotApplyResult.scalingRestored) `
        "Tracking-window pilot apply must converge as one coherent service pair."
    $trackingPilotCandidateTasks = @(
        [pscustomobject]@{ Arn = [string]$trackingPilotApplyResult.candidateApiTaskDefinitionArn; Container = "api" },
        [pscustomobject]@{ Arn = [string]$trackingPilotApplyResult.candidateWorkerTaskDefinitionArn; Container = "scheduler-worker" }
    )
    foreach ($candidateContract in $trackingPilotCandidateTasks) {
        $candidate = $global:RuntimeConfigTestState.TaskResponses[$candidateContract.Arn].taskDefinition
        $candidateContainer = @($candidate.containerDefinitions | Where-Object name -CEQ $candidateContract.Container)[0]
        $candidateState = Get-RuntimeActivationState -Environment @($candidateContainer.environment)
        Assert-Condition ($candidateState.Mode -ceq "tracking-window-pilot" -and
            [string]$candidateState.SchoolId -ceq $testSchoolId) `
            "API and worker candidates must contain the same exact pilot scope."
        Assert-Condition ([string]$candidateContainer.image -ceq
            "135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api@$digest") `
            "Runtime-only pilot apply must preserve the immutable image digest."
        Assert-Condition (@($candidateContainer.environment | Where-Object {
            [string]$_.name -ceq "NODE_ENV" -and [string]$_.value -ceq "production"
        }).Count -eq 1) "Runtime-only pilot apply must preserve unrelated environment values."
        $candidateTurnSecret = @($candidateContainer.secrets | Where-Object name -CEQ "CLASSPILOT_TURN_REST_SECRET")
        Assert-Condition ($candidateTurnSecret.Count -eq 1 -and
            [string]$candidateTurnSecret[0].valueFrom -ceq $turnSecretArn) `
            "Runtime-only pilot apply must preserve the exact TURN secret authority."
        Assert-Condition ([string]@($candidateContainer.environment | Where-Object {
            [string]$_.name -ceq "CLASSPILOT_TURN_HOSTS"
        })[0].value -ceq "turn-a.school-pilot.net,turn-b.school-pilot.net" -and
            [string]@($candidateContainer.environment | Where-Object {
                [string]$_.name -ceq "CLASSPILOT_STUN_URLS"
            })[0].value -ceq "stun:turn-a.school-pilot.net:3478,stun:turn-b.school-pilot.net:3478") `
            "Runtime-only pilot apply must preserve the exact TURN and STUN host wiring."
    }
    $trackingPilotApiTask = $global:RuntimeConfigTestState.TaskResponses[[string]$trackingPilotApplyResult.candidateApiTaskDefinitionArn].taskDefinition
    $trackingPilotWorkerTask = $global:RuntimeConfigTestState.TaskResponses[[string]$trackingPilotApplyResult.candidateWorkerTaskDefinitionArn].taskDefinition
    Assert-Condition ((Get-ManagedRuntimeFingerprint -TaskDefinition $trackingPilotApiTask -ContainerName "api") -ceq
        (Get-ManagedRuntimeFingerprint -TaskDefinition $trackingPilotWorkerTask -ContainerName "scheduler-worker")) `
        "Tracking-window pilot API and worker runtime configuration must be identical."

    $studentGatePilotProfilePath = Join-Path $testRoot "student-gate-pilot-profile.json"
    Write-TestJson -Path $studentGatePilotProfilePath -Value ([ordered]@{
        schemaVersion = 3; mode = "student-gate-pilot"; pilotSchoolId = $testSchoolId
    })
    $studentGatePilotPlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot `
        -PrivateProfilePath $studentGatePilotProfilePath -EvidenceRoot $evidenceRoot `
        -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn ([string]$trackingPilotApplyResult.candidateApiTaskDefinitionArn) `
        -WorkerTaskDefinitionArn ([string]$trackingPilotApplyResult.candidateWorkerTaskDefinitionArn) `
        -Now $now -SkipRepositoryCheck
    $studentGatePilotPlan = Read-RuntimePlan -Path $studentGatePilotPlanResult.PlanPath `
        -ExpectedSha256 $studentGatePilotPlanResult.PlanSha256
    Assert-Condition ($studentGatePilotPlan.profileMode -ceq "student-gate-pilot" -and
        [int]$studentGatePilotPlan.schoolScopeCount -eq 1 -and
        [int]$studentGatePilotPlan.enabledCapabilityCount -eq 11 -and
        $null -eq $studentGatePilotPlan.turnEvidenceSha256) `
        "Student-gate pilot plan must resolve against and preserve the active full runtime profile."
    Assert-Condition (-not ([IO.File]::ReadAllText($studentGatePilotPlanResult.PlanPath)).Contains($testSchoolId)) `
        "Student-gate pilot plan must not expose its private school scope."
    $studentGatePilotApplyResult = Invoke-RuntimeConfigApply -Plan $studentGatePilotPlan `
        -PlanSha256 $studentGatePilotPlanResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck
    Assert-Condition ($studentGatePilotApplyResult.status -ceq "applied" -and
        $studentGatePilotApplyResult.profileMode -ceq "student-gate-pilot" -and
        $studentGatePilotApplyResult.scalingRestored) `
        "Student-gate pilot apply must converge as one coherent API/worker pair."
    foreach ($studentGateCandidateContract in @(
        [pscustomobject]@{ Arn = [string]$studentGatePilotApplyResult.candidateApiTaskDefinitionArn; Container = "api" },
        [pscustomobject]@{ Arn = [string]$studentGatePilotApplyResult.candidateWorkerTaskDefinitionArn; Container = "scheduler-worker" }
    )) {
        $studentGateCandidate = $global:RuntimeConfigTestState.TaskResponses[$studentGateCandidateContract.Arn].taskDefinition
        $studentGateCandidateContainer = @($studentGateCandidate.containerDefinitions | Where-Object name -CEQ $studentGateCandidateContract.Container)[0]
        $studentGateCandidateState = Get-RuntimeActivationState -Environment @($studentGateCandidateContainer.environment)
        Assert-Condition ($studentGateCandidateState.Mode -ceq "tracking-window-pilot" -and
            [string]$studentGateCandidateState.SchoolId -ceq $testSchoolId -and
            $studentGateCandidateState.StudentGateMode -ceq "pilot" -and
            [string]$studentGateCandidateState.StudentGateSchoolId -ceq $testSchoolId) `
            "Student-gate apply must preserve screenshot scope and apply only its own school pilot."
        Assert-Condition ([string]$studentGateCandidateContainer.image -ceq
            "135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api@$digest") `
            "Student-gate runtime-only apply must preserve the immutable image digest."
        Assert-Condition (@($studentGateCandidateContainer.environment | Where-Object {
            [string]$_.name -ceq "NODE_ENV" -and [string]$_.value -ceq "production"
        }).Count -eq 1) "Student-gate apply must preserve unrelated environment values."
        Assert-Condition (@($studentGateCandidateContainer.secrets | Where-Object {
            [string]$_.name -ceq "CLASSPILOT_TURN_REST_SECRET" -and [string]$_.valueFrom -ceq $turnSecretArn
        }).Count -eq 1) "Student-gate apply must preserve the exact TURN secret reference."
    }
    $studentGatePilotApiTask = $global:RuntimeConfigTestState.TaskResponses[
        [string]$studentGatePilotApplyResult.candidateApiTaskDefinitionArn
    ].taskDefinition
    $studentGatePilotRuntimeConfigurationSha256 = Get-ManagedRuntimeFingerprint `
        -TaskDefinition $studentGatePilotApiTask -ContainerName "api"
    $studentGatePilotEvidencePath = Join-Path $testRoot "student-gate-pilot-evidence.json"
    $studentGatePilotEvidence = [ordered]@{
        schemaVersion = 1
        validatedAt = $now.ToString("o")
        observedFrom = $now.AddMinutes(-60).ToString("o")
        observedThrough = $now.ToString("o")
        pilotSchoolId = $testSchoolId
        schoolPilotToolSha = $toolSha
        schoolPilotAppSha = $appSha
        schoolPilotImageDigest = $digest
        pilotApiTaskDefinitionArn = [string]$studentGatePilotApplyResult.candidateApiTaskDefinitionArn
        pilotWorkerTaskDefinitionArn = [string]$studentGatePilotApplyResult.candidateWorkerTaskDefinitionArn
        pilotRuntimeConfigurationSha256 = $studentGatePilotRuntimeConfigurationSha256
        checks = [ordered]@{
            fullSchoolActivityWindowObserved = $true
            managedCapabilityNegotiated = $true
            freshActiveStudentHidden = $true
            sameChromebookResumePassed = $true
            crossChromebookPlainNamePassed = $true
            correctPinTransferPassed = $true
            wrongPinPreservedSession = $true
            cancelSignOutHeartbeatRehides = $true
            concurrentTransferSingleWinner = $true
            runtimeAndRosterErrorsWithinBudget = $true
            noAuthorizationOrPrivacyDefects = $true
        }
    }
    Write-TestJson -Path $studentGatePilotEvidencePath -Value $studentGatePilotEvidence
    [void](Assert-StudentGatePilotEvidence `
        -EvidenceSnapshot (Read-StrictJsonSnapshot -Path $studentGatePilotEvidencePath) `
        -PilotSchoolId $testSchoolId -ToolSha $toolSha -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn ([string]$studentGatePilotApplyResult.candidateApiTaskDefinitionArn) `
        -WorkerTaskDefinitionArn ([string]$studentGatePilotApplyResult.candidateWorkerTaskDefinitionArn) `
        -RuntimeConfigurationSha256 $studentGatePilotRuntimeConfigurationSha256 -Now $now)
    $invalidStudentGatePilotEvidence = $studentGatePilotEvidence | ConvertTo-Json -Depth 30 |
        ConvertFrom-Json -Depth 30 -DateKind String
    $invalidStudentGatePilotEvidence.checks.wrongPinPreservedSession = $false
    Write-TestJson -Path $studentGatePilotEvidencePath -Value $invalidStudentGatePilotEvidence
    Assert-Throws {
        Assert-StudentGatePilotEvidence `
            -EvidenceSnapshot (Read-StrictJsonSnapshot -Path $studentGatePilotEvidencePath) `
            -PilotSchoolId $testSchoolId -ToolSha $toolSha -AppSha $appSha -ImageDigest $digest `
            -ApiTaskDefinitionArn ([string]$studentGatePilotApplyResult.candidateApiTaskDefinitionArn) `
            -WorkerTaskDefinitionArn ([string]$studentGatePilotApplyResult.candidateWorkerTaskDefinitionArn) `
            -RuntimeConfigurationSha256 $studentGatePilotRuntimeConfigurationSha256 -Now $now
    } "A failed wrong-PIN preservation check must block student-gate global activation."
    Write-TestJson -Path $studentGatePilotEvidencePath -Value $studentGatePilotEvidence

    $studentGateGlobalProfilePath = Join-Path $testRoot "student-gate-global-profile.json"
    Write-TestJson -Path $studentGateGlobalProfilePath -Value ([ordered]@{
        schemaVersion = 3; mode = "student-gate-global-on"
    })
    Assert-Throws {
        New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot `
            -PrivateProfilePath $studentGateGlobalProfilePath -EvidenceRoot $evidenceRoot `
            -AppSha $appSha -ImageDigest $digest `
            -ApiTaskDefinitionArn ([string]$studentGatePilotApplyResult.candidateApiTaskDefinitionArn) `
            -WorkerTaskDefinitionArn ([string]$studentGatePilotApplyResult.candidateWorkerTaskDefinitionArn) `
            -Now $now -SkipRepositoryCheck
    } "Student-gate global planning must fail without pilot smoke and soak evidence."
    $studentGateGlobalPlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot `
        -PrivateProfilePath $studentGateGlobalProfilePath `
        -PrivateStudentGatePilotEvidencePath $studentGatePilotEvidencePath `
        -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn ([string]$studentGatePilotApplyResult.candidateApiTaskDefinitionArn) `
        -WorkerTaskDefinitionArn ([string]$studentGatePilotApplyResult.candidateWorkerTaskDefinitionArn) `
        -Now $now -SkipRepositoryCheck
    $studentGateGlobalPlan = Read-RuntimePlan -Path $studentGateGlobalPlanResult.PlanPath `
        -ExpectedSha256 $studentGateGlobalPlanResult.PlanSha256
    Assert-Condition ($studentGateGlobalPlan.profileMode -ceq "student-gate-global-on" -and
        [string]$studentGateGlobalPlan.validationLevel -ceq "managed" -and
        [string]$studentGateGlobalPlan.managedValidation -ceq "passed" -and
        [string]$studentGateGlobalPlan.studentGatePilotEvidenceSha256 -ceq
            (Get-FileSha256 -Path $studentGatePilotEvidencePath)) `
        "Student-gate global planning must require exact managed pilot evidence."
    $studentGateGlobalApplyResult = Invoke-RuntimeConfigApply -Plan $studentGateGlobalPlan `
        -PlanSha256 $studentGateGlobalPlanResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck
    Assert-Condition ($studentGateGlobalApplyResult.status -ceq "applied" -and
        $studentGateGlobalApplyResult.profileMode -ceq "student-gate-global-on") `
        "Student-gate global apply must converge only after evidence revalidation."

    $studentGateOffProfilePath = Join-Path $testRoot "student-gate-off-profile.json"
    Write-TestJson -Path $studentGateOffProfilePath -Value ([ordered]@{
        schemaVersion = 3; mode = "student-gate-off"
    })
    $studentGateOffPlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot `
        -PrivateProfilePath $studentGateOffProfilePath -EvidenceRoot $evidenceRoot `
        -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn ([string]$studentGateGlobalApplyResult.candidateApiTaskDefinitionArn) `
        -WorkerTaskDefinitionArn ([string]$studentGateGlobalApplyResult.candidateWorkerTaskDefinitionArn) `
        -Now $now -SkipRepositoryCheck
    $studentGateOffPlan = Read-RuntimePlan -Path $studentGateOffPlanResult.PlanPath `
        -ExpectedSha256 $studentGateOffPlanResult.PlanSha256
    $studentGateOffApplyResult = Invoke-RuntimeConfigApply -Plan $studentGateOffPlan `
        -PlanSha256 $studentGateOffPlanResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck
    foreach ($studentGateOffCandidateContract in @(
        [pscustomobject]@{ Arn = [string]$studentGateOffApplyResult.candidateApiTaskDefinitionArn; Container = "api" },
        [pscustomobject]@{ Arn = [string]$studentGateOffApplyResult.candidateWorkerTaskDefinitionArn; Container = "scheduler-worker" }
    )) {
        $studentGateOffCandidate = $global:RuntimeConfigTestState.TaskResponses[$studentGateOffCandidateContract.Arn].taskDefinition
        $studentGateOffCandidateContainer = @($studentGateOffCandidate.containerDefinitions | Where-Object name -CEQ $studentGateOffCandidateContract.Container)[0]
        $studentGateOffCandidateState = Get-RuntimeActivationState -Environment @($studentGateOffCandidateContainer.environment)
        Assert-Condition ($studentGateOffCandidateState.Mode -ceq "tracking-window-pilot" -and
            [string]$studentGateOffCandidateState.SchoolId -ceq $testSchoolId -and
            $studentGateOffCandidateState.StudentGateMode -ceq "off") `
            "Student-gate-off must preserve the screenshot pilot and disable only auth-gate presence."
    }
    [void](Invoke-RuntimeConfigRollback -Plan $studentGateOffPlan `
        -PlanSha256 $studentGateOffPlanResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0)
    [void](Invoke-RuntimeConfigRollback -Plan $studentGateGlobalPlan `
        -PlanSha256 $studentGateGlobalPlanResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0)
    $studentGatePilotRollbackResult = Invoke-RuntimeConfigRollback -Plan $studentGatePilotPlan `
        -PlanSha256 $studentGatePilotPlanResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0
    Assert-Condition ($studentGatePilotRollbackResult.status -ceq "rolled_back" -and
        $global:RuntimeConfigTestState.ApiCurrentArn -ceq
            [string]$trackingPilotApplyResult.candidateApiTaskDefinitionArn -and
        $global:RuntimeConfigTestState.WorkerCurrentArn -ceq
            [string]$trackingPilotApplyResult.candidateWorkerTaskDefinitionArn) `
        "Student-gate pilot rollback must restore the exact prior tracking-window pair."

    $trackingGlobalProfilePath = Join-Path $testRoot "tracking-window-global-profile.json"
    Write-TestJson -Path $trackingGlobalProfilePath -Value $trackingGlobalProfile
    $trackingPilotRuntimeConfigurationSha256 = Get-ManagedRuntimeFingerprint `
        -TaskDefinition $trackingPilotApiTask -ContainerName "api"
    $trackingPilotEvidencePath = Join-Path $testRoot "tracking-window-pilot-evidence.json"
    $trackingPilotEvidence = [ordered]@{
        schemaVersion = 2
        validatedAt = $now.ToString("o")
        observedFrom = $now.AddMinutes(-60).ToString("o")
        observedThrough = $now.ToString("o")
        pilotSchoolId = $testSchoolId
        schoolPilotToolSha = $toolSha
        schoolPilotAppSha = $appSha
        schoolPilotImageDigest = $digest
        pilotApiTaskDefinitionArn = [string]$trackingPilotApplyResult.candidateApiTaskDefinitionArn
        pilotWorkerTaskDefinitionArn = [string]$trackingPilotApplyResult.candidateWorkerTaskDefinitionArn
        pilotRuntimeConfigurationSha256 = $trackingPilotRuntimeConfigurationSha256
        checks = [ordered]@{
            fullSchoolActivityWindowObserved = $true
            managedCapabilityNegotiated = $true
            teacherTabSwitchingPassed = $true
            adminObserveTabSwitchingPassed = $true
            newScreenshotWithinThirtySecondsPassed = $true
            authorizationPurgePassed = $true
            zeroScreenshotStoreErrors = $true
            screenshotLatencyWithinBudget = $true
            noAuthorizationOrPrivacyDefects = $true
        }
    }
    Write-TestJson -Path $trackingPilotEvidencePath -Value $trackingPilotEvidence
    $trackingPilotEvidenceSnapshot = Read-StrictJsonSnapshot -Path $trackingPilotEvidencePath
    [void](Assert-TrackingWindowPilotEvidence -EvidenceSnapshot $trackingPilotEvidenceSnapshot `
        -PilotSchoolId $testSchoolId -ToolSha $toolSha -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn ([string]$trackingPilotApplyResult.candidateApiTaskDefinitionArn) `
        -WorkerTaskDefinitionArn ([string]$trackingPilotApplyResult.candidateWorkerTaskDefinitionArn) `
        -RuntimeConfigurationSha256 $trackingPilotRuntimeConfigurationSha256 -Now $now)
    $fastPreviewPilotEvidencePath = Join-Path $testRoot "fast-preview-pilot-evidence.json"
    $fastPreviewPilotEvidence = [ordered]@{
        schemaVersion = 1
        validatedAt = $now.ToString("o")
        observedFrom = $now.AddMinutes(-60).ToString("o")
        observedThrough = $now.ToString("o")
        pilotSchoolId = $testSchoolId
        schoolPilotToolSha = $toolSha
        schoolPilotAppSha = $appSha
        schoolPilotImageDigest = $digest
        pilotApiTaskDefinitionArn = [string]$trackingPilotApplyResult.candidateApiTaskDefinitionArn
        pilotWorkerTaskDefinitionArn = [string]$trackingPilotApplyResult.candidateWorkerTaskDefinitionArn
        pilotRuntimeConfigurationSha256 = $trackingPilotRuntimeConfigurationSha256
        checks = [ordered]@{
            fullSchoolActivityWindowObserved = $true
            managedCapabilityNegotiated = $true
            exactObservationFiveSecondCadencePassed = $true
            backgroundThirtySecondCadencePassed = $true
            observationExpiryFallbackPassed = $true
            screenshotTtlOneHundredTwentySecondsPassed = $true
            fortyStudentLoadPassed = $true
            fiveHundredStudentLoadPassed = $true
            eightHundredStudentLoadPassed = $true
            wafHeadroomWithinBudget = $true
            screenshotIngressWithinBudget = $true
            apiWorkerStable = $true
            screenshotStoreLatencyWithinBudget = $true
            noAuthorizationOrPrivacyDefects = $true
        }
    }
    Write-TestJson -Path $fastPreviewPilotEvidencePath -Value $fastPreviewPilotEvidence
    [void](Assert-FastPreviewPilotEvidence `
        -EvidenceSnapshot (Read-StrictJsonSnapshot -Path $fastPreviewPilotEvidencePath) `
        -PilotSchoolId $testSchoolId -ToolSha $toolSha -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn ([string]$trackingPilotApplyResult.candidateApiTaskDefinitionArn) `
        -WorkerTaskDefinitionArn ([string]$trackingPilotApplyResult.candidateWorkerTaskDefinitionArn) `
        -RuntimeConfigurationSha256 $trackingPilotRuntimeConfigurationSha256 -Now $now)
    $invalidFastPreviewPilotEvidence = $fastPreviewPilotEvidence | ConvertTo-Json -Depth 30 |
        ConvertFrom-Json -Depth 30 -DateKind String
    $invalidFastPreviewPilotEvidence.checks.eightHundredStudentLoadPassed = $false
    Write-TestJson -Path $fastPreviewPilotEvidencePath -Value $invalidFastPreviewPilotEvidence
    Assert-Throws {
        Assert-FastPreviewPilotEvidence `
            -EvidenceSnapshot (Read-StrictJsonSnapshot -Path $fastPreviewPilotEvidencePath) `
            -PilotSchoolId $testSchoolId -ToolSha $toolSha -AppSha $appSha -ImageDigest $digest `
            -ApiTaskDefinitionArn ([string]$trackingPilotApplyResult.candidateApiTaskDefinitionArn) `
            -WorkerTaskDefinitionArn ([string]$trackingPilotApplyResult.candidateWorkerTaskDefinitionArn) `
            -RuntimeConfigurationSha256 $trackingPilotRuntimeConfigurationSha256 -Now $now
    } "Fast-preview global activation must reject a failed 800-device load gate."
    $invalidTrackingPilotEvidence = $trackingPilotEvidence | ConvertTo-Json -Depth 30 | ConvertFrom-Json -Depth 30 -DateKind String
    $invalidTrackingPilotEvidence.checks.teacherTabSwitchingPassed = $false
    Write-TestJson -Path $trackingPilotEvidencePath -Value $invalidTrackingPilotEvidence
    Assert-Throws {
        Assert-TrackingWindowPilotEvidence -EvidenceSnapshot (Read-StrictJsonSnapshot -Path $trackingPilotEvidencePath) `
            -PilotSchoolId $testSchoolId -ToolSha $toolSha -AppSha $appSha -ImageDigest $digest `
            -ApiTaskDefinitionArn ([string]$trackingPilotApplyResult.candidateApiTaskDefinitionArn) `
            -WorkerTaskDefinitionArn ([string]$trackingPilotApplyResult.candidateWorkerTaskDefinitionArn) `
            -RuntimeConfigurationSha256 $trackingPilotRuntimeConfigurationSha256 -Now $now
    } "A failed managed teacher tab-switch smoke must block tracking-window global activation."
    $invalidTrackingPilotEvidence = $trackingPilotEvidence | ConvertTo-Json -Depth 30 | ConvertFrom-Json -Depth 30 -DateKind String
    $invalidTrackingPilotEvidence.schoolPilotToolSha = "c" * 40
    Write-TestJson -Path $trackingPilotEvidencePath -Value $invalidTrackingPilotEvidence
    Assert-Throws {
        Assert-TrackingWindowPilotEvidence -EvidenceSnapshot (Read-StrictJsonSnapshot -Path $trackingPilotEvidencePath) `
            -PilotSchoolId $testSchoolId -ToolSha $toolSha -AppSha $appSha -ImageDigest $digest `
            -ApiTaskDefinitionArn ([string]$trackingPilotApplyResult.candidateApiTaskDefinitionArn) `
            -WorkerTaskDefinitionArn ([string]$trackingPilotApplyResult.candidateWorkerTaskDefinitionArn) `
            -RuntimeConfigurationSha256 $trackingPilotRuntimeConfigurationSha256 -Now $now
    } "Pilot evidence created by another reviewed runtime-tool revision must fail closed."
    $invalidTrackingPilotEvidence = $trackingPilotEvidence | ConvertTo-Json -Depth 30 | ConvertFrom-Json -Depth 30 -DateKind String
    $invalidTrackingPilotEvidence.pilotRuntimeConfigurationSha256 = "0" * 64
    Write-TestJson -Path $trackingPilotEvidencePath -Value $invalidTrackingPilotEvidence
    Assert-Throws {
        Assert-TrackingWindowPilotEvidence -EvidenceSnapshot (Read-StrictJsonSnapshot -Path $trackingPilotEvidencePath) `
            -PilotSchoolId $testSchoolId -ToolSha $toolSha -AppSha $appSha -ImageDigest $digest `
            -ApiTaskDefinitionArn ([string]$trackingPilotApplyResult.candidateApiTaskDefinitionArn) `
            -WorkerTaskDefinitionArn ([string]$trackingPilotApplyResult.candidateWorkerTaskDefinitionArn) `
            -RuntimeConfigurationSha256 $trackingPilotRuntimeConfigurationSha256 -Now $now
    } "Pilot evidence from another runtime configuration must fail closed."
    $invalidTrackingPilotEvidence = $trackingPilotEvidence | ConvertTo-Json -Depth 30 | ConvertFrom-Json -Depth 30 -DateKind String
    $invalidTrackingPilotEvidence.validatedAt = $now.AddHours(-2).AddSeconds(-1).ToString("o")
    $invalidTrackingPilotEvidence.observedFrom = $now.AddHours(-3).ToString("o")
    $invalidTrackingPilotEvidence.observedThrough = $now.AddHours(-2).AddSeconds(-1).ToString("o")
    Write-TestJson -Path $trackingPilotEvidencePath -Value $invalidTrackingPilotEvidence
    Assert-Throws {
        Assert-TrackingWindowPilotEvidence -EvidenceSnapshot (Read-StrictJsonSnapshot -Path $trackingPilotEvidencePath) `
            -PilotSchoolId $testSchoolId -ToolSha $toolSha -AppSha $appSha -ImageDigest $digest `
            -ApiTaskDefinitionArn ([string]$trackingPilotApplyResult.candidateApiTaskDefinitionArn) `
            -WorkerTaskDefinitionArn ([string]$trackingPilotApplyResult.candidateWorkerTaskDefinitionArn) `
            -RuntimeConfigurationSha256 $trackingPilotRuntimeConfigurationSha256 -Now $now
    } "Stale tracking-window pilot evidence must fail closed."
    $invalidTrackingPilotEvidence = $trackingPilotEvidence | ConvertTo-Json -Depth 30 | ConvertFrom-Json -Depth 30 -DateKind String
    $invalidTrackingPilotEvidence.observedThrough = $now.AddSeconds(1).ToString("o")
    Write-TestJson -Path $trackingPilotEvidencePath -Value $invalidTrackingPilotEvidence
    Assert-Throws {
        Assert-TrackingWindowPilotEvidence -EvidenceSnapshot (Read-StrictJsonSnapshot -Path $trackingPilotEvidencePath) `
            -PilotSchoolId $testSchoolId -ToolSha $toolSha -AppSha $appSha -ImageDigest $digest `
            -ApiTaskDefinitionArn ([string]$trackingPilotApplyResult.candidateApiTaskDefinitionArn) `
            -WorkerTaskDefinitionArn ([string]$trackingPilotApplyResult.candidateWorkerTaskDefinitionArn) `
            -RuntimeConfigurationSha256 $trackingPilotRuntimeConfigurationSha256 -Now $now
    } "Pilot evidence with an observation ending after validation must fail closed."
    Write-TestJson -Path $trackingPilotEvidencePath -Value $trackingPilotEvidence
    Assert-Throws {
        New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot `
            -PrivateProfilePath $trackingGlobalProfilePath -PrivateTurnEvidencePath $evidencePath `
            -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
            -ApiTaskDefinitionArn ([string]$trackingPilotApplyResult.candidateApiTaskDefinitionArn) `
            -WorkerTaskDefinitionArn ([string]$trackingPilotApplyResult.candidateWorkerTaskDefinitionArn) `
            -Now $now -SkipRepositoryCheck
    } "Tracking-window global planning must fail without pilot smoke and soak evidence."
    $trackingGlobalPlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot `
        -PrivateProfilePath $trackingGlobalProfilePath -PrivateTurnEvidencePath $evidencePath `
        -PrivateTrackingPilotEvidencePath $trackingPilotEvidencePath `
        -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn ([string]$trackingPilotApplyResult.candidateApiTaskDefinitionArn) `
        -WorkerTaskDefinitionArn ([string]$trackingPilotApplyResult.candidateWorkerTaskDefinitionArn) `
        -Now $now -SkipRepositoryCheck
    $trackingGlobalPlan = Read-RuntimePlan -Path $trackingGlobalPlanResult.PlanPath `
        -ExpectedSha256 $trackingGlobalPlanResult.PlanSha256
    Assert-Condition ($trackingGlobalPlan.profileMode -ceq "tracking-window-global-on" -and
        [int]$trackingGlobalPlan.schoolScopeCount -eq 0 -and
        [int]$trackingGlobalPlan.enabledCapabilityCount -eq 10 -and
        [string]$trackingGlobalPlan.validationLevel -ceq "managed" -and
        [string]$trackingGlobalPlan.managedValidation -ceq "passed" -and
        [string]$trackingGlobalPlan.trackingPilotEvidenceSha256 -ceq
            (Get-FileSha256 -Path $trackingPilotEvidencePath)) `
        "Tracking-window global plan must be admitted only after the live pilot state and retain managed validation authority."
    $trackingGlobalPlanText = [IO.File]::ReadAllText($trackingGlobalPlanResult.PlanPath)
    Assert-Condition (-not $trackingGlobalPlanText.Contains($testSchoolId) -and
        -not $trackingGlobalPlanText.Contains([string]$trackingPilotEvidence.pilotRuntimeConfigurationSha256)) `
        "Tracking-window global plan must retain only the pilot evidence hash, never its private contents."
    $capturedTrackingPilotEvidenceBytes = [IO.File]::ReadAllBytes([string]$trackingGlobalPlan.trackingPilotEvidencePath)
    $tamperedTrackingPilotEvidence = Read-StrictJson -Path ([string]$trackingGlobalPlan.trackingPilotEvidencePath)
    $tamperedTrackingPilotEvidence.checks.adminObserveTabSwitchingPassed = $false
    Write-TestJson -Path ([string]$trackingGlobalPlan.trackingPilotEvidencePath) -Value $tamperedTrackingPilotEvidence
    Assert-Throws {
        Invoke-RuntimeConfigApply -Plan $trackingGlobalPlan `
            -PlanSha256 $trackingGlobalPlanResult.PlanSha256 -Now $now `
            -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck
    } "Tracking-window global apply must reject pilot evidence changed after planning."
    [IO.File]::WriteAllBytes(
        [string]$trackingGlobalPlan.trackingPilotEvidencePath,
        $capturedTrackingPilotEvidenceBytes
    )
    Set-PrivatePathPermissions -Path ([string]$trackingGlobalPlan.trackingPilotEvidencePath)
    Assert-Throws {
        Invoke-RuntimeConfigApply -Plan $trackingGlobalPlan `
            -PlanSha256 $trackingGlobalPlanResult.PlanSha256 -Now $now.AddHours(2).AddMinutes(1) `
            -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck
    } "Tracking-window global apply must revalidate pilot evidence freshness."
    $trackingGlobalApplyResult = Invoke-RuntimeConfigApply -Plan $trackingGlobalPlan `
        -PlanSha256 $trackingGlobalPlanResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck
    Assert-Condition ($trackingGlobalApplyResult.status -ceq "applied" -and
        $trackingGlobalApplyResult.profileMode -ceq "tracking-window-global-on" -and
        [string]$trackingGlobalApplyResult.trackingPilotEvidenceSha256 -ceq
            [string]$trackingGlobalPlan.trackingPilotEvidenceSha256 -and
        $trackingGlobalApplyResult.scalingRestored) `
        "Tracking-window global apply must revalidate the hash-bound pilot evidence and converge."
    foreach ($globalCandidateContract in @(
        [pscustomobject]@{ Arn = [string]$trackingGlobalApplyResult.candidateApiTaskDefinitionArn; Container = "api" },
        [pscustomobject]@{ Arn = [string]$trackingGlobalApplyResult.candidateWorkerTaskDefinitionArn; Container = "scheduler-worker" }
    )) {
        $globalCandidate = $global:RuntimeConfigTestState.TaskResponses[$globalCandidateContract.Arn].taskDefinition
        $globalCandidateContainer = @($globalCandidate.containerDefinitions | Where-Object name -CEQ $globalCandidateContract.Container)[0]
        $globalCandidateState = Get-RuntimeActivationState -Environment @($globalCandidateContainer.environment)
        Assert-Condition ($globalCandidateState.Mode -ceq "tracking-window-global-on" -and
            $null -eq $globalCandidateState.SchoolId) `
            "Tracking-window global apply must remove pilot scope identically from API and worker."
    }

    $fastPreviewPilotProfilePath = Join-Path $testRoot "fast-preview-pilot-profile.json"
    Write-TestJson -Path $fastPreviewPilotProfilePath -Value ([ordered]@{
        schemaVersion = 5; mode = "fast-preview-pilot"; pilotSchoolId = $testSchoolId
    })
    $fastPreviewPilotPlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot `
        -PrivateProfilePath $fastPreviewPilotProfilePath -EvidenceRoot $evidenceRoot `
        -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn ([string]$trackingGlobalApplyResult.candidateApiTaskDefinitionArn) `
        -WorkerTaskDefinitionArn ([string]$trackingGlobalApplyResult.candidateWorkerTaskDefinitionArn) `
        -Now $now -SkipRepositoryCheck
    $fastPreviewPilotPlan = Read-RuntimePlan -Path $fastPreviewPilotPlanResult.PlanPath `
        -ExpectedSha256 $fastPreviewPilotPlanResult.PlanSha256
    Assert-Condition ($fastPreviewPilotPlan.profileMode -ceq "fast-preview-pilot" -and
        [int]$fastPreviewPilotPlan.schoolScopeCount -eq 1 -and
        [int]$fastPreviewPilotPlan.enabledCapabilityCount -eq 11 -and
        $null -eq $fastPreviewPilotPlan.fastPreviewPilotEvidenceSha256) `
        "Fast-preview pilot planning must preserve the active runtime while adding one school-scoped capability."
    Assert-Condition (-not ([IO.File]::ReadAllText($fastPreviewPilotPlanResult.PlanPath)).Contains($testSchoolId)) `
        "Fast-preview pilot plan evidence must not expose the private school scope."
    $fastPreviewPilotApplyResult = Invoke-RuntimeConfigApply -Plan $fastPreviewPilotPlan `
        -PlanSha256 $fastPreviewPilotPlanResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck
    Assert-Condition ($fastPreviewPilotApplyResult.status -ceq "applied" -and
        $fastPreviewPilotApplyResult.profileMode -ceq "fast-preview-pilot" -and
        $fastPreviewPilotApplyResult.scalingRestored) `
        "Fast-preview pilot apply must converge as one coherent API/worker pair."
    foreach ($fastPreviewPilotCandidateContract in @(
        [pscustomobject]@{ Arn = [string]$fastPreviewPilotApplyResult.candidateApiTaskDefinitionArn; Container = "api" },
        [pscustomobject]@{ Arn = [string]$fastPreviewPilotApplyResult.candidateWorkerTaskDefinitionArn; Container = "scheduler-worker" }
    )) {
        $fastPreviewPilotCandidate = $global:RuntimeConfigTestState.TaskResponses[$fastPreviewPilotCandidateContract.Arn].taskDefinition
        $fastPreviewPilotContainer = @($fastPreviewPilotCandidate.containerDefinitions | Where-Object name -CEQ $fastPreviewPilotCandidateContract.Container)[0]
        $fastPreviewPilotState = Get-RuntimeActivationState -Environment @($fastPreviewPilotContainer.environment)
        Assert-Condition ($fastPreviewPilotState.Mode -ceq "tracking-window-global-on" -and
            $fastPreviewPilotState.FastPreviewMode -ceq "pilot" -and
            [string]$fastPreviewPilotState.FastPreviewSchoolId -ceq $testSchoolId -and
            [string]$fastPreviewPilotContainer.image -ceq
                "135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api@$digest") `
            "Fast-preview pilot API and worker candidates must preserve the image and exact school scope."
    }
    $fastPreviewPilotApiTask = $global:RuntimeConfigTestState.TaskResponses[
        [string]$fastPreviewPilotApplyResult.candidateApiTaskDefinitionArn
    ].taskDefinition
    $fastPreviewPilotWorkerTask = $global:RuntimeConfigTestState.TaskResponses[
        [string]$fastPreviewPilotApplyResult.candidateWorkerTaskDefinitionArn
    ].taskDefinition
    $fastPreviewPilotRuntimeConfigurationSha256 = Get-ManagedRuntimeFingerprint `
        -TaskDefinition $fastPreviewPilotApiTask -ContainerName "api"
    Assert-Condition ($fastPreviewPilotRuntimeConfigurationSha256 -ceq
        (Get-ManagedRuntimeFingerprint -TaskDefinition $fastPreviewPilotWorkerTask -ContainerName "scheduler-worker")) `
        "Fast-preview pilot API and worker runtime configuration must be identical."

    $fastPreviewPilotEvidence = [ordered]@{
        schemaVersion = 1
        validatedAt = $now.ToString("o")
        observedFrom = $now.AddMinutes(-60).ToString("o")
        observedThrough = $now.ToString("o")
        pilotSchoolId = $testSchoolId
        schoolPilotToolSha = $toolSha
        schoolPilotAppSha = $appSha
        schoolPilotImageDigest = $digest
        pilotApiTaskDefinitionArn = [string]$fastPreviewPilotApplyResult.candidateApiTaskDefinitionArn
        pilotWorkerTaskDefinitionArn = [string]$fastPreviewPilotApplyResult.candidateWorkerTaskDefinitionArn
        pilotRuntimeConfigurationSha256 = $fastPreviewPilotRuntimeConfigurationSha256
        checks = [ordered]@{
            fullSchoolActivityWindowObserved = $true
            managedCapabilityNegotiated = $true
            exactObservationFiveSecondCadencePassed = $true
            backgroundThirtySecondCadencePassed = $true
            observationExpiryFallbackPassed = $true
            screenshotTtlOneHundredTwentySecondsPassed = $true
            fortyStudentLoadPassed = $true
            fiveHundredStudentLoadPassed = $true
            eightHundredStudentLoadPassed = $true
            wafHeadroomWithinBudget = $true
            screenshotIngressWithinBudget = $true
            apiWorkerStable = $true
            screenshotStoreLatencyWithinBudget = $true
            noAuthorizationOrPrivacyDefects = $true
        }
    }
    Write-TestJson -Path $fastPreviewPilotEvidencePath -Value $fastPreviewPilotEvidence
    $fastPreviewGlobalProfilePath = Join-Path $testRoot "fast-preview-global-profile.json"
    Write-TestJson -Path $fastPreviewGlobalProfilePath -Value ([ordered]@{
        schemaVersion = 5; mode = "fast-preview-global-on"
    })
    Assert-Throws {
        New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot `
            -PrivateProfilePath $fastPreviewGlobalProfilePath -EvidenceRoot $evidenceRoot `
            -AppSha $appSha -ImageDigest $digest `
            -ApiTaskDefinitionArn ([string]$fastPreviewPilotApplyResult.candidateApiTaskDefinitionArn) `
            -WorkerTaskDefinitionArn ([string]$fastPreviewPilotApplyResult.candidateWorkerTaskDefinitionArn) `
            -Now $now -SkipRepositoryCheck
    } "Fast-preview global planning must fail without exact pilot evidence."
    $fastPreviewGlobalPlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot `
        -PrivateProfilePath $fastPreviewGlobalProfilePath `
        -PrivateFastPreviewPilotEvidencePath $fastPreviewPilotEvidencePath `
        -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn ([string]$fastPreviewPilotApplyResult.candidateApiTaskDefinitionArn) `
        -WorkerTaskDefinitionArn ([string]$fastPreviewPilotApplyResult.candidateWorkerTaskDefinitionArn) `
        -Now $now -SkipRepositoryCheck
    $fastPreviewGlobalPlan = Read-RuntimePlan -Path $fastPreviewGlobalPlanResult.PlanPath `
        -ExpectedSha256 $fastPreviewGlobalPlanResult.PlanSha256
    Assert-Condition ($fastPreviewGlobalPlan.profileMode -ceq "fast-preview-global-on" -and
        [string]$fastPreviewGlobalPlan.validationLevel -ceq "managed" -and
        [string]$fastPreviewGlobalPlan.managedValidation -ceq "passed" -and
        [string]$fastPreviewGlobalPlan.fastPreviewPilotEvidenceSha256 -ceq
            (Get-FileSha256 -Path $fastPreviewPilotEvidencePath)) `
        "Fast-preview global planning must retain only exact managed pilot evidence authority."
    $fastPreviewGlobalApplyResult = Invoke-RuntimeConfigApply -Plan $fastPreviewGlobalPlan `
        -PlanSha256 $fastPreviewGlobalPlanResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck
    Assert-Condition ($fastPreviewGlobalApplyResult.status -ceq "applied" -and
        $fastPreviewGlobalApplyResult.profileMode -ceq "fast-preview-global-on" -and
        [string]$fastPreviewGlobalApplyResult.fastPreviewPilotEvidenceSha256 -ceq
            [string]$fastPreviewGlobalPlan.fastPreviewPilotEvidenceSha256) `
        "Fast-preview global apply must revalidate pilot evidence before convergence."
    foreach ($fastPreviewGlobalCandidateContract in @(
        [pscustomobject]@{ Arn = [string]$fastPreviewGlobalApplyResult.candidateApiTaskDefinitionArn; Container = "api" },
        [pscustomobject]@{ Arn = [string]$fastPreviewGlobalApplyResult.candidateWorkerTaskDefinitionArn; Container = "scheduler-worker" }
    )) {
        $fastPreviewGlobalCandidate = $global:RuntimeConfigTestState.TaskResponses[$fastPreviewGlobalCandidateContract.Arn].taskDefinition
        $fastPreviewGlobalContainer = @($fastPreviewGlobalCandidate.containerDefinitions | Where-Object name -CEQ $fastPreviewGlobalCandidateContract.Container)[0]
        $fastPreviewGlobalState = Get-RuntimeActivationState -Environment @($fastPreviewGlobalContainer.environment)
        Assert-Condition ($fastPreviewGlobalState.Mode -ceq "tracking-window-global-on" -and
            $fastPreviewGlobalState.FastPreviewMode -ceq "global-on") `
            "Fast-preview global apply must remove only its pilot scope on API and worker."
    }

    $fastPreviewOffProfilePath = Join-Path $testRoot "fast-preview-off-profile.json"
    Write-TestJson -Path $fastPreviewOffProfilePath -Value ([ordered]@{
        schemaVersion = 5; mode = "fast-preview-off"
    })
    $fastPreviewOffPlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot `
        -PrivateProfilePath $fastPreviewOffProfilePath -EvidenceRoot $evidenceRoot `
        -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn ([string]$fastPreviewGlobalApplyResult.candidateApiTaskDefinitionArn) `
        -WorkerTaskDefinitionArn ([string]$fastPreviewGlobalApplyResult.candidateWorkerTaskDefinitionArn) `
        -Now $now -SkipRepositoryCheck
    $fastPreviewOffPlan = Read-RuntimePlan -Path $fastPreviewOffPlanResult.PlanPath `
        -ExpectedSha256 $fastPreviewOffPlanResult.PlanSha256
    $fastPreviewOffApplyResult = Invoke-RuntimeConfigApply -Plan $fastPreviewOffPlan `
        -PlanSha256 $fastPreviewOffPlanResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck
    foreach ($fastPreviewOffCandidateContract in @(
        [pscustomobject]@{ Arn = [string]$fastPreviewOffApplyResult.candidateApiTaskDefinitionArn; Container = "api" },
        [pscustomobject]@{ Arn = [string]$fastPreviewOffApplyResult.candidateWorkerTaskDefinitionArn; Container = "scheduler-worker" }
    )) {
        $fastPreviewOffCandidate = $global:RuntimeConfigTestState.TaskResponses[$fastPreviewOffCandidateContract.Arn].taskDefinition
        $fastPreviewOffContainer = @($fastPreviewOffCandidate.containerDefinitions | Where-Object name -CEQ $fastPreviewOffCandidateContract.Container)[0]
        $fastPreviewOffState = Get-RuntimeActivationState -Environment @($fastPreviewOffContainer.environment)
        Assert-Condition ($fastPreviewOffState.Mode -ceq "tracking-window-global-on" -and
            $fastPreviewOffState.FastPreviewMode -ceq "off") `
            "Fast-preview rollback profile must preserve global tracking-window screenshots on API and worker."
    }
    [void](Invoke-RuntimeConfigRollback -Plan $fastPreviewOffPlan `
        -PlanSha256 $fastPreviewOffPlanResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0)
    [void](Invoke-RuntimeConfigRollback -Plan $fastPreviewGlobalPlan `
        -PlanSha256 $fastPreviewGlobalPlanResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0)
    $fastPreviewPilotRollbackResult = Invoke-RuntimeConfigRollback -Plan $fastPreviewPilotPlan `
        -PlanSha256 $fastPreviewPilotPlanResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0
    Assert-Condition ($fastPreviewPilotRollbackResult.status -ceq "rolled_back" -and
        $global:RuntimeConfigTestState.ApiCurrentArn -ceq
            [string]$trackingGlobalApplyResult.candidateApiTaskDefinitionArn -and
        $global:RuntimeConfigTestState.WorkerCurrentArn -ceq
            [string]$trackingGlobalApplyResult.candidateWorkerTaskDefinitionArn) `
        "Fast-preview rollback chain must restore the exact tracking-window global pair."

    $trackingGlobalRollbackResult = Invoke-RuntimeConfigRollback -Plan $trackingGlobalPlan `
        -PlanSha256 $trackingGlobalPlanResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0
    Assert-Condition ($trackingGlobalRollbackResult.status -ceq "rolled_back" -and
        $global:RuntimeConfigTestState.ApiCurrentArn -ceq
            [string]$trackingPilotApplyResult.candidateApiTaskDefinitionArn -and
        $global:RuntimeConfigTestState.WorkerCurrentArn -ceq
            [string]$trackingPilotApplyResult.candidateWorkerTaskDefinitionArn) `
        "Tracking-window global rollback must restore the exact school-scoped pilot pair."
    $trackingPilotResultText = [IO.File]::ReadAllText([string]$trackingPilotPlan.resultPath)
    $trackingPilotCheckpointText = [IO.File]::ReadAllText([string]$trackingPilotPlan.checkpointPath)
    Assert-Condition (-not $trackingPilotResultText.Contains($testSchoolId) -and
        -not $trackingPilotCheckpointText.Contains($testSchoolId)) `
        "Tracking-window pilot result and checkpoint evidence must remain identifier-free."
    $trackingPilotRollbackResult = Invoke-RuntimeConfigRollback -Plan $trackingPilotPlan `
        -PlanSha256 $trackingPilotPlanResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0
    Assert-Condition ($trackingPilotRollbackResult.status -ceq "rolled_back" -and
        $global:RuntimeConfigTestState.ApiCurrentArn -ceq $apiSourceArn -and
        $global:RuntimeConfigTestState.WorkerCurrentArn -ceq $workerSourceArn) `
        "Tracking-window pilot rollback must restore the exact pre-pilot API and worker revisions."
    foreach ($sourceContract in @(
        [pscustomobject]@{ Arn = $apiSourceArn; Container = "api" },
        [pscustomobject]@{ Arn = $workerSourceArn; Container = "scheduler-worker" }
    )) {
        $sourceTask = $global:RuntimeConfigTestState.TaskResponses[$sourceContract.Arn].taskDefinition
        $sourceContainer = @($sourceTask.containerDefinitions | Where-Object name -CEQ $sourceContract.Container)[0]
        $sourceState = Get-RuntimeActivationState -Environment @($sourceContainer.environment) -AllowBaseline
        Assert-Condition ($sourceState.Mode -ceq "global-on") `
            "Tracking-window pilot rollback must return both services to the explicit global-on tracking-off profile."
    }
    Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn

    $offProfilePath = Join-Path $testRoot "off-profile.json"
    Write-TestJson -Path $offProfilePath -Value ([pscustomobject]@{ schemaVersion = 1; mode = "off" })
    $global:RuntimeConfigTestState.TaskResponses[$apiSourceArn].tags = @()
    $global:RuntimeConfigTestState.TaskResponses[$workerSourceArn].tags = @()
    $global:RuntimeConfigTestState.ApiDesiredCount = 6
    $global:RuntimeConfigTestState.ScalingMin = 6
    $global:RuntimeConfigTestState.RejectEcrLookup = $true
    $global:RuntimeConfigGitState.Branch = "feature"
    1..3 | ForEach-Object {
        $global:RuntimeConfigClockQueue.Enqueue([DateTimeOffset]::Parse("2026-08-24T06:00:00-04:00"))
    }
    $offPlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot -PrivateProfilePath $offProfilePath `
        -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn $apiSourceArn -WorkerTaskDefinitionArn $workerSourceArn -Now $now
    $offPlan = Read-RuntimePlan -Path $offPlanResult.PlanPath -ExpectedSha256 $offPlanResult.PlanSha256
    $offResult = Invoke-RuntimeConfigApply -Plan $offPlan -PlanSha256 $offPlanResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0
    Assert-Condition ($offResult.status -ceq "applied" -and $offResult.profileMode -ceq "off") "Emergency off must work from the exact active pair even when main advanced and the arrival window is active."
    Assert-Condition (@($global:RuntimeConfigTestState.TaskResponses[[string]$offResult.candidateApiTaskDefinitionArn].tags).Count -eq 0 -and
        @($global:RuntimeConfigTestState.TaskResponses[[string]$offResult.candidateWorkerTaskDefinitionArn].tags).Count -eq 0) `
        "Runtime Apply must preserve untagged API and worker task definitions."
    Assert-Condition ($global:RuntimeConfigClockQueue.Count -eq 0) "Emergency off must use the live clock to restore the scheduled arrival minimum without applying the enablement window gate."
    Assert-Condition ($global:RuntimeConfigTestState.ApiMinimumHealthyPercent -eq 100 -and $global:RuntimeConfigTestState.ApiMaximumPercent -eq 200) "Emergency off must restore original API deployment bounds."
    Assert-Condition ($global:RuntimeConfigTestState.WorkerMinimumHealthyPercent -eq 100 -and $global:RuntimeConfigTestState.WorkerMaximumPercent -eq 200) "Emergency off must restore original worker deployment bounds."
    $offEvents = @($global:RuntimeConfigTestState.Events)
    Assert-Condition ($offEvents -contains "bounds:api:83-100" -and $offEvents -contains "bounds:worker:0-100") "Emergency off must use no-growth one-for-one rolling bounds."
    $offCandidate = $global:RuntimeConfigTestState.TaskResponses[[string]$offResult.candidateApiTaskDefinitionArn].taskDefinition
    $offCandidateContainer = @($offCandidate.containerDefinitions | Where-Object name -CEQ "api")[0]
    Assert-Condition ([string]@($offCandidateContainer.environment | Where-Object name -CEQ "CLASSPILOT_PROTOCOL_V3_ENABLED")[0].value -ceq "false") "Emergency off candidate must disable protocol-v3 acceptance."
    Assert-Condition ([string]@($offCandidateContainer.environment | Where-Object name -CEQ "CLASSPILOT_CAP_KIOSK_LAUNCH_TICKET_V1")[0].value -ceq "false") "Emergency off must keep ticket V1 disabled."
    $global:RuntimeConfigClockQueue.Clear()
    $global:RuntimeConfigGitState.Branch = "main"
    foreach ($containmentCase in @(
        [pscustomobject]@{ Desired = 1; Minimum = 100; Maximum = 200; MinimumTasks = 1; MaximumTasks = 2 },
        [pscustomobject]@{ Desired = 2; Minimum = 50; Maximum = 100; MinimumTasks = 1; MaximumTasks = 2 },
        [pscustomobject]@{ Desired = 3; Minimum = 66; Maximum = 100; MinimumTasks = 2; MaximumTasks = 3 },
        [pscustomobject]@{ Desired = 4; Minimum = 75; Maximum = 100; MinimumTasks = 3; MaximumTasks = 4 },
        [pscustomobject]@{ Desired = 5; Minimum = 80; Maximum = 100; MinimumTasks = 4; MaximumTasks = 5 },
        [pscustomobject]@{ Desired = 6; Minimum = 83; Maximum = 100; MinimumTasks = 5; MaximumTasks = 6 }
    )) {
        Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
        $global:RuntimeConfigTestState.ApiDesiredCount = $containmentCase.Desired
        Acquire-OperationLock -RunId ([Guid]::NewGuid().ToString("N")) -PlanSha256 ("c" * 64)
        Start-OperationMutationWindow
        Acquire-OffContainmentDeploymentBounds -Snapshot (Get-ServiceSnapshot)
        Assert-Condition ($global:RuntimeConfigTestState.ApiMinimumHealthyPercent -eq $containmentCase.Minimum -and
            $global:RuntimeConfigTestState.ApiMaximumPercent -eq $containmentCase.Maximum) "Containment bounds must match the reviewed desired=$($containmentCase.Desired) policy."
        $minimumTasks = [int][Math]::Ceiling(($containmentCase.Desired * $global:RuntimeConfigTestState.ApiMinimumHealthyPercent) / 100.0)
        $maximumTasks = [int][Math]::Floor(($containmentCase.Desired * $global:RuntimeConfigTestState.ApiMaximumPercent) / 100.0)
        Assert-Condition ($minimumTasks -eq $containmentCase.MinimumTasks -and $maximumTasks -eq $containmentCase.MaximumTasks) "Mocked ECS rounding must retain the reviewed availability/capacity envelope for desired=$($containmentCase.Desired)."
        Assert-Condition ($global:RuntimeConfigTestState.WorkerMinimumHealthyPercent -eq 0 -and $global:RuntimeConfigTestState.WorkerMaximumPercent -eq 100) "Worker containment must remain stop-first without a surge slot."
        Restore-OffContainmentDeploymentBounds
        Assert-Condition ($global:RuntimeConfigTestState.ApiMinimumHealthyPercent -eq 100 -and $global:RuntimeConfigTestState.ApiMaximumPercent -eq 200 -and
            $global:RuntimeConfigTestState.WorkerMinimumHealthyPercent -eq 100 -and $global:RuntimeConfigTestState.WorkerMaximumPercent -eq 200) "Containment must restore the exact reviewed deployment configuration."
        Complete-OperationMutationWindow
        Release-OperationLock
    }

    Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
    foreach ($role in @("Api", "Worker")) {
        $configurationProperty = $role + "DeploymentConfiguration"
        $configuration = $global:RuntimeConfigTestState[$configurationProperty] | ConvertTo-Json -Depth 20 | ConvertFrom-Json -Depth 20
        $configuration | Add-Member -NotePropertyName alarms -NotePropertyValue ([pscustomobject]@{
            alarmNames = @("schoolpilot-reviewed-deployment-alarm"); enable = $false; rollback = $true
        })
        $global:RuntimeConfigTestState[$configurationProperty] = $configuration
    }
    $optionalBefore = Get-ServiceSnapshot
    $optionalBeforeSha = [pscustomobject]@{
        Api = Get-ServiceDeploymentConfigurationSha256 -Service $optionalBefore.Api
        Worker = Get-ServiceDeploymentConfigurationSha256 -Service $optionalBefore.Worker
    }
    Acquire-OperationLock -RunId "optional-config-preservation" -PlanSha256 ("3" * 64)
    Start-OperationMutationWindow
    Acquire-OffContainmentDeploymentBounds -Snapshot $optionalBefore
    Restore-OffContainmentDeploymentBounds
    Complete-OperationMutationWindow
    Release-OperationLock
    $optionalAfter = Get-ServiceSnapshot
    Assert-Condition ((Get-ServiceDeploymentConfigurationSha256 -Service $optionalAfter.Api) -ceq $optionalBeforeSha.Api -and
        (Get-ServiceDeploymentConfigurationSha256 -Service $optionalAfter.Worker) -ceq $optionalBeforeSha.Worker) "Emergency off must restore optional reviewed ECS deployment fields byte-for-byte after changing only temporary bounds."

    Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
    $global:RuntimeConfigTestState.SimulateScheduledDesiredChangeDuringConvergence = $true
    $global:RuntimeConfigTestState.RejectEcrLookup = $true
    $scheduledCrossingPlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot -PrivateProfilePath $offProfilePath `
        -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn $apiSourceArn -WorkerTaskDefinitionArn $workerSourceArn -Now $now
    $scheduledCrossingPlan = Read-RuntimePlan -Path $scheduledCrossingPlanResult.PlanPath -ExpectedSha256 $scheduledCrossingPlanResult.PlanSha256
    1..3 | ForEach-Object {
        $global:RuntimeConfigClockQueue.Enqueue([DateTimeOffset]::Parse("2026-08-24T05:46:00-04:00"))
    }
    $scheduledCrossingResult = Invoke-RuntimeConfigApply -Plan $scheduledCrossingPlan `
        -PlanSha256 $scheduledCrossingPlanResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 3 -ConvergenceIntervalSeconds 0
    Assert-Condition ($scheduledCrossingResult.status -ceq "applied" -and
        -not $global:RuntimeConfigTestState.ScheduledDesiredChangeConsumed) "The all-scaling hold must block a scheduled desired-count change during containment."
    Assert-Condition ($global:RuntimeConfigTestState.ScalingMin -eq 6 -and
        -not $global:RuntimeConfigTestState.Scheduled) "Scaling release after a 05:45 crossing must reconcile the live six-task arrival minimum."

    Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
    $global:RuntimeConfigTestState.DelayedScheduledChangeTrigger = "source-recheck"
    $global:RuntimeConfigTestState.RejectEcrLookup = $true
    $delayedSourcePlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot -PrivateProfilePath $offProfilePath `
        -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn $apiSourceArn -WorkerTaskDefinitionArn $workerSourceArn -Now $now
    $delayedSourcePlan = Read-RuntimePlan -Path $delayedSourcePlanResult.PlanPath -ExpectedSha256 $delayedSourcePlanResult.PlanSha256
    Assert-Throws {
        Invoke-RuntimeConfigApply -Plan $delayedSourcePlan -PlanSha256 $delayedSourcePlanResult.PlanSha256 `
            -Now $now -ConvergenceAttempts 3 -ConvergenceIntervalSeconds 0
    } "A delayed scheduled action after hold acquisition must fail before service mutation."
    $delayedSourceResult = Read-StrictJson -Path ([string]$delayedSourcePlan.resultPath)
    Assert-Condition ($global:RuntimeConfigTestState.DelayedScheduledChangeConsumed -and
        @($global:RuntimeConfigTestState.Events | Where-Object { $_ -like "update:*" }).Count -eq 0) "Post-hold desired drift must produce zero task-definition updates."
    Assert-Condition ($delayedSourceResult.status -ceq "apply_failed_no_service_mutation" -and
        $delayedSourceResult.scalingRestored) "Post-hold desired drift must restore scaling and record a no-mutation failure."

    Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
    $global:RuntimeConfigTestState.DelayedScheduledChangeTrigger = "convergence"
    $global:RuntimeConfigTestState.RejectEcrLookup = $true
    $delayedConvergencePlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot -PrivateProfilePath $offProfilePath `
        -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn $apiSourceArn -WorkerTaskDefinitionArn $workerSourceArn -Now $now
    $delayedConvergencePlan = Read-RuntimePlan -Path $delayedConvergencePlanResult.PlanPath -ExpectedSha256 $delayedConvergencePlanResult.PlanSha256
    Assert-Throws {
        Invoke-RuntimeConfigApply -Plan $delayedConvergencePlan -PlanSha256 $delayedConvergencePlanResult.PlanSha256 `
            -Now $now -ConvergenceAttempts 3 -ConvergenceIntervalSeconds 0
    } "A delayed desired-count change during convergence must enter bounded source-pair recovery."
    $delayedConvergenceResult = Read-StrictJson -Path ([string]$delayedConvergencePlan.resultPath)
    $delayedEvents = @($global:RuntimeConfigTestState.Events)
    Assert-Condition ($delayedConvergenceResult.status -ceq "apply_failed_rolled_back" -and
        $delayedConvergenceResult.scalingRestored) "Delayed convergence drift must recover one coherent source pair."
    Assert-Condition ([Array]::LastIndexOf($delayedEvents, "bounds:api:83-100") -lt
        [Array]::IndexOf($delayedEvents, "update:api:source") -and
        [Array]::LastIndexOf($delayedEvents, "bounds:api:83-100") -ge 0) "Recovery must derive no-growth bounds from the current frozen desired count of six."

    Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
    $global:RuntimeConfigTestState.RejectEcrLookup = $true
    $boundaryPlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot -PrivateProfilePath $offProfilePath `
        -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn $apiSourceArn -WorkerTaskDefinitionArn $workerSourceArn -Now $now
    $boundaryPlan = Read-RuntimePlan -Path $boundaryPlanResult.PlanPath -ExpectedSha256 $boundaryPlanResult.PlanSha256
    foreach ($clockValue in @(
        "2026-08-24T05:44:59-04:00", "2026-08-24T05:44:59-04:00", "2026-08-24T05:45:00-04:00",
        "2026-08-24T05:45:00-04:00", "2026-08-24T05:45:00-04:00", "2026-08-24T05:45:00-04:00"
    )) {
        $global:RuntimeConfigClockQueue.Enqueue([DateTimeOffset]::Parse($clockValue))
    }
    $boundaryResult = Invoke-RuntimeConfigApply -Plan $boundaryPlan -PlanSha256 $boundaryPlanResult.PlanSha256 `
        -Now $now -ConvergenceAttempts 3 -ConvergenceIntervalSeconds 0
    Assert-Condition ($boundaryResult.status -ceq "applied" -and
        $global:RuntimeConfigTestState.ScalingMin -eq 6 -and -not $global:RuntimeConfigTestState.Scheduled) "Scaling release must retry across 05:45 and finish at the current scheduled minimum."
    Assert-Condition (@($global:RuntimeConfigTestState.Events | Where-Object { $_ -ceq "scaling:hold" }).Count -ge 3) "A restore-time schedule boundary must re-establish the hold before retrying release."

    Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
    $global:RuntimeConfigTestState.ApiDesiredCount = 6
    $global:RuntimeConfigTestState.ScalingMin = 6
    $global:RuntimeConfigTestState.RejectEcrLookup = $true
    $scaleDownBoundaryPlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot -PrivateProfilePath $offProfilePath `
        -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn $apiSourceArn -WorkerTaskDefinitionArn $workerSourceArn -Now $now
    $scaleDownBoundaryPlan = Read-RuntimePlan -Path $scaleDownBoundaryPlanResult.PlanPath -ExpectedSha256 $scaleDownBoundaryPlanResult.PlanSha256
    foreach ($clockValue in @(
        "2026-08-24T09:59:59-04:00", "2026-08-24T09:59:59-04:00", "2026-08-24T10:00:00-04:00",
        "2026-08-24T10:00:00-04:00", "2026-08-24T10:00:00-04:00", "2026-08-24T10:00:00-04:00"
    )) {
        $global:RuntimeConfigClockQueue.Enqueue([DateTimeOffset]::Parse($clockValue))
    }
    $scaleDownBoundaryResult = Invoke-RuntimeConfigApply -Plan $scaleDownBoundaryPlan `
        -PlanSha256 $scaleDownBoundaryPlanResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 3 -ConvergenceIntervalSeconds 0
    Assert-Condition ($scaleDownBoundaryResult.status -ceq "applied" -and
        $global:RuntimeConfigTestState.ScalingMin -eq 1 -and -not $global:RuntimeConfigTestState.Scheduled) "Scaling release must retry across 10:00 and finish at the current ordinary minimum."

    Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
    $global:RuntimeConfigTestState.ApiDesiredCount = 2
    $global:RuntimeConfigTestState.FailApiBoundsRestoreOnce = $true
    $global:RuntimeConfigTestState.RejectEcrLookup = $true
    $postConvergencePlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot -PrivateProfilePath $offProfilePath `
        -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn $apiSourceArn -WorkerTaskDefinitionArn $workerSourceArn -Now $now
    $postConvergencePlan = Read-RuntimePlan -Path $postConvergencePlanResult.PlanPath -ExpectedSha256 $postConvergencePlanResult.PlanSha256
    $postConvergenceResult = Invoke-RuntimeConfigApply -Plan $postConvergencePlan `
        -PlanSha256 $postConvergencePlanResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 3 -ConvergenceIntervalSeconds 0
    Assert-Condition ($postConvergenceResult.status -ceq "applied" -and
        $global:RuntimeConfigTestState.ApiBoundsRestoreFailureConsumed) "A transient post-convergence bounds failure must recover the coherent capabilities-off pair."
    Assert-Condition (@($global:RuntimeConfigTestState.Events | Where-Object { $_ -like "update:*:source" }).Count -eq 0) "Post-convergence containment recovery must never reactivate the source capability pair."
    Assert-Condition ($global:RuntimeConfigTestState.ApiCurrentArn -ceq $postConvergenceResult.candidateApiTaskDefinitionArn -and
        $global:RuntimeConfigTestState.WorkerCurrentArn -ceq $postConvergenceResult.candidateWorkerTaskDefinitionArn) "Recovered containment must retain both exact candidate revisions."

    Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
    $global:RuntimeConfigTestState.ApiDesiredCount = 6
    $global:RuntimeConfigTestState.FailWorkerCandidateOnce = $true
    $global:RuntimeConfigTestState.RejectEcrLookup = $true
    $preConvergencePlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot -PrivateProfilePath $offProfilePath `
        -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn $apiSourceArn -WorkerTaskDefinitionArn $workerSourceArn -Now $now
    $preConvergencePlan = Read-RuntimePlan -Path $preConvergencePlanResult.PlanPath -ExpectedSha256 $preConvergencePlanResult.PlanSha256
    Assert-Throws {
        Invoke-RuntimeConfigApply -Plan $preConvergencePlan -PlanSha256 $preConvergencePlanResult.PlanSha256 `
            -Now $now -ConvergenceAttempts 3 -ConvergenceIntervalSeconds 0
    } "A pre-convergence worker failure must fail after bounded source-pair recovery."
    $preConvergenceResult = Read-StrictJson -Path ([string]$preConvergencePlan.resultPath)
    $preConvergenceEvents = @($global:RuntimeConfigTestState.Events)
    $lastSafeWorkerBounds = [Array]::LastIndexOf($preConvergenceEvents, "bounds:worker:0-100")
    $firstSourceUpdate = [Array]::IndexOf($preConvergenceEvents, "update:api:source")
    Assert-Condition ($preConvergenceResult.status -ceq "apply_failed_rolled_back" -and $preConvergenceResult.scalingRestored) "Pre-convergence containment failure must record a coherent source-pair recovery."
    Assert-Condition ($lastSafeWorkerBounds -ge 0 -and $lastSafeWorkerBounds -lt $firstSourceUpdate) "Source-pair recovery must first re-prove the complete no-growth containment configuration."

    foreach ($protectedDesiredCount in 1..6) {
        Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
        Set-MockSourceRuntimeConfiguration -RuntimeConfiguration $fullTestRuntime
        $global:RuntimeConfigTestState.ApiDesiredCount = $protectedDesiredCount
        $protectedCountPlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot -PrivateProfilePath $profilePath `
            -PrivateTurnEvidencePath $evidencePath -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
            -ApiTaskDefinitionArn $apiSourceArn -WorkerTaskDefinitionArn $workerSourceArn -Now $now -SkipRepositoryCheck `
            -ConfirmProductionMutation -ConfirmProtectedWindowProductionMutation
        $protectedCountPlan = Read-RuntimePlan -Path $protectedCountPlanResult.PlanPath `
            -ExpectedSha256 $protectedCountPlanResult.PlanSha256
        Assert-Condition ($protectedCountPlan.protectedWindowProductionMutation -eq $true -and
            $protectedCountPlan.validationLevel -ceq "managed") `
            "Protected strict planning must admit exact stable API desired count $protectedDesiredCount."
    }
    Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
    Set-MockSourceRuntimeConfiguration -RuntimeConfiguration $fullTestRuntime
    $global:RuntimeConfigTestState.ApiDesiredCount = 3
    Assert-Throws {
        New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot -PrivateProfilePath $profilePath `
            -PrivateTurnEvidencePath $evidencePath -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
            -ApiTaskDefinitionArn $apiSourceArn -WorkerTaskDefinitionArn $workerSourceArn -Now $now -SkipRepositoryCheck
    } "Ordinary strict planning must retain the two-task API ceiling."

    Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
    Set-MockSourceRuntimeConfiguration -RuntimeConfiguration $firstCapabilityRuntime
    $global:RuntimeConfigTestState.ApiDesiredCount = 6
    $global:RuntimeConfigTestState.ScalingMin = 6
    $waiverPlanArguments = @{
        RepositoryRoot = $repositoryRoot
        PrivateProfilePath = $profilePath
        PrivateTurnEvidencePath = $waiverTurnEvidencePath
        PrivateSyntheticValidationPath = $syntheticValidationPath
        PrivateManagedTestWaiverPath = $managedTestWaiverPath
        EvidenceRoot = $evidenceRoot
        AppSha = $appSha
        ImageDigest = $digest
        ApiTaskDefinitionArn = $apiSourceArn
        WorkerTaskDefinitionArn = $workerSourceArn
        Now = $now
        SkipRepositoryCheck = $true
    }
    Assert-Throws {
        New-RuntimeConfigPlan @waiverPlanArguments `
            -ConfirmSyntheticOnlyGlobalActivation -ConfirmProtectedWindowProductionMutation
    } "Synthetic-only plan admission must require the general production mutation confirmation."
    Assert-Throws {
        New-RuntimeConfigPlan @waiverPlanArguments `
            -ConfirmProductionMutation -ConfirmProtectedWindowProductionMutation
    } "Synthetic-only plan admission must require its exact waiver confirmation."
    Assert-Throws {
        New-RuntimeConfigPlan @waiverPlanArguments `
            -ConfirmProductionMutation -ConfirmSyntheticOnlyGlobalActivation
    } "Synthetic-only plan admission must require protected-window production confirmation."
    Assert-Throws {
        New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot -PrivateProfilePath $profilePath `
            -PrivateTurnEvidencePath $waiverTurnEvidencePath -PrivateSyntheticValidationPath $syntheticValidationPath `
            -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest -ApiTaskDefinitionArn $apiSourceArn `
            -WorkerTaskDefinitionArn $workerSourceArn -Now $now -SkipRepositoryCheck `
            -ConfirmProductionMutation -ConfirmSyntheticOnlyGlobalActivation -ConfirmProtectedWindowProductionMutation
    } "Synthetic-only plan admission must reject incomplete waiver evidence paths."

    $waiverPlanResult = New-RuntimeConfigPlan @waiverPlanArguments `
        -ConfirmProductionMutation -ConfirmSyntheticOnlyGlobalActivation -ConfirmProtectedWindowProductionMutation
    $waiverPlan = Read-RuntimePlan -Path $waiverPlanResult.PlanPath -ExpectedSha256 $waiverPlanResult.PlanSha256
    Assert-Condition ($waiverPlan.validationLevel -ceq "synthetic_only" -and
        $waiverPlan.managedValidation -ceq "waived_not_passed" -and
        $waiverPlan.protectedWindowProductionMutation -eq $true) `
        "Waiver plan must record its exact synthetic-only authority."
    Assert-Condition ([string]$waiverPlan.syntheticValidationSha256 -ceq [string]$syntheticValidationSnapshot.Sha256 -and
        [string]$waiverPlan.managedTestWaiverSha256 -ceq (Get-FileSha256 -Path $managedTestWaiverPath)) `
        "Waiver plan must bind both exact private evidence hashes."
    $waiverPlanText = [IO.File]::ReadAllText($waiverPlanResult.PlanPath)
    Assert-Condition (-not $waiverPlanText.Contains("bzinkan@school-pilot.net") -and
        -not $waiverPlanText.Contains([string]$managedTestWaiver.reason) -and
        -not $waiverPlanText.Contains($testSchoolId)) `
        "Waiver plan must not expose private evidence contents or school scope."
    Assert-Throws {
        Invoke-RuntimeConfigApply -Plan $waiverPlan -PlanSha256 $waiverPlanResult.PlanSha256 -Now $now `
            -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck `
            -ConfirmSyntheticOnlyGlobalActivation -ConfirmProtectedWindowProductionMutation
    } "Synthetic-only apply must re-require the general production mutation confirmation."
    Assert-Throws {
        Invoke-RuntimeConfigApply -Plan $waiverPlan -PlanSha256 $waiverPlanResult.PlanSha256 -Now $now `
            -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck `
            -ConfirmProductionMutation -ConfirmProtectedWindowProductionMutation
    } "Synthetic-only apply must re-require the exact waiver confirmation."
    $eventsBeforeStaleWaiverApply = @($global:RuntimeConfigTestState.Events).Count
    Assert-Throws {
        Invoke-RuntimeConfigApply -Plan $waiverPlan -PlanSha256 $waiverPlanResult.PlanSha256 `
            -Now $now.AddHours(2).AddMinutes(1) -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 `
            -SkipRepositoryCheck -ConfirmProductionMutation -ConfirmSyntheticOnlyGlobalActivation `
            -ConfirmProtectedWindowProductionMutation
    } "Apply must revalidate waiver evidence freshness against its current clock."
    Assert-Condition (@($global:RuntimeConfigTestState.Events).Count -eq $eventsBeforeStaleWaiverApply) `
        "Stale waiver evidence must fail before any production lease or service action."

    $capturedSyntheticBytes = [IO.File]::ReadAllBytes([string]$waiverPlan.syntheticValidationPath)
    $tamperedSyntheticCopy = Read-StrictJson -Path ([string]$waiverPlan.syntheticValidationPath)
    $tamperedSyntheticCopy.checks.protocol2CompatibilityPassed = $false
    Write-TestJson -Path ([string]$waiverPlan.syntheticValidationPath) -Value $tamperedSyntheticCopy
    Assert-Throws {
        Invoke-RuntimeConfigApply -Plan $waiverPlan -PlanSha256 $waiverPlanResult.PlanSha256 -Now $now `
            -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck `
            -ConfirmProductionMutation -ConfirmSyntheticOnlyGlobalActivation `
            -ConfirmProtectedWindowProductionMutation
    } "Apply must reject a changed hash-bound synthetic validation snapshot."
    [IO.File]::WriteAllBytes([string]$waiverPlan.syntheticValidationPath, $capturedSyntheticBytes)
    Set-PrivatePathPermissions -Path ([string]$waiverPlan.syntheticValidationPath)
    $capturedWaiverBytes = [IO.File]::ReadAllBytes([string]$waiverPlan.managedTestWaiverPath)
    $tamperedWaiverCopy = Read-StrictJson -Path ([string]$waiverPlan.managedTestWaiverPath)
    $tamperedWaiverCopy.reason = "Changed after planning."
    Write-TestJson -Path ([string]$waiverPlan.managedTestWaiverPath) -Value $tamperedWaiverCopy
    Assert-Throws {
        Invoke-RuntimeConfigApply -Plan $waiverPlan -PlanSha256 $waiverPlanResult.PlanSha256 -Now $now `
            -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck `
            -ConfirmProductionMutation -ConfirmSyntheticOnlyGlobalActivation `
            -ConfirmProtectedWindowProductionMutation
    } "Apply must reject a changed hash-bound managed-test waiver snapshot."
    [IO.File]::WriteAllBytes([string]$waiverPlan.managedTestWaiverPath, $capturedWaiverBytes)
    Set-PrivatePathPermissions -Path ([string]$waiverPlan.managedTestWaiverPath)

    1..5 | ForEach-Object {
        $global:RuntimeConfigClockQueue.Enqueue([DateTimeOffset]::Parse("2026-08-24T06:00:00-04:00"))
    }
    $waiverApplyResult = Invoke-RuntimeConfigApply -Plan $waiverPlan -PlanSha256 $waiverPlanResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck `
        -ConfirmProductionMutation -ConfirmSyntheticOnlyGlobalActivation `
        -ConfirmProtectedWindowProductionMutation
    Assert-Condition ($waiverApplyResult.status -ceq "applied" -and
        $waiverApplyResult.validationLevel -ceq "synthetic_only" -and
        $waiverApplyResult.managedValidation -ceq "waived_not_passed") `
        "Synthetic-only protected apply must converge and retain its waiver record."
    $waiverEvents = @($global:RuntimeConfigTestState.Events)
    Assert-Condition ($waiverEvents -contains "bounds:api:83-100" -and
        $waiverEvents -contains "bounds:worker:0-100") `
        "Six-task protected activation must use the existing no-growth rolling bounds."
    Assert-Condition ($global:RuntimeConfigTestState.ApiMinimumHealthyPercent -eq 100 -and
        $global:RuntimeConfigTestState.ApiMaximumPercent -eq 200 -and
        $global:RuntimeConfigTestState.WorkerMinimumHealthyPercent -eq 100 -and
        $global:RuntimeConfigTestState.WorkerMaximumPercent -eq 200) `
        "Protected activation must restore the exact prior deployment configuration."
    $waiverCandidate = $global:RuntimeConfigTestState.TaskResponses[[string]$waiverApplyResult.candidateApiTaskDefinitionArn].taskDefinition
    $waiverCandidateEnvironment = @($waiverCandidate.containerDefinitions | Where-Object name -CEQ "api")[0].environment
    $waiverCandidateRollouts = [string]@($waiverCandidateEnvironment | Where-Object name -CEQ "CLASSPILOT_CAPABILITY_ROLLOUTS_JSON")[0].value | ConvertFrom-Json -Depth 10
    Assert-Condition ($waiverCandidateRollouts.scopedAuthorityChecksV1.mode -ceq "on" -and
        -not ($waiverCandidateRollouts.scopedAuthorityChecksV1.PSObject.Properties.Name -contains "schoolIds")) `
        "Approved synthetic-only activation must produce the exact global-on runtime configuration."
    $global:RuntimeConfigTestState.Events.Add("test:protected-rollback-start")
    $protectedRollbackStart = [Array]::IndexOf(@($global:RuntimeConfigTestState.Events), "test:protected-rollback-start")
    1..5 | ForEach-Object {
        $global:RuntimeConfigClockQueue.Enqueue([DateTimeOffset]::Parse("2026-08-24T06:00:00-04:00"))
    }
    $waiverRollbackResult = Invoke-RuntimeConfigRollback -Plan $waiverPlan `
        -PlanSha256 $waiverPlanResult.PlanSha256 -Now $now.AddHours(3) `
        -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 `
        -ConfirmProductionMutation -ConfirmProtectedWindowProductionMutation
    $protectedRollbackEvents = @($global:RuntimeConfigTestState.Events)
    $protectedRollbackTail = @($protectedRollbackEvents[($protectedRollbackStart + 1)..($protectedRollbackEvents.Count - 1)])
    Assert-Condition ($waiverRollbackResult.status -ceq "rolled_back" -and
        $global:RuntimeConfigTestState.ApiCurrentArn -ceq $apiSourceArn -and
        $global:RuntimeConfigTestState.WorkerCurrentArn -ceq $workerSourceArn) `
        "Protected rollback must restore the exact pre-waiver service pair at six tasks."
    Assert-Condition ($protectedRollbackTail -contains "bounds:api:83-100" -and
        $protectedRollbackTail -contains "bounds:worker:0-100") `
        "Protected rollback must use the same no-growth six-task bounds."

    Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
    Set-MockSourceRuntimeConfiguration -RuntimeConfiguration $fullTestRuntime
    $planResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot -PrivateProfilePath $profilePath `
        -PrivateTurnEvidencePath $evidencePath -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn $apiSourceArn -WorkerTaskDefinitionArn $workerSourceArn -Now $now -SkipRepositoryCheck
    $plan = Read-RuntimePlan -Path $planResult.PlanPath -ExpectedSha256 $planResult.PlanSha256
    $planText = [IO.File]::ReadAllText($planResult.PlanPath)
    Assert-Condition (-not $planText.Contains($testSchoolId) -and -not $planText.Contains("turn-a.school-pilot.net") -and -not $planText.Contains($turnSecretArn)) "Plan evidence must not contain school, TURN host, or secret identifiers."

    $global:RuntimeConfigTestState.TransitionApiDescribeReadsRemaining = 1
    $applyResult = Invoke-RuntimeConfigApply -Plan $plan -PlanSha256 $planResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck
    Assert-Condition ($applyResult.status -ceq "applied" -and $applyResult.scalingRestored) "Mocked global-on apply must converge and restore scaling."
    Assert-Condition ($global:RuntimeConfigTestState.ApiCurrentArn -ceq $applyResult.candidateApiTaskDefinitionArn) "API must use the registered candidate."
    Assert-Condition ($global:RuntimeConfigTestState.WorkerCurrentArn -ceq $applyResult.candidateWorkerTaskDefinitionArn) "Worker must use the registered candidate."
    $events = @($global:RuntimeConfigTestState.Events)
    $leaseAcquireIndex = [Array]::FindIndex($events, [Predicate[string]]{ param($event) $event -like "lease:acquire:*" })
    $leaseReleaseIndex = [Array]::FindIndex($events, [Predicate[string]]{ param($event) $event -like "lease:release:*" })
    Assert-Condition ($leaseAcquireIndex -ge 0 -and $leaseAcquireIndex -lt [Array]::IndexOf($events, "register:api")) "The fenced operation lease must precede candidate registration."
    Assert-Condition ([Array]::IndexOf($events, "register:api") -lt [Array]::IndexOf($events, "scaling:hold")) "Both candidates must register before the scaling hold and service mutation."
    Assert-Condition ([Array]::IndexOf($events, "scaling:hold") -lt [Array]::IndexOf($events, "update:api:candidate")) "Scaling hold must precede API mutation."
    Assert-Condition ([Array]::IndexOf($events, "update:api:candidate") -lt [Array]::IndexOf($events, "update:worker:candidate")) "API and worker updates must follow the reviewed order."
    Assert-Condition ([Array]::LastIndexOf($events, "scaling:restore") -lt $leaseReleaseIndex -and $leaseReleaseIndex -eq ($events.Count - 1)) "Scaling must restore before the fenced operation lease is released."
    Assert-Condition ($events -contains "transition:api-stopping") "Convergence must tolerate a modeled draining old API deployment before accepting the exact final pair."
    $resultText = [IO.File]::ReadAllText([string]$plan.resultPath)
    Assert-Condition (-not $resultText.Contains($testSchoolId) -and -not $resultText.Contains("turn-a.school-pilot.net") -and -not $resultText.Contains($turnSecretArn)) "Result evidence must remain identifier-free."
    $checkpointText = [IO.File]::ReadAllText([string]$plan.checkpointPath)
    Assert-Condition (-not $checkpointText.Contains($testSchoolId) -and -not $checkpointText.Contains("turn-a.school-pilot.net") -and -not $checkpointText.Contains($turnSecretArn)) "Durable transition checkpoints must remain identifier-free."
    $checkpoint = $checkpointText | ConvertFrom-Json -Depth 10 -DateKind String
    Assert-Condition ($checkpoint.stage -ceq "apply_pair_converged" -and [string]$checkpoint.candidateWorkerTaskDefinitionArn) "Apply must persist the exact candidate pair before returning success."

    $successfulApplyEvidenceText = [IO.File]::ReadAllText([string]$plan.resultPath)
    $tamperedApplyEvidence = $successfulApplyEvidenceText | ConvertFrom-Json -Depth 30
    $tamperedApplyEvidence.scalingRestored = $false
    Write-TestJson -Path ([string]$plan.resultPath) -Value $tamperedApplyEvidence
    $leaseAcquireCountBeforeRejectedRollback = @($global:RuntimeConfigTestState.Events | Where-Object { $_ -like "lease:acquire:*" }).Count
    Assert-Throws {
        Invoke-RuntimeConfigRollback -Plan $plan -PlanSha256 $planResult.PlanSha256 -Now $now `
            -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0
    } "Rollback must reject apply evidence that does not prove exact autoscaling restoration."
    Assert-Condition (@($global:RuntimeConfigTestState.Events | Where-Object { $_ -like "lease:acquire:*" }).Count -eq $leaseAcquireCountBeforeRejectedRollback) "Invalid rollback evidence must fail before acquiring the production operation lease."
    $tamperedApplyEvidence.scalingRestored = $true
    $tamperedApplyEvidence.status = "Applied"
    Write-TestJson -Path ([string]$plan.resultPath) -Value $tamperedApplyEvidence
    Assert-Throws {
        Invoke-RuntimeConfigRollback -Plan $plan -PlanSha256 $planResult.PlanSha256 -Now $now `
            -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0
    } "Rollback evidence status must use the exact reviewed lowercase spelling."
    [IO.File]::WriteAllText([string]$plan.resultPath, $successfulApplyEvidenceText, [Text.UTF8Encoding]::new($false))
    Set-PrivatePathPermissions -Path ([string]$plan.resultPath)

    $global:RuntimeConfigTestState.FailRollbackReassertion = $true
    Assert-Throws {
        Invoke-RuntimeConfigRollback -Plan $plan -PlanSha256 $planResult.PlanSha256 -Now $now `
            -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0
    } "An ambiguous source reassertion during explicit rollback must fail."
    $failedRollbackResult = Read-StrictJson -Path ([string]$plan.resultPath)
    Assert-Condition ($failedRollbackResult.status -ceq "rollback_failed_candidate_restored" -and $failedRollbackResult.scalingRestored) "Failed rollback must restore the coherent candidate pair before releasing scaling."
    Assert-Condition ($global:RuntimeConfigTestState.ApiCurrentArn -ceq $applyResult.candidateApiTaskDefinitionArn -and $global:RuntimeConfigTestState.WorkerCurrentArn -ceq $applyResult.candidateWorkerTaskDefinitionArn) "Failed rollback recovery must restore both exact candidate revisions."
    $global:RuntimeConfigTestState.FailRollbackReassertion = $false
    $rollbackResult = Invoke-RuntimeConfigRollback -Plan $plan -PlanSha256 $planResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0
    Assert-Condition ($rollbackResult.status -ceq "rolled_back" -and $rollbackResult.scalingRestored) "A retried explicit rollback must restore the exact source pair."
    Assert-Condition ($global:RuntimeConfigTestState.ApiCurrentArn -ceq $apiSourceArn -and $global:RuntimeConfigTestState.WorkerCurrentArn -ceq $workerSourceArn) "Rollback must restore both exact source revisions."

    Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
    Set-MockSourceRuntimeConfiguration -RuntimeConfiguration $fullTestRuntime
    $applyEvidenceFailurePlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot -PrivateProfilePath $profilePath `
        -PrivateTurnEvidencePath $evidencePath -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn $apiSourceArn -WorkerTaskDefinitionArn $workerSourceArn -Now $now -SkipRepositoryCheck
    $applyEvidenceFailurePlan = Read-RuntimePlan -Path $applyEvidenceFailurePlanResult.PlanPath -ExpectedSha256 $applyEvidenceFailurePlanResult.PlanSha256
    $global:SchoolPilotRuntimeConfigResultWriteHandler = { throw "Injected final result evidence failure." }
    Assert-Throws {
        Invoke-RuntimeConfigApply -Plan $applyEvidenceFailurePlan -PlanSha256 $applyEvidenceFailurePlanResult.PlanSha256 -Now $now `
            -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck
    } "A final apply evidence-write failure must surface after preserving the converged candidate pair."
    $global:SchoolPilotRuntimeConfigResultWriteHandler = $null
    $applyEvidenceFailureCheckpoint = Read-StrictJson -Path ([string]$applyEvidenceFailurePlan.checkpointPath)
    $applyEvidenceFailureEvents = @($global:RuntimeConfigTestState.Events)
    Assert-Condition ($global:RuntimeConfigTestState.ApiCurrentArn -ceq [string]$applyEvidenceFailureCheckpoint.candidateApiTaskDefinitionArn -and
        $global:RuntimeConfigTestState.WorkerCurrentArn -ceq [string]$applyEvidenceFailureCheckpoint.candidateWorkerTaskDefinitionArn) "Final apply evidence failure must retain the exact coherent candidate pair."
    Assert-Condition (-not $global:RuntimeConfigTestState.DynamicIn -and -not $global:RuntimeConfigTestState.DynamicOut -and
        @($applyEvidenceFailureEvents | Where-Object { $_ -like "update:*:source" }).Count -eq 0) "Final apply evidence failure must not compensate after autoscaling was safely released."
    Assert-Condition ($script:OperationLockHeld -and @($applyEvidenceFailureEvents | Where-Object { $_ -like "lease:release:*" }).Count -eq 0) "A missing final apply receipt must leave the fenced lease to expire for operator recovery."

    Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
    Set-MockSourceRuntimeConfiguration -RuntimeConfiguration $fullTestRuntime
    $rollbackEvidenceFailurePlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot -PrivateProfilePath $profilePath `
        -PrivateTurnEvidencePath $evidencePath -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn $apiSourceArn -WorkerTaskDefinitionArn $workerSourceArn -Now $now -SkipRepositoryCheck
    $rollbackEvidenceFailurePlan = Read-RuntimePlan -Path $rollbackEvidenceFailurePlanResult.PlanPath -ExpectedSha256 $rollbackEvidenceFailurePlanResult.PlanSha256
    [void](Invoke-RuntimeConfigApply -Plan $rollbackEvidenceFailurePlan -PlanSha256 $rollbackEvidenceFailurePlanResult.PlanSha256 -Now $now `
        -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck)
    $global:RuntimeConfigTestState.Events.Add("test:rollback-result-failure-start")
    $rollbackResultFailureStart = [Array]::IndexOf(@($global:RuntimeConfigTestState.Events), "test:rollback-result-failure-start")
    $global:SchoolPilotRuntimeConfigResultWriteHandler = { throw "Injected final rollback result evidence failure." }
    Assert-Throws {
        Invoke-RuntimeConfigRollback -Plan $rollbackEvidenceFailurePlan -PlanSha256 $rollbackEvidenceFailurePlanResult.PlanSha256 -Now $now `
            -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0
    } "A final rollback evidence-write failure must surface after preserving the converged source pair."
    $global:SchoolPilotRuntimeConfigResultWriteHandler = $null
    $rollbackEvidenceFailureEvents = @($global:RuntimeConfigTestState.Events)
    $rollbackFailureTail = @($rollbackEvidenceFailureEvents[($rollbackResultFailureStart + 1)..($rollbackEvidenceFailureEvents.Count - 1)])
    Assert-Condition ($global:RuntimeConfigTestState.ApiCurrentArn -ceq $apiSourceArn -and $global:RuntimeConfigTestState.WorkerCurrentArn -ceq $workerSourceArn) "Final rollback evidence failure must retain the exact coherent source pair."
    Assert-Condition (-not $global:RuntimeConfigTestState.DynamicIn -and -not $global:RuntimeConfigTestState.DynamicOut -and
        @($rollbackFailureTail | Where-Object { $_ -like "update:*:candidate" }).Count -eq 0) "Final rollback evidence failure must never reassert the candidate after safe source convergence."
    Assert-Condition ($script:OperationLockHeld -and @($rollbackFailureTail | Where-Object { $_ -like "lease:release:*" }).Count -eq 0) "A missing final rollback receipt must leave the fenced lease to expire for operator recovery."

    Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
    Set-MockSourceRuntimeConfiguration -RuntimeConfiguration $fullTestRuntime
    $failurePlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot -PrivateProfilePath $profilePath `
        -PrivateTurnEvidencePath $evidencePath -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn $apiSourceArn -WorkerTaskDefinitionArn $workerSourceArn -Now $now -SkipRepositoryCheck
    $failurePlan = Read-RuntimePlan -Path $failurePlanResult.PlanPath -ExpectedSha256 $failurePlanResult.PlanSha256
    $global:RuntimeConfigTestState.FailWorkerCandidateOnce = $true
    Assert-Throws {
        Invoke-RuntimeConfigApply -Plan $failurePlan -PlanSha256 $failurePlanResult.PlanSha256 -Now $now `
            -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck
    } "A failed worker update must fail the apply."
    $failureResult = Read-StrictJson -Path ([string]$failurePlan.resultPath)
    Assert-Condition ($failureResult.status -ceq "apply_failed_rolled_back" -and $failureResult.scalingRestored) "A partial service mutation must record successful pair rollback."
    Assert-Condition ($global:RuntimeConfigTestState.ApiCurrentArn -ceq $apiSourceArn -and $global:RuntimeConfigTestState.WorkerCurrentArn -ceq $workerSourceArn) "Automatic recovery must reassert both source revisions."

    Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
    Set-MockSourceRuntimeConfiguration -RuntimeConfiguration $fullTestRuntime
    $unsafePlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot -PrivateProfilePath $profilePath `
        -PrivateTurnEvidencePath $evidencePath -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn $apiSourceArn -WorkerTaskDefinitionArn $workerSourceArn -Now $now -SkipRepositoryCheck
    $unsafePlan = Read-RuntimePlan -Path $unsafePlanResult.PlanPath -ExpectedSha256 $unsafePlanResult.PlanSha256
    $global:RuntimeConfigTestState.FailWorkerCandidateOnce = $true
    $global:RuntimeConfigTestState.FailRollbackReassertion = $true
    Assert-Throws {
        Invoke-RuntimeConfigApply -Plan $unsafePlan -PlanSha256 $unsafePlanResult.PlanSha256 -Now $now `
            -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck
    } "An unrecoverable mixed pair must fail hard."
    $unsafeResult = Read-StrictJson -Path ([string]$unsafePlan.resultPath)
    Assert-Condition ($unsafeResult.status -ceq "apply_failed_manual_intervention" -and -not $unsafeResult.scalingRestored) "Unsafe mixed state must retain the scaling hold and record manual intervention."
    Assert-Condition ($global:RuntimeConfigTestState.DynamicIn -and $global:RuntimeConfigTestState.DynamicOut) "Autoscaling hold must remain during an unresolved mixed state."

    Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
    Set-MockSourceRuntimeConfiguration -RuntimeConfiguration $fullTestRuntime
    $driftPlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot -PrivateProfilePath $profilePath `
        -PrivateTurnEvidencePath $evidencePath -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn $apiSourceArn -WorkerTaskDefinitionArn $workerSourceArn -Now $now -SkipRepositoryCheck
    $driftPlan = Read-RuntimePlan -Path $driftPlanResult.PlanPath -ExpectedSha256 $driftPlanResult.PlanSha256
    $global:RuntimeConfigTestState.DriftAfterRegistration = $true
    Assert-Throws {
        Invoke-RuntimeConfigApply -Plan $driftPlan -PlanSha256 $driftPlanResult.PlanSha256 -Now $now `
            -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck
    } "Source drift after registration must block all service mutation."
    Assert-Condition (@($global:RuntimeConfigTestState.Events | Where-Object { $_ -like "update:*" }).Count -eq 0) "Source drift must produce zero update-service calls."
    Assert-Condition (-not $global:RuntimeConfigTestState.DynamicIn -and -not $global:RuntimeConfigTestState.DynamicOut) "No-mutation failure must restore scaling."

    Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
    Set-MockSourceRuntimeConfiguration -RuntimeConfiguration $fullTestRuntime
    $boundsDriftPlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot -PrivateProfilePath $profilePath `
        -PrivateTurnEvidencePath $evidencePath -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn $apiSourceArn -WorkerTaskDefinitionArn $workerSourceArn -Now $now -SkipRepositoryCheck
    $boundsDriftPlan = Read-RuntimePlan -Path $boundsDriftPlanResult.PlanPath -ExpectedSha256 $boundsDriftPlanResult.PlanSha256
    $global:RuntimeConfigTestState.BoundsDriftAfterRegistration = $true
    Assert-Throws {
        Invoke-RuntimeConfigApply -Plan $boundsDriftPlan -PlanSha256 $boundsDriftPlanResult.PlanSha256 -Now $now `
            -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck
    } "Deployment-configuration drift after registration must block all service mutation."
    Assert-Condition (@($global:RuntimeConfigTestState.Events | Where-Object { $_ -like "update:*" -or $_ -like "bounds:*" }).Count -eq 0) "Deployment-configuration drift must be rejected immediately before mutation."
    Assert-Condition (-not $global:RuntimeConfigTestState.DynamicIn -and -not $global:RuntimeConfigTestState.DynamicOut -and
        -not $global:RuntimeConfigTestState.Scheduled) "Deployment-configuration drift must restore the exact autoscaling suspension state."

    Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
    Set-MockSourceRuntimeConfiguration -RuntimeConfiguration $fullTestRuntime
    $scalingPlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot -PrivateProfilePath $profilePath `
        -PrivateTurnEvidencePath $evidencePath -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn $apiSourceArn -WorkerTaskDefinitionArn $workerSourceArn -Now $now -SkipRepositoryCheck
    $scalingPlan = Read-RuntimePlan -Path $scalingPlanResult.PlanPath -ExpectedSha256 $scalingPlanResult.PlanSha256
    $global:RuntimeConfigTestState.FailScalingReadbackOnce = $true
    Assert-Throws {
        Invoke-RuntimeConfigApply -Plan $scalingPlan -PlanSha256 $scalingPlanResult.PlanSha256 -Now $now `
            -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck
    } "An ambiguous scaling-hold readback must fail the apply."
    Assert-Condition (-not $global:RuntimeConfigTestState.DynamicIn -and -not $global:RuntimeConfigTestState.DynamicOut) "An ambiguous hold acquisition must restore the captured scaling state."
    $scalingFailure = Read-StrictJson -Path ([string]$scalingPlan.resultPath)
    Assert-Condition ($scalingFailure.status -ceq "apply_failed_no_service_mutation" -and $scalingFailure.scalingRestored) "Scaling acquisition failure must retain accurate recovery evidence."

    Reset-MockDeploymentState -ApiArn $apiSourceArn -WorkerArn $workerSourceArn -Digest $digest -SecretArn $turnSecretArn
    Set-MockSourceRuntimeConfiguration -RuntimeConfiguration $fullTestRuntime
    $windowPlanResult = New-RuntimeConfigPlan -RepositoryRoot $repositoryRoot -PrivateProfilePath $profilePath `
        -PrivateTurnEvidencePath $evidencePath -EvidenceRoot $evidenceRoot -AppSha $appSha -ImageDigest $digest `
        -ApiTaskDefinitionArn $apiSourceArn -WorkerTaskDefinitionArn $workerSourceArn -Now $now -SkipRepositoryCheck
    $windowPlan = Read-RuntimePlan -Path $windowPlanResult.PlanPath -ExpectedSha256 $windowPlanResult.PlanSha256
    $global:RuntimeConfigClockQueue.Enqueue([DateTimeOffset]::Parse("2026-08-24T04:44:59-04:00"))
    $global:RuntimeConfigClockQueue.Enqueue([DateTimeOffset]::Parse("2026-08-24T04:45:00-04:00"))
    Assert-Throws {
        Invoke-RuntimeConfigApply -Plan $windowPlan -PlanSha256 $windowPlanResult.PlanSha256 -Now $now `
            -ConvergenceAttempts 2 -ConvergenceIntervalSeconds 0 -SkipRepositoryCheck
    } "A deployment that crosses into the arrival window before mutation must stop."
    Assert-Condition (@($global:RuntimeConfigTestState.Events | Where-Object { $_ -like "update:*" }).Count -eq 0) "Fresh-clock window crossing must produce zero service updates."
    Assert-Condition (-not $global:RuntimeConfigTestState.DynamicIn -and -not $global:RuntimeConfigTestState.DynamicOut) "Fresh-clock stop must restore the scaling hold."

    $productionVariables = Get-Content -LiteralPath (Join-Path $repositoryRoot "infra/production.tfvars") -Raw
    $terraformVariables = Get-Content -LiteralPath (Join-Path $repositoryRoot "infra/variables.tf") -Raw
    $turnOperations = Get-Content -LiteralPath (Join-Path $repositoryRoot "docs/CLASSPILOT_TURN_OPERATIONS.md") -Raw
    Assert-Condition ($productionVariables -cmatch '(?m)^enable_classpilot_turn\s*=\s*true\s*$') `
        "The canonical production baseline must keep the reviewed TURN module enabled."
    Assert-Condition ($productionVariables -cnotmatch '(?m)^\s*classpilot_turn_tls_email\s*=') `
        "The operator-owned TURN TLS email must not be committed to production.tfvars."
    Assert-Condition ($terraformVariables -cmatch '(?s)variable\s+"classpilot_turn_tls_email"\s*\{.*?sensitive\s*=\s*true.*?\}') `
        "Terraform must continue treating the TURN TLS contact as sensitive input."
    Assert-Condition ($turnOperations -cmatch 'TF_VAR_classpilot_turn_tls_email' -and
        $turnOperations -cmatch 'Remove-Item Env:TF_VAR_classpilot_turn_tls_email') `
        "The TURN runbook must document process-local injection and cleanup of the private TLS contact."
    Assert-Condition ($turnOperations -cmatch 'zero destructive actions' -and
        $turnOperations -cmatch 'must not deploy') `
        "The TURN runbook must constrain the saved production plan before apply."

    Write-Output "ClassPilot runtime-config deployment tests passed ($script:Assertions assertions)."
}
finally {
    $env:SCHOOLPILOT_RUNTIME_CONFIG_TEST_MODE = $priorTestMode
    if ($null -ne $priorAwsHandlerVariable) { $global:SchoolPilotRuntimeConfigAwsHandler = $priorAwsHandler }
    else { Remove-Variable -Name SchoolPilotRuntimeConfigAwsHandler -Scope Global -ErrorAction SilentlyContinue }
    if ($null -ne $priorGitHandlerVariable) { $global:SchoolPilotRuntimeConfigGitHandler = $priorGitHandler }
    else { Remove-Variable -Name SchoolPilotRuntimeConfigGitHandler -Scope Global -ErrorAction SilentlyContinue }
    if ($null -ne $priorClockHandlerVariable) { $global:SchoolPilotRuntimeConfigClockHandler = $priorClockHandler }
    else { Remove-Variable -Name SchoolPilotRuntimeConfigClockHandler -Scope Global -ErrorAction SilentlyContinue }
    if ($null -ne $priorSnapshotHandlerVariable) { $global:SchoolPilotRuntimeConfigSnapshotReadHandler = $priorSnapshotHandler }
    else { Remove-Variable -Name SchoolPilotRuntimeConfigSnapshotReadHandler -Scope Global -ErrorAction SilentlyContinue }
    if ($null -ne $priorLeaseClockHandlerVariable) { $global:SchoolPilotRuntimeConfigLeaseClockHandler = $priorLeaseClockHandler }
    else { Remove-Variable -Name SchoolPilotRuntimeConfigLeaseClockHandler -Scope Global -ErrorAction SilentlyContinue }
    if ($null -ne $priorResultWriteHandlerVariable) { $global:SchoolPilotRuntimeConfigResultWriteHandler = $priorResultWriteHandler }
    else { Remove-Variable -Name SchoolPilotRuntimeConfigResultWriteHandler -Scope Global -ErrorAction SilentlyContinue }
    Remove-Variable -Name RuntimeConfigGitState -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name RuntimeConfigTestState -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name RuntimeConfigClockQueue -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name RuntimeConfigLeaseClock -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name RuntimeConfigSnapshotSwapPath -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name RuntimeConfigSnapshotSwapText -Scope Global -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
