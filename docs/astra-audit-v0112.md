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

## Sources

- https://docs.comfy.org/custom-nodes/backend/lazy_evaluation
- https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WeakMap
- https://github.com/Comfy-Org/ComfyUI_frontend/blob/main/src/scripts/app.ts
- https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file
