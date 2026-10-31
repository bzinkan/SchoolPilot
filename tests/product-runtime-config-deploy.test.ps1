#requires -Version 7.5
[CmdletBinding()]
param([switch]$ContainmentInterruptionFixture, [string]$InterruptionDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:Assertions = 0

# Reuse only fixture/assertion function definitions. Never execute the existing
# test suite or any of its deployment workflow invocations.
$fixtureFile = Join-Path $PSScriptRoot 'classpilot-runtime-config-deploy.test.ps1'
$fixtureAst = [Management.Automation.Language.Parser]::ParseFile($fixtureFile, [ref]$null, [ref]$null)
foreach ($name in @('Assert-Condition', 'Assert-Throws', 'Get-ArgumentValue', 'New-TestTaskResponse', 'New-TestService')) {
    $definition = $fixtureAst.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name }, $true)
    if ($null -eq $definition) { throw "Missing fixture helper $name" }
    . ([scriptblock]::Create($definition.Extent.Text))
}
. (Join-Path $PSScriptRoot '../scripts/deploy-product-runtime-config.ps1')

$script:ProductTestFile = $PSCommandPath
$script:TestDirectory = Join-Path ([IO.Path]::GetTempPath()) ('product-runtime-mock-' + [Guid]::NewGuid().ToString('N'))
if ($ContainmentInterruptionFixture) {
    if (-not [IO.Path]::IsPathFullyQualified($InterruptionDirectory)) { throw 'Interruption fixture requires an absolute private mock directory.' }
    $interruptedRoot = [IO.Path]::GetFullPath($InterruptionDirectory)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $interruptedRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($interruptedRoot) -notlike 'product-runtime-mock-*') { throw 'Unsafe interruption fixture path.' }
    $script:TestDirectory = $interruptedRoot
}
[void][IO.Directory]::CreateDirectory($script:TestDirectory)
$script:TestSha = 'a' * 40
$script:CurrentToolSha = $script:TestSha
$script:TestDigest = 'sha256:' + ('b' * 64)
$script:TestApiArn = 'arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:161'
$script:TestWorkerArn = 'arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:177'
$script:BaselineTables = 'students,passes,classpilot_ai_decisions,flight_paths,block_lists'
$script:RulesTables = @('passpilot_destination_policies', 'passpilot_pass_limits', 'passpilot_encounter_restrictions', 'passpilot_pass_denials')
$script:AppointmentRegistry = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '../src/config/rlsRegistry.json'))
$script:AppointmentTables = @((($script:AppointmentRegistry | ConvertFrom-Json -Depth 30 -DateKind String).inventories.passpilotAppointmentsPostExpand.tables))
$script:SchoolA = '0f1e2d3c-4b5a-4c6d-8e7f-a1b2c3d4e5f6'
$script:SchoolB = '9a8b7c6d-5e4f-4a3b-9c2d-e1f0a9b8c7d6'

function Assert-ThrowsMatch {
    param([scriptblock]$Action, [string]$Pattern, [string]$Message)
    $script:Assertions++
    $caught = $null
    try { $null = & $Action } catch { $caught = $_.Exception.Message }
    if ($null -eq $caught) { throw "$Message (nothing was thrown)" }
    if ($caught -notmatch $Pattern) { throw "$Message (unexpected error: $caught)" }
}
function Copy-TestValue($Value) { return ($Value | ConvertTo-Json -Depth 50 | ConvertFrom-Json -Depth 50 -DateKind String) }
function Get-TestTask([string]$Role) { if ($Role -ceq 'api') { return $script:Mock.Tasks[$script:TestApiArn] } else { return $script:Mock.Tasks[$script:TestWorkerArn] } }
function Set-TestEnvironment($Response, [string]$Name, $Value) {
    $container = $Response.taskDefinition.containerDefinitions[0]
    $container.environment = @($container.environment | Where-Object name -CNE $Name)
    if ($null -ne $Value) { $container.environment += [pscustomobject]@{ name = $Name; value = $Value } }
}
function Set-BothEnvironment([string]$Name, $Value) { foreach ($role in @('api', 'worker')) { Set-TestEnvironment (Get-TestTask $role) $Name $Value } }
function Get-TestEnvironmentValue($Response, [string]$Name) {
    $entries = @($Response.taskDefinition.containerDefinitions[0].environment | Where-Object name -CEQ $Name)
    if ($entries.Count -eq 0) { return $null }
    return [string]$entries[0].value
}
function Add-BothTables([string[]]$Tables) {
    foreach ($role in @('api', 'worker')) {
        $response = Get-TestTask $role
        Set-TestEnvironment $response 'RLS_ENABLED_TABLES' ((Get-TestEnvironmentValue $response 'RLS_ENABLED_TABLES') + ',' + ($Tables -join ','))
    }
}
function Remove-TestTable([string]$Role, [string]$Table) {
    $response = Get-TestTask $Role
    $tables = @((Get-TestEnvironmentValue $response 'RLS_ENABLED_TABLES').Split(',') | Where-Object { $_ -cne $Table })
    Set-TestEnvironment $response 'RLS_ENABLED_TABLES' ($tables -join ',')
}
function Get-ServingState([string]$Role) {
    $response = $script:Mock.Tasks[$script:Mock.Services.$Role.taskDefinition]
    $container = if ($Role -ceq 'Api') { 'api' } else { 'scheduler-worker' }
    return Get-ProductManagedState (Get-ProductEnvironment -Task $response.taskDefinition -ContainerName $container)
}
function Invoke-GitText {
    param([string[]]$Arguments, [string]$RepositoryRoot)
    if ($Arguments[0] -ceq 'show' -and $Arguments[1] -clike '*:src/config/passpilotReportsMode.ts') {
        if ($script:Mock.CompatibleReportsWriter) {
            if ($script:Mock.CompatibleReportAuthority) { return 'export const PASSPILOT_REPORTS_CONTRACT_VERSION = 2; export const PASSPILOT_REPORTS_AUTHORITY_FENCE_VERSION = 1;' }
            return 'export const PASSPILOT_REPORTS_CONTRACT_VERSION = 2;'
        }
        return '// earlier report projection'
    }
    if ($Arguments[0] -ceq 'show' -and $Arguments[1] -clike '*:src/config/passpilotAppointmentsMode.ts') {
        if ($script:Mock.CompatibleAppointmentWriter) { return 'export const PASSPILOT_APPOINTMENTS_ATOMIC_WRITER_CONTRACT_VERSION = 2;' }
        return 'export const PASSPILOT_APPOINTMENTS_ATOMIC_WRITER_CONTRACT_VERSION = 1;'
    }
    if ($Arguments[0] -ceq 'show' -and $Arguments[1] -clike '*:src/config/rlsRegistry.json') { return $script:AppointmentRegistry }
    if ($Arguments[0] -ceq 'show' -and $Arguments[1] -clike '*:src/config/classpilotUsageModes.ts') {
        if ($script:Mock.CompatibleUsageWriter) { return 'export const CLASSPILOT_USAGE_COVERAGE_CONTRACT_VERSION = 1;' }
        return '// pre-ledger release'
    }
    throw "Unexpected git source query: $($Arguments -join ' ')"
}
function Reset-ProductMock {
    $envs = @(
        [pscustomobject]@{ name = 'RLS_GUC_ENABLED'; value = 'true' },
        [pscustomobject]@{ name = 'RLS_ENABLED_TABLES'; value = $script:BaselineTables },
        [pscustomobject]@{ name = 'CLASSPILOT_CAPABILITY_ROLLOUTS_JSON'; value = '{"unchanged":"private-existing-runtime"}' },
        [pscustomobject]@{ name = 'CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1'; value = 'true' },
        [pscustomobject]@{ name = 'CLASSPILOT_TURN_HOSTS'; value = 'turn-a.example.invalid' },
        [pscustomobject]@{ name = 'MYDESK_MODE'; value = 'on' },
        [pscustomobject]@{ name = 'CLIENT_URL'; value = 'https://school-pilot.net' }
    )
    $turnSecret = [pscustomobject]@{ name = 'CLASSPILOT_TURN_REST_SECRET'; valueFrom = 'arn:aws:secretsmanager:us-east-1:135775632425:secret:test-turn-secret' }
    $api = New-TestTaskResponse api $script:TestApiArn $script:TestDigest $envs @($turnSecret)
    $worker = New-TestTaskResponse worker $script:TestWorkerArn $script:TestDigest $envs @($turnSecret)
    $script:Mock = @{
        Tasks = @{ $script:TestApiArn = $api; $script:TestWorkerArn = $worker }
        Services = [pscustomobject]@{ Api = (New-TestService api $script:TestApiArn 3); Worker = (New-TestService worker $script:TestWorkerArn 1) }
        Scaling = [pscustomobject]@{ Min = 3; Max = 6; DynamicIn = $false; DynamicOut = $false; Scheduled = $false }
        Calls = [Collections.Generic.List[string]]::new(); Requests = [Collections.Generic.List[object]]::new()
        CompatibleUsageWriter = $true; CompatibleAppointmentWriter = $true; CompatibleReportsWriter = $true; CompatibleReportAuthority = $true; Revision = 200; FailWorkerOnce = $false; FailRecovery = $false; FailedWorker = $false; FailStart = $false; InjectWorkerFlag = $false
        Unhealthy = $false; ProtectedWindow = $false; OtherLease = $false; FailApiOnce = $false; FailedApi = $false
        FailBoundsRestore = $false; FailScalingRestore = $false; FailBoundsSetOnce = $false; FailedBoundsSet = $false
        DriftAfterHold = $false; DriftDuringRecovery = $false; LoseFenceDuringWorker = $false
        InterruptWorker = $false
    }
    $script:CurrentToolSha = $script:TestSha
    $script:ApiServiceMutationStarted = $false; $script:WorkerServiceMutationStarted = $false
    $script:ScalingHoldAcquired = $false; $script:PriorScalingState = $null
    $script:OperationLockHeld = $false; $script:OperationLockState = $null
    $script:DeploymentBoundsChanged = $false; $script:PriorDeploymentConfigurations = $null
    $script:UsageOffContainment = $false
}

# All external interactions are replaced below. The default mock fails closed
# on an unknown AWS operation, so this file cannot invoke the installed AWS CLI.
function Invoke-AwsJson {
    param([string[]]$Arguments)
    $operation = $Arguments[0..1] -join ' '
    $script:Mock.Calls.Add($operation)
    switch -CaseSensitive ($operation) {
        'sts get-caller-identity' { return [pscustomobject]@{ Account = $script:AccountId } }
        'ecr describe-images' { return [pscustomobject]@{ imageDetails = @([pscustomobject]@{ imageDigest = $script:TestDigest }) } }
        'ecs describe-task-definition' { return Copy-TestValue $script:Mock.Tasks[(Get-ArgumentValue $Arguments '--task-definition')] }
        'ecs register-task-definition' {
            $path = (Get-ArgumentValue $Arguments '--cli-input-json').Substring(7)
            $request = [IO.File]::ReadAllText($path) | ConvertFrom-Json -Depth 50 -DateKind String
            if ($null -ne $request.PSObject.Properties['tags'] -and @($request.tags).Count -eq 0) { throw 'ClientException: Tags can not be empty.' }
            $script:Mock.Requests.Add((Copy-TestValue $request))
            $script:Mock.Revision++
            $arn = "arn:aws:ecs:us-east-1:135775632425:task-definition/$($request.family):$($script:Mock.Revision)"
            $task = Copy-TestValue $request
            $tags = @()
            if ($null -ne $task.PSObject.Properties['tags']) { $tags = @($task.tags); $task.PSObject.Properties.Remove('tags') }
            if ($script:Mock.InjectWorkerFlag -and $request.family -ceq 'schoolpilot-production-scheduler-worker') {
                # Simulates a registered worker revision that kept a managed
                # name the plan did not ask for; the per-name checks inside the
                # shared registration only prove desired names are present.
                $task.containerDefinitions[0].environment += [pscustomobject]@{ name = 'PASSPILOT_APPOINTMENTS_MODE'; value = 'on' }
            }
            $task | Add-Member taskDefinitionArn $arn; $task | Add-Member status 'ACTIVE'; $task | Add-Member revision $script:Mock.Revision
            $response = [pscustomobject]@{ taskDefinition = $task; tags = $tags }
            $script:Mock.Tasks[$arn] = $response
            return Copy-TestValue $response
        }
        'ecs update-service' {
            $service = Get-ArgumentValue $Arguments '--service'
            $role = if ($service -ceq $script:ApiService) { 'Api' } else { 'Worker' }
            $configurationPath = if ($Arguments -ccontains '--deployment-configuration') { Get-ArgumentValue $Arguments '--deployment-configuration' } else { $null }
            if ($configurationPath) {
                $configuration = [IO.File]::ReadAllText($configurationPath.Substring(7)) | ConvertFrom-Json -Depth 50 -DateKind String
                $script:Mock.Calls.Add("bounds:$role`:$($configuration.minimumHealthyPercent)/$($configuration.maximumPercent)")
                if ($script:Mock.FailBoundsRestore -and $configuration.maximumPercent -eq 200) { throw 'Deployment bounds restoration failed' }
                $script:Mock.Services.$role.deploymentConfiguration = $configuration
                if ($script:Mock.FailBoundsSetOnce -and -not $script:Mock.FailedBoundsSet) {
                    $script:Mock.FailedBoundsSet = $true
                    throw 'Ambiguous bounds response after accepted update'
                }
                return [pscustomobject]@{}
            }
            $arn = Get-ArgumentValue $Arguments '--task-definition'
            if ($role -ceq 'Worker' -and $script:Mock.InterruptWorker) {
                # A separate process exits without unwinding Apply's catch or
                # finally blocks, immediately before the worker update. The
                # only transport in that process is this mock.
                Write-SanitizedJson (Join-Path $script:TestDirectory 'interruption-state.json') ([pscustomobject]@{
                    planPath = $script:InterruptionPlan.path; planHash = $script:InterruptionPlan.sha256
                    apiMode = (Get-ServingState Api)['CLASSPILOT_USAGE_ROLLUP_MODE']
                    workerMode = (Get-ServingState Worker)['CLASSPILOT_USAGE_ROLLUP_MODE']
                    fenceHeld = $script:OperationLockHeld; fenceState = $script:OperationLockState
                    fenceOwner = $script:OperationLockOwner; fenceToken = $script:OperationLockFence
                    scalingHeld = $script:ScalingHoldAcquired; boundsHeld = $script:DeploymentBoundsChanged
                })
                exit 73
            }
            $script:Mock.Calls.Add("update:$role")
            $count = $script:Mock.Services.$role.desiredCount
            $configuration = $script:Mock.Services.$role.deploymentConfiguration
            $script:Mock.Services.$role = New-TestService $role.ToLowerInvariant() $arn $count -DeploymentConfiguration $configuration
            if ($role -ceq 'Api' -and $script:Mock.FailApiOnce -and -not $script:Mock.FailedApi) {
                $script:Mock.FailedApi = $true
                throw 'Ambiguous API response after accepted update.'
            }
            if ($role -ceq 'Worker' -and $script:Mock.FailWorkerOnce -and -not $script:Mock.FailedWorker) {
                $script:Mock.FailedWorker = $true
                if ($script:Mock.DriftDuringRecovery) { $script:Mock.Services.Api.deploymentConfiguration.maximumPercent = 150 }
                if ($script:Mock.LoseFenceDuringWorker) { $script:OperationLockHeld = $false }
                throw 'Ambiguous worker response after accepted update.'
            }
            return [pscustomobject]@{}
        }
        default { throw "Unmocked external operation: $operation" }
    }
}
function Get-ServiceSnapshot { return Copy-TestValue $script:Mock.Services }
function Start-Sleep { param($Seconds) } # Bounded poll loops remain deterministic under mocked transport.
function Assert-ApiTargetHealth { param($ApiService, $ExpectedDesiredCount, $Mode) if ($script:Mock.Unhealthy) { throw 'Unhealthy API targets' }; return $true }
function Get-ScalingSnapshot { return Copy-TestValue $script:Mock.Scaling }
function Assert-ScheduledScalingContract { }
function Assert-RuntimeConfigMutationWindow { if ($script:Mock.ProtectedWindow) { throw 'Protected production mutation window' } }
function Assert-RepositoryIdentity { param($RepositoryRoot, $ExpectedSha) if ($ExpectedSha -and $ExpectedSha -cne $script:CurrentToolSha) { throw 'Tool SHA drift' }; return $script:CurrentToolSha }
function Assert-PrivateExternalRoot { param($Root, $RepositoryRoot) return $Root }
function Assert-PrivateInputPath { param($Path, $RepositoryRoot) if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'Missing test input' }; return $Path }
function Set-PrivatePathPermissions { param($Path) }
function Acquire-OperationLock { param($RunId, $PlanSha256) if ($script:Mock.OtherLease) { throw 'Another runtime operation holds the lease' }; $script:OperationLockHeld = $true; $script:OperationLockState = 'preparing'; $script:OperationLockOwner = "$RunId-mockowner"; $script:OperationLockFence = 42; $script:Mock.Calls.Add('lock') }
function Maintain-OperationLock { if (-not $script:OperationLockHeld) { throw 'Missing operation fence' } }
function Start-OperationMutationWindow { if ($script:Mock.FailStart) { throw 'Fence acquisition failed' }; $script:OperationLockState = 'mutating' }
function Complete-OperationMutationWindow { if ($script:OperationLockState -cne 'mutating') { throw 'Not mutating' }; $script:OperationLockState = 'terminal_safe' }
function Release-OperationLock { $script:OperationLockHeld = $false; $script:Mock.Calls.Add('unlock') }
function Acquire-ScalingHold { $script:PriorScalingState = Copy-TestValue $script:Mock.Scaling; $script:ScalingHoldAcquired = $true; $script:Mock.Scaling.DynamicIn = $true; $script:Mock.Scaling.DynamicOut = $true; $script:Mock.Scaling.Scheduled = $true; $script:Mock.Calls.Add('hold'); if ($script:Mock.DriftAfterHold) { $script:Mock.Services.Api.desiredCount++ } }
function Assert-ScalingHoldExact { if (-not $script:ScalingHoldAcquired) { throw 'Missing scaling hold' }; return $true }
function Restore-ScalingHold { if ($script:Mock.FailScalingRestore) { throw 'Autoscaling restoration failed' }; $script:Mock.Scaling = Copy-TestValue $script:PriorScalingState; $script:ScalingHoldAcquired = $false; $script:Mock.Calls.Add('restore'); return $true }
function Wait-ExactServicePairConvergence {
    param($ExpectedApiArn, $ExpectedWorkerArn, $ExpectedDesiredCount)
    $script:Mock.Calls.Add('wait')
    if ($script:Mock.FailRecovery -and $script:Mock.FailedWorker) { throw 'Recovery could not converge' }
    if ($script:Mock.Services.Api.taskDefinition -cne $ExpectedApiArn -or $script:Mock.Services.Worker.taskDefinition -cne $ExpectedWorkerArn -or $ExpectedDesiredCount -ne $script:Mock.Services.Api.desiredCount) { throw 'Incorrect convergence pair' }
    return $true
}

function New-TestConfig([hashtable]$Environment) { return [pscustomobject]@{ schemaVersion = 1; environment = [pscustomobject]$Environment } }
function New-TestProductPlan($Config, $EvidencePath = $null, $UsageEvidencePath = $null, [switch]$UsageOffContainment) {
    # Plan against whatever pair is serving now, as an operator would.
    return New-ProductPlan $Config $script:TestDirectory $script:Mock.Services.Api.taskDefinition $script:Mock.Services.Worker.taskDefinition `
        $script:TestDigest $script:TestSha $EvidencePath $UsageEvidencePath -UsageOffContainment:$UsageOffContainment
}
function Initialize-TestUsageOn([int]$DesiredCount = 3) {
    Reset-ProductMock
    Set-BothEnvironment 'CLASSPILOT_USAGE_ROLLUP_MODE' 'on'
    Set-BothEnvironment 'CLASSPILOT_DIGITAL_USAGE_MODE' 'on'
    $script:Mock.Services.Api = New-TestService api $script:TestApiArn $DesiredCount
    $script:Mock.Scaling.Min = if ($DesiredCount -eq 1) { 1 } else { 3 }
}
function Read-TestProductReceipt($Plan) {
    return (Read-StrictJsonSnapshot (Join-Path $script:TestDirectory "$($Plan.plan.runId)-result.json")).Value
}
function Assert-AllRegisteredUsageOff([string]$Message) {
    foreach ($request in $script:Mock.Requests) {
        $environment = @($request.containerDefinitions[0].environment)
        foreach ($name in @('CLASSPILOT_USAGE_ROLLUP_MODE', 'CLASSPILOT_DIGITAL_USAGE_MODE')) {
            $entries = @($environment | Where-Object name -CEQ $name)
            Assert-Condition ($entries.Count -eq 1 -and $entries[0].value -ceq 'off') $Message
        }
    }
}
function Assert-NoMutation([string]$Message) {
    $mutations = @($script:Mock.Calls | Where-Object { $_ -cin @('ecs register-task-definition', 'ecs update-service', 'lock', 'hold') })
    Assert-Condition ($mutations.Count -eq 0 -and $script:Mock.Requests.Count -eq 0 -and -not $script:OperationLockHeld -and -not $script:ScalingHoldAcquired) $Message
}
function Get-TestSchoolDays([int]$Count) {
    $cursor = (Get-EasternNow).Date.AddDays(-1)
    $days = @()
    while ($days.Count -lt $Count) {
        if ($cursor.DayOfWeek -notin @([DayOfWeek]::Saturday, [DayOfWeek]::Sunday)) {
            $days += [pscustomobject]@{ date = $cursor.ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture); processedSchools = 1; shadowMismatches = 0; failedSchools = 0 }
        }
        $cursor = $cursor.AddDays(-1)
    }
    return ,$days
}
function New-TestEvidence {
    return [pscustomobject]@{ schemaVersion = 1; reviewedAt = [DateTimeOffset]::UtcNow.ToString('o'); reviewReference = 'logs-insights/daily-usage-shadow-review'
        imageDigest = $script:TestDigest; schoolDays = (Get-TestSchoolDays 3) }
}
function New-TestUsageObservation {
    $date = (Get-EasternNow).Date.AddDays(-2)
    while ($date.DayOfWeek -in @([DayOfWeek]::Saturday, [DayOfWeek]::Sunday)) { $date = $date.AddDays(-1) }
    $zone = [TimeZoneInfo]::FindSystemTimeZoneById('America/New_York')
    $start = [TimeZoneInfo]::ConvertTimeToUtc([DateTime]::SpecifyKind($date, [DateTimeKind]::Unspecified), $zone)
    $end = [TimeZoneInfo]::ConvertTimeToUtc([DateTime]::SpecifyKind($date.AddDays(1), [DateTimeKind]::Unspecified), $zone).AddHours(2)
    return [pscustomobject]@{ schemaVersion = 1; reviewedAt = [DateTimeOffset]::UtcNow.ToString('o'); reviewReference = 'usage/observed-ledger-review'
        appSha = $script:TestSha; imageDigest = $script:TestDigest; schoolDays = @([pscustomobject]@{
            schoolId = $script:SchoolA; date = $date.ToString('yyyy-MM-dd'); timeZone = 'America/New_York'
            startedAt = $start.ToString('o'); endedAt = $end.ToString('o'); coverageCheckedAt = $end.ToString('o')
            observedRuns = 25; failedSchools = 0; deferredDays = 0; budgetExhausted = $false; maxRunDurationMs = 10000
            finalDayComplete = $true; currentDayComplete = $true; logSha256 = ('c' * 64); coverageSha256 = ('d' * 64)
        }) }
}
function New-TestInstructionalUsageObservation {
    $evidence = New-TestUsageObservation
    $evidence.schemaVersion = 2
    $day = $evidence.schoolDays[0]
    $date = [DateTime]::ParseExact($day.date, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
    $zone = [TimeZoneInfo]::FindSystemTimeZoneById($day.timeZone)
    $classesStart = [TimeZoneInfo]::ConvertTimeToUtc([DateTime]::SpecifyKind($date.AddHours(9).AddMinutes(15), [DateTimeKind]::Unspecified), $zone)
    $classesEnd = [TimeZoneInfo]::ConvertTimeToUtc([DateTime]::SpecifyKind($date.AddHours(15).AddMinutes(45), [DateTimeKind]::Unspecified), $zone)
    $window = [pscustomobject]@{
        startedAt = $classesStart.ToString('o'); endedAt = $classesEnd.ToString('o')
        usageOnCompletedAt = $classesStart.AddMinutes(-10).ToString('o')
        observedFrom = $classesStart.ToString('o'); observedThrough = $classesEnd.ToString('o')
        confirmationReference = 'human/confirmed-full-class-day'
    }
    # New York's whole-hour offset means 10:00 local is the first scheduled
    # tick after 09:15 classes; include all 15 normal ticks through midnight.
    $firstTick = [TimeZoneInfo]::ConvertTimeToUtc([DateTime]::SpecifyKind($date.AddHours(10), [DateTimeKind]::Unspecified), $zone)
    $buckets = @(0..14 | ForEach-Object { $firstTick.AddHours($_).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture) })
    $day | Add-Member instructionalWindow $window
    $day | Add-Member requiredHourlyBuckets $buckets
    $day.observedRuns = 15
    return $evidence
}
function Write-TestEvidence($Evidence) {
    $path = Join-Path $script:TestDirectory ('evidence-' + [Guid]::NewGuid().ToString('N') + '.json')
    Write-SanitizedJson $path $Evidence
    return $path
}
function Invoke-TestRollback($Plan) {
    $script:Action = 'Rollback'; $script:Execute = $true; $script:ManifestPath = $Plan.path; $script:ManifestHash = $Plan.sha256; $script:DailyUsageEvidencePath = $null
    $script:UsageObservationEvidencePath = $null
    Invoke-ProductMain
}

if ($ContainmentInterruptionFixture) {
    Initialize-TestUsageOn 6
    $script:InterruptionPlan = New-TestProductPlan (New-TestConfig @{ CLASSPILOT_USAGE_ROLLUP_MODE = 'off'; CLASSPILOT_DIGITAL_USAGE_MODE = 'off' }) -UsageOffContainment
    $script:Mock.InterruptWorker = $true
    [void](Invoke-ProductApply $script:InterruptionPlan.plan $script:InterruptionPlan.sha256 $script:TestDirectory)
    throw 'Interruption fixture unexpectedly completed.'
}

try {
    # --- Configuration: only the nine managed names, exact values only ---
    Reset-ProductMock
    Assert-Condition ((ConvertTo-ProductChanges (New-TestConfig @{ PASSPILOT_RULES_MODE = 'on' }))['PASSPILOT_RULES_MODE'] -ceq 'on') 'An exact managed value must parse.'
    Assert-Condition ((ConvertTo-ProductChanges (New-TestConfig @{ CLASSPILOT_DASHBOARD_THEMES_ENABLED = 'true' }))['CLASSPILOT_DASHBOARD_THEMES_ENABLED'] -ceq 'true') 'Dashboard themes must parse the exact true value.'
    foreach ($value in @('on', 'True', 'TRUE', ' true', 'true ', '1')) {
        Assert-Throws { ConvertTo-ProductChanges (New-TestConfig @{ CLASSPILOT_DASHBOARD_THEMES_ENABLED = $value }) } 'Dashboard theme aliases must be refused.'
    }
    Assert-Condition ('dashboardThemes' -cin (Get-ProductActivations (Get-ProductManagedState (Get-ProductEnvironment $script:Mock.Tasks[$script:TestApiArn].taskDefinition 'api')) (Resolve-ProductDesiredState (Get-ProductManagedState (Get-ProductEnvironment $script:Mock.Tasks[$script:TestApiArn].taskDefinition 'api')) (ConvertTo-ProductChanges (New-TestConfig @{ CLASSPILOT_DASHBOARD_THEMES_ENABLED = 'true' }))))) 'Turning dashboard themes on is an activation with no admission gate.'
    Assert-Condition ((ConvertTo-ProductChanges (New-TestConfig @{ PASSPILOT_REPORTS_MODE = 'v2' }))['PASSPILOT_REPORTS_MODE'] -ceq 'v2') 'Reports must parse the exact reviewed v2 value.'
    foreach ($value in @('on', 'V2', ' v2', 'v2 ')) {
        Assert-Throws { ConvertTo-ProductChanges (New-TestConfig @{ PASSPILOT_REPORTS_MODE = $value }) } 'Report mode aliases must be refused.'
    }
    foreach ($name in @('NODE_ENV', 'CLIENT_URL', 'DATABASE_URL', 'CLASSPILOT_SCHEDULED_CLASSROOM_MODE', 'CLASSPILOT_LIVE_VIEW_SIGNALING_ENABLED', 'PASSPILOT_RULES_MODE ')) {
        Assert-ThrowsMatch { ConvertTo-ProductChanges (New-TestConfig @{ $name = 'on' }) } 'not a wave-1 product flag' "Unmanaged name '$name' must be refused."
    }
    foreach ($name in @('CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1', 'CLASSPILOT_CAP_LIVE_VIEW_ICE_SERVERS_V1', 'CLASSPILOT_CAPABILITY_ROLLOUTS_JSON', 'CLASSPILOT_PROTOCOL_V3_ENABLED')) {
        Assert-ThrowsMatch { ConvertTo-ProductChanges (New-TestConfig @{ $name = 'true' }) } 'capability control' "Capability control $name must be refused."
    }
    foreach ($name in @('CLASSPILOT_TURN_HOSTS', 'CLASSPILOT_STUN_URLS', 'CLASSPILOT_TURN_REST_SECRET')) {
        Assert-ThrowsMatch { ConvertTo-ProductChanges (New-TestConfig @{ $name = 'turn.example.invalid' }) } 'legacy TURN' "TURN name $name must be refused."
    }
    foreach ($name in @('MYDESK_MODE', 'MYDESK_AI_IMPORT_MODE', 'STUDENT_INFORMATION_AI_IMPORT_MODE')) {
        Assert-ThrowsMatch { ConvertTo-ProductChanges (New-TestConfig @{ $name = 'off' }) } 'My Desk control' "My Desk name $name must be refused."
    }
    foreach ($name in @('RLS_ENABLED_TABLES', 'RLS_GUC_ENABLED')) {
        Assert-ThrowsMatch { ConvertTo-ProductChanges (New-TestConfig @{ $name = 'true' }) } 'enable-rls-table' "RLS admission name $name must be refused."
    }
    foreach ($name in @('passpilot_rules_mode', 'Passpilot_Rules_Mode', 'classpilot_digital_usage_mode')) {
        Assert-ThrowsMatch { ConvertTo-ProductChanges (New-TestConfig @{ $name = 'on' }) } 'exact upper-case' "Case variant '$name' must be refused."
    }
    $secretConfig = [pscustomobject]@{ schemaVersion = 1; environment = [pscustomobject]@{ PASSPILOT_RULES_MODE = 'on' }
        secrets = [pscustomobject]@{ PASSPILOT_RULES_MODE = 'arn:aws:ssm:us-east-1:135775632425:parameter/test/flag' } }
    Assert-ThrowsMatch { ConvertTo-ProductChanges $secretConfig } 'must contain exactly' 'A secret channel must be refused.'
    Assert-ThrowsMatch { ConvertTo-ProductChanges (New-TestConfig @{ PASSPILOT_RULES_MODE = [pscustomobject]@{ valueFrom = 'arn:aws:ssm:us-east-1:135775632425:parameter/test/flag' } }) } 'JSON string' 'A secret reference value must be refused.'
    foreach ($value in @(1, $true, @('on'))) {
        Assert-ThrowsMatch { ConvertTo-ProductChanges (New-TestConfig @{ PASSPILOT_RULES_MODE = $value }) } 'JSON string' 'Non-string values must be refused.'
    }
    foreach ($name in @('CLASSPILOT_TODAY_SCHEDULE_MODE', 'CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE', 'PASSPILOT_RULES_MODE', 'PASSPILOT_APPOINTMENTS_MODE', 'CLASSPILOT_USAGE_ROLLUP_MODE', 'CLASSPILOT_DIGITAL_USAGE_MODE')) {
        foreach ($value in @('off', 'on', $null)) {
            Assert-Condition ((ConvertTo-ProductChanges (New-TestConfig @{ $name = $value })).Contains($name)) "$name must accept '$value'."
        }
        foreach ($value in @('ON', 'On', 'OFF', ' on', 'on ', 'true', 'false', '1', 'enabled', '', 'pilot', '*', 'shadow')) {
            Assert-ThrowsMatch { ConvertTo-ProductChanges (New-TestConfig @{ $name = $value }) } 'exact documented values' "$name must refuse '$value'."
        }
    }
    foreach ($value in @('legacy', 'shadow', 'set_based', 'on', $null)) {
        Assert-Condition ((ConvertTo-ProductChanges (New-TestConfig @{ CLASSPILOT_DAILY_USAGE_ROLLUP_MODE = $value })).Contains('CLASSPILOT_DAILY_USAGE_ROLLUP_MODE')) "The daily rollup must accept '$value'."
    }
    foreach ($value in @('off', 'SET_BASED', 'Shadow', 'setbased', 'set-based', 'On', 'promoted', '')) {
        Assert-ThrowsMatch { ConvertTo-ProductChanges (New-TestConfig @{ CLASSPILOT_DAILY_USAGE_ROLLUP_MODE = $value }) } 'exact documented values' "The daily rollup must refuse '$value'."
    }
    $ids = ConvertTo-ProductChanges (New-TestConfig @{ CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS = "$($script:SchoolA),$($script:SchoolB)" })
    Assert-Condition ($ids['CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS'] -ceq "$($script:SchoolA),$($script:SchoolB)") 'A comma-separated UUID list must parse unchanged.'
    $emptyIds = ConvertTo-ProductChanges (New-TestConfig @{ CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS = '' })
    Assert-Condition ($emptyIds.Contains('CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS') -and $null -eq $emptyIds['CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS']) 'An empty allowlist must unset the variable rather than write an empty value.'
    foreach ($value in @($script:SchoolA.ToUpperInvariant(), "$($script:SchoolA), $($script:SchoolB)", "$($script:SchoolA),", ",$($script:SchoolA)",
            "$($script:SchoolA),$($script:SchoolA)", "$($script:SchoolA);$($script:SchoolB)", 'st-francis-desales', '*', 'all', ' ',
            '11111111-1111-6111-8111-111111111111', "{$($script:SchoolA)}")) {
        Assert-ThrowsMatch { ConvertTo-ProductChanges (New-TestConfig @{ CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS = $value }) } 'exact documented values' "School list '$value' must be refused."
    }
    Assert-ThrowsMatch { ConvertTo-ProductChanges ([pscustomobject]@{ schemaVersion = 2; environment = [pscustomobject]@{ PASSPILOT_RULES_MODE = 'on' } }) } 'schemaVersion' 'Unknown schema versions must be refused.'
    Assert-ThrowsMatch { ConvertTo-ProductChanges ([pscustomobject]@{ SchemaVersion = 1; environment = [pscustomobject]@{ PASSPILOT_RULES_MODE = 'on' } }) } 'must contain exactly' 'Top-level names are exact.'
    Assert-ThrowsMatch { ConvertTo-ProductChanges ([pscustomobject]@{ schemaVersion = 1; environment = @('PASSPILOT_RULES_MODE=on') }) } 'JSON object' 'The environment must be an object.'
    Assert-ThrowsMatch { ConvertTo-ProductChanges (New-TestConfig @{}) } 'names no flag' 'An empty change set must be refused.'

    # --- Plan: read-only, frozen, hash-bound ---
    Reset-ProductMock
    $rulesConfig = New-TestConfig @{ PASSPILOT_RULES_MODE = 'on' }
    Assert-ThrowsMatch { New-TestProductPlan $rulesConfig } 'passpilot_destination_policies' 'Rules activation must require its RLS bundle.'
    Assert-NoMutation 'A refused plan must not mutate anything.'
    Add-BothTables $script:RulesTables
    $plan = New-TestProductPlan $rulesConfig
    Assert-NoMutation 'Planning must not register, update, lock or hold anything.'
    Assert-Condition (@($plan.plan.activations) -ceq 'passpilotRules' -and @($plan.plan.activations).Count -eq 1) 'The plan must name its single activation.'
    Assert-Condition (@($plan.plan.changes).Count -eq 1 -and $null -eq $plan.plan.changes[0].from -and $plan.plan.changes[0].to -ceq 'on') 'The plan must show the reviewed change.'
    Assert-Condition ($null -eq $plan.plan.dailyUsageEvidence) 'No evidence is bound when nothing is promoted.'
    $loaded = Read-ProductPlan $plan.path $plan.sha256
    Assert-Condition ($loaded.runId -ceq $plan.plan.runId -and $loaded.desired.PASSPILOT_RULES_MODE -ceq 'on' -and $null -eq $loaded.prior.PASSPILOT_RULES_MODE) 'A valid frozen plan must load.'
    Assert-ThrowsMatch { Read-ProductPlan $plan.path ('e' * 64) } 'hash mismatch' 'A mismatched plan hash must fail.'
    Assert-ThrowsMatch { Read-ProductPlan $plan.path $plan.sha256.ToUpperInvariant() } 'hash mismatch' 'Plan hashes are exact lower-case hex.'
    $bytes = [IO.File]::ReadAllBytes($plan.path)
    $tamperedPath = Join-Path $script:TestDirectory 'tampered-plan.json'
    [IO.File]::WriteAllBytes($tamperedPath, $bytes + [byte[]](0x0a))
    Assert-ThrowsMatch { Read-ProductPlan $tamperedPath $plan.sha256 } 'hash mismatch' 'A one-byte change must break the reviewed hash.'
    foreach ($tamper in @(
            @{ Pattern = 'internally inconsistent'; Edit = { param($p) $p.desired.PASSPILOT_APPOINTMENTS_MODE = 'on' } },
            @{ Pattern = 'internally inconsistent'; Edit = { param($p) $p.config.environment.PASSPILOT_RULES_MODE = 'off'; $p.changes[0].to = 'off' } },
            @{ Pattern = 'internally inconsistent'; Edit = { param($p) $p.activations = @() } },
            @{ Pattern = 'internally inconsistent'; Edit = { param($p) $p.changes = @() } },
            @{ Pattern = 'evidence binding'; Edit = { param($p) $p.dailyUsageEvidence = [pscustomobject]@{ path = 'C:\evidence.json'; sha256 = ('c' * 64) } } },
            @{ Pattern = 'not a product runtime plan'; Edit = { param($p) $p.tool = 'deploy-mydesk-runtime-config' } },
            @{ Pattern = 'must contain exactly'; Edit = { param($p) $p | Add-Member extra 'field' } },
            @{ Pattern = 'Tool SHA drift'; Edit = { param($p) $p.toolSha = 'c' * 40 } })) {
        $copy = (Read-StrictJsonSnapshot -Path $plan.path).Value
        & $tamper.Edit $copy
        Write-SanitizedJson $tamperedPath $copy
        $tamperedHash = Get-FileSha256 $tamperedPath
        Assert-ThrowsMatch { Read-ProductPlan $tamperedPath $tamperedHash } $tamper.Pattern 'A re-hashed tampered plan must still be refused.'
    }
    Assert-NoMutation 'Reading plans must never mutate.'

    # --- Apply: exact clone of both services, API first ---
    $sourceApi = Copy-TestValue (Get-TestTask 'api')
    $sourceWorker = Copy-TestValue (Get-TestTask 'worker')
    $result = Invoke-ProductApply $loaded $plan.sha256 $script:TestDirectory
    Assert-Condition ($result.status -ceq 'applied' -and $script:Mock.Requests.Count -eq 2) 'Apply must register exactly the API/worker pair.'
    Assert-Condition (-not $script:OperationLockHeld -and -not $script:ScalingHoldAcquired) 'Apply must release the fence and restore scaling.'
    $order = @($script:Mock.Calls | Where-Object { $_ -like 'update:*' -or $_ -ceq 'wait' }) -join ','
    Assert-Condition ($order -ceq 'update:Api,wait,update:Worker,wait') 'API convergence must precede the worker rollout.'
    foreach ($entry in @(@($sourceApi, 'api', $result.apiArn), @($sourceWorker, 'scheduler-worker', $result.workerArn))) {
        $registered = $script:Mock.Tasks[$entry[2]]
        Assert-Condition ((Get-TaskFingerprint $entry[0].taskDefinition $entry[1]) -ceq (Get-TaskFingerprint $registered.taskDefinition $entry[1])) 'Apply must preserve image, RLS, sizes, IAM, secrets and unrelated environment.'
        Assert-Condition ((Get-TaskTagsFingerprint $entry[0].tags) -ceq (Get-TaskTagsFingerprint $registered.tags)) 'Apply must preserve tags.'
        Assert-Condition ((Get-CanonicalJsonSha256 @($entry[0].taskDefinition.containerDefinitions[0].secrets | Sort-Object name)) -ceq (Get-CanonicalJsonSha256 @($registered.taskDefinition.containerDefinitions[0].secrets | Sort-Object name))) 'Apply must never touch a secret, including the parked TURN reference.'
        foreach ($name in @('CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1', 'CLASSPILOT_CAPABILITY_ROLLOUTS_JSON', 'CLASSPILOT_TURN_HOSTS', 'MYDESK_MODE', 'RLS_ENABLED_TABLES')) {
            Assert-Condition ((Get-TestEnvironmentValue $registered $name) -ceq (Get-TestEnvironmentValue $entry[0] $name)) "Apply must leave $name unchanged."
        }
    }
    $apiState = Get-ServingState 'Api'; $workerState = Get-ServingState 'Worker'
    Assert-Condition ($apiState['PASSPILOT_RULES_MODE'] -ceq 'on' -and (Get-CanonicalJsonSha256 $apiState) -ceq (Get-CanonicalJsonSha256 $workerState)) 'API and worker must serve identical managed values.'
    Assert-Condition (@($apiState.Keys | Where-Object { $_ -cne 'PASSPILOT_RULES_MODE' -and $null -ne $apiState[$_] }).Count -eq 0) 'Names the configuration did not list must stay unset.'
    Assert-ThrowsMatch { Invoke-ProductApply $loaded $plan.sha256 $script:TestDirectory } 'already has a receipt|drifted|stable' 'A plan must not apply twice.'

    # --- Rollback restores the exact prior values ---
    Invoke-TestRollback $plan
    Assert-Condition ($script:Mock.Requests.Count -eq 4) 'Rollback must register exactly one new pair.'
    foreach ($role in @('Api', 'Worker')) {
        $state = Get-ServingState $role
        Assert-Condition ($null -eq $state['PASSPILOT_RULES_MODE']) 'Rollback must restore an unset prior value as unset.'
        $response = $script:Mock.Tasks[$script:Mock.Services.$role.taskDefinition]
        Assert-Condition ($response.taskDefinition.containerDefinitions[0].image.EndsWith($script:TestDigest)) 'Rollback must retain the serving image digest.'
        Assert-Condition ((Get-TestEnvironmentValue $response 'MYDESK_MODE') -ceq 'on') 'Rollback must leave unrelated names unchanged.'
    }
    Assert-Condition (-not $script:OperationLockHeld -and -not $script:ScalingHoldAcquired) 'Rollback must release the fence and scaling.'

    # A rollback that would re-enable something needs a reviewed new plan.
    Reset-ProductMock; Add-BothTables $script:RulesTables; Set-BothEnvironment 'PASSPILOT_RULES_MODE' 'on'
    $offPlan = New-TestProductPlan (New-TestConfig @{ PASSPILOT_RULES_MODE = 'off' })
    Assert-Condition (@($offPlan.plan.activations).Count -eq 0) 'Turning a feature off is not an activation.'
    Assert-Condition ((Invoke-ProductApply $offPlan.plan $offPlan.sha256 $script:TestDirectory).status -ceq 'applied') 'Turn-off must apply.'
    Assert-ThrowsMatch { Invoke-TestRollback $offPlan } 'cannot activate' 'Rollback must never re-enable a disabled feature.'
    Assert-Condition ($script:Mock.Requests.Count -eq 2) 'A refused rollback must not register anything.'

    # A turn-off is never blocked by an activation precondition.
    Reset-ProductMock; Set-BothEnvironment 'PASSPILOT_RULES_MODE' 'on'; Set-BothEnvironment 'RLS_GUC_ENABLED' 'false'
    Assert-Condition ($null -ne (New-TestProductPlan (New-TestConfig @{ PASSPILOT_RULES_MODE = 'off' }))) 'An emergency turn-off must plan even without RLS admission.'

    # --- RLS admission preconditions, per gate, per service ---
    foreach ($gate in @(
            @{ Name = 'CLASSPILOT_TODAY_SCHEDULE_MODE'; Config = @{ CLASSPILOT_TODAY_SCHEDULE_MODE = 'on' }; Tables = @('classpilot_today_changes', 'classpilot_today_occurrences'); Live = @{} },
            @{ Name = 'PASSPILOT_RULES_MODE'; Config = @{ PASSPILOT_RULES_MODE = 'on' }; Tables = $script:RulesTables; Live = @{} },
            @{ Name = 'PASSPILOT_APPOINTMENTS_MODE'; Config = @{ PASSPILOT_APPOINTMENTS_MODE = 'on' }; Tables = @('passpilot_appointments'); Live = @{} },
            @{ Name = 'CLASSPILOT_USAGE_ROLLUP_MODE'; Config = @{ CLASSPILOT_USAGE_ROLLUP_MODE = 'on' }; Tables = @('classpilot_usage_rollups', 'classpilot_usage_rollup_days'); Live = @{} },
            @{ Name = 'CLASSPILOT_DIGITAL_USAGE_MODE'; Config = @{ CLASSPILOT_DIGITAL_USAGE_MODE = 'on' }; Tables = @('classpilot_usage_rollups', 'classpilot_usage_rollup_days'); Live = @{ CLASSPILOT_USAGE_ROLLUP_MODE = 'on' } })) {
        $prepare = {
            Reset-ProductMock
            foreach ($live in $gate.Live.GetEnumerator()) { Set-BothEnvironment $live.Key $live.Value }
            Add-BothTables $gate.Tables
            if ($gate.Name -ceq 'PASSPILOT_APPOINTMENTS_MODE') { Set-BothEnvironment 'RLS_ENABLED_TABLES' ($script:AppointmentTables -join ',') }
        }
        foreach ($table in $gate.Tables) {
            foreach ($role in @('api', 'worker')) {
                & $prepare; Remove-TestTable $role $table
                Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig $gate.Config) } "$($gate.Name)=on requires .*RLS_ENABLED_TABLES" "$($gate.Name) must require $table on the $role."
            }
        }
        foreach ($case in @(@('api', 'false'), @('worker', 'TRUE'), @('worker', $null))) {
            & $prepare; Set-TestEnvironment (Get-TestTask $case[0]) 'RLS_GUC_ENABLED' $case[1]
            Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig $gate.Config) } 'RLS_GUC_ENABLED=true' "$($gate.Name) must require RLS_GUC_ENABLED=true on the $($case[0])."
        }
        & $prepare; Set-TestEnvironment (Get-TestTask 'api') 'RLS_ENABLED_TABLES' $null
        Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig $gate.Config) } 'RLS_ENABLED_TABLES allowlist' "$($gate.Name) must require an allowlist."
        & $prepare
        $usageEvidence = if ($gate.Name -ceq 'CLASSPILOT_DIGITAL_USAGE_MODE') { Write-TestEvidence (New-TestUsageObservation) } else { $null }
        $admitted = New-TestProductPlan (New-TestConfig $gate.Config) $null $usageEvidence
        Assert-Condition (@($admitted.plan.activations).Count -eq 1) "$($gate.Name) must plan once its bundle is admitted on both services."
        Assert-NoMutation 'Precondition checks must be read-only.'
    }
    # Preconditions are re-checked at Apply against the live task definitions.
    Reset-ProductMock; Set-BothEnvironment 'RLS_ENABLED_TABLES' ($script:AppointmentTables -join ',')
    $appointmentConfig = New-TestConfig @{ PASSPILOT_APPOINTMENTS_MODE = 'on' }
    $appointmentPlan = New-TestProductPlan $appointmentConfig
    $script:Mock.CompatibleAppointmentWriter = $false
    Assert-ThrowsMatch { New-TestProductPlan $appointmentConfig } 'atomic writer contract version 2' 'Admitted tables cannot enable a pre-eligibility-lock serving image.'
    Assert-ThrowsMatch { Invoke-ProductApply $appointmentPlan.plan $appointmentPlan.sha256 $script:TestDirectory } 'atomic writer contract version 2' 'Apply must recheck atomic compatibility before any mutation.'
    Assert-NoMutation 'Incompatible appointment image must fail before registration or service mutation.'
    Set-BothEnvironment 'PASSPILOT_APPOINTMENTS_MODE' 'on'
    Assert-Condition ($null -ne (New-TestProductPlan (New-TestConfig @{ PASSPILOT_APPOINTMENTS_MODE = 'off' }))) 'Emergency appointment turn-off must remain possible on an older image.'
    Reset-ProductMock; Set-BothEnvironment 'RLS_ENABLED_TABLES' ($script:AppointmentTables -join ',')
    Set-BothEnvironment 'PASSPILOT_APPOINTMENTS_MODE' 'on'; Remove-TestTable 'worker' 'classpilot_usage_rollup_days'
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE = 'on' }) } '128-table admission' 'Continuing appointment activation requires every preserved admission on the worker.'
    Reset-ProductMock; Add-BothTables $script:RulesTables
    $plan = New-TestProductPlan $rulesConfig
    Remove-TestTable 'worker' 'passpilot_pass_denials'
    Assert-ThrowsMatch { Invoke-ProductApply $plan.plan $plan.sha256 $script:TestDirectory } 'PASSPILOT_RULES_MODE=on requires' 'Apply must re-check RLS admission.'
    Assert-NoMutation 'A failed Apply precondition must not mutate.'

    # Reports require the serving confidentiality/aggregate contract and full
    # admission at both Plan and Apply, even when v2 is already active.
    Reset-ProductMock; Set-BothEnvironment 'RLS_ENABLED_TABLES' ($script:AppointmentTables -join ',')
    $reportsConfig = New-TestConfig @{ PASSPILOT_REPORTS_MODE = 'v2' }
    $reportsPlan = New-TestProductPlan $reportsConfig
    Assert-Condition ('passpilotReports' -cin @($reportsPlan.plan.activations)) 'Reports must be an explicit governed activation.'
    $script:Mock.CompatibleReportsWriter = $false
    Assert-ThrowsMatch { New-TestProductPlan $reportsConfig } 'report contract version 2' 'Plan must reject a pre-contract report projection.'
    Assert-ThrowsMatch { Invoke-ProductApply $reportsPlan.plan $reportsPlan.sha256 $script:TestDirectory } 'report contract version 2' 'Apply must recheck report compatibility.'
    Assert-NoMutation 'An incompatible report image cannot mutate task definitions.'
    $script:Mock.CompatibleReportsWriter = $true; $script:Mock.CompatibleReportAuthority = $false
    Assert-ThrowsMatch { New-TestProductPlan $reportsConfig } 'authority-fence version 1' 'Plan must reject pre-fix 7c/d01 report source with only the v2 wire marker.'
    Assert-ThrowsMatch { Invoke-ProductApply $reportsPlan.plan $reportsPlan.sha256 $script:TestDirectory } 'authority-fence version 1' 'Apply must reject loss of the verified authority fence.'
    Assert-NoMutation 'A pre-fix v2 report image cannot mutate task definitions.'
    Set-BothEnvironment 'PASSPILOT_REPORTS_MODE' 'v2'
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE = 'on' }) } 'authority-fence version 1' 'Continuing v2 must reject pre-fix source as well as first activation.'
    Set-BothEnvironment 'PASSPILOT_REPORTS_MODE' 'v2'; Set-BothEnvironment 'RLS_GUC_ENABLED' 'false'
    Assert-Condition ($null -ne (New-TestProductPlan (New-TestConfig @{ PASSPILOT_REPORTS_MODE = 'off' }))) 'Reports emergency turn-off must remain available.'
    foreach ($role in @('api', 'worker')) {
        foreach ($table in @('passes', 'passpilot_pass_denials', 'passpilot_appointments', 'classpilot_usage_rollup_days')) {
            Reset-ProductMock; Set-BothEnvironment 'RLS_ENABLED_TABLES' ($script:AppointmentTables -join ','); Remove-TestTable $role $table
            Assert-ThrowsMatch { New-TestProductPlan $reportsConfig } '128-table admission' "Reports must preserve $table admission on $role."
        }
    }
    Reset-ProductMock; Set-BothEnvironment 'RLS_ENABLED_TABLES' ($script:AppointmentTables -join ','); Set-BothEnvironment 'PASSPILOT_REPORTS_MODE' 'v2'
    Remove-TestTable 'worker' 'students'
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE = 'on' }) } '128-table admission' 'Keeping v2 on must recheck admission.'

    # --- Digital usage requires the usage rollup ---
    Reset-ProductMock; Add-BothTables @('classpilot_usage_rollups', 'classpilot_usage_rollup_days')
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ CLASSPILOT_DIGITAL_USAGE_MODE = 'on' }) } 'requires CLASSPILOT_USAGE_ROLLUP_MODE=on' 'Digital usage alone must be refused.'
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ CLASSPILOT_DIGITAL_USAGE_MODE = 'on'; CLASSPILOT_USAGE_ROLLUP_MODE = 'off' }) } 'requires CLASSPILOT_USAGE_ROLLUP_MODE=on' 'Digital usage with the rollup off must be refused.'
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ CLASSPILOT_USAGE_ROLLUP_MODE = 'on'; CLASSPILOT_DIGITAL_USAGE_MODE = 'on' }) } 'worker first' 'Digital Usage cannot activate in the same operation as its unobserved worker.'
    Set-BothEnvironment 'CLASSPILOT_USAGE_ROLLUP_MODE' 'on'
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ CLASSPILOT_DIGITAL_USAGE_MODE = 'on' }) } 'UsageObservationEvidencePath' 'Digital Usage activation requires operating evidence even with the worker on.'
    $usageObservationPath = Write-TestEvidence (New-TestUsageObservation)
    $both = New-TestProductPlan (New-TestConfig @{ CLASSPILOT_DIGITAL_USAGE_MODE = 'on' }) $null $usageObservationPath
    Assert-Condition ('digitalUsage' -cin @($both.plan.activations) -and $null -ne $both.plan.usageObservationEvidence) 'Digital Usage must bind operating evidence separately from daily shadow promotion.'
    $script:Mock.CompatibleUsageWriter = $false
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ CLASSPILOT_DIGITAL_USAGE_MODE = 'on' }) } 'coverage contract version 1' 'Plan must reject a pre-ledger serving SHA even with both admissions.'
    Assert-ThrowsMatch { Invoke-ProductApply $both.plan $both.sha256 $script:TestDirectory } 'coverage contract version 1' 'Apply must re-check source compatibility before mutation.'
    Assert-NoMutation 'An incompatible serving release must not mutate.'
    $script:Mock.CompatibleUsageWriter = $true
    Set-BothEnvironment 'CLASSPILOT_USAGE_ROLLUP_MODE' 'on'; Set-BothEnvironment 'CLASSPILOT_DIGITAL_USAGE_MODE' 'on'
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ CLASSPILOT_USAGE_ROLLUP_MODE = 'off' }) } 'requires CLASSPILOT_USAGE_ROLLUP_MODE=on' 'The rollup cannot turn off under live digital usage.'
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ CLASSPILOT_USAGE_ROLLUP_MODE = $null }) } 'requires CLASSPILOT_USAGE_ROLLUP_MODE=on' 'The rollup cannot be unset under live digital usage.'
    Remove-TestTable 'api' 'classpilot_usage_rollups'
    $offBoth = New-TestProductPlan (New-TestConfig @{ CLASSPILOT_USAGE_ROLLUP_MODE = 'off'; CLASSPILOT_DIGITAL_USAGE_MODE = 'off' })
    Assert-Condition (@($offBoth.plan.activations).Count -eq 0) 'Turning both off must plan without preconditions.'

    # A complete, source-matched observed day is mandatory; empty measured days
    # still require successful ledger coverage and hourly worker samples.
    Reset-ProductMock; Add-BothTables @('classpilot_usage_rollups', 'classpilot_usage_rollup_days'); Set-BothEnvironment 'CLASSPILOT_USAGE_ROLLUP_MODE' 'on'
    $usageConfig = New-TestConfig @{ CLASSPILOT_DIGITAL_USAGE_MODE = 'on' }
    foreach ($case in @(
            @{ Property = 'appSha'; Value = ('f' * 40); Pattern = 'exact serving' },
            @{ Property = 'imageDigest'; Value = ('sha256:' + ('f' * 64)); Pattern = 'exact serving' },
            @{ Property = 'schoolDays'; Value = @(); Pattern = 'complete school day' },
            @{ Property = 'reviewedAt'; Value = [DateTimeOffset]::UtcNow.AddDays(-2).ToString('o'); Pattern = 'hours old' })) {
        $invalid = New-TestUsageObservation; $invalid.($case.Property) = $case.Value
        Assert-ThrowsMatch { New-TestProductPlan $usageConfig $null (Write-TestEvidence $invalid) } $case.Pattern 'Invalid observation source or review must fail before mutation.'
    }
    foreach ($case in @(
            @{ Property = 'observedRuns'; Value = 0 }, @{ Property = 'failedSchools'; Value = 1 }, @{ Property = 'deferredDays'; Value = 1 },
            @{ Property = 'budgetExhausted'; Value = $true }, @{ Property = 'maxRunDurationMs'; Value = 1500000 },
            @{ Property = 'finalDayComplete'; Value = $false }, @{ Property = 'currentDayComplete'; Value = $false },
            @{ Property = 'logSha256'; Value = '' }, @{ Property = 'coverageSha256'; Value = '' })) {
        $invalid = New-TestUsageObservation; $invalid.schoolDays[0].($case.Property) = $case.Value
        Assert-ThrowsMatch { New-TestProductPlan $usageConfig $null (Write-TestEvidence $invalid) } 'hourly samples' 'Failed, deferred or unverified days must not become accepted observations.'
    }
    $invalid = New-TestUsageObservation; $invalid.schoolDays += $invalid.schoolDays[0]
    Assert-ThrowsMatch { New-TestProductPlan $usageConfig $null (Write-TestEvidence $invalid) } 'distinct canonical' 'Duplicate observation dates cannot supply additional acceptance.'
    $invalid = New-TestUsageObservation; $invalid.schoolDays[0].startedAt = $invalid.schoolDays[0].endedAt
    Assert-ThrowsMatch { New-TestProductPlan $usageConfig $null (Write-TestEvidence $invalid) } 'full recent' 'A partial-day observation must be rejected.'
    Assert-NoMutation 'Rejected operating observations must not register or update services.'
    $validUsage = New-TestUsageObservation; $usageObservationPath = Write-TestEvidence $validUsage
    $usagePlan = New-TestProductPlan $usageConfig $null $usageObservationPath
    $validUsage.schoolDays[0].maxRunDurationMs = 11000; Write-SanitizedJson $usageObservationPath $validUsage
    Assert-ThrowsMatch { Invoke-ProductApply $usagePlan.plan $usagePlan.sha256 $script:TestDirectory } 'changed after planning' 'Apply must rehash the operating evidence before any mutation.'
    Assert-NoMutation 'Changed operating evidence must fail before registration.'
    $usageObservationPath = Write-TestEvidence (New-TestUsageObservation)
    $usagePlan = New-TestProductPlan $usageConfig $null $usageObservationPath
    Assert-Condition ((Invoke-ProductApply $usagePlan.plan $usagePlan.sha256 $script:TestDirectory).status -ceq 'applied') 'A complete clean observed day must permit governed reporting activation.'
    Invoke-TestRollback $usagePlan
    Assert-Condition ($null -eq (Get-ServingState 'Api')['CLASSPILOT_DIGITAL_USAGE_MODE']) 'Observation-gated activation rollback must restore reporting off.'
    Reset-ProductMock
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ PASSPILOT_RULES_MODE = 'off' }) $null $usageObservationPath } 'only to Digital Usage' 'Unrelated plans must refuse observation evidence.'

    # Schema 2 changes only the qualifying scheduler window. Full calendar-day
    # exports, source/freshness, all error counters and final/live proof remain.
    Reset-ProductMock; Add-BothTables @('classpilot_usage_rollups', 'classpilot_usage_rollup_days'); Set-BothEnvironment 'CLASSPILOT_USAGE_ROLLUP_MODE' 'on'
    $instructional = New-TestInstructionalUsageObservation
    $instructionalPath = Write-TestEvidence $instructional
    $instructionalPlan = New-TestProductPlan $usageConfig $null $instructionalPath
    Assert-Condition ($instructionalPlan.plan.usageObservationEvidence.sha256 -ceq (Get-FileSha256 $instructionalPath)) 'Instructional acceptance must bind the exact schema-2 evidence bytes.'
    Assert-NoMutation 'Instructional evidence planning remains read-only.'
    $legacy = New-TestUsageObservation; $legacy.schoolDays[0].observedRuns = 15
    Assert-ThrowsMatch { New-TestProductPlan $usageConfig $null (Write-TestEvidence $legacy) } 'hourly samples' 'Schema 1 must still require every calendar-day tick.'
    $legacy = New-TestInstructionalUsageObservation; $legacy.schemaVersion = 1
    Assert-ThrowsMatch { New-TestProductPlan $usageConfig $null (Write-TestEvidence $legacy) } 'must contain exactly' 'Schema 1 must not silently accept instructional fields.'
    foreach ($change in @(
            { param($w) $w.PSObject.Properties.Remove('observedFrom') },
            { param($w) $w | Add-Member optionalOverride $true },
            { param($w) $w.startedAt = $w.startedAt.Replace('Z', '+00:00') },
            { param($w) $w.usageOnCompletedAt = ([DateTimeOffset]::Parse($w.observedFrom).AddTicks(1)).ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'") },
            { param($w) $w.observedFrom = $w.endedAt },
            { param($w) $w.startedAt = $w.endedAt },
            { param($w) $w.observedThrough = $w.startedAt },
            { param($w) $w.confirmationReference = 'unconfirmed class day' })) {
        $invalid = New-TestInstructionalUsageObservation; & $change $invalid.schoolDays[0].instructionalWindow
        Assert-ThrowsMatch { New-TestProductPlan $usageConfig $null (Write-TestEvidence $invalid) } 'instructional window' 'Unconfirmed, partial, late-activation or malformed class windows must refuse.'
    }
    $invalid = New-TestInstructionalUsageObservation
    $invalid.schoolDays[0].instructionalWindow.observedFrom = ([DateTimeOffset]::Parse($invalid.schoolDays[0].startedAt).AddTicks(-1)).ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'")
    Assert-ThrowsMatch { New-TestProductPlan $usageConfig $null (Write-TestEvidence $invalid) } 'instructional window' 'Attended observation cannot start outside the watched local date.'
    $invalid = New-TestInstructionalUsageObservation
    $invalid.schoolDays[0].instructionalWindow.observedThrough = ([DateTimeOffset]::Parse($invalid.schoolDays[0].endedAt)).ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'")
    Assert-ThrowsMatch { New-TestProductPlan $usageConfig $null (Write-TestEvidence $invalid) } 'instructional window' 'Class observation cannot extend into the following local date.'
    foreach ($change in @(
            { param($d) $d.requiredHourlyBuckets = @($d.requiredHourlyBuckets | Select-Object -Skip 1) },
            { param($d) $d.requiredHourlyBuckets[1] = $d.requiredHourlyBuckets[0] },
            { param($d) [array]::Reverse($d.requiredHourlyBuckets) },
            { param($d) $d.requiredHourlyBuckets[0] = $d.requiredHourlyBuckets[0].Replace('.000Z', '.0000000Z') },
            { param($d) $d.requiredHourlyBuckets[0] = $d.requiredHourlyBuckets[0].Replace('Z', '+00:00') },
            { param($d) $d.requiredHourlyBuckets = 'not-an-array' })) {
        $invalid = New-TestInstructionalUsageObservation; & $change $invalid.schoolDays[0]
        Assert-ThrowsMatch { New-TestProductPlan $usageConfig $null (Write-TestEvidence $invalid) } 'instructional hourly buckets' 'Omitted, duplicate, reordered or noncanonical scheduler bucket IDs must refuse.'
    }
    foreach ($case in @(
            @{ Property = 'observedRuns'; Value = 14 }, @{ Property = 'observedRuns'; Value = 25 }, @{ Property = 'observedRuns'; Value = '15' },
            @{ Property = 'failedSchools'; Value = 1 }, @{ Property = 'deferredDays'; Value = 1 }, @{ Property = 'budgetExhausted'; Value = $true },
            @{ Property = 'maxRunDurationMs'; Value = 1500000 }, @{ Property = 'finalDayComplete'; Value = $false }, @{ Property = 'currentDayComplete'; Value = $false })) {
        $invalid = New-TestInstructionalUsageObservation; $invalid.schoolDays[0].($case.Property) = $case.Value
        Assert-ThrowsMatch { New-TestProductPlan $usageConfig $null (Write-TestEvidence $invalid) } 'hourly samples' 'Schema 2 must preserve counters, duration and ledger guards and require the exact derived run count.'
    }
    $invalid = New-TestInstructionalUsageObservation; $invalid.schoolDays[0].startedAt = $invalid.schoolDays[0].instructionalWindow.observedFrom
    Assert-ThrowsMatch { New-TestProductPlan $usageConfig $null (Write-TestEvidence $invalid) } 'full recent' 'Instructional acceptance must still export the full calendar day.'
    $invalid = New-TestInstructionalUsageObservation; $invalid.appSha = 'f' * 40
    Assert-ThrowsMatch { New-TestProductPlan $usageConfig $null (Write-TestEvidence $invalid) } 'exact serving' 'Schema 2 must preserve serving source binding.'
    $invalid = New-TestInstructionalUsageObservation; $invalid.reviewedAt = [DateTimeOffset]::UtcNow.AddHours(-3).ToString('o')
    Assert-ThrowsMatch { New-TestProductPlan $usageConfig $null (Write-TestEvidence $invalid) } 'hours old' 'Schema 2 must preserve fresh reviews.'
    Assert-NoMutation 'Every refused instructional observation must precede runtime mutation.'
    $instructional.schoolDays[0].instructionalWindow.confirmationReference = 'human/review-reference-changed'
    Write-SanitizedJson $instructionalPath $instructional
    Assert-ThrowsMatch { Invoke-ProductApply $instructionalPlan.plan $instructionalPlan.sha256 $script:TestDirectory } 'changed after planning' 'Apply must rehash schema-2 window evidence before mutation.'
    Assert-NoMutation 'Changed instructional evidence must not register or update services.'

    # UTC scheduler ceilings must survive fractional ticks and half-hour DST.
    $window = [pscustomobject]@{ startedAt = '2026-10-23T14:00:00.0000001Z'; endedAt = '2026-10-23T19:45:00Z'; usageOnCompletedAt = '2026-10-23T13:05:34Z'; observedFrom = '2026-10-23T13:15:00Z'; observedThrough = '2026-10-23T19:45:00Z'; confirmationReference = 'human/submillisecond-start' }
    $buckets = Get-UsageInstructionalHourlyBuckets ([DateTimeOffset]'2026-10-23T04:00:00Z') ([DateTimeOffset]'2026-10-24T04:00:00Z') $window
    Assert-Condition ($buckets.Count -eq 14 -and $buckets[0] -ceq '2026-10-23T15:00:00.000Z' -and $buckets[-1] -ceq '2026-10-24T04:00:00.000Z') 'Sub-millisecond starts must not round down to an earlier scheduler hour.'
    $window.startedAt = '2026-10-03T22:15:00Z'; $window.endedAt = '2026-10-04T04:45:00Z'; $window.usageOnCompletedAt = '2026-10-03T22:05:34Z'; $window.observedFrom = $window.startedAt; $window.observedThrough = $window.endedAt
    $buckets = Get-UsageInstructionalHourlyBuckets ([DateTimeOffset]'2026-10-03T13:30:00Z') ([DateTimeOffset]'2026-10-04T13:00:00Z') $window
    Assert-Condition ($buckets.Count -eq 15 -and $buckets[0] -ceq '2026-10-03T23:00:00.000Z' -and $buckets[-1] -ceq '2026-10-04T13:00:00.000Z') 'A 23.5-hour Lord Howe day must derive actual UTC scheduler IDs.'

    # --- Daily usage rollup promotion requires clean shadow evidence ---
    Reset-ProductMock
    $promote = New-TestConfig @{ CLASSPILOT_DAILY_USAGE_ROLLUP_MODE = 'on' }
    Assert-ThrowsMatch { New-TestProductPlan $promote } 'DailyUsageEvidencePath' 'Promotion to on must require evidence.'
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ CLASSPILOT_DAILY_USAGE_ROLLUP_MODE = 'set_based' }) } 'DailyUsageEvidencePath' 'Promotion to set_based must require evidence.'
    $evidence = New-TestEvidence
    $evidencePath = Write-TestEvidence $evidence
    $promotePlan = New-TestProductPlan $promote $evidencePath
    Assert-Condition ($promotePlan.plan.dailyUsageEvidence.sha256 -ceq (Get-FileSha256 $evidencePath) -and 'dailyUsageRollupPromotion' -cin @($promotePlan.plan.activations)) 'Evidence must be hash-bound into the plan.'
    Assert-Condition ((Read-ProductPlan $promotePlan.path $promotePlan.sha256).dailyUsageEvidence.path -ceq $evidencePath) 'The evidence binding must survive the plan file.'
    $today = (Get-EasternNow).Date
    $saturday = $today.AddDays(-1); while ($saturday.DayOfWeek -ne [DayOfWeek]::Saturday) { $saturday = $saturday.AddDays(-1) }
    $oldWeekday = $today.AddDays(-45); while ($oldWeekday.DayOfWeek -in @([DayOfWeek]::Saturday, [DayOfWeek]::Sunday)) { $oldWeekday = $oldWeekday.AddDays(-1) }
    $invariant = [Globalization.CultureInfo]::InvariantCulture
    foreach ($mutation in @(
            @('at least three school days', { param($e) $e.schoolDays = @($e.schoolDays[0], $e.schoolDays[1]) }),
            @('Every evidence day needs', { param($e) $e.schoolDays[0].shadowMismatches = 1 }),
            @('Every evidence day needs', { param($e) $e.schoolDays[1].failedSchools = 1 }),
            @('Every evidence day needs', { param($e) $e.schoolDays[2].processedSchools = 0 }),
            @('Every evidence day needs', { param($e) $e.schoolDays[0].shadowMismatches = '0' }),
            @('Every evidence day needs', { param($e) $e.schoolDays[0].processedSchools = 1.5 }),
            @('distinct weekdays', { param($e) $e.schoolDays[0].date = $saturday.ToString('yyyy-MM-dd', $invariant) }),
            @('distinct weekdays', { param($e) $e.schoolDays[1].date = $e.schoolDays[0].date }),
            @('distinct weekdays', { param($e) $e.schoolDays[0].date = $today.ToString('yyyy-MM-dd', $invariant) }),
            @('distinct weekdays', { param($e) $e.schoolDays[0].date = $oldWeekday.ToString('yyyy-MM-dd', $invariant) }),
            @('distinct weekdays', { param($e) $e.schoolDays[0].date = '2026-13-01' }),
            @('distinct weekdays', { param($e) $e.schoolDays[0].date = $e.schoolDays[0].date.Replace('-', '/') }),
            @('evidence day must contain exactly', { param($e) $e.schoolDays[0] | Add-Member mode 'shadow' }),
            @('two hours old', { param($e) $e.reviewedAt = [DateTimeOffset]::UtcNow.AddHours(-3).ToString('o') }),
            @('ISO-8601', { param($e) $e.reviewedAt = $today.ToString('yyyy-MM-dd', $invariant) }),
            @('serving image digest', { param($e) $e.imageDigest = 'sha256:' + ('c' * 64) }),
            @('name its review', { param($e) $e.reviewReference = 'reviewed by me' }),
            @('schemaVersion 1', { param($e) $e.schemaVersion = 2 }),
            @('evidence must contain exactly', { param($e) $e | Add-Member notes 'extra' }),
            @('evidence must contain exactly', { param($e) $e.PSObject.Properties.Remove('schoolDays') }))) {
        $bad = Copy-TestValue $evidence
        & $mutation[1] $bad
        $badPath = Write-TestEvidence $bad
        Assert-ThrowsMatch { New-TestProductPlan $promote $badPath } $mutation[0] "Incomplete or failing daily-usage evidence must block promotion ($($mutation[0]))."
    }
    Assert-NoMutation 'Evidence review must be read-only.'
    $evidence.reviewReference = 'logs-insights/changed-after-plan'; Write-SanitizedJson $evidencePath $evidence
    Assert-ThrowsMatch { Invoke-ProductApply $promotePlan.plan $promotePlan.sha256 $script:TestDirectory } 'changed after planning' 'Evidence changed after planning must block Apply.'
    Assert-NoMutation 'Rejected evidence must never register task definitions.'
    $promotePlan = New-TestProductPlan $promote $evidencePath
    $promoted = Invoke-ProductApply $promotePlan.plan $promotePlan.sha256 $script:TestDirectory
    Assert-Condition ($promoted.status -ceq 'applied' -and (Get-ServingState 'Worker')['CLASSPILOT_DAILY_USAGE_ROLLUP_MODE'] -ceq 'on' -and (Get-ServingState 'Api')['CLASSPILOT_DAILY_USAGE_ROLLUP_MODE'] -ceq 'on') 'Clean evidence must allow the promotion on both services.'
    Invoke-TestRollback $promotePlan
    Assert-Condition ($null -eq (Get-ServingState 'Worker')['CLASSPILOT_DAILY_USAGE_ROLLUP_MODE']) 'Rolling back a promotion must restore the unset shadow default.'
    Reset-ProductMock; Set-BothEnvironment 'CLASSPILOT_DAILY_USAGE_ROLLUP_MODE' 'legacy'
    Assert-ThrowsMatch { New-TestProductPlan $promote $evidencePath } 'only from shadow' 'Legacy mode never measured mismatches, so it cannot be promoted.'
    Reset-ProductMock; Set-BothEnvironment 'CLASSPILOT_DAILY_USAGE_ROLLUP_MODE' 'shadow'
    Assert-Condition ($null -ne (New-TestProductPlan $promote $evidencePath).plan.dailyUsageEvidence) 'An explicit shadow mode can be promoted with evidence.'
    Reset-ProductMock; Set-BothEnvironment 'CLASSPILOT_DAILY_USAGE_ROLLUP_MODE' 'set_based'
    Assert-Condition (@((New-TestProductPlan $promote).plan.activations).Count -eq 0) 'Switching set_based to its on alias is not a promotion.'
    Assert-ThrowsMatch { New-TestProductPlan $promote $evidencePath } 'applies only to a plan that promotes' 'Evidence must not be bound to a plan that promotes nothing.'
    Reset-ProductMock; Set-BothEnvironment 'CLASSPILOT_DAILY_USAGE_ROLLUP_MODE' 'on'
    foreach ($value in @('shadow', 'legacy', $null)) {
        Assert-Condition ($null -ne (New-TestProductPlan (New-TestConfig @{ CLASSPILOT_DAILY_USAGE_ROLLUP_MODE = $value }))) "Demoting the rollup to '$value' needs no evidence."
    }

    # --- API/worker parity, secret channels and live values set elsewhere ---
    Reset-ProductMock; Set-TestEnvironment (Get-TestTask 'worker') 'PASSPILOT_APPOINTMENTS_MODE' 'off'
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE = 'on' }) } 'API and worker carry different' 'A worker-only managed value must block planning.'
    Reset-ProductMock; Set-TestEnvironment (Get-TestTask 'api') 'CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE' 'on'
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ PASSPILOT_RULES_MODE = 'off' }) } 'API and worker carry different' 'An API-only managed value must block planning.'
    Reset-ProductMock; (Get-TestTask 'worker').taskDefinition.containerDefinitions[0].secrets += [pscustomobject]@{ name = 'PASSPILOT_RULES_MODE'; valueFrom = 'arn:aws:ssm:us-east-1:135775632425:parameter/test/flag' }
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ PASSPILOT_RULES_MODE = 'off' }) } 'secret channel' 'A managed name delivered as a secret must block planning.'
    Reset-ProductMock; Set-TestEnvironment (Get-TestTask 'api') 'passpilot_rules_mode' 'on'
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ PASSPILOT_RULES_MODE = 'off' }) } 'case variant' 'A live case variant of a managed name must block planning.'
    Reset-ProductMock; Set-BothEnvironment 'PASSPILOT_RULES_MODE' 'ON'
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE = 'on' }) } 'malformed' 'An unrelated malformed live value must block planning.'
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ PASSPILOT_RULES_MODE = 'on' }) } 'passpilot_destination_policies' 'Repairing a malformed value to on is an activation with its preconditions.'
    $repair = New-TestProductPlan (New-TestConfig @{ PASSPILOT_RULES_MODE = 'off' })
    Assert-Condition ($repair.plan.changes[0].from -ceq 'ON' -and $repair.plan.changes[0].to -ceq 'off') 'Naming a malformed value repairs it explicitly.'
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ PASSPILOT_RULES_MODE = 'ON' }) } 'exact documented values' 'A malformed value can never be written.'
    Reset-ProductMock; Set-BothEnvironment 'PASSPILOT_RULES_MODE' 'off'
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ PASSPILOT_RULES_MODE = 'off' }) } 'nothing would change' 'A no-op plan must be refused.'
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS = '' }) } 'nothing would change' 'Unsetting an unset list is a no-op.'
    # Both registered revisions must end with identical managed values.
    Reset-ProductMock; Add-BothTables $script:RulesTables
    $plan = New-TestProductPlan $rulesConfig
    $script:Mock.InjectWorkerFlag = $true
    # Registration readback rejects the extra name before the later pair check.
    Assert-ThrowsMatch { Invoke-ProductApply $plan.plan $plan.sha256 $script:TestDirectory } 'Registered runtime task changed the exact managed environment presence' 'A worker revision with an extra managed value must stop the operation.'
    $receipt = (Read-StrictJsonSnapshot (Join-Path $script:TestDirectory "$($plan.plan.runId)-result.json")).Value
    Assert-Condition ($receipt.status -ceq 'failed_no_service_mutation' -and -not $script:OperationLockHeld -and @($script:Mock.Calls | Where-Object { $_ -ceq 'ecs update-service' }).Count -eq 0) 'A parity failure must stop before any service mutation and release the fence.'

    # --- Shared teaching resources: allowlist semantics and rollback direction ---
    Reset-ProductMock
    $sharedPlan = New-TestProductPlan (New-TestConfig @{ CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE = 'on'; CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS = $script:SchoolA })
    Assert-Condition ('sharedTeachingResources' -cin @($sharedPlan.plan.activations)) 'Turning the library on for a school is an activation.'
    [void](Invoke-ProductApply $sharedPlan.plan $sharedPlan.sha256 $script:TestDirectory)
    Assert-Condition ((Get-ServingState 'Worker')['CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS'] -ceq $script:SchoolA) 'The allowlist must reach both services.'
    Invoke-TestRollback $sharedPlan
    Assert-Condition ($null -eq (Get-ServingState 'Api')['CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE'] -and $null -eq (Get-ServingState 'Worker')['CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS']) 'Rollback must unset both shared-library names.'
    Reset-ProductMock; Set-BothEnvironment 'CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE' 'on'; Set-BothEnvironment 'CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS' "$($script:SchoolA),$($script:SchoolB)"
    $narrow = New-TestProductPlan (New-TestConfig @{ CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS = $script:SchoolA })
    Assert-Condition (@($narrow.plan.activations).Count -eq 0) 'Removing a school is not an activation.'
    [void](Invoke-ProductApply $narrow.plan $narrow.sha256 $script:TestDirectory)
    Assert-ThrowsMatch { Invoke-TestRollback $narrow } 'cannot activate' 'Rollback must not re-add a removed school.'
    $everySchool = New-TestProductPlan (New-TestConfig @{ CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS = '' })
    Assert-Condition ('sharedTeachingResources' -cin @($everySchool.plan.activations)) 'An empty allowlist opens the library to every school.'
    [void](Invoke-ProductApply $everySchool.plan $everySchool.sha256 $script:TestDirectory)
    foreach ($role in @('Api', 'Worker')) {
        $response = $script:Mock.Tasks[$script:Mock.Services.$role.taskDefinition]
        Assert-Condition (@($response.taskDefinition.containerDefinitions[0].environment | Where-Object name -CEQ 'CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS').Count -eq 0) 'An empty allowlist must be removed, never written as an empty value.'
    }
    Invoke-TestRollback $everySchool
    Assert-Condition ((Get-ServingState 'Api')['CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS'] -ceq $script:SchoolA) 'Rollback from every school may narrow back to the prior list.'

    # --- Drift, stale plans, tool SHA and task sizes ---
    Reset-ProductMock; Add-BothTables $script:RulesTables
    $plan = New-TestProductPlan $rulesConfig
    Set-TestEnvironment (Get-TestTask 'api') 'CLIENT_URL' 'https://changed.invalid'
    Assert-ThrowsMatch { Invoke-ProductApply $plan.plan $plan.sha256 $script:TestDirectory } 'drifted' 'Unrelated runtime drift must stop before mutation.'
    Assert-NoMutation 'A stale plan must perform no mutation.'
    Reset-ProductMock; Add-BothTables $script:RulesTables
    $plan = New-TestProductPlan $rulesConfig
    Set-BothEnvironment 'PASSPILOT_APPOINTMENTS_MODE' 'off'
    Assert-ThrowsMatch { Invoke-ProductApply $plan.plan $plan.sha256 $script:TestDirectory } 'drifted' 'A managed value changed after planning must stop Apply.'
    Reset-ProductMock; Add-BothTables $script:RulesTables
    $plan = New-TestProductPlan $rulesConfig
    $plan.plan.createdAt = [DateTimeOffset]::UtcNow.AddHours(-3).ToString('o')
    Assert-ThrowsMatch { Invoke-ProductApply $plan.plan $plan.sha256 $script:TestDirectory } 'fresh' 'A plan older than two hours must not apply.'
    $plan = New-TestProductPlan $rulesConfig
    $script:CurrentToolSha = 'c' * 40
    Assert-ThrowsMatch { Read-ProductPlan $plan.path $plan.sha256 } 'Tool SHA drift' 'Main moving between Plan and Apply must invalidate the plan.'
    $script:CurrentToolSha = $script:TestSha
    Assert-NoMutation 'Refused applies must not mutate.'
    Reset-ProductMock; (Get-TestTask 'worker').taskDefinition.cpu = '256'; (Get-TestTask 'worker').taskDefinition.memory = '512'
    Assert-Throws { New-TestProductPlan (New-TestConfig @{ PASSPILOT_RULES_MODE = 'off' }) } 'A serving worker below the reviewed 512 CPU / 1024 MiB must be refused.'
    Reset-ProductMock; (Get-TestTask 'api').taskDefinition.cpu = '512'
    Assert-Throws { New-TestProductPlan (New-TestConfig @{ PASSPILOT_RULES_MODE = 'off' }) } 'A serving API below the reviewed 1024 CPU must be refused.'
    Reset-ProductMock; $script:Mock.Scaling.DynamicIn = $true
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ PASSPILOT_RULES_MODE = 'off' }) } 'holds autoscaling' 'A held autoscaling target must block planning.'

    # --- Failure recovery ---
    Reset-ProductMock; Add-BothTables $script:RulesTables
    $plan = New-TestProductPlan $rulesConfig; $script:Mock.FailWorkerOnce = $true
    Assert-Throws { Invoke-ProductApply $plan.plan $plan.sha256 $script:TestDirectory } 'An ambiguous service update must remain an unsuccessful activation.'
    $receipt = (Read-StrictJsonSnapshot (Join-Path $script:TestDirectory "$($plan.plan.runId)-result.json")).Value
    Assert-Condition ($receipt.status -ceq 'rolled_back' -and $script:Mock.Requests.Count -eq 4 -and -not $script:OperationLockHeld) 'A recoverable failure must restore the prior values in fresh clones and release the fence.'
    Assert-Condition ($null -eq (Get-ServingState 'Api')['PASSPILOT_RULES_MODE'] -and $null -eq (Get-ServingState 'Worker')['PASSPILOT_RULES_MODE']) 'Recovery must return both services to the prior values.'
    $order = @($script:Mock.Calls | Where-Object { $_ -like 'update:*' -or $_ -ceq 'wait' }) -join ','
    Assert-Condition ($order -ceq 'update:Api,wait,update:Worker,update:Api,wait,update:Worker,wait') 'Recovery must retain the API-first overlap bound.'
    Reset-ProductMock; Add-BothTables $script:RulesTables
    $plan = New-TestProductPlan $rulesConfig; $script:Mock.FailWorkerOnce = $true; $script:Mock.FailRecovery = $true
    Assert-Throws { Invoke-ProductApply $plan.plan $plan.sha256 $script:TestDirectory } 'Uncertain recovery must fail closed.'
    $receipt = (Read-StrictJsonSnapshot (Join-Path $script:TestDirectory "$($plan.plan.runId)-result.json")).Value
    Assert-Condition ($receipt.status -ceq 'recovery_required' -and $script:OperationLockHeld -and $script:ScalingHoldAcquired) 'An uncertain service pair must keep the operation fence and scaling hold.'
    Reset-ProductMock; Add-BothTables $script:RulesTables
    $plan = New-TestProductPlan $rulesConfig; $script:Mock.FailStart = $true
    $script:ApiServiceMutationStarted = $true; $script:WorkerServiceMutationStarted = $true
    Assert-Throws { Invoke-ProductApply $plan.plan $plan.sha256 $script:TestDirectory } 'An ambiguous fence transition must fail closed.'
    Assert-Condition ($script:OperationLockHeld -and $script:Mock.Requests.Count -eq 0) 'A failed mutation-window transition must keep its fence without registering anything.'
    Assert-Condition (-not $script:ApiServiceMutationStarted -and -not $script:WorkerServiceMutationStarted) 'Sequential operations must reset their service-mutation markers.'

    # --- Usage off containment: separate v2 contract, never weaker activation ---
    $bothOff = New-TestConfig @{ CLASSPILOT_USAGE_ROLLUP_MODE = 'off'; CLASSPILOT_DIGITAL_USAGE_MODE = 'off' }
    foreach ($desiredCount in @(1, 3, 4, 6)) {
        Initialize-TestUsageOn $desiredCount
        $priorConfigurations = Get-CanonicalJsonSha256 @($script:Mock.Services.Api.deploymentConfiguration, $script:Mock.Services.Worker.deploymentConfiguration)
        $priorScaling = Get-CanonicalJsonSha256 $script:Mock.Scaling
        $plan = New-TestProductPlan $bothOff -UsageOffContainment
        Assert-Condition ($plan.plan.schemaVersion -eq 2 -and $plan.plan.operationMode -ceq 'usage_off_containment' -and $plan.plan.apiDesired -eq $desiredCount) 'Containment must bind its operation mode and exact capacity in a v2 manifest.'
        Assert-Condition ((Read-ProductPlan $plan.path $plan.sha256).operationMode -ceq 'usage_off_containment') 'A v2 containment manifest must round-trip through strict validation.'
        Assert-Condition (@($plan.plan.activations).Count -eq 0) 'Containment cannot activate anything.'
        Assert-NoMutation 'Containment Plan must be read-only.'
        $applied = Invoke-ProductApply $plan.plan $plan.sha256 $script:TestDirectory
        Assert-Condition ($applied.status -ceq 'applied' -and $applied.schemaVersion -eq 2 -and $applied.operationMode -ceq 'usage_off_containment') 'Containment receipt must retain its v2 mode.'
        Assert-Condition ($applied.operationLockOwner -ceq "$($plan.plan.runId)-mockowner" -and $applied.operationLockFence -eq 42) 'Containment receipt must bind the exact run owner and fence for interrupted-process recovery.'
        Assert-Condition ($script:Mock.Services.Api.desiredCount -eq $desiredCount -and -not $script:OperationLockHeld -and -not $script:ScalingHoldAcquired -and -not $script:DeploymentBoundsChanged) 'Successful containment must preserve capacity and release only restored holds.'
        Assert-Condition ((Get-CanonicalJsonSha256 @($script:Mock.Services.Api.deploymentConfiguration, $script:Mock.Services.Worker.deploymentConfiguration)) -ceq $priorConfigurations -and (Get-CanonicalJsonSha256 $script:Mock.Scaling) -ceq $priorScaling) 'Containment must restore complete deployment configurations and scaling state.'
        $minimum = if ($desiredCount -eq 1) { 100 } else { [int][Math]::Floor((($desiredCount - 1) * 100) / $desiredCount) }
        $maximum = if ($desiredCount -eq 1) { 200 } else { 100 }
        $order = @($script:Mock.Calls | Where-Object { $_ -clike 'bounds:*' -or $_ -clike 'update:*' -or $_ -cin @('wait', 'restore', 'unlock') }) -join ','
        Assert-Condition ($order -ceq "bounds:Api:$minimum/$maximum,bounds:Worker:0/100,update:Api,wait,update:Worker,wait,bounds:Api:100/200,bounds:Worker:100/200,restore,unlock") 'Containment must set reviewed bounds, converge API before worker, then restore bounds/scaling before unlock.'
        Assert-AllRegisteredUsageOff 'Every containment candidate must explicitly turn both Usage modes off.'
        foreach ($role in @('Api', 'Worker')) {
            Assert-Condition ((Get-ServingState $role)['CLASSPILOT_USAGE_ROLLUP_MODE'] -ceq 'off' -and (Get-ServingState $role)['CLASSPILOT_DIGITAL_USAGE_MODE'] -ceq 'off') 'Both serving services must be OFF.'
        }
        Assert-ThrowsMatch { Invoke-TestRollback $plan } 'cannot activate Usage' 'Containment rollback must never re-enable Usage.'
    }
    foreach ($desiredCount in @(4, 6)) {
        Initialize-TestUsageOn $desiredCount
        Assert-ThrowsMatch { New-TestProductPlan $bothOff } 'stable release posture' 'Ordinary v1 off plans must retain the original three-task ceiling.'
        Assert-NoMutation 'An ordinary capacity refusal must not mutate.'
    }
    foreach ($badConfig in @(
            (New-TestConfig @{ CLASSPILOT_USAGE_ROLLUP_MODE = 'off' }),
            (New-TestConfig @{ CLASSPILOT_USAGE_ROLLUP_MODE = 'off'; CLASSPILOT_DIGITAL_USAGE_MODE = $null }),
            (New-TestConfig @{ CLASSPILOT_USAGE_ROLLUP_MODE = 'on'; CLASSPILOT_DIGITAL_USAGE_MODE = 'off' }),
            (New-TestConfig @{ CLASSPILOT_USAGE_ROLLUP_MODE = 'off'; CLASSPILOT_DIGITAL_USAGE_MODE = 'off'; PASSPILOT_RULES_MODE = 'off' }))) {
        Initialize-TestUsageOn
        Assert-ThrowsMatch { New-TestProductPlan $badConfig -UsageOffContainment } 'exactly both Usage modes' 'Containment must reject every configuration except exact explicit both-OFF.'
        Assert-NoMutation 'Invalid containment configurations must not mutate.'
    }
    Initialize-TestUsageOn
    $plan = New-TestProductPlan $bothOff -UsageOffContainment
    foreach ($mutation in @(
            { param($p) $p.operationMode = 'ordinary' },
            { param($p) $p.operationMode = 'USAGE_OFF_CONTAINMENT' },
            { param($p) $p.schemaVersion = 1 },
            { param($p) $p.schemaVersion = 3 },
            { param($p) $p.PSObject.Properties.Remove('operationMode') },
            { param($p) $p.apiDesired = 7 },
            { param($p) $p.config.environment | Add-Member PASSPILOT_RULES_MODE 'off' },
            { param($p) $p.config.environment.CLASSPILOT_USAGE_ROLLUP_MODE = 'on' })) {
        $badPlan = Copy-TestValue $plan.plan
        & $mutation $badPlan
        $badPath = Write-TestEvidence $badPlan
        Assert-Throws { Read-ProductPlan $badPath (Get-FileSha256 $badPath) } 'Even rehashed malformed/tampered containment manifests must fail semantic validation.'
    }
    $script:CurrentToolSha = 'c' * 40
    Assert-ThrowsMatch { Read-ProductPlan $plan.path $plan.sha256 } 'Tool SHA drift' 'Containment also binds the reviewed tool SHA.'
    $script:CurrentToolSha = $script:TestSha
    Assert-NoMutation 'Manifest rejection must never mutate.'

    foreach ($refusal in @('Unhealthy', 'ProtectedWindow', 'OtherLease')) {
        Initialize-TestUsageOn 6
        $plan = New-TestProductPlan $bothOff -UsageOffContainment
        $script:Mock[$refusal] = $true
        Assert-Throws { Invoke-ProductApply $plan.plan $plan.sha256 $script:TestDirectory } "Containment must preserve the $refusal refusal."
        Assert-NoMutation 'Containment cannot bypass health, protected-window or concurrent-operation guards.'
    }
    Initialize-TestUsageOn 6; $script:Mock.Unhealthy = $true
    Assert-ThrowsMatch { New-TestProductPlan $bothOff -UsageOffContainment } 'Unhealthy' 'Unhealthy targets must block containment Plan as well as Apply.'
    foreach ($drift in @(
            { $script:Mock.Services.Api.desiredCount = 4; $script:Mock.Services.Api.runningCount = 4; $script:Mock.Services.Api.deployments[0].desiredCount = 4; $script:Mock.Services.Api.deployments[0].runningCount = 4 },
            { Set-TestEnvironment (Get-TestTask api) 'CLIENT_URL' 'https://drift.invalid' },
            { $script:Mock.Services.Api.deploymentConfiguration.maximumPercent = 150 },
            { $script:Mock.Scaling.Min = 1 })) {
        Initialize-TestUsageOn 6
        $plan = New-TestProductPlan $bothOff -UsageOffContainment
        & $drift
        Assert-Throws { Invoke-ProductApply $plan.plan $plan.sha256 $script:TestDirectory } 'Containment must reject capacity, task, deployment or scaling drift.'
        Assert-NoMutation 'Preflight drift refusal must not mutate.'
    }
    Initialize-TestUsageOn 6
    $plan = New-TestProductPlan $bothOff -UsageOffContainment
    $plan.plan.createdAt = [DateTimeOffset]::UtcNow.AddHours(-3).ToString('o')
    Assert-ThrowsMatch { Invoke-ProductApply $plan.plan $plan.sha256 $script:TestDirectory } 'fresh' 'Containment manifests expire after two hours.'
    Initialize-TestUsageOn 6
    $plan = New-TestProductPlan $bothOff -UsageOffContainment
    $script:Mock.DriftAfterHold = $true
    Assert-ThrowsMatch { Invoke-ProductApply $plan.plan $plan.sha256 $script:TestDirectory } 'Service state changed' 'Drift after taking the scaling hold must still block service mutation.'
    Assert-Condition ((Read-TestProductReceipt $plan).status -ceq 'failed_no_service_mutation' -and 'update:Api' -cnotin $script:Mock.Calls -and -not $script:OperationLockHeld) 'Post-hold drift must release only after restoring the owned hold.'

    foreach ($failure in @('FailApiOnce', 'FailWorkerOnce')) {
        Initialize-TestUsageOn 6
        $plan = New-TestProductPlan $bothOff -UsageOffContainment
        $script:Mock[$failure] = $true
        Assert-Throws { Invoke-ProductApply $plan.plan $plan.sha256 $script:TestDirectory } 'An ambiguous accepted update remains a failed attempt even when forward recovery succeeds.'
        $receipt = Read-TestProductReceipt $plan
        Assert-Condition ($receipt.status -ceq 'recovered_off' -and $script:Mock.Requests.Count -eq 4 -and -not $script:OperationLockHeld -and -not $script:ScalingHoldAcquired -and -not $script:DeploymentBoundsChanged) 'Successful forward recovery must report recovered_off and restore all holds before unlock.'
        Assert-AllRegisteredUsageOff 'Forward containment recovery must never register a Usage-ON revision.'
        Assert-Condition ((Get-ServingState Api)['CLASSPILOT_USAGE_ROLLUP_MODE'] -ceq 'off' -and (Get-ServingState Worker)['CLASSPILOT_USAGE_ROLLUP_MODE'] -ceq 'off') 'Forward recovery must leave both services OFF.'
    }
    foreach ($failure in @('FailRecovery', 'FailBoundsRestore', 'FailScalingRestore', 'DriftDuringRecovery', 'LoseFenceDuringWorker')) {
        Initialize-TestUsageOn 6
        $plan = New-TestProductPlan $bothOff -UsageOffContainment
        $script:Mock[$failure] = $true
        if ($failure -cin @('FailRecovery', 'DriftDuringRecovery', 'LoseFenceDuringWorker')) { $script:Mock.FailWorkerOnce = $true }
        Assert-Throws { Invoke-ProductApply $plan.plan $plan.sha256 $script:TestDirectory } 'Unproven off recovery must remain fenced for operator attention.'
        $receipt = Read-TestProductReceipt $plan
        Assert-Condition ($receipt.status -ceq 'recovery_required' -and 'unlock' -cnotin $script:Mock.Calls -and $script:ScalingHoldAcquired) 'Recovery uncertainty must never release the lease or scaling hold.'
        Assert-AllRegisteredUsageOff 'No failure path after containment mutation may register Usage ON.'
        Assert-Condition ($receipt.priorApiArn -ceq $script:TestApiArn -and $receipt.priorWorkerArn -ceq $script:TestWorkerArn -and $receipt.planSha256 -ceq $plan.sha256 -and $null -ne $receipt.priorDeploymentConfigurations -and $null -ne $receipt.priorScalingState) 'Interrupted containment must preserve run-bound source and restoration evidence.'
    }
    Initialize-TestUsageOn 6
    $plan = New-TestProductPlan $bothOff -UsageOffContainment
    $script:Mock.FailBoundsSetOnce = $true
    Assert-Throws { Invoke-ProductApply $plan.plan $plan.sha256 $script:TestDirectory } 'An ambiguous deployment-bounds update must be repaired before releasing the fence.'
    Assert-Condition ((Read-TestProductReceipt $plan).status -ceq 'failed_no_service_mutation' -and -not $script:DeploymentBoundsChanged -and -not $script:ScalingHoldAcquired -and -not $script:OperationLockHeld) 'A pre-task-update bounds failure may release only after exact settings restoration.'
    Assert-Condition ('update:Api' -cnotin $script:Mock.Calls -and 'update:Worker' -cnotin $script:Mock.Calls) 'A bounds preflight failure must not roll tasks.'
    Initialize-TestUsageOn 6
    $plan = New-TestProductPlan $bothOff -UsageOffContainment
    $script:Mock.FailBoundsSetOnce = $true; $script:Mock.FailBoundsRestore = $true
    Assert-Throws { Invoke-ProductApply $plan.plan $plan.sha256 $script:TestDirectory } 'Unproven restoration after a partial bounds mutation must stay fenced.'
    Assert-Condition ((Read-TestProductReceipt $plan).status -ceq 'recovery_required' -and $script:OperationLockHeld -and $script:ScalingHoldAcquired -and $script:DeploymentBoundsChanged) 'Partial bounds mutation plus restoration failure must retain all recovery state.'
    Initialize-TestUsageOn 6
    $plan = New-TestProductPlan $bothOff -UsageOffContainment
    $script:Mock.FailStart = $true
    Assert-Throws { Invoke-ProductApply $plan.plan $plan.sha256 $script:TestDirectory } 'Ambiguous containment fence acquisition must remain unresolved.'
    Assert-Condition ((Read-TestProductReceipt $plan).status -ceq 'recovery_required' -and $script:OperationLockHeld -and $script:Mock.Requests.Count -eq 0) 'An interrupted fence transition must retain its receipt and never guess that release is safe.'
    $interruptionRoot = Join-Path $script:TestDirectory 'product-runtime-mock-interrupted'
    & (Get-Process -Id $PID).Path -NoProfile -File $script:ProductTestFile -ContainmentInterruptionFixture -InterruptionDirectory $interruptionRoot 2>&1 | Out-Null
    Assert-Condition ($LASTEXITCODE -eq 73) 'The interrupted mock process must exit before Apply recovery can execute.'
    $interrupted = (Read-StrictJsonSnapshot (Join-Path $interruptionRoot 'interruption-state.json')).Value
    $interruptedPlan = Read-ProductPlan $interrupted.planPath $interrupted.planHash
    $interruptedReceipt = (Read-StrictJsonSnapshot (Join-Path $interruptionRoot "$($interruptedPlan.runId)-result.json")).Value
    Assert-Condition ($interruptedReceipt.status -ceq 'worker_update_pending' -and $interrupted.apiMode -ceq 'off' -and $interrupted.workerMode -ceq 'on') 'Process termination must leave an honest checkpoint identifying the partial API/worker rollout.'
    Assert-Condition ($interrupted.fenceHeld -and $interrupted.fenceState -ceq 'mutating' -and $interrupted.scalingHeld -and $interrupted.boundsHeld) 'Process termination must not silently release the fence or owned scaling/deployment bounds.'
    Assert-Condition ($interruptedReceipt.operationLockOwner -ceq $interrupted.fenceOwner -and $interruptedReceipt.operationLockFence -eq $interrupted.fenceToken -and $null -ne $interruptedReceipt.priorDeploymentConfigurations -and $null -ne $interruptedReceipt.containmentDeploymentConfigurations) 'The persisted checkpoint must identify the exact interrupted lease and settings needed for forward-OFF operator recovery.'

    # --- Entry point: private strict JSON file, Execute gate ---
    Reset-ProductMock; Add-BothTables $script:RulesTables
    $configPath = Join-Path $script:TestDirectory 'product-config.json'
    [IO.File]::WriteAllText($configPath, '{"schemaVersion":1,"environment":{"PASSPILOT_RULES_MODE":"on"}}')
    $script:Action = 'Plan'; $script:ConfigPath = $configPath; $script:OutDir = $script:TestDirectory; $script:DailyUsageEvidencePath = $null
    $script:UsageObservationEvidencePath = $null
    $script:ApiArn = $script:TestApiArn; $script:WorkerArn = $script:TestWorkerArn; $script:ImageDigest = $script:TestDigest; $script:AppSha = $script:TestSha
    Invoke-ProductMain
    Assert-NoMutation 'The Plan entry point must be read-only.'
    foreach ($text in @('{"schemaVersion":1,"environment":{"PASSPILOT_RULES_MODE":"on","PASSPILOT_RULES_MODE":"off"}}',
            '{"schemaVersion":1,"environment":{"PASSPILOT_RULES_MODE":"on","passpilot_rules_mode":"on"}}',
            '{"schemaVersion":1,"environment":{"PASSPILOT_RULES_MODE":"on"},}')) {
        [IO.File]::WriteAllText($configPath, $text)
        Assert-ThrowsMatch { Invoke-ProductMain } 'Invalid strict JSON|different casing' 'Duplicate, case-variant or invalid JSON must be refused.'
    }
    $script:Action = 'Apply'; $script:Execute = $false; $script:ManifestPath = $plan.path; $script:ManifestHash = $plan.sha256
    Assert-ThrowsMatch { Invoke-ProductMain } 'requires Execute' 'Apply must require -Execute.'
    $script:Execute = $true; $script:DailyUsageEvidencePath = $evidencePath
    Assert-ThrowsMatch { Invoke-ProductMain } 'bound into the plan' 'Apply must use only the evidence bound into the plan.'
    $script:DailyUsageEvidencePath = $null
    Assert-NoMutation 'Refused entry points must not mutate.'
    foreach ($operation in @('Apply', 'Rollback')) {
        $script:Action = $operation; $script:UsageOffContainment = $true
        Assert-ThrowsMatch { Invoke-ProductMain } 'Plan-only' 'Apply and Rollback must derive containment exclusively from the reviewed manifest.'
    }
    Initialize-TestUsageOn 6
    [IO.File]::WriteAllText($configPath, '{"schemaVersion":1,"environment":{"CLASSPILOT_USAGE_ROLLUP_MODE":"off","CLASSPILOT_DIGITAL_USAGE_MODE":"off"}}')
    $script:Action = 'Plan'; $script:UsageOffContainment = $true
    Invoke-ProductMain
    $entryPointPlan = Get-ChildItem -LiteralPath $script:TestDirectory -Filter '*-plan.json' | Where-Object {
        $candidatePlan = (Read-StrictJsonSnapshot $_.FullName).Value
        $candidatePlan.schemaVersion -eq 2 -and $candidatePlan.apiDesired -eq 6 -and $candidatePlan.prior.CLASSPILOT_USAGE_ROLLUP_MODE -ceq 'on'
    } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    Assert-Condition ($null -ne $entryPointPlan) 'The Plan-only CLI switch must emit a v2 containment manifest.'
    Assert-NoMutation 'The containment CLI Plan remains read-only.'
    $script:UsageOffContainment = $false
    $script:Action = 'Apply'; $script:Execute = $true; $script:ManifestPath = $entryPointPlan.FullName; $script:ManifestHash = Get-FileSha256 $entryPointPlan.FullName
    Invoke-ProductMain
    Assert-Condition ((Get-ServingState Api)['CLASSPILOT_USAGE_ROLLUP_MODE'] -ceq 'off' -and (Get-ServingState Worker)['CLASSPILOT_DIGITAL_USAGE_MODE'] -ceq 'off') 'CLI Apply must honor the manifest-bound containment mode without a switch argument.'

    Write-Host "Product runtime configuration tests passed ($script:Assertions assertions)."
} finally {
    $resolved = [IO.Path]::GetFullPath($script:TestDirectory)
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolved.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notlike 'product-runtime-mock-*') { throw 'Unsafe test cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
}
