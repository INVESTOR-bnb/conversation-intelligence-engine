"""
Stage 1: Conversation Decomposition.

Splits the raw conversation into turns and identifies natural phases
or shifts in engagement. This stage does no interpretation of intent,
trust, or risk — it only establishes the structural skeleton that
later stages will reason over.
"""

from __future__ import annotations

import re

from engine.llm_client import LLMClient
from models.schemas import Decomposition, RawConversation, Turn

SYSTEM_PROMPT = """You are the Decomposition stage of a Conversation Intelligence Engine.

Your only job is structural: split the conversation into turns and identify
natural phases (shifts in engagement, topic, or posture). You must not
interpret intent, trust, risk, or make any judgment about the participants.
That happens in later stages.

Rules:
- Preserve the original turn order and speaker labels exactly as given.
- A "phase" is a contiguous run of turns that shares a structural character
  (e.g. opening, information exchange, price negotiation, stalling, closing).
- Phases must be evidence-based and grounded in what actually shifts in the
  text, not assumed from conversation genre.
- If the conversation is short or unstructured, it is fine to return very
  few phases, even one. Do not invent structure that is not there.
- Be transparent: your reasoning_notes should explain how you identified
  turn boundaries and phase boundaries.
"""


def _pre_split_turns(raw_text: str) -> list[Turn]:
    """Best-effort mechanical pre-split of raw text into turns.

    This gives the LLM stage a reliable, offset-accurate turn list to work
    from rather than asking it to compute character offsets itself (which
    LLMs do unreliably). The LLM is used afterward only to assign phases
    and to refine speaker attribution if labels are ambiguous.
    """
    lines = raw_text.splitlines(keepends=True)
    turns: list[Turn] = []
    offset = 0
    speaker_pattern = re.compile(r"^\s*([\w .'-]{1,40}):\s?(.*)$")

    current_label = None
    current_text_parts: list[str] = []
    current_start = 0

    def flush():
        nonlocal current_label, current_text_parts, current_start
        if current_label is not None and current_text_parts:
            text = "".join(current_text_parts).strip()
            if text:
                turns.append(
                    Turn(
                        index=len(turns),
                        speaker="unknown",
                        speaker_label=current_label,
                        text=text,
                        char_start=current_start,
                        char_end=current_start + len(text),
                    )
                )
        current_text_parts = []

    for line in lines:
        match = speaker_pattern.match(line)
        if match:
            flush()
            current_label = match.group(1).strip()
            current_start = offset + (len(line) - len(line.lstrip()))
            current_text_parts = [match.group(2)]
        else:
            if current_label is None:
                # No speaker label found yet; treat as a single unlabeled turn.
                current_label = "Speaker"
                current_start = offset
            current_text_parts.append(line)
        offset += len(line)

    flush()

    if not turns:
        # Entire text is one block with no discernible speaker labels.
        stripped = raw_text.strip()
        if stripped:
            turns.append(
                Turn(
                    index=0,
                    speaker="unknown",
                    speaker_label="Speaker",
                    text=stripped,
                    char_start=0,
                    char_end=len(stripped),
                )
            )

    return turns


def decompose(client: LLMClient, raw: RawConversation) -> Decomposition:
    """Run Stage 1 and return a Decomposition."""
    turns = _pre_split_turns(raw.text)

    turns_summary = "\n".join(
        f"[{t.index}] {t.speaker_label}: {t.text}" for t in turns
    )

    user_prompt = f"""Here are the mechanically pre-split turns of a conversation.
Speaker labels are as they appeared in the source text; do not rename them.

{turns_summary}

Optional context supplied by the user: {raw.context or "(none provided)"}

Identify natural phases across these turns (by start_turn/end_turn indices,
inclusive, using the indices shown in brackets above). Also indicate, for
each turn, whether the speaker is most likely "user" (the person who will
read this analysis) or "other" (the counterparty) or "unknown" if it cannot
be determined — base this only on structural cues like who initiates,
responds, or is addressed, not on assumptions about role.

Return a JSON object matching the Decomposition schema. Reproduce the turns
list exactly as given (same index, speaker_label, text, char_start, char_end),
only filling in the "speaker" field and adding "phases" and "reasoning_notes".
"""

    result = client.generate_structured(SYSTEM_PROMPT, user_prompt, Decomposition)

    # Safety net: if the model mangled turn text/offsets, fall back to the
    # mechanically computed turns so downstream evidence indices stay valid.
    if len(result.turns) != len(turns):
        result.turns = turns

    return result
