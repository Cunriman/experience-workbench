'use strict';
/**
 * 经历工作台 · 本地小服务
 * 只监听 127.0.0.1，不对外暴露。数据全部在你自己的硬盘上。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const store = require('./src/store');
const library = require('./src/library');
const reminder = require('./src/reminder');
const exporter = require('./src/export');
const demo = require('./src/demo');
const taxonomy = require('./src/taxonomy');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const EXPORT_DIR = path.join(store.DATA_DIR, 'exports');
fs.mkdirSync(EXPORT_DIR, { recursive: true });

const HOST = '127.0.0.1';
let PORT = Number(process.env.PORT || 8777);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.md': 'text/markdown; charset=utf-8',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8'
};

const MAX_BODY = 64 * 1024 * 1024;

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('内容过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function serveFile(res, filePath, downloadName) {
  if (!filePath || !fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
  const ext = path.extname(filePath).toLowerCase();
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
  if (downloadName) {
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  } else {
    // 这是本机小工具，样式和脚本随时会改；不缓存，省得改了 CSS 刷新还看到旧的
    headers['Cache-Control'] = 'no-store, must-revalidate';
    headers['Pragma'] = 'no-cache';
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

/**
 * 导出页的参数走查询串而不是 JSON——因为预览是一个 iframe 的 src，
 * 下载是 <a download>，两者都没法带请求体。
 */
function exportOptsFromQuery(query) {
  const q = query || {};
  const types = q.types ? String(q.types).split(',').map(s => s.trim()).filter(Boolean) : null;
  const ids = q.ids ? String(q.ids).split(',').map(s => s.trim()).filter(Boolean) : null;
  return {
    profile: q.profile ? String(q.profile) : undefined,
    template: q.template ? String(q.template) : undefined,
    lang: q.lang ? String(q.lang) : undefined,
    photo: q.photo === '1',
    includeTypes: types && types.length ? types : undefined,
    includeIds: ids && ids.length ? ids : undefined
  };
}

/* ---------------- API ---------------- */

async function handleApi(req, res, pathname, query) {
  const method = req.method.toUpperCase();

  if (pathname === '/api/state' && method === 'GET') {
    const pv = reminder.preview();
    const prof = store.getProfile();
    return json(res, 200, {
      profile: prof,
      // 经历类型词表：内置 10 类 + 用户自定义。前端不再自己写一份，
      // 免得加一类要改两处还容易漏。
      taxonomy: taxonomy.buildTaxonomy(prof.customTypes),
      experiences: store.listExperiences(false),
      deleted: store.listExperiences(true).filter(e => e.deletedAt).map(e => ({ id: e.id, title: e.title, deletedAt: e.deletedAt })),
      library: (() => { const l = library.listLibrary(); return { libVersion: l.libVersion, dataAsOf: l.dataAsOf, count: l.count, majorTags: l.majorTags, majorCatalog: l.majorCatalog, source: l.source, caution: l.caution, tierNote: l.tierNote, recognitionSource: l.recognitionSource, recognitionNote: l.recognitionNote, recognitions: l.recognitions }; })(),
      stats: store.stats(),
      reminder: { preview: pv.digest.count, overdue: pv.overdue.length, smtpReady: pv.smtpReady, nodemailerReady: pv.nodemailerReady },
      exportProfiles: Object.entries(exporter.PROFILES).map(([k, v]) => ({ key: k, label: v.label, desc: v.desc })),
      exportTemplates: exporter.listTemplates().map(t => ({
        key: t.key, label: t.label, desc: t.desc, credit: t.credit,
        layout: t.layout, thumb: t.thumb, custom: !!t.custom
      })),
      demoLoaded: store.listExperiences(false).some(e => String(e.id).startsWith(demo.MARK)),
      now: new Date().toISOString()
    });
  }

  if (pathname === '/api/demo/load' && method === 'POST') {
    const n = demo.load();
    return json(res, 200, { ok: true, created: n, experiences: store.listExperiences(false) });
  }

  if (pathname === '/api/demo/clear' && method === 'POST') {
    const n = demo.clear();
    return json(res, 200, { ok: true, removed: n, experiences: store.listExperiences(false) });
  }

  if (pathname === '/api/profile' && method === 'PUT') {
    const body = await readBody(req);
    // 专业变了就顺手把「方向标签」重算一遍。放在服务端算，前端不用重复实现
    // 匹配逻辑；将来手机端改专业也走同一条路。
    if (Array.isArray(body.majors)) {
      body.majors = body.majors.map(s => String(s).trim()).filter(Boolean).slice(0, 8);
      body.majorTags = library.tracksForMajors(body.majors);
    }
    if (Array.isArray(body.customTypes)) {
      const seen = new Set();
      body.customTypes = body.customTypes
        .map(t => (typeof t === 'string' ? { label: t } : t))
        .filter(t => t && String(t.label || '').trim())
        // 合法的 x_ key 原样保留（外部脚本 PUT 全量列表时 key 要稳，不然已录经历的 type 会失联）；
        // 只有没给 key 或 key 不合法的才按名称现生成——与 buildTaxonomy 的取 key 逻辑保持一致。
        .map(t => ({
          key: t.key && taxonomy.isCustom(t.key) ? t.key : taxonomy.customKey(t.label),
          label: String(t.label).trim().slice(0, 12)
        }))
        .filter(t => {
          if (seen.has(t.key)) return false;
          seen.add(t.key);
          return true;
        })
        .slice(0, 12);
    }
    return json(res, 200, { profile: store.saveProfile(body) });
  }

  if (pathname === '/api/experience' && method === 'POST') {
    const body = await readBody(req);
    if (!body.title || !String(body.title).trim()) return json(res, 400, { error: '名称不能为空' });
    return json(res, 200, { experience: store.upsertExperience(body) });
  }

  let m = pathname.match(/^\/api\/experience\/([\w-]+)(\/restore)?$/);
  if (m) {
    const id = m[1];
    if (method === 'DELETE') {
      const e = store.softDeleteExperience(id);
      return e ? json(res, 200, { ok: true, id }) : json(res, 404, { error: '找不到这条经历' });
    }
    if (method === 'POST' && m[2]) {
      const e = store.restoreExperience(id);
      return e ? json(res, 200, { ok: true, id }) : json(res, 404, { error: '找不到这条经历' });
    }
  }

  if (pathname === '/api/attachment' && method === 'POST') {
    const body = await readBody(req);
    if (!body.base64) return json(res, 400, { error: '缺少文件内容' });
    const file = store.saveAttachment(body.name || 'file', body.base64);
    return json(res, 200, { file, name: body.name || file });
  }

  if (pathname === '/api/library' && method === 'GET') {
    const l = library.listLibrary();
    if (query.q) {
      const q = String(query.q).toLowerCase();
      l.items = l.items.filter(i => (i.name + i.short + i.category + (i.recognition || '') + (i.majorTags || []).join('')).toLowerCase().includes(q));
    }
    if (query.recog) {
      const r = String(query.recog);
      l.items = l.items.filter(i => (i.recognition || '未认定') === r);
    }
    l.matched = l.items.length;      // 库内总数仍是 count，筛选命中数单独给
    return json(res, 200, l);
  }

  if (pathname === '/api/library/recommend' && method === 'GET') {
    const profile = store.getProfile();
    const majors = query.majors ? String(query.majors).split(',').filter(Boolean) : profile.majors;
    return json(res, 200, { items: library.recommend({ ...profile, majors }, { limit: Number(query.limit || 30) }) });
  }

  if (pathname === '/api/library/instantiate' && method === 'POST') {
    const body = await readBody(req);
    const lib = library.getLibrary();
    const item = lib.items.find(i => i.id === body.id);
    if (!item) return json(res, 404, { error: '库里没有这条竞赛' });
    const already = store.listExperiences(false).some(e => e.fromLibrary && e.fromLibrary.id === item.id);
    const exp = store.upsertExperience(library.instantiate(item, body.extra || {}));
    return json(res, 200, { experience: exp, already });
  }

  if (pathname === '/api/library/import' && method === 'POST') {
    const body = await readBody(req);
    try {
      const result = library.importPackage(body.package || body);
      return json(res, 200, result);
    } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  }

  // 手动加一条竞赛：中文名必填，英文名 / 网址可选（英文简历的标题用英文名）
  if (pathname === '/api/library/custom' && method === 'POST') {
    const body = await readBody(req);
    try {
      const item = library.addCustom(body || {});
      return json(res, 200, { item });
    } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  }

  // 删掉自己加的竞赛（内置竞赛不许删——那是骨架数据）
  if (pathname === '/api/library/custom' && method === 'DELETE') {
    try {
      return json(res, 200, library.removeCustom(String(query.id || '')));
    } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  }

  if (pathname === '/api/library/reset' && method === 'POST') {
    library.resetLibrary();
    return json(res, 200, { ok: true, library: library.listLibrary() });
  }

  if (pathname === '/api/reminder/preview' && method === 'GET') {
    return json(res, 200, reminder.preview());
  }

  if (pathname === '/api/reminder/run' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const r = await reminder.run({ skipNotify: !!body.skipNotify });
    return json(res, 200, r);
  }

  if (pathname === '/api/majors/search' && method === 'GET') {
    const items = library.searchMajors(query.q, Number(query.limit || 8));
    const tags = [];
    for (const it of items) for (const t of it.tracks || []) if (!tags.includes(t)) tags.push(t);
    return json(res, 200, {
      q: String(query.q || ''),
      catalog: library.listLibrary().majorCatalog,
      items,
      tags,
      // 库里到底有没有对口的竞赛——没有就直说，别装作推荐得很准
      coverage: tags.length ? library.majorCoverage(tags) : null
    });
  }

  // 已选专业的方向标签能对上库里多少竞赛。设置页用它说一句实话：
  // 有些专业这库里确实没有对口赛事，与其装作推荐得很准，不如直接讲清楚。
  if (pathname === '/api/majors/coverage' && method === 'GET') {
    const tags = query.tags ? String(query.tags).split(',').map(s => s.trim()).filter(Boolean) : [];
    return json(res, 200, { tags, coverage: tags.length ? library.majorCoverage(tags) : null });
  }

  /* 预览是一份独立的、已经排好版的 A4 文档，用 iframe 加载：
     ① 版式 CSS 不会漏进主界面（不用给几百行 CSS 加作用域前缀）
     ② 它本身就是 A4 尺寸，所见即所得
     ③ 点「导出 PDF」时直接 iframe.contentWindow.print()，
        不用弹新窗口，也不怕被浏览器拦截 */
  if (pathname === '/api/export/preview' && method === 'GET') {
    // preview:true 才会带上「还差这些」清单——它排在纸外面，打印时自动消失。
    // 下载的文件走的是不带 preview 的那条路，纸上和正文里都不会有提示语。
    const opts = Object.assign(exportOptsFromQuery(query), { preview: true });
    // Markdown 的预览就是它本身：等宽字体原样展示，所见即所得（不套任何版式）
    if (String(query.format || '') === 'md') {
      const out = exporter.build(opts);
      const md = out.markdown.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>Markdown</title><style>
body{margin:0;background:#f2f2ef;font:400 11pt/1.7 "Cascadia Mono","Consolas","Courier New",monospace;color:#1b1b19}
pre{white-space:pre-wrap;margin:0 auto;max-width:210mm;padding:14mm 15mm;background:#fff;min-height:297mm}
</style></head><body><pre>${md}</pre></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    const out = exporter.build(opts);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(out.html);
  }

  if (pathname === '/api/export/file' && method === 'GET') {
    const fmt = String(query.format || 'html');
    const out = exporter.build(exportOptsFromQuery(query));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const safeName = String(out.name).replace(/[\\/:*?"<>|]/g, '').slice(0, 24) || '简历';
    const base = `${safeName}-${out.label}-${stamp}`;
    fs.mkdirSync(EXPORT_DIR, { recursive: true });

    if (fmt === 'docx') {
      const buf = exporter.buildDocx(out);
      const file = path.join(EXPORT_DIR, base + '.docx');
      fs.writeFileSync(file, buf);
      store.appendLog({ op: 'export.save', title: base, note: 'docx ' + buf.length + 'B' });
      return serveFile(res, file, base + '.docx');
    }
    if (fmt === 'md') {
      const file = path.join(EXPORT_DIR, base + '.md');
      fs.writeFileSync(file, out.markdown, 'utf8');
      store.appendLog({ op: 'export.save', title: base, note: 'markdown' });
      return serveFile(res, file, base + '.md');
    }
    const file = path.join(EXPORT_DIR, base + '.html');
    fs.writeFileSync(file, out.html, 'utf8');
    store.appendLog({ op: 'export.save', title: base, note: 'html' });
    return serveFile(res, file, base + '.html');
  }

  /* 自定义模板：上传（POST）/ 删除（DELETE）。模板本体是一份 JSON（元信息 + css），
     作用在导出渲染器固有的骨架上；样例走 template-sample 下载。 */
  if (pathname === '/api/export/template' && method === 'POST') {
    const body = await readBody(req);
    try {
      const t = exporter.upsertCustomTemplate(body);
      store.appendLog({ op: 'template.upsert', title: t.label, note: t.key });
      return json(res, 200, { ok: true, template: { key: t.key, label: t.label, custom: true }, templates: exporter.listTemplates() });
    } catch (e) {
      return json(res, 400, { error: String(e.message || e) });
    }
  }
  if (pathname === '/api/export/template' && method === 'DELETE') {
    const key = String(query.key || '');
    const ok = exporter.deleteCustomTemplate(key);
    return ok ? json(res, 200, { ok: true, templates: exporter.listTemplates() })
      : json(res, 404, { error: '没有这个上传的模板' });
  }
  if (pathname === '/api/export/template-sample' && method === 'GET') {
    const sample = exporter.sampleTemplate();
    const file = path.join(EXPORT_DIR, '模板样例.json');
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(sample, null, 2), 'utf8');
    return serveFile(res, file, '模板样例.json');
  }

  // 给导出页用的轻量摘要（真正的排版结果走上面两个接口，不走 JSON）
  if (pathname === '/api/export' && method === 'POST') {
    const out = exporter.build(await readBody(req));
    return json(res, 200, {
      profile: out.profileKey, label: out.label, template: out.template,
      templateLabel: out.templateMeta.label, count: out.count,
      sections: out.sections.map(s => ({ name: s.name, count: s.entries.length })),
      generatedAt: out.generatedAt
    });
  }

  if (pathname === '/api/changelog' && method === 'GET') {
    // 原始日志仍全量保留在 data/changelog.jsonl；这里返回折叠过的摘要，避免自动保存刷屏
    return json(res, 200, {
      items: store.recentChanges(500, 10 * 60 * 1000).slice(0, 60),
      rawCount: store.readChangelog(Infinity).length
    });
  }

  return json(res, 404, { error: '未知接口 ' + pathname });
}

/* ---------------- 服务器 ---------------- */

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);

  try {
    if (pathname.startsWith('/api/')) {
      return await handleApi(req, res, pathname, parsed.query);
    }

    if (pathname.startsWith('/attachment/')) {
      const name = pathname.replace('/attachment/', '');
      return serveFile(res, store.attachmentPath(name), parsed.query.download ? name : null);
    }

    if (pathname === '/' || pathname === '/index.html') {
      return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }

    const safe = path.normalize(pathname).replace(/^([/\\])+/, '');
    const target = path.join(PUBLIC_DIR, safe);
    if (!target.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
    return serveFile(res, target);
  } catch (e) {
    console.error('[server]', e);
    json(res, 500, { error: String(e.message || e) });
  }
});

let booted = false;
function boot(actualPort) {
  // 防御：无论 listen 重试了几次，横幅和调度器都只能跑一次
  if (booted) return;
  booted = true;
  PORT = actualPort;
  const p = store.getProfile();
  console.log('');
  console.log('  经历工作台已启动');
  console.log('  ──────────────────────────────────────');
  console.log(`  地址：http://${HOST}:${PORT}`);
  console.log(`  数据：${store.DATA_DIR}`);
  console.log(`  专业：${(p.majors || []).join(' / ') || '尚未设置（到「设置」里选）'}`);
  console.log(`  提醒：每天 ${p.remind.time}　提前 ${(p.remind.days || []).join('/')} 天　渠道 ${(p.remind.channels || []).join('+')}`);
  console.log('  关闭此窗口即停止服务（数据不会丢）');
  console.log('');
  reminder.startScheduler();
  setTimeout(() => { reminder.catchUpOnBoot().catch(() => {}); }, 3000);
}

function listen(port, attempt) {
  attempt = attempt || 0;
  const onListening = () => {
    server.removeListener('error', onError);
    boot(server.address().port);   // 用真实绑定到的端口，别用闭包里的
  };
  /* 关键：端口占用时，上一次注册的 listening 回调必须显式摘掉。
     否则重试成功后两个回调会一起触发——横幅打两遍、
     调度器起两个、开机补发跑两次（会重复提醒）。 */
  const onError = err => {
    server.removeListener('listening', onListening);
    if (err.code === 'EADDRINUSE' && attempt < 10) {
      console.log(`端口 ${port} 被占用，换 ${port + 1} 试试…`);
      listen(port + 1, attempt + 1);
    } else {
      console.error('启动失败：', err.message);
      process.exit(1);
    }
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, HOST);
}

listen(PORT);

process.on('SIGINT', () => { console.log('\n已停止。'); process.exit(0); });
