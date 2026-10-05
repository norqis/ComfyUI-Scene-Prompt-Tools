# Random Route Input and Output

## Contract and compatibility

The existing ScenePromptRandomRoute class ID remains registered. Change its display name to Scene Prompt Random Route Input and accept both old and new display-name aliases. Preserve its scene_prompt input, probability button, ten SCENE_PROMPT outputs, seeded draw and validation rules. Existing JSON/PNG/Preset/API class IDs and saved widget values must continue to load.

Add ScenePromptRandomRouteOutput, displayed as Scene Prompt Random Route Output. It takes optional scene_prompt1 through scene_prompt10 and emits one scene_prompt. It has no probability, count, ordering, fixed/multiply or other editable widget. Join with the existing shared queue/random-guard planning function using its default controls; do not duplicate the selection algorithm or enumerate schedules. Include the Output node in the selected route's source-node metadata and normal planning/cache/lifecycle support.

The intended graph is Input -> branch Prompt/LoRA/etc -> Output -> Count -> Expand. Output closes one innermost random group, passes only the winning branch for each generation and preserves outer groups for nested Input/Output pairs. Zero-percent branches remain inert and optional; all nonzero branches must join the same Output. Missing/duplicate/crossed branches fail before continuous generation starts. Count after Output schedules independent draws; a single latent batch keeps one selected route as before. Existing Queue joins remain supported and their old control behavior is unchanged.

Fresh Input nodes must retain their own join boundary even when only one output has 100% probability, so an inner deterministic Input/Output pair cannot accidentally close an outer Random. Reuse the existing hidden preserve_join widget: its new-node schema default becomes true, while Python method/IS_CHANGED omitted-argument defaults stay false for legacy API prompts. During frontend configuration, a legacy node with no serialized preserve_join value explicitly restores false; saved false and saved true must both retain their value. New serialization writes true. This is the only input schema default change; do not reorder existing widgets or remove the hidden compatibility field.

An Output with no connected inputs fails if used in an executed route rather than creating an empty generation. Unused/disconnected graph nodes remain irrelevant. Reuse existing queue validation for valid supplied plans; do not add graph-wide ancestry scans or new pairing IDs/settings. A deterministic legacy 100% route can still pass through the Output using the shared join behavior.

## Integration

Register/export the class, safe Preset evaluator, source metadata and frontend Scene node recognition. Treat Output as a queue boundary and multi-input join in frontend previews, cached plans, Expand graph collection, model/LoRA route selection, To Text/Delete, frozen PNG replay and callback traversal. Keep generic queue/join computations shared, but do not attach Queue's settings widgets to Output. Update input/output labels and errors to refer to a join/Output without removing legacy Queue support.

Coordinate frontend changes after the Civitai UI commit so the same shared file is not edited concurrently. Do not change unrelated node schema or resource handoff behavior.

## Validation

- Full node registration/contracts include Input legacy ID and new Output; Output has ten Scene inputs, one Scene output and no editable widgets.
- New Input defaults preserve_join true; legacy one-widget JSON/PNG load false, saved false remains false, frozen replay true remains true. Load old and new display aliases and preserve named/positional widget values.
- 50/50 -> two branch Prompts -> Output -> Count10 produces ten independent seeded draws with no count inflation. Output input connection order does not change the Input's output probabilities.
- 0%, 100%, zero/one active branch, missing nonzero branch, duplicate branch, crossed different Inputs, nested random pairs and nested inner 100% pairs.
- Shared Queue legacy tests unchanged; old 100% direct Expand works without a join. Large lazy Count remains compact, without schedule enumeration or capacity limits.
- Preset save/load/reference and nested Presets contain Output, retain namespaced random IDs and produce matching preview/actual counts and selected prompts.
- Only the winning Model/LoRA/Callback/Prompt/Delete values are present; source_node_names describe the selected generation route, not the whole graph.
- Actual isolated ComfyUI CPU HTTP and browser tests cover fresh Input/Output registration/UI, old PNG/JSON, ordinary generation and continuous preparation/planning. Existing Python/frontend/ComfyUI/GPU tests remain passing. Production generation is untouched.

## Queue controls when upstream is bypassed

Keep each Queue's own order_mode, alternate_block_size and downstream_count_mode widget values even while upstream Queue or Random joins make them disabled. The existing backend and frontend shared queue planners already ignore these controls when an effective upstream queue boundary is present; do not reset values or add a second property snapshot. Normal widget serialization supplies persistence through JSON/PNG/Preset and undo/redo.

When an upstream Queue is bypassed, evaluate its effective upstream input rather than treating its class as an active queue boundary. Enable downstream Queue controls only if no effective active Queue boundary or Random join remains. When bypass is removed, disable the controls again while preserving their values. Muted nodes, intervening Prompt/reroute nodes and multiple upstream Queue sources must follow the same effective-path rule.

Verify the actual mode-change event updates downstream controls and invalidates cached schedules, including the native ComfyUI bypass action, instead of only invoking the synchronization helper in a unit test. Reuse the existing event-driven mode/connection watchers and downstream refresh batching; do not add polling or graph-wide repeated scans. Tests cover active -> bypass -> active transitions, settings surviving each transition and graph serialization/reload, accurate locked/unlocked schedule counts, nested/preset paths, and a second still-active Queue continuing to lock the receiver.
