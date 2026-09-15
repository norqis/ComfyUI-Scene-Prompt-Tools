const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "web", "scene_prompt_ui.js"), "utf8");

function functionSource(name) {
    const asyncStart = source.indexOf(`async function ${name}(`);
    const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `Missing function: ${name}`);
    const bodyStart = source.indexOf(") {", start);
    let depth = 0;
    for (let index = bodyStart + 2; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        if (source[index] === "}") {
            depth -= 1;
            if (depth === 0) return source.slice(start, index + 1);
        }
    }
    throw new Error(`Unclosed function: ${name}`);
}

function install(context, names) {
    vm.createContext(context);
    for (const name of names) vm.runInContext(functionSource(name), context);
}

function runWidget(value) {
    return { name: "run_id", value };
}

function testRunRebindStaysInItsWorkflow() {
    const workflowA = { path: "workflows/A.json" };
    const workflowB = { path: "workflows/B.json" };
    const graphA = {};
    const replacementA = { id: 41, graph: graphA, widgets: [runWidget("run-a")] };
    graphA.getNodeById = () => replacementA;
    const context = {
        Map, Object, Number, String,
        app: { graph: graphA, extensionManager: { workflow: { activeWorkflow: workflowA } } },
        sceneBatchRunsById: new Map(),
        sceneBatchDetachedRuns: new Map(),
        findWidget(node, name) { return node.widgets.find((widget) => widget.name === name); },
    };
    install(context, ["sceneBatchNodeRunId", "sceneWorkflowManager", "sceneActiveWorkflow", "sceneWorkflowsMatch", "sceneBatchRunForNode", "sceneNodeForRun", "rebindSceneBatchRunNode"]);

    const run = { runId: "run-a", nodeId: 41, node: { id: 41, graph: {}, widgets: [runWidget("run-a")] }, graph: {}, workflow: workflowA };
    context.sceneBatchRunsById.set(run.runId, run);
    assert.equal(context.sceneNodeForRun(run), replacementA);
    assert.equal(run.node, replacementA);

    context.sceneBatchRunsById.delete(run.runId);
    context.sceneBatchDetachedRuns.set(run.runId, run);
    replacementA.widgets[0].value = "";
    assert.equal(
        context.sceneBatchRunForNode(replacementA),
        run,
        "a stopped run remains visible after its queue-only controls are cleared",
    );
    assert.equal(context.sceneNodeForRun(run), replacementA);

    const graphB = {};
    const sameIdB = { id: 41, graph: graphB, widgets: [runWidget("run-a")] };
    graphB.getNodeById = () => sameIdB;
    context.app.graph = graphB;
    context.app.extensionManager.workflow.activeWorkflow = workflowB;
    assert.equal(context.sceneBatchRunForNode(sameIdB), null);
    assert.equal(context.rebindSceneBatchRunNode(sameIdB), null);
    assert.equal(run.node, replacementA);
}

function testStaleStopLabelCannotRequeue() {
    let resetCount = 0;
    let createCount = 0;
    const context = {
        sceneBatchRunForNode() { return null; },
        sceneBatchRunStatus() { return "idle"; },
        sceneBatchNodeRunId() { return "finished-run"; },
        resetSceneExpandRunControls() { resetCount += 1; },
        updateSceneExpandButton() {},
        createSceneBatchRun() { createCount += 1; },
    };
    install(context, ["startSceneBatchRun"]);
    context.startSceneBatchRun({});
    assert.equal(resetCount, 1);
    assert.equal(createCount, 0);
}

function testStoppingRunClearsQueueControlsImmediately() {
    const node = {
        id: 67,
        graph: {},
        widgets: [
            { name: "current_index", value: 19 },
            { name: "run_id", value: "stopped-run" },
        ],
    };
    const run = {
        runId: "stopped-run",
        nodeId: 67,
        node,
        graph: node.graph,
        waiting: true,
        currentPromptId: "prompt-running",
    };
    const context = {
        Map, Set, String, Object,
        sceneBatchRun: run,
        sceneBatchRunsById: new Map([[run.runId, run]]),
        sceneBatchDetachedRuns: new Map(),
        sceneBatchFinalizingRuns: new Set(),
        sceneBatchPendingReleases: new Map(),
        sceneBatchPendingRuns: [],
        findWidget(target, name) { return target?.widgets?.find((widget) => widget.name === name); },
        sceneNodeForRun() { return node; },
        cancelSceneBatchRunPreparation() {},
        rememberDetachedSceneBatchRun(target) { context.sceneBatchDetachedRuns.set(target.runId, target); },
        rememberPendingSceneBatchRelease() {},
        clearPendingSceneBatchReleasesForRun() {},
        releaseSceneBatchPlan() {},
        activateNextSceneBatchRun() {},
        resetSceneExpandRunControls(target) {
            target.widgets.find((widget) => widget.name === "current_index").value = 0;
            target.widgets.find((widget) => widget.name === "run_id").value = "";
        },
        statuses: [],
        updateSceneExpandButton(target) {
            context.statuses.push(context.sceneBatchRunStatus(context.sceneBatchRunForNode(target)));
        },
    };
    install(context, ["sceneBatchNodeRunId", "sceneBatchRunForNode", "sceneBatchRunStatus", "stopSceneBatchRun"]);
    context.stopSceneBatchRun();
    assert.equal(node.widgets[0].value, 0, "Stop clears the stale selected index before normal Queue can serialize it");
    assert.equal(node.widgets[1].value, "", "Stop clears the continuous run marker before normal Queue");
    assert.equal(context.sceneBatchDetachedRuns.get(run.runId), run, "the submitted backend prompt stays tracked for safe cleanup");
    assert.equal(context.statuses.at(-1), "stopping", "clearing queue controls does not hide the stopping state");
    run.releaseBlocked = true;
    assert.equal(context.sceneBatchRunStatus(run), "blocked", "a failed stop reconciliation can be retried from the button");
}

function testForeignPreviewIsRemovedFromActiveTab() {
    const workflowA = { path: "workflows/A.json" };
    const workflowB = { path: "workflows/B.json" };
    const foreignImage = { src: "http://localhost/view?filename=a.png&type=output&subfolder=" };
    const ownImage = { src: "http://localhost/view?filename=b.png&type=output&subfolder=" };
    const node = { id: 7, type: "ScenePresetReference", imgs: [ownImage, foreignImage], setDirtyCanvas() {} };
    const context = {
        Map, Set, Object, Array, Number, String, URL,
        globalThis: { location: { href: "http://localhost/" } },
        NODE_NAMES: new Set(["ScenePresetReference", "SceneSaveImage"]),
        SCENE_SAVE_IMAGE_NODE_NAMES: new Set(["SceneSaveImage"]),
        scenePromptSubmissionsById: new Map([["prompt-a", { workflow: workflowA }]]),
        scenePromptIdFromValue(detail) { return detail?.prompt_id || ""; },
        app: {
            graph: { getNodeById: () => node, setDirtyCanvas() {} },
            canvas: { setDirty() {} },
            extensionManager: { workflow: { activeWorkflow: workflowB } },
        },
    };
    install(context, ["sceneWorkflowManager", "sceneActiveWorkflow", "sceneWorkflowsMatch", "sceneEventRootNodeId", "sceneEventSubmission", "sceneEventTargetsActiveWorkflow", "sceneNodeFromEvent", "sceneImageMatchesRef", "removeForeignSceneEventImages", "appendSceneSavePreview"]);
    context.appendSceneSavePreview({ prompt_id: "prompt-a", node: "7:expanded", output: { images: [{ filename: "a.png", type: "output", subfolder: "" }] } });
    assert.equal(node.imgs.length, 1);
    assert.equal(node.imgs[0], ownImage);
}

function testForeignProgressCannotLightActiveTab() {
    const workflowA = { path: "workflows/A.json" };
    const workflowB = { path: "workflows/B.json" };
    const node = { id: 9, progress: { value: 50 }, execute_triggered: 1, setDirtyCanvas() {} };
    const context = {
        Map, Set, Object, Array, Number, String,
        sceneExecutingPromptId: "",
        scenePromptSubmissionsById: new Map([["prompt-a", { workflow: workflowA }], ["prompt-b", { workflow: workflowB }]]),
        sceneProgressNodeIdsByPromptId: new Map(),
        scenePromptIdFromValue(detail) { return detail?.prompt_id || ""; },
        app: {
            graph: { _nodes: [node], getNodeById: () => node, setDirtyCanvas() {} },
            canvas: { setDirty() {} },
            extensionManager: { workflow: { activeWorkflow: workflowB } },
        },
    };
    install(context, ["sceneWorkflowManager", "sceneActiveWorkflow", "sceneWorkflowsMatch", "sceneProgressNodeIds", "clearForeignSceneProgressState", "receiveSceneProgressState"]);
    context.receiveSceneProgressState({ prompt_id: "prompt-a", nodes: { "9": { node_id: "9", value: 50, max: 100 } } });
    assert.equal(node.progress, undefined);
    assert.equal(node.execute_triggered, 0);

    node.progress = { value: 10 };
    node.execute_triggered = 1;
    context.receiveSceneProgressState({ prompt_id: "prompt-b", nodes: { "9": { node_id: "9", value: 10, max: 100 } } });
    assert.deepEqual(node.progress, { value: 10 });
    assert.equal(node.execute_triggered, 1);
}

testRunRebindStaysInItsWorkflow();
testStaleStopLabelCannotRequeue();
testStoppingRunClearsQueueControlsImmediately();
testForeignPreviewIsRemovedFromActiveTab();
testForeignProgressCannotLightActiveTab();
console.log("Scene Prompt multi-workflow runtime tests passed.");
