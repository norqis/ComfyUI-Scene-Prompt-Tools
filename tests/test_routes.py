import importlib
import asyncio
import json
import sys
import tempfile
import threading
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
    folder_paths.get_public_user_directory = lambda user_id: str(data_dir / "user" / user_id)

    registered = {}
    def route(method):
        def register(path):
            def decorate(handler):
                registered[(method, path)] = handler
                return handler
            return decorate
        return register
    aiohttp = types.ModuleType("aiohttp")
    aiohttp.web = types.SimpleNamespace(
        json_response=lambda payload, status=200: {"payload": payload, "status": status},
    )
    server = types.ModuleType("server")
    server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(
        routes=types.SimpleNamespace(get=route("GET"), post=route("POST")),
        user_manager=types.SimpleNamespace(get_request_user_id=lambda request: request.user_id),
    ))
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
    routes._clear_prompt_caches()
    routes.define_routes()
    routes._test_routes = registered
    return routes


class PromptDataRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.routes = load_routes(Path(self.temp.name) / "data")
        self.data_dir = self.routes._data_dir()

    def tearDown(self):
        self.temp.cleanup()

    def test_empty_data_directory_returns_empty_lists(self):
        self.assertEqual(self.routes._load_items(), [])
        self.assertEqual(self.routes._load_saved_prompts(), [])

    def test_corrupt_prompt_data_is_reported_with_filename(self):
        path = self.data_dir / "Category" / "prompt.json"
        path.parent.mkdir(parents=True)
        path.write_text("{broken", encoding="utf-8")
        payload = self.routes._load_items(with_errors=True)
        self.assertEqual(payload["items"], [])
        self.assertEqual(payload["errors"][0]["file"], "Category/prompt.json")
        self.assertNotIn(str(self.data_dir), payload["errors"][0]["error"])

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
        payload = self.routes._load_saved_prompts(with_errors=True)
        self.assertEqual(payload["saved_prompts"], [])
        self.assertEqual(payload["errors"][0]["file"], "saved/prompt.json")
        self.assertNotIn(str(self.data_dir), payload["errors"][0]["error"])

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
        payload = self.routes._load_saved_prompts(with_errors=True)
        self.assertEqual(payload["saved_prompts"], [])
        self.assertIn("unsupported", payload["errors"][0]["error"])

    def test_prompt_data_and_saved_prompts_are_isolated_by_user(self):
        alice_data = self.routes._data_dir("alice")
        bob_data = self.routes._data_dir("bob")
        alice_file = alice_data / "People" / "prompt.json"
        bob_file = bob_data / "People" / "prompt.json"
        for path, label in ((alice_file, "Alice"), (bob_file, "Bob")):
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps([{"label": label, "prompt": label.lower(), "description": ""}]), encoding="utf-8")
        self.assertEqual([item["label"] for item in self.routes._load_items("alice")], ["Alice"])
        self.assertEqual([item["label"] for item in self.routes._load_items("bob")], ["Bob"])

    def test_prompt_paths_reject_untrusted_user_ids(self):
        for user_id in ("", "../outside", "/outside", "C:" + chr(92) + "outside", "__system"):
            with self.subTest(user_id=user_id):
                with self.assertRaises(ValueError):
                    self.routes._data_dir(user_id)

    def test_new_category_components_reject_path_characters_without_sanitizing(self):
        for field, value in (("category", "A/B"), ("subcategory", "A\\B"), ("category", "..")):
            payload = {"category": "People", "subcategory": "", "label": "One", "prompt": "girl"}
            payload[field] = value
            with self.subTest(field=field, value=value):
                with self.assertRaisesRegex(ValueError, "unsupported|cannot"):
                    self.routes._create_prompt_item(payload, "alice")
        self.assertFalse((self.routes._data_dir("alice") / "A").exists())

    def test_new_category_components_reject_names_over_80_characters(self):
        shared_prefix = "A" * 80
        for suffix in ("1", "2"):
            with self.subTest(suffix=suffix), self.assertRaisesRegex(ValueError, "80 characters"):
                self.routes._create_prompt_item({
                    "category": f"{shared_prefix}{suffix}",
                    "label": "One",
                    "prompt": "girl",
                }, "alice")
        self.assertFalse((self.routes._data_dir("alice") / shared_prefix).exists())

    def test_force_reload_discards_the_user_cache(self):
        path = self.routes._data_dir("alice") / "People" / "prompt.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps([{"label": "Old", "prompt": "old"}]), encoding="utf-8")
        self.assertEqual(self.routes._load_items("alice")[0]["label"], "Old")
        path.write_text(json.dumps([{"label": "New", "prompt": "new"}]), encoding="utf-8")
        self.assertEqual(self.routes._load_items("alice", force=True)[0]["label"], "New")

    def test_post_write_keeps_success_when_list_reload_fails(self):
        class Request:
            def __init__(self, payload):
                self.user_id = "alice"
                self.payload = payload

            async def json(self):
                return self.payload

        handler = self.routes._test_routes[("POST", "/scene_prompt/items")]
        original = self.routes._load_items
        self.routes._load_items = lambda *args, **kwargs: (_ for _ in ()).throw(OSError("reload failed"))
        try:
            response = asyncio.run(handler(Request({"category": "People", "label": "One", "prompt": "girl"})))
        finally:
            self.routes._load_items = original
        self.assertEqual(response["status"], 200)
        self.assertEqual(response["payload"]["item"]["label"], "One")
        self.assertIn("warning", response["payload"])
        self.assertTrue((self.routes._data_dir("alice") / "People" / "prompt.json").exists())

    def test_route_endpoints_cover_saved_prompts_presets_claim_and_force_reads(self):
        class Request:
            def __init__(self, payload=None, query=None):
                self.user_id = "alice"
                self.payload = payload
                self.query = query or {}

            async def json(self):
                return self.payload

        item = {
            "id": "sample",
            "label": "Sample",
            "prompt": "girl",
            "category_path": ["People"],
            "category_key": "People",
            "category_label": "People",
            "selected_parts": [{"index": 0, "text": "girl", "weight": 1.0}],
        }
        saved = self.routes._test_routes[("POST", "/scene_prompt/saved_prompts")]
        saved_response = asyncio.run(saved(Request({"name": "Saved", "description": "", "items": [item]})))
        self.assertEqual(saved_response["status"], 200)
        self.assertEqual(saved_response["payload"]["saved_prompt"]["name"], "Saved")
        get_saved = self.routes._test_routes[("GET", "/scene_prompt/saved_prompts")]
        self.assertEqual(asyncio.run(get_saved(Request(query={"reload": "1"})))["payload"]["saved_prompts"][0]["name"], "Saved")

        graph = {
            "output": {
                "1": {"class_type": "ScenePresetInput", "inputs": {}},
                "2": {
                    "class_type": "ScenePrompter",
                    "inputs": {
                        "prompt_name": "Preset", "positive_base": "preset", "positive_json": '{"version":1,"categories":{}}',
                        "negative_base": "", "negative_json": '{"version":1,"categories":{}}', "category_order": "",
                        "seed": 0, "randomize": True, "scene_prompt": ["1", 0],
                    },
                },
                "3": {"class_type": "ScenePresetOutput", "inputs": {"scene_prompt": ["2", 0]}},
            }
        }
        save_preset = self.routes._test_routes[("POST", "/scene_presets/save")]
        response = asyncio.run(save_preset(Request({"preset_id": "route", "name": "Route", "output_node_id": "3", "api_graph": graph, "workflow": {"nodes": []}})))
        self.assertEqual(response["status"], 200)
        list_presets = self.routes._test_routes[("GET", "/scene_presets/list")]
        self.assertEqual(asyncio.run(list_presets(Request()))["payload"]["presets"][0]["metadata"]["preset_id"], "route")
        load_preset = self.routes._test_routes[("GET", "/scene_presets/load")]
        loaded = asyncio.run(load_preset(Request(query={"preset_id": "route"})))
        self.assertEqual(loaded["status"], 200)
        self.assertSetEqual(set(loaded["payload"]), {"metadata", "workflow"})
        self.assertEqual(loaded["payload"]["metadata"]["preset_id"], "route")
        self.assertNotIn("api_graph", loaded["payload"])

        prepare = self.routes._test_routes[("POST", "/scene_prompt/runs/prepare")]
        claim = self.routes._test_routes[("POST", "/scene_prompt/runs/claim")]
        release = self.routes._test_routes[("POST", "/scene_prompt/runs/release")]
        prepared_graph = {"output": {"1": {"class_type": "ScenePrompter", "inputs": {}}}}
        prepared = asyncio.run(prepare(Request({"api_graph": prepared_graph})))
        handle = prepared["payload"]["run_handle"]
        self.assertTrue(asyncio.run(claim(Request({"run_handle": handle, "prompt_id": "route-prompt"})))["payload"]["claimed"])
        self.assertTrue(asyncio.run(release(Request({"run_handle": handle})))["payload"]["released"])

    def test_preset_load_route_is_user_scoped_and_has_clear_errors(self):
        class Request:
            def __init__(self, user_id, query):
                self.user_id = user_id
                self.query = query

        graph = {
            "output": {
                "1": {"class_type": "ScenePresetInput", "inputs": {}},
                "2": {"class_type": "ScenePrompter", "inputs": {
                    "prompt_name": "Preset", "positive_base": "alice", "positive_json": '{"version":1,"categories":{}}',
                    "negative_base": "", "negative_json": '{"version":1,"categories":{}}', "category_order": "",
                    "seed": 0, "randomize": True, "scene_prompt": ["1", 0],
                }},
                "3": {"class_type": "ScenePresetOutput", "inputs": {"scene_prompt": ["2", 0]}},
            },
        }
        self.routes.save_preset({
            "preset_id": "shared", "name": "Alice", "output_node_id": "3", "api_graph": graph,
            "workflow": {"version": 1, "nodes": [{"id": 1, "type": "ScenePresetInput"}]},
        }, "alice")
        graph["output"]["2"]["inputs"]["positive_base"] = "bob"
        self.routes.save_preset({
            "preset_id": "shared", "name": "Bob", "output_node_id": "3", "api_graph": graph,
            "workflow": {"version": 1, "nodes": [{"id": 1, "type": "ScenePresetInput"}]},
        }, "bob")
        load_preset = self.routes._test_routes[("GET", "/scene_presets/load")]
        alice = asyncio.run(load_preset(Request("alice", {"preset_id": "shared"})))
        bob = asyncio.run(load_preset(Request("bob", {"preset_id": "shared"})))
        self.assertEqual(alice["payload"]["metadata"]["name"], "Alice")
        self.assertEqual(bob["payload"]["metadata"]["name"], "Bob")
        self.assertEqual(asyncio.run(load_preset(Request("alice", {"preset_id": "missing"})))["status"], 404)
        self.assertEqual(asyncio.run(load_preset(Request("alice", {"preset_id": "bad/id"})))["status"], 400)
        presets = sys.modules[f"{self.routes.__package__}.presets"]
        broken = presets._preset_path("broken", "alice")
        broken.write_text("{broken", encoding="utf-8")
        self.assertEqual(asyncio.run(load_preset(Request("alice", {"preset_id": "broken"})))["status"], 400)

    def test_preset_save_route_returns_conflict_for_stale_revision(self):
        class Request:
            user_id = "alice"

            def __init__(self, payload):
                self.payload = payload

            async def json(self):
                return self.payload

        graph = {
            "output": {
                "1": {"class_type": "ScenePresetInput", "inputs": {}},
                "2": {"class_type": "ScenePrompter", "inputs": {
                    "prompt_name": "Preset", "positive_base": "one", "positive_json": '{"version":1,"categories":{}}',
                    "negative_base": "", "negative_json": '{"version":1,"categories":{}}', "category_order": "",
                    "seed": 0, "randomize": True, "scene_prompt": ["1", 0],
                }},
                "3": {"class_type": "ScenePresetOutput", "inputs": {"scene_prompt": ["2", 0]}},
            },
        }
        payload = {"preset_id": "conflict", "name": "Conflict", "output_node_id": "3", "api_graph": graph, "workflow": {"version": 1, "nodes": []}}
        save = self.routes._test_routes[("POST", "/scene_presets/save")]
        self.assertEqual(asyncio.run(save(Request(payload)))["status"], 200)
        payload["expected_revision"] = 1
        self.assertEqual(asyncio.run(save(Request(payload)))["status"], 200)
        self.assertEqual(asyncio.run(save(Request(payload)))["status"], 409)

    def test_async_item_route_keeps_the_event_loop_responsive(self):
        handler = self.routes._test_routes[("GET", "/scene_prompt/items")]
        original = self.routes._load_items

        def slow_load(user_id, *args, **kwargs):
            import time
            time.sleep(0.05)
            return original(user_id, *args, **kwargs)

        self.routes._load_items = slow_load
        try:
            async def run():
                task = asyncio.create_task(handler(types.SimpleNamespace(user_id="alice", query={})))
                await asyncio.sleep(0.005)
                self.assertFalse(task.done())
                return await task
            response = asyncio.run(run())
        finally:
            self.routes._load_items = original
        self.assertEqual(response["status"], 200)
        self.assertEqual(response["payload"], {"items": [], "errors": []})

    def test_prepare_route_creates_owner_bound_opaque_context(self):
        class Request:
            def __init__(self, user_id, payload):
                self.user_id = user_id
                self.payload = payload

            async def json(self):
                return self.payload

        prepare = self.routes._test_routes[("POST", "/scene_prompt/runs/prepare")]
        release = self.routes._test_routes[("POST", "/scene_prompt/runs/release")]
        graph = {"output": {"1": {"class_type": "ScenePrompter", "inputs": {}}}}
        response = asyncio.run(prepare(Request("alice", {"user_id": "bob", "api_graph": graph})))
        self.assertEqual(response["status"], 200)
        handle = response["payload"]["run_handle"]
        self.assertNotEqual(handle, "alice")
        self.assertNotIn("user_id", response["payload"])

        runs = sys.modules[f"{self.routes.__package__}.runs"]
        self.assertEqual(runs.require_run_context(handle)["user_id"], "alice")
        self.assertFalse(asyncio.run(release(Request("bob", {"run_handle": handle})))["payload"]["released"])
        self.assertTrue(asyncio.run(release(Request("alice", {"run_handle": handle})))["payload"]["released"])
        with self.assertRaises(runs.SceneRunError):
            runs.require_run_context(handle)

    def test_prepare_reconciles_only_stale_ordinary_active_contexts(self):
        class Request:
            user_id = "alice"

            def __init__(self, payload):
                self.payload = payload

            async def json(self):
                return self.payload

        runs = sys.modules[f"{self.routes.__package__}.runs"]
        runs.RUN_CONTEXTS = runs.RunContextStore()
        stale = runs.create_run_context("alice")
        running = runs.create_run_context("alice")
        continuous = runs.create_run_context("alice", continuous=True)
        self.assertTrue(runs.claim_run_context(stale, "alice", "finished"))
        self.assertTrue(runs.claim_run_context(running, "alice", "running"))
        self.assertTrue(runs.claim_run_context(continuous, "alice", "batch-finished"))

        self.routes.PromptServer.instance.prompt_queue = types.SimpleNamespace(
            get_current_queue_volatile=lambda: ([(0, "running")], []),
        )
        prepare = self.routes._test_routes[("POST", "/scene_prompt/runs/prepare")]
        graph = {"output": {"1": {"class_type": "ScenePrompter", "inputs": {}}}}
        response = asyncio.run(prepare(Request({"api_graph": graph})))

        self.assertEqual(response["status"], 200)
        with self.assertRaises(runs.SceneRunError):
            runs.require_run_context(stale)
        self.assertEqual(runs.require_run_context(running)["state"], "active")
        self.assertEqual(runs.require_run_context(continuous)["state"], "active")

    def test_continuous_run_detection_uses_the_target_expand_only(self):
        graph = {"output": {
            "1": {"class_type": "ScenePrompterExpand", "inputs": {"run_id": "continuous"}},
            "2": {"class_type": "ScenePrompterExpand", "inputs": {}},
        }}
        self.assertTrue(self.routes._is_continuous_scene_run(graph, "1"))
        self.assertFalse(self.routes._is_continuous_scene_run(graph, "2"))

    def test_prepare_and_claim_are_owner_bound(self):
        class Request:
            def __init__(self, user_id, payload):
                self.user_id = user_id
                self.payload = payload

            async def json(self):
                return self.payload

        selected = json.dumps({"version": 1, "categories": {"Style": [{
            "id": "used", "label": "Used", "prompt": "used",
            "category_path": ["Style"], "category_key": "Style", "category_label": "Style",
        }]}})
        graph = {"output": {"1": {"class_type": "ScenePrompter", "inputs": {"positive_json": selected}}}}
        prepare = self.routes._test_routes[("POST", "/scene_prompt/runs/prepare")]
        claim = self.routes._test_routes[("POST", "/scene_prompt/runs/claim")]
        release = self.routes._test_routes[("POST", "/scene_prompt/runs/release")]
        handle = asyncio.run(prepare(Request("alice", {"api_graph": graph})))["payload"]["run_handle"]
        runs = sys.modules[f"{self.routes.__package__}.runs"]
        self.assertEqual(runs.require_run_context(handle)["user_id"], "alice")
        self.assertFalse(asyncio.run(claim(Request("bob", {"run_handle": handle, "prompt_id": "p1"})))["payload"]["claimed"])
        self.assertTrue(asyncio.run(claim(Request("alice", {"run_handle": handle, "prompt_id": "p1"})))["payload"]["claimed"])
        self.assertTrue(asyncio.run(claim(Request("alice", {"run_handle": handle, "prompt_id": "p1"})))["payload"]["claimed"])
        self.assertTrue(asyncio.run(release(Request("alice", {"run_handle": handle})))["payload"]["released"])

    def test_prepare_ignores_canvas_only_presets_without_connected_full_save(self):
        class Request:
            def __init__(self, payload):
                self.user_id = "alice"
                self.payload = payload

            async def json(self):
                return self.payload

        prepare = self.routes._test_routes[("POST", "/scene_prompt/runs/prepare")]
        release = self.routes._test_routes[("POST", "/scene_prompt/runs/release")]
        workflow = {"nodes": [{"id": 50, "type": "ScenePresetReference", "widgets_values": ["missing"]}], "links": []}
        scene_inputs = {
            "prompt_name": "Test",
            "positive_base": "",
            "positive_json": '{"version":1,"categories":{}}',
            "negative_base": "",
            "negative_json": '{"version":1,"categories":{}}',
            "category_order": "",
            "seed": 0,
            "randomize": False,
        }
        cases = (
            ("off", {"metadata_mode": "ワークフロー全体", "expand_preset_contents": False, "scene_info": ["2", 2]}),
            ("prompt only", {"metadata_mode": "プロンプトのみ", "expand_preset_contents": True, "scene_info": ["2", 2]}),
            ("execution path", {"metadata_mode": "生成経路ノードのみ", "expand_preset_contents": True, "scene_info": ["2", 2]}),
            ("other expand", {"metadata_mode": "ワークフロー全体", "expand_preset_contents": True, "scene_info": ["4", 2]}),
        )
        for label, save_inputs in cases:
            with self.subTest(label=label):
                graph = {"output": {
                    "1": {"class_type": "ScenePrompter", "inputs": scene_inputs},
                    "2": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["1", 0]}},
                    "3": {"class_type": "ScenePrompter", "inputs": scene_inputs},
                    "4": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["3", 0]}},
                    "9": {"class_type": "SceneSaveImage", "inputs": save_inputs},
                }}
                response = asyncio.run(prepare(Request({
                    "api_graph": graph,
                    "expand_node_id": "2",
                    "workflow": workflow,
                })))
                self.assertEqual(response["status"], 200, response["payload"])
                self.assertEqual(response["payload"]["presets"], [])
                handle = response["payload"]["run_handle"]
                self.assertTrue(asyncio.run(release(Request({"run_handle": handle})))["payload"]["released"])

    def test_prepare_uses_stored_selections_without_reading_prompt_data(self):
        class Request:
            user_id = "alice"

            async def json(self):
                selected = json.dumps({"version": 1, "categories": {"Style": [{
                    "id": "used", "label": "Used", "prompt": "stored prompt",
                    "category_path": ["Style"], "category_key": "Style", "category_label": "Style",
                }]}})
                return {"api_graph": {"output": {
                    "1": {"class_type": "ScenePrompter", "inputs": {
                        "prompt_name": "Stored",
                        "positive_base": "",
                        "positive_json": selected,
                        "negative_base": "",
                        "negative_json": '{"version":1,"categories":{}}',
                        "category_order": "",
                        "seed": 0,
                        "randomize": True,
                    }},
                    "2": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["1", 0]}},
                }}, "expand_node_id": "2"}

        prepare = self.routes._test_routes[("POST", "/scene_prompt/runs/prepare")]
        release = self.routes._test_routes[("POST", "/scene_prompt/runs/release")]
        original_data_dir = self.routes._data_dir
        self.routes._data_dir = lambda *_args: (_ for _ in ()).throw(AssertionError("generation must not read prompt data"))
        try:
            response = asyncio.run(prepare(Request()))
        finally:
            self.routes._data_dir = original_data_dir

        self.assertEqual(response["status"], 200, response["payload"])
        self.assertEqual(response["payload"]["total_images"], 1)
        handle = response["payload"]["run_handle"]
        request = types.SimpleNamespace(user_id="alice", json=lambda: None)
        request.json = lambda: asyncio.sleep(0, result={"run_handle": handle})
        self.assertTrue(asyncio.run(release(request))["payload"]["released"])

    def test_prepare_ignores_stale_selections_outside_selected_expand_branch(self):
        class Request:
            def __init__(self, user_id, payload):
                self.user_id = user_id
                self.payload = payload

            async def json(self):
                return self.payload

        current = json.dumps({"version": 1, "categories": {"Style": [{
            "id": "current", "label": "Current", "prompt": "current",
            "category_path": ["Style"], "category_key": "Style", "category_label": "Style",
        }]}})
        stale = json.dumps({"version": 1, "categories": {"Style": [{
            "id": "stale", "label": "Stale", "prompt": "stale",
            "category_path": ["Style"], "category_key": "Style", "category_label": "Style",
        }]}})
        scene_inputs = {
            "prompt_name": "Current branch",
            "positive_base": "",
            "positive_json": current,
            "negative_base": "",
            "negative_json": "{\"version\":1,\"categories\":{}}",
            "category_order": "",
            "seed": 0,
            "randomize": True,
        }
        graph = {"output": {
            "1": {"class_type": "ScenePrompter", "inputs": scene_inputs},
            "2": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["1", 0]}},
            "3": {"class_type": "ScenePrompter", "inputs": {"positive_json": stale}},
            "4": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["3", 0]}},
        }}
        prepare = self.routes._test_routes[("POST", "/scene_prompt/runs/prepare")]
        release = self.routes._test_routes[("POST", "/scene_prompt/runs/release")]

        response = asyncio.run(prepare(Request("alice", {
            "api_graph": graph,
            "expand_node_id": "2",
        })))

        self.assertEqual(response["status"], 200, response["payload"])
        handle = response["payload"]["run_handle"]
        runs = sys.modules[f"{self.routes.__package__}.runs"]
        self.assertEqual(runs.require_run_context(handle)["user_id"], "alice")
        self.assertTrue(asyncio.run(release(Request("alice", {"run_handle": handle})))["payload"]["released"])

    def test_unlinked_expand_ignores_disconnected_stale_selections(self):
        class Request:
            def __init__(self, user_id, payload):
                self.user_id = user_id
                self.payload = payload

            async def json(self):
                return self.payload

        stale = json.dumps({"version": 1, "categories": {"Style": [{
            "id": "stale", "label": "Stale", "prompt": "stale",
            "category_path": ["Style"], "category_key": "Style", "category_label": "Style",
        }]}})
        graph = {"output": {
            "1": {"class_type": "ScenePrompter", "inputs": {"positive_json": stale}},
            "2": {"class_type": "ScenePrompterExpand", "inputs": {}},
            "3": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["1", 0]}},
        }}
        prepare = self.routes._test_routes[("POST", "/scene_prompt/runs/prepare")]
        release = self.routes._test_routes[("POST", "/scene_prompt/runs/release")]

        response = asyncio.run(prepare(Request("alice", {
            "api_graph": graph,
            "expand_node_id": "2",
        })))

        self.assertEqual(response["status"], 200, response["payload"])
        handle = response["payload"]["run_handle"]
        self.assertTrue(asyncio.run(release(Request("alice", {"run_handle": handle})))["payload"]["released"])

    def test_explicit_expand_rejects_missing_wrong_and_invalid_upstream_nodes(self):
        class Request:
            def __init__(self, user_id, payload):
                self.user_id = user_id
                self.payload = payload

            async def json(self):
                return self.payload

        prepare = self.routes._test_routes[("POST", "/scene_prompt/runs/prepare")]
        for expand_node_id, expected in (("missing", "Scene Prompt Expand #missing が見つかりません。"), (
            "1", "#1 は Scene Prompt Expand ではありません。",
        )):
            with self.subTest(expand_node_id=expand_node_id):
                graph = {"output": {"1": {"class_type": "ScenePrompter", "inputs": {}}}}
                response = asyncio.run(prepare(Request("alice", {
                    "api_graph": graph,
                    "expand_node_id": expand_node_id,
                })))
                self.assertEqual(response["status"], 400)
                self.assertEqual(response["payload"]["error"], expected)

    def test_expiration_removes_contexts_and_preset_snapshots_once_and_bounds_caches(self):
        runs = sys.modules[f"{self.routes.__package__}.runs"]
        presets = sys.modules[f"{self.routes.__package__}.presets"]
        store = runs.RUN_CONTEXTS
        original = (store.prepared_ttl_seconds, store._expiration_callback)
        released = []

        def release_snapshot(handle, user_id):
            released.append((handle, user_id))
            presets.release_scene_preset_snapshot(handle, user_id)

        graph = {"output": {"1": {"class_type": "ScenePrompter", "inputs": {}}}}
        handles = []
        try:
            store.prepared_ttl_seconds = 999
            runs.set_run_expiration_callback(release_snapshot)
            for index in range(300):
                user_id = f"user-{index}"
                handle = runs.create_run_context(user_id)
                presets.snapshot_presets_for_run(handle, graph, user_id=user_id)
                handles.append((handle, user_id))

            self.assertEqual(len(store._entries), 300)
            self.assertEqual(len(presets._RUN_SNAPSHOTS), 300)
            store.prepared_ttl_seconds = 0
            with self.assertRaisesRegex(runs.SceneRunError, "有効期限"):
                runs.require_run_context(handles[0][0])
            self.assertFalse(runs.claim_run_context(handles[1][0], handles[1][1], "late-prompt"))
            runs.purge_expired_run_contexts()

            self.assertEqual(store._entries, {})
            self.assertEqual(presets._RUN_SNAPSHOTS, {})
            self.assertCountEqual(released, handles)
            self.assertEqual(len(released), len(set(released)))
            self.assertLessEqual(len(presets._CANCELLED_RUNS), presets._CANCELLED_RUNS_MAX_ENTRIES)
        finally:
            store.clear()
            presets._RUN_SNAPSHOTS.clear()
            presets._CANCELLED_RUNS.clear()
            store.prepared_ttl_seconds, callback = original
            runs.set_run_expiration_callback(callback)

    def test_stale_threaded_read_cannot_restore_a_cleared_cache(self):
        path = self.routes._data_dir("alice") / "Category" / "prompt.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps([{"label": "Old", "prompt": "old"}]), encoding="utf-8")
        self.routes._clear_prompt_caches("alice")
        started = threading.Event()
        continue_read = threading.Event()
        original = self.routes._read_items

        def delayed_read(*args, **kwargs):
            value = original(*args, **kwargs)
            started.set()
            self.assertTrue(continue_read.wait(2))
            return value

        self.routes._read_items = delayed_read
        result = {}
        worker = threading.Thread(target=lambda: result.setdefault("items", self.routes._load_items("alice")))
        worker.start()
        self.assertTrue(started.wait(2))
        path.write_text(json.dumps([{"label": "New", "prompt": "new"}]), encoding="utf-8")
        self.routes._clear_prompt_caches("alice")
        continue_read.set()
        worker.join(2)
        self.routes._read_items = original
        self.assertEqual([item["label"] for item in result["items"]], ["New"])
        self.assertEqual([item["label"] for item in self.routes._load_items("alice")], ["New"])

    def test_ui_caches_evict_least_recently_used_users(self):
        for index in range(self.routes._CACHE_MAX_USERS + 1):
            self.routes._load_items(f"user-{index}")
            self.routes._load_saved_prompts(f"user-{index}")

        self.assertEqual(len(self.routes._ITEMS_CACHE), self.routes._CACHE_MAX_USERS)
        self.assertEqual(len(self.routes._SAVED_PROMPTS_CACHE), self.routes._CACHE_MAX_USERS)
        self.assertNotIn("user-0", self.routes._ITEMS_CACHE)
        self.assertNotIn("user-0", self.routes._SAVED_PROMPTS_CACHE)


if __name__ == "__main__":
    unittest.main()
