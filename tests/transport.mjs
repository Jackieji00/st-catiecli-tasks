import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const yamlRoot = process.env.YAML_PACKAGE || path.dirname(require.resolve('yaml/package.json'));
const root = fileURLToPath(new URL('../', import.meta.url));
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
execFileSync(process.execPath, ['--check', '--input-type=module'], { input: source });
const core = source.slice(0, source.indexOf('// ===== 扩展 UI')).replace(/^import .*$/gm, '');
const tasks = new Map(), posts = [], cancels = [], queries = [];
let nativeRequests = 0, socketFailures = 0;
const tool = { id: 'synthetic', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'tool-1', type: 'function',
    function: { name: 'transam_content', arguments: '{"content":"合成中文😀"}' } }] }, finish_reason: null }] };
const rawSse = 'data: ' + JSON.stringify(tool) + '\n\ndata: ' + JSON.stringify({
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
}) + '\n\ndata: [DONE]\n\n';
const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname.startsWith('/yaml/')) {
            const relative = url.pathname.slice('/yaml/'.length);
            const filename = path.resolve(yamlRoot, relative);
            if (!filename.startsWith(path.resolve(yamlRoot) + path.sep)) { res.writeHead(403).end(); return; }
            res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(filename)); return;
        }
        if (url.pathname === '/') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end('<!doctype html><body><p id="catiecli_tasks_status"></p><script type="module">' +
                'import yaml from "/yaml/browser/index.js"; const extension_settings = {};\n' +
                'window.submissionCalls = 0; const networkFetch = window.fetch.bind(window); window.fetch = (input, init) => { if (String(input).endsWith("/v1/openai/tasks") && init?.method === "POST") window.submissionCalls++; return networkFetch(input, init); };\n' +
                (url.searchParams.has('late') ? 'window.ta_outer_transport_status = { phase: "installed" };\n' : '') +
                core + '\nloadSettings(); installFetchPatch(); window.qa = { settings:getSettings(), extractOpenAIBody, resolveHeaders, normalizeBaseUrl, listTasks, readTaskResult };' +
                '</script>'); return;
        }
        if (url.pathname === '/api/backends/chat-completions/generate') {
            nativeRequests++; res.setHeader('Content-Type', 'application/json'); res.end('{"native":true}'); return;
        }
        if (url.pathname === '/v1/openai/tasks' && req.method === 'POST') {
            let input = ''; for await (const chunk of req) input += chunk;
            const body = JSON.parse(input), id = 'task_' + (tasks.size + 1);
            posts.push({ body, headers: req.headers }); tasks.set(id, { body, failures: 0 });
            if (body.model === 'uncertain') { req.socket.destroy(); return; }
            res.setHeader('Content-Type', 'application/json');
            if (body.model === 'stop-submit') await new Promise(resolve => setTimeout(resolve, 250));
            res.end(JSON.stringify({ id, status: 'queued' })); return;
        }
        if (url.pathname === '/v1/openai/tasks' && req.method === 'GET') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ data: [...tasks].map(([id, task]) => ({
                id, model: task.body.model, stream: task.body.stream, status: 'completed', created_at: 1762156900,
            })) })); return;
        }
        const match = /^\/v1\/openai\/tasks\/(task_\d+)(\/cancel)?$/.exec(url.pathname);
        if (match) {
            const [, id, cancel] = match, task = tasks.get(id);
            if (cancel) { cancels.push(id); res.setHeader('Content-Type', 'application/json'); res.end('{"status":"cancelled"}'); return; }
            const after = Number(url.searchParams.get('after')); queries.push({ id, after });
            if (task.body.model === 'reconnect' && !task.failures++) { socketFailures++; req.socket.destroy(); return; }
            if (task.body.model === 'unavailable' && !task.failures++) {
                res.writeHead(503).end(); return;
            }
            let env;
            if (task.body.model === 'waiting' || task.body.model === 'stop-submit') {
                env = { status: 'running', done: false, chunks: [], next_after: after };
            } else if (!task.body.stream) {
                env = { status: 'completed', done: true, result: { choices: [{ message: { content: '{"events":[]}' } }] } };
            } else if (task.body.model === 'failed') {
                env = { status: 'failed', done: true, status_code: 429, result: { error: { message: 'synthetic quota error' } },
                    chunks: [rawSse], next_after: 1 };
            } else if (task.body.model === 'truncated') {
                env = { status: 'completed', done: true, chunks: [rawSse.replace('data: [DONE]\n\n', '')], next_after: 1 };
            } else {
                const chunks = [rawSse.slice(0, 29), rawSse.slice(29, -5), rawSse.slice(-5)];
                const done = after === chunks.length - 1;
                env = { status: done ? 'completed' : 'running', done, chunks: [chunks[after]], next_after: after + 1 };
            }
            res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(env)); return;
        }
        res.writeHead(404).end();
    } catch (error) { res.writeHead(500).end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let browser;
try {
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined, headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => window.qa);
    await page.evaluate(origin => {
        Object.assign(qa.settings, { enabled: true, apiKey: 'synthetic-main-key', upstreamOverride: origin, interceptKeyword: '127\\.0\\.0\\.1' });
        window.makeBody = (model, stream = true) => ({ chat_completion_source: 'custom', custom_url: origin + '/v1',
            model, stream, messages: [{ role: 'user', content: '合成请求' }], tools: [{ type: 'function', function: {
                name: 'transam_content', parameters: { type: 'object', properties: { content: { type: 'string' } } },
            } }], tool_choice: { type: 'function', function: { name: 'transam_content' } } });
        window.send = data => fetch('/api/backends/chat-completions/generate', { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        // Observe the real response path without replacing responses or network APIs.
        const lower = window.fetch;
        window.layerHits = 0;
        window.fetch = async (...args) => { const response = await lower(...args); window.layerHits++; return response; };
        window.observedFetch = window.fetch;
    }, origin);

    const stream = await page.evaluate(async () => (await send(makeBody('stream'))).text());
    assert.equal(stream, rawSse, 'Tool calls, UTF-8 text and fragmented SSE must arrive unchanged');
    assert.equal(await page.evaluate(() => layerHits), 1);
    const retry = await page.evaluate(async () => (await send(makeBody('reconnect'))).text());
    assert.equal(retry, rawSse);
    assert.equal(socketFailures, 1);
    assert.equal(posts.filter(p => p.body.model === 'reconnect').length, 1);

    const unavailable = await page.evaluate(async () => (await send(makeBody('unavailable'))).text());
    assert.equal(unavailable, rawSse);
    assert.equal(posts.filter(p => p.body.model === 'unavailable').length, 1);
    // Drop the real browser network after a successful partial response, then freeze/resume the page.
    const firstChunk = page.waitForResponse(response => response.url().includes('/v1/openai/tasks/') &&
        response.url().endsWith('?after=0'));
    await page.evaluate(() => {
        window.resumedText = send(makeBody('background')).then(response => response.text());
    });
    await firstChunk;
    await page.context().setOffline(true);
    await page.waitForTimeout(1000);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    await page.waitForTimeout(500);
    await page.context().setOffline(false);
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    assert.equal(await page.evaluate(() => resumedText), rawSse);
    assert.equal(posts.filter(p => p.body.model === 'background').length, 1);
    const backgroundId = [...tasks].find(([, task]) => task.body.model === 'background')[0];
    assert.equal(queries.filter(query => query.id === backgroundId && query.after === 0).length, 1);
    await cdp.detach();

    // A fresh page has no in-memory task ID; recover it from the existing task-list API.
    const recovery = await browser.newPage();
    await recovery.goto(origin); await recovery.waitForFunction(() => window.qa);
    const recovered = await recovery.evaluate(async origin => {
        const headers = new Headers({ Authorization: 'Bearer synthetic-main-key' });
        const tasks = await qa.listTasks(origin, headers);
        const task = tasks.find(task => task.model === 'background');
        return qa.readTaskResult(origin, headers, task.id, () => {});
    }, origin);
    assert.equal(recovered.text, rawSse);
    assert.equal(recovered.status, 'completed');
    assert.equal(posts.filter(p => p.body.model === 'background').length, 1);
    await recovery.close();

    await page.evaluate(async () => {
        const body = makeBody('summary', false);
        body.reverse_proxy = body.custom_url; body.proxy_password = 'synthetic-summary-key';
        body.custom_include_body = 'temperature: 0.2\nmax_tokens: 512\nextra_body:\n  test: true';
        body.custom_exclude_body = '[max_tokens]';
        window.beforeBody = JSON.stringify(body);
        const result = await (await send(body)).json();
        if (JSON.stringify(body) !== beforeBody) throw new Error('Request mutated');
        if (result.choices[0].message.content !== '{"events":[]}') throw new Error('Summary response altered');
    });
    const summary = posts.find(p => p.body.model === 'summary');
    assert.equal(summary.headers.authorization, 'Bearer synthetic-summary-key');
    assert.equal(summary.body.temperature, 0.2);
    assert.equal(summary.body.max_tokens, undefined);
    assert.deepEqual(summary.body.extra_body, { test: true });

    const failure = await page.evaluate(async () => (await send(makeBody('failed'))).text());
    assert.ok(failure.includes('synthetic quota error'));
    assert.ok(!failure.includes('data: [DONE]'), 'A failed task must not finish before its error');
    const truncated = await page.evaluate(async () => (await send(makeBody('truncated'))).text());
    assert.ok(truncated.includes('"error"'));
    assert.ok(!truncated.includes('data: [DONE]'));

    const nativeBefore = nativeRequests;
    const submissionsBefore = await page.evaluate(() => submissionCalls);
    const uncertain = await page.evaluate(async () => {
        try { await send(makeBody('uncertain')); return ''; } catch (error) { return error.message; }
    });
    assert.ok(uncertain.includes('提交结果不明'));
    assert.equal(await page.evaluate(() => submissionCalls), submissionsBefore + 1, 'The plugin must call POST only once');
    assert.ok(posts.some(p => p.body.model === 'uncertain'));
    console.log('Observed browser-level deliveries of the single uncertain POST:', posts.filter(p => p.body.model === 'uncertain').length);
    assert.equal(nativeRequests, nativeBefore, 'No native-generation fallback after uncertain submission');

    await page.evaluate(async () => {
        const controller = new AbortController();
        const promise = fetch('/api/backends/chat-completions/generate', { method: 'POST',
            body: JSON.stringify(makeBody('stop-submit', false)), signal: controller.signal });
        setTimeout(() => controller.abort(), 50);
        try { await promise; } catch {}
    });
    await page.waitForTimeout(200);
    assert.equal(cancels.length, 1, 'Stopping while submitting must cancel once the task ID is known');
    await page.evaluate(async () => {
        const controller = new AbortController();
        const response = await fetch('/api/backends/chat-completions/generate', { method: 'POST',
            body: JSON.stringify(makeBody('waiting')), signal: controller.signal });
        const text = response.text(); setTimeout(() => controller.abort(), 50); await text;
    });
    await page.waitForTimeout(200);
    assert.equal(cancels.length, 2);

    await page.evaluate(async () => {
        qa.settings.enabled = false; await send(makeBody('disabled'));
        qa.settings.enabled = true;
        if (fetch !== observedFetch) throw new Error('Preset wrapper removed');
        const data = makeBody('gemini'); data.chat_completion_source = 'makersuite'; await send(data);
        const processed = makeBody('processed'); processed.custom_prompt_post_processing = 'merge'; await send(processed);
    });
    assert.equal(nativeRequests, nativeBefore + 3);
    const requestResult = await page.evaluate(async () => {
        const request = new Request(location.origin + '/api/backends/chat-completions/generate', {
            method: 'POST', body: JSON.stringify(makeBody('request-object', false)),
        });
        return (await fetch(request)).json();
    });
    assert.ok(requestResult.choices);
    const denied = await page.evaluate(() => {
        try {
            const data = makeBody('foreign');
            data.custom_url = 'https://catiecli.example.invalid/v1';
            qa.resolveHeaders(data, qa.normalizeBaseUrl(data.custom_url));
            return false;
        } catch { return true; }
    });
    assert.equal(denied, true, 'Fallback key must stay with its configured API base');

    const late = await browser.newPage();
    await late.goto(origin + '/?late'); await late.waitForFunction(() => window.qa);
    const countBefore = posts.length;
    await late.evaluate(async origin => {
        Object.assign(qa.settings, { enabled: true, interceptKeyword: '127\\.0\\.0\\.1' });
        await fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify({
            chat_completion_source: 'custom', custom_url: origin + '/v1', model: 'late', messages: [],
        }) });
    }, origin);
    assert.equal(posts.length, countBefore);
    assert.deepEqual(errors, []);
    console.log('PASS: real browser Fetch/Streams + local HTTP; tool SSE, reconnect, offline + frozen/resumed page, 503 retry, fresh-page recovery, summary credentials/YAML, errors, no plugin POST retry/native fallback, cancellation, wrapper toggles, Request objects, source isolation and late-load guard.');
} finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
}
