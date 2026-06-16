export type CandidateEventKind = "strong" | "steady" | "light";
export type CandidateReviewState = "unreviewed" | "keep" | "skip";
export type CandidateTimingRole = "pulse" | "offbeat" | "subdivision" | "thirtySecond" | "triplet" | "freeAccent";
export type CandidateStrategy = "reactive" | "pattern" | "hybrid";
export type CandidateSceneFamily = "reactive" | "pattern";
export type CandidateSceneType =
  | "prep_1_attack"
  | "prep_2_attack"
  | "prep_3_attack"
  | "combo_pattern_1bar"
  | "combo_pattern_2bar";
export type TimingRoleSelection = Record<CandidateTimingRole, boolean>;

export type CandidateEvent = {
  id: string;
  timeSec: number;
  beatIndex: number;
  barIndex: number;
  beatInBar: number;
  slotInBeat: number;
  gridDivision: 0 | 1 | 2 | 3 | 4 | 8;
  timingRole: CandidateTimingRole;
  confidence: number;
  strength: number;
  kind: CandidateEventKind;
  sceneFamily: CandidateSceneFamily;
  sceneType: CandidateSceneType;
  sceneGroupId: string;
  cueTimesSec: number[];
  reason: string;
};

export type PatternSegment = {
  id: string;
  bars: 1 | 2;
  sceneType: "combo_pattern_1bar" | "combo_pattern_2bar";
  cueStartBar: number;
  cueEndBar: number;
  responseStartBar: number;
  responseEndBar: number;
  cueStartSec: number;
  cueEndSec: number;
  responseStartSec: number;
  responseEndSec: number;
  score: number;
  similarity: number;
  cueEvents: CandidateEvent[];
  responseEventIds: string[];
};

export type OffsetCandidateSource = "auto" | "first_onset" | "strong_onset" | "grid_phase" | "beat_tracker";

export type OffsetCandidate = {
  source: OffsetCandidateSource;
  label: string;
  offsetSec: number;
  reason: string;
};

export type BpmCandidateSource = "precise_autocorr" | "pipeline" | "ioi";

export type BpmCandidate = {
  source: BpmCandidateSource;
  label: string;
  bpm: number;
  reason: string;
};

export type AnalysisResponse = {
  schemaVersion: number;
  songId: string;
  songName: string;
  audioFileName: string;
  analysisVersion: string;
  globalBpm: number;
  offsetSec: number;
  songLengthSec: number;
  defaultCandidateStrategy: CandidateStrategy;
  bpmCandidates?: BpmCandidate[];
  offsetCandidates?: OffsetCandidate[];
  candidateEvents: CandidateEvent[];
  candidateVariants: CandidateVariant[];
};

export type CandidateVariant = {
  strategy: CandidateStrategy;
  label: string;
  description: string;
  candidateEvents: CandidateEvent[];
  patternSegments: PatternSegment[];
};

export type ProjectSnapshot = {
  snapshotVersion: number;
  savedAt: string;
  analysis: AnalysisResponse;
  reviewStates: Record<string, CandidateReviewState>;
  activeTimingRoles: TimingRoleSelection;
  activeCandidateStrategy: CandidateStrategy;
  selectedEventId: string | null;
};

export type SavedProjectSummary = {
  id: string;
  title: string;
  savedAt: string;
  audioFileName: string | null;
  hasAudio: boolean;
  candidateEventCount: number;
  keptEventCount: number;
  activeCandidateStrategy: CandidateStrategy;
};

export type ResultExportLineMode = "splitLines" | "mergedLine";

export type ResultExportLine = {
  id: string;
  label: string;
  sceneType: CandidateSceneType | "merged";
  eventCount: number;
  events: CandidateEvent[];
};

export type ResultExport = {
  schemaVersion: number;
  exportedAt: string;
  songId: string;
  songName: string;
  audioFileName: string;
  globalBpm: number;
  offsetSec: number;
  songLengthSec: number;
  candidateStrategy: CandidateStrategy;
  activeTimingRoles: CandidateTimingRole[];
  lineMode: ResultExportLineMode;
  selectedLineCount: number;
  sourceSelectedEventCount: number;
  overlapRemovedEventCount: number;
  selectedEventCount: number;
  selectedTimingRoleCounts: Record<CandidateTimingRole, number>;
  selectedLines: ResultExportLine[];
  selectedEvents: CandidateEvent[];
};
