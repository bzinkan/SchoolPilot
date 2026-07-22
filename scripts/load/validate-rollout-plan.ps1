#requires -Version 7.5

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("PublicEcs", "NatRemoved", "NatRollback", "Route53", "Redis", "RdsResize", "RdsNormalize")]
    [string]$Phase,

    [Parameter(Mandatory = $true)]
    [string]$PlanPath,

    [Parameter(Mandatory = $true)]
    [string]$PlanSha256,

    [string]$RollbackPlanPath,
    [string]$RollbackPlanSha256,
    [string]$ForwardPlanPath,
    [string]$ForwardPlanSha256,
    [string]$PublicSubnetEvidencePath,
    [string]$PublicSubnetEvidenceSha256,
    [string]$BudgetAcknowledgementPath,
    [string]$BudgetAcknowledgementSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))

function Resolve-ExternalFile {
    param([string]$Path, [string]$Name)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) {
        throw "$Name must be an absolute external file path."
    }
    $absolute = [IO.Path]::GetFullPath($Path)
    $root = $repositoryRoot.TrimEnd('\', '/')
    if ($absolute -eq $root -or $absolute.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Name must remain outside the repository."
    }
    if (-not (Test-Path -LiteralPath $absolute -PathType Leaf)) { throw "$Name does not exist." }
    $cursor = $absolute
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "$Name must not traverse a reparse point."
            }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
    return $absolute
}

function Assert-FileDigest {
    param([string]$Path, [string]$Expected, [string]$Name)
    $normalized = $Expected.ToLowerInvariant()
    if ($normalized -notmatch '^[0-9a-f]{64}$') { throw "$Name SHA-256 must be exactly 64 lowercase hexadecimal characters." }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $normalized) { throw "$Name SHA-256 does not match the saved file." }
    return $actual
}

function Invoke-TerraformPlanJson {
    param([string]$Path)
    $raw = & terraform show -json $Path 2>&1
    if ($LASTEXITCODE -ne 0) { throw "terraform show -json failed for the saved $Phase plan." }
    try { return (($raw | Out-String).Trim() | ConvertFrom-Json -DateKind String -Depth 60) }
    catch { throw "terraform show -json did not return valid plan JSON." }
}

function Get-PlanActionCounts {
    param($Plan)
    $counts = [ordered]@{ add = 0; change = 0; destroy = 0 }
    foreach ($resource in @($Plan.resource_changes)) {
        $actions = @($resource.change.actions | ForEach-Object { [string]$_ })
        if ($actions.Count -eq 1 -and $actions[0] -eq "no-op") { continue }
        if ($actions.Count -eq 1 -and $actions[0] -eq "create") { $counts.add++; continue }
        if ($actions.Count -eq 1 -and $actions[0] -eq "update") { $counts.change++; continue }
        if ($actions.Count -eq 1 -and $actions[0] -eq "delete") { $counts.destroy++; continue }
        if ($actions.Count -eq 2 -and $actions -contains "create" -and $actions -contains "delete") {
            $counts.add++; $counts.destroy++; continue
        }
        throw "Saved plan contains unsupported actions '$($actions -join ',')' at '$($resource.address)'."
    }
    return $counts
}

function Assert-PlanExecutionMetadata {
    param($Plan, [string]$Contract)
    foreach ($name in @("errored","complete","applyable","deferred_changes")) {
        if ($null -eq $Plan.PSObject.Properties[$name]) {
            throw "$Contract saved plan lacks required Terraform execution metadata '$name'."
        }
    }
    if ($Plan.errored -isnot [bool] -or $Plan.complete -isnot [bool] -or $Plan.applyable -isnot [bool] -or
        $Plan.errored -ne $false -or $Plan.complete -ne $true -or $Plan.applyable -ne $true -or
        @($Plan.deferred_changes).Count -ne 0) {
        throw "$Contract saved plan must be non-errored, complete, applyable, and contain no deferred changes."
    }
    if (@(Get-PlanObjectValue $Plan "resource_drift" @()).Count -ne 0) {
        throw "$Contract saved plan contains unreviewed resource drift."
    }
    $failedChecks = @((Get-PlanObjectValue $Plan "checks" @()) | Where-Object {
        [string](Get-PlanObjectValue $_ "status" "") -in @("fail","error")
    })
    if ($failedChecks.Count -gt 0) { throw "$Contract saved plan contains a failed Terraform check." }
}

function Assert-ExactPlanContract {
    param($Plan, [string]$Contract, [hashtable]$AllowedActions, [int]$Adds, [int]$Changes, [int]$Destroys)
    if ($null -eq $Plan -or [string]::IsNullOrWhiteSpace([string]$Plan.format_version)) {
        throw "$Contract saved plan lacks the Terraform JSON format marker."
    }
    Assert-PlanExecutionMetadata $Plan $Contract
    $effective = @($Plan.resource_changes | Where-Object { @($_.change.actions) -notcontains "no-op" })
    if ($effective.Count -ne $AllowedActions.Count) {
        throw "$Contract saved plan contains an extra, missing, or duplicate resource change."
    }
    foreach ($resource in $effective) {
        $address = [string]$resource.address
        if (-not $AllowedActions.ContainsKey($address)) { throw "$Contract saved plan changes unreviewed resource '$address'." }
        $actual = @($resource.change.actions | ForEach-Object { [string]$_ }) -join ","
        $expected = [string]$AllowedActions[$address]
        if ($actual -notin @($expected -split '\|')) { throw "$Contract saved plan actions for '$address' are '$actual', expected '$expected'." }
    }
    $counts = Get-PlanActionCounts -Plan $Plan
    if ($counts.add -ne $Adds -or $counts.change -ne $Changes -or $counts.destroy -ne $Destroys) {
        throw "$Contract saved plan shape is $($counts.add) add / $($counts.change) change / $($counts.destroy) destroy; expected $Adds/$Changes/$Destroys."
    }
    return $counts
}

function Assert-HashedEvidenceReference {
    param($Reference, [string]$Name)
    if ($null -eq $Reference) { throw "$Name is required." }
    $path = Resolve-ExternalFile -Path ([string]$Reference.path) -Name "$Name.path"
    $sha = Assert-FileDigest -Path $path -Expected ([string]$Reference.sha256) -Name $Name
    return [ordered]@{ path = $path; sha256 = $sha }
}

function Assert-FreshEvidenceTimestamp {
    param([string]$Value, [string]$Name)
    $timestamp = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($Value, [ref]$timestamp)) { throw "$Name must be an ISO-8601 timestamp." }
    $utc = $timestamp.ToUniversalTime()
    $now = [DateTimeOffset]::UtcNow
    if ($utc -gt $now.AddMinutes(5) -or $utc -lt $now.AddHours(-24)) {
        throw "$Name must be fresh within 24 hours and no more than five minutes in the future."
    }
    return $utc
}

function Assert-PublicSubnetEvidence {
    param([string]$Path, [string]$Sha256)
    $resolved = Resolve-ExternalFile -Path $Path -Name "PublicSubnetEvidencePath"
    [void](Assert-FileDigest $resolved $Sha256 "Public ECS subnet evidence")
    try { $evidence = Get-Content -LiteralPath $resolved -Raw | ConvertFrom-Json -DateKind String -Depth 30 }
    catch { throw "Public ECS subnet evidence must contain valid JSON." }
    [void](Assert-FreshEvidenceTimestamp ([string]$evidence.observedAtUtc) "Public ECS subnet evidence observedAtUtc")
    $subnets = @($evidence.subnets)
    $ids = @($subnets | ForEach-Object { [string]$_.subnetId })
    $zones = @($subnets | ForEach-Object { [string]$_.availabilityZone })
    if ([int]$evidence.schemaVersion -ne 1 -or [string]$evidence.type -ne "reviewed_public_ecs_subnets" -or
        [string]$evidence.accountId -ne '135775632425' -or [string]$evidence.region -ne 'us-east-1' -or
        $subnets.Count -ne 2 -or @($ids | Sort-Object -Unique).Count -ne 2 -or
        @($zones | Sort-Object -Unique).Count -ne 2 -or @($ids | Where-Object { $_ -notmatch '^subnet-[0-9a-f]+$' }).Count -gt 0 -or
        @($zones | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -gt 0) {
        throw "Public ECS subnet evidence must bind exactly two unique reviewed subnet IDs in two availability zones."
    }
    return [ordered]@{path=$resolved;sha256=$Sha256.ToLowerInvariant();accountId=[string]$evidence.accountId;region=[string]$evidence.region;subnetIds=@($ids|Sort-Object)}
}

function Assert-RdsBudgetAcknowledgement {
    param([string]$Path, [string]$Sha256, [string]$ResizePlanSha256)
    $resolved = Resolve-ExternalFile -Path $Path -Name "BudgetAcknowledgementPath"
    [void](Assert-FileDigest -Path $resolved -Expected $Sha256 -Name "Budget acknowledgement")
    try { $ack = Get-Content -LiteralPath $resolved -Raw | ConvertFrom-Json -DateKind String -Depth 30 }
    catch { throw "Budget acknowledgement must contain valid JSON." }
    if ([int]$ack.schemaVersion -ne 1 -or [string]$ack.type -ne "rds_resize_budget_acknowledgement" -or
        $ack.approved -ne $true -or [string]::IsNullOrWhiteSpace([string]$ack.approver) -or
        [string]$ack.targetRdsInstanceClass -ne "db.t4g.xlarge" -or
        [string]$ack.resizePlanSha256 -ne $ResizePlanSha256 -or
        [string]$ack.accountId -ne '135775632425' -or [string]$ack.region -ne 'us-east-1' -or
        [string]$ack.currency -ne "USD" -or
        [double]$ack.monthlyBudgetUsd -ne 350.0 -or $ack.temporaryBudgetBreachAcknowledged -ne $true -or
        $ack.pendingOsUpdateHandledSeparately -ne $true -or $ack.orderabilityVerified -ne $true -or
        $ack.pointInTimeRecoveryVerified -ne $true -or $ack.manualSnapshotEncrypted -ne $true -or
        [string]$ack.manualSnapshotArn -notmatch '^arn:aws:rds:us-east-1:135775632425:snapshot:[A-Za-z0-9][A-Za-z0-9-]{0,254}$') {
        throw "RDS resize requires the explicit approved $350 budget, OS-update, orderability, PITR, and encrypted-snapshot acknowledgement."
    }
    $acknowledgedAt = Assert-FreshEvidenceTimestamp ([string]$ack.acknowledgedAtUtc) "Budget acknowledgement acknowledgedAtUtc"
    $price = Assert-HashedEvidenceReference -Reference $ack.awsPriceEvidence -Name "AWS price evidence"
    $projection = Assert-HashedEvidenceReference -Reference $ack.costExplorerProjectionEvidence -Name "Cost Explorer projection evidence"
    $snapshot = Assert-HashedEvidenceReference -Reference $ack.manualSnapshotEvidence -Name "Manual RDS snapshot evidence"
    try { $priceJson = Get-Content -LiteralPath $price.path -Raw | ConvertFrom-Json -DateKind String -Depth 30 }
    catch { throw "AWS price evidence must contain valid JSON." }
    try { $projectionJson = Get-Content -LiteralPath $projection.path -Raw | ConvertFrom-Json -DateKind String -Depth 30 }
    catch { throw "Cost Explorer projection evidence must contain valid JSON." }
    try { $snapshotJson = Get-Content -LiteralPath $snapshot.path -Raw | ConvertFrom-Json -DateKind String -Depth 30 }
    catch { throw "Manual RDS snapshot evidence must contain valid JSON." }
    [void](Assert-FreshEvidenceTimestamp ([string]$priceJson.observedAtUtc) "AWS price evidence observedAtUtc")
    [void](Assert-FreshEvidenceTimestamp ([string]$projectionJson.generatedAtUtc) "Cost Explorer projection generatedAtUtc")
    $snapshotObservedAt = Assert-FreshEvidenceTimestamp ([string]$snapshotJson.observedAtUtc) "Manual RDS snapshot evidence observedAtUtc"
    $snapshotCreatedAt = Assert-FreshEvidenceTimestamp ([string]$snapshotJson.snapshotCreateTimeUtc) "Manual RDS snapshot evidence snapshotCreateTimeUtc"
    if ([int]$priceJson.schemaVersion -ne 1 -or [string]$priceJson.type -ne "aws_rds_price_evidence" -or
        [string]$priceJson.accountId -ne [string]$ack.accountId -or [string]$priceJson.region -ne [string]$ack.region -or
        [string]$priceJson.currency -ne "USD" -or [string]$priceJson.targetRdsInstanceClass -ne "db.t4g.xlarge" -or
        [double]$priceJson.hourlyOnDemandUsd -le 0 -or [double]$priceJson.estimatedMonthlyUsd -le 0 -or
        [string]$priceJson.sourceUrl -notmatch '^https://aws\.amazon\.com/(?:rds|pricing)/') {
        throw "AWS price evidence must be typed and bind the exact account, region, currency, and db.t4g.xlarge price."
    }
    if ([int]$projectionJson.schemaVersion -ne 1 -or [string]$projectionJson.type -ne "rds_cost_explorer_projection" -or
        [string]$projectionJson.accountId -ne [string]$ack.accountId -or [string]$projectionJson.region -ne [string]$ack.region -or
        [string]$projectionJson.currency -ne "USD" -or [string]$projectionJson.targetRdsInstanceClass -ne "db.t4g.xlarge" -or
        [double]$projectionJson.monthlyEstimateUsd -le 0 -or [double]$projectionJson.monthlyBudgetUsd -ne 350.0) {
        throw "Cost Explorer projection must be typed and bind the exact account, region, currency, target class, estimate, and $350 budget."
    }
    if ([int]$snapshotJson.schemaVersion -ne 1 -or [string]$snapshotJson.type -ne "rds_manual_snapshot_evidence" -or
        [string]$snapshotJson.accountId -ne '135775632425' -or [string]$snapshotJson.region -ne 'us-east-1' -or
        [string]$snapshotJson.snapshotArn -ne [string]$ack.manualSnapshotArn -or
        [string]$snapshotJson.sourceDbInstanceIdentifier -ne 'schoolpilot-production-db' -or
        [string]$snapshotJson.sourceDbInstanceClass -ne 'db.t4g.medium' -or
        [string]$snapshotJson.engine -ne 'postgres' -or [string]$snapshotJson.status -ne 'available' -or
        $snapshotJson.encrypted -ne $true -or [string]::IsNullOrWhiteSpace([string]$snapshotJson.kmsKeyId) -or
        $snapshotCreatedAt -gt $snapshotObservedAt) {
        throw "Manual RDS snapshot evidence must be fresh, available, encrypted, and bind the exact production source DB and snapshot ARN."
    }
    return [ordered]@{
        path = $resolved
        sha256 = $Sha256.ToLowerInvariant()
        approver = [string]$ack.approver
        acknowledgedAtUtc = $acknowledgedAt.ToUniversalTime().ToString("o")
        priceEvidence = $price
        costExplorerProjectionEvidence = $projection
        manualSnapshotEvidence = $snapshot
    }
}

function Get-PlanObjectValue {
    param($Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    $member = $Object.PSObject.Properties[$Name]
    if ($null -eq $member -or $null -eq $member.Value) { return $Default }
    return $member.Value
}

function ConvertTo-PlanComparableJson {
    param($Value)
    if ($null -eq $Value) { return "null" }
    return ($Value | ConvertTo-Json -Depth 60 -Compress)
}

function Get-TextSha256 {
    param([string]$Text)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.UTF8Encoding]::new($false).GetBytes($Text))).ToLowerInvariant()
}

function Get-TrueUnknownLeafPaths {
    param($Value, [string]$Prefix = "")
    if ($null -eq $Value -or $Value -eq $false) { return @() }
    if ($Value -eq $true) { return @($Prefix) }
    if ($Value -is [Collections.IDictionary]) {
        $results = @()
        foreach ($key in $Value.Keys) {
            $path = if ($Prefix) { "$Prefix.$key" } else { [string]$key }
            $results += @(Get-TrueUnknownLeafPaths $Value[$key] $path)
        }
        return $results
    }
    if ($Value -is [Collections.IEnumerable] -and $Value -isnot [string]) {
        $results = @(); $index = 0
        foreach ($item in $Value) {
            $path = if ($Prefix) { "$Prefix[$index]" } else { "[$index]" }
            $results += @(Get-TrueUnknownLeafPaths $item $path); $index++
        }
        return $results
    }
    $results = @()
    foreach ($property in @($Value.PSObject.Properties)) {
        $path = if ($Prefix) { "$Prefix.$($property.Name)" } else { $property.Name }
        $results += @(Get-TrueUnknownLeafPaths $property.Value $path)
    }
    return $results
}

function Get-ChangedTopLevelFields {
    param($Before, $After)
    $names = @(@($Before.PSObject.Properties.Name) + @($After.PSObject.Properties.Name) | Sort-Object -Unique)
    return @($names | Where-Object {
        (ConvertTo-PlanComparableJson (Get-PlanObjectValue $Before $_)) -cne
        (ConvertTo-PlanComparableJson (Get-PlanObjectValue $After $_))
    })
}

function Assert-OnlyReviewedTopLevelChanges {
    param($Resource, [string[]]$Allowed, [string[]]$Required, [string[]]$AllowedUnknown = @())
    $before = $Resource.change.before
    $after = $Resource.change.after
    if ($null -eq $before -or $null -eq $after) { throw "'$($Resource.address)' must be an in-place/replacement change with before/after values." }
    $changed = @(Get-ChangedTopLevelFields $before $after)
    $unexpected = @($changed | Where-Object { $_ -notin $Allowed })
    $missing = @($Required | Where-Object { $_ -notin $changed })
    if ($unexpected.Count -gt 0 -or $missing.Count -gt 0) {
        throw "'$($Resource.address)' changed unreviewed fields [$($unexpected -join ',')] or omitted required fields [$($missing -join ',')]."
    }
    $unknown = Get-PlanObjectValue $Resource.change "after_unknown"
    if ($null -ne $unknown) {
        $unknownTrue = @(Get-TrueUnknownLeafPaths $unknown)
        $unknownUnexpected = @($unknownTrue | Where-Object { $_ -notin $AllowedUnknown })
        if ($unknownUnexpected.Count -gt 0) {
            throw "'$($Resource.address)' contains unreviewed provider-unknown fields [$($unknownUnexpected -join ',')]."
        }
    }
}

function Get-ExactPlanResource {
    param($Plan, [string]$Address)
    $matches = @($Plan.resource_changes | Where-Object address -eq $Address)
    if ($matches.Count -ne 1) { throw "Saved plan must contain exactly one '$Address' change." }
    return $matches[0]
}

function Get-EcsNetworkConfiguration {
    param($Value)
    $network = @(Get-PlanObjectValue $Value "network_configuration" @())
    if ($network.Count -ne 1) { throw "ECS service plan must contain exactly one network_configuration block." }
    return $network[0]
}

function Assert-PublicEcsFields {
    param($Plan, [string[]]$ReviewedPublicSubnetIds)
    $afterNetworks = @()
    foreach ($address in @("module.ecs.aws_ecs_service.api","module.ecs.aws_ecs_service.worker")) {
        $resource = Get-ExactPlanResource $Plan $address
        Assert-OnlyReviewedTopLevelChanges $resource @("network_configuration") @("network_configuration")
        $beforeNetwork = Get-EcsNetworkConfiguration $resource.change.before
        $afterNetwork = Get-EcsNetworkConfiguration $resource.change.after
        if ([bool](Get-PlanObjectValue $beforeNetwork "assign_public_ip" $false) -ne $false -or
            [bool](Get-PlanObjectValue $afterNetwork "assign_public_ip" $false) -ne $true -or
            (ConvertTo-PlanComparableJson (Get-PlanObjectValue $beforeNetwork "security_groups" @())) -cne
            (ConvertTo-PlanComparableJson (Get-PlanObjectValue $afterNetwork "security_groups" @()))) {
            throw "PublicEcs may only move each ECS service from private to public-task egress while preserving security groups."
        }
        $beforeSubnets = @((Get-PlanObjectValue $beforeNetwork "subnets" @()) | Sort-Object)
        $afterSubnets = @((Get-PlanObjectValue $afterNetwork "subnets" @()) | Sort-Object)
        if ($beforeSubnets.Count -lt 1 -or $afterSubnets.Count -lt 1 -or
            @(Compare-Object $beforeSubnets $afterSubnets).Count -eq 0 -or
            @(Compare-Object @($ReviewedPublicSubnetIds|Sort-Object) $afterSubnets).Count -ne 0) {
            throw "PublicEcs must replace the private subnet set with the exact hashed reviewed public subnet set."
        }
        $afterNetworks += ConvertTo-PlanComparableJson $afterNetwork
    }
    if ($afterNetworks[0] -cne $afterNetworks[1]) { throw "PublicEcs API and worker must converge on the exact same public network posture." }
    $alb = Get-ExactPlanResource $Plan "module.alb.aws_lb.main"
    if ((@($alb.change.actions | ForEach-Object {[string]$_}) -join ',') -ne "no-op") { throw "PublicEcs must preserve the existing ALB as an exact no-op." }
    $albSubnets = @((Get-PlanObjectValue $alb.change.after "subnets" @()) | Sort-Object)
    if (@(Compare-Object @($ReviewedPublicSubnetIds|Sort-Object) $albSubnets).Count -ne 0) {
        throw "PublicEcs reviewed task subnets must equal the preserved public ALB subnet set."
    }
    $apiResource = Get-ExactPlanResource $Plan "module.ecs.aws_ecs_service.api"
    $network = Get-EcsNetworkConfiguration $apiResource.change.after
    $canonical = [ordered]@{awsvpcConfiguration=[ordered]@{
        subnets=@((Get-PlanObjectValue $network "subnets" @())|Sort-Object)
        securityGroups=@((Get-PlanObjectValue $network "security_groups" @())|Sort-Object)
        assignPublicIp="ENABLED"
    }}
    $json = $canonical | ConvertTo-Json -Depth 10 -Compress
    return [ordered]@{canonicalNetwork=$canonical;canonicalNetworkSha256=Get-TextSha256 $json}
}

function Assert-RdsFields {
    param($Plan, [bool]$Normalize)
    $resource = Get-ExactPlanResource $Plan "module.rds.aws_db_instance.main"
    $allowed = if ($Normalize) { @("apply_immediately") } else { @("instance_class","apply_immediately") }
    Assert-OnlyReviewedTopLevelChanges $resource $allowed @("apply_immediately")
    $before = $resource.change.before; $after = $resource.change.after
    foreach ($identity in @("identifier","engine","engine_version","allocated_storage","max_allocated_storage","storage_type","storage_encrypted","multi_az","publicly_accessible","db_subnet_group_name","vpc_security_group_ids")) {
        if ((ConvertTo-PlanComparableJson (Get-PlanObjectValue $before $identity)) -cne
            (ConvertTo-PlanComparableJson (Get-PlanObjectValue $after $identity))) {
            throw "RDS plan changes sensitive identity/posture field '$identity'."
        }
    }
    if ($Normalize) {
        if ([string](Get-PlanObjectValue $before "instance_class") -ne "db.t4g.xlarge" -or
            [string](Get-PlanObjectValue $after "instance_class") -ne "db.t4g.xlarge" -or
            [bool](Get-PlanObjectValue $before "apply_immediately" $false) -ne $true -or
            [bool](Get-PlanObjectValue $after "apply_immediately" $true) -ne $false) {
            throw "RdsNormalize must keep db.t4g.xlarge and change only apply_immediately true to false."
        }
    }
    elseif ([string](Get-PlanObjectValue $before "instance_class") -ne "db.t4g.medium" -or
        [string](Get-PlanObjectValue $after "instance_class") -ne "db.t4g.xlarge" -or
        [bool](Get-PlanObjectValue $after "apply_immediately" $false) -ne $true) {
        throw "RdsResize must change the existing db.t4g.medium instance to db.t4g.xlarge with apply_immediately=true."
    }
}

function Assert-RedisFields {
    param($Plan)
    $resource = Get-ExactPlanResource $Plan "module.redis.aws_elasticache_replication_group.main"
    Assert-OnlyReviewedTopLevelChanges $resource @("node_type") @("node_type")
    $before=$resource.change.before;$after=$resource.change.after
    foreach ($identity in @("replication_group_id","engine","engine_version","port","subnet_group_name","security_group_ids","at_rest_encryption_enabled","transit_encryption_enabled","automatic_failover_enabled","multi_az_enabled")) {
        if ((ConvertTo-PlanComparableJson (Get-PlanObjectValue $before $identity)) -cne
            (ConvertTo-PlanComparableJson (Get-PlanObjectValue $after $identity))) { throw "Redis plan changes sensitive identity/posture field '$identity'." }
    }
    if ([string](Get-PlanObjectValue $after "node_type") -ne "cache.t4g.micro" -or
        [string](Get-PlanObjectValue $before "node_type") -ne "cache.t4g.small" -or
        [bool](Get-PlanObjectValue $before "apply_immediately" $false) -ne $true -or
        [bool](Get-PlanObjectValue $after "apply_immediately" $false) -ne $true) {
        throw "Redis plan must change only node_type from cache.t4g.small to cache.t4g.micro while preserving apply_immediately=true."
    }
}

function Assert-Route53Fields {
    param($Plan)
    $health = Get-ExactPlanResource $Plan "aws_route53_health_check.schoolpilot_public_health[0]"
    Assert-OnlyReviewedTopLevelChanges $health @("measure_latency","id") @("measure_latency") @("id")
    if ([bool](Get-PlanObjectValue $health.change.before "measure_latency" $false) -ne $true -or
        [bool](Get-PlanObjectValue $health.change.after "measure_latency" $true) -ne $false) {
        throw "Route53 health-check replacement must change only measure_latency true to false."
    }
    foreach ($field in @("type","fqdn","port","resource_path","request_interval","failure_threshold")) {
        if ((ConvertTo-PlanComparableJson (Get-PlanObjectValue $health.change.before $field)) -cne
            (ConvertTo-PlanComparableJson (Get-PlanObjectValue $health.change.after $field))) { throw "Route53 plan changes reviewed health-check field '$field'." }
    }
    if ([string](Get-PlanObjectValue $health.change.before "type") -ne "HTTPS" -or
        [string](Get-PlanObjectValue $health.change.after "type") -ne "HTTPS" -or
        [int](Get-PlanObjectValue $health.change.before "port" 0) -ne 443 -or
        [int](Get-PlanObjectValue $health.change.after "port" 0) -ne 443 -or
        [string](Get-PlanObjectValue $health.change.before "resource_path") -ne "/health" -or
        [string](Get-PlanObjectValue $health.change.after "resource_path") -ne "/health") {
        throw "Route53 replacement must preserve the exact HTTPS/443 /health checker contract."
    }
    $alarm = Get-ExactPlanResource $Plan "aws_cloudwatch_metric_alarm.synthetic_public_health[0]"
    Assert-OnlyReviewedTopLevelChanges $alarm @("dimensions") @("dimensions") @("dimensions.HealthCheckId")
    foreach ($field in @("alarm_name","namespace","metric_name","comparison_operator","threshold","period","evaluation_periods","treat_missing_data","alarm_actions")) {
        if ((ConvertTo-PlanComparableJson (Get-PlanObjectValue $alarm.change.before $field)) -cne
            (ConvertTo-PlanComparableJson (Get-PlanObjectValue $alarm.change.after $field))) { throw "Route53 alarm update changes sensitive field '$field'." }
    }
    $beforeDimensions = Get-PlanObjectValue $alarm.change.before "dimensions"
    $afterDimensions = Get-PlanObjectValue $alarm.change.after "dimensions"
    $beforeDimensionNames = @($beforeDimensions.PSObject.Properties.Name)
    $afterDimensionNames = @($afterDimensions.PSObject.Properties.Name)
    $oldHealthCheckId = [string](Get-PlanObjectValue $beforeDimensions "HealthCheckId" "")
    $newHealthCheckId = [string](Get-PlanObjectValue $afterDimensions "HealthCheckId" "")
    $unknownLeaves = @(Get-TrueUnknownLeafPaths (Get-PlanObjectValue $alarm.change "after_unknown"))
    $computedRetarget = $unknownLeaves -contains "dimensions.HealthCheckId"
    if ($beforeDimensionNames.Count -ne 1 -or $beforeDimensionNames[0] -ne "HealthCheckId" -or
        $afterDimensionNames.Count -ne 1 -or $afterDimensionNames[0] -ne "HealthCheckId" -or
        [string]::IsNullOrWhiteSpace($oldHealthCheckId) -or
        (-not $computedRetarget -and ([string]::IsNullOrWhiteSpace($newHealthCheckId) -or $newHealthCheckId -eq $oldHealthCheckId))) {
        throw "Route53 alarm must retarget its exact single HealthCheckId dimension from the old checker to the replacement checker."
    }
}

function Get-NatAddresses {
    return @(
        "module.vpc.aws_eip.nat[0]", "module.vpc.aws_eip.nat[1]",
        "module.vpc.aws_nat_gateway.main[0]", "module.vpc.aws_nat_gateway.main[1]",
        "module.vpc.aws_route.private_nat[0]", "module.vpc.aws_route.private_nat[1]"
    )
}

function Find-ConfigurationResources {
    param($Node, [string]$Address)
    if ($null -eq $Node) { return @() }
    $matches = @()
    if ([string](Get-PlanObjectValue $Node "address" "") -eq $Address) { $matches += $Node }
    if ($Node -is [Collections.IEnumerable] -and $Node -isnot [string]) {
        foreach ($item in $Node) { $matches += @(Find-ConfigurationResources $item $Address) }
    }
    else {
        foreach ($property in @($Node.PSObject.Properties)) {
            if ($property.Name -in @("address","references","constant_value")) { continue }
            $matches += @(Find-ConfigurationResources $property.Value $Address)
        }
    }
    return $matches
}

function Assert-NatConfigurationReferences {
    param($Plan)
    $natResources = @(Find-ConfigurationResources $Plan.configuration "aws_nat_gateway.main")
    $routeResources = @(Find-ConfigurationResources $Plan.configuration "aws_route.private_nat")
    if ($natResources.Count -ne 1 -or $routeResources.Count -ne 1) {
        throw "NAT rollback plan must expose the reviewed NAT gateway and route configuration expressions."
    }
    $allocationReferences = @((Get-PlanObjectValue (Get-PlanObjectValue $natResources[0].expressions "allocation_id") "references" @()) | ForEach-Object { [string]$_ })
    $gatewayReferences = @((Get-PlanObjectValue (Get-PlanObjectValue $routeResources[0].expressions "nat_gateway_id") "references" @()) | ForEach-Object { [string]$_ })
    if (@($allocationReferences | Where-Object { $_ -match '^aws_eip\.nat(?:\[|\.|$)' }).Count -lt 1 -or
        @($gatewayReferences | Where-Object { $_ -match '^aws_nat_gateway\.main(?:\[|\.|$)' }).Count -lt 1) {
        throw "NAT rollback allocation_id and nat_gateway_id must reference the reviewed same-index EIP and NAT resources."
    }
}

function Assert-NatForwardTopology {
    param($Plan)
    $subnets = @(); $routeTables = @()
    $eips = @(); $gateways = @(); $routes = @()
    foreach ($address in Get-NatAddresses) {
        $resource = Get-ExactPlanResource $Plan $address
        $value = $resource.change.before
        if ($null -eq $value) { throw "NAT removal lacks concrete before-state at '$address'." }
        if ($address -match 'aws_eip\.nat') {
            if ([string](Get-PlanObjectValue $value "domain" "") -ne "vpc") { throw "NAT EIP must be VPC-scoped." }
            $eips += [ordered]@{
                address = $address
                domain = "vpc"
                allocationId = [string](Get-PlanObjectValue $value "allocation_id" "")
                publicIp = [string](Get-PlanObjectValue $value "public_ip" "")
            }
        }
        elseif ($address -match 'aws_nat_gateway\.main') {
            $subnet = [string](Get-PlanObjectValue $value "subnet_id" "")
            $allocationId = [string](Get-PlanObjectValue $value "allocation_id" "")
            if ($subnet -notmatch '^subnet-[0-9a-f]+$' -or [string](Get-PlanObjectValue $value "connectivity_type" "") -ne "public" -or
                [string]::IsNullOrWhiteSpace($allocationId)) {
                throw "NAT removal must preserve concrete public connectivity, subnet, and allocation wiring evidence."
            }
            $subnets += $subnet
            $gateways += [ordered]@{address=$address;subnetId=$subnet;allocationId=$allocationId;connectivityType="public"}
        }
        else {
            $routeTable = [string](Get-PlanObjectValue $value "route_table_id" "")
            $natGatewayId = [string](Get-PlanObjectValue $value "nat_gateway_id" "")
            if ([string](Get-PlanObjectValue $value "destination_cidr_block" "") -ne "0.0.0.0/0" -or
                $routeTable -notmatch '^rtb-[0-9a-f]+$' -or
                [string]::IsNullOrWhiteSpace($natGatewayId)) {
                throw "NAT removal must preserve concrete per-AZ default-route wiring evidence."
            }
            $routeTables += $routeTable
            $routes += [ordered]@{address=$address;routeTableId=$routeTable;destinationCidrBlock="0.0.0.0/0";natGatewayId=$natGatewayId}
        }
    }
    if (@($subnets|Sort-Object -Unique).Count -ne 2 -or @($routeTables|Sort-Object -Unique).Count -ne 2) {
        throw "NAT removal must bind two distinct AZ subnet and private route-table paths."
    }
    return [ordered]@{eips=$eips;natGateways=$gateways;routes=$routes}
}

function Assert-NatRollbackInverse {
    param($RollbackPlan, $ForwardPlan)
    Assert-NatConfigurationReferences $RollbackPlan
    $subnets = @(); $routeTables = @()
    foreach ($address in Get-NatAddresses) {
        $forward = Get-ExactPlanResource $ForwardPlan $address
        $rollback = Get-ExactPlanResource $RollbackPlan $address
        $before = $forward.change.before; $after = $rollback.change.after
        if ($null -eq $before -or $null -eq $after) { throw "NAT rollback inverse lacks concrete compared state at '$address'." }
        $unknown = @(Get-TrueUnknownLeafPaths (Get-PlanObjectValue $rollback.change "after_unknown"))
        if ($address -match 'aws_eip\.nat') {
            foreach ($field in @("domain","tags")) {
                if ((ConvertTo-PlanComparableJson (Get-PlanObjectValue $before $field)) -cne
                    (ConvertTo-PlanComparableJson (Get-PlanObjectValue $after $field))) { throw "NAT rollback EIP '$address' changed stable field '$field'." }
            }
            $allowed = @("id","allocation_id","association_id","carrier_ip","customer_owned_ip","network_border_group","private_dns","private_ip","public_dns","public_ip")
        }
        elseif ($address -match 'aws_nat_gateway\.main') {
            foreach ($field in @("connectivity_type","subnet_id","tags")) {
                if ((ConvertTo-PlanComparableJson (Get-PlanObjectValue $before $field)) -cne
                    (ConvertTo-PlanComparableJson (Get-PlanObjectValue $after $field))) { throw "NAT rollback gateway '$address' changed stable field '$field'." }
            }
            if ($unknown -notcontains "allocation_id") { throw "NAT rollback gateway '$address' must compute allocation_id from its EIP reference." }
            $subnets += [string](Get-PlanObjectValue $after "subnet_id" "")
            $allowed = @("id","allocation_id","network_interface_id","private_ip","public_ip","association_id")
        }
        else {
            foreach ($field in @("destination_cidr_block","route_table_id")) {
                if ((ConvertTo-PlanComparableJson (Get-PlanObjectValue $before $field)) -cne
                    (ConvertTo-PlanComparableJson (Get-PlanObjectValue $after $field))) { throw "NAT rollback route '$address' changed stable field '$field'." }
            }
            if ($unknown -notcontains "nat_gateway_id") { throw "NAT rollback route '$address' must compute nat_gateway_id from its NAT reference." }
            $routeTables += [string](Get-PlanObjectValue $after "route_table_id" "")
            $allowed = @("id","nat_gateway_id","origin","state")
        }
        $unexpected = @($unknown | Where-Object { $_ -notin $allowed })
        if ($unexpected.Count -gt 0) { throw "NAT rollback '$address' contains unreviewed nested unknown leaves [$($unexpected -join ',')]." }
    }
    if (@($subnets|Sort-Object -Unique).Count -ne 2 -or @($routeTables|Sort-Object -Unique).Count -ne 2) {
        throw "NAT rollback cross-wires the two per-AZ subnet or route-table paths."
    }
}

$resolvedPlan = Resolve-ExternalFile -Path $PlanPath -Name "PlanPath"
$resolvedPlanSha = Assert-FileDigest -Path $resolvedPlan -Expected $PlanSha256 -Name "$Phase plan"
$plan = Invoke-TerraformPlanJson -Path $resolvedPlan
$publicSubnetBinding = $null
$contract = switch ($Phase) {
    "PublicEcs" {
        if (-not $PublicSubnetEvidencePath -or -not $PublicSubnetEvidenceSha256) {
            throw "PublicEcs requires hashed reviewed public-subnet evidence."
        }
        $publicSubnetBinding = Assert-PublicSubnetEvidence $PublicSubnetEvidencePath $PublicSubnetEvidenceSha256
        $counts = Assert-ExactPlanContract $plan $Phase @{
            "module.ecs.aws_ecs_service.api" = "update"
            "module.ecs.aws_ecs_service.worker" = "update"
        } 0 2 0
        $networkBinding = Assert-PublicEcsFields $plan $publicSubnetBinding.subnetIds
        [ordered]@{counts=$counts;network=$networkBinding}
    }
    "NatRemoved" {
        $destroyActions = @{}
        foreach ($address in @(
            "module.vpc.aws_eip.nat[0]", "module.vpc.aws_eip.nat[1]",
            "module.vpc.aws_nat_gateway.main[0]", "module.vpc.aws_nat_gateway.main[1]",
            "module.vpc.aws_route.private_nat[0]", "module.vpc.aws_route.private_nat[1]"
        )) { $destroyActions[$address] = "delete" }
        $forward = Assert-ExactPlanContract $plan $Phase $destroyActions 0 0 6
        $topology = Assert-NatForwardTopology $plan
        $forward["preDestroyRecoveryContract"] = [ordered]@{
            schemaVersion = 1
            type = "nat_pre_destroy_recovery_contract"
            forwardPlanSha256 = $resolvedPlanSha
            expectedRollbackShape = [ordered]@{add=6;change=0;destroy=0}
            resourceAddresses = @(Get-NatAddresses)
            exactForwardTopology = $topology
        }
        $forward
    }
    "NatRollback" {
        if (-not $ForwardPlanPath -or -not $ForwardPlanSha256) {
            throw "NatRollback requires the hashed, previously validated NatRemoved forward plan."
        }
        $forwardPath = Resolve-ExternalFile $ForwardPlanPath "ForwardPlanPath"
        $forwardSha = Assert-FileDigest $forwardPath $ForwardPlanSha256 "NatRemoved forward plan"
        $forwardJson = Invoke-TerraformPlanJson $forwardPath
        $destroyActions = @{}; foreach ($address in Get-NatAddresses) { $destroyActions[$address] = "delete" }
        $forwardCounts = Assert-ExactPlanContract $forwardJson "NatRemoved forward" $destroyActions 0 0 6
        $forwardTopology = Assert-NatForwardTopology $forwardJson
        $createActions = @{}
        foreach ($address in $destroyActions.Keys) { $createActions[$address] = "create" }
        $rollbackCounts = Assert-ExactPlanContract $plan "NatRollback" $createActions 6 0 0
        Assert-NatRollbackInverse $plan $forwardJson
        [ordered]@{forward=$forwardCounts;rollback=$rollbackCounts;forwardPlanPath=$forwardPath;forwardPlanSha256=$forwardSha;exactForwardTopology=$forwardTopology}
    }
    "Route53" {
        $counts = Assert-ExactPlanContract $plan $Phase @{
            "aws_route53_health_check.schoolpilot_public_health[0]" = "create,delete"
            "aws_cloudwatch_metric_alarm.synthetic_public_health[0]" = "update"
        } 1 1 1
        Assert-Route53Fields $plan
        $counts
    }
    "Redis" {
        $counts = Assert-ExactPlanContract $plan $Phase @{ "module.redis.aws_elasticache_replication_group.main" = "update" } 0 1 0
        Assert-RedisFields $plan
        $counts
    }
    "RdsResize" {
        $counts = Assert-ExactPlanContract $plan $Phase @{ "module.rds.aws_db_instance.main" = "update" } 0 1 0
        Assert-RdsFields $plan $false
        $counts
    }
    "RdsNormalize" {
        $counts = Assert-ExactPlanContract $plan $Phase @{ "module.rds.aws_db_instance.main" = "update" } 0 1 0
        Assert-RdsFields $plan $true
        $counts
    }
}

$budget = $null
if ($Phase -eq "RdsResize") {
    if (-not $BudgetAcknowledgementPath -or -not $BudgetAcknowledgementSha256) {
        throw "RdsResize requires explicit BudgetAcknowledgementPath and BudgetAcknowledgementSha256."
    }
    $budget = Assert-RdsBudgetAcknowledgement -Path $BudgetAcknowledgementPath -Sha256 $BudgetAcknowledgementSha256 -ResizePlanSha256 $resolvedPlanSha
}
elseif ($BudgetAcknowledgementPath -or $BudgetAcknowledgementSha256) {
    throw "Budget acknowledgement parameters are accepted only for RdsResize."
}
if ($Phase -ne "PublicEcs" -and ($PublicSubnetEvidencePath -or $PublicSubnetEvidenceSha256)) {
    throw "Public subnet evidence parameters are accepted only for PublicEcs."
}
if ($Phase -ne "NatRollback" -and ($ForwardPlanPath -or $ForwardPlanSha256)) {
    throw "Forward-plan parameters are accepted only for NatRollback."
}
if ($RollbackPlanPath -or $RollbackPlanSha256) {
    throw "The circular pre-destroy rollback-plan parameters are retired; validate the post-destroy add plan with Phase NatRollback."
}

[ordered]@{
    schemaVersion = 1
    type = "schoolpilot_saved_plan_validation"
    valid = $true
    phase = $Phase
    planPath = $resolvedPlan
    planSha256 = $resolvedPlanSha
    shape = $contract
    publicSubnetEvidence = $publicSubnetBinding
    budgetAcknowledgement = $budget
} | ConvertTo-Json -Depth 20
