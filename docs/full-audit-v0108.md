# Full repository audit v0.10.8

## Ownership and scope

Root investigates and designs; implementation is delegated after gpt-5.6-sol medium design approval. Root reviews the final diff and independent tests. Baseline main is c212aff (v0.10.7). Production ComfyUI is busy; no queue mutation, model inference/unload, restart, browser reload or private workflow edits are permitted. Use isolated CPU fixtures. No cache capacity, token or output count limits are added.

Root inspected runtime nodes and save/index allocation, prompt parsing, lazy schedules and Count policies, Preset closure/evaluation/snapshot/storage/metadata, routes/run contexts, model/LoRA metadata/hash ownership, Civitai streaming acquisition, LLM connection/negotiation/resource adapters/GPU admission, frontend caches/previews/refresh, modal and LLM operation lifetime. Prior audit fixes remain in place. Existing user workflows were inventoried read-only (118 to 241 nodes); IL.json is absent under its former name. No private prompt contents belong in this report.

## Reproduced findings and design

### Cancelled run preparation retains its context

The runs/prepare route catches Exception, but asyncio.CancelledError derives from BaseException. A deterministic blocked-thread probe cancelled preparation after context allocation and observed one retained prepared continuous context. The worker can finish later, so merely cancelling its await cannot prevent snapshot publication.

On cancellation release both the owned run context and Preset snapshot, using the existing cancellation tombstone to reject late publication. Re-raise cancellation. Keep normal successful prepared/FIFO waiting contexts alive, and retain existing typed failure responses and user isolation. Do not add timers, capacities or a second run manager. Test cancellation before allocation, during the actual snapshot worker, after publication but before response, repeated cancellation, late worker completion and subsequent successful preparation. Assert no snapshot/context/operation retention and no resurrection.

### Cancelled final Callback remains in_progress forever

A blocked dispatch probe cancelled the finalize request, then allowed dispatch to complete. Callback state remained in_progress; a subsequent finalize request also returned in_progress. The state update currently belongs to the cancelled awaiting coroutine rather than the dispatch worker.

Dispatch completion must own the final state transition even when the HTTP waiter is cancelled. Use one small worker operation that dispatches and records success/failure in that same worker. Preserve at-most-once dispatch, in_progress while the actual worker runs, Continue versus Stop failure semantics, callback ordering and user/prompt ownership. Do not restart an uncertain callback on reconnect. Unexpected worker errors must also terminate state, rather than strand it. Test cancelled successful dispatch, Continue and Stop failures, repeated/cross-user requests during dispatch, cancellation before dispatch starts, and a following independent run. No production webhook or desktop notification is sent.

### Merge cache keys recursively embed upstream cache keys

scenePromptLineageKey embeds source cache keys at Merge, and cache-key construction embeds those lineages again. A shared six-node Merge fixture produced strings growing from 243 to 28,443 characters; this growth represents topology description, not additional generation rows. More nested shared branches amplify construction, storage and draw work despite unchanged content.

Replace recursive embedding with a flat lineage description built by an operation-local traversal. Visit actual node objects once; include deterministic input edges/slots and existing local invalidation fields (mode, revision, link identities, Count/Random/Delete/Reverse/latent/Matrix state, Preset snapshot/revision and Queue controls where relevant). Shared subgraphs are represented once, with edges retaining both connections. No global topology history, digest collision mechanism, capacity controls or model reads. Current per-node computed caches remain replaceable and releasable. Preserve immediate changes through bypass, Reroute, Queue, Preset and Primitive values and separate graph identity; cyclic malformed graphs must terminate safely. Batch downstream refresh must share its seen set across sources instead of revisiting the same descendants for each edited source.

Regression probes compare key size/traversal work across shared Merge depths and warm redraws, shared refresh sources, unchanged cache reuse, edits/topology/bypass/toggle/Undo/reload, separate graphs with reused node IDs and cycle termination. Test real UI loading/redrawing using the existing isolated native ComfyUI browser harness; do not claim GPU speed gains from these measurements.

Removed nodes must clear all computed/render/lineage caches through the existing cleanup helper, including any new cache. Keep only saved widgets/state needed by Undo; reconstruction is lazy after restoration. Do not retain removed nodes through a global traversal memo.

### Primitive settings do not agree with visible plan counts

Backend evaluation resolves PrimitiveBoolean/Int links. Frontend scenePromptCounterDownstreamEnabled reads only its hidden widget, so a linked false can appear as true; sceneEmptyLatentConfig also reads only widgets, ignoring a linked batch size. Count has a special primitive reader, but the other count-affecting settings lack parity.

Read supported standard Primitive values for Count's downstream Boolean and Scene Empty Latent's numeric values, resolving existing Reroute/bypass machinery. Include those effective values in the current lineage/cache identity so editing the Primitive updates totals without reload. Preserve unlinked/legacy defaults and existing Count/Random/Queue policies; do not execute arbitrary image/model nodes to calculate previews. Tests compare frontend totals and actual backend prepared totals with linked Count on/off and latent batch size, direct/Reroute connections, edits and bypass/reload. An unresolved dynamic provider must not be silently treated as a trustworthy literal result.

## Validation and publication gates

Add focused deterministic regression tests to existing suites and ensure CI invokes any added suite. Root must independently verify the fixes and inspect complete diffs. Run complete Python/frontend tests, public package/history/whitespace checks, native CPU module/HTTP smoke and native ComfyUI browser tests. Verify historical workflows and all Scene node registry contracts remain covered; LLM prompt generation still performs zero weight-loader/image queue operations. Obtain medium APPROVE before implementation and again on final coherent changes. If corrections pass, publish PR/stable v0.10.8 and update the installed copy only at an observed empty production queue. Production restart remains the user's action.

References: https://docs.python.org/3/library/asyncio-task.html (CancelledError and worker cancellation); https://docs.comfy.org/custom-nodes/backend/server_overview (node execution/change contracts); local standard Primitive definitions in comfy_extras/nodes_primitive.py. Existing active model/hash caches remain reusable; only obsolete operation-owned data should be released.

Baseline verification: all 649 Python tests pass (two opt-in native smoke skips) and all 23 frontend suites pass. These existing tests miss the four reproductions above; regression additions are required.
