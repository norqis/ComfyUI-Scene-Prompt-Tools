# ComfyUI Scene Prompt Tools

Build reusable prompt plans, combine variations, and generate them sequentially in ComfyUI. The nodes carry prompt choices, image size, filenames, and output paths through a Scene plan, then save selected PNG metadata.

## Install

Clone the repository into `ComfyUI/custom_nodes`, then restart ComfyUI.

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/norqis/ComfyUI-Scene-Prompt-Tools.git
```

This package has no separate Python dependency installation step.

## Update

From the custom-node directory, pull the latest files and restart ComfyUI.

```bash
cd ComfyUI/custom_nodes/ComfyUI-Scene-Prompt-Tools
git pull
```

## Quick Start

Create this minimal graph alongside a normal checkpoint, CLIP Text Encode, KSampler, and VAE Decode workflow.

```text
Scene Prompt -> Scene Empty Latent -> Scene Prompt Expand
```

Make these connections:

1. `Scene Prompt.scene_prompt` -> `Scene Empty Latent.scene_prompt`
2. `Scene Empty Latent.scene_prompt` -> `Scene Prompt Expand.scene_prompt`
3. `Checkpoint Loader (Simple).CLIP` -> both `CLIP Text Encode.clip` inputs.
4. `Scene Prompt Expand.ポジティブ` -> positive `CLIP Text Encode.text`; `Scene Prompt Expand.ネガティブ` -> negative `CLIP Text Encode.text`.
5. Positive `CLIP Text Encode.CONDITIONING` -> `KSampler.positive`; negative `CLIP Text Encode.CONDITIONING` -> `KSampler.negative`.
6. `Checkpoint Loader (Simple).MODEL` -> `KSampler.model`.
7. `Scene Prompt Expand.シード` -> `KSampler.seed`; `Scene Prompt Expand.潜在画像` -> `KSampler.latent_image`.
8. `KSampler.samples` -> `VAE Decode.samples`; `Checkpoint Loader (Simple).VAE` -> `VAE Decode.vae`.
9. `VAE Decode.IMAGE` -> `Scene Save Image.画像`; `Scene Prompt Expand.メタ情報` -> `Scene Save Image.メタ情報`.

Set the positive and negative base prompts on **Scene Prompt**. Set width, height, and batch size on **Scene Empty Latent**. Add a **Scene Save Image** node to write PNGs. Click **連続生成 (Continuous Generation)** on **Scene Prompt Expand** to run the complete plan one batch at a time.

## Prompt Data

Prompt candidates live outside the custom-node directory:

```text
ComfyUI/user/<user>/scene_prompt_tools/data/
```

For the default local user, this is:

```text
ComfyUI/user/default/scene_prompt_tools/data/
```

Do not put prompt data in `custom_nodes/ComfyUI-Scene-Prompt-Tools/data/`.

Directories under `data` are recursive categories. Every candidate file must be named `prompt.json`.

```text
data/
  Outfit/
    School/
      prompt.json
  Camera/
    prompt.json
```

Each `prompt.json` is a JSON array, not an object with an `items` field. `label` and `prompt` are required. `id` and `description` are optional.

```json
[
  {
    "id": "summer_uniform",
    "label": "Summer uniform",
    "prompt": "school uniform, short sleeves, pleated skirt",
    "description": "Light summer school outfit"
  },
  {
    "label": "Low angle",
    "prompt": "low angle"
  }
]
```

Use the Scene Prompt UI to create and manage saved prompt collections. They are stored separately at `data/保存済みプロンプト/<collection>/prompt.json`.

## Prompt Choices

Use braces to select one option when **Scene Prompt Expand** runs. Selection is seeded, so the same starting seed and generation index produce the same choice.

| Text | Result |
| --- | --- |
| `{A|B}` | `A` or `B`, each 1/2 |
| `{A|}` | `A` or empty, each 1/2 |
| `{a||}` | `a` 1/3, empty 2/3 |

Empty options are meaningful. Keep every `|` that represents a blank outcome.

## Presets

Create a reusable Scene fragment:

```text
Scene Preset Input -> Scene Prompt / Matrix / Queue / Merge / Count / Path / Empty Latent -> Scene Preset Output
```

One editor workflow can contain several independent Preset branches. Set a Preset ID and name on the Output for the branch you want, then click **保存 (Save)**. Saving keeps only that Output's connected upstream branch; unrelated nodes and other Preset branches are not included.

Each saved Preset requires one connected Input and one connected Output. Only Scene planning nodes and nested **Scene Preset Reference** nodes are accepted inside it; image-generation and image-saving nodes are not accepted.

In a regular workflow, add **Scene Preset Reference**, choose the saved Preset, and connect its `scene_prompt` output to the next Scene node or to Scene Prompt Expand. Its **Preset編集 (Preset Edit)** button opens the saved fragment in a new workflow tab.

## Nodes

| Node | Use |
| --- | --- |
| Scene Prompt | Adds base prompts and selected prompt candidates. |
| Scene Matrix | Creates one variation for each enabled row. |
| Scene Prompt Merge | Creates every combination of two Scene plans. |
| Scene Prompt Queue | Appends up to ten Scene plans in input order. |
| Scene Prompt Count | Multiplies the generation count for each row. |
| Scene Path | Adds output-folder parts without changing the prompt. |
| Scene Empty Latent | Sets width, height, and batch size for the plan. |
| Scene Prompt Expand | Produces one planned batch with prompt strings, seed, metadata, and latent image. |
| Scene Save Image | Saves PNGs using the Scene output path and filename information. |
| Scene Preset Input / Output / Reference | Save, reuse, and edit Scene plan fragments. |

## Scene Save Image Metadata

Choose the metadata mode on **Scene Save Image**:

| Mode | PNG contents |
| --- | --- |
| Full workflow | The complete workflow, including its canvas layout. |
| Execution path nodes only | The Scene branch and image-generation nodes used for that image, with their original layout. |
| Prompt only | No ComfyUI prompt graph or workflow. When メタ情報 is connected, Scene prompt text and seed are retained. |

Dragging a PNG back into ComfyUI can restore a workflow for the first two modes. **Prompt only** cannot restore a workflow.

## Import HTML Prompt Tables

`--input` accepts a directory containing HTML files directly. It reads `*.html` files in that directory only: it does not recurse and does not accept a single HTML file. Preview the result first, then merge it with existing files when ready.

```bash
python tools/import_scene_html.py --input path/to/html-directory --output path/to/data --dry-run
python tools/import_scene_html.py --input path/to/html-directory --output path/to/data --merge
```

Existing `prompt.json` files are unchanged unless you use `--merge`, `--replace`, or `--clean`.

## Troubleshooting

**The nodes do not appear**

Confirm that the repository is directly under `ComfyUI/custom_nodes/ComfyUI-Scene-Prompt-Tools`, then restart ComfyUI. After updating, run `git pull` in that directory and restart again.

**Prompt candidates do not appear**

Check the current user's `scene_prompt_tools/data` directory. The file name must be `prompt.json`; its top level must be a JSON array; and every item needs string `label` and `prompt` values. Use **設定再読み込み (Reload Settings)** in the candidate popup after editing files.

**A saved Preset cannot run**

Open it with **Preset編集 (Preset Edit)** and confirm one connected Scene Preset Input and Scene Preset Output. Allow Scene planning nodes and nested Scene Preset Reference nodes inside the saved fragment.

## Development

Run the checks from this repository.

```bash
npm ci
npm test
python -m unittest discover -s tests -v
python tests/check_public_package.py
```

## Support and License

Report bugs or feature requests in [GitHub Issues](https://github.com/norqis/ComfyUI-Scene-Prompt-Tools/issues).

Released under the [MIT License](LICENSE).
