#requires -Version 7.5

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$loadRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\scripts\load"))
$minimumPowerShellVersion = [Version]"7.5"
$violations = [System.Collections.Generic.List[string]]::new()
$callCount = 0
$filesWithCalls = 0

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Get-ConvertFromJsonCommandName {
    param([System.Management.Automation.Language.CommandAst]$Command)

    $commandName = $Command.GetCommandName()
    if ([string]::IsNullOrWhiteSpace($commandName)) { return $null }
    $leafName = ($commandName -split '\\')[-1]
    if ($leafName -ine "ConvertFrom-Json") { return $null }
    return $commandName
}

function Get-LiteralDateKindArguments {
    param([System.Management.Automation.Language.CommandAst]$Command)

    $arguments = [System.Collections.Generic.List[object]]::new()
    $elements = @($Command.CommandElements)
    for ($index = 0; $index -lt $elements.Count; $index++) {
        $element = $elements[$index]
        if ($element -isnot [System.Management.Automation.Language.CommandParameterAst] -or
            $element.ParameterName -ine "DateKind") {
            continue
        }

        $argument = $element.Argument
        if ($null -eq $argument -and $index + 1 -lt $elements.Count -and
            $elements[$index + 1] -isnot [System.Management.Automation.Language.CommandParameterAst]) {
            $argument = $elements[$index + 1]
        }
        $arguments.Add($argument)
    }
    return @($arguments)
}

$qualifiedTokens = $null
$qualifiedErrors = $null
$qualifiedAst = [System.Management.Automation.Language.Parser]::ParseInput(
    'Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject ''{}'' -DateKind String',
    [ref]$qualifiedTokens,
    [ref]$qualifiedErrors
)
Assert-Condition ($qualifiedErrors.Count -eq 0) "Unable to parse the module-qualified conformance probe."
$qualifiedCommand = $qualifiedAst.Find({
    param($node)
    $node -is [System.Management.Automation.Language.CommandAst] -and
        $null -ne (Get-ConvertFromJsonCommandName -Command $node)
}, $true)
Assert-Condition ($null -ne $qualifiedCommand) "The conformance scanner must detect module-qualified ConvertFrom-Json calls."
$qualifiedDateKind = @(Get-LiteralDateKindArguments -Command $qualifiedCommand)
Assert-Condition (
    $qualifiedDateKind.Count -eq 1 -and
        $qualifiedDateKind[0] -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
        $qualifiedDateKind[0].Value -ceq "String"
) "The conformance scanner must validate module-qualified literal -DateKind String arguments."

$files = @(Get-ChildItem -LiteralPath $loadRoot -Recurse -File | Where-Object {
    $_.Extension -in @(".ps1", ".psm1")
} | Sort-Object FullName)
if ($files.Count -eq 0) { throw "No PowerShell files were discovered under scripts/load." }

foreach ($file in $files) {
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(
        $file.FullName,
        [ref]$tokens,
        [ref]$parseErrors
    )
    $relativePath = [IO.Path]::GetRelativePath((Split-Path $loadRoot -Parent), $file.FullName)
    foreach ($parseError in @($parseErrors)) {
        $violations.Add("$relativePath`:$($parseError.Extent.StartLineNumber): parser error: $($parseError.Message)")
    }
    if ($parseErrors.Count -gt 0) { continue }

    $commands = @($ast.FindAll({
        param($node)
        if ($node -isnot [System.Management.Automation.Language.CommandAst]) { return $false }
        return $null -ne (Get-ConvertFromJsonCommandName -Command $node)
    }, $true))
    if ($commands.Count -eq 0) { continue }

    $filesWithCalls++
    $requiredVersion = $ast.ScriptRequirements.RequiredPSVersion
    if ($null -eq $requiredVersion -or $requiredVersion -lt $minimumPowerShellVersion) {
        $violations.Add("$relativePath`:1: files containing ConvertFrom-Json must require PowerShell 7.5 or newer.")
    }

    foreach ($command in $commands) {
        $callCount++
        $dateKindArguments = @(Get-LiteralDateKindArguments -Command $command)
        $validLiteral = $dateKindArguments.Count -eq 1 -and
            $dateKindArguments[0] -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
            $dateKindArguments[0].Value -ceq "String"
        if (-not $validLiteral) {
            $violations.Add(
                "$relativePath`:$($command.Extent.StartLineNumber): ConvertFrom-Json must contain exactly one literal -DateKind String argument."
            )
        }
    }
}

if ($callCount -eq 0) { throw "No ConvertFrom-Json commands were discovered under scripts/load." }
if ($violations.Count -gt 0) {
    throw ("PowerShell JSON date-kind conformance failed:`n" + ($violations -join "`n"))
}

$timestampCases = [ordered]@{
    zulu = "2026-07-22T15:58:03.1234567Z"
    zeroOffset = "2026-07-22T15:58:03.1234567+00:00"
    nonzeroOffset = "2026-07-22T11:58:03.1234567-04:00"
}
$json = $timestampCases | ConvertTo-Json -Compress
$plain = $json | ConvertFrom-Json -Depth 10 -DateKind String
$hashtable = $json | ConvertFrom-Json -Depth 10 -AsHashtable -DateKind String
$noEnumerate = "[$json]" | ConvertFrom-Json -Depth 10 -NoEnumerate -DateKind String
$jsonLines = @(
    (@{ value = $timestampCases.zulu } | ConvertTo-Json -Compress),
    (@{ value = $timestampCases.zeroOffset } | ConvertTo-Json -Compress),
    (@{ value = $timestampCases.nonzeroOffset } | ConvertTo-Json -Compress)
)
$jsonLineValues = @($jsonLines | ForEach-Object {
    ($_ | ConvertFrom-Json -Depth 10 -DateKind String).value
})
$deepClone = $plain | ConvertTo-Json -Depth 10 -Compress | ConvertFrom-Json -Depth 10 -DateKind String

foreach ($property in $timestampCases.Keys) {
    $expected = [string]$timestampCases[$property]
    $plainValue = $plain.$property
    $hashtableValue = $hashtable[$property]
    $cloneValue = $deepClone.$property
    Assert-Condition ($plainValue -is [string] -and $plainValue -ceq $expected) "Plain JSON decoding changed $property."
    Assert-Condition ($hashtableValue -is [string] -and $hashtableValue -ceq $expected) "Hashtable JSON decoding changed $property."
    Assert-Condition ($cloneValue -is [string] -and $cloneValue -ceq $expected) "JSON deep cloning changed $property."
}
Assert-Condition ($noEnumerate -is [array] -and $noEnumerate.Count -eq 1) "-NoEnumerate must preserve the single-item JSON array."
foreach ($property in $timestampCases.Keys) {
    $expected = [string]$timestampCases[$property]
    $actual = $noEnumerate[0].$property
    Assert-Condition ($actual -is [string] -and $actual -ceq $expected) "-NoEnumerate JSON decoding changed $property."
}
$expectedJsonLineValues = @($timestampCases.Values | ForEach-Object { [string]$_ })
Assert-Condition ($jsonLineValues.Count -eq $expectedJsonLineValues.Count) "JSONL decoding returned an unexpected record count."
for ($index = 0; $index -lt $expectedJsonLineValues.Count; $index++) {
    Assert-Condition (
        $jsonLineValues[$index] -is [string] -and $jsonLineValues[$index] -ceq $expectedJsonLineValues[$index]
    ) "JSONL decoding changed timestamp record $index."
}

Write-Output "PASS: $callCount ConvertFrom-Json call(s) across $filesWithCalls scripts/load file(s) preserve date strings."
