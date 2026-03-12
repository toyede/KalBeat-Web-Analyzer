# KalBeat Web Analyzer

리듬게임 채보 제작을 위한 웹 분석 도구의 초기 스캐폴드입니다. 현재 구성은 `Next.js` 프론트엔드와 `FastAPI` 백엔드를 하나의 저장소에서 함께 관리하는 방식입니다.

## 현재 결정사항

- 인증: 없음
- 업로드 포맷: `wav`, `mp3`
- 앱 레벨 업로드 용량 제한: 없음
- 프론트엔드: `Next.js + TypeScript`
- 백엔드: `FastAPI + Python 3.11`
- 1차 범위: 업로드, BPM/offset/downbeat 초안, 섹션/비트 시각화용 JSON 응답

참고: 앱 코드에서 용량 제한은 두지 않았지만, 실제 배포 환경에서는 프록시나 호스팅 서비스에서 별도 제한이 걸릴 수 있습니다.

## 폴더 구조

```text
frontend/  Next.js 앱
backend/   FastAPI API
```

## 빠른 실행

### 1. 백엔드

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn app.main:app --reload
```

가상환경을 매번 직접 활성화하기 싫으면 아래처럼 실행해도 됩니다.

```powershell
.\backend\run-dev.ps1
```

### 2. 프론트엔드

```powershell
cd frontend
npm install
Copy-Item .env.example .env.local
npm run dev
```

프론트엔드는 기본적으로 `http://127.0.0.1:8000`의 백엔드를 바라봅니다.

## 현재 구현 상태

- 업로드 화면과 JSON 프리뷰 UI
- `wav`, `mp3` 파일 형식 검증
- FastAPI 업로드 엔드포인트
- `librosa` 기반 BPM, beat, downbeat, section, chart hint 초안 생성
- Unity 연동용 분석 JSON 응답

## 가상환경과 배포

- `backend/.venv`는 로컬 개발용 Python 격리 환경입니다. 이 폴더 안에서만 실행해야 한다는 뜻이 아니라, 이 환경의 Python 인터프리터로 실행해야 한다는 뜻입니다.
- 로컬에서는 `.venv\Scripts\Activate.ps1`로 활성화하거나, `backend/run-dev.ps1`처럼 `.venv\Scripts\python.exe`를 직접 호출하면 됩니다.
- 배포할 때는 로컬 `.venv`를 그대로 올리지 않습니다. 서버나 호스팅 환경에서 새 Python 환경을 만들고 `pip install -r requirements.txt`를 다시 실행합니다.
- Docker는 필수는 아니지만, 오디오 라이브러리와 시스템 의존성을 고정하기 쉬워서 재현성 측면에서는 권장할 만합니다.

## 다음 작업

- 멀티 BPM 정확도 개선과 템포맵 보정
- stem separation 및 악기 단위 onset 분석
- 분석 작업 큐와 상태 추적
- 템포맵/다운비트/차트 힌트 보정 UI
- Unity import preset 맞춤 내보내기
