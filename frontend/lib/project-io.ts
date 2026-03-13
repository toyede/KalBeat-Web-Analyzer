import { candidateStrategyOrder, getCandidateVariant } from "@/lib/candidate-strategy";
import { timingRoleOrder } from "@/lib/candidate-event-meta";
import type {
  AnalysisResponse,
  CandidateEvent,
  CandidateReviewState,
  CandidateStrategy,
  CandidateTimingRole,
  CandidateVariant,
  ProjectSnapshot,
  ResultExport,
  SavedProjectSummary,
  TimingRoleSelection,
} from "@/lib/types";

const PROJECT_DB_NAME = "kalbeat-web-analyzer";
const PROJECT_STORE_NAME = "projects";
const PROJECT_DB_VERSION = 1;
const PROJECT_SNAPSHOT_VERSION = 2;
const RESULT_EXPORT_VERSION = 1;
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
  return value === "section4bar" ? "section4bar" : "global";
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
    reason: value.reason,
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
        .map((variant) => normalizeCandidateVariant(variant))
        .filter((variant): variant is CandidateVariant => variant !== null)
    : [];
  const defaultCandidateStrategy = normalizeCandidateStrategy(value.defaultCandidateStrategy);
  const normalizedVariants =
    candidateVariants.length > 0
      ? candidateVariants
      : [
          {
            strategy: defaultCandidateStrategy,
            label: "전곡 기준",
            description: "기존 저장본에서 불러온 기본 후보 세트입니다.",
            candidateEvents,
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

export function buildResultExport(options: {
  analysis: AnalysisResponse;
  reviewStates: Record<string, CandidateReviewState>;
  activeTimingRoles: TimingRoleSelection;
  candidateStrategy: CandidateStrategy;
}): ResultExport {
  const activeVariant = getCandidateVariant(options.analysis, options.candidateStrategy);
  const selectedEvents = activeVariant.candidateEvents.filter((event) => options.reviewStates[event.id] === "keep");
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
    selectedEventCount: selectedEvents.length,
    selectedTimingRoleCounts,
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

export function getResultExportFilename(analysis: AnalysisResponse, strategy: CandidateStrategy) {
  const suffix = candidateStrategyOrder.indexOf(strategy) >= 0 ? strategy : "global";
  return `${sanitizeFilenamePart(analysis.songName || analysis.songId)}-${suffix}-selected-events.json`;
}
