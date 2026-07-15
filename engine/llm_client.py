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
import time
from abc import ABC, abstractmethod
from typing import Optional, Type, TypeVar

from openai import OpenAI, APIError
from pydantic import BaseModel

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
    """Production-grade OpenRouter client using the OpenAI-compatible API."""

    FALLBACK_MODELS = [
        "meta-llama/llama-3.3-70b-instruct:free",
        "qwen/qwen3-next-80b-a3b-instruct:free",
        "nvidia/nemotron-3-ultra-550b-a55b:free",
        "tencent/hy3:free",
    ]

    def __init__(
        self,
        model: str = "meta-llama/llama-3.3-70b-instruct:free",
        api_key: Optional[str] = None,
        base_url: str = "https://openrouter.ai/api/v1",
        timeout: float = 30.0,
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

        for model in models_to_try:
            self._model = model
            for attempt in range(3):
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
                        raise ValueError("OpenRouter returned empty content.")

                    raw_text = _strip_code_fences(content.strip())

                    if not raw_text:
                        raise ValueError("OpenRouter returned empty or whitespace-only content.")

                    try:
                        data = json.loads(raw_text)
                    except json.JSONDecodeError as exc:
                        if attempt == 2:
                            raise ValueError(
                                f"Model did not return valid JSON for {response_model.__name__}. "
                                f"Raw output:\n{raw_text}"
                            ) from exc
                        logger.warning(
                            "Malformed JSON received from OpenRouter (attempt %s). Retrying...",
                            attempt + 1,
                        )
                        time.sleep(0.5 + random.uniform(0, 0.5))
                        continue

                    return response_model.model_validate(data)

                except APIError as exc:
                    last_exception = exc
                    if getattr(exc, "status_code", None) == 429:
                        retry_after = 0
                        if hasattr(exc, "response") and exc.response is not None:
                            retry_after = int(exc.response.headers.get("Retry-After", 0) or 0)
                        sleep_time = retry_after or ((2 ** attempt) * 0.5 + random.uniform(0, 0.5))
                        logger.warning(
                            "429 from %s. Sleeping %.1fs...", self._model, sleep_time
                        )
                        time.sleep(sleep_time)
                        continue
                    raise

                except Exception as exc:
                    last_exception = exc
                    if attempt == 2:
                        break
                    time.sleep(0.5 + random.uniform(0, 0.5))

        raise RuntimeError(
            f"All fallback models failed for {response_model.__name__}. "
            f"Last error: {last_exception}"
        ) from last_exception


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
    """Factory function used by the rest of the application."""
    model = os.environ.get("CIE_MODEL", "meta-llama/llama-3.3-70b-instruct:free")
    return OpenRouterLLMClient(model=model)
