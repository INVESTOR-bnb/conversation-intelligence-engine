"""
Stage 2: Signal Extraction.

Extracts observable, evidence-linked signals across five universal
dimensions of conversational coordination: intent, trust, risk,
decision readiness, and information quality.

This stage must stay descriptive, not evaluative — it records what is
observably present, with a confidence score, rather than judging the
participants.
"""

from __future__ import annotations

from engine.llm_client import LLMClient
from models.schemas import Decomposition, SignalExtraction

SYSTEM_PROMPT = """You are the Signal Extraction stage of a Conversation Intelligence Engine.

Given a decomposed conversation (turns and phases), extract observable
signals across exactly these five categories:
- intent: what participants appear to want, as evidenced by their language
- trust: indicators of trust being built, tested, or broken
- risk: indicators of exposure, uncertainty, or things left unresolved
- decision_readiness: how close participants seem to being ready to commit
- information_quality: how complete, vague, specific, or contradictory the
  information exchanged is

Rules:
- Every signal must cite the specific turn indices that support it.
- Do not speculate about internal mental states beyond what the text
  supports. Ground each signal in language, not assumption.
- Assign a confidence score (0-1) reflecting how directly the evidence
  supports the observation. Reserve confidence above 0.8 for signals with
  unambiguous textual support.
- It is acceptable, and often correct, to extract very few signals if the
  conversation is short or ambiguous. Do not manufacture signals to fill
  categories.
- Avoid duplicating near-identical signals; prefer fewer, well-evidenced
  signals over many weak ones.
"""


def extract_signals(client: LLMClient, decomposition: Decomposition) -> SignalExtraction:
    """Run Stage 2 and return a SignalExtraction."""
    turns_summary = "\n".join(
        f"[{t.index}] ({t.speaker}) {t.speaker_label}: {t.text}" for t in decomposition.turns
    )
    phases_summary = "\n".join(
        f"- {p.name} (turns {p.start_turn}-{p.end_turn}): {p.description}" for p in decomposition.phases
    )

    user_prompt = f"""Conversation turns:
{turns_summary}

Identified phases:
{phases_summary}

Extract observable signals per the instructions. Return a JSON object
matching the SignalExtraction schema. Include a reasoning_notes field
explaining your extraction approach and any categories where you found
little or no evidence.
"""

    return client.generate_structured(SYSTEM_PROMPT, user_prompt, SignalExtraction)
