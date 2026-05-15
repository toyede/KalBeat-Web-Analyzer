"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type MutableRefObject } from "react";

import { candidateSceneTypeMeta, candidateSceneTypeOrder } from "@/lib/candidate-scene-meta";
import { timingRoleMeta } from "@/lib/candidate-event-meta";
import type { AnalysisResponse, CandidateReviewState, CandidateVariant, PatternSegment } from "@/lib/types";

const MIN_TIMELINE_ZOOM = 1;
const MAX_TIMELINE_ZOOM = 10;
const TIMELINE_ZOOM_STEP = 0.5;

type AnalysisTimelineProps = {
  analysis: AnalysisResponse;
  variant: CandidateVariant;
  audioFile: File | null;
  selectedEventId: string | null;
  reviewStates: Record<string, CandidateReviewState>;
  onSelectEvent: (eventId: string) => void;
};

type TimelineLane = {
  id: string;
  sceneType: PatternSegment["sceneType"] | CandidateVariant["candidateEvents"][number]["sceneType"];
  label: string;
  responseEvents: CandidateVariant["candidateEvents"];
  cueEvents: CueMarker[];
  patternSegments: PatternSegment[];
};

type CueMarker = {
  id: string;
  timeSec: number;
  kind: CandidateVariant["candidateEvents"][number]["kind"];
};

type PreviewEvent = {
  id: string;
  timeSec: number;
  kind: CandidateVariant["candidateEvents"][number]["kind"];
  tone: "cue" | "input";
};

type WindowWithWebkitAudio = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

function formatSeconds(value: number) {
  const minutes = Math.floor(value / 60);
  const seconds = value - minutes * 60;
  return `${minutes}:${seconds.toFixed(2).padStart(5, "0")}`;
}

function formatSlotLabel(slotInBeat: number, gridDivision: number) {
  if (gridDivision === 0) {
    return "free onset";
  }

  return `slot ${slotInBeat}/${gridDivision}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getFileKey(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function createAudioContext() {
  const AudioContextConstructor = window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext;

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

function buildTimelineLanes(variant: CandidateVariant): TimelineLane[] {
  const laneSceneTypes =
    variant.strategy === "reactive"
      ? candidateSceneTypeOrder.filter((sceneType) => candidateSceneTypeMeta[sceneType].family === "reactive")
      : variant.strategy === "pattern"
        ? candidateSceneTypeOrder.filter((sceneType) => candidateSceneTypeMeta[sceneType].family === "pattern")
        : candidateSceneTypeOrder;

  return laneSceneTypes.flatMap((sceneType) => {
    const responseEvents = variant.candidateEvents.filter((event) => event.sceneType === sceneType);
    const patternSegments = variant.patternSegments.filter((segment) => segment.sceneType === sceneType);
    const cueEventMap = new Map<string, CueMarker>();

    for (const segment of patternSegments) {
      for (const event of segment.cueEvents) {
        cueEventMap.set(event.id, {
          id: event.id,
          timeSec: event.timeSec,
          kind: event.kind,
        });
      }
    }

    for (const event of responseEvents) {
      for (const [cueIndex, cueTimeSec] of event.cueTimesSec.entries()) {
        const cueId = `${event.sceneGroupId || event.id}-cue-${cueIndex + 1}`;

        if (!cueEventMap.has(cueId)) {
          cueEventMap.set(cueId, {
            id: cueId,
            timeSec: cueTimeSec,
            kind: "light",
          });
        }
      }
    }

    const cueEvents = Array.from(cueEventMap.values()).sort((left, right) => left.timeSec - right.timeSec);

    if (responseEvents.length === 0 && cueEvents.length === 0 && patternSegments.length === 0) {
      return [];
    }

    return [
      {
        id: sceneType,
        sceneType,
        label: candidateSceneTypeMeta[sceneType].laneLabel,
        responseEvents,
        cueEvents,
        patternSegments,
      },
    ];
  });
}

function buildPreviewEvents(events: CandidateVariant["candidateEvents"], tone: "cue" | "input"): PreviewEvent[] {
  return events.map((event) => ({
    id: event.id,
    timeSec: event.timeSec,
    kind: event.kind,
    tone,
  }));
}

function buildCuePreviewEvents(events: CueMarker[]): PreviewEvent[] {
  return events.map((event) => ({
    id: event.id,
    timeSec: event.timeSec,
    kind: event.kind,
    tone: "cue" as const,
  }));
}

function buildPreviewEventsForLanes(lanes: TimelineLane[]) {
  const eventMap = new Map<string, PreviewEvent>();

  for (const lane of lanes) {
    for (const event of buildCuePreviewEvents(lane.cueEvents)) {
      eventMap.set(event.id, event);
    }

    for (const event of buildPreviewEvents(lane.responseEvents, "input")) {
      eventMap.set(event.id, event);
    }
  }

  return Array.from(eventMap.values()).sort((left, right) => left.timeSec - right.timeSec);
}

export function AnalysisTimeline({
  analysis,
  variant,
  audioFile,
  selectedEventId,
  reviewStates,
  onSelectEvent,
}: AnalysisTimelineProps) {
  const [effectFile, setEffectFile] = useState<File | null>(null);
  const [waveformBars, setWaveformBars] = useState<number[]>(() => createPlaceholderBars());
  const [waveformStatus, setWaveformStatus] = useState("실제 파형은 업로드한 오디오를 기준으로 브라우저에서 계산합니다.");
  const [previewStatus, setPreviewStatus] = useState("효과음이 없으면 합성 클릭으로 후보 타이밍을 들려줍니다.");
  const [isPlaying, setIsPlaying] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(2);
  const [panPercent, setPanPercent] = useState(0);
  const [musicVolume, setMusicVolume] = useState(55);
  const [effectVolume, setEffectVolume] = useState(100);
  const [cuePitch, setCuePitch] = useState(82);
  const [inputPitch, setInputPitch] = useState(118);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const musicBufferRef = useRef<{ key: string; buffer: AudioBuffer } | null>(null);
  const effectBufferRef = useRef<{ key: string; buffer: AudioBuffer } | null>(null);
  const activeSourcesRef = useRef<AudioScheduledSourceNode[]>([]);
  const playbackTimerRef = useRef<number | null>(null);

  const timelineLanes = useMemo(() => buildTimelineLanes(variant), [variant]);
  const previewEvents = useMemo(() => buildPreviewEventsForLanes(timelineLanes), [timelineLanes]);
  const selectedEvent = variant.candidateEvents.find((event) => event.id === selectedEventId) ?? variant.candidateEvents[0] ?? null;
  const selectedLane =
    timelineLanes.find((lane) => lane.responseEvents.some((event) => event.id === selectedEvent?.id)) ??
    timelineLanes.find((lane) => lane.responseEvents.length > 0) ??
    null;
  const selectedSceneMeta = selectedEvent ? candidateSceneTypeMeta[selectedEvent.sceneType] : null;
  const selectedTimingMeta = selectedEvent ? timingRoleMeta[selectedEvent.timingRole] : null;
  const lanePreviewEvents = useMemo(
    () => (selectedLane ? buildPreviewEventsForLanes([selectedLane]) : []),
    [selectedLane],
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
      setWaveformStatus("실제 파형은 업로드한 오디오를 기준으로 브라우저에서 계산합니다.");
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
        setWaveformStatus("오디오 파형과 씬 후보 위치를 같은 축에서 비교할 수 있습니다.");
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setWaveformBars(createPlaceholderBars());
        setWaveformStatus("파형 계산에 실패해서 기본 시각화로 대체했습니다.");
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
  }, [syncViewportToPan, zoomLevel, waveformBars.length, timelineLanes.length, variant.candidateEvents.length]);

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

  function scheduleSynthClick(context: AudioContext, when: number, gainScale: number, pitchRate: number) {
    const oscillator = context.createOscillator();
    const gainNode = context.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.value = 1950 * pitchRate;
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
    setZoomLevel(clamp(Number.isFinite(nextZoom) ? nextZoom : MIN_TIMELINE_ZOOM, MIN_TIMELINE_ZOOM, MAX_TIMELINE_ZOOM));
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

  function handleCuePitchChange(event: ChangeEvent<HTMLInputElement>) {
    setCuePitch(clamp(Number.parseFloat(event.target.value), 60, 160));
  }

  function handleInputPitchChange(event: ChangeEvent<HTMLInputElement>) {
    setInputPitch(clamp(Number.parseFloat(event.target.value), 60, 160));
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
      setPreviewStatus("오디오 파일을 먼저 선택하고 분석해 주세요.");
      return;
    }

    if (variant.candidateEvents.length === 0) {
      setPreviewStatus("현재 보기에는 재생할 후보가 없습니다.");
      return;
    }

    if (mode === "focus" && !selectedEvent) {
      setPreviewStatus("먼저 미리들을 이벤트를 하나 선택해 주세요.");
      return;
    }

    stopPlayback();

    try {
      const context = audioContextRef.current ?? createAudioContext();
      audioContextRef.current = context;
      await context.resume();

      const musicBuffer = await ensureAudioBuffer(audioFile, musicBufferRef);
      const fxBuffer = effectFile ? await ensureAudioBuffer(effectFile, effectBufferRef) : null;
      const previewSource =
        mode === "group"
          ? lanePreviewEvents
          : mode === "focus" && selectedEvent
            ? [
                ...buildCuePreviewEvents(
                  selectedEvent.cueTimesSec.map((cueTimeSec, cueIndex) => ({
                    id: `${selectedEvent.sceneGroupId || selectedEvent.id}-focus-cue-${cueIndex + 1}`,
                    timeSec: cueTimeSec,
                    kind: "light" as const,
                  })),
                ),
                ...buildPreviewEvents(
                  variant.candidateEvents.filter((event) => event.sceneGroupId === selectedEvent.sceneGroupId),
                  "input",
                ),
              ]
            : previewEvents;
      const previewStart =
        mode === "focus" && selectedEvent
          ? Math.max(selectedEvent.timeSec - 1.2, 0)
          : Math.max(Math.min(...previewSource.map((event) => event.timeSec), 0), 0);
      const previewDuration =
        mode === "focus" && selectedEvent
          ? Math.min(4, Math.max(1.8, musicBuffer.duration - previewStart))
          : musicBuffer.duration;
      const previewEnd = Math.min(musicBuffer.duration, previewStart + previewDuration);
      const previewEventsInRange = previewSource.filter((event) => event.timeSec >= previewStart && event.timeSec <= previewEnd);
      const startAt = context.currentTime + 0.05;
      const musicSource = context.createBufferSource();
      const musicGain = context.createGain();

      musicSource.buffer = musicBuffer;
      musicGain.gain.value = musicVolume / 100;
      musicSource.connect(musicGain);
      musicGain.connect(context.destination);
      musicSource.start(startAt, previewStart, previewEnd - previewStart);
      activeSourcesRef.current.push(musicSource);

      for (const event of previewEventsInRange) {
        const cueAt = startAt + (event.timeSec - previewStart);
        const pitchRate = (event.tone === "cue" ? cuePitch : inputPitch) / 100;

        if (fxBuffer) {
          const effectSource = context.createBufferSource();
          const effectGain = context.createGain();
          effectSource.buffer = fxBuffer;
          effectSource.playbackRate.value = pitchRate;
          effectGain.gain.value =
            ((event.kind === "strong" ? 0.86 : event.kind === "steady" ? 0.7 : 0.56) *
              (event.tone === "cue" ? 0.72 : 1) *
              effectVolume) /
            100;
          effectSource.connect(effectGain);
          effectGain.connect(context.destination);
          effectSource.start(cueAt);
          activeSourcesRef.current.push(effectSource);
          continue;
        }

        scheduleSynthClick(context, cueAt, ((event.tone === "cue" ? 0.72 : 1) * effectVolume) / 100, pitchRate);
      }

      setIsPlaying(true);
      setPreviewStatus(
        `${effectFile ? `${effectFile.name} 효과음` : "합성 클릭"}으로 ${
          mode === "focus" ? "선택 이벤트" : mode === "group" ? "현재 씬 타입" : "현재 보기 전체"
        }를 재생합니다. 제시 피치 ${cuePitch}%, 입력 피치 ${inputPitch}%`,
      );

      playbackTimerRef.current = window.setTimeout(() => {
        stopPlayback("미리듣기가 종료되었습니다.");
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

    setPreviewStatus("효과음 파일이 없으면 합성 클릭으로 미리듣기 합니다.");
  }

  return (
    <section className="panel timeline-panel">
      <div className="subpanel-header">
        <div>
          <p className="eyebrow">Timeline</p>
          <h3>씬 후보 타임라인</h3>
        </div>
        <div className="timeline-summary">
          <span>{variant.candidateEvents.length}개 후보</span>
          <span>{timelineLanes.length}개 씬 레인</span>
          <span>패턴 구간 {variant.patternSegments.length}개</span>
        </div>
      </div>

      <p className="helper-text">{waveformStatus}</p>

      <div className="timeline-toolbar">
        <div className="toolbar-card">
          <span className="metric-label">줌</span>
          <div className="toolbar-row">
            <button
              className="mini-button"
              onClick={() => setZoomLevel((current) => clamp(current - TIMELINE_ZOOM_STEP, MIN_TIMELINE_ZOOM, MAX_TIMELINE_ZOOM))}
              type="button"
            >
              -
            </button>
            <input
              max={MAX_TIMELINE_ZOOM}
              min={MIN_TIMELINE_ZOOM}
              onChange={handleZoomChange}
              step={TIMELINE_ZOOM_STEP}
              type="range"
              value={zoomLevel}
            />
            <button
              className="mini-button"
              onClick={() => setZoomLevel((current) => clamp(current + TIMELINE_ZOOM_STEP, MIN_TIMELINE_ZOOM, MAX_TIMELINE_ZOOM))}
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
            <div className="timeline-track-row waveform-row">
              <div className="timeline-track-label">Wave</div>
              <div className="timeline-waveform-track">
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
              </div>
            </div>

            <div className="timeline-lanes">
              {timelineLanes.map((lane) => (
                <div className="timeline-track-row lane-row" key={lane.id}>
                  <div className="timeline-track-label">{lane.label}</div>
                  <div className="timeline-lane-track">
                    <div className="timeline-lane-rule" aria-hidden="true" />
                    {lane.patternSegments.map((segment) => {
                      const cueLeft = analysis.songLengthSec > 0 ? (segment.cueStartSec / analysis.songLengthSec) * 100 : 0;
                      const cueWidth =
                        analysis.songLengthSec > 0
                          ? Math.max(((segment.cueEndSec - segment.cueStartSec) / analysis.songLengthSec) * 100, 0.8)
                          : 0;
                      const responseLeft =
                        analysis.songLengthSec > 0 ? (segment.responseStartSec / analysis.songLengthSec) * 100 : 0;
                      const responseWidth =
                        analysis.songLengthSec > 0
                          ? Math.max(((segment.responseEndSec - segment.responseStartSec) / analysis.songLengthSec) * 100, 0.8)
                          : 0;

                      return (
                        <div key={`${lane.id}-${segment.id}`}>
                          <span
                            aria-hidden="true"
                            className="timeline-segment cue"
                            style={{ left: `${Math.min(cueLeft, 100)}%`, width: `${Math.min(cueWidth, 100)}%` }}
                          />
                          <span
                            aria-hidden="true"
                            className="timeline-segment response"
                            style={{ left: `${Math.min(responseLeft, 100)}%`, width: `${Math.min(responseWidth, 100)}%` }}
                          />
                        </div>
                      );
                    })}
                    {lane.cueEvents.map((event) => {
                      const position = analysis.songLengthSec > 0 ? (event.timeSec / analysis.songLengthSec) * 100 : 0;
                      return (
                        <span
                          key={event.id}
                          aria-hidden="true"
                          className={`timeline-dot cue ${event.kind}`}
                          style={{ left: `${Math.min(position, 100)}%` }}
                          title={`${lane.label} 예비 박 · ${event.timeSec.toFixed(3)}s`}
                        />
                      );
                    })}
                    {lane.responseEvents.map((event) => {
                      const reviewState = reviewStates[event.id] ?? "unreviewed";
                      const position = analysis.songLengthSec > 0 ? (event.timeSec / analysis.songLengthSec) * 100 : 0;

                      return (
                        <button
                          key={event.id}
                          type="button"
                          className={`timeline-dot ${event.kind} ${reviewState} ${event.id === selectedEventId ? "selected" : ""}`}
                          onClick={() => onSelectEvent(event.id)}
                          style={{ left: `${Math.min(position, 100)}%` }}
                          title={`${candidateSceneTypeMeta[event.sceneType].label} · Beat ${event.beatIndex} · ${event.timeSec.toFixed(3)}s`}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
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
            <span>원본 볼륨 {musicVolume}%</span>
            <input max="100" min="0" onChange={handleMusicVolumeChange} step="1" type="range" value={musicVolume} />
          </label>
          <label className="slider-field">
            <span>효과음 볼륨 {effectVolume}%</span>
            <input max="140" min="0" onChange={handleEffectVolumeChange} step="1" type="range" value={effectVolume} />
          </label>
          <label className="slider-field">
            <span>패턴 제시 피치 {cuePitch}%</span>
            <input max="160" min="60" onChange={handleCuePitchChange} step="1" type="range" value={cuePitch} />
          </label>
          <label className="slider-field">
            <span>입력 타이밍 피치 {inputPitch}%</span>
            <input max="160" min="60" onChange={handleInputPitchChange} step="1" type="range" value={inputPitch} />
          </label>
        </div>

        <div className="preview-buttons">
          <button
            className="secondary-button"
            disabled={!audioFile || variant.candidateEvents.length === 0}
            onClick={() => void playPreview("all")}
            type="button"
          >
            전체 후보 재생
          </button>
          <button
            className="secondary-button"
            disabled={!audioFile || !selectedLane}
            onClick={() => void playPreview("group")}
            type="button"
          >
            현재 씬 타입 재생
          </button>
          <button
            className="secondary-button"
            disabled={!audioFile || !selectedEvent}
            onClick={() => void playPreview("focus")}
            type="button"
          >
            선택 이벤트 재생
          </button>
          <button className="ghost-button" disabled={!isPlaying} onClick={() => stopPlayback("미리듣기를 중지했습니다.")} type="button">
            정지
          </button>
        </div>
      </div>

      <p className="helper-text">{previewStatus}</p>

      <div className="selected-event-card">
        {selectedEvent && selectedSceneMeta && selectedTimingMeta ? (
          <>
            <div>
              <span className="metric-label">선택 이벤트</span>
              <strong className="selected-event-title">
                {selectedSceneMeta.label} · Beat {selectedEvent.beatIndex} · {selectedEvent.timeSec.toFixed(3)}s
              </strong>
            </div>
            <div className="selected-event-meta">
              <span>{selectedSceneMeta.family === "reactive" ? "반응형" : "패턴형"}</span>
              <span>{selectedTimingMeta.label}</span>
              <span>Bar {selectedEvent.barIndex}</span>
              <span>{formatSlotLabel(selectedEvent.slotInBeat, selectedEvent.gridDivision)}</span>
              <span>confidence {Math.round(selectedEvent.confidence * 100)}%</span>
              <span>strength {Math.round(selectedEvent.strength * 100)}%</span>
            </div>
            <p>{selectedEvent.reason}</p>
          </>
        ) : (
          <p>후보 이벤트를 선택하면 여기에서 씬 타입과 타이밍 설명을 볼 수 있습니다.</p>
        )}
      </div>
    </section>
  );
}
