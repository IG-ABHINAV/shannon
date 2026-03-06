#!/usr/bin/env pwsh

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ComposeFile = Join-Path $ScriptDir 'docker-compose.yml'

function Import-EnvFile {
  $envFile = Join-Path $ScriptDir '.env'
  if (-not (Test-Path $envFile)) {
    return
  }

  Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) {
      return
    }

    $parts = $line -split '=', 2
    if ($parts.Count -ne 2) {
      return
    }

    $name = $parts[0].Trim()
    $value = $parts[1].Trim().Trim('"').Trim("'")
    [System.Environment]::SetEnvironmentVariable($name, $value, 'Process')
  }
}

function Show-Help {
  @'
Shannon CLI

Usage:
  .\shannon.ps1 start URL=<url> REPO=<name>
  .\shannon.ps1 logs ID=<workflow-id>
  .\shannon.ps1 query ID=<workflow-id>
  .\shannon.ps1 stop [CLEAN=true]
  .\shannon.ps1 help

Options for start:
  URL=<url>             Target application URL
  REPO=<name>           Folder name under .\repos\
  CONFIG=<path>         YAML configuration file
  OUTPUT=<path>         Output directory for reports
  PIPELINE_TESTING=true Use minimal prompts for fast testing
  REBUILD=true          Rebuild the worker image with --no-cache
  ROUTER=true           Route requests through claude-code-router
'@ | Write-Host
}

function Parse-KeyValueArgs {
  param([string[]]$Arguments)

  $parsed = @{}
  foreach ($arg in $Arguments) {
    if ($arg -match '^(?<key>[^=]+)=(?<value>.*)$') {
      $parsed[$matches['key'].ToUpperInvariant()] = $matches['value']
    }
  }

  return $parsed
}

function Test-TemporalReady {
  try {
    $output = docker compose -f $ComposeFile exec -T temporal temporal operator cluster health --address localhost:7233 2>$null
    return $LASTEXITCODE -eq 0 -and ($output | Out-String) -match 'SERVING'
  } catch {
    return $false
  }
}

function Ensure-Containers {
  param([hashtable]$Options)

  if ($Options.ContainsKey('OUTPUT_DIR')) {
    Write-Host 'Ensuring worker has correct output mount...'
    docker compose -f $ComposeFile up -d worker | Out-Null
  }

  if (Test-TemporalReady) {
    return
  }

  Write-Host 'Starting Shannon containers...'
  if ($Options.REBUILD -eq 'true') {
    Write-Host 'Rebuilding worker image with --no-cache...'
    docker compose -f $ComposeFile build --no-cache worker
  }

  docker compose -f $ComposeFile up -d --build

  Write-Host 'Waiting for Temporal to be ready...'
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    if (Test-TemporalReady) {
      Write-Host 'Temporal is ready.'
      return
    }
  }

  throw 'Timeout waiting for Temporal to become ready.'
}

function Resolve-RepoPath {
  param([string]$Repo)

  if ($Repo.StartsWith('/benchmarks/') -or $Repo.StartsWith('/repos/')) {
    return $Repo
  }

  $localRepo = Join-Path $ScriptDir 'repos' | Join-Path -ChildPath $Repo
  if (-not (Test-Path $localRepo)) {
    throw "Repository not found at $localRepo"
  }

  return "/repos/$Repo"
}

function Start-Shannon {
  param([hashtable]$ArgsMap)

  $url = if ($ArgsMap.ContainsKey('URL')) { $ArgsMap['URL'] } else { $null }
  $repo = if ($ArgsMap.ContainsKey('REPO')) { $ArgsMap['REPO'] } else { $null }
  $routerFlag = if ($ArgsMap.ContainsKey('ROUTER')) { $ArgsMap['ROUTER'] } else { $null }
  $rebuildFlag = if ($ArgsMap.ContainsKey('REBUILD')) { $ArgsMap['REBUILD'] } else { $null }
  $configPath = if ($ArgsMap.ContainsKey('CONFIG')) { $ArgsMap['CONFIG'] } else { $null }
  $outputPath = if ($ArgsMap.ContainsKey('OUTPUT')) { $ArgsMap['OUTPUT'] } else { $null }
  $pipelineTesting = if ($ArgsMap.ContainsKey('PIPELINE_TESTING')) { $ArgsMap['PIPELINE_TESTING'] } else { $null }

  if (-not $url -or -not $repo) {
    throw 'URL and REPO are required. Example: .\shannon.ps1 start URL=https://example.com REPO=my-repo'
  }

  $hasAnthropic = -not [string]::IsNullOrWhiteSpace($env:ANTHROPIC_API_KEY)
  $hasOauth = -not [string]::IsNullOrWhiteSpace($env:CLAUDE_CODE_OAUTH_TOKEN)
  $routerEnabled = $routerFlag -eq 'true'
  $hasRouterProvider = -not [string]::IsNullOrWhiteSpace($env:OPENAI_API_KEY) -or -not [string]::IsNullOrWhiteSpace($env:OPENROUTER_API_KEY)

  if (-not $hasAnthropic -and -not $hasOauth) {
    if ($routerEnabled -and $hasRouterProvider) {
      $env:ANTHROPIC_API_KEY = 'router-mode'
    } else {
      throw 'Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in .env before starting Shannon.'
    }
  }

  $containerRepo = Resolve-RepoPath -Repo $repo

  if (-not (Test-Path (Join-Path $ScriptDir 'audit-logs'))) {
    New-Item -ItemType Directory -Path (Join-Path $ScriptDir 'audit-logs') | Out-Null
  }

  $ensureOptions = @{
    REBUILD = $rebuildFlag
  }

  if ($outputPath) {
    $resolvedOutput = (Resolve-Path -LiteralPath $outputPath -ErrorAction SilentlyContinue)
    if (-not $resolvedOutput) {
      New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
      $resolvedOutput = Resolve-Path -LiteralPath $outputPath
    }
    $env:OUTPUT_DIR = $resolvedOutput.Path
    $ensureOptions['OUTPUT_DIR'] = $resolvedOutput.Path
  }

  if ($routerEnabled) {
    if (-not $hasRouterProvider) {
      Write-Warning 'Router mode enabled, but OPENAI_API_KEY or OPENROUTER_API_KEY is not set.'
    }

    docker compose -f $ComposeFile --profile router up -d router
    $env:ANTHROPIC_BASE_URL = 'http://router:3456'
    $env:ANTHROPIC_AUTH_TOKEN = 'shannon-router-key'
  }

  Ensure-Containers -Options $ensureOptions

  $clientArgs = @($url, $containerRepo)

  if ($configPath) {
    $clientArgs += @('--config', $configPath)
  }
  if ($outputPath) {
    $clientArgs += @('--output', '/app/output', '--display-output', $env:OUTPUT_DIR)
  }
  if ($pipelineTesting -eq 'true') {
    $clientArgs += '--pipeline-testing'
  }

  docker compose -f $ComposeFile exec -T worker node dist/temporal/client.js $clientArgs
}

function Show-Logs {
  param([hashtable]$ArgsMap)

  $workflowId = if ($ArgsMap.ContainsKey('ID')) { $ArgsMap['ID'] } else { $null }

  if (-not $workflowId) {
    throw 'ID is required. Example: .\shannon.ps1 logs ID=example_shannon-123'
  }

  $workflowLog = Get-ChildItem -Path $ScriptDir -Filter workflow.log -Recurse -File |
    Where-Object { $_.FullName -match [regex]::Escape($workflowId) } |
    Select-Object -First 1

  if (-not $workflowLog) {
    throw "Workflow log not found for ID $workflowId"
  }

  Write-Host "Tailing workflow log: $($workflowLog.FullName)"
  Get-Content -Path $workflowLog.FullName -Wait
}

function Query-Shannon {
  param([hashtable]$ArgsMap)

  $workflowId = if ($ArgsMap.ContainsKey('ID')) { $ArgsMap['ID'] } else { $null }

  if (-not $workflowId) {
    throw 'ID is required. Example: .\shannon.ps1 query ID=example_shannon-123'
  }

  docker compose -f $ComposeFile exec -T worker node dist/temporal/query.js $workflowId
}

function Stop-Shannon {
  param([hashtable]$ArgsMap)

  $clean = if ($ArgsMap.ContainsKey('CLEAN')) { $ArgsMap['CLEAN'] } else { $null }

  if ($clean -eq 'true') {
    docker compose -f $ComposeFile --profile router down -v
  } else {
    docker compose -f $ComposeFile --profile router down
  }
}

Import-EnvFile

$command = if ($args.Count -gt 0) { $args[0].ToLowerInvariant() } else { 'help' }
$argMap = Parse-KeyValueArgs -Arguments ($args | Select-Object -Skip 1)

switch ($command) {
  'start' { Start-Shannon -ArgsMap $argMap }
  'logs' { Show-Logs -ArgsMap $argMap }
  'query' { Query-Shannon -ArgsMap $argMap }
  'stop' { Stop-Shannon -ArgsMap $argMap }
  'help' { Show-Help }
  default { Show-Help }
}
