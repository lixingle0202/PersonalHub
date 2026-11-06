param([Parameter(Mandatory)][string]$Executable, [Parameter(Mandatory)][string]$DataDirectory, [int]$Port = 18771, [string]$LocalModelUrl = '')
$ErrorActionPreference = 'Stop'
$Executable = (Resolve-Path -LiteralPath $Executable).Path
$base = 'http://127.0.0.1:' + $Port
$env:PERSONAL_HUB_DESKTOP_DATA_DIR = [IO.Path]::GetFullPath($DataDirectory)
$env:PERSONAL_HUB_DESKTOP_PORT = [string]$Port
$env:PERSONAL_HUB_NO_BROWSER = '1'
function Wait-Desktop {
    for ($attempt = 0; $attempt -lt 80; $attempt++) {
        try { $health = Invoke-RestMethod -Uri ($base + '/health') -TimeoutSec 1; if ($health.mode -eq 'desktop') { return } } catch {}
        Start-Sleep -Milliseconds 200
    }
    throw 'Desktop restart did not become ready.'
}
function Stop-OwnedDesktop {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $listener) { return }
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$listener.OwningProcess)
    if (-not [string]::Equals($process.ExecutablePath, $Executable, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected process on test port.' }
    Stop-Process -Id $process.ProcessId
    Start-Sleep -Milliseconds 500
}
Wait-Desktop
$credentials = @{ username = ('restart_' + [guid]::NewGuid().ToString('N').Substring(0,8)); password = [guid]::NewGuid().ToString('N') } | ConvertTo-Json -Compress
Invoke-RestMethod -Uri ($base + '/api/v1/public/register') -Method Post -ContentType 'application/json' -Body $credentials -SessionVariable account | Out-Null
$token = (Invoke-RestMethod -Uri ($base + '/api/v1/bootstrap') -WebSession $account).local_token
Invoke-RestMethod -Uri ($base + '/api/v1/quick-notes') -Method Post -ContentType 'application/json' -Body '{"content":"packaged-restart-persistence"}' -WebSession $account -Headers @{ 'X-Local-Token' = $token } | Out-Null
$config = Invoke-RestMethod -Uri ($base + '/api/v1/ai/ollama/settings') -WebSession $account
$modelPort = ([Uri]$config.base_url).Port
$modelListener = Get-NetTCPConnection -State Listen -LocalPort $modelPort | Select-Object -First 1
if ($LocalModelUrl) {
    $available = Invoke-RestMethod -Uri ($base + '/api/v1/desktop/ai/models') -Method Post -ContentType 'application/json' -Body (@{ base_url = $LocalModelUrl } | ConvertTo-Json -Compress) -WebSession $account -Headers @{ 'X-Local-Token' = $token }
    if (-not $available.models.Count) { throw 'No model available for switch persistence verification.' }
    $custom = @{ source = 'local'; base_url = $LocalModelUrl; model = $available.models[0] } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri ($base + '/api/v1/desktop/ai/settings') -Method Put -ContentType 'application/json' -Body $custom -WebSession $account -Headers @{ 'X-Local-Token' = $token } | Out-Null
}
$second = Start-Process -FilePath $Executable -WorkingDirectory (Split-Path -Parent $Executable) -WindowStyle Hidden -PassThru
$null = $second.Handle
if (-not $second.WaitForExit(15000)) { throw 'Second instance failed to reuse the running app.' }
$second.WaitForExit()
if ($second.ExitCode -ne 0) { throw 'Second instance did not exit successfully.' }
Write-Output 'PASS: double-click reuses the existing instance.'
Stop-OwnedDesktop
if (Get-Process -Id $modelListener.OwningProcess -ErrorAction SilentlyContinue) { throw 'The owned model service did not stop.' }
Write-Output 'PASS: closing the executable also closes its owned AI service.'
$restarted = Start-Process -FilePath $Executable -WorkingDirectory (Split-Path -Parent $Executable) -WindowStyle Hidden -PassThru
try {
    Wait-Desktop
    Invoke-RestMethod -Uri ($base + '/api/v1/public/login') -Method Post -ContentType 'application/json' -Body $credentials -SessionVariable newAccount | Out-Null
    $notes = @(Invoke-RestMethod -Uri ($base + '/api/v1/quick-notes') -WebSession $newAccount)
    if (-not ($notes.content -contains 'packaged-restart-persistence')) { throw 'Account or data was not retained after restart.' }
    Write-Output 'PASS: registration, passwords, and personal data survive executable restart.'
    if ($LocalModelUrl) {
        $saved = Invoke-RestMethod -Uri ($base + '/api/v1/desktop/ai/settings') -WebSession $newAccount
        if ($saved.source -ne 'local' -or $saved.base_url -ne $LocalModelUrl -or $saved.model -ne $available.models[0]) { throw 'Custom model selection was not retained.' }
        $newToken = (Invoke-RestMethod -Uri ($base + '/api/v1/bootstrap') -WebSession $newAccount).local_token
        $reset = Invoke-RestMethod -Uri ($base + '/api/v1/desktop/ai/settings') -Method Put -ContentType 'application/json' -Body '{"source":"builtin"}' -WebSession $newAccount -Headers @{ 'X-Local-Token' = $newToken }
        if ($reset.source -ne 'builtin') { throw 'Reset to built-in model failed.' }
        Write-Output 'PASS: selected local model survives executable restart; switching back to the bundled model works.'
    }
} finally { Stop-OwnedDesktop }
