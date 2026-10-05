import { requestJSON, identity, value, applyCandidate, captureTarget } from "./scene_prompt_llm.js";

let settingsModalID = 0;
const SORTS = ["Most Downloaded", "Most Liked", "Most Collected", "Highest Rated"];
const modals = [];
export async function lookupCivitaiByHash(api, sha256) {
    const data = await requestJSON(api, `/scene_prompt/civitai/by-hash?sha256=${encodeURIComponent(sha256)}`);
    if (data?.found === false && data.version === null) return null;
    if (data?.found !== true || typeof data.version?.model?.name !== "string" || !data.version.model.name.trim()) {
        throw new Error("Civitai情報を取得できませんでした。");
    }
    return data.version;
}
function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}
export function openModal(title, onDismiss) {
    const focus = document.activeElement;
    const overlay = element("div", undefined, "pc-lora-overlay");
    const dialog = element("div", undefined, "pc-lora-dialog pc-civitai-dialog");
    dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true"); dialog.setAttribute("aria-label", title);
    const head = element("div", undefined, "pc-lora-head"), close = element("button", "閉じる", "pc-button");
    head.append(element("strong", title), close); dialog.append(head); overlay.append(dialog); document.body.append(overlay);
    modals.push(overlay);
    for (const previous of modals.slice(0, -1)) previous.inert = true;
    let closed = false;
    function dismiss() {
        if (closed) return; closed = true;
        onDismiss?.();
        document.removeEventListener("keydown", onKey); overlay.remove(); const index = modals.indexOf(overlay); if (index >= 0) modals.splice(index, 1);
        const current = modals.at(-1); if (current) current.inert = false;
        if (focus?.isConnected) focus.focus?.();
    }
    function onKey(event) {
        if (modals.at(-1) !== overlay) return;
        if (event.key === "Escape") dismiss();
        if (event.key === "Tab") {
            const controls = [...dialog.querySelectorAll("button,input,select,a[href]")].filter((node) => !node.disabled);
            const first = controls[0], last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
    }
    close.onclick = dismiss; overlay.onclick = (event) => { if (event.target === overlay) dismiss(); };
    document.addEventListener("keydown", onKey); close.focus();
    return { overlay, dialog, dismiss };
}
export function showAPIError(error, query, retry) {
    const modal = openModal("取得に失敗しました");
    modal.dialog.append(element("p", `検索・説明: ${query || "—"}`), element("p", error.message, "pc-civitai-error"));
    const button = element("button", "再試行", "pc-button");
    button.onclick = () => { modal.dismiss(); void retry(); }; modal.dialog.append(button);
    return modal;
}
export function openCivitaiSearch({ node, api, refresh, details, activeGraph = () => node.graph,
    beginChange = (graph) => graph.beforeChange?.(), endChange = (graph) => graph.afterChange?.() }) {
    const state = node.properties?.scene_civitai || {};
    let revision = 0, currentResult = null;
    const invalidate = () => { revision++; currentResult = null; list.replaceChildren(); };
    const modal = openModal("Civitai Search", invalidate);
    const controls = element("div", undefined, "pc-civitai-controls"), query = element("input"), sort = element("select");
    query.type = "search"; query.value = state.query || ""; query.placeholder = "LoRAを検索"; query.setAttribute("aria-label", "検索語");
    sort.setAttribute("aria-label", "並び順");
    for (const name of SORTS) { const option = element("option", name); option.value = name; sort.append(option); }
    sort.value = state.sort || SORTS[0];
    const search = element("button", "検索", "pc-button"), list = element("div", undefined, "pc-civitai-results");
    controls.append(query, sort, search); modal.dialog.append(controls, list);
    function render(items) {
        list.replaceChildren();
        if (!items.length) { list.append(element("p", "該当するLoRAはありません。")); return; }
        const selected = node.properties?.scene_civitai;
        if (selected && !items.some((item) => identity(item) === identity(selected))) {
            list.append(element("p", `現在の選択（検索結果外）: ${selected.name || selected.lora_name} · ${selected.version_name || selected.version_id}`, "pc-lora-selected"));
        }
        // Keep the authoritative server ranking; selection changes only styling.
        for (const item of items) {
            const row = element("article", undefined, `pc-civitai-card${selected && identity(item) === identity(selected) ? " pc-lora-selected" : ""}`);
            if (item.image_url) { const image = element("img"); image.src = item.image_url; image.loading = "lazy"; image.alt = item.name; row.append(image); }
            row.append(element("strong", item.name), element("span", `${item.version_name} · ${item.base_model}`),
                element("span", `${Number(item.size_kb || 0).toLocaleString()} KB`), element("span", `Trigger: ${(item.triggers || []).join(", ") || "—"}`));
            const stats = item.stats || {};
            row.append(element("span", `Downloads ${stats.downloadCount || 0} · Likes ${stats.thumbsUpCount ?? stats.favoriteCount ?? 0} · Collected ${stats.collectedCount || 0} · Rating ${stats.rating ?? "—"}`));
            const link = element("a", "Civitai"); link.href = item.model_url; link.target = "_blank"; link.rel = "noopener noreferrer"; row.append(link);
            const detailButton = element("button", "詳細確認", "pc-button");
            detailButton.onclick = () => {
                if (details) { details(item, detailButton); return; }
                const detail = openModal(item.name);
                detail.dialog.append(element("p", `${item.version_name} · ${item.base_model}`), element("p", `File: ${item.file_name} · ${Number(item.size_kb || 0).toLocaleString()} KB`),
                    element("p", `Trigger: ${(item.triggers || []).join(", ") || "—"}`), element("p", `Model ${item.model_id} · Version ${item.version_id} · File ${item.file_id}`));
                const source = element("a", "Civitaiで開く"); source.href = item.model_url; source.target = "_blank"; source.rel = "noopener noreferrer"; detail.dialog.append(source);
            };
            row.append(detailButton);
            const choose = element("button", item.acquired ? "取得済み・選択" : "取得して選択", "pc-button");
            choose.onclick = async () => {
                const serial = revision, graph = node.graph, lora = value(node, "lora_name");
                const current = captureTarget({ node, graph, ownerGraph: graph }, activeGraph);
                choose.disabled = true;
                try {
                    const downloaded = await requestJSON(api, "/scene_prompt/civitai/download", { model_id: item.model_id, version_id: item.version_id, file_id: item.file_id, model_mode: value(node, "model_mode") });
                    if (!modal.overlay.isConnected || revision !== serial || !current() || value(node, "lora_name") !== lora) return;
                    beginChange(graph);
                    try { applyCandidate(node, { ...downloaded.candidate, lora_name: downloaded.lora_name }, { query: query.value.trim(), sort: sort.value }); }
                    finally { endChange(graph); }
                    item.acquired = true; item.lora_name = downloaded.lora_name;
                    refresh?.(node); render(items);
                } catch (error) { if (modal.overlay.isConnected && revision === serial)
                    showAPIError(error, query.value, () => { if (modal.overlay.isConnected && revision === serial) choose.click(); }); }
                finally { choose.disabled = false; }
            };
            row.append(choose); list.append(row);
        }
    }
    async function load(force = false) {
        if (!modal.overlay.isConnected) return;
        const serial = ++revision;
        const key = new URLSearchParams({ query: query.value.trim(), model_mode: value(node, "model_mode"), sort: sort.value }).toString();
        list.textContent = "検索中…";
        let result = !force && currentResult?.key === key ? currentResult.data : null;
        currentResult = null;
        try {
            if (!result) result = await requestJSON(api, `/scene_prompt/civitai/search?${key}`);
            if (!modal.overlay.isConnected || serial !== revision) return;
            currentResult = { key, data: result };
            render(result.items);
        } catch (error) {
            if (modal.overlay.isConnected && serial === revision) { list.textContent = "検索できませんでした。"; showAPIError(error, query.value, () => load(true)); }
        }
    }
    search.onclick = () => void load(true); sort.onchange = () => void load(true); query.onkeydown = (event) => { if (event.key === "Enter") void load(true); };
    query.focus(); void load(); return modal;
}
export async function openLLMSettings(api) {
    const modal = openModal("LLM接続設定"), form = element("form"), status = element("p");
    form.className = "pc-connection-settings"; status.setAttribute("role", "status");
    modal.dialog.append(form, status);
    const fields = {};
    function field(name, labelText, initial, help) {
        const label = element("label"), caption = element("span", labelText), input = element("input");
        input.type = name === "api_key" ? "password" : name === "base_url" ? "url" : "text";
        input.name = name; input.value = initial ?? "";
        if (name === "base_url") { caption.append(element("span", " *", "pc-required-star")); input.required = true; input.setAttribute("aria-required", "true"); }
        if (name === "port") input.inputMode = "numeric";
        label.append(caption, input); fields[name] = input; form.append(label);
        if (help) { const note = element("small", help, "pc-connection-help"); note.id = `pc-connection-help-${++settingsModalID}`; input.setAttribute("aria-describedby", note.id); form.append(note); }
    }
    try {
        const settings = await requestJSON(api, "/scene_prompt/llm/settings");
        if (!modal.overlay.isConnected) return modal;
        field("base_url", "API URL", settings.base_url);
        field("port", "ポート（任意）", settings.port, "空欄ならHTTP/HTTPSの既定ポートを使います。");
        field("model", "モデル名（任意）", settings.model, "空欄ならLLMサーバーの既定モデルを使います。");
        field("api_key", "LLM API Key（任意）", "", "接続先LLMサーバーの認証キーです。Codexのキーではありません。空欄で保存済みのキーを保持します。");
        const key = fields.api_key;
        key.placeholder = settings.api_key_set ? "保存済み（空欄で保持）" : "未設定";
        let clearKey = false, keyDraft = 0, clearDraft = 0;
        const clear = element("button", "API Keyを削除", "pc-button"); clear.type = "button"; clear.setAttribute("aria-pressed", "false");
        function renderClear() { clear.setAttribute("aria-pressed", String(clearKey)); clear.textContent = clearKey ? "API Key削除を取り消す" : "API Keyを削除"; }
        clear.onclick = () => { clearKey = !clearKey; clearDraft++; renderClear(); };
        key.addEventListener("input", () => keyDraft++); form.append(clear);
        const actions = element("div", undefined, "pc-connection-actions"), save = element("button", "保存", "pc-button"), test = element("button", "接続テスト・モデル取得", "pc-button");
        test.type = "button"; actions.append(save, test); form.append(actions);
        let portEdited = false;
        fields.port.addEventListener("input", () => { portEdited = true; });
        fields.base_url.addEventListener("blur", splitURL);
        function splitURL() {
            try {
                const url = new URL(fields.base_url.value.trim());
                if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) return;
                // A non-default scheme lets URL preserve explicit HTTP 80 / HTTPS 443.
                const pastedPort = new URL(fields.base_url.value.trim().replace(/^https?:/i, "scene-port:")).port;
                if (pastedPort) { if (!portEdited) fields.port.value = pastedPort; url.port = ""; fields.base_url.value = url.href.replace(/\/$/, ""); }
            } catch { /* Keep the draft for the validation message. */ }
        }
        function body() {
            splitURL();
            const url = new URL(fields.base_url.value.trim());
            if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error("API URLには認証情報・クエリ・フラグメントを含まないHTTP(S) URLを入力してください。");
            const port = fields.port.value;
            if (port !== "" && (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) throw new Error("ポートは1〜65535の整数、または空欄にしてください。");
            return { ...Object.fromEntries(Object.entries(fields).map(([name, input]) => [name, input.value])), clear_api_key: clearKey };
        }
        const datalist = element("datalist");
        datalist.id = `pc-llm-models-${++settingsModalID}`; fields.model.setAttribute("list", datalist.id); form.append(datalist);
        let busy = false;
        async function run(saving) {
            if (busy || !form.reportValidity()) return;
            let submitted;
            try { submitted = body(); } catch (error) { status.textContent = error.message; return; }
            const submittedKeyDraft = keyDraft, submittedClearDraft = clearDraft;
            busy = true; save.disabled = true; test.disabled = true;
            try {
                const result = await requestJSON(api, `/scene_prompt/llm/${saving ? "settings" : "test"}`, submitted);
                if (!modal.overlay.isConnected) return;
                if (saving) {
                    if (keyDraft === submittedKeyDraft && key.value === submitted.api_key) key.value = "";
                    if (submitted.clear_api_key && clearDraft === submittedClearDraft) { clearKey = false; renderClear(); }
                    key.placeholder = result.api_key_set ? "保存済み（空欄で保持）" : "未設定";
                    status.textContent = "保存しました";
                } else {
                    status.textContent = `接続成功: ${(result.models || []).map((model) => model.id).join(", ")}`;
                    datalist.replaceChildren();
                    for (const model of result.models || []) { const option = element("option"); option.value = model.id; datalist.append(option); }
                }
            } catch (error) { if (modal.overlay.isConnected) status.textContent = error.message; }
            finally { busy = false; save.disabled = false; test.disabled = false; }
        }
        form.onsubmit = (event) => { event.preventDefault(); void run(true); };
        test.onclick = () => void run(false);
    } catch (error) { if (modal.overlay.isConnected) status.textContent = error.message; }
    return modal;
}
