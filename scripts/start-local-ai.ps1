param(
    [string]$InstallRoot = '',
    [ValidateRange(1024, 65535)][int]$Port = 11434,
    [string]$AllowedOrigin = '',
    [ValidateRange(1, 3)][int]$ParallelRequests = 3
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not $InstallRoot) { $InstallRoot = Join-Path $ProjectRoot '.local-ai' }
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
if ([System.IO.Path]::GetPathRoot($InstallRoot) -eq 'C:\') {
    throw 'Keep the local AI installation and model files on a drive other than C:.'
}
$OllamaExe = Join-Path $InstallRoot 'ollama\ollama.exe'
if (-not (Test-Path -LiteralPath $OllamaExe)) { throw "Ollama was not found: $OllamaExe" }
$ModelDirectory = Join-Path $InstallRoot 'models'
$LogDirectory = Join-Path $InstallRoot 'logs'
$TempDirectory = Join-Path $InstallRoot 'tmp'
New-Item -ItemType Directory -Path $ModelDirectory, $LogDirectory, $TempDirectory -Force | Out-Null
$StatePath = Join-Path $LogDirectory "runtime-$Port.json"
$BaseUrl = "http://127.0.0.1:$Port"
if ($AllowedOrigin) {
    $ParsedOrigin = $null
    if (-not [System.Uri]::TryCreate($AllowedOrigin, [System.UriKind]::Absolute, [ref]$ParsedOrigin) -or
        $ParsedOrigin.Scheme -ne 'https' -or $ParsedOrigin.UserInfo -or
        $ParsedOrigin.GetLeftPart([System.UriPartial]::Authority) -ne $AllowedOrigin.TrimEnd('/')) {
        throw 'AllowedOrigin must be one exact HTTPS website origin without a path or wildcard.'
    }
    $AllowedOrigin = $ParsedOrigin.GetLeftPart([System.UriPartial]::Authority)
}

function Test-OllamaReady {
    try {
        $Version = Invoke-RestMethod -Uri "$BaseUrl/api/version" -TimeoutSec 1
        return -not [string]::IsNullOrWhiteSpace($Version.version)
    } catch { return $false }
}

$LaunchLock = $null
$LockPath = Join-Path $LogDirectory "start-$Port.lock"
for ($Attempt = 0; $Attempt -lt 40; $Attempt++) {
    try {
        $LaunchLock = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        break
    } catch [System.IO.IOException] { Start-Sleep -Milliseconds 200 }
}
if ($null -eq $LaunchLock) { throw 'Another launch is still in progress. Try again shortly.' }
try {
if (Test-OllamaReady) {
    if (-not (Test-Path -LiteralPath $StatePath)) { throw 'Ollama is already running, but its model directory cannot be verified. Keep the existing service unchanged.' }
    $Existing = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $ExistingProcess = Get-Process -Id $Existing.pid -ErrorAction SilentlyContinue
    if ($null -eq $ExistingProcess -or $ExistingProcess.Path -ne $OllamaExe -or $Existing.models_directory -ne $ModelDirectory) {
        throw 'An existing Ollama service does not match this installation. Keep the existing service unchanged.'
    }
    if ($AllowedOrigin -and $Existing.allowed_origin -ne $AllowedOrigin) {
        throw 'Ollama is running with a different allowed origin. Use Configure-HostLocalModel.ps1 to update it.'
    }
    if ($Existing.parallel_requests -ne $ParallelRequests -or $Existing.context_length -ne 8192) {
        throw 'Ollama is running with different inference limits. Use Configure-HostLocalModel.ps1 to restart the verified project service.'
    }
    $Existing | ConvertTo-Json -Compress
    exit 0
}

$Variables = @{
    OLLAMA_HOST = "127.0.0.1:$Port"
    OLLAMA_MODELS = $ModelDirectory
    OLLAMA_NO_CLOUD = '1'
    OLLAMA_CONTEXT_LENGTH = '8192'
    OLLAMA_MAX_LOADED_MODELS = '1'
    OLLAMA_NUM_PARALLEL = [string]$ParallelRequests
    TEMP = $TempDirectory
    TMP = $TempDirectory
}
if ($AllowedOrigin) { $Variables.OLLAMA_ORIGINS = $AllowedOrigin }
$Previous = @{}
try {
    foreach ($Name in $Variables.Keys) {
        $Previous[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process')
        [Environment]::SetEnvironmentVariable($Name, $Variables[$Name], 'Process')
    }
    $Stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $ErrorLog = Join-Path $LogDirectory "ollama-$Port-$Stamp-error.log"
    $OutputLog = Join-Path $LogDirectory "ollama-$Port-$Stamp-output.log"
    $Service = Start-Process -FilePath $OllamaExe -ArgumentList 'serve' -WorkingDirectory (Split-Path -Parent $OllamaExe) -WindowStyle Hidden -RedirectStandardOutput $OutputLog -RedirectStandardError $ErrorLog -PassThru
    $Ready = $false
    for ($Attempt = 0; $Attempt -lt 40; $Attempt++) {
        $Service.Refresh()
        if ($Service.HasExited) { throw "Ollama exited early. See $ErrorLog" }
        if (Test-OllamaReady) { $Ready = $true; break }
        Start-Sleep -Milliseconds 200
    }
    if (-not $Ready) { throw "Ollama did not become ready. See $ErrorLog" }
    $State = @{ pid = $Service.Id; url = $BaseUrl; models_directory = $ModelDirectory; executable = $OllamaExe; no_cloud = $true; allowed_origin = $AllowedOrigin; error_log = $ErrorLog; parallel_requests = $ParallelRequests; context_length = 8192 }
    $State | ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding UTF8
    $State | ConvertTo-Json -Compress
} finally {
    foreach ($Name in $Previous.Keys) { [Environment]::SetEnvironmentVariable($Name, $Previous[$Name], 'Process') }
}
} finally { $LaunchLock.Dispose() }
