param([string]$ReleaseName = '')
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $ReleaseName) { $ReleaseName = 'PersonalHub-Full-' + (Get-Date -Format 'yyyyMMdd-HHmmss') }
if ($ReleaseName -notmatch '^PersonalHub-Full-[A-Za-z0-9-]+$') { throw 'Invalid release folder name.' }
$releaseRoot = Join-Path $projectRoot ('dist\' + $ReleaseName)
if (Test-Path -LiteralPath $releaseRoot) { throw 'Release output already exists; choose a new release name.' }
$modelRoot = Join-Path $projectRoot '.local-ai\models'
$manifestPath = Join-Path $modelRoot 'manifests\registry.ollama.ai\library\qwen2.5\1.5b'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$blobs = @($manifest.config) + @($manifest.layers)
foreach ($blob in $blobs) {
    $source = Join-Path $modelRoot ('blobs\' + $blob.digest.Replace(':', '-'))
    if ((Get-Item -LiteralPath $source).Length -ne $blob.size -or
        (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $blob.digest.Substring(7)) {
        throw 'Bundled model verification failed.'
    }
}
$python = Join-Path $projectRoot '.venv\Scripts\python.exe'
$node = (Get-Command node.exe -ErrorAction Stop).Source
Push-Location (Join-Path $projectRoot 'frontend')
try {
    & $node '.\node_modules\typescript\bin\tsc' '-b'
    if ($LASTEXITCODE) { throw 'TypeScript build failed.' }
    & $node '.\node_modules\vite\bin\vite.js' 'build'
    if ($LASTEXITCODE) { throw 'Frontend build failed.' }
} finally { Pop-Location }
Push-Location $projectRoot
try {
    & $python -m PyInstaller --clean --noconfirm --distpath $releaseRoot --workpath (Join-Path $projectRoot ('.test-runtime\' + $ReleaseName + '-build')) PersonalHubDesktop.spec
    if ($LASTEXITCODE) { throw 'Executable build failed.' }
} finally { Pop-Location }
$package = Join-Path $releaseRoot 'PersonalHub'
$ai = Join-Path $package 'ai'
New-Item -ItemType Directory -Force -Path (Join-Path $ai 'models\blobs'), (Join-Path $ai 'models\manifests\registry.ollama.ai\library\qwen2.5'), (Join-Path $package 'licenses') | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot '.local-ai\ollama') -Destination (Join-Path $ai 'ollama') -Recurse
Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $ai 'models\manifests\registry.ollama.ai\library\qwen2.5\1.5b')
foreach ($blob in $blobs) {
    Copy-Item -LiteralPath (Join-Path $modelRoot ('blobs\' + $blob.digest.Replace(':', '-'))) -Destination (Join-Path $ai 'models\blobs')
}
$licenseBlob = @($manifest.layers | Where-Object { $_.mediaType -eq 'application/vnd.ollama.image.license' })[0]
Copy-Item -LiteralPath (Join-Path $modelRoot ('blobs\' + $licenseBlob.digest.Replace(':', '-'))) -Destination (Join-Path $package 'licenses\Qwen2.5-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $projectRoot 'docs\third-party\Ollama-LICENSE.txt') -Destination (Join-Path $package 'licenses\Ollama-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $projectRoot 'docs\FullDesktopGuide.txt') -Destination (Join-Path $package '使用说明.txt')
$private = @(Get-ChildItem -LiteralPath $package -Recurse -File | Where-Object { $_.Extension -in '.db','.sqlite','.sqlite3' -or $_.Name -eq '.env' -or $_.Name -match '^id_(rsa|ed25519)' })
if ($private.Count) { throw 'Private files unexpectedly found in the release.' }
Write-Output ('FULL_PACKAGE_DIRECTORY=' + $package)
