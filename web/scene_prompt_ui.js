import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
    DEFAULT_SELECTED_JSON,
    MATRIX_DEFAULT_JSON,
    createMatrixLine,
    createMatrixState,
    createSelectionState,
    formatSceneExpandCounts,
    parseMatrixLine,
    parseMatrixState,
    parseSelectionState,
    serializeMatrixState,
    serializeSelectionState,
} from "./scene_prompt_state.js";

const PROMPT_NODE_NAMES = new Set(["ScenePrompt", "Scene Prompt"]);
const PROMPT_MATRIX_NODE_NAMES = new Set(["SceneMatrix", "Scene Matrix"]);
const SCENE_PATH_NODE_NAMES = new Set(["ScenePath", "Scene Path"]);
const SCENE_PROMPT_MERGE_NODE_NAMES = new Set(["ScenePromptMerge", "Scene Prompt Merge"]);
const SCENE_PROMPT_COUNTER_NODE_NAMES = new Set(["ScenePromptCounter", "Scene Prompt Count"]);
const SCENE_PROMPT_QUEUE_NODE_NAMES = new Set(["ScenePromptQueue", "Scene Prompt Queue"]);
const SCENE_EMPTY_LATENT_NODE_NAMES = new Set(["SceneEmptyLatent", "Scene Empty Latent"]);
const SCENE_PROMPT_EXPAND_NODE_NAMES = new Set(["ScenePromptExpand", "Scene Prompt Expand"]);
const SCENE_SAVE_IMAGE_NODE_NAMES = new Set(["SceneSaveImage", "Scene Save Image"]);
const SCENE_PRESET_INPUT_NODE_NAMES = new Set(["ScenePresetInput", "Scene Preset Input"]);
const SCENE_PRESET_OUTPUT_NODE_NAMES = new Set(["ScenePresetOutput", "Scene Preset Output"]);
const SCENE_PRESET_REFERENCE_NODE_NAMES = new Set(["ScenePresetReference", "Scene Preset Reference"]);
const SCENE_PLAN_NODE_CLASS_TYPES = new Set([
    "ScenePrompt",
    "SceneMatrix",
    "ScenePath",
    "ScenePromptMerge",
    "ScenePromptCounter",
    "ScenePromptQueue",
    "SceneEmptyLatent",
    "ScenePresetReference",
]);
const NODE_NAMES = new Set([
    ...PROMPT_NODE_NAMES,
    ...PROMPT_MATRIX_NODE_NAMES,
    ...SCENE_PATH_NODE_NAMES,
    ...SCENE_PROMPT_MERGE_NODE_NAMES,
    ...SCENE_PROMPT_COUNTER_NODE_NAMES,
    ...SCENE_PROMPT_QUEUE_NODE_NAMES,
    ...SCENE_EMPTY_LATENT_NODE_NAMES,
    ...SCENE_PROMPT_EXPAND_NODE_NAMES,
    ...SCENE_SAVE_IMAGE_NODE_NAMES,
    ...SCENE_PRESET_INPUT_NODE_NAMES,
    ...SCENE_PRESET_OUTPUT_NODE_NAMES,
    ...SCENE_PRESET_REFERENCE_NODE_NAMES,
]);
const POPUP_MIN_WIDTH = 420;
const POPUP_MIN_HEIGHT = 180;
const POPUP_DEFAULT_WIDTH = 560;
const POPUP_DEFAULT_HEIGHT = 620;
const SELECTED_LIST_MIN_HEIGHT = 28;
const CHIP_HEIGHT = 19;
const CHIP_GAP = 4;
const CHIP_LINE_GAP = 4;
const CHIP_TEXT_PAD_X = 6;
const SELECTED_LIST_WIDTH_GUARD = 12;
const SELECTED_LIST_HEIGHT_GUARD = 6;
const WIDGET_ROW_HEIGHT = 24;
const SCENE_PROMPT_QUEUE_INPUT_COUNT = 10;
const SCENE_PROMPT_SOCKET_TYPE = "SCENE_PROMPT";
const SCENE_PROMPT_QUEUE_INPUT_NAMES = new Set(Array.from(
    { length: SCENE_PROMPT_QUEUE_INPUT_COUNT },
    (_value, index) => `scene_prompt${index + 1}`,
));
const SCENE_PROMPT_MERGE_INPUT_NAMES = new Set(["scene_prompt1", "scene_prompt2"]);
const MATRIX_NODE_DEFAULT_WIDTH = 340;
const MATRIX_NODE_MIN_WIDTH = 320;
const MATRIX_SECTION_VISIBLE_ROWS = 12;
const SCENE_QUEUE_DISPLAY_PREVIEW_ROWS = 160;
const SCENE_DETAIL_MIN_SCALE = 0.98;
const SCENE_COMPACT_WIDGET_HEIGHT = 18;
const SCENE_NODE_AUTO_FIT_MAX_HEIGHT = 720;
const SCENE_WIDGET_CANVAS_MAX_PIXELS = 2500000;
const SCENE_SAVE_PREVIEW_LIMIT = 1;
const SCENE_QUEUE_GROUP_COLORS = [
    "#c9a4ff",
    "#ff7777",
    "#ff9b45",
    "#ffe36d",
    "#b9f56a",
    "#5ee58c",
    "#64b7ff",
    "#4269ff",
];
const SCENE_COUNT_MAX = 10000;
const PATH_MODE_DIRECTORY = "フォルダに分ける";
const PATH_MODE_APPEND = "前のフォルダ名に結合";
const SCENE_WIDGET_LABELS = {
    category: "カテゴリ",
    count: "生成回数",
    prompt_name: "ノード名",
    path_name: "ノード名",
    positive_base: "ポジティブ基本文",
    negative_base: "ネガティブ基本文",
    scene_prompt: "scene_prompt",
    matrix: "matrix",
    path_mode: "保存パスの扱い",
    current_index: "生成番号",
    run_id: "実行ID",
    seed_base: "シード基準",
    timestamp_dir: "タイムスタンプディレクトリ",
    prefix: "ファイル名プレフィックス",
    width: "width",
    height: "height",
    batch_size: "batch_size",
    scene_info: "メタ情報",
    images: "画像",
    path: "保存パス",
    preset_id: "Preset ID",
    preset_name: "表示名",
};
const SCENE_NODE_DISPLAY_NAMES = {
    ScenePrompt: "Scene Prompt",
    SceneMatrix: "Scene Matrix",
    ScenePath: "Scene Path",
    ScenePromptMerge: "Scene Prompt Merge",
    ScenePromptCounter: "Scene Prompt Count",
    ScenePromptQueue: "Scene Prompt Queue",
    SceneEmptyLatent: "Scene Empty Latent",
    ScenePromptExpand: "Scene Prompt Expand",
    SceneSaveImage: "Scene Save Image",
    ScenePresetInput: "Scene Preset Input",
    ScenePresetOutput: "Scene Preset Output",
    ScenePresetReference: "Scene Preset Reference",
};

let promptItems = null;
let savedPrompts = null;
let promptItemsPromise = null;
let savedPromptsPromise = null;
let promptItemsLatestPromise = null;
let savedPromptsLatestPromise = null;
let promptItemsRequestGeneration = 0;
let savedPromptsRequestGeneration = 0;
let activePopup = null;
let activePopupContext = null;
let sceneBatchRun = null;
const sceneBatchRunsById = new Map();
const sceneBatchPendingRuns = [];
const sceneBatchPendingReleases = new Map();
const sceneBatchDetachedRuns = new Map();
const sceneBatchTerminalEvents = new Map();
const SCENE_DETACHED_RETRY_MS = 30 * 1000;
const SCENE_DETACHED_MAX_RETRIES = 20;
let chipMeasureContext = null;
let sceneDownstreamRefreshTimer = null;
let sceneQueuePromptSyncPaused = 0;
let hideInternalDomWidgetsScheduled = false;
let hideInternalDomWidgetsTimerShort = null;
let hideInternalDomWidgetsTimerLong = null;
const sceneDownstreamRefreshSources = new Set();
const sceneTitleSyncNodes = new Set();
const sceneLoadedRefreshNodes = new Set();
let sceneLoadedRefreshTimer = null;
let sceneLastPromptValidationErrorKey = "";
let sceneLastPromptValidationErrorAt = 0;
let scenePresetDisplayGraphs = new Map();
let scenePresetList = null;
let scenePresetListErrors = [];
let scenePresetListRequestGeneration = 0;
let scenePresetListPromise = null;
let scenePresetListLatestPromise = null;
let scenePresetListCacheCurrent = false;
let scenePresetNotificationTimer = null;
const sceneRunHandlesByPromptId = new Map();
const sceneRunTerminalPromptIds = new Map();
const sceneRunHandleReconcileTimers = new Map();
const sceneRunReleaseStates = new Map();
const SCENE_RUN_TERMINAL_MAX = 256;
const SCENE_RUN_TERMINAL_RETENTION_MS = 10 * 60 * 1000;
let sceneRunTerminalOverflowUntil = 0;

const VISIBLE_INPUT_NAMES = new Set(["scene_prompt"]);
const INTERNAL_INPUT_NAMES = new Set([
    "prompt_name",
    "path_name",
    "positive_json",
    "negative_json",
    "matrix_json",
    "category_order",
    "seed",
    "current_index",
    "run_id",
    "seed_base",
    "randomize",
]);

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

import { injectStyle } from "./scene_prompt_style.js";

async function loadPromptItems(force = false) {
    if (promptItems && !force) {
        return promptItems;
    }
    if (!force && promptItemsPromise) {
        return promptItemsPromise;
    }
    const generation = ++promptItemsRequestGeneration;
    let request = null;
    const latest = () => promptItemsLatestPromise === request ? promptItems : promptItemsLatestPromise;
    request = (async () => {
        try {
            const response = await api.fetchApi(`/scene_prompt/items${force ? "?reload=1" : ""}`);
            if (generation !== promptItemsRequestGeneration) return latest();
            const data = await readApiJson(response, "候補データの読込に失敗しました");
            if (generation !== promptItemsRequestGeneration) return latest();
            if (!response.ok) throw new Error(data.error || "候補データの読込に失敗しました");
            if (!Array.isArray(data.items)) throw new Error("候補データの応答形式が不正です。");
            promptItems = data.items;
            return promptItems;
        } catch (error) {
            if (generation !== promptItemsRequestGeneration) return latest();
            console.error("[Scene Prompt] 候補データの読込に失敗しました", error);
            showSceneBatchError("候補データを読み込めませんでした。", error);
            throw error;
        }
    })();
    promptItemsPromise = request;
    promptItemsLatestPromise = request;
    try {
        return await request;
    } finally {
        if (promptItemsPromise === request) promptItemsPromise = null;
    }
}

async function loadSavedPrompts(force = false) {
    if (savedPrompts && !force) {
        return savedPrompts;
    }
    const generation = ++savedPromptsRequestGeneration;
    let request = null;
    const latest = () => savedPromptsLatestPromise === request ? savedPrompts : savedPromptsLatestPromise;
    request = (async () => {
        try {
            const response = await api.fetchApi(`/scene_prompt/saved_prompts${force ? "?reload=1" : ""}`);
            if (generation !== savedPromptsRequestGeneration) return latest();
            const data = await readApiJson(response, "保存済みプロンプトの読込に失敗しました");
            if (generation !== savedPromptsRequestGeneration) return latest();
            if (!response.ok) throw new Error(data.error || "保存済みプロンプトの読込に失敗しました");
            if (!Array.isArray(data.saved_prompts)) throw new Error("保存済みプロンプトの応答形式が不正です。");
            savedPrompts = data.saved_prompts;
            clearSceneSelectedListLayoutCaches();
            return savedPrompts;
        } catch (error) {
            if (generation !== savedPromptsRequestGeneration) return latest();
            console.error("[Scene Prompt] 保存済みプロンプトの読込に失敗しました", error);
            showSceneBatchError("保存済みプロンプトを読み込めませんでした。", error);
            throw error;
        }
    })();
    savedPromptsPromise = request;
    savedPromptsLatestPromise = request;
    try {
        return await request;
    } finally {
        if (savedPromptsPromise === request) savedPromptsPromise = null;
    }
}
function clearSceneSelectedListLayoutCaches() {
    for (const node of app.graph?._nodes || []) {
        if (node?.sceneSelectedListLayoutCache) {
            node.sceneSelectedListLayoutCache = null;
        }
        if (node?.sceneSelectedListPositiveRenderCache) {
            node.sceneSelectedListPositiveRenderCache = null;
        }
        if (node?.sceneSelectedListNegativeRenderCache) {
            node.sceneSelectedListNegativeRenderCache = null;
        }
    }
}

async function readApiJson(response, errorMessage) {
    const text = await response.text();
    if (!text.trim()) {
        return {};
    }
    try {
        return JSON.parse(text);
    } catch (error) {
        const detail = text.trim().slice(0, 180);
        if (response.status === 404 || response.status === 405) {
            throw new Error(`${errorMessage} APIが読み込まれていません。ComfyUIを再起動してください。(${response.status}: ${detail})`);
        }
        throw new Error(`${errorMessage} サーバー応答をJSONとして読めません。${detail || error.message}`);
    }
}

async function saveCurrentPrompt(name, description, items) {
    const generation = ++savedPromptsRequestGeneration;
    const response = await api.fetchApi("/scene_prompt/saved_prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, items }),
    });
    const data = await readApiJson(response, "プロンプトまとめの保存に失敗しました");
    if (!response.ok) {
        throw new Error(data.error || "プロンプトまとめの保存に失敗しました");
    }
    if (generation === savedPromptsRequestGeneration) {
        savedPrompts = Array.isArray(data.saved_prompts) ? data.saved_prompts : null;
    }
    clearSceneSelectedListLayoutCaches();
    return data.saved_prompt;
}

async function createPromptItem(payload) {
    const generation = ++promptItemsRequestGeneration;
    const response = await api.fetchApi("/scene_prompt/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    const data = await readApiJson(response, "プロンプト作成に失敗しました");
    if (!response.ok) {
        throw new Error(data.error || "プロンプト作成に失敗しました");
    }
    if (generation === promptItemsRequestGeneration) {
        promptItems = Array.isArray(data.items) ? data.items : null;
    }
    return data.item;
}

async function updatePromptItem(payload) {
    const generation = ++promptItemsRequestGeneration;
    const response = await api.fetchApi("/scene_prompt/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, mode: "update" }),
    });
    const data = await readApiJson(response, "プロンプト更新に失敗しました");
    if (!response.ok) {
        throw new Error(data.error || "プロンプト更新に失敗しました");
    }
    if (generation === promptItemsRequestGeneration) {
        promptItems = Array.isArray(data.items) ? data.items : null;
    }
    return data.item;
}

function findWidget(node, name) {
    return node?.widgets?.find((widget) => widget.name === name);
}

function setWidgetValue(node, name, value, options = {}) {
    if (!node) {
        return false;
    }
    const widget = findWidget(node, name);
    if (!widget) {
        return false;
    }
    const previousWidgetValue = widget.value;
    widget.value = value;
    node.widgets_values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    const widgetIndex = Array.isArray(node.widgets) ? node.widgets.indexOf(widget) : -1;
    const previousStoredValue = widgetIndex >= 0 ? node.widgets_values[widgetIndex] : undefined;
    if (widgetIndex >= 0) {
        node.widgets_values[widgetIndex] = value;
    }
    const changed = previousWidgetValue !== value || previousStoredValue !== value;
    if (changed && !options.silent) {
        notifyWidgetChanged(node, widget, value);
    }
    return changed;
}

function notifyWidgetChanged(node, widget, value) {
    try {
        widget?.callback?.(value, app.canvas, node, app.canvas?.graph_mouse);
    } catch (_error) {
        // Some Comfy widgets do not accept callback notifications.
    }
    try {
        node?.onWidgetChanged?.(widget?.name, value, value, widget);
    } catch (_error) {
    }
}

function normalizePathMode(value) {
    const text = String(value || "").trim();
    if (text === PATH_MODE_APPEND) {
        return PATH_MODE_APPEND;
    }
    return PATH_MODE_DIRECTORY;
}

function pathModeOptionLabel(value) {
    return normalizePathMode(value);
}

function widgetOptionValues(widget) {
    const values = widget?.options?.values;
    try {
        return typeof values === "function" ? values() : values;
    } catch (_error) {
        return [];
    }
}

function optionValuesInclude(widget, value) {
    const values = widgetOptionValues(widget);
    return Array.isArray(values) && values.map((item) => String(item)).includes(String(value));
}

function applyWidgetLabel(widget, label) {
    if (!widget || !label) {
        return;
    }
    widget.label = label;
    widget.options = widget.options || {};
    widget.options.display_name = label;
    widget.options.label = label;
}

function applySceneWidgetLabels(node) {
    for (const widget of node.widgets || []) {
        applyWidgetLabel(widget, SCENE_WIDGET_LABELS[widget?.name]);
    }

    const pathMode = findWidget(node, "path_mode");
    if (pathMode) {
        pathMode.options = pathMode.options || {};
        pathMode.options.getOptionLabel = pathModeOptionLabel;
        if (optionValuesInclude(pathMode, PATH_MODE_DIRECTORY)) {
            pathMode.value = normalizePathMode(pathMode.value);
        }
    }

}

function activeStateWidgetName(node) {
    return node?.sceneStateWidgetName || node?.sceneDefaultStateWidgetName || "positive_json";
}

function setActiveStateWidget(node, stateWidgetName) {
    node.sceneStateWidgetName = stateWidgetName || node.sceneDefaultStateWidgetName || "positive_json";
}

function matrixLineStateWidgetName(side) {
    return `matrix_line_${side}_json`;
}

function setMatrixLineDraftContext(node, index, draft, side) {
    const stateWidgetName = matrixLineStateWidgetName(side);
    node.sceneMatrixLineDraftContext = { index, draft, side, stateWidgetName };
    return stateWidgetName;
}

function matrixLineDraftContextFor(node, stateWidgetName) {
    const widgetName = stateWidgetName || activeStateWidgetName(node);
    const context = node?.sceneMatrixLineDraftContext;
    if (!context?.draft || context.stateWidgetName !== widgetName) {
        return null;
    }
    return context;
}

function matrixLineDraftSelectionState(draft, side) {
    const key = side === "negative" ? "negative_json" : "positive_json";
    return selectionStateObjectFromValue(draft?.[key]);
}

function refreshMatrixLineDraftComputedFields(draft) {
    if (!draft) {
        return;
    }
    const order = String(draft.category_order || "").trim();
    const positiveBase = String(draft.positive_base || "").trim();
    const negativeBase = String(draft.negative_base || "").trim();
    const positiveState = selectionStateObjectFromValue(draft.positive_json);
    const negativeState = selectionStateObjectFromValue(draft.negative_json);
    const { positiveParts, negativeParts } = mergePositiveNegativeParts(
        promptPartsFromState(positiveBase, positiveState, order),
        promptPartsFromState(negativeBase, negativeState, order),
        [],
        [],
    );
    draft.positive_parts = positiveParts;
    draft.negative_parts = negativeParts;
    draft.display_labels = [
        ...promptDisplayLabelsFromBaseAndState(positiveBase, positiveState, order),
        ...promptDisplayLabelsFromBaseAndState(negativeBase, negativeState, order),
    ];
}

function writeMatrixLineDraftSelectionState(draft, side, state) {
    if (!draft) {
        return;
    }
    const key = side === "negative" ? "negative_json" : "positive_json";
    draft[key] = serializedSelectionStateObject(state);
    refreshMatrixLineDraftComputedFields(draft);
}

function clearMatrixLineDraftContext(node) {
    if (!node) {
        return;
    }
    node.sceneMatrixLineDraftContext = null;
    node.sceneMatrixLinePopupSecondary = false;
}

function popupStateWidgetName(node, options = {}) {
    return options.stateWidgetName
        || (activePopupContext?.node === node ? activePopupContext.stateWidgetName : null)
        || activeStateWidgetName(node);
}

function activatePopupStateWidget(node, options = {}) {
    const stateWidgetName = popupStateWidgetName(node, options);
    setActiveStateWidget(node, stateWidgetName);
    return stateWidgetName;
}

function readStateFromWidget(node, stateWidgetName) {
    const widgetName = stateWidgetName || activeStateWidgetName(node);
    const matrixLineContext = matrixLineDraftContextFor(node, widgetName);
    if (matrixLineContext) {
        return matrixLineDraftSelectionState(matrixLineContext.draft, matrixLineContext.side);
    }
    const widget = findWidget(node, widgetName);
    const raw = serializedSelectionStateValue(node, widget, widgetName) || widget?.value;
    return parseSelectionState(raw);
}

function serializedSelectionStateValue(node, widget, widgetName) {
    if (!Array.isArray(node?.widgets_values)) {
        return "";
    }
    const widgetIndex = Array.isArray(node?.widgets) && widget ? node.widgets.indexOf(widget) : -1;
    if (widgetIndex >= 0 && node.widgets_values[widgetIndex] != null && String(node.widgets_values[widgetIndex]).trim()) {
        return node.widgets_values[widgetIndex];
    }
    if (widgetName) {
        const namedIndex = (node.widgets || []).findIndex((candidate) => candidate?.name === widgetName);
        if (namedIndex >= 0 && node.widgets_values[namedIndex] != null && String(node.widgets_values[namedIndex]).trim()) {
            return node.widgets_values[namedIndex];
        }
    }
    return "";
}

function readState(node) {
    return readStateFromWidget(node, activeStateWidgetName(node));
}

function writeStateToWidget(node, state, stateWidgetName) {
    const widgetName = stateWidgetName || activeStateWidgetName(node);
    const matrixLineContext = matrixLineDraftContextFor(node, widgetName);
    if (matrixLineContext) {
        writeMatrixLineDraftSelectionState(matrixLineContext.draft, matrixLineContext.side, state);
        matrixLineContext.draft.sceneScheduleRenderSummaries?.();
        return;
    }
    const widget = findWidget(node, widgetName);
    const nextValue = JSON.stringify(state);
    if (widget) {
        widget.value = nextValue;
        node.widgets_values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
        const widgetIndex = Array.isArray(node.widgets) ? node.widgets.indexOf(widget) : -1;
        if (widgetIndex >= 0) {
            node.widgets_values[widgetIndex] = nextValue;
        }
        notifyWidgetChanged(node, widget, nextValue);
    }
}

function writeState(node, state, options = {}) {
    const stateWidgetName = options.stateWidgetName || activeStateWidgetName(node);
    setActiveStateWidget(node, stateWidgetName);
    writeStateToWidget(node, state, stateWidgetName);
    if (matrixLineDraftContextFor(node, stateWidgetName)) {
        return;
    }
    clearSceneComputedCaches(node);
    refreshNode(node, { expand: true, reserveSelectedListLine: !!options.reserveSelectedListLine });
    if (isScenePromptNode(node)) {
        refreshDownstreamSceneNodes(node);
    }
    if (options.fitHeight) {
        scheduleFitHeight(node, options.fitDelay ?? 80);
    }
    app.graph?.change?.();
    node.graph?.change?.();
}

function itemPath(item) {
    if (!Array.isArray(item.category_path)) {
        return [];
    }
    return item.category_path.map((part) => String(part).trim()).filter(Boolean);
}

function pathKey(path) {
    return path.join(" > ");
}

function pathLabel(path) {
    return pathKey(path);
}

function stripCountSuffix(label) {
    return String(label || "")
        .replace(/\s*\(\s*\d+\s*(?:\/\s*\d+\s*)?\)\s*$/u, "")
        .trim();
}

function displayPathLabel(path) {
    return path.map(stripCountSuffix).filter(Boolean).join(" > ");
}

function displayCategoryLabel(category) {
    return String(category || "")
        .split(" > ")
        .map(stripCountSuffix)
        .filter(Boolean)
        .join(" > ");
}

function itemCategoryKey(item) {
    return item.category_key || pathKey(itemPath(item));
}

function itemCategoryLabel(item) {
    return item.category_label || pathLabel(itemPath(item));
}

function pathsEqual(left, right) {
    return left.length === right.length && left.every((part, index) => part === right[index]);
}

function pathStartsWith(path, prefix) {
    return prefix.every((part, index) => path[index] === part);
}

function itemMatchesPath(item, path) {
    return pathsEqual(itemPath(item), path);
}

function itemStartsWithPath(item, path) {
    return pathStartsWith(itemPath(item), path);
}

function itemKey(item) {
    return `${itemCategoryKey(item)}::${item.id || item.label || item.prompt || ""}`;
}

function normalizeWeight(value) {
    const number = typeof value === "number" ? value : Number.parseFloat(String(value ?? "").trim());
    if (!Number.isFinite(number) || number < 0.05 || number > 3) {
        throw new Error("強度は 0.05 から 3 の数値で指定してください。");
    }
    return number;
}

function weightForStorage(value) {
    const weight = normalizeWeight(value);
    if (Math.abs(weight - 1) < 0.0005) {
        return null;
    }
    return Number(weight.toFixed(3));
}

function itemWeight(item) {
    return normalizeWeight(item?.weight ?? 1);
}

function formatWeight(value) {
    const weight = normalizeWeight(value);
    return weight.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
}

function splitPromptParts(text) {
    const parts = [];
    let current = "";
    let depth = 0;
    for (const character of String(text || "")) {
        if (character === "{") depth += 1;
        if (character === "}" && depth) depth -= 1;
        if ((character === "," || character === "\n") && depth === 0) {
            if (current.trim()) parts.push(current.trim());
            current = "";
        } else {
            current += character;
        }
    }
    if (current.trim()) parts.push(current.trim());
    return parts.map((part, index) => ({ index, text: part }));
}

function promptOverrideKey(part) {
    let text = String(part ?? "").trim();
    for (let index = 0; index < 8; index += 1) {
        const match = text.match(/^\((.*):\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+)\)$/u);
        if (!match) {
            break;
        }
        text = match[1].trim();
    }
    return text.replace(/\s+/gu, " ").toLowerCase();
}

function uniquePromptParts(parts, blockedOverrideKeys = new Set()) {
    const seen = new Set();
    const out = [];
    for (const part of parts || []) {
        const text = String(part ?? "").trim();
        const key = text.replace(/\s+/gu, " ").toLowerCase();
        const overrideKey = promptOverrideKey(text);
        if (!key || seen.has(key) || blockedOverrideKeys.has(overrideKey)) {
            continue;
        }
        seen.add(key);
        out.push(text);
    }
    return out;
}

function promptOverrideKeys(parts) {
    return new Set((parts || []).map((part) => promptOverrideKey(part)).filter(Boolean));
}

function mergePositiveNegativeParts(basePositive, baseNegative, addedPositive, addedNegative) {
    const negativeParts = uniquePromptParts([...(baseNegative || []), ...(addedNegative || [])]);
    const positiveParts = uniquePromptParts(
        [...(basePositive || []), ...(addedPositive || [])],
        promptOverrideKeys(negativeParts),
    );
    return { positiveParts, negativeParts };
}

function itemPromptParts(item) {
    return splitPromptParts(item?.prompt);
}

function itemHasMultipleParts(item) {
    return itemPromptParts(item).length > 1;
}

function partKey(part) {
    return `${Number(part?.index) || 0}::${String(part?.text || "").trim()}`;
}

function normalizedSelectedParts(item, source = item) {
    const parts = itemPromptParts(item);
    if (!parts.length || !Array.isArray(source?.selected_parts)) {
        return null;
    }

    if (!source.selected_parts.length) {
        throw new Error("選択済みのプロンプト要素が空です。");
    }
    const seen = new Set();
    return source.selected_parts.map((raw) => {
        if (!raw || typeof raw !== "object" || !Number.isInteger(raw.index) || raw.index < 0 || raw.index >= parts.length) {
            throw new Error("選択済みのプロンプト要素が不正です。");
        }
        const part = parts[raw.index];
        if (raw.text !== part.text || seen.has(part.index)) {
            throw new Error("選択済みのプロンプト要素が現在のプロンプトと一致しません。");
        }
        seen.add(part.index);
        const selectedPart = { index: part.index, text: part.text };
        const stored = weightForStorage(raw.weight ?? 1);
        if (stored !== null) selectedPart.weight = stored;
        return selectedPart;
    });
}

function itemHasPartSelection(item) {
    return !!normalizedSelectedParts(item, item);
}

function itemHasPartialSelection(item) {
    const selectedParts = normalizedSelectedParts(item, item);
    return !!selectedParts && selectedParts.length < itemPromptParts(item).length;
}

function itemWeightSuffix(item) {
    if (!item || itemHasPartSelection(item)) {
        return "";
    }
    const weight = itemWeight(item);
    return Math.abs(weight - 1) < 0.0005 ? "" : `:${formatWeight(weight)}`;
}

function itemBaseLabel(item, options = {}) {
    const label = item?.label || item?.prompt || item?.id || "prompt";
    const weightedLabel = options.showWeight === false ? label : `${label}${itemWeightSuffix(item)}`;
    return itemHasPartialSelection(item) ? `${weightedLabel}（一部）` : weightedLabel;
}

function selectedItemFor(state, item) {
    const key = itemKey(item);
    return selectedItems(state).find((selected) => itemKey(selected) === key) || null;
}

function itemForState(item, weightSource = item) {
    const selected = { ...item };
    const selectedParts = normalizedSelectedParts(item, weightSource);
    if (selectedParts) {
        selected.selected_parts = selectedParts;
        delete selected.weight;
    } else {
        delete selected.selected_parts;
        const stored = weightForStorage(weightSource?.weight);
        if (stored === null) {
            delete selected.weight;
        } else {
            selected.weight = stored;
        }
    }
    return selected;
}

function itemForEditedState(updatedItem, previousItem) {
    if (!Array.isArray(previousItem?.selected_parts)) {
        return itemForState(updatedItem, previousItem);
    }
    if (updatedItem.prompt !== previousItem.prompt) {
        throw new Error("一部選択されている候補は、選択を解除してからプロンプトを編集してください。");
    }
    return itemForState(updatedItem, previousItem);
}

function replacePromptItemInState(state, originalCategory, originalKey, updatedItem, updatedCategory) {
    let changed = false;
    const nextCategories = {};
    const matchKeys = new Set([originalKey]);
    for (const [category, items] of Object.entries(state.categories || {})) {
        const nextItems = [];
        for (const item of items || []) {
            if ((category === originalCategory || itemCategoryKey(item) === originalCategory) && matchKeys.has(itemKey(item))) {
                const replacement = itemForEditedState(updatedItem, item);
                if (replacement) {
                    const replacementCategory = itemCategoryKey(replacement) || updatedCategory;
                    if (replacementCategory === category) {
                        nextItems.push(replacement);
                    } else {
                        nextCategories[replacementCategory] = nextCategories[replacementCategory] || [];
                        nextCategories[replacementCategory].push(replacement);
                    }
                }
                changed = true;
            } else {
                nextItems.push(item);
            }
        }
        if (nextItems.length) {
            nextCategories[category] = [...(nextCategories[category] || []), ...nextItems];
        } else if ((items || []).length && !nextCategories[category]) {
            changed = true;
        }
    }

    if (!changed) {
        return { state, changed: false };
    }
    return {
        state: {
            ...state,
            categories: nextCategories,
        },
        changed: true,
    };
}

function replaceSelectedPromptItem(node, originalItem, updatedItem, options = {}) {
    if (!node || !updatedItem) {
        return false;
    }
    const originalCategory = itemCategoryKey(originalItem);
    const updatedCategory = itemCategoryKey(updatedItem);
    const originalKey = itemKey(originalItem);
    if (!originalCategory || !updatedCategory || !originalKey) {
        return false;
    }

    let anyChanged = false;
    const previousStateWidgetName = activeStateWidgetName(node);
    const matrixLineContext = matrixLineDraftContextFor(node, options.stateWidgetName);
    if (matrixLineContext) {
        let draftChanged = false;
        for (const side of ["positive", "negative"]) {
            const currentState = matrixLineDraftSelectionState(matrixLineContext.draft, side);
            const result = replacePromptItemInState(currentState, originalCategory, originalKey, updatedItem, updatedCategory);
            if (result.changed) {
                writeMatrixLineDraftSelectionState(matrixLineContext.draft, side, result.state);
                draftChanged = true;
                anyChanged = true;
            }
        }
        if (draftChanged) {
            matrixLineContext.draft.sceneScheduleRenderSummaries?.();
        }
    }

    const stateWidgetNames = matrixLineContext
        ? selectionStateWidgetNames(node)
        : [
            options.stateWidgetName,
            ...selectionStateWidgetNames(node),
        ].filter(Boolean);
    for (const stateWidgetName of [...new Set(stateWidgetNames)]) {
        const state = readStateFromWidget(node, stateWidgetName);
        const result = replacePromptItemInState(state, originalCategory, originalKey, updatedItem, updatedCategory);
        if (result.changed) {
            writeStateToWidget(node, result.state, stateWidgetName);
            anyChanged = true;
        }
    }
    setActiveStateWidget(node, previousStateWidgetName);
    return anyChanged;
}

function replacePromptItemInMatrixState(state, originalCategory, originalKey, updatedItem, updatedCategory) {
    let changed = false;
    const nextSets = [];
    for (const line of state?.sets || []) {
        let nextLine = { ...line };
        let lineChanged = false;
        for (const side of ["positive", "negative"]) {
            const key = side === "negative" ? "negative_json" : "positive_json";
            const result = replacePromptItemInState(
                selectionStateObjectFromValue(nextLine[key]),
                originalCategory,
                originalKey,
                updatedItem,
                updatedCategory,
            );
            if (result.changed) {
                nextLine[key] = serializedSelectionStateObject(result.state);
                lineChanged = true;
                changed = true;
            }
        }
        if (lineChanged) {
            refreshMatrixLineDraftComputedFields(nextLine);
            nextLine = normalizeMatrixLine(nextLine);
        }
        nextSets.push(nextLine);
    }

    return {
        state: {
            ...(state || {}),
            version: 1,
            sets: nextSets,
        },
        changed,
    };
}

function graphNodes() {
    return Array.isArray(app?.graph?._nodes) ? app.graph._nodes.filter(Boolean) : [];
}

function replacePromptItemEverywhere(originalItem, updatedItem) {
    if (!updatedItem) {
        return false;
    }
    const originalCategory = itemCategoryKey(originalItem);
    const updatedCategory = itemCategoryKey(updatedItem);
    const originalKey = itemKey(originalItem);
    if (!originalCategory || !updatedCategory || !originalKey) {
        return false;
    }

    let anyChanged = false;
    for (const graphNode of graphNodes()) {
        if (isScenePromptNode(graphNode)) {
            let nodeChanged = false;
            const previousStateWidgetName = activeStateWidgetName(graphNode);
            for (const stateWidgetName of selectionStateWidgetNames(graphNode)) {
                const state = readStateFromWidget(graphNode, stateWidgetName);
                const result = replacePromptItemInState(state, originalCategory, originalKey, updatedItem, updatedCategory);
                if (result.changed) {
                    writeStateToWidget(graphNode, result.state, stateWidgetName);
                    nodeChanged = true;
                }
            }
            setActiveStateWidget(graphNode, previousStateWidgetName);
            if (nodeChanged) {
                clearSceneComputedCaches(graphNode);
                refreshNode(graphNode);
                refreshDownstreamSceneNodes(graphNode);
                graphNode.graph?.change?.();
                anyChanged = true;
            }
        }

        if (isPromptMatrixNode(graphNode)) {
            const result = replacePromptItemInMatrixState(
                readMatrixState(graphNode),
                originalCategory,
                originalKey,
                updatedItem,
                updatedCategory,
            );
            if (result.changed) {
                writeMatrixState(graphNode, result.state, { fitHeight: false });
                anyChanged = true;
            }
        }
    }

    if (anyChanged) {
        app.graph?.change?.();
    }
    return anyChanged;
}

function itemSearchHaystack(item) {
    return [
        itemCategoryLabel(item),
        ...itemPath(item),
        item.label,
        item.description,
        item.prompt,
        item.id,
    ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
}

function pathSearchHaystack(path) {
    return [
        displayPathLabel(path),
        path[path.length - 1],
        ...path,
    ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
}

function allCategoryPaths(items) {
    const paths = new Map();
    for (const item of items || []) {
        const path = itemPath(item);
        for (let index = 1; index <= path.length; index += 1) {
            const currentPath = path.slice(0, index);
            paths.set(pathKey(currentPath), currentPath);
        }
    }
    return [...paths.values()].sort((left, right) => displayPathLabel(left).localeCompare(displayPathLabel(right), "ja"));
}

function searchCategoryPaths(items, query, depth) {
    return allCategoryPaths(items)
        .filter((path) => (depth === 1 ? path.length === 1 : path.length > 1))
        .filter((path) => pathSearchHaystack(path).includes(query));
}

function selectedItems(state) {
    return Object.values(state.categories || {}).flat().filter(Boolean);
}

function promptTextFromSelectedItem(item) {
    const selectedParts = normalizedSelectedParts(item, item);
    if (selectedParts) {
        return selectedParts
            .map((part) => {
                const weight = itemWeight(part);
                return Math.abs(weight - 1) < 0.0005 ? part.text : `(${part.text}:${formatWeight(weight)})`;
            })
            .filter(Boolean);
    }

    const prompt = String(item?.prompt || "").trim();
    if (!prompt) {
        return [];
    }
    const weight = itemWeight(item);
    return [Math.abs(weight - 1) < 0.0005 ? prompt : `(${prompt}:${formatWeight(weight)})`];
}

function orderedSelectionCategories(state, orderText = "") {
    const categories = Object.keys(state?.categories || {});
    const order = String(orderText || "")
        .split(/[,、\n]/u)
        .map((part) => part.trim())
        .filter(Boolean);
    const ordered = [];
    const used = new Set();

    for (const wanted of order) {
        const match = categories.find((category) => category === wanted || category.endsWith(` > ${wanted}`));
        if (match && !used.has(match)) {
            ordered.push(match);
            used.add(match);
        }
    }

    for (const category of categories) {
        if (!used.has(category)) {
            ordered.push(category);
        }
    }
    return ordered;
}

function promptPartsFromState(baseText, state, orderText = "") {
    const parts = splitPromptParts(baseText).map((part) => part.text);
    for (const category of orderedSelectionCategories(state, orderText)) {
        for (const item of state?.categories?.[category] || []) {
            parts.push(...promptTextFromSelectedItem(item));
        }
    }
    return parts.map((part) => String(part || "").trim()).filter(Boolean);
}

function promptEntriesFromState(state, orderText = "") {
    const entries = [];
    for (const category of orderedSelectionCategories(state, orderText)) {
        for (const item of state?.categories?.[category] || []) {
            const positiveParts = promptTextFromSelectedItem(item)
                .map((part) => String(part || "").trim())
                .filter(Boolean);
            if (!positiveParts.length) {
                continue;
            }
            entries.push({
                label: itemBaseLabel(item, { showWeight: false }),
                positive_parts: positiveParts,
            });
        }
    }
    return entries;
}

function promptLabelsFromState(state, orderText = "") {
    const labels = [];
    for (const category of orderedSelectionCategories(state, orderText)) {
        for (const item of state?.categories?.[category] || []) {
            const label = String(item?.label || "").trim();
            if (label) {
                labels.push(label);
            }
        }
    }
    return labels;
}

function promptDisplayLabelsFromBaseAndState(baseText, state, orderText = "") {
    return promptLabelsFromState(state, orderText)
        .map((part) => String(part || "").trim())
        .filter(Boolean);
}

function selectedKeys(state) {
    return new Set(selectedItems(state).map(itemKey));
}

function selectedItemMap(state) {
    return new Map(selectedItems(state).map((item) => [itemKey(item), item]));
}

function cloneSelectionState(state) {
    const cloned = { version: state?.version || 1, categories: {} };
    for (const [category, items] of Object.entries(state?.categories || {})) {
        const clonedItems = (items || []).filter(Boolean).map((item) => itemForState(item, item));
        if (clonedItems.length) {
            cloned.categories[category] = clonedItems;
        }
    }
    return cloned;
}

function mergeSelectedItemsForDisplay(displayState, sourceState) {
    if (!displayState.categories || typeof displayState.categories !== "object") {
        displayState.categories = {};
    }

    for (const [sourceCategory, items] of Object.entries(sourceState?.categories || {})) {
        for (const item of items || []) {
            if (!item) {
                continue;
            }
            const category = itemCategoryKey(item) || sourceCategory;
            if (!category) {
                continue;
            }
            const targetItems = displayState.categories[category] || [];
            const key = itemKey(item);
            const nextItem = itemForState(item, item);
            const existingIndex = targetItems.findIndex((existing) => itemKey(existing) === key);
            if (existingIndex >= 0) {
                targetItems[existingIndex] = nextItem;
            } else {
                targetItems.push(nextItem);
            }
            displayState.categories[category] = targetItems;
        }
    }
    return displayState;
}

function savedPromptKey(savedPrompt) {
    return String(savedPrompt?.id || savedPrompt?.name || "");
}

function savedPromptPath(savedPrompt) {
    const path = Array.isArray(savedPrompt?.category_path) ? savedPrompt.category_path : [];
    const normalized = path.map((part) => stripCountSuffix(part)).filter(Boolean);
    if (normalized.length) {
        return normalized;
    }
    return [savedPrompt?.name || savedPrompt?.id || "保存済みプロンプト"].filter(Boolean);
}

function savedPromptStartsWithPath(savedPrompt, path) {
    return pathStartsWith(savedPromptPath(savedPrompt), path);
}

function savedPromptMatchesPath(savedPrompt, path) {
    return pathsEqual(savedPromptPath(savedPrompt), path);
}

function getSavedPromptChildSegments(saved, path) {
    const names = new Set();
    for (const savedPrompt of saved || []) {
        const promptPath = savedPromptPath(savedPrompt);
        if (promptPath.length > path.length && pathStartsWith(promptPath, path)) {
            names.add(promptPath[path.length]);
        }
    }
    return [...names].sort((a, b) => a.localeCompare(b, "ja"));
}

function savedPromptsForPath(saved, path) {
    return (saved || []).filter((savedPrompt) => savedPromptMatchesPath(savedPrompt, path));
}

function savedPromptCountForPath(saved, state, path) {
    const selected = selectedKeys(state);
    const branch = (saved || []).filter((savedPrompt) => savedPromptStartsWithPath(savedPrompt, path));
    return {
        total: branch.length,
        selected: branch.filter((savedPrompt) => savedPromptMatches(savedPrompt, selected)).length,
    };
}

function savedPromptMatches(savedPrompt, selected) {
    const items = Array.isArray(savedPrompt?.items) ? savedPrompt.items : [];
    if (!items.length) {
        return false;
    }
    if (selected instanceof Map) {
        return items.every((item) => {
            const current = selected.get(itemKey(item));
            return current && itemSelectionSignature(current) === itemSelectionSignature(item);
        });
    }
    return items.every((item) => selected.has(itemKey(item)));
}

function itemSelectionSignature(item) {
    const selectedParts = normalizedSelectedParts(item, item);
    if (selectedParts) {
        return JSON.stringify({
            mode: "parts",
            parts: selectedParts.map((part) => ({
                index: part.index,
                text: part.text,
                weight: weightForStorage(part.weight),
            })),
        });
    }
    return JSON.stringify({
        mode: "all",
        weight: weightForStorage(item?.weight),
    });
}

function matchedSavedPrompts(state, saved = savedPrompts || []) {
    const selected = selectedItemMap(state);
    return (saved || []).filter((savedPrompt) => savedPromptMatches(savedPrompt, selected));
}

function itemsCoveredBySavedPrompts(saved) {
    const covered = new Set();
    for (const savedPrompt of saved || []) {
        for (const item of savedPrompt.items || []) {
            covered.add(itemKey(item));
        }
    }
    return covered;
}

function uncoveredCategories(state, saved) {
    const covered = itemsCoveredBySavedPrompts(saved);
    const categories = [];
    for (const [category, items] of Object.entries(state.categories || {})) {
        const visibleItems = (items || []).filter((item) => !covered.has(itemKey(item)));
        if (visibleItems.length) {
            categories.push([category, visibleItems]);
        }
    }
    return categories;
}

function addItemsToState(state, items) {
    for (const item of items || []) {
        const category = itemCategoryKey(item);
        if (!category) {
            continue;
        }
        const categoryItems = state.categories[category] || [];
        const key = itemKey(item);
        if (!categoryItems.some((existing) => itemKey(existing) === key)) {
            categoryItems.push(itemForState(item));
        }
        state.categories[category] = categoryItems;
    }
}

function setSavedPromptChecked(node, savedPrompt, checked, options = {}) {
    const stateWidgetName = popupStateWidgetName(node, options);
    const state = readStateFromWidget(node, stateWidgetName);
    if (checked) {
        addItemsToState(state, savedPrompt.items || []);
    } else {
        const keys = new Set((savedPrompt.items || []).map(itemKey));
        for (const [category, items] of Object.entries(state.categories || {})) {
            state.categories[category] = (items || []).filter((item) => !keys.has(itemKey(item)));
            if (!state.categories[category].length) {
                delete state.categories[category];
            }
        }
    }
    writeState(node, state, checked
        ? { reserveSelectedListLine: true, stateWidgetName }
        : { fitHeight: true, stateWidgetName });
}

function pruneStateToData(node, state, items, options = {}) {
    const validCategories = new Set(items.map(itemCategoryKey).filter(Boolean));
    const currentItems = new Map(items.map((item) => [itemKey(item), item]));
    let changed = false;
    const nextCategories = {};

    for (const [category, selected] of Object.entries(state.categories || {})) {
        if (!validCategories.has(category)) throw new Error(`選択済みカテゴリ「${category}」が候補データにありません。`);

        const kept = [];
        for (const item of selected || []) {
            const currentItem = currentItems.get(itemKey(item));
            if (!currentItem || itemCategoryKey(currentItem) !== category) {
                throw new Error(`選択済み候補「${item.label || item.prompt}」が候補データにありません。`);
            }
            const keptItem = itemForState(currentItem, item);
            kept.push(keptItem);
            if (itemSelectionSignature(item) !== itemSelectionSignature(keptItem)) changed = true;
        }

        if (kept.length) {
            nextCategories[category] = kept;
        }
    }

    if (changed) {
        state.categories = nextCategories;
        writeStateToWidget(node, state, options.stateWidgetName || activeStateWidgetName(node));
    }
    return state;
}

function selectionStateWidgetNames(node) {
    const names = [];
    for (const name of ["positive_json", "negative_json"]) {
        if (findWidget(node, name)) {
            names.push(name);
        }
    }
    return names.length ? names : [activeStateWidgetName(node)];
}

function pruneAllSelectionStatesToData(node, items) {
    const previous = activeStateWidgetName(node);
    for (const stateWidgetName of selectionStateWidgetNames(node)) {
        pruneStateToData(node, readStateFromWidget(node, stateWidgetName), items, { stateWidgetName });
    }
    setActiveStateWidget(node, previous);
}

function getChildSegments(items, path) {
    const names = new Set();
    for (const item of items) {
        const itemCategoryPath = itemPath(item);
        if (itemCategoryPath.length > path.length && pathStartsWith(itemCategoryPath, path)) {
            names.add(itemCategoryPath[path.length]);
        }
    }
    return [...names].sort((a, b) => a.localeCompare(b, "ja"));
}

function itemsForPath(items, path) {
    return items.filter((item) => itemMatchesPath(item, path));
}

function branchItems(items, path) {
    return items.filter((item) => itemStartsWithPath(item, path));
}

function rootCategories(items) {
    const categories = new Set();
    for (const item of items || []) {
        const path = itemPath(item);
        if (path[0]) {
            categories.add(stripCountSuffix(path[0]));
        }
    }
    return [...categories].sort((a, b) => a.localeCompare(b, "ja"));
}

function subcategoriesFor(items, category) {
    const selectedCategory = stripCountSuffix(category);
    const subcategories = new Set();
    for (const item of items || []) {
        const path = itemPath(item);
        if (stripCountSuffix(path[0]) === selectedCategory && path[1]) {
            subcategories.add(stripCountSuffix(path[1]));
        }
    }
    return [...subcategories].sort((a, b) => a.localeCompare(b, "ja"));
}

function countForPath(items, state, path) {
    return {
        total: branchItems(items, path).length,
        selected: selectedItems(state).filter((item) => itemStartsWithPath(item, path)).length,
    };
}

function countExactForPath(items, state, path) {
    return {
        total: itemsForPath(items, path).length,
        selected: selectedItems(state).filter((item) => itemMatchesPath(item, path)).length,
    };
}

function formatCategoryCount(counts) {
    return counts.selected ? ` ${counts.selected} / ${counts.total} ` : `${counts.total}`;
}

function setItemChecked(node, item, checked, options = {}) {
    const stateWidgetName = popupStateWidgetName(node, options);
    const state = readStateFromWidget(node, stateWidgetName);
    const category = itemCategoryKey(item);
    if (!category) {
        return;
    }
    const items = state.categories[category] || [];
    const key = itemKey(item);
    const exists = items.some((existing) => itemKey(existing) === key);

    if (checked && !exists) {
        items.push(itemForState(item));
        state.categories[category] = items;
    } else if (!checked && exists) {
        state.categories[category] = items.filter((existing) => itemKey(existing) !== key);
    }

    if (!state.categories[category]?.length) {
        delete state.categories[category];
    }
    writeState(node, state, checked
        ? { reserveSelectedListLine: true, stateWidgetName }
        : { fitHeight: true, stateWidgetName });
}

function setItemWeight(node, item, value, options = {}) {
    const stateWidgetName = popupStateWidgetName(node, options);
    const state = readStateFromWidget(node, stateWidgetName);
    const category = itemCategoryKey(item);
    if (!category) {
        return null;
    }
    const items = state.categories[category] || [];
    const key = itemKey(item);
    let target = items.find((existing) => itemKey(existing) === key);
    if (!target) {
        target = itemForState(item);
        items.push(target);
        state.categories[category] = items;
    }

    const stored = weightForStorage(value);
    if (stored === null) {
        delete target.weight;
    } else {
        target.weight = stored;
    }

    writeState(node, state, { reserveSelectedListLine: true, stateWidgetName });
    return target;
}

function partSelectionsForItem(item, selectedItem = null) {
    const parts = itemPromptParts(item);
    const selectedParts = normalizedSelectedParts(item, selectedItem);
    if (selectedParts) {
        const selectedMap = new Map(selectedParts.map((part) => [partKey(part), part]));
        return parts.map((part) => {
            const selectedPart = selectedMap.get(partKey(part));
            return {
                ...part,
                checked: !!selectedPart,
                weight: selectedPart ? itemWeight(selectedPart) : 1,
            };
        });
    }

    const wholeSelected = !!selectedItem;
    const weight = wholeSelected ? itemWeight(selectedItem) : 1;
    return parts.map((part) => ({
        ...part,
        checked: wholeSelected,
        weight,
    }));
}

function writeItemPartSelections(node, item, selections, options = {}) {
    const stateWidgetName = popupStateWidgetName(node, options);
    const state = readStateFromWidget(node, stateWidgetName);
    const category = itemCategoryKey(item);
    if (!category) {
        return null;
    }

    const allParts = itemPromptParts(item);
    const allKeys = new Set(allParts.map(partKey));
    const checked = (selections || [])
        .filter((part) => part.checked && allKeys.has(partKey(part)))
        .map((part) => ({
            index: part.index,
            text: part.text,
            weight: itemWeight(part),
        }));

    const categoryItems = state.categories[category] || [];
    const key = itemKey(item);
    const withoutItem = categoryItems.filter((existing) => itemKey(existing) !== key);

    if (!checked.length) {
        if (withoutItem.length) {
            state.categories[category] = withoutItem;
        } else {
            delete state.categories[category];
        }
        writeState(node, state, { fitHeight: true, stateWidgetName });
        return null;
    }

    const selected = itemForState(item);
    const allChecked = checked.length === allParts.length;
    const firstWeight = weightForStorage(checked[0]?.weight);
    const sameWeight = checked.every((part) => weightForStorage(part.weight) === firstWeight);
    if (allChecked && sameWeight && !options.forceParts) {
        if (firstWeight === null) {
            delete selected.weight;
        } else {
            selected.weight = firstWeight;
        }
        delete selected.selected_parts;
    } else {
        delete selected.weight;
        selected.selected_parts = checked.map((part) => {
            const selectedPart = { index: part.index, text: part.text };
            const stored = weightForStorage(part.weight);
            if (stored !== null) {
                selectedPart.weight = stored;
            }
            return selectedPart;
        });
    }

    withoutItem.push(selected);
    state.categories[category] = withoutItem;
    writeState(node, state, { reserveSelectedListLine: true, stateWidgetName });
    return selected;
}

function setItemPartChecked(node, item, part, checked, options = {}) {
    const stateWidgetName = popupStateWidgetName(node, options);
    const selectedItem = selectedItemFor(readStateFromWidget(node, stateWidgetName), item);
    const selections = partSelectionsForItem(item, selectedItem).map((selection) => {
        if (partKey(selection) === partKey(part)) {
            return { ...selection, checked };
        }
        return selection;
    });
    return writeItemPartSelections(node, item, selections, { forceParts: true, stateWidgetName });
}

function setItemPartWeight(node, item, part, value, options = {}) {
    const stateWidgetName = popupStateWidgetName(node, options);
    const selectedItem = selectedItemFor(readStateFromWidget(node, stateWidgetName), item);
    const selections = partSelectionsForItem(item, selectedItem).map((selection) => {
        if (partKey(selection) === partKey(part)) {
            return { ...selection, checked: true, weight: normalizeWeight(value) };
        }
        return selection;
    });
    return writeItemPartSelections(node, item, selections, { forceParts: true, stateWidgetName });
}

function setAllItemParts(node, item, checked, options = {}) {
    const stateWidgetName = popupStateWidgetName(node, options);
    const selectedItem = selectedItemFor(readStateFromWidget(node, stateWidgetName), item);
    const selections = partSelectionsForItem(item, selectedItem).map((selection) => ({
        ...selection,
        checked,
    }));
    return writeItemPartSelections(node, item, selections, { forceParts: !checked, stateWidgetName });
}

function clearSelection(node, stateWidgetName = null) {
    const targetStateWidgetName = stateWidgetName || activeStateWidgetName(node);
    setActiveStateWidget(node, targetStateWidgetName);
    writeState(node, { version: 1, categories: {} }, { fitHeight: true, fitDelay: 0, stateWidgetName: targetStateWidgetName });
}

function summarizeSelection(state) {
    const categories = Object.keys(state.categories || {});
    const items = selectedItems(state);
    if (!items.length) {
        return "";
    }
    return `${categories.length}カテゴリ / ${items.length}候補`;
}

function createButton(text, className = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `pc-button ${className}`.trim();
    button.textContent = text;
    return button;
}

function closePopup() {
    if (activePopup) {
        const closingContext = activePopupContext;
        const parent = activePopupContext?.parent || null;
        if (closingContext?.secondary && closingContext?.node) {
            rememberSecondaryPopupRect(closingContext.node, activePopup);
            if (parent?.context?.stateWidgetName) {
                setActiveStateWidget(closingContext.node, parent.context.stateWidgetName);
            } else {
                clearMatrixLineDraftContext(closingContext.node);
            }
        }
        if (closingContext?.node && !closingContext?.secondary) {
            rememberPopupRect(closingContext.node, activePopup);
            clearMatrixLineDraftContext(closingContext.node);
        }
        activePopup.remove();
        activePopup = parent?.popup || null;
        activePopupContext = parent?.context || null;
        return;
    }
    activePopupContext = null;
}

function closeAllPopups() {
    while (activePopup) {
        closePopup();
    }
}

function nodeScreenRect(node) {
    const canvas = app?.canvas;
    const canvasRect = canvas?.canvas?.getBoundingClientRect?.();
    if (!canvasRect || !Array.isArray(node?.pos) || !Array.isArray(node?.size)) {
        return null;
    }
    const scale = canvas?.ds?.scale || 1;
    const offset = canvas?.ds?.offset || [0, 0];
    const left = canvasRect.left + (node.pos[0] + offset[0]) * scale;
    const top = canvasRect.top + (node.pos[1] + offset[1]) * scale;
    return {
        left,
        top,
        bottom: top + node.size[1] * scale,
        width: node.size[0] * scale,
        height: node.size[1] * scale,
    };
}

function popupInitialRect(node) {
    const viewportWidth = window.innerWidth || 1280;
    const viewportHeight = window.innerHeight || 720;
    const cached = node.scenePromptPopupRect || {};
    const width = clamp(cached.width || POPUP_DEFAULT_WIDTH, POPUP_MIN_WIDTH, viewportWidth - 24);
    const preferredHeight = Math.max(cached.height || 0, POPUP_DEFAULT_HEIGHT);
    const height = clamp(preferredHeight, POPUP_MIN_HEIGHT, viewportHeight - 24);
    const nodeRect = nodeScreenRect(node);
    const defaultLeft = nodeRect ? nodeRect.left + 18 : 64;
    const defaultTop = nodeRect ? nodeRect.top + 46 : 64;
    return {
        left: clamp(cached.left ?? defaultLeft, 12, viewportWidth - width - 12),
        top: clamp(cached.top ?? defaultTop, 12, viewportHeight - height - 12),
        width,
        height,
    };
}

function rememberPopupRect(node, popup) {
    const rect = popup.getBoundingClientRect();
    node.scenePromptPopupRect = {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
    };
}

function rememberSecondaryPopupRect(node, popup) {
    const rect = popup.getBoundingClientRect();
    node.sceneMatrixLineSecondaryPopupRect = {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
    };
}

function applyPopupRect(popup, rect) {
    popup.style.left = `${rect.left}px`;
    popup.style.top = `${rect.top}px`;
    popup.style.width = `${rect.width}px`;
    popup.style.height = `${rect.height}px`;
}

function fitPopupToContent(popup) {
    requestAnimationFrame(() => {
        const maxWidth = (window.innerWidth || 1280) - 24;
        const maxHeight = (window.innerHeight || 720) - 24;
        popup.classList.add("pc-fit-content");
        popup.style.height = "auto";
        const height = clamp(popup.scrollHeight + 4, POPUP_MIN_HEIGHT, maxHeight);
        popup.style.height = `${Math.round(height)}px`;
        const rect = popup.getBoundingClientRect();
        const width = clamp(rect.width, POPUP_MIN_WIDTH, maxWidth);
        popup.style.width = `${Math.round(width)}px`;
        const left = clamp(rect.left, 12, Math.max(12, (window.innerWidth || 1280) - width - 12));
        const top = clamp(rect.top, 12, Math.max(12, (window.innerHeight || 720) - height - 12));
        popup.style.left = `${Math.round(left)}px`;
        popup.style.top = `${Math.round(top)}px`;
    });
}

function makePopupDraggable(node, popup, handle) {
    handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        const rect = popup.getBoundingClientRect();
        const offsetX = event.clientX - rect.left;
        const offsetY = event.clientY - rect.top;

        const move = (moveEvent) => {
            const width = popup.offsetWidth;
            const height = popup.offsetHeight;
            const left = clamp(moveEvent.clientX - offsetX, 8, window.innerWidth - width - 8);
            const top = clamp(moveEvent.clientY - offsetY, 8, window.innerHeight - height - 8);
            popup.style.left = `${Math.round(left)}px`;
            popup.style.top = `${Math.round(top)}px`;
        };

        const up = () => {
            document.removeEventListener("pointermove", move, true);
            document.removeEventListener("pointerup", up, true);
            if (popup.sceneSecondaryPopup) {
                rememberSecondaryPopupRect(node, popup);
            } else {
                rememberPopupRect(node, popup);
            }
        };

        document.addEventListener("pointermove", move, true);
        document.addEventListener("pointerup", up, true);
    });
}

function openPopupShell(node, titleText, options = {}) {
    const stateWidgetName = options.stateWidgetName || activeStateWidgetName(node);
    const isSecondary = !!options.secondary
        || !!matrixLineDraftContextFor(node, stateWidgetName)
        || (!!node?.sceneMatrixLinePopupSecondary && !!matrixLineDraftContextFor(node, stateWidgetName))
        || (!!activePopupContext?.secondary && !!matrixLineDraftContextFor(node, stateWidgetName));
    let parent = null;
    if (isSecondary) {
        if (activePopupContext?.secondary) {
            closePopup();
        }
        parent = activePopup && activePopupContext
            ? { popup: activePopup, context: activePopupContext }
            : null;
    } else {
        closeAllPopups();
    }
    if (isSecondary) {
        node.sceneMatrixLinePopupSecondary = true;
    }
    setActiveStateWidget(node, stateWidgetName);

    const popup = document.createElement("div");
    popup.className = "pc-popup";
    popup.sceneSecondaryPopup = isSecondary;
    for (const eventName of ["pointerdown", "pointermove", "pointerup", "mousedown", "mouseup", "click", "wheel"]) {
        popup.addEventListener(eventName, (event) => event.stopPropagation(), { passive: eventName === "wheel" });
    }

    const rect = popupInitialRect(node);
    if (isSecondary && node.sceneMatrixLineSecondaryPopupRect) {
        const cached = node.sceneMatrixLineSecondaryPopupRect;
        rect.width = clamp(cached.width || rect.width, POPUP_MIN_WIDTH, window.innerWidth - 24);
        rect.height = clamp(cached.height || rect.height, POPUP_MIN_HEIGHT, window.innerHeight - 24);
        rect.left = clamp(cached.left ?? rect.left, 12, window.innerWidth - rect.width - 12);
        rect.top = clamp(cached.top ?? rect.top, 12, window.innerHeight - rect.height - 12);
    } else if (parent?.popup) {
        const parentRect = parent.popup.getBoundingClientRect();
        rect.left = clamp(parentRect.left + 34, 12, window.innerWidth - rect.width - 12);
        rect.top = clamp(parentRect.top + 34, 12, window.innerHeight - rect.height - 12);
    }
    applyPopupRect(popup, rect);

    const head = document.createElement("div");
    head.className = "pc-popup-head";

    const grip = document.createElement("div");
    grip.className = "pc-popup-grip";
    grip.textContent = "::::";
    head.appendChild(grip);

    const title = document.createElement("div");
    title.className = "pc-popup-title";
    title.textContent = titleText;
    head.appendChild(title);

    const actions = document.createElement("div");
    actions.className = "pc-popup-actions";

    if (!options.hideReload) {
        const reload = createButton("設定再読み込み");
        reload.addEventListener("click", async () => {
            setActiveStateWidget(node, stateWidgetName);
            promptItems = null;
            savedPrompts = null;
            const [items] = await Promise.all([loadPromptItems(true), loadSavedPrompts(true)]);
            if (matrixLineDraftContextFor(node, stateWidgetName)) {
                pruneStateToData(node, readStateFromWidget(node, stateWidgetName), items, { stateWidgetName });
            } else {
                pruneAllSelectionStatesToData(node, items);
            }
            setActiveStateWidget(node, stateWidgetName);
            refreshNode(node, { fitHeight: true });
            activePopupContext?.reopen?.();
        });
        actions.appendChild(reload);
    }

    if (!options.hideClear) {
        const clear = createButton("選択クリア");
        clear.addEventListener("click", () => {
            clearSelection(node, stateWidgetName);
            setActiveStateWidget(node, stateWidgetName);
            activePopupContext?.reopen?.();
        });
        actions.appendChild(clear);
    }

    const close = createButton("閉じる");
    close.addEventListener("click", () => {
        closePopup();
    });
    actions.appendChild(close);
    head.appendChild(actions);

    popup.appendChild(head);
    document.body.appendChild(popup);
    makePopupDraggable(node, popup, head);

    activePopup = popup;
    activePopupContext = { node, popup, reopen: null, stateWidgetName, secondary: isSecondary, parent };
    return popup;
}

function appendPopupNavButtons(toolbar, node, current = "", options = {}) {
    const stateWidgetName = popupStateWidgetName(node, options);
    const list = createButton("一覧");
    list.classList.toggle("pc-on", current === "list");
    list.addEventListener("click", () => openCategoryLevelPicker(node, [], { stateWidgetName }));
    toolbar.appendChild(list);

    const selected = createButton("選択済み一覧");
    selected.classList.toggle("pc-on", current === "selected");
    selected.addEventListener("click", () => openSelectedPopup(node, { stateWidgetName }));
    toolbar.appendChild(selected);

    const save = createButton("プロンプトまとめて保存");
    save.classList.toggle("pc-on", current === "save");
    save.addEventListener("click", () => openSavePromptPopup(node, { stateWidgetName }));
    toolbar.appendChild(save);

    const create = createButton("プロンプト作成");
    create.classList.toggle("pc-on", current === "create");
    create.addEventListener("click", () => openCreatePromptPopup(node, { stateWidgetName }));
    toolbar.appendChild(create);

    const search = createButton("検索");
    search.classList.toggle("pc-on", current === "search");
    search.addEventListener("click", () => openSearchPopup(node, { stateWidgetName }));
    toolbar.appendChild(search);
}

function appendMatrixLineEditReturn(popup, node, options = {}) {
    const stateWidgetName = popupStateWidgetName(node, options);
    const matrixLineContext = matrixLineDraftContextFor(node, stateWidgetName);
    if (!matrixLineContext) {
        return;
    }
    const row = document.createElement("div");
    row.className = "pc-toolbar";
    row.style.justifyContent = "flex-start";
    row.style.flex = "0 0 auto";
    const edit = createButton("行編集へ戻る");
    edit.addEventListener("click", () => {
        matrixLineContext.draft.sceneScheduleRenderSummaries?.();
        closePopup();
    });
    row.appendChild(edit);
    popup.appendChild(row);
}

function appendMatrixLineBasePromptInput(popup, node, options = {}) {
    const stateWidgetName = popupStateWidgetName(node, options);
    const matrixLineContext = matrixLineDraftContextFor(node, stateWidgetName);
    if (!matrixLineContext) {
        return;
    }
    const input = createMatrixLineBaseInput(matrixLineContext.draft, matrixLineContext.side);
    input.style.flex = "0 0 auto";
    popup.appendChild(input);
}

function appendBackButton(container, text, onClick) {
    const back = createButton(text, "pc-back-button");
    back.addEventListener("click", onClick);
    container.appendChild(back);
    return back;
}

function appendSearchHeading(container, text) {
    const heading = document.createElement("div");
    heading.className = "pc-search-heading";
    heading.textContent = text;
    container.appendChild(heading);
    return heading;
}

function openPathFromSearch(node, items, path, options = {}) {
    const children = getChildSegments(items, path);
    const directItems = itemsForPath(items, path);
    if (!children.length && directItems.length) {
        openPromptCandidatePopup(node, path, options);
    } else {
        openCategoryLevelPicker(node, path, options);
    }
}

function appendSearchPathRow(container, node, items, state, path, options = {}) {
    const stateWidgetName = popupStateWidgetName(node, options);
    const counts = countForPath(items, state, path);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "pc-button pc-search-path";
    row.classList.toggle("pc-on", !!counts.selected);
    row.title = displayPathLabel(path);

    const title = document.createElement("div");
    title.className = "pc-search-path-title";
    title.textContent = `${stripCountSuffix(path[path.length - 1])} (${formatCategoryCount(counts)})`;
    row.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "pc-search-path-meta";
    meta.textContent = displayPathLabel(path);
    row.appendChild(meta);

    row.addEventListener("click", () => openPathFromSearch(node, items, path, { stateWidgetName }));
    container.appendChild(row);
    return row;
}

function createWeightControl(node, item, selectedItem, onUpdate, options = {}) {
    const stateWidgetName = popupStateWidgetName(node, options);
    const wrap = document.createElement("div");
    wrap.className = `pc-weight-control ${options.className || ""}`.trim();

    const input = document.createElement("input");
    input.className = "pc-weight-input";
    input.type = "number";
    input.min = "0.05";
    input.max = "3";
    input.step = "0.05";
    input.value = formatWeight(itemWeight(selectedItem));
    input.disabled = !!options.disabled;
    input.setAttribute("aria-label", "強度");
    input.title = "1 is normal. Non-1 values output as (prompt:1.5).";

    const stop = (event) => {
        event.stopPropagation();
    };
    input.addEventListener("click", stop);
    input.addEventListener("mousedown", stop);
    input.addEventListener("pointerdown", stop);
    input.addEventListener("keydown", stop);
    const storeWeight = (options = {}) => {
        const updated = setItemWeight(node, item, input.value, { stateWidgetName });
        if (options.normalize) {
            input.value = formatWeight(itemWeight(updated));
        }
        if (options.notify) {
            onUpdate?.();
        }
    };
    input.addEventListener("input", () => {
        if (Number.isFinite(Number.parseFloat(String(input.value).trim()))) {
            storeWeight();
        }
    });
    input.addEventListener("change", () => storeWeight({ normalize: true, notify: true }));
    input.addEventListener("blur", () => storeWeight({ normalize: true }));

    wrap.appendChild(input);
    wrap.sceneWeightInput = input;
    return wrap;
}

function createPartWeightInput(value, disabled, onChange) {
    const input = document.createElement("input");
    input.className = "pc-weight-input";
    input.type = "number";
    input.min = "0.05";
    input.max = "3";
    input.step = "0.05";
    input.value = formatWeight(value);
    input.disabled = !!disabled;
    input.setAttribute("aria-label", "強度");
    input.title = "1が通常。1以外は生成時に(prompt:1.5)として出力します。";
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("mousedown", (event) => event.stopPropagation());
    input.addEventListener("pointerdown", (event) => event.stopPropagation());
    input.addEventListener("keydown", (event) => event.stopPropagation());
    input.addEventListener("input", () => {
        if (Number.isFinite(Number.parseFloat(String(input.value).trim()))) {
            onChange(input.value, { notify: false });
        }
    });
    input.addEventListener("change", () => {
        onChange(input.value, { notify: true });
        input.value = formatWeight(input.value);
    });
    input.addEventListener("blur", () => {
        onChange(input.value, { notify: false });
        input.value = formatWeight(input.value);
    });
    return input;
}

function appendPartRow(container, node, item, partSelection, onUpdate, options = {}) {
    const stateWidgetName = popupStateWidgetName(node, options);
    const row = document.createElement("label");
    row.className = `pc-part-row ${partSelection.checked ? "pc-on" : ""}`.trim();

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !!partSelection.checked;
    row.appendChild(checkbox);

    const text = document.createElement("div");
    text.className = "pc-part-text";
    text.textContent = partSelection.text;
    row.appendChild(text);

    const weight = createPartWeightInput(partSelection.weight, !partSelection.checked, (value, options = {}) => {
        setItemPartWeight(node, item, partSelection, value, { stateWidgetName });
        if (options.notify !== false) {
            onUpdate?.();
        }
    });
    row.appendChild(weight);

    checkbox.addEventListener("change", () => {
        setItemPartChecked(node, item, partSelection, checkbox.checked, { stateWidgetName });
        onUpdate?.();
    });

    container.appendChild(row);
    return row;
}

async function openItemPartPopup(node, item, backHandler = null, options = {}) {
    const stateWidgetName = activatePopupStateWidget(node, options);
    const popup = openPopupShell(node, `${itemBaseLabel(item)} 個別選択`, { stateWidgetName });
    if (activePopupContext?.popup === popup) {
        activePopupContext.reopen = () => openItemPartPopup(node, item, backHandler, { stateWidgetName });
    }

    const toolbar = document.createElement("div");
    toolbar.className = "pc-toolbar";
    appendPopupNavButtons(toolbar, node, "", { stateWidgetName });
    popup.appendChild(toolbar);

    const list = document.createElement("div");
    list.className = "pc-popup-list pc-popup-category-list";
    popup.appendChild(list);

    const renderParts = () => {
        const selectedItem = selectedItemFor(readStateFromWidget(node, stateWidgetName), item);
        const selections = partSelectionsForItem(item, selectedItem);
        list.innerHTML = "";

        if (backHandler) {
            appendBackButton(list, "←戻る", backHandler);
        }

        const actions = document.createElement("div");
        actions.className = "pc-part-actions";
        const selectAll = createButton("全て選択");
        selectAll.addEventListener("click", () => {
            setAllItemParts(node, item, true, { stateWidgetName });
            renderParts();
        });
        actions.appendChild(selectAll);

        const clearAll = createButton("全て解除");
        clearAll.addEventListener("click", () => {
            setAllItemParts(node, item, false, { stateWidgetName });
            renderParts();
        });
        actions.appendChild(clearAll);
        list.appendChild(actions);

        for (const selection of selections) {
            appendPartRow(list, node, item, selection, renderParts, { stateWidgetName });
        }
        fitPopupToContent(popup);
    };

    renderParts();
    fitPopupToContent(popup);
}

function appendCandidateRow(container, node, item, selected, onUpdate, options = {}) {
    const stateWidgetName = popupStateWidgetName(node, options);
    const showPath = !!options.showPath;
    const state = options.state || readStateFromWidget(node, stateWidgetName);
    let selectedItem = selectedItemFor(state, item);
    const key = itemKey(item);
    const row = document.createElement("label");
    row.className = `pc-candidate ${selectedItem ? "pc-selected-item" : ""}`.trim();
    row.title = item.prompt || "";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !!selectedItem;
    checkbox.indeterminate = itemHasPartialSelection(selectedItem);
    row.appendChild(checkbox);

    const main = document.createElement("div");
    main.className = "pc-candidate-main";

    const title = document.createElement("div");
    title.className = "pc-candidate-title";
    title.textContent = itemBaseLabel(selectedItem || item, { showWeight: false });
    main.appendChild(title);

    if (showPath) {
        const path = document.createElement("div");
        path.className = "pc-candidate-path";
        path.textContent = displayCategoryLabel(itemCategoryLabel(item));
        main.appendChild(path);
    }

    const prompt = document.createElement("div");
    prompt.className = "pc-candidate-prompt";
    prompt.textContent = item.prompt || "";
    main.appendChild(prompt);

    if (item.description) {
        const desc = document.createElement("div");
        desc.className = "pc-candidate-desc";
        desc.textContent = item.description;
        main.appendChild(desc);
    }

    const actions = document.createElement("div");
    actions.className = "pc-candidate-actions";

    const weightControl = createWeightControl(node, item, selectedItem, onUpdate, {
        disabled: !selectedItem || itemHasPartSelection(selectedItem),
        stateWidgetName,
    });
    actions.appendChild(weightControl);

    if (itemHasMultipleParts(item)) {
        const partsButton = createButton("個別選択");
        partsButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            openItemPartPopup(node, item, () => openPromptCandidatePopup(node, itemPath(item), { stateWidgetName }), { stateWidgetName });
        });
        actions.appendChild(partsButton);
    }
    if (options.allowEdit !== false) {
        const editButton = createButton("編集");
        editButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const back = () => {
                if (options.backToSearch) {
                    openSearchPopup(node, { stateWidgetName });
                } else {
                    openPromptCandidatePopup(node, itemPath(item), { stateWidgetName });
                }
            };
            openEditPromptItemPopup(node, item, back, { stateWidgetName });
        });
        actions.appendChild(editButton);
    }
    main.appendChild(actions);

    row.appendChild(main);

    const toggle = () => {
        setItemChecked(node, item, checkbox.checked, { stateWidgetName });
        selectedItem = checkbox.checked ? selectedItemFor(readStateFromWidget(node, stateWidgetName), item) : null;
        row.classList.toggle("pc-selected-item", checkbox.checked);
        checkbox.indeterminate = false;
        title.textContent = itemBaseLabel(selectedItem || item, { showWeight: false });
        weightControl.sceneWeightInput.disabled = !checkbox.checked || itemHasPartSelection(selectedItem);
        weightControl.sceneWeightInput.value = formatWeight(itemWeight(selectedItem));
        onUpdate?.();
    };
    checkbox.addEventListener("change", toggle);

    container.appendChild(row);
}

function appendCandidateChip(container, node, item, selected, onUpdate, options = {}) {
    const stateWidgetName = popupStateWidgetName(node, options);
    const key = itemKey(item);
    let selectedItem = selectedItemFor(readStateFromWidget(node, stateWidgetName), item);
    const checked = !!selectedItem && selected.has(key);
    const chip = document.createElement("label");
    chip.className = `pc-selected-chip ${checked ? "" : "pc-off"}`.trim();
    chip.title = item.prompt || item.description || "";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = checked;
    checkbox.indeterminate = itemHasPartialSelection(selectedItem);
    chip.appendChild(checkbox);

    const label = document.createElement("span");
    label.textContent = itemBaseLabel(selectedItem || item, { showWeight: false });
    chip.appendChild(label);

    const openParts = (event) => {
        event.preventDefault();
        event.stopPropagation();
        openItemPartPopup(node, item, () => openSelectedPopup(node, { stateWidgetName }), { stateWidgetName });
    };
    if (itemHasMultipleParts(item)) {
        label.title = "個別選択";
        label.addEventListener("click", openParts);
    }

    const weightControl = createWeightControl(node, item, selectedItem, () => {
        selectedItem = selectedItemFor(readStateFromWidget(node, stateWidgetName), item);
        label.textContent = itemBaseLabel(selectedItem || item, { showWeight: false });
        onUpdate?.();
    }, {
        disabled: !checked || itemHasPartSelection(selectedItem),
        stateWidgetName,
    });
    chip.appendChild(weightControl);

    if (itemHasMultipleParts(item)) {
        const partsButton = createButton("個別");
        partsButton.addEventListener("click", openParts);
        chip.appendChild(partsButton);
    }
    if (options.allowEdit) {
        const editButton = createButton("編集");
        editButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            openEditPromptItemPopup(node, item, () => openSelectedPopup(node, { stateWidgetName }), { stateWidgetName });
        });
        chip.appendChild(editButton);
    }

    checkbox.addEventListener("change", () => {
        setItemChecked(node, item, checkbox.checked, { stateWidgetName });
        selectedItem = checkbox.checked ? selectedItemFor(readStateFromWidget(node, stateWidgetName), item) : null;
        chip.classList.toggle("pc-off", !checkbox.checked);
        checkbox.indeterminate = false;
        weightControl.sceneWeightInput.disabled = !checkbox.checked || itemHasPartSelection(selectedItem);
        weightControl.sceneWeightInput.value = formatWeight(itemWeight(selectedItem));
        label.textContent = itemBaseLabel(selectedItem || item, { showWeight: false });
        if (options.keepVisibleWhenUnchecked && !checkbox.checked) {
            if (activePopup) {
                fitPopupToContent(activePopup);
            }
            return;
        }
        onUpdate?.();
    });

    container.appendChild(chip);
    return chip;
}

function appendPreviewChip(container, item) {
    const chip = document.createElement("span");
    chip.className = "pc-preview-chip";
    chip.title = item.prompt || item.description || "";

    const label = document.createElement("span");
    label.textContent = itemBaseLabel(item);
    chip.appendChild(label);

    container.appendChild(chip);
    return chip;
}

function appendSavedPromptRow(container, savedPrompt, onClick) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "pc-saved-prompt";
    row.title = savedPrompt.description || "";

    const title = document.createElement("div");
    title.className = "pc-saved-title";
    title.textContent = savedPrompt.name || savedPrompt.id || "保存済みプロンプト";
    row.appendChild(title);

    if (savedPrompt.description) {
        const desc = document.createElement("div");
        desc.className = "pc-saved-desc";
        desc.textContent = savedPrompt.description;
        row.appendChild(desc);
    }

    row.addEventListener("click", onClick);
    container.appendChild(row);
    return row;
}

async function openSavePromptPopup(node, options = {}) {
    const stateWidgetName = activatePopupStateWidget(node, options);
    const data = await loadPromptItems();
    setActiveStateWidget(node, stateWidgetName);
    const state = pruneStateToData(node, readStateFromWidget(node, stateWidgetName), data, { stateWidgetName });
    const items = selectedItems(state);
    const popup = openPopupShell(node, "プロンプトまとめて保存", { stateWidgetName });
    if (activePopupContext?.popup === popup) {
        activePopupContext.reopen = () => openSavePromptPopup(node, { stateWidgetName });
    }

    const nav = document.createElement("div");
    nav.className = "pc-toolbar";
    appendPopupNavButtons(nav, node, "save", { stateWidgetName });
    popup.appendChild(nav);

    const form = document.createElement("div");
    form.className = "pc-form";

    const nameLabel = document.createElement("label");
    nameLabel.textContent = "名前";
    const nameInput = document.createElement("input");
    nameInput.placeholder = "例: ギャルOL基本セット";
    nameLabel.appendChild(nameInput);
    form.appendChild(nameLabel);

    const descLabel = document.createElement("label");
    descLabel.textContent = "説明";
    const descInput = document.createElement("textarea");
    descInput.placeholder = "用途や狙いをメモ";
    descLabel.appendChild(descInput);
    form.appendChild(descLabel);

    const note = document.createElement("div");
    note.className = "pc-form-note";
    note.textContent = `${items.length}件の選択済み候補を保存します。`;
    form.appendChild(note);

    if (items.length) {
        const preview = document.createElement("div");
        preview.className = "pc-chip-list";
        for (const item of items) {
            appendPreviewChip(preview, item);
        }
        form.appendChild(preview);
    }

    const error = document.createElement("div");
    error.className = "pc-error";
    form.appendChild(error);

    const toolbar = document.createElement("div");
    toolbar.className = "pc-toolbar";
    const save = createButton("保存");
    save.disabled = !items.length;
    save.addEventListener("click", async () => {
        error.textContent = "";
        try {
            await saveCurrentPrompt(nameInput.value, descInput.value, items);
            await loadSavedPrompts(true);
            refreshNode(node, { fitHeight: true });
            openSelectedPopup(node, { stateWidgetName });
        } catch (saveError) {
            error.textContent = saveError.message || "プロンプトまとめの保存に失敗しました";
            fitPopupToContent(popup);
        }
    });
    toolbar.appendChild(save);

    const back = createButton("←戻る");
    back.addEventListener("click", () => openSelectedPopup(node, { stateWidgetName }));
    toolbar.appendChild(back);
    form.appendChild(toolbar);

    popup.appendChild(form);
    fitPopupToContent(popup);
    nameInput.focus();
}

async function openCreatePromptPopup(node, options = {}) {
    const stateWidgetName = activatePopupStateWidget(node, options);
    const data = await loadPromptItems();
    setActiveStateWidget(node, stateWidgetName);
    const popup = openPopupShell(node, "プロンプト作成", { stateWidgetName });
    if (activePopupContext?.popup === popup) {
        activePopupContext.reopen = () => openCreatePromptPopup(node, { stateWidgetName });
    }

    const nav = document.createElement("div");
    nav.className = "pc-toolbar";
    appendPopupNavButtons(nav, node, "create", { stateWidgetName });
    popup.appendChild(nav);

    const form = document.createElement("div");
    form.className = "pc-form";

    const categoryLabel = document.createElement("label");
    categoryLabel.textContent = "カテゴリ（必須）";
    const categoryInput = document.createElement("input");
    categoryInput.placeholder = "新規入力、または既存カテゴリを選択";
    categoryLabel.appendChild(categoryInput);
    const categorySelect = document.createElement("select");
    categoryLabel.appendChild(categorySelect);
    form.appendChild(categoryLabel);

    const subcategoryLabel = document.createElement("label");
    subcategoryLabel.textContent = "サブカテゴリ（任意）";
    const subcategoryInput = document.createElement("input");
    subcategoryInput.placeholder = "新規入力、または既存サブカテゴリを選択";
    subcategoryLabel.appendChild(subcategoryInput);
    const subcategorySelect = document.createElement("select");
    subcategoryLabel.appendChild(subcategorySelect);
    form.appendChild(subcategoryLabel);

    const nameLabel = document.createElement("label");
    nameLabel.textContent = "名前";
    const nameInput = document.createElement("input");
    nameInput.placeholder = "例: アングルセット";
    nameLabel.appendChild(nameInput);
    form.appendChild(nameLabel);

    const promptLabel = document.createElement("label");
    promptLabel.textContent = "プロンプト";
    const promptInput = document.createElement("textarea");
    promptInput.placeholder = "例: low angle, from below";
    promptLabel.appendChild(promptInput);
    form.appendChild(promptLabel);

    const descLabel = document.createElement("label");
    descLabel.textContent = "説明";
    const descInput = document.createElement("textarea");
    descInput.placeholder = "用途やニュアンスをメモ";
    descLabel.appendChild(descInput);
    form.appendChild(descLabel);

    const error = document.createElement("div");
    error.className = "pc-error";
    form.appendChild(error);

    const fillSelect = (select, placeholder, values) => {
        select.innerHTML = "";
        const empty = document.createElement("option");
        empty.value = "";
        empty.textContent = placeholder;
        select.appendChild(empty);
        for (const value of values) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = value;
            select.appendChild(option);
        }
    };

    fillSelect(categorySelect, "既存カテゴリを選択", rootCategories(data));

    let currentCategory = "";
    const refreshSubcategories = () => {
        fillSelect(subcategorySelect, "既存サブカテゴリを選択", subcategoriesFor(data, categoryInput.value));
    };
    const syncCategorySelect = () => {
        const categories = rootCategories(data);
        categorySelect.value = categories.includes(categoryInput.value) ? categoryInput.value : "";
    };
    const setCategory = (value) => {
        if (categoryInput.value !== value) {
            categoryInput.value = value;
            subcategoryInput.value = "";
            subcategorySelect.value = "";
        }
        currentCategory = categoryInput.value;
        syncCategorySelect();
        refreshSubcategories();
    };

    categorySelect.addEventListener("change", () => {
        setCategory(categorySelect.value);
    });
    categoryInput.addEventListener("input", () => {
        if (categoryInput.value !== currentCategory) {
            subcategoryInput.value = "";
            subcategorySelect.value = "";
        }
        currentCategory = categoryInput.value;
        syncCategorySelect();
        refreshSubcategories();
    });
    subcategorySelect.addEventListener("change", () => {
        subcategoryInput.value = subcategorySelect.value;
    });
    refreshSubcategories();

    const toolbar = document.createElement("div");
    toolbar.className = "pc-toolbar";
    const create = createButton("作成");
    create.addEventListener("click", async () => {
        error.textContent = "";
        try {
            const item = await createPromptItem({
                category: categoryInput.value,
                subcategory: subcategoryInput.value,
                name: nameInput.value,
                prompt: promptInput.value,
                description: descInput.value,
            });
            promptItems = null;
            await loadPromptItems();
            refreshNode(node, { fitHeight: true });
            openPromptCandidatePopup(node, item.category_path || [categoryInput.value].filter(Boolean), { stateWidgetName });
        } catch (createError) {
            error.textContent = createError.message || "プロンプト作成に失敗しました";
            fitPopupToContent(popup);
        }
    });
    toolbar.appendChild(create);

    const back = createButton("←戻る");
    back.addEventListener("click", () => openCategoryLevelPicker(node, [], { stateWidgetName }));
    toolbar.appendChild(back);
    form.appendChild(toolbar);

    popup.appendChild(form);
    fitPopupToContent(popup);
    categoryInput.focus();
}

async function openEditPromptItemPopup(node, item, backHandler = null, options = {}) {
    const stateWidgetName = activatePopupStateWidget(node, options);
    setActiveStateWidget(node, stateWidgetName);
    const popup = openPopupShell(node, "候補を編集", { stateWidgetName });
    if (activePopupContext?.popup === popup) {
        activePopupContext.reopen = () => openEditPromptItemPopup(node, item, backHandler, { stateWidgetName });
    }

    const form = document.createElement("div");
    form.className = "pc-form";

    const categoryNote = document.createElement("div");
    categoryNote.className = "pc-form-note";
    categoryNote.textContent = displayCategoryLabel(itemCategoryLabel(item));
    form.appendChild(categoryNote);

    const nameLabel = document.createElement("label");
    nameLabel.textContent = "名前";
    const nameInput = document.createElement("input");
    nameInput.value = item.label || item.id || "";
    nameLabel.appendChild(nameInput);
    form.appendChild(nameLabel);

    const promptLabel = document.createElement("label");
    promptLabel.textContent = "プロンプト";
    const promptInput = document.createElement("textarea");
    promptInput.value = item.prompt || "";
    promptLabel.appendChild(promptInput);
    form.appendChild(promptLabel);

    const descLabel = document.createElement("label");
    descLabel.textContent = "説明";
    const descInput = document.createElement("textarea");
    descInput.value = item.description || "";
    descLabel.appendChild(descInput);
    form.appendChild(descLabel);

    const error = document.createElement("div");
    error.className = "pc-error";
    form.appendChild(error);

    const toolbar = document.createElement("div");
    toolbar.className = "pc-toolbar";
    const save = createButton("保存", "pc-on");
    save.addEventListener("click", async () => {
        error.textContent = "";
        save.disabled = true;
        try {
            const updated = await updatePromptItem({
                category_path: itemPath(item),
                original: {
                    id: item.id || "",
                    label: item.label || "",
                    prompt: item.prompt || "",
                    description: item.description || "",
                },
                label: nameInput.value,
                prompt: promptInput.value,
                description: descInput.value,
            });
            const selectedChanged = replaceSelectedPromptItem(node, item, updated, { stateWidgetName });
            const graphChanged = replacePromptItemEverywhere(item, updated);
            clearSceneComputedCaches(node);
            refreshNode(node, { fitHeight: true });
            if (selectedChanged || graphChanged) {
                refreshDownstreamSceneNodes(node);
                app.graph?.change?.();
                node.graph?.change?.();
            }
            if (backHandler) {
                backHandler(updated);
            } else {
                openSelectedPopup(node, { stateWidgetName });
            }
        } catch (editError) {
            save.disabled = false;
            error.textContent = editError.message || "プロンプト更新に失敗しました";
            fitPopupToContent(popup);
        }
    });
    toolbar.appendChild(save);

    const back = createButton("←戻る");
    back.addEventListener("click", () => {
        if (backHandler) {
            backHandler();
        } else {
            openSelectedPopup(node, { stateWidgetName });
        }
    });
    toolbar.appendChild(back);
    form.appendChild(toolbar);

    popup.appendChild(form);
    fitPopupToContent(popup);
    nameInput.focus();
}

async function openCategoryLevelPicker(node, path = [], options = {}) {
    const stateWidgetName = activatePopupStateWidget(node, options);
    const [data, saved] = await Promise.all([loadPromptItems(), loadSavedPrompts()]);
    setActiveStateWidget(node, stateWidgetName);
    const state = pruneStateToData(node, readStateFromWidget(node, stateWidgetName), data, { stateWidgetName });
    const children = getChildSegments(data, path);
    const directItems = itemsForPath(data, path);

    if (!children.length && directItems.length) {
        openPromptCandidatePopup(node, path, { stateWidgetName });
        return;
    }

    const popup = openPopupShell(node, path.length ? displayPathLabel(path) : "カテゴリ", { stateWidgetName });
    if (activePopupContext?.popup === popup) {
        activePopupContext.reopen = () => openCategoryLevelPicker(node, path, { stateWidgetName });
    }

    appendMatrixLineEditReturn(popup, node, { stateWidgetName });
    const toolbar = document.createElement("div");
    toolbar.className = "pc-toolbar";
    appendPopupNavButtons(toolbar, node, "list", { stateWidgetName });
    popup.appendChild(toolbar);

    appendMatrixLineBasePromptInput(popup, node, { stateWidgetName });
    const list = document.createElement("div");
    list.className = "pc-popup-list pc-popup-category-list";
    popup.appendChild(list);

    if (path.length) {
        appendBackButton(list, "←戻る", () => openCategoryLevelPicker(node, path.slice(0, -1), { stateWidgetName }));
    }

    if (directItems.length && children.length) {
        const directCounts = countExactForPath(data, state, path);
        const directCount = formatCategoryCount(directCounts);
        const direct = createButton(`この階層の候補 (${directCount})`);
        direct.classList.toggle("pc-on", !!directCounts.selected);
        direct.addEventListener("click", () => openPromptCandidatePopup(node, path, { stateWidgetName }));
        list.appendChild(direct);
    }

    if (!path.length && saved.length) {
        const counts = savedPromptCountForPath(saved, state, []);
        const countLabel = formatCategoryCount(counts);
        const option = createButton(`保存済みプロンプト (${countLabel})`);
        option.classList.toggle("pc-on", !!counts.selected);
        option.addEventListener("click", () => openSavedPromptLevelPicker(node, [], { stateWidgetName }));
        list.appendChild(option);
    }

    if (!children.length && !directItems.length) {
        if (!list.children.length) {
            const empty = document.createElement("div");
            empty.className = "pc-empty";
            empty.textContent = "カテゴリなし";
            list.appendChild(empty);
        }
        fitPopupToContent(popup);
        return;
    }

    for (const segment of children) {
        const nextPath = [...path, segment];
        const counts = countForPath(data, state, nextPath);
        const countLabel = formatCategoryCount(counts);
        const option = createButton(`${stripCountSuffix(segment)} (${countLabel})`);
        option.classList.toggle("pc-on", !!counts.selected);
        option.addEventListener("click", () => {
            const hasChildren = getChildSegments(data, nextPath).length > 0;
            const hasDirectItems = itemsForPath(data, nextPath).length > 0;
            if (hasChildren) {
                openCategoryLevelPicker(node, nextPath, { stateWidgetName });
            } else if (hasDirectItems) {
                openPromptCandidatePopup(node, nextPath, { stateWidgetName });
            } else {
                openCategoryLevelPicker(node, nextPath, { stateWidgetName });
            }
        });
        list.appendChild(option);
    }
    fitPopupToContent(popup);
}

async function openSavedPromptLevelPicker(node, path = [], options = {}) {
    const stateWidgetName = activatePopupStateWidget(node, options);
    const [data, saved] = await Promise.all([loadPromptItems(), loadSavedPrompts()]);
    setActiveStateWidget(node, stateWidgetName);
    const state = pruneStateToData(node, readStateFromWidget(node, stateWidgetName), data, { stateWidgetName });
    const children = getSavedPromptChildSegments(saved, path);
    const directPrompts = savedPromptsForPath(saved, path);
    const title = path.length ? `保存済みプロンプト > ${displayPathLabel(path)}` : "保存済みプロンプト";

    const popup = openPopupShell(node, title, { stateWidgetName });
    if (activePopupContext?.popup === popup) {
        activePopupContext.reopen = () => openSavedPromptLevelPicker(node, path, { stateWidgetName });
    }

    appendMatrixLineEditReturn(popup, node, { stateWidgetName });
    const toolbar = document.createElement("div");
    toolbar.className = "pc-toolbar";
    appendPopupNavButtons(toolbar, node, "list", { stateWidgetName });
    popup.appendChild(toolbar);

    appendMatrixLineBasePromptInput(popup, node, { stateWidgetName });
    const list = document.createElement("div");
    list.className = "pc-popup-list pc-popup-category-list";
    popup.appendChild(list);

    appendBackButton(list, "←戻る", () => {
        if (path.length) {
            openSavedPromptLevelPicker(node, path.slice(0, -1), { stateWidgetName });
        } else {
            openCategoryLevelPicker(node, [], { stateWidgetName });
        }
    });

    const selected = selectedKeys(state);
    for (const savedPrompt of directPrompts) {
        const row = appendSavedPromptRow(list, savedPrompt, () => {
            const nextSelected = selectedKeys(readStateFromWidget(node, stateWidgetName));
            setSavedPromptChecked(node, savedPrompt, !savedPromptMatches(savedPrompt, nextSelected), { stateWidgetName });
            openSavedPromptLevelPicker(node, path, { stateWidgetName });
        });
        row.classList.toggle("pc-on", savedPromptMatches(savedPrompt, selected));
    }

    for (const segment of children) {
        const nextPath = [...path, segment];
        const childDirect = savedPromptsForPath(saved, nextPath);
        const childSegments = getSavedPromptChildSegments(saved, nextPath);
        const counts = savedPromptCountForPath(saved, state, nextPath);
        const countLabel = formatCategoryCount(counts);
        const option = createButton(`${stripCountSuffix(segment)} (${countLabel})`);
        option.classList.toggle("pc-on", !!counts.selected);
        option.addEventListener("click", () => {
            if (!childSegments.length && childDirect.length === 1) {
                openSavedPromptLevelPicker(node, nextPath, { stateWidgetName });
            } else {
                openSavedPromptLevelPicker(node, nextPath, { stateWidgetName });
            }
        });
        list.appendChild(option);
    }

    if (!directPrompts.length && !children.length) {
        const empty = document.createElement("div");
        empty.className = "pc-empty";
        empty.textContent = "保存済みプロンプトなし";
        list.appendChild(empty);
    }

    fitPopupToContent(popup);
}

async function openPromptCandidatePopup(node, path, options = {}) {
    const stateWidgetName = activatePopupStateWidget(node, options);
    const data = await loadPromptItems();
    setActiveStateWidget(node, stateWidgetName);
    const popup = openPopupShell(node, displayPathLabel(path), { stateWidgetName });
    if (activePopupContext?.popup === popup) {
        activePopupContext.reopen = () => openPromptCandidatePopup(node, path, { stateWidgetName });
    }

    appendMatrixLineEditReturn(popup, node, { stateWidgetName });
    const toolbar = document.createElement("div");
    toolbar.className = "pc-toolbar";
    appendPopupNavButtons(toolbar, node, "list", { stateWidgetName });
    popup.appendChild(toolbar);

    appendMatrixLineBasePromptInput(popup, node, { stateWidgetName });
    const filter = document.createElement("input");
    filter.className = "pc-searchbox";
    filter.placeholder = "この階層内を検索";
    popup.appendChild(filter);

    const list = document.createElement("div");
    list.className = "pc-popup-list";
    popup.appendChild(list);

    const renderList = () => {
        const state = pruneStateToData(node, readStateFromWidget(node, stateWidgetName), data, { stateWidgetName });
        const selected = selectedKeys(state);
        const query = filter.value.trim().toLowerCase();
        const candidates = data
            .filter((item) => itemMatchesPath(item, path))
            .filter((item) => !query || itemSearchHaystack(item).includes(query));

        list.innerHTML = "";
        if (path.length) {
            appendBackButton(list, "←戻る", () => openCategoryLevelPicker(node, path.slice(0, -1), { stateWidgetName }));
        }
        if (!candidates.length) {
            const empty = document.createElement("div");
            empty.className = "pc-empty";
            empty.textContent = "候補なし";
            list.appendChild(empty);
            fitPopupToContent(popup);
            return;
        }

        for (const item of candidates) {
            appendCandidateRow(list, node, item, selected, null, { stateWidgetName, state });
        }
        fitPopupToContent(popup);
    };

    filter.addEventListener("input", renderList);
    renderList();
    fitPopupToContent(popup);
    filter.focus();
}

async function openSelectedPopup(node, options = {}) {
    const stateWidgetName = activatePopupStateWidget(node, options);
    const [data, saved] = await Promise.all([loadPromptItems(), loadSavedPrompts()]);
    setActiveStateWidget(node, stateWidgetName);
    const displayState = cloneSelectionState(pruneStateToData(node, readStateFromWidget(node, stateWidgetName), data, { stateWidgetName }));
    const popup = openPopupShell(node, "選択済み一覧", { stateWidgetName });
    if (activePopupContext?.popup === popup) {
        activePopupContext.reopen = () => openSelectedPopup(node, { stateWidgetName });
    }

    appendMatrixLineEditReturn(popup, node, { stateWidgetName });
    const toolbar = document.createElement("div");
    toolbar.className = "pc-toolbar";
    appendPopupNavButtons(toolbar, node, "selected", { stateWidgetName });
    popup.appendChild(toolbar);

    appendMatrixLineBasePromptInput(popup, node, { stateWidgetName });
    const list = document.createElement("div");
    list.className = "pc-popup-list";
    popup.appendChild(list);

    const renderSelected = () => {
        const state = pruneStateToData(node, readStateFromWidget(node, stateWidgetName), data, { stateWidgetName });
        mergeSelectedItemsForDisplay(displayState, state);
        const matchedSaved = matchedSavedPrompts(displayState, saved);
        const categories = uncoveredCategories(displayState, matchedSaved);
        const selected = selectedKeys(state);

        list.innerHTML = "";
        if (matchedSaved.length) {
            const heading = document.createElement("div");
            heading.className = "pc-saved-heading";
            heading.textContent = "保存済みプロンプト";
            list.appendChild(heading);
            for (const savedPrompt of matchedSaved) {
                appendSavedPromptRow(list, savedPrompt, () => openSavedPromptDetailPopup(node, savedPrompt, { stateWidgetName }));
            }
        }

        if (!matchedSaved.length && !categories.length) {
            fitPopupToContent(popup);
            return;
        }

        for (const [category, items] of categories) {
            const heading = document.createElement("div");
            heading.className = "pc-selected-heading";
            heading.textContent = displayCategoryLabel(category);
            list.appendChild(heading);

            const chipList = document.createElement("div");
            chipList.className = "pc-chip-list";
            list.appendChild(chipList);

            for (const item of items) {
                appendCandidateChip(chipList, node, item, selected, renderSelected, {
                    allowEdit: true,
                    keepVisibleWhenUnchecked: true,
                    stateWidgetName,
                });
            }
        }
        fitPopupToContent(popup);
    };

    renderSelected();
    fitPopupToContent(popup);
}

async function openSavedPromptDetailPopup(node, savedPrompt, options = {}) {
    const stateWidgetName = activatePopupStateWidget(node, options);
    await loadPromptItems();
    setActiveStateWidget(node, stateWidgetName);
    const popup = openPopupShell(node, savedPrompt.name || "保存済みプロンプト", { stateWidgetName });
    if (activePopupContext?.popup === popup) {
        activePopupContext.reopen = () => openSavedPromptDetailPopup(node, savedPrompt, { stateWidgetName });
    }

    appendMatrixLineEditReturn(popup, node, { stateWidgetName });
    const toolbar = document.createElement("div");
    toolbar.className = "pc-toolbar";
    appendPopupNavButtons(toolbar, node, "selected", { stateWidgetName });
    popup.appendChild(toolbar);

    appendMatrixLineBasePromptInput(popup, node, { stateWidgetName });
    const list = document.createElement("div");
    list.className = "pc-popup-list";
    popup.appendChild(list);

    const renderItems = () => {
        const selected = selectedKeys(readStateFromWidget(node, stateWidgetName));
        list.innerHTML = "";
        appendBackButton(list, "←戻る", () => openSelectedPopup(node, { stateWidgetName }));
        const chipList = document.createElement("div");
        chipList.className = "pc-chip-list";
        for (const item of savedPrompt.items || []) {
            appendCandidateChip(chipList, node, item, selected, renderItems, { stateWidgetName });
        }
        if (chipList.children.length) {
            list.appendChild(chipList);
        } else {
            const empty = document.createElement("div");
            empty.className = "pc-empty";
            empty.textContent = "候補なし";
            list.appendChild(empty);
        }
        fitPopupToContent(popup);
    };

    renderItems();
    fitPopupToContent(popup);
}

async function openSearchPopup(node, options = {}) {
    const stateWidgetName = activatePopupStateWidget(node, options);
    const data = await loadPromptItems();
    setActiveStateWidget(node, stateWidgetName);
    const popup = openPopupShell(node, "候補検索", { stateWidgetName });
    if (activePopupContext?.popup === popup) {
        activePopupContext.reopen = () => openSearchPopup(node, { stateWidgetName });
    }

    appendMatrixLineEditReturn(popup, node, { stateWidgetName });
    const toolbar = document.createElement("div");
    toolbar.className = "pc-toolbar";
    appendPopupNavButtons(toolbar, node, "search", { stateWidgetName });
    popup.appendChild(toolbar);

    appendMatrixLineBasePromptInput(popup, node, { stateWidgetName });
    const input = document.createElement("input");
    input.className = "pc-searchbox";
    input.placeholder = "カテゴリ / サブカテゴリ / ラベル / 説明 / prompt を検索";
    popup.appendChild(input);

    const list = document.createElement("div");
    list.className = "pc-popup-list";
    popup.appendChild(list);

    const renderResults = () => {
        const state = pruneStateToData(node, readStateFromWidget(node, stateWidgetName), data, { stateWidgetName });
        const selected = selectedKeys(state);
        const query = input.value.trim().toLowerCase();
        const matchedCategories = query ? searchCategoryPaths(data, query, 1).slice(0, 80) : [];
        const matchedSubcategories = query ? searchCategoryPaths(data, query, 2).slice(0, 160) : [];
        const matchedItems = query
            ? data.filter((item) => itemSearchHaystack(item).includes(query)).slice(0, 240)
            : [];

        list.innerHTML = "";
        if (!query) {
            const empty = document.createElement("div");
            empty.className = "pc-empty";
            empty.textContent = "検索語を入力";
            list.appendChild(empty);
            fitPopupToContent(popup);
            return;
        }
        if (!matchedCategories.length && !matchedSubcategories.length && !matchedItems.length) {
            const empty = document.createElement("div");
            empty.className = "pc-empty";
            empty.textContent = "一致なし";
            list.appendChild(empty);
            fitPopupToContent(popup);
            return;
        }
        if (matchedCategories.length) {
            appendSearchHeading(list, "カテゴリ");
        for (const path of matchedCategories) {
            appendSearchPathRow(list, node, data, state, path, { stateWidgetName });
        }
        }
        if (matchedSubcategories.length) {
            appendSearchHeading(list, "サブカテゴリ");
        for (const path of matchedSubcategories) {
            appendSearchPathRow(list, node, data, state, path, { stateWidgetName });
        }
        }
        if (matchedItems.length) {
            appendSearchHeading(list, "候補");
        }
        for (const item of matchedItems) {
            appendCandidateRow(list, node, item, selected, null, { backToSearch: true, showPath: true, stateWidgetName, state });
        }
        fitPopupToContent(popup);
    };

    input.addEventListener("input", renderResults);
    renderResults();
    fitPopupToContent(popup);
    input.focus();
}

function hideWidget(widget) {
    if (!widget) {
        return;
    }
    widget.sceneHiddenStoredType = widget.sceneHiddenStoredType || widget.type;
    widget.sceneHiddenStoredComputeSize = widget.sceneHiddenStoredComputeSize || widget.computeSize;
    widget.sceneHiddenStoredDraw = widget.sceneHiddenStoredDraw || widget.draw;
    widget.hidden = true;
    widget.options = widget.options || {};
    widget.options.hidden = true;
    widget.type = "hidden";
    widget.computeSize = () => [0, 0];
    widget.draw = () => {};
    const element = widget.inputEl || widget.element || widget.domElement;
    const container = element?.closest?.(".dom-widget") || element;
    if (container?.style) {
        container.classList?.add("scene-prompt-owned-widget");
        container.style.setProperty("display", "none", "important");
    }
}

function showWidget(widget) {
    if (!widget) {
        return;
    }
    widget.hidden = false;
    if (widget.options) {
        widget.options.hidden = false;
    }
    if (widget.sceneHiddenStoredType && widget.sceneHiddenStoredType !== "hidden") {
        widget.type = widget.sceneHiddenStoredType;
    }
    if (widget.sceneHiddenStoredComputeSize) {
        widget.computeSize = widget.sceneHiddenStoredComputeSize;
    }
    if (widget.sceneHiddenStoredDraw) {
        widget.draw = widget.sceneHiddenStoredDraw;
    }
    const element = widget.inputEl || widget.element || widget.domElement;
    const container = element?.closest?.(".dom-widget") || element;
    if (container?.style) {
        container.classList?.remove("scene-prompt-owned-widget");
        container.style.removeProperty("display");
    }
}

function hideScenePromptWidgets(node) {
    const visibleWidgets = new Set(["positive_base", "negative_base"]);
    for (const widget of node.widgets || []) {
        if (widget?.sceneRole || visibleWidgets.has(widget?.name)) {
            showWidget(widget);
        } else {
            hideWidget(widget);
        }
    }
}

function hideScenePathWidgets(node) {
    const visibleWidgets = new Set(["path_mode"]);
    for (const widget of node.widgets || []) {
        if (widget?.sceneRole || visibleWidgets.has(widget?.name)) {
            showWidget(widget);
        } else {
            hideWidget(widget);
        }
    }
}

function hideScenePromptCounterWidgets(node) {
    const visibleWidgets = new Set(["count"]);
    for (const widget of node.widgets || []) {
        if (widget?.sceneRole || visibleWidgets.has(widget?.name)) {
            showWidget(widget);
        } else {
            hideWidget(widget);
        }
    }
}

function scenePromptTitle(node) {
    const title = String(node?.title || "").trim();
    if (title && title !== "ScenePrompt" && title !== "Scene Prompt") {
        return title;
    }
    return title || "Scene Prompt";
}

function syncScenePromptNameFromTitle(node) {
    const widget = findWidget(node, "prompt_name");
    if (!widget) {
        return;
    }
    const nextName = scenePromptTitle(node);
    if (widget.value !== nextName) {
        setWidgetValue(node, "prompt_name", nextName);
    }
}

function scenePathTitle(node) {
    const title = String(node?.title || "").trim();
    if (title && title !== "ScenePath" && title !== "Scene Path") {
        return title;
    }
    return title || "Scene Path";
}

function syncScenePathNameFromTitle(node) {
    const widget = findWidget(node, "path_name");
    if (!widget) {
        return;
    }
    const nextName = scenePathTitle(node);
    if (widget.value !== nextName) {
        setWidgetValue(node, "path_name", nextName);
    }
}

function hidePromptMatrixWidgets(node) {
    const visibleWidgets = new Set();
    for (const widget of node.widgets || []) {
        if (widget?.sceneRole || visibleWidgets.has(widget?.name)) {
            showWidget(widget);
        } else {
            hideWidget(widget);
        }
    }
}

function hideNonSceneRoleWidgets(node) {
    const visibleWidgets = new Set();
    for (const widget of node.widgets || []) {
        if (widget?.sceneRole || visibleWidgets.has(widget?.name)) {
            showWidget(widget);
        } else {
            hideWidget(widget);
        }
    }
}

function hideSceneUtilityWidgets(node, nodeName) {
    const visibleWidgets = SCENE_SAVE_IMAGE_NODE_NAMES.has(nodeName)
        ? new Set(["path", "metadata_mode"])
        : isSceneExpandNodeName(nodeName)
            ? new Set(["timestamp_dir", "prefix"])
            : SCENE_EMPTY_LATENT_NODE_NAMES.has(nodeName)
                ? new Set(["width", "height", "batch_size"])
                : new Set();
    for (const widget of node.widgets || []) {
        if (widget?.sceneRole || visibleWidgets.has(widget?.name)) {
            showWidget(widget);
        } else {
            hideWidget(widget);
        }
    }
}

function hideInternalDomWidgets() {
    for (const node of app.graph?._nodes || []) {
        if (!nodeClassNames(node).some((name) => NODE_NAMES.has(name))) {
            continue;
        }
        for (const widget of node.widgets || []) {
            if (widget?.hidden || widget?.type === "hidden") {
                hideWidget(widget);
            }
        }
    }
}

function scheduleHideInternalDomWidgets() {
    if (hideInternalDomWidgetsScheduled) {
        return;
    }
    hideInternalDomWidgetsScheduled = true;
    requestAnimationFrame(() => {
        hideInternalDomWidgetsScheduled = false;
        hideInternalDomWidgets();
        clearTimeout(hideInternalDomWidgetsTimerShort);
        clearTimeout(hideInternalDomWidgetsTimerLong);
        hideInternalDomWidgetsTimerShort = setTimeout(hideInternalDomWidgets, 80);
        hideInternalDomWidgetsTimerLong = setTimeout(hideInternalDomWidgets, 250);
    });
}

function removeInternalInputSockets(node, options = {}) {
    if (!Array.isArray(node.inputs)) {
        return;
    }
    const visibleNames = options.visibleNames || VISIBLE_INPUT_NAMES;
    const removeAllExceptVisible = !!options.removeAllExceptVisible;
    for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
        const input = node.inputs[index];
        const name = String(input?.name || "");
        if (visibleNames.has(name)) {
            continue;
        }
        if (removeAllExceptVisible || INTERNAL_INPUT_NAMES.has(name)) {
            if (typeof node.removeInput === "function") {
                node.removeInput(index);
            } else {
                node.inputs.splice(index, 1);
            }
        }
    }
}

function syncInputLinkTargetSlots(node) {
    const graph = node?.graph || app.graph;
    if (!node || !Array.isArray(node.inputs) || !graph?.links) {
        return;
    }
    node.inputs.forEach((input, index) => {
        if (input?.link == null) {
            return;
        }
        const link = graph.links[input.link];
        if (!link) {
            return;
        }
        link.target_id = node.id;
        link.target_slot = index;
    });
}

function syncOutputLinkOriginSlots(node) {
    const graph = node?.graph || app.graph;
    if (!node || !Array.isArray(node.outputs) || !graph?.links) {
        return;
    }
    node.outputs.forEach((output, index) => {
        for (const linkId of output?.links || []) {
            const link = graph.links[linkId];
            if (!link) {
                continue;
            }
            link.origin_id = node.id;
            link.origin_slot = index;
        }
    });
}

function labelScenePromptInputSocket(input, name = "scene_prompt") {
    if (!input) {
        return;
    }
    input.name = name;
    input.type = SCENE_PROMPT_SOCKET_TYPE;
    input.label = name;
    input.display_name = name;
    input.localized_name = name;
}

function labelScenePromptOutputSocket(output, name = "scene_prompt") {
    if (!output) {
        return;
    }
    output.name = name;
    output.type = SCENE_PROMPT_SOCKET_TYPE;
    output.label = name;
    output.display_name = name;
    output.localized_name = name;
}

function ensureScenePromptInput(node, name = "scene_prompt") {
    node.inputs = Array.isArray(node.inputs) ? node.inputs : [];
    let input = node.inputs.find((candidate) => candidate?.name === name);
    if (!input && typeof node.addInput === "function") {
        node.addInput(name, SCENE_PROMPT_SOCKET_TYPE, {
            display_name: name,
            label: name,
        });
        input = node.inputs.find((candidate) => candidate?.name === name);
    }
    if (!input) {
        input = {
            name,
            type: SCENE_PROMPT_SOCKET_TYPE,
            link: null,
        };
        node.inputs.push(input);
    }
    labelScenePromptInputSocket(input, name);
    return input;
}

function ensureScenePromptOutput(node, name = "scene_prompt") {
    node.outputs = Array.isArray(node.outputs) ? node.outputs : [];
    let output = node.outputs.find((candidate) => candidate?.name === name);
    if (!output && typeof node.addOutput === "function") {
        node.addOutput(name, SCENE_PROMPT_SOCKET_TYPE, {
            display_name: name,
            label: name,
        });
        output = node.outputs.find((candidate) => candidate?.name === name);
    }
    if (!output) {
        output = {
            name,
            type: SCENE_PROMPT_SOCKET_TYPE,
            links: [],
        };
        node.outputs.push(output);
    }
    output.links = Array.isArray(output.links) ? output.links : [];
    labelScenePromptOutputSocket(output, name);
    return output;
}

function normalizeSceneMatrixSockets(node) {
    if (!node) {
        return;
    }
    ensureScenePromptInput(node, "scene_prompt");
    removeInternalInputSockets(node, {
        visibleNames: new Set(["scene_prompt"]),
        removeAllExceptVisible: true,
    });
    syncInputLinkTargetSlots(node);

    const sceneOutput = ensureScenePromptOutput(node, "scene_prompt");
    labelScenePromptOutputSocket(sceneOutput, "scene_prompt");
    syncOutputLinkOriginSlots(node);
}

function normalizeScenePromptMergeSockets(node) {
    if (!node) {
        return;
    }
    ensureScenePromptInput(node, "scene_prompt1");
    ensureScenePromptInput(node, "scene_prompt2");
    removeInternalInputSockets(node, {
        visibleNames: SCENE_PROMPT_MERGE_INPUT_NAMES,
        removeAllExceptVisible: true,
    });
    syncInputLinkTargetSlots(node);

    const sceneOutput = ensureScenePromptOutput(node, "scene_prompt");
    labelScenePromptOutputSocket(sceneOutput, "scene_prompt");
    syncOutputLinkOriginSlots(node);
}

function ensureScenePromptQueueInputs(node) {
    if (!node) {
        return;
    }
    node.inputs = Array.isArray(node.inputs) ? node.inputs : [];
    for (let index = 1; index <= SCENE_PROMPT_QUEUE_INPUT_COUNT; index += 1) {
        const name = `scene_prompt${index}`;
        let input = node.inputs.find((candidate) => candidate?.name === name);
        if (!input) {
            if (typeof node.addInput === "function") {
                node.addInput(name, SCENE_PROMPT_SOCKET_TYPE, {
                    display_name: name,
                    label: name,
                });
                input = node.inputs.find((candidate) => candidate?.name === name);
            } else {
                input = {
                    name,
                    type: SCENE_PROMPT_SOCKET_TYPE,
                    link: null,
                };
                node.inputs.push(input);
            }
        }
        labelScenePromptInput(input, index);
    }
}

function normalizeScenePromptQueueInputs(node) {
    if (!node) {
        return;
    }
    ensureScenePromptQueueInputs(node);
    removeInternalInputSockets(node, {
        visibleNames: SCENE_PROMPT_QUEUE_INPUT_NAMES,
        removeAllExceptVisible: true,
    });
    syncScenePromptQueueInputs(node);
    syncInputLinkTargetSlots(node);
}

function findSceneWidget(node, role) {
    return node.widgets?.find((widget) => widget.sceneRole === role);
}

function addSceneButton(node, role, name, callback) {
    const existing = findSceneWidget(node, role);
    if (existing) {
        existing.name = name;
        existing.callback = callback;
        showWidget(existing);
        return existing;
    }
    const widget = node.addWidget("button", name, null, callback, { serialize: false });
    widget.sceneRole = role;
    widget.serialize = false;
    return widget;
}

function estimateChipWidth(label, availableWidth) {
    if (!chipMeasureContext && typeof document !== "undefined") {
        const canvas = document.createElement("canvas");
        chipMeasureContext = canvas.getContext("2d");
    }
    if (chipMeasureContext) {
        chipMeasureContext.font = "11px sans-serif";
        const measured = Math.ceil(chipMeasureContext.measureText(String(label || "")).width) + CHIP_TEXT_PAD_X * 2;
        return Math.min(Math.max(38, measured), Math.max(40, availableWidth));
    }

    const textWidth = Array.from(String(label || "")).reduce((sum, char) => {
        return sum + (char.charCodeAt(0) > 255 ? 9 : 7);
    }, 0);
    return Math.min(Math.max(38, textWidth + CHIP_TEXT_PAD_X * 2), Math.max(40, availableWidth));
}

function selectedListSections(node, options = {}) {
    if (Array.isArray(options.sections)) {
        return options.sections;
    }
    const state = options.state || readStateFromWidget(node, options.stateWidgetName || activeStateWidgetName(node));
    const saved = matchedSavedPrompts(state);
    const categories = uncoveredCategories(state, saved);
    const sections = [];
    for (const savedPrompt of saved) {
        sections.push({
            title: savedPrompt.name || savedPrompt.id || "保存済みプロンプト",
            type: "saved",
            items: savedPrompt.items || [],
        });
    }
    for (const [category, items] of categories) {
        sections.push({
            title: displayCategoryLabel(category),
            type: "category",
            items,
        });
    }
    return sections;
}

function selectedListLayout(node, width, ctx = null, options = {}) {
    const sections = selectedListSections(node, options);
    if (!sections.length) {
        return { empty: true, height: SELECTED_LIST_MIN_HEIGHT, sections: [] };
    }

    const x0 = 10;
    const nodeWidth = width || node.size?.[0] || 360;
    const lineRight = Math.max(x0 + 120, nodeWidth - 10);
    const available = Math.max(48, lineRight - x0);
    const layouts = [];
    let cursorY = 12;
    let maxBottom = 0;

    for (const section of sections) {
        const sectionLayout = {
            title: section.title,
            type: section.type,
            titleY: cursorY,
            chips: [],
        };
        maxBottom = Math.max(maxBottom, cursorY + 8);
        cursorY += 18;

        let cursorX = x0;
        for (const item of section.items || []) {
            const label = itemBaseLabel(item);
            const chipWidth = estimateChipWidthWithContext(label, available, ctx);
            if (cursorX > x0 && cursorX + chipWidth > lineRight) {
                cursorX = x0;
                cursorY += CHIP_HEIGHT + CHIP_LINE_GAP;
            }
            const chipY = cursorY - 9;
            sectionLayout.chips.push({
                item,
                label,
                x: cursorX,
                y: chipY,
                width: chipWidth,
            });
            maxBottom = Math.max(maxBottom, chipY + CHIP_HEIGHT);
            cursorX += chipWidth + CHIP_GAP;
        }
        if (!sectionLayout.chips.length) {
            maxBottom = Math.max(maxBottom, cursorY + 6);
        }
        cursorY += CHIP_HEIGHT + 7;
        layouts.push(sectionLayout);
    }

    return {
        empty: false,
        height: Math.max(SELECTED_LIST_MIN_HEIGHT, Math.ceil(maxBottom + 14)),
        sections: layouts,
    };
}

function estimateChipWidthWithContext(label, availableWidth, ctx = null) {
    if (ctx) {
        const previousFont = ctx.font;
        ctx.font = "11px sans-serif";
        const measured = Math.ceil(ctx.measureText(String(label || "")).width) + CHIP_TEXT_PAD_X * 2;
        ctx.font = previousFont;
        return Math.min(Math.max(38, measured), Math.max(40, availableWidth));
    }
    return estimateChipWidth(label, availableWidth);
}

function selectedListLayoutWidth(node, width = null) {
    const nodeWidth = node.size?.[0] || 0;
    const drawWidth = Number.isFinite(width) ? width : 0;
    return Math.max(120, (nodeWidth || drawWidth || 360) - SELECTED_LIST_WIDTH_GUARD);
}

function selectedListLayoutCacheKey(node, width, options = {}) {
    const stateWidgetName = options.stateWidgetName || activeStateWidgetName(node);
    const stateWidget = findWidget(node, stateWidgetName);
    return JSON.stringify({
        stateWidgetName,
        width: Math.ceil(width || 0),
        state: String(stateWidget?.value || DEFAULT_SELECTED_JSON),
    });
}

function cachedSelectedListLayout(node, width, options = {}) {
    if (options.sections || options.state) {
        return selectedListLayout(node, width, null, options);
    }
    const cacheKey = selectedListLayoutCacheKey(node, width, options);
    const cache = node.sceneSelectedListLayoutCache;
    if (cache?.has(cacheKey)) {
        return cache.get(cacheKey);
    }
    const stateWidgetName = options.stateWidgetName || activeStateWidgetName(node);
    const layout = selectedListLayout(node, width, null, {
        ...options,
        stateWidgetName,
        state: readStateFromWidget(node, stateWidgetName),
    });
    const nextCache = cache || new Map();
    nextCache.set(cacheKey, layout);
    while (nextCache.size > 8) {
        nextCache.delete(nextCache.keys().next().value);
    }
    node.sceneSelectedListLayoutCache = nextCache;
    return layout;
}

function selectedListHeight(node, width = null, options = {}) {
    if (!sceneShouldDrawDetails()) {
        return SCENE_COMPACT_WIDGET_HEIGHT;
    }
    return cachedSelectedListLayout(node, selectedListLayoutWidth(node, width), options).height + SELECTED_LIST_HEIGHT_GUARD;
}

function roundedRect(ctx, x, y, width, height, radius) {
    if (ctx.roundRect) {
        ctx.roundRect(x, y, width, height, radius);
        return;
    }
    const r = Math.min(radius, width / 2, height / 2);
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
}

function fitCanvasText(ctx, value, maxWidth) {
    const text = String(value || "");
    if (!Number.isFinite(maxWidth) || maxWidth <= 0 || ctx.measureText(text).width <= maxWidth) {
        return text;
    }

    const chars = Array.from(text);
    const suffix = "...";
    let low = 0;
    let high = chars.length;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const candidate = `${chars.slice(0, mid).join("")}${suffix}`;
        if (ctx.measureText(candidate).width <= maxWidth) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    return `${chars.slice(0, Math.max(0, low)).join("")}${suffix}`;
}

function selectedListRenderCacheName(role) {
    return role === "negative_selected_list"
        ? "sceneSelectedListNegativeRenderCache"
        : "sceneSelectedListPositiveRenderCache";
}

function drawSelectedListContent(ctx, layout) {
    const x0 = 10;
    if (layout.empty) {
        return;
    }

    ctx.font = "12px sans-serif";
    ctx.textBaseline = "middle";
    for (const section of layout.sections) {
        const isSaved = section.type === "saved";
        ctx.fillStyle = isSaved ? "#e7d6ff" : "#dfe8f5";
        ctx.font = "bold 11px sans-serif";
        ctx.fillText(section.title, x0, section.titleY);

        ctx.font = "11px sans-serif";
        for (const chip of section.chips) {
            ctx.fillStyle = isSaved ? "#3b285a" : "#244832";
            ctx.strokeStyle = isSaved ? "#8564c7" : "#4d9b63";
            ctx.beginPath();
            roundedRect(ctx, chip.x, chip.y, chip.width, CHIP_HEIGHT, 5);
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = isSaved ? "#f4edff" : "#effff3";
            const measured = Math.ceil(ctx.measureText(chip.label).width) + CHIP_TEXT_PAD_X * 2;
            const text = measured > chip.width
                ? `${chip.label.slice(0, Math.max(1, Math.floor((chip.width - CHIP_TEXT_PAD_X * 2 - 10) / 7)))}...`
                : chip.label;
            ctx.fillText(text, chip.x + CHIP_TEXT_PAD_X, chip.y + 10);
        }
    }
}

function drawSelectedList(ctx, node, width, y, height, options = {}) {
    const drawWidth = sceneWidgetDrawWidth(node, width, 360);
    if (!sceneShouldDrawDetails()) {
        drawSceneCompactWidget(ctx, node, drawWidth, y, height, "selected");
        return;
    }
    const role = options.role || "positive_selected_list";
    const layout = cachedSelectedListLayout(node, selectedListLayoutWidth(node, drawWidth), options);
    const drawHeight = sceneWidgetDrawHeight(
        node,
        role,
        y,
        height,
        selectedListHeight(node, drawWidth, options),
        SELECTED_LIST_MIN_HEIGHT,
    );
    const canvas = cachedSceneWidgetCanvas(
        node,
        selectedListRenderCacheName(role),
        drawWidth,
        drawHeight,
        (renderCtx) => drawSelectedListContent(renderCtx, layout),
    );

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y, drawWidth, drawHeight);
    ctx.clip();
    if (canvas) {
        ctx.drawImage(canvas, 0, y, drawWidth, drawHeight);
    } else {
        ctx.translate(0, y);
        drawSelectedListContent(ctx, layout);
    }
    ctx.restore();
}

function addSelectedListWidget(node, options = {}) {
    const role = options.role || "positive_selected_list";
    const stateWidgetName = options.stateWidgetName || activeStateWidgetName(node);
    const existing = findSceneWidget(node, role);
    if (existing) {
        existing.stateWidgetName = stateWidgetName;
        return existing;
    }
    const widget = {
        type: "scene_selected_list",
        name: "選択済み一覧",
        value: "",
        serialize: false,
        options: { serialize: false },
        sceneRole: role,
        stateWidgetName,
        computeSize(width) {
            const drawWidth = sceneWidgetDrawWidth(node, width, 360);
            return [drawWidth, selectedListHeight(node, drawWidth, { stateWidgetName })];
        },
        draw(ctx, drawNode, width, y, height) {
            drawSelectedList(ctx, drawNode, width, y, height, { role, stateWidgetName });
        },
    };
    if (options.name) {
        widget.name = options.name;
    }
    node.widgets = node.widgets || [];
    node.widgets.push(widget);
    return widget;
}

function visibleWidgetTotalHeight(node, options = {}) {
    let total = 12;
    for (const widget of node.widgets || []) {
        if (widget.hidden || widget.type === "hidden" || widget.options?.hidden) {
            continue;
        }
        total += sceneWidgetMeasuredHeight(node, widget, node.size?.[0] || 420) + 1;
    }
    return total;
}

function sceneWidgetNaturalHeight(node, widget, width) {
    const role = widget?.sceneRole || "";
    const detailsForSizing = !!node?.sceneForceNaturalWidgetHeight || sceneShouldDrawDetails();
    if (role.endsWith("_selected_list")) {
        return selectedListHeight(node, width, { stateWidgetName: widget.stateWidgetName });
    }
    if (role === "matrix_connected_list") {
        return detailsForSizing ? matrixDisplayCache(node, width).naturalHeight : SCENE_COMPACT_WIDGET_HEIGHT;
    }
    if (role === "scene_prompt_merge_list") {
        return detailsForSizing ? scenePromptMergeDisplayCache(node, width).naturalHeight : SCENE_COMPACT_WIDGET_HEIGHT;
    }
    if (role === "scene_prompt_queue_list") {
        return SCENE_COMPACT_WIDGET_HEIGHT;
    }
    if (role === "expand_total_count") {
        return 22;
    }
    if (widget.sceneMeasuringHeight) {
        return WIDGET_ROW_HEIGHT;
    }
    widget.sceneMeasuringHeight = true;
    try {
        const size = widget.computeSize?.(width) || [0, WIDGET_ROW_HEIGHT];
        return Math.max(0, Number(size[1] ?? WIDGET_ROW_HEIGHT));
    } finally {
        widget.sceneMeasuringHeight = false;
    }
}

function sceneWidgetMeasuredHeight(node, widget, width) {
    if (widget.hidden || widget.type === "hidden" || widget.options?.hidden) {
        return 0;
    }
    const computed = Number(widget.computedHeight || 0);
    if (!node?.sceneForceNaturalWidgetHeight && Number.isFinite(computed) && computed > 0) {
        return computed;
    }
    return sceneWidgetNaturalHeight(node, widget, width);
}

function resizableSceneWidgetHeight(node, role, naturalHeight, minimumHeight = 40) {
    const natural = Math.max(minimumHeight, Number(naturalHeight || 0));
    const cappedNaturalHeight = Math.min(natural, SCENE_NODE_AUTO_FIT_MAX_HEIGHT);
    if (node?.sceneForceNaturalWidgetHeight) {
        return cappedNaturalHeight;
    }

    const nodeHeight = Number(node?.size?.[1] || 0);
    if (!nodeHeight) {
        return cappedNaturalHeight;
    }

    let used = 12;
    for (const widget of node.widgets || []) {
        if (widget.hidden || widget.type === "hidden" || widget.options?.hidden || widget.sceneRole === role) {
            continue;
        }
        used += sceneWidgetMeasuredHeight(node, widget, node.size?.[0] || 420) + 1;
    }

    return clamp(nodeHeight - used - 4, 0, natural);
}

function sceneWidgetDrawHeight(node, role, y, height, naturalHeight, minimumHeight = 40) {
    const widget = findSceneWidget(node, role);
    const candidates = [height, widget?.computedHeight, naturalHeight]
        .map((value) => Number(value || 0))
        .filter((value) => Number.isFinite(value) && value > 0);
    let drawHeight = Math.max(minimumHeight, ...candidates);
    const nodeHeight = Number(node?.size?.[1] || 0);
    const top = Number(y || 0);
    if (nodeHeight > 0 && Number.isFinite(top)) {
        const available = Math.max(0, nodeHeight - top - 6);
        drawHeight = Math.min(drawHeight, available);
    }
    return Math.max(0, drawHeight);
}

function sceneWidgetDrawWidth(node, width, defaultWidth = 360) {
    const nodeWidth = Number(node?.size?.[0] || 0);
    if (Number.isFinite(nodeWidth) && nodeWidth > 0) {
        return Math.max(80, nodeWidth);
    }
    const drawWidth = Number(width || 0);
    if (Number.isFinite(drawWidth) && drawWidth > 0) {
        return Math.max(80, drawWidth);
    }
    return Math.max(80, defaultWidth);
}

function sceneCanvasScale() {
    const scale = Number(app?.canvas?.ds?.scale || 1);
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function sceneShouldDrawDetails() {
    return sceneCanvasScale() >= SCENE_DETAIL_MIN_SCALE;
}

function sceneWidgetCanvasRatio() {
    return Math.min(3, Math.max(1, Number(window.devicePixelRatio || 1)));
}

function drawSceneCompactWidget(ctx, node, width, y, height, tone = "matrix") {
    const drawWidth = sceneWidgetDrawWidth(node, width, tone === "matrix" ? MATRIX_NODE_DEFAULT_WIDTH : 360);
    const drawHeight = Math.min(
        Math.max(SCENE_COMPACT_WIDGET_HEIGHT, Number(height || SCENE_COMPACT_WIDGET_HEIGHT)),
        SCENE_COMPACT_WIDGET_HEIGHT,
    );
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = "#6da0c2";
    ctx.beginPath();
    roundedRect(ctx, 10, y + 3, Math.max(50, drawWidth - 20), Math.max(8, drawHeight - 6), 4);
    ctx.stroke();
    ctx.restore();
}

function cachedSceneWidgetCanvas(node, cacheName, width, height, render) {
    const drawWidth = Math.max(1, Math.ceil(width || 1));
    const drawHeight = Math.max(1, Math.ceil(height || 1));
    const ratio = sceneWidgetCanvasRatio();
    if (drawWidth * drawHeight * ratio * ratio > SCENE_WIDGET_CANVAS_MAX_PIXELS) {
        return null;
    }
    const cache = node?.[cacheName];
    if (cache?.canvas && cache.width === drawWidth && cache.height === drawHeight && cache.ratio === ratio) {
        return cache.canvas;
    }

    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(drawWidth * ratio);
    canvas.height = Math.ceil(drawHeight * ratio);
    const renderCtx = canvas.getContext("2d");
    renderCtx.imageSmoothingEnabled = true;
    renderCtx.imageSmoothingQuality = "high";
    renderCtx.scale(ratio, ratio);
    render(renderCtx, drawWidth, drawHeight);
    node[cacheName] = {
        canvas,
        width: drawWidth,
        height: drawHeight,
        ratio,
    };
    return canvas;
}

function setNodeSize(node, width, height, options = {}) {
    const minWidth = options.minWidth ?? 430;
    const nextWidth = Math.max(minWidth, Math.ceil(width || minWidth));
    const nextHeight = Math.max(80, Math.ceil(height || 80));
    const currentWidth = Math.ceil(node.size?.[0] || 0);
    const currentHeight = Math.ceil(node.size?.[1] || 0);
    if (currentWidth === nextWidth && currentHeight === nextHeight) {
        return;
    }
    if (typeof node.setSize === "function") {
        node.setSize([nextWidth, nextHeight]);
    } else if (node.size) {
        node.size[0] = nextWidth;
        node.size[1] = nextHeight;
    }
}

function sceneAutoFitHeight(height) {
    return Math.min(Math.max(80, Math.ceil(height || 80)), SCENE_NODE_AUTO_FIT_MAX_HEIGHT);
}

function clearSceneFitHeightTimer(node) {
    if (!node?.sceneFitHeightTimer) {
        return;
    }
    clearTimeout(node.sceneFitHeightTimer);
    node.sceneFitHeightTimer = null;
}

function scheduleFitHeight(node, delay = 0) {
    if (!node) {
        return;
    }
    if (node.sceneFitHeightTimer) {
        clearTimeout(node.sceneFitHeightTimer);
    }
    node.sceneFitHeightTimer = setTimeout(() => {
        node.sceneFitHeightTimer = null;
        refreshNode(node, { fitHeight: true, skipDeferredFit: true });
    }, delay);
}

function nodeClassName(node) {
    return node?.comfyClass || node?.type || "";
}

function nodeClassNames(node) {
    return [
        node?.comfyClass,
        node?.type,
        node?.properties?.["Node name for S&R"],
    ].map((name) => String(name || "").trim()).filter(Boolean);
}

function isRerouteNode(node) {
    return nodeClassNames(node).some((name) => /Reroute/u.test(name));
}

function isScenePromptNode(node) {
    return nodeClassNames(node).some((name) => PROMPT_NODE_NAMES.has(name));
}

function isPromptMatrixNode(node) {
    return nodeClassNames(node).some((name) => PROMPT_MATRIX_NODE_NAMES.has(name));
}

function isScenePathNode(node) {
    return nodeClassNames(node).some((name) => SCENE_PATH_NODE_NAMES.has(name));
}

function isScenePromptMergeNode(node) {
    return nodeClassNames(node).some((name) => SCENE_PROMPT_MERGE_NODE_NAMES.has(name));
}

function isSceneExpandNodeName(nodeName) {
    return SCENE_PROMPT_EXPAND_NODE_NAMES.has(nodeName);
}

function isSceneExpandNode(node) {
    return nodeClassNames(node).some((name) => isSceneExpandNodeName(name));
}

function isScenePromptQueueNode(node) {
    return nodeClassNames(node).some((name) => SCENE_PROMPT_QUEUE_NODE_NAMES.has(name));
}

function isSceneEmptyLatentNode(node) {
    return nodeClassNames(node).some((name) => SCENE_EMPTY_LATENT_NODE_NAMES.has(name));
}

function isScenePromptCounterNode(node) {
    return nodeClassNames(node).some((name) => SCENE_PROMPT_COUNTER_NODE_NAMES.has(name));
}

function isScenePresetInputNode(node) {
    return nodeClassNames(node).some((name) => SCENE_PRESET_INPUT_NODE_NAMES.has(name));
}

function isScenePresetOutputNode(node) {
    return nodeClassNames(node).some((name) => SCENE_PRESET_OUTPUT_NODE_NAMES.has(name));
}

function isScenePresetReferenceNode(node) {
    return nodeClassNames(node).some((name) => SCENE_PRESET_REFERENCE_NODE_NAMES.has(name));
}

function isScenePromptSourceNode(node) {
    return isScenePromptNode(node)
        || isPromptMatrixNode(node)
        || isScenePathNode(node)
        || isScenePromptMergeNode(node)
        || isScenePromptCounterNode(node)
        || isScenePromptQueueNode(node)
        || isSceneEmptyLatentNode(node)
        || isScenePresetReferenceNode(node);
}

function liteGraphNodeMode(name, defaultValue) {
    const value = globalThis.LiteGraph?.[name] ?? globalThis.LiteGraph?.NodeMode?.[name];
    const number = Number(value);
    return Number.isFinite(number) ? number : defaultValue;
}

function sceneNodeMode(node) {
    const number = Number(node?.mode ?? 0);
    return Number.isFinite(number) ? number : 0;
}

function isSceneNodeBypassed(node) {
    return sceneNodeMode(node) === liteGraphNodeMode("BYPASS", 4);
}

function isSceneNodeMuted(node) {
    return sceneNodeMode(node) === liteGraphNodeMode("NEVER", 2);
}

function linkedInput(node, inputName) {
    return (node.inputs || []).find((candidate) => candidate?.name === inputName) || null;
}

function graphLink(graph, linkId) {
    return linkId != null ? graph?.links?.[linkId] || null : null;
}

function firstLinkedInput(node) {
    return (node?.inputs || []).find((input) => input?.link != null) || null;
}

function linkKey(link) {
    return [
        link?.id ?? "",
        link?.origin_id ?? "",
        link?.origin_slot ?? "",
        link?.target_id ?? "",
        link?.target_slot ?? "",
    ].map((part) => String(part ?? "")).join(":");
}

function resolveLinkedSourceFromLink(graph, link, seen = new Set()) {
    if (!link) {
        return { source: null, keyParts: [] };
    }
    const key = linkKey(link);
    if (seen.has(key)) {
        return { source: null, keyParts: [key] };
    }
    seen.add(key);
    const source = graph?.getNodeById?.(link.origin_id) || null;
    const keyParts = [key, `node:${source?.id ?? ""}:${nodeClassName(source)}`];
    if (source && isRerouteNode(source)) {
        const upstreamInput = firstLinkedInput(source);
        const upstream = resolveLinkedSourceFromLink(graph, graphLink(graph, upstreamInput?.link), seen);
        return {
            source: upstream.source,
            keyParts: [...keyParts, ...upstream.keyParts],
        };
    }
    return { source, keyParts };
}

function resolveLinkedSourceFromInput(graph, input) {
    const link = input?.link != null ? graph?.links?.[input.link] : null;
    return resolveLinkedSourceFromLink(graph, link);
}

function linkedSourceNode(node, inputName) {
    const input = linkedInput(node, inputName);
    const graph = node.graph || app.graph;
    return resolveLinkedSourceFromInput(graph, input).source;
}

function linkedInputKey(node, inputName) {
    const input = linkedInput(node, inputName);
    const graph = node.graph || app.graph;
    const resolved = resolveLinkedSourceFromInput(graph, input);
    if (!resolved.keyParts.length) {
        return input?.link == null ? "" : String(input.link);
    }
    return resolved.keyParts.join("|");
}

function emptyMatrixRow() {
    return {
        labels: [],
        positive_parts: [],
        negative_parts: [],
        path_parts: [],
        display_labels: [],
        display_label_groups: [],
        set_refs: [],
    };
}

function matrixRowBaseKey(row) {
    return JSON.stringify({
        labels: (row?.labels || []).map((item) => String(item).trim()).filter(Boolean),
        path_parts: (row?.path_parts || []).map((item) => String(item).trim()).filter(Boolean),
    });
}

function matrixRowSetRefs(row) {
    return (row?.set_refs || [])
        .filter((ref) => ref && typeof ref === "object")
        .map((ref) => ({
            category: String(ref.category || "").trim(),
            name: String(ref.name || "").trim(),
            path_label: String(ref.path_label || ref.name || "").trim(),
            node_id: ref.node_id == null ? "" : String(ref.node_id).trim(),
        }))
        .filter((ref) => ref.category || ref.name || ref.path_label || ref.node_id);
}

function matrixRowKey(row) {
    const refs = matrixRowSetRefs(row);
    if (!refs.length) {
        return matrixRowBaseKey(row);
    }
    return JSON.stringify({
        labels: (row?.labels || []).map((item) => String(item).trim()).filter(Boolean),
        path_parts: (row?.path_parts || []).map((item) => String(item).trim()).filter(Boolean),
        set_refs: refs,
    });
}

function matrixRowLabel(row) {
    const labels = (row?.labels || []).map((item) => String(item).trim()).filter(Boolean);
    const pathParts = (row?.path_parts || []).map((item) => String(item).trim()).filter(Boolean);
    return labels.join(" / ") || pathParts.join(" / ") || "Scene";
}

function scenePathLabelParts(items) {
    const parts = [];
    for (const item of items || []) {
        for (const part of String(item || "").split(/[\/\\／＞>]+/u)) {
            const cleanPart = part.trim();
            if (cleanPart) {
                parts.push(cleanPart);
            }
        }
    }
    return parts;
}

function sceneQueueEntryParts(entry) {
    const sourceParts = Array.isArray(entry?.display_parts)
        ? entry.display_parts
        : (Array.isArray(entry?.parts) ? entry.parts : []);
    const parts = scenePathLabelParts(sourceParts);
    if (parts.length) {
        return parts;
    }
    return sceneQueueRowSignatureParts(entry?.row);
}

function sceneQueueRowSignatureParts(row) {
    const labels = scenePathLabelParts(row?.labels);
    if (labels.length) {
        return labels;
    }
    const pathParts = scenePathLabelParts(row?.path_parts);
    if (pathParts.length) {
        return pathParts;
    }
    return ["Scene"];
}

function matrixRowDisplayLabels(row) {
    return (row?.display_labels || [])
        .map((item) => String(item).trim())
        .filter(Boolean);
}

function matrixRowDisplayLabelGroups(row) {
    return (row?.display_label_groups || [])
        .map((group) => (Array.isArray(group) ? group : [group])
            .map((item) => String(item).trim())
            .filter(Boolean));
}

function matrixLineDisplayLabels(matrixLine) {
    return matrixRowDisplayLabels(matrixLine);
}

function matrixLineRef(matrixLine) {
    const label = matrixLineLabel(matrixLine);
    return {
        category: String(matrixLine?.category || "").trim(),
        name: label,
        path_label: label,
        node_id: matrixLine?.node_id == null ? "" : String(matrixLine.node_id),
    };
}

function appendScenePathPart(pathParts, label, pathMode) {
    const mode = normalizePathMode(pathMode);
    const cleanLabel = String(label || "").trim();
    if (!cleanLabel) {
        return [...pathParts];
    }
    const nextParts = [...pathParts];
    if (mode === PATH_MODE_APPEND && nextParts.length) {
        nextParts[nextParts.length - 1] = `${nextParts[nextParts.length - 1]}_${cleanLabel}`;
    } else {
        nextParts.push(cleanLabel);
    }
    return nextParts;
}

function selectionStateObjectFromValue(value) {
    return parseSelectionState(value);
}

function serializedSelectionStateObject(value) {
    return serializeSelectionState(value);
}

function normalizeMatrixLine(value) {
    return parseMatrixLine(value);
}

function matrixLineLabel(matrixLine) {
    return String(matrixLine?.name || "Matrix 行").trim();
}

function matrixLineOutputLabel(matrixLine) {
    const labels = matrixLineDisplayLabels(matrixLine);
    return labels.join(" / ") || matrixLineLabel(matrixLine);
}

function matrixRowDisplayText(row) {
    const labels = matrixRowDisplayLabels(row);
    return labels.join(" / ") || matrixRowLabel(row);
}

function currentMatrixJsonValue(node, widget) {
    const values = [widget?.value, node?.properties?.scene_matrix_json, serializedMatrixJsonValue(node)]
        .filter((value) => value != null && String(value).trim());
    const parsed = values.map((value) => parseMatrixState(value));
    const configured = parsed.find((state) => state.sets.length > 0);
    return serializeMatrixState(configured || parsed[0] || createMatrixState());
}

function normalizeMatrixWidgetValues(node, widget) {
    if (!node || !widget) {
        return;
    }
    node.widgets_values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    node.properties = node.properties || {};

    const matrixValue = currentMatrixJsonValue(node, widget);
    const matrixIndex = Array.isArray(node.widgets) ? node.widgets.indexOf(widget) : -1;
    if (widget.value !== matrixValue) {
        widget.value = matrixValue;
    }
    if (matrixIndex >= 0 && node.widgets_values[matrixIndex] !== matrixValue) {
        node.widgets_values[matrixIndex] = matrixValue;
    }
    if (node.properties.scene_matrix_json !== matrixValue) {
        node.properties.scene_matrix_json = matrixValue;
    }

}

function ensureMatrixJsonWidget(node) {
    let widget = findWidget(node, "matrix_json");
    if (widget) {
        widget.serialize = true;
        widget.options = widget.options || {};
        widget.options.serialize = true;
        widget.options.hidden = true;
        widget.computeSize = () => [0, 0];
        widget.draw = () => {};
        normalizeMatrixWidgetValues(node, widget);
        hideWidget(widget);
        return widget;
    }

    const initialValue = serializeMatrixState(parseMatrixState(serializedMatrixJsonValue(node)));

    if (typeof node.addWidget === "function") {
        widget = node.addWidget("text", "matrix_json", initialValue, null, { serialize: true });
    } else {
        widget = {
            type: "text",
            name: "matrix_json",
            value: initialValue,
            serialize: true,
            options: { serialize: true },
        };
        node.widgets = node.widgets || [];
        node.widgets.push(widget);
    }
    widget.serialize = true;
    widget.options = widget.options || {};
    widget.options.serialize = true;
    normalizeMatrixWidgetValues(node, widget);
    hideWidget(widget);
    return widget;
}

function serializedMatrixJsonValue(node) {
    if (!Array.isArray(node?.widgets_values) || !Array.isArray(node?.widgets)) {
        return "";
    }
    const index = node.widgets.findIndex((widget) => widget?.name === "matrix_json");
    return index >= 0 ? node.widgets_values[index] || "" : "";
}

function parseMatrixStateValue(value) {
    return parseMatrixState(value);
}

function normalizeMatrixState(state) {
    return parseMatrixState(state);
}

function readMatrixState(node) {
    const widget = ensureMatrixJsonWidget(node);
    const cacheKey = JSON.stringify({
        widget: String(widget?.value || ""),
        property: String(node?.properties?.scene_matrix_json || ""),
        memory: node?.sceneMatrixState && typeof node.sceneMatrixState === "object"
            ? JSON.stringify(node.sceneMatrixState)
            : String(node?.sceneMatrixState || ""),
    });
    if (node.sceneMatrixStateCache?.cacheKey === cacheKey) {
        return node.sceneMatrixStateCache.state;
    }
    const state = parseMatrixStateValue(currentMatrixJsonValue(node, widget));
    node.sceneMatrixStateCache = { cacheKey, state };
    return state;
}

function writeMatrixState(node, state, options = {}) {
    node.properties = node.properties || {};
    const widget = ensureMatrixJsonWidget(node);
    const nextState = normalizeMatrixState(state);
    const nextValue = serializeMatrixState(nextState);
    if (widget) {
        widget.value = nextValue;
        node.widgets_values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
        const widgetIndex = Array.isArray(node.widgets) ? node.widgets.indexOf(widget) : -1;
        if (widgetIndex >= 0) {
            node.widgets_values[widgetIndex] = nextValue;
        }
        notifyWidgetChanged(node, widget, nextValue);
    }
    node.sceneMatrixState = nextState;
    node.properties.scene_matrix_json = nextValue;
    clearSceneComputedCaches(node);
    if (options.refresh !== false) {
        refreshNode(node, { fitHeight: !!options.fitHeight });
    }
    refreshDownstreamSceneNodes(node);
    app.graph?.change?.();
}

function installScenePromptWidgetSyncHandlers(node) {
    for (const widgetName of ["positive_base", "negative_base", "category_order"]) {
        const widget = findWidget(node, widgetName);
        if (!widget || widget.scenePromptSyncWrapped) {
            continue;
        }
        const originalCallback = widget.callback;
        widget.callback = function () {
            const result = originalCallback?.apply(this, arguments);
            clearSceneComputedCaches(node);
            scheduleSceneNodeRefresh(node, { fitHeight: false }, 80);
            refreshDownstreamSceneNodes(node);
            return result;
        };
        widget.scenePromptSyncWrapped = true;
    }
}

function installScenePathWidgetSyncHandlers(node) {
    const widget = findWidget(node, "path_mode");
    if (!widget || widget.scenePathSyncWrapped) {
        return;
    }
    const originalCallback = widget.callback;
    widget.callback = function () {
        const result = originalCallback?.apply(this, arguments);
        clearSceneComputedCaches(node);
        refreshDownstreamSceneNodes(node);
        return result;
    };
    widget.scenePathSyncWrapped = true;
}

function installScenePromptCounterWidgetSyncHandlers(node) {
    const widget = findWidget(node, "count");
    if (!widget || widget.scenePromptCounterSyncWrapped) {
        return;
    }
    const originalCallback = widget.callback;
    widget.callback = function () {
        const result = originalCallback?.apply(this, arguments);
        clearSceneComputedCaches(node);
        refreshDownstreamSceneNodes(node);
        return result;
    };
    widget.scenePromptCounterSyncWrapped = true;
}

function installSceneEmptyLatentWidgetSyncHandlers(node) {
    for (const widgetName of ["width", "height", "batch_size"]) {
        const widget = findWidget(node, widgetName);
        if (!widget || widget.sceneEmptyLatentSyncWrapped) {
            continue;
        }
        const originalCallback = widget.callback;
        widget.callback = function () {
            const result = originalCallback?.apply(this, arguments);
            clearSceneComputedCaches(node);
            refreshDownstreamSceneNodes(node);
            return result;
        };
        widget.sceneEmptyLatentSyncWrapped = true;
    }
}

function matrixLinesForNode(node) {
    const state = readMatrixState(node);
    const sets = [];
    const seen = new Set();
    const pushMatrixLine = (matrixLine) => {
        if (!matrixLine) {
            return;
        }
        const key = matrixLine.row_id || matrixLine.node_id || `${matrixLine.category}::${matrixLine.name}`;
        if (!seen.has(key)) {
            seen.add(key);
            sets.push(matrixLine);
        }
    };

    for (const rawSet of state.sets || []) {
        const matrixLine = normalizeMatrixLine(rawSet);
        if (matrixLine.enabled === false) {
            continue;
        }
        pushMatrixLine(matrixLine);
    }

    return sets;
}

function matrixConfiguredLineCount(node) {
    return (readMatrixState(node).sets || [])
        .map(normalizeMatrixLine)
        .length;
}

function matrixDisplayCacheKey(node, width = null) {
    const inputSource = scenePromptInputSource(node);
    return JSON.stringify({
        width: Math.ceil(width || node?.size?.[0] || MATRIX_NODE_DEFAULT_WIDTH),
        mode: sceneNodeMode(node),
        input: linkedInputKey(node, "scene_prompt"),
        input_id: inputSource?.id ?? null,
        input_mode: sceneNodeMode(inputSource),
        input_revision: sceneNodeRevision(inputSource),
        matrix_json: String(ensureMatrixJsonWidget(node)?.value || MATRIX_DEFAULT_JSON),
        revision: sceneNodeRevision(node),
    });
}

function matrixSourceCacheKey(node) {
    return JSON.stringify({
        mode: sceneNodeMode(node),
        input: linkedInputKey(node, "scene_prompt"),
        matrix_json: String(ensureMatrixJsonWidget(node)?.value || MATRIX_DEFAULT_JSON),
        revision: sceneNodeRevision(node),
    });
}

function compactMatrixLabels(labels, limit = MATRIX_SECTION_VISIBLE_ROWS) {
    const cleanLabels = (labels || [])
        .map((label) => String(label || "").trim())
        .filter(Boolean);
    if (cleanLabels.length <= limit) {
        return cleanLabels.map((label) => ({ label }));
    }
    return [
        ...cleanLabels.slice(0, limit).map((label) => ({ label })),
        { label: `ほか ${cleanLabels.length - limit} 行`, muted: true },
    ];
}

function matrixInputItems(node) {
    const upstream = scenePromptInputSource(node);
    if (!upstream) {
        return [];
    }
    const previewEntries = scenePromptPreviewEntries(upstream, MATRIX_SECTION_VISIBLE_ROWS);
    const labels = previewEntries
        .map((entry) => sceneQueueEntryParts(entry).join(" / "))
        .filter(Boolean);
    const items = labels.map((label) => ({ label }));
    const overflow = Math.max(0, scenePromptStats(upstream).rows - previewEntries.length);
    if (overflow > 0) {
        items.push({ label: `ほか ${overflow} 行`, muted: true });
    }
    return items;
}

function matrixOutputLabels(node) {
    return matrixLinesForNode(node)
        .map((line) => matrixLineLabel(line))
        .filter(Boolean);
}

function matrixSectionHeight(section) {
    const titleHeight = section?.title ? 22 : 0;
    if (!section?.items?.length) {
        return titleHeight + (section?.empty ? 18 : 0) + 6;
    }
    return titleHeight + section.items.length * 18 + 6;
}

function computeMatrixDisplayCache(node, width = null, cacheKey = null) {
    const drawWidth = width || node?.size?.[0] || MATRIX_NODE_DEFAULT_WIDTH;
    const finalKey = cacheKey || matrixDisplayCacheKey(node, drawWidth);
    if (node.sceneMatrixDisplayCache?.cacheKey === finalKey) {
        return node.sceneMatrixDisplayCache;
    }

    const sections = [
        {
            title: "入力 matrix",
            color: "#d8b846",
            empty: "入力matrixなし",
            items: matrixInputItems(node),
        },
        {
            title: "出力 matrix",
            color: "#6da0c2",
            empty: "",
            items: compactMatrixLabels(matrixOutputLabels(node)),
        },
    ];
    const naturalHeight = Math.max(56, 8 + sections.reduce((total, section) => total + matrixSectionHeight(section), 0));
    const cache = {
        cacheKey: finalKey,
        width: drawWidth,
        sections,
        naturalHeight,
    };
    node.sceneMatrixDisplayCache = cache;
    node.sceneMatrixRenderCache = null;
    return cache;
}

function matrixDisplayCache(node, width = null) {
    const drawWidth = width || node?.size?.[0] || MATRIX_NODE_DEFAULT_WIDTH;
    const cached = node.sceneMatrixDisplayCache;
    const cacheKey = matrixDisplayCacheKey(node, drawWidth);
    if (cached && Math.ceil(cached.width || 0) === Math.ceil(drawWidth) && cached.cacheKey === cacheKey) {
        return cached;
    }
    return computeMatrixDisplayCache(node, drawWidth, cacheKey);
}

function drawMatrixSection(ctx, section, width, cursorY) {
    ctx.textBaseline = "middle";
    if (section.title) {
        ctx.font = "bold 12px sans-serif";
        ctx.fillStyle = section.color;
        ctx.fillText(section.title, 10, cursorY + 10);
        cursorY += 22;
    }

    if (!section.items.length) {
        if (section.empty) {
            ctx.font = "11px sans-serif";
            ctx.fillStyle = "#aab3c4";
            ctx.fillText(section.empty, 10, cursorY + 10);
            cursorY += 18;
        }
        return cursorY + 6;
    }

    const itemWidth = Math.max(60, width - 20);
    ctx.font = "11px sans-serif";
    for (const item of section.items) {
        ctx.fillStyle = item.muted ? "#b7bdc8" : "#30343b";
        ctx.strokeStyle = item.muted ? "#59616e" : section.color;
        ctx.beginPath();
        roundedRect(ctx, 10, cursorY + 1, itemWidth, 15, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = item.muted ? "#b7bdc8" : "#e7edf7";
        ctx.fillText(fitCanvasText(ctx, item.label, Math.max(20, itemWidth - 12)), 16, cursorY + 9);
        cursorY += 18;
    }
    return cursorY + 6;
}

function drawMatrixList(ctx, node, width, y, height) {
    const drawWidth = sceneWidgetDrawWidth(node, width, MATRIX_NODE_DEFAULT_WIDTH);
    if (!sceneShouldDrawDetails()) {
        drawSceneCompactWidget(ctx, node, drawWidth, y, height, "matrix");
        return;
    }

    const cache = matrixDisplayCache(node, drawWidth);
    const drawHeight = sceneWidgetDrawHeight(
        node,
        "matrix_connected_list",
        y,
        height,
        cache.naturalHeight,
        56,
    );
    const canvas = cachedSceneWidgetCanvas(
        node,
        "sceneMatrixRenderCache",
        drawWidth,
        drawHeight,
        (renderCtx, renderWidth) => {
            let cursorY = 4;
            for (const section of cache.sections) {
                cursorY = drawMatrixSection(renderCtx, section, renderWidth, cursorY);
            }
        },
    );
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y, drawWidth, drawHeight);
    ctx.clip();
    if (canvas) {
        ctx.drawImage(canvas, 0, y, drawWidth, drawHeight);
    } else {
        ctx.translate(0, y);
        let cursorY = 4;
        for (const section of cache.sections) {
            cursorY = drawMatrixSection(ctx, section, drawWidth, cursorY);
        }
    }
    ctx.restore();
}

function addMatrixListWidget(node) {
    const existing = findSceneWidget(node, "matrix_connected_list");
    if (existing) {
        return existing;
    }
    const widget = {
        type: "matrix_connected_list",
        name: "matrix",
        value: "",
        serialize: false,
        options: { serialize: false },
        sceneRole: "matrix_connected_list",
        computeSize(width) {
            const drawDetails = !!node?.sceneForceNaturalWidgetHeight || sceneShouldDrawDetails();
            const drawWidth = sceneWidgetDrawWidth(node, width, MATRIX_NODE_DEFAULT_WIDTH);
            const naturalHeight = drawDetails
                ? matrixDisplayCache(node, drawWidth).naturalHeight
                : SCENE_COMPACT_WIDGET_HEIGHT;
            return [
                drawWidth,
                resizableSceneWidgetHeight(node, "matrix_connected_list", naturalHeight, drawDetails ? 56 : SCENE_COMPACT_WIDGET_HEIGHT),
            ];
        },
        draw(ctx, drawNode, width, y, height) {
            drawMatrixList(ctx, drawNode, width, y, height);
        },
    };
    node.widgets = node.widgets || [];
    node.widgets.push(widget);
    return widget;
}

function scenePromptMergeDisplayCacheKey(node, width = null) {
    const sources = connectedScenePromptSourcesForMerge(node);
    return JSON.stringify({
        width: Math.ceil(width || node?.size?.[0] || MATRIX_NODE_DEFAULT_WIDTH),
        inputs: sources.map(({ name, input, source }) => ({
            name,
            link: input?.link ?? null,
            source_id: source?.id ?? null,
            source_type: nodeClassName(source),
            source_title: String(source?.title || "").trim(),
            source_mode: sceneNodeMode(source),
        })),
        revision: sceneNodeRevision(node),
    });
}

function scenePromptSourceTitle(source) {
    return String(source?.title || "").trim();
}

function scenePromptMergeInputSections(node) {
    const colors = ["#d8b846", "#6da0c2"];
    return connectedScenePromptSourcesForMerge(node).map(({ source }, index) => {
        const connected = !!source;
        return {
            title: "",
            color: colors[index] || "#dfe8f5",
            empty: "未接続",
            items: connected
                ? [{ label: scenePromptSourceTitle(source) }]
                : [],
        };
    });
}

function computeScenePromptMergeDisplayCache(node, width = null, cacheKey = null) {
    const drawWidth = width || node?.size?.[0] || MATRIX_NODE_DEFAULT_WIDTH;
    const finalKey = cacheKey || scenePromptMergeDisplayCacheKey(node, drawWidth);
    if (node.scenePromptMergeDisplayCache?.cacheKey === finalKey) {
        return node.scenePromptMergeDisplayCache;
    }
    const sections = scenePromptMergeInputSections(node);
    const naturalHeight = Math.max(
        70,
        8 + sections.reduce((total, section) => total + matrixSectionHeight(section), 0),
    );
    const cache = {
        cacheKey: finalKey,
        width: drawWidth,
        sections,
        naturalHeight,
    };
    node.scenePromptMergeDisplayCache = cache;
    node.scenePromptMergeRenderCache = null;
    return cache;
}

function scenePromptMergeDisplayCache(node, width = null) {
    const drawWidth = width || node?.size?.[0] || MATRIX_NODE_DEFAULT_WIDTH;
    const cached = node.scenePromptMergeDisplayCache;
    const cacheKey = scenePromptMergeDisplayCacheKey(node, drawWidth);
    if (cached && Math.ceil(cached.width || 0) === Math.ceil(drawWidth) && cached.cacheKey === cacheKey) {
        return cached;
    }
    return computeScenePromptMergeDisplayCache(node, drawWidth, cacheKey);
}

function drawScenePromptMergeList(ctx, node, width, y, height) {
    const drawWidth = sceneWidgetDrawWidth(node, width, MATRIX_NODE_DEFAULT_WIDTH);
    if (!sceneShouldDrawDetails()) {
        drawSceneCompactWidget(ctx, node, drawWidth, y, height, "scene_prompt");
        return;
    }

    const cache = scenePromptMergeDisplayCache(node, drawWidth);
    const drawHeight = sceneWidgetDrawHeight(
        node,
        "scene_prompt_merge_list",
        y,
        height,
        cache.naturalHeight,
        70,
    );
    const canvas = cachedSceneWidgetCanvas(
        node,
        "scenePromptMergeRenderCache",
        drawWidth,
        drawHeight,
        (renderCtx, renderWidth) => {
            let cursorY = 4;
            for (const section of cache.sections) {
                cursorY = drawMatrixSection(renderCtx, section, renderWidth, cursorY);
            }
        },
    );
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y, drawWidth, drawHeight);
    ctx.clip();
    if (canvas) {
        ctx.drawImage(canvas, 0, y, drawWidth, drawHeight);
    } else {
        ctx.translate(0, y);
        let cursorY = 4;
        for (const section of cache.sections) {
            cursorY = drawMatrixSection(ctx, section, drawWidth, cursorY);
        }
    }
    ctx.restore();
}

function addScenePromptMergeListWidget(node) {
    const existing = findSceneWidget(node, "scene_prompt_merge_list");
    if (existing) {
        return existing;
    }
    const widget = {
        type: "scene_prompt_merge_list",
        name: "プロンプト一覧",
        value: "",
        serialize: false,
        options: { serialize: false },
        sceneRole: "scene_prompt_merge_list",
        computeSize(width) {
            const drawDetails = !!node?.sceneForceNaturalWidgetHeight || sceneShouldDrawDetails();
            const drawWidth = sceneWidgetDrawWidth(node, width, MATRIX_NODE_DEFAULT_WIDTH);
            const naturalHeight = drawDetails
                ? scenePromptMergeDisplayCache(node, drawWidth).naturalHeight
                : SCENE_COMPACT_WIDGET_HEIGHT;
            return [
                drawWidth,
                resizableSceneWidgetHeight(node, "scene_prompt_merge_list", naturalHeight, drawDetails ? 70 : SCENE_COMPACT_WIDGET_HEIGHT),
            ];
        },
        draw(ctx, drawNode, width, y, height) {
            drawScenePromptMergeList(ctx, drawNode, width, y, height);
        },
    };
    node.widgets = node.widgets || [];
    node.widgets.push(widget);
    return widget;
}

function downstreamNodes(node) {
    const graph = node?.graph || app.graph;
    const nodes = [];
    for (const output of node?.outputs || []) {
        for (const linkId of output?.links || []) {
            const link = graph?.links?.[linkId];
            const target = link ? graph?.getNodeById?.(link.target_id) : null;
            if (target) {
                nodes.push(target);
            }
        }
    }
    return nodes;
}

function collectDownstreamSceneNodes(node, targets = new Set(), seen = new Set()) {
    if (!node || seen.has(node.id)) {
        return targets;
    }
    seen.add(node.id);
    for (const target of downstreamNodes(node)) {
        if (isRerouteNode(target)) {
            collectDownstreamSceneNodes(target, targets, seen);
            continue;
        }
        if (
            isPromptMatrixNode(target)
            || isScenePromptSourceNode(target)
            || isSceneExpandNode(target)
        ) {
            targets.add(target);
            if (!isSceneExpandNode(target)) {
                collectDownstreamSceneNodes(target, targets, seen);
            }
        }
    }
    return targets;
}

function clearSceneComputedCaches(node) {
    if (!node) {
        return;
    }
    node.scenePromptRevision = (Number(node.scenePromptRevision || 0) + 1) % Number.MAX_SAFE_INTEGER;
    node.sceneMatrixDisplayCache = null;
    node.sceneMatrixRenderCache = null;
    node.scenePromptMergeDisplayCache = null;
    node.scenePromptMergeRenderCache = null;
    node.sceneSelectedListLayoutCache = null;
    node.sceneSelectedListPositiveRenderCache = null;
    node.sceneSelectedListNegativeRenderCache = null;
    node.scenePromptQueueDisplayCache = null;
    node.scenePromptQueueRenderCache = null;
    node.scenePromptQueueRowsCache = null;
    node.scenePromptTotalCache = null;
    node.scenePromptSourceKeyCache = null;
    node.scenePromptPreviewCache = null;
    node.sceneMatrixStateCache = null;
}

function flushDownstreamSceneRefreshes() {
    clearTimeout(sceneDownstreamRefreshTimer);
    const sources = [...sceneDownstreamRefreshSources];
    sceneDownstreamRefreshSources.clear();
    sceneDownstreamRefreshTimer = null;
    const targets = new Set();
    for (const source of sources) {
        collectDownstreamSceneNodes(source, targets);
    }
    for (const target of targets) {
        clearSceneComputedCaches(target);
        scheduleSceneNodeRefresh(target, { fitHeight: false }, 40);
    }
}

function refreshDownstreamSceneNodes(node) {
    if (!node) {
        return;
    }
    for (const target of collectDownstreamSceneNodes(node)) {
        clearSceneComputedCaches(target);
    }
    sceneDownstreamRefreshSources.add(node);
    clearTimeout(sceneDownstreamRefreshTimer);
    sceneDownstreamRefreshTimer = setTimeout(flushDownstreamSceneRefreshes, 100);
}

function handleSceneNodeModeChange(node) {
    const mode = sceneNodeMode(node);
    if (node.sceneLastMode === undefined) {
        node.sceneLastMode = mode;
        return false;
    }
    if (node.sceneLastMode === mode) {
        return false;
    }
    node.sceneLastMode = mode;
    clearSceneComputedCaches(node);
    scheduleSceneNodeRefresh(node, { fitHeight: false }, 40);
    refreshDownstreamSceneNodes(node);
    return true;
}

function sceneGraphNodes() {
    return app.graph?._nodes || app.graph?.nodes || [];
}

function syncSceneNodeModes() {
    let changed = false;
    for (const node of sceneGraphNodes()) {
        if (isScenePromptSourceNode(node) || isSceneExpandNode(node)) {
            changed = handleSceneNodeModeChange(node) || changed;
        }
    }
    flushDownstreamSceneRefreshes();
    if (changed) {
        app.graph?.change?.();
    }
    return changed;
}

function installSceneModeWatcher(node) {
    if (!node || node.sceneModeWatcherInstalled) {
        return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(node, "mode");
    if (descriptor && descriptor.configurable === false) {
        node.sceneLastMode = sceneNodeMode(node);
        return;
    }

    let value = node.mode;
    node.sceneLastMode = sceneNodeMode(node);

    Object.defineProperty(node, "mode", {
        configurable: true,
        enumerable: true,
        get() {
            return value;
        },
        set(nextValue) {
            const previous = Number(value ?? 0);
            value = nextValue;
            const next = Number(nextValue ?? 0);
            if (Number.isFinite(previous) && Number.isFinite(next) && previous !== next) {
                handleSceneNodeModeChange(this);
            }
        },
    });

    node.sceneModeWatcherInstalled = true;
}

function installSceneConnectionWatcher(node) {
    if (!node) {
        return;
    }
    installSceneModeWatcher(node);
    if (node.scenePromptConnectionWrapped || node.onConnectionsChange?.scenePromptConnectionWrapped) {
        return;
    }
    const originalOnConnectionsChange = node.onConnectionsChange;
    node.onConnectionsChange = function () {
        const result = originalOnConnectionsChange?.apply(this, arguments);
        clearSceneComputedCaches(this);
        scheduleSceneNodeRefresh(this, { fitHeight: false }, 40);
        refreshDownstreamSceneNodes(this);
        return result;
    };
    const originalOnModeChange = node.onModeChange;
    node.onModeChange = function () {
        const result = originalOnModeChange?.apply(this, arguments);
        handleSceneNodeModeChange(this);
        return result;
    };
    node.onModeChange.scenePromptConnectionWrapped = true;
    node.onConnectionsChange.scenePromptConnectionWrapped = true;
    node.scenePromptConnectionWrapped = true;
}

function scheduleSceneNodeRefresh(node, options = {}, delay = 80) {
    if (!node) {
        return;
    }
    const pending = node.scenePendingRefreshOptions || {};
    node.scenePendingRefreshOptions = {
        ...pending,
        ...options,
        fitHeight: !!pending.fitHeight || !!options.fitHeight,
        expand: !!pending.expand || !!options.expand,
    };
    clearTimeout(node.sceneRefreshTimer);
    node.sceneRefreshTimer = setTimeout(() => {
        const refreshOptions = node.scenePendingRefreshOptions || {};
        node.scenePendingRefreshOptions = null;
        node.sceneRefreshTimer = null;
        refreshNode(node, refreshOptions);
    }, delay);
}

function flushLoadedSceneNodeRefreshes() {
    const sources = [...sceneLoadedRefreshNodes].filter((node) => node?.graph === app.graph);
    sceneLoadedRefreshNodes.clear();
    sceneLoadedRefreshTimer = null;
    for (const source of sources) {
        clearSceneComputedCaches(source);
        source.setDirtyCanvas?.(true, true);
    }
}

function scheduleLoadedSceneNodeRefresh(node) {
    if (!node) {
        return;
    }
    sceneLoadedRefreshNodes.add(node);
    clearTimeout(sceneLoadedRefreshTimer);
    sceneLoadedRefreshTimer = setTimeout(flushLoadedSceneNodeRefreshes, 120);
}

function clampSceneCount(value, defaultValue = 0) {
    const number = Number.parseInt(String(value ?? "").trim(), 10);
    if (!Number.isFinite(number)) {
        return clamp(defaultValue, 0, SCENE_COUNT_MAX);
    }
    return clamp(number, 0, SCENE_COUNT_MAX);
}

function sceneQueueLeafDisplayLabel(entry) {
    const parts = sceneQueueEntryParts(entry);
    return parts[parts.length - 1] || "Scene";
}

function aggregateConsecutiveDisplayRowsByParts(rows) {
    const entries = [];
    for (const row of rows || []) {
        const parts = sceneQueueEntryParts(row);
        const key = JSON.stringify(parts);
        const count = clampSceneCount(row?.count, 0);
        const previous = entries[entries.length - 1];
        if (previous?.displayKey === key) {
            previous.count += count;
            continue;
        }
        entries.push({
            ...row,
            parts,
            display_parts: parts,
            displayKey: key,
            count,
        });
    }
    return entries;
}

function compactConsecutiveDisplayRowsByParts(rows) {
    return aggregateConsecutiveDisplayRowsByParts(rows).map((entry) => {
        const { displayKey, ...cleaned } = entry;
        return cleaned;
    });
}

function sceneQueueDisplayEntriesFromRows(rows) {
    const orderedRows = aggregateConsecutiveDisplayRowsByParts(rows);
    const displayEntries = [];
    const pushChips = (items, level) => {
        const cleaned = (items || []).filter((item) => String(item?.label || "").trim());
        if (!cleaned.length) {
            return;
        }
        displayEntries.push({
            type: "chips",
            level,
            items: cleaned,
        });
    };
    const partAt = (entry, depth) => sceneQueueEntryParts(entry)[depth] || "";
    const canFoldSingleChild = (entries, depth) => {
        if (!entries.length) {
            return false;
        }
        const firstChild = partAt(entries[0], depth);
        if (!firstChild) {
            return false;
        }
        return entries.every((entry) => {
            const parts = sceneQueueEntryParts(entry);
            return parts.length > depth + 1 && partAt(entry, depth) === firstChild;
        });
    };
    const emitRange = (entries, pathDepth, level) => {
        let index = 0;
        const leafItems = [];
        const flushLeaves = () => {
            pushChips(leafItems.splice(0), level);
        };
        while (index < entries.length) {
            const entry = entries[index];
            const parts = sceneQueueEntryParts(entry);
            if (parts.length <= pathDepth + 1) {
                leafItems.push({
                    label: sceneQueueLeafDisplayLabel(entry),
                    count: entry.count,
                });
                index += 1;
                continue;
            }

            flushLeaves();
            const groupFirst = partAt(entry, pathDepth) || "Scene";
            let end = index + 1;
            while (end < entries.length) {
                const nextParts = sceneQueueEntryParts(entries[end]);
                if (nextParts.length <= pathDepth + 1 || partAt(entries[end], pathDepth) !== groupFirst) {
                    break;
                }
                end += 1;
            }
            const groupEntries = entries.slice(index, end);
            const labelParts = [groupFirst];
            let nextPathDepth = pathDepth + 1;
            while (canFoldSingleChild(groupEntries, nextPathDepth)) {
                labelParts.push(partAt(groupEntries[0], nextPathDepth));
                nextPathDepth += 1;
            }
            displayEntries.push({
                type: "group",
                level,
                label: labelParts.join(" / "),
            });
            emitRange(groupEntries, nextPathDepth, level + 1);
            index = end;
        }
        flushLeaves();
    };
    emitRange(orderedRows, 0, 0);
    return displayEntries;
}

function sceneQueuePreviewRows(node) {
    return scenePromptPreviewEntries(node, SCENE_QUEUE_DISPLAY_PREVIEW_ROWS);
}

function sceneQueueChipWidth(label, availableWidth, ctx = null) {
    return estimateChipWidthWithContext(label, availableWidth, ctx);
}

function sceneQueueChipRows(items, width, level = 0, ctx = null) {
    const left = 24 + Math.max(0, level) * 12;
    const available = Math.max(80, width - left - 10);
    let rows = 1;
    let cursorX = 0;
    for (const item of items || []) {
        const label = `${item.label} x${item.count}`;
        const chipWidth = sceneQueueChipWidth(label, available, ctx);
        if (cursorX > 0 && cursorX + chipWidth > available) {
            rows += 1;
            cursorX = 0;
        }
        cursorX += chipWidth + CHIP_GAP;
    }
    return rows;
}

function sceneQueueEntryHeight(entry, width, ctx = null) {
    if (entry?.type === "chips") {
        return sceneQueueChipRows(entry.items, width, entry.level || 0, ctx) * (CHIP_HEIGHT + CHIP_LINE_GAP);
    }
    return 20;
}

function sceneQueueEntriesHeight(entries, width, ctx = null) {
    return (entries || []).reduce((total, entry) => total + sceneQueueEntryHeight(entry, width, ctx), 0);
}

function sceneNodeById(nodeId) {
    return app.graph?.getNodeById?.(nodeId) || app.graph?.getNodeById?.(Number(nodeId)) || null;
}

function sceneExpandScenePromptSourceNode(node) {
    const source = linkedSourceNode(node, "scene_prompt");
    return source && isScenePromptSourceNode(source) ? source : null;
}

function scenePromptLocalCacheKey(node) {
    return JSON.stringify({
        type: "prompt",
        id: node?.id ?? null,
        mode: sceneNodeMode(node),
        title: scenePromptTitle(node),
        input: linkedInputKey(node, "scene_prompt"),
        positive_base: String(findWidget(node, "positive_base")?.value || ""),
        positive_json: String(findWidget(node, "positive_json")?.value || ""),
        negative_base: String(findWidget(node, "negative_base")?.value || ""),
        negative_json: String(findWidget(node, "negative_json")?.value || ""),
        category_order: String(findWidget(node, "category_order")?.value || ""),
    });
}

function scenePathLocalCacheKey(node) {
    return JSON.stringify({
        type: "path",
        id: node?.id ?? null,
        mode: sceneNodeMode(node),
        title: scenePathTitle(node),
        input: linkedInputKey(node, "scene_prompt"),
        path_mode: normalizePathMode(findWidget(node, "path_mode")?.value),
    });
}

function scenePromptSourceLocalCacheKey(node) {
    const upstream = scenePromptInputSource(node);
    const upstreamKey = upstream
        ? {
            id: upstream.id ?? null,
            type: nodeClassName(upstream),
            mode: sceneNodeMode(upstream),
            revision: sceneNodeRevision(upstream),
            link: linkedInputKey(node, "scene_prompt"),
            lineage: scenePromptLineageKey(upstream),
        }
        : null;

    if (isScenePromptNode(node)) {
        return JSON.stringify({
            local: scenePromptLocalCacheKey(node),
            upstream: upstreamKey,
        });
    }
    if (isPromptMatrixNode(node)) {
        return JSON.stringify({
            type: "matrix",
            id: node?.id ?? null,
            mode: sceneNodeMode(node),
            local: matrixSourceCacheKey(node),
            upstream: upstreamKey,
        });
    }
    if (isScenePathNode(node)) {
        return JSON.stringify({
            local: scenePathLocalCacheKey(node),
            upstream: upstreamKey,
        });
    }
    if (isScenePromptMergeNode(node)) {
        const graph = node?.graph || app.graph;
        return JSON.stringify({
            type: "merge",
            id: node?.id ?? null,
            mode: sceneNodeMode(node),
            inputs: ["scene_prompt1", "scene_prompt2"].map((name) => {
                const input = linkedInput(node, name);
                const resolved = resolveLinkedSourceFromInput(graph, input);
                const source = resolved.source;
                return {
                    name,
                    link: input?.link ?? null,
                    source_path: resolved.keyParts,
                    source_id: source?.id ?? null,
                    source_type: nodeClassName(source),
                    source_mode: sceneNodeMode(source),
                    source_revision: sceneNodeRevision(source),
                    source_lineage: source ? scenePromptLineageKey(source) : "",
                };
            }),
        });
    }
    if (isScenePromptCounterNode(node)) {
        return JSON.stringify({
            type: "counter",
            id: node?.id ?? null,
            mode: sceneNodeMode(node),
            count: scenePromptCounterCount(node),
            input: linkedInputKey(node, "scene_prompt"),
            upstream: upstreamKey,
        });
    }
    if (isSceneEmptyLatentNode(node)) {
        return JSON.stringify({
            type: "empty_latent",
            id: node?.id ?? null,
            mode: sceneNodeMode(node),
            width: Number(findWidget(node, "width")?.value || 512),
            height: Number(findWidget(node, "height")?.value || 512),
            batch_size: Number(findWidget(node, "batch_size")?.value || 1),
            input: linkedInputKey(node, "scene_prompt"),
            upstream: upstreamKey,
        });
    }
    if (isScenePromptQueueNode(node)) {
        const graph = node?.graph || app.graph;
        return JSON.stringify({
            type: "queue",
            id: node?.id ?? null,
            mode: sceneNodeMode(node),
            inputs: scenePromptQueueInputIndexes(node).map(({ input }) => {
                const resolved = resolveLinkedSourceFromInput(graph, input);
                const source = resolved.source;
                return {
                    name: String(input?.name || ""),
                    link: input?.link ?? null,
                    source_path: resolved.keyParts,
                    source_id: source?.id ?? null,
                    source_type: nodeClassName(source),
                    source_mode: sceneNodeMode(source),
                    source_revision: sceneNodeRevision(source),
                    source_lineage: source ? scenePromptLineageKey(source) : "",
                };
            }),
        });
    }
    if (isScenePresetReferenceNode(node)) {
        return JSON.stringify({
            type: "preset_reference",
            id: node?.id ?? null,
            preset_id: String(findWidget(node, "preset_id")?.value || ""),
            input: linkedInputKey(node, "scene_prompt"),
            snapshot: node?.scenePresetGraph?.metadata?.sha256 || "",
        });
    }
    return "";
}

function scenePromptSourceCacheKey(node, seen = new Set()) {
    if (!node || seen.has(node.id)) {
        return "";
    }
    const localKey = scenePromptSourceLocalCacheKey(node);
    if (localKey && node.scenePromptSourceKeyCache?.localKey === localKey) {
        return node.scenePromptSourceKeyCache.key;
    }
    const cacheKey = localKey;
    if (localKey && cacheKey) {
        node.scenePromptSourceKeyCache = { localKey, key: cacheKey };
    }
    return cacheKey;
}

function scenePromptTotalCount(node) {
    return scenePromptStats(node).total;
}

function scenePresetGraphNodes(preset) {
    const nodes = preset?.api_graph?.output;
    return nodes && typeof nodes === "object" ? nodes : null;
}

function apiLink(value) {
    return Array.isArray(value) && value.length === 2 ? String(value[0]) : "";
}

function apiInput(node, name) {
    return node?.inputs?.[name];
}

function apiMatrixEnabledCount(node) {
    return parseMatrixStateValue(apiInput(node, "matrix_json")).sets
        .filter((set) => set.enabled)
        .length;
}

function apiMatrixConfigured(node) {
    return parseMatrixStateValue(apiInput(node, "matrix_json")).sets.length > 0;
}

function scenePresetStats(presetId, upstream, stack = new Set(), preferredPreset = null) {
    const preset = preferredPreset || scenePresetDisplayGraphs.get(String(presetId || ""));
    const nodes = scenePresetGraphNodes(preset);
    if (!nodes || stack.has(presetId)) {
        return emptyScenePromptStats();
    }
    const outputEntry = Object.entries(nodes).find(([, value]) => value?.class_type === "ScenePresetOutput");
    if (!outputEntry) {
        return emptyScenePromptStats();
    }
    const outputSource = apiLink(apiInput(outputEntry[1], "scene_prompt"));
    if (!outputSource) {
        return emptyScenePromptStats();
    }
    const nextStack = new Set(stack);
    nextStack.add(presetId);
    const memo = new Map();
    const statsForNode = (nodeId) => {
        if (memo.has(nodeId)) {
            return memo.get(nodeId);
        }
        const node = nodes[String(nodeId)];
        if (!node) {
            return emptyScenePromptStats();
        }
        const source = (name) => {
            const sourceId = apiLink(apiInput(node, name));
            return sourceId ? statsForNode(sourceId) : null;
        };
        let result = emptyScenePromptStats();
        if (node.class_type === "ScenePresetInput") {
            result = upstream || { rows: 1, total: 1 };
        } else if (node.class_type === "ScenePrompt") {
            result = source("scene_prompt") || { rows: 1, total: 1 };
        } else if (node.class_type === "SceneMatrix") {
            const base = source("scene_prompt") || { rows: 1, total: 1 };
            const count = apiMatrixEnabledCount(node);
            const configured = apiMatrixConfigured(node);
            result = count ? { rows: base.rows * count, total: base.total * count } : (configured ? emptyScenePromptStats() : base);
        } else if (node.class_type === "ScenePath" || node.class_type === "SceneEmptyLatent") {
            result = source("scene_prompt") || { rows: 1, total: 1 };
        } else if (node.class_type === "ScenePromptCounter") {
            const base = source("scene_prompt") || { rows: 1, total: 1 };
            const count = clampSceneCount(apiInput(node, "count"), 1);
            result = { rows: base.rows, total: base.total * count };
        } else if (node.class_type === "ScenePromptMerge") {
            const first = source("scene_prompt1") || { rows: 1, total: 1 };
            const second = source("scene_prompt2") || { rows: 1, total: 1 };
            result = { rows: first.rows * second.rows, total: first.total * second.total };
        } else if (node.class_type === "ScenePromptQueue") {
            result = emptyScenePromptStats();
            for (let index = 1; index <= SCENE_PROMPT_QUEUE_INPUT_COUNT; index += 1) {
                const item = source(`scene_prompt${index}`);
                if (item) {
                    result = { rows: result.rows + item.rows, total: result.total + item.total };
                }
            }
            if (!result.rows) {
                result = { rows: 1, total: 1 };
            }
        } else if (node.class_type === "ScenePresetReference") {
            result = scenePresetStats(String(apiInput(node, "preset_id") || ""), source("scene_prompt"), nextStack);
        }
        result = { rows: sceneStatNumber(result.rows), total: sceneStatNumber(result.total) };
        memo.set(nodeId, result);
        return result;
    };
    return statsForNode(outputSource);
}

function emptyScenePromptStats() {
    return { rows: 0, total: 0 };
}

function sceneStatNumber(value) {
    const number = Number(value || 0);
    return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function scenePromptStats(node, seen = new Set(), memo = new Map()) {
    if (!node || seen.has(node.id)) {
        return emptyScenePromptStats();
    }
    const cacheKey = scenePromptSourceCacheKey(node);
    if (cacheKey && node.scenePromptTotalCache?.cacheKey === cacheKey) {
        return node.scenePromptTotalCache.stats;
    }
    if (cacheKey && memo.has(cacheKey)) {
        return memo.get(cacheKey);
    }

    seen.add(node.id);
    const finish = (stats) => {
        const result = {
            rows: sceneStatNumber(stats.rows),
            total: sceneStatNumber(stats.total),
        };
        if (cacheKey) {
            memo.set(cacheKey, result);
            node.scenePromptTotalCache = { cacheKey, stats: result };
        }
        return result;
    };

    if (isSceneNodeMuted(node)) {
        return finish(emptyScenePromptStats());
    }
    if (isSceneNodeBypassed(node)) {
        const bypassSource = sceneBypassInputSource(node);
        return finish(bypassSource ? scenePromptStats(bypassSource, new Set(seen), memo) : emptyScenePromptStats());
    }

    const upstream = scenePromptInputSource(node);
    if (isScenePromptNode(node)) {
        return finish(upstream ? scenePromptStats(upstream, new Set(seen), memo) : { rows: 1, total: 1 });
    }
    if (isPromptMatrixNode(node)) {
        const matrixCount = matrixLinesForNode(node).length;
        if (!matrixCount) {
            return finish(matrixConfiguredLineCount(node) > 0
                ? emptyScenePromptStats()
                : (upstream ? scenePromptStats(upstream, new Set(seen), memo) : { rows: 1, total: 1 }));
        }
        const base = upstream ? scenePromptStats(upstream, new Set(seen), memo) : { rows: 1, total: 1 };
        return finish({ rows: base.rows * matrixCount, total: base.total * matrixCount });
    }
    if (isScenePathNode(node)) {
        return finish(upstream ? scenePromptStats(upstream, new Set(seen), memo) : { rows: 1, total: 1 });
    }
    if (isScenePromptMergeNode(node)) {
        const sources = connectedScenePromptSourcesForMerge(node).map((entry) => entry.source);
        const firstSource = sources[0] || null;
        const secondSource = sources[1] || null;
        const first = firstSource ? scenePromptStats(firstSource, new Set(seen), memo) : { rows: 1, total: 1 };
        const second = secondSource ? scenePromptStats(secondSource, new Set(seen), memo) : { rows: 1, total: 1 };
        return finish({
            rows: first.rows * second.rows,
            total: first.total * second.total,
        });
    }
    if (isScenePromptCounterNode(node)) {
        const base = upstream ? scenePromptStats(upstream, new Set(seen), memo) : { rows: 1, total: 1 };
        return finish({ rows: base.rows, total: base.total * scenePromptCounterCount(node) });
    }
    if (isScenePromptQueueNode(node)) {
        let rows = 0;
        let total = 0;
        for (const { source } of connectedScenePromptSourcesForQueue(node)) {
            const stats = scenePromptStats(source, new Set(seen), memo);
            rows += stats.rows;
            total += stats.total;
        }
        return finish(rows ? { rows, total } : { rows: 1, total: 1 });
    }
    if (isSceneEmptyLatentNode(node)) {
        return finish(upstream ? scenePromptStats(upstream, new Set(seen), memo) : { rows: 1, total: 1 });
    }
    if (isScenePresetReferenceNode(node)) {
        const presetId = String(findWidget(node, "preset_id")?.value || "").trim();
        const base = upstream ? scenePromptStats(upstream, new Set(seen), memo) : { rows: 1, total: 1 };
        return finish(scenePresetStats(presetId, base, new Set(), node.scenePresetGraph || null));
    }
    return finish(emptyScenePromptStats());
}

function scenePromptInputNumber(input) {
    const match = String(input?.name || "").match(/^scene_prompt(\d+)$/u);
    return match ? Number.parseInt(match[1], 10) : null;
}

function scenePromptQueueInputIndexes(node) {
    return (node.inputs || [])
        .map((input, index) => ({ input, index }))
        .filter(({ input }) => /^scene_prompt\d+$/u.test(String(input?.name || "")))
        .sort((a, b) => scenePromptInputNumber(a.input) - scenePromptInputNumber(b.input));
}

function labelScenePromptInput(input, index) {
    if (!input) {
        return;
    }
    const label = `scene_prompt${index}`;
    input.label = label;
    input.display_name = label;
    input.localized_name = label;
}

function syncScenePromptQueueInputs(node) {
    if (!node) {
        return;
    }
    for (const input of node.inputs || []) {
        const inputIndex = scenePromptInputNumber(input);
        if (inputIndex) {
            labelScenePromptInput(input, inputIndex);
        }
    }
}

function connectedScenePromptSourcesForQueue(node) {
    const graph = node?.graph || app.graph;
    return scenePromptQueueInputIndexes(node)
        .map(({ input }) => {
            const source = resolveLinkedSourceFromInput(graph, input).source;
            return {
                input,
                source: source && isScenePromptSourceNode(source) ? source : null,
            };
        })
        .filter(({ source }) => !!source);
}

function connectedScenePromptSourcesForMerge(node) {
    const graph = node?.graph || app.graph;
    return ["scene_prompt1", "scene_prompt2"].map((name) => {
        const input = linkedInput(node, name);
        const source = resolveLinkedSourceFromInput(graph, input).source;
        return {
            name,
            input,
            source: source && isScenePromptSourceNode(source) ? source : null,
        };
    });
}

function mergeScenePromptRows(firstRow, secondRow) {
    const left = firstRow || emptyMatrixRow();
    const right = secondRow || emptyMatrixRow();
    const merged = mergePositiveNegativeParts(
        left.positive_parts || [],
        left.negative_parts || [],
        right.positive_parts || [],
        right.negative_parts || [],
    );
    const row = {
        ...left,
        labels: [...(left.labels || []), ...(right.labels || [])],
        positive_parts: merged.positiveParts,
        negative_parts: merged.negativeParts,
        path_parts: [...(left.path_parts || []), ...(right.path_parts || [])],
        display_labels: [...(left.display_labels || []), ...(right.display_labels || [])],
        display_label_groups: [...(left.display_label_groups || []), ...(right.display_label_groups || [])],
        set_refs: [...(left.set_refs || []), ...(right.set_refs || [])],
    };
    if (right.latent || left.latent) {
        row.latent = right.latent || left.latent;
    }
    return row;
}

function multiplyScenePromptEntryCount(entry, factor) {
    return {
        ...entry,
        count: sceneStatNumber(entry?.count) * sceneStatNumber(factor),
    };
}

function scenePromptEntryBatchSize(entry) {
    const batchSize = Number(entry?.row?.latent?.batch_size);
    return Number.isSafeInteger(batchSize) && batchSize >= 1 ? batchSize : 1;
}

function scenePromptEntryImageCount(entry) {
    return sceneStatNumber(entry?.count) * scenePromptEntryBatchSize(entry);
}

function mergeScenePromptEntryPair(firstEntry, secondEntry) {
    const primary = firstEntry || secondEntry || {};
    if (!firstEntry) {
        return secondEntry;
    }
    if (!secondEntry) {
        return firstEntry;
    }
    return {
        ...primary,
        parts: [...(firstEntry.parts || []), ...(secondEntry.parts || [])],
        count: sceneStatNumber(firstEntry.count) * sceneStatNumber(secondEntry.count),
        row: mergeScenePromptRows(firstEntry.row, secondEntry.row),
    };
}

function mergeScenePromptEntryLists(firstEntries, secondEntries, limit = Infinity) {
    const first = Array.isArray(firstEntries) ? firstEntries : [];
    const second = Array.isArray(secondEntries) ? secondEntries : [];
    if (!first.length) {
        return Number.isFinite(limit) ? second.slice(0, limit) : second;
    }
    if (!second.length) {
        return Number.isFinite(limit) ? first.slice(0, limit) : first;
    }
    const rows = [];
    const maxRows = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Infinity;
    for (const firstEntry of first) {
        for (const secondEntry of second) {
            rows.push(mergeScenePromptEntryPair(firstEntry, secondEntry));
            if (rows.length >= maxRows) {
                return rows;
            }
        }
    }
    return rows;
}

function sceneBypassInputSource(node) {
    if (isScenePromptMergeNode(node)) {
        const source = connectedScenePromptSourcesForMerge(node)
            .map((entry) => entry.source)
            .find(Boolean);
        return source || null;
    }
    if (isScenePromptQueueNode(node)) {
        const graph = node?.graph || app.graph;
        const input = (node.inputs || [])[0] || null;
        const source = input ? resolveLinkedSourceFromInput(graph, input).source : null;
        return source && isScenePromptSourceNode(source) ? source : null;
    }
    return scenePromptInputSource(node);
}

function scenePromptCounterCount(node) {
    const primitive = linkedSourceNode(node, "count");
    if (["PrimitiveInt", "PrimitiveFloat"].includes(nodeClassName(primitive))) {
        return clampSceneCount(findWidget(primitive, "value")?.value, 1);
    }
    return clampSceneCount(findWidget(node, "count")?.value, 1);
}

function sceneEmptyLatentConfig(node) {
    const dimension = (name) => clamp(
        Number.parseInt(String(findWidget(node, name)?.value ?? 512), 10) || 512,
        16,
        16384,
    );
    return {
        width: dimension("width"),
        height: dimension("height"),
        batch_size: clampSceneCount(findWidget(node, "batch_size")?.value, 1) || 1,
    };
}

function scenePromptInputSource(node) {
    const source = linkedSourceNode(node, "scene_prompt");
    return source && isScenePromptSourceNode(source) ? source : null;
}

function scenePromptLineageKey(node, limit = 80) {
    const parts = [];
    const seen = new Set();
    let current = node;
    let depth = 0;
    while (current && depth < limit) {
        if (seen.has(current.id)) {
            parts.push(`cycle:${current.id}`);
            break;
        }
        seen.add(current.id);
        parts.push([
            current.id ?? "",
            nodeClassName(current),
            sceneNodeMode(current),
            sceneNodeRevision(current),
            linkedInputKey(current, "scene_prompt"),
        ].map((part) => String(part ?? "")).join(":"));
        if (isScenePromptCounterNode(current)) {
            parts.push(`count:${scenePromptCounterCount(current)}`);
        }
        if (isSceneEmptyLatentNode(current)) {
            parts.push(`latent:${JSON.stringify(sceneEmptyLatentConfig(current))}`);
        }
        if (isPromptMatrixNode(current)) {
            parts.push(`matrix:${matrixSourceCacheKey(current)}`);
        }
        if (isScenePromptMergeNode(current)) {
            parts.push(JSON.stringify(connectedScenePromptSourcesForMerge(current).map(({ name, source }) => ({
                name,
                link: linkedInputKey(current, name),
                source_key: source ? scenePromptSourceCacheKey(source) : "",
            }))));
            break;
        }
        if (isScenePromptQueueNode(current)) {
            break;
        }
        current = scenePromptInputSource(current);
        depth += 1;
    }
    if (current && depth >= limit) {
        parts.push("limit");
    }
    return parts.join("|");
}

function sceneMatrixRowEntries(node, seen = new Set(), memo = new Map()) {
    if (isSceneNodeMuted(node)) {
        return [];
    }
    if (isSceneNodeBypassed(node)) {
        const bypassSource = sceneBypassInputSource(node);
        return bypassSource ? scenePromptRowEntries(bypassSource, new Set(seen), memo) : [];
    }

    const upstream = scenePromptInputSource(node);
    const upstreamEntries = upstream ? scenePromptRowEntries(upstream, new Set(seen), memo) : [];
    const baseEntries = upstreamEntries.length
        ? upstreamEntries
        : [{
            parts: [],
            count: 1,
            row: emptyMatrixRow(),
        }];
    const matrixRows = matrixLinesForNode(node);
    const rows = [];

    if (!matrixRows.length) {
        return matrixConfiguredLineCount(node) > 0 ? [] : (upstream ? upstreamEntries : []);
    }

    for (const matrixRow of matrixRows) {
        for (const entry of baseEntries) {
            const row = entry.row || emptyMatrixRow();
            const label = matrixLineLabel(matrixRow);
            const displayLabels = matrixLineDisplayLabels(matrixRow);
            const merged = mergePositiveNegativeParts(
                row.positive_parts || [],
                row.negative_parts || [],
                matrixRow.positive_parts || [],
                matrixRow.negative_parts || [],
            );
            rows.push({
                ...entry,
                parts: [...(entry.parts || []), label],
                row: {
                    ...row,
                    labels: [...(row.labels || []), label],
                    positive_parts: merged.positiveParts,
                    negative_parts: merged.negativeParts,
                    path_parts: [...(row.path_parts || [])],
                    set_refs: [
                        ...(row.set_refs || []),
                        matrixLineRef(matrixRow),
                    ],
                    display_labels: [
                        ...(row.display_labels || []),
                        ...displayLabels,
                    ],
                    display_label_groups: [
                        ...(row.display_label_groups || []),
                        displayLabels,
                    ],
                },
            });
        }
    }

    return rows;
}

function sceneQueueDisplayPartsForEntry(entry) {
    return (entry?.parts || [])
        .slice(-2)
        .reverse();
}

function scenePromptPreviewEntries(node, limit = MATRIX_SECTION_VISIBLE_ROWS, seen = new Set(), memo = new Map()) {
    const maxEntries = Math.max(0, Math.floor(Number(limit || 0)));
    if (!node || seen.has(node.id) || maxEntries <= 0) {
        return [];
    }
    const cacheKey = `${scenePromptSourceCacheKey(node)}::preview:${maxEntries}`;
    if (cacheKey && node.scenePromptPreviewCache?.cacheKey === cacheKey) {
        return node.scenePromptPreviewCache.entries;
    }
    if (cacheKey && memo.has(cacheKey)) {
        return memo.get(cacheKey);
    }

    seen.add(node.id);
    const finish = (entries) => {
        const preview = (entries || []).slice(0, maxEntries);
        if (cacheKey) {
            memo.set(cacheKey, preview);
            node.scenePromptPreviewCache = { cacheKey, entries: preview };
        }
        return preview;
    };

    if (isSceneNodeMuted(node)) {
        return finish([]);
    }
    if (isSceneNodeBypassed(node)) {
        const bypassSource = sceneBypassInputSource(node);
        return finish(bypassSource ? scenePromptPreviewEntries(bypassSource, maxEntries, new Set(seen), memo) : []);
    }

    if (isScenePromptNode(node)) {
        const title = scenePromptTitle(node);
        const upstream = scenePromptInputSource(node);
        const upstreamEntries = upstream
            ? scenePromptPreviewEntries(upstream, maxEntries, new Set(seen), memo)
            : [{
                parts: [],
                count: 1,
                row: emptyMatrixRow(),
            }];
        return finish(upstreamEntries.map((entry) => {
            const row = entry.row || emptyMatrixRow();
            return {
                ...entry,
                parts: [...(entry.parts || []), title],
                row: {
                    ...row,
                    labels: [...(row.labels || []), title],
                    path_parts: [...(row.path_parts || [])],
                },
            };
        }));
    }

    if (isPromptMatrixNode(node)) {
        const upstream = scenePromptInputSource(node);
        const matrixRows = matrixLinesForNode(node);
        if (!matrixRows.length) {
            return finish(matrixConfiguredLineCount(node) > 0
                ? []
                : (upstream ? scenePromptPreviewEntries(upstream, maxEntries, new Set(seen), memo) : []));
        }
        const entries = [];
        for (const matrixRow of matrixRows) {
            const remaining = maxEntries - entries.length;
            if (remaining <= 0) {
                break;
            }
            const baseEntries = upstream
                ? scenePromptPreviewEntries(upstream, remaining, new Set(seen), memo)
                : [{
                    parts: [],
                    count: 1,
                    row: emptyMatrixRow(),
                }];
            const label = matrixLineLabel(matrixRow);
            for (const entry of baseEntries) {
                const row = entry.row || emptyMatrixRow();
                entries.push({
                    ...entry,
                    parts: [...(entry.parts || []), label],
                    row: {
                        ...row,
                        labels: [...(row.labels || []), label],
                        path_parts: [...(row.path_parts || [])],
                    },
                });
                if (entries.length >= maxEntries) {
                    break;
                }
            }
        }
        return finish(entries);
    }

    if (isScenePathNode(node)) {
        const title = scenePathTitle(node);
        const pathMode = normalizePathMode(findWidget(node, "path_mode")?.value);
        const upstream = scenePromptInputSource(node);
        if (!upstream) {
            return finish([]);
        }
        return finish(scenePromptPreviewEntries(upstream, maxEntries, new Set(seen), memo).map((entry) => {
            const row = entry.row || emptyMatrixRow();
            return {
                ...entry,
                row: {
                    ...row,
                    path_parts: appendScenePathPart(row.path_parts || [], title, pathMode),
                },
            };
        }));
    }

    if (isScenePromptMergeNode(node)) {
        const sources = connectedScenePromptSourcesForMerge(node).map((entry) => entry.source);
        const firstSource = sources[0] || null;
        const secondSource = sources[1] || null;
        if (!firstSource) {
            return finish(secondSource ? scenePromptPreviewEntries(secondSource, maxEntries, new Set(seen), memo) : []);
        }
        if (!secondSource) {
            return finish(scenePromptPreviewEntries(firstSource, maxEntries, new Set(seen), memo));
        }
        const firstEntries = scenePromptPreviewEntries(firstSource, maxEntries, new Set(seen), memo);
        const firstCount = firstEntries.length || 1;
        const secondLimit = Math.max(1, Math.ceil(maxEntries / firstCount));
        const secondEntries = scenePromptPreviewEntries(secondSource, secondLimit, new Set(seen), memo);
        return finish(mergeScenePromptEntryLists(firstEntries, secondEntries, maxEntries));
    }

    if (isScenePromptCounterNode(node)) {
        const count = scenePromptCounterCount(node);
        const upstream = scenePromptInputSource(node);
        if (!upstream) {
            return finish([]);
        }
        return finish(scenePromptPreviewEntries(upstream, maxEntries, new Set(seen), memo).map((entry) => ({
            ...multiplyScenePromptEntryCount(entry, count),
        })));
    }

    if (isSceneEmptyLatentNode(node)) {
        const upstream = scenePromptInputSource(node);
        if (!upstream) {
            return finish([]);
        }
        const latent = sceneEmptyLatentConfig(node);
        return finish(scenePromptPreviewEntries(upstream, maxEntries, new Set(seen), memo).map((entry) => ({
            ...entry,
            row: { ...(entry.row || emptyMatrixRow()), latent },
        })));
    }

    if (isScenePromptQueueNode(node)) {
        const entries = [];
        for (const { source } of connectedScenePromptSourcesForQueue(node)) {
            const remaining = maxEntries - entries.length;
            if (remaining <= 0) {
                break;
            }
            for (const entry of scenePromptPreviewEntries(source, remaining, new Set(seen), memo)) {
                entries.push({
                    ...entry,
                    display_parts: sceneQueueDisplayPartsForEntry(entry),
                });
                if (entries.length >= maxEntries) {
                    break;
                }
            }
        }
        return finish(entries);
    }

    return finish([]);
}

function scenePromptRowEntries(node, seen = new Set(), memo = new Map()) {
    if (!node || seen.has(node.id)) {
        return [];
    }
    const memoKey = scenePromptSourceCacheKey(node);
    if (memoKey && memo.has(memoKey)) {
        return memo.get(memoKey);
    }
    const finish = (entries) => {
        if (memoKey) {
            memo.set(memoKey, entries);
        }
        return entries;
    };

    seen.add(node.id);

    if (isSceneNodeMuted(node)) {
        return finish([]);
    }
    if (isSceneNodeBypassed(node)) {
        const bypassSource = sceneBypassInputSource(node);
        return finish(bypassSource ? scenePromptRowEntries(bypassSource, new Set(seen), memo) : []);
    }

    if (isScenePromptNode(node)) {
        const title = scenePromptTitle(node);
        const order = findWidget(node, "category_order")?.value || "";
        const positiveParts = promptPartsFromState(
            findWidget(node, "positive_base")?.value || "",
            readStateFromWidget(node, "positive_json"),
            order,
        );
        const negativeParts = promptPartsFromState(
            findWidget(node, "negative_base")?.value || "",
            readStateFromWidget(node, "negative_json"),
            order,
        );
        const upstream = scenePromptInputSource(node);
        const upstreamEntries = upstream
            ? scenePromptRowEntries(upstream, new Set(seen), memo)
            : [{
                parts: [],
                count: 1,
                row: emptyMatrixRow(),
            }];
        return finish(upstreamEntries.map((entry) => {
            const row = entry.row || emptyMatrixRow();
            const merged = mergePositiveNegativeParts(
                row.positive_parts || [],
                row.negative_parts || [],
                positiveParts,
                negativeParts,
            );
            return {
                ...entry,
                parts: [...(entry.parts || []), title],
                row: {
                    ...row,
                    labels: [...(row.labels || []), title],
                    positive_parts: merged.positiveParts,
                    negative_parts: merged.negativeParts,
                    path_parts: [...(row.path_parts || [])],
                },
            };
        }));
    }

    if (isPromptMatrixNode(node)) {
        return finish(sceneMatrixRowEntries(node, seen, memo));
    }

    if (isScenePathNode(node)) {
        const title = scenePathTitle(node);
        const pathMode = normalizePathMode(findWidget(node, "path_mode")?.value);
        const upstream = scenePromptInputSource(node);
        if (!upstream) {
            return finish([]);
        }
        return finish(scenePromptRowEntries(upstream, new Set(seen), memo).map((entry) => {
            const row = entry.row || emptyMatrixRow();
            return {
                ...entry,
                row: {
                    ...row,
                    path_parts: appendScenePathPart(row.path_parts || [], title, pathMode),
                },
            };
        }));
    }

    if (isScenePromptMergeNode(node)) {
        const sources = connectedScenePromptSourcesForMerge(node).map((entry) => entry.source);
        const firstSource = sources[0] || null;
        const secondSource = sources[1] || null;
        if (!firstSource) {
            return finish(secondSource ? scenePromptRowEntries(secondSource, new Set(seen), memo) : []);
        }
        if (!secondSource) {
            return finish(scenePromptRowEntries(firstSource, new Set(seen), memo));
        }
        const firstEntries = scenePromptRowEntries(firstSource, new Set(seen), memo);
        const secondEntries = scenePromptRowEntries(secondSource, new Set(seen), memo);
        return finish(mergeScenePromptEntryLists(firstEntries, secondEntries));
    }

    if (isScenePromptCounterNode(node)) {
        const count = scenePromptCounterCount(node);
        const upstream = scenePromptInputSource(node);
        if (!upstream) {
            return finish([]);
        }
        return finish(scenePromptRowEntries(upstream, new Set(seen), memo).map((entry) => ({
            ...multiplyScenePromptEntryCount(entry, count),
        })));
    }

    if (isSceneEmptyLatentNode(node)) {
        const upstream = scenePromptInputSource(node);
        if (!upstream) {
            return finish([]);
        }
        const latent = sceneEmptyLatentConfig(node);
        return finish(scenePromptRowEntries(upstream, new Set(seen), memo).map((entry) => ({
            ...entry,
            row: { ...(entry.row || emptyMatrixRow()), latent },
        })));
    }

    if (isScenePromptQueueNode(node)) {
        return finish(scenePromptQueueRowEntries(node, seen, memo));
    }

    return finish([]);
}

function scenePromptQueueRowEntries(node, seen = new Set(), memo = new Map()) {
    if (isSceneNodeMuted(node)) {
        return [];
    }
    if (isSceneNodeBypassed(node)) {
        const bypassSource = sceneBypassInputSource(node);
        return bypassSource ? scenePromptRowEntries(bypassSource, new Set(seen), memo) : [];
    }

    const cacheKey = scenePromptQueueRowsCacheKey(node);
    if (cacheKey && node.scenePromptQueueRowsCache?.cacheKey === cacheKey) {
        return node.scenePromptQueueRowsCache.entries;
    }
    if (cacheKey && memo.has(cacheKey)) {
        return memo.get(cacheKey);
    }
    const entries = [];
    for (const { source } of connectedScenePromptSourcesForQueue(node)) {
        for (const entry of scenePromptRowEntries(source, new Set(seen), memo)) {
            entries.push({
                ...entry,
                display_parts: sceneQueueDisplayPartsForEntry(entry),
            });
        }
    }
    if (cacheKey) {
        memo.set(cacheKey, entries);
        node.scenePromptQueueRowsCache = { cacheKey, entries };
    }
    return entries;
}

function sceneNodeRevision(node) {
    return Number(node?.scenePromptRevision || 0);
}

function scenePromptQueueRowsCacheKey(node) {
    const graph = node?.graph || app.graph;
    return JSON.stringify({
        type: "queue_rows",
        id: node?.id ?? null,
        mode: sceneNodeMode(node),
        inputs: scenePromptQueueInputIndexes(node).map(({ input }) => {
            const resolved = resolveLinkedSourceFromInput(graph, input);
            return {
                name: String(input?.name || ""),
                link: input?.link ?? null,
                source_path: resolved.keyParts,
                source_mode: sceneNodeMode(resolved.source),
                source_revision: sceneNodeRevision(resolved.source),
                source_lineage: resolved.source ? scenePromptLineageKey(resolved.source) : "",
            };
        }),
    });
}

function scenePromptQueueDisplayCacheKey(node, width = null) {
    const drawWidth = width || node.size?.[0] || 360;
    const rowKey = scenePromptQueueRowsCacheKey(node);
    return JSON.stringify({
        width: Math.ceil(drawWidth),
        rows: rowKey,
    });
}

function computeScenePromptQueueDisplayCache(node, width = null, cacheKey = null) {
    const drawWidth = width || node.size?.[0] || 360;
    const finalKey = cacheKey || scenePromptQueueDisplayCacheKey(node, drawWidth);
    if (node.scenePromptQueueDisplayCache?.cacheKey === finalKey) {
        return node.scenePromptQueueDisplayCache;
    }
    const stats = scenePromptStats(node);
    const rows = scenePromptQueueRowEntries(node);
    const entries = sceneQueueDisplayEntriesFromRows(sceneQueuePreviewRows(node));
    const totalImages = rows.length
        ? rows.reduce((total, entry) => total + scenePromptEntryImageCount(entry), 0)
        : stats.total;
    const cache = {
        cacheKey: finalKey,
        width: drawWidth,
        title: "生成キュー",
        emptyText: "scene_promptを接続してください",
        noRowsText: "生成対象がありません",
        hasMatrix: connectedScenePromptSourcesForQueue(node).length > 0,
        rowCount: stats.rows,
        enabledCount: stats.rows,
        totalBatches: stats.total,
        totalImages,
        entries,
        naturalHeight: sceneQueueDisplayNaturalHeight(entries, drawWidth),
    };
    node.scenePromptQueueDisplayCache = cache;
    node.scenePromptQueueRenderCache = null;
    return cache;
}

function scenePromptQueueDisplayCache(node, width = null) {
    const drawWidth = width || node.size?.[0] || 360;
    const cached = node.scenePromptQueueDisplayCache;
    const cacheKey = scenePromptQueueDisplayCacheKey(node, drawWidth);
    if (cached && Math.ceil(cached.width || 0) === Math.ceil(drawWidth) && cached.cacheKey === cacheKey) {
        return cached;
    }
    return computeScenePromptQueueDisplayCache(node, drawWidth, cacheKey);
}

function scenePromptQueueListHeight(node) {
    return SCENE_COMPACT_WIDGET_HEIGHT;
}

function drawScenePromptQueueList(ctx, node, width, y, height) {
    const drawWidth = sceneWidgetDrawWidth(node, width, 360);
    if (!sceneShouldDrawDetails()) {
        drawSceneCompactWidget(ctx, node, drawWidth, y, height, "scene_prompt");
        return;
    }
    const cache = scenePromptQueueDisplayCache(node, drawWidth);
    const drawHeight = sceneWidgetDrawHeight(
        node,
        "scene_prompt_queue_list",
        y,
        height,
        cache.naturalHeight,
        56,
    );
    const canvas = cachedSceneWidgetCanvas(
        node,
        "scenePromptQueueRenderCache",
        drawWidth,
        drawHeight,
        (renderCtx, renderWidth, renderHeight) => drawSceneQueueListContent(renderCtx, cache, renderWidth, 0, renderHeight),
    );
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y, drawWidth, drawHeight);
    ctx.clip();
    if (canvas) {
        ctx.drawImage(canvas, 0, y, drawWidth, drawHeight);
    } else {
        drawSceneQueueListContent(ctx, cache, drawWidth, y, drawHeight);
    }
    ctx.restore();
}

function addScenePromptQueueListWidget(node) {
    const existing = findSceneWidget(node, "scene_prompt_queue_list");
    if (existing) {
        return existing;
    }
    const widget = {
        type: "scene_prompt_queue_list",
        name: "生成キュー",
        value: "",
        serialize: false,
        options: { serialize: false },
        sceneRole: "scene_prompt_queue_list",
        computeSize(width) {
            return [sceneWidgetDrawWidth(node, width, 360), scenePromptQueueListHeight(node)];
        },
        draw(ctx, drawNode, width, y, height) {
            drawScenePromptQueueList(ctx, drawNode, width, y, height);
        },
    };
    node.widgets = node.widgets || [];
    node.widgets.push(widget);
    return widget;
}

function sceneExpandCounts(node) {
    const run = sceneBatchRunForNode(node);
    if (run?.snapshotReady) {
        const totalBatches = Number(run.total);
        const totalImages = Number(run.totalImages);
        if (Number.isSafeInteger(totalBatches) && totalBatches >= 0 && Number.isSafeInteger(totalImages) && totalImages >= 0) {
            return { totalBatches, totalImages };
        }
    }
    if (isSceneNodeMuted(node) || isSceneNodeBypassed(node)) {
        return { totalBatches: 0, totalImages: 0 };
    }
    const scenePromptSource = sceneExpandScenePromptSourceNode(node);
    if (isScenePromptSourceNode(scenePromptSource)) {
        return { totalBatches: scenePromptTotalCount(scenePromptSource), totalImages: null };
    }
    return { totalBatches: 0, totalImages: null };
}

function sceneExpandCountLabel(node) {
    const { totalBatches, totalImages } = sceneExpandCounts(node);
    return totalImages === null ? `${totalBatches}回` : formatSceneExpandCounts(totalBatches, totalImages);
}

function sceneBatchRunId(date = new Date()) {
    const pad = (value, length = 2) => String(value).padStart(length, "0");
    return [
        date.getFullYear(),
        "_",
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        "_",
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
    ].join("");
}

function sceneBatchSeedBase() {
    if (globalThis.crypto?.getRandomValues) {
        const values = new Uint32Array(2);
        globalThis.crypto.getRandomValues(values);
        const seed = ((values[0] & 0x1fffff) * 0x100000000) + values[1];
        return Math.max(1, seed);
    }
    return Math.max(1, Math.floor((Date.now() * 1000) + (Math.random() * 1000)));
}

function sceneBatchPlanId() {
    const cryptoApi = globalThis.crypto;
    if (typeof cryptoApi?.randomUUID === "function") {
        return cryptoApi.randomUUID().replaceAll("-", "");
    }
    if (typeof cryptoApi?.getRandomValues === "function") {
        const values = new Uint32Array(4);
        cryptoApi.getRandomValues(values);
        return Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("");
    }
    return "";
}

function sceneBatchNodeRunId(node) {
    return String(findWidget(node, "run_id")?.value || "").trim();
}

function sceneBatchRunForNode(node) {
    const runId = sceneBatchNodeRunId(node);
    if (runId && sceneBatchRunsById.has(runId)) {
        return sceneBatchRunsById.get(runId);
    }
    if (runId && sceneBatchDetachedRuns.has(runId)) {
        return sceneBatchDetachedRuns.get(runId);
    }
    return null;
}

function sceneBatchRunStatus(run) {
    if (!run) {
        return "idle";
    }
    if (sceneBatchRun === run) {
        return "active";
    }
    if (sceneBatchDetachedRuns.get(run.runId) === run) {
        return "stopping";
    }
    if (sceneBatchPendingRuns.includes(run)) {
        return "pending";
    }
    if (run.releaseBlocked) {
        return "blocked";
    }
    return "idle";
}

function sceneNodeForRun(run) {
    const node = run?.node || null;
    if (!node || node.graph !== run.graph || String(node.id) !== String(run.nodeId)) {
        return null;
    }
    return sceneBatchNodeRunId(node) === run.runId ? node : null;
}

function markSceneNodeChanged(node, options = {}) {
    const background = options.background !== false;
    node?.setDirtyCanvas?.(true, background);
    app.graph?.setDirtyCanvas?.(true, background);
    app.canvas?.setDirty?.(true, background);
    if (options.graphChange !== false) {
        app.graph?.change?.();
    }
}

function updateSceneExpandButton(node, options = {}) {
    const button = findSceneWidget(node, "expand_run_all");
    if (!button) {
        return;
    }

    const previousName = button.name;
    const run = sceneBatchRunForNode(node);
    const status = sceneBatchRunStatus(run);
    if (status === "active") {
        if (run.preparing) {
            button.name = "準備中";
        } else {
            const current = Math.min(run.nextIndex + 1, run.total);
            button.name = `停止 ${current}/${run.total}`;
        }
    } else if (status === "pending") {
        const position = Math.max(1, sceneBatchPendingRuns.indexOf(run) + 1);
        button.name = `待機 ${position}/${sceneBatchPendingRuns.length}`;
    } else if (status === "stopping") {
        button.name = "停止処理中";
    } else if (status === "blocked") {
        button.name = "停止確認待ち";
    } else {
        button.name = "連続生成";
    }
    if (button.name !== previousName) {
        markSceneNodeChanged(node, options);
    }
}

function updateSceneExpandCountWidget(node) {
    const widget = findSceneWidget(node, "expand_total_count");
    if (!widget) {
        return;
    }
    const { totalBatches, totalImages } = sceneExpandCounts(node);
    widget.value = sceneExpandCountLabel(node);
    widget.sceneTotalCount = totalBatches;
    widget.sceneTotalImages = totalImages;
}

function drawSceneExpandCount(ctx, node, width, y, height) {
    const drawWidth = sceneWidgetDrawWidth(node, width, 220);
    const widget = findSceneWidget(node, "expand_total_count");
    const { totalBatches } = sceneExpandCounts(node);
    if (widget) {
        widget.sceneTotalCount = totalBatches;
        widget.value = sceneExpandCountLabel(node);
    }
    const text = `生成 ${widget?.value || "0回"}`;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y, drawWidth, height);
    ctx.clip();
    ctx.font = "bold 12px sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillStyle = totalBatches > 0 ? "#ffe36d" : "#aab3c4";
    ctx.fillText(fitCanvasText(ctx, text, Math.max(40, drawWidth - 20)), 10, y + Math.max(10, height / 2));
    ctx.restore();
}

function addSceneExpandCountWidget(node) {
    const existing = findSceneWidget(node, "expand_total_count");
    if (existing) {
        return existing;
    }
    const widget = {
        type: "scene_expand_total_count",
        name: "生成枚数",
        value: "",
        serialize: false,
        options: { serialize: false },
        sceneRole: "expand_total_count",
        computeSize(width) {
            return [sceneWidgetDrawWidth(node, width, 220), 22];
        },
        draw(ctx, drawNode, width, y, height) {
            drawSceneExpandCount(ctx, drawNode, width, y, height);
        },
    };
    node.widgets = node.widgets || [];
    node.widgets.push(widget);
    return widget;
}

function showSceneBatchError(message, error = null) {
    const detail = error?.message ? `${message}\n${error.message}` : message;
    console.error("[Scene Prompt]", detail, error || "");
    if (app.ui?.dialog?.show) {
        const dialogBody = document.createElement("div");
        dialogBody.textContent = detail;
        dialogBody.style.whiteSpace = "pre-wrap";
        app.ui.dialog.show(dialogBody);
    } else if (typeof window !== "undefined") {
        window.alert(detail);
    }
}

function sceneNodeDisplayNameFromValidation(nodeId, nodeError) {
    const classType = String(nodeError?.class_type || "").trim();
    const node = sceneNodeById(nodeId);
    const title = String(node?.title || "").trim();
    if (title && title !== classType && title !== SCENE_NODE_DISPLAY_NAMES[classType]) {
        return `${title} (${SCENE_NODE_DISPLAY_NAMES[classType] || classType || "Unknown"})`;
    }
    return SCENE_NODE_DISPLAY_NAMES[classType] || classType || "Unknown";
}

function sceneValidationInputName(reason) {
    return String(reason?.extra_info?.input_name || reason?.details || "").trim();
}

function isScenePromptInputName(name) {
    return /^scene_prompt(?:\d+)?$/.test(String(name || "").trim());
}

function isSceneMissingPromptReason(reason) {
    return String(reason?.type || "").trim() === "required_input_missing"
        && isScenePromptInputName(sceneValidationInputName(reason));
}

function scenePromptValidationEntries(payload) {
    const nodeErrors = payload?.node_errors && typeof payload.node_errors === "object"
        ? payload.node_errors
        : {};
    const entries = [];
    for (const [nodeId, nodeError] of Object.entries(nodeErrors)) {
        const classType = String(nodeError?.class_type || "").trim();
        if (!SCENE_NODE_DISPLAY_NAMES[classType]) {
            continue;
        }
        const reasons = (Array.isArray(nodeError?.errors) ? nodeError.errors : [])
            .filter(isSceneMissingPromptReason);
        if (!reasons.length) {
            continue;
        }
        entries.push({ nodeId, nodeError, reasons });
    }
    return entries;
}

function formatPromptValidationMessage(payload) {
    const entries = scenePromptValidationEntries(payload);
    const lines = [
        "ワークフローの接続不足で生成できませんでした。",
        "線がつながっていない Scene ノードがあります。",
        "",
    ];

    for (const { nodeId, nodeError, reasons } of entries) {
        const nodeName = sceneNodeDisplayNameFromValidation(nodeId, nodeError);
        lines.push(`・${nodeName} #${nodeId}`);
        for (const reason of reasons) {
            const inputName = sceneValidationInputName(reason);
            lines.push(`  - 必須入力「${inputName}」が未接続です。`);
        }
        const outputs = Array.isArray(nodeError?.dependent_outputs)
            ? nodeError.dependent_outputs.filter((item) => String(item || "").trim())
            : [];
        if (outputs.length) {
            lines.push(`  - 影響する出力: ${outputs.join(", ")}`);
        }
    }

    return lines.join("\n").trim();
}

function maybeShowPromptValidationError(payload) {
    const entries = scenePromptValidationEntries(payload);
    if (!entries.length) {
        return false;
    }

    const key = JSON.stringify({
        nodes: entries.map(({ nodeId, nodeError, reasons }) => ({
            nodeId,
            class_type: nodeError?.class_type || "",
            reasons: reasons.map((reason) => ({
                type: reason?.type || "",
                input: sceneValidationInputName(reason),
            })),
            outputs: nodeError?.dependent_outputs || [],
        })),
    });
    const now = Date.now();
    if (key === sceneLastPromptValidationErrorKey && now - sceneLastPromptValidationErrorAt < 1500) {
        return true;
    }
    sceneLastPromptValidationErrorKey = key;
    sceneLastPromptValidationErrorAt = now;
    showSceneBatchError(formatPromptValidationMessage(payload));
    return true;
}

function showPromptValidationErrorFromThrown(error) {
    const candidates = [
        error?.response,
        error?.responseJson,
        error?.data,
        error,
    ];
    for (const candidate of candidates) {
        if (candidate && typeof candidate === "object" && maybeShowPromptValidationError(candidate)) {
            return true;
        }
    }
    return false;
}

function cloneScenePromptPayload(value) {
    if (typeof structuredClone === "function") {
        return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
}

async function createSceneBatchPromptSnapshot(expandNodeId) {
    const graphToPrompt = typeof app.graphToPrompt === "function" ? app.graphToPrompt.bind(app) : null;
    if (!graphToPrompt) {
        throw new Error("このComfyUIでは開始時点のプロンプトを安全に固定できません。");
    }
    const prompt = await graphToPrompt();
    const snapshot = sliceSceneBatchPrompt(cloneScenePromptPayload(prompt || {}), expandNodeId);
    const expandPrompt = snapshot?.output?.[String(expandNodeId)];
    if (!snapshot?.output || !expandPrompt?.inputs) {
        throw new Error("Scene Prompt Expand のプロンプトを取得できませんでした。");
    }
    return snapshot;
}

function sceneRunTargetNodes(apiGraph) {
    return Object.values(apiGraph?.output || {}).filter((node) => (
        ["ScenePrompt", "SceneMatrix", "ScenePresetReference", "ScenePromptExpand"].includes(node?.class_type)
    ));
}

function applySceneRunHandle(apiGraph, runHandle) {
    const targetNodes = Object.values(apiGraph?.output || {}).filter((node) => (
        ["ScenePrompt", "SceneMatrix", "ScenePresetReference", "ScenePromptExpand"].includes(node?.class_type)
    ));
    for (const node of targetNodes) {
        node.inputs = node.inputs || {};
        node.inputs.run_handle = runHandle;
        delete node.inputs.user_id;
    }
    return apiGraph;
}

async function prepareSceneRunContext(apiGraph, expandNodeId = null) {
    if (!sceneRunTargetNodes(apiGraph).length) {
        return null;
    }
    const response = await api.fetchApi("/scene_prompt/runs/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_graph: apiGraph, expand_node_id: expandNodeId }),
    });
    const data = await readApiJson(response, "Scene Promptの実行準備に失敗しました");
    if (!response.ok || !data?.run_handle) {
        const error = new Error(data?.error || "Scene Promptの実行準備に失敗しました");
        error.scenePresetReferenceId = data?.node_id ? String(data.node_id) : "";
        throw error;
    }
    applySceneRunHandle(apiGraph, String(data.run_handle));
    return data;
}

function promptDescendantIds(nodes, sourceId) {
    const targets = new Map();
    for (const [nodeId, node] of Object.entries(nodes || {})) {
        for (const input of Object.values(node?.inputs || {})) {
            const linkedId = apiLink(input);
            if (!linkedId) {
                continue;
            }
            const entries = targets.get(linkedId) || [];
            entries.push(String(nodeId));
            targets.set(linkedId, entries);
        }
    }
    const descendants = new Set();
    const pending = [String(sourceId)];
    while (pending.length) {
        const nodeId = pending.pop();
        if (descendants.has(nodeId) || !nodes?.[nodeId]) {
            continue;
        }
        descendants.add(nodeId);
        pending.push(...(targets.get(nodeId) || []));
    }
    return descendants;
}

function promptAncestorIds(nodes, nodeIds) {
    const ancestors = new Set();
    const pending = [...nodeIds];
    while (pending.length) {
        const nodeId = String(pending.pop());
        if (ancestors.has(nodeId) || !nodes?.[nodeId]) {
            continue;
        }
        ancestors.add(nodeId);
        for (const input of Object.values(nodes[nodeId]?.inputs || {})) {
            const linkedId = apiLink(input);
            if (linkedId) {
                pending.push(linkedId);
            }
        }
    }
    return ancestors;
}

function sliceSceneBatchPrompt(prompt, expandNodeId) {
    const nodes = prompt?.output;
    const expandId = String(expandNodeId);
    if (!nodes?.[expandId]) {
        throw new Error("Scene Prompt Expand のプロンプトを取得できませんでした。");
    }
    const branch = promptDescendantIds(nodes, expandId);
    const keep = promptAncestorIds(nodes, branch);
    for (const nodeId of keep) {
        if (nodeId !== expandId && nodes[nodeId]?.class_type === "ScenePromptExpand") {
            throw new Error("この出力は複数の Scene Prompt Expand に接続されているため実行できません。");
        }
    }
    const snapshot = { ...prompt, output: {} };
    for (const nodeId of keep) {
        snapshot.output[nodeId] = nodes[nodeId];
    }
    return snapshot;
}

function showSceneNotification(message) {
    console.info("[Scene Prompt]", message);
    if (typeof document === "undefined") {
        return;
    }
    let notice = document.getElementById("scene-prompt-notification");
    if (!notice) {
        notice = document.createElement("div");
        notice.id = "scene-prompt-notification";
        notice.className = "pc-scene-notification";
        document.body.appendChild(notice);
    }
    notice.textContent = message;
    notice.hidden = false;
    if (scenePresetNotificationTimer) {
        clearTimeout(scenePresetNotificationTimer);
    }
    scenePresetNotificationTimer = setTimeout(() => {
        notice.hidden = true;
        scenePresetNotificationTimer = null;
    }, 3200);
}

async function resolveScenePresetsForRun(run, snapshot, expandNodeId) {
    if (run.cancelled) {
        return null;
    }
    const referenceIds = scenePresetReferenceIdsForExpand(snapshot, expandNodeId);
    clearScenePresetReferenceErrors({ nodeIds: referenceIds });
    const data = await prepareSceneRunContext(snapshot, expandNodeId);
    if (run.cancelled) {
        releaseSceneRunHandle(data?.run_handle);
        return null;
    }
    clearScenePresetReferenceErrors({ nodeIds: referenceIds });
    run.presetGraphs = new Map(Object.entries(data.preset_graphs || {}));
    run.presetSnapshots = Array.isArray(data.presets) ? data.presets : [];
    run.runHandle = String(data.run_handle);
    return data;
}

function releaseCancelledSceneBatchRun(run) {
    if (!run || run.snapshotReleased) {
        return;
    }
    run.snapshotReleased = true;
    releaseSceneRunHandle(run.runHandle);
}

function cancelSceneBatchRunPreparation(run) {
    if (!run || run.cancelled) {
        return;
    }
    run.cancelled = true;
    run.resolveController?.abort();
    releaseCancelledSceneBatchRun(run);
}

function scenePresetReferenceIdsForExpand(apiGraph, expandNodeId) {
    const nodes = apiGraph?.output;
    const expand = nodes?.[String(expandNodeId)];
    const source = apiLink(apiInput(expand, "scene_prompt"));
    if (!source || !nodes) {
        return [];
    }
    const ids = new Set();
    const visited = new Set();
    const visit = (nodeId) => {
        const normalizedId = String(nodeId);
        if (visited.has(normalizedId)) {
            return;
        }
        visited.add(normalizedId);
        const node = nodes[normalizedId];
        if (!node) {
            return;
        }
        if (node.class_type === "ScenePresetReference") {
            ids.add(normalizedId);
        }
        for (const value of Object.values(node.inputs || {})) {
            const linkedId = apiLink(value);
            if (linkedId) {
                visit(linkedId);
            }
        }
    };
    visit(source);
    return [...ids];
}

function markScenePresetReferenceErrors(message, options = {}) {
    const targetIds = new Set();
    if (options.nodeId) {
        targetIds.add(String(options.nodeId));
    } else {
        for (const nodeId of options.relatedNodeIds || []) {
            targetIds.add(String(nodeId));
        }
    }
    if (!targetIds.size) {
        return;
    }
    for (const node of app.graph?._nodes || []) {
        if (!isScenePresetReferenceNode(node) || !targetIds.has(String(node.id))) {
            continue;
        }
        if (!node.scenePresetOriginalColors) {
            node.scenePresetOriginalColors = { color: node.color, bgcolor: node.bgcolor };
        }
        node.color = "#7f1d1d";
        node.bgcolor = "#3b1010";
        node.scenePresetError = message;
        node.setDirtyCanvas?.(true, true);
    }
    app.graph?.setDirtyCanvas?.(true, true);
}

function clearScenePresetReferenceErrors(options = {}) {
    const targetIds = new Set((options.nodeIds || []).map((nodeId) => String(nodeId)));
    if (!targetIds.size) {
        return;
    }
    for (const node of app.graph?._nodes || []) {
        if (!isScenePresetReferenceNode(node) || !node.scenePresetOriginalColors || !targetIds.has(String(node.id))) {
            continue;
        }
        node.color = node.scenePresetOriginalColors.color;
        node.bgcolor = node.scenePresetOriginalColors.bgcolor;
        node.scenePresetOriginalColors = null;
        node.scenePresetError = "";
        node.setDirtyCanvas?.(true, true);
    }
    app.graph?.setDirtyCanvas?.(true, true);
}

async function queueSingleScenePrompt() {
    const run = sceneBatchRun;
    if (run && run.nextIndex > 0 && !run.cachedPrompt) {
        throw new Error("連続生成用プロンプトを作成できませんでした。最初から実行し直してください。");
    }
    if (run?.cachedPrompt) {
        const expandPrompt = run.cachedPrompt.output?.[String(run.nodeId)];
        if (!expandPrompt?.inputs) {
            throw new Error("連続生成用プロンプトを更新できませんでした。");
        }
        expandPrompt.inputs.current_index = run.nextIndex;
        expandPrompt.inputs.run_id = run.runId;
        expandPrompt.inputs.seed_base = run.currentSeed;
        const result = await api.queuePrompt(0, run.cachedPrompt);
        acceptSceneBatchPrompt(run, result);
        return result;
    }

    if (run?.firstPromptSnapshot) {
        const result = await api.queuePrompt(0, run.firstPromptSnapshot);
        acceptSceneBatchPrompt(run, result);
        return result;
    }

    const queuePrompt = typeof app.queuePrompt === "function" ? app.queuePrompt.bind(app) : null;
    if (!queuePrompt) {
        throw new Error("ComfyUIのQueue関数が見つかりません。");
    }

    sceneQueuePromptSyncPaused += 1;
    try {
        return await queuePrompt(0, 1);
    } finally {
        sceneQueuePromptSyncPaused = Math.max(0, sceneQueuePromptSyncPaused - 1);
    }
}

function scenePromptInputSourceId(value) {
    if (!Array.isArray(value) || value.length < 2) {
        return "";
    }
    return String(value[0]);
}

function scenePromptInputSources(promptNode) {
    const sources = [];
    for (const value of Object.values(promptNode?.inputs || {})) {
        const sourceId = scenePromptInputSourceId(value);
        if (sourceId) {
            sources.push(sourceId);
        }
    }
    return sources;
}

function buildSceneBatchCachedPrompt(prompt, expandNodeId) {
    const cached = cloneScenePromptPayload(prompt);
    const output = cached?.output;
    const expandPrompt = output?.[String(expandNodeId)];
    const sourceId = scenePromptInputSourceId(expandPrompt?.inputs?.scene_prompt);
    if (!output || !expandPrompt?.inputs || !sourceId) {
        return null;
    }

    delete expandPrompt.inputs.scene_prompt;
    const referenceCounts = new Map();
    for (const promptNode of Object.values(output)) {
        for (const inputSourceId of scenePromptInputSources(promptNode)) {
            referenceCounts.set(inputSourceId, (referenceCounts.get(inputSourceId) || 0) + 1);
        }
    }

    const pending = Object.entries(output)
        .filter(([nodeId, promptNode]) => (
            SCENE_PLAN_NODE_CLASS_TYPES.has(promptNode?.class_type)
            && (referenceCounts.get(nodeId) || 0) === 0
        ))
        .map(([nodeId]) => nodeId);
    while (pending.length) {
        const currentId = pending.pop();
        const promptNode = output[currentId];
        if (!promptNode || (referenceCounts.get(currentId) || 0) > 0) {
            continue;
        }
        if (!SCENE_PLAN_NODE_CLASS_TYPES.has(promptNode.class_type)) {
            continue;
        }
        delete output[currentId];
        for (const inputSourceId of scenePromptInputSources(promptNode)) {
            const nextCount = Math.max(0, (referenceCounts.get(inputSourceId) || 0) - 1);
            referenceCounts.set(inputSourceId, nextCount);
            if (nextCount === 0) {
                pending.push(inputSourceId);
            }
        }
    }
    return cached;
}

function installSceneBatchPromptCapture() {
    if (api.__ScenePromptBatchCaptureInstalled || typeof api.queuePrompt !== "function") {
        return;
    }
    const originalQueuePrompt = api.queuePrompt.bind(api);
    api.queuePrompt = async function (number, prompt) {
        let preparedRunHandle = "";
        if (prompt?.output && sceneRunTargetNodes(prompt).length) {
            const existingHandle = sceneRunTargetNodes(prompt)
                .map((node) => String(node?.inputs?.run_handle || ""))
                .find(Boolean);
            if (!existingHandle) {
                const prepared = await prepareSceneRunContext(prompt);
                preparedRunHandle = String(prepared?.run_handle || "");
            }
        }
        let run = sceneBatchRun;
        let expandPrompt = prompt?.output?.[String(run?.nodeId)];
        const matchesActivePlan = !!run?.firstApiPending
            && String(expandPrompt?.inputs?.run_id || "") === run.runId;
        if (!matchesActivePlan) {
            const detachedEntry = Object.values(prompt?.output || {}).find((promptNode) => (
                promptNode?.class_type === "ScenePromptExpand"
                && sceneBatchDetachedRuns.has(String(promptNode.inputs?.run_id || ""))
            ));
            const detachedRunId = String(detachedEntry?.inputs?.run_id || "");
            run = sceneBatchDetachedRuns.get(detachedRunId) || run;
            expandPrompt = detachedEntry || expandPrompt;
        }
        const matchesFirstBatchPrompt = !!run?.firstApiPending
            && run.nextIndex === 0
            && expandPrompt?.class_type === "ScenePromptExpand"
            && String(expandPrompt.inputs?.run_id || "") === run.runId
            && Number(expandPrompt.inputs?.current_index || 0) === 0;
        if (matchesFirstBatchPrompt) {
            run.firstApiPending = false;
            run.cachedPrompt = buildSceneBatchCachedPrompt(prompt, run.nodeId);
        }
        let result;
        try {
            result = await originalQueuePrompt(...arguments);
        } catch (error) {
            releaseSceneRunHandle(preparedRunHandle);
            showPromptValidationErrorFromThrown(error);
            throw error;
        }
        const promptId = scenePromptIdFromValue(result);
        if (preparedRunHandle && promptId) {
            registerQueuedSceneRunHandle(promptId, preparedRunHandle);
        } else if (preparedRunHandle) {
            releaseSceneRunHandle(preparedRunHandle);
        }
        if (matchesFirstBatchPrompt) {
            acceptSceneBatchPrompt(run, result);
        }
        return result;
    };
    api.__ScenePromptBatchCaptureInstalled = true;
}

function acceptSceneBatchPrompt(run, result) {
    const promptId = scenePromptIdFromValue(result);
    if (!run?.waiting || !promptId) {
        return "";
    }
    run.promptAccepted = true;
    run.currentPromptId = promptId;
    run.pendingPromptIds.add(promptId);
    scheduleActiveSceneBatchReconcile(run);
    if (run.runHandle && !run.runClaimed) {
        run.runClaimed = true;
        run.runClaimPromise = claimSceneRunHandle(run.runHandle, promptId).catch((error) => {
            run.runClaimed = false;
            markSceneBatchReleaseBlocked(run, "連続生成の実行状態を開始できませんでした。もう一度実行してください。");
            console.warn("[Scene Prompt] 実行コンテキストの開始に失敗しました。", error);
        });
    }
    const terminal = sceneBatchTerminalEvents.get(promptId);
    if (terminal) {
        sceneBatchTerminalEvents.delete(promptId);
    }
    if (sceneBatchRun !== run) {
        if (terminal) {
            clearDetachedSceneBatchRun(run);
            releaseSceneBatchPlan(run.runId);
            sceneBatchRunsById.delete(run.runId);
            activateNextSceneBatchRun();
        } else {
            rememberPendingSceneBatchRelease(promptId, run.runId);
            refreshSceneBatchRunNode(run, { graphChange: false, background: false });
        }
    } else if (terminal) {
        queueMicrotask(() => {
            if (terminal.type === "success") {
                continueSceneBatchRun(terminal.detail);
            } else {
                failSceneBatchRun(terminal.detail);
            }
        });
    }
    return promptId;
}

function rememberSceneBatchTerminalEvent(type, detail) {
    const promptId = scenePromptIdFromValue(detail);
    if (!promptId) {
        return;
    }
    sceneBatchTerminalEvents.set(promptId, { type, detail });
    while (sceneBatchTerminalEvents.size > 32) {
        sceneBatchTerminalEvents.delete(sceneBatchTerminalEvents.keys().next().value);
    }
}

function releaseSceneBatchPlan(runId) {
    const key = String(runId || "");
    const run = sceneBatchRunsById.get(key) || sceneBatchDetachedRuns.get(key);
    if (!run || run.releaseRequested) {
        return;
    }
    run.releaseRequested = true;
    const release = () => releaseSceneRunHandle(run.runHandle);
    if (run.runClaimPromise) {
        run.runClaimPromise.finally(release);
    } else {
        release();
    }
}

function pruneSceneRunTerminalPromptIds(now = Date.now()) {
    for (const [promptId, completedAt] of sceneRunTerminalPromptIds.entries()) {
        if (now - completedAt >= SCENE_RUN_TERMINAL_RETENTION_MS) {
            sceneRunTerminalPromptIds.delete(promptId);
        }
    }
    while (sceneRunTerminalPromptIds.size > SCENE_RUN_TERMINAL_MAX) {
        sceneRunTerminalPromptIds.delete(sceneRunTerminalPromptIds.keys().next().value);
        sceneRunTerminalOverflowUntil = Math.max(
            sceneRunTerminalOverflowUntil,
            now + SCENE_RUN_TERMINAL_RETENTION_MS,
        );
    }
    if (sceneRunTerminalOverflowUntil <= now) {
        sceneRunTerminalOverflowUntil = 0;
    }
}

function rememberSceneRunTerminalPromptId(promptId, now = Date.now()) {
    const key = String(promptId || "");
    if (!key) {
        return;
    }
    sceneRunTerminalPromptIds.delete(key);
    sceneRunTerminalPromptIds.set(key, now);
    pruneSceneRunTerminalPromptIds(now);
}

function consumeSceneRunTerminalPromptId(promptId, now = Date.now()) {
    pruneSceneRunTerminalPromptIds(now);
    const key = String(promptId || "");
    const found = sceneRunTerminalPromptIds.has(key);
    sceneRunTerminalPromptIds.delete(key);
    return found;
}

function clearQueuedSceneRunReconcile(promptId) {
    const timer = sceneRunHandleReconcileTimers.get(promptId);
    if (timer) {
        clearTimeout(timer);
    }
    sceneRunHandleReconcileTimers.delete(promptId);
}

async function reconcileQueuedSceneRunHandle(promptId, runHandle, attempt = 0) {
    if (sceneRunHandlesByPromptId.get(promptId) !== runHandle) {
        clearQueuedSceneRunReconcile(promptId);
        return;
    }
    try {
        const response = await api.fetchApi(`/history/${encodeURIComponent(promptId)}`);
        const history = await readApiJson(response, "Scene Promptの実行状態を確認できませんでした");
        if (
            response.ok
            && sceneHistoryStatus(history, promptId)
            && sceneRunHandlesByPromptId.get(promptId) === runHandle
        ) {
            sceneRunHandlesByPromptId.delete(promptId);
            clearQueuedSceneRunReconcile(promptId);
            releaseSceneRunHandle(runHandle);
            return;
        }
    } catch (error) {
        console.warn("[Scene Prompt] 生成計画の完了確認に失敗しました。", error);
    }
    if (attempt >= 5 || sceneRunHandlesByPromptId.get(promptId) !== runHandle) {
        clearQueuedSceneRunReconcile(promptId);
        return;
    }
    const timer = setTimeout(() => {
        sceneRunHandleReconcileTimers.delete(promptId);
        reconcileQueuedSceneRunHandle(promptId, runHandle, attempt + 1);
    }, 10 * 1000);
    sceneRunHandleReconcileTimers.set(promptId, timer);
}

function releaseCompletedSceneRun(detail) {
    const promptId = scenePromptIdFromValue(detail);
    const runHandle = promptId ? sceneRunHandlesByPromptId.get(promptId) : "";
    if (!runHandle) {
        rememberSceneRunTerminalPromptId(promptId);
        return;
    }
    sceneRunHandlesByPromptId.delete(promptId);
    sceneRunTerminalPromptIds.delete(promptId);
    clearQueuedSceneRunReconcile(promptId);
    releaseSceneRunHandle(runHandle);
}

async function claimSceneRunHandle(runHandle, promptId) {
    const response = await api.fetchApi("/scene_prompt/runs/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_handle: runHandle, prompt_id: promptId }),
    });
    const data = await readApiJson(response, "Scene Promptの実行開始に失敗しました");
    if (!response.ok || !data?.claimed) {
        throw new Error(data?.error || "Scene Promptの実行開始に失敗しました");
    }
}

function registerQueuedSceneRunHandle(promptId, runHandle) {
    const key = String(promptId || "");
    if (!key || !runHandle) {
        return;
    }
    claimSceneRunHandle(runHandle, key).then(() => {
        if (consumeSceneRunTerminalPromptId(key)) {
            releaseSceneRunHandle(runHandle);
            return;
        }
        sceneRunHandlesByPromptId.set(key, runHandle);
        if (sceneRunTerminalOverflowUntil > Date.now()) {
            reconcileQueuedSceneRunHandle(key, runHandle);
        }
    }).catch((error) => {
        releaseSceneRunHandle(runHandle);
        console.warn("[Scene Prompt] 実行コンテキストの開始に失敗しました。", error);
    });
}

function releaseSceneRunHandle(runHandle, options = {}) {
    const key = String(runHandle || "");
    if (!key) {
        return Promise.resolve(false);
    }
    const existing = sceneRunReleaseStates.get(key);
    if (existing) {
        return existing;
    }
    const release = (async () => {
        let lastError = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
                const response = await api.fetchApi("/scene_prompt/runs/release", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ run_handle: key }),
                    keepalive: !!options.keepalive,
                });
                const data = await readApiJson(response, "生成計画の解放に失敗しました");
                if (!response.ok) {
                    throw new Error(data.error || "生成計画の解放に失敗しました");
                }
                return !!data.released;
            } catch (error) {
                lastError = error;
                if (attempt < 3 && !options.keepalive) {
                    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
                }
            }
        }
        console.warn("[Scene Prompt] 生成計画の解放に失敗しました。", lastError);
        return false;
    })();
    sceneRunReleaseStates.set(key, release);
    release.finally(() => {
        if (sceneRunReleaseStates.get(key) === release) {
            sceneRunReleaseStates.delete(key);
        }
    });
    return release;
}

function releaseSceneRunsOnPageHide(event) {
    if (event?.persisted) {
        return;
    }
    const handles = new Set(sceneRunReleaseStates.keys());
    for (const handle of sceneRunHandlesByPromptId.values()) {
        handles.add(handle);
    }
    for (const run of sceneBatchRunsById.values()) {
        if (run?.runHandle) handles.add(run.runHandle);
    }
    for (const run of sceneBatchDetachedRuns.values()) {
        if (run?.runHandle) handles.add(run.runHandle);
    }
    for (const handle of handles) {
        releaseSceneRunHandle(handle, { keepalive: true });
    }
}

function clearPendingSceneBatchReleasesForRun(runId) {
    if (!runId) {
        return;
    }
    for (const [promptId, entry] of sceneBatchPendingReleases.entries()) {
        if (entry?.runId !== runId) {
            continue;
        }
        sceneBatchPendingReleases.delete(promptId);
        if (entry.timer) {
            clearTimeout(entry.timer);
        }
    }
}

function markSceneBatchReleaseBlocked(run, message) {
    if (!run || run.releaseBlocked) {
        return;
    }
    run.releaseBlocked = true;
    refreshSceneBatchRunNode(run, { graphChange: false, background: false });
    showSceneBatchError(message);
}

function sceneQueueContainsPrompt(value, promptId) {
    if (value == null) {
        return false;
    }
    if (typeof value === "string" || typeof value === "number") {
        return String(value) === String(promptId);
    }
    if (Array.isArray(value)) {
        return value.some((item) => sceneQueueContainsPrompt(item, promptId));
    }
    if (typeof value === "object") {
        return Object.entries(value).some(([key, item]) => (
            String(key) === String(promptId) || sceneQueueContainsPrompt(item, promptId)
        ));
    }
    return false;
}

function releaseDetachedSceneBatchRun(run, promptId) {
    if (!run || run.detachedReleased) {
        return;
    }
    run.detachedReleased = true;
    if (promptId && sceneBatchPendingReleases.has(promptId)) {
        releasePendingSceneBatchPlan({ prompt_id: promptId });
        return;
    }
    clearDetachedSceneBatchRun(run);
    clearPendingSceneBatchReleasesForRun(run.runId);
    sceneBatchRunsById.set(run.runId, run);
    releaseSceneBatchPlan(run.runId);
    sceneBatchRunsById.delete(run.runId);
    activateNextSceneBatchRun();
}

function scheduleDetachedSceneBatchReconcile(run, delay = SCENE_DETACHED_RETRY_MS) {
    if (!run?.runId || run.detachedReleased || run.detachedTimer) {
        return;
    }
    const retryCount = Number(run.detachedRetryCount || 0);
    // Keep checking safely after the counter saturates; a queued prompt must
    // never be released only because its node disappeared or retries elapsed.
    run.detachedRetryCount = Math.min(retryCount + 1, SCENE_DETACHED_MAX_RETRIES);
    run.detachedTimer = setTimeout(() => {
        run.detachedTimer = null;
        if (sceneBatchDetachedRuns.get(run.runId) === run) {
            reconcileDetachedSceneBatchRun(run);
        }
    }, delay);
}

async function reconcileDetachedSceneBatchRun(run) {
    if (!run?.runId || run.reconciling) {
        return false;
    }
    const promptId = String(run.currentPromptId || "");
    if (!promptId) {
        return false;
    }
    run.reconciling = true;
    let released = false;
    try {
        const historyResponse = await api.fetchApi(`/history/${encodeURIComponent(promptId)}`);
        const history = await readApiJson(historyResponse, "連続生成の状態を確認できませんでした");
        if (!historyResponse.ok) {
            throw new Error(history.error || "連続生成の状態を確認できませんでした");
        }
        const hasHistory = sceneQueueContainsPrompt(history, promptId);
        if (hasHistory) {
            releaseDetachedSceneBatchRun(run, promptId);
            released = true;
            return true;
        }
        const queueResponse = await api.fetchApi("/queue");
        const queue = await readApiJson(queueResponse, "連続生成の状態を確認できませんでした");
        if (!queueResponse.ok) {
            throw new Error(queue.error || "連続生成の状態を確認できませんでした");
        }
        if (!sceneQueueContainsPrompt(queue, promptId)) {
            releaseDetachedSceneBatchRun(run, promptId);
            released = true;
            return true;
        }
        markSceneBatchReleaseBlocked(run, "前の連続生成はまだ実行待ちです。終了後にもう一度確認してください。");
        return false;
    } catch (error) {
        markSceneBatchReleaseBlocked(run, "前の連続生成の状態を確認できません。接続を確認して、もう一度押してください。");
        console.warn("[Scene Prompt] 連続生成の状態確認に失敗しました。", error);
        return false;
    } finally {
        run.reconciling = false;
        if (!released && sceneBatchDetachedRuns.get(run.runId) === run) {
            scheduleDetachedSceneBatchReconcile(run);
        }
    }
}

function rememberPendingSceneBatchRelease(promptId, runId) {
    if (!promptId || !runId) {
        return;
    }
    const previous = sceneBatchPendingReleases.get(promptId);
    if (previous?.timer) {
        clearTimeout(previous.timer);
    }
    const entry = { runId, timer: null };
    entry.timer = setTimeout(() => {
        if (sceneBatchPendingReleases.get(promptId) === entry) {
            const run = sceneBatchDetachedRuns.get(runId) || sceneBatchRunsById.get(runId);
            reconcileDetachedSceneBatchRun(run);
        }
    }, 5 * 60 * 1000);
    sceneBatchPendingReleases.set(promptId, entry);
}

function scheduleActiveSceneBatchReconcile(run) {
    if (!run?.currentPromptId || run.activeReconcileTimer) {
        return;
    }
    run.activeReconcileTimer = setTimeout(() => {
        run.activeReconcileTimer = null;
        reconcileActiveSceneBatchRun(run);
    }, 90 * 1000);
}

async function reconcileActiveSceneBatchRun(run) {
    if (sceneBatchRun !== run || !run?.waiting || run.reconciling) {
        return;
    }
    const promptId = String(run.currentPromptId || "");
    if (!promptId) {
        return;
    }
    run.reconciling = true;
    try {
        const historyResponse = await api.fetchApi(`/history/${encodeURIComponent(promptId)}`);
        const history = await readApiJson(historyResponse, "連続生成の状態を確認できませんでした");
        if (!historyResponse.ok) {
            throw new Error(history.error || "連続生成の状態を確認できませんでした");
        }
        const historyStatus = sceneHistoryStatus(history, promptId);
        if (historyStatus === "success") {
            continueSceneBatchRun({ prompt_id: promptId });
            return;
        }
        if (historyStatus === "error") {
            failSceneBatchRun({ prompt_id: promptId });
            return;
        }
        const queueResponse = await api.fetchApi("/queue");
        const queue = await readApiJson(queueResponse, "連続生成の状態を確認できませんでした");
        if (!queueResponse.ok) {
            throw new Error(queue.error || "連続生成の状態を確認できませんでした");
        }
        if (!sceneQueueContainsPrompt(queue, promptId)) {
            failSceneBatchRun({ prompt_id: promptId });
            return;
        }
    } catch (error) {
        console.warn("[Scene Prompt] 連続生成の再照合に失敗しました。", error);
    } finally {
        run.reconciling = false;
        if (sceneBatchRun === run && run.waiting) {
            scheduleActiveSceneBatchReconcile(run);
        }
    }
}

function sceneHistoryStatus(history, promptId) {
    const entry = history?.[String(promptId)];
    const status = String(entry?.status?.status_str || "").toLowerCase();
    if (status === "success" || entry?.status?.completed === true) {
        return "success";
    }
    if (status === "error" || entry?.status?.completed === false) {
        return "error";
    }
    return "";
}

function rememberDetachedSceneBatchRun(run) {
    if (!run?.runId) {
        return;
    }
    if (run.detachedTimer) {
        clearTimeout(run.detachedTimer);
    }
    sceneBatchDetachedRuns.set(run.runId, run);
    run.detachedRetryCount = 0;
    scheduleDetachedSceneBatchReconcile(run);
}

function clearDetachedSceneBatchRun(run) {
    if (!run) {
        return;
    }
    sceneBatchDetachedRuns.delete(run.runId);
    if (run.detachedTimer) {
        clearTimeout(run.detachedTimer);
        run.detachedTimer = null;
    }
    run.detachedRetryCount = 0;
    if (run.controlsResetPending) {
        const node = sceneNodeForRun(run);
        if (String(findSceneWidget(node, "run_id")?.value || "") === run.runId) {
            resetSceneExpandRunControls(node, { mark: false });
            updateSceneExpandButton(node);
        }
        run.controlsResetPending = false;
    }
}

function releasePendingSceneBatchPlan(detail) {
    const promptId = scenePromptIdFromValue(detail);
    const entry = promptId ? sceneBatchPendingReleases.get(promptId) : null;
    if (!entry) {
        return;
    }
    sceneBatchPendingReleases.delete(promptId);
    clearTimeout(entry.timer);
    sceneBatchTerminalEvents.delete(promptId);
    const run = sceneBatchDetachedRuns.get(entry.runId) || sceneBatchRunsById.get(entry.runId);
    clearDetachedSceneBatchRun(run);
    clearPendingSceneBatchReleasesForRun(entry.runId);
    releaseSceneBatchPlan(entry.runId);
    sceneBatchRunsById.delete(entry.runId);
    activateNextSceneBatchRun();
}

function scenePromptIdFromValue(value, depth = 0) {
    if (value == null || depth > 3) {
        return "";
    }
    if (typeof value === "string" || typeof value === "number") {
        return String(value);
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = scenePromptIdFromValue(item, depth + 1);
            if (found) {
                return found;
            }
        }
        return "";
    }
    if (typeof value === "object") {
        for (const key of ["prompt_id", "promptId"]) {
            if (value[key] != null) {
                return String(value[key]);
            }
        }
        for (const key of ["data", "prompt", "response"]) {
            const found = scenePromptIdFromValue(value[key], depth + 1);
            if (found) {
                return found;
            }
        }
    }
    return "";
}

function sceneBatchEventMatchesRun(run, detail) {
    if (!run.promptAccepted) {
        return false;
    }
    const promptId = scenePromptIdFromValue(detail);
    if (!promptId) {
        return false;
    }
    if (run.currentPromptId && promptId !== run.currentPromptId) {
        return false;
    }
    if (run.pendingPromptIds?.size && !run.pendingPromptIds.has(promptId)) {
        return false;
    }
    return true;
}

function stopSceneBatchRun(options = {}) {
    const run = sceneBatchRun;
    if (run?.nextTimer) {
        clearTimeout(run.nextTimer);
        run.nextTimer = null;
    }
    if (run?.activeReconcileTimer) {
        clearTimeout(run.activeReconcileTimer);
        run.activeReconcileTimer = null;
    }
    const previousNode = sceneNodeForRun(run);
    if (run?.preparing) {
        cancelSceneBatchRunPreparation(run);
    }
    sceneBatchRun = null;
    const deferRelease = options.forceRelease !== true && !!run?.waiting;
    if (deferRelease) {
        run.controlsResetPending = true;
        rememberDetachedSceneBatchRun(run);
    }
    if (deferRelease && run.currentPromptId) {
        rememberPendingSceneBatchRelease(run.currentPromptId, run.runId);
    } else if (!deferRelease) {
        clearPendingSceneBatchReleasesForRun(run?.runId);
        if (!run?.snapshotReleased) {
            releaseSceneBatchPlan(run?.runId);
        }
        sceneBatchRunsById.delete(run?.runId);
    }
    if (previousNode) {
        if (!deferRelease) {
            resetSceneExpandRunControls(previousNode, { mark: false });
        }
        updateSceneExpandButton(previousNode);
    }
    if (!deferRelease) {
        activateNextSceneBatchRun();
    }
}

function cancelSceneBatchRunForNode(node) {
    const run = sceneBatchRunForNode(node);
    if (!run) {
        return;
    }
    run.nodeRemoved = true;
    if (sceneBatchRun === run) {
        stopSceneBatchRun();
        return;
    }
    if (sceneBatchPendingRuns.includes(run)) {
        cancelPendingSceneBatchRun(run);
        return;
    }
    if (sceneBatchDetachedRuns.get(run.runId) === run) {
        if (run.detachedTimer) {
            clearTimeout(run.detachedTimer);
            run.detachedTimer = null;
        }
        if (run.currentPromptId) {
            reconcileDetachedSceneBatchRun(run);
        } else {
            releaseDetachedSceneBatchRun(run, "");
        }
    }
}

function syncAllScenePromptNames() {
    for (const node of [...sceneTitleSyncNodes]) {
        if (!node || node.graph !== app.graph) {
            sceneTitleSyncNodes.delete(node);
            continue;
        }
        if (isScenePromptNode(node)) {
            syncScenePromptNameFromTitle(node);
        }
        if (isScenePathNode(node)) {
            syncScenePathNameFromTitle(node);
        }
    }
}

function installScenePromptQueueSync() {
    if (app.__ScenePromptQueueSyncInstalled || typeof app.queuePrompt !== "function") {
        return;
    }
    const originalQueuePrompt = app.queuePrompt.bind(app);
    app.queuePrompt = function () {
        if (!sceneBatchRun && sceneQueuePromptSyncPaused <= 0) {
            syncSceneNodeModes();
            syncAllScenePromptNames();
        }
        return originalQueuePrompt(...arguments);
    };
    app.__ScenePromptQueueSyncInstalled = true;
}

function scheduleScenePromptQueueSyncInstall() {
    installScenePromptQueueSync();
    installSceneBatchPromptCapture();
}

function resetSceneExpandRunControls(node, options = {}) {
    let changed = false;
    changed = setWidgetValue(node, "current_index", 0, { silent: true }) || changed;
    changed = setWidgetValue(node, "run_id", "", { silent: true }) || changed;
    changed = setWidgetValue(node, "seed_base", 0, { silent: true }) || changed;
    if (changed && options.mark !== false) {
        markSceneNodeChanged(node, options);
    }
    return changed;
}

function refreshSceneBatchRunNode(run, options = {}) {
    const node = sceneNodeForRun(run);
    if (node) {
        updateSceneExpandButton(node, options);
    }
}

function cancelPendingSceneBatchRun(run) {
    cancelSceneBatchRunPreparation(run);
    const index = sceneBatchPendingRuns.indexOf(run);
    if (index >= 0) {
        sceneBatchPendingRuns.splice(index, 1);
    }
    sceneBatchRunsById.delete(run.runId);
    const node = sceneNodeForRun(run);
    if (node) {
        resetSceneExpandRunControls(node, { mark: false });
        updateSceneExpandButton(node);
    }
    for (const pending of sceneBatchPendingRuns) {
        refreshSceneBatchRunNode(pending, { graphChange: false, background: false });
    }
}

function activateNextSceneBatchRun() {
    if (sceneBatchRun || sceneBatchDetachedRuns.size) {
        return;
    }
    let nextRun = sceneBatchPendingRuns.shift();
    while (nextRun && (!sceneBatchRunsById.has(nextRun.runId) || nextRun.cancelled)) {
        nextRun = sceneBatchPendingRuns.shift();
    }
    if (!nextRun) {
        return;
    }
    sceneBatchRun = nextRun;
    clearSceneSavePreviews();
    refreshSceneBatchRunNode(nextRun, { graphChange: false, background: false });
    for (const pending of sceneBatchPendingRuns) {
        refreshSceneBatchRunNode(pending, { graphChange: false, background: false });
    }
    prepareSceneBatchRunSnapshot(nextRun, sceneNodeForRun(nextRun));
    queueNextSceneBatchItem();
}

function createSceneBatchRun(node, total) {
    const planId = sceneBatchPlanId();
    if (!planId) {
        throw new Error("安全な実行IDを作成できませんでした。");
    }
    const run = {
        nodeId: node.id,
        node,
        graph: node.graph || app.graph,
        total,
        totalImages: null,
        nextIndex: 0,
        runId: `${sceneBatchRunId()}__${planId}`,
        runHandle: "",
        waiting: false,
        queueing: false,
        currentPromptId: "",
        pendingPromptIds: new Set(),
        currentSeed: sceneBatchSeedBase(),
        firstPromptSnapshot: null,
        promptCapturePromise: null,
        promptCaptureError: null,
        snapshotPromise: null,
        snapshotReady: false,
        snapshotError: null,
        cachedPrompt: null,
        cancelled: false,
        resolveController: null,
        snapshotReleased: false,
    };
    setWidgetValue(node, "current_index", 0, { silent: true });
    setWidgetValue(node, "run_id", run.runId, { silent: true });
    setWidgetValue(node, "seed_base", run.currentSeed, { silent: true });
    run.promptCapturePromise = createSceneBatchPromptSnapshot(node.id).catch((error) => {
        run.promptCaptureError = error;
        return null;
    });
    sceneBatchRunsById.set(run.runId, run);
    updateSceneExpandButton(node);
    return run;
}

function prepareSceneBatchRunSnapshot(run, node) {
    if (!run || run.snapshotPromise) {
        return run?.snapshotPromise || Promise.resolve(null);
    }
    run.snapshotPromise = (async () => {
        try {
            run.firstPromptSnapshot = await run.promptCapturePromise;
            if (run.promptCaptureError) {
                throw run.promptCaptureError;
            }
            if (!run.firstPromptSnapshot) {
                throw new Error("Scene Prompt Expand のプロンプトを取得できませんでした。");
            }
            if (run.cancelled) {
                return null;
            }
            run.resolveController = new AbortController();
            const resolved = await resolveScenePresetsForRun(run, run.firstPromptSnapshot, node.id);
            if (run.cancelled || !resolved) {
                releaseCancelledSceneBatchRun(run);
                return null;
            }
            const totalBatches = Number(resolved.total_batches);
            const totalImages = Number(resolved.total_images);
            if (!Number.isSafeInteger(totalBatches) || totalBatches < 0 || !Number.isSafeInteger(totalImages) || totalImages < 0) {
                throw new Error("生成計画の回数または画像枚数が不正です。");
            }
            run.total = totalBatches;
            run.totalImages = totalImages;
            if (run.total <= 0) {
                throw new Error("生成対象がありません。Scene PresetとSceneノードの接続を確認してください。");
            }
            run.snapshotReady = true;
            run.snapshotError = null;
            updateSceneExpandCountWidget(node);
        } catch (error) {
            if (run.cancelled || error?.name === "AbortError") {
                releaseCancelledSceneBatchRun(run);
                return null;
            }
            run.snapshotError = error;
            markScenePresetReferenceErrors(error?.message || "Presetの検証に失敗しました。", {
                nodeId: error?.scenePresetReferenceId,
                relatedNodeIds: scenePresetReferenceIdsForExpand(run.firstPromptSnapshot, node.id),
            });
            const status = sceneBatchRunStatus(run);
            if (status === "pending") {
                cancelPendingSceneBatchRun(run);
                showSceneBatchError("待機中の連続生成を準備できませんでした。", error);
            }
        } finally {
            run.resolveController = null;
            refreshSceneBatchRunNode(run, { graphChange: false, background: false });
        }
        return run.firstPromptSnapshot;
    })();
    return run.snapshotPromise;
}

async function queueNextSceneBatchItem() {
    const run = sceneBatchRun;
    if (!run || run.queueing || run.waiting) {
        return;
    }
    if (run.releaseBlocked) {
        stopSceneBatchRun({ forceRelease: true });
        return;
    }

    run.queueing = true;
    try {
        if (run.snapshotPromise && !run.snapshotReady && !run.cachedPrompt) {
            await run.snapshotPromise;
        }
        if (sceneBatchRun !== run || run.cancelled) {
            return;
        }
        if (run.snapshotError) {
            throw run.snapshotError;
        }
        run.preparing = false;
        if (run.nextIndex >= run.total) {
            stopSceneBatchRun();
            return;
        }
        const isFirstSnapshotQueue = run.nextIndex === 0 && !!run.firstPromptSnapshot && !run.cachedPrompt;
        if (!isFirstSnapshotQueue) {
            run.currentSeed = sceneBatchSeedBase();
        }
        const node = sceneNodeForRun(run);
        if (node) {
            const changedIndex = setWidgetValue(node, "current_index", run.nextIndex, { silent: true });
            const changedRun = setWidgetValue(node, "run_id", run.runId, { silent: true });
            const changedSeed = setWidgetValue(node, "seed_base", run.currentSeed, { silent: true });
            const lightweightDirty = { graphChange: false, background: false };
            updateSceneExpandButton(node, lightweightDirty);
            if (changedIndex || changedRun || changedSeed) {
                markSceneNodeChanged(node, lightweightDirty);
            }
        }

        run.waiting = true;
        run.promptAccepted = false;
        run.firstApiPending = run.nextIndex === 0 && !run.cachedPrompt;
        const queueResult = await queueSingleScenePrompt();
        acceptSceneBatchPrompt(run, queueResult);
    } catch (error) {
        if (sceneBatchRun === run) {
            stopSceneBatchRun({ forceRelease: true });
            showSceneBatchError("連続生成を開始できませんでした。", error);
        } else {
            clearDetachedSceneBatchRun(run);
            releaseSceneBatchPlan(run.runId);
            sceneBatchRunsById.delete(run.runId);
            activateNextSceneBatchRun();
        }
    } finally {
        run.queueing = false;
        if (run.completedWhileQueueing && sceneBatchRun === run) {
            run.completedWhileQueueing = false;
            scheduleNextSceneBatchItem(run);
        }
    }
}

function startSceneBatchRun(node) {
    const existingRun = sceneBatchRunForNode(node);
    const existingStatus = sceneBatchRunStatus(existingRun);
    if (existingStatus === "active") {
        stopSceneBatchRun();
        return;
    }
    if (existingStatus === "pending") {
        cancelPendingSceneBatchRun(existingRun);
        return;
    }
    if (existingStatus === "blocked") {
        reconcileDetachedSceneBatchRun(existingRun);
        return;
    }
    if (existingStatus === "stopping") {
        showSceneBatchError("この連続生成は停止処理中です。完了後に再実行してください。");
        return;
    }

    syncSceneNodeModes();
    syncAllScenePromptNames();
    let run;
    try {
        run = createSceneBatchRun(node, sceneExpandCounts(node).totalBatches);
        run.preparing = true;
    } catch (error) {
        resetSceneExpandRunControls(node, { mark: false });
        updateSceneExpandButton(node);
        showSceneBatchError("連続生成を開始できませんでした。", error);
        return;
    }

    if (sceneBatchRun || sceneBatchDetachedRuns.size) {
        sceneBatchPendingRuns.push(run);
        updateSceneExpandButton(node);
        for (const pending of sceneBatchPendingRuns) {
            refreshSceneBatchRunNode(pending, { graphChange: false, background: false });
        }
        return;
    }

    sceneBatchRun = run;
    clearSceneSavePreviews();
    updateSceneExpandButton(node);
    prepareSceneBatchRunSnapshot(run, node);
    queueNextSceneBatchItem();
}

function continueSceneBatchRun(detail = null) {
    const run = sceneBatchRun;
    if (!run || !run.waiting) {
        return;
    }
    if (!sceneBatchEventMatchesRun(run, detail)) {
        return;
    }
    if (run.releaseBlocked) {
        failSceneBatchRun(detail);
        return;
    }
    const promptId = scenePromptIdFromValue(detail);
    if (run.activeReconcileTimer) {
        clearTimeout(run.activeReconcileTimer);
        run.activeReconcileTimer = null;
    }
    if (promptId) {
        run.pendingPromptIds.delete(promptId);
        sceneBatchTerminalEvents.delete(promptId);
    }
    run.currentPromptId = "";
    run.promptAccepted = false;
    const node = sceneNodeForRun(run);
    run.waiting = false;
    run.nextIndex += 1;
    if (node) {
        updateSceneExpandButton(node, { graphChange: false, background: false });
    }
    scheduleNextSceneBatchItem(run);
}

function scheduleNextSceneBatchItem(run) {
    if (run.nextIndex >= run.total) {
        stopSceneBatchRun({ forceRelease: true });
        return;
    }
    if (run.queueing) {
        run.completedWhileQueueing = true;
        return;
    }
    if (run.nextTimer) {
        clearTimeout(run.nextTimer);
    }
    run.nextTimer = setTimeout(() => {
        run.nextTimer = null;
        queueNextSceneBatchItem();
    }, 120);
}

function failSceneBatchRun(detail = null) {
    if (sceneBatchRun && !sceneBatchEventMatchesRun(sceneBatchRun, detail)) {
        return;
    }
    if (sceneBatchRun) {
        const promptId = scenePromptIdFromValue(detail);
        if (promptId) {
            sceneBatchTerminalEvents.delete(promptId);
        }
        stopSceneBatchRun({ forceRelease: true });
    }
}

function refreshScenePromptNode(node, options = {}) {
    const drawDetails = sceneShouldDrawDetails();
    const measureDetails = drawDetails || !!options.fitHeight || !!options.expand;
    const positiveButton = findSceneWidget(node, "positive_open");
    if (positiveButton) {
        positiveButton.name = "ポジティブ候補";
    }
    const negativeButton = findSceneWidget(node, "negative_open");
    if (negativeButton) {
        negativeButton.name = "ネガティブ候補";
    }
    for (const widget of node.widgets || []) {
        if (!widget?.sceneRole || !widget.stateWidgetName || !widget.sceneRole.endsWith("_selected_list")) {
            continue;
        }
        if (measureDetails) {
            const state = readStateFromWidget(node, widget.stateWidgetName);
            widget.value = summarizeSelection(state);
            widget.computedHeight = selectedListHeight(node, node.size?.[0] || 420, {
                stateWidgetName: widget.stateWidgetName,
            });
        } else {
            widget.value = "";
            widget.computedHeight = SCENE_COMPACT_WIDGET_HEIGHT;
        }
    }
    if (measureDetails && (options.expand || options.fitHeight) && node.size) {
        const desiredWidth = node.size[0] || 430;
        const desiredHeight = visibleWidgetTotalHeight(node, {
            reserveSelectedListLine: !!options.reserveSelectedListLine,
        }) + 4;
        if (options.fitHeight || (node.size[1] || 0) < desiredHeight) {
            setNodeSize(node, desiredWidth, sceneAutoFitHeight(desiredHeight), { minWidth: 1 });
        }
    }
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
}

function refreshPromptMatrixNode(node, options = {}) {
    const drawDetails = sceneShouldDrawDetails();
    const measureDetails = drawDetails || !!options.fitHeight || !!options.expand;
    const cache = measureDetails ? matrixDisplayCache(node) : null;
    const positiveButton = findSceneWidget(node, "positive_open");
    if (positiveButton) {
        positiveButton.name = "ポジティブ候補";
    }
    const negativeButton = findSceneWidget(node, "negative_open");
    if (negativeButton) {
        negativeButton.name = "ネガティブ候補";
    }
    for (const widget of node.widgets || []) {
        if (!widget?.sceneRole || !widget.stateWidgetName) {
            continue;
        }
        if (widget.sceneRole.endsWith("_selected_list")) {
            if (measureDetails) {
                const state = readStateFromWidget(node, widget.stateWidgetName);
                widget.value = summarizeSelection(state);
                widget.computedHeight = selectedListHeight(node, node.size?.[0] || MATRIX_NODE_DEFAULT_WIDTH, {
                    stateWidgetName: widget.stateWidgetName,
                });
            } else {
                widget.value = "";
                widget.computedHeight = SCENE_COMPACT_WIDGET_HEIGHT;
            }
        }
    }
    const list = findSceneWidget(node, "matrix_connected_list");
    if (list) {
        list.value = "";
        list.computedHeight = resizableSceneWidgetHeight(
            node,
            "matrix_connected_list",
            measureDetails ? cache.naturalHeight : 0,
            0,
        );
    }
    if (measureDetails && (options.expand || options.fitHeight) && node.size) {
        const desiredWidth = node.size[0] || MATRIX_NODE_DEFAULT_WIDTH;
        node.sceneForceNaturalWidgetHeight = true;
        try {
            const desiredHeight = visibleWidgetTotalHeight(node, {}) + 4;
            if (options.fitHeight || (node.size[1] || 0) < desiredHeight) {
                setNodeSize(node, desiredWidth, sceneAutoFitHeight(desiredHeight), { minWidth: MATRIX_NODE_MIN_WIDTH });
            }
        } finally {
            node.sceneForceNaturalWidgetHeight = false;
        }
    }
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
}

function sceneQueueDisplayNaturalHeight(entries, width, ctx = null) {
    return Math.max(56, 28 + Math.max(sceneQueueEntriesHeight(entries, width, ctx), 20));
}

function drawSceneQueueListContent(ctx, cache, width, y, maxHeight = Infinity) {
    ctx.font = "12px sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#dfe8f5";
    ctx.fillText(
        `${cache.title || "生成キュー"}: ${cache.enabledCount}/${cache.rowCount}行 / ${formatSceneExpandCounts(cache.totalBatches, cache.totalImages)}`,
        10,
        y + 12,
    );
    if (!cache.hasMatrix) {
        ctx.fillStyle = "#aab3c4";
        ctx.fillText(cache.emptyText || "matrixを接続してください", 10, y + 32);
        return;
    }
    if (!cache.rowCount || !cache.enabledCount) {
        ctx.fillStyle = "#aab3c4";
        ctx.fillText(cache.noRowsText || (cache.rowCount ? "生成対象がありません" : "生成行がありません"), 10, y + 32);
        return;
    }

    const maxTextWidth = Math.max(80, width - 36);
    let cursorY = 30;
    for (const entry of cache.entries) {
        if (cursorY > maxHeight + 24) {
            break;
        }
        const top = y + cursorY;
        if (entry.type === "group") {
            ctx.font = "bold 11px sans-serif";
            ctx.fillStyle = SCENE_QUEUE_GROUP_COLORS[Math.min(entry.level || 0, SCENE_QUEUE_GROUP_COLORS.length - 1)];
            const left = 18 + Math.max(0, entry.level || 0) * 12;
            ctx.fillText(fitCanvasText(ctx, entry.label, Math.max(80, width - left - 10)), left, top);
            cursorY += 20;
            continue;
        }

        if (entry.type === "chips") {
            ctx.font = "11px sans-serif";
            const left = 24 + Math.max(0, entry.level || 0) * 12;
            let chipX = left;
            let chipY = y + cursorY - 9;
            const chipMaxWidth = Math.max(80, width - left - 10);
            for (const item of entry.items || []) {
                const chipLabel = `${item.label} x${item.count}`;
                const chipWidth = sceneQueueChipWidth(chipLabel, chipMaxWidth, ctx);
                if (chipX > left && chipX - left + chipWidth > chipMaxWidth) {
                    chipX = left;
                    chipY += CHIP_HEIGHT + CHIP_LINE_GAP;
                    cursorY += CHIP_HEIGHT + CHIP_LINE_GAP;
                }
                ctx.fillStyle = "#30343b";
                ctx.strokeStyle = "#59616e";
                ctx.beginPath();
                roundedRect(ctx, chipX, chipY, chipWidth, CHIP_HEIGHT, 5);
                ctx.fill();
                ctx.stroke();
                ctx.fillStyle = "#e3e8ef";
                ctx.fillText(
                    fitCanvasText(ctx, chipLabel, Math.max(20, chipWidth - CHIP_TEXT_PAD_X * 2)),
                    chipX + CHIP_TEXT_PAD_X,
                    chipY + 10,
                );
                chipX += chipWidth + CHIP_GAP;
            }
            cursorY += CHIP_HEIGHT + CHIP_LINE_GAP;
            continue;
        }
    }
}

function refreshScenePromptQueueNode(node, options = {}) {
    const drawDetails = sceneShouldDrawDetails();
    const measureDetails = drawDetails || !!options.fitHeight || !!options.expand;
    const stats = measureDetails ? scenePromptStats(node) : null;
    const list = findSceneWidget(node, "scene_prompt_queue_list");
    if (list) {
        const rows = measureDetails ? scenePromptQueueRowEntries(node) : [];
        const totalImages = rows.length
            ? rows.reduce((total, entry) => total + scenePromptEntryImageCount(entry), 0)
            : stats?.total;
        list.value = measureDetails ? `${stats.rows}行 / ${formatSceneExpandCounts(stats.total, totalImages)}` : "";
        list.computedHeight = SCENE_COMPACT_WIDGET_HEIGHT;
    }
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
}

function refreshScenePromptCounterNode(node) {
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
}

function refreshSceneExpandNode(node, options = {}) {
    updateSceneExpandButton(node);
    updateSceneExpandCountWidget(node);
    if (options.fitHeight && node.size) {
        const desiredWidth = node.size[0] || 220;
        const desiredHeight = visibleWidgetTotalHeight(node, {}) + 4;
        setNodeSize(node, desiredWidth, sceneAutoFitHeight(desiredHeight), { minWidth: 1 });
    }
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
}

function refreshNode(node, options = {}) {
    if (isScenePromptNode(node)) {
        refreshScenePromptNode(node, options);
        return;
    }
    if (isScenePromptCounterNode(node)) {
        refreshScenePromptCounterNode(node);
        return;
    }
    if (isPromptMatrixNode(node)) {
        refreshPromptMatrixNode(node, options);
        return;
    }
    if (isScenePromptQueueNode(node)) {
        refreshScenePromptQueueNode(node, options);
        return;
    }
    if (isSceneExpandNode(node)) {
        refreshSceneExpandNode(node, options);
        return;
    }

    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
}

function openPromptSelectionPicker(node, stateWidgetName) {
    setActiveStateWidget(node, stateWidgetName);
    openCategoryLevelPicker(node, [], { stateWidgetName });
}

function ensurePromptSelectionControls(node) {
    addSceneButton(node, "positive_open", "ポジティブ候補", () => openPromptSelectionPicker(node, "positive_json"));
    addSelectedListWidget(node, {
        role: "positive_selected_list",
        name: "ポジティブ選択済み",
        stateWidgetName: "positive_json",
    });
    addSceneButton(node, "negative_open", "ネガティブ候補", () => openPromptSelectionPicker(node, "negative_json"));
    addSelectedListWidget(node, {
        role: "negative_selected_list",
        name: "ネガティブ選択済み",
        stateWidgetName: "negative_json",
    });
}

function matrixLineDraftLabel(draft) {
    return String(draft?.name || "").trim();
}

function matrixLineDraftSummary(draft, side) {
    const state = matrixLineDraftSelectionState(draft, side);
    return selectedItems(state)
        .map((item) => itemBaseLabel(item))
        .filter(Boolean)
        .join(" / ");
}

function createMatrixLineDraft(value, index) {
    const draft = value == null ? createMatrixLine(`行 ${index + 1}`) : normalizeMatrixLine(value);
    draft.name = matrixLineDraftLabel(draft);
    draft.path_label = draft.name;
    draft.positive_json = serializedSelectionStateObject(selectionStateObjectFromValue(draft.positive_json));
    draft.negative_json = serializedSelectionStateObject(selectionStateObjectFromValue(draft.negative_json));
    refreshMatrixLineDraftComputedFields(draft);
    return draft;
}

function matrixLineDraftsForNode(node) {
    return (readMatrixState(node).sets || []).map((line, index) => createMatrixLineDraft(line, index));
}

function saveMatrixLineDrafts(node, drafts) {
    const sets = drafts.map((draft, index) => {
        const namedDraft = {
            ...draft,
            name: matrixLineDraftLabel(draft),
        };
        namedDraft.path_label = namedDraft.name;
        refreshMatrixLineDraftComputedFields(namedDraft);
        return normalizeMatrixLine(namedDraft);
    });
    writeMatrixState(node, { version: 1, sets }, { fitHeight: true });
}

function saveMatrixLineEnabled(node, draft) {
    const state = readMatrixState(node);
    const rowId = String(draft?.row_id || "");
    const index = (state.sets || []).findIndex((line) => String(line?.row_id || "") === rowId);
    if (index < 0) {
        return;
    }
    const sets = state.sets.map((line, lineIndex) => (
        lineIndex === index ? { ...line, enabled: draft.enabled !== false } : line
    ));
    writeMatrixState(node, { version: 1, sets }, { fitHeight: true });
}

function openMatrixLineSelectionPopup(node, drafts, index, side, renderRows) {
    const draft = drafts[index];
    if (!draft) {
        return;
    }
    const stateWidgetName = setMatrixLineDraftContext(node, index, draft, side);
    draft.sceneScheduleRenderSummaries = renderRows;
    openCategoryLevelPicker(node, [], { stateWidgetName });
}

function createMatrixLineBaseInput(draft, side) {
    const key = side === "negative" ? "negative_base" : "positive_base";
    const input = document.createElement("textarea");
    input.className = "pc-searchbox";
    input.placeholder = side === "negative" ? "ネガティブ基本文" : "ポジティブ基本文";
    input.value = String(draft?.[key] || "");
    input.rows = 2;
    input.style.resize = "vertical";
    input.style.minHeight = "42px";
    input.style.boxSizing = "border-box";
    input.addEventListener("input", () => {
        draft[key] = input.value;
        refreshMatrixLineDraftComputedFields(draft);
    });
    return input;
}

function openSceneMatrixLinesPopup(node) {
    const drafts = matrixLineDraftsForNode(node);
    const popup = openPopupShell(node, "Matrix 行を編集", { hideReload: true, hideClear: true });
    if (activePopupContext?.popup === popup) {
        activePopupContext.reopen = () => openSceneMatrixLinesPopup(node);
    }

    const toolbar = document.createElement("div");
    toolbar.className = "pc-toolbar";
    popup.appendChild(toolbar);

    const list = document.createElement("div");
    list.className = "pc-popup-list";
    popup.appendChild(list);

    const add = createButton("行を追加");
    add.addEventListener("click", () => {
        drafts.push(createMatrixLineDraft(null, drafts.length));
        renderRows();
    });
    toolbar.appendChild(add);

    const save = createButton("保存", "pc-on");
    save.addEventListener("click", () => {
        saveMatrixLineDrafts(node, drafts);
        closeAllPopups();
    });
    toolbar.appendChild(save);

    const renderRows = () => {
        list.textContent = "";
        drafts.forEach((draft, index) => {
            const row = document.createElement("div");
            row.className = "pc-candidate";
            row.style.flexDirection = "column";
            row.style.alignItems = "stretch";
            row.style.gap = "7px";
            row.style.opacity = draft.enabled === false ? "0.48" : "1";

            const name = document.createElement("input");
            name.className = "pc-searchbox";
            name.placeholder = "名前";
            name.value = matrixLineDraftLabel(draft);
            name.addEventListener("input", () => {
                draft.name = name.value.trim();
                draft.path_label = draft.name;
                refreshMatrixLineDraftComputedFields(draft);
            });
            row.appendChild(name);

            const actions = document.createElement("div");
            actions.className = "pc-toolbar";
            const toggle = createButton(draft.enabled === false ? "無効" : "有効", draft.enabled === false ? "" : "pc-on");
            toggle.title = draft.enabled === false ? "この行は生成されません" : "この行は生成対象です";
            toggle.addEventListener("click", () => {
                draft.enabled = draft.enabled === false;
                saveMatrixLineEnabled(node, draft);
                renderRows();
            });
            actions.appendChild(toggle);

            const moveUp = createButton("↑");
            moveUp.title = "上へ移動";
            moveUp.disabled = index === 0;
            moveUp.addEventListener("click", () => {
                if (index <= 0) {
                    return;
                }
                const [moved] = drafts.splice(index, 1);
                drafts.splice(index - 1, 0, moved);
                renderRows();
            });
            actions.appendChild(moveUp);

            const positive = createButton("ポジティブ候補");
            positive.addEventListener("click", () => openMatrixLineSelectionPopup(node, drafts, index, "positive", renderRows));
            actions.appendChild(positive);

            const negative = createButton("ネガティブ候補");
            negative.addEventListener("click", () => openMatrixLineSelectionPopup(node, drafts, index, "negative", renderRows));
            actions.appendChild(negative);

            const remove = createButton("削除");
            remove.addEventListener("click", () => {
                drafts.splice(index, 1);
                renderRows();
            });
            actions.appendChild(remove);
            row.appendChild(actions);

            const positiveSummary = matrixLineDraftSummary(draft, "positive");
            if (positiveSummary) {
                const summary = document.createElement("div");
                summary.className = "pc-candidate-desc";
                summary.style.color = "#8ee59f";
                summary.textContent = positiveSummary;
                row.appendChild(summary);
            }

            const negativeSummary = matrixLineDraftSummary(draft, "negative");
            if (negativeSummary) {
                const summary = document.createElement("div");
                summary.className = "pc-candidate-desc";
                summary.style.color = "#ff9b9b";
                summary.textContent = negativeSummary;
                row.appendChild(summary);
            }

            list.appendChild(row);
        });
    };

    renderRows();
}

function ensurePromptMatrixControls(node) {
    addSceneButton(node, "matrix_rows", "行を編集", () => openSceneMatrixLinesPopup(node));
    addMatrixListWidget(node);
}

function ensureSceneExpandControls(node) {
    addSceneButton(node, "expand_run_all", "連続生成", () => startSceneBatchRun(node));
    addSceneExpandCountWidget(node);
    updateSceneExpandButton(node);
    updateSceneExpandCountWidget(node);
}

async function loadScenePresetList(force = false) {
    if (!force && scenePresetListCacheCurrent && Array.isArray(scenePresetList)) {
        return scenePresetList;
    }
    if (!force && scenePresetListPromise) {
        return scenePresetListPromise;
    }
    const generation = ++scenePresetListRequestGeneration;
    scenePresetListCacheCurrent = false;
    const request = (async () => {
        try {
            const response = await api.fetchApi("/scene_presets/list");
            if (generation !== scenePresetListRequestGeneration) {
                return scenePresetListLatestPromise;
            }
            const data = await readApiJson(response, "Preset一覧を取得できませんでした");
            if (generation !== scenePresetListRequestGeneration) {
                return scenePresetListLatestPromise;
            }
            if (!response.ok) {
                throw new Error(data.error || "Preset一覧を取得できませんでした");
            }
            const entries = Array.isArray(data.presets) ? data.presets : [];
            scenePresetDisplayGraphs = new Map(entries.map((entry) => [
                String(entry?.metadata?.preset_id || ""),
                entry,
            ]).filter(([presetId]) => presetId));
            scenePresetList = entries.map((entry) => entry.metadata).filter(Boolean);
            scenePresetListErrors = Array.isArray(data.errors) ? data.errors : [];
            scenePresetListCacheCurrent = true;
            return scenePresetList;
        } catch (error) {
            if (generation !== scenePresetListRequestGeneration) {
                return scenePresetListLatestPromise;
            }
            throw error;
        }
    })();
    scenePresetListPromise = request;
    scenePresetListLatestPromise = request;
    try {
        return await request;
    } finally {
        if (scenePresetListPromise === request) {
            scenePresetListPromise = null;
        }
    }
}

function selectedScenePreset(node, presets = scenePresetList || []) {
    const presetId = String(findWidget(node, "preset_id")?.value || "").trim();
    return presets.find((preset) => String(preset?.preset_id || "") === presetId) || null;
}

function refreshScenePresetReference(node, presets = scenePresetList || []) {
    const button = findSceneWidget(node, "scene_preset_select");
    if (!button) {
        return;
    }
    const preset = selectedScenePreset(node, presets);
    node.scenePresetGraph = preset ? scenePresetDisplayGraphs.get(String(preset.preset_id)) || null : null;
    button.name = preset ? `Preset: ${preset.name || preset.preset_id}` : "Presetを選択";
    node.setDirtyCanvas?.(true, true);
}

function refreshAllScenePresetReferences(presets = scenePresetList || []) {
    for (const node of app.graph?._nodes || []) {
        if (isScenePresetReferenceNode(node)) {
            refreshScenePresetReference(node, presets);
        }
    }
    for (const expand of app.graph?._nodes || []) {
        if (isSceneExpandNode(expand)) {
            updateSceneExpandCountWidget(expand);
        }
    }
}

async function refreshScenePresetReferenceList(node, force = false) {
    const presets = await loadScenePresetList(force);
    refreshScenePresetReference(node, presets);
    return presets;
}

async function openScenePresetPicker(node) {
    let presets;
    try {
        presets = await refreshScenePresetReferenceList(node, true);
    } catch (error) {
        showSceneBatchError("Preset一覧を取得できませんでした。", error);
        return;
    }
    const popup = openPopupShell(node, "Scene Presetを選択", { hideReload: true, hideClear: true });
    const list = document.createElement("div");
    list.className = "pc-popup-list pc-popup-category-list";
    if (!presets.length) {
        const empty = document.createElement("div");
        empty.className = "pc-empty";
        empty.textContent = "保存済みPresetはありません。";
        list.appendChild(empty);
    }
    if (scenePresetListErrors.length) {
        const warning = document.createElement("div");
        warning.className = "pc-candidate-desc";
        warning.textContent = `読み込めないPreset ${scenePresetListErrors.length}件: ${scenePresetListErrors.map((item) => item.preset_id).join(", ")}`;
        list.appendChild(warning);
    }
    for (const preset of presets) {
        const button = createButton(preset.name || preset.preset_id);
        button.title = `Preset ID: ${preset.preset_id}`;
        if (selectedScenePreset(node, presets)?.preset_id === preset.preset_id) {
            button.classList.add("pc-on");
        }
        button.addEventListener("click", () => {
            setWidgetValue(node, "preset_id", preset.preset_id);
            refreshScenePresetReference(node, presets);
            refreshAllScenePresetReferences(presets);
            closePopup();
            node.setDirtyCanvas?.(true, true);
            app.graph?.setDirtyCanvas?.(true, true);
        });
        list.appendChild(button);
    }
    popup.appendChild(list);
}

async function saveScenePreset(node) {
    const presetId = String(findWidget(node, "preset_id")?.value || "").trim();
    const name = String(findWidget(node, "preset_name")?.value || presetId).trim() || presetId;
    if (!presetId) {
        showSceneBatchError("Preset IDを入力してください。");
        return;
    }
    try {
        const graphToPrompt = app.graphToPrompt?.bind(app);
        if (!graphToPrompt || !app.graph?.serialize) {
            throw new Error("Preset保存に必要なComfyUI APIが見つかりません。");
        }
        const apiGraph = await graphToPrompt();
        const workflow = app.graph.serialize();
        const response = await api.fetchApi("/scene_presets/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ preset_id: presetId, name, api_graph: apiGraph, workflow }),
        });
        const data = await readApiJson(response, "Presetの保存に失敗しました");
        if (!response.ok) {
            throw new Error(data.error || "Presetの保存に失敗しました");
        }
        const metadata = data.metadata || {};
        scenePresetList = null;
        try {
            refreshAllScenePresetReferences(await loadScenePresetList(true));
        } catch (listError) {
            console.warn("[Scene Prompt]", listError);
        }
        showSceneNotification(`Preset「${metadata.name || name}」を保存しました。revision ${metadata.revision || 1}`);
    } catch (error) {
        showSceneBatchError("Presetを保存できませんでした。", error);
    }
}

function attachScenePresetOutput(node) {
    injectStyle();
    applySceneWidgetLabels(node);
    node.resizable = true;
    addSceneButton(node, "scene_preset_save", "保存", () => saveScenePreset(node));
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
}

function attachScenePresetReference(node) {
    injectStyle();
    applySceneWidgetLabels(node);
    node.resizable = true;
    removeInternalInputSockets(node, { visibleNames: new Set(["scene_prompt"]), removeAllExceptVisible: true });
    hideWidget(findWidget(node, "preset_id"));
    addSceneButton(node, "scene_preset_select", "Presetを選択", () => openScenePresetPicker(node));
    if (!node.scenePresetSelectionRefreshInstalled) {
        const previousOnSelected = node.onSelected;
        node.onSelected = function (...args) {
            const result = previousOnSelected?.apply(this, args);
            refreshScenePresetReferenceList(node, true).catch((error) => console.warn("[Scene Prompt]", error));
            return result;
        };
        node.scenePresetSelectionRefreshInstalled = true;
    }
    refreshScenePresetReferenceList(node, true).catch((error) => console.warn("[Scene Prompt]", error));
    scheduleHideInternalDomWidgets();
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
}

function installSceneResizeHandler(node, mode) {
    clearSceneFitHeightTimer(node);
    node.sceneResizeMode = mode;
}

function attachScenePrompt(node) {
    injectStyle();
    applySceneWidgetLabels(node);
    sceneTitleSyncNodes.add(node);

    node.properties = node.properties || {};
    node.resizable = true;
    installSceneConnectionWatcher(node);

    removeInternalInputSockets(node, {
        visibleNames: new Set(["scene_prompt"]),
        removeAllExceptVisible: true,
    });
    ensurePromptSelectionControls(node);
    installScenePromptWidgetSyncHandlers(node);
    hideScenePromptWidgets(node);
    scheduleHideInternalDomWidgets();

    installSceneResizeHandler(node, "fit_width");

    syncScenePromptNameFromTitle(node);
    node.setDirtyCanvas?.(true, true);
}

function attachSceneMatrix(node) {
    injectStyle();
    applySceneWidgetLabels(node);

    node.properties = node.properties || {};
    node.resizable = true;
    node.sceneDefaultStateWidgetName = "positive_json";
    setActiveStateWidget(node, "positive_json");
    installSceneConnectionWatcher(node);

    normalizeSceneMatrixSockets(node);
    ensureMatrixJsonWidget(node);
    ensurePromptMatrixControls(node);
    hidePromptMatrixWidgets(node);
    scheduleHideInternalDomWidgets();

    installSceneResizeHandler(node, "simple");

    node.setDirtyCanvas?.(true, true);
}

function attachScenePromptCounter(node) {
    injectStyle();
    applySceneWidgetLabels(node);

    node.properties = node.properties || {};
    node.resizable = true;
    installSceneConnectionWatcher(node);

    removeInternalInputSockets(node, {
        visibleNames: new Set(["scene_prompt"]),
    });
    installScenePromptCounterWidgetSyncHandlers(node);
    hideScenePromptCounterWidgets(node);
    scheduleHideInternalDomWidgets();

    installSceneResizeHandler(node, "simple");

    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
}

function attachScenePromptMerge(node) {
    injectStyle();
    applySceneWidgetLabels(node);

    node.properties = node.properties || {};
    node.resizable = true;
    installSceneConnectionWatcher(node);

    normalizeScenePromptMergeSockets(node);
    addScenePromptMergeListWidget(node);
    hideNonSceneRoleWidgets(node);
    scheduleHideInternalDomWidgets();

    installSceneResizeHandler(node, "simple");

    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
}

function attachScenePath(node) {
    injectStyle();
    applySceneWidgetLabels(node);
    sceneTitleSyncNodes.add(node);

    node.properties = node.properties || {};
    node.resizable = true;
    installSceneConnectionWatcher(node);

    removeInternalInputSockets(node, {
        visibleNames: new Set(["scene_prompt"]),
        removeAllExceptVisible: true,
    });
    installScenePathWidgetSyncHandlers(node);
    hideScenePathWidgets(node);
    scheduleHideInternalDomWidgets();
    syncScenePathNameFromTitle(node);

    installSceneResizeHandler(node, "simple");

    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
}

function attachScenePromptQueue(node) {
    injectStyle();
    applySceneWidgetLabels(node);

    node.properties = node.properties || {};
    node.resizable = true;
    installSceneConnectionWatcher(node);

    normalizeScenePromptQueueInputs(node);
    addScenePromptQueueListWidget(node);
    hideNonSceneRoleWidgets(node);
    scheduleHideInternalDomWidgets();

    installSceneResizeHandler(node, "simple");

    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
}

function attachSceneUtilityNode(node, nodeName) {
    injectStyle();
    applySceneWidgetLabels(node);
    installSceneConnectionWatcher(node);
    if (isSceneExpandNodeName(nodeName)) {
        if (!sceneBatchRunForNode(node)) {
            resetSceneExpandRunControls(node, { mark: false });
        }
        ensureSceneExpandControls(node);
    }
    if (SCENE_EMPTY_LATENT_NODE_NAMES.has(nodeName)) {
        installSceneEmptyLatentWidgetSyncHandlers(node);
    }
    hideSceneUtilityWidgets(node, nodeName);
    scheduleHideInternalDomWidgets();
    if (isSceneExpandNodeName(nodeName)) {
        refreshSceneExpandNode(node, { fitHeight: true });
    } else {
        node.setDirtyCanvas?.(true, true);
        app.graph?.setDirtyCanvas?.(true, true);
        app.canvas?.setDirty?.(true, true);
    }
}

function popupContextReferencesNode(context, node) {
    for (let current = context; current; current = current.parent?.context || null) {
        if (current.node === node) {
            return true;
        }
    }
    return false;
}

function installSceneNodeRemovalCleanup(node, nodeName) {
    if (node.scenePromptRemovalInstalled) {
        return;
    }
    const previousOnRemoved = node.onRemoved;
    node.onRemoved = function (...args) {
        sceneTitleSyncNodes.delete(this);
        sceneLoadedRefreshNodes.delete(this);
        sceneDownstreamRefreshSources.delete(this);
        clearSceneFitHeightTimer(this);
        clearTimeout(this.sceneRefreshTimer);
        this.sceneRefreshTimer = null;
        this.scenePendingRefreshOptions = null;
        if (popupContextReferencesNode(activePopupContext, this)) {
            closeAllPopups();
        }
        if (isSceneExpandNodeName(nodeName)) {
            cancelSceneBatchRunForNode(this);
        }
        return previousOnRemoved?.apply(this, args);
    };
    node.scenePromptRemovalInstalled = true;
}

function attachSceneNode(node, nodeName) {
    installSceneNodeRemovalCleanup(node, nodeName);
    if (isScenePresetOutputNode(node) || SCENE_PRESET_OUTPUT_NODE_NAMES.has(nodeName)) {
        attachScenePresetOutput(node);
    } else if (isScenePresetReferenceNode(node) || SCENE_PRESET_REFERENCE_NODE_NAMES.has(nodeName)) {
        attachScenePresetReference(node);
    } else if (isScenePresetInputNode(node) || SCENE_PRESET_INPUT_NODE_NAMES.has(nodeName)) {
        injectStyle();
        applySceneWidgetLabels(node);
    } else if (isPromptMatrixNode(node) || PROMPT_MATRIX_NODE_NAMES.has(nodeName)) {
        attachSceneMatrix(node);
    } else if (isScenePathNode(node) || SCENE_PATH_NODE_NAMES.has(nodeName)) {
        attachScenePath(node);
    } else if (isScenePromptMergeNode(node) || SCENE_PROMPT_MERGE_NODE_NAMES.has(nodeName)) {
        attachScenePromptMerge(node);
    } else if (isScenePromptCounterNode(node) || SCENE_PROMPT_COUNTER_NODE_NAMES.has(nodeName)) {
        attachScenePromptCounter(node);
    } else if (isScenePromptQueueNode(node) || SCENE_PROMPT_QUEUE_NODE_NAMES.has(nodeName)) {
        attachScenePromptQueue(node);
    } else if (
        SCENE_PROMPT_EXPAND_NODE_NAMES.has(nodeName)
        || SCENE_EMPTY_LATENT_NODE_NAMES.has(nodeName)
        || SCENE_SAVE_IMAGE_NODE_NAMES.has(nodeName)
    ) {
        attachSceneUtilityNode(node, nodeName);
    } else {
        attachScenePrompt(node);
    }
}

function scheduleAttachSceneNode(node, nodeName) {
    if (!node || node.scenePromptAttachScheduled) {
        return;
    }
    node.scenePromptAttachScheduled = true;
    requestAnimationFrame(() => {
        node.scenePromptAttachScheduled = false;
        try {
            attachSceneNode(node, nodeName);
        } catch (error) {
            console.error("[Scene Prompt] ノードの初期化に失敗しました", error);
            showSceneBatchError("Sceneノードを読み込めませんでした。", error);
        }
    });
}

function previewUrl(imageRef) {
    const params = new URLSearchParams();
    params.set("filename", imageRef.filename || "");
    params.set("type", imageRef.type || "output");
    params.set("subfolder", imageRef.subfolder || "");
    return `./view?${params.toString()}&t=${Date.now()}${app.getPreviewFormatParam?.() || ""}`;
}

function sceneNodeFromEvent(detail) {
    const rawId = String(detail?.display_node || detail?.node || "").split(":")[0];
    if (!rawId) {
        return null;
    }
    return app.graph?.getNodeById?.(Number(rawId)) || app.graph?.getNodeById?.(rawId) || null;
}

function imageRefKey(imageRef) {
    return JSON.stringify({
        filename: imageRef?.filename || "",
        subfolder: imageRef?.subfolder || "",
        type: imageRef?.type || "output",
    });
}

function appendSceneSavePreview(detail) {
    const node = sceneNodeFromEvent(detail);
    const images = detail?.output?.images || [];
    if (!node || !SCENE_SAVE_IMAGE_NODE_NAMES.has(node.type) || !images.length) {
        return;
    }

    node.scenePreviewKeys = node.scenePreviewKeys || new Set();
    node.scenePreviewImages = node.scenePreviewImages || new Map();
    node.imgs = Array.isArray(node.imgs) ? node.imgs : [];

    for (const imageRef of images) {
        const key = imageRefKey(imageRef);
        if (node.scenePreviewKeys.has(key) && node.scenePreviewImages.has(key)) {
            const existingImage = node.scenePreviewImages.get(key);
            const existingIndex = node.imgs.indexOf(existingImage);
            if (existingIndex >= 0) {
                node.imageIndex = existingIndex;
            }
            continue;
        }
        node.scenePreviewKeys.add(key);
        const image = new Image();
        image.scenePreviewKey = key;
        image.onload = () => {
            if (node.size) {
                node.size[1] = Math.max(220, node.size[1] || 0);
            }
            node.setDirtyCanvas?.(true, true);
            app.graph?.setDirtyCanvas?.(true, true);
            app.canvas?.setDirty?.(true, true);
        };
        image.src = previewUrl(imageRef);
        node.scenePreviewImages.set(key, image);
        node.imgs.push(image);
        node.imageIndex = node.imgs.length - 1;
    }

    trimSceneSavePreviews(node);
    if (node.size) {
        node.size[1] = Math.max(220, node.size[1] || 0);
    }
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
}

function trimSceneSavePreviews(node) {
    if (!Array.isArray(node?.imgs) || node.imgs.length <= SCENE_SAVE_PREVIEW_LIMIT) {
        return;
    }
    const removeCount = Math.max(0, node.imgs.length - SCENE_SAVE_PREVIEW_LIMIT);
    const removed = node.imgs.splice(0, removeCount);
    for (const image of removed) {
        const key = image?.scenePreviewKey;
        if (key) {
            node.scenePreviewKeys?.delete(key);
            node.scenePreviewImages?.delete(key);
        }
    }
    node.imageIndex = Math.max(0, node.imgs.length - 1);
}

function clearSceneSavePreviews() {
    for (const node of app.graph?._nodes || []) {
        if (!SCENE_SAVE_IMAGE_NODE_NAMES.has(node?.type)) {
            continue;
        }
        node.scenePreviewKeys = new Set();
        node.scenePreviewImages = new Map();
        node.imgs = [];
        node.imageIndex = 0;
        node.setDirtyCanvas?.(true, true);
    }
}

app.registerExtension({
    name: "ScenePrompt.UI",

    setup() {
        if (window.__ScenePromptUISetupInstalled) {
            return;
        }
        window.__ScenePromptUISetupInstalled = true;
        scheduleScenePromptQueueSyncInstall();
        window.addEventListener("pagehide", releaseSceneRunsOnPageHide);
        api.addEventListener("execution_start", () => {
            if (!sceneBatchRun) {
                clearSceneSavePreviews();
            }
        });
        api.addEventListener("executed", ({ detail }) => appendSceneSavePreview(detail));
        api.addEventListener("execution_success", ({ detail }) => {
            rememberSceneBatchTerminalEvent("success", detail);
            continueSceneBatchRun(detail);
            releasePendingSceneBatchPlan(detail);
            releaseCompletedSceneRun(detail);
        });
        api.addEventListener("execution_error", ({ detail }) => {
            rememberSceneBatchTerminalEvent("error", detail);
            failSceneBatchRun(detail);
            releasePendingSceneBatchPlan(detail);
            releaseCompletedSceneRun(detail);
        });
        api.addEventListener("execution_interrupted", ({ detail }) => {
            rememberSceneBatchTerminalEvent("interrupted", detail);
            failSceneBatchRun(detail);
            releasePendingSceneBatchPlan(detail);
            releaseCompletedSceneRun(detail);
        });
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!NODE_NAMES.has(nodeData.name)) {
            return;
        }
        const wrapMarker = `__ScenePromptWrapped_${nodeData.name}`;
        if (nodeType.prototype[wrapMarker]) {
            return;
        }
        nodeType.prototype[wrapMarker] = true;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            attachSceneNode(this, nodeData.name);
            return result;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = onConfigure?.apply(this, arguments);
            scheduleAttachSceneNode(this, nodeData.name);
            return result;
        };
    },

    loadedGraphNode(node) {
        if (isPromptMatrixNode(node) || isScenePromptSourceNode(node)) {
            scheduleLoadedSceneNodeRefresh(node);
        }
    },
});
