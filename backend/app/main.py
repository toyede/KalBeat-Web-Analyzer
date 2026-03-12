from pathlib import Path
import shutil
from uuid import uuid4

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.schemas import AnalysisResponse
from app.services.analysis import AnalysisError, analyze_audio_file


ALLOWED_EXTENSIONS = {".wav", ".mp3"}
ALLOWED_CONTENT_TYPES = {
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
    "audio/x-mp3",
    "audio/x-wav",
    "application/octet-stream",
}

settings.upload_dir.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title="KalBeat Web Analyzer API",
    version="0.1.0",
    summary="리듬게임 BGM 분석 API",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.allowed_origins),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _validate_upload(file: UploadFile) -> str:
    extension = Path(file.filename or "").suffix.lower()

    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="현재는 .wav와 .mp3 파일만 지원합니다.")

    if file.content_type and file.content_type.lower() not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"지원하지 않는 Content-Type입니다: {file.content_type}",
        )

    return extension


@app.get("/")
def root() -> dict[str, str]:
    return {
        "service": "KalBeat Web Analyzer API",
        "version": "0.1.0",
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/config")
def config() -> dict[str, object]:
    return {
        "authenticationRequired": False,
        "acceptedExtensions": sorted(ALLOWED_EXTENSIONS),
        "appLevelMaxUploadSizeMb": None,
    }


@app.post("/api/analyze", response_model=AnalysisResponse)
async def analyze(file: UploadFile = File(...)) -> AnalysisResponse:
    extension = _validate_upload(file)
    file_name = file.filename or f"upload{extension}"
    upload_id = uuid4().hex
    destination = settings.upload_dir / f"{upload_id}{extension}"

    try:
        with destination.open("wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        return analyze_audio_file(file_name=file_name, saved_path=destination)
    except AnalysisError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    finally:
        await file.close()
