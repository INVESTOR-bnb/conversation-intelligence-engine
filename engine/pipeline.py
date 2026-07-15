from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

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
    total_stages: int = 1


ProgressCallback = Optional[Callable[[StageProgress], None]]


def run_pipeline(
    client: LLMClient,
    raw: RawConversation,
    on_progress: ProgressCallback = None,
) -> ConversationAnalysis:
    """Single structured LLM call (production path for free tier)."""

    if on_progress:
        on_progress(StageProgress(stage_index=0, stage_name="Full Analysis"))

    # Combined system prompt (all stages in one request)
    combined_system = """You are the complete Conversation Intelligence Engine.

Perform all four stages in a single response and return one JSON object matching the ConversationAnalysis schema:

1. Conversation Decomposition (turns + phases)
2. Signal Extraction (intent, trust, risk, decision_readiness, information_quality)
3. Dynamic Diagnosis (primary dynamic + explanation)
4. Judgment Synthesis (structural_understanding, strength, weakness, next_action)

Be thorough but concise. Ground everything in the provided conversation text."""

    user_prompt = f"""Analyze this conversation:

{raw.text}

Optional context: {raw.context or "(none)"}"""

    analysis = client.generate_structured(combined_system, user_prompt, ConversationAnalysis)
    return analysis
