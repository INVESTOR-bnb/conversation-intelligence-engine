"""
Conversation Intelligence Engine v1.0 — Streamlit prototype.

A scientific reasoning instrument, not a consumer product. The interface
is deliberately minimal: paste a conversation, watch the four reasoning
stages run transparently, then inspect the four synthesized outputs with
their evidence.

Run with: streamlit run app.py
Requires ANTHROPIC_API_KEY to be set in the environment.
"""

from __future__ import annotations

import streamlit as st

from engine.llm_client import build_default_client
from engine.pipeline import StageProgress, run_pipeline
from models.schemas import ConversationAnalysis, RawConversation
from utils.evidence import format_evidence_block

st.set_page_config(
    page_title="Conversation Intelligence Engine",
    page_icon=None,
    layout="centered",
)

# ---------------------------------------------------------------------------
# Minimal, research-grade styling
# ---------------------------------------------------------------------------

st.markdown(
    """
    <style>
    .stApp { background-color: #fafafa; }
    h1, h2, h3 { font-weight: 500; letter-spacing: -0.01em; }
    .cie-caption { color: #6b6b6b; font-size: 0.85rem; }
    .cie-divider { border-top: 1px solid #e0e0e0; margin: 1.5rem 0; }
    .cie-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; color: #444; }
    </style>
    """,
    unsafe_allow_html=True,
)

if "analysis" not in st.session_state:
    st.session_state.analysis: ConversationAnalysis | None = None
if "client" not in st.session_state:
    st.session_state.client = None


def get_client():
    if st.session_state.client is None:
        st.session_state.client = build_default_client()
    return st.session_state.client


# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------

st.title("Conversation Intelligence Engine")
st.markdown(
    '<span class="cie-caption">v1.0 — a research instrument for the structural dynamics of '
    "conversation: intent, trust, risk, decision readiness, and information quality. "
    "Not persuasion advice, not psychological profiling.</span>",
    unsafe_allow_html=True,
)
st.markdown('<div class="cie-divider"></div>', unsafe_allow_html=True)


# ---------------------------------------------------------------------------
# Input View
# ---------------------------------------------------------------------------

st.subheader("Input")
conversation_text = st.text_area(
    "Paste a conversation",
    height=260,
    placeholder=(
        "Paste the conversation as text, ideally with speaker labels, e.g.\n\n"
        "Agent: Good afternoon, is the property still available?\n"
        "Owner: Yes, still available.\n"
        "Agent: What's the last price?\n..."
    ),
    label_visibility="collapsed",
)
context_text = st.text_input(
    "Minimal context (optional)",
    placeholder="e.g. This was the first contact with a new prospective client.",
)

run_clicked = st.button("Run analysis", type="primary", disabled=not conversation_text.strip())

st.markdown('<div class="cie-divider"></div>', unsafe_allow_html=True)


# ---------------------------------------------------------------------------
# Run pipeline with live stage progress (Analysis View)
# ---------------------------------------------------------------------------

if run_clicked:
    raw = RawConversation(text=conversation_text.strip(), context=context_text.strip() or None)

    st.subheader("Analysis")
    progress_container = st.container()
    stage_placeholders = [progress_container.empty() for _ in range(4)]

    def on_progress(p: StageProgress):
        for i, ph in enumerate(stage_placeholders):
            if i < p.stage_index:
                ph.markdown(f"✓ **{i + 1}. {p.stage_name if i == p.stage_index else ''}**".strip())
        stage_placeholders[p.stage_index].markdown(f"→ **{p.stage_index + 1}. {p.stage_name}** — running…")

    try:
        client = get_client()
        with st.spinner(""):
            analysis = run_pipeline(client, raw, on_progress=on_progress)
        for i, ph in enumerate(stage_placeholders):
            from engine.pipeline import STAGE_NAMES
            ph.markdown(f"✓ **{i + 1}. {STAGE_NAMES[i]}**")
        st.session_state.analysis = analysis
    except (ImportError, ValueError) as e:
        st.error(str(e))
    except Exception as e:  # noqa: BLE001 - surface any pipeline failure plainly
        st.error(f"Analysis failed: {e}")


# ---------------------------------------------------------------------------
# Detailed stage-by-stage view (expand/collapse) + Results + Evidence
# ---------------------------------------------------------------------------

analysis = st.session_state.analysis

if analysis:
    st.markdown('<div class="cie-divider"></div>', unsafe_allow_html=True)
    st.subheader("Reasoning trace")

    with st.expander("1. Conversation Decomposition", expanded=False):
        st.markdown(f'<span class="cie-caption">{analysis.decomposition.reasoning_notes}</span>', unsafe_allow_html=True)
        for phase in analysis.decomposition.phases:
            st.markdown(f"**{phase.name}** (turns {phase.start_turn}–{phase.end_turn})")
            st.markdown(f'<span class="cie-caption">{phase.description}</span>', unsafe_allow_html=True)
        st.markdown("---")
        for t in analysis.decomposition.turns:
            st.markdown(
                f'<span class="cie-mono">[{t.index}] {t.speaker_label} ({t.speaker}): {t.text}</span>',
                unsafe_allow_html=True,
            )

    with st.expander("2. Signal Extraction", expanded=False):
        st.markdown(f'<span class="cie-caption">{analysis.signal_extraction.reasoning_notes}</span>', unsafe_allow_html=True)
        for i, s in enumerate(analysis.signal_extraction.signals):
            st.markdown(
                f"**[{i}] {s.category.value}** — {s.description}  \n"
                f'<span class="cie-caption">evidence turns {s.evidence_turn_indices} · confidence {s.confidence:.2f}</span>',
                unsafe_allow_html=True,
            )

    with st.expander("3. Dynamic Diagnosis", expanded=False):
        d = analysis.diagnosis
        st.markdown(f"**{d.dynamic_name}**  (confidence {d.confidence:.2f})")
        st.write(d.explanation)
        if d.alternative_dynamics_considered:
            st.markdown('<span class="cie-caption">Alternatives considered:</span>', unsafe_allow_html=True)
            for alt in d.alternative_dynamics_considered:
                st.markdown(f"- {alt}")
        st.markdown(
            f'<span class="cie-caption">Supported by signals {d.supporting_signal_indices}</span>',
            unsafe_allow_html=True,
        )

    with st.expander("4. Judgment Synthesis", expanded=False):
        st.markdown(f'<span class="cie-caption">Overall confidence: {analysis.synthesis.overall_confidence:.2f}</span>', unsafe_allow_html=True)
        st.markdown(f'<span class="cie-caption">Limitations: {analysis.synthesis.limitations}</span>', unsafe_allow_html=True)

    # -----------------------------------------------------------------
    # Results View
    # -----------------------------------------------------------------
    st.markdown('<div class="cie-divider"></div>', unsafe_allow_html=True)
    st.subheader("Results")

    synth = analysis.synthesis
    turns = analysis.decomposition.turns

    st.markdown("**Structural understanding**")
    st.write(synth.structural_understanding)
    with st.expander("Evidence"):
        st.markdown(format_evidence_block(turns, synth.structural_understanding_evidence.turn_indices))

    st.markdown("**Strength**")
    st.write(synth.strength)
    with st.expander("Evidence"):
        st.markdown(format_evidence_block(turns, synth.strength_evidence.turn_indices))

    st.markdown("**Weakness / blind spot**")
    st.write(synth.weakness)
    with st.expander("Evidence"):
        st.markdown(format_evidence_block(turns, synth.weakness_evidence.turn_indices))

    st.markdown("**Next action**")
    st.write(synth.next_action)

    st.markdown('<div class="cie-divider"></div>', unsafe_allow_html=True)
    st.markdown(
        f'<span class="cie-caption">Overall confidence: {synth.overall_confidence:.2f}. '
        f"{synth.limitations}</span>",
        unsafe_allow_html=True,
    )
