#requires -Version 7.5
[CmdletBinding()]
param(
    [ValidateSet('Plan', 'Apply', 'Rollback')][string]$Action = 'Plan',
    [string]$ConfigPath, [string]$OutDir, [string]$ManifestPath, [string]$ManifestHash,
    [string]$ApiArn, [string]$WorkerArn, [string]$ImageDigest, [string]$AppSha,
    [string]$DailyUsageEvidencePath, [switch]$Execute
)

# The only sanctioned production setter for the wave-1 product flags
# (docs/PRODUCT_RUNTIME_CONFIG_OPERATIONS.md). It reuses the reviewed AWS
# transport, private files, task cloning, operation fence (the same DynamoDB
# lease as the ClassPilot and My Desk tools, so one runtime-config operation
# runs at a time), autoscaling hold, health checks and exact convergence. It
# never invokes the capability workflow and writes no name outside the eight
# below: every other environment entry, secret and task field is fingerprinted
# and must survive each clone unchanged.
. "$PSScriptRoot/deploy-classpilot-runtime-config.ps1"
$script:ProductSchoolIdsName = 'CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS'
$script:ProductModeValues = [ordered]@{
    CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE = @('off', 'on')
    PASSPILOT_RULES_MODE = @('off', 'on')
    PASSPILOT_APPOINTMENTS_MODE = @('off', 'on')
    PASSPILOT_REPORTS_MODE = @('off', 'v2')
    # src/services/scheduler.ts dailyUsageRollupMode(): unset reads as shadow,
    # and `on` is the alias of set_based added by the PR 10a hardening.
    CLASSPILOT_DAILY_USAGE_ROLLUP_MODE = @('legacy', 'shadow', 'set_based', 'on')
    CLASSPILOT_USAGE_ROLLUP_MODE = @('off', 'on')
    CLASSPILOT_DIGITAL_USAGE_MODE = @('off', 'on')
}
$script:RuntimeEnvironmentNames = @('CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE', $script:ProductSchoolIdsName, 'PASSPILOT_RULES_MODE',
    'PASSPILOT_APPOINTMENTS_MODE', 'PASSPILOT_REPORTS_MODE', 'CLASSPILOT_DAILY_USAGE_ROLLUP_MODE', 'CLASSPILOT_USAGE_ROLLUP_MODE', 'CLASSPILOT_DIGITAL_USAGE_MODE')
$script:AllowedEnvironmentNames = @($script:RuntimeEnvironmentNames)
$script:AllowedSecretNames = @()
# These features' mode readers stay off unless their whole table bundle is RLS
# admitted on the task that reads them, so turning one on requires the same.
$script:ProductRlsGates = @(
    [pscustomobject]@{ Feature = 'passpilotRules'; Name = 'PASSPILOT_RULES_MODE'
        Tables = @('passpilot_destination_policies', 'passpilot_pass_limits', 'passpilot_encounter_restrictions', 'passpilot_pass_denials') },
    [pscustomobject]@{ Feature = 'passpilotAppointments'; Name = 'PASSPILOT_APPOINTMENTS_MODE'; Tables = @('passpilot_appointments') },
    [pscustomobject]@{ Feature = 'usageRollup'; Name = 'CLASSPILOT_USAGE_ROLLUP_MODE'; Tables = @('classpilot_usage_rollups', 'classpilot_usage_rollup_days') },
    [pscustomobject]@{ Feature = 'digitalUsage'; Name = 'CLASSPILOT_DIGITAL_USAGE_MODE'; Tables = @('classpilot_usage_rollups', 'classpilot_usage_rollup_days') }
)
$script:ProductSchoolIdPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
$script:ProductPlanTool = 'deploy-product-runtime-config'
$script:ProductPlanFields = @('schemaVersion', 'tool', 'runId', 'createdAt', 'toolSha', 'appSha', 'imageDigest', 'apiArn', 'workerArn',
    'apiFingerprint', 'workerFingerprint', 'managedFingerprint', 'apiTags', 'workerTags', 'apiDesired', 'deploymentHash', 'scaling',
    'config', 'prior', 'desired', 'changes', 'activations', 'dailyUsageEvidence')
$script:EvidenceRootMarkerName = '.schoolpilot-product-runtime-evidence-v1'
$script:EvidenceRootMarkerBytes = [Text.Encoding]::UTF8.GetBytes("schoolpilot-product-runtime-evidence-v1`n")

function Assert-ProductExactProperties {
    param($Value, [string[]]$Names, [string]$Trail)
    # Property names are compared ordinally: a case variant is a different name.
    if ($Value -isnot [Management.Automation.PSCustomObject]) { throw "$Trail must be a JSON object." }
    $present = @($Value.PSObject.Properties | ForEach-Object { $_.Name })
    if (@($present | Where-Object { $_ -cnotin $Names }).Count -or @($Names | Where-Object { $_ -cnotin $present }).Count) {
        throw "$Trail must contain exactly: $($Names -join ', ')."
    }
}

function Get-ProductNameRefusal {
    param([string]$Name)
    if ($Name -cin $script:RuntimeEnvironmentNames) { return $null }
    if ($Name -in $script:RuntimeEnvironmentNames) { return "Managed names are exact upper-case environment names; '$Name' is not one." }
    if ($Name -cmatch '^CLASSPILOT_CAP_' -or $Name -cin @('CLASSPILOT_CAPABILITY_ROLLOUTS_JSON', 'CLASSPILOT_PROTOCOL_V3_ENABLED')) {
        return "$Name is a ClassPilot capability control; only deploy-classpilot-runtime-config.ps1 changes it."
    }
    if ($Name -cmatch '^CLASSPILOT_(TURN|STUN)_') { return "$Name is legacy TURN configuration; no runtime-config tool changes it." }
    if ($Name -cmatch '^MYDESK_' -or $Name -ceq 'STUDENT_INFORMATION_AI_IMPORT_MODE') {
        return "$Name is a My Desk control; only deploy-mydesk-runtime-config.ps1 changes it."
    }
    if ($Name -cin @('RLS_ENABLED_TABLES', 'RLS_GUC_ENABLED')) { return "$Name changes only through deploy.sh --enable-rls-table." }
    return "$Name is not a wave-1 product flag; this tool refuses every other name."
}

function Get-ProductSchoolIds {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
    if ($Value -ceq '') { return ,[string[]]@() }
    $ids = $Value.Split(',')
    if (@($ids | Where-Object { $_ -cnotmatch $script:ProductSchoolIdPattern }).Count -or @($ids | Sort-Object -Unique).Count -ne $ids.Count) {
        throw "$($script:ProductSchoolIdsName) must list distinct lower-case school UUIDs separated by commas, without spaces."
    }
    return ,$ids
}

function Test-ProductValue {
    param([string]$Name, $Value)
    if ($Name -cnotin $script:RuntimeEnvironmentNames) { return $false }
    if ($null -eq $Value) { return $true }
    if ($Value -isnot [string]) { return $false }
    if ($Name -ceq $script:ProductSchoolIdsName) {
        try { [void](Get-ProductSchoolIds $Value); return $true } catch { return $false }
    }
    return $Value -cin $script:ProductModeValues[$Name]
}

function ConvertTo-ProductChanges {
    param([Parameter(Mandatory)][AllowNull()]$Config)
    Assert-ProductExactProperties $Config @('schemaVersion', 'environment') 'Product runtime configuration'
    if (-not (Test-IsJsonInteger $Config.schemaVersion) -or $Config.schemaVersion -ne 1) { throw 'Product runtime configuration schemaVersion must be 1.' }
    if ($Config.environment -isnot [Management.Automation.PSCustomObject]) { throw 'Product runtime configuration environment must be a JSON object.' }
    $changes = [ordered]@{}
    foreach ($property in @($Config.environment.PSObject.Properties)) {
        $refusal = Get-ProductNameRefusal $property.Name
        if ($refusal) { throw $refusal }
        $value = $property.Value
        if ($null -ne $value -and $value -isnot [string]) { throw "$($property.Name) must be a JSON string, or null to unset it." }
        # An empty allowlist means every school, exactly like an unset one. It is
        # written as unset so no empty value ever reaches a task definition.
        if ($property.Name -ceq $script:ProductSchoolIdsName -and $value -ceq '') { $value = $null }
        if (-not (Test-ProductValue $property.Name $value)) { throw "$($property.Name) accepts only its exact documented values." }
        $changes[$property.Name] = $value
    }
    if ($changes.Count -eq 0) { throw 'The product runtime configuration names no flag.' }
    return $changes
}

function ConvertTo-ProductState {
    param([Parameter(Mandatory)][AllowNull()]$Value)
    $names = if ($Value -is [Collections.IDictionary]) { @($Value.Keys | ForEach-Object { [string]$_ }) }
        elseif ($Value -is [Management.Automation.PSCustomObject]) { @($Value.PSObject.Properties | ForEach-Object { $_.Name }) }
        else { throw 'Invalid product runtime state.' }
    if ($names.Count -ne $script:RuntimeEnvironmentNames.Count -or @($names | Where-Object { $_ -cnotin $script:RuntimeEnvironmentNames }).Count) {
        throw 'Invalid product runtime state.'
    }
    $state = [ordered]@{}
    foreach ($name in $script:RuntimeEnvironmentNames) {
        $item = if ($Value -is [Collections.IDictionary]) { $Value[$name] } else { $Value.$name }
        if ($null -ne $item -and $item -isnot [string]) { throw 'Invalid product runtime state.' }
        $state[$name] = $item
    }
    return $state
}

function Get-ProductEnvironment {
    param([Parameter(Mandatory)]$Task, [Parameter(Mandatory)][string]$ContainerName)
    $containers = @($Task.containerDefinitions | Where-Object name -CEQ $ContainerName)
    if ($containers.Count -ne 1) { throw 'Ambiguous product runtime container.' }
    $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
    foreach ($entry in @($containers[0].environment)) {
        if (-not $environment.TryAdd([string]$entry.name, [string]$entry.value)) { throw 'Duplicate runtime environment name.' }
    }
    foreach ($name in @($environment.Keys)) {
        if ($name -cnotin $script:RuntimeEnvironmentNames -and $name -in $script:RuntimeEnvironmentNames) {
            throw 'A case variant of a wave-1 product flag was set outside this tool; remove it in a reviewed change first.'
        }
    }
    foreach ($secret in @($containers[0].secrets)) {
        if ([string]$secret.name -in $script:RuntimeEnvironmentNames) { throw 'Wave-1 product flags use an unexpected secret channel.' }
    }
    return ,$environment
}

function Get-ProductManagedState {
    param([Parameter(Mandatory)]$Environment)
    $state = [ordered]@{}
    foreach ($name in $script:RuntimeEnvironmentNames) {
        $state[$name] = if ($Environment.ContainsKey($name)) { $Environment[$name] } else { $null }
    }
    return $state
}

function Resolve-ProductDesiredState {
    param([Parameter(Mandatory)][Collections.IDictionary]$Prior, [Parameter(Mandatory)][Collections.IDictionary]$Changes)
    $desired = [ordered]@{}
    foreach ($name in $script:RuntimeEnvironmentNames) {
        if ($Changes.Contains($name)) { $desired[$name] = $Changes[$name]; continue }
        if (-not (Test-ProductValue $name $Prior[$name])) {
            throw "The live $name value is malformed (it was set outside this tool); name it in the configuration to repair it."
        }
        $desired[$name] = $Prior[$name]
    }
    if ($desired['CLASSPILOT_DIGITAL_USAGE_MODE'] -ceq 'on' -and $desired['CLASSPILOT_USAGE_ROLLUP_MODE'] -cne 'on') {
        throw 'CLASSPILOT_DIGITAL_USAGE_MODE=on requires CLASSPILOT_USAGE_ROLLUP_MODE=on; set or keep both in the same plan.'
    }
    if ((Get-CanonicalJsonSha256 $desired) -ceq (Get-CanonicalJsonSha256 $Prior)) { throw 'The configuration matches the live runtime; nothing would change.' }
    return $desired
}

function Get-ProductExposure {
    param([Parameter(Mandatory)][Collections.IDictionary]$State)
    # Malformed values count as off (their readers fail closed), so replacing
    # one is always treated as an activation and meets every precondition.
    $allSchools = $false; $schools = @()
    if ($State['CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE'] -ceq 'on') {
        $ids = $State[$script:ProductSchoolIdsName]
        if ($null -eq $ids -or $ids -ceq '') { $allSchools = $true }
        elseif (Test-ProductValue $script:ProductSchoolIdsName $ids) { $schools = Get-ProductSchoolIds $ids }
    }
    return [pscustomobject]@{
        AllSchools = $allSchools; Schools = $schools
        passpilotRules = $State['PASSPILOT_RULES_MODE'] -ceq 'on'
        passpilotAppointments = $State['PASSPILOT_APPOINTMENTS_MODE'] -ceq 'on'
        passpilotReports = $State['PASSPILOT_REPORTS_MODE'] -ceq 'v2'
        dailyUsageRollupPromotion = $State['CLASSPILOT_DAILY_USAGE_ROLLUP_MODE'] -cin @('set_based', 'on')
        usageRollup = $State['CLASSPILOT_USAGE_ROLLUP_MODE'] -ceq 'on'
        digitalUsage = $State['CLASSPILOT_DIGITAL_USAGE_MODE'] -ceq 'on'
    }
}

function Get-ProductActivations {
    # A feature activates when the desired state exposes it where the prior did
    # not: off to on, shadow to set_based/on, or a school the allowlist gains.
    param([Parameter(Mandatory)][Collections.IDictionary]$Prior, [Parameter(Mandatory)][Collections.IDictionary]$Desired)
    $before = Get-ProductExposure $Prior
    $after = Get-ProductExposure $Desired
    $activations = [Collections.Generic.List[string]]::new()
    if (-not $before.AllSchools -and ($after.AllSchools -or @($after.Schools | Where-Object { $_ -cnotin $before.Schools }).Count)) {
        $activations.Add('sharedTeachingResources')
    }
    foreach ($feature in @('passpilotRules', 'passpilotAppointments', 'passpilotReports', 'dailyUsageRollupPromotion', 'usageRollup', 'digitalUsage')) {
        if ($after.$feature -and -not $before.$feature) { $activations.Add($feature) }
    }
    return ,$activations.ToArray()
}

function Get-ProductChangeList {
    param([Parameter(Mandatory)][Collections.IDictionary]$Prior, [Parameter(Mandatory)][Collections.IDictionary]$Desired)
    return ,@($script:RuntimeEnvironmentNames | Where-Object { $Prior[$_] -cne $Desired[$_] } | ForEach-Object {
        [ordered]@{ name = $_; from = $Prior[$_]; to = $Desired[$_] }
    })
}

function ConvertTo-ProductRuntime {
    param([Parameter(Mandatory)][Collections.IDictionary]$State)
    $environment = [ordered]@{}
    foreach ($name in $script:RuntimeEnvironmentNames) {
        if ($null -ne $State[$name]) { $environment[$name] = [string]$State[$name] }
    }
    return [pscustomobject]@{ Mode = 'product'; Turn = $null; Environment = $environment }
}

function Assert-DailyUsagePromotionEvidence {
    param([string]$EvidencePath, [string]$Digest, [string]$RepositoryRoot)
    if (-not $EvidencePath) { throw 'Promoting CLASSPILOT_DAILY_USAGE_ROLLUP_MODE requires -DailyUsageEvidencePath recording three clean shadow school days.' }
    $path = Assert-PrivateInputPath -Path $EvidencePath -RepositoryRoot $RepositoryRoot
    $snapshot = Read-StrictJsonSnapshot -Path $path
    $e = $snapshot.Value
    Assert-ProductExactProperties $e @('schemaVersion', 'reviewedAt', 'reviewReference', 'imageDigest', 'schoolDays') 'Daily-usage evidence'
    if (-not (Test-IsJsonInteger $e.schemaVersion) -or $e.schemaVersion -ne 1) { throw 'Daily-usage evidence must use schemaVersion 1.' }
    if ($e.reviewedAt -isnot [string]) { throw 'Daily-usage evidence reviewedAt must be an exact ISO-8601 timestamp string.' }
    $now = [DateTimeOffset]::UtcNow
    [void](Get-FreshEvidenceTimestamp -Value $e.reviewedAt -Label 'Daily-usage evidence' -Now $now)
    if ($e.reviewReference -isnot [string] -or $e.reviewReference -cnotmatch '^[a-zA-Z0-9_./:-]{1,160}$' -or $e.imageDigest -cne $Digest) {
        throw 'Daily-usage evidence must name its review and bind the serving image digest.'
    }
    if ($e.schoolDays -isnot [array] -or @($e.schoolDays).Count -lt 3) { throw 'Daily-usage evidence must record at least three school days.' }
    $today = (Get-EasternNow -UtcNow $now).Date
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($day in @($e.schoolDays)) {
        Assert-ProductExactProperties $day @('date', 'processedSchools', 'shadowMismatches', 'failedSchools') 'Daily-usage evidence day'
        $date = [DateTime]::MinValue
        if ($day.date -isnot [string] -or $day.date -cnotmatch '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' -or
            -not [DateTime]::TryParseExact($day.date, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$date) -or
            $date.DayOfWeek -in @([DayOfWeek]::Saturday, [DayOfWeek]::Sunday) -or $date -ge $today -or $date -lt $today.AddDays(-30) -or
            -not $seen.Add($day.date)) {
            throw 'Daily-usage evidence days must be distinct weekdays within the last 30 days, before today in America/New_York.'
        }
        if (-not (Test-IsJsonInteger $day.processedSchools) -or $day.processedSchools -lt 1 -or
            -not (Test-IsJsonInteger $day.shadowMismatches) -or $day.shadowMismatches -ne 0 -or
            -not (Test-IsJsonInteger $day.failedSchools) -or $day.failedSchools -ne 0) {
            throw 'Every evidence day needs processedSchools of at least 1, shadowMismatches 0 and failedSchools 0.'
        }
    }
    return [pscustomobject]@{ path = $path; sha256 = $snapshot.Sha256 }
}

function Assert-ProductPreconditions {
    param([Collections.IDictionary]$Prior, [Collections.IDictionary]$Desired, $Snapshot, [string]$EvidencePath, [string]$Digest, [string]$RepositoryRoot, [string]$AppSha)
    # Admission checks apply to activation; source compatibility applies while
    # usage remains on. Turning both usage flags off stays available.
    $activations = Get-ProductActivations $Prior $Desired
    if ($Desired['PASSPILOT_REPORTS_MODE'] -ceq 'v2') {
        $compatibilityError = 'PASSPILOT_REPORTS_MODE=v2 requires complete preserved 128-table admission, RLS_GUC_ENABLED=true, and report contract version 2 with authority-fence version 1 in the exact source SHA serving both API and worker.'
        try {
            $source = Invoke-GitText -Arguments @('show', "${AppSha}:src/config/passpilotReportsMode.ts") -RepositoryRoot $RepositoryRoot
            $registry = (Invoke-GitText -Arguments @('show', "${AppSha}:src/config/rlsRegistry.json") -RepositoryRoot $RepositoryRoot) | ConvertFrom-Json -Depth 30 -DateKind String
            $inventory = $registry.inventories.passpilotAppointmentsPostExpand
        } catch { throw $compatibilityError }
        if ($source -cnotmatch 'export const PASSPILOT_REPORTS_CONTRACT_VERSION = 2;' -or
            $source -cnotmatch 'export const PASSPILOT_REPORTS_AUTHORITY_FENCE_VERSION = 1;' -or
            $inventory.count -ne 128 -or @($inventory.tables).Count -ne 128 -or
            @($inventory.tables | Sort-Object -Unique).Count -ne 128 -or
            @('students', 'passes', 'passpilot_pass_denials', 'passpilot_appointments' | Where-Object { $_ -cnotin @($inventory.tables) }).Count) { throw $compatibilityError }
        foreach ($environment in $Snapshot.Environments) {
            if (-not $environment.ContainsKey('RLS_GUC_ENABLED') -or $environment['RLS_GUC_ENABLED'] -cne 'true' -or
                -not $environment.ContainsKey('RLS_ENABLED_TABLES')) { throw $compatibilityError }
            $tables = $environment['RLS_ENABLED_TABLES'].Split(',')
            if (@($inventory.tables | Where-Object { $_ -cnotin $tables }).Count) { throw $compatibilityError }
        }
    }
    if ($Desired['PASSPILOT_APPOINTMENTS_MODE'] -ceq 'on') {
        # Both stable services are bound to AppSha/digest. The singleton table
        # alone cannot make a pre-atomic issuer or older admission image safe.
        $compatibilityError = 'PASSPILOT_APPOINTMENTS_MODE=on requires RLS_GUC_ENABLED=true and an RLS_ENABLED_TABLES allowlist with the complete preserved 128-table admission, plus atomic writer contract version 2 on both API and worker.'
        try {
            $source = Invoke-GitText -Arguments @('show', "${AppSha}:src/config/passpilotAppointmentsMode.ts") -RepositoryRoot $RepositoryRoot
            $registry = (Invoke-GitText -Arguments @('show', "${AppSha}:src/config/rlsRegistry.json") -RepositoryRoot $RepositoryRoot) | ConvertFrom-Json -Depth 30 -DateKind String
            $inventory = $registry.inventories.passpilotAppointmentsPostExpand
        } catch { throw $compatibilityError }
        if ($source -cnotmatch 'export const PASSPILOT_APPOINTMENTS_ATOMIC_WRITER_CONTRACT_VERSION = 2;' -or
            $inventory.count -ne 128 -or @($inventory.tables).Count -ne 128 -or
            @($inventory.tables | Sort-Object -Unique).Count -ne 128 -or 'passpilot_appointments' -cnotin @($inventory.tables)) { throw $compatibilityError }
        foreach ($environment in $Snapshot.Environments) {
            if (-not $environment.ContainsKey('RLS_GUC_ENABLED') -or $environment['RLS_GUC_ENABLED'] -cne 'true' -or
                -not $environment.ContainsKey('RLS_ENABLED_TABLES')) { throw $compatibilityError }
            $tables = $environment['RLS_ENABLED_TABLES'].Split(',')
            if (@($inventory.tables | Where-Object { $_ -cnotin $tables }).Count) { throw $compatibilityError }
        }
    }
    if ($Desired['CLASSPILOT_USAGE_ROLLUP_MODE'] -ceq 'on' -or $Desired['CLASSPILOT_DIGITAL_USAGE_MODE'] -ceq 'on') {
        # The snapshot binds BOTH serving task definitions to AppSha and digest.
        # Inspect that release's source, never the local working tree: admitting
        # the table alone cannot make a pre-ledger writer coverage-compatible.
        $source = Invoke-GitText -Arguments @('show', "${AppSha}:src/config/classpilotUsageModes.ts") -RepositoryRoot $RepositoryRoot
        if ($source -cnotmatch 'export const CLASSPILOT_USAGE_COVERAGE_CONTRACT_VERSION = 1;') {
            throw 'Monitored Browser Time requires a serving source SHA with usage coverage contract version 1 on both API and worker.'
        }
    }
    foreach ($gate in $script:ProductRlsGates) {
        if ($gate.Feature -cnotin $activations) { continue }
        foreach ($environment in $Snapshot.Environments) {
            if (-not $environment.ContainsKey('RLS_GUC_ENABLED') -or $environment['RLS_GUC_ENABLED'] -cne 'true' -or
                -not $environment.ContainsKey('RLS_ENABLED_TABLES')) {
                throw "$($gate.Name)=on requires RLS_GUC_ENABLED=true and an RLS_ENABLED_TABLES allowlist on both the API and the worker."
            }
            $tables = $environment['RLS_ENABLED_TABLES'].Split(',')
            if (@($gate.Tables | Where-Object { $_ -cnotin $tables }).Count) {
                throw "$($gate.Name)=on requires $($gate.Tables -join ', ') in RLS_ENABLED_TABLES on both the API and the worker; admit them with deploy.sh --enable-rls-table first."
            }
        }
    }
    if ('dailyUsageRollupPromotion' -cnotin $activations) {
        if ($EvidencePath) { throw 'Daily-usage evidence applies only to a plan that promotes CLASSPILOT_DAILY_USAGE_ROLLUP_MODE to set_based or on.' }
        return $null
    }
    # Legacy and set_based always report zero mismatches; only shadow compares.
    if ($null -ne $Prior['CLASSPILOT_DAILY_USAGE_ROLLUP_MODE'] -and $Prior['CLASSPILOT_DAILY_USAGE_ROLLUP_MODE'] -cne 'shadow') {
        throw 'Promote the daily usage rollup only from shadow (unset or shadow): no other mode measures mismatches.'
    }
    return Assert-DailyUsagePromotionEvidence -EvidencePath $EvidencePath -Digest $Digest -RepositoryRoot $RepositoryRoot
}

function Get-ProductSnapshot {
    param([string]$ExpectedApiArn, [string]$ExpectedWorkerArn, [string]$Digest, [string]$ReleaseSha)
    Assert-ExpectedReleaseIdentity -AppSha $ReleaseSha -ImageDigest $Digest -ApiTaskDefinitionArn $ExpectedApiArn -WorkerTaskDefinitionArn $ExpectedWorkerArn
    $identity = Invoke-AwsJson -Arguments @('sts', 'get-caller-identity', '--output', 'json')
    if ($identity.Account -cne $script:AccountId) { throw 'Wrong AWS account.' }
    $services = Get-ServiceSnapshot
    Assert-StableService -Service $services.Api -ExpectedTaskDefinitionArn $ExpectedApiArn -MinimumDesired 1 -MaximumDesired 3 -Label 'API'
    Assert-StableService -Service $services.Worker -ExpectedTaskDefinitionArn $ExpectedWorkerArn -MinimumDesired 1 -MaximumDesired 1 -Label 'worker'
    Assert-NormalServiceDeploymentConfiguration -Service $services.Api
    Assert-NormalServiceDeploymentConfiguration -Service $services.Worker
    [void](Assert-ApiTargetHealth -ApiService $services.Api -ExpectedDesiredCount $services.Api.desiredCount -Mode Exact)
    $api = Get-TaskDefinitionResponse -TaskDefinitionArn $ExpectedApiArn
    $worker = Get-TaskDefinitionResponse -TaskDefinitionArn $ExpectedWorkerArn
    $environments = @()
    # Sources must be the reviewed task sizes. Every candidate and recovery
    # revision below is an exact-size clone of these, so none can shrink a task.
    foreach ($entry in @(@($api, $ExpectedApiArn, 'api', $script:ApiTaskCpu, $script:ApiTaskMemory),
            @($worker, $ExpectedWorkerArn, 'scheduler-worker', $script:WorkerTaskCpu, $script:WorkerTaskMemory))) {
        $task = $entry[0].taskDefinition
        [void](Assert-TaskDefinitionContract -Response $entry[0] -ExpectedArn $entry[1] -ExpectedFamily $task.family -ContainerName $entry[2] `
            -ExpectedDigest $Digest -ExpectedCpu $entry[3] -ExpectedMemory $entry[4])
        $environments += ,(Get-ProductEnvironment -Task $task -ContainerName $entry[2])
    }
    if ((Get-ManagedRuntimeFingerprint $api.taskDefinition 'api') -cne (Get-ManagedRuntimeFingerprint $worker.taskDefinition 'scheduler-worker')) {
        throw 'API and worker carry different wave-1 product flag values; they were changed outside this tool.'
    }
    $ecr = Invoke-AwsJson -Arguments @('ecr', 'describe-images', '--repository-name', $script:EcrRepository,
        '--image-ids', "imageTag=$($ReleaseSha.Substring(0,12))", '--region', $script:Region, '--output', 'json')
    if (@($ecr.imageDetails).Count -ne 1 -or $ecr.imageDetails[0].imageDigest -cne $Digest) { throw 'Release tag does not match the serving image.' }
    return [pscustomobject]@{ Services = $services; ApiTask = $api; WorkerTask = $worker; Environments = $environments }
}

function Assert-ProductCandidateState {
    # API and worker must end with identical values for every managed name.
    param([string]$ApiTaskArn, [string]$WorkerTaskArn, [Collections.IDictionary]$Expected)
    $expectedHash = Get-CanonicalJsonSha256 $Expected
    foreach ($entry in @(@($ApiTaskArn, 'api'), @($WorkerTaskArn, 'scheduler-worker'))) {
        $response = Get-TaskDefinitionResponse -TaskDefinitionArn $entry[0]
        $state = Get-ProductManagedState (Get-ProductEnvironment -Task $response.taskDefinition -ContainerName $entry[1])
        if ((Get-CanonicalJsonSha256 $state) -cne $expectedHash) { throw 'A registered revision does not carry exactly the planned wave-1 flag values.' }
    }
}

function Assert-ProductPlanConsistency {
    param([Parameter(Mandatory)]$Plan)
    $prior = ConvertTo-ProductState $Plan.prior
    $desired = Resolve-ProductDesiredState $prior (ConvertTo-ProductChanges $Plan.config)
    $activations = Get-ProductActivations $prior $desired
    $expected = [ordered]@{ desired = $desired; changes = Get-ProductChangeList $prior $desired; activations = $activations }
    $recorded = [ordered]@{ desired = ConvertTo-ProductState $Plan.desired; changes = @($Plan.changes); activations = @($Plan.activations) }
    if ((Get-CanonicalJsonSha256 $expected) -cne (Get-CanonicalJsonSha256 $recorded)) { throw 'The product runtime plan is internally inconsistent.' }
    $evidence = $Plan.dailyUsageEvidence
    if (('dailyUsageRollupPromotion' -cin $activations) -ne ($null -ne $evidence)) { throw 'The product runtime plan evidence binding is inconsistent.' }
    if ($null -ne $evidence) {
        Assert-ProductExactProperties ([pscustomobject]$evidence) @('path', 'sha256') 'Plan evidence binding'
        if ($evidence.path -isnot [string] -or $evidence.sha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'The product runtime plan evidence binding is inconsistent.' }
    }
    return [pscustomobject]@{ Prior = $prior; Desired = $desired }
}

function New-ProductPlan {
    param($Config, [string]$Directory, [string]$ExpectedApiArn, [string]$ExpectedWorkerArn, [string]$Digest, [string]$ReleaseSha, [string]$EvidencePath)
    $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $toolSha = Assert-RepositoryIdentity -RepositoryRoot $repo
    $changes = ConvertTo-ProductChanges $Config
    $snapshot = Get-ProductSnapshot $ExpectedApiArn $ExpectedWorkerArn $Digest $ReleaseSha
    $prior = Get-ProductManagedState $snapshot.Environments[0]
    $desired = Resolve-ProductDesiredState $prior $changes
    $evidence = Assert-ProductPreconditions $prior $desired $snapshot $EvidencePath $Digest $repo $ReleaseSha
    $scaling = Get-ScalingSnapshot
    if ($scaling.DynamicIn -or $scaling.DynamicOut -or $scaling.Scheduled) { throw 'Another operation holds autoscaling.' }
    Assert-ScheduledScalingContract
    $directory = Assert-PrivateExternalRoot -Root $Directory -RepositoryRoot $repo
    $runId = [Guid]::NewGuid().ToString('N')
    $plan = [ordered]@{ schemaVersion = 1; tool = $script:ProductPlanTool; runId = $runId; createdAt = [DateTimeOffset]::UtcNow.ToString('o')
        toolSha = $toolSha; appSha = $ReleaseSha; imageDigest = $Digest; apiArn = $ExpectedApiArn; workerArn = $ExpectedWorkerArn
        apiFingerprint = Get-TaskFingerprint $snapshot.ApiTask.taskDefinition 'api'
        workerFingerprint = Get-TaskFingerprint $snapshot.WorkerTask.taskDefinition 'scheduler-worker'
        managedFingerprint = Get-ManagedRuntimeFingerprint $snapshot.ApiTask.taskDefinition 'api'
        apiTags = Get-TaskTagsFingerprint @($snapshot.ApiTask.tags); workerTags = Get-TaskTagsFingerprint @($snapshot.WorkerTask.tags)
        apiDesired = [int]$snapshot.Services.Api.desiredCount
        deploymentHash = Get-CanonicalJsonSha256 @($snapshot.Services.Api.deploymentConfiguration, $snapshot.Services.Worker.deploymentConfiguration)
        scaling = $scaling; config = $Config; prior = $prior; desired = $desired
        changes = Get-ProductChangeList $prior $desired; activations = Get-ProductActivations $prior $desired; dailyUsageEvidence = $evidence
    }
    $path = Join-Path $directory "$runId-plan.json"
    Write-SanitizedJson -Path $path -Value $plan
    return [pscustomobject]@{ path = $path; sha256 = Get-FileSha256 $path; plan = [pscustomobject]$plan }
}

function Read-ProductPlan {
    param([string]$Path, [string]$Hash)
    $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    [void](Assert-PrivateInputPath -Path $Path -RepositoryRoot $repo)
    $snapshot = Read-StrictJsonSnapshot -Path $Path
    if ($Hash -cnotmatch '^[a-f0-9]{64}$' -or $snapshot.Sha256 -cne $Hash) { throw 'Product runtime plan hash mismatch.' }
    $plan = $snapshot.Value
    Assert-ProductExactProperties $plan $script:ProductPlanFields 'Product runtime plan'
    if (-not (Test-IsJsonInteger $plan.schemaVersion) -or $plan.schemaVersion -ne 1 -or $plan.tool -cne $script:ProductPlanTool -or
        $plan.runId -cnotmatch '^[a-f0-9]{32}$') { throw 'This file is not a product runtime plan.' }
    [void](Assert-RepositoryIdentity -RepositoryRoot $repo -ExpectedSha $plan.toolSha)
    [void](Assert-ProductPlanConsistency $plan)
    return $plan
}

function Invoke-ProductApply {
    param($Plan, [string]$Hash, [string]$Directory)
    $age = [DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse($Plan.createdAt)
    if ($age.TotalHours -gt 2 -or $age.TotalSeconds -lt -60) { throw 'Create a fresh product runtime plan before applying.' }
    Assert-RuntimeConfigMutationWindow
    $state = Assert-ProductPlanConsistency $Plan
    # Re-read production and re-check every precondition: nothing is trusted
    # from planning time except what the fingerprints below prove unchanged.
    $snapshot = Get-ProductSnapshot $Plan.apiArn $Plan.workerArn $Plan.imageDigest $Plan.appSha
    if ((Get-CanonicalJsonSha256 (Get-ProductManagedState $snapshot.Environments[0])) -cne (Get-CanonicalJsonSha256 $state.Prior)) {
        throw 'Production state drifted after the product runtime plan.'
    }
    $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $evidencePath = if ($null -ne $Plan.dailyUsageEvidence) { [string]$Plan.dailyUsageEvidence.path } else { $null }
    $evidence = Assert-ProductPreconditions $state.Prior $state.Desired $snapshot $evidencePath $Plan.imageDigest $repo $Plan.appSha
    if ($null -ne $evidence -and $evidence.sha256 -cne $Plan.dailyUsageEvidence.sha256) { throw 'Daily-usage evidence changed after planning.' }
    foreach ($check in @(
        @((Get-TaskFingerprint $snapshot.ApiTask.taskDefinition 'api'), $Plan.apiFingerprint),
        @((Get-TaskFingerprint $snapshot.WorkerTask.taskDefinition 'scheduler-worker'), $Plan.workerFingerprint),
        @((Get-ManagedRuntimeFingerprint $snapshot.ApiTask.taskDefinition 'api'), $Plan.managedFingerprint),
        @((Get-TaskTagsFingerprint @($snapshot.ApiTask.tags)), $Plan.apiTags),
        @((Get-TaskTagsFingerprint @($snapshot.WorkerTask.tags)), $Plan.workerTags),
        @((Get-CanonicalJsonSha256 @($snapshot.Services.Api.deploymentConfiguration, $snapshot.Services.Worker.deploymentConfiguration)), $Plan.deploymentHash),
        @((Get-CanonicalJsonSha256 (Get-ScalingSnapshot)), (Get-CanonicalJsonSha256 $Plan.scaling)))) {
        if ($check[0] -cne $check[1]) { throw 'Production state drifted after the product runtime plan.' }
    }
    if ($snapshot.Services.Api.desiredCount -ne $Plan.apiDesired) { throw 'API capacity changed after planning.' }
    $runtime = ConvertTo-ProductRuntime $state.Desired
    $resultPath = Join-Path $Directory "$($Plan.runId)-result.json"
    if (Test-Path -LiteralPath $resultPath) { throw 'This plan already has a receipt; inspect it before creating a new operation.' }
    $candidate = @{}
    $checkpoint = [ordered]@{ schemaVersion = 1; runId = $Plan.runId; planSha256 = $Hash; status = 'preparing'
        priorApiArn = $Plan.apiArn; priorWorkerArn = $Plan.workerArn; apiArn = $null; workerArn = $null }
    Acquire-OperationLock -RunId $Plan.runId -PlanSha256 $Hash
    # A dot-sourced caller may run Apply and Rollback in the same process.
    # Recovery must describe this operation, never a prior completed rollout.
    $script:ApiServiceMutationStarted = $false
    $script:WorkerServiceMutationStarted = $false
    try {
        Start-OperationMutationWindow
        foreach ($role in @('Api', 'Worker')) {
            $source = $snapshot.($role + 'Task'); $task = $source.taskDefinition
            $container = if ($role -ceq 'Api') { 'api' } else { 'scheduler-worker' }
            $request = New-RuntimeTaskDefinitionRequest -SourceResponse $source -RuntimeConfiguration $runtime -ExpectedDigest $Plan.imageDigest `
                -ExpectedArn $task.taskDefinitionArn -ExpectedFamily $task.family -ContainerName $container -ExpectedCpu $task.cpu -ExpectedMemory $task.memory
            $candidate[$role] = Register-RuntimeTaskDefinition -Request $request -Directory $Directory -RuntimeConfiguration $runtime -ExpectedDigest $Plan.imageDigest `
                -SourceFingerprint (Get-TaskFingerprint $task $container) -SourceTagsFingerprint (Get-TaskTagsFingerprint @($source.tags)) `
                -ExpectedFamily $task.family -ContainerName $container -ExpectedCpu $task.cpu -ExpectedMemory $task.memory
            $checkpoint[($role.ToLowerInvariant() + 'Arn')] = $candidate[$role]
            Write-SanitizedJson -Path $resultPath -Value $checkpoint
        }
        Assert-ProductCandidateState $candidate.Api $candidate.Worker $state.Desired
        [void](Acquire-ScalingHold)
        $before = Get-ServiceSnapshot
        if ($before.Api.taskDefinition -cne $Plan.apiArn -or $before.Worker.taskDefinition -cne $Plan.workerArn -or $before.Api.desiredCount -ne $Plan.apiDesired) { throw 'Service state changed before mutation.' }
        [void](Assert-ScalingHoldExact)
        # Converge the API before rolling the worker, bounding overlapping pools.
        $checkpoint.status = 'api_update_pending'; Write-SanitizedJson $resultPath $checkpoint
        Invoke-RuntimeServiceUpdate -Role api -TaskDefinitionArn $candidate.Api
        [void](Wait-ExactServicePairConvergence $candidate.Api $Plan.workerArn $Plan.apiDesired)
        $checkpoint.status = 'worker_update_pending'; Write-SanitizedJson $resultPath $checkpoint
        Invoke-RuntimeServiceUpdate -Role worker -TaskDefinitionArn $candidate.Worker
        [void](Wait-ExactServicePairConvergence $candidate.Api $candidate.Worker $Plan.apiDesired)
        [void](Restore-ScalingHold)
        $checkpoint.status = 'applied'; Write-SanitizedJson $resultPath $checkpoint
        Complete-OperationMutationWindow
        Release-OperationLock
        return [pscustomobject]$checkpoint
    } catch {
        # Messages from this tool and the shared transport never carry values.
        $failure = $_.Exception.Message
        $checkpoint.status = 'recovery_required'; Write-SanitizedJson $resultPath $checkpoint
        if (-not $script:ApiServiceMutationStarted -and -not $script:WorkerServiceMutationStarted) {
            if ($script:ScalingHoldAcquired) { [void](Restore-ScalingHold) }
            # Start can fail after AWS accepted its fence update but before the
            # response reached us. Do not guess that a local preparing state is
            # safe to release; retain the receipt and let the operator inspect it.
            if ($script:OperationLockState -ceq 'mutating') {
                Complete-OperationMutationWindow
                Release-OperationLock
                $checkpoint.status = 'failed_no_service_mutation'; Write-SanitizedJson $resultPath $checkpoint
            }
        } else {
            try {
                # Restore the exact prior values in fresh clones of the frozen
                # sources, so API and worker again match each other.
                $observed = Get-ServiceSnapshot
                if ($observed.Api.taskDefinition -cnotin @($Plan.apiArn, $candidate.Api) -or
                    $observed.Worker.taskDefinition -cnotin @($Plan.workerArn, $candidate.Worker) -or
                    $observed.Api.desiredCount -ne $Plan.apiDesired -or $observed.Worker.desiredCount -ne 1) { throw 'Recovery source drifted.' }
                [void](Assert-ScalingHoldExact)
                $recoveryRuntime = ConvertTo-ProductRuntime $state.Prior
                $recovery = @{}
                foreach ($role in @('Api', 'Worker')) {
                    $source = $snapshot.($role + 'Task'); $task = $source.taskDefinition
                    $container = if ($role -ceq 'Api') { 'api' } else { 'scheduler-worker' }
                    $request = New-RuntimeTaskDefinitionRequest -SourceResponse $source -RuntimeConfiguration $recoveryRuntime -ExpectedDigest $Plan.imageDigest `
                        -ExpectedArn $task.taskDefinitionArn -ExpectedFamily $task.family -ContainerName $container -ExpectedCpu $task.cpu -ExpectedMemory $task.memory
                    $recovery[$role] = Register-RuntimeTaskDefinition -Request $request -Directory $Directory -RuntimeConfiguration $recoveryRuntime -ExpectedDigest $Plan.imageDigest `
                        -SourceFingerprint (Get-TaskFingerprint $task $container) -SourceTagsFingerprint (Get-TaskTagsFingerprint @($source.tags)) `
                        -ExpectedFamily $task.family -ContainerName $container -ExpectedCpu $task.cpu -ExpectedMemory $task.memory
                    $checkpoint[($role.ToLowerInvariant() + 'Arn')] = $recovery[$role]
                    Write-SanitizedJson $resultPath $checkpoint
                }
                Assert-ProductCandidateState $recovery.Api $recovery.Worker $state.Prior
                Invoke-RuntimeServiceUpdate -Role api -TaskDefinitionArn $recovery.Api
                [void](Wait-ExactServicePairConvergence $recovery.Api $observed.Worker.taskDefinition $Plan.apiDesired)
                Invoke-RuntimeServiceUpdate -Role worker -TaskDefinitionArn $recovery.Worker
                [void](Wait-ExactServicePairConvergence $recovery.Api $recovery.Worker $Plan.apiDesired)
                [void](Restore-ScalingHold)
                $checkpoint.status = 'rolled_back'; Write-SanitizedJson $resultPath $checkpoint
                Complete-OperationMutationWindow; Release-OperationLock
            } catch {
                # Keep the non-stealable mutation fence and source/candidate
                # receipt when even bounded recovery cannot prove convergence.
                $checkpoint.status = 'recovery_required'; Write-SanitizedJson $resultPath $checkpoint
            }
        }
        throw "The product runtime configuration did not finish: $failure Inspect the private receipt for failed_no_service_mutation, rolled_back or recovery_required; preserve an uncertain operation fence."
    }
}

function Invoke-ProductMain {
    # Read the script parameters by explicit scope: a bare name would resolve
    # through dynamic scoping to any same-named variable of a calling function.
    $operation = $script:Action
    $evidenceArgument = $script:DailyUsageEvidencePath
    if ($operation -ceq 'Plan') {
        if (-not $script:ConfigPath -or -not $script:OutDir) { throw 'Plan requires ConfigPath and OutDir.' }
        $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
        [void](Assert-PrivateInputPath -Path $script:ConfigPath -RepositoryRoot $repo)
        $config = (Read-StrictJsonSnapshot -Path $script:ConfigPath).Value
        $created = New-ProductPlan $config $script:OutDir $script:ApiArn $script:WorkerArn $script:ImageDigest $script:AppSha $evidenceArgument
        Write-Host "Product runtime plan: $($created.path) sha256=$($created.sha256)"
        foreach ($change in @($created.plan.changes)) {
            $from = if ($null -eq $change.from) { '(unset)' } else { $change.from }
            $to = if ($null -eq $change.to) { '(unset)' } else { $change.to }
            Write-Host "  $($change.name): $from -> $to"
        }
        if (@($created.plan.activations).Count) { Write-Host "  activates: $(@($created.plan.activations) -join ', ')" }
        return
    }
    $manifestPath = $script:ManifestPath
    $manifestHash = $script:ManifestHash
    if (-not $script:Execute -or -not $manifestPath -or -not $manifestHash) { throw 'Apply/Rollback requires Execute, ManifestPath and ManifestHash.' }
    if ($evidenceArgument) { throw 'Apply and Rollback use the evidence bound into the plan; do not pass DailyUsageEvidencePath.' }
    $plan = Read-ProductPlan $manifestPath $manifestHash
    $directory = Split-Path -Parent $manifestPath
    if ($operation -ceq 'Rollback') {
        $receiptPath = Join-Path $directory "$($plan.runId)-result.json"
        $receipt = (Read-StrictJsonSnapshot $receiptPath).Value
        if ($receipt.planSha256 -cne $manifestHash -or $receipt.status -cne 'applied') { throw 'Rollback requires a completed, matching activation receipt.' }
        $current = Get-ProductSnapshot $receipt.apiArn $receipt.workerArn $plan.imageDigest $plan.appSha
        $planned = ConvertTo-ProductState $plan.desired
        $prior = ConvertTo-ProductState $plan.prior
        if ((Get-CanonicalJsonSha256 (Get-ProductManagedState $current.Environments[0])) -cne (Get-CanonicalJsonSha256 $planned)) {
            throw 'The live flags no longer match this plan; create a reviewed new plan.'
        }
        $gains = Get-ProductActivations $planned $prior
        if ($gains.Count) { throw 'Rollback cannot activate a previously disabled feature; create a reviewed new plan.' }
        # Restore exactly the prior values of the names this plan changed. A
        # configuration-only rollback keeps the image, admission, IAM, secrets
        # and every unrelated field of the current pair.
        $environment = [ordered]@{}
        foreach ($name in $script:RuntimeEnvironmentNames) {
            if ($planned[$name] -cne $prior[$name]) { $environment[$name] = $prior[$name] }
        }
        $rollbackConfig = [pscustomobject]@{ schemaVersion = 1; environment = [pscustomobject]$environment }
        $created = New-ProductPlan $rollbackConfig $directory $receipt.apiArn $receipt.workerArn $plan.imageDigest $plan.appSha $null
        $plan = $created.plan; $manifestHash = $created.sha256
    }
    $result = Invoke-ProductApply $plan $manifestHash $directory
    Write-Host "Product runtime configuration status=$($result.status) API=$($result.apiArn) worker=$($result.workerArn)"
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-ProductMain }
