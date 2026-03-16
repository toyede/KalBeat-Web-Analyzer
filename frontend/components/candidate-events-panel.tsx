"use client";

import { useMemo } from "react";

import { timingRoleMeta, timingRoleOrder } from "@/lib/candidate-event-meta";
import type {
  AnalysisResponse,
  CandidateEvent,
  CandidateReviewState,
  CandidateTimingRole,
  TimingRoleSelection,
} from "@/lib/types";

type CandidateEventsPanelProps = {
  activeTimingRoles: TimingRoleSelection;
  analysis: AnalysisResponse;
  selectedEventId: string | null;
  reviewStates: Record<string, CandidateReviewState>;
  onReviewChange: (eventId: string, nextState: CandidateReviewState) => void;
  onSelectAllTimingRoles: (nextValue: boolean) => void;
  onSelectEvent: (eventId: string) => void;
  onToggleTimingRole: (role: CandidateTimingRole) => void;
};

const reviewLabels: Record<CandidateReviewState, string> = {
  unreviewed: "검토 전",
  keep: "채용",
  skip: "제외",
};

function formatSlotLabel(event: CandidateEvent) {
  if (event.gridDivision === 0) {
    return "free onset";
  }

  return `slot ${event.slotInBeat}/${event.gridDivision}`;
}

export function CandidateEventsPanel({
  activeTimingRoles,
  analysis,
  selectedEventId,
  reviewStates,
  onReviewChange,
  onSelectAllTimingRoles,
  onSelectEvent,
  onToggleTimingRole,
}: CandidateEventsPanelProps) {
  const eventsByRole = useMemo(
    () =>
      Object.fromEntries(
        timingRoleOrder.map((role) => [role, analysis.candidateEvents.filter((event) => event.timingRole === role)]),
      ) as Record<CandidateTimingRole, CandidateEvent[]>,
    [analysis.candidateEvents],
  );
  let keepCount = 0;
  let skipCount = 0;

  for (const event of analysis.candidateEvents) {
    const reviewState = reviewStates[event.id] ?? "unreviewed";

    if (reviewState === "keep") {
      keepCount += 1;
    }

    if (reviewState === "skip") {
      skipCount += 1;
    }
  }

  const activeGroupCount = timingRoleOrder.filter((role) => activeTimingRoles[role]).length;

  return (
    <section className="panel candidate-panel">
      <div className="subpanel-header">
        <div>
          <p className="eyebrow">Event Review</p>
          <h3>분류된 후보 이벤트</h3>
        </div>
        <div className="timeline-summary">
          <span>총 {analysis.candidateEvents.length}개</span>
          <span>채용 {keepCount}개</span>
          <span>제외 {skipCount}개</span>
        </div>
      </div>

      <p className="helper-text">
        위 그룹 카드에서 재생 대상 그룹만 빠르게 고르고, 아래 상세 목록에서 각 이벤트의 시점과 분류 상태를 검토할 수 있습니다.
      </p>

      <div className="group-control-bar">
        <div className="group-control-summary">재생 대상 그룹 {activeGroupCount} / {timingRoleOrder.length}</div>
        <div className="group-control-actions">
          <button className="ghost-button" onClick={() => onSelectAllTimingRoles(true)} type="button">
            전체 선택
          </button>
          <button className="ghost-button" onClick={() => onSelectAllTimingRoles(false)} type="button">
            전체 해제
          </button>
        </div>
      </div>

      <div className="group-summary-grid">
        {timingRoleOrder.map((role) => {
          const meta = timingRoleMeta[role];
          const count = eventsByRole[role].length;

          if (count === 0) {
            return null;
          }

          return (
            <button
              key={role}
              className={`group-summary-card ${activeTimingRoles[role] ? "active" : "inactive"}`}
              onClick={() => onToggleTimingRole(role)}
              type="button"
            >
              <strong>{meta.label}</strong>
              <span>{count}개 이벤트</span>
            </button>
          );
        })}
      </div>

      {analysis.candidateEvents.length === 0 ? (
        <p className="helper-text">현재 분석 결과에는 표시할 후보 이벤트가 없습니다.</p>
      ) : (
        <div className="event-groups">
          {timingRoleOrder.map((role) => {
            const groupEvents = eventsByRole[role];

            if (groupEvents.length === 0) {
              return null;
            }

            const meta = timingRoleMeta[role];

            return (
              <section className={`event-group ${activeTimingRoles[role] ? "active" : "muted"}`} key={role}>
                <div className="event-group-header">
                  <div>
                    <h4>{meta.label}</h4>
                    <p>{meta.description}</p>
                  </div>
                  <span>{groupEvents.length}개</span>
                </div>

                <div className="candidate-list">
                  {groupEvents.map((event) => {
                    const reviewState = reviewStates[event.id] ?? "unreviewed";

                    return (
                      <article
                        key={event.id}
                        className={`candidate-row ${event.id === selectedEventId ? "selected" : ""}`}
                      >
                        <button className="candidate-select" onClick={() => onSelectEvent(event.id)} type="button">
                          <div className="candidate-row-top">
                            <strong>
                              Beat {event.beatIndex} · {event.timeSec.toFixed(3)}s
                            </strong>
                            <span className={`event-kind ${event.kind}`}>{meta.shortLabel}</span>
                          </div>
                          <div className="candidate-row-meta">
                            <span>
                              Bar {event.barIndex}.{event.beatInBar}
                            </span>
                            <span>{formatSlotLabel(event)}</span>
                            <span>confidence {Math.round(event.confidence * 100)}%</span>
                            <span>strength {Math.round(event.strength * 100)}%</span>
                          </div>
                          <p>{event.reason}</p>
                        </button>

                        <label className="candidate-review">
                          <span>분류</span>
                          <select
                            onChange={(eventTarget) =>
                              onReviewChange(event.id, eventTarget.target.value as CandidateReviewState)
                            }
                            value={reviewState}
                          >
                            {Object.entries(reviewLabels).map(([value, label]) => (
                              <option key={value} value={value}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </label>
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}
