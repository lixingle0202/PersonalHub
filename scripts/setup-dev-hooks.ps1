param(
    [string]$PythonPath = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $PythonPath) {
    $PythonPath = Join-Path $projectRoot '.venv\Scripts\python.exe'
}
if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
    throw 'Project Python was not found. Create .venv and install requirements-dev.txt first.'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js was not found. Install Node.js and reopen the terminal first.'
}

Push-Location $projectRoot
try {
    & $PythonPath -X utf8 -m pre_commit --version
    if ($LASTEXITCODE -ne 0) {
        throw 'Install development dependencies with: .\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt'
    }
    & $PythonPath -X utf8 -m pre_commit install --install-hooks
    if ($LASTEXITCODE -ne 0) {
        throw 'Hook installation failed. Check the output above and retry.'
    }
    Write-Output 'Pre-commit hooks are installed. Git commits now check and format staged files.'
} finally {
    Pop-Location
}
