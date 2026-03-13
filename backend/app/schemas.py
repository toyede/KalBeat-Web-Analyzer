from typing import Literal

from pydantic import BaseModel, Field

CandidateStrategy = Literal["global", "section4bar"]


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
    reason: str


class CandidateVariant(BaseModel):
    strategy: CandidateStrategy
    label: str
    description: str
    candidateEvents: list[CandidateEvent] = Field(default_factory=list)


class AnalysisResponse(BaseModel):
    schemaVersion: int = Field(1, ge=1)
    songId: str
    songName: str
    audioFileName: str
    analysisVersion: str
    globalBpm: float = Field(..., gt=0)
    offsetSec: float = Field(..., ge=0)
    songLengthSec: float = Field(..., ge=0)
    defaultCandidateStrategy: CandidateStrategy = "global"
    candidateEvents: list[CandidateEvent] = Field(default_factory=list)
    candidateVariants: list[CandidateVariant] = Field(default_factory=list)
