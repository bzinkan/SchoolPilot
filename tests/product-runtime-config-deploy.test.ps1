#requires -Version 7.5
[CmdletBinding()]
param()
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

$script:TestDirectory = Join-Path ([IO.Path]::GetTempPath()) ('product-runtime-mock-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($script:TestDirectory)
$script:TestSha = 'a' * 40
$script:CurrentToolSha = $script:TestSha
$script:TestDigest = 'sha256:' + ('b' * 64)
$script:TestApiArn = 'arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:161'
$script:TestWorkerArn = 'arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:177'
$script:BaselineTables = 'students,passes,classpilot_ai_decisions,flight_paths,block_lists'
$script:RulesTables = @('passpilot_destination_policies', 'passpilot_pass_limits', 'passpilot_encounter_restrictions', 'passpilot_pass_denials')
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
        Revision = 200; FailWorkerOnce = $false; FailRecovery = $false; FailedWorker = $false; FailStart = $false; InjectWorkerFlag = $false
    }
    $script:CurrentToolSha = $script:TestSha
    $script:ApiServiceMutationStarted = $false; $script:WorkerServiceMutationStarted = $false
    $script:ScalingHoldAcquired = $false; $script:PriorScalingState = $null
    $script:OperationLockHeld = $false; $script:OperationLockState = $null
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
            $arn = Get-ArgumentValue $Arguments '--task-definition'
            $role = if ($service -ceq $script:ApiService) { 'Api' } else { 'Worker' }
            $script:Mock.Calls.Add("update:$role")
            $count = if ($role -ceq 'Api') { 3 } else { 1 }
            $script:Mock.Services.$role = New-TestService $role.ToLowerInvariant() $arn $count
            if ($role -ceq 'Worker' -and $script:Mock.FailWorkerOnce -and -not $script:Mock.FailedWorker) {
                $script:Mock.FailedWorker = $true
                throw 'Ambiguous worker response after accepted update.'
            }
            return [pscustomobject]@{}
        }
        default { throw "Unmocked external operation: $operation" }
    }
}
function Get-ServiceSnapshot { return Copy-TestValue $script:Mock.Services }
function Start-Sleep { param($Seconds) } # Bounded poll loops remain deterministic under mocked transport.
function Assert-ApiTargetHealth { param($ApiService, $ExpectedDesiredCount, $Mode) return $true }
function Get-ScalingSnapshot { return Copy-TestValue $script:Mock.Scaling }
function Assert-ScheduledScalingContract { }
function Assert-RuntimeConfigMutationWindow { }
function Assert-RepositoryIdentity { param($RepositoryRoot, $ExpectedSha) if ($ExpectedSha -and $ExpectedSha -cne $script:CurrentToolSha) { throw 'Tool SHA drift' }; return $script:CurrentToolSha }
function Assert-PrivateExternalRoot { param($Root, $RepositoryRoot) return $Root }
function Assert-PrivateInputPath { param($Path, $RepositoryRoot) if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'Missing test input' }; return $Path }
function Set-PrivatePathPermissions { param($Path) }
function Acquire-OperationLock { param($RunId, $PlanSha256) $script:OperationLockHeld = $true; $script:OperationLockState = 'preparing'; $script:Mock.Calls.Add('lock') }
function Maintain-OperationLock { if (-not $script:OperationLockHeld) { throw 'Missing operation fence' } }
function Start-OperationMutationWindow { if ($script:Mock.FailStart) { throw 'Fence acquisition failed' }; $script:OperationLockState = 'mutating' }
function Complete-OperationMutationWindow { if ($script:OperationLockState -cne 'mutating') { throw 'Not mutating' }; $script:OperationLockState = 'terminal_safe' }
function Release-OperationLock { $script:OperationLockHeld = $false; $script:Mock.Calls.Add('unlock') }
function Acquire-ScalingHold { $script:PriorScalingState = Copy-TestValue $script:Mock.Scaling; $script:ScalingHoldAcquired = $true; $script:Mock.Scaling.DynamicIn = $true; $script:Mock.Scaling.DynamicOut = $true; $script:Mock.Scaling.Scheduled = $true; $script:Mock.Calls.Add('hold') }
function Assert-ScalingHoldExact { if (-not $script:ScalingHoldAcquired) { throw 'Missing scaling hold' }; return $true }
function Restore-ScalingHold { $script:Mock.Scaling = Copy-TestValue $script:PriorScalingState; $script:ScalingHoldAcquired = $false; $script:Mock.Calls.Add('restore'); return $true }
function Wait-ExactServicePairConvergence {
    param($ExpectedApiArn, $ExpectedWorkerArn, $ExpectedDesiredCount)
    $script:Mock.Calls.Add('wait')
    if ($script:Mock.FailRecovery -and $script:Mock.FailedWorker) { throw 'Recovery could not converge' }
    if ($script:Mock.Services.Api.taskDefinition -cne $ExpectedApiArn -or $script:Mock.Services.Worker.taskDefinition -cne $ExpectedWorkerArn -or $ExpectedDesiredCount -ne 3) { throw 'Incorrect convergence pair' }
    return $true
}

function New-TestConfig([hashtable]$Environment) { return [pscustomobject]@{ schemaVersion = 1; environment = [pscustomobject]$Environment } }
function New-TestProductPlan($Config, $EvidencePath = $null) {
    # Plan against whatever pair is serving now, as an operator would.
    return New-ProductPlan $Config $script:TestDirectory $script:Mock.Services.Api.taskDefinition $script:Mock.Services.Worker.taskDefinition `
        $script:TestDigest $script:TestSha $EvidencePath
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
function Write-TestEvidence($Evidence) {
    $path = Join-Path $script:TestDirectory ('evidence-' + [Guid]::NewGuid().ToString('N') + '.json')
    Write-SanitizedJson $path $Evidence
    return $path
}
function Invoke-TestRollback($Plan) {
    $script:Action = 'Rollback'; $script:Execute = $true; $script:ManifestPath = $Plan.path; $script:ManifestHash = $Plan.sha256; $script:DailyUsageEvidencePath = $null
    Invoke-ProductMain
}

try {
    # --- Configuration: only the seven managed names, exact values only ---
    Reset-ProductMock
    Assert-Condition ((ConvertTo-ProductChanges (New-TestConfig @{ PASSPILOT_RULES_MODE = 'on' }))['PASSPILOT_RULES_MODE'] -ceq 'on') 'An exact managed value must parse.'
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
    foreach ($name in @('CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE', 'PASSPILOT_RULES_MODE', 'PASSPILOT_APPOINTMENTS_MODE', 'CLASSPILOT_USAGE_ROLLUP_MODE', 'CLASSPILOT_DIGITAL_USAGE_MODE')) {
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
            @{ Name = 'PASSPILOT_RULES_MODE'; Config = @{ PASSPILOT_RULES_MODE = 'on' }; Tables = $script:RulesTables; Live = @{} },
            @{ Name = 'PASSPILOT_APPOINTMENTS_MODE'; Config = @{ PASSPILOT_APPOINTMENTS_MODE = 'on' }; Tables = @('passpilot_appointments'); Live = @{} },
            @{ Name = 'CLASSPILOT_USAGE_ROLLUP_MODE'; Config = @{ CLASSPILOT_USAGE_ROLLUP_MODE = 'on' }; Tables = @('classpilot_usage_rollups'); Live = @{} },
            @{ Name = 'CLASSPILOT_DIGITAL_USAGE_MODE'; Config = @{ CLASSPILOT_DIGITAL_USAGE_MODE = 'on' }; Tables = @('classpilot_usage_rollups'); Live = @{ CLASSPILOT_USAGE_ROLLUP_MODE = 'on' } })) {
        $prepare = {
            Reset-ProductMock
            foreach ($live in $gate.Live.GetEnumerator()) { Set-BothEnvironment $live.Key $live.Value }
            Add-BothTables $gate.Tables
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
        $admitted = New-TestProductPlan (New-TestConfig $gate.Config)
        Assert-Condition (@($admitted.plan.activations).Count -eq 1) "$($gate.Name) must plan once its bundle is admitted on both services."
        Assert-NoMutation 'Precondition checks must be read-only.'
    }
    # Preconditions are re-checked at Apply against the live task definitions.
    Reset-ProductMock; Add-BothTables $script:RulesTables
    $plan = New-TestProductPlan $rulesConfig
    Remove-TestTable 'worker' 'passpilot_pass_denials'
    Assert-ThrowsMatch { Invoke-ProductApply $plan.plan $plan.sha256 $script:TestDirectory } 'PASSPILOT_RULES_MODE=on requires' 'Apply must re-check RLS admission.'
    Assert-NoMutation 'A failed Apply precondition must not mutate.'

    # --- Digital usage requires the usage rollup ---
    Reset-ProductMock; Add-BothTables @('classpilot_usage_rollups')
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ CLASSPILOT_DIGITAL_USAGE_MODE = 'on' }) } 'requires CLASSPILOT_USAGE_ROLLUP_MODE=on' 'Digital usage alone must be refused.'
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ CLASSPILOT_DIGITAL_USAGE_MODE = 'on'; CLASSPILOT_USAGE_ROLLUP_MODE = 'off' }) } 'requires CLASSPILOT_USAGE_ROLLUP_MODE=on' 'Digital usage with the rollup off must be refused.'
    $both = New-TestProductPlan (New-TestConfig @{ CLASSPILOT_USAGE_ROLLUP_MODE = 'on'; CLASSPILOT_DIGITAL_USAGE_MODE = 'on' })
    Assert-Condition ('usageRollup' -cin @($both.plan.activations) -and 'digitalUsage' -cin @($both.plan.activations)) 'Both usage features may activate together.'
    Set-BothEnvironment 'CLASSPILOT_USAGE_ROLLUP_MODE' 'on'; Set-BothEnvironment 'CLASSPILOT_DIGITAL_USAGE_MODE' 'on'
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ CLASSPILOT_USAGE_ROLLUP_MODE = 'off' }) } 'requires CLASSPILOT_USAGE_ROLLUP_MODE=on' 'The rollup cannot turn off under live digital usage.'
    Assert-ThrowsMatch { New-TestProductPlan (New-TestConfig @{ CLASSPILOT_USAGE_ROLLUP_MODE = $null }) } 'requires CLASSPILOT_USAGE_ROLLUP_MODE=on' 'The rollup cannot be unset under live digital usage.'
    Remove-TestTable 'api' 'classpilot_usage_rollups'
    $offBoth = New-TestProductPlan (New-TestConfig @{ CLASSPILOT_USAGE_ROLLUP_MODE = 'off'; CLASSPILOT_DIGITAL_USAGE_MODE = 'off' })
    Assert-Condition (@($offBoth.plan.activations).Count -eq 0) 'Turning both off must plan without preconditions.'

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
    Assert-ThrowsMatch { Invoke-ProductApply $plan.plan $plan.sha256 $script:TestDirectory } 'does not carry exactly the planned' 'A worker revision with an extra managed value must stop the operation.'
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

    # --- Entry point: private strict JSON file, Execute gate ---
    Reset-ProductMock; Add-BothTables $script:RulesTables
    $configPath = Join-Path $script:TestDirectory 'product-config.json'
    [IO.File]::WriteAllText($configPath, '{"schemaVersion":1,"environment":{"PASSPILOT_RULES_MODE":"on"}}')
    $script:Action = 'Plan'; $script:ConfigPath = $configPath; $script:OutDir = $script:TestDirectory; $script:DailyUsageEvidencePath = $null
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

    Write-Host "Product runtime configuration tests passed ($script:Assertions assertions)."
} finally {
    $resolved = [IO.Path]::GetFullPath($script:TestDirectory)
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolved.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notlike 'product-runtime-mock-*') { throw 'Unsafe test cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
}
