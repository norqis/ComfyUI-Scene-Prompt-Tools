"""Real local HTTP tests without Comfy imports, model loading, or GPU work."""
import asyncio
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


class HttpFixture(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls = []
        self.result = {"positive": "cat", "negative": "dog", "lora_queries": []}
        self.status = 200
        self.finish = "stop"
        self.delay = 0
        app = web.Application()
        app.router.add_route("*", "/{tail:.*}", self.handle)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        self.settings = {**settings_module.DEFAULTS, "base_url": f"http://127.0.0.1:{port}/v1", "model": "local", "api_key": "private-secret"}

    async def asyncTearDown(self):
        await self.runner.cleanup()

    async def handle(self, request):
        payload = await request.json() if request.method == "POST" else None
        self.calls.append((request.path, payload, request.headers.get("Authorization")))
        if self.delay:
            await asyncio.sleep(self.delay)
        if request.path.endswith("/models"):
            return web.json_response({"data": [{"id": "local"}]})
        return web.json_response({"choices": [{"finish_reason": self.finish, "message": {"content": self.result if isinstance(self.result, str) else json.dumps(self.result)}}]}, status=self.status)


class LocalHttpTest(HttpFixture):
    async def test_generate_formats_and_exclusion_instructions(self):
        for format_mode in ("json_object", "json_schema", "instructions"):
            self.settings["response_format"] = format_mode
            result = await service.generate(self.settings, "猫、犬は除く", "Illustrious")
            self.assertEqual(result["template_version"], "scene-llm-v1")
            payload = self.calls[-1][1]
            self.assertIn("Preserve every explicit exclusion", payload["messages"][0]["content"])
            self.assertIn("Do not invent style", payload["messages"][0]["content"])
            self.assertEqual(json.loads(payload["messages"][1]["content"])["description"], "猫、犬は除く")
            self.assertEqual("response_format" in payload, format_mode != "instructions")
        self.assertEqual((await service.test_connection(self.settings))["models"], [{"id": "local"}])

    async def test_anima_and_optional_reasoning(self):
        self.settings["reasoning_effort"] = "none"
        await service.generate(self.settings, "cat", "Anima")
        self.assertIn("concise natural English", self.calls[-1][1]["messages"][0]["content"])
        self.assertEqual(self.calls[-1][1]["reasoning_effort"], "none")

    async def test_invalid_truncated_http_errors_and_timeout(self):
        for result in ("not JSON", {"positive": 1, "negative": "", "lora_queries": []}, {"positive": "", "negative": "", "lora_queries": []}, {"positive": "", "negative": "", "lora_queries": [1]}, {"positive": "", "negative": "", "lora_queries": [], "extra": True}):
            self.result = result
            with self.assertRaises(service.ServiceError):
                await service.generate(self.settings, "cat", "Anima")
        self.result = {"positive": "cat", "negative": "", "lora_queries": []}
        self.finish = "length"
        with self.assertRaises(service.ServiceError):
            await service.generate(self.settings, "cat", "Anima")
        self.finish = "stop"
        self.status = 401
        with self.assertRaises(service.ServiceError) as error:
            await service.generate(self.settings, "cat", "Anima")
        self.assertNotIn("private-secret", str(error.exception))
        self.status = 200
        self.delay = .05
        self.settings["timeout_seconds"] = .01
        with self.assertRaises(service.ServiceError):
            await service.generate(self.settings, "cat", "Anima")

    async def test_selection_none_unknown_duplicate_and_url_omission(self):
        candidate = {"model_id": 1, "version_id": 2, "file_id": 3, "name": "cat", "image_url": "private-image", "downloadUrl": "invented"}
        self.result = {"selected": []}
        self.assertEqual(await service.select_loras(self.settings, "cat", "Anima", "cat", [candidate]), self.result)
        sent = self.calls[-1][1]["messages"][1]["content"]
        self.assertNotIn("private-image", sent)
        self.assertNotIn("invented", sent)
        identity = {"model_id": 1, "version_id": 2, "file_id": 3}
        self.result = {"selected": [identity]}
        self.assertEqual(await service.select_loras(self.settings, "cat", "Anima", "cat", [candidate]), self.result)
        for selected in ([{**identity, "file_id": 9}], [identity, identity]):
            self.result = {"selected": selected}
            with self.assertRaises(service.ServiceError):
                await service.select_loras(self.settings, "cat", "Anima", "cat", [candidate])


class SettingsTest(unittest.TestCase):
    def test_per_user_secrets_blank_preserve_clear_and_validation(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(settings_module, "storage_directory", side_effect=lambda user: Path(temporary) / user):
            public = settings_module.save_settings("alice", {"api_key": "secret", "civitai_api_key": "other"})
            self.assertNotIn("api_key", public)
            self.assertTrue(public["api_key_set"])
            settings_module.save_settings("alice", {"api_key": ""})
            self.assertEqual(settings_module.load_settings("alice")["api_key"], "secret")
            self.assertFalse(settings_module.public_settings(settings_module.load_settings("bob"))["api_key_set"])
            settings_module.save_settings("alice", {"clear_api_key": True})
            self.assertEqual(settings_module.load_settings("alice")["api_key"], "")
            for changes in ({"base_url": "http://secret@localhost/v1"}, {"civitai_host": "evil.example"}, {"timeout_seconds": 0}, {"max_tokens": 1}):
                with self.assertRaises(ValueError):
                    settings_module.save_settings("alice", changes)


if __name__ == "__main__":
    unittest.main()
