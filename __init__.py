from .scene_prompt_tools.nodes import (
    SceneEmptyLatent,
    SceneApplyModel,
    SceneApplyLora,
    ScenePromptCounter,
    ScenePromptReverse,
    ScenePromptDelete,
    ScenePromptToText,
    SceneMatrix,
    ScenePath,
    ScenePromptMerge,
    ScenePromptExpand,
    ScenePromptQueue,
    ScenePromptCallback,
    ScenePromptCallbackDiscord,
    ScenePromptCallbackRequest,
    ScenePromptCallbackDesktop,
    SceneSaveImage,
)
from .scene_prompt_tools.prompt import ScenePrompt
from .scene_prompt_tools.presets import ScenePresetInput, ScenePresetOutput, ScenePresetReference
from .scene_prompt_tools.routes import define_routes


NODE_CLASS_MAPPINGS = {
    "ScenePrompter": ScenePrompt,
    "SceneMatrix": SceneMatrix,
    "ScenePath": ScenePath,
    "ScenePrompterMerge": ScenePromptMerge,
    "ScenePromptCounter": ScenePromptCounter,
    "ScenePromptReverse": ScenePromptReverse,
    "ScenePromptDelete": ScenePromptDelete,
    "ScenePromptToText": ScenePromptToText,
    "ScenePrompterQueue": ScenePromptQueue,
    "ScenePromptCallback": ScenePromptCallback,
    "ScenePromptCallbackDiscord": ScenePromptCallbackDiscord,
    "ScenePromptCallbackRequest": ScenePromptCallbackRequest,
    "ScenePromptCallbackDesktop": ScenePromptCallbackDesktop,
    "SceneEmptyLatent": SceneEmptyLatent,
    "SceneApplyModel": SceneApplyModel,
    "SceneApplyLora": SceneApplyLora,
    "ScenePrompterExpand": ScenePromptExpand,
    "SceneSaveImage": SceneSaveImage,
    "ScenePresetInput": ScenePresetInput,
    "ScenePresetOutput": ScenePresetOutput,
    "ScenePresetReference": ScenePresetReference,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ScenePrompter": "Scene Prompt",
    "SceneMatrix": "Scene Matrix",
    "ScenePath": "Scene Path",
    "ScenePrompterMerge": "Scene Prompt Merge",
    "ScenePromptCounter": "Scene Prompt Count",
    "ScenePromptReverse": "Scene Prompt Reverse",
    "ScenePromptDelete": "Scene Prompt Delete",
    "ScenePromptToText": "Scene Prompt To Text",
    "ScenePrompterQueue": "Scene Prompt Queue",
    "ScenePromptCallback": "Scene Prompt Callback",
    "ScenePromptCallbackDiscord": "Scene Prompt Callback (Discord)",
    "ScenePromptCallbackRequest": "Scene Prompt Callback (Request)",
    "ScenePromptCallbackDesktop": "Scene Prompt Callback (Desktop)",
    "SceneEmptyLatent": "Scene Empty Latent",
    "SceneApplyModel": "Scene Apply Model",
    "SceneApplyLora": "Scene Apply LoRA",
    "ScenePrompterExpand": "Scene Prompt Expand",
    "SceneSaveImage": "Scene Save Image",
    "ScenePresetInput": "Scene Preset Input",
    "ScenePresetOutput": "Scene Preset Output",
    "ScenePresetReference": "Scene Preset Reference",
}

WEB_DIRECTORY = "./web"

define_routes()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
