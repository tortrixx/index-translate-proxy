/**
 * 线上验收：对已部署的 Vercel 服务跑真实请求。
 *
 *   PROXY_URL=https://xxx.vercel.app PROXY_API_KEY=xxx node test/live-check.mjs
 *
 * 覆盖：静态页、健康检查、鉴权、CORS（含浏览器 Origin 模拟）、非流式、SSE 流式、
 * 扩展真实使用的「批量 JSON 数组」翻译形态、以及错误路径透传。
 */
const BASE = (process.env.PROXY_URL || '').replace(/\/+$/, '');
const KEY = process.env.PROXY_API_KEY || '';

if (!BASE) {
  console.error('请设置 PROXY_URL，例如 PROXY_URL=https://xxx.vercel.app node test/live-check.mjs');
  process.exit(2);
}

const results = [];
let failures = 0;

async function test(name, fn) {
  try {
    const info = await fn();
    results.push(`  ✅ ${name}${info ? ` — ${info}` : ''}`);
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

const authHeaders = KEY ? { Authorization: `Bearer ${KEY}` } : {};

async function chat(body) {
  return fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://example.com', ...authHeaders },
    body: JSON.stringify(body),
  });
}

const TRANSLATE = (text) => ({
  model: 'Index-Translate-35B-A3B',
  messages: [
    { role: 'user', content: `请将以下文本翻译为英语，直接输出翻译结果，不要进行任何解释。\n\n${text}` },
  ],
  max_tokens: 512,
});

async function main() {
  console.log(`目标服务: ${BASE}\n鉴权: ${KEY ? '已启用 PROXY_API_KEY' : '未启用（不带密钥）'}\n`);

  await test('状态页 GET / 可访问', async () => {
    const res = await fetch(BASE);
    assertEqual(res.status, 200, '状态码');
    const html = await res.text();
    assert(/Index-Translate/.test(html), '页面应包含服务标识');
    return `${html.length} bytes`;
  });

  await test('健康检查 GET /v1 返回服务信息', async () => {
    const res = await fetch(`${BASE}/v1`, { headers: authHeaders });
    assertEqual(res.status, 200, '状态码');
    const data = await res.json();
    assertEqual(data.status, 'ok', 'status');
    assert(/index-translate\.bilibili\.com/.test(data.upstream), 'upstream 应为官方地址');
    return `region=${res.headers.get('x-vercel-id') || 'n/a'}`;
  });

  if (KEY) {
    await test('错误密钥被拒绝（401）且带 CORS 头', async () => {
      const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-key' },
        body: JSON.stringify(TRANSLATE('你好')),
      });
      assertEqual(res.status, 401, '状态码');
      assertEqual(res.headers.get('access-control-allow-origin'), '*', '401 也必须带 CORS，否则浏览器里只能看到 CORS 报错');
      return '401 + ACAO:*';
    });

    await test('无密钥被拒绝（401）', async () => {
      const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(TRANSLATE('你好')),
      });
      assertEqual(res.status, 401, '状态码');
      return '401';
    });
  }

  await test('OPTIONS 预检通过（浏览器跨域必需）', async () => {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST' },
    });
    assertEqual(res.status, 204, '状态码');
    assertEqual(res.headers.get('access-control-allow-origin'), '*', 'ACAO');
    assert(/POST/.test(res.headers.get('access-control-allow-methods') || ''), 'allow-methods 应含 POST');
    await res.text();
    return '204 + ACAO:*';
  });

  await test('GET /v1/models 返回模型列表', async () => {
    const res = await fetch(`${BASE}/v1/models`, { headers: { Origin: 'https://example.com', ...authHeaders } });
    assertEqual(res.status, 200, '状态码');
    assertEqual(res.headers.get('access-control-allow-origin'), '*', 'ACAO');
    const data = await res.json();
    assert(data.data.some((m) => m.id === 'Index-Translate-35B-A3B'), '应包含 Index-Translate-35B-A3B');
    return data.data.map((m) => m.id).join(', ');
  });

  await test('非流式翻译：中译英正确返回', async () => {
    const t0 = Date.now();
    const res = await chat(TRANSLATE('技术赋能创作，让交流跨越语言的界限。'));
    const ms = Date.now() - t0;
    assertEqual(res.status, 200, '状态码');
    assertEqual(res.headers.get('access-control-allow-origin'), '*', 'ACAO');
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content?.trim();
    assert(content && content.length > 0, '译文不应为空');
    return `${ms}ms · "${content}"`;
  });

  await test('SSE 流式：增量返回且以 [DONE] 结束', async () => {
    const res = await chat({ ...TRANSLATE('今天天气真好，我们去公园散步吧。'), stream: true });
    assertEqual(res.status, 200, '状态码');
    assert(/text\/event-stream/.test(res.headers.get('content-type') || ''), `content-type 应为 SSE，实际 ${res.headers.get('content-type')}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let reads = 0;
    const stamps = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      reads++;
      stamps.push(Date.now());
      text += decoder.decode(value, { stream: true });
    }
    const events = text.split('\n').filter((l) => l.startsWith('data: '));
    assert(events.length >= 2, `应至少 2 个 SSE 事件，实际 ${events.length}`);
    assert(text.includes('data: [DONE]'), '应带 [DONE]');
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
    assert(assembled.trim().length > 0, '拼接后的译文不应为空');
    const span = stamps.length > 1 ? stamps[stamps.length - 1] - stamps[0] : 0;
    return `${events.length} 事件 / ${reads} 次读取 / 跨度 ${span}ms · "${assembled.trim()}"`;
  });

  await test('扩展真实用法：批量 JSON 数组翻译（system prompt + 数组）', async () => {
    const texts = ['登录以继续', '这是一个示例页面', 'https://example.com'];
    const res = await chat({
      model: 'Index-Translate-35B-A3B',
      temperature: 1.0,
      max_tokens: 1024,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        {
          role: 'system',
          content:
            '你是一个专业的翻译引擎。将用户给出的 JSON 字符串数组中的每一项翻译成English。\n要求：\n1. 只输出一个 JSON 字符串数组，长度与输入完全一致，顺序一一对应。\n2. 保留原文中的专有名词、代码、数字格式。\n3. 不要输出任何解释或 markdown 代码块标记。',
        },
        { role: 'user', content: JSON.stringify(texts) },
      ],
    });
    assertEqual(res.status, 200, '状态码');
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content?.trim() || '';
    const cleaned = content.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    assert(Array.isArray(parsed), '应返回 JSON 数组');
    assertEqual(parsed.length, texts.length, '数组长度需与输入一致');
    return JSON.stringify(parsed);
  });

  await test('不支持的路径不被转发（404）', async () => {
    const res = await fetch(`${BASE}/v1/definitely-not-a-real-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: '{}',
    });
    assert(res.status === 404, `应 404，实际 ${res.status}`);
    return '404';
  });

  console.log(results.join('\n'));
  console.log(failures === 0 ? '\n🎉 线上验收全部通过' : `\n❌ ${failures} 个用例失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('验收脚本异常：', err);
  process.exit(1);
});
