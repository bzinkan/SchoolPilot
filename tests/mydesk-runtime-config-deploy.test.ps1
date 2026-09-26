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
foreach ($name in @('Assert-Condition', 'Assert-Throws', 'Get-ArgumentValue', 'New-TestTaskResponse', 'New-TestService', 'Copy-RegisteredTask')) {
    $definition = $fixtureAst.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name }, $true)
    if ($null -eq $definition) { throw "Missing fixture helper $name" }
    . ([scriptblock]::Create($definition.Extent.Text))
}
. (Join-Path $PSScriptRoot '../scripts/deploy-mydesk-runtime-config.ps1')
$readinessAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../scripts/run-mydesk-readiness.ps1'), [ref]$null, [ref]$null)
$script:MyDeskReadinessRepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
foreach ($definition in $readinessAst.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    . ([scriptblock]::Create($definition.Extent.Text))
}

$script:TestDirectory = Join-Path ([IO.Path]::GetTempPath()) ('mydesk-runtime-mock-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($script:TestDirectory)
$script:TestSha = 'a' * 40
$script:TestDigest = 'sha256:' + ('b' * 64)
$script:TestApiArn = 'arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:146'
$script:TestWorkerArn = 'arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:161'
$script:TestConfig = [pscustomobject]@{ mode = 'on'; seatingMode = 'on'; aiImportMode = 'off'; bucket = 'schoolpilot-production-mydesk-attachments'; model = 'claude-sonnet-5'; teacherDailyPages = 100; schoolDailyPages = 500 }

function Copy-TestValue($Value) { return ($Value | ConvertTo-Json -Depth 50 | ConvertFrom-Json -Depth 50) }
function Set-TestEnvironment($Response, [string]$Name, [string]$Value) {
    $container = $Response.taskDefinition.containerDefinitions[0]
    $container.environment = @($container.environment | Where-Object name -CNE $Name) + @([pscustomobject]@{ name = $Name; value = $Value })
}
function Reset-MyDeskMock {
    $envs = @(
        [pscustomobject]@{ name = 'RLS_GUC_ENABLED'; value = 'true' },
        [pscustomobject]@{ name = 'RLS_ENABLED_TABLES'; value = 'students,' + ($script:MyDeskTables -join ',') },
        [pscustomobject]@{ name = 'CLASSPILOT_CAPABILITY_ROLLOUTS_JSON'; value = '{"unchanged":"private-existing-runtime"}' },
        [pscustomobject]@{ name = 'CLIENT_URL'; value = 'https://school-pilot.net' }
    )
    $key = [pscustomobject]@{ name = 'ANTHROPIC_API_KEY'; valueFrom = 'arn:aws:ssm:us-east-1:135775632425:parameter/test/anthropic' }
    $api = New-TestTaskResponse api $script:TestApiArn $script:TestDigest $envs @($key)
    $worker = New-TestTaskResponse worker $script:TestWorkerArn $script:TestDigest $envs @($key)
    $script:Mock = @{
        Tasks = @{ $script:TestApiArn = $api; $script:TestWorkerArn = $worker }
        Services = [pscustomobject]@{ Api = (New-TestService api $script:TestApiArn 3); Worker = (New-TestService worker $script:TestWorkerArn 1) }
        Scaling = [pscustomobject]@{ Min = 3; Max = 6; DynamicIn = $false; DynamicOut = $false; Scheduled = $false }
        Calls = [Collections.Generic.List[string]]::new(); Requests = [Collections.Generic.List[object]]::new()
        Revision = 200; FailWorkerOnce = $false; FailRecovery = $false; FailedWorker = $false
        PublicBucket = $false; ExpireObjects = $false; Versioning = $null
        DuplicateTlsResource = $false; NarrowTlsCondition = $false
        BadIam = $false; DeniedObjects = $false; BroadObjects = $false; FailStart = $false
        ReadinessRequests = [Collections.Generic.List[object]]::new(); ReadinessLostResponse = $false; ReadinessExitCode = 0
        ReadinessExtraOutput = $false; ReadinessReport = $null; ReadinessSplitOutput = $false
    }
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
    switch ($operation) {
        'sts get-caller-identity' { return [pscustomobject]@{ Account = $script:AccountId } }
        'ecr describe-images' { return [pscustomobject]@{ imageDetails = @([pscustomobject]@{ imageDigest = $script:TestDigest }) } }
        'ecs describe-task-definition' { return Copy-TestValue $script:Mock.Tasks[(Get-ArgumentValue $Arguments '--task-definition')] }
        'ecs register-task-definition' {
            $path = (Get-ArgumentValue $Arguments '--cli-input-json').Substring(7)
            $request = [IO.File]::ReadAllText($path) | ConvertFrom-Json -Depth 50
            $script:Mock.Requests.Add((Copy-TestValue $request))
            $script:Mock.Revision++
            $arn = "arn:aws:ecs:us-east-1:135775632425:task-definition/$($request.family):$($script:Mock.Revision)"
            $task = Copy-TestValue $request
            $tags = @($task.tags); $task.PSObject.Properties.Remove('tags')
            $task | Add-Member taskDefinitionArn $arn; $task | Add-Member status 'ACTIVE'
            $task | Add-Member revision $script:Mock.Revision
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
        's3api get-public-access-block' { return [pscustomobject]@{ PublicAccessBlockConfiguration = [pscustomobject]@{ BlockPublicAcls = (-not $script:Mock.PublicBucket); IgnorePublicAcls = $true; BlockPublicPolicy = $true; RestrictPublicBuckets = $true } } }
        's3api get-bucket-encryption' { return [pscustomobject]@{ ServerSideEncryptionConfiguration = [pscustomobject]@{ Rules = @([pscustomobject]@{ ApplyServerSideEncryptionByDefault = [pscustomobject]@{ SSEAlgorithm = 'AES256' } }) } } }
        's3api get-bucket-ownership-controls' { return [pscustomobject]@{ OwnershipControls = [pscustomobject]@{ Rules = @([pscustomobject]@{ ObjectOwnership = 'BucketOwnerEnforced' }) } } }
        's3api get-bucket-policy' {
            $policy = @{ Version = '2012-10-17'; Statement = @(@{ Sid = 'RequireTLS'; Effect = 'Deny'; Principal = '*'; Action = 's3:*'; Resource = @('arn:aws:s3:::schoolpilot-production-mydesk-attachments', 'arn:aws:s3:::schoolpilot-production-mydesk-attachments/*'); Condition = @{ Bool = @{ 'aws:SecureTransport' = 'false' } } }) }
            if ($script:Mock.DuplicateTlsResource) { $policy.Statement[0].Resource = @('arn:aws:s3:::schoolpilot-production-mydesk-attachments','arn:aws:s3:::schoolpilot-production-mydesk-attachments') }
            if ($script:Mock.NarrowTlsCondition) { $policy.Statement[0].Condition.StringEquals = @{ 'aws:PrincipalArn' = 'arn:aws:iam::135775632425:role/unrelated' } }
            return [pscustomobject]@{ Policy = ($policy | ConvertTo-Json -Depth 20) }
        }
        's3api get-bucket-lifecycle-configuration' {
            $rule = [pscustomobject]@{ Status = 'Enabled'; AbortIncompleteMultipartUpload = @{ DaysAfterInitiation = 1 } }
            if ($script:Mock.ExpireObjects) { $rule | Add-Member Expiration @{ Days = 30 } }
            return [pscustomobject]@{ Rules = @($rule) }
        }
        's3api get-bucket-versioning' {
            if ($null -ne $script:Mock.Versioning) { return [pscustomobject]@{ Status = $script:Mock.Versioning } }
            return [pscustomobject]@{}
        }
        'iam get-role-policy' {
            $policy = [pscustomobject]@{ Version = '2012-10-17'; Statement = @(
                [pscustomobject]@{ Sid = 'NotebookObjects'; Effect = 'Allow'; Action = @('s3:PutObject','s3:GetObject','s3:DeleteObject'); Resource = 'arn:aws:s3:::schoolpilot-production-mydesk-attachments/mydesk/*' },
                [pscustomobject]@{ Sid = 'ReconcileNotebookObjects'; Effect = 'Allow'; Action = 's3:ListBucket'; Resource = 'arn:aws:s3:::schoolpilot-production-mydesk-attachments'; Condition = [pscustomobject]@{ StringLike = [pscustomobject]@{ 's3:prefix' = @('mydesk/','mydesk/*') } } }
            ) }
            if ($script:Mock.BadIam) { $policy.Statement[0].Resource = '*' }
            return [pscustomobject]@{ PolicyDocument = [Uri]::EscapeDataString(($policy | ConvertTo-Json -Depth 20)) }
        }
        'iam simulate-principal-policy' {
            $resource = Get-ArgumentValue $Arguments '--resource-arns'
            $outside = $resource -like '*/outside-mydesk/*'
            $decision = if ($outside) { if ($script:Mock.BroadObjects) { 'allowed' } else { 'implicitDeny' } } else { if ($script:Mock.DeniedObjects) { 'explicitDeny' } else { 'allowed' } }
            return [pscustomobject]@{ EvaluationResults = @('s3:GetObject','s3:PutObject','s3:DeleteObject' | ForEach-Object {
                [pscustomobject]@{ EvalActionName = $_; EvalResourceName = $resource; EvalDecision = $decision }
            }) }
        }
        'ecs run-task' {
            $path = (Get-ArgumentValue $Arguments '--cli-input-json').Substring(7)
            $request = [IO.File]::ReadAllText($path) | ConvertFrom-Json -Depth 50
            $script:Mock.ReadinessRequests.Add($request)
            if ($script:Mock.ReadinessLostResponse -and $script:Mock.ReadinessRequests.Count -eq 1) { throw 'Lost RunTask response' }
            return [pscustomobject]@{ failures = @(); tasks = @([pscustomobject]@{ taskArn = ('arn:aws:ecs:us-east-1:135775632425:task/schoolpilot-production-cluster/' + ('c' * 32)) }) }
        }
        'ecs describe-tasks' {
            $request = $script:Mock.ReadinessRequests[0]
            return [pscustomobject]@{ failures = @(); tasks = @([pscustomobject]@{
                taskArn = Get-ArgumentValue $Arguments '--tasks'; taskDefinitionArn = $request.taskDefinition; startedBy = $request.startedBy; lastStatus = 'STOPPED'
                containers = @([pscustomobject]@{ name = 'scheduler-worker'; exitCode = $script:Mock.ReadinessExitCode })
            }) }
        }
        'logs get-log-events' {
            $text = $script:Mock.ReadinessReport | ConvertTo-Json -Depth 50 -Compress
            $events = if ($script:Mock.ReadinessSplitOutput) {
                $midpoint = [int]($text.Length / 2)
                @([pscustomobject]@{ message = $text.Substring(0,$midpoint) }, [pscustomobject]@{ message = $text.Substring($midpoint) })
            } else { @([pscustomobject]@{ message = $text }) }
            if ($script:Mock.ReadinessExtraOutput) { $events += [pscustomobject]@{ message = 'private source text must never be persisted' } }
            return [pscustomobject]@{ events = $events; nextForwardToken = 'unused' }
        }
        'ecs stop-task' { return [pscustomobject]@{} }
        'ecs deregister-task-definition' { return [pscustomobject]@{} }
        default { throw "Unmocked external operation: $operation" }
    }
}
function Get-ServiceSnapshot { return Copy-TestValue $script:Mock.Services }
function Start-Sleep { param($Seconds) } # Bounded poll loops remain deterministic under mocked transport.
function Assert-ApiTargetHealth { param($ApiService, $ExpectedDesiredCount, $Mode) return $true }
function Get-ScalingSnapshot { return Copy-TestValue $script:Mock.Scaling }
function Assert-ScheduledScalingContract { }
function Assert-RuntimeConfigMutationWindow { }
function Assert-RepositoryIdentity { param($RepositoryRoot, $ExpectedSha) if ($ExpectedSha -and $ExpectedSha -cne $script:TestSha) { throw 'Tool SHA drift' }; return $script:TestSha }
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
function New-TestMyDeskPlan($Config = $script:TestConfig, $EvidencePath = $null) {
    return New-MyDeskPlan $Config $script:TestDirectory $script:TestApiArn $script:TestWorkerArn $script:TestDigest $script:TestSha $EvidencePath
}
function New-TestAiEvidence {
    $processing = Get-Content (Join-Path $PSScriptRoot '../src/services/mydeskImportProcessing.ts') -Raw
    $prompt = [regex]::Match($processing, 'MYDESK_IMPORT_PROMPT_VERSION\s*=\s*"([a-zA-Z0-9-]+)"').Groups[1].Value
    return [pscustomobject]@{
        schemaVersion = 1; reviewedAt = [DateTimeOffset]::UtcNow.ToString('o'); reviewReference = 'synthetic-review-1'; imageDigest = $script:TestDigest
        model = 'claude-sonnet-5'; promptVersion = $prompt; providerReviewApproved = $true
        qualityReportSha256 = ('c' * 64); capacityReportSha256 = ('d' * 64); typedPrecision = 0.98; typedRecall = 0.97; typedFieldAccuracy = 0.99
        criticalFailures = 0; pageCount = 30; formCount = 60; correctionTimingRecorded = $true; workerCpu = '256'; workerMemory = '512'
        peakMemoryFraction = 0.6; apiP95Ratio = 1.1; noServiceDisruption = $true; reviewAndRecoveryPassed = $true
    }
}
function Reset-ReadinessMock {
    Reset-MyDeskMock
    $worker = $script:Mock.Tasks[$script:TestWorkerArn].taskDefinition.containerDefinitions[0]
    $worker.logConfiguration.options | Add-Member 'awslogs-stream-prefix' 'ecs'
    $worker.secrets += [pscustomobject]@{ name = 'DATABASE_URL'; valueFrom = 'arn:aws:ssm:us-east-1:135775632425:parameter/test/DATABASE_URL' }
    $script:Mock.Services.Worker | Add-Member networkConfiguration ([pscustomobject]@{
        awsvpcConfiguration = [pscustomobject]@{ subnets = @('subnet-1234'); securityGroups = @('sg-5678'); assignPublicIp = 'ENABLED' }
    })
    $script:Mock.ReadinessReport = [pscustomobject]@{
        version = 1; mode = 'read_only_inventory'; requiresConstraintReview = $true
        role = [pscustomobject]@{ name = 'schoolpilot'; superuser = $false; bypassRls = $false }
        ledger = @('mydesk-private-notebook-20260925','mydesk-private-seating-20260925','mydesk-ai-imports-20260925' | ForEach-Object {
            [pscustomobject]@{ id = $_; expectedChecksum = ('a' * 64); checksumMatches = $true; status = 'complete' }
        })
        tables = @($script:MyDeskTables | ForEach-Object { [pscustomobject]@{ name = $_; present = $true; enabled = $true; forced = $true; canonicalPolicy = $true; policyCount = 1; counts = [pscustomobject]@{ total = '0'; byState = [pscustomobject]@{ ready = '0' } } } })
        columns = @([pscustomobject]@{ tableName = 'mydesk_notes'; name = 'school_id'; type = 'text'; nullable = $false })
        constraints = @([pscustomobject]@{ tableName = 'mydesk_notes'; name = 'example_fk'; type = 'f'; validated = $true; deleteAction = 'n'; deleteColumns = @('group_id'); definitionSha256 = ('b' * 64) })
        indexes = @([pscustomobject]@{ tableName = 'mydesk_notes'; name = 'example_idx'; valid = $true; ready = $true; definitionSha256 = ('c' * 64) })
    }
}

try {
    Reset-MyDeskMock
    foreach ($change in @(@('mode','pilot'), @('mode','*'), @('mode','ON'), @('teacherDailyPages',0), @('schoolDailyPages',100001), @('bucket','other-bucket'))) {
        $config = Copy-TestValue $script:TestConfig; $config.($change[0]) = $change[1]
        Assert-Throws { ConvertTo-MyDeskRuntime $config } 'Malformed global runtime must be rejected.'
    }
    $disabled = Copy-TestValue $script:TestConfig; $disabled.mode = 'off'
    Assert-Throws { ConvertTo-MyDeskRuntime $disabled } 'Child features require the base mode.'
    $extra = Copy-TestValue $script:TestConfig; $extra | Add-Member schoolId 'forbidden-opt-in'
    Assert-Throws { ConvertTo-MyDeskRuntime $extra } 'Runtime must not accept per-school opt-ins.'

    $plan = New-TestMyDeskPlan
    Assert-Condition ($script:Mock.Requests.Count -eq 0 -and -not $script:OperationLockHeld) 'Planning must not register or update AWS state.'
    Assert-Condition ((Read-MyDeskPlan $plan.path $plan.sha256).runId -ceq $plan.plan.runId) 'A valid frozen plan must load.'
    Assert-Throws { Read-MyDeskPlan $plan.path ('e' * 64) } 'A mismatched plan hash must fail.'
    $sourceApi = Copy-TestValue $script:Mock.Tasks[$script:TestApiArn]
    $sourceWorker = Copy-TestValue $script:Mock.Tasks[$script:TestWorkerArn]
    $result = Invoke-MyDeskApply $plan.plan $plan.sha256 $script:TestDirectory
    Assert-Condition ($result.status -ceq 'applied' -and $script:Mock.Requests.Count -eq 2) 'Successful apply must register exactly the API/worker pair.'
    Assert-Condition (-not $script:OperationLockHeld -and -not $script:ScalingHoldAcquired) 'Successful apply must release the fence and restore scaling.'
    $order = @($script:Mock.Calls | Where-Object { $_ -like 'update:*' -or $_ -ceq 'wait' }) -join ','
    Assert-Condition ($order -ceq 'update:Api,wait,update:Worker,wait') 'API convergence must precede the worker rollout.'
    foreach ($entry in @(@($sourceApi,'api',$result.apiArn), @($sourceWorker,'scheduler-worker',$result.workerArn))) {
        $registered = $script:Mock.Tasks[$entry[2]]
        Assert-Condition ((Get-TaskFingerprint $entry[0].taskDefinition $entry[1]) -ceq (Get-TaskFingerprint $registered.taskDefinition $entry[1])) 'Apply must preserve image, RLS, resources, IAM, secrets and unrelated environment.'
        Assert-Condition ((Get-TaskTagsFingerprint $entry[0].tags) -ceq (Get-TaskTagsFingerprint $registered.tags)) 'Apply must preserve tags.'
    }

    # Exercise the real rollback entrypoint using the persisted activation receipt.
    $script:Action = 'Rollback'; $script:Execute = $true; $script:ManifestPath = $plan.path; $script:ManifestHash = $plan.sha256; $script:AiReadinessPath = $null
    Invoke-MyDeskMain
    foreach ($role in @('Api','Worker')) {
        $response = $script:Mock.Tasks[$script:Mock.Services.$role.taskDefinition]
        $container = if ($role -ceq 'Api') { 'api' } else { 'scheduler-worker' }
        $env = Get-MyDeskEnvironment $response.taskDefinition $container
        Assert-Condition ($env['MYDESK_MODE'] -ceq 'off' -and $env['MYDESK_ATTACHMENTS_BUCKET'] -ceq $script:TestConfig.bucket) 'Rollback must disable prior modes while retaining durable cleanup storage.'
        Assert-Condition ($response.taskDefinition.containerDefinitions[0].image.EndsWith($script:TestDigest)) 'Rollback must retain the serving image digest.'
    }

    Reset-MyDeskMock; $plan = New-TestMyDeskPlan
    Set-TestEnvironment $script:Mock.Tasks[$script:TestApiArn] 'CLIENT_URL' 'https://changed.invalid'
    Assert-Throws { Invoke-MyDeskApply $plan.plan $plan.sha256 $script:TestDirectory } 'Unrelated runtime drift must stop before mutation.'
    Assert-Condition ($script:Mock.Requests.Count -eq 0 -and -not $script:OperationLockHeld) 'A stale plan must perform no mutation.'
    Reset-MyDeskMock
    Set-TestEnvironment $script:Mock.Tasks[$script:TestWorkerArn] 'RLS_ENABLED_TABLES' 'students,mydesk_notes'
    Assert-Throws { New-TestMyDeskPlan } 'Missing six-table RLS admission must block configuration.'
    Reset-MyDeskMock
    Set-TestEnvironment $script:Mock.Tasks[$script:TestWorkerArn] 'MYDESK_MODE' 'on'
    Assert-Throws { New-TestMyDeskPlan } 'API/worker availability disagreement must block configuration.'
    Reset-MyDeskMock
    Set-TestEnvironment $script:Mock.Tasks[$script:TestApiArn] 'MYDESK_ENABLED_SCHOOL_IDS' 'retired'
    Assert-Throws { New-TestMyDeskPlan } 'Retired school allowlists must not survive runtime activation.'
    Reset-MyDeskMock
    foreach ($arn in @($script:TestApiArn,$script:TestWorkerArn)) {
        Set-TestEnvironment $script:Mock.Tasks[$arn] 'MYDESK_ATTACHMENTS_BUCKET' 'other-existing-private-notebook'
    }
    Assert-Throws { New-TestMyDeskPlan } 'Availability changes must not silently move existing notebook objects to another bucket.'
    Reset-MyDeskMock; $script:Mock.PublicBucket = $true
    Assert-Throws { New-TestMyDeskPlan } 'A public bucket must block configuration.'
    Reset-MyDeskMock; $script:Mock.ExpireObjects = $true
    Assert-Throws { New-TestMyDeskPlan } 'Blanket object expiration must block configuration.'
    foreach ($failure in @('BadIam','DeniedObjects','BroadObjects')) {
        Reset-MyDeskMock; $script:Mock[$failure] = $true
        Assert-Throws { New-TestMyDeskPlan } 'Unready or excessive task-role storage permissions must block configuration.'
    }
    foreach ($failure in @('DuplicateTlsResource','NarrowTlsCondition')) {
        Reset-MyDeskMock; $script:Mock[$failure] = $true
        Assert-Throws { New-TestMyDeskPlan } 'Weakened TLS denial must block configuration even when matching policy entries exist.'
    }
    foreach ($versioning in @('Enabled','Suspended')) {
        Reset-MyDeskMock; $script:Mock.Versioning = $versioning
        Assert-Throws { New-TestMyDeskPlan } 'Previously or currently versioned storage must not silently retain purged private sources.'
    }

    Reset-MyDeskMock; $plan = New-TestMyDeskPlan; $script:Mock.FailWorkerOnce = $true
    Assert-Throws { Invoke-MyDeskApply $plan.plan $plan.sha256 $script:TestDirectory } 'Ambiguous service update must remain an unsuccessful activation.'
    $receipt = (Read-StrictJsonSnapshot (Join-Path $script:TestDirectory "$($plan.plan.runId)-result.json")).Value
    Assert-Condition ($receipt.status -ceq 'rolled_back') 'A recoverable failure must restore prior modes using fresh clones.'
    Assert-Condition ($script:Mock.Requests.Count -eq 4 -and -not $script:OperationLockHeld) 'Verified recovery must register its pair and release the fence.'
    $env = Get-MyDeskEnvironment $script:Mock.Tasks[$receipt.apiArn].taskDefinition 'api'
    Assert-Condition ($env['MYDESK_MODE'] -ceq 'off' -and $env['MYDESK_ATTACHMENTS_BUCKET'] -ceq $script:TestConfig.bucket) 'Recovery must preserve cleanup storage.'
    $order = @($script:Mock.Calls | Where-Object { $_ -like 'update:*' -or $_ -ceq 'wait' }) -join ','
    Assert-Condition ($order -ceq 'update:Api,wait,update:Worker,update:Api,wait,update:Worker,wait') 'Recovery must retain the API-first overlap bound.'

    Reset-MyDeskMock
    foreach ($arn in @($script:TestApiArn,$script:TestWorkerArn)) {
        foreach ($pair in @(@('MYDESK_MODE','on'), @('MYDESK_AI_IMPORT_MODE','on'), @('MYDESK_AI_IMPORT_MODEL','claude-sonnet-5'),
            @('MYDESK_AI_IMPORT_TEACHER_DAILY_PAGES','75'), @('MYDESK_AI_IMPORT_SCHOOL_DAILY_PAGES','250'))) {
            Set-TestEnvironment $script:Mock.Tasks[$arn] $pair[0] $pair[1]
        }
    }
    $offPlanConfig = Copy-TestValue $script:TestConfig
    $offPlanConfig.model = 'claude-unreviewed-next'; $offPlanConfig.teacherDailyPages = 1000; $offPlanConfig.schoolDailyPages = 5000
    $plan = New-TestMyDeskPlan $offPlanConfig; $script:Mock.FailWorkerOnce = $true
    Assert-Throws { Invoke-MyDeskApply $plan.plan $plan.sha256 $script:TestDirectory } 'Failed AI disable/configuration changes must restore only the prior proven configuration.'
    $receipt = (Read-StrictJsonSnapshot (Join-Path $script:TestDirectory "$($plan.plan.runId)-result.json")).Value
    Assert-Condition ($receipt.status -ceq 'rolled_back') 'Prior AI configuration recovery should converge.'
    foreach ($entry in @(@($receipt.apiArn,'api'), @($receipt.workerArn,'scheduler-worker'))) {
        $env = Get-MyDeskEnvironment $script:Mock.Tasks[$entry[0]].taskDefinition $entry[1]
        Assert-Condition ($env['MYDESK_AI_IMPORT_MODE'] -ceq 'on' -and $env['MYDESK_AI_IMPORT_MODEL'] -ceq 'claude-sonnet-5' -and
            $env['MYDESK_AI_IMPORT_TEACHER_DAILY_PAGES'] -ceq '75' -and $env['MYDESK_AI_IMPORT_SCHOOL_DAILY_PAGES'] -ceq '250') 'Recovery must not turn AI on under an unreviewed model or budget.'
    }

    Reset-MyDeskMock; $plan = New-TestMyDeskPlan; $script:Mock.FailWorkerOnce = $true; $script:Mock.FailRecovery = $true
    Assert-Throws { Invoke-MyDeskApply $plan.plan $plan.sha256 $script:TestDirectory } 'Uncertain recovery must fail closed.'
    $receipt = (Read-StrictJsonSnapshot (Join-Path $script:TestDirectory "$($plan.plan.runId)-result.json")).Value
    Assert-Condition ($receipt.status -ceq 'recovery_required' -and $script:OperationLockHeld -and $script:ScalingHoldAcquired) 'An uncertain service pair must keep the operation fence and scaling hold.'

    Reset-MyDeskMock; $plan = New-TestMyDeskPlan; $script:Mock.FailStart = $true
    # Simulate a dot-sourced call after a previous completed operation.
    $script:ApiServiceMutationStarted = $true; $script:WorkerServiceMutationStarted = $true
    Assert-Throws { Invoke-MyDeskApply $plan.plan $plan.sha256 $script:TestDirectory } 'An ambiguous fence transition must fail closed.'
    Assert-Condition ($script:OperationLockHeld -and $script:Mock.Requests.Count -eq 0) 'A failed mutation-window transition must keep its fence without registering recovery tasks.'
    Assert-Condition (-not $script:ApiServiceMutationStarted -and -not $script:WorkerServiceMutationStarted) 'Sequential operations must reset their service-mutation markers.'

    Reset-MyDeskMock
    $ai = Copy-TestValue $script:TestConfig; $ai.aiImportMode = 'on'
    Assert-Throws { New-TestMyDeskPlan $ai } 'AI activation must require reviewed evidence.'
    $evidencePath = Join-Path $script:TestDirectory 'ai-evidence.json'
    $evidence = New-TestAiEvidence; Write-SanitizedJson $evidencePath $evidence
    $aiPlan = New-TestMyDeskPlan $ai $evidencePath
    Assert-Condition ($null -ne $aiPlan.plan.aiEvidence) 'Passing evidence must bind AI activation to its exact file hash.'
    foreach ($change in @(@('typedRecall',0.94), @('criticalFailures',1), @('providerReviewApproved',$false), @('workerMemory','1024'), @('peakMemoryFraction','0.6'), @('apiP95Ratio','1.1'), @('promptVersion','old-prompt'))) {
        $bad = Copy-TestValue $evidence; $bad.($change[0]) = $change[1]; Write-SanitizedJson $evidencePath $bad
        Assert-Throws { New-TestMyDeskPlan $ai $evidencePath } 'Incomplete or mismatched AI evidence must block activation.'
    }
    $evidence.reviewReference = 'changed-review'; Write-SanitizedJson $evidencePath $evidence
    Assert-Throws { Invoke-MyDeskApply $aiPlan.plan $aiPlan.sha256 $script:TestDirectory } 'Evidence changed after planning must block mutation.'
    Assert-Condition ($script:Mock.Requests.Count -eq 0) 'Rejected AI evidence must never register task definitions.'
    $aiPlan = New-TestMyDeskPlan $ai $evidencePath
    $aiResult = Invoke-MyDeskApply $aiPlan.plan $aiPlan.sha256 $script:TestDirectory
    Assert-Condition ($aiResult.status -ceq 'applied') 'Complete release-bound evidence must allow the mocked AI activation path.'
    Reset-MyDeskMock
    $script:Mock.Tasks[$script:TestWorkerArn].taskDefinition.containerDefinitions[0].secrets = @()
    Assert-Throws { New-TestMyDeskPlan $ai $evidencePath } 'AI requires a secret reference on both serving roles.'

    Reset-ReadinessMock
    $source = Copy-TestValue $script:Mock.Tasks[$script:TestWorkerArn]
    $script:Mock.ReadinessLostResponse = $true
    $script:Mock.ReadinessSplitOutput = $true
    $inventory = Invoke-MyDeskReadinessTask $script:TestWorkerArn $script:TestDigest $script:TestSha $script:TestDirectory
    $receipt = (Read-StrictJsonSnapshot $inventory.path).Value
    Assert-Condition ($receipt.status -ceq 'inventoried' -and $receipt.report.requiresConstraintReview) 'Read-only preflight must retain inventory without implying release approval.'
    Assert-Condition ($script:Mock.Requests.Count -eq 1 -and $script:Mock.ReadinessRequests.Count -eq 2) 'A lost RunTask response must retry the same temporary task request.'
    Assert-Condition ((Get-CanonicalJsonSha256 $script:Mock.ReadinessRequests[0]) -ceq (Get-CanonicalJsonSha256 $script:Mock.ReadinessRequests[1])) 'RunTask recovery must retain its exact idempotency token and request.'
    $run = $script:Mock.ReadinessRequests[0]
    Assert-Condition (($run.overrides.containerOverrides[0].command -join ' ') -ceq 'node dist/cli/inspectMyDeskReadiness.js' -and $run.count -eq 1) 'The task may execute only the bounded read-only inventory command.'
    Assert-Condition ((Get-CanonicalJsonSha256 $run.networkConfiguration) -ceq (Get-CanonicalJsonSha256 $script:Mock.Services.Worker.networkConfiguration)) 'Inventory must reuse the exact worker network.'
    Assert-Condition ((Get-CanonicalJsonSha256 $script:Mock.Requests[0].containerDefinitions[0].secrets) -ceq (Get-CanonicalJsonSha256 $source.taskDefinition.containerDefinitions[0].secrets)) 'Inventory must reuse references without reading or rewriting secret values.'
    Assert-Condition (@($script:Mock.Calls | Where-Object { $_ -ceq 'ecs update-service' }).Count -eq 0) 'Readiness inspection must never deploy a serving service.'
    Assert-Condition (@($script:Mock.Calls | Where-Object { $_ -ceq 'ecs deregister-task-definition' }).Count -eq 1) 'A completed inventory must retire its temporary definition.'
    $badReport = Copy-TestValue $script:Mock.ReadinessReport; $badReport | Add-Member privateBody 'private source text'
    Assert-Throws { ConvertTo-SafeMyDeskReadinessReport ($badReport | ConvertTo-Json -Depth 50) } 'Unexpected report fields must never reach the evidence file.'
    Reset-ReadinessMock; $script:Mock.ReadinessExtraOutput = $true
    Assert-Throws { Invoke-MyDeskReadinessTask $script:TestWorkerArn $script:TestDigest $script:TestSha $script:TestDirectory } 'Unexpected stdout must not be copied into private evidence.'
    Reset-ReadinessMock; $script:Mock.ReadinessExitCode = 1
    Assert-Throws { Invoke-MyDeskReadinessTask $script:TestWorkerArn $script:TestDigest $script:TestSha $script:TestDirectory } 'A failed inventory task must not report success.'
    Write-Host "My Desk runtime configuration tests passed ($script:Assertions assertions)."
} finally {
    $resolved = [IO.Path]::GetFullPath($script:TestDirectory)
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolved.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notlike 'mydesk-runtime-mock-*') { throw 'Unsafe test cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
}
