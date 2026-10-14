/**
 * 部署前验收测试：本地起 mock Vercel 环境，覆盖 CORS / 流式 / 鉴权 / 请求体改写。
 *
 *   node test/run-tests.mjs
 *
 * 其中 chat/completions 的端到端用例会真实访问 index-translate.bilibili.com。
 * 若只想跑离线用例（不依赖外网）：SKIP_UPSTREAM=1 node test/run-tests.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, 'local-server.mjs');
const SKIP_UPSTREAM = process.env.SKIP_UPSTREAM === '1';

const results = [];
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    results.push(`  ✅ ${name}`);
  } catch (err) {
    failures++;
    results.push(`  ❌ ${name}\n       ${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function startProxy(env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[proxy] ${d}`));
  return child;
}

async function waitReady(base, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/v1`, { signal: AbortSignal.timeout(1500) });
      if (res.status > 0) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`proxy not ready at ${base}`);
}

function makeEchoUpstream() {
  const state = { captured: null };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/__captured') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(state.captured));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    state.captured = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf-8'),
    };
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        id: 'echo',
        object: 'chat.completion',
        model: 'echo',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ECHO' }, finish_reason: 'stop' }],
      }),
    );
  });
  return { server, state };
}

const ANTHROPIC = '请将以下文本翻译为英语，直接输出翻译结果，不要进行任何解释。\n\n今天天气真好。';

async function chat(base, extra = {}, headers = {}) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      model: 'Index-Translate-35B-A3B',
      messages: [{ role: 'user', content: ANTHROPIC }],
      max_tokens: 128,
      ...extra,
    }),
  });
}

async function main() {
  // ---------- A. 主服务（模拟 Vercel 预解析 body） ----------
  const PORT_A = 8801;
  const BASE_A = `http://127.0.0.1:${PORT_A}`;
  const proxyA = startProxy({ PORT: String(PORT_A), PREPARE_BODY: '1' });
  await waitReady(BASE_A);

  try {
    await test('OPTIONS 预检返回 204 且带 CORS 头', async () => {
      const res = await fetch(`${BASE_A}/v1/chat/completions`, { method: 'OPTIONS' });
      assertEqual(res.status, 204, '状态码');
      assertEqual(res.headers.get('access-control-allow-origin'), '*', 'ACAO');
      assert(/POST/.test(res.headers.get('access-control-allow-methods') || ''), 'allow-methods 应含 POST');
      await res.text();
    });

    await test('GET /v1 返回服务状态 JSON', async () => {
      const res = await fetch(`${BASE_A}/v1`);
      assertEqual(res.status, 200, '状态码');
      assertEqual(res.headers.get('access-control-allow-origin'), '*', 'ACAO');
      const data = await res.json();
      assertEqual(data.status, 'ok', 'status');
      assert(/index-translate\.bilibili\.com/.test(data.upstream), 'upstream 应指向官方地址');
    });

    await test('GET /v1/models 返回模型列表并带 CORS', async () => {
      const res = await fetch(`${BASE_A}/v1/models`);
      assertEqual(res.status, 200, '状态码');
      assertEqual(res.headers.get('access-control-allow-origin'), '*', 'ACAO');
      const data = await res.json();
      assert(Array.isArray(data.data) && data.data.length > 0, 'data 应为非空数组');
      assert(data.data.some((m) => m.id === 'Index-Translate-35B-A3B'), '应包含 35B 模型');
    });

    await test('GET /v1/models 在上游不可用时回退到内置模型表', async () => {
      // 指向一个不存在的上游
      const PORT_F = 8805;
      const BASE_F = `http://127.0.0.1:${PORT_F}`;
      const proxyF = startProxy({
        PORT: String(PORT_F),
        UPSTREAM_BASE: 'http://127.0.0.1:1/v1',
        CONNECT_TIMEOUT_MS: '1500',
      });
      try {
        await waitReady(BASE_F);
        const res = await fetch(`${BASE_F}/v1/models`);
        assertEqual(res.status, 200, '状态码');
        const data = await res.json();
        assertEqual(data.data[0].id, 'Index-Translate-35B-A3B', '回退模型 id');
        assertEqual(res.headers.get('x-proxy-fallback') !== null, true, '应带 x-proxy-fallback 标记');
      } finally {
        proxyF.kill('SIGKILL');
      }
    });

    await test('未知路径 POST 返回 404（不转发任意路径）', async () => {
      const res = await fetch(`${BASE_A}/v1/whatever`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assertEqual(res.status, 404, '状态码');
      assertEqual(res.headers.get('access-control-allow-origin'), '*', '错误响应也要有 CORS（否则浏览器里看不到真实报错）');
    });

    if (!SKIP_UPSTREAM) {
      await test('POST /v1/chat/completions 非流式真实翻译成功', async () => {
        const res = await chat(BASE_A);
        assertEqual(res.status, 200, '状态码');
        assertEqual(res.headers.get('access-control-allow-origin'), '*', 'ACAO');
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        assert(typeof content === 'string' && content.trim().length > 0, '译文不应为空');
        assert(/weather/i.test(content), `译文应为英文，实际: ${content}`);
      });

      await test('POST /v1/chat/completions 流式 SSE 增量返回', async () => {
        const res = await chat(BASE_A, { stream: true });
        assertEqual(res.status, 200, '状态码');
        assert(/text\/event-stream/.test(res.headers.get('content-type') || ''), 'content-type 应为 SSE');
        assertEqual(res.headers.get('access-control-allow-origin'), '*', 'ACAO');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let text = '';
        let reads = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          reads++;
          text += decoder.decode(value, { stream: true });
        }
        const events = text.split('\n').filter((l) => l.startsWith('data: '));
        assert(events.length >= 2, `应至少收到 2 个 SSE 事件，实际 ${events.length}`);
        assert(text.includes('data: [DONE]'), '应带 [DONE] 结束标记');
        const assembled = events
          .filter((l) => !l.includes('[DONE]'))
          .map((l) => {
            try {
              return JSON.parse(l.slice(6))?.choices?.[0]?.delta?.content || '';
            } catch {
              return '';
            }
          })
          .join('');
        assert(/weather/i.test(assembled), `拼接后的流式译文应含 weather，实际: ${assembled}`);
        console.log(`       · 流式分片读取次数: ${reads}，事件数: ${events.length}`);
      });
    } else {
      results.push('  ⏭  跳过真实上游用例（SKIP_UPSTREAM=1）');
    }
  } finally {
    proxyA.kill('SIGKILL');
  }

  // ---------- B. 不预解析 body（handler 自己读流） ----------
  const PORT_B = 8802;
  const BASE_B = `http://127.0.0.1:${PORT_B}`;
  const proxyB = startProxy({ PORT: String(PORT_B), PREPARE_BODY: '0' });
  await waitReady(BASE_B);
  try {
    await test('未预解析 body 时 handler 能自己从流里读（PREPARE_BODY=0）', async () => {
      const { server, state } = makeEchoUpstream();
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const echoPort = server.address().port;
      const PORT_C = 8803;
      const BASE_C = `http://127.0.0.1:${PORT_C}`;
      const proxyC = startProxy({
        PORT: String(PORT_C),
        PREPARE_BODY: '0',
        UPSTREAM_BASE: `http://127.0.0.1:${echoPort}/v1`,
      });
      try {
        await waitReady(BASE_C);
        const res = await chat(BASE_C);
        assertEqual(res.status, 200, '状态码');
        assert(state.captured, '上游应收到请求');
        const sent = JSON.parse(state.captured.body);
        assertEqual(sent.messages[0].content.includes('今天天气真好'), true, 'body 应完整传到上游');
      } finally {
        proxyC.kill('SIGKILL');
        server.close();
      }
    });
  } finally {
    proxyB.kill('SIGKILL');
  }

  // ---------- C. 请求体改写 / 头部隔离（echo 上游） ----------
  const { server: echo, state } = makeEchoUpstream();
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const echoPort = echo.address().port;
  const PORT_D = 8804;
  const BASE_D = `http://127.0.0.1:${PORT_D}`;
  const proxyD = startProxy({
    PORT: String(PORT_D),
    UPSTREAM_BASE: `http://127.0.0.1:${echoPort}/v1`,
  });
  await waitReady(BASE_D);

  try {
    await test('默认注入 enable_thinking=false 与 temperature=0', async () => {
      await chat(BASE_D, {}, { Authorization: 'Bearer index' });
      const sent = JSON.parse(state.captured.body);
      assertEqual(sent.chat_template_kwargs.enable_thinking, false, 'enable_thinking');
      assertEqual(sent.temperature, 0, 'temperature');
    });

    await test('用户显式传入的 enable_thinking / temperature 不被覆盖', async () => {
      await chat(BASE_D, { temperature: 0.7, chat_template_kwargs: { enable_thinking: true } });
      const sent = JSON.parse(state.captured.body);
      assertEqual(sent.chat_template_kwargs.enable_thinking, true, 'enable_thinking');
      assertEqual(sent.temperature, 0.7, 'temperature');
    });

    await test('不把客户端 Authorization 泄漏给上游', async () => {
      await chat(BASE_D, {}, { Authorization: 'Bearer super-secret-key' });
      const auth = state.captured.headers.authorization;
      assert(auth === undefined, `不应转发 Authorization，实际: ${auth}`);
      assert(!state.captured.body.includes('super-secret-key'), 'body 里也不应出现密钥');
    });

    await test('转发路径与上游 UA 正确', async () => {
      await chat(BASE_D);
      assertEqual(state.captured.url, '/v1/chat/completions', '上游路径');
      assert(/Index-Translate-Vercel-Proxy/.test(state.captured.headers['user-agent'] || ''), 'UA 应为代理标识');
    });

    await test('透传上游流式响应头与内容', async () => {
      const res = await chat(BASE_D);
      assertEqual(res.status, 200, '状态码');
      const data = await res.json();
      assertEqual(data.choices[0].message.content, 'ECHO', 'echo 内容');
    });
  } finally {
    proxyD.kill('SIGKILL');
    echo.close();
  }

  // ---------- D. 可选鉴权 ----------
  const PORT_E = 8806;
  const BASE_E = `http://127.0.0.1:${PORT_E}`;
  const proxyE = startProxy({ PORT: String(PORT_E), PROXY_API_KEY: 'secret-key-123' });
  await waitReady(BASE_E);
  try {
    await test('设置 PROXY_API_KEY 后无密钥返回 401（含 CORS 头）', async () => {
      const res = await chat(BASE_E);
      assertEqual(res.status, 401, '状态码');
      assertEqual(res.headers.get('access-control-allow-origin'), '*', 'ACAO');
      const data = await res.json();
      assert(/api key/i.test(data.error.message), '应给出密钥错误说明');
    });

    await test('携带正确 Bearer 密钥可正常通过鉴权', async () => {
      const res = await chat(BASE_E, {}, { Authorization: 'Bearer secret-key-123' });
      assert(res.status !== 401, `不应再是 401，实际 ${res.status}`);
      await res.text();
    });

    await test('支持 ?key= 查询参数鉴权（给无法自定义头的客户端）', async () => {
      const res = await fetch(`${BASE_E}/v1/chat/completions?key=secret-key-123`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'Index-Translate-35B-A3B', messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert(res.status !== 401, `不应再是 401，实际 ${res.status}`);
      await res.text();
    });

    await test('GET /v1 状态接口在开启鉴权时也需密钥', async () => {
      const res = await fetch(`${BASE_E}/v1`);
      assertEqual(res.status, 401, '状态码');
    });
  } finally {
    proxyE.kill('SIGKILL');
  }

  console.log('\n测试结果：');
  console.log(results.join('\n'));
  console.log(failures === 0 ? '\n🎉 全部通过' : `\n❌ ${failures} 个用例失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试脚本异常：', err);
  process.exit(1);
});
