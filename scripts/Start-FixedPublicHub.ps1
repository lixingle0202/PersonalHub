$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot = Join-Path $projectRoot '.public-runtime'
$tokenPath = Join-Path $runtimeRoot 'ngrok-token.xml'
$configPath = Join-Path $runtimeRoot 'ngrok-agent.yml'
$statePath = Join-Path $runtimeRoot 'fixed-sharing.json'
$localUrl = 'http://127.0.0.1:8766'
$controlUrl = 'http://127.0.0.1:4041/api/tunnels'
$ngrok = Get-Command ngrok.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $ngrok) { throw 'Install the official ngrok app from Microsoft Store first: https://apps.microsoft.com/detail/9mvs1j51gmk6' }
if (-not (Test-Path -LiteralPath $tokenPath)) { throw 'Run Configure-FixedTunnel.cmd to save your ngrok token first.' }

# This starts only the account-isolated service; it never creates a Quick Tunnel.
& (Join-Path $PSScriptRoot 'Start-PublicHub.ps1') -LocalOnly

function Get-ProjectAgent {
    $listener = Get-NetTCPConnection -State Listen -LocalPort 4041 -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $listener) { return $null }
    $owner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$listener.OwningProcess)
    if (-not $owner -or $owner.Name -ne 'ngrok.exe' -or $owner.CommandLine -notmatch [regex]::Escape($configPath)) {
        throw 'Port 4041 belongs to another program. The existing program was not changed.'
    }
    return $owner
}

function Get-ProjectEndpoint {
    try {
        $response = Invoke-RestMethod -Uri $controlUrl -TimeoutSec 2
        foreach ($endpoint in $response.tunnels) {
            if ($endpoint.config.addr.TrimEnd('/') -ne $localUrl -or $endpoint.proto -ne 'https') { continue }
            $uri = [Uri]$endpoint.public_url
            if ($uri.Scheme -eq 'https' -and $uri.Host -match '\.(ngrok-free\.(app|dev)|ngrok\.(app|dev))$') {
                return $uri.GetLeftPart([UriPartial]::Authority)
            }
        }
    } catch {}
    return ''
}

$agent = Get-ProjectAgent
$newProcess = $null
if (-not $agent) {
    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    # The configuration contains no token. The local control API stays on loopback.
    @'
version: 3
agent:
  web_addr: 127.0.0.1:4041
  console_ui: false
  inspect_db_size: -1
  remote_management: false
'@ | Set-Content -LiteralPath $configPath -Encoding utf8
    $runId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $stdoutPath = Join-Path $runtimeRoot ('ngrok-' + $runId + '-out.log')
    $stderrPath = Join-Path $runtimeRoot ('ngrok-' + $runId + '-err.log')
    $secureToken = Import-Clixml -LiteralPath $tokenPath
    if ($secureToken -isnot [System.Security.SecureString]) { throw 'The encrypted ngrok configuration is invalid. Run Configure-FixedTunnel.cmd again.' }
    $previousToken = [Environment]::GetEnvironmentVariable('NGROK_AUTHTOKEN', 'Process')
    $tokenBuffer = [IntPtr]::Zero
    try {
        $tokenBuffer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
        $env:NGROK_AUTHTOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenBuffer)
        $arguments = @('http', $localUrl, ('--config="' + $configPath + '"'), '--inspect=false', '--log=stdout', '--log-format=json')
        $newProcess = Start-Process -FilePath $ngrok.Source -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
    } finally {
        [Environment]::SetEnvironmentVariable('NGROK_AUTHTOKEN', $previousToken, 'Process')
        if ($tokenBuffer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenBuffer) }
        $secureToken.Dispose()
    }
}

$publicUrl = ''
for ($attempt = 0; $attempt -lt 45; $attempt++) {
    $agent = Get-ProjectAgent
    if ($agent) { $publicUrl = Get-ProjectEndpoint }
    if ($publicUrl) { break }
    if ($newProcess -and $newProcess.HasExited) {
        # ngrok errors may echo credentials. Report only error codes, never raw logs.
        $errorCodes = @()
        foreach ($path in @($stdoutPath, $stderrPath)) {
            if (Test-Path -LiteralPath $path) {
                $errorCodes += [regex]::Matches([string](Get-Content -LiteralPath $path -Raw), 'ERR_NGROK_\d+') | ForEach-Object { $_.Value }
            }
        }
        throw ('ngrok could not start. Error codes: ' + (($errorCodes | Select-Object -Unique) -join ', '))
    }
    Start-Sleep -Milliseconds 750
}
if (-not $publicUrl) { throw 'ngrok has not connected yet. No working public link was confirmed.' }

$healthy = $false
for ($attempt = 0; $attempt -lt 6; $attempt++) {
    try {
        $health = Invoke-RestMethod -Uri ($publicUrl + '/health') -TimeoutSec 6
        if ($health.status -eq 'ok' -and $health.mode -eq 'public') { $healthy = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 500
}
if (-not $healthy) { throw 'The assigned hostname exists, but its public health check did not pass. Do not share it yet.' }

[ordered]@{ url=$publicUrl; processId=$agent.ProcessId; checkedAt=(Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
Write-Output ('Public PersonalHub: ' + $publicUrl + '/learning')
Write-Output 'Public health check passed. Check it in a normal browser before sharing.'
Write-Output 'Free ngrok may show a Visit Site page. The host computer, network and local app must stay running.'
