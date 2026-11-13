import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
const valid = { schemaVersion: 1, layoutId: 'test', units: 'm', wallHeight: 2.5, wallThickness: 0.15, walls: [{ id: 'wall-001', ax: 0, ay: 0, bx: 4, by: 0 }] };
async function setup() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'paper-space-')), server = await createApp({ dataDir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { dataDir, server, base: `http://127.0.0.1:${server.address().port}`, close: async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); } };
}
test('API health, empty state, POST, GET and ETag', async () => {
  const app = await setup(); try {
    assert.equal((await (await fetch(app.base + '/api/health')).json()).ok, true);
    assert.equal((await fetch(app.base + '/api/layouts/latest')).status, 204);
    const post = await fetch(app.base + '/api/layouts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(valid) });
    assert.equal(post.status, 201); const saved = await post.json(); assert.equal(saved.revision, 1);
    const get = await fetch(app.base + '/api/layouts/latest'); assert.deepEqual(await get.json(), saved);
    assert.equal((await fetch(app.base + '/api/layouts/latest', { headers: { 'If-None-Match': get.headers.get('etag') } })).status, 304);
  } finally { await app.close(); }
});
test('invalid JSON, invalid geometry and cross-origin writes are rejected without replacing data', async () => {
  const app = await setup(); try {
    const post = (body, extra = {}) => fetch(app.base + '/api/layouts', { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body });
    assert.equal((await post('{')).status, 400);
    assert.equal((await post(JSON.stringify({ ...valid, wallHeight: -2 }))).status, 422);
    assert.equal((await post(JSON.stringify(valid), { Origin: 'http://untrusted.example' })).status, 403);
    assert.equal((await fetch(app.base + '/api/layouts/latest')).status, 204);
  } finally { await app.close(); }
});
test('concurrent POSTs get unique increasing revisions and survive restart', async () => {
  const app = await setup(); let second;
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => fetch(app.base + '/api/layouts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(valid) }).then(r => r.json())));
    assert.deepEqual(results.map(r => r.revision).sort(), [1, 2, 3, 4]);
    assert.equal(JSON.parse(await readFile(path.join(app.dataDir, 'latest-layout.json'), 'utf8')).revision, 4);
    second = await createApp({ dataDir: app.dataDir }); await new Promise(resolve => second.listen(0, '127.0.0.1', resolve));
    const latest = await (await fetch(`http://127.0.0.1:${second.address().port}/api/layouts/latest`)).json(); assert.equal(latest.revision, 4);
  } finally { if (second) await new Promise(r => second.close(r)); await app.close(); }
});
test('empty walls array explicitly clears latest geometry', async () => {
  const app = await setup(); try {
    const res = await fetch(app.base + '/api/layouts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...valid, walls: [] }) });
    assert.equal(res.status, 201); assert.deepEqual((await res.json()).walls, []);
  } finally { await app.close(); }
});
