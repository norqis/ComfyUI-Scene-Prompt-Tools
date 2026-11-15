import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

export async function verifyLoraModelFilter(page) {
    const original = await page.evaluate(() => structuredClone(window.__sceneLoraCatalog));
    const bases = ["iLlUsTrIoUs", "Illustrious XL", "ANIMA", "NoobAI", "NoobAI XL", "Pony", "", null];
    const entries = bases.map((base, index) => ({ path: `filter/${index}.safetensors`, size: 100, mtime_ns: 1, base }));
    const hashes = entries.map((_, index) => (index + 1).toString(16).padStart(64, "0"));
    let release, started, pending = false, fail = false;
    const calls = [];
    const handler = async route => {
        const hash = new URL(route.request().url()).searchParams.get("sha256"), index = hashes.indexOf(hash);
        if (index < 0) return route.fallback();
        calls.push(index);
        const base = entries[index].base;
        if (pending) { pending = false; started?.(); await new Promise(done => release = done); }
        if (fail) return route.fulfill({ status: 503, json: { error: "metadata offline" } });
        return route.fulfill({ json: base === null ? { found: false, version: null } : { found: true, version: {
            id: 100 + index, modelId: 90, name: "Filter version", baseModel: base, model: { name: `Filter ${index}` }, trainedWords: [] } } });
    };
    await page.route("**/scene_prompt/civitai/by-hash?*", handler);
    const picker = page.getByRole("dialog", { name: "LoRAを選択", exact: true });
    const open = () => page.evaluate(() => window.__sceneLoraTestNode.widgets.find(widget => widget.sceneRole === "lora_select").callback());
    const paths = () => picker.locator(".pc-lora-path").allTextContents();
    const shown = indexes => indexes.map(index => `filter/${index}.safetensors`);
    const install = async () => page.evaluate(({ entries, hashes }) => {
        window.__sceneLoraCatalog.splice(0, window.__sceneLoraCatalog.length, ...entries.map(({ base, ...item }) => item));
        window.__sceneLoraHashes = Object.fromEntries(entries.map((item,index) => [item.path,hashes[index]]));
    }, { entries, hashes });
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: 1200, height: 1400 });
    await install(); await open();
    await picker.locator(".pc-lora-source").getByText("Local", { exact: true }).waitFor();
    const model = picker.getByRole("combobox", { name: "Base Model", exact: true }), search = picker.getByRole("searchbox");
    assert.deepEqual(await model.locator("option").evaluateAll(nodes => nodes.map(node => node.value)), ["", "Illustrious", "Anima", "NoobAI", "Pony"]);
    assert.equal(await model.inputValue(), ""); assert.deepEqual(await paths(), shown([0,1,2,3,4,5,6,7]));
    const nodeBefore = await page.evaluate(() => JSON.stringify(window.__sceneLoraTestNode.serialize()));
    const resolvedCalls = calls.length;
    for (const [mode, expected] of [["Illustrious",[0,1]],["Anima",[2]],["NoobAI",[3,4]],["Pony",[5]]]) {
        await model.selectOption(mode); assert.deepEqual(await paths(), shown(expected));
    }
    assert.equal(calls.length, resolvedCalls, "cached model filtering never requests metadata");
    await model.selectOption("Illustrious"); await search.fill("1.safetensors"); assert.deepEqual(await paths(), shown([1]));
    await model.selectOption("Anima"); await picker.getByText("該当するLoRAはありません。", { exact: true }).waitFor();
    await search.fill(""); await model.selectOption("");
    assert.deepEqual(await paths(), shown([0,1,2,3,4,5,6,7]));
    for (const width of [1100,360]) {
        await page.setViewportSize({width,height:740});
        assert.equal(await picker.locator(".pc-lora-filters").evaluate(bar => {
            const [search,model]=bar.children,a=search.getBoundingClientRect(),b=model.getBoundingClientRect();
            return a.width>0 && a.right<=b.left && Math.abs(a.y-b.y)<1 && bar.scrollWidth<=bar.clientWidth && b.right<=innerWidth;
        }),true);
    }
    const screenshots = resolve(tmpdir(), "scene-lora-filter-review"); await mkdir(screenshots,{recursive:true});
    await page.screenshot({path:resolve(screenshots,"local-filter-narrow.png")});
    await page.keyboard.press("Escape"); await page.setViewportSize({width:1200,height:1400});
    // Unresolved visible rows remain while requested, then only the mismatching row disappears.
    entries.push({path:"filter/8.safetensors",size:100,mtime_ns:1,base:"Pony"}); hashes.push("9".padStart(64,"0"));
    pending=true; const begins=new Promise(done=>started=done); await install(); await open(); await begins;
    await model.selectOption("Anima"); assert.deepEqual(await paths(),shown([2,8]));
    const sameRow=await picker.locator('.pc-lora-row').filter({hasText:'filter/2.safetensors'}).elementHandle();
    release(); await picker.locator('.pc-lora-row').filter({hasText:'filter/8.safetensors'}).waitFor({state:'detached'});
    assert.equal(await sameRow.evaluate(node=>node.isConnected),true,"resolution removes one row without rebuilding matching rows");
    assert.deepEqual(await paths(),shown([2])); await page.keyboard.press("Escape");
    // A failed resolution stays unknown, retrying successfully may then remove it.
    entries.push({path:"filter/9.safetensors",size:100,mtime_ns:1,base:"Illustrious"}); hashes.push("a".padStart(64,"0")); fail=true;
    await install(); await open();await model.selectOption('Anima');
    const failedRow=picker.locator('.pc-lora-row').filter({hasText:'filter/9.safetensors'});
    await failedRow.getByRole('button',{name:'filter/9.safetensors の詳細確認',exact:true}).getByText('再確認',{exact:true}).waitFor();
    assert.equal(await failedRow.locator('.pc-lora-base-model').textContent(),'取得失敗');
    assert.match(await failedRow.locator('.pc-lora-base-model').getAttribute('title'),/metadata offline/);
    assert.deepEqual(await paths(),shown([2,9]));fail=false;await failedRow.locator('.pc-lora-source').click();await failedRow.waitFor({state:'detached'});
    assert.deepEqual(await paths(),shown([2]));
    // A late reply cannot restore a row/file removed by a later catalog generation.
    await page.keyboard.press('Escape');entries.push({path:'filter/10.safetensors',size:100,mtime_ns:1,base:'Anima'});hashes.push('b'.padStart(64,'0'));
    pending=true;const lateStarted=new Promise(done=>started=done);await install();await open();await lateStarted;
    await model.selectOption('Anima');await page.keyboard.press('Escape');entries.pop();hashes.pop();await install();await open();await model.selectOption('Anima');release();
    await picker.locator('.pc-lora-path').getByText('filter/2.safetensors',{exact:true}).waitFor();
    assert.deepEqual(await paths(),shown([2]));
    assert.equal(await page.evaluate(()=>JSON.stringify(window.__sceneLoraTestNode.serialize())),nodeBefore,'text/model filters and lazy completion never edit model mode, LoRA or other widgets');
    await model.selectOption(''); await search.fill('no matches');await picker.getByText('該当するLoRAはありません。',{exact:true}).waitFor();
    await page.keyboard.press('Escape');await page.unroute("**/scene_prompt/civitai/by-hash?*",handler);
    await page.evaluate(original=>{window.__sceneLoraCatalog.splice(0,window.__sceneLoraCatalog.length,...original);delete window.__sceneLoraHashes;},original);
    await page.setViewportSize(viewport);
    console.log("Local LoRA model filters: all families/aliases, text AND, lazy mismatches, failed retry, stale ownership, empty state and narrow layout passed");
}
