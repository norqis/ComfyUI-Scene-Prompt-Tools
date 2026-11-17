import { requestJSON, identity, value, applyCandidate, captureTarget } from "./scene_prompt_llm.js";
import { SCENE_MODEL_MODES } from "./scene_prompt_state.js";

let settingsModalID = 0;
const SORTS = ["Relevancy", "Highest Rated", "Most Downloaded", "Most Liked", "Most Collected", "Newest"];
const IMAGE_METADATA_KEYS = ["width", "height", "createdAt", "seed", "sampler", "steps", "cfgScale"];
function imageMetadata(...sources) {
    return Object.fromEntries(IMAGE_METADATA_KEYS.flatMap(key => { const value = sources.find(source => source?.[key] != null)?.[key]; return value != null && typeof value !== "object" ? [[key, value]] : []; }));
}
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
export function openModal(title, onDismiss, focus = document.activeElement, parent = modals.at(-1)) {
    const overlay = element("div", undefined, "pc-lora-overlay");
    const dialog = element("div", undefined, "pc-lora-dialog pc-civitai-dialog");
    dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true");
    const head = element("div", undefined, "pc-lora-head"), heading = element("strong"), close = element("button", "閉じる", "pc-button");
    head.append(heading, close); dialog.append(head); overlay.append(dialog); document.body.append(overlay);
    const modal = { overlay, dialog, head, close, dismiss, parent, busy: false,
        setBusy(value) { this.busy = !!value; dialog.inert = this.busy; close.disabled = this.busy; dialog.setAttribute("aria-busy", String(this.busy)); },
        setTitle(text) { heading.textContent = text; dialog.setAttribute("aria-label", text); } };
    modal.setTitle(title);
    modals.push(modal);
    function updateInert() { for (const entry of modals) entry.overlay.inert = entry !== modals.at(-1); }
    updateInert();
    let closed = false;
    function dismiss() {
        const index = modals.indexOf(modal);
        const descendant = entry => { for (let current = entry; current; current = current.parent) if (current === modal) return true; return false; };
        if (closed || modals.some(entry => descendant(entry) && entry.busy)) return;
        const wasTop = modals.at(-1) === modal;
        closed = true;
        const children = modals.filter(entry => entry !== modal && descendant(entry)).reverse();
        modals.splice(index, 1);
        onDismiss?.();
        for (const child of children) child.dismiss();
        document.removeEventListener("keydown", onKey); overlay.remove();
        updateInert();
        if (wasTop && focus?.isConnected) focus.focus?.();
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
export function openCivitaiAuth({ api, host = "civitai.red", onAuthenticated, onStatusChanged }) {
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
            key.value = ""; show(data); onStatusChanged?.(data);
            if (!removing) { onAuthenticated?.(data); modal.dismiss(); }
        } catch (error) { if (current(requestedSerial)) status.textContent = error.message; }
        finally { busy = false; authenticate.disabled = false; clear.disabled = false; }
    }
    form.onsubmit = event => { event.preventDefault(); void submit(false); };
    clear.onclick = () => void submit(true);
    key.focus(); return modal;
}
function showCivitaiRequestError(error, { api, host, query, retry, isCurrent, onStatusChanged, retryLabel = "再取得", title = "取得に失敗しました" }) {
    const modal = openModal(title), status = element("p", error.message, "pc-civitai-error"), again = element("button", "再試行", "pc-button");
    modal.dialog.append(element("p", `検索・説明: ${query || "—"}`), status, again);
    again.onclick = () => { modal.dismiss(); if (isCurrent()) void retry(); };
    if (error.status === 401 && error.code !== "civitai_download_disabled") {
        again.hidden = true;
        const auth = element("button", "認証", "pc-button");
        auth.onclick = () => {
            if (!isCurrent()) return;
            openCivitaiAuth({ api, host, onStatusChanged: data => { if (isCurrent() && modal.overlay.isConnected) onStatusChanged?.(data); }, onAuthenticated: () => {
                if (!isCurrent() || !modal.overlay.isConnected) return;
                status.textContent = `認証しました。${retryLabel}してください。`; again.textContent = retryLabel; again.hidden = false;
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
    const flatMeta = preview.meta || {}, nestedMeta = flatMeta.meta && typeof flatMeta.meta === "object" ? flatMeta.meta : {};
    let meta = flatMeta;
    if (meta.meta && typeof meta.meta === "object") meta = { ...meta, ...meta.meta };
    const resources = meta.resources || meta.civitaiResources || [];
    return { resources: Array.isArray(resources) ? resources.filter(resource => resource && typeof resource === "object").map(resource => {
        const model = resource.model || {}, modelID = model.id || resource.modelId, versionID = resource.modelVersionId ?? resource.id;
        return { name: model.name || resource.name, version_name: model.name ? resource.name : "", type: model.type || resource.type,
            strength: resource.strength ?? resource.weight,
            ...(Number.isSafeInteger(modelID) && modelID > 0 ? { url: `https://${host}/models/${modelID}${Number.isSafeInteger(versionID) && versionID > 0 ? `?modelVersionId=${versionID}` : ""}` } : {}) };
    }) : [], prompt: meta.prompt ?? meta.positive,
        negative_prompt: meta.negativePrompt ?? meta.negative_prompt ?? meta.negative, tags: meta.tags ?? meta.tag,
        other: imageMetadata(nestedMeta, flatMeta, preview) };
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
            } else if (heading === "TAG") {
                const tags = typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(tag => typeof tag === "string" ? [tag] : tag && typeof tag.name === "string" ? [tag.name] : []) : [];
                const chips = element("div", undefined, "pc-civitai-tags");
                for (const tag of tags) chips.append(element("span", tag, "pc-civitai-tag"));
                section.append(tags.length ? chips : element("p", "公開情報なし"));
            } else if (["PROMPT", "NEGATIVE PROMPT"].includes(heading)) { const pre = element("pre", undefined, "pc-civitai-prompt"), code = element("code", displayValue(value)); pre.append(code); section.append(pre); }
            else section.append(element("p", "公開情報なし"));
            information.append(section);
        }
        information.append(element("h3", "OTHER METADATA"));
        const entries = Object.entries(imageMetadata(data.other));
        if (!entries.length) information.append(element("p", "公開情報なし"));
        for (const [key, value] of entries) information.append(element("p", `${key}: ${displayValue(value)}`));
    }
    render(imageInformation(preview, host));
    const status = element("p");
    async function load() {
        status.replaceChildren(document.createTextNode("読み込み中…")); information.prepend(status);
        try {
            const data = await requestJSON(api, `/scene_prompt/civitai/image?${new URLSearchParams({ image_id: preview.id, host })}`, undefined, { signal: request.signal });
            if (!request.signal.aborted) render(data);
        } catch (error) {
            if (request.signal.aborted) return;
            status.textContent = `生成情報を取得できませんでした。 ${error.message}`;
            if (error.status === 401) showCivitaiRequestError(error, { api, host, query: "画像の生成情報", retryLabel: "再試行", retry: load, isCurrent: () => !request.signal.aborted });
            else { const retry = element("button", "再試行", "pc-button"); retry.onclick = () => { status.remove(); void load(); }; status.append(retry); }
        }
    }
    if (preview.id) void load();
    return modal;
}
function openCivitaiDownload({ api, item, isCurrent, acquire, onStale }) {
    const controller = new AbortController();
    const modal = openModal("LoRAを取得", () => controller.abort());
    const label = element("label", "保存先", "pc-civitai-directory-label"), combo = element("div", undefined, "pc-civitai-directory"), input = element("input"),
        toggle = element("button", "▼", "pc-button"), list = element("div", undefined, "pc-civitai-directory-list"), status = element("p", "保存先を読み込み中…"),
        actions = element("div", undefined, "pc-civitai-download-actions"), download = element("button", "取得", "pc-button"), select = element("button", "取得して選択", "pc-button");
    const path = String(item.lora_name || "").replaceAll("\\", "/");
    input.value = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : item.acquired ? "" : "llm";
    input.setAttribute("role", "combobox"); input.setAttribute("aria-label", "保存先"); input.setAttribute("aria-expanded", "false"); input.setAttribute("aria-autocomplete", "list");
    list.id = `pc-civitai-directories-${++settingsModalID}`; list.setAttribute("role", "listbox"); list.hidden = true; input.setAttribute("aria-controls", list.id);
    toggle.setAttribute("aria-label", "保存先を選択");
    let directories = [], active = -1, busy = false;
    const current = () => modal.overlay.isConnected && isCurrent();
    function popup(show) { list.hidden = !show; input.setAttribute("aria-expanded", String(show)); }
    function highlight(index) {
        active = Math.max(0, Math.min(index, directories.length - 1));
        for (const [i, option] of [...list.children].entries()) option.setAttribute("aria-selected", String(i === active));
        const option = list.children[active]; if (option) { input.setAttribute("aria-activedescendant", option.id); option.scrollIntoView({ block: "nearest" }); }
    }
    function choose(index) { input.value = directories[index]; popup(false); input.focus(); }
    toggle.onclick = () => { popup(list.hidden); if (!list.hidden) highlight(Math.max(0, directories.indexOf(input.value))); input.focus(); };
    input.addEventListener("keydown", event => {
        if (event.key === "Escape" && !list.hidden) { event.preventDefault(); event.stopImmediatePropagation(); popup(false); }
        else if (["ArrowDown", "ArrowUp"].includes(event.key) && directories.length) { event.preventDefault(); popup(true); highlight(active + (event.key === "ArrowDown" ? 1 : -1)); }
        else if (event.key === "Enter" && !list.hidden && active >= 0) { event.preventDefault(); choose(active); }
    });
    input.addEventListener("input", () => { active = -1; input.removeAttribute("aria-activedescendant"); });
    async function load() {
        status.textContent = "保存先を読み込み中…";
        try {
            const data = await requestJSON(api, "/scene_prompt/civitai/directories", undefined, { signal: controller.signal });
            if (!current()) return;
            directories = data.directories; list.replaceChildren();
            const lastChild = new Map();
            for (const path of directories) if (path) lastChild.set(path.split("/").slice(0, -1).join("/"), path);
            for (const [index, path] of directories.entries()) {
                const option = element("div", undefined, "pc-civitai-directory-option"); option.setAttribute("role", "option"); option.setAttribute("aria-label", path || "ルート"); option.id = `${list.id}-${index}`;
                if (!path) option.textContent = "ルート";
                else {
                    const parts = path.split("/"), prefix = parts.slice(0, -1).map((_, depth) => {
                        const parent = parts.slice(0, depth).join("/"), branch = parts.slice(0, depth + 1).join("/");
                        return lastChild.get(parent) !== branch ? "│  " : "   ";
                    }).join("");
                    const parent = parts.slice(0, -1).join("/");
                    option.textContent = `${prefix}${lastChild.get(parent) === path ? "└─ " : "├─ "}${parts.at(-1)}`;
                }
                option.onclick = () => choose(index); list.append(option);
            }
            status.textContent = "空欄はLoRAフォルダ直下。新しい保存先も入力できます。";
        } catch (error) { if (current()) { status.replaceChildren(element("span", error.message)); const retry = element("button", "再試行", "pc-button"); retry.onclick = () => void load(); status.append(retry); } }
    }
    const progress = element("progress"), transferred = element("p", "", "pc-civitai-download-progress");
    progress.hidden = transferred.hidden = true;
    function updateProgress({ received, total }) {
        if (!Number.isSafeInteger(received) || received < 0) return;
        progress.hidden = transferred.hidden = false;
        const bytes = number => `${new Intl.NumberFormat("en-US").format(number)} bytes`;
        if (Number.isSafeInteger(total) && total >= 0) {
            progress.max = total || 1; progress.value = total ? Math.min(received, total) : 1;
            transferred.textContent = received >= total ? "100% · 確認・保存中…" : `${Math.floor(received / total * 100)}% · ${bytes(received)} / ${bytes(total)}`;
        } else { progress.removeAttribute("value"); transferred.textContent = `${bytes(received)} 取得済み`; }
    }
    async function run(apply, directory = input.value, existingAction = "ask", existingName = "") {
        if (busy || !current()) return;
        popup(false); busy = true; modal.setBusy(true);
        download.disabled = select.disabled = input.disabled = toggle.disabled = true; status.textContent = "取得中…";
        let failure, acquired;
        updateProgress({ received: 0, total: null });
        try { acquired = await acquire({ apply, directory, existingAction, existingName, isCurrent: current, onProgress: updateProgress }); }
        catch (error) { failure = error; }
        finally {
            busy = false; modal.setBusy(false);
            download.disabled = select.disabled = input.disabled = toggle.disabled = false;
        }
        if (!current() || acquired === false) { modal.dismiss(); onStale?.(); return; }
        if (failure?.code === "civitai_file_exists" && failure.existing_name) {
            status.textContent = "同名ファイルが存在します。操作を選択してください。"; progress.hidden = transferred.hidden = true;
            const confirmation = openModal("既に存在します。再取得しますか？", undefined, modal.close, modal);
            confirmation.dialog.append(element("p", failure.existing_name));
            const actions = element("div", undefined, "pc-civitai-download-actions");
            for (const [label, action, shouldApply] of [["キャンセル", null, false], ["選択のみ", "select", true], ["再取得", "replace", apply]]) {
                const button = element("button", label, "pc-button");
                button.onclick = () => { confirmation.dismiss(); if (action && current()) void run(shouldApply, directory, action, failure.existing_name); };
                actions.append(button);
            }
            confirmation.dialog.append(actions);
        }
        else if (failure) showCivitaiRequestError(failure, { api, host: item.downloadHost, query: item.name, retry: () => run(apply, directory, existingAction, existingName), isCurrent: current });
        else modal.dismiss();
    }
    download.onclick = () => void run(false); select.onclick = () => void run(true);
    combo.append(input, toggle, list); label.append(combo); actions.append(download, select); modal.dialog.append(label, status, progress, transferred, actions); input.focus(); void load(); return modal;
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
            if (error.status === 401) showCivitaiRequestError(error, { api, host, query: item.name, retryLabel: "再試行", retry: () => loadGallery(nextCursor), isCurrent });
        } finally { busy = false; more.disabled = false; }
    }
    previous.onclick = () => { offset -= 2; renderImages(); }; next.onclick = () => { offset += 2; renderImages(); };
    more.onclick = () => void loadGallery(cursor);
    pages.append(previous, page, next, more); container.append(images, pages, galleryStatus); renderImages();
    if (!gallery.length) void loadGallery();
    const metadata = element("dl", undefined, "pc-civitai-metadata");
    function field(label, content) {
        const body = element("dd");
        if (content instanceof Node) body.append(content);
        else body.textContent = displayValue(content);
        metadata.append(element("dt", label), body);
    }
    function stats(data) { return Object.entries({ downloadCount: "Downloads", thumbsUpCount: "Likes", favoriteCount: "Favorites", collectedCount: "Collected", rating: "Rating", ratingCount: "Ratings", commentCount: "Comments", tippedAmountCount: "Tips" }).filter(([key]) => data?.[key] != null).map(([key, label]) => `${label}: ${data[key]}`).join(" · "); }
    field("AUTHOR", item.creator_name); field("UPDATED", item.updated_at);
    field("BASE MODEL", item.base_model); field("TRIGGER WORDS", (item.triggers || []).join(", "));
    for (const [label, html] of [["DESCRIPTION", item.description], ["VERSION DESCRIPTION", item.version_description]]) {
        const description = renderCivitaiDescription(html);
        field(label, description.textContent.trim() ? description : "");
    }
    field("PUBLISHED", item.published_at); field("MODEL STATS", stats(item.model_stats || item.stats)); field("VERSION STATS", stats(item.version_stats));
    if (item.file_name) field("FILE", `${item.file_name} · ${Number(item.size_kb || 0).toLocaleString()} KB`);
    container.append(metadata);
    const actions = element("div", undefined, "pc-civitai-detail-actions"), source = element("a", "公式サイトを開く");
    source.href = `https://${host}/models/${item.model_id}?modelVersionId=${item.version_id}`; source.target = "_blank"; source.rel = "noopener noreferrer";
    if (onChoose) {
        const choose = element("button", "取得", "pc-button");
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
            if (error.status === 401) showCivitaiRequestError(error, { api, host, query: "モデルの詳細", retryLabel: "再試行", retry: load, isCurrent: () => !request.signal.aborted });
        }
    }
    void load(); return modal;
}
export function openCivitaiSearch({ node, api, refresh, onAcquired, activeGraph = () => node.graph,
    beginChange = (graph) => graph.beforeChange?.(), endChange = (graph) => graph.afterChange?.() }) {
    const cached = searchViews.get(node), state = cached?.draft || node.properties?.scene_civitai || {};
    const generation = ++searchViewGeneration;
    searchViews.set(node, { ...cached, generation });
    let authRevision = 0, authRequest, gate = "checking";
    let revision = 0, detailRevision = 0, currentResult = null, downloadBusy = false, searchRequest, optionsRequest;
    const hostOptions = new Map(Object.entries(cached?.hostOptions || {}));
    let gridPosition = cached?.gridPosition || { left: 0, top: 0, modal: 0 };
    function saveView() {
        if (searchViews.get(node)?.generation !== generation) return;
        const result = currentResult ? structuredClone({ snapshot: currentResult.snapshot,
            items: currentResult.items.map(item => ({ ...item, gallery: (item.gallery || []).map(({ id, url, width, height, createdAt }) => ({ id, url, width, height, createdAt })) })) }) : null;
        searchViews.set(node, { generation, draft: snapshot(), lastSuccessfulResult: result, gridPosition: { ...gridPosition }, hostOptions: structuredClone(Object.fromEntries(hostOptions)) });
    }
    const modal = openModal("Civitai Search", () => {
        revision++; detailRevision++;
        if (!list.hidden) gridPosition = { left: list.scrollLeft, top: list.scrollTop, modal: modal.dialog.scrollTop };
        saveView(); authRevision++; authRequest?.abort(); searchRequest?.abort(); optionsRequest?.abort(); currentResult?.scope.close(); observer.disconnect(); currentResult = null;
        list.replaceChildren(); detail.replaceChildren();
        if (!modals.some(entry => entry.ownerNode === node)) node.sceneCivitaiSearchCleanup = null;
    }, document.activeElement, null);
    modal.ownerNode = node;
    node.sceneCivitaiSearchCleanup = () => { for (const entry of modals.filter(entry => entry.ownerNode === node).reverse()) entry.dismiss(); };
    modal.dialog.classList.add("pc-civitai-search-dialog");
    const authentication = element("button", "認証", "pc-button"); authentication.onclick = () => openCivitaiAuth({ api, host: host.value, onStatusChanged: authenticationChanged });
    const headActions = element("div", undefined, "pc-lora-head-actions"); headActions.append(authentication, modal.close); modal.head.append(headActions);
    const controls = element("div", undefined, "pc-civitai-controls"), query = element("input"), sort = element("select"), model = element("select"), host = element("select"), modelType = element("select"), category = element("select");
    query.type = "search"; query.value = state.query || ""; query.placeholder = "モデルを検索"; query.setAttribute("aria-label", "検索語");
    function options(select, label, names, selected) { select.replaceChildren(); select.setAttribute("aria-label", label); for (const name of names) { const option = element("option", name); option.value = name; select.append(option); } select.value = names.includes(selected) ? selected : names[0]; }
    options(sort, "並び順", SORTS, state.sort || "Most Downloaded"); options(model, "Base Model", SCENE_MODEL_MODES, value(node, "model_mode")); options(host, "接続先", ["civitai.red", "civitai.com"], state.host);
    const allModels = element("option", "All"); allModels.value = ""; model.prepend(allModels);
    if (state.model_mode !== undefined) model.value = state.model_mode;
    options(modelType, "Model Type", [state.model_type || "LORA"], state.model_type || "LORA");
    if (modelType.options[0].value === "LORA") modelType.options[0].textContent = "LoRA";
    function setCategories(names, selected = category.value, authoritative = false) {
        if (authoritative && !names.includes(selected)) selected = "";
        options(category, "Category", ["", ...new Set([...names, ...(selected ? [selected] : [])])], selected);
        category.options[0].textContent = "Category";
    }
    setCategories([], state.category || "");
    let optionsReady;
    function loadOptions(retry = false) {
        const selectedHost = host.value;
        if (selectedHost === "civitai.red" && gate !== "configured") return Promise.resolve(false);
        if (!retry && optionsReady?.host === selectedHost && !optionsReady.request.signal.aborted) return optionsReady.promise;
        optionsRequest?.abort(); const request = new AbortController(); optionsRequest = request;
        const operation = { host: selectedHost, request }; optionsReady = operation;
        operation.promise = (async () => {
            try {
                let data = hostOptions.get(selectedHost);
                if (!data) {
                    data = await requestJSON(api, `/scene_prompt/civitai/options?${new URLSearchParams({ host: selectedHost })}`, undefined, { signal: request.signal });
                    if (request.signal.aborted || optionsRequest !== request || !gateCurrent() || selectedHost !== host.value) return false;
                    hostOptions.set(selectedHost, data);
                }
                if (!gateCurrent() || selectedHost !== host.value) return false;
                options(modelType, "Model Type", data.model_types, modelType.value);
                for (const option of modelType.options) if (option.value === "LORA") option.textContent = "LoRA";
                const categories = data.categories || [];
                setCategories(categories, category.value, Boolean(categories.length || selectedHost !== "civitai.red" || gate === "configured"));
                if (currentResult) {
                    if (JSON.stringify(snapshot()) !== JSON.stringify(currentResult.snapshot)) status.textContent = "前回成功した条件の検索結果";
                    else if (status.textContent === "前回成功した条件の検索結果") status.textContent = "";
                }
                return true;
            } catch (error) {
                if (!request.signal.aborted && selectedHost === host.value && gateCurrent()) {
                    if (error.status === 401) showCivitaiRequestError(error, { api, host: selectedHost, query: "Civitai options", retryLabel: "再試行", retry: () => void loadOptions(true), onStatusChanged: authenticationChanged, isCurrent: () => gateCurrent() && selectedHost === host.value });
                    else showAPIError(error, "Civitai options", () => void loadOptions(true));
                }
                return false;
            }
        })();
        return operation.promise;
    }
    const search = element("button", "検索", "pc-button"), status = element("p", "", "pc-civitai-status"), list = element("div", undefined, "pc-civitai-results"), detail = element("div", undefined, "pc-civitai-detail");
    status.setAttribute("role", "status"); detail.hidden = true;
    controls.append(query, host, model, modelType, category, sort, search); modal.dialog.append(controls, status, list, detail);
    const snapshot = () => Object.freeze({ query: query.value.trim(), sort: sort.value, host: host.value, model_mode: model.value, model_type: modelType.value, category: category.value.trim() });
    const authNotice = element("p", undefined, "pc-civitai-status"); controls.after(authNotice);
    const gateCurrent = () => modal.overlay.isConnected && searchViews.get(node)?.generation === generation;
    function setGate(next) {
        const wasBlocked = gate !== "configured";
        gate = next; const blocked = host.value === "civitai.red" && gate !== "configured";
        search.disabled = blocked;
        authNotice.replaceChildren();
        if (!blocked) { if (detail.hidden) list.hidden = false; if (wasBlocked && currentResult) { currentResult.serial = revision; currentResult.scope = galleryScope(api); render(currentResult); } return; }
        revision++; detailRevision++; searchRequest?.abort(); currentResult?.scope.close(); observer.disconnect();
        controls.hidden = false; status.hidden = false; list.hidden = true; detail.hidden = true; detail.replaceChildren(); modal.setTitle("Civitai Search");
        if (gate === "missing") authNotice.textContent = 'civitai.redで検索するには認証が必要です。右上の「認証」からAPIキーを登録してください。';
        else if (gate === "checking") authNotice.textContent = "認証状態を確認中…";
        else { authNotice.append(element("span", "認証状態を確認できませんでした。")); const retry = element("button", "再試行", "pc-button"); retry.onclick = () => void checkGate(); authNotice.append(retry); }
    }
    function authenticationChanged(data) {
        if (!gateCurrent()) return;
        authRevision++; authRequest?.abort(); revision++; detailRevision++; searchRequest?.abort(); optionsRequest?.abort();
        currentResult?.scope.close(); observer.disconnect(); currentResult = null; hostOptions.clear();
        list.replaceChildren(); detail.replaceChildren(); detail.hidden = true; controls.hidden = false; status.hidden = false; status.textContent = ""; modal.setTitle("Civitai Search");
        setGate(host.value === "civitai.red" && !data.configured ? "missing" : "configured");
        saveView(); if (gate === "configured") void loadOptions();
    }
    async function checkGate(afterCheck) {
        const serial = ++authRevision, selectedHost = host.value; authRequest?.abort(); authRequest = new AbortController();
        if (selectedHost !== "civitai.red") { setGate("configured"); if (await loadOptions() && serial === authRevision && selectedHost === host.value) afterCheck?.(); return; }
        setGate("checking");
        try {
            const data = await requestJSON(api, "/scene_prompt/civitai/auth", undefined, { signal: authRequest.signal, cache: "no-store" });
            if (!gateCurrent() || serial !== authRevision || host.value !== selectedHost) return;
            setGate(data.configured ? "configured" : "missing"); if (data.configured && await loadOptions() && serial === authRevision && selectedHost === host.value) afterCheck?.();
        } catch (error) { if (gateCurrent() && serial === authRevision && host.value === selectedHost) setGate("error"); }
    }
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
            }).catch(error => { if (currentResult === view && view.serial === revision && card.isConnected) card.querySelector(".pc-civitai-no-preview").textContent = error.status === 401 ? "画像の取得には認証が必要です。右上の認証から登録してください。" : "画像を取得できませんでした。クリックして再試行"; });
        }
    }, { root: list });
    function back(view, card, position) {
        detailRevision++; detail.replaceChildren(); detail.hidden = true; controls.hidden = false; list.hidden = false; status.hidden = false; modal.setTitle("Civitai Search");
        if (currentResult !== view) return;
        updateSelection(view);
        list.scrollLeft = position.left; list.scrollTop = position.top; modal.dialog.scrollTop = position.modal; card.focus({ preventScroll: true });
    }
    function showDetails(item, view, card) {
        if (currentResult !== view || view.serial !== revision) return;
        const position = { left: list.scrollLeft, top: list.scrollTop, modal: modal.dialog.scrollTop }, serial = ++detailRevision;
        gridPosition = position;
        controls.hidden = true; list.hidden = true; status.hidden = true; detail.hidden = false; modal.setTitle("Civitai Detail");
        const ownsAction = () => searchViews.get(node)?.generation === generation && modal.overlay.isConnected && currentResult === view && revision === view.serial && detailRevision === serial;
        renderCivitaiDetail({ modal, container: detail, item, host: view.snapshot.host, scope: view.scope, api, onBack: () => back(view, card, position), isCurrent: ownsAction,
            onChoose: item.installable === false ? null : () => {
                openCivitaiDownload({ api, item: { ...item, downloadHost: view.snapshot.host }, isCurrent: ownsAction, onStale: () => modal.dismiss(),
                    acquire: async ({ apply, directory, existingAction, existingName, isCurrent, onProgress }) => {
                        if (downloadBusy) return false;
                        const graph = node.graph, lora = value(node, "lora_name"), current = captureTarget({ node, graph, ownerGraph: graph }, activeGraph);
                        downloadBusy = true;
                        try {
                            const applyMode = item.apply_model_mode || view.snapshot.model_mode;
                            const downloadID = crypto.randomUUID();
                            const listener = event => { if (event.detail?.download_id === downloadID && isCurrent()) onProgress(event.detail); };
                            api.addEventListener("scene_prompt_civitai_download_progress", listener);
                            let downloaded;
                            try {
                                downloaded = await requestJSON(api, "/scene_prompt/civitai/download", { model_id: item.model_id, version_id: item.version_id, file_id: item.file_id, model_mode: applyMode, host: view.snapshot.host, directory, existing_action: existingAction, existing_name: existingName, client_id: api.clientId || "", download_id: downloadID });
                            } finally { api.removeEventListener("scene_prompt_civitai_download_progress", listener); }
                            if (!isCurrent() || !current() || value(node, "lora_name") !== lora) return false;
                            if (!downloaded.lora_name || !downloaded.candidate && existingAction !== "select") throw new Error("Civitai取得結果が無効です。");
                            if (downloaded.candidate) { item.acquired = true; item.lora_name = downloaded.lora_name; }
                            await onAcquired?.(node, downloaded, () => isCurrent() && current() && value(node, "lora_name") === lora);
                            if (!isCurrent() || !current() || value(node, "lora_name") !== lora) return false;
                            const loraWidget = node.widgets.find(widget => widget.name === "lora_name");
                            const pathIdentity = path => String(path).replaceAll("\\", "/");
                            const nativeName = (loraWidget?.options?.values || []).find(name => pathIdentity(name) === pathIdentity(downloaded.lora_name)) || downloaded.lora_name;
                            if (apply) {
                                beginChange(graph); try {
                                    if (downloaded.candidate) applyCandidate(node, { ...downloaded.candidate, lora_name: nativeName }, { ...view.snapshot, model_mode: applyMode, injectTriggers: false });
                                    else loraWidget.value = nativeName;
                                } finally { endChange(graph); }
                                updateSelection(view);
                                refresh?.(node);
                            }
                            return true;
                        } catch (error) {
                            if (!isCurrent() || !current() || value(node, "lora_name") !== lora) return false;
                            throw error;
                        } finally { downloadBusy = false; }
                    } });
            } });
    }
    function observeMissingPreviews() { for (const card of list.querySelectorAll(".pc-civitai-card")) if (!currentResult.items[Number(card.dataset.index)].image_url) observer.observe(card); }
    function updateSelection(view) {
        const path = name => String(name || "").replaceAll("\\", "/");
        const selectedPath = path(value(node, "lora_name")), saved = node.properties?.scene_civitai;
        const selected = selectedPath && path(saved?.lora_name) === selectedPath ? saved : null;
        for (const card of list.querySelectorAll(".pc-civitai-card")) {
            const item = view.items[Number(card.dataset.index)];
            card.classList.toggle("pc-lora-selected", Boolean(selected && identity(item) === identity(selected) || selectedPath && item.acquired && path(item.lora_name) === selectedPath));
        }
    }
    function render(view) {
        list.replaceChildren(); list.inert = false; observer.disconnect();
        const saved = node.properties?.scene_civitai;
        const selected = saved?.lora_name && saved.lora_name.replaceAll("\\", "/") === String(value(node, "lora_name")).replaceAll("\\", "/") ? saved : null;
        if (!view.items.length) { list.append(element("p", "該当するモデルはありません。")); return; }
        const selectedLabel = selected?.name || selected?.lora_name;
        if (selectedLabel && [selected.model_id, selected.version_id, selected.file_id].every((id) => Number.isSafeInteger(Number(id)) && Number(id) > 0) && !view.items.some(item => identity(item) === identity(selected))) status.textContent = `現在の選択（検索結果外）: ${selectedLabel}${selected.version_name ? ` · ${selected.version_name}` : ""}`;
        for (const [index, item] of view.items.entries()) {
            const card = element("article", undefined, "pc-civitai-card");
            card.setAttribute("role", "button"); card.tabIndex = 0; card.dataset.identity = identity(item); card.dataset.index = index; card.setAttribute("aria-label", `${item.name} ${item.version_name || ""} の詳細`);
            const preview = element("div", undefined, "pc-civitai-card-preview");
            if (item.image_url) { const image = element("img"); image.src = item.image_url; image.loading = "lazy"; image.alt = ""; preview.append(image); }
            else preview.append(element("div", "読み込み待ち…", "pc-civitai-no-preview"));
            const title = element("strong", item.name || "—", "pc-civitai-card-title"); title.title = item.name || "—";
            const base = element("span", item.base_model || "—", "pc-civitai-card-base"); base.title = item.base_model || "—";
            preview.append(base); card.append(preview, title, element("span", item.version_name || "—", "pc-civitai-card-version"));
            const footer = element("div", undefined, "pc-civitai-card-footer"), summary = element("div", undefined, "pc-civitai-card-summary"), metrics = element("span", undefined, "pc-civitai-card-stats"), author = element("span", item.creator_name || "—", "pc-civitai-card-author");
            author.title = item.creator_name || "—";
            const updatedDate = item.updated_at ? new Date(item.updated_at) : null;
            const updated = element("span", `Updated: ${updatedDate && Number.isFinite(updatedDate.getTime()) ? updatedDate.toLocaleDateString("ja-JP") : "—"}`, "pc-civitai-card-updated");
            if (item.updated_at) updated.title = item.updated_at;
            summary.append(updated, metrics);
            const compact = number => typeof number === "number" && Number.isFinite(number) && number >= 0 ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(number) : "—";
            for (const [key, label, icon] of [["downloadCount", "Downloads", "⇩"], ["collectedCount", "Bookmarks", "🔖"], ["thumbsUpCount", "Likes", "👍"]]) {
                const text = compact(item.model_stats?.[key]), group = element("span"), symbol = element("span", icon);
                group.title = `${label}: ${text}`; group.setAttribute("aria-label", `${label}: ${text}`); symbol.setAttribute("aria-hidden", "true"); group.append(symbol, document.createTextNode(` ${text}`)); metrics.append(group);
            }
            footer.append(author, summary); card.append(footer);
            card.onclick = () => showDetails(item, view, card); card.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); showDetails(item, view, card); } }; list.append(card);
            if (!item.image_url) observer.observe(card);
        }
        updateSelection(view);
    }
    let searchIntent = 0;
    async function load(requested) {
        const intent = ++searchIntent, selectedHost = host.value, authSerial = authRevision;
        searchRequest?.abort(); list.inert = false;
        if (currentResult) { currentResult.serial = revision; observeMissingPreviews(); }
        if (!await loadOptions() || intent !== searchIntent || !gateCurrent() || selectedHost !== host.value || authSerial !== authRevision) return;
        const categories = hostOptions.get(selectedHost)?.categories || [];
        setCategories(categories, category.value, Boolean(categories.length || selectedHost !== "civitai.red" || gate === "configured"));
        requested ??= snapshot();
        if (!gateCurrent() || (requested.host === "civitai.red" && gate !== "configured")) return;
        const serial = ++revision; detailRevision++; searchRequest = new AbortController();
        const ownsSearch = () => gateCurrent() && intent === searchIntent && selectedHost === host.value && authSerial === authRevision && serial === revision;
        detail.replaceChildren(); detail.hidden = true; controls.hidden = false; list.hidden = false; status.hidden = false; modal.setTitle("Civitai Search"); status.textContent = "検索中…"; list.inert = true;
        try {
            const result = await requestJSON(api, `/scene_prompt/civitai/search?${new URLSearchParams(requested)}`, undefined, { signal: searchRequest.signal });
            if (!ownsSearch()) return;
            if (!Array.isArray(result.items)) throw new Error("API /scene_prompt/civitai/search · HTTP 200: 無効な検索応答です。");
            currentResult?.scope.close(); observer.disconnect();
            currentResult = { serial, snapshot: requested, items: result.items, scope: galleryScope(api) }; status.textContent = ""; render(currentResult); saveView();
        } catch (error) {
            if (ownsSearch()) {
                status.textContent = currentResult ? "検索できませんでした。前の検索結果を表示しています。" : "検索できませんでした。";
                if (currentResult) { currentResult.serial = serial; list.inert = false; observeMissingPreviews(); }
                if (error.status === 401) {
                    setGate(requested.host === "civitai.red" ? "missing" : "configured"); let failedRevision = revision;
                    showCivitaiRequestError(error, { api, host: requested.host, query: requested.query, title: "検索に失敗しました", onStatusChanged: data => { authenticationChanged(data); failedRevision = revision; }, retryLabel: "再検索", retry: () => { setGate("configured"); void load(requested); }, isCurrent: () => gateCurrent() && intent === searchIntent && selectedHost === host.value && failedRevision === revision });
                } else showAPIError(error, requested.query, () => { if (ownsSearch()) void load(requested); });
            }
        }
    }
    search.onclick = () => void load(); for (const select of [sort, model, modelType, category]) select.onchange = () => void load();
    host.onchange = () => { searchRequest?.abort(); list.inert = false; if (currentResult) currentResult.serial = revision; optionsRequest?.abort(); void checkGate(() => void load()); };
    query.onkeydown = event => { if (event.key === "Enter") void load(); };
    query.focus();
    if (cached?.lastSuccessfulResult) {
        const result = structuredClone(cached.lastSuccessfulResult);
        currentResult = { serial: revision, snapshot: Object.freeze(result.snapshot), items: result.items, scope: galleryScope(api) };
        if (JSON.stringify(snapshot()) !== JSON.stringify(result.snapshot)) status.textContent = "前回成功した条件の検索結果";
    }
    void checkGate(() => {
        if (currentResult) { void waitForModalPaint().then(() => { if (gateCurrent()) { list.scrollLeft = gridPosition.left; list.scrollTop = gridPosition.top; modal.dialog.scrollTop = gridPosition.modal; } }); }
        else if (!cached) void load();
    });
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
