import json
import sys
import types
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

folder_paths = types.ModuleType("folder_paths")
folder_paths.get_user_directory = lambda: str(ROOT / ".test-user")
folder_paths.get_public_user_directory = lambda user_id: str(ROOT / ".test-user" / user_id)
sys.modules.setdefault("folder_paths", folder_paths)

from scene_prompt_tools.prompt import _choice_rng, _compose_prompt_parts, _expand_choices, _expand_prompt_parts, _parse_selection_json


EMPTY_SELECTION = '{"version":1,"categories":{}}'


def test_single_choice_is_always_present():
    assert _expand_prompt_parts(["before, {A}, after"], 1, "positive") == ["before", "A", "after"]


def test_optional_choice_can_be_present_or_empty():
    values = {
        tuple(_expand_prompt_parts(["{A|}"], seed, "positive"))
        for seed in range(32)
    }
    assert values == {(), ("A",)}


def test_two_choices_can_produce_both_results():
    values = {
        tuple(_expand_prompt_parts(["{A|B}"], seed, "positive"))
        for seed in range(32)
    }
    assert values == {("A",), ("B",)}


def test_choice_with_commas_stays_intact_until_expanded():
    values = {
        tuple(_expand_prompt_parts(["{red dress, boots|blue dress, heels}"], seed, "positive"))
        for seed in range(32)
    }
    assert values == {("red dress", "boots"), ("blue dress", "heels")}


def test_randomize_false_keeps_choices_for_expand():
    assert _compose_prompt_parts("{A|B}", EMPTY_SELECTION, "", False, 99) == ["{A|B}"]


def test_randomize_true_keeps_choices_for_expand():
    assert _compose_prompt_parts("{A|B}", EMPTY_SELECTION, "", True, 99) == ["{A|B}"]


def test_duplicate_empty_choice_slots_are_preserved():
    class ChoiceSpy:
        def __init__(self, index):
            self.index = index
            self.options = None

        def choice(self, options):
            self.options = list(options)
            return options[self.index]

    first = ChoiceSpy(0)
    second = ChoiceSpy(1)
    third = ChoiceSpy(2)

    assert _expand_choices("{a||}", first) == "a"
    assert _expand_choices("{a||}", second) == ""
    assert _expand_choices("{a||}", third) == ""
    assert first.options == second.options == third.options == ["a", "", ""]


def test_same_seed_is_reproducible_and_streams_are_distinct():
    first = _expand_prompt_parts(["{A|B|C}"], 123, "positive")
    assert first == _expand_prompt_parts(["{A|B|C}"], 123, "positive")
    assert _choice_rng(123, "positive").getstate() != _choice_rng(123, "negative").getstate()


def test_empty_choice_removes_empty_weight_and_extra_commas():
    assert _expand_prompt_parts(["before", "({|}:1.2)", "after"], 1, "positive") == ["before", "after"]


def test_selection_state_accepts_only_version_one_categories_schema():
    current = _parse_selection_json('{"version":1,"categories":{"A":[]}}')
    assert list(current) == ["A"]
    for invalid in (
        '[{"category_key":"A","prompt":"alpha"}]',
        '{"items":[]}',
        '{"version":2,"categories":{"A":[]}}',
        '{"version":1,"categories":{"A":{}}}',
        '{broken',
    ):
        try:
            _parse_selection_json(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError("invalid selection JSON must be rejected")


def test_selection_entries_are_strict():
    item = {
        "id": "a", "label": "A", "prompt": "alpha, beta",
        "category_path": ["Category"], "category_key": "Category", "category_label": "Category",
        "selected_parts": [{"index": 0, "text": "alpha", "weight": 1.2}],
    }
    state = {"version": 1, "categories": {"Category": [item]}}
    assert _parse_selection_json(json.dumps(state))["Category"][0]["selected_parts"][0]["weight"] == 1.2
    for invalid_item in (
        {**item, "weight": "bad"},
        {key: value for key, value in item.items() if key != "prompt"},
        {**item, "legacy": True},
    ):
        try:
            _parse_selection_json(json.dumps({"version": 1, "categories": {"Category": [invalid_item]}}))
        except ValueError:
            pass
        else:
            raise AssertionError("invalid selection item must be rejected")


def test_legacy_selection_entries_normalize_without_prompt_data_lookup():
    legacy = {"version": 1, "categories": {"Outfit > School": [{
        "label": "Summer", "prompt": "summer uniform",
    }]}}
    item = _parse_selection_json(json.dumps(legacy))["Outfit > School"][0]
    assert item == {
        "label": "Summer",
        "prompt": "summer uniform",
        "category_path": ["Outfit", "School"],
        "category_key": "Outfit > School",
        "category_label": "Outfit > School",
    }


def test_pre_public_legacy_keys_normalize_without_remapping():
    legacy = {"version": 1, "categories": {"Outfit": [{
        "label": "Summer", "prompt": "summer uniform",
        "legacy_keys": ["Outfit::Summer", "Outfit::summer uniform"],
    }]}}
    item = _parse_selection_json(json.dumps(legacy))["Outfit"][0]
    assert item == {
        "label": "Summer",
        "prompt": "summer uniform",
        "category_path": ["Outfit"],
        "category_key": "Outfit",
        "category_label": "Outfit",
    }


def test_pre_public_legacy_keys_reject_invalid_values_and_unknown_fields():
    base = {"label": "Summer", "prompt": "summer uniform"}
    for item in (
        {**base, "legacy_keys": "Outfit::Summer"},
        {**base, "legacy_keys": [""]},
        {**base, "legacy_keys": [1]},
        {**base, "legacy_keys": ["Outfit::Summer"], "unknown": True},
    ):
        try:
            _parse_selection_json(json.dumps({"version": 1, "categories": {"Outfit": [item]}}))
        except ValueError:
            pass
        else:
            raise AssertionError("invalid legacy selection JSON must be rejected")


def test_selection_rejects_unknown_or_conflicting_legacy_values():
    base = {"label": "Summer", "prompt": "summer uniform"}
    for item in (
        {**base, "unknown": True},
        {**base, "category_key": "Wrong"},
        {**base, "category_path": ["Outfit"]},
        {**base, "category_label": "Wrong"},
    ):
        try:
            _parse_selection_json(json.dumps({"version": 1, "categories": {"Outfit > School": [item]}}))
        except ValueError:
            pass
        else:
            raise AssertionError("invalid legacy selection JSON must be rejected")


def selection_item(prompt, **overrides):
    item = {
        "id": "stable-item",
        "label": "Example",
        "prompt": prompt,
        "category_path": ["Category"],
        "category_key": "Category",
        "category_label": "Category",
    }
    item.update(overrides)
    return item


def test_selection_keeps_its_stored_prompt_and_partial_selection():
    previous = selection_item("alpha, beta", selected_parts=[{"index": 1, "text": "beta", "weight": 1.2}])
    parsed = _parse_selection_json(json.dumps({"version": 1, "categories": {"Category": [previous]}}))
    assert parsed["Category"][0]["prompt"] == "alpha, beta"
    selected = parsed["Category"][0]["selected_parts"]
    assert selected == [{"index": 1, "text": "beta", "weight": 1.2}]


class PromptChoiceTests(unittest.TestCase):
    def test_choices(self):
        test_single_choice_is_always_present()
        test_optional_choice_can_be_present_or_empty()
        test_two_choices_can_produce_both_results()
        test_choice_with_commas_stays_intact_until_expanded()
        test_randomize_false_keeps_choices_for_expand()
        test_randomize_true_keeps_choices_for_expand()
        test_duplicate_empty_choice_slots_are_preserved()
        test_same_seed_is_reproducible_and_streams_are_distinct()
        test_empty_choice_removes_empty_weight_and_extra_commas()

    def test_current_data_schema(self):
        test_selection_state_accepts_only_version_one_categories_schema()
        test_selection_entries_are_strict()
        test_legacy_selection_entries_normalize_without_prompt_data_lookup()
        test_selection_rejects_unknown_or_conflicting_legacy_values()
        test_pre_public_legacy_keys_normalize_without_remapping()
        test_pre_public_legacy_keys_reject_invalid_values_and_unknown_fields()

    def test_selection_values_are_stored(self):
        test_selection_keeps_its_stored_prompt_and_partial_selection()


if __name__ == "__main__":
    unittest.main()
