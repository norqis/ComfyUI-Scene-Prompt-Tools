"""Saved LLM prompt output. Inference is an explicit editor action only."""

from .prompt import SCENE_PROMPT_TYPE, _split_prompt, _scene_prompt_change_key
from .plan import transform, with_source_node, MODEL_MODE_CHOICES, MODEL_MODE_ILLUSTRIOUS


class ScenePromptLLM:
    DESCRIPTION = "日本語などの説明をGenerateボタンでプロンプトへ変換します。保存したポジティブ・ネガティブは直接編集できます。画像生成時にはLLMへ接続しません。"
    CATEGORY = "Scene/prompt"
    RETURN_TYPES = (SCENE_PROMPT_TYPE,)
    RETURN_NAMES = ("scene_prompt",)
    FUNCTION = "build"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model_mode": (MODEL_MODE_CHOICES, {"default": MODEL_MODE_ILLUSTRIOUS}),
                "description": ("STRING", {"default": "", "multiline": True}),
                "positive": ("STRING", {"default": "", "multiline": True}),
                "negative": ("STRING", {"default": "", "multiline": True}),
            },
            "optional": {
                "scene_prompt": (SCENE_PROMPT_TYPE, {"display_name": "scene_prompt"}),
                "generation_state_json": ("STRING", {"default": "{}", "hidden": True}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "source_node_id": ("STRING", {"default": "", "hidden": True}),
                "source_node_name": ("STRING", {"default": "", "hidden": True}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, model_mode, description, positive, negative, scene_prompt=None, **kwargs):
        return (model_mode, description, positive, negative, _scene_prompt_change_key(scene_prompt))

    def build(self, model_mode, description, positive, negative, scene_prompt=None,
              generation_state_json="{}", unique_id=None, source_node_id="", source_node_name=""):
        plan = transform(scene_prompt, operation={
            "kind": "prompt_add",
            "payload": ["Scene Prompt (LLM)", _split_prompt(positive), _split_prompt(negative), False],
        })
        return (with_source_node(plan, source_node_id or unique_id, source_node_name),)
