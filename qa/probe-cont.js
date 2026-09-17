'use strict';
/**
 * 验证「一节连跨三页时标题出现『（续）（续）』」这个问题。
 * 做法：打开导出预览（裸 HTML），把首页第一节的条目复制若干份撑成超长节，
 * 手动触发分页，再把每一页的 h2 文本读出来看续页后缀拼了几次。
 * 用法：WB_BASE=http://127.0.0.1:8777 node probe-cont.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.WB_BROWSER
].filter(Boolean).find(p => { try { return fs.existsSync(p); } catch (_) { return false; } }) || 'msedge.exe';
const PORT = Number(process.env.WB_CDP_PORT || 9346);
const BASE = process.env.WB_BASE || 'http://127.0.0.1:8777';
const PROFILE = path.join(require('os').tmpdir(), '_wb_cdpprof_cont');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
async function waitForDevtools(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { return await getJson(`http://127.0.0.1:${PORT}/json/version`); } catch (_) { await sleep(300); }
  }
  throw new Error('devtools 端口没起来');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = {}; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连接失败')); });
    const c = new CDP(ws);
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { resolve, reject } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.method + ' ' + JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method && c.handlers[msg.method]) c.handlers[msg.method](msg.params);
    };
    return c;
  }
  on(m, fn) { this.handlers[m] = fn; }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('超时 ' + method)); } }, 30000);
    });
  }
  async eval(expr, awaitPromise) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: !!awaitPromise, userGesture: true
    });
    if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  }
}

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--mute-audio',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--window-size=1440,1200', '--force-device-scale-factor=1', 'about:blank'
  ], { stdio: 'ignore', windowsHide: true });

  let cdp;
  try {
    await waitForDevtools(20000);
    const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    const page = list.find(t => t.type === 'page');
    cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    await cdp.send('Page.navigate', { url: BASE + '/api/export/preview?profile=job&template=classic' });
    await sleep(3500);
    for (let i = 0; i < 20; i++) {
      const ready = await cdp.eval('window.__pagesReady === true && typeof window.__paginate === "function"').catch(() => false);
      if (ready) break;
      await sleep(400);
    }

    const base = await cdp.eval(`(function () {
      var sheets = document.querySelectorAll('.a4');
      var sects = sheets[0] ? sheets[0].querySelectorAll('.sect') : [];
      var names = [];
      for (var i = 0; i < sects.length; i++) {
        var h2 = sects[i].querySelector('h2');
        names.push((h2 ? h2.textContent : '(无题)') + ' [' + sects[i].querySelectorAll('.entry').length + ' 条]');
      }
      return { pages: sheets.length, sects: names };
    })()`);
    console.log('注入前：' + base.pages + ' 页，首页各节：');
    base.sects.forEach(s => console.log('  ' + s));

    // 把首页第一个有 entry 的节撑成超长节，逼它跨三页以上
    const injected = await cdp.eval(`(function () {
      var sheets = document.querySelectorAll('.a4');
      var sects = sheets[0].querySelectorAll('.sect');
      for (var i = 0; i < sects.length; i++) {
        var entry = sects[i].querySelector('.entry');
        if (!entry) continue;
        for (var k = 0; k < 45; k++) sects[i].appendChild(entry.cloneNode(true));
        var h2 = sects[i].querySelector('h2');
        return '注入节：' + (h2 ? h2.textContent : '(无题)') + ' -> ' + sects[i].querySelectorAll('.entry').length + ' 条';
      }
      return '没找到可注入的节';
    })()`);
    console.log(injected);

    await cdp.eval('window.__paginate(); "ok"');
    await sleep(1500);

    const after = await cdp.eval(`(function () {
      var sheets = document.querySelectorAll('.a4');
      var out = [];
      for (var i = 0; i < sheets.length; i++) {
        var h2 = sheets[i].querySelector('h2');
        out.push({
          i: i + 1,
          title: h2 ? h2.textContent : '(无题)',
          entries: sheets[i].querySelectorAll('.entry').length,
          over: Math.round(sheets[i].scrollHeight - 1123)
        });
      }
      return out;
    })()`);

    console.log('');
    console.log('分页后：' + after.length + ' 页');
    after.forEach(p => console.log('  P' + String(p.i).padStart(2) + ' 溢出' + String(p.over).padStart(5) + 'px  [' + String(p.entries).padStart(2) + ' 条]  ' + p.title));

    const dup = after.filter(p => /（续）\s*（续）|\(cont\.\)\s*\(cont\.\)/.test(p.title));
    console.log('');
    console.log(dup.length ? '✗ 发现重复后缀 ' + dup.length + ' 处：' + dup.map(p => 'P' + p.i).join(', ') : '✓ 无重复后缀');
    const overflow = after.filter(p => p.over > 0);
    console.log(overflow.length ? '✗ 有 ' + overflow.length + ' 页溢出' : '✓ 无页溢出');
  } finally {
    try { child.kill(); } catch (_) {}
  }
})().catch(e => { console.error('探针失败：' + e.message); process.exit(1); });
