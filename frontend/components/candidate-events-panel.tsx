"use client";

import { useMemo } from "react";

import { candidateSceneFamilyMeta, candidateSceneFamilyOrder, candidateSceneTypeMeta, candidateSceneTypeOrder } from "@/lib/candidate-scene-meta";
import { timingRoleMeta } from "@/lib/candidate-event-meta";
import type { AnalysisResponse, CandidateEvent, CandidateReviewState, CandidateVariant } from "@/lib/types";

type CandidateEventsPanelProps = {
  analysis: AnalysisResponse;
  variant: CandidateVariant;
  selectedEventId: string | null;
  reviewStates: Record<string, CandidateReviewState>;
  onReviewChange: (eventId: string, nextState: CandidateReviewState) => void;
  onSelectEvent: (eventId: string) => void;
};

type EventGroup = {
  id: string;
  family: "reactive" | "pattern";
  sceneType: CandidateEvent["sceneType"];
  title: string;
  description: string;
  events: CandidateEvent[];
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

function buildEventGroups(variant: CandidateVariant): EventGroup[] {
  const allowedFamilies =
    variant.strategy === "reactive"
      ? ["reactive"]
      : variant.strategy === "pattern"
        ? ["pattern"]
        : candidateSceneFamilyOrder;

  return candidateSceneTypeOrder.flatMap((sceneType) => {
    const meta = candidateSceneTypeMeta[sceneType];

    if (!allowedFamilies.includes(meta.family)) {
      return [];
    }

    const events = variant.candidateEvents.filter((event) => event.sceneType === sceneType);

    if (events.length === 0) {
      return [];
    }

    return [
      {
        id: sceneType,
        family: meta.family,
        sceneType,
        title: meta.label,
        description: meta.description,
        events,
      },
    ];
  });
}

export function CandidateEventsPanel({
  analysis,
  variant,
  selectedEventId,
  reviewStates,
  onReviewChange,
  onSelectEvent,
}: CandidateEventsPanelProps) {
  const eventGroups = useMemo(() => buildEventGroups(variant), [variant]);
  let keepCount = 0;
  let skipCount = 0;

  for (const event of variant.candidateEvents) {
    const reviewState = reviewStates[event.id] ?? "unreviewed";

    if (reviewState === "keep") {
      keepCount += 1;
    }

    if (reviewState === "skip") {
      skipCount += 1;
    }
  }

  return (
    <section className="panel candidate-panel">
      <div className="subpanel-header">
        <div>
          <p className="eyebrow">Event Review</p>
          <h3>씬 후보 목록</h3>
        </div>
        <div className="timeline-summary">
          <span>총 {variant.candidateEvents.length}개</span>
          <span>채용 {keepCount}개</span>
          <span>제외 {skipCount}개</span>
        </div>
      </div>

      <p className="helper-text">
        이제 후보 목록은 박자 역할이 아니라 전투 씬 기준으로 묶여 있습니다. 반응형은 `헤비 어택`, `퀵 어택`으로,
        패턴형은 `1마디 콤보`, `2마디 콤보`로 나뉩니다.
      </p>

      {variant.patternSegments.length > 0 ? (
        <section className="event-group active">
          <div className="event-group-header">
            <div>
              <h4>패턴 제시 구간</h4>
              <p>패턴형 후보는 제시 구간과 따라치기 구간을 같이 보여 줍니다.</p>
            </div>
            <span>{variant.patternSegments.length}개</span>
          </div>

          <div className="group-summary-grid">
            {variant.patternSegments.map((segment) => {
              const sceneMeta = candidateSceneTypeMeta[segment.sceneType];

              return (
                <article className="group-summary-card active" key={segment.id}>
                  <strong>{sceneMeta.label}</strong>
                  <span>
                    제시 Bar {segment.cueStartBar}-{segment.cueEndBar}
                  </span>
                  <span>
                    입력 Bar {segment.responseStartBar}-{segment.responseEndBar}
                  </span>
                  <span>제시 노트 {segment.cueEvents.length}개</span>
                  <span>입력 노트 {segment.responseEventIds.length}개</span>
                  <span>score {Math.round(segment.score * 100)}%</span>
                  <span>similarity {Math.round(segment.similarity * 100)}%</span>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {analysis.candidateEvents.length === 0 ? (
        <p className="helper-text">현재 분석 결과에는 표시할 후보 이벤트가 없습니다.</p>
      ) : (
        <div className="event-groups">
          {candidateSceneFamilyOrder.map((family) => {
            const familyGroups = eventGroups.filter((group) => group.family === family);

            if (familyGroups.length === 0) {
              return null;
            }

            const familyMeta = candidateSceneFamilyMeta[family];

            return (
              <section className="event-group active" key={family}>
                <div className="event-group-header">
                  <div>
                    <h4>{familyMeta.label}</h4>
                    <p>{familyMeta.description}</p>
                  </div>
                  <span>{familyGroups.reduce((count, group) => count + group.events.length, 0)}개</span>
                </div>

                <div className="event-groups">
                  {familyGroups.map((group) => (
                    <section className="event-group active" key={group.id}>
                      <div className="event-group-header">
                        <div>
                          <h4>{group.title}</h4>
                          <p>{group.description}</p>
                        </div>
                        <span>{group.events.length}개</span>
                      </div>

                      <div className="candidate-list">
                        {group.events.map((event) => {
                          const timingMeta = timingRoleMeta[event.timingRole];
                          const reviewState = reviewStates[event.id] ?? "unreviewed";

                          return (
                            <article key={event.id} className={`candidate-row ${event.id === selectedEventId ? "selected" : ""}`}>
                              <button className="candidate-select" onClick={() => onSelectEvent(event.id)} type="button">
                                <div className="candidate-row-top">
                                  <strong>
                                    {candidateSceneTypeMeta[event.sceneType].label} · Beat {event.beatIndex} · {event.timeSec.toFixed(3)}s
                                  </strong>
                                  <span className={`event-kind ${event.kind}`}>{candidateSceneTypeMeta[event.sceneType].shortLabel}</span>
                                </div>
                                <div className="candidate-row-meta">
                                  <span>
                                    Bar {event.barIndex}.{event.beatInBar}
                                  </span>
                                  <span>{timingMeta.label}</span>
                                  <span>{formatSlotLabel(event)}</span>
                                  <span>confidence {Math.round(event.confidence * 100)}%</span>
                                  <span>strength {Math.round(event.strength * 100)}%</span>
                                </div>
                                <p>{event.reason}</p>
                              </button>

                              <label className="candidate-review">
                                <span>분류</span>
                                <select
                                  onChange={(eventTarget) => onReviewChange(event.id, eventTarget.target.value as CandidateReviewState)}
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
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}
