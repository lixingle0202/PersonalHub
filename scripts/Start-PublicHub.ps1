$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot = Join-Path $projectRoot '.public-runtime'
$python = Join-Path $projectRoot '.venv\Scripts\python.exe'
$cloudflared = Join-Path $runtimeRoot 'cloudflared.exe'
$model = 'qwen2.5:1.5b'
$localUrl = 'http://127.0.0.1:8766'
$tunnelLog = Join-Path $runtimeRoot 'tunnel-http2-err.log'

if (-not (Test-Path -LiteralPath $python)) { throw 'Project Python runtime is missing.' }
if (-not (Test-Path -LiteralPath $cloudflared)) { throw 'Download cloudflared-windows-amd64.exe from Cloudflare into .public-runtime/cloudflared.exe first.' }
$signature = Get-AuthenticodeSignature -LiteralPath $cloudflared
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Cloudflare') {
    throw 'cloudflared digital signature is invalid.'
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

$existing = @(Get-CimInstance Win32_Process | Where-Object {
    [string]::Equals($_.ExecutablePath, $cloudflared, [StringComparison]::OrdinalIgnoreCase) -and
    $_.CommandLine -match '127\.0\.0\.1:8766'
})
if ($existing.Count -gt 1) { throw 'More than one tunnel process is running.' }
if ($existing.Count -eq 0) {
    Start-Process -FilePath $cloudflared -ArgumentList @('tunnel','--url',$localUrl,'--no-autoupdate','--protocol','http2','--loglevel','info') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'tunnel-http2-out.log') -RedirectStandardError $tunnelLog | Out-Null
}
$publicUrl = ''
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if (Test-Path -LiteralPath $tunnelLog) {
        $log = [string](Get-Content -LiteralPath $tunnelLog -Raw)
        $match = [regex]::Match($log, 'https://[a-z0-9-]+\.trycloudflare\.com')
        if ($match.Success) { $publicUrl = $match.Value; break }
    }
    Start-Sleep -Milliseconds 500
}
if (-not $publicUrl) { throw 'Tunnel did not provide a public URL.' }
$reachable = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
        $remote = Invoke-RestMethod -Uri ($publicUrl + '/health') -TimeoutSec 5
        if ($remote.mode -eq 'public') { $reachable = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 500
}
if (-not $reachable) { throw 'Tunnel URL exists but is not yet reachable.' }
Write-Output ('Public PersonalHub: ' + $publicUrl)
Write-Output 'Visitors register their own accounts; the local owner database stays private.'
