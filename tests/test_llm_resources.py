"""Provider resource APIs on ephemeral HTTP fixtures; no real model service is used."""
import asyncio
import importlib
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

import aiohttp
from aiohttp import web

ROOT = Path(__file__).resolve().parents[1]
package = types.ModuleType("scene_llm_resources_test")
package.__path__ = [str(ROOT / "scene_prompt_tools")]
sys.modules[package.__name__] = package
with mock.patch.dict(sys.modules, {"folder_paths": types.ModuleType("folder_paths")}):
    settings_module = importlib.import_module(package.__name__ + ".llm_settings")
    service_module = importlib.import_module(package.__name__ + ".llm_service")
    resources = importlib.import_module(package.__name__ + ".llm_resources")
sys.modules[package.__name__ + ".llm_settings"] = settings_module
sys.modules[package.__name__ + ".llm_service"] = service_module
sys.modules[package.__name__ + ".llm_resources"] = resources


def ollama_model(name):
    return {"name": name, "model": name, "digest": "fixture-digest", "size_vram": 1}


def lm_model(key="local", instances=("local-instance",), kind="llm"):
    return {"type": kind, "key": key,
            "loaded_instances": [{"id": identifier, "config": {}} for identifier in instances]}


class HttpFixture(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls = []
        self.responses = {}
        self.prefix = ""
        self.request_started = asyncio.Event()
        self.request_gate = None
        app = web.Application()
        app.router.add_route("*", "/{tail:.*}", self.handle)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        self.port = site._server.sockets[0].getsockname()[1]
        self.settings = {**settings_module.DEFAULTS, "port": self.port,
                         "model": "local", "api_key": "private-resource-secret"}

    async def asyncTearDown(self):
        if self.request_gate:
            self.request_gate.set()
        await self.runner.cleanup()

    def respond(self, method, path, *responses):
        self.responses[(method, self.prefix + path)] = list(responses)

    async def handle(self, request):
        payload = await request.json() if request.method == "POST" else None
        self.calls.append((request.method, request.path, payload, request.headers.get("Authorization")))
        self.request_started.set()
        if self.request_gate:
            await self.request_gate.wait()
        responses = self.responses.get((request.method, request.path), [])
        status, body = responses.pop(0) if responses else (404, {"error": "missing fixture path"})
        if status == 302:
            return web.json_response(body, status=status, headers={"Location": self.prefix + "/redirected"})
        if isinstance(body, str):
            return web.Response(text=body, status=status,
                                content_type="text/html" if body.startswith("<") else "application/json")
        return web.json_response(body, status=status)

    def strata(self, *, loaded=True, model="local", after_loaded=False):
        before = {"service": "strata", "loaded": loaded}
        after = {"service": "strata", "loaded": after_loaded}
        if model is not None:
            before["model"] = after["model"] = model
        self.respond("GET", "/v1/status", (200, before), (200, after))
        self.respond("POST", "/v1/unload", (200, {"status": "unloaded", **after}))

    def ollama(self, *, models=None, after=None):
        models = [ollama_model("local:latest")] if models is None else models
        self.respond("GET", "/api/version", (200, {"version": "0.5.1"}))
        self.respond("GET", "/api/ps", (200, {"models": models}), (200, {"models": after or []}))
        name = models[0]["model"] if models else "local:latest"
        self.respond("POST", "/api/generate", (200, {"model": name, "done": True, "done_reason": "unload"}))

    def lmstudio(self, *, models=None, after=None):
        models = [lm_model()] if models is None else models
        self.respond("GET", "/api/v1/models", (200, {"models": models}), (200, {"models": after or []}))
        self.respond("POST", "/api/v1/models/unload", (200, {"instance_id": "local-instance"}))

    def paths(self):
        return [(method, path) for method, path, _, _ in self.calls]

    async def assert_failure(self, message=None):
        with self.assertRaises(resources.ResourceError) as raised:
            await resources.unload_llm(self.settings)
        self.assertIsInstance(raised.exception, service_module.ServiceError)
        self.assertNotIn(self.settings["api_key"], str(raised.exception))
        if message:
            self.assertIn(message, str(raised.exception))
        return raised.exception


class ProviderResourceTest(HttpFixture):
    async def test_strata_release_is_confirmed_and_targeted(self):
        self.strata()
        result = await resources.unload_llm(self.settings)
        self.assertEqual(result, {"provider": "strata", "model": "local", "target": "local",
                                  "released": True, "already_unloaded": False})
        self.assertEqual(self.paths(), [("GET", "/v1/status"), ("POST", "/v1/unload"), ("GET", "/v1/status")])
        self.assertEqual(self.calls[1][2], {"model": "local"})
        self.assertTrue(all(call[3] == "Bearer private-resource-secret" for call in self.calls))

    async def test_strata_default_uses_status_model(self):
        self.settings["model"] = ""
        self.strata(model="runner-model")
        result = await resources.unload_llm(self.settings)
        self.assertEqual(result["model"], "runner-model")
        self.assertEqual(self.calls[1][2], {"model": "runner-model"})

    async def test_strata_single_engine_allows_missing_model(self):
        self.settings["model"] = ""
        self.strata(model=None)
        result = await resources.unload_llm(self.settings)
        self.assertIsNone(result["model"])
        self.assertEqual(self.calls[1][2], {})

    async def test_strata_already_unloaded_avoids_mutation(self):
        self.strata(loaded=False)
        result = await resources.unload_llm(self.settings)
        self.assertTrue(result["already_unloaded"])
        self.assertEqual(self.paths(), [("GET", "/v1/status")])

    async def test_strata_wrong_configured_model_is_never_unloaded(self):
        self.strata(model="other")
        await self.assert_failure("does not match")
        self.assertEqual(self.paths(), [("GET", "/v1/status")])

    async def test_strata_status_requires_boolean_loaded(self):
        self.respond("GET", "/v1/status", (200, {"service": "strata", "loaded": "false", "model": "local"}))
        await self.assert_failure("invalid resource status")
        self.assertEqual(len(self.calls), 1)

    async def test_ollama_native_release_empty_prompt_and_confirmation(self):
        self.ollama(after=[ollama_model("unrelated:latest")])
        result = await resources.unload_llm(self.settings)
        self.assertEqual(result["provider"], "ollama")
        self.assertEqual(result["target"], "local:latest")
        self.assertEqual(self.paths(), [("GET", "/v1/status"), ("GET", "/api/version"), ("GET", "/api/ps"),
                                       ("POST", "/api/generate"), ("GET", "/api/ps")])
        self.assertEqual(self.calls[3][2], {"model": "local:latest", "prompt": "", "keep_alive": 0, "stream": False})

    async def test_ollama_default_unique_loaded_model(self):
        self.settings["model"] = ""
        self.ollama()
        self.assertEqual((await resources.unload_llm(self.settings))["model"], "local:latest")

    async def test_ollama_missing_target_leaves_other_models_loaded(self):
        self.ollama(models=[ollama_model("other:latest")])
        result = await resources.unload_llm(self.settings)
        self.assertTrue(result["already_unloaded"])
        self.assertEqual(result["model"], "local")
        self.assertEqual(len(self.calls), 3)

    async def test_ollama_default_ambiguous_and_duplicate_targets_fail(self):
        for configured, models in [("", [ollama_model("a:latest"), ollama_model("b:latest")]),
                                   ("local", [ollama_model("local:latest"), ollama_model("local:latest")])]:
            with self.subTest(configured=configured):
                self.calls.clear()
                self.settings["model"] = configured
                self.ollama(models=models)
                await self.assert_failure("multiple matching")
                self.assertTrue(all(call[0] == "GET" for call in self.calls))

    async def test_ollama_alias_and_registry_port_are_resolved(self):
        self.settings["model"] = "registry.example:1234/org/local"
        self.ollama(models=[ollama_model("registry.example:1234/org/local:latest")])
        result = await resources.unload_llm(self.settings)
        self.assertEqual(result["target"], "registry.example:1234/org/local:latest")

    async def test_ollama_version_requires_positive_schema(self):
        self.respond("GET", "/api/version", (200, {"unexpected": "private-resource-secret"}))
        await self.assert_failure("supported model release API")
        self.assertNotIn(("GET", "/api/ps"), self.paths())
        self.assertTrue(all(call[0] == "GET" for call in self.calls))

    async def test_ollama_running_models_schema_required(self):
        self.ollama()
        self.respond("GET", "/api/ps", (200, {"models": [{"model": "local"}]}))
        await self.assert_failure("invalid model identifier")
        self.assertEqual(len(self.calls), 3)

    async def test_lmstudio_release_uses_instance_and_confirms(self):
        self.lmstudio(after=[lm_model("unrelated", ("other-instance",))])
        result = await resources.unload_llm(self.settings)
        self.assertEqual(result["provider"], "lmstudio")
        self.assertEqual(result["model"], "local")
        self.assertEqual(result["target"], "local-instance")
        self.assertEqual(self.paths(), [("GET", "/v1/status"), ("GET", "/api/version"), ("GET", "/api/v1/models"),
                                       ("POST", "/api/v1/models/unload"), ("GET", "/api/v1/models")])
        self.assertEqual(self.calls[3][2], {"instance_id": "local-instance"})

    async def test_lmstudio_default_unique_instance_ignores_embedding(self):
        self.settings["model"] = ""
        self.lmstudio(models=[lm_model(), lm_model("embedding", ("embed",), "embedding"), lm_model("idle", ())])
        self.assertEqual((await resources.unload_llm(self.settings))["target"], "local-instance")

    async def test_lmstudio_multiple_instances_can_use_explicit_id(self):
        self.settings["model"] = "local-instance"
        self.lmstudio(models=[lm_model(instances=("local-instance", "other-instance"))],
                      after=[lm_model(instances=("other-instance",))])
        self.assertEqual((await resources.unload_llm(self.settings))["target"], "local-instance")

    async def test_lmstudio_reloaded_model_key_cannot_confirm_release(self):
        self.lmstudio(after=[lm_model(instances=("replacement-instance",))])
        await self.assert_failure("could not be confirmed")
        self.assertEqual(self.calls[-1][0], "GET")

    async def test_lmstudio_ambiguous_key_or_default_is_not_unloaded(self):
        for configured, models in [("local", [lm_model(instances=("a", "b"))]),
                                   ("", [lm_model(), lm_model("second", ("b",))])]:
            with self.subTest(configured=configured):
                self.calls.clear()
                self.settings["model"] = configured
                self.lmstudio(models=models)
                await self.assert_failure("multiple matching")
                self.assertTrue(all(call[0] == "GET" for call in self.calls))

    async def test_lmstudio_embedding_target_is_rejected(self):
        self.lmstudio(models=[lm_model("local", ("embed",), "embedding")])
        await self.assert_failure("not an LLM")
        self.assertTrue(all(call[0] == "GET" for call in self.calls))

    async def test_lmstudio_incomplete_instance_schema_fails(self):
        self.respond("GET", "/api/v1/models", (200, {"models": [{"type": "llm", "key": "local"}]}))
        await self.assert_failure("invalid model identifier")
        self.assertTrue(all(call[0] == "GET" for call in self.calls))

    async def test_empty_running_state_is_already_released(self):
        for provider in (self.ollama, self.lmstudio):
            with self.subTest(provider=provider.__name__):
                self.responses.clear()
                self.calls.clear()
                self.settings["model"] = ""
                provider(models=[])
                result = await resources.unload_llm(self.settings)
                self.assertTrue(result["released"] and result["already_unloaded"])
                self.assertIsNone(result["target"])
                self.assertTrue(all(call[0] == "GET" for call in self.calls))

    async def test_lmstudio_unloaded_or_absent_target_avoids_mutation(self):
        for models in ([lm_model(instances=()), lm_model("other", ("other-instance",))],
                       [lm_model("other", ("other-instance",))]):
            with self.subTest(models=models):
                self.calls.clear()
                self.lmstudio(models=models)
                self.assertTrue((await resources.unload_llm(self.settings))["already_unloaded"])
                self.assertTrue(all(call[0] == "GET" for call in self.calls))

    async def test_false_success_still_loaded_fails_for_all_providers(self):
        for provider in ("strata", "ollama", "lmstudio"):
            with self.subTest(provider=provider):
                self.responses.clear()
                self.calls.clear()
                if provider == "strata":
                    self.strata(after_loaded=True)
                elif provider == "ollama":
                    self.ollama(after=[ollama_model("local:latest")])
                else:
                    self.lmstudio(after=[lm_model()])
                await self.assert_failure("could not be confirmed")
                self.assertEqual(self.calls[-1][0], "GET")

    async def test_false_200_acknowledgements_fail_before_confirmation(self):
        cases = [(self.strata, "/v1/unload", {"status": "unsupported"}),
                 (self.strata, "/v1/unload", {"status": "busy"}),
                 (self.ollama, "/api/generate", {"done": True, "model": "local:latest", "done_reason": "stop"}),
                 (self.ollama, "/api/generate", {"done": True, "model": "other", "done_reason": "unload"}),
                 (self.lmstudio, "/api/v1/models/unload", {"instance_id": "wrong"})]
        for fixture, path, data in cases:
            with self.subTest(path=path, data=data):
                self.responses.clear()
                self.calls.clear()
                fixture()
                self.respond("POST", path, (200, data))
                await self.assert_failure("did not accept")
                self.assertEqual(self.calls[-1][0], "POST")

    async def test_mutation_http_failures_remain_failures_and_hide_body(self):
        for status in (401, 403, 404, 405, 409, 500, 302):
            with self.subTest(status=status):
                self.calls.clear()
                self.strata()
                self.respond("POST", "/v1/unload", (status, {"error": "private-resource-secret"}))
                await self.assert_failure(f"HTTP {status}")
                self.assertEqual(len(self.calls), 2)

    async def test_probe_http_failure_is_not_masked_as_unsupported(self):
        for status in (401, 403, 409, 500, 302):
            with self.subTest(status=status):
                self.calls.clear()
                self.respond("GET", "/v1/status", (status, {"error": "private-resource-secret"}))
                await self.assert_failure(f"HTTP {status}")
                self.assertEqual(len(self.calls), 1)

    async def test_http_200_error_is_not_success_or_provider_fallback(self):
        for path, fixture in [("/v1/status", self.strata), ("/api/ps", self.ollama),
                              ("/api/v1/models", self.lmstudio)]:
            with self.subTest(path=path):
                self.responses.clear()
                self.calls.clear()
                fixture()
                self.respond("GET", path, (200, {"error": "private-resource-secret"}))
                await self.assert_failure("error response")
                self.assertEqual(self.calls[-1][1], path)
                self.assertTrue(all(call[0] == "GET" for call in self.calls))

    async def test_strata_busy_status_never_claims_already_released(self):
        self.respond("GET", "/v1/status", (200, {"service": "strata", "model": "local", "loaded": False,
                                                 "activity": {"in_flight": 1}}))
        await self.assert_failure("busy")
        self.assertEqual(len(self.calls), 1)

    async def test_bad_json_and_html_cannot_confirm_release(self):
        for response in ("{bad-json", "<html>private-resource-secret</html>", []):
            with self.subTest(response=response):
                self.calls.clear()
                self.strata()
                self.respond("GET", "/v1/status", (200, {"service": "strata", "loaded": True, "model": "local"}),
                             (200, response))
                await self.assert_failure("invalid")
                self.assertEqual(len(self.calls), 3)

    async def test_unknown_html_and_openai_only_server_never_mutate(self):
        for body in ("<html>UI</html>", "{bad-json", {"object": "list", "data": [{"id": "local"}]}, {"service": "unknown", "loaded": False}):
            with self.subTest(body=body):
                self.responses.clear()
                self.calls.clear()
                for path in ("/v1/status", "/api/version", "/api/v1/models"):
                    self.respond("GET", path, (200, body))
                await self.assert_failure("supported model release API")
                self.assertEqual(len(self.calls), 3)
                self.assertTrue(all(call[0] == "GET" for call in self.calls))

    async def test_html_unknown_path_allows_positive_native_detection(self):
        self.ollama()
        self.respond("GET", "/v1/status", (200, "<html>Ollama proxy UI</html>"))
        self.assertEqual((await resources.unload_llm(self.settings))["provider"], "ollama")

    async def test_reverse_proxy_prefix_and_port_override_for_all_providers(self):
        self.prefix = "/proxy/llm"
        self.settings["base_url"] = "http://127.0.0.1:1/proxy/llm/v1/"
        for provider in (self.strata, self.ollama, self.lmstudio):
            with self.subTest(provider=provider.__name__):
                self.responses.clear()
                self.calls.clear()
                provider()
                await resources.unload_llm(self.settings)
                self.assertTrue(all(call[1].startswith(self.prefix + "/") for call in self.calls))

    async def test_embedded_port_is_used_when_port_is_absent(self):
        self.settings.pop("port")
        self.settings["base_url"] = f"http://127.0.0.1:{self.port}/v1"
        self.strata()
        self.assertTrue((await resources.unload_llm(self.settings))["released"])

    async def test_blank_authentication_is_not_sent(self):
        self.settings["api_key"] = ""
        self.strata()
        await resources.unload_llm(self.settings)
        self.assertTrue(all(call[3] is None for call in self.calls))

    async def test_detection_is_read_only_and_has_no_identity_cache(self):
        self.strata()
        self.assertEqual(await resources.detect_provider(self.settings), "strata")
        self.responses.clear()
        self.settings.update(model="local:latest", api_key="changed-private-secret")
        self.ollama()
        self.assertEqual(await resources.detect_provider(self.settings), "ollama")
        self.assertTrue(all(call[0] == "GET" for call in self.calls))
        self.assertEqual(self.calls[-1][3], "Bearer changed-private-secret")

    async def test_no_request_timeout_or_retry_is_added(self):
        self.strata()
        factory = aiohttp.ClientSession
        with mock.patch.object(resources.aiohttp, "ClientSession", side_effect=factory) as session:
            await resources.unload_llm(self.settings)
        self.assertEqual(session.call_args.kwargs["timeout"].total, None)
        self.assertEqual(session.call_count, 1)
        self.assertEqual(len(self.calls), 3)

    async def test_connection_failure_is_precise_and_not_retried(self):
        with mock.patch.object(aiohttp.ClientSession, "request", side_effect=aiohttp.ClientConnectionError("private-resource-secret")) as request:
            await self.assert_failure("connection failed")
        self.assertEqual(request.call_count, 1)

    async def test_cancelled_request_propagates_without_release(self):
        self.strata()
        self.request_gate = asyncio.Event()
        task = asyncio.create_task(resources.unload_llm(self.settings))
        await self.request_started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.request_gate.set()
        self.assertEqual(self.paths(), [("GET", "/v1/status")])


class EndpointAndImportTest(unittest.TestCase):
    def test_default_protocol_ipv6_and_unversioned_prefix(self):
        for base_url, port, expected in [("https://llm.example/proxy/v1", None, "https://llm.example/proxy"),
                                         ("http://[::1]/proxy/v1", 8080, "http://[::1]:8080/proxy"),
                                         ("https://llm.example/prefix", None, "https://llm.example/prefix")]:
            with self.subTest(base_url=base_url):
                client = resources._Client(None, {**settings_module.DEFAULTS, "base_url": base_url, "port": port})
                self.assertEqual(client.native_url, expected)

    def test_import_performs_no_http_or_inference(self):
        with mock.patch.object(aiohttp, "ClientSession") as session:
            importlib.reload(resources)
        session.assert_not_called()


if __name__ == "__main__":
    unittest.main()
