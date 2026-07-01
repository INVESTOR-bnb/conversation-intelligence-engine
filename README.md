# Conversation Intelligence Engine v1.0

A scientific validation prototype, not a product. It tests whether a
structured, four-stage reasoning pipeline can produce genuinely useful,
evidence-linked understanding of a business conversation — using only
universal structural signals (intent, trust, risk, decision readiness,
information quality), not industry knowledge or persuasion tactics.

## Setup

```bash
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

export ANTHROPIC_API_KEY="sk-ant-..."
# optional: override the model (defaults to claude-sonnet-4-6)
export CIE_MODEL="claude-sonnet-4-6"

streamlit run app.py
```

## How it works

Four independent, sequential reasoning stages, each its own module under
`engine/`:

1. **Decomposition** (`engine/decomposition.py`) — splits the raw text into
   turns (mechanically, for reliable offsets) and asks the model to
   identify natural phases/shifts. No interpretation of intent or trust
   happens here.
2. **Signal Extraction** (`engine/signal_extraction.py`) — extracts
   observable, evidence-cited signals across five categories: intent,
   trust, risk, decision readiness, information quality.
3. **Dynamic Diagnosis** (`engine/diagnosis.py`) — commits to the single
   most influential structural dynamic, states alternatives considered,
   and gives an honest confidence score.
4. **Judgment Synthesis** (`engine/synthesis.py`) — produces exactly four
   outputs: a structural understanding, one strength, one weakness, and
   one concrete next action, each evidence-linked, plus explicit stated
   limitations.

`engine/pipeline.py` sequences the four stages and reports progress via a
callback so the UI can show live status.

## Architecture

```
models/schemas.py     Pydantic types shared by every stage (the contract)
engine/llm_client.py   LLMClient abstraction — swap models/providers here only
engine/decomposition.py
engine/signal_extraction.py
engine/diagnosis.py
engine/synthesis.py
engine/pipeline.py     Orchestrates the four stages
utils/evidence.py      Helpers linking conclusions back to source turns
app.py                 Streamlit UI: Input / Analysis / Results / Evidence
```

Design choices worth knowing about:

- **Model-agnostic core.** Every stage calls `LLMClient.generate_structured`,
  never the Anthropic SDK directly. To point at a different model or
  provider, implement a new `LLMClient` subclass in `engine/llm_client.py`
  and change `build_default_client()` — nothing in `engine/` or `app.py`
  needs to change.
- **Reliable turn offsets.** Turn splitting is done mechanically in
  `decomposition.py` before the LLM ever sees the text, because LLMs
  compute character offsets unreliably. The LLM only assigns phases and
  refines speaker attribution.
- **Evidence is structural, not decorative.** Every signal, diagnosis, and
  synthesis output carries turn indices back to the source conversation.
  `utils/evidence.py` renders those as quoted blocks in the UI.
- **Confidence is explicit everywhere.** Signals, diagnosis, and the final
  synthesis all carry a confidence score, and synthesis carries an
  explicit `limitations` field so the tool doesn't imply more certainty
  than the reasoning supports.

## Explicitly out of scope for v1.0

User accounts, conversation storage/history, feedback collection,
multi-model comparison, admin dashboards, complex visualizations. See the
project brief for rationale — the goal is to validate the reasoning
engine, not build a full application.

## Testing a stage in isolation

Each stage is a plain function taking an `LLMClient` plus typed input and
returning a typed output, so it can be tested independently, e.g.:

```python
from engine.llm_client import build_default_client
from engine.decomposition import decompose
from models.schemas import RawConversation

client = build_default_client()
result = decompose(client, RawConversation(text="Agent: Hi\nOwner: Hello"))
print(result.model_dump_json(indent=2))
```
