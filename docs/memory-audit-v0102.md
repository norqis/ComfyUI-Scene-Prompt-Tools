# v0.10.2 memory and prompt-generation audit

Status: root investigation/design; implementation waits for gpt-5.6-sol medium approval.

## Scope and observed evidence

The prompt-generation controller never queues a Comfy prompt or executes connected model loaders. Its LLM request contains description/model_mode only. Existing Civitai search/download/insertion was explicitly requested earlier; a clarification about removing that feature is pending. This audit must guarantee that prompt generation cannot load connected Checkpoint, diffusion, CLIP, VAE or LoRA weights. Do not silently remove previously requested search features before that clarification.

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

Full Preset hydration must be operation-local. Keep the global compact display-source map compact and unchanged. Use one operation-local source map/overlay for reachable Presets, with explicit source-identity guards against global list changes. All targets in that operation share its hydrated data. Release the operation and its detached target graphs in finally, including error, retry and stale-edit paths. Editor projects/copies the required full definitions before opening and then releases the temporary hydration. No deep copy of the whole unrelated workflow, no asynchronous work on draw/load, no global full-body promotion. Preserve nested own override precedence, local generated edits, duplicate occurrence IDs, two-target commits and editor save/reload.

Keep full-source cache at 32 entries and additionally cap its serialized UTF-16 payload estimate at 16 MiB, computed once at insertion. Skip caching an oversize response but still use it for the requesting operation. Eviction must never delete active operation data. Keep availability checks and normal unchanged load free of requests and full graph construction.

Bound the session LoRA-title cache to the existing 120-entry preference, evicting the least-recently-used title/revision. Retain in-flight request deduplication and persistent cached titles. Do not add model-file reads on draw or candidate rendering.

### Backend Preset data

Use a small shared OrderedDict-compatible cache implementation for the three Preset payload caches, retaining their existing entry caps and adding accounting for the retained key/value object graph. Account each object identity once per entry, iteratively, on insertion only; conservative duplicate accounting across entries is acceptable. Budget local JSON and compact lists at 16 MiB each, file definitions at 32 MiB. Oversize payloads remain valid and are returned uncached. TTL refresh of the same payload must reuse the stored weight, avoiding another graph walk. Keep cache locks, LRU behavior, invalidation, failed validation, same-size file change detection, user isolation and copy-on-return. No byte eviction of active run plans or snapshots; their lifecycle remains release/expiry.

Create a run snapshot using one deep copy of the combined shared definitions and occurrence map so aliases within that snapshot are preserved. Both must remain independent of source/cache/later saves. Keep local customized occurrences distinct, source identity semantics correct, and active snapshots fixed until release. No policy changes to reference coverage, queued runs, callback order, counts, seeds or metadata.

### PNG conversion

Keep the owned scaled array (multiplication already separates it from the input tensor), clip it in place using NumPy's out argument, then convert to uint8. Preserve clipping/truncation, dtype behavior, source image immutability, PNG pixels, metadata, naming, failure cleanup and returned image identity.

## Verification and release

- Backend cache budget/LRU/replacement/pop/clear/oversize semantics; TTL refresh cost; source/copy/user isolation; many local/file/list payloads; retained-memory before/after evidence. Do not allocate extreme real model files.
- Operation-local hydration: global source map remains compact; shared/nested/customized targets, sequential commits, error/stale/retry/editor paths release temporary ownership; bounded cache plus oversized uncached sources. No weakening asynchronous routing or manual-edit guards.
- Browser title-cache 300 paths/revisions remains <=120; old entries can resolve again; actual modal title/details/injection behavior remains correct.
- Native isolated CPU Comfy browser: connected standard/model/LoRA loader nodes do not execute during prompt generation; zero Comfy prompt/run/resource calls; two-LLM Preset generation, native insertion if retained, Undo/Redo, reload and editor HTTP Save/reload; zero delayed browser errors and legacy PNG load behavior.
- PNG actual output pixels and metadata, input tensor unchanged, measured temporary-memory reduction.
- Full frontend/Python/public package and real Comfy CI. Root final diff/runtime review plus gpt-5.6-sol medium final approval, patch PR/release/local hash sync; no production restart.

Retain the user's requested undo-history count. Existing run cleanup, bounded preview count, sequential service operations and lazy schedule representation are part of the audit; do not replace them speculatively when no failing case is demonstrated.
