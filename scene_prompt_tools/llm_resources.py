"""Explicit, confirmed model release through local providers' resource APIs.

Detection only reads provider state. No provider identity or credentials are cached,
and callers decide when resource control is enabled.
"""
import asyncio
import json

import aiohttp

from .llm_service import ServiceError
from .llm_settings import endpoint


class ResourceError(ServiceError):
    """A requested release could not be confirmed."""


def _text(value):
    return isinstance(value, str) and bool(value.strip())


class _Client:
    def __init__(self, session, settings):
        self.session = session
        self.openai_url = endpoint(settings)
        # Replace only the OpenAI version suffix, preserving a reverse proxy path.
        self.native_url = self.openai_url[:-3] if self.openai_url.endswith("/v1") else self.openai_url
        self.model = settings.get("model", "").strip()
        api_key = settings.get("api_key", "")
        self.headers = {"Authorization": "Bearer " + api_key} if api_key else {}

    async def request(self, method, url, payload=None, *, probe=False):
        try:
            async with self.session.request(method, url, json=payload, headers=self.headers,
                                            allow_redirects=False) as response:
                if probe and response.status in (404, 405):
                    return None
                if response.status != 200:
                    raise ResourceError(f"LLM resource API returned HTTP {response.status}.")
                try:
                    data = await response.json()
                except (aiohttp.ContentTypeError, json.JSONDecodeError, UnicodeDecodeError):
                    # Some servers serve their HTML UI on unknown read-only paths.
                    if probe:
                        return None
                    raise ResourceError("LLM resource API returned invalid JSON.") from None
                if not isinstance(data, dict):
                    if probe:
                        return None
                    raise ResourceError("LLM resource API returned an invalid response.")
                if data.get("error") is not None:
                    raise ResourceError("LLM resource API returned an error response.")
                return data
        except (aiohttp.ClientError, asyncio.TimeoutError):
            raise ResourceError("LLM resource API connection failed or timed out.") from None


def _result(provider, model, target, already_unloaded=False):
    return {"provider": provider, "model": model, "target": target,
            "released": True, "already_unloaded": already_unloaded}


class _Strata:
    name = "strata"

    @staticmethod
    def state(data):
        if not isinstance(data, dict) or data.get("service") != "strata" or type(data.get("loaded")) is not bool:
            raise ResourceError("Strata returned an invalid resource status.")
        if data.get("model") is not None and not _text(data["model"]):
            raise ResourceError("Strata returned an invalid model identifier.")
        activity = data.get("activity")
        if isinstance(activity, dict) and activity.get("in_flight"):
            raise ResourceError("Strata is busy with a running or queued request.")
        return data

    async def detect(self, client):
        data = await client.request("GET", client.openai_url + "/status", probe=True)
        return self.state(data) if data and data.get("service") == self.name else None

    async def unload(self, client, state):
        model = state.get("model") or client.model or None
        if client.model and state.get("model") and client.model != state["model"]:
            raise ResourceError("The configured model does not match Strata's model.")
        if not state["loaded"]:
            return _result(self.name, model, model, True)
        data = await client.request("POST", client.openai_url + "/unload", {"model": model} if model else {})
        if data.get("status") not in ("unloaded", "not loaded"):
            raise ResourceError("Strata did not accept the model release.")
        after = self.state(await client.request("GET", client.openai_url + "/status"))
        if after["loaded"] or (model and after.get("model") and model != after["model"]):
            raise ResourceError("Strata model release could not be confirmed.")
        return _result(self.name, model, model)


def _ollama_name(name):
    # A missing tag means latest; a registry's port is not a model tag.
    return name if ":" in name.rsplit("/", 1)[-1] else name + ":latest"


class _Ollama:
    name = "ollama"

    @staticmethod
    def state(data):
        if not isinstance(data, dict) or not isinstance(data.get("models"), list):
            raise ResourceError("Ollama returned an invalid running-model response.")
        for model in data["models"]:
            if not isinstance(model, dict) or not _text(model.get("model")) or not _text(model.get("name")):
                raise ResourceError("Ollama returned an invalid model identifier.")
        return data["models"]

    async def detect(self, client):
        data = await client.request("GET", client.native_url + "/api/version", probe=True)
        if not data or not _text(data.get("version")):
            return None
        return self.state(await client.request("GET", client.native_url + "/api/ps"))

    @staticmethod
    def matches(model, name):
        return _ollama_name(name) in {_ollama_name(model["model"]), _ollama_name(model["name"])}

    async def unload(self, client, state):
        matches = [item for item in state if not client.model or self.matches(item, client.model)]
        if not matches:
            return _result(self.name, client.model or None, client.model or None, True)
        if len(matches) != 1:
            raise ResourceError("Ollama has multiple matching loaded models. Specify one model in LLM settings.")
        model = matches[0]["model"]
        data = await client.request("POST", client.native_url + "/api/generate",
                                    {"model": model, "prompt": "", "keep_alive": 0, "stream": False})
        if data.get("done") is not True or data.get("done_reason") != "unload" or not _text(data.get("model")) or not self.matches(matches[0], data["model"]):
            raise ResourceError("Ollama did not accept the model release.")
        after = self.state(await client.request("GET", client.native_url + "/api/ps"))
        if any(self.matches(item, model) or self.matches(item, matches[0]["name"]) for item in after):
            raise ResourceError("Ollama model release could not be confirmed.")
        return _result(self.name, model, model)


class _LMStudio:
    name = "lmstudio"

    @staticmethod
    def state(data):
        if not isinstance(data, dict) or not isinstance(data.get("models"), list):
            raise ResourceError("LM Studio returned an invalid resource-model response.")
        for model in data["models"]:
            if not isinstance(model, dict) or model.get("type") not in ("llm", "embedding") or not _text(model.get("key")) or not isinstance(model.get("loaded_instances"), list):
                raise ResourceError("LM Studio returned an invalid model identifier or instance list.")
            if any(not isinstance(instance, dict) or not _text(instance.get("id")) for instance in model["loaded_instances"]):
                raise ResourceError("LM Studio returned an invalid loaded-instance identifier.")
        return data["models"]

    async def detect(self, client):
        data = await client.request("GET", client.native_url + "/api/v1/models", probe=True)
        if not data or not isinstance(data.get("models"), list):
            return None
        # This native schema includes model types, keys and loaded instances.
        return self.state(data)

    async def unload(self, client, state):
        instances = [(model, instance["id"]) for model in state for instance in model["loaded_instances"]]
        explicit = [(model, instance_id) for model, instance_id in instances if client.model and instance_id == client.model]
        if explicit:
            matches = explicit
        else:
            models = [model for model in state if model["type"] == "llm" and (not client.model or model["key"] == client.model)]
            matches = [(model, instance["id"]) for model in models for instance in model["loaded_instances"]]
        if any(model["type"] != "llm" for model, _ in matches) or any(model["type"] != "llm" and model["key"] == client.model for model in state):
            raise ResourceError("The configured LM Studio model is not an LLM.")
        if not matches:
            return _result(self.name, client.model or None, client.model or None, True)
        if len(matches) != 1:
            raise ResourceError("LM Studio has multiple matching loaded instances. Specify one instance in LLM settings.")
        model, instance_id = matches[0]
        data = await client.request("POST", client.native_url + "/api/v1/models/unload", {"instance_id": instance_id})
        if data.get("instance_id") != instance_id:
            raise ResourceError("LM Studio did not accept the model instance release.")
        after = self.state(await client.request("GET", client.native_url + "/api/v1/models"))
        if any(instance["id"] == instance_id for item in after for instance in item["loaded_instances"]) or (
                not explicit and any(item["key"] == model["key"] and item["loaded_instances"] for item in after)):
            raise ResourceError("LM Studio model instance release could not be confirmed.")
        return _result(self.name, model["key"], instance_id)


_ADAPTERS = (_Strata(), _Ollama(), _LMStudio())


async def _detect(client):
    for adapter in _ADAPTERS:
        state = await adapter.detect(client)
        if state is not None:
            return adapter, state
    raise ResourceError("This LLM provider does not expose a supported model release API (Strata, Ollama or LM Studio).")


async def detect_provider(settings):
    """Return a positively identified provider name without loading or releasing it."""
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None)) as session:
        adapter, _ = await _detect(_Client(session, settings))
        return adapter.name


async def unload_llm(settings):
    """Release only the configured or unique loaded target and confirm its absence.

    The returned descriptor contains no endpoint, credentials or provider body.
    No timeout, polling loop, process termination or inference is introduced.
    """
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None)) as session:
        client = _Client(session, settings)
        adapter, state = await _detect(client)
        return await adapter.unload(client, state)
