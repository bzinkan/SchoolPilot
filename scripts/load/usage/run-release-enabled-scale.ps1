#requires -Version 7.5
[CmdletBinding()]
param(
  [ValidatePattern('^schoolpilot_redesign_usage_[a-z0-9_]+$')][string]$SchemaDatabase = 'schoolpilot_redesign_usage_20260930',
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [ValidateSet('combined','ingest','reports','worker','preflight')][string]$Phase = 'combined',
  [switch]$DiagnosticOnly
)
$ErrorActionPreference = 'Stop'
function Assert-LocalDockerEndpoint {
  param([string]$Endpoint)
  # A pipe must address this machine. Refuse TCP/SSH and UNC remote pipes,
  # including loopback TCP tunnels: loopback published ports are not proof.
  if ($Endpoint -cnotmatch '^npipe:/{2,4}\./pipe/[a-zA-Z0-9_.-]+$' -and $Endpoint -cnotmatch '^unix:///[^\s?#]+$') {
    throw 'Load fixtures require a local named-pipe or Unix-socket Docker daemon.'
  }
}
$dockerExecutable = (Get-Command docker -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$requestedDockerContext = ($env:DOCKER_CONTEXT ?? '').Trim()
$requestedDockerHost = ($env:DOCKER_HOST ?? '').Trim()
$Profile = 'cold-open-loop-ai'
$RlsInventory = 'classpilotPrivateChatLifecyclePostExpand'
$PrepareOnly = $false
$HoldFixtureForDiagnostics = $false
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$RlsInventory = @('classpilotUsageRollupDaysPostExpand','passpilotAppointmentsPostExpand','classpilotPrivateChatLifecyclePostExpand' | Where-Object { $_ -ieq $RlsInventory })[0]
$registryPath = Join-Path $repository 'src/config/rlsRegistry.json'
$registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json -DateKind String
$selectedInventory = $registry.inventories.$RlsInventory
if ($null -eq $selectedInventory -or $null -eq $selectedInventory.tables) { throw 'Requested inventory is missing from this source; no fixture will be created.' }
$registrySha256 = (Get-FileHash -LiteralPath $registryPath -Algorithm SHA256).Hash.ToLower()
$output = [IO.Path]::GetFullPath($OutputDirectory)
if ($output.Equals($repository, [StringComparison]::OrdinalIgnoreCase) -or $output.StartsWith($repository + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Choose an external evidence directory.' }
node (Join-Path $PSScriptRoot 'assert-fresh-evidence-directory.mjs') $output
if ($LASTEXITCODE -ne 0) { throw 'Choose a fresh empty evidence directory; existing artifacts will not be overwritten.' }
New-Item -ItemType Directory -Path $output -Force | Out-Null
$run = [guid]::NewGuid().ToString('N').Substring(0,12)
$container = 'schoolpilot-usage-scale-' + $run
$database = 'schoolpilot_redesign_usage_scale_' + $run
$fixtureRole = 'scale_fixture_' + $run; $appRole = 'scale_app_' + $run
$fixturePassword = [guid]::NewGuid().ToString('N'); $appPassword = [guid]::NewGuid().ToString('N')
$names = @('DATABASE_URL','ADMIN_DATABASE_URL','DATABASE_URL_PRIVILEGED','JWT_SECRET','SESSION_SECRET','STUDENT_TOKEN_SECRET','NODE_ENV','REDIS_URL','RLS_GUC_ENABLED','RLS_ENABLED_TABLES','SCHEDULER_ENABLED','USAGE_LOCAL_SCALE','USAGE_SCALE_OUTPUT','USAGE_SCALE_CAPS','USAGE_SCALE_CONTAINER','USAGE_SOURCE_REVISION','USAGE_SCALE_PREPARE_ONLY','USAGE_SCALE_COLD_PHASE','USAGE_SCALE_COLD_STATE','USAGE_SCALE_COLD_STATE_SHA256','CLASSPILOT_USAGE_ROLLUP_MODE','CLASSPILOT_DIGITAL_USAGE_MODE','DB_POOL_MIN','SESSION_DB_POOL_MIN','USAGE_SCALE_RLS_INVENTORY','RUN_LEGACY_MIGRATIONS_ONLY','RUN_MIGRATIONS_ONLY','CLASSPILOT_DAILY_USAGE_ROLLUP_MODE','CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE','PASSPILOT_RULES_MODE','PASSPILOT_APPOINTMENTS_MODE','PASSPILOT_REPORTS_MODE','CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1','CLASSPILOT_CAP_FOCUS_TAB_V1','CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1','CLASSPILOT_CAPABILITY_ROLLOUTS_JSON')
$saved = @{}; foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
$redisContainer = 'schoolpilot-usage-redis-' + $run
$created = $false; $redisCreated = $false; $exitCode = 1
$names += @('USAGE_RELEASE_PHASE','USAGE_RELEASE_DIAGNOSTIC','DOTENV_CONFIG_PATH','DOTENV_CONFIG_QUIET','DOCKER_CONTEXT','DOCKER_HOST','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','DOCKER_TLS')
foreach ($name in @('USAGE_RELEASE_PHASE','USAGE_RELEASE_DIAGNOSTIC','DOTENV_CONFIG_PATH','DOTENV_CONFIG_QUIET','DOCKER_CONTEXT','DOCKER_HOST','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','DOCKER_TLS')) { $saved[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
Push-Location -LiteralPath $repository
try {
  # Context metadata is local. Pin its validated endpoint before the first
  # daemon operation, then remove inherited selectors/TLS overrides.
  $selectedDockerContext = $requestedDockerContext
  if (-not $selectedDockerContext -and $requestedDockerHost) {
    $pinnedDockerHost = $requestedDockerHost
  } else {
    if (-not $selectedDockerContext) {
      $selectedDockerContext = (& $dockerExecutable context show).Trim()
      if ($LASTEXITCODE -ne 0) { throw 'Docker context selection failed.' }
    }
    if ($selectedDockerContext -cnotmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$') { throw 'Invalid Docker context name.' }
    $contexts = @(& $dockerExecutable context inspect $selectedDockerContext | ConvertFrom-Json -DateKind String)
    if ($LASTEXITCODE -ne 0 -or $contexts.Count -ne 1 -or $contexts[0].Name -cne $selectedDockerContext) { throw 'Docker context metadata verification failed.' }
    $pinnedDockerHost = $contexts[0].Endpoints.docker.Host
  }
  Assert-LocalDockerEndpoint $pinnedDockerHost
  foreach ($name in @('DOCKER_CONTEXT','DOCKER_HOST','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','DOCKER_TLS')) { [Environment]::SetEnvironmentVariable($name,$null,'Process') }
  [ordered]@{ context=$selectedDockerContext; endpoint=$pinnedDockerHost; pinnedForEveryAction=$true } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'local-docker-daemon.json') -Encoding utf8
  if (-not $DiagnosticOnly -and (git status --porcelain).Length -gt 0) { throw 'Commit source and harness before collecting evidence.' }
  $env:USAGE_SOURCE_REVISION = (git rev-parse HEAD).Trim()
  $env:DOTENV_CONFIG_PATH = Join-Path $output 'intentionally-absent-dotenv'; $env:DOTENV_CONFIG_QUIET = 'true'
  $env:USAGE_RELEASE_PHASE = $Phase; $env:USAGE_RELEASE_DIAGNOSTIC = if ($DiagnosticOnly) { 'true' } else { 'false' }
  npm run build *> (Join-Path $output 'build.log')
  if ($LASTEXITCODE -ne 0) { throw 'Plain backend build failed; see build.log.' }
  $schema = Join-Path $output 'schema-only.sql'
  & $dockerExecutable --host $pinnedDockerHost exec schoolpilot-db pg_dump -U schoolpilot -d $SchemaDatabase --schema-only --no-owner --no-privileges | Set-Content -LiteralPath $schema -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw 'Read-only local schema export failed.' }
  $image = (& $dockerExecutable --host $pinnedDockerHost inspect schoolpilot-db --format '{{.Image}}').Trim()
  if ($LASTEXITCODE -ne 0 -or $image -cnotmatch '^sha256:[a-f0-9]{64}$') { throw 'Existing local PostgreSQL image lookup failed.' }
  # The random name, run ownership label and loopback-only port are verified
  # again before cleanup. No shared local container quota or volume is changed.
  & $dockerExecutable --host $pinnedDockerHost run --detach --name $container --label "codex.usage-scale=$run" --cpus 4 --memory 4g --memory-swap 4g --publish '127.0.0.1:5437:5432' --env "POSTGRES_DB=$database" --env "POSTGRES_USER=$fixtureRole" --env "POSTGRES_PASSWORD=$fixturePassword" $image *> (Join-Path $output 'container-create.log')
  $createStatus = $LASTEXITCODE
  $creationIdentity = & $dockerExecutable --host $pinnedDockerHost inspect $container --format '{{json .Config.Labels}}' 2>$null
  if ($LASTEXITCODE -eq 0 -and ($creationIdentity | ConvertFrom-Json -DateKind String).'codex.usage-scale' -ceq $run) { $created = $true }
  if ($createStatus -ne 0 -or -not $created) { throw 'Dedicated local capped container creation failed.' }
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    # The image's initialization server accepts Unix sockets before restarting.
    # Require TCP readiness so schema restore waits for the final server.
    & $dockerExecutable --host $pinnedDockerHost exec $container pg_isready -h 127.0.0.1 -p 5432 -U $fixtureRole -d $database *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { throw 'Dedicated local database did not become ready.' }
  $identity = & $dockerExecutable --host $pinnedDockerHost inspect $container --format '{{json .Config.Labels}}' | ConvertFrom-Json -DateKind String
  if ($LASTEXITCODE -ne 0 -or $identity.'codex.usage-scale' -cne $run) { throw 'Generated container ownership mismatch.' }
  $ports = & $dockerExecutable --host $pinnedDockerHost inspect $container --format '{{json .NetworkSettings.Ports}}' | ConvertFrom-Json -DateKind String
  if ($ports.'5432/tcp'[0].HostIp -cne '127.0.0.1' -or $ports.'5432/tcp'[0].HostPort -cne '5437') { throw 'Fixture must publish only the approved loopback port.' }
  & $dockerExecutable --host $pinnedDockerHost inspect $container --format '{{json .HostConfig}}' | Set-Content -LiteralPath (Join-Path $output 'resource-caps.json') -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw 'Resource cap evidence failed.' }
  Get-Content -LiteralPath $schema -Raw | & $dockerExecutable --host $pinnedDockerHost exec -i $container psql -U $fixtureRole -d $database -v ON_ERROR_STOP=1 *> (Join-Path $output 'schema-restore.log')
  if ($LASTEXITCODE -ne 0) { throw 'Dedicated schema-only restore failed.' }
  "CREATE ROLE $appRole LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '$appPassword'; GRANT USAGE ON SCHEMA public TO $appRole; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO $appRole; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO $appRole;" | & $dockerExecutable --host $pinnedDockerHost exec -i $container psql -U $fixtureRole -d $database -v ON_ERROR_STOP=1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Restricted non-owner role creation failed.' }
  $env:DATABASE_URL = "postgresql://${appRole}:${appPassword}@127.0.0.1:5437/$database"
  $env:ADMIN_DATABASE_URL = "postgresql://${fixtureRole}:${fixturePassword}@127.0.0.1:5437/$database"
  $env:DATABASE_URL_PRIVILEGED = $env:DATABASE_URL
  $env:JWT_SECRET = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'); $env:SESSION_SECRET = $env:JWT_SECRET; $env:STUDENT_TOKEN_SECRET = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
  $env:NODE_ENV = 'test'; $env:REDIS_URL = ''; $env:RLS_GUC_ENABLED = 'true'; $env:SCHEDULER_ENABLED = 'false'
  $env:RLS_ENABLED_TABLES = $selectedInventory.tables -join ','
  $env:USAGE_SCALE_RLS_INVENTORY = $RlsInventory
  $env:CLASSPILOT_USAGE_ROLLUP_MODE = 'on'; $env:CLASSPILOT_DIGITAL_USAGE_MODE = 'on'
  if ($RlsInventory -cne 'classpilotUsageRollupDaysPostExpand') {
    # Freeze new combined capabilities off only in this owned child fixture.
    # Daily usage is an existing shadow-default scheduler; it is disabled by
    # SCHEDULER_ENABLED=false, not by the ineffective daily-mode value off.
    $env:CLASSPILOT_DAILY_USAGE_ROLLUP_MODE = 'shadow'
    $env:CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE = 'off'; $env:PASSPILOT_RULES_MODE = 'off'
    $env:PASSPILOT_APPOINTMENTS_MODE = 'off'; $env:PASSPILOT_REPORTS_MODE = 'off'
    $env:CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1 = 'false'; $env:CLASSPILOT_CAP_FOCUS_TAB_V1 = 'false'
    $env:CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = '{"preciseRestrictionResourcesV1":{"mode":"off"},"focusTabV1":{"mode":"off"}}'
    if ($RlsInventory -ceq 'classpilotPrivateChatLifecyclePostExpand') {
      $env:CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1 = 'false'
      $env:CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = '{"preciseRestrictionResourcesV1":{"mode":"off"},"focusTabV1":{"mode":"off"},"privateChatLifecycleV1":{"mode":"off"}}'
    }
    # Combined-source verification reapplies the exact current contract in its
    # owned empty fixture before traffic, then restores the restricted app role.
    $applicationUrl = $env:DATABASE_URL
    $env:DATABASE_URL = $env:ADMIN_DATABASE_URL; $env:DATABASE_URL_PRIVILEGED = $env:ADMIN_DATABASE_URL
    $env:RUN_LEGACY_MIGRATIONS_ONLY = 'true'; $env:RUN_MIGRATIONS_ONLY = 'false'
    node dist/index.js *> (Join-Path $output 'fixture-legacy-convergence.log')
    if ($LASTEXITCODE -ne 0) { throw 'Complete current local legacy convergence failed.' }
    $env:RUN_LEGACY_MIGRATIONS_ONLY = 'false'; $env:RUN_MIGRATIONS_ONLY = 'true'
    node dist/index.js *> (Join-Path $output 'fixture-versioned-migrations.log')
    if ($LASTEXITCODE -ne 0) { throw 'Complete current local versioned migration/admission failed.' }
    $env:RUN_MIGRATIONS_ONLY = 'false'
    # Versioned expansion may create a new table after the initial restore.
    # Give this disposable non-owner role the same CRUD grants for all current
    # fixture tables; FORCE RLS and every constraint remain unchanged.
    "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO $appRole; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO $appRole;" | & $dockerExecutable --host $pinnedDockerHost exec -i $container psql -U $fixtureRole -d $database -v ON_ERROR_STOP=1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Complete current fixture grants failed.' }
    $env:DATABASE_URL = $applicationUrl; $env:DATABASE_URL_PRIVILEGED = $applicationUrl
  }
  # Preserve the actual post-convergence contract separately from the input
  # schema export. This empty-fixture snapshot is UTF8/LF before any traffic.
  $convergedSchema = Join-Path $output 'post-convergence-schema.sql'
  $convergedDdl = @(& $dockerExecutable --host $pinnedDockerHost exec $container pg_dump -U $fixtureRole -d $database --schema-only --no-owner --no-privileges)
  if ($LASTEXITCODE -ne 0) { throw 'Actual post-convergence schema snapshot failed.' }
  [IO.File]::WriteAllText($convergedSchema, ($convergedDdl -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
  $convergedSchemaSha256 = (Get-FileHash -LiteralPath $convergedSchema -Algorithm SHA256).Hash.ToLower()
  $canonicalSchemaSha256 = (node scripts/load/usage/release-schema-fingerprint.mjs $convergedSchema).Trim()
  if ($LASTEXITCODE -ne 0 -or $canonicalSchemaSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Canonical schema fingerprint failed.' }
  [ordered]@{ rawSha256=$convergedSchemaSha256; canonicalSha256=$canonicalSchemaSha256; normalization='UTF8/LF; remove only pg_dump restrict/unrestrict security nonce lines; preserve all DDL' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'schema-fingerprint.json') -Encoding utf8
  # The isolated API process performs the real16-client startup prewarm.
  # Do not set ineffective DB_POOL_MIN variables or increase any pool cap.
  $env:USAGE_LOCAL_SCALE = '1'; $env:USAGE_SCALE_OUTPUT = Join-Path $output 'usage-scale.json'
  $env:USAGE_SCALE_CAPS = Join-Path $output 'resource-caps.json'; $env:USAGE_SCALE_CONTAINER = $container
  $env:USAGE_SCALE_PREPARE_ONLY = if ($PrepareOnly) { '1' } else { '0' }
  # Windows PowerShell5 converts native stderr warnings to ErrorRecords.
  # Preserve them as evidence without aborting a successful running process.
  $strictPreference = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    $harness = switch ($Profile) {
      'school-day' { 'scripts/load/usage/local-school-day-scale.mjs' }
      'school-day-ai' { 'scripts/load/usage/local-school-day-ai-scale.mjs' }
      'cold-open-loop-ai' { 'scripts/load/usage/local-cold-open-loop-scale.mjs' }
      'stress' { 'scripts/load/usage/local-usage-scale.mjs' }
    }
    if ($Profile -ceq 'cold-open-loop-ai') {
      $env:USAGE_SCALE_COLD_PHASE = 'prepare'
      $env:USAGE_SCALE_COLD_STATE = Join-Path $output 'cold-fixture-state.json'
      $env:USAGE_SCALE_OUTPUT = Join-Path $output 'preparation-metrics.json'
      node scripts/load/usage/bounded-fixture-step.mjs 900000 --max-old-space-size=512 --import ./tests/test-environment.mjs $harness *> (Join-Path $output 'preparation.log')
      if ($LASTEXITCODE -ne 0) { throw 'Cold fixture preparation failed; measurement did not begin.' }
      $env:USAGE_SCALE_COLD_STATE_SHA256 = (Get-FileHash -LiteralPath $env:USAGE_SCALE_COLD_STATE -Algorithm SHA256).Hash.ToLower()
      if ($container -cnotmatch '^schoolpilot-usage-scale-[a-f0-9]{12}$' -or $container.Substring($container.Length-12) -cne $run -or
          $database -cne ('schoolpilot_redesign_usage_scale_' + $run)) { throw 'Cold restart target guard failed.' }
      $coldLabels = & $dockerExecutable --host $pinnedDockerHost inspect $container --format '{{json .Config.Labels}}' | ConvertFrom-Json -DateKind String
      if ($LASTEXITCODE -ne 0 -or $coldLabels.'codex.usage-scale' -cne $run) { throw 'Cold restart refused without exact run ownership.' }
      & $dockerExecutable --host $pinnedDockerHost restart $container *> (Join-Path $output 'cold-restart.log')
      if ($LASTEXITCODE -ne 0) { throw 'Owned cold PostgreSQL restart failed.' }
      $coldReady = $false
      for ($attempt = 0; $attempt -lt 30; $attempt++) {
        & $dockerExecutable --host $pinnedDockerHost exec $container pg_isready -h 127.0.0.1 -p 5432 -U $fixtureRole -d $database *> $null
        if ($LASTEXITCODE -eq 0) { $coldReady = $true; break }
        Start-Sleep -Milliseconds 500
      }
      if (-not $coldReady) { throw 'Cold restarted fixture did not become ready.' }
      & $dockerExecutable --host $pinnedDockerHost inspect $container --format '{{json .State}}' | Set-Content -LiteralPath (Join-Path $output 'cold-restarted-state.json') -Encoding utf8
      if ($LASTEXITCODE -ne 0) { throw 'Cold restart evidence failed.' }
      $env:USAGE_SCALE_COLD_PHASE = 'measure'; $env:USAGE_SCALE_OUTPUT = Join-Path $output 'usage-scale.json'
    }
    $redisImage = (& $dockerExecutable --host $pinnedDockerHost inspect schoolpilot-redis --format '{{.Image}}').Trim()
    if ($LASTEXITCODE -ne 0 -or $redisImage -cnotmatch '^sha256:[a-f0-9]{64}$') { throw 'Existing local Redis image lookup failed.' }
    & $dockerExecutable --host $pinnedDockerHost run --detach --name $redisContainer --label "codex.usage-scale=$run" --cpus 1 --memory 256m --memory-swap 256m --publish '127.0.0.1:6387:6379' $redisImage redis-server --save '' --appendonly no *> (Join-Path $output 'redis-create.log')
    $redisCreateStatus = $LASTEXITCODE
    $redisLabels = & $dockerExecutable --host $pinnedDockerHost inspect $redisContainer --format '{{json .Config.Labels}}' 2>$null
    if ($LASTEXITCODE -eq 0 -and ($redisLabels | ConvertFrom-Json -DateKind String).'codex.usage-scale' -ceq $run) { $redisCreated = $true }
    if ($redisCreateStatus -ne 0 -or -not $redisCreated) { throw 'Owned isolated Redis creation failed.' }
    $redisReady = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
      $ping = & $dockerExecutable --host $pinnedDockerHost exec $redisContainer redis-cli PING
      if ($LASTEXITCODE -eq 0 -and $ping -ceq 'PONG') { $redisReady = $true; break }
      Start-Sleep -Milliseconds 100
    }
    if (-not $redisReady) { throw 'Owned Redis did not become ready.' }
    $redisPorts = & $dockerExecutable --host $pinnedDockerHost inspect $redisContainer --format '{{json .NetworkSettings.Ports}}' | ConvertFrom-Json -DateKind String
    if ($redisPorts.'6379/tcp'[0].HostIp -cne '127.0.0.1' -or $redisPorts.'6379/tcp'[0].HostPort -cne '6387') { throw 'Redis must publish only the dedicated loopback port.' }
    $env:REDIS_URL = 'redis://127.0.0.1:6387'
    # Deliberately omit tests/test-environment.mjs: it would disable real Redis.
    node --max-old-space-size=512 scripts/load/usage/release-enabled-scale.mjs *> (Join-Path $output 'scale.log')
    $exitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $strictPreference }
  Get-Content -LiteralPath (Join-Path $output 'scale.log') | Where-Object { $_ -match '"event":"release_enabled_usage_complete' }
  [ordered]@{ sourceRevision=$env:USAGE_SOURCE_REVISION; workloadProfile='release-enabled-isolated-100rps-v1'; phase=$Phase; diagnosticOnly=[bool]$DiagnosticOnly; redisImageDigest=$redisImage; redisContainer=$redisContainer; rlsInventory=$RlsInventory; registrySha256=$registrySha256; admittedTables=$selectedInventory.tables.Count; currentFixtureMigrations=($RlsInventory -cne 'classpilotUsageRollupDaysPostExpand'); coldPostgresRestart=($Profile -ceq 'cold-open-loop-ai'); hostFilesystemCachesFlushed=$false; preparedStateSha256=$env:USAGE_SCALE_COLD_STATE_SHA256; schemaSource=$SchemaDatabase; schemaOnly=$true; schemaSha256=(Get-FileHash -LiteralPath $schema -Algorithm SHA256).Hash.ToLower(); inputSchemaSha256=(Get-FileHash -LiteralPath $schema -Algorithm SHA256).Hash.ToLower(); postConvergenceSchemaSha256=$convergedSchemaSha256; postConvergenceSchemaNormalization='UTF8/LF; no owner/grants; pg_dump nonce retained'; imageDigest=$image; container=$container; database=$database; restrictedNonOwnerRole=$true; postgresCpu=4; postgresMemoryBytes=4294967296; nodeOldSpaceMiB=512; productionMutations=0; exitCode=$exitCode } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'execution.json') -Encoding utf8
  if ($HoldFixtureForDiagnostics) {
    # This optional local-only hold permits read-only EXPLAIN work on the same
    # costly synthetic fixture. No credentials are persisted. Signal completion
    # using the external marker; expiry still runs the exact guarded cleanup.
    $marker = Join-Path $output 'diagnostics-complete.marker'
    $holdDeadline = [DateTime]::UtcNow.AddMinutes(30)
    Write-Output ([ordered]@{ event='local_usage_scale_diagnostic_hold'; container=$container; database=$database; fixtureRole=$fixtureRole; appRole=$appRole; marker=$marker; expiresAtUtc=$holdDeadline.ToString('o') } | ConvertTo-Json -Compress)
    while (-not (Test-Path -LiteralPath $marker) -and [DateTime]::UtcNow -lt $holdDeadline) { Start-Sleep -Milliseconds 500 }
  }
} finally {
  if ($redisCreated) {
    if ($redisContainer -cnotmatch '^schoolpilot-usage-redis-[a-f0-9]{12}$' -or $redisContainer.Substring($redisContainer.Length-12) -cne $run) { throw 'Redis cleanup target guard failed.' }
    $redisLabels = & $dockerExecutable --host $pinnedDockerHost inspect $redisContainer --format '{{json .Config.Labels}}' | ConvertFrom-Json -DateKind String
    if ($LASTEXITCODE -ne 0 -or $redisLabels.'codex.usage-scale' -cne $run) { throw 'Redis cleanup refused without ownership label.' }
    & $dockerExecutable --host $pinnedDockerHost stats $redisContainer --no-stream --format '{{json .}}' | Set-Content -LiteralPath (Join-Path $output 'redis-final-stats.json') -Encoding utf8
    & $dockerExecutable --host $pinnedDockerHost rm --force --volumes $redisContainer | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Error 'Owned Redis cleanup failed.' }
  }
  if ($created) {
    if ($container -cnotmatch '^schoolpilot-usage-scale-[a-f0-9]{12}$' -or $container.Substring($container.Length-12) -cne $run -or $database -cne ('schoolpilot_redesign_usage_scale_' + $run)) { throw 'Generated cleanup target guard failed.' }
    $labels = & $dockerExecutable --host $pinnedDockerHost inspect $container --format '{{json .Config.Labels}}' | ConvertFrom-Json -DateKind String
    if ($LASTEXITCODE -ne 0 -or $labels.'codex.usage-scale' -cne $run) { throw 'Cleanup refused without exact run ownership label.' }
    & $dockerExecutable --host $pinnedDockerHost inspect $container --format '{{json .State}}' | Set-Content -LiteralPath (Join-Path $output 'container-final-state.json') -Encoding utf8
    & $dockerExecutable --host $pinnedDockerHost stats $container --no-stream --format '{{json .}}' | Set-Content -LiteralPath (Join-Path $output 'container-final-stats.json') -Encoding utf8
    & $dockerExecutable --host $pinnedDockerHost rm --force --volumes $container | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Error 'Generated local fixture container/volume cleanup failed.' }
  }
  foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
  Pop-Location
}
exit $exitCode
