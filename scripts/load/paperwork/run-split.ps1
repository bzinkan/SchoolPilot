#requires -Version 7.5
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^.+@sha256:[a-f0-9]{64}$')][string]$ImageReference,
  [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedRevision,
  [string]$ExpectedCompiledDirectory,
  [string]$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..')),
  [Parameter(Mandatory)][string]$EvidenceDirectory,
  [ValidatePattern('^schoolpilot_(paperwork|benchmark)[a-z0-9_]*$')][string]$SchemaDatabase = 'schoolpilot_paperwork_progress_20260928',
  [ValidatePattern('^[a-zA-Z0-9_.-]+$')][string]$SchemaContainer = 'schoolpilot-db',
  [ValidatePattern('^[a-zA-Z_][a-zA-Z0-9_]*$')][string]$SchemaRole = 'schoolpilot',
  [ValidateRange(0.5, 4)][decimal]$ApiCpu = 1,
  [ValidateRange(1024, 8192)][int]$ApiMemoryMiB = 2048,
  [ValidateRange(0.5, 4)][decimal]$WorkerCpu = 0.5,
  [ValidateRange(1024, 8192)][int]$WorkerMemoryMiB = 1024
)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath($RepositoryRoot)
$root = [IO.Path]::GetFullPath($EvidenceDirectory)
if ($root.StartsWith($repository + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $root -eq $repository) { throw 'Evidence must be outside the repository.' }
if (Test-Path -LiteralPath $root) { throw 'Choose a new evidence directory; existing evidence is never overwritten.' }
$digest = $ImageReference.Split('@')[-1]
$identity = docker image inspect $ImageReference | ConvertFrom-Json -DateKind String
if ($LASTEXITCODE -ne 0 -or $identity.Count -ne 1 -or $identity.Architecture -cne 'amd64' -or $identity.Os -cne 'linux' -or $identity.RepoDigests -cnotcontains $ImageReference) { throw 'Pinned Linux amd64 image is unavailable.' }
$imageRevision = $identity.Config.Labels.'org.opencontainers.image.revision'
if ($imageRevision -and $imageRevision -cne $ExpectedRevision) { throw 'Pinned image revision differs from the expected reviewed commit.' }
$sourceProof = & node (Join-Path $PSScriptRoot 'runner-provenance.mjs') capture $repository $ExpectedRevision $PSCommandPath | ConvertFrom-Json -DateKind String
if ($LASTEXITCODE -ne 0) { throw 'Application or harness source identity is unavailable or unclean.' }
if ($sourceProof.harnessRepositoryRoot) {
  $toolRepository = [IO.Path]::GetFullPath($sourceProof.harnessRepositoryRoot)
  if ($root.StartsWith($toolRepository + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $root -eq $toolRepository) { throw 'Evidence must be outside the harness repository.' }
}
$repositoryRevision = $sourceProof.repositoryRevision
$harnessRevision = $sourceProof.harnessRevision
$harnessSource = $sourceProof.harnessSource
$runnerSourceSha256 = $sourceProof.runnerSourceSha256
$sourceIdentity = 'oci_revision_label'
$compiledHashes = $null
if (-not $imageRevision) {
  if ([string]::IsNullOrWhiteSpace($ExpectedCompiledDirectory)) { throw 'An unlabeled image requires the reviewed final build directory for compiled-source verification.' }
  if ($repositoryRevision -cne $ExpectedRevision) { throw 'Compiled-source fallback requires this checkout at the reviewed final commit.' }
  $compiledRoot = [IO.Path]::GetFullPath($ExpectedCompiledDirectory)
  $files = @('services/mydeskImportWorker.js','services/mydeskImportPipeline.js','services/importProcessingStages.js','services/mydeskImportProcessing.js','services/mydeskImportsValidation.js','services/mydeskFiles.js','services/mydeskImports.js','config/paperworkProcessing.js','schema/importProcessingStages.js','schema/mydeskImports.js','services/studentInformationWorker.js','routes/mydesk.js')
  $compiledHashes = @{}
  foreach ($file in $files) { $compiledHashes[$file] = (Get-FileHash -LiteralPath (Join-Path $compiledRoot $file) -Algorithm SHA256).Hash.ToLowerInvariant() }
  $hashScript = 'const fs=require("node:fs"),c=require("node:crypto");const files=JSON.parse(process.argv[1]);console.log(JSON.stringify(Object.fromEntries(files.map(f=>[f,c.createHash("sha256").update(fs.readFileSync("/app/dist/"+f)).digest("hex")]))));'
  $imageHashes = docker run --rm --network none --read-only $ImageReference node -e $hashScript (ConvertTo-Json -InputObject $files -Compress) | ConvertFrom-Json -DateKind String -AsHashtable
  if ($LASTEXITCODE -ne 0) { throw 'Pinned image compiled-source verification failed.' }
  foreach ($file in $files) { if ($imageHashes[$file] -cne $compiledHashes[$file]) { throw 'Pinned image differs from the reviewed compiled build.' } }
  $sourceIdentity = 'reviewed_local_build_compiled_hashes_and_deployment_receipt'
  $imageRevision = $ExpectedRevision
}
New-Item -ItemType Directory -Path $root | Out-Null
[ordered]@{expectedRevision=$ExpectedRevision;identityMethod=$sourceIdentity;imageDigest=$digest;compiledHashes=$compiledHashes} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'split-source-identity.json') -Encoding utf8
$sourceProof | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $root 'split-harness-source-before.json') -Encoding utf8
foreach ($file in $sourceProof.files.PSObject.Properties) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file.Name) -Destination (Join-Path $root $file.Name)
  if ((Get-FileHash -LiteralPath (Join-Path $root $file.Name) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.Value.sha256) { throw 'Harness source changed while evidence was frozen.' }
}
$runId = [guid]::NewGuid().ToString('N').Substring(0, 12)
$network = 'sp-paperwork-capacity-' + $runId
$dbContainer = $network + '-db'; $appContainer = $network + '-api'; $workerContainer = $network + '-worker'
$driverContainer = $network + '-driver'; $filesContainer = $network + '-files'; $volume = $network + '-evidence'
$DriverCpu = 1; $DriverMemoryMiB = 1024
$database = 'schoolpilot_benchmark_capacity'; $role = 'paperwork_app'
$saved = @{}
$names = @('POSTGRES_PASSWORD','POSTGRES_DB','DATABASE_URL','ADMIN_DATABASE_URL','DATABASE_URL_PRIVILEGED','JWT_SECRET','SESSION_SECRET','RLS_ENABLED_TABLES','RLS_TEST_ROLE','RLS_GUC_ENABLED','SCHEDULER_ENABLED','NODE_ENV','EVIDENCE_IMAGE_DIGEST','EVIDENCE_CPU','EVIDENCE_MEMORY','EVIDENCE_SOURCE_REVISION','AWS_EC2_METADATA_DISABLED','MYDESK_AI_IMPORT_MODEL','ANTHROPIC_API_KEY','PAPERWORK_LIVE_PROVIDER','PAPERWORK_SCENARIO','MYDESK_MODE','MYDESK_AI_IMPORT_MODE','MYDESK_IMPORT_PIPELINE_VERSION','MYDESK_IMPORT_PIPELINE_WIDTH','STUDENT_INFORMATION_AI_IMPORT_MODE')
$names += 'MYDESK_SEATING_MODE'
foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
$deadline = [DateTimeOffset]::UtcNow.AddMinutes(15)
$exitCode = 1; $networkCreated = $false; $dbCreated = $false; $appCreated = $false; $workerCreated = $false
$driverCreated = $false; $filesCreated = $false; $volumeCreated = $false; $artifactCopySucceeded = $false; $sourceIdentityVerified = $false
try {
  # Schema only from an explicitly local synthetic database. Never load production data.
  $schemaPath = Join-Path $root 'split-local-schema.sql'
  docker exec $SchemaContainer pg_dump -U $SchemaRole -d $SchemaDatabase --schema-only --no-owner --no-privileges | Set-Content -LiteralPath $schemaPath -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw 'Local schema export failed.' }
  $env:POSTGRES_PASSWORD = [guid]::NewGuid().ToString('N'); $env:POSTGRES_DB = $database
  $appPassword = [guid]::NewGuid().ToString('N')
  $env:DATABASE_URL = "postgresql://${role}:${appPassword}@127.0.0.1:5432/$database"
  $env:DATABASE_URL_PRIVILEGED = $env:DATABASE_URL
  $env:ADMIN_DATABASE_URL = "postgresql://postgres:$($env:POSTGRES_PASSWORD)@127.0.0.1:5432/$database"
  $env:JWT_SECRET = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
  $env:SESSION_SECRET = [guid]::NewGuid().ToString('N')
  $registry = Get-Content (Join-Path $repository 'src/config/rlsRegistry.json') -Raw | ConvertFrom-Json -DateKind String
  $tables = @($registry.inventories.passpilotAppointmentsPostExpand.tables)
  if ($tables -cnotcontains 'import_processing_stages' -or ($tables | Select-Object -Unique).Count -ne $tables.Count) { throw 'Current stage-ledger RLS inventory is invalid.' }
  $env:RLS_ENABLED_TABLES = $tables -join ','
  $env:RLS_TEST_ROLE = $role; $env:RLS_GUC_ENABLED = 'true'; $env:SCHEDULER_ENABLED = 'false'; $env:NODE_ENV = 'test'
  $env:EVIDENCE_IMAGE_DIGEST = $digest; $env:EVIDENCE_CPU = [string]$ApiCpu; $env:EVIDENCE_MEMORY = [string]($ApiMemoryMiB * 1048576); $env:EVIDENCE_SOURCE_REVISION = $imageRevision
  $env:PAPERWORK_SCENARIO = 'split'; $env:PAPERWORK_LIVE_PROVIDER = '0'
  $env:AWS_EC2_METADATA_DISABLED = 'true'; $env:MYDESK_AI_IMPORT_MODEL = 'claude-opus-5-5'; $env:ANTHROPIC_API_KEY = $null
  $env:MYDESK_MODE = 'on'; $env:MYDESK_AI_IMPORT_MODE = 'on'; $env:MYDESK_IMPORT_PIPELINE_VERSION = '2'; $env:MYDESK_IMPORT_PIPELINE_WIDTH = '2'; $env:STUDENT_INFORMATION_AI_IMPORT_MODE = 'off'
  $env:MYDESK_SEATING_MODE = 'on'
  docker network create --internal $network | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Isolated network failed.' }; $networkCreated = $true
  docker run -d --name $dbContainer --network $network --memory 512m --cpus 1 --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=384m -e POSTGRES_PASSWORD -e POSTGRES_DB postgres:16-alpine | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Disposable database failed.' }; $dbCreated = $true
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) { docker exec $dbContainer pg_isready -U postgres -d $database 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { $ready = $true; break }; Start-Sleep -Milliseconds 500 }
  if (-not $ready) { throw 'Disposable database did not become ready.' }
  Get-Content -LiteralPath $schemaPath -Raw | docker exec -i $dbContainer psql -U postgres -d $database -v ON_ERROR_STOP=1 *> (Join-Path $root 'split-schema-restore.log')
  if ($LASTEXITCODE -ne 0) { throw 'Schema-only restore failed.' }
  "CREATE ROLE $role LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '$appPassword'; GRANT USAGE ON SCHEMA public TO $role; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO $role; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO $role;" | docker exec -i $dbContainer psql -U postgres -d $database -v ON_ERROR_STOP=1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Restricted application role setup failed.' }
  $environmentArgs = @(); foreach ($name in $names | Where-Object { $_ -notin @('POSTGRES_PASSWORD','POSTGRES_DB','ANTHROPIC_API_KEY') }) { $environmentArgs += @('-e', $name) }
  $started = [DateTimeOffset]::UtcNow.ToString('o')
  # Host transfer happens before/after load; clients never consume the serving API quota.
  docker volume create --label "schoolpilot.capacity.run=$runId" $volume | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Isolated evidence volume creation failed.' }; $volumeCreated = $true
  docker create --name $filesContainer --user 0 --network none --read-only --mount "type=volume,source=$volume,target=/app/evidence" $ImageReference sh -c 'chown -R node:node /app/evidence' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Evidence transfer container creation failed.' }; $filesCreated = $true
  docker cp (Join-Path $root '.') "${filesContainer}:/app/evidence/"
  if ($LASTEXITCODE -ne 0) { throw 'Evidence source copy into Linux volume failed.' }
  # This fixed path is the new isolated volume, never a host checkout or production mount.
  docker start -a $filesContainer | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Isolated evidence volume ownership setup failed.' }
  $workerEnvironment = @(); foreach ($name in $names | Where-Object { $_ -notin @('POSTGRES_PASSWORD','POSTGRES_DB','ANTHROPIC_API_KEY','ADMIN_DATABASE_URL','SCHEDULER_ENABLED','EVIDENCE_CPU','EVIDENCE_MEMORY') }) { $workerEnvironment += @('-e',$name) }
  $apiEnvironment = @(); foreach ($name in $names | Where-Object { $_ -notin @('POSTGRES_PASSWORD','POSTGRES_DB','ANTHROPIC_API_KEY','ADMIN_DATABASE_URL') }) { $apiEnvironment += @('-e',$name) }
  docker run -d --name $workerContainer --network "container:$dbContainer" --memory "${WorkerMemoryMiB}m" --memory-swap "${WorkerMemoryMiB}m" --cpus ([string]$WorkerCpu) --pids-limit 128 --read-only --tmpfs /tmp:rw,nosuid,size=128m --mount "type=volume,source=$volume,target=/app/evidence" @workerEnvironment -e SCHEDULER_ENABLED=true -e "EVIDENCE_CPU=$WorkerCpu" -e "EVIDENCE_MEMORY=$($WorkerMemoryMiB * 1048576)" $ImageReference node /app/evidence/split-worker.mjs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Exact-image worker start failed.' }; $workerCreated = $true
  docker run -d --name $appContainer --network "container:$dbContainer" --memory "${ApiMemoryMiB}m" --memory-swap "${ApiMemoryMiB}m" --cpus ([string]$ApiCpu) --pids-limit 128 --read-only --tmpfs /tmp:rw,nosuid,size=128m --mount "type=volume,source=$volume,target=/app/evidence" @apiEnvironment $ImageReference node /app/evidence/split-api-server.mjs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Exact-image API start failed.' }
  $appCreated = $true
  $servicesReady = $false
  for ($i=0; $i -lt 30; $i++) {
    docker exec $appContainer node -e "Promise.all([fetch('http://127.0.0.1:3998/__capacity/ready'),fetch('http://127.0.0.1:3999/ready')]).then(rs=>process.exit(rs.every(r=>r.ok)?0:1)).catch(()=>process.exit(1))" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $servicesReady=$true; break }; Start-Sleep -Milliseconds 500
  }
  if (-not $servicesReady) { throw 'Synthetic API/worker control endpoints did not become ready.' }
  docker create --name $driverContainer --network "container:$dbContainer" --memory "${DriverMemoryMiB}m" --memory-swap "${DriverMemoryMiB}m" --cpus ([string]$DriverCpu) --pids-limit 128 --read-only --tmpfs /tmp:rw,nosuid,size=128m --mount "type=volume,source=$volume,target=/app/evidence" @environmentArgs -e "DRIVER_CPU=$DriverCpu" -e "DRIVER_MEMORY=$($DriverMemoryMiB * 1048576)" $ImageReference node --test --test-concurrency=1 /app/evidence/split.test.mjs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Isolated load-driver create failed.' }; $driverCreated = $true
  docker start $driverContainer | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Isolated load-driver start failed.' }
  $controllerAbort = $null
  while ($true) {
    $driverState = docker inspect $driverContainer --format '{{json .State}}' | ConvertFrom-Json -DateKind String
    if ($LASTEXITCODE -ne 0) { throw 'Load-driver state unavailable.' }
    if (-not $driverState.Running) { break }
    foreach ($service in @(@{name=$appContainer;label='API'},@{name=$workerContainer;label='WORKER'})) {
      $state = docker inspect $service.name --format '{{json .State}}' | ConvertFrom-Json -DateKind String
      if ($LASTEXITCODE -ne 0) { throw 'Service state unavailable.' }
      if (-not $state.Running -and $state.ExitCode -ne 0) { $controllerAbort=$service.label+'_EXIT_NONZERO'; break }
    }
    if ($controllerAbort) { docker stop --time 2 $driverContainer | Out-Null; break }
    if ([DateTimeOffset]::UtcNow -ge $deadline) { $controllerAbort='CONTROLLER_15_MINUTE_DEADLINE'; docker stop --time 2 $driverContainer | Out-Null; break }
    Start-Sleep -Milliseconds 1000
  }
  $driverState = docker inspect $driverContainer --format '{{json .State}}' | ConvertFrom-Json -DateKind String
  if ($LASTEXITCODE -ne 0) { throw 'Load-driver result unavailable.' }
  $exitCode = [int]$driverState.ExitCode
  $apiState = docker inspect $appContainer --format '{{json .State}}' | ConvertFrom-Json -DateKind String
  if ($LASTEXITCODE -ne 0) { throw 'API result unavailable.' }
  if ($apiState.Running) { docker stop --time 10 $appContainer | Out-Null; $apiState = docker inspect $appContainer --format '{{json .State}}' | ConvertFrom-Json -DateKind String }
  $workerState = docker inspect $workerContainer --format '{{json .State}}' | ConvertFrom-Json -DateKind String
  if ($LASTEXITCODE -ne 0) { throw 'Worker result unavailable.' }
  if ($workerState.Running) { docker stop --time 2 $workerContainer | Out-Null; $workerState = docker inspect $workerContainer --format '{{json .State}}' | ConvertFrom-Json -DateKind String }
  $apiImage = docker inspect $appContainer --format '{{.Image}}'; $workerImage = docker inspect $workerContainer --format '{{.Image}}'; $driverImage = docker inspect $driverContainer --format '{{.Image}}'
  if ($apiImage -cne $identity.Id -or $workerImage -cne $identity.Id -or $driverImage -cne $identity.Id) { throw 'Running containers differ from the pinned image ID.' }
  $inspectFormat = '{"containerId":"{{.Id}}","imageId":"{{.Image}}","nanoCpus":{{.HostConfig.NanoCpus}},"memoryBytes":{{.HostConfig.Memory}},"memorySwapBytes":{{.HostConfig.MemorySwap}},"user":"{{.Config.User}}","mounts":{{json .Mounts}}}'
  $inspectedServices = @{}
  foreach ($service in @(@{name=$appContainer;role='api';cpu=$ApiCpu;memory=$ApiMemoryMiB},@{name=$workerContainer;role='worker';cpu=$WorkerCpu;memory=$WorkerMemoryMiB},@{name=$driverContainer;role='driver';cpu=$DriverCpu;memory=$DriverMemoryMiB})) {
    $inspected = docker inspect $service.name --format $inspectFormat | ConvertFrom-Json -DateKind String
    if ($LASTEXITCODE -ne 0 -or $inspected.containerId -cnotmatch '^[a-f0-9]{64}$' -or $inspected.nanoCpus -ne $service.cpu*1000000000 -or $inspected.memoryBytes -ne $service.memory*1048576 -or $inspected.memorySwapBytes -ne $inspected.memoryBytes -or $inspected.user -cne 'node') { throw 'Inspected service identity/resources differ from the declared topology.' }
    $evidenceMount = @($inspected.mounts | Where-Object Destination -eq '/app/evidence')
    if ($evidenceMount.Count -ne 1 -or $evidenceMount[0].Type -cne 'volume' -or $evidenceMount[0].Name -cne $volume) { throw 'Service evidence storage is not the isolated Linux volume.' }
    $inspectedServices[$service.role] = $inspected
  }
  if (@($inspectedServices.Values.containerId | Select-Object -Unique).Count -ne 3) { throw 'API, worker and driver must be distinct containers.' }
  $inspectedServices | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $root 'split-topology-inspection.json') -Encoding utf8
  if ($driverState.OOMKilled -or $apiState.OOMKilled -or $workerState.OOMKilled -or $controllerAbort -or $apiState.ExitCode -ne 0 -or $workerState.ExitCode -ne 0) { $exitCode = 1 }
  [ordered]@{version=3;processingVersion=2;pipelineWidth=2;sourceIdentity=$sourceIdentity;runId=$runId;startedAt=$started;finishedAt=[DateTimeOffset]::UtcNow.ToString('o');imageDigest=$digest;imageRevision=$imageRevision;repositoryRevision=$repositoryRevision;harnessRevision=$harnessRevision;harnessSource=$harnessSource;runnerSourceSha256=$runnerSourceSha256;apiInspectedImageId=$apiImage;workerInspectedImageId=$workerImage;driverInspectedImageId=$driverImage;apiCpu=$ApiCpu;apiMemoryMiB=$ApiMemoryMiB;workerCpu=$WorkerCpu;workerMemoryMiB=$WorkerMemoryMiB;driverCpu=$DriverCpu;driverMemoryMiB=$DriverMemoryMiB;apiState=$apiState;workerState=$workerState;driverState=$driverState;controllerAbort=$controllerAbort;exitCode=$exitCode;storage='physical_linux_volume';provider='synthetic_transport';network='internal_no_external_access';database='schema_only_fresh_tmpfs';productionMutations=0;description='Separate load driver and pinned-image API/worker; actual v2 claims; ordinary HTTP uploads; shared Linux-native volume; no exposed ports or serving task changes'} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $root 'split-execution.json') -Encoding utf8
} finally {
  $cleanupSucceeded = $true
  # Freeze service output before transferring authoritative final evidence.
  foreach ($item in @(@{created=$driverCreated;name=$driverContainer;grace=2},@{created=$appCreated;name=$appContainer;grace=10},@{created=$workerCreated;name=$workerContainer;grace=2})) {
    if ($item.created) {
      $state = docker inspect $item.name --format '{{json .State}}' | ConvertFrom-Json -DateKind String
      if ($LASTEXITCODE -ne 0) { $cleanupSucceeded=$false }
      elseif ($state.Running) { docker stop --time $item.grace $item.name | Out-Null; if ($LASTEXITCODE -ne 0) { $cleanupSucceeded=$false } }
    }
  }
  if ($filesCreated) {
    docker cp "${filesContainer}:/app/evidence/." $root
    if ($LASTEXITCODE -eq 0) { $artifactCopySucceeded=$true } else { $cleanupSucceeded=$false }
  }
  $finalApiValidationSucceeded = $false
  if ($artifactCopySucceeded) {
    node (Join-Path $root 'finalize-api-evidence.mjs') $root $digest $imageRevision ([string]$ApiCpu) ([string]($ApiMemoryMiB * 1048576))
    if ($LASTEXITCODE -eq 0) { $finalApiValidationSucceeded=$true }
  }
  & node (Join-Path $root 'runner-provenance.mjs') verify (Join-Path $root 'split-harness-source-before.json') (Join-Path $root 'split-harness-source-after.json') | Out-Null
  if ($LASTEXITCODE -eq 0) { $sourceIdentityVerified=$true }
  foreach ($item in @(@{created=$driverCreated;name=$driverContainer;log='split.tap.log'},@{created=$appCreated;name=$appContainer;log='split-api.log'},@{created=$workerCreated;name=$workerContainer;log='split-worker.log'})) {
    if ($item.created) {
      docker logs $item.name *> (Join-Path $root $item.log)
      if ($LASTEXITCODE -ne 0) { $cleanupSucceeded=$false }
      docker rm -f $item.name | Out-Null
      if ($LASTEXITCODE -ne 0) { $cleanupSucceeded=$false }
    }
  }
  if ($filesCreated) { docker rm -f $filesContainer | Out-Null; if ($LASTEXITCODE -ne 0) { $cleanupSucceeded = $false } }
  if ($dbCreated) { docker rm -f $dbContainer | Out-Null; if ($LASTEXITCODE -ne 0) { $cleanupSucceeded = $false } }
  if ($volumeCreated) { docker volume rm $volume | Out-Null; if ($LASTEXITCODE -ne 0) { $cleanupSucceeded = $false } }
  if ($networkCreated) { docker network rm $network | Out-Null; if ($LASTEXITCODE -ne 0) { $cleanupSucceeded = $false } }
  foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
  $appPassword = $null
  $ownedRemaining = @(docker ps -a --filter "name=$network" --format '{{.Names}}')
  if ($LASTEXITCODE -ne 0) { $cleanupSucceeded = $false }
  $ownedNetworkRemaining = @(docker network ls --filter "name=$network" --format '{{.Name}}')
  if ($LASTEXITCODE -ne 0) { $cleanupSucceeded = $false }
  $ownedVolumeRemaining = @(docker volume ls --filter "name=$volume" --format '{{.Name}}')
  if ($LASTEXITCODE -ne 0) { $cleanupSucceeded = $false }
  $cleanupComplete = $cleanupSucceeded -and $ownedRemaining.Count -eq 0 -and $ownedNetworkRemaining.Count -eq 0 -and $ownedVolumeRemaining.Count -eq 0
  if (-not $cleanupComplete -or -not $artifactCopySucceeded -or -not $finalApiValidationSucceeded -or -not $sourceIdentityVerified) { $exitCode = 1 }
  [ordered]@{runId=$runId;containersRemaining=$ownedRemaining;networksRemaining=$ownedNetworkRemaining;volumesRemaining=$ownedVolumeRemaining;artifactCopySucceeded=$artifactCopySucceeded;finalApiValidationSucceeded=$finalApiValidationSucceeded;commandsSucceeded=$cleanupSucceeded;complete=$cleanupComplete} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'split-cleanup.json') -Encoding utf8
  $executionPath = Join-Path $root 'split-execution.json'
  if (Test-Path -LiteralPath $executionPath) {
    $execution = Get-Content -LiteralPath $executionPath -Raw | ConvertFrom-Json -DateKind String
    $execution.exitCode = $exitCode
    $execution | Add-Member -NotePropertyName finalApiValidationSucceeded -NotePropertyValue $finalApiValidationSucceeded
    $execution | Add-Member -NotePropertyName sourceIdentityVerified -NotePropertyValue $sourceIdentityVerified
    $execution | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $executionPath -Encoding utf8
  }
}
Write-Output "Isolated paperwork capacity exit=$exitCode evidence=$root"
exit $exitCode
