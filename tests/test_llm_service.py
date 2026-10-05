"""Real isolated HTTP and settings ownership tests; never load model weights."""
import asyncio
import concurrent.futures
import importlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import aiohttp
from aiohttp import web

ROOT = Path(__file__).resolve().parents[1]
package = types.ModuleType("scene_llm_service_test")
package.__path__ = [str(ROOT / "scene_prompt_tools")]
sys.modules[package.__name__] = package
folder_paths = types.ModuleType("folder_paths")
with mock.patch.dict(sys.modules, {"folder_paths": folder_paths}):
    settings_module = importlib.import_module(package.__name__ + ".llm_settings")
    service = importlib.import_module(package.__name__ + ".llm_service")
# Keep this isolated package's shared dependencies after patch.dict restores modules.
sys.modules[package.__name__ + ".llm_settings"] = settings_module
sys.modules[package.__name__ + ".llm_service"] = service


class HttpFixture(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls = []
        self.result = {"positive": "cat", "negative": "dog", "lora_queries": []}
        self.status, self.finish, self.delay = 200, "stop", 0
        self.responses = []
        self.model_ids = ["local"]
        self.raw = False
        self.error = {"error": {"message": "Generic failure private-secret"}}
        app = web.Application()
        app.router.add_route("*", "/{tail:.*}", self.handle)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        self.port = site._server.sockets[0].getsockname()[1]
        self.settings = {**settings_module.DEFAULTS, "base_url": "http://127.0.0.1/v1", "port": self.port,
                         "model": "local", "api_key": "private-secret"}

    async def asyncTearDown(self):
        await self.runner.cleanup()

    async def handle(self, request):
        payload = await request.json() if request.method == "POST" else None
        self.calls.append((request.path, payload, request.headers.get("Authorization")))
        if self.delay:
            await asyncio.sleep(self.delay)
        if request.path.endswith("/models"):
            return web.json_response({"data": [{"id": item} for item in self.model_ids]})
        if self.responses:
            status, error = self.responses.pop(0)
            return web.json_response(error, status=status)
        if self.status != 200:
            return web.json_response(self.error, status=self.status)
        if self.raw:
            return web.Response(text="not JSON", content_type="application/json")
        return web.json_response({"choices": [{"finish_reason": self.finish,
            "message": {"content": self.result if isinstance(self.result, str) else json.dumps(self.result)}}]})


class LocalHttpTest(HttpFixture):
    async def test_default_model_omitted_no_budget_or_tuning_and_instructions(self):
        self.settings.update(model="", max_tokens=1, reasoning_effort="high", temperature=9, response_format="instructions")
        result = await service.generate(self.settings, "猫、犬は除く", "Illustrious")
        self.assertEqual(result["template_version"], "scene-llm-v1")
        payload = self.calls[-1][1]
        self.assertEqual(set(payload), {"messages", "stream", "response_format"})
        self.assertEqual(payload["response_format"], {"type": "json_object"})
        self.assertIn("Preserve every explicit exclusion", payload["messages"][0]["content"])
        self.assertIn("Do not invent style", payload["messages"][0]["content"])
        self.assertEqual(json.loads(payload["messages"][1]["content"])["description"], "猫、犬は除く")
        self.assertEqual(self.calls[-1][2], "Bearer private-secret")

    async def test_explicit_model_and_anima(self):
        await service.generate(self.settings, "cat", "Anima")
        self.assertEqual(self.calls[-1][1]["model"], "local")
        self.assertIn("concise natural English", self.calls[-1][1]["messages"][0]["content"])
        self.assertEqual((await service.test_connection(self.settings))["models"], [{"id": "local"}])
        self.assertEqual([call[0] for call in self.calls], ["/v1/chat/completions", "/v1/models"])

    async def test_unique_model_discovered_only_after_explicit_required_error(self):
        self.settings["model"] = ""
        self.responses = [(422, {"detail": [{"loc": ["body", "model"], "msg": "Field required"}]})]
        await service.generate(self.settings, "cat", "Anima")
        self.assertEqual([call[0] for call in self.calls], ["/v1/chat/completions", "/v1/models", "/v1/chat/completions"])
        self.assertNotIn("model", self.calls[0][1])
        self.assertEqual(self.calls[-1][1]["model"], "local")

    async def test_zero_many_and_duplicate_model_ids(self):
        self.settings["model"] = ""
        for models in ([], ["a", "b"], ["", " "]):
            self.calls.clear(); self.model_ids = models
            self.responses = [(400, {"error": {"message": "model is required"}})]
            with self.assertRaisesRegex(service.ServiceError, "Specify the model name"):
                await service.generate(self.settings, "cat", "Anima")
            self.assertEqual(len(self.calls), 2)
        self.model_ids = [" local ", "local"]
        self.responses = [(400, {"error": {"param": "model", "message": "Missing required field"}})]
        await service.generate(self.settings, "cat", "Anima")
        self.assertEqual(self.calls[-1][1]["model"], "local")

    async def test_explicit_model_never_replaced(self):
        self.responses = [(400, {"error": {"param": "model", "message": "model is required"}})]
        with self.assertRaises(service.ServiceError):
            await service.generate(self.settings, "cat", "Anima")
        self.assertEqual(len(self.calls), 1)

    async def test_format_fallback_retains_schema_and_strict_validation(self):
        self.responses = [(400, {"error": {"param": "response_format", "message": "Unsupported parameter"}})]
        await service.generate(self.settings, "cat", "Anima")
        self.assertEqual(len(self.calls), 2)
        self.assertNotIn("response_format", self.calls[-1][1])
        self.assertEqual(self.calls[0][1]["messages"], self.calls[1][1]["messages"])
        self.calls.clear(); self.result = {"positive": "cat", "negative": "", "lora_queries": [], "extra": 1}
        self.responses = [(422, {"error": {"message": "json_object is not supported"}})]
        with self.assertRaises(service.ServiceError):
            await service.generate(self.settings, "cat", "Anima")
        self.assertEqual(len(self.calls), 2)

    async def test_both_correction_orders(self):
        self.settings["model"] = ""
        format_error = (400, {"error": {"message": "response_format is not supported"}})
        model_error = (422, {"error": {"message": "Missing required parameter: model"}})
        for errors in ([format_error, model_error], [model_error, format_error]):
            self.calls.clear(); self.responses = list(errors)
            await service.generate(self.settings, "cat", "Anima")
            self.assertEqual(len(self.calls), 4)
            self.assertEqual(self.calls[-1][1]["model"], "local")
            self.assertNotIn("response_format", self.calls[-1][1])

    async def test_each_correction_only_once(self):
        self.settings["model"] = ""
        self.responses = [(400, {"error": {"message": "model is required"}})] * 2
        with self.assertRaises(service.ServiceError):
            await service.generate(self.settings, "cat", "Anima")
        self.assertEqual(len(self.calls), 3)
        self.calls.clear()
        self.responses = [(400, {"error": {"message": "response_format is not supported"}})] * 2
        with self.assertRaises(service.ServiceError):
            await service.generate(self.settings, "cat", "Anima")
        self.assertEqual(len(self.calls), 2)

    async def test_unrelated_errors_never_retry_or_echo_provider_details(self):
        self.settings["model"] = ""
        errors = [
            {"error": {"message": "Bad request"}},
            {"error": {"param": "messages", "message": "model request is missing required messages private-secret"}},
            {"error": {"message": "model request is missing required messages"}},
            {"error": {"param": "temperature", "message": "Unsupported parameter; response_format was accepted"}},
            {"error": {"message": "Unsupported temperature parameter; response_format was accepted"}},
            {"error": {"param": "response_format", "message": "Invalid schema required property"}},
        ]
        for status in (400, 422, 401, 403, 500, 503):
            for error in errors:
                self.calls.clear(); self.status = status; self.error = error
                with self.assertRaises(service.ServiceError) as caught:
                    await service.generate(self.settings, "cat", "Anima")
                self.assertEqual(len(self.calls), 1, (status, error))
                self.assertNotIn("private-secret", str(caught.exception))
                self.assertNotIn("messages", str(caught.exception))

    async def test_invalid_truncated_success_never_retry(self):
        for result in ("not JSON", {"positive": 1, "negative": "", "lora_queries": []},
                       {"positive": "", "negative": "", "lora_queries": []},
                       {"positive": "cat", "negative": "", "lora_queries": [1]},
                       {"positive": "cat", "negative": "", "lora_queries": [], "extra": True}):
            self.calls.clear(); self.result = result
            with self.assertRaises(service.ServiceError):
                await service.generate(self.settings, "cat", "Anima")
            self.assertEqual(len(self.calls), 1)
        self.result = {"positive": "cat", "negative": "", "lora_queries": []}
        self.finish = "length"; self.calls.clear()
        with self.assertRaises(service.ServiceError):
            await service.generate(self.settings, "cat", "Anima")
        self.assertEqual(len(self.calls), 1)
        self.finish = "stop"; self.raw = True; self.calls.clear()
        with self.assertRaises(service.ServiceError):
            await service.generate(self.settings, "cat", "Anima")
        self.assertEqual(len(self.calls), 1)

    async def test_no_application_timeout_and_cancellation_propagates(self):
        self.settings["timeout_seconds"] = .001
        self.delay = .03
        with mock.patch.object(aiohttp, "ClientTimeout", wraps=aiohttp.ClientTimeout) as timeout:
            await service.generate(self.settings, "cat", "Anima")
            timeout.assert_called_once_with(total=None)
        self.delay = .2
        task = asyncio.create_task(service.generate(self.settings, "cat", "Anima"))
        while len(self.calls) < 2:
            await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(len(self.calls), 2)

    async def test_network_failure_not_retried(self):
        with mock.patch.object(service, "request_json", side_effect=service.ServiceError("LLM connection failed.")) as request:
            with self.assertRaises(service.ServiceError):
                await service.generate(self.settings, "cat", "Anima")
            request.assert_called_once()

    async def test_malformed_success_envelopes_and_failed_negotiation_are_not_cached(self):
        for envelope in ({}, {"choices": []}, {"choices": [None]}, {"choices": ["bad"]},
                         {"choices": [{"message": {"content": 42}}]}):
            with mock.patch.object(service, "request_json", return_value=envelope) as request:
                with self.assertRaises(service.ServiceError):
                    await service.generate(self.settings, "cat", "Anima")
                request.assert_called_once()
        state = service.negotiation_state("invalid-result-user", self.settings)
        self.result = {"positive": "", "negative": "", "lora_queries": []}
        self.responses = [(400, {"error": {"message": "response_format is unsupported"}})]
        with self.assertRaises(service.ServiceError):
            await service.generate(self.settings, "cat", "Anima", state)
        self.assertTrue(state.json_object)

    async def test_latest_user_state_reuses_negotiation_without_retaining_requests(self):
        self.settings["model"] = ""
        state = service.negotiation_state("reuse-user", self.settings)
        self.responses = [(400, {"error": {"message": "model is required"}}),
                          (400, {"error": {"message": "response_format is unsupported"}})]
        await service.generate(self.settings, "private description", "Anima", state)
        self.calls.clear()
        self.assertIs(service.negotiation_state("reuse-user", self.settings), state)
        await service.generate(self.settings, "another node", "Anima", state)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][1]["model"], "local")
        self.assertNotIn("response_format", self.calls[0][1])
        self.assertEqual(set(vars(state)), {"identity", "user_id", "json_object", "model"})
        self.assertNotIn("private-secret", repr(state))
        self.assertNotIn("private description", repr(state))
        for change in ({"port": self.port+1}, {"model": "different"}, {"api_key": "replacement"}):
            updated = service.negotiation_state("reuse-user", {**self.settings, **change})
            self.assertIsNot(updated, state)
            self.assertTrue(updated.json_object)
            self.assertIsNone(updated.model)
        self.assertIsNot(service.negotiation_state("different-user", self.settings), state)

    async def test_stale_completion_cannot_publish_after_configuration_replaced(self):
        self.settings["model"] = ""
        state = service.negotiation_state("late-user", self.settings)
        self.delay = .04
        self.responses = [(400, {"error": {"message": "response_format is unsupported"}})]
        task = asyncio.create_task(service.generate(self.settings, "cat", "Anima", state))
        while not self.calls:
            await asyncio.sleep(0)
        replacement = service.negotiation_state("late-user", {**self.settings, "api_key": "new-secret"})
        await task
        self.assertIs(service._CAPABILITIES["late-user"], replacement)
        self.assertTrue(replacement.json_object)
        self.assertTrue(state.json_object, "a stale owner cannot even update its detached state")
        service.invalidate_negotiation("late-user")
        service._remember(replacement, False, "local")
        self.assertNotIn("late-user", service._CAPABILITIES)

    async def test_selection_none_unknown_duplicate_and_no_candidate_count_cap(self):
        candidate = {"model_id": 1, "version_id": 2, "file_id": 3, "name": "cat", "image_url": "private-image", "downloadUrl": "invented"}
        self.result = {"selected": []}
        self.assertEqual(await service.select_loras(self.settings, "cat", "Anima", "cat", [candidate]), self.result)
        sent = self.calls[-1][1]["messages"][1]["content"]
        self.assertNotIn("private-image", sent); self.assertNotIn("invented", sent)
        identity = {"model_id": 1, "version_id": 2, "file_id": 3}
        self.result = {"selected": [identity]}
        many = [{**candidate, "file_id": index+3} for index in range(121)]
        self.assertEqual(await service.select_loras(self.settings, "cat", "Anima", "cat", many), self.result)
        for selected in ([{**identity, "file_id": 9}], [identity, identity], [{**identity, "model_id": True}]):
            self.result = {"selected": selected}
            with self.assertRaises(service.ServiceError):
                await service.select_loras(self.settings, "cat", "Anima", "cat", [candidate])
        self.assertEqual(await service.select_loras(self.settings, "cat", "Anima", "cat", []), {"selected": []})


class SettingsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.directory_patch = mock.patch.object(settings_module, "storage_directory", side_effect=lambda user: self.root / user)
        self.directory_patch.start()

    def tearDown(self):
        self.directory_patch.stop(); self.temporary.cleanup()

    def legacy(self, values):
        path = self.root / "alice" / "llm_settings.json"
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(values), encoding="utf-8")
        return path

    def test_migration_url_port_path_ipv6_and_removed_tuning(self):
        for url, base, port in (("http://localhost:9000/v1", "http://localhost/v1", 9000),
            ("https://host/proxy/v1", "https://host/proxy/v1", None),
            ("https://[::1]:9443/proxy/v1", "https://[::1]/proxy/v1", 9443),
            ("https://[::1]/v1", "https://[::1]/v1", None)):
            path = self.legacy({"base_url": url, "api_key": "secret", "civitai_api_key": "other", "civitai_host": "civitai.com",
                "timeout_seconds": 120, "max_tokens": 8192, "response_format": "json_schema", "reasoning_effort": "high"})
            loaded = settings_module.load_settings("alice")
            self.assertEqual((loaded["base_url"], loaded["port"]), (base, port))
            settings_module.save_settings("alice", {}, service="llm")
            self.assertEqual(set(json.loads(path.read_text(encoding="utf-8"))), set(settings_module.DEFAULTS))
            self.assertEqual(loaded["api_key"], "secret"); self.assertEqual(loaded["civitai_api_key"], "other")
        self.assertEqual(settings_module.load_settings("new"), settings_module.DEFAULTS)

    def test_port_precedence_explicit_blank_default_url_only_and_integer_strings(self):
        for changes, port in (({"base_url": "http://host:9001/v1"}, 9001),
            ({"base_url": "https://host/v1"}, None),
            ({"base_url": "http://host:9001/v1", "port": ""}, None),
            ({"base_url": "http://host:9001/v1", "port": None}, None),
            ({"base_url": "http://host:9001/v1", "port": "65535"}, 65535),
            ({"port": "1"}, 1)):
            merged = settings_module.merge_settings(settings_module.DEFAULTS, changes)
            self.assertEqual(merged["port"], port)
            self.assertNotIn(":9001", merged["base_url"])
            self.assertTrue(port is None or type(merged["port"]) is int)
        self.legacy({"base_url": "https://host:9001/v1", "port": None})
        self.assertEqual(settings_module.endpoint(settings_module.load_settings("alice")), "https://host/v1")
        self.assertEqual(settings_module.endpoint({**settings_module.DEFAULTS, "base_url": "http://[::1]/proxy/v1", "port": 9090}), "http://[::1]:9090/proxy/v1")

    def test_secrets_scoped_saves_per_user_and_cache_invalidation(self):
        public = settings_module.save_settings("alice", {"api_key": "secret", "civitai_api_key": "other"})
        self.assertEqual(set(public), {"base_url", "port", "model", "api_key_set", "template_version"})
        settings, state = settings_module.request_settings("alice")
        settings_module.save_settings("alice", {"api_key": "", "civitai_api_key": "wrong", "clear_civitai_api_key": True}, service="llm")
        self.assertNotIn("alice", service._CAPABILITIES)
        self.assertEqual(settings_module.load_settings("alice")["api_key"], "secret")
        self.assertEqual(settings_module.load_settings("alice")["civitai_api_key"], "other")
        _, state = settings_module.request_settings("alice")
        public = settings_module.save_settings("alice", {"civitai_api_key": "replacement", "api_key": "wrong", "model": "wrong"}, service="civitai")
        self.assertEqual(public, {"civitai_api_key_set": True})
        self.assertIs(service._CAPABILITIES["alice"], state)
        self.assertEqual(settings_module.load_settings("alice")["api_key"], "secret")
        self.assertEqual(settings_module.load_settings("alice")["model"], "")
        self.assertFalse(settings_module.public_settings(settings_module.load_settings("bob"))["api_key_set"])
        settings_module.save_settings("alice", {"clear_api_key": True}, service="llm")
        settings_module.save_settings("alice", {"clear_civitai_api_key": True}, service="civitai")
        self.assertEqual(settings_module.load_settings("alice")["api_key"], "")
        self.assertEqual(settings_module.load_settings("alice")["civitai_api_key"], "")

    def test_concurrent_scoped_saves_preserve_both_services(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            for index in range(12):
                futures = [executor.submit(settings_module.save_settings, "alice", {"model": str(index), "api_key": "llm"}, service="llm"),
                           executor.submit(settings_module.save_settings, "alice", {"civitai_api_key": "civi" + str(index)}, service="civitai")]
                for future in futures:
                    future.result()
                saved = settings_module.load_settings("alice")
                self.assertEqual((saved["model"], saved["api_key"], saved["civitai_api_key"]), (str(index), "llm", "civi"+str(index)))
        self.assertFalse(list(self.root.rglob(".settings-*")))

    def test_protocol_validation_and_obsolete_values_ignored(self):
        for url in ("", "invalid", "ftp://host/v1", "http://secret@host/v1", "https://host/v1?q=1", "https://host/v1#part", "http://host:65536/v1"):
            with self.assertRaises(ValueError):
                settings_module.save_settings("alice", {"base_url": url}, service="llm")
        for port in (0, 65536, -1, 1.5, True, False, "1.0", "x", "-1", " "):
            with self.assertRaises(ValueError):
                settings_module.save_settings("alice", {"port": port}, service="llm")
        for key in ("api_key", "civitai_api_key", "model"):
            with self.assertRaises(ValueError):
                settings_module.save_settings("alice", {key: 123})
        result = settings_module.save_settings("alice", {"response_format": "bad", "timeout_seconds": 0, "max_tokens": 1, "civitai_host": "evil"})
        self.assertNotIn("response_format", result)


if __name__ == "__main__":
    unittest.main()
