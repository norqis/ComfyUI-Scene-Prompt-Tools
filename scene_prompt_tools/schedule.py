"""Lazy, immutable generation schedules for Scene Prompt plans.

The public workflow stores node inputs, never these process-local plans.  A
schedule keeps one copy of each distinct row even when Count describes many
millions of executions.
"""

from __future__ import annotations

import bisect
import copy
import hashlib
import json

from . import plan as _old


ScenePlan = _old.ScenePlan
ScenePlanError = _old.ScenePlanError
MAX_SAFE_INTEGER = _old.MAX_SAFE_INTEGER
SCENE_PROMPT_TYPE = _old.SCENE_PROMPT_TYPE
MAX_SCHEDULE_DEPTH = 256
PLAN_VERSION = 7
PLAN_KEYS = {"type", "version", "units", "sources", "contains_queue_boundary", "random_guards", "stats", "change_key"}
STATS_KEYS = {"total_batches", "total_images", "unset_batches", "row_count"}
UNIT_KEYS = {
    "run": {"row", "count"},
    "sequence": {"plan"},
    "alternate": {"inputs", "block_size"},
    "repeat": {"unit", "factor"},
    "repeat_each": {"unit", "factor"},
    "count_fixed": {"unit"},
    "count_hold": {"unit"},
    "count_scale": {"unit", "factor"},
    "matrix_map": {"unit", "matrix_rows"},
    "product": {"left", "right"},
    "map": {"unit", "operations"},
    "random_choice": {"gate_id", "weights", "inputs", "selected_arm"},
}
OPERATION_KINDS = {
    "prompt_add", "path_add", "reverse", "delete", "model_set", "lora_add",
    "prompt_passthrough", "prompt_whole", "source_node", "callback", "latent_set",
}


class ScheduleUnit(dict):
    """Unit with a process-local digest; its serialized fields remain exact."""

    def __init__(self, data):
        super().__init__(data)
        kind = data["kind"]
        if kind == "run":
            self.depth = 0
        elif kind in {"sequence"}:
            self.depth = 1 + data["plan"].depth
        elif kind in {"alternate", "random_choice"}:
            self.depth = 1 + max((plan.depth for plan in data["inputs"]), default=0)
        elif kind == "product":
            self.depth = 1 + max(data["left"].depth, data["right"].depth)
        else:
            self.depth = 1 + data["unit"].depth
        self.has_count_hold = kind == "count_hold" or (
            data["plan"].has_count_hold if kind == "sequence" else
            any(plan.has_count_hold for plan in data["inputs"]) if kind in {"alternate", "random_choice"} else
            data["left"].has_count_hold or data["right"].has_count_hold if kind == "product" else
            data["unit"].has_count_hold if "unit" in data else False)
        self.digest = _fingerprint(data)

    @property
    def count_policy(self):
        if not hasattr(self, "_count_policy"):
            self._count_policy = _unit_policy(self)
        return self._count_policy


def _safe(value, label="Scene Prompt total"):
    if type(value) is not int or value < 0 or value > MAX_SAFE_INTEGER:
        raise ScenePlanError(f"{label} exceeds JavaScript's safe integer range.")
    return value


def _stats(batches=0, images=0, unset=0, rows=0):
    return {
        "total_batches": _safe(batches),
        "total_images": _safe(images),
        "unset_batches": _safe(unset),
        "row_count": _safe(rows),
    }


def _sum_stats(parts):
    result = _stats()
    for part in parts:
        for key in STATS_KEYS:
            result[key] = _safe(result[key] + part[key])
    return result


def _fingerprint(value):
    def public(value, root=False):
        if isinstance(value, ScheduleUnit) and not root:
            return {"unit_digest": value.digest}
        if isinstance(value, ScenePlan) and not root:
            return {"plan_change_key": value["change_key"]}
        if isinstance(value, dict):
            return {key: public(item) for key, item in value.items() if key != "change_key"}
        if isinstance(value, (list, tuple)):
            return [public(item) for item in value]
        return value
    payload = json.dumps(public(value, root=True), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "scene-prompt:v7:" + hashlib.blake2b(payload.encode("utf-8"), digest_size=16).hexdigest()


def _unit(kind, **values):
    if kind == "matrix_map":
        values["matrix_rows"] = _clone_matrix_rows(values["matrix_rows"])
    elif kind == "map":
        values["operations"] = [_clone_operation(operation) for operation in values["operations"]]
    data = {"kind": kind, **values}
    data["stats"] = _unit_stats(data)
    return ScheduleUnit(data)


def _unit_stats(unit):
    kind = unit["kind"]
    if kind == "run":
        count = _old._require_int(unit["count"], "Scene Prompt plan count", 0, MAX_SAFE_INTEGER)
        latent = unit["row"].get("latent")
        batch_size = latent["batch_size"] if latent else 1
        return _stats(count, _safe(count * batch_size), 0 if latent else count, 1)
    if kind == "sequence":
        return dict(unit["plan"]["stats"])
    if kind == "alternate":
        return _sum_stats(plan["stats"] for plan in unit["inputs"])
    if kind == "random_choice":
        arms = unit["inputs"]
        selected = unit["selected_arm"]
        if selected is not None:
            return dict(arms[selected]["stats"])
        active = [arm["stats"] for arm, weight in zip(arms, unit["weights"]) if weight]
        if not active or any(stats != active[0] for stats in active[1:]):
            raise ScenePlanError("Scene Prompt Random Route の各経路の生成件数が一致しません。")
        return dict(active[0])
    if kind in {"repeat", "repeat_each"}:
        stats = unit["unit"]["stats"]
        factor = _old._require_int(unit["factor"], "Scene Prompt repeat factor",
                                   1 if kind == "repeat_each" else 0, MAX_SAFE_INTEGER)
        return _stats(*(_safe(stats[key] * factor) for key in ("total_batches", "total_images", "unset_batches")), stats["row_count"])
    if kind in {"count_fixed", "count_hold"}:
        return dict(unit["unit"]["stats"])
    if kind == "count_scale":
        factor = _old._require_int(unit["factor"], "Scene Prompt count factor", 0, MAX_SAFE_INTEGER)
        child = unit["unit"]
        stats = child["stats"]
        projection = child.count_policy[0 if factor == 0 else 2]
        if any(value is None for value in projection) and factor != 1:
            raise ScenePlanError("Scene Prompt Random Route の各経路のCount適用後の生成件数が一致しません。")
        values = tuple(stats[key] for key in _POLICY_KEYS) if factor == 1 else projection if factor == 0 else tuple(
            stats[key] + (factor - 1) * value for key, value in zip(_POLICY_KEYS, projection))
        return _stats(*values, stats["row_count"])
    if kind == "matrix_map":
        stats = unit["unit"]["stats"]
        length = len(unit["matrix_rows"])
        return _stats(*(_safe(stats[key] * length) for key in ("total_batches", "total_images", "unset_batches", "row_count")))
    if kind == "product":
        left, right = unit["left"]["stats"], unit["right"]["stats"]
        lb, li, lu, lr = (left[key] for key in ("total_batches", "total_images", "unset_batches", "row_count"))
        rb, ri, ru, rr = (right[key] for key in ("total_batches", "total_images", "unset_batches", "row_count"))
        return _stats(_safe(lb * rb), _safe(lb * (ri - ru) + li * ru), _safe(lu * ru), _safe(lr * rr))
    if kind == "map":
        stats = dict(unit["unit"]["stats"])
        for operation in unit["operations"]:
            if operation["kind"] == "latent_set":
                stats["total_images"] = _safe(stats["total_batches"] * operation["payload"]["batch_size"])
                stats["unset_batches"] = 0
        return stats
    raise ScenePlanError("Unsupported Scene Prompt schedule unit.")


_POLICY_KEYS = ("total_batches", "total_images", "unset_batches")
_POLICY_ZERO = (0, 0, 0)


def _policy_add(first, second):
    return tuple(None if a is None or b is None else a + b for a, b in zip(first, second))


def _policy_sub(first, second):
    return tuple(None if a is None or b is None else a - b for a, b in zip(first, second))


def _policy_product(first, second):
    if first == _POLICY_ZERO or second == _POLICY_ZERO:
        return _POLICY_ZERO
    def multiply(a, b):
        return 0 if a == 0 or b == 0 else None if a is None or b is None else a * b

    lb, li, lu = first
    rb, ri, ru = second
    own_images = multiply(lb, None if ri is None or ru is None else ri - ru)
    inherited_images = multiply(li, ru)
    images = None if own_images is None or inherited_images is None else own_images + inherited_images
    return multiply(lb, rb), images, multiply(lu, ru)


def _plan_policy(plan):
    result = [_POLICY_ZERO] * 3
    for unit in plan["units"]:
        result = [_policy_add(first, second) for first, second in zip(result, unit.count_policy)]
    return tuple(result)


def _unit_policy(unit):
    """Strict, legacy-fixed and free statistics, with unknown Random components."""
    kind = unit["kind"]
    total = tuple(unit["stats"][key] for key in _POLICY_KEYS)
    if kind == "run":
        return _POLICY_ZERO, _POLICY_ZERO, total
    if kind == "sequence":
        return _plan_policy(unit["plan"])
    if kind == "alternate":
        parts = [_plan_policy(plan) for plan in unit["inputs"]]
        return tuple(_policy_sum(part[index] for part in parts) for index in range(3))
    if kind == "random_choice":
        selected = unit["selected_arm"]
        parts = [_plan_policy(unit["inputs"][selected])] if selected is not None else [
            _plan_policy(plan) for plan, weight in zip(unit["inputs"], unit["weights"]) if weight]
        return tuple(tuple(parts[0][index][metric] if all(part[index][metric] == parts[0][index][metric] for part in parts)
                           else None for metric in range(3)) for index in range(3))
    if kind == "product":
        left, right = _plan_policy(unit["left"]), _plan_policy(unit["right"])
        free = _policy_product(left[2], right[2])
        nonstrict = _policy_product(_policy_sub(tuple(unit["left"]["stats"][key] for key in _POLICY_KEYS), left[0]),
                                   _policy_sub(tuple(unit["right"]["stats"][key] for key in _POLICY_KEYS), right[0]))
        return _policy_sub(total, nonstrict), _policy_sub(nonstrict, free), free
    if kind == "count_hold":
        return total, _POLICY_ZERO, _POLICY_ZERO
    child = unit["unit"].count_policy
    if kind == "count_fixed":
        return child[0], _policy_sub(total, child[0]), _POLICY_ZERO
    if kind == "count_scale":
        if unit["factor"] == 0:
            return child[0], _POLICY_ZERO, _POLICY_ZERO
        free = tuple(None if value is None else value * unit["factor"] for value in child[2])
        return child[0], child[1], free
    if kind in {"repeat", "repeat_each", "matrix_map"}:
        factor = len(unit["matrix_rows"]) if kind == "matrix_map" else unit["factor"]
        return tuple(_POLICY_ZERO if factor == 0 else tuple(None if value is None else value * factor for value in part)
                     for part in child)
    if kind == "map":
        for operation in unit["operations"]:
            if operation["kind"] == "latent_set":
                size = operation["payload"]["batch_size"]
                child = tuple((part[0], None if part[0] is None else part[0] * size, 0) for part in child)
        return child
    raise ScenePlanError("Unsupported Scene Prompt Count policy unit.")


def _policy_sum(parts):
    result = _POLICY_ZERO
    for part in parts:
        result = _policy_add(result, part)
    return result


def _plan(units, sources=None, boundary=False, guards=()):
    units = list(units)
    depth = max((1 + unit.depth for unit in units), default=0)
    if depth > MAX_SCHEDULE_DEPTH:
        raise ScenePlanError("Scene Prompt schedule exceeds maximum depth.")
    data = ScenePlan({
        "type": SCENE_PROMPT_TYPE,
        "version": PLAN_VERSION,
        "units": units,
        "sources": _old._clone_sources([] if sources is None else sources),
        "contains_queue_boundary": bool(boundary),
        "random_guards": [copy.deepcopy(guard) for guard in guards],
        "stats": _sum_stats(unit["stats"] for unit in units),
    })
    data.depth = depth
    data.has_count_hold = any(unit.has_count_hold for unit in units)
    data.batch_prefix = []
    data.row_prefix = []
    batches = rows = 0
    for unit in units:
        batches += unit["stats"]["total_batches"]
        rows += unit["stats"]["row_count"]
        data.batch_prefix.append(_safe(batches))
        data.row_prefix.append(_safe(rows))
    data["change_key"] = _fingerprint(data)
    return data


def make_plan(rows, *, sources=None):
    if not isinstance(rows, list):
        raise ScenePlanError("Scene Prompt plan rows must be a list.")
    units = []
    for item in rows:
        if not isinstance(item, dict):
            raise ScenePlanError("Scene Prompt plan items must be objects.")
        _old._require_exact_keys(item, _old.PLAN_BUILD_ITEM_KEYS, "Scene Prompt plan item")
        units.append(_unit("run", row=_old._clone_row(item["row"]), count=item["count"]))
    return _plan(units, sources)


def seed_plan():
    return make_plan([{"row": _old.empty_row(), "count": 1}])


def _validate_plan(value, depth=0, ancestors=None):
    if depth > MAX_SCHEDULE_DEPTH:
        raise ScenePlanError("Scene Prompt schedule exceeds maximum depth.")
    if not isinstance(value, dict):
        raise ScenePlanError("A Scene Prompt input must receive a current Scene Prompt plan.")
    _old._require_exact_keys(value, PLAN_KEYS, "Scene Prompt plan")
    if value["type"] != SCENE_PROMPT_TYPE or value["version"] != PLAN_VERSION:
        raise ScenePlanError("Unsupported Scene Prompt plan version.")
    if type(value["contains_queue_boundary"]) is not bool or not isinstance(value["units"], list):
        raise ScenePlanError("Scene Prompt schedule is invalid.")
    _validate_stats(value["stats"])
    if not isinstance(value["change_key"], str):
        raise ScenePlanError("Scene Prompt schedule fingerprint is invalid.")
    ancestors = set() if ancestors is None else ancestors
    if id(value) in ancestors:
        raise ScenePlanError("Scene Prompt schedule contains a cycle.")
    ancestors.add(id(value))
    units = [_validate_unit(unit, depth + 1, ancestors) for unit in value["units"]]
    ancestors.remove(id(value))
    guards = _validate_guards(value["random_guards"])
    expected = _plan(units, value["sources"], value["contains_queue_boundary"], guards)
    if value["stats"] != expected["stats"] or value["change_key"] != expected["change_key"]:
        raise ScenePlanError("Scene Prompt schedule statistics or fingerprint are invalid.")
    return expected


def _validate_unit(value, depth, ancestors):
    if depth > MAX_SCHEDULE_DEPTH or not isinstance(value, dict):
        raise ScenePlanError("Scene Prompt schedule unit is invalid.")
    kind = value.get("kind")
    if kind not in UNIT_KEYS:
        raise ScenePlanError("Scene Prompt schedule unit kind is invalid.")
    _old._require_exact_keys(value, {"kind", "stats"} | UNIT_KEYS[kind], "Scene Prompt schedule unit")
    _validate_stats(value["stats"])
    if id(value) in ancestors:
        raise ScenePlanError("Scene Prompt schedule contains a cycle.")
    ancestors.add(id(value))
    data = {key: item for key, item in value.items() if key not in {"kind", "stats"}}
    if kind == "run":
        data["row"] = _old._clone_row(data["row"])
    elif kind in {"sequence"}:
        data["plan"] = _validate_plan(data["plan"], depth + 1, ancestors)
    elif kind == "alternate":
        if not isinstance(data["inputs"], list) or not data["inputs"]:
            raise ScenePlanError("Scene Prompt alternate inputs are invalid.")
        data["block_size"] = _old._require_int(data["block_size"], "Scene Prompt alternate block size", 1, MAX_SAFE_INTEGER)
        data["inputs"] = [_validate_plan(plan, depth + 1, ancestors) for plan in data["inputs"]]
    elif kind == "random_choice":
        _old._require_string(data["gate_id"], "Scene Prompt Random Route ID", allow_empty=False)
        data["weights"] = validate_random_weights(data["weights"])
        if not isinstance(data["inputs"], list) or len(data["inputs"]) != 10:
            raise ScenePlanError("Scene Prompt Random Route の出力が不正です。")
        data["inputs"] = [_validate_plan(plan, depth + 1, ancestors) for plan in data["inputs"]]
        selected = data["selected_arm"]
        if selected is not None and (type(selected) is not int or not 0 <= selected < 10):
            raise ScenePlanError("Scene Prompt Random Route の選択先が不正です。")
    elif kind == "product":
        data["left"] = _validate_plan(data["left"], depth + 1, ancestors)
        data["right"] = _validate_plan(data["right"], depth + 1, ancestors)
    elif kind == "matrix_map":
        data["matrix_rows"] = _clone_matrix_rows(data["matrix_rows"])
        data["unit"] = _validate_unit(data["unit"], depth + 1, ancestors)
    elif kind == "map":
        if not isinstance(data["operations"], list) or any(not isinstance(op, dict) or set(op) != {"kind", "payload"} for op in data["operations"]):
            raise ScenePlanError("Scene Prompt map operations are invalid.")
        for operation in data["operations"]:
            _validate_operation(operation)
        data["operations"] = [_clone_operation(operation) for operation in data["operations"]]
        data["unit"] = _validate_unit(data["unit"], depth + 1, ancestors)
    else:
        data["unit"] = _validate_unit(data["unit"], depth + 1, ancestors)
    ancestors.remove(id(value))
    expected = _unit(kind, **data)
    if expected["stats"] != value["stats"]:
        raise ScenePlanError("Scene Prompt schedule unit statistics are invalid.")
    return expected


def _validate_stats(value):
    if not isinstance(value, dict) or set(value) != STATS_KEYS:
        raise ScenePlanError("Scene Prompt schedule statistics are invalid.")
    for key in STATS_KEYS:
        _safe(value[key], f"Scene Prompt {key}")


def _clone_matrix_rows(value):
    if not isinstance(value, list):
        raise ScenePlanError("Scene Matrix rows must be a list.")
    result = []
    needed = _old.ROW_KEYS - {"source_node_ids", "source_node_names", "callbacks"}
    for row in value:
        if not isinstance(row, dict) or type(row.get("enabled")) is not bool or row["enabled"] is not True:
            raise ScenePlanError("Scene Matrix schedule row must be an enabled object.")
        _old._require_string(row.get("name"), "Scene Matrix row name", allow_empty=False)
        if not needed.issubset(row):
            raise ScenePlanError("Scene Matrix schedule row has missing prompt fields.")
        candidate = {key: row[key] for key in _old.ROW_KEYS if key in row}
        candidate["source_node_ids"] = []
        candidate["source_node_names"] = {}
        candidate["callbacks"] = []
        _old._clone_row(candidate)
        result.append(copy.deepcopy(row))
    return result


def normalize_plan(value):
    if value is None:
        return seed_plan()
    if isinstance(value, ScenePlan):
        return value
    return _validate_plan(value)


def validate_random_weights(value):
    if not isinstance(value, list) or len(value) != 10 or any(type(item) is not int or not 0 <= item <= 10000 for item in value):
        raise ScenePlanError("Scene Prompt Random Route の確率は0.01%単位の10個の整数で指定してください。")
    if sum(value) != 10000:
        raise ScenePlanError("Scene Prompt Random Route の確率合計は100%にしてください。")
    return list(value)


def _validate_guards(guards):
    if not isinstance(guards, list) or len(guards) > MAX_SCHEDULE_DEPTH:
        raise ScenePlanError("Scene Prompt Random Route の分岐状態が不正です。")
    result = []
    for guard in guards:
        if not isinstance(guard, dict) or set(guard) != {"gate_id", "arm_index", "weights"}:
            raise ScenePlanError("Scene Prompt Random Route の分岐状態が不正です。")
        gate_id = _old._require_string(guard["gate_id"], "Scene Prompt Random Route ID", allow_empty=False)
        arm = _old._require_int(guard["arm_index"], "Scene Prompt Random Route output", 0, 9)
        weights = validate_random_weights(guard["weights"])
        result.append({"gate_id": gate_id, "arm_index": arm, "weights": weights})
    return result


def _validate_operation(operation):
    if not isinstance(operation, dict) or set(operation) != {"kind", "payload"}:
        raise ScenePlanError("Scene Prompt map operation is invalid.")
    kind, payload = operation["kind"], operation["payload"]
    if kind not in OPERATION_KINDS:
        raise ScenePlanError("Scene Prompt map operation kind is invalid.")
    if kind in {"prompt_passthrough", "prompt_whole"}:
        valid = payload is None
    elif kind == "prompt_add":
        valid = (isinstance(payload, (list, tuple)) and len(payload) == 4
                 and isinstance(payload[0], str) and type(payload[3]) is bool
                 and all(isinstance(parts, list) and all(isinstance(item, str) for item in parts) for parts in payload[1:3]))
    elif kind in {"path_add", "delete", "source_node"}:
        valid = isinstance(payload, (list, tuple)) and len(payload) == 2 and all(isinstance(item, str) for item in payload)
    elif kind == "reverse":
        valid = isinstance(payload, str) and payload in ("全てのノード", "直前のノード")
    elif kind == "model_set":
        try:
            _old._clone_model_links(payload)
            valid = True
        except ScenePlanError:
            valid = False
    elif kind == "lora_add":
        try:
            _old._clone_loras([payload])
            valid = True
        except ScenePlanError:
            valid = False
    elif kind == "latent_set":
        try:
            _old._clone_latent(payload)
            valid = True
        except ScenePlanError:
            valid = False
    else:
        valid = (isinstance(payload, (list, tuple)) and len(payload) == 5
                 and isinstance(payload[0], str) and isinstance(payload[1], dict)
                 and payload[2] in {"初回", "毎回"} and type(payload[3]) is int
                 and payload[3] >= 1 and payload[4] in {"続行", "停止"})
    if not valid:
        raise ScenePlanError("Scene Prompt map operation payload is invalid.")


def _clone_operation(operation):
    _validate_operation(operation)
    return {"kind": operation["kind"], "payload": copy.deepcopy(operation["payload"])}


def _map_unit(unit, operation):
    if unit["kind"] in {"count_fixed", "count_hold"}:
        return _unit(unit["kind"], unit=_map_unit(unit["unit"], operation))
    if unit["kind"] == "run":
        return _unit("run", row=_apply_operation(unit["row"], operation), count=unit["count"])
    if unit["kind"] == "map":
        return _unit("map", unit=unit["unit"], operations=[*unit["operations"], operation])
    return _unit("map", unit=unit, operations=[operation])


def _apply_operation(row, operation):
    kind, payload = operation["kind"], operation["payload"]
    if kind == "prompt_add":
        from .prompt import _merge_positive_negative_parts
        label, positive_parts, negative_parts, filename_enabled = payload
        positive, negative = _merge_positive_negative_parts(
            row["positive_parts"], row["negative_parts"], positive_parts, negative_parts,
        )
        next_row = {**row, "labels": [*row["labels"], label],
                    "positive_parts": positive, "negative_parts": negative,
                    "filename_parts": [*row["filename_parts"], *([label] if filename_enabled else [])]}
        next_row = _old.with_prompt_trace(next_row, row, positive_parts, negative_parts)
    elif kind == "path_add":
        from .nodes import _append_path_part
        label, path_mode = payload
        next_row = {**row, "path_parts": _append_path_part(row["path_parts"], label, path_mode)}
    elif kind == "reverse":
        from .nodes import REVERSE_SCOPE_PREVIOUS
        from .prompt import _merge_positive_negative_parts
        scope = payload
        positive, negative = list(row["positive_parts"]), list(row["negative_parts"])
        loras = [dict(descriptor) for descriptor in row.get("loras", [])]
        trace = row.get("prompt_trace")
        indices = []
        if scope == REVERSE_SCOPE_PREVIOUS and isinstance(trace, dict):
            if trace["kind"] == "passthrough":
                pass
            elif trace["kind"] == "whole":
                positive, negative = negative, positive
                indices = range(len(loras))
            elif trace["lora_index"] is not None:
                indices = [trace["lora_index"]]
            else:
                positive, negative = _merge_positive_negative_parts(
                    trace["before_positive_parts"], trace["before_negative_parts"],
                    trace["added_negative_parts"], trace["added_positive_parts"],
                )
        else:
            positive, negative = negative, positive
            indices = range(len(loras))
        for index in indices:
            loras[index]["positive_parts"], loras[index]["negative_parts"] = (
                loras[index]["negative_parts"], loras[index]["positive_parts"])
        next_row = {**row, "positive_parts": positive, "negative_parts": negative,
                    **({"loras": loras} if "loras" in row else {})}
        if scope == REVERSE_SCOPE_PREVIOUS and isinstance(trace, dict) and trace["lora_index"] is not None and trace["kind"] == "delta":
            index = trace["lora_index"]
            next_row = _old.with_prompt_trace(next_row, row, loras[index]["positive_parts"], loras[index]["negative_parts"], lora_index=index)
        else:
            next_row = _old.with_prompt_trace(next_row, row, positive, negative, kind="whole")
    elif kind == "delete":
        from .prompt import _delete_prompt_parts, _prompt_override_key, _split_prompt
        positive, negative = payload
        keys = {"positive_parts": {_prompt_override_key(part) for part in _split_prompt(positive)},
                "negative_parts": {_prompt_override_key(part) for part in _split_prompt(negative)}}
        loras = [{**descriptor, **{side: _delete_prompt_parts(descriptor[side], values) for side, values in keys.items()}}
                 for descriptor in row.get("loras", [])]
        next_row = {**row, **{side: _delete_prompt_parts(row[side], values) for side, values in keys.items()},
                    **({"loras": loras} if "loras" in row else {})}
    elif kind == "model_set":
        next_row = {**row, "model_links": {key: list(value) for key, value in payload.items()}}
    elif kind == "lora_add":
        descriptor = copy.deepcopy(payload)
        index = len(row.get("loras", []))
        next_row = _old.with_prompt_trace(row, row, descriptor["positive_parts"], descriptor["negative_parts"], lora_index=index)
        next_row["loras"] = [*row.get("loras", []), descriptor]
    elif kind == "prompt_passthrough":
        next_row = _old.with_prompt_trace(row, row, [], [], kind="passthrough")
    elif kind == "prompt_whole":
        next_row = _old.with_prompt_trace(row, _old.empty_row(), row["positive_parts"], row["negative_parts"], kind="whole")
    elif kind == "source_node":
        node_id, name = payload
        next_row = {
            **row,
            "source_node_ids": _old._unique_strings([*row["source_node_ids"], node_id]),
            "source_node_names": {**row["source_node_names"], **({node_id: name} if name else {})},
        }
    elif kind == "callback":
        node_id, config, frequency, timeout, failure = payload
        descriptor = {
            "callback_node_id": node_id, "config": copy.deepcopy(config), "frequency": frequency,
            "timeout_seconds": timeout, "failure_mode": failure,
            "current_positive_parts": list(row["positive_parts"]),
            "current_negative_parts": list(row["negative_parts"]),
            "current_source_node_ids": list(row["source_node_ids"]),
            "current_loras": _old._clone_loras(row.get("loras", [])),
        }
        next_row = {**row, "callbacks": [*row["callbacks"], descriptor]}
    elif kind == "latent_set":
        next_row = {**row, "latent": dict(payload)}
    else:
        raise ScenePlanError("Unsupported Scene Prompt map operation.")
    return _old._clone_row(next_row)


def _map_plan(plan, operation):
    _validate_operation(operation)
    source = normalize_plan(plan)
    if source["random_guards"] and operation["kind"] == "latent_set" and not _inert_random_arm(source):
        raise ScenePlanError("Scene Prompt Random Route の分岐内で Scene Empty Latent は使えません。")
    return _plan([_map_unit(unit, operation) for unit in source["units"]], source["sources"], source["contains_queue_boundary"], source["random_guards"])


def transform(plan, transform_row=None, *, latent=None, operation=None):
    source = normalize_plan(plan)
    if latent is not None:
        operation = {"kind": "latent_set", "payload": _old._clone_latent(latent)}
    if operation is not None:
        _validate_operation(operation)
        return _map_plan(source, operation)
    if not callable(transform_row):
        raise ScenePlanError("Scene Prompt transform must be callable.")
    units = []
    for unit in source["units"]:
        fixed = unit["kind"] in {"count_fixed", "count_hold"}
        child = unit["unit"] if fixed else unit
        simple = _unwrap_run(child)
        if simple is None:
            raise ScenePlanError("A composite Scene Prompt transform needs a named operation.")
        row = _old._clone_row(transform_row(copy.deepcopy(simple["row"]), {"row": copy.deepcopy(simple["row"]), "count": simple["count"]}))
        result = _unit("run", row=row, count=simple["count"])
        units.append(_unit(unit["kind"], unit=result) if fixed else result)
    return _plan(units, source["sources"], source["contains_queue_boundary"], source["random_guards"])


def mark_prompt_passthrough(plan):
    return _map_plan(plan, {"kind": "prompt_passthrough", "payload": None})


def mark_prompt_whole(plan):
    return _map_plan(plan, {"kind": "prompt_whole", "payload": None})


def with_source_node(plan, node_id, node_name=""):
    node_id = str(node_id or "").strip()
    if not node_id:
        return normalize_plan(plan)
    return _map_plan(plan, {"kind": "source_node", "payload": (node_id, str(node_name or "").strip())})


def append_callback(plan, callback_node_id, config, frequency, timeout_seconds, failure_mode):
    node_id = _old._require_string(str(callback_node_id or "").strip(), "Scene Prompt callback node id", allow_empty=False)
    if not isinstance(config, dict):
        raise ScenePlanError("Scene Prompt callback config must be an object.")
    timeout = _old._require_int(timeout_seconds, "Scene Prompt callback timeout_seconds", 1)
    frequency = {"first": "初回", "every": "毎回"}.get(frequency, frequency)
    failure_mode = {"continue": "続行", "stop": "停止"}.get(failure_mode, failure_mode)
    source = _map_plan(plan, {"kind": "callback", "payload": (node_id, config, frequency, timeout, failure_mode)})
    return mark_prompt_passthrough(source)


def _repeat(unit, factor):
    if factor == 1:
        return unit
    if unit["kind"] == "run":
        return _unit("run", row=unit["row"], count=_safe(unit["count"] * factor))
    if unit["kind"] == "repeat":
        return _unit("repeat", unit=unit["unit"], factor=_safe(unit["factor"] * factor))
    return _unit("repeat", unit=unit, factor=factor)


def _inert_random_arm(plan):
    if not plan["random_guards"] or plan["stats"]["total_batches"] != 0:
        return False
    gate = plan["random_guards"][-1]
    return gate["weights"][gate["arm_index"]] == 0


def multiply_count(plan, factor, enable_downstream_count=True):
    amount = _old._require_int(factor, "Scene Prompt count factor", 0, MAX_SAFE_INTEGER)
    if type(enable_downstream_count) is not bool:
        raise ScenePlanError("Scene Prompt enable_downstream_count must be a boolean.")
    source = normalize_plan(plan)
    if source["random_guards"] and not _inert_random_arm(source):
        raise ScenePlanError("Scene Prompt Random Route の分岐内で Scene Prompt Count は使えません。")
    all_strict = source.has_count_hold and _plan_policy(source)[0] == tuple(source["stats"][key] for key in _POLICY_KEYS)
    if all_strict:
        units = source["units"]
    elif source.has_count_hold:
        units = [_unit("count_scale", unit=_unit("sequence", plan=source), factor=amount)]
    else:
        units = []
        for unit in source["units"]:
            if amount > 0 and unit["kind"] == "count_fixed":
                units.append(unit)
            elif amount == 0 and unit["kind"] == "count_fixed":
                units.append(_unit("count_fixed", unit=_repeat(unit["unit"], 0)))
            else:
                units.append(_repeat(unit, amount))
    if not enable_downstream_count and not all_strict:
        units = [_unit("count_hold", unit=units[0] if len(units) == 1 else _unit("sequence", plan=_plan(units)))]
    return mark_prompt_passthrough(_plan(units, source["sources"], source["contains_queue_boundary"], source["random_guards"]))


def _contains_composite(unit):
    kind = unit["kind"]
    if kind in {"alternate", "sequence", "repeat_each", "random_choice", "count_hold", "count_scale"}:
        return True
    if kind == "product":
        return any(_contains_composite(subunit) for plan in (unit["left"], unit["right"]) for subunit in plan["units"])
    if "unit" in unit:
        return _contains_composite(unit["unit"])
    return False


def merge(left, right):
    first, second = normalize_plan(left), normalize_plan(right)
    if first["random_guards"] or second["random_guards"]:
        raise ScenePlanError("Scene Prompt Random Route の分岐内で Scene Prompt Merge は使えません。")
    composite = any(_contains_composite(unit) for plan in (first, second) for unit in plan["units"])
    boundary = first["contains_queue_boundary"] or second["contains_queue_boundary"]
    if composite:
        units = [_unit("product", left=first, right=second)]
    else:
        units = []
        for left_unit in first["units"]:
            for right_unit in second["units"]:
                a, b = _unwrap_run(left_unit), _unwrap_run(right_unit)
                if a is None or b is None:
                    raise ScenePlanError("Unsupported Scene Prompt merge unit.")
                units.append(_unit("run", row=_old.merge_rows(a["row"], b["row"]), count=_safe(a["count"] * b["count"])))
    return mark_prompt_whole(_plan(units, boundary=boundary))


def _unwrap_run(unit):
    while unit["kind"] in {"count_fixed", "count_hold", "map"}:
        if unit["kind"] == "map":
            child = _unwrap_run(unit["unit"])
            if child is None:
                return None
            row = child["row"]
            for operation in unit["operations"]:
                row = _apply_operation(row, operation)
            return _unit("run", row=row, count=child["count"])
        unit = unit["unit"]
    return unit if unit["kind"] == "run" else None


def _validate_queue_controls(order_mode, alternate_block_size, input_repeats_json, downstream_count_mode):
    if order_mode not in ("input_order", "alternate"):
        raise ScenePlanError("Scene Prompt Queue 並び順 is invalid.")
    block = _old._require_int(alternate_block_size, "Scene Prompt Queue 1行の回数", 1, MAX_SAFE_INTEGER)
    if downstream_count_mode not in ("multiply", "fixed"):
        raise ScenePlanError("Scene Prompt Queue 後続Count is invalid.")
    # Keep the old widget argument for serialized workflows; it no longer affects output.
    return order_mode, block, downstream_count_mode


def queue(values, *, order_mode="input_order", alternate_block_size=1, input_repeats_json="{}", downstream_count_mode="multiply"):
    mode, block, count_mode = _validate_queue_controls(order_mode, alternate_block_size, input_repeats_json, downstream_count_mode)
    slots = [(index, normalize_plan(value)) for index, value in enumerate(values, start=1) if value is not None]
    zero_guards = [plan["random_guards"][-1] for _, plan in slots if _inert_random_arm(plan)]
    slots = [(index, plan) for index, plan in slots if not (
        _inert_random_arm(plan)
    )]
    if zero_guards and not slots:
        gate = zero_guards[0]
        missing = [str(index + 1) for index, weight in enumerate(gate["weights"]) if weight]
        raise ScenePlanError(f"Scene Prompt Random Route Input {gate['gate_id']} の出力{', '.join(missing)}が合流OutputまたはQueueに接続されていません。")
    guarded = [(index, plan) for index, plan in slots if plan["random_guards"]]
    if guarded:
        if len(guarded) != len(slots):
            raise ScenePlanError("Scene Prompt Random Route の合流OutputまたはQueueに無関係な入力を混ぜられません。")
        stack = guarded[0][1]["random_guards"]
        gate = stack[-1]
        if any(plan["random_guards"][:-1] != stack[:-1] or
               plan["random_guards"][-1]["gate_id"] != gate["gate_id"] or
               plan["random_guards"][-1]["weights"] != gate["weights"] for _, plan in guarded):
            raise ScenePlanError("Scene Prompt Random Route の分岐を交差させず、同じOutputまたはQueueへ合流してください。")
        inputs = [None] * 10
        for _, plan in guarded:
            arm = plan["random_guards"][-1]["arm_index"]
            if inputs[arm] is not None:
                raise ScenePlanError(f"Scene Prompt Random Route の出力{arm + 1}が同じOutputまたはQueueに複数接続されています。")
            inputs[arm] = _plan(plan["units"], plan["sources"], plan["contains_queue_boundary"], stack[:-1])
        missing = [str(index + 1) for index, weight in enumerate(gate["weights"]) if weight and inputs[index] is None]
        if missing:
            raise ScenePlanError(f"Scene Prompt Random Route Input {gate['gate_id']} の出力{', '.join(missing)}が合流OutputまたはQueueに接続されていません。")
        empty = _plan([])
        inputs = [plan if plan is not None else empty for plan in inputs]
        unit = _unit("random_choice", gate_id=gate["gate_id"], weights=gate["weights"], inputs=inputs, selected_arm=None)
        return mark_prompt_whole(_plan([unit], boundary=True, guards=stack[:-1]))
    locked = any(plan["contains_queue_boundary"] for _, plan in slots)
    sources = [{
        "index": index, "row_count": plan["stats"]["row_count"],
        "total_images": plan["stats"]["total_images"], "total_batches": plan["stats"]["total_batches"],
    } for index, plan in slots]
    if not slots:
        units = list(seed_plan()["units"])
        if block > 1:
            units = [_unit("repeat_each", unit=unit, factor=block) for unit in units]
        if count_mode == "fixed":
            units = [_unit("count_fixed", unit=unit) for unit in units]
    elif locked:
        units = [unit for _, plan in slots for unit in plan["units"]]
    else:
        streams = [
            _plan([_unit("repeat_each", unit=unit, factor=block) for unit in plan["units"]])
            if block > 1 else plan for _, plan in slots
        ]
        if mode == "alternate":
            units = [_unit("alternate", inputs=streams, block_size=block)]
        else:
            units = [unit for stream in streams for unit in stream["units"]]
            if block > 1:
                units = [_unit("sequence", plan=_plan(units))]
        if count_mode == "fixed":
            units = [_unit("count_fixed", unit=unit) for unit in units]
    return mark_prompt_whole(_plan(units, sources, True))


def _matrix_row(base, matrix_row):
    addition = {key: matrix_row[key] for key in _old.ROW_KEYS if key in matrix_row}
    addition["source_node_ids"] = []
    addition["source_node_names"] = {}
    addition["callbacks"] = []
    row = _old.merge_rows(base, addition)
    row = _old.with_prompt_trace(row, base, addition["positive_parts"], addition["negative_parts"])
    name = _old._require_string(matrix_row.get("name"), "Scene Matrix row name", allow_empty=False).strip()
    row["labels"] = [*base["labels"], name]
    return _old._clone_row(row)


def matrix_product(plan, matrix_rows, configured):
    source = normalize_plan(plan)
    if source["random_guards"] and not _inert_random_arm(source):
        raise ScenePlanError("Scene Prompt Random Route の分岐内で Scene Matrix は使えません。")
    if not isinstance(matrix_rows, list) or type(configured) is not bool:
        raise ScenePlanError("Scene Matrix rows are invalid.")
    active = []
    for row in matrix_rows:
        if not isinstance(row, dict) or type(row.get("enabled")) is not bool:
            raise ScenePlanError("Scene Matrix rows must be current validated objects.")
        if row["enabled"]:
            active.append(copy.deepcopy(row))
    if not configured:
        return mark_prompt_passthrough(source)
    units = []
    for unit in source["units"]:
        fixed = unit["kind"] in {"count_fixed", "count_hold"}
        child = unit["unit"] if fixed else unit
        if child["kind"] == "run":
            derived = [_unit("run", row=_matrix_row(child["row"], matrix_row), count=child["count"]) for matrix_row in active]
        elif active:
            derived = [_unit("matrix_map", unit=child, matrix_rows=active)]
        else:
            derived = []
        units.extend(_unit(unit["kind"], unit=item) if fixed else item for item in derived)
    return _plan(units, boundary=source["contains_queue_boundary"], guards=source["random_guards"])


def random_route(plan, weights, gate_id, *, preserve_join=False):
    source = normalize_plan(plan)
    weights = validate_random_weights(weights)
    gate_id = _old._require_string(str(gate_id or "").strip(), "Scene Prompt Random Route ID", allow_empty=False)
    if any(guard["gate_id"] == gate_id for guard in source["random_guards"]):
        raise ScenePlanError("Scene Prompt Random Route の分岐が閉じる前に同じノードを再利用できません。")
    outputs = []
    for arm, weight in enumerate(weights):
        guard = {"gate_id": gate_id, "arm_index": arm, "weights": weights}
        outputs.append(_plan(source["units"] if weight else [], source["sources"] if weight else [], source["contains_queue_boundary"] if weight else False, [*source["random_guards"], guard]))
    if sum(bool(weight) for weight in weights) == 1 and not preserve_join:
        arm = next(index for index, weight in enumerate(weights) if weight)
        outputs[arm] = source
    return tuple(outputs)


def _random_arm(weights, gate_id, seed):
    payload = json.dumps([int(seed), str(gate_id)], ensure_ascii=False, separators=(",", ":"))
    draw = int.from_bytes(hashlib.blake2b(payload.encode("utf-8"), digest_size=8).digest(), "big") % 10000
    for arm, weight in enumerate(weights):
        if draw < weight:
            return arm
        draw -= weight
    raise ScenePlanError("Scene Prompt Random Route の確率が不正です。")


def _select_plan(plan, index, seed=0):
    unit_index = bisect.bisect_right(plan.batch_prefix, index)
    if unit_index >= len(plan["units"]):
        raise IndexError("Generation index is outside the plan.")
    offset = plan.batch_prefix[unit_index - 1] if unit_index else 0
    row_offset = plan.row_prefix[unit_index - 1] if unit_index else 0
    item = _select_unit(plan["units"][unit_index], index - offset, seed)
    item["row_index"] += row_offset
    item["event_ref"] = (("top", unit_index), *item["event_ref"])
    return item


def _prefix_plan_policy(plan, end, seed=0):
    result = [0, 0, 0]
    for unit in plan["units"]:
        length = min(end, unit["stats"]["total_batches"])
        result = [a + b for a, b in zip(result, _prefix_unit_policy(unit, length, seed))]
        end -= length
        if not end:
            break
    return tuple(result)


def _prefix_unit_policy(unit, end, seed=0):
    """Count policy classes in a prefix without visiting generated events."""
    if not end:
        return 0, 0, 0
    kind = unit["kind"]
    if kind == "run":
        return 0, 0, end
    if kind == "count_hold":
        return end, 0, 0
    if kind == "sequence":
        return _prefix_plan_policy(unit["plan"], end, seed)
    if kind == "random_choice":
        arm = unit["selected_arm"]
        if arm is None:
            arm = _random_arm(unit["weights"], unit["gate_id"], seed)
        return _prefix_plan_policy(unit["inputs"][arm], end, seed)
    if kind == "alternate":
        lengths = [plan["stats"]["total_batches"] for plan in unit["inputs"]]
        block = unit["block_size"]
        lower, upper = 0, (max(lengths, default=0) + block - 1) // block
        while lower < upper:
            middle = (lower + upper + 1) // 2
            if sum(min(length, block * middle) for length in lengths) <= end:
                lower = middle
            else:
                upper = middle - 1
        remaining = end - sum(min(length, block * lower) for length in lengths)
        result = [0, 0, 0]
        for plan, length in zip(unit["inputs"], lengths):
            start = min(length, block * lower)
            within = min(remaining, block, length - start)
            result = [a + b for a, b in zip(result, _prefix_plan_policy(plan, start + within, seed))]
            remaining -= within
        return tuple(result)
    if kind == "product":
        right_total = unit["right"]["stats"]["total_batches"]
        full, within = divmod(end, right_total)
        left = _prefix_plan_policy(unit["left"], full, seed)
        right = _prefix_plan_policy(unit["right"], right_total, seed)
        result = [0, 0, 0]
        for a in range(3):
            for b in range(3):
                result[min(a, b)] += left[a] * right[b]
        if within:
            next_left = _prefix_plan_policy(unit["left"], full + 1, seed)
            right_prefix = _prefix_plan_policy(unit["right"], within, seed)
            for a in range(3):
                for b in range(3):
                    result[min(a, b)] += (next_left[a] - left[a]) * right_prefix[b]
        return tuple(result)
    if kind == "count_scale":
        if unit["factor"] == 0:
            return end, 0, 0
        first = min(end, unit["unit"]["stats"]["total_batches"])
        strict, legacy, free = _prefix_unit_policy(unit["unit"], first, seed)
        return strict, legacy, free + end - first
    if kind == "count_fixed":
        strict = _prefix_unit_policy(unit["unit"], end, seed)[0]
        return strict, end - strict, 0
    if kind == "repeat":
        length = unit["unit"]["stats"]["total_batches"]
        cycles, within = divmod(end, length)
        total = _prefix_unit_policy(unit["unit"], length, seed)
        partial = _prefix_unit_policy(unit["unit"], within, seed)
        return tuple(value * cycles + rest for value, rest in zip(total, partial))
    if kind in {"repeat_each", "matrix_map"}:
        factor = len(unit["matrix_rows"]) if kind == "matrix_map" else unit["factor"]
        full, within = divmod(end, factor)
        prefix = _prefix_unit_policy(unit["unit"], full, seed)
        after = _prefix_unit_policy(unit["unit"], full + 1, seed) if within else prefix
        return tuple(value * factor + (next_value - value) * within for value, next_value in zip(prefix, after))
    if kind == "map":
        return _prefix_unit_policy(unit["unit"], end, seed)
    raise ScenePlanError("Unsupported Scene Prompt Count prefix unit.")


def _eligible_index(unit, ordinal, policy, seed):
    lower, upper = 0, unit["stats"]["total_batches"]
    while lower < upper:
        middle = (lower + upper) // 2
        if _prefix_unit_policy(unit, middle + 1, seed)[policy] <= ordinal:
            lower = middle + 1
        else:
            upper = middle
    return lower


def _select_unit(unit, index, seed=0):
    kind = unit["kind"]
    if kind == "run":
        row = copy.deepcopy(unit["row"])
        return {"row": row, "count": unit["count"], "row_index": 0, "repeat_index": index + 1,
                "event_ref": (("run", index),)}
    if kind == "sequence":
        item = _select_plan(unit["plan"], index, seed)
        item["event_ref"] = (("sequence",), *item["event_ref"])
        return item
    if kind == "count_fixed":
        item = _select_unit(unit["unit"], index, seed)
        item["event_ref"] = (("fixed",), *item["event_ref"])
        return item
    if kind == "count_hold":
        item = _select_unit(unit["unit"], index, seed)
        item["event_ref"] = (("count_hold",), *item["event_ref"])
        return item
    if kind == "count_scale":
        child = unit["unit"]
        original = child["stats"]["total_batches"]
        factor = unit["factor"]
        cycle, projection = 0, "original"
        if factor == 0:
            projection = "strict"
            local = _eligible_index(child, index, 0, seed)
        elif index < original:
            local = index
        else:
            eligible = _prefix_unit_policy(child, original, seed)[2]
            cycle, ordinal = divmod(index - original, eligible)
            cycle += 1
            projection = "free"
            local = _eligible_index(child, ordinal, 2, seed)
        item = _select_unit(child, local, seed)
        before = _prefix_unit_policy(child, local, seed)[2]
        is_free = _prefix_unit_policy(child, local + 1, seed)[2] > before
        if is_free and factor > 0:
            item["repeat_index"] += cycle * item["count"]
            item["count"] *= factor
        item["event_ref"] = (("count_scale", cycle, projection), *item["event_ref"])
        return item
    if kind == "repeat":
        child_count = unit["unit"]["stats"]["total_batches"]
        cycle, local = divmod(index, child_count)
        item = _select_unit(unit["unit"], local, seed)
        item["repeat_index"] += cycle * item["count"]
        item["count"] *= unit["factor"]
        item["event_ref"] = (("repeat", cycle), *item["event_ref"])
        return item
    if kind == "repeat_each":
        child_index, within = divmod(index, unit["factor"])
        item = _select_unit(unit["unit"], child_index, seed)
        item["repeat_index"] = (item["repeat_index"] - 1) * unit["factor"] + within + 1
        item["count"] *= unit["factor"]
        item["event_ref"] = (("repeat_each", within), *item["event_ref"])
        return item
    if kind == "alternate":
        lengths = [plan["stats"]["total_batches"] for plan in unit["inputs"]]
        block = unit["block_size"]
        lower, upper = 0, (max(lengths) + block - 1) // block
        while lower < upper:
            middle = (lower + upper) // 2
            before_next = sum(min(length, block * (middle + 1)) for length in lengths)
            if index < before_next:
                upper = middle
            else:
                lower = middle + 1
        round_index = lower
        before = sum(min(length, block * round_index) for length in lengths)
        within = index - before
        for socket, (plan, length) in enumerate(zip(unit["inputs"], lengths)):
            amount = min(block, max(0, length - block * round_index))
            if within < amount:
                local = block * round_index + within
                item = _select_plan(plan, local, seed)
                item["row_index"] += sum(previous["stats"]["row_count"] for previous in unit["inputs"][:socket])
                item["event_ref"] = (("alternate", socket, round_index, within), *item["event_ref"])
                return item
            within -= amount
        raise IndexError("Generation index is outside the alternate schedule.")
    if kind == "matrix_map":
        size = len(unit["matrix_rows"])
        child_index, matrix_index = divmod(index, size)
        item = _select_unit(unit["unit"], child_index, seed)
        item["row"] = _matrix_row(item["row"], unit["matrix_rows"][matrix_index])
        item["row_index"] = item["row_index"] * size + matrix_index
        item["event_ref"] = (("matrix", matrix_index), *item["event_ref"])
        return item
    if kind == "product":
        right_batches = unit["right"]["stats"]["total_batches"]
        left_index, right_index = divmod(index, right_batches)
        left = _select_plan(unit["left"], left_index, seed)
        right = _select_plan(unit["right"], right_index, seed)
        row = _old.merge_rows(left["row"], right["row"])
        return {"row": row, "count": left["count"] * right["count"],
                "row_index": left["row_index"] * unit["right"]["stats"]["row_count"] + right["row_index"],
                "repeat_index": (left["repeat_index"] - 1) * right["count"] + right["repeat_index"],
                "event_ref": (("product",), left["event_ref"], right["event_ref"])}
    if kind == "map":
        item = _select_unit(unit["unit"], index, seed)
        for operation in unit["operations"]:
            item["row"] = _apply_operation(item["row"], operation)
        item["event_ref"] = (("map",), *item["event_ref"])
        return item
    if kind == "random_choice":
        arm = unit["selected_arm"]
        if arm is None:
            arm = _random_arm(unit["weights"], unit["gate_id"], seed)
        item = _select_plan(unit["inputs"][arm], index, seed)
        item["event_ref"] = (("random_choice", unit["gate_id"], arm), *item["event_ref"])
        return item
    raise ScenePlanError("Unsupported Scene Prompt schedule unit.")


def item_for_normalized_plan(plan, index, seed=0):
    if plan["random_guards"]:
        raise ScenePlanError(f"Scene Prompt Random Route Input {plan['random_guards'][-1]['gate_id']} の分岐がOutputまたはQueueで合流していません。")
    if type(index) is not int or not 0 <= index < plan["stats"]["total_batches"]:
        raise IndexError("Generation index is outside the plan.")
    item = _select_plan(plan, index, seed)
    item["label"] = _old.row_label(item["row"])
    item["start_index"] = index - item["repeat_index"] + 1
    item["queue_index"] = 0
    item["source_id"] = ""
    item["source_title"] = ""
    item["global_index"] = index
    item["total_batches"] = plan["stats"]["total_batches"]
    item["total_images"] = plan["stats"]["total_images"]
    return item


def item_for_index(plan, index):
    return item_for_normalized_plan(normalize_plan(plan), index)


def legacy_rows(plan):
    """Small compatibility view for callers inspecting old row-major plans.

    Executing a composite schedule never uses this view; materializing an
    alternating plan would change its grouping and make large Counts costly.
    """
    if plan["random_guards"]:
        raise ScenePlanError(f"Scene Prompt Random Route Input {plan['random_guards'][-1]['gate_id']} の分岐がOutputまたはQueueで合流していません。")
    if plan["stats"]["row_count"] > 100_000:
        raise ScenePlanError("This schedule has too many logical rows to list.")
    rows = []

    def visit(unit):
        kind = unit["kind"]
        if kind == "run":
            rows.append({"row": copy.deepcopy(unit["row"]), "count": unit["count"]})
        elif kind in {"count_fixed", "count_hold"}:
            visit(unit["unit"])
        elif kind in {"repeat", "repeat_each"}:
            before = len(rows)
            visit(unit["unit"])
            for item in rows[before:]:
                item["count"] *= unit["factor"]
        elif kind == "map":
            before = len(rows)
            visit(unit["unit"])
            for item in rows[before:]:
                for operation in unit["operations"]:
                    item["row"] = _apply_operation(item["row"], operation)
        elif kind == "sequence":
            for child in unit["plan"]["units"]:
                visit(child)
        else:
            raise ScenePlanError("An alternating schedule has no contiguous rows view.")

    for unit in plan["units"]:
        visit(unit)
    cursor = 0
    result = []
    for row_index, item in enumerate(rows):
        result.append({
            "row": item["row"], "count": item["count"], "start_index": cursor,
            "row_index": row_index, "label": _old.row_label(item["row"]),
            "queue_index": 0, "source_id": "", "source_title": "",
        })
        cursor += item["count"]
    return result


def _prune_plan(plan, selected_sources, visible_sources, pending_operations=(), selected_arms=None):
    return _plan(
        [_prune_unit(unit, selected_sources, visible_sources, pending_operations, selected_arms) for unit in plan["units"]],
        plan["sources"], plan["contains_queue_boundary"], plan["random_guards"],
    )


def _prune_unit(unit, selected_sources, visible_sources, pending_operations=(), selected_arms=None):
    kind = unit["kind"]
    if kind == "run":
        row = unit["row"]
        for operation in pending_operations:
            row = _apply_operation(row, operation)
        row_sources = {str(source) for source in row["source_node_ids"]}
        kept = (row_sources & visible_sources) <= selected_sources
        return unit if kept else _unit("run", row=unit["row"], count=0)
    if kind == "sequence":
        return _unit("sequence", plan=_prune_plan(unit["plan"], selected_sources, visible_sources, pending_operations, selected_arms))
    if kind == "alternate":
        return _unit("alternate", inputs=[_prune_plan(plan, selected_sources, visible_sources, pending_operations, selected_arms) for plan in unit["inputs"]], block_size=unit["block_size"])
    if kind == "random_choice":
        arm = selected_arms.get(unit["gate_id"]) if selected_arms else None
        if arm is None:
            return _unit("random_choice", gate_id=unit["gate_id"], weights=unit["weights"], inputs=[_plan([]) for _ in range(10)], selected_arm=0)
        inputs = [_plan([]) for _ in range(10)]
        inputs[arm] = _prune_plan(unit["inputs"][arm], selected_sources, visible_sources, pending_operations, selected_arms)
        return _unit("random_choice", gate_id=unit["gate_id"], weights=unit["weights"], inputs=inputs, selected_arm=arm)
    if kind == "product":
        return _unit("product", left=_prune_plan(unit["left"], selected_sources, visible_sources, selected_arms=selected_arms), right=_prune_plan(unit["right"], selected_sources, visible_sources, selected_arms=selected_arms))
    if kind == "map":
        child = _prune_unit(unit["unit"], selected_sources, visible_sources, (*unit["operations"], *pending_operations), selected_arms)
        return _unit("map", unit=child, operations=unit["operations"])
    child = _prune_unit(unit["unit"], selected_sources, visible_sources, pending_operations, selected_arms)
    if kind in {"repeat", "repeat_each", "count_scale"}:
        return _unit(kind, unit=child, factor=unit["factor"])
    if kind in {"count_fixed", "count_hold"}:
        return _unit(kind, unit=child)
    if kind == "matrix_map":
        return _unit("matrix_map", unit=child, matrix_rows=unit["matrix_rows"])
    raise ScenePlanError("Unsupported Scene Prompt replay unit.")


def _rank_plan(plan, path):
    if not path or path[0][0] != "top":
        raise ScenePlanError("Selected Scene Prompt event path is invalid.")
    index = path[0][1]
    if type(index) is not int or not 0 <= index < len(plan["units"]):
        raise ScenePlanError("Selected Scene Prompt event no longer exists.")
    before = plan.batch_prefix[index - 1] if index else 0
    return before + _rank_unit(plan["units"][index], path[1:])


def _rank_unit(unit, path):
    kind = unit["kind"]
    if not path:
        raise ScenePlanError("Selected Scene Prompt event path is incomplete.")
    marker = path[0]
    if kind == "run":
        occurrence = marker[1] if marker[0] == "run" else -1
        if type(occurrence) is not int or not 0 <= occurrence < unit["count"]:
            raise ScenePlanError("Selected Scene Prompt event was pruned.")
        return occurrence
    if kind == "sequence" and marker[0] == "sequence":
        return _rank_plan(unit["plan"], path[1:])
    if kind == "count_fixed" and marker[0] == "fixed":
        return _rank_unit(unit["unit"], path[1:])
    if kind == "count_hold" and marker[0] == "count_hold":
        return _rank_unit(unit["unit"], path[1:])
    if kind == "count_scale" and marker[0] == "count_scale" and len(marker) == 3:
        cycle, projection = marker[1:]
        child = unit["unit"]
        local = _rank_unit(child, path[1:])
        policy = 0 if unit["factor"] == 0 else 2
        if projection == "original" and cycle == 0 and unit["factor"] > 0:
            return local
        expected = "strict" if unit["factor"] == 0 else "free"
        if projection != expected or type(cycle) is not int or not (
                cycle == 0 if unit["factor"] == 0 else 1 <= cycle < unit["factor"]):
            raise ScenePlanError("Selected Scene Prompt Count cycle no longer exists.")
        before = _prefix_unit_policy(child, local)[policy]
        if _prefix_unit_policy(child, local + 1)[policy] == before:
            raise ScenePlanError("Selected Scene Prompt Count event was pruned.")
        if unit["factor"] == 0:
            return before
        length = child["stats"]["total_batches"]
        return length + (cycle - 1) * _prefix_unit_policy(child, length)[2] + before
    if kind == "repeat" and marker[0] == "repeat":
        cycle = marker[1]
        if type(cycle) is not int or not 0 <= cycle < unit["factor"]:
            raise ScenePlanError("Selected Scene Prompt repeat no longer exists.")
        return cycle * unit["unit"]["stats"]["total_batches"] + _rank_unit(unit["unit"], path[1:])
    if kind == "repeat_each" and marker[0] == "repeat_each":
        within = marker[1]
        if type(within) is not int or not 0 <= within < unit["factor"]:
            raise ScenePlanError("Selected Scene Prompt row repeat no longer exists.")
        return _rank_unit(unit["unit"], path[1:]) * unit["factor"] + within
    if kind == "alternate" and marker[0] == "alternate":
        socket = marker[1]
        if type(socket) is not int or not 0 <= socket < len(unit["inputs"]):
            raise ScenePlanError("Selected Scene Prompt socket no longer exists.")
        local = _rank_plan(unit["inputs"][socket], path[1:])
        lengths = [plan["stats"]["total_batches"] for plan in unit["inputs"]]
        block = unit["block_size"]
        round_index, offset = divmod(local, block)
        before = sum(min(length, round_index * block) for length in lengths)
        prior = sum(min(block, max(0, length - round_index * block)) for length in lengths[:socket])
        return before + prior + offset
    if kind == "random_choice" and marker[0] == "random_choice":
        arm = marker[2] if len(marker) == 3 and marker[1] == unit["gate_id"] else -1
        if type(arm) is not int or arm != unit["selected_arm"]:
            raise ScenePlanError("Scene Prompt Random Route の保存経路が一致しません。")
        return _rank_plan(unit["inputs"][arm], path[1:])
    if kind == "matrix_map" and marker[0] == "matrix":
        matrix_index = marker[1]
        if type(matrix_index) is not int or not 0 <= matrix_index < len(unit["matrix_rows"]):
            raise ScenePlanError("Selected Scene Prompt Matrix row no longer exists.")
        return _rank_unit(unit["unit"], path[1:]) * len(unit["matrix_rows"]) + matrix_index
    if kind == "product" and marker[0] == "product":
        if len(path) != 3:
            raise ScenePlanError("Selected Scene Prompt Merge path is invalid.")
        left = _rank_plan(unit["left"], path[1])
        right = _rank_plan(unit["right"], path[2])
        return left * unit["right"]["stats"]["total_batches"] + right
    if kind == "map" and marker[0] == "map":
        return _rank_unit(unit["unit"], path[1:])
    raise ScenePlanError("Selected Scene Prompt event path does not match its plan.")


def replay_index_for_event(plan, event_ref, selected_sources, visible_source_ids):
    """Rank the selected event after excluding other visible generation paths."""
    source = normalize_plan(plan)
    if not isinstance(event_ref, (list, tuple)):
        raise ScenePlanError("Selected Scene Prompt event path is missing.")
    selected = {str(value) for value in selected_sources}
    visible = {str(value) for value in visible_source_ids}
    selected_arms = {}
    def choices(path):
        for part in path:
            if isinstance(part, (list, tuple)) and part and part[0] == "random_choice" and len(part) == 3:
                selected_arms[part[1]] = part[2]
            elif isinstance(part, (list, tuple)):
                choices(part)
    choices(event_ref)
    pruned = _prune_plan(source, selected, visible, selected_arms=selected_arms)
    index = _rank_plan(pruned, event_ref)
    if not 0 <= index < pruned["stats"]["total_batches"]:
        raise ScenePlanError("Selected Scene Prompt event was pruned.")
    return index
