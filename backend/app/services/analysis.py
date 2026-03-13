from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path
import math
import re

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

from app.schemas import AnalysisResponse, CandidateEvent, CandidateStrategy, CandidateVariant

try:
    import librosa
except ImportError:  # pragma: no cover - depends on runtime environment
    librosa = None


TARGET_SAMPLE_RATE = 22050
HOP_LENGTH = 256
FOUR_BAR_BEATS = 16
TIMING_ROLE_ORDER = ("pulse", "offbeat", "subdivision", "thirtySecond", "triplet", "freeAccent")
TIMING_ROLE_SORT_INDEX = {role: index for index, role in enumerate(TIMING_ROLE_ORDER)}
STRATEGY_META: dict[CandidateStrategy, tuple[str, str]] = {
    "global": (
        "전곡 기준",
        "곡 전체 onset 에너지를 한 기준으로 보고 후보를 추출합니다. 전체적으로 안정적이지만 조용한 구간에서는 후보가 덜 나올 수 있습니다.",
    ),
    "section4bar": (
        "4마디 기준",
        "4마디 단위로 onset 세기를 다시 평가합니다. 구간별 상대 강세를 더 반영해서 조용한 파트의 후보가 더 잘 살아납니다.",
    ),
}


@dataclass(frozen=True)
class GridRoleSpec:
    timing_role: str
    grid_division: int
    slots: tuple[int, ...]
    window_factor: float
    min_window_sec: float
    max_window_sec: float
    min_confidence: float
    min_strength: float
    reason: str


GRID_ROLE_SPECS: tuple[GridRoleSpec, ...] = (
    GridRoleSpec(
        timing_role="pulse",
        grid_division=1,
        slots=(0,),
        window_factor=0.16,
        min_window_sec=0.045,
        max_window_sec=0.11,
        min_confidence=0.24,
        min_strength=0.18,
        reason="Quarter-note pulse matched a local onset.",
    ),
    GridRoleSpec(
        timing_role="offbeat",
        grid_division=2,
        slots=(1,),
        window_factor=0.12,
        min_window_sec=0.032,
        max_window_sec=0.082,
        min_confidence=0.19,
        min_strength=0.13,
        reason="Eighth-note offbeat matched a local onset.",
    ),
    GridRoleSpec(
        timing_role="subdivision",
        grid_division=4,
        slots=(1, 3),
        window_factor=0.08,
        min_window_sec=0.024,
        max_window_sec=0.055,
        min_confidence=0.14,
        min_strength=0.10,
        reason="Sixteenth-note subdivision matched a local onset.",
    ),
    GridRoleSpec(
        timing_role="thirtySecond",
        grid_division=8,
        slots=(1, 3, 5, 7),
        window_factor=0.05,
        min_window_sec=0.016,
        max_window_sec=0.034,
        min_confidence=0.10,
        min_strength=0.07,
        reason="Thirty-second subdivision matched a local onset.",
    ),
    GridRoleSpec(
        timing_role="triplet",
        grid_division=3,
        slots=(1, 2),
        window_factor=0.075,
        min_window_sec=0.024,
        max_window_sec=0.052,
        min_confidence=0.13,
        min_strength=0.09,
        reason="Triplet or shuffle subdivision matched a local onset.",
    ),
)


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


def _role_reason(spec: GridRoleSpec, beat_in_bar: int) -> str:
    if spec.timing_role == "pulse" and beat_in_bar == 1:
        return "Quarter-note pulse at a bar start matched a local onset."

    return spec.reason


def _role_kind(confidence: float, normalized_strength: float) -> tuple[str, str]:
    if confidence >= 0.8 or normalized_strength >= 0.88:
        return "strong", "Strong local energy."

    if confidence >= 0.58 or normalized_strength >= 0.56:
        return "steady", "Stable local energy."

    return "light", "Lighter local energy."


def _reference_strength(onset_envelope: np.ndarray, percentile: float = 90) -> float:
    reference_strength = float(np.percentile(onset_envelope, percentile))

    if reference_strength <= 0:
        reference_strength = float(np.max(onset_envelope))

    return reference_strength


def _build_four_bar_reference_strengths(
    onset_envelope: np.ndarray,
    sample_rate: int,
    offset_sec: float,
    song_length_sec: float,
    beat_duration: float,
) -> dict[int, float]:
    frame_duration = HOP_LENGTH / sample_rate
    chunk_duration = beat_duration * FOUR_BAR_BEATS
    chunk_count = max(1, int(math.ceil(max(song_length_sec - offset_sec, beat_duration) / chunk_duration)))
    strengths: dict[int, float] = {}

    for chunk_index in range(chunk_count):
        chunk_start = max(0.0, offset_sec + chunk_index * chunk_duration)
        chunk_end = min(song_length_sec, chunk_start + chunk_duration)
        start_frame = max(0, int(math.floor(chunk_start / frame_duration)))
        end_frame = min(onset_envelope.size, int(math.ceil(chunk_end / frame_duration)))
        chunk_slice = onset_envelope[start_frame:end_frame]

        if chunk_slice.size == 0:
            strengths[chunk_index] = 0.0
            continue

        strengths[chunk_index] = _reference_strength(chunk_slice, percentile=86)

    return strengths


def _event_reference_strength(
    strategy: CandidateStrategy,
    beat_index: int,
    global_reference_strength: float,
    four_bar_reference_strengths: dict[int, float],
) -> float:
    if strategy == "global":
        return global_reference_strength

    chunk_index = max(0, (beat_index - 1) // FOUR_BAR_BEATS)
    local_reference_strength = four_bar_reference_strengths.get(chunk_index, 0.0)
    return max(local_reference_strength, global_reference_strength * 0.5)


def _strategy_threshold_scale(strategy: CandidateStrategy) -> float:
    return 1.0 if strategy == "global" else 0.92


def _build_grid_candidates(
    strategy: CandidateStrategy,
    song_length_sec: float,
    offset_sec: float,
    global_bpm: float,
    sample_rate: int,
    onset_envelope: np.ndarray,
) -> tuple[list[tuple[float, dict[str, object]]], np.ndarray]:
    if global_bpm <= 0 or song_length_sec <= 0 or onset_envelope.size == 0:
        return [], np.empty(0, dtype=int)

    beat_duration = 60.0 / global_bpm
    beat_starts = np.arange(offset_sec, song_length_sec + beat_duration * 0.5, beat_duration, dtype=float)
    frame_duration = HOP_LENGTH / sample_rate
    global_reference_strength = _reference_strength(onset_envelope)
    four_bar_reference_strengths = _build_four_bar_reference_strengths(
        onset_envelope=onset_envelope,
        sample_rate=sample_rate,
        offset_sec=offset_sec,
        song_length_sec=song_length_sec,
        beat_duration=beat_duration,
    )

    if global_reference_strength <= 0 or beat_starts.size == 0:
        return [], np.empty(0, dtype=int)

    threshold_scale = _strategy_threshold_scale(strategy)
    payload_entries: list[tuple[float, dict[str, object]]] = []
    matched_peak_frames: list[int] = []

    for beat_index, beat_start in enumerate(beat_starts, start=1):
        if beat_start > song_length_sec:
            break

        beat_in_bar = ((beat_index - 1) % 4) + 1
        bar_index = ((beat_index - 1) // 4) + 1
        event_reference_strength = _event_reference_strength(
            strategy=strategy,
            beat_index=beat_index,
            global_reference_strength=global_reference_strength,
            four_bar_reference_strengths=four_bar_reference_strengths,
        )

        for spec in GRID_ROLE_SPECS:
            window_sec = min(max(beat_duration * spec.window_factor, spec.min_window_sec), spec.max_window_sec)
            window_frames = max(1, int(round(window_sec / frame_duration)))
            min_confidence = spec.min_confidence * threshold_scale
            min_strength = spec.min_strength * threshold_scale

            for slot_in_beat in spec.slots:
                event_time = beat_start + ((slot_in_beat / spec.grid_division) * beat_duration)

                if event_time > song_length_sec:
                    continue

                center_frame = int(round(event_time / frame_duration))
                start_frame = max(0, center_frame - window_frames)
                end_frame = min(onset_envelope.size, center_frame + window_frames + 1)

                if start_frame >= end_frame:
                    continue

                local_slice = onset_envelope[start_frame:end_frame]
                local_peak_index = int(np.argmax(local_slice))
                peak_frame = start_frame + local_peak_index
                distance_sec = abs(peak_frame - center_frame) * frame_duration
                normalized_strength = _clamp01(float(local_slice[local_peak_index]) / max(event_reference_strength, 1e-6))
                closeness = _clamp01(1.0 - (distance_sec / window_sec if window_sec > 0 else 1.0))
                confidence = (normalized_strength * 0.72) + (closeness * 0.28)

                if confidence < min_confidence and normalized_strength < min_strength:
                    continue

                kind, energy_reason = _role_kind(confidence, normalized_strength)
                payload_entries.append(
                    (
                        event_time,
                        {
                            "id": "",
                            "timeSec": _round_float(event_time),
                            "beatIndex": beat_index,
                            "barIndex": bar_index,
                            "beatInBar": beat_in_bar,
                            "slotInBeat": slot_in_beat,
                            "gridDivision": spec.grid_division,
                            "timingRole": spec.timing_role,
                            "confidence": _round_float(confidence, 3),
                            "strength": _round_float(normalized_strength, 3),
                            "kind": kind,
                            "reason": f"{_role_reason(spec, beat_in_bar)} {energy_reason}",
                        },
                    )
                )
                matched_peak_frames.append(peak_frame)

    return payload_entries, np.asarray(matched_peak_frames, dtype=int)


def _build_free_accent_candidates(
    strategy: CandidateStrategy,
    song_length_sec: float,
    offset_sec: float,
    global_bpm: float,
    sample_rate: int,
    onset_envelope: np.ndarray,
    onset_frames: np.ndarray,
    matched_peak_frames: np.ndarray,
    existing_event_times: list[float],
) -> list[tuple[float, dict[str, object]]]:
    if onset_frames.size == 0 or onset_envelope.size == 0 or global_bpm <= 0:
        return []

    frame_duration = HOP_LENGTH / sample_rate
    beat_duration = 60.0 / global_bpm
    global_reference_strength = _reference_strength(onset_envelope)
    four_bar_reference_strengths = _build_four_bar_reference_strengths(
        onset_envelope=onset_envelope,
        sample_rate=sample_rate,
        offset_sec=offset_sec,
        song_length_sec=song_length_sec,
        beat_duration=beat_duration,
    )

    if global_reference_strength <= 0:
        return []

    matched_peak_frames = np.unique(matched_peak_frames)
    threshold_scale = _strategy_threshold_scale(strategy)
    free_tolerance_frames = max(1, int(round(min(max(beat_duration * 0.045, 0.02), 0.05) / frame_duration)))
    grid_tolerance_sec = min(max(beat_duration * 0.04, 0.018), 0.045)
    payload_entries: list[tuple[float, dict[str, object]]] = []

    for onset_frame in onset_frames:
        event_time = float(librosa.frames_to_time(int(onset_frame), sr=sample_rate, hop_length=HOP_LENGTH))

        if event_time < max(0.0, offset_sec - beat_duration * 0.25) or event_time > song_length_sec:
            continue

        beat_position = max(0.0, (event_time - offset_sec) / beat_duration)
        beat_index = int(math.floor(beat_position)) + 1
        event_reference_strength = _event_reference_strength(
            strategy=strategy,
            beat_index=beat_index,
            global_reference_strength=global_reference_strength,
            four_bar_reference_strengths=four_bar_reference_strengths,
        )
        normalized_strength = _clamp01(float(onset_envelope[int(onset_frame)]) / max(event_reference_strength, 1e-6))

        if normalized_strength < 0.22 * threshold_scale:
            continue

        if matched_peak_frames.size > 0 and int(np.min(np.abs(matched_peak_frames - onset_frame))) <= free_tolerance_frames:
            continue

        if existing_event_times and min(abs(event_time - grid_event_time) for grid_event_time in existing_event_times) <= grid_tolerance_sec:
            continue

        beat_in_bar = ((beat_index - 1) % 4) + 1
        bar_index = ((beat_index - 1) // 4) + 1
        nearest_grid_time = offset_sec + round(beat_position * 4.0) * (beat_duration / 4.0)
        off_gridness = _clamp01(abs(event_time - nearest_grid_time) / max(beat_duration * 0.08, 1e-6))
        confidence = _clamp01((normalized_strength * 0.75) + (off_gridness * 0.25))
        kind, energy_reason = _role_kind(confidence, normalized_strength)

        payload_entries.append(
            (
                event_time,
                {
                    "id": "",
                    "timeSec": _round_float(event_time),
                    "beatIndex": beat_index,
                    "barIndex": bar_index,
                    "beatInBar": beat_in_bar,
                    "slotInBeat": 0,
                    "gridDivision": 0,
                    "timingRole": "freeAccent",
                    "confidence": _round_float(confidence, 3),
                    "strength": _round_float(normalized_strength, 3),
                    "kind": kind,
                    "reason": f"Strong onset landed outside the current beat grid. {energy_reason}",
                },
            )
        )

    return payload_entries


def _build_candidate_events(
    strategy: CandidateStrategy,
    song_length_sec: float,
    offset_sec: float,
    global_bpm: float,
    sample_rate: int,
    onset_envelope: np.ndarray,
    onset_frames: np.ndarray,
) -> list[CandidateEvent]:
    grid_entries, matched_peak_frames = _build_grid_candidates(
        strategy=strategy,
        song_length_sec=song_length_sec,
        offset_sec=offset_sec,
        global_bpm=global_bpm,
        sample_rate=sample_rate,
        onset_envelope=onset_envelope,
    )
    free_entries = _build_free_accent_candidates(
        strategy=strategy,
        song_length_sec=song_length_sec,
        offset_sec=offset_sec,
        global_bpm=global_bpm,
        sample_rate=sample_rate,
        onset_envelope=onset_envelope,
        onset_frames=onset_frames,
        matched_peak_frames=matched_peak_frames,
        existing_event_times=[entry[0] for entry in grid_entries],
    )
    payload_entries = grid_entries + free_entries
    payload_entries.sort(
        key=lambda item: (
            item[0],
            TIMING_ROLE_SORT_INDEX.get(str(item[1]["timingRole"]), len(TIMING_ROLE_SORT_INDEX)),
            int(item[1]["gridDivision"]),
            int(item[1]["slotInBeat"]),
        )
    )

    prefix = "gbl" if strategy == "global" else "s4b"
    candidate_events: list[CandidateEvent] = []

    for index, (_, payload) in enumerate(payload_entries, start=1):
        payload = {**payload, "id": f"{prefix}-evt-{index:05d}"}
        candidate_events.append(CandidateEvent(**payload))

    return candidate_events


def _build_variant(
    strategy: CandidateStrategy,
    song_length_sec: float,
    offset_sec: float,
    global_bpm: float,
    sample_rate: int,
    onset_envelope: np.ndarray,
    onset_frames: np.ndarray,
) -> CandidateVariant:
    label, description = STRATEGY_META[strategy]
    candidate_events = _build_candidate_events(
        strategy=strategy,
        song_length_sec=song_length_sec,
        offset_sec=offset_sec,
        global_bpm=global_bpm,
        sample_rate=sample_rate,
        onset_envelope=onset_envelope,
        onset_frames=onset_frames,
    )

    return CandidateVariant(
        strategy=strategy,
        label=label,
        description=description,
        candidateEvents=candidate_events,
    )


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

    candidate_variants = [
      _build_variant(
          strategy="global",
          song_length_sec=duration_sec,
          offset_sec=offset_sec,
          global_bpm=global_bpm,
          sample_rate=sample_rate,
          onset_envelope=onset_envelope,
          onset_frames=onset_frames,
      ),
      _build_variant(
          strategy="section4bar",
          song_length_sec=duration_sec,
          offset_sec=offset_sec,
          global_bpm=global_bpm,
          sample_rate=sample_rate,
          onset_envelope=onset_envelope,
          onset_frames=onset_frames,
      ),
    ]
    default_variant = next((variant for variant in candidate_variants if variant.strategy == "global"), candidate_variants[0])

    return AnalysisResponse(
        schemaVersion=1,
        songId=_slugify(Path(file_name).stem),
        songName=_title_from_file_name(file_name),
        audioFileName=file_name,
        analysisVersion=date.today().isoformat(),
        globalBpm=_round_float(global_bpm, 2),
        offsetSec=_round_float(offset_sec),
        songLengthSec=_round_float(duration_sec),
        defaultCandidateStrategy="global",
        candidateEvents=default_variant.candidateEvents,
        candidateVariants=candidate_variants,
    )
