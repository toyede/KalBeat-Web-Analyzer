from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Literal
import math
import re

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

from app.schemas import (
    AnalysisResponse,
    CandidateEvent,
    CandidateSceneFamily,
    CandidateSceneType,
    CandidateStrategy,
    CandidateVariant,
    OffsetCandidate,
    PatternSegment,
)

try:
    import librosa
except ImportError:  # pragma: no cover - depends on runtime environment
    librosa = None


SourceProfile = Literal["global", "section4bar"]
PatternDensity = Literal["pattern", "hybrid"]

TARGET_SAMPLE_RATE = 22050
HOP_LENGTH = 256
BEATS_PER_BAR = 4
FOUR_BAR_BEATS = 16
PATTERN_UNITS_PER_BEAT = 24
SIXTEENTH_STEPS_PER_BEAT = 4
SIXTEENTH_STEPS_PER_BAR = BEATS_PER_BAR * SIXTEENTH_STEPS_PER_BEAT
# BPM octave/metrical correction: metrical-level variants of the base estimate to
# re-score (half/double plus the 2:3 and 3:4 cross-rhythm mis-locks), the perceptual
# band used to break half/double ties (half-time leaning), and comb depth.
OCTAVE_CORRECTION_RATIOS = (0.5, 2.0 / 3.0, 0.75, 1.0, 4.0 / 3.0, 1.5, 2.0)
PREFERRED_BPM_LOW = 70.0
PREFERRED_BPM_HIGH = 140.0
OCTAVE_BPM_FLOOR = 40.0
OCTAVE_BPM_CEIL = 300.0
OCTAVE_COMB_HARMONICS = 6
TIMING_ROLE_ORDER = ("pulse", "offbeat", "subdivision", "thirtySecond", "triplet", "freeAccent")
TIMING_ROLE_SORT_INDEX = {role: index for index, role in enumerate(TIMING_ROLE_ORDER)}
STYLE_META: dict[CandidateStrategy, tuple[str, str]] = {
    "reactive": (
        "반응형",
        "짧은 여백 뒤에 튀는 악센트와 박자 착지를 중심으로 즉각 반응하기 좋은 단발 입력 후보를 추립니다.",
    ),
    "pattern": (
        "패턴형",
        "직전 1~2마디의 모티프가 다음 1~2마디에 다시 드러나는 구간을 찾아 따라치기 좋은 응답 후보만 남깁니다.",
    ),
    "hybrid": (
        "반응형 + 패턴형",
        "패턴 응답 구간을 먼저 확보하고, 남는 구간에는 반응형 단발 후보를 채워 두 스타일을 섞어서 제안합니다.",
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


@dataclass(frozen=True)
class PatternWindow:
    bars: int
    cue_start_bar: int
    response_start_bar: int
    score: float
    cue_events: tuple[CandidateEvent, ...]
    response_events: tuple[CandidateEvent, ...]
    similarity: float


@dataclass(frozen=True)
class ReactiveEventScore:
    event: CandidateEvent
    score: float
    pre_gap_score: float
    phrase_score: float
    landing_score: float
    local_accent_score: float
    drum_accent_score: float
    drum_low_score: float
    drum_snap_score: float


@dataclass(frozen=True)
class QuickAttackCluster:
    events: tuple[CandidateEvent, ...]
    score: float
    lead_in_score: float
    cue_times: tuple[float, ...]


@dataclass(frozen=True)
class DrumFeatureCurves:
    low: np.ndarray
    mid: np.ndarray
    high: np.ndarray
    accent: np.ndarray


@dataclass(frozen=True)
class ReactiveGrammarCandidate:
    event: CandidateEvent
    cue_events: tuple[CandidateEvent, ...]
    prep_count: int
    step_size: int
    score: float


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


def _lag_autocorrelation(centered_envelope: np.ndarray, lag: int) -> float:
    if lag < 1 or lag >= centered_envelope.size:
        return 0.0

    left = centered_envelope[:-lag]
    right = centered_envelope[lag:]
    norm = float(np.linalg.norm(left) * np.linalg.norm(right))

    if norm <= 0:
        return 0.0

    return float(np.dot(left, right) / norm)


def _comb_score(centered_envelope: np.ndarray, bpm: float, frame_rate: float, harmonics: int = OCTAVE_COMB_HARMONICS) -> float:
    if bpm <= 0:
        return 0.0

    period_frames = (60.0 / bpm) * frame_rate
    return sum(
        _lag_autocorrelation(centered_envelope, int(round(period_frames * harmonic)))
        for harmonic in range(1, harmonics + 1)
    )


def _octave_correct_bpm(base_bpm: float, onset_envelope: np.ndarray, sample_rate: int) -> float:
    """Resolve metrical-octave errors from beat_track.

    beat_track + the start_bpm=120 prior can lock onto a wrong metrical level
    (e.g. reporting 123 for a song whose real beat is ~92, a 4:3 mis-lock, or
    half/double of the true tempo). We re-score octave/metrical variants of the
    base estimate with a harmonic comb autocorrelation of the onset envelope and
    prefer a candidate inside the perceptual band, which keeps the chosen tempo
    on the level human BPM detectors agree on.
    """
    if base_bpm <= 0 or onset_envelope.size < 8:
        return base_bpm

    frame_rate = sample_rate / HOP_LENGTH
    centered_envelope = np.asarray(onset_envelope, dtype=float)
    centered_envelope = centered_envelope - centered_envelope.mean()

    scored: list[tuple[float, float]] = []

    for ratio in OCTAVE_CORRECTION_RATIOS:
        candidate_bpm = base_bpm * ratio

        if candidate_bpm < OCTAVE_BPM_FLOOR or candidate_bpm > OCTAVE_BPM_CEIL:
            continue

        # Refine within +/-2 frames to counter HOP_LENGTH quantization of the lag.
        center_lag = int(round((60.0 / candidate_bpm) * frame_rate))
        best_bpm, best_score = candidate_bpm, -math.inf

        for lag in range(max(1, center_lag - 2), center_lag + 3):
            refined_bpm = 60.0 * frame_rate / lag
            score = _comb_score(centered_envelope, refined_bpm, frame_rate)

            if score > best_score:
                best_score, best_bpm = score, refined_bpm

        scored.append((best_bpm, best_score))

    if not scored:
        return base_bpm

    in_band = [item for item in scored if PREFERRED_BPM_LOW <= item[0] <= PREFERRED_BPM_HIGH]
    pool = in_band or scored
    return max(pool, key=lambda item: item[1])[0]


def _best_grid_phase_offset(onset_envelope: np.ndarray, sample_rate: int, bpm: float) -> float:
    """Offset within the first beat whose beat grid best lines up with onset energy."""
    if bpm <= 0 or onset_envelope.size < 4:
        return 0.0

    frame_rate = sample_rate / HOP_LENGTH
    period_frames = (60.0 / bpm) * frame_rate

    if period_frames < 2:
        return 0.0

    total_frames = onset_envelope.size
    grid_count = max(1, int((total_frames - 1) / period_frames))
    steps = max(8, int(round(period_frames)) * 2)
    best_phase, best_score = 0.0, -1.0

    for step in range(steps):
        phase = (step / steps) * period_frames
        indices = np.round(phase + period_frames * np.arange(grid_count)).astype(int)
        indices = indices[indices < total_frames]

        if indices.size == 0:
            continue

        score = float(onset_envelope[indices].sum()) / indices.size

        if score > best_score:
            best_score, best_phase = score, phase

    return best_phase / frame_rate


def _build_offset_candidates(
    auto_offset_sec: float,
    beat_tracker_offset_sec: float | None,
    first_onset_sec: float | None,
    onset_frames: np.ndarray,
    onset_envelope: np.ndarray,
    sample_rate: int,
    global_bpm: float,
    song_length_sec: float,
) -> list[OffsetCandidate]:
    """Offer a few musically meaningful starting points so the user can pick/verify."""

    def clamp_offset(value: float) -> float:
        return float(min(max(value, 0.0), max(song_length_sec, 0.0)))

    proposals: list[tuple[str, str, float, str]] = [
        ("auto", "자동 추정", clamp_offset(auto_offset_sec), "분석기가 고른 기본 시작점입니다."),
    ]

    if first_onset_sec is not None:
        proposals.append(
            ("first_onset", "첫 소리", clamp_offset(first_onset_sec), "곡에서 가장 먼저 감지된 소리에 맞춥니다."),
        )

    if onset_frames.size > 0 and onset_envelope.size > 0:
        beat_duration = 60.0 / max(global_bpm, 1e-6)
        early_limit_sec = max(4.0, beat_duration * 8)
        early_onsets = [
            (int(frame), float(onset_envelope[int(frame)]))
            for frame in onset_frames
            if int(frame) < onset_envelope.size
            and float(librosa.frames_to_time(int(frame), sr=sample_rate, hop_length=HOP_LENGTH)) <= early_limit_sec
        ]

        if early_onsets:
            strong_frame = max(early_onsets, key=lambda item: item[1])[0]
            strong_time = float(librosa.frames_to_time(strong_frame, sr=sample_rate, hop_length=HOP_LENGTH))
            proposals.append(
                ("strong_onset", "초반 강타", clamp_offset(strong_time), "곡 초반에서 가장 강하게 친 타격에 맞춥니다."),
            )

    proposals.append(
        (
            "grid_phase",
            "박자 그리드",
            clamp_offset(_best_grid_phase_offset(onset_envelope, sample_rate, global_bpm)),
            "곡 전체 박자 에너지가 가장 잘 맞는 위상입니다.",
        )
    )

    if beat_tracker_offset_sec is not None:
        proposals.append(
            ("beat_tracker", "박자 추적기", clamp_offset(beat_tracker_offset_sec), "자동 박자 추적기가 찍은 첫 박입니다."),
        )

    candidates: list[OffsetCandidate] = []
    seen_offsets: list[float] = []

    for source, label, offset_value, reason in proposals:
        if any(abs(offset_value - kept) <= 0.012 for kept in seen_offsets):
            continue

        seen_offsets.append(offset_value)
        candidates.append(
            OffsetCandidate(source=source, label=label, offsetSec=_round_float(offset_value), reason=reason)
        )

    return candidates


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _normalize_curve(curve: np.ndarray) -> np.ndarray:
    if curve.size == 0:
        return curve.astype(float)

    curve = np.maximum(np.asarray(curve, dtype=float), 0.0)
    reference = float(np.percentile(curve, 95))

    if reference <= 0:
        reference = float(np.max(curve))

    if reference <= 0:
        return np.zeros_like(curve, dtype=float)

    return np.clip(curve / reference, 0.0, 1.0)


def _positive_flux(energy_curve: np.ndarray) -> np.ndarray:
    energy_curve = np.asarray(energy_curve, dtype=float)

    if energy_curve.size == 0:
        return np.zeros(0, dtype=float)

    log_energy = np.log1p(np.maximum(energy_curve, 0.0))
    return np.maximum(np.diff(log_energy, prepend=log_energy[:1]), 0.0)


def _smooth_curve(curve: np.ndarray, width: int = 5) -> np.ndarray:
    if curve.size == 0 or width <= 1:
        return np.asarray(curve, dtype=float)

    kernel = np.ones(width, dtype=float) / width
    return np.convolve(curve, kernel, mode="same")


def _build_drum_feature_curves(percussive_signal: np.ndarray, sample_rate: int) -> DrumFeatureCurves:
    stft_magnitude = np.abs(
        librosa.stft(
            y=percussive_signal,
            n_fft=1024,
            hop_length=HOP_LENGTH,
        )
    )
    frequencies = librosa.fft_frequencies(sr=sample_rate, n_fft=1024)

    def band_energy(min_hz: float, max_hz: float | None) -> np.ndarray:
        band_mask = frequencies >= min_hz

        if max_hz is not None:
            band_mask &= frequencies < max_hz

        if not np.any(band_mask):
            return np.zeros(stft_magnitude.shape[1], dtype=float)

        return np.mean(stft_magnitude[band_mask], axis=0)

    low_flux = _positive_flux(band_energy(0.0, 180.0))
    mid_flux = _positive_flux(band_energy(180.0, 2200.0))
    high_flux = _positive_flux(band_energy(2200.0, None))

    low_curve = _normalize_curve(_smooth_curve(low_flux, width=5))
    mid_curve = _normalize_curve(_smooth_curve(mid_flux, width=5))
    high_curve = _normalize_curve(_smooth_curve(high_flux, width=5))
    accent_curve = _normalize_curve(_smooth_curve((low_curve * 0.5) + (mid_curve * 0.35) + (high_curve * 0.15), width=3))

    return DrumFeatureCurves(
        low=low_curve,
        mid=mid_curve,
        high=high_curve,
        accent=accent_curve,
    )


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
    profile: SourceProfile,
    beat_index: int,
    global_reference_strength: float,
    four_bar_reference_strengths: dict[int, float],
) -> float:
    if profile == "global":
        return global_reference_strength

    chunk_index = max(0, (beat_index - 1) // FOUR_BAR_BEATS)
    local_reference_strength = four_bar_reference_strengths.get(chunk_index, 0.0)
    return max(local_reference_strength, global_reference_strength * 0.5)


def _profile_threshold_scale(profile: SourceProfile) -> float:
    return 1.0 if profile == "global" else 0.92


def _build_grid_candidates(
    profile: SourceProfile,
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

    threshold_scale = _profile_threshold_scale(profile)
    payload_entries: list[tuple[float, dict[str, object]]] = []
    matched_peak_frames: list[int] = []

    for beat_index, beat_start in enumerate(beat_starts, start=1):
        if beat_start > song_length_sec:
            break

        beat_in_bar = ((beat_index - 1) % BEATS_PER_BAR) + 1
        bar_index = ((beat_index - 1) // BEATS_PER_BAR) + 1
        event_reference_strength = _event_reference_strength(
            profile=profile,
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
                            "sceneFamily": "reactive",
                            "sceneType": "prep_1_attack",
                            "sceneGroupId": "",
                            "cueTimesSec": [],
                            "reason": f"{_role_reason(spec, beat_in_bar)} {energy_reason}",
                        },
                    )
                )
                matched_peak_frames.append(peak_frame)

    return payload_entries, np.asarray(matched_peak_frames, dtype=int)


def _build_free_accent_candidates(
    profile: SourceProfile,
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
    threshold_scale = _profile_threshold_scale(profile)
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
            profile=profile,
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

        beat_in_bar = ((beat_index - 1) % BEATS_PER_BAR) + 1
        bar_index = ((beat_index - 1) // BEATS_PER_BAR) + 1
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
                    "sceneFamily": "reactive",
                    "sceneType": "prep_1_attack",
                    "sceneGroupId": "",
                    "cueTimesSec": [],
                    "reason": f"Strong onset landed outside the current beat grid. {energy_reason}",
                },
            )
        )

    return payload_entries


def _build_candidate_events(
    profile: SourceProfile,
    song_length_sec: float,
    offset_sec: float,
    global_bpm: float,
    sample_rate: int,
    onset_envelope: np.ndarray,
    onset_frames: np.ndarray,
) -> list[CandidateEvent]:
    grid_entries, matched_peak_frames = _build_grid_candidates(
        profile=profile,
        song_length_sec=song_length_sec,
        offset_sec=offset_sec,
        global_bpm=global_bpm,
        sample_rate=sample_rate,
        onset_envelope=onset_envelope,
    )
    free_entries = _build_free_accent_candidates(
        profile=profile,
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

    prefix = "gbl" if profile == "global" else "s4b"
    candidate_events: list[CandidateEvent] = []

    for index, (_, payload) in enumerate(payload_entries, start=1):
        payload = {**payload, "id": f"{prefix}-src-{index:05d}"}
        candidate_events.append(CandidateEvent(**payload))

    return candidate_events


def _event_sort_key(event: CandidateEvent) -> tuple[float, int, int, int]:
    return (
        event.timeSec,
        TIMING_ROLE_SORT_INDEX.get(event.timingRole, len(TIMING_ROLE_SORT_INDEX)),
        event.gridDivision,
        event.slotInBeat,
    )


def _copy_event(
    event: CandidateEvent,
    event_id: str,
    confidence: float,
    reason: str,
    scene_family: CandidateSceneFamily | None = None,
    scene_type: CandidateSceneType | None = None,
    scene_group_id: str | None = None,
    cue_times_sec: list[float] | None = None,
) -> CandidateEvent:
    next_confidence = _round_float(_clamp01(confidence), 3)
    kind, _ = _role_kind(next_confidence, event.strength)

    return CandidateEvent(
        id=event_id,
        timeSec=event.timeSec,
        beatIndex=event.beatIndex,
        barIndex=event.barIndex,
        beatInBar=event.beatInBar,
        slotInBeat=event.slotInBeat,
        gridDivision=event.gridDivision,
        timingRole=event.timingRole,
        confidence=next_confidence,
        strength=event.strength,
        kind=kind,
        sceneFamily=scene_family or event.sceneFamily,
        sceneType=scene_type or event.sceneType,
        sceneGroupId=scene_group_id if scene_group_id is not None else event.sceneGroupId,
        cueTimesSec=[_round_float(cue_time) for cue_time in cue_times_sec] if cue_times_sec is not None else event.cueTimesSec,
        reason=reason,
    )


def _previous_onset_gap(event_time: float, onset_times: np.ndarray) -> float:
    if onset_times.size == 0:
        return event_time

    previous_index = int(np.searchsorted(onset_times, event_time, side="left")) - 1

    if previous_index < 0:
        return event_time

    return max(0.0, event_time - float(onset_times[previous_index]))


def _reactive_role_bonus(event: CandidateEvent) -> float:
    return {
        "pulse": 0.08,
        "offbeat": 0.05,
        "subdivision": 0.01,
        "triplet": 0.03,
        "freeAccent": 0.07,
        "thirtySecond": -0.08,
    }.get(event.timingRole, 0.0)


def _reactive_phrase_score(event: CandidateEvent) -> float:
    if event.timingRole == "pulse" and event.beatInBar == 1 and event.slotInBeat == 0:
        return 1.0

    if event.beatInBar == 1:
        return 0.74

    if event.timingRole == "pulse":
        return 0.56

    return 0.28


def _reactive_landing_score(event: CandidateEvent) -> float:
    if event.timingRole == "pulse":
        return 1.0

    if event.timingRole in {"offbeat", "triplet"}:
        return 0.72

    if event.timingRole == "freeAccent":
        return 0.5

    if event.timingRole == "subdivision":
        return 0.38

    return 0.2


def _collect_signal_times(
    event_time: float,
    onset_times: np.ndarray,
    beat_duration: float,
    max_hits: int = 3,
) -> tuple[float, ...]:
    if onset_times.size == 0:
        return ()

    window_start = max(0.0, event_time - max(beat_duration * 1.9, 0.42))
    window_end = max(0.0, event_time - min(max(beat_duration * 0.16, 0.08), 0.2))

    if window_end <= window_start:
        return ()

    signal_times = [
        float(onset_time)
        for onset_time in onset_times
        if window_start <= float(onset_time) <= window_end
    ]

    if not signal_times:
        return ()

    deduped_times: list[float] = []
    min_signal_spacing = min(max(beat_duration * 0.16, 0.08), 0.22)

    for signal_time in signal_times:
        if deduped_times and (signal_time - deduped_times[-1]) < min_signal_spacing:
            deduped_times[-1] = signal_time
            continue

        deduped_times.append(signal_time)

    return tuple(_round_float(signal_time) for signal_time in deduped_times[-max_hits:])


def _count_signal_hits(event_time: float, onset_times: np.ndarray, beat_duration: float) -> int:
    return len(_collect_signal_times(event_time, onset_times, beat_duration=beat_duration, max_hits=3))


def _local_accent_score(event: CandidateEvent, source_events: list[CandidateEvent], beat_duration: float) -> float:
    neighbor_window = max(beat_duration * 0.62, 0.24)
    neighbor_strengths = [
        other.strength
        for other in source_events
        if abs(other.timeSec - event.timeSec) <= neighbor_window
    ]

    if not neighbor_strengths:
        return event.strength

    strongest_neighbor = max(neighbor_strengths)
    return _clamp01(event.strength / max(strongest_neighbor, 1e-6))


def _curve_peak_score(curve: np.ndarray, time_sec: float, sample_rate: int) -> float:
    if curve.size == 0:
        return 0.0

    frame_index = int(round(time_sec / (HOP_LENGTH / sample_rate)))
    frame_index = max(0, min(curve.size - 1, frame_index))
    local_slice = curve[max(0, frame_index - 2) : min(curve.size, frame_index + 3)]
    neighborhood = curve[max(0, frame_index - 10) : min(curve.size, frame_index + 11)]
    local_peak = float(np.max(local_slice)) if local_slice.size > 0 else float(curve[frame_index])
    neighborhood_median = float(np.median(neighborhood)) if neighborhood.size > 0 else 0.0
    prominence = max(0.0, local_peak - neighborhood_median)
    return _clamp01((local_peak * 0.65) + (prominence * 0.7))


def _drum_feature_scores(
    event_time: float,
    drum_curves: DrumFeatureCurves,
    sample_rate: int,
) -> tuple[float, float, float]:
    drum_accent_score = _curve_peak_score(drum_curves.accent, event_time, sample_rate)
    drum_low_score = _curve_peak_score(drum_curves.low, event_time, sample_rate)
    drum_mid_score = _curve_peak_score(drum_curves.mid, event_time, sample_rate)
    drum_high_score = _curve_peak_score(drum_curves.high, event_time, sample_rate)
    drum_snap_score = _clamp01((drum_mid_score * 0.62) + (drum_high_score * 0.38))
    return drum_accent_score, drum_low_score, drum_snap_score


def _sixteenth_slot_in_beat(event: CandidateEvent) -> int | None:
    if event.timingRole not in {"pulse", "offbeat", "subdivision"} or event.gridDivision <= 0:
        return None

    slot = int(round((event.slotInBeat / event.gridDivision) * SIXTEENTH_STEPS_PER_BEAT))

    if 0 <= slot < SIXTEENTH_STEPS_PER_BEAT:
        return slot

    return None


def _absolute_sixteenth_slot(event: CandidateEvent) -> int | None:
    slot_in_beat = _sixteenth_slot_in_beat(event)

    if slot_in_beat is None:
        return None

    return ((event.barIndex - 1) * SIXTEENTH_STEPS_PER_BAR) + ((event.beatInBar - 1) * SIXTEENTH_STEPS_PER_BEAT) + slot_in_beat


def _reactive_compatible(event: CandidateEvent) -> bool:
    return _absolute_sixteenth_slot(event) is not None


def _prep_scene_type(prep_count: int) -> CandidateSceneType:
    return {
        1: "prep_1_attack",
        2: "prep_2_attack",
        3: "prep_3_attack",
    }.get(prep_count, "prep_1_attack")


def _reactive_step_duration(step_size: int, beat_duration: float) -> float:
    return beat_duration * (step_size / SIXTEENTH_STEPS_PER_BEAT)


def _reactive_slot_quality(
    event: CandidateEvent,
    source_events: list[CandidateEvent],
    beat_duration: float,
    drum_curves: DrumFeatureCurves,
    sample_rate: int,
) -> float:
    local_accent_score = _local_accent_score(event, source_events, beat_duration)
    drum_accent_score, drum_low_score, drum_snap_score = _drum_feature_scores(
        event.timeSec,
        drum_curves=drum_curves,
        sample_rate=sample_rate,
    )
    return _clamp01(
        (event.confidence * 0.24)
        + (event.strength * 0.22)
        + (local_accent_score * 0.18)
        + (drum_accent_score * 0.2)
        + (drum_low_score * 0.1)
        + (drum_snap_score * 0.06)
    )


def _build_best_slot_events(
    source_events: list[CandidateEvent],
    beat_duration: float,
    drum_curves: DrumFeatureCurves,
    sample_rate: int,
    compatibility_fn,
) -> dict[int, CandidateEvent]:
    slot_events: dict[int, tuple[float, CandidateEvent]] = {}

    for event in source_events:
        if not compatibility_fn(event):
            continue

        slot = _absolute_sixteenth_slot(event)

        if slot is None:
            continue

        quality = _reactive_slot_quality(
            event=event,
            source_events=source_events,
            beat_duration=beat_duration,
            drum_curves=drum_curves,
            sample_rate=sample_rate,
        )
        current = slot_events.get(slot)

        if current is None or quality > current[0]:
            slot_events[slot] = (quality, event)

    return {slot: event for slot, (_, event) in slot_events.items()}


def _cue_strength_shape(cue_events: tuple[CandidateEvent, ...], final_event: CandidateEvent) -> float:
    if not cue_events:
        return 0.0

    cue_strengths = [event.strength for event in cue_events]
    average_cue_strength = sum(cue_strengths) / len(cue_strengths)
    final_dominance = _clamp01((final_event.strength - average_cue_strength + 0.35) / 0.7)
    return final_dominance


def _cue_spacing_score(cue_events: tuple[CandidateEvent, ...], final_event: CandidateEvent, expected_interval: float) -> float:
    if not cue_events or expected_interval <= 0:
        return 0.0

    event_times = [event.timeSec for event in cue_events] + [final_event.timeSec]
    intervals = [right - left for left, right in zip(event_times, event_times[1:])]

    if not intervals:
        return 0.0

    error_scores = [
        _clamp01(1.0 - (abs(interval - expected_interval) / max(expected_interval * 0.55, 0.05)))
        for interval in intervals
    ]
    spread_score = _clamp01(1.0 - ((max(intervals) - min(intervals)) / max(expected_interval * 0.45, 0.04)))
    return _clamp01((sum(error_scores) / len(error_scores) * 0.72) + (spread_score * 0.28))


def _reactive_pattern_reason(prep_count: int, cue_events: tuple[CandidateEvent, ...], final_event: CandidateEvent, step_size: int) -> str:
    prep_description = {
        1: "One prep beat leads into the attack.",
        2: "Two prep beats build into the attack.",
        3: "Three prep beats build a long wind-up before the attack.",
    }[prep_count]
    division_label = {
        4: "quarter-note",
        2: "eighth-note",
        1: "sixteenth-note",
    }.get(step_size, "subdivided")
    return (
        f"Reactive grammar candidate ({prep_count} prep + attack). "
        f"{prep_description} The cues and final hit lock to a readable {division_label} grid. "
        f"Final attack lands at {final_event.timeSec:.3f}s after {len(cue_events)} prep cues."
    )


def _build_reactive_grammar_candidates(
    source_events: list[CandidateEvent],
    global_bpm: float,
    drum_curves: DrumFeatureCurves,
    sample_rate: int,
) -> list[ReactiveGrammarCandidate]:
    if not source_events:
        return []

    beat_duration = 60.0 / max(global_bpm, 1e-6)
    slot_events = _build_best_slot_events(
        source_events=source_events,
        beat_duration=beat_duration,
        drum_curves=drum_curves,
        sample_rate=sample_rate,
        compatibility_fn=_reactive_compatible,
    )

    if not slot_events:
        return []

    candidates: list[ReactiveGrammarCandidate] = []

    for final_slot, final_event in sorted(slot_events.items()):
        local_accent_score = _local_accent_score(final_event, source_events, beat_duration)
        drum_accent_score, drum_low_score, _ = _drum_feature_scores(
            final_event.timeSec,
            drum_curves=drum_curves,
            sample_rate=sample_rate,
        )
        phrase_score = _reactive_phrase_score(final_event)
        landing_score = _reactive_landing_score(final_event)
        final_anchor_score = _clamp01(
            (final_event.confidence * 0.2)
            + (final_event.strength * 0.22)
            + (local_accent_score * 0.18)
            + (drum_accent_score * 0.2)
            + (drum_low_score * 0.12)
            + (phrase_score * 0.05)
            + (landing_score * 0.03)
        )

        if final_anchor_score < 0.52:
            continue

        best_candidate: ReactiveGrammarCandidate | None = None

        for prep_count in (3, 2, 1):
            for step_size in (4, 2, 1):
                cue_slots = [final_slot - (step_size * distance) for distance in range(prep_count, 0, -1)]

                if any(slot < 0 for slot in cue_slots):
                    continue

                cue_events = tuple(slot_events.get(slot) for slot in cue_slots)

                if any(event is None for event in cue_events):
                    continue

                cue_events = tuple(event for event in cue_events if event is not None)

                if len(cue_events) != prep_count:
                    continue

                cue_quality = sum(
                    _reactive_slot_quality(
                        event=cue_event,
                        source_events=source_events,
                        beat_duration=beat_duration,
                        drum_curves=drum_curves,
                        sample_rate=sample_rate,
                    )
                    for cue_event in cue_events
                ) / prep_count
                spacing_score = _cue_spacing_score(
                    cue_events=cue_events,
                    final_event=final_event,
                    expected_interval=_reactive_step_duration(step_size, beat_duration),
                )
                dominance_score = _cue_strength_shape(cue_events, final_event)
                readability_score = {4: 1.0, 2: 0.88, 1: 0.74}[step_size]
                cue_density_score = _clamp01(0.55 + (prep_count * 0.12))
                score = _clamp01(
                    (final_anchor_score * 0.34)
                    + (cue_quality * 0.18)
                    + (spacing_score * 0.18)
                    + (dominance_score * 0.14)
                    + (readability_score * 0.08)
                    + (cue_density_score * 0.08)
                )

                if cue_quality < {1: 0.28, 2: 0.34, 3: 0.42}[prep_count]:
                    continue

                if spacing_score < {1: 0.5, 2: 0.56, 3: 0.62}[prep_count]:
                    continue

                if dominance_score < {1: 0.28, 2: 0.38, 3: 0.48}[prep_count] or score < 0.58:
                    continue

                if best_candidate is None or score > best_candidate.score:
                    best_candidate = ReactiveGrammarCandidate(
                        event=final_event,
                        cue_events=cue_events,
                        prep_count=prep_count,
                        step_size=step_size,
                        score=score,
                    )

        if best_candidate is not None:
            candidates.append(best_candidate)

    candidates.sort(key=lambda candidate: (-candidate.score, candidate.prep_count, candidate.event.timeSec))
    selected: list[ReactiveGrammarCandidate] = []
    selected_times: list[float] = []
    reserved_slots: set[int] = set()
    bar_counts: dict[int, int] = {}
    min_spacing_sec = min(max(beat_duration * 0.3, 0.14), 0.28)

    for candidate in candidates:
        candidate_slots = {
            *[
                _absolute_sixteenth_slot(cue_event)
                for cue_event in candidate.cue_events
                if _absolute_sixteenth_slot(cue_event) is not None
            ],
            _absolute_sixteenth_slot(candidate.event),
        }
        candidate_slots.discard(None)

        if candidate_slots & reserved_slots:
            continue

        if any(abs(candidate.event.timeSec - selected_time) < min_spacing_sec for selected_time in selected_times):
            continue

        if bar_counts.get(candidate.event.barIndex, 0) >= 2:
            continue

        selected.append(candidate)
        selected_times.append(candidate.event.timeSec)
        reserved_slots.update(candidate_slots)
        bar_counts[candidate.event.barIndex] = bar_counts.get(candidate.event.barIndex, 0) + 1

    selected.sort(key=lambda candidate: _event_sort_key(candidate.event))
    return selected


def _telegraph_score(signal_hits: int, pre_gap_score: float) -> float:
    if signal_hits >= 3:
        return 1.0

    if signal_hits == 2:
        return 0.8

    if signal_hits == 1:
        return 0.58

    return _clamp01(pre_gap_score * 0.92)


def _heavy_attack_reason(event: CandidateEvent, signal_hits: int, pre_gap_score: float, phrase_score: float) -> str:
    details: list[str] = ["Telegraphed heavy-attack candidate."]

    if signal_hits >= 3:
        details.append("Three prep beats lead into the final impact.")
    elif signal_hits == 2:
        details.append("Two prep beats build a readable wind-up before the strike.")
    elif signal_hits == 1:
        details.append("A single prep beat sets up the final hit.")
    elif pre_gap_score >= 0.6:
        details.append("A short breath before the hit still reads like a wind-up.")

    if phrase_score >= 0.74:
        details.append("The landing also feels like a phrase or bar impact.")

    if event.timingRole == "freeAccent":
        details.append("The impact breaks away from the beat grid, which makes the strike pop.")
    elif event.timingRole == "pulse":
        details.append("The strike lands cleanly on the core pulse.")
    elif event.timingRole in {"offbeat", "triplet"}:
        details.append("The slightly offset placement still reads as a committed final hit.")

    return " ".join(details)


def _quick_attack_interval_score(intervals: list[float], beat_duration: float) -> float:
    if not intervals:
        return 0.0

    average_interval = sum(intervals) / len(intervals)
    target_interval = min(max(beat_duration * 0.34, 0.15), 0.32)
    density_score = _clamp01(1.0 - (abs(average_interval - target_interval) / max(beat_duration * 0.32, 0.1)))
    consistency_score = _clamp01(1.0 - ((max(intervals) - min(intervals)) / max(beat_duration * 0.22, 0.08)))
    return _clamp01((density_score * 0.56) + (consistency_score * 0.44))


def _quick_attack_reason(cluster: QuickAttackCluster, event: CandidateEvent) -> str:
    burst_hits = len(cluster.events)
    hit_index = next((index for index, item in enumerate(cluster.events, start=1) if item.id == event.id), 1)
    details = [f"Quick-attack candidate. A short tell leads into a {burst_hits}-hit burst."]

    if cluster.lead_in_score >= 0.62:
        details.append("The burst starts after a clean lead-in.")

    details.append(f"This note is hit {hit_index} of {burst_hits} in the combo.")
    return " ".join(details)


def _build_reactive_score_pool(
    source_events: list[CandidateEvent],
    onset_times: np.ndarray,
    beat_duration: float,
    drum_curves: DrumFeatureCurves,
    sample_rate: int,
) -> list[ReactiveEventScore]:
    scored_events: list[ReactiveEventScore] = []

    for event in source_events:
        if event.timingRole == "thirtySecond" and event.confidence < 0.72:
            continue

        pre_gap_score = _clamp01((_previous_onset_gap(event.timeSec, onset_times) - 0.09) / 0.28)
        phrase_score = _reactive_phrase_score(event)
        landing_score = _reactive_landing_score(event)
        local_accent_score = _local_accent_score(event, source_events, beat_duration)
        drum_accent_score, drum_low_score, drum_snap_score = _drum_feature_scores(
            event.timeSec,
            drum_curves=drum_curves,
            sample_rate=sample_rate,
        )
        score = _clamp01(
            (event.confidence * 0.24)
            + (event.strength * 0.2)
            + (local_accent_score * 0.16)
            + (drum_accent_score * 0.18)
            + (drum_low_score * 0.08)
            + (pre_gap_score * 0.08)
            + (phrase_score * 0.04)
            + (landing_score * 0.02)
            + _reactive_role_bonus(event)
        )

        if score < 0.56:
            continue

        scored_events.append(
            ReactiveEventScore(
                event=event,
                score=score,
                pre_gap_score=pre_gap_score,
                phrase_score=phrase_score,
                landing_score=landing_score,
                local_accent_score=local_accent_score,
                drum_accent_score=drum_accent_score,
                drum_low_score=drum_low_score,
                drum_snap_score=drum_snap_score,
            )
        )

    return scored_events


def _select_reactive_score_pool(
    scored_events: list[ReactiveEventScore],
    beat_duration: float,
) -> list[ReactiveEventScore]:
    dense_min_spacing = min(max(beat_duration * 0.22, 0.11), 0.22)
    selected: list[ReactiveEventScore] = []
    selected_times: list[float] = []
    bar_counts: dict[int, int] = {}

    for item in sorted(scored_events, key=lambda current: (-current.score, current.event.timeSec)):
        if any(abs(item.event.timeSec - selected_time) < dense_min_spacing for selected_time in selected_times):
            continue

        if bar_counts.get(item.event.barIndex, 0) >= 4:
            continue

        if item.event.timingRole == "freeAccent" and item.score < 0.66:
            continue

        selected.append(item)
        selected_times.append(item.event.timeSec)
        bar_counts[item.event.barIndex] = bar_counts.get(item.event.barIndex, 0) + 1

    selected.sort(key=lambda current: _event_sort_key(current.event))
    return selected


def _detect_quick_attack_clusters(
    selected_scores: list[ReactiveEventScore],
    onset_times: np.ndarray,
    beat_duration: float,
) -> list[QuickAttackCluster]:
    if len(selected_scores) < 2:
        return []

    min_interval = min(max(beat_duration * 0.16, 0.1), 0.22)
    max_interval = min(max(beat_duration * 0.62, 0.28), 0.48)
    candidates: list[QuickAttackCluster] = []

    for start_index in range(len(selected_scores)):
        for burst_hits in (3, 2):
            window = selected_scores[start_index : start_index + burst_hits]

            if len(window) != burst_hits:
                continue

            events = tuple(item.event for item in window)
            total_span = events[-1].timeSec - events[0].timeSec
            max_total_span = beat_duration * (1.25 if burst_hits == 3 else 0.75)

            if total_span <= 0 or total_span > max_total_span:
                continue

            intervals = [
                right.event.timeSec - left.event.timeSec
                for left, right in zip(window, window[1:])
            ]

            if any(interval < min_interval or interval > max_interval for interval in intervals):
                continue

            if events[-1].barIndex - events[0].barIndex > 1:
                continue

            cue_times = _collect_signal_times(events[0].timeSec, onset_times, beat_duration=beat_duration, max_hits=1)
            lead_in_gap = _previous_onset_gap(events[0].timeSec, onset_times)
            lead_in_score = _clamp01((lead_in_gap - min(max(beat_duration * 0.18, 0.1), 0.18)) / max(beat_duration * 0.34, 0.12))
            interval_score = _quick_attack_interval_score(intervals, beat_duration)
            average_score = sum(item.score for item in window) / burst_hits
            average_strength = sum(item.event.strength for item in window) / burst_hits
            phrase_score = max(item.phrase_score for item in window)
            local_accent_score = max(item.local_accent_score for item in window)
            drum_snap_score = sum(item.drum_snap_score for item in window) / burst_hits
            drum_accent_score = max(item.drum_accent_score for item in window)
            cluster_score = _clamp01(
                (average_score * 0.24)
                + (average_strength * 0.16)
                + (interval_score * 0.24)
                + (lead_in_score * 0.08)
                + (local_accent_score * 0.08)
                + (drum_snap_score * 0.14)
                + (drum_accent_score * 0.06)
            )

            if not cue_times:
                continue

            if interval_score < 0.58 or local_accent_score < 0.72 or drum_snap_score < 0.52:
                continue

            if cluster_score < (0.75 if burst_hits == 3 else 0.71):
                continue

            candidates.append(
                QuickAttackCluster(
                    events=events,
                    score=cluster_score,
                    lead_in_score=lead_in_score,
                    cue_times=cue_times,
                )
            )

    candidates.sort(
        key=lambda cluster: (-cluster.score, -len(cluster.events), cluster.events[0].timeSec)
    )
    selected_clusters: list[QuickAttackCluster] = []
    reserved_event_ids: set[str] = set()
    reserved_bars: set[int] = set()
    reserved_blocks: set[int] = set()

    for cluster in candidates:
        cluster_event_ids = {event.id for event in cluster.events}
        block_index = (cluster.events[0].barIndex - 1) // 2

        if cluster_event_ids & reserved_event_ids:
            continue

        if cluster.events[0].barIndex in reserved_bars:
            continue

        if block_index in reserved_blocks:
            continue

        selected_clusters.append(cluster)
        reserved_event_ids.update(cluster_event_ids)
        reserved_bars.add(cluster.events[0].barIndex)
        reserved_blocks.add(block_index)

    selected_clusters.sort(key=lambda cluster: cluster.events[0].timeSec)
    return selected_clusters


def _select_heavy_attack_scores(
    selected_scores: list[ReactiveEventScore],
    quick_attack_event_ids: set[str],
    onset_times: np.ndarray,
    beat_duration: float,
) -> list[tuple[ReactiveEventScore, tuple[float, ...], float]]:
    min_spacing_sec = min(max(beat_duration * 0.48, 0.2), 0.42)
    selected: list[tuple[ReactiveEventScore, tuple[float, ...], float]] = []
    selected_times: list[float] = []
    bar_counts: dict[int, int] = {}

    heavy_candidates: list[tuple[float, tuple[float, ...], float, ReactiveEventScore]] = []

    for item in selected_scores:
        if item.event.id in quick_attack_event_ids:
            continue

        cue_times = _collect_signal_times(item.event.timeSec, onset_times, beat_duration=beat_duration, max_hits=3)
        signal_hits = len(cue_times)
        telegraph_score = _telegraph_score(signal_hits, item.pre_gap_score)
        heavy_score = _clamp01(
            (item.score * 0.34)
            + (telegraph_score * 0.24)
            + (item.phrase_score * 0.14)
            + (item.landing_score * 0.08)
            + (item.local_accent_score * 0.06)
            + (item.drum_low_score * 0.1)
            + (item.drum_accent_score * 0.04)
        )

        if heavy_score < 0.6:
            continue

        if not cue_times or item.drum_accent_score < 0.44:
            continue

        heavy_candidates.append((heavy_score, cue_times, telegraph_score, item))

    heavy_candidates.sort(key=lambda current: (-current[0], current[3].event.timeSec))

    for heavy_score, cue_times, telegraph_score, item in heavy_candidates:
        if any(abs(item.event.timeSec - selected_time) < min_spacing_sec for selected_time in selected_times):
            continue

        if bar_counts.get(item.event.barIndex, 0) >= 1:
            continue

        selected.append((item, cue_times, telegraph_score))
        selected_times.append(item.event.timeSec)
        bar_counts[item.event.barIndex] = bar_counts.get(item.event.barIndex, 0) + 1

    selected.sort(key=lambda current: _event_sort_key(current[0].event))
    return selected


def _build_reactive_events(
    source_events: list[CandidateEvent],
    onset_times: np.ndarray,
    global_bpm: float,
    drum_curves: DrumFeatureCurves,
    sample_rate: int,
) -> list[CandidateEvent]:
    del onset_times

    grammar_candidates = _build_reactive_grammar_candidates(
        source_events=source_events,
        global_bpm=global_bpm,
        drum_curves=drum_curves,
        sample_rate=sample_rate,
    )
    reactive_events: list[CandidateEvent] = []

    for index, candidate in enumerate(grammar_candidates, start=1):
        reactive_events.append(
            _copy_event(
                event=candidate.event,
                event_id=f"rct-evt-{index:05d}",
                confidence=candidate.score,
                reason=_reactive_pattern_reason(
                    prep_count=candidate.prep_count,
                    cue_events=candidate.cue_events,
                    final_event=candidate.event,
                    step_size=candidate.step_size,
                ),
                scene_family="reactive",
                scene_type=_prep_scene_type(candidate.prep_count),
                scene_group_id=f"rct-prep-{candidate.prep_count}-{index:03d}",
                cue_times_sec=[cue_event.timeSec for cue_event in candidate.cue_events],
            )
        )

    return reactive_events


def _pattern_compatible(event: CandidateEvent) -> bool:
    return _absolute_sixteenth_slot(event) is not None


def _pattern_role_bonus(event: CandidateEvent) -> float:
    return {
        "pulse": 0.06,
        "offbeat": 0.08,
        "subdivision": 0.09,
        "triplet": 0.08,
        "freeAccent": -0.08,
        "thirtySecond": -0.12,
    }.get(event.timingRole, 0.0)


def _build_pattern_seed_events(
    source_events: list[CandidateEvent],
    onset_times: np.ndarray,
    global_bpm: float,
    drum_curves: DrumFeatureCurves,
    sample_rate: int,
) -> list[CandidateEvent]:
    del onset_times

    if not source_events:
        return []

    beat_duration = 60.0 / max(global_bpm, 1e-6)
    slot_events = _build_best_slot_events(
        source_events=source_events,
        beat_duration=beat_duration,
        drum_curves=drum_curves,
        sample_rate=sample_rate,
        compatibility_fn=_pattern_compatible,
    )
    selected: list[CandidateEvent] = []

    for index, event in enumerate(sorted(slot_events.values(), key=_event_sort_key), start=1):
        local_accent_score = _local_accent_score(event, source_events, beat_duration)
        drum_accent_score, _, drum_snap_score = _drum_feature_scores(
            event.timeSec,
            drum_curves=drum_curves,
            sample_rate=sample_rate,
        )
        pattern_seed_score = _clamp01(
            (event.confidence * 0.28)
            + (event.strength * 0.24)
            + (local_accent_score * 0.18)
            + (drum_accent_score * 0.18)
            + (drum_snap_score * 0.12)
            + _pattern_role_bonus(event)
        )

        if pattern_seed_score < 0.42:
            continue

        selected.append(
            _copy_event(
                event=event,
                event_id=f"ptn-seed-{index:05d}",
                confidence=pattern_seed_score,
                reason=event.reason,
            )
        )

    return selected


def _window_events(source_events: list[CandidateEvent], start_bar: int, bars: int) -> tuple[CandidateEvent, ...]:
    end_bar = start_bar + bars
    return tuple(event for event in source_events if start_bar <= event.barIndex < end_bar and _pattern_compatible(event))


def _slot_position(event: CandidateEvent, start_bar: int) -> int | None:
    absolute_slot = _absolute_sixteenth_slot(event)

    if absolute_slot is None:
        return None

    return absolute_slot - ((start_bar - 1) * SIXTEENTH_STEPS_PER_BAR)


def _slot_signature(events: tuple[CandidateEvent, ...], start_bar: int) -> dict[int, float]:
    signature: dict[int, float] = {}

    for event in events:
        slot = _slot_position(event, start_bar)

        if slot is None:
            continue

        signature[slot] = max(signature.get(slot, 0.0), (event.confidence * 0.54) + (event.strength * 0.46))

    return signature


def _weighted_slot_match(left_signature: dict[int, float], right_signature: dict[int, float], tolerance: int = 2) -> float:
    del tolerance

    if not left_signature or not right_signature:
        return 0.0

    if tuple(sorted(left_signature)) != tuple(sorted(right_signature)):
        return 0.0

    slot_scores = [
        1.0 - abs(left_signature[slot] - right_signature[slot])
        for slot in left_signature
    ]
    return _clamp01(sum(slot_scores) / len(slot_scores))


def _density_score(event_count: int, bars: int) -> float:
    average_count = event_count / max(bars, 1)
    target = 4.0 if bars == 1 else 3.5
    tolerance = 2.4 if bars == 1 else 2.8
    return _clamp01(1.0 - (abs(average_count - target) / tolerance))


def _interval_variety_score(signature: dict[int, float]) -> float:
    slots = sorted(signature)

    if len(slots) <= 1:
        return 0.0

    intervals = [right - left for left, right in zip(slots, slots[1:])]
    unique_intervals = len(set(intervals))
    return _clamp01((unique_intervals - 1) / 3)


def _signature_complexity_score(signature: dict[int, float]) -> float:
    if not signature:
        return 0.0

    slots = sorted(signature)
    offbeat_slots = sum(1 for slot in slots if slot % SIXTEENTH_STEPS_PER_BEAT == 2)
    subdivision_slots = sum(1 for slot in slots if slot % SIXTEENTH_STEPS_PER_BEAT in {1, 3})
    non_pulse_ratio = (offbeat_slots + subdivision_slots) / len(slots)
    slot_variety = len({slot % SIXTEENTH_STEPS_PER_BEAT for slot in slots})
    return _clamp01((non_pulse_ratio * 0.72) + (max(0, slot_variety - 1) / 3 * 0.28))


def _window_event_strength(events: tuple[CandidateEvent, ...]) -> float:
    if not events:
        return 0.0

    return sum((event.confidence * 0.55) + (event.strength * 0.45) for event in events) / len(events)


def _pattern_non_pulse_ratio(events: tuple[CandidateEvent, ...]) -> float:
    if not events:
        return 0.0

    non_pulse_events = sum(1 for event in events if event.timingRole != "pulse")
    return non_pulse_events / len(events)


def _pattern_character_score(
    events: tuple[CandidateEvent, ...],
    start_bar: int,
    drum_curves: DrumFeatureCurves,
    sample_rate: int,
) -> float:
    if not events:
        return 0.0

    interval_variety = _interval_variety_score(_slot_signature(events, start_bar))
    non_pulse_ratio = _pattern_non_pulse_ratio(events)
    drum_snap_mean = sum(_drum_feature_scores(event.timeSec, drum_curves, sample_rate)[2] for event in events) / len(events)
    return _clamp01((interval_variety * 0.52) + (non_pulse_ratio * 0.28) + (drum_snap_mean * 0.2))


def _shift_event_by_bars(
    event: CandidateEvent,
    bars: int,
    beat_duration: float,
    song_length_sec: float,
) -> CandidateEvent | None:
    shifted_time = event.timeSec + (bars * BEATS_PER_BAR * beat_duration)

    if shifted_time > song_length_sec:
        return None

    shifted_confidence = _clamp01((event.confidence * 0.82) + 0.08)
    kind, _ = _role_kind(shifted_confidence, event.strength)

    return CandidateEvent(
        id=f"proj-{event.id}",
        timeSec=_round_float(shifted_time),
        beatIndex=event.beatIndex + (bars * BEATS_PER_BAR),
        barIndex=event.barIndex + bars,
        beatInBar=event.beatInBar,
        slotInBeat=event.slotInBeat,
        gridDivision=event.gridDivision,
        timingRole=event.timingRole,
        confidence=_round_float(shifted_confidence, 3),
        strength=event.strength,
        kind=kind,
        sceneFamily=event.sceneFamily,
        sceneType=event.sceneType,
        sceneGroupId=event.sceneGroupId,
        cueTimesSec=list(event.cueTimesSec),
        reason="Projected response note based on the cue motif.",
    )


def _project_pattern_response_events(
    cue_events: tuple[CandidateEvent, ...],
    bars: int,
    global_bpm: float,
    song_length_sec: float,
) -> tuple[CandidateEvent, ...]:
    beat_duration = 60.0 / max(global_bpm, 1e-6)
    projected_events = [
        shifted
        for event in cue_events
        if (shifted := _shift_event_by_bars(event, bars=bars, beat_duration=beat_duration, song_length_sec=song_length_sec))
        is not None
    ]
    return tuple(projected_events)


def _pattern_target_window_count(max_bar: int, density: PatternDensity) -> int:
    if max_bar <= 4:
        return 1

    if density == "pattern":
        return max(2 if max_bar >= 6 else 1, round(max_bar / 2.5))

    return max(1 if max_bar >= 6 else 0, round(max_bar / 4))


def _pattern_support_score(
    support_events: list[CandidateEvent],
    response_start_bar: int,
    bars: int,
) -> float:
    response_support_events = _window_events(support_events, response_start_bar, bars)
    return (_density_score(len(response_support_events), bars) * 0.4) + (
        _window_event_strength(response_support_events) * 0.6
    )


def _collect_projected_pattern_window_candidates(
    seed_events: list[CandidateEvent],
    support_events: list[CandidateEvent],
    global_bpm: float,
    song_length_sec: float,
    drum_curves: DrumFeatureCurves,
    sample_rate: int,
) -> list[PatternWindow]:
    max_bar = max((event.barIndex for event in seed_events if _pattern_compatible(event)), default=0)
    projected_candidates: list[PatternWindow] = []

    for bars in (1, 2):
        min_events = 3 if bars == 1 else 4
        max_events = 6 if bars == 1 else 10

        for cue_start_bar in range(1, max_bar - bars + 1):
            response_start_bar = cue_start_bar + bars
            cue_events = _window_events(seed_events, cue_start_bar, bars)

            if not (min_events <= len(cue_events) <= max_events):
                continue

            cue_signature = _slot_signature(cue_events, cue_start_bar)
            density = _density_score(len(cue_events), bars)
            clarity = _window_event_strength(cue_events)
            variety = _interval_variety_score(cue_signature)
            character = _pattern_character_score(cue_events, cue_start_bar, drum_curves, sample_rate)
            response_support = _pattern_support_score(
                support_events=support_events,
                response_start_bar=response_start_bar,
                bars=bars,
            )
            actual_response_events = _window_events(seed_events, response_start_bar, bars)
            actual_similarity = _weighted_slot_match(
                cue_signature,
                _slot_signature(actual_response_events, response_start_bar),
            )
            score = _clamp01(
                (clarity * 0.24)
                + (density * 0.18)
                + (variety * 0.2)
                + (character * 0.22)
                + (response_support * 0.1)
                + (actual_similarity * 0.06)
            )

            if character < (0.2 if bars == 1 else 0.16):
                continue

            if score < (0.6 if bars == 1 else 0.68):
                continue

            projected_events = _project_pattern_response_events(
                cue_events=cue_events,
                bars=bars,
                global_bpm=global_bpm,
                song_length_sec=song_length_sec,
            )

            if len(projected_events) < min_events:
                continue

            projected_candidates.append(
                PatternWindow(
                    bars=bars,
                    cue_start_bar=cue_start_bar,
                    response_start_bar=response_start_bar,
                    score=score,
                    cue_events=cue_events,
                    response_events=projected_events,
                    similarity=actual_similarity,
                )
            )

    return projected_candidates


def _select_pattern_windows(
    seed_events: list[CandidateEvent],
    support_events: list[CandidateEvent],
    global_bpm: float,
    song_length_sec: float,
    density: PatternDensity,
    drum_curves: DrumFeatureCurves,
    sample_rate: int,
) -> list[PatternWindow]:
    if not seed_events:
        return []

    max_bar = max((event.barIndex for event in seed_events if _pattern_compatible(event)), default=0)

    if max_bar < 2:
        return []

    window_candidates: list[PatternWindow] = []
    target_window_count = _pattern_target_window_count(max_bar, density)

    for bars in (1, 2):
        min_events = 2 if bars == 1 else 4
        max_events = 10 if bars == 1 else 16

        for cue_start_bar in range(1, max_bar - bars + 2):
            response_start_bar = cue_start_bar + bars
            cue_events = _window_events(seed_events, cue_start_bar, bars)

            if not (min_events <= len(cue_events) <= max_events):
                continue

            projected_response_events = _project_pattern_response_events(
                cue_events=cue_events,
                bars=bars,
                global_bpm=global_bpm,
                song_length_sec=song_length_sec,
            )

            if len(projected_response_events) != len(cue_events):
                continue

            cue_signature = _slot_signature(cue_events, cue_start_bar)
            if len(cue_signature) != len(cue_events):
                continue

            similarity = 1.0
            density_score = _density_score(len(cue_events), bars)
            clarity = _window_event_strength(cue_events)
            variety = _interval_variety_score(cue_signature)
            complexity = _signature_complexity_score(cue_signature)
            character = _pattern_character_score(cue_events, cue_start_bar, drum_curves, sample_rate)
            response_support = _pattern_support_score(
                support_events=support_events,
                response_start_bar=response_start_bar,
                bars=bars,
            )
            score = _clamp01(
                (similarity * 0.18)
                + (clarity * 0.24)
                + (density_score * 0.16)
                + (variety * 0.12)
                + (complexity * 0.12)
                + (character * 0.12)
                + (response_support * 0.06)
                + (0.1 if bars == 1 else 0.0)
            )

            if complexity < (0.02 if bars == 1 else 0.05):
                continue

            if score < (0.58 if bars == 1 else 0.62):
                continue

            window_candidates.append(
                PatternWindow(
                    bars=bars,
                    cue_start_bar=cue_start_bar,
                    response_start_bar=response_start_bar,
                    score=score,
                    cue_events=cue_events,
                    response_events=projected_response_events,
                    similarity=similarity,
                )
            )

    window_candidates.sort(key=lambda window: (-window.score, window.bars, window.cue_start_bar))
    selected_windows: list[PatternWindow] = []
    reserved_bars: set[int] = set()

    one_bar_candidates = [window for window in window_candidates if window.bars == 1]
    two_bar_candidates = [window for window in window_candidates if window.bars == 2]

    if density == "pattern":
        target_one_bar_count = min(len(one_bar_candidates), max(1, round(target_window_count * 0.7)))
    elif density == "hybrid" and target_window_count >= 3:
        target_one_bar_count = min(len(one_bar_candidates), 2)
    else:
        target_one_bar_count = 0

    target_two_bar_count = max(0, target_window_count - target_one_bar_count)

    def try_select(candidates: list[PatternWindow], max_count: int) -> None:
        for window in candidates:
            if len(selected_windows) >= target_window_count:
                break

            current_count = sum(1 for selected in selected_windows if selected.bars == window.bars)

            if current_count >= max_count:
                continue

            full_window_bars = range(window.cue_start_bar, window.response_start_bar + window.bars)

            if any(bar in reserved_bars for bar in full_window_bars):
                continue

            selected_windows.append(window)
            reserved_bars.update(full_window_bars)

    if target_one_bar_count > 0:
        try_select(one_bar_candidates, target_one_bar_count)

    if target_two_bar_count > 0:
        try_select(two_bar_candidates, target_two_bar_count)

    for window in window_candidates:
        if len(selected_windows) >= target_window_count:
            break

        full_window_bars = range(window.cue_start_bar, window.response_start_bar + window.bars)

        if any(bar in reserved_bars for bar in full_window_bars):
            continue

        selected_windows.append(window)
        reserved_bars.update(full_window_bars)

    if not selected_windows and window_candidates and window_candidates[0].score >= 0.58:
        selected_windows.append(window_candidates[0])

    selected_windows.sort(key=lambda window: (window.response_start_bar, window.bars))
    return selected_windows


def _pattern_reason(window: PatternWindow, event: CandidateEvent) -> str:
    return (
        f"{window.bars}-bar combo-pattern response candidate. "
        f"Bars {window.cue_start_bar}-{window.cue_start_bar + window.bars - 1} and "
        f"bars {window.response_start_bar}-{window.response_start_bar + window.bars - 1} share the same rhythm grid, "
        f"so this note belongs to the exact copied response phrase at {event.timeSec:.3f}s."
    )


def _pattern_cue_reason(window: PatternWindow) -> str:
    return (
        f"{window.bars}-bar combo-pattern cue motif. "
        f"Listen to bars {window.cue_start_bar}-{window.cue_start_bar + window.bars - 1}; "
        f"the response repeats the same rhythm exactly one section later."
    )


def _event_time_bounds(events: list[CandidateEvent]) -> tuple[float, float]:
    if not events:
        return 0.0, 0.0

    times = [event.timeSec for event in events]
    return _round_float(min(times)), _round_float(max(times))


def _build_pattern_content(
    selected_windows: list[PatternWindow],
    prefix: str,
) -> tuple[list[CandidateEvent], list[PatternSegment]]:
    pattern_events: list[CandidateEvent] = []
    pattern_segments: list[PatternSegment] = []
    next_index = 1

    for window_index, window in enumerate(selected_windows, start=1):
        scene_type: Literal["combo_pattern_1bar", "combo_pattern_2bar"] = (
            "combo_pattern_1bar" if window.bars == 1 else "combo_pattern_2bar"
        )
        scene_group_id = f"{prefix}-grp-{window_index:03d}"
        response_event_ids: list[str] = []
        response_events: list[CandidateEvent] = []

        for event in sorted(window.response_events, key=_event_sort_key):
            style_confidence = _clamp01((window.score * 0.62) + (event.confidence * 0.38))
            event_id = f"{prefix}-evt-{next_index:05d}"
            copied_event = _copy_event(
                event=event,
                event_id=event_id,
                confidence=style_confidence,
                reason=_pattern_reason(window, event),
                scene_family="pattern",
                scene_type=scene_type,
                scene_group_id=scene_group_id,
            )
            pattern_events.append(copied_event)
            response_events.append(copied_event)
            response_event_ids.append(event_id)
            next_index += 1

        cue_events: list[CandidateEvent] = []

        for cue_index, event in enumerate(sorted(window.cue_events, key=_event_sort_key), start=1):
            cue_events.append(
                _copy_event(
                    event=event,
                    event_id=f"{prefix}-cue-{window_index:03d}-{cue_index:02d}",
                    confidence=_clamp01((window.score * 0.45) + (event.confidence * 0.55)),
                    reason=_pattern_cue_reason(window),
                    scene_family="pattern",
                    scene_type=scene_type,
                    scene_group_id=scene_group_id,
                )
            )

        cue_start_sec, cue_end_sec = _event_time_bounds(cue_events)
        response_start_sec, response_end_sec = _event_time_bounds(response_events)
        cue_times_sec = [_round_float(event.timeSec) for event in cue_events]

        if cue_times_sec:
            response_events = [
                _copy_event(
                    event=event,
                    event_id=event.id,
                    confidence=event.confidence,
                    reason=event.reason,
                    scene_family=event.sceneFamily,
                    scene_type=event.sceneType,
                    scene_group_id=scene_group_id,
                    cue_times_sec=cue_times_sec,
                )
                for event in response_events
            ]
            pattern_events[-len(response_events) :] = response_events

        pattern_segments.append(
            PatternSegment(
                id=f"{prefix}-seg-{window_index:03d}",
                bars=window.bars,
                sceneType=scene_type,
                cueStartBar=window.cue_start_bar,
                cueEndBar=window.cue_start_bar + window.bars - 1,
                responseStartBar=window.response_start_bar,
                responseEndBar=window.response_start_bar + window.bars - 1,
                cueStartSec=cue_start_sec,
                cueEndSec=cue_end_sec,
                responseStartSec=response_start_sec,
                responseEndSec=response_end_sec,
                score=_round_float(window.score, 3),
                similarity=_round_float(window.similarity, 3),
                cueEvents=cue_events,
                responseEventIds=response_event_ids,
            )
        )

    return pattern_events, pattern_segments


def _build_hybrid_events(
    reactive_events: list[CandidateEvent],
    pattern_events: list[CandidateEvent],
    selected_windows: list[PatternWindow],
) -> list[CandidateEvent]:
    reserved_bars: set[int] = set()

    for window in selected_windows:
        reserved_bars.update(range(window.cue_start_bar, window.response_start_bar + window.bars))

    hybrid_events = list(pattern_events)
    reactive_index = 1

    for event in reactive_events:
        if event.barIndex in reserved_bars:
            continue

        hybrid_events.append(
            _copy_event(
                event=event,
                event_id=f"hyb-rct-{reactive_index:05d}",
                confidence=event.confidence,
                reason=f"Hybrid candidate outside reserved pattern bars. {event.reason}",
            )
        )
        reactive_index += 1

    hybrid_events.sort(key=_event_sort_key)
    return hybrid_events


def _build_variant(
    strategy: CandidateStrategy,
    candidate_events: list[CandidateEvent],
    pattern_segments: list[PatternSegment] | None = None,
) -> CandidateVariant:
    label, description = STYLE_META[strategy]
    return CandidateVariant(
        strategy=strategy,
        label=label,
        description=description,
        candidateEvents=candidate_events,
        patternSegments=pattern_segments or [],
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
    drum_curves = _build_drum_feature_curves(percussive_signal, sample_rate)

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
        global_bpm = _snap_bpm(_octave_correct_bpm(global_bpm, onset_envelope, sample_rate))
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

    offset_candidates = _build_offset_candidates(
        auto_offset_sec=offset_sec,
        beat_tracker_offset_sec=float(beat_times[0]) if beat_times.size > 0 else None,
        first_onset_sec=first_onset_sec,
        onset_frames=onset_frames,
        onset_envelope=onset_envelope,
        sample_rate=sample_rate,
        global_bpm=global_bpm,
        song_length_sec=duration_sec,
    )

    reactive_source_events = _build_candidate_events(
        profile="global",
        song_length_sec=duration_sec,
        offset_sec=offset_sec,
        global_bpm=global_bpm,
        sample_rate=sample_rate,
        onset_envelope=onset_envelope,
        onset_frames=onset_frames,
    )
    pattern_source_events = _build_candidate_events(
        profile="section4bar",
        song_length_sec=duration_sec,
        offset_sec=offset_sec,
        global_bpm=global_bpm,
        sample_rate=sample_rate,
        onset_envelope=onset_envelope,
        onset_frames=onset_frames,
    )

    reactive_events = _build_reactive_events(
        source_events=reactive_source_events,
        onset_times=onset_times,
        global_bpm=global_bpm,
        drum_curves=drum_curves,
        sample_rate=sample_rate,
    )
    pattern_seed_events = _build_pattern_seed_events(
        source_events=pattern_source_events,
        onset_times=onset_times,
        global_bpm=global_bpm,
        drum_curves=drum_curves,
        sample_rate=sample_rate,
    )
    selected_pattern_windows = _select_pattern_windows(
        seed_events=pattern_seed_events or reactive_events,
        support_events=pattern_source_events,
        global_bpm=global_bpm,
        song_length_sec=duration_sec,
        density="pattern",
        drum_curves=drum_curves,
        sample_rate=sample_rate,
    )
    selected_hybrid_windows = _select_pattern_windows(
        seed_events=pattern_seed_events or reactive_events,
        support_events=pattern_source_events,
        global_bpm=global_bpm,
        song_length_sec=duration_sec,
        density="hybrid",
        drum_curves=drum_curves,
        sample_rate=sample_rate,
    )
    pattern_events, pattern_segments = _build_pattern_content(selected_pattern_windows, prefix="ptn")
    hybrid_pattern_events, hybrid_pattern_segments = _build_pattern_content(selected_hybrid_windows, prefix="hyb-ptn")
    hybrid_events = _build_hybrid_events(reactive_events, hybrid_pattern_events, selected_hybrid_windows)

    candidate_variants = [
        _build_variant("reactive", reactive_events),
        _build_variant("pattern", pattern_events, pattern_segments),
        _build_variant("hybrid", hybrid_events or reactive_events, hybrid_pattern_segments),
    ]
    default_variant = next((variant for variant in candidate_variants if variant.strategy == "hybrid"), candidate_variants[0])

    return AnalysisResponse(
        schemaVersion=1,
        songId=_slugify(Path(file_name).stem),
        songName=_title_from_file_name(file_name),
        audioFileName=file_name,
        analysisVersion=date.today().isoformat(),
        globalBpm=_round_float(global_bpm, 2),
        offsetSec=_round_float(offset_sec),
        songLengthSec=_round_float(duration_sec),
        defaultCandidateStrategy="hybrid",
        offsetCandidates=offset_candidates,
        candidateEvents=default_variant.candidateEvents,
        candidateVariants=candidate_variants,
    )
