# v0.10.1 audit: async ownership and compact Preset persistence

Status: root investigation and design approved by gpt-5.6-sol medium; implementation and regression validation completed. Final review and release verification remain root-owned.

## Confirmed findings

1. LLM -> Prompt -> Prompt -> Expand: disconnect the middle edge while an LLM response is pending. v0.10.0 still writes the obsolete output and starts a graph transaction. Neither the target direct edges nor Expand direct edges changed.
2. Mute Expand while the same response is pending. v0.10.0 still writes output because the post-hydration guard checks the model widget but not the root mode.
3. A 1 KiB generated output in a nested Preset grows from 3,967 bytes (no nesting) to 17,143 / 72,993 / 318,403 / 1,454,101 / 7,075,287 bytes at nesting depths 1 through 5. Ancestor JSON repeatedly embeds descendant definitions in API and workflow widgets while also retaining the same paths at the outer Reference.
4. In Chromium, clear an API key, save, type a replacement key, and save again: clear_api_key remains checked, so merge_settings deletes the replacement key. Saved indicators also remain stale.
5. In Chromium, search on civitai.com, change the saved host to civitai.red, reopen the same search: no new search request occurs and the old civitai.com card remains.
6. Download verification writes the complete LoRA and then rereads the temporary file through _sha256. This is an unnecessary full-file disk pass; hashing can happen while chunks are written.

## Root design

### Operation ownership

Capture the reachable SCENE_PROMPT routing once before each target request, including node identity, mode, relevant input links and their endpoints. Check it after awaited work and before committing. Include the root mode. Do not serialize the entire workflow, hash prompts on draw, or invalidate unrelated graph edits. Refresh the expected routing only after the controller's own committed LoRA insertion; a routing change from the user invalidates the remaining old target list. Preserve existing target-text/manual-edit checks, per-Reference ownership checks and global operation locking. Normal upstream insertion must not invalidate the next legitimate target.

### Preset state

Keep version 1 and existing flat path keys. On explicit generation commit, normalize effective existing local customizations into one flat outer map. Store each local/modified occurrence definition once. Strip embedded llm_presets_json from Reference API inputs and all corresponding workflow widget representations in stored definitions, after collecting its effective descendant local definitions. Include parent definitions when clearing their embedded local states is necessary; retain all existing customized descendants and unrelated local siblings, with own override precedence resolved before flattening. Shared source definitions remain immutable. A path changed by a previous sequential target must remain current and editable.

Do not normalize/deep-copy on draw or ordinary unchanged load. Old v0.10.0 nested states remain readable and become compact on the next explicit commit. Editor entry projects flat descendants only onto the immediate child References, using flat relative paths within each child subtree. Explicit Save persists root customizations without writing a shared nested file. Backend occurrence resolution already understands flat overrides; change it only if regressions prove a missing contract. Avoid a new schema, recursive embedding, whole unrelated workflow snapshots, or speculative caches.

### Settings and search

Prevent overlapping Save submissions. After successful Save, reset consumed clear-key checkboxes, clear only the key text that was actually submitted, and update masked saved indicators from the public response; preserve any newer user draft. Reuse one model datalist per settings modal instead of appending one on every connection test. Invalidate the Civitai search cache on successful settings changes, and prevent an earlier in-flight response from restoring an old cache/result. Keep cache scope/epoch ephemeral, never put credentials or gallery results into workflow state. No automatic network work on canvas drawing or workflow loading.

### Downloads

Calculate SHA256 in the same worker operation that writes each streamed chunk; close the stream before verifying the digest and atomic rename. Keep the existing local-file hash cache for already acquired files. Do not cache temporary paths or reread a just-downloaded temporary file. Preserve trusted-origin headers, redirects, model/file identity validation, failure cleanup, and manifest deduplication. No production downloads are needed for verification.

## Acceptance tests and release

- Deferred responses at generation/search/selection/download stages; middle disconnect, intermediate/root mute/bypass, same-ID node replacement, branch reroute, unrelated edit, normal two-target LoRA insertion, Preset Reference disconnect. No stale transactions or subsequent old-target requests.
- Nested depth 0..8 with a 1 KiB output: saved state grows approximately linearly, with a conservative <250 KiB bound at depth 8. Verify reparse, editor projection, explicit Save/reload, own override priority, repeated nested IDs, siblings, second sequential target, metadata/count/resources, old nested state compatibility, and original shared files unchanged.
- Chromium clear/save/replacement key and delayed newer draft; save serialization, public saved indicators, repeated connection tests reuse one datalist; host change and deferred old search, failure/retry remain correct.
- Multi-chunk streamed hash success/mismatch/redirect/failure cleanup; instrument that the new temporary file is not reread for verification, while acquired-file validation remains intact.
- Full Python/frontend/package checks and isolated CPU native Comfy browser smoke. Keep production GPU, queue, browser and server untouched. Root reviews final implementation/runtime evidence, obtain 5.6-sol medium final approval, PR CI, squash merge, v0.10.1 release and local file sync without restarting active generation.
