$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$cloudflared = Join-Path $projectRoot '.public-runtime\cloudflared.exe'
$tunnels = @(Get-CimInstance Win32_Process | Where-Object {
    [string]::Equals($_.ExecutablePath, $cloudflared, [StringComparison]::OrdinalIgnoreCase) -and
    $_.CommandLine -match '127\.0\.0\.1:8766'
})
foreach ($tunnel in $tunnels) { Stop-Process -Id $tunnel.ProcessId }
$listener = Get-NetTCPConnection -State Listen -LocalPort 8766 -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    $server = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$listener.OwningProcess)
    if (-not $server -or $server.CommandLine -notmatch ' -m app\.run_public') { throw 'Port 8766 belongs to another program.' }
    $parent = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$server.ParentProcessId)
    $expected = Join-Path $projectRoot '.venv\Scripts\python.exe'
    if (-not $parent -or -not [string]::Equals($parent.ExecutablePath, $expected, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The server process does not belong to this project.'
    }
    Stop-Process -Id $server.ProcessId
    Stop-Process -Id $parent.ProcessId -ErrorAction SilentlyContinue
}
Write-Output 'Public sharing stopped. Account data was not removed.'
