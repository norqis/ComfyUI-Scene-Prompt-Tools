# Astra whole-repository audit after v0.11.1

Baseline: `2a06f57`. The user requested a full audit by a new GPT-6 Astra xhigh agent, root-owned implementation, review until approved, then another fresh Astra xhigh whole-repository audit. Repeat after any new findings before release. No additional limits or speculative defensive changes. Production ComfyUI is generating and remains untouched; all execution tests use isolated CPU/browser fixtures.

## First independent audit

Agent `astra_audit_round1` completed Python modules and API, schedule/Count/Queue/Random/Switch/Preset, model/LoRA, LLM/GPU/Callback, PNG save/replay, frontend candidates/modals/Undo/render caches/multiple workflows/continuous generation. Four reproduced groups:

1. Asynchronous capture reads another workflow after a tab change. Preset save mixed API A with workflow B; Preset switch bindings used B's values even when the native graph object was reused. Source names, Matrix synchronization and run preparation share this ownership boundary.
2. A delayed candidate edit updated the newly active workflow. Save/create responses could reopen an obsolete modal.
3. Preset Count2 then Matrix[x,y] preview produced x,y,x,y instead of x,x,y,y; Merge lost the y row. EmptyLatent batch3 followed by Merge lost the image count in the preview. Reproduced with actual frontend merge helpers and Python nodes.
4. Ordinary Matrix chains eagerly materialize all Cartesian row payloads. Actual SceneMatrix.build with three matrices of 10/20/30 rows produced 1,000/8,000/27,000 units: 0.366/2.570/8.419 seconds without tracemalloc. Independent memory runs retained 3.20/25.55/86.20 MB and peaked at 6.93/54.29/182.42 MB. These are CPU preparation probes, not GPU sampling measurements.

Root independently reproduced the tab races. Commit `63b98e4` uses the captured workflow for save/run metadata, captures switch fallback values before await, confines candidate replacement to retained original nodes, suppresses obsolete popup completion, and aligns simple preview Count/map/latent handling with the backend. Browser regression covers graph replacement and reuse, delayed save, names, switch values, Matrix data, and prepare ownership. Focused browser/queue/Preset/schedule/audit suites passed before the full validation below.

## Compact ordinary row schedules

Preserve the existing composite schedules and add compact expressions for ordinary contiguous rows: Matrix rows, row-product Merge, and repetition of each logical row. Row selection uses the child event's count/repeat index to recover the row's starting offset, preserving legacy left-row/right-row/repetition ordering without materializing combinations. Event references retain the candidate child path plus the selected within-row offset; replay rank recovers child row offsets after pruning. Only the legacy explicit rows view materializes rows when requested. No row-count cap, size threshold or historical cache.

Required verification: legacy eager oracle versus all selected rows/counts/metadata on small cases, variable-count Merge groups, repeated matrices, zero Counts, fixed Queue and downstream Count policy, callbacks/LoRA/latent/source trace, JSON roundtrip, PNG event pruning/rank, backend/frontend parity, and large Cartesian plans that retain only original data. Fix review and a fresh independent full audit remain mandatory.

The Astra reviewer approved the design after an independent 300-case / 19,649-event arithmetic comparison. Root implemented `matrix_rows`, `row_product`, and `row_repeat`, preserving scalar run fast paths and existing composite schedules. Root tests compare all row payloads, count/repetition/index metadata, image totals, JSON roundtrip and event ranks against an eager reference, plus fixed/strict Count, source pruning, callbacks, and large plans. Python and JavaScript retain input rows only; no cache or new limit is used. The pre-existing 100,000-row restriction on the explicit compatibility view was removed.

The same actual SceneMatrix.build benchmark now reports:

| Rows per Matrix (3 stages) | Events | Units retained | Preparation | Retained bytes | Peak bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10 | 1,000 | 1 | 0.0047 s | 67,912 | 97,832 |
| 20 | 8,000 | 1 | 0.0102 s | 113,934 | 183,178 |
| 30 | 27,000 | 1 | 0.0122 s | 154,924 | 267,333 |

During regression work root also reproduced exponential growth of duplicate UI labels in shared Merge chains. Backend Merge already removes duplicate labels; frontend Merge now follows the same behavior. Forty shared scalar merges stay a single run. The previous frontend terminated with a V8 invalid-size error in this probe.

Validation: the clean full Python run passed 713 tests (2 opt-in native classes skipped); npm syntax and all 25 frontend suites passed, including Chromium snapshot ownership races. Actual ComfyUI CPU/HTTP passed 44 existing tests, plus the new compact Matrix/Merge test: preparation count 120, selected boundary/interior events, saving only the selected graph, loading PNG metadata and executing the same prompt again. The complete isolated native Chromium suite passed, including normal/batch queue, physical Preset bypass, Count/Switch pointer edits, Undo/Redo, candidate/Matrix edits, LLM settings/resources, and multi-workflow behavior.

The first fix review reproduced one remaining shared-Merge growth path in `row.labels`; root fixed it in `b172622` and replaced the old test stub with the actual row/prompt merge helpers from the start of the suite. The 40-stage scalar regression now checks row labels as well as the compact schedule. It also found live Random validation after asynchronous batch capture; `789d84c` removes this redundant current-tab check and uses the existing backend preparation validation of captured probabilities/connections. A delayed same-graph/same-ID tab-change regression passes.

## Independent review and second full audit

The first Astra reviewer approved HEAD `789d84c`, covering all initial findings and follow-up fixes. Its independent comparison with `2a06f57` covered 1,496 graph compositions and 7,110 events: row payloads, count/repetition/order, serialization and replay rank after source pruning all matched. This included zero Counts, mixed fixed/strict policy, ordinary/alternating Queue, Matrix/Merge and latent maps. Full validation logs were also reviewed.

A new GPT-6 Astra xhigh agent (`astra_audit_round2`) completed a second whole-repository audit, including code outside the diff, and found two further issues:

- A failed GPU session-end or policy-release request discarded the browser's ownership record while the backend still retained the operation. A later action could then remain blocked. Root retains only failed cleanup IDs and retries once before a new operation; successful cleanup releases the records. No retry timer or history cache is added. Policy release is idempotent even when the server succeeded and only the response was lost; existing policies still enforce user/client ownership.
- A single-row Merge with downstream Count disabled was stored as a recursive product. Repeatedly merging a shared scalar row doubled traversal work. Root now folds scalar merges before composite classification and preserves the strict Count policy. No general-purpose memoization or additional cache is needed.

The reviewer approved `f045ed2`. Its independent comparison covered 1,728 compositions and 5,056 events, including free/strict/fixed Count, zero Counts, latent, named maps, Callback snapshots, downstream Counts and replay rank after pruning. In its shared-Merge probe, Python depth 14 improved from about 2 seconds to 0.00005 seconds; JavaScript depth 16 improved from about 740 ms to 0.008 ms. Python 714 tests, all 25 frontend suites, native CPU/HTTP 45 tests and complete native Chromium passed after these fixes.

## Third independent full audit

Another new GPT-6 Astra xhigh agent (`astra_audit_round3`) found three further issues:

- The actual LLM button skipped GPU preparation altogether when the release setting was OFF. Consequently, switching OFF after a failed session-end request also skipped pending cleanup. Root calls resource preparation once when there is actual pending inference, regardless of the setting. Fully reusable targets still make no request, and OFF does not acquire a new session. Both real controllers are tested together for single-node and Expand generation. An isolated native browser aborts one end request before the real coordinator receives it, switches OFF, then successfully generates another prompt.
- Expanding an inputless passthrough Preset into PNG metadata removed its seed Input. This could fail image saving or disconnect a required Scene input when reloading. Root retains the existing PresetInput when the outer Reference has no Scene input, in both API and workflow-only expansion. Nested Presets, required inputs and physical bypass paths keep their seed connection; upstream-connected References retain their existing behavior. Tests cover direct and nested passthrough, required Reverse input, bypass, Switch bundles, and actual PNG save/replay for full-workflow and selected-path metadata.
- Windows reserved names with a dotted suffix, such as `AUX.preview`, were accepted as directory components and then failed at actual saving. Root uses the existing reserved-stem check for save paths and the same rule in the standalone HTML importer. Existing plain reserved-name output folders keep their previous names. Actual Windows PNG writes cover the Save path, Scene path and run directory; importer tests cover category and subcategory writes.

The fixes are committed as `1900c5f` and `c9fcfd9`. The auditor independently reviewed all three fixes. Python 715 tests and all frontend suites passed before the final two Windows regressions, which also passed. Native CPU/HTTP verification covers 45 existing tests plus a new test with six PNG save/replay combinations; its fixture was corrected to include the required Reverse scope and to expect one retained Save node in selected-path metadata. The complete isolated native browser suite passed, including actual OFF LLM cleanup recovery. Release still requires a clean audit by a subsequent new agent.

## Fourth independent full audit

A new GPT-6 Astra xhigh agent (`astra_audit_round4`) audited the entire repository and reproduced seven more issues. Root implemented the fixes in `634998a`:

- Candidate/category/saved-prompt names and Preset IDs now report Windows reserved names before attempting a write. The filesystem-specific validation preserves existing Linux names. Image/import paths retain their sanitizing behavior.
- A named-switch passthrough Preset no longer replaces an external Scene input with its retained switch seed when saving expanded workflow metadata.
- Expanded Presets retain their whole-prompt boundary for subsequent To Text/Reverse previous-node scope. Each saved Preset Output becomes the existing Count 1 boundary used by runtime expansion; a workflow property restores the hidden trace flag on native graph serialization. Nested, bypassed and inputless paths, shared fanout, workflow-only references, and older internal-only source lineage are covered. Normal Preset Output behavior is unchanged.
- Selection dictionaries no longer inherit Object prototype keys. Categories named `__proto__`, `constructor` or `toString` survive editing, cloning, pruning and JSON round trips without renaming.
- A zero-row Merge product is normalized immediately after Random validation. Queue provenance is preserved; Count 0 rows retain their existing meaning. Forty shared empty merges retain no recursive product. Before the fix, the independent probes visited over one million units at Python depth 19 and over four million at JavaScript depth 21.
- Inputless Path, Empty Latent, unconfigured Matrix and Delete previews now retain the seed row, matching the backend. A connected all-disabled Matrix remains empty. Queue labels and image counts are tested together.
- Delete traverses nested prompt choices with an explicit work stack. It preserves option positions, unchanged whitespace and incomplete braces. A 1,500-level choice can pass through Delete and To Text without a recursion error; no depth limit is added.

The review caught an incorrect scope constant in the new Reverse test; `5dccc3e` uses the actual previous-node Reverse option and the direct/nested tests pass. All frontend suites and the complete isolated native browser suite pass, including four actual LiteGraph Preset expansion/reload cases. The full Python run passed 722 tests (2 opt-in native classes skipped). Native CPU/HTTP initially passed 44 of 46 tests; two Random-plus-ToText PNG re-save cases exposed an obsolete source ID on the new boundary. Root removed that pinned ID in `dfa7805`, retaining source aliases for initial path slicing but using current graph IDs on replay. Both native cases then passed. The same auditor approved `dfa7805` after independent checks of 187 related Python tests, metadata 26 tests, five frontend suites and 24,008 Delete comparisons against the old implementation, plus depths 250/1,500/3,000. A fifth new agent is conducting the next whole-repository audit.

## Fifth independent full audit

The new GPT-6 Astra xhigh agent (`astra_audit_round5`) completed another whole-repository audit and reproduced three issues. Root fixed them in `fae0af3`:

- A Preset placed inside an open Random branch failed when its runtime whole-prompt boundary was treated as an ordinary Count. Only the existing hidden whole boundary with integer Count 1 and downstream Count enabled now passes the schedule through unchanged. Normal Count restrictions remain. Live and Preset frontend planners agree, and compact Preset definitions retain the trace flag. Actual ComfyUI HTTP tests execute direct/nested Presets inside both Queue and Random Output joins, run each twice, save expanded PNG metadata and replay it.
- Inputless Count and both-inputless Merge now retain their seed row in previews, matching execution. Count 0 and explicitly empty connected Matrix inputs retain their prior meanings.
- Preset validation previously marked or cleared same-ID Reference nodes in the newly active tab after asynchronous capture/preparation/save. The operation now captures only its original Reference objects and checks ownership by object identity before changing errors. Preparation releases the captured list when settled. Eighteen deferred-response cases cover successful preparation, failed preparation and failed save, before capture or before response, with unchanged, separate and reused graph objects.

Focused regressions and the new native HTTP test pass. Full Python passes 723 tests (2 opt-in native classes skipped), all 25 frontend suites pass, and the complete isolated native Chromium suite passes. The same auditor approved `fae0af3` after independently re-running four frontend suites and 23 Python tests and reviewing the full/native logs. A sixth new GPT-6 Astra xhigh agent is conducting the next whole-repository audit.

## Sixth independent full audit

A new GPT-6 Astra xhigh agent (`astra_audit_round6`) audited every backend/frontend module, the complete node execution paths, Presets/PNG, API/storage, callback/FIFO, GPU/LLM, downloads/import and packaging. It independently passed Python 723 tests and 25 frontend suites, and checked 878 synthetic plans / 6,507 events for statistics, latent counts, serialization and source-pruned replay position. It reproduced one further lifetime issue with two triggers: completion before the HTTP queue response reinserted a finished submission and retained its closed workflow; deleting an unstarted native queue item had no terminal event to clear browser ownership records.

Root fixed this in `cea9654`. Submission registration consults the existing terminal-event map. The existing native queue-edit hook notifies only the owner client of IDs actually removed from the pending queue; it does not broadcast headless items or disturb running work. Deleting the last native item internally calls wipe, so one reentrancy flag under the native mutex keeps this a single removal notification. All terminal events share existing cleanup. Unused history polling and its timer map were removed; no cache, limit or periodic polling was added.

Regression checks cover 180 normal/Scene submissions with success/error/interruption before response, before claim or after claim, individual and complete pending removal, running-item retention and cleanup of workflow references. The auditor independently repeated the original large-workflow leak probe 100 times for each of three orderings with zero retained submissions/handles. A real two-client ComfyUI WebSocket test verifies removal delivery, single notification for native last-item deletion, policy release and preservation of the running job. Full Python passes 724 tests (2 opt-in native classes skipped), all 25 frontend suites and complete isolated native Chromium pass. The same auditor approved exact HEAD `cea9654` after independently verifying the complete product diff, seven worker-hook tests, the 180-case queue suite and its original 300-run lifetime probe. A seventh new GPT-6 Astra xhigh agent is now auditing the entire repository again.


## Seventh independent full audit

A new GPT-6 Astra xhigh agent (`astra_audit_round7`) completed another whole-repository audit and reproduced one remaining shared-schedule traversal issue in two forms: a deterministic singleton alternate Queue and a Random join followed by shared Merge branches. Even with one output event, each additional Merge doubled selection and replay work. Root first folded deterministic one-event sequence/alternate wrappers in `47dba6e`, preserving real repetitions and Random. The independent review then reproduced Random selection at 0.83 seconds and replay ranking at 3.90 seconds for 12 shared merges, and frontend preview at 2.58 seconds for 18 merges.

Root fixed this in `7da434b` and `d2c67d7`. Selection and Count-prefix calculations reuse the same unit/index/seed only inside that operation. Returned item metadata and mutable frontend prefix arrays are copied, while existing row transforms continue to produce new rows. Source pruning needs only whether a pending source lies outside the selected visible sources; it reuses plan/unit results with that Boolean context instead of retaining or replaying irrelevant prompt operations. Ranking reuses the same plan/path, retains temporary paths until it finishes, and both Random provenance collectors visit shared paths once. No persistent cache, new limit, preselected Random result or serialization change is introduced.

Tests cover 28-stage direct and separately mapped shared branches, different seeds, distinct indices, fixed/strict/zero Count, Matrix, source pruning with distinct branch contexts, actual Random Input/Output/Merge/To Text nodes and PNG Random freezing. Root's original 12-stage probe improved to approximately 0.00077 seconds for selection and 0.0010 seconds for replay; 28 stages remained around 0.0013/0.0020 seconds. The plan was collectible after the operation. Full Python passes 730 tests (2 opt-in native classes skipped), all 25 frontend suites and the complete isolated native browser suite pass; the final save collector change also passes all 25 To Text/Delete tests.

The same auditor approved exact HEAD `d2c67d7`. Its independent comparison against `47dba6e` matched 546 Python plans / 30,015 events / 8,963 prefixes / 9,378 replay positions and 426 JavaScript plans / 6,135 events / 1,274 prefixes. A 40-stage Random diamond with distinct source maps completed selection/replay in approximately 10.2/7.8 ms, with zero retained-memory increase after 100 operations and collection. Ten seeded 40-stage save-freeze probes and conflicting arms across multiple consumers also passed. A new eighth GPT-6 Astra xhigh agent is auditing the entire repository; release remains pending its independent verdict and final CI.


## Eighth independent full audit

A new GPT-6 Astra xhigh agent (`astra_audit_round8`) completed another whole-repository audit and reproduced two groups. Root fixed them in `c6fdfe8`, `9e7d3dc` and `e1ada0d`:

- Candidate creation and saved-prompt forms accepted repeated submissions. Navigating to another view and back within the same popup session while a POST was pending allowed its later success to erase a newly edited draft. Both forms now keep one pending operation per session/form, disable submission until it settles, and reset/navigate only while their original popup and submitted draft are still current. Reopened forms replace the pending operation's current button callback instead of retaining obsolete button subscriptions. Completion deletes the pending record; failures preserve input and allow retry. Explicit closing still discards the session as before. POST responses already provide complete lists, so normal success avoids a redundant forced GET. An older successful create/update/save invalidates catalog and in-flight read lineage, ensuring overlapping writes cannot leave a stale list or revert edited candidates.
- Selected-path PNG metadata used recursive traversal when contracting overwritten Apply Model nodes. Valid long model chains could finish planning but fail saving with RecursionError. The traversal now walks iteratively, reuses already resolved links and preserves terminal output slots, inputless/cycle behavior and intervening non-model nodes. No depth or node-count limit was added.

Real Chromium regressions cover both forms with normal completion, edits during submission, session-preserving navigation/reopen, failure/retry, independent nodes and independent forms. Read/write regressions cover create/create, update/create and save/save responses in reverse order, with and without an outstanding stale GET. A 1,501-node actual Apply Model chain reaches selected-path metadata with only the effective model retained, while existing LoRA/Queue/Merge/Switch cases continue passing. Full Python passes 731 tests (2 opt-in native classes skipped), all 25 frontend suites and the complete isolated native browser suite pass. The final callback simplification also passes the entire frontend suite.

The same auditor approved exact HEAD `e1ada0d`. Its independent Chromium reproductions now issue one POST and retain new drafts; the reverse-order update/create case retains the edited candidate. Its 1,500-node actual model plan saves correctly in about 30 ms, and 3,000 randomized comparisons of the old and new contraction functions match, including Model/LoRA/Queue/Switch, shared links, output slots, protected sources, inputless nodes and cycles. A new ninth GPT-6 Astra xhigh agent is conducting the next independent whole-repository audit.

## Ninth independent full audit

A new GPT-6 Astra xhigh agent (`astra_audit_round9`) audited the whole repository and reproduced three further groups. Root fixed them in `f3b6764`; `73b194d` aligns the native test with the existing pre-execution display contract:

- On Windows, IDs differing only in case silently overwrote the same Preset file and broke existing references with an unrelated LLM identity error. Under the existing publication lock, saving now checks the resolved existing filename before replacing it. Loading checks the validated stored ID and reports both IDs directly. Same-ID updates, last-save-wins, and repairing a corrupt definition still work. This adds no directory scan or read of the old large JSON during saving. Case-sensitive filesystems retain distinct IDs. Actual Windows tests cover concurrent casing collisions, original bytes/reference preservation and temporary-file cleanup.
- PNG expansion dropped original Reference-to-Reference physical links, although its API graph still contained them. Removed outer links now use the same two-endpoint resolution loop as inner physical links. Tests reconstruct execution from serialized links for two/three serial Presets with single or fanout entry points. The isolated native browser reloads twelve combinations of chain length one/two/three, nested Presets and physical bypass, preserving the whole-prompt boundaries and text.
- Optimized counts treated an encountered Random node as empty inside a nested Preset. Only the selected Random-containing definition now falls back to the existing schedule calculation, just as Count-hold paths already did. Its stats flow back through parent aggregation. Tests cover first/tenth 100% arms, multiple nesting levels, upstream Matrix/Count/latent, held Count and an unselected invalid Random branch that does not invoke fallback. Actual native graph loading displays 24 executions before preparation; the backend then confirms 24 executions and 72 images for latent batch 3. These passthrough Random fixtures explicitly preserve legacy `preserve_join=false`; current join-required defaults are unchanged.

Full Python passes 735 tests (2 opt-in native classes skipped), all 25 frontend suites pass, and the complete isolated native Chromium suite passes. Root reviewed all three product changes and reproduced each failing regression before the fix. The same auditor approved exact HEAD `73b194d9d9082ac3166114bff02fee03b2805b74` after independent Windows, physical-link and nested-Random probes and final test-log review. A new tenth GPT-6 Astra xhigh agent is conducting the next independent whole-repository audit.

## Tenth independent full audit

A new GPT-6 Astra xhigh agent (`astra_audit_round10`) completed another whole-repository audit and reproduced one further issue: normal Queue skipped preparation if any serialized Scene node already contained a run handle. Imported or saved workflows could therefore reuse an expired context, mix handles, or bypass current Preset preparation. Root fixed this in `0a28d43`: only a currently owned batch submission reuses its captured context; every normal execution prepares once and applies the fresh handle to all Scene targets. Removing the old handle scan also avoids duplicate graph walks. No retry, new cache, limit or fallback is added.

Focused tests cover stale, mixed and identical handles, two executions of the same prompt object, multiple Expands, terminal release and active/detached batch iterations. The complete isolated native browser loads the actual legacy Reference fixture, executes ordinary Queue twice through To Text and PreviewAny, and verifies one preparation per call, uniform fresh handles, successful backend history and the expected text. All 25 frontend suites pass. The backend is unchanged from the auditor's independent 735-test pass (2 opt-in native classes skipped).

The same auditor approved exact HEAD `0a28d439298b7f04510266ea3138c5d6eff7ac00`. Its independent whole-audit probes matched 12,000 frontend comparisons and 2,475 backend plans / 35,143 events. A new eleventh GPT-6 Astra xhigh agent will audit the entire repository again before release.

## Sources

- https://docs.comfy.org/custom-nodes/backend/lazy_evaluation
- https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WeakMap
- https://github.com/Comfy-Org/ComfyUI_frontend/blob/main/src/scripts/app.ts
- https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file
