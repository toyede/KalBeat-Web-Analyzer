"use client";

import { useDeferredValue, useEffect, useState, useTransition, type ChangeEvent, type FormEvent } from "react";

import { analyzeAudio, supportedExtensions, validateAudioFile } from "@/lib/api";
import { timingRoleOrder } from "@/lib/candidate-event-meta";
import { sampleAnalysis } from "@/lib/sample-analysis";
import type { AnalysisResponse, CandidateReviewState, CandidateTimingRole } from "@/lib/types";

import { AnalysisTimeline } from "./analysis-timeline";
import { CandidateEventsPanel } from "./candidate-events-panel";

type Phase = "idle" | "uploading" | "success" | "error";
type TimingRoleSelection = Record<CandidateTimingRole, boolean>;

const defaultMessage =
  "샘플 결과가 먼저 보입니다. 실제 파일을 업로드하면 BPM, offset, 길이와 후보 이벤트가 새로 계산됩니다.";

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

function createInitialReviewState(analysis: AnalysisResponse) {
  return Object.fromEntries(
    analysis.candidateEvents.map((event) => [event.id, "unreviewed" as CandidateReviewState]),
  );
}

function createTimingRoleSelection(nextValue = true): TimingRoleSelection {
  return Object.fromEntries(
    timingRoleOrder.map((role) => [role, nextValue]),
  ) as TimingRoleSelection;
}

export function UploadWorkbench() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResponse>(sampleAnalysis);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(
    sampleAnalysis.candidateEvents[0]?.id ?? null,
  );
  const [reviewStates, setReviewStates] = useState<Record<string, CandidateReviewState>>(
    createInitialReviewState(sampleAnalysis),
  );
  const [activeTimingRoles, setActiveTimingRoles] = useState<TimingRoleSelection>(createTimingRoleSelection(true));
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState(defaultMessage);
  const [isRendering, startTransition] = useTransition();
  const deferredAnalysis = useDeferredValue(analysis);

  useEffect(() => {
    setReviewStates((current) => {
      const next = createInitialReviewState(deferredAnalysis);

      for (const event of deferredAnalysis.candidateEvents) {
        next[event.id] = current[event.id] ?? "unreviewed";
      }

      const currentKeys = Object.keys(current);
      const nextKeys = Object.keys(next);

      if (
        currentKeys.length === nextKeys.length &&
        nextKeys.every((key) => current[key] === next[key])
      ) {
        return current;
      }

      return next;
    });

    if (!deferredAnalysis.candidateEvents.some((event) => event.id === selectedEventId)) {
      setSelectedEventId(deferredAnalysis.candidateEvents[0]?.id ?? null);
    }
  }, [deferredAnalysis, selectedEventId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedFile) {
      setPhase("error");
      setMessage("먼저 분석할 음원 파일을 선택해 주세요.");
      return;
    }

    try {
      validateAudioFile(selectedFile);
      setPhase("uploading");
      setMessage(`${selectedFile.name} 분석 요청을 보내는 중입니다.`);

      const result = await analyzeAudio(selectedFile);

      startTransition(() => {
        setAnalysis(result);
        setSelectedEventId(result.candidateEvents[0]?.id ?? null);
        setReviewStates(createInitialReviewState(result));
        setPhase("success");
        setMessage(
          `${result.audioFileName} 분석이 완료되었습니다. 후보 이벤트 ${result.candidateEvents.length}개를 검토해 보세요.`,
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
      setMessage(`${file.name} 준비 완료. 분석 실행 버튼을 누르면 결과를 계산합니다.`);
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

  return (
    <section className="panel workbench">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Analyzer</p>
          <h2>음원 업로드</h2>
        </div>
        <span className={`status-pill ${phase}`}>{isRendering ? "반영 중" : getPhaseLabel(phase)}</span>
      </div>

      <form className="upload-form" onSubmit={handleSubmit}>
        <label className="file-drop">
          <input accept=".wav,.mp3,audio/wav,audio/mpeg" onChange={handleFileChange} type="file" />
          <strong>{selectedFile ? selectedFile.name : "분석할 음원 파일 선택"}</strong>
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

      <div className="metrics-grid">
        <div className="metric-card">
          <span className="metric-label">BPM</span>
          <strong className="metric-value">{deferredAnalysis.globalBpm.toFixed(2)}</strong>
        </div>
        <div className="metric-card">
          <span className="metric-label">Offset</span>
          <strong className="metric-value">{deferredAnalysis.offsetSec.toFixed(3)}s</strong>
        </div>
        <div className="metric-card">
          <span className="metric-label">Song Length</span>
          <strong className="metric-value">{deferredAnalysis.songLengthSec.toFixed(2)}s</strong>
        </div>
        <div className="metric-card">
          <span className="metric-label">Candidate Events</span>
          <strong className="metric-value">{deferredAnalysis.candidateEvents.length}</strong>
        </div>
      </div>

      <AnalysisTimeline
        activeTimingRoles={activeTimingRoles}
        analysis={deferredAnalysis}
        audioFile={selectedFile}
        onSelectEvent={setSelectedEventId}
        reviewStates={reviewStates}
        selectedEventId={selectedEventId}
      />

      <CandidateEventsPanel
        activeTimingRoles={activeTimingRoles}
        analysis={deferredAnalysis}
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
