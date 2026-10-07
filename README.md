# ComfyUI Scene Prompt Tools

Build reusable prompt plans, combine variations, and generate them sequentially in ComfyUI. The nodes carry prompt choices, image size, filenames, and output paths through a Scene plan, then save selected PNG metadata.

## Install

Clone the repository into `ComfyUI/custom_nodes`, then restart ComfyUI.

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/norqis/ComfyUI-Scene-Prompt-Tools.git
```

This package has no separate Python dependency installation step.

## LLM prompts and Civitai LoRAs (v0.10.0)

Add **Scene Prompt (LLM)** as the first prompt node, or connect an existing Scene plan to its `scene_prompt` input. Select **Illustrious** or **Anima**, describe the content you want, then press **Generate**. The saved positive and negative fields are editable. Illustrious conversion favors English tags; Anima conversion favors concise English descriptions. Generation preserves your exclusions without adding a generic style or quality prompt.

Open the node's **LLM接続設定** and enter an OpenAI-compatible API URL. Port, model name, and LLM API key are optional. The defaults are `http://127.0.0.1/v1` and port `8080`; an empty port uses HTTP/HTTPS's default. Pasted URLs with ports are separated automatically. An empty model name uses the server's default; if the server requires a model and advertises exactly one, it is selected automatically. The API key authenticates your LLM server and is unrelated to Codex. The connection test fetches model names without inference. Settings are stored separately for each ComfyUI user; credentials are excluded from workflows and PNG metadata. Reopening settings shows only whether an API key is saved; leaving its field blank retains that key.

An OpenAI-compatible server such as Strata can be configured directly; no MCP server is required. Structured JSON output is requested automatically, with a schema-instruction fallback only when the server explicitly rejects that format. The tool imposes no output-token or request-time budgets and never starts a model server or GPU process automatically.

**Prompt Generate** on Scene Prompt Expand converts the reachable LLM descriptions before **Continuous Generate**. It reuses matching saved results, including your manual edits; use the LLM node's own Generate button to regenerate deliberately. Changing the model mode replaces the saved output pair when you generate again. Loading a workflow and generating images use the saved prompts and never start LLM inference.

Prompt generation sends descriptions to the configured LLM service; it does not queue image generation or execute connected Checkpoint, diffusion model, CLIP, VAE or LoRA loaders. Full Preset definitions and local customizations are shared only within the operation that needs them. Current prompt responses and file metadata replace their obsolete revisions, without arbitrary cache count or memory limits. Concurrent requests for the same file share one hash read within each metadata service, while different files can be read in parallel. Active generation snapshots remain fixed until their run is released. With the optional GPU settings below disabled, ComfyUI model residency is unchanged.

### Sharing GPU memory with a local LLM

After updating, restart ComfyUI and reload the browser. Open **ComfyUI Settings → Scene Prompt Tools → GPU** to choose either option. Both are off by default and are saved per ComfyUI user, separately from workflows:

- **プロンプト生成前にComfyUIモデルを解放** waits for active image generation, releases ComfyUI's cached models, then starts the requested LLM prompts. All reachable LLM nodes and LoRA selections stay in the same operation. Fully reused prompts need no release. The LLM stays loaded when prompt generation finishes.
- **画像生成前にLLMモデル・KVキャッシュを解放** releases the configured LLM before an accepted image job starts executing nodes. A continuous run keeps the setting captured when you click Generate, including while it waits behind another run. Its following images reuse the released state until a later LLM request loads the model again.

LLM release supports **Strata, Ollama and LM Studio** through their resource APIs. It keeps the API server running and targets the configured model or uniquely matching loaded instance. Unsupported release APIs, ambiguous model instances, busy providers and failed release confirmations produce an execution error before image nodes run. Prompt generation remains available through other OpenAI-compatible servers with the image release option disabled. LLM connection settings apply when the next operation starts.

When the generated description suggests useful LoRAs, the tool searches real compatible Civitai candidates and lets the LLM choose from those results. A successful download is verified and saved in the configured LoRA folder's `llm` subfolder. Selected Apply LoRA nodes are inserted immediately after their LLM node, preserving downstream connections and Queue order. Trigger prompts are stored on Apply LoRA and follow its model filter.

The local LoRA picker also provides **Civitai Search**. Choose `civitai.red` or `civitai.com`, an `Illustrious` or `Anima` model filter, and Most Downloaded, Most Liked, Most Collected, or Highest Rated. Public searches and downloads use the selected host anonymously; older selections default to `civitai.red`. Results appear as ten preview cards per row, with horizontal scrolling inside the results on narrow screens. Click a card or press Enter/Space for details, two preview images at a time, descriptions, publication date and separate model/version statistics. **Back** returns to the same results and scroll position without another search. Selecting a LoRA updates its node's model kind and triggers together. Reopening preserves the saved query, sort, host and selection; a search without a selected LoRA shows no selection summary. Errors retain the previous results, graph and selection and provide Retry. Workflow state keeps only small search settings, selection identities and local filenames; previews and descriptions stay outside the workflow.

### Customizing one Preset Reference

Prompt Generate can reach LLM nodes inside a Preset Reference. Its generated prompts and inserted LoRAs are saved on that particular Reference, so two references to the same shared Preset can produce different results. Nested references are identified by their position in the reference tree; repeated uses of the same nested Preset remain independent. A nested Reference's own customization takes precedence over customization inherited from its parent.

Opening the customized Reference in the Preset editor shows its saved local graph. Explicit Preset Save writes the currently open root Preset and retains nested customizations inside it. A shared nested Preset changes only when you explicitly open and save that child. The originating Reference retains its customization, and an image generation already in progress keeps the snapshot captured when it started.

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

When a KSampler's `seed` or `noise_seed` is unconnected and its after-generate control is `randomize`, Scene Prompt refreshes it for every normal or continuous queue send. Fixed seeds are retained. Connect **Scene Prompt Expand.シード** when the sampler must use the planned Scene seed.

Continuous runs, progress highlights, and Scene image previews stay with the workflow tab that started them. Switching tabs does not transfer an active run or its preview to nodes with the same numeric ID. Stopping a continuous run lets its current image finish, shows `停止処理中`, and then advances the waiting FIFO without allowing a stale Stop button to enqueue the workflow again.

Normal Queue submissions use the latest Scene Matrix enabled state and row order. Scene Save Image also avoids reusing deleted output filenames during the current ComfyUI session, and execution-path-only PNG metadata keeps reroute references consistent so the saved workflow can be reopened safely.

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

Click the **☆** at the top right of a prompt candidate to mark it as a favorite. Switch between **検索** (Search) and **お気に入り** (Favorites) in the candidate popup. Favorites are shared across nodes and workflows for the current user and are saved separately from workflow and PNG metadata.

## Prompt Choices

Use braces to select one option when **Scene Prompt Expand** runs. Selection is seeded, so the same starting seed and generation index produce the same choice.

| Text | Result |
| --- | --- |
| `{A|B}` | `A` or `B`, each 1/2 |
| `{A|}` | `A` or empty, each 1/2 |
| `{a||}` | `a` 1/3, empty 2/3 |

Empty options are meaningful. Keep every `|` that represents a blank outcome.

Repeated tags keep the spelling with the highest explicit `(tag:weight)` value; a plain tag counts as `1.0`. The winner stays at the first occurrence's position, and equal weights keep the first spelling. This applies separately to positive and negative prompts, including expanded choices and browser summaries. Negative tags still override positive tags regardless of weight. Only finite numeric colon weights are compared, using the innermost explicit weight for nested forms as ComfyUI does; decimal, exponent, trailing-dot, and digit-separated values are supported. `(tag)`, `[tag]`, `(tag;1.4)`, and `<lora:tag:1>` remain distinct. Anima conversion runs after this selection.

## Queue order and counts

**Scene Prompt Random Route Input** draws one of up to ten `scene_prompt` outputs on each Expand execution. Images within the same latent batch share that draw. Use **確率を設定** to enter percentages in 0.01% steps; the ten values must total exactly 100%. A 0% output may remain unconnected. Connect every positive-probability output through its own Scene path, then bring those paths together at **Scene Prompt Random Route Output** before Count or Expand. Output has ten inputs and no settings; it keeps only the selected path. Input/Output pairs can be nested, including an inner 100% path. A downstream Count 10 makes ten independent draws. The starting seed and generation index determine each draw, so replay is reproducible. Existing Random Route workflows and joins through **Scene Prompt Queue** remain supported.

Within a branch, Prompt, Path, Delete, Reverse, Apply Model/LoRA, and Callback preserve the one-image choice. Join the branches before using Count, Matrix, Empty Latent, or Merge. The same rule applies inside Presets. Execution-path PNG metadata fixes a gate to 100% when all consumers selected the same arm. If Expand and To Text used different arms, it retains the original probabilities and their individual seeds to reproduce both results. Full-workflow metadata retains the original probabilities.

**Scene Prompt Queue** accepts up to ten connected Scene plans. **並び順** selects **入力順** (finish each input in socket order) or **交互** (take turns between inputs). **1行の回数** repeats each generated row before moving on. For example, two single-row inputs A and B with a value of 2 produce `A,A,B,B`. With multiple rows per input, **交互** moves to the next input after the repeated row. The default value of 1 preserves the order and count behavior of older workflows. The former per-input repeat setting is no longer used.

Visible Scene node settings accept standard ComfyUI widget inputs, including Queue repetitions from an Integer node. Connected values are preserved on workflow reload and inside saved Presets; changing a count source updates Expand's displayed total. Presets support standard literal Integer, Float, String and Boolean providers. Linked LLM descriptions and Preset Output IDs/names also use their connected values.

**後続Count** applies to the whole configurable Queue: **乗算** (the default) lets a later Scene Prompt Count multiply its output; **固定** keeps that Queue's batches at their specified counts. Count 0 still cancels these Queue batches unless a preceding Count has protected their path with the option below. A Count placed *before* Queue has already changed its incoming plan and is unaffected by this setting.

Scene Prompt Count has **後続Countを有効化**, enabled by default. Turn it off to apply this Count and then ignore subsequent Counts on that path, including Count 0. Count 10 with this option off followed by Count 10 stays at 10 batches; leaving it on produces 100. Existing workflows and Presets without the option keep it enabled.

Protection follows each input through Queue, Matrix, Merge and Presets. For example, A → Count 3 (off) and B → Count 2 (on), joined by Queue → Count 10, produce A three times and B twenty times. The first Queue cycle keeps its original order; remaining cycles contain only paths eligible for multiplication. Queue row repetitions and Matrix/Merge combinations still apply normally. This option does not lock Queue controls.

For example, connect one-row inputs A and B and set **1行の回数** to 2. A later Count 10 leaves `A,A,B,B` unchanged with **固定**. With **乗算**, it produces `(A,A,B,B) × 10`.

If any connected input has already passed through a Queue, the receiving Queue becomes an ordered join: its settings are greyed out and it preserves the incoming sequences and their Count behavior. This also applies when Scene Prompt, Reroute, or Preset Reference nodes sit between the two Queues. Bypassing or disconnecting the upstream Queue makes the settings available again, provided no other active Queue or Random join remains upstream. Each Queue keeps its own settings while they are greyed out and restores their use when the controls become available.

## Text Output and Tag Deletion

**Scene Prompt To Text** outputs the current planned row as ordinary `positive` and `negative` strings. Choose **全てのノード** for the complete row or **直前のノードのみ** for the immediately preceding node's additions. LoRA prompt text is not included. A preceding structural node supplies its whole row; a node that only passes prompts through supplies empty strings in the latter mode. An unconnected input produces empty strings at index 0.

Normal Queue sends share one fresh starting seed across Expand and To Text nodes without changing their saved generation indexes. Continuous generation synchronizes To Text with the selected Expand's index and seed; when To Text has fewer rows, it cycles through them while choices use the full generation index for their seed. Choices resolve before duplicate removal and negative precedence. Execution-path PNGs keep the Scene branches needed by each text consumer and rebase each consumer's index and seed separately, including Presets.

**Scene Prompt Delete** removes comma- or newline-separated tags from each specified side of the incoming plan. Matching ignores surrounding/repeated whitespace, case, and explicit numeric weights; it is exact, so `bald` does not remove `bald head`. Later nodes can add the tag again. Deletion preserves choice slots: `{bald|hair}` becomes `{|hair}`, `{bald||hair}` becomes `{||hair}`, and `{bald}` becomes `{}` (one empty choice). Nested choices are supported. Delete can start an empty plan and can be saved inside Presets.

## Presets

Create a reusable Scene fragment:

```text
Scene Preset Input -> Scene Prompt / Matrix / Queue / Merge / Count / Reverse / Delete / Path / Empty Latent -> Scene Preset Output
```

One editor workflow can contain several independent Preset branches. Set a Preset ID and name on the Output for the branch you want, then click **保存 (Save)**. Saving keeps only that Output's connected upstream branch; unrelated nodes and other Preset branches are not included.

Each saved Preset requires one connected Input and one connected Output. Scene planning nodes, nested **Scene Preset Reference** nodes, the standard **If/Else Switch** on Scene paths, and its supported Boolean controls are accepted inside it; image-generation and image-saving nodes are not accepted.

In a regular workflow, add **Scene Preset Reference**, choose the saved Preset, and connect its `scene_prompt` output to the next Scene node or to Scene Prompt Expand. Its **Preset編集 (Preset Edit)** button opens the saved fragment in a new workflow tab.

### Named switches and nested Presets (v0.11.0)

Use ComfyUI's standard **If/Else Switch** (Japanese **スイッチ**, marked BETA) to choose a Scene path. Connect the path with the optional Prompt, Matrix or LoRA to **on_true**, and its original upstream Scene to **on_false** to bypass that addition when false. Both sides should supply a Scene plan. Expand's plan, counts and connected-resource information follow the selected Scene side.

**Scene Preset Input** provides ten Boolean outputs and one **スイッチ一式** output in addition to its existing `scene_prompt`. The bundle appears above Switch 1. Open **スイッチ名設定** to name each switch. Names appear on its output sockets and in Reference settings; changing a name does not change the connection or its number. Saved output slot numbers remain unchanged.

On **Scene Preset Reference**, open **スイッチ設定** above **Preset編集**. Each destination switch can be ON, OFF, or use any incoming switch 1–10. For example, destination 3 can use incoming 1, and several destinations can use that same incoming value. Destination labels come from the selected Preset; incoming labels describe the connected source. A missing incoming bundle supplies OFF values. New or legacy settings forward matching incoming numbers until changed.

To pass settings into a nested Preset, connect the parent's Input **スイッチ一式** output to the child's Reference **スイッチ一式** input. This carries all ten values through one wire. The child's settings decide which values to use; its Input then exposes those resolved values for switches or another nested Reference. There is no implicit inheritance without this connection, and changing a child does not change its parent or sibling references. Continuous generation retains the settings captured when that run starts.

ComfyUI's **Scene Prompt Tools** settings category contains both GPU options and Undo history. Updating preserves existing saved setting values.

## Per-scene models and LoRAs

Use **Scene Apply Model** and **Scene Apply LoRA** before Expand when each Scene path needs different generation resources. Both nodes can begin an empty Scene plan or receive an existing `scene_prompt`.

```text
Checkpoint Loader (Simple) -> Scene Apply Model -> Scene Apply LoRA -> Scene Prompt Expand
```

Connect MODEL, CLIP, and VAE from a checkpoint loader to **Scene Apply Model**. Separate diffusion-model, CLIP, and VAE loaders can also be connected. Connect Expand's MODEL and CLIP outputs to the corresponding sampler and text-encode inputs, and its VAE output to VAE Decode. The loader nodes are evaluated only when their Scene path is selected.

**Scene Apply LoRA** uses ComfyUI's standard `models/loras` list and stores its relative model path. Set **モデル種別** to `Illustrious` or `Anima` on each LoRA and on **Scene Prompt Expand**; both default to `Illustrious`. Expand loads only matching LoRAs, preserving their path order. With no matches, it returns the original MODEL and CLIP. If several **Scene Apply Model** nodes occur on one path, the last model bundle wins. The nodes may appear in either visual order while preserving the matching LoRAs' relative order. Scene Apply LoRA can be saved inside a Preset, including its model setting; older Presets without the setting use `Illustrious`. Scene Apply Model stays in the outer workflow because its MODEL, CLIP, and VAE links point to external loader nodes.

**LoRAを選択** opens a searchable list, with **Civitai Search** next to Close. Visible rows look up the Civitai model title by file hash in the background, trying `civitai.red` first and `civitai.com` after an error or missing record. A match shows the Civitai title and detail button. Only two confirmed missing records show the filename with a **Local** badge; an unresolved or failed lookup keeps the filename and offers confirmation or retry without caching the failure. Successful metadata is cached for that file version. Search matches paths and titles already retrieved. The node does not show a separate path/name summary; **詳細確認** remains available for the selected LoRA's local metadata and Trigger Words. **注入** adds a Trigger Word to **positiveテキスト** once. **ポジティブ候補** and **ネガティブ候補** add selected prompt candidates beside the corresponding text fields. LoRA text and candidates apply in Expand only when its model type matches the selected LoRA. Scene Prompt To Text reads the Scene prompt itself without selecting a model type or adding LoRA text.

On **Scene Prompt Expand**, click **生成情報** above **連続生成** to inspect the resources connected to that Expand's Scene paths, including saved Presets. The read-only dialog lists each model file once: either a checkpoint or a separately loaded diffusion model, plus its CLIP and VAE files. It also groups repeated LoRA files and shows each distinct model type and MODEL/CLIP strength combination. The dialog describes the connected paths as they are now; it does not show a particular generation, prompt, or seed. **Civitaiを確認** looks up links for the model's main file (checkpoint or diffusion model) and LoRA files when requested. These hash lookups request public metadata anonymously through ComfyUI and link to `civitai.red`. A separately loaded CLIP or VAE has no Civitai lookup in this dialog.

## Callbacks

Use a callback to notify another service for a Scene batch. A configuration node creates a `callback` value; **Scene Prompt Callback** decides when it runs and passes `scene_prompt` through unchanged.

```text
Scene Prompt / Matrix -> Scene Prompt Callback -> Scene Prompt Expand
Scene Prompt Callback (Discord, Request, or Desktop) -> Scene Prompt Callback.callback
```

`scene_prompt` on **Scene Prompt Callback** is optional, so it can begin a plan. Place it anywhere on the Scene path, including inside a Preset. A Callback outside the Scene path is ignored, and a common Callback with no setting is a no-op passthrough. It never fires while a plan is previewed or counted.

| Configuration node | Fields |
| --- | --- |
| Scene Prompt Callback (Discord) | Webhook URL, text, optional display name. |
| Scene Prompt Callback (Request) | GET or POST, URL, text, text or JSON body, optional JSON headers. |
| Scene Prompt Callback (Desktop) | Desktop-notification title and text. |

**Scene Prompt Callback (Desktop)** displays an operating-system notification on the computer running the browser that started the run. Click its **デスクトップ通知を許可** button once to grant browser permission; the node never asks automatically while loading or generating. Browsers allow these notifications only on HTTPS or localhost. If that browser tab is closed, no notification is displayed. The callback completes when the browser reports that the notification was shown, not when the user dismisses it.

For GET, the text body is disabled; put query parameters in the URL. Variables used in URLs are percent-encoded. For a JSON body, write valid JSON and use variables inside string values, for example `{"content":"{all_positive}"}`. The common Callback node has **frequency** (`初回` or `毎回`), timeout seconds, and failure behavior (`続行` or `停止`). `初回` runs once for that Callback node during a continuous-generation run; `毎回` runs whenever its position is traversed in that run. Sending happens after Expand has finalized the batch prompt and before image generation starts. Selected Callbacks run in path order and each request completes before the next Callback or image generation continues; `続行` logs a failure and continues, while `停止` stops the run.

**Scene Prompt Expand** also accepts optional `callback_first`, `callback_each`, and `callback_last` inputs. Connect a Discord, Request, or Desktop configuration node directly to them when the callback belongs to that Expand rather than to a location in the Scene path. `callback_first` runs only for the first batch, `callback_each` runs for every batch, and `callback_last` runs once after the final batch has generated successfully. These three inputs use a fixed **10-second timeout** and the Expand failure setting; older saved timeout values are ignored. The separate Scene Prompt Callback node retains its configurable timeout. `callback_last` waits for the request before its run context is released and before the next queued continuous run begins. It does not run after an error, interruption, manual stop, or closing the page. With `続行`, transport errors are returned as warnings and the next queued run continues; with `停止`, the completed run is released but later queued runs do not start automatically.

Text fields support these variables. `all` is the completed prompt for the current batch, not every batch in the run.

| Variable | Value |
| --- | --- |
| `{current_positive}` / `{current_negative}` | Prompt content accumulated before this Callback. |
| `{all_positive}` / `{all_negative}` | Final positive or negative prompt for the current batch. |
| `{current_node_names}` | Scene node display names used before this Callback, joined with `_`. Callback nodes, their configuration nodes, and Expand are excluded. |
| `{all_node_names}` | Scene node display names used by the complete current path, joined with `_`. Callback nodes, their configuration nodes, and Expand are excluded. |
| `{exec_current_count}` / `{exec_total_count}` | Current batch number (starting at 1) and total batches in this continuous run. |
| `{exec_replace_underscores}` | `true` when Scene Prompt Expand replaces `_` with spaces. |
| `{exec_anima_weights}` | `true` when Scene Prompt Expand applies the Anima emphasis-weight conversion. |
| `{exec_model}` | The model type selected on Scene Prompt Expand: `Illustrious` or `Anima`. |
| `{exec_seed}` | Seed for the current batch. |

Unknown variables stay unchanged, so a literal placeholder is never silently removed.

## Nodes

| Node | Use |
| --- | --- |
| Scene Prompt | Adds base prompts and selected prompt candidates. |
| Scene Matrix | Creates one variation for each enabled row. |
| Scene Prompt Merge | Creates every combination of two Scene plans. |
| Scene Prompt Queue | Orders up to ten Scene plans, repeats each row as requested, and applies the downstream Count policy. |
| Scene Prompt Count | Repeats countable Scene batches; optionally protects its path from subsequent Counts, including Count 0. |
| Scene Prompt To Text | Outputs the current row or previous node contribution as positive/negative strings. |
| Scene Prompt Delete | Removes exact tags from each prompt side, preserving empty choice slots. |
| Scene Prompt Reverse | Swaps positive and negative prompts for the complete plan or only the immediately preceding Scene node. |
| Scene Path | Adds output-folder parts without changing the prompt. |
| Scene Empty Latent | Sets width, height, and batch size for the plan. |
| Scene Apply Model | Selects the MODEL, CLIP, and VAE bundle for this Scene path. |
| Scene Apply LoRA | Adds a LoRA and strengths to this Scene path. |
| Scene Prompt Callback | Runs a configured callback at its position in a continuous Scene run. |
| Scene Prompt Callback (Discord) | Configures a Discord webhook callback. |
| Scene Prompt Callback (Request) | Configures a GET or POST callback. |
| Scene Prompt Callback (Desktop) | Configures a desktop notification for the originating browser. |
| Scene Prompt Expand | Produces one planned batch with prompt strings, seed, metadata, latent image, MODEL, CLIP, and VAE. |
| Scene Save Image | Saves PNGs using the Scene output path, filename information, and selected metadata mode. |
| Scene Preset Input / Output / Reference | Save, reuse, and edit Scene plan fragments. |

`Scene Prompt Expand` has two independent conversion options, both off by default; changing **モデル種別** does not change them. **_を空白に変換** replaces ASCII underscores in final positive and negative prompts before they reach CLIP, PNG metadata, and Callback variables. **強調値をAnima向けに変換** converts only forward-compatible emphasis weights from 1.0–1.5 to Anima's range; turning it off never reverses existing values. Existing workflows saved with the v0.4.12 Anima selection load with both options on, and former Illustrious selections load with both off. Workflows from versions without the model selector receive `Illustrious` while retaining their conversion settings.

**Scene Prompt Reverse** swaps positive and negative prompt content without changing row order, generation counts, paths, latent settings, or callbacks. Select **全てのノード** to swap the complete prompt accumulated so far. Select **直前のノード** to swap only the prompt contribution of the immediately preceding Scene node. If the preceding node is Path, Count, Empty Latent, or Callback, it has no prompt contribution and the operation is a no-op. Merge, Queue, Preset Reference, and Reverse treat each complete output row as their contribution.

When [ComfyUI-Custom-Scripts](https://github.com/pythongosssss/ComfyUI-Custom-Scripts) is installed, the positive and negative base-prompt fields opened from each **Scene Matrix** row use its existing autocomplete, including tag, embedding, and LoRA suggestions. Without it, the fields remain normal text inputs.

## Scene Save Image Metadata

If no explicit run directory is supplied, each Scene Save Image node keeps its latest automatic folder for the same prompt and output base. Changing either replaces that fallback; choosing an explicit directory or disabling the run directory releases it. Normal ComfyUI object caching retains the node between executions and releases it when unused; with `--cache-none`, a new node instance can choose a new automatic folder.

Scene Save Image keeps persistent filename counters for each output root, extension, padding, prefix, and counter position. New counter keys store their lock and state files in ComfyUI's system-user directory at `scene_prompt_tools/output_counters`, leaving output folders free of permanent counter sidecars. Existing output-side `.scene-save-*.lock` or `.state` files remain in use so running older versions can share their lock. Separate ComfyUI user directories do not share the new counter lock; neither do old and new versions starting together with no existing sidecars. Those combinations still prevent overwriting the same output filename but do not guarantee one prefix-wide sequence.

Choose the metadata mode on **Scene Save Image**:

| Mode | PNG contents |
| --- | --- |
| Full workflow | The complete workflow, including its canvas layout. |
| Execution path nodes only | The Scene branch and image-generation nodes used for that image, with their original layout. Bypassed nodes are omitted and their active upstream/downstream connections are restored. |
| Prompt only | No ComfyUI prompt graph or workflow. When メタ情報 is connected, Scene prompt text and seed are retained. |

Dragging a PNG back into ComfyUI can restore a workflow for the first two modes. **Prompt only** cannot restore a workflow.

**Presetの中身を展開** is optional and off by default, so existing workflows can omit it. Enable it to replace Scene Preset Reference nodes with the connected Scene nodes from the Preset contents fixed when generation started, including nested Presets. In **Full workflow**, this also expands disconnected Reference nodes visible on the canvas. In **Execution path nodes only**, only the Reference branch used for that image is expanded. This setting has no effect in **Prompt only** mode.

Version 0.4.14 preserves bypassed Scene nodes and their physical workflow links when a Preset is saved or expanded into PNG metadata. The API prompt still contains only ComfyUI's executable graph, so reopening the Preset restores the bypass layout and can queue it again.

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

Open it with **Preset編集 (Preset Edit)** and confirm one connected Scene Preset Input and Scene Preset Output. Use the supported Scene planning nodes, nested references and standard Scene switches inside the saved fragment.

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
