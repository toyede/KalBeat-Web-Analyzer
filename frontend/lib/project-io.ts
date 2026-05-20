import { candidateStrategyOrder, getCandidateVariant } from "@/lib/candidate-strategy";
import { candidateSceneTypeMeta, candidateSceneTypeOrder } from "@/lib/candidate-scene-meta";
import { timingRoleOrder } from "@/lib/candidate-event-meta";
import type {
  AnalysisResponse,
  CandidateEvent,
  CandidateReviewState,
  CandidateSceneType,
  CandidateStrategy,
  CandidateTimingRole,
  CandidateVariant,
  PatternSegment,
  ProjectSnapshot,
  ResultExport,
  ResultExportLine,
  ResultExportLineMode,
  SavedProjectSummary,
  TimingRoleSelection,
} from "@/lib/types";

const PROJECT_DB_NAME = "kalbeat-web-analyzer";
const PROJECT_STORE_NAME = "projects";
const PROJECT_DB_VERSION = 1;
const PROJECT_SNAPSHOT_VERSION = 2;
const RESULT_EXPORT_VERSION = 2;
const MERGED_LINE_TIME_TOLERANCE_SEC = 0.02;
const VALID_GRID_DIVISIONS = new Set([0, 1, 2, 3, 4, 8]);

type StoredProjectRecord = {
  id: string;
  title: string;
  savedAt: string;
  snapshot: ProjectSnapshot;
  audioBlob: Blob | null;
  audioFileName: string | null;
  audioFileType: string | null;
};

export type LoadedProjectRecord = {
  summary: SavedProjectSummary;
  snapshot: ProjectSnapshot;
  audioFile: File | null;
};

function sanitizeFilenamePart(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized || "analysis";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function normalizeTimingRole(value: unknown): CandidateTimingRole | null {
  if (
    value === "pulse" ||
    value === "offbeat" ||
    value === "subdivision" ||
    value === "thirtySecond" ||
    value === "triplet" ||
    value === "freeAccent"
  ) {
    return value;
  }

  if (value === "downbeat" || value === "beat") {
    return "pulse";
  }

  return null;
}

function normalizeTimingRoleSelection(value: unknown): TimingRoleSelection | null {
  if (!isRecord(value)) {
    return null;
  }

  const next = Object.fromEntries(timingRoleOrder.map((role) => [role, true])) as TimingRoleSelection;
  const legacyDownbeat = typeof value.downbeat === "boolean" ? value.downbeat : null;
  const legacyBeat = typeof value.beat === "boolean" ? value.beat : null;
  const hasLegacyPulse = legacyDownbeat !== null || legacyBeat !== null;

  next.pulse =
    typeof value.pulse === "boolean"
      ? value.pulse
      : hasLegacyPulse
        ? Boolean(legacyDownbeat) || Boolean(legacyBeat)
        : true;

  for (const role of timingRoleOrder) {
    if (role === "pulse") {
      continue;
    }

    if (typeof value[role] === "boolean") {
      next[role] = value[role];
    }
  }

  return next;
}

function normalizeCandidateStrategy(value: unknown): CandidateStrategy {
  if (value === "reactive" || value === "pattern" || value === "hybrid") {
    return value;
  }

  if (value === "global") {
    return "reactive";
  }

  if (value === "section4bar") {
    return "hybrid";
  }

  return "hybrid";
}

function normalizeSceneType(value: unknown): CandidateSceneType | null {
  if (value === "heavy_attack") {
    return "prep_1_attack";
  }

  if (value === "quick_attack") {
    return "prep_2_attack";
  }

  if (
    value === "prep_1_attack" ||
    value === "prep_2_attack" ||
    value === "prep_3_attack" ||
    value === "combo_pattern_1bar" ||
    value === "combo_pattern_2bar"
  ) {
    return value;
  }

  return null;
}

function toNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeCandidateEvent(value: unknown): CandidateEvent | null {
  if (!isRecord(value)) {
    return null;
  }

  const timingRole = normalizeTimingRole(value.timingRole);
  const timeSec = toNumber(value.timeSec);
  const beatIndex = toNumber(value.beatIndex);
  const barIndex = toNumber(value.barIndex);
  const beatInBar = toNumber(value.beatInBar);
  const slotInBeat = toNumber(value.slotInBeat);
  const gridDivision = toNumber(value.gridDivision);
  const confidence = toNumber(value.confidence);
  const strength = toNumber(value.strength);
  const sceneType = normalizeSceneType(value.sceneType);

  if (
    typeof value.id !== "string" ||
    !timingRole ||
    timeSec === null ||
    beatIndex === null ||
    barIndex === null ||
    beatInBar === null ||
    slotInBeat === null ||
    gridDivision === null ||
    confidence === null ||
    strength === null ||
    typeof value.kind !== "string" ||
    typeof value.reason !== "string"
  ) {
    return null;
  }

  const normalizedGridDivision =
    timingRole === "freeAccent" ? 0 : VALID_GRID_DIVISIONS.has(gridDivision) ? gridDivision : 0;

  return {
    id: value.id,
    timeSec,
    beatIndex,
    barIndex,
    beatInBar,
    slotInBeat: timingRole === "freeAccent" ? 0 : slotInBeat,
    gridDivision: normalizedGridDivision as CandidateEvent["gridDivision"],
    timingRole,
    confidence,
    strength,
    kind: value.kind as CandidateEvent["kind"],
    sceneFamily:
      typeof value.sceneFamily === "string" && (value.sceneFamily === "reactive" || value.sceneFamily === "pattern")
        ? value.sceneFamily
        : candidateSceneTypeMeta[sceneType ?? "prep_1_attack"].family,
    sceneType:
      sceneType ??
      (typeof value.sceneFamily === "string" && value.sceneFamily === "pattern" ? "combo_pattern_1bar" : "prep_1_attack"),
    sceneGroupId: typeof value.sceneGroupId === "string" && value.sceneGroupId.trim() ? value.sceneGroupId : value.id,
    cueTimesSec: Array.isArray(value.cueTimesSec)
      ? value.cueTimesSec.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
      : [],
    reason: value.reason,
  };
}

function normalizePatternSegment(value: unknown): PatternSegment | null {
  if (!isRecord(value) || !Array.isArray(value.cueEvents) || !Array.isArray(value.responseEventIds)) {
    return null;
  }

  const cueEvents = value.cueEvents
    .map((candidate) => normalizeCandidateEvent(candidate))
    .filter((candidate): candidate is CandidateEvent => candidate !== null);

  if (cueEvents.length !== value.cueEvents.length) {
    return null;
  }

  const bars = toNumber(value.bars);
  const sceneType = normalizeSceneType(value.sceneType);
  const normalizedPatternSceneType =
    sceneType === "combo_pattern_1bar" || sceneType === "combo_pattern_2bar"
      ? sceneType
      : bars === 1
        ? "combo_pattern_1bar"
        : "combo_pattern_2bar";
  const cueStartBar = toNumber(value.cueStartBar);
  const cueEndBar = toNumber(value.cueEndBar);
  const responseStartBar = toNumber(value.responseStartBar);
  const responseEndBar = toNumber(value.responseEndBar);
  const cueStartSec = toNumber(value.cueStartSec);
  const cueEndSec = toNumber(value.cueEndSec);
  const responseStartSec = toNumber(value.responseStartSec);
  const responseEndSec = toNumber(value.responseEndSec);
  const score = toNumber(value.score);
  const similarity = toNumber(value.similarity);
  const responseEventIds = value.responseEventIds.filter((item): item is string => typeof item === "string");

  if (
    typeof value.id !== "string" ||
    (bars !== 1 && bars !== 2) ||
    cueStartBar === null ||
    cueEndBar === null ||
    responseStartBar === null ||
    responseEndBar === null ||
    cueStartSec === null ||
    cueEndSec === null ||
    responseStartSec === null ||
    responseEndSec === null ||
    score === null ||
    similarity === null ||
    responseEventIds.length !== value.responseEventIds.length
  ) {
    return null;
  }

  return {
    id: value.id,
    bars,
    sceneType: normalizedPatternSceneType,
    cueStartBar,
    cueEndBar,
    responseStartBar,
    responseEndBar,
    cueStartSec,
    cueEndSec,
    responseStartSec,
    responseEndSec,
    score,
    similarity,
    cueEvents,
    responseEventIds,
  };
}

function normalizeCandidateVariant(value: unknown): CandidateVariant | null {
  if (!isRecord(value) || !Array.isArray(value.candidateEvents)) {
    return null;
  }

  const candidateEvents = value.candidateEvents
    .map((candidate) => normalizeCandidateEvent(candidate))
    .filter((candidate): candidate is CandidateEvent => candidate !== null);

  if (candidateEvents.length !== value.candidateEvents.length) {
    return null;
  }

  return {
    strategy: normalizeCandidateStrategy(value.strategy),
    label: typeof value.label === "string" ? value.label : "후보 방식",
    description: typeof value.description === "string" ? value.description : "",
    candidateEvents,
    patternSegments: [],
  };
}

function normalizeCandidateVariantWithSegments(value: unknown): CandidateVariant | null {
  const baseVariant = normalizeCandidateVariant(value);

  if (!baseVariant || !isRecord(value)) {
    return baseVariant;
  }

  const patternSegments = Array.isArray(value.patternSegments)
    ? value.patternSegments
        .map((segment) => normalizePatternSegment(segment))
        .filter((segment): segment is PatternSegment => segment !== null)
    : [];

  if (Array.isArray(value.patternSegments) && patternSegments.length !== value.patternSegments.length) {
    return null;
  }

  return {
    ...baseVariant,
    patternSegments,
  };
}

function normalizeAnalysisResponse(value: unknown): AnalysisResponse | null {
  if (!isRecord(value) || !Array.isArray(value.candidateEvents)) {
    return null;
  }

  const candidateEvents = value.candidateEvents
    .map((candidate) => normalizeCandidateEvent(candidate))
    .filter((candidate): candidate is CandidateEvent => candidate !== null);

  if (candidateEvents.length !== value.candidateEvents.length) {
    return null;
  }

  const candidateVariants = Array.isArray(value.candidateVariants)
    ? value.candidateVariants
        .map((variant) => normalizeCandidateVariantWithSegments(variant))
        .filter((variant): variant is CandidateVariant => variant !== null)
    : [];
  const defaultCandidateStrategy = normalizeCandidateStrategy(value.defaultCandidateStrategy);
  const normalizedVariants =
    candidateVariants.length > 0
      ? candidateVariants
      : [
          {
            strategy: defaultCandidateStrategy,
            label: "반응형 + 패턴형",
            description: "기존 저장본에서 불러온 기본 후보 세트입니다.",
            candidateEvents,
            patternSegments: [],
          },
        ];
  const defaultVariant =
    normalizedVariants.find((variant) => variant.strategy === defaultCandidateStrategy) ?? normalizedVariants[0];

  return {
    schemaVersion: typeof value.schemaVersion === "number" ? value.schemaVersion : 1,
    songId: typeof value.songId === "string" ? value.songId : "untitled-track",
    songName: typeof value.songName === "string" ? value.songName : "Untitled Track",
    audioFileName: typeof value.audioFileName === "string" ? value.audioFileName : "unknown-audio",
    analysisVersion: typeof value.analysisVersion === "string" ? value.analysisVersion : "",
    globalBpm: toNumber(value.globalBpm) ?? 120,
    offsetSec: toNumber(value.offsetSec) ?? 0,
    songLengthSec: toNumber(value.songLengthSec) ?? 0,
    defaultCandidateStrategy,
    candidateEvents: defaultVariant.candidateEvents,
    candidateVariants: normalizedVariants,
  };
}

function normalizeProjectSnapshot(value: unknown): ProjectSnapshot | null {
  if (!isRecord(value) || !isRecord(value.reviewStates)) {
    return null;
  }

  const analysis = normalizeAnalysisResponse(value.analysis);
  const activeTimingRoles = normalizeTimingRoleSelection(value.activeTimingRoles);

  if (!analysis || !activeTimingRoles) {
    return null;
  }

  return {
    snapshotVersion: typeof value.snapshotVersion === "number" ? value.snapshotVersion : PROJECT_SNAPSHOT_VERSION,
    savedAt: typeof value.savedAt === "string" ? value.savedAt : new Date().toISOString(),
    analysis,
    reviewStates: value.reviewStates as Record<string, CandidateReviewState>,
    activeTimingRoles,
    activeCandidateStrategy: normalizeCandidateStrategy(value.activeCandidateStrategy ?? analysis.defaultCandidateStrategy),
    selectedEventId: value.selectedEventId === null || typeof value.selectedEventId === "string" ? value.selectedEventId : null,
  };
}

function createProjectId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `project-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function ensureIndexedDbSupport() {
  if (typeof indexedDB === "undefined") {
    throw new Error("이 브라우저에서는 로컬 저장본 보관을 지원하지 않습니다.");
  }
}

function openProjectDatabase(): Promise<IDBDatabase> {
  ensureIndexedDbSupport();

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PROJECT_DB_NAME, PROJECT_DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(PROJECT_STORE_NAME)) {
        database.createObjectStore(PROJECT_STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error ?? new Error("저장소를 열지 못했습니다."));
    };
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("저장소 작업에 실패했습니다."));
    transaction.onabort = () => reject(transaction.error ?? new Error("저장소 작업이 중단되었습니다."));
  });
}

function buildProjectSummary(record: StoredProjectRecord): SavedProjectSummary {
  const activeVariant = getCandidateVariant(record.snapshot.analysis, record.snapshot.activeCandidateStrategy);
  const keptEventCount = activeVariant.candidateEvents.filter(
    (event) => record.snapshot.reviewStates[event.id] === "keep",
  ).length;

  return {
    id: record.id,
    title: record.title,
    savedAt: record.savedAt,
    audioFileName: record.audioFileName,
    hasAudio: Boolean(record.audioBlob && record.audioFileName),
    candidateEventCount: activeVariant.candidateEvents.length,
    keptEventCount,
    activeCandidateStrategy: record.snapshot.activeCandidateStrategy,
  };
}

function toStoredRecord(options: {
  snapshot: ProjectSnapshot;
  audioFile: File | null;
  title?: string;
}): StoredProjectRecord {
  const audioFileName = options.audioFile?.name ?? null;
  const title = options.title?.trim() || audioFileName || options.snapshot.analysis.songName || options.snapshot.analysis.songId;

  return {
    id: createProjectId(),
    title,
    savedAt: options.snapshot.savedAt,
    snapshot: options.snapshot,
    audioBlob: options.audioFile ?? null,
    audioFileName,
    audioFileType: options.audioFile?.type ?? null,
  };
}

function toLoadedRecord(record: StoredProjectRecord): LoadedProjectRecord {
  const audioFile =
    record.audioBlob && record.audioFileName
      ? new File([record.audioBlob], record.audioFileName, {
          type: record.audioFileType ?? "application/octet-stream",
          lastModified: new Date(record.savedAt).getTime(),
        })
      : null;

  return {
    summary: buildProjectSummary(record),
    snapshot: record.snapshot,
    audioFile,
  };
}

export function buildProjectSnapshot(options: {
  analysis: AnalysisResponse;
  reviewStates: Record<string, CandidateReviewState>;
  activeTimingRoles: TimingRoleSelection;
  activeCandidateStrategy: CandidateStrategy;
  selectedEventId: string | null;
}): ProjectSnapshot {
  return {
    snapshotVersion: PROJECT_SNAPSHOT_VERSION,
    savedAt: new Date().toISOString(),
    analysis: options.analysis,
    reviewStates: options.reviewStates,
    activeTimingRoles: options.activeTimingRoles,
    activeCandidateStrategy: options.activeCandidateStrategy,
    selectedEventId: options.selectedEventId,
  };
}

export async function saveProjectRecord(options: {
  analysis: AnalysisResponse;
  reviewStates: Record<string, CandidateReviewState>;
  activeTimingRoles: TimingRoleSelection;
  activeCandidateStrategy: CandidateStrategy;
  selectedEventId: string | null;
  audioFile: File | null;
  title?: string;
}) {
  const snapshot = buildProjectSnapshot({
    analysis: options.analysis,
    reviewStates: options.reviewStates,
    activeTimingRoles: options.activeTimingRoles,
    activeCandidateStrategy: options.activeCandidateStrategy,
    selectedEventId: options.selectedEventId,
  });
  const record = toStoredRecord({
    snapshot,
    audioFile: options.audioFile,
    title: options.title,
  });
  const database = await openProjectDatabase();

  try {
    const transaction = database.transaction(PROJECT_STORE_NAME, "readwrite");
    transaction.objectStore(PROJECT_STORE_NAME).put(record);
    await transactionDone(transaction);
  } finally {
    database.close();
  }

  return buildProjectSummary(record);
}

export async function listProjectRecords() {
  const database = await openProjectDatabase();

  try {
    const transaction = database.transaction(PROJECT_STORE_NAME, "readonly");
    const request = transaction.objectStore(PROJECT_STORE_NAME).getAll();
    const records = await new Promise<StoredProjectRecord[]>((resolve, reject) => {
      request.onsuccess = () =>
        resolve(
          (request.result as StoredProjectRecord[]).flatMap((record) => {
            const snapshot = normalizeProjectSnapshot(record.snapshot);
            return snapshot ? [{ ...record, snapshot }] : [];
          }),
        );
      request.onerror = () => reject(request.error ?? new Error("저장본 목록을 불러오지 못했습니다."));
    });

    await transactionDone(transaction);

    return records
      .sort((left, right) => right.savedAt.localeCompare(left.savedAt))
      .map((record) => buildProjectSummary(record));
  } finally {
    database.close();
  }
}

export async function loadProjectRecord(projectId: string) {
  const database = await openProjectDatabase();

  try {
    const transaction = database.transaction(PROJECT_STORE_NAME, "readonly");
    const request = transaction.objectStore(PROJECT_STORE_NAME).get(projectId);
    const record = await new Promise<StoredProjectRecord | null>((resolve, reject) => {
      request.onsuccess = () => {
        const result = request.result as StoredProjectRecord | undefined;
        const normalizedSnapshot = result ? normalizeProjectSnapshot(result.snapshot) : null;
        resolve(result && normalizedSnapshot ? { ...result, snapshot: normalizedSnapshot } : null);
      };
      request.onerror = () => reject(request.error ?? new Error("저장본을 불러오지 못했습니다."));
    });

    await transactionDone(transaction);

    return record ? toLoadedRecord(record) : null;
  } finally {
    database.close();
  }
}

export async function deleteProjectRecord(projectId: string) {
  const database = await openProjectDatabase();

  try {
    const transaction = database.transaction(PROJECT_STORE_NAME, "readwrite");
    transaction.objectStore(PROJECT_STORE_NAME).delete(projectId);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

function getTimingRoleSortIndex(role: CandidateTimingRole) {
  const index = timingRoleOrder.indexOf(role);
  return index >= 0 ? index : timingRoleOrder.length;
}

function getSceneTypeSortIndex(event: CandidateEvent) {
  const index = candidateSceneTypeOrder.indexOf(event.sceneType);
  return index >= 0 ? index : candidateSceneTypeOrder.length;
}

function compareCandidateEvents(left: CandidateEvent, right: CandidateEvent) {
  return (
    left.timeSec - right.timeSec ||
    left.beatIndex - right.beatIndex ||
    left.barIndex - right.barIndex ||
    left.beatInBar - right.beatInBar ||
    left.slotInBeat - right.slotInBeat ||
    getTimingRoleSortIndex(left.timingRole) - getTimingRoleSortIndex(right.timingRole) ||
    getSceneTypeSortIndex(left) - getSceneTypeSortIndex(right) ||
    left.id.localeCompare(right.id)
  );
}

function isBetterOverlappingEvent(candidate: CandidateEvent, current: CandidateEvent) {
  return (
    candidate.confidence - current.confidence ||
    candidate.strength - current.strength ||
    getTimingRoleSortIndex(current.timingRole) - getTimingRoleSortIndex(candidate.timingRole) ||
    getSceneTypeSortIndex(current) - getSceneTypeSortIndex(candidate) ||
    -compareCandidateEvents(candidate, current)
  ) > 0;
}

function pickBestOverlappingEvent(events: CandidateEvent[]) {
  return events.reduce((best, event) => (isBetterOverlappingEvent(event, best) ? event : best), events[0]);
}

function mergeOverlappingEvents(events: CandidateEvent[]) {
  const sortedEvents = [...events].sort(compareCandidateEvents);
  const mergedEvents: CandidateEvent[] = [];
  let currentCluster: CandidateEvent[] = [];
  let clusterStartTimeSec = 0;

  function flushCluster() {
    if (currentCluster.length === 0) {
      return;
    }

    mergedEvents.push(pickBestOverlappingEvent(currentCluster));
    currentCluster = [];
  }

  for (const event of sortedEvents) {
    if (currentCluster.length === 0) {
      currentCluster = [event];
      clusterStartTimeSec = event.timeSec;
      continue;
    }

    if (Math.abs(event.timeSec - clusterStartTimeSec) <= MERGED_LINE_TIME_TOLERANCE_SEC) {
      currentCluster.push(event);
      continue;
    }

    flushCluster();
    currentCluster = [event];
    clusterStartTimeSec = event.timeSec;
  }

  flushCluster();
  return mergedEvents.sort(compareCandidateEvents);
}

function buildSplitExportLines(selectedEvents: CandidateEvent[]): ResultExportLine[] {
  return candidateSceneTypeOrder.flatMap((sceneType) => {
    const events = selectedEvents.filter((event) => event.sceneType === sceneType).sort(compareCandidateEvents);

    if (events.length === 0) {
      return [];
    }

    return [
      {
        id: sceneType,
        label: candidateSceneTypeMeta[sceneType].label,
        sceneType,
        eventCount: events.length,
        events,
      },
    ];
  });
}

function buildMergedExportLines(selectedEvents: CandidateEvent[]): ResultExportLine[] {
  const events = mergeOverlappingEvents(selectedEvents);

  if (events.length === 0) {
    return [];
  }

  return [
    {
      id: "merged",
      label: "Merged line",
      sceneType: "merged",
      eventCount: events.length,
      events,
    },
  ];
}

export function buildResultExport(options: {
  analysis: AnalysisResponse;
  reviewStates: Record<string, CandidateReviewState>;
  activeTimingRoles: TimingRoleSelection;
  candidateStrategy: CandidateStrategy;
  lineMode?: ResultExportLineMode;
}): ResultExport {
  const activeVariant = getCandidateVariant(options.analysis, options.candidateStrategy);
  const lineMode = options.lineMode ?? "splitLines";
  const sourceSelectedEvents = activeVariant.candidateEvents.filter((event) => options.reviewStates[event.id] === "keep");
  const selectedLines =
    lineMode === "mergedLine" ? buildMergedExportLines(sourceSelectedEvents) : buildSplitExportLines(sourceSelectedEvents);
  const selectedEvents = selectedLines.flatMap((line) => line.events).sort(compareCandidateEvents);
  const selectedTimingRoleCounts = timingRoleOrder.reduce<Record<CandidateTimingRole, number>>((counts, role) => {
    counts[role] = selectedEvents.filter((event) => event.timingRole === role).length;
    return counts;
  }, {} as Record<CandidateTimingRole, number>);

  return {
    schemaVersion: RESULT_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    songId: options.analysis.songId,
    songName: options.analysis.songName,
    audioFileName: options.analysis.audioFileName,
    globalBpm: options.analysis.globalBpm,
    offsetSec: options.analysis.offsetSec,
    songLengthSec: options.analysis.songLengthSec,
    candidateStrategy: options.candidateStrategy,
    activeTimingRoles: timingRoleOrder.filter((role) => options.activeTimingRoles[role]),
    lineMode,
    selectedLineCount: selectedLines.length,
    sourceSelectedEventCount: sourceSelectedEvents.length,
    overlapRemovedEventCount: Math.max(sourceSelectedEvents.length - selectedEvents.length, 0),
    selectedEventCount: selectedEvents.length,
    selectedTimingRoleCounts,
    selectedLines,
    selectedEvents,
  };
}

export function downloadJsonFile(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

export function getProjectSnapshotFilename(analysis: AnalysisResponse) {
  return `${sanitizeFilenamePart(analysis.songName || analysis.songId)}-project.json`;
}

export function getResultExportFilename(
  analysis: AnalysisResponse,
  strategy: CandidateStrategy,
  lineMode: ResultExportLineMode = "splitLines",
) {
  const suffix = candidateStrategyOrder.indexOf(strategy) >= 0 ? strategy : "hybrid";
  const lineSuffix = lineMode === "mergedLine" ? "merged-line" : "split-lines";
  return `${sanitizeFilenamePart(analysis.songName || analysis.songId)}-${suffix}-${lineSuffix}-selected-events.json`;
}
