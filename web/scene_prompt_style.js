export function injectStyle() {
    const style = document.getElementById("scene-prompt-style") || document.createElement("style");
    style.id = "scene-prompt-style";
    style.textContent = `
        .pc-popup {
            position: fixed;
            z-index: 99999;
            box-sizing: border-box;
            min-width: 420px;
            min-height: 180px;
            max-width: calc(100vw - 24px);
            max-height: calc(100vh - 24px);
            display: flex;
            flex-direction: column;
            gap: 8px;
            overflow: hidden;
            resize: both;
            padding: 8px;
            border: 1px solid #4a505b;
            border-radius: 7px;
            background: #202329;
            color: #e7e7e7;
            box-shadow: 0 14px 36px rgba(0, 0, 0, .55);
            font: 12px/1.38 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .pc-popup-head {
            display: grid;
            grid-template-columns: auto minmax(0, 1fr) auto;
            align-items: center;
            gap: 7px;
            min-width: 0;
            padding-bottom: 3px;
            border-bottom: 1px solid #303640;
            cursor: move;
            user-select: none;
        }
        .pc-popup-grip {
            color: #9aa4b5;
            font-size: 14px;
            line-height: 1;
        }
        .pc-popup-title {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-weight: 700;
            color: #fff;
        }
        .pc-popup-actions {
            display: flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
        }
        .pc-toolbar {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 6px;
            min-width: 0;
        }
        .pc-button {
            border: 1px solid #454b55;
            border-radius: 4px;
            background: #2c3038;
            color: #e7e7e7;
            cursor: pointer;
            font-size: 12px;
            line-height: 1.15;
            padding: 5px 9px;
            white-space: nowrap;
        }
        .pc-button:hover {
            background: #373d47;
        }
        .pc-button.pc-on {
            background: #244832;
            border-color: #4d9b63;
            color: #effff3;
        }
        .pc-button.pc-back-button {
            width: 100%;
            margin-bottom: 8px;
            border-color: #555b66;
            background: #30343b;
            color: #e2e4ea;
            text-align: left;
        }
        .pc-button.pc-back-button:hover {
            background: #3a3f48;
        }
        .pc-searchbox {
            box-sizing: border-box;
            width: 100%;
            min-width: 0;
            border: 1px solid #454b55;
            border-radius: 4px;
            background: #15171c;
            color: #f0f0f0;
            font-size: 12px;
            padding: 7px 9px;
            outline: none;
        }
        .pc-searchbox:focus {
            border-color: #6e90d8;
        }
        .pc-popup-list {
            box-sizing: border-box;
            flex: 1 1 0;
            min-height: 0;
            overflow: auto;
            border: 1px solid #363c46;
            border-radius: 5px;
            background: #181b20;
            padding: 8px;
        }
        .pc-popup.pc-fit-content .pc-popup-list {
            flex: 0 1 auto;
            max-height: calc(100vh - 178px);
        }
        .pc-popup-category-list {
            display: grid;
            grid-template-columns: minmax(0, 1fr);
            grid-auto-rows: min-content;
            align-content: start;
            gap: 7px;
        }
        .pc-popup-category-list .pc-button {
            width: 100%;
            min-height: 27px;
            text-align: left;
            white-space: normal;
            overflow-wrap: anywhere;
        }
        .pc-scene-notification {
            position: fixed;
            z-index: 100000;
            right: 18px;
            bottom: 18px;
            max-width: min(460px, calc(100vw - 36px));
            padding: 9px 12px;
            border: 1px solid #4d9b63;
            border-radius: 5px;
            background: #183a26;
            color: #effff3;
            box-shadow: 0 10px 24px rgba(0, 0, 0, .42);
            font: 12px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .pc-empty {
            color: #aab3c4;
            padding: 7px 4px;
        }
        .pc-selected-heading {
            margin: 8px 2px 5px;
            color: #dfe8f5;
            font-weight: 700;
        }
        .pc-selected-heading:first-child {
            margin-top: 2px;
        }
        .pc-saved-heading {
            margin: 2px 2px 6px;
            color: #e7d6ff;
            font-weight: 800;
        }
        .pc-saved-prompt {
            box-sizing: border-box;
            width: 100%;
            display: block;
            margin-bottom: 5px;
            padding: 7px 8px;
            border: 1px solid #7c5ab8;
            border-radius: 5px;
            background: #382750;
            color: #f3ecff;
            text-align: left;
            cursor: pointer;
        }
        .pc-saved-prompt:hover {
            background: #473165;
        }
        .pc-saved-prompt.pc-on {
            background: #53357a;
            border-color: #a481e5;
        }
        .pc-saved-title {
            font-weight: 700;
            overflow-wrap: anywhere;
        }
        .pc-saved-desc {
            margin-top: 3px;
            color: #cdbce8;
            font-size: 11.5px;
            overflow-wrap: anywhere;
        }
        .pc-chip-list {
            display: flex;
            flex-wrap: wrap;
            align-items: flex-start;
            gap: 5px;
            margin: 3px 0 3px;
            min-width: 0;
        }
        .pc-selected-chip {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            max-width: 100%;
            padding: 5px 8px;
            border: 1px solid #4d9b63;
            border-radius: 5px;
            background: #244832;
            color: #effff3;
            cursor: pointer;
            line-height: 1.2;
            white-space: nowrap;
        }
        .pc-selected-chip:hover {
            background: #2e5d3f;
        }
        .pc-selected-chip.pc-off {
            border-color: #4a505b;
            background: #252932;
            color: #d8dce7;
        }
        .pc-selected-chip input {
            margin: 0;
        }
        .pc-selected-chip span {
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .pc-weight-control {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            min-width: 0;
        }
        .pc-weight-label {
            color: #b8c2d4;
            font-size: 11px;
            line-height: 1;
            white-space: nowrap;
        }
        .pc-weight-input {
            box-sizing: border-box;
            width: 56px;
            min-width: 56px;
            height: 22px;
            border: 1px solid #4b5360;
            border-radius: 4px;
            background: #15181d;
            color: #f3f3f3;
            padding: 2px 4px;
            font: 12px/1.2 Consolas, "Cascadia Mono", monospace;
        }
        .pc-weight-input:disabled {
            opacity: .45;
            cursor: not-allowed;
        }
        .pc-candidate-weight {
            margin-top: 6px;
        }
        .pc-selected-chip .pc-weight-label {
            color: #c8f2d3;
        }
        .pc-selected-chip.pc-off .pc-weight-label {
            color: #aab3c4;
        }
        .pc-selected-chip .pc-weight-input {
            width: 50px;
            min-width: 50px;
            height: 20px;
        }
        .pc-preview-chip {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            max-width: 100%;
            padding: 5px 8px;
            border: 1px solid #405f92;
            border-radius: 5px;
            background: #22324c;
            color: #edf4ff;
            line-height: 1.2;
            white-space: nowrap;
        }
        .pc-preview-chip span {
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .pc-form {
            display: grid;
            gap: 8px;
            min-width: 0;
        }
        .pc-form label {
            display: grid;
            gap: 4px;
            color: #d8dce7;
            font-weight: 600;
        }
        .pc-form input,
        .pc-form select,
        .pc-form textarea {
            box-sizing: border-box;
            width: 100%;
            min-width: 0;
            border: 1px solid #3f4652;
            border-radius: 5px;
            background: #15181d;
            color: #f3f3f3;
            padding: 7px 8px;
            font: 13px/1.38 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .pc-form select {
            cursor: pointer;
        }
        .pc-form input[list]::-webkit-calendar-picker-indicator {
            opacity: .75;
        }
        .pc-form textarea {
            min-height: 90px;
            resize: vertical;
        }
        .pc-form-note {
            color: #aab3c4;
            font-size: 12px;
        }
        .pc-error {
            color: #ffb2b2;
            min-height: 16px;
        }
        .pc-error:empty {
            display: none;
        }
        .pc-candidate {
            box-sizing: border-box;
            width: 100%;
            display: grid;
            grid-template-columns: auto minmax(0, 1fr);
            gap: 5px 8px;
            margin-bottom: 8px;
            padding: 8px 9px;
            border: 1px solid #303640;
            border-radius: 5px;
            background: #252932;
            cursor: pointer;
            min-width: 0;
        }
        .pc-candidate:hover {
            background: #303641;
        }
        .pc-candidate.pc-selected-item {
            background: #244832;
            border-color: #4d9b63;
        }
        .pc-candidate.pc-selected-item:hover {
            background: #2e5d3f;
        }
        .pc-candidate input {
            margin-top: 2px;
        }
        .pc-candidate-main {
            min-width: 0;
        }
        .pc-candidate-title {
            color: #f3f3f3;
            font-weight: 600;
            overflow-wrap: anywhere;
        }
        .pc-candidate-path {
            margin-top: 2px;
            color: #9db8ec;
            font-size: 11px;
            overflow-wrap: anywhere;
        }
        .pc-candidate-prompt {
            margin-top: 3px;
            color: #d8dce7;
            font: 11px/1.35 Consolas, "Cascadia Mono", monospace;
            overflow-wrap: anywhere;
            word-break: break-word;
        }
        .pc-candidate-desc {
            margin-top: 3px;
            color: #aeb6c3;
            font-size: 11.5px;
            overflow-wrap: anywhere;
        }
        .pc-candidate-actions {
            margin-top: 6px;
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 6px;
        }
        .pc-part-row {
            box-sizing: border-box;
            display: grid;
            grid-template-columns: auto minmax(0, 1fr) auto;
            align-items: center;
            gap: 7px;
            margin-bottom: 6px;
            padding: 7px 8px;
            border: 1px solid #303640;
            border-radius: 5px;
            background: #252932;
        }
        .pc-part-row.pc-on {
            background: #244832;
            border-color: #4d9b63;
        }
        .pc-part-text {
            min-width: 0;
            overflow-wrap: anywhere;
            font: 12px/1.35 Consolas, "Cascadia Mono", monospace;
            color: #edf4ff;
        }
        .pc-part-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin: 0 0 8px;
        }
        .pc-search-heading {
            margin: 10px 2px 6px;
            color: #dfe8f5;
            font-weight: 800;
        }
        .pc-search-heading:first-child {
            margin-top: 2px;
        }
        .pc-button.pc-search-path {
            box-sizing: border-box;
            display: block;
            width: 100%;
            margin-bottom: 7px;
            text-align: left;
            white-space: normal;
        }
        .pc-search-path-title {
            color: #f3f3f3;
            font-weight: 700;
            overflow-wrap: anywhere;
        }
        .pc-search-path-meta {
            margin-top: 3px;
            color: #9db8ec;
            font-size: 11px;
            overflow-wrap: anywhere;
        }
        .dom-widget:has(textarea[placeholder="category_order"]) {
            display: none !important;
            pointer-events: none !important;
            visibility: hidden !important;
        }
    `;
    if (!style.parentNode) {
        document.head.appendChild(style);
    }
}
