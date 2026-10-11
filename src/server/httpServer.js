// 接入层：HTTP + SSE + 静态文件。只做协议转换，不含业务规则。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const MAX_BODY_BYTES = 64 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

export function createHttpServer({ service, publicDir }) {
  const sseClients = new Set();
  const heartbeat = setInterval(() => {
    for (const res of sseClients) res.write(': ping\n\n');
  }, 15000);

  service.subscribe((event) => {
    // 显式携带事件名，前端按类型分发；缺省 message 事件会被浏览器特殊处理
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(frame);
      } catch {
        sseClients.delete(res);
      }
    }
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/api/state') {
        sendJson(res, 200, service.state);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(`event: hello\ndata: ${JSON.stringify({ type: 'hello', payload: service.state, at: Date.now() })}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/messages') {
        const body = await readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) {
          sendJson(res, 400, { error: 'text 不能为空' });
          return;
        }
        const message = service.postHostMessage(text);
        sendJson(res, 201, { message });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/pause') {
        const body = await readBody(req);
        service.setPaused(Boolean(body.paused));
        sendJson(res, 200, service.state);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/reset') {
        service.clearHistory();
        sendJson(res, 200, service.state);
        return;
      }
      if (req.method === 'GET') {
        // 静态文件：归一化路径并限制在 publicDir 内，防目录穿越
        const rel = normalize(url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, ''));
        if (rel.startsWith('..')) {
          sendJson(res, 403, { error: 'forbidden' });
          return;
        }
        const file = join(publicDir, rel);
        if (!file.startsWith(normalize(publicDir))) {
          sendJson(res, 403, { error: 'forbidden' });
          return;
        }
        const content = await readFile(file);
        res.writeHead(200, { 'content-type': MIME[`.${file.split('.').pop()}`] ?? 'application/octet-stream' });
        res.end(content);
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  });

  return {
    server,
    // port 传 0 时由系统分配，必须回读真实端口（测试与脚本都依赖这一点）
    listen(port) {
      return new Promise((resolve) => server.listen(port, () => resolve(server.address().port)));
    },
    close() {
      clearInterval(heartbeat);
      for (const res of sseClients) res.end();
      // 强制断开残留连接，保证 close() 必然完成（测试与热重启依赖这一点）
      server.closeAllConnections?.();
      sseClients.clear();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
