import importlib
import copy
import asyncio
import json
import os
import sys
import tempfile
import threading
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

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
    folder_paths.get_system_user_directory = lambda name: str(data_dir / "user" / "__system__" / name)

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

    def test_lora_catalog_route_returns_catalog(self):
        handler = self.routes._test_routes[("GET", "/scene_prompt/loras/list")]
        catalog = [{"path": "style/example.safetensors", "title": "Example", "source": "local",
                    "size": 10, "mtime_ns": 123}]
        with mock.patch.object(self.routes, "list_loras", return_value=catalog):
            self.assertEqual(asyncio.run(handler(None)), {"payload": catalog, "status": 200})

    def test_completed_prompt_status_reports_error_before_completed_flag(self):
        self.routes.PromptServer.instance.prompt_queue = types.SimpleNamespace(
            get_history=lambda **_kwargs: {"failed": {"status": {"status_str": "error", "completed": False}}}
        )
        self.assertEqual(self.routes._completed_prompt_status("failed"), "failed")
        self.routes.PromptServer.instance.prompt_queue = types.SimpleNamespace(
            get_history=lambda **_kwargs: {"pending": {"status": {"status_str": None, "completed": False}}}
        )
        self.assertEqual(self.routes._completed_prompt_status("pending"), "pending")

    def test_desktop_ack_route_is_owner_bound_and_one_shot(self):
        class Request:
            def __init__(self, user_id, payload):
                self.user_id = user_id
                self.payload = payload

            async def json(self):
                return self.payload

        callbacks = importlib.import_module(f"{self.routes.__package__}.callbacks")
        callbacks._DESKTOP_PENDING["request"] = {
            "event": threading.Event(), "user_id": "alice", "result": None,
        }
        try:
            ack = self.routes._test_routes[("POST", "/scene_prompt/callbacks/desktop/ack")]
            self.assertEqual(asyncio.run(ack(Request("bob", {"request_id": "request", "success": True})))["status"], 403)
            self.assertEqual(asyncio.run(ack(Request("alice", {"request_id": "request", "success": True}))), {"payload": {"acknowledged": True}, "status": 200})
            self.assertEqual(asyncio.run(ack(Request("alice", {"request_id": "request", "success": True})))["status"], 404)
        finally:
            callbacks._DESKTOP_PENDING.pop("request", None)

    def test_prepare_stores_client_id_only_in_private_delivery_context(self):
        class Request:
            user_id = "alice"

            async def json(self):
                return {"api_graph": {"output": {"1": {"class_type": "ScenePrompter", "inputs": {}}}}, "client_id": "desktop-client"}

        prepare = self.routes._test_routes[("POST", "/scene_prompt/runs/prepare")]
        response = asyncio.run(prepare(Request()))
        self.assertNotIn("client_id", response["payload"])
        runs = sys.modules[f"{self.routes.__package__}.runs"]
        self.assertEqual(runs.get_run_delivery_context(response["payload"]["run_handle"]), {"client_id": "desktop-client", "user_id": "alice"})

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

    def test_new_category_components_preserve_distinct_names_over_80_characters(self):
        shared_prefix = "A" * 80
        for suffix in ("1", "2"):
            with self.subTest(suffix=suffix):
                self.routes._create_prompt_item({
                    "category": f"{shared_prefix}{suffix}",
                    "label": "One",
                    "prompt": "girl",
                }, "alice")
        self.assertTrue((self.routes._data_dir("alice") / f"{shared_prefix}1").exists())
        self.assertTrue((self.routes._data_dir("alice") / f"{shared_prefix}2").exists())

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
        full_loaded = asyncio.run(load_preset(Request(query={"preset_id": "route", "include_api_graph": "1"})))
        self.assertEqual(full_loaded["status"], 200)
        self.assertSetEqual(set(full_loaded["payload"]), {"schema_version", "metadata", "workflow", "api_graph"})
        self.assertEqual(full_loaded["payload"]["schema_version"], 1)
        self.assertEqual(full_loaded["payload"]["api_graph"], graph)
        hydrated = copy.deepcopy(full_loaded['payload'])
        hydrated['api_graph']['output']['2']['inputs']['positive_base'] = 'edited hydrated result'
        presets_module = importlib.import_module(self.routes.__package__ + '.presets')
        overrides = presets_module.parse_llm_preset_overrides(json.dumps({'version': 1, 'presets': {'.': hydrated}}))
        self.assertEqual(overrides['.']['api_graph']['output']['2']['inputs']['positive_base'], 'edited hydrated result')
        default_loaded = asyncio.run(load_preset(Request(query={"preset_id": "route", "include_api_graph": "0"})))
        self.assertNotIn("api_graph", default_loaded["payload"])

        prepare = self.routes._test_routes[("POST", "/scene_prompt/runs/prepare")]
        claim = self.routes._test_routes[("POST", "/scene_prompt/runs/claim")]
        release = self.routes._test_routes[("POST", "/scene_prompt/runs/release")]
        prepared_graph = {"output": {"1": {"class_type": "ScenePrompter", "inputs": {}}}}
        prepared = asyncio.run(prepare(Request({"api_graph": prepared_graph})))
        handle = prepared["payload"]["run_handle"]
        self.assertTrue(asyncio.run(claim(Request({"run_handle": handle, "prompt_id": "route-prompt"})))["payload"]["claimed"])
        self.assertTrue(asyncio.run(release(Request({"run_handle": handle})))["payload"]["released"])

    def test_preset_save_returns_empty_reference_node_id(self):
        class Request:
            user_id = "alice"

            def __init__(self, payload):
                self.payload = payload

            async def json(self):
                return self.payload

        graph = {
            "output": {
                "1": {"class_type": "ScenePresetInput", "inputs": {}},
                "2": {
                    "class_type": "ScenePresetReference",
                    "_meta": {"title": "途中の参照"},
                    "inputs": {"preset_id": "", "scene_prompt": ["1", 0]},
                },
                "3": {"class_type": "ScenePresetOutput", "inputs": {"scene_prompt": ["2", 0]}},
            },
        }
        save_preset = self.routes._test_routes[("POST", "/scene_presets/save")]
        response = asyncio.run(save_preset(Request({
            "preset_id": "empty-reference",
            "name": "Empty Reference",
            "output_node_id": "3",
            "api_graph": graph,
            "workflow": {"nodes": []},
        })))

        self.assertEqual(response["status"], 400)
        self.assertEqual(response["payload"], {
            "error": "Preset「Empty Reference」: 途中の参照 #2 でPresetが選択されていません。",
            "node_id": "2",
        })

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

    def test_preset_save_route_ignores_stale_revision_and_keeps_last_content(self):
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
        payload["api_graph"]["output"]["2"]["inputs"]["positive_base"] = "last"
        last = asyncio.run(save(Request(payload)))
        self.assertEqual(last["status"], 200)
        self.assertNotIn("revision", last["payload"]["metadata"])
        presets = sys.modules[f"{self.routes.__package__}.presets"]
        self.assertEqual(
            presets.load_preset("conflict", "alice")["api_graph"]["output"]["2"]["inputs"]["positive_base"],
            "last",
        )

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
            self.assertEqual(len(presets._CANCELLED_RUNS), len(handles))
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

    def test_ui_caches_keep_all_current_users_without_count_eviction(self):
        with mock.patch.object(self.routes.time, "monotonic", return_value=0):
            for index in range(70):
                self.routes._load_items(f"user-{index}")
                self.routes._load_saved_prompts(f"user-{index}")
        self.assertEqual(len(self.routes._ITEMS_CACHE), 70)
        self.assertEqual(len(self.routes._SAVED_PROMPTS_CACHE), 70)
        self.assertIn("user-0", self.routes._ITEMS_CACHE)
        self.assertIn("user-0", self.routes._SAVED_PROMPTS_CACHE)

    def test_expired_matching_signature_renews_cache_without_rereading(self):
        path = self.data_dir / "Category" / "prompt.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps([{"label": "Cached", "prompt": "cached"}]), encoding="utf-8")
        with mock.patch.object(self.routes.time, "monotonic", return_value=0):
            self.assertEqual(self.routes._load_items()[0]["label"], "Cached")
        with mock.patch.object(self.routes, "_read_items", side_effect=AssertionError("must reuse matching cache")):
            with mock.patch.object(self.routes.time, "monotonic", return_value=999):
                self.assertEqual(self.routes._load_items()[0]["label"], "Cached")

    def test_expired_equal_signature_reloads_changed_prompt_content(self):
        path = self.data_dir / "Category" / "prompt.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps([{"label": "Cached", "prompt": "cached"}]), encoding="utf-8")
        original_stat = path.stat()
        with mock.patch.object(self.routes.time, "monotonic", return_value=0):
            self.assertEqual(self.routes._load_items()[0]["label"], "Cached")
        path.write_text(json.dumps([{"label": "Fresh!", "prompt": "fresh!"}]), encoding="utf-8")
        self.assertEqual(path.stat().st_size, original_stat.st_size)
        os.utime(path, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
        with mock.patch.object(self.routes.time, "monotonic", return_value=999):
            self.assertEqual(self.routes._load_items()[0]["label"], "Fresh!")


class RunLifetimeRouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.routes = load_routes(Path(self.temp.name) / "data")
        self.runs = sys.modules[f"{self.routes.__package__}.runs"]
        self.presets = sys.modules[f"{self.routes.__package__}.presets"]
        self.callbacks = sys.modules[f"{self.routes.__package__}.callbacks"]
        self.prepare = self.routes._test_routes[("POST", "/scene_prompt/runs/prepare")]
        self.release = self.routes._test_routes[("POST", "/scene_prompt/runs/release")]
        self.finalize = self.routes._test_routes[("POST", "/scene_prompt/runs/finalize")]
        self.graph = {"output": {
            "1": {"class_type": "ScenePrompter", "inputs": {
                "prompt_name": "Fixture", "positive_base": "fixture", "positive_json": '{"version":1,"categories":{}}',
                "negative_base": "", "negative_json": '{"version":1,"categories":{}}',
                "category_order": "", "seed": 0, "randomize": True,
            }},
            "2": {"class_type": "ScenePrompterExpand", "inputs": {
                "scene_prompt": ["1", 0], "run_id": "continuous",
            }},
        }}

    async def asyncTearDown(self):
        self.assert_no_runs()

    @staticmethod
    def request(payload, user_id="alice"):
        async def json_payload():
            return payload
        return types.SimpleNamespace(user_id=user_id, json=json_payload)

    def assert_no_runs(self):
        self.assertEqual(self.runs.RUN_CONTEXTS._entries, {})
        self.assertEqual(self.presets._RUN_SNAPSHOTS, {})
        self.assertEqual(self.presets._RESOLVING_RUNS, {})

    async def prepare_followup(self):
        response = await self.prepare(self.request({"api_graph": self.graph, "expand_node_id": "2"}))
        self.assertEqual(response["status"], 200, response)
        handle = response["payload"]["run_handle"]
        self.assertEqual(response["payload"]["total_images"], 1)
        self.assertTrue(self.runs.require_run_context(handle)["continuous"])
        self.assertIn(("alice", handle), self.presets._RUN_SNAPSHOTS)
        denied = await self.release(self.request({"run_handle": handle}, "bob"))
        self.assertFalse(denied["payload"]["released"])
        self.assertIn(handle, self.runs.RUN_CONTEXTS._entries)
        self.assertIn(("alice", handle), self.presets._RUN_SNAPSHOTS)
        await self.release(self.request({"run_handle": handle}))
        self.assert_no_runs()

    async def test_prepare_cancelled_before_allocation_keeps_no_state(self):
        entered = asyncio.Event()
        never = asyncio.Event()

        async def blocked_json():
            entered.set()
            await never.wait()

        task = asyncio.create_task(self.prepare(types.SimpleNamespace(user_id="alice", json=blocked_json)))
        await asyncio.wait_for(entered.wait(), 5)
        task.cancel()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assert_no_runs()
        self.assertEqual(self.presets._CANCELLED_RUNS, {})
        await self.prepare_followup()

    async def test_prepare_cancellation_prevents_actual_late_snapshot_publication(self):
        loop = asyncio.get_running_loop()
        for phase in ("resolving", "published"):
            with self.subTest(phase=phase):
                entered = asyncio.Event()
                finished = asyncio.Event()
                resume = threading.Event()
                errors = []
                snapshot = self.routes.snapshot_presets_for_run
                scene_value = self.presets._scene_node_value

                def pause():
                    loop.call_soon_threadsafe(entered.set)
                    self.assertTrue(resume.wait(5), "snapshot worker was not released")

                def blocked_value(*args, **kwargs):
                    pause()
                    return scene_value(*args, **kwargs)

                def observed_snapshot(*args, **kwargs):
                    try:
                        result = snapshot(*args, **kwargs)
                        if phase == "published":
                            pause()
                        return result
                    except self.presets.ScenePresetError as exc:
                        errors.append(str(exc))
                        raise
                    finally:
                        loop.call_soon_threadsafe(finished.set)

                with mock.patch.object(self.routes, "snapshot_presets_for_run", observed_snapshot), \
                     mock.patch.object(self.presets, "_scene_node_value", blocked_value if phase == "resolving" else scene_value):
                    task = asyncio.create_task(self.prepare(self.request({
                        "api_graph": self.graph, "expand_node_id": "2",
                    })))
                    try:
                        await asyncio.wait_for(entered.wait(), 5)
                        handle, = self.runs.RUN_CONTEXTS._entries
                        key = ("alice", handle)
                        self.assertTrue(self.runs.require_run_context(handle)["continuous"])
                        if phase == "published":
                            self.assertIn(key, self.presets._RUN_SNAPSHOTS)
                        else:
                            self.assertEqual(self.presets._RESOLVING_RUNS, {key: 1})
                        task.cancel()
                        task.cancel()
                        with self.assertRaises(asyncio.CancelledError):
                            await task
                        self.assertFalse(task.cancel())
                        self.assertEqual(self.runs.RUN_CONTEXTS._entries, {})
                        self.assertEqual(self.presets._RUN_SNAPSHOTS, {})
                        self.assertIn(key, self.presets._CANCELLED_RUNS)
                    finally:
                        resume.set()
                        await asyncio.wait_for(finished.wait(), 5)
                    self.assertEqual(bool(errors), phase == "resolving")
                self.assert_no_runs()
                await self.prepare_followup()

    async def test_prepare_resolution_failure_keeps_node_error_and_releases_state(self):
        graph = {"output": {
            "1": {"class_type": "ScenePresetReference", "inputs": {"preset_id": "missing"}},
            "2": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["1", 0]}},
        }}
        response = await self.prepare(self.request({"api_graph": graph, "expand_node_id": "2"}))
        self.assertEqual(response["status"], 400)
        self.assertEqual(response["payload"]["node_id"], "1")
        self.assert_no_runs()
        await self.prepare_followup()

    def callback_run(self, failure_mode, prompt_id="prompt-1"):
        handle = self.runs.create_run_context("alice", continuous=True)
        self.assertTrue(self.runs.claim_run_context(handle, "alice", prompt_id))
        self.assertTrue(self.runs.register_last_callback(
            handle, "2", {"kind": "webhook"}, {"prompt_id": prompt_id}, 5,
            failure_mode, prompt_id, {"user_id": "alice", "client_id": "client"},
        ))
        self.routes.PromptServer.instance.prompt_queue = types.SimpleNamespace(
            get_history=lambda prompt_id: {prompt_id: {"status": {"status_str": "success", "completed": True}}},
        )
        return handle, {"run_handle": handle, "expand_node_id": "2", "prompt_id": prompt_id}

    def callback_state(self, handle):
        return self.runs.require_run_context(handle)["last_callbacks"]["2"]["state"]

    async def test_finalize_rejects_incomplete_failed_and_foreign_requests_before_dispatch(self):
        handle, payload = self.callback_run(self.callbacks.CALLBACK_FAILURE_STOP)
        with mock.patch.object(self.routes, "dispatch_callback") as dispatch:
            for status, completed, expected_state, expected_status in (
                (None, False, "pending", 202), ("error", True, "not_success", 409),
            ):
                with self.subTest(status=status):
                    self.routes.PromptServer.instance.prompt_queue = types.SimpleNamespace(
                        get_history=lambda prompt_id: {prompt_id: {"status": {"status_str": status, "completed": completed}}},
                    )
                    result = await self.finalize(self.request(payload))
                    self.assertEqual(result, {"payload": {"state": expected_state}, "status": expected_status})
                    self.assertEqual(self.callback_state(handle), "pending")
            self.routes.PromptServer.instance.prompt_queue = types.SimpleNamespace(
                get_history=lambda prompt_id: {prompt_id: {"status": {"status_str": "success", "completed": True}}},
            )
            for request, expected in (
                (self.request(payload, "bob"), "missing"),
                (self.request({**payload, "prompt_id": "wrong"}), "wrong_prompt"),
            ):
                result = await self.finalize(request)
                self.assertEqual(result, {"payload": {"state": expected}, "status": 409})
                self.assertEqual(self.callback_state(handle), "pending")
            dispatch.assert_not_called()
        await self.release(self.request({"run_handle": handle}))

    async def test_finalize_normal_outcomes_transition_in_dispatch_thread(self):
        outcomes = (
            (None, self.callbacks.CALLBACK_FAILURE_STOP, "finalized", 200),
            (self.routes.SceneCallbackError("fixture failure"), self.callbacks.CALLBACK_FAILURE_CONTINUE, "finalized", 200),
            (self.routes.SceneCallbackError("fixture failure"), self.callbacks.CALLBACK_FAILURE_STOP, "failed", 502),
            (RuntimeError("unexpected worker failure"), self.callbacks.CALLBACK_FAILURE_CONTINUE, "failed", 400),
        )
        for error, mode, state, status in outcomes:
            with self.subTest(error=error, mode=mode):
                handle, payload = self.callback_run(mode)
                threads = []
                finish = self.routes.finish_last_callback

                def dispatch(*args, **kwargs):
                    threads.append(threading.get_ident())
                    self.assertEqual(kwargs["desktop_context"], {"user_id": "alice", "client_id": "client"})
                    if error:
                        raise error

                def record_finish(*args):
                    threads.append(threading.get_ident())
                    return finish(*args)

                with mock.patch.object(self.routes, "dispatch_callback", side_effect=dispatch) as calls, \
                     mock.patch.object(self.routes, "finish_last_callback", side_effect=record_finish):
                    result = await self.finalize(self.request(payload))
                    self.assertEqual(result["status"], status, result)
                    if isinstance(error, self.routes.SceneCallbackError) and state == "finalized":
                        self.assertEqual(result["payload"]["warning"], str(error))
                    self.assertEqual(self.callback_state(handle), state)
                    again = await self.finalize(self.request(payload))
                    self.assertEqual(again["status"], 200 if state == "finalized" else 502)
                    calls.assert_called_once()
                self.assertEqual(len(threads), 2)
                self.assertEqual(threads[0], threads[1])
                self.assertNotEqual(threads[0], threading.get_ident())
                await self.release(self.request({"run_handle": handle}))

    async def test_finalize_cancelled_dispatch_settles_success_and_failures_once(self):
        loop = asyncio.get_running_loop()
        outcomes = (
            (None, self.callbacks.CALLBACK_FAILURE_STOP, "finalized"),
            (self.routes.SceneCallbackError("fixture failure"), self.callbacks.CALLBACK_FAILURE_CONTINUE, "finalized"),
            (self.routes.SceneCallbackError("fixture failure"), self.callbacks.CALLBACK_FAILURE_STOP, "failed"),
            (RuntimeError("unexpected worker failure"), self.callbacks.CALLBACK_FAILURE_CONTINUE, "failed"),
        )
        for error, mode, state in outcomes:
            with self.subTest(error=error, mode=mode):
                handle, payload = self.callback_run(mode)
                entered = asyncio.Event()
                resume = threading.Event()
                dispatched = []

                def dispatch(_config, values, _timeout, **_kwargs):
                    dispatched.append(values["prompt_id"])
                    if values["prompt_id"] == "prompt-1":
                        loop.call_soon_threadsafe(entered.set)
                        self.assertTrue(resume.wait(5), "callback worker was not released")
                        if error:
                            raise error

                with mock.patch.object(self.routes, "dispatch_callback", side_effect=dispatch):
                    task = asyncio.create_task(self.finalize(self.request(payload)))
                    try:
                        await asyncio.wait_for(entered.wait(), 5)
                        for _ in range(2):
                            task.cancel()
                            await asyncio.sleep(0)
                            self.assertFalse(task.done())
                            self.assertEqual(self.callback_state(handle), "in_progress")
                        duplicate = await self.finalize(self.request(payload))
                        self.assertEqual(duplicate, {"payload": {"state": "in_progress"}, "status": 202})
                        foreign = await self.finalize(self.request(payload, "bob"))
                        self.assertEqual(foreign, {"payload": {"state": "missing"}, "status": 409})
                        wrong = await self.finalize(self.request({**payload, "prompt_id": "other"}))
                        self.assertEqual(wrong, {"payload": {"state": "wrong_prompt"}, "status": 409})
                        next_handle, next_payload = self.callback_run(mode, "next-prompt")
                        next_result = await self.finalize(self.request(next_payload))
                        self.assertEqual(next_result["payload"]["state"], "finalized")
                        await self.release(self.request({"run_handle": next_handle}))
                    finally:
                        resume.set()
                    with self.assertRaises(asyncio.CancelledError):
                        await asyncio.wait_for(task, 5)
                    self.assertEqual(self.callback_state(handle), state)
                    again = await self.finalize(self.request(payload))
                    self.assertEqual(again["status"], 200 if state == "finalized" else 502)
                    self.assertEqual(dispatched, ["prompt-1", "next-prompt"])
                await self.release(self.request({"run_handle": handle}))

    async def test_finalize_cancelled_while_executor_queued_retains_work_and_followup(self):
        loop = asyncio.get_running_loop()
        entered = asyncio.Event()
        submitted = {2: asyncio.Event(), 3: asyncio.Event()}
        resume = threading.Event()

        class NotifyingExecutor(ThreadPoolExecutor):
            def __init__(self):
                super().__init__(max_workers=1)
                self.submissions = 0

            def submit(self, *args, **kwargs):
                result = super().submit(*args, **kwargs)
                self.submissions += 1
                if self.submissions in submitted:
                    submitted[self.submissions].set()
                return result

        loop.set_default_executor(NotifyingExecutor())

        def occupy_executor():
            loop.call_soon_threadsafe(entered.set)
            self.assertTrue(resume.wait(5), "executor blocker was not released")

        blocker = loop.run_in_executor(None, occupy_executor)
        await asyncio.wait_for(entered.wait(), 5)
        handle, payload = self.callback_run(self.callbacks.CALLBACK_FAILURE_STOP)
        next_handle, next_payload = self.callback_run(self.callbacks.CALLBACK_FAILURE_STOP, "next-prompt")
        dispatched = []
        with mock.patch.object(self.routes, "dispatch_callback", side_effect=lambda _config, values, *_args, **_kwargs: dispatched.append(values["prompt_id"])):
            task = asyncio.create_task(self.finalize(self.request(payload)))
            try:
                await asyncio.wait_for(submitted[2].wait(), 5)
                for _ in range(2):
                    task.cancel()
                    await asyncio.sleep(0)
                    self.assertFalse(task.done())
                self.assertEqual(self.callback_state(handle), "in_progress")
                self.assertEqual(dispatched, [])
                duplicate = await self.finalize(self.request(payload))
                self.assertEqual(duplicate["status"], 202)
                followup = asyncio.create_task(self.finalize(self.request(next_payload)))
                await asyncio.wait_for(submitted[3].wait(), 5)
                self.assertFalse(followup.done())
            finally:
                resume.set()
                await asyncio.wait_for(blocker, 5)
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, 5)
            self.assertEqual((await asyncio.wait_for(followup, 5))["payload"]["state"], "finalized")
            self.assertEqual(dispatched, ["prompt-1", "next-prompt"])
            self.assertEqual(self.callback_state(handle), "finalized")
            self.assertEqual(self.callback_state(next_handle), "finalized")
        await self.release(self.request({"run_handle": handle}))
        await self.release(self.request({"run_handle": next_handle}))


if __name__ == "__main__":
    unittest.main()
