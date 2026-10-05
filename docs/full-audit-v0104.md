# Full audit and corrective release v0.10.4

Historical audit: v0.10.5 supersedes the Civitai API-key settings and authenticated transport described here. Current Civitai operations use anonymous public access and have no API-key settings.

## Scope and baseline

Root inspected node execution and cache keys, lazy Queue/Count/Random schedules, prompt normalization and Delete/To Text, Preset save/expansion/run snapshots, PNG metadata and filename allocation, callback/run/FIFO lifecycle, browser ownership and resource information, LLM settings/transport/controller, Civitai acquisition and metadata caches. Baseline is v0.10.3 (ef8476f). All 523 Python tests passed with the two opt-in smoke skips; all 22 frontend suites passed. Passing existing checks does not prove the cases below correct.

Only read-only inspection of production is allowed. Reproduction and runtime verification use private temporary fixtures and a separate CPU ComfyUI server; never start image generation or local LLM inference in production. The former IL.json path is absent; a current 120-node workflow exists under a different name. No production workflow or private configuration is edited.

## Reproduced findings

1. LoRA metadata/title resolution and model Civitai lookup still fetch civitai.com directly from the browser; their detail/resource links also use .com. Search/download settings now specify civitai.red. These remaining paths ignore that choice and cannot use the private configured Civitai key. Confirmed by four source sites in scene_prompt_ui.js. The public .red search API returns valid JSON and .red download URLs; Highest Rated is accepted. No production token or weight download was used.
2. An unchanged LoRA inventory refresh changes lora_metadata._CATALOG_GENERATION and makes an in-progress read_lora_info restart its complete SHA256 read. A deterministic probe refreshed the same inventory during three hash passes: four complete hashes of the same unchanged file. Repeated picker openings can prolong disk work without any changed file.
3. Cancellation while awaiting to_thread(tempfile.mkstemp) loses ownership of its eventual descriptor/path before the download's finally block exists. A delayed-worker probe cancelled this stage and observed one leftover .download-*.part and one open descriptor. Cancellation also needs to settle file-writing/close/promotion workers before cleanup; cancelling an await does not stop its worker.
4. Strongest-emphasis deduplication compares the outer explicit weight in nested wrappers, although ComfyUI's token_weights replaces it with the innermost explicit weight. The installed parser, executed as two pure extracted functions without importing tensors/models, reports ((test:4):0.5) as weight 4 and (test:1.2) as 1.2; current dedup keeps the weaker second item. The existing nested test codifies the incorrect implementation assumption. Browser summaries also deduplicate only exact strings and can disagree with the final prompt.

## Design

### Consistent Civitai metadata transport

Add GET /scene_prompt/civitai/by-hash?sha256=... using the existing per-public-user settings and Civitai transport, fixed .red origin and scoped Authorization. Validate a 64-digit hexadecimal SHA256; this operation must never scan/hash/load any local model. Return only the metadata the UI needs (version/model identifiers and names, trainedWords) with an ordinary explicit not-found result for upstream 404. Keep authentication, network and malformed-success errors visible without echoing provider bodies/secrets. Reuse api_get with a narrowly scoped optional missing-result behavior rather than creating another transport stack or caching response history.

Frontend LoRA title/detail and model information lookup call that local endpoint after their existing explicitly requested local hash step. Share a small helper for this lookup; use .red for all current links. Existing persisted local title metadata remains usable and is not mass-cleared. A missing record still permits local trigger words; failures remain retryable and must not become successful negative caches. Preserve current-file/late-response guards, selected-state behavior, read-only prompt generation and zero weight-loader execution.

### File-specific hash publication

Retain only the latest inventory of physical identities and signatures, reusing list_loras' existing scan. An inventory refresh may invalidate removed/replaced files, but a result with the same current physical identity and signature can be published without rereading merely because the global generation changed. Preserve final filename resolution and file-signature checks. Deleted selections, remapped aliases and real replacement during hashing must still prevent stale publication. Do not add cache-count limits or retain old inventories/revisions. Do not scan the full inventory during each hash chunk or open model tensors.

### Cancellation-safe download ownership

Resource creation must hand off descriptor/path exactly once or clean up the eventual result if cancellation wins. Use a small task-owned I/O helper or equivalent: shield the worker from cancellation of its await and settle it before releasing/cleaning its file resource. The owner must also settle in-flight writes before close/unlink. Preserve streaming incremental SHA256 and atomic verified promotion; never reread a fresh temporary download or buffer the whole model. Existing final verified files survive cancellation after promotion and can be reused on retry; temporary files and descriptors must not survive an unsuccessful acquisition. Keep cancellation propagation and the download serialization lock; do not add timeouts, retries, capacities, background download managers or a complex resource framework.

### Actual explicit emphasis and summary parity

For already-supported nested explicit numeric wrappers, use the innermost finite explicit weight, matching ComfyUI's tokenizer. Preserve the original winning text, first position, first equal-strength spelling, negative precedence and choices. Do not flatten/rewrite saved user input or introduce interpretation of previously distinct implicit parentheses, square brackets, LoRA syntax or nonfinite/invalid weights. Browser prompt summaries must select winners by the same explicit identity/effective strength; retain supported finite number spellings including exponents, trailing dots and digit separators. These helpers are linear in input text and keep only one winner per current identity. To Text/Delete/Reverse/Matrix/Preset/Expand continue using their shared prompt logic.

## Regression and release gates

| Area | Required evidence |
| --- | --- |
| Metadata HTTP | .red origin, user key scoped to it, upstream 404 normal, 401/429/network/bad JSON still errors, invalid hash rejected before HTTP, no local hash/loader execution, minimal response and no secrets |
| Frontend | Local endpoint for both LoRA and model lookup, red links, trigger injection/title/selection retained, no premature negative cache, stale file/modal results ignored; actual Chromium/native Comfy browser interactions |
| Hash I/O | Same inventory and unrelated-file refresh during hash cause one full read; selected replacement/removal/remap cannot publish stale metadata; current caches remain reusable with no count cap |
| Cancellation | Deterministic cancel during temporary creation and write, worker settlement before cleanup, no partial/descriptor leak, lock reusable for following acquisition; network/hash mismatch cleanup and cancellation after atomic promotion remain correct |
| Emphasis | Nested stronger/weaker/equal winners agree with the real pure Comfy tokenizer; ordinary, scientific and digit-separated finite numbers, negative precedence, choice expansion and invalid syntax preserved; Matrix/Preset/To Text/Expand and browser summaries agree without editing saved input |
| Whole repository | Full Python/frontend suites, public package/history and whitespace checks, native CPU ComfyUI browser harness, legacy 175-node PNG load, ordinary/continuous seeds and Preset/Queue/Random/To Text/Delete contracts |
| Publication | Root final diff and regression review, gpt-5.6-sol medium APPROVE, required PR/main CI, squash merge and stable v0.10.4 release, exact installed tracked-file hashes, production process/queue/private settings preserved |

References: https://docs.python.org/3/library/asyncio-task.html#asyncio.to_thread (thread tasks and cancellation), https://docs.aiohttp.org/en/stable/client_reference.html (streaming requests and timeout ownership), https://docs.comfy.org/custom-nodes/backend/server_overview (node validation and change keys). No claim of real local LLM quality or GPU throughput improvement follows from fixture tests.

## Final implementation and independent verification

Implementation commits are 6588b23 (frontend) and 1713e64 (backend). Root personally reviewed the complete runtime changes, new regression fixtures, ownership and cancellation paths, and publication metadata. No required correction remains from that review.

- Independent full Python run: 539 tests, PASS in 46.314 seconds; the two explicitly opt-in smoke classes were skipped in this lightweight suite. Required CI separately runs real ComfyUI module and HTTP smoke tests.
- Independent frontend run: syntax checks and all 22 suites, PASS, including actual Chromium metadata errors/retries, current-file and delayed-response ownership, title/link/trigger injection, and Matrix edits.
- Public package/history and complete changed-range whitespace checks: PASS. Version is 0.10.4; no private settings or workflow contents are committed.
- Unchanged inventory, initial inventory establishment and unrelated-file changes during every hash chunk each produce one complete read. Replacement, deletion and selected alias remapping still reject obsolete metadata.
- Seven repeated-cancellation gates cover resource creation, write, late write failure, close, atomic promotion, manifest publication and unlink. Workers settle before cleanup and lock release; descriptors and partial files are removed; a queued next acquisition succeeds and reuses a verified promoted file. Open/close/network/hash failures also clean up.
- Root independently extracted only the installed ComfyUI pure parse_parentheses/token_weights functions and compared seven ordinary, nested, equal, exponent, trailing-dot, digit-separated and whitespace cases. Winners agree without importing tensors or loading any model. The upstream implementation is https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/sd1_clip.py.
- Separate CPU ComfyUI server with the actual frontend: PASS. Actual local metadata HTTP, model/LoRA detail widgets, retry, red links and trigger injection work. Weighted Matrix inputs retain their original text while producing the expected positive/negative parts. No delayed browser errors.
- The same native run verifies old/current widget layouts and connected links, Preset bypass save/load, Random, favorites after reload, instance-local LLM Preset generation/editor Save/reload, delayed routing invalidation, and ordinary/cached batch seed submissions. Connected checkpoint/diffusion/CLIP/VAE/LoRA loader executions remain zero during prompt generation, with no image queue/run preparation/resource inspection requests.
- The legacy PNG loads 175 nodes in 1490.6 ms and makes no LLM/Civitai service calls. This single isolated timing is a compatibility observation, not a GPU generation benchmark.

Final independent medium review, required PR/main CI, stable release and installed-file verification remain publication gates. Production is not restarted or reloaded by this audit.
