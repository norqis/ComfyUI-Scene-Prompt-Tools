from pathlib import Path

import folder_paths


STORAGE_DIRECTORY_NAME = "scene_prompt_tools"


def storage_directory():
    return Path(folder_paths.get_user_directory()) / "default" / STORAGE_DIRECTORY_NAME


def prompt_data_directory():
    return storage_directory() / "data"
