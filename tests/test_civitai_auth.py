import asyncio
import hashlib
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from test_civitai import civitai, civitai_auth, llm_fixture, web


class CivitaiAuthTest(llm_fixture.HttpFixture):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.storage = mock.patch.object(civitai_auth, "storage_directory", side_effect=lambda user: self.root / user)
        self.storage.start()
        self.origin = llm_fixture.settings_module.endpoint(self.settings).removesuffix("/v1")
        self.origin_patch = mock.patch.object(civitai, "api_origin", return_value=self.origin)
        self.origin_patch.start()
        self.status = 200
        self.identity = {"id": 1, "username": "fixture-user"}
        self.headers = []
        self.delayed = None
        self.release = asyncio.Event()

    async def asyncTearDown(self):
        self.release.set()
        self.storage.stop()
        self.origin_patch.stop()
        self.directory.cleanup()
        await super().asyncTearDown()

    async def handle(self, request):
        if request.path == "/api/v1/me":
            self.headers.append(request.headers.get("Authorization"))
            self.assertNotIn("api_key", request.query)
            if self.delayed == request.headers.get("Authorization"):
                await self.release.wait()
            return web.json_response(self.identity, status=self.status)
        return await super().handle(request)

    async def test_user_separation_public_status_blank_revalidation_and_clear(self):
        public = await civitai_auth.authenticate("alice", "private-key")
        self.assertEqual(public, {"configured": True, "username": "fixture-user"})
        self.assertNotIn("private-key", str(public))
        self.assertEqual(civitai_auth.public_status("bob"), {"configured": False, "username": ""})
        self.assertEqual(civitai_auth.token_snapshot("alice"), "private-key")
        await civitai_auth.authenticate("alice", "")
        self.assertEqual(self.headers, ["Bearer private-key", "Bearer private-key"])
        self.assertEqual(civitai_auth.clear("alice"), {"configured": False, "username": ""})
        self.assertFalse((self.root / "alice" / "civitai_auth.json").exists())
        with self.assertRaises(ValueError):
            await civitai_auth.authenticate("alice", "")

    async def test_failed_validation_redirect_and_invalid_identity_preserve_saved_key(self):
        await civitai_auth.authenticate("alice", "old-key")
        for status, identity in [(401, self.identity), (302, self.identity), (200, {"id": True, "username": "bad"}),
                                 (200, {"id": 2, "username": " "}), (200, {"id": 0, "username": "bad"}), (200, [])]:
            self.status, self.identity = status, identity
            with self.subTest(status=status, identity=identity), self.assertRaises(civitai.ServiceError):
                await civitai_auth.authenticate("alice", "replacement")
            self.assertEqual(civitai_auth.token_snapshot("alice"), "old-key")
        self.assertEqual(civitai_auth._PENDING, {})
        self.assertEqual(list(self.root.rglob(".civitai-auth-*")), [])

    async def test_failed_atomic_replace_preserves_previous_key_and_removes_temporary_file(self):
        await civitai_auth.authenticate("alice", "old-key")
        with mock.patch.object(civitai_auth.os, "replace", side_effect=OSError("fixture write failure")):
            with self.assertRaises(OSError):
                await civitai_auth.authenticate("alice", "new-key")
        self.assertEqual(civitai_auth.token_snapshot("alice"), "old-key")
        self.assertEqual(list(self.root.rglob(".civitai-auth-*")), [])
        self.assertEqual(civitai_auth._PENDING, {})

    async def test_newer_verification_or_clear_prevents_old_verification_overwrite(self):
        self.delayed = "Bearer old-pending"
        old = asyncio.create_task(civitai_auth.authenticate("alice", "old-pending"))
        while not self.headers:
            await asyncio.sleep(0)
        await civitai_auth.authenticate("alice", "new-key")
        self.release.set()
        with self.assertRaises(civitai.ServiceError):
            await old
        self.assertEqual(civitai_auth.token_snapshot("alice"), "new-key")
        self.release.clear(); self.delayed = "Bearer pending-clear"
        old = asyncio.create_task(civitai_auth.authenticate("alice", "pending-clear"))
        while self.headers[-1] != "Bearer pending-clear":
            await asyncio.sleep(0)
        civitai_auth.clear("alice"); self.release.set()
        with self.assertRaises(civitai.ServiceError):
            await old
        self.assertFalse(civitai_auth.public_status("alice")["configured"])
        self.assertEqual(civitai_auth._PENDING, {})

    async def test_cancelled_begin_releases_pending_owner_and_newlines_never_enter_headers(self):
        for key in ("one\ntwo", "one\rtwo"):
            with self.assertRaisesRegex(ValueError, "改行"):
                await civitai_auth.authenticate("alice", key)
        self.assertEqual(self.headers, [])
        started = asyncio.Event()
        release = threading.Event()
        loop = asyncio.get_running_loop()
        original = civitai_auth._begin
        def paused(*args):
            result = original(*args)
            loop.call_soon_threadsafe(started.set)
            release.wait(3)
            return result
        with mock.patch.object(civitai_auth, "_begin", side_effect=paused):
            task = asyncio.create_task(civitai_auth.authenticate("alice", "key"))
            await started.wait(); task.cancel(); release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(civitai_auth._PENDING, {})
        self.assertFalse(civitai_auth.public_status("alice")["configured"])

    def test_download_headers_are_scoped_to_official_https_origins(self):
        for url in ("https://civitai.red/api/download/models/1", "https://civitai.com:443/api/download/models/1"):
            self.assertEqual(civitai._download_headers(url, "secret"), {"Authorization": "Bearer secret"})
        for url in ("https://cdn.example/file", "http://civitai.red/file", "https://civitai.red.evil/file", "https://civitai.red:444/file", "https://user@civitai.com/file"):
            self.assertEqual(civitai._download_headers(url, "secret"), {})

    async def test_real_download_rebuilds_headers_for_each_redirect(self):
        content = b"safe fixture model"
        model = {"id": 1, "type": "LORA", "name": "fixture", "modelVersions": [{"id": 2, "baseModel": "Illustrious",
            "files": [{"id": 3, "name": "fixture.safetensors", "type": "Model", "hashes": {"SHA256": hashlib.sha256(content).hexdigest()},
                       "downloadUrl": "https://civitai.red/api/download/models/2"}]}]}
        requests = []
        class Response:
            def __init__(self, location=None):
                self.status = 302 if location else 200
                self.headers = {"Location": location} if location else {}
                self.content = self
            def release(self):
                pass
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                pass
            async def iter_chunked(self, _size):
                yield content
        class Session:
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                pass
            async def get(self, url, **kwargs):
                requests.append((url, kwargs))
                locations = ["https://civitai.com/api/download/models/2", "https://cdn.example/model", "http://civitai.red/model", None]
                return Response(locations[len(requests) - 1])
        with mock.patch.object(civitai, "api_origin", return_value="https://civitai.red"), \
                mock.patch.object(civitai, "api_get", return_value=model), \
                mock.patch.object(civitai, "lora_root", return_value=self.root), \
                mock.patch.object(civitai_auth, "token_snapshot", return_value="private-token"), \
                mock.patch.object(civitai.aiohttp, "ClientSession", return_value=Session()):
            result = await civitai.download({"model_id": 1, "version_id": 2, "file_id": 3}, "Illustrious", user_id="alice")
        self.assertEqual((self.root / result["lora_name"]).read_bytes(), content)
        self.assertEqual([request[1]["headers"] for request in requests],
                         [{"Authorization": "Bearer private-token"}, {"Authorization": "Bearer private-token"}, {}, {}])
        self.assertTrue(all(request[1]["allow_redirects"] is False for request in requests))


if __name__ == "__main__":
    unittest.main()
