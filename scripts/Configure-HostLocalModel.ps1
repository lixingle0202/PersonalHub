param([string]$Origin = '')

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $Origin) {
    $logPath = Join-Path $projectRoot '.public-runtime\tunnel-http2-err.log'
    if (-not (Test-Path -LiteralPath $logPath)) { throw 'Public tunnel log is missing. Start sharing first or pass -Origin.' }
    $matches = [regex]::Matches([string](Get-Content -LiteralPath $logPath -Raw), 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($matches.Count -eq 0) { throw 'Public tunnel URL was not found. Start sharing first or pass -Origin.' }
    $Origin = $matches[$matches.Count - 1].Value
}
$parsed = $null
if (-not [Uri]::TryCreate($Origin, [UriKind]::Absolute, [ref]$parsed) -or
    $parsed.Scheme -ne 'https' -or $parsed.UserInfo -or
    $parsed.GetLeftPart([UriPartial]::Authority) -ne $Origin.TrimEnd('/')) {
    throw 'Origin must be one exact HTTPS website origin.'
}
$Origin = $parsed.GetLeftPart([UriPartial]::Authority)
$public = Invoke-RestMethod -Uri "$Origin/health" -TimeoutSec 10
if ($public.mode -ne 'public') { throw 'The chosen URL does not serve public PersonalHub.' }

$statePath = Join-Path $projectRoot '.local-ai\logs\runtime-11434.json'
$state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
$expectedExe = Join-Path $projectRoot '.local-ai\ollama\ollama.exe'
$expectedModels = Join-Path $projectRoot '.local-ai\models'
$process = Get-Process -Id $state.pid -ErrorAction Stop
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort 11434 -ErrorAction Stop)
if ($process.Path -ne $expectedExe -or $state.models_directory -ne $expectedModels -or
    $listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1' -or
    $listeners[0].OwningProcess -ne $state.pid) {
    throw 'Port 11434 does not belong to this project Ollama service; it was left unchanged.'
}

if ($state.allowed_origin -ne $Origin) {
    Stop-Process -Id $state.pid -ErrorAction Stop
    $stopped = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if (-not (Get-NetTCPConnection -State Listen -LocalPort 11434 -ErrorAction SilentlyContinue)) { $stopped = $true; break }
        Start-Sleep -Milliseconds 250
    }
    if (-not $stopped) { throw 'Ollama did not stop; do not restart it until port 11434 is free.' }
    try {
        & (Join-Path $PSScriptRoot 'start-local-ai.ps1') -AllowedOrigin $Origin | Out-Null
    } catch {
        $failure = $_
        try { & (Join-Path $PSScriptRoot 'start-local-ai.ps1') | Out-Null } catch {}
        throw "Could not restart Ollama with the allowed origin: $failure"
    }
}
& (Join-Path $PSScriptRoot 'Test-PublicLocalModel.ps1') -Origin $Origin
