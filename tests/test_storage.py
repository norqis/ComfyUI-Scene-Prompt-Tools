import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
STORAGE_PATH = ROOT / "scene_prompt_tools" / "storage.py"


class PublicUserDirectoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.user_root = Path(self.temp.name) / "users"
        self.user_root.mkdir()
        self.folder_paths = types.ModuleType("folder_paths")
        self.folder_paths.get_user_directory = lambda: str(self.user_root)
        self.folder_paths.get_public_user_directory = lambda user_id: str(self.user_root / user_id)
        self.modules = mock.patch.dict(sys.modules, {"folder_paths": self.folder_paths})
        self.modules.start()
        spec = importlib.util.spec_from_file_location("scene_storage_test", STORAGE_PATH)
        self.storage = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.storage)

    def tearDown(self):
        self.modules.stop()
        self.temp.cleanup()

    def test_accepts_current_public_user_id_shape(self):
        self.assertEqual(self.storage.public_user_directory("Alice_01-user"), self.user_root / "Alice_01-user")

    def test_rejects_empty_traversal_absolute_and_system_user_ids(self):
        for user_id in ("", "../outside", "/outside", "C:" + chr(92) + "outside", "__system"):
            with self.subTest(user_id=user_id):
                with self.assertRaises(ValueError):
                    self.storage.public_user_directory(user_id)

    def test_rejects_public_path_outside_user_root(self):
        self.folder_paths.get_public_user_directory = lambda user_id: str(self.user_root.parent / "outside")
        with self.assertRaises(ValueError):
            self.storage.public_user_directory("alice")


if __name__ == "__main__":
    unittest.main()
