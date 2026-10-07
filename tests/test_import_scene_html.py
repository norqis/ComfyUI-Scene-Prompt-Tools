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

    def test_windows_reserved_names_are_writable_for_categories_and_subcategories(self):
        destination = self.root / "reserved"
        names = ("CON", "AUX.preview", "LPT9 .txt", "COM¹.view", "ordinary")
        grouped = {name: {name: [{"label": "neutral", "prompt": "neutral"}]} for name in names}
        self.assertEqual(self.module.write_data(grouped, destination), (5, 5, 5))
        for name in names:
            safe = name if name == "ordinary" else "_" + name
            path = destination / safe / safe / "prompt.json"
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))[0]["prompt"], "neutral")

    def test_output_argument_is_required(self):
        with mock.patch.object(sys, "argv", ["import_scene_html.py", "--input", "source"]):
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    self.module.parse_args()

    def test_case_collisions_preserve_all_html_entries_on_disk(self):
        source = self.root / "html"
        source.mkdir()
        sections = []
        for main, sub, prompt in (("Room", "View", "first"), ("Room", "view", "second"), ("room", "View", "third")):
            sections.append(
                f"<h2>{main}</h2><h3>{sub}</h3><figure><table>"
                f"<tr><td>{prompt}</td><td><code>{prompt}</code></td></tr>"
                "</table></figure>"
            )
        (source / "prompt.html").write_text("".join(sections), encoding="utf-8")
        grouped = self.module.load_html_items(source)
        destination = self.root / "data"
        payloads = self.module._output_payloads(grouped, destination)
        paths = [str(path.relative_to(destination)).casefold() for path, _ in payloads]
        self.assertEqual(len(set(paths)), 3)
        self.assertEqual(self.module.write_data(grouped, destination), (2, 3, 3))
        files = list(destination.rglob("prompt.json"))
        self.assertEqual(len(files), 3)
        self.assertEqual(
            {item["prompt"] for path in files for item in json.loads(path.read_text(encoding="utf-8"))},
            {"first", "second", "third"},
        )
        expected = {
            "first": "Room/View/prompt.json",
            "second": f"Room/view_{self.module.stable_suffix('view')}/prompt.json",
            "third": f"room_{self.module.stable_suffix('room')}/View/prompt.json",
        }
        self.assertEqual({items[0]["prompt"]: path.relative_to(destination).as_posix() for path, items in payloads}, expected)

    def test_sanitized_collisions_keep_existing_suffix_convention(self):
        grouped = {
            main: {sub: [{"label": f"{main}:{sub}", "prompt": f"{main}:{sub}"}] for sub in ("A/B", "A:B")}
            for main in ("A/B", "A:B")
        }
        destination = self.root / "data"
        payloads = self.module._output_payloads(grouped, destination)
        suffixed = f"A_B_{self.module.stable_suffix('A:B')}"
        self.assertEqual(
            {path.relative_to(destination).as_posix() for path, _ in payloads},
            {f"{main}/{sub}/prompt.json" for main in ("A_B", suffixed) for sub in ("A_B", suffixed)},
        )
        self.assertEqual(self.module.write_data(grouped, destination), (2, 4, 4))
        self.assertEqual(len(list(destination.rglob("prompt.json"))), 4)

    def test_literal_suffixed_names_and_hash_collisions_are_unique(self):
        cases = (
            (("ROOM", "ROOM_same", "ROOM_same_2", "room"), {"ROOM": "ROOM", "ROOM_same": "ROOM_same", "ROOM_same_2": "ROOM_same_2", "room": "room_same_3"}),
            (("A/B", "A:B", "A?B", "A_B_same"), {"A/B": "A_B", "A:B": "A_B_same", "A?B": "A_B_same_2", "A_B_same": "A_B_same_same"}),
        )
        destination = self.root / "data"
        for names, expected_names in cases:
            for level in ("main", "sub"):
                with self.subTest(names=names, level=level):
                    if level == "main":
                        grouped = {name: {"Sub": [{"label": name, "prompt": name}]} for name in names}
                    else:
                        grouped = {"Main": {name: [{"label": name, "prompt": name}] for name in names}}
                    with mock.patch.object(self.module, "stable_suffix", return_value="same"):
                        payloads = self.module._output_payloads(grouped, destination)
                    self.assertEqual(
                        {items[0]["label"]: path.relative_to(destination).parts[0 if level == "main" else 1] for path, items in payloads},
                        expected_names,
                    )
                    self.assertEqual(len({str(path).casefold() for path, _ in payloads}), len(names))

    def test_literal_name_matching_real_generated_suffix_keeps_all_entries(self):
        literal = f"ROOM_{self.module.stable_suffix('room')}"
        names = ("ROOM", literal, "room")
        grouped = {
            main: {sub: [{"label": f"{main}:{sub}", "prompt": f"{main}:{sub}"}] for sub in names}
            for main in names
        }
        destination = self.root / "data"
        self.assertEqual(self.module.write_data(grouped, destination), (3, 9, 9))
        files = list(destination.rglob("prompt.json"))
        self.assertEqual(len(files), 9)
        self.assertEqual(
            {item["prompt"] for path in files for item in json.loads(path.read_text(encoding="utf-8"))},
            {f"{main}:{sub}" for main in names for sub in names},
        )
        final_name = f"room_{self.module.stable_suffix('room')}_2"
        self.assertTrue((destination / final_name / final_name / "prompt.json").exists())

    def test_allocation_is_deterministic_and_merge_stays_in_each_category(self):
        names = ("Room", "room", "A/B", "A:B")
        grouped = {
            main: {sub: [{"label": f"{main}:{sub}", "prompt": f"{main}:{sub}"}] for sub in names}
            for main in names
        }
        reversed_grouped = {main: dict(reversed(list(subs.items()))) for main, subs in reversed(list(grouped.items()))}
        destination = self.root / "data"
        initial = self.module._output_payloads(grouped, destination)
        self.assertEqual(self.module._output_payloads(reversed_grouped, destination), initial)
        self.assertEqual(self.module.write_data(grouped, destination), (4, 16, 16))
        self.assertEqual(self.module.write_data(reversed_grouped, destination, "merge"), (4, 16, 16))
        for subs in reversed_grouped.values():
            for items in subs.values():
                original = items[0]["prompt"]
                items.append({"label": f"new:{original}", "prompt": f"new:{original}"})
        self.assertEqual(self.module.write_data(reversed_grouped, destination, "merge"), (4, 16, 32))
        self.assertEqual(len(list(destination.rglob("prompt.json"))), 16)
        for path, items in initial:
            original = items[0]["prompt"]
            self.assertEqual(
                [item["prompt"] for item in json.loads(path.read_text(encoding="utf-8"))],
                [original, f"new:{original}"],
            )

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
