param([string]$Workspace = (Get-Location).Path, [int]$Port = 3080, [string]$HarnessRoot = '', [string]$Profile = 'jev')
$ErrorActionPreference = 'Stop'
$candidateRoot = if ($HarnessRoot) { [IO.Path]::GetFullPath($HarnessRoot) } else { [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\deepseek-harness')) }
$command = Join-Path $candidateRoot 'dsh.cmd'
if (Test-Path -LiteralPath $command -PathType Leaf) { $env:PATH = "$candidateRoot;$env:PATH" }
else { $command = (Get-Command dsh.cmd -ErrorAction Stop).Source }
if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) { throw "Workspace not found: $Workspace" }
Push-Location -LiteralPath $Workspace
try { & $command --profile $Profile --port $Port; exit $LASTEXITCODE } finally { Pop-Location }
