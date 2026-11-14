import { requestJSON, identity, value, applyCandidate, captureTarget } from "./scene_prompt_llm.js";
import { SCENE_MODEL_MODES } from "./scene_prompt_state.js";

let settingsModalID = 0;
const SORTS = ["Most Downloaded", "Most Liked", "Most Collected", "Highest Rated"];
const modals = [];
const searchViews = new WeakMap();
let searchViewGeneration = 0;
export function waitForModalPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}
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
export function renderCivitaiDescription(html) {
    const template = document.createElement("template");
    template.innerHTML = html || "";
    const allowed = new Set(["P", "DIV", "SPAN", "BR", "PRE", "CODE", "UL", "OL", "LI", "STRONG", "B", "EM", "I", "U", "S",
        "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "HR", "A"]);
    const blocked = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "TEMPLATE", "IMG", "VIDEO", "AUDIO"]);
    const content = element("div", undefined, "pc-civitai-description");
    function append(source, parent) {
        if (source.nodeType === Node.TEXT_NODE) { parent.append(document.createTextNode(source.textContent)); return; }
        if (source.nodeType !== Node.ELEMENT_NODE) return;
        const tag = source.tagName.toUpperCase();
        if (blocked.has(tag)) return;
        let target = parent;
        if (allowed.has(tag)) {
            target = document.createElement(tag.toLowerCase());
            if (tag === "A") {
                let url;
                try { url = new URL(source.getAttribute("href")); } catch (_) { /* Plain text for non-absolute links. */ }
                if (url && ["http:", "https:"].includes(url.protocol)) {
                    target.href = url.href; target.target = "_blank"; target.rel = "noopener noreferrer";
                } else target = document.createElement("span");
            }
            parent.append(target);
        }
        for (const child of source.childNodes) append(child, target);
    }
    for (const child of template.content.childNodes) append(child, content);
    return content;
}
export function openModal(title, onDismiss, focus = document.activeElement) {
    const overlay = element("div", undefined, "pc-lora-overlay");
    const dialog = element("div", undefined, "pc-lora-dialog pc-civitai-dialog");
    dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true");
    const head = element("div", undefined, "pc-lora-head"), heading = element("strong"), close = element("button", "閉じる", "pc-button");
    head.append(heading, close); dialog.append(head); overlay.append(dialog); document.body.append(overlay);
    const modal = { overlay, dialog, head, close, dismiss, setTitle(text) { heading.textContent = text; dialog.setAttribute("aria-label", text); } };
    modal.setTitle(title);
    modals.push(modal);
    for (const previous of modals.slice(0, -1)) previous.overlay.inert = true;
    let closed = false;
    function dismiss() {
        if (closed) return;
        closed = true;
        const index = modals.indexOf(modal), children = modals.slice(index + 1).reverse();
        modals.splice(index, 1);
        onDismiss?.();
        for (const child of children) child.dismiss();
        document.removeEventListener("keydown", onKey); overlay.remove();
        const current = modals.at(-1); if (current) current.overlay.inert = false;
        if (focus?.isConnected) focus.focus?.();
    }
    function onKey(event) {
        if (modals.at(-1) !== modal) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); dismiss(); return; }
        if (event.key === "Tab") {
            const controls = [...dialog.querySelectorAll("button,input,select,a[href],[tabindex=\"0\"]")].filter((node) => !node.disabled && node.getClientRects().length && !node.closest("[inert]"));
            const first = controls[0], last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
    }
    close.onclick = dismiss; overlay.onclick = (event) => { if (event.target === overlay && modals.at(-1) === modal) dismiss(); };
    document.addEventListener("keydown", onKey); close.focus();
    return modal;
}
export function showAPIError(error, query, retry) {
    const modal = openModal("取得に失敗しました");
    modal.dialog.append(element("p", `検索・説明: ${query || "—"}`), element("p", error.message, "pc-civitai-error"));
    const button = element("button", "再試行", "pc-button");
    button.onclick = () => { modal.dismiss(); void retry(); }; modal.dialog.append(button);
    return modal;
}
export function openCivitaiAuth({ api, host = "civitai.red", onAuthenticated }) {
    const controller = new AbortController();
    let serial = 0, busy = false;
    const modal = openModal("Civitai 認証", () => { serial++; controller.abort(); key.value = ""; });
    const heading = element("p", "Civitai APIキー認証"), issue = element("a", "公式サイトでAPIキーを発行"), key = element("input"), status = element("p", "読み込み中…"),
        authenticate = element("button", "認証", "pc-button"), clear = element("button", "認証解除", "pc-button"), form = element("form");
    issue.href = "https://civitai.com/user/account"; issue.target = "_blank"; issue.rel = "noopener noreferrer";
    key.type = "password"; key.autocomplete = "off"; key.setAttribute("aria-label", "Civitai APIキー");
    key.placeholder = "APIキー（保存済みなら空欄で再確認）";
    const note = element("p", "APIキーはこのComfyUIユーザー領域に保存され、暗号化はされません。");
    clear.type = "button"; clear.hidden = true;
    form.append(heading, issue, key, note, authenticate, clear); modal.dialog.append(form, status);
    const current = value => !controller.signal.aborted && serial === value;
    function show(data) { status.textContent = data.configured ? `保存済み: ${data.username || "Civitai"}` : "未認証"; clear.hidden = !data.configured; }
    const readSerial = ++serial;
    requestJSON(api, "/scene_prompt/civitai/auth", undefined, { signal: controller.signal, cache: "no-store" })
        .then(data => { if (current(readSerial)) show(data); }).catch(error => { if (current(readSerial)) status.textContent = error.message; });
    async function submit(removing) {
        if (busy) return;
        const requestedSerial = ++serial;
        busy = true; authenticate.disabled = true; clear.disabled = true;
        try {
            const data = await requestJSON(api, removing ? "/scene_prompt/civitai/auth/clear" : "/scene_prompt/civitai/auth",
                removing ? {} : { api_key: key.value, host }, { signal: controller.signal, cache: "no-store" });
            if (!current(requestedSerial)) return;
            key.value = ""; show(data);
            if (!removing) { onAuthenticated?.(data); modal.dismiss(); }
        } catch (error) { if (current(requestedSerial)) status.textContent = error.message; }
        finally { busy = false; authenticate.disabled = false; clear.disabled = false; }
    }
    form.onsubmit = event => { event.preventDefault(); void submit(false); };
    clear.onclick = () => void submit(true);
    key.focus(); return modal;
}
function showCivitaiDownloadError(error, { api, host, query, retry, isCurrent }) {
    const modal = openModal("取得に失敗しました"), status = element("p", error.message, "pc-civitai-error"), again = element("button", "再試行", "pc-button");
    modal.dialog.append(element("p", `検索・説明: ${query || "—"}`), status, again);
    again.onclick = () => { modal.dismiss(); if (isCurrent()) void retry(); };
    if (error.status === 401 && error.code !== "civitai_download_disabled") {
        again.hidden = true;
        const auth = element("button", "認証", "pc-button");
        auth.onclick = () => {
            if (!isCurrent()) return;
            openCivitaiAuth({ api, host, onAuthenticated: () => {
                if (!isCurrent() || !modal.overlay.isConnected) return;
                status.textContent = "認証しました。再取得してください。"; again.textContent = "再取得"; again.hidden = false;
            } });
        };
        modal.dialog.append(auth);
    }
    return modal;
}
function galleryScope(api) {
    const controller = new AbortController(), promises = new Map(), pending = [];
    let active = 0;
    function pump() {
        while (!controller.signal.aborted && active < 3 && pending.length) {
            const job = pending.shift(); active++;
            requestJSON(api, `/scene_prompt/civitai/gallery?${new URLSearchParams(job.query)}`, undefined, { signal: controller.signal })
                .then(job.resolve, job.reject).finally(() => { active--; pump(); });
        }
    }
    return {
        get(host, versionID, cursor) {
            const key = `${host}/${versionID}/${cursor || ""}`;
            if (!promises.has(key)) {
                const query = { host, version_id: versionID }; if (cursor) query.cursor = cursor;
                const promise = new Promise((resolve, reject) => { pending.push({ query, resolve, reject }); pump(); });
                promises.set(key, promise);
                promise.catch(() => { if (promises.get(key) === promise) promises.delete(key); });
            }
            return promises.get(key);
        },
        close() {
            controller.abort();
            for (const job of pending.splice(0)) job.reject(new DOMException("Closed", "AbortError"));
            promises.clear();
        },
    };
}
function appendGallery(gallery, incoming) {
    const ids = new Set(gallery.filter(image => image.id).map(image => image.id)), urls = new Set(gallery.map(image => image.url));
    for (const image of incoming || []) {
        if (!image?.url || ids.has(image.id) || urls.has(image.url)) continue;
        gallery.push(image); if (image.id) ids.add(image.id); urls.add(image.url);
    }
}
function imageInformation(preview, host) {
    let meta = preview.meta || {};
    if (meta.meta && typeof meta.meta === "object") meta = { ...meta, ...meta.meta };
    const omitted = new Set(["meta", "prompt", "positive", "negativePrompt", "negative_prompt", "negative", "tags", "tag", "resources", "civitaiResources"]);
    const resources = meta.resources || meta.civitaiResources || [];
    return { resources: Array.isArray(resources) ? resources.filter(resource => resource && typeof resource === "object").map(resource => {
        const model = resource.model || {}, modelID = model.id || resource.modelId;
        return { name: model.name || resource.name, version_name: model.name ? resource.name : "", type: model.type || resource.type,
            strength: resource.strength ?? resource.weight,
            ...(Number.isSafeInteger(modelID) && modelID > 0 ? { url: `https://${host}/models/${modelID}` } : {}) };
    }) : [], prompt: meta.prompt ?? meta.positive,
        negative_prompt: meta.negativePrompt ?? meta.negative_prompt ?? meta.negative, tags: meta.tags ?? meta.tag,
        other: Object.fromEntries(Object.entries(meta).filter(([key]) => !omitted.has(key))) };
}
function displayValue(value) {
    if (value == null || value === "" || Array.isArray(value) && !value.length) return "公開情報なし";
    return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
}
export function openCivitaiImage({ api, preview, index, host }) {
    const request = new AbortController(), modal = openModal(`Civitai Image #${index + 1}`, () => request.abort());
    modal.dialog.classList.add("pc-civitai-image-dialog");
    const layout = element("div", undefined, "pc-civitai-image-layout"), image = element("img"), information = element("section", undefined, "pc-civitai-generation-data");
    image.src = preview.url; image.alt = `Civitai Image #${index + 1}`;
    layout.append(image, information); modal.dialog.append(layout);
    function render(data) {
        information.replaceChildren(element("h2", "GENERATION DATA"));
        if (data.partial) information.append(element("p", "一部の生成情報を取得できませんでした。公開画像の情報を表示しています。"));
        for (const [heading, value] of [["RESOURCES USED", data.resources], ["PROMPT", data.prompt], ["TAG", data.tags], ["NEGATIVE PROMPT", data.negative_prompt]]) {
            const section = element("section"); section.append(element("h3", heading));
            if (heading === "RESOURCES USED" && Array.isArray(value) && value.length) {
                for (const resource of value) {
                    const row = element("div", undefined, "pc-civitai-resource"), name = element("span", resource.name || "公開情報なし");
                    if (resource.url) { const link = element("a", name.textContent); link.href = resource.url; link.target = "_blank"; link.rel = "noopener noreferrer"; row.append(link); }
                    else row.append(name);
                    row.append(element("span", [resource.version_name, resource.type, resource.strength == null ? "" : `Strength: ${resource.strength}`].filter(Boolean).join(" · ")));
                    section.append(row);
                }
            } else section.append(element("div", displayValue(value), "pc-civitai-data-text"));
            information.append(section);
        }
        information.append(element("h3", "OTHER METADATA"));
        const entries = Object.entries(data.other || {});
        if (!entries.length) information.append(element("p", "公開情報なし"));
        for (const [key, value] of entries) {
            if (value && typeof value === "object") {
                const details = element("details"), summary = element("summary", key), pre = element("pre");
                let rendered = false;
                details.addEventListener("toggle", () => { if (details.open && !rendered) { rendered = true; pre.textContent = displayValue(value); } });
                details.append(summary, pre); information.append(details);
            } else information.append(element("p", `${key}: ${displayValue(value)}`));
        }
    }
    render(imageInformation(preview, host));
    if (preview.id) {
        const status = element("p", "読み込み中…"); information.prepend(status);
        requestJSON(api, `/scene_prompt/civitai/image?${new URLSearchParams({ image_id: preview.id, host })}`, undefined, { signal: request.signal }).then(data => {
            if (!request.signal.aborted) render(data);
        }).catch(error => { if (!request.signal.aborted) status.textContent = `生成情報を取得できませんでした。 ${error.message}`; });
    }
    return modal;
}
function renderCivitaiDetail({ modal, container, item, host, scope, api, onBack, onChoose, isCurrent }) {
    const back = element("button", "戻る", "pc-button"); back.onclick = onBack;
    container.replaceChildren(back, element("h2", item.name || "公開情報なし"), element("p", item.version_name || "公開情報なし"));
    const gallery = [...(Array.isArray(item.gallery) ? item.gallery : item.image_url ? [{ url: item.image_url }] : [])];
    const images = element("div", undefined, "pc-civitai-gallery"), pages = element("div", undefined, "pc-civitai-pages"),
        previous = element("button", "Previous", "pc-button"), next = element("button", "Next", "pc-button"), page = element("span"),
        more = element("button", "Load more", "pc-button"), galleryStatus = element("div", undefined, "pc-civitai-status");
    let offset = 0, cursor = item.next_cursor || null, busy = false;
    function renderImages() {
        images.replaceChildren();
        if (!gallery.length) images.append(element("p", "プレビュー画像はありません。"));
        for (const [slot, preview] of gallery.slice(offset, offset + 2).entries()) {
            const button = element("button", undefined, "pc-civitai-image-button"), image = element("img");
            button.type = "button"; button.setAttribute("aria-label", `Civitai Image #${offset + slot + 1}`);
            image.src = preview.url; image.alt = item.name || "Civitai preview";
            if (preview.width > 0 && preview.height > 0) image.style.aspectRatio = `${preview.width} / ${preview.height}`;
            button.append(image); button.onclick = () => openCivitaiImage({ api, preview, index: offset + slot, host }); images.append(button);
        }
        previous.disabled = offset === 0; next.disabled = offset + 2 >= gallery.length;
        page.textContent = gallery.length ? `${offset + 1}–${Math.min(offset + 2, gallery.length)} / ${gallery.length}` : "0 / 0";
        more.hidden = !cursor;
    }
    async function loadGallery(nextCursor) {
        if (busy) return; busy = true; more.disabled = true; galleryStatus.textContent = "画像を読み込み中…";
        try {
            const result = await scope.get(host, item.version_id, nextCursor);
            if (!isCurrent()) return;
            appendGallery(gallery, result.items); cursor = result.next_cursor || null;
            item.gallery = gallery.slice(); item.image_url = gallery[0]?.url || ""; item.next_cursor = cursor;
            galleryStatus.replaceChildren(); renderImages();
        } catch (error) {
            if (!isCurrent()) return;
            galleryStatus.replaceChildren(element("span", `画像を取得できませんでした。 ${error.message}`));
            const retry = element("button", "再試行", "pc-button"); retry.onclick = () => void loadGallery(nextCursor); galleryStatus.append(retry);
        } finally { busy = false; more.disabled = false; }
    }
    previous.onclick = () => { offset -= 2; renderImages(); }; next.onclick = () => { offset += 2; renderImages(); };
    more.onclick = () => void loadGallery(cursor);
    pages.append(previous, page, next, more); container.append(images, pages, galleryStatus); renderImages();
    if (!gallery.length) void loadGallery();
    const metadata = element("dl", undefined, "pc-civitai-metadata");
    function field(label, content) { metadata.append(element("dt", label), element("dd", displayValue(content))); }
    function stats(data) { return Object.entries({ downloadCount: "Downloads", thumbsUpCount: "Likes", favoriteCount: "Favorites", collectedCount: "Collected", rating: "Rating", ratingCount: "Ratings", commentCount: "Comments", tippedAmountCount: "Tips" }).filter(([key]) => data?.[key] != null).map(([key, label]) => `${label}: ${data[key]}`).join(" · "); }
    field("BASE MODEL", item.base_model); field("TRIGGER WORDS", (item.triggers || []).join(", "));
    field("DESCRIPTION", descriptionText(item.description)); field("VERSION DESCRIPTION", descriptionText(item.version_description));
    field("PUBLISHED", item.published_at); field("MODEL STATS", stats(item.model_stats || item.stats)); field("VERSION STATS", stats(item.version_stats));
    if (item.file_name) field("FILE", `${item.file_name} · ${Number(item.size_kb || 0).toLocaleString()} KB`);
    container.append(metadata);
    const actions = element("div", undefined, "pc-civitai-detail-actions"), source = element("a", "公式サイトを開く");
    source.href = `https://${host}/models/${item.model_id}?modelVersionId=${item.version_id}`; source.target = "_blank"; source.rel = "noopener noreferrer";
    if (onChoose) {
        const choose = element("button", item.acquired ? "取得済み・選択" : "取得して選択", "pc-button");
        choose.onclick = () => onChoose(choose); actions.append(choose);
    }
    actions.append(source); container.append(actions); back.focus();
}
export function openCivitaiDetail({ api, modelID, versionID, host = "civitai.red" }) {
    const request = new AbortController(), scope = galleryScope(api);
    const modal = openModal("Civitai Detail", () => { request.abort(); scope.close(); });
    const container = element("div", undefined, "pc-civitai-detail"); modal.dialog.append(container);
    async function load() {
        container.replaceChildren(element("p", "読み込み中…"));
        try {
            const item = await requestJSON(api, `/scene_prompt/civitai/details?${new URLSearchParams({ model_id: modelID, version_id: versionID, host })}`, undefined, { signal: request.signal });
            if (request.signal.aborted) return;
            renderCivitaiDetail({ modal, container, item, host, scope, api, onBack: modal.dismiss, isCurrent: () => !request.signal.aborted });
        } catch (error) {
            if (request.signal.aborted) return;
            container.replaceChildren(element("p", error.message));
            const back = element("button", "戻る", "pc-button"), retry = element("button", "再試行", "pc-button");
            back.onclick = modal.dismiss; retry.onclick = () => void load(); container.append(back, retry);
        }
    }
    void load(); return modal;
}
export function openCivitaiSearch({ node, api, refresh, activeGraph = () => node.graph,
    beginChange = (graph) => graph.beforeChange?.(), endChange = (graph) => graph.afterChange?.() }) {
    const cached = searchViews.get(node), state = cached?.draft || node.properties?.scene_civitai || {};
    const generation = ++searchViewGeneration;
    searchViews.set(node, { ...cached, generation });
    let revision = 0, detailRevision = 0, currentResult = null, downloadBusy = false, searchRequest, optionsRequest, tagRequest, tagTimer, tagRevision = 0;
    const hostOptions = new Map(Object.entries(cached?.hostOptions || {}));
    let gridPosition = cached?.gridPosition || { left: 0, top: 0, modal: 0 };
    function saveView() {
        if (searchViews.get(node)?.generation !== generation) return;
        const result = currentResult ? structuredClone({ snapshot: currentResult.snapshot,
            items: currentResult.items.map(item => ({ ...item, gallery: (item.gallery || []).map(({ id, url, width, height }) => ({ id, url, width, height })) })) }) : null;
        searchViews.set(node, { generation, draft: snapshot(), lastSuccessfulResult: result, gridPosition: { ...gridPosition }, hostOptions: structuredClone(Object.fromEntries(hostOptions)) });
    }
    const modal = openModal("Civitai Search", () => {
        revision++; detailRevision++;
        if (!list.hidden) gridPosition = { left: list.scrollLeft, top: list.scrollTop, modal: modal.dialog.scrollTop };
        saveView(); searchRequest?.abort(); optionsRequest?.abort(); tagRequest?.abort(); clearTimeout(tagTimer); currentResult?.scope.close(); observer.disconnect(); currentResult = null;
        list.replaceChildren(); detail.replaceChildren();
        if (!modals.some(entry => entry.ownerNode === node)) node.sceneCivitaiSearchCleanup = null;
    });
    modal.ownerNode = node;
    node.sceneCivitaiSearchCleanup = () => { for (const entry of modals.filter(entry => entry.ownerNode === node).reverse()) entry.dismiss(); };
    modal.dialog.classList.add("pc-civitai-search-dialog");
    const authentication = element("button", "認証", "pc-button"); authentication.onclick = () => openCivitaiAuth({ api, host: host.value });
    const headActions = element("div", undefined, "pc-lora-head-actions"); headActions.append(authentication, modal.close); modal.head.append(headActions);
    const controls = element("div", undefined, "pc-civitai-controls"), query = element("input"), sort = element("select"), model = element("select"), host = element("select"), modelType = element("select"), category = element("input"), tagList = element("datalist");
    query.type = "search"; query.value = state.query || ""; query.placeholder = "モデルを検索"; query.setAttribute("aria-label", "検索語");
    function options(select, label, names, selected) { select.replaceChildren(); select.setAttribute("aria-label", label); for (const name of names) { const option = element("option", name); option.value = name; select.append(option); } select.value = names.includes(selected) ? selected : names[0]; }
    options(sort, "並び順", SORTS, state.sort); options(model, "Base Model", SCENE_MODEL_MODES, value(node, "model_mode")); options(host, "接続先", ["civitai.red", "civitai.com"], state.host);
    const allModels = element("option", "All"); allModels.value = ""; model.prepend(allModels);
    if (state.model_mode !== undefined) model.value = state.model_mode;
    options(modelType, "Model Type", [state.model_type || "LORA"], state.model_type || "LORA");
    if (modelType.options[0].value === "LORA") modelType.options[0].textContent = "LoRA";
    category.setAttribute("role", "combobox"); category.setAttribute("aria-label", "Category"); category.setAttribute("aria-autocomplete", "list"); category.value = state.category || "";
    category.placeholder = "Category";
    tagList.id = `pc-civitai-tags-${++settingsModalID}`; category.setAttribute("list", tagList.id);
    const tagHelp = element("small", "Civitaiのモデルタグ");
    function setTags(tags) { tagList.replaceChildren(); for (const tag of new Set(["Action", "Style", "Concept", ...tags])) { const option = element("option"); option.value = tag; tagList.append(option); } }
    setTags([]);
    async function loadOptions() {
        const selectedHost = host.value;
        optionsRequest?.abort(); optionsRequest = new AbortController();
        try {
            if (!hostOptions.has(selectedHost)) hostOptions.set(selectedHost, await requestJSON(api, `/scene_prompt/civitai/options?${new URLSearchParams({ host: selectedHost })}`, undefined, { signal: optionsRequest.signal }));
            if (!modal.overlay.isConnected || selectedHost !== host.value) return;
            const selected = modelType.value;
            options(modelType, "Model Type", hostOptions.get(selectedHost).model_types, selected);
            for (const option of modelType.options) if (option.value === "LORA") option.textContent = "LoRA";
        } catch (error) { if (error.name !== "AbortError" && selectedHost === host.value && modal.overlay.isConnected) showAPIError(error, "Model Type", () => void loadOptions()); }
    }
    category.addEventListener("input", () => {
        const serial = ++tagRevision, selectedHost = host.value, text = category.value;
        clearTimeout(tagTimer); tagRequest?.abort();
        tagTimer = setTimeout(async () => {
            tagRequest = new AbortController();
            try {
                const data = await requestJSON(api, `/scene_prompt/civitai/tags?${new URLSearchParams({ host: selectedHost, query: text })}`, undefined, { signal: tagRequest.signal });
                if (modal.overlay.isConnected && serial === tagRevision && selectedHost === host.value) setTags(data.items || []);
            } catch (error) { if (error.name !== "AbortError" && serial === tagRevision && modal.overlay.isConnected) tagHelp.textContent = "Civitaiのモデルタグ（候補を取得できませんでした）"; }
        }, 250);
    });
    const search = element("button", "検索", "pc-button"), status = element("p", "", "pc-civitai-status"), list = element("div", undefined, "pc-civitai-results"), detail = element("div", undefined, "pc-civitai-detail");
    status.setAttribute("role", "status"); detail.hidden = true;
    controls.append(query, host, model, modelType, category, tagList, tagHelp, sort, search); modal.dialog.append(controls, status, list, detail);
    const snapshot = () => Object.freeze({ query: query.value.trim(), sort: sort.value, host: host.value, model_mode: model.value, model_type: modelType.value, category: category.value.trim() });
    const observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue; observer.unobserve(entry.target);
            const view = currentResult, item = view?.items[Number(entry.target.dataset.index)];
            if (!item || item.image_url) continue;
            const card = entry.target;
            view.scope.get(view.snapshot.host, item.version_id).then(result => {
                if (currentResult !== view || view.serial !== revision || !card.isConnected) return;
                item.gallery = result.items || []; item.image_url = item.gallery[0]?.url || ""; item.next_cursor = result.next_cursor;
                const preview = card.querySelector(".pc-civitai-no-preview");
                if (item.image_url) { const image = element("img"); image.src = item.image_url; image.loading = "lazy"; image.alt = ""; preview?.replaceWith(image); }
                else if (preview) preview.textContent = "プレビュー画像はありません。";
            }).catch(() => { if (currentResult === view && view.serial === revision && card.isConnected) card.querySelector(".pc-civitai-no-preview").textContent = "画像を取得できませんでした。クリックして再試行"; });
        }
    }, { root: list });
    function back(view, card, position) {
        detailRevision++; detail.replaceChildren(); detail.hidden = true; controls.hidden = false; list.hidden = false; status.hidden = false; modal.setTitle("Civitai Search");
        if (currentResult !== view) return;
        list.scrollLeft = position.left; list.scrollTop = position.top; modal.dialog.scrollTop = position.modal; card.focus({ preventScroll: true });
    }
    function showDetails(item, view, card) {
        if (currentResult !== view || view.serial !== revision) return;
        const position = { left: list.scrollLeft, top: list.scrollTop, modal: modal.dialog.scrollTop }, serial = ++detailRevision;
        gridPosition = position;
        controls.hidden = true; list.hidden = true; status.hidden = true; detail.hidden = false; modal.setTitle("Civitai Detail");
        const ownsAction = () => modal.overlay.isConnected && currentResult === view && revision === view.serial && detailRevision === serial;
        renderCivitaiDetail({ modal, container: detail, item, host: view.snapshot.host, scope: view.scope, api, onBack: () => back(view, card, position), isCurrent: ownsAction,
            onChoose: item.installable === false ? null : async choose => {
                if (downloadBusy) return;
                const graph = node.graph, lora = value(node, "lora_name"), current = captureTarget({ node, graph, ownerGraph: graph }, activeGraph);
                downloadBusy = true; choose.disabled = true;
                try {
                    const applyMode = item.apply_model_mode || view.snapshot.model_mode;
                    const downloaded = await requestJSON(api, "/scene_prompt/civitai/download", { model_id: item.model_id, version_id: item.version_id, file_id: item.file_id, model_mode: applyMode, host: view.snapshot.host });
                    if (!ownsAction() || !current() || value(node, "lora_name") !== lora) return;
                    if (!downloaded.candidate || !downloaded.lora_name) throw new Error("Civitai取得結果が無効です。");
                    beginChange(graph); try { applyCandidate(node, { ...downloaded.candidate, lora_name: downloaded.lora_name }, { ...view.snapshot, model_mode: applyMode }); } finally { endChange(graph); }
                    item.acquired = true; item.lora_name = downloaded.lora_name;
                    for (const row of list.querySelectorAll(".pc-civitai-card")) row.classList.toggle("pc-lora-selected", row.dataset.identity === identity(item));
                    choose.textContent = "取得済み・選択"; refresh?.(node);
                } catch (error) { if (ownsAction()) showCivitaiDownloadError(error, { api, host: view.snapshot.host, query: view.snapshot.query, retry: () => choose.click(), isCurrent: () => ownsAction() && current() && value(node, "lora_name") === lora }); }
                finally { downloadBusy = false; if (ownsAction()) choose.disabled = false; }
            } });
    }
    function render(view) {
        list.replaceChildren(); list.inert = false; observer.disconnect();
        const saved = node.properties?.scene_civitai;
        const selected = saved?.lora_name && saved.lora_name.replaceAll("\\", "/") === String(value(node, "lora_name")).replaceAll("\\", "/") ? saved : null;
        if (!view.items.length) { list.append(element("p", "該当するモデルはありません。")); return; }
        const selectedLabel = selected?.name || selected?.lora_name;
        if (selectedLabel && [selected.model_id, selected.version_id, selected.file_id].every((id) => Number.isSafeInteger(Number(id)) && Number(id) > 0) && !view.items.some(item => identity(item) === identity(selected))) status.textContent = `現在の選択（検索結果外）: ${selectedLabel}${selected.version_name ? ` · ${selected.version_name}` : ""}`;
        for (const [index, item] of view.items.entries()) {
            const card = element("article", undefined, `pc-civitai-card${selected && identity(item) === identity(selected) ? " pc-lora-selected" : ""}`);
            card.setAttribute("role", "button"); card.tabIndex = 0; card.dataset.identity = identity(item); card.dataset.index = index; card.setAttribute("aria-label", `${item.name} ${item.version_name || ""} の詳細`);
            if (item.image_url) { const image = element("img"); image.src = item.image_url; image.loading = "lazy"; image.alt = ""; card.append(image); }
            else card.append(element("div", "読み込み待ち…", "pc-civitai-no-preview"));
            card.append(element("span", item.version_name || "—"), element("span", item.base_model || "—"));
            const footer = element("div", undefined, "pc-civitai-card-footer"), summary = element("div", undefined, "pc-civitai-card-summary"), metrics = element("span", undefined, "pc-civitai-card-stats"), title = element("strong", item.name || "—");
            title.title = item.name || "—";
            const updatedDate = item.updated_at ? new Date(item.updated_at) : null;
            const updated = element("span", `Updated: ${updatedDate && Number.isFinite(updatedDate.getTime()) ? updatedDate.toLocaleDateString("ja-JP") : "—"}`, "pc-civitai-card-updated");
            if (item.updated_at) updated.title = item.updated_at;
            summary.append(updated, metrics);
            const compact = number => typeof number === "number" && Number.isFinite(number) && number >= 0 ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(number) : "—";
            for (const [key, label, icon] of [["downloadCount", "Downloads", "⇩"], ["collectedCount", "Bookmarks", "🔖"], ["thumbsUpCount", "Likes", "👍"]]) {
                const text = compact(item.model_stats?.[key]), group = element("span"), symbol = element("span", icon);
                group.title = `${label}: ${text}`; group.setAttribute("aria-label", `${label}: ${text}`); symbol.setAttribute("aria-hidden", "true"); group.append(symbol, document.createTextNode(` ${text}`)); metrics.append(group);
            }
            footer.append(title, summary); card.append(footer);
            card.onclick = () => showDetails(item, view, card); card.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); showDetails(item, view, card); } }; list.append(card);
            if (!item.image_url) observer.observe(card);
        }
    }
    async function load(requested = snapshot()) {
        if (!modal.overlay.isConnected) return;
        const serial = ++revision; detailRevision++; searchRequest?.abort(); currentResult?.scope.close(); observer.disconnect(); searchRequest = new AbortController();
        detail.replaceChildren(); detail.hidden = true; controls.hidden = false; list.hidden = false; status.hidden = false; modal.setTitle("Civitai Search"); status.textContent = "検索中…"; list.inert = true;
        try {
            const result = await requestJSON(api, `/scene_prompt/civitai/search?${new URLSearchParams(requested)}`, undefined, { signal: searchRequest.signal });
            if (!modal.overlay.isConnected || serial !== revision) return;
            if (!Array.isArray(result.items)) throw new Error("API /scene_prompt/civitai/search · HTTP 200: 無効な検索応答です。");
            currentResult = { serial, snapshot: requested, items: result.items, scope: galleryScope(api) }; status.textContent = ""; render(currentResult); saveView();
        } catch (error) {
            if (modal.overlay.isConnected && serial === revision) {
                status.textContent = currentResult ? "検索できませんでした。前の検索結果を表示しています。" : "検索できませんでした。";
                if (currentResult) { currentResult.serial = serial; currentResult.scope = galleryScope(api); list.inert = false; }
                showAPIError(error, requested.query, () => { if (modal.overlay.isConnected && serial === revision) void load(requested); });
            }
        }
    }
    search.onclick = () => void load(); for (const select of [sort, model, modelType]) select.onchange = () => void load();
    host.onchange = () => { tagRevision++; clearTimeout(tagTimer); tagRequest?.abort(); setTags([]); void loadOptions(); void load(); };
    category.onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); void load(); } };
    query.onkeydown = event => { if (event.key === "Enter") void load(); };
    query.focus(); void loadOptions();
    if (cached?.lastSuccessfulResult) {
        const result = structuredClone(cached.lastSuccessfulResult);
        currentResult = { serial: revision, snapshot: Object.freeze(result.snapshot), items: result.items, scope: galleryScope(api) };
        if (JSON.stringify(snapshot()) !== JSON.stringify(result.snapshot)) status.textContent = "前回成功した条件の検索結果";
        render(currentResult);
        void waitForModalPaint().then(() => { if (modal.overlay.isConnected) { list.scrollLeft = gridPosition.left; list.scrollTop = gridPosition.top; modal.dialog.scrollTop = gridPosition.modal; } });
    } else if (!cached) void load();
    return modal;
}
export async function openLLMSettings(api) {
    const modal = openModal("LLM接続設定"), form = element("form"), status = element("p", "読み込み中…");
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
        await waitForModalPaint();
        if (!modal.overlay.isConnected) return modal;
        const settings = await requestJSON(api, "/scene_prompt/llm/settings");
        if (!modal.overlay.isConnected) return modal;
        status.textContent = "";
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
