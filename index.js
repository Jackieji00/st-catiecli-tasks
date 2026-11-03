/**
 * Catiecli Tasks — SillyTavern UI 扩展(纯前端,Extensions 贴 git 链接即装)
 *
 * 用 catiecli 的「任务 API」(提交 + 轮询分片)接管 SillyTavern 的 Chat
 * Completion 生成请求,根治长连接网络不稳定:断网/切后台不再报废整个回复。
 *
 * 工作方式:
 *   ST 前端 sendOpenAIRequest 会 fetch('/api/backends/chat-completions/generate')
 *   本扩展 patch window.fetch 拦截该请求,改为在浏览器内直接:
 *     1. POST {catiecli}/v1/openai/tasks      提交任务(秒回 task_id)
 *     2. GET  {catiecli}/v1/openai/tasks/{id}?after=N  轮询增量分片
 *     3. 分片原样推进 ReadableStream → 返回伪 Response 给 ST 的 SSE 解析器
 *   (catiecli 全站 CORS 放行,浏览器可直连)
 *
 * 使用(Extensions 里启用本扩展后):
 *   1. API 选 Chat Completion → 源选 Custom (OpenAI-compatible)
 *   2. Custom Endpoint 填 catiecli 地址,如 https://catiecli.sukaka.top/v1
 *   3. API 密钥填 cat- 密钥(本扩展直接复用该密钥,无需另填)
 *   4. 连接(后端直连 catiecli /v1/models,标准协议)→ 选模型 → 生成
 *
 * 断网行为:提交/轮询自动重试(3 次指数退避),3 次都连不上才报错;
 * ST 侧中断(停止按钮)→ 扩展发 cancel,不浪费上游额度。
 */
import { extension_settings, renderExtensionTemplateAsync } from '../../extensions.js';
import { saveSettingsDebounced } from '../../../script.js';
import { oai_settings, chat_completion_sources } from '../../openai.js';
import { SECRET_KEYS, findSecret } from '../../secrets.js';

const MODULE_NAME = 'st-catiecli-tasks';
const GENERATE_URL = '/api/backends/chat-completions/generate';
const DEFAULT_UPSTREAM = 'https://catiecli.sukaka.top';

// ===== 设置 =====
const defaultSettings = {
    enabled: true,               // 总开关:接管 Custom 源的生成请求
    pollIntervalMs: 800,        // 常规轮询间隔
    busyPollIntervalMs: 60,      // 有新分片时的快速跟进间隔(准流式)
    netRetryMax: 3,              // 网络错误重试次数
    netRetryBaseMs: 1000,        // 重试退避基数(1s→2s→4s)
    pollMaxMinutes: 30,          // 单任务最长轮询时间
    upstreamOverride: '',        // 留空用 Custom Endpoint;否则强制此地址
};

function loadSettings() {
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || {};
    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
}

function getSettings() {
    return extension_settings[MODULE_NAME] ?? defaultSettings;
}

// ===== 上游地址与密钥 =====

/** 上游 base:扩展设置强制地址 > Custom Endpoint(剥掉尾部 /v1) > 默认线上 */
function resolveUpstream() {
    const s = getSettings();
    if (s.upstreamOverride?.trim()) {
        return s.upstreamOverride.trim().replace(/\/+$/, '');
    }
    // custom_url 形如 https://catiecli.sukaka.top/v1(ST 后端会拼 /chat/completions)
    const url = (oai_settings.custom_url || '').replace(/\/+$/, '');
    if (url) {
        return url.replace(/\/(v1|v1beta)$/i, '');
    }
    return DEFAULT_UPSTREAM;
}

/** 读取 cat- 密钥:复用 Custom 源 secret(经 ST 后端 API 读,不另存一份) */
let cachedKey = null;
async function resolveApiKey() {
    if (cachedKey) return cachedKey;
    try {
        const value = await findSecret(SECRET_KEYS.CUSTOM);
        if (value) {
            cachedKey = value;
            return value;
        }
    } catch {
        // ignore
    }
    throw new Error('未找到 API 密钥:请在 API 连接面板为 Custom 源设置 cat- 密钥');
}

// ===== 网络重试包装(连不上才重试;HTTP 错误是明确响应,直接抛) =====

function isNetworkError(err) {
    return err instanceof TypeError || ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT']
        .includes(err?.cause?.code);
}

async function withNetRetry(label, fn, settings) {
    let lastErr = null;
    for (let attempt = 1; attempt <= settings.netRetryMax; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (err instanceof Error && err.statusCode !== undefined) throw err; // HTTP 错误:透传
            if (!isNetworkError(err)) throw err;
            lastErr = err;
            if (attempt < settings.netRetryMax) {
                const delay = Math.min(settings.netRetryBaseMs * (2 ** (attempt - 1)), 8000);
                console.warn(`[st-catiecli-tasks] ${label} 网络错误(第 ${attempt}/${settings.netRetryMax} 次),${delay / 1000}s 后重试: ${err.message}`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw Object.assign(
        new Error(`${label}: 连续 ${settings.netRetryMax} 次无法连接上游(${lastErr?.message ?? '网络错误'})`),
        { statusCode: 502 },
    );
}

// ===== 任务 API 客户端 =====

async function submitTask(upstream, apiKey, body, settings) {
    return withNetRetry('任务提交', () => fetch(`${upstream}/v1/openai/tasks`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }).then(async resp => {
        const text = await resp.text();
        if (!resp.ok) {
            throw Object.assign(new Error(`任务提交失败: ${resp.status} ${text.slice(0, 500)}`), { statusCode: resp.status });
        }
        const data = JSON.parse(text);
        if (!data?.id) throw new Error('任务提交未返回 task_id');
        return data.id;
    }), settings);
}

async function pollTask(upstream, apiKey, taskId, after, settings) {
    return withNetRetry('任务轮询', () => fetch(`${upstream}/v1/openai/tasks/${encodeURIComponent(taskId)}?after=${after}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
    }).then(async resp => {
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw Object.assign(new Error(`任务查询失败: ${resp.status} ${text.slice(0, 500)}`), { statusCode: resp.status });
        }
        return resp.json();
    }), settings);
}

async function cancelTask(upstream, apiKey, taskId) {
    try {
        await fetch(`${upstream}/v1/openai/tasks/${encodeURIComponent(taskId)}/cancel`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}` },
        });
    } catch (err) {
        console.warn(`[st-catiecli-tasks] 取消任务 ${taskId} 失败:`, err.message);
    }
}

// ===== fetch 拦截:接管生成请求 =====

const originalFetch = window.fetch;
let patched = false;

/** 从 ST 的 generate_data 提取 OpenAI 协议字段(与 ST 后端发给上游的请求体同构) */
function extractOpenAIBody(generateData) {
    const body = {
        messages: generateData.messages,
        model: generateData.model,
        temperature: generateData.temperature,
        frequency_penalty: generateData.frequency_penalty,
        presence_penalty: generateData.presence_penalty,
        top_p: generateData.top_p,
        max_tokens: generateData.max_tokens,
        max_completion_tokens: generateData.max_completion_tokens,
        stream: !!generateData.stream,
        stop: generateData.stop,
        logit_bias: generateData.logit_bias,
        seed: generateData.seed,
        n: generateData.n,
        response_format: generateData.response_format,
        tools: generateData.tools,
        tool_choice: generateData.tool_choice,
        reasoning_effort: generateData.reasoning_effort,
        verbosity: generateData.verbosity,
    };
    // 移除 undefined 字段,避免 catiecli 收到无意义 null
    for (const k of Object.keys(body)) {
        if (body[k] === undefined) delete body[k];
    }
    return body;
}

/** 是否应拦截本次 generate 请求 */
function shouldIntercept(generateData) {
    const s = getSettings();
    if (!s.enabled) return false;
    // 仅接管 Custom (OpenAI-compatible) 源
    if (oai_settings.chat_completion_source !== chat_completion_sources.CUSTOM) return false;
    if (!generateData || typeof generateData !== 'object' || !generateData.model) return false;
    return true;
}

/** 非流式:envelope → 伪 Response(failed 时 ok=false,ST 会弹错并透传错误体) */
function envelopeToResponse(env) {
    const status = env.status === 'failed'
        ? (env.status_code ?? 502)
        : (env.status === 'cancelled' ? 499 : 200);
    const body = env.status === 'completed'
        ? JSON.stringify(env.result ?? {})
        : JSON.stringify(env.result ?? { error: { message: env.error ?? `任务 ${env.status}`, code: status } });
    return new Response(body, {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

/** 流式:伪 SSE Response,分片推进 ReadableStream(准流式) */
function streamTaskResponse(upstream, apiKey, taskId, settings, signal) {
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller) {
            const deadline = Date.now() + settings.pollMaxMinutes * 60 * 1000;
            let after = 0;
            try {
                let nextDelay = settings.pollIntervalMs;
                while (Date.now() < deadline) {
                    if (signal?.aborted) break;
                    await new Promise(r => setTimeout(r, nextDelay));
                    if (signal?.aborted) break;

                    const env = await pollTask(upstream, apiKey, taskId, after, settings);
                    for (const chunk of (env.chunks ?? [])) {
                        controller.enqueue(encoder.encode(chunk));
                    }
                    after = env.next_after ?? after;

                    if (env.done) {
                        const joined = (env.chunks ?? []).join('');
                        // failed 且无错误帧时补一帧让 ST 弹 toast
                        if (env.status === 'failed' && env.error && !joined.includes('"error"')) {
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: env.error, code: env.status_code ?? 502 } })}\n\n`));
                        }
                        if (env.status === 'cancelled' && !joined.includes('"error"')) {
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: '任务已取消', code: 499 } })}\n\n`));
                        }
                        // 上游 SSE 缺 [DONE] 时补齐(ST 靠它结束流)
                        if (!joined.includes('[DONE]')) {
                            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                        }
                        break;
                    }
                    // 有新分片 → 快速跟进(准流式);否则常规节奏
                    nextDelay = (env.chunks?.length ?? 0) > 0 ? settings.busyPollIntervalMs : settings.pollIntervalMs;
                }
                if (Date.now() >= deadline && !signal?.aborted) {
                    await cancelTask(upstream, apiKey, taskId);
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: `任务 ${taskId} 超时(${settings.pollMaxMinutes} 分钟)`, code: 504 } })}\n\n`));
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                }
            } catch (err) {
                try {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: err.message ?? String(err), code: err.statusCode ?? 502 } })}\n\n`));
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                } catch {
                    // controller 已关闭
                }
            } finally {
                try { controller.close(); } catch { /* already closed */ }
            }
        },
        cancel() {
            // ST 侧取消(停止按钮/断开):取消任务,不浪费上游额度
            cancelTask(upstream, apiKey, taskId);
        },
    });

    return new Response(stream, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
        },
    });
}

/** 把 catiecli 任务跑成一个伪 Response(SSE 流或 JSON),接口与 ST 期望一致 */
async function runTaskAsResponse(generateData, signal) {
    const settings = getSettings();
    const upstream = resolveUpstream();
    const apiKey = await resolveApiKey();
    const requestBody = extractOpenAIBody(generateData);

    const taskId = await submitTask(upstream, apiKey, requestBody, settings);
    console.info(`[st-catiecli-tasks] 任务已提交: ${taskId}(stream=${requestBody.stream})`);

    if (!requestBody.stream) {
        // 非流式:轮询到终态,返回伪 JSON Response
        const deadline = Date.now() + settings.pollMaxMinutes * 60 * 1000;
        let after = 0;
        let env = null;
        while (Date.now() < deadline) {
            if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
            await new Promise(r => setTimeout(r, settings.pollIntervalMs));
            env = await pollTask(upstream, apiKey, taskId, after, settings);
            after = env.next_after ?? after;
            if (env.done) break;
            env = null;
        }
        if (!env) {
            await cancelTask(upstream, apiKey, taskId);
            throw Object.assign(new Error(`任务 ${taskId} 超过 ${settings.pollMaxMinutes} 分钟未完成`), { statusCode: 504 });
        }
        return envelopeToResponse(env);
    }

    return streamTaskResponse(upstream, apiKey, taskId, settings, signal);
}

function installFetchPatch() {
    if (patched) return;
    patched = true;
    window.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : input?.url ?? '';
        if (url.includes(GENERATE_URL) && init?.method?.toUpperCase() === 'POST' && init?.body) {
            try {
                const generateData = JSON.parse(init.body);
                if (shouldIntercept(generateData)) {
                    console.info('[st-catiecli-tasks] 接管生成请求 →', generateData.model);
                    return await runTaskAsResponse(generateData, init.signal ?? null);
                }
            } catch (err) {
                if (err instanceof DOMException && err.name === 'AbortError') throw err;
                // 拦截失败(缺密钥/JSON 问题):透传原始请求并提示
                console.error('[st-catiecli-tasks] 接管失败,回退 ST 原生请求:', err);
                if (typeof toastr !== 'undefined') {
                    toastr.warning(`Catiecli Tasks 接管失败: ${err.message}`, '已回退直连模式');
                }
            }
        }
        return originalFetch.call(this, input, init);
    };
    console.info('[st-catiecli-tasks] fetch 拦截已安装(仅接管 Custom 源生成请求)');
}

function uninstallFetchPatch() {
    if (!patched) return;
    window.fetch = originalFetch;
    patched = false;
}

// ===== 扩展 UI(设置面板) =====

async function addSettingsPanel() {
    // 第三方扩展模板路径需带 third-party/ 前缀(静态挂载在
    // /scripts/extensions/third-party/* 下)
    const html = await renderExtensionTemplateAsync('third-party/st-catiecli-tasks', 'settings', {});
    $('#extensions_settings2').append(html);

    const s = getSettings();
    $('#catiecli_tasks_enabled').prop('checked', s.enabled).on('change', function () {
        s.enabled = $(this).prop('checked');
        s.enabled ? installFetchPatch() : uninstallFetchPatch();
        saveSettingsDebounced();
    });
    $('#catiecli_tasks_upstream').val(s.upstreamOverride).on('input', function () {
        s.upstreamOverride = String($(this).val());
        saveSettingsDebounced();
    });
    $('#catiecli_tasks_status').on('click', testConnection);
}

async function testConnection() {
    const btn = $('#catiecli_tasks_status');
    const original = btn.html();
    btn.prop('disabled', true).html('测试中...');
    try {
        const upstream = resolveUpstream();
        const apiKey = await resolveApiKey();
        const resp = await withNetRetry('连通性测试', () => fetch(`${upstream}/v1/models`, {
            headers: { 'Authorization': `Bearer ${apiKey}` },
        }), getSettings());
        if (resp.ok) {
            const data = await resp.json();
            const count = Array.isArray(data?.data) ? data.data.length : 0;
            toastr.success(`连接成功,${count} 个模型可用(${upstream})`, 'Catiecli Tasks');
        } else {
            const text = await resp.text().catch(() => '');
            toastr.error(`上游返回 ${resp.status}: ${text.slice(0, 200)}`, 'Catiecli Tasks');
        }
    } catch (err) {
        toastr.error(err.message, 'Catiecli Tasks');
    } finally {
        btn.prop('disabled', false).html(original);
    }
}

// ===== 入口 =====

export async function init() {
    loadSettings();
    await addSettingsPanel();
    if (getSettings().enabled) {
        installFetchPatch();
    }
    console.info('[st-catiecli-tasks] Catiecli Tasks 扩展已加载(任务 API 接管模式)');
}
