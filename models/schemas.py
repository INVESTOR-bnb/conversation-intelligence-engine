"""
Data schemas for the Conversation Intelligence Engine.

All data flowing between the four reasoning stages is strongly typed here.
This is the contract the rest of the system is built against — UI code,
engine code, and any future reasoning stages all speak these types.
"""

from __future__ import annotations

from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Stage 0 input
# ---------------------------------------------------------------------------

class RawConversation(BaseModel):
    """Raw input supplied by the user before any processing."""
    text: str = Field(..., description="The full pasted conversation text.")
    context: Optional[str] = Field(
        None, description="Optional minimal context the user supplies (e.g. 'first contact with a buyer')."
    )


# ---------------------------------------------------------------------------
# Stage 1: Conversation Decomposition
# ---------------------------------------------------------------------------

class Speaker(str, Enum):
    USER = "user"
    OTHER = "other"
    UNKNOWN = "unknown"


class Turn(BaseModel):
    """A single turn in the conversation."""
    index: int = Field(..., description="0-based position of this turn in the conversation.")
    speaker: Speaker
    speaker_label: str = Field(..., description="Original label as it appeared in the source text.")
    text: str
    char_start: int = Field(..., description="Start offset of this turn in the original raw text.")
    char_end: int = Field(..., description="End offset of this turn in the original raw text.")


class Phase(BaseModel):
    """A natural phase or shift in engagement across a span of turns."""
    name: str = Field(..., description="Short label for the phase, e.g. 'Opening', 'Price anchoring', 'Stall'.")
    start_turn: int
    end_turn: int
    description: str = Field(..., description="What is structurally happening in this phase.")


class Decomposition(BaseModel):
    """Output of Stage 1."""
    turns: List[Turn]
    phases: List[Phase]
    reasoning_notes: str = Field(
        ..., description="Transparent explanation of how turns/phases were identified."
    )


# ---------------------------------------------------------------------------
# Stage 2: Signal Extraction
# ---------------------------------------------------------------------------

class SignalCategory(str, Enum):
    INTENT = "intent"
    TRUST = "trust"
    RISK = "risk"
    DECISION_READINESS = "decision_readiness"
    INFORMATION_QUALITY = "information_quality"


class Signal(BaseModel):
    """A single observable, evidence-linked signal."""
    category: SignalCategory
    description: str = Field(..., description="What was observed, stated plainly and non-speculatively.")
    evidence_turn_indices: List[int] = Field(
        ..., description="Indices of turns that directly support this observation."
    )
    confidence: float = Field(
        ..., ge=0.0, le=1.0, description="Confidence that this signal is genuinely present, not overinterpreted."
    )


class SignalExtraction(BaseModel):
    """Output of Stage 2."""
    signals: List[Signal]
    reasoning_notes: str


# ---------------------------------------------------------------------------
# Stage 3: Dynamic Diagnosis
# ---------------------------------------------------------------------------

class DynamicDiagnosis(BaseModel):
    """Output of Stage 3 — the single most influential structural dynamic."""
    dynamic_name: str = Field(..., description="Short name for the dynamic, e.g. 'Trust asymmetry after turn 4'.")
    explanation: str = Field(..., description="Why this dynamic, above others, shaped the trajectory.")
    supporting_signal_indices: List[int] = Field(
        ..., description="Indices into SignalExtraction.signals that support this diagnosis."
    )
    alternative_dynamics_considered: List[str] = Field(
        default_factory=list,
        description="Other candidate dynamics that were considered and set aside, for transparency.",
    )
    confidence: float = Field(..., ge=0.0, le=1.0)


# ---------------------------------------------------------------------------
# Stage 4: Judgment Synthesis
# ---------------------------------------------------------------------------

class EvidenceRef(BaseModel):
    """A pointer back to the source conversation supporting a claim."""
    turn_indices: List[int]
    note: Optional[str] = None


class JudgmentSynthesis(BaseModel):
    """Output of Stage 4 — exactly four outputs, each evidence-linked."""
    structural_understanding: str
    structural_understanding_evidence: EvidenceRef

    strength: str
    strength_evidence: EvidenceRef

    weakness: str
    weakness_evidence: EvidenceRef

    next_action: str = Field(..., description="One concrete, testable action for the next conversation.")

    overall_confidence: float = Field(
        ..., ge=0.0, le=1.0, description="Honest confidence in the synthesis as a whole."
    )
    limitations: str = Field(
        ..., description="Explicit statement of what this analysis cannot tell the user, to avoid false certainty."
    )


# ---------------------------------------------------------------------------
# Full pipeline result
# ---------------------------------------------------------------------------

class ConversationAnalysis(BaseModel):
    """The complete, traceable output of a full pipeline run."""
    raw: RawConversation
    decomposition: Decomposition
    signal_extraction: SignalExtraction
    diagnosis: DynamicDiagnosis
    synthesis: JudgmentSynthesis
