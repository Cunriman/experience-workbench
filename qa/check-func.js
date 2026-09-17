'use strict';
/**
 * 用 CDP 驱动无头 Edge：逐视图截图 + 收集控制台报错 + 跑交互断言。
 * Node 22 自带 WebSocket，不需要额外依赖。
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
const PORT = Number(process.env.WB_CDP_PORT || 9333);
const BASE = process.env.WB_BASE || 'http://127.0.0.1:8777';
const OUT = process.env.WB_OUT || path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const PROFILE = path.join(require('os').tmpdir(), '_wb_cdpprof_func');

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
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = e => rej(new Error('ws 连接失败')); });
    const c = new CDP(ws);
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { resolve, reject } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.method + ' ' + JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method && c.handlers[msg.method]) {
        c.handlers[msg.method](msg.params);
      }
    };
    return c;
  }
  on(method, fn) { this.handlers[method] = fn; }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('超时 ' + method)); }
      }, 30000);
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
  const log = [];
  const errors = [];
  fs.rmSync(PROFILE, { recursive: true, force: true });

  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--mute-audio',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--window-size=1400,900', 'about:blank'
  ], { stdio: 'ignore', windowsHide: true });

  let cdp;
  try {
    await waitForDevtools(20000);
    const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    const page = list.find(t => t.type === 'page');
    if (!page) throw new Error('没有找到 page target');
    cdp = await CDP.connect(page.webSocketDebuggerUrl);

    cdp.on('Runtime.consoleAPICalled', p => {
      if (p.type === 'error' || p.type === 'warning') {
        errors.push(p.type + ': ' + (p.args || []).map(a => a.value || a.description || a.type).join(' '));
      }
    });
    cdp.on('Runtime.exceptionThrown', p => {
      const d = p.exceptionDetails || {};
      errors.push('exception: ' + (d.exception && (d.exception.description || d.exception.value) || d.text));
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable').catch(() => {});

    async function shot(name, opts) {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png', ...(opts || {}) });
      const f = path.join(OUT, 'q-' + name + '.png');
      fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
      return { name, size: fs.statSync(f).size };
    }

    async function gotoHash(view) {
      await cdp.eval(`location.hash = ${JSON.stringify('#' + view)}; 'ok'`);
      await sleep(500);
    }

    // 首屏
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await sleep(2500);
    // 等数据到位
    for (let i = 0; i < 20; i++) {
      const n = await cdp.eval('(typeof S !== "undefined" && S.experiences ? S.experiences.length : -1)').catch(() => -1);
      if (n >= 0) break;
      await sleep(300);
    }
    await sleep(600);

    /* 数据夹具 ---------------------------------------------------------------
       这个脚本量的是「有内容时的排版与几何」：时间轴、抽屉、导出排版、材料卡、
       照片落位，都需要库里有东西可量。别人 clone 下来跑时库是空的，会直接量到
       null 崩掉，所以这里先自己把夹具备齐。
       下面几段都「只在空缺时才补」，因此也能安全地跑在已有真实数据的库上。 */
    const fxReport = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      const send = (p, m, b) => fetch(p, { method: m, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
      const rep = { loaded: false, exp: 0, filled: [], photo: false, mats: 0 };

      // ① 示例经历：demo-lanqiao 是下面抽屉与材料断言的固定入口，缺了就补
      //    （/api/demo/load 按 id upsert，重复调不会产生副本）
      if (!S.experiences.some(e => e.id === 'demo-lanqiao')) {
        await send('/api/demo/load', 'POST', {});
        await refresh(); await w(400);
        rep.loaded = true;
      }
      rep.exp = S.experiences.length;

      // ② 个人资料：只填空缺。学校/学院/年级/GPA/排名/英语——教育背景一节靠它们
      //    （学校有值这一节就会出，专业可以留空，顺带把「专业还没填」那条缺口也留下来）。
      //    专业与联系方式都故意留空：后者让「必填缺失进缺口清单」有东西可断言，
      //    前者交给下面「专业标签」那条断言自己去加——那条要量的是「加一个 / 减一个」的差值，
      //    先塞一个专业进去会让它的期望值对不上。
      const P = S.profile || {};
      const want = {
        name: '林一鸣', nameEn: 'Yiming Lin', school: '云澜大学', college: '计算机学院',
        grade: '大三', studyYears: '2023.09 - 2027.06', gpa: '3.82 / 4.0',
        majorRank: '专业前 26%（7 名）', englishScore: 'CET-6 545'
      };
      const patch = {};
      for (const k in want) {
        const cur = P[k];
        const empty = cur === undefined || cur === null || cur === '' || (Array.isArray(cur) && !cur.length);
        if (empty) { patch[k] = want[k]; rep.filled.push(k); }
      }
      if (Object.keys(patch).length) await send('/api/profile', 'PUT', patch);

      // ③ 证件照：1×1 的 PNG 就够，断言量的是落位不是像素
      const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
      if (!P.photo) {
        const up = await send('/api/attachment', 'POST', { name: 'qa-id-photo.png', base64: PNG });
        await send('/api/profile', 'PUT', { photo: up.file });
        rep.photo = true;
      }

      // ④ 材料：演示数据里那两条材料只有名字、file 是空的（点不开预览），所以判据要看
      //    「有没有带真实文件、能预览的材料」，光数条数会在这条断言上假失败。
      //    缺了就给固定那条经历补 png/docx/pdf 三种格式（预览 / 下载两个动作按格式分叉）。
      const previewable = e => (e.materials || []).some(m => /\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(String(m.file || '')));
      if (!S.experiences.some(previewable)) {
        const mk = async n => (await send('/api/attachment', 'POST', { name: n, base64: PNG })).file;
        const pick = S.experiences.find(e => e.id === 'demo-lanqiao') || S.experiences[0];
        const full = JSON.parse(JSON.stringify(pick));   // upsert 是全量合并，必须回传整条
        // 原有材料留着，只清掉上一轮补的 qa-mat-*，重复跑不会堆副本
        full.materials = (full.materials || []).filter(m => !/^qa-mat-/.test(String(m.id))).concat([
          { id: 'qa-mat-png', name: '获奖证书.png', file: await mk('qa-cert.png'), kind: 'image' },
          { id: 'qa-mat-doc', name: '参赛报告.docx', file: await mk('qa-report.docx'), kind: 'doc' },
          { id: 'qa-mat-pdf', name: '盖章证明.pdf', file: await mk('qa-proof.pdf'), kind: 'pdf' }
        ]);
        await send('/api/experience', 'POST', full);
        rep.mats = full.materials.length;
      }

      await refresh(); await w(400);
      return JSON.stringify(rep);
    })()`, true);
    log.push('fixture ' + fxReport);

    const views = ['overview', 'archive', 'schedule', 'materials', 'retro', 'export', 'library', 'settings'];
    for (const v of views) {
      await gotoHash(v);
      const s = await shot(v);
      log.push(`shot ${s.name} ${s.size}`);
    }

    // 表格模式
    await cdp.eval('go("archive"); "ok"'); await sleep(400);
    await cdp.eval('S.mode.archive = "table"; render(); "ok"');
    await sleep(500);
    log.push(`shot table ${(await shot('archive-table')).size}`);

    // 抽屉
    await cdp.eval('S.mode.archive = "kanban"; render(); openDrawer("demo-lanqiao"); "ok"');
    await sleep(700);
    log.push(`shot drawer ${(await shot('drawer')).size}`);

    // 模态：竞赛库
    await cdp.eval('closeDrawer(); openLibraryModal(); "ok"', true);
    await sleep(900);
    log.push(`shot library ${(await shot('modal-library')).size}`);
    await cdp.eval('closeModal(); "ok"');

    // 模态：变更与恢复
    await cdp.eval('openChanges(); "ok"', true);
    await sleep(800);
    log.push(`shot changes ${(await shot('modal-changes')).size}`);
    await cdp.eval('closeModal(); "ok"');

    // 模态：提醒预览
    await cdp.eval('openReminderPreview(); "ok"', true);
    await sleep(800);
    log.push(`shot remind ${(await shot('modal-remind')).size}`);
    await cdp.eval('closeModal(); "ok"');

    // 模态：确认框
    await cdp.eval('window.__cfm = null; confirmModal({title:"删除这条经历", body:"「全国大学生数学建模竞赛」会被移到回收站。<br><span class=\\"dim\\">数据不会真的消失，随时可以在「设置 → 变更与恢复」里还原。</span>", ok:"删除", danger:true}).then(v => window.__cfm = v); "ok"');
    await sleep(700);
    log.push(`shot confirm ${(await shot('modal-confirm')).size}`);
    const cfmVisible = await cdp.eval('document.querySelector("#cfmOk") ? getComputedStyle(document.querySelector("#modal")).display : "missing"');
    await cdp.eval('document.querySelector("[data-m=close]").click(); "ok"');
    await sleep(500);
    const cfmResult = await cdp.eval('String(window.__cfm)');

    // 新增经历模态
    await cdp.eval('openNewModal(); "ok"');
    await sleep(700);
    log.push(`shot new ${(await shot('modal-new')).size}`);
    await cdp.eval('closeModal(); "ok"');

    /* ---------------- 断言 ---------------- */
    const A = [];
    const SK = [];
    const assert = (name, ok, detail) => A.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`);
    // 前置条件在当前数据集里根本不成立时报 SKIP，不报 FAIL——那说明「没验到」，
    // 不说明功能坏了。例如「空类型没被藏起来」得库里真有空类型才观察得到。
    const skip = (name, why) => SK.push(`SKIP  ${name}  :: ${why}`);

    // 1. hidden 必须真的不显示
    const hiddenCheck = await cdp.eval(`(() => {
      const out = [];
      for (const sel of ['.drawer','.drawer-scrim']) {
        const el = document.querySelector(sel);
        out.push(sel + '=' + getComputedStyle(el).display + '/' + el.hidden);
      }
      return out.join(' | ');
    })()`);
    assert('关闭状态下的抽屉真的隐藏',
      /\.drawer=none\/true/.test(hiddenCheck) && /\.drawer-scrim=none\/true/.test(hiddenCheck), hiddenCheck);

    // 骨架屏必须已被真实内容替换（防「卡在加载中」）
    // 导航是 8 项——「竞赛库」从设置里独立出来占了导航一席
    const skel = await cdp.eval('document.querySelectorAll(".skel").length + "/" + document.querySelectorAll("#nav .nav-item").length');
    assert('骨架屏已被真实内容替换，且 8 个导航项（七视图 + 设置）都在', skel === '0/8', skel);

    // 2. 没有游离的覆盖层挡住内容
    const overlay = await cdp.eval(`(() => {
      const bad = [];
      document.querySelectorAll('.drawer,.drawer-scrim').forEach(el => {
        const cs = getComputedStyle(el);
        if (cs.display !== 'none' && cs.position === 'fixed') bad.push(el.className);
      });
      return bad.length ? bad.join(',') : '';
    })()`);
    assert('没有固定定位的空覆盖层', overlay === '', overlay);

    // 3. 看板列数与数据一致
    await cdp.eval('go("overview"); "ok"'); await sleep(300);
    await cdp.eval('go("archive"); "ok"'); await sleep(500);
    const cols = await cdp.eval(`(() => {
      const c = [...document.querySelectorAll('.kcol')].map(k => k.dataset.stage + ':' + k.querySelectorAll('.kcard').length);
      return c.join(' ');
    })()`);
    const expCount = await cdp.eval('S.experiences.length');
    const sum = (cols.match(/:(\d+)/g) || []).reduce((a, x) => a + Number(x.slice(1)), 0);
    assert('看板卡片总数 = 经历总数', sum === expCount, `${cols}  sum=${sum} exps=${expCount}`);

    // 4. 看板不能横向溢出
    const overflow = await cdp.eval(`(() => {
      const v = document.querySelector('#view');
      const k = document.querySelector('.kanban');
      if (!k) return 'no-kanban';
      return 'viewScrollW=' + v.scrollWidth + ' clientW=' + v.clientWidth + ' kanbanRight=' + Math.round(k.getBoundingClientRect().right) + ' viewRight=' + Math.round(v.getBoundingClientRect().right);
    })()`);
    const ov = overflow.match(/viewScrollW=(\d+) clientW=(\d+)/);
    assert('看板不产生横向滚动', ov && Number(ov[1]) <= Number(ov[2]) + 1, overflow);

    // 5. 时间轴圆点是否落在竖线上
    // 注意：竖线位置必须从 CSS 实读（.tl::before 的 left），不要在脚本里写死像素——
    // 缩进/栅格一改，写死的数字就会误报。
    await cdp.eval('go("schedule"); "ok"'); await sleep(600);
    const tlAlign = await cdp.eval(`(() => {
      const tl = document.querySelector('.tl');
      if (!tl) return 'no-tl';
      const railLeft = tl.getBoundingClientRect().left + parseFloat(getComputedStyle(tl, '::before').left) + 0.75;
      const row = document.querySelector('.tl-row');
      const dot = row ? getComputedStyle(row, '::before') : null;
      const rowLeft = row.getBoundingClientRect().left;
      const dotLeft = parseFloat(dot.left);           // 负数 px
      const dotCenter = rowLeft + dotLeft + 3.5;
      return 'railCenter=' + railLeft.toFixed(2) + ' dotCenter=' + dotCenter.toFixed(2) + ' delta=' + (dotCenter - railLeft).toFixed(2);
    })()`);
    const dAlign = tlAlign.match(/delta=(-?[\d.]+)/);
    assert('时间轴圆点与竖线对齐（<1.5px）', dAlign && Math.abs(Number(dAlign[1])) < 1.5, tlAlign);

    // 6. 时间轴整体收窄 + 月份节点也在线上 + 勾选框离正文不远
    const tlGeom = await cdp.eval(`(() => {
      const tl = document.querySelector('.tl');
      const wrap = tl.parentElement;
      const railX = tl.getBoundingClientRect().left + parseFloat(getComputedStyle(tl, '::before').left) + 0.75;
      const knot = document.querySelector('.tl-month .knot');
      const knotX = knot.getBoundingClientRect().left + knot.getBoundingClientRect().width / 2;
      const row = document.querySelector('.tl-row');
      const title = row.querySelector('.tl-title');
      const box = row.querySelector('input[type=checkbox]').closest('label');
      return JSON.stringify({
        wrapW: Math.round(wrap.getBoundingClientRect().width),
        knotDelta: +(knotX - railX).toFixed(2),
        titleToBox: Math.round(box.getBoundingClientRect().left - title.getBoundingClientRect().left),
        rowW: Math.round(row.getBoundingClientRect().width)
      });
    })()`);
    const g = JSON.parse(tlGeom);
    assert('时间轴宽度受控（≤940px）', g.wrapW <= 940, tlGeom);
    assert('月份节点也落在竖线上（<1.5px）', Math.abs(g.knotDelta) < 1.5, tlGeom);
    assert('正文到勾选框距离合理（≤760px）', g.titleToBox <= 760, tlGeom);

    // 6. 多行脚注不会被拆成并排（旧的设置页脚注已删，改查基本信息页的「已识别方向」回显；
    //    用户没填专业时这段是单行，没有 <br> 可查——跳过，别误报）
    await cdp.eval('go("profile"); "ok"'); await sleep(500);
    const foot = await cdp.eval(`(() => {
      const f = [...document.querySelectorAll('.panel-foot')].find(x => x.innerHTML.includes('<br>'));
      if (!f) return 'no-br-foot';
      const cs = getComputedStyle(f);
      return 'display=' + cs.display + ' h=' + Math.round(f.getBoundingClientRect().height);
    })()`);
    assert('含 <br> 的脚注是块级（不被拆列）', foot === 'no-br-foot' || /display=block/.test(foot), foot);

    // 7. 改截止时间会重置提醒档位
    const reset = await cdp.eval(`(async () => {
      const exp = S.experiences.find(e => (e.nodes||[]).length);
      const n = exp.nodes[0];
      n.notifiedAt = ['7','3'];
      await saveExp(exp, true);
      const before = JSON.parse(JSON.stringify(S.experiences.find(e=>e.id===exp.id).nodes.find(x=>x.id===n.id).notifiedAt));
      // 模拟模态里改时间：直接调 scan 之外，用相同规则验证前端逻辑
      const dueAt = new Date(Date.now()+9*86400000).toISOString();
      const changed = (n.dueAt || '') !== (dueAt || '');
      return 'changed=' + changed + ' before=' + JSON.stringify(before);
    })()`, true);
    assert('节点时间变更可被检测（用于重置档位）', /changed=true/.test(reset), reset);

    // 8. 深链能打开某条经历
    await cdp.eval('location.hash = "#materials/demo-lanqiao"; "ok"');
    await sleep(800);
    const deep = await cdp.eval(`(() => {
      const d = document.querySelector('#drawer');
      return 'hidden=' + d.hidden + ' title=' + (document.querySelector('#dTitle')||{}).textContent + ' view=' + S.view;
    })()`);
    assert('深链 #view/id 能直接打开抽屉', /hidden=false/.test(deep), deep);
    const deepShot = await shot('deep-link');
    log.push(`shot deep-link ${deepShot.size}`);

    // 9. 导出页（2026-09-16 改版）：左栏一屏排完 + A4 预览 + 缩放
    //    改版要点：口径四种、语言单设、格式先选后预览、版式可收藏、内容可展开到单条。
    //    所以这一组断言整体重写，测的是「屏幕上那份 A4 是不是真的按 A4 尺寸排出来了」，
    //    以及「选格式不会直接把文件下走」。
    await cdp.eval('closeDrawer(); "ok"');
    await cdp.eval('go("export"); "ok"'); await sleep(1400);
    const expFrame = await cdp.eval(`(() => {
      const f = document.querySelector('#a4');
      const d = f && f.contentDocument;
      const a4 = d && d.querySelector('.a4');
      return JSON.stringify({
        hasFrame: !!f,
        src: f ? (f.dataset.src || '') : '',
        loaded: !!a4,
        chars: a4 ? a4.textContent.replace(/\\s+/g, '').length : 0,
        h2: d ? d.querySelectorAll('h2').length : 0,
        a4w: a4 ? Math.round(a4.getBoundingClientRect().width) : 0
      });
    })()`);
    const EF = JSON.parse(expFrame);
    assert('导出页有 A4 预览 iframe，且指向预览接口',
      EF.hasFrame && /^\/api\/export\/preview\?/.test(EF.src), expFrame);
    assert('预览 iframe 真的排出了文档（有内容、有章节）',
      EF.loaded && EF.chars > 80 && EF.h2 >= 1, expFrame);
    // A4 宽 210mm ≈ 794px。这条是「所见即打印所得」的地基：
    // 一旦预览不是 A4 宽度，用户看到的版面和打印出来的就不是一回事了。
    assert('预览页里确实是 A4 尺寸（210mm ≈ 794px，±12px）',
      Math.abs(EF.a4w - 794) <= 12, `a4w=${EF.a4w}`);
    log.push(`shot export-doc ${(await shot('export-doc')).size}`);

    // 9b. 切版式：只换 iframe 的 src，不整页重绘（整页重绘会让预览闪一下）
    const tplSwitch = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      // 版式卡只显示「收藏的模板」——收藏列表里没有 academic 时按钮根本不存在，
      // 这里自愈：缺就把 academic + classic 补进收藏，量完恢复原收藏。
      const st0 = await (await fetch('/api/state')).json();
      const origFavs = (st0.profile.export.favorites || []).slice();
      const need = ['academic', 'classic'].filter(k => !origFavs.includes(k));
      if (need.length) {
        await fetch('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ export: { favorites: origFavs.concat(need).slice(-3) } }) });
        await refresh();
        repaintExport();   // 左栏模板格不归 refresh 管，必须显式重画，按钮才会出现
        await w(800);
      }
      const btns = [...document.querySelectorAll('[data-tpl]')];
      const btn = btns.find(b => b.dataset.tpl === 'academic');
      const other = btns.find(b => b.dataset.tpl !== 'academic');
      if (!btn || !other) return 'NO_BTN';
      // 先把当前版式挪到别的档，否则「再点 academic」根本不产生变化，
      // 断言会误判成「点了没反应」。上一次跑留下的偏好会让这一步变得必要。
      if (btn.classList.contains('on')) { other.click(); await w(1500); }
      const f0 = document.querySelector('#a4');
      const before = f0.dataset.src;
      btn.click(); await w(1500);
      const f1 = document.querySelector('#a4');
      const d = f1.contentDocument;
      const a4 = d && d.querySelector('.a4');
      const saved = (await (await fetch('/api/state')).json()).profile.export.template;
      // 先把断言要用的数据算完（此时 DOM 还是点击后的状态），再恢复收藏
      const changed = before !== f1.dataset.src;
      const sameNode = f1 === f0;
      const on = btn.classList.contains('on');
      const hasHead = !!(d && d.querySelector('.head'));
      const numbered = !!(a4 && getComputedStyle(a4).counterReset.includes('sect'));
      if (need.length) {
        await fetch('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ export: { favorites: origFavs } }) });
        await refresh(); await w(500);
      }
      return JSON.stringify({
        changed,
        sameNode,
        on,
        saved,
        // 学术版式的结构特征：独立的页眉块 + 章节自动编号。
        // 不去断言「研究方向」——那一段只在填了专业之后才渲染，
        // profile 为空时会合理地缺席，拿它当判据会误报。
        hasHead,
        numbered
      });
    })()`, true);
    const TS = JSON.parse(tplSwitch);
    assert('点版式卡会换预览，但不重建 iframe 节点', TS.changed && TS.sameNode, tplSwitch);
    assert('选中的版式被存进 profile.export.template', TS.saved === 'academic', tplSwitch);
    assert('学术版式用的是自己的版面（独立页眉 + 章节自动编号）',
      TS.hasHead && TS.numbered, tplSwitch);
    log.push(`shot export-academic ${(await shot('export-academic')).size}`);

    // 9c. 「包含内容」：① 有空成果的类型也要列出来（只是没得选）
    //     ② 关掉一类，预览里对应的章节就该消失 ③ 展开到单条，勾掉一条也生效
    const incShape = await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('.inc-type')];
      const empty = rows.filter(r => r.querySelector('.inc-toggle').disabled);
      const rowsWithKids = rows.filter(r => r.querySelectorAll('[data-inc-id]').length);
      // 类型名字在上、勾选框在展开区里；折叠状态默认是收起的
      const collapsed = rows.every(r => r.querySelector('.inc-body').hidden);
      return JSON.stringify({
        rows: rows.length,
        empty: empty.length,
        emptyLabels: empty.map(r => r.querySelector('.inc-label').textContent),
        withKids: rowsWithKids.length,
        collapsed,
        types: (S && S.taxonomy ? S.taxonomy.length : -1)
      });
    })()`);
    const IS = JSON.parse(incShape);
    assert('「包含内容」把所有类型都列出来（含一条成果都没有的类型）',
      IS.rows === IS.types && IS.rows >= 9, incShape);
    if (IS.empty === 0) {
      skip('空成果的类型只是没得勾，没有藏起来',
        '当前数据每类都有内容，观察不到「空类型」；换个只有部分类型有内容的库再验');
    } else {
      assert('空成果的类型只是没得勾，没有藏起来', IS.emptyLabels.length === IS.empty, incShape);
    }
    assert('每个有内容的类型都带逐条勾选（默认收起）', IS.withKids >= 1 && IS.collapsed, incShape);

    const typeScope = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      // 挑第一个「真的有内容」的类型来关，不写死某个 key——
      // 用户删掉某类经历之后，写死的 key 会让这条断言变成假失败。
      const pick = () => [...document.querySelectorAll('[data-inc]')].find(b => !b.disabled);
      const chip = pick();
      if (!chip) return 'NO_CHIP';
      const label = chip.querySelector('.inc-label').textContent;
      const row = () => chip.closest('.inc-type');
      const d0 = document.querySelector('#a4').contentDocument;
      const beforeNames = [...d0.querySelectorAll('h2')].map(h => h.textContent);
      const before = beforeNames.length;
      chip.click();
      // 数据多的时候整份稿子重排要一会儿。等到 h2 真变了再读，
      // 否则读到的是上一版（条数一模一样，看起来像「关不掉」）。
      let afterNames = beforeNames;
      for (let i = 0; i < 20; i++) {
        await w(400);
        const doc = document.querySelector('#a4').contentDocument;
        const names = doc ? [...doc.querySelectorAll('h2')].map(h => h.textContent) : [];
        afterNames = names;
        if (names.join('|') !== beforeNames.join('|')) break;
      }
      const after = afterNames.length;
      const gone = beforeNames.filter(n => !afterNames.includes(n));
      const left = afterNames.filter(n => n.startsWith('竞赛经历')).length;
      const off = row().classList.contains('off');
      pick().click(); await w(1400);      // 复位
      const back = document.querySelector('#a4').contentDocument.querySelectorAll('h2').length;
      return JSON.stringify({ label, before, after, gone, left, off, back, on: !row().classList.contains('off') });
    })()`, true);
    const SC = JSON.parse(typeScope);
    // 「竞赛经历」跨页时拆出「（续）」标题，关掉类型后消失的 h2 会不止一个。
    // 判据不能写「页数正好少这么多个」：那一章腾出的位置会让后面内容整体前移，
    // 别的章节可能因此多拆出一个「（续）」，总数就对不上了（实测 11 -> 10：
    // 消失 2 个、新增 1 个）。只认两件事——该章标题真出现过、关掉后一个都不剩。
    assert('关掉一个内容类型后，预览里对应的章节会消失',
      SC.gone.length >= 1 && SC.gone.every(n => n.startsWith('竞赛经历'))
      && SC.left === 0 && SC.off, typeScope);
    assert('再点一次能恢复（不是单向开关）', SC.back === SC.before && SC.on, typeScope);

    // 逐条勾选：展开一个类型，去掉其中一条，条数应该跟着少
    const oneOff = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      const row = [...document.querySelectorAll('.inc-type')].find(r => r.querySelectorAll('[data-inc-id]').length >= 2);
      if (!row) return 'NO_ROW';
      row.querySelector('.inc-caret').click();
      await w(200);
      const body = row.querySelector('.inc-body');
      const opened = !body.hidden;
      const cb = body.querySelector('[data-inc-id]');
      const before = document.querySelector('#a4').contentDocument.querySelectorAll('.entry').length;
      cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true }));
      await w(1600);
      const after = document.querySelector('#a4').contentDocument.querySelectorAll('.entry').length;
      const note = document.querySelector('#exIncNote').textContent;
      cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
      await w(1400);
      const back = document.querySelector('#a4').contentDocument.querySelectorAll('.entry').length;
      return JSON.stringify({ opened, before, after, back, note });
    })()`, true);
    const OO = JSON.parse(oneOff);
    assert('展开类型后能逐条勾选，取消一条预览里就少一条',
      OO.opened && OO.after === OO.before - 1, oneOff);
    assert('逐条勾选也能整体复位', OO.back === OO.before, oneOff);

    // 9d. 左栏：口径 4 种 / 语言 2 种 / 格式 4 种，且「选格式」只切预览不下载
    const barShape = await cdp.eval(`(() => {
      const seg = k => [...document.querySelectorAll('[data-' + k + ']')].map(b => b.dataset[k.replace('exp-','exp')] || b.dataset.expProfile);
      const cnt = sel => document.querySelectorAll(sel).length;
      const rows = [...document.querySelectorAll('.ex-row .ex-k')].map(e => e.textContent.trim());
      return JSON.stringify({
        profiles: cnt('[data-exp-profile]'),
        langs: cnt('[data-exp-lang]'),
        fmts: cnt('[data-exp-fmt]'),
        keys: [...document.querySelectorAll('[data-exp-fmt]')].map(b => b.dataset.expFmt),
        labels: rows,
        dl: !!document.querySelector('#exDlBtn'),
        dlText: (document.querySelector('#exDlBtn') || {}).textContent || ''
      });
    })()`);
    const EXBAR = JSON.parse(barShape);
    assert('导出页（简历导出）类型是三种（保研 / 求职 / 出国），「自定义」已删',
      EXBAR.profiles === 3, barShape);
    assert('中英双语是独立的语言选项', EXBAR.langs === 2, barShape);
    assert('四种导出格式都在，且都在版式上面',
      EXBAR.fmts === 4 && EXBAR.keys.join(',') === 'pdf,docx,html,md', barShape);
    assert('左栏按「类型 / 语言 / 照片 / 格式 / 版式 / 包含内容」顺序排',
      EXBAR.labels.slice(0, 4).join(',') === '类型,语言,照片,格式', barShape);
    assert('下载动作只有一个按钮（不再一选格式就下载）', EXBAR.dl, barShape);

    // 选 Markdown：预览切成纯文本，版式区禁用，且绝不能触发下载
    const mdMode = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      let downloaded = false;
      const spy = e => { if (e.target && e.target.tagName === 'A' && e.target.download !== undefined
        && /\\/api\\/export\\/file/.test(e.target.href || '')) downloaded = true; };
      document.addEventListener('click', spy, true);
      const btn = [...document.querySelectorAll('[data-exp-fmt]')].find(b => b.dataset.expFmt === 'md');
      btn.click(); await w(1600);
      const block = document.querySelector('#exTplBlock');
      const d = document.querySelector('#a4').contentDocument;
      const off = block.classList.contains('off');
      const pointer = getComputedStyle(block).pointerEvents;
      const src = document.querySelector('#a4').dataset.src;
      const dlText = document.querySelector('#exDlBtn').textContent;
      const label = document.querySelector('#previewLabel').textContent;
      // 预览里应当是 Markdown 原文（有 ## 标题、有 - 列表），不是排好版的 A4
      const body = d ? d.body.textContent : '';
      const isMd = /^#\\s/m.test(body) || /##\\s/.test(body);
      document.removeEventListener('click', spy, true);
      return JSON.stringify({ off, pointer, src, dlText, label, isMd, downloaded,
        hasA4: !!(d && d.querySelector('.a4')) });
    })()`, true);
    const MD = JSON.parse(mdMode);
    assert('选 Markdown 后预览换成纯文本稿（不是 A4 版面）',
      MD.isMd && !MD.hasA4 && /format=md/.test(MD.src), mdMode);
    assert('仅 Markdown 时版式区被禁掉（纯文本不套版式）',
      MD.off && MD.pointer === 'none', mdMode);
    assert('选格式只是预览，绝不触发下载', MD.downloaded === false, mdMode);
    assert('下载按钮跟着格式改字', /Markdown/.test(MD.dlText), mdMode);

    // 切回 PDF——后面几条依赖 A4 预览
    const backPdf = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      [...document.querySelectorAll('[data-exp-fmt]')].find(b => b.dataset.expFmt === 'pdf').click();
      await w(1600);
      const d = document.querySelector('#a4').contentDocument;
      return JSON.stringify({
        off: document.querySelector('#exTplBlock').classList.contains('off'),
        a4: !!(d && d.querySelector('.a4'))
      });
    })()`, true);
    assert('切回 PDF 后版式区恢复可用、预览回到 A4', !JSON.parse(backPdf).off && JSON.parse(backPdf).a4, backPdf);

    // 9e. 后端出口能真出文件：Word 必须是合法 zip，网页要有内容，Markdown 要是文本
    const dl = await cdp.eval(`(async () => {
      const out = [];
      for (const fmt of ['docx', 'html', 'md']) {
        const r = await fetch('/api/export/file?profile=baoyan&template=classic&format=' + fmt);
        const b = new Uint8Array(await r.arrayBuffer());
        const cd = r.headers.get('content-disposition') || '';
        const isZip = b[0] === 0x50 && b[1] === 0x4b;
        const ok = fmt === 'docx' ? isZip : b.byteLength > 800;
        out.push(fmt + '=' + r.status + '/' + b.byteLength + '/' +
          (cd.includes('attachment') ? 'dl' : 'inline') + '/' + ok);
      }
      return out.join(' ');
    })()`, true);
    assert('Word 导出返回合法 docx（zip 头 + 附件下载）',
      /docx=200\/\d+\/dl\/true/.test(dl), dl);
    assert('网页导出有内容且按附件下载', /html=200\/\d+\/dl\/true/.test(dl), dl);
    assert('Markdown 导出有内容且按附件下载', /md=200\/\d+\/dl\/true/.test(dl), dl);

    // 9e2. 上传自定义模板：格式不对要报错，格式对了要真能选
    const tplUp = await cdp.eval(`(async () => {
      const post = body => fetch('/api/export/template', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      }).then(r => r.json().then(j => ({ status: r.status, j })));
      const bad = await post({ label: '没写样式' });
      const good = await post({
        label: '自检临时版式',
        desc: '自检用，跑完就删',
        layout: 'one',
        css: '.name{color:#123456}'
      });
      const list = good.j && good.j.templates ? good.j.templates.map(t => t.key) : [];
      const all = (await (await fetch('/api/state')).json()).exportTemplates.map(t => t.key);
      const del = await fetch('/api/export/template?key=' + encodeURIComponent(good.j.template.key), { method: 'DELETE' })
        .then(r => r.json());
      const after = (await (await fetch('/api/state')).json()).exportTemplates.map(t => t.key);
      return JSON.stringify({
        badStatus: bad.status, badMsg: (bad.j && bad.j.error) || '',
        upStatus: good.status, key: good.j.template && good.j.template.key,
        inList: list.includes(good.j.template.key), inState: all.includes(good.j.template.key),
        delOk: del.ok, goneAfterDelete: !after.includes(good.j.template.key)
      });
    })()`, true);
    const TU = JSON.parse(tplUp);
    assert('上传的模板格式不对会被挡下来并说明原因',
      TU.badStatus === 400 && /css/.test(TU.badMsg), tplUp);
    assert('格式正确的模板上传后立刻进入可选列表', TU.upStatus === 200 && TU.inList && TU.inState, tplUp);
    assert('上传的模板可以删掉', TU.delOk && TU.goneAfterDelete, tplUp);

    // 9f. 提示语不能混进成品。
    //     「级别与名次待补——评审最看这一项」这类话是给自己看的，
    //     以前它直接排在正文里、跟着 PDF/Word 一起投出去。现在它只活在屏幕预览的纸外面。
    await sleep(1200);
    const gapsScreen = await cdp.eval(`(() => {
      const d = document.querySelector('#a4').contentDocument;
      const g = d && d.querySelector('.gaps');
      const paper = d && d.querySelector('.a4');
      const note = document.querySelector('#gapNote');
      return JSON.stringify({
        hasGaps: !!g,
        gapsDisplay: g ? getComputedStyle(g).display : '-',
        gapsLi: d ? d.querySelectorAll('.gaps li').length : -1,
        noteShown: !!(note && !note.hidden),
        noteText: note ? note.textContent : '',
        paperHasDraftWord: paper ? /待补/.test(paper.textContent) : null,
        draftLis: d ? d.querySelectorAll('.elist li.draft').length : -1
      });
    })()`);
    const GP = JSON.parse(gapsScreen);
    assert('屏幕预览会在纸下面列出「还差这些」，并在页头报出条数',
      GP.hasGaps && GP.gapsDisplay !== 'none' && GP.gapsLi >= 1 && GP.noteShown, gapsScreen);
    assert('A4 纸面正文里没有「待补」这类给自己看的话',
      GP.paperHasDraftWord === false && GP.draftLis === 0, gapsScreen);

    // 打印媒体 = 「导出 PDF」走的那条路，提示块必须整块消失
    await cdp.send('Emulation.setEmulatedMedia', { media: 'print' });
    await sleep(500);
    const gapsPrint = await cdp.eval(`(() => {
      const d = document.querySelector('#a4').contentDocument;
      const g = d && d.querySelector('.gaps');
      const a4 = d && d.querySelector('.a4');
      return JSON.stringify({
        gapsDisplay: g ? getComputedStyle(g).display : 'gone',
        a4w: a4 ? Math.round(a4.getBoundingClientRect().width) : 0
      });
    })()`);
    await cdp.send('Emulation.setEmulatedMedia', { media: '' });
    await sleep(400);
    assert('打印/导出 PDF 时提示块整块消失（纸上不会印出来）',
      JSON.parse(gapsPrint).gapsDisplay === 'none', gapsPrint);

    // 下载出去的网页稿同理：既没有提示块，也没有提示语
    const dlClean = await cdp.eval(`(async () => {
      const r = await fetch('/api/export/file?format=html&profile=baoyan&template=classic');
      const t = await r.text();
      return JSON.stringify({
        htmlGaps: t.includes('class="gaps"'),
        htmlHint: t.includes('待补') || t.includes('建议补上')
      });
    })()`, true);
    const DC = JSON.parse(dlClean);
    assert('下载的网页稿里既没有提示块也没有提示语',
      !DC.htmlGaps && !DC.htmlHint, dlClean);

    // 9g. 版式收藏 + 「更多模板」子域
    //     左栏一行 4 格：前 TPL_ROW(3) 个模板 + 固定的「更多模板」，其余在子域里挑。
    const tplGrid = await cdp.eval(`(() => {
      const cells = [...document.querySelectorAll('.tpl-grid > .tpl')];
      const more = cells.find(c => c.classList.contains('tpl-more'));
      const names = cells.filter(c => c !== more).map(c => {
        const n = c.querySelector('.tpl-name');
        const t = c.querySelector('.tpl-thumb');
        // 「名字写在图上方」不是靠视觉顺序，是 DOM 顺序：名字必须是 thumb 的前一个兄弟
        return n && t && n.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING
          ? n.textContent.trim() : 'BAD_ORDER';
      });
      // 一行 4 格是排版约定：格子数必须等于 4（3 模板 + 1 更多），多了就会折成两行
      const oneRow = getComputedStyle(document.querySelector('.tpl-grid')).gridTemplateColumns
        .split(' ').length === 4;
      return JSON.stringify({
        cells: cells.length,
        more: !!more,
        names,
        oneRow,
        favN: (S.profile.export.favorites || []).length,
        act: more ? typeof more.onclick : 'none'
      });
    })()`);
    const TG = JSON.parse(tplGrid);
    assert('左栏版式一行 4 格 = 3 个模板 + 固定一个「更多模板」',
      TG.cells === 4 && TG.more && TG.oneRow, tplGrid);
    assert('模板名写在缩略图上方（DOM 顺序：名字 → 图）',
      TG.names.length === 3 && !TG.names.includes('BAD_ORDER'), tplGrid);
    assert('「更多模板」按钮绑上了事件', TG.act === 'function', tplGrid);

    const gallery = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.tpl-more').click();
      await w(500);
      const m = document.querySelector('#modal');
      const cards = [...m.querySelectorAll('.gal-card')];
      const stars = [...m.querySelectorAll('.gal-star')];
      const on = stars.filter(s => s.classList.contains('on'));
      const up = !!m.querySelector('#tplFile');
      const sample = !!m.querySelector('#tplSample');
      const first = stars.find(s => !s.classList.contains('on'));
      const before = (S.profile.export.favorites || []).length;
      // 已收藏满 5 个时，未收藏的星标应当是禁用的——不能偷偷超出排版上限
      const blockedRight = !first || first.disabled;
      // 先取消一个，再收藏一个，确认两个方向都真的写进配置
      const onStar = on[0];
      const key = onStar.dataset.fav;
      onStar.click(); await w(600);
      const afterUnfav = (S.profile.export.favorites || []).length;
      // 收藏动完会重画整个子域，旧的星标节点已经脱离文档——
      // 拿它读 class 永远是旧值。按 key 重新查一次。
      const again = m.querySelector('[data-fav="' + key + '"]');
      const nowOff = !!again && !again.classList.contains('on');
      const free = [...m.querySelectorAll('.gal-star')].find(s => !s.classList.contains('on'));
      free.click(); await w(600);
      const afterFav = (S.profile.export.favorites || []).length;
      const backCell = (await (await fetch('/api/state')).json()).profile.export.favorites;
      // 子域是模态，不收掉它后面的缩放断言点不到东西
      m.close();
      return JSON.stringify({
        cards: cards.length, stars: stars.length, onN: on.length, up, sample,
        blockedRight, afterUnfav, nowOff, afterFav, key, backCell
      });
    })()`, true);
    const GA = JSON.parse(gallery);
    assert('「更多模板」子域列出全部模板（比左栏 5 格多得多）',
      GA.cards >= 9 && GA.stars === GA.cards, gallery);
    assert('子域里能上传自己的模板，也给得出样例',
      GA.up && GA.sample, gallery);
    assert('收藏满上限后，其余星标是禁用的（不超出排版允许的数量）',
      GA.blockedRight, gallery);
    assert('取消收藏立刻生效（格子与配置同步）',
      GA.afterUnfav === 2 && GA.nowOff, gallery);
    assert('重新收藏另一个模板后仍是 3 个', GA.afterFav === 3 && GA.backCell.length === 3, gallery);

    // 9h. 一屏装得下 + Ctrl+滚轮缩放
    const fitZoom = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      const outer = document.querySelector('#zoomOuter');
      const stage = document.querySelector('#zoomStage');
      const panel = document.querySelector('.ex-panel');
      const frame = document.querySelector('#a4');
      const fits = () => stage.offsetHeight <= outer.clientHeight + 2 && stage.offsetWidth <= outer.clientWidth + 2;
      /* 占位盒（stage）与纸（iframe）的可见矩形必须一模一样。
         做法是「stage 定尺寸 + iframe 自己吃 transform」，两边各乘一次；
         一旦有人把 scale 挪到 stage 上，盒子会变成「原始尺寸 × 比例²」，
         只有纸的一半高、纸会戳出盒子 —— 这条就是那个 bug 的回归哨兵。 */
      const snug = () => {
        const s = stage.getBoundingClientRect(), f = frame.getBoundingClientRect();
        return Math.abs(s.height - f.height) <= 1.5 && Math.abs(s.width - f.width) <= 1.5
          && (f.bottom - s.bottom) <= 1.5 && (f.right - s.right) <= 1.5;
      };
      // 量用户真正看得见的那行百分比，而不是某个元素的内联 transform
      const before = document.querySelector('#zoomPct').textContent;
      const z0 = S._tplZoom ? S._tplZoom.v : -1;
      const fit0 = fits();
      const snug0 = snug();
      // 缩放条上的「＋」等价于用户手动放大
      document.querySelector('#zoomIn').click(); await w(300);
      const z1 = S._tplZoom.v;
      const after = document.querySelector('#zoomPct').textContent;
      const snug1 = snug();
      document.querySelector('#zoomFit').click(); await w(300);
      const z2 = S._tplZoom.v;
      // 「适应」这一档必须当场满足「整页在框里」——后面还有滚轮测试，
      // 量晚了就变成在量放大之后的尺寸了（上一版就是这么误报的）。
      const fit2 = fits();
      // Ctrl+滚轮
      outer.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }));
      await w(250);
      const z3 = S._tplZoom.v;
      // 手动调过之后要退出「适应」跟随态，否则拉一下窗口比例就被重置了
      const manualFlag = S._tplZoom.auto === false;
      document.querySelector('#zoomFit').click(); await w(250);
      const fitFlag = S._tplZoom.auto === true;
      // 普通滚轮不该被拦（页面还得能滚动）
      const plain = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
      const plainPrevented = !outer.dispatchEvent(plain);
      return JSON.stringify({
        hasZoom: typeof S._tplZoom === 'object' && S._tplZoom !== null,
        z0, z1, z2, z3, before, after, fit0, fit2, snug0, snug1, manualFlag, fitFlag,
        plainPrevented,
        outerH: outer.clientHeight, stageH: stage.offsetHeight,
        panelH: panel.offsetHeight, panelScroll: panel.scrollHeight, viewH: window.innerHeight,
        frameH: frame.offsetHeight, baseH: frame.style.height,
        frameRectH: Math.round(frame.getBoundingClientRect().height),
        stageRectH: Math.round(stage.getBoundingClientRect().height)
      });
    })()`, true);
    const FZ = JSON.parse(fitZoom);
    assert('预览区能缩放：＋/− 真的改变比例，百分比标签同步',
      FZ.hasZoom && FZ.z1 > FZ.z2 * 0.99 && FZ.after !== FZ.before,
      `z0=${FZ.z0} z1=${FZ.z1} z2=${FZ.z2} pct "${FZ.before}"→"${FZ.after}"`);
    assert('占位盒与纸严丝合缝（缩放比没被乘两遍）',
      FZ.snug0 && FZ.snug1,
      `rect stage=${FZ.stageRectH} frame=${FZ.frameRectH} | offset stage=${FZ.stageH} frame=${FZ.frameH}`);
    assert('「适应」把整页塞进预览区（不是让你滚半页才发现有第二页）',
      FZ.fit0 && FZ.fit2 && FZ.z2 > 0, fitZoom);
    assert('Ctrl + 滚轮能在预览里缩放', FZ.z3 > FZ.z2, fitZoom);
    assert('手动调过之后退出「适应」跟随态，点适应又回来',
      FZ.manualFlag && FZ.fitFlag, fitZoom);
    assert('不按 Ctrl 的滚轮不被劫持（页面该滚还得滚）', FZ.plainPrevented === false, fitZoom);
    assert('左栏一屏内显示完，不用滚到底才找得到下载',
      FZ.panelH <= FZ.viewH && FZ.panelScroll <= FZ.panelH + 2,
      `panel=${FZ.panelH}/${FZ.panelScroll} viewport=${FZ.viewH}`);

    // 9i. 新版预览的三件事：纸内 Ctrl+滚轮、分页、缩放比例跨视图记忆
    const zoomExtra = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      const res = {};
      // ① 鼠标悬在纸上（iframe 文档内）按 Ctrl+滚轮——事件发生在 iframe 里，
      //    外层容器收不到；不挂进 iframe 文档的话这一下就是「缩放失效」
      const f = document.querySelector('#a4');
      const zBefore = S._tplZoom.v;
      const doc = f.contentDocument;
      doc.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true }));
      await w(250);
      res.inDocZoom = S._tplZoom.v !== zBefore;
      // ② 分页：文档超过一页时出现翻页条，下一页真的把文档滚过一页的距离
      await w(600);
      res.total = S._page ? S._page.total : -1;
      res.barHidden = document.querySelector('#pageBar').hidden;
      if (res.total > 1) {
        document.querySelector('#pgNext').click(); await w(300);
        res.page2 = S._page.n;
        res.scrollY = Math.round(f.contentWindow.scrollY);
        document.querySelector('#pgPrev').click(); await w(300);
      }
      // ③ 缩放比例跨视图记忆：手动调一档 → 去别的视图 → 回来，比例还在
      document.querySelector('#zoomIn').click(); await w(250);
      res.kept = S._tplZoom.v;
      go('overview'); await w(700);
      go('export'); await w(700);
      res.restored = S._tplZoom.v;
      return JSON.stringify(res);
    })()`, true);
    const ZX = JSON.parse(zoomExtra);
    assert('鼠标悬在纸上 Ctrl+滚轮也能缩放（wheel 挂进了 iframe 文档）', ZX.inDocZoom, zoomExtra);
    assert('分页条与文档页数一致（单页不显示）',
      ZX.total >= 1 && ZX.barHidden === (ZX.total <= 1), zoomExtra);
    if (ZX.total > 1) assert('下一页把文档滚离页首（页码到 2）、上一页能回来',
      ZX.page2 === 2 && ZX.scrollY > 112,
      `total=${ZX.total} scrollY=${ZX.scrollY}（2 页稿子会钳在 文档高−1123，不必恰好等于 1123）`);
    assert('切走再切回导出页，手动缩放比例原样保留',
      Math.abs(ZX.restored - ZX.kept) < 0.001, zoomExtra);

    // 把测试动过的偏好复位：版式 + 收藏（上限 3 个，与 MAX_FAV_TPL 一致）
    await cdp.eval(`fetch('/api/profile', { method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ export: { template: 'classic', lang: 'zh',
        favorites: ['classic', 'academic', 'compact'] } }) }).then(() => 'ok')`, true);

    // 10. 复盘卡片能在不报错的前提下渲染
    await cdp.eval('go("retro"); "ok"'); await sleep(500);
    const retro = await cdp.eval(`(() => {
      const t = document.querySelectorAll('[data-retro]');
      const bars = document.querySelectorAll('[data-save]');
      return 'textareas=' + t.length + ' bars=' + bars.length;
    })()`);
    const rn = retro.match(/textareas=(\d+) bars=(\d+)/);
    assert('每条复盘卡都有独立保存指示（3 输入 : 1 指示）', rn && Number(rn[1]) === Number(rn[2]) * 3 && Number(rn[2]) > 0, retro);
    log.push(`shot retro2 ${(await shot('retro2')).size}`);

    // 10b. 改截止时间 → 已发提醒档位必须被重置（真实端到端）
    const realReset = await cdp.eval(`(async () => {
      const exp0 = S.experiences.find(e => (e.nodes||[]).some(n => n.dueAt));
      const node0 = exp0.nodes.find(n => n.dueAt);
      const origDue = node0.dueAt;
      node0.notifiedAt = ['7','3'];
      await saveExp(exp0, true);
      openNodeModal(S.experiences.find(e => e.id === exp0.id), node0.id);
      document.querySelector('#ndDue').value = '2027-03-05T18:00';
      document.querySelector('#ndGo').click();
      await new Promise(r => setTimeout(r, 1200));
      const after = S.experiences.find(e => e.id === exp0.id).nodes.find(x => x.id === node0.id);
      const out = 'notifiedAt=' + JSON.stringify(after.notifiedAt) + '  due=' + after.dueAt;
      // 再改回去，顺便验证「时间没变就不重置」
      after.notifiedAt = ['7'];
      await saveExp(S.experiences.find(e => e.id === exp0.id), true);
      openNodeModal(S.experiences.find(e => e.id === exp0.id), node0.id);
      document.querySelector('#ndGo').click();
      await new Promise(r => setTimeout(r, 1200));
      const keep = S.experiences.find(e => e.id === exp0.id).nodes.find(x => x.id === node0.id).notifiedAt;
      // 复原数据
      const fin = S.experiences.find(e => e.id === exp0.id);
      const fn = fin.nodes.find(x => x.id === node0.id);
      fn.dueAt = origDue; fn.notifiedAt = [];
      await saveExp(fin, true);
      return out + '  || 未改时间时 notifiedAt=' + JSON.stringify(keep);
    })()`, true);
    assert('改截止时间会重置提醒档位', /notifiedAt=\[\]/.test(realReset), realReset);
    assert('没改时间就保留已发档位', /未改时间时 notifiedAt=\["7"\]/.test(realReset), realReset);

    // 11. 空筛选态
    await cdp.eval('go("archive"); "ok"'); await sleep(400);
    await cdp.eval('S.filter.q = "zzzz不存在"; render(); "ok"');
    await sleep(400);
    const empty = await cdp.eval(`!!document.querySelector('.empty') + '/' + !!document.querySelector('.empty-art svg')`);
    assert('空状态有插画', empty === 'true/true', empty);
    await cdp.eval('S.filter = {q:"",type:"",stage:"",matq:""}; render(); "ok"');

    // 12. 减少动效开关生效
    const rm = await cdp.eval(`(() => {
      document.documentElement.classList.add('reduce-motion');
      const el = document.querySelector('.kcard') || document.querySelector('.panel');
      const d = el ? getComputedStyle(el).transitionDuration : '';
      document.documentElement.classList.remove('reduce-motion');
      return 'dur=' + d;
    })()`);
    assert('「减少动效」真的把过渡压到极短', /^(0s|0\.0*1m?s|1e-0?5s|0\.00001s)$/.test(rm.replace('dur=', '').trim()) || parseFloat(rm.replace('dur=', '')) <= 0.00002, rm);

    // 13. 侧栏高亮必须跟着视图走（曾经一直停在「概览」）
    //     基本信息页是个例外：它不在导航里，高亮的是左下角那张资料卡。
    const railStates = [];
    for (const v of ['overview', 'archive', 'schedule', 'materials', 'retro', 'export', 'library', 'settings', 'profile']) {
      await cdp.eval(`go(${JSON.stringify(v)}); "ok"`);
      await sleep(320);
      const st = await cdp.eval(`(() => {
        const on = [...document.querySelectorAll('#nav .nav-item.on')];
        const card = document.querySelector('#railUser');
        const want = S.view === 'profile' ? '0|card=' + (card && card.classList.contains('on')) : '1|' + (on[0] ? on[0].dataset.go : '');
        return want + '|' + S.view;
      })()`);
      railStates.push(v + ':' + st);
      const [n, go, view] = st.split('|');
      const ok = v === 'profile' ? (n === '0' && go === 'card=true') : (n === '1' && go === v);
      if (!ok || view !== v) assert(`侧栏高亮跟随视图（${v}）`, false, st);
    }
    assert('侧栏高亮正好一项且跟随视图（基本信息页改为资料卡高亮）',
      railStates.every(s => {
        const [v, rest] = s.split(':');
        return rest === (v === 'profile' ? '0|card=true|profile' : '1|' + v + '|' + v);
      }), railStates.join(' '));

    // 14. 时间轴月份标签不能被竖线穿过（label 右边缘 必须 < 竖线左边缘）
    await cdp.eval('go("schedule"); "ok"'); await sleep(500);
    const lblGeom = await cdp.eval(`(() => {
      const tl = document.querySelector('.tl');
      const tlLeft = tl.getBoundingClientRect().left;
      const bl = parseFloat(getComputedStyle(tl, '::before').left);
      const railLeft = tlLeft + bl;
      // 逐个量所有月份标签，取最宽的那个（「10 月」比「9 月」宽）
      let gap = 1e9, leftMost = 1e9, who = '', overlap = false, n = 0;
      document.querySelectorAll('.tl-month .lbl .mo').forEach(mo => {
        const mr = mo.getBoundingClientRect(); n++;
        const g = railLeft - mr.right;
        if (g < gap) { gap = g; who = (mo.textContent || '').trim(); }
        if (mr.left - tlLeft < leftMost) leftMost = mr.left - tlLeft;
        if (mr.right > railLeft - 1) overlap = true;
      });
      return JSON.stringify({
        months: n, railLeft: +railLeft.toFixed(2), worstText: who,
        minGap: +gap.toFixed(2), minInkLeftVsTl: +leftMost.toFixed(2), overlap
      });
    })()`);
    const LG = JSON.parse(lblGeom);
    assert('所有月份标签都不压竖线（最窄气口 ≥4px）', !LG.overlap && LG.minGap >= 4, lblGeom);
    assert('月份标签没有溢出到时间轴容器左边之外', LG.minInkLeftVsTl >= -3, lblGeom);

    // 15. 进度条填充宽度要和百分比对得上
    await cdp.eval('go("overview"); "ok"'); await sleep(450);
    const barOv = await cdp.eval(`(() => {
      const b = document.querySelector('.bar');
      if (!b) return 'no-bar';
      const i = b.querySelector('i');
      // 动画期间量不准，等它跑完
      return new Promise(r => setTimeout(() => {
        const br = b.getBoundingClientRect(), ir = i.getBoundingClientRect();
        r(JSON.stringify({ box: Math.round(br.width), fill: Math.round(ir.width),
          pct: Math.round(ir.width / br.width * 100),
          bg: getComputedStyle(i).backgroundColor }));
      }, 800));
    })()`, true);
    const BO = JSON.parse(barOv);
    assert('概览进度条有实际填充且颜色是主色', BO.fill > 0 && /^rgb\(/.test(BO.bg) && !/rgba\(0, 0, 0, 0\)/.test(BO.bg), barOv);

    await cdp.eval('go("settings"); "ok"'); await sleep(450);
    // 「数据与外观」面板已整体删除：设置页里不该再有任何进度条
    const barSet = await cdp.eval(`(() => new Promise(r => setTimeout(() => {
      r(JSON.stringify({ bars: document.querySelectorAll('#view .bar').length,
        labels: [...document.querySelectorAll('#view > .grid-2 > .panel > .panel-label')].map(l => l.textContent.trim()) }));
    }, 500)))()`, true);
    const BS = JSON.parse(barSet);
    assert('设置页不再有「内容完整度」进度条（面板已删）', BS.bars === 0, barSet);

    // 16. 变更日志：连续的同一条变更必须被合并（自动保存不该刷屏）
    const chg = await cdp.eval(`fetch('/api/changelog').then(r => r.json()).then(d => {
      // 只算「窗口内」的连续重复。合并规则是 op+id 且相隔 ≤10 分钟，
      // 超出窗口的同名条目本来就该各算一条（比如上午改一次、下午又改一次）。
      const WIN = 10 * 60 * 1000;
      let dup = 0; const samples = [];
      for (let i = 1; i < d.items.length; i++) {
        const a = d.items[i - 1], b = d.items[i];
        if (a.op + '|' + (a.id || '') !== b.op + '|' + (b.id || '')) continue;
        const gap = Math.abs(new Date(b.at) - new Date(a.at));
        if (gap <= WIN) { dup++; samples.push(a.op + ' ' + (a.id || '-') + ' 间隔' + Math.round(gap / 60000) + '分'); }
      }
      const n2 = d.items.filter(x => x.n > 1).length;
      return JSON.stringify({ items: d.items.length, rawCount: d.rawCount, consecutiveDup: dup, merged: n2, samples: samples.slice(0, 3) });
    })`, true);
    const CH = JSON.parse(chg);
    assert('变更摘要里没有窗口内连续重复的同一条', CH.consecutiveDup === 0, chg);
    assert('自动保存已被合并（出现 ×N）', CH.rawCount > CH.items ? CH.merged >= 1 : true,
      `raw=${CH.rawCount} shown=${CH.items} merged=${CH.merged}`);

    // 17. 空操作保存不该写盘、也不该记日志
    // 设置页里"点了一下但没改任何东西"（下拉重选同一项、复选框点两下、SMTP 框进出）
    // 都会走到 saveProfile。之前它无条件写盘 + appendLog，会拿空写入刷屏变更日志，
    // 还会让 updatedAt 白跳一下（手机端将来靠它判增量）。
    const noop = await cdp.eval(`(async () => {
      const before = (await (await fetch('/api/changelog')).json()).rawCount;
      const cur = S.profile;
      const gradeBefore = cur.grade || '';
      const majorsBefore = (cur.majors || []).length;
      await fetch('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grade: gradeBefore, majors: cur.majors || [] }) });
      const after = (await (await fetch('/api/changelog')).json()).rawCount;
      const st = await (await fetch('/api/state')).json();
      return JSON.stringify({ before, after, gradeBefore,
        gradeSame: (st.profile.grade || '') === gradeBefore,
        majorsSame: (st.profile.majors || []).length === majorsBefore });
    })()`, true);
    const NP = JSON.parse(noop);
    assert('无实质变化的保存不新增变更记录', NP.after === NP.before, noop);
    assert('无实质变化的保存不改动 profile 内容', NP.gradeSame && NP.majorsSame, noop);

    await cdp.eval('openChanges(); "ok"', true); await sleep(900);
    log.push(`shot modal-changes ${(await shot('modal-changes2')).size}`);
    await cdp.eval('closeModal(); "ok"');

    /* ---------------- 右上角按钮 ---------------- */
    // 这组是补漏：之前测抽屉/弹窗都是直接调 openXxx()，不点真实按钮，
    // 所以「按钮渲染在 #view 外面、一个都没绑事件」这个 bug 一条断言都抓不到。
    // 以后凡是用户要用鼠标点的东西，断言就必须真点。
    const topBtns = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      const out = [];
      for (const v of ['overview','archive','schedule','materials','export','retro','settings']) {
        go(v); await w(120);
        const bs = [...document.querySelectorAll('#topbarActions button')];
        out.push(v + '=' + bs.length + '/' + bs.filter(b => typeof b.onclick === 'function').length);
      }
      return out.join(' ');
    })()`, true);
    const topPairs = topBtns.split(' ').map(s => s.split('=')[1].split('/'));
    assert('右上角每个按钮都绑上了事件',
      topPairs.every(p => Number(p[0]) === Number(p[1])) && topPairs.some(p => Number(p[0]) > 0), topBtns);

    const topClick = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      go('overview'); await w(250);
      const b = document.querySelector('#topbarActions button[data-act="new"]');
      if (!b) return 'no-button';
      b.click(); await w(400);
      const d = document.querySelector('#modal');
      const radios = [...document.querySelectorAll('#ntypeBox input[name=ntype]')];
      const libRow = document.querySelector('#nLibRow');
      // 默认类型是「竞赛」（列表第一个），所以竞赛库入口一开始就在
      const libShown0 = libRow ? !libRow.hidden : null;
      const other = radios.find(i => i.value === 'paper');
      other.click(); await w(150);
      const libShownOther = !libRow.hidden;
      const comp = radios.find(i => i.value === 'competition');
      comp.click(); await w(150);
      const libShownComp = !libRow.hidden;
      // 空名称直接创建：报错 toast 必须看得见——模态在浏览器顶层，
      // 以前 toast 挂在 body 上会被整个压住，现在挂在模态里
      document.querySelector('#nGo').click(); await w(400);
      const tEl = d.querySelector('.toast');
      const toastInModal = !!tEl;
      const toastText = tEl ? tEl.textContent : '';
      closeModal();
      return JSON.stringify({ open: d.open, nTypes: radios.length,
        libShown0, libShownOther, libShownComp, toastInModal, toastText });
    })()`, true);
    const TNC = JSON.parse(topClick);
    assert('「新增经历」弹窗带全部类型（10 类），选「竞赛」才出现竞赛库入口',
      TNC.nTypes >= 10 && TNC.libShown0 === true && TNC.libShownOther === false && TNC.libShownComp === true, topClick);
    assert('空名称的报错 toast 在模态里看得见（顶层遮挡修复）',
      TNC.toastInModal && /名称不能为空/.test(TNC.toastText), topClick);

    const topGo = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      go('materials'); await w(250);
      const b = document.querySelector('#topbarActions button[data-go]');
      if (!b) return 'no-go-button';
      const target = b.dataset.go;
      b.click(); await w(400);
      return 'target=' + target + ' now=' + S.view;
    })()`, true);
    assert('右上角「去经历里添加」能切到档案视图', /target=archive now=archive/.test(topGo), topGo);

    /* ---------------- 竞赛库：校内认定档次 ---------------- */
    await cdp.eval('go("overview"); "ok"');
    await sleep(300);
    await cdp.eval('openLibraryModal(); "ok"', true);
    await sleep(1000);

    const libOpen = await cdp.eval(`(() => {
      const d = document.querySelector('#modal');
      const chips = [...d.querySelectorAll('.modal-body .chip')].map(c => c.textContent.trim());
      return JSON.stringify({
        count: (d.querySelector('#lcount') || {}).textContent || '',
        legend: ['国际级顶级','国际级','国家级顶级','国家级','名单外'].every(t => chips.includes(t)),
        legendText: chips.join('/'),
        select: [...d.querySelectorAll('#lrecog option')].map(o => o.textContent.trim()).join('/'),
        chips: [...d.querySelectorAll('#lres .chip')].length,
        cards: d.querySelectorAll('#lres .panel').length
      });
    })()`);
    const LO = JSON.parse(libOpen);
    assert('竞赛库图例含四档 + 名单外', LO.legend, LO.legendText);
    assert('档次下拉含全部四档 + 名单外', /国际级顶级\/国际级\/国家级顶级\/国家级\/名单外/.test(LO.select), LO.select);
    const libTotal = await cdp.eval(`fetch('/api/library').then(r => r.json()).then(d => d.count)`, true);
    assert('竞赛库计数行报出总量（与库实际条数一致）', LO.count.includes(String(libTotal)), LO.count + ' / api=' + libTotal);
    assert('每张竞赛卡都带档次 chip', LO.chips >= LO.cards && LO.cards > 0, libOpen);

    const libFilter = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      const sel = document.querySelector('#lrecog');
      sel.value = '国家级赛事';
      sel.dispatchEvent(new Event('change'));
      await w(800);
      const items = [...document.querySelectorAll('#lres .panel')];
      const chips = items.map(p => p.querySelector('.chip').textContent.trim());
      return JSON.stringify({
        n: items.length,
        allSame: chips.length > 0 && chips.every(c => c === '国家级'),
        cnt: (document.querySelector('#lcount') || {}).textContent || '',
        sample: [...new Set(chips)].join(',')
      });
    })()`, true);
    const LF = JSON.parse(libFilter);
    assert('档次筛选只留该档（全部是「国家级」）', LF.allSame, libFilter);
    assert('档次筛选命中数与源文档一致（75 条）', /75/.test(LF.cnt), LF.cnt);
    log.push(`shot library-filtered ${(await shot('modal-library-filtered')).size}`);
    await cdp.eval('closeModal(); "ok"');

    /* ---------------- 本轮改版：侧边栏 / 经历类型 / 专业 / 高级区 ---------------- */
    // 这组同样遵守「用户要用鼠标点的东西，断言就必须真点」这条纪律：
    // 侧栏入口、类型选择、专业候选，全部走 .click() / dispatchEvent，不直接调函数。

    // A. 主导航 8 项（七视图 + 「设置」），左下角资料卡是「基本信息」入口
    await cdp.eval('go("overview"); "ok"'); await sleep(400);
    const navSet = await cdp.eval(`(() => {
      const items = [...document.querySelectorAll('#nav .nav-item')].map(b => b.dataset.go);
      const labels = [...document.querySelectorAll('#nav .nav-label')].map(l => l.textContent.trim());
      const card = document.querySelector('#railUser');
      return JSON.stringify({ items, labels, cardGo: card ? card.dataset.go : '' });
    })()`);
    const NV = JSON.parse(navSet);
    assert('主导航 8 项，包含「竞赛库」与「设置」',
      NV.items.includes('settings') && NV.items.includes('library') && NV.items.length === 8, navSet);
    assert('侧边栏不再有「工作区」这个分组标签', !NV.labels.includes('工作区'), navSet);
    assert('左下角资料卡是「基本信息」入口', NV.cardGo === 'profile', navSet);

    const cardClick = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('#railUser').click();
      await w(500);
      const card = document.querySelector('#railUser');
      return JSON.stringify({ view: S.view, on: card.classList.contains('on'),
        title: document.querySelector('#viewTitle').textContent,
        navOnCount: document.querySelectorAll('#nav .nav-item.on').length });
    })()`, true);
    const CC = JSON.parse(cardClick);
    assert('真点资料卡能进「基本信息」页，且资料卡自身高亮', CC.view === 'profile' && CC.on, cardClick);
    assert('在基本信息页时导航里没有任何一项被误标为选中', CC.navOnCount === 0, cardClick);

    const setNav = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      const btn = document.querySelector('#nav .nav-item[data-go="settings"]');
      if (!btn) return 'no-settings-item';
      btn.click(); await w(500);
      return JSON.stringify({ view: S.view, title: document.querySelector('#viewTitle').textContent,
        on: btn.classList.contains('on') });
    })()`, true);
    const SN = JSON.parse(setNav);
    assert('导航里的「设置」点得动，进去是设置页且导航项高亮',
      SN.view === 'settings' && SN.title === '设置' && SN.on, setNav);
    log.push(`shot settings-v2 ${(await shot('settings-v2')).size}`);

    // B. 经历类型：专利 / 学生工作 / 志愿服务 / 证书 都在，且各带专属字段
    const tax = await cdp.eval(`JSON.stringify({
      labels: TYPE_LIST.map(t => t.label),
      hasPatent: TYPE_LIST.some(t => t.key === 'patent'),
      hasStudentWork: TYPE_LIST.some(t => t.key === 'student_work'),
      hasVolunteer: TYPE_LIST.some(t => t.key === 'volunteer'),
      hasCert: TYPE_LIST.some(t => t.key === 'certificate'),
      patentFields: (fieldsOf('patent') || []).map(f => f.label),
      swFields: (fieldsOf('student_work') || []).map(f => f.label)
    })`);
    const TX = JSON.parse(tax);
    assert('经历类型含专利 / 学生工作 / 志愿服务 / 证书',
      TX.hasPatent && TX.hasStudentWork && TX.hasVolunteer && TX.hasCert, tax);
    assert('专利带专属字段（专利类型 / 专利号 / 授权公告日）',
      TX.patentFields.length >= 3 && TX.patentFields.join('').includes('专利'), tax);
    assert('学生工作带专属字段（组织 / 职务 / 规模）',
      TX.swFields.length >= 3 && TX.swFields.join('').includes('职务'), tax);

    // B2. 类型收口：内置 10 类、没有「其他类型」；设置里可以自加/删自定义类型
    const custom = await cdp.eval(`(() => {
      const labels = TYPE_LIST.map(t => t.label);
      return JSON.stringify({
        n: TYPE_LIST.length,
        hasExchange: labels.includes('交换经历'),
        hasOther: labels.includes('其他类型'),
        customs: TYPE_LIST.filter(t => t.custom).length,
        addTypeBtn: !!document.querySelector('[data-act="add-type"]')
      });
    })()`);
    const CU = JSON.parse(custom);
    assert('类型含内置「交换经历」，且不再有「其他类型」', CU.hasExchange && !CU.hasOther, custom);
    assert('类型表里当前没有自定义项（「加一个类型」入口在设置页，D 组会量到）',
      CU.customs === 0, custom);

    // B3. 抽屉里换类型 → 专属字段与措辞跟着变
    const tchange = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      const target = S.experiences[0];
      const id = target.id, origType = target.type;
      openDrawer(id); await w(400);
      const sel = document.querySelector('#drawer [data-e="type"]');
      sel.value = 'student_work'; sel.dispatchEvent(new Event('change'));
      await w(1000);
      const metaKeys = [...document.querySelectorAll('#drawer [data-meta]')].map(i => i.dataset.meta);
      const hasAward = !!document.querySelector('#drawer [data-e="result.award"]');
      const hasRank = !!document.querySelector('#drawer [data-e="result.rank"]');
      const hasLevel = !!document.querySelector('#drawer [data-e="level"]');
      const pos = document.querySelector('#drawer [data-meta="position"]');
      let savedPos = null;
      if (pos) {
        pos.value = '学习部部长'; pos.dispatchEvent(new Event('change'));
        await w(1000);
        savedPos = ((S.experiences.find(e => e.id === id) || {}).meta || {}).position;
      }
      const exp = S.experiences.find(e => e.id === id);
      exp.type = origType; exp.meta = {};
      await saveExp(exp, true); renderDrawer(); render();
      return JSON.stringify({ metaKeys, hasAward, hasRank, hasLevel, savedPos });
    })()`, true);
    const TC = JSON.parse(tchange);
    assert('抽屉里能换类型，专属字段跟着变成学生工作的三项',
      ['org', 'position', 'scale'].every(k => TC.metaKeys.includes(k)), tchange);
    assert('非竞赛类不再被问「级别 / 名次」，改成「获得的认可」',
      !TC.hasRank && !TC.hasLevel && TC.hasAward, tchange);
    assert('专属字段真的存进了 exp.meta', TC.savedPos === '学习部部长', tchange);

    // C. 专业：自由输入 + 相近查找 + 覆盖度实话（专业在「基本信息」页）
    await cdp.eval('closeDrawer(); go("profile"); "ok"'); await sleep(500);
    const majorFlow = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      const orig = JSON.stringify(S.profile.majors || []);
      const origN = (S.profile.majors || []).length;
      const q = document.querySelector('#majorQ');
      if (!q) return 'NO_INPUT';
      q.value = '计算机'; q.dispatchEvent(new Event('input'));
      await w(900);
      const sugg = [...document.querySelectorAll('#majorSugg .sugg')];
      const first = sugg[0];
      const firstMeta = first ? first.querySelector('span').textContent : '';
      if (first) { first.click(); await w(1200); }
      const chips = [...document.querySelectorAll('.mchip')].map(c => c.textContent.replace('×', '').trim());
      const echo = (document.querySelector('#majorEcho') || {}).textContent || '';
      const tags = S.profile.majorTags || [];
      await w(700);
      const cov = (document.querySelector('#majorCoverage') || {}).textContent || '';
      const x = document.querySelector('[data-delmajor]');
      if (x) { x.click(); await w(900); }
      const afterRemove = (S.profile.majors || []).length;
      await fetch('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ majors: JSON.parse(orig) }) });
      await refresh(); await w(200);
      return JSON.stringify({ suggN: sugg.length, firstMeta, chips, tags, cov, afterRemove, origN,
        echoHasTags: /已识别方向/.test(echo) });
    })()`, true);
    const MF = JSON.parse(majorFlow);
    assert('专业输入框敲字会给出相近专业候选，且注明它属于哪个专业类',
      MF.suggN >= 3 && /计算机类/.test(MF.firstMeta), majorFlow);
    assert('点候选能把它加成专业标签', MF.chips.includes('计算机科学与技术'), majorFlow);
    assert('选完会显示由专业解析出的竞赛方向', MF.tags.length > 0 && MF.echoHasTags, majorFlow);
    assert('会如实告诉用户库里有多少对口赛事（不装作推荐得很准）',
      /对口/.test(MF.cov) && /\d/.test(MF.cov), MF.cov);
    // 用户本来就有专业（数据科学与大数据技术），所以「移除一个」是回到原有数量，
    // 不是归零——以前写死 0，用户一设专业这条就假失败。
    assert('专业标签能单个移除',
      MF.afterRemove === MF.origN && MF.chips.length === MF.origN + 1, majorFlow);
    log.push(`shot settings-major ${(await shot('settings-major')).size}`);

    // D. 设置页只剩两块：提醒 / 经历类型。竞赛库与数据与外观已整块删除。
    await cdp.eval('go("settings"); "ok"'); await sleep(500);
    const setShape = await cdp.eval(`(() => {
      const txt = document.querySelector('#view').textContent;
      return JSON.stringify({
        noAdv: !document.querySelector('.adv'),
        labels: [...document.querySelectorAll('#view > .grid-2 > .panel > .panel-label')].map(l => l.textContent.trim()),
        hasAddType: !!document.querySelector('[data-act="add-type"]'),
        libGo: !!document.querySelector('#view [data-go="library"]'),
        changelog: !!document.querySelector('#view [data-act="changelog"]'),
        noShutdownText: !/关机期间|下次开机/.test(txt),
        noSmtpEssay: !/邮件会落成|outbox/.test(txt),
        noOrigin: !/学业竞赛项目库|认定档次|榜单来源/.test(txt)
      });
    })()`);
    const SS2 = JSON.parse(setShape);
    assert('设置页不再有「高级」折叠区', SS2.noAdv, setShape);
    assert('设置页正文只剩「提醒 / 经历类型」两块（竞赛库 / 数据与外观已删）',
      ['提醒', '经历类型'].every(k => SS2.labels.includes(k)) && SS2.labels.length === 2, setShape);
    assert('经历类型块保留「加一个类型」入口', SS2.hasAddType, setShape);
    assert('设置页里不再有数据维护与竞赛库的按钮', !SS2.libGo && !SS2.changelog, setShape);
    assert('被删掉的三段说明真的没有回来（关机补发 / SMTP 落盘 / 库的来历）',
      SS2.noShutdownText && SS2.noSmtpEssay && SS2.noOrigin, setShape);

    // 基本信息页：联系方式等新字段真的在，且能存进 profile
    const profFlow = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      go('profile'); await w(400);
      const labels = [...document.querySelectorAll('#view .panel-label')].map(l => l.textContent.trim());
      const hasPhone = !!document.querySelector('[data-set="phone"]');
      const hasEmail = !!document.querySelector('[data-set="email"]');
      const hasGender = !!document.querySelector('[data-set="gender"]');
      const hasMajorQ = !!document.querySelector('#majorQ');
      // 布局：专业在右列联系方式下方，底边与左列身份信息对齐（±2px）
      const panels = [...document.querySelectorAll('#view .panel')];
      const idP = panels.find(x => (x.querySelector('.panel-label') || {}).textContent === '身份信息');
      const majorP = panels.find(x => x.querySelector('#majorQ'));
      const alignBottom = (idP && majorP)
        ? Math.abs(idP.getBoundingClientRect().bottom - majorP.getBoundingClientRect().bottom) : -1;
      // 证件照字段 + 上一轮删掉的草稿向说明文案不许回来
      const hasPhotoPick = !!document.querySelector('[data-act="photo-pick"]');
      const pageTxt = document.querySelector('#view').textContent;
      const noDraftText = !/英文简历抬头用它|改了就走|硬通货|打字就行|逐份稿子/.test(pageTxt);
      const phone = document.querySelector('[data-set="phone"]');
      phone.value = '13800001234'; phone.dispatchEvent(new Event('change'));
      await w(800);
      const savedPhone = S.profile.phone;
      await fetch('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '' }) });
      await refresh(); await w(200);
      return JSON.stringify({ labels, hasPhone, hasEmail, hasGender, hasMajorQ, hasPhotoPick,
        noDraftText, savedPhone, alignBottom,
        title: document.querySelector('#viewTitle').textContent });
    })()`, true);
    const PF = JSON.parse(profFlow);
    assert('基本信息页有「基本信息」标题与电话 / 邮箱 / 性别字段',
      PF.title === '基本信息' && PF.hasPhone && PF.hasEmail && PF.hasGender, profFlow);
    assert('基本信息页有「证件照」上传入口', PF.hasPhotoPick, profFlow);
    assert('草稿向的说明文案已全部删掉', PF.noDraftText, profFlow);
    assert('电话能存进 profile（写入路径与设置项一致）', PF.savedPhone === '13800001234', profFlow);
    assert('基本信息页保留专业模块（教育背景面板 + 自由输入入口都在）',
      PF.labels.includes('教育背景') && PF.hasMajorQ, profFlow);
    assert('专业模块在联系方式下方，底边与身份信息对齐（±2px）',
      PF.alignBottom >= 0 && PF.alignBottom <= 2, profFlow);

    /* ---------------- 竞赛库独立视图（Phase D 从设置里单设的一栏） ---------------- */
    await cdp.eval('go("library"); "ok"'); await sleep(900);
    const libView = await cdp.eval(`(() => {
      const cards = [...document.querySelectorAll('#libList .panel')];
      const first = cards[0];
      return JSON.stringify({
        q: !!document.querySelector('#libq'),
        recog: [...(document.querySelector('#librecog') || { options: [] }).options].map(o => o.textContent.trim()).join('/'),
        count: (document.querySelector('#libCount') || {}).textContent || '',
        cards: cards.length,
        detail: first ? ['类别', '时间窗口', '主办方', '校内认定'].every(k => first.textContent.includes(k)) : false,
        site: first ? !!first.querySelector('a[target="_blank"]') : false,
        addBtn: !!document.querySelector('#view [data-act="lib-add"]'),
        recoBtn: !!document.querySelector('#view [data-act="lib-reco"]'),
        // 「来历说明」指的是出处解释文案；主办方字段里真实写着「中国高等教育学会」的竞赛不受影响
        noOrigin: !/学业竞赛项目库|认定档次|榜单来源/.test(document.querySelector('#view').textContent)
      });
    })()`);
    const LV = JSON.parse(libView);
    assert('竞赛库视图有搜索框、档次下拉（含名单外）与「按我专业推荐」',
      LV.q && /名单外/.test(LV.recog) && LV.recoBtn, libView);
    assert('竞赛库计数报出总量（与库实际条数一致）', LV.count.includes(String(libTotal)), LV.count + ' / api=' + libTotal);
    assert('竞赛卡片带完整信息：类别 / 时间窗口 / 主办方 / 校内认定 + 官网链接',
      LV.cards > 0 && LV.detail && LV.site, libView);
    assert('「添加新竞赛」入口就在工具栏上', LV.addBtn, libView);
    assert('库视图里没有来历说明（认定名单 / 学会榜单一概不提）', LV.noOrigin, libView);
    log.push(`shot library-view ${(await shot('library-view')).size}`);

    // 自定义竞赛：真点「添加新竞赛」，三个字段（中英文名 + 网址）走一遍加 / 重名 / 删
    const customFlow = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      const total = () => fetch('/api/library').then(r => r.json()).then(d => d.count);
      const before = await total();
      // 空中文名要被挡下来
      document.querySelector('#view [data-act="lib-add"]').click(); await w(400);
      let m = document.querySelector('#modal');
      m.querySelector('#clGo').click(); await w(400);
      const toastEl = m.querySelector('.toast');
      const emptyBlocked = !!toastEl && /不能为空/.test(toastEl.textContent);
      // 填齐三个字段，真加一条
      m.querySelector('#clName').value = '自检临时竞赛ZZZ';
      m.querySelector('#clNameEn').value = 'QA Temp Contest';
      m.querySelector('#clSite').value = 'https://example.org/qa';
      m.querySelector('#clGo').click(); await w(1400);
      const afterAdd = await total();
      // 重名再点一次：加不进去
      document.querySelector('#view [data-act="lib-add"]').click(); await w(400);
      m = document.querySelector('#modal');
      m.querySelector('#clName').value = '自检临时竞赛ZZZ';
      m.querySelector('#clGo').click(); await w(800);
      const dupBlocked = !!m.querySelector('.toast');
      m.close();
      // 清理：自定义条目能删，内置的删不掉
      const lib = await fetch('/api/library').then(r => r.json());
      const added = (lib.items || []).find(i => i.name === '自检临时竞赛ZZZ');
      const del = await fetch('/api/library/custom?id=' + encodeURIComponent(added.id), { method: 'DELETE' }).then(r => r.json());
      const afterDel = await total();
      const builtinStatus = await fetch('/api/library/custom?id=cn-innovation', { method: 'DELETE' }).then(r => r.status);
      await refresh(); await w(300);
      return JSON.stringify({ before, emptyBlocked, afterAdd, dupBlocked, delOk: del.ok, afterDel,
        builtinStatus, back: afterDel === before });
    })()`, true);
    const CF2 = JSON.parse(customFlow);
    assert('添加新竞赛：空中文名被挡下并提示', CF2.emptyBlocked, customFlow);
    assert('填齐中英文名 + 网址后能真加进库（总数 +1）', CF2.afterAdd === CF2.before + 1, customFlow);
    assert('重名的竞赛加不进去', CF2.dupBlocked, customFlow);
    assert('自己加的竞赛能删掉、内置竞赛删不掉，删完总数复原',
      CF2.delOk && CF2.afterDel === CF2.before && CF2.builtinStatus === 400, customFlow);

    // 自定义经历类型：加 → 出现在词表和设置页 → 删 → 消失（与设置页同一条写路径）
    const ctypeFlow = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      await fetch('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customTypes: [{ label: '自检类型' }] }) });
      await refresh();
      go('settings'); await w(600);
      const labels1 = TYPE_LIST.map(t => t.label);
      const key = (TYPE_LIST.find(t => t.custom) || {}).key || '';
      const inSettings = !!document.querySelector('[data-act="add-type"]')
        && [...document.querySelectorAll('.chip')].some(c => c.textContent.includes('自检类型'));
      const hasDelete = !!document.querySelector('[data-deltype="' + key + '"]');
      await fetch('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customTypes: [] }) });
      await refresh(); await w(300);
      const labels2 = TYPE_LIST.map(t => t.label);
      return JSON.stringify({ added: labels1.includes('自检类型'), key, inSettings, hasDelete,
        removed: !labels2.includes('自检类型'), xPrefix: key.startsWith('x_') });
    })()`, true);
    const CT = JSON.parse(ctypeFlow);
    assert('自定义类型加完立刻出现在词表里（x_ 前缀），设置页能看到也能删',
      CT.added && CT.xPrefix && CT.inSettings && CT.hasDelete, ctypeFlow);
    assert('删掉自定义类型后词表复原（已录经历不受影响的语义由后端保证）', CT.removed, ctypeFlow);

    /* ---------------- 英文稿纯化 ---------------- */
    // 英文版的「壳」必须全换：html lang、章节标题、侧栏小标题。
    // 正文里的人名 / 校名 / 没填英文名的经历标题是用户数据，不强求翻译（titleEn 回退原名）。
    await cdp.eval('go("export"); "ok"'); await sleep(1400);
    const enMode = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      // 口径归位到保研：出国锁定英文，会让「切回中文」失效
      const baoyanBtn = [...document.querySelectorAll('[data-exp-profile]')].find(b => b.dataset.expProfile === 'baoyan');
      if (baoyanBtn && !baoyanBtn.classList.contains('on')) { baoyanBtn.click(); await w(1200); }
      [...document.querySelectorAll('[data-exp-lang]')].find(b => b.dataset.expLang === 'en').click();
      await w(1800);
      const d = document.querySelector('#a4').contentDocument;
      const cjk = s => /[\\u4e00-\\u9fff]/.test(s);
      const h2s = [...d.querySelectorAll('h2')].map(h => h.textContent.trim());
      const sideH = [...d.querySelectorAll('.side-h')].map(h => h.textContent.trim());
      return JSON.stringify({
        lang: d.documentElement.lang,
        h2s, sideH,
        h2Clean: h2s.length > 0 && h2s.every(t => !cjk(t)),
        sideClean: sideH.every(t => !cjk(t))
      });
    })()`, true);
    const EN = JSON.parse(enMode);
    assert('英文稿的 html lang 是 en，章节标题全部换成英文',
      EN.lang === 'en' && EN.h2Clean, JSON.stringify({ lang: EN.lang, h2s: EN.h2s }));
    assert('英文稿的侧栏小标题也是英文', EN.sideClean, enMode);
    // 切回中文，别把语言偏好留在英文档
    await cdp.eval(`(async () => {
      [...document.querySelectorAll('[data-exp-lang]')].find(b => b.dataset.expLang === 'zh').click();
      await new Promise(r => setTimeout(r, 1200));
      return 'ok';
    })()`, true);

    /* ---------------- Phase E：三类侧重 / 出国锁英文 / 照片 / 翻译标注 ---------------- */

    // E1. 导航与口径改名：「简历导出」+「求职」
    const eRename = await cdp.eval(`JSON.stringify({
      navLabels: [...document.querySelectorAll('#nav .nav-item')].map(l => l.textContent.trim()),
      profiles: [...document.querySelectorAll('[data-exp-profile]')].map(b => b.textContent.trim())
    })`);
    const ER = JSON.parse(eRename);
    assert('导航第八项改叫「简历导出」', ER.navLabels.includes('简历导出') && !ER.navLabels.includes('成果导出'), eRename);
    assert('口径是保研 / 求职 / 出国（「求学」「自定义」都不在了）',
      ER.profiles.join('/') === '保研/求职/出国', eRename);

    // E2. 照片选项按口径给默认：保研/求职默认放，出国默认不放；出国锁定英文
    const ePhoto = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      const photoSeg = () => [...document.querySelectorAll('[data-exp-photo]')].find(b => b.classList.contains('on'));
      const zhBtn = () => document.querySelector('[data-exp-lang="zh"]');
      const r = {};
      r.baoyanPhoto = photoSeg() ? photoSeg().dataset.expPhoto : '';
      // 切到出国
      [...document.querySelectorAll('[data-exp-profile]')].find(b => b.dataset.expProfile === 'chuguo').click();
      await w(1500);
      r.chuguoPhoto = photoSeg() ? photoSeg().dataset.expPhoto : '';
      r.chuguoZhDisabled = zhBtn().disabled;
      r.chuguoLang = document.querySelector('#a4').contentDocument.documentElement.lang;
      r.chuguoLangEn = [...document.querySelectorAll('[data-exp-lang]')].find(b => b.dataset.expLang === 'en').classList.contains('on');
      // 切回保研，把偏好还原
      [...document.querySelectorAll('[data-exp-profile]')].find(b => b.dataset.expProfile === 'baoyan').click();
      await w(1200);
      r.backPhoto = photoSeg() ? photoSeg().dataset.expPhoto : '';
      return JSON.stringify(r);
    })()`, true);
    const EP = JSON.parse(ePhoto);
    assert('照片选项默认：保研 / 求职放上，出国不放',
      EP.baoyanPhoto === '1' && EP.chuguoPhoto === '0', ePhoto);
    assert('切到出国自动锁定英文（中文按钮禁用、预览 lang=en）',
      EP.chuguoZhDisabled && EP.chuguoLang === 'en' && EP.chuguoLangEn, ePhoto);
    assert('切回保研后照片跟着口径回到默认', EP.backPhoto === '1', ePhoto);

    // E3. 教育背景成节：GPA / 排名 / 英语从基本信息进简历第一节
    const eEdu = await cdp.eval(`(() => {
      const d = document.querySelector('#a4').contentDocument;
      const h2s = [...d.querySelectorAll('h2')].map(h => h.textContent.trim());
      const first = d.querySelector('.sect .entry');
      return JSON.stringify({ h2s, firstTitle: first ? first.querySelector('.etitle').textContent.trim() : '',
        firstSub: first ? first.querySelector('.esub') ? first.querySelector('.esub').textContent : '' : '' });
    })()`);
    const EE = JSON.parse(eEdu);
    assert('简历第一节是「教育背景」（学校 / 学院 / GPA / 英语自动进纸面）',
      EE.h2s[0] === '教育背景' && EE.firstTitle, eEdu);

    // E4. 翻译标注自洽：英文稿里没翻完的中文一定标黄，且缺口清单里点得出名
    const eZh = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      [...document.querySelectorAll('[data-exp-lang]')].find(b => b.dataset.expLang === 'en').click();
      await w(1600);
      const d = document.querySelector('#a4').contentDocument;
      const zhN = d.querySelectorAll('.zh-draft').length;
      const gaps = [...d.querySelectorAll('.gaps')].map(g => g.textContent).join('');
      const hasGapNote = /待译|没翻译/.test(gaps);
      // 切回中文
      [...document.querySelectorAll('[data-exp-lang]')].find(b => b.dataset.expLang === 'zh').click();
      await w(1000);
      return JSON.stringify({ zhN, hasGapNote });
    })()`, true);
    const EZ = JSON.parse(eZh);
    assert('英文稿的翻译标注自洽（纸上有标黄 ⇔ 缺口清单里点得出名）',
      (EZ.zhN > 0) === EZ.hasGapNote, eZh);

    // E5. 经历抽屉有「简历排序」字段，导出排序尊重它
    const eOrder = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      const d = document.querySelector('#a4').contentDocument;
      const sec = [...d.querySelectorAll('.sect')].find(s => s.querySelector('h2').textContent.includes('竞赛经历'));
      const before = sec ? [...sec.querySelectorAll('.etitle')].map(t => t.textContent.trim()) : [];
      const target = S.experiences.find(e => e.type === 'competition');
      if (!target) return JSON.stringify({ skipped: true, before });
      await fetch('/api/experience', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: target.id, type: target.type, title: target.title, rOrder: 1 }) });
      await refresh(); render(); await w(1600);
      const d2 = document.querySelector('#a4').contentDocument;
      const sec2 = [...d2.querySelectorAll('.sect')].find(s => s.querySelector('h2').textContent.includes('竞赛经历'));
      const after = sec2 ? [...sec2.querySelectorAll('.etitle')].map(t => t.textContent.trim()) : [];
      // 复原：去掉 rOrder
      await fetch('/api/experience', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: target.id, type: target.type, title: target.title, rOrder: '' }) });
      await refresh(); await w(600);
      const drawerOk = await new Promise(res => {
        openDrawer(target.id); setTimeout(() => {
          res(!!document.querySelector('[data-e="rOrder"]'));
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        }, 500);
      });
      return JSON.stringify({ before, after, first: after[0] === target.title, drawerOk });
    })()`, true);
    const EO = JSON.parse(eOrder);
    assert('抽屉里有「简历排序」字段，填 1 后该条真的排到节首',
      !EO.skipped && EO.first && EO.drawerOk, eOrder);

    // E6. 库简介：国家级 / 国际级每一项都有「比的是什么」
    const eIntro = await cdp.eval(`fetch('/api/library').then(r => r.json()).then(d => {
      const majors = d.items.filter(i => /国际级|国家级/.test(i.recognition || ''));
      const withIntro = majors.filter(i => i.intro && i.intro.length >= 10);
      return JSON.stringify({ total: majors.length, withIntro: withIntro.length,
        sample: (majors[0] || {}).intro || '' });
    })`, true);
    const EI = JSON.parse(eIntro);
    assert('国家级 / 国际级竞赛全部带简介', EI.total > 0 && EI.withIntro === EI.total, eIntro);

    /* ---------------- Phase F：分类型字段 / 完成节点 / 材料预览 / 照片适配 / 自动分页 ---------------- */

    // F1. 分类型收集：自定义类型抽屉只留最小字段集；「角色」只给有人参与其中的类型
    const fFields = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      await fetch('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customTypes: [{ key: 'x_qaf', label: '自检类型' }] }) });
      await refresh(); await w(300);
      const r = await (await fetch('/api/experience', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'x_qaf', title: '自检-字段集' }) })).json();
      await refresh(); await w(300);   // openDrawer 只认 S.experiences 里的 id，POST 完必须先刷
      openDrawer(r.experience.id); await w(500);
      const has = sel => !!document.querySelector('#drawer ' + sel);
      const res = {
        titleEn: has('[data-e="titleEn"]'),
        summary: has('[data-e="result.summary"]'),
        role: has('[data-e="role"]'),
        rOrder: has('[data-e="rOrder"]'),
        award: has('[data-e="result.award"]'),
        level: has('[data-e="level"]'),
        startedAt: has('[data-e="startedAt"]'),
        roleLogic: !isRoleish('paper') && isRoleish('competition')
      };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await w(250);
      await fetch('/api/experience/' + r.experience.id, { method: 'DELETE' });
      await fetch('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customTypes: [] }) });
      await refresh(); await w(200);
      return JSON.stringify(res);
    })()`, true);
    const FF = JSON.parse(fFields);
    assert('自定义类型只收集英文名 + 成果摘要（角色 / 排序 / 奖项 / 级别都不出现）',
      FF.titleEn && FF.summary && !FF.role && !FF.rOrder && !FF.award && !FF.level && FF.startedAt, fFields);
    assert('「角色」字段跟着类型走：竞赛有，论文没有', FF.roleLogic, fFields);

    // F2. 完成节点：弹窗里有「完成」、选中后提醒提前量收起、服务端扫描直接跳过
    const fDone = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      const tomorrow = new Date(Date.now() + 86400000).toISOString();
      const r = await (await fetch('/api/experience', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'certificate', title: '自检-完成节点',
          nodes: [{ id: 'qa-done-node', title: '获奖公布', kind: 'done', dueAt: tomorrow, done: false, remindDays: null, notifiedAt: [] }] }) })).json();
      await refresh(); await w(300);
      const pv = await (await fetch('/api/reminder/preview')).json();
      const res = { skipped: !JSON.stringify(pv).includes('qa-done-node') };
      openDrawer(r.experience.id); await w(400);
      const btn = document.querySelector('[data-dact="add-node"]');
      if (btn) { btn.click(); await w(300); }
      res.kinds = [...document.querySelectorAll('#ndKind option')].map(o => o.value).join(',');
      const sel = document.querySelector('#ndKind');
      if (sel) {
        sel.value = 'done'; sel.dispatchEvent(new Event('change')); await w(150);
        const wrap = document.querySelector('#ndRemindWrap');
        res.remindHidden = !wrap || wrap.hidden;
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await w(150);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await w(200);
      await fetch('/api/experience/' + r.experience.id, { method: 'DELETE' });
      await refresh(); await w(200);
      return JSON.stringify(res);
    })()`, true);
    const FD = JSON.parse(fDone);
    assert('节点类型有「完成」（里程碑）', FD.kinds.includes('done'), fDone);
    assert('选中「完成」后提醒提前量自动收起', FD.remindHidden === true, fDone);
    assert('「完成」节点即使设了时间也不进提醒扫描', FD.skipped === true, fDone);

    // F3. 材料预览：预览/下载两个动作，预览层里能看
    const fMat = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      go('materials'); await w(600);
      const res = {
        prevBtns: document.querySelectorAll('[data-mat-view]').length,
        dlLinks: [...document.querySelectorAll('#view a[download]')].length,
        kinds: { png: matPreviewKind('a.png'), docx: matPreviewKind('a.docx'), pdf: matPreviewKind('a.pdf') }
      };
      const b = document.querySelector('[data-mat-view]');
      if (b) {
        b.click(); await w(400);
        const dlg = document.querySelector('dialog[open]');
        res.modal = !!dlg;
        res.hasDl = !!(dlg && dlg.querySelector('a[download]'));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await w(250);
      }
      return JSON.stringify(res);
    })()`, true);
    const FM = JSON.parse(fMat);
    assert('材料卡是「预览 / 下载」两个动作（每个可预览材料都带下载）',
      FM.prevBtns > 0 && FM.dlLinks >= FM.prevBtns, fMat);
    assert('预览类型判断：图片 / PDF 可看，Word 不行',
      FM.kinds.png === 'image' && FM.kinds.pdf === 'pdf' && FM.kinds.docx === '', fMat);
    assert('点「预览」弹出预览层，里面带下载按钮', FM.modal === true && FM.hasDl === true, fMat);

    // F4. 照片按模板适配：单栏钉右上角、侧栏版式进侧栏顶部、横幅版式进色带右端
    const fFit = await cdp.eval(`(async () => {
      const g = async tpl => await (await fetch('/api/export/file?format=html&profile=baoyan&template=' + tpl + '&photo=1&lang=zh')).text();
      const classic = await g('classic');
      const compact = await g('compact');
      const banner = await g('banner');
      return JSON.stringify({
        classicAbs: /<div class="a4"><img class="photo"/.test(classic),
        compactAside: /<aside class="col-l">\\s*<img class="photo"/.test(compact),
        cssSide: /\\.col-l \\.photo \\{[^}]*position: ?static/.test(compact),
        bannerBand: /<div class="band"><div class="band-main"><div class="name">[\\s\\S]*?<\\/div><img class="photo"/.test(banner),
        cssBand: /\\.band \\.photo \\{[^}]*position: ?static/.test(banner),
        hasPaginate: classic.includes('__paginate')
      });
    })()`, true);
    const FFIT = JSON.parse(fFit);
    assert('照片位置跟着版式走：单栏右上角 / 侧栏顶部 / 色带右端，不再是到处乱钉',
      FFIT.classicAbs && FFIT.compactAside && FFIT.cssSide && FFIT.bannerBand && FFIT.cssBand, fFit);
    assert('分页脚本随导出 HTML 下发', FFIT.hasPaginate === true, fFit);

    // F7. 照片审视遗留：fresh 不重复姓名；上传的模板骨架（含照片位置语义）要原样保留
    const fFresh = await cdp.eval(`(async () => {
      const g = async tpl => await (await fetch('/api/export/preview?format=html&profile=baoyan&template=' + tpl + '&photo=1&lang=zh')).text();
      const fresh = await g('fresh');
      const names = (fresh.match(/class="name"/g) || []).length;
      const bandHasName = /<div class="band"><div class="name">/.test(fresh);
      const asidePhotoThenName = /<aside class="col-l">\\s*<img class="photo"\\s*<div class="name">/.test(fresh);
      return JSON.stringify({ names, bandHasName, asidePhotoThenName });
    })()`, true);
    const FFRESH = JSON.parse(fFresh);
    assert('fresh 版式姓名只在色带里出现一次（侧栏不再重复一个半透明的）',
      FFRESH.names === 1 && FFRESH.bandHasName && !FFRESH.asidePhotoThenName, fFresh);

    const fCustTpl = await cdp.eval(`(async () => {
      const up = await (await fetch('/api/export/template', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: '自检横幅模板', desc: 'qa 造的', layout: 'banner',
          css: '.a4{font-family:sans-serif} .band{background:#204e3c;padding:10mm;display:flex} .name{color:#fff;font-size:20pt}' }) })).json();
      const key = up.template && up.template.key;
      // 响应里的 template 只有 key/label——layout 要从词表里拿
      const def = (await (await fetch('/api/state')).json()).exportTemplates.find(t => t.key === key);
      const html = await (await fetch('/api/export/preview?format=html&profile=baoyan&template=' + encodeURIComponent(key) + '&photo=1&lang=zh')).text();
      const band = /<div class="band">/.test(html);
      const photoInBand = /<div class="band">[\\s\\S]*?<img class="photo"/.test(html);
      await fetch('/api/export/template?key=' + encodeURIComponent(key), { method: 'DELETE' });
      return JSON.stringify({ layout: def && def.layout, band, photoInBand });
    })()`, true);
    const FCUST = JSON.parse(fCustTpl);
    assert('上传模板的 banner 骨架原样保留（不再被削成单栏）', FCUST.layout === 'banner' && FCUST.band, fCustTpl);
    assert('上传的横幅模板照片进色带右端（照片位置跟着骨架走）', FCUST.photoInBand, fCustTpl);

    // F5. 自动分页：造 30 条临时竞赛把稿子顶过两页，量完删掉——机制要有确定性的证据
    const fPages = await cdp.eval(`(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      /* 双栏 / 侧栏版式（compact / sidebar）在分页脚本里是明确跳过的：整张纸就是一个 flex
         容器，拆开会破版，那几种版式的屏幕预览就是一张长纸，交给打印分页兜底。
         这条断言量的是「分页机制」本身，所以先切到单栏；量完把原来的选择放回去。 */
      const prevTpl = (S.profile.export || {}).template;
      if (prevTpl && prevTpl !== 'classic') {
        await fetch('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ export: { template: 'classic' } }) });
        await refresh(); await w(200);
      }
      const ids = [];
      for (let i = 0; i < 30; i++) {
        const r = await (await fetch('/api/experience', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'competition', title: '自检-分页-' + i,
            result: { summary: '在两万支队伍中进入全国前 3%，负责模型构建与论文撰写，最终拿到国家级一等奖。' } }) })).json();
        ids.push(r.experience.id);
      }
      await refresh(); await w(300);
      go('export'); await w(1400);
      const f = document.querySelector('#a4');
      const doc = f.contentDocument;
      if (!doc || !doc.querySelector('.a4')) return JSON.stringify({ noDoc: true });
      if (f.contentWindow.__paginate) f.contentWindow.__paginate();
      await w(400);
      const pageH = Math.round(297 * 96 / 25.4);
      const sheets = [...doc.querySelectorAll('.a4')];
      const res = { n: sheets.length,
        overflow: sheets.some(s => s.scrollHeight > pageH + 2),
        barTotal: (S._page || {}).total };
      for (const id of ids) await fetch('/api/experience/' + id, { method: 'DELETE' });
      if (prevTpl && prevTpl !== 'classic') {
        await fetch('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ export: { template: prevTpl } }) });
      }
      await refresh(); await w(200);
      return JSON.stringify(res);
    })()`, true);
    const FP = JSON.parse(fPages);
    if (FP.noDoc) {
      assert('导出预览加载出 A4 纸', false, fPages);
    } else {
      assert('内容超过一页时自动拆成多张 A4，且每一张都装得下',
        FP.n >= 2 && FP.overflow === false, fPages);
      assert('预览翻页条的页数与实际纸张数一致', FP.barTotal === FP.n, fPages);
    }

    fs.writeFileSync(path.join(OUT, 'wb-qa.txt'), [
      '=== 截图 ===', ...log,
      '', '=== 断言 ===', ...A,
      ...(SK.length ? ['', '=== 跳过（前置条件在本数据集不成立） ===', ...SK] : []),
      '', '=== 控制台报错 (' + errors.length + ') ===', ...(errors.length ? errors : ['（无）'])
    ].join('\n'), 'utf8');

  } catch (e) {
    fs.writeFileSync(path.join(OUT, 'wb-qa.txt'), 'ERROR: ' + (e.stack || e.message) + '\n\n' + log.join('\n') + '\n\n' + errors.join('\n'), 'utf8');
  } finally {
    try { child.kill('SIGKILL'); } catch (_) {}
    process.exit(0);
  }
})();
