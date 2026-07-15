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
        raise NotImplementedError


class OpenRouterLLMClient(LLMClient):
    """Production-grade client for OpenRouter (OpenAI-compatible)."""

    FALLBACK_MODELS = [
        "meta-llama/llama-3.3-70b-instruct:free",
        "qwen/qwen2.5-72b-instruct:free",
        "mistralai/mistral-small-3.1-24b-instruct:free",
        "deepseek/deepseek-chat:free",
    ]

    def __init__(
        self,
        model: str = "meta-llama/llama-3.3-70b-instruct:free",
        api_key: Optional[str] = None,
        base_url: str = "https://openrouter.ai/api/v1",
        timeout: float = 30.0,
    ):
        key = api_key or os.environ.get("OPENROUTER_API_KEY")
        if not key:
            raise ValueError("OPENROUTER_API_KEY is required.")

        self._client = OpenAI(base_url=base_url, api_key=key, timeout=timeout)
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

        last_exception = None

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
                    if not content:
                        raise ValueError("Empty response from model")

                    raw_text = _strip_code_fences(content.strip())

                    try:
                        data = json.loads(raw_text)
                    except json.JSONDecodeError as e:
                        if attempt == 2:
                            raise ValueError(
                                f"Invalid JSON from {self._model} for {response_model.__name__}"
                            ) from e
                        logger.warning("Malformed JSON (attempt %s). Retrying...", attempt + 1)
                        time.sleep(0.5 + random.uniform(0, 0.5))
                        continue

                    return response_model.model_validate(data)

                except APIError as e:
                    last_exception = e
                    if getattr(e, "status_code", None) == 429:
                        retry_after = 0
                        if hasattr(e, "response") and e.response:
                            retry_after = int(e.response.headers.get("Retry-After", 0) or 0)
                        sleep_time = retry_after or ((2 ** attempt) * 0.5 + random.uniform(0, 0.5))
                        logger.warning("429 from %s. Sleeping %.1fs...", self._model, sleep_time)
                        time.sleep(sleep_time)
                        continue
                    raise

                except Exception as e:
                    last_exception = e
                    if attempt == 2:
                        break
                    time.sleep(0.5 + random.uniform(0, 0.5))

        raise RuntimeError(
            f"All fallback models failed for {response_model.__name__}. "
            f"Last error: {last_exception}"
        ) from last_exception


def _strip_code_fences(text: str) -> str:
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        return "\n".join(lines).strip()
    return text


def build_default_client() -> LLMClient:
    model = os.environ.get("CIE_MODEL", "meta-llama/llama-3.3-70b-instruct:free")
    return OpenRouterLLMClient(model=model)
