# Downstream Count policy and resource ordering

## User contract

Add optional BOOLEAN `enable_downstream_count`, displayed as `後続Countを有効化`, default true, to Scene Prompt Count. Apply the current Count before making its result protected when this option is false. Existing protection from earlier Counts remains effective. Do not re-enable a protected ancestor when a later Count has this option true.

- Count10(true) -> Count10 = 100.
- Count10(false) -> Count10 = 10.
- Count10(true) -> Count10(false) -> Count10 = 100.
- A -> Count3(false), B -> Count2(true) -> Queue -> Count10 = A3 and B20. Protection belongs to the corresponding generation path, not unrelated Queue inputs.
- Later Count0 also has no effect on a path protected by the new option. A Count0 before protection still creates no events.
- Queue row repetitions, Matrix choices and Merge combinations continue to do their own work. This option ignores subsequent Count nodes only; it does not create a Queue boundary or disable Queue settings.
- Keep the existing Queue fixed-mode behavior, including its existing Count0 cancellation behavior, for workflows that do not use the new option.

## Compact scheduling

Use one immutable `count_hold` unit wrapping the current Count result to mark strict protection. Its statistics and selected item are identical to its child. Keep the existing `count_fixed` unit for Queue's older policy. No global flags, mutable node state, schedule expansion, arbitrary limits, or new graph ancestry passes.

All existing unprotected plans continue through the current Count implementation unchanged. A protected composite must not silently regain multiplication when a Queue, alternate, map, Matrix, Merge, repeat or Preset wraps it. In particular, a Queue mixing protected and free inputs and a Merge of such paths must preserve path-specific protection. A generated Merge combination is protected if either contributing path is protected; unrelated combinations remain free.

For mixed protection, use a compact `count_scale` unit holding the child and multiplier. Preserve the child plan's first ordered cycle, then repeat only its eligible events for the remaining cycles. With multiplier zero, retain only strictly protected events. This makes the normal unchanged all-free case exactly the old cycle behavior, retains protected events once, and scales only free events. Do not implement separate ad hoc rules for each graph shape.

Keep derived policy statistics and eligibility on immutable units, outside serialized fields. Distinguish strict Count protection, legacy Queue fixed protection, and free events. For a positive multiplier strict and legacy protected events stay unchanged; free events scale. For zero only strict events survive. Unit total rows remain the original logical rows, not the sum of repeated projections. Maps/latent changes, Matrix dimensions and product combinations must compute batch/image/unset totals consistently with the existing statistics. A Random choice must retain preflight equality of the resulting active-arm totals, instead of failing later during generation.

Select eligible events lazily using prefix counts over existing unit kinds, followed by ordinal lookup. Reuse existing selection for the actual event, preserving original row indices, selected branch/model/LoRA/callback/source metadata. Prefix calculations use child statistics and arithmetic for repeat/product/alternate units; they must never loop over generated events or materialize filtered rows. Consecutive scales may combine their multipliers when doing so preserves zero and legacy semantics. Do not cache graph histories or introduce capacity limits. Keep replay/event-reference support exact for partial cycles, filtered events, pruned paths and JSON round trips.

Prefer a simpler implementation if it meets every mixed-path, composition, ordering, replay and compatibility condition above. Do not substitute whole-Queue protection or multiply a protected nested part as a shortcut.

## Frontend and compatibility

Keep the Count's existing input/output sockets. Show the toggle beneath the numeric count. Restore old JSON/PNG/Preset/API values with the new option true when absent; preserve saved true/false and named-widget precedence. Preserve existing widget positions and source metadata rather than interpreting old strings as the new boolean. Add the toggle to widget synchronization, local cache keys and native graph serialization. Update downstream cached totals immediately when it changes.

Frontend schedules and backend plans must use the same protection and mixed-cycle rules. Once strict protection exists, scalar-only stats cannot blindly multiply an upstream total; route those cases through the compact schedule planner. Cover direct Count chains, interposed Prompt/Matrix/Delete/To Text/model/LoRA/callback nodes, joins and nested Presets. Do not scan the complete workflow on each redraw or add polling.

## Verification

- Assert the exact examples above, flag defaults and saved true/false/named/legacy positional loading, bypassed Count and undo/reload.
- Queue input-order and alternate modes, row repeats and fixed/multiply, mixed/all/none protected inputs, Count0/1, multiple successive Counts, and settings unaffected by Count protection.
- Protection through maps, Matrix, Merge (including mixed protected/free combinations), sequence/repeat/repeat-each and Random Input/Output; selected metadata, Text/Delete and callbacks remain exact.
- Preview totals, actual generated schedule, event ordering and saved execution-path replay agree, including nested Preset save/reference/expanded PNG.
- Huge mixed counts stay compact and random access remains arithmetic; safe-integer overflow raises before generation. No per-event scan or additional cache limit.
- Full legacy Python/frontend tests and isolated native CPU HTTP/browser tests. Production queue, servers and GPU remain untouched.

## Expand resource modal

Sort LoRA cards with any applicable variant first, then unknown applicability, then cards whose variants are all inapplicable. Within each card put applicable variants first, unknown next and inapplicable last. Use stable sorting within each group. Keep one card per file, current strengths/model labels/Civitai links and inapplicable gray styling. Do not mutate the API response or change generation behavior. Add a browser assertion for card and variant order, including a mixed card and duplicate-free output.
