# LLM prompt generation queue

## Behavior

- Within one ComfyUI browser page, explicit node and Expand prompt-generation requests enter a FIFO. Each operation owns its resource session until cleanup completes. Repeated clicks on the same requested root reuse its pending operation.
- A queued root displays `待機中`; an active root displays `プロンプト生成中…`. Idle nodes have no `待機` label. Pending jobs hold node identities, not copied workflows or prompt histories.
- Jobs read current input when they start. A removed/replaced root or switched workflow is cancelled explicitly. Existing in-flight edit/connection guards prevent overwriting newer content.
- Expand reuses previously converted nodes and user-edited outputs as before. Remaining nodes are sent individually, one at a time. No batch API or extra context handling is introduced.
- LoRA selection/download remains per node and preserves insertion order. Prompt generation never executes connected image-model loaders or queues image generation.
- This queue is per browser page, not a distributed queue shared by separate browsers.

## Verification

- Controller: FIFO across node/Expand calls, repeated clicks, failure recovery, cleanup ordering, queued-root ownership, workflow replacement/removal, shared graph traversal, output reuse, stale changes, Preset disposal and LoRA splicing.
- Runtime: actual ComfyUI node widgets show queued/running/idle states, each output reaches the right node, Undo/Redo and Presets remain valid, and image loaders stay unexecuted.
