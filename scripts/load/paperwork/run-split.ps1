#requires -Version 7.5
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^.+@sha256:[a-f0-9]{64}$')][string]$ImageReference,
  [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedRevision,
  [string]$ExpectedCompiledDirectory,
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
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$root = [IO.Path]::GetFullPath($EvidenceDirectory)
if ($root.StartsWith($repository + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $root -eq $repository) { throw 'Evidence must be outside the repository.' }
if (Test-Path -LiteralPath $root) { throw 'Choose a new evidence directory; existing evidence is never overwritten.' }
$digest = $ImageReference.Split('@')[-1]
$identity = docker image inspect $ImageReference | ConvertFrom-Json -DateKind String
if ($LASTEXITCODE -ne 0 -or $identity.Count -ne 1 -or $identity.Architecture -cne 'amd64' -or $identity.Os -cne 'linux' -or $identity.RepoDigests -cnotcontains $ImageReference) { throw 'Pinned Linux amd64 image is unavailable.' }
$imageRevision = $identity.Config.Labels.'org.opencontainers.image.revision'
if ($imageRevision -and $imageRevision -cne $ExpectedRevision) { throw 'Pinned image revision differs from the expected reviewed commit.' }
$harnessRevision = git -C $repository rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Repository revision unavailable.' }
$sourceIdentity = 'oci_revision_label'
$compiledHashes = $null
if (-not $imageRevision) {
  if ([string]::IsNullOrWhiteSpace($ExpectedCompiledDirectory)) { throw 'An unlabeled image requires the reviewed final build directory for compiled-source verification.' }
  if ($harnessRevision -cne $ExpectedRevision) { throw 'Compiled-source fallback requires this checkout at the reviewed final commit.' }
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
foreach ($name in @('split-worker.mjs', 'split.test.mjs', 'split-api-observation.mjs', 'scheduler-overlap.mjs', 'latency-metrics.mjs')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $root $name) }
$runId = [guid]::NewGuid().ToString('N').Substring(0, 12)
$network = 'sp-paperwork-capacity-' + $runId
$dbContainer = $network + '-db'; $appContainer = $network + '-api'; $workerContainer = $network + '-worker'
$database = 'schoolpilot_benchmark_capacity'; $role = 'paperwork_app'
$saved = @{}
$names = @('POSTGRES_PASSWORD','POSTGRES_DB','DATABASE_URL','ADMIN_DATABASE_URL','DATABASE_URL_PRIVILEGED','JWT_SECRET','SESSION_SECRET','RLS_ENABLED_TABLES','RLS_TEST_ROLE','RLS_GUC_ENABLED','SCHEDULER_ENABLED','NODE_ENV','EVIDENCE_IMAGE_DIGEST','EVIDENCE_CPU','EVIDENCE_MEMORY','EVIDENCE_SOURCE_REVISION','AWS_EC2_METADATA_DISABLED','MYDESK_AI_IMPORT_MODEL','ANTHROPIC_API_KEY','PAPERWORK_LIVE_PROVIDER','PAPERWORK_SCENARIO','MYDESK_MODE','MYDESK_AI_IMPORT_MODE','MYDESK_IMPORT_PIPELINE_VERSION','MYDESK_IMPORT_PIPELINE_WIDTH','STUDENT_INFORMATION_AI_IMPORT_MODE')
foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
$deadline = [DateTimeOffset]::UtcNow.AddMinutes(15)
$exitCode = 1; $networkCreated = $false; $dbCreated = $false; $appCreated = $false; $workerCreated = $false
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
  $tables = @($registry.inventories.importProcessingStagesPostExpand.tables)
  if ($tables -cnotcontains 'import_processing_stages' -or ($tables | Select-Object -Unique).Count -ne $tables.Count) { throw 'Current stage-ledger RLS inventory is invalid.' }
  $env:RLS_ENABLED_TABLES = $tables -join ','
  $env:RLS_TEST_ROLE = $role; $env:RLS_GUC_ENABLED = 'true'; $env:SCHEDULER_ENABLED = 'false'; $env:NODE_ENV = 'test'
  $env:EVIDENCE_IMAGE_DIGEST = $digest; $env:EVIDENCE_CPU = [string]$ApiCpu; $env:EVIDENCE_MEMORY = [string]($ApiMemoryMiB * 1048576); $env:EVIDENCE_SOURCE_REVISION = $imageRevision
  $env:PAPERWORK_SCENARIO = 'split'; $env:PAPERWORK_LIVE_PROVIDER = '0'
  $env:AWS_EC2_METADATA_DISABLED = 'true'; $env:MYDESK_AI_IMPORT_MODEL = 'claude-opus-5-5'; $env:ANTHROPIC_API_KEY = $null
  $env:MYDESK_MODE = 'on'; $env:MYDESK_AI_IMPORT_MODE = 'on'; $env:MYDESK_IMPORT_PIPELINE_VERSION = '2'; $env:MYDESK_IMPORT_PIPELINE_WIDTH = '2'; $env:STUDENT_INFORMATION_AI_IMPORT_MODE = 'off'
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
  $workerEnvironment = @(); foreach ($name in $names | Where-Object { $_ -notin @('POSTGRES_PASSWORD','POSTGRES_DB','ANTHROPIC_API_KEY','ADMIN_DATABASE_URL','SCHEDULER_ENABLED','EVIDENCE_CPU','EVIDENCE_MEMORY') }) { $workerEnvironment += @('-e',$name) }
  docker run -d --name $workerContainer --network "container:$dbContainer" --memory "${WorkerMemoryMiB}m" --memory-swap "${WorkerMemoryMiB}m" --cpus ([string]$WorkerCpu) --pids-limit 128 --read-only --tmpfs /tmp:rw,nosuid,size=128m --mount "type=bind,source=$root,target=/app/evidence" @workerEnvironment -e SCHEDULER_ENABLED=true -e "EVIDENCE_CPU=$WorkerCpu" -e "EVIDENCE_MEMORY=$($WorkerMemoryMiB * 1048576)" $ImageReference node /app/evidence/split-worker.mjs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Exact-image worker start failed.' }; $workerCreated = $true
  $workerReady = $false
  for ($i=0; $i -lt 30; $i++) { docker exec $workerContainer node -e "fetch('http://127.0.0.1:3999/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { $workerReady=$true; break }; Start-Sleep -Milliseconds 500 }
  if (-not $workerReady) { docker logs $workerContainer *> (Join-Path $root 'split-worker.log'); throw 'Synthetic worker RPC did not start.' }
  docker create --name $appContainer --network "container:$dbContainer" --memory "${ApiMemoryMiB}m" --memory-swap "${ApiMemoryMiB}m" --cpus ([string]$ApiCpu) --pids-limit 128 --read-only --tmpfs /tmp:rw,nosuid,size=128m --mount "type=bind,source=$root,target=/app/evidence" @environmentArgs $ImageReference node --test --test-concurrency=1 /app/evidence/split.test.mjs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Exact-image API create failed.' }; $appCreated = $true
  docker start $appContainer | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Exact-image API start failed.' }
  $controllerAbort = $null
  while ($true) {
    $apiState = docker inspect $appContainer --format '{{json .State}}' | ConvertFrom-Json -DateKind String
    if (-not $apiState.Running) { break }
    $workerProgress = docker inspect $workerContainer --format '{{json .State}}' | ConvertFrom-Json -DateKind String
    if (-not $workerProgress.Running -and $workerProgress.ExitCode -ne 0) { $controllerAbort='WORKER_EXIT_NONZERO'; docker stop --time 2 $appContainer | Out-Null; break }
    if ([DateTimeOffset]::UtcNow -ge $deadline) { $controllerAbort='CONTROLLER_15_MINUTE_DEADLINE'; docker stop --time 2 $appContainer | Out-Null; break }
    Start-Sleep -Milliseconds 1000
  }
  docker logs $appContainer *> (Join-Path $root 'split.tap.log')
  $apiImage = docker inspect $appContainer --format '{{.Image}}'; $workerImage = docker inspect $workerContainer --format '{{.Image}}'
  if ($apiImage -cne $identity.Id -or $workerImage -cne $identity.Id) { throw 'Running containers differ from the pinned image ID.' }
  $result = docker inspect $appContainer --format '{{json .State}}' | ConvertFrom-Json -DateKind String
  $exitCode = [int]$result.ExitCode
  $workerState = docker inspect $workerContainer --format '{{json .State}}' | ConvertFrom-Json -DateKind String
  if ($workerState.Running) { docker stop --time 2 $workerContainer | Out-Null; $workerState = docker inspect $workerContainer --format '{{json .State}}' | ConvertFrom-Json -DateKind String }
  docker logs $workerContainer *> (Join-Path $root 'split-worker.log')
  if ($result.OOMKilled -or $workerState.OOMKilled -or $controllerAbort -or $workerState.ExitCode -ne 0) { $exitCode = 1 }
  [ordered]@{version=2;processingVersion=2;pipelineWidth=2;sourceIdentity=$sourceIdentity;runId=$runId;startedAt=$started;finishedAt=[DateTimeOffset]::UtcNow.ToString('o');imageDigest=$digest;imageRevision=$imageRevision;harnessRevision=$harnessRevision;apiInspectedImageId=$apiImage;workerInspectedImageId=$workerImage;apiCpu=$ApiCpu;apiMemoryMiB=$ApiMemoryMiB;workerCpu=$WorkerCpu;workerMemoryMiB=$WorkerMemoryMiB;apiState=$result;workerState=$workerState;controllerAbort=$controllerAbort;exitCode=$exitCode;storage='physical_local_files';provider='synthetic_transport';network='internal_no_external_access';database='schema_only_fresh_tmpfs';productionMutations=0;description='Separate pinned-image API and worker; actual v2 claims; ordinary HTTP uploads; no exposed ports or serving task changes'} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $root 'split-execution.json') -Encoding utf8
} finally {
  $cleanupSucceeded = $true
  if ($appCreated) { docker rm -f $appContainer | Out-Null; if ($LASTEXITCODE -ne 0) { $cleanupSucceeded = $false } }
  if ($workerCreated) { docker rm -f $workerContainer | Out-Null; if ($LASTEXITCODE -ne 0) { $cleanupSucceeded = $false } }
  if ($dbCreated) { docker rm -f $dbContainer | Out-Null; if ($LASTEXITCODE -ne 0) { $cleanupSucceeded = $false } }
  if ($networkCreated) { docker network rm $network | Out-Null; if ($LASTEXITCODE -ne 0) { $cleanupSucceeded = $false } }
  foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
  $appPassword = $null
  $ownedRemaining = @(docker ps -a --filter "name=$network" --format '{{.Names}}')
  if ($LASTEXITCODE -ne 0) { $cleanupSucceeded = $false }
  $ownedNetworkRemaining = @(docker network ls --filter "name=$network" --format '{{.Name}}')
  if ($LASTEXITCODE -ne 0) { $cleanupSucceeded = $false }
  $cleanupComplete = $cleanupSucceeded -and $ownedRemaining.Count -eq 0 -and $ownedNetworkRemaining.Count -eq 0
  if (-not $cleanupComplete) { $exitCode = 1 }
  [ordered]@{runId=$runId;containersRemaining=$ownedRemaining;networksRemaining=$ownedNetworkRemaining;commandsSucceeded=$cleanupSucceeded;complete=$cleanupComplete} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'split-cleanup.json') -Encoding utf8
}
Write-Output "Isolated paperwork capacity exit=$exitCode evidence=$root"
exit $exitCode
