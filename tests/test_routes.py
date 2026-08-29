import importlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

from comfy_stubs import install_comfy_execution_stub, install_torch_stub


torch = install_torch_stub()
ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = ROOT / "scene_prompt_tools"


def load_routes(data_dir):
    install_comfy_execution_stub()
    comfy = types.ModuleType("comfy")
    management = types.ModuleType("comfy.model_management")
    management.intermediate_device = lambda: "cpu"
    management.intermediate_dtype = lambda: torch.float32
    comfy.model_management = management
    cli_args = types.ModuleType("comfy.cli_args")
    cli_args.args = types.SimpleNamespace(disable_metadata=False)
    folder_paths = types.ModuleType("folder_paths")
    folder_paths.get_output_directory = lambda: str(data_dir / "output")
    folder_paths.get_user_directory = lambda: str(data_dir / "user")

    aiohttp = types.ModuleType("aiohttp")
    aiohttp.web = types.SimpleNamespace(json_response=lambda *_args, **_kwargs: None)
    server = types.ModuleType("server")
    server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=types.SimpleNamespace()))
    sys.modules.update({
        "comfy": comfy,
        "comfy.model_management": management,
        "comfy.cli_args": cli_args,
        "folder_paths": folder_paths,
        "aiohttp": aiohttp,
        "server": server,
    })

    package_name = "scene_routes_test"
    for name in list(sys.modules):
        if name == package_name or name.startswith(f"{package_name}."):
            del sys.modules[name]
    package = types.ModuleType(package_name)
    package.__path__ = [str(PACKAGE_ROOT)]
    sys.modules[package_name] = package
    routes = importlib.import_module(f"{package_name}.routes")
    routes.DATA_DIR = data_dir
    routes.SAVED_PROMPTS_DIR = data_dir / routes.SAVED_PROMPTS_FOLDER
    routes._clear_prompt_caches()
    return routes


class PromptDataRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp.name) / "data"
        self.routes = load_routes(self.data_dir)

    def tearDown(self):
        self.temp.cleanup()

    def test_empty_data_directory_returns_empty_lists(self):
        self.assertEqual(self.routes._load_items(), [])
        self.assertEqual(self.routes._load_saved_prompts(), [])

    def test_corrupt_prompt_data_is_reported_with_filename(self):
        path = self.data_dir / "Category" / "prompt.json"
        path.parent.mkdir(parents=True)
        path.write_text("{broken", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, r"prompt\.json.*invalid JSON"):
            self.routes._load_items()

        with self.assertRaisesRegex(ValueError, r"prompt\.json.*invalid JSON"):
            self.routes._read_prompt_payload(path)
        try:
            self.routes._read_prompt_payload(path)
        except ValueError as exc:
            self.assertNotIn(str(self.data_dir), str(exc))

    def test_corrupt_saved_prompt_is_reported_with_filename(self):
        path = self.data_dir / self.routes.SAVED_PROMPTS_FOLDER / "saved" / "prompt.json"
        path.parent.mkdir(parents=True)
        path.write_text("{broken", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, r"prompt\.json.*invalid JSON"):
            self.routes._load_saved_prompts()

    def test_saved_prompt_items_keep_the_current_selection_schema(self):
        path = self.data_dir / self.routes.SAVED_PROMPTS_FOLDER / "saved" / "prompt.json"
        path.parent.mkdir(parents=True)
        item = {
            "id": "a", "label": "A", "prompt": "alpha, beta",
            "category_path": ["Category"], "category_key": "Category", "category_label": "Category",
            "selected_parts": [{"index": 0, "text": "alpha", "weight": 1.1}],
        }
        path.write_text(json.dumps({"name": "Saved", "description": "", "items": [item]}), encoding="utf-8")
        loaded = self.routes._load_saved_prompts()[0]["items"][0]
        self.assertEqual(loaded["selected_parts"][0]["weight"], 1.1)

        path.write_text(json.dumps({"name": "Saved", "description": "", "items": [{**item, "legacy": True}]}), encoding="utf-8")
        self.routes._clear_prompt_caches()
        with self.assertRaisesRegex(ValueError, r"unsupported"):
            self.routes._load_saved_prompts()


if __name__ == "__main__":
    unittest.main()
