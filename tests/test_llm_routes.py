import importlib
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from test_routes import load_routes
import test_llm_service as llm_fixture
from test_civitai import civitai

aiohttp = llm_fixture.aiohttp
service, settings_module = llm_fixture.service, llm_fixture.settings_module

class LlmRoutesTest(unittest.IsolatedAsyncioTestCase):
    async def test_gpu_routes_snapshot_client_ownership_operation_failure_and_explicit_intent(self):
        with tempfile.TemporaryDirectory() as temporary:
            original_modules = dict(sys.modules)
            try:
                routes = load_routes(Path(temporary))
                package = routes.__package__
                gpu = sys.modules[package + ".gpu_handoff"]
                coordinator = routes.PromptServer.instance._scene_gpu_handoff
                class Socket:
                    closed = False
                coordinator.socket_owners.update({"a": ("alice", Socket()), "b": ("alice", Socket())})
                sys.modules["aiohttp"] = aiohttp
                class Request:
                    user_id = "alice"
                    payload = {}
                    async def json(self):
                        return self.payload
                request = Request()
                registered = routes._test_routes
                prepare = registered[("POST", "/scene_prompt/gpu/prepare")]
                begin = registered[("POST", "/scene_prompt/llm/begin")]
                end = registered[("POST", "/scene_prompt/llm/end")]
                generate = registered[("POST", "/scene_prompt/llm/generate")]
                release = registered[("POST", "/scene_prompt/gpu/release")]
                with mock.patch.dict(sys.modules, {package + ".llm_settings": settings_module,
                        package + ".llm_service": service}), \
                        mock.patch.object(settings_module, "storage_directory", side_effect=lambda user: Path(temporary) / user), \
                        mock.patch.object(coordinator, "release_comfy", new=mock.AsyncMock()):
                    settings_module.save_settings("alice", {"model": "first", "api_key": "secret"})
                    # Explicit endpoint calls preserve an operation requested
                    # while the browser's UI setting was on, even if it changed
                    # during a FIFO wait. No current-setting gate is consulted.
                    request.payload = {"client_id": "a"}
                    policy_response = await prepare(request)
                    self.assertEqual(policy_response["status"], 200)
                    policy_id = policy_response["payload"]["policy_id"]
                    self.assertNotIn("secret", str(policy_response))
                    started = await begin(request)
                    self.assertEqual(started["status"], 200)
                    session_id = started["payload"]["session_id"]
                    self.assertEqual((await begin(request))["status"], 409)
                    settings_module.save_settings("alice", {"model": "changed"})
                    request.payload = {"client_id": "b", "session_id": session_id, "description": "scene", "model_mode": "Illustrious"}
                    with mock.patch.object(service, "generate", new=mock.AsyncMock(return_value={"positive": "fixture"})) as inference:
                        self.assertEqual((await generate(request))["status"], 403)
                        inference.assert_not_awaited()
                        request.user_id = "bob"
                        request.payload["client_id"] = "a"
                        self.assertEqual((await generate(request))["status"], 403)
                        request.user_id = "alice"
                        result = await generate(request)
                        self.assertEqual(result["status"], 200)
                        self.assertEqual(inference.await_args.args[0]["model"], "first")
                        self.assertEqual(inference.await_args.args[0]["api_key"], "secret")
                    request.payload = {"client_id": "b", "session_id": session_id}
                    self.assertEqual((await end(request))["status"], 403)
                    request.payload["client_id"] = "a"
                    self.assertTrue((await end(request))["payload"]["ended"])
                    self.assertFalse(coordinator.gate.exclusive)
                    request.payload = {"client_id": "b", "policy_id": policy_id}
                    self.assertEqual((await release(request))["status"], 403)
                    request.payload["client_id"] = "a"
                    self.assertTrue((await release(request))["payload"]["released"])
                    # The response may be lost after cleanup already succeeded.
                    repeated = await release(request)
                    self.assertEqual(repeated["status"], 200)
                    self.assertFalse(repeated["payload"]["released"])
                    held_id = coordinator.prepare("alice", "a", {})
                    coordinator.admit("pending-prompt", held_id, "alice", "a")
                    request.payload["policy_id"] = held_id
                    self.assertTrue((await release(request))["payload"]["released"])
                    self.assertTrue((await release(request))["payload"]["released"])
                    request.payload["client_id"] = "b"
                    self.assertEqual((await release(request))["status"], 403)
                    request.payload["client_id"] = "a"
                    request.user_id = "bob"
                    self.assertEqual((await release(request))["status"], 403)
                    request.user_id = "alice"
                    coordinator.finish_prompt("pending-prompt")
                    self.assertFalse((await release(request))["payload"]["released"])
                    request.payload = {"client_id": "a", "session_id": "missing", "description": "scene", "model_mode": "Illustrious"}
                    self.assertEqual((await generate(request))["status"], 404)
                    request.payload = {"client_id": "missing"}
                    self.assertEqual((await prepare(request))["status"], 403)
                    self.assertFalse(coordinator.policies)
                    self.assertFalse(coordinator.sessions)
            finally:
                for name in list(sys.modules):
                    if name not in original_modules:
                        del sys.modules[name]
                sys.modules.update(original_modules)

    async def test_real_http_settings_save_reopen_and_user_isolation_without_secret_prefill(self):
        with tempfile.TemporaryDirectory() as temporary:
            original_modules = dict(sys.modules)
            runner = None
            try:
                routes = load_routes(Path(temporary))
                sys.modules["aiohttp"] = aiohttp
                package = routes.__package__
                with mock.patch.dict(sys.modules, {
                    package + ".llm_settings": settings_module,
                    package + ".llm_service": service,
                }), mock.patch.object(settings_module, "storage_directory", side_effect=lambda user: Path(temporary) / user), \
                        mock.patch.object(routes, "web", llm_fixture.web), \
                        mock.patch.object(routes, "_request_user_id", side_effect=lambda request: request.headers["X-Test-User"]):
                    app = llm_fixture.web.Application()
                    for method in ("GET", "POST"):
                        app.router.add_route(method, "/scene_prompt/llm/settings", routes._test_routes[(method, "/scene_prompt/llm/settings")])
                    runner = llm_fixture.web.AppRunner(app)
                    await runner.setup()
                    site = llm_fixture.web.TCPSite(runner, "127.0.0.1", 0)
                    await site.start()
                    url = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}/scene_prompt/llm/settings"
                    async with aiohttp.ClientSession() as session:
                        async def request(method, user, payload=None):
                            async with session.request(method, url, headers={"X-Test-User": user}, json=payload) as response:
                                result = await response.json()
                                self.assertEqual(response.status, 200, result)
                                self.assertNotIn("api_key", result)
                                self.assertNotIn("private-secret", str(result))
                                return result
                        with mock.patch.object(settings_module, "load_settings", wraps=settings_module.load_settings) as load:
                            saved = await request("POST", "alice", {"base_url": "https://llm.example:9443/proxy/v1",
                                "model": "configured", "api_key": "private-secret"})
                            load.assert_called_once_with("alice")
                        self.assertEqual((saved["base_url"], saved["port"], saved["model"], saved["api_key_set"]),
                                         ("https://llm.example/proxy/v1", 9443, "configured", True))
                        self.assertEqual(await request("GET", "alice"), saved)
                        bob = await request("POST", "bob", {"base_url": "http://localhost/v1", "port": "18080", "model": "bob"})
                        self.assertEqual((bob["port"], bob["model"], bob["api_key_set"]), (18080, "bob", False))
                        updated = await request("POST", "alice", {"base_url": "https://llm.example/proxy/v1", "port": "",
                            "model": "updated", "api_key": "", "clear_api_key": True})
                        self.assertEqual((updated["port"], updated["model"], updated["api_key_set"]), (None, "updated", True))
                        self.assertEqual(await request("GET", "alice"), updated)
                        self.assertEqual(await request("GET", "bob"), bob)
                    self.assertEqual(settings_module.load_settings("alice")["api_key"], "private-secret")
                    private = Path(temporary) / "alice" / "llm_settings.json"
                    self.assertNotIn("clear_api_key", private.read_text(encoding="utf-8"))
            finally:
                if runner is not None:
                    await runner.cleanup()
                for name in list(sys.modules):
                    if name not in original_modules:
                        del sys.modules[name]
                sys.modules.update(original_modules)

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
                        reads = 0

                        async def json(self):
                            self.reads += 1
                            return self.payload

                    request = Request()
                    request.payload = {"api_key": "route-secret", "model": "configured"}
                    with mock.patch.object(settings_module, "load_settings", wraps=settings_module.load_settings) as load:
                        result = await registered[("POST", "/scene_prompt/llm/settings")](request)
                        load.assert_called_once_with("alice")
                    self.assertEqual(request.reads, 1)
                    self.assertEqual(result["status"], 200)
                    self.assertNotIn("route-secret", str(result))
                    result = await registered[("GET", "/scene_prompt/llm/settings")](request)
                    self.assertTrue(result["payload"]["api_key_set"])
                    saved = settings_module.load_settings("alice")
                    request.payload = {"base_url": "http://127.0.0.1:19001/v1", "model": "unsaved-model", "api_key": "unsaved-secret"}
                    with mock.patch.object(service, "test_connection", return_value={"ok": True, "models": [], "model": "unsaved-model"}) as connection:
                        result = await registered[("POST", "/scene_prompt/llm/test")](request)
                        supplied = connection.call_args.args[0]
                        self.assertEqual(supplied["base_url"], "http://127.0.0.1/v1")
                        self.assertEqual(supplied["port"], 19001)
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
                    expected = {("GET", "/scene_prompt/civitai/search"), ("GET", "/scene_prompt/civitai/by-hash"), ("POST", "/scene_prompt/civitai/download"), ("POST", "/scene_prompt/llm/select_loras")}
                    self.assertTrue(expected.issubset(registered))
                    for method in ("GET", "POST"):
                        self.assertNotIn((method, "/scene_prompt/civitai/settings"), registered)
                    request.user_id = "alice"
                    request.payload = {"civitai_api_key": {"malformed": True}, "clear_civitai_api_key": True}
                    result = await registered[("POST", "/scene_prompt/llm/settings")](request)
                    self.assertEqual(result["status"], 200)
                    self.assertEqual(result["payload"]["model"], "configured")
                    self.assertNotIn("civitai_api_key_set", result["payload"])
                    self.assertNotIn("civitai_api_key", settings_module.load_settings("alice"))
                    by_hash = registered[("GET", "/scene_prompt/civitai/by-hash")]
                    version = {"id": 2, "modelId": 1, "name": "v1", "model": {"name": "model"}, "trainedWords": ["trigger"], "private": "provider body"}
                    with mock.patch.object(settings_module, "load_settings", side_effect=ValueError("malformed LLM settings")), \
                            mock.patch.object(settings_module, "storage_directory", side_effect=AssertionError("private settings access")), \
                            mock.patch.object(civitai, "api_get", return_value=version) as lookup, \
                            mock.patch.object(civitai, "_sha256", side_effect=AssertionError("local hash")), \
                            mock.patch.object(civitai, "lora_root", side_effect=AssertionError("local model access")):
                        for user in ("alice", "bob"):
                            request.user_id = user
                            request.query = {"sha256": "A" * 64}
                            result = await by_hash(request)
                            self.assertEqual(result["status"], 200)
                            self.assertEqual(result["payload"], {"found": True, "version": {key: value for key, value in version.items() if key != "private"}})
                            self.assertEqual(lookup.call_args.args, ("/api/v1/model-versions/by-hash/" + "a" * 64,))
                            self.assertTrue(lookup.call_args.kwargs["missing_ok"])
                        request.query = {"sha256": "invalid"}
                        lookup.reset_mock()
                        self.assertEqual((await by_hash(request))["status"], 400)
                        lookup.assert_not_called()
                        request.query = {"query": "hat", "model_mode": "Anima", "sort": "Highest Rated"}
                        with mock.patch.object(civitai, "search", return_value={"items": []}) as search:
                            self.assertEqual((await registered[("GET", "/scene_prompt/civitai/search")](request))["payload"], {"items": []})
                            search.assert_awaited_once_with("hat", "Anima", "Highest Rated", host="civitai.red")
                            request.query["host"] = "civitai.com"
                            await registered[("GET", "/scene_prompt/civitai/search")](request)
                            self.assertEqual(search.await_args.kwargs["host"], "civitai.com")
                        request.payload = {"model_id": 1, "version_id": 2, "file_id": 3, "model_mode": "Anima"}
                        with mock.patch.object(civitai, "download", return_value={"lora_name": "llm/public.safetensors"}) as download:
                            self.assertEqual((await registered[("POST", "/scene_prompt/civitai/download")](request))["status"], 200)
                            download.assert_awaited_once_with(request.payload, "Anima", host="civitai.red")
                            request.payload["host"] = "civitai.com"
                            await registered[("POST", "/scene_prompt/civitai/download")](request)
                            self.assertEqual(download.await_args.kwargs["host"], "civitai.com")
                        request.query = {"sha256": "a" * 64}
                        with mock.patch.object(civitai, "api_get", return_value=civitai._NOT_FOUND):
                            self.assertEqual((await by_hash(request))["payload"], {"found": False, "version": None})
                        with mock.patch.object(civitai, "api_get", side_effect=service.ServiceError("Civitai API returned HTTP 401.")):
                            self.assertEqual((await by_hash(request))["status"], 502)
                        request.payload = []
                        self.assertEqual((await registered[("POST", "/scene_prompt/civitai/download")](request))["status"], 400)
            finally:
                for name in list(sys.modules):
                    if name not in original_modules:
                        del sys.modules[name]
                sys.modules.update(original_modules)


if __name__ == "__main__":
    unittest.main()
