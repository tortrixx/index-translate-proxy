/**
 * Index-Translate → OpenAI 兼容 CORS 网桥（Vercel Serverless Function）
 *
 * 背景：https://index-translate.bilibili.com/v1 是官方免费公共 API，但它 **不返回任何
 * CORS 响应头**，因此浏览器插件（沉浸式翻译 / Index-Translate 扩展）无法直接调用。
 * 官方给的解法是在本机跑 `python call_api.py --serve`，对 7x24 很不友好。
 *
 * 本函数就是把这个本地代理搬到 Vercel 上：无状态、按需冷启动、不转发任何密钥。
 *   - 补齐 CORS 头（含 OPTIONS 预检）
 *   - 原样转发到上游，且真流式转发 SSE（不缓存、不缓冲）
 *   - 默认注入 enable_thinking=false / temperature=0，与官方本地代理行为一致
 *   - 可选 PROXY_API_KEY 鉴权，避免公开地址被白嫖
 *
 * 环境变量（全部可选）：
 *   UPSTREAM_BASE        上游地址，默认 https://index-translate.bilibili.com/v1
 *   PROXY_API_KEY        设置后，调用方必须带 Authorization: Bearer <key>（或 ?key=）
 *   CONNECT_TIMEOUT_MS   建连超时，默认 30000
 *   IDLE_TIMEOUT_MS      流式空闲超时，默认 55000
 *   UPSTREAM_USER_AGENT  转发时使用的 UA
 *
 * 路由说明（实测踩坑）：Vercel Functions 里的 `api/v1/[...path].js` 只匹配单层路径 ——
 * `/api/v1/models` 能进函数，而 `/api/v1/chat/completions` 被边缘直接返回 NOT_FOUND。
 * 所以 api/v1/ 下按路径建立显式文件，全部 re-export 本模块。不要"简化"回 catch-all。
 */

const DEFAULT_UPSTREAM = 'https://index-translate.bilibili.com/v1';

const UPSTREAM_BASE = (process.env.UPSTREAM_BASE || DEFAULT_UPSTREAM).replace(/\/+$/, '');
const PROXY_API_KEY = String(process.env.PROXY_API_KEY || '').trim();
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS || 30000);
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS || 55000);
const UPSTREAM_USER_AGENT =
  process.env.UPSTREAM_USER_AGENT || 'Index-Translate-Vercel-Proxy/1.0';

/** 只放行插件真正需要的 OpenAI 兼容路径，避免这个免费代理被当成任意路径的跳板。 */
const ALLOWED_PATHS = new Set(['/chat/completions', '/completions', '/responses', '/models']);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

/** 上游响应头里值得透传给浏览器的字段（其余如 content-length 必须丢弃，因为可能被改写）。 */
const FORWARD_RESPONSE_HEADERS = new Set([
  'content-type',
  'cache-control',
  'retry-after',
  'x-request-id',
  'openai-version',
  'openai-processing-ms',
]);

const FALLBACK_MODELS = {
  object: 'list',
  data: [
    {
      id: 'Index-Translate-35B-A3B',
      object: 'model',
      created: 1727712000,
      owned_by: 'index-translate',
    },
  ],
};

function setCors(res) {
  for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8');
  setCors(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(body.length));
  res.end(body);
}

function errorPayload(message, type = 'invalid_request_error', code = null) {
  return { error: { message, type, code, param: null } };
}

/** 从请求 URL 里取出 /v1 之后的路径；兼容 /v1/*、/api/v1/* 以及带尾斜杠的形式。 */
function resolveUpstreamPath(req) {
  let pathname = '/v1';
  try {
    pathname = new URL(req.url || '/', 'http://localhost').pathname;
  } catch {
    /* 保底走默认值 */
  }
  const match = pathname.match(/\/v1(\/.*)?$/);
  const raw = match && match[1] ? match[1] : '/';
  // 折叠重复斜杠并去掉尾部斜杠（根路径除外）
  const normalized = raw.replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1');
  return normalized === '' ? '/' : normalized;
}

function isAuthorized(req) {
  if (!PROXY_API_KEY) return true;
  let provided = '';
  const auth = req.headers?.authorization || req.headers?.Authorization || '';
  if (auth) provided = String(auth).replace(/^Bearer\s+/i, '').trim();
  if (!provided) {
    const apiKey = req.headers?.['x-api-key'];
    if (apiKey) provided = String(apiKey).trim();
  }
  if (!provided) {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      provided = (
        url.searchParams.get('key') ||
        url.searchParams.get('api_key') ||
        url.searchParams.get('token') ||
        ''
      ).trim();
    } catch {
      /* ignore */
    }
  }
  return provided === PROXY_API_KEY;
}

/**
 * 读取原始请求体。
 * Vercel Node runtime 通常会预先解析 JSON body 到 req.body；若未解析则从流里读。
 * 两条路径都要支持，否则一旦平台行为变化就会静默丢 body。
 */
async function readRawBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') return Buffer.from(req.body, 'utf-8');
    return Buffer.from(JSON.stringify(req.body), 'utf-8');
  }
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * 与官方本地代理（call_api.py --serve）保持一致：
 * 默认关闭思维链、默认温度 0，避免 CoT 文本顶掉译文。用户显式传入的值一律尊重。
 */
function normalizeChatPayload(rawBody) {
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf-8'));
  } catch {
    return rawBody;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return rawBody;

  if (
    payload.chat_template_kwargs === undefined ||
    payload.chat_template_kwargs === null ||
    typeof payload.chat_template_kwargs !== 'object' ||
    Array.isArray(payload.chat_template_kwargs)
  ) {
    payload.chat_template_kwargs = {};
  }
  if (payload.chat_template_kwargs.enable_thinking === undefined) {
    payload.chat_template_kwargs.enable_thinking = false;
  }
  if (payload.temperature === undefined || payload.temperature === null) {
    payload.temperature = 0.0;
  }
  return Buffer.from(JSON.stringify(payload), 'utf-8');
}

/** 把上游响应（含 SSE）逐块推给客户端，不做任何缓冲或改写。 */
async function pipeUpstream(upstream, res) {
  setCors(res);
  res.statusCode = upstream.status;
  for (const [key, value] of upstream.headers) {
    if (FORWARD_RESPONSE_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
  }
  // 明确告诉 Vercel / 中间层不要缓冲，否则流式会退化成一次性返回。
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (res.writableEnded || res.destroyed) {
      await reader.cancel().catch(() => {});
      return;
    }
    if (!res.write(Buffer.from(value))) {
      await new Promise((resolve) => res.once('drain', resolve));
    }
  }
  res.end();
}

async function handleGet(req, res, upstreamPath) {
  if (upstreamPath === '/') {
    return sendJson(res, 200, {
      service: 'index-translate-vercel-proxy',
      status: 'ok',
      upstream: UPSTREAM_BASE,
      auth_required: Boolean(PROXY_API_KEY),
      endpoints: ['/v1/chat/completions', '/v1/completions', '/v1/responses', '/v1/models'],
      usage: {
        api_base_url: 'https://<your-domain>/v1',
        model: 'Index-Translate-35B-A3B',
        api_key: PROXY_API_KEY ? '<PROXY_API_KEY>' : 'any (not required)',
      },
    });
  }

  if (upstreamPath === '/models') {
    // 上游 /models 若临时不可用，退回到内置模型表，保证插件能完成模型校验。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
    try {
      const upstream = await fetch(`${UPSTREAM_BASE}/models`, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': UPSTREAM_USER_AGENT },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
      const text = await upstream.text();
      JSON.parse(text); // 校验是合法 JSON，否则走兜底
      setCors(res);
      res.statusCode = upstream.status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(text);
      return;
    } catch (err) {
      clearTimeout(timer);
      res.setHeader('X-Proxy-Fallback', String(err?.message || err));
      return sendJson(res, 200, FALLBACK_MODELS);
    }
  }

  return sendJson(res, 404, errorPayload(`Unsupported GET path: /v1${upstreamPath}`, 'invalid_request_error', 'not_found'));
}

async function handlePost(req, res, upstreamPath) {
  let body = await readRawBody(req);
  if (upstreamPath === '/chat/completions') body = normalizeChatPayload(body);

  const controller = new AbortController();
  let connectTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);

  // 客户端断开时立刻放弃上游请求，别继续烧算力。
  const onClose = () => controller.abort();
  res.once('close', onClose);

  let upstream;
  try {
    upstream = await fetch(`${UPSTREAM_BASE}${upstreamPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': req.headers?.['content-type'] || 'application/json',
        Accept: req.headers?.accept || '*/*',
        'User-Agent': UPSTREAM_USER_AGENT,
      },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(connectTimer);
    res.removeListener('close', onClose);
    const aborted = err?.name === 'AbortError';
    return sendJson(
      res,
      aborted ? 504 : 502,
      errorPayload(
        aborted
          ? `Upstream did not respond within ${CONNECT_TIMEOUT_MS}ms`
          : `Failed to reach upstream: ${err?.message || err}`,
        'api_error',
        aborted ? 'upstream_timeout' : 'upstream_unreachable',
      ),
    );
  }
  clearTimeout(connectTimer);

  // 建连已成功：改用空闲超时，长文本流式输出不会被建连超时误杀。
  let idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  const reader = upstream.body?.getReader();
  if (!reader) {
    res.removeListener('close', onClose);
    clearTimeout(idleTimer);
    return pipeUpstream(upstream, res);
  }

  setCors(res);
  res.statusCode = upstream.status;
  for (const [key, value] of upstream.headers) {
    if (FORWARD_RESPONSE_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
  }
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
      if (res.writableEnded || res.destroyed) {
        await reader.cancel().catch(() => {});
        break;
      }
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
    res.end();
  } catch (err) {
    // 响应头已发出，无法再改状态码；按官方本地代理的做法直接断流（绝不伪造 [DONE]）。
    if (!res.writableEnded) res.end();
  } finally {
    clearTimeout(idleTimer);
    res.removeListener('close', onClose);
  }
}

export default async function handler(req, res) {
  const method = String(req.method || 'GET').toUpperCase();

  if (method === 'OPTIONS') {
    setCors(res);
    res.statusCode = 204;
    res.setHeader('Content-Length', '0');
    res.end();
    return;
  }

  if (!isAuthorized(req)) {
    return sendJson(res, 401, errorPayload('Invalid API key for this proxy', 'invalid_request_error', 'invalid_api_key'));
  }

  const upstreamPath = resolveUpstreamPath(req);

  if (method === 'GET' || method === 'HEAD') {
    return handleGet(req, res, upstreamPath);
  }

  if (method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return sendJson(res, 405, errorPayload(`Method ${method} not allowed`));
  }

  if (!ALLOWED_PATHS.has(upstreamPath)) {
    return sendJson(
      res,
      404,
      errorPayload(
        `Unsupported path: /v1${upstreamPath}. Supported: ${[...ALLOWED_PATHS].join(', ')}`,
        'invalid_request_error',
        'not_found',
      ),
    );
  }

  return handlePost(req, res, upstreamPath);
}
