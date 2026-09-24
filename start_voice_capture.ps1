[CmdletBinding()]
param(
    [int]$Port = 8765,
    [switch]$NoBrowser,
    [switch]$NoWait
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = $PSScriptRoot
$url = 'http://127.0.0.1:{0}/' -f $Port

function Test-VoiceCaptureServer {
    param([Parameter(Mandatory = $true)][string]$TargetUrl)

    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $TargetUrl -TimeoutSec 1
        return (
            $response.StatusCode -eq 200 -and
            $response.Content.Contains('aria-labelledby="pageTitle"')
        )
    }
    catch {
        return $false
    }
}

if (Test-VoiceCaptureServer -TargetUrl $url) {
    Write-Host ''
    Write-Host 'Voice capture server is already running. Reusing:' -ForegroundColor Green
    Write-Host $url
    Write-Output 'VOICE_CAPTURE_ALREADY_RUNNING'

    if (-not $NoBrowser) {
        Start-Process $url
    }
    if (-not $NoWait) {
        Write-Host ''
        [void](Read-Host 'Press Enter after you finish using the page')
    }
    exit 0
}

$occupiedPort = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($occupiedPort) {
    throw "Port $Port is already used by another program. Close it or pass a different -Port value."
}

$pythonCommand = Get-Command python -ErrorAction SilentlyContinue | Select-Object -First 1
$pythonArguments = @('-m', 'http.server', $Port, '--bind', '127.0.0.1')

if ($null -eq $pythonCommand) {
    $pythonCommand = Get-Command py -ErrorAction SilentlyContinue | Select-Object -First 1
    $pythonArguments = @('-3', '-m', 'http.server', $Port, '--bind', '127.0.0.1')
}

if ($null -eq $pythonCommand) {
    $bundledPython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
    if (Test-Path -LiteralPath $bundledPython) {
        $pythonCommand = Get-Item -LiteralPath $bundledPython
        $pythonArguments = @('-m', 'http.server', $Port, '--bind', '127.0.0.1')
    }
}

if ($null -eq $pythonCommand) {
    throw 'Python was not found. Install Python 3 or run another static file server in this folder.'
}

$server = Start-Process `
    -FilePath $pythonCommand.Source `
    -ArgumentList $pythonArguments `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -PassThru

$serverReady = $false
for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    if ($server.HasExited) {
        break
    }
    if (Test-VoiceCaptureServer -TargetUrl $url) {
        $serverReady = $true
        break
    }
    Start-Sleep -Milliseconds 125
}

if (-not $serverReady) {
    if (-not $server.HasExited) {
        Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
    }
    throw "The local voice capture server did not start at $url. Check Python, the port, or security software."
}

if (-not $NoBrowser) {
    Start-Process $url
}

Write-Host ''
Write-Host 'Voice capture page is ready:' -ForegroundColor Green
Write-Host $url
Write-Output 'VOICE_CAPTURE_READY'
Write-Host ''
Write-Host 'Recordings stay in browser memory and are not uploaded by this server.'

if ($NoWait) {
    Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
    exit 0
}

Write-Host 'After recording and export, return here and press Enter to stop the local server.'
try {
    [void](Read-Host)
}
finally {
    if (-not $server.HasExited) {
        Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
    }
}
