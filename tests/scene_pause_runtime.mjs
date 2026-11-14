import assert from 'node:assert/strict';
import http from 'node:http';

// Every image waits inside the real CPU executor. Pausing therefore has to
// finish the owned prompt, save its PNG and observe execution_success.
export async function verifySceneBatchPause(page, url) {
    const prompts = [], requests = [], callbacks = [], frees = [];
    let finalResponse;
    const callbackServer = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        callbacks.push({ phase: request.url.slice(1), body: JSON.parse(Buffer.concat(chunks).toString()) });
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/last') finalResponse = response;
        else response.end('{}');
    });
    await new Promise(done => callbackServer.listen(0, '127.0.0.1', done));
    const callbackUrl = `http://127.0.0.1:${callbackServer.address().port}`;
    const record = request => {
        const path = new URL(request.url()).pathname.replace(/^\/api/u, '');
        if (path === '/interrupt' || path.startsWith('/scene_prompt/runs/') || path === '/scene_prompt/gpu/free') {
            requests.push({ path, body: request.method() === 'POST' ? request.postDataJSON() : null });
        }
    };
    const queue = async route => {
        prompts.push(route.request().postDataJSON());
        await route.continue();
    };
    const free = async route => {
        const response = await route.fetch();
        let deliver;
        const delivered = new Promise(done => { deliver = done; });
        frees.push({ response, deliver });
        await delivered;
        await route.fulfill({ response });
    };
    const api = async (path, body) => {
        const response = await fetch(`${url}${path}`, body === undefined ? undefined : {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const data = await response.json();
        assert(response.ok, `${path}: ${JSON.stringify(data)}`);
        return data;
    };
    const waitFor = async (check, message) => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
            const result = await check();
            if (result) return result;
            await new Promise(done => setTimeout(done, 40));
        }
        assert.fail(message);
    };
    const firstGate = (await api('/scene_test/pause_images')).started;
    const release = index => api('/scene_test/pause_images/release', { index });
    const started = count => waitFor(async () => (await api('/scene_test/pause_images')).started === count,
        `CPU image ${count} did not enter its execution gate`);
    const finishFree = async (id, count, baseline, terminal = false) => {
        const pending = await waitFor(() => frees[count - 1], `Pause ${count} did not finish its real worker release`);
        assert.equal(pending.response.status(), 200, await pending.response.text());
        await waitControls(id, terminal ? { disabled: true } : { pause: '停止中...', disabled: true });
        if (terminal) {
            const state = await controls(id);
            assert.notEqual(state.main, '連続生成', 'final cleanup remains visible until worker release acknowledgement');
            assert.notEqual(state.pause, '再開', 'a completed final item is never resumable');
        }
        const released = await api('/scene_test/pause_release');
        const completed = released.events.slice(baseline);
        const operations = completed.map(event => event.operation);
        assert(operations.includes('reset') && operations.includes('unload') && operations.includes('cache'),
            `pause must reset executor caches and unload models: ${JSON.stringify(completed)}`);
        assert(operations.indexOf('reset') < operations.indexOf('unload'));
        assert(operations.lastIndexOf('cache') > operations.indexOf('unload'));
        assert(completed.every(event => event.thread !== released.main_thread), 'ComfyUI worker performs the release');
        pending.deliver();
        await waitControls(id, terminal
            ? { main: '連続生成', pause: '一時停止', disabled: true, savedRunId: '' }
            : { pause: '再開', disabled: false });
    };
    const click = async (id, role) => {
        const point = await page.evaluate(({ id, role }) => {
            const node = window.app.graph.getNodeById(id), canvas = window.app.canvas;
            canvas.draw(true, true);
            const widget = node.widgets.find(widget => widget.sceneRole === role);
            const rect = canvas.canvas.getBoundingClientRect();
            return { x: rect.left + (node.pos[0] + node.size[0] / 2 + canvas.ds.offset[0]) * canvas.ds.scale,
                y: rect.top + (node.pos[1] + widget.last_y + window.LiteGraph.NODE_WIDGET_HEIGHT / 2 + canvas.ds.offset[1]) * canvas.ds.scale,
                disabled: widget.disabled };
        }, { id, role });
        assert.equal(point.disabled, false, `${role} must be enabled before the native pointer click`);
        const viewport = page.viewportSize();
        assert(point.x > 0 && point.x < viewport.width && point.y > 0 && point.y < viewport.height,
            `${role} must be visible: ${JSON.stringify(point)}`);
        await page.mouse.click(point.x, point.y);
    };
    const controls = id => page.evaluate(id => {
        const node = window.app.graph.getNodeById(id), run = window.__sceneSeedRuntimeTest.batchRun();
        const widget = role => node.widgets.find(widget => widget.sceneRole === role);
        const original = window.__scenePauseOriginal;
        return { main: widget('expand_run_all').name, pause: widget('expand_pause').name,
            disabled: widget('expand_pause').disabled, runId: run?.runId || '', handle: run?.runHandle || '',
            nextIndex: run?.nextIndex, waiting: run?.waiting, requested: run?.pauseRequested,
            sameRun: !!run && run === original?.run, sameSnapshot: !!run && run.cachedPrompt === original?.snapshot,
            savedRunId: node.widgets.find(widget => widget.name === 'run_id').value };
    }, id);
    const waitControls = (id, expected) => waitFor(async () => {
        const state = await controls(id);
        return Object.entries(expected).every(([key, value]) => state[key] === value) && state;
    }, `Pause controls did not become ${JSON.stringify(expected)}`);
    const saved = async (ids, ordinal) => {
        const promptId = await waitFor(async () => page.evaluate(ordinal => window.__scenePauseEvents.successes[ordinal], ordinal),
            `Image ${ordinal} did not report real execution_success`);
        const history = await waitFor(async () => {
            const entry = (await api(`/history/${promptId}`))[promptId];
            return entry?.status?.completed && entry;
        }, `Image ${ordinal} did not persist history`);
        assert.equal(history.status.status_str, 'success', JSON.stringify(history.status));
        assert.deepEqual(history.outputs[String(ids.image)].text, ['native_pause_original', 'native_pause_negative']);
        const images = history.outputs[String(ids.save)].images;
        assert.equal(images.length, 1);
        const response = await fetch(`${url}/view?${new URLSearchParams(images[0])}`);
        assert(response.ok, 'the actual saved CPU image is available');
        const png = Buffer.from(await response.arrayBuffer());
        assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        assert.equal(png.readUInt32BE(16), 16);
        assert.equal(png.readUInt32BE(20), 16);
        return { promptId, image: images[0] };
    };
    const fixture = async (count, withCallbacks) => page.evaluate(async ({ count, callbackUrl, withCallbacks }) => {
        const { api } = await import('/scripts/api.js');
        const app = window.app; app.graph.clear();
        const add = (type, position = [2200, 80]) => {
            const node = window.LiteGraph.createNode(type); app.graph.add(node); node.pos = position; return node;
        };
        const set = (node, name, value) => { node.widgets.find(widget => widget.name === name).value = value; };
        const link = (from, slot, to, name) => {
            if (!to.inputs.some(input => input.name === name)) {
                to.addInput(name, from.outputs[slot].type, { widget: { name } });
            }
            if (!from.connect(slot, to, to.inputs.findIndex(input => input.name === name))) {
                throw new Error(`Cannot connect pause fixture ${name}`);
            }
        };
        const source = add('ScenePrompter'), counter = add('ScenePromptCounter');
        const expand = add('ScenePrompterExpand', [180, 60]), image = add('TestScenePauseImage'), save = add('SceneSaveImage');
        set(source, 'positive_base', 'native_pause_original'); set(source, 'negative_base', 'native_pause_negative');
        set(counter, 'count', count); set(expand, 'timestamp_dir', false); set(save, 'path', 'native-pause');
        link(source, 0, counter, 'scene_prompt'); link(counter, 0, expand, 'scene_prompt');
        link(expand, 0, image, 'positive'); link(expand, 1, image, 'negative'); link(expand, 3, image, 'seed');
        link(image, 0, save, 'images'); link(expand, 2, save, 'scene_info');
        if (withCallbacks) for (const phase of ['first', 'each', 'last']) {
            const callback = add('ScenePromptCallbackRequest');
            set(callback, 'method', 'POST'); set(callback, 'url', `${callbackUrl}/${phase}`);
            set(callback, 'body_type', 'json'); set(callback, 'text', '{"index":"{exec_current_count}"}');
            link(callback, 0, expand, `callback_${phase}`);
        }
        const successes = [], errors = [];
        const success = ({ detail }) => successes.push(detail.prompt_id);
        const failure = ({ detail }) => errors.push(detail);
        api.addEventListener('execution_success', success); api.addEventListener('execution_error', failure);
        window.__scenePauseEvents = { successes, errors, cleanup: () => {
            api.removeEventListener('execution_success', success); api.removeEventListener('execution_error', failure);
        } };
        app.canvas.ds.scale = 1; app.canvas.ds.offset = [0, 0];
        await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
        app.canvas.draw(true, true);
        return { source: source.id, count: counter.id, expand: expand.id, image: image.id, save: save.id };
    }, { count, callbackUrl, withCallbacks });
    page.on('request', record);
    await page.route('**/prompt', queue);
    await page.route('**/scene_prompt/gpu/free', free);
    const previousViewport = page.viewportSize();
    await page.setViewportSize({ width: 1440, height: 1200 });
    try {
        const ids = await fixture(3, true);
        const idle = await controls(ids.expand);
        assert.deepEqual({ main: idle.main, pause: idle.pause, disabled: idle.disabled },
            { main: '連続生成', pause: '一時停止', disabled: true });
        assert.equal(await page.evaluate(id => {
            const widgets = window.app.graph.getNodeById(id).widgets;
            return widgets.findIndex(widget => widget.sceneRole === 'expand_pause')
                - widgets.findIndex(widget => widget.sceneRole === 'expand_run_all');
        }, ids.expand), 1, 'pause is immediately below the continuous generation button');
        await click(ids.expand, 'expand_run_all');
        await started(firstGate + 1);
        const owner = await controls(ids.expand);
        assert.equal(owner.main, '停止'); assert(owner.runId); assert(owner.handle);
        await page.evaluate(() => {
            const run = window.__sceneSeedRuntimeTest.batchRun();
            window.__scenePauseOriginal = { run, snapshot: run.cachedPrompt };
        });
        const outputs = [];
        let terminalReleaseBaseline;
        for (let index = 0; index < 3; index++) {
            const releaseBaseline = (await api('/scene_test/pause_release')).events.length;
            await click(ids.expand, 'expand_pause');
            await waitControls(ids.expand, { pause: '停止中...', disabled: true, requested: true });
            assert.equal(prompts.length, index + 1, 'pause does not queue another prompt while the current image runs');
            await release(firstGate + index);
            outputs.push(await saved(ids, index));
            if (index === 2) { terminalReleaseBaseline = releaseBaseline; break; }
            await finishFree(ids.expand, index + 1, releaseBaseline);
            const paused = await waitControls(ids.expand, { main: '停止', pause: '再開', disabled: false,
                waiting: false, requested: true, nextIndex: index + 1 });
            assert.equal(paused.runId, owner.runId); assert.equal(paused.handle, owner.handle);
            assert.equal(paused.sameRun, true); assert.equal(paused.sameSnapshot, true);
            await page.waitForTimeout(600);
            assert.equal(prompts.length, index + 1, 'paused continuous generation submits no next /prompt after successful save');
            assert.equal(callbacks.filter(item => item.phase === 'first').length, 1);
            assert.equal(callbacks.filter(item => item.phase === 'each').length, index + 1);
            assert.equal(callbacks.filter(item => item.phase === 'last').length, 0, 'pause does not dispatch completion callback');
            if (index === 0) await page.evaluate(ids => {
                const app = window.app;
                app.graph.getNodeById(ids.source).widgets.find(widget => widget.name === 'positive_base').value = 'edited_while_paused';
                app.graph.getNodeById(ids.count).widgets.find(widget => widget.name === 'count').value = 9;
            }, ids);
            await click(ids.expand, 'expand_pause');
            await started(firstGate + index + 2);
            const resumed = await controls(ids.expand);
            assert.equal(resumed.pause, '一時停止'); assert.equal(resumed.disabled, false);
            assert.equal(resumed.runId, owner.runId); assert.equal(resumed.handle, owner.handle);
            assert.equal(resumed.sameRun, true); assert.equal(resumed.sameSnapshot, true);
        }
        await waitFor(() => finalResponse, 'completion callback did not start after the final saved image');
        await waitControls(ids.expand, { main: '完了通知中', disabled: true });
        assert.equal(prompts.length, 3, 'final-item pause completes the original three-item snapshot');
        assert.equal(frees.length, 2, 'final callback finishes before the final paused item releases its memory');
        assert.deepEqual(prompts.map(item => item.prompt[String(ids.expand)].inputs.current_index), [0, 1, 2]);
        assert(prompts.every(item => item.prompt[String(ids.expand)].inputs.run_id === owner.runId));
        assert(prompts.every(item => item.prompt[String(ids.expand)].inputs.run_handle === owner.handle));
        assert.equal(new Set(outputs.map(item => item.promptId)).size, 3);
        assert.equal(new Set(outputs.map(item => item.image.filename)).size, 3);
        assert.deepEqual(callbacks.map(item => [item.phase, item.body.index]),
            [['first', '1'], ['each', '1'], ['each', '2'], ['each', '3'], ['last', '3']]);
        finalResponse.end('{}'); finalResponse = null;
        await finishFree(ids.expand, 3, terminalReleaseBaseline, true);
        assert.equal(requests.filter(item => item.path.endsWith('/prepare')).length, 1, 'resuming never prepares another snapshot');
        assert.equal(requests.filter(item => item.path.endsWith('/release') && item.body.run_handle === owner.handle).length, 1);
        assert.deepEqual(await page.evaluate(() => window.__scenePauseEvents.errors), []);
        await page.evaluate(() => window.__scenePauseEvents.cleanup());

        const stopIds = await fixture(2, false);
        await click(stopIds.expand, 'expand_run_all');
        await started(firstGate + 4);
        const stopReleaseBaseline = (await api('/scene_test/pause_release')).events.length;
        await click(stopIds.expand, 'expand_pause');
        await waitControls(stopIds.expand, { pause: '停止中...', disabled: true });
        await release(firstGate + 3);
        await saved(stopIds, 0);
        await finishFree(stopIds.expand, 4, stopReleaseBaseline);
        const stoppedOwner = await waitControls(stopIds.expand, { pause: '再開', disabled: false });
        await click(stopIds.expand, 'expand_run_all');
        await waitControls(stopIds.expand, { main: '連続生成', pause: '一時停止', disabled: true, savedRunId: '' });
        await page.waitForTimeout(600);
        assert.equal(prompts.length, 4, 'stopping an already paused run never submits its remaining item');
        assert.equal(requests.filter(item => item.path.endsWith('/release') && item.body.run_handle === stoppedOwner.handle).length, 1);
        assert.deepEqual(await page.evaluate(() => window.__scenePauseEvents.errors), []);
        await page.evaluate(() => window.__scenePauseEvents.cleanup());

        const lastIds = await fixture(1, false);
        await click(lastIds.expand, 'expand_run_all');
        await started(firstGate + 5);
        const lastReleaseBaseline = (await api('/scene_test/pause_release')).events.length;
        await click(lastIds.expand, 'expand_pause');
        await waitControls(lastIds.expand, { pause: '停止中...', disabled: true });
        await release(firstGate + 4);
        await saved(lastIds, 0);
        await finishFree(lastIds.expand, 5, lastReleaseBaseline, true);
        await page.waitForTimeout(600);
        assert.equal(prompts.length, 5, 'final-item pause without callbacks finishes after its memory release');
        assert.equal(requests.filter(item => item.path === '/interrupt').length, 0, 'pause and paused stop never interrupt ComfyUI');
        assert.deepEqual(await page.evaluate(() => window.__scenePauseEvents.errors), []);
        assert.deepEqual(await api('/scene_test/model_executions'), [], 'pause coverage never loads model weights');
        assert.equal(frees.length, 5, 'each actual pause, including final-item completion with or without callbacks, releases memory once');
        console.log('real ComfyUI canvas pause/resume saves CPU images before worker model/cache release, waits for confirmation, retains snapshot/ownership/order across repeated pauses, completes callbacks once and stops paused runs without /interrupt');
    } finally {
        finalResponse?.end('{}');
        for (const pending of frees) pending.deliver();
        const count = (await api('/scene_test/pause_images')).started;
        for (let index = firstGate; index < count; index++) await release(index);
        await page.evaluate(() => {
            window.__scenePauseEvents?.cleanup(); delete window.__scenePauseEvents; delete window.__scenePauseOriginal;
        });
        page.off('request', record);
        await page.unroute('**/prompt', queue);
        await page.unroute('**/scene_prompt/gpu/free', free);
        await page.setViewportSize(previousViewport);
        callbackServer.closeAllConnections();
        await new Promise(done => callbackServer.close(done));
    }
}
