import importlib
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import aiohttp
from test_routes import load_routes
from test_llm_service import service, settings_module
from test_civitai import civitai


class LlmRoutesTest(unittest.IsolatedAsyncioTestCase):
    async def test_routes_settings_generate_error_and_user_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            # Existing route fixture intentionally replaces aiohttp with a tiny mock.
            original_modules = dict(sys.modules)
            try:
                routes = load_routes(Path(temporary))
                registered = routes._test_routes
                sys.modules["aiohttp"] = aiohttp
                package = routes.__package__
                with mock.patch.dict(sys.modules, {
                    package + ".llm_settings": settings_module,
                    package + ".llm_service": service,
                    package + ".civitai": civitai,
                }), mock.patch.object(settings_module, "storage_directory", side_effect=lambda user: Path(temporary) / user):
                    class Request:
                        user_id = "alice"
                        query = {}
                        payload = {}

                        async def json(self):
                            return self.payload

                    request = Request()
                    request.payload = {"api_key": "route-secret", "model": "configured"}
                    result = await registered[("POST", "/scene_prompt/llm/settings")](request)
                    self.assertEqual(result["status"], 200)
                    self.assertNotIn("route-secret", str(result))
                    result = await registered[("GET", "/scene_prompt/llm/settings")](request)
                    self.assertTrue(result["payload"]["api_key_set"])
                    saved = settings_module.load_settings("alice")
                    request.payload = {"base_url": "http://127.0.0.1:19001/v1", "model": "unsaved-model", "api_key": "unsaved-secret"}
                    with mock.patch.object(service, "test_connection", return_value={"ok": True, "models": [], "model": "unsaved-model"}) as connection:
                        result = await registered[("POST", "/scene_prompt/llm/test")](request)
                        supplied = connection.call_args.args[0]
                        self.assertEqual(supplied["base_url"], request.payload["base_url"])
                        self.assertEqual(supplied["model"], "unsaved-model")
                        self.assertEqual(supplied["api_key"], "unsaved-secret")
                        self.assertNotIn("unsaved-secret", str(result))
                    self.assertEqual(settings_module.load_settings("alice"), saved)
                    request.payload["api_key"] = ""
                    with mock.patch.object(service, "test_connection", return_value={"ok": True}) as connection:
                        await registered[("POST", "/scene_prompt/llm/test")](request)
                        self.assertEqual(connection.call_args.args[0]["api_key"], "route-secret")
                    request.payload["base_url"] = "invalid"
                    with mock.patch.object(service, "test_connection") as connection:
                        result = await registered[("POST", "/scene_prompt/llm/test")](request)
                        self.assertEqual(result["status"], 400)
                        connection.assert_not_called()
                    self.assertEqual(settings_module.load_settings("alice"), saved)
                    request.user_id = "bob"
                    result = await registered[("GET", "/scene_prompt/llm/settings")](request)
                    self.assertFalse(result["payload"]["api_key_set"])
                    request.payload = {"description": "", "model_mode": "Anima"}
                    result = await registered[("POST", "/scene_prompt/llm/generate")](request)
                    self.assertEqual(result["status"], 400)
                    with mock.patch.object(service, "test_connection", side_effect=service.ServiceError("LLM endpoint returned HTTP 401.")):
                        result = await registered[("POST", "/scene_prompt/llm/test")](request)
                        self.assertEqual(result["status"], 502)
                    expected = {("GET", "/scene_prompt/civitai/search"), ("POST", "/scene_prompt/civitai/download"), ("POST", "/scene_prompt/llm/select_loras")}
                    self.assertTrue(expected.issubset(registered))
            finally:
                for name in list(sys.modules):
                    if name not in original_modules:
                        del sys.modules[name]
                sys.modules.update(original_modules)


if __name__ == "__main__":
    unittest.main()
