import hashlib
import importlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aiohttp import web
import test_llm_service as llm_fixture

folder_paths = llm_fixture.folder_paths
package = llm_fixture.package

with mock.patch.dict(sys.modules, {"folder_paths": folder_paths}):
    civitai = importlib.import_module(package.__name__ + ".civitai")


class CivitaiHttpTest(llm_fixture.HttpFixture):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        folder_paths.get_folder_paths = lambda kind: [str(self.root)]
        folder_paths.filename_list_cache = {"loras": "old"}
        self.content = b"safetensors-test-content"
        self.sha = hashlib.sha256(self.content).hexdigest()
        self.origin = self.settings["base_url"].removesuffix("/v1")
        self.origin_patch = mock.patch.object(civitai, "api_origin", return_value=self.origin)
        self.origin_patch.start()
        civitai._DOWNLOAD_LOCK = None
        self.settings["civitai_api_key"] = "civitai-secret"
        self.version = {"id": 2, "name": "version", "baseModel": "Illustrious", "trainedWords": ["cat"],
            "images": [{"url": "version-image", "nsfwLevel": 1}], "files": [{"id": 3, "name": "../../unsafe.safetensors", "type": "Model", "hashes": {"SHA256": self.sha}, "downloadUrl": self.origin + "/api/download/models/2"}]}
        self.model = {"id": 1, "name": "cat", "type": "LORA", "modelVersions": [self.version]}
        self.redirect = False
        self.model_requests = []
        self.base_model_parameters = []
        self.download_calls = 0
        self.storage_headers = []
        self.api_status = 200

    async def asyncTearDown(self):
        self.origin_patch.stop()
        self.temporary.cleanup()
        await super().asyncTearDown()

    async def handle(self, request):
        if request.path.startswith("/api/v1/models"):
            self.model_requests.append((dict(request.query), request.headers.get("Authorization")))
            self.base_model_parameters.append(request.query.getall("baseModels", []))
            return web.json_response({"items": [self.model]} if request.path == "/api/v1/models" else self.model, status=self.api_status)
        if request.path.startswith("/api/download"):
            self.download_calls += 1
            if self.redirect:
                # Distinct authority even though both servers are localhost.
                raise web.HTTPFound(self.storage_origin + "/storage")
            return web.Response(body=self.content)
        return await super().handle(request)

    async def test_search_sorts_version_file_image_alignment(self):
        self.model["modelVersions"].insert(0, {"id": 99, "baseModel": "Anima", "images": [{"url": "wrong-image"}], "files": []})
        for sort in civitai.SORTS:
            result = await civitai.search(self.settings, "cat", "Illustrious", sort)
            self.assertEqual(result["items"][0]["version_id"], 2)
            self.assertEqual(result["items"][0]["file_id"], 3)
            self.assertEqual(result["items"][0]["image_url"], "version-image")
            params, authorization = self.model_requests[-1]
            self.assertEqual(params["limit"], "30")
            self.assertEqual(params["period"], "AllTime")
            self.assertEqual(params["sort"], sort)
            self.assertEqual(authorization, "Bearer civitai-secret")
            self.assertEqual(self.base_model_parameters[-1], ["Illustrious", "NoobAI"])
        self.assertEqual(civitai.normalize(self.model, "Anima"), [])

    async def test_noobai_family_search_and_anima_parameters(self):
        self.version["baseModel"] = "NoobAI"
        result = await civitai.search(self.settings, "cat", "Illustrious")
        self.assertEqual(result["items"][0]["base_model"], "NoobAI")
        self.version["baseModel"] = "Anima"
        result = await civitai.search(self.settings, "cat", "Anima")
        self.assertEqual(result["items"][0]["base_model"], "Anima")
        self.assertEqual(self.base_model_parameters[-1], ["Anima"])

    async def test_authorization_origin_includes_scheme_host_and_port(self):
        with mock.patch.object(civitai, "api_origin", return_value="https://civitai.com"):
            self.assertEqual(civitai._headers(self.settings, "https://civitai.com:443/api/download/models/2"), {"Authorization": "Bearer civitai-secret"})
            for url in ("http://civitai.com/api/download/models/2", "http://civitai.com:443/api/download/models/2", "https://civitai.com:444/api/download/models/2", "https://other.example/api/download/models/2"):
                self.assertEqual(civitai._headers(self.settings, url), {}, url)

    async def test_download_safe_path_atomic_hash_dedup_and_incompatible(self):
        identity = {"model_id": 1, "version_id": 2, "file_id": 3}
        result = await civitai.download(self.settings, identity, "Illustrious")
        self.assertEqual(result["lora_name"], "llm/civitai-1-2-3.safetensors")
        self.assertEqual((self.root / result["lora_name"]).read_bytes(), self.content)
        self.assertNotIn("loras", folder_paths.filename_list_cache)
        await civitai.download(self.settings, identity, "Illustrious")
        self.assertEqual(self.download_calls, 1)
        self.version["files"][0]["id"] = 4
        await civitai.download(self.settings, {**identity, "file_id": 4}, "Illustrious")
        self.assertEqual(self.download_calls, 1, "same published SHA256 reuses existing content")
        with self.assertRaises(ValueError):
            await civitai.download(self.settings, identity, "Anima")

    async def test_hash_mismatch_cleans_partial(self):
        self.content = b"corrupt"
        with self.assertRaises(civitai.ServiceError):
            await civitai.download(self.settings, {"model_id": 1, "version_id": 2, "file_id": 3}, "Illustrious")
        self.assertEqual(list((self.root / "llm").iterdir()), [])

    async def test_search_primary_only_and_cached_hash_invalidates(self):
        identity = {"model_id": 1, "version_id": 2, "file_id": 3}
        result = await civitai.download(self.settings, identity, "Illustrious")
        self.version["files"].append({**self.version["files"][0], "id": 4, "primary": True})
        with mock.patch.object(civitai.hashlib, "sha256", wraps=hashlib.sha256) as hash_function:
            found = await civitai.search(self.settings, "cat", "Illustrious")
            self.assertEqual(len(found["items"]), 1)
            self.assertEqual(found["items"][0]["file_id"], 4)
            self.assertTrue(found["items"][0]["acquired"])
            first_count = hash_function.call_count
            await civitai.search(self.settings, "cat", "Illustrious")
            self.assertEqual(hash_function.call_count, first_count)
            (self.root / result["lora_name"]).write_bytes(b"modified")
            found = await civitai.search(self.settings, "cat", "Illustrious")
            self.assertFalse(found["items"][0]["acquired"])
            self.assertGreater(hash_function.call_count, first_count)

    async def test_refetched_download_url_rejects_untrusted_source(self):
        self.version["files"][0]["downloadUrl"] = "https://untrusted.example/file"
        with self.assertRaises(ValueError):
            await civitai.download(self.settings, {"model_id": 1, "version_id": 2, "file_id": 3}, "Illustrious")
        self.assertEqual(self.download_calls, 0)

    async def test_api_error_empty_and_invalid_parameters(self):
        self.api_status = 429
        with self.assertRaises(civitai.ServiceError) as error:
            await civitai.search(self.settings, "query", "Illustrious")
        self.assertIn("429", str(error.exception))
        self.assertNotIn("civitai-secret", str(error.exception))
        self.api_status = 200
        self.model["modelVersions"] = []
        self.assertEqual((await civitai.search(self.settings, "query", "Illustrious"))["items"], [])
        for mode, sort in (("bad", "Most Downloaded"), ("Illustrious", "bad")):
            with self.assertRaises(ValueError):
                await civitai.search(self.settings, "query", mode, sort)

    async def test_redirect_strips_token_on_storage_origin(self):
        async def storage(request):
            self.storage_headers.append(request.headers.get("Authorization"))
            return web.Response(body=self.content)
        app = web.Application()
        app.router.add_get("/storage", storage)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        self.storage_origin = "http://127.0.0.1:" + str(site._server.sockets[0].getsockname()[1])
        self.redirect = True
        try:
            await civitai.download(self.settings, {"model_id": 1, "version_id": 2, "file_id": 3}, "Illustrious")
            self.assertEqual(self.storage_headers, [None])
        finally:
            await runner.cleanup()


if __name__ == "__main__":
    unittest.main()
