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
import time
from abc import ABC, abstractmethod
from typing import Optional, Type, TypeVar

from openai import OpenAI, APIError
from pydantic import BaseModel

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)


class LLMClient(ABC):
    """Abstract interface for a structured-output-capable LLM client.

    All concrete implementations (OpenRouter, OpenAI, Gemini, Anthropic, etc.)
    must implement this interface so that the rest of the system remains
    completely decoupled from any specific provider.
    """

    @abstractmethod
    def generate_structured(
        self,
        system_prompt: str,
        user_prompt: str,
        response_model: Type[T],
    ) -> T:
        """Generate a structured response and return a validated Pydantic model.

        The implementation must:
        - Force the model to return valid JSON matching the schema.
        - Never silently accept malformed output.
        - Raise clear, actionable exceptions on failure.
        """
        raise NotImplementedError


class OpenRouterLLMClient(LLMClient):
    """Production-grade OpenRouter client using the OpenAI-compatible API.

    Designed to be easily replaceable by other providers while keeping the
    public interface stable.
    """

    def __init__(self, model: str = "meta-llama/llama-3.3-70b-instruct:free", api_key: Optional[str] = None):
        base_url: str = "https://openrouter.ai/api/v1",
        timeout: float = 30.0,
    ) -> None:
        """Initialize the OpenRouter client.

        Args:
            model: Model identifier to use (can be overridden via CIE_MODEL env var).
            api_key: OpenRouter API key. Falls back to OPENROUTER_API_KEY env var.
            base_url: OpenRouter API endpoint.
            timeout: Request timeout in seconds.
        """
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
        self._model = model
        self._timeout = timeout

    def generate_structured(
        self,
        system_prompt: str,
        user_prompt: str,
        response_model: Type[T],
    ) -> T:
        """Generate structured output using OpenRouter's OpenAI-compatible endpoint.

        Uses JSON mode + explicit schema instructions for maximum reliability.
        Implements retry logic for transient JSON parsing failures.
        """
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]

        last_exception: Exception | None = None

        for attempt in range(2):  # Simple retry on JSON parsing issues
            try:
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
                    if attempt == 1:
                        raise ValueError(
                            f"Model did not return valid JSON for {response_model.__name__}. "
                            f"Raw output:\n{raw_text}"
                        ) from exc
                    logger.warning(
                        "Malformed JSON received from OpenRouter (attempt %s). Retrying...",
                        attempt + 1,
                    )
                    time.sleep(0.5)
                    continue

                return response_model.model_validate(data)

            except APIError as exc:
                last_exception = exc
                logger.warning("OpenRouter API error (attempt %s): %s", attempt + 1, exc)
                if attempt == 1:
                    break
                time.sleep(0.5)

            except Exception as exc:
                last_exception = exc
                if attempt == 1:
                    break
                logger.warning("Unexpected error (attempt %s): %s", attempt + 1, exc)
                time.sleep(0.5)

        raise RuntimeError(
            f"OpenRouterLLMClient failed after retries for model '{self._model}'. "
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
    """Factory function used by the rest of the application.

    The model can be overridden via the CIE_MODEL environment variable.
    This is the single point where the concrete LLM client is chosen.
    """
    model = os.environ.get("CIE_MODEL", "deepseek/deepseek-chat-v3-0324:free")
    return OpenRouterLLMClient(model=model)
