# 部署指南

部署只需要几分钟，没有构建步骤、没有 npm 依赖。**唯一需要注意的是国内使用时要绑自有域名**（见第 3 节）。

---

## 1. 部署方式

三种方式任选其一，效果相同。

### 方式 A：一键部署（推荐）

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/tortrixx/index-translate-proxy)

点击后登录并授权 Vercel，按提示选择账号即可。Vercel 会：

1. 在你的 Git 账号下创建一份本仓库的副本（名字可改）
2. 自动识别为无框架项目并完成部署
3. 之后你改动这份副本的代码，Vercel 会自动重新部署

不需要本地安装任何东西。**不想要仓库副本**的话用方式 B 或 C。

### 方式 B：Vercel CLI

```bash
git clone https://github.com/tortrixx/index-translate-proxy.git
cd index-translate-proxy
npx vercel login            # 浏览器授权一次
npx vercel deploy --prod
```

首次部署的交互都回车即可：

```
Set up and deploy?                          → y
Which scope?                                → 选你的账号
Link to existing project?                   → n
What's your project's name?                 → 直接回车
In which directory is your code located?    → ./
Want to modify these settings?              → n
```

结束后会输出 `https://<项目名>.vercel.app`。

### 方式 C：本仓库自带脚本

```bash
export VERCEL_TOKEN=xxxx        # https://vercel.com/account/tokens
./scripts/deploy.sh
```

脚本会在仓库内建一个隔离的 CLI 环境（`.tools/`，已 gitignore），不会污染系统目录；
若目录里没有 `.vercel/` 关联文件（例如全新 clone），它会先自动关联到已有项目再部署，
避免把这次部署误当成新项目创建。

### 网页手动导入

也可以直接在 [vercel.com/new](https://vercel.com/new) 导入仓库，**Framework Preset 选 `Other`**，
其余保持默认，直接 Deploy。

---

## 2. 环境变量

在 Vercel 项目 **Settings → Environment Variables** 配置，改完必须 **Redeploy** 才生效。全部可选：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PROXY_API_KEY` | 不设置 | **不设 = 完全开放**（和官方免费 API 一致）。设置后必须带 `Authorization: Bearer <key>`，也支持 `?key=` 查询参数。适合防止公开地址被白嫖 |
| `UPSTREAM_BASE` | `https://index-translate.bilibili.com/v1` | 上游地址。**可以改成你自己部署的 vLLM / SGLang 端点**，本服务就变成它的跨域网关 |
| `CONNECT_TIMEOUT_MS` | `30000` | 建连超时；超时返回 504 |
| `IDLE_TIMEOUT_MS` | `55000` | 流式空闲超时；长时间没有新数据才中断 |

### 区域

`vercel.json` 已指定 `regions: ["hkg1"]`（香港），因为上游走 bilicdn 中国节点，香港延迟最低。

若账号不接受该配置导致部署报错，删掉 `vercel.json` 里的 `regions` 字段，改为在
**Project Settings → Functions → Function Region** 里选 **Hong Kong**。

---

## 3. 绑定自定义域名（中国大陆必需）

### 为什么必须绑

实测：`*.vercel.app` 在中国大陆**直连会被 TLS reset**，而同样托管在 Vercel 的 `vercel.com`、`nextjs.org`
直连都是 200 —— 说明封锁是**按 SNI（域名）**而不是按 IP 的。换一个自有域名即可绕过。

| 访问方式 | 直连结果 | 延迟 |
| --- | --- | --- |
| `xxx.vercel.app` | ❌ TLS reset | — |
| `xxx.vercel.app`（走代理） | ✅ 200 | 1.22s |
| 自有域名（灰云 CNAME） | ✅ 200 | **0.42–0.49s** |

顺带一提：绑自有域名后连代理都不用开，反而比开代理更快。

### 步骤

**① 在 Vercel 加域名**

控制台 → 项目 → **Settings → Domains** → 填入 `api.你的域名.com` → Add。
页面会给出需要配置的 DNS 记录，形如：

```
类型 CNAME   名称 api   值 xxxxxxxx.vercel-dns-017.com
```

**② 在 DNS 服务商加记录**

| DNS 服务商 | 做法 |
| --- | --- |
| **Cloudflare** | 加 CNAME，目标填 Vercel 给的值，**代理状态必须选 DNS only（灰云）** |
| 其他服务商 | 直接加 CNAME 即可（部分服务商也支持 A 记录指向 `76.76.21.21`） |

> ⚠️ **Cloudflare 一定要用灰云。** 橙云会让流量重新经过 Cloudflare 代理，若该 zone 开了安全防护
> （Browser Integrity Check / Bot Fight Mode / WAF 挑战），curl 和插件的 `fetch` 都会拿到
> `403 Just a moment...` 的 JS 挑战页 —— 插件无法通过。灰云则完全绕过 Cloudflare 代理。

**③ 等证书签发（约 1–5 分钟）**

这段时间里直连 TLS 会直接断（`unexpected eof`），**这是正常的**，不是被墙也不是配置错误 ——
Vercel 在证书签发前会拒绝该 SNI 的握手。签发完成后自动恢复。

**④ 验证**

```bash
./scripts/verify-domain.sh api.你的域名.com
```

脚本会依次检查 DNS、直连 TLS、然后跑完整的 8 项验收（全程自动绕过本地代理）。

---

## 4. 验证部署

浏览器打开 `https://<你的域名>/` —— 状态页会自动探测服务，并提供「翻译自检」「流式自检」两个按钮，
用真实请求走完整链路（流式那个会逐字渲染，可直观确认 SSE 是真增量透传）。

命令行：

```bash
# 模型列表
curl -s https://<你的域名>/v1/models

# 翻译
curl -s https://<你的域名>/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"Index-Translate-35B-A3B","messages":[{"role":"user","content":"请将以下文本翻译为英语，直接输出翻译结果，不要进行任何解释。\n\n今天天气真好。"}]}'
```

返回 `The weather is really nice today.` 即正常。若设了 `PROXY_API_KEY`，加上 `-H 'Authorization: Bearer <key>'`。

---

## 5. 故障排查

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 插件报 CORS / 请求被拦 | 上游没有任何 CORS 头且会对扩展 Origin 返 412 | 用本服务；确认请求确实打到了本代理 |
| 直连 `*.vercel.app` / `*.workers.dev` 报 `Connection reset` | **SNI 被墙** | 绑自有域名（第 3 节） |
| 域名刚绑上时 TLS 断（`unexpected eof`） | Vercel 还没签发证书 | 等几分钟；对照一个无关域名（如 `foo.example.org`）表现相同即可确认不是被墙 |
| 浏览器打开域名显示 `403 Just a moment...` | DNS 记录是**橙云**，流量被 Cloudflare 代理并触发 JS 挑战 | 改成 **DNS only（灰云）** |
| 请求 `/v1/chat/completions` 返回 Vercel 的 `404 NOT_FOUND` 且无 CORS 头 | 路由没匹配上函数 | 别把 `api/v1/` 下的显式路由文件改成 `[...path].js` catch-all，Vercel 的 catch-all 只匹配单层路径 |
| 返回 412 且内容是 bilibili「出错啦」页面 | 上游 WAF 拦截了出口来源 | 检查是否把自己改的 `UPSTREAM_BASE` 指向了别处；**Cloudflare Workers 出口会被上游全量拦 412**，不要用它做直连（见第 7 节） |
| 图片翻译报 413 | 请求体超过 Vercel 的 4.5 MB 限制 | 压缩图片，或改用 base64 之外的传图方式 |
| 报 504 `upstream_timeout` | 上游超过 `CONNECT_TIMEOUT_MS` 没响应 | 调大该变量，或检查上游是否限流 |

**判断「是否被墙」的正确方法**：

```bash
# 把域名强制解析到某个 IP，看 TLS 是否被 reset（reset 才是被墙）
curl -k --resolve <域名>:443:<IP> https://<域名>/
```

---

## 6. 维护

| 需求 | 做法 |
| --- | --- |
| 改完代码重新部署 | `./scripts/deploy.sh`（需 `VERCEL_TOKEN`） |
| 换域名 | Vercel → Domains 加新域名，DNS 加灰云 CNAME，然后 `./scripts/verify-domain.sh 新域名` |
| 换区域 | Settings → Functions → Function Region，或改 `vercel.json` 的 `regions` |
| 加访问门禁 | 加环境变量 `PROXY_API_KEY` 并 Redeploy；插件里的 API Key 填同一个值 |
| 完全停用 | 控制台删除 Vercel 项目即可，官方上游 API 不受影响 |

---

## 7. 为什么不选 Cloudflare Workers

这条路实测走不通，记录在此避免重复踩坑。

Cloudflare Workers 的逻辑实现完全可行（本项目作者写过一版，本地 17 个用例全通过），但
**bilicdn 的 WAF 会把来自 Cloudflare 出口的请求全部拦成 412**：

| 请求来源 | `GET /v1/models` | `POST /v1/chat/completions` |
| --- | --- | --- |
| 本机直连（中国住宅 IP） | 200 | 200 |
| Vercel `hkg1` 出口 | — | **200** |
| **Cloudflare Workers 出口** | **412** | **412** |

在 Cloudflare 上做过 8 组对照（GET / POST / PUT、有无自定义头、有无 body、有无 `Origin`）**全部 412**，
而同一时刻本机与 Vercel 都是 200 —— 所以与请求方法、路径、头部都无关，是出口 IP/ASN 被拦。
Workers 无法更换出口 IP，因此这条路封死。

如果确实想用 Cloudflare 当入口，唯一可行的是让 Worker 把请求转给 Vercel 代理（多一跳，得不偿失），
不如直接把域名绑到 Vercel。
