"""Local deletion fixtures; every file lives in a disposable temporary folder."""
import concurrent.futures
from contextlib import contextmanager
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

from test_civitai import civitai, folder_paths, lora_metadata


class DeleteLoraTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.roots = [self.root / "first", self.root / "second"]
        for root in self.roots:
            root.mkdir()
        self.extra = {}
        self.native_cache = {"other": "preserved"}
        for patch in (
            mock.patch.object(folder_paths, "get_folder_paths", side_effect=lambda kind: self.roots, create=True),
            mock.patch.object(folder_paths, "get_filename_list", side_effect=self.names, create=True),
            mock.patch.object(folder_paths, "get_full_path", side_effect=self.resolve, create=True),
            mock.patch.object(folder_paths, "filename_list_cache", self.native_cache, create=True),
        ):
            patch.start()
            self.addCleanup(patch.stop)
        lora_metadata._CACHE.clear()
        civitai._HASH_CACHE.clear()

    def names(self, kind):
        if kind in self.native_cache:
            return self.native_cache[kind]
        return list(dict.fromkeys([path.relative_to(root).as_posix()
            for root in self.roots for path in root.rglob("*.safetensors")] + list(self.extra)))

    def resolve(self, kind, name):
        if name in self.extra:
            return self.extra[name]
        name = lora_metadata.canonical_lora_name(name)
        return next((str(root / name) for root in self.roots if (root / name).is_file()), None)

    def write(self, name="selected.safetensors", content=b"fixture weights", root=0):
        path = self.roots[root] / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def row(self, name="selected.safetensors"):
        return next(item for item in lora_metadata.list_loras() if item["path"] == name)

    def test_delete_exact_file_refreshes_catalog_and_prunes_caches(self):
        target = self.write()
        sibling = self.write("sibling.safetensors")
        sidecar = target.with_suffix(".json")
        sidecar.write_text("sidecar")
        row = self.row()
        key = lora_metadata.file_identity(target)
        signature = lora_metadata.file_signature(target)
        lora_metadata._CACHE[key] = (signature, {"sha256": "a" * 64})
        civitai._HASH_CACHE[key] = (signature, "a" * 64)
        self.native_cache["loras"] = self.names("loras")
        with mock.patch("builtins.open", side_effect=AssertionError("delete read weights")), \
                mock.patch.object(Path, "open", side_effect=AssertionError("delete read weights")):
            result = lora_metadata.delete_lora(row["path"], row["file_revision"])
        self.assertEqual(result["deleted"], target.name)
        self.assertEqual([item["path"] for item in result["items"]], [sibling.name])
        self.assertFalse(target.exists())
        self.assertTrue(sibling.exists())
        self.assertEqual(sidecar.read_text(), "sidecar")
        self.assertNotIn(key, lora_metadata._CACHE)
        self.assertNotIn(key, civitai._HASH_CACHE)
        self.assertEqual(self.native_cache, {"other": "preserved"})

    def test_revision_uses_existing_stat_and_keeps_integer_precision(self):
        target = self.write()
        original = lora_metadata.os.stat
        with mock.patch.object(folder_paths, "get_filename_list", return_value=[target.name]), \
                mock.patch.object(folder_paths, "get_full_path", return_value=str(target)), \
                mock.patch.object(lora_metadata.os, "stat", wraps=original) as stat_file:
            row = self.row()
        self.assertEqual(row["file_revision"], ":".join(map(str, lora_metadata.file_signature(target))))
        self.assertIsInstance(row["file_revision"], str)
        # One native selection plus one entry per configured root, as before.
        self.assertEqual(stat_file.call_count, 3)

    def test_slash_alias_returns_native_name(self):
        target = self.write("nested/selected.safetensors")
        native_name = "nested\\selected.safetensors"
        self.native_cache["loras"] = [native_name]
        row = self.row(native_name)
        result = lora_metadata.delete_lora("nested/selected.safetensors", row["file_revision"])
        self.assertEqual(result["deleted"], native_name)
        self.assertEqual(result["items"], [])
        self.assertFalse(target.exists())

    def test_invalid_arguments_do_not_resolve_or_delete(self):
        target = self.write()
        for name, revision in ((None, "x"), ("", "x"), ([], "x"), (target.name, None),
                (target.name, ""), ("../selected.safetensors", "x"),
                ("nested/../selected.safetensors", "x"), (str(target), "x"),
                ("C:\\selected.safetensors", "x"), ("C:selected.safetensors", "x"),
                ("\\selected.safetensors", "x"), ("/selected.safetensors", "x")):
            with self.subTest(name=name, revision=revision), \
                    mock.patch.object(folder_paths, "get_full_path", side_effect=AssertionError("invalid resolution")):
                with self.assertRaises(ValueError):
                    lora_metadata.delete_lora(name, revision)
        self.assertTrue(target.exists())

    def test_unknown_and_missing_file_report_not_found(self):
        with self.assertRaises(FileNotFoundError):
            lora_metadata.delete_lora("unknown.safetensors", "x")
        target = self.write()
        row = self.row()
        self.native_cache["loras"] = [target.name]
        target.unlink()
        with self.assertRaises(FileNotFoundError):
            lora_metadata.delete_lora(target.name, row["file_revision"])

    def test_directory_and_external_resolver_are_rejected(self):
        directory = self.roots[0] / "directory.safetensors"
        directory.mkdir()
        external = self.root / "external.safetensors"
        external.write_bytes(b"external")
        for path in (directory, external):
            self.extra[path.name] = str(path)
            with self.subTest(path=path), self.assertRaises(ValueError):
                lora_metadata.delete_lora(path.name, "x")
            self.assertTrue(path.exists())

    def test_leaf_symlinks_and_escaping_parent_symlinks_are_rejected(self):
        external = self.root / "outside"
        external.mkdir()
        outside_file = external / "outside.safetensors"
        outside_file.write_bytes(b"external")
        internal = self.write()
        try:
            (self.roots[0] / "leaf.safetensors").symlink_to(internal)
            (self.roots[0] / "linked").symlink_to(external, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"Symlink creation unavailable: {error}")
        for name, path in (("leaf.safetensors", internal), ("linked/outside.safetensors", outside_file)):
            self.extra[name] = str(self.roots[0] / name)
            with self.subTest(name=name), self.assertRaises(ValueError):
                lora_metadata.delete_lora(name, self.row(name)["file_revision"])
            self.assertTrue(path.exists())

    def test_linked_leaf_rejection_does_not_require_symlink_creation_privilege(self):
        target = self.write()
        row = self.row()
        with mock.patch.object(Path, "is_symlink", return_value=True), \
                mock.patch.object(Path, "unlink", side_effect=AssertionError("linked leaf unlinked")):
            with self.assertRaisesRegex(ValueError, "linked LoRA"):
                lora_metadata.delete_lora(target.name, row["file_revision"])
        self.assertTrue(target.exists())

    def test_size_and_mtime_changes_reject_old_revision(self):
        for change in ("size", "mtime"):
            target = self.write()
            row = self.row()
            if change == "size":
                target.write_bytes(b"changed size")
            else:
                info = target.stat()
                os.utime(target, ns=(info.st_atime_ns, info.st_mtime_ns + 10_000_000))
            with self.subTest(change=change), self.assertRaises(lora_metadata.StaleLoRAFileError):
                lora_metadata.delete_lora(target.name, row["file_revision"])
            self.assertTrue(target.exists())

    def test_ctime_device_and_inode_are_part_of_revision(self):
        target = self.write()
        row = self.row()
        for index in (2, 3, 4):
            revision = row["file_revision"].split(":")
            revision[index] = str(int(revision[index]) + 1)
            with self.subTest(index=index), self.assertRaises(lora_metadata.StaleLoRAFileError):
                lora_metadata.delete_lora(target.name, ":".join(revision))
        self.assertTrue(target.exists())

    def test_atomic_replacement_with_same_size_and_mtime_is_not_deleted(self):
        target = self.write(content=b"original")
        row = self.row()
        info = target.stat()
        replacement = self.write("replacement.safetensors", b"replaced")
        os.utime(replacement, ns=(info.st_atime_ns, info.st_mtime_ns))
        replacement.replace(target)
        with self.assertRaises(lora_metadata.StaleLoRAFileError):
            lora_metadata.delete_lora(target.name, row["file_revision"])
        self.assertEqual(target.read_bytes(), b"replaced")

    def test_resolver_change_while_waiting_for_lock_is_rejected(self):
        target = self.write()
        shadow = self.write(root=1)
        row = self.row()
        calls = 0
        def changed_resolver(kind, name):
            nonlocal calls
            calls += 1
            return str(target if calls == 1 else shadow)
        with mock.patch.object(folder_paths, "get_full_path", side_effect=changed_resolver):
            with self.assertRaises(lora_metadata.StaleLoRAFileError):
                lora_metadata.delete_lora(target.name, row["file_revision"])
        self.assertTrue(target.exists())
        self.assertTrue(shadow.exists())

    def test_deleted_first_root_reveals_shadow_with_new_token_and_digest(self):
        target = self.write(content=b"original")
        shadow = self.write(content=b"shadowed", root=1)
        row = self.row()
        target_key, shadow_key = map(lora_metadata.file_identity, (target, shadow))
        for path, key in ((target, target_key), (shadow, shadow_key)):
            civitai._HASH_CACHE[key] = (lora_metadata.file_signature(path), "a" * 64)
        self.native_cache["loras"] = [target.name]
        result = lora_metadata.delete_lora(target.name, row["file_revision"])
        self.assertEqual(result["items"][0]["path"], target.name)
        self.assertNotEqual(result["items"][0]["file_revision"], row["file_revision"])
        self.assertEqual(result["items"][0]["file_revision"], ":".join(map(str, lora_metadata.file_signature(shadow))))
        self.assertNotIn(target_key, civitai._HASH_CACHE)
        self.assertIn(shadow_key, civitai._HASH_CACHE)
        self.assertEqual(shadow.read_bytes(), b"shadowed")

    def test_shared_file_lock_waits_and_revalidates_replacement(self):
        target = self.write(content=b"original")
        row = self.row()
        key = lora_metadata.file_identity(target)
        attempted = threading.Event()
        original_lock = lora_metadata.file_operation
        @contextmanager
        def waiting_lock(identity):
            self.assertEqual(identity, key)
            attempted.set()
            with original_lock(identity):
                yield
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            with original_lock(key), mock.patch.object(lora_metadata, "file_operation", waiting_lock):
                pending = executor.submit(lora_metadata.delete_lora, target.name, row["file_revision"])
                self.assertTrue(attempted.wait(5))
                self.assertFalse(pending.done())
                replacement = self.write("replacement.safetensors", b"replaced")
                replacement.replace(target)
            with self.assertRaises(lora_metadata.StaleLoRAFileError):
                pending.result(timeout=5)
        self.assertEqual(target.read_bytes(), b"replaced")

    def test_permission_error_leaves_file_and_native_cache_intact(self):
        target = self.write()
        row = self.row()
        self.native_cache["loras"] = [target.name]
        with mock.patch.object(Path, "unlink", side_effect=PermissionError("fixture unlink denied")):
            with self.assertRaises(PermissionError):
                lora_metadata.delete_lora(target.name, row["file_revision"])
        self.assertTrue(target.exists())
        self.assertEqual(self.native_cache["loras"], [target.name])


if __name__ == "__main__":
    unittest.main()
