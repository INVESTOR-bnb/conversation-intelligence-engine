"""
Stage 4: Judgment Synthesis.

Produces the four required user-facing outputs:
1. A deeper structural understanding of what happened
2. One specific strength the user demonstrated
3. One specific weakness or blind spot
4. One concrete, testable action for the next conversation

Every output must be evidence-linked back to specific turns, and the
stage must state its limitations explicitly rather than implying more
certainty than the analysis supports.
"""

from __future__ import annotations

from engine.llm_client import LLMClient
from models.schemas import (
    Decomposition,
    DynamicDiagnosis,
    JudgmentSynthesis,
    SignalExtraction,
)

SYSTEM_PROMPT = """You are the Judgment Synthesis stage of a Conversation Intelligence Engine.

You receive the full upstream reasoning: decomposition, signals, and the
diagnosed dynamic. Produce exactly four outputs about the "user" speaker
(the person who will read this analysis), each with a direct evidence
reference to specific turn indices:

1. structural_understanding — a deeper explanation of what actually
   happened in this conversation, building on the diagnosed dynamic.
2. strength — one specific thing the user did well, evidenced in their
   own turns.
3. weakness — one specific blind spot or missed opportunity in the user's
   own turns. Be honest and specific, not generically critical.
4. next_action — one concrete, testable action for the user's next
   conversation. It must be specific enough that the user could know
   afterward whether they did it.

Rules:
- strength and weakness must be about the "user" speaker specifically, not
  the counterparty. If turns cannot be reliably attributed to "user", say
  so explicitly in limitations and give your best-supported reading rather
  than refusing to answer.
- Do not overstate certainty. If the underlying signals or diagnosis have
  low confidence, reflect that in overall_confidence and say plainly, in
  limitations, what this analysis cannot tell the user (e.g. tone/intent
  behind short texts, information outside the conversation, outcomes that
  haven't happened yet).
- Keep each output concrete and specific to this conversation — avoid
  generic advice that could apply to any conversation.
"""


def synthesize(
    client: LLMClient,
    decomposition: Decomposition,
    signal_extraction: SignalExtraction,
    diagnosis: DynamicDiagnosis,
) -> JudgmentSynthesis:
    """Run Stage 4 and return a JudgmentSynthesis."""
    turns_summary = "\n".join(
        f"[{t.index}] ({t.speaker}) {t.speaker_label}: {t.text}" for t in decomposition.turns
    )
    signals_summary = "\n".join(
        f"[{i}] ({s.category}) {s.description} [evidence turns: {s.evidence_turn_indices}]"
        for i, s in enumerate(signal_extraction.signals)
    )

    user_prompt = f"""Conversation turns:
{turns_summary}

Extracted signals:
{signals_summary}

Diagnosed dynamic: {diagnosis.dynamic_name}
Explanation: {diagnosis.explanation}
Diagnosis confidence: {diagnosis.confidence:.2f}

Produce the four synthesis outputs. Return a JSON object matching the
JudgmentSynthesis schema, with turn_indices in each EvidenceRef pointing
to the [index] values shown above.
"""

    return client.generate_structured(SYSTEM_PROMPT, user_prompt, JudgmentSynthesis)
