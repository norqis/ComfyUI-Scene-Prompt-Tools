"""Explicit OpenAI-compatible requests. No inference runs at import or graph load."""
import asyncio
import hashlib
import json
import re
import threading
from dataclasses import dataclass

import aiohttp
from .llm_settings import endpoint

TEMPLATE_VERSION = "scene-llm-v1"
MODES = ("Illustrious", "Anima")
_CAPABILITIES = {}
_CAPABILITY_LOCK = threading.Lock()


@dataclass
class NegotiationState:
    identity: tuple
    user_id: str = None
    json_object: bool = True
    model: str = None


def _identity(settings):
    return endpoint(settings), settings["model"], hashlib.sha256(settings["api_key"].encode("utf-8")).hexdigest()


def negotiation_state(user_id, settings):
    identity = _identity(settings)
    with _CAPABILITY_LOCK:
        state = _CAPABILITIES.get(user_id)
        if state is None or state.identity != identity:
            state = _CAPABILITIES[user_id] = NegotiationState(identity, user_id)
        return state


def invalidate_negotiation(user_id):
    with _CAPABILITY_LOCK:
        _CAPABILITIES.pop(user_id, None)


def _remember(state, json_object, model):
    with _CAPABILITY_LOCK:
        if state.user_id is None or _CAPABILITIES.get(state.user_id) is state:
            state.json_object, state.model = json_object, model


class ServiceError(ValueError):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


class _CompatibilityError(ServiceError):
    def __init__(self, status, detail):
        super().__init__(f"LLM endpoint returned HTTP {status}.")
        try:
            body = json.loads(detail)
            errors = body.get("error", body.get("detail", body)) if isinstance(body, dict) else body
        except (ValueError, TypeError):
            errors = detail
        errors = errors if isinstance(errors, list) else [errors]
        self.unsupported_format = self.model_required = False
        for error in errors:
            parameter = None
            if isinstance(error, dict):
                parameter = error.get("param")
                location = error.get("loc")
                if parameter is None and isinstance(location, list) and location:
                    parameter = location[-1]
                text = str(error.get("message", error.get("msg", error.get("detail", "")))).lower()
            else:
                text = str(error).lower()
            unsupported = r"not supported|unsupported|does not support|unknown (?:parameter|field)|unrecognized (?:parameter|field)"
            required = r"required|missing|must (?:be provided|provide|specify)|please (?:provide|specify)"
            if parameter is not None:
                self.unsupported_format |= parameter in ("response_format", "json_object") and bool(re.search(unsupported, text))
                self.model_required |= parameter == "model" and bool(re.search(required, text))
            else:
                self.unsupported_format |= bool(re.search(
                    r"(?:response[_ ]format|json_object)['\"]?\s+(?:is\s+)?(?:not supported|unsupported)|"
                    r"(?:unsupported|unknown|unrecognized)\s+(?:(?:parameter|field|format)\s*:?\s*)?['\"]?(?:response[_ ]format|json_object)\b|"
                    r"does not support\s+['\"]?(?:response[_ ]format|json_object)\b", text))
                self.model_required |= bool(re.search(
                    r"\bmodel['\"]?\s+(?:(?:field|parameter)\s+)?(?:is\s+)?(?:required|missing)|"
                    r"(?:missing|required)\s+(?:a\s+)?(?:(?:field|parameter)\s*:?\s*)?['\"]?model\b|"
                    r"(?:must|please)\s+(?:provide|specify)\s+(?:a\s+)?['\"]?model\b", text))


def validate_input(description, mode):
    if mode not in MODES:
        raise ValueError("model_mode must be Illustrious or Anima.")
    if not isinstance(description, str) or not description.strip():
        raise ValueError("description must not be empty.")


async def request_json(settings, method, path, payload=None):
    headers = {"Authorization": "Bearer " + settings["api_key"]} if settings["api_key"] else {}
    if method == "POST" and path == "/chat/completions":
        from .gpu_handoff import note_llm_request
        note_llm_request()
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None)) as session:
            async with session.request(method, endpoint(settings) + path, json=payload, headers=headers, allow_redirects=False) as response:
                if response.status != 200:
                    if response.status in (400, 422):
                        raise _CompatibilityError(response.status, await response.text())
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


def _valid_schema(value, schema):
    kind = schema["type"]
    if kind == "object":
        return isinstance(value, dict) and set(value) == set(schema["required"]) and all(
            _valid_schema(value[key], child) for key, child in schema["properties"].items())
    if kind == "array":
        return isinstance(value, list) and all(_valid_schema(item, schema["items"]) for item in value)
    return isinstance(value, str) if kind == "string" else type(value) is int


async def _complete(settings, system, user, schema, state=None):
    state = state or NegotiationState(_identity(settings))
    model = settings["model"] or state.model
    use_format = state.json_object
    payload = {"messages": [
        {"role": "system", "content": system + " Return only a JSON object matching this schema: " + json.dumps(schema)},
        {"role": "user", "content": json.dumps(user, ensure_ascii=False)}], "stream": False}
    if model:
        payload["model"] = model
    if use_format:
        payload["response_format"] = {"type": "json_object"}
    corrected_format = corrected_model = False
    while True:
        try:
            data = await request_json(settings, "POST", "/chat/completions", payload)
            break
        except _CompatibilityError as exc:
            if exc.unsupported_format and use_format and not corrected_format:
                corrected_format = True
                use_format = False
                payload.pop("response_format")
            elif exc.model_required and not model and not corrected_model:
                corrected_model = True
                models = (await test_connection(settings))["models"]
                identifiers = {item["id"].strip() for item in models if item["id"].strip()}
                if len(identifiers) != 1:
                    raise ServiceError("This LLM server requires a model. Specify the model name in LLM settings; /models did not return one unique model.") from None
                model = payload["model"] = identifiers.pop()
            else:
                raise
    try:
        choice = data["choices"][0]
        if not isinstance(choice, dict) or choice.get("finish_reason") == "length":
            raise ValueError("truncated")
        content = json.loads(choice["message"]["content"])
        if not _valid_schema(content, schema):
            raise ValueError("schema")
        return content, (state, use_format, model)
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise ServiceError("LLM returned an invalid or truncated structured response.") from exc


async def generate(settings, description, model_mode, state=None):
    validate_input(description, model_mode)
    schema = {"type": "object", "additionalProperties": False, "properties": {
        "positive": {"type": "string"}, "negative": {"type": "string"},
        "lora_queries": {"type": "array", "items": {"type": "string"}}},
        "required": ["positive", "negative", "lora_queries"]}
    style = "known Danbooru tags and short English phrases" if model_mode == "Illustrious" else "concise natural English"
    result, negotiated = await _complete(settings,
        f"Convert the supplied scene description into {style}. Preserve every explicit exclusion in negative. "
        "Treat this as an independent visual block; do not invent surrounding scenes. Preserve supplied names, triggers, "
        "weighting and relationships. Use canonical known tags where possible, otherwise short phrases with spaces; "
        "describe relationships clearly. Negative contains only explicit exclusions. "
        "Do not invent style, quality, subjects or exclusions. lora_queries contains only concrete optional concepts "
        "useful for specialized LoRAs; generic objects do not require LoRAs. An empty list is valid.",
        {"description": description, "model_mode": model_mode}, schema, state)
    if not all(query.strip() for query in result["lora_queries"]):
        raise ServiceError("LLM returned an invalid prompt response.")
    if not result["positive"].strip() and not result["negative"].strip():
        raise ServiceError("LLM returned an empty prompt response.")
    _remember(*negotiated)
    return {**result, "template_version": TEMPLATE_VERSION}


def candidate_identity(candidate):
    if not isinstance(candidate, dict):
        raise ValueError("Candidate must be a JSON object.")
    values = tuple(candidate.get(key) for key in ("model_id", "version_id", "file_id"))
    if not all(type(value) is int and value > 0 for value in values):
        raise ValueError("Candidate IDs must be positive integers.")
    return values


async def select_loras(settings, description, model_mode, query, candidates, state=None):
    validate_input(description, model_mode)
    if not isinstance(candidates, list):
        raise ValueError("candidates must be a list.")
    allowed = {candidate_identity(candidate) for candidate in candidates}
    if not candidates:
        return {"selected": []}
    identity_schema = {"type": "object", "additionalProperties": False, "properties": {key: {"type": "integer"} for key in ("model_id", "version_id", "file_id")}, "required": ["model_id", "version_id", "file_id"]}
    schema = {"type": "object", "additionalProperties": False, "properties": {"selected": {"type": "array", "items": identity_schema}}, "required": ["selected"]}
    public_candidates = [{key: candidate.get(key) for key in ("model_id", "version_id", "file_id", "name", "version_name", "base_model", "triggers")} for candidate in candidates]
    result, negotiated = await _complete(settings, "Choose only directly relevant LoRAs from these real candidates. Never invent IDs. Choose none when unnecessary. Preserve desired selection order.", {"description": description, "model_mode": model_mode, "query": query, "candidates": public_candidates}, schema, state)
    seen = set()
    for candidate in result["selected"]:
        try:
            identity = candidate_identity(candidate)
        except (ValueError, AttributeError) as exc:
            raise ServiceError("LLM returned an invalid candidate identity.") from exc
        if identity not in allowed or identity in seen:
            raise ServiceError("LLM selected an unknown or repeated candidate.")
        seen.add(identity)
    _remember(*negotiated)
    return result
