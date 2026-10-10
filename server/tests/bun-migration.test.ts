import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const entry of ['app.ts', 'dist/app.js']) {
  test(`Bun HTTP 验收 (${entry})：静态文件、SQLite 写入与撤销`, async () => {
    const folder = mkdtempSync(join(tmpdir(), 'holdings-bun-'));
    const serverRoot = fileURLToPath(new URL('..', import.meta.url));
    const child = Bun.spawn([process.execPath, '--eval', `
      import app from ${JSON.stringify('./' + entry)};
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
      console.log('BUN_CHECK_PORT=' + server.port);
    `], {
      cwd: serverRoot,
      env: { ...process.env, HOLDINGS_DB_PATH: join(folder, 'test.db') },
      stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const reader = child.stdout.getReader();
      let output = '';
      let port = '';
      while (!port) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('验收服务器提前退出: ' + await new Response(child.stderr).text());
        output += new TextDecoder().decode(chunk.value);
        port = output.match(/BUN_CHECK_PORT=(\d+)/)?.[1] || '';
      }
      reader.releaseLock();
      const url = `http://127.0.0.1:${port}`;
      const home = await fetch(url);
      assert.equal(home.status, 200);
      assert.match(home.headers.get('content-type') || '', /text\/html/);
      assert.match(await home.text(), /HoldingsLens/);
      for (const path of ['/app.js', '/js/history.js', '/style.css', '/favicon.svg', '/' + encodeURIComponent('持仓明细展示.html')]) {
        const response = await fetch(url + path);
        assert.equal(response.status, 200, path);
        assert.ok((await response.arrayBuffer()).byteLength > 0, path);
      }
      assert.equal((await fetch(url + '/missing-file')).status, 404);
      assert.equal((await (await fetch(url + '/api/status')).json()).status, 'ok');
      const initial = await (await fetch(url + '/api/base-holdings')).json();
      const original = initial.holdings.find((h: { code: string }) => h.code === '512170.SH');
      const created = await fetch(url + '/api/transactions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: original.code, type: 'buy', trade_date: '2026-10-10', quantity: 100, amount_cny: 40, note: '验收模拟交易' }),
      });
      assert.equal(created.status, 200);
      assert.equal((await created.json()).new_quantity, original.quantity + 100);
      const list = await (await fetch(url + '/api/transactions?limit=50')).json();
      assert.equal(list.transactions.length, 1);
      assert.equal(list.transactions[0].note, '验收模拟交易');
      const undone = await fetch(url + '/api/transactions/' + list.transactions[0].id, { method: 'DELETE' });
      assert.equal(undone.status, 200);
      assert.equal((await undone.json()).new_quantity, original.quantity);
      assert.equal((await (await fetch(url + '/api/transactions?limit=50')).json()).transactions.length, 0);
    } finally {
      child.kill();
      await child.exited;
      rmSync(folder, { recursive: true, force: true });
    }
  }, 10000);
}

test('GBK 中文行情解码兼容', () => {
  assert.equal(new TextDecoder('gbk').decode(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])), '中文');
});

test('macOS 通知使用的子进程回调接口兼容（不发送通知）', async () => {
  await new Promise<void>((resolve, reject) => execFile('/usr/bin/true', [], err => err ? reject(err) : resolve()));
});
