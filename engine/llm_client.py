"""
LLM client abstraction layer.

Every reasoning stage talks to this interface, never to a specific SDK.
Swapping models (or providers) later means writing a new class that
implements LLMClient — nothing else in the codebase changes.
"""

from __future__ import annotations

import json
import logging
import os
import random
import re
import time
from abc import ABC, abstractmethod
from typing import Optional, Type, TypeVar

from openai import OpenAI, APIError
from pydantic import BaseModel, ValidationError

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)


class LLMClient(ABC):
    """Abstract interface for a structured-output-capable LLM."""

    @abstractmethod
    def generate_structured(
        self,
        system_prompt: str,
        user_prompt: str,
        response_model: Type[T],
    ) -> T:
        """Generate a response and parse it into `response_model`.

        Implementations must ensure the raw model output is valid JSON
        matching the schema of response_model, and must raise a clear
        exception if parsing fails rather than silently guessing.
        """
        raise NotImplementedError


class OpenRouterLLMClient(LLMClient):
    """
    Production-grade OpenRouter client with tiered fallback, intelligent
    error handling, JSON repair, and full observability.

    Tiering prioritizes models with proven structured JSON reliability.
    """

    # Tier A: Highest JSON reliability + reasoning (tried first)
    TIER_A = [
        "meta-llama/llama-3.3-70b-instruct:free",
        "qwen/qwen3-next-80b-a3b-instruct:free",
    ]

    # Tier B: Strong reasoning, may occasionally need repair
    TIER_B = [
        "nvidia/nemotron-3-ultra-550b-a55b:free",
    ]

    # Tier C: Emergency fallback
    TIER_C = [
        "tencent/hy3:free",
    ]

    FALLBACK_MODELS = TIER_A + TIER_B + TIER_C

    def __init__(
        self,
        model: str = "meta-llama/llama-3.3-70b-instruct:free",
        api_key: Optional[str] = None,
        base_url: str = "https://openrouter.ai/api/v1",
        timeout: float = 30.0,
        max_retries_per_model: int = 3,
    ) -> None:
        key = api_key or os.environ.get("OPENROUTER_API_KEY")
        if not key:
            raise ValueError(
                "OPENROUTER_API_KEY is required. "
                "Set it as an environment variable or pass it explicitly."
            )

        self._client = OpenAI(
            base_url=base_url,
            api_key=key,
            timeout=timeout,
        )
        self._fallback_models = self.FALLBACK_MODELS.copy()
        self._model = model
        self._timeout = timeout
        self._max_retries_per_model = max_retries_per_model

    def generate_structured(
        self,
        system_prompt: str,
        user_prompt: str,
        response_model: Type[T],
    ) -> T:
        models_to_try = [self._model] + [
            m for m in self._fallback_models if m != self._model
        ]

        last_exception: Exception | None = None
        start_time = time.time()

        for model in models_to_try:
            self._model = model
            logger.info(
                "Trying model: %s | Pipeline stage: structured_generation",
                model,
            )

            for attempt in range(self._max_retries_per_model):
                try:
                    messages = [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ]

                    response = self._client.chat.completions.create(
                        model=self._model,
                        messages=messages,
                        response_format={"type": "json_object"},
                        max_tokens=4000,
                        timeout=self._timeout,
                    )

                    content = response.choices[0].message.content
                    if content is None:
                        raise ValueError("Model returned empty content")

                    raw_text = _strip_code_fences(content.strip())

                    # JSON Repair Layer
                    repaired_text = self._repair_json(raw_text)
                    try:
                        data = json.loads(repaired_text)
                        logger.info(
                            "JSON parsing status: success | model=%s | attempt=%s",
                            self._model,
                            attempt + 1,
                        )
                    except json.JSONDecodeError as exc:
                        if attempt == self._max_retries_per_model - 1:
                            logger.warning(
                                "JSON parsing status: failed after repair | model=%s",
                                self._model,
                            )
                            raise ValueError(
                                f"Model did not return valid JSON for {response_model.__name__}"
                            ) from exc
                        logger.warning(
                            "Malformed JSON (attempt %s). Retrying with backoff...",
                            attempt + 1,
                        )
                        time.sleep(0.5 + random.uniform(0, 0.5))
                        continue

                    # Validation Layer
                    try:
                        validated = response_model.model_validate(data)
                        logger.info(
                            "Validation status: success | model=%s | total_time=%.2fs",
                            self._model,
                            time.time() - start_time,
                        )
                        logger.info("Final model used: %s", self._model)
                        return validated
                    except ValidationError as exc:
                        logger.warning(
                            "Validation failed on %s. Missing/invalid fields. "
                            "Attempting repair or fallback...",
                            self._model,
                        )
                        # For now we treat validation failure as a signal to try next model
                        # (more advanced per-field regeneration can be added later)
                        break

                except APIError as exc:
                    last_exception = exc
                    status = getattr(exc, "status_code", None)

                    if status in (401, 403):
                        logger.error(
                            "Authentication/forbidden error (%s) on model %s. "
                            "Aborting all fallbacks.",
                            status,
                            self._model,
                        )
                        raise RuntimeError(
                            f"Authentication error ({status}). Check your OPENROUTER_API_KEY."
                        ) from exc

                    if status == 429:
                        logger.warning("Model failed with 429 on %s", self._model)
                        retry_after = 0
                        if hasattr(exc, "response") and exc.response is not None:
                            retry_after = int(
                                exc.response.headers.get("Retry-After", 0) or 0
                            )
                        if retry_after > 0:
                            time.sleep(retry_after)
                        else:
                            time.sleep((2 ** attempt) * 0.5 + random.uniform(0, 0.5))
                        continue

                    if status in (400, 404):
                        logger.warning(
                            "Model unavailable (%s) on %s. Switching to fallback...",
                            status,
                            self._model,
                        )
                        break

                    if status in (408, 500, 502, 503, 504):
                        logger.warning(
                            "Server error (%s) on %s. Retrying with backoff...",
                            status,
                            self._model,
                        )
                        time.sleep((2 ** attempt) * 0.5 + random.uniform(0, 0.5))
                        continue

                    logger.warning(
                        "API error (%s) on %s. Switching to fallback...",
                        status,
                        self._model,
                    )
                    break

                except Exception as exc:
                    last_exception = exc
                    logger.warning(
                        "Unexpected error on model %s: %s. Trying next fallback...",
                        self._model,
                        exc,
                    )
                    break

        raise RuntimeError(
            f"All fallback models exhausted for {response_model.__name__}. "
            f"Last error: {last_exception}"
        ) from last_exception

    def _repair_json(self, text: str) -> str:
        """Lightweight JSON repair for common model mistakes."""
        text = text.strip()
        # Remove trailing commas before } or ]
        text = re.sub(r",\s*([}\]])", r"\1", text)
        # Remove control characters that break JSON
        text = re.sub(r"[\x00-\x1F]+", "", text)
        return text


def _strip_code_fences(text: str) -> str:
    """Remove markdown code fences if present."""
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        return "\n".join(lines).strip()
    return text


def build_default_client() -> LLMClient:
    """Factory used by the rest of the application."""
    model = os.environ.get("CIE_MODEL", "meta-llama/llama-3.3-70b-instruct:free")
    return OpenRouterLLMClient(model=model)
