export const SELECTION_STATE_VERSION = 1;
export const MATRIX_STATE_VERSION = 1;
export const MATRIX_LINE_TYPE = "SCENE_MATRIX_LINE";
export const SCENE_MODEL_MODES = ["Illustrious", "Anima", "NoobAI", "Pony"];

export const DEFAULT_SELECTED_JSON = "{\"version\":1,\"categories\":{}}";
export const MATRIX_DEFAULT_JSON = "{\"version\":1,\"sets\":[]}";
const SELECTION_ITEM_REQUIRED_KEYS = ["label", "prompt", "category_path", "category_key", "category_label"];
const SELECTION_ITEM_OPTIONAL_KEYS = ["id", "description", "weight", "selected_parts"];
const SELECTION_ITEM_LEGACY_OPTIONAL_KEYS = ["legacy_keys"];
const SELECTION_ITEM_KNOWN_KEYS = new Set([
    ...SELECTION_ITEM_REQUIRED_KEYS,
    ...SELECTION_ITEM_OPTIONAL_KEYS,
    ...SELECTION_ITEM_LEGACY_OPTIONAL_KEYS,
]);
const SELECTED_PART_REQUIRED_KEYS = ["index", "text"];
const SELECTED_PART_OPTIONAL_KEYS = ["weight", "missing"];
const MATRIX_LINE_KEYS = [
    "type", "version", "row_id", "node_id", "category", "name", "path_label", "enabled", "filename_enabled",
    "positive_base", "positive_json", "negative_base", "negative_json", "category_order",
    "positive_parts", "negative_parts", "display_labels", "display_label_groups",
    "row_kind", "preset_id", "switch_settings_json",
];
const MATRIX_LINE_REQUIRED_LEGACY_KEYS = ["row_id", "name", "path_label"];

function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function isEmptyValue(value) {
    return value === null || value === undefined || (typeof value === "string" && !value.trim());
}

function stateError(message, cause) {
    return new Error(`${message} 該当の設定を確認し、編集画面を開き直してください。`, cause ? { cause } : undefined);
}

function parseJsonValue(value, label) {
    if (typeof value === "string") {
        try {
            return JSON.parse(value);
        } catch (error) {
            throw stateError(`${label}の保存データをJSONとして読み取れません。`, error);
        }
    }
    return value;
}

function requireString(value, label, { allowEmpty = true } = {}) {
    if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
        throw stateError(`${label}は${allowEmpty ? "文字列" : "空でない文字列"}で指定してください。`);
    }
    return value;
}

function requireStringList(value, label) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw stateError(`${label}は文字列の一覧で指定してください。`);
    }
    return [...value];
}

function requireStringGroups(value, label) {
    if (!Array.isArray(value) || value.some((group) => !Array.isArray(group) || group.some((item) => typeof item !== "string"))) {
        throw stateError(`${label}は文字列をまとめた一覧で指定してください。`);
    }
    return value.map((group) => [...group]);
}

function splitPromptParts(text) {
    const parts = [];
    let current = "";
    let depth = 0;
    for (const character of text) {
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
    return parts;
}

function requireExactKeys(value, required, optional, label) {
    const allowed = new Set([...required, ...optional]);
    const keys = Object.keys(value);
    if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !allowed.has(key))) {
        const missing = required.filter(key => !Object.hasOwn(value, key));
        const unsupported = keys.filter(key => !allowed.has(key));
        throw stateError(`${label}の項目が一致しません。${missing.length ? `不足: ${missing.join("、")}。` : ""}${unsupported.length ? `未対応の項目: ${unsupported.join("、")}。` : ""}`);
    }
}

function requireWeight(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw stateError(`${label}は有限の数値で指定してください。`);
    }
    return value;
}

function parseSelectedPart(value, promptParts, label) {
    if (!isPlainObject(value)) {
        throw stateError(`${label}は項目名と値の組で指定してください。`);
    }
    requireExactKeys(value, SELECTED_PART_REQUIRED_KEYS, SELECTED_PART_OPTIONAL_KEYS, label);
    if (!Number.isSafeInteger(value.index) || value.index < 0) {
        throw stateError(`${label}の選択位置は0以上の整数で指定してください。`);
    }
    const text = requireString(value.text, `${label}のテキスト`, { allowEmpty: false });
    let missing = value.missing ?? false;
    if (typeof missing !== "boolean") {
        throw stateError(`${label}の欠落フラグはtrueまたはfalseで指定してください。`);
    }
    if (!missing && (value.index >= promptParts.length || promptParts[value.index] !== text)) {
        missing = true;
    }
    const result = { index: value.index, text };
    if (missing) result.missing = true;
    if (Object.hasOwn(value, "weight")) {
        result.weight = requireWeight(value.weight, `${label}の強度`);
    }
    return result;
}

export function normalizeMissingPartIndexes(parts, promptPartCount) {
    const used = new Set(parts.filter((part) => !part.missing).map((part) => part.index));
    let nextIndex = promptPartCount;
    for (const part of parts) {
        if (!part.missing) continue;
        if (used.has(part.index)) {
            while (used.has(nextIndex)) nextIndex += 1;
            part.index = nextIndex++;
        }
        used.add(part.index);
    }
    return parts;
}

function parseSelectionItem(value, category, label) {
    if (!isPlainObject(value)) {
        throw stateError(`${label}は項目名と値の組で指定してください。`);
    }
    if (!Object.hasOwn(value, "label") || !Object.hasOwn(value, "prompt") || Object.keys(value).some((key) => !SELECTION_ITEM_KNOWN_KEYS.has(key))) {
        throw stateError(`${label}に候補名・プロンプトがないか、未対応の項目があります。`);
    }
    const categoryPath = category.split(" > ");
    if (!category.trim() || categoryPath.some((part) => !part.trim())) {
        throw stateError(`${label}のカテゴリ名が空か、階層の区切りが正しくありません。`);
    }
    if (Object.hasOwn(value, "category_path")) {
        const storedPath = requireStringList(value.category_path, `${label}のカテゴリ階層`);
        if (!storedPath.length || storedPath.some((part) => !part.trim())) {
            throw stateError(`${label}のカテゴリ階層に空の名前があります。`);
        }
        if (storedPath.length !== categoryPath.length || storedPath.some((part, index) => part !== categoryPath[index])) {
            throw stateError(`${label}のカテゴリ名と階層が一致しません。`);
        }
    }
    for (const field of ["category_key", "category_label"]) {
        if (Object.hasOwn(value, field) && requireString(value[field], `${label}のカテゴリ名`, { allowEmpty: false }) !== category) {
            throw stateError(`${label}のカテゴリ名と階層が一致しません。`);
        }
    }
    const prompt = requireString(value.prompt, `${label}のプロンプト`, { allowEmpty: false });
    if (Object.hasOwn(value, "legacy_keys")) {
        const legacyKeys = requireStringList(value.legacy_keys, `${label}の旧形式キー (legacy_keys)`);
        if (!legacyKeys.length || legacyKeys.some((key) => !key.trim())) {
            throw stateError(`${label}の旧形式キー (legacy_keys) に空の項目があります。`);
        }
    }
    if (Object.hasOwn(value, "weight") && Object.hasOwn(value, "selected_parts")) {
        throw stateError(`${label}に候補全体の強度と部分選択が両方保存されています。どちらか一方の設定にしてください。`);
    }
    const result = {
        label: requireString(value.label, `${label}の候補名`, { allowEmpty: false }),
        prompt,
        category_path: categoryPath,
        category_key: category,
        category_label: category,
    };
    if (Object.hasOwn(value, "id")) result.id = requireString(value.id, `${label}の識別名`, { allowEmpty: false });
    if (Object.hasOwn(value, "description")) result.description = requireString(value.description, `${label}の説明`);
    if (Object.hasOwn(value, "weight")) result.weight = requireWeight(value.weight, `${label}の強度`);
    if (Object.hasOwn(value, "selected_parts")) {
        if (!Array.isArray(value.selected_parts) || !value.selected_parts.length) {
            throw stateError(`${label}の部分選択には少なくとも1つの項目が必要です。`);
        }
        const promptParts = splitPromptParts(prompt);
        const parts = normalizeMissingPartIndexes(value.selected_parts.map((part, index) => parseSelectedPart(part, promptParts, `${label}の部分選択 ${index + 1}番目`)), promptParts.length);
        if (new Set(parts.map((part) => part.index)).size !== parts.length) {
            throw stateError(`${label}の部分選択に同じ選択位置が重複しています。`);
        }
        result.selected_parts = parts;
    }
    return result;
}

export function createSelectionState() {
    return { version: SELECTION_STATE_VERSION, categories: Object.create(null) };
}

export function parseSelectionState(value) {
    if (isEmptyValue(value)) {
        return createSelectionState();
    }

    const parsed = parseJsonValue(value, "候補の選択内容");
    if (!isPlainObject(parsed) || Object.keys(parsed).length !== 2 || !Object.hasOwn(parsed, "version") || !Object.hasOwn(parsed, "categories")) {
        throw stateError("候補の選択データには形式番号とカテゴリ一覧が必要です。");
    }
    if (parsed.version !== SELECTION_STATE_VERSION) {
        throw stateError(`候補の選択データの形式番号「${parsed.version}」には対応していません。保存時の拡張機能のバージョンを確認してください。`);
    }
    if (!isPlainObject(parsed.categories)) {
        throw stateError("候補のカテゴリ一覧は、カテゴリ名と候補の組で指定してください。");
    }

    const categories = Object.create(null);
    for (const [name, items] of Object.entries(parsed.categories)) {
        requireString(name, "候補のカテゴリ名", { allowEmpty: false });
        if (!Array.isArray(items)) {
            throw stateError(`カテゴリ「${name}」の候補は一覧で指定してください。`);
        }
        categories[name] = items.map((item, index) => parseSelectionItem(item, name, `カテゴリ「${name}」 / 候補${typeof item?.label === "string" && item.label.trim() ? `「${item.label}」` : ` ${index + 1}番目`}`));
    }
    return { version: SELECTION_STATE_VERSION, categories };
}

export function serializeSelectionState(value) {
    return JSON.stringify(parseSelectionState(value));
}

export function createMatrixLine(name) {
    const title = requireString(name, "Matrixの行名", { allowEmpty: false }).trim();
    return {
        type: MATRIX_LINE_TYPE,
        version: MATRIX_STATE_VERSION,
        row_id: `matrix-row-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        node_id: "",
        category: "",
        name: title,
        path_label: title,
        enabled: true,
        filename_enabled: false,
        positive_base: "",
        positive_json: DEFAULT_SELECTED_JSON,
        negative_base: "",
        negative_json: DEFAULT_SELECTED_JSON,
        category_order: "",
        positive_parts: [],
        negative_parts: [],
        display_labels: [],
        display_label_groups: [],
    };
}

export function parseMatrixLine(value) {
    try {
        return parseMatrixLineData(value);
    } catch (error) {
        const name = typeof value?.name === "string" ? value.name.trim() : "";
        throw new Error(`${name ? `Matrix行「${name}」` : "Matrixの行"}: ${error.message}`, { cause: error });
    }
}

function matrixSelectionJson(value, side) {
    try {
        return serializeSelectionState(value);
    } catch (error) {
        throw new Error(`${side}候補: ${error.message}`, { cause: error });
    }
}

function parseMatrixLineData(value) {
    if (!isPlainObject(value)) {
        throw stateError("行データは項目名と値の組で指定してください。");
    }
    if (MATRIX_LINE_REQUIRED_LEGACY_KEYS.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !MATRIX_LINE_KEYS.includes(key))) {
        throw stateError("行の識別名・行名・保存パス名がないか、未対応の項目があります。");
    }
    if ((Object.hasOwn(value, "type") && value.type !== MATRIX_LINE_TYPE) || (Object.hasOwn(value, "version") && value.version !== MATRIX_STATE_VERSION)) {
        throw stateError("行データの種類または形式番号に対応していません。保存時の拡張機能のバージョンを確認してください。");
    }
    if (Object.hasOwn(value, "enabled") && typeof value.enabled !== "boolean") {
        throw stateError("行の有効・無効はtrueまたはfalseで指定してください。");
    }
    if (Object.hasOwn(value, "filename_enabled") && typeof value.filename_enabled !== "boolean") {
        throw stateError("ファイル名付与の有効・無効はtrueまたはfalseで指定してください。");
    }
    const rowKind = value.row_kind ?? "normal";
    if (!["normal", "preset"].includes(rowKind)) throw stateError("行の種類は通常行またはPreset行を指定してください。");

    const name = requireString(value.name, "行名", { allowEmpty: false }).trim();
    const pathLabel = requireString(value.path_label, "保存パス名", { allowEmpty: false }).trim();
    const rowId = requireString(value.row_id, "行の識別名", { allowEmpty: false });
    const fieldOrDefault = (field, fallback) => Object.hasOwn(value, field) ? value[field] : fallback;

    return {
        ...(rowKind === "preset" ? {
            row_kind: "preset",
            preset_id: requireString(value.preset_id ?? "", "Presetの識別名"),
            switch_settings_json: requireString(value.switch_settings_json ?? "[]", "Presetのスイッチ設定"),
        } : {}),
        type: MATRIX_LINE_TYPE,
        version: MATRIX_STATE_VERSION,
        row_id: rowId,
        node_id: requireString(fieldOrDefault("node_id", ""), "参照ノードの識別名"),
        category: requireString(fieldOrDefault("category", ""), "カテゴリ名"),
        name,
        path_label: pathLabel,
        enabled: fieldOrDefault("enabled", true),
        filename_enabled: fieldOrDefault("filename_enabled", false),
        positive_base: requireString(fieldOrDefault("positive_base", ""), "ポジティブ基本文"),
        positive_json: matrixSelectionJson(fieldOrDefault("positive_json", DEFAULT_SELECTED_JSON), "ポジティブ"),
        negative_base: requireString(fieldOrDefault("negative_base", ""), "ネガティブ基本文"),
        negative_json: matrixSelectionJson(fieldOrDefault("negative_json", DEFAULT_SELECTED_JSON), "ネガティブ"),
        category_order: requireString(fieldOrDefault("category_order", ""), "カテゴリの順序"),
        positive_parts: requireStringList(fieldOrDefault("positive_parts", []), "ポジティブの構成要素"),
        negative_parts: requireStringList(fieldOrDefault("negative_parts", []), "ネガティブの構成要素"),
        display_labels: requireStringList(fieldOrDefault("display_labels", []), "表示ラベル"),
        display_label_groups: requireStringGroups(fieldOrDefault("display_label_groups", []), "表示ラベルのグループ"),
    };
}

export function createMatrixState() {
    return { version: MATRIX_STATE_VERSION, sets: [] };
}

export function parseMatrixState(value) {
    if (isEmptyValue(value)) {
        return createMatrixState();
    }

    const parsed = parseJsonValue(value, "Matrixの行一覧");
    if (!isPlainObject(parsed) || Object.keys(parsed).length !== 2 || !Object.hasOwn(parsed, "version") || !Object.hasOwn(parsed, "sets")) {
        throw stateError("Matrixの行データには形式番号と行一覧が必要です。");
    }
    if (parsed.version !== MATRIX_STATE_VERSION) {
        throw stateError(`Matrixの形式番号「${parsed.version}」には対応していません。保存時の拡張機能のバージョンを確認してください。`);
    }
    if (!Array.isArray(parsed.sets)) {
        throw stateError("Matrixの行は一覧で指定してください。");
    }
    return {
        version: MATRIX_STATE_VERSION,
        sets: parsed.sets.map((line) => parseMatrixLine(line)),
    };
}

export function serializeMatrixState(value) {
    return JSON.stringify(parseMatrixState(value));
}

function requireCount(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw stateError(`${label}は0以上の整数で指定してください。`);
    }
    return value;
}

export function formatSceneExpandCounts(totalBatches, totalImages) {
    const batches = requireCount(totalBatches, "生成回数");
    const images = requireCount(totalImages, "生成枚数");
    return `${batches}回 / ${images}枚`;
}
