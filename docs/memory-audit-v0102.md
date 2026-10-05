# v0.10.2 lifetime and prompt-generation audit

Status: revised root design approved by gpt-5.6-sol medium at 92e0ee9. Backend and frontend ownership implementations, full unit suites and isolated native browser checks verified. Final combined review and public release gates remain.

## Required behavior

No arbitrary cache entry-count or byte-cap eviction. Retain data still needed by an active operation/run or a current model selection. Release obsolete revisions and data whose owning operation, modal, node or run has ended. Do not change ComfyUI model residency or unload any model. Prompt generation sends description/model_mode to the LLM and never executes connected Checkpoint/diffusion/CLIP/VAE/LoRA loaders or queues images. Previously authorized Civitai search/acquisition/editor insertion stays separate from weight execution.

Keep production server, GPU, queue and browser untouched. Root investigated the full repository and owns design/review; implementation is delegated. All existing generation/count/random/callback/Preset ownership behavior remains valid.

## Ownership instead of capacity eviction

### Frontend

Retain the already-tested operation-local Preset hydration and compare-and-dispose contract, including compact availability restoration before settled busy callbacks, fresh retry contexts, current-source identity guards, editor tab/widget guards and disposal before loading its copied workflow. Remove the global fullSources cache entirely: full definitions are shared only through the active operation's definitions Map. A source needed twice in the same operation is fetched once; another completed operation is not its owner. No numeric count/byte cap and no size serialization. Global compact sources never receive full bodies.

LoRA session and persistent title information represents current file identities, not a history of revisions. Replace the prior revision when resolving the same normalized path; reconcile against the actual catalog on catalog refresh to remove deleted/changed files. Keep all current file titles, without 120 or any other count/byte limit. Preserve current title/trigger/detail/injection behavior and in-flight request deduplication. A stale request must not repopulate a revision that catalog refresh made obsolete. Do not read model weights on draw or availability checks.

Civitai search results belong to their open search modal. Retain the current query/sort result for reuse, replace it when a different search supersedes it, and release it on dismissal, including late-response guards. Do not keep a global history capped at 20. Multiple open modals retain their own still-needed state; settings epoch/ranking/selection/error/retry behavior remains unchanged.

Selected-list layout caching stores the current state/width for each actual widget role. Changing that state or width replaces its obsolete layout; node removal releases it. Remove the historical 8-layout cache cap without accumulating resize/state history.

Terminal-event race records are pending delivery data, not an image/count limit. Remove the arbitrary 32-entry cap and retire consumed or expired records using the existing terminal retention age. Do not expire pending accepted runs or alter callback ordering. Leave the user's separately configured Undo history and UI sizing/preview behavior unchanged.

### Backend

Remove global full Preset-file payload caching and global serialized-local-JSON payload caching rather than replacing them with unlimited revision history. Each file read returns an independently owned validated definition. Existing resolved maps already share file definitions within a top-level prepare/evaluation operation; strengthen that contract if a duplicate read is demonstrated. Local JSON parsing gets an explicit operation-owned memo passed through Preset preparation so equal definitions parse/validate once within an operation; drop it when preparation returns. Snapshot copies own all needed data after that point. No global serialized JSON keys holding past revisions.

Preserve the existing current compact-list/items/saved-prompts response caches by stable user identity, using ordinary maps without user-count or byte limits. Replacement releases the old response. Discard expired inactive-user entries at subsequent cache access using their existing validity TTL, and retain the requested user's current entry for unchanged signature/hash revalidation. Removal/invalidation must not restore an old in-flight response: preserve generation checks and existing user isolation. Do not introduce background timers, payload-size walks or repeated copies on unchanged local memo hits. Cached compact/list copy-on-return stays outside locks.

Remove the now-unused payload_cache module and capacity/size-accounting code/tests/docs. Retain generation-safe invalidation for compact responses and all meaningful ownership/correctness regressions. File reads do not publish a stale full body to any global cache.

LoRA metadata, base-model hash and acquired-file hash caches keep only the latest observed revision per actual file identity, without 32/128-entry caps. Reconcile removed/changed catalog files where the catalog is already read; explicit same-path reads replace obsolete revisions, with stale publication guards. Keep hashes for current files, and stream file hashing as before; do not change or unload model objects. Do not add a full-catalog scan to each hash read.

Save fallback run-directory caching stores the current prompt identity per save-node/base-directory identity instead of historic prompt hashes with a 256-entry cap. Replace obsolete prompt entries. Retain stable directory reuse within a batch and independent nodes/output roots. Actual Scene run directories/snapshots continue to have their existing run-owned lifecycle.

### Existing verified reductions retained

Keep one combined snapshot deepcopy of shared definitions and occurrences, preserving alias relationships inside the owned snapshot and independence from source/cache/later saves. Construct it outside _PRESET_LOCK; winner/cancellation checks and publication remain locked. No eviction of active or waiting runs.

Keep PNG clipping in the already-owned scaled NumPy array before uint8 conversion. Existing isolated 2048x2048 RGB float32 Save test measured 60.015 MiB versus 108 MiB before; checksum 1,599,078,426, input pixels, metadata, filename and failure cleanup stay unchanged.

Keep Save's owned payload/hash/staging write/verification outside the global lock. Dependency validation and publication retain the existing lock for concurrent cycle prevention; do not add complex transactional machinery for that remaining correctness boundary.

## Tests and gates

- More than the former cache thresholds remain usable while current: files/titles/users/results are not rejected or evicted solely because count/bytes increased.
- Seventy large local JSON revisions leave no global historical payloads; repeated identical values within a single preparation share one validated result; later independent operations and customized occurrences remain independent.
- Duplicate shared/nested file references read/validate once per preparation, then active snapshots survive source changes until release. Current compact responses retain unchanged-hit efficiency, TTL/hash checks, copy isolation and invalidation races.
- Frontend full-body ownership and late error/stale/retry cleanup; global compact Map unchanged; full source needed twice fetches once per operation; next independent operation can fetch its current source again.
- Current file title/hash retained, same-path revisions replace older ones, deleted catalog identities disappear, late replies cannot resurrect invalidated identities. No per-draw hash/file reads.
- Search modal replacement/dismissal and concurrent modals; layout state/resize replacement; consumed/expired terminal events; save directory reuse and changed prompts/output roots.
- Full frontend/Python/public-package suites and isolated native CPU Comfy browser: connected standard loaders execute zero times during prompt generation; zero /prompt, runs or resource inspection calls; failed Preset Retry, two-LLM insertion, Undo/Redo, reload and editor HTTP Save, no delayed page errors and historical PNG load checks.
- Measure retained memory from actual ownership cleanup, not an arbitrary capacity cap. Do not claim live LLM quality or GPU sampling speed from fixture tests.
- Root final diff/evidence review and gpt-5.6-sol medium APPROVE, public CI, v0.10.2 release and installed-source hash sync. No production restart.

This revision concerns cache ownership. Integer precision/overflow checks, valid probability totals, parser/file-format integrity checks, explicit service output settings and user-requested Undo settings are not cache capacity controls and remain unchanged.

## Frontend and independent root verification

- The full frontend suite and isolated native CPU ComfyUI browser passed. The native test connected registered standard Checkpoint, diffusion-model, CLIP, VAE and LoRA loaders before the LLM path: prompt generation executed none of them and made zero image queue, run-preparation or resource-inspection requests. Failed Preset retry, two-LLM LoRA insertion, Undo/Redo, workflow reload and editor HTTP Save/reload also passed without delayed browser errors. Generated responses were fixtures; live LLM quality and GPU sampling speed were not measured.
- Forty distinct hydrated 1 MiB outputs remained available during their owning operations, with no capacity eviction. Disposing the operations left zero definition entries; compact global source bytes stayed 18,522 before/after. The isolated JavaScript heap settled from 43.62 MiB to 3.36 MiB after disposal/collection. Current/persisted titles beyond 300 files, revision replacement, acquisition before catalog refresh, failed temporary identities, modal dismissal, layout replacement and terminal-event consumption/expiry have focused regressions.
- Root independently reran all 25 memory ownership tests and the Preset frontend regression. A separate 70-revision probe using a 256 KiB API prompt retained zero operation bytes after input deletion/collection, with a 1.1363 MiB temporary peak. These are synthetic ownership measurements rather than a total browser or server memory claim.

## Backend lifetime implementation and evidence

- Full-file and serialized-local-JSON global Preset caches and the payload-capacity helper are removed. Independently owned file definitions share through the existing operation's resolved map; explicit local-JSON memos pass through shared/nested reference preparation, Save validation, list compaction and run preparation, without becoming global history. A repeated nested-reference snapshot reads and validates each shared file once; equal customization JSON validates once within that operation.
- Compact Preset lists and ordinary/saved prompt responses use stable user-keyed maps. Replacement/invalidation releases obsolete responses. Existing validity TTL removes inactive other users on the next access; the requested user's unchanged signature/hash can still reuse its current value. Copy-on-return and response construction remain outside cache locks, and generation checks prevent late invalidated reads from restoring old responses.
- LoRA metadata, base-model hashes and acquired-file hashes retain the current signature per normalized actual file. Aliases return the requesting name/kind rather than the identity of the first cache hit. Explicit revision changes replace older records; existing catalog reads retire removed/changed LoRA records and model selections. Hashing remains streamed, with post-read file/catalog checks guarding both publication and presentation.
- Fallback Save directory state keeps one current prompt identity per save-node/output-root identity. A changed prompt replaces that owner's previous entry, while repeated saves in the same batch and independent current nodes/roots keep their directory state.
- Combined snapshot copies and in-place PNG clipping remain. Save's own payload/hash/staging work remains outside the global lock; dependency validation and atomic publication retain the existing serialization needed to prevent concurrent reference cycles.
- The isolated LLM Preset fixture processed 70 revisions with a 256 KiB generated output represented in both API and editor workflow. After deleting operation inputs and collecting garbage, `tracemalloc` retained 0 bytes of those operations, with a 2,401,315-byte (2.2901 MiB) peak. Both removed global full-file/local-JSON caches were absent. This measures ownership cleanup in a synthetic CPU fixture, not whole ComfyUI or GPU memory.
- The 25 focused tests cover current data beyond former thresholds, operation sharing/independence, completed-revision release, user TTL/revalidation, response replacement/invalidation, snapshot aliases, file aliases and changed/deleted revisions, late hash/catalog races, Save directory identity, and actual PNG pixels/metadata/input immutability/temporary peak. The full isolated Python suite passed 506 tests in 43.370 seconds, with 2 existing optional runtime skips; the public package checker also passed. Production ComfyUI, LLM and GPU were untouched.
