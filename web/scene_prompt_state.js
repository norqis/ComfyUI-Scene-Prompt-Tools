export const SELECTION_STATE_VERSION = 1;
export const MATRIX_STATE_VERSION = 1;
export const MATRIX_LINE_TYPE = "SCENE_MATRIX_LINE";

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
const SELECTED_PART_OPTIONAL_KEYS = ["weight"];
const MATRIX_LINE_KEYS = [
    "type", "version", "row_id", "node_id", "category", "name", "path_label", "enabled", "filename_enabled",
    "positive_base", "positive_json", "negative_base", "negative_json", "category_order",
    "positive_parts", "negative_parts", "display_labels", "display_label_groups",
];
const MATRIX_LINE_REQUIRED_LEGACY_KEYS = ["row_id", "name", "path_label"];

function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function isEmptyValue(value) {
    return value === null || value === undefined || (typeof value === "string" && !value.trim());
}

function parseJsonValue(value, label) {
    if (typeof value === "string") {
        try {
            return JSON.parse(value);
        } catch (error) {
            throw new Error(`${label} JSON is invalid.`, { cause: error });
        }
    }
    return value;
}

function requireString(value, label, { allowEmpty = true } = {}) {
    if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
        throw new Error(`${label} must be${allowEmpty ? "" : " a non-empty"} string.`);
    }
    return value;
}

function requireStringList(value, label) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new Error(`${label} must be a list of strings.`);
    }
    return [...value];
}

function requireStringGroups(value, label) {
    if (!Array.isArray(value) || value.some((group) => !Array.isArray(group) || group.some((item) => typeof item !== "string"))) {
        throw new Error(`${label} must be a list of string lists.`);
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
        throw new Error(`${label} has unsupported or missing fields.`);
    }
}

function requireWeight(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0.05 || value > 3) {
        throw new Error(`${label} must be a number between 0.05 and 3.`);
    }
    return value;
}

function parseSelectedPart(value, promptParts, label) {
    if (!isPlainObject(value)) {
        throw new Error(`${label} must be an object.`);
    }
    requireExactKeys(value, SELECTED_PART_REQUIRED_KEYS, SELECTED_PART_OPTIONAL_KEYS, label);
    if (!Number.isSafeInteger(value.index) || value.index < 0 || value.index >= promptParts.length) {
        throw new Error(`${label} index is invalid.`);
    }
    const text = requireString(value.text, `${label} text`, { allowEmpty: false });
    if (promptParts[value.index] !== text) {
        throw new Error(`${label} does not match its prompt part.`);
    }
    const result = { index: value.index, text };
    if (Object.hasOwn(value, "weight")) {
        result.weight = requireWeight(value.weight, `${label} weight`);
    }
    return result;
}

function parseSelectionItem(value, category, label) {
    if (!isPlainObject(value)) {
        throw new Error(`${label} must be an object.`);
    }
    if (!Object.hasOwn(value, "label") || !Object.hasOwn(value, "prompt") || Object.keys(value).some((key) => !SELECTION_ITEM_KNOWN_KEYS.has(key))) {
        throw new Error(`${label} has unsupported or missing fields.`);
    }
    const categoryPath = category.split(" > ");
    if (!category.trim() || categoryPath.some((part) => !part.trim())) {
        throw new Error(`${label} category is invalid.`);
    }
    if (Object.hasOwn(value, "category_path")) {
        const storedPath = requireStringList(value.category_path, `${label} category_path`);
        if (!storedPath.length || storedPath.some((part) => !part.trim())) {
            throw new Error(`${label} category_path must be a non-empty list of strings.`);
        }
        if (storedPath.length !== categoryPath.length || storedPath.some((part, index) => part !== categoryPath[index])) {
            throw new Error(`${label} category fields are inconsistent.`);
        }
    }
    for (const field of ["category_key", "category_label"]) {
        if (Object.hasOwn(value, field) && requireString(value[field], `${label} ${field}`, { allowEmpty: false }) !== category) {
            throw new Error(`${label} category fields are inconsistent.`);
        }
    }
    const prompt = requireString(value.prompt, `${label} prompt`, { allowEmpty: false });
    if (Object.hasOwn(value, "legacy_keys")) {
        const legacyKeys = requireStringList(value.legacy_keys, `${label} legacy_keys`);
        if (!legacyKeys.length || legacyKeys.some((key) => !key.trim())) {
            throw new Error(`${label} legacy_keys must be a non-empty list of strings.`);
        }
    }
    if (Object.hasOwn(value, "weight") && Object.hasOwn(value, "selected_parts")) {
        throw new Error(`${label} cannot contain both weight and selected_parts.`);
    }
    const result = {
        label: requireString(value.label, `${label} label`, { allowEmpty: false }),
        prompt,
        category_path: categoryPath,
        category_key: category,
        category_label: category,
    };
    if (Object.hasOwn(value, "id")) result.id = requireString(value.id, `${label} id`, { allowEmpty: false });
    if (Object.hasOwn(value, "description")) result.description = requireString(value.description, `${label} description`);
    if (Object.hasOwn(value, "weight")) result.weight = requireWeight(value.weight, `${label} weight`);
    if (Object.hasOwn(value, "selected_parts")) {
        if (!Array.isArray(value.selected_parts) || !value.selected_parts.length) {
            throw new Error(`${label} selected_parts must be a non-empty list.`);
        }
        const promptParts = splitPromptParts(prompt);
        const parts = value.selected_parts.map((part, index) => parseSelectedPart(part, promptParts, `${label} selected_parts[${index}]`));
        if (new Set(parts.map((part) => part.index)).size !== parts.length) {
            throw new Error(`${label} selected_parts must not repeat an index.`);
        }
        result.selected_parts = parts;
    }
    return result;
}

export function createSelectionState() {
    return { version: SELECTION_STATE_VERSION, categories: {} };
}

export function parseSelectionState(value) {
    if (isEmptyValue(value)) {
        return createSelectionState();
    }

    const parsed = parseJsonValue(value, "Scene Prompt selection");
    if (!isPlainObject(parsed) || Object.keys(parsed).length !== 2 || !Object.hasOwn(parsed, "version") || !Object.hasOwn(parsed, "categories")) {
        throw new Error("Scene Prompt selection must be an object.");
    }
    if (parsed.version !== SELECTION_STATE_VERSION) {
        throw new Error("Unsupported Scene Prompt selection schema version.");
    }
    if (!isPlainObject(parsed.categories)) {
        throw new Error("Scene Prompt selection categories must be an object.");
    }

    const categories = {};
    for (const [name, items] of Object.entries(parsed.categories)) {
        requireString(name, "Scene Prompt selection category", { allowEmpty: false });
        if (!Array.isArray(items)) {
            throw new Error("Scene Prompt selection category entries must be a list of objects.");
        }
        categories[name] = items.map((item, index) => parseSelectionItem(item, name, `Scene Prompt selection entry ${index}`));
    }
    return { version: SELECTION_STATE_VERSION, categories };
}

export function serializeSelectionState(value) {
    return JSON.stringify(parseSelectionState(value));
}

export function createMatrixLine(name) {
    const title = requireString(name, "Scene Matrix line name", { allowEmpty: false }).trim();
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
    if (!isPlainObject(value)) {
        throw new Error("Scene Matrix entries must be objects.");
    }
    if (MATRIX_LINE_REQUIRED_LEGACY_KEYS.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !MATRIX_LINE_KEYS.includes(key))) {
        throw new Error("Scene Matrix entry has unsupported or missing fields.");
    }
    if ((Object.hasOwn(value, "type") && value.type !== MATRIX_LINE_TYPE) || (Object.hasOwn(value, "version") && value.version !== MATRIX_STATE_VERSION)) {
        throw new Error("Unsupported Scene Matrix entry schema.");
    }
    if (Object.hasOwn(value, "enabled") && typeof value.enabled !== "boolean") {
        throw new Error("Scene Matrix entry enabled must be a boolean.");
    }
    if (Object.hasOwn(value, "filename_enabled") && typeof value.filename_enabled !== "boolean") {
        throw new Error("Scene Matrix entry filename_enabled must be a boolean.");
    }

    const name = requireString(value.name, "Scene Matrix line name", { allowEmpty: false }).trim();
    const pathLabel = requireString(value.path_label, "Scene Matrix line path label", { allowEmpty: false }).trim();
    const rowId = requireString(value.row_id, "Scene Matrix line row id", { allowEmpty: false });
    const fieldOrDefault = (field, fallback) => Object.hasOwn(value, field) ? value[field] : fallback;

    return {
        type: MATRIX_LINE_TYPE,
        version: MATRIX_STATE_VERSION,
        row_id: rowId,
        node_id: requireString(fieldOrDefault("node_id", ""), "Scene Matrix line node id"),
        category: requireString(fieldOrDefault("category", ""), "Scene Matrix line category"),
        name,
        path_label: pathLabel,
        enabled: fieldOrDefault("enabled", true),
        filename_enabled: fieldOrDefault("filename_enabled", false),
        positive_base: requireString(fieldOrDefault("positive_base", ""), "Scene Matrix positive base"),
        positive_json: serializeSelectionState(fieldOrDefault("positive_json", DEFAULT_SELECTED_JSON)),
        negative_base: requireString(fieldOrDefault("negative_base", ""), "Scene Matrix negative base"),
        negative_json: serializeSelectionState(fieldOrDefault("negative_json", DEFAULT_SELECTED_JSON)),
        category_order: requireString(fieldOrDefault("category_order", ""), "Scene Matrix category order"),
        positive_parts: requireStringList(fieldOrDefault("positive_parts", []), "Scene Matrix positive parts"),
        negative_parts: requireStringList(fieldOrDefault("negative_parts", []), "Scene Matrix negative parts"),
        display_labels: requireStringList(fieldOrDefault("display_labels", []), "Scene Matrix display labels"),
        display_label_groups: requireStringGroups(fieldOrDefault("display_label_groups", []), "Scene Matrix display label groups"),
    };
}

export function createMatrixState() {
    return { version: MATRIX_STATE_VERSION, sets: [] };
}

export function parseMatrixState(value) {
    if (isEmptyValue(value)) {
        return createMatrixState();
    }

    const parsed = parseJsonValue(value, "Scene Matrix");
    if (!isPlainObject(parsed) || Object.keys(parsed).length !== 2 || !Object.hasOwn(parsed, "version") || !Object.hasOwn(parsed, "sets")) {
        throw new Error("Scene Matrix JSON must be an object.");
    }
    if (parsed.version !== MATRIX_STATE_VERSION) {
        throw new Error("Unsupported Scene Matrix schema version.");
    }
    if (!Array.isArray(parsed.sets)) {
        throw new Error("Scene Matrix sets must be a list.");
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
        throw new Error(`${label} must be a non-negative integer.`);
    }
    return value;
}

export function formatSceneExpandCounts(totalBatches, totalImages) {
    const batches = requireCount(totalBatches, "Scene Expand total batches");
    const images = requireCount(totalImages, "Scene Expand total images");
    return `${batches}回 / ${images}枚`;
}
