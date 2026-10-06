import json
import random
import re
import sys
import tempfile
import tracemalloc
import types
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

folder_paths = types.ModuleType("folder_paths")
folder_paths.get_user_directory = lambda: str(ROOT / ".test-user")
folder_paths.get_public_user_directory = lambda user_id: str(ROOT / ".test-user" / user_id)
sys.modules.setdefault("folder_paths", folder_paths)

from scene_prompt_tools.prompt import (
    _choice_rng, _compose_prompt_parts, _expand_choices, _expand_prompt_parts,
    _join_unique, _merge_positive_negative_parts, _parse_selection_json, _unique_parts,
    _split_prompt,
)


EMPTY_SELECTION = '{"version":1,"categories":{}}'


def legacy_expand_choices(text, rng):
    """The original whole-string implementation, kept only as a small oracle."""
    result = text or ""
    seen = set()
    while result not in seen:
        seen.add(result)
        match = re.search(r"\{([^{}]*)\}", result)
        if not match:
            break
        options = [option.strip() for option in match.group(1).split("|")]
        replacement = rng.choice(options) if options else ""
        result = result[:match.start()] + replacement + result[match.end():]
    return result


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
    for weight in (-20, 50):
        weighted = {**item, "selected_parts": [{"index": 0, "text": "alpha", "weight": weight}]}
        parsed = _parse_selection_json(json.dumps({"version": 1, "categories": {"Category": [weighted]}}))
        assert parsed["Category"][0]["selected_parts"][0]["weight"] == weight
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


def test_missing_partial_selection_is_valid_but_not_emitted():
    item = selection_item(
        "alpha, gamma",
        selected_parts=[
            {"index": 0, "text": "alpha"},
            {"index": 1, "text": "beta", "missing": True, "weight": 1.2},
        ],
    )
    state = json.dumps({"version": 1, "categories": {"Category": [item]}})
    parsed = _parse_selection_json(state)["Category"][0]
    assert parsed["selected_parts"][1] == {"index": 1, "text": "beta", "missing": True, "weight": 1.2}
    assert _compose_prompt_parts("", state, "", False, 0) == ["alpha"]

    mismatched = selection_item(
        "alpha, gamma",
        selected_parts=[{"index": 1, "text": "beta", "weight": 1.2}],
    )
    mismatched_state = json.dumps({"version": 1, "categories": {"Category": [mismatched]}})
    repaired = _parse_selection_json(mismatched_state)["Category"][0]["selected_parts"][0]
    assert repaired == {"index": 1, "text": "beta", "missing": True, "weight": 1.2}
    assert _compose_prompt_parts("", mismatched_state, "", False, 0) == []


class PromptChoiceTests(unittest.TestCase):
    def test_plain_text_returns_original_without_consuming_rng(self):
        text = "plain | literal }, (tag:1.4)\n日本語 " * 3000
        rng = random.Random(123)
        original_state = rng.getstate()
        self.assertIs(_expand_choices(text, rng), text)
        self.assertEqual(rng.getstate(), original_state)

    def assert_legacy_choices(self, values):
        for text in values:
            for seed in (0, 1, 123, (1 << 64) - 1):
                for stream in ("positive", "negative"):
                    with self.subTest(text=text, seed=seed, stream=stream):
                        old_rng = _choice_rng(seed, stream)
                        new_rng = _choice_rng(seed, stream)
                        self.assertEqual(_expand_choices(text, new_rng), legacy_expand_choices(text, old_rng))
                        self.assertEqual(new_rng.getstate(), old_rng.getstate())

    def test_parser_matches_legacy_output_and_rng_for_fixed_syntax(self):
        self.assert_legacy_choices([
            None, "", "literal | tags, (weight:1.4)\n日本語", "{}", "{|}", "{a||}",
            "{single}", "{ \t single \n }", "{\u3000a\u00a0|\t\n}",
            "before, {red dress, boots|blue dress, heels}, after",
            "{a|{b|c}}", "{{a|b}|{c|d}}", "{a|}{}{{x}}{y|z}",
            "{a{b|c}tail|fallback}", "({{|}:1.2})", "{{}}", "{{|}}",
            "{", "}", "{{", "}}", "{|", "{a{b|c}", "{a|{b|c}",
            "{ {a|b} | untouched", "{{a|b}}}", "}{a|b}{", "{a}{b|c}{d",
            "{{a}{{b|c}}{d|e}", "{a|b}}{c|d}", "{a}b|{c|d}",
        ])

    def test_parser_matches_generated_balanced_and_unbalanced_choices(self):
        generator = random.Random(3107)
        literals = ("", "alpha", " beta ", "red, blue", "(tag:1.4)", "日本語", "\t", "\u3000")

        def balanced(depth):
            if depth == 0 or generator.randrange(3) == 0:
                return generator.choice(literals)
            return "{" + "|".join(balanced(depth - 1) for _ in range(generator.randrange(1, 5))) + "}"

        cases = [balanced(4) for _ in range(150)]
        cases.extend("".join(generator.choice("{}|ab ,\n\t") for _ in range(generator.randrange(100)))
                     for _ in range(300))
        # Broken outer braces must still allow complete inner choices to resolve.
        cases.extend("{" + balanced(3) + "|" + balanced(2) for _ in range(50))
        self.assert_legacy_choices(cases)

    def test_single_and_empty_slots_still_call_choice_in_exact_order(self):
        class ChoiceSpy:
            def __init__(self):
                self.calls = []

            def choice(self, options):
                self.calls.append(list(options))
                return options[0]

        rng = ChoiceSpy()
        self.assertEqual(_expand_choices("{{}{}{ a }}{||}{last}", rng), "alast")
        self.assertEqual(rng.calls, [[""], [""], ["a"], ["a"], ["", "", ""], ["last"]])

    def test_many_adjacent_choices_use_linear_memory(self):
        peaks = []
        for count in (200, 1000, 3000, 9000):
            text = ", ".join("{alpha|bravo}" for _ in range(count))
            old_rng = random.Random(123)
            expected = ", ".join(old_rng.choice(["alpha", "bravo"]) for _ in range(count))
            rng = random.Random(123)
            tracemalloc.start()
            try:
                result = _expand_choices(text, rng)
                _, peak = tracemalloc.get_traced_memory()
            finally:
                tracemalloc.stop()
            self.assertEqual(result, expected)
            self.assertEqual(rng.getstate(), old_rng.getstate())
            # Generous per-input bound; the former 3000-choice peak was ~99 MB.
            self.assertLess(peak, len(text) * 32 + 65536, (count, peak))
            peaks.append(peak)
        self.assertLess(peaks[-1], peaks[0] * 60)

    def test_deep_single_choices_reuse_long_payload_without_recursion(self):
        class ChoiceSpy(random.Random):
            def __init__(self):
                super().__init__(123)
                self.calls = 0
                self.payload_ids = set()

            def choice(self, options):
                self.calls += 1
                self.payload_ids.add(id(options[0]))
                return super().choice(options)

        depth = 3000
        payload = "long_payload" * 10000
        text = "{ \t" * depth + payload + "\u3000}" * depth
        rng = ChoiceSpy()
        self.assertEqual(_expand_choices(text, rng), payload)
        self.assertEqual(rng.calls, depth)
        # Even surrounding whitespace must not force a new payload per frame.
        self.assertEqual(len(rng.payload_ids), 1)
        old_rng = random.Random(123)
        for _ in range(depth):
            old_rng.choice([payload])
        self.assertEqual(rng.getstate(), old_rng.getstate())

    def test_deep_unclosed_outer_braces_keep_literal_frames(self):
        depth = 4000
        rng = random.Random(123)
        expected_rng = random.Random(123)
        chosen = expected_rng.choice(["a", "b"])
        text = "{prefix|" * depth + "{a|b} tail"
        self.assertEqual(_expand_choices(text, rng), "{prefix|" * depth + chosen + " tail")
        self.assertEqual(rng.getstate(), expected_rng.getstate())

    def test_expand_to_text_and_delete_keep_seeded_choice_results(self):
        from test_node_plan_semantics import load_nodes

        with tempfile.TemporaryDirectory() as directory:
            nodes, prompt = load_nodes(Path(directory))
            plan = prompt.ScenePrompt().build(
                "Choices", "before, {{red|blue}|{green|}}, {positive_remove|kept}, ({|spare}:1.2), after", EMPTY_SELECTION,
                "{{bad|worse}|noise}, {negative_remove|}", EMPTY_SELECTION, "", 0, False,
            )[0]
            plan = nodes.ScenePromptDelete().delete("positive_remove", "negative_remove", plan)[0]
            original = json.dumps(plan)
            row = nodes.item_for_normalized_plan(plan, 0)["row"]
            self.assertIn("{|kept}", row["positive_parts"])
            self.assertIn("{|}", row["negative_parts"])

            def legacy_parts(parts, seed, stream):
                rng = _choice_rng(seed, stream)
                return _unique_parts([candidate for part in parts
                                      for candidate in _split_prompt(legacy_expand_choices(part, rng))
                                      if not prompt._is_empty_weighted_part(candidate)])

            for seed in (0, 1, 123, (1 << 64) - 1):
                expected_parts = _merge_positive_negative_parts(
                    legacy_parts(row["positive_parts"], seed, "positive"),
                    legacy_parts(row["negative_parts"], seed, "negative"), [], [],
                )
                expected = tuple(", ".join(parts) for parts in expected_parts)
                expanded = nodes.ScenePromptExpand().expand(scene_prompt=plan, seed_base=seed,
                                                            seed_base_literal=True, timestamp_dir=False)
                text = nodes.ScenePromptToText().to_text(scene_prompt=plan, seed_base=seed, seed_base_literal=True)
                self.assertEqual(expanded[:2], expected)
                self.assertEqual(text, expected)
                self.assertEqual((expanded[2]["positive"], expanded[2]["negative"]), expected)
            self.assertEqual(json.dumps(plan), original)

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
        test_missing_partial_selection_is_valid_but_not_emitted()


class PromptWeightDeduplicationTests(unittest.TestCase):
    def assert_winners(self, parts, expected):
        original = list(parts)
        self.assertEqual(_unique_parts(parts), expected)
        self.assertEqual(_join_unique(parts, ", "), ", ".join(expected))
        self.assertEqual(parts, original)

    def test_highest_weight_replaces_in_place_and_plain_tags_count_as_one(self):
        self.assert_winners(
            ["test", "between", "(test:1.4)", "after", "(test:1.2)"],
            ["(test:1.4)", "between", "after"],
        )
        self.assert_winners(["(test:.5)", "between", "test", "(test:-2)"], ["test", "between"])

    def test_equal_weights_preserve_the_first_spelling_and_position(self):
        self.assert_winners(["(Test:1.0)", "test", "(TEST:1.)"], ["(Test:1.0)"])
        self.assert_winners(["test", "(Test:1.0)"], ["test"])
        self.assert_winners(
            ["before", "( Tag   Name :1.40)", "middle", "(tag name:+1.4)"],
            ["before", "( Tag   Name :1.40)", "middle"],
        )

    def test_all_finite_float_spellings_are_compared(self):
        for spelling, expected in (("1.", "test"), (".5", "test"), ("+1.2", "(test:+1.2)"),
                                   ("1e-1", "test"), ("1E+1", "(test:1E+1)"),
                                   ("  +1.2  ", "(test:  +1.2  )"), ("1_0", "(test:1_0)")):
            with self.subTest(spelling=spelling):
                self.assert_winners(["test", f"(test:{spelling})"], [expected])

    def test_nested_weights_compare_the_innermost_explicit_weight_like_comfy(self):
        # ComfyUI comfy/sd1_clip.py token_weights assigns each explicit float
        # before descending into the next wrapper; it does not multiply them.
        self.assert_winners(
            ["((test:4):0.5)", "between", "(test:1.2)", "((test:0.1):1.3)"],
            ["((test:4):0.5)", "between"],
        )
        self.assert_winners(["((test:0.1):4)", "between", "(test:1.2)"], ["(test:1.2)", "between"])
        self.assert_winners(["((Test:1.2):4)", "(test:1.2)"], ["((Test:1.2):4)"])
        self.assert_winners(["(((test:1_0):0.5):1e-1)", "(test:9.)"], ["(((test:1_0):0.5):1e-1)"])
        self.assert_winners(["( ( (Test: +1.4 ) : 0.1 ) : 3 )", "(test:1.2)"], ["( ( (Test: +1.4 ) : 0.1 ) : 3 )"])

    def test_other_syntax_and_nonfinite_weights_remain_distinct(self):
        parts = ["test", "(test)", "[test]", "(test;1.4)", "<lora:test:1>",
                 "(test:nan)", "(test:inf)", "(test:-inf)", "(test:1e999)", "(test:invalid)",
                 "((test:2):nan)"]
        self.assert_winners(parts, parts)
        self.assert_winners(["test", "(test)", "((test):2)"], ["test", "((test):2)"])
        self.assert_winners(["test", "(test:nan)", "((test:nan):2)"], ["test", "((test:nan):2)"])

    def test_negative_precedence_is_independent_of_weight(self):
        self.assertEqual(
            _merge_positive_negative_parts(
                ["(shared:5)", "only_positive", "(keep:1.1)"], ["(shared:.1)", "negative"],
                ["(keep:1.3)"], ["(negative:1.4)", "shared"],
            ),
            (["only_positive", "(keep:1.3)"], ["shared", "(negative:1.4)"]),
        )

    def test_choices_select_the_strongest_expanded_tag(self):
        for stream in ("positive", "negative"):
            with self.subTest(stream=stream):
                outputs = {
                    tuple(_expand_prompt_parts(["before", "{test|(test:1.4)}", "(test:1.2)", "after"], seed, stream))
                    for seed in range(32)
                }
                self.assertEqual(outputs, {("before", "(test:1.2)", "after"), ("before", "(test:1.4)", "after")})
        self.assertEqual(_expand_prompt_parts(["({|}:1e-1)", "keep"], 1, "positive"), ["keep"])
        self.assertEqual(_expand_prompt_parts(["{((test:4):.5)|((test:4):.5)}", "(test:1.2)"], 1, "positive"), ["((test:4):.5)"])

    def test_join_preserves_explicit_seen_key_filtering(self):
        seen = {"test"}
        self.assertEqual(_join_unique(["test", "(test:1.2)", "after"], ", ", seen), "(test:1.2), after")
        self.assertEqual(seen, {"test"})


if __name__ == "__main__":
    unittest.main()
