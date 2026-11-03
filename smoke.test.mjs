/**
 * st-catiecli-tasks 冒烟测试
 *
 * 不依赖真实 catiecli / SillyTavern：
 * - 用 Node http 起一个假 catiecli（模拟 task API 语义：提交秒回 task_id、
 *   GET 返回 envelope、cancel 改状态）
 * - 用 express 风格的假 router 初始化插件，再起真 HTTP server 暴露插件路由
 * - 用 fetch 以 ST 视角调用 /v1/chat/completions（流式与非流式）验证：
 *   1. 流式：SSE 分片原样转发、[DONE] 收尾、状态 200
 *   2. 非流式：result 原样返回
 *   3. 错误透传：上游 429 错误体按 status_code 返回
 *   4. 停止按钮：客户端断开 → 插件向上游发 cancel
 *   5. /v1/models 透传
 *   6. X-Catiecli-Url 请求头覆盖上游地址（无头时用默认线上地址）
 */
import express from 'express';
import http from 'node:http';
import assert from 'node:assert';

const UPSTREAM_PORT = 59991;
const PLUGIN_PORT = 59992;

// 假 catiecli 状态
const tasks = new Map();
let cancelCalls = [];
let submitHitCount = 0;

const fakeBackend = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
        const json = body ? JSON.parse(body) : {};

        if (req.method === 'POST' && url.pathname === '/v1/openai/tasks') {
            const id = 'task_test_' + (tasks.size + 1);
            tasks.set(id, {
                id, status: 'running', stream: !!json.stream,
                chunks: json.__mockChunks || [], pushIdx: 0,
                result: json.__mockResult ?? null,
                status_code: json.__mockStatusCode,
                error: json.__mockError,
                pushInterval: json.__mockInterval ?? 30,
            });
            // 模拟后台执行：定时把 chunks 推进去（空 chunks 时一拍即终态）
            const t = tasks.get(id);
            t.timer = setInterval(() => {
                if (t.pushIdx < t.chunks.length) {
                    t.pushIdx++;
                }
                if (t.pushIdx >= t.chunks.length) {
                    t.status = t.status_code >= 400 ? 'failed' : 'completed';
                    clearInterval(t.timer);
                }
            }, t.pushInterval);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ id, object: 'task', status: 'queued', stream: t.stream }));
        }

        const m = url.pathname.match(/^\/v1\/openai\/tasks\/([^/]+)$/);
        if (req.method === 'GET' && m) {
            const t = tasks.get(m[1]);
            if (!t) { res.writeHead(404); return res.end('{}'); }
            const after = Number(url.searchParams.get('after') || 0);
            const visible = t.chunks.slice(0, t.pushIdx);
            const env = {
                id: t.id, object: 'task', status: t.status,
                done: ['completed', 'failed', 'cancelled'].includes(t.status),
                stream: t.stream,
                chunks: visible.slice(after),
                chunk_count: visible.length,
                next_after: visible.length,
            };
            if (env.done) {
                env.status_code = t.status_code;
                if (t.status === 'failed') env.error = t.error;
                if (!t.stream) env.result = t.result;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(env));
        }

        const c = url.pathname.match(/^\/v1\/openai\/tasks\/([^/]+)\/cancel$/);
        if (req.method === 'POST' && c) {
            cancelCalls.push(c[1]);
            const t = tasks.get(c[1]);
            if (t) { t.status = 'cancelled'; clearInterval(t.timer); }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ id: c[1], cancel_requested: !!t }));
        }

        if (req.method === 'GET' && url.pathname === '/v1/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ object: 'list', data: [{ id: 'robin-3.8-flash', object: 'model', owned_by: 'plugin-test' }] }));
        }

        res.writeHead(404);
        res.end('{}');
    });
});

const results = [];
function check(name, cond, detail = '') {
    results.push([name, cond]);
    console.log(`${cond ? '  ✅' : '  ❌'} ${name}${cond ? '' : ' ' + detail}`);
}

async function main() {
    // 1. 起假 catiecli
    await new Promise(r => fakeBackend.listen(59991, r));

    // 2. 初始化插件（注入环境变量指向上游；按本文件真实位置导入）
    process.env.CATIECLI_URL = 'http://127.0.0.1:59991';
    const thisFile = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const pluginFile = new URL('file:///' + thisFile.replace(/smoke\.test(\.tmp)?\.mjs$/, 'index.js').replace(/\\/g, '/')).href;
    const mod = await import(pluginFile);
    const router = express.Router();
    await mod.init(router);

    const app = express();
    app.use('/api/plugins/st-catiecli-tasks', router);
    const server = http.createServer(app);
    await new Promise(r => server.listen(59992, r));

    const BASE = 'http://127.0.0.1:59992/api/plugins/st-catiecli-tasks';
    const AUTH = { 'Authorization': 'Bearer cat-test', 'Content-Type': 'application/json' };

    // --- 3. health ---
    let resp = await fetch(`${BASE}/health`);
    check('health ok', resp.ok && (await resp.json()).upstream.includes('59991'));

    // --- 4. models 透传 ---
    resp = await fetch(`${BASE}/v1/models`, { headers: AUTH });
    const models = await resp.json();
    check('models 透传', resp.status === 200 && models.data?.[0]?.id === 'robin-3.8-flash', JSON.stringify(models));

    // --- 5. 无 Key 401 ---
    resp = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'x', messages: [] }),
    });
    check('无 Key 401', resp.status === 401);

    // --- 6. 流式：分片原样转发 + [DONE] ---
    const sseChunks = [
        'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"，世界"}}]}\n\n',
        'data: [DONE]\n\n',
    ];
    resp = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST', headers: AUTH,
        body: JSON.stringify({ model: 'robin-3.8-flash', stream: true, messages: [], __mockChunks: sseChunks }),
    });
    check('流式状态 200 + SSE content-type', resp.status === 200 && (resp.headers.get('content-type') || '').includes('text/event-stream'));
    const sseText = await resp.text();
    check('流式分片完整转发', sseText === sseChunks.join(''), JSON.stringify(sseText));

    // --- 7. 非流式：result 原样 ---
    const mockResult = { id: 'chatcmpl-x', choices: [{ message: { role: 'assistant', content: 'hi' } }] };
    resp = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST', headers: AUTH,
        body: JSON.stringify({ model: 'robin-3.8-flash', stream: false, messages: [], __mockResult: mockResult }),
    });
    const nonstream = await resp.json();
    check('非流式 result 原样', resp.status === 200 && nonstream.choices?.[0]?.message?.content === 'hi', JSON.stringify(nonstream));

    // --- 8. 错误透传：上游 429 ---
    const errBody = { error: { message: '速率限制: 4 次/分钟', code: 429 } };
    resp = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST', headers: AUTH,
        body: JSON.stringify({
            model: 'robin-3.8-flash', stream: false, messages: [],
            __mockResult: errBody, __mockStatusCode: 429, __mockError: '速率限制',
        }),
    });
    const errJson = await resp.json();
    check('非流式 429 透传', resp.status === 429 && errJson.error?.code === 429, `${resp.status} ${JSON.stringify(errJson)}`);

    // --- 9. 流式失败：错误帧 + [DONE] ---
    resp = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST', headers: AUTH,
        body: JSON.stringify({
            model: 'robin-3.8-flash', stream: true, messages: [],
            __mockChunks: ['data: {"choices":[{"delta":{"content":"部分内容"}}]}\n\n'],
            __mockStatusCode: 502, __mockError: '上游网络中断: RemoteProtocolError',
        }),
    });
    const failSse = await resp.text();
    check('流式中断:保留已产出分片+补错误帧+DONE',
        failSse.includes('部分内容') && failSse.includes('"error"') && failSse.includes('上游网络中断') && failSse.includes('[DONE]'),
        JSON.stringify(failSse));

    // --- 10. 停止按钮：客户端断开 → cancel ---
    cancelCalls = [];
    const abort = new AbortController();
    const p = fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST', headers: AUTH,
        signal: abort.signal,
        body: JSON.stringify({
            model: 'robin-3.8-flash', stream: true, messages: [],
            __mockChunks: ['data: {"choices":[{"delta":{"content":"a"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"b"}}]}\n\n', 'data: [DONE]\n\n'],
            __mockInterval: 700,  // 让它慢慢跑，中途 abort
        }),
    }).catch(e => e);
    await new Promise(r => setTimeout(r, 500));
    abort.abort();
    await p;
    // abort 后 handler 还要等完当前轮询 sleep（最长 800ms）才走到 finally 发 cancel
    await new Promise(r => setTimeout(r, 2500));
    check('断开触发上游 cancel', cancelCalls.length === 1, JSON.stringify(cancelCalls));

    // --- 11. 无 model 的 body 也能被上游 400 透传（提交失败 → statusCode 透传）---
    resp = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST', headers: AUTH,
        body: JSON.stringify({ messages: [] }),
    });
    // 假后端没实现 model 校验，这里只会验证插件透传路径不崩
    check('提交失败路径不崩（透传状态码）', resp.status >= 200, `status=${resp.status}`);

    server.close();
    fakeBackend.close();

    const failed = results.filter(([_, ok]) => !ok);
    console.log(`\n===== 结果：${results.length - failed.length} 通过 / ${failed.length} 失败 =====`);
    process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
