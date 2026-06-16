from typing import Literal

from pydantic import BaseModel, Field

CandidateStrategy = Literal["reactive", "pattern", "hybrid"]
CandidateSceneFamily = Literal["reactive", "pattern"]
CandidateSceneType = Literal[
    "prep_1_attack",
    "prep_2_attack",
    "prep_3_attack",
    "combo_pattern_1bar",
    "combo_pattern_2bar",
]


class CandidateEvent(BaseModel):
    id: str
    timeSec: float = Field(..., ge=0)
    beatIndex: int = Field(..., ge=1)
    barIndex: int = Field(..., ge=1)
    beatInBar: int = Field(..., ge=1, le=4)
    slotInBeat: int = Field(..., ge=0, le=7)
    gridDivision: Literal[0, 1, 2, 3, 4, 8]
    timingRole: Literal["pulse", "offbeat", "subdivision", "thirtySecond", "triplet", "freeAccent"]
    confidence: float = Field(..., ge=0, le=1)
    strength: float = Field(..., ge=0, le=1)
    kind: Literal["strong", "steady", "light"]
    sceneFamily: CandidateSceneFamily
    sceneType: CandidateSceneType
    sceneGroupId: str = ""
    cueTimesSec: list[float] = Field(default_factory=list)
    reason: str


class PatternSegment(BaseModel):
    id: str
    bars: Literal[1, 2]
    sceneType: Literal["combo_pattern_1bar", "combo_pattern_2bar"]
    cueStartBar: int = Field(..., ge=1)
    cueEndBar: int = Field(..., ge=1)
    responseStartBar: int = Field(..., ge=1)
    responseEndBar: int = Field(..., ge=1)
    cueStartSec: float = Field(..., ge=0)
    cueEndSec: float = Field(..., ge=0)
    responseStartSec: float = Field(..., ge=0)
    responseEndSec: float = Field(..., ge=0)
    score: float = Field(..., ge=0, le=1)
    similarity: float = Field(..., ge=0, le=1)
    cueEvents: list[CandidateEvent] = Field(default_factory=list)
    responseEventIds: list[str] = Field(default_factory=list)


class OffsetCandidate(BaseModel):
    source: Literal["auto", "first_onset", "strong_onset", "grid_phase", "beat_tracker"]
    label: str
    offsetSec: float = Field(..., ge=0)
    reason: str = ""


class CandidateVariant(BaseModel):
    strategy: CandidateStrategy
    label: str
    description: str
    candidateEvents: list[CandidateEvent] = Field(default_factory=list)
    patternSegments: list[PatternSegment] = Field(default_factory=list)


class AnalysisResponse(BaseModel):
    schemaVersion: int = Field(1, ge=1)
    songId: str
    songName: str
    audioFileName: str
    analysisVersion: str
    globalBpm: float = Field(..., gt=0)
    offsetSec: float = Field(..., ge=0)
    songLengthSec: float = Field(..., ge=0)
    defaultCandidateStrategy: CandidateStrategy = "hybrid"
    offsetCandidates: list[OffsetCandidate] = Field(default_factory=list)
    candidateEvents: list[CandidateEvent] = Field(default_factory=list)
    candidateVariants: list[CandidateVariant] = Field(default_factory=list)
