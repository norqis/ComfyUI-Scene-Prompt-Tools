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
function descriptionText(html) {
    const template = document.createElement("template");
    template.innerHTML = html || "";
    for (const node of template.content.querySelectorAll("script,style,iframe")) node.remove();
    for (const node of template.content.querySelectorAll("br")) node.replaceWith(document.createTextNode("\n"));
    for (const node of template.content.querySelectorAll("p,div,li,h1,h2,h3,h4,blockquote")) node.append(document.createTextNode("\n"));
    return template.content.textContent.replace(/\n{3,}/gu, "\n\n").trim();
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
            const controls = [...dialog.querySelectorAll("button,input,select,a[href],[tabindex=\"0\"]")].filter((node) => !node.disabled && node.getClientRects().length && !node.closest("[inert]"));
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
export function openCivitaiSearch({ node, api, refresh, activeGraph = () => node.graph,
    beginChange = (graph) => graph.beforeChange?.(), endChange = (graph) => graph.afterChange?.() }) {
    const state = node.properties?.scene_civitai || {};
    let revision = 0, detailRevision = 0, currentResult = null, downloadBusy = false;
    const modal = openModal("Civitai Search", () => {
        revision++; detailRevision++; currentResult = null;
        list.replaceChildren(); detail.replaceChildren();
    });
    modal.dialog.classList.add("pc-civitai-search-dialog");
    const controls = element("div", undefined, "pc-civitai-controls"), query = element("input"), sort = element("select"),
        model = element("select"), host = element("select");
    query.type = "search"; query.value = state.query || ""; query.placeholder = "LoRAを検索"; query.setAttribute("aria-label", "検索語");
    function options(select, label, names, selected) {
        select.setAttribute("aria-label", label);
        for (const name of names) { const option = element("option", name); option.value = name; select.append(option); }
        select.value = names.includes(selected) ? selected : names[0];
    }
    options(sort, "並び順", SORTS, state.sort);
    options(model, "Base Model", ["Illustrious", "Anima"], value(node, "model_mode"));
    options(host, "接続先", ["civitai.red", "civitai.com"], state.host);
    const search = element("button", "検索", "pc-button"), status = element("p", "", "pc-civitai-status"),
        list = element("div", undefined, "pc-civitai-results"), detail = element("div", undefined, "pc-civitai-detail");
    status.setAttribute("role", "status"); detail.hidden = true;
    controls.append(query, sort, model, host, search); modal.dialog.append(controls, status, list, detail);
    const snapshot = () => Object.freeze({ query: query.value.trim(), sort: sort.value, host: host.value, model_mode: model.value });
    function back(view, card, position) {
        detailRevision++; detail.replaceChildren(); detail.hidden = true; controls.hidden = false; list.hidden = false; status.hidden = false;
        if (currentResult !== view) return;
        list.scrollLeft = position.left; list.scrollTop = position.top; modal.dialog.scrollTop = position.modal;
        card.focus({ preventScroll: true });
    }
    function showDetails(item, view, card) {
        if (currentResult !== view || view.serial !== revision) return;
        const position = { left: list.scrollLeft, top: list.scrollTop, modal: modal.dialog.scrollTop };
        const serial = ++detailRevision;
        detail.replaceChildren(); controls.hidden = true; list.hidden = true; status.hidden = true; detail.hidden = false;
        const goBack = element("button", "戻る", "pc-button"), title = element("h2", item.name || "—");
        goBack.onclick = () => back(view, card, position);
        detail.append(goBack, title, element("p", item.version_name || "—"));
        const gallery = Array.isArray(item.gallery) ? item.gallery : item.image_url ? [{ url: item.image_url }] : [];
        const images = element("div", undefined, "pc-civitai-gallery"), pages = element("div", undefined, "pc-civitai-pages"),
            previous = element("button", "Previous", "pc-button"), next = element("button", "Next", "pc-button"), page = element("span");
        let offset = 0;
        function renderImages() {
            images.replaceChildren();
            if (!gallery.length) images.append(element("p", "プレビュー画像はありません。"));
            for (const preview of gallery.slice(offset, offset + 2)) {
                const image = element("img"); image.src = preview.url; image.alt = item.name || "LoRA preview";
                if (preview.width > 0 && preview.height > 0) image.style.aspectRatio = `${preview.width} / ${preview.height}`;
                images.append(image);
            }
            previous.disabled = offset === 0; next.disabled = offset + 2 >= gallery.length;
            page.textContent = gallery.length ? `${offset + 1}–${Math.min(offset + 2, gallery.length)} / ${gallery.length}` : "0 / 0";
        }
        previous.onclick = () => { offset -= 2; renderImages(); }; next.onclick = () => { offset += 2; renderImages(); };
        pages.append(previous, page, next); detail.append(images, pages); renderImages();
        const metadata = element("dl", undefined, "pc-civitai-metadata");
        function field(label, content) { metadata.append(element("dt", label), element("dd", content || "—")); }
        function stats(data) {
            return Object.entries({ downloadCount: "Downloads", thumbsUpCount: "Likes", favoriteCount: "Favorites", collectedCount: "Collected",
                rating: "Rating", ratingCount: "Ratings", commentCount: "Comments", tippedAmountCount: "Tips" })
                .filter(([key]) => data?.[key] != null).map(([key, label]) => `${label}: ${data[key]}`).join(" · ");
        }
        field("Base Model", item.base_model); field("Trigger Words", (item.triggers || []).join(", "));
        field("Description", descriptionText(item.description)); field("Version Description", descriptionText(item.version_description));
        field("Published", item.published_at); field("Model Stats", stats(item.model_stats || item.stats)); field("Version Stats", stats(item.version_stats));
        field("File", `${item.file_name || "—"} · ${Number(item.size_kb || 0).toLocaleString()} KB`);
        detail.append(metadata);
        const actions = element("div", undefined, "pc-civitai-detail-actions"),
            choose = element("button", item.acquired ? "取得済み・選択" : "取得して選択", "pc-button"), source = element("a", "Civitaiで開く");
        source.href = `https://${view.snapshot.host}/models/${item.model_id}?modelVersionId=${item.version_id}`;
        source.target = "_blank"; source.rel = "noopener noreferrer";
        choose.disabled = downloadBusy;
        actions.append(choose, source); detail.append(actions);
        choose.onclick = async () => {
            if (downloadBusy) return;
            const graph = node.graph, lora = value(node, "lora_name"), current = captureTarget({ node, graph, ownerGraph: graph }, activeGraph);
            const ownsAction = () => modal.overlay.isConnected && currentResult === view && revision === view.serial && detailRevision === serial;
            downloadBusy = true; choose.disabled = true;
            try {
                const downloaded = await requestJSON(api, "/scene_prompt/civitai/download", { model_id: item.model_id, version_id: item.version_id,
                    file_id: item.file_id, model_mode: view.snapshot.model_mode, host: view.snapshot.host });
                if (!ownsAction() || !current() || value(node, "lora_name") !== lora) return;
                if (!downloaded.candidate || !downloaded.lora_name) throw new Error("Civitai取得結果が無効です。");
                beginChange(graph);
                try { applyCandidate(node, { ...downloaded.candidate, lora_name: downloaded.lora_name }, view.snapshot); }
                finally { endChange(graph); }
                item.acquired = true; item.lora_name = downloaded.lora_name;
                for (const row of list.querySelectorAll(".pc-civitai-card")) row.classList.toggle("pc-lora-selected", row.dataset.identity === identity(item));
                choose.textContent = "取得済み・選択"; refresh?.(node);
            } catch (error) { if (ownsAction()) showAPIError(error, view.snapshot.query, () => { if (ownsAction()) choose.click(); }); }
            finally {
                downloadBusy = false;
                for (const button of detail.querySelectorAll(".pc-civitai-detail-actions button")) button.disabled = false;
            }
        };
        goBack.focus();
    }
    function render(view) {
        list.replaceChildren(); list.inert = false;
        const saved = node.properties?.scene_civitai;
        const selected = saved?.lora_name && saved.lora_name.replaceAll("\\", "/") === String(value(node, "lora_name")).replaceAll("\\", "/") ? saved : null;
        if (!view.items.length) { list.append(element("p", "該当するLoRAはありません。")); return; }
        const selectedLabel = selected?.name || selected?.lora_name;
        if (selectedLabel && [selected.model_id, selected.version_id, selected.file_id].every((id) => Number.isSafeInteger(Number(id)) && Number(id) > 0)
            && !view.items.some((item) => identity(item) === identity(selected)))
            status.textContent = `現在の選択（検索結果外）: ${selectedLabel}${selected.version_name ? ` · ${selected.version_name}` : ""}`;
        for (const item of view.items) {
            const card = element("article", undefined, `pc-civitai-card${selected && identity(item) === identity(selected) ? " pc-lora-selected" : ""}`);
            card.setAttribute("role", "button"); card.tabIndex = 0; card.dataset.identity = identity(item); card.setAttribute("aria-label", `${item.name} ${item.version_name || ""} の詳細`);
            if (item.image_url) { const image = element("img"); image.src = item.image_url; image.loading = "lazy"; image.alt = ""; card.append(image); }
            else card.append(element("div", "No preview", "pc-civitai-no-preview"));
            card.append(element("strong", item.name || "—"), element("span", item.version_name || "—"), element("span", item.base_model || "—"));
            card.onclick = () => showDetails(item, view, card);
            card.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); showDetails(item, view, card); } };
            list.append(card);
        }
    }
    async function load(requested = snapshot()) {
        if (!modal.overlay.isConnected) return;
        const serial = ++revision; detailRevision++;
        detail.replaceChildren(); detail.hidden = true; controls.hidden = false; list.hidden = false; status.hidden = false;
        status.textContent = "検索中…"; list.inert = true;
        try {
            const result = await requestJSON(api, `/scene_prompt/civitai/search?${new URLSearchParams(requested)}`);
            if (!modal.overlay.isConnected || serial !== revision) return;
            if (!Array.isArray(result.items)) throw new Error("API /scene_prompt/civitai/search · HTTP 200: 無効な検索応答です。");
            currentResult = { serial, snapshot: requested, items: result.items };
            status.textContent = ""; render(currentResult);
        } catch (error) {
            if (modal.overlay.isConnected && serial === revision) {
                status.textContent = currentResult ? "検索できませんでした。前の検索結果を表示しています。" : "検索できませんでした。";
                if (currentResult) { currentResult.serial = serial; list.inert = false; }
                showAPIError(error, requested.query, () => { if (modal.overlay.isConnected && serial === revision) void load(requested); });
            }
        }
    }
    search.onclick = () => void load();
    for (const select of [sort, model, host]) select.onchange = () => void load();
    query.onkeydown = (event) => { if (event.key === "Enter") void load(); };
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
        let keyDraft = 0;
        key.addEventListener("input", () => keyDraft++);
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
            return Object.fromEntries(Object.entries(fields).map(([name, input]) => [name, input.value]));
        }
        const datalist = element("datalist");
        datalist.id = `pc-llm-models-${++settingsModalID}`; fields.model.setAttribute("list", datalist.id); form.append(datalist);
        let busy = false;
        async function run(saving) {
            if (busy || !form.reportValidity()) return;
            let submitted;
            try { submitted = body(); } catch (error) { status.textContent = error.message; return; }
            const submittedKeyDraft = keyDraft;
            busy = true; save.disabled = true; test.disabled = true;
            try {
                const result = await requestJSON(api, `/scene_prompt/llm/${saving ? "settings" : "test"}`, submitted);
                if (!modal.overlay.isConnected) return;
                if (saving) {
                    if (keyDraft === submittedKeyDraft && key.value === submitted.api_key) key.value = "";
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
