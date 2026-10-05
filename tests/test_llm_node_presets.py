import copy
import importlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_scene_presets import load_presets_module, basic_nodes, graph
from test_preset_metadata import outer_workflow


class LLMNodePresetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.presets = load_presets_module(Path(self.temp.name))
        self.nodes = importlib.import_module(self.presets.__package__ + '.nodes')
        self.llm = self.presets.ScenePromptLLM

    def tearDown(self):
        self.temp.cleanup()

    def save(self, preset_id, nodes):
        return self.presets.save_preset({"preset_id": preset_id, "name": preset_id,
            "output_node_id": "3", "api_graph": graph(nodes), "workflow": {"version": 1, "nodes": []}})

    def definition(self, saved, positive, count=1):
        local = copy.deepcopy(saved)
        nodes = local['api_graph']['output']
        nodes['2'] = {"class_type": "ScenePromptLLM", "inputs": {
            "model_mode": "Illustrious", "description": "saved description", "positive": positive,
            "negative": "", "scene_prompt": ['1', 0]}}
        nodes['4'] = {"class_type": "ScenePromptCounter", "inputs": {"count": count, "scene_prompt": ['2', 0]}}
        nodes['3']['inputs']['scene_prompt'] = ['4', 0]
        local["workflow"] = outer_workflow(nodes)
        llm_workflow = next(node for node in local['workflow']['nodes'] if node['id'] == 2)
        llm_workflow['widgets_values'] = ['Illustrious', 'saved description', positive, '', '{}']
        return local

    def reference(self, preset_id, overrides=None):
        inputs = {'preset_id': preset_id}
        if overrides is not None:
            inputs['llm_presets_json'] = json.dumps({'version': 1, 'presets': overrides})
        return {'class_type': 'ScenePresetReference', 'inputs': inputs}

    def text(self, plan, **kwargs):
        return self.nodes.ScenePromptToText().to_text(scene_prompt=plan, **kwargs)

    def test_saved_output_standalone_mixed_delete_reverse_and_model_lora(self):
        head = self.llm().build('Illustrious', 'description is not executed', 'girl, red_hair', 'blur', unique_id='llm')[0]
        self.assertEqual(self.text(head), ('girl, red_hair', 'blur'))
        mixed = self.llm().build('Anima', '', 'hat', '', scene_prompt=head)[0]
        self.assertEqual(self.text(mixed), ('girl, red_hair, hat', 'blur'))
        removed = self.nodes.ScenePromptDelete().delete('red_hair', '', head)[0]
        self.assertEqual(self.text(removed), ('girl', 'blur'))
        reversed_plan = self.nodes.ScenePromptReverse().reverse(head)[0]
        self.assertEqual(self.text(reversed_plan), ('blur', 'girl, red_hair'))
        lora = self.nodes.SceneApplyLora().apply_lora('style/example.safetensors', scene_prompt=head,
            model_mode='Anima', positive='trigger')[0]
        self.assertNotIn('trigger', self.nodes.ScenePromptExpand().expand(scene_prompt=lora, model_mode='Illustrious')[0])
        self.assertIn('trigger', self.nodes.ScenePromptExpand().expand(scene_prompt=lora, model_mode='Anima')[0])

    def test_safe_registry_hidden_fields_and_legacy_widget_order(self):
        self.assertIs(self.presets.SAFE_NODE_CLASSES['ScenePromptLLM'], self.llm)
        self.assertIn('ScenePromptLLM', self.nodes.SCENE_NODE_TYPES)
        self.assertEqual(list(self.llm.INPUT_TYPES()['optional']), ['scene_prompt', 'generation_state_json'])
        self.assertEqual(list(self.presets.ScenePresetReference.INPUT_TYPES()['optional']),
                         ['scene_prompt', 'run_handle', 'llm_presets_json'])
        self.assertEqual(self.llm.INPUT_TYPES()['optional']['generation_state_json'][1]['default'], '{}')

    def test_two_instances_local_output_count_snapshot_graphbuilder_and_metadata(self):
        shared = self.save('shared', basic_nodes('original'))
        a, b = self.definition(shared, 'apple', 2), self.definition(shared, 'banana', 3)
        nodes = {'10': self.reference('shared', {'.': a}), '20': self.reference('shared', {'.': b}),
            '30': {'class_type': 'ScenePrompterQueue', 'inputs': {'scene_prompt1': ['10', 0], 'scene_prompt2': ['20', 0]}},
            '40': {'class_type': 'ScenePrompterExpand', 'inputs': {'scene_prompt': ['30', 0]}}}
        response = self.presets.snapshot_presets_for_run('local', graph(nodes), '40')
        self.assertEqual(response['total_images'], 5)
        snapshot = self.presets.snapshot_presets_for_metadata('local')
        occurrences = snapshot['__occurrences__']
        self.assertEqual(occurrences['10']['api_graph']['output']['2']['inputs']['positive'], 'apple')
        self.assertEqual(occurrences['20']['api_graph']['output']['2']['inputs']['positive'], 'banana')
        evaluation = {'__occurrences__': occurrences}
        plan = self.presets._scene_node_value(nodes, '30', evaluation, set())
        self.assertEqual([self.text(plan, current_index=i)[0] for i in range(5)], ['apple'] * 2 + ['banana'] * 3)
        expanded = self.presets.expand_preset_reference('shared', run_handle='local', source_node_id='20')['expand']
        self.assertEqual(expanded['2']['inputs']['positive'], 'banana')
        self.assertEqual(expanded['2']['inputs']['source_node_id'], '20/2')
        metadata = importlib.import_module(self.presets.__package__ + '.preset_metadata')
        workflow = {'nodes': [{'id': 10, 'type': 'ScenePresetReference', 'pos': [0, 0]},
                             {'id': 20, 'type': 'ScenePresetReference', 'pos': [300, 0]}], 'links': []}
        replay, _, sources = metadata.expand_preset_references({'10': nodes['10'], '20': nodes['20']}, workflow, snapshot)
        llms = [(sources[node_id], node['inputs']['positive']) for node_id, node in replay.items() if node['class_type'] == 'ScenePromptLLM']
        self.assertEqual(set(llms), {('10/2', 'apple'), ('20/2', 'banana')})
        nodes['20']['inputs']['llm_presets_json'] = json.dumps({'version': 1, 'presets': {'.': a}})
        self.assertEqual(self.presets._snapshot_preset('local', 'shared', reference_path='20')['api_graph']['output']['2']['inputs']['positive'], 'banana')
        self.assertEqual(self.presets.load_preset('shared')['api_graph']['output']['2']['inputs']['positive_base'], 'original')

    def test_nested_repeated_ids_subtree_and_own_override_precedence(self):
        child = self.save('child', basic_nodes('shared child'))
        parent_nodes = basic_nodes('')
        parent_nodes.pop('2')
        parent_nodes['4'] = self.reference('child')
        parent_nodes['5'] = self.reference('child', {'.': self.definition(child, 'own', 4)})
        parent_nodes['4']['inputs']['scene_prompt'] = ['1', 0]
        parent_nodes['5']['inputs']['scene_prompt'] = ['1', 0]
        parent_nodes['6'] = {'class_type': 'ScenePrompterQueue', 'inputs': {'scene_prompt1': ['4', 0], 'scene_prompt2': ['5', 0]}}
        parent_nodes['3']['inputs']['scene_prompt'] = ['6', 0]
        parent = self.save('parent', parent_nodes)
        outer = {'10': self.reference('parent', {'.': parent, '4': self.definition(child, 'inherited', 2), '5': self.definition(child, 'ignored', 8)}),
                 '20': self.reference('parent', {'4': self.definition(child, 'other', 3)})}
        resolved = {}
        occurrences = self.presets.prepare_preset_occurrences(outer, resolved)
        self.assertEqual(occurrences['10/4']['api_graph']['output']['2']['inputs']['positive'], 'inherited')
        self.assertEqual(occurrences['10/5']['api_graph']['output']['2']['inputs']['positive'], 'own')
        self.assertEqual(occurrences['20/4']['api_graph']['output']['2']['inputs']['positive'], 'other')
        evaluation = {**resolved, '__occurrences__': occurrences}
        for node_id, expected_count in [('10', 6), ('20', 7)]:
            plan = self.presets._scene_node_value(outer, node_id, evaluation, set())
            self.assertEqual(plan['stats']['total_images'], expected_count)

    def test_operation_memo_reuses_validation_rejects_unsafe_graph_and_identity(self):
        shared = self.save('shared', basic_nodes())
        serialized = json.dumps({'version': 1, 'presets': {'.': self.definition(shared, 'local')}})
        local_memo = {}
        first = self.presets.parse_llm_preset_overrides(serialized, local_memo)
        with mock.patch.object(self.presets, '_validate_preset_payload', side_effect=AssertionError('revalidated')):
            self.assertIs(self.presets.parse_llm_preset_overrides(serialized, local_memo), first)
        unsafe = copy.deepcopy(shared)
        unsafe['api_graph']['output']['2']['class_type'] = 'KSampler'
        with self.assertRaises(self.presets.ScenePresetError):
            self.presets.parse_llm_preset_overrides(json.dumps({'version': 1, 'presets': {'.': unsafe}}))
        with self.assertRaisesRegex(self.presets.ScenePresetError, 'identity mismatch'):
            self.presets.prepare_preset_occurrences({'10': self.reference('different', {'.': shared})})

    def test_flat_nested_customizations_keep_count_resources_and_metadata(self):
        child = self.save('flat-child', basic_nodes('shared'))
        leaf = self.definition(child, 'generated leaf', 3)
        leaf_nodes = leaf['api_graph']['output']
        leaf_nodes['5'] = {'class_type': 'SceneApplyLora', 'inputs': {'scene_prompt': ['4', 0],
            'lora_name': 'style/example.safetensors', 'model_mode': 'Illustrious',
            'strength_model': 0.8, 'strength_clip': 0.6}}
        leaf_nodes['3']['inputs']['scene_prompt'] = ['5', 0]
        leaf['workflow'] = outer_workflow(leaf_nodes)
        parent_nodes = basic_nodes('')
        parent_nodes.pop('2')
        parent_nodes['4'] = self.reference('flat-child', {'.': self.definition(child, 'obsolete', 9)})
        parent_nodes['4']['inputs']['scene_prompt'] = ['1', 0]
        parent_nodes['3']['inputs']['scene_prompt'] = ['4', 0]
        parent = self.save('flat-parent', parent_nodes)
        compact_parent = copy.deepcopy(parent)
        compact_parent['api_graph']['output']['4']['inputs']['llm_presets_json'] = ''
        compact_parent['workflow'] = outer_workflow(compact_parent['api_graph']['output'])
        grand_nodes = basic_nodes('')
        grand_nodes.pop('2')
        grand_nodes['4'] = self.reference('flat-parent')
        grand_nodes['4']['inputs']['scene_prompt'] = ['1', 0]
        grand_nodes['3']['inputs']['scene_prompt'] = ['4', 0]
        grand = self.save('flat-grand', grand_nodes)
        grand['workflow'] = outer_workflow(grand['api_graph']['output'])
        api_nodes = {'10': self.reference('flat-grand', {'.': grand, '4': compact_parent, '4/4': leaf}),
            '40': {'class_type': 'ScenePrompterExpand', 'inputs': {'scene_prompt': ['10', 0], 'model_mode': 'Illustrious'}}}
        response = self.presets.snapshot_presets_for_run('flat-local', graph(api_nodes), '40')
        self.assertEqual(response['total_images'], 3)
        snapshot = self.presets.snapshot_presets_for_metadata('flat-local')
        self.assertEqual(snapshot['__occurrences__']['10/4/4']['api_graph']['output']['2']['inputs']['positive'], 'generated leaf')
        resources = importlib.import_module(self.presets.__package__ + '.resource_info').connected_resources(graph(api_nodes), '40')
        self.assertEqual(resources['loras'][0]['name'], 'style/example.safetensors')
        metadata = importlib.import_module(self.presets.__package__ + '.preset_metadata')
        replay, _, sources = metadata.expand_preset_references({'10': api_nodes['10']},
            {'nodes': [{'id': 10, 'type': 'ScenePresetReference', 'pos': [0, 0]}], 'links': []}, snapshot)
        generated = [(sources[node_id], node['inputs']['positive']) for node_id, node in replay.items() if node['class_type'] == 'ScenePromptLLM']
        self.assertEqual(generated, [('10/4/4/2', 'generated leaf')])
        self.assertIn('obsolete', self.presets.load_preset('flat-parent')['api_graph']['output']['4']['inputs']['llm_presets_json'])

    def test_resources_use_each_local_definition_and_lora_mode(self):
        shared = self.save('shared', basic_nodes())
        a, b = self.definition(shared, 'one'), self.definition(shared, 'two')
        for definition, mode in [(a, 'Illustrious'), (b, 'Anima')]:
            nodes = definition['api_graph']['output']
            nodes['5'] = {'class_type': 'SceneApplyLora', 'inputs': {'scene_prompt': ['4', 0],
                'lora_name': 'style/example.safetensors', 'model_mode': mode,
                'strength_model': 1.0 if mode == 'Illustrious' else 0.7, 'strength_clip': 1.0}}
            nodes['3']['inputs']['scene_prompt'] = ['5', 0]
            definition['workflow'] = outer_workflow(nodes)
        api = graph({'10': self.reference('shared', {'.': a}), '20': self.reference('shared', {'.': b}),
            '30': {'class_type': 'ScenePrompterQueue', 'inputs': {'scene_prompt1': ['10', 0], 'scene_prompt2': ['20', 0]}},
            '40': {'class_type': 'ScenePrompterExpand', 'inputs': {'scene_prompt': ['30', 0], 'model_mode': 'Illustrious'}}})
        resources = importlib.import_module(self.presets.__package__ + '.resource_info').connected_resources(api, '40')
        self.assertEqual(len(resources['loras']), 1)
        variants = resources['loras'][0]['variants']
        self.assertEqual({(v['model_mode'], v['applies']) for v in variants}, {('Illustrious', True), ('Anima', False)})

    def test_workflow_only_nested_reference_real_widgets_metadata_and_root_save_reload(self):
        child = self.save('child', basic_nodes('shared child'))
        child_local = self.definition(child, 'custom child', 2)
        child_serialized = json.dumps({'version': 1, 'presets': {'.': child_local}})
        root_nodes = basic_nodes('root')
        root_nodes['4'] = self.reference('child', {'.': child_local})
        root_nodes['4']['inputs']['scene_prompt'] = ['2', 0]
        root_nodes['3']['inputs']['scene_prompt'] = ['4', 0]
        root_workflow = outer_workflow(root_nodes)
        nested = next(node for node in root_workflow['nodes'] if node['id'] == 4)
        nested['widgets_values'] = ['child', '', child_serialized]
        root = self.presets.save_preset({'preset_id': 'root', 'name': 'root', 'output_node_id': '3',
            'api_graph': graph(root_nodes), 'workflow': root_workflow})
        root_local = copy.deepcopy(root)
        root_local['api_graph']['output']['2']['inputs']['positive_base'] = 'local root'
        local_json = json.dumps({'version': 1, 'presets': {'.': root_local}})
        api = {
            '1': basic_nodes('main')['2'],
            '2': {'class_type': 'ScenePrompterExpand', 'inputs': {'scene_prompt': ['1', 0]}},
            '9': {'class_type': 'SceneSaveImage', 'inputs': {'images': ['2', 0], 'scene_info': ['2', 6],
                'metadata_mode': self.nodes.SAVE_METADATA_WORKFLOW, 'expand_preset_contents': True}},
        }
        api['1']['inputs'].pop('scene_prompt')
        workflow = outer_workflow(api)
        workflow['nodes'].append({'id': 50, 'type': 'ScenePresetReference', 'pos': [800, 0],
            'inputs': [], 'outputs': [{'name': 'scene_prompt', 'type': 'SCENE_PROMPT', 'links': []}],
            'widgets_values': ['root', '', local_json]})
        self.presets.snapshot_presets_for_run('canvas-only', graph(api), '2', workflow=workflow)
        snapshots = self.presets.snapshot_presets_for_metadata('canvas-only')
        self.assertEqual(snapshots['__occurrences__']['50/4']['api_graph']['output']['2']['inputs']['positive'], 'custom child')
        metadata = importlib.import_module(self.presets.__package__ + '.preset_metadata')
        replay, expanded_workflow, _ = metadata.expand_preset_references(api, workflow, snapshots, expand_workflow_references=True)
        self.assertEqual(set(replay), set(api))
        self.assertNotIn('ScenePresetReference', {node['type'] for node in expanded_workflow['nodes']})
        self.assertIn('ScenePromptLLM', {node['type'] for node in expanded_workflow['nodes']})
        replayed_llm = next(node for node in expanded_workflow['nodes'] if node['type'] == 'ScenePromptLLM')
        self.assertEqual(replayed_llm['widgets_values'][2], 'custom child')
        # Explicitly saving the root edited graph keeps the child customization
        # in both API and real widget transport; it does not write the child file.
        self.presets.save_preset({'preset_id': 'root', 'name': 'root', 'output_node_id': '3',
            'api_graph': root_local['api_graph'], 'workflow': root_local['workflow']})
        reloaded = self.presets.load_preset('root')
        self.assertEqual(reloaded['api_graph']['output']['4']['inputs']['llm_presets_json'], child_serialized)
        nested_reloaded = next(node for node in reloaded['workflow']['nodes'] if node['id'] == 4)
        self.assertEqual(nested_reloaded['widgets_values'], ['child', '', child_serialized])
        self.assertEqual(self.presets.load_preset('child')['api_graph']['output']['2']['inputs']['positive_base'], 'shared child')

    def test_compact_list_llm_availability_and_nested_local_state(self):
        shared = self.save('child', basic_nodes('shared'))
        local = self.definition(shared, 'private saved output')
        inputs = local['api_graph']['output']['2']['inputs']
        inputs['description'] = ' a useful description '
        inputs['generation_state_json'] = '{"description":"private saved description"}'
        compact = self.presets._compact_preset_list_graph(local['api_graph'])['output']
        self.assertIs(compact['2']['has_llm_input'], True)
        for name in ('description', 'positive', 'negative', 'generation_state_json'):
            self.assertNotIn(name, compact['2']['inputs'])
        inputs['description'] = ' \n\t '
        self.assertIs(self.presets._compact_preset_list_graph(local['api_graph'])['output']['2']['has_llm_input'], False)
        reference = self.reference('child', {'.': local})
        reference_compact = self.presets._compact_preset_list_graph(graph({'10': reference}))['output']['10']
        compact_definition = json.loads(reference_compact['inputs']['llm_presets_json'])['presets']['.']
        self.assertIs(compact_definition['scene_compact'], True)
        self.assertEqual(compact_definition['metadata']['preset_id'], 'child')
        self.assertIs(compact_definition['api_graph']['output']['2']['has_llm_input'], False)
        self.assertEqual(compact_definition['api_graph']['output']['4']['inputs']['count'], 1)
        self.assertNotIn('private saved output', json.dumps(compact_definition))
        self.assertTrue(all(set(node) <= {'id', 'mode'} for node in compact_definition['workflow']['nodes']))
        ordinary = self.presets._compact_preset_list_graph(graph({'10': self.reference('child')}))['output']['10']
        self.assertNotIn('llm_presets_json', ordinary['inputs'])
        inputs['description'] = 'list availability'
        self.save('llm-list', local['api_graph']['output'])
        parent = basic_nodes()
        parent['2'] = self.reference('child', {'.': local})
        parent['2']['inputs']['scene_prompt'] = ['1', 0]
        self.save('nested-list', parent)
        listed = {entry['metadata']['preset_id']: entry for entry in self.presets.list_presets()['presets']}
        listed_llm = listed['llm-list']['api_graph']['output']['2']
        self.assertIs(listed_llm['has_llm_input'], True)
        self.assertNotIn('private saved output', json.dumps(listed['llm-list']))
        nested_list = json.loads(listed['nested-list']['api_graph']['output']['2']['inputs']['llm_presets_json'])['presets']['.']
        self.assertIs(nested_list['api_graph']['output']['2']['has_llm_input'], True)
        self.assertNotIn('private saved output', json.dumps(listed['nested-list']))

    def test_recursive_compact_local_state_omits_megabyte_text_and_preserves_source(self):
        child = self.save('child', basic_nodes('shared'))
        heavy = self.definition(child, 'positive-secret:' + 'p' * 1024 * 1024, count=7)
        heavy['api_graph']['output']['2']['inputs']['description'] = 'description-secret:' + 'd' * 1024 * 1024
        parent_nodes = basic_nodes('parent')
        parent_nodes['4'] = self.reference('child', {'.': heavy})
        parent_nodes['4']['inputs']['scene_prompt'] = ['2', 0]
        parent_nodes['3']['inputs']['scene_prompt'] = ['4', 0]
        parent = self.presets.save_preset({'preset_id': 'parent', 'name': 'parent', 'output_node_id': '3',
            'api_graph': graph(parent_nodes), 'workflow': outer_workflow(parent_nodes)})
        parent_local = copy.deepcopy(parent)
        outer = graph({'10': self.reference('parent', {'.': parent_local, '4': heavy})})
        source_before = json.dumps(outer)
        serialized = json.dumps(self.presets._compact_preset_list_graph(outer))
        self.assertLess(len(serialized), 20_000)
        self.assertNotIn('positive-secret:', serialized)
        self.assertNotIn('description-secret:', serialized)
        local = json.loads(json.loads(serialized)['output']['10']['inputs']['llm_presets_json'])
        self.assertEqual(set(local['presets']), {'.', '4'})
        child_compact = local['presets']['4']
        self.assertIs(child_compact['scene_compact'], True)
        self.assertEqual(child_compact['api_graph']['output']['4']['inputs']['count'], 7)
        self.assertIs(child_compact['api_graph']['output']['2']['has_llm_input'], True)
        nested_serialized = local['presets']['.']['api_graph']['output']['4']['inputs']['llm_presets_json']
        self.assertEqual(json.loads(nested_serialized)['presets']['.']['metadata']['preset_id'], 'child')
        self.assertEqual(json.dumps(outer), source_before)
        reloaded = self.presets.load_preset('parent')
        self.assertEqual(reloaded['api_graph']['output']['4']['inputs']['llm_presets_json'], parent_nodes['4']['inputs']['llm_presets_json'])
        self.assertEqual(self.presets._compact_local_preset_json('{}'), '{}')
        with self.assertRaisesRegex(self.presets.ScenePresetError, 'loaded in full'):
            self.presets.parse_llm_preset_overrides(json.dumps(local))


if __name__ == '__main__':
    unittest.main()
