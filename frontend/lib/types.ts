export type CandidateEventKind = "strong" | "steady" | "light";
export type CandidateReviewState = "unreviewed" | "keep" | "skip";
export type CandidateTimingRole = "pulse" | "offbeat" | "subdivision" | "thirtySecond" | "triplet" | "freeAccent";
export type CandidateStrategy = "global" | "section4bar";
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
  candidateEvents: CandidateEvent[];
  candidateVariants: CandidateVariant[];
};

export type CandidateVariant = {
  strategy: CandidateStrategy;
  label: string;
  description: string;
  candidateEvents: CandidateEvent[];
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
  selectedEventCount: number;
  selectedTimingRoleCounts: Record<CandidateTimingRole, number>;
  selectedEvents: CandidateEvent[];
};
