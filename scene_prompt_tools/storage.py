from pathlib import Path

import folder_paths


STORAGE_DIRECTORY_NAME = "scene_prompt_tools"


def public_user_directory(user_id="default"):
    directory = folder_paths.get_public_user_directory(str(user_id or "default"))
    if directory is None:
        raise ValueError("Scene Prompt user directory is unavailable.")
    return Path(directory)


def storage_directory(user_id="default"):
    return public_user_directory(user_id) / STORAGE_DIRECTORY_NAME


def prompt_data_directory(user_id="default"):
    return storage_directory(user_id) / "data"
