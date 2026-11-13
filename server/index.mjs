import { createApp } from './app.mjs';
import os from 'node:os';
const port = Number(process.env.PORT || 3000), host = process.env.HOST || '0.0.0.0';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORTには1〜65535の整数を指定してください。');
try {
  const server = await createApp({ ...(process.env.DATA_DIR ? { dataDir: process.env.DATA_DIR } : {}), receiveKey: process.env.RECEIVE_KEY || '', allowForward: process.env.RECEIVE_ONLY !== '1' });
  server.on('error', err => { console.error(err.code === 'EADDRINUSE' ? `ポート${port}は使用中です。PORT環境変数で別の番号に変更してください。` : err.message); process.exitCode = 1; });
  server.listen(port, host, () => {
    console.log(`\nPAPER / SPACE — 紙の線を、空間へ。\n\nPC: http://localhost:${port}`);
    if (host !== '127.0.0.1' && host !== 'localhost') for (const list of Object.values(os.networkInterfaces())) for (const entry of list || []) if (entry.family === 'IPv4' && !entry.internal) console.log(`LAN: http://${entry.address}:${port}`);
    console.log(`\nモード: ${process.env.RECEIVE_ONLY === '1' ? '別PCからの受信専用' : 'Webアプリ / 送信・受信'} / 受信キー: ${process.env.RECEIVE_KEY ? '有効' : 'なし'}\nUnity: GET http://127.0.0.1:${port}/api/layouts/latest\n停止: Ctrl+C\n同じネットワークの端末からアクセスできます。信頼できるLAN内だけで利用してください。\n`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
} catch (error) { console.error(error.message); process.exitCode = 1; }
