import importlib.util
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "tools" / "import_scene_html.py"


def load_importer():
    spec = importlib.util.spec_from_file_location("scene_html_importer_test", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ImportSceneHtmlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.module = load_importer()
        self.grouped = {
            "Main": {
                "Sub": [{"label": "One", "prompt": "one", "description": ""}],
                "Other": [{"label": "Two", "prompt": "two", "description": ""}],
            }
        }

    def tearDown(self):
        self.temp.cleanup()

    def test_output_argument_is_required(self):
        with mock.patch.object(sys, "argv", ["import_scene_html.py", "--input", "source"]):
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    self.module.parse_args()

    def test_default_collision_aborts_without_mutating_destination(self):
        destination = self.root / "data"
        target = destination / "Main" / "Sub" / "prompt.json"
        target.parent.mkdir(parents=True)
        target.write_text(json.dumps([{"label": "Existing", "prompt": "existing"}]), encoding="utf-8")
        original = target.read_text(encoding="utf-8")
        with self.assertRaises(FileExistsError):
            self.module.write_data(self.grouped, destination)
        self.assertEqual(target.read_text(encoding="utf-8"), original)
        self.assertFalse((destination / "Main" / "Other" / "prompt.json").exists())

    def test_merge_prepares_all_inputs_before_writing(self):
        destination = self.root / "data"
        first = destination / "Main" / "Sub" / "prompt.json"
        second = destination / "Main" / "Other" / "prompt.json"
        first.parent.mkdir(parents=True)
        second.parent.mkdir(parents=True)
        first.write_text(json.dumps([{"label": "Existing", "prompt": "existing"}]), encoding="utf-8")
        second.write_text("{broken", encoding="utf-8")
        original = first.read_text(encoding="utf-8")
        with self.assertRaises(json.JSONDecodeError):
            self.module.write_data(self.grouped, destination, "merge")
        self.assertEqual(first.read_text(encoding="utf-8"), original)

    def test_clean_and_replace_are_explicit_write_modes(self):
        destination = self.root / "data"
        stale = destination / "stale.txt"
        stale.parent.mkdir(parents=True)
        stale.write_text("stale", encoding="utf-8")
        self.module.write_data(self.grouped, destination, "clean")
        self.assertFalse(stale.exists())
        target = destination / "Main" / "Sub" / "prompt.json"
        target.write_text(json.dumps([{"label": "Old", "prompt": "old"}]), encoding="utf-8")
        self.module.write_data(self.grouped, destination, "replace")
        self.assertEqual(json.loads(target.read_text(encoding="utf-8"))[0]["label"], "One")

    def test_staging_failure_preserves_existing_clean_destination(self):
        destination = self.root / "data"
        original = destination / "existing" / "prompt.json"
        original.parent.mkdir(parents=True)
        original.write_text(json.dumps([{"label": "Keep", "prompt": "keep"}]), encoding="utf-8")
        real_write = self.module._atomic_write_json
        calls = 0

        def fail_second_write(path, data):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("simulated staging failure")
            return real_write(path, data)

        with mock.patch.object(self.module, "_atomic_write_json", side_effect=fail_second_write):
            with self.assertRaisesRegex(OSError, "staging failure"):
                self.module.write_data(self.grouped, destination, "clean")
        self.assertEqual(json.loads(original.read_text(encoding="utf-8"))[0]["label"], "Keep")

    def test_commit_failure_restores_existing_destination(self):
        destination = self.root / "data"
        original = destination / "existing" / "prompt.json"
        original.parent.mkdir(parents=True)
        original.write_text(json.dumps([{"label": "Keep", "prompt": "keep"}]), encoding="utf-8")
        replace = Path.replace

        def fail_stage_commit(path, target):
            if path.name.startswith(".data.stage-") and Path(target) == destination:
                raise OSError("simulated commit failure")
            return replace(path, target)

        with mock.patch.object(Path, "replace", new=fail_stage_commit):
            with self.assertRaisesRegex(OSError, "commit failure"):
                self.module.write_data(self.grouped, destination, "clean")
        self.assertEqual(json.loads(original.read_text(encoding="utf-8"))[0]["label"], "Keep")

    def test_backup_cleanup_failure_before_commit_preserves_destination(self):
        destination = self.root / "data"
        original = destination / "existing" / "prompt.json"
        original.parent.mkdir(parents=True)
        original.write_text(json.dumps([{"label": "Keep", "prompt": "keep"}]), encoding="utf-8")
        backup = destination.with_name(".data.backup-stale")
        backup.mkdir()
        (backup / "stale.txt").write_text("stale", encoding="utf-8")
        remove_tree = self.module.shutil.rmtree

        def fail_backup_cleanup(path, *args, **kwargs):
            if Path(path) == backup:
                raise OSError("simulated backup cleanup failure")
            return remove_tree(path, *args, **kwargs)

        with mock.patch.object(self.module, "stable_suffix", return_value="stale"), mock.patch.object(
            self.module.shutil, "rmtree", side_effect=fail_backup_cleanup,
        ):
            with self.assertRaisesRegex(OSError, "backup cleanup failure"):
                self.module.write_data(self.grouped, destination, "clean")
        self.assertEqual(json.loads(original.read_text(encoding="utf-8"))[0]["label"], "Keep")
        self.assertTrue(backup.exists())

    def test_dry_run_leaves_output_absent(self):
        source = self.root / "html"
        source.mkdir()
        (source / "prompt.html").write_text("<h2>Main</h2><figure><table><tr><th>Name</th><th>Prompt</th></tr><tr><td>One</td><td><code>one</code></td></tr></table></figure>", encoding="utf-8")
        destination = self.root / "data"
        with mock.patch.object(sys, "argv", ["import_scene_html.py", "--input", str(source), "--output", str(destination), "--dry-run"]):
            self.assertEqual(self.module.main(), 0)
        self.assertFalse(destination.exists())
