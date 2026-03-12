from __future__ import annotations

from datetime import date
from pathlib import Path
import math
import re

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

from app.schemas import AnalysisResponse, CandidateEvent

try:
    import librosa
except ImportError:  # pragma: no cover - depends on runtime environment
    librosa = None


TARGET_SAMPLE_RATE = 22050
HOP_LENGTH = 256


class AnalysisError(RuntimeError):
    pass


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return slug or "untitled-track"


def _title_from_file_name(file_name: str) -> str:
    title = Path(file_name).stem.replace("_", " ").replace("-", " ").strip()
    return title.title() or "Untitled Track"


def _round_float(value: float, digits: int = 3) -> float:
    return round(float(value), digits)


def _first_float(value: object, fallback: float) -> float:
    array = np.asarray(value, dtype=float).reshape(-1)

    if array.size == 0:
        return fallback

    return float(array[0])


def _snap_bpm(value: float) -> float:
    nearest_integer = round(float(value))

    if abs(float(value) - nearest_integer) <= 0.1:
        return float(nearest_integer)

    return float(value)


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _load_audio(saved_path: Path) -> tuple[np.ndarray, int]:
    try:
        signal, sample_rate = sf.read(str(saved_path), dtype="float32", always_2d=False)
    except Exception as exc:  # pragma: no cover - decoder depends on local runtime
        raise AnalysisError("Unable to decode the uploaded audio file.") from exc

    signal = np.asarray(signal, dtype=np.float32)

    if signal.ndim > 1:
        signal = np.mean(signal, axis=1)

    if signal.size == 0:
        raise AnalysisError("The uploaded audio file is empty.")

    if sample_rate != TARGET_SAMPLE_RATE:
        gcd = math.gcd(sample_rate, TARGET_SAMPLE_RATE)
        signal = resample_poly(signal, TARGET_SAMPLE_RATE // gcd, sample_rate // gcd).astype(np.float32)
        sample_rate = TARGET_SAMPLE_RATE

    return signal, sample_rate


def _candidate_grid_for_step(beat_index: int, slot_in_beat: int, beat_duration: float) -> tuple[str, int, float, float, float, str]:
    beat_in_bar = ((beat_index - 1) % 4) + 1

    if slot_in_beat == 0 and beat_in_bar == 1:
        return (
            "downbeat",
            1,
            min(max(beat_duration * 0.18, 0.05), 0.13),
            0.26,
            0.20,
            "Bar-start pulse matched a local onset.",
        )

    if slot_in_beat == 0:
        return (
            "beat",
            1,
            min(max(beat_duration * 0.16, 0.045), 0.11),
            0.28,
            0.21,
            "Quarter-note pulse matched a local onset.",
        )

    if slot_in_beat == 2:
        return (
            "offbeat",
            2,
            min(max(beat_duration * 0.12, 0.035), 0.085),
            0.23,
            0.16,
            "Eighth-note offbeat matched a local onset.",
        )

    return (
        "subdivision",
        4,
        min(max(beat_duration * 0.085, 0.028), 0.06),
        0.19,
        0.12,
        "Sixteenth-note subdivision matched a local onset.",
    )


def _build_candidate_events(
    song_length_sec: float,
    offset_sec: float,
    global_bpm: float,
    sample_rate: int,
    onset_envelope: np.ndarray,
) -> list[CandidateEvent]:
    if global_bpm <= 0 or song_length_sec <= 0 or onset_envelope.size == 0:
        return []

    beat_duration = 60.0 / global_bpm
    step_duration = beat_duration / 4.0
    step_times = np.arange(offset_sec, song_length_sec + step_duration * 0.5, step_duration, dtype=float)
    frame_duration = HOP_LENGTH / sample_rate

    if step_times.size == 0:
        return []

    reference_strength = float(np.percentile(onset_envelope, 92))

    if reference_strength <= 0:
        reference_strength = float(np.max(onset_envelope))

    if reference_strength <= 0:
        return []

    candidate_events: list[CandidateEvent] = []

    for step_index, event_time in enumerate(step_times):
        if event_time > song_length_sec:
            break

        beat_index = (step_index // 4) + 1
        beat_in_bar = ((beat_index - 1) % 4) + 1
        slot_in_beat = step_index % 4
        timing_role, grid_division, window_sec, min_confidence, min_strength, role_reason = _candidate_grid_for_step(
            beat_index=beat_index,
            slot_in_beat=slot_in_beat,
            beat_duration=beat_duration,
        )

        center_frame = int(round(event_time / frame_duration))
        window_frames = max(1, int(round(window_sec / frame_duration)))
        start_frame = max(0, center_frame - window_frames)
        end_frame = min(onset_envelope.size, center_frame + window_frames + 1)

        if start_frame >= end_frame:
            continue

        local_slice = onset_envelope[start_frame:end_frame]
        local_peak_index = int(np.argmax(local_slice))
        peak_frame = start_frame + local_peak_index
        distance_sec = abs(peak_frame - center_frame) * frame_duration
        normalized_strength = _clamp01(float(local_slice[local_peak_index]) / reference_strength)
        closeness = _clamp01(1.0 - (distance_sec / window_sec if window_sec > 0 else 1.0))
        confidence = (normalized_strength * 0.7) + (closeness * 0.3)

        if confidence < min_confidence and normalized_strength < min_strength:
            continue

        if confidence >= 0.8 or normalized_strength >= 0.88:
            kind = "strong"
            reason = f"{role_reason} Strong local energy."
        elif confidence >= 0.62:
            kind = "steady"
            reason = f"{role_reason} Stable local energy."
        else:
            kind = "light"
            reason = f"{role_reason} Lighter local energy."

        candidate_events.append(
            CandidateEvent(
                id=f"evt-{step_index + 1:05d}",
                timeSec=_round_float(event_time),
                beatIndex=beat_index,
                barIndex=((beat_index - 1) // 4) + 1,
                beatInBar=beat_in_bar,
                slotInBeat=slot_in_beat,
                gridDivision=grid_division,
                timingRole=timing_role,
                confidence=_round_float(confidence, 3),
                strength=_round_float(normalized_strength, 3),
                kind=kind,
                reason=reason,
            )
        )

    return candidate_events


def analyze_audio_file(file_name: str, saved_path: Path) -> AnalysisResponse:
    if librosa is None:
        raise AnalysisError(
            "librosa is not installed in the active Python environment. Use backend/.venv for the API."
        )

    signal, sample_rate = _load_audio(saved_path)
    duration_sec = signal.size / sample_rate
    _, percussive_signal = librosa.effects.hpss(signal, margin=(1.0, 4.0))
    onset_envelope = np.asarray(
        librosa.onset.onset_strength(
            y=percussive_signal,
            sr=sample_rate,
            hop_length=HOP_LENGTH,
            aggregate=np.median,
        ),
        dtype=float,
    )

    if onset_envelope.size == 0 or float(np.max(onset_envelope)) <= 0:
        raise AnalysisError("Unable to detect rhythmic onsets in this audio file.")

    estimated_tempo, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_envelope,
        sr=sample_rate,
        hop_length=HOP_LENGTH,
        start_bpm=120.0,
        trim=False,
    )
    beat_frames_array = np.asarray(beat_frames, dtype=int)
    beat_times = librosa.frames_to_time(beat_frames_array, sr=sample_rate, hop_length=HOP_LENGTH)

    onset_frames = np.asarray(
        librosa.onset.onset_detect(
            onset_envelope=onset_envelope,
            sr=sample_rate,
            hop_length=HOP_LENGTH,
            backtrack=True,
        ),
        dtype=int,
    )
    onset_times = librosa.frames_to_time(onset_frames, sr=sample_rate, hop_length=HOP_LENGTH)
    global_bpm = _first_float(estimated_tempo, 120.0)

    first_onset_sec = float(onset_times[0]) if onset_times.size > 0 else None

    if beat_times.size > 1:
        global_bpm = _snap_bpm(60.0 / float(np.median(np.diff(beat_times))))
        offset_sec = float(beat_times[0])

        if first_onset_sec is not None:
            beat_duration = 60.0 / max(global_bpm, 1e-6)
            onset_gap = offset_sec - first_onset_sec

            if 0.0 <= onset_gap <= beat_duration * 0.15:
                offset_sec = first_onset_sec
    elif beat_times.size == 1:
        offset_sec = float(beat_times[0])

        if first_onset_sec is not None and 0.0 <= offset_sec - first_onset_sec <= 0.08:
            offset_sec = first_onset_sec
    elif onset_times.size > 0:
        offset_sec = float(onset_times[0])
    else:
        raise AnalysisError("Unable to estimate BPM or offset from this audio file.")

    candidate_events = _build_candidate_events(
        song_length_sec=duration_sec,
        offset_sec=offset_sec,
        global_bpm=global_bpm,
        sample_rate=sample_rate,
        onset_envelope=onset_envelope,
    )

    return AnalysisResponse(
        schemaVersion=1,
        songId=_slugify(Path(file_name).stem),
        songName=_title_from_file_name(file_name),
        audioFileName=file_name,
        analysisVersion=date.today().isoformat(),
        globalBpm=_round_float(global_bpm, 2),
        offsetSec=_round_float(offset_sec),
        songLengthSec=_round_float(duration_sec),
        candidateEvents=candidate_events,
    )
