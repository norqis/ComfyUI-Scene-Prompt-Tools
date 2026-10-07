import copy
import importlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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

    def test_internal_preset_boundary_preserves_open_random_branch(self):
        arm, other, *_ = self.plan.random_route(self.build('base'), [5000, 5000] + [0] * 8, 'gate')
        counter = self.nodes.ScenePromptCounter()
        marked = counter.count(arm, 1, prompt_trace_kind='whole', source_node_id='reference')[0]
        self.assertEqual(marked['random_guards'], arm['random_guards'])
        joined = self.plan.queue([marked, other])
        self.assertEqual(self.text(joined), ('base', ''))
        for count, downstream, kind in ((1, True, ''), (2, True, 'whole'), (1, False, 'whole'), (True, True, 'whole')):
            with self.subTest(count=count, downstream=downstream, kind=kind), self.assertRaises(ValueError):
                counter.count(arm, count, prompt_trace_kind=kind, enable_downstream_count=downstream)

    def test_singleton_alternate_queue_shared_merge_uses_compact_actual_node_path(self):
        plan = self.nodes.ScenePromptQueue().queue(scene_prompt1=self.build('cat'), order_mode='alternate')[0]
        merge = self.nodes.ScenePromptMerge()
        for index in range(40):
            plan = merge.merge(plan, plan, unique_id=str(index))[0]
        self.assertLess(plan.depth, 4)
        self.assertEqual(self.text(plan), ('cat', ''))
        self.assertEqual(plan['stats']['total_batches'], 1)

    def test_random_output_shared_merge_keeps_text_and_replay_compact(self):
        arms = self.nodes.ScenePromptRandomRoute().route(
            weights_json=json.dumps([5000, 5000] + [0] * 8), scene_prompt=self.build('cat'), unique_id='gate')
        plan = self.nodes.ScenePromptRandomRouteOutput().join(scene_prompt1=arms[0], scene_prompt2=arms[1])[0]
        for index in range(28):
            plan = self.nodes.ScenePromptMerge().merge(plan, plan, unique_id=f'merge{index}')[0]
        self.assertEqual(self.text(plan), ('cat', ''))
        self.assertEqual(plan['stats']['total_batches'], 1)
        selected = self.plan.item_for_normalized_plan(plan, 0, 123)
        sources = set(selected['row']['source_node_ids'])
        self.assertEqual(self.plan.replay_index_for_event(plan, selected['event_ref'], sources, sources), 0)
        graph = {'gate': {'class_type': 'ScenePromptRandomRoute', 'inputs': {'weights_json': json.dumps([5000, 5000] + [0] * 8)}}}
        infos = [{'_event_ref': selected['event_ref']}]
        choices = self.nodes._selected_random_routes(infos)
        self.nodes._freeze_random_routes(graph, None, infos)
        weights = json.loads(graph['gate']['inputs']['weights_json'])
        self.assertEqual(weights[next(iter(choices['gate']))], 10000)
        self.assertTrue(graph['gate']['inputs']['preserve_join'])

    def test_delete_deep_choices_preserves_slots_without_recursion(self):
        value = "{" * 1500 + "tag" + "}" * 1500
        plan = self.build(value)
        for removal, expected in (("unrelated", "tag"), ("tag", "")):
            deleted = self.nodes.ScenePromptDelete().delete(removal, "", plan)[0]
            self.assertEqual(self.text(deleted), (expected, ""))
        cases = {
            "before { tag |keep||} after": "before {|keep||} after",
            "{tag, keep|{tag|other}}": "{keep|{|other}}",
            "{  keep  |tag}": "{  keep  |}",
            "{tag|{keep}": "{tag|{keep}",
            "prefix {tag|keep} suffix {tag}": "prefix {|keep} suffix {}",
        }
        for original, expected in cases.items():
            self.assertEqual(self.prompt._delete_prompt_parts([original], {"tag"}), [expected])

    def test_to_text_selects_one_row_and_cycles_shorter_plans(self):
        a, b, c = [self.build(value, node_id=value) for value in ('A', 'B', 'C')]
        b = self.nodes.ScenePromptCounter().count(count=2, scene_prompt=b)[0]
        plan = self.nodes.ScenePromptQueue().queue(scene_prompt1=a, scene_prompt2=b, scene_prompt3=c)[0]
        self.assertEqual([self.text(plan, current_index=i) for i in range(4)], [('A', ''), ('B', ''), ('B', ''), ('C', '')])
        self.assertEqual([self.text(plan, current_index=i) for i in range(4, 8)],
                         [('A', ''), ('B', ''), ('B', ''), ('C', '')])
        for index in (-1, True, 1.5):
            with self.subTest(index=index), self.assertRaisesRegex(ValueError, '生成番号'):
                self.text(plan, current_index=index)
        self.assertEqual(self.text(), ('', ''))
        self.assertEqual(self.text(current_index=1), ('', ''))
        empty = self.nodes.ScenePromptCounter().count(scene_prompt=self.build('x'), count=0)[0]
        with self.assertRaises(IndexError): self.text(empty)
        self.assertFalse(hasattr(self.nodes.ScenePromptToText, 'OUTPUT_IS_LIST'))
        self.assertNotIn('ScenePromptToText', self.nodes.SCENE_NODE_TYPES)
        self.assertNotIn('ScenePromptToText', self.presets.SAFE_NODE_CLASSES)

    def test_nested_emphasis_agrees_across_matrix_preset_to_text_expand_reverse_and_delete(self):
        from test_scene_presets import basic_nodes
        positive, negative = 'before, ((test:4):.5), (blocked:5)', '((blocked:.1):5)'
        matrix_json = json.dumps({'version': 1, 'sets': [{
            'row_id': 'nested', 'name': 'Nested', 'path_label': 'Nested',
            'positive_parts': ['(test:1.2)', 'between', '((weak:.1):4)', '(weak:1.2)',
                               '{((choice:3):.1)|((choice:3):.1)}', '(choice:1.2)', '((test:4):3)'],
            'negative_parts': [],
        }]})
        source = self.build(positive, negative)
        original = copy.deepcopy(source)
        plan = self.nodes.SceneMatrix().build(matrix_json, scene_prompt=source)[0]
        expected = ('before, ((test:4):.5), between, (weak:1.2), ((choice:3):.1)', negative)
        self.assertEqual(self.text(plan), expected)
        self.assertEqual(self.nodes.ScenePromptExpand().expand(scene_prompt=plan, seed_base=123)[:2], expected)
        self.assertEqual(source, original)
        graph = basic_nodes(positive)
        graph['2']['inputs']['negative_base'] = negative
        graph['4'] = {'class_type': 'SceneMatrix', 'inputs': {'scene_prompt': ['2', 0], 'matrix_json': matrix_json}}
        graph['3']['inputs']['scene_prompt'] = ['4', 0]
        saved = self.presets.save_preset({'preset_id': 'nested', 'name': 'Nested', 'output_node_id': '3',
            'api_graph': {'output': graph}, 'workflow': self.workflow(graph)})
        self.assertEqual(saved['api_graph']['output']['2']['inputs']['positive_base'], positive)
        self.assertEqual(saved['api_graph']['output']['4']['inputs']['matrix_json'], matrix_json)
        restored = self.presets._evaluate_preset_scene(saved, {}, None)
        self.assertEqual(self.text(restored), expected)
        self.assertEqual(self.nodes.ScenePromptExpand().expand(scene_prompt=restored, seed_base=123)[:2], expected)
        reversed_plan = self.nodes.ScenePromptReverse().reverse(restored)[0]
        self.assertEqual(self.text(reversed_plan), expected[::-1])
        deleted = self.nodes.ScenePromptDelete().delete('(test:.1)', '', restored)[0]
        self.assertEqual(self.text(deleted), (expected[0].replace('((test:4):.5), ', ''), expected[1]))

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

    def test_delete_cache_key_tracks_plan_and_both_fields(self):
        changed = self.nodes.ScenePromptDelete.IS_CHANGED
        baseline = changed()
        self.assertEqual(baseline, changed(scene_prompt=None, positive='', negative=''))
        for values in ({'scene_prompt': self.build('different')}, {'positive': 'bald'}, {'negative': 'bald'}):
            self.assertNotEqual(baseline, changed(**values))
        self.assertNotEqual(changed(positive='a|b', negative='c'), changed(positive='a', negative='b|c'))

    def test_text_replay_uses_own_default_index_and_requires_reproducible_seed(self):
        handle = self.runs.create_run_context('default')
        plan = self.build('{red|blue}', node_id='source')
        self.nodes.ScenePromptToText().to_text(plan, seed_base=17, run_handle=handle, unique_id='1')
        prompt = {'1': {'class_type': 'ScenePromptToText', 'inputs': {'seed_base': 17}},
                  '2': {'class_type': 'Save', 'inputs': {'text': ['1', 0]}}}
        info = {'run_handle': handle, 'file_index': 4, 'seed': 999}
        replay = self.nodes._consumer_replay_items(prompt, '2', info)['1']
        self.assertEqual((replay['row_index'], replay['repeat_index'], replay['seed']), (0, 1, 17))
        prompt['1']['inputs']['seed_base'] = 0
        with self.assertRaisesRegex(ValueError, 'seed_base'):
            self.nodes._consumer_replay_items(prompt, '2', info)
        prompt['1']['inputs']['seed_base_literal'] = True
        self.assertEqual(self.nodes._consumer_replay_items(prompt, '2', info)['1']['seed'], 0)
        prompt['1']['inputs']['current_index'] = 1
        cycled = self.nodes._consumer_replay_items(prompt, '2', info)['1']
        self.assertEqual((cycled['row_index'], cycled['repeat_index'], cycled['seed']), (0, 1, 1))

    def test_v7_text_replay_uses_its_own_alternate_event_path(self):
        handle = self.runs.create_run_context('default')
        a = self.nodes.ScenePromptCounter().count(count=2, scene_prompt=self.build('A', node_id='a'))[0]
        b = self.nodes.ScenePromptCounter().count(count=2, scene_prompt=self.build('B', node_id='b'))[0]
        plan = self.nodes.ScenePromptQueue().queue(
            scene_prompt1=a, scene_prompt2=b, order_mode='alternate', unique_id='queue',
        )[0]
        self.nodes.ScenePromptToText().to_text(plan, current_index=3, seed_base=10,
                                                run_handle=handle, unique_id='text')
        full_prompt = {
            'a': {'class_type': 'ScenePrompter', 'inputs': {}},
            'b': {'class_type': 'ScenePrompter', 'inputs': {}},
            'queue': {'class_type': 'ScenePrompterQueue', 'inputs': {
                'scene_prompt1': ['a', 0], 'scene_prompt2': ['b', 0],
            }},
            'text': {'class_type': 'ScenePromptToText', 'inputs': {
                'scene_prompt': ['queue', 0], 'current_index': 3, 'seed_base': 10,
            }},
            'save': {'class_type': 'Save', 'inputs': {'text': ['text', 0]}},
        }
        info = self.nodes._consumer_replay_items(full_prompt, 'save', {'run_handle': handle})['text']
        self.assertIn('_event_ref', info)
        saved_prompt = {key: copy.deepcopy(full_prompt[key]) for key in ('b', 'queue', 'text', 'save')}
        saved_prompt['queue']['inputs'].pop('scene_prompt1')
        self.nodes._apply_consumer_replay_values(saved_prompt, None, {'text': info}, full_prompt)
        self.assertEqual(saved_prompt['text']['inputs']['current_index'], 1)
        self.assertEqual(saved_prompt['text']['inputs']['seed_base'], 12)
        self.assertFalse(saved_prompt['text']['inputs']['seed_base_literal'])

    def test_text_replay_uses_its_executed_context_without_expand_metadata(self):
        handle = self.runs.create_run_context('default')
        plan = self.build('{red|blue}, coat', node_id='source')
        self.nodes.ScenePromptToText().to_text(plan, seed_base=17, run_handle=handle, unique_id='text')
        prompt = {
            'source': scene_prompt('{red|blue}, coat'),
            'text': {'class_type': 'ScenePromptToText', 'inputs': {
                'scene_prompt': ['source', 0], 'seed_base': 17, 'run_handle': handle,
            }},
            'save': {'class_type': 'SceneSaveImage', 'inputs': {'text': ['text', 0]}},
        }
        for scene_info in (None, {}, {'run_handle': 'unrelated'}):
            with self.subTest(scene_info=scene_info):
                replay = self.nodes._consumer_replay_items(prompt, 'save', scene_info)['text']
                self.assertEqual(replay['source_node_ids'], ['source'])
                self.assertEqual(replay['seed'], 17)

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

    def test_png_without_metadata_rebases_each_expand_and_keeps_consumed_models(self):
        for shared_model, metadata_connected in ((False, False), (True, False), (False, True), (True, True)):
            with self.subTest(shared_model=shared_model, metadata=metadata_connected):
                handle = self.runs.create_run_context('default')
                graph, plans = {}, {}
                for node_id, loader, upstream in [('10', '20', None), ('11', '21', '10'),
                                                  ('12', '22', '11' if shared_model else '10')]:
                    links = dict(zip(('model', 'clip', 'vae'), ([loader, 0], [loader, 1], [loader, 2])))
                    graph[loader] = {'class_type': 'CheckpointLoaderSimple', 'inputs': {'ckpt_name': f'{loader}.safetensors'}}
                    graph[node_id] = {'class_type': 'SceneApplyModel', 'inputs': {
                        **links, **({'scene_prompt': [upstream, 0]} if upstream else {}),
                    }}
                    plans[node_id] = self.nodes.SceneApplyModel().apply_model(
                        **links, scene_prompt=plans.get(upstream), unique_id=node_id)[0]
                for node_id, source in [('30', '12' if shared_model else '11'), ('31', '11' if shared_model else '12')]:
                    graph[node_id] = {'class_type': 'ScenePrompterExpand', 'inputs': {
                        'scene_prompt': [source, 0], 'seed_base': 100, 'run_handle': handle,
                    }}
                    self.runs.set_run_plan_reference(handle, node_id, plans[source])
                graph['32'] = {'class_type': 'ImageWithTwoModels', 'inputs': {'model_a': ['30', 5], 'model_b': ['31', 5]}}
                graph['33'] = {'class_type': 'SceneSaveImage', 'inputs': {'images': ['32', 0]}}
                info = None
                if metadata_connected:
                    first_plan = plans['12' if shared_model else '11']
                    item = self.plan.item_for_normalized_plan(first_plan, 0, 100)
                    info = {'run_handle': handle, '_plan_ref': first_plan, '_event_ref': item['event_ref'],
                            'seed': 100, 'source_node_ids': [*item['row']['source_node_ids'], '30']}
                saved, _ = self.nodes._metadata_for_save_mode(
                    graph, {'workflow': self.workflow(graph)}, '33', self.nodes.SAVE_METADATA_EXECUTION_PATH, info)
                self.assertEqual(saved['10']['class_type'], 'ScenePromptCounter')
                self.assertEqual(saved['10']['inputs']['count'], 1)
                self.assertNotIn('20', saved)
                self.assertEqual(saved['30']['inputs']['scene_prompt'], ['12' if shared_model else '11', 0])
                self.assertEqual(saved['31']['inputs']['scene_prompt'], ['11' if shared_model else '12', 0])
                for node_id, loader in [('11', '21'), ('12', '22')]:
                    self.assertEqual(saved[node_id]['inputs']['model'], [loader, 0])
                    self.assertIn(loader, saved)
                self.assertEqual(saved['32']['inputs'], graph['32']['inputs'])

    def test_png_superseded_root_model_keeps_empty_queue_unit(self):
        for metadata in (False, True):
            for index in range(4):
                with self.subTest(metadata=metadata, index=index):
                    handle = self.runs.create_run_context('default')
                    graph = {
                        '101': {'class_type': 'CheckpointLoaderSimple', 'inputs': {}},
                        '102': {'class_type': 'CheckpointLoaderSimple', 'inputs': {}},
                        '1': {'class_type': 'SceneApplyModel', 'inputs': {'model': ['101', 0], 'clip': ['101', 1], 'vae': ['101', 2], 'source_node_id': '1', 'source_node_name': 'first'}},
                        '2': {'class_type': 'ScenePromptCounter', 'inputs': {'scene_prompt': ['1', 0], 'count': 3}},
                        '3': {'class_type': 'ScenePrompterQueue', 'inputs': {'scene_prompt1': ['1', 0], 'scene_prompt2': ['2', 0]}},
                        '4': {'class_type': 'SceneApplyModel', 'inputs': {'scene_prompt': ['3', 0], 'model': ['102', 0], 'clip': ['102', 1], 'vae': ['102', 2], 'source_node_id': '4'}},
                        '5': {'class_type': 'ScenePrompterExpand', 'inputs': {'scene_prompt': ['4', 0], 'current_index': index, 'seed_base': 100, 'run_handle': handle}},
                        '6': {'class_type': 'SceneSaveImage', 'inputs': {'images': ['5', 4]}},
                    }
                    workflow = self.workflow(graph)
                    for target in workflow['nodes']:
                        target_id = str(target['id'])
                        for slot, entry in enumerate(target['inputs']):
                            value = graph[target_id]['inputs'][entry['name']]
                            if isinstance(value, list):
                                workflow['links'].append([len(workflow['links']) + 1, int(value[0]), value[1], int(target_id), slot, '*'])
                    plan = self.presets._scene_node_value(graph, '4', {}, set())
                    expanded = self.nodes.ScenePromptExpand().expand(scene_prompt=plan, current_index=index,
                        seed_base=100, unique_id='5', run_handle=handle, prompt=graph)['result']
                    saved, extra = self.nodes._metadata_for_save_mode(graph, {'workflow': workflow}, '6',
                        self.nodes.SAVE_METADATA_EXECUTION_PATH, expanded[2] if metadata else None)
                    self.assertNotIn('101', saved)
                    self.assertEqual(saved['1'], {'class_type': 'ScenePromptCounter', 'inputs': {
                        'count': 1, 'enable_downstream_count': True, 'source_node_id': '1', 'source_node_name': 'first'}})
                    replay = self.presets._scene_node_value(saved, '4', {}, set())
                    inputs = saved['5']['inputs']
                    actual = self.nodes.ScenePromptExpand().expand(scene_prompt=replay,
                        **{name: inputs[name] for name in ('current_index', 'seed_base', 'seed_base_literal')})['result']
                    self.assertEqual(actual[:2], expanded[:2])
                    self.assertEqual(actual[3], expanded[3])
                    self.assertEqual(actual[5:], expanded[5:])
                    node = next(node for node in extra['workflow']['nodes'] if str(node['id']) == '1')
                    self.assertEqual(node['type'], 'ScenePromptCounter')
                    self.assertEqual(node['widgets_values'], [1, True])
                    self.assertEqual(len(node['inputs']), 1)
                    self.assertIsNone(node['inputs'][0]['link'])
                    self.assertFalse(any(str(link[3]) == '1' for link in extra['workflow']['links']))

    def test_png_preserves_effective_model_in_shared_merge_and_preset(self):
        inner = {
            '80': {'class_type': 'ScenePresetInput', 'inputs': {}},
            '81': {'class_type': 'ScenePresetOutput', 'inputs': {'scene_prompt': ['80', 0]}},
        }
        self.presets.save_preset({'preset_id': 'model-pass', 'name': 'model-pass', 'output_node_id': '81',
                                 'api_graph': {'output': inner}, 'workflow': self.workflow(inner)})
        for preset_mode in ('none', 'reference', 'expanded'):
            for metadata in (False, True):
                for second_consumer in (False, True):
                    # A shared Model A is merged after B. Deduplicated source order is A,B,
                    # but the effective model is A. Also cover only CLIP or VAE differing.
                    for changed_input in ('model', 'clip', 'vae'):
                        with self.subTest(preset=preset_mode, metadata=metadata, second=second_consumer, changed=changed_input):
                            handle = self.runs.create_run_context('default')
                            links_a = {name: ['101', index] for index, name in enumerate(('model', 'clip', 'vae'))}
                            links_b = {**links_a, changed_input: ['102', links_a[changed_input][1]]}
                            graph = {
                                '101': {'class_type': 'CheckpointLoaderSimple', 'inputs': {'ckpt_name': 'a.safetensors'}},
                                '102': {'class_type': 'CheckpointLoaderSimple', 'inputs': {'ckpt_name': 'b.safetensors'}},
                                '11': {'class_type': 'SceneApplyModel', 'inputs': {**links_a, 'source_node_id': '11'}},
                                '19': {'class_type': 'SceneApplyModel', 'inputs': {**links_a, 'scene_prompt': ['11', 0], 'source_node_id': '19'}},
                                '12': {'class_type': 'SceneApplyModel', 'inputs': {**links_b, 'scene_prompt': ['19', 0], 'source_node_id': '12'}},
                                '13': {'class_type': 'ScenePrompterMerge', 'inputs': {'scene_prompt1': ['12', 0], 'scene_prompt2': ['11', 0]}},
                                '14': {'class_type': 'ScenePrompterExpand', 'inputs': {'scene_prompt': ['13', 0], 'seed_base': 100, 'run_handle': handle}},
                                '15': {'class_type': 'ModelImage', 'inputs': {'model': ['14', 5]}},
                                '16': {'class_type': 'SceneSaveImage', 'inputs': {'images': ['15', 0]}},
                            }
                            if preset_mode != 'none':
                                graph['17'] = {'class_type': 'ScenePresetReference', 'inputs': {'scene_prompt': ['13', 0], 'preset_id': 'model-pass', 'run_handle': handle}}
                                graph['14']['inputs']['scene_prompt'] = ['17', 0]
                            if second_consumer:
                                graph['18'] = {'class_type': 'ScenePrompterExpand', 'inputs': {'scene_prompt': ['12', 0], 'seed_base': 200, 'run_handle': handle}}
                                graph['15']['inputs']['other_model'] = ['18', 5]
                            self.presets.snapshot_presets_for_run(handle, {'output': graph}, '14')
                            snapshots = self.presets.snapshot_presets_for_metadata(handle)
                            for consumer in ('14', '18') if second_consumer else ('14',):
                                source = graph[consumer]['inputs']['scene_prompt'][0]
                                plan = self.presets._scene_node_value(graph, '13' if source == '17' else source, snapshots, set())
                                if source == '17':
                                    # Runtime Preset Output marks the outer Reference as a whole-prompt source.
                                    plan = self.nodes.ScenePromptCounter().count(plan, 1, prompt_trace_kind='whole', source_node_id='17')[0]
                                expanded = self.nodes.ScenePromptExpand().expand(scene_prompt=plan, seed_base=100,
                                    unique_id=consumer, run_handle=handle, prompt=graph)['result']
                                if consumer == '14':
                                    self.assertEqual(expanded[5:], (links_a['model'], links_a['clip'], links_a['vae']))
                                    info = self.nodes._normalize_scene_save_info(expanded[2]) if metadata else None
                            saved, _ = self.nodes._metadata_for_save_mode(graph, {'workflow': self.workflow(graph)}, '16',
                                self.nodes.SAVE_METADATA_EXECUTION_PATH, info, expand_preset_contents=preset_mode == 'expanded')
                            self.assertIn('11', saved)
                            self.assertEqual('12' in saved, second_consumer)
                            self.assertEqual('102' in saved, second_consumer)
                            for consumer, expected in [('14', links_a), *([('18', links_b)] if second_consumer else [])]:
                                replay = self.presets._scene_node_value(saved, saved[consumer]['inputs']['scene_prompt'][0], snapshots, set())
                                row = self.plan.item_for_normalized_plan(replay, 0, 100)['row']
                                self.assertEqual(row['model_links'], expected)

    def test_png_without_metadata_preserves_distinct_expand_indices_and_seeds(self):
        handle = self.runs.create_run_context('default')
        graph, branches = {}, []
        for index, label in enumerate(('unused', 'alpha', 'beta'), start=1):
            source, counter = str(index), str(index + 10)
            graph[source] = scene_prompt(label)
            graph[counter] = {'class_type': 'ScenePromptCounter', 'inputs': {'scene_prompt': [source, 0], 'count': 2}}
            branches.append(self.nodes.ScenePromptCounter().count(self.build(label, node_id=source), 2, unique_id=counter)[0])
        graph['20'] = {'class_type': 'ScenePrompterQueue', 'inputs': {
            f'scene_prompt{index}': [str(index + 10), 0] for index in range(1, 4)}}
        plan = self.nodes.ScenePromptQueue().queue(**{f'scene_prompt{index}': branch for index, branch in enumerate(branches, start=1)}, unique_id='20')[0]
        for node_id, index, seed in [('30', 3, 100), ('31', 5, 300)]:
            graph[node_id] = {'class_type': 'ScenePrompterExpand', 'inputs': {
                'scene_prompt': ['20', 0], 'current_index': index, 'seed_base': seed, 'run_handle': handle,
            }}
            self.runs.set_run_plan_reference(handle, node_id, plan)
        graph['32'] = {'class_type': 'ImageWithTwoTexts', 'inputs': {'positive': ['30', 0], 'negative': ['31', 0]}}
        graph['33'] = {'class_type': 'SceneSaveImage', 'inputs': {'images': ['32', 0]}}
        saved, extra = self.nodes._metadata_for_save_mode(
            graph, {'workflow': self.workflow(graph)}, '33', self.nodes.SAVE_METADATA_EXECUTION_PATH)
        self.assertNotIn('1', saved)
        self.assertNotIn('11', saved)
        for node_id, index, seed in [('30', 1, 102), ('31', 3, 302)]:
            self.assertEqual((saved[node_id]['inputs']['current_index'], saved[node_id]['inputs']['seed_base']), (index, seed))
            widgets = next(node['widgets_values'] for node in extra['workflow']['nodes'] if str(node['id']) == node_id)
            self.assertEqual((widgets[0], widgets[2]), (index, seed))
        self.assertEqual(saved['32']['inputs'], graph['32']['inputs'])

    def test_png_rebases_each_plan_independently_with_and_without_preset_expansion(self):
        for expand_index in (2, 3):
            for in_preset, expand_contents in ((False, False), (True, False), (True, True)):
                with self.subTest(expand_index=expand_index, in_preset=in_preset, expand_contents=expand_contents):
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
                        '30': {'class_type': 'ScenePrompterExpand', 'inputs': {'scene_prompt': ['21', 0], 'current_index': expand_index, 'seed_base': 100}},
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
                    expanded = self.nodes.ScenePromptExpand().expand(scene_prompt=plans['21'], current_index=expand_index, seed_base=100, run_handle=handle, unique_id='30', prompt=prompt)
                    workflow = self.workflow(prompt)
                    for node in workflow['nodes']:
                        if str(node['id']) in ('30', '31'):
                            node['widgets_values_named'] = {'current_index': 2, 'seed_base': 100, 'seed_base_literal': False}
                    saved, extra = self.nodes._metadata_for_save_mode(prompt, {'workflow': workflow}, '33', self.nodes.SAVE_METADATA_EXECUTION_PATH, expanded[2], expand_preset_contents=expand_contents)
                    self.assertNotIn('1', saved)
                    self.assertNotIn('99', saved)
                    self.assertEqual(saved['30']['inputs']['current_index'], expand_index - 2)
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
                        visual = next(node for node in extra['workflow']['nodes'] if str(node['id']) == consumer_id)
                        self.assertEqual(visual['widgets_values_named'], values)
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
            '5': {'class_type': 'ScenePromptToText', 'inputs': {'scene_prompt': ['2', 0], 'scope': self.nodes.TEXT_SCOPE_PREVIOUS, 'seed_base': 123}},
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

    def test_run_snapshot_resolves_to_text_into_delete_by_output_slot(self):
        api = {
            '1': scene_prompt('bald, hair'),
            '2': scene_prompt('bald'),
            '3': {'class_type': 'ScenePromptToText', 'inputs': {
                'scene_prompt': ['2', 0], 'scope': self.nodes.TEXT_SCOPE_ALL,
                'current_index': 0, 'seed_base': 123,
                'run_handle': 'stale', 'unique_id': 'stale',
            }},
            '4': {'class_type': 'ScenePromptDelete', 'inputs': {
                'scene_prompt': ['1', 0], 'positive': ['3', 0], 'negative': ['3', 1],
            }},
            '5': {'class_type': 'ScenePrompterExpand', 'inputs': {'scene_prompt': ['4', 0]}},
        }
        api['1']['inputs']['negative_base'] = 'bad, worse'
        api['2']['inputs']['negative_base'] = 'bad'
        handle = self.runs.create_run_context('default')
        calls = []
        original = self.nodes.ScenePromptToText.to_text
        def observed(instance, **kwargs):
            calls.append(kwargs)
            return original(instance, **kwargs)
        with mock.patch.object(self.nodes.ScenePromptToText, 'to_text', observed):
            result = self.presets.snapshot_presets_for_run(handle, {'output': api}, '5')
        self.assertEqual(len(calls), 1)
        self.assertEqual((calls[0]['run_handle'], calls[0]['unique_id']), ('', None))
        self.assertIsNone(self.runs.get_run_plan_reference(handle, '3'))
        self.assertEqual(result['total_images'], 1)
        plan = self.presets._scene_node_value(api, '4', {}, set(), run_handle=handle)
        self.assertEqual(self.text(plan), ('hair', 'worse'))
        counted = self.nodes.ScenePromptCounter().count(scene_prompt=plan, count=2)[0]
        self.assertEqual(self.text(counted), ('hair', 'worse'))
        self.assertEqual(self.nodes.ScenePromptExpand().expand(scene_prompt=counted, seed_base=123)[:2], ('hair', 'worse'))
        for invalid in (True, -1, 2, '0'):
            api['4']['inputs']['positive'] = ['3', invalid]
            with self.subTest(slot=invalid), self.assertRaisesRegex(self.presets.ScenePresetResolutionError, '出力番号'):
                self.presets._scene_node_value(api, '4', {}, set(), run_handle=handle)

    def test_run_snapshot_supports_preset_reference_then_to_text_then_delete(self):
        from test_scene_presets import basic_nodes

        preset_graph = basic_nodes('bald')
        saved = self.presets.save_preset({
            'preset_id': 'text_source', 'name': 'text_source', 'output_node_id': '3',
            'api_graph': {'output': preset_graph}, 'workflow': self.workflow(preset_graph),
        })
        api = {
            '1': scene_prompt('bald, hair'),
            '2': {'class_type': 'ScenePresetReference', 'inputs': {'preset_id': 'text_source'}},
            '3': {'class_type': 'ScenePromptToText', 'inputs': {'scene_prompt': ['2', 0], 'seed_base': 123}},
            '4': {'class_type': 'ScenePromptDelete', 'inputs': {'scene_prompt': ['1', 0], 'positive': ['3', 0]}},
            '5': {'class_type': 'ScenePrompterExpand', 'inputs': {'scene_prompt': ['4', 0]}},
        }
        handle = self.runs.create_run_context('default')
        result = self.presets.snapshot_presets_for_run(handle, {'output': api}, '5')
        self.assertEqual(result['total_images'], 1)
        self.assertEqual([entry['preset_id'] for entry in result['presets']], ['text_source'])
        plan = self.presets._scene_node_value(api, '4', {'text_source': saved}, set(), run_handle=handle)
        self.assertEqual(self.text(plan), ('hair', ''))

    def test_run_snapshot_evaluates_all_registered_scene_ancestors(self):
        api = {
            '1': scene_prompt('hair'),
            '2': {'class_type': 'SceneMatrix', 'inputs': {
                'scene_prompt': ['1', 0], 'matrix_json': self.nodes.DEFAULT_MATRIX_JSON,
            }},
            '3': {'class_type': 'ScenePath', 'inputs': {'scene_prompt': ['2', 0], 'path_name': 'test'}},
            '4': {'class_type': 'ScenePrompterQueue', 'inputs': {'scene_prompt1': ['3', 0]}},
            '5': {'class_type': 'ScenePrompterMerge', 'inputs': {'scene_prompt1': ['4', 0], 'scene_prompt2': ['1', 0]}},
            '6': {'class_type': 'ScenePromptReverse', 'inputs': {
                'scene_prompt': ['5', 0], 'reverse_scope': self.nodes.REVERSE_SCOPE_ALL,
            }},
            '7': {'class_type': 'ScenePromptToText', 'inputs': {'scene_prompt': ['1', 0], 'seed_base': 13}},
            '8': {'class_type': 'ScenePromptDelete', 'inputs': {
                'scene_prompt': ['6', 0], 'negative': ['7', 0], 'positive': ['7', 1],
            }},
            '9': {'class_type': 'ScenePromptCounter', 'inputs': {'scene_prompt': ['8', 0], 'count': 2}},
            '10': {'class_type': 'SceneEmptyLatent', 'inputs': {
                'scene_prompt': ['9', 0], 'width': 16, 'height': 16, 'batch_size': 1,
            }},
            '11': {'class_type': 'SceneApplyModel', 'inputs': {
                'scene_prompt': ['10', 0], 'model': ['unresolved-model', 0],
                'clip': ['unresolved-clip', 0], 'vae': ['unresolved-vae', 0],
            }},
            '12': {'class_type': 'SceneApplyLora', 'inputs': {
                'scene_prompt': ['11', 0], 'lora_name': 'style/example.safetensors',
                'strength_model': 1.0, 'strength_clip': 1.0,
            }},
            '13': {'class_type': 'ScenePromptCallbackDiscord', 'inputs': {
                'webhook_url': 'https://example.com/webhook', 'text': 'sample',
            }},
            '14': {'class_type': 'ScenePromptCallback', 'inputs': {
                'scene_prompt': ['12', 0], 'callback': ['13', 0],
            }},
            '15': {'class_type': 'ScenePromptCallbackRequest', 'inputs': {
                'method': 'GET', 'url': 'https://example.com/callback', 'text': '',
            }},
            '16': {'class_type': 'ScenePromptCallback', 'inputs': {
                'scene_prompt': ['14', 0], 'callback': ['15', 0],
            }},
            '17': {'class_type': 'ScenePromptCallbackDesktop', 'inputs': {'title': 'sample', 'text': 'sample'}},
            '18': {'class_type': 'ScenePromptCallback', 'inputs': {
                'scene_prompt': ['16', 0], 'callback': ['17', 0],
            }},
            '21': {'class_type': 'ScenePromptLLM', 'inputs': {
                'scene_prompt': ['18', 0], 'model_mode': 'Illustrious',
                'description': 'Saved only; no inference during execution.', 'positive': 'saved_llm_tag', 'negative': '',
            }},
            '20': {'class_type': 'ScenePromptRandomRoute', 'inputs': {
                'scene_prompt': ['21', 0], 'weights_json': self.nodes.DEFAULT_RANDOM_WEIGHTS_JSON,
            }},
            '22': {'class_type': 'ScenePromptRandomRouteOutput', 'inputs': {'scene_prompt1': ['20', 0]}},
            '19': {'class_type': 'ScenePrompterExpand', 'inputs': {'scene_prompt': ['22', 0]}},
        }
        reached = {node['class_type'] for node in api.values()}
        self.assertEqual(reached - {'ScenePrompterExpand', 'ScenePromptToText', 'SceneApplyModel'},
                         set(self.presets.SAFE_NODE_CLASSES) - {'ScenePresetReference'})
        scene_nodes, source = self.presets._scene_nodes_for_expand(api, '19')
        self.assertEqual(set(scene_nodes), set(api) - {'19'})
        self.assertEqual(source, ['22', 0])
        handle = self.runs.create_run_context('default')
        with self.subTest('prepare'):
            result = self.presets.snapshot_presets_for_run(handle, {'output': api}, '19')
        self.assertEqual(result['total_images'], 2)
        self.assertEqual(result['total_batches'], 2)

        plan = self.presets._scene_node_value(api, '21', {}, set(), run_handle=handle)
        self.assertIn('saved_llm_tag', self.text(plan)[0])

    def test_random_route_snapshot_selects_output_slots_and_checks_missing_positive(self):
        import json
        api = {
            '1': scene_prompt('base'),
            '2': {'class_type': 'ScenePromptRandomRoute', 'inputs': {
                'scene_prompt': ['1', 0], 'weights_json': json.dumps([5000, 5000] + [0] * 8),
            }},
            '3': scene_prompt('A'),
            '4': {'class_type': 'ScenePromptDelete', 'inputs': {
                'scene_prompt': ['2', 0], 'negative': '', 'positive': '',
            }},
            '5': {'class_type': 'ScenePromptReverse', 'inputs': {
                'scene_prompt': ['2', 1], 'reverse_scope': self.nodes.REVERSE_SCOPE_ALL,
            }},
            '6': {'class_type': 'ScenePrompterQueue', 'inputs': {
                'scene_prompt1': ['4', 0], 'scene_prompt2': ['5', 0],
            }},
            '7': {'class_type': 'ScenePrompterExpand', 'inputs': {'scene_prompt': ['6', 0]}},
        }
        handle = self.runs.create_run_context('default')
        result = self.presets.snapshot_presets_for_run(handle, {'output': api}, '7')
        self.assertEqual(result['total_batches'], 1)
        joined = self.presets._scene_node_value(api, '6', {}, set(), run_handle=handle)
        selected = [self.plan.item_for_normalized_plan(joined, 0, seed)['row']['positive_parts'] for seed in range(20)]
        self.assertIn(['base'], selected)
        self.assertIn([], selected)
        api['6']['inputs'].pop('scene_prompt2')
        with self.assertRaisesRegex(self.presets.ScenePresetResolutionError, '出力2'):
            self.presets.snapshot_presets_for_run(self.runs.create_run_context('default'), {'output': api}, '7')
        api['5']['inputs'].pop('scene_prompt')
        with self.assertRaisesRegex(self.plan.ScenePlanError, '出力2'):
            self.nodes.ScenePromptRandomRoute().route(
                weights_json=json.dumps([5000, 5000] + [0] * 8), unique_id='2', prompt=api,
            )

    def test_random_route_inside_preset_uses_reference_instance_gate_ids(self):
        import json
        preset_nodes = {
            '1': {'class_type': 'ScenePresetInput', 'inputs': {}},
            '2': {'class_type': 'ScenePromptRandomRoute', 'inputs': {
                'scene_prompt': ['1', 0], 'weights_json': json.dumps([2500, 7500] + [0] * 8),
            }},
            '3': {'class_type': 'ScenePath', 'inputs': {'scene_prompt': ['2', 0], 'path_name': 'A'}},
            '4': {'class_type': 'ScenePath', 'inputs': {'scene_prompt': ['2', 1], 'path_name': 'B'}},
            '5': {'class_type': 'ScenePrompterQueue', 'inputs': {'scene_prompt1': ['3', 0], 'scene_prompt2': ['4', 0]}},
            '6': {'class_type': 'ScenePresetOutput', 'inputs': {'scene_prompt': ['5', 0]}},
        }
        saved = self.presets.save_preset({
            'preset_id': 'route_preset', 'name': 'route_preset', 'output_node_id': '6',
            'api_graph': {'output': preset_nodes}, 'workflow': self.workflow(preset_nodes),
        })
        listed = self.presets.list_presets()
        compact = next(entry['api_graph']['output'] for entry in listed['presets'] if entry['metadata']['preset_id'] == 'route_preset')
        self.assertEqual(json.loads(compact['2']['inputs']['weights_json']), [2500, 7500] + [0] * 8)
        api = {
            '100': scene_prompt('base'),
            '101': {'class_type': 'ScenePresetReference', 'inputs': {'preset_id': 'route_preset', 'scene_prompt': ['100', 0]}},
            '102': {'class_type': 'ScenePresetReference', 'inputs': {'preset_id': 'route_preset', 'scene_prompt': ['100', 0]}},
            '103': {'class_type': 'ScenePrompterQueue', 'inputs': {'scene_prompt1': ['101', 0], 'scene_prompt2': ['102', 0]}},
        }
        first = self.presets._scene_node_value(api, '101', {'route_preset': saved}, set())
        second = self.presets._scene_node_value(api, '102', {'route_preset': saved}, set())
        def gate(plan):
            unit = plan['units'][0]
            while unit['kind'] == 'map':
                unit = unit['unit']
            return unit['gate_id']
        self.assertEqual(gate(first), '101/2')
        self.assertEqual(gate(second), '102/2')

    def test_random_route_validates_dynamic_preset_edges(self):
        import json
        class Dynamic:
            def __init__(self, ephemeral):
                self.ephemeral = ephemeral
            def all_node_ids(self):
                return self.ephemeral.keys()
            def get_node(self, node_id):
                return self.ephemeral[node_id]
        route = self.nodes.ScenePromptRandomRoute()
        kwargs = {'weights_json': json.dumps([5000, 5000] + [0] * 8), 'unique_id': 'ephemeral_random',
                  'prompt': {'unrelated': {'class_type': 'ScenePrompter', 'inputs': {}}}}
        dynamic = Dynamic({
            'arm_a': {'inputs': {'scene_prompt': ['ephemeral_random', 0]}},
            'arm_b': {'inputs': {'scene_prompt': ['ephemeral_random', 1]}},
        })
        self.assertEqual(len(route.route(**kwargs, dynprompt=dynamic)), 10)
        dynamic.ephemeral.pop('arm_b')
        with self.assertRaisesRegex(self.plan.ScenePlanError, '出力2'):
            route.route(**kwargs, dynprompt=dynamic)

    def test_random_replay_does_not_freeze_conflicting_expand_and_to_text_arms(self):
        import json
        original = json.dumps([5000, 5000] + [0] * 8)
        graph = {'route': {'class_type': 'ScenePromptRandomRoute', 'inputs': {'weights_json': original}}}
        first = {'_event_ref': (('top', 0), ('random_choice', 'route', 0), ('top', 0), ('run', 0))}
        second = {'_event_ref': (('top', 0), ('random_choice', 'route', 1), ('top', 0), ('run', 0))}
        self.nodes._freeze_random_routes(graph, None, [first, second])
        self.assertEqual(graph['route']['inputs']['weights_json'], original)
        self.nodes._freeze_random_routes(graph, None, [first, first])
        self.assertEqual(json.loads(graph['route']['inputs']['weights_json']), [10000] + [0] * 9)
        self.assertTrue(graph['route']['inputs']['preserve_join'])
        visual = {'nodes': [{'id': 'route', 'type': 'ScenePromptRandomRoute', 'widgets_values': [original],
                             'widgets_values_named': {'weights_json': original, 'preserve_join': False}}]}
        self.nodes._freeze_random_routes(graph, visual, [first])
        self.assertEqual(visual['nodes'][0]['widgets_values'], [graph['route']['inputs']['weights_json'], True])
        self.assertEqual(visual['nodes'][0]['widgets_values_named'], {
            'weights_json': graph['route']['inputs']['weights_json'], 'preserve_join': True})


if __name__ == '__main__':
    unittest.main()
