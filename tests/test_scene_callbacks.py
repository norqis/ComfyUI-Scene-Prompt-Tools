import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scene_prompt_tools.callbacks import (
    SceneCallbackError,
    dispatch_callback,
    discord_callback,
    request_callback,
)
from scene_prompt_tools.plan import append_callback, empty_row, make_plan, merge, with_source_node
from scene_prompt_tools.runs import RunContextStore


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


if __name__ == "__main__":
    unittest.main()
