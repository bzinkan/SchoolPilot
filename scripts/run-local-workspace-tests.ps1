param(
  [Parameter(Mandatory = $true)][ValidatePattern('^schoolpilot_redesign_[a-z0-9_]+$')][string]$Database,
  [Parameter(Mandatory = $true)][string[]]$TestFiles,
  [switch]$Restricted
)
$ErrorActionPreference = 'Stop'
$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
foreach ($file in $TestFiles) {
  $resolved = [System.IO.Path]::GetFullPath((Join-Path $workspace $file))
  $testsRoot = [System.IO.Path]::GetFullPath((Join-Path $workspace 'tests')) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $resolved.StartsWith($testsRoot, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $resolved) -or $resolved -notmatch '\.test\.(ts|mjs)$') {
    throw 'Choose existing repository test files only.'
  }
}
# This helper is intentionally bound to the repository's local Docker database.
# Never read cloud secrets or change the established development role password.
$exists = docker exec schoolpilot-db psql -U schoolpilot -d postgres -At -v ON_ERROR_STOP=1 -c "SELECT 1 FROM pg_database WHERE datname='$Database';"
if ($LASTEXITCODE -ne 0) { throw 'The local Docker database is unavailable.' }
if ($exists -ne '1') {
  docker exec schoolpilot-db psql -U schoolpilot -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $Database TEMPLATE schoolpilot_workspace_integration_20260926;"
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated test database.' }
}
$role = 'codex_workspace_fixture_' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$password = [guid]::NewGuid().ToString('N')
$appRole = 'codex_workspace_rls_' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$appPassword = [guid]::NewGuid().ToString('N')
$saved = @{}
foreach ($name in @('DATABASE_URL','ADMIN_DATABASE_URL','JWT_SECRET','SESSION_SECRET','RLS_GUC_ENABLED','RLS_ENABLED_TABLES','RLS_TEST_ROLE')) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$exitCode = 1
try {
  # A disposable local migration/fixture role; its password never enters output.
  "CREATE ROLE $role LOGIN SUPERUSER PASSWORD '$password';" | docker exec -i schoolpilot-db psql -U schoolpilot -d $Database -v ON_ERROR_STOP=1
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the local fixture role.' }
  $env:DATABASE_URL = 'postgresql://' + $role + ':' + $password + '@127.0.0.1:5435/' + $Database
  $env:ADMIN_DATABASE_URL = $env:DATABASE_URL
  $env:JWT_SECRET = 'synthetic-workspace-tests-local-only-key'
  $env:SESSION_SECRET = 'synthetic-workspace-tests-local-only-key'
  $env:RLS_GUC_ENABLED = 'false'
  if ($Restricted) {
    "CREATE ROLE $appRole LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '$appPassword'; GRANT USAGE ON SCHEMA public TO $appRole; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO $appRole; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO $appRole; ALTER DEFAULT PRIVILEGES FOR ROLE $role IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO $appRole;" | docker exec -i schoolpilot-db psql -U schoolpilot -d $Database -v ON_ERROR_STOP=1
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the restricted local application role.' }
    $registry = Get-Content -LiteralPath (Join-Path $workspace 'src/config/rlsRegistry.json') -Raw | ConvertFrom-Json
    $env:RLS_ENABLED_TABLES = $registry.inventories.importProcessingStagesPostExpand.tables -join ','
    $env:RLS_GUC_ENABLED = 'true'
    $env:RLS_TEST_ROLE = $appRole
    $env:DATABASE_URL = 'postgresql://' + $appRole + ':' + $appPassword + '@127.0.0.1:5435/' + $Database
  }
  Push-Location -LiteralPath $workspace
  try {
    & node --import ./tests/test-environment.mjs --import tsx --test --test-concurrency=1 @TestFiles
    $exitCode = $LASTEXITCODE
  } finally { Pop-Location }
} finally {
  if ($Restricted) {
    "ALTER DEFAULT PRIVILEGES FOR ROLE $role IN SCHEMA public REVOKE ALL ON TABLES FROM $appRole; DROP OWNED BY $appRole; DROP ROLE $appRole;" | docker exec -i schoolpilot-db psql -U schoolpilot -d $Database -v ON_ERROR_STOP=1
    if ($LASTEXITCODE -ne 0) { Write-Error 'The restricted local application role could not be cleaned up.' }
  }
  # Fresh migration functions may be owned by the disposable role. Transfer only
  # this role's objects within this isolated database before removing the login.
  "REASSIGN OWNED BY $role TO schoolpilot; DROP ROLE $role;" | docker exec -i schoolpilot-db psql -U schoolpilot -d $Database -v ON_ERROR_STOP=1
  if ($LASTEXITCODE -ne 0) { Write-Error 'The local fixture role could not be cleaned up.' }
  foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
}
exit $exitCode
