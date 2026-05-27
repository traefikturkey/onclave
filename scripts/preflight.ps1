#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$script:Failures = 0
$script:Warnings = 0
$RecommendedNodeMajor = 24
$RepoRoot = Split-Path -Parent $PSScriptRoot
$PackageJsonPath = Join-Path $RepoRoot 'package.json'
$WorkspacePath = Join-Path $RepoRoot 'pnpm-workspace.yaml'
$ExpectedPnpmVersion = $null
$ExpectedPnpmMajor = $null

function Get-PnpmMajorFallback {
    if ($script:ExpectedPnpmMajor) {
        return $script:ExpectedPnpmMajor
    }

    return '10'
}

function Write-StatusLine {
    param(
        [Parameter(Mandatory)]
        [string]$Status,
        [Parameter(Mandatory)]
        [string]$Name,
        [Parameter(Mandatory)]
        [string]$Details
    )

    Write-Host "$Status $Name`: $Details"
}

function Write-HintLine {
    param([Parameter(Mandatory)][string]$Hint)
    Write-Host "    hint: $Hint"
}

function Get-CommandPathSafe {
    param([Parameter(Mandatory)][string]$Name)

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        return $null
    }

    return $command.Source
}

function Get-CommandVersionSafe {
    param([Parameter(Mandatory)][string]$Name)

    $path = Get-CommandPathSafe -Name $Name
    if ($null -eq $path) {
        return $null
    }

    try {
        $output = & $path --version 2>&1 | Select-Object -First 1
        if ($null -eq $output) {
            return $null
        }

        return "$output".Trim()
    } catch {
        return $null
    }
}

function Initialize-PnpmPolicy {
    $packageJson = Get-Content $PackageJsonPath -Raw | ConvertFrom-Json
    if ($packageJson.packageManager -is [string] -and $packageJson.packageManager.StartsWith('pnpm@')) {
        $script:ExpectedPnpmVersion = $packageJson.packageManager.Substring(5)
        $script:ExpectedPnpmMajor = ($script:ExpectedPnpmVersion -split '\.')[0]
    }
}

function Test-Node {
    $nodePath = Get-CommandPathSafe -Name 'node'
    if ($null -eq $nodePath) {
        Write-StatusLine -Status 'FAIL' -Name 'node' -Details 'not found on PATH'
        Write-HintLine -Hint "Install Node.js $RecommendedNodeMajor.x before running repo commands."
        $script:Failures += 1
        return
    }

    $version = (Get-CommandVersionSafe -Name 'node') -replace '^v', ''
    $major = ($version -split '\.')[0]
    if ($major -eq "$RecommendedNodeMajor") {
        Write-StatusLine -Status 'PASS' -Name 'node' -Details "found $version (matches the current validated major $RecommendedNodeMajor.x)"
        return
    }

    Write-StatusLine -Status 'WARN' -Name 'node' -Details "found $version (the repo is currently validated most directly on $RecommendedNodeMajor.x)"
    $script:Warnings += 1
}

function Test-Pnpm {
    $pnpmPath = Get-CommandPathSafe -Name 'pnpm'
    if ($null -eq $pnpmPath) {
        Write-StatusLine -Status 'FAIL' -Name 'pnpm' -Details 'not found on PATH'
        Write-HintLine -Hint "Install pnpm $(Get-PnpmMajorFallback).x and rerun this preflight."
        $script:Failures += 1
        return
    }

    $version = Get-CommandVersionSafe -Name 'pnpm'
    $major = ($version -split '\.')[0]

    if ($script:ExpectedPnpmMajor -and $major -ne $script:ExpectedPnpmMajor) {
        Write-StatusLine -Status 'FAIL' -Name 'pnpm' -Details "found at $pnpmPath ($version; expected pnpm $($script:ExpectedPnpmMajor).x from packageManager $($script:ExpectedPnpmVersion))"
        Write-HintLine -Hint "Use pnpm $($script:ExpectedPnpmMajor).x for this workspace."
        $script:Failures += 1
        return
    }

    if ($script:ExpectedPnpmVersion -and $version -ne $script:ExpectedPnpmVersion) {
        Write-StatusLine -Status 'WARN' -Name 'pnpm' -Details "found at $pnpmPath ($version; root packageManager pins $($script:ExpectedPnpmVersion))"
        Write-HintLine -Hint "Prefer pnpm $($script:ExpectedPnpmVersion) or another $($script:ExpectedPnpmMajor).x release for consistent installs."
        $script:Warnings += 1
        return
    }

    Write-StatusLine -Status 'PASS' -Name 'pnpm' -Details "found at $pnpmPath ($version)"
}

function Test-CommandRequirement {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][ValidateSet('FAIL', 'WARN')][string]$MissingStatus,
        [Parameter(Mandatory)][string]$MissingHint
    )

    $path = Get-CommandPathSafe -Name $Name
    if ($null -eq $path) {
        Write-StatusLine -Status $MissingStatus -Name $Name -Details 'not found on PATH'
        Write-HintLine -Hint $MissingHint
        if ($MissingStatus -eq 'FAIL') {
            $script:Failures += 1
        } else {
            $script:Warnings += 1
        }
        return
    }

    $version = Get-CommandVersionSafe -Name $Name
    $details = if ($version) { "found at $path ($version)" } else { "found at $path" }
    Write-StatusLine -Status 'PASS' -Name $Name -Details $details
}

function Test-RepoFiles {
    $nodeModulesPath = Join-Path $RepoRoot 'node_modules'
    if (Test-Path $nodeModulesPath) {
        Write-StatusLine -Status 'PASS' -Name 'dependencies' -Details 'node_modules directory is present'
    } else {
        Write-StatusLine -Status 'WARN' -Name 'dependencies' -Details 'dependencies do not appear to be installed yet'
        Write-HintLine -Hint 'Run just setup or pnpm install after bootstrap preflight succeeds.'
        $script:Warnings += 1
    }

    if (Test-Path $WorkspacePath) {
        Write-StatusLine -Status 'PASS' -Name 'workspace' -Details 'found pnpm-workspace.yaml'
    } else {
        Write-StatusLine -Status 'FAIL' -Name 'workspace' -Details 'missing pnpm-workspace.yaml'
        Write-HintLine -Hint 'Restore the workspace manifest before adding or installing packages.'
        $script:Failures += 1
    }
}

function Write-NextSteps {
    Write-Host ''
    Write-Host 'Next steps:'

    if ($script:Failures -gt 0) {
        if ($null -eq (Get-CommandPathSafe -Name 'node')) {
            Write-Host "- Install Node.js $RecommendedNodeMajor.x first."
        }
        if ($null -eq (Get-CommandPathSafe -Name 'pnpm')) {
            Write-Host "- Install pnpm $(Get-PnpmMajorFallback).x so workspace commands can run."
        }
        if ($null -eq (Get-CommandPathSafe -Name 'just')) {
            Write-Host '- Install just so you can use the repo command surface from justfile.'
        }
    }

    if (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
        Write-Host '- Run just setup or pnpm install once the required tools are available.'
    }

    Write-Host '- After bootstrap passes, run just preflight-repo or pnpm run preflight:repo for the Node-based repo check.'
    Write-Host '- Run just check before handing off code changes.'
    Write-Host '- Run just pi-local when you need to load the Onclave extension in Pi.'
}

Initialize-PnpmPolicy
Write-Host 'Onclave bootstrap preflight'
Write-Host ''
Write-Host "Repo root: $RepoRoot"
Write-Host ''
Test-Node
Test-Pnpm
Test-CommandRequirement -Name 'just' -MissingStatus 'FAIL' -MissingHint 'Install just so you can use the repo command surface from justfile.'
Test-CommandRequirement -Name 'git' -MissingStatus 'FAIL' -MissingHint 'Install git so repository workflows and project label detection work.'
Test-CommandRequirement -Name 'pi' -MissingStatus 'WARN' -MissingHint 'Install Pi to run local extension loading and Onclave smoke checks.'
Test-RepoFiles
Write-NextSteps

if ($script:Failures -gt 0) {
    exit 1
}
