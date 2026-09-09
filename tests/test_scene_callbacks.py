import json
import importlib
import sys
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from scene_prompt_tools.callbacks import (
    SceneCallbackError,
    acknowledge_desktop_callback,
    desktop_callback,
    dispatch_callback,
    discord_callback,
    request_callback,
)
from scene_prompt_tools.plan import append_callback, empty_row, make_plan, merge, with_source_node
from scene_prompt_tools.runs import RunContextStore
from comfy_stubs import install_comfy_execution_stub, install_torch_stub


def _nodes_module():
    install_comfy_execution_stub()
    torch = install_torch_stub()
    comfy = types.ModuleType("comfy")
    management = types.ModuleType("comfy.model_management")
    management.intermediate_device = lambda: "cpu"
    management.intermediate_dtype = lambda: torch.float32
    cli_args = types.ModuleType("comfy.cli_args")
    cli_args.args = types.SimpleNamespace(disable_metadata=False)
    comfy.model_management = management
    folder_paths = types.ModuleType("folder_paths")
    folder_paths.get_output_directory = lambda: "."
    folder_paths.get_user_directory = lambda: "."
    folder_paths.get_public_user_directory = lambda _user_id: "."
    sys.modules.update({
        "comfy": comfy,
        "comfy.model_management": management,
        "comfy.cli_args": cli_args,
        "folder_paths": folder_paths,
    })
    return importlib.import_module("scene_prompt_tools.nodes")


class _Handler(BaseHTTPRequestHandler):
    received = []

    def log_message(self, *_args):
        pass

    def do_GET(self):
        type(self).received.append(("GET", self.path, dict(self.headers), b""))
        self.send_response(204)
        self.end_headers()

    def do_POST(self):
        size = int(self.headers.get("Content-Length", 0))
        type(self).received.append(("POST", self.path, dict(self.headers), self.rfile.read(size)))
        self.send_response(500 if self.path == "/failed" else 204)
        self.end_headers()


class SceneCallbackTests(unittest.TestCase):
    def setUp(self):
        _Handler.received = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()

    def test_producers_only_return_settings(self):
        self.assertEqual(discord_callback("https://example.invalid", "hello")[0]["kind"], "discord")
        self.assertEqual(request_callback("POST", "https://example.invalid", "x", "text")[0]["kind"], "request")
        self.assertEqual(desktop_callback("Title", "hello")[0], {"kind": "desktop", "title": "Title", "text": "hello"})

    def test_desktop_callback_targets_only_its_prepared_client_and_accepts_early_ack(self):
        sent = []

        class Prompt:
            def send_sync(self, event, payload, *, sid=None):
                sent.append((event, payload, sid))
                acknowledge_desktop_callback(payload["request_id"], "alice", True)

        server = types.ModuleType("server")
        server.PromptServer = types.SimpleNamespace(instance=Prompt())
        previous = sys.modules.get("server")
        sys.modules["server"] = server
        try:
            dispatch_callback(
                desktop_callback("Run {exec_current_count}", "{all_positive}")[0],
                {"exec_current_count": 2, "all_positive": "ready"},
                3,
                desktop_context={"client_id": "only-this-client", "user_id": "alice"},
            )
        finally:
            if previous is None:
                sys.modules.pop("server", None)
            else:
                sys.modules["server"] = previous
        self.assertEqual(sent[0][0], "scene_prompt_desktop_notification")
        self.assertEqual(sent[0][2], "only-this-client")
        self.assertEqual({key: value for key, value in sent[0][1].items() if key != "request_id"}, {"title": "Run 2", "text": "ready", "timeout_seconds": 3})

    def test_desktop_ack_rejects_wrong_user_duplicate_and_failure(self):
        sent = []
        delivered = threading.Event()

        class Prompt:
            def send_sync(self, _event, payload, *, sid=None):
                sent.append((payload, sid))
                delivered.set()

        server = types.ModuleType("server")
        server.PromptServer = types.SimpleNamespace(instance=Prompt())
        previous = sys.modules.get("server")
        sys.modules["server"] = server
        failures = []
        worker = threading.Thread(
            target=lambda: failures.append(self._desktop_dispatch_failure()), daemon=True
        )
        try:
            worker.start()
            self.assertTrue(delivered.wait(1))
            request_id = sent[0][0]["request_id"]
            self.assertEqual(acknowledge_desktop_callback(request_id, "bob", False, "permission_denied"), "forbidden")
            self.assertEqual(acknowledge_desktop_callback(request_id, "alice", False, "permission_denied"), "acknowledged")
            self.assertEqual(acknowledge_desktop_callback(request_id, "alice", False, "permission_denied"), "missing")
            worker.join(3)
        finally:
            if previous is None:
                sys.modules.pop("server", None)
            else:
                sys.modules["server"] = previous
        self.assertEqual(failures, ["Desktop callback failed: permission_denied."])

    @staticmethod
    def _desktop_dispatch_failure():
        try:
            dispatch_callback(
                desktop_callback("", "")[0], {}, 3,
                desktop_context={"client_id": "client", "user_id": "alice"},
            )
        except SceneCallbackError as exc:
            return str(exc)
        return "unexpected success"

    def test_desktop_timeout_cleans_pending_request(self):
        sent = []

        class Prompt:
            def send_sync(self, _event, payload, *, sid=None):
                sent.append((payload, sid))

        server = types.ModuleType("server")
        server.PromptServer = types.SimpleNamespace(instance=Prompt())
        previous = sys.modules.get("server")
        sys.modules["server"] = server
        try:
            with self.assertRaisesRegex(SceneCallbackError, "timeout"):
                dispatch_callback(desktop_callback("", "")[0], {}, 1, desktop_context={"client_id": "client", "user_id": "alice"})
        finally:
            if previous is None:
                sys.modules.pop("server", None)
            else:
                sys.modules["server"] = previous
        self.assertEqual(acknowledge_desktop_callback(sent[0][0]["request_id"], "alice", True), "missing")

    def test_desktop_missing_client_fails_only_when_dispatched(self):
        config = desktop_callback("", "")[0]
        with self.assertRaisesRegex(SceneCallbackError, "unavailable"):
            dispatch_callback(config, {}, 3)

    def test_get_keeps_fixed_query_and_has_no_body(self):
        config = request_callback("GET", self.base_url + "/check?fixed=yes&name={exec_model}", headers_json='{"X-Scene":"{exec_seed}"}')[0]
        dispatch_callback(config, {"exec_model": "Illustrious", "exec_seed": 12}, 3)
        method, path, headers, body = _Handler.received.pop()
        self.assertEqual((method, path, body), ("GET", "/check?fixed=yes&name=Illustrious", b""))
        self.assertEqual(headers["X-Scene"], "12")

    def test_post_json_replaces_after_parsing(self):
        config = request_callback("POST", self.base_url + "/json", '{"prompt":"{all_positive}"}', "json")[0]
        dispatch_callback(config, {"all_positive": 'quote " and\nnewline'}, 3)
        method, _path, headers, body = _Handler.received.pop()
        self.assertEqual(method, "POST")
        self.assertEqual(headers["Content-Type"], "application/json; charset=utf-8")
        self.assertEqual(json.loads(body), {"prompt": 'quote " and\nnewline'})

    def test_existing_lowercase_content_type_is_preserved(self):
        config = request_callback("POST", self.base_url + "/text", "body", "text", '{"content-type":"custom/type"}')[0]
        dispatch_callback(config, {}, 3)
        self.assertEqual(_Handler.received.pop()[2]["Content-Type"], "custom/type")

    def test_discord_wait_true_replaces_existing_value(self):
        config = discord_callback(self.base_url + "/discord?wait=false", "hello")[0]
        dispatch_callback(config, {}, 3)
        method, path, _headers, body = _Handler.received.pop()
        self.assertEqual((method, path), ("POST", "/discord?wait=true"))
        self.assertEqual(json.loads(body), {"content": "hello"})

    def test_invalid_request_is_a_callback_error(self):
        config = request_callback("POST", "", "x", "text")[0]
        with self.assertRaises(SceneCallbackError):
            dispatch_callback(config, {}, 3)

    def test_http_failure_and_timeout_are_callback_errors(self):
        config = request_callback("POST", self.base_url + "/failed", "x")[0]
        with self.assertRaises(SceneCallbackError):
            dispatch_callback(config, {}, 3)
        config = request_callback("GET", self.base_url + "/timeout")[0]
        with mock.patch("scene_prompt_tools.callbacks.urlopen", side_effect=OSError("timeout")) as open_request:
            with self.assertRaises(SceneCallbackError):
                dispatch_callback(config, {}, 7)
        self.assertEqual(open_request.call_args.kwargs["timeout"], 7)

    def test_callback_snapshot_and_merge_deduplicate_shared_node(self):
        row = {**empty_row(), "positive_parts": ["first"]}
        base = with_source_node(make_plan([{"row": row, "count": 1}]), "p", "Prompt")
        callback = append_callback(base, "callback", {"kind": "request"}, "毎回", 10, "続行")
        merged = merge(callback, callback)
        descriptor = merged["rows"][0]["row"]["callbacks"]
        self.assertEqual(len(descriptor), 1)
        self.assertEqual(descriptor[0]["current_source_node_ids"], ["p"])

    def test_once_claim_is_atomic_and_resets_with_new_run(self):
        store = RunContextStore()
        first = store.create("user")
        self.assertTrue(store.claim_callback_attempt(first, "callback"))
        self.assertFalse(store.claim_callback_attempt(first, "callback"))
        self.assertTrue(store.claim_callback_attempt(store.create("user"), "callback"))

    def test_cached_metadata_keeps_current_iteration_inputs(self):
        nodes = _nodes_module()
        cached = {
            "expand": {"class_type": "ScenePrompterExpand", "inputs": {"scene_prompt": ["callback", 0], "current_index": 0, "seed_base": 10}},
            "callback": {"class_type": "ScenePromptCallback", "inputs": {"scene_prompt": ["prompt", 0]}},
        }
        current = {"expand": {"class_type": "ScenePrompterExpand", "inputs": {"current_index": 3, "seed_base": 13}}}
        merged = nodes._merge_cached_prompt(cached, current)
        self.assertEqual(merged["expand"]["inputs"], {"scene_prompt": ["callback", 0], "current_index": 3, "seed_base": 13})
        self.assertEqual(cached["expand"]["inputs"]["current_index"], 0)

    def test_noop_callback_keeps_its_source_id_but_not_a_name(self):
        nodes = _nodes_module()
        plan = nodes.ScenePromptCallback().apply_callback(scene_prompt=None, unique_id="callback")[0]
        row = plan["rows"][0]["row"]
        self.assertEqual(row["source_node_ids"], ["callback"])
        self.assertEqual(row["source_node_names"], {})

    def test_queue_late_first_and_snapshot_values(self):
        nodes = _nodes_module()
        store = RunContextStore()
        handle = store.create("user")
        first = with_source_node(make_plan([{"row": empty_row(), "count": 1}]), "first", "First")
        second = append_callback(
            with_source_node(make_plan([{"row": {**empty_row(), "positive_parts": ["before"], "negative_parts": ["no"]}, "count": 1}]), "second", "Second"),
            "late", {"kind": "request"}, "初回", 10, "停止",
        )
        plan = merge(first, second)
        calls = []
        with mock.patch.object(nodes, "claim_callback_attempt", side_effect=lambda _handle, callback_id: store.claim_callback_attempt(handle, callback_id)), mock.patch.object(nodes, "dispatch_callback", side_effect=lambda _config, values, _timeout, **_kwargs: calls.append(values)):
            nodes._dispatch_row_callbacks(plan["rows"][0]["row"], {"global_index": 1, "total_batches": 2}, 17, "Illustrious", handle, "before", "no")
            nodes._dispatch_row_callbacks(plan["rows"][0]["row"], {"global_index": 1, "total_batches": 2}, 17, "Illustrious", handle, "before", "no")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["current_positive"], "before")
        self.assertEqual(calls[0]["all_node_names"], "First_Second")

    def test_callback_failures_do_not_reach_latent_and_continue_runs_next(self):
        nodes = _nodes_module()
        base = make_plan([{"row": {**empty_row(), "positive_parts": ["prompt"]}, "count": 1}])
        stop_plan = append_callback(base, "stop", {"kind": "request"}, "毎回", 10, "停止")
        events = []
        with mock.patch.object(nodes, "dispatch_callback", side_effect=nodes.SceneCallbackError("failed")), mock.patch.object(nodes, "_empty_latent", side_effect=lambda _value: events.append("latent")):
            with self.assertRaises(RuntimeError):
                nodes.ScenePromptExpand().expand(scene_prompt=stop_plan, timestamp_dir=False)
        self.assertEqual(events, [])
        continue_plan = append_callback(append_callback(base, "continue", {"kind": "request"}, "毎回", 10, "続行"), "next", {"kind": "request"}, "毎回", 10, "停止")
        sent = []
        with mock.patch.object(nodes, "dispatch_callback", side_effect=[nodes.SceneCallbackError("failed"), lambda *_args: None]) as dispatch, mock.patch.object(nodes, "_empty_latent", return_value="latent"):
            nodes.ScenePromptExpand().expand(scene_prompt=continue_plan, timestamp_dir=False)
        self.assertEqual(dispatch.call_count, 2)


if __name__ == "__main__":
    unittest.main()
