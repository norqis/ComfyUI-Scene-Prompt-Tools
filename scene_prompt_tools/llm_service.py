"""Explicit OpenAI-compatible requests. No inference runs at import or graph load."""
import asyncio
import json

import aiohttp

TEMPLATE_VERSION = "scene-llm-v1"
MODES = ("Illustrious", "Anima")


class ServiceError(ValueError):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def validate_input(description, mode):
    if mode not in MODES:
        raise ValueError("model_mode must be Illustrious or Anima.")
    if not isinstance(description, str) or not description.strip():
        raise ValueError("description must not be empty.")


async def request_json(settings, method, path, payload=None):
    headers = {"Authorization": "Bearer " + settings["api_key"]} if settings["api_key"] else {}
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=settings["timeout_seconds"])) as session:
            async with session.request(method, settings["base_url"] + path, json=payload, headers=headers, allow_redirects=False) as response:
                if response.status != 200:
                    raise ServiceError(f"LLM endpoint returned HTTP {response.status}.")
                return await response.json()
    except (aiohttp.ClientError, asyncio.TimeoutError, json.JSONDecodeError) as exc:
        raise ServiceError("LLM connection failed, timed out, or returned invalid JSON.") from exc


async def test_connection(settings):
    data = await request_json(settings, "GET", "/models")
    if not isinstance(data, dict) or not isinstance(data.get("data"), list):
        raise ServiceError("LLM returned an invalid models response.")
    models = [{"id": item["id"]} for item in data.get("data", []) if isinstance(item, dict) and isinstance(item.get("id"), str)]
    return {"ok": True, "models": models, "model": settings["model"]}


async def _complete(settings, system, user, schema):
    if not settings["model"].strip():
        raise ValueError("Configure an LLM model first.")
    payload = {"model": settings["model"], "messages": [
        {"role": "system", "content": system + " Return only a JSON object matching this schema: " + json.dumps(schema)},
        {"role": "user", "content": json.dumps(user, ensure_ascii=False)}], "temperature": 0.2,
        "max_tokens": settings.get("max_tokens", 8192), "stream": False}
    if settings.get("reasoning_effort"):
        payload["reasoning_effort"] = settings["reasoning_effort"]
    format_mode = settings["response_format"]
    if format_mode == "json_object":
        payload["response_format"] = {"type": "json_object"}
    elif format_mode == "json_schema":
        payload["response_format"] = {"type": "json_schema", "json_schema": {"name": "scene_prompt", "strict": True, "schema": schema}}
    data = await request_json(settings, "POST", "/chat/completions", payload)
    try:
        choice = data["choices"][0]
        if choice.get("finish_reason") == "length":
            raise ValueError("truncated")
        content = json.loads(choice["message"]["content"])
        if not isinstance(content, dict) or set(content) != set(schema["required"]):
            raise ValueError("schema")
        return content
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise ServiceError("LLM returned an invalid or truncated structured response.") from exc


async def generate(settings, description, model_mode):
    validate_input(description, model_mode)
    schema = {"type": "object", "additionalProperties": False, "properties": {
        "positive": {"type": "string"}, "negative": {"type": "string"},
        "lora_queries": {"type": "array", "items": {"type": "string"}}},
        "required": ["positive", "negative", "lora_queries"]}
    style = "known Danbooru tags and short English phrases" if model_mode == "Illustrious" else "concise natural English"
    result = await _complete(settings,
        f"Convert the supplied scene description into {style}. Preserve every explicit exclusion in negative. "
        "Treat this as an independent visual block; do not invent surrounding scenes. Preserve supplied names, triggers, "
        "weighting and relationships. Use canonical known tags where possible, otherwise short phrases with spaces; "
        "describe relationships clearly. Negative contains only explicit exclusions. "
        "Do not invent style, quality, subjects or exclusions. lora_queries contains only concrete optional concepts "
        "useful for specialized LoRAs; generic objects do not require LoRAs. An empty list is valid.",
        {"description": description, "model_mode": model_mode}, schema)
    if not all(isinstance(result[key], str) for key in ("positive", "negative")) or not isinstance(result["lora_queries"], list) or not all(isinstance(query, str) and query.strip() for query in result["lora_queries"]):
        raise ServiceError("LLM returned an invalid prompt response.")
    if not result["positive"].strip() and not result["negative"].strip():
        raise ServiceError("LLM returned an empty prompt response.")
    return {**result, "template_version": TEMPLATE_VERSION}


def candidate_identity(candidate):
    if not isinstance(candidate, dict):
        raise ValueError("Candidate must be a JSON object.")
    values = tuple(candidate.get(key) for key in ("model_id", "version_id", "file_id"))
    if not all(type(value) is int and value > 0 for value in values):
        raise ValueError("Candidate IDs must be positive integers.")
    return values


async def select_loras(settings, description, model_mode, query, candidates):
    validate_input(description, model_mode)
    if not isinstance(candidates, list) or len(candidates) > 120:
        raise ValueError("candidates must be a list of at most 120 items.")
    allowed = {candidate_identity(candidate) for candidate in candidates}
    if not candidates:
        return {"selected": []}
    identity_schema = {"type": "object", "additionalProperties": False, "properties": {key: {"type": "integer"} for key in ("model_id", "version_id", "file_id")}, "required": ["model_id", "version_id", "file_id"]}
    schema = {"type": "object", "additionalProperties": False, "properties": {"selected": {"type": "array", "items": identity_schema}}, "required": ["selected"]}
    public_candidates = [{key: candidate.get(key) for key in ("model_id", "version_id", "file_id", "name", "version_name", "base_model", "triggers")} for candidate in candidates]
    result = await _complete(settings, "Choose only directly relevant LoRAs from these real candidates. Never invent IDs. Choose none when unnecessary. Preserve desired selection order.", {"description": description, "model_mode": model_mode, "query": query, "candidates": public_candidates}, schema)
    if not isinstance(result["selected"], list):
        raise ServiceError("LLM returned an invalid LoRA selection.")
    seen = set()
    for candidate in result["selected"]:
        try:
            identity = candidate_identity(candidate)
        except (ValueError, AttributeError) as exc:
            raise ServiceError("LLM returned an invalid candidate identity.") from exc
        if identity not in allowed or identity in seen or set(candidate) != set(identity_schema["required"]):
            raise ServiceError("LLM selected an unknown or repeated candidate.")
        seen.add(identity)
    return result
