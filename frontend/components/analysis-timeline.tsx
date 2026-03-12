"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type MutableRefObject } from "react";

import { timingRoleMeta } from "@/lib/candidate-event-meta";
import type { AnalysisResponse, CandidateReviewState, CandidateTimingRole } from "@/lib/types";

type TimingRoleSelection = Record<CandidateTimingRole, boolean>;

type AnalysisTimelineProps = {
  activeTimingRoles: TimingRoleSelection;
  analysis: AnalysisResponse;
  audioFile: File | null;
  selectedEventId: string | null;
  reviewStates: Record<string, CandidateReviewState>;
  onSelectEvent: (eventId: string) => void;
};

type WindowWithWebkitAudio = Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext };

function formatSeconds(value: number) {
  const minutes = Math.floor(value / 60);
  const seconds = value - minutes * 60;
  return `${minutes}:${seconds.toFixed(2).padStart(5, "0")}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getFileKey(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function createAudioContext() {
  const AudioContextConstructor =
    window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext;

  if (!AudioContextConstructor) {
    throw new Error("이 브라우저에서는 오디오 미리듣기를 지원하지 않습니다.");
  }

  return new AudioContextConstructor();
}

async function buildWaveformBars(file: File, bucketCount = 240) {
  const context = createAudioContext();

  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    const channelData = buffer.getChannelData(0);
    const samplesPerBucket = Math.max(1, Math.floor(channelData.length / bucketCount));
    const bars: number[] = [];
    let highestPeak = 0;

    for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
      const start = bucketIndex * samplesPerBucket;
      const end = Math.min(channelData.length, start + samplesPerBucket);
      let peak = 0;

      for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
        const amplitude = Math.abs(channelData[sampleIndex] ?? 0);

        if (amplitude > peak) {
          peak = amplitude;
        }
      }

      bars.push(peak);
      highestPeak = Math.max(highestPeak, peak);
    }

    if (highestPeak <= 0) {
      return Array.from({ length: bucketCount }, () => 0.12);
    }

    return bars.map((peak) => Math.max(0.08, peak / highestPeak));
  } finally {
    await context.close();
  }
}

function createPlaceholderBars(count = 240) {
  return Array.from({ length: count }, (_, index) => {
    const value = Math.abs(Math.sin(index * 0.19)) * 0.44 + Math.abs(Math.cos(index * 0.05)) * 0.18;
    return Math.max(0.08, Math.min(0.78, value));
  });
}

export function AnalysisTimeline({
  activeTimingRoles,
  analysis,
  audioFile,
  selectedEventId,
  reviewStates,
  onSelectEvent,
}: AnalysisTimelineProps) {
  const [effectFile, setEffectFile] = useState<File | null>(null);
  const [waveformBars, setWaveformBars] = useState<number[]>(() => createPlaceholderBars());
  const [waveformStatus, setWaveformStatus] = useState("실제 파형은 업로드한 파일을 기준으로 브라우저에서 계산합니다.");
  const [previewStatus, setPreviewStatus] = useState("음원 볼륨을 0%로 두면 효과음만 따로 들을 수 있습니다.");
  const [isPlaying, setIsPlaying] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(2);
  const [panPercent, setPanPercent] = useState(0);
  const [musicVolume, setMusicVolume] = useState(55);
  const [effectVolume, setEffectVolume] = useState(100);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const musicBufferRef = useRef<{ key: string; buffer: AudioBuffer } | null>(null);
  const effectBufferRef = useRef<{ key: string; buffer: AudioBuffer } | null>(null);
  const activeSourcesRef = useRef<AudioScheduledSourceNode[]>([]);
  const playbackTimerRef = useRef<number | null>(null);
  const selectedEvent =
    analysis.candidateEvents.find((event) => event.id === selectedEventId) ?? analysis.candidateEvents[0] ?? null;
  const selectedMeta = selectedEvent ? timingRoleMeta[selectedEvent.timingRole] : null;
  const selectedGroupEvents = useMemo(
    () => analysis.candidateEvents.filter((event) => activeTimingRoles[event.timingRole]),
    [activeTimingRoles, analysis.candidateEvents],
  );
  const visibleFraction = 1 / zoomLevel;
  const maxStartFraction = Math.max(0, 1 - visibleFraction);
  const startFraction = maxStartFraction > 0 ? (panPercent / 100) * maxStartFraction : 0;
  const endFraction = Math.min(1, startFraction + visibleFraction);
  const visibleStartSec = analysis.songLengthSec * startFraction;
  const visibleEndSec = analysis.songLengthSec * endFraction;

  useEffect(() => {
    let cancelled = false;

    if (!audioFile) {
      setWaveformBars(createPlaceholderBars());
      setWaveformStatus("실제 파형은 업로드한 파일을 기준으로 브라우저에서 계산합니다.");
      return () => {
        cancelled = true;
      };
    }

    setWaveformStatus("파형을 계산하는 중입니다.");

    void buildWaveformBars(audioFile)
      .then((bars) => {
        if (cancelled) {
          return;
        }

        setWaveformBars(bars);
        setWaveformStatus("줌과 이동으로 원하는 구간을 확대해서 볼 수 있습니다.");
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setWaveformBars(createPlaceholderBars());
        setWaveformStatus("파형 계산에 실패해서 기본 타임라인으로 표시합니다.");
      });

    return () => {
      cancelled = true;
    };
  }, [audioFile]);

  const syncViewportToPan = useCallback(() => {
    const viewport = viewportRef.current;

    if (!viewport) {
      return;
    }

    const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    viewport.scrollLeft = maxScrollLeft * (panPercent / 100);
  }, [panPercent]);

  useEffect(() => {
    syncViewportToPan();
  }, [syncViewportToPan, zoomLevel, waveformBars.length, analysis.candidateEvents.length]);

  const stopPlayback = useCallback((statusMessage?: string) => {
    for (const source of activeSourcesRef.current) {
      try {
        source.stop();
      } catch {}

      source.disconnect();
    }

    activeSourcesRef.current = [];

    if (playbackTimerRef.current !== null) {
      window.clearTimeout(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }

    if (statusMessage) {
      setPreviewStatus(statusMessage);
    }

    setIsPlaying(false);
  }, []);

  useEffect(() => {
    return () => {
      stopPlayback();
    };
  }, [stopPlayback]);

  async function ensureAudioBuffer(
    file: File,
    cacheRef: MutableRefObject<{ key: string; buffer: AudioBuffer } | null>,
  ) {
    const key = getFileKey(file);

    if (cacheRef.current?.key === key) {
      return cacheRef.current.buffer;
    }

    const context = audioContextRef.current ?? createAudioContext();
    audioContextRef.current = context;
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    cacheRef.current = { key, buffer: decoded };
    return decoded;
  }

  function scheduleSynthClick(context: AudioContext, when: number, gainScale: number) {
    const oscillator = context.createOscillator();
    const gainNode = context.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.value = 1950;
    gainNode.gain.setValueAtTime(0.0001, when);
    gainNode.gain.exponentialRampToValueAtTime(0.24 * gainScale, when + 0.002);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, when + 0.055);
    oscillator.connect(gainNode);
    gainNode.connect(context.destination);
    oscillator.start(when);
    oscillator.stop(when + 0.06);
    activeSourcesRef.current.push(oscillator);
  }

  function handleViewportScroll() {
    const viewport = viewportRef.current;

    if (!viewport) {
      return;
    }

    const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const nextPan = maxScrollLeft > 0 ? (viewport.scrollLeft / maxScrollLeft) * 100 : 0;
    setPanPercent(nextPan);
  }

  function handleZoomChange(event: ChangeEvent<HTMLInputElement>) {
    const nextZoom = Number.parseFloat(event.target.value);
    setZoomLevel(clamp(Number.isFinite(nextZoom) ? nextZoom : 1, 1, 10));
  }

  function handlePanChange(event: ChangeEvent<HTMLInputElement>) {
    setPanPercent(clamp(Number.parseFloat(event.target.value), 0, 100));
  }

  function handleMusicVolumeChange(event: ChangeEvent<HTMLInputElement>) {
    setMusicVolume(clamp(Number.parseFloat(event.target.value), 0, 100));
  }

  function handleEffectVolumeChange(event: ChangeEvent<HTMLInputElement>) {
    setEffectVolume(clamp(Number.parseFloat(event.target.value), 0, 140));
  }

  function focusSelectedEvent() {
    if (!selectedEvent || analysis.songLengthSec <= 0) {
      return;
    }

    const selectedFraction = selectedEvent.timeSec / analysis.songLengthSec;
    const nextStartFraction = clamp(selectedFraction - visibleFraction / 2, 0, maxStartFraction);
    const nextPan = maxStartFraction > 0 ? (nextStartFraction / maxStartFraction) * 100 : 0;
    setPanPercent(nextPan);
  }

  async function playPreview(mode: "all" | "group" | "focus") {
    if (!audioFile) {
      setPreviewStatus("실제 음원 파일을 먼저 선택하고 분석해 주세요.");
      return;
    }

    if (analysis.candidateEvents.length === 0) {
      setPreviewStatus("현재 분석 결과에는 마킹할 후보 이벤트가 없습니다.");
      return;
    }

    if (mode === "focus" && !selectedEvent) {
      setPreviewStatus("먼저 미리들을 이벤트를 하나 선택해 주세요.");
      return;
    }

    if (mode === "group" && selectedGroupEvents.length === 0) {
      setPreviewStatus("재생할 그룹이 선택되지 않았습니다. 아래 그룹 체크박스를 먼저 선택해 주세요.");
      return;
    }

    stopPlayback();

    try {
      const context = audioContextRef.current ?? createAudioContext();
      audioContextRef.current = context;
      await context.resume();

      const musicBuffer = await ensureAudioBuffer(audioFile, musicBufferRef);
      const fxBuffer = effectFile ? await ensureAudioBuffer(effectFile, effectBufferRef) : null;
      const previewStart = mode === "focus" && selectedEvent ? Math.max(selectedEvent.timeSec - 1.2, 0) : 0;
      const previewDuration =
        mode === "focus" && selectedEvent
          ? Math.min(4, Math.max(1.8, musicBuffer.duration - previewStart))
          : musicBuffer.duration;
      const previewEnd = Math.min(musicBuffer.duration, previewStart + previewDuration);
      const previewEvents =
        mode === "focus" && selectedEvent
          ? [selectedEvent]
          : mode === "group"
            ? selectedGroupEvents.filter((event) => event.timeSec >= previewStart && event.timeSec <= previewEnd)
            : analysis.candidateEvents.filter((event) => event.timeSec >= previewStart && event.timeSec <= previewEnd);
      const startAt = context.currentTime + 0.05;
      const musicSource = context.createBufferSource();
      const musicGain = context.createGain();

      musicSource.buffer = musicBuffer;
      musicGain.gain.value = musicVolume / 100;
      musicSource.connect(musicGain);
      musicGain.connect(context.destination);
      musicSource.start(startAt, previewStart, previewEnd - previewStart);
      activeSourcesRef.current.push(musicSource);

      for (const event of previewEvents) {
        const cueAt = startAt + (event.timeSec - previewStart);

        if (fxBuffer) {
          const effectSource = context.createBufferSource();
          const effectGain = context.createGain();
          effectSource.buffer = fxBuffer;
          effectGain.gain.value =
            ((event.kind === "strong" ? 0.86 : event.kind === "steady" ? 0.7 : 0.56) * effectVolume) / 100;
          effectSource.connect(effectGain);
          effectGain.connect(context.destination);
          effectSource.start(cueAt);
          activeSourcesRef.current.push(effectSource);
          continue;
        }

        scheduleSynthClick(context, cueAt, effectVolume / 100);
      }

      setIsPlaying(true);
      setPreviewStatus(
        `${
          effectFile ? `${effectFile.name} 효과음` : "합성 클릭"
        }으로 ${
          mode === "focus" ? "선택 이벤트" : mode === "group" ? "선택 그룹" : "전체 이벤트"
        }를 재생합니다. 음원 ${musicVolume}%, 효과음 ${effectVolume}%`,
      );

      playbackTimerRef.current = window.setTimeout(() => {
        stopPlayback("미리듣기가 끝났습니다.");
      }, Math.ceil((previewEnd - previewStart) * 1000) + 180);
    } catch (error) {
      stopPlayback(error instanceof Error ? error.message : "오디오 미리듣기를 시작하지 못했습니다.");
    }
  }

  function handleEffectFileChange(event: ChangeEvent<HTMLInputElement>) {
    const nextFile = event.target.files?.[0] ?? null;
    setEffectFile(nextFile);
    effectBufferRef.current = null;

    if (nextFile) {
      setPreviewStatus(`${nextFile.name}을 효과음으로 사용합니다.`);
      return;
    }

    setPreviewStatus("효과음 파일이 없으면 합성 클릭으로 미리듣기합니다.");
  }

  return (
    <section className="panel timeline-panel">
      <div className="subpanel-header">
        <div>
          <p className="eyebrow">Timeline</p>
          <h3>타임라인과 이벤트 마킹</h3>
        </div>
        <div className="timeline-summary">
          <span>{analysis.candidateEvents.length}개 후보 이벤트</span>
          <span>선택 그룹 {selectedGroupEvents.length}개</span>
          <span>{formatSeconds(analysis.songLengthSec)} 길이</span>
        </div>
      </div>

      <p className="helper-text">{waveformStatus}</p>

      <div className="timeline-toolbar">
        <div className="toolbar-card">
          <span className="metric-label">줌</span>
          <div className="toolbar-row">
            <button
              className="mini-button"
              onClick={() => setZoomLevel((current) => clamp(current - 0.5, 1, 10))}
              type="button"
            >
              -
            </button>
            <input max="10" min="1" onChange={handleZoomChange} step="0.5" type="range" value={zoomLevel} />
            <button
              className="mini-button"
              onClick={() => setZoomLevel((current) => clamp(current + 0.5, 1, 10))}
              type="button"
            >
              +
            </button>
            <strong>{zoomLevel.toFixed(1)}x</strong>
          </div>
        </div>

        <div className="toolbar-card">
          <span className="metric-label">이동</span>
          <div className="toolbar-row">
            <input
              disabled={zoomLevel <= 1}
              max="100"
              min="0"
              onChange={handlePanChange}
              step="0.1"
              type="range"
              value={panPercent}
            />
            <button className="mini-button" disabled={!selectedEvent} onClick={focusSelectedEvent} type="button">
              선택 위치
            </button>
          </div>
          <p className="toolbar-note">
            현재 창 {formatSeconds(visibleStartSec)} - {formatSeconds(visibleEndSec)}
          </p>
        </div>
      </div>

      <div className="timeline-stage">
        <div className="timeline-viewport" onScroll={handleViewportScroll} ref={viewportRef}>
          <div className="timeline-content" style={{ width: `${Math.max(100, zoomLevel * 100)}%` }}>
            <div className="timeline-waveform" role="img" aria-label="Waveform and candidate event markers">
              <div className="timeline-bars" aria-hidden="true">
                {waveformBars.map((value, index) => (
                  <span
                    key={`bar-${index}`}
                    className="timeline-bar"
                    style={{ height: `${Math.max(8, Math.round(value * 100))}%` }}
                  />
                ))}
              </div>

              {analysis.songLengthSec > 0 ? (
                <div
                  aria-hidden="true"
                  className="timeline-offset-marker"
                  style={{ left: `${Math.min((analysis.offsetSec / analysis.songLengthSec) * 100, 100)}%` }}
                />
              ) : null}

              <div className="timeline-marker-layer">
                {analysis.candidateEvents.map((event) => {
                  const reviewState = reviewStates[event.id] ?? "unreviewed";
                  const position = analysis.songLengthSec > 0 ? (event.timeSec / analysis.songLengthSec) * 100 : 0;
                  const meta = timingRoleMeta[event.timingRole];
                  const isGroupActive = activeTimingRoles[event.timingRole];

                  return (
                    <button
                      key={event.id}
                      type="button"
                      className={`timeline-marker ${event.kind} ${reviewState} ${
                        event.id === selectedEventId ? "selected" : ""
                      } ${isGroupActive ? "" : "group-disabled"}`}
                      onClick={() => onSelectEvent(event.id)}
                      style={{ left: `${Math.min(position, 100)}%` }}
                      title={`${meta.label} · Beat ${event.beatIndex} · ${event.timeSec.toFixed(3)}s`}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        <div className="timeline-scale">
          <span>0:00.00</span>
          <span>offset {analysis.offsetSec.toFixed(3)}s</span>
          <span>{formatSeconds(analysis.songLengthSec)}</span>
        </div>
      </div>

      <div className="preview-controls">
        <label className="secondary-file-input">
          <span>효과음 파일 선택</span>
          <input accept=".wav,.mp3,audio/wav,audio/mpeg" onChange={handleEffectFileChange} type="file" />
        </label>

        <div className="volume-grid">
          <label className="slider-field">
            <span>음원 볼륨 {musicVolume}%</span>
            <input max="100" min="0" onChange={handleMusicVolumeChange} step="1" type="range" value={musicVolume} />
          </label>
          <label className="slider-field">
            <span>효과음 볼륨 {effectVolume}%</span>
            <input
              max="140"
              min="0"
              onChange={handleEffectVolumeChange}
              step="1"
              type="range"
              value={effectVolume}
            />
          </label>
        </div>

        <div className="preview-buttons">
          <button
            className="secondary-button"
            disabled={!audioFile || analysis.candidateEvents.length === 0}
            onClick={() => void playPreview("all")}
            type="button"
          >
            전체 재생
          </button>
          <button
            className="secondary-button"
            disabled={!audioFile || selectedGroupEvents.length === 0}
            onClick={() => void playPreview("group")}
            type="button"
          >
            선택 그룹 재생
          </button>
          <button
            className="secondary-button"
            disabled={!audioFile || !selectedEvent}
            onClick={() => void playPreview("focus")}
            type="button"
          >
            선택 이벤트 재생
          </button>
          <button
            className="ghost-button"
            disabled={!isPlaying}
            onClick={() => stopPlayback("미리듣기를 중지했습니다.")}
            type="button"
          >
            정지
          </button>
        </div>
      </div>

      <p className="helper-text">{previewStatus}</p>

      <div className="selected-event-card">
        {selectedEvent && selectedMeta ? (
          <>
            <div>
              <span className="metric-label">선택 이벤트</span>
              <strong className="selected-event-title">
                {selectedMeta.label} · Beat {selectedEvent.beatIndex} · {selectedEvent.timeSec.toFixed(3)}s
              </strong>
            </div>
            <div className="selected-event-meta">
              <span>Bar {selectedEvent.barIndex}</span>
              <span>slot {selectedEvent.slotInBeat}/4</span>
              <span>confidence {Math.round(selectedEvent.confidence * 100)}%</span>
              <span>strength {Math.round(selectedEvent.strength * 100)}%</span>
            </div>
            <p>{selectedMeta.description}</p>
          </>
        ) : (
          <p>후보 이벤트가 생기면 여기에서 선택된 마커 정보를 볼 수 있습니다.</p>
        )}
      </div>
    </section>
  );
}
