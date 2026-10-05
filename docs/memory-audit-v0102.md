# v0.10.2 memory and prompt-generation audit

Status: root design approved by gpt-5.6-sol medium. Backend/frontend implementation and isolated Python/native browser verification complete; final review and public CI/release gates remain.

## Scope and observed evidence

The prompt-generation controller never queues a Comfy prompt or executes connected model loaders. Its LLM request contains description/model_mode only. Previously requested Civitai search/download/editor insertion is retained; these editor/service actions do not execute model weights. This audit guarantees that prompt generation cannot load connected Checkpoint, diffusion, CLIP, VAE or LoRA weights.

The root traced LLM HTTP/controller actions, Scene raw/lazy model links and deferred LoRA graph expansion, run prepare/claim/release/expiry, Preset ownership/metadata/snapshots/caches, schedule lazy representation, popup/removal/timer cleanup, LoRA/catalog/gallery caches, save conversion and image previews, and native undo retention. Keep production inference/queue/browser/server untouched.

Confirmed memory costs:

- Resolving 300 distinct LoRA titles leaves 300 entries in the session Map, while its persistent cache is limited to 120. File revisions add further distinct keys.
- Preset file (512 entries), local JSON (64), list (64 users), and full frontend source (32) caches have entry-count caps but no payload-size cap. A synthetic 70-revision local definition with a 64 KiB generated output retains 17.02 MiB with 64 entries; clearing that cache reduces retained memory to 0.22 MiB. The cache keeps both the serialized key and parsed API/workflow payload.
- Explicit hydration replaces compact entries in the global display-source Map with full definitions. A 20-source fixture expands that Map from 4,431 to 41,951,091 serialized bytes. Evicting the separate fullSources cache does not release bodies still owned by the global display map.
- A prepared run retains independently owned shared-definition and occurrence dictionary copies. The shared Preset entry is not identical to its uncustomized occurrence; occurrences do share a second copy among themselves.
- PNG conversion allocates a separate float clip array. A 2048x2048 RGB float32 probe peaks at 108 MiB; clipping the already-owned scaled array in place peaks at 60 MiB with the same pixel checksum and unchanged source.

## Design

### Prompt generation and frontend ownership

Keep generation as editor/service actions, without queuePrompt, /prompt, run preparation/finalization, Expand backend execution, resource inspection/hashing, or Comfy model loading. Preserve the existing small description/model_mode payload. Native tests must connect model/LoRA loaders and prove generation leaves their execution markers and Comfy queue untouched.

Full Preset hydration must be operation-local. Keep the global compact display-source map compact and unchanged. Use one operation-local source map/overlay for reachable Presets, with explicit source-identity guards against global list changes. All targets in that operation share its hydrated data. `prepareTargets` returns an operation context; the controller always calls its `dispose()` in `finally`, including preparation errors, retry and stale edits before the first commit. Disposal cuts references to targets, occurrences and detached graphs, and deletes or restores a Reference cache entry only when that entry still belongs to this operation. This compare-and-dispose must not erase a newer operation. Editor uses the same context, copies/projects its required workflow, and disposes before `app.loadGraphData`. Retry closures start a fresh operation rather than retaining a disposed context. No deep copy of the whole unrelated workflow, no asynchronous work on draw/load, no global full-body promotion. Preserve nested own override precedence, local generated edits, duplicate occurrence IDs, two-target commits and editor save/reload.

Keep full-source cache at 32 entries and additionally cap its serialized UTF-16 payload estimate at 16 MiB, computed once at insertion. Skip caching an oversize response but still use it for the requesting operation. Eviction must never delete active operation data. Keep availability checks and normal unchanged load free of requests and full graph construction.

Bound the session LoRA-title cache to the existing 120-entry preference, evicting the least-recently-used title/revision. Retain in-flight request deduplication and persistent cached titles. Do not add model-file reads on draw or candidate rendering.

### Backend Preset data

Use a small shared OrderedDict-compatible cache implementation for the three Preset payload caches, retaining their existing entry caps and adding accounting for the retained key/value object graph. Account each object identity once per entry, iteratively, on insertion only; conservative duplicate accounting across entries is acceptable. Budget local JSON and compact lists at 16 MiB each, file definitions at 32 MiB. Oversize payloads remain valid and are returned uncached. TTL refresh of the same payload must reuse the stored weight, avoiding another graph walk. Keep cache locks, LRU behavior, invalidation, failed validation, same-size file change detection, user isolation and copy-on-return. No byte eviction of active run plans or snapshots; their lifecycle remains release/expiry.

Apply the same helper to routes `_ITEMS_CACHE` and `_SAVED_PROMPTS_CACHE`, retaining 64-user caps with 16 MiB per cache. Their current mutable cache-record fill must be replaced with a single accounted insertion after constructing the value; TTL-only changes may retain its weight. Oversized prompt data is still a valid uncached response. Preserve TTL, concurrent invalidation generation checks and user isolation.

Compute retained size and construct large copies outside global/cache locks. Inside locks only retrieve references, check generation/cancellation/winners, replace/account entries and update LRU. File/list cache hits copy their acquired immutable payload outside the cache lock. Local JSON cache keeps its existing read-only shared return rather than introducing a copy on every hit. Snapshot combined copying also happens outside `_PRESET_LOCK`, followed by cancellation/winner checks and insertion under the lock.

Create a run snapshot using one deep copy of the combined shared definitions and occurrence map so aliases within that snapshot are preserved. Both must remain independent of source/cache/later saves. Keep local customized occurrences distinct, source identity semantics correct, and active snapshots fixed until release. No policy changes to reference coverage, queued runs, callback order, counts, seeds or metadata.

### PNG conversion

Keep the owned scaled array (multiplication already separates it from the input tensor), clip it in place using NumPy's out argument, then convert to uint8. Preserve clipping/truncation, dtype behavior, source image immutability, PNG pixels, metadata, naming, failure cleanup and returned image identity.

## Verification and release

- Backend cache budget/LRU/replacement/pop/clear/oversize semantics; TTL refresh cost; source/copy/user isolation; many local/file/list and prompt-data payloads; retained-memory before/after evidence. Assert expensive weight/copy work occurs outside shared locks, and concurrent invalidation does not restore obsolete entries. Do not allocate extreme real model files.
- Operation-local hydration: global source map remains compact; shared/nested/customized targets, sequential commits, error/stale/retry/editor paths release temporary ownership; bounded cache plus oversized uncached sources. No weakening asynchronous routing or manual-edit guards.
- Browser title-cache 300 paths/revisions remains <=120; old entries can resolve again; actual modal title/details/injection behavior remains correct.
- Native isolated CPU Comfy browser: connected standard/model/LoRA loader nodes do not execute during prompt generation; zero Comfy prompt/run/resource calls; two-LLM Preset generation, native insertion if retained, Undo/Redo, reload and editor HTTP Save/reload; zero delayed browser errors and legacy PNG load behavior.
- PNG actual output pixels and metadata, input tensor unchanged, measured temporary-memory reduction.
- Full frontend/Python/public package and real Comfy CI. Root final diff/runtime review plus gpt-5.6-sol medium final approval, patch PR/release/local hash sync; no production restart.

Retain the user's requested undo-history count. Existing run cleanup, bounded preview count, sequential service operations and lazy schedule representation are part of the audit; do not replace them speculatively when no failing case is demonstrated.

## Backend implementation and measured verification

- `PayloadCache` now accounts retained key/value objects at insertion and applies the existing entry limits together with the specified byte budgets to all five payload caches. Unchanged TTL refreshes reuse the original weight and payload. Cache invalidation generations prevent an older in-flight file/list/prompt read from restoring invalidated data. Oversized data is valid and is returned uncached.
- File/list copy-on-return, insertion copies/size accounting, run snapshot construction and repeated snapshot response copies happen outside their shared/cache locks. Local customization hits keep the existing read-only shared return. The list cache no longer stores its unused second copy of each entry in a `files` map.
- Preset Save builds its already-owned workflow/API payload, computes the hash, writes and verifies the staging file outside `_PRESET_LOCK`. Dependency validation and atomic publication retain that lock to preserve concurrent reference-cycle prevention. Nested dependency validation can still copy another Preset while holding this outer lock; this existing correctness boundary is deliberately retained rather than claiming all save validation is lock-free.
- Run snapshots use one combined deep copy, preserving identity between shared definitions and uncustomized occurrences, keeping customized occurrences distinct, and remaining independent of source/cache objects and returned response edits.
- Root's synthetic 70-revision fixture with a 256 KiB generated output in both API and workflow retained 64 entries and 64.94 MiB with only the previous count limit (67.23 MiB peak). With the 16 MiB payload budget it retained 15 entries and 15.22 MiB (17.51 MiB peak; 15.23 MiB conservative accounting). This is Python `tracemalloc` data for the synthetic fixture, not whole ComfyUI/GPU memory.
- The actual isolated 2048x2048 RGB float32 PNG Save path reached 60.015 MiB at pixel conversion, versus the original conversion probe's 108 MiB. Pixel checksum remained 1,599,078,426 and the input array was unchanged. Float32/float64 actual PNG pixels, metadata, returned image identity, filenames and staging cleanup are covered.
- Added 18 focused audit tests for object alias/cycle accounting, LRU/count/byte limits, replacement/removal/clear, valid oversize responses, TTL cost, lock placement, invalidation during reads/measurement, snapshot ownership and actual PNG output/peak. The full isolated Python suite passed 499 tests in 39.142 seconds, with 2 existing optional runtime skips. Production ComfyUI, LLM and GPU were untouched.

## Frontend implementation and root verification

- Full definitions are held in an explicit operation context. Generation and Editor dispose that context on all exit paths; compare-and-dispose preserves newer operations and restores compact availability, so a failed service request can be retried. Editor verifies tab/node/widget identity through asynchronous source loading and copies the workflow before disposal.
- Full-source LRU is bounded by 32 entries and a 16 MiB serialized UTF-16 estimate; an oversized response is still valid for its active operation. Session LoRA titles now use the existing 120-entry limit, including revisions and cache hits. In-flight request deduplication is retained.
- Root loaded 20 full sources with 1 MiB outputs. The compact global Map remained at 5,151 serialized bytes before and after all operations, with zero promoted full entries and zero entries in disposed operation maps. This measures serialized source ownership, not whole browser memory.
- Full frontend tests and the isolated native CPU browser passed. With actual registered CheckpointLoaderSimple, LoraLoader, UNETLoader, CLIPLoader and VAELoader connected through Scene Apply Model, prompt generation recorded zero loader executions, zero Comfy prompt/run/resource inspection requests, and an empty image queue. The LLM request contained only description/model_mode.
- Native verification also covered failed Preset generation followed by the actual Retry button, unchanged global compact sources, two-LLM generation/insertion, Undo/Redo, workflow reload, Editor HTTP Save/reload and zero delayed page errors. The historical 175-node PNG loaded in 1,520.2 ms. LLM and acquisition responses were fixtures; live inference quality and GPU sampling speed are not claimed.
