param(
    [string]$Executable = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not $Executable) {
    $Executable = Join-Path $ProjectRoot "dist\PersonalHub\PersonalHub.exe"
}
if (-not (Test-Path -LiteralPath $Executable)) {
    throw "Packaged executable was not found: $Executable"
}

function Get-FreeLoopbackPort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port }
    finally { $listener.Stop() }
}

function Wait-ForHealth([int]$Port, [System.Diagnostics.Process]$Process) {
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        $Process.Refresh()
        if ($Process.HasExited) { throw "Packaged app exited early with code $($Process.ExitCode)." }
        try {
            return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 1
        } catch {
            Start-Sleep -Milliseconds 100
        }
    }
    throw "Packaged app did not become healthy on port $Port."
}

function Stop-TestProcess([System.Diagnostics.Process]$Process) {
    if ($null -eq $Process) { return }
    $Process.Refresh()
    if (-not $Process.HasExited) {
        Stop-Process -Id $Process.Id -Force
        $Process.WaitForExit(10000) | Out-Null
    }
}

$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("PersonalHubPackageSmoke-" + [guid]::NewGuid().ToString("N"))
$ExpectedParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$Port = Get-FreeLoopbackPort
$First = $null
$Second = $null
$Restarted = $null
$OldDataDir = $env:PERSONAL_HUB_DATA_DIR
$OldPort = $env:PERSONAL_HUB_PORT
$OldNoBrowser = $env:PERSONAL_HUB_NO_BROWSER

try {
    New-Item -ItemType Directory -Path $TempRoot | Out-Null
    $env:PERSONAL_HUB_DATA_DIR = $TempRoot
    $env:PERSONAL_HUB_PORT = [string]$Port
    $env:PERSONAL_HUB_NO_BROWSER = "1"
    $WorkingDirectory = Split-Path -Parent $Executable

    $First = Start-Process -FilePath $Executable -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $TempRoot 'first-stderr.log')
    $null = $First.Handle
    $Health = Wait-ForHealth -Port $Port -Process $First
    if ($Health.status -ne "ok" -or $Health.host -ne "127.0.0.1") { throw "Unexpected health response." }

    $Bootstrap = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v1/bootstrap" -TimeoutSec 2
    if ([System.IO.Path]::GetFullPath($Bootstrap.database_path) -ne [System.IO.Path]::GetFullPath((Join-Path $TempRoot "data\personal_data.db"))) {
        throw "Packaged app used an unexpected data file."
    }
    $HomePageResponse = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -TimeoutSec 2 -UseBasicParsing
    $DirectRoute = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/development" -TimeoutSec 2 -UseBasicParsing
    if ($HomePageResponse.StatusCode -ne 200 -or $DirectRoute.StatusCode -ne 200 -or $HomePageResponse.Content -notmatch "PersonalHub") {
        throw "Packaged frontend or direct route was not served."
    }

    $Headers = @{ "X-Local-Token" = $Bootstrap.local_token }
    $Body = '{"content":"package-persistence"}'
    Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v1/quick-notes" -Method Post -Headers $Headers -ContentType "application/json" -Body $Body -TimeoutSec 2 | Out-Null

    $OfflineModelAddress = "http://127.0.0.1:$(Get-FreeLoopbackPort)"
    $ModelConfig = @{ base_url = $OfflineModelAddress; model = 'package-test-model' } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v1/ai/ollama/settings" -Method Put -Headers $Headers -ContentType "application/json" -Body $ModelConfig -TimeoutSec 2 | Out-Null
    $DisconnectedStatus = 0
    try {
        $EndpointBody = @{ base_url = $OfflineModelAddress } | ConvertTo-Json -Compress
        $DisconnectedResponse = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/v1/ai/ollama/models" -Method Post -Headers $Headers -ContentType "application/json" -Body $EndpointBody -TimeoutSec 5 -UseBasicParsing
        $DisconnectedStatus = [int]$DisconnectedResponse.StatusCode
    } catch {
        if ($null -eq $_.Exception.Response) { throw }
        $DisconnectedStatus = [int]$_.Exception.Response.StatusCode
    }
    if ($DisconnectedStatus -ne 503) { throw "Packaged Ollama client did not handle a disconnected local service (HTTP $DisconnectedStatus)." }

    $Second = Start-Process -FilePath $Executable -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $TempRoot 'second-stderr.log')
    # Windows PowerShell needs the handle retained before this short launch exits.
    $null = $Second.Handle
    if (-not $Second.WaitForExit(10000)) { throw "Second packaged instance did not exit." }
    $Second.WaitForExit()
    if ($Second.ExitCode -ne 0) { throw "Second packaged instance returned $($Second.ExitCode)." }
    $First.Refresh()
    if ($First.HasExited) { throw "Second launch interrupted the running instance." }

    Stop-TestProcess -Process $First
    $First = $null
    Start-Sleep -Milliseconds 400

    $Restarted = Start-Process -FilePath $Executable -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $TempRoot 'restarted-stderr.log')
    $null = $Restarted.Handle
    Wait-ForHealth -Port $Port -Process $Restarted | Out-Null
    $Notes = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v1/quick-notes" -TimeoutSec 2
    if (@($Notes).Count -ne 1 -or @($Notes)[0].content -ne "package-persistence") {
        throw "Data did not persist across a packaged app restart."
    }

    $SavedModel = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v1/ai/ollama/settings" -TimeoutSec 2
    if ($SavedModel.model -ne 'package-test-model' -or $SavedModel.base_url -ne $OfflineModelAddress) {
        throw 'Local model settings did not persist across a packaged app restart.'
    }

    Write-Host "Package smoke test passed: local-only server, frontend assets, single instance, restart persistence, Ollama client errors and persisted model settings."
} catch {
    $Failure = $_
    foreach ($LogName in @('logs\personalhub.log', 'first-stderr.log', 'second-stderr.log', 'restarted-stderr.log')) {
        $TestLog = Join-Path $TempRoot $LogName
        if (Test-Path -LiteralPath $TestLog) { Get-Content -LiteralPath $TestLog -Tail 60 }
    }
    throw $Failure
} finally {
    Stop-TestProcess -Process $Second
    Stop-TestProcess -Process $First
    Stop-TestProcess -Process $Restarted
    $env:PERSONAL_HUB_DATA_DIR = $OldDataDir
    $env:PERSONAL_HUB_PORT = $OldPort
    $env:PERSONAL_HUB_NO_BROWSER = $OldNoBrowser

    $ResolvedTemp = [System.IO.Path]::GetFullPath($TempRoot)
    if ($ResolvedTemp.StartsWith($ExpectedParent) -and (Split-Path -Leaf $ResolvedTemp).StartsWith("PersonalHubPackageSmoke-") -and (Test-Path -LiteralPath $ResolvedTemp)) {
        Remove-Item -LiteralPath $ResolvedTemp -Recurse -Force
    }
}
