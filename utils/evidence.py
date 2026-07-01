"""
Shared helpers for connecting conclusions back to source conversation turns.

Used by the Results View and Evidence Panel so that every claim the engine
makes can be traced to specific text the user actually wrote or received.
"""

from __future__ import annotations

from typing import List

from models.schemas import Turn


def turns_by_index(turns: List[Turn], indices: List[int]) -> List[Turn]:
    """Return the subset of turns matching the given indices, in order."""
    lookup = {t.index: t for t in turns}
    return [lookup[i] for i in indices if i in lookup]


def format_evidence_block(turns: List[Turn], indices: List[int]) -> str:
    """Render a small markdown block quoting the evidence turns."""
    matched = turns_by_index(turns, indices)
    if not matched:
        return "_No directly linked turns._"
    lines = [f"> **{t.speaker_label}** (turn {t.index}): {t.text}" for t in matched]
    return "\n>\n".join(lines)
