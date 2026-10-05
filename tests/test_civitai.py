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


class CivitaiHttpTest(llm_fixture.HttpFixture):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        folder_paths.get_folder_paths = lambda kind: [str(self.root)]
        folder_paths.filename_list_cache = {"loras": "old"}
        self.content = b"safetensors-test-content"
        self.sha = hashlib.sha256(self.content).hexdigest()
        self.origin = llm_fixture.settings_module.endpoint(self.settings).removesuffix("/v1").replace("127.0.0.1", "localhost")
        self.origin_patch = mock.patch.object(civitai, "api_origin", return_value=self.origin)
        self.origin_patch.start()
        civitai._DOWNLOAD_LOCK = None
        self.version = {"id": 2, "name": "version", "baseModel": "Illustrious", "trainedWords": ["cat"],
            "images": [{"url": "version-image", "nsfwLevel": 1}], "files": [{"id": 3, "name": "../../unsafe.safetensors", "type": "Model", "hashes": {"SHA256": self.sha}, "downloadUrl": self.origin + "/api/download/models/2"}]}
        self.model = {"id": 1, "name": "cat", "type": "LORA", "modelVersions": [self.version]}
        self.redirect = False
        self.model_requests = []
        self.base_model_parameters = []
        self.download_calls = 0
        self.storage_headers = []
        self.api_status = 200
        self.hash_status = 200
        self.hash_raw = False
        self.hash_requests = []
        self.hash_result = {"id": 2, "modelId": 1, "name": "version", "model": {"name": "cat", "description": "private provider body"},
                            "trainedWords": ["cat"], "files": [{"downloadUrl": "secret URL"}]}

    async def asyncTearDown(self):
        self.origin_patch.stop()
        self.temporary.cleanup()
        await super().asyncTearDown()

    async def handle(self, request):
        self.assertIsNone(request.headers.get("Authorization"))
        self.assertIsNone(request.headers.get("Cookie"))
        self.assertNotIn("token", request.query)
        if request.path.startswith("/api/v1/model-versions/by-hash/"):
            self.hash_requests.append((request.path, request.headers.get("Authorization")))
            if self.hash_raw:
                return web.Response(text="private provider body", content_type="application/json", status=self.hash_status)
            response = web.json_response(self.hash_result, status=self.hash_status)
            response.set_cookie("provider_session", "should-not-be-replayed")
            return response
        if request.path.startswith("/api/v1/models"):
            self.model_requests.append((dict(request.query), request.headers.get("Authorization")))
            self.base_model_parameters.append(request.query.getall("baseModels", []))
            return web.json_response({"items": [self.model]} if request.path == "/api/v1/models" else self.model, status=self.api_status)
        if request.path.startswith("/api/download"):
            self.download_calls += 1
            if self.redirect:
                # Distinct authority even though both servers are localhost.
                response = web.HTTPFound(self.storage_origin + "/storage?signature=provider-signature")
                response.set_cookie("provider_session", "should-not-be-replayed")
                raise response
            return web.Response(body=self.content)
        return await super().handle(request)

    async def test_by_hash_returns_only_metadata_without_any_local_model_access(self):
        with mock.patch.object(civitai, "lora_root", side_effect=AssertionError("local model access")), \
                mock.patch.object(civitai, "_sha256", side_effect=AssertionError("local hash")):
            result = await civitai.by_hash(self.sha.upper())
        self.assertEqual(result, {"found": True, "version": {"id": 2, "modelId": 1, "name": "version",
                                "model": {"name": "cat"}, "trainedWords": ["cat"]}})
        self.assertEqual(self.hash_requests, [("/api/v1/model-versions/by-hash/" + self.sha, None)])
        self.assertNotIn("private", str(result))
        self.assertNotIn("secret", str(result))

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

    async def test_search_sorts_version_file_image_alignment(self):
        self.model["modelVersions"].insert(0, {"id": 99, "baseModel": "Anima", "images": [{"url": "wrong-image"}], "files": []})
        for sort in civitai.SORTS:
            result = await civitai.search("cat", "Illustrious", sort)
            self.assertEqual(result["items"][0]["version_id"], 2)
            self.assertEqual(result["items"][0]["file_id"], 3)
            self.assertEqual(result["items"][0]["image_url"], "version-image")
            self.assertTrue(result["items"][0]["model_url"].startswith("https://civitai.red/models/"))
            params, authorization = self.model_requests[-1]
            self.assertEqual(params["limit"], "30")
            self.assertEqual(params["period"], "AllTime")
            self.assertEqual(params["sort"], sort)
            self.assertEqual(authorization, None)
            self.assertEqual(self.base_model_parameters[-1], ["Illustrious", "NoobAI"])
        self.assertEqual(civitai.normalize(self.model, "Anima"), [])

    async def test_fixed_red_origin_and_no_time_budget(self):
        self.origin_patch.stop()
        self.assertEqual(civitai.api_origin(), "https://civitai.red")
        self.origin_patch.start()
        with mock.patch.object(llm_fixture.aiohttp, "ClientTimeout", wraps=llm_fixture.aiohttp.ClientTimeout) as timeout:
            await civitai.search("cat", "Illustrious")
            await civitai.download({"model_id": 1, "version_id": 2, "file_id": 3}, "Illustrious")
            self.assertEqual(timeout.call_args_list, [mock.call(total=None)] * 3)

    async def test_noobai_family_search_and_anima_parameters(self):
        self.version["baseModel"] = "NoobAI"
        result = await civitai.search("cat", "Illustrious")
        self.assertEqual(result["items"][0]["base_model"], "NoobAI")
        self.version["baseModel"] = "Anima"
        result = await civitai.search("cat", "Anima")
        self.assertEqual(result["items"][0]["base_model"], "Anima")
        self.assertEqual(self.base_model_parameters[-1], ["Anima"])

    async def test_download_safe_path_atomic_hash_dedup_and_incompatible(self):
        identity = {"model_id": 1, "version_id": 2, "file_id": 3}
        result = await civitai.download(identity, "Illustrious")
        self.assertEqual(result["lora_name"], "llm/civitai-1-2-3.safetensors")
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

    async def test_api_and_redirected_download_are_anonymous_without_cookie_replay(self):
        async def storage(request):
            self.storage_headers.append((request.path, request.headers.get("Authorization"), request.headers.get("Cookie"), dict(request.query)))
            if request.path == "/storage":
                response = web.HTTPFound("/storage-final?signature=provider-signature")
                response.set_cookie("storage_session", "should-not-be-replayed")
                raise response
            return web.Response(body=self.content)
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
            self.assertEqual(sessions.call_count, 4)
            for call in sessions.call_args_list:
                self.assertIsInstance(call.kwargs["cookie_jar"], llm_fixture.aiohttp.DummyCookieJar)
                self.assertNotIn("headers", call.kwargs)
                self.assertNotIn("auth", call.kwargs)
        finally:
            await runner.cleanup()


if __name__ == "__main__":
    unittest.main()
