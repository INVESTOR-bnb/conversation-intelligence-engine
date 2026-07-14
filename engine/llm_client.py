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
    """Implementation backed by the Google Gemini API.

    Requires the `google-generativeai` package and a GEMINI_API_KEY environment
    variable. This is intentionally the only place in the codebase that
    imports the Gemini SDK.
    """

    def __init__(self, model: str = "gemini-1.5-flash", api_key: Optional[str] = None):
        try:
            import google.generativeai as genai  # local import: keeps the dependency optional
        except ImportError as e:
            raise ImportError(
                "The 'google-generativeai' package is required for GeminiLLMClient. "
                "Install it with: pip install google-generativeai"
            ) from e

        key = api_key or os.environ.get("GEMINI_API_KEY")
        if not key:
            raise ValueError(
                "No API key found. Set GEMINI_API_KEY as an environment variable "
                "or pass api_key explicitly."
            )

        genai.configure(api_key=key)
        self._model_name = model
        self._model = genai.GenerativeModel(model)

    def generate_structured(
        self,
        system_prompt: str,
        user_prompt: str,
        response_model: Type[T],
    ) -> T:
        schema = response_model.model_json_schema()
        full_system = (
            f"{system_prompt}\n\n"
            "You must respond with ONLY valid JSON matching this JSON schema, "
            "with no preamble, no markdown code fences, and no commentary:\n\n"
            f"{json.dumps(schema, indent=2)}"
        )

        last_exception = None

        for attempt in range(2):  # Simple retry on transient/JSON failures
            try:
                response = self._model.generate_content(
                    contents=user_prompt,
                    system_instruction=full_system,
                    generation_config={
                        "response_mime_type": "application/json",
                        "max_output_tokens": 4000,
                    },
                    request_options={"timeout": 30},  # Important for Railway
                )

                # Handle blocked / safety filtered responses
                if response.prompt_feedback and response.prompt_feedback.block_reason:
                    raise ValueError(
                        f"Gemini blocked the response due to: {response.prompt_feedback.block_reason}"
                    )

                raw_text = getattr(response, "text", "") or ""
                raw_text = _strip_code_fences(raw_text).strip()

                if not raw_text:
                    raise ValueError("Gemini returned an empty response.")

                try:
                    data = json.loads(raw_text)
                except json.JSONDecodeError as e:
                    if attempt == 1:  # Last attempt
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

        # If we reach here, all attempts failed
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
    """Factory used by the UI to build whichever client is configured.

    Centralizing this means the UI layer never needs to know which
    concrete LLMClient implementation is active.
    """
    model = os.environ.get("CIE_MODEL", "gemini-1.5-flash")
    return GeminiLLMClient(model=model)        raise NotImplementedError


class AnthropicLLMClient(LLMClient):
    """Default implementation backed by the Anthropic Messages API.

    Requires the `anthropic` package and an ANTHROPIC_API_KEY environment
    variable. This is intentionally the only place in the codebase that
    imports the anthropic SDK.
    """

    def __init__(self, model: str = "claude-sonnet-4-6", api_key: Optional[str] = None):
        try:
            import anthropic  # local import: keeps the dependency optional
        except ImportError as e:
            raise ImportError(
                "The 'anthropic' package is required for AnthropicLLMClient. "
                "Install it with: pip install anthropic"
            ) from e

        key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            raise ValueError(
                "No API key found. Set ANTHROPIC_API_KEY as an environment variable "
                "or pass api_key explicitly."
            )

        self._client = anthropic.Anthropic(api_key=key)
        self._model = model

    def generate_structured(
        self,
        system_prompt: str,
        user_prompt: str,
        response_model: Type[T],
    ) -> T:
        schema = response_model.model_json_schema()
        full_system = (
            f"{system_prompt}\n\n"
            "You must respond with ONLY valid JSON matching this JSON schema, "
            "with no preamble, no markdown code fences, and no commentary:\n\n"
            f"{json.dumps(schema, indent=2)}"
        )

        response = self._client.messages.create(
            model=self._model,
            max_tokens=4000,
            system=full_system,
            messages=[{"role": "user", "content": user_prompt}],
        )

        text_parts = [block.text for block in response.content if getattr(block, "type", None) == "text"]
        raw_text = "\n".join(text_parts).strip()
        raw_text = _strip_code_fences(raw_text)

        try:
            data = json.loads(raw_text)
        except json.JSONDecodeError as e:
            raise ValueError(
                f"Model did not return valid JSON for {response_model.__name__}. "
                f"Raw output:\n{raw_text}"
            ) from e

        return response_model.model_validate(data)


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
    """Factory used by the UI to build whichever client is configured.

    Centralizing this means the UI layer never needs to know which
    concrete LLMClient implementation is active.
    """
    model = os.environ.get("CIE_MODEL", "claude-sonnet-4-6")
    return AnthropicLLMClient(model=model)
