import re
from pathlib import Path

import folder_paths


STORAGE_DIRECTORY_NAME = "scene_prompt_tools"
PUBLIC_USER_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def public_user_directory(user_id="default"):
    if not isinstance(user_id, str) or not PUBLIC_USER_ID_RE.fullmatch(user_id) or user_id.startswith("__"):
        raise ValueError("Scene Prompt user ID is invalid.")
    root = Path(folder_paths.get_user_directory()).resolve()
    directory = folder_paths.get_public_user_directory(user_id)
    if directory is None:
        raise ValueError("Scene Prompt user directory is unavailable.")
    directory = Path(directory).resolve()
    try:
        directory.relative_to(root)
    except ValueError as exc:
        raise ValueError("Scene Prompt user directory is outside the public user directory.") from exc
    return directory


def storage_directory(user_id="default"):
    return public_user_directory(user_id) / STORAGE_DIRECTORY_NAME


def prompt_data_directory(user_id="default"):
    return storage_directory(user_id) / "data"
