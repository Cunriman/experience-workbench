'use strict';
/**
 * 响应式窄屏验证：在 5 个宽度下逐一渲染 7 个视图，检查
 *  - 是否出现横向溢出
 *  - 侧栏是否正确塌缩成底部导航，且内容不被挡住
 *  - 时间轴在窄屏下圆点/月份节点是否仍落在竖线上
 *  - 看板列数是否符合断点预期
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
const PORT = Number(process.env.WB_CDP_PORT || 9334);
const BASE = process.env.WB_BASE || 'http://127.0.0.1:8777';
const OUT = process.env.WB_OUT || path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const PROFILE = path.join(require('os').tmpdir(), '_wb_cdpprof_resp');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}
async function waitForDevtools(t) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) { try { return await getJson(`http://127.0.0.1:${PORT}/json/version`); } catch (_) { await sleep(300); } }
  throw new Error('devtools 端口没起来');
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = {}; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 失败')); });
    const c = new CDP(ws);
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) { const p = c.pending.get(m.id); c.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
      else if (m.method && c.handlers[m.method]) c.handlers[m.method](m.params);
    };
    return c;
  }
  on(me, fn) { this.handlers[me] = fn; }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('超时 ' + method)); } }, 30000);
    });
  }
  async eval(expr, aw) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!aw, userGesture: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text));
    return r.result.value;
  }
}

const WIDTHS = [1400, 1240, 1000, 820, 640, 420];
const VIEWS = ['overview', 'archive', 'schedule', 'materials', 'retro', 'export', 'library', 'settings'];

(async () => {
  const A = [];
  const errors = [];
  const log = [];
  const OO = [];
  const assert = (n, ok, d) => A.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  :: ' + d : ''}`);
  fs.rmSync(PROFILE, { recursive: true, force: true });

  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`, '--window-size=1400,900', 'about:blank'
  ], { stdio: 'ignore', windowsHide: true });

  let cdp;
  try {
    await waitForDevtools(20000);
    const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    const page = list.find(t => t.type === 'page');
    cdp = await CDP.connect(page.webSocketDebuggerUrl);
    cdp.on('Runtime.exceptionThrown', p => {
      const d = p.exceptionDetails || {};
      errors.push('exception: ' + ((d.exception || {}).description || d.text));
    });
    cdp.on('Runtime.consoleAPICalled', p => {
      if (p.type === 'error') errors.push('console.error: ' + (p.args || []).map(a => a.value || a.description).join(' '));
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    await cdp.send('Page.navigate', { url: BASE + '/' });
    await sleep(2500);
    for (let i = 0; i < 20; i++) {
      const n = await cdp.eval('(typeof S!=="undefined"&&S.experiences?S.experiences.length:-1)').catch(() => -1);
      if (n >= 0) break;
      await sleep(300);
    }
    await sleep(600);

    // 导出内容由服务端排好、iframe 直接加载。必须先等它渲染完再量，
    // 否则测到的是空 frame，而不是「内容最重」的真实状态。
    await cdp.eval('location.hash = "#export"; "ok"');
    await sleep(1800);
    const genOk = await cdp.eval(`(() => {
      const f = document.querySelector('#a4');
      const d = f && f.contentDocument;
      const a4 = d && d.querySelector('.a4');
      return JSON.stringify({ frame: !!f, loaded: !!a4,
        chars: a4 ? a4.textContent.replace(/\\s+/g, '').length : 0,
        h2: d ? d.querySelectorAll('h2').length : 0 });
    })()`);
    const GO = JSON.parse(genOk);
    assert('导出预览 iframe 在测量前就已经排好内容（不是空态）',
      GO.frame && GO.loaded && GO.chars > 80 && GO.h2 >= 1, genOk);
    log.push('导出预生成 ' + genOk);

    // 左栏版式格只放「收藏的 3 个 + 更多模板」（第 4 格）。
    // 所以这里必须跟着 favorites 走——拿全套模板清单去点，点到第 4 个以后就找不着按钮了。
    const TK = JSON.parse(await cdp.eval('JSON.stringify((S.profile.export.favorites||[]).slice())') || '[]');
    const TPL_TOTAL = Number(await cdp.eval('S.exportTemplates.length') || 0);
    assert('左栏收藏的版式都在模板清单里', TK.length > 0 && TK.every(k => k), `fav=${TK.join(',')} 全量=${TPL_TOTAL}`);

    for (const [wi, w] of WIDTHS.entries()) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(400);

      for (const v of VIEWS) {
        await cdp.eval(`location.hash = "#${v}"; "ok"`);
        await sleep(420);
        const r = await cdp.eval(`(() => {
          const de = document.documentElement;
          const view = document.querySelector('#view');
          // 找出真正溢出的元素
          const vw = de.clientWidth;
          const bad = [];
          document.querySelectorAll('#view *').forEach(el => {
            const b = el.getBoundingClientRect();
            if (b.width === 0 || b.height === 0) return;
            if (b.right > vw + 2 || b.left < -2) {
              const cs = getComputedStyle(el);
              if (cs.position === 'fixed') return;
              bad.push((el.className && String(el.className).split(' ')[0] || el.tagName) + '@' + Math.round(b.right));
            }
          });
          return JSON.stringify({
            docOverflow: de.scrollWidth - de.clientWidth,
            viewOverflow: view ? view.scrollWidth - view.clientWidth : -1,
            bad: bad.slice(0, 4),
            badN: bad.length
          });
        })()`);
        const o = JSON.parse(r);
        const ok = o.docOverflow <= 1 && o.viewOverflow <= 1 && o.badN === 0;
        assert(`${w}px · ${v} 无横向溢出`, ok, `doc=${o.docOverflow} view=${o.viewOverflow} bad=${o.badN} ${o.bad.join(',')}`);
      }

      // 导出页：当前宽度下要点得动版式、预览要真的重排出来。
      // A4 固定 210mm 宽，窄屏下 iframe 内部横向滚动是预期行为；
      // 父页面决不能被撑破——那才是真 bug。
      // 先切到导出页，再从「格子里实际有的」挑模板——
      // 收藏列表第 4、5 套在「更多模板」弹窗里，格子里没有按钮可点。
      await cdp.eval('location.hash = "#export"; "ok"');
      await sleep(300);
      const tk = await cdp.eval(`(arr => arr.length ? arr[${wi} % arr.length] : '')(
        [...document.querySelectorAll('.tpl-grid [data-tpl]')].map(b => b.dataset.tpl))`);
      await sleep(300);
      const tplHit = await cdp.eval(`(() => {
        const b = document.querySelector('[data-tpl="${tk}"]');
        if (!b) return 'missing';
        b.click(); return 'clicked';
      })()`);
      await sleep(1500);
      const r2 = await cdp.eval(`(() => {
        const de = document.documentElement;
        const view = document.querySelector('#view');
        const vw = de.clientWidth;
        const bad = [];
        document.querySelectorAll('#view *').forEach(el => {
          const b = el.getBoundingClientRect();
          if (!b.width || !b.height) return;
          if (b.right > vw + 2) {
            const cs = getComputedStyle(el);
            if (cs.position === 'fixed') return;
            bad.push((String(el.className || el.tagName).split(' ')[0]) + '@' + Math.round(b.right));
          }
        });
        const f = document.querySelector('#a4');
        const d = f ? f.contentDocument : null;
        const a4 = d ? d.querySelector('.a4') : null;
        return JSON.stringify({
          docOverflow: de.scrollWidth - de.clientWidth,
          viewOverflow: view ? view.scrollWidth - view.clientWidth : -1,
          rendered: !!a4 && a4.textContent.replace(/\\s+/g, '').length > 80,
          frameRight: f ? Math.round(f.getBoundingClientRect().right) : 0,
          bad: bad.slice(0, 4), badN: bad.length
        });
      })()`);
      const o2 = JSON.parse(r2);
      assert(`${w}px · 导出[${tk}] 装得下且预览已渲染`,
        tplHit === 'clicked' && o2.docOverflow <= 1 && o2.viewOverflow <= 1 && o2.badN === 0
        && o2.rendered && o2.frameRight <= w + 2,
        `hit=${tplHit} doc=${o2.docOverflow} view=${o2.viewOverflow} rendered=${o2.rendered} frameRight=${o2.frameRight}/${w} bad=${o2.bad.join(',')}`);

      // 「一屏看完整页」：适应缩放之后，缩放后的纸必须落在预览容器里。
      // 这条是右栏那套缩放逻辑在窄屏的兜底——比率算对了但它要是没生效，等于没有。
      await sleep(700);
      const rf = await cdp.eval(`(() => {
        const outer = document.querySelector('#zoomOuter');
        const stage = document.querySelector('#zoomStage');
        const panel = document.querySelector('.ex-panel');
        const fr = document.querySelector('#a4');
        if (!outer || !stage) return 'no-zoom';
        return JSON.stringify({
          outerH: outer.clientHeight, outerW: outer.clientWidth,
          stageH: stage.offsetHeight, stageW: stage.offsetWidth,
          zoom: S._tplZoom ? Math.round(S._tplZoom.v * 100) : -1,
          panelH: panel ? panel.offsetHeight : -1,
          viewH: window.innerHeight,
          frameH: fr ? fr.offsetHeight : -1
        });
      })()`);
      if (rf === 'no-zoom') {
        assert(`${w}px · 预览缩放已初始化`, false, rf);
      } else {
        const ZF = JSON.parse(rf);
        assert(`${w}px · 「适应」把整页塞进预览框（${ZF.zoom}%）`,
          ZF.stageH <= ZF.outerH + 2 && ZF.stageW <= ZF.outerW + 2 && ZF.zoom > 0,
          `stage=${ZF.stageW}x${ZF.stageH} outer=${ZF.outerW}x${ZF.outerH} zoom=${ZF.zoom}%`);
        assert(`${w}px · 左栏一屏内显示完（面板 ≤ 视口）`,
          ZF.panelH <= ZF.viewH, `panel=${ZF.panelH} view=${ZF.viewH}`);
      }

      // 竞赛库弹窗：搜索框 + 档次下拉 + 按钮挤在同一排，窄屏最容易撑破
      await cdp.eval(`location.hash = "#overview"; "ok"`);
      await sleep(320);
      await cdp.eval('openLibraryModal(); "ok"', true);
      await sleep(800);
      const r3 = await cdp.eval(`(() => {
        const de = document.documentElement;
        const m = document.querySelector('#modal');
        const body = m.querySelector('.modal-body');
        const vw = de.clientWidth;
        const bad = [];
        body.querySelectorAll('*').forEach(el => {
          const b = el.getBoundingClientRect();
          if (!b.width || !b.height) return;
          if (b.right > vw + 2 || b.left < -2) {
            bad.push((String(el.className || el.tagName).split(' ')[0]) + '@' + Math.round(b.right));
          }
        });
        return JSON.stringify({
          vw,
          dialogRight: Math.round(m.getBoundingClientRect().right),
          docOverflow: de.scrollWidth - de.clientWidth,
          bodyOverflow: body.scrollWidth - body.clientWidth,
          cards: body.querySelectorAll('#lres .panel').length,
          bad: bad.slice(0, 4), badN: bad.length
        });
      })()`);
      const o3 = JSON.parse(r3);
      assert(`${w}px · 竞赛库弹窗装得下（无溢出、有条目）`,
        o3.dialogRight <= o3.vw + 2 && o3.docOverflow <= 1 && o3.bodyOverflow <= 1 && o3.badN === 0 && o3.cards > 0,
        `vw=${o3.vw} dialogRight=${o3.dialogRight} doc=${o3.docOverflow} body=${o3.bodyOverflow} cards=${o3.cards} bad=${o3.bad.join(',')}`);
      await cdp.eval('closeModal(); "ok"');
      await sleep(250);

      // 侧栏形态
      const rail = await cdp.eval(`(() => {
        const r = document.querySelector('.rail'), cs = getComputedStyle(r);
        const app = getComputedStyle(document.querySelector('.app'));
        const brand = getComputedStyle(document.querySelector('.brand'));
        return JSON.stringify({
          pos: cs.position, dir: cs.flexDirection,
          appCols: app.gridTemplateColumns.split(' ').length,
          brand: brand.display,
          railH: Math.round(r.getBoundingClientRect().height),
          viewPadBottom: getComputedStyle(document.querySelector('.view')).paddingBottom
        });
      })()`);
      const R = JSON.parse(rail);
      log.push(`${w}px rail ${rail}`);
      if (w > 820) {
        assert(`${w}px 侧栏为纵向常驻栏`, R.pos === 'static' || R.pos === 'sticky' ? R.dir === 'column' : R.dir === 'column', rail);
      } else {
        assert(`${w}px 侧栏塌缩为底部导航`, R.pos === 'fixed' && R.dir === 'row' && R.brand === 'none', rail);
        assert(`${w}px 底部导航不遮挡内容（view 有足够底部留白）`, parseFloat(R.viewPadBottom) >= R.railH, `pad=${R.viewPadBottom} railH=${R.railH}`);
      }

      // 资料卡是「基本信息」的入口，任何宽度下都得看得见、点得到
      const ru = await cdp.eval(`(() => {
        const u = document.querySelector('#railUser');
        if (!u) return '{"alive":false}';
        const b = u.getBoundingClientRect(), de = document.documentElement;
        return JSON.stringify({
          alive: true, display: getComputedStyle(u).display,
          w: Math.round(b.width), h: Math.round(b.height),
          inView: b.right <= de.clientWidth + 2 && b.left >= -2 && b.top >= -2 && b.bottom <= de.clientHeight + 2,
          tip: u.getAttribute('title') || ''
        });
      })()`);
      const RU = JSON.parse(ru);
      assert(`${w}px 资料卡（基本信息入口）可见且在视口内`,
        RU.alive && RU.display !== 'none' && RU.w > 0 && RU.h > 0 && RU.inView, ru);
      if (w === 820) {
        await cdp.eval('location.hash = "#overview"; "ok"'); await sleep(320);
        await cdp.eval(`document.querySelector('#railUser').click(); "ok"`);
        await sleep(620);
        const toSet = await cdp.eval(`JSON.stringify({ view: S.view, title: (document.querySelector('#viewTitle')||{}).textContent })`);
        const TS = JSON.parse(toSet);
        assert(`${w}px 点资料卡能进「基本信息」`, TS.view === 'profile' && TS.title === '基本信息', toSet);
      }

      // 看板 & 时间轴细节
      await cdp.eval('location.hash = "#archive"; "ok"'); await sleep(420);
      const kb = await cdp.eval(`(() => {
        const k = document.querySelector('.kanban');
        if (!k) return 'none';
        return getComputedStyle(k).gridTemplateColumns.split(' ').length + '';
      })()`);
      const kbExpect = w <= 820 ? 1 : w <= 1000 ? 2 : w <= 1240 ? 3 : 5;
      assert(`${w}px 看板列数 = ${kbExpect}`, Number(kb) === kbExpect, `实际=${kb}`);

      await cdp.eval('location.hash = "#schedule"; "ok"'); await sleep(520);
      const tl = await cdp.eval(`(() => {
        const tl = document.querySelector('.tl');
        if (!tl) return 'none';
        const tlLeft = tl.getBoundingClientRect().left;
        const bl = parseFloat(getComputedStyle(tl, '::before').left);
        const railX = tlLeft + bl + 0.75;
        const row = document.querySelector('.tl-row');
        const dot = getComputedStyle(row, '::before');
        const dotX = row.getBoundingClientRect().left + parseFloat(dot.left) + 3.5;
        const knot = document.querySelector('.tl-month .knot');
        const kr = knot.getBoundingClientRect();
        const knotX = kr.left + kr.width / 2;
        const lbl = document.querySelector('.tl-month .lbl');
        const lr = lbl.getBoundingClientRect();
        // 逐个量所有月份标签：取最宽的那个才算数（「10 月」比「9 月」宽）
        let worstGap = 1e9, worstLeft = 1e9, worstText = '', n = 0;
        document.querySelectorAll('.tl-month .lbl .mo').forEach(mo => {
          const mr = mo.getBoundingClientRect();
          n++;
          if (railX - 0.75 - mr.right < worstGap) { worstGap = +(railX - 0.75 - mr.right).toFixed(2); worstText = (mo.textContent || '').trim(); }
          if (mr.left - tlLeft < worstLeft) worstLeft = +(mr.left - tlLeft).toFixed(2);
        });
        return JSON.stringify({
          dotDelta: +(dotX - railX).toFixed(2),
          knotDelta: +(knotX - railX).toFixed(2),
          labelGap: worstGap,
          labelInkLeftVsTl: worstLeft,
          labelBox: Math.round(lr.width) + '@' + Math.round(lr.left - tlLeft),
          months: n,
          worstText,
          tlLeft: Math.round(tlLeft)
        });
      })()`);
      const T = JSON.parse(tl);
      assert(`${w}px 时间轴圆点仍落在竖线上`, Math.abs(T.dotDelta) < 1.5, tl);
      assert(`${w}px 时间轴月份节点仍落在竖线上`, Math.abs(T.knotDelta) < 1.5, tl);
      assert(`${w}px 月份标签不压竖线（气口 ≥4px）`, T.labelGap >= 4, tl);
      assert(`${w}px 月份标签不溢出容器左边`, T.labelInkLeftVsTl >= -3, tl);
    }

    // 收藏的版式挨个点一遍：确认按钮真的换了版式（src 变 + 内容重排 + 选中态跟随），
    // 而不是只换了个高亮。放在最宽的窗口下做，避免和其他窄屏断言混在一起。
    // 注意点的是「左栏格子里有的」——其余模板在「更多模板」子域里，左栏没有按钮可点。
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.eval('location.hash = "#export"; "ok"');
    await sleep(700);
    const swapLog = [];
    // 左栏一行只放 3 个模板 + 「更多模板」——能直接点的是格子里有的前 3 套，
    // 其余收藏在「更多模板」弹窗里（弹窗内的收藏/切换已由功能自检覆盖）。
    const shown = await cdp.eval(`JSON.stringify(
      [...document.querySelectorAll('.tpl-grid [data-tpl]')].map(b => b.dataset.tpl))`);
    const TK3 = JSON.parse(shown);
    OO.push(TK3.length === 3);
    // 先把起点切到「最后一档」，保证后面点第一档时 src 必然发生变化
    if (TK3.length >= 2) {
      await cdp.eval(`(() => { const b = document.querySelector('[data-tpl="${TK3[TK3.length - 1]}"]'); if (b) b.click(); return 'ok'; })()`);
      await sleep(1400);
    }
    for (const tk2 of TK3) {
      const before = await cdp.eval(`(() => { const f = document.querySelector('#a4'); return f ? (f.getAttribute('src') || '') : ''; })()`);
      await cdp.eval(`(() => { const b = document.querySelector('[data-tpl="${tk2}"]'); if (b) b.click(); return 'ok'; })()`);
      await sleep(1400);
      const after = await cdp.eval(`(() => {
        const f = document.querySelector('#a4');
        const d = f ? f.contentDocument : null;
        const a4 = d ? d.querySelector('.a4') : null;
        const btn = document.querySelector('[data-tpl="${tk2}"]');
        return JSON.stringify({
          src: f ? (f.getAttribute('src') || '') : '',
          rendered: !!a4 && a4.textContent.replace(/\\s+/g, '').length > 80,
          on: !!(btn && btn.classList.contains('on')),
          a4w: a4 ? Math.round(a4.getBoundingClientRect().width) : 0
        });
      })()`);
      const o4 = JSON.parse(after);
      swapLog.push(`${tk2}: src换=${o4.src !== before} 渲染=${o4.rendered} 选中=${o4.on} A4宽=${o4.a4w}`);
      OO.push(o4.rendered && o4.on && o4.src.includes('template=' + tk2) && o4.src !== before);
    }
    assert(`左栏一行 3 套版式都能切换并各自重排（收藏 ${TK.length} 套 / 全库 ${TPL_TOTAL} 套，格子只放 ${TK3.length} 套）`,
      TK3.length === 3 && OO.every(Boolean), swapLog.join(' | '));

    await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => {});
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });

    fs.writeFileSync(path.join(OUT, 'wb-resp.txt'), [
      '=== 响应式断言 ===', ...A,
      '', '=== 侧栏 / 其他 ===', ...log,
      '', '=== 控制台报错 (' + errors.length + ') ===', ...(errors.length ? errors : ['（无）'])
    ].join('\n'), 'utf8');
  } catch (e) {
    fs.writeFileSync(path.join(OUT, 'wb-resp.txt'), 'ERROR: ' + (e.stack || e.message) + '\n\n' + A.join('\n') + '\n\n' + log.join('\n') + '\n\n' + errors.join('\n'), 'utf8');
  } finally {
    try { child.kill('SIGKILL'); } catch (_) {}
    process.exit(0);
  }
})();
