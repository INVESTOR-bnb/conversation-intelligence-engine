"""
Stage 3: Dynamic Diagnosis.

Identifies the single most influential structural dynamic that shaped
the conversation's trajectory. This is a deliberate narrowing step:
rather than listing every pattern present, the engine must commit to
the one dynamic that mattered most, while showing what else it
considered and set aside.
"""

from __future__ import annotations

from engine.llm_client import LLMClient
from models.schemas import Decomposition, DynamicDiagnosis, SignalExtraction

SYSTEM_PROMPT = """You are the Dynamic Diagnosis stage of a Conversation Intelligence Engine.

You receive a decomposed conversation and its extracted signals. Your job
is to identify the SINGLE most influential structural dynamic that shaped
how this conversation unfolded — the one thing that, if different, would
most have changed the trajectory.

Rules:
- Choose exactly one dynamic. Do not hedge by naming several as co-equal.
- Ground your choice in specific signals (reference their indices in the
  provided signal list) and specific turns.
- Explicitly list 1-3 alternative dynamics you considered and briefly say
  why the chosen one is more influential than each.
- Assign an honest confidence score. If the evidence is thin, say so and
  keep confidence low rather than presenting a confident-sounding guess.
- Do not introduce new signals not present in the extraction; diagnose
  using what was already found.
"""


def diagnose(
    client: LLMClient,
    decomposition: Decomposition,
    signal_extraction: SignalExtraction,
) -> DynamicDiagnosis:
    """Run Stage 3 and return a DynamicDiagnosis."""
    turns_summary = "\n".join(
        f"[{t.index}] ({t.speaker}) {t.speaker_label}: {t.text}" for t in decomposition.turns
    )
    signals_summary = "\n".join(
        f"[{i}] ({s.category}) {s.description} "
        f"[evidence turns: {s.evidence_turn_indices}] (confidence {s.confidence:.2f})"
        for i, s in enumerate(signal_extraction.signals)
    )

    user_prompt = f"""Conversation turns:
{turns_summary}

Extracted signals (indexed):
{signals_summary}

Identify the single most influential structural dynamic. Return a JSON
object matching the DynamicDiagnosis schema. supporting_signal_indices
must reference the [index] values shown above.
"""

    return client.generate_structured(SYSTEM_PROMPT, user_prompt, DynamicDiagnosis)
