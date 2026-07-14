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


class GeminiLLMClient(LLMClient):
    """Implementation using the official google-genai SDK (Google AI Studio)."""

    def __init__(self, model: str = "gemini-2.0-flash", api_key: Optional[str] = None):
        try:
            from google import genai
            from google.genai import types
        except ImportError as e:
            raise ImportError(
                "The 'google-genai' package is required. "
                "Install it with: pip install google-genai"
            ) from e

        key = api_key or os.environ.get("GEMINI_API_KEY")
        if not key:
            raise ValueError(
                "No API key found. Set GEMINI_API_KEY as an environment variable "
                "or pass api_key explicitly."
            )

        self._client = genai.Client(api_key=key)
        self._model_name = model
        self._types = types

    def generate_structured(
        self,
        system_prompt: str,
        user_prompt: str,
        response_model: Type[T],
    ) -> T:
        from google.genai import types

        full_system = (
            f"{system_prompt}\n\n"
            "You must respond with ONLY valid JSON matching this JSON schema, "
            "with no preamble, no markdown code fences, and no commentary:\n\n"
            f"{json.dumps(response_model.model_json_schema(), indent=2)}"
        )

        combined_prompt = f"SYSTEM:\n{full_system}\n\nUSER:\n{user_prompt}"

        last_exception = None

        for attempt in range(2):
            try:
                config = types.GenerateContentConfig(
                    response_mime_type="application/json",
                    max_output_tokens=4000,
                )

                response = self._client.models.generate_content(
                    model=self._model_name,
                    contents=combined_prompt,
                    config=config,
                )

                if response.prompt_feedback and response.prompt_feedback.block_reason:
                    raise ValueError(
                        f"Gemini blocked the response due to: {response.prompt_feedback.block_reason}"
                    )

                raw_text = (response.text or "").strip()
                raw_text = _strip_code_fences(raw_text)

                if not raw_text:
                    raise ValueError("Gemini returned an empty response.")

                try:
                    data = json.loads(raw_text)
                except json.JSONDecodeError as e:
                    if attempt == 1:
                        raise ValueError(
                            f"Model did not return valid JSON for {response_model.__name__}. "
                            f"Raw output:\n{raw_text}"
                        ) from e
                    logger.warning("Malformed JSON from Gemini (attempt %s). Retrying...", attempt + 1)
                    time.sleep(0.5)
                    continue

                return response_model.model_validate(data)

            except Exception as e:
                last_exception = e
                if attempt == 1:
                    break
                logger.warning("Gemini call failed (attempt %s): %s. Retrying...", attempt + 1, str(e))
                time.sleep(0.5)

        raise RuntimeError(
            f"GeminiLLMClient failed after retries for model {self._model_name}. "
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
    model = os.environ.get("CIE_MODEL", "gemini-2.0-flash")
    return GeminiLLMClient(model=model)
