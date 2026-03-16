$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeDir = Join-Path $rootDir ".kalbeat-runtime"
$pidPaths = @(
    (Join-Path $runtimeDir "backend.pid"),
    (Join-Path $runtimeDir "frontend.pid")
)

foreach ($pidPath in $pidPaths) {
    if (-not (Test-Path $pidPath)) {
        continue
    }

    $parsedPid = 0
    $rawPid = Get-Content $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1

    if ([int]::TryParse($rawPid, [ref]$parsedPid)) {
        $process = Get-Process -Id $parsedPid -ErrorAction SilentlyContinue

        if ($process) {
            Stop-Process -Id $parsedPid -Force -ErrorAction SilentlyContinue
        }
    }

    Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
}
