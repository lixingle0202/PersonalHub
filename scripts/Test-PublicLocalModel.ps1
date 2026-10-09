param(
    [Parameter(Mandatory)][string]$Origin,
    [string]$Model = 'qwen2.5:1.5b'
)

$ErrorActionPreference = 'Stop'
$parsed = $null
if (-not [Uri]::TryCreate($Origin, [UriKind]::Absolute, [ref]$parsed) -or
    $parsed.Scheme -ne 'https' -or $parsed.UserInfo -or
    $parsed.GetLeftPart([UriPartial]::Authority) -ne $Origin.TrimEnd('/')) {
    throw 'Origin must be one exact HTTPS website origin.'
}
$Origin = $parsed.GetLeftPart([UriPartial]::Authority)
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$statePath = Join-Path $projectRoot '.local-ai\logs\runtime-11434.json'
$state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
$expectedExe = Join-Path $projectRoot '.local-ai\ollama\ollama.exe'
$expectedModels = Join-Path $projectRoot '.local-ai\models'
$process = Get-Process -Id $state.pid -ErrorAction Stop
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort 11434 -ErrorAction Stop)
if ($process.Path -ne $expectedExe -or $state.models_directory -ne $expectedModels -or
    $state.allowed_origin -ne $Origin -or $listeners.Count -ne 1 -or
    $listeners[0].LocalAddress -ne '127.0.0.1' -or $listeners[0].OwningProcess -ne $state.pid) {
    throw 'Ollama is not the expected project-owned, loopback-only service with this allowed origin.'
}
$base = 'http://127.0.0.1:11434'
$headers = @{ Origin = $Origin; 'Access-Control-Request-Method' = 'GET' }
$preflight = Invoke-WebRequest -Uri "$base/api/tags" -Method Options -Headers $headers -TimeoutSec 8 -SkipHttpErrorCheck
if ($preflight.StatusCode -lt 200 -or $preflight.StatusCode -ge 300 -or
    $preflight.Headers['Access-Control-Allow-Origin'] -ne $Origin) {
    throw "Ollama CORS preflight failed: HTTP $($preflight.StatusCode)."
}
$response = Invoke-WebRequest -Uri "$base/api/tags" -Headers @{ Origin = $Origin } -TimeoutSec 8 -SkipHttpErrorCheck
if ($response.StatusCode -ne 200 -or $response.Headers['Access-Control-Allow-Origin'] -ne $Origin) {
    throw "Ollama model request failed: HTTP $($response.StatusCode)."
}
$tags = $response.Content | ConvertFrom-Json
if (-not ($tags.models.name -contains $Model)) { throw "Expected model is missing: $Model" }
$chatPreflight = Invoke-WebRequest -Uri "$base/api/chat" -Method Options -Headers @{
    Origin = $Origin
    'Access-Control-Request-Method' = 'POST'
    'Access-Control-Request-Headers' = 'content-type'
} -TimeoutSec 8 -SkipHttpErrorCheck
if ($chatPreflight.StatusCode -lt 200 -or $chatPreflight.StatusCode -ge 300 -or
    $chatPreflight.Headers['Access-Control-Allow-Origin'] -ne $Origin) {
    throw "Ollama chat preflight failed: HTTP $($chatPreflight.StatusCode)."
}
$foreign = Invoke-WebRequest -Uri "$base/api/tags" -Method Options -Headers @{
    Origin = 'https://unrelated.example'
    'Access-Control-Request-Method' = 'GET'
} -TimeoutSec 8 -SkipHttpErrorCheck
if ($foreign.StatusCode -ne 403 -or $foreign.Headers['Access-Control-Allow-Origin']) {
    throw 'Ollama unexpectedly allowed an unrelated website origin.'
}
$chat = Invoke-WebRequest -Uri "$base/api/chat" -Method Post -Headers @{ Origin = $Origin } -ContentType 'application/json' -Body (
    @{ model = $Model; stream = $false; messages = @(@{ role = 'user'; content = 'Reply with OK.' }); options = @{ num_predict = 8 } } | ConvertTo-Json -Depth 5
) -TimeoutSec 120 -SkipHttpErrorCheck
if ($chat.StatusCode -ne 200 -or $chat.Headers['Access-Control-Allow-Origin'] -ne $Origin -or
    -not ($chat.Content | ConvertFrom-Json).message.content) {
    throw "Ollama chat request failed: HTTP $($chat.StatusCode)."
}
$public = Invoke-RestMethod -Uri "$Origin/health" -TimeoutSec 10
if ($public.mode -ne 'public') { throw 'The public URL does not serve PersonalHub.' }
Write-Output "PASS: $Origin can use $Model for chat through the project Ollama CORS endpoint."
Write-Output 'PASS: An unrelated website origin is rejected.'
Write-Output 'PASS: Ollama listens on 127.0.0.1 only, and the public PersonalHub is healthy.'
