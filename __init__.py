from .scene_prompt_tools.nodes import (
    SceneEmptyLatent,
    ScenePromptCounter,
    SceneMatrix,
    ScenePath,
    ScenePromptMerge,
    ScenePromptExpand,
    ScenePromptQueue,
    SceneSaveImage,
)
from .scene_prompt_tools.prompt import ScenePrompt
from .scene_prompt_tools.presets import ScenePresetInput, ScenePresetOutput, ScenePresetReference
from .scene_prompt_tools.routes import define_routes

NODE_CLASS_MAPPINGS = {
    "ScenePrompt": ScenePrompt,
    "SceneMatrix": SceneMatrix,
    "ScenePath": ScenePath,
    "ScenePromptMerge": ScenePromptMerge,
    "ScenePromptCounter": ScenePromptCounter,
    "ScenePromptQueue": ScenePromptQueue,
    "SceneEmptyLatent": SceneEmptyLatent,
    "ScenePromptExpand": ScenePromptExpand,
    "SceneSaveImage": SceneSaveImage,
    "ScenePresetInput": ScenePresetInput,
    "ScenePresetOutput": ScenePresetOutput,
    "ScenePresetReference": ScenePresetReference,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ScenePrompt": "Scene Prompt",
    "SceneMatrix": "Scene Matrix",
    "ScenePath": "Scene Path",
    "ScenePromptMerge": "Scene Prompt Merge",
    "ScenePromptCounter": "Scene Prompt Count",
    "ScenePromptQueue": "Scene Prompt Queue",
    "SceneEmptyLatent": "Scene Empty Latent",
    "ScenePromptExpand": "Scene Prompt Expand",
    "SceneSaveImage": "Scene Save Image",
    "ScenePresetInput": "Scene Preset Input",
    "ScenePresetOutput": "Scene Preset Output",
    "ScenePresetReference": "Scene Preset Reference",
}

WEB_DIRECTORY = "./web"

define_routes()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
