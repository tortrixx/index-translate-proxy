# index-translate-proxy

把 [Index-Translate](https://github.com/bilibili/Index-Translate) 的**免费公共 API** 转成一个
**浏览器插件可直接调用**的 OpenAI 兼容端点，跑在 Vercel Serverless 上 —— 零依赖、零运维、无需常驻机器。

> 官方给出的方案是本地跑 `python call_api.py --serve`（要一直开着）。本项目把那层代理搬到 Serverless 上。

## 为什么插件不能直连上游

| 原因 | 实测表现 |
| --- | --- |
| 扩展来源被上游 WAF 拦截 | 带 `Origin: chrome-extension://…` 的请求一律 **HTTP 412**；带普通 `https://` Origin 却是 200 |
| 上游不返回任何 CORS 头 | 即使侥幸 200，浏览器也读不到响应体 |

官方本地代理之所以能用，是因为 Python `urllib` 不会发送 `Origin`，且自己补了 CORS 头。
本项目复刻了同样两点：**不向上游转发客户端 `Origin`**，并**给所有响应（含 4xx/5xx）补上
`Access-Control-Allow-Origin: *`**。

## 能力

| 能力 | 说明 |
| --- | --- |
| CORS | 全量补齐跨域头，正确处理 `OPTIONS` 预检 |
| 流式 | 真流式透传 SSE，逐块写出、不缓冲、`[DONE]` 原样透传 |
| 端点 | `/v1/chat/completions`、`/v1/completions`、`/v1/responses`、`/v1/models` |
| 行为对齐 | 默认注入 `enable_thinking=false`、`temperature=0`（用户显式传值时不覆盖） |
| 上游隔离 | 不转发客户端的 `Authorization` 与 `Origin`，只放行白名单路径 |
| 零依赖 | 纯 Node 标准 API，没有 npm 依赖，无供应链风险 |
| 可选门禁 | 设 `PROXY_API_KEY` 即要求 `Authorization: Bearer <key>`；不设则完全开放 |

上游本身不需要 API Key，所以本服务不持有任何密钥。

## 快速开始

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/tortrixx/index-translate-proxy)

```bash
git clone https://github.com/tortrixx/index-translate-proxy.git
cd index-translate-proxy
npx vercel deploy --prod        # 首次按提示回车即可，详见 DEPLOY.md
```

部署完得到 `https://<项目名>.vercel.app`。**在中国大陆建议绑定自有域名** ——
`*.vercel.app` 直连会被 TLS reset（SNI 封锁），绑域名后实测直连 0.4s 可用。完整步骤见 **[DEPLOY.md](DEPLOY.md)**。

## 插件配置

以「沉浸式翻译」的自定义 OpenAI 兼容服务为例，Index-Translate 官方扩展同理：

| 配置项 | 值 |
| --- | --- |
| 翻译服务 | 自定义 / OpenAI 兼容 |
| 接口地址 API URL | `https://<你的域名>/v1` |
| 模型 Model | `Index-Translate-35B-A3B` |
| API Key | 未设 `PROXY_API_KEY` 时随便填（如 `index`） |

部署后浏览器打开 `https://<你的域名>/` 会看到状态页，可一键跑通「翻译自检 / 流式自检」。

## 已知限制

- **请求体上限约 4.5 MB**（Vercel 平台限制）。纯文本翻译无关；图片翻译的超大 base64 会被 413，需压缩图片。
- **单次函数最长 60s**（Hobby 上限，`vercel.json` 已设 `maxDuration: 60`；Pro 可提到 300）。
- **`*.vercel.app` 在中国大陆直连会被 TLS reset**（SNI 封锁，与 IP 无关），绑定自有域名即可解决。
- 上游是公益免费额度，请勿高频轰炸；如需防白嫖可加 `PROXY_API_KEY`。

## 开发与测试

```bash
node test/run-tests.mjs                            # 17 个本地用例：CORS / 流式 / 鉴权 / body 改写 / 上游隔离
node test/local-server.mjs                         # 本地起 mock Vercel 环境：http://127.0.0.1:8080
SKIP_UPSTREAM=1 node test/run-tests.mjs            # 只跑离线用例（不访问外网）
PROXY_URL=https://<域名> node test/live-check.mjs   # 对已部署实例跑真实请求验收（8 项）
./scripts/verify-domain.sh <域名>                   # DNS / 证书 / 直连 / 完整验收一把过
```

`test/run-tests.mjs` 会 spawn 子进程、复刻 Vercel 的 `rewrites` 与「JSON body 预解析到 `req.body`」两个行为，
所以本地通过的用例在线上同样成立。

## 目录结构

```
.
├── lib/proxy.js                 # 全部逻辑：CORS 网桥 + SSE 流式转发 + 可选鉴权
├── api/v1/index.js              # GET  /v1                     健康检查 / 配置自检
├── api/v1/models.js             # GET  /v1/models              模型列表（上游挂了回退内置表）
├── api/v1/chat/completions.js   # POST /v1/chat/completions    插件主入口
├── api/v1/completions.js        # POST /v1/completions
├── api/v1/responses.js          # POST /v1/responses
├── public/index.html            # 部署后的状态页 / 自测页
├── test/                        # mock Vercel 的本地测试 + 线上验收脚本
├── scripts/                     # 部署与验证辅助脚本
├── vercel.json                  # 区域(hkg1) / rewrites / maxDuration
└── DEPLOY.md                    # 部署指南（含自定义域名与故障排查）
```

> ⚠️ `api/v1/` 下**必须**按路径建显式文件。实测 Vercel Functions 的 `api/v1/[...path].js` 只匹配单层路径：
> `/api/v1/models` 能进函数，`/api/v1/chat/completions` 会被边缘直接 404。所有路由文件都只是
> re-export `lib/proxy.js`，逻辑只有一份。
