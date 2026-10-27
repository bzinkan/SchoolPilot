param(
  [ValidatePattern('^schoolpilot_redesign_native_demo_[a-z0-9_]+$')][string]$Database = 'schoolpilot_redesign_native_demo_clean_20261026',
  [ValidatePattern('^[a-z][a-z0-9_]+$')][string]$TemplateDatabase = 'schoolpilot_redesign_release297_ci_20261002',
  [ValidateRange(1024,65535)][int]$Port = 4100,
  [string]$PrivateDirectory = (Join-Path $env:LOCALAPPDATA 'ClassPilotDesktop\synthetic-demo')
)
$ErrorActionPreference = 'Stop'
$taskWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskPrivate = [IO.Path]::GetFullPath($PrivateDirectory)
if ($taskPrivate.StartsWith($taskWorkspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Private fixture output must be outside the repository.' }
New-Item -ItemType Directory -Path $taskPrivate -Force | Out-Null
$taskSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskPrincipal = '*' + $taskSid
& icacls $taskPrivate /inheritance:r /grant:r "${taskPrincipal}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict private fixture directory.' }
$taskExists = docker exec schoolpilot-db psql -U schoolpilot -d postgres -At -v ON_ERROR_STOP=1 -c "SELECT 1 FROM pg_database WHERE datname='$Database';"
if ($LASTEXITCODE -ne 0) { throw 'Start the existing local schoolpilot Docker services first.' }
if ($taskExists -ne '1') {
  docker exec schoolpilot-db psql -U schoolpilot -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $Database;"
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated local synthetic database.' }
  # Copy schema only: prior local fixture rows are not demo data and may
  # intentionally violate later contract-migration preconditions.
  docker exec schoolpilot-db pg_dump -U schoolpilot --schema-only --no-owner --no-privileges -d $TemplateDatabase |
    docker exec -i schoolpilot-db psql -U schoolpilot -d $Database -v ON_ERROR_STOP=1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the isolated local synthetic schema.' }
}
$taskTag = [guid]::NewGuid().ToString('N')
$taskAdminRole = 'native_bootstrap_' + $taskTag
$taskAppRole = 'native_demo_' + $taskTag
$taskAdminPassword = [guid]::NewGuid().ToString('N')
$taskAppPassword = [guid]::NewGuid().ToString('N')
$taskRedisInspect = (docker inspect schoolpilot-redis | ConvertFrom-Json)[0]
if ($LASTEXITCODE -ne 0) { throw 'The local Redis container is unavailable.' }
$taskRedisArguments = @($taskRedisInspect.Config.Cmd)
$taskRedisPasswordIndex = [Array]::IndexOf($taskRedisArguments, '--requirepass')
$taskRedisUrl = 'redis://127.0.0.1:6380'
if ($taskRedisPasswordIndex -ge 0) {
  $taskRedisPassword = [string]$taskRedisArguments[$taskRedisPasswordIndex + 1]
  $taskRedisUrl = 'redis://:' + [Uri]::EscapeDataString($taskRedisPassword) + '@127.0.0.1:6380'
}
"CREATE ROLE $taskAdminRole LOGIN SUPERUSER PASSWORD '$taskAdminPassword'; CREATE ROLE $taskAppRole LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '$taskAppPassword';" | docker exec -i schoolpilot-db psql -U schoolpilot -d $Database -v ON_ERROR_STOP=1
if ($LASTEXITCODE -ne 0) { throw 'Could not create isolated local roles.' }
$taskRegistry = Get-Content -LiteralPath (Join-Path $taskWorkspace 'src/config/rlsRegistry.json') -Raw | ConvertFrom-Json
$taskValues = @{
  DATABASE_URL = "postgresql://${taskAppRole}:${taskAppPassword}@127.0.0.1:5435/$Database"
  ADMIN_DATABASE_URL = "postgresql://${taskAdminRole}:${taskAdminPassword}@127.0.0.1:5435/$Database"
  NODE_ENV = 'development'; APP_ENV = 'development'; SCHEDULER_ENABLED = 'false'
  JWT_SECRET = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
  SESSION_SECRET = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
  STUDENT_TOKEN_SECRET = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
  COOKIE_NAME = 'schoolpilot.native.local.sid'; COOKIE_DOMAIN = ''
  GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
  RLS_GUC_ENABLED = 'true'; RLS_ENABLED_TABLES = $taskRegistry.inventories.classpilotNativeVisibilityPostExpand.tables -join ','
  REDIS_URL = $taskRedisUrl; REDIS_PREFIX = 'native-demo-' + $taskTag
  CORS_ALLOWLIST = 'http://127.0.0.1:5179,http://localhost:5179'
  PUBLIC_BASE_URL = "http://127.0.0.1:$Port"; CLIENT_URL = 'http://127.0.0.1:5179'
  NATIVE_DEMO_PORT = [string]$Port; NATIVE_DEMO_PRIVATE_DIR = $taskPrivate
  RUN_MIGRATIONS_ON_STARTUP = 'false'; SENDGRID_API_KEY = ''; TELEGRAM_BOT_TOKEN = ''; TELEGRAM_CHAT_ID = ''
  GEMINI_API_KEY = ''; ANTHROPIC_API_KEY = ''; SENTRY_DSN = ''
}
$taskSaved = @{}
$taskExit = 1
try {
  foreach ($taskName in $taskValues.Keys) {
    $taskSaved[$taskName] = [Environment]::GetEnvironmentVariable($taskName, 'Process')
    [Environment]::SetEnvironmentVariable($taskName, $taskValues[$taskName], 'Process')
  }
  Push-Location -LiteralPath $taskWorkspace
  try { & node --import tsx scripts/classpilot-native-local-demo.ts; $taskExit = $LASTEXITCODE }
  finally { Pop-Location }
} finally {
  "REASSIGN OWNED BY $taskAdminRole TO schoolpilot; DROP OWNED BY $taskAppRole; DROP ROLE $taskAppRole; DROP ROLE $taskAdminRole;" | docker exec -i schoolpilot-db psql -U schoolpilot -d $Database -v ON_ERROR_STOP=1
  foreach ($taskName in $taskSaved.Keys) { [Environment]::SetEnvironmentVariable($taskName, $taskSaved[$taskName], 'Process') }
}
exit $taskExit
