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

Put local prompt data in `data/`. The directory is kept for you, but its contents are not tracked by Git.

## Tests

Run `python -m unittest discover -s tests -v` from this directory.
