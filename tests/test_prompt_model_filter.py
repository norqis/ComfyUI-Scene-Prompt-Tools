"""Model-specific prompt additions stay lazy until the Expand consumer selects a row."""
import copy
import importlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_scene_prompt_reverse import load_modules
from test_preset_metadata import outer_workflow, scene_prompt


class PromptModelFilterTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        modules = load_modules(Path(temporary.name))
        self.nodes, self.plan = modules['nodes'], modules['plan']
        self.prompt, self.presets = modules['prompt'], modules['presets']
        self.schedule = importlib.import_module(self.plan.__package__ + '.schedule')
        self.runs = importlib.import_module(self.plan.__package__ + '.runs')

    def build(self, name, positive='', negative='', mode=None, source=None, **kwargs):
        if mode is not None:
            kwargs['model_mode'] = mode
        return self.prompt.ScenePrompt().build(name, positive, self.prompt.DEFAULT_SELECTED_JSON,
            negative, self.prompt.DEFAULT_SELECTED_JSON, '', 0, False, scene_prompt=source,
            unique_id=name, source_node_name=name, filename_enabled=True, **kwargs)[0]

    def expand(self, plan, mode='Illustrious', **kwargs):
        return self.nodes.ScenePromptExpand().expand(scene_prompt=plan, model_mode=mode, seed_base=123,
            replace_underscores=False, convert_anima_weights=False, **kwargs)

    def row(self, plan, mode=None, index=0):
        return self.plan.item_for_normalized_plan(plan, index, 123, model_mode=mode)['row']

    def test_each_mode_all_legacy_omission_and_shared_plan_independence(self):
        modes = self.plan.MODEL_MODE_CHOICES
        self.assertEqual(self.prompt.ScenePrompt.INPUT_TYPES()['optional']['model_mode'][0],
                         ('全モデル', *modes))
        for prompt_mode in modes:
            plan = self.build('restricted', '(cat:1.4), own', 'bad', prompt_mode)
            original = copy.deepcopy(plan)
            for expand_mode in (*modes, *reversed(modes)):
                active = prompt_mode == expand_mode
                result = self.expand(plan, expand_mode)
                self.assertEqual(result[:2], ('(cat:1.4), own', 'bad') if active else ('', ''))
                self.assertEqual(result[2]['filename_suffix'], 'restricted' if active else '')
                row = self.row(plan, expand_mode)
                self.assertEqual(row['labels'], ['restricted'] if active else [])
                self.assertEqual(row['source_node_ids'], ['restricted'])
                self.assertEqual(row['source_node_names'], {'restricted': 'restricted'} if active else {})
            self.assertEqual(plan, original)
            self.assertEqual(self.nodes.ScenePromptToText().to_text(plan, seed_base=123),
                             ('(cat:1.4), own', 'bad'))
        for mode in (None, '全モデル'):
            plan = self.build('all', 'cat', 'bad', mode)
            self.assertEqual(plan['units'][0]['kind'], 'run', 'unrestricted prompts keep the scalar fast path')
            for consumer_mode in modes:
                self.assertEqual(self.expand(plan, consumer_mode)[:2], ('cat', 'bad'))
        empty_id = self.prompt.ScenePrompt().build('', 'cat', self.prompt.DEFAULT_SELECTED_JSON, '',
            self.prompt.DEFAULT_SELECTED_JSON, '', 0, False, model_mode='Anima')[0]
        self.assertEqual(self.row(empty_id, 'Anima')['source_node_ids'], [])

    def test_inactive_negative_does_not_erase_upstream_and_weights_only_compete_when_active(self):
        base = self.build('base', '(cat:1.1), keep', 'bad')
        plan = self.build('anima', '(cat:1.8), extra', 'keep', 'Anima', base)
        self.assertEqual(self.expand(plan)[:2], ('(cat:1.1), keep', 'bad'))
        self.assertEqual(self.expand(plan, 'Anima')[:2], ('(cat:1.8), extra', 'bad, keep'))
        plan = self.build('pony', '(cat:2.5)', mode='Pony', source=plan)
        self.assertEqual(self.expand(plan, 'Anima')[0], '(cat:1.8), extra')
        self.assertEqual(self.expand(plan, 'Pony')[0], '(cat:2.5), keep')

    def test_delete_reverse_and_callback_snapshots_follow_filtered_order(self):
        base = self.build('base', 'cat, keep', 'base_bad')
        plan = self.build('restricted', 'own', 'own_bad', 'Anima', base)
        callback = self.plan.append_callback(plan, 'callback', {'type': 'request'}, '毎回', 10, '続行')
        for mode, expected in [('Illustrious', ('cat, keep', 'base_bad')),
                               ('Anima', ('cat, keep, own', 'base_bad, own_bad'))]:
            row = self.row(callback, mode)
            snapshot = row['callbacks'][0]
            self.assertEqual(snapshot['current_positive_parts'], row['positive_parts'])
            self.assertEqual(snapshot['current_negative_parts'], row['negative_parts'])
            self.assertEqual(snapshot['current_source_node_ids'], ['base', 'restricted'])
            names = self.nodes._callback_names(row, snapshot['current_source_node_ids'])
            self.assertEqual(names, 'base_restricted' if mode == 'Anima' else 'base')
            self.assertEqual(self.expand(plan, mode)[:2], expected)
        previous = self.nodes.ScenePromptReverse().reverse(plan, '直前のノード')[0]
        self.assertEqual(self.expand(previous)[:2], ('cat, keep', 'base_bad'))
        self.assertEqual(self.expand(previous, 'Anima')[:2], ('cat, keep, own_bad', 'base_bad, own'))
        all_reversed = self.nodes.ScenePromptReverse().reverse(plan, '全てのノード')[0]
        self.assertEqual(self.expand(all_reversed)[:2], ('base_bad', 'cat, keep'))
        deleted = self.nodes.ScenePromptDelete().delete('cat, own', 'own_bad', plan)[0]
        self.assertEqual(self.expand(deleted)[:2], ('keep', 'base_bad'))
        self.assertEqual(self.expand(deleted, 'Anima')[:2], ('keep', 'base_bad'))

    def test_merge_matrix_queue_and_huge_count_keep_event_order_without_expansion(self):
        a = self.build('A', 'a', mode='Anima')
        b = self.build('B', 'b', mode='Pony')
        merged = self.nodes.ScenePromptMerge().merge(a, b)[0]
        self.assertEqual(self.expand(merged, 'Anima')[0], 'a')
        self.assertEqual(self.expand(merged, 'Pony')[0], 'b')
        matrix = self.nodes.SceneMatrix().build(json.dumps({'version': 1, 'sets': [
            {'row_id': 'm1', 'name': 'M1', 'path_label': 'M1', 'positive_parts': ['m1'], 'negative_parts': []},
            {'row_id': 'm2', 'name': 'M2', 'path_label': 'M2', 'positive_parts': ['m2'], 'negative_parts': []},
        ]}), scene_prompt=merged)[0]
        for count_mode in ('fixed', 'multiply'):
            queue = self.nodes.ScenePromptQueue().queue(scene_prompt1=matrix, scene_prompt2=b,
                order_mode='alternate', alternate_block_size=2, downstream_count_mode=count_mode)[0]
            counted = self.nodes.ScenePromptCounter().count(queue, 3)[0]
            self.assertEqual(counted['stats']['total_batches'], 6 if count_mode == 'fixed' else 18)
            for index in range(counted['stats']['total_batches']):
                items = [self.plan.item_for_normalized_plan(counted, index, model_mode=mode)
                         for mode in ('Anima', 'Pony')]
                self.assertEqual(items[0]['event_ref'], items[1]['event_ref'])
                self.assertEqual(items[0]['count'], items[1]['count'])
                self.assertNotIn("b", items[0]["row"]["positive_parts"])
                self.assertNotIn("a", items[1]["row"]["positive_parts"])
        counted = self.nodes.ScenePromptCounter().count(merged, 10**12)[0]
        with mock.patch.object(self.schedule, 'legacy_rows', side_effect=AssertionError('materialized rows')):
            self.assertEqual(self.expand(counted, 'Pony', current_index=10**12 - 1)[0], 'b')
        self.assertLess(len(json.dumps(counted)), 8000)

    def test_mode_changes_prompt_cache_key(self):
        arguments = dict(prompt_name='x', positive_base='cat', positive_json=self.prompt.DEFAULT_SELECTED_JSON,
            negative_base='', negative_json=self.prompt.DEFAULT_SELECTED_JSON, category_order='', seed=0, randomize=False)
        keys = [self.prompt.ScenePrompt.IS_CHANGED(**arguments, model_mode=mode)
                for mode in self.plan.PROMPT_MODEL_MODE_CHOICES]
        self.assertEqual(len(set(keys)), 5)
        self.assertNotIn('model_mode', self.nodes.ScenePromptToText.INPUT_TYPES()['optional'])

    def test_nested_and_matrix_presets_keep_mode_and_primitive_inputs(self):
        child = {'1': {'class_type': 'ScenePresetInput', 'inputs': {}},
                 '2': scene_prompt('child', ['1', 0]),
                 '3': {'class_type': 'ScenePresetOutput', 'inputs': {'scene_prompt': ['2', 0]}},
                 '4': {'class_type': 'PrimitiveString', 'inputs': {'value': 'Anima'}}}
        child['2']['inputs'].update(model_mode=['4', 0], filename_enabled=True)
        self.presets.save_preset({'preset_id': 'model-child', 'name': 'Model child', 'output_node_id': '3',
            'api_graph': {'output': child}, 'workflow': outer_workflow(child)})
        parent = {'1': {'class_type': 'ScenePresetInput', 'inputs': {}},
                  '2': {'class_type': 'ScenePresetReference', 'inputs': {'preset_id': 'model-child', 'scene_prompt': ['1', 0]}},
                  '3': {'class_type': 'ScenePresetOutput', 'inputs': {'scene_prompt': ['2', 0]}}}
        visual = outer_workflow(parent)
        next(node for node in visual['nodes'] if str(node['id']) == '2')['widgets_values'] = ['model-child']
        self.presets.save_preset({'preset_id': 'model-parent', 'name': 'Model parent', 'output_node_id': '3',
            'api_graph': {'output': parent}, 'workflow': visual})
        base = self.build('base', 'base')
        nested = self.presets.expand_preset_reference('model-parent', scene_prompt=base, source_node_id='ref')
        matrix = self.nodes.SceneMatrix().build(json.dumps({'version': 1, 'sets': [
            {'row_id': 'p', 'name': 'Preset', 'path_label': 'Preset', 'row_kind': 'preset',
             'preset_id': 'model-parent', 'positive_base': 'matrix'},
        ]}), scene_prompt=base, unique_id='matrix')[0]
        for mode in self.plan.MODEL_MODE_CHOICES:
            active = mode == 'Anima'
            self.assertEqual(self.expand(nested, mode)[0], 'base, child' if active else 'base')
            self.assertEqual(self.expand(matrix, mode)[0], 'base, child, matrix' if active else 'base, matrix')
            self.assertEqual(self.row(nested, mode)['filename_parts'], ['base', 'child'] if active else ['base'])

    def test_queue_branch_pruning_rebases_inactive_prompt_and_seed(self):
        handle = self.runs.create_run_context('default')
        self.addCleanup(self.runs.release_run_context, handle, 'default')
        graph = {}
        for source, counter, label in [('1', '11', 'unused'), ('2', '12', 'chosen'), ('3', '13', 'tail')]:
            graph[source] = scene_prompt(label)
            graph[source]['inputs'].update(model_mode='Anima', filename_enabled=True)
            graph[counter] = {'class_type': 'ScenePromptCounter', 'inputs': {'scene_prompt': [source, 0], 'count': 3}}
        graph['20'] = {'class_type': 'ScenePrompterQueue', 'inputs': {
            'scene_prompt1': ['11', 0], 'scene_prompt2': ['12', 0], 'scene_prompt3': ['13', 0]}}
        graph['21'] = {'class_type': 'ScenePrompterExpand', 'inputs': {
            'scene_prompt': ['20', 0], 'current_index': 4, 'seed_base': 123, 'run_handle': handle, 'model_mode': 'Pony'}}
        graph['22'] = {'class_type': 'TestImage', 'inputs': {'text': ['21', 0]}}
        graph['23'] = {'class_type': 'SceneSaveImage', 'inputs': {'images': ['22', 0]}}
        plan = self.presets._scene_node_value(graph, '20', {}, set())
        expected = self.expand(plan, 'Pony', current_index=4, run_handle=handle, unique_id='21')
        for metadata in (False, True):
            with self.subTest(metadata=metadata):
                saved, _extra = self.nodes._metadata_for_save_mode(graph, {'workflow': outer_workflow(graph)}, '23',
                    self.nodes.SAVE_METADATA_EXECUTION_PATH, expected[2] if metadata else None)
                self.assertIn('2', saved)
                self.assertNotIn('1', saved)
                self.assertNotIn('3', saved)
                self.assertEqual(saved['21']['inputs']['current_index'], 1)
                self.assertEqual(saved['21']['inputs']['seed_base'], 126)
                replay = self.presets._scene_node_value(saved, saved['21']['inputs']['scene_prompt'][0], {}, set())
                replayed = self.nodes.ScenePromptExpand().expand(scene_prompt=replay, model_mode='Pony', current_index=1,
                    seed_base=126, seed_base_literal=True)
                self.assertEqual(replayed[:2], expected[:2])
                self.assertEqual(replayed[2]['seed'], expected[2]['seed'])

    def test_random_replay_protects_conditional_prompt_sources_inside_each_arm(self):
        arms = self.nodes.ScenePromptRandomRoute().route(weights_json=json.dumps([5000, 5000] + [0] * 8), unique_id='gate')
        a = self.build('armA', 'a', mode='Anima', source=arms[0])
        b = self.build('armB', 'b', mode='Pony', source=arms[1])
        joined = self.nodes.ScenePromptRandomRouteOutput().join(scene_prompt1=a, scene_prompt2=b)[0]
        sources = self.plan.random_replay_source_ids([joined], {'gate'})
        self.assertTrue({'armA', 'armB'}.issubset(sources))

    def test_queue_random_png_execution_path_replays_inactive_prompts_and_linked_mode(self):
        for random in (False, True):
            for metadata in (False, True):
                with self.subTest(random=random, metadata=metadata):
                    handle = self.runs.create_run_context('default')
                    self.addCleanup(self.runs.release_run_context, handle, 'default')
                    graph = {'1': scene_prompt('base'), '2': scene_prompt('inactive')}
                    graph['2']['inputs'].update(scene_prompt=['1', 0], model_mode='Anima', filename_enabled=True)
                    if random:
                        graph['3'] = {'class_type': 'ScenePromptRandomRoute', 'inputs': {
                            'scene_prompt': ['2', 0], 'weights_json': json.dumps([5000, 5000] + [0] * 8), 'preserve_join': True}}
                        graph['4'] = {'class_type': 'ScenePromptRandomRouteOutput', 'inputs': {
                            'scene_prompt1': ['3', 0], 'scene_prompt2': ['3', 1]}}
                    else:
                        graph['4'] = {'class_type': 'ScenePrompterQueue', 'inputs': {'scene_prompt1': ['2', 0]}}
                    graph.update({'5': {'class_type': 'ScenePromptCounter', 'inputs': {'scene_prompt': ['4', 0], 'count': 4}},
                        '6': {'class_type': 'PrimitiveString', 'inputs': {'value': 'Pony'}},
                        '7': {'class_type': 'ScenePrompterExpand', 'inputs': {'scene_prompt': ['5', 0], 'model_mode': ['6', 0],
                            'current_index': 2, 'seed_base': 123, 'run_handle': handle}},
                        '8': {'class_type': 'TestImage', 'inputs': {'text': ['7', 0]}},
                        '9': {'class_type': 'SceneSaveImage', 'inputs': {'images': ['8', 0]}}})
                    plan = self.presets._scene_node_value(graph, '5', {}, set())
                    result = self.expand(plan, 'Pony', current_index=2, run_handle=handle, unique_id='7')
                    self.assertEqual(result[0], 'base')
                    self.assertEqual(self.runs.get_run_consumer_selection(handle, '7')[3], 'Pony')
                    saved, _extra = self.nodes._metadata_for_save_mode(graph, {'workflow': outer_workflow(graph)},
                        '9', self.nodes.SAVE_METADATA_EXECUTION_PATH, result[2] if metadata else None)
                    self.assertIn('2', saved, 'inactive prompt remains a structural replay ancestor')
                    replay = self.presets._scene_node_value(saved, saved['7']['inputs']['scene_prompt'][0], {}, set())
                    arguments = {name: saved['7']['inputs'][name] for name in ('current_index', 'seed_base', 'seed_base_literal')}
                    replayed = self.nodes.ScenePromptExpand().expand(scene_prompt=replay, model_mode='Pony',
                        replace_underscores=False, convert_anima_weights=False, **arguments)
                    self.assertEqual(replayed[:2], result[:2])
                    self.assertEqual(replayed[2]['filename_suffix'], result[2]['filename_suffix'])
                    self.assertEqual(replayed[2]['seed'], result[2]['seed'])


if __name__ == '__main__':
    unittest.main()
