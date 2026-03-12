export type CandidateEventKind = "strong" | "steady" | "light";
export type CandidateReviewState = "unreviewed" | "keep" | "skip";
export type CandidateTimingRole = "downbeat" | "beat" | "offbeat" | "subdivision";

export type CandidateEvent = {
  id: string;
  timeSec: number;
  beatIndex: number;
  barIndex: number;
  beatInBar: number;
  slotInBeat: number;
  gridDivision: 1 | 2 | 4;
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
  candidateEvents: CandidateEvent[];
};
