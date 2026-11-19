"""Small local fixtures for exact Civitai ownership; never scan installed models."""
import asyncio
import hashlib
import struct
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from test_civitai import civitai, folder_paths, lora_metadata


class OwnedLoraTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.roots = [self.root / "first", self.root / "second"]
        for root in self.roots:
            root.mkdir()
        self.extra = {}
        self.patches = [
            mock.patch.object(folder_paths, "get_folder_paths", side_effect=lambda kind: self.roots, create=True),
            mock.patch.object(folder_paths, "get_filename_list", side_effect=lambda kind: list(dict.fromkeys(
                [path.relative_to(root).as_posix() for root in self.roots for path in root.rglob("*.safetensors")] + list(self.extra))), create=True),
            mock.patch.object(folder_paths, "get_full_path", side_effect=lambda kind, name: self.extra.get(name) or next(
                (str(root / name) for root in self.roots if (root / name).is_file()), None), create=True),
            mock.patch.object(civitai, "_token", side_effect=AssertionError("ownership used authentication")),
            mock.patch.object(civitai, "api_get", side_effect=AssertionError("ownership used provider API")),
        ]
        for patch in self.patches:
            patch.start()
        civitai._OWNERSHIP_LOCK = None
        civitai._HASH_CACHE.clear()
        lora_metadata._CACHE.clear()

    async def asyncTearDown(self):
        for patch in reversed(self.patches):
            patch.stop()
        self.temporary.cleanup()

    def write(self, name, content=b"fixture weights", root=0):
        path = self.roots[root] / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def candidate(self, content=b"fixture weights", **kwargs):
        return {"sha256": hashlib.sha256(content).hexdigest(), "size_kb": len(content) / 1024, **kwargs}

    async def test_renamed_nested_duplicate_hash_and_wrong_same_filename(self):
        self.write("Original.safetensors", b"wrong contents")
        self.write("nested/改名.safetensors")
        self.write("duplicate.safetensors", root=1)
        expected = self.candidate()
        result = await civitai.owned([expected, expected, self.candidate(b"unavailable")])
        self.assertEqual(result, {"items": [{"sha256": expected["sha256"], "owned": True, "lora_name": "nested/改名.safetensors"}]})

    async def test_hidden_root_file_is_owned_without_wrong_selectable_name(self):
        self.write("nested/same.safetensors", b"selected wrong contents")
        hidden = self.write("nested/same.safetensors", root=1)
        result = await civitai.owned([self.candidate()])
        self.assertEqual(result["items"], [{"sha256": self.candidate()["sha256"], "owned": True, "lora_name": ""}])
        with mock.patch.object(Path, "open", side_effect=AssertionError("picker evicted hidden digest")):
            self.assertEqual(lora_metadata.list_loras()[0]["size"], len(b"selected wrong contents"))
            self.assertEqual(await civitai.owned([self.candidate(size_kb=999999)]), result)
        self.assertIn(lora_metadata.file_identity(hidden), civitai._HASH_CACHE)

    async def test_selected_duplicate_preferred_and_external_native_resolver_retained(self):
        self.write("hidden.safetensors", root=1)
        selected = self.write("selected.safetensors")
        self.assertEqual((await civitai.owned([self.candidate()]))["items"][0]["lora_name"], "selected.safetensors")
        selected.unlink()
        external = self.root / "external.safetensors"
        external.write_bytes(b"outside configured roots")
        self.extra["custom/name.safetensors"] = str(external)
        result = await civitai.owned([self.candidate(external.read_bytes())])
        self.assertEqual(result["items"][0]["lora_name"], "custom/name.safetensors")

    async def test_metadata_and_acquisition_hashes_are_reused_even_with_approximate_sizes(self):
        header = b'{"__metadata__": {"modelspec.trigger_phrase": "local"}}'
        contents = struct.pack("<Q", len(header)) + header + b"weights"
        self.write("metadata.safetensors", contents)
        info = await asyncio.to_thread(lora_metadata.read_lora_info, "metadata.safetensors")
        acquired = self.write("acquired.safetensors", b"downloaded fixture")
        await asyncio.to_thread(civitai._sha256, acquired)
        with mock.patch("builtins.open", side_effect=AssertionError("metadata digest was reread")), \
                mock.patch.object(Path, "open", side_effect=AssertionError("acquisition digest was reread")):
            result = await civitai.owned([{"sha256": info["sha256"], "size_kb": 9000}, self.candidate(b"downloaded fixture", size_kb=9000)])
        self.assertEqual(len(result["items"]), 2)

    async def test_size_filter_unknown_size_and_rounding_tolerance(self):
        self.write("unrelated.safetensors", b"x" * 9000)
        wanted = self.write("wanted.safetensors", b"w" * 4096)
        original_hash = civitai._sha256
        with mock.patch.object(civitai, "_sha256", wraps=original_hash) as hash_file:
            self.assertTrue((await civitai.owned([self.candidate(wanted.read_bytes(), size_kb=4.999)]))["items"])
            self.assertEqual(hash_file.call_args_list, [mock.call(wanted)])
        civitai._HASH_CACHE.clear()
        for size in (None, 0):
            self.assertTrue((await civitai.owned([self.candidate(wanted.read_bytes(), size_kb=size)]))["items"])
        unknown = {"sha256": self.candidate(wanted.read_bytes())["sha256"]}
        self.assertTrue((await civitai.owned([unknown]))["items"])

    async def test_replacement_and_deletion_invalidate_both_caches(self):
        path = self.write("renamed.safetensors")
        expected = self.candidate()
        self.assertTrue((await civitai.owned([expected]))["items"])
        replacement = self.write("replacement.safetensors", b"other contents!")
        replacement.replace(path)
        self.assertEqual((await civitai.owned([expected]))["items"], [])
        self.assertEqual((await civitai.owned([self.candidate(b"other contents!")]))["items"][0]["lora_name"], path.name)
        path.unlink()
        self.assertEqual((await civitai.owned([expected]))["items"], [])
        self.assertEqual(civitai._HASH_CACHE, {})
        self.assertEqual(lora_metadata._CACHE, {})

    async def test_concurrent_lookups_coalesce_reads_and_keep_event_loop_free(self):
        self.write("owned.safetensors")
        entered, release = threading.Event(), threading.Event()
        original = hashlib.sha256
        def hashing(*args):
            entered.set()
            self.assertTrue(release.wait(5))
            return original(*args)
        expected = self.candidate()
        with mock.patch.object(civitai.hashlib, "sha256", side_effect=hashing) as hash_function:
            first = asyncio.create_task(civitai.owned([expected]))
            self.assertTrue(await asyncio.to_thread(entered.wait, 5))
            second = asyncio.create_task(civitai.owned([expected]))
            direct = asyncio.create_task(asyncio.to_thread(civitai._sha256, self.roots[0] / "owned.safetensors"))
            await asyncio.sleep(0)
            self.assertFalse(second.done())
            release.set()
            one, two, digest = await asyncio.gather(first, second, direct)
            self.assertEqual(one, two)
            self.assertEqual(digest, expected["sha256"])
            self.assertEqual(hash_function.call_count, 1)

    async def test_disconnect_stops_next_file_and_queued_inventory(self):
        self.write("first.safetensors", b"one")
        self.write("second.safetensors", b"two")
        live = True
        def hash_file(path):
            nonlocal live
            live = False
            return "f" * 64
        with mock.patch.object(civitai, "_sha256", side_effect=hash_file) as hash_function:
            await civitai.owned([self.candidate()], is_current=lambda: live)
            self.assertEqual(hash_function.call_count, 1)
        with mock.patch.object(civitai, "lora_inventory", side_effect=AssertionError("disconnected catalog scan")):
            self.assertEqual(await civitai.owned([self.candidate()], is_current=lambda: False), {"items": []})
            lock = civitai._OWNERSHIP_LOCK
            async with lock:
                live = True
                pending = asyncio.create_task(civitai.owned([self.candidate()], is_current=lambda: live))
                await asyncio.sleep(0)
                live = False
            self.assertEqual(await pending, {"items": []})

    async def test_cancelled_handler_settles_file_before_next_lookup(self):
        self.write("owned.safetensors")
        entered, release = threading.Event(), threading.Event()
        expected = self.candidate()
        original = civitai._sha256
        def hash_file(path):
            entered.set()
            self.assertTrue(release.wait(5))
            return original(path)
        with mock.patch.object(civitai, "_sha256", side_effect=hash_file), \
                mock.patch.object(civitai, "lora_inventory", wraps=lora_metadata.lora_inventory) as inventory:
            first = asyncio.create_task(civitai.owned([expected]))
            self.assertTrue(await asyncio.to_thread(entered.wait, 5))
            first.cancel()
            second = asyncio.create_task(civitai.owned([expected]))
            await asyncio.sleep(0)
            self.assertTrue(civitai._OWNERSHIP_LOCK.locked())
            self.assertFalse(first.done())
            self.assertEqual(inventory.call_count, 1)
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await first
            self.assertTrue((await second)["items"])

    async def test_vanished_file_is_skipped_but_io_failure_is_reported(self):
        self.write("owned.safetensors")
        with mock.patch.object(civitai, "_sha256", side_effect=FileNotFoundError):
            self.assertEqual(await civitai.owned([self.candidate()]), {"items": []})
        with mock.patch.object(civitai, "_sha256", side_effect=PermissionError("fixture read denied")):
            with self.assertRaises(PermissionError):
                await civitai.owned([self.candidate()])

    async def test_picker_keeps_partial_row_when_one_stat_is_unavailable(self):
        good = self.write("good.safetensors")
        denied = self.write("denied.safetensors")
        original_stat = lora_metadata.os.stat
        def stat(path, *args, **kwargs):
            if Path(path) == denied:
                raise PermissionError("fixture stat denied")
            return original_stat(path, *args, **kwargs)
        with mock.patch.object(folder_paths, "get_filename_list", return_value=[good.name, denied.name]), \
                mock.patch.object(folder_paths, "get_full_path", side_effect=lambda kind, name: str(self.roots[0] / name)), \
                mock.patch.object(lora_metadata.os, "stat", side_effect=stat):
            rows = lora_metadata.list_loras()
        self.assertEqual(rows[0]["size"], good.stat().st_size)
        self.assertEqual(rows[1], {"path": denied.name, "size": None, "mtime_ns": None})

    async def test_invalid_payload_rejected_without_inventory(self):
        for items in (None, {}, [None], [{"sha256": "wrong"}], [self.candidate(size_kb=True)], [self.candidate(size_kb=-1)], [self.candidate(size_kb=float("nan"))]):
            with self.subTest(items=items), mock.patch.object(civitai, "lora_inventory", side_effect=AssertionError("invalid inventory")):
                with self.assertRaises(ValueError):
                    await civitai.owned(items)


if __name__ == "__main__":
    unittest.main()
