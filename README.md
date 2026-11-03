# st-catiecli-tasks

SillyTavern **UI 扩展**:把 [catiecli-neo](https://github.com/su-kaka/catiecli-neo)
的**任务 API**(`POST /v1/openai/tasks` 提交 → `GET .../tasks/{id}?after=N`
轮询分片)接到 SillyTavern 的 Chat Completion 生成链路上,**根治长连接网络
不稳定**:断网、切后台、换 WiFi 不再报废整个回复。

> 形态:纯前端 UI 扩展(**Extensions 贴 git 链接即装**,无需改 config.yaml、
> 无需服务端插件)。生成请求由浏览器直接调 catiecli(catiecli 全站 CORS
> 放行),ST 原生流式解析照常工作。

## 为什么需要它

长回复/长思考请求动辄几分钟,客户端必须保持长连接;手机切后台、网络抖动
都会断开连接,整个回复作废。本扩展把生成请求改为**提交-轮询**模式:

```
ST 前端 ──patch fetch 拦截 /api/backends/chat-completions/generate
        └─ 浏览器直连 catiecli:
           POST /v1/openai/tasks                 提交任务(秒回 task_id)
           GET  /v1/openai/tasks/{id}?after=N   轮询增量分片
        └─ 分片原样推进伪 SSE Response → ST 原生 SSE 解析器照常打字机
```

- 断网:提交/轮询自动重试 3 次(指数退避),3 次都连不上才报错;
  任务在 catiecli 服务端继续执行,分片存 Redis 不丢
- ST 停止按钮:扩展对任务发 cancel,不浪费上游额度

## 安装(Extensions 贴链接)

SillyTavern → **Extensions(扩展)** 面板 → `Install extension` 填:

```
https://github.com/su-kaka/st-catiecli-tasks
```

装完在扩展列表勾选启用 **Catiecli Tasks**。

## 配置(一次)

1. API 选 **Chat Completion** → 源选 **Custom (OpenAI-compatible)**
2. **Custom Endpoint** 填 catiecli 地址:

```
https://catiecli.sukaka.top/v1
```

3. 点 🔑 → API 密钥(`api_key_custom`)填 catiecli 的 `cat-` 密钥
   —— **扩展直接复用该密钥,无需另填**
4. 点 **连接**(ST 后端直连 catiecli `/v1/models`,标准协议兼容)
   → 选模型 → 生成

扩展面板(Extensions 设置区)里:
- **接管开关**:默认开;关闭则完全回退 ST 原生直连
- **上游地址**:留空跟随 Custom Endpoint;也可强制指定
- **测试连接**:验证扩展 → catiecli 连通性(显示可用模型数)

## 使用体验

与直连 Custom 源**完全一致**:流式打字机(有新分片时 60ms 快速跟进)、
非流式、预设、模型选择全部照常;区别只是底层走任务 API,网络再抖也
不丢回复。单任务最长 30 分钟,超时自动取消并提示。

## `server/` 子目录(可选的服务端插件形态)

不想用浏览器直连(例如 ST 部署在无外网出口的机器)时,可用
[server/](./server) 下的服务端插件形态:把它放进 SillyTavern 的
`plugins/` 目录并在 `config.yaml` 设 `enableServerPlugins: true`,
Custom Endpoint 改指插件地址。两种形态二选一即可。
