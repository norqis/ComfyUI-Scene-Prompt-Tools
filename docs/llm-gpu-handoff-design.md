# Optional GPU handoff between prompt and image generation

## User-visible contract

- ComfyUI settings, under Scene Prompt Tools, register two independent booleans:
  - `ScenePrompt.ReleaseComfyBeforeLLM`: プロンプト生成前にComfyUIモデルを解放. Default false.
  - `ScenePrompt.ReleaseLLMBeforeImage`: 画像生成前にLLMモデル・KVキャッシュを解放. Default false.
- Prompt generation never unloads the LLM when it finishes.
- Image handoff occurs when an accepted job actually starts, before any workflow node or model loader executes.
- A continuous run snapshots settings when requested, including while it waits for another run. Each ordinary submission has its own snapshot.
- With both options off, there are no resource-control HTTP requests, model unloads, or state polling. A concurrently active controlled operation still protects its resource handoff from other submissions.
- The resource adapter acts only on the configured model or uniquely resolved model instance. It does not stop the API server or kill unrelated processes.
- Unsupported providers, ambiguous targets, busy responses and failed unloads cannot be reported as successful releases. A requested image handoff failure prevents workflow execution and produces a normal execution error.

## Separation of responsibilities

Prompt generation remains OpenAI-compatible. A separate module exposes provider detection and unload/confirmation. Initially support Strata, Ollama and LM Studio using their official APIs. Detect providers by positive JSON response identity/schema, not a URL string or a mutation probe. Preserve configured reverse-proxy prefixes. A different provider can add an adapter without changing Scene nodes or Expand.

Each operation privately snapshots its endpoint, port, model and authentication settings. Provider detection does not retain a cross-operation cache. Never retain credentials in workflow, prompt history, PNG metadata or browser-facing responses. No new model/cache capacity limits.

ComfyUI's `/free` acknowledges flags rather than completed work. Controlled prompt generation queues a worker command and wakes the worker with a queue flag. Wrap `PromptQueue.get` once: process pending controls on the worker thread, reset inactive executor caches, unload models, collect garbage and soft-empty-cache, then acknowledge actual completion before starting the LLM. Register executors weakly at construction. Never reset an executor from an HTTP thread: the worker still reads its success/status/history after execute returns. Do not patch the installed ComfyUI source.

One prompt-generation operation includes all target LLM nodes and LoRA selection requests. The operation retains its lease until the entire operation finishes or is cancelled/disconnected. Already completed node edits retain existing behavior on partial failure. Fully cached operations do not acquire a resource lease.

The queue hook admits images and confirms provider release on the worker before returning the item. Retain the image lease through `task_done`, not just through `execute`, and handle already-popped items without blocking worker control acknowledgement. All ordinary image/LLM requests register as shared readers; pending exclusive operations prevent reader starvation using writer priority. Session-owned HTTP requests reuse their exclusive lease. Continuous runs avoid repeated release calls while no intervening LLM request has loaded the provider again. If another prompt operation runs between images, the next image must ensure release again.

Release failures must not escape the executor hook and kill ComfyUI's worker. Produce the failed job's normal status/history and release ownership after task completion. Queue delete/wipe release unused policy references. Bind a session to one user/client lifetime, rejecting duplicate active begins; native websocket removal/replacement retires abandoned state directly, without polling, arbitrary capacity limits or execution deadlines. Already queued images keep their snapshot through completion.

The native frontend `api.queuePrompt` ignores additional prompt properties and builds its own extra_data. Use a per-call API receiver whose fetchApi inserts the opaque token into the actual POST body. Preserve receiver propagation through this package's wrappers; never temporarily replace the global fetchApi. An incompatible pre-bound foreign queue wrapper must not silently claim resource control succeeded.

## Frontend/backend integration contract

Resource-control HTTP endpoints are owned by the authenticated ComfyUI user. Proposed routes:

- `POST /scene_prompt/gpu/prepare` with `{client_id, run_handle?, continuous?}` creates/snapshots a private image policy and returns `{policy_id}`. Only used when ReleaseLLMBeforeImage is true.
- Images carry only `extra_data.scene_gpu_policy = policy_id` through `api.queuePrompt`. API/headless requests without an explicitly prepared policy remain off.
- `POST /scene_prompt/gpu/release` with `{policy_id, client_id}` retires an unused/completed continuous policy. Running or already queued work retains its required snapshot until completion.
- `POST /scene_prompt/llm/begin` with `{client_id}` acquires the controlled prompt operation and releases Comfy resources, returning `{session_id}`. Only used when ReleaseComfyBeforeLLM is true and at least one actual LLM request is needed.
- `/llm/generate` and `/llm/select_loras` carry `session_id` and `client_id` for that operation; connection settings are fixed by the session.
- `POST /scene_prompt/llm/end` with `{session_id, client_id}` ends the operation. Frontend invokes in finally and on page teardown; backend also retires abandoned ownership on client disconnect.

An authenticated prepare/begin call is explicit handoff intent. Do not reject a previously captured ON choice by rereading the current native checkbox after a FIFO or Preset wait. Connection settings apply when the operation is prepared. Strip the opaque image token before the queue stores its item; ownership remains in a private prompt-id map and is absent from queue history and saved PNG metadata.

The backend may reuse existing run-context ownership for policies rather than build duplicate stores. Session/policy ownership must be checked at prompt admission, before dispatching queued work. Queue rejection/deletion, normal/error completion, stop, client disconnect and preparation failure release unused state. Use lifetime ownership and weak executor references instead of arbitrary capacity limits.

## Validation

1. Both settings default off, are independent, survive reopen/reload, and do not add serialized node widgets or disturb old workflow layouts.
2. Off does not unload or make provider-control requests. Reused LLM results need no resource-control requests.
3. Controlled prompt generation waits for active image execution and completes actual cache/model release before the first LLM request. Multiple nodes and LoRA selection remain inside one operation.
4. Success, service error, stale graph, retry and disconnect release the operation; prompt completion leaves the LLM loaded.
5. Normal execution and continuous generation unload the LLM before the first node/model loader. Queue delay and subsequent settings changes preserve the initial policy.
6. A continuous run does not redundantly unload the same unchanged LLM; an intervening LLM request invalidates that reuse.
7. Provider detection/target resolution/unload confirmation cover Strata, Ollama, LM Studio, reverse-proxy paths, credentials, unavailable/unsupported/ambiguous/busy responses and unload failure.
8. Concurrent tabs, ordinary and continuous jobs, ON/OFF mixtures, deleted queued jobs and disconnected owners do not leak leases or private settings.
9. A release failure emits execution_error/history and leaves the worker usable for the next job.
10. Run existing Python/frontend tests and real isolated ComfyUI CPU HTTP/browser tests. Never perform test inference, unload or restart against the production ComfyUI or local LLM.
