#requires -Version 7.5
# Owner-only acquisition. Never provisions or modifies MFA. Token codes are not argv/logs.
# Use a newly attached MFA device or a reviewed existing device.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$MfaSerial,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$AwsSha256,
    [string]$AwsPath = 'C:\Program Files\Amazon\AWSCLIV2\aws.exe',
    [string]$Profile = 'default'
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion -lt [Version]'7.5') { throw 'PowerShell 7.5 required.' }
. (Join-Path $PSScriptRoot '../../../private-permissions.ps1')
Assert-NoReparsePointInExistingPath -Path $OutputDirectory
if (-not [IO.Path]::IsPathRooted($OutputDirectory)) { throw 'Absolute private output directory required.' }
if (Test-IsPathWithin -Candidate $OutputDirectory -Parent (Resolve-Path (Join-Path $PSScriptRoot '../../../..')).Path) { throw 'Session material must remain outside Git.' }
Assert-PrivatePathPermissions -Path $OutputDirectory -Directory
if ($MfaSerial -notmatch '^arn:aws:iam::([0-9]{12}):mfa/[A-Za-z0-9+=,.@_/-]+$') { throw 'Exact IAM MFA device ARN required.' }
$accountId = $Matches[1]
$nonce = [Guid]::NewGuid().ToString('N')
Assert-NoReparsePointInExistingPath -Path $AwsPath
if ((Get-FileHash -LiteralPath $AwsPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $AwsSha256) { throw 'Reviewed AWS executable hash differs.' }
function Write-NewPrivateBytes([string]$Target, [byte[]]$Bytes) {
    $stream = [IO.File]::Open($Target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { Set-PrivatePathPermissions -Path $Target; $stream.Write($Bytes); $stream.Flush($true) } finally { $stream.Dispose() }
    Assert-PrivatePathPermissions -Path $Target
}
function Invoke-PrivateAws([string[]]$Arguments, [string]$Label) {
    $info = [Diagnostics.ProcessStartInfo]::new($AwsPath)
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    foreach ($argument in $Arguments) { [void]$info.ArgumentList.Add($argument) }
    # Endpoint URLs are explicit. Profile/global endpoint overrides are never used.
    [void]$info.ArgumentList.Add('--endpoint-url')
    [void]$info.ArgumentList.Add($(if ($Arguments[0] -eq 'iam') { 'https://iam.amazonaws.com' } else { 'https://sts.us-east-1.amazonaws.com' }))
    $info.Environment['AWS_PAGER'] = ''
    foreach ($key in @($info.Environment.Keys)) { if ($key -like 'AWS_ENDPOINT_URL*') { [void]$info.Environment.Remove($key) } }
    $process = [Diagnostics.Process]::Start($info)
    $stdoutTask = $process.StandardOutput.ReadToEndAsync(); $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(90000)) { $process.Kill($true); throw 'AWS acquisition timed out.' }
    $stdout = $stdoutTask.GetAwaiter().GetResult(); $stderr = $stderrTask.GetAwaiter().GetResult()
    Write-NewPrivateBytes (Join-Path $OutputDirectory "$nonce-$Label-stderr.txt") ([Text.Encoding]::UTF8.GetBytes($stderr))
    $target = Join-Path $OutputDirectory "$nonce-$Label.json"
    Write-NewPrivateBytes $target ([Text.Encoding]::UTF8.GetBytes($stdout))
    if ($process.ExitCode -ne 0) { throw 'AWS acquisition failed; inspect private receipts.' }
    return @{ Path = $target; Body = ($stdout | ConvertFrom-Json -DateKind String) }
}
$caller = Invoke-PrivateAws @('sts','get-caller-identity','--profile',$Profile,'--region','us-east-1','--output','json','--no-cli-pager') 'caller'
if ($caller.Body.Account -ne $accountId -or $caller.Body.Arn -notmatch ':user/([^/]+)$') { throw 'Exact IAM user/account required for this session acquisition path.' }
$userName = $Matches[1]
$devices = Invoke-PrivateAws @('iam','list-mfa-devices','--user-name',$userName,'--profile',$Profile,'--region','us-east-1','--output','json','--no-cli-pager') 'mfa-devices'
if (@($devices.Body.MFADevices | Where-Object SerialNumber -eq $MfaSerial).Count -ne 1) { throw 'MFA device is not attached to the caller; no session acquired.' }
$token = Read-Host 'Current six-digit MFA token (private input)' -AsSecureString
$requestPath = Join-Path $OutputDirectory "$nonce-transient-mfa-request.json"
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($token)
try {
    $code = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    if ($code -notmatch '^\d{6}$') { throw 'Six-digit MFA token required.' }
    $request = @{ DurationSeconds = 32400; SerialNumber = $MfaSerial; TokenCode = $code } | ConvertTo-Json -Compress
    Write-NewPrivateBytes $requestPath ([Text.Encoding]::UTF8.GetBytes($request))
    $session = Invoke-PrivateAws @('sts','get-session-token','--cli-input-json',"file://$requestPath",'--profile',$Profile,'--region','us-east-1','--output','json','--no-cli-pager') 'temporary-credentials'
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr); $code = $null; $request = $null; $token.Dispose()
    if ([IO.File]::Exists($requestPath)) { Remove-Item -LiteralPath $requestPath -Force }
}
$receipt = @{ schemaVersion = 1; kind = 'usage_linux_mfa_session'; accountId = $accountId; callerArn = $caller.Body.Arn; mfaSerial = $MfaSerial; acquiredAtUtc = [DateTime]::UtcNow.ToString('o'); expiresUtc = $session.Body.Credentials.Expiration; credentials = @{path = $session.Path; sha256 = (Get-FileHash -LiteralPath $session.Path -Algorithm SHA256).Hash.ToLowerInvariant()}; callerReceiptSha256 = (Get-FileHash -LiteralPath $caller.Path -Algorithm SHA256).Hash.ToLowerInvariant(); mfaDeviceReceiptSha256 = (Get-FileHash -LiteralPath $devices.Path -Algorithm SHA256).Hash.ToLowerInvariant() }
$receiptPath = Join-Path $OutputDirectory "$nonce-mfa-session-receipt.json"
Write-NewPrivateBytes $receiptPath ([Text.Encoding]::UTF8.GetBytes(($receipt | ConvertTo-Json -Depth 10)))
Write-Output "MFA session acquired; private receipt: $receiptPath"
