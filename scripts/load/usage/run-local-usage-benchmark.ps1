param(
  [ValidatePattern('^schoolpilot_redesign_usage_[a-z0-9_]+$')][string]$SchemaDatabase = 'schoolpilot_redesign_usage_20260930',
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$repository = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
if ($output.Equals($repository, [StringComparison]::OrdinalIgnoreCase) -or $output.StartsWith($repository + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Choose an external evidence directory.' }
New-Item -ItemType Directory -Path $output -Force | Out-Null
$run = [guid]::NewGuid().ToString('N').Substring(0,12)
$database = 'schoolpilot_redesign_usage_capacity_' + $run
$fixtureRole = 'usage_fixture_' + $run; $appRole = 'usage_app_' + $run
$fixturePassword = [guid]::NewGuid().ToString('N'); $appPassword = [guid]::NewGuid().ToString('N')
$names = @('DATABASE_URL','ADMIN_DATABASE_URL','DATABASE_URL_PRIVILEGED','JWT_SECRET','SESSION_SECRET','NODE_ENV','REDIS_URL','RLS_GUC_ENABLED','RLS_ENABLED_TABLES','SCHEDULER_ENABLED','USAGE_LOCAL_BENCHMARK','USAGE_BENCHMARK_OUTPUT','USAGE_SOURCE_REVISION','CLASSPILOT_USAGE_ROLLUP_MODE','CLASSPILOT_DIGITAL_USAGE_MODE','DB_POOL_MIN','SESSION_DB_POOL_MIN')
$saved = @{}; foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
$created = $false; $rolesCreated = $false; $exitCode = 1
Push-Location -LiteralPath $repository
try {
  if ((git status --porcelain).Length -gt 0) { throw 'Commit the source and harness before collecting source-bound evidence.' }
  $env:USAGE_SOURCE_REVISION = (git rev-parse HEAD).Trim()
  npm run build *> (Join-Path $output 'build.log')
  if ($LASTEXITCODE -ne 0) { throw 'Plain backend build failed; see build.log.' }
  docker exec schoolpilot-db psql -U schoolpilot -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $database;" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Fresh local fixture database creation failed.' }; $created = $true
  $schema = Join-Path $output 'schema-only.sql'
  docker exec schoolpilot-db pg_dump -U schoolpilot -d $SchemaDatabase --schema-only --no-owner --no-privileges | Set-Content -LiteralPath $schema -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw 'Local schema-only export failed.' }
  Get-Content -LiteralPath $schema -Raw | docker exec -i schoolpilot-db psql -U schoolpilot -d $database -v ON_ERROR_STOP=1 *> (Join-Path $output 'schema-restore.log')
  if ($LASTEXITCODE -ne 0) { throw 'Local schema-only restore failed.' }
  $rolesCreated = $true # Also clean up if the multi-statement creation stops partway through.
  "CREATE ROLE $fixtureRole LOGIN SUPERUSER PASSWORD '$fixturePassword'; CREATE ROLE $appRole LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '$appPassword'; GRANT USAGE ON SCHEMA public TO $appRole; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO $appRole; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO $appRole;" | docker exec -i schoolpilot-db psql -U schoolpilot -d $database -v ON_ERROR_STOP=1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Disposable fixture/application role creation failed.' }
  $env:DATABASE_URL = "postgresql://${appRole}:${appPassword}@127.0.0.1:5435/$database"
  $env:ADMIN_DATABASE_URL = "postgresql://${fixtureRole}:${fixturePassword}@127.0.0.1:5435/$database"
  $env:DATABASE_URL_PRIVILEGED = $env:DATABASE_URL
  $env:JWT_SECRET = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'); $env:SESSION_SECRET = $env:JWT_SECRET
  $env:NODE_ENV = 'test'; $env:REDIS_URL = ''; $env:RLS_GUC_ENABLED = 'true'; $env:SCHEDULER_ENABLED = 'false'
  $registry = Get-Content -LiteralPath src/config/rlsRegistry.json -Raw | ConvertFrom-Json
  $env:RLS_ENABLED_TABLES = $registry.inventories.classpilotUsageRollupDaysPostExpand.tables -join ','
  $env:CLASSPILOT_USAGE_ROLLUP_MODE = 'on'; $env:CLASSPILOT_DIGITAL_USAGE_MODE = 'on'
  $env:DB_POOL_MIN = '0'; $env:SESSION_DB_POOL_MIN = '0'
  $env:USAGE_LOCAL_BENCHMARK = '1'; $env:USAGE_BENCHMARK_OUTPUT = Join-Path $output 'usage-benchmark.json'
  docker inspect schoolpilot-db --format '{{json .HostConfig}}' | Set-Content -LiteralPath (Join-Path $output 'local-database-host-config.json') -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw 'Local database resource evidence failed.' }
  node --import ./tests/test-environment.mjs scripts/load/usage/local-usage-benchmark.mjs *> (Join-Path $output 'benchmark.log')
  $exitCode = $LASTEXITCODE
  Get-Content -LiteralPath (Join-Path $output 'benchmark.log') | Where-Object { $_ -match '"event":"local_usage_benchmark_' }
  [ordered]@{ sourceRevision=$env:USAGE_SOURCE_REVISION; schemaSource=$SchemaDatabase; schemaOnly=$true; schemaSha256=(Get-FileHash -LiteralPath $schema -Algorithm SHA256).Hash.ToLower(); database=$database; restrictedRole=$true; productionMutations=0; exitCode=$exitCode; limits='Shared local Docker database has no production CPU/memory/I/O guarantee; application and driver share one local process' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'execution.json') -Encoding utf8
} finally {
  # Only the freshly generated database and roles from this run may be removed.
  if ($created) {
    if ($database -cnotmatch '^schoolpilot_redesign_usage_capacity_[a-f0-9]{12}$') { throw 'Fixture cleanup database guard failed.' }
    docker exec schoolpilot-db psql -U schoolpilot -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE $database WITH (FORCE);" | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Error 'Disposable fixture database cleanup failed.' }
  }
  if ($rolesCreated) {
    docker exec schoolpilot-db psql -U schoolpilot -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS $appRole; DROP ROLE IF EXISTS $fixtureRole;" | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Error 'Disposable fixture roles cleanup failed.' }
  }
  foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
  Pop-Location
}
exit $exitCode
