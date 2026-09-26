// ==UserScript==
// @name         Chat Prompt
// @namespace    https://example.com/
// @version      3.0.0
// @description  ChatGPT / DeepSeek Prompt 管理器，支持本地 Prompt、远程 Prompt 集合和远程单 Prompt
// @author       You
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://chat.deepseek.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    /* =========================================================
     * Storage
     * ========================================================= */

    const CONFIG_KEY =
        'prompt_picker_config_v3';

    const REMOTE_CACHE_KEY =
        'prompt_picker_remote_cache_v3';

    const DEFAULT_CONFIG = [
        {
            type: 'local',
            name: '代码审查',
            content:
                '请帮我审查下面的代码，重点检查：\n' +
                '1. 潜在 Bug\n' +
                '2. 性能问题\n' +
                '3. 可维护性\n' +
                '4. 安全问题\n' +
                '5. 给出具体修改建议'
        },
        {
            type: 'local',
            name: '翻译中文',
            content:
                '请把下面的内容翻译成自然、准确的中文，保留原意和专业术语。'
        },
        {
            type: 'local',
            name: '总结',
            content:
                '请总结下面的内容，提炼核心观点、重要事实和待办事项。'
        }
    ];

    /* =========================================================
     * Runtime
     * ========================================================= */

    let picker = null;
    let pickerSearch = null;
    let pickerList = null;

    let pickerItems = [];
    let pickerSelectedIndex = 0;

    let savedEditor = null;
    let savedRange = null;
    let savedSelectionStart = null;
    let savedSelectionEnd = null;

    /*
     * 当前网页生命周期里：
     *
     * 第一次打开 ! / ！ 弹窗：
     * 自动同步一次远程源。
     *
     * 后续打开：
     * 只使用缓存。
     *
     * 要重新同步：
     * 用户点击 ↻。
     */
    let initialRemoteSyncDone = false;

    let remoteSyncRunning = false;

    /* =========================================================
     * Utils
     * ========================================================= */

    function clone(value) {
        return JSON.parse(
            JSON.stringify(value)
        );
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    function isValidType(type) {
        return (
            type === 'local' ||
            type === 'prompts' ||
            type === 'prompt'
        );
    }

    function validateConfig(config) {
        if (!Array.isArray(config)) {
            throw new Error(
                '最外层必须是 JSON Array'
            );
        }

        config.forEach(
            (item, index) => {
                if (
                    !item ||
                    typeof item !== 'object' ||
                    Array.isArray(item)
                ) {
                    throw new Error(
                        `第 ${index + 1} 项必须是 Object`
                    );
                }

                if (!isValidType(item.type)) {
                    throw new Error(
                        `第 ${index + 1} 项 type 必须是 local、prompts 或 prompt`
                    );
                }

                if (
                    typeof item.name !== 'string' ||
                    !item.name.trim()
                ) {
                    throw new Error(
                        `第 ${index + 1} 项 name 不能为空`
                    );
                }

                if (
                    typeof item.content !== 'string'
                ) {
                    throw new Error(
                        `第 ${index + 1} 项 content 必须是字符串`
                    );
                }

                if (
                    item.type !== 'local' &&
                    !item.content.trim()
                ) {
                    throw new Error(
                        `第 ${index + 1} 项 URL 不能为空`
                    );
                }
            }
        );

        return config;
    }

    function normalizeConfig(config) {
        return config.map(item => ({
            type:
                isValidType(item.type)
                    ? item.type
                    : 'local',

            name:
                String(
                    item.name ?? ''
                ).trim(),

            content:
                String(
                    item.content ?? ''
                )
        }));
    }

    /* =========================================================
     * Config
     * ========================================================= */

    function migrateLegacyConfig() {
        const result = [];

        /*
         * 旧版 Local Prompt
         */
        let oldLocal =
            GM_getValue(
                'prompt_picker_local_prompts',
                ''
            );

        if (!oldLocal) {
            oldLocal =
                GM_getValue(
                    'prompt_picker_prompts',
                    ''
                );
        }

        if (oldLocal) {
            try {
                const data =
                    JSON.parse(oldLocal);

                if (
                    data &&
                    typeof data === 'object' &&
                    !Array.isArray(data)
                ) {
                    for (
                        const [name, content]
                        of Object.entries(data)
                    ) {
                        if (
                            typeof content ===
                            'string'
                        ) {
                            result.push({
                                type:
                                    'local',

                                name,

                                content
                            });
                        }
                    }
                }
            } catch (_) {
                // ignore
            }
        }

        /*
         * 旧版 Remote Sources
         */
        const oldRemote =
            GM_getValue(
                'prompt_picker_remote_sources',
                ''
            );

        if (oldRemote) {
            try {
                const sources =
                    JSON.parse(
                        oldRemote
                    );

                if (
                    Array.isArray(
                        sources
                    )
                ) {
                    for (
                        const source
                        of sources
                    ) {
                        if (
                            !source ||
                            typeof source.name !==
                                'string' ||
                            typeof source.url !==
                                'string'
                        ) {
                            continue;
                        }

                        result.push({
                            type:
                                source.type ===
                                'prompt'
                                    ? 'prompt'
                                    : 'prompts',

                            name:
                                source.name,

                            content:
                                source.url
                        });
                    }
                }
            } catch (_) {
                // ignore
            }
        }

        return result;
    }

    function getConfig() {
        const raw =
            GM_getValue(
                CONFIG_KEY,
                ''
            );

        if (raw) {
            try {
                const config =
                    normalizeConfig(
                        JSON.parse(raw)
                    );

                validateConfig(config);

                return config;

            } catch (_) {
                return [];
            }
        }

        /*
         * 自动迁移旧版配置
         */
        const migrated =
            migrateLegacyConfig();

        const config =
            migrated.length
                ? migrated
                : clone(
                    DEFAULT_CONFIG
                );

        saveConfig(config);

        return config;
    }

    function saveConfig(config) {
        GM_setValue(
            CONFIG_KEY,
            JSON.stringify(
                config,
                null,
                2
            )
        );
    }

    /* =========================================================
     * Remote Cache
     * ========================================================= */

    function getRemoteCache() {
        const raw =
            GM_getValue(
                REMOTE_CACHE_KEY,
                '{}'
            );

        try {
            const data =
                JSON.parse(raw);

            if (
                data &&
                typeof data === 'object' &&
                !Array.isArray(data)
            ) {
                return data;
            }

        } catch (_) {
            // ignore
        }

        return {};
    }

    function saveRemoteCache(cache) {
        GM_setValue(
            REMOTE_CACHE_KEY,
            JSON.stringify(cache)
        );
    }

    function getRemoteCacheKey(item) {
        return (
            item.type +
            ':' +
            item.content
        );
    }

    /* =========================================================
     * HTTP
     * ========================================================= */

    function requestRemoteItem(item) {
        return new Promise(
            (resolve, reject) => {

                GM_xmlhttpRequest({
                    method:
                        'GET',

                    url:
                        item.content,

                    timeout:
                        15000,

                    headers: {
                        Accept:
                            item.type ===
                            'prompts'
                                ? 'application/json, text/plain, */*'
                                : 'text/plain, application/json, */*'
                    },

                    onload(response) {
                        if (
                            response.status < 200 ||
                            response.status >= 300
                        ) {
                            reject(
                                new Error(
                                    `HTTP ${response.status}`
                                )
                            );

                            return;
                        }

                        const text =
                            response.responseText ??
                            '';

                        /*
                         * ==============================
                         * type = prompts
                         *
                         * {
                         *   "hello_prompt": "...",
                         *   "review": "..."
                         * }
                         * ==============================
                         */

                        if (
                            item.type ===
                            'prompts'
                        ) {
                            try {
                                const data =
                                    JSON.parse(
                                        text
                                    );

                                if (
                                    !data ||
                                    typeof data !==
                                        'object' ||
                                    Array.isArray(
                                        data
                                    )
                                ) {
                                    throw new Error(
                                        '远程内容必须是 JSON Object'
                                    );
                                }

                                for (
                                    const [
                                        name,
                                        prompt
                                    ]
                                    of Object.entries(
                                        data
                                    )
                                ) {
                                    if (
                                        typeof prompt !==
                                        'string'
                                    ) {
                                        throw new Error(
                                            `"${name}" 的值必须是字符串`
                                        );
                                    }
                                }

                                resolve(
                                    data
                                );

                            } catch (e) {
                                reject(e);
                            }

                            return;
                        }

                        /*
                         * ==============================
                         * type = prompt
                         *
                         * HTTP 直接返回：
                         *
                         * 你是一名资深开发工程师...
                         *
                         * 也兼容：
                         *
                         * "你是一名资深开发工程师..."
                         * ==============================
                         */

                        let prompt =
                            text;

                        try {
                            const parsed =
                                JSON.parse(
                                    text
                                );

                            if (
                                typeof parsed ===
                                'string'
                            ) {
                                prompt =
                                    parsed;
                            }

                        } catch (_) {
                            // 普通文本
                        }

                        resolve(prompt);
                    },

                    onerror() {
                        reject(
                            new Error(
                                '网络请求失败'
                            )
                        );
                    },

                    ontimeout() {
                        reject(
                            new Error(
                                '请求超时'
                            )
                        );
                    }
                });
            }
        );
    }

    async function refreshRemoteItem(item) {
        if (
            item.type !== 'prompts' &&
            item.type !== 'prompt'
        ) {
            return null;
        }

        if (!item.content) {
            return null;
        }

        try {
            const data =
                await requestRemoteItem(
                    item
                );

            const cache =
                getRemoteCache();

            cache[
                getRemoteCacheKey(
                    item
                )
            ] = {
                updatedAt:
                    Date.now(),

                type:
                    item.type,

                data
            };

            saveRemoteCache(
                cache
            );

            return data;

        } catch (_) {
            /*
             * 失败静默处理。
             *
             * 旧缓存不会被删除。
             */
            return null;
        }
    }

    async function refreshAllRemoteItems() {
        if (remoteSyncRunning) {
            return;
        }

        remoteSyncRunning =
            true;

        try {
            const config =
                getConfig();

            const remotes =
                config.filter(
                    item =>
                        item.type ===
                            'prompts' ||
                        item.type ===
                            'prompt'
                );

            await Promise.allSettled(
                remotes.map(
                    item =>
                        refreshRemoteItem(
                            item
                        )
                )
            );

        } finally {
            remoteSyncRunning =
                false;
        }
    }

    /* =========================================================
     * Runtime Prompt Items
     * ========================================================= */

    function getPromptItems(
        config = getConfig()
    ) {
        const result = [];

        const cache =
            getRemoteCache();

        config.forEach(
            (configItem, configIndex) => {

                /*
                 * ===========================
                 * local
                 * ===========================
                 */

                if (
                    configItem.type ===
                    'local'
                ) {
                    result.push({
                        id:
                            `local:${configIndex}`,

                        type:
                            'local',

                        name:
                            configItem.name,

                        displayName:
                            configItem.name,

                        prompt:
                            configItem.content,

                        sourceName:
                            null,

                        sourceUrl:
                            null
                    });

                    return;
                }

                const cached =
                    cache[
                        getRemoteCacheKey(
                            configItem
                        )
                    ];

                if (
                    !cached ||
                    cached.data ===
                        undefined
                ) {
                    return;
                }

                /*
                 * ===========================
                 * prompts
                 * ===========================
                 */

                if (
                    configItem.type ===
                    'prompts'
                ) {
                    if (
                        !cached.data ||
                        typeof cached.data !==
                            'object' ||
                        Array.isArray(
                            cached.data
                        )
                    ) {
                        return;
                    }

                    for (
                        const [
                            name,
                            prompt
                        ]
                        of Object.entries(
                            cached.data
                        )
                    ) {
                        if (
                            typeof prompt !==
                            'string'
                        ) {
                            continue;
                        }

                        result.push({
                            id:
                                `prompts:${configIndex}:${name}`,

                            type:
                                'prompts',

                            name,

                            displayName:
                                `${name} [${configItem.name}]`,

                            prompt,

                            sourceName:
                                configItem.name,

                            sourceUrl:
                                configItem.content
                        });
                    }

                    return;
                }

                /*
                 * ===========================
                 * prompt
                 * ===========================
                 */

                if (
                    configItem.type ===
                    'prompt'
                ) {
                    if (
                        typeof cached.data !==
                        'string'
                    ) {
                        return;
                    }

                    result.push({
                        id:
                            `prompt:${configIndex}`,

                        type:
                            'prompt',

                        name:
                            configItem.name,

                        displayName:
                            `${configItem.name} [远程]`,

                        prompt:
                            cached.data,

                        sourceName:
                            configItem.name,

                        sourceUrl:
                            configItem.content
                    });
                }
            }
        );

        return result;
    }

    /* =========================================================
     * Editor
     * ========================================================= */

    function getEditor(target) {
        if (
            !(target instanceof Element)
        ) {
            return null;
        }

        return target.closest(
            [
                'textarea',
                '[contenteditable="true"]',
                '[role="textbox"]'
            ].join(',')
        );
    }

    function isChatEditor(editor) {
        if (!editor) {
            return false;
        }

        if (
            picker &&
            picker.contains(editor)
        ) {
            return false;
        }

        const settings =
            document.getElementById(
                'tampermonkey-prompt-settings'
            );

        if (
            settings &&
            settings.contains(editor)
        ) {
            return false;
        }

        const hostname =
            location.hostname;

        return (
            hostname ===
                'chatgpt.com' ||
            hostname ===
                'chat.openai.com' ||
            hostname ===
                'chat.deepseek.com'
        );
    }

    /* =========================================================
     * Cursor
     * ========================================================= */

    function saveCursor(editor) {
        savedEditor =
            editor;

        if (
            editor instanceof
                HTMLTextAreaElement ||
            editor instanceof
                HTMLInputElement
        ) {
            savedSelectionStart =
                editor.selectionStart;

            savedSelectionEnd =
                editor.selectionEnd;

            savedRange =
                null;

            return;
        }

        const selection =
            window.getSelection();

        if (
            selection &&
            selection.rangeCount
        ) {
            savedRange =
                selection
                    .getRangeAt(0)
                    .cloneRange();

        } else {
            savedRange =
                null;
        }
    }

    function restoreCursor() {
        if (
            !savedEditor ||
            !document.contains(
                savedEditor
            )
        ) {
            return;
        }

        savedEditor.focus();

        if (
            savedEditor instanceof
                HTMLTextAreaElement ||
            savedEditor instanceof
                HTMLInputElement
        ) {
            const length =
                savedEditor.value.length;

            const start =
                savedSelectionStart ??
                length;

            const end =
                savedSelectionEnd ??
                start;

            savedEditor
                .setSelectionRange(
                    start,
                    end
                );

            return;
        }

        if (savedRange) {
            try {
                const selection =
                    window.getSelection();

                selection.removeAllRanges();
                selection.addRange(
                    savedRange
                );

            } catch (_) {
                // ignore
            }
        }
    }

    /* =========================================================
     * Insert Prompt
     * ========================================================= */

    function insertIntoTextarea(
        editor,
        text
    ) {
        const start =
            savedSelectionStart ??
            editor.selectionStart ??
            editor.value.length;

        const end =
            savedSelectionEnd ??
            editor.selectionEnd ??
            start;

        const oldValue =
            editor.value;

        const newValue =
            oldValue.slice(
                0,
                start
            ) +
            text +
            oldValue.slice(
                end
            );

        const prototype =
            editor instanceof
            HTMLTextAreaElement
                ? HTMLTextAreaElement
                    .prototype
                : HTMLInputElement
                    .prototype;

        const descriptor =
            Object
                .getOwnPropertyDescriptor(
                    prototype,
                    'value'
                );

        if (
            descriptor &&
            descriptor.set
        ) {
            descriptor.set.call(
                editor,
                newValue
            );
        } else {
            editor.value =
                newValue;
        }

        editor.dispatchEvent(
            new InputEvent(
                'input',
                {
                    bubbles:
                        true,

                    inputType:
                        'insertText',

                    data:
                        text
                }
            )
        );

        editor.dispatchEvent(
            new Event(
                'change',
                {
                    bubbles:
                        true
                }
            )
        );

        const cursor =
            start +
            text.length;

        requestAnimationFrame(
            () => {
                editor.focus();

                editor.setSelectionRange(
                    cursor,
                    cursor
                );
            }
        );
    }

    function insertIntoContentEditable(
        editor,
        text
    ) {
        restoreCursor();

        const selection =
            window.getSelection();

        if (!selection) {
            return;
        }

        let success = false;

        try {
            success =
                document.execCommand(
                    'insertText',
                    false,
                    text
                );

        } catch (_) {
            success = false;
        }

        if (
            !success &&
            selection.rangeCount
        ) {
            try {
                const range =
                    selection.getRangeAt(
                        0
                    );

                range.deleteContents();

                const node =
                    document.createTextNode(
                        text
                    );

                range.insertNode(node);

                range.setStartAfter(
                    node
                );

                range.collapse(true);

                selection.removeAllRanges();

                selection.addRange(
                    range
                );

            } catch (_) {
                return;
            }
        }

        editor.dispatchEvent(
            new InputEvent(
                'input',
                {
                    bubbles:
                        true,

                    inputType:
                        'insertText',

                    data:
                        text
                }
            )
        );
    }

    function insertPrompt(prompt) {
        if (!savedEditor) {
            return;
        }

        const text =
            prompt +
            '\n\n---\n\n';

        if (
            savedEditor instanceof
                HTMLTextAreaElement ||
            savedEditor instanceof
                HTMLInputElement
        ) {
            insertIntoTextarea(
                savedEditor,
                text
            );

        } else {
            insertIntoContentEditable(
                savedEditor,
                text
            );
        }
    }

    /* =========================================================
     * Picker
     * ========================================================= */

    function createPicker() {
        if (picker) {
            return;
        }

        picker =
            document.createElement(
                'div'
            );

        picker.id =
            'tampermonkey-prompt-picker';

        picker.innerHTML = `
            <div class="pp-box">

                <div class="pp-header">

                    <div class="pp-search-wrap">

                        <svg
                            class="pp-search-icon"
                            viewBox="0 0 24 24"
                        >
                            <path
                                d="M21 21l-4.35-4.35m2.35-5.65a8 8 0 1 1-16 0 8 8 0 0 1 16 0z"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                            />
                        </svg>

                        <input
                            class="pp-search"
                            type="text"
                            placeholder="搜索 Prompt..."
                            autocomplete="off"
                        />

                    </div>

                    <button
                        class="pp-icon-button pp-refresh"
                        type="button"
                        title="刷新远程 Prompt"
                    >
                        <svg viewBox="0 0 24 24">
                            <path
                                d="M20 6v5h-5"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                            />

                            <path
                                d="M19 11a7 7 0 1 0 1 5"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                            />
                        </svg>
                    </button>

                    <button
                        class="pp-icon-button pp-settings"
                        type="button"
                        title="Prompt 设置"
                    >
                        <svg viewBox="0 0 24 24">
                            <path
                                fill="currentColor"
                                d="
                                    M19.14 12.94
                                    c.04-.31.06-.63.06-.94
                                    s-.02-.63-.07-.94
                                    l2.03-1.58
                                    a.5.5 0 0 0 .12-.64
                                    l-1.92-3.32
                                    a.5.5 0 0 0-.61-.22
                                    l-2.39.96
                                    a7.1 7.1 0 0 0-1.62-.94
                                    l-.36-2.54
                                    A.49.49 0 0 0 13.89 2
                                    h-3.84
                                    a.49.49 0 0 0-.49.42
                                    L9.2 4.96
                                    c-.58.24-1.12.56-1.62.94
                                    l-2.39-.96
                                    a.49.49 0 0 0-.61.22
                                    L2.66 8.48
                                    a.5.5 0 0 0 .12.64
                                    l2.03 1.58
                                    c-.05.31-.08.64-.08.96
                                    0 .32.03.65.08.96
                                    l-2.03 1.58
                                    a.5.5 0 0 0-.12.64
                                    l1.92 3.32
                                    c.13.23.4.31.61.22
                                    l2.39-.96
                                    c.5.39 1.04.71 1.62.94
                                    l.36 2.54
                                    c.04.24.24.42.49.42
                                    h3.84
                                    c.25 0 .46-.18.49-.42
                                    l.36-2.54
                                    c.58-.24 1.12-.56 1.62-.94
                                    l2.39.96
                                    c.23.08.49 0 .61-.22
                                    l1.92-3.32
                                    a.5.5 0 0 0-.12-.64
                                    z

                                    M12 15.5
                                    A3.5 3.5 0 1 1 12 8
                                    a3.5 3.5 0 0 1 0 7.5
                                    z
                                "
                            />
                        </svg>
                    </button>

                </div>

                <div class="pp-list"></div>

                <div class="pp-footer">
                    <span>↑↓ 选择</span>
                    <span>Enter 插入</span>
                    <span>Esc 关闭</span>
                    <span>! / ！ 唤起</span>
                </div>

            </div>
        `;

        document.body.appendChild(
            picker
        );

        pickerSearch =
            picker.querySelector(
                '.pp-search'
            );

        pickerList =
            picker.querySelector(
                '.pp-list'
            );

        const refreshButton =
            picker.querySelector(
                '.pp-refresh'
            );

        const settingsButton =
            picker.querySelector(
                '.pp-settings'
            );

        pickerSearch.addEventListener(
            'input',
            renderPicker
        );

        pickerSearch.addEventListener(
            'keydown',
            handlePickerKeydown
        );

        settingsButton.addEventListener(
            'mousedown',
            e =>
                e.preventDefault()
        );

        settingsButton.addEventListener(
            'click',
            () => {
                picker.style.display =
                    'none';

                openSettings();
            }
        );

        refreshButton.addEventListener(
            'mousedown',
            e =>
                e.preventDefault()
        );

        refreshButton.addEventListener(
            'click',
            async () => {
                if (
                    refreshButton.disabled
                ) {
                    return;
                }

                refreshButton.disabled =
                    true;

                refreshButton
                    .classList
                    .add(
                        'loading'
                    );

                try {
                    await refreshAllRemoteItems();

                    renderPicker();

                } finally {
                    refreshButton.disabled =
                        false;

                    refreshButton
                        .classList
                        .remove(
                            'loading'
                        );

                    pickerSearch.focus();
                }
            }
        );

        picker.addEventListener(
            'mousedown',
            e => {
                if (
                    e.target ===
                    picker
                ) {
                    closePicker();
                }
            }
        );
    }

    function showPicker() {
        createPicker();

        pickerSelectedIndex =
            0;

        picker.style.display =
            'flex';

        pickerSearch.value =
            '';

        /*
         * 马上显示：
         *
         * local
         * +
         * 已缓存的远程 Prompt
         */
        renderPicker();

        requestAnimationFrame(
            () => {
                pickerSearch.focus();
            }
        );

        /*
         * 当前页面第一次打开：
         * 自动同步一次。
         *
         * 不阻塞弹窗。
         */
        if (
            !initialRemoteSyncDone
        ) {
            initialRemoteSyncDone =
                true;

            refreshAllRemoteItems()
                .then(() => {
                    if (
                        picker &&
                        picker.style.display !==
                            'none'
                    ) {
                        renderPicker();

                        pickerSearch.focus();
                    }
                })
                .catch(() => {
                    // 静默
                });
        }
    }

    function closePicker() {
        if (!picker) {
            return;
        }

        picker.style.display =
            'none';

        restoreCursor();
    }

    function renderPicker() {
        const allItems =
            getPromptItems();

        const keyword =
            pickerSearch
                .value
                .trim()
                .toLowerCase();

        pickerItems =
            allItems.filter(
                item => {
                    if (!keyword) {
                        return true;
                    }

                    return (
                        item.displayName
                            .toLowerCase()
                            .includes(
                                keyword
                            ) ||

                        item.prompt
                            .toLowerCase()
                            .includes(
                                keyword
                            )
                    );
                }
            );

        if (
            pickerSelectedIndex >=
            pickerItems.length
        ) {
            pickerSelectedIndex =
                Math.max(
                    0,
                    pickerItems.length -
                        1
                );
        }

        pickerList.innerHTML =
            '';

        if (!pickerItems.length) {
            const empty =
                document.createElement(
                    'div'
                );

            empty.className =
                'pp-empty';

            empty.textContent =
                '没有找到 Prompt';

            pickerList.appendChild(
                empty
            );

            return;
        }

        pickerItems.forEach(
            (item, index) => {

                const element =
                    document.createElement(
                        'div'
                    );

                element.className =
                    'pp-item' +
                    (
                        index ===
                        pickerSelectedIndex
                            ? ' selected'
                            : ''
                    );

                const title =
                    document.createElement(
                        'div'
                    );

                title.className =
                    'pp-title';

                const name =
                    document.createElement(
                        'span'
                    );

                name.textContent =
                    item.name;

                title.appendChild(
                    name
                );

                /*
                 * prompts:
                 *
                 * hello_prompt [hello]
                 */
                if (
                    item.type ===
                    'prompts'
                ) {
                    const badge =
                        document.createElement(
                            'span'
                        );

                    badge.className =
                        'pp-source';

                    badge.textContent =
                        `[${item.sourceName}]`;

                    title.appendChild(
                        badge
                    );
                }

                /*
                 * prompt:
                 *
                 * hi [远程]
                 */
                if (
                    item.type ===
                    'prompt'
                ) {
                    const badge =
                        document.createElement(
                            'span'
                        );

                    badge.className =
                        'pp-source';

                    badge.textContent =
                        '[远程]';

                    title.appendChild(
                        badge
                    );
                }

                const preview =
                    document.createElement(
                        'div'
                    );

                preview.className =
                    'pp-preview';

                preview.textContent =
                    item.prompt
                        .replace(
                            /\s+/g,
                            ' '
                        )
                        .slice(
                            0,
                            120
                        );

                element.appendChild(
                    title
                );

                element.appendChild(
                    preview
                );

                element.addEventListener(
                    'mouseenter',
                    () => {
                        pickerSelectedIndex =
                            index;

                        updatePickerSelection();
                    }
                );

                element.addEventListener(
                    'mousedown',
                    e =>
                        e.preventDefault()
                );

                element.addEventListener(
                    'click',
                    () => {
                        choosePrompt(
                            index
                        );
                    }
                );

                pickerList.appendChild(
                    element
                );
            }
        );

        scrollPickerSelection();
    }

    function updatePickerSelection() {
        pickerList
            .querySelectorAll(
                '.pp-item'
            )
            .forEach(
                (item, index) => {
                    item.classList.toggle(
                        'selected',
                        index ===
                            pickerSelectedIndex
                    );
                }
            );

        scrollPickerSelection();
    }

    function scrollPickerSelection() {
        pickerList
            .querySelector(
                '.pp-item.selected'
            )
            ?.scrollIntoView({
                block:
                    'nearest'
            });
    }

    function choosePrompt(index) {
        const item =
            pickerItems[index];

        if (!item) {
            return;
        }

        picker.style.display =
            'none';

        insertPrompt(
            item.prompt
        );
    }

    function handlePickerKeydown(e) {
        if (
            e.key ===
            'Escape'
        ) {
            e.preventDefault();

            closePicker();

            return;
        }

        if (
            e.key ===
            'ArrowDown'
        ) {
            e.preventDefault();

            if (
                !pickerItems.length
            ) {
                return;
            }

            pickerSelectedIndex =
                (
                    pickerSelectedIndex +
                    1
                ) %
                pickerItems.length;

            updatePickerSelection();

            return;
        }

        if (
            e.key ===
            'ArrowUp'
        ) {
            e.preventDefault();

            if (
                !pickerItems.length
            ) {
                return;
            }

            pickerSelectedIndex =
                (
                    pickerSelectedIndex -
                    1 +
                    pickerItems.length
                ) %
                pickerItems.length;

            updatePickerSelection();

            return;
        }

        if (
            e.key ===
            'Enter'
        ) {
            e.preventDefault();

            choosePrompt(
                pickerSelectedIndex
            );
        }
    }

    /* =========================================================
     * Settings
     * ========================================================= */

    function openSettings() {
        document
            .getElementById(
                'tampermonkey-prompt-settings'
            )
            ?.remove();

        let workingConfig =
            clone(
                getConfig()
            );

        let selectedIndex =
            workingConfig.length
                ? 0
                : -1;

        let activeTab =
            'visual';

        const modal =
            document.createElement(
                'div'
            );

        modal.id =
            'tampermonkey-prompt-settings';

        modal.innerHTML = `
            <div class="ps-box">

                <header class="ps-header">

                    <div>
                        <div class="ps-title">
                            Prompt 管理
                        </div>

                        <div class="ps-desc">
                            local / prompts / prompt
                        </div>
                    </div>

                    <div class="ps-tabs">

                        <button
                            class="ps-tab active"
                            data-tab="visual"
                            type="button"
                        >
                            可视化
                        </button>

                        <button
                            class="ps-tab"
                            data-tab="json"
                            type="button"
                        >
                            JSON
                        </button>

                    </div>

                    <button
                        class="ps-close"
                        type="button"
                    >
                        ×
                    </button>

                </header>

                <div class="ps-body">

                    <!-- Visual -->

                    <section
                        class="ps-pane active"
                        data-pane="visual"
                    >

                        <aside class="ps-sidebar">

                            <div class="ps-sidebar-header">

                                <strong>
                                    配置
                                </strong>

                                <button
                                    class="ps-add"
                                    type="button"
                                    title="新增"
                                >
                                    +
                                </button>

                            </div>

                            <div
                                class="ps-config-list"
                            ></div>

                        </aside>

                        <main class="ps-detail">

                            <div
                                class="ps-detail-empty"
                            >
                                请选择一个配置
                            </div>

                            <div
                                class="ps-detail-content"
                            >

                                <label class="ps-field">

                                    <span>
                                        类型
                                    </span>

                                    <select
                                        class="ps-type"
                                    >
                                        <option value="local">
                                            local
                                        </option>

                                        <option value="prompts">
                                            prompts
                                        </option>

                                        <option value="prompt">
                                            prompt
                                        </option>
                                    </select>

                                </label>

                                <label class="ps-field">

                                    <span class="ps-name-label">
                                        名称
                                    </span>

                                    <input
                                        class="ps-name"
                                        type="text"
                                    />

                                </label>

                                <label
                                    class="ps-field ps-content-field"
                                >

                                    <span class="ps-content-label">
                                        Prompt 内容
                                    </span>

                                    <textarea
                                        class="ps-content"
                                        spellcheck="false"
                                    ></textarea>

                                </label>

                                <div
                                    class="ps-remote-preview"
                                ></div>

                                <div class="ps-detail-actions">

                                    <button
                                        class="ps-refresh-one"
                                        type="button"
                                    >
                                        刷新远程内容
                                    </button>

                                    <button
                                        class="ps-delete danger"
                                        type="button"
                                    >
                                        删除
                                    </button>

                                </div>

                            </div>

                        </main>

                    </section>

                    <!-- JSON -->

                    <section
                        class="ps-pane ps-json-pane"
                        data-pane="json"
                    >

                        <div class="ps-json-tip">
                            完整配置。格式为 [{ type, name, content }]
                        </div>

                        <textarea
                            class="ps-json-editor"
                            spellcheck="false"
                        ></textarea>

                    </section>

                </div>

                <div
                    class="ps-error"
                ></div>

                <footer class="ps-footer">

                    <button
                        class="ps-reset"
                        type="button"
                    >
                        恢复示例
                    </button>

                    <div class="ps-spacer"></div>

                    <button
                        class="ps-cancel"
                        type="button"
                    >
                        取消
                    </button>

                    <button
                        class="ps-save primary"
                        type="button"
                    >
                        保存
                    </button>

                </footer>

            </div>
        `;

        document.body.appendChild(
            modal
        );

        const configList =
            modal.querySelector(
                '.ps-config-list'
            );

        const detailEmpty =
            modal.querySelector(
                '.ps-detail-empty'
            );

        const detailContent =
            modal.querySelector(
                '.ps-detail-content'
            );

        const typeInput =
            modal.querySelector(
                '.ps-type'
            );

        const nameInput =
            modal.querySelector(
                '.ps-name'
            );

        const contentInput =
            modal.querySelector(
                '.ps-content'
            );

        const nameLabel =
            modal.querySelector(
                '.ps-name-label'
            );

        const contentLabel =
            modal.querySelector(
                '.ps-content-label'
            );

        const remotePreview =
            modal.querySelector(
                '.ps-remote-preview'
            );

        const refreshOneButton =
            modal.querySelector(
                '.ps-refresh-one'
            );

        const jsonEditor =
            modal.querySelector(
                '.ps-json-editor'
            );

        const error =
            modal.querySelector(
                '.ps-error'
            );

        /* -----------------------------------------------------
         * Helpers
         * ----------------------------------------------------- */

        function setError(
            message = ''
        ) {
            error.textContent =
                message;
        }

        function getSelectedConfig() {
            if (
                selectedIndex < 0 ||
                selectedIndex >=
                    workingConfig.length
            ) {
                return null;
            }

            return workingConfig[
                selectedIndex
            ];
        }

        function commitDetail() {
            const item =
                getSelectedConfig();

            if (!item) {
                return true;
            }

            item.type =
                typeInput.value;

            item.name =
                nameInput
                    .value
                    .trim();

            item.content =
                contentInput.value;

            if (!item.name) {
                setError(
                    '名称不能为空'
                );

                return false;
            }

            if (
                item.type !==
                    'local' &&
                !item.content.trim()
            ) {
                setError(
                    '远程 URL 不能为空'
                );

                return false;
            }

            setError('');

            return true;
        }

        /* -----------------------------------------------------
         * Config List
         * ----------------------------------------------------- */

        function renderConfigList() {
            configList.innerHTML =
                '';

            if (
                !workingConfig.length
            ) {
                configList.innerHTML = `
                    <div class="ps-list-empty">
                        还没有配置
                    </div>
                `;

                return;
            }

            workingConfig.forEach(
                (item, index) => {

                    const button =
                        document.createElement(
                            'button'
                        );

                    button.type =
                        'button';

                    button.className =
                        'ps-config-item' +
                        (
                            index ===
                            selectedIndex
                                ? ' active'
                                : ''
                        );

                    const title =
                        document.createElement(
                            'div'
                        );

                    title.className =
                        'ps-config-title';

                    const badge =
                        document.createElement(
                            'span'
                        );

                    badge.className =
                        `ps-type-badge type-${item.type}`;

                    badge.textContent =
                        item.type;

                    const name =
                        document.createElement(
                            'span'
                        );

                    name.textContent =
                        item.name ||
                        '(未命名)';

                    title.appendChild(
                        badge
                    );

                    title.appendChild(
                        name
                    );

                    const preview =
                        document.createElement(
                            'div'
                        );

                    preview.className =
                        'ps-config-preview';

                    preview.textContent =
                        item.type ===
                        'local'
                            ? item.content
                                .replace(
                                    /\s+/g,
                                    ' '
                                )
                                .slice(
                                    0,
                                    60
                                )
                            : item.content;

                    button.appendChild(
                        title
                    );

                    button.appendChild(
                        preview
                    );

                    button.addEventListener(
                        'click',
                        () => {
                            if (
                                !commitDetail()
                            ) {
                                return;
                            }

                            selectedIndex =
                                index;

                            renderConfigList();
                            renderDetail();
                        }
                    );

                    configList.appendChild(
                        button
                    );
                }
            );
        }

        /* -----------------------------------------------------
         * Remote Preview
         * ----------------------------------------------------- */

        function renderRemotePreview() {
            const item =
                getSelectedConfig();

            remotePreview.innerHTML =
                '';

            if (
                !item ||
                item.type ===
                    'local'
            ) {
                remotePreview.style.display =
                    'none';

                return;
            }

            remotePreview.style.display =
                'block';

            const cache =
                getRemoteCache();

            const cached =
                cache[
                    getRemoteCacheKey(
                        item
                    )
                ];

            if (
                !cached ||
                cached.data ===
                    undefined
            ) {
                remotePreview.innerHTML = `
                    <div class="ps-preview-title">
                        远程缓存
                    </div>

                    <div class="ps-preview-empty">
                        尚未同步
                    </div>
                `;

                return;
            }

            if (
                item.type ===
                'prompts'
            ) {
                const names =
                    Object.keys(
                        cached.data || {}
                    );

                remotePreview.innerHTML = `
                    <div class="ps-preview-title">
                        已缓存 ${names.length} 个 Prompt
                    </div>

                    <div class="ps-preview-items"></div>
                `;

                const holder =
                    remotePreview
                        .querySelector(
                            '.ps-preview-items'
                        );

                names.forEach(name => {
                    const row =
                        document.createElement(
                            'div'
                        );

                    row.className =
                        'ps-preview-item';

                    row.textContent =
                        `${name} [${item.name}]`;

                    holder.appendChild(
                        row
                    );
                });

                return;
            }

            remotePreview.innerHTML = `
                <div class="ps-preview-title">
                    已缓存远程 Prompt
                </div>

                <pre class="ps-preview-content"></pre>
            `;

            remotePreview
                .querySelector(
                    '.ps-preview-content'
                )
                .textContent =
                    String(
                        cached.data
                    );
        }

        /* -----------------------------------------------------
         * Detail
         * ----------------------------------------------------- */

        function renderDetail() {
            const item =
                getSelectedConfig();

            if (!item) {
                detailEmpty.style.display =
                    'flex';

                detailContent.style.display =
                    'none';

                return;
            }

            detailEmpty.style.display =
                'none';

            detailContent.style.display =
                'flex';

            typeInput.value =
                item.type;

            nameInput.value =
                item.name;

            contentInput.value =
                item.content;

            if (
                item.type ===
                'local'
            ) {
                nameLabel.textContent =
                    'Prompt 名称';

                contentLabel.textContent =
                    'Prompt 内容';

                contentInput.placeholder =
                    '请输入 Prompt 内容...';

                refreshOneButton.style.display =
                    'none';

            } else if (
                item.type ===
                'prompts'
            ) {
                nameLabel.textContent =
                    '来源名称';

                contentLabel.textContent =
                    'JSON URL';

                contentInput.placeholder =
                    'http://example.com/prompts.json';

                refreshOneButton.style.display =
                    '';

            } else {
                nameLabel.textContent =
                    'Prompt 名称';

                contentLabel.textContent =
                    'Prompt URL';

                contentInput.placeholder =
                    'http://example.com/prompt.txt';

                refreshOneButton.style.display =
                    '';
            }

            renderRemotePreview();
        }

        /* -----------------------------------------------------
         * Detail Events
         * ----------------------------------------------------- */

        typeInput.addEventListener(
            'change',
            () => {
                const item =
                    getSelectedConfig();

                if (!item) {
                    return;
                }

                item.type =
                    typeInput.value;

                renderDetail();
                renderConfigList();
            }
        );

        nameInput.addEventListener(
            'input',
            () => {
                const item =
                    getSelectedConfig();

                if (!item) {
                    return;
                }

                item.name =
                    nameInput.value;

                renderConfigList();
            }
        );

        contentInput.addEventListener(
            'input',
            () => {
                const item =
                    getSelectedConfig();

                if (!item) {
                    return;
                }

                item.content =
                    contentInput.value;

                renderConfigList();
            }
        );

        /* -----------------------------------------------------
         * Add
         * ----------------------------------------------------- */

        modal
            .querySelector(
                '.ps-add'
            )
            .addEventListener(
                'click',
                () => {

                    if (
                        !commitDetail()
                    ) {
                        return;
                    }

                    workingConfig.push({
                        type:
                            'local',

                        name:
                            '新 Prompt',

                        content:
                            ''
                    });

                    selectedIndex =
                        workingConfig.length -
                        1;

                    renderConfigList();
                    renderDetail();

                    requestAnimationFrame(
                        () => {
                            nameInput.focus();
                            nameInput.select();
                        }
                    );
                }
            );

        /* -----------------------------------------------------
         * Delete
         * ----------------------------------------------------- */

        modal
            .querySelector(
                '.ps-delete'
            )
            .addEventListener(
                'click',
                () => {

                    const item =
                        getSelectedConfig();

                    if (!item) {
                        return;
                    }

                    if (
                        !window.confirm(
                            `确定删除 "${item.name}" 吗？`
                        )
                    ) {
                        return;
                    }

                    workingConfig.splice(
                        selectedIndex,
                        1
                    );

                    if (
                        !workingConfig.length
                    ) {
                        selectedIndex =
                            -1;

                    } else if (
                        selectedIndex >=
                        workingConfig.length
                    ) {
                        selectedIndex =
                            workingConfig.length -
                            1;
                    }

                    renderConfigList();
                    renderDetail();
                }
            );

        /* -----------------------------------------------------
         * Refresh one
         * ----------------------------------------------------- */

        refreshOneButton.addEventListener(
            'click',
            async () => {
                const item =
                    getSelectedConfig();

                if (
                    !item ||
                    item.type ===
                        'local'
                ) {
                    return;
                }

                if (
                    !commitDetail()
                ) {
                    return;
                }

                refreshOneButton.disabled =
                    true;

                refreshOneButton.textContent =
                    '刷新中...';

                try {
                    await refreshRemoteItem(
                        item
                    );

                    /*
                     * 请求失败也静默。
                     * 直接重新显示缓存。
                     */
                    renderRemotePreview();

                } finally {
                    refreshOneButton.disabled =
                        false;

                    refreshOneButton.textContent =
                        '刷新远程内容';
                }
            }
        );

        /* -----------------------------------------------------
         * JSON
         * ----------------------------------------------------- */

        function loadJsonEditor() {
            jsonEditor.value =
                JSON.stringify(
                    workingConfig,
                    null,
                    2
                );
        }

        function applyJsonEditor() {
            try {
                const data =
                    normalizeConfig(
                        JSON.parse(
                            jsonEditor.value
                        )
                    );

                validateConfig(data);

                workingConfig =
                    data;

                if (
                    workingConfig.length
                ) {
                    if (
                        selectedIndex < 0 ||
                        selectedIndex >=
                            workingConfig.length
                    ) {
                        selectedIndex =
                            0;
                    }

                } else {
                    selectedIndex =
                        -1;
                }

                setError('');

                return true;

            } catch (e) {
                setError(
                    `JSON 错误：${e.message}`
                );

                return false;
            }
        }

        /* -----------------------------------------------------
         * Tabs
         * ----------------------------------------------------- */

        function switchTab(tab) {
            if (
                tab === activeTab
            ) {
                return;
            }

            if (
                activeTab ===
                    'visual'
            ) {
                if (
                    !commitDetail()
                ) {
                    return;
                }
            }

            if (
                activeTab ===
                    'json'
            ) {
                if (
                    !applyJsonEditor()
                ) {
                    return;
                }
            }

            activeTab =
                tab;

            modal
                .querySelectorAll(
                    '.ps-tab'
                )
                .forEach(button => {
                    button.classList.toggle(
                        'active',
                        button.dataset.tab ===
                            tab
                    );
                });

            modal
                .querySelectorAll(
                    '.ps-pane'
                )
                .forEach(pane => {
                    pane.classList.toggle(
                        'active',
                        pane.dataset.pane ===
                            tab
                    );
                });

            if (
                tab ===
                'json'
            ) {
                loadJsonEditor();

            } else {
                renderConfigList();
                renderDetail();
            }

            setError('');
        }

        modal
            .querySelectorAll(
                '.ps-tab'
            )
            .forEach(button => {
                button.addEventListener(
                    'click',
                    () => {
                        switchTab(
                            button.dataset.tab
                        );
                    }
                );
            });

        /* -----------------------------------------------------
         * Reset
         * ----------------------------------------------------- */

        modal
            .querySelector(
                '.ps-reset'
            )
            .addEventListener(
                'click',
                () => {

                    if (
                        !window.confirm(
                            '确定恢复示例配置吗？'
                        )
                    ) {
                        return;
                    }

                    workingConfig =
                        clone(
                            DEFAULT_CONFIG
                        );

                    selectedIndex =
                        0;

                    loadJsonEditor();
                    renderConfigList();
                    renderDetail();

                    setError('');
                }
            );

        /* -----------------------------------------------------
         * Save
         * ----------------------------------------------------- */

        modal
            .querySelector(
                '.ps-save'
            )
            .addEventListener(
                'click',
                () => {

                    if (
                        activeTab ===
                        'visual'
                    ) {
                        if (
                            !commitDetail()
                        ) {
                            return;
                        }

                    } else {
                        if (
                            !applyJsonEditor()
                        ) {
                            return;
                        }
                    }

                    try {
                        workingConfig =
                            normalizeConfig(
                                workingConfig
                            );

                        validateConfig(
                            workingConfig
                        );

                    } catch (e) {
                        setError(
                            e.message
                        );

                        return;
                    }

                    saveConfig(
                        workingConfig
                    );

                    /*
                     * 保存配置不自动访问网络。
                     *
                     * 新配置可以：
                     *
                     * 1. 点击单个「刷新远程内容」
                     * 2. 点击 Prompt 弹窗里的 ↻
                     * 3. 刷新页面后第一次 ! 自动同步
                     */

                    modal.remove();

                    if (picker) {
                        renderPicker();
                    }

                    restoreCursor();
                }
            );

        /* -----------------------------------------------------
         * Close
         * ----------------------------------------------------- */

        function close() {
            modal.remove();

            requestAnimationFrame(
                restoreCursor
            );
        }

        modal
            .querySelector(
                '.ps-close'
            )
            .addEventListener(
                'click',
                close
            );

        modal
            .querySelector(
                '.ps-cancel'
            )
            .addEventListener(
                'click',
                close
            );

        modal.addEventListener(
            'mousedown',
            e => {
                if (
                    e.target ===
                    modal
                ) {
                    close();
                }
            }
        );

        /* -----------------------------------------------------
         * Init
         * ----------------------------------------------------- */

        loadJsonEditor();
        renderConfigList();
        renderDetail();
    }

    /* =========================================================
     * Trigger
     * ========================================================= */

    function triggerPicker(
        editor,
        event
    ) {
        if (
            picker &&
            picker.style.display ===
                'flex'
        ) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        saveCursor(
            editor
        );

        showPicker();
    }

    /*
     * 英文 !
     */
    document.addEventListener(
        'keydown',
        e => {
            if (
                e.defaultPrevented ||
                e.ctrlKey ||
                e.metaKey ||
                e.altKey
            ) {
                return;
            }

            if (
                e.key !== '!' &&
                e.key !== '！'
            ) {
                return;
            }

            const editor =
                getEditor(
                    e.target
                );

            if (
                !isChatEditor(
                    editor
                )
            ) {
                return;
            }

            triggerPicker(
                editor,
                e
            );
        },
        true
    );

    /*
     * 中文输入法：
     * 部分输入法只在 beforeinput 中出现 ！
     */
    document.addEventListener(
        'beforeinput',
        e => {
            if (
                e.defaultPrevented
            ) {
                return;
            }

            if (
                e.inputType !==
                'insertText'
            ) {
                return;
            }

            if (
                e.data !== '!' &&
                e.data !== '！'
            ) {
                return;
            }

            const editor =
                getEditor(
                    e.target
                );

            if (
                !isChatEditor(
                    editor
                )
            ) {
                return;
            }

            triggerPicker(
                editor,
                e
            );
        },
        true
    );

    /* =========================================================
     * CSS
     * ========================================================= */

    const style =
        document.createElement(
            'style'
        );

    style.textContent = `

        #tampermonkey-prompt-picker *,
        #tampermonkey-prompt-settings * {
            box-sizing: border-box;
        }

        /* ================= Picker ================= */

        #tampermonkey-prompt-picker {
            position: fixed;
            inset: 0;
            z-index: 2147483646;

            display: none;
            align-items: center;
            justify-content: center;

            background: rgba(0,0,0,.18);

            font-family:
                -apple-system,
                BlinkMacSystemFont,
                "Segoe UI",
                sans-serif;
        }

        #tampermonkey-prompt-picker .pp-box {
            width: min(
                660px,
                calc(100vw - 32px)
            );

            max-height: min(
                620px,
                calc(100vh - 80px)
            );

            display: flex;
            flex-direction: column;

            overflow: hidden;

            border: 1px solid
                rgba(0,0,0,.1);

            border-radius: 14px;

            background: #fff;
            color: #222;

            box-shadow:
                0 20px 60px
                rgba(0,0,0,.28);
        }

        .pp-header {
            display: flex;
            align-items: center;
            gap: 7px;

            padding: 10px;

            border-bottom:
                1px solid #eee;
        }

        .pp-search-wrap {
            position: relative;
            flex: 1;
        }

        .pp-search-icon {
            position: absolute;

            left: 11px;
            top: 50%;

            width: 16px;
            height: 16px;

            transform:
                translateY(-50%);

            color: #888;

            pointer-events: none;
        }

        .pp-search {
            width: 100%;

            padding:
                10px 12px
                10px 35px;

            border:
                1px solid #ddd;

            border-radius: 9px;

            outline: none;

            background: #fff;
            color: #222;

            font-size: 14px;
        }

        .pp-search:focus {
            border-color: #888;
        }

        .pp-icon-button {
            width: 38px;
            height: 38px;

            flex: 0 0 38px;

            display: flex;
            align-items: center;
            justify-content: center;

            padding: 0;

            border: 0;
            border-radius: 9px;

            background: transparent;
            color: #666;

            cursor: pointer;
        }

        .pp-icon-button:hover {
            background: #f0f0f0;
            color: #111;
        }

        .pp-icon-button svg {
            width: 19px;
            height: 19px;
        }

        .pp-refresh.loading svg {
            animation:
                pp-spin
                .8s
                linear
                infinite;
        }

        @keyframes pp-spin {
            to {
                transform:
                    rotate(360deg);
            }
        }

        .pp-list {
            flex: 1;

            padding: 7px;

            overflow-y: auto;
        }

        .pp-item {
            padding:
                10px 12px;

            border-radius: 9px;

            cursor: pointer;
        }

        .pp-item.selected {
            background: #f0f0f0;
        }

        .pp-title {
            display: flex;
            align-items: center;
            gap: 7px;

            margin-bottom: 4px;

            font-size: 14px;
            font-weight: 600;
        }

        .pp-source {
            padding:
                2px 6px;

            border-radius: 5px;

            background: #eef1f6;
            color: #667085;

            font-size: 10px;
            font-weight: 500;
        }

        .pp-preview {
            overflow: hidden;

            white-space: nowrap;
            text-overflow: ellipsis;

            color: #777;

            font-size: 12px;
        }

        .pp-empty {
            padding: 36px;

            text-align: center;

            color: #999;
        }

        .pp-footer {
            display: flex;
            gap: 14px;

            padding:
                8px 14px;

            border-top:
                1px solid #eee;

            color: #999;

            font-size: 11px;
        }

        /* ================= Settings ================= */

        #tampermonkey-prompt-settings {
            position: fixed;
            inset: 0;

            z-index: 2147483647;

            display: flex;
            align-items: center;
            justify-content: center;

            background:
                rgba(0,0,0,.45);

            font-family:
                -apple-system,
                BlinkMacSystemFont,
                "Segoe UI",
                sans-serif;
        }

        #tampermonkey-prompt-settings .ps-box {
            width: min(
                1050px,
                calc(100vw - 30px)
            );

            height: min(
                780px,
                calc(100vh - 40px)
            );

            display: flex;
            flex-direction: column;

            overflow: hidden;

            border-radius: 14px;

            background: #fff;
            color: #222;

            box-shadow:
                0 20px 70px
                rgba(0,0,0,.35);
        }

        .ps-header {
            min-height: 68px;

            display: flex;
            align-items: center;
            gap: 18px;

            padding:
                0 18px;

            border-bottom:
                1px solid #eee;
        }

        .ps-title {
            font-size: 18px;
            font-weight: 700;
        }

        .ps-desc {
            margin-top: 2px;

            color: #888;

            font-size: 12px;
        }

        .ps-tabs {
            display: flex;

            margin-left: auto;

            padding: 3px;

            border-radius: 9px;

            background: #f2f2f2;
        }

        .ps-tab {
            padding:
                6px 14px;

            border: 0;
            border-radius: 7px;

            background: transparent;
            color: #777;

            cursor: pointer;
        }

        .ps-tab.active {
            background: #fff;
            color: #111;

            box-shadow:
                0 1px 4px
                rgba(0,0,0,.12);
        }

        .ps-close {
            border: 0;

            background: transparent;
            color: #777;

            font-size: 28px;

            cursor: pointer;
        }

        .ps-body {
            flex: 1;
            min-height: 0;
        }

        .ps-pane {
            display: none;

            width: 100%;
            height: 100%;
        }

        .ps-pane.active {
            display: flex;
        }

        /* ================= Sidebar ================= */

        .ps-sidebar {
            width: 300px;
            flex: 0 0 300px;

            display: flex;
            flex-direction: column;

            border-right:
                1px solid #eee;
        }

        .ps-sidebar-header {
            height: 52px;

            display: flex;
            align-items: center;

            padding:
                0 12px 0 16px;

            border-bottom:
                1px solid #eee;
        }

        .ps-add {
            width: 30px;
            height: 30px;

            margin-left: auto;

            border: 0;
            border-radius: 7px;

            background: #eee;

            cursor: pointer;

            font-size: 20px;
        }

        .ps-config-list {
            flex: 1;

            padding: 7px;

            overflow-y: auto;
        }

        .ps-config-item {
            width: 100%;

            display: block;

            margin-bottom: 3px;

            padding: 10px;

            border: 0;
            border-radius: 8px;

            background: transparent;
            color: inherit;

            cursor: pointer;

            text-align: left;
        }

        .ps-config-item:hover {
            background: #f5f5f5;
        }

        .ps-config-item.active {
            background: #ececec;
        }

        .ps-config-title {
            display: flex;
            align-items: center;

            gap: 6px;

            font-size: 13px;
            font-weight: 600;
        }

        .ps-type-badge {
            flex: 0 0 auto;

            padding:
                2px 5px;

            border-radius: 5px;

            font-size: 9px;
            font-weight: 600;
        }

        .type-local {
            background: #edf7ed;
            color: #327a39;
        }

        .type-prompts {
            background: #e9eef9;
            color: #4c618e;
        }

        .type-prompt {
            background: #f6ecff;
            color: #745098;
        }

        .ps-config-preview {
            margin-top: 4px;

            overflow: hidden;

            white-space: nowrap;
            text-overflow: ellipsis;

            color: #888;

            font-size: 11px;
        }

        .ps-list-empty {
            padding: 30px;

            text-align: center;

            color: #999;
        }

        /* ================= Detail ================= */

        .ps-detail {
            flex: 1;
            min-width: 0;
        }

        .ps-detail-empty {
            width: 100%;
            height: 100%;

            display: flex;
            align-items: center;
            justify-content: center;

            color: #999;
        }

        .ps-detail-content {
            width: 100%;
            height: 100%;

            display: none;
            flex-direction: column;

            padding: 20px;
        }

        .ps-field {
            display: flex;
            flex-direction: column;

            gap: 7px;

            margin-bottom: 15px;
        }

        .ps-field > span {
            color: #666;

            font-size: 12px;
            font-weight: 600;
        }

        .ps-type,
        .ps-name,
        .ps-content,
        .ps-json-editor {
            border:
                1px solid #ddd;

            border-radius: 8px;

            outline: none;

            background: #fff;
            color: #222;
        }

        .ps-type,
        .ps-name {
            padding:
                9px 11px;

            font-size: 14px;
        }

        .ps-content-field {
            flex: 1;
            min-height: 0;
        }

        .ps-content {
            flex: 1;

            min-height: 100px;

            padding: 13px;

            resize: none;

            font-family:
                "SFMono-Regular",
                Consolas,
                monospace;

            font-size: 13px;
            line-height: 1.55;
        }

        .ps-remote-preview {
            display: none;

            max-height: 180px;

            margin-bottom: 14px;
            padding: 10px;

            overflow-y: auto;

            border: 1px solid #eee;
            border-radius: 8px;

            background: #fafafa;
        }

        .ps-preview-title {
            margin-bottom: 7px;

            color: #666;

            font-size: 11px;
            font-weight: 600;
        }

        .ps-preview-empty {
            color: #999;

            font-size: 12px;
        }

        .ps-preview-item {
            padding:
                4px 0;

            border-bottom:
                1px solid #eee;

            font-size: 12px;
        }

        .ps-preview-content {
            margin: 0;

            white-space: pre-wrap;

            color: #666;

            font-size: 11px;

            font-family:
                "SFMono-Regular",
                Consolas,
                monospace;
        }

        .ps-detail-actions {
            display: flex;
            justify-content: flex-end;

            gap: 8px;
        }

        /* ================= JSON ================= */

        .ps-json-pane {
            flex-direction: column;

            padding: 14px;
        }

        .ps-json-tip {
            margin-bottom: 9px;

            color: #888;

            font-size: 12px;
        }

        .ps-json-editor {
            flex: 1;

            width: 100%;

            padding: 14px;

            resize: none;

            font-family:
                "SFMono-Regular",
                Consolas,
                monospace;

            font-size: 13px;
            line-height: 1.55;
        }

        /* ================= Footer ================= */

        .ps-error {
            min-height: 23px;

            padding:
                3px 16px;

            color: #d33;

            font-size: 12px;
        }

        .ps-footer {
            display: flex;
            align-items: center;

            gap: 8px;

            padding:
                10px 14px 14px;
        }

        .ps-spacer {
            flex: 1;
        }

        .ps-footer button,
        .ps-detail-actions button {
            padding:
                8px 13px;

            border:
                1px solid #ddd;

            border-radius: 8px;

            background: #fff;
            color: #222;

            cursor: pointer;
        }

        button.primary {
            background: #111 !important;
            color: #fff !important;

            border-color:
                #111 !important;
        }

        button.danger {
            color: #b42318 !important;

            border-color:
                #e2b5b2 !important;
        }

        /* ================= Dark ================= */

        @media (prefers-color-scheme: dark) {

            #tampermonkey-prompt-picker .pp-box,
            #tampermonkey-prompt-settings .ps-box {
                background: #242424;
                color: #eee;
            }

            .pp-header,
            .pp-footer,
            .ps-header,
            .ps-sidebar,
            .ps-sidebar-header {
                border-color: #444;
            }

            .pp-search,
            .ps-type,
            .ps-name,
            .ps-content,
            .ps-json-editor {
                background: #181818;
                color: #eee;

                border-color: #555;
            }

            .pp-item.selected,
            .ps-config-item.active {
                background: #3a3a3a;
            }

            .ps-config-item:hover {
                background: #333;
            }

            .ps-tabs {
                background: #181818;
            }

            .ps-tab.active {
                background: #3a3a3a;
                color: #fff;
            }

            .ps-add {
                background: #333;
                color: #eee;
            }

            .ps-remote-preview {
                background: #181818;
                border-color: #444;
            }

            .ps-preview-item {
                border-color: #444;
            }

            .ps-footer button,
            .ps-detail-actions button {
                background: #333;
                color: #eee;

                border-color: #555;
            }

            button.primary {
                background: #eee !important;
                color: #111 !important;

                border-color:
                    #eee !important;
            }
        }

        /* ================= Mobile ================= */

        @media (max-width: 720px) {

            .ps-sidebar {
                width: 210px;
                flex-basis: 210px;
            }

            .ps-header {
                gap: 8px;
            }

            .ps-desc {
                display: none;
            }
        }
    `;

    document.head.appendChild(
        style
    );

    /* =========================================================
     * Tampermonkey Menu
     * ========================================================= */

    GM_registerMenuCommand(
        'Prompt 管理',
        openSettings
    );

})();
