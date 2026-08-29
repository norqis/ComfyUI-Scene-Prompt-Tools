import re
import unittest
from pathlib import Path

from check_public_package import (
    FORBIDDEN,
    SYNTHETIC_MERGE_ENV,
    history_privacy_failures,
    history_revision_range,
    synthetic_merge_metadata,
    tracked_files,
)


ROOT = Path(__file__).resolve().parents[1]


class PublicPackageTests(unittest.TestCase):
    def test_runtime_modules_are_in_one_internal_package(self):
        expected = {"__init__.py", "nodes.py", "plan.py", "prompt.py", "presets.py", "routes.py", "runs.py", "storage.py"}
        self.assertSetEqual({path.name for path in (ROOT / "scene_prompt_tools").glob("*.py")}, expected)
        for filename in expected - {"__init__.py"}:
            self.assertFalse((ROOT / filename).exists())

    def test_frontend_has_a_standard_test_entrypoint(self):
        package = (ROOT / "package.json").read_text(encoding="utf-8")
        self.assertIn('"test": "npm run check:frontend && npm run test:frontend"', package)

    def test_user_data_is_not_stored_in_the_custom_node_directory(self):
        self.assertFalse(any((ROOT / "data").glob("**/*")))
        storage_source = (ROOT / "scene_prompt_tools" / "storage.py").read_text(encoding="utf-8")
        self.assertIn("folder_paths.get_public_user_directory", storage_source)
        self.assertIn('STORAGE_DIRECTORY_NAME = "scene_prompt_tools"', storage_source)
        self.assertNotIn("get_public_user_directory", (ROOT / "scene_prompt_tools" / "presets.py").read_text(encoding="utf-8"))

    def test_generated_tool_caches_are_ignored(self):
        gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
        self.assertIn(".ruff_cache/", gitignore)

    def test_registry_metadata_declares_the_mit_license(self):
        pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
        self.assertIn('name = "scene-prompt-tools"', pyproject)
        self.assertIn('version = "0.2.6"', pyproject)
        self.assertIn('PublisherId = "norqis"', pyproject)
        self.assertIn('license = "MIT"', pyproject)
        self.assertIn('license-files = ["LICENSE"]', pyproject)
        self.assertIn('"License :: OSI Approved :: MIT License"', pyproject)
        self.assertTrue((ROOT / "LICENSE").is_file())
        self.assertFalse((ROOT / "requirements.txt").exists())

    def test_forbidden_pattern_matches_every_retired_name(self):
        candidates = (
            "META" + "CAMP",
            "META" + "CHAMP",
            "meta" + "-" + "camp",
            "meta" + "_" + "champ",
            "Scene" + " Promp" + "ter",
            "scene-" + "prompter",
            "scene_" + "prompter",
            "scene" + "Prompter",
        )
        for candidate in candidates:
            with self.subTest(candidate=candidate):
                self.assertIsNotNone(FORBIDDEN.search(candidate))

    def test_retired_names_and_private_brand_names_are_absent(self):
        for relative_path in tracked_files():
            path = ROOT / relative_path
            if path.suffix.lower() in {".pyc", ".png", ".jpg", ".jpeg", ".gif", ".zip"}:
                continue
            with self.subTest(path=relative_path):
                self.assertIsNone(FORBIDDEN.search(path.read_text(encoding="utf-8")))

    def test_runtime_uses_comfyui_user_data_directory(self):
        prompt_source = (ROOT / "scene_prompt_tools" / "prompt.py").read_text(encoding="utf-8")
        routes_source = (ROOT / "scene_prompt_tools" / "routes.py").read_text(encoding="utf-8")
        self.assertNotIn("prompt_data_directory", prompt_source)
        self.assertIn("prompt_data_directory(user_id)", routes_source)
        self.assertNotIn('Path(__file__).resolve().parents[1] / "data"', prompt_source + routes_source)

    def test_runtime_has_no_prompt_data_remapping(self):
        runtime_source = "\n".join(
            path.read_text(encoding="utf-8")
            for path in (ROOT / "scene_prompt_tools").glob("*.py")
        )
        for retired_name in ("prompt_data_index", "latest_prompt", "STORED_SELECTION_DATA", "project_prompt_data_index"):
            with self.subTest(retired_name=retired_name):
                self.assertNotIn(retired_name, runtime_source)

    def test_old_schema_migration_code_is_absent(self):
        runtime_source = "\n".join(
            path.read_text(encoding="utf-8")
            for path in (ROOT / "scene_prompt_tools").glob("*.py")
        )
        self.assertNotIn("legacy_keys", runtime_source)
        self.assertNotIn("source_shape", runtime_source)
        self.assertNotIn("_migrate", runtime_source)

    def test_public_text_sources_have_no_utf8_bom(self):
        for relative_path in tracked_files():
            path = ROOT / relative_path
            if path.suffix.lower() not in {".py", ".js", ".json", ".md", ".toml", ".yml", ".yaml"}:
                continue
            with self.subTest(path=relative_path):
                self.assertFalse(path.read_bytes().startswith(b"\xef\xbb\xbf"))

    def test_public_history_rejects_personal_email_but_allows_github_noreply(self):
        self.assertEqual(history_privacy_failures([
            ("a", "account@users.noreply.github.com", "github-actions[bot]@users.noreply.github.com"),
            ("b", "account@users.noreply.github.com", "noreply@github.com"),
        ]), [])
        self.assertEqual(len(history_privacy_failures([
            ("c", "person@example.test", "account@users.noreply.github.com"),
            ("d", "account@users.noreply.github.com", "person@example.test"),
        ])), 2)

    def test_public_history_uses_explicit_ci_branch_range_or_local_head(self):
        self.assertEqual(history_revision_range({}), "HEAD")
        self.assertEqual(
            history_revision_range({
                "SCENE_PROMPT_HISTORY_BASE_SHA": "base",
                "SCENE_PROMPT_HISTORY_HEAD_SHA": "head",
            }),
            "base..head",
        )
        self.assertEqual(
            history_revision_range({
                "SCENE_PROMPT_HISTORY_BASE_SHA": "0" * 40,
                "SCENE_PROMPT_HISTORY_HEAD_SHA": "head",
            }),
            "head",
        )
        with self.assertRaises(ValueError):
            history_revision_range({"SCENE_PROMPT_HISTORY_BASE_SHA": "base"})

    def test_synthetic_merge_metadata_is_optional_for_local_runs(self):
        self.assertEqual(synthetic_merge_metadata({}), [])
        records = synthetic_merge_metadata({SYNTHETIC_MERGE_ENV: "HEAD"})
        self.assertEqual(len(records), 1)
        self.assertEqual(len(records[0]), 3)
        with self.assertRaisesRegex(ValueError, "Synthetic merge ref"):
            synthetic_merge_metadata({SYNTHETIC_MERGE_ENV: "does-not-exist"})

    def test_ci_checks_event_specific_diff_ranges_with_full_history(self):
        workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        self.assertIn("fetch-depth: 0", workflow)
        self.assertIn("github.event.pull_request.base.sha", workflow)
        self.assertIn("github.event.before", workflow)
        self.assertIn("SCENE_PROMPT_HISTORY_BASE_SHA", workflow)
        self.assertIn("SCENE_PROMPT_HISTORY_HEAD_SHA", workflow)
        self.assertIn("refs/pull/${{ github.event.pull_request.number }}/merge", workflow)
        self.assertIn("SCENE_PROMPT_SYNTHETIC_MERGE_REF", workflow)
        self.assertIn("cache: pip", workflow)
        self.assertNotIn("cache: npm", workflow)
        self.assertIn('python -m pip install "numpy<3" "Pillow<12" "coverage<8"', workflow)
        self.assertIn("coverage report -m", workflow)
        self.assertIn("python3 - <<'PY'", workflow)


if __name__ == "__main__":
    unittest.main()
