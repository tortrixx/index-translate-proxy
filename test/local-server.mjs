/**
 * 本地模拟 Vercel 运行环境，用于在部署前验证 api/v1/[...path].js。
 *
 * 刻意复刻了 Vercel 的两个关键行为，否则本地测过了线上仍可能翻车：
 *   1. vercel.json 里的 rewrites：/v1/* → /api/v1/*
 *   2. Node runtime 会把 application/json 请求体预解析到 req.body（流已被消费）
 *
 * 环境变量：
 *   PORT          监听端口（默认 8080）
 *   PREPARE_BODY  1=预解析 JSON body（默认，模拟 Vercel）；0=让 handler 自己读流
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// 直接加载共享 handler；Vercel 上的路由由 api/v1/** 下的显式文件负责
const handlerPath = path.join(here, '..', 'lib', 'proxy.js');
const { default: handler } = await import(pathToFileURL(handlerPath).href);

const PORT = Number(process.env.PORT || 8080);
const PREPARE_BODY = process.env.PREPARE_BODY !== '0';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 1. 模拟 vercel.json rewrites
  if (/^\/v1(\/|$)/.test(url.pathname)) {
    req.url = '/api' + url.pathname + url.search;
  }

  // 2. 模拟 Vercel 对 JSON body 的预解析
  if (PREPARE_BODY && req.method === 'POST' && /application\/json/i.test(req.headers['content-type'] || '')) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      req.body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch {
      req.body = undefined;
    }
  }

  try {
    await handler(req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
    }
    res.end(JSON.stringify({ error: { message: String(err?.stack || err) } }));
  }
});

server.listen(PORT, () => {
  console.log(`[local-server] listening on http://127.0.0.1:${PORT} (prepareBody=${PREPARE_BODY})`);
});
