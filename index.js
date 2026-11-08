/**
 * Catiecli Tasks — TRANS-AM compatibility fork.
 * Based on su-kaka/st-catiecli-tasks v1.2.0, MIT, Copyright (c) 2026 sukaka.
 * Keeps the original task API and ST response path; see README for tested limits.
 */
// 相对路径注意:第三方扩展经 /scripts/extensions/third-party/<name>/ 提供,
// 比内置扩展深一层,所以是 ../../../(内置扩展用 ../../)
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveSettings, saveSettingsDebounced } from '../../../../script.js';
import { yaml } from '../../../../lib.js';

const MODULE_NAME = 'st-catiecli-tasks';
const GENERATE_URL = '/api/backends/chat-completions/generate';
const DEFAULT_UPSTREAM = 'https://catiecli.sukaka.top';

// Always install before preset scripts (Tavern Helper loading_order is 100).
// Toggling only changes enabled; never restore an old fetch over another wrapper.
const originalFetch = window.fetch.bind(window);
const loadedAfterPreset = Boolean(window.ta_outer_transport_status);
const defaultSettings = { enabled: false, apiKey: '', upstreamOverride: '', interceptKeyword: 'catiecli' };
const POLL_MAX_MS = 30 * 60 * 1000;
let patched = false;

function loadSettings() {
    extension_settings[MODULE_NAME] ??= {};
    for (const [key, value] of Object.entries(defaultSettings)) {
        extension_settings[MODULE_NAME][key] ??= value;
    }
}
function getSettings() { return extension_settings[MODULE_NAME] ?? defaultSettings; }
function reportStatus(text) {
    const node = document.getElementById('catiecli_tasks_status');
    if (node) node.textContent = text;
}
function normalizeBaseUrl(raw) {
    const url = new URL(String(raw).trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('任务接口需要不含账号、查询参数或片段的 HTTP(S) 基础地址');
    }
    return url.href.replace(/\/+$/, '').replace(/\/v1$/i, '');
}
function resolveUpstream(data) { return normalizeBaseUrl(data.custom_url); }
function yamlObject(text) {
    if (!text) return {};
    const value = yaml.parse(text);
    const rows = Array.isArray(value) ? value : [value];
    if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
        throw new Error('自定义请求体或请求头必须是 YAML 对象');
    }
    return Object.assign({}, ...rows);
}
function resolveHeaders(data, upstream) {
    const headers = new Headers(yamlObject(data.custom_include_headers));
    if (!headers.has('Authorization')) {
        let key;
        if (data.reverse_proxy && Object.hasOwn(data, 'proxy_password')) {
            key = String(data.proxy_password ?? '').trim();
        } else if (Object.hasOwn(data, 'api_key_custom')) {
            key = String(data.api_key_custom ?? '').trim();
        } else {
            const settings = getSettings();
            if (upstream !== normalizeBaseUrl(settings.upstreamOverride || DEFAULT_UPSTREAM)) {
                throw new Error('本次独立连接未提供密钥，且地址与插件密钥所属地址不同；未发送请求');
            }
            key = String(settings.apiKey ?? '').trim();
        }
        if (!key) throw new Error('请填写本次独立连接的密钥，或在插件中保存猫站密钥');
        headers.set('Authorization', 'Bearer ' + key);
    }
    headers.set('Content-Type', 'application/json');
    return headers;
}
function extractOpenAIBody(data) {
    const body = {};
    for (const key of ['messages', 'model', 'temperature', 'frequency_penalty', 'presence_penalty',
        'top_p', 'max_tokens', 'max_completion_tokens', 'stop', 'logit_bias', 'seed', 'n',
        'response_format', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning_effort', 'verbosity']) {
        if (data[key] !== undefined) body[key] = structuredClone(data[key]);
    }
    body.stream = Boolean(data.stream);
    if (data.logprobs > 0) { body.logprobs = true; body.top_logprobs = data.logprobs; }
    Object.assign(body, yamlObject(data.custom_include_body));
    if (data.json_schema) {
        body.response_format = { type: 'json_schema', json_schema: {
            name: data.json_schema.name, strict: data.json_schema.strict ?? true, schema: data.json_schema.value,
        } };
    }
    if (data.custom_exclude_body) {
        const exclusions = yaml.parse(data.custom_exclude_body);
        const keys = Array.isArray(exclusions) ? exclusions
            : typeof exclusions === 'string' ? [exclusions] : Object.keys(exclusions ?? {});
        for (const key of keys) delete body[key];
    }
    if (!body.model || !Array.isArray(body.messages)) throw new Error('最终请求缺少 model 或 messages');
    if (Boolean(body.stream) !== Boolean(data.stream)) throw new Error('自定义 stream 与酒馆流式设置不一致，未提交任务');
    return body;
}
function shouldIntercept(data) {
    if (!getSettings().enabled || data?.chat_completion_source !== 'custom' || !data.model) return false;
    const pattern = String(getSettings().interceptKeyword || 'catiecli');
    if (!new RegExp(pattern, 'i').test(String(data.custom_url ?? ''))) return false;
    // Preserve ST's backend transformations when this browser adapter cannot reproduce them.
    if (data.custom_prompt_post_processing) {
        reportStatus('本次沿用酒馆直连：启用了提示词后处理');
        return false;
    }
    if (loadedAfterPreset) {
        reportStatus('本次沿用酒馆直连：插件在预设之后加载，请刷新页面');
        return false;
    }
    return true;
}
function waitForPoll(ms, signal) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const finish = () => { signal?.removeEventListener('abort', stop); resolve(); };
        const timer = setTimeout(finish, ms);
        const stop = () => { clearTimeout(timer); reject(signal.reason); };
        signal?.addEventListener('abort', stop, { once: true });
    });
}
async function submitTask(upstream, headers, body) {
    // POST is intentionally never retried: a lost response does not mean submission failed.
    let response;
    try {
        response = await originalFetch(upstream + '/v1/openai/tasks', {
            method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
        });
    } catch (error) {
        throw new Error('任务提交结果不明，未自动重提。请用插件的“找回后台任务”核对，避免重复生成。', { cause: error });
    }
    if (!response.ok) throw new Error('任务提交失败：HTTP ' + response.status);
    let data;
    try { data = await response.json(); }
    catch (error) { throw new Error('任务可能已提交，但返回内容不完整；未自动重提。', { cause: error }); }
    if (!data?.id) throw new Error('提交响应没有任务 ID；未自动重提');
    return data.id;
}
async function cancelTask(upstream, headers, id) {
    const response = await originalFetch(upstream + '/v1/openai/tasks/' + encodeURIComponent(id) + '/cancel', {
        method: 'POST', headers, signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('取消任务失败：HTTP ' + response.status);
}
async function pollTask(upstream, headers, id, after, signal, deadline) {
    while (Date.now() < deadline) {
        signal?.throwIfAborted();
        try {
            const timeout = AbortSignal.timeout(Math.max(1, Math.min(15000, deadline - Date.now())));
            const response = await originalFetch(upstream + '/v1/openai/tasks/' + encodeURIComponent(id) + '?after=' + after, {
                headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            });
            if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
                reportStatus('查询暂不可用，继续等待同一个任务：' + id);
                await waitForPoll(2000, signal);
                continue;
            }
            if (!response.ok) throw new Error('任务查询失败：HTTP ' + response.status + '；任务 ' + id);
            return await response.json();
        } catch (error) {
            signal?.throwIfAborted();
            if (!(error instanceof TypeError) && !(error instanceof SyntaxError) && error.name !== 'TimeoutError') throw error;
            reportStatus((error instanceof SyntaxError ? '任务查询返回的 JSON 不完整或无效，继续读取同一个任务：' : '网络暂不可用，继续等待同一个任务：') + id);
            await waitForPoll(Math.min(2000, Math.max(0, deadline - Date.now())), signal);
        }
    }
    throw new Error('任务轮询达到 30 分钟上限：' + id);
}

function recoveryConnection() {
    const settings = getSettings();
    const upstream = normalizeBaseUrl(settings.upstreamOverride || DEFAULT_UPSTREAM);
    return { upstream, headers: resolveHeaders({ custom_url: upstream }, upstream) };
}
async function listTasks(upstream, headers) {
    const response = await originalFetch(upstream + '/v1/openai/tasks', {
        headers, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('找回任务失败：HTTP ' + response.status);
    const result = await response.json();
    if (!Array.isArray(result.data)) throw new Error('任务列表格式异常');
    return result.data;
}
async function readTaskResult(upstream, headers, id, onProgress) {
    const deadline = Date.now() + POLL_MAX_MS;
    let after = 0, text = '';
    while (Date.now() < deadline) {
        const env = await pollTask(upstream, headers, id, after, undefined, deadline);
        if (env.stream || Array.isArray(env.chunks)) {
            const chunks = env.chunks ?? [];
            if (chunks.some(chunk => typeof chunk !== 'string') || env.next_after !== after + chunks.length) {
                throw new Error('找回任务的分片游标异常');
            }
            text += chunks.join('');
            after = env.next_after;
        }
        onProgress(env.status);
        if (env.done) {
            const stream = env.stream || Array.isArray(env.chunks);
            return { text: stream ? text : JSON.stringify(env.result ?? { error: env.error, status: env.status }, null, 2),
                type: stream ? 'text/event-stream' : 'application/json', extension: stream ? 'sse.txt' : 'json',
                status: env.status, error: env.error };
        }
        await waitForPoll(2000);
    }
    throw new Error('找回任务超过等待期限；可稍后重新查询');
}

function envelopeToResponse(env) {
    const success = env.status === 'completed';
    const upstreamCode = env.status_code;
    const status = success ? 200 : env.status === 'cancelled' ? 499
        : Number.isInteger(upstreamCode) && upstreamCode >= 400 && upstreamCode <= 599 ? upstreamCode : 502;
    return new Response(JSON.stringify(env.result ?? { error: { message: env.error || '任务 ' + env.status } }), {
        status, headers: { 'Content-Type': 'application/json' },
    });
}
async function runTaskAsResponse(data, signal) {
    signal?.throwIfAborted();
    const upstream = resolveUpstream(data);
    const headers = resolveHeaders(data, upstream);
    const body = extractOpenAIBody(data);
    const deadline = Date.now() + POLL_MAX_MS;
    const id = await submitTask(upstream, headers, body);
    let finished = false, cancelStarted = false;
    const stop = () => {
        if (finished || cancelStarted) return;
        cancelStarted = true;
        cancelTask(upstream, headers, id).catch(error => reportStatus(error.message + '；任务 ' + id));
    };
    const dispose = () => signal?.removeEventListener('abort', stop);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) { stop(); dispose(); signal.throwIfAborted(); }
    reportStatus('任务已提交：' + id);
    if (!body.stream) {
        try {
            while (Date.now() < deadline) {
                const env = await pollTask(upstream, headers, id, 0, signal, deadline);
                signal?.throwIfAborted();
                if (env.done) {
                    finished = true;
                    reportStatus('任务 ' + env.status + '：' + id);
                    return envelopeToResponse(env);
                }
                await waitForPoll(2000, signal);
            }
            throw new Error('任务超时：' + id);
        } catch (error) {
            if (Date.now() >= deadline) stop();
            reportStatus(error.message + '；任务 ' + id);
            throw error;
        } finally { dispose(); }
    }
    const encoder = new TextEncoder();
    const local = new AbortController();
    const streamSignal = signal ? AbortSignal.any([signal, local.signal]) : local.signal;
    const stream = new ReadableStream({
        async start(controller) {
            let after = 0, pending = '', doneOffset = -1;
            try {
                while (Date.now() < deadline) {
                    const env = await pollTask(upstream, headers, id, after, streamSignal, deadline);
                    streamSignal.throwIfAborted();
                    const chunks = env.chunks ?? [];
                    if (!Array.isArray(chunks) || chunks.some(chunk => typeof chunk !== 'string')
                        || !Number.isInteger(env.next_after) || env.next_after !== after + chunks.length) {
                        throw new Error('任务分片游标异常，已停止续取：' + id);
                    }
                    pending += chunks.join('');
                    const doneMatch = /(?:^|\n)data:\s*\[DONE\]\s*(?:\r?\n|$)/.exec(pending);
                    doneOffset = doneMatch ? doneMatch.index : -1;
                    // Hold the small tail, including a split [DONE], until task status is known.
                    let cut = Math.min(Math.max(0, pending.length - 64), doneOffset < 0 ? Infinity : doneOffset);
                    if (cut && /[\uD800-\uDBFF]/.test(pending[cut - 1])) cut--;
                    if (cut) { controller.enqueue(encoder.encode(pending.slice(0, cut))); pending = pending.slice(cut); }
                    if (doneOffset >= 0) doneOffset -= cut;
                    after = env.next_after;
                    if (env.done) {
                        finished = true;
                        if (env.status !== 'completed') {
                            throw new Error(env.error || env.result?.error?.message || '任务 ' + env.status + '（HTTP ' + (env.status_code ?? 502) + '）');
                        }
                        if (doneOffset < 0) throw new Error('任务已结束但 SSE 缺少 [DONE]，未伪造完整结束标记');
                        controller.enqueue(encoder.encode(pending));
                        pending = '';
                        reportStatus('任务完成：' + id);
                        break;
                    }
                    await waitForPoll(chunks.length ? 500 : 2000, streamSignal);
                }
                if (!finished) throw new Error('任务超时：' + id);
            } catch (error) {
                if (Date.now() >= deadline) stop();
                if (!local.signal.aborted) {
                    const partial = doneOffset < 0 ? pending : pending.slice(0, doneOffset);
                    if (partial) controller.enqueue(encoder.encode(partial));
                    // Never fabricate [DONE] for a failed or truncated response.
                    controller.enqueue(encoder.encode('\n\ndata: ' + JSON.stringify({
                        error: { message: error.message || '请求已停止', task_id: id },
                    }) + '\n\n'));
                }
                reportStatus((error.message || '请求已停止') + '；任务 ' + id);
            } finally {
                dispose();
                if (!local.signal.aborted) controller.close();
            }
        },
        cancel() { local.abort(); stop(); dispose(); },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
}
function installFetchPatch() {
    if (patched) return;
    patched = true;
    window.fetch = async function (input, init) {
        const url = new URL(input instanceof Request ? input.url : input, window.location.href);
        if (url.origin !== window.location.origin || url.pathname !== GENERATE_URL || !getSettings().enabled) {
            return originalFetch(input, init);
        }
        const request = new Request(input instanceof Request ? input.clone() : url, init);
        if (request.method !== 'POST') return originalFetch(input, init);
        const data = await request.clone().json();
        if (!shouldIntercept(data)) return originalFetch(input, init);
        try { return await runTaskAsResponse(data, request.signal); }
        catch (error) {
            reportStatus(error.message);
            // No native-generation fallback after submission, including uncertain POST results.
            throw error;
        }
    };
}

// ===== 扩展 UI(设置面板) =====

async function addSettingsPanel() {
    // 第三方扩展模板路径需带 third-party/ 前缀(静态挂载在
    // /scripts/extensions/third-party/* 下)
    const folder = decodeURIComponent(new URL('.', import.meta.url).pathname).match(/\/third-party\/([^/]+)\//)?.[1];
    if (!folder) throw new Error('无法确定插件安装目录');
    const html = await renderExtensionTemplateAsync('third-party/' + folder, 'settings', {});
    $('#extensions_settings2').append(html);

    const s = getSettings();
    $('#catiecli_tasks_upstream').val(s.upstreamOverride);

    document.getElementById('catiecli_tasks_recover').addEventListener('click', async function () {
        this.disabled = true;
        const list = document.getElementById('catiecli_tasks_list');
        for (const link of list.querySelectorAll('a[download]')) URL.revokeObjectURL(link.href);
        list.replaceChildren();
        try {
            const { upstream, headers } = recoveryConnection();
            const tasks = await listTasks(upstream, headers);
            if (!tasks.length) list.textContent = '此密钥暂无未过期任务。';
            for (const task of tasks) {
                const row = document.createElement('div');
                const label = document.createElement('p');
                const created = task.created_at ? new Date(task.created_at * 1000).toLocaleString() : '';
                label.textContent = [task.model, task.status, created, task.id].filter(Boolean).join(' · ');
                const button = document.createElement('button');
                button.type = 'button'; button.className = 'menu_button'; button.textContent = '读取结果';
                button.addEventListener('click', async () => {
                    button.disabled = true;
                    try {
                        const result = await readTaskResult(upstream, headers, task.id,
                            status => { button.textContent = '读取中：' + status; });
                        const link = document.createElement('a');
                        link.textContent = '下载结果（' + result.status + '）';
                        link.download = task.id + '.' + result.extension;
                        link.href = URL.createObjectURL(new Blob([result.text], { type: result.type }));
                        button.replaceWith(link);
                        if (result.error) label.textContent += ' · ' + result.error;
                    } catch (error) {
                        button.disabled = false; button.textContent = '重新读取';
                        reportStatus(error.message);
                    }
                });
                row.append(label, button); list.append(row);
            }
        } catch (error) { reportStatus(error.message); }
        finally { this.disabled = false; }
    });

    // 一键切换接管(标题栏内的开关)
    $('#catiecli_tasks_enabled').prop('checked', s.enabled).on('change', function () {
        s.enabled = $(this).prop('checked');
        saveSettingsDebounced();
        toastr.info(s.enabled ? '已开启任务 API 接管' : '已关闭接管,恢复 ST 原生直连', 'Catiecli Tasks');
    });

    // 密钥:显示/隐藏;有值时输入框转绿、无值时呼吸提醒
    const keyInput = $('#catiecli_tasks_key');
    keyInput.val(s.apiKey).on('input', function () {
        s.apiKey = String($(this).val());
        $(this).toggleClass('has-key', Boolean(s.apiKey?.trim()));
    });
    keyInput.toggleClass('has-key', Boolean(s.apiKey?.trim()));
    $('#catiecli_tasks_key_toggle').on('click', function () {
        const input = $('#catiecli_tasks_key');
        const isPassword = input.attr('type') === 'password';
        input.attr('type', isPassword ? 'text' : 'password');
        $(this).toggleClass('fa-eye fa-eye-slash');
    });

    // 保存按钮(密钥/上游共用行为:立即落盘 + 打勾反馈 + toast;onSave 抛错则不落盘)
    function bindSaveIcon(selector, onSave) {
        $(selector).on('click', async function () {
            try {
                await onSave();
            } catch (err) {
                console.warn('[st-catiecli-tasks] 保存失败:', err.message);
                return;
            }
            await saveSettings();
            const icon = $(this);
            icon.addClass('fa-check').removeClass('fa-save');
            setTimeout(() => icon.addClass('fa-save').removeClass('fa-check'), 1500);
        });
    }
    bindSaveIcon('#catiecli_tasks_key_save', async () => {
        s.apiKey = String($('#catiecli_tasks_key').val());
        $('#catiecli_tasks_key').toggleClass('has-key', Boolean(s.apiKey?.trim()));
        toastr.success('API 密钥已保存', 'Catiecli Tasks');
    });
    bindSaveIcon('#catiecli_tasks_save', async () => {
        s.upstreamOverride = String($('#catiecli_tasks_upstream').val());
        toastr.success('上游地址已保存', 'Catiecli Tasks');
    });
    $('#catiecli_tasks_keyword').val(s.interceptKeyword ?? 'catiecli');
    bindSaveIcon('#catiecli_tasks_keyword_save', async () => {
        const raw = String($('#catiecli_tasks_keyword').val()).trim();
        try {
            new RegExp(raw, 'i'); // 提前校验,非法正则不落盘
        } catch {
            toastr.error('接管关键词不是合法的正则表达式,未保存', 'Catiecli Tasks');
            throw new Error('invalid regex');
        }
        s.interceptKeyword = raw;
        toastr.success(raw ? `接管关键词已保存:${raw}` : '已清空,恢复默认 catiecli', 'Catiecli Tasks');
    });
}

// ===== 入口 =====

let initialization;
export function init() {
    return initialization ??= addSettingsPanel();
}
loadSettings();
installFetchPatch();
jQuery(() => init().catch(error => {
    console.error('[Catiecli Tasks] 初始化失败', error);
    toastr.error(error.message, 'Catiecli Tasks');
}));
