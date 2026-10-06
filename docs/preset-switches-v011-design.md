# Preset switches v0.11.0

Status: implementation design approved by gpt-5.6-sol medium; production and GPU must remain untouched.

## Accepted scope

Use the installed standard `ComfySwitchNode` (Japanese スイッチ, BETA). Do not add a duplicate Scene switch. Support its Scene-path selection in saved Presets, preflight, normal execution, continuous execution, counts, Queue boundary/ordering, previews, connected resources and prompt lineage. Selection requests only the chosen branch; it must not pre-execute models, LoRAs, callbacks or an arbitrary Boolean provider during preview. Core static validation of both connected branches remains core behavior.

ScenePresetInput keeps scene_prompt at output 0. Append fixed Boolean outputs switch_1 through switch_10 at 1..10 and SCENE_SWITCHES output switches at 11. No dynamic port insertion, deletion or reordering. Each Preset can name the ten switches via a スイッチ名設定 modal. Only socket display labels change, not internal names, slots or types. Empty names display スイッチN. Duplicate names are allowed; mapping controls also display the slot number. Names are stored in Preset data and workflow serialization and restored after load/clone/Undo/Redo.

ScenePresetReference keeps scene_prompt input/output and adds one optional SCENE_SWITCHES input named switches. Put スイッチ設定 above Preset編集. For each target slot the modal chooses OFF, ON, or one incoming switch 1..10. The target label comes from the referenced Preset, and source choices use the incoming PresetInput names when identifiable. Mapping 1->3 and one source->multiple targets are supported. All targets read the same immutable incoming vector, so swaps have no ordering dependence. The child Input exposes the child's effective values and its own names. Its bundle can be explicitly wired to a grandchild. There is no implicit inheritance through containment or through scene_prompt.

Without a bundle the incoming values are all false. A missing settings field means identity mapping of incoming 1..10, so legacy/no-input References resolve to false and connected References forward matching slots. ON/OFF explicitly override that. UI must explain missing incoming values as OFF rather than pretending a connection exists. This avoids adding a separate Preset-default feature. Fixed ten is the user's choice; no extra cache/results/generation limits are introduced.

Unify all ComfyUI settings under category `Scene Prompt Tools`, including Undo history. Preserve existing setting IDs/values. No new settings controls are needed for this fix.

## Shared persisted contract

- PresetInput optional hidden STRING widget `switch_names_json`, default `[]`: JSON array of up to ten strings, normalized to ten display labels. Append to schema. No names in prompt evaluation semantics.
- Reference optional hidden STRING widget `switch_settings_json`, default `[]`: an array of ten entries when set. Entry is a JSON boolean (literal ON/OFF) or an integer 1..10 (incoming source index). Empty/absent array means identity 1..10. Keep bool and integer validation distinct in Python. No index-zero sentinels.
- SCENE_SWITCHES runtime payload: fixed ten Boolean values (tuple/list), no node instances, model tensors or UI labels. No OUTPUT_IS_LIST behavior.
- PresetInput internal hidden/optional value binding for effective switches may be added for GraphBuilder expansion; it is not a visible user socket. Keep name/schema coordination between backend and frontend explicit.
- The agreed internal binding is `switch_values` (SCENE_SWITCHES), hidden from the user. Names metadata is a permitted literal on PresetInput; external links to its internal inputs remain invalid in saved Presets.
- ComfyUI treats JSON arrays in API inputs as links. The internal literal binding therefore travels as `switch_values: {"values": [ten booleans]}` and is unwrapped at the Input/control boundary. The actual SCENE_SWITCHES output remains the plain Boolean tuple. Expanded workflow metadata stores the vector in Input `properties.scene_switch_values`; graphToPrompt restores the internal binding. This is replay state, not a new user setting or an override of a fresh Reference occurrence.
- Reference's switches input is a real dependency. Effective values/settings participate in runtime caching and memo identity. Do not depend on process-global mutable context. Input display names do not select connections.

## Backend implementation boundaries

1. Add a small reusable switch-value/name/settings module as needed; reuse it in Preset validation, evaluation, GraphBuilder expansion, compact metadata and resource traversal. Avoid a generalized arbitrary-node executor or reflection framework.
2. Standard Switch must be admitted separately from Scene classes: do not inject Scene-only hidden source arguments into the standard class. Validate its Boolean control and compatible Scene branches for Preset Scene traversal. Also permit the standard PrimitiveBoolean literal needed for the control; unknown providers must not be guessed or executed in preflight.
3. Preserve output slot when evaluating linked values. Existing special cases for Random and ToText plus new multi-output Input must not accidentally pass a whole tuple or a Boolean as a Scene plan. `_replace_link` currently maps every Input output to scene_prompt when upstream is present; replace only slot 0 and bind 1..11 correctly, including when scene_prompt is absent.
4. `_scene_node_value` currently schedules every linked dependency before evaluation: make Switch resolve the control before scheduling only the selected branch. Maintain iterative traversal for long graphs. The initial closure/snapshot/resource helpers need separate physical ancestry versus effective selected ancestry where appropriate; saved workflows retain both branches and bypassed/muted nodes.
5. Reference effective vector = resolve(incoming-or-false, mapping); evaluate and expand the Preset with this occurrence-specific vector. Nested siblings and repeated identical Presets never mutate each other. Memo keys must distinguish settings/effective vector where the surrounding occurrence is insufficient. Freeze run inputs with the existing run snapshot. Replaying metadata must preserve mappings and names.
6. Compact Preset list payload retains switch fields and literal control values needed by frontend counts, including PrimitiveBoolean.value, without restoring heavyweight prompt content. Exact slots/types remain validated. Preflight should support Preset editor defaults with no live Reference.
7. Resource information traverses the selected Scene branch using the same Boolean semantics without evaluating model/LoRA nodes. Continue displaying model-mode-inapplicable resources according to existing rules within that branch. Keep unrelated top-level standard Switch uses untouched.
8. Execution-path-only PNGs contract selected Scene switches to their chosen input: retaining the Switch while removing its unselected required input would produce an invalid replay. Full-workflow PNGs retain both branches, Boolean/bundle ports and physical bypassed/muted wiring. Preserve nonzero Input ports even when they appear only in physical workflow links. Resolve consecutive Switch contractions once per operation rather than walking each suffix repeatedly.
   With `expand_preset_contents`, a Reference and its incoming bundle edge are consumed by inlining; the child Input stores that occurrence's effective vector. Its fixed bundle output remains available, while a link to a deleted Reference does not. Ordinary saved Presets and runtime GraphBuilder expansion retain their bundle links.

## Frontend implementation boundaries

Support ComfySwitchNode in Scene traversals without overwriting core socket types or unrelated image/model switches. Resolve linked Boolean controls from known literals/Preset slots; unresolved controls produce an honest planning error/unknown state, never a guessed true/false. Pass output slots and effective vector through full and compact Preset stats, schedule, Queue boundary, preview, lineage/cache invalidation and native request preparation. A selected branch's Scene nodes must not be pruned merely because Switch uses on_true/on_false rather than scene_prompt names. Preserve required control and bundle dependencies. Standard Switch itself is not an extra generation row.

Only follow selected branches when identifying applied resources and execution lineage. LLM prompt-generation traversal must remain side-effect free (no image/model loading) and must not omit LLM nodes behind a standard Scene switch by treating it as an unknown break. If LLM generation's existing all-connected scope retains both branches, preserve that scope deliberately; it is a separate user action from image generation.

Use existing modal and graph transaction helpers for names/settings. Commit genuine changed values in one balanced owning-graph transaction, support Undo/Redo, reject stale modal owners, and never create history for normalization/draw. Refresh socket labels and source/target choice labels on relevant metadata changes; cache by existing revision, not repeated per-frame preset reads. No global queues or full-graph JSON clones for each row. Fixed socket indices are preserved when hiding internal widgets. Extend legacy configuration migration so old Reference widget order cannot shift into the new JSON fields.

## Tests and acceptance

- Pure values: all ten slots, bool vs integer mapping, 1->3, swaps, one->many, missing legacy fields, missing incoming, strict invalid values.
- Backend plans vs native execution: true/false literals and PrimitiveBoolean, chosen branch only, same and different counts, Matrix/Queue/Count, LoRA/text/Delete/ToText/callback path preservation, model paths deferred, zero extra rows, unknown Boolean preflight failure.
- Presets: full/compact parity; Input with/without scene upstream; nonzero Bool/bundle slots; nested 3 levels; sibling separation; same Preset two References with different mappings; bundle-only child dependency; no implicit inheritance when disconnected; bypass/mute round-trip; old Presets/JSON/PNG keep slot 0 and legacy widget state.
- Names/UI: edit, save, reopen, reload, clone, Undo/Redo; names on actual output ports and Reference destination/source dropdowns; duplicate/empty/Japanese names; 1->3 mapping survives rename; names don't alter values; stale modal after tab/reload cannot alter replacement graph.
- Native isolated browser: actual standard Switch MatchType connection and graphToPrompt output; change Reference settings via DOM, verify counts and prepared plan; settings sidebar has only Scene Prompt Tools category and existing values persist.
- Native isolated CPU executor/HTTP: execute representative nested mapped switches without real models/images; only selected callback/marker branch runs; consecutive runs with changed settings invalidate cache correctly; snapshot remains fixed during a run.
- Performance: no complete plan materialization, graph traversal remains memoized per operation/context, no per-generation-row switch/name copies or new unbounded global retention. Run existing regression suites.

Root reviews final product and tests and independently runs full Python/frontend/native suites. Required gpt-5.6-sol medium design and final review must approve. Check CI before merge, release v0.11.0, synchronize tracked files to the installed copy only while queue is empty, verify hashes; do not restart production. Keep private files out of commits. Archive the managed worktree after success.

## Sources

- https://docs.comfy.org/custom-nodes/backend/lazy_evaluation
- https://docs.comfy.org/custom-nodes/backend/expansion
- https://docs.comfy.org/custom-nodes/backend/more_on_inputs
- https://docs.comfy.org/custom-nodes/js/javascript_settings
- https://github.com/Comfy-Org/ComfyUI_frontend/issues/16642 (live-label refresh regression to account for in browser tests)
