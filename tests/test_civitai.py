import asyncio
import hashlib
import importlib
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import test_llm_service as llm_fixture

web = llm_fixture.web
folder_paths = llm_fixture.folder_paths
package = llm_fixture.package

with mock.patch.dict(sys.modules, {"folder_paths": folder_paths}):
    civitai = importlib.import_module(package.__name__ + ".civitai")
    civitai_auth = importlib.import_module(package.__name__ + ".civitai_auth")
sys.modules[civitai.__name__] = civitai
sys.modules[civitai_auth.__name__] = civitai_auth


class CivitaiHttpTest(llm_fixture.HttpFixture):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.auth_directory = mock.patch.object(civitai_auth, "storage_directory", side_effect=lambda user: self.root / "users" / user)
        self.auth_directory.start()
        self.auth_token = mock.patch.object(civitai_auth, "token_snapshot", return_value="fixture-search-key")
        self.auth_token_mock = self.auth_token.start()
        folder_paths.get_folder_paths = lambda kind: [str(self.root)]
        folder_paths.filename_list_cache = {"loras": "old"}
        self.content = b"safetensors-test-content"
        self.sha = hashlib.sha256(self.content).hexdigest()
        self.origin = llm_fixture.settings_module.endpoint(self.settings).removesuffix("/v1").replace("127.0.0.1", "localhost")
        self.origin_patch = mock.patch.object(civitai, "api_origin", return_value=self.origin)
        self.origin_patch.start()
        civitai._DOWNLOAD_LOCK = None
        self.version = {"id": 2, "name": "version", "baseModel": "Illustrious", "trainedWords": ["cat"],
            "images": [{"url": "version-image", "nsfwLevel": 1}], "files": [{"id": 3, "name": "Original LoRA.safetensors", "type": "Model", "hashes": {"SHA256": self.sha}, "downloadUrl": self.origin + "/api/download/models/2"}]}
        self.model = {"id": 1, "name": "cat", "type": "LORA", "modelVersions": [self.version]}
        self.redirect = False
        self.site_requests = []
        self.site_hits = None
        self.ids_parameters = []
        self.hydrated_models = None
        self.model_requests = []
        self.base_model_parameters = []
        self.download_headers = {}
        self.chunked_download = False
        self.encoded_download = False
        self.download_calls = 0
        self.download_status = 200
        self.download_message = None
        self.storage_headers = []
        self.api_status = 200
        self.api_raw = None
        self.hash_status = 200
        self.hash_raw = False
        self.hash_requests = []
        self.hash_result = {"id": 2, "modelId": 1, "name": "version", "model": {"name": "cat", "description": "private provider body"},
                            "trainedWords": ["cat"], "files": [{"downloadUrl": "secret URL"}]}

    async def asyncTearDown(self):
        self.auth_token.stop()
        self.auth_directory.stop()
        self.origin_patch.stop()
        self.temporary.cleanup()
        await super().asyncTearDown()

    async def handle(self, request):
        self.assertIn(request.headers.get("Authorization"), (None, "Bearer fixture-search-key"))
        if request.path not in ("/api/v1/models", "/api/search/multi-search"): self.assertIsNone(request.headers.get("Authorization"))
        self.assertIsNone(request.headers.get("Cookie"))
        self.assertNotIn("token", request.query)
        if request.path.startswith("/api/v1/model-versions/by-hash/"):
            self.hash_requests.append((request.path, request.headers.get("Authorization")))
            if self.hash_raw:
                return web.Response(text="private provider body", content_type="application/json", status=self.hash_status)
            response = web.json_response(self.hash_result, status=self.hash_status)
            response.set_cookie("provider_session", "should-not-be-replayed")
            return response
        if request.path == "/api/search/multi-search":
            body = await request.json()
            self.site_requests.append((body, request.headers.get("Authorization")))
            if self.api_raw is not None:
                return web.Response(text=self.api_raw, content_type="application/json", status=self.api_status)
            query = body["queries"][0]
            result = {"facetDistribution": {"category.name": {"Style": 12, "Concept": 3}}} if query["limit"] == 0 else {"hits": self.site_hits if self.site_hits is not None else [{"id": self.model["id"], "metrics": self.model.get("stats", {})}]}
            return web.json_response({"results": [result]}, status=self.api_status)
        if request.path == "/api/v1/enums":
            return web.json_response({"ModelType": ["Checkpoint", "LORA", "CLIP"]})
        if request.path.startswith("/api/v1/models"):
            self.model_requests.append((dict(request.query), request.headers.get("Authorization")))
            self.base_model_parameters.append(request.query.getall("baseModels", []))
            self.ids_parameters.append(request.query.getall("ids", []))
            if self.api_raw is not None:
                return web.Response(text=self.api_raw, content_type="application/json", status=self.api_status)
            return web.json_response({"items": self.hydrated_models if self.hydrated_models is not None else [self.model]} if request.path == "/api/v1/models" else self.model, status=self.api_status)
        if request.path.startswith("/api/download"):
            self.download_calls += 1
            if self.download_status != 200:
                return web.json_response({"message": self.download_message}, status=self.download_status)
            if self.redirect:
                # Distinct authority even though both servers are localhost.
                response = web.HTTPFound(self.storage_origin + "/storage?signature=provider-signature")
                response.set_cookie("provider_session", "should-not-be-replayed")
                raise response
            if self.chunked_download:
                response = web.StreamResponse(headers=self.download_headers); await response.prepare(request)
                await response.write(self.content[:5]); await response.write(self.content[5:]); await response.write_eof(); return response
            if self.encoded_download:
                import gzip
                return web.Response(body=gzip.compress(self.content), headers={**self.download_headers, "Content-Encoding": "gzip"})
            return web.Response(body=self.content, headers=self.download_headers)
        return await super().handle(request)

    async def test_site_order_hydration_filters_and_bookmarks(self):
        import copy
        second, unknown = copy.deepcopy(self.model), copy.deepcopy(self.model)
        second["id"], unknown["id"] = 2, 99
        self.model["stats"] = {"collectedCount": 0, "thumbsUpCount": 5, "favoriteCount": 100}
        second["stats"] = {"thumbsUpCount": 7, "favoriteCount": 88}
        self.hydrated_models = [self.model, unknown, second]
        self.site_hits = [{"id": 2, "metrics": {"collectedCount": 233, "favoriteCount": 9999}, "createdAt": "2026-11-15T00:00:00Z"},
                          {"id": 1, "metrics": {"collectedCount": 229}}, {"id": 2, "metrics": {"collectedCount": 999}}, {"id": 3}, {"id": True}, {"id": "4"}, {"id": -1}]
        category = 'Concept" OR category.name = "Other'
        result = await civitai.search("ranked query", "Illustrious", "Relevancy", category=category, user_id="alice")
        self.auth_token_mock.assert_called_with("alice")
        self.assertEqual([item["model_id"] for item in result["items"]], [2, 1])
        self.assertEqual([item["model_stats"]["collectedCount"] for item in result["items"]], [233, 0])
        self.assertEqual(result["items"][0]["model_stats"]["thumbsUpCount"], 7)
        self.assertIsNone(result["items"][0]["updated_at"], "createdAt never substitutes for updatedAt")
        query = self.site_requests[-1][0]["queries"][0]
        self.assertEqual(query["indexUid"], "models_v9")
        self.assertEqual(query["q"], "ranked query")
        self.assertEqual(query["attributesToRetrieve"], ["id", "metrics", "createdAt", "lastVersionAt"])
        self.assertEqual(query["filter"], 'type = "LORA" AND (versions.baseModel = "Illustrious" OR versions.baseModel = "Illustrious XL") AND category.name = ' + json.dumps(category))
        self.assertNotIn("sort", query)
        self.assertEqual(self.ids_parameters[-1], ["2", "1", "3"])
        self.assertEqual(set(self.model_requests[-1][0]), {"ids", "limit", "nsfw"})
        self.assertEqual(len(self.site_requests), 1)
        self.assertEqual(len(self.model_requests), 1)
        second["stats"] = {}
        self.site_hits = [{"id": 2}]
        result = await civitai.search("missing", "Illustrious")
        self.assertNotIn("collectedCount", result["items"][0]["model_stats"])
        self.site_hits = []
        before = len(self.model_requests)
        self.assertEqual((await civitai.search("empty", "Illustrious"))["items"], [])
        self.assertEqual(len(self.model_requests), before)

    async def test_official_category_options_and_authenticated_or_anonymous_hosts(self):
        with mock.patch.object(civitai_auth, "token_snapshot", return_value=""):
            data = await civitai.options("civitai.red", user_id="alice")
            self.assertEqual(data["categories"], [])
            self.assertEqual(self.site_requests, [])
            self.assertEqual((await civitai.options("civitai.com"))["categories"], ["Style", "Concept"])
            self.assertIsNone(self.site_requests[-1][1])
        data = await civitai.options("civitai.red")
        self.assertEqual(data["categories"], ["Style", "Concept"])
        query, authorization = self.site_requests[-1]
        self.assertEqual(query, {"queries": [{"indexUid": "models_v9", "q": "", "limit": 0, "facets": ["category.name"]}]})
        self.assertEqual(authorization, "Bearer fixture-search-key")
        await civitai.search("com keyed", "Illustrious", host="civitai.com")
        self.assertEqual(self.site_requests[-1][1], "Bearer fixture-search-key")
        self.assertEqual(self.model_requests[-1][1], "Bearer fixture-search-key")
        self.api_status = 302
        with self.assertRaisesRegex(civitai.ServiceError, "302"):
            await civitai.search("no redirect", "Illustrious")

    async def test_search_token_is_scoped_to_red_models_only(self):
        await civitai.api_get("/api/v1/models/1", host="civitai.red", token="fixture-search-key")
        await civitai.api_get("/api/v1/models", host="civitai.com", token="fixture-search-key")
        self.assertEqual([headers for _, headers in self.model_requests], [None, "Bearer fixture-search-key"])
        await civitai.api_get("/api/v1/models", host="civitai.red", token="fixture-search-key")
        self.assertEqual(self.model_requests[-1][1], "Bearer fixture-search-key")

    async def test_destination_tree_and_safe_relative_paths(self):
        for path in ("a/b", "c/local/bin", "c/local/lib"):
            (self.root / path).mkdir(parents=True)
        (self.root / "weight.safetensors").write_bytes(b"not-a-folder")
        self.assertEqual(civitai.directories(), {"directories": ["", "a", "a/b", "c", "c/local", "c/local/bin", "c/local/lib"]})
        for path in ("../outside", "/absolute", "C:" + "/drive", "a/../../outside"):
            with self.subTest(path=path), mock.patch.object(civitai, "api_get") as get, self.assertRaises(ValueError):
                await civitai.download({"model_id": 1, "version_id": 2, "file_id": 3}, "Illustrious", directory=path)
            get.assert_not_called()
        with tempfile.TemporaryDirectory() as outside:
            try:
                (self.root / "outside").symlink_to(outside, target_is_directory=True)
                (self.root / "a" / "loop").symlink_to(self.root, target_is_directory=True)
            except OSError:
                return  # Windows can prohibit symlinks without Developer Mode.
            self.assertNotIn("outside", civitai.directories()["directories"])
            self.assertNotIn("a/loop", civitai.directories()["directories"])
            with self.assertRaises(ValueError):
                civitai._relative_target(self.root, "outside/new")

    async def test_destination_download_reuse_manifest_and_hash_failure(self):
        ids = {"model_id": 1, "version_id": 2, "file_id": 3}
        first = await civitai.download(ids, "Illustrious", directory="")
        self.assertNotIn("/", first["lora_name"])
        second = await civitai.download(ids, "Illustrious", directory="")
        self.assertEqual(first["lora_name"], second["lora_name"])
        self.assertEqual(self.download_calls, 1)
        third = await civitai.download(ids, "Illustrious", directory="a/b")
        self.assertTrue(third["lora_name"].startswith("a/b/"))
        self.assertEqual(self.download_calls, 2)
        self.assertEqual((await civitai.search("cat", "Illustrious"))["items"][0]["lora_name"], third["lora_name"])
        destination = self.root / third["lora_name"]
        destination.write_bytes(b"keep-existing")
        self.content = b"invalid-new-content"
        with self.assertRaisesRegex(ValueError, "同名"):
            await civitai.download(ids, "Illustrious", directory="a/b")
        self.assertEqual(destination.read_bytes(), b"keep-existing")
        self.assertFalse(list((self.root / "a/b").glob("*.part")))

    async def test_red_authentication_search_only_and_missing_key_rejected_before_http(self):
        with mock.patch.object(civitai_auth, "token_snapshot", return_value=""), mock.patch.object(civitai, "api_get") as get:
            with self.assertRaises(civitai.DownloadAccessError) as failure:
                await civitai.search("cat", "Illustrious")
            self.assertEqual(failure.exception.status, 401)
            get.assert_not_called()
        await civitai.search("cat", "Illustrious")
        self.assertEqual(self.model_requests[-1][1], "Bearer fixture-search-key")
        with mock.patch.object(civitai_auth, "token_snapshot", return_value=""):
            await civitai.search("cat", "Illustrious", host="civitai.com")
        self.assertIsNone(self.model_requests[-1][1])
        self.api_status = 401
        with self.assertRaises(civitai.DownloadAccessError) as failure:
            await civitai.search("cat", "Illustrious")
        self.assertEqual(failure.exception.code, "civitai_auth_required")

    async def test_by_hash_returns_only_metadata_without_any_local_model_access(self):
        with mock.patch.object(civitai, "lora_root", side_effect=AssertionError("local model access")), \
                mock.patch.object(civitai, "_sha256", side_effect=AssertionError("local hash")):
            result = await civitai.by_hash(self.sha.upper())
        self.assertEqual(result, {"found": True, "version": {"id": 2, "modelId": 1, "name": "version",
                                "baseModel": "", "model": {"name": "cat"}, "trainedWords": ["cat"]}})
        self.assertEqual(self.hash_requests, [("/api/v1/model-versions/by-hash/" + self.sha, None)])
        self.assertNotIn("private", str(result))
        self.assertNotIn("secret", str(result))

    async def test_download_401_messages_are_safe_and_temporary_files_are_removed(self):
        self.download_status = 401
        for message, code, expected in [
            ("The creator of this asset requires you to be logged in to download it", "civitai_auth_required", "認証が必要"),
            ("The creator of this asset has disabled downloads on this file", "civitai_download_disabled", "無効"),
            ("<html>private secret URL</html>", "civitai_auth_required", "取得を拒否"),
        ]:
            self.download_message = message
            with self.subTest(message=message), self.assertRaises(civitai.DownloadAccessError) as failure:
                await civitai.download({"model_id": 1, "version_id": 2, "file_id": 3}, "Illustrious")
            self.assertEqual(failure.exception.status, 401)
            self.assertEqual(failure.exception.code, code)
            self.assertIn(expected, str(failure.exception))
            self.assertNotIn("private", str(failure.exception))
            self.assertEqual(list(self.root.rglob("*.part")), [])
            self.assertEqual(list(self.root.rglob("*.safetensors")), [])
            self.assertFalse((self.root / "llm" / "manifest.json").exists())

    async def test_descriptions_use_selected_version_without_local_model_access(self):
        self.model["description"] = "<h2>Outfits</h2><pre><code>blue_coat</code></pre>"
        self.version["description"] = "<p>Selected version</p>"
        self.model["modelVersions"].insert(0, {"id": 9, "description": "Other version"})
        with mock.patch.object(civitai, "lora_root", side_effect=AssertionError("local model access")), \
                mock.patch.object(civitai, "_sha256", side_effect=AssertionError("local hash")):
            result = await civitai.descriptions(1, 2)
        self.assertEqual(result, {"base_model": "Illustrious", "description": self.model["description"], "version_description": self.version["description"]})
        self.assertEqual(len(self.model_requests), 1)
        self.assertEqual(self.download_calls, 0)
        self.model["description"], self.version["description"] = None, None
        self.assertEqual(await civitai.descriptions(1, 2), {"base_model": "Illustrious", "description": "", "version_description": ""})

    async def test_descriptions_validate_ids_before_http_and_fallback_to_com(self):
        for invalid in (0, -1, True, "1", None, 1.5):
            for ids in ((invalid, 2), (1, invalid)):
                with self.subTest(ids=ids), self.assertRaises(ValueError):
                    await civitai.descriptions(*ids)
        self.assertEqual(self.model_requests, [])
        failures = [civitai.ServiceError("offline"), None, {**self.model, "id": 99},
                    {**self.model, "id": True}, {**self.model, "modelVersions": {}},
                    {**self.model, "modelVersions": [{"id": "2"}]},
                    {**self.model, "description": 7}]
        for bad in failures:
            with self.subTest(bad=bad), mock.patch.object(civitai, "api_get", side_effect=[bad, self.model]) as fetched:
                self.assertEqual(await civitai.descriptions(1, 2), {"base_model": "Illustrious", "description": "", "version_description": ""})
                self.assertEqual([call.kwargs["host"] for call in fetched.await_args_list], ["civitai.red", "civitai.com"])
        with mock.patch.object(civitai, "api_get", return_value={**self.model, "modelVersions": []}):
            with self.assertRaisesRegex(civitai.ServiceError, "version was not found"):
                await civitai.descriptions(1, 2)

    async def test_by_hash_missing_is_explicit_but_other_failures_remain_errors(self):
        self.hash_status = 404
        self.assertEqual(await civitai.by_hash(self.sha), {"found": False, "version": None})
        for status in (401, 429, 500):
            self.hash_status = status
            with self.subTest(status=status), self.assertRaisesRegex(civitai.ServiceError, str(status)) as error:
                await civitai.by_hash(self.sha)
            self.assertNotIn("secret", str(error.exception))
            self.assertNotIn("private", str(error.exception))
        self.hash_status, self.hash_raw = 200, True
        with self.assertRaisesRegex(civitai.ServiceError, "invalid JSON"):
            await civitai.by_hash(self.sha)
        with mock.patch.object(civitai.aiohttp.ClientSession, "get", side_effect=llm_fixture.aiohttp.ClientConnectionError()):
            with self.assertRaisesRegex(civitai.ServiceError, "connection failed"):
                await civitai.by_hash(self.sha)

    async def test_by_hash_rejects_bad_hash_before_http_and_malformed_success(self):
        for value in ("", "a" * 63, "g" * 64, "a" * 64 + "/file", None, 1):
            with self.subTest(value=value), self.assertRaises(ValueError):
                await civitai.by_hash(value)
        self.assertEqual(self.hash_requests, [])
        valid = self.hash_result
        for value in (None, [], {}, {**valid, "id": True}, {**valid, "modelId": "1"},
                      {**valid, "model": {}}, {**valid, "trainedWords": "cat"}, {**valid, "trainedWords": [1]}):
            self.hash_result = value
            with self.subTest(value=value), self.assertRaisesRegex(civitai.ServiceError, "invalid version"):
                await civitai.by_hash(self.sha)

    async def test_empty_truncated_and_html_upstream_responses_recover(self):
        for raw in ("", '{"items":[', "<html>provider error</html>"):
            self.api_raw = raw
            with self.subTest(raw=raw), self.assertRaisesRegex(civitai.ServiceError, "invalid JSON.*HTTP 200") as failure:
                await civitai.search("cat", "Illustrious")
            self.assertNotIn("provider error", str(failure.exception))
        self.api_raw = None
        self.assertEqual(len((await civitai.search("cat", "Illustrious"))["items"]), 1)

    async def test_search_sorts_version_file_image_alignment(self):
        self.model["modelVersions"].insert(0, {"id": 99, "baseModel": "Anima", "images": [{"url": "wrong-image"}], "files": []})
        for sort in civitai.SORTS:
            result = await civitai.search("cat", "Illustrious", sort)
            self.assertEqual(result["items"][0]["version_id"], 2)
            self.assertEqual(result["items"][0]["file_id"], 3)
            self.assertEqual(result["items"][0]["image_url"], "version-image")
            self.assertTrue(result["items"][0]["model_url"].startswith("https://civitai.red/models/"))
            params, authorization = self.model_requests[-1]
            self.assertEqual(params, {"ids": "1", "limit": "30", "nsfw": "true"})
            request = self.site_requests[-1][0]["queries"][0]
            self.assertEqual(request["q"], "cat")
            self.assertEqual(request["limit"], 30)
            expected = {"Highest Rated": "metrics.thumbsUpCount:desc", "Most Downloaded": "metrics.downloadCount:desc", "Most Liked": "metrics.favoriteCount:desc", "Most Collected": "metrics.collectedCount:desc", "Newest": "createdAt:desc"}
            if sort == "Relevancy": self.assertNotIn("sort", request)
            else: self.assertEqual(request["sort"], [expected[sort]])
            self.assertIn('versions.baseModel = "Illustrious"', request["filter"])
            self.assertIn('versions.baseModel = "Illustrious XL"', request["filter"])
            self.assertEqual(authorization, "Bearer fixture-search-key")
        self.assertEqual(civitai.normalize(self.model, "Anima"), [])

    async def test_metadata_gallery_and_host_are_bound_to_selected_version(self):
        self.model.update(description="Model description", stats={"downloadCount": 90})
        self.version.update(description="Version description", publishedAt="2026-08-02", createdAt="2026-07-01", stats={"downloadCount": 12})
        self.version["images"] = [{"url": "first", "width": 600, "height": 800}, {"url": "hidden", "nsfwLevel": 2}, {"url": "video", "type": "video"},
                                  {"url": "second", "width": 900, "height": 600}, {"url": "hidden2", "nsfw": True}]
        result = await civitai.search("cat", "Illustrious", host="civitai.com")
        item = result["items"][0]
        self.assertEqual(item["description"], "Model description")
        self.assertEqual(item["version_description"], "Version description")
        self.assertEqual(item["published_at"], "2026-08-02")
        self.assertEqual(item["model_stats"], {"downloadCount": 90})
        self.assertEqual(item["version_stats"], {"downloadCount": 12})
        self.assertEqual(item["gallery"], [{"url": "first", "width": 600, "height": 800}, {"url": "second", "width": 900, "height": 600}])
        self.assertEqual(item["image_url"], "first")
        self.model["stats"]["unusedFutureField"] = "ignored"
        self.assertEqual(civitai.normalize(self.model, "Illustrious")[0]["model_stats"]["unusedFutureField"], "ignored")
        self.assertTrue(item["model_url"].startswith("https://civitai.com/"))
        del self.version["publishedAt"]
        self.assertEqual(civitai.normalize(self.model, "Illustrious")[0]["published_at"], "2026-07-01")

    async def test_host_allowlist_and_canonical_download_origin(self):
        with mock.patch.object(civitai, "api_get", return_value=self.model) as get:
            for host in ("evil.example", "https://civitai.com", "civitai.com.evil", None):
                with self.subTest(host=host), self.assertRaises(ValueError):
                    await civitai.search("cat", "Illustrious", host=host)
                with self.assertRaises(ValueError):
                    await civitai.download({"model_id": 1, "version_id": 2, "file_id": 3}, "Illustrious", host=host)
            get.assert_not_called()
        self.version["files"][0]["downloadUrl"] = "https://civitai.com/api/download/models/2?type=Model"
        result = await civitai.download({"model_id": 1, "version_id": 2, "file_id": 3, "downloadUrl": "https://evil.example/file"}, "Illustrious", host="civitai.red")
        self.assertEqual((self.root / result["lora_name"]).read_bytes(), self.content)
        self.assertEqual(self.download_calls, 1, "canonical com authority is rewritten through selected red origin")

    async def test_upstream_used_schema_errors_are_service_errors(self):
        import copy
        for target, key, invalid in [("version", "images", {}), ("version", "images", [None]), ("version", "images", [{"url": 1}]),
                                     ("version", "files", {}),
                                     ("version", "trainedWords", [1]), ("version", "description", []), ("version", "stats", []),
                                     ("file", "hashes", []), ("model", "id", None)]:
            model = copy.deepcopy(self.model)
            obj = model if target == "model" else model["modelVersions"][0] if target == "version" else model["modelVersions"][0]["files"][0]
            obj[key] = invalid
            with self.subTest(target=target, key=key), self.assertRaises(civitai.ServiceError) as failure:
                civitai.normalize(model, "Illustrious")
            self.assertEqual(failure.exception.status, 502)

    async def test_hash_fallback_only_caches_two_confirmed_missing_results(self):
        valid = self.hash_result
        cases = [(valid, None, True, 1), (civitai._NOT_FOUND, valid, True, 2), (civitai.ServiceError("red failure"), valid, True, 2),
                 (civitai._NOT_FOUND, civitai._NOT_FOUND, False, 2)]
        for red, com, found, count in cases:
            with self.subTest(red=red, com=com), mock.patch.object(civitai, "api_get", side_effect=[red, com]) as lookup:
                self.assertEqual((await civitai.by_hash(self.sha))["found"], found)
                self.assertEqual(lookup.await_count, count)
                self.assertEqual([call.kwargs["host"] for call in lookup.await_args_list], list(civitai.HOSTS[:count]))
        for red, com in [(civitai.ServiceError("red failure"), civitai._NOT_FOUND), (civitai._NOT_FOUND, civitai.ServiceError("com failure")),
                         (civitai.ServiceError("red failure"), civitai.ServiceError("com failure")), ({}, {}), ({}, civitai._NOT_FOUND)]:
            with self.subTest(red=red, com=com), mock.patch.object(civitai, "api_get", side_effect=[red, com]), self.assertRaises(civitai.ServiceError):
                await civitai.by_hash(self.sha)
        with mock.patch.object(civitai, "api_get", side_effect=[{}, valid]):
            self.assertTrue((await civitai.by_hash(self.sha))["found"], "malformed red response still falls back to com")

    async def test_fixed_red_origin_and_no_time_budget(self):
        self.origin_patch.stop()
        self.assertEqual(civitai.api_origin(), "https://civitai.red")
        self.assertEqual(civitai.api_origin("civitai.com"), "https://civitai.com")
        self.origin_patch.start()
        with mock.patch.object(llm_fixture.aiohttp, "ClientTimeout", wraps=llm_fixture.aiohttp.ClientTimeout) as timeout:
            await civitai.search("cat", "Illustrious")
            await civitai.download({"model_id": 1, "version_id": 2, "file_id": 3}, "Illustrious")
            self.assertEqual(timeout.call_args_list, [mock.call(total=None)] * 4)

    async def test_four_model_families_search_and_download_are_separate(self):
        identity = {"model_id": 1, "version_id": 2, "file_id": 3}
        for mode in ("Illustrious", "Anima", "NoobAI", "Pony"):
            for family in ("Illustrious", "Anima", "NoobAI", "Pony", "Pony V7"):
                with self.subTest(mode=mode, family=family):
                    self.version["baseModel"] = family
                    result = await civitai.search("cat", mode)
                    self.assertIn("versions.baseModel = " + json.dumps(mode), self.site_requests[-1][0]["queries"][0]["filter"])
                    self.assertEqual(len(result["items"]), int(mode == family))
                    if mode == family:
                        self.assertEqual(result["items"][0]["base_model"], family)
                        self.assertTrue((await civitai.download(identity, mode))["lora_name"])
                    else:
                        with self.assertRaises(ValueError):
                            await civitai.download(identity, mode)
        for family in ("Illustrious", "NoobAI"):
            self.assertTrue(civitai.compatible(f"{family} XL", family))
            other = "NoobAI" if family == "Illustrious" else "Illustrious"
            self.assertFalse(civitai.compatible(f"{family} XL", other))

    async def test_final_download_filename_headers_unicode_and_invalid_names(self):
        from urllib.parse import quote
        ids = {"model_id": 1, "version_id": 2, "file_id": 3}
        for index, (header, expected) in enumerate([
            (None, "Original LoRA.safetensors"),
            ('attachment; filename="Quoted Name.safetensors"', "Quoted Name.safetensors"),
            ('attachment; filename=Plain.safetensors', "Plain.safetensors"),
            ("attachment; filename=fallback.safetensors; filename*=UTF-8''" + quote("衣装 LoRA.safetensors"), "衣装 LoRA.safetensors"),
        ]):
            self.download_headers = {"Content-Disposition": header} if header else {}
            result = await civitai.download(ids, "Illustrious", directory=str(index))
            self.assertEqual(result["lora_name"], str(index) + "/" + expected)
            self.assertEqual((self.root / result["lora_name"]).read_bytes(), self.content)
        self.download_headers = {}
        self.version["files"][0]["name"] = "API 衣装 LoRA.safetensors"
        unicode_name = await civitai.download(ids, "Illustrious", directory="unicode-api")
        self.assertEqual(unicode_name["lora_name"], "unicode-api/API 衣装 LoRA.safetensors")
        self.version["files"][0]["name"] = "Original LoRA.safetensors"
        for index, invalid in enumerate(["../bad.safetensors", "a/b.safetensors", "a\\b.safetensors", "CON.safetensors", "COM1.safetensors", "bad?.safetensors", "bad.safetensors ", "bad.safetensors.", "bad.txt"]):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, "filename"):
                self.download_headers = {"Content-Disposition": "attachment; filename*=UTF-8''" + quote(invalid, safe="")}
                await civitai.download(ids, "Illustrious", directory="invalid-" + str(index))
            self.assertFalse(list((self.root / ("invalid-" + str(index))).iterdir()))
        for index, invalid in enumerate(["/absolute.safetensors", "\\root.safetensors", "X" + ":\\drive.safetensors"]):
            self.download_headers = {"Content-Disposition": 'attachment; filename="' + invalid.replace("\\", "\\\\") + '"'}
            with self.subTest(header=invalid), self.assertRaisesRegex(ValueError, "filename"):
                await civitai.download(ids, "Illustrious", directory="absolute-" + str(index))
        self.download_headers = {}
        self.version["files"][0]["name"] = "../../escape.safetensors"
        with self.assertRaisesRegex(ValueError, "filename"):
            await civitai.download(ids, "Illustrious", directory="unsafe-api")
        self.assertFalse(list((self.root / "unsafe-api").iterdir()))

    async def test_download_reports_actual_written_bytes_with_known_and_unknown_totals(self):
        identity = {"model_id": 1, "version_id": 2, "file_id": 3}
        for chunked, encoded in ((False, False), (True, False), (False, True)):
            self.chunked_download, self.encoded_download = chunked, encoded
            events = []
            await civitai.download(identity, "Illustrious", directory=str(chunked)+str(encoded), progress=lambda received, total: events.append((received, total)))
            total = None if chunked or encoded else len(self.content)
            self.assertEqual(events[0], (0, total))
            self.assertEqual(events[-1], (len(self.content), total))
            self.assertTrue(all(a[0] <= b[0] for a, b in zip(events, events[1:])))
        def offline(*args):
            raise RuntimeError("websocket closed")
        self.assertTrue((await civitai.download(identity, "Illustrious", directory="offline-progress", progress=offline))["lora_name"])

    async def test_original_name_collision_preserves_existing_and_legacy_manifest_reuses_name(self):
        ids = {"model_id": 1, "version_id": 2, "file_id": 3}
        folder = self.root / "llm"; folder.mkdir()
        path = folder / "Original LoRA.safetensors"; path.write_bytes(b"different hash")
        with self.assertRaisesRegex(ValueError, "同名"):
            await civitai.download(ids, "Illustrious")
        self.assertEqual(path.read_bytes(), b"different hash")
        self.assertFalse(list(folder.glob("*.part")))
        path.unlink()
        legacy = folder / "civitai-1-2-3.safetensors"; legacy.write_bytes(self.content)
        (folder / "manifest.json").write_text(json.dumps({"1-2-3": {"sha256": self.sha, "lora_name": "llm/" + legacy.name}}), encoding="utf-8")
        before = self.download_calls
        result = await civitai.download(ids, "Illustrious")
        self.assertEqual(result["lora_name"], "llm/" + legacy.name)
        self.assertEqual(self.download_calls, before)
        self.assertFalse(path.exists())

    async def test_search_creator_and_index_updated_date_are_not_created_dates(self):
        self.model["creator"] = {"username": "作者 <script>"}
        self.model["createdAt"] = "2020-01-01T00:00:00Z"
        self.site_hits = [{"id": 1, "createdAt": "2021-01-01T00:00:00Z", "lastVersionAt": "2025-11-15T12:00:00Z"}]
        found = (await civitai.search("cat", "Illustrious"))["items"][0]
        self.assertEqual(found["updated_at"], "2025-11-15T12:00:00Z")
        self.assertEqual(found["creator_name"], "作者 <script>")
        self.assertNotIn("lastVersionAt", self.model)
        self.version["updatedAt"] = "2026-01-01T00:00:00Z"
        self.assertEqual((await civitai.search("cat", "Illustrious"))["items"][0]["updated_at"], self.version["updatedAt"])
        self.version.pop("updatedAt"); self.site_hits[0].pop("lastVersionAt"); self.model.pop("creator")
        missing = (await civitai.search("cat", "Illustrious"))["items"][0]
        self.assertIsNone(missing["updated_at"]); self.assertEqual(missing["creator_name"], "")

    async def test_download_safe_path_atomic_hash_dedup_and_incompatible(self):
        identity = {"model_id": 1, "version_id": 2, "file_id": 3}
        result = await civitai.download(identity, "Illustrious")
        self.assertEqual(result["lora_name"], "llm/Original LoRA.safetensors")
        self.assertEqual((self.root / result["lora_name"]).read_bytes(), self.content)
        self.assertNotIn("loras", folder_paths.filename_list_cache)
        await civitai.download(identity, "Illustrious")
        self.assertEqual(self.download_calls, 1)
        self.version["files"][0]["id"] = 4
        await civitai.download({**identity, "file_id": 4}, "Illustrious")
        self.assertEqual(self.download_calls, 1, "same published SHA256 reuses existing content")
        with self.assertRaises(ValueError):
            await civitai.download(identity, "Anima")

    async def test_hash_mismatch_cleans_partial(self):
        self.content = b"corrupt"
        with self.assertRaises(civitai.ServiceError):
            await civitai.download({"model_id": 1, "version_id": 2, "file_id": 3}, "Illustrious")
        self.assertEqual(list((self.root / "llm").iterdir()), [])

    async def test_multichunk_download_hashes_during_write_without_temp_reread(self):
        self.content = bytes(range(256)) * 13001
        self.version["files"][0]["hashes"]["SHA256"] = hashlib.sha256(self.content).hexdigest()
        original_hash = civitai._sha256
        hashed_paths = []
        def acquired_hash(path):
            self.assertFalse(path.name.startswith(".download-"), "new download must not be reread for hashing")
            hashed_paths.append(path)
            return original_hash(path)
        with mock.patch.object(civitai, "_sha256", side_effect=acquired_hash):
            identity = {"model_id": 1, "version_id": 2, "file_id": 3}
            result = await civitai.download(identity, "Illustrious")
            self.assertEqual((self.root / result["lora_name"]).read_bytes(), self.content)
            self.assertEqual(hashed_paths, [])
            await civitai.download(identity, "Illustrious")
            self.assertTrue(hashed_paths, "existing acquisition still validates its local file")
            self.assertEqual(self.download_calls, 1)
        self.assertFalse(list((self.root / "llm").glob(".download-*")))

    async def test_multichunk_hash_mismatch_never_promotes_or_rereads_partial(self):
        self.content = b"wrong content" * 200000
        with mock.patch.object(civitai, "_sha256", side_effect=AssertionError("temporary file reread")):
            with self.assertRaisesRegex(civitai.ServiceError, "SHA256"):
                await civitai.download({"model_id": 1, "version_id": 2, "file_id": 3}, "Illustrious")
        self.assertEqual(list((self.root / "llm").iterdir()), [])

    async def cancel_at_file_stage(self, stage):
        started, release = asyncio.Event(), threading.Event()
        loop = asyncio.get_running_loop()
        paused = False
        descriptors, streams = [], []
        original_mkstemp, original_fdopen = civitai.tempfile.mkstemp, civitai.os.fdopen
        original_replace, original_unlink = civitai.os.replace, civitai.os.unlink
        original_discard = civitai._discard_download
        def pause():
            nonlocal paused
            if paused:
                return False
            paused = True
            loop.call_soon_threadsafe(started.set)
            release.wait()
            return True
        def mkstemp(*args, **kwargs):
            descriptor, path = original_mkstemp(*args, **kwargs)
            descriptors.append(descriptor)
            if stage == "create" and kwargs.get("prefix") == ".download-":
                pause()
            return descriptor, path
        class Stream:
            def __init__(self, stream):
                self.stream = stream
                streams.append(stream)
            def write(self, chunk):
                if stage in ("write", "write_failure") and pause():
                    if stage == "write_failure":
                        raise OSError("worker write failed after cancellation")
                return self.stream.write(chunk)
            def close(self):
                if stage == "close":
                    pause()
                self.stream.close()
        def fdopen(descriptor, mode, **kwargs):
            stream = original_fdopen(descriptor, mode, **kwargs)
            return Stream(stream) if mode == "wb" else stream
        def replace(source, destination):
            if (stage == "promote" and str(destination).endswith(".safetensors")) or \
                    (stage == "manifest" and str(destination).endswith("manifest.json")):
                pause()
            return original_replace(source, destination)
        def unlink(path, *args, **kwargs):
            if stage == "unlink" and str(path).endswith(".part"):
                pause()
            return original_unlink(path, *args, **kwargs)
        cleanup_started = False
        def discard(download):
            nonlocal cleanup_started
            cleanup_started = True
            return original_discard(download)
        if stage == "unlink":
            self.content = b"incorrect hash"
        identity = {"model_id": 1, "version_id": 2, "file_id": 3}
        with mock.patch.object(civitai.tempfile, "mkstemp", side_effect=mkstemp), \
                mock.patch.object(civitai.os, "fdopen", side_effect=fdopen), \
                mock.patch.object(civitai.os, "replace", side_effect=replace), \
                mock.patch.object(civitai.os, "unlink", side_effect=unlink), \
                mock.patch.object(civitai, "_discard_download", side_effect=discard):
            task = asyncio.create_task(civitai.download(identity, "Illustrious"))
            following = None
            try:
                await asyncio.wait_for(started.wait(), 3)
                task.cancel()
                await asyncio.sleep(0)
                task.cancel()
                await asyncio.sleep(0)
                self.assertFalse(task.done(), "cancellation must wait for the active worker")
                self.assertTrue(civitai._DOWNLOAD_LOCK.locked())
                if stage in ("create", "write", "write_failure", "close"):
                    self.assertFalse(cleanup_started, "cleanup cannot race the active worker")
                    self.assertTrue(list((self.root / "llm").glob(".download-*.part")))
                    civitai.os.fstat(descriptors[0])
                self.content = b"safetensors-test-content"
                following = asyncio.create_task(civitai.download(identity, "Illustrious"))
                await asyncio.sleep(0)
                self.assertFalse(following.done())
            finally:
                release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
            result = await following
        destination = self.root / result["lora_name"]
        self.assertEqual(destination.read_bytes(), self.content)
        self.assertFalse(civitai._DOWNLOAD_LOCK.locked())
        self.assertFalse(list((self.root / "llm").glob(".download-*")))
        self.assertFalse(list((self.root / "llm").glob(".manifest-*")))
        self.assertTrue(all(stream.closed for stream in streams))
        for descriptor in descriptors:
            with self.assertRaises(OSError):
                civitai.os.fstat(descriptor)
        self.assertEqual(self.download_calls, 1 if stage in ("create", "promote", "manifest") else 2,
                         "a verified promoted download survives cancellation and is reused")
        manifest = json.loads((self.root / "llm" / "manifest.json").read_text())
        self.assertEqual(manifest["1-2-3"]["sha256"], self.sha)

    async def test_cancel_creation_settles_mkstemp_and_closes_eventual_descriptor(self):
        await self.cancel_at_file_stage("create")

    async def test_cancel_write_settles_worker_before_cleanup_and_next_download(self):
        await self.cancel_at_file_stage("write")

    async def test_cancel_write_worker_failure_still_cleans_and_propagates_cancellation(self):
        await self.cancel_at_file_stage("write_failure")

    async def test_cancel_close_settles_before_unlink(self):
        await self.cancel_at_file_stage("close")

    async def test_cancel_promotion_preserves_verified_file_for_retry(self):
        await self.cancel_at_file_stage("promote")

    async def test_cancel_manifest_settles_before_lock_release(self):
        await self.cancel_at_file_stage("manifest")

    async def test_cancel_unlink_settles_cleanup_before_lock_release(self):
        await self.cancel_at_file_stage("unlink")

    async def test_close_failure_still_removes_unpromoted_temporary_file(self):
        original_create = civitai._create_download
        owned = []
        class FailingClose:
            def __init__(self, stream):
                self.stream = stream
            def write(self, chunk):
                return self.stream.write(chunk)
            def close(self):
                self.stream.close()
                raise OSError("close failed")
        def create(folder):
            stream, temporary = original_create(folder)
            owned.append(stream)
            return FailingClose(stream), temporary
        with mock.patch.object(civitai, "_create_download", side_effect=create):
            with self.assertRaisesRegex(OSError, "close failed"):
                await civitai.download({"model_id": 1, "version_id": 2, "file_id": 3}, "Illustrious")
        self.assertTrue(owned[0].closed)
        self.assertEqual(list((self.root / "llm").iterdir()), [])
        self.assertFalse(civitai._DOWNLOAD_LOCK.locked())

    async def test_stream_open_failure_closes_created_descriptor_and_removes_partial(self):
        original_mkstemp = civitai.tempfile.mkstemp
        descriptors = []
        def mkstemp(*args, **kwargs):
            result = original_mkstemp(*args, **kwargs)
            descriptors.append(result[0])
            return result
        with mock.patch.object(civitai.tempfile, "mkstemp", side_effect=mkstemp), \
                mock.patch.object(civitai.os, "fdopen", side_effect=OSError("open failed")):
            with self.assertRaisesRegex(OSError, "open failed"):
                await civitai.download({"model_id": 1, "version_id": 2, "file_id": 3}, "Illustrious")
        with self.assertRaises(OSError):
            civitai.os.fstat(descriptors[0])
        self.assertEqual(list((self.root / "llm").iterdir()), [])
        self.assertFalse(civitai._DOWNLOAD_LOCK.locked())

    async def test_network_failure_cleans_owned_stream_and_partial(self):
        with mock.patch.object(civitai, "api_get", return_value=self.model), \
                mock.patch.object(civitai.aiohttp.ClientSession, "get", side_effect=llm_fixture.aiohttp.ClientConnectionError()):
            with self.assertRaisesRegex(civitai.ServiceError, "download failed"):
                await civitai.download({"model_id": 1, "version_id": 2, "file_id": 3}, "Illustrious")
        self.assertEqual(list((self.root / "llm").iterdir()), [])
        self.assertFalse(civitai._DOWNLOAD_LOCK.locked())

    async def test_search_primary_only_and_cached_hash_invalidates(self):
        identity = {"model_id": 1, "version_id": 2, "file_id": 3}
        result = await civitai.download(identity, "Illustrious")
        self.version["files"].append({**self.version["files"][0], "id": 4, "primary": True})
        with mock.patch.object(civitai.hashlib, "sha256", wraps=hashlib.sha256) as hash_function:
            found = await civitai.search("cat", "Illustrious")
            self.assertEqual(len(found["items"]), 1)
            self.assertEqual(found["items"][0]["file_id"], 4)
            self.assertTrue(found["items"][0]["acquired"])
            first_count = hash_function.call_count
            await civitai.search("cat", "Illustrious")
            self.assertEqual(hash_function.call_count, first_count)
            (self.root / result["lora_name"]).write_bytes(b"modified")
            found = await civitai.search("cat", "Illustrious")
            self.assertFalse(found["items"][0]["acquired"])
            self.assertGreater(hash_function.call_count, first_count)

    async def test_refetched_download_url_rejects_untrusted_source(self):
        self.version["files"][0]["downloadUrl"] = "https://untrusted.example/file"
        with self.assertRaises(ValueError):
            await civitai.download({"model_id": 1, "version_id": 2, "file_id": 3}, "Illustrious")
        self.assertEqual(self.download_calls, 0)

    async def test_api_error_empty_and_invalid_parameters(self):
        self.api_status = 429
        with self.assertRaises(civitai.ServiceError) as error:
            await civitai.search("query", "Illustrious")
        self.assertIn("429", str(error.exception))
        self.assertNotIn("civitai-secret", str(error.exception))
        self.api_status = 200
        self.model["modelVersions"] = []
        self.assertEqual((await civitai.search("query", "Illustrious"))["items"], [])
        for mode, sort in (("bad", "Most Downloaded"), ("Illustrious", "bad")):
            with self.assertRaises(ValueError):
                await civitai.search("query", mode, sort)

    async def test_api_and_redirected_download_do_not_replay_cookie_or_cdn_authorization(self):
        async def storage(request):
            self.storage_headers.append((request.path, request.headers.get("Authorization"), request.headers.get("Cookie"), dict(request.query)))
            if request.path == "/storage":
                response = web.HTTPFound("/storage-final?signature=provider-signature")
                response.set_cookie("storage_session", "should-not-be-replayed")
                raise response
            return web.Response(body=self.content, headers=self.download_headers)
        app = web.Application()
        app.router.add_get("/storage", storage)
        app.router.add_get("/storage-final", storage)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        self.storage_origin = "http://localhost:" + str(site._server.sockets[0].getsockname()[1])
        self.redirect = True
        try:
            with mock.patch.object(civitai.aiohttp, "ClientSession", wraps=llm_fixture.aiohttp.ClientSession) as sessions:
                await civitai.by_hash(self.sha)
                await civitai.search("cat", "Illustrious")
                await civitai.download({"model_id": 1, "version_id": 2, "file_id": 3}, "Illustrious")
            self.assertEqual(self.storage_headers, [(path, None, None, {"signature": "provider-signature"})
                                                   for path in ("/storage", "/storage-final")])
            self.assertEqual(sessions.call_count, 5)
            for call in sessions.call_args_list:
                self.assertIsInstance(call.kwargs["cookie_jar"], llm_fixture.aiohttp.DummyCookieJar)
                self.assertNotIn("headers", call.kwargs)
                self.assertNotIn("auth", call.kwargs)
        finally:
            await runner.cleanup()


if __name__ == "__main__":
    unittest.main()
