# st-catiecli-tasks

SillyTavern 服务端插件：把 [catiecli](https://catiecli.sukaka.top/)
的**任务 API**（`POST /v1/openai/tasks` 提交 → `GET .../tasks/{id}?after=N`
轮询分片）封装成一个**标准 OpenAI 兼容端点**。

SillyTavern 用 **Custom (OpenAI-compatible)** 源接入即可，使用体验与直连
`/v1/chat/completions` 完全一致 —— 流式打字机、非流式、模型列表连接、错误
提示全部照常工作。

## 为什么需要它

长回复/长思考请求动辄几分钟，客户端必须保持长连接；手机切后台、网络抖动、
换 WiFi 都会断开连接，整个回复作废。本插件在 ST 与 catiecli 之间走
**提交-轮询**模式：

```
ST ──POST /v1/chat/completions──▶ 插件 ──POST /v1/openai/tasks──▶ catiecli（秒回 task_id）
                                  插件 ──GET /tasks/{id}?after=N─▶ catiecli（增量分片轮询）
ST ◀──标准 SSE 流（原样转发分片）── 插件
```

- ST 与插件之间断连（用户点了停止）→ 插件取消任务，不浪费上游额度
- 插件与 catiecli 之间网络抖动 → 任务仍在服务端继续执行，轮询自动续上，分片不丢

## 安装

1. 把本目录（或它的符号链接/junction）放到 SillyTavern 的 `plugins/` 下：

```powershell
# Windows：用 junction 免复制，插件目录更新即时生效
cmd /c mklink /J E:\projects\SillyTavern\plugins\st-catiecli-tasks E:\projects\st-catiecli-tasks
```
2. 在 SillyTavern 的 `config.yaml` 启用服务端插件（默认关闭）：

```yaml
enableServerPlugins: true
```

3. （可选）指向本地/其他 catiecli 实例：在 SillyTavern 的
   **「自定义请求头 / Custom Include Headers」** 输入框里填（YAML 格式）：

```yaml
X-Catiecli-Url: http://127.0.0.1:5002
```

不填则默认使用内置线上地址 `https://catiecli.sukaka.top`（填 key 即用）。
改完保存即生效，无需重启。

4. 重启 SillyTavern，控制台看到
   `[st-catiecli-tasks] Provider ready.` 即加载成功。

> 「自定义请求头」输入框在 ST 的 Chat Completion 设置里（Custom 源），
> 与「自定义请求体 / Custom Include Body」相邻；其内容会随每个请求
> 发往插件，插件按 `X-Catiecli-Url` 头路由到对应 catiecli 实例。

## 在 SillyTavern 中配置

1. API 选 **Chat Completion** → 源选 **Custom (OpenAI-compatible)**
2. **Custom Endpoint** 填：

```
http://127.0.0.1:8000/api/plugins/st-catiecli-tasks/v1
```

（`8000` 换成你 SillyTavern 的实际端口；`/v1` 结尾不要丢——插件按标准
OpenAI 路径提供 `/v1/models` 与 `/v1/chat/completions`。）

3. 点 🔑 图标 → **API 密钥** → `CUSTOM_OPENAI` 填 catiecli 的 `cat-` 密钥
4. 点 **连接**（拉取模型列表）→ 选模型 → 生成

流式开关随意：流式走分片轮询 + SSE 原样转发（有新分片时快速跟进，
体验接近直连）；非流式等任务完成后一次性返回。

## 工作细节

| 行为 | 说明 |
|---|---|
| 模型列表 | `GET /v1/models` 直接透传 catiecli（ST「连接」时拉取） |
| 流式 | 提交任务后轮询增量分片，原样写回 SSE；新分片到达间隔 60ms 快速跟进 |
| 非流式 | 轮询至终态后返回 `result` 原样体 |
| 错误透传 | 任务 `failed` 时按 `status_code` 返回错误体；流式中途失败写 OpenAI 惯例错误帧（ST 能弹出 toast） |
| ST 停止按钮 | ST 断开连接 → 插件对任务发 cancel，2 秒内生效 |
| 轮询上限 | 单任务 30 分钟，超时返回 504 |
| 网络重试 | 提交/轮询/取消/模型列表遇到**连不上**自动重试 3 次（1s→2s 指数退避），3 次都失败才报"连续 3 次无法连接上游"；HTTP 4xx/5xx 是服务器明确响应，不重试直接透传 |
| 上游地址 | 每请求读取 `X-Catiecli-Url` 头（ST 自定义请求头输入框）覆盖；默认内置线上地址 |
| 鉴权 | 插件路由在 ST 登录鉴权之后；catiecli 密钥只在服务端之间传递 |

> 插件本身**零依赖**（只用 Node ≥ 18 全局 fetch + ST 自带的 express）。
> 目录里的 `smoke.test.mjs` 是独立冒烟测试（需可解析到 express，
> 例如临时 junction 一个 node_modules），与运行无关。

## 端点（挂载于 `/api/plugins/st-catiecli-tasks/`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 插件状态 + 上游地址 |
| GET | `/v1/models` | 模型列表（透传） |
| POST | `/v1/chat/completions` | 生成入口（流式/非流式） |
