# Queue ordering and Count composition design

Status: design only; no runtime behavior is changed by this document.

## Version decision

Target package release: `v0.7.0`, provided saved workflows and documented output remain compatible. The internal `SCENE_PROMPT` plan schema changes from v6 to v7. A schema revision is not by itself a public major release. If implementation needs to change the output of an existing workflow, stop and revisit the public version and migration rather than silently shipping it. The mode defaults to the current input order. No installed ComfyUI copy should be changed while it is generating.

## User-visible contract

Scene Prompt Queue gains `並び順: 入力順 | 1件ずつ交互`. Existing workflows and absent API values mean `入力順`. `1件` means one Expand execution batch, not one image in a latent batch. An alternating Queue reads one batch from each connected input, in numbered socket order; exhausted inputs are skipped. A Queue with no connected inputs retains its current one-empty-plan behavior. Count 0 yields no executions.

A Queue input whose effective plan already contains a Queue boundary locks the receiving Queue to `入力順`. This includes Reroutes, Scene transforms, and Preset References, not just a visually adjacent Queue. Its widget reads `入力順（上流Queueあり）` and is disabled. Connecting such an input normalizes a previously saved `交互` choice to `入力順`; disconnecting it does not resurrect that old choice. Graph load and connection changes refresh the widget. The Python node independently uses `入力順` when an input plan contains a Queue boundary, including direct API calls without the UI. A bypassed Queue leaves a boundary only if the effective bypass path actually contains one. Queue provenance is plan metadata; inspecting the whole graph at each execution or draw is unnecessary.

For the target graph:

```text
A -> b1 --\
          Queue A [1件ずつ交互] --\
A -> b2 --/                         \
                                     Queue C [入力順, locked] -> Count D [10] -> Expand
A -> b3 --\                         /
          Queue B [入力順] --------/
A -> b4 --/
```

The resulting order is `(A-b1, A-b2) × 10`, then `A-b3 × 10`, then `A-b4 × 10`. Queue A's own mode remains active. Queue C does not specify separate modes for its children. If Queue A's inputs have unequal lengths, one complete alternating cycle drains both inputs; Count after Queue A repeats that complete cycle. For example, `b1 × 2` and `b2 × 3` make a cycle `b1,b2,b1,b2,b2`, and Count 2 makes that exact five-batch cycle twice. Count before Queue A instead changes each input stream before interleaving; these two placements intentionally differ.

Count repeats each **top-level output unit** of its incoming plan. A run of one row is a unit; an alternating Queue is one unit. An input-order Queue concatenates its children's top-level units and does not turn the entire concatenation into a new unit. Thus Count after an ordinary Queue remains exactly the current per-row Count for old workflows, while Count after an alternating Queue repeats the alternating sequence. Queue B's ordinary rows remain separate units when Queue C concatenates them. Count factors in series multiply, and Count 1 preserves structure.

## Plan representation and indexing

Plan v6 stores a flat list of `(row, contiguous count, start_index)`. Flattening an alternating Queue into that list destroys its grouping before downstream Count; materializing every batch would also use memory proportional to generation count. Plan v7 uses immutable schedule units:

- `Run(row, count)` is a contiguous row run.
- `Alternate(inputs)` is one atomic unit, with each input holding an ordered plan. It drains input streams round-robin.
- `Repeat(unit, factor)` repeats an entire unit. Count multiplies each top-level unit by `factor`; adjacent repeats may be folded with checked multiplication.
- A plan's top level is an ordered sequence of units. Input-order Queue concatenates sequences; alternating Queue produces one `Alternate` unit. Empty plans and zero-count units have no executable batch.
- Event-local expansion and Cartesian combination units are introduced only where Matrix or Merge needs them, as defined below. Do not add an eager list of emitted batches or a second authoritative flat representation.

Each unit caches exact `total_batches` and `total_images`. All additions and multiplications check the existing JavaScript-safe maximum before constructing a result. The plan fingerprint hashes the canonical schedule, order mode, row data, and repeat factors. `normalize_plan` strictly validates v7 dictionaries; a process-local `ScenePlan` skips repeated validation as today. A v6 runtime plan is not accepted by a v7 evaluator; saved workflow JSON is migrated through the unchanged node definitions and defaults, not by loading an old process-local plan. A ComfyUI restart is required when installing the backend change.

`item_for_normalized_plan(plan, index)` remains zero-based and lazy. It locates a top-level unit using cached prefix totals; `Repeat` uses quotient and remainder of the unit length. For `Alternate`, if input stream lengths are `L_i`, the number of events in the first `r` rounds is `F(r) = sum(min(L_i, r))`. Binary-search the round, choose the active input by socket order, then look up that input's event at local index `r`. No operation expands `count` batches into Python rows. At most ten inputs are inspected per alternating level. Target memory is proportional to schedule nodes and distinct rows, not `total_batches`; lookup work is bounded by nesting depth and logarithmic count search.

An event carries final `global_index`, leaf identity/path, occurrence ordinal within that leaf, resolved row, and total plan counts. `row_index`, `repeat_index`, and `repeat_count` retain their exact old values for plans without alternating units. For alternating plans, `row_index` identifies the selected logical leaf, `repeat_index` is its occurrence number in this final plan, and `repeat_count` is that leaf's total occurrences. Repeated use of one upstream node through different Queue sockets has distinct leaf paths. Filename numbering, seed offsets, callback `exec_current_count`, and Expand's final callback use final `global_index`, never source-node evaluation order.

## Other Scene nodes

Prompt, Path, Latent, Reverse, Delete, Apply Model, Apply LoRA, Callback, and source-name tracking map selected leaf rows while preserving schedule units and their order. Callback snapshots are captured at their position in each leaf. Only nodes on the selected event path contribute to `source_node_ids`/`current_node_names`; a sibling Queue input must not leak into them. `first` remains once per callback node/run, `every` follows final event order, and Expand `last` fires after its last event.

Matrix before an alternating Queue expands each input stream in Matrix row order; the Queue then alternates their resulting batches. Matrix after an alternating Queue expands each selected event inline in Matrix row order, while preserving the enclosing alternating unit for later Count. For a plan without alternating units, Matrix keeps the current `matrix-row × original-run-count` order. This requires a lazy event-local expansion unit for the alternating case, not an eager multiplication of all rows.

Merge without alternating units keeps the current left-row-major Cartesian order and product of row counts. When either operand contains an alternating unit, Merge defines a lazy left-event-major Cartesian product: for each event of the left stream, emit each event of the right stream, combining rows by the existing `merge_rows` rules. That product is one atomic unit for downstream Count. This is new behavior only for a composition that does not exist today. Total images must account for the merged row's right-preferred latent batch size; `left.total_images × right.total_images` is not generally correct. Empty operands yield no events. Merge/Matrix must never erase an existing alternating boundary merely to reuse the old flat implementation.

Preset expansion retains Queue mode and plan provenance. The Preset marker's Count 1 preserves units and adds its source identity without flattening. Bypass and mute use the effective plan, including through a Preset Reference. The existing model-specific LoRA selection, positive/negative resolution, seed-based `{...}` choices, and negative precedence operate on the selected event's row after index lookup.

## PNG replay and UI

Execution-path PNG replay currently rebases by `row_index` and `repeat_index` in a flat plan. For v7, retain a process-local event reference consisting of a structural leaf path and occurrence ordinal alongside `_plan_ref`. After pruning unselected branches, rank that same event in the pruned schedule and derive its new `current_index` and seed base. Keep the old flat-row path for old, non-alternating plans and old PNGs. Distinct occurrences from two Queue sockets must not alias. To Text and Expand each rebase against their own actual plan. Do not serialize the plan object or the process-local event reference into PNG JSON. The reopened workflow's mode widgets must reproduce the same schedule.

The Queue preview shows the effective mode, lock reason, total batches/images, and only a bounded prefix of actual final-order events. `Queue A: b1,b2,...` and `Queue C: A-cycle,...,b3,...,b4,...` must agree with Expand, not merely with graph traversal order. Statistics stay scalar and must not enumerate all batches. The preview's cache/lineage key includes mode, effective upstream Queue provenance, connected source revision, and Preset revision. Browser reload, connection edit, bypass, Preset edit, and API execution converge on the same effective mode. A frontend schedule preview resolver should use the same small golden fixtures as the Python resolver; do not maintain an unrelated heuristic for alternate ordering.

## Test design and acceptance gates

| Area | Required checks |
| --- | --- |
| Backward compatibility | Existing Queue→Count, Count→Queue, Matrix→Queue, Merge→Queue, two Counts, and old `widgets_values` produce identical order, prompt, seed, totals, filenames, and callback behavior. Missing `order_mode` means input order. |
| Target composition | Queue A alternate + Queue B input order → Queue C input order → Count 3 emits `b1,b2,b1,b2,b1,b2,b3,b3,b3,b4,b4,b4`. Check every indexed event and final totals, not just the first and last. |
| Count placement | Unequal input lengths `b1×2,b2×3` yield `b1,b2,b1,b2,b2`; Count after A repeats this cycle, whereas Counts before A alter the streams. Count 0 and 1, nested Counts, and an empty branch are explicit fixtures. |
| Round-robin | One to ten inputs, skipped empty/zero-count inputs, uneven lengths, duplicate upstream source connected twice, latent `batch_size > 1` (one batch per turn), and integer overflow. |
| Mode lock | Direct Queue, Reroute, Scene transform, Preset Reference, connection change, graph reload, bypass/mute, and old saved `交互` on a newly locked Queue. UI shows input order disabled; backend/API uses the same mode and saved widget normalizes to it. |
| Other operators | Prompt/Path/Latent/Reverse/Delete/Apply Model/LoRA/Callback preserve event order and selected-path provenance. Matrix before vs after alternating, Merge before vs after alternating, and Count after each have complete expected sequences. Legacy Merge/Matrix fixtures remain unchanged. |
| Generation | Expand/To Text prompts, LoRA model selection, random choice seeds, image totals, filename counters, per-branch callbacks and final callback follow final global order. Verify first, middle, and last events. |
| Preset and PNG | Queue modes inside/outside Presets, nested Presets, saved and reloaded workflows, execution-path-only PNG replay for A/b1 and A/b2 occurrences, separate Expand/To Text rebase, and no sibling source-node IDs in `current_node_names`. |
| Frontend | Bounded Queue preview and totals match Python golden fixtures, including 160-item truncation, huge Count, mode lock/reload/disconnect, and responsive rendering. |
| Performance and validation | `10^8` repeats of a two-event alternate plan do not allocate proportional rows. Assert schedule size and lookup call counts, plus a generous memory ceiling rather than a fragile time threshold. Fuzz small schedules against a simple eager reference interpreter. Reject malformed, cyclic, or over-depth v7 structures and totals beyond the safe integer limit. |
| Integration | Python 3.9/3.11, frontend/browser integration, public package, real ComfyUI HTTP smoke, and end-to-end Preset/PNG replay. Do not run these against a user's active generation process. |

The design is accepted only when the same schedule fixture passes the Python resolver, browser preview, real HTTP execution, and PNG replay. No release or installed-copy update is part of this design-only change.
