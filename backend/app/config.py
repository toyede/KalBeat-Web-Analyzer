from dataclasses import dataclass
from pathlib import Path
import os


APP_DIR = Path(__file__).resolve().parent
BACKEND_DIR = APP_DIR.parent
ENV_FILE = BACKEND_DIR / ".env"


def _load_env_file() -> None:
    if not ENV_FILE.exists():
        return

    for raw_line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()

        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _split_origins(raw_value: str) -> tuple[str, ...]:
    return tuple(origin.strip() for origin in raw_value.split(",") if origin.strip())


@dataclass(frozen=True)
class Settings:
    upload_dir: Path
    allowed_origins: tuple[str, ...]


def load_settings() -> Settings:
    upload_dir_raw = os.getenv("UPLOAD_DIR", "uploads")
    upload_dir = Path(upload_dir_raw)

    if not upload_dir.is_absolute():
        upload_dir = BACKEND_DIR / upload_dir

    origins_raw = os.getenv(
        "ALLOWED_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000",
    )

    return Settings(
        upload_dir=upload_dir,
        allowed_origins=_split_origins(origins_raw),
    )

_load_env_file()
settings = load_settings()
