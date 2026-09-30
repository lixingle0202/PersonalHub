$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
$NodeCommand = Get-Command "node.exe" -ErrorAction SilentlyContinue
$BundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if ($null -ne $NodeCommand) {
    $Node = $NodeCommand.Source
} elseif (Test-Path -LiteralPath $BundledNode) {
    $Node = $BundledNode
} else {
    throw "Node.js was not found. Install Node.js before building PersonalHub."
}

Push-Location (Join-Path $ProjectRoot "frontend")
try {
    & $Node ".\node_modules\typescript\bin\tsc" "-b"
    if ($LASTEXITCODE -ne 0) { throw "TypeScript build failed with exit code $LASTEXITCODE." }
    & $Node ".\node_modules\vite\bin\vite.js" "build"
    if ($LASTEXITCODE -ne 0) { throw "Vite build failed with exit code $LASTEXITCODE." }
} finally {
    Pop-Location
}

Push-Location $ProjectRoot
try {
    & $Python "-m" "PyInstaller" "--clean" "--noconfirm" "PersonalHub.spec"
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed with exit code $LASTEXITCODE." }
} finally {
    Pop-Location
}

Write-Host "Build complete: dist\PersonalHub\PersonalHub.exe"
