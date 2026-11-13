import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ApiError, validateTarget, probeTarget, forwardLayout } from './forward.mjs';
import path from 'node:path';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateLayout } from '../web/lib/geometry.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

export async function createApp({ dataDir = path.join(root, 'user-data'), webDir = path.join(root, 'web'), receiveKey = '', allowForward = true } = {}) {
  let latest = null;
  await mkdir(dataDir, { recursive: true });
  const dataFile = path.join(dataDir, 'latest-layout.json');
  try {
    latest = JSON.parse(await readFile(dataFile, 'utf8'));
    if (validateLayout(latest).length) throw new Error('保存データの検証に失敗しました。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`保存データを読めません。既存ファイルを保全して起動を停止します: ${error.message}`);
  }
  let queue = Promise.resolve(), forwarding = 0;
  const server = http.createServer(async (req, res) => {
    const headers = {
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"
    };
    const json = (status, body, extra = {}) => { res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra }); res.end(body === undefined ? undefined : JSON.stringify(body)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) { json(415, { error: 'Content-Type: application/json が必要です。' }); return; }
        if (req.headers['sec-fetch-site'] === 'cross-site') { json(403, { error: '別サイトからの書き込みは許可していません。' }); return; }
        if (req.headers.origin) {
          let origin; try { origin = new URL(req.headers.origin); } catch { json(403, { error: 'Originが不正です。' }); return; }
          if (origin.host !== req.headers.host) { json(403, { error: '別オリジンからの書き込みは許可していません。' }); return; }
        }
      }
      if (url.pathname === '/api/targets/check' || url.pathname === '/api/targets/send') {
        if (!allowForward) { json(403, { error: 'このサーバーは受信専用です。転送機能は無効です。' }); return; }
        if (req.method !== 'POST') { json(405, { error: 'POSTで送信してください。' }); return; }
        if (forwarding >= 4) { json(429, { error: '送信処理中です。完了後に再度実行してください。' }); return; }
        const value = await readJsonBody(req);
        const target = validateTarget(value?.target);
        if (forwarding >= 4) { json(429, { error: '送信処理中です。完了後に再度実行してください。' }); return; }
        forwarding++;
        try { json(200, url.pathname.endsWith('/check') ? await probeTarget(target) : await forwardLayout(target, value?.layout)); }
        finally { forwarding--; }
        return;
      }
      if (url.pathname === '/api/health' && req.method === 'GET') { json(200, { ok: true, app: 'paper-to-walls', version: '1.1.0', authRequired: !!receiveKey, allowForward, hasLayout: !!latest, revision: latest?.revision ?? 0 }); return; }
      if (url.pathname === '/api/layouts/latest' && req.method === 'GET') {
        if (!latest) { json(204); return; }
        const etag = `"revision-${latest.revision}"`;
        if (req.headers['if-none-match'] === etag) { json(304, undefined, { ETag: etag }); return; }
        json(200, latest, { ETag: etag }); return;
      }
      if (url.pathname === '/api/layouts' && req.method === 'POST') {
        if (receiveKey) {
          const supplied = Buffer.from(String(req.headers['x-paper-space-key'] || '')), expected = Buffer.from(receiveKey);
          if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { json(401, { error: '受信キーが一致しません。' }); return; }
        }
        const value = await readJsonBody(req);
        const errors = validateLayout(value, { requireRevision: false }); if (errors.length) { json(422, { error: errors.join('\n') }); return; }
        // Serialize writes so simultaneous POSTs cannot receive the same revision.
        const task = queue.then(async () => {
          const saved = { schemaVersion: 1, layoutId: value.layoutId, revision: (latest?.revision ?? 0) + 1, units: 'm', wallHeight: value.wallHeight, wallThickness: value.wallThickness, walls: value.walls.map(({ id, ax, ay, bx, by }) => ({ id, ax, ay, bx, by })) };
          const temporary = `${dataFile}.tmp`;
          await writeFile(temporary, JSON.stringify(saved, null, 2) + '\n', 'utf8');
          await rename(temporary, dataFile); latest = saved;
          return saved;
        });
        queue = task.catch(() => {});
        json(201, await task); return;
      }
      if (url.pathname.startsWith('/api/')) { json(404, { error: 'APIが見つかりません。' }); return; }
      if (!['GET', 'HEAD'].includes(req.method)) { json(405, { error: 'Method not allowed' }); return; }
      let requested; try { requested = decodeURIComponent(url.pathname); } catch { json(400, { error: 'Invalid path' }); return; }
      const file = path.resolve(webDir, '.' + (requested === '/' ? '/index.html' : requested));
      const relative = path.relative(webDir, file);
      if (relative.startsWith('..') || path.isAbsolute(relative) || requested.includes('\0') || requested.includes('\\')) { json(403, { error: 'Forbidden' }); return; }
      const ext = path.extname(file).toLowerCase();
      if (!types[ext]) { json(404, { error: 'Not found' }); return; }
      let bytes; try { if (!(await stat(file)).isFile()) throw new Error(); bytes = await readFile(file); } catch { json(404, { error: 'Not found' }); return; }
      res.writeHead(200, { ...headers, 'Content-Type': types[ext], 'Content-Length': bytes.length });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (error instanceof ApiError) { if (!res.headersSent) json(error.status, { error: error.message }); return; }
      console.error(error);
      if (!res.headersSent) json(500, { error: 'サーバー側で処理に失敗しました。保存先のアクセス権とログを確認してください。' });
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  return server;
}

async function readJsonBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new ApiError(413, 'JSONは1MB以下にしてください。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'JSONを解析できません。'); }
}
