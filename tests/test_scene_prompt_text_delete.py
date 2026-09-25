import copy
import importlib
import tempfile
import unittest
from pathlib import Path

from test_scene_prompt_reverse import load_modules, add_prompt
from test_preset_metadata import outer_workflow, scene_prompt


class ScenePromptTextDeleteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.modules = load_modules(Path(self.temp.name))
        self.nodes = self.modules['nodes']
        self.plan = self.modules['plan']
        self.prompt = self.modules['prompt']
        self.presets = self.modules['presets']
        self.runs = importlib.import_module(self.nodes.__package__ + '.runs')

    def tearDown(self):
        self.temp.cleanup()

    def build(self, positive, negative='', upstream=None, node_id='source'):
        return add_prompt(self.prompt, node_id, positive, negative, upstream, node_id)

    def text(self, plan=None, **kwargs):
        return self.nodes.ScenePromptToText().to_text(scene_prompt=plan, seed_base=123, **kwargs)

    def test_to_text_selects_one_row_and_repeat_with_strict_bounds(self):
        a, b, c = [self.build(value, node_id=value) for value in ('A', 'B', 'C')]
        b = self.nodes.ScenePromptCounter().count(count=2, scene_prompt=b)[0]
        plan = self.nodes.ScenePromptQueue().queue(scene_prompt1=a, scene_prompt2=b, scene_prompt3=c)[0]
        self.assertEqual([self.text(plan, current_index=i) for i in range(4)], [('A', ''), ('B', ''), ('B', ''), ('C', '')])
        for index in (-1, 4):
            with self.assertRaises(IndexError): self.text(plan, current_index=index)
        self.assertEqual(self.text(), ('', ''))
        with self.assertRaises(IndexError): self.text(current_index=1)
        self.assertFalse(hasattr(self.nodes.ScenePromptToText, 'OUTPUT_IS_LIST'))
        self.assertNotIn('ScenePromptToText', self.nodes.SCENE_NODE_TYPES)
        self.assertNotIn('ScenePromptToText', self.presets.SAFE_NODE_CLASSES)

    def test_previous_scope_delta_whole_passthrough_and_legacy(self):
        previous = self.nodes.TEXT_SCOPE_PREVIOUS
        a = self.build('base', 'bad')
        b = self.build('added', 'newbad', a)
        self.assertEqual(self.text(b), ('base, added', 'bad, newbad'))
        self.assertEqual(self.text(b, scope=previous), ('added', 'newbad'))
        self.assertEqual(self.text(self.plan.mark_prompt_whole(b), scope=previous), self.text(b))
        self.assertEqual(self.text(self.plan.mark_prompt_passthrough(b), scope=previous), ('', ''))
        legacy = self.plan.transform(b, lambda row, _: {key: value for key, value in row.items() if key != 'prompt_trace'})
        self.assertEqual(self.text(legacy, scope=previous), self.text(b))

    def test_to_text_choices_match_expand_and_resolve_conflicts_after_choice(self):
        plan = self.nodes.ScenePromptCounter().count(count=5, scene_prompt=self.build('{same|one|two}', '{same}'))[0]
        for index in range(5):
            for scope in self.nodes.TEXT_SCOPE_CHOICES:
                candidate = self.plan.mark_prompt_whole(plan)
                text = self.text(candidate, current_index=index, scope=scope)
                expanded = self.nodes.ScenePromptExpand().expand(scene_prompt=candidate, current_index=index, seed_base=123)
                self.assertEqual(text, expanded[:2])
                self.assertNotIn('{', text[0])
                self.assertNotIn('same', text[0])

    def test_to_text_caches_plan_per_node_and_changes_execution_identity(self):
        handle = self.runs.create_run_context('default')
        first = self.build('one')
        second = self.build('two')
        self.assertEqual(self.text(first, run_handle=handle, unique_id='1'), ('one', ''))
        self.assertEqual(self.text(second, run_handle=handle, unique_id='2'), ('two', ''))
        self.assertEqual(self.text(None, run_handle=handle, unique_id='1'), ('one', ''))
        changed = self.nodes.ScenePromptToText.IS_CHANGED
        base = dict(scene_prompt=first, seed_base=1)
        baseline = changed(**base)
        for name, value in [('scene_prompt', second), ('scope', self.nodes.TEXT_SCOPE_PREVIOUS), ('current_index', 1), ('seed_base', 2), ('seed_base_literal', True), ('run_handle', handle)]:
            self.assertNotEqual(baseline, changed(**{**base, name: value}), name)

    def test_delete_exact_weight_case_whitespace_sides_and_later_additions(self):
        source = self.build('(BALD:1.4), bald head, messy   hair, keep', 'bald, messy hair')
        original = copy.deepcopy(source)
        deleted = self.nodes.ScenePromptDelete().delete(' (bald:0.5)\n messy hair ', 'messy hair', source, unique_id='delete')[0]
        row = deleted['rows'][0]['row']
        self.assertEqual(row['positive_parts'], ['bald head', 'keep'])
        self.assertEqual(row['negative_parts'], ['bald'])
        self.assertEqual(row['prompt_trace']['kind'], 'passthrough')
        self.assertIn('delete', row['source_node_ids'])
        self.assertEqual(source, original)
        later = self.nodes.ScenePromptDelete().delete('bald', '', self.build('bald, keep'))[0]
        self.assertEqual(self.text(self.build('bald', upstream=later)), ('keep, bald', ''))
        self.assertEqual(self.text(self.nodes.ScenePromptDelete().delete()[0]), ('', ''))
        self.assertEqual(self.text(self.nodes.ScenePromptDelete().delete('', '', source)[0]), self.text(source))

    def test_delete_choice_slots_nested_and_empty_choices(self):
        examples = {
            '{bald}': '{}', '{bald|bald}': '{|}', '{bald||hair}': '{||hair}',
            '{bald, 1girl|hair}': '{1girl|hair}', '{(bald:1.4), 1girl|hair}': '{1girl|hair}',
            '{{bald|hair}|bald}': '{{|hair}|}', '{ hair , coat | hat }': '{ hair , coat | hat }', 'prefix {unclosed': 'prefix {unclosed',
        }
        for value, expected in examples.items():
            with self.subTest(value=value):
                deleted = self.nodes.ScenePromptDelete().delete('bald', '', self.build(value))[0]
                self.assertEqual(deleted['rows'][0]['row']['positive_parts'], [expected])
                for seed in range(12):
                    result = self.nodes.ScenePromptExpand().expand(scene_prompt=deleted, seed_base=seed, seed_base_literal=True)
                    if value != 'prefix {unclosed': self.assertNotIn('{', result[0])
                    self.assertNotIn('bald', result[0])
        class CountingRng:
            calls = 0
            def choice(self, options):
                self.calls += 1
                return options[0]
        rng = CountingRng()
        self.assertEqual(self.prompt._expand_choices('{}', rng), '')
        self.assertEqual(rng.calls, 1)

    def workflow(self, prompt):
        workflow = outer_workflow(prompt)
        for node in workflow['nodes']:
            if node['type'] == 'ScenePromptToText': node['widgets_values'] = [self.nodes.TEXT_SCOPE_ALL, 2, 100, False]
            if node['type'] == 'ScenePrompterExpand': node['widgets_values'] = [2, '', 100, False, '', '最後', 'Illustrious', False, False, '停止', False]
        return workflow

    def test_png_rebases_each_plan_independently_with_and_without_preset_expansion(self):
        for in_preset in (False, True):
            for expand_contents in ((False, True) if in_preset else (False,)):
                with self.subTest(in_preset=in_preset, expand_contents=expand_contents):
                    handle = self.runs.create_run_context('default')
                    prompt = {}
                    plans = {}
                    for node_id, label, count in [('1', 'A', 2), ('2', 'B', 2), ('3', 'X', 1), ('4', 'Y', 3)]:
                        value = label + ', {red|blue|green}'
                        prompt[node_id] = scene_prompt(value)
                        prompt[node_id]['inputs']['source_node_id'] = node_id
                        plans[node_id] = self.build(value, node_id=node_id)
                        count_id = str(int(node_id) + 10)
                        prompt[count_id] = {'class_type': 'ScenePromptCounter', 'inputs': {'scene_prompt': [node_id, 0], 'count': count, 'source_node_id': count_id}}
                        plans[count_id] = self.nodes.ScenePromptCounter().count(count=count, scene_prompt=plans[node_id], unique_id=count_id)[0]
                    for queue_id, first, second in [('21', '11', '12'), ('22', '13', '14')]:
                        prompt[queue_id] = {'class_type': 'ScenePrompterQueue', 'inputs': {'scene_prompt1': [first, 0], 'scene_prompt2': [second, 0], 'source_node_id': queue_id}}
                        plans[queue_id] = self.nodes.ScenePromptQueue().queue(scene_prompt1=plans[first], scene_prompt2=plans[second], unique_id=queue_id)[0]
                    if in_preset:
                        inner_ids = ('3', '4', '13', '14', '22')
                        inner = {key: prompt.pop(key) for key in inner_ids}
                        inner['80'] = {'class_type': 'ScenePresetInput', 'inputs': {}}
                        inner['3']['inputs']['scene_prompt'] = ['80', 0]
                        inner['4']['inputs']['scene_prompt'] = ['80', 0]
                        inner['81'] = {'class_type': 'ScenePresetOutput', 'inputs': {'scene_prompt': ['22', 0]}}
                        preset_id = 'text-plan'
                        self.presets.save_preset({'preset_id': preset_id, 'name': preset_id, 'output_node_id': '81', 'api_graph': {'output': inner}, 'workflow': self.workflow(inner)})
                        prompt['22'] = {'class_type': 'ScenePresetReference', 'inputs': {'preset_id': preset_id}}
                    prompt.update({
                        '30': {'class_type': 'ScenePrompterExpand', 'inputs': {'scene_prompt': ['21', 0], 'current_index': 2, 'seed_base': 100}},
                        '31': {'class_type': 'ScenePromptToText', 'inputs': {'scene_prompt': ['22', 0], 'current_index': 2, 'seed_base': 100}},
                        '32': {'class_type': 'TestImage', 'inputs': {'latent': ['30', 4], 'positive': ['31', 0]}},
                        '33': {'class_type': 'SceneSaveImage', 'inputs': {'images': ['32', 0], 'scene_info': ['30', 2]}},
                        '99': scene_prompt('unused'),
                    })
                    if in_preset:
                        resolved = self.presets.snapshot_presets_for_run(handle, {'output': prompt}, '30')
                        self.assertEqual(resolved['total_batches'], 4)
                        self.assertEqual([entry['preset_id'] for entry in resolved['presets']], ['text-plan'])
                        snapshots = self.presets.snapshot_presets_for_metadata(handle)
                        # Runtime preset expansion namespaces every Scene source.
                        graph = self.presets.expand_preset_reference('text-plan', run_handle=handle, source_node_id='22')['expand']
                        source = '__scene_preset_source'
                        plans['22'] = self.presets._scene_node_value(graph, source, snapshots, set())
                    expected_text = self.nodes.ScenePromptToText().to_text(plans['22'], current_index=2, seed_base=100, run_handle=handle, unique_id='31')
                    expanded = self.nodes.ScenePromptExpand().expand(scene_prompt=plans['21'], current_index=2, seed_base=100, run_handle=handle, unique_id='30', prompt=prompt)
                    saved, extra = self.nodes._metadata_for_save_mode(prompt, {'workflow': self.workflow(prompt)}, '33', self.nodes.SAVE_METADATA_EXECUTION_PATH, expanded[2], expand_preset_contents=expand_contents)
                    self.assertNotIn('1', saved)
                    self.assertNotIn('99', saved)
                    self.assertEqual(saved['30']['inputs']['current_index'], 0)
                    expected_index = 2 if in_preset and not expand_contents else 1
                    self.assertEqual(saved['31']['inputs']['current_index'], expected_index)
                    self.assertEqual(saved['31']['inputs']['seed_base'], 102 - expected_index)
                    widgets = next(node['widgets_values'] for node in extra['workflow']['nodes'] if str(node['id']) == '31')
                    self.assertEqual(widgets[1:4], [expected_index, 102 - expected_index, False])
                    # Evaluate the retained source graph and reproduce choices with each consumer's new seed.
                    replay_plans = self.presets.snapshot_presets_for_metadata(handle) if in_preset else {}
                    for consumer_id in ('30', '31'):
                        inputs = saved[consumer_id]['inputs']
                        plan = self.presets._scene_node_value(saved, inputs['scene_prompt'][0], replay_plans, set())
                        values = {name: inputs[name] for name in ('current_index', 'seed_base', 'seed_base_literal')}
                        if consumer_id == '31': self.assertEqual(self.nodes.ScenePromptToText().to_text(plan, **values), expected_text)
                        else: self.assertEqual(self.nodes.ScenePromptExpand().expand(scene_prompt=plan, **values)[:2], expanded[:2])

    def test_execution_path_keeps_text_previous_node_when_expand_model_is_superseded(self):
        handle = self.runs.create_run_context('default')
        first = self.plan.with_source_node(self.plan.mark_prompt_passthrough(self.build('base', node_id='1')), '2')
        final = self.plan.with_source_node(self.plan.mark_prompt_passthrough(first), '3')
        prompt = {
            '1': scene_prompt('base'),
            '2': {'class_type': 'SceneApplyModel', 'inputs': {'scene_prompt': ['1', 0]}},
            '3': {'class_type': 'SceneApplyModel', 'inputs': {'scene_prompt': ['2', 0]}},
            '4': {'class_type': 'ScenePrompterExpand', 'inputs': {'scene_prompt': ['3', 0]}},
            '5': {'class_type': 'ScenePromptToText', 'inputs': {'scene_prompt': ['2', 0], 'scope': self.nodes.TEXT_SCOPE_PREVIOUS}},
            '6': {'class_type': 'Save', 'inputs': {'text': ['5', 0], 'info': ['4', 2]}},
        }
        self.assertEqual(self.text(first, scope=self.nodes.TEXT_SCOPE_PREVIOUS, run_handle=handle, unique_id='5'), ('', ''))
        expanded = self.nodes.ScenePromptExpand().expand(scene_prompt=final, seed_base=123, unique_id='4', run_handle=handle, prompt=prompt)
        saved, _ = self.nodes._metadata_for_save_mode(prompt, None, '6', self.nodes.SAVE_METADATA_EXECUTION_PATH, expanded[2])
        self.assertIn('2', saved, 'the previous contribution must remain passthrough on replay')
        self.assertEqual(saved['5']['inputs']['scene_prompt'], ['2', 0])

    def test_execution_path_requires_executed_text_plan(self):
        prompt = {'1': {'class_type': 'ScenePromptToText', 'inputs': {}}, '2': {'class_type': 'Save', 'inputs': {'text': ['1', 0]}}}
        with self.assertRaisesRegex(ValueError, 'Scene Prompt To Text'):
            self.nodes._metadata_for_save_mode(prompt, None, '2', self.nodes.SAVE_METADATA_EXECUTION_PATH, {'file_index': 1, 'seed': 10})

    def test_delete_roundtrips_through_preset_and_reference(self):
        from test_scene_presets import basic_nodes
        graph = basic_nodes('bald, hair')
        graph['4'] = {'class_type': 'ScenePromptDelete', 'inputs': {'scene_prompt': ['2', 0], 'positive': 'bald', 'negative': ''}}
        graph['3']['inputs']['scene_prompt'] = ['4', 0]
        saved = self.presets.save_preset({'preset_id': 'delete', 'name': 'delete', 'output_node_id': '3', 'api_graph': {'output': graph}, 'workflow': self.workflow(graph)})
        plan = self.presets._evaluate_preset_scene(saved, {}, None)
        self.assertEqual(self.text(plan), ('hair', ''))
        outer = {'5': {'class_type': 'ScenePresetReference', 'inputs': {'preset_id': 'delete'}}}
        self.assertEqual(self.text(self.presets._scene_node_value(outer, '5', {'delete': saved}, set())), ('hair', ''))
        handle = self.runs.create_run_context('default')
        outer.update({
            '10': {'class_type': 'ScenePromptCounter', 'inputs': {'count': 2}},
            '11': {'class_type': 'ScenePrompterExpand', 'inputs': {'scene_prompt': ['10', 0]}},
            '20': {'class_type': 'ScenePromptCounter', 'inputs': {'scene_prompt': ['5', 0], 'count': 100}},
            '21': {'class_type': 'ScenePromptToText', 'inputs': {'scene_prompt': ['20', 0]}},
        })
        snapshot = self.presets.snapshot_presets_for_run(handle, {'output': outer}, '11')
        self.assertEqual(snapshot['total_batches'], 2)
        self.assertEqual([preset['preset_id'] for preset in snapshot['presets']], ['delete'])


if __name__ == '__main__':
    unittest.main()
