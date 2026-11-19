import assert from "node:assert/strict";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

export async function testReadableSceneErrors(browser, url) {
    const page = await browser.newPage({ viewport: { width: 1050, height: 800 } });
    await page.goto(url); await page.waitForFunction(() => window.__scenePromptBrowserReady);
    await page.evaluate(() => {
        window.app.ui = { dialog: { show(body) {
            const dialog = document.querySelector("#error-dialog") || document.body.appendChild(Object.assign(document.createElement("div"), { id: "error-dialog" }));
            dialog.setAttribute("role", "dialog"); dialog.style.cssText="margin:30px;padding:24px;border:1px solid #999;background:#24282e;color:#eee;font:16px/1.8 sans-serif";
            dialog.replaceChildren(body);
        } } };
        const node = { id: 41, type: "SceneMatrix", title: "別タブの同じID", graph: window.app.graph, widgets: [], properties: {} };
        window.app.graph._nodes.push(node);
        window.__scenePromptPopupTestHooks.maybeShowPromptValidationError({ node_errors: {
            41: { class_type: "SceneApplyLora", dependent_outputs: [9999], errors: [
                { type: "value_not_in_list", extra_info: { input_name: "lora_name", received_value: "removed.safetensors" } },
                { type: "value_bigger_than_max", extra_info: { input_name: "strength_model", received_value: 9, max: 4 } },
            ] },
        } }, { output: { 41: { class_type: "SceneApplyLora", inputs: {} } }, workflow: { nodes: [{ id: 41, type: "SceneApplyLora", title: "衣装<script>window.injected=true</script>" }] } });
    });
    const dialog = page.locator("#error-dialog");
    let text = await dialog.textContent();
    assert.match(text, /ノード「衣装<script>window.injected=true<\/script>」/u);
    assert.match(text, /LoRA.*removed\.safetensors.*選び直/u); assert.match(text, /モデル強度.*4以下/u);
    assert.doesNotMatch(text, /#41|9999|別タブ/u);
    assert.equal(await dialog.locator("script").count(), 0); assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.screenshot({ path: resolve(tmpdir(), "scene-readable-validation-errors.png") });
    const selection = await page.evaluate(() => {
        const raw = JSON.stringify({ version: 1, categories: { 衣装: [{ label: "夏服", prompt: "summer", weight: "bad" }] } });
        const node = { id: 42, type: "ScenePrompter", title: "Scene Prompt", widgets: [{ name: "prompt_name", value: "服装選択" }, { name: "negative_json", value: raw }], properties: {} };
        const before = JSON.stringify(node);
        const result = window.__scenePromptPopupTestHooks.readPopupSelectionState(node, "negative_json", { items: [] });
        return { unchanged: JSON.stringify(node) === before, result };
    });
    assert.deepEqual(selection, { unchanged: true, result: null });
    text = await dialog.textContent();
    assert.match(text, /ノード「服装選択」.*ネガティブ候補/u); assert.match(text, /カテゴリ「衣装」.*候補「夏服」.*強度.*数値/u); assert.match(text, /開き直/u);
    const matrix = await page.evaluate(() => {
        const raw = JSON.stringify({ version: 1, sets: [{ row_id: "r", name: "夜の森", path_label: "夜の森", positive_json: "{broken" }] });
        const node = { id: 43, type: "SceneMatrix", title: "背景セット", widgets: [{ name: "matrix_json", value: raw }], properties: { scene_matrix_json: raw }, widgets_values: [raw] };
        window.__scenePromptPopupTestHooks.openSceneMatrixLinesPopup(node);
        return [node.widgets[0].value, node.properties.scene_matrix_json, node.widgets_values[0]].every(value => value === raw);
    });
    assert.equal(matrix, true, "invalid Matrix data is not deleted or replaced");
    text = await dialog.textContent();
    assert.match(text, /ノード「背景セット」.*Matrix行/u); assert.match(text, /Matrix行「夜の森」: ポジティブ候補:.*JSONとして読み取れません/u);
    await page.evaluate(async () => {
        const raw = JSON.stringify({ version: 1, sets: [{ row_id: "r", name: "初期行", path_label: "初期行", negative_json: "{broken" }] });
        const node = { id: 46, type: "SceneMatrix", title: "読み込み中の背景", widgets: [{ name: "matrix_json", value: raw }], properties: { scene_matrix_json: raw }, widgets_values: [raw] };
        window.__scenePromptPopupTestHooks.scheduleAttachSceneNode(node, "SceneMatrix");
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    text = await dialog.textContent();
    assert.match(text, /ノード「読み込み中の背景」.*初期化できませんでした/u); assert.match(text, /Matrix行「初期行」.*ネガティブ候補/u);
    await page.evaluate(async () => {
        const original = window.api.fetchApi;
        window.api.fetchApi = async (url, options) => url === "/scene_presets/save"
            ? new Response(JSON.stringify({ error: "Preset「夜のPreset」内のノード「光源」でモデルの接続がありません。モデルを接続してください。", node_id: "child" }), { status: 400 }) : original(url, options);
        try {
            await window.__scenePromptPopupTestHooks.saveScenePreset({ id: 44, type: "ScenePresetOutput", graph: window.app.graph,
                widgets: [{ name: "preset_id", value: "night" }, { name: "preset_name", value: "夜のPreset" }] });
        } finally { window.api.fetchApi = original; }
    });
    text = await dialog.textContent();
    assert.match(text, /^Preset「夜のPreset」を保存できませんでした/u);
    assert.match(text, /Preset「夜のPreset」内のノード「光源」でモデルの接続がありません。モデルを接続してください。/u, "precise backend context remains intact");
    await page.evaluate(async () => {
        const original = window.api.fetchApi;
        window.__scenePresetListFixture = { presets: [{ metadata: { preset_id: "night", name: "夜のPreset" } }], errors: [] };
        window.api.fetchApi = async (url, options) => url.includes("/scene_presets/load")
            ? new Response(JSON.stringify({ error: "fixture network offline" }), { status: 503 }) : original(url, options);
        const node = { id: 45, type: "ScenePresetReference", title: "夜の参照", graph: window.app.graph, properties: {}, widgets: [{ name: "preset_id", value: "night" }] };
        window.app.graph._nodes.push(node);
        try { await window.__scenePromptPopupTestHooks.openScenePresetEditor(node); }
        finally { window.api.fetchApi = original; }
    });
    text = await dialog.textContent();
    assert.match(text, /Preset「夜のPreset」.*夜の参照.*開けませんでした/u);
    assert.match(text, /fixture network offline/u); assert.doesNotMatch(text, /破損/u, "unknown transport failures are not misdiagnosed as corrupt data");
    await page.close();
    console.log("Readable Scene validation, candidate/Matrix context, named Preset errors and text-only dialogs passed");
}
