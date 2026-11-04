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
// 相对路径注意:第三方扩展经 /scripts/extensions/third-party/<name>/ 提供,
// 比内置扩展深一层,所以是 ../../../(内置扩展用 ../../)
import { extension_settings, renderExtensionTemplateAsync, getContext } from '../../../extensions.js';
import { saveSettings, saveSettingsDebounced } from '../../../../script.js';
import { chat_completion_sources } from '../../../openai.js';

const MODULE_NAME = 'st-catiecli-tasks';
const GENERATE_URL = '/api/backends/chat-completions/generate';
const DEFAULT_UPSTREAM = 'https://catiecli.sukaka.top';

/** oai_settings 未从 openai.js 导出;官方扩展 API getContext().chatCompletionSettings 即它 */
function getOaiSettings() {
    return getContext()?.chatCompletionSettings ?? {};
}

// ===== 轮询节奏(代码内固定,非用户设置) =====
const POLL_INTERVAL_MS = 2000;   // 常规轮询间隔(等待中,无新分片)
const BUSY_POLL_INTERVAL_MS = 500; // 流式打字机跟进间隔(有新分片时)
const NET_RETRY_MAX = 3;         // 网络错误重试次数(3 次都连不上才报错)
const NET_RETRY_BASE_MS = 1000;  // 重试退避基数(1s→2s→4s)
const POLL_MAX_MINUTES = 30;     // 单任务最长轮询时间

// ===== 设置(仅用户真正会改的东西) =====
const defaultSettings = {
    enabled: false,              // 总开关:接管 Custom 源的生成请求
    apiKey: '',                  // cat- 密钥(扩展自存,不依赖 ST secret)
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

/** 规范化 base:去尾斜杠,剥掉 ST 后端会拼路径的 /v1、/v1beta 段 */
function normalizeBaseUrl(raw) {
    return String(raw || '').trim().replace(/\/+$/, '').replace(/\/(v1|v1beta)(\/|$)/gi, '');
}

/** 判断 URL 是否指向 catiecli(域名/整串含 catiecli 字样,大小写不敏感) */
function isCatiecliUrl(raw) {
    return normalizeBaseUrl(raw).toLowerCase().includes('catiecli');
}

/** 本次请求原定要打的上游(判定用,不含 override):请求体 custom_url 优先,缺席时用连接面板地址 */
function requestTargetUrl(generateData) {
    const fromBody = String(generateData?.custom_url ?? '').trim();
    if (fromBody) return fromBody;
    return String(getOaiSettings().custom_url ?? '').trim();
}

/** 上游 base(已确定接管后调用):强制上游 > 请求体/面板地址,否则默认线上 */
function resolveUpstream(generateData) {
    const s = getSettings();
    if (s.upstreamOverride?.trim()) {
        return normalizeBaseUrl(s.upstreamOverride);
    }
    const target = requestTargetUrl(generateData);
    if (target) return normalizeBaseUrl(target);
    return DEFAULT_UPSTREAM;
}

/** 读取 cat- 密钥:扩展设置里自带(不依赖 ST secret 存储/权限) */
function resolveApiKey() {
    const key = getSettings().apiKey?.trim();
    if (key) return key;
    throw new Error('未设置 API 密钥:请在 Catiecli Tasks 扩展面板填写 cat- 密钥并保存');
}

// ===== 网络重试包装(连不上才重试;HTTP 错误是明确响应,直接抛) =====

function isNetworkError(err) {
    return err instanceof TypeError || ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT']
        .includes(err?.cause?.code);
}

async function withNetRetry(label, fn) {
    let lastErr = null;
    for (let attempt = 1; attempt <= NET_RETRY_MAX; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (err instanceof Error && err.statusCode !== undefined) throw err; // HTTP 错误:透传
            if (!isNetworkError(err)) throw err;
            lastErr = err;
            if (attempt < NET_RETRY_MAX) {
                const delay = Math.min(NET_RETRY_BASE_MS * (2 ** (attempt - 1)), 8000);
                console.warn(`[st-catiecli-tasks] ${label} 网络错误(第 ${attempt}/${NET_RETRY_MAX} 次),${delay / 1000}s 后重试: ${err.message}`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw Object.assign(
        new Error(`${label}: 连续 ${NET_RETRY_MAX} 次无法连接上游(${lastErr?.message ?? '网络错误'})`),
        { statusCode: 502 },
    );
}

// ===== 任务 API 客户端 =====

async function submitTask(upstream, apiKey, body) {
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
    }));
}

async function pollTask(upstream, apiKey, taskId, after) {
    return withNetRetry('任务轮询', () => fetch(`${upstream}/v1/openai/tasks/${encodeURIComponent(taskId)}?after=${after}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
    }).then(async resp => {
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw Object.assign(new Error(`任务查询失败: ${resp.status} ${text.slice(0, 500)}`), { statusCode: resp.status });
        }
        return resp.json();
    }));
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

/** 是否应拦截本次 generate 请求(逐请求判定,不依赖面板全局状态) */
function shouldIntercept(generateData) {
    const s = getSettings();
    if (!s.enabled) return false;
    // 仅接管 Custom (OpenAI-compatible) 源 —— 以请求体为准:
    // 第三方插件走同一个 /generate 端点,请求体自带各自的 chat_completion_source
    if (generateData?.chat_completion_source !== chat_completion_sources.CUSTOM) return false;
    if (!generateData || typeof generateData !== 'object' || !generateData.model) return false;
    // 逐请求判定本次请求要打的上游:请求体 custom_url 优先(第三方插件自带),
    // 缺席时兜底连接面板地址。仅当它指向 catiecli 才接管,其他 API 自动直连。
    // upstreamOverride 表示「我的连接地址是 catiecli 反代(域名不含 catiecli 字样),
    // 强制接管」—— 仅当请求体没有自带 custom_url 时生效(即用户自己的连接),
    // 不会劫走第三方插件显式带 URL 的请求。
    const target = requestTargetUrl(generateData);
    if (!target) return false;
    if (s.upstreamOverride?.trim() && !String(generateData?.custom_url ?? '').trim()) return true;
    return isCatiecliUrl(target);
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
function streamTaskResponse(upstream, apiKey, taskId, signal) {
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller) {
            const deadline = Date.now() + POLL_MAX_MINUTES * 60 * 1000;
            let after = 0;
            try {
                let nextDelay = POLL_INTERVAL_MS;
                while (Date.now() < deadline) {
                    if (signal?.aborted) break;
                    await new Promise(r => setTimeout(r, nextDelay));
                    if (signal?.aborted) break;

                    const env = await pollTask(upstream, apiKey, taskId, after);
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
                    nextDelay = (env.chunks?.length ?? 0) > 0 ? BUSY_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
                }
                if (Date.now() >= deadline && !signal?.aborted) {
                    await cancelTask(upstream, apiKey, taskId);
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: `任务 ${taskId} 超时(${POLL_MAX_MINUTES} 分钟)`, code: 504 } })}\n\n`));
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
    const upstream = resolveUpstream(generateData);
    const apiKey = await resolveApiKey();
    const requestBody = extractOpenAIBody(generateData);

    const taskId = await submitTask(upstream, apiKey, requestBody);
    console.info(`[st-catiecli-tasks] 任务已提交: ${taskId}(stream=${requestBody.stream})`);

    if (!requestBody.stream) {
        // 非流式:轮询到终态,返回伪 JSON Response
        const deadline = Date.now() + POLL_MAX_MINUTES * 60 * 1000;
        let after = 0;
        let env = null;
        while (Date.now() < deadline) {
            if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
            env = await pollTask(upstream, apiKey, taskId, after);
            after = env.next_after ?? after;
            if (env.done) break;
            env = null;
        }
        if (!env) {
            await cancelTask(upstream, apiKey, taskId);
            throw Object.assign(new Error(`任务 ${taskId} 超过 ${POLL_MAX_MINUTES} 分钟未完成`), { statusCode: 504 });
        }
        return envelopeToResponse(env);
    }

    return streamTaskResponse(upstream, apiKey, taskId, signal);
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

    // 一键切换接管(标题栏内的开关)
    $('#catiecli_tasks_enabled').prop('checked', s.enabled).on('change', function () {
        s.enabled = $(this).prop('checked');
        if (s.enabled) {
            installFetchPatch();
        } else {
            uninstallFetchPatch();
        }
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

    // 保存按钮(密钥/上游共用行为:立即落盘 + 打勾反馈 + toast)
    function bindSaveIcon(selector, onSave) {
        $(selector).on('click', async function () {
            await onSave();
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
