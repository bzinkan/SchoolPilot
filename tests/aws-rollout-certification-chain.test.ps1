#requires -Version 7.0

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$script:RequiredWorkloadSchemaVersion = "classpilot-tile-batch-v1"
$script:RequiredWorkloadEndpointShapeSha256 = "8e9f1942e4b3a27de7dd0571a9f60ffeb276c089e4baae96a885dba69e3233b2"
$script:RequiredPollAccountingVersion = "staggered-deadline-v1"

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$supervisorPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\scripts\load\start-aws-rollout-supervisor.ps1"))
$monitorPathUnderTest = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\scripts\load\aws-rollout-monitor.ps1"))
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
    "Assert-CertificationFixtureVerificationContract","Get-CertificationHarnessArtifactBindings","Assert-CertificationHarnessArtifactContract",
    "Assert-CertificationHarnessArtifactEnvironment","Assert-CertificationFixtureAttestation",
    "Assert-CertificationConsumedReceiptAttestation","Assert-CertificationAttestedStageEvidence",
    "Test-CertificationTerminalTileBatchContract",
    "Assert-CertificationChainContinuity","Test-CertificationIntervalIncludesLocalTime",
    "ConvertTo-CertificationUtcTimestamp",
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
$monitorTokens = $null
$monitorParseErrors = $null
$monitorAst = [Management.Automation.Language.Parser]::ParseFile($monitorPathUnderTest, [ref]$monitorTokens, [ref]$monitorParseErrors)
if ($monitorParseErrors.Count -gt 0) { throw "Unable to parse rollout monitor." }
foreach ($name in @("Get-OptionalValue","Get-ValidatedLoadSummaryTiming")) {
    $definition = $monitorAst.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    if ($null -eq $definition) { throw "Missing monitor function $name." }
    Invoke-Expression $definition.Extent.Text
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) "schoolpilot-cert-chain-$([Guid]::NewGuid().ToString('N'))"
[void][IO.Directory]::CreateDirectory($tempRoot)
$assertions = 0
try {
    $summaryFinalAt = [DateTimeOffset]::UtcNow
    $script:TrafficStartedAtUtc = $summaryFinalAt.AddSeconds(-1800)
    $summaryConfig = [pscustomobject]@{
        TestMode=$false
        RunId="summary-contract";Workload=[pscustomobject]@{
            Stage="500";Devices=510;CanaryDevices=10;ScreenshotBytes=40960;DurationSeconds=1800
            WorkloadSchemaVersion=$script:RequiredWorkloadSchemaVersion
            EndpointShapeSha256=$script:RequiredWorkloadEndpointShapeSha256
        }
    }
    $summaryProgress = [pscustomobject]@{
        event=[pscustomobject]@{event="final";timestamp=$summaryFinalAt.ToString("o")}
        summary=[pscustomobject]@{
            runId="summary-contract";stage="500";devices=510;declaredSecondSchoolCanaryDevices=10
            workloadSchemaVersion=$script:RequiredWorkloadSchemaVersion
            workloadEndpointShapeSha256=$script:RequiredWorkloadEndpointShapeSha256
            screenshotFixture=[pscustomobject]@{decodedBytes=40960}
            run=[pscustomobject]@{
                durationClock="monotonic-hrtime-v1";runtimeTargetTrafficSeconds=1800
                plannedTrafficMilliseconds=1800000;actualTrafficMilliseconds=1800000
                plannedTrafficSeconds=1800;actualTrafficSeconds=1800;completedConfiguredDuration=$true
                shutdownReason="duration"
            }
            screenshotRetrieval=[pscustomobject]@{attempts=500;successes=500}
            tileBatch=[pscustomobject]@{configured=$true;pollAccountingVersion=$script:RequiredPollAccountingVersion;teacherCohorts=20;studentsPerCohort=25;teacherTileAssignments=500;requestsPerCohortPerPoll=2;logicalOperationsPerPoll=1000;historyRequests=20;screenshotRequests=20;historyRequestsByCohort=@(1)*20;screenshotRequestsByCohort=@(1)*20;completeRoundsPerCohort=1;maximumRoundsPerCohort=1;partialFinalRoundCohorts=0;historyLogicalOperations=500;screenshotLogicalOperations=500;networkRequests=40;logicalOperations=1000}
        }
    }
    $validatedSummary = Get-ValidatedLoadSummaryTiming $summaryConfig $summaryProgress
    Assert-Condition ($null -ne $validatedSummary -and $validatedSummary.TileBatch.teacherCohorts -eq 20 -and $validatedSummary.TileBatch.screenshotLogicalOperations -eq 500) `
        "The monitor must accept and expose exact Waf/500 tile-batch logical evidence."
    $assertions++
    $summaryProgress.summary.tileBatch.historyLogicalOperations = 499
    Assert-Condition ($null -eq (Get-ValidatedLoadSummaryTiming $summaryConfig $summaryProgress)) `
        "The monitor must reject inconsistent per-tile logical accounting."
    $assertions++
    $summaryProgress.summary.tileBatch.historyLogicalOperations = 500
    $summaryProgress.summary.workloadSchemaVersion = "legacy-per-device-v1"
    Assert-Condition ($null -eq (Get-ValidatedLoadSummaryTiming $summaryConfig $summaryProgress)) `
        "The monitor must reject a load summary that is not bound to the reviewed tile-batch schema."
    $assertions++
    $summaryProgress.summary.workloadSchemaVersion = $script:RequiredWorkloadSchemaVersion

    $partialCounts = @(1..20 | ForEach-Object { if ($_ -le 10) { 59 } else { 58 } })
    $summaryProgress.summary.tileBatch.historyRequestsByCohort = $partialCounts
    $summaryProgress.summary.tileBatch.screenshotRequestsByCohort = @($partialCounts)
    $summaryProgress.summary.tileBatch.completeRoundsPerCohort = 58
    $summaryProgress.summary.tileBatch.maximumRoundsPerCohort = 59
    $summaryProgress.summary.tileBatch.partialFinalRoundCohorts = 10
    $summaryProgress.summary.tileBatch.historyRequests = 1170
    $summaryProgress.summary.tileBatch.screenshotRequests = 1170
    $summaryProgress.summary.tileBatch.historyLogicalOperations = 29250
    $summaryProgress.summary.tileBatch.screenshotLogicalOperations = 29250
    $summaryProgress.summary.tileBatch.networkRequests = 2340
    $summaryProgress.summary.tileBatch.logicalOperations = 58500
    $summaryProgress.summary.screenshotRetrieval.attempts = 29250
    $summaryProgress.summary.screenshotRetrieval.successes = 29250
    $partialSummary = Get-ValidatedLoadSummaryTiming $summaryConfig $summaryProgress
    Assert-Condition ($null -ne $partialSummary -and $partialSummary.TileBatch.partialFinalRoundCohorts -eq 10 -and $partialSummary.TileBatch.historyRequests -eq 1170) `
        "The monitor must accept the deadline-truncated leading cohort prefix without changing traffic shape."
    $assertions++
    $summaryProgress.summary.tileBatch.historyRequestsByCohort = @($partialCounts[0..8] + 58 + 59 + $partialCounts[11..19])
    $summaryProgress.summary.tileBatch.screenshotRequestsByCohort = @($summaryProgress.summary.tileBatch.historyRequestsByCohort)
    Assert-Condition ($null -eq (Get-ValidatedLoadSummaryTiming $summaryConfig $summaryProgress)) `
        "The monitor must reject an extra poll outside the leading stagger prefix."
    $assertions++
    $summaryProgress.summary.tileBatch.historyRequestsByCohort = $partialCounts
    $summaryProgress.summary.tileBatch.screenshotRequestsByCohort = @($partialCounts)
    $summaryProgress.summary.tileBatch.pollAccountingVersion = "legacy-aggregate-v1"
    Assert-Condition ($null -eq (Get-ValidatedLoadSummaryTiming $summaryConfig $summaryProgress)) `
        "The monitor must reject historical tile evidence without the staggered deadline accounting version."
    $assertions++
    $summaryProgress.summary.tileBatch.pollAccountingVersion = $script:RequiredPollAccountingVersion
    $summaryProgress.summary.tileBatch.historyRequestsByCohort = @($partialCounts[0..18])
    Assert-Condition ($null -eq (Get-ValidatedLoadSummaryTiming $summaryConfig $summaryProgress)) `
        "The monitor must reject malformed cohort array lengths."
    $assertions++
    $summaryProgress.summary.tileBatch.historyRequestsByCohort = @($partialCounts)
    $negativeCounts = @($partialCounts); $negativeCounts[19] = -1
    $summaryProgress.summary.tileBatch.historyRequestsByCohort = $negativeCounts
    $summaryProgress.summary.tileBatch.screenshotRequestsByCohort = @($negativeCounts)
    Assert-Condition ($null -eq (Get-ValidatedLoadSummaryTiming $summaryConfig $summaryProgress)) `
        "The monitor must reject negative cohort counters."
    $assertions++
    $skewedCounts = @($partialCounts); $skewedCounts[19] = 57
    $summaryProgress.summary.tileBatch.historyRequestsByCohort = $skewedCounts
    $summaryProgress.summary.tileBatch.screenshotRequestsByCohort = @($skewedCounts)
    Assert-Condition ($null -eq (Get-ValidatedLoadSummaryTiming $summaryConfig $summaryProgress)) `
        "The monitor must reject cohort poll skew above one."
    $assertions++
    $summaryProgress.summary.tileBatch.historyRequestsByCohort = @($partialCounts)
    $summaryProgress.summary.tileBatch.screenshotRequestsByCohort = @($partialCounts)
    $summaryProgress.summary.tileBatch.partialFinalRoundCohorts = 9
    Assert-Condition ($null -eq (Get-ValidatedLoadSummaryTiming $summaryConfig $summaryProgress)) `
        "The monitor must recompute and reject mismatched derived poll fields."
    $assertions++
    $summaryProgress.summary.tileBatch.partialFinalRoundCohorts = 10
    $summaryProgress.summary.tileBatch.historyRequests = 1169
    Assert-Condition ($null -eq (Get-ValidatedLoadSummaryTiming $summaryConfig $summaryProgress)) `
        "The monitor must reject aggregate request counters that disagree with cohort evidence."
    $assertions++
    $summaryProgress.summary.tileBatch.historyRequests = 1170
    $summaryProgress.summary.tileBatch.screenshotRequestsByCohort = @($partialCounts); $summaryProgress.summary.tileBatch.screenshotRequestsByCohort[19] = 57
    Assert-Condition ($null -eq (Get-ValidatedLoadSummaryTiming $summaryConfig $summaryProgress)) `
        "The monitor must reject unpaired screenshot and history cohort counters."
    $assertions++
    $summaryProgress.summary.tileBatch.screenshotRequestsByCohort = @($partialCounts)
    $summaryProgress.summary.workloadEndpointShapeSha256 = "0" * 64
    Assert-Condition ($null -eq (Get-ValidatedLoadSummaryTiming $summaryConfig $summaryProgress)) `
        "The monitor must reject a mismatched tile endpoint shape."
    $assertions++
    $summaryProgress.summary.workloadEndpointShapeSha256 = $script:RequiredWorkloadEndpointShapeSha256

    $orderedDictionary = [ordered]@{sha256="a"*64}
    Assert-Condition ((Get-CertificationValue $orderedDictionary "sha256" ("0"*64)) -eq ("a"*64)) `
        "Certification lookup must read OrderedDictionary keys."
    $assertions++

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
    $controllerHashes = [ordered]@{
        supervisor="a"*64;monitor="b"*64;rollback="c"*64;harness="d"*64
        monotonicDeadline="e"*64;tilePollAccounting="9"*64;preparer="f"*64;savedPlanValidator="0"*64
    }
    $chainId = "chain-one";$priorRunId="prior-waf-500"
    $activeApiArn="arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api:17"
    $activeWorkerArn="arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:37"
    $rollbackApiArn="arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:13"
    $rollbackWorkerArn="arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:35"

    $schemaPath=Join-Path $tempRoot "schema.json";[IO.File]::WriteAllText($schemaPath,'{"schemaVersion":1,"type":"rollback_schema_compatibility","compatible":true}',[Text.UTF8Encoding]::new($false))
    $schemaBinding=[ordered]@{path=$schemaPath;sha256=Get-CertificationSha256 $schemaPath}
    $artifactOne=Join-Path $tempRoot "load-devices.private.json";$artifactTwo=Join-Path $tempRoot "load-auth.private.json";$artifactThree=Join-Path $tempRoot "load-command-bodies.private.json"
    $primarySchoolId="school-primary";$canarySchoolId="school-canary"
    $deviceArtifact=@(1..10|ForEach-Object{[ordered]@{deviceId="canary-device-$_";studentId="canary-student-$_";studentToken="canary-token-$_";schoolId=$canarySchoolId}})
    $deviceArtifact+=@(1..1000|ForEach-Object{
        $primaryIndex=$_
        $studentId=if($primaryIndex -le 500){
            $teacher=[Math]::Floor(($primaryIndex-1)/25)+1;$student=(($primaryIndex-1)%25)+1;"student-$teacher-$student"
        }elseif($primaryIndex -le 800){
            $teacher=[Math]::Floor(($primaryIndex-501)/15)+1;$student=(($primaryIndex-501)%15)+26;"student-$teacher-$student"
        }else{"extra-student-$primaryIndex"}
        [ordered]@{deviceId="primary-device-$primaryIndex";studentId=$studentId;studentToken="primary-token-$primaryIndex";schoolId=$primarySchoolId}
    })
    $teacherArtifact=@(1..20|ForEach-Object{$teacher=$_;[ordered]@{teacherId="teacher-$teacher";schoolId=$primarySchoolId;role="teacher";teachingSessionId="session-$teacher";teacherCookie="cookie-$teacher";csrfToken="csrf-$teacher";teacherToken="token-$teacher";studentIds=@(1..40|ForEach-Object{"student-$teacher-$_"})}})
    $commandArtifact=@(1..20|ForEach-Object{[ordered]@{teachingSessionId="session-$_";targetScope="class";commandType="open-tab";commandPayload=@{url="https://example.edu/$_"}}})
    Write-AtomicJson $artifactOne $deviceArtifact;Write-AtomicJson $artifactTwo ([ordered]@{schemaVersion=2;schoolId=$primarySchoolId;teacherAuth=$teacherArtifact});Write-AtomicJson $artifactThree $commandArtifact
    $fixtureId="fixture-chain";$fixtureNow=[DateTimeOffset]::UtcNow
    $statePath=Join-Path $tempRoot "fixture-state.json";Write-AtomicJson $statePath ([ordered]@{schemaVersion=1;fixtureId=$fixtureId;generatedAt=$fixtureNow.AddMinutes(-10).ToString("o");refreshedAt=$fixtureNow.AddMinutes(-5).ToString("o")})
    $verificationPath=Join-Path $tempRoot "fixture-verification.json";Write-AtomicJson $verificationPath ([ordered]@{
        schemaVersion=1;fixtureId=$fixtureId;verifiedAt=$fixtureNow.AddMinutes(-1).ToString("o");passed=$true
        counts=[ordered]@{schools=2;teachers=20;officeStaff=1;students=1010;classes=20;classRosterStudents=800;devices=1010;activeDeviceSessions=1010;activeSessions=20;commandBodies=20;authorizationPlanCohorts=@{coTeacherStudents=40;officeSupervisionStudents=40};liveAuth=@{commandAdministrators=1;teachers=20}}
        schoolTimezones=@{primary=@{schoolTimezone="America/New_York";schoolHoursTimezone="America/New_York"};canary=@{schoolTimezone="America/New_York";schoolHoursTimezone="America/New_York"}}
        gates=@{autoEnrollDisabled=$true;trackingDisabled=$true;schedulesDisabled=$true;exactSchoolTimezones=$true;classRostersExactAndDisjoint=$true;authorizationPlanCohortsExact=$true;authorizationPlanOfficeStudentsOutsideTeacherRosters=$true;allDeviceTokensLive=$true;allStaffAuthArtifactsLive=$true}
    })
    $fixture=[ordered]@{
        state=@{path=$statePath;sha256=Get-CertificationSha256 $statePath};verification=@{path=$verificationPath;sha256=Get-CertificationSha256 $verificationPath}
        artifacts=@(
            [pscustomobject]@{kind="device-manifest";path=$artifactOne;sha256=Get-CertificationSha256 $artifactOne},
            [pscustomobject]@{kind="teacher-auth";path=$artifactTwo;sha256=Get-CertificationSha256 $artifactTwo},
            [pscustomobject]@{kind="command-bodies";path=$artifactThree;sha256=Get-CertificationSha256 $artifactThree}
        )
        fixtureId=$fixtureId;generatedAtUtc=$fixtureNow.AddMinutes(-10).ToString("o");refreshedAtUtc=$fixtureNow.AddMinutes(-5).ToString("o");verifiedAtUtc=$fixtureNow.AddMinutes(-1).ToString("o");timezone="America/New_York";plannedTrafficStartUtc=$fixtureNow.ToString("o")
    }
    $validFixtureVerification=Get-Content -LiteralPath $verificationPath -Raw|ConvertFrom-Json -Depth 20
    Assert-CertificationFixtureVerificationContract $validFixtureVerification
    $assertions++

    $missingPlanCohorts=$validFixtureVerification|ConvertTo-Json -Depth 20|ConvertFrom-Json -Depth 20
    $missingPlanCohorts.counts.PSObject.Properties.Remove("authorizationPlanCohorts")
    $missingPlanCohortsRejected=$false
    try{Assert-CertificationFixtureVerificationContract $missingPlanCohorts}catch{$missingPlanCohortsRejected=$_.Exception.Message -match "authorizationPlanCohorts"}
    Assert-Condition $missingPlanCohortsRejected "Certification preflight must reject fixture evidence missing the authorization-plan cohorts."
    $assertions++

    $mismatchedPlanCohorts=$validFixtureVerification|ConvertTo-Json -Depth 20|ConvertFrom-Json -Depth 20
    $mismatchedPlanCohorts.counts.authorizationPlanCohorts.officeSupervisionStudents=39
    $mismatchedPlanCohortsRejected=$false
    try{Assert-CertificationFixtureVerificationContract $mismatchedPlanCohorts}catch{$mismatchedPlanCohortsRejected=$_.Exception.Message -match "authorization-plan cohort"}
    Assert-Condition $mismatchedPlanCohortsRejected "Certification preflight must reject a non-deterministic office-supervision plan cohort."
    $assertions++

    $missingOfficeStaff=$validFixtureVerification|ConvertTo-Json -Depth 20|ConvertFrom-Json -Depth 20
    $missingOfficeStaff.counts.PSObject.Properties.Remove("officeStaff")
    $missingOfficeStaffRejected=$false
    try{Assert-CertificationFixtureVerificationContract $missingOfficeStaff}catch{$missingOfficeStaffRejected=$true}
    Assert-Condition $missingOfficeStaffRejected "Certification preflight must reject fixture evidence missing the office-staff count."
    $assertions++

    $disabledPlanGate=$validFixtureVerification|ConvertTo-Json -Depth 20|ConvertFrom-Json -Depth 20
    $disabledPlanGate.gates.authorizationPlanOfficeStudentsOutsideTeacherRosters=$false
    $disabledPlanGateRejected=$false
    try{Assert-CertificationFixtureVerificationContract $disabledPlanGate}catch{$disabledPlanGateRejected=$_.Exception.Message -match "authorizationPlanOfficeStudentsOutsideTeacherRosters"}
    Assert-Condition $disabledPlanGateRejected "Certification preflight must reject office-supervision students that were not proven outside teacher rosters."
    $assertions++

    $artifactBindings=@(Get-CertificationHarnessArtifactBindings $fixture.artifacts "fixture.artifacts")
    Assert-Condition ($artifactBindings.Count -eq 3 -and
        (@($artifactBindings | ForEach-Object { [string]$_.kind } | Sort-Object) -join ",") -eq "command-bodies,device-manifest,teacher-auth") `
        "Fixture custody must bind the three role-tagged harness inputs exactly once."
    $assertions++
    Assert-CertificationHarnessArtifactContract $artifactBindings "fixture.artifacts"
    $assertions++

    $missingStudentDevices=@(Get-Content -LiteralPath $artifactOne -Raw|ConvertFrom-Json -Depth 20)
    $missingStudentDevices[10].PSObject.Properties.Remove("studentId")
    Write-AtomicJson $artifactOne $missingStudentDevices
    $missingStudentBindings=@(Get-CertificationHarnessArtifactBindings @(
        [pscustomobject]@{kind="device-manifest";path=$artifactOne;sha256=Get-CertificationSha256 $artifactOne},
        $fixture.artifacts[1],$fixture.artifacts[2]
    ) "fixture.artifacts")
    $missingStudentRejected=$false
    try{Assert-CertificationHarnessArtifactContract $missingStudentBindings "fixture.artifacts"}catch{$missingStudentRejected=$true}
    Assert-Condition $missingStudentRejected "Every selected device must bind a nonblank student ID."
    $assertions++
    Write-AtomicJson $artifactOne $deviceArtifact

    $mismatchedStudentDevices=@(Get-Content -LiteralPath $artifactOne -Raw|ConvertFrom-Json -Depth 20)
    $mismatchedStudentDevices[10].studentId="unrelated-student"
    Write-AtomicJson $artifactOne $mismatchedStudentDevices
    $mismatchedStudentBindings=@(Get-CertificationHarnessArtifactBindings @(
        [pscustomobject]@{kind="device-manifest";path=$artifactOne;sha256=Get-CertificationSha256 $artifactOne},
        $fixture.artifacts[1],$fixture.artifacts[2]
    ) "fixture.artifacts")
    $mismatchedStudentRejected=$false
    try{Assert-CertificationHarnessArtifactContract $mismatchedStudentBindings "fixture.artifacts"}catch{$mismatchedStudentRejected=$_.Exception.Message -match "selected Waf/800 primary devices"}
    Assert-Condition $mismatchedStudentRejected "The first 800 primary devices must be the 800 disjoint teacher-roster students."
    $assertions++
    Write-AtomicJson $artifactOne $deviceArtifact

    $skewedWaf500Devices=@(Get-Content -LiteralPath $artifactOne -Raw|ConvertFrom-Json -Depth 20)
    $firstTeacherStudent=$skewedWaf500Devices[10].studentId
    $skewedWaf500Devices[10].studentId=$skewedWaf500Devices[525].studentId
    $skewedWaf500Devices[525].studentId=$firstTeacherStudent
    Write-AtomicJson $artifactOne $skewedWaf500Devices
    $skewedWaf500Bindings=@(Get-CertificationHarnessArtifactBindings @(
        [pscustomobject]@{kind="device-manifest";path=$artifactOne;sha256=Get-CertificationSha256 $artifactOne},
        $fixture.artifacts[1],$fixture.artifacts[2]
    ) "fixture.artifacts")
    $skewedWaf500Rejected=$false
    try{Assert-CertificationHarnessArtifactContract $skewedWaf500Bindings "fixture.artifacts"}catch{$skewedWaf500Rejected=$_.Exception.Message -match "25 roster students per class"}
    Assert-Condition $skewedWaf500Rejected "Waf/500 must select exactly 25 students from every teacher roster."
    $assertions++
    Write-AtomicJson $artifactOne $deviceArtifact

    $artifactEnvironment=[ordered]@{LOAD_DEVICE_MANIFEST=$artifactOne;LOAD_TEACHER_AUTH_FILE=$artifactTwo;LOAD_COMMAND_BODIES_FILE=$artifactThree}
    $previousArtifactEnvironment=@{}
    foreach($entry in $artifactEnvironment.GetEnumerator()){
        $previousArtifactEnvironment[$entry.Key]=[Environment]::GetEnvironmentVariable($entry.Key,"Process")
        [Environment]::SetEnvironmentVariable($entry.Key,$entry.Value,"Process")
    }
    try{
        Assert-CertificationHarnessArtifactEnvironment $artifactBindings
        $artifactEnvironmentMismatchRejected=$false
        [Environment]::SetEnvironmentVariable("LOAD_DEVICE_MANIFEST",$artifactTwo,"Process")
        try{Assert-CertificationHarnessArtifactEnvironment $artifactBindings}catch{$artifactEnvironmentMismatchRejected=$_.Exception.Message -match "differs from its role-tagged"}
        Assert-Condition $artifactEnvironmentMismatchRejected "The supervisor must reject a harness path that differs from the attested artifact."
        $assertions++
        [Environment]::SetEnvironmentVariable("LOAD_DEVICE_MANIFEST",$artifactOne.ToUpperInvariant(),"Process")
        $caseVariantRejected=$false
        try{Assert-CertificationHarnessArtifactEnvironment $artifactBindings}catch{$caseVariantRejected=$true}
        Assert-Condition ($(if($IsWindows){-not $caseVariantRejected}else{$caseVariantRejected})) `
            "Harness artifact path comparison must follow the host filesystem's case semantics."
        $assertions++
    }finally{
        foreach($entry in $previousArtifactEnvironment.GetEnumerator()){
            [Environment]::SetEnvironmentVariable($entry.Key,$entry.Value,"Process")
        }
    }

    $duplicateArtifactKindRejected=$false
    try{
        Get-CertificationHarnessArtifactBindings @(
            $fixture.artifacts[0],$fixture.artifacts[1],
            [pscustomobject]@{kind="teacher-auth";path=$artifactThree;sha256=Get-CertificationSha256 $artifactThree}
        ) "fixture.artifacts" | Out-Null
    }catch{$duplicateArtifactKindRejected=$_.Exception.Message -match "each reviewed harness artifact kind exactly once"}
    Assert-Condition $duplicateArtifactKindRejected "Duplicate or missing harness artifact roles must fail closed."
    $assertions++
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
        WorkloadSchemaVersion=$script:RequiredWorkloadSchemaVersion;WorkloadEndpointShapeSha256=$script:RequiredWorkloadEndpointShapeSha256
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

    $rootPath=Join-Path $tempRoot "root.json";Write-AtomicJson $rootPath ([ordered]@{schemaVersion=1;type="certification_chain_root";runId=$priorRunId;chainId=$chainId;phase="Waf";stage="500";supervisionKind="Load";createdAtUtc=[DateTimeOffset]::UtcNow.ToString("o");capacityTrack="baseline";applicationGitSha=$appSha;deployedImageDigest=$digest;workloadSchemaVersion=$script:RequiredWorkloadSchemaVersion;workloadEndpointShapeSha256=$script:RequiredWorkloadEndpointShapeSha256;controllerGitSha=$controllerSha;controllerHashes=$controllerHashes;operatorConfigSha256=$operatorHash;boundRuntimeConfigSha256=$runtimeHash;rollbackConfig=$boundRollback;validationReceipt=$receiptBinding;taskDefinitions=$taskDefinitions;fixture=$fixture;schemaCompatibility=$schemaBinding;budgetAcknowledgement=$null;generatorPublicIpv4="198.51.100.10";historicalEvidenceDiagnosticOnly=@();datastorePosture=$datastore;networkPosture=$network;alarms=$alarms;schedules=$schedules;rollbackIdentities=$rollbackIdentities})
    $rootRef=[pscustomobject]@{path=$rootPath;sha256=Get-CertificationSha256 $rootPath}
    $stagePath=Join-Path $tempRoot "prior-stage.json";Write-AtomicJson $stagePath ([ordered]@{schemaVersion=1;type="certification_stage_attestation";runId=$priorRunId;chainId=$chainId;phase="Waf";stage="500";supervisionKind="Load";attestedAtUtc=[DateTimeOffset]::UtcNow.ToString("o");chainRoot=$rootRef;validationReceipt=$receiptBinding;predecessor=$null;applicationGitSha=$appSha;deployedImageDigest=$digest;workloadSchemaVersion=$script:RequiredWorkloadSchemaVersion;workloadEndpointShapeSha256=$script:RequiredWorkloadEndpointShapeSha256;controllerGitSha=$controllerSha;controllerHashes=$controllerHashes;operatorConfigSha256=$operatorHash;boundRuntimeConfigSha256=$runtimeHash;rollbackConfig=$boundRollback;taskDefinitions=$taskDefinitions;fixture=$fixture;generatorPublicIpv4="198.51.100.10";datastorePosture=$datastore;networkPosture=$network;alarms=$alarms;schedules=$schedules;rollbackIdentities=$rollbackIdentities;budgetAcknowledgement=$null;historicalEvidence=@{diagnosticOnly=$true;artifacts=@()}})
    $stageRef=[ordered]@{path=$stagePath;sha256=Get-CertificationSha256 $stagePath}
    $monitorTileBatch=[ordered]@{pollAccountingVersion=$script:RequiredPollAccountingVersion;teacherCohorts=20;studentsPerCohort=25;teacherTileAssignments=500;requestsPerCohortPerPoll=2;logicalOperationsPerPoll=1000;historyRequestsByCohort=@(1..20|ForEach-Object{if($_ -le 10){59}else{58}});screenshotRequestsByCohort=@(1..20|ForEach-Object{if($_ -le 10){59}else{58}});completeRoundsPerCohort=58;maximumRoundsPerCohort=59;partialFinalRoundCohorts=10;historyRequests=1170;screenshotRequests=1170;historyLogicalOperations=29250;screenshotLogicalOperations=29250;networkRequests=2340;logicalOperations=58500;screenshotAttempts=29250;screenshotSuccesses=29250}
    $monitorPath=Join-Path $tempRoot "prior-monitor.json";Write-AtomicJson $monitorPath ([ordered]@{runId=$priorRunId;phase="Waf";diagnosticOnly=$false;certificationEligible=$true;status="completed";postureAccepted=$true;workload=@{stage="500";workloadSchemaVersion=$script:RequiredWorkloadSchemaVersion;endpointShapeSha256=$script:RequiredWorkloadEndpointShapeSha256;tileBatch=$monitorTileBatch};acceptance=@{passed=$true}})
    $monitorRef=[ordered]@{path=$monitorPath;sha256=Get-CertificationSha256 $monitorPath;runId=$priorRunId;phase="Waf"}
    $producerRootRef=[ordered]@{path=$rootRef.path;sha256=$rootRef.sha256}
    $producerPredecessorSha=""
    $linkInput=(@(
        [string](Get-CertificationValue $producerRootRef "sha256" ("0"*64)),
        $(if($producerPredecessorSha){$producerPredecessorSha}else{"0"*64}),
        [string](Get-CertificationValue $stageRef "sha256" ("0"*64)),
        [string]$monitorRef.sha256
    )-join "`n")
    $consumerLinkInput=@($rootRef.sha256,("0"*64),$stageRef.sha256,$monitorRef.sha256)-join "`n"
    Assert-Condition ((Get-CertificationTextSha256 $linkInput) -eq (Get-CertificationTextSha256 $consumerLinkInput)) `
        "A producer link built from ordered bindings must match consumer recomputation."
    $assertions++
    $envelopePath=Join-Path $tempRoot "prior-supervisor.json"
    $envelope=[ordered]@{schemaVersion=2;type="certification_supervisor_terminal";supervisorSealed=$true;status="completed";runId=$priorRunId;phase="Waf";stage="500";chainId=$chainId;applicationGitSha=$appSha;deployedImageDigest=$digest;workloadSchemaVersion=$script:RequiredWorkloadSchemaVersion;workloadEndpointShapeSha256=$script:RequiredWorkloadEndpointShapeSha256;controllerGitSha=$controllerSha;controllerHashes=$controllerHashes;operatorConfigSha256=$operatorHash;boundRuntimeConfigSha256=$runtimeHash;rollbackConfig=$boundRollback;supervisionKind="Load";chainRoot=$rootRef;stageAttestation=$stageRef;terminalMonitorResult=$monitorRef;predecessorSupervisorResultSha256=$null;linkSha256=Get-CertificationTextSha256 $linkInput}
    Write-AtomicJson $envelopePath $envelope
    $contract.Raw|Add-Member -NotePropertyName chainRoot -NotePropertyValue $rootRef
    $config=[pscustomobject]@{phase="Waf";workload=[pscustomobject]@{stage="800";workloadSchemaVersion=$script:RequiredWorkloadSchemaVersion;endpointShapeSha256=$script:RequiredWorkloadEndpointShapeSha256};predecessorResultPath=$envelopePath;predecessorResultSha256=Get-CertificationSha256 $envelopePath}
    Assert-CertificationChainContinuity -Config $config -Contract $contract;$assertions++

    $tamperedControllerEnvelope=$envelope|ConvertTo-Json -Depth 60|ConvertFrom-Json -Depth 60
    $tamperedControllerEnvelope.controllerHashes.tilePollAccounting="8"*64
    Write-AtomicJson $envelopePath $tamperedControllerEnvelope;$config.predecessorResultSha256=Get-CertificationSha256 $envelopePath
    $tamperedControllerHashRejected=$false
    try{Assert-CertificationChainContinuity -Config $config -Contract $contract}catch{$tamperedControllerHashRejected=$true}
    Assert-Condition $tamperedControllerHashRejected "A re-sealed predecessor with a changed tile-poll-accounting helper hash must not seed certification.";$assertions++
    Write-AtomicJson $envelopePath $envelope;$config.predecessorResultSha256=Get-CertificationSha256 $envelopePath

    $invalidLogicalMonitor=Get-Content -LiteralPath $monitorPath -Raw|ConvertFrom-Json -Depth 60
    $invalidLogicalMonitor.workload.tileBatch.historyLogicalOperations=499
    Write-AtomicJson $monitorPath $invalidLogicalMonitor
    $invalidLogicalMonitorRef=[ordered]@{path=$monitorPath;sha256=Get-CertificationSha256 $monitorPath;runId=$priorRunId;phase="Waf"}
    $invalidLogicalEnvelope=$envelope|ConvertTo-Json -Depth 60|ConvertFrom-Json -Depth 60
    $invalidLogicalEnvelope.terminalMonitorResult=$invalidLogicalMonitorRef
    $invalidLogicalEnvelope.linkSha256=Get-CertificationTextSha256 (@($rootRef.sha256,("0"*64),$stageRef.sha256,$invalidLogicalMonitorRef.sha256)-join "`n")
    Write-AtomicJson $envelopePath $invalidLogicalEnvelope;$config.predecessorResultSha256=Get-CertificationSha256 $envelopePath
    $invalidLogicalRejected=$false
    try{Assert-CertificationChainContinuity -Config $config -Contract $contract}catch{$invalidLogicalRejected=$_.Exception.Message -match "terminal monitor result"}
    Assert-Condition $invalidLogicalRejected "A re-sealed monitor result with inconsistent batch logical accounting must not seed certification.";$assertions++
    Write-AtomicJson $monitorPath ([ordered]@{runId=$priorRunId;phase="Waf";diagnosticOnly=$false;certificationEligible=$true;status="completed";postureAccepted=$true;workload=@{stage="500";workloadSchemaVersion=$script:RequiredWorkloadSchemaVersion;endpointShapeSha256=$script:RequiredWorkloadEndpointShapeSha256;tileBatch=$monitorTileBatch};acceptance=@{passed=$true}})
    $monitorRef=[ordered]@{path=$monitorPath;sha256=Get-CertificationSha256 $monitorPath;runId=$priorRunId;phase="Waf"}
    $envelope.terminalMonitorResult=$monitorRef
    $envelope.linkSha256=Get-CertificationTextSha256 (@($rootRef.sha256,("0"*64),$stageRef.sha256,$monitorRef.sha256)-join "`n")
    Write-AtomicJson $envelopePath $envelope;$config.predecessorResultSha256=Get-CertificationSha256 $envelopePath

    $legacyPerDeviceEnvelope=$envelope|ConvertTo-Json -Depth 60|ConvertFrom-Json -Depth 60
    $legacyPerDeviceEnvelope.PSObject.Properties.Remove("workloadSchemaVersion")
    $legacyPerDeviceEnvelope.PSObject.Properties.Remove("workloadEndpointShapeSha256")
    Write-AtomicJson $envelopePath $legacyPerDeviceEnvelope;$config.predecessorResultSha256=Get-CertificationSha256 $envelopePath
    $legacyPerDeviceRejected=$false
    try{Assert-CertificationChainContinuity -Config $config -Contract $contract}catch{$legacyPerDeviceRejected=$true}
    Assert-Condition $legacyPerDeviceRejected "A historical per-device predecessor without the tile-batch schema/shape binding must be rejected.";$assertions++
    Write-AtomicJson $envelopePath $envelope;$config.predecessorResultSha256=Get-CertificationSha256 $envelopePath

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

    $runId = "receipt-missing-tile-helper-hash"
    $missingHelperReceiptPath = Join-Path $tempRoot "missing-helper-receipt.json"
    $missingHelperSealPath = Join-Path $tempRoot "missing-helper-receipt-seal.json"
    $missingHelperConsumedPath = "$missingHelperReceiptPath.consumed"
    $preflight.observedAtUtc=[DateTimeOffset]::UtcNow.AddSeconds(-1).ToString("o")
    New-CertificationValidationReceipt -Contract $receiptContract -Preflight $preflight -RollbackConfig $rollbackBinding -ReceiptPath $missingHelperReceiptPath -SealPath $missingHelperSealPath
    $missingHelperReceipt = Get-Content -LiteralPath $missingHelperReceiptPath -Raw | ConvertFrom-Json -Depth 30
    $missingHelperReceipt.controllerHashes.PSObject.Properties.Remove("tilePollAccounting")
    Write-AtomicJson $missingHelperReceiptPath $missingHelperReceipt
    Write-AtomicJson $missingHelperSealPath ([ordered]@{
        schemaVersion=1;type="certification_validation_receipt_seal";runId=$runId
        receiptSha256=Get-CertificationSha256 $missingHelperReceiptPath
    })
    $missingHelperHashRejected = $false
    try { Use-CertificationValidationReceipt -Contract $receiptContract -ReceiptPath $missingHelperReceiptPath -SealPath $missingHelperSealPath -ConsumedPath $missingHelperConsumedPath | Out-Null }
    catch { $missingHelperHashRejected = $true }
    Assert-Condition ($missingHelperHashRejected -and -not (Test-Path $missingHelperConsumedPath)) "A re-sealed receipt missing the tile-poll-accounting helper hash must fail before consumption."
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

    $failedRunObservedNow = [DateTimeOffset]::Parse("2026-07-18T03:40:20.3511840Z")
    $convertedVerification = '{"verifiedAt":"2026-07-18T03:40:04.601Z"}' | ConvertFrom-Json
    Assert-Condition ($convertedVerification.verifiedAt -is [DateTime]) `
        "The regression must exercise PowerShell ConvertFrom-Json automatic DateTime conversion."
    $assertions++
    $failedRunVerifiedAt = Assert-CertificationFixtureVerificationTimestamp `
        $convertedVerification.verifiedAt 60 $failedRunObservedNow "Fixture verification verifiedAt"
    $convertedState = '{"schemaVersion":1,"fixtureId":"launch-safe-20260711","generatedAt":"2026-07-11T21:37:04.729Z","refreshedAt":"2026-07-18T03:39:11.540Z"}' | ConvertFrom-Json
    $failedRunFixtureGeneration = Get-CertificationFixtureGenerationBinding `
        $convertedState `
        ([pscustomobject]@{schemaVersion=1;fixtureId="launch-safe-20260711";passed=$true}) `
        ([pscustomobject]@{expectedFixtureId="launch-safe-20260711"}) `
        $failedRunVerifiedAt 60 $failedRunObservedNow
    Assert-Condition `
        ($failedRunVerifiedAt.ToString("o") -eq "2026-07-18T03:40:04.6010000+00:00" -and
         [string]$failedRunFixtureGeneration.refreshedAtUtc -eq "2026-07-18T03:39:11.5400000+00:00") `
        "JSON DateTime values must retain their original UTC instants without a second local offset."
    $assertions++

    $fixedNowFutureRejected = $false
    try {
        Assert-CertificationFixtureVerificationTimestamp `
            "2026-07-18T03:40:20.3521840Z" 60 $failedRunObservedNow "Fixture verification verifiedAt" | Out-Null
    }
    catch {
        $fixedNowFutureRejected = $_.Exception.Message -match `
            "value=2026-07-18T03:40:20.3521840\+00:00; observedNowUtc=2026-07-18T03:40:20.3511840\+00:00"
    }
    Assert-Condition $fixedNowFutureRejected "Fixture verification must reject and diagnose an exact future timestamp."
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
