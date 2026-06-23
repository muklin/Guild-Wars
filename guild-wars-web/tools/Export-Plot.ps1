<#
.SYNOPSIS
  Exports a savegame subset (a plot, block, or junction plus adjacent geometry) into
  a testBlocks.json-shaped file, for the buildingparts preview harness
  (client/preview/blockpreview.js). Thin wrapper around tools/exportPlot.mjs.

.PARAMETER Save
  Save file name (without .json) under server/saves/, e.g. "autosave".

.PARAMETER File
  Direct path to a save .json file, instead of -Save.

.PARAMETER Plot
  Plot id. Exports its block, plus all junctions/streets bordering that block.

.PARAMETER Block
  Block id. Exports the block, plus all junctions/streets bordering it, plus every
  block that also touches those same streets.

.PARAMETER Junction
  Junction id. Exports the junction, plus the junctions/streets it connects to
  directly, plus every block bordering those streets.

.PARAMETER Out
  Output path. Defaults to client/preview/testBlocks.json (overwrites the preview
  harness's current stub data).

.EXAMPLE
  ./tools/Export-Plot.ps1 -Save autosave -Plot 530

.EXAMPLE
  ./tools/Export-Plot.ps1 -Save autosave -Block 53 -Out client/preview/testBlocks.json

.EXAMPLE
  ./tools/Export-Plot.ps1 -File server/saves/autosave.json -Junction 12
#>
param(
  [string]$Save,
  [string]$File,
  [int]$Plot = -1,
  [int]$Block = -1,
  [int]$Junction = -1,
  [string]$Out
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot  = Split-Path -Parent $scriptDir
$exporter  = Join-Path $scriptDir 'exportPlot.mjs'

if (-not $Save -and -not $File) {
  Write-Error "Specify -Save <name> (server/saves/<name>.json) or -File <path>."
  exit 1
}
if ($Plot -lt 0 -and $Block -lt 0 -and $Junction -lt 0) {
  Write-Error "Specify one of -Plot <id>, -Block <id>, or -Junction <id>."
  exit 1
}

$nodeArgs = @($exporter)
if ($Save)         { $nodeArgs += @('--save', $Save) }
if ($File)         { $nodeArgs += @('--file', $File) }
if ($Plot -ge 0)     { $nodeArgs += @('--plot', $Plot) }
if ($Block -ge 0)    { $nodeArgs += @('--block', $Block) }
if ($Junction -ge 0) { $nodeArgs += @('--junction', $Junction) }
if ($Out)          { $nodeArgs += @('--out', $Out) }

Push-Location $repoRoot
try {
  & node @nodeArgs
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
