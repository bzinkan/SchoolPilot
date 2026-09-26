#requires -Version 7.5
[CmdletBinding()]
param(
    [string]$WorkerArn,
    [string]$CandidateImageDigest,
    [string]$CandidateAppSha,
    [string]$OutDir,
    [switch]$Execute
)

. "$PSScriptRoot/deploy-classpilot-runtime-config.ps1"
$script:EvidenceRootMarkerName = '.schoolpilot-mydesk-readiness-evidence-v1'
$script:EvidenceRootMarkerBytes = [Text.Encoding]::UTF8.GetBytes("schoolpilot-mydesk-readiness-evidence-v1`n")
$script:MyDeskReadinessRepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function New-MyDeskReadinessTaskRequest {
    param($Response, [string]$Digest)
    $task = $Response.taskDefinition
    if ($task.networkMode -cne 'awsvpc' -or @($task.containerDefinitions).Count -ne 1 -or
        $task.containerDefinitions[0].name -cne 'scheduler-worker' -or
        @($task.requiresCompatibilities) -cnotcontains 'FARGATE') { throw 'Readiness requires the exact single-container Fargate worker posture.' }
    $container = $task.containerDefinitions[0]
    if ($null -ne $container.PSObject.Properties['entryPoint'] -and @($container.entryPoint).Count -gt 0) { throw 'An unexpected worker entrypoint could bypass the read-only command.' }
    if ($container.logConfiguration.logDriver -cne 'awslogs' -or
        $container.logConfiguration.options.'awslogs-region' -cne $script:Region -or
        $container.logConfiguration.options.'awslogs-group' -cnotmatch '^/ecs/schoolpilot-production-[a-z0-9-]+$' -or
        $container.logConfiguration.options.'awslogs-stream-prefix' -cnotmatch '^[a-zA-Z0-9_-]{1,64}$') { throw 'Readiness requires the known worker logging channel.' }
    if (@($container.secrets | Where-Object name -CEQ 'DATABASE_URL').Count -ne 1 -or
        @($container.environment | Where-Object name -CEQ 'DATABASE_URL').Count -gt 0) { throw 'Readiness requires the existing database secret reference.' }
    $allowed = @('family','taskRoleArn','executionRoleArn','networkMode','containerDefinitions','volumes','placementConstraints',
        'requiresCompatibilities','cpu','memory','runtimePlatform','ephemeralStorage','proxyConfiguration',
        'inferenceAccelerators','pidMode','ipcMode','enableFaultInjection')
    $metadata = @('taskDefinitionArn','revision','status','requiresAttributes','compatibilities','registeredAt','registeredBy','deregisteredAt','tags')
    $request = [ordered]@{}
    foreach ($property in $task.PSObject.Properties) {
        if ($property.Name -cin $allowed) { if ($null -ne $property.Value) { $request[$property.Name] = $property.Value } }
        elseif ($property.Name -cnotin $metadata) { throw 'Unreviewed task-definition field in the worker clone.' }
    }
    $request.tags = @($Response.tags)
    $clone = $request | ConvertTo-Json -Depth 50 | ConvertFrom-Json -Depth 50
    $clone.family = 'schoolpilot-production-mydesk-readiness'
    $clone.containerDefinitions[0].image = "135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api@$Digest"
    return $clone
}

function ConvertTo-SafeMyDeskReadinessReport {
    param([string]$Text)
    if ([Text.Encoding]::UTF8.GetByteCount($Text) -gt 1048576) { throw 'Readiness output exceeded its metadata bound.' }
    $report = ConvertFrom-StrictJsonText -Text $Text
    Assert-ExactProperties $report @('version','mode','requiresConstraintReview','role','ledger','tables','columns','constraints','indexes') 'readiness report'
    if ($report.version -ne 1 -or $report.mode -cne 'read_only_inventory' -or $report.requiresConstraintReview -ne $true) { throw 'Unexpected readiness report contract.' }
    Assert-ExactProperties $report.role @('name','superuser','bypassRls') 'readiness role'
    if ($report.role.name -cnotmatch '^[a-zA-Z0-9_-]{1,128}$' -or $report.role.superuser -isnot [bool] -or $report.role.bypassRls -isnot [bool]) { throw 'Unexpected database-role metadata.' }
    $expectedTables = @('mydesk_attachments','mydesk_notes','mydesk_seating_charts','mydesk_import_assets','mydesk_import_items','mydesk_imports')
    $expectedMigrations = @('mydesk-private-notebook-20260925','mydesk-private-seating-20260925','mydesk-ai-imports-20260925')
    if (@($report.tables).Count -ne 6 -or @($report.ledger).Count -ne 3 -or
        @($report.tables.name | Sort-Object -Unique).Count -ne 6 -or @($report.ledger.id | Sort-Object -Unique).Count -ne 3) { throw 'Incomplete readiness inventory.' }
    foreach ($row in @($report.ledger)) {
        Assert-ExactProperties $row @('id','expectedChecksum','checksumMatches','status') 'readiness ledger'
        if ($row.id -cnotin $expectedMigrations -or $row.expectedChecksum -cnotmatch '^[0-9a-f]{64}$' -or
            $row.checksumMatches -isnot [bool] -or $row.status -cnotin @('complete','running','failed','unknown','missing')) { throw 'Unexpected ledger metadata.' }
    }
    foreach ($row in @($report.tables)) {
        Assert-ExactProperties $row @('name','present','enabled','forced','canonicalPolicy','policyCount','counts') 'readiness table'
        if ($row.name -cnotin $expectedTables -or -not (Test-IsJsonInteger $row.policyCount) -or $row.policyCount -lt 0 -or $row.policyCount -gt 100) { throw 'Unexpected table metadata.' }
        foreach ($key in @('present','enabled','forced','canonicalPolicy')) { if ($row.$key -isnot [bool]) { throw 'Unexpected RLS metadata.' } }
        if ($null -ne $row.counts) {
            Assert-ExactProperties $row.counts @('total','byState') 'readiness counts'
            if ($row.counts.total -isnot [string] -or $row.counts.total -cnotmatch '^[0-9]{1,20}$') { throw 'Unexpected aggregate count.' }
            foreach ($state in $row.counts.byState.PSObject.Properties) {
                if ($state.Name -cnotin @('pending','active','deleted','uploading','ready','delete_pending','queued','processing','review','failed','completed','cancelled','expired','promoted') -or
                    $state.Value -isnot [string] -or $state.Value -cnotmatch '^[0-9]{1,20}$') { throw 'Unexpected aggregate state.' }
            }
        }
    }
    foreach ($kind in @('columns','constraints','indexes')) {
        if (@($report.$kind).Count -gt 2000) { throw 'Catalog inventory exceeded its bound.' }
        $fields = switch ($kind) {
            'columns' { @('tableName','name','type','nullable') }
            'constraints' { @('tableName','name','type','validated','deleteAction','deleteColumns','definitionSha256') }
            'indexes' { @('tableName','name','valid','ready','definitionSha256') }
        }
        foreach ($row in @($report.$kind)) {
            Assert-ExactProperties $row $fields 'readiness catalog entry'
            if ($row.tableName -cnotin $expectedTables -or $row.name -cnotmatch '^[a-zA-Z0-9_]{1,128}$') { throw 'Unexpected catalog identifier.' }
            foreach ($property in $row.PSObject.Properties) {
                switch ($property.Name) {
                    { $_ -cin @('nullable','validated','valid','ready') } { if ($property.Value -isnot [bool]) { throw 'Unexpected catalog Boolean.' } }
                    'definitionSha256' { if ($property.Value -cnotmatch '^[a-f0-9]{64}$') { throw 'Unexpected definition hash.' } }
                    { $_ -cin @('type','deleteAction') } { if ($property.Value -cnotmatch '^[a-zA-Z0-9_ ]{1,64}$') { throw 'Unexpected catalog type.' } }
                    'deleteColumns' { foreach ($column in @($property.Value)) { if ($column -cnotmatch '^[a-zA-Z0-9_]{1,128}$') { throw 'Unexpected delete-column identifier.' } } }
                }
            }
        }
    }
    return $report
}

function Invoke-MyDeskReadinessTask {
    param([string]$ExpectedWorkerArn, [string]$Digest, [string]$ReleaseSha, [string]$Directory)
    if ($ExpectedWorkerArn -cnotmatch '^arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:[1-9][0-9]*$' -or
        $Digest -cnotmatch '^sha256:[a-f0-9]{64}$' -or $ReleaseSha -cnotmatch '^[a-f0-9]{40}$') { throw 'Exact worker and candidate image identity are required.' }
    $repo = $script:MyDeskReadinessRepositoryRoot
    [void](Assert-RepositoryIdentity -RepositoryRoot $repo -ExpectedSha $ReleaseSha)
    $directory = Assert-PrivateExternalRoot -Root $Directory -RepositoryRoot $repo
    $identity = Invoke-AwsJson -Arguments @('sts','get-caller-identity','--output','json')
    if ($identity.Account -cne $script:AccountId) { throw 'Wrong AWS account.' }
    $services = Get-ServiceSnapshot
    Assert-StableService $services.Worker $ExpectedWorkerArn 1 1 'worker'
    $source = Get-TaskDefinitionResponse $ExpectedWorkerArn
    if ($source.taskDefinition.taskDefinitionArn -cne $ExpectedWorkerArn -or $source.taskDefinition.status -cne 'ACTIVE') { throw 'Source worker definition drifted.' }
    $image = Invoke-AwsJson -Arguments @('ecr','describe-images','--repository-name',$script:EcrRepository,'--image-ids',"imageTag=$($ReleaseSha.Substring(0,12))",'--region',$script:Region,'--output','json')
    if (@($image.imageDetails).Count -ne 1 -or $image.imageDetails[0].imageDigest -cne $Digest) { throw 'Candidate SHA tag does not resolve to the reviewed digest.' }
    $request = New-MyDeskReadinessTaskRequest $source $Digest
    $network = $services.Worker.networkConfiguration
    Assert-ExactProperties $network @('awsvpcConfiguration') 'worker network'
    Assert-ExactProperties $network.awsvpcConfiguration @('subnets','securityGroups','assignPublicIp') 'worker network'
    if (@($network.awsvpcConfiguration.subnets).Count -lt 1 -or @($network.awsvpcConfiguration.securityGroups).Count -lt 1 -or
        $network.awsvpcConfiguration.assignPublicIp -cnotin @('ENABLED','DISABLED')) { throw 'Incomplete worker network configuration.' }
    $runId = [Guid]::NewGuid().ToString('N')
    $receiptPath = Join-Path $directory "$runId-readiness.json"
    $receipt = [ordered]@{ version = 1; runId = $runId; status = 'preparing'; workerArn = $ExpectedWorkerArn; imageDigest = $Digest; appSha = $ReleaseSha; taskArn = $null; taskDefinitionArn = $null }
    Write-SanitizedJson $receiptPath $receipt
    $definitionArn = $null; $taskArn = $null; $stopped = $false
    try {
        $inputPath = Write-PrivateAwsJsonInput $request
        try {
            $registered = Invoke-AwsJson -Arguments @('ecs','register-task-definition','--cli-input-json',("file://" + $inputPath.Replace('\','/')),'--region',$script:Region,'--output','json')
        } finally { Remove-Item -LiteralPath $inputPath -Force -ErrorAction SilentlyContinue }
        $definitionArn = [string]$registered.taskDefinition.taskDefinitionArn
        if ($definitionArn -cnotmatch '^arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-mydesk-readiness:[1-9][0-9]*$') { throw 'Invalid readiness task definition.' }
        $verified = Get-TaskDefinitionResponse $definitionArn
        if ((Get-CanonicalJsonSha256 (New-MyDeskReadinessTaskRequest $verified $Digest)) -cne (Get-CanonicalJsonSha256 $request) -or
            $verified.taskDefinition.containerDefinitions[0].image -cne $request.containerDefinitions[0].image) { throw 'Registered readiness clone drifted.' }
        $receipt.taskDefinitionArn = $definitionArn; Write-SanitizedJson $receiptPath $receipt
        # RunTask reuses exact secret references/network settings; its fixed
        # command imports no application server, scheduler, provider or storage.
        $runRequest = [ordered]@{ cluster = $script:Cluster; taskDefinition = $definitionArn; count = 1; launchType = 'FARGATE';
            clientToken = $runId; startedBy = $runId; enableExecuteCommand = $false; networkConfiguration = $network;
            overrides = @{ containerOverrides = @(@{ name = 'scheduler-worker'; command = @('node','dist/cli/inspectMyDeskReadiness.js'); environment = @(
                @{ name = 'SCHEDULER_ENABLED'; value = 'false' }, @{ name = 'RUN_MIGRATIONS_ONLY'; value = 'false' },
                @{ name = 'RUN_MIGRATIONS_ON_STARTUP'; value = 'false' }, @{ name = 'MYDESK_MODE'; value = 'off' },
                @{ name = 'MYDESK_SEATING_MODE'; value = 'off' }, @{ name = 'MYDESK_AI_IMPORT_MODE'; value = 'off' }
            ) }) } }
        $inputPath = Write-PrivateAwsJsonInput $runRequest
        try {
            $arguments = @('ecs','run-task','--cli-input-json',("file://" + $inputPath.Replace('\','/')),'--region',$script:Region,'--output','json')
            try { $started = Invoke-AwsJson -Arguments $arguments }
            catch { $started = Invoke-AwsJson -Arguments $arguments } # exact idempotent request after a lost response
        } finally { Remove-Item -LiteralPath $inputPath -Force -ErrorAction SilentlyContinue }
        if (@($started.failures).Count -gt 0 -or @($started.tasks).Count -ne 1) { throw 'Readiness task did not start exactly once.' }
        $taskArn = [string]$started.tasks[0].taskArn
        if ($taskArn -cnotmatch '^arn:aws:ecs:us-east-1:135775632425:task/schoolpilot-production-cluster/[a-f0-9]{32}$') { throw 'Unexpected readiness task identity.' }
        $receipt.taskArn = $taskArn; $receipt.status = 'running'; Write-SanitizedJson $receiptPath $receipt
        $deadline = [DateTimeOffset]::UtcNow.AddMinutes(4)
        do {
            $observed = Invoke-AwsJson -Arguments @('ecs','describe-tasks','--cluster',$script:Cluster,'--tasks',$taskArn,'--region',$script:Region,'--output','json')
            if (@($observed.failures).Count -eq 0 -and @($observed.tasks).Count -eq 1) {
                $task = $observed.tasks[0]
                if ($task.taskArn -cne $taskArn -or $task.taskDefinitionArn -cne $definitionArn -or $task.startedBy -cne $runId) { throw 'Readiness task identity drifted.' }
                if ($task.lastStatus -ceq 'STOPPED') { $stopped = $true; break }
            }
            Start-Sleep -Seconds 3
        } while ([DateTimeOffset]::UtcNow -lt $deadline)
        if (-not $stopped -or @($task.containers).Count -ne 1 -or $task.containers[0].name -cne 'scheduler-worker' -or
            $null -eq $task.containers[0].PSObject.Properties['exitCode'] -or $task.containers[0].exitCode -ne 0) { throw 'Read-only inventory did not exit successfully within its deadline.' }
        $logging = $request.containerDefinitions[0].logConfiguration.options
        $stream = $logging.'awslogs-stream-prefix' + '/scheduler-worker/' + $taskArn.Split('/')[-1]
        $report = $null
        for ($attempt = 0; $attempt -lt 10; $attempt++) {
            $logs = Invoke-AwsJson -Arguments @('logs','get-log-events','--log-group-name',$logging.'awslogs-group','--log-stream-name',$stream,
                '--start-from-head','--limit','100','--region',$script:Region,'--output','json')
            if (@($logs.events).Count -gt 0) {
                # The container logger may split one long JSON line into
                # several events. Reassemble in stream order; strict parsing
                # still rejects extra output and never persists raw messages.
                try {
                    $report = ConvertTo-SafeMyDeskReadinessReport ((@($logs.events | ForEach-Object { [string]$_.message })) -join '')
                    break
                } catch {
                    if ($attempt -eq 9) { throw 'Inventory output did not match the metadata-only contract.' }
                }
            }
            Start-Sleep -Seconds 3
        }
        if ($null -eq $report) { throw 'Sanitized inventory output was not available.' }
        $receipt.status = 'inventoried'; $receipt.observedAt = [DateTimeOffset]::UtcNow.ToString('o'); $receipt.report = $report
        Write-SanitizedJson $receiptPath $receipt
        return [pscustomobject]@{ path = $receiptPath; sha256 = Get-FileSha256 $receiptPath; runId = $runId }
    } catch {
        $receipt.status = 'failed'; Write-SanitizedJson $receiptPath $receipt
        throw "My Desk read-only preflight failed. Inspect the private receipt for run $runId; no serving service was updated."
    } finally {
        if ($taskArn -and -not $stopped) {
            try { [void](Invoke-AwsJson -Arguments @('ecs','stop-task','--cluster',$script:Cluster,'--task',$taskArn,'--reason','My Desk read-only inventory deadline','--region',$script:Region,'--output','json')) } catch { }
        }
        if ($definitionArn) {
            try { [void](Invoke-AwsJson -Arguments @('ecs','deregister-task-definition','--task-definition',$definitionArn,'--region',$script:Region,'--output','json')) } catch { }
        }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    if (-not $Execute -or -not $OutDir) { throw 'Use -Execute -WorkerArn <exact serving ARN> -CandidateImageDigest <digest> -CandidateAppSha <SHA> -OutDir <private external directory>. This starts one read-only task and never updates services.' }
    $result = Invoke-MyDeskReadinessTask $WorkerArn $CandidateImageDigest $CandidateAppSha $OutDir
    Write-Host "My Desk read-only inventory: $($result.path) sha256=$($result.sha256)"
}
