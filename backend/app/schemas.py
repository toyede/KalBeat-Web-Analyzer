from typing import Literal

from pydantic import BaseModel, Field


class CandidateEvent(BaseModel):
    id: str
    timeSec: float = Field(..., ge=0)
    beatIndex: int = Field(..., ge=1)
    barIndex: int = Field(..., ge=1)
    beatInBar: int = Field(..., ge=1, le=4)
    slotInBeat: int = Field(..., ge=0, le=3)
    gridDivision: Literal[1, 2, 4]
    timingRole: Literal["downbeat", "beat", "offbeat", "subdivision"]
    confidence: float = Field(..., ge=0, le=1)
    strength: float = Field(..., ge=0, le=1)
    kind: Literal["strong", "steady", "light"]
    reason: str


class AnalysisResponse(BaseModel):
    schemaVersion: int = Field(1, ge=1)
    songId: str
    songName: str
    audioFileName: str
    analysisVersion: str
    globalBpm: float = Field(..., gt=0)
    offsetSec: float = Field(..., ge=0)
    songLengthSec: float = Field(..., ge=0)
    candidateEvents: list[CandidateEvent] = Field(default_factory=list)
