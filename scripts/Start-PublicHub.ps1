param([switch]$DirectNetwork, [switch]$LocalOnly)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot = Join-Path $projectRoot '.public-runtime'
$python = Join-Path $projectRoot '.venv\Scripts\python.exe'
$cloudflared = Join-Path $runtimeRoot 'cloudflared.exe'
$model = 'qwen2.5:1.5b'
$localUrl = 'http://127.0.0.1:8766'
$tunnelLog = Join-Path $runtimeRoot 'tunnel-http2-err.log'

function Get-SharingUrl {
    if (Test-Path -LiteralPath $tunnelLog) {
        $content = [string](Get-Content -LiteralPath $tunnelLog -Raw)
        $match = [regex]::Match($content, 'https://[a-z0-9-]+\.trycloudflare\.com')
        if ($match.Success) { return $match.Value }
    }
    return ''
}

function Test-SharingUrl([string]$Url) {
    if ($Url -notmatch '^https://[a-z0-9-]+\.trycloudflare\.com$') { return $false }
    try {
        $remote = Invoke-RestMethod -Uri ($Url + '/health') -TimeoutSec 5
        if ($remote.status -eq 'ok' -and $remote.mode -eq 'public') { return $true }
    } catch {}
    # A forced IP can prove that the origin responds, but cannot prove that a
    # visitor's browser can resolve the hostname. Never accept it as a working URL.
    return $false
}

if (-not (Test-Path -LiteralPath $python)) { throw 'Project Python runtime is missing.' }
if (-not $LocalOnly) {
    if (-not (Test-Path -LiteralPath $cloudflared)) { throw 'Download cloudflared-windows-amd64.exe from Cloudflare into .public-runtime/cloudflared.exe first.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $cloudflared
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Cloudflare') {
        throw 'cloudflared digital signature is invalid.'
    }
}
$tags = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 8
if (-not ($tags.models.name -contains $model)) { throw 'Start Ollama with qwen2.5:1.5b before sharing.' }
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

$listener = Get-NetTCPConnection -State Listen -LocalPort 8766 -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    $owner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$listener.OwningProcess)
    if (-not $owner -or $owner.CommandLine -notmatch ' -m app\.run_public') { throw 'Port 8766 belongs to another program.' }
} else {
    $env:PYTHONPATH = Join-Path $projectRoot 'backend'
    Start-Process -FilePath $python -ArgumentList '-m','app.run_public' -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'hub-out.log') -RedirectStandardError (Join-Path $runtimeRoot 'hub-err.log') | Out-Null
}
$healthy = $false
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    try {
        $health = Invoke-RestMethod -Uri ($localUrl + '/health') -TimeoutSec 1
        if ($health.mode -eq 'public') { $healthy = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 250
}
if (-not $healthy) { throw 'Public PersonalHub did not start.' }
if ($LocalOnly) {
    Write-Output ('Local account-based PersonalHub: ' + $localUrl + '/learning')
    return
}

$existing = @(Get-CimInstance Win32_Process | Where-Object {
    [string]::Equals($_.ExecutablePath, $cloudflared, [StringComparison]::OrdinalIgnoreCase) -and
    $_.CommandLine -match '127\.0\.0\.1:8766'
})
if ($existing.Count -gt 1) { throw 'More than one tunnel process is running.' }
if ($existing.Count -eq 1 -and -not (Test-SharingUrl (Get-SharingUrl))) {
    # A live process with a stale/1033 route must not be reused as a working link.
    Copy-Item -LiteralPath $tunnelLog -Destination (Join-Path $runtimeRoot 'tunnel-previous-err.log') -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $existing[0].ProcessId
    Wait-Process -Id $existing[0].ProcessId -Timeout 10 -ErrorAction SilentlyContinue
    $existing = @()
}
if ($existing.Count -eq 0) {
    $tunnelArguments = @('tunnel','--url',$localUrl,'--no-autoupdate','--protocol','http2','--edge-ip-version','4','--loglevel','info')
    if ($DirectNetwork) {
        $physical = Get-NetIPConfiguration | Where-Object {
            $_.NetAdapter.HardwareInterface -and $_.NetAdapter.Status -eq 'Up' -and $_.IPv4DefaultGateway -and $_.IPv4Address
        } | Select-Object -First 1
        if (-not $physical) { throw 'No connected physical IPv4 network was found for -DirectNetwork.' }
        $tunnelArguments += @('--edge-bind-address', $physical.IPv4Address[0].IPAddress)
    }
    Set-Content -LiteralPath $tunnelLog -Value ''
    Start-Process -FilePath $cloudflared -ArgumentList $tunnelArguments -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'tunnel-http2-out.log') -RedirectStandardError $tunnelLog | Out-Null
}
$publicUrl = ''
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    $publicUrl = Get-SharingUrl
    if ($publicUrl) { break }
    Start-Sleep -Milliseconds 500
}
if (-not $publicUrl) { throw 'Tunnel did not provide a public URL.' }
$reachable = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (Test-SharingUrl $publicUrl) { $reachable = $true; break }
    Start-Sleep -Milliseconds 500
}
if (-not $reachable) { throw 'Tunnel URL exists but is not yet reachable.' }
Write-Output ('Public PersonalHub: ' + $publicUrl)
Write-Output 'Visitors register their own accounts; the local owner database stays private.'
