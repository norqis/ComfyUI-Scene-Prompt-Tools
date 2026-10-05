import { requestJSON, identity, value, applyCandidate, captureTarget } from "./scene_prompt_llm.js";

const cache = new Map();
let cacheEpoch = 0;
let settingsModalID = 0;
const SORTS = ["Most Downloaded", "Most Liked", "Most Collected", "Highest Rated"];
const modals = [];
function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}
export function openModal(title) {
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
    const modal = openModal("Civitai Search");
    const controls = element("div", undefined, "pc-civitai-controls"), query = element("input"), sort = element("select");
    query.type = "search"; query.value = state.query || ""; query.placeholder = "LoRAを検索"; query.setAttribute("aria-label", "検索語");
    sort.setAttribute("aria-label", "並び順");
    for (const name of SORTS) { const option = element("option", name); option.value = name; sort.append(option); }
    sort.value = state.sort || SORTS[0];
    const search = element("button", "検索", "pc-button"), list = element("div", undefined, "pc-civitai-results");
    controls.append(query, sort, search); modal.dialog.append(controls, list);
    let revision = 0;
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
                const serial = revision, epoch = cacheEpoch, graph = node.graph, lora = value(node, "lora_name");
                const current = captureTarget({ node, graph, ownerGraph: graph }, activeGraph);
                choose.disabled = true;
                try {
                    const downloaded = await requestJSON(api, "/scene_prompt/civitai/download", { model_id: item.model_id, version_id: item.version_id, file_id: item.file_id, model_mode: value(node, "model_mode") });
                    if (!modal.overlay.isConnected || revision !== serial || epoch !== cacheEpoch || !current() || value(node, "lora_name") !== lora) return;
                    beginChange(graph);
                    try { applyCandidate(node, { ...downloaded.candidate, lora_name: downloaded.lora_name }, { query: query.value.trim(), sort: sort.value }); }
                    finally { endChange(graph); }
                    item.acquired = true; item.lora_name = downloaded.lora_name;
                    refresh?.(node); render(items);
                } catch (error) { if (modal.overlay.isConnected) showAPIError(error, query.value, () => choose.click()); }
                finally { choose.disabled = false; }
            };
            row.append(choose); list.append(row);
        }
    }
    async function load(force = false) {
        const serial = ++revision, epoch = cacheEpoch;
        const key = new URLSearchParams({ query: query.value.trim(), model_mode: value(node, "model_mode"), sort: sort.value }).toString();
        list.textContent = "検索中…";
        try {
            let result = force ? null : cache.get(key);
            if (!result) {
                result = await requestJSON(api, `/scene_prompt/civitai/search?${key}`);
                if (epoch !== cacheEpoch) return;
                cache.delete(key); cache.set(key, result);
                while (cache.size > 20) cache.delete(cache.keys().next().value);
            }
            if (modal.overlay.isConnected && serial === revision && epoch === cacheEpoch) render(result.items);
        } catch (error) {
            if (modal.overlay.isConnected && serial === revision && epoch === cacheEpoch) { list.textContent = "検索できませんでした。"; showAPIError(error, query.value, () => load(true)); }
        }
    }
    search.onclick = () => void load(true); sort.onchange = () => void load(true); query.onkeydown = (event) => { if (event.key === "Enter") void load(true); };
    query.focus(); void load(); return modal;
}
export async function openLLMSettings(api) {
    const modal = openModal("LLM接続設定"), form = element("form"), status = element("p");
    modal.dialog.append(form, status);
    const fields = {};
    const labels = { base_url: "API URL", model: "モデル", api_key: "API Key", response_format: "応答形式", timeout_seconds: "タイムアウト（秒）", reasoning_effort: "Reasoning effort", max_tokens: "最大出力トークン", civitai_api_key: "Civitai API Key", civitai_host: "Civitai Host" };
    function field(name, initial) {
        const label = element("label", labels[name]);
        let input;
        const options = { response_format: ["json_object", "json_schema", "instructions"], reasoning_effort: ["", "none", "low", "medium", "high"], civitai_host: ["civitai.com", "civitai.red"] }[name];
        if (options) { input = element("select"); for (const value of options) { const option = element("option", value || "既定"); option.value = value; input.append(option); } }
        else { input = element("input"); input.type = name.includes("api_key") ? "password" : ["timeout_seconds", "max_tokens"].includes(name) ? "number" : "text"; }
        input.name = name; input.value = initial ?? ""; fields[name] = input; label.append(input); form.append(label);
    }
    try {
        const settings = await requestJSON(api, "/scene_prompt/llm/settings");
        if (!modal.overlay.isConnected) return;
        for (const name of Object.keys(labels)) field(name, settings[name]);
        for (const name of ["api_key", "civitai_api_key"]) {
            fields[name].placeholder = settings[`${name}_set`] ? "保存済み（空欄で保持）" : "未設定";
            const label = element("label", `${labels[name]}を削除`), input = element("input"); input.type = "checkbox"; input.name = `clear_${name}`; fields[`clear_${name}`] = input; label.append(input); form.append(label);
        }
        const save = element("button", "保存", "pc-button"), test = element("button", "接続テスト・モデル取得", "pc-button"); test.type = "button";
        form.append(save, test);
        const datalist = element("datalist"); datalist.id = `pc-llm-models-${++settingsModalID}`;
        fields.model.setAttribute("list", datalist.id); form.append(datalist);
        const body = () => Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : input.value]));
        const drafts = {};
        for (const name of ["api_key", "civitai_api_key", "clear_api_key", "clear_civitai_api_key"]) {
            drafts[name] = 0;
            fields[name].addEventListener("input", () => drafts[name]++);
        }
        let saving = false;
        form.onsubmit = async (event) => {
            event.preventDefault();
            if (saving) return;
            const submitted = body();
            const submittedDrafts = { ...drafts };
            saving = true; save.disabled = true;
            try {
                const saved = await requestJSON(api, "/scene_prompt/llm/settings", submitted);
                cacheEpoch++; cache.clear();
                if (!modal.overlay.isConnected) return;
                for (const name of ["api_key", "civitai_api_key"]) {
                    if (drafts[name] === submittedDrafts[name] && fields[name].value === submitted[name]) fields[name].value = "";
                    if (submitted[`clear_${name}`] && drafts[`clear_${name}`] === submittedDrafts[`clear_${name}`]) fields[`clear_${name}`].checked = false;
                    fields[name].placeholder = saved[`${name}_set`] ? "保存済み（空欄で保持）" : "未設定";
                }
                status.textContent = "保存しました";
            } catch (error) { status.textContent = error.message; }
            finally { saving = false; save.disabled = false; }
        };
        test.onclick = async () => {
            try {
                const result = await requestJSON(api, "/scene_prompt/llm/test", body());
                if (!modal.overlay.isConnected) return;
                status.textContent = `接続成功: ${(result.models || []).map((model) => model.id).join(", ")}`;
                datalist.replaceChildren();
                for (const model of result.models || []) { const option = element("option"); option.value = model.id; datalist.append(option); }
            } catch (error) { status.textContent = error.message; }
        };
    } catch (error) { status.textContent = error.message; }
    return modal;
}
