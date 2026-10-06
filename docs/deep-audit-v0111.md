# Whole-repository audit after v0.11.0

Baseline: 66a7190 (v0.11.0). Root performs investigation, design, final review and independent verification. Implementation is delegated after gpt-5.6-sol medium design approval. Production ComfyUI is busy and remains untouched. Testing uses isolated CPU servers/browser fixtures and temporary inputs.

## First reproduced findings and design

### Unchanged selected-list and Matrix draws repeatedly serialize their full data

selectedListLayoutCacheKey and matrixDisplayCacheKey stringify the entire selection / matrix JSON string before checking a warm cache. This copies and escapes the complete data on every draw, including two selected-list checks within one draw. Root's synthetic source-function probe (500 selection entries; Matrix with 30 such rows; 1,000 warm checks) measured 222 ms / 89,495,000 allocated string characters for selection and 6,847 ms / 3,344,919,000 characters for Matrix. These are workload probes, not end-to-end generation speed claims.

Use a node-owned current descriptor containing the existing scalar dependencies and raw immutable widget string. Compare fields directly, retaining one descriptor per selection role and one Matrix display descriptor; return/reuse stable identity for unchanged values. Do not hash, serialize, reparse, or store historical versions on hits. Include role and rounded width, and preserve Matrix link/source identity, modes and revisions. Include the current saved-prompts catalog identity in selection dependencies because saved-set headings derive from it; represent that identity by a lightweight revision/token rather than holding the catalog array in every node (inactive graph caches must not retain old catalog payloads). Clear these current references with existing node cache lifecycle. Remove matrixSourceCacheKey if still unused. Keep direct widget value changes visible without requiring callbacks. No global cache or new cap.

### Selection layout can refresh while its rendered canvas remains stale

Root changed the selected JSON from one label to another of the same layout size without invoking a callback. cachedSelectedListLayout returned a new layout, but cachedSceneWidgetCanvas reused the old canvas (only one render across both values). This can leave displayed selections inconsistent with current data. Invalidate the matching positive/negative render cache whenever its layout content changes, including externally supplied state/sections if that route uses a canvas. Preserve independent positive/negative ownership. Releasing/rebuilding the selected layout must also release its corresponding raster. Separately, when cachedSceneWidgetCanvas chooses direct drawing because the current dimensions exceed its existing raster threshold, release its now-unused old canvas; do not retain a buffer that will not be drawn.

Tests: real cache/draw functions, same-size text/weight edits without callbacks, role independence, width changes, current catalog replacement, Matrix JSON/source/mode/revision edits, normal clear/removal lifecycle, warm serialization/parsing counts, oversized raster release and later redraw. Native browser exercises actual widgets with synthetic safe text, preserves Undo/Redo and asserts rendered content changes, not just a helper result. Measure warm workload before/after without wall-clock thresholds in CI.

### Brace-choice expansion retains quadratic intermediate prompt text

prompt._expand_choices stores every shrinking whole prompt in a seen set. Every replacement removes at least the matched braces, so a cycle is impossible. Root measured 200 / 1,000 / 3,000 adjacent choices using tracemalloc: peak 459,926 / 11,078,102 / 99,260,406 bytes for input lengths 2,998 / 14,998 / 44,998. Repeated regex scans/string reconstruction also grow unnecessarily.

Replace this with an iterative left-to-right brace parser that resolves an innermost choice when its closing brace is reached. Retain only the current fragments/frames. Preserve the existing innermost-leftmost RNG call order exactly, including single-option/empty options, duplicate empty slots, whitespace stripping, nested choices, literal unmatched braces, commas and emphasis text. Do not change seed streams or add limits; avoid recursion. No choice syntax changes. Compare outputs AND RNG state with a small legacy oracle over fixed examples, deterministic generated balanced/unbalanced strings and many seeds. Add a large adjacent-choice allocation regression with a generous linear memory bound and a deeply nested non-recursion regression. Check Expand/To Text/Delete integration and native seeded replay.

## Coverage and follow-up audit

Read/reviewed so far: prompt composition/dedup/deletion; schedule plan types, Count policy, Queue/random indexing; Preset snapshot ownership and effective Switch dependencies; resource summaries; API catalog caches; LLM settings/service/providers; GPU handoff gate/hooks and owner cleanup; anonymous Civitai metadata/download lifecycle; batch finalization/release; UI node/modal/cache cleanup. Findings are limited to reproduced behavior; unsupported provider chains and existing filename counter semantics are not silently redesigned.

Further verification: complete remaining metadata/save/import/UI event paths, run the full test matrix, independently review every implementation diff, repeat a whole-area audit after fixes, then record residual limitations and release evidence. Production install synchronization requires an empty native queue and no active Scene continuous run.

First-pass baseline verification: all 698 Python tests passed (two opt-in native suites skipped), and all 25 frontend suites passed before changes. Root's independent deterministic schedule probe generated 1,000 Count/Queue/Matrix/Merge/Delete/latent combinations and checked 4,190 selected events for serialized roundtrip equality, image totals, repeat indices and event replay rank. No mismatch occurred. A native isolated browser reproduced the same-size selection label canvas defect and recorded 200 full-selection serializations across 100 unchanged draws. No production queue/model was touched.

## Primary references

- https://docs.comfy.org/custom-nodes/backend/lazy_evaluation (selected lazy input execution)
- https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WeakMap (owner lifetime)
- https://developer.mozilla.org/en-US/docs/Web/API/EventTarget/removeEventListener (listener cleanup)
