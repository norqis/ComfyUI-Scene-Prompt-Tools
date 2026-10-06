# Repository audit v0.10.9

Root owns investigation, design, final diff review and independent validation. Baseline is bced5ed (v0.10.8). Fixes are delegated only after gpt-5.6-sol medium design approval. Production queues, models and browser sessions remain untouched; use isolated CPU/browser fixtures. The idle installed checkout was synchronized to v0.10.8 and independently hash-verified. No restart was performed.

## Reproduced issues and proposed corrections

### Shared LoRA is applied twice after branch convergence

A single Scene Apply LoRA feeding two Prompt branches and then Merge produces two identical descriptors and two LoraLoader nodes in Expand. Repeated shared convergence also multiplies retained descriptor data. Distinct Apply LoRA nodes using the same file are intentional and must still stack.

Add optional source-node identity to new LoRA descriptors, using the existing source_node_id / unique_id convention. Existing Preset evaluation already namespaces source IDs by Reference occurrence, including nesting. Accept old six-field descriptors without identity. At merge_rows, coalesce only descriptors with the same nonempty identity, retaining first occurrence order. Anonymous legacy descriptors and distinct node IDs remain separate. Preserve branch-transformed positive/negative contributions by combining their parts with existing exact-part uniqueness; final prompt resolution still owns weighted deduplication and negative priority. Do not rewrite prior Callback snapshots or change model filtering. Prompt-trace indices are local to pre-Merge rows; merged rows already discard the trace.

Tests: shared fork/rejoin loads once; distinct same-file nodes load twice in order; shared plus branch-local chains; Delete/Reverse on one branch preserves the other branch's prompt contributions; both model modes; Callback snapshots; JSON roundtrip and legacy descriptors; repeated/nested Preset instances remain distinct while a shared instance reconverges once. Check descriptor counts across repeated convergence, no new global cache or cap. Exercise real Expand expansion and isolated native loader stubs rather than checking helper output alone.

### Compact Preset summaries lose Count protection

_compact_preset_list_graph drops enable_downstream_count. A Preset with Count 3 and downstream-count OFF correctly executes three batches, but its compact summary defaults to ON and an outer Count 10 displays thirty. Reproduced full=3 versus compact=30.

Retain this Boolean in compact scalar inputs. No full prompt/model data is added to the list response. Test saved full definition -> real compact response -> frontend schedule composition, including nested/local Preset definitions, protected/free branches, zero Count and omitted legacy defaults. Actual execution totals and displayed totals must agree.

### LLM Preset edits erase workflow-only nodes and physical connections

createPresetGraph currently reconstructs only api_graph.output and its contracted links, then replaces the entire workflow with that graph. A valid physical Input -> LLM -> bypassed Prompt -> Output plus Note becomes Input -> LLM -> Output after only editing the generated positive field. Bypassed References and muted nodes are similarly at risk.

Keep the execution adapter distinct from the original serialized physical workflow. Unchanged workflow nodes/links, modes, groups, reroute metadata and slot references survive prompt-only edits exactly. Update widgets/properties only for edited execution nodes and append newly inserted LoRA nodes. Preserve operation-local ownership and existing release; do not instantiate a hidden native Comfy graph or load models.

For generated LoRA insertion, use one explicit optional adapter hook in insertLoras carrying the insertion's old tail, output slot and placed chain. The adapter records/patches the physical splice at that old tail: redirect its existing physical fanout through the new tail, retaining old target endpoints, link IDs/metadata and intervening bypass chains; add the new chain's links. Execution graph still uses its existing API edges and insertion behavior. A native graph without this hook behaves unchanged. Link allocation must avoid all saved physical IDs. Preserve workflow-only nodes even when they do not appear in API, and preserve unrelated subgraphs. Fallback reconstruction is only for legacy/test definitions lacking physical links, not a wholesale replacement when physical links exist. Keep indexing linear in nodes+edges; avoid per-API-edge scans of all workflow links.

Tests: prompt-only edit roundtrip retains bypassed Prompt/Reference, muted nodes, Notes, branches, groups and reroutes; automatic one/multiple LoRA insertion preserves physical bypass chains and API output; repeat generation reuses the adjacent managed chain; unrelated/manual branches remain; nested/repeated Reference occurrences stay isolated; dispose releases detached state. Use a native Comfy browser fixture that serializes an actual bypassed graph, performs the local edit/insertion, reloads, and compares physical topology plus graphToPrompt API topology. No real LLM/Civitai request or image model load.

## Audit evidence and exclusions

### Unchanged Matrix reads still parse and serialize the full state

Root loaded the production readMatrixState/ensureMatrixJsonWidget functions with the real scene_prompt_state parser. After warmup, 1,000 reads of an unchanged 100-row Matrix parsed 1,000 times and took about 1.15 seconds. The cache is checked only after ensureMatrixJsonWidget has already parsed and serialized the state. This is UI overhead, not GPU sampling time.

Move the unchanged-state check before normalization. Retain one current node-owned normalized value/state (or extend the existing current cache) keyed by the actual widget value, serialized widget slot and legacy property value. Compare strings directly without building another large JSON cache key. A change to any source invalidates the reuse and follows existing migration precedence, including recovery from malformed widget data and a nonempty legacy property. Keep widget/property/serialized values synchronized on the slow path. Do not add historical entries or a global cache. Existing computed-cache clearing/removal must release the cached state. Matrix edits, delete-all, Undo/Redo, reload, graph replacement and legacy fallback must remain correct. Regressions assert zero parser calls on warm reads and equal output, then actual invalidation/recovery; native browser exercises edit/close/delete-all/undo/reload and the existing layout checks.

Baseline Python: 656 tests pass (two native opt-ins skipped); all frontend suites pass. Coverage was collected to guide remaining reads, not treated as proof of correctness.

Local Comfy sd1_clip.token_weights explicitly replaces an outer weight when a nested token has an explicit inner weight. Therefore multiplying nested explicit weights during duplicate selection would be incorrect; no speculative change is planned. Filename recovery without Scene metadata uses documented five-digit placement and can be ambiguous next to user numeric text; do not change its regex in a way that breaks existing numeric-prefix/suffix compatibility. Normal allocation persists counters and supports six-plus digits.

## Additional root reproduction: HTML import loses case-colliding categories

On Windows, importing Room/View and room/View reports two files/two entries but creates one prompt.json containing only the second entry. _output_payloads detects sanitized name collisions case-sensitively although the target filesystem aliases these names. The same problem affects subcategories. This is confirmed with synthetic temporary files; no user data was changed.

Use a portable case-insensitive collision identity when allocating output directory names, while retaining original display spelling. Reuse the existing deterministic suffix convention for colliding names. Ensure the final allocated name itself is unique, including a user category whose literal name equals another category's suffixed name; a small local allocation helper and deterministic suffix/counter resolution suffice. Keep unique existing paths and merge/replace/abort/clean semantics unchanged. No global registry, extra manifests or new limits. Test both main/subcategory case collisions, ordinary sanitized collisions, natural names matching a generated suffix, stable repeated import/merge and actual Windows write results. Linux CI must exercise allocation identities without relying on its case-sensitive filesystem. Stage/rollback tests stay intact.

## Release gates

Root continues the remaining source audit during implementation. Every confirmed additional issue requires a concrete reproduction and a simple design before a fix. Root reviews the complete final diff; medium reviews implementation. Run full Python and frontend suites, native CPU node/HTTP tests, isolated native browser tests, old-workflow/node contract suites, public package and whitespace checks. Review exact-head CI before merge, publish v0.10.9 using existing release conventions, verify the public release, then synchronize installed tracked files only while the production queue is idle and verify hashes. Do not restart ComfyUI or alter private workflows. This audit cannot prove absence of all bugs, and CPU/browser probes do not establish GPU sampling speed.
