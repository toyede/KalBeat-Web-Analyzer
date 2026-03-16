$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Join-Path $rootDir "backend"
$frontendDir = Join-Path $rootDir "frontend"
$runtimeDir = Join-Path $rootDir ".kalbeat-runtime"
$backendPython = Join-Path $backendDir ".venv\Scripts\python.exe"
$npmPath = (Get-Command npm.cmd -ErrorAction Stop).Source

$backendPidPath = Join-Path $runtimeDir "backend.pid"
$frontendPidPath = Join-Path $runtimeDir "frontend.pid"
$backendLogPath = Join-Path $runtimeDir "backend.log"
$backendErrPath = Join-Path $runtimeDir "backend.err.log"
$frontendLogPath = Join-Path $runtimeDir "frontend.log"
$frontendErrPath = Join-Path $runtimeDir "frontend.err.log"

$backendUrl = "http://127.0.0.1:8000/health"
$frontendUrl = "http://127.0.0.1:3000"

function Ensure-Directory($path) {
    if (-not (Test-Path $path)) {
        New-Item -ItemType Directory -Path $path | Out-Null
    }
}

function Read-ManagedProcess($pidPath) {
    if (-not (Test-Path $pidPath)) {
        return $null
    }

    $rawPid = Get-Content $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1
    $parsedPid = 0

    if (-not [int]::TryParse($rawPid, [ref]$parsedPid)) {
        Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
        return $null
    }

    $pidValue = [int]$parsedPid
    $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue

    if (-not $process) {
        Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
        return $null
    }

    return $process
}

function Save-ManagedProcess($pidPath, $processId) {
    Set-Content -Path $pidPath -Value $processId -Encoding ascii
}

function Wait-ForUrl($url, $timeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)

    while ((Get-Date) -lt $deadline) {
        try {
            Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 | Out-Null
            return $true
        }
        catch {
            Start-Sleep -Milliseconds 500
        }
    }

    return $false
}

Ensure-Directory $runtimeDir

if (-not (Test-Path $backendPython)) {
    throw "Missing backend virtual environment: $backendPython"
}

if (-not (Test-Path (Join-Path $frontendDir "node_modules"))) {
    throw "Missing frontend dependencies. Run npm install in frontend first."
}

$backendProcess = Read-ManagedProcess $backendPidPath
$frontendProcess = Read-ManagedProcess $frontendPidPath

if (-not $backendProcess) {
    $backendProcess = Start-Process `
        -FilePath $backendPython `
        -ArgumentList @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000", "--reload") `
        -WorkingDirectory $backendDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $backendLogPath `
        -RedirectStandardError $backendErrPath `
        -PassThru

    Save-ManagedProcess $backendPidPath $backendProcess.Id
}

if (-not $frontendProcess) {
    $frontendProcess = Start-Process `
        -FilePath $npmPath `
        -ArgumentList @("run", "dev") `
        -WorkingDirectory $frontendDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $frontendLogPath `
        -RedirectStandardError $frontendErrPath `
        -PassThru

    Save-ManagedProcess $frontendPidPath $frontendProcess.Id
}

$backendReady = Wait-ForUrl $backendUrl 20
$frontendReady = Wait-ForUrl $frontendUrl 30

if (-not $backendReady) {
    Write-Warning "Backend did not respond in time. Check $backendErrPath"
}

if (-not $frontendReady) {
    Write-Warning "Frontend did not respond in time. Check $frontendErrPath"
}

Start-Process $frontendUrl
