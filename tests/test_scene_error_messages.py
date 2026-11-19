"""Useful Scene errors identify the selected frozen route without changing validity."""
import copy
import importlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_scene_presets import basic_nodes, load_presets_module, matrix_line


class SceneErrorMessageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.presets = load_presets_module(Path(temporary.name))
        self.nodes = importlib.import_module(self.presets.__package__ + '.nodes')
        self.runs = importlib.import_module(self.presets.__package__ + '.runs')
        self.prompt = importlib.import_module(self.presets.__package__ + '.prompt')

    def save(self, preset_id, name, graph):
        return self.presets.save_preset({'preset_id': preset_id, 'name': name,
            'output_node_id': '360', 'api_graph': {'output': graph}, 'workflow': {'nodes': []}})

    def child_graph(self):
        prompt = basic_nodes()['2']
        return {
            '353': {'class_type': 'ScenePresetInput', 'inputs': {}},
            '354': {**copy.deepcopy(prompt), 'inputs': {**prompt['inputs'], 'scene_prompt': ['353', 0]}},
            '355': {**copy.deepcopy(prompt), 'inputs': {**prompt['inputs'], 'scene_prompt': ['353', 0]}},
            '359': {'class_type': 'SceneMatrix', '_meta': {'title': '表情差分'}, 'inputs': {
                'matrix_json': json.dumps({'version': 1, 'sets': [matrix_line('差分')]})}},
            '358': {'class_type': 'ScenePrompterQueue', 'inputs': {
                'scene_prompt1': ['354', 0], 'scene_prompt2': ['355', 0], 'scene_prompt3': ['359', 0]}},
            '360': {'class_type': 'ScenePresetOutput', 'inputs': {'scene_prompt': ['358', 0]}},
        }

    def setup_nested(self, matrix_preset=False, child=None):
        self.save('inner', 'FANZA_999アへ_差分', child or self.child_graph())
        outer = {
            '353': {'class_type': 'ScenePresetInput', 'inputs': {}},
            '379': {'class_type': 'ScenePresetReference', 'inputs': {'preset_id': 'inner', 'scene_prompt': ['353', 0]}},
            '360': {'class_type': 'ScenePresetOutput', 'inputs': {'scene_prompt': ['379', 0]}},
        }
        self.save('outer', '外側のセット', outer)
        graph = {
            '2': {'class_type': 'SceneApplyModel', 'inputs': {'model': ['loader', 0], 'clip': ['loader', 1], 'vae': ['loader', 2]}},
            '383': {'class_type': 'ScenePresetReference', 'inputs': {'preset_id': 'outer', 'scene_prompt': ['2', 0]}},
            '400': {'class_type': 'ScenePrompterExpand', 'inputs': {'scene_prompt': ['383', 0]}},
            '401': {'class_type': 'ModelSink', 'inputs': {'model': ['400', 5]}},
        }
        if matrix_preset:
            graph['2'] = {'class_type': 'ScenePrompterMerge', 'inputs': {}}
            graph['383'] = {'class_type': 'SceneMatrix', 'inputs': {'scene_prompt': ['2', 0],
                'matrix_json': json.dumps({'version': 1, 'sets': [matrix_line('行Preset', row_kind='preset', preset_id='outer')]})}}
        handle = self.runs.create_run_context('default')
        self.addCleanup(self.runs.release_run_context, handle, 'default')
        prepared = self.presets.snapshot_presets_for_run(handle, {'output': graph}, '400')
        self.assertEqual(prepared['total_batches'], 3)
        snapshots = self.presets.snapshot_presets_for_metadata(handle)
        plan = self.presets._scene_node_value(graph, '383', snapshots, set(), run_handle=handle)
        return graph, handle, plan

    def error(self, graph, handle, plan):
        with self.assertRaises(ValueError) as caught:
            self.nodes.ScenePromptExpand().expand(scene_prompt=plan, run_handle=handle, unique_id='400',
                current_index=2, seed_base=7, prompt=graph)
        return str(caught.exception)

    def test_third_nested_route_identifies_frozen_preset_and_unconnected_matrix(self):
        graph, handle, plan = self.setup_nested()
        # Editing the saved file must not rename the error during an active run.
        changed = self.child_graph()
        changed['359']['_meta']['title'] = '後から変更した名前'
        self.save('inner', '後から変更したPreset', changed)
        with mock.patch.object(self.presets, 'load_preset', side_effect=AssertionError('disk read')):
            message = self.error(graph, handle, plan)
        for text in ('Preset「外側のセット」', 'Preset「FANZA_999アへ_差分」', '未接続のノード「表情差分」', '3/3件目', 'Preset Input', 'scene_prompt'):
            self.assertIn(text, message)
        self.assertNotIn('#359', message)
        self.assertNotIn('後から変更', message)

    def test_matrix_preset_occurrence_prefix_resolves_the_same_nested_origin(self):
        graph, handle, plan = self.setup_nested(matrix_preset=True)
        message = self.error(graph, handle, plan)
        self.assertIn('Preset「FANZA_999アへ_差分」', message)
        self.assertIn('未接続のノード「表情差分」', message)

    def test_valid_rows_do_not_invoke_diagnostics_or_input_schema_scans(self):
        graph, handle, plan = self.setup_nested()
        with mock.patch.object(self.presets, 'missing_model_message', side_effect=AssertionError('diagnostic called')):
            for index in (0, 1):
                result = self.nodes.ScenePromptExpand().expand(scene_prompt=plan, run_handle=handle, unique_id='400',
                    current_index=index, seed_base=7, prompt=graph)
                self.assertIsNotNone(result['result'][5])
        with mock.patch.object(self.nodes.SceneMatrix, 'INPUT_TYPES', side_effect=AssertionError('schema scan')):
            self.assertIn('表情差分', self.error(graph, handle, plan))

    def test_unknown_snapshot_off_path_and_multiple_origins_do_not_invent_disconnections(self):
        child = self.child_graph()
        child['357'] = copy.deepcopy(child['359'])
        child['357']['_meta']['title'] = '別の先頭'
        graph, handle, plan = self.setup_nested(child=child)
        row = self.nodes.item_for_normalized_plan(plan, 2)['row']
        # A normal graph node with the same local ID is not the qualified source.
        graph['359'] = {'class_type': 'SceneMatrix', '_meta': {'title': '無関係'}, 'inputs': {}}
        unknown = self.presets.missing_model_message(row, '', graph, 2, 3)
        self.assertNotIn('未接続', unknown)
        self.assertNotIn('無関係', unknown)
        self.assertIn('Scene Apply Model', unknown)
        self.assertNotIn('別の先頭', self.presets.missing_model_message(row, handle, graph))
        child['356'] = {'class_type': 'ScenePrompterMerge', 'inputs': {
            'scene_prompt1': ['359', 0], 'scene_prompt2': ['357', 0]}}
        child['358']['inputs']['scene_prompt3'] = ['356', 0]
        graph, handle, plan = self.setup_nested(child=child)
        self.assertNotIn('未接続', self.error(graph, handle, plan))

    def test_normal_node_name_and_no_model_output_keep_existing_guard_semantics(self):
        graph = {'359': {'class_type': 'ScenePrompter', '_meta': {'title': 'Scene Prompt'},
                         'inputs': {**basic_nodes()['2']['inputs'], 'source_node_name': '通常の表情'}}}
        graph['359']['inputs'].pop('scene_prompt')
        graph['400'] = {'class_type': 'ScenePrompterExpand', 'inputs': {'scene_prompt': ['359', 0]}}
        graph['401'] = {'class_type': 'ModelSink', 'inputs': {'model': ['400', 5]}}
        plan = self.presets._scene_node_value(graph, '359', {}, set())
        with self.assertRaisesRegex(ValueError, '通常の表情.*モデル設定'):
            self.nodes.ScenePromptExpand().expand(scene_prompt=plan, unique_id='400', prompt=graph, seed_base=7)
        self.assertEqual(self.presets._node_label('359', graph['359']), 'ノード「通常の表情」')
        graph.pop('401')
        self.assertIsNone(self.nodes.ScenePromptExpand().expand(scene_prompt=plan, unique_id='400', prompt=graph, seed_base=7)[5])

    def test_common_preset_input_errors_name_fields_choices_bounds_and_keep_node_id(self):
        cases = [
            ('count', 'many', ('INT', {'min': 0}), ('生成回数', '整数', '接続元')),
            ('count', -1, ('INT', {'min': 0}), ('生成回数', '0以上', '修正')),
            ('count', 11, ('INT', {'max': 10}), ('生成回数', '10以下', '修正')),
            ('model_mode', 'unknown', (('Anima', 'Pony'),), ('モデル種別', 'Anima', 'Pony', '選び直')),
            ('lora_name', 'missing', (('existing.safetensors',),), ('LoRA', '一覧を更新', '選び直')),
        ]
        for field, value, definition, expected in cases:
            with self.subTest(field=field, value=value):
                node = {'class_type': 'ScenePromptCounter', '_meta': {'title': '表情の回数'}, 'inputs': {}}
                with self.assertRaises(self.presets.ScenePresetResolutionError) as caught:
                    self.presets._validate_literal_input('359', node, field, value, definition)
                self.assertEqual(caught.exception.node_id, '359')
                self.assertIn('ノード「表情の回数」', str(caught.exception))
                self.assertNotIn('#359', str(caught.exception))
                for text in expected:
                    self.assertIn(text, str(caught.exception))

    def test_invalid_value_keeps_technical_cause_and_missing_preset_offers_recovery(self):
        graph = {'359': {'class_type': 'PrimitiveInt', '_meta': {'title': '表情の回数'}, 'inputs': {'value': 'abc'}}}
        with self.assertRaises(self.presets.ScenePresetResolutionError) as caught:
            self.presets._scene_node_value(graph, '359', {}, set())
        self.assertEqual(caught.exception.node_id, '359')
        self.assertIn('ノード「表情の回数」', str(caught.exception))
        self.assertIn('整数で直接入力', str(caught.exception))
        self.assertIsInstance(caught.exception.__cause__.__cause__, ValueError)
        with self.assertRaises(self.presets.ScenePresetNotFoundError) as missing:
            self.presets.load_preset('deleted')
        self.assertIn('Preset「deleted」', str(missing.exception))
        self.assertIn('復元', str(missing.exception))

    def test_bad_selection_matrix_count_latent_and_callback_offer_specific_remedies(self):
        cases = [
            (lambda: self.nodes.ScenePromptCounter().count(count=-1), ('生成回数', '整数', '0')),
            (lambda: self.nodes.SceneEmptyLatent().apply_latent(width=65, height=512), ('幅', '高さ', '8の倍数')),
            (lambda: self.nodes.SceneEmptyLatent().apply_latent(batch_size=0), ('バッチサイズ', '1以上')),
            (lambda: self.nodes.SceneMatrix().build('{'), ('行データ', '括弧', '行を編集')),
            (lambda: self.prompt._compose_prompt_parts('', '{', '', False, 0, label='ネガティブの選択候補'), ('ネガティブ', '括弧', '選び直')),
            (lambda: self.nodes.ScenePromptCallback().apply_callback({}, frequency='unknown'), ('実行頻度', '初回', '毎回')),
        ]
        for operation, expected in cases:
            with self.subTest(expected=expected), self.assertRaises(ValueError) as caught:
                operation()
            for text in expected:
                self.assertIn(text, str(caught.exception))


if __name__ == '__main__':
    unittest.main()
