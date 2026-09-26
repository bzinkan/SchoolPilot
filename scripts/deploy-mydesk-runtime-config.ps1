#requires -Version 7.5
[CmdletBinding()]
param(
    [ValidateSet('Plan', 'Apply', 'Rollback')][string]$Action = 'Plan',
    [string]$ConfigPath, [string]$OutDir, [string]$ManifestPath, [string]$ManifestHash,
    [string]$ApiArn, [string]$WorkerArn, [string]$ImageDigest, [string]$AppSha,
    [string]$AiReadinessPath, [switch]$Execute
)

# Reuse the reviewed AWS transport, private files, task cloning, operation fence,
# autoscaling hold, health checks and exact convergence machinery. This entrypoint
# does not invoke the extension-capability workflow or change its configuration.
. "$PSScriptRoot/deploy-classpilot-runtime-config.ps1"
$script:RuntimeEnvironmentNames = @('MYDESK_MODE', 'MYDESK_SEATING_MODE', 'MYDESK_AI_IMPORT_MODE',
    'MYDESK_ATTACHMENTS_BUCKET', 'MYDESK_AI_IMPORT_MODEL', 'MYDESK_AI_IMPORT_TEACHER_DAILY_PAGES',
    'MYDESK_AI_IMPORT_SCHOOL_DAILY_PAGES')
$script:AllowedEnvironmentNames = @($script:RuntimeEnvironmentNames)
$script:AllowedSecretNames = @()
$script:MyDeskLegacyNames = @('MYDESK_ENABLED_SCHOOL_IDS', 'MYDESK_SEATING_ENABLED_SCHOOL_IDS', 'MYDESK_AI_IMPORT_ENABLED_SCHOOL_IDS')
$script:MyDeskTables = @('mydesk_attachments', 'mydesk_notes', 'mydesk_seating_charts',
    'mydesk_import_assets', 'mydesk_import_items', 'mydesk_imports')
$script:EvidenceRootMarkerName = '.schoolpilot-mydesk-runtime-evidence-v1'
$script:EvidenceRootMarkerBytes = [Text.Encoding]::UTF8.GetBytes("schoolpilot-mydesk-runtime-evidence-v1`n")

function ConvertTo-MyDeskRuntime {
    param([Parameter(Mandatory)]$Config)
    $names = @('mode', 'seatingMode', 'aiImportMode', 'bucket', 'model', 'teacherDailyPages', 'schoolDailyPages')
    Assert-ExactProperties -Value $Config -Allowed $names -Trail 'My Desk configuration'
    if (@($Config.PSObject.Properties.Name).Count -ne $names.Count) { throw 'My Desk configuration is incomplete.' }
    foreach ($name in @('mode', 'seatingMode', 'aiImportMode')) {
        if ($Config.$name -isnot [string] -or $Config.$name -cnotin @('off', 'on')) { throw 'My Desk modes must be exactly off or on.' }
    }
    if ($Config.mode -ceq 'off' -and ($Config.seatingMode -ceq 'on' -or $Config.aiImportMode -ceq 'on')) {
        throw 'Seating and imports require the base My Desk mode.'
    }
    if ($Config.bucket -cne 'schoolpilot-production-mydesk-attachments') { throw 'Use the reviewed private production My Desk bucket.' }
    if ($Config.model -isnot [string] -or $Config.model -cnotmatch '^claude-[a-z0-9-]{1,80}$') { throw 'Invalid dedicated import model.' }
    foreach ($entry in @(@('teacherDailyPages', 10000), @('schoolDailyPages', 100000))) {
        if (-not (Test-IsJsonInteger $Config.($entry[0])) -or $Config.($entry[0]) -lt 1 -or $Config.($entry[0]) -gt $entry[1]) {
            throw 'Invalid My Desk daily page budget.'
        }
    }
    return [pscustomobject]@{ Mode = $Config.mode; Turn = $null; Environment = [ordered]@{
        MYDESK_MODE = $Config.mode; MYDESK_SEATING_MODE = $Config.seatingMode; MYDESK_AI_IMPORT_MODE = $Config.aiImportMode
        MYDESK_ATTACHMENTS_BUCKET = $Config.bucket; MYDESK_AI_IMPORT_MODEL = $Config.model
        MYDESK_AI_IMPORT_TEACHER_DAILY_PAGES = [string]$Config.teacherDailyPages
        MYDESK_AI_IMPORT_SCHOOL_DAILY_PAGES = [string]$Config.schoolDailyPages
    } }
}

function Get-MyDeskEnvironment {
    param($Task, [string]$ContainerName)
    $containers = @($Task.containerDefinitions | Where-Object name -CEQ $ContainerName)
    if ($containers.Count -ne 1) { throw 'Ambiguous My Desk runtime container.' }
    $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
    foreach ($entry in @($containers[0].environment)) {
        if (-not $environment.TryAdd([string]$entry.name, [string]$entry.value)) { throw 'Duplicate runtime environment name.' }
    }
    foreach ($name in $script:MyDeskLegacyNames) {
        if ($environment.ContainsKey($name)) { throw 'Retired My Desk school allowlists must be removed in the reviewed backend release.' }
    }
    if ($environment.ContainsKey('MYDESK_ATTACHMENTS_BUCKET') -and
        $environment['MYDESK_ATTACHMENTS_BUCKET'] -cne '' -and
        $environment['MYDESK_ATTACHMENTS_BUCKET'] -cne 'schoolpilot-production-mydesk-attachments') {
        throw 'Changing an existing notebook storage bucket requires a separate data-preserving migration.'
    }
    foreach ($secret in @($containers[0].secrets)) {
        if ($secret.name -cin @($script:AllowedEnvironmentNames + $script:MyDeskLegacyNames)) { throw 'My Desk configuration uses an unexpected secret channel.' }
    }
    $modes = @{}
    foreach ($key in @('MYDESK_MODE', 'MYDESK_SEATING_MODE', 'MYDESK_AI_IMPORT_MODE')) {
        $modes[$key] = if ($environment.ContainsKey($key)) { $environment[$key] } else { 'off' }
        if ($modes[$key] -cnotin @('off', 'on')) { throw 'Invalid source My Desk mode.' }
    }
    if ($modes.MYDESK_MODE -ceq 'off' -and ($modes.MYDESK_SEATING_MODE -ceq 'on' -or $modes.MYDESK_AI_IMPORT_MODE -ceq 'on')) {
        throw 'Source child mode requires the base My Desk mode.'
    }
    return ,$environment
}

function Get-MyDeskSnapshot {
    param([string]$ExpectedApiArn, [string]$ExpectedWorkerArn, [string]$Digest, [string]$ReleaseSha)
    Assert-ExpectedReleaseIdentity -AppSha $ReleaseSha -ImageDigest $Digest -ApiTaskDefinitionArn $ExpectedApiArn -WorkerTaskDefinitionArn $ExpectedWorkerArn
    $identity = Invoke-AwsJson -Arguments @('sts', 'get-caller-identity', '--output', 'json')
    if ($identity.Account -cne $script:AccountId) { throw 'Wrong AWS account.' }
    $services = Get-ServiceSnapshot
    Assert-StableService -Service $services.Api -ExpectedTaskDefinitionArn $ExpectedApiArn -MinimumDesired 1 -MaximumDesired 3 -Label 'API'
    Assert-StableService -Service $services.Worker -ExpectedTaskDefinitionArn $ExpectedWorkerArn -MinimumDesired 1 -MaximumDesired 1 -Label 'worker'
    Assert-NormalServiceDeploymentConfiguration -Service $services.Api
    Assert-NormalServiceDeploymentConfiguration -Service $services.Worker
    [void](Assert-ApiTargetHealth -ApiService $services.Api -ExpectedDesiredCount $services.Api.desiredCount -Mode Exact)
    $api = Get-TaskDefinitionResponse -TaskDefinitionArn $ExpectedApiArn
    $worker = Get-TaskDefinitionResponse -TaskDefinitionArn $ExpectedWorkerArn
    $environments = @()
    foreach ($entry in @(@($api, $ExpectedApiArn, 'api'), @($worker, $ExpectedWorkerArn, 'scheduler-worker'))) {
        $task = $entry[0].taskDefinition
        [void](Assert-TaskDefinitionContract -Response $entry[0] -ExpectedArn $entry[1] -ExpectedFamily $task.family -ContainerName $entry[2] `
            -ExpectedDigest $Digest -ExpectedCpu $task.cpu -ExpectedMemory $task.memory)
        $environment = Get-MyDeskEnvironment -Task $task -ContainerName $entry[2]
        if (-not $environment.ContainsKey('RLS_GUC_ENABLED') -or $environment['RLS_GUC_ENABLED'] -cne 'true' -or
            -not $environment.ContainsKey('RLS_ENABLED_TABLES')) { throw 'My Desk requires the admitted RLS baseline.' }
        $tables = $environment['RLS_ENABLED_TABLES'].Split(',')
        if (@($script:MyDeskTables | Where-Object { $_ -cnotin $tables }).Count -gt 0) { throw 'Admit all six My Desk tables before configuring availability.' }
        $environments += ,$environment
    }
    if ($environments[0]['RLS_ENABLED_TABLES'] -cne $environments[1]['RLS_ENABLED_TABLES'] -or
        (Get-ManagedRuntimeFingerprint $api.taskDefinition 'api') -cne (Get-ManagedRuntimeFingerprint $worker.taskDefinition 'scheduler-worker')) {
        throw 'API and worker My Desk or RLS configuration differs.'
    }
    $ecr = Invoke-AwsJson -Arguments @('ecr', 'describe-images', '--repository-name', $script:EcrRepository,
        '--image-ids', "imageTag=$($ReleaseSha.Substring(0,12))", '--region', $script:Region, '--output', 'json')
    if (@($ecr.imageDetails).Count -ne 1 -or $ecr.imageDetails[0].imageDigest -cne $Digest) { throw 'Release tag does not match the serving image.' }
    return [pscustomobject]@{ Services = $services; ApiTask = $api; WorkerTask = $worker; Environments = $environments }
}

function Assert-MyDeskStorage {
    param([string]$Bucket)
    $prefix = @('--bucket', $Bucket, '--expected-bucket-owner', $script:AccountId, '--region', $script:Region, '--output', 'json')
    $public = Invoke-AwsJson -Arguments (@('s3api', 'get-public-access-block') + $prefix)
    foreach ($field in @('BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets')) {
        if ($public.PublicAccessBlockConfiguration.$field -ne $true) { throw 'Private bucket public-access blocking is incomplete.' }
    }
    $encryption = Invoke-AwsJson -Arguments (@('s3api', 'get-bucket-encryption') + $prefix)
    if (@($encryption.ServerSideEncryptionConfiguration.Rules).Count -ne 1 -or
        $encryption.ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm -cne 'AES256') { throw 'Unexpected My Desk encryption configuration.' }
    $ownership = Invoke-AwsJson -Arguments (@('s3api', 'get-bucket-ownership-controls') + $prefix)
    if (@($ownership.OwnershipControls.Rules).Count -ne 1 -or $ownership.OwnershipControls.Rules[0].ObjectOwnership -cne 'BucketOwnerEnforced') { throw 'Private bucket ownership controls are incomplete.' }
    $policyResult = Invoke-AwsJson -Arguments (@('s3api', 'get-bucket-policy') + $prefix)
    $policy = $policyResult.Policy | ConvertFrom-Json -Depth 20
    $expectedPolicy = [pscustomobject]@{ Version = '2012-10-17'; Statement = @([pscustomobject]@{
        Sid = 'RequireTLS'; Effect = 'Deny'; Principal = '*'; Action = 's3:*'
        Resource = @("arn:aws:s3:::$Bucket", "arn:aws:s3:::$Bucket/*")
        Condition = [pscustomobject]@{ Bool = [pscustomobject]@{ 'aws:SecureTransport' = 'false' } }
    }) }
    foreach ($document in @($policy, $expectedPolicy)) {
        foreach ($statement in @($document.Statement)) { $statement.Resource = @($statement.Resource | Sort-Object) }
        $document.Statement = @($document.Statement | Sort-Object Sid)
    }
    # Matching entries alone could accept duplicate bucket ARNs, omit the
    # object wildcard, or hide an extra condition narrowing the TLS denial.
    if ((Get-CanonicalJsonSha256 $policy) -cne (Get-CanonicalJsonSha256 $expectedPolicy)) { throw 'Unexpected private bucket policy.' }
    $lifecycle = Invoke-AwsJson -Arguments (@('s3api', 'get-bucket-lifecycle-configuration') + $prefix)
    foreach ($rule in @($lifecycle.Rules | Where-Object Status -CEQ 'Enabled')) {
        if ($rule.PSObject.Properties.Name -contains 'Expiration' -or $rule.PSObject.Properties.Name -contains 'NoncurrentVersionExpiration') {
            throw 'Notebook objects must not have blanket expiration.'
        }
    }
    $versioning = Invoke-AwsJson -Arguments (@('s3api', 'get-bucket-versioning') + $prefix)
    if ($null -ne $versioning.PSObject.Properties['Status']) {
        throw 'My Desk cleanup requires an unversioned bucket; versioned deletions would retain private content.'
    }
}

function Assert-MyDeskStorageRoles {
    param($Snapshot, [string]$Bucket)
    $roles = @($Snapshot.ApiTask.taskDefinition.taskRoleArn, $Snapshot.WorkerTask.taskDefinition.taskRoleArn) | Sort-Object -Unique
    foreach ($roleArn in $roles) {
        if ($roleArn -cnotmatch '^arn:aws:iam::135775632425:role/([a-zA-Z0-9+=,.@_/-]+)$') { throw 'Unexpected My Desk task role.' }
        $roleName = $Matches[1].Split('/')[-1]
        $response = Invoke-AwsJson -Arguments @('iam', 'get-role-policy', '--role-name', $roleName,
            '--policy-name', 'schoolpilot-production-mydesk-attachments', '--output', 'json')
        $policy = $response.PolicyDocument
        if ($policy -is [string]) { $policy = [Uri]::UnescapeDataString($policy) | ConvertFrom-Json -Depth 20 }
        $expected = [pscustomobject]@{ Version = '2012-10-17'; Statement = @(
            [pscustomobject]@{ Sid = 'NotebookObjects'; Effect = 'Allow'; Action = @('s3:PutObject', 's3:GetObject', 's3:DeleteObject'); Resource = "arn:aws:s3:::$Bucket/mydesk/*" },
            [pscustomobject]@{ Sid = 'ReconcileNotebookObjects'; Effect = 'Allow'; Action = @('s3:ListBucket'); Resource = "arn:aws:s3:::$Bucket";
                Condition = [pscustomobject]@{ StringLike = [pscustomobject]@{ 's3:prefix' = @('mydesk/', 'mydesk/*') } } }
        ) }
        # AWS may serialize singleton actions as scalars. Compare normalized
        # actions/statements while retaining exact resources and conditions.
        foreach ($document in @($policy, $expected)) {
            foreach ($statement in @($document.Statement)) { $statement.Action = @($statement.Action | Sort-Object) }
            $document.Statement = @($document.Statement | Sort-Object Sid)
        }
        if ((Get-CanonicalJsonSha256 $policy) -cne (Get-CanonicalJsonSha256 $expected)) { throw 'My Desk task-role policy differs from the reviewed prefix-scoped contract.' }
        $simulation = Invoke-AwsJson -Arguments @('iam', 'simulate-principal-policy', '--policy-source-arn', $roleArn,
            '--action-names', 's3:GetObject', 's3:PutObject', 's3:DeleteObject', '--resource-arns', "arn:aws:s3:::$Bucket/mydesk/operational-probe",
            '--output', 'json')
        if (@($simulation.EvaluationResults).Count -ne 3 -or @($simulation.EvaluationResults | Where-Object EvalDecision -CNE 'allowed').Count -gt 0) {
            throw 'Effective task-role object access is not ready.'
        }
        $outside = Invoke-AwsJson -Arguments @('iam', 'simulate-principal-policy', '--policy-source-arn', $roleArn,
            '--action-names', 's3:GetObject', 's3:PutObject', 's3:DeleteObject', '--resource-arns', "arn:aws:s3:::$Bucket/outside-mydesk/probe",
            '--output', 'json')
        if (@($outside.EvaluationResults).Count -ne 3 -or @($outside.EvaluationResults | Where-Object EvalDecision -CEQ 'allowed').Count -gt 0) {
            throw 'Task-role My Desk access is broader than its reviewed object prefix.'
        }
    }
}

function Assert-MyDeskAiReadiness {
    param($Config, $Snapshot, [string]$EvidencePath, [string]$Digest, [string]$RepositoryRoot)
    if ($Config.aiImportMode -ceq 'off') { return $null }
    if (-not $EvidencePath) { throw 'AI activation requires the provider, evaluation and capacity evidence.' }
    $path = Assert-PrivateInputPath -Path $EvidencePath -RepositoryRoot $RepositoryRoot
    $evidenceSnapshot = Read-StrictJsonSnapshot -Path $path
    $e = $evidenceSnapshot.Value
    $fields = @('schemaVersion', 'reviewedAt', 'reviewReference', 'imageDigest', 'model', 'promptVersion', 'providerReviewApproved',
        'qualityReportSha256', 'capacityReportSha256', 'typedPrecision', 'typedRecall', 'typedFieldAccuracy', 'criticalFailures',
        'pageCount', 'formCount', 'correctionTimingRecorded', 'workerCpu', 'workerMemory', 'peakMemoryFraction', 'apiP95Ratio',
        'noServiceDisruption', 'reviewAndRecoveryPassed')
    Assert-ExactProperties -Value $e -Allowed $fields -Trail 'AI readiness'
    if (@($e.PSObject.Properties.Name).Count -ne $fields.Count -or $e.schemaVersion -ne 1) { throw 'Incomplete AI readiness evidence.' }
    [void](Get-FreshEvidenceTimestamp -Value $e.reviewedAt -Label 'AI readiness' -Now ([DateTimeOffset]::UtcNow))
    $processing = [IO.File]::ReadAllText((Join-Path $RepositoryRoot 'src/services/mydeskImportProcessing.ts'))
    $prompt = [regex]::Match($processing, 'MYDESK_IMPORT_PROMPT_VERSION\s*=\s*"([a-zA-Z0-9-]+)"').Groups[1].Value
    if (-not $prompt -or $e.imageDigest -cne $Digest -or $e.model -cne $Config.model -or $e.promptVersion -cne $prompt -or
        $e.reviewReference -isnot [string] -or $e.reviewReference -notmatch '^[a-zA-Z0-9_./:-]{1,160}$' -or
        $e.qualityReportSha256 -cnotmatch '^[0-9a-f]{64}$' -or $e.capacityReportSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'AI readiness does not bind this release and provider review.' }
    foreach ($name in @('providerReviewApproved', 'correctionTimingRecorded', 'noServiceDisruption', 'reviewAndRecoveryPassed')) {
        if ($e.$name -isnot [bool] -or -not $e.$name) { throw 'AI readiness contains an incomplete required check.' }
    }
    foreach ($name in @('typedPrecision', 'typedRecall', 'typedFieldAccuracy')) {
        if ($e.$name -isnot [ValueType] -or $e.$name -is [bool] -or -not [double]::IsFinite([double]$e.$name) -or $e.$name -lt 0.95 -or $e.$name -gt 1) { throw 'AI extraction quality gate has not passed.' }
    }
    foreach ($name in @('peakMemoryFraction', 'apiP95Ratio')) {
        if ($e.$name -isnot [ValueType] -or $e.$name -is [bool] -or -not [double]::IsFinite([double]$e.$name)) { throw 'Capacity measurements must be finite JSON numbers.' }
    }
    if (-not (Test-IsJsonInteger $e.criticalFailures) -or $e.criticalFailures -ne 0 -or
        -not (Test-IsJsonInteger $e.pageCount) -or $e.pageCount -lt 30 -or
        -not (Test-IsJsonInteger $e.formCount) -or $e.formCount -lt 60 -or
        $e.peakMemoryFraction -le 0 -or $e.peakMemoryFraction -ge 0.70 -or $e.apiP95Ratio -le 0 -or $e.apiP95Ratio -gt 1.20 -or
        [string]$e.workerCpu -cne [string]$Snapshot.WorkerTask.taskDefinition.cpu -or
        [string]$e.workerMemory -cne [string]$Snapshot.WorkerTask.taskDefinition.memory) { throw 'AI capacity or evaluation gate has not passed for the serving worker.' }
    foreach ($task in @($Snapshot.ApiTask, $Snapshot.WorkerTask)) {
        $containers = @($task.taskDefinition.containerDefinitions | Where-Object name -CIn @('api', 'scheduler-worker'))
        $keys = @($containers[0].secrets | Where-Object name -CEQ 'ANTHROPIC_API_KEY')
        if ($keys.Count -ne 1 -or @($containers[0].environment | Where-Object name -CEQ 'ANTHROPIC_API_KEY').Count -gt 0) { throw 'AI requires the existing secret-reference channel on both services.' }
    }
    return [pscustomobject]@{ path = $path; sha256 = $evidenceSnapshot.Sha256 }
}

function New-MyDeskPlan {
    param($Config, [string]$Directory, [string]$ExpectedApiArn, [string]$ExpectedWorkerArn, [string]$Digest, [string]$ReleaseSha, [string]$EvidencePath)
    $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $toolSha = Assert-RepositoryIdentity -RepositoryRoot $repo
    $runtime = ConvertTo-MyDeskRuntime $Config
    $snapshot = Get-MyDeskSnapshot $ExpectedApiArn $ExpectedWorkerArn $Digest $ReleaseSha
    Assert-MyDeskStorage $Config.bucket
    Assert-MyDeskStorageRoles $snapshot $Config.bucket
    $aiEvidence = Assert-MyDeskAiReadiness $Config $snapshot $EvidencePath $Digest $repo
    $scaling = Get-ScalingSnapshot
    if ($scaling.DynamicIn -or $scaling.DynamicOut -or $scaling.Scheduled) { throw 'Another operation holds autoscaling.' }
    Assert-ScheduledScalingContract
    $directory = Assert-PrivateExternalRoot -Root $Directory -RepositoryRoot $repo
    $runId = [Guid]::NewGuid().ToString('N')
    $priorModes = [ordered]@{}
    foreach ($entry in @(@('mode','MYDESK_MODE'), @('seatingMode','MYDESK_SEATING_MODE'), @('aiImportMode','MYDESK_AI_IMPORT_MODE'))) {
        $value = if ($snapshot.Environments[0].ContainsKey($entry[1])) { $snapshot.Environments[0][$entry[1]] } else { 'off' }
        if ($value -cnotin @('off','on')) { throw 'Invalid prior My Desk mode.' }
        $priorModes[$entry[0]] = $value
    }
    $plan = [ordered]@{ schemaVersion = 1; runId = $runId; createdAt = [DateTimeOffset]::UtcNow.ToString('o')
        toolSha = $toolSha; appSha = $ReleaseSha; imageDigest = $Digest; apiArn = $ExpectedApiArn; workerArn = $ExpectedWorkerArn
        apiFingerprint = Get-TaskFingerprint $snapshot.ApiTask.taskDefinition 'api'
        workerFingerprint = Get-TaskFingerprint $snapshot.WorkerTask.taskDefinition 'scheduler-worker'
        managedFingerprint = Get-ManagedRuntimeFingerprint $snapshot.ApiTask.taskDefinition 'api'
        apiTags = Get-TaskTagsFingerprint @($snapshot.ApiTask.tags); workerTags = Get-TaskTagsFingerprint @($snapshot.WorkerTask.tags)
        apiDesired = [int]$snapshot.Services.Api.desiredCount; config = $Config; priorModes = $priorModes; aiEvidence = $aiEvidence
        deploymentHash = Get-CanonicalJsonSha256 @($snapshot.Services.Api.deploymentConfiguration, $snapshot.Services.Worker.deploymentConfiguration)
        scaling = $scaling
    }
    $path = Join-Path $directory "$runId-plan.json"
    Write-SanitizedJson -Path $path -Value $plan
    return [pscustomobject]@{ path = $path; sha256 = Get-FileSha256 $path; plan = [pscustomobject]$plan }
}

function Read-MyDeskPlan {
    param([string]$Path, [string]$Hash)
    $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    [void](Assert-PrivateInputPath -Path $Path -RepositoryRoot $repo)
    $snapshot = Read-StrictJsonSnapshot -Path $Path
    if ($Hash -cnotmatch '^[a-f0-9]{64}$' -or $snapshot.Sha256 -cne $Hash -or $snapshot.Value.schemaVersion -ne 1) { throw 'My Desk plan hash or version mismatch.' }
    $plan = $snapshot.Value
    [void](Assert-RepositoryIdentity -RepositoryRoot $repo -ExpectedSha $plan.toolSha)
    [void](ConvertTo-MyDeskRuntime $plan.config)
    if ($plan.runId -cnotmatch '^[a-f0-9]{32}$') { throw 'Invalid plan identifier.' }
    return $plan
}

function Invoke-MyDeskApply {
    param($Plan, [string]$Hash, [string]$Directory)
    $age = [DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse($Plan.createdAt)
    if ($age.TotalHours -gt 2 -or $age.TotalSeconds -lt -60) { throw 'Create a fresh My Desk plan before applying.' }
    Assert-RuntimeConfigMutationWindow
    $runtime = ConvertTo-MyDeskRuntime $Plan.config
    $snapshot = Get-MyDeskSnapshot $Plan.apiArn $Plan.workerArn $Plan.imageDigest $Plan.appSha
    Assert-MyDeskStorage $Plan.config.bucket
    Assert-MyDeskStorageRoles $snapshot $Plan.config.bucket
    $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $evidence = if ($null -ne $Plan.aiEvidence) { [string]$Plan.aiEvidence.path } else { $null }
    $checkedEvidence = Assert-MyDeskAiReadiness $Plan.config $snapshot $evidence $Plan.imageDigest $repo
    if ($null -ne $Plan.aiEvidence -and $checkedEvidence.sha256 -cne $Plan.aiEvidence.sha256) { throw 'AI readiness evidence changed.' }
    foreach ($check in @(
        @((Get-TaskFingerprint $snapshot.ApiTask.taskDefinition 'api'), $Plan.apiFingerprint),
        @((Get-TaskFingerprint $snapshot.WorkerTask.taskDefinition 'scheduler-worker'), $Plan.workerFingerprint),
        @((Get-ManagedRuntimeFingerprint $snapshot.ApiTask.taskDefinition 'api'), $Plan.managedFingerprint),
        @((Get-TaskTagsFingerprint @($snapshot.ApiTask.tags)), $Plan.apiTags),
        @((Get-TaskTagsFingerprint @($snapshot.WorkerTask.tags)), $Plan.workerTags),
        @((Get-CanonicalJsonSha256 @($snapshot.Services.Api.deploymentConfiguration, $snapshot.Services.Worker.deploymentConfiguration)), $Plan.deploymentHash),
        @((Get-CanonicalJsonSha256 (Get-ScalingSnapshot)), (Get-CanonicalJsonSha256 $Plan.scaling)))) {
        if ($check[0] -cne $check[1]) { throw 'Production state drifted after the My Desk plan.' }
    }
    if ($snapshot.Services.Api.desiredCount -ne $Plan.apiDesired) { throw 'API capacity changed after planning.' }
    $resultPath = Join-Path $Directory "$($Plan.runId)-result.json"
    if (Test-Path -LiteralPath $resultPath) { throw 'This plan already has a receipt; inspect it before creating a new operation.' }
    $candidate = @{}
    $checkpoint = [ordered]@{ schemaVersion = 1; runId = $Plan.runId; planSha256 = $Hash; status = 'preparing'
        priorApiArn = $Plan.apiArn; priorWorkerArn = $Plan.workerArn; apiArn = $null; workerArn = $null }
    Acquire-OperationLock -RunId $Plan.runId -PlanSha256 $Hash
    # A dot-sourced caller may run Apply and Rollback in the same process.
    # Recovery must describe this operation, never a prior completed rollout.
    $script:ApiServiceMutationStarted = $false
    $script:WorkerServiceMutationStarted = $false
    try {
        Start-OperationMutationWindow
        foreach ($role in @('Api', 'Worker')) {
            $source = $snapshot.($role + 'Task'); $task = $source.taskDefinition
            $container = if ($role -ceq 'Api') { 'api' } else { 'scheduler-worker' }
            $request = New-RuntimeTaskDefinitionRequest -SourceResponse $source -RuntimeConfiguration $runtime -ExpectedDigest $Plan.imageDigest `
                -ExpectedArn $task.taskDefinitionArn -ExpectedFamily $task.family -ContainerName $container -ExpectedCpu $task.cpu -ExpectedMemory $task.memory
            $candidate[$role] = Register-RuntimeTaskDefinition -Request $request -Directory $Directory -RuntimeConfiguration $runtime -ExpectedDigest $Plan.imageDigest `
                -SourceFingerprint (Get-TaskFingerprint $task $container) -SourceTagsFingerprint (Get-TaskTagsFingerprint @($source.tags)) `
                -ExpectedFamily $task.family -ContainerName $container -ExpectedCpu $task.cpu -ExpectedMemory $task.memory
            $checkpoint[($role.ToLowerInvariant() + 'Arn')] = $candidate[$role]
            Write-SanitizedJson -Path $resultPath -Value $checkpoint
        }
        [void](Acquire-ScalingHold)
        $before = Get-ServiceSnapshot
        if ($before.Api.taskDefinition -cne $Plan.apiArn -or $before.Worker.taskDefinition -cne $Plan.workerArn -or $before.Api.desiredCount -ne $Plan.apiDesired) { throw 'Service state changed before mutation.' }
        [void](Assert-ScalingHoldExact)
        # Converge the API before rolling the worker, bounding overlapping pools.
        $checkpoint.status = 'api_update_pending'; Write-SanitizedJson $resultPath $checkpoint
        Invoke-RuntimeServiceUpdate -Role api -TaskDefinitionArn $candidate.Api
        [void](Wait-ExactServicePairConvergence $candidate.Api $Plan.workerArn $Plan.apiDesired)
        $checkpoint.status = 'worker_update_pending'; Write-SanitizedJson $resultPath $checkpoint
        Invoke-RuntimeServiceUpdate -Role worker -TaskDefinitionArn $candidate.Worker
        [void](Wait-ExactServicePairConvergence $candidate.Api $candidate.Worker $Plan.apiDesired)
        [void](Restore-ScalingHold)
        $checkpoint.status = 'applied'; Write-SanitizedJson $resultPath $checkpoint
        Complete-OperationMutationWindow
        Release-OperationLock
        return [pscustomobject]$checkpoint
    } catch {
        # Restore prior feature modes in newly cloned definitions, retaining the
        # configured bucket even when the old definitions had none. Never strand
        # deletion work by sending services back to an unconfigured old revision.
        $checkpoint.status = 'recovery_required'; Write-SanitizedJson $resultPath $checkpoint
        if (-not $script:ApiServiceMutationStarted -and -not $script:WorkerServiceMutationStarted) {
            if ($script:ScalingHoldAcquired) { [void](Restore-ScalingHold) }
            # Start can fail after AWS accepted its fence update but before the
            # response reached us. Do not guess that a local preparing state is
            # safe to release; retain the receipt and let the operator inspect it.
            if ($script:OperationLockState -ceq 'mutating') {
                Complete-OperationMutationWindow
                Release-OperationLock
            }
        } else {
            try {
                $observed = Get-ServiceSnapshot
                if ($observed.Api.taskDefinition -cnotin @($Plan.apiArn, $candidate.Api) -or
                    $observed.Worker.taskDefinition -cnotin @($Plan.workerArn, $candidate.Worker) -or
                    $observed.Api.desiredCount -ne $Plan.apiDesired -or $observed.Worker.desiredCount -ne 1) { throw 'Recovery source drifted.' }
                [void](Assert-ScalingHoldExact)
                $recoveryConfig = $Plan.config | ConvertTo-Json | ConvertFrom-Json
                foreach ($name in @('mode', 'seatingMode', 'aiImportMode')) { $recoveryConfig.$name = $Plan.priorModes.$name }
                # An off-plan can change model/budgets without activation
                # evidence. Never restore prior AI=on under those new values.
                # Restore the frozen source configuration; only keep the newly
                # configured bucket so cleanup cannot lose its storage access.
                foreach ($entry in @(
                    @('model', 'MYDESK_AI_IMPORT_MODEL', 'claude-sonnet-5'),
                    @('teacherDailyPages', 'MYDESK_AI_IMPORT_TEACHER_DAILY_PAGES', '100'),
                    @('schoolDailyPages', 'MYDESK_AI_IMPORT_SCHOOL_DAILY_PAGES', '500'))) {
                    $value = if ($snapshot.Environments[0].ContainsKey($entry[1])) { $snapshot.Environments[0][$entry[1]] } else { $entry[2] }
                    if ($entry[0] -ceq 'model') { $recoveryConfig.model = $value }
                    else {
                        if ($value -cnotmatch '^[1-9][0-9]{0,5}$') { throw 'Prior AI budget cannot be safely restored.' }
                        $recoveryConfig.($entry[0]) = [long]$value
                    }
                }
                $recoveryRuntime = ConvertTo-MyDeskRuntime $recoveryConfig
                $recovery = @{}
                foreach ($role in @('Api', 'Worker')) {
                    $source = $snapshot.($role + 'Task'); $task = $source.taskDefinition
                    $container = if ($role -ceq 'Api') { 'api' } else { 'scheduler-worker' }
                    $request = New-RuntimeTaskDefinitionRequest -SourceResponse $source -RuntimeConfiguration $recoveryRuntime -ExpectedDigest $Plan.imageDigest `
                        -ExpectedArn $task.taskDefinitionArn -ExpectedFamily $task.family -ContainerName $container -ExpectedCpu $task.cpu -ExpectedMemory $task.memory
                    $recovery[$role] = Register-RuntimeTaskDefinition -Request $request -Directory $Directory -RuntimeConfiguration $recoveryRuntime -ExpectedDigest $Plan.imageDigest `
                        -SourceFingerprint (Get-TaskFingerprint $task $container) -SourceTagsFingerprint (Get-TaskTagsFingerprint @($source.tags)) `
                        -ExpectedFamily $task.family -ContainerName $container -ExpectedCpu $task.cpu -ExpectedMemory $task.memory
                    $checkpoint[($role.ToLowerInvariant() + 'Arn')] = $recovery[$role]
                    Write-SanitizedJson $resultPath $checkpoint
                }
                Invoke-RuntimeServiceUpdate -Role api -TaskDefinitionArn $recovery.Api
                [void](Wait-ExactServicePairConvergence $recovery.Api $observed.Worker.taskDefinition $Plan.apiDesired)
                Invoke-RuntimeServiceUpdate -Role worker -TaskDefinitionArn $recovery.Worker
                [void](Wait-ExactServicePairConvergence $recovery.Api $recovery.Worker $Plan.apiDesired)
                [void](Restore-ScalingHold)
                $checkpoint.status = 'rolled_back'; Write-SanitizedJson $resultPath $checkpoint
                Complete-OperationMutationWindow; Release-OperationLock
            } catch {
                # Keep the non-stealable mutation fence and source/candidate
                # receipt when even bounded recovery cannot prove convergence.
                $checkpoint.status = 'recovery_required'; Write-SanitizedJson $resultPath $checkpoint
            }
        }
        throw 'My Desk configuration did not finish. Inspect the private receipt for rolled_back or recovery_required; preserve an uncertain operation fence.'
    }
}

function Invoke-MyDeskMain {
    if ($Action -ceq 'Plan') {
        if (-not $ConfigPath -or -not $OutDir) { throw 'Plan requires ConfigPath and OutDir.' }
        $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
        [void](Assert-PrivateInputPath -Path $ConfigPath -RepositoryRoot $repo)
        $config = (Read-StrictJsonSnapshot -Path $ConfigPath).Value
        $created = New-MyDeskPlan $config $OutDir $ApiArn $WorkerArn $ImageDigest $AppSha $AiReadinessPath
        Write-Host "My Desk plan: $($created.path) sha256=$($created.sha256)"
        return
    }
    if (-not $Execute -or -not $ManifestPath -or -not $ManifestHash) { throw 'Apply/Rollback requires Execute, ManifestPath and ManifestHash.' }
    $plan = Read-MyDeskPlan $ManifestPath $ManifestHash
    $directory = Split-Path -Parent $ManifestPath
    if ($Action -ceq 'Rollback') {
        $receiptPath = Join-Path $directory "$($plan.runId)-result.json"
        $receipt = (Read-StrictJsonSnapshot $receiptPath).Value
        if ($receipt.planSha256 -cne $ManifestHash -or $receipt.status -cne 'applied') { throw 'Rollback requires a completed, matching activation receipt.' }
        $current = Get-MyDeskSnapshot $receipt.apiArn $receipt.workerArn $plan.imageDigest $plan.appSha
        Assert-RuntimeTaskConfiguration $current.ApiTask.taskDefinition (ConvertTo-MyDeskRuntime $plan.config) 'api'
        $rollbackConfig = $plan.config | ConvertTo-Json | ConvertFrom-Json
        foreach ($name in @('mode', 'seatingMode', 'aiImportMode')) {
            if ($plan.priorModes.$name -ceq 'on' -and $rollbackConfig.$name -ceq 'off') { throw 'Rollback cannot activate a previously disabled feature; create a reviewed new plan.' }
            $rollbackConfig.$name = $plan.priorModes.$name
        }
        # Configuration-only rollback retains the current bucket/model/limits,
        # image, admission, IAM, and every unrelated field on the current pair.
        $created = New-MyDeskPlan $rollbackConfig $directory $receipt.apiArn $receipt.workerArn $plan.imageDigest $plan.appSha $AiReadinessPath
        $plan = $created.plan; $ManifestHash = $created.sha256
    }
    $result = Invoke-MyDeskApply $plan $ManifestHash $directory
    Write-Host "My Desk configuration status=$($result.status) API=$($result.apiArn) worker=$($result.workerArn)"
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-MyDeskMain }
