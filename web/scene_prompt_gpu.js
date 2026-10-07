// Resource ownership stays outside nodes and serialized workflow settings.
export const GPU_HANDOFF_SETTINGS = [
    {
        id: "ScenePrompt.ReleaseComfyBeforeLLM",
        name: "プロンプト生成前にComfyUIモデルを解放",
        type: "boolean",
        defaultValue: false,
        category: ["Scene Prompt Tools", "GPU", "プロンプト生成前にComfyUIモデルを解放"],
    },
    {
        id: "ScenePrompt.ReleaseLLMBeforeImage",
        name: "画像生成前にLLMモデル・KVキャッシュを解放",
        type: "boolean",
        defaultValue: false,
        category: ["Scene Prompt Tools", "GPU", "画像生成前にLLMモデル・KVキャッシュを解放"],
    },
];

export function createGPUController({ app, api, onCleanupError = (error) => console.warn("[Scene Prompt] GPU操作の終了に失敗しました。", error) }) {
    const sessions = new Set(), policies = new Set();
    const failedSessionEnds = new Set(), failedPolicyReleases = new Set();
    let pageHidden = false;
    function snapshot() {
        const read = (id) => app.extensionManager?.setting?.get
            ? app.extensionManager.setting.get(id)
            : app.ui?.settings?.getSettingValue?.(id);
        return {
            releaseComfyBeforeLLM: read(GPU_HANDOFF_SETTINGS[0].id) === true,
            releaseLLMBeforeImage: read(GPU_HANDOFF_SETTINGS[1].id) === true,
        };
    }
    async function post(path, body, { keepalive = false } = {}) {
        const response = await api.fetchApi(`/scene_prompt/${path}`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body), ...(keepalive ? { keepalive: true } : {}),
            ...(path === "llm/begin" ? { timeoutMs: null } : {}),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || data.message || `HTTP ${response.status}`);
        return data;
    }
    async function endLLM(sessionId, options) {
        if (!sessionId) return;
        try {
            await post("llm/end", { session_id: sessionId, client_id: api.clientId || "" }, options);
            sessions.delete(sessionId);
            failedSessionEnds.delete(sessionId);
        } catch (error) {
            if (sessions.has(sessionId)) failedSessionEnds.add(sessionId);
            throw error;
        }
    }
    async function releaseImage(policyId, options) {
        if (!policyId) return;
        try {
            await post("gpu/release", { policy_id: policyId, client_id: api.clientId || "" }, options);
            policies.delete(policyId);
            failedPolicyReleases.delete(policyId);
        } catch (error) {
            if (policies.has(policyId)) failedPolicyReleases.add(policyId);
            throw error;
        }
    }
    async function finishPendingCleanup() {
        // Retry only failed cleanup, once per new user action. Active operations
        // remain owned, and a persistent failure is reported before new work.
        for (const sessionId of failedSessionEnds) await endLLM(sessionId);
        for (const policyId of failedPolicyReleases) await releaseImage(policyId);
    }
    async function beginLLM(settings) {
        await finishPendingCleanup();
        if (!settings?.releaseComfyBeforeLLM) return "";
        const data = await post("llm/begin", { client_id: api.clientId || "" });
        if (!data.session_id) throw new Error("LLM生成のGPU準備に失敗しました。");
        const sessionId = String(data.session_id);
        sessions.add(sessionId);
        if (pageHidden) {
            await endLLM(sessionId, { keepalive: true });
            throw new Error("ページを終了したためプロンプト生成を中止しました。");
        }
        return sessionId;
    }
    async function prepareImage(settings, { runHandle = "", continuous = false } = {}) {
        await finishPendingCleanup();
        if (!settings?.releaseLLMBeforeImage) return "";
        const data = await post("gpu/prepare", {
            client_id: api.clientId || "", continuous,
            ...(runHandle ? { run_handle: runHandle } : {}),
        });
        if (!data.policy_id) throw new Error("画像生成のGPU準備に失敗しました。");
        const policyId = String(data.policy_id);
        policies.add(policyId);
        if (pageHidden) {
            await releaseImage(policyId, { keepalive: true });
            throw new Error("ページを終了したため画像生成を中止しました。");
        }
        return policyId;
    }
    function applyImagePolicy(prompt, policyId) {
        if (policyId) {
            prompt.extra_data ||= {};
            prompt.extra_data.scene_gpu_policy = policyId;
        } else if (prompt.extra_data) {
            delete prompt.extra_data.scene_gpu_policy;
        }
    }
    function acceptImage(policyId) {
        policies.delete(policyId);
        failedPolicyReleases.delete(policyId);
    }
    function queueClient(queuePrompt, policyId) {
        if (!policyId) return api;
        if (queuePrompt.name.startsWith("bound ")) {
            throw new Error("画像生成前のLLM解放に対応していないQueue拡張が有効です。");
        }
        // Native queuePrompt builds its own extra_data. Scope this transport to
        // one submission so overlapping queue calls cannot exchange policies.
        const client = Object.create(api);
        client.fetchApi = function (path, options) {
            if (path === "/prompt" && options?.method === "POST") {
                const body = JSON.parse(options.body);
                body.extra_data ||= {};
                body.extra_data.scene_gpu_policy = policyId;
                options = { ...options, body: JSON.stringify(body) };
            }
            return api.fetchApi(path, options);
        };
        return client;
    }
    function releaseOnPageHide(event) {
        if (event?.persisted) return;
        pageHidden = true;
        for (const sessionId of sessions) endLLM(sessionId, { keepalive: true }).catch(onCleanupError);
        for (const policyId of policies) releaseImage(policyId, { keepalive: true }).catch(onCleanupError);
    }
    return { snapshot, beginLLM, endLLM, prepareImage, releaseImage, applyImagePolicy, acceptImage, queueClient, releaseOnPageHide, onCleanupError };
}
