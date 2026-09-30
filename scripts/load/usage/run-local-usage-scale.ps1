param(
  [ValidatePattern('^schoolpilot_redesign_usage_[a-z0-9_]+$')][string]$SchemaDatabase = 'schoolpilot_redesign_usage_20260930',
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$output = [IO.Path]::GetFullPath($OutputDirectory)
if ($output.Equals($repository, [StringComparison]::OrdinalIgnoreCase) -or $output.StartsWith($repository + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Choose an external evidence directory.' }
New-Item -ItemType Directory -Path $output -Force | Out-Null
$run = [guid]::NewGuid().ToString('N').Substring(0,12)
$container = 'schoolpilot-usage-scale-' + $run
$database = 'schoolpilot_redesign_usage_scale_' + $run
$fixtureRole = 'scale_fixture_' + $run; $appRole = 'scale_app_' + $run
$fixturePassword = [guid]::NewGuid().ToString('N'); $appPassword = [guid]::NewGuid().ToString('N')
$names = @('DATABASE_URL','ADMIN_DATABASE_URL','DATABASE_URL_PRIVILEGED','JWT_SECRET','SESSION_SECRET','STUDENT_TOKEN_SECRET','NODE_ENV','REDIS_URL','RLS_GUC_ENABLED','RLS_ENABLED_TABLES','SCHEDULER_ENABLED','USAGE_LOCAL_SCALE','USAGE_SCALE_OUTPUT','USAGE_SCALE_CAPS','USAGE_SCALE_CONTAINER','USAGE_SOURCE_REVISION','CLASSPILOT_USAGE_ROLLUP_MODE','CLASSPILOT_DIGITAL_USAGE_MODE','DB_POOL_MIN','SESSION_DB_POOL_MIN')
$saved = @{}; foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
$created = $false; $exitCode = 1
Push-Location -LiteralPath $repository
try {
  if ((git status --porcelain).Length -gt 0) { throw 'Commit source and harness before collecting evidence.' }
  $env:USAGE_SOURCE_REVISION = (git rev-parse HEAD).Trim()
  npm run build *> (Join-Path $output 'build.log')
  if ($LASTEXITCODE -ne 0) { throw 'Plain backend build failed; see build.log.' }
  $schema = Join-Path $output 'schema-only.sql'
  docker exec schoolpilot-db pg_dump -U schoolpilot -d $SchemaDatabase --schema-only --no-owner --no-privileges | Set-Content -LiteralPath $schema -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw 'Read-only local schema export failed.' }
  $image = (docker inspect schoolpilot-db --format '{{.Image}}').Trim()
  if ($LASTEXITCODE -ne 0 -or $image -cnotmatch '^sha256:[a-f0-9]{64}$') { throw 'Existing local PostgreSQL image lookup failed.' }
  # The random name, run ownership label and loopback-only port are verified
  # again before cleanup. No shared local container quota or volume is changed.
  docker run --detach --name $container --label "codex.usage-scale=$run" --cpus 4 --memory 4g --memory-swap 4g --publish '127.0.0.1:5437:5432' --env "POSTGRES_DB=$database" --env "POSTGRES_USER=$fixtureRole" --env "POSTGRES_PASSWORD=$fixturePassword" $image *> (Join-Path $output 'container-create.log')
  $createStatus = $LASTEXITCODE
  $creationIdentity = docker inspect $container --format '{{json .Config.Labels}}' 2>$null
  if ($LASTEXITCODE -eq 0 -and ($creationIdentity | ConvertFrom-Json).'codex.usage-scale' -ceq $run) { $created = $true }
  if ($createStatus -ne 0 -or -not $created) { throw 'Dedicated local capped container creation failed.' }
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    docker exec $container pg_isready -U $fixtureRole -d $database *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { throw 'Dedicated local database did not become ready.' }
  $identity = docker inspect $container --format '{{json .Config.Labels}}' | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $identity.'codex.usage-scale' -cne $run) { throw 'Generated container ownership mismatch.' }
  $ports = docker inspect $container --format '{{json .NetworkSettings.Ports}}' | ConvertFrom-Json
  if ($ports.'5432/tcp'[0].HostIp -cne '127.0.0.1' -or $ports.'5432/tcp'[0].HostPort -cne '5437') { throw 'Fixture must publish only the approved loopback port.' }
  docker inspect $container --format '{{json .HostConfig}}' | Set-Content -LiteralPath (Join-Path $output 'resource-caps.json') -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw 'Resource cap evidence failed.' }
  Get-Content -LiteralPath $schema -Raw | docker exec -i $container psql -U $fixtureRole -d $database -v ON_ERROR_STOP=1 *> (Join-Path $output 'schema-restore.log')
  if ($LASTEXITCODE -ne 0) { throw 'Dedicated schema-only restore failed.' }
  "CREATE ROLE $appRole LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '$appPassword'; GRANT USAGE ON SCHEMA public TO $appRole; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO $appRole; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO $appRole;" | docker exec -i $container psql -U $fixtureRole -d $database -v ON_ERROR_STOP=1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Restricted non-owner role creation failed.' }
  $env:DATABASE_URL = "postgresql://${appRole}:${appPassword}@127.0.0.1:5437/$database"
  $env:ADMIN_DATABASE_URL = "postgresql://${fixtureRole}:${fixturePassword}@127.0.0.1:5437/$database"
  $env:DATABASE_URL_PRIVILEGED = $env:DATABASE_URL
  $env:JWT_SECRET = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'); $env:SESSION_SECRET = $env:JWT_SECRET; $env:STUDENT_TOKEN_SECRET = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
  $env:NODE_ENV = 'test'; $env:REDIS_URL = ''; $env:RLS_GUC_ENABLED = 'true'; $env:SCHEDULER_ENABLED = 'false'
  $registry = Get-Content -LiteralPath src/config/rlsRegistry.json -Raw | ConvertFrom-Json
  $env:RLS_ENABLED_TABLES = $registry.inventories.classpilotUsageRollupDaysPostExpand.tables -join ','
  $env:CLASSPILOT_USAGE_ROLLUP_MODE = 'on'; $env:CLASSPILOT_DIGITAL_USAGE_MODE = 'on'
  $env:DB_POOL_MIN = '0'; $env:SESSION_DB_POOL_MIN = '0'
  $env:USAGE_LOCAL_SCALE = '1'; $env:USAGE_SCALE_OUTPUT = Join-Path $output 'usage-scale.json'
  $env:USAGE_SCALE_CAPS = Join-Path $output 'resource-caps.json'; $env:USAGE_SCALE_CONTAINER = $container
  # Windows PowerShell5 converts native stderr warnings to ErrorRecords.
  # Preserve them as evidence without aborting a successful running process.
  $strictPreference = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    node --max-old-space-size=512 --import ./tests/test-environment.mjs scripts/load/usage/local-usage-scale.mjs *> (Join-Path $output 'scale.log')
    $exitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $strictPreference }
  Get-Content -LiteralPath (Join-Path $output 'scale.log') | Where-Object { $_ -match '"event":"local_usage_scale_' }
  [ordered]@{ sourceRevision=$env:USAGE_SOURCE_REVISION; schemaSource=$SchemaDatabase; schemaOnly=$true; schemaSha256=(Get-FileHash -LiteralPath $schema -Algorithm SHA256).Hash.ToLower(); imageDigest=$image; container=$container; database=$database; restrictedNonOwnerRole=$true; postgresCpu=4; postgresMemoryBytes=4294967296; nodeOldSpaceMiB=512; productionMutations=0; exitCode=$exitCode } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'execution.json') -Encoding utf8
} finally {
  if ($created) {
    if ($container -cnotmatch '^schoolpilot-usage-scale-[a-f0-9]{12}$' -or $container.Substring($container.Length-12) -cne $run -or $database -cne ('schoolpilot_redesign_usage_scale_' + $run)) { throw 'Generated cleanup target guard failed.' }
    $labels = docker inspect $container --format '{{json .Config.Labels}}' | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $labels.'codex.usage-scale' -cne $run) { throw 'Cleanup refused without exact run ownership label.' }
    docker inspect $container --format '{{json .State}}' | Set-Content -LiteralPath (Join-Path $output 'container-final-state.json') -Encoding utf8
    docker stats $container --no-stream --format '{{json .}}' | Set-Content -LiteralPath (Join-Path $output 'container-final-stats.json') -Encoding utf8
    docker rm --force --volumes $container | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Error 'Generated local fixture container/volume cleanup failed.' }
  }
  foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
  Pop-Location
}
exit $exitCode
