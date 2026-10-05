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

Provider state is keyed by endpoint, port, model and authentication identity and becomes unused when settings change. Never retain credentials in workflow, prompt history, PNG metadata or browser-facing responses. No new model/cache capacity limits.

ComfyUI's `/free` acknowledges flags rather than completed work. Controlled prompt generation must wait for running image execution, reset inactive executor caches and invoke model unload, garbage collection and soft-empty-cache under the same coordination lease before starting the LLM. Do not patch the installed ComfyUI source.

One prompt-generation operation includes all target LLM nodes and LoRA selection requests. The operation retains its lease until the entire operation finishes or is cancelled/disconnected. Already completed node edits retain existing behavior on partial failure. Fully cached operations do not acquire a resource lease.

The image execution hook retains the same lease from provider unload confirmation through workflow execution. Continuous runs avoid repeated release calls while no intervening LLM request has loaded the provider again. If another prompt operation runs between images, the next image must ensure release again.

## Frontend/backend integration contract

Resource-control HTTP endpoints are owned by the authenticated ComfyUI user. Proposed routes:

- `POST /scene_prompt/gpu/prepare` with `{client_id, run_handle?, continuous?}` creates/snapshots a private image policy and returns `{policy_id}`. Only used when ReleaseLLMBeforeImage is true.
- Images carry only `extra_data.scene_gpu_policy = policy_id` through `api.queuePrompt`. API/headless requests without an explicitly prepared policy remain off.
- `POST /scene_prompt/gpu/release` with `{policy_id}` retires an unused/completed continuous policy. Running or already queued work retains its required snapshot until completion.
- `POST /scene_prompt/llm/begin` with `{client_id}` acquires the controlled prompt operation and releases Comfy resources, returning `{session_id}`. Only used when ReleaseComfyBeforeLLM is true and at least one actual LLM request is needed.
- `/llm/generate` and `/llm/select_loras` carry `session_id` for that operation; settings are fixed by the session.
- `POST /scene_prompt/llm/end` with `{session_id}` ends the operation. Frontend invokes in finally and on page teardown; backend also retires abandoned ownership on client disconnect.

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
