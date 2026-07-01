"""
Pipeline orchestrator.

Chains the four independent reasoning stages into a single traceable run.
Each stage is called through the shared LLMClient abstraction, so the
underlying model can be swapped without touching this file or any stage
module.

Kept deliberately thin: this file's only job is sequencing and packaging
results into a ConversationAnalysis. All actual reasoning logic lives in
the stage modules.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

from engine import decomposition, diagnosis, signal_extraction, synthesis
from engine.llm_client import LLMClient
from models.schemas import ConversationAnalysis, RawConversation

STAGE_NAMES = (
    "Conversation Decomposition",
    "Signal Extraction",
    "Dynamic Diagnosis",
    "Judgment Synthesis",
)


@dataclass
class StageProgress:
    stage_index: int
    stage_name: str
    total_stages: int = 4


ProgressCallback = Optional[Callable[[StageProgress], None]]


def run_pipeline(
    client: LLMClient,
    raw: RawConversation,
    on_progress: ProgressCallback = None,
) -> ConversationAnalysis:
    """Run all four stages in sequence and return the full analysis.

    on_progress, if provided, is called before each stage begins so a UI
    can show live progress through the reasoning pipeline.
    """

    def _notify(i: int):
        if on_progress:
            on_progress(StageProgress(stage_index=i, stage_name=STAGE_NAMES[i]))

    _notify(0)
    decomp = decomposition.decompose(client, raw)

    _notify(1)
    signals = signal_extraction.extract_signals(client, decomp)

    _notify(2)
    diag = diagnosis.diagnose(client, decomp, signals)

    _notify(3)
    synth = synthesis.synthesize(client, decomp, signals, diag)

    return ConversationAnalysis(
        raw=raw,
        decomposition=decomp,
        signal_extraction=signals,
        diagnosis=diag,
        synthesis=synth,
    )
