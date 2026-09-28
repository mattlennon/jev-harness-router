param([string]$OutputDirectory = '')
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
if (-not $OutputDirectory) { $OutputDirectory = Split-Path $projectRoot -Parent }
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
$archivePath = Join-Path $outputRoot "jev-harness-router-v$version.zip"
Push-Location -LiteralPath $projectRoot
try {
  & node tools/check-repository.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Repository validation failed' }
  # Export the committed tree only: no untracked credentials, logs or local state.
  & git -c "safe.directory=$($projectRoot.Replace('\', '/'))" archive --format=zip --prefix=jev-harness-router/ "--output=$archivePath" HEAD
  if ($LASTEXITCODE -ne 0) { throw 'git archive failed; commit the reviewed changes first' }
  [pscustomobject]@{ archive = $archivePath; bytes = (Get-Item -LiteralPath $archivePath).Length; source = 'HEAD' } | ConvertTo-Json
} finally { Pop-Location }
