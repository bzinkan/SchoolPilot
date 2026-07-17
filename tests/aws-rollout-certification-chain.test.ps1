#requires -Version 7.0

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$supervisorPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\scripts\load\start-aws-rollout-supervisor.ps1"))
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($supervisorPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw "Unable to parse rollout supervisor." }
$functionNames = @(
    "Resolve-ExternalPath","Get-RequiredProperty","Get-AtomicJsonMutexName","Invoke-WithAtomicJsonMutex",
    "Write-AtomicJson","ConvertTo-CertificationComparableJson","Get-CertificationValue","Get-CertificationSha256",
    "Get-CertificationTextSha256","Assert-CertificationSha256","Assert-CertificationEvidenceReference",
    "Get-CertificationConfigHash","New-CertificationValidationReceipt","Use-CertificationValidationReceipt",
    "Assert-CertificationReceiptLifetime","Assert-CertificationTaskDefinitionAttestations","Assert-CertificationPreflightContract",
    "Assert-CertificationFixtureVerificationContract","Assert-CertificationFixtureAttestation",
    "Assert-CertificationConsumedReceiptAttestation","Assert-CertificationAttestedStageEvidence",
    "Assert-CertificationChainContinuity","Test-CertificationIntervalIncludesLocalTime",
    "Assert-CertificationFixtureVerificationTimestamp","Assert-CertificationProductionRollbackTaskIdentities",
    "Assert-CertificationFreshTimestamp",
    "Get-CertificationFixtureGenerationBinding","Assert-CertificationOperatorConfigUnchanged",
    "Copy-CertificationFileIfHashMatches"
)
foreach ($name in $functionNames) {
    $definition = $ast.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    if ($null -eq $definition) { throw "Missing supervisor function $name." }
    Invoke-Expression $definition.Extent.Text
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) "schoolpilot-cert-chain-$([Guid]::NewGuid().ToString('N'))"
[void][IO.Directory]::CreateDirectory($tempRoot)
$assertions = 0
try {
    $resolvedConfigPath = Join-Path $tempRoot "current-config.json"
    [IO.File]::WriteAllText($resolvedConfigPath, '{"schemaVersion":1}', [Text.UTF8Encoding]::new($false))
    $script:OperatorConfigSha256 = Get-CertificationSha256 $resolvedConfigPath
    [IO.File]::WriteAllText($resolvedConfigPath, '{"schemaVersion":2}', [Text.UTF8Encoding]::new($false))
    $operatorMutationRejected = $false
    try { Assert-CertificationOperatorConfigUnchanged }
    catch { $operatorMutationRejected = $_.Exception.Message -match "changed after certification validation" }
    Assert-Condition $operatorMutationRejected "A re-hashed operator config mutation must not cross the Validate-to-Run boundary."
    $assertions++
    [IO.File]::WriteAllText($resolvedConfigPath, '{"schemaVersion":1}', [Text.UTF8Encoding]::new($false))
    $appSha = "1" * 40;$rollbackApiSha="4"*40;$rollbackWorkerSha="5"*40
    $controllerSha = "2" * 40;$digest = "sha256:" + ("3" * 64)
    $rollbackApiDigest="sha256:"+("6"*64);$rollbackWorkerDigest="sha256:"+("7"*64)
    $controllerHashes = [ordered]@{supervisor="a"*64;monitor="b"*64;rollback="c"*64;harness="d"*64;preparer="e"*64;savedPlanValidator="f"*64}
    $chainId = "chain-one";$priorRunId="prior-waf-500"
    $activeApiArn="arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api:17"
    $activeWorkerArn="arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:37"
    $rollbackApiArn="arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:13"
    $rollbackWorkerArn="arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:35"

    $schemaPath=Join-Path $tempRoot "schema.json";[IO.File]::WriteAllText($schemaPath,'{"schemaVersion":1,"type":"rollback_schema_compatibility","compatible":true}',[Text.UTF8Encoding]::new($false))
    $schemaBinding=[ordered]@{path=$schemaPath;sha256=Get-CertificationSha256 $schemaPath}
    $artifactOne=Join-Path $tempRoot "primary-fixture.json";$artifactTwo=Join-Path $tempRoot "canary-fixture.json"
    [IO.File]::WriteAllText($artifactOne,'{"school":"primary"}',[Text.UTF8Encoding]::new($false));[IO.File]::WriteAllText($artifactTwo,'{"school":"canary"}',[Text.UTF8Encoding]::new($false))
    $fixtureId="fixture-chain";$fixtureNow=[DateTimeOffset]::UtcNow
    $statePath=Join-Path $tempRoot "fixture-state.json";Write-AtomicJson $statePath ([ordered]@{schemaVersion=1;fixtureId=$fixtureId;generatedAt=$fixtureNow.AddMinutes(-10).ToString("o");refreshedAt=$fixtureNow.AddMinutes(-5).ToString("o")})
    $verificationPath=Join-Path $tempRoot "fixture-verification.json";Write-AtomicJson $verificationPath ([ordered]@{
        schemaVersion=1;fixtureId=$fixtureId;verifiedAt=$fixtureNow.AddMinutes(-1).ToString("o");passed=$true
        counts=[ordered]@{schools=2;teachers=20;students=1010;classes=20;classRosterStudents=800;devices=1010;activeDeviceSessions=1010;activeSessions=20;commandBodies=20;liveAuth=@{commandAdministrators=1;teachers=20}}
        schoolTimezones=@{primary=@{schoolTimezone="America/New_York";schoolHoursTimezone="America/New_York"};canary=@{schoolTimezone="America/New_York";schoolHoursTimezone="America/New_York"}}
        gates=@{autoEnrollDisabled=$true;trackingDisabled=$true;schedulesDisabled=$true;exactSchoolTimezones=$true;classRostersExactAndDisjoint=$true;allDeviceTokensLive=$true;allStaffAuthArtifactsLive=$true}
    })
    $fixture=[ordered]@{
        state=@{path=$statePath;sha256=Get-CertificationSha256 $statePath};verification=@{path=$verificationPath;sha256=Get-CertificationSha256 $verificationPath}
        artifacts=@(@{path=$artifactOne;sha256=Get-CertificationSha256 $artifactOne},@{path=$artifactTwo;sha256=Get-CertificationSha256 $artifactTwo})
        fixtureId=$fixtureId;generatedAtUtc=$fixtureNow.AddMinutes(-10).ToString("o");refreshedAtUtc=$fixtureNow.AddMinutes(-5).ToString("o");verifiedAtUtc=$fixtureNow.AddMinutes(-1).ToString("o");timezone="America/New_York";plannedTrafficStartUtc=$fixtureNow.ToString("o")
    }
    function New-TaskAttestation($arn,$imageDigest,$gitSha,$container,$cpu,$memory){[ordered]@{taskDefinitionArn=$arn;taskDefinitionJsonSha256="8"*64;image="repo@$imageDigest";imageDigest=$imageDigest;imageManifestSha256="9"*64;gitSha=$gitSha;provenanceTag=$gitSha.Substring(0,12);cpu=$cpu;memory=$memory;containerName=$container}}
    $taskDefinitions=[ordered]@{
        activeApi=New-TaskAttestation $activeApiArn $digest $appSha "api" 512 2048
        activeWorker=New-TaskAttestation $activeWorkerArn $digest $appSha "scheduler-worker" 256 512
        rollbackApi=New-TaskAttestation $rollbackApiArn $rollbackApiDigest $rollbackApiSha "api" 512 2048
        rollbackWorker=New-TaskAttestation $rollbackWorkerArn $rollbackWorkerDigest $rollbackWorkerSha "scheduler-worker" 256 512
    }
    $services=@(
        [ordered]@{name="api";taskDefinitionArn=$activeApiArn;desired=6;running=6;pending=0;subnets=@("subnet-a1","subnet-a2");assignPublicIp="DISABLED"},
        [ordered]@{name="worker";taskDefinitionArn=$activeWorkerArn;desired=1;running=1;pending=0;subnets=@("subnet-a1","subnet-a2");assignPublicIp="DISABLED"}
    )
    $rds=[ordered]@{arn="arn:aws:rds:us-east-1:135775632425:db:schoolpilot-production-db";class="db.t4g.medium";exactPosture=@{engine="postgres";storageEncrypted=$true;publiclyAccessible=$false};expectedExactPosture=$null}
    $redis=[ordered]@{arn="arn:aws:elasticache:us-east-1:135775632425:replicationgroup:schoolpilot";nodeType="cache.t4g.small";status="available"}
    $alarms=@([ordered]@{name="api-alarm";state="OK";actionsEnabled=$true});$schedules=@([ordered]@{name="night";schedule="cron(0 1 * * ? *)";timezone="America/New_York";minCapacity=6;maxCapacity=8})
    $loadStability=[ordered]@{api=@{desired=6;running=6;pending=0;taskDefinitionArn=$activeApiArn};worker=@{desired=1;running=1;pending=0;taskDefinitionArn=$activeWorkerArn};healthyTargetCount=6;targetPort=443;apiTaskPrivateIpv4=@("10.0.0.1","10.0.0.2","10.0.0.3","10.0.0.4","10.0.0.5","10.0.0.6");tasks=@{api=@();worker=@()};scalableTarget=@{minCapacity=6;maxCapacity=8}}
    $preflight=[ordered]@{observedAtUtc=[DateTimeOffset]::UtcNow.AddSeconds(-1).ToString("o");taskDefinitions=$taskDefinitions;posture=[ordered]@{services=$services;rds=$rds;redis=$redis;alarms=$alarms;schedules=$schedules;loadStability=$loadStability}}
    $contract = [pscustomobject]@{
        ChainId=$chainId;CapacityTrack="baseline";ApplicationGitSha=$appSha;DeployedImageDigest=$digest;ControllerGitSha=$controllerSha;ControllerHashes=$controllerHashes
        ActiveApiArn=$activeApiArn;ActiveWorkerArn=$activeWorkerArn;RollbackApiArn=$rollbackApiArn;RollbackWorkerArn=$rollbackWorkerArn
        RollbackApiGitSha=$rollbackApiSha;RollbackWorkerGitSha=$rollbackWorkerSha;RollbackApiImageDigest=$rollbackApiDigest;RollbackWorkerImageDigest=$rollbackWorkerDigest;SchemaCompatibility=$schemaBinding
        Raw=[pscustomobject]@{alarmNames=@("api-alarm");scheduleNames=@("night")}
    }
    $rollbackPath = Join-Path $tempRoot "rollback.json";[IO.File]::WriteAllText($rollbackPath,'{"schemaVersion":1}',[Text.UTF8Encoding]::new($false))
    $rollbackBinding=[ordered]@{path=$rollbackPath;sha256=Get-CertificationSha256 $rollbackPath}
    $boundRollbackPath=Join-Path $tempRoot "bound-rollback.json";[IO.File]::Copy($rollbackPath,$boundRollbackPath)
    $boundRollback=[ordered]@{path=$boundRollbackPath;sha256=Get-CertificationSha256 $boundRollbackPath}
    $runId=$priorRunId;$receiptPath=Join-Path $tempRoot "prior-receipt.json";$sealPath=Join-Path $tempRoot "prior-receipt-seal.json";$consumedPath="$receiptPath.consumed"
    New-CertificationValidationReceipt -Contract $contract -Preflight $preflight -RollbackConfig $rollbackBinding -ReceiptPath $receiptPath -SealPath $sealPath
    $receiptBinding=Use-CertificationValidationReceipt -Contract $contract -ReceiptPath $receiptPath -SealPath $sealPath -ConsumedPath $consumedPath
    $operatorHash=Get-CertificationConfigHash;$runtimeHash="0"*64
    $datastore=[ordered]@{expectedRdsInstanceClass="db.t4g.medium";expectedRedisNodeType="cache.t4g.small";observedRds=$rds;observedRedis=$redis}
    $network=[ordered]@{expectedNatGatewayCount=2;expectedEcsAssignPublicIp=$false;ecsTaskSubnetIds=@("subnet-a1","subnet-a2");observedServices=$services}
    $rollbackIdentities=[ordered]@{api=$rollbackApiArn;worker=$rollbackWorkerArn;schemaCompatibility=$schemaBinding}

    $rootPath=Join-Path $tempRoot "root.json";Write-AtomicJson $rootPath ([ordered]@{schemaVersion=1;type="certification_chain_root";runId=$priorRunId;chainId=$chainId;phase="Waf";stage="500";supervisionKind="Load";createdAtUtc=[DateTimeOffset]::UtcNow.ToString("o");capacityTrack="baseline";applicationGitSha=$appSha;deployedImageDigest=$digest;controllerGitSha=$controllerSha;controllerHashes=$controllerHashes;operatorConfigSha256=$operatorHash;boundRuntimeConfigSha256=$runtimeHash;rollbackConfig=$boundRollback;validationReceipt=$receiptBinding;taskDefinitions=$taskDefinitions;fixture=$fixture;schemaCompatibility=$schemaBinding;budgetAcknowledgement=$null;generatorPublicIpv4="198.51.100.10";historicalEvidenceDiagnosticOnly=@();datastorePosture=$datastore;networkPosture=$network;alarms=$alarms;schedules=$schedules;rollbackIdentities=$rollbackIdentities})
    $rootRef=[pscustomobject]@{path=$rootPath;sha256=Get-CertificationSha256 $rootPath}
    $stagePath=Join-Path $tempRoot "prior-stage.json";Write-AtomicJson $stagePath ([ordered]@{schemaVersion=1;type="certification_stage_attestation";runId=$priorRunId;chainId=$chainId;phase="Waf";stage="500";supervisionKind="Load";attestedAtUtc=[DateTimeOffset]::UtcNow.ToString("o");chainRoot=$rootRef;validationReceipt=$receiptBinding;predecessor=$null;applicationGitSha=$appSha;deployedImageDigest=$digest;controllerGitSha=$controllerSha;controllerHashes=$controllerHashes;operatorConfigSha256=$operatorHash;boundRuntimeConfigSha256=$runtimeHash;rollbackConfig=$boundRollback;taskDefinitions=$taskDefinitions;fixture=$fixture;generatorPublicIpv4="198.51.100.10";datastorePosture=$datastore;networkPosture=$network;alarms=$alarms;schedules=$schedules;rollbackIdentities=$rollbackIdentities;budgetAcknowledgement=$null;historicalEvidence=@{diagnosticOnly=$true;artifacts=@()}})
    $stageRef=[ordered]@{path=$stagePath;sha256=Get-CertificationSha256 $stagePath}
    $monitorPath=Join-Path $tempRoot "prior-monitor.json";Write-AtomicJson $monitorPath ([ordered]@{runId=$priorRunId;phase="Waf";status="completed";postureAccepted=$true;workload=@{stage="500"};acceptance=@{passed=$true}})
    $monitorRef=[ordered]@{path=$monitorPath;sha256=Get-CertificationSha256 $monitorPath;runId=$priorRunId;phase="Waf"}
    $envelopePath=Join-Path $tempRoot "prior-supervisor.json";$linkInput=@($rootRef.sha256,("0"*64),$stageRef.sha256,$monitorRef.sha256)-join "`n"
    $envelope=[ordered]@{schemaVersion=2;type="certification_supervisor_terminal";supervisorSealed=$true;status="completed";runId=$priorRunId;phase="Waf";stage="500";chainId=$chainId;applicationGitSha=$appSha;deployedImageDigest=$digest;controllerGitSha=$controllerSha;controllerHashes=$controllerHashes;operatorConfigSha256=$operatorHash;boundRuntimeConfigSha256=$runtimeHash;rollbackConfig=$boundRollback;supervisionKind="Load";chainRoot=$rootRef;stageAttestation=$stageRef;terminalMonitorResult=$monitorRef;predecessorSupervisorResultSha256=$null;linkSha256=Get-CertificationTextSha256 $linkInput}
    Write-AtomicJson $envelopePath $envelope
    $contract.Raw|Add-Member -NotePropertyName chainRoot -NotePropertyValue $rootRef
    $config=[pscustomobject]@{phase="Waf";workload=[pscustomobject]@{stage="800"};predecessorResultPath=$envelopePath;predecessorResultSha256=Get-CertificationSha256 $envelopePath}
    Assert-CertificationChainContinuity -Config $config -Contract $contract;$assertions++

    $minimalStagePath=Join-Path $tempRoot "minimal-stage.json";Write-AtomicJson $minimalStagePath ([ordered]@{schemaVersion=1;type="certification_stage_attestation";runId=$priorRunId;chainId=$chainId;phase="Waf";stage="500";chainRoot=$rootRef;applicationGitSha=$appSha;deployedImageDigest=$digest;controllerGitSha=$controllerSha;controllerHashes=$controllerHashes})
    $minimalStageRef=[ordered]@{path=$minimalStagePath;sha256=Get-CertificationSha256 $minimalStagePath}
    $minimalEnvelope=$envelope|ConvertTo-Json -Depth 60|ConvertFrom-Json -Depth 60;$minimalEnvelope.stageAttestation=$minimalStageRef;$minimalEnvelope.linkSha256=Get-CertificationTextSha256 (@($rootRef.sha256,("0"*64),$minimalStageRef.sha256,$monitorRef.sha256)-join "`n")
    Write-AtomicJson $envelopePath $minimalEnvelope;$config.predecessorResultSha256=Get-CertificationSha256 $envelopePath
    $minimalRejected=$false;try{Assert-CertificationChainContinuity -Config $config -Contract $contract}catch{$minimalRejected=$true}
    Assert-Condition $minimalRejected "A re-hashed hand-authored minimal predecessor envelope must not bypass Validate-to-Run custody.";$assertions++
    Write-AtomicJson $envelopePath $envelope;$config.predecessorResultSha256=Get-CertificationSha256 $envelopePath

    $originalMonitor = Get-Content -LiteralPath $monitorPath -Raw
    $tamperedMonitor = $originalMonitor | ConvertFrom-Json
    $tamperedMonitor.status = "failed"
    Write-AtomicJson $monitorPath $tamperedMonitor
    $tamperRejected = $false
    try { Assert-CertificationChainContinuity -Config $config -Contract $contract }
    catch { $tamperRejected = $_.Exception.Message -match "changed after its hash" }
    Assert-Condition $tamperRejected "A changed terminal monitor result must invalidate its sealed predecessor."
    $assertions++
    [IO.File]::WriteAllText($monitorPath, $originalMonitor, [Text.UTF8Encoding]::new($false))

    $otherRootPath = Join-Path $tempRoot "other-root.json"
    $otherRoot=Get-Content -LiteralPath $rootPath -Raw|ConvertFrom-Json -Depth 60
    $otherRoot|Add-Member -NotePropertyName nonce -NotePropertyValue "different-root" -Force
    Write-AtomicJson $otherRootPath $otherRoot
    $otherRootRef = [pscustomobject]@{path=$otherRootPath;sha256=Get-CertificationSha256 $otherRootPath}
    $crossContract = $contract.PSObject.Copy()
    $crossContract.Raw = [pscustomobject]@{chainRoot=$otherRootRef}
    $crossRejected = $false
    try { Assert-CertificationChainContinuity -Config $config -Contract $crossContract }
    catch { $crossRejected = $true }
    Assert-Condition $crossRejected "A predecessor from another root must not cross-link into the current chain."
    $assertions++

    $badEnvelope = $envelope | ConvertTo-Json -Depth 30 | ConvertFrom-Json -Depth 30
    $badEnvelope.linkSha256 = "f" * 64
    Write-AtomicJson $envelopePath $badEnvelope
    $config.predecessorResultSha256 = Get-CertificationSha256 $envelopePath
    $linkRejected = $false
    try { Assert-CertificationChainContinuity -Config $config -Contract $contract }
    catch { $linkRejected = $_.Exception.Message -match "link seal is invalid" }
    Assert-Condition $linkRejected "A recomputed outer hash must not hide a broken SHA-256 chain link."
    $assertions++
    Write-AtomicJson $envelopePath $envelope
    $config.predecessorResultSha256 = Get-CertificationSha256 $envelopePath

    $runId = "receipt-once"
    $receiptContract = $contract
    $receiptPath = Join-Path $tempRoot "receipt.json"
    $sealPath = Join-Path $tempRoot "receipt-seal.json"
    $consumedPath = "$receiptPath.consumed"
    $rollbackPath = Join-Path $tempRoot "rollback.json"
    [IO.File]::WriteAllText($rollbackPath, '{"schemaVersion":1}', [Text.UTF8Encoding]::new($false))
    $rollbackBinding = [ordered]@{path=$rollbackPath;sha256=Get-CertificationSha256 $rollbackPath}
    $preflight.observedAtUtc=[DateTimeOffset]::UtcNow.AddSeconds(-1).ToString("o")
    New-CertificationValidationReceipt -Contract $receiptContract -Preflight $preflight -RollbackConfig $rollbackBinding -ReceiptPath $receiptPath -SealPath $sealPath
    $binding = Use-CertificationValidationReceipt -Contract $receiptContract -ReceiptPath $receiptPath -SealPath $sealPath -ConsumedPath $consumedPath
    Assert-Condition ((Test-Path $consumedPath) -and -not (Test-Path $receiptPath) -and -not (Test-Path $sealPath) -and
        $binding.sha256 -eq (Get-CertificationSha256 $consumedPath)) "A valid receipt must be atomically consumed exactly once."
    $assertions++
    $replayRejected = $false
    try { Use-CertificationValidationReceipt -Contract $receiptContract -ReceiptPath $receiptPath -SealPath $sealPath -ConsumedPath $consumedPath | Out-Null }
    catch { $replayRejected = $_.Exception.Message -match "replay is forbidden" }
    Assert-Condition $replayRejected "A consumed validation receipt must reject replay."
    $assertions++

    $runId="receipt-bad-lifetime";$lifetimeReceiptPath=Join-Path $tempRoot "lifetime-receipt.json";$lifetimeSealPath=Join-Path $tempRoot "lifetime-seal.json"
    $preflight.observedAtUtc=[DateTimeOffset]::UtcNow.AddSeconds(-1).ToString("o")
    New-CertificationValidationReceipt -Contract $receiptContract -Preflight $preflight -RollbackConfig $rollbackBinding -ReceiptPath $lifetimeReceiptPath -SealPath $lifetimeSealPath
    $lifetimeReceipt=Get-Content -LiteralPath $lifetimeReceiptPath -Raw|ConvertFrom-Json -Depth 60
    $lifetimeReceipt.expiresAtUtc=([DateTimeOffset]$lifetimeReceipt.issuedAtUtc).AddHours(12).ToString("o")
    Write-AtomicJson $lifetimeReceiptPath $lifetimeReceipt
    Write-AtomicJson $lifetimeSealPath ([ordered]@{schemaVersion=1;type="certification_validation_receipt_seal";runId=$runId;receiptSha256=Get-CertificationSha256 $lifetimeReceiptPath})
    $lifetimeRejected=$false;try{Use-CertificationValidationReceipt $receiptContract $lifetimeReceiptPath $lifetimeSealPath "$lifetimeReceiptPath.consumed"|Out-Null}catch{$lifetimeRejected=$_.Exception.Message -match "exactly 30 minutes"}
    Assert-Condition $lifetimeRejected "A far-future hand-authored receipt expiry must fail before one-use consumption.";$assertions++

    $runId="receipt-wrong-consumed-path";$pathReceipt=Join-Path $tempRoot "path-receipt.json";$pathSeal=Join-Path $tempRoot "path-seal.json"
    $preflight.observedAtUtc=[DateTimeOffset]::UtcNow.AddSeconds(-1).ToString("o")
    New-CertificationValidationReceipt -Contract $receiptContract -Preflight $preflight -RollbackConfig $rollbackBinding -ReceiptPath $pathReceipt -SealPath $pathSeal
    $pathRejected=$false;try{Use-CertificationValidationReceipt $receiptContract $pathReceipt $pathSeal (Join-Path $tempRoot "renamed-receipt.consumed")|Out-Null}catch{$pathRejected=$_.Exception.Message -match "exact receipt path"}
    Assert-Condition ($pathRejected -and (Test-Path -LiteralPath $pathReceipt)) "Receipt consumption must use only the exact receiptPath.consumed destination.";$assertions++

    $maliciousPriorReceipt=Get-Content -LiteralPath $receiptBinding.path -Raw|ConvertFrom-Json -Depth 60
    $maliciousPriorReceipt.expiresAtUtc=([DateTimeOffset]$maliciousPriorReceipt.issuedAtUtc).AddHours(12).ToString("o")
    $maliciousPriorPath=Join-Path $tempRoot "prior-receipt-malicious.json.consumed";Write-AtomicJson $maliciousPriorPath $maliciousPriorReceipt
    $maliciousPriorRef=$receiptBinding|ConvertTo-Json -Depth 20|ConvertFrom-Json -Depth 20;$maliciousPriorRef.path=$maliciousPriorPath;$maliciousPriorRef.sha256=Get-CertificationSha256 $maliciousPriorPath
    $maliciousAttestation=Get-Content -LiteralPath $stagePath -Raw|ConvertFrom-Json -Depth 60;$maliciousAttestation.validationReceipt=$maliciousPriorRef
    $priorLifetimeRejected=$false;try{Assert-CertificationConsumedReceiptAttestation $maliciousPriorRef $maliciousAttestation $contract ([DateTimeOffset]$maliciousAttestation.attestedAtUtc) "test.predecessor"|Out-Null}catch{$priorLifetimeRejected=$_.Exception.Message -match "exactly 30 minutes"}
    Assert-Condition $priorLifetimeRejected "Predecessor receipt verification must reject a re-hashed far-future receipt lifetime.";$assertions++

    $runId = "receipt-tamper"
    $tamperReceiptPath = Join-Path $tempRoot "tamper-receipt.json"
    $tamperSealPath = Join-Path $tempRoot "tamper-receipt-seal.json"
    $tamperConsumedPath = "$tamperReceiptPath.consumed"
    $preflight.observedAtUtc=[DateTimeOffset]::UtcNow.AddSeconds(-1).ToString("o")
    New-CertificationValidationReceipt -Contract $receiptContract -Preflight $preflight -RollbackConfig $rollbackBinding -ReceiptPath $tamperReceiptPath -SealPath $tamperSealPath
    $receiptJson = Get-Content -LiteralPath $tamperReceiptPath -Raw | ConvertFrom-Json -Depth 30
    $receiptJson.applicationGitSha = "9" * 40
    Write-AtomicJson $tamperReceiptPath $receiptJson
    Write-AtomicJson $tamperSealPath ([ordered]@{
        schemaVersion=1;type="certification_validation_receipt_seal";runId=$runId
        receiptSha256=Get-CertificationSha256 $tamperReceiptPath
    })
    $semanticTamperRejected = $false
    try { Use-CertificationValidationReceipt -Contract $receiptContract -ReceiptPath $tamperReceiptPath -SealPath $tamperSealPath -ConsumedPath $tamperConsumedPath | Out-Null }
    catch { $semanticTamperRejected = $_.Exception.Message -match "stale, tampered" }
    Assert-Condition ($semanticTamperRejected -and -not (Test-Path $tamperConsumedPath)) "A re-sealed receipt with a changed application identity must fail before consumption."
    $assertions++

    [IO.File]::WriteAllText($rollbackPath, '{"schemaVersion":2}', [Text.UTF8Encoding]::new($false))
    $rollbackMutationRejected = $false
    try { Copy-CertificationFileIfHashMatches $rollbackPath (Join-Path $tempRoot "mutated-bound-rollback.json") $rollbackBinding.sha256 | Out-Null }
    catch { $rollbackMutationRejected = $_.Exception.Message -match "changed after validation" }
    Assert-Condition $rollbackMutationRejected "Rollback config bytes must remain hash-bound while the immutable runtime copy is created."
    $assertions++

    $wafStart = [DateTimeOffset]::Parse("2026-07-18T04:44:00Z")
    Assert-Condition ((Test-CertificationIntervalIncludesLocalTime $wafStart 5400 "America/New_York" "01:30") -and
        (Test-CertificationIntervalIncludesLocalTime $wafStart 5400 "America/New_York" "02:00")) `
        "The intended Waf/800 interval must prove both purge and rollup local times."
    $assertions++
    Assert-Condition (-not (Test-CertificationIntervalIncludesLocalTime ([DateTimeOffset]::Parse("2026-07-18T07:00:00Z")) 5400 "America/New_York" "01:30")) `
        "An ineligible interval must fail the fixture-time proof."
    $assertions++

    $futureVerificationRejected = $false
    try { Assert-CertificationFixtureVerificationTimestamp ([DateTimeOffset]::UtcNow.AddSeconds(30).ToString("o")) 60 | Out-Null }
    catch { $futureVerificationRejected = $_.Exception.Message -match "in the future" }
    Assert-Condition $futureVerificationRejected "Fixture verification must reject any future verifiedAt timestamp."
    $assertions++

    $staleBudgetTimestampRejected=$false
    try{Assert-CertificationFreshTimestamp ([DateTimeOffset]::UtcNow.AddHours(-25).ToString("o")) "Budget acknowledgement acknowledgedAtUtc"|Out-Null}catch{$staleBudgetTimestampRejected=$_.Exception.Message -match "fresh within 24 hours"}
    Assert-Condition $staleBudgetTimestampRejected "Certification contract budget approval must reject an acknowledgement older than 24 hours.";$assertions++
    $futureBudgetTimestampRejected=$false
    try{Assert-CertificationFreshTimestamp ([DateTimeOffset]::UtcNow.AddMinutes(6).ToString("o")) "Budget acknowledgement acknowledgedAtUtc"|Out-Null}catch{$futureBudgetTimestampRejected=$_.Exception.Message -match "fresh within 24 hours"}
    Assert-Condition $futureBudgetTimestampRejected "Certification contract budget approval must reject an acknowledgement more than five minutes in the future.";$assertions++

    $fixtureMismatchRejected = $false
    $fixtureNow = [DateTimeOffset]::UtcNow
    try {
        Get-CertificationFixtureGenerationBinding `
            ([pscustomobject]@{schemaVersion=1;fixtureId="fixture-a";generatedAt=$fixtureNow.AddMinutes(-5).ToString("o");refreshedAt=$fixtureNow.AddMinutes(-2).ToString("o")}) `
            ([pscustomobject]@{schemaVersion=1;fixtureId="fixture-b";passed=$true}) `
            ([pscustomobject]@{expectedFixtureId="fixture-a"}) $fixtureNow 60 | Out-Null
    }
    catch { $fixtureMismatchRejected = $_.Exception.Message -match "exact expected fixture generation" }
    Assert-Condition $fixtureMismatchRejected "Fixture state and verification from different generation IDs must be rejected."
    $assertions++

    $rollbackIdentityRejected = $false
    try {
        Assert-CertificationProductionRollbackTaskIdentities `
            "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:14" `
            "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:35" $false
    }
    catch { $rollbackIdentityRejected = $_.Exception.Message -match "exact reviewed full us-east-1" }
    Assert-Condition $rollbackIdentityRejected "Production certification must reject any rollback task identity outside the reviewed :13/:35 ARNs."
    $assertions++

}
finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

"AWS rollout certification-chain tests: PASS ($assertions assertions)"
