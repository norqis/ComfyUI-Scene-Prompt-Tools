# ComfyUI Scene Prompt Tools

Create reusable prompt plans, variation matrices, ordered queues, saved presets, and sequential image runs in ComfyUI.

## Installation

Clone this repository into `ComfyUI/custom_nodes`, then restart ComfyUI.

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/norqis/ComfyUI-Scene-Prompt-Tools.git
```

## Main nodes

- **Scene Prompt** adds positive and negative prompt parts.
- **Scene Matrix** creates variations from enabled rows.
- **Scene Prompt Merge** makes all combinations of two plans.
- **Scene Prompt Queue** runs plans in input order.
- **Scene Prompt Count** multiplies each row's image count.
- **Scene Path** records an output subfolder.
- **Scene Empty Latent** records image size and batch size.
- **Scene Prompt Expand** emits one planned batch at a time.
- **Scene Preset** nodes save and reuse plan fragments.

Prompt items and saved prompt collections are stored in `ComfyUI/user/default/scene_prompt_tools/data`.
This keeps user data outside the replaceable custom-node installation. Version 0.1.1 does not read the former `custom_nodes/ComfyUI-Scene-Prompt-Tools/data` location.
When updating from 0.1.0, move the contents of the former `data` directory to the new location once.

## Tests

Run `python -m unittest discover -s tests -v` from this directory.
