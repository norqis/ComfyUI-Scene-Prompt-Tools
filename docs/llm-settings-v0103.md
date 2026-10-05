# LLM connection settings correction (v0.10.3)

## Approved user requirements

The LLM modal contains only API URL, port, optional model name, and optional LLM API key. URL is required and its label has a red asterisk; port may be empty to use HTTP/HTTPS's default port. Add spacing above the first URL row. Explain that the key authenticates the destination LLM server, not Codex. Model omission uses the server's default. Remove output-token limits, reasoning settings, response-format choices, and request timeout settings. Civitai authentication belongs in a separate modal reached from Civitai search; Civitai uses civitai.red with no host selection. Existing connection settings and secrets must survive migration.

## Investigation

- v0.10.2 requires model, sends max_tokens=8192 and temperature=0.2, exposes three response formats, and bounds token/time settings. These are client-imposed restrictions and unnecessary tuning controls.
- Local Strata selects its inference engine at launch; chat requests can omit model and token budget. Other compatible APIs require a model identifier. JSON-object support also differs among providers.
- Civitai public GET /api/v1/models?limit=1&types=LORA returned valid JSON and HTTP 200 from both civitai.red and civitai.com on 2026-10-05. No production authentication or downloads were exercised. Official API reference: https://github.com/civitai/civitai-developer-docs/blob/main/site/reference/index.md.
- Existing settings save atomically, distinguish blank-key preservation from explicit deletion, and keep secrets out of browser responses/workflows. Existing connection test uses the unsaved draft and GET /models without inference. Preserve these behaviors.

## Implementation design

### Configuration and endpoints

Retain one private per-user file and one atomic save lock, but normalize to only base_url, port, model, api_key, civitai_api_key. Public LLM settings return only the first three values, api_key_set, and template_version. Separate Civitai GET/POST settings routes return only civitai_api_key_set. Scoped saves cannot overwrite the other service's settings. Existing generic save helper may remain internally shared.

Store base_url without its port; preserve scheme, bracketed IPv6, and reverse-proxy path. Store port as an integer or null. New default is http://127.0.0.1/v1 plus port 8080. Migrate old embedded ports; a legacy URL without a port means protocol default, not 8080. An explicitly submitted port wins; otherwise a submitted URL with an embedded port supplies it. Blank port means protocol default. Validate actual TCP port range 1..65535, reject fractional/bool/invalid ports, credentials, query, fragment, invalid scheme, and missing host. These are protocol constraints, not arbitrary output limits. Model is trimmed optional text. Old response_format, timeout_seconds, reasoning_effort, max_tokens, and civitai_host are ignored when loading and removed on the next save. Don't print or modify the production private file during testing.

Assemble URLs with urllib's URL parser, never string-replace a port or split at colon. Frontend can accept a pasted complete endpoint by separating its embedded port on blur; an explicit port entry takes priority. IPv6 and HTTPS default-port migration must have regression tests. Do not reset a deliberately blank port on reopen.

### LLM transport and compatibility

Send messages, stream=false, automatically requested JSON-object format, and model only when nonempty. Do not send max_tokens, max_completion_tokens, reasoning_effort, or temperature. English instructions include the schema and the returned object remains strictly validated.

If and only if HTTP 400/422 explicitly reports that response_format/json_object is unsupported, retry once without response_format, retaining the schema instructions and strict response validation. If and only if HTTP 400/422 explicitly reports a missing/required model when no model was supplied, GET /models and retry with its unique valid model identifier. Zero or multiple identifiers require a useful error asking the user to specify the optional model. Never guess the first of several models. Explicit model entries are not replaced. Both corrections may be needed in either order, but each can occur only once in a call. Authentication, network, generic 400, server failures, malformed successful responses and truncated results are not retried. Provider error detail is used only for internal classification; public errors do not echo response text or credentials.

Remember only the currently successful format/model negotiation for each public user's current configuration, not historical endpoint/model caches. Identity includes assembled endpoint, model, and a digest of the key. Replace the entry when that identity changes and invalidate it when LLM settings are saved. Store only small capability metadata, no response text, prompts, candidates or raw key. Late requests cannot publish into a newer entry. Independent users remain isolated. Direct service tests can use a request-owned state without global history. There is no entry-count/output-size cap.

Use aiohttp ClientTimeout(total=None) for LLM and Civitai requests/downloads; omit application-imposed time budgets and allow cancellation to propagate. Callback's user-requested fixed 10 seconds is unrelated and unchanged. Remove the arbitrary 120-candidate service limit; retain actual candidate validation and the user's requested 30-result Civitai page behavior.

### UI and lifecycle

LLM form has exactly four fields, with optional labels/help and only URL marked required (red star and accessible required state). Save/test validate URL and port, retain unsaved drafts, protect newer key input during a pending save, and do not reveal saved keys. Save and test are mutually busy. Connection test remains GET /models only; opening forms, graph load and availability checks never generate or load model weights. Closing a form before GET settings resolves must not attach orphaned controls/listeners.

Civitai search gets a Civitai設定 button; its modal contains only an optional key plus explicit clear action. Use civitai.red as API origin and candidate-link host, including legacy persisted host configurations. Preserve download authorization scoping and verified streaming/hash identity. Civitai saves invalidate active search results; LLM saves no longer invalidate them. Existing top-modal focus/Escape/inert handling stays intact. Apply comfortable top padding before API URL, responsive layout and visible red star at desktop/360px widths.

## Verification plan

| Area | Required checks |
| --- | --- |
| Migration | Old complete URL, explicit/default/blank port, HTTPS path, IPv6, invalid values, obsolete settings removed, keys preserved, per-user isolation, scoped saves, concurrent LLM/Civitai saves |
| Real isolated HTTP | Optional model omitted; explicit model sent; one/zero/many model fallback; JSON support fallback; both correction orders; no retry on auth/network/generic 400/5xx or invalid/truncated success; no budget/tuning fields; cancellation; no 120-candidate rejection |
| State ownership | Repeated nodes reuse successful method; URL/model/key change replaces state; stale completion cannot repopulate replaced state; no prompt/candidate data retained |
| Browser | Exactly four LLM fields; required red star; top spacing; split full URL; blank optional model/key/port; masked/clear/newer draft preservation; unsaved test; separate Civitai key modal and red-only host; search invalidation; close-during-load; 360px layout |
| Regression | Full Python and frontend suites; native CPU ComfyUI browser smoke with connected standard model/LoRA loaders never executed by prompt generation; public package checks |
| Release | Root diff review plus gpt-5.6-sol medium APPROVE, required CI, squash merge, v0.10.3 tag/release, installed tracked-file hashes; preserve running production process and private data |

This correction supersedes the output-tuning/settings portions of docs/llm-civitai-v010-design.md and the explicit-settings exclusion in docs/memory-audit-v0102.md. Real local LLM inference quality is not claimed by isolated protocol tests.
