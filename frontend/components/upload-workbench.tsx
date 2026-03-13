"use client";

import { useDeferredValue, useEffect, useMemo, useState, useTransition, type ChangeEvent, type FormEvent } from "react";

import { analyzeAudio, supportedExtensions, validateAudioFile } from "@/lib/api";
import {
  candidateStrategyOrder,
  createAnalysisForStrategy,
  getCandidateVariant,
  getCandidateVariants,
} from "@/lib/candidate-strategy";
import { timingRoleOrder } from "@/lib/candidate-event-meta";
import {
  buildProjectSnapshot,
  buildResultExport,
  deleteProjectRecord,
  downloadJsonFile,
  getProjectSnapshotFilename,
  getResultExportFilename,
  listProjectRecords,
  loadProjectRecord,
  saveProjectRecord,
} from "@/lib/project-io";
import { sampleAnalysis } from "@/lib/sample-analysis";
import type {
  AnalysisResponse,
  CandidateEvent,
  CandidateReviewState,
  CandidateStrategy,
  CandidateTimingRole,
  SavedProjectSummary,
  TimingRoleSelection,
} from "@/lib/types";

import { AnalysisTimeline } from "./analysis-timeline";
import { CandidateEventsPanel } from "./candidate-events-panel";

type Phase = "idle" | "uploading" | "success" | "error";

const defaultMessage =
  "샘플 결과가 먼저 보입니다. 실제 오디오 파일을 올리면 BPM, offset, 곡 길이와 함께 두 가지 후보 추출 방식의 차이를 바로 비교할 수 있습니다.";

function getPhaseLabel(phase: Phase) {
  if (phase === "uploading") {
    return "분석 중";
  }

  if (phase === "success") {
    return "완료";
  }

  if (phase === "error") {
    return "오류";
  }

  return "대기";
}

function collectAllCandidateEvents(analysis: AnalysisResponse) {
  const variants = getCandidateVariants(analysis);
  const seenIds = new Set<string>();
  const events: CandidateEvent[] = [];

  for (const variant of variants) {
    for (const event of variant.candidateEvents) {
      if (seenIds.has(event.id)) {
        continue;
      }

      seenIds.add(event.id);
      events.push(event);
    }
  }

  return events;
}

function createInitialReviewState(analysis: AnalysisResponse) {
  return Object.fromEntries(
    collectAllCandidateEvents(analysis).map((event) => [event.id, "unreviewed" as CandidateReviewState]),
  );
}

function mergeReviewStates(
  analysis: AnalysisResponse,
  current: Record<string, CandidateReviewState> | null | undefined,
) {
  const next = createInitialReviewState(analysis);

  if (!current) {
    return next;
  }

  for (const event of collectAllCandidateEvents(analysis)) {
    next[event.id] = current[event.id] ?? "unreviewed";
  }

  return next;
}

function createTimingRoleSelection(nextValue = true): TimingRoleSelection {
  return Object.fromEntries(timingRoleOrder.map((role) => [role, nextValue])) as TimingRoleSelection;
}

function normalizeTimingRoleSelection(current: Partial<TimingRoleSelection> | null | undefined) {
  const next = createTimingRoleSelection(true);

  if (!current) {
    return next;
  }

  for (const role of timingRoleOrder) {
    if (typeof current[role] === "boolean") {
      next[role] = current[role];
    }
  }

  return next;
}

function formatSavedAt(savedAt: string) {
  const parsed = new Date(savedAt);

  if (Number.isNaN(parsed.getTime())) {
    return savedAt;
  }

  return parsed.toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function UploadWorkbench() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResponse>(sampleAnalysis);
  const [activeCandidateStrategy, setActiveCandidateStrategy] = useState<CandidateStrategy>(
    sampleAnalysis.defaultCandidateStrategy,
  );
  const [selectedEventId, setSelectedEventId] = useState<string | null>(sampleAnalysis.candidateEvents[0]?.id ?? null);
  const [reviewStates, setReviewStates] = useState<Record<string, CandidateReviewState>>(
    createInitialReviewState(sampleAnalysis),
  );
  const [activeTimingRoles, setActiveTimingRoles] = useState<TimingRoleSelection>(createTimingRoleSelection(true));
  const [savedProjects, setSavedProjects] = useState<SavedProjectSummary[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState(defaultMessage);
  const [isRendering, startTransition] = useTransition();

  const deferredAnalysis = useDeferredValue(analysis);
  const activeVariant = useMemo(
    () => getCandidateVariant(deferredAnalysis, activeCandidateStrategy),
    [activeCandidateStrategy, deferredAnalysis],
  );
  const activeAnalysis = useMemo(
    () => createAnalysisForStrategy(deferredAnalysis, activeVariant.strategy),
    [activeVariant.strategy, deferredAnalysis],
  );
  const strategyCounts = useMemo(
    () =>
      Object.fromEntries(
        getCandidateVariants(deferredAnalysis).map((variant) => [variant.strategy, variant.candidateEvents.length]),
      ) as Record<CandidateStrategy, number>,
    [deferredAnalysis],
  );

  const keptCount = useMemo(
    () => activeAnalysis.candidateEvents.filter((event) => reviewStates[event.id] === "keep").length,
    [activeAnalysis.candidateEvents, reviewStates],
  );

  useEffect(() => {
    let cancelled = false;

    async function refreshSavedProjects() {
      try {
        const nextSavedProjects = await listProjectRecords();

        if (!cancelled) {
          setSavedProjects(nextSavedProjects);
        }
      } catch (error) {
        if (!cancelled) {
          setPhase("error");
          setMessage(error instanceof Error ? error.message : "저장본 목록을 불러오지 못했습니다.");
        }
      }
    }

    void refreshSavedProjects();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setReviewStates((current) => {
      const next = mergeReviewStates(deferredAnalysis, current);
      const currentKeys = Object.keys(current);
      const nextKeys = Object.keys(next);

      if (currentKeys.length === nextKeys.length && nextKeys.every((key) => current[key] === next[key])) {
        return current;
      }

      return next;
    });
  }, [deferredAnalysis]);

  useEffect(() => {
    const nextVariant = getCandidateVariant(deferredAnalysis, activeCandidateStrategy);

    if (!nextVariant) {
      return;
    }

    if (!nextVariant.candidateEvents.some((event) => event.id === selectedEventId)) {
      setSelectedEventId(nextVariant.candidateEvents[0]?.id ?? null);
    }
  }, [activeCandidateStrategy, deferredAnalysis, selectedEventId]);

  async function refreshSavedProjects() {
    const nextSavedProjects = await listProjectRecords();
    setSavedProjects(nextSavedProjects);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedFile) {
      setPhase("error");
      setMessage("먼저 분석할 오디오 파일을 선택해 주세요.");
      return;
    }

    try {
      validateAudioFile(selectedFile);
      setPhase("uploading");
      setMessage(`${selectedFile.name} 분석 요청을 보내는 중입니다.`);

      const result = await analyzeAudio(selectedFile);

      startTransition(() => {
        const defaultStrategy = result.defaultCandidateStrategy ?? "global";
        const defaultVariant = getCandidateVariant(result, defaultStrategy);
        const globalCount = getCandidateVariant(result, "global").candidateEvents.length;
        const sectionCount = getCandidateVariant(result, "section4bar").candidateEvents.length;

        setAnalysis(result);
        setActiveCandidateStrategy(defaultVariant.strategy);
        setSelectedEventId(defaultVariant.candidateEvents[0]?.id ?? null);
        setReviewStates(createInitialReviewState(result));
        setActiveTimingRoles(createTimingRoleSelection(true));
        setPhase("success");
        setMessage(
          `${result.audioFileName} 분석이 끝났습니다. 전곡 기준 ${globalCount}개, 4마디 기준 ${sectionCount}개 후보를 비교해 보세요.`,
        );
      });
    } catch (error) {
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "분석 요청에 실패했습니다.");
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;

    if (!file) {
      setSelectedFile(null);
      setPhase("idle");
      setMessage(defaultMessage);
      return;
    }

    try {
      validateAudioFile(file);
      setSelectedFile(file);
      setPhase("idle");
      setMessage(`${file.name} 준비 완료. 분석 실행을 누르면 두 가지 후보 추출 방식을 함께 계산합니다.`);
    } catch (error) {
      setSelectedFile(null);
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "지원하지 않는 파일 형식입니다.");
    }
  }

  function handleReviewChange(eventId: string, nextState: CandidateReviewState) {
    setReviewStates((current) => ({
      ...current,
      [eventId]: nextState,
    }));
  }

  function handleTimingRoleToggle(role: CandidateTimingRole) {
    setActiveTimingRoles((current) => ({
      ...current,
      [role]: !current[role],
    }));
  }

  function handleSelectAllTimingRoles(nextValue: boolean) {
    setActiveTimingRoles(createTimingRoleSelection(nextValue));
  }

  function handleCandidateStrategyChange(strategy: CandidateStrategy) {
    const nextVariant = getCandidateVariant(analysis, strategy);
    setActiveCandidateStrategy(strategy);
    setSelectedEventId((current) =>
      current && nextVariant.candidateEvents.some((event) => event.id === current)
        ? current
        : nextVariant.candidateEvents[0]?.id ?? null,
    );
    setPhase("success");
    setMessage(`${nextVariant.label} 방식으로 후보를 보고 있습니다. 타임라인과 재생, 내보내기도 이 기준을 따릅니다.`);
  }

  async function handleSaveProject() {
    try {
      const savedProject = await saveProjectRecord({
        analysis,
        reviewStates,
        activeTimingRoles,
        activeCandidateStrategy,
        selectedEventId,
        audioFile: selectedFile,
        title: selectedFile?.name ?? analysis.audioFileName ?? analysis.songName,
      });

      await refreshSavedProjects();
      setPhase("success");
      setMessage(
        `${savedProject.title} 저장본을 만들었습니다. ${
          savedProject.hasAudio ? "원본 음원도 함께 보관했습니다." : "현재는 분석 결과만 저장되었습니다."
        }`,
      );
    } catch (error) {
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "저장본을 만들지 못했습니다.");
    }
  }

  async function handleRestoreProject(projectId: string) {
    try {
      const loadedProject = await loadProjectRecord(projectId);

      if (!loadedProject) {
        setPhase("error");
        setMessage("선택한 저장본을 찾지 못했습니다.");
        return;
      }

      startTransition(() => {
        const restoredVariant = getCandidateVariant(
          loadedProject.snapshot.analysis,
          loadedProject.snapshot.activeCandidateStrategy,
        );

        setSelectedFile(loadedProject.audioFile);
        setAnalysis(loadedProject.snapshot.analysis);
        setActiveCandidateStrategy(loadedProject.snapshot.activeCandidateStrategy);
        setSelectedEventId(
          loadedProject.snapshot.selectedEventId &&
            restoredVariant.candidateEvents.some((event) => event.id === loadedProject.snapshot.selectedEventId)
            ? loadedProject.snapshot.selectedEventId
            : restoredVariant.candidateEvents[0]?.id ?? null,
        );
        setReviewStates(mergeReviewStates(loadedProject.snapshot.analysis, loadedProject.snapshot.reviewStates));
        setActiveTimingRoles(normalizeTimingRoleSelection(loadedProject.snapshot.activeTimingRoles));
        setPhase("success");
        setMessage(
          `${loadedProject.summary.title} 저장본을 복원했습니다. ${
            loadedProject.audioFile ? `${loadedProject.audioFile.name} 음원도 함께 불러왔습니다.` : "이 저장본에는 음원이 포함되어 있지 않습니다."
          }`,
        );
      });
    } catch (error) {
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "저장본을 복원하지 못했습니다.");
    }
  }

  async function handleDeleteProject(projectId: string) {
    try {
      await deleteProjectRecord(projectId);
      await refreshSavedProjects();
      setPhase("success");
      setMessage("선택한 저장본을 삭제했습니다.");
    } catch (error) {
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "저장본을 삭제하지 못했습니다.");
    }
  }

  function handleExportProject() {
    const snapshot = buildProjectSnapshot({
      analysis,
      reviewStates,
      activeTimingRoles,
      activeCandidateStrategy,
      selectedEventId,
    });

    downloadJsonFile(getProjectSnapshotFilename(analysis), {
      ...snapshot,
      exportedAt: new Date().toISOString(),
      hasEmbeddedAudio: false,
      audioFileName: selectedFile?.name ?? analysis.audioFileName,
    });
    setPhase("success");
    setMessage(`${analysis.songName} 프로젝트 JSON을 내보냈습니다. 오디오 데이터는 포함하지 않았습니다.`);
  }

  function handleExportResult() {
    const resultExport = buildResultExport({
      analysis,
      reviewStates,
      activeTimingRoles,
      candidateStrategy: activeCandidateStrategy,
    });

    if (resultExport.selectedEventCount === 0) {
      setPhase("error");
      setMessage("채용으로 분류한 이벤트가 아직 없습니다. 하나 이상 채용한 뒤 다시 내보내 주세요.");
      return;
    }

    downloadJsonFile(getResultExportFilename(analysis, activeCandidateStrategy), resultExport);
    setPhase("success");
    setMessage(
      `${activeVariant.label} 기준에서 채용한 이벤트 ${resultExport.selectedEventCount}개를 JSON으로 내보냈습니다.`,
    );
  }

  return (
    <section className="panel workbench">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Analyzer</p>
          <h2>오디오 업로드</h2>
        </div>
        <span className={`status-pill ${phase}`}>{isRendering ? "반영 중" : getPhaseLabel(phase)}</span>
      </div>

      <form className="upload-form" onSubmit={handleSubmit}>
        <label className="file-drop">
          <input accept=".wav,.mp3,audio/wav,audio/mpeg" onChange={handleFileChange} type="file" />
          <strong>{selectedFile ? selectedFile.name : "분석할 오디오 파일 선택"}</strong>
          <span className="support-copy">
            <span>지원 형식: {supportedExtensions.join(", ")}</span>
            <span>로그인 없음</span>
            <span>업로드 제한 없음</span>
          </span>
        </label>

        <div className="action-row">
          <button className="primary-button" disabled={!selectedFile || phase === "uploading"} type="submit">
            {phase === "uploading" ? "분석 중..." : "분석 실행"}
          </button>
        </div>
      </form>

      <p aria-live="polite" className="helper-text">
        {message}
      </p>

      <section className="comparison-panel">
        <div className="subpanel-header">
          <div>
            <p className="eyebrow">Candidate Compare</p>
            <h3>후보 추출 방식 비교</h3>
          </div>
          <div className="timeline-summary">
            <span>현재 기준: {activeVariant.label}</span>
          </div>
        </div>

        <div className="strategy-toggle-grid">
          {candidateStrategyOrder.map((strategy) => {
            const variant = getCandidateVariant(analysis, strategy);
            const isActive = strategy === activeCandidateStrategy;
            const delta = variant.candidateEvents.length - getCandidateVariant(analysis, "global").candidateEvents.length;

            return (
              <button
                key={strategy}
                className={`strategy-card ${isActive ? "active" : ""}`}
                onClick={() => handleCandidateStrategyChange(strategy)}
                type="button"
              >
                <strong>{variant.label}</strong>
                <span>{variant.candidateEvents.length}개 후보</span>
                <p>{variant.description}</p>
                {strategy === "section4bar" ? (
                  <small>{delta >= 0 ? `전곡 기준보다 +${delta}개` : `전곡 기준보다 ${delta}개`}</small>
                ) : (
                  <small>기본 비교 기준</small>
                )}
              </button>
            );
          })}
        </div>
      </section>

      <div className="project-actions">
        <div className="action-row">
          <button className="secondary-button" onClick={() => void handleSaveProject()} type="button">
            현재 상태 저장
          </button>
          <button className="ghost-button" onClick={handleExportProject} type="button">
            프로젝트 내보내기
          </button>
          <button className="ghost-button" onClick={handleExportResult} type="button">
            현재 기준 내보내기
          </button>
        </div>
        <p className="project-status">
          저장본 {savedProjects.length}개, 현재 기준 후보 {activeAnalysis.candidateEvents.length}개, 채용 {keptCount}개
        </p>
      </div>

      <section className="saved-projects">
        <div className="subpanel-header">
          <div>
            <p className="eyebrow">Saved Projects</p>
            <h3>저장본 목록</h3>
          </div>
          <div className="timeline-summary">
            <span>{savedProjects.length}개 저장본</span>
          </div>
        </div>

        {savedProjects.length === 0 ? (
          <p className="helper-text">아직 저장한 작업 상태가 없습니다. 분석 결과를 검토한 뒤 저장해 두세요.</p>
        ) : (
          <div className="saved-project-list">
            {savedProjects.map((project) => (
              <article className="saved-project-item" key={project.id}>
                <div className="saved-project-copy">
                  <strong>{project.title}</strong>
                  <div className="saved-project-meta">
                    <span>{formatSavedAt(project.savedAt)}</span>
                    <span>{project.hasAudio ? `음원 포함: ${project.audioFileName}` : "음원 미포함"}</span>
                    <span>복원 기준 {project.activeCandidateStrategy === "section4bar" ? "4마디 기준" : "전곡 기준"}</span>
                    <span>후보 이벤트 {project.candidateEventCount}개</span>
                    <span>채용 {project.keptEventCount}개</span>
                  </div>
                </div>
                <div className="saved-project-buttons">
                  <button className="secondary-button" onClick={() => void handleRestoreProject(project.id)} type="button">
                    복원
                  </button>
                  <button className="ghost-button" onClick={() => void handleDeleteProject(project.id)} type="button">
                    삭제
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <div className="metrics-grid">
        <div className="metric-card">
          <span className="metric-label">BPM</span>
          <strong className="metric-value">{activeAnalysis.globalBpm.toFixed(2)}</strong>
        </div>
        <div className="metric-card">
          <span className="metric-label">Offset</span>
          <strong className="metric-value">{activeAnalysis.offsetSec.toFixed(3)}s</strong>
        </div>
        <div className="metric-card">
          <span className="metric-label">Song Length</span>
          <strong className="metric-value">{activeAnalysis.songLengthSec.toFixed(2)}s</strong>
        </div>
        <div className="metric-card">
          <span className="metric-label">Candidate Events</span>
          <strong className="metric-value">{strategyCounts[activeVariant.strategy] ?? activeAnalysis.candidateEvents.length}</strong>
        </div>
      </div>

      <AnalysisTimeline
        activeTimingRoles={activeTimingRoles}
        analysis={activeAnalysis}
        audioFile={selectedFile}
        onSelectEvent={setSelectedEventId}
        reviewStates={reviewStates}
        selectedEventId={selectedEventId}
      />

      <CandidateEventsPanel
        activeTimingRoles={activeTimingRoles}
        analysis={activeAnalysis}
        onReviewChange={handleReviewChange}
        onSelectAllTimingRoles={handleSelectAllTimingRoles}
        onSelectEvent={setSelectedEventId}
        onToggleTimingRole={handleTimingRoleToggle}
        reviewStates={reviewStates}
        selectedEventId={selectedEventId}
      />
    </section>
  );
}
