$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonPath = Join-Path $scriptDir ".venv\Scripts\python.exe"

if (-not (Test-Path $pythonPath)) {
    throw "backend/.venv 가 없습니다. 먼저 'python -m venv .venv' 와 'pip install -r requirements.txt' 를 실행하세요."
}

Push-Location $scriptDir

try {
    & $pythonPath -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
}
finally {
    Pop-Location
}
