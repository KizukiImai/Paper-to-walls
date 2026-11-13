/** LAN-only HTTP relay. Browsers never fetch another origin directly. */
import http from 'node:http';
import { isIP } from 'node:net';
import { validateLayout } from '../web/lib/geometry.js';
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function validateTarget(value) {
  if (!value || typeof value !== 'object') throw new ApiError(422, '送信先のIPアドレスとポートを入力してください。');
  const host = typeof value.host === 'string' ? value.host.trim() : '';
  if (isIP(host) !== 4) throw new ApiError(422, 'IPアドレスはIPv4形式で入力してください（例: 192.168.1.50）。http://やポートは含めません。');
  const [a, b] = host.split('.').map(Number);
  if (!(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127)) throw new ApiError(422, '送信先はプライベートIPv4またはループバックに限定しています。');
  const port = value.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiError(422, 'ポートは1〜65535の整数にしてください。');
  const key = value.key ?? '';
  if (typeof key !== 'string' || key.length > 256 || /[^\x21-\x7e]/.test(key)) throw new ApiError(422, '受信キーは空、または256文字以下の半角英数字・記号で入力してください。');
  return { host, port, key };
}
export function requestTarget(target, method, route, value, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const data = value === undefined ? null : Buffer.from(JSON.stringify(value));
    const headers = { Accept: 'application/json' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    if (target.key) headers['X-Paper-Space-Key'] = target.key;
    let timer;
    const req = http.request({ host: target.host, port: target.port, path: route, method, headers, agent: false }, res => {
      const chunks = []; let count = 0;
      res.on('data', chunk => {
        count += chunk.length;
        if (count > 1024 * 1024) { req.destroy(new ApiError(502, '受信先からの応答が大きすぎます。')); return; }
        chunks.push(chunk);
      });
      res.on('error', error=>{clearTimeout(timer);reject(new ApiError(502, `受信先の応答が中断されました（${error.code || '通信エラー'}）。`));});
      res.on('end', () => {
        clearTimeout(timer);
        if (res.statusCode >= 300 && res.statusCode < 400) { reject(new ApiError(502, '送信先がリダイレクトを返しました。転送は行いません。IP・ポートを確認してください。')); return; }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { reject(new ApiError(502, '送信先がJSONを返しません。受信用サーバーのポートを確認してください。')); return; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = res.statusCode === 401 ? '受信キーが一致しません。' : `受信先エラー HTTP ${res.statusCode}: ${String(body.error || '送信が拒否されました。').slice(0, 250)}`;
          reject(new ApiError(502, error)); return;
        }
        resolve(body);
      });
    });
    timer = setTimeout(() => req.destroy(new ApiError(504, `送信先 ${target.host}:${target.port} が応答しません。受信サーバー、Firewall、IPアドレスを確認してください。`)), timeout);
    req.on('error', error => {
      clearTimeout(timer);
      reject(error instanceof ApiError ? error : new ApiError(502, `送信先 ${target.host}:${target.port} に接続できません（${error.code || '通信エラー'}）。受信サーバーの起動とポートを確認してください。`));
    });
    req.end(data);
  });
}
export async function probeTarget(target) {
  const result = await requestTarget(target, 'GET', '/api/health');
  if (result?.ok !== true || result?.app !== 'paper-to-walls') throw new ApiError(502, 'PAPER / SPACEの受信APIではありません。受信用サーバーを起動してください。');
  if (result.authRequired && !target.key) throw new ApiError(422, '受信先は受信キーを要求しています。受信キーを入力してください。');
  return { ok: true, revision: result.revision || 0, version: result.version, receiver: result.app, authRequired: !!result.authRequired };
}
export async function forwardLayout(target, layout) {
  const errors = validateLayout(layout, { requireRevision: false });
  if (errors.length) throw new ApiError(422, errors.join('\n'));
  await probeTarget(target);
  // Do not forward the envelope, UI configuration, credentials, or source images.
  const body = { schemaVersion: 1, layoutId: layout.layoutId, units: 'm', wallHeight: layout.wallHeight, wallThickness: layout.wallThickness,
    walls: layout.walls.map(({ id, ax, ay, bx, by }) => ({ id, ax, ay, bx, by })) };
  const saved = await requestTarget(target, 'POST', '/api/layouts', body);
  if (validateLayout(saved).length || saved.layoutId !== body.layoutId || saved.wallHeight !== body.wallHeight || saved.wallThickness !== body.wallThickness ||
      saved.walls.length !== body.walls.length || saved.walls.some((w, i) => ['id', 'ax', 'ay', 'bx', 'by'].some(k => w[k] !== body.walls[i][k]))) {
    throw new ApiError(502, '送信先の保存確認が一致しません。送信結果は不明です。受信先の最新JSONを確認してください。');
  }
  return { ok: true, target: { host: target.host, port: target.port }, revision: saved.revision, layoutId: saved.layoutId, wallCount: saved.walls.length, delivery: 'stored-on-receiver' };
}
