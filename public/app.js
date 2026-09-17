'use strict';
/* =============================================================================
   经历工作台 · 前端
   零构建、零依赖。数据全部来自本机小服务，不经过任何第三方。
   结构：工具 → 启动 → 视图 → 事件 → 抽屉 → 模态 → 杂项
   ============================================================================= */

const S = {
  profile: null,
  experiences: [],
  library: null,
  stats: null,
  exportProfiles: [],
  exportTemplates: [],
  taxonomy: [],
  view: 'overview',
  mode: { archive: 'kanban', schedule: 'upcoming', materials: 'all' },
  filter: { q: '', type: '', stage: '', matq: '' },
  _expFmt: 'pdf',            // 导出页当前选中的格式（pdf/docx/html/md），只影响预览和下载按钮
  _expIds: null,             // 导出时包含哪些经历（细到条）；null = 全都要
  _tplZoom: null,            // 预览缩放控制器 {v, auto, fit(), apply()}，bindPreviewZoom 里建
  _page: null,               // 预览分页状态 {n, total}，syncExportPreview 里建
  _recs: [],
  _lastView: null
};

const STAGES = ['筹备中', '进行中', '已提交', '已出结果', '已复盘'];

/* 经历类型词表由服务端下发（内置 9 类 + 用户自定义，唯一真源在 src/taxonomy.js）。
   以前前端自己写一份 TYPE_LABEL，加一类要改两处、还漏过，所以现在只保留一个同步过来的映射。 */
const TYPE_LABEL = {};
let TYPE_LIST = [];

function applyTaxonomy(list) {
  // 两处都要写：S.taxonomy 给视图渲染用，TYPE_LIST 给各处按 key 反查用。
  // 曾经只写了 TYPE_LIST，结果导出页的「包含内容」按 S.taxonomy 遍历，
  // 列表永远是空的——筛选、导出范围全失效。这里保持同一个数组引用，不会走岔。
  S.taxonomy = Array.isArray(list) && list.length ? list : [];
  TYPE_LIST = S.taxonomy;
  for (const k of Object.keys(TYPE_LABEL)) delete TYPE_LABEL[k];
  for (const t of TYPE_LIST) TYPE_LABEL[t.key] = t.label;
}

function typeDef(key) { return TYPE_LIST.find(t => t.key === key) || null; }
function typeLabel(key) { return TYPE_LABEL[key] || key || '其他'; }
function fieldsOf(key) { const d = typeDef(key); return (d && d.fields) || []; }

/** 类型图标走 index.html 里的 SVG 精灵；认不出来的 id 一律退回通用标签图标 */
const ICON_SET = new Set(['ic-trophy', 'ic-board', 'ic-doc', 'ic-bulb', 'ic-medal', 'ic-people',
  'ic-briefcase', 'ic-heart', 'ic-badge', 'ic-tag']);
function typeIcon(key) {
  const d = typeDef(key);
  const id = d && ICON_SET.has(d.icon) ? d.icon : 'ic-tag';
  return `<svg class="ic" aria-hidden="true"><use href="#${id}"/></svg>`;
}
/** 除了竞赛/奖项这类「有对抗性名次」的，其余类型不该被问「你第几名」 */
const AWARDISH = ['competition', 'award', 'project', 'paper', 'patent', 'internship'];
function isAwardish(key) { return AWARDISH.includes(key); }
/** 「角色」只在有人参与其中时才问得出：论文有作者次序、专利有申请人、证书有发证机构，都不用这个 */
const ROLEISH = ['competition', 'project', 'student_work', 'internship', 'volunteer'];
function isRoleish(key) { return ROLEISH.includes(key); }
function isCustomType(key) { const d = typeDef(key); return !!(d && d.custom); }

const KIND_LABEL = { deadline: '截止', submit: '提交', defense: '答辩', result: '出结果', reminder: '提醒', done: '完成' };
const MAT_KIND = { cert: '证书', work: '作品', form: '报名表', doc: '说明书', other: '其他' };

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

/* =============================== 工具 =============================== */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** 只填了日期（没填时分）时，不要把 00:00 当作一个信息展示出来 */
function hasClock(d) { return d.getHours() !== 0 || d.getMinutes() !== 0; }

function fmt(iso, withTime) {
  const d = toDate(iso);
  if (!d) return iso ? String(iso) : '';
  const p = n => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  if (!withTime) return base;
  return hasClock(d) ? `${base} ${p(d.getHours())}:${p(d.getMinutes())}` : base;
}

function fmtShort(iso) {
  const d = toDate(iso);
  if (!d) return '—';
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
function weekdayOf(iso) { const d = toDate(iso); return d ? '周' + WEEK[d.getDay()] : ''; }

function fromLocalInput(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : v;
}

function toLocalInput(iso) {
  const d = toDate(iso);
  if (!d) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 距今天数（向上取整）。今天=0，逾期<0 */
function dl(iso) {
  const d = toDate(iso);
  if (!d) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86400000);
}

/** 剩余天数的统一说法 */
function dlText(d) {
  if (d === null) return '';
  if (d < 0) return `已逾期 ${-d} 天`;
  if (d === 0) return '今天截止';
  if (d === 1) return '明天截止';
  return `${d} 天后`;
}

/** 紧急程度：hot(逾期/今天) warm(3 天内) later(7 天内) '' */
function urgency(d) {
  if (d === null) return '';
  if (d <= 0) return 'hot';
  if (d <= 3) return 'warm';
  if (d <= 7) return 'later';
  return '';
}

function nodeState(n) {
  if (n.done) return 'done';
  // 「完成」类节点是里程碑（如获奖公布），不是要赶的截止——不参与紧急程度
  if (n.kind === 'done') return '';
  if (!n.dueAt) return '';
  const d = dl(n.dueAt);
  if (d === null) return '';
  if (d <= 0) return 'now';
  if (d <= 3) return 'soon';
  return '';
}

function nextNode(exp) {
  const list = (exp.nodes || []).filter(n => !n.done && n.dueAt)
    .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
  const t = Date.now() - 86400000;
  return list.find(n => new Date(n.dueAt).getTime() >= t) || list[0] || null;
}

function allPendingNodes(winDays) {
  const out = [];
  const limit = Date.now() + (winDays == null ? 30 : winDays) * 86400000;
  for (const e of S.experiences) {
    for (const n of e.nodes || []) {
      if (n.done || !n.dueAt) continue;
      const t = new Date(n.dueAt).getTime();
      if (!Number.isFinite(t) || t > limit) continue;
      out.push({ exp: e, node: n, t });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

function stageIndex(st) { const i = STAGES.indexOf(st); return i < 0 ? 0 : i; }

/** 阶段刻度条：已经走过的 + 当前 */
function meter(stage, cls) {
  const i = stageIndex(stage);
  return `<div class="meter ${cls || ''}">${STAGES.map((_, k) =>
    `<i class="${k < i ? 'done' : k === i ? 'now' : ''}"></i>`).join('')}</div>`;
}

/** 导出就绪度：把"该补什么"变成看得见的数字 */
function readiness() {
  const list = S.experiences;
  const dims = [
    { key: 'level', label: '级别没填', test: e => !!e.level },
    { key: 'summary', label: '成果摘要没写', test: e => !!(e.result && e.result.summary) },
    { key: 'materials', label: '没有附任何材料', test: e => (e.materials || []).length > 0 },
    { key: 'retro', label: '还没做过复盘', test: e => !!(e.retro && (e.retro.good || e.retro.bad || e.retro.reuse)) }
  ];
  if (!list.length) return { pct: 0, gaps: [], total: 0, readyList: [] };
  let hit = 0;
  const gaps = dims.map(d => ({ label: d.label, n: list.filter(e => !d.test(e)).length }));
  for (const e of list) for (const d of dims) if (d.test(e)) hit++;
  return {
    pct: Math.round(hit / (list.length * dims.length) * 100),
    gaps: gaps.filter(g => g.n > 0).sort((a, b) => b.n - a.n),
    total: list.length,
    // 四项全占的才算「就绪」——这样的成果已经可以直接排进简历里
    readyList: list.filter(e => dims.every(d => d.test(e)))
  };
}

function toast(msg, type) {
  const el = document.createElement('div');
  const icon = type === 'bad' ? 'ic-close' : type === 'warn' ? 'ic-dot' : 'ic-check';
  el.className = 'toast ' + (type === true ? 'bad' : type || 'ok');
  el.innerHTML = `<span class="ic ${icon}"></span><span>${esc(msg)}</span>`;
  const box = toastBox();
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 260);
  }, 2400);
}

/* 原生 <dialog> 弹出时处在浏览器「顶层」，比任何 z-index 都高——
   toast 如果只挂在 body 上，模态开着时（比如「名称不能为空」）就永远看不见。
   模态开着时把 toast 挂进 dialog 里面，跟它同一层才能露出来。 */
function toastBox() {
  const m = $('#modal');
  if (m && m.open) {
    let b = m.querySelector('.toasts');
    if (!b) { b = document.createElement('div'); b.className = 'toasts'; m.appendChild(b); }
    return b;
  }
  return $('#toasts');
}

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('请求失败 ' + res.status));
  return data;
}

function debounce(fn, ms) {
  let t = null;
  return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
}

/* =============================== 启动 =============================== */

/* 设置拆成两处：导航里的「设置」管提醒 / 竞赛库 / 数据这些开关，
   左下角资料卡打开的是「基本信息」（姓名、专业、联系方式）。 */
/* 设置分成两个入口：左下角资料卡 = 基本信息（关于你），
   导航里的「设置」= 提醒、竞赛库、数据这些机器侧的开关。 */
const NAV = [
  { key: 'overview', label: '概览', icon: 'ic-grid' },
  { key: 'archive', label: '经历档案', icon: 'ic-board' },
  { key: 'schedule', label: '赛程节点', icon: 'ic-clock' },
  { key: 'materials', label: '材料库', icon: 'ic-file' },
  { key: 'retro', label: '复盘笔记', icon: 'ic-note' },
  { key: 'export', label: '简历导出', icon: 'ic-out' },
  { key: 'library', label: '竞赛库', icon: 'ic-search' },
  { key: 'settings', label: '设置', icon: 'ic-cog' }
];

/* 副标题只留确实有信息量的（导出页）；
   其余页面的说明文案按用户要求全部去掉，页面自己会说话。 */
const TITLES = {
  overview: ['概览', ''],
  archive: ['经历档案', ''],
  schedule: ['赛程节点', ''],
  materials: ['材料库', ''],
  retro: ['复盘笔记', ''],
  export: ['简历导出', ''],
  library: ['竞赛库', ''],
  settings: ['设置', ''],
  profile: ['基本信息', '']
};

async function boot() {
  renderSkeleton();
  await refresh();
  const { view, id } = parseHash();
  if (VIEWS[view]) S.view = view;
  render();
  if (id && S.experiences.some(x => x.id === id)) openDrawer(id);
}

/** 地址栏形如 #archive/exp-123：视图 + 某条经历，可以直接收藏、也能用浏览器回退 */
function parseHash() {
  const h = (location.hash || '').replace('#', '');
  if (!h) return { view: '', id: '' };
  const i = h.indexOf('/');
  return i < 0 ? { view: h, id: '' } : { view: h.slice(0, i), id: h.slice(i + 1) };
}

function setHash(view, id) {
  const next = '#' + view + (id ? '/' + id : '');
  if (location.hash === next) return;
  try { history.replaceState(null, '', next); } catch (_) { }
}

async function refresh() {
  // state 里的 library 只带元信息（count/版本），竞赛全量列表单独拉——
  // 竞赛库视图、推荐、添加竞赛都吃这份。
  const [st, lib] = await Promise.all([api('/api/state'), api('/api/library')]);
  S.profile = st.profile;
  S._libItems = lib.items || [];
  // 收藏模板上限改成 3 之后，老数据里存的 5 个要收敛一次，否则「更多模板」
  // 里的星标全被旧数据占满，一个都点不动。
  const favs = (S.profile.export && S.profile.export.favorites) || [];
  if (favs.length > MAX_FAV_TPL) {
    S.profile.export.favorites = favs.slice(0, MAX_FAV_TPL);
    api('/api/profile', { method: 'PUT', body: { export: { favorites: S.profile.export.favorites } } }).catch(() => { });
  }
  S.experiences = st.experiences;
  S.library = st.library;
  S.stats = st.stats;
  S.deleted = st.deleted || [];
  S.exportProfiles = st.exportProfiles || [];
  S.exportTemplates = st.exportTemplates || [];
  applyTaxonomy(st.taxonomy);
  // 类型被删掉后（用户在设置里改过），筛选条件可能指向一个不存在的类型
  if (S.filter.type && !TYPE_LABEL[S.filter.type]) S.filter.type = '';
  S.reminderInfo = st.reminder || {};
  document.documentElement.classList.toggle('reduce-motion', !!(S.profile.ui && S.profile.ui.reduceMotion));
  await loadRecs();
  renderRail();
}

function renderRail() {
  $('#nav').innerHTML =
    NAV.map(n => `
      <button class="nav-item${S.view === n.key ? ' on' : ''}" data-go="${n.key}">
        <span class="ic ${n.icon}"></span><span class="label">${n.label}</span>
      </button>`).join('');

  $$('#nav .nav-item').forEach(b => b.onclick = () => go(b.dataset.go));

  const p = S.profile || {};
  const name = (p.name || '').trim();
  $('#railName').textContent = name || '未设置姓名';
  $('#railSub').textContent = [p.school, p.grade].filter(Boolean).join(' · ') || '点这里补全信息';
  $('#railAvatar').textContent = name ? name.slice(0, 1) : '我';
  // 资料卡 = 基本信息入口，所以它自己也要有选中态，否则进了基本信息页整条侧栏都是暗的
  $('#railUser').classList.toggle('on', S.view === 'profile');
  $('#railUser').onclick = () => go('profile');
}

/* 角标已按用户要求移除：导航只留干净的名字。 */

/* 切视图时只同步高亮（不重建 DOM：重建会打断 View Transition，也会丢焦点） */
function syncRailActive() {
  $$('#nav .nav-item').forEach(b => b.classList.toggle('on', b.dataset.go === S.view));
  const u = $('#railUser');
  if (u) u.classList.toggle('on', S.view === 'profile');
}

function go(view) {
  if (S.view === view) return;
  const run = () => { S.view = view; render(); };
  if (document.startViewTransition) {
    const t = document.startViewTransition(run);
    // 连续切视图时旧过渡会被新过渡打断（AbortError）——这是预期行为，
    // 不接住的话会变成 unhandled rejection，把控制台染红。
    t.finished.catch(() => {});
  } else run();
  setHash(view, '');
}

function renderSkeleton() {
  $('#view').innerHTML = `<div class="bento">
    <div class="skel b-hero" style="height:280px;grid-column:span 8"></div>
    <div class="skel b-brief" style="height:280px;grid-column:span 4"></div>
    <div class="skel b-third" style="height:170px"></div>
    <div class="skel b-third" style="height:170px"></div>
    <div class="skel b-third" style="height:170px"></div>
  </div>`;
}

function render() {
  const [t, sub] = TITLES[S.view] || TITLES.overview;
  $('#viewTitle').textContent = t;
  $('#viewSub').textContent = sub;
  $('#viewSub').hidden = !sub;
  renderTopbar();
  syncRailActive();
  const v = $('#view');
  const sameView = S._lastView === S.view;
  const keepScroll = sameView ? v.scrollTop : 0;
  v.innerHTML = (VIEWS[S.view] || VIEWS.overview)();
  // 只有真正换了视图才播放进入动效——筛选/输入引起的重绘不该再动一次
  if (!sameView) {
    Array.from(v.children).forEach((c, i) => {
      c.classList.add('view-enter');
      c.style.animationDelay = Math.min(i, 4) * 45 + 'ms';
    });
    S._lastView = S.view;
  }
  bindView();
  // 同一视图内的重绘（勾节点、切筛选）不该把滚动位置弹回顶部
  v.scrollTop = keepScroll;
}

function renderTopbar() {
  const el = $('#topbarActions');
  const map = {
    // 竞赛库的入口在「新增经历」里（选竞赛类型时出现），顶栏不再单独放一个
    overview: `<button class="btn btn-primary" data-act="new"><span class="ic ic-plus"></span>新增经历</button>`,
    archive: `<button class="btn btn-primary" data-act="new"><span class="ic ic-plus"></span>新增经历</button>`,
    schedule: '',
    materials: `<button class="btn" data-go="archive"><span class="ic ic-board"></span>去经历里添加</button>`,
    retro: '',
    // 导出页的下载动作只有一个，就在左栏底部（按选中的格式走）。
    // 顶栏再放一个「导出 PDF」会跟用户选的格式打架，索性留空。
    export: '',
    settings: ''
  };
  el.innerHTML = map[S.view] || '';
}

/* =============================== 视图 =============================== */

const VIEWS = {};

/* ------------------------------ 概览 ------------------------------ */
VIEWS.overview = function () {
  if (!S.experiences.length) return emptyState();

  const soon = allPendingNodes(14);
  const hero = soon.slice(0, 3);
  const over = allPendingNodes(0).filter(x => x.t < Date.now());
  const activeComp = S.experiences.filter(e => e.type === 'competition' && stageIndex(e.stage) < 4);
  const awards = S.experiences.filter(e => (e.result && e.result.award) || e.type === 'award');
  const soonN = allPendingNodes(7).length;
  const noMat = S.experiences.filter(e => !(e.materials || []).length && stageIndex(e.stage) < 4).length;
  const retros = S.experiences
    .filter(e => e.retro && (e.retro.good || e.retro.bad || e.retro.reuse))
    .sort((a, b) => String(b.endedAt || '').localeCompare(String(a.endedAt || '')));
  const recs = (S._recs || []).slice(0, 8);
  const rd = readiness();

  const heroHtml = hero.length ? hero.map((x, i) => {
    const d = dl(x.node.dueAt);
    const u = urgency(d);
    const cls = d < 0 ? 'now' : d === 0 ? 'now' : d <= 3 ? 'soon' : 'later';
    const big = d < 0 ? '!' : d === 0 ? '今' : String(d);
    const small = d < 0 ? '逾期' : d === 0 ? '天' : d === 1 ? '明天' : '天后';
    return `<div class="upnext-row enter" style="--i:${Math.min(i, 8)}">
      <div class="day ${cls}"><b>${big}</b><span>${small}</span></div>
      <div class="upnext-body">
        <div class="upnext-title">${esc(x.node.title)}</div>
        <div class="upnext-meta">
          <span>${esc(x.exp.title)}</span><span class="sep"></span>
          <span>${fmt(x.node.dueAt, true)}</span><span class="sep"></span>
          <span class="${u === 'hot' ? '' : 'muted'}" style="${u === 'hot' ? 'color:var(--danger)' : ''}">${dlText(d)}</span>
        </div>
      </div>
      <button class="btn btn-sm" data-open="${x.exp.id}">详情</button>
    </div>`;
  }).join('') : `<div style="padding:26px 0;text-align:center">
      <div class="dim" style="font-size:13px">未来两周没有临近的节点。</div>
      <div class="dim" style="font-size:12px;margin-top:4px">给经历加一个带截止时间的节点，它就会出现在这里。</div>
    </div>`;

  return `<div class="ov-grid">
    <div class="panel ov-side">
      <div class="panel-label"><span class="ic ic-search" style="width:13px;height:13px"></span>可以开始准备的竞赛</div>
      <div class="ov-side-list">${recs.length ? recs.map((r, i) => `
        <div class="listrow enter" style="--i:${Math.min(i, 8)}">
          <div class="listrow-body">
            <div class="listrow-title">${esc(r.short || r.name)}</div>
            <div class="listrow-meta">${esc(r.category)} · ${esc(r.window)}</div>
          </div>
          <button class="btn btn-sm" data-act="add-lib" data-id="${esc(r.id)}">参加</button>
        </div>`).join('') : '<div class="dim" style="font-size:12.5px">正在按你的专业排序…</div>'}</div>
      <div class="spacer"></div>
      <button class="btn btn-sm btn-quiet" data-act="pick-lib">浏览全部竞赛库</button>
    </div>

    <div class="bento ov-main">
    <div class="panel hero b-hero">
      <div class="hero-top">
        <div class="hero-h"><span class="pulse"></span>接下来要发生的</div>
        ${over.length ? `<span class="chip chip-danger">${over.length} 件已逾期</span>` : '<span class="chip chip-ok">没有逾期</span>'}
      </div>
      <div class="upnext">${heroHtml}</div>
      <div class="spacer"></div>
      <div class="row-wrap" style="padding-top:12px;border-top:1px solid var(--line-soft)">
        <button class="btn btn-sm" data-go="schedule">看完整赛程</button>
        <div class="spacer"></div>
        <span class="dim" style="font-size:11.5px">共 ${S.experiences.length} 条经历 · ${S.stats ? S.stats.nodes : 0} 个节点</span>
      </div>
    </div>

    <div class="panel brief b-brief">
      <div class="brief-head">
        <div class="panel-label">此刻简报</div>
      </div>
      <div class="brief-body">
        <div class="brief-item" data-go="archive">
          <span class="ic ic-board"></span>
          <span class="k">在研竞赛</span>
          <span class="v">${activeComp.length}</span>
        </div>
        <div class="brief-item" data-go="schedule">
          <span class="ic ic-clock"></span>
          <span class="k">7 天内节点</span>
          <span class="v ${soonN ? 'hot' : ''}">${soonN}</span>
        </div>
        <div class="brief-item" data-go="materials">
          <span class="ic ic-file"></span>
          <span class="k">材料待补</span>
          <span class="v ${noMat ? 'warm' : ''}">${noMat}</span>
        </div>
        <div class="brief-item" data-go="retro">
          <span class="ic ic-spark"></span>
          <span class="k">已获奖项</span>
          <span class="v ok">${awards.length}</span>
        </div>
      </div>
    </div>

    <div class="panel panel-hover b-half" data-go="retro">
      <div class="panel-label">最近复盘</div>
      ${retros.length ? retros.slice(0, 3).map(e => `
        <div class="listrow">
          <div class="listrow-body">
            <div class="listrow-title">${esc(e.title)}</div>
            <div class="listrow-meta">${esc((e.retro.good || e.retro.bad || e.retro.reuse || '').slice(0, 52))}</div>
          </div>
          ${e.result && e.result.award ? `<span class="chip chip-accent">${esc(e.result.award)}</span>` : ''}
        </div>`).join('')
      : `<div class="dim" style="font-size:12.5px;line-height:1.75">还没有复盘记录。比赛结束后花三分钟记一下——这是越用越厚的那部分。</div>`}
    </div>

    <div class="panel panel-hover b-half" data-go="export">
      <div class="panel-label">成果就绪度</div>
      <div class="row" style="align-items:flex-end;gap:8px">
        <span class="stat-num">${rd.pct}<span style="font-size:16px;font-weight:500">%</span></span>
        <span class="dim" style="font-size:11.5px;padding-bottom:5px">${rd.total} 条经历</span>
      </div>
      <div class="bar"><i style="width:${rd.pct}%"></i></div>
      ${rd.readyList.length ? `<div class="col" style="gap:6px;margin-top:12px">${rd.readyList.slice(0, 3).map(e => `
          <div class="row" style="gap:8px;font-size:11.5px;color:var(--accent-ink)">
            <span class="ic ic-check" style="width:12px;height:12px;flex:0 0 auto"></span>
            <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.title)}</span>
          </div>`).join('')}
        ${rd.readyList.length > 3 ? `<div class="dim" style="font-size:11px">还有 ${rd.readyList.length - 3} 条已就绪</div>` : ''}</div>`
      : rd.gaps.length ? `<div class="col" style="gap:6px;margin-top:12px">${rd.gaps.slice(0, 2).map(g =>
        `<div class="row" style="gap:8px;font-size:11.5px;color:var(--ink-3)">
            <span style="width:5px;height:5px;border-radius:50%;background:var(--amber-9);flex:0 0 auto"></span>
            ${esc(g.label)} <span class="dim">· ${g.n} 条</span>
          </div>`).join('')}</div>`
        : `<div class="row" style="gap:7px;font-size:11.5px;color:var(--accent-ink);margin-top:12px">
            <span class="ic ic-check"></span>一个缺项都没有
          </div>`}
    </div>
    </div>
  </div>`;
};

function emptyState() {
  return `<div class="empty view-enter">
    <div class="empty-art">${ART.compass}</div>
    <h3>还没有任何经历</h3>
    <p>从内置竞赛库里挑一个（骨架来自中国高等教育学会的竞赛榜单，选中后赛程节点自动套好），<br>或者手动新增一条自己的项目、实习、论文。</p>
    <div class="row-wrap" style="justify-content:center;gap:9px">
      <button class="btn btn-primary btn-lg" data-act="pick-lib"><span class="ic ic-search"></span>从竞赛库挑一个</button>
      <button class="btn btn-lg" data-act="new"><span class="ic ic-plus"></span>手动新增</button>
    </div>
    <button class="btn btn-ghost btn-sm" data-act="demo-load">先载入示例看看效果</button>
  </div>`;
}

/* 空状态插画：纯 SVG，不依赖外部资源 */
const ART = {
  compass: `<svg viewBox="0 0 104 104" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="52" cy="52" r="34" stroke="#d6f1e3" stroke-width="1.5"/>
    <circle cx="52" cy="52" r="24" fill="#f4fbf7"/>
    <circle cx="52" cy="52" r="24" stroke="#acdec8" stroke-width="1.5"/>
    <path d="M52 20v-6M52 90v-6M20 52h-6M90 52h-6" stroke="#8bceb6" stroke-width="1.5" stroke-linecap="round"/>
    <path d="m62 42-7 15-15 7 7-15z" fill="#29a383" fill-opacity=".9"/>
    <circle cx="52" cy="52" r="3" fill="#1d3b31"/>
  </svg>`,
  file: `<svg viewBox="0 0 104 104" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="26" y="18" width="44" height="58" rx="7" fill="#fff" stroke="#d6f1e3" stroke-width="1.5"/>
    <rect x="34" y="26" width="44" height="58" rx="7" fill="#f4fbf7" stroke="#acdec8" stroke-width="1.5"/>
    <path d="M44 44h24M44 54h24M44 64h14" stroke="#8bceb6" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="76" cy="76" r="13" fill="#29a383"/>
    <path d="m70.5 76 4 4 7-8" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
  pencil: `<svg viewBox="0 0 104 104" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="24" y="20" width="56" height="64" rx="8" fill="#fff" stroke="#d6f1e3" stroke-width="1.5"/>
    <path d="M36 38h30M36 50h30M36 62h18" stroke="#acdec8" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M78 54l14 14-8 8-14-14z" fill="#f4fbf7" stroke="#29a383" stroke-width="1.5"/>
    <path d="m84 60-8 8" stroke="#29a383" stroke-width="1.5"/>
    <path d="m70 76-4 4 1-5z" fill="#1d3b31"/>
  </svg>`,
  cal: `<svg viewBox="0 0 104 104" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="20" y="26" width="64" height="56" rx="9" fill="#fff" stroke="#d6f1e3" stroke-width="1.5"/>
    <rect x="20" y="26" width="64" height="16" rx="9" fill="#d6f1e3"/>
    <path d="M36 20v10M68 20v10" stroke="#56ba9f" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="38" cy="56" r="3.5" fill="#8bceb6"/>
    <circle cx="52" cy="56" r="3.5" fill="#8bceb6"/>
    <circle cx="66" cy="56" r="3.5" fill="#29a383"/>
    <circle cx="38" cy="70" r="3.5" fill="#d6f1e3"/>
    <circle cx="52" cy="70" r="3.5" fill="#d6f1e3"/>
  </svg>`,
  search: `<svg viewBox="0 0 104 104" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="47" cy="47" r="24" stroke="#acdec8" stroke-width="2.5"/>
    <circle cx="47" cy="47" r="16" fill="#f4fbf7"/>
    <path d="m65 65 14 14" stroke="#29a383" stroke-width="4" stroke-linecap="round"/>
    <path d="M41 47h12M47 41v12" stroke="#8bceb6" stroke-width="2.5" stroke-linecap="round"/>
  </svg>`
};

/* ------------------------------ 档案 ------------------------------ */
VIEWS.archive = function () {
  const q = S.filter.q.toLowerCase().trim();
  const list = S.experiences.filter(e => {
    if (S.filter.type && e.type !== S.filter.type) return false;
    if (S.filter.stage && e.stage !== S.filter.stage) return false;
    if (q && !((e.title || '') + (e.tags || []).join('') + (e.role || '') + (e.track || '')).toLowerCase().includes(q)) return false;
    return true;
  });

  const toolbar = `<div class="toolbar">
    <div class="search-wrap"><span class="ic ic-search"></span>
      <input class="input input-search" id="fq" placeholder="搜索名称、标签、角色" value="${esc(S.filter.q)}">
    </div>
    <select class="select" id="ftype" style="width:auto;min-width:110px">
      <option value="">全部类型</option>
      ${Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}"${S.filter.type === k ? ' selected' : ''}>${v}</option>`).join('')}
    </select>
    <select class="select" id="fstage" style="width:auto;min-width:110px">
      <option value="">全部阶段</option>
      ${STAGES.map(s => `<option value="${s}"${S.filter.stage === s ? ' selected' : ''}>${s}</option>`).join('')}
    </select>
    ${(S.filter.q || S.filter.type || S.filter.stage) ? `<button class="btn btn-sm btn-ghost" data-act="clear-filter">清空筛选</button>` : ''}
    <div class="spacer"></div>
    <span class="dim" style="font-size:12px">${list.length} / ${S.experiences.length} 条</span>
    <div class="seg">
      <button class="${S.mode.archive === 'kanban' ? 'on' : ''}" data-mode="kanban">看板</button>
      <button class="${S.mode.archive === 'table' ? 'on' : ''}" data-mode="table">表格</button>
    </div>
  </div>`;

  if (!list.length) {
    return toolbar + `<div class="empty">
      <div class="empty-art">${S.experiences.length ? ART.search : ART.compass}</div>
      <h3>${S.experiences.length ? '没有符合条件的经历' : '档案还是空的'}</h3>
      <p>${S.experiences.length ? '换个筛选条件试试。' : '从竞赛库里挑一个，或者自己新增一条。'}</p>
      <button class="btn btn-primary" data-act="${S.experiences.length ? 'clear-filter' : 'pick-lib'}">${S.experiences.length ? '清空筛选' : '从竞赛库挑一个'}</button>
    </div>`;
  }

  if (S.mode.archive === 'table') {
    const rows = list.map((e, i) => {
      const n = nextNode(e);
      const d = n ? dl(n.dueAt) : null;
      return `<tr data-open="${e.id}" class="enter" style="--i:${Math.min(i, 8)}">
        <td><div class="t-name">${esc(e.title)}</div>
          ${e.track || e.role ? `<div class="dim" style="font-size:11.5px;margin-top:2px">${esc(e.role || e.track)}</div>` : ''}</td>
        <td><span class="chip chip-line">${typeIcon(e.type)}${esc(typeLabel(e.type))}</span></td>
        <td>${esc(e.level || '—')}</td>
        <td style="min-width:96px">${meter(e.stage)}
          <div class="dim" style="font-size:11px;margin-top:4px">${esc(e.stage)}</div></td>
        <td class="num">${n ? fmtShort(n.dueAt) : '—'}</td>
        <td>${d === null ? '<span class="dim">—</span>'
          : d < 0 ? '<span class="chip chip-danger">已逾期</span>'
            : `<span class="chip${d <= 3 ? ' chip-warn' : ''}">${d === 0 ? '今天' : d + ' 天'}</span>`}</td>
        <td class="right num">${(e.materials || []).length}</td>
      </tr>`;
    }).join('');
    return toolbar + `<div class="table-wrap"><table class="tbl">
      <thead><tr><th>名称</th><th>类型</th><th>级别</th><th>阶段</th><th>最近节点</th><th>剩余</th><th class="right">材料</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  /* 按阶段筛过之后，别的列都必然是空壳——那就不摆看板了，
     把命中的卡片横着铺开，一屏看完。 */
  if (S.filter.stage) {
    const items = list.filter(e => (e.stage || '筹备中') === S.filter.stage);
    return toolbar + `<div class="grid-3">${items.map((e, i) => kanbanCard(e, i)).join('')}</div>`;
  }

  const cols = STAGES.map(st => {
    const items = list.filter(e => (e.stage || '筹备中') === st);
    return `<div class="kcol" data-stage="${st}">
      <div class="kcol-head"><span class="dot"></span><span>${st}</span><span class="cnt">${items.length}</span></div>
      <div class="kcol-body" data-stage="${st}">
        ${items.length ? items.map((e, i) => kanbanCard(e, i)).join('') : '<div class="kcol-empty">这一列还没有</div>'}
      </div>
    </div>`;
  }).join('');

  return toolbar + `<div class="kanban">${cols}</div>`;
};

function kanbanCard(e, i) {
  const n = nextNode(e);
  const d = n ? dl(n.dueAt) : null;
  const u = urgency(d);
  const cls = u === 'hot' ? 'hot' : u === 'warm' ? 'warm' : '';
  return `<div class="kcard enter" style="--i:${Math.min(i, 8)}" data-open="${e.id}" data-id="${e.id}">
    <h4>${esc(e.title)}</h4>
    <div class="kmeta">
      <span class="chip chip-line">${typeIcon(e.type)}${esc(typeLabel(e.type))}</span>
      ${e.level ? `<span class="chip">${esc(e.level.replace(/（.*?）/, ''))}</span>` : ''}
    </div>
    ${meter(e.stage)}
    ${n ? `<div class="kfoot ${cls}">
        <span class="ic ${cls === 'hot' ? 'ic-dot' : 'ic-cal'}" style="width:13px;height:13px"></span>
        <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(n.title)}</span>
        <span style="margin-left:auto;flex:0 0 auto">${dlText(d)}</span>
      </div>`
      : `<div class="kfoot dim">未设节点</div>`}
    ${(e.materials || []).length ? `<div class="kfoot dim"><span class="ic ic-file" style="width:13px;height:13px"></span>${(e.materials || []).length} 份材料</div>` : ''}
  </div>`;
}

/* ------------------------------ 赛程 ------------------------------ */
VIEWS.schedule = function () {
  const win = S.mode.schedule === 'all' ? 3650 : 120;
  let list;
  if (S.mode.schedule === 'done') {
    list = [];
    for (const e of S.experiences) for (const n of e.nodes || []) {
      if (n.done && n.dueAt) list.push({ exp: e, node: n, t: new Date(n.dueAt).getTime() });
    }
    list.sort((a, b) => b.t - a.t);
  } else {
    list = allPendingNodes(win);
  }

  const toolbar = `<div class="toolbar">
    <div class="seg">
      <button class="${S.mode.schedule === 'upcoming' ? 'on' : ''}" data-smode="upcoming">未来 120 天</button>
      <button class="${S.mode.schedule === 'all' ? 'on' : ''}" data-smode="all">全部未完成</button>
      <button class="${S.mode.schedule === 'done' ? 'on' : ''}" data-smode="done">已完成</button>
    </div>
    <div class="spacer"></div>
  </div>`;

  if (!list.length) {
    return toolbar + `<div class="empty">
      <div class="empty-art">${ART.cal}</div>
      <h3>${S.mode.schedule === 'done' ? '还没有完成过的节点' : '这段时间没有节点'}</h3>
      <p>到「经历档案」给某项经历加一个带截止时间的节点，它就会出现在这里，并自动进入每日提醒。</p>
      <button class="btn btn-primary" data-go="archive">去档案里加节点</button>
    </div>`;
  }

  const byDay = new Map();
  for (const x of list) {
    const k = fmt(x.node.dueAt, false);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(x);
  }
  const byMonth = new Map();
  for (const [day, arr] of byDay) {
    const m = day.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push([day, arr]);
  }

  let i = 0;
  let prevYear = '';
  const html = Array.from(byMonth.entries()).map(([month, days]) => {
    const [y, mm] = month.split('-');
    // 左槽太窄放不下「2026 年 10 月」，所以换年时才显示年份，月份单独放大
    const showYear = y !== prevYear;
    prevYear = y;
    return `<div class="tl-month">
      <span class="lbl">${showYear ? `<span class="yr">${y}</span>` : ''}<span class="mo">${Number(mm)} 月</span></span><span class="knot"></span>
    </div>
    <div class="tl-group">
      ${days.map(([day, arr]) => {
        const conflict = arr.length > 1 && arr.some(x => !x.node.done);
        return arr.map(x => {
          const d = dl(x.node.dueAt);
          const u = x.node.done ? '' : urgency(d);
          const cls = [u === 'hot' ? 'hot' : u === 'warm' ? 'warm' : '', x.node.done ? 'done' : '', conflict ? 'conflict' : ''].filter(Boolean).join(' ');
          const dd = toDate(x.node.dueAt);
          return `<div class="tl-row ${cls} enter" style="--i:${Math.min(i++, 8)}">
            <div class="tl-date"><b>${fmtShort(x.node.dueAt)}</b>${weekdayOf(x.node.dueAt)}</div>
            <div class="tl-main">
              <div class="tl-title">${esc(x.node.title)}
                ${conflict ? '<span class="tl-conflict-tag">· 同日冲突</span>' : ''}
              </div>
              <div class="tl-meta">
                <span>${esc(x.exp.title)}</span><span class="sep">·</span>
                <span>${KIND_LABEL[x.node.kind] || '节点'}</span>
                ${dd && hasClock(dd) ? `<span class="sep">·</span><span>${String(dd.getHours()).padStart(2, '0')}:${String(dd.getMinutes()).padStart(2, '0')}</span>` : ''}
                ${!x.node.done && d !== null ? `<span class="sep">·</span><span style="color:${u === 'hot' ? 'var(--danger)' : u === 'warm' ? 'var(--warn)' : 'inherit'}">${dlText(d)}</span>` : ''}
              </div>
            </div>
            <label class="check tl-check" title="标记完成">
              <input type="checkbox" data-donetoggle="${x.exp.id}|${x.node.id}" ${x.node.done ? 'checked' : ''}>
            </label>
          </div>`;
        }).join('');
      }).join('')}
    </div>`;
  }).join('');

  // 时间轴本身收窄：否则右侧的勾选框离正文有 800px，读起来要来回甩头
  return `<div style="max-width:920px">${toolbar}<div class="tl">${html}</div></div>`;
};

/* ------------------------------ 材料 ------------------------------ */
VIEWS.materials = function () {
  const all = [];
  for (const e of S.experiences) for (const m of e.materials || []) all.push({ exp: e, m });

  if (!all.length) {
    return `<div class="empty">
      <div class="empty-art">${ART.file}</div>
      <h3>材料库是空的</h3>
      <p>证书、作品、报名表都可以放进来。文件会被复制到项目目录，原文件删了也不丢。<br>把「报名表」这类年年重复用的勾上「可复用」，下次写材料直接取。</p>
      <button class="btn btn-primary" data-go="archive">去经历里上传</button>
    </div>`;
  }

  const q = S.filter.matq.toLowerCase().trim();
  let list = all.filter(x => !q || (x.m.name + x.exp.title + (x.m.note || '')).toLowerCase().includes(q));
  if (S.mode.materials === 'reuse') list = list.filter(x => x.m.reusable);

  const toolbar = `<div class="toolbar">
    <div class="search-wrap"><span class="ic ic-search"></span>
      <input class="input input-search" id="fmat" placeholder="搜索材料或所属经历" value="${esc(S.filter.matq)}">
    </div>
    <div class="seg">
      <button class="${S.mode.materials === 'all' ? 'on' : ''}" data-mmode="all">全部 ${all.length}</button>
      <button class="${S.mode.materials === 'reuse' ? 'on' : ''}" data-mmode="reuse">可复用 ${all.filter(x => x.m.reusable).length}</button>
    </div>
    <div class="spacer"></div>
    <span class="dim" style="font-size:12px">${list.length} 份</span>
  </div>`;

  if (!list.length) {
    return toolbar + `<div class="empty">
      <div class="empty-art">${ART.search}</div>
      <h3>没有匹配的材料</h3>
      <p>换个关键词，或者切回「全部」。</p>
      <button class="btn" data-act="mat-clear">清空筛选</button>
    </div>`;
  }

  const warn = all.length > 60 ? `<div class="panel" style="background:var(--warn-bg);border-color:var(--warn-line);flex-direction:row;align-items:center;gap:10px;margin-bottom:16px">
    <span class="ic ic-dot" style="color:var(--warn)"></span>
    <span style="font-size:12.5px;color:var(--warn)">材料已有 ${all.length} 份，项目目录会越变越大。建议把往年的归档外移，只留还在用的。</span>
  </div>` : '';

  const reuse = list.filter(x => x.m.reusable);
  const rest = list.filter(x => !x.m.reusable);

  return warn + toolbar +
    (reuse.length ? `<div class="sect-head"><h2>可复用模板</h2><span class="rule"></span><span class="hint">报名材料年年重复填，这几个直接取</span></div>
      <div class="grid-3" style="margin-bottom:26px">${reuse.map((x, i) => matCard(x, i)).join('')}</div>` : '') +
    (rest.length ? `<div class="sect-head"><h2>其他材料</h2><span class="rule"></span><span class="hint">${rest.length} 份</span></div>
      <div class="grid-3">${rest.map((x, i) => matCard(x, i)).join('')}</div>` : '');
};

function matCard(x, i) {
  const m = x.m;
  return `<div class="panel panel-hover enter" style="--i:${Math.min(i, 8)}" data-open="${x.exp.id}">
    <div class="row" style="justify-content:space-between;align-items:flex-start;gap:10px">
      <div class="row" style="gap:8px;min-width:0;align-items:flex-start">
        <span class="chip chip-line">${MAT_KIND[m.kind] || '其他'}</span>
        <b style="font-size:13.5px;font-weight:600;line-height:1.45;word-break:break-word">${esc(m.name)}</b>
      </div>
      ${m.reusable ? '<span class="chip chip-accent">可复用</span>' : ''}
    </div>
    ${m.note ? `<div style="font-size:12px;color:var(--ink-3);line-height:1.7">${esc(m.note)}</div>` : ''}
    <div class="spacer"></div>
    <div class="panel-foot fx" style="justify-content:space-between">
      <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.exp.title)}</span>
      <span style="flex:0 0 auto">${fmt(m.addedAt, false)}</span>
    </div>
    <div class="row" style="justify-content:space-between;border-top:1px solid var(--line-soft);padding-top:10px">
      <label class="check" title="勾上后会在「可复用模板」里置顶">
        <input type="checkbox" data-mat-reuse2="${x.exp.id}|${m.id}" ${m.reusable ? 'checked' : ''}>可复用
      </label>
      ${m.file
        ? `<span class="row" style="gap:6px;flex:0 0 auto">
            <button class="btn btn-sm" data-mat-view="${x.exp.id}|${m.id}" onclick="event.stopPropagation()">预览</button>
            <a class="btn btn-sm btn-ghost" href="/attachment/${encodeURIComponent(m.file)}?download=1" download onclick="event.stopPropagation()">下载</a>
          </span>`
        : '<span class="dim" style="font-size:11.5px">仅文字备注</span>'}
    </div>
  </div>`;
}

/* --------------------------- 材料预览 --------------------------- */
/** 哪些文件能在浏览器里直接看：图片 / PDF / 纯文本。Word、压缩包这类只能下载。 */
function matPreviewKind(file) {
  const ext = (String(file || '').split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (['txt', 'md', 'csv', 'json', 'log'].includes(ext)) return 'text';
  return '';
}

/** 点「预览」在弹层里看，不再一点就新开标签页/触发下载 */
function openMatPreview(exp, matId) {
  const m = (exp.materials || []).find(x => x.id === matId);
  if (!m) return;
  if (!m.file) { toast('这条只有文字备注，没有文件'); return; }
  const kind = matPreviewKind(m.file);
  const src = '/attachment/' + encodeURIComponent(m.file);
  let body = '';
  if (kind === 'image') {
    body = `<div style="text-align:center"><img src="${src}" style="max-width:100%;max-height:62vh;border-radius:6px" alt="${esc(m.name)}"></div>`;
  } else if (kind === 'pdf') {
    body = `<iframe src="${src}" style="width:100%;height:62vh;border:1px solid var(--line-soft);border-radius:6px;background:#fff" title="${esc(m.name)}"></iframe>`;
  } else if (kind === 'text') {
    body = `<pre id="matPre" style="max-height:62vh;overflow:auto;white-space:pre-wrap;font-size:12px;line-height:1.7;background:var(--sand-2,#f5f4f0);padding:12px;border-radius:6px;margin:0">加载中…</pre>`;
  } else {
    body = `<div class="dim" style="line-height:1.8;padding:8px 0">这种格式（Word / Excel / 压缩包等）浏览器没法直接预览，点下面的「下载」用本机应用打开。</div>`;
  }
  openModal(m.name, body,
    `<a class="btn" href="${src}?download=1" download="${esc(m.name)}">下载</a>
     <button class="btn btn-primary" data-m="close">关闭</button>`, { width: 'wide' });
  if (kind === 'text') {
    fetch(src).then(r => r.text()).then(t => {
      const pre = document.getElementById('matPre');
      if (pre) pre.textContent = t.slice(0, 200000);
    }).catch(() => {
      const pre = document.getElementById('matPre');
      if (pre) pre.textContent = '读取失败';
    });
  }
}

/* ------------------------------ 复盘 ------------------------------ */
VIEWS.retro = function () {
  const list = S.experiences.filter(e =>
    stageIndex(e.stage) >= 2 || (e.retro && (e.retro.good || e.retro.bad || e.retro.reuse)));

  if (!list.length) {
    return `<div class="empty">
      <div class="empty-art">${ART.pencil}</div>
      <h3>还没有可以复盘的经历</h3>
      <p>经历推进到「已提交」之后，就会出现在这里。<br>花三分钟回答三个问题——这一栏不会立刻有用，但它是三年后你最值钱的东西。</p>
      <button class="btn btn-primary" data-go="archive">去经历档案</button>
    </div>`;
  }

  const done = list.filter(e => e.retro && (e.retro.good || e.retro.bad || e.retro.reuse)).length;
  const head = `<div class="sect-head"><h2>${done} / ${list.length} 条已复盘</h2><span class="rule"></span></div>`;

  return head + `<div class="grid-2" style="align-items:start">${list.map((e, i) => `
    <div class="panel enter" style="--i:${Math.min(i, 8)}">
      <div class="row" style="align-items:flex-start;justify-content:space-between;gap:10px">
        <div style="min-width:0">
          <h3 style="font-size:14px;line-height:1.45">${esc(e.title)}</h3>
          <div class="panel-foot fx" style="margin-top:4px">
            ${e.level ? `<span>${esc(e.level)}</span>` : ''}
            ${e.result && e.result.award ? `<span class="chip chip-accent">${esc(e.result.award)}</span>` : ''}
            ${e.endedAt ? `<span>${fmt(e.endedAt, false)}</span>` : ''}
          </div>
        </div>
        <button class="btn btn-sm btn-quiet" data-open="${e.id}">详情</button>
      </div>
      <div class="field"><label>做对了什么（以后继续）</label>
        <textarea class="input" rows="3" data-retro="${e.id}|good" placeholder="哪种做法明显有效率？">${esc(e.retro.good)}</textarea></div>
      <div class="field"><label>踩了什么坑（以后避免）</label>
        <textarea class="input" rows="3" data-retro="${e.id}|bad" placeholder="哪一步白花了时间？">${esc(e.retro.bad)}</textarea></div>
      <div class="field"><label>哪些材料 / 做法可以复用</label>
        <textarea class="input" rows="2" data-retro="${e.id}|reuse" placeholder="下次能直接拿过来的东西">${esc(e.retro.reuse)}</textarea></div>
      <div class="savebar" data-save="${e.id}"><span class="ic ic-check"></span>已保存</div>
    </div>`).join('')}</div>`;
};

/* ------------------------------ 导出 ------------------------------ */

/** 收藏模板总量上限 = 左栏展示的 3 个（「更多模板」弹窗里的星标也按这个数封顶）。 */
const MAX_FAV_TPL = 3;
/** 四种导出格式。选格式只影响预览与下载按钮，选中不会直接下载 */
const EXPORT_FMTS = [
  { key: 'pdf', label: 'PDF' },
  { key: 'docx', label: 'Word' },
  { key: 'html', label: '网页' },
  { key: 'md', label: 'Markdown' }
];

function curExportProfile() {
  const list = S.exportProfiles.length ? S.exportProfiles : [{ key: 'baoyan' }];
  const k = (S.profile && S.profile.export && S.profile.export.profile) || '';
  return list.some(x => x.key === k) ? k : list[0].key;
}
function curExportTemplate() {
  const list = S.exportTemplates;
  const k = (S.profile && S.profile.export && S.profile.export.template) || '';
  return list.some(x => x.key === k) ? k : (list[0] ? list[0].key : 'classic');
}
/** 语言是独立选项（中文稿 / 英文骨架稿），不再绑死在「出国」口径上 */
function curExportLang() {
  return (S.profile && S.profile.export && S.profile.export.lang) === 'en' ? 'en' : 'zh';
}
/** 照片开关按口径分别记：出国默认不放，保研 / 求职默认放。用户手动切过就以手动为准 */
function curExportPhoto() {
  const cur = curExportProfile();
  const on = S.profile && S.profile.export && S.profile.export.photoOn;
  if (on && typeof on[cur] === 'boolean') return on[cur];
  return cur !== 'chuguo';
}
/** 出国稿固定英文：切到出国自动翻成 English，别的口径不拦 */
function effectiveExportLang() {
  return curExportProfile() === 'chuguo' ? 'en' : curExportLang();
}
/** 当前格式：pdf / docx / html / md。选格式只影响预览与下载按钮，不直接下载 */
function curExportFmt() {
  return EXPORT_FMTS.some(f => f.key === S._expFmt) ? S._expFmt : 'pdf';
}

/** 收藏的模板（不足或失效时用内置模板补齐到 MAX_FAV_TPL）。左栏展示的就是这些。 */
function favTemplates() {
  const favs = (S.profile && S.profile.export && S.profile.export.favorites) || [];
  const out = [];
  for (const k of favs) {
    const t = S.exportTemplates.find(x => x.key === k);
    if (t && !out.includes(t)) out.push(t);
  }
  for (const t of S.exportTemplates) {
    if (out.length >= MAX_FAV_TPL) break;
    if (!out.includes(t)) out.push(t);
  }
  return out.slice(0, MAX_FAV_TPL);
}
function isFavTpl(key) {
  const favs = (S.profile && S.profile.export && S.profile.export.favorites) || [];
  return favs.includes(key);
}

function profileLabel(k) {
  const p = S.exportProfiles.find(x => x.key === k);
  return p ? p.label : k;
}
function templateLabel(k) {
  const t = S.exportTemplates.find(x => x.key === k);
  return t ? t.label : k;
}
/** 预览面板标题的右半截：Markdown 不套版式，就不写版式名 */
function previewLabelText() {
  const cur = curExportProfile();
  const tail = curExportFmt() === 'md' ? 'Markdown' : templateLabel(curExportTemplate());
  return `预览 · ${profileLabel(cur)} · ${tail}`;
}

/** 「包含内容」按类型展开的行：全部类型都列出（包括一条经历都没有的），
    空类型只是没有可选项，不藏着——用户能看见工具认识哪些类型。 */
function expTypeRows() {
  const rows = [];
  for (const t of S.taxonomy) {
    const exps = S.experiences.filter(e => e.type === t.key);
    const on = !S._expIds ? true : exps.some(e => S._expIds.includes(e.id));
    rows.push({ key: t.key, label: t.label, exps, on });
  }
  return rows;
}
function periodOf(e) {
  const ym = s => s ? String(s).slice(0, 7).replace('-', '.') : '';
  const a = ym(e.startedAt), b = ym(e.endedAt);
  if (a && b) return a === b ? a : `${a} – ${b}`;
  return a || b || '';
}

/** 预览页与下载共用的查询串。细粒度勾选走 ids（经历 id），
    一个都没勾特殊处理成 null（= 全都要），避免导出一份空简历。 */
function exportQuery(fmt) {
  const q = new URLSearchParams();
  q.set('profile', curExportProfile());
  q.set('lang', effectiveExportLang());
  if (curExportPhoto()) q.set('photo', '1');
  if (curExportFmt() !== 'md') q.set('template', curExportTemplate());
  if (S._expIds && S._expIds.length) q.set('ids', S._expIds.join(','));
  if (fmt) q.set('format', fmt);
  else if (curExportFmt() === 'md') q.set('format', 'md');
  return q.toString();
}

/**
 * 版式缩略图：不画真排版，只用灰条示意「这一套长什么样」。
 * 各套的差别本来就是版面的差别，看一眼比读一段描述快。
 */
function tplThumb(kind) {
  const G = '#e8e8e3', D = '#c9c9c3', K = '#2c4a3f', BAND = '#1d3b31', FRESH = '#3f7d6b';
  const R = (x, y, w, h, c, rx) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx == null ? h / 2 : rx}" fill="${c}"/>`;
  const rows = (x, y0, n, w) => Array.from({ length: n }, (_, i) =>
    R(x, y0 + i * 5.2, i === n - 1 ? w * 0.6 : w, 1.9, G)).join('');
  const sect = y => R(7, y, 15, 2.6, K, 1.3) + R(7, y + 4.2, 46, 1, D, 0.5);
  const sideRows = (x, y0, n, w, c) => Array.from({ length: n }, (_, i) =>
    R(x, y0 + i * 5.2, i === n - 1 ? w * 0.6 : w, 1.9, c)).join('');
  let body = '';
  switch (kind) {
    case 'plain':
      body = R(7, 7, 26, 4, D, 2) + R(7, 13.5, 34, 1.7, G, 0.8)
        + R(7, 22, 12, 2.6, K, 1.3) + rows(7, 28, 3, 46)
        + R(7, 45, 12, 2.6, K, 1.3) + rows(7, 51, 3, 46);
      break;
    case 'academic':
      body = R(15, 7, 30, 4.2, D, 2) + R(11, 14, 38, 1.7, G, 0.8) + R(7, 20, 46, 1.4, K, 0.7)
        + R(7, 26, 4.5, 2.6, K, 1) + R(13.5, 26, 15, 2.6, D, 1.3) + rows(7, 32, 2, 46)
        + R(7, 44, 4.5, 2.6, K, 1) + R(13.5, 44, 15, 2.6, D, 1.3) + rows(7, 50, 3, 46);
      break;
    case 'two':
      body = R(0, 0, 20, 78, '#f1f1ed', 0)
        + R(4, 7, 12, 3.4, D, 1.7) + R(4, 14, 11, 1.5, G, 0.75)
        + R(4, 22, 8, 1.9, K, 0.95) + R(4, 26, 12, 1.4, G, 0.7)
        + R(4, 34, 8, 1.9, K, 0.95) + R(4, 38, 12, 1.4, G, 0.7)
        + R(24, 7, 17, 2.6, K, 1.3) + R(24, 15, 29, 1, D, 0.5) + rows(24, 20, 3, 29)
        + R(24, 38, 17, 2.6, K, 1.3) + R(24, 46, 29, 1, D, 0.5) + rows(24, 51, 3, 29);
      break;
    case 'side':
      body = R(0, 0, 22, 78, BAND, 0)
        + R(4, 7, 13, 3.6, '#ffffff', 1.8)
        + sideRows(4, 16, 2, 13, '#9dc3b5') + R(4, 29, 8, 1.8, '#9dc3b5', 0.9)
        + sideRows(4, 34, 2, 13, '#9dc3b5') + R(4, 47, 8, 1.8, '#9dc3b5', 0.9)
        + R(26, 7, 16, 2.6, K, 1.3) + R(26, 15, 27, 1, D, 0.5) + rows(26, 20, 3, 27)
        + R(26, 38, 16, 2.6, K, 1.3) + R(26, 46, 27, 1, D, 0.5) + rows(26, 51, 3, 27);
      break;
    case 'banner':
      body = R(0, 0, 60, 15, BAND, 0)
        + R(7, 5, 20, 3.6, '#ffffff', 1.8) + R(7, 10.5, 26, 1.3, '#9dc3b5', 0.65)
        + sect(22) + rows(7, 28, 3, 46) + sect(45) + rows(7, 51, 3, 46);
      break;
    case 'elegant':
      body = R(16, 7, 28, 4, D, 2) + R(7, 14, 46, 0.8, '#1b1b19', 0.4) + R(7, 16.4, 46, 1.8, '#1b1b19', 0.9)
        + R(20, 23, 20, 2.2, K, 1.1) + rows(12, 29, 3, 36)
        + R(20, 47, 20, 2.2, K, 1.1) + rows(12, 53, 2, 36);
      break;
    case 'fresh':
      body = R(0, 0, 60, 14, FRESH, 3)
        + R(7, 5, 18, 3.2, '#ffffff', 1.6) + R(7, 10, 24, 1.2, '#d5e8e0', 0.6)
        + R(0, 14, 19, 64, '#f2f7f4', 0)
        + R(3, 20, 9, 1.8, FRESH, 0.9) + R(3, 24, 13, 1.2, G, 0.6)
        + R(3, 31, 9, 1.8, FRESH, 0.9) + R(3, 35, 13, 1.2, G, 0.6)
        + R(23, 20, 15, 2.4, K, 1.2) + rows(23, 26, 3, 30)
        + R(23, 44, 15, 2.4, K, 1.2) + rows(23, 50, 3, 30);
      break;
    case 'dense':
      body = R(7, 6, 16, 3.8, D, 1.9) + R(30, 7.4, 23, 1.5, G, 0.75) + R(7, 12.5, 46, 1.2, '#1b1b19', 0.6)
        + R(7, 17, 12, 2.2, K, 1.1) + rows(7, 22, 4, 46)
        + R(7, 45, 12, 2.2, K, 1.1) + rows(7, 50, 4, 46);
      break;
    default: // center / 上传的单栏模板
      body = R(17, 7, 26, 4.2, D, 2) + R(13, 13.5, 34, 1.7, G, 0.8)
        + sect(21) + rows(7, 27, 3, 46) + sect(45) + rows(7, 51, 3, 46);
  }
  return `<svg viewBox="0 0 60 78" aria-hidden="true"><rect width="60" height="78" rx="3.5" fill="#fff"/>${body}</svg>`;
}

VIEWS.export = function () {
  const cur = curExportProfile();
  const lang = effectiveExportLang();
  const chuguo = cur === 'chuguo';
  const fmt = curExportFmt();
  const tplKey = curExportTemplate();
  const tpls = favTemplates();
  const rows = expTypeRows();
  const mdOn = fmt === 'md';
  const fmtLabel = (EXPORT_FMTS.find(f => f.key === fmt) || {}).label || 'PDF';
  const incCount = S._expIds ? S._expIds.length : S.experiences.length;

  return `<div class="export-grid">
    <div class="panel ex-panel">
      <div class="ex-row">
        <span class="ex-k">类型</span>
        <div class="seg">${S.exportProfiles.map(p => `
          <button type="button" data-exp-profile="${esc(p.key)}" class="${cur === p.key ? 'on' : ''}">${esc(p.label)}</button>`).join('')}
        </div>
      </div>

      <div class="ex-row">
        <span class="ex-k">语言</span>
        <div class="seg">
          <button type="button" data-exp-lang="zh" class="${lang === 'zh' ? 'on' : ''}" ${chuguo ? 'disabled title="出国稿固定英文"' : ''}>中文</button>
          <button type="button" data-exp-lang="en" class="${lang === 'en' ? 'on' : ''}">English</button>
        </div>
        ${chuguo ? '<span class="ex-note">出国稿固定英文；还没翻译的内容会在纸上标黄提醒你</span>' : ''}
      </div>

      <div class="ex-row">
        <span class="ex-k">照片</span>
        <div class="seg">
          <button type="button" data-exp-photo="1" class="${curExportPhoto() ? 'on' : ''}">放上</button>
          <button type="button" data-exp-photo="0" class="${!curExportPhoto() ? 'on' : ''}">不放</button>
        </div>
        ${S.profile.photo ? '' : '<span class="ex-note">还没传证件照——去「基本信息」上传后才会出现在纸上</span>'}
      </div>

      <div class="ex-row">
        <span class="ex-k">格式</span>
        <div class="seg">${EXPORT_FMTS.map(f => `
          <button type="button" data-exp-fmt="${f.key}" class="${fmt === f.key ? 'on' : ''}">${f.label}</button>`).join('')}
        </div>
      </div>

      <div class="ex-block${mdOn ? ' off' : ''}" id="exTplBlock">
        <div class="ex-row">
          <span class="ex-k">版式</span>
          <span class="ex-note" id="exTplNote"${mdOn ? '' : ' hidden'}>Markdown 是纯文本，不套版式</span>
        </div>
        <div class="tpl-grid">
          ${tpls.map(t => `
          <button type="button" class="tpl${tplKey === t.key ? ' on' : ''}" data-tpl="${esc(t.key)}">
            <span class="tpl-name">${esc(t.label)}${t.custom ? ' ◆' : ''}</span>
            <span class="tpl-thumb">${tplThumb(t.thumb)}</span>
          </button>`).join('')}
          <button type="button" class="tpl tpl-more" data-act="tpl-more">
            <span class="tpl-name">更多模板</span>
            <span class="tpl-thumb"><svg viewBox="0 0 60 78" aria-hidden="true"><rect width="60" height="78" rx="3.5" fill="#f2f5f3"/><path d="M30 26v26M17 39h26" stroke="#9db8ad" stroke-width="3" stroke-linecap="round"/></svg></span>
          </button>
        </div>
      </div>

      <div class="ex-block inc-block">
        <div class="ex-row">
          <span class="ex-k">包含内容</span>
          <span class="ex-note" id="exIncNote">${incCount === S.experiences.length ? `全部 ${incCount} 条` : `${incCount} / ${S.experiences.length} 条`}</span>
        </div>
        <div class="inc-list">
          ${rows.map(r => `
          <div class="inc-type${r.on ? '' : ' off'}">
            <div class="inc-head">
              <button type="button" class="inc-toggle" data-inc="${esc(r.key)}" ${r.exps.length ? '' : 'disabled'}>
                ${typeIcon(r.key)}<span class="inc-label">${esc(r.label)}</span>
                <em>${r.exps.length ? r.exps.length : '空'}</em>
              </button>
              ${r.exps.length ? `<button type="button" class="inc-caret" data-inc-open="${esc(r.key)}" title="展开 / 收起">▾</button>` : ''}
            </div>
            <div class="inc-body" data-inc-body="${esc(r.key)}" hidden>
              ${r.exps.length ? r.exps.map(e => `
              <label class="inc-item"><input type="checkbox" data-inc-id="${esc(e.id)}" ${!S._expIds || S._expIds.includes(e.id) ? 'checked' : ''}><span>${esc(e.title)}</span><i>${esc(periodOf(e))}</i></label>`).join('')
      : '<span class="inc-empty">还没有这一类的经历</span>'}
            </div>
          </div>`).join('')}
        </div>
      </div>

      <div class="ex-actions">
        <button class="btn btn-primary" id="exDlBtn" data-act="export-dl"><span class="ic ic-out"></span>下载 ${esc(fmtLabel)}</button>
      </div>
    </div>

    <div class="panel panel-preview">
      <div class="row-wrap" style="justify-content:space-between;gap:10px;align-items:center">
        <div class="panel-label" id="previewLabel">${esc(previewLabelText())}</div>
        <span class="gapnote" id="gapNote" hidden></span>
        <div class="pagebar" id="pageBar" hidden>
          <button class="btn btn-sm btn-ghost" id="pgPrev" title="上一页">‹</button>
          <span class="page-num" id="pgNum">1 / 1</span>
          <button class="btn btn-sm btn-ghost" id="pgNext" title="下一页">›</button>
        </div>
        <div class="zoombar">
          <button class="btn btn-sm btn-ghost" id="zoomOut" title="缩小">−</button>
          <span class="zoom-pct" id="zoomPct">100%</span>
          <button class="btn btn-sm btn-ghost" id="zoomIn" title="放大">＋</button>
          <button class="btn btn-sm" id="zoomFit" title="单页放进这一屏">适应</button>
        </div>
      </div>
      <div class="zoom-outer" id="zoomOuter">
        <div class="zoom-stage" id="zoomStage"><iframe class="a4-frame" id="a4" title="导出预览"></iframe></div>
      </div>
    </div>
  </div>`;
};

/* ------------------------------ 我的信息（设置） ------------------------------ */
/* 基本信息页：左下角资料卡进来看到的就这一块。
   电话 / 邮箱 / 性别是简历抬头和联系方式的原料，导出会用得上。 */
VIEWS.profile = function () {
  const p = S.profile;
  const tags = p.majorTags || [];

  return `<div class="grid-2 prof-top">
    <div class="panel">
      <div class="panel-label">身份信息</div>
      <div class="dgrid">
        <div class="field"><label>姓名</label><input class="input" data-set="name" value="${esc(p.name)}" placeholder="如：张明"></div>
        <div class="field"><label>英文名</label><input class="input" data-set="nameEn" value="${esc(p.nameEn || '')}" placeholder="如：Ming Zhang"></div>
        <div class="field"><label>性别</label>
          <select class="input" data-set="gender">
            ${['', '男', '女'].map(g => `<option value="${g}"${(p.gender || '') === g ? ' selected' : ''}>${g || '未填'}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>出生年月</label><input class="input" data-set="birth" value="${esc(p.birth || '')}" placeholder="如：2004.06"></div>
        <div class="field"><label>籍贯</label><input class="input" data-set="hometown" value="${esc(p.hometown || '')}" placeholder="如：福建厦门"></div>
        <div class="field"><label>政治面貌</label><input class="input" data-set="politics" value="${esc(p.politics || '')}" placeholder="如：中共党员 / 共青团员"></div>
        <div class="field"><label>证件照</label>
          <div class="row" style="gap:10px;align-items:center">
            ${p.photo ? `<img class="photo-thumb" src="/attachment/${esc(p.photo)}" alt="证件照">` : '<span class="dim" style="font-size:12.5px">未设置</span>'}
            <span class="row" style="gap:7px">
              <button type="button" class="btn btn-sm" data-act="photo-pick">${p.photo ? '换一张' : '上传照片'}</button>
              ${p.photo ? '<button type="button" class="btn btn-sm btn-ghost" data-act="photo-remove">移除</button>' : ''}
            </span>
          </div>
        </div>
      </div>
    </div>

    <div class="prof-side">
      <div class="panel">
        <div class="panel-label">联系方式</div>
        <div class="dgrid">
          <div class="field"><label>电话</label><input class="input" data-set="phone" value="${esc(p.phone || '')}" placeholder="如：138xxxx0000"></div>
          <div class="field"><label>邮箱</label><input class="input" data-set="email" value="${esc(p.email || '')}" placeholder="如：me@example.com"></div>
          <div class="field"><label>个人主页 / GitHub</label><input class="input" data-set="homepage" value="${esc(p.homepage || '')}" placeholder="如：github.com/yourname"></div>
        </div>
      </div>

      <div class="panel">
        <div class="field" style="margin-bottom:2px">
          <label>专业</label>
          <div class="major-picked">
            ${(p.majors || []).length
      ? (p.majors || []).map(m => `<span class="chip chip-accent mchip">${esc(m)}<button class="mchip-x" data-delmajor="${esc(m)}" title="移除">×</button></span>`).join('')
      : '<span class="dim" style="font-size:12.5px">还没填。填了之后，首页推荐才知道该推什么给你。</span>'}
          </div>
          <div class="major-search">
            <span class="ic ic-search"></span>
            <input class="input" id="majorQ" placeholder="如「计算机」「自动化」「临床」，会自己找相近的" autocomplete="off">
          </div>
          <div class="sugg-list" id="majorSugg" hidden></div>
        </div>

        <div class="panel-foot" id="majorEcho" style="line-height:1.75">
          ${tags.length
      ? `已识别方向：<b>${tags.map(esc).join(' · ')}</b><br><span id="majorCoverage" class="dim"></span>`
      : '专业库来自教育部《普通高等学校本科专业目录（2024年）》——12 个门类、93 个专业类、816 个专业，不用自己记。'}
        </div>
      </div>
    </div>

    <div class="panel span-all">
      <div class="panel-label">教育背景</div>
      <div class="dgrid" style="grid-template-columns:repeat(4,1fr)">
        <div class="field"><label>学校</label><input class="input" data-set="school" value="${esc(p.school)}" placeholder="如：某某大学"></div>
        <div class="field"><label>学院</label><input class="input" data-set="college" value="${esc(p.college || '')}" placeholder="如：信息学院"></div>
        <div class="field"><label>年级</label><input class="input" data-set="grade" value="${esc(p.grade)}" placeholder="如：大三"></div>
        <div class="field"><label>学制年份</label><input class="input" data-set="studyYears" value="${esc(p.studyYears || '')}" placeholder="如：2023.09 – 2027.06"></div>
        <div class="field"><label>GPA</label><input class="input" data-set="gpa" value="${esc(p.gpa || '')}" placeholder="如：3.82 / 4.0"></div>
        <div class="field"><label>专业排名</label><input class="input" data-set="majorRank" value="${esc(p.majorRank || '')}" placeholder="如：5 / 120（前 4%）"></div>
        <div class="field" style="grid-column:span 2"><label>英语成绩</label><input class="input" data-set="englishScore" value="${esc(p.englishScore || '')}" placeholder="如：CET-6 588 / IELTS 7.0 / TOEFL 102"></div>
      </div>
    </div>
  </div>`;
};

/* =============================== 竞赛库视图 =============================== */
/* 左侧导航单设的一栏：概览里那个「可以开始准备的竞赛」是精简版，
   这里给完整信息——档次、时间窗、主办方、对口方向、官网，加自己的新竞赛也在这。 */

function libFiltered() {
  let items = S._libItems || [];
  if (S._libReco && (S._recs || []).length) items = S._recs;   // 推荐结果带 _score 排序
  const q = (S._libq || '').trim().toLowerCase();
  if (q) {
    items = items.filter(i => ((i.name || '') + (i.nameEn || '') + (i.short || '') +
      (i.category || '') + (i.organizer || '')).toLowerCase().includes(q));
  }
  if (S._librecog) items = items.filter(i => (i.recognition || '未认定') === S._librecog);
  return items;
}

function libCard(it, i) {
  const inTrack = S.experiences.some(e => e.fromLibrary && e.fromLibrary.id === it.id);
  const tags = (it.majorTags || []).slice(0, 6);
  const months = (typeof it.monthsUntil === 'number' && it.monthsUntil < 12)
    ? (it.monthsUntil === 0 ? '本月开始' : `约 ${it.monthsUntil} 个月后开始`) : '';
  return `<div class="panel enter" style="--i:${Math.min(i, 10)};gap:10px">
    <div class="row" style="justify-content:space-between;align-items:flex-start;gap:10px">
      <div style="min-width:0">
        <b style="font-size:14.5px;font-weight:600;line-height:1.5">${esc(it.name)}</b>
        ${it.nameEn ? `<div class="dim" style="font-size:12px;margin-top:2px">${esc(it.nameEn)}</div>` : ''}
        ${it.intro ? `<div style="font-size:12.5px;color:var(--ink-2);line-height:1.7;margin-top:4px">${esc(it.intro)}</div>` : ''}
      </div>
      ${(it.matchMajors && it.matchMajors.length) ? '<span class="chip chip-accent">对口你的方向</span>' : ''}
    </div>
    <div class="dgrid" style="grid-template-columns:repeat(4,1fr);gap:8px 14px;font-size:12.5px">
      <div><span class="dim" style="font-size:11.5px">类别</span><br>${esc(it.category || '—')}</div>
      <div><span class="dim" style="font-size:11.5px">时间窗口</span><br>${esc(it.window || '以官网为准')}</div>
      <div><span class="dim" style="font-size:11.5px">主办方</span><br>${esc(it.organizer || '—')}</div>
      <div><span class="dim" style="font-size:11.5px">校内认定</span><br>${it.recognition ? esc(RECOGNITION_LABEL[it.recognition] || it.recognition) : '名单外'}</div>
    </div>
    ${(tags.length || it.tier || it.custom || months) ? `
    <div class="row-wrap" style="gap:5px">
      ${it.tier ? `<span class="chip chip-line">${esc(TIER_LABEL[it.tier] || it.tier)}</span>` : ''}
      ${it.custom ? '<span class="chip chip-line">自定义</span>' : ''}
      ${months ? `<span class="chip chip-line">${esc(months)}</span>` : ''}
      ${tags.map(t => `<span class="chip chip-line">${esc(t)}</span>`).join('')}
    </div>` : ''}
    <div class="row" style="justify-content:space-between;gap:10px">
      <span></span>
      <span class="row" style="gap:7px">
        ${it.site ? `<a class="btn btn-sm btn-ghost" href="${esc(it.site)}" target="_blank" rel="noopener">官网</a>` : ''}
        <button class="btn btn-sm ${inTrack ? '' : 'btn-primary'}" data-act="add-lib" data-id="${esc(it.id)}"
          title="${inTrack ? '已在档案里，再点一次会把赛程模板补齐' : '建一条对应的经历，赛程节点自动套好'}">${inTrack ? '补齐赛程' : '加入我的档案'}</button>
      </span>
    </div>
  </div>`;
}

/** 只重画列表区，不整页 render——搜索框的焦点就不丢 */
function renderLibList() {
  const v = $('#view');
  const box = v.querySelector('#libList');
  const cnt = v.querySelector('#libCount');
  if (!box) return;
  const items = libFiltered();
  if (cnt) {
    const total = S.library ? S.library.count : 0;
    cnt.textContent = items.length === total ? `共 ${total} 项` : `筛出 ${items.length} / 共 ${total} 项`;
  }
  box.innerHTML = items.length
    ? items.slice(0, 120).map((it, i) => libCard(it, i)).join('')
    : `<div class="empty" style="padding:36px 20px">
        <div class="empty-art" style="width:74px;height:74px">${ART.search}</div>
        <h3>没有匹配的竞赛</h3>
        <p>换个词试试，或者直接把这项竞赛自己加进来。</p>
        <button class="btn btn-sm" data-act="lib-add"><span class="ic ic-plus"></span>添加新竞赛</button>
      </div>`;
  bindActs(box);
}

VIEWS.library = function () {
  const recogs = (S.library && S.library.recognitions) || RECOGNITION_ORDER;
  return `<div class="toolbar" style="max-width:920px">
    <div class="search-wrap" style="flex:1"><span class="ic ic-search"></span>
      <input class="input input-search" id="libq" placeholder="搜索竞赛名称（中 / 英文）、类别、主办方" value="${esc(S._libq || '')}" autocomplete="off"></div>
    <select class="input" id="librecog" style="flex:0 0 auto;width:auto;max-width:9.5em">
      <option value="">全部档次</option>
      ${recogs.map(r => `<option value="${esc(r)}"${S._librecog === r ? ' selected' : ''}>${esc(RECOGNITION_LABEL[r] || r)}</option>`).join('')}
      <option value="未认定"${S._librecog === '未认定' ? ' selected' : ''}>名单外</option>
    </select>
    <button class="btn btn-sm${S._libReco ? ' btn-primary' : ''}" data-act="lib-reco">按我专业推荐</button>
    <button class="btn btn-sm" data-act="lib-add"><span class="ic ic-plus"></span>添加新竞赛</button>
  </div>
  <div id="libCount" class="dim" style="font-size:12px;margin-bottom:10px"></div>
  <div id="libList" class="col" style="gap:12px;max-width:920px"></div>`;
};

/* 添加新竞赛：三个字段——中文名、英文名、网址。加进库之后就能「加入我的档案」套赛程。 */
function openCustomLibModal() {
  const m = openModal('添加新竞赛', `
    <div class="field"><label>竞赛中文名</label>
      <input class="input" id="clName" placeholder="如：全国大学生节能减排社会实践与科技竞赛"></div>
    <div class="field"><label>竞赛英文名 <span class="dim">（英文简历的标题用它，可以后补）</span></label>
      <input class="input" id="clNameEn" placeholder="如：National College Energy Saving Competition"></div>
    <div class="field"><label>竞赛网址</label>
      <input class="input" id="clSite" placeholder="如：https://example.com/contest"></div>`,
    `<button class="btn" data-m="close">取消</button>
     <button class="btn btn-primary" id="clGo">加入竞赛库</button>`);
  const go = m.querySelector('#clGo');
  go.onclick = async () => {
    const name = m.querySelector('#clName').value.trim();
    if (!name) { toast('中文名不能为空', 'bad'); m.querySelector('#clName').focus(); return; }
    go.disabled = true;
    try {
      await api('/api/library/custom', { method: 'POST', body: {
        name,
        nameEn: m.querySelector('#clNameEn').value.trim(),
        site: m.querySelector('#clSite').value.trim()
      } });
      m.close();
      await refresh(); render();
      toast(`「${name}」已加入竞赛库`);
    } catch (e) { toast(String(e.message || e).replace(/^.*?error["':]+\s*/i, ''), 'bad'); go.disabled = false; }
  };
  m.querySelector('#clName').onkeydown = e => { if (e.key === 'Enter') go.click(); };
  setTimeout(() => m.querySelector('#clName').focus(), 60);
}

/* 设置页：机器侧的开关。关于人的信息在「基本信息」（左下角资料卡进）。 */
VIEWS.settings = function () {
  const p = S.profile;

  return `<div class="grid-2" style="align-items:start">
    <div class="panel">
      <div class="panel-label">提醒</div>
      <label class="check"><input type="checkbox" data-set="remind.enabled" ${p.remind.enabled ? 'checked' : ''}>启用每日检查</label>
      <div class="dgrid">
        <div class="field"><label>每天几点检查</label><input class="input" type="time" data-set="remind.time" value="${esc(p.remind.time)}"></div>
        <div class="field"><label>提前几天提醒</label><input class="input" data-set="remind.days" value="${esc((p.remind.days || []).join(','))}" placeholder="7,3,1"></div>
      </div>
      <div class="field"><label>送达渠道</label>
        <div class="row-wrap" style="gap:6px 14px">
          <label class="check"><input type="checkbox" data-channel="desktop" ${(p.remind.channels || []).includes('desktop') ? 'checked' : ''}>桌面通知</label>
          <label class="check"><input type="checkbox" data-channel="email" ${(p.remind.channels || []).includes('email') ? 'checked' : ''}>邮件</label>
        </div>
      </div>
      <details class="smtp" ${p.remind.smtp ? 'open' : ''}>
        <summary>邮箱设置（可选）</summary>
        <div class="dgrid" style="margin-top:10px">
          <div class="field"><label>SMTP 服务器</label><input class="input" data-smtp="host" value="${esc((p.remind.smtp && p.remind.smtp.host) || '')}" placeholder="smtp.qq.com"></div>
          <div class="field"><label>端口</label><input class="input" data-smtp="port" value="${esc((p.remind.smtp && p.remind.smtp.port) || '465')}"></div>
          <div class="field"><label>发件邮箱</label><input class="input" data-smtp="user" value="${esc((p.remind.smtp && p.remind.smtp.user) || '')}"></div>
          <div class="field"><label>授权码 / 密码</label><input class="input" type="password" data-smtp="pass" value="${esc((p.remind.smtp && p.remind.smtp.pass) || '')}"></div>
          <div class="field" style="grid-column:span 2"><label>收件邮箱</label><input class="input" data-smtp="to" value="${esc((p.remind.smtp && p.remind.smtp.to) || '')}"></div>
        </div>
      </details>
      <div class="row-wrap" style="gap:9px">
        <button class="btn btn-sm" data-act="remind-preview">看这次会发什么</button>
        <button class="btn btn-sm btn-primary" data-act="remind-run">立刻检查一次</button>
      </div>
    </div>

    <div class="panel">
      <div class="panel-label">经历类型</div>
      <div class="row-wrap" style="gap:7px">
        ${TYPE_LIST.map(t => `<span class="chip chip-line">${typeIcon(t.key)}${esc(t.label)}${t.custom ? `<button class="mchip-x" data-deltype="${esc(t.key)}" title="删除这个类型">×</button>` : ''}</span>`).join('')}
        <button class="btn btn-xs btn-quiet" data-act="add-type"><span class="ic ic-plus"></span>加一个类型</button>
      </div>
      <div class="panel-foot" style="line-height:1.75">
        加的类型在「新增经历」里就能选；删掉只是以后不能再选，<b>已经录进去的经历不会丢</b>。
      </div>
    </div>
  </div>`;
};

/* 自定义经历类型：设置里加，加完「新增经历」里立刻能选 */
async function addTypeModal() {
  const label = await promptModal({
    title: '新增经历类型',
    label: '叫什么',
    placeholder: '如：社团任职 / 讲座 / 培训',
    ok: '添加'
  });
  if (!label || !label.trim()) return null;
  const name = label.trim().slice(0, 12);
  const list = (S.profile.customTypes || []).slice();
  if (list.some(t => t.label === name)) { toast('这个类型已经有了', 'warn'); return null; }
  const r = await api('/api/profile', { method: 'PUT', body: { customTypes: list.concat([{ label: name }]) } });
  await refresh();
  render();
  const saved = (r.profile.customTypes || []).find(t => t.label === name);
  toast(`已添加类型「${name}」`);
  return saved || null;
}

/* =============================== 事件绑定 =============================== */

/* 把 [data-go] / [data-open] / [data-act] 绑到给定容器里的元素上。
   抽出来是因为右上角那排按钮渲染在 #topbarActions —— 它在 <header> 里、#view 外面。
   之前只绑 #view，那些按钮就一个都没绑上，点上去毫无反应。 */
function bindActs(root) {
  if (!root) return;

  root.querySelectorAll('[data-go]').forEach(el => el.onclick = e => {
    if (e.target.closest('button[data-act]')) return;
    go(el.dataset.go);
  });

  root.querySelectorAll('[data-open]').forEach(el => el.onclick = e => {
    if (e.target.closest('a') || e.target.closest('button[data-act]') || e.target.closest('label.check')) return;
    openDrawer(el.dataset.open);
  });

  root.querySelectorAll('[data-act]').forEach(el => el.onclick = async e => {
    e.stopPropagation();
    await handleAct(el.dataset.act, el);
  });
}

function bindView() {
  const v = $('#view');

  bindActs(v);
  bindActs($('#topbarActions'));

  const fq = v.querySelector('#fq');
  if (fq) {
    fq.oninput = debounce(() => {
      S.filter.q = fq.value;
      render();
      const n = $('#fq');
      if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
    }, 240);
  }
  const ft = v.querySelector('#ftype');
  if (ft) ft.onchange = () => { S.filter.type = ft.value; render(); };
  const fs = v.querySelector('#fstage');
  if (fs) fs.onchange = () => { S.filter.stage = fs.value; render(); };
  const fm = v.querySelector('#fmat');
  if (fm) {
    fm.oninput = debounce(() => {
      S.filter.matq = fm.value;
      render();
      const n = $('#fmat');
      if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
    }, 240);
  }

  v.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { S.mode.archive = b.dataset.mode; render(); });
  v.querySelectorAll('[data-smode]').forEach(b => b.onclick = () => { S.mode.schedule = b.dataset.smode; render(); });
  v.querySelectorAll('[data-mmode]').forEach(b => b.onclick = () => { S.mode.materials = b.dataset.mmode; render(); });

  /* —— 竞赛库：搜索/筛选只重画列表区（renderLibList 内部自己重绑按钮） —— */
  const libq = v.querySelector('#libq');
  if (libq) {
    libq.oninput = debounce(() => { S._libq = libq.value; renderLibList(); }, 220);
  }
  const lr = v.querySelector('#librecog');
  if (lr) lr.onchange = () => { S._librecog = lr.value; renderLibList(); };
  if (libq || lr) renderLibList();

  /* —— 导出：口径 / 语言 / 格式 / 版式 / 内容范围 ——
     这几处都**不整页重绘**：重绘会把 iframe 重建一遍，预览会闪。
     所以只改 class、写配置，然后单独把 iframe 的 src 换掉。 */
  v.querySelectorAll('[data-exp-profile]').forEach(b => b.onclick = async () => {
    const key = b.dataset.expProfile;
    if (key === curExportProfile()) return;
    await api('/api/profile', { method: 'PUT', body: { export: { profile: key } } });
    S.profile.export.profile = key;
    v.querySelectorAll('[data-exp-profile]').forEach(x => x.classList.toggle('on', x === b));
    // 换口径要连带刷新语言（出国锁定英文）和照片（按口径默认值）两组高亮
    const zh = v.querySelector('[data-exp-lang="zh"]'), en = v.querySelector('[data-exp-lang="en"]');
    if (zh && en) {
      const eff = effectiveExportLang();
      zh.classList.toggle('on', eff === 'zh');
      en.classList.toggle('on', eff === 'en');
      zh.disabled = key === 'chuguo';
      if (zh.disabled) zh.title = '出国稿固定英文';
    }
    v.querySelectorAll('[data-exp-photo]').forEach(x =>
      x.classList.toggle('on', (x.dataset.expPhoto === '1') === curExportPhoto()));
    const lb = v.querySelector('#previewLabel');
    if (lb) lb.textContent = previewLabelText();
    syncExportPreview();
  });

  v.querySelectorAll('[data-exp-lang]').forEach(b => b.onclick = async () => {
    const key = b.dataset.expLang;
    if (key === effectiveExportLang() || (key === 'zh' && curExportProfile() === 'chuguo')) return;
    await api('/api/profile', { method: 'PUT', body: { export: { lang: key } } });
    S.profile.export.lang = key;
    v.querySelectorAll('[data-exp-lang]').forEach(x => x.classList.toggle('on', x.dataset.expLang === effectiveExportLang()));
    syncExportPreview();
  });

  /* 照片开关按口径分别记，所以存的是整个 photoOn 对象（export 合并是一层浅合并） */
  v.querySelectorAll('[data-exp-photo]').forEach(b => b.onclick = async () => {
    const on = b.dataset.expPhoto === '1';
    if (on === curExportPhoto()) return;
    const cur = curExportProfile();
    const next = { ...((S.profile.export && S.profile.export.photoOn) || {}), [cur]: on };
    await api('/api/profile', { method: 'PUT', body: { export: { photoOn: next } } });
    S.profile.export.photoOn = next;
    v.querySelectorAll('[data-exp-photo]').forEach(x => x.classList.toggle('on', (x.dataset.expPhoto === '1') === on));
    syncExportPreview();
  });

  /* 选格式只切预览，不触发下载——下载按钮单独在下面 */
  v.querySelectorAll('[data-exp-fmt]').forEach(b => b.onclick = () => {
    const key = b.dataset.expFmt;
    if (key === curExportFmt()) return;
    S._expFmt = key;
    v.querySelectorAll('[data-exp-fmt]').forEach(x => x.classList.toggle('on', x === b));
    const mdOn = key === 'md';
    const block = v.querySelector('#exTplBlock');
    if (block) block.classList.toggle('off', mdOn);
    // 只有 Markdown 才需要解释「为什么版式不能选」，其它时候这块留白就够
    const note = v.querySelector('#exTplNote');
    if (note) note.hidden = !mdOn;
    const lb = v.querySelector('#previewLabel');
    if (lb) lb.textContent = previewLabelText();
    const dl = v.querySelector('#exDlBtn');
    if (dl) dl.innerHTML = `<span class="ic ic-out"></span>下载 ${esc((EXPORT_FMTS.find(f => f.key === key) || {}).label)}`;
    syncExportPreview();
  });

  v.querySelectorAll('[data-tpl]').forEach(b => b.onclick = async () => {
    const key = b.dataset.tpl;
    if (key === curExportTemplate() || curExportFmt() === 'md') return;
    await api('/api/profile', { method: 'PUT', body: { export: { template: key } } });
    S.profile.export.template = key;
    v.querySelectorAll('[data-tpl]').forEach(x => x.classList.toggle('on', x === b));
    const lb = v.querySelector('#previewLabel');
    if (lb) lb.textContent = previewLabelText();
    syncExportPreview();
  });

  /* 「包含内容」：类型开关 + 展开后的逐条勾选 */
  const updateIncUI = () => {
    for (const row of expTypeRows()) {
      // inc-type 本体不带 data 属性，从它里面的类型开关反查回去
      const t = v.querySelector(`[data-inc="${CSS.escape(row.key)}"]`);
      const el = t ? t.closest('.inc-type') : null;
      if (!el) continue;
      el.classList.toggle('off', !row.on);
      el.querySelectorAll('[data-inc-id]').forEach(cb => {
        cb.checked = !S._expIds || S._expIds.includes(cb.dataset.incId);
      });
    }
    const note = v.querySelector('#exIncNote');
    if (note) {
      const n = S._expIds ? S._expIds.length : S.experiences.length;
      note.textContent = n === S.experiences.length ? `全部 ${n} 条` : `${n} / ${S.experiences.length} 条`;
    }
  };

  v.querySelectorAll('[data-inc]').forEach(b => b.onclick = () => {
    const key = b.dataset.inc;
    const exps = S.experiences.filter(e => e.type === key);
    if (!exps.length) return;
    const cur = S._expIds ? S._expIds.slice() : S.experiences.map(e => e.id);
    const ids = exps.map(e => e.id);
    const allOn = ids.every(id => cur.includes(id));
    const next = allOn ? cur.filter(id => !ids.includes(id)) : cur.concat(ids.filter(id => !cur.includes(id)));
    // 一个不剩 = 没做筛选，别留一个空数组在那儿（那会导出一份空简历）
    S._expIds = (next.length === 0 || next.length === S.experiences.length) ? null : next;
    updateIncUI();
    syncExportPreview();
  });

  v.querySelectorAll('[data-inc-open]').forEach(b => b.onclick = ev => {
    ev.stopPropagation();
    const body = v.querySelector(`[data-inc-body="${CSS.escape(b.dataset.incOpen)}"]`);
    if (!body) return;
    body.hidden = !body.hidden;
    b.classList.toggle('open', !body.hidden);
  });

  v.querySelectorAll('[data-inc-id]').forEach(cb => cb.onchange = () => {
    const cur = S._expIds ? S._expIds.slice() : S.experiences.map(e => e.id);
    const next = cb.checked ? cur.concat([cb.dataset.incId]) : cur.filter(id => id !== cb.dataset.incId);
    S._expIds = (next.length === 0 || next.length === S.experiences.length) ? null : next;
    updateIncUI();
    syncExportPreview();
  });

  syncExportPreview();
  bindPreviewZoom();

  v.querySelectorAll('[data-delmajor]').forEach(b => b.onclick = () => removeMajor(b.dataset.delmajor));
  v.querySelectorAll('[data-deltype]').forEach(b => b.onclick = async () => {
    const key = b.dataset.deltype;
    const def = typeDef(key);
    const n = S.experiences.filter(e => e.type === key).length;
    const ok = await confirmModal({
      title: '删掉这个类型',
      body: `以后不能再选「${esc(def ? def.label : key)}」了。` +
        (n ? `<br><span class="dim">已经有 ${n} 条经历用了它，那些经历不会丢，只是类型名会显示成原始代号。</span>`
          : '<br><span class="dim">目前没有经历在用它。</span>'),
      ok: '删除', danger: true
    });
    if (!ok) return;
    const list = (S.profile.customTypes || []).filter(t => t.key !== key);
    await api('/api/profile', { method: 'PUT', body: { customTypes: list } });
    await refresh(); render();
    toast('已删除该类型');
  });

  const mq = v.querySelector('#majorQ');
  if (mq) {
    mq.oninput = debounce(() => suggestMajors(mq.value), 220);
    mq.onfocus = () => suggestMajors(mq.value);
    mq.onkeydown = e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const first = $('#majorSugg .sugg');
      // 列表里有候选就选第一条；没有就把用户打的字原样存下来——
      // 专业目录不可能穷尽所有叫法，别让人卡在这儿。
      addMajor(first ? first.dataset.name : mq.value);
    };
  }
  paintCoverage();

  // 节点完成
  v.querySelectorAll('[data-donetoggle]').forEach(cb => cb.onchange = async () => {
    const [expId, nodeId] = cb.dataset.donetoggle.split('|');
    const exp = S.experiences.find(x => x.id === expId);
    const node = exp && (exp.nodes || []).find(n => n.id === nodeId);
    if (!node) return;
    node.done = cb.checked;
    node.doneAt = cb.checked ? new Date().toISOString() : '';
    const row = cb.closest('.tl-row');
    if (row) { row.classList.add('justdone'); row.classList.toggle('done', cb.checked); }
    await saveExp(exp, true);
    toast(cb.checked ? '完成，记下了' : '已恢复为未完成');
    render();
  });

  // 复盘：每张卡自己显示保存状态
  v.querySelectorAll('[data-retro]').forEach(ta => {
    ta.oninput = debounce(async () => {
      const [id, key] = ta.dataset.retro.split('|');
      const exp = S.experiences.find(x => x.id === id);
      if (!exp) return;
      exp.retro = exp.retro || { good: '', bad: '', reuse: '' };
      exp.retro[key] = ta.value;
      await saveExp(exp, true);
      const bar = v.querySelector(`[data-save="${id}"]`);
      if (bar) { bar.classList.add('show'); setTimeout(() => bar.classList.remove('show'), 1500); }
    }, 700);
  });

  // 材料库里的「可复用」开关
  v.querySelectorAll('[data-mat-reuse2]').forEach(cb => cb.onchange = async () => {
    const [expId, matId] = cb.dataset.matReuse2.split('|');
    const exp = S.experiences.find(x => x.id === expId);
    const m = exp && (exp.materials || []).find(x => x.id === matId);
    if (!m) return;
    m.reusable = cb.checked;
    await saveExp(exp, true);
    toast(cb.checked ? '已标为可复用' : '已取消可复用');
    render();
  });

  // 材料卡上的「预览」
  v.querySelectorAll('[data-mat-view]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const [expId, matId] = b.dataset.matView.split('|');
    const exp = S.experiences.find(x => x.id === expId);
    if (exp) openMatPreview(exp, matId);
  });

  // 设置项
  v.querySelectorAll('[data-set]').forEach(el => el.onchange = async () => {
    const path = el.dataset.set;
    let val;
    if (el.type === 'checkbox') val = el.checked;
    else if (path === 'remind.days') val = el.value.split(/[,，\s]+/).map(Number).filter(n => n > 0);
    else val = el.value;
    const patch = {};
    if (path.includes('.')) { const [a, b] = path.split('.'); patch[a] = { [b]: val }; } else patch[path] = val;
    await api('/api/profile', { method: 'PUT', body: patch });
    await refresh();
    toast('已保存');
  });

  // 专业不再是一堆复选框，而是「打字 → 找相近 → 点一下加进来」，见 suggestMajors()

  v.querySelectorAll('[data-channel]').forEach(cb => cb.onchange = async () => {
    const list = Array.from(v.querySelectorAll('[data-channel]:checked')).map(x => x.dataset.channel);
    await api('/api/profile', { method: 'PUT', body: { remind: { channels: list } } });
    await refresh();
    toast('已保存');
  });

  v.querySelectorAll('[data-smtp]').forEach(el => el.onchange = async () => {
    const smtp = { ...(S.profile.remind.smtp || {}) };
    smtp[el.dataset.smtp] = el.value;
    await api('/api/profile', { method: 'PUT', body: { remind: { smtp } } });
    await refresh();
    toast('邮箱设置已保存');
  });
}

/* ============ 专业：自由输入 + 相近查找（设置页） ============ */

/** 敲字就地给候选；候选自己带专业类与方向，点一下即加入 */
async function suggestMajors(q) {
  const box = $('#majorSugg');
  if (!box) return;
  const kw = String(q || '').trim();
  try {
    const r = await api('/api/majors/search?q=' + encodeURIComponent(kw));
    if (r.items.length) {
      box.innerHTML = r.items.map(it => `
        <button type="button" class="sugg" data-name="${esc(it.name)}">
          <b>${esc(it.name)}</b>
          <span>${esc(it.disc)} · ${esc(it.cat)}${(it.tracks || []).length ? ' · ' + it.tracks.map(esc).join('/') : ''}</span>
          <em>${esc(it.how || '')}</em>
        </button>`).join('');
    } else {
      box.innerHTML = `<div class="sugg-none">专业目录里没有「${esc(kw)}」。<br>
        按 <b>回车</b> 可以直接把你打的这个名字存下来——推荐会退化成通用排序，不影响使用。</div>`;
    }
    box.querySelectorAll('.sugg').forEach(b => b.onclick = () => addMajor(b.dataset.name));
    box.hidden = false;
  } catch (_) { box.hidden = true; }
}

async function addMajor(name) {
  const n = String(name || '').trim();
  if (!n) return;
  const list = (S.profile.majors || []).slice();
  if (list.includes(n)) { toast('这个专业已经加过了', 'warn'); return; }
  if (list.length >= 8) { toast('最多 8 个专业，先去掉一个再加', 'warn'); return; }
  list.push(n);
  await api('/api/profile', { method: 'PUT', body: { majors: list } });
  await refresh(); render();
  toast('已加入：' + n + '，推荐排序已重算');
}

async function removeMajor(name) {
  const list = (S.profile.majors || []).filter(m => m !== name);
  await api('/api/profile', { method: 'PUT', body: { majors: list } });
  await refresh(); render();
  toast('已移除：' + name);
}

/** 告诉用户「你这个方向，库里到底有多少对口的」——没有就直说 */
async function paintCoverage() {
  const el = $('#majorCoverage');
  if (!el) return;
  const tags = (S.profile && S.profile.majorTags) || [];
  if (!tags.length) return;
  el.textContent = '正在对库…';
  try {
    const r = await api('/api/majors/coverage?tags=' + encodeURIComponent(tags.join(',')));
    const c = r.coverage;
    if (!c || !c.matched) {
      el.textContent = '库里暂时没有对口这些方向的赛事——这一块确实是我们覆盖不到的地方，遇到相关的比赛自己加一条就行。';
      return;
    }
    el.textContent = `库里对口这些方向的赛事有 ${c.matched} 项，首页会按相关度排给你。`;
  } catch (_) { el.textContent = ''; }
}

/* ============ 导出预览：只换 iframe 的 src，不整页重绘 ============ */

/* A4 @96dpi：预览文档本身就是 794 宽，一页高 1123。
   分页模型：iframe 固定一页高，文档在里面滚，「第 N 页」= scrollTop 的第 N 格。 */
const A4_W = 794, A4_H = 1123;

/** 预览文档的页数：分页脚本拆成几张 .a4 纸就是几页；脚本还没跑完就用文档高估一版 */
function countPages(f) {
  try {
    const d = f.contentDocument;
    const sheets = d ? d.querySelectorAll('.a4') : null;
    if (sheets && sheets.length) return sheets.length;
    const h = d && d.documentElement ? d.documentElement.scrollHeight : 0;
    return Math.max(1, Math.ceil((h - 8) / A4_H));
  } catch (_) { return 1; }
}

function syncExportPreview() {
  const f = $('#a4');
  if (!f) return;
  const want = '/api/export/preview?' + exportQuery();
  if (f.dataset.src === want) return;
  f.dataset.src = want;
  // 预览文档是同源的，可以直接读它里面有多少处「待补」。
  // 那块提示排在 A4 纸下面，不主动说一声用户多半滚不到。
  f.onload = () => {
    // 页数：预览里的分页脚本会按内容把纸拆成多张 .a4，几张就是几页；
    // 脚本要等字体图片就绪才跑，跑完回调 __onPaginated 把页数校正过来。
    const total = countPages(f);
    S._page = { n: 1, total };
    try {
      f.contentWindow.__onPaginated = () => {
        const t = countPages(f);
        S._page.total = t;
        S._page.n = Math.min(S._page.n || 1, t);
        const bar2 = $('#pageBar');
        if (bar2) bar2.hidden = t <= 1;
        const num2 = $('#pgNum');
        if (num2) num2.textContent = `${S._page.n} / ${t}`;
      };
      if (f.contentWindow.__pagesReady) f.contentWindow.__onPaginated();
    } catch (_) { }
    const bar = $('#pageBar');
    if (bar) {
      bar.hidden = total <= 1;
      const num = $('#pgNum');
      if (num) num.textContent = `1 / ${total}`;
    }
    try { f.contentWindow.scrollTo(0, 0); } catch (_) { }
    attachPreviewDocHooks(f);
    const note = $('#gapNote');
    if (!note) return;
    let n = 0;
    try {
      const d = f.contentDocument;
      const b = d && d.querySelector('.gaps b');
      const m = b && /（(\d+) 处）/.exec(b.textContent || '');
      n = m ? Number(m[1]) : 0;
    } catch (_) { n = 0; }
    note.hidden = !n;
    note.textContent = n ? `纸下面还有 ${n} 处没填完` : '';
    note.onclick = () => {
      try { f.contentWindow.scrollTo({ top: f.contentDocument.body.scrollHeight, behavior: 'smooth' }); } catch (_) { }
    };
    // 文档换了一份（版式换了、内容多了），把当前缩放态重新套上：
    // 适应态重算比例，手动态原样恢复——切走再切回来比例不变就是靠这条。
    const z = S._tplZoom;
    if (z) { if (z.auto) z.fit(); else z.apply(z.v); }
  };
  f.src = want;
}

/** 翻到第 n 页（滚到第 n 张纸的页首；老文档没有纸就按一页高滚） */
function setA4Page(n) {
  const f = $('#a4');
  const p = S._page;
  if (!f || !p || !p.total) return;
  const c = Math.min(Math.max(1, n), p.total);
  p.n = c;
  try {
    const doc = f.contentDocument;
    const sheet = doc ? doc.querySelectorAll('.a4')[c - 1] : null;
    f.contentWindow.scrollTo(0, sheet ? sheet.offsetTop : (c - 1) * A4_H);
  } catch (_) { }
  const num = $('#pgNum');
  if (num) num.textContent = `${c} / ${p.total}`;
}

/** 预览文档（同源 iframe）每次加载完，都要重新挂两样东西：
    ① Ctrl+滚轮缩放——滚轮事件发生在 iframe 文档里，外层容器根本收不到，
       不挂在这里的话「鼠标放在纸上缩放就失效」（用户实测踩到）；
    ② scroll 监听——用户在纸内自由滚动时页码跟着走。 */
function attachPreviewDocHooks(f) {
  let doc;
  try { doc = f.contentDocument; } catch (_) { return; }
  if (!doc) return;
  doc.addEventListener('wheel', e => {
    if (!e.ctrlKey && !e.metaKey) return;   // 普通滚动照常，只接管 Ctrl/⌘+滚轮
    e.preventDefault();                     // 拦掉浏览器对 iframe 的整页缩放
    const z = S._tplZoom;
    if (!z) return;
    z.auto = false;
    z.apply(z.v + (e.deltaY > 0 ? -0.08 : 0.08));
  }, { passive: false, capture: true });
  doc.addEventListener('scroll', () => {
    const p = S._page;
    if (!p || !p.total) return;
    let top = 0;
    try { top = f.contentWindow.scrollY || doc.documentElement.scrollTop || 0; } catch (_) { }
    let n;
    try {
      const sheets = doc.querySelectorAll('.a4');
      if (sheets.length > 1) {
        n = 1;
        sheets.forEach((s, i) => { if (top >= s.offsetTop - 20) n = i + 1; });
      } else {
        n = Math.min(p.total, Math.max(1, Math.round(top / A4_H) + 1));
      }
    } catch (_) { n = Math.min(p.total, Math.max(1, Math.round(top / A4_H) + 1)); }
    n = Math.min(p.total, Math.max(1, n));
    if (n !== p.n) {
      p.n = n;
      const num = $('#pgNum');
      if (num) num.textContent = `${n} / ${p.total}`;
    }
  }, { capture: true, passive: true });
}

/* ============ 预览缩放：Ctrl+滚轮 / 缩放条 / 适应窗口 ============ */

/**
 * 缩放不改字号、不重排文档，只给 iframe 加一层 transform:scale（stage 当占位盒，见 apply）。
 * 理由：① 改字号会让 210mm 的纸不再是 210mm，所见即所得就废了
 *       ② transform 是合成层操作，滚轮连滚不会掉帧
 * 上限放在 2 倍、下限到「单页能塞进这一屏」，两端都能用鼠标停在中间调。
 */
function bindPreviewZoom() {
  const outer = $('#zoomOuter');
  const stage = $('#zoomStage');
  const pct = $('#zoomPct');
  if (!outer || !stage) return;
  // 左栏重画（收藏模板、上传模板）会再跑一遍 bindView，但预览区没重建。
  // 不设这个闸就会出现第二个 wheel 监听器，滚一次缩两档。
  if (outer.dataset.zoomBound === '1') return;
  outer.dataset.zoomBound = '1';

  const clamp = v => Math.min(2, Math.max(0.25, v));

  /** 单页塞进容器需要缩到多少（多页靠翻页，不靠把整份稿子缩成一粒米） */
  const fitScale = () => {
    const availW = outer.clientWidth - 24;
    const availH = outer.clientHeight - 24;
    return clamp(Math.min(availW / A4_W, availH / A4_H));
  };

  const apply = v => {
    const s = clamp(v);
    S._tplZoom.v = s;
    const f = $('#a4');
    // 分工见 styles.css 里 .zoom-stage/.a4-frame 的注释：
    // stage 拿「原始尺寸 × 缩放比」当占位盒（顺便靠 margin:auto 居中），
    // iframe 自己吃 transform——两边各乘一次，合成的可见尺寸才正好等于占位盒。
    stage.style.width = Math.round(A4_W * s) + 'px';
    stage.style.height = Math.round(A4_H * s) + 'px';
    if (f) f.style.transform = `scale(${s})`;
    if (pct) pct.textContent = Math.round(s * 100) + '%';
    return s;
  };
  /** 「适应」= 自动跟随容器；用户一旦手动调过，就不再自作主张改他的比例 */
  const doFit = () => { S._tplZoom.auto = true; return apply(fitScale()); };

  // 缩放态跟着会话走：切到别的栏目再切回来，手动调过的比例原样恢复，
  // 适应态则按当前容器重新适配。没有这一步，每次重进导出页都会被打回适应。
  const prev = S._tplZoom;
  S._tplZoom = { v: prev ? prev.v : 1, auto: prev ? prev.auto : true, fit: doFit, apply };
  if (S._tplZoom.auto) doFit(); else apply(S._tplZoom.v);

  outer.addEventListener('wheel', e => {
    // 只在按住 Ctrl（macOS 的 ⌘）时接管，否则普通滚动该滚还是滚
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    S._tplZoom.auto = false;
    apply(S._tplZoom.v + (e.deltaY > 0 ? -0.08 : 0.08));
  }, { passive: false });

  const zin = $('#zoomIn'), zout = $('#zoomOut'), zfit = $('#zoomFit');
  if (zin) zin.onclick = () => { S._tplZoom.auto = false; apply(S._tplZoom.v + 0.1); };
  if (zout) zout.onclick = () => { S._tplZoom.auto = false; apply(S._tplZoom.v - 0.1); };
  if (zfit) zfit.onclick = () => doFit();

  const bar = $('#pageBar');
  if (bar) {
    const prev1 = $('#pgPrev'), next1 = $('#pgNext');
    if (prev1) prev1.onclick = () => setA4Page((S._page ? S._page.n : 1) - 1);
    if (next1) next1.onclick = () => setA4Page((S._page ? S._page.n : 1) + 1);
  }

  // 容器尺寸变了（拉窗口、折起侧栏），「适应」的值跟着变，
  // 但只在用户本来就是适应态时才自动跟随——手动放大过就别擅自改他的选择。
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => { if (S._tplZoom.auto) doFit(); });
    ro.observe(outer);
  }
}

/* 看板拖拽 */
/* 拖拽改状态已按用户要求移除——阶段在详情页里改，看板只负责看。 */

async function handleAct(act, el) {
  if (act === 'new') return openNewModal();
  if (act === 'pick-lib') return openLibraryModal();
  if (act === 'clear-filter') { S.filter = { q: '', type: '', stage: '', matq: '' }; return render(); }
  if (act === 'mat-clear') { S.filter.matq = ''; S.mode.materials = 'all'; return render(); }
  if (act === 'add-lib') return addFromLibrary(el.dataset.id);
  if (act === 'add-type') return addTypeModal();
  if (act === 'lib-add') return openCustomLibModal();
  if (act === 'lib-reco') { S._libReco = !S._libReco; return render(); }

  if (act === 'remind-preview') return openReminderPreview();
  if (act === 'remind-run') {
    el && (el.disabled = true);
    try {
      const r = await api('/api/reminder/run', { method: 'POST', body: {} });
      if (!r.sent) { toast('当前没有需要提醒的节点'); return; }
      const bad = (r.deliveries || []).filter(d => d.ok === false);
      const okDesk = (r.deliveries || []).some(d => d.channel === 'desktop' && d.ok !== false);
      if (bad.length) {
        toast(`发出 ${r.digest.count} 条，但${bad.map(d => d.channel === 'desktop' ? '桌面通知' : '邮件').join('、')}没成功：${bad[0].reason || '未知原因'}`, 'warn');
      } else {
        toast(`已发出 ${r.digest.count} 条提醒${okDesk ? '，桌面通知已弹出' : ''}`);
      }
    } finally { el && (el.disabled = false); }
    return;
  }

  if (act === 'export-pdf') return exportNow('pdf');
  if (act === 'export-docx') return exportNow('docx');
  if (act === 'export-html') return exportNow('html');
  // 左栏那个大按钮：按当前选中的格式下载，不再一个格式一个按钮
  if (act === 'export-dl') return exportNow(curExportFmt());
  if (act === 'tpl-more') return openTplModal();

  /* —— 证件照：文件转 base64 走附件接口落盘，再把文件名记进 profile —— */
  if (act === 'photo-pick') {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/png,image/jpeg,image/webp';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      if (f.size > 4 * 1024 * 1024) { toast('照片别超过 4MB', 'warn'); return; }
      try {
        const b64 = await new Promise((ok, no) => {
          const r = new FileReader();
          r.onload = () => ok(String(r.result).split(',')[1] || '');
          r.onerror = no;
          r.readAsDataURL(f);
        });
        const up = await api('/api/attachment', { method: 'POST', body: { name: f.name || 'photo.jpg', base64: b64 } });
        await api('/api/profile', { method: 'PUT', body: { photo: up.file } });
        await refresh(); render();
        toast('证件照已更新，简历导出时可以用上');
      } catch (err) { toast('上传失败：' + (err && err.message || err), 'warn'); }
    };
    inp.click();
    return;
  }
  if (act === 'photo-remove') {
    await api('/api/profile', { method: 'PUT', body: { photo: '' } });
    await refresh(); render();
    toast('已移除证件照');
    return;
  }

  if (act === 'lib-reset') {
    const ok = await confirmModal({
      title: '重置竞赛库',
      body: '把竞赛库恢复成内置骨架？<br><span class="dim">你自己手动加进档案的经历不受影响；只是库里那些元信息（主办方、时间窗口、赛程模板）会回到出厂状态。</span>',
      ok: '重置'
    });
    if (!ok) return;
    await api('/api/library/reset', { method: 'POST', body: {} });
    await refresh(); render(); toast('竞赛库已重置');
    return;
  }
  if (act === 'changelog') return openChanges();

  if (act === 'demo-load') {
    const r = await api('/api/demo/load', { method: 'POST', body: {} });
    await refresh(); render();
    toast(`已载入 ${r.created} 条示例经历`);
    return;
  }
  if (act === 'demo-clear') {
    const ok = await confirmModal({
      title: '移除示例经历',
      body: '把全部示例经历移到回收站？<br><span class="dim">用软删除处理——之后还能在「变更与恢复」里找回来。</span>',
      ok: '移除'
    });
    if (!ok) return;
    const r = await api('/api/demo/clear', { method: 'POST', body: {} });
    await refresh(); render();
    toast(`已移除 ${r.removed} 条示例`);
    return;
  }
}

/* 四种出口：
   PDF      —— 让浏览器打印 iframe 里那份 A4 稿。零依赖，中文不会缺字，文字还能选中。
   Word     —— 服务端拼 OOXML（src/docx.js），一律单栏。
   网页     —— 直接落一份自带样式的 HTML，发给谁都能看。
   Markdown —— 纯文本，给笔记软件和版本管理用；不套版式。 */
const EXPORT_TIP = {
  pdf: '在打印窗口里选「另存为 PDF」',
  docx: '正在生成 Word，几秒后开始下载',
  html: '正在生成网页文件',
  md: '正在生成 Markdown'
};
function exportNow(fmt) {
  if (fmt === 'pdf') {
    const f = $('#a4');
    if (!f) return;
    if (!f.dataset.src) { toast('正在准备预览，稍等一下', 'warn'); return; }
    try {
      f.contentWindow.focus();
      f.contentWindow.print();
      toast(EXPORT_TIP.pdf);
    } catch (_) {
      window.open(f.dataset.src, '_blank');
      toast('浏览器拦住了直接打印，已打开预览页——按 Ctrl+P 也一样', 'warn');
    }
    return;
  }
  const a = document.createElement('a');
  a.href = '/api/export/file?' + exportQuery(fmt);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast(EXPORT_TIP[fmt] || '正在生成文件');
}

/* ===================== 模板库（「更多模板」子域） =====================
   左栏只放得下 5 个版式格子，其余都在这里：挑、收藏、上传自己的。 */

/** 上传格式说明——用户问「以什么格式上传」时，答案就在弹窗里，不用去翻文档 */
const TPL_FORMAT_HELP = `<b>JSON 文件</b>（点上面的「下载样例」拿一份改）：
<code>{ "label": "模板名", "desc": "一句话", "layout": "one / two / banner / fresh", "css": ".a4{...}" }</code>
<span class="dim" style="font-size:11px;display:block;margin-top:4px">layout 决定骨架，也决定证件照放哪：one 右上角（右上留空）、two 和 fresh 侧栏顶部、banner 色带右端。</span>`;

async function openTplModal() {
  const all = S.exportTemplates;
  const draw = () => {
    const favN = (S.profile.export.favorites || []).length;
    const cards = all.map(t => {
      const on = isFavTpl(t.key);
      return `<div class="gal-card${on ? ' on' : ''}">
        <button type="button" class="gal-star${on ? ' on' : ''}" data-fav="${esc(t.key)}"
          title="${on ? '取消收藏' : '收藏到导出页'}" ${!on && favN >= MAX_FAV_TPL ? 'disabled' : ''}>${on ? '★' : '☆'}</button>
        <span class="gal-thumb">${tplThumb(t.thumb)}</span>
        <div class="gal-meta">
          <b>${esc(t.label)}${t.custom ? ' ◆' : ''}</b>
          <span class="gal-desc">${esc(t.desc || '')}</span>
          ${t.credit && t.credit.name
        ? `<span class="gal-credit">${esc(t.credit.name)}${t.credit.license ? ' · ' + esc(t.credit.license) : ''}</span>` : ''}
        </div>
        ${t.custom ? `<button type="button" class="gal-del" data-delt="${esc(t.key)}" title="删掉这个上传的模板">删</button>` : ''}
      </div>`;
    }).join('');

    const m = openModal('模板库', `
      <div class="gal-top">
        <span class="dim" style="font-size:12px">收藏会出现在导出页的版式格里，最多 <b>${MAX_FAV_TPL}</b> 个（已收藏 ${favN} 个）</span>
        <a class="btn btn-sm" id="tplSample" href="/api/export/template-sample" download>下载样例</a>
      </div>
      <div class="gal-grid">${cards}</div>
      <div class="gal-up">
        <div class="gal-up-h">上传自己的模板</div>
        <div class="gal-up-note">${TPL_FORMAT_HELP}</div>
        <input type="file" id="tplFile" accept=".json,application/json">
      </div>`, '', { width: 'wide' });

    m.querySelectorAll('[data-fav]').forEach(b => b.onclick = async () => {
      const key = b.dataset.fav;
      const list = (S.profile.export.favorites || []).slice();
      if (list.includes(key)) {
        await api('/api/profile', { method: 'PUT', body: { export: { favorites: list.filter(k => k !== key) } } });
        S.profile.export.favorites = list.filter(k => k !== key);
      } else {
        if (list.length >= MAX_FAV_TPL) { toast(`最多收藏 ${MAX_FAV_TPL} 个，先取消一个`, 'warn'); return; }
        // 收藏到末尾，用户在导出页看到的顺序就是他自己排的顺序
        await api('/api/profile', { method: 'PUT', body: { export: { favorites: list.concat([key]) } } });
        S.profile.export.favorites = list.concat([key]);
      }
      repaintExport();  // 只重画左栏的版式格，弹窗不动
      draw();           // 星标状态跟着变
    });

    m.querySelectorAll('[data-delt]').forEach(b => b.onclick = async () => {
      const key = b.dataset.delt;
      const t = S.exportTemplates.find(x => x.key === key);
      const ok = await confirmModal({
        title: '删掉这个模板',
        body: `「${esc(t ? t.label : key)}」会从列表里消失，之后可以重新上传。`,
        ok: '删除', danger: true
      });
      if (!ok) return;
      const r = await api('/api/export/template?key=' + encodeURIComponent(key), { method: 'DELETE' });
      if (!r.ok) { toast('删除失败', 'bad'); return; }
      // 顺手从收藏里摘掉，否则会留一个指向不存在模板的死收藏
      const favs = (S.profile.export.favorites || []).filter(k => k !== key);
      if (favs.length !== (S.profile.export.favorites || []).length) {
        await api('/api/profile', { method: 'PUT', body: { export: { favorites: favs } } });
        S.profile.export.favorites = favs;
      }
      await refresh();
      repaintExport();
      m.close();
      openTplModal();
      toast('已删除该模板');
    });

    const file = m.querySelector('#tplFile');
    file.onchange = async () => {
      const f = file.files[0];
      if (!f) return;
      try {
        const body = JSON.parse(await f.text());
        const r = await api('/api/export/template', { method: 'POST', body });
        await refresh();
        repaintExport();
        m.close();
        openTplModal();
        toast(`模板「${r.template.label}」已可用，点 ☆ 收藏它`);
      } catch (e) {
        toast('上传失败：' + (e.message || 'JSON 格式不对'), 'bad');
      }
      file.value = '';
    };
  };
  draw();
}

/**
 * 只重画导出页的左栏，不动右栏 iframe——
 * 换收藏/加模板时预览不该跟着闪一下再重新加载。
 */
function repaintExport() {
  const v = $('#view');
  const panel = v && v.querySelector('.ex-panel');
  if (!panel) return;
  const fresh = document.createElement('div');
  fresh.innerHTML = VIEWS.export();
  const next = fresh.querySelector('.ex-panel');
  if (!next) return;
  panel.replaceWith(next);
  bindView();
}

/* 自定义经历类型的入口在设置页（见 addTypeModal）。 */

/* =============================== 抽屉 =============================== */

let openId = null;

function openDrawer(id) {
  const e = S.experiences.find(x => x.id === id);
  if (!e) return;
  openId = id;
  setHash(S.view, id);
  $('#scrim').hidden = false;
  const d = $('#drawer');
  d.hidden = false;
  renderDrawer();
  const body = d.querySelector('.drawer-body');
  if (body) body.scrollTop = 0;
}

function closeDrawer() {
  $('#drawer').hidden = true;
  $('#scrim').hidden = true;
  openId = null;
  setHash(S.view, '');
}

function renderDrawer() {
  const e = S.experiences.find(x => x.id === openId);
  if (!e) return closeDrawer();
  const nodes = (e.nodes || []).slice().sort((a, b) =>
    String(a.dueAt || '9999').localeCompare(String(b.dueAt || '9999')));
  const lib = e.fromLibrary || {};
  const mats = e.materials || [];
  const nDone = nodes.filter(n => n.done).length;

  $('#drawer').innerHTML = `
  <div class="drawer-head">
    <div class="titlewrap">
      <h2 id="dTitle" contenteditable="true" spellcheck="false" title="点一下就能改">${esc(e.title)}</h2>
      <div class="sub">
        <span class="chip chip-line">${typeIcon(e.type)}${esc(typeLabel(e.type))}</span>
        ${e.level ? `<span>${esc(e.level)}</span>` : ''}
        ${e.track ? `<span>· ${esc(e.track)}</span>` : ''}
        ${lib.site ? `<a href="${esc(lib.site)}" target="_blank" rel="noopener">官网</a>` : ''}
      </div>
    </div>
    <button class="btn btn-sm btn-ghost btn-icon" data-dact="close" title="关闭（Esc）"><span class="ic ic-close"></span></button>
  </div>

  <div class="drawer-body">
    <div class="dsec">
      <div class="dsec-head"><h4>基本信息</h4><span class="chip chip-line">${esc(e.stage)}</span></div>
      <div class="dgrid">
        <div class="field"><label>类型</label><select class="input" data-e="type">
          ${TYPE_LIST.map(t => `<option value="${esc(t.key)}"${e.type === t.key ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}
        </select></div>
        <div class="field"><label>阶段</label><select class="input" data-e="stage">${STAGES.map(s => `<option${e.stage === s ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
        ${isAwardish(e.type) && !isCustomType(e.type) ? `
        <div class="field"><label>级别</label><input class="input" data-e="level" value="${esc(e.level)}" placeholder="如：国家级"></div>
        <div class="field"><label>赛道 / 方向</label><input class="input" data-e="track" value="${esc(e.track)}"></div>` : ''}
        <div class="field"><label>英文名</label>
          <input class="input" data-e="titleEn" value="${esc(e.titleEn || '')}" placeholder="如：CUMCM · China Undergraduate Mathematical Contest in Modeling"></div>
        ${isCustomType(e.type) ? '' : `
        <div class="field"><label>简历排序</label>
          <input class="input" type="number" min="1" step="1" data-e="rOrder" value="${esc(e.rOrder || '')}" placeholder="可空；数字小的排前面"></div>`}
        ${isRoleish(e.type) ? `
        <div class="field"><label>${isAwardish(e.type) ? '我的角色' : '我担任'}</label>
          <input class="input" data-e="role" value="${esc(e.role)}" placeholder="${isAwardish(e.type) ? '如：队长 / 后端' : '如：部长 / 志愿者'}"></div>` : ''}
        <div class="field"><label>开始</label><input class="input" type="date" data-e="startedAt" value="${esc(fmt(e.startedAt, false))}"></div>
        <div class="field"><label>结束</label><input class="input" type="date" data-e="endedAt" value="${esc(fmt(e.endedAt, false))}"></div>
      </div>
    </div>

    ${fieldsOf(e.type).length ? `
    <div class="dsec">
      <div class="dsec-head"><h4>${esc(typeLabel(e.type))}的专属信息</h4><span class="dim" style="font-size:11px">导出时会带上</span></div>
      <div class="dgrid">
        ${fieldsOf(e.type).map(f => `
          <div class="field"><label>${esc(f.label)}</label>
            <input class="input" type="${f.type === 'date' ? 'date' : 'text'}" data-meta="${esc(f.key)}"
              value="${esc((e.meta || {})[f.key] || '')}" placeholder="${esc(f.placeholder || '')}"></div>`).join('')}
      </div>
    </div>` : ''}

    <div class="dsec">
      <div class="dsec-head"><h4>成果</h4></div>
      ${isCustomType(e.type) ? '' : `
      <div class="dgrid">
        <div class="field"><label>${isAwardish(e.type) ? '奖项' : '获得的认可 / 评价'}</label>
          <input class="input" data-e="result.award" value="${esc(e.result.award)}"
            placeholder="${isAwardish(e.type) ? '如：国家级一等奖' : '如：校级优秀志愿者'}"></div>
        ${isAwardish(e.type) ? `
        <div class="field"><label>名次 / 排名</label><input class="input" data-e="result.rank" value="${esc(e.result.rank)}" placeholder="如：第 12 名 / 前 5%"></div>` : ''}
      </div>`}
      <div class="field"><label>一句话成果摘要（导出时直接用它）</label>
        <textarea class="input" rows="2" data-e="result.summary" placeholder="如：在 2 万支队伍中进入全国前 3%，负责模型构建与论文撰写">${esc(e.result.summary)}</textarea></div>
    </div>

    <div class="dsec">
      <div class="dsec-head">
        <h4>时间节点 <span class="cnt">${nDone}/${nodes.length} 已完成</span></h4>
        <button class="btn btn-sm" data-dact="add-node"><span class="ic ic-plus"></span>加节点</button>
      </div>
      <div class="col" style="gap:9px">
        ${nodes.length ? nodes.map(n => {
    const st = nodeState(n);
    const d = n.dueAt ? dl(n.dueAt) : null;
    return `<div class="node ${st}">
            <label class="check" style="margin-top:1px"><input type="checkbox" data-node-done="${n.id}" ${n.done ? 'checked' : ''}></label>
            <div style="min-width:0;flex:1">
              <div class="node-title">${esc(n.title)}</div>
              <div class="node-meta">${KIND_LABEL[n.kind] || '提醒'}
                ${n.dueAt ? ' · ' + esc(fmt(n.dueAt, true)) : ' · 未设时间'}
                ${d !== null && !n.done && n.kind !== 'done' ? ' · ' + dlText(d) : ''}</div>
            </div>
            <div class="node-actions">
              <button class="btn btn-xs btn-quiet" data-dact="edit-node" data-node="${n.id}">改</button>
              <button class="btn btn-xs btn-ghost" data-dact="del-node" data-node="${n.id}">删</button>
            </div>
          </div>`;
  }).join('') : '<div class="dim" style="font-size:12.5px;padding:8px 0">还没有节点。加一个带截止时间的节点，它就会进入每日提醒。</div>'}
      </div>
    </div>

    <div class="dsec">
      <div class="dsec-head">
        <h4>材料 <span class="cnt">${mats.length} 份</span></h4>
        <span class="row" style="gap:6px">
          <button class="btn btn-sm btn-quiet" data-dact="add-note">加文字备注</button>
          <button class="btn btn-sm" data-dact="upload"><span class="ic ic-plus"></span>上传文件</button>
        </span>
      </div>
      <div class="col" style="gap:9px">
        ${mats.length ? mats.map(m => `
          <div class="node" style="align-items:center">
            <div style="min-width:0;flex:1">
              <div class="node-title">${esc(m.name)}</div>
              <div class="node-meta">${MAT_KIND[m.kind] || '其他'} · ${fmt(m.addedAt, false)}${m.note ? ' · ' + esc(m.note) : ''}</div>
            </div>
            <label class="check" title="勾上后会在材料库的「可复用模板」里置顶"><input type="checkbox" data-mat-reuse="${m.id}" ${m.reusable ? 'checked' : ''}>可复用</label>
            ${m.file ? `<button class="btn btn-xs btn-quiet" data-dact="mat-view" data-mat="${m.id}">预览</button>
            <a class="btn btn-xs btn-ghost" href="/attachment/${encodeURIComponent(m.file)}?download=1" download>下载</a>` : ''}
            <button class="btn btn-xs btn-ghost" data-dact="del-mat" data-mat="${m.id}">删</button>
          </div>`).join('')
      : '<div class="dim" style="font-size:12.5px;padding:8px 0">还没有材料。文件会被复制进项目目录，原文件删了也不丢。</div>'}
      </div>
      <input type="file" id="matFile" hidden>
    </div>

    <div class="dsec">
      <div class="dsec-head"><h4>复盘</h4><span class="dim" style="font-size:11px">输入即保存</span></div>
      <div class="col" style="gap:10px">
        <div class="field"><label>做对了什么</label><textarea class="input" rows="2" data-e="retro.good">${esc(e.retro.good)}</textarea></div>
        <div class="field"><label>踩了什么坑</label><textarea class="input" rows="2" data-e="retro.bad">${esc(e.retro.bad)}</textarea></div>
        <div class="field"><label>可复用的材料 / 做法</label><textarea class="input" rows="2" data-e="retro.reuse">${esc(e.retro.reuse)}</textarea></div>
      </div>
    </div>
  </div>

  <div class="drawer-foot">
    <span class="savebar" id="saveStatus"><span class="ic ic-check"></span>已保存</span>
    <div class="spacer"></div>
    <button class="btn btn-sm btn-danger" data-dact="del"><span class="ic ic-trash"></span>删除</button>
    <button class="btn btn-sm" data-dact="close">关闭</button>
  </div>`;

  bindDrawer();
}

const saveExp = async function (exp, quiet) {
  try {
    const r = await api('/api/experience', { method: 'POST', body: exp });
    const i = S.experiences.findIndex(x => x.id === r.experience.id);
    if (i >= 0) S.experiences[i] = r.experience; else S.experiences.push(r.experience);
    flashSaved();
    if (!quiet) toast('已保存');
    return r.experience;
  } catch (e) { toast('保存失败：' + e.message, 'bad'); throw e; }
};

let savedTimer = null;
function flashSaved() {
  const el = $('#saveStatus');
  if (!el) return;
  el.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove('show'), 1400);
}

function bindDrawer() {
  const d = $('#drawer');

  d.querySelectorAll('[data-dact]').forEach(b => b.onclick = async e => {
    e.stopPropagation();
    const act = b.dataset.dact;
    const exp = S.experiences.find(x => x.id === openId);
    if (!exp) return;

    if (act === 'close') return closeDrawer();

    if (act === 'del') {
      const ok = await confirmModal({
        title: '删除这条经历',
        body: `「${esc(exp.title)}」会被移到回收站。<br><span class="dim">数据不会真的消失，随时可以在「设置 → 变更与恢复」里还原。</span>`,
        ok: '删除',
        danger: true
      });
      if (!ok) return;
      await api('/api/experience/' + exp.id, { method: 'DELETE' });
      S.experiences = S.experiences.filter(x => x.id !== exp.id);
      closeDrawer(); await refresh(); render();
      toast('已移到回收站');
      return;
    }

    if (act === 'add-node' || act === 'edit-node') return openNodeModal(exp, b.dataset.node);

    if (act === 'mat-view') return openMatPreview(exp, b.dataset.mat);

    if (act === 'del-node') {
      const node = (exp.nodes || []).find(n => n.id === b.dataset.node);
      const ok = await confirmModal({
        title: '删除节点',
        body: `删除「${esc(node ? node.title : '')}」？<br><span class="dim">这个节点上的提醒记录也会一并消失。</span>`,
        ok: '删除', danger: true
      });
      if (!ok) return;
      exp.nodes = (exp.nodes || []).filter(n => n.id !== b.dataset.node);
      await saveExp(exp, true); renderDrawer(); render();
      toast('节点已删除');
      return;
    }

    if (act === 'add-note') {
      const r = await promptModal({
        title: '加一条材料备注',
        label: '材料名称',
        placeholder: '如：校赛报名表（年年能改一改用）',
        ok: '加入材料库'
      });
      if (!r) return;
      exp.materials = exp.materials || [];
      exp.materials.push({
        id: crypto.randomUUID(), name: r, file: '', kind: /报名|登记/.test(r) ? 'form' : 'doc',
        reusable: false, note: '', addedAt: new Date().toISOString()
      });
      await saveExp(exp, true); renderDrawer(); render();
      toast('已加入材料库');
      return;
    }

    if (act === 'upload') {
      const f = d.querySelector('#matFile');
      f.onchange = async () => {
        const file = f.files[0];
        if (!file) return;
        if (file.size > 40 * 1024 * 1024) { toast('文件太大（上限 40MB）', 'bad'); return; }
        b.disabled = true;
        try {
          const b64 = await fileToBase64(file);
          const r = await api('/api/attachment', { method: 'POST', body: { name: file.name, base64: b64.split(',')[1] } });
          exp.materials = exp.materials || [];
          exp.materials.push({
            id: crypto.randomUUID(), name: file.name, file: r.file, kind: guessKind(file.name),
            reusable: false, note: '', addedAt: new Date().toISOString()
          });
          await saveExp(exp, true); renderDrawer(); render();
          toast('已存入材料库（原件删了也不丢）');
        } catch (err) {
          toast('上传失败：' + err.message, 'bad');
        } finally { b.disabled = false; }
      };
      f.click();
      return;
    }

    if (act === 'del-mat') {
      exp.materials = (exp.materials || []).filter(x => x.id !== b.dataset.mat);
      await saveExp(exp, true); renderDrawer(); render();
      toast('已从材料库移除');
      return;
    }
  });

  const title = d.querySelector('#dTitle');
  if (title) {
    title.onkeydown = ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); title.blur(); }
      if (ev.key === 'Escape') { ev.stopPropagation(); title.blur(); }
    };
    title.onblur = async () => {
      const exp = S.experiences.find(x => x.id === openId);
      if (!exp) return;
      const next = title.textContent.trim();
      if (!next) { title.textContent = exp.title; return; }
      if (exp.title === next) return;
      exp.title = next;
      await saveExp(exp, true);
      render();
    };
  }

  d.querySelectorAll('[data-e]').forEach(el => {
    el.onchange = async () => {
      const exp = S.experiences.find(x => x.id === openId);
      if (!exp) return;
      const path = el.dataset.e;
      if (path.startsWith('result.')) { exp.result = exp.result || {}; exp.result[path.split('.')[1]] = el.value; }
      else if (path.startsWith('retro.')) { exp.retro = exp.retro || {}; exp.retro[path.split('.')[1]] = el.value; }
      else exp[path] = el.value;
      await saveExp(exp, true);
      // 换类型要整块重画：专属字段、以及「奖项」还是「获得的认可」，都跟着类型走
      if (path === 'stage' || path === 'type') { renderDrawer(); render(); }
    };
    if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text')) {
      el.oninput = debounce(() => el.dispatchEvent(new Event('change')), 700);
    }
  });

  // 类型专属字段（专利号、担任职务、期刊…）：统一存在 exp.meta 里，键由 taxonomy 定
  d.querySelectorAll('[data-meta]').forEach(el => {
    el.onchange = async () => {
      const exp = S.experiences.find(x => x.id === openId);
      if (!exp) return;
      exp.meta = exp.meta || {};
      exp.meta[el.dataset.meta] = el.value;
      await saveExp(exp, true);
    };
    if (el.type === 'text') el.oninput = debounce(() => el.dispatchEvent(new Event('change')), 700);
  });

  d.querySelectorAll('[data-node-done]').forEach(cb => cb.onchange = async () => {
    const exp = S.experiences.find(x => x.id === openId);
    const n = (exp.nodes || []).find(x => x.id === cb.dataset.nodeDone);
    if (!n) return;
    n.done = cb.checked;
    n.doneAt = cb.checked ? new Date().toISOString() : '';
    await saveExp(exp, true);
    renderDrawer(); render();
  });

  d.querySelectorAll('[data-mat-reuse]').forEach(cb => cb.onchange = async () => {
    const exp = S.experiences.find(x => x.id === openId);
    const m = (exp.materials || []).find(x => x.id === cb.dataset.matReuse);
    if (!m) return;
    m.reusable = cb.checked;
    await saveExp(exp, true);
  });
}

function guessKind(name) {
  const n = String(name).toLowerCase();
  if (/证书|cert|奖/.test(n)) return 'cert';
  if (/报名|登记|申请/.test(n)) return 'form';
  if (/说明|申报|论文|报告|方案/.test(n)) return 'doc';
  if (/\.(png|jpe?g|gif|webp|mp4|mov|zip|rar|pdf)$/.test(n)) return 'work';
  return 'other';
}

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error('读取文件失败'));
    r.readAsDataURL(file);
  });
}

/* =============================== 模态 =============================== */

function openModal(title, bodyHtml, footHtml, opts) {
  opts = opts || {};
  const m = $('#modal');
  m.className = 'modal' + (opts.width === 'wide' ? ' wide' : opts.width === 'narrow' ? ' narrow' : '');
  m.innerHTML = `<div class="modal-head"><h2>${esc(title)}</h2>
      <button class="btn btn-sm btn-ghost btn-icon" data-m="close" title="关闭"><span class="ic ic-close"></span></button></div>
    <div class="modal-body">${bodyHtml}</div>
    ${footHtml ? `<div class="modal-foot">${footHtml}</div>` : ''}`;
  if (!m.open) m.showModal();
  m.querySelectorAll('[data-m="close"]').forEach(b => b.onclick = () => m.close());
  return m;
}

function closeModal() { const m = $('#modal'); if (m.open) m.close(); }

/** 替代原生 confirm：统一视觉，且能写清楚风险 */
function confirmModal(opts) {
  return new Promise(resolve => {
    const m = openModal(opts.title || '确认', `<div style="font-size:13.5px;line-height:1.85">${opts.body || ''}</div>`,
      `<button class="btn" data-m="close">取消</button>
       <button class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" id="cfmOk">${esc(opts.ok || '确定')}</button>`,
      { width: 'narrow' });
    let done = false;
    const finish = v => { if (done) return; done = true; m.close(); resolve(v); };
    m.querySelector('#cfmOk').onclick = () => finish(true);
    m.querySelectorAll('[data-m="close"]').forEach(b => b.onclick = () => finish(false));
    m.addEventListener('close', () => finish(false), { once: true });
  });
}

/** 替代原生 prompt */
function promptModal(opts) {
  return new Promise(resolve => {
    const m = openModal(opts.title || '输入', `
      <div class="field"><label>${esc(opts.label || '内容')}</label>
        <input class="input" id="pmVal" value="${esc(opts.value || '')}" placeholder="${esc(opts.placeholder || '')}"></div>
      ${opts.hint ? `<div class="dim" style="font-size:11.5px;line-height:1.7">${opts.hint}</div>` : ''}`,
      `<button class="btn" data-m="close">取消</button>
       <button class="btn btn-primary" id="pmOk">${esc(opts.ok || '确定')}</button>`,
      { width: 'narrow' });
    const input = m.querySelector('#pmVal');
    let done = false;
    const finish = v => { if (done) return; done = true; m.close(); resolve(v); };
    const commit = () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      finish(v);
    };
    m.querySelector('#pmOk').onclick = commit;
    input.onkeydown = e => { if (e.key === 'Enter') commit(); };
    input.oninput = () => { if (opts.maxlength) input.value = input.value.slice(0, opts.maxlength); };
    m.querySelectorAll('[data-m="close"]').forEach(b => b.onclick = () => finish(null));
    m.addEventListener('close', () => finish(null), { once: true });
    setTimeout(() => input.focus(), 60);
  });
}

function openNewModal() {
  const m = openModal('新增经历', `
    <div class="field"><label>类型</label>
      <div class="row-wrap" style="gap:8px 14px" id="ntypeBox">
        ${TYPE_LIST.map((t, i) =>
    `<label class="check"><input type="radio" name="ntype" value="${esc(t.key)}" ${i === 0 ? 'checked' : ''}>${esc(t.label)}</label>`).join('')}
      </div>
    </div>
    <div class="field" id="nLibRow" hidden>
      <label>从竞赛库挑一个</label>
      <div class="row" style="gap:9px">
        <button type="button" class="btn" id="nPickLib"><span class="ic ic-search"></span>打开竞赛库</button>
        <span class="dim" style="font-size:11.5px">选中后赛程节点会自动套好，名称也帮你填好</span>
      </div>
    </div>
    <div class="field"><label>名称</label>
      <input class="input" id="nTitle" placeholder="如：全国大学生数学建模竞赛"></div>`,
    `<button class="btn" data-m="close">取消</button>
     <button class="btn btn-primary" id="nGo">创建</button>`);

  const box = m.querySelector('#ntypeBox');
  const libRow = m.querySelector('#nLibRow');
  // 类型选「竞赛」才出现竞赛库入口——别的类型库里本来也没有
  const syncLibRow = () => {
    const t = box.querySelector('input[name="ntype"]:checked');
    libRow.hidden = !(t && t.value === 'competition');
  };
  box.querySelectorAll('input[name="ntype"]').forEach(r => r.onchange = syncLibRow);
  syncLibRow();

  m.querySelector('#nPickLib').onclick = () => {
    // 竞赛库里「加入我的档案」会直接建好经历（赛程模板一起套上），
    // 所以这里把新建弹窗关掉就行，不用两条路径都留着
    m.close();
    openLibraryModal();
  };

  const goBtn = m.querySelector('#nGo');
  let busy = false;
  const commit = async () => {
    if (busy) return;
    const title = m.querySelector('#nTitle').value.trim();
    if (!title) { toast('名称不能为空', 'bad'); m.querySelector('#nTitle').focus(); return; }
    busy = true; goBtn.disabled = true;
    try {
      const type = box.querySelector('input[name="ntype"]:checked').value;
      const exp = { type, title, nodes: [] };
      const saved = await saveExp(exp, true);
      m.close(); render();
      toast('已创建');
      openDrawer(saved.id);
    } catch (_) { busy = false; goBtn.disabled = false; }
  };
  goBtn.onclick = commit;
  m.querySelector('#nTitle').onkeydown = e => { if (e.key === 'Enter') commit(); };
  setTimeout(() => m.querySelector('#nTitle').focus(), 60);
}

function openNodeModal(exp, nodeId) {
  const n = nodeId ? (exp.nodes || []).find(x => x.id === nodeId) : null;
  const m = openModal(n ? '编辑节点' : '加一个节点', `
    <div class="field"><label>节点名称</label>
      <input class="input" id="ndTitle" value="${esc(n ? n.title : '')}" placeholder="如：作品提交截止"></div>
    <div class="grid-2">
      <div class="field"><label>类型</label><select class="input" id="ndKind">
        ${Object.entries(KIND_LABEL).map(([k, v]) => `<option value="${k}"${n && n.kind === k ? ' selected' : ''}>${v}</option>`).join('')}
      </select></div>
      <div class="field"><label>时间</label><input class="input" type="datetime-local" id="ndDue" value="${esc(toLocalInput(n ? n.dueAt : ''))}"></div>
    </div>
    <div class="field" id="ndRemindWrap"><label>单独设提醒提前量 <span class="dim">（留空则用全局设置 ${(S.profile.remind.days || []).join(' / ')} 天）</span></label>
      <input class="input" id="ndDays" value="${esc(n && n.remindDays ? n.remindDays.join(',') : '')}" placeholder="如：14,7,3,1"></div>
    <div class="dim" id="ndDoneNote" style="font-size:11.5px;line-height:1.7" hidden>「完成」是里程碑（如获奖公布、拿到证书），只记录时间，不会触发任何提醒。</div>
    ${n ? `<div class="dim" id="ndChangedNote" style="font-size:11.5px;line-height:1.7">改了时间，这个节点的提醒档位会自动重置——否则新日期就提醒不出来了。</div>` : ''}`,
    `<button class="btn" data-m="close">取消</button>
     <button class="btn btn-primary" id="ndGo">${n ? '保存' : '添加'}</button>`);

  const goBtn = m.querySelector('#ndGo');
  // 「完成」类节点是里程碑不是截止：提醒提前量对它没有意义，直接收起来
  const syncDoneUi = () => {
    const isDone = m.querySelector('#ndKind').value === 'done';
    m.querySelector('#ndRemindWrap').hidden = isDone;
    m.querySelector('#ndDoneNote').hidden = !isDone;
  };
  m.querySelector('#ndKind').onchange = syncDoneUi;
  syncDoneUi();
  goBtn.onclick = async () => {
    const title = m.querySelector('#ndTitle').value.trim();
    if (!title) { toast('节点名称不能为空', 'bad'); return; }
    const dueAt = fromLocalInput(m.querySelector('#ndDue').value);
    // 截止时间变了就把已发提醒重置，否则新日期永远不会触发提醒
    const changed = n ? (n.dueAt || '') !== (dueAt || '') : false;
    const days = m.querySelector('#ndDays').value.split(/[,，\s]+/).map(Number).filter(x => x > 0);
    const payload = {
      id: n ? n.id : crypto.randomUUID(),
      title,
      kind: m.querySelector('#ndKind').value,
      dueAt,
      done: n ? n.done : false,
      doneAt: n ? n.doneAt : '',
      remindDays: days.length ? days : null,
      notifiedAt: changed ? [] : (n ? (n.notifiedAt || []) : [])
    };
    exp.nodes = exp.nodes || [];
    const i = exp.nodes.findIndex(x => x.id === payload.id);
    if (i >= 0) exp.nodes[i] = payload; else exp.nodes.push(payload);
    goBtn.disabled = true;
    await saveExp(exp, true);
    m.close(); renderDrawer(); render();
    toast(changed ? '节点已保存，提醒档位已重置' : '节点已保存');
  };
  setTimeout(() => m.querySelector('#ndTitle').focus(), 60);
}

const TIER_LABEL = { '榜单': '榜单内', '观察': '观察目录', '关联': '关联赛事' };
// 校内认定档次：短标签用于 chip，太长会把一行撑满
const RECOGNITION_LABEL = {
  '国际级顶级赛事': '国际级顶级',
  '国际级赛事': '国际级',
  '国家级顶级赛事': '国家级顶级',
  '国家级赛事': '国家级'
};
const RECOGNITION_ORDER = ['国际级顶级赛事', '国际级赛事', '国家级顶级赛事', '国家级赛事'];

async function openLibraryModal() {
  const lib = S.library || {};
  const recogs = (lib.recognitions && lib.recognitions.length) ? lib.recognitions : RECOGNITION_ORDER;

  const m = openModal('竞赛库', `
    <div class="toolbar" style="margin:0">
      <div class="search-wrap" style="max-width:none;flex:1"><span class="ic ic-search"></span>
        <input class="input input-search" id="lq" placeholder="搜索竞赛名称、类别、专业"></div>
      <select class="input" id="lrecog" style="flex:0 0 auto;width:auto;max-width:9.5em">
        <option value="">全部档次</option>
        ${recogs.map(r => `<option value="${esc(r)}">${esc(RECOGNITION_LABEL[r] || r)}</option>`).join('')}
        <option value="未认定">名单外</option>
      </select>
      <button class="btn btn-sm" id="lrec">按我专业推荐</button>
    </div>
    <div class="row-wrap" style="gap:6px;padding:11px 13px;background:var(--sand-2);border:1px solid var(--line-soft);border-radius:var(--r-md)">
      ${recogs.map((r, i) => `<span class="chip ${i === 0 ? 'chip-accent' : 'chip-line'}">${esc(RECOGNITION_LABEL[r] || r)}</span>`).join('')}
      <span class="chip chip-line">名单外</span>
    </div>
    <div id="lcount" class="dim" style="font-size:11.5px"></div>
    <div id="lres" class="col" style="gap:9px;max-height:46vh;overflow:auto;padding-right:2px"></div>`,
    `<span class="dim" style="font-size:11.5px;margin-right:auto">库里只放稳定信息；当届截止日期请以官网为准。</span>
     <button class="btn" data-m="close">关闭</button>`, { width: 'wide' });

  const renderList = (items, total, matched) => {
    const shown = items.length;
    // 三种情况：全量 / 筛掉了但没截断 / 筛掉了且截断
    let line = `共 ${shown} 项`;
    if (matched != null && matched !== shown) line = `筛选出 ${matched} 项，显示前 ${shown} 项`;
    else if (total && total > shown) line = `库里共 ${total} 项，显示前 ${shown} 项`;
    m.querySelector('#lcount').textContent = line;

    m.querySelector('#lres').innerHTML = items.length ? items.map((it, i) => `
      <div class="panel" style="--i:${Math.min(i, 10)};padding:14px 16px;gap:9px">
        <div class="row" style="justify-content:space-between;align-items:flex-start;gap:10px">
          <b style="font-size:13.5px;font-weight:600;line-height:1.5">${esc(it.name)}</b>
          ${(it.matchMajors && it.matchMajors.length) ? '<span class="chip chip-accent">对口</span>' : ''}
        </div>
        ${it.intro ? `<div style="font-size:12.5px;color:var(--ink-2);line-height:1.7">${esc(it.intro)}</div>` : ''}
        <div class="panel-foot fx" style="gap:7px">
          <span>${esc(it.category)}</span>
          ${it.window ? `<span class="sep">·</span><span>${esc(it.window)}</span>` : ''}
          ${it.organizer ? `<span class="sep">·</span><span>${esc(it.organizer)}</span>` : ''}
        </div>
        <div class="row" style="justify-content:space-between;gap:10px">
          <span class="row" style="gap:6px">
            ${it.recognition
              ? `<span class="chip ${it.recognition === '国际级顶级赛事' ? 'chip-accent' : 'chip-line'}">${esc(RECOGNITION_LABEL[it.recognition] || it.recognition)}</span>`
              : '<span class="chip chip-line">名单外</span>'}
            ${it.tier ? `<span class="chip chip-line">${esc(TIER_LABEL[it.tier] || it.tier)}</span>` : ''}
          </span>
          <span class="row" style="gap:7px">
            ${it.site ? `<a class="btn btn-sm btn-ghost" href="${esc(it.site)}" target="_blank" rel="noopener">官网</a>` : ''}
            <button class="btn btn-sm btn-primary" data-add="${esc(it.id)}">加入我的档案</button>
          </span>
        </div>
      </div>`).join('')
      : `<div class="empty" style="padding:36px 20px">
          <div class="empty-art" style="width:74px;height:74px">${ART.search}</div>
          <h3>没有匹配的竞赛</h3>
          <p>冷门赛和地方性赛事可以手动新建一条。</p>
          <button class="btn btn-sm" id="lManual">手动新增</button>
        </div>`;
    const man = m.querySelector('#lManual');
    if (man) man.onclick = () => { m.close(); openNewModal(); };
    m.querySelectorAll('[data-add]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      await addFromLibrary(b.dataset.add);
      m.close();
    });
  };

  // 搜索词和档次是叠加的，所以统一走一个查询函数
  const query = async () => {
    const q = m.querySelector('#lq').value.trim();
    const rg = m.querySelector('#lrecog').value;
    const qs = [];
    if (q) qs.push('q=' + encodeURIComponent(q));
    if (rg) qs.push('recog=' + encodeURIComponent(rg));
    const r = await api('/api/library' + (qs.length ? '?' + qs.join('&') : ''));
    // 没加任何筛选时不要传 matched，否则文案会把「全量」说成「筛选出」
    renderList(r.items.slice(0, 60), r.count, qs.length ? r.matched : null);
  };

  const first = await api('/api/library');
  renderList(first.items.slice(0, 40), first.count, null);

  m.querySelector('#lq').oninput = debounce(query, 240);
  m.querySelector('#lrecog').onchange = query;

  m.querySelector('#lrec').onclick = async () => {
    const r = await api('/api/library/recommend?limit=40');
    renderList(r.items);
  };
}

async function addFromLibrary(id) {
  const r = await api('/api/library/instantiate', { method: 'POST', body: { id } });
  const i = S.experiences.findIndex(x => x.id === r.experience.id);
  if (i >= 0) S.experiences[i] = r.experience; else S.experiences.push(r.experience);
  await refresh();
  if (r.already) toast('这条你已经在跟了，我把赛程模板补齐了', 'warn');
  else toast('已加入，去填当届的截止日期');
  render();
  setTimeout(() => openDrawer(r.experience.id), 200);
}

async function openReminderPreview() {
  const r = await api('/api/reminder/preview');
  const p = S.profile;
  const items = r.items || [];
  const body = `
    <div style="font-size:12.5px;line-height:1.85;color:var(--ink-2)">
      每天 <b>${esc(p.remind.time)}</b> 检查一次，提前 <b>${(p.remind.days || []).join(' / ')}</b> 天各提醒一次。
      关机期间不发；下次开机把漏掉的那一档补上，已发过的档位不会重复。
      逾期只在工具里标红，不再发信。
    </div>
    <div class="sect-head" style="margin:4px 0 0"><h2>这次会发出的内容</h2><span class="rule"></span>
      <span class="hint">${items.length} 条</span></div>
    ${items.length ? items.map(it => `
      <div class="node ${it.daysLeft <= 0 ? 'now' : it.daysLeft <= 3 ? 'soon' : ''}" style="align-items:center">
        <span class="chip ${it.daysLeft <= 0 ? 'chip-danger' : it.daysLeft <= 3 ? 'chip-warn' : 'chip-accent'}">${it.daysLeft <= 0 ? '今天' : it.daysLeft + ' 天'}</span>
        <div style="min-width:0;flex:1">
          <div class="node-title">${esc(it.nodeTitle)}</div>
          <div class="node-meta">${esc(it.expTitle)} · 截止 ${esc(fmt(it.dueAt, true))}${it.catchUp ? ' · 补发' : ''}</div>
        </div>
      </div>`).join('')
      : '<div class="dim" style="font-size:12.5px">未来没有临近的节点，今天不会打扰你。</div>'}
    ${r.overdue && r.overdue.length ? `<div class="panel" style="background:var(--danger-bg);border-color:var(--danger-line);gap:6px">
        <div class="panel-label" style="color:var(--danger)">已逾期 ${r.overdue.length} 件（不再重复提醒）</div>
        ${r.overdue.map(o => `<div style="font-size:12px;color:var(--ink-2)">· ${esc(o.expTitle)} — ${esc(o.nodeTitle)}（${esc(fmt(o.dueAt, false))}）</div>`).join('')}
      </div>` : ''}
    <div class="panel" style="background:var(--sand-2);box-shadow:none;gap:5px">
      <div class="panel-label">送达通道</div>
      <div style="font-size:12px;line-height:1.9;color:var(--ink-2)">
        桌面通知：${(p.remind.channels || []).includes('desktop') ? '开' : '关'}<br>
        邮件：${r.smtpReady ? (r.nodemailerReady ? '已配置，可发送' : '已配置，但缺 nodemailer，会落盘') : '未配置，邮件会落成 data/outbox/*.eml'}
      </div>
    </div>`;
  const m = openModal('提醒预览', body,
    `<button class="btn" id="rpRun">现在真的发一次</button>
     <button class="btn btn-primary" data-m="close">知道了</button>`);
  m.querySelector('#rpRun').onclick = async () => {
    m.close();
    await handleAct('remind-run');
  };
}

/** 变更记录 + 回收站：把"能恢复"这个承诺真正实现掉 */
async function openChanges() {
  const r = await api('/api/changelog');
  const deleted = S.deleted || [];
  const OP_LABEL = {
    'experience.create': '新建', 'experience.update': '更新', 'experience.delete': '删除',
    'experience.restore': '恢复', 'profile.update': '设置', 'library.install': '装库',
    'library.import': '导入库', 'library.reset': '重置库', 'attachment.add': '附件',
    'demo.load': '载入示例', 'demo.clear': '移除示例', 'export.save': '导出', 'reminder.run': '提醒'
  };

  const m = openModal('变更与恢复', `
    <div class="sect-head" style="margin:0"><h2>回收站</h2><span class="rule"></span>
      <span class="hint">${deleted.length} 条</span></div>
    ${deleted.length ? deleted.map(d => `
      <div class="node" style="align-items:center">
        <span class="ic ic-trash" style="color:var(--ink-4)"></span>
        <div style="min-width:0;flex:1">
          <div class="node-title">${esc(d.title)}</div>
          <div class="node-meta">删除于 ${fmt(d.deletedAt, true)}</div>
        </div>
        <button class="btn btn-sm btn-quiet" data-restore="${d.id}">恢复</button>
      </div>`).join('')
      : '<div class="dim" style="font-size:12.5px">回收站是空的。删除经历后会先放到这里，随时能还原。</div>'}

    <div class="sect-head" style="margin:10px 0 0"><h2>近期变更</h2><span class="rule"></span>
      <span class="hint">${r.items.length} 条${r.rawCount > r.items.length ? ` · 合并了 ${r.rawCount} 次写入` : ''}</span></div>
    <div style="font-size:12px;display:flex;flex-direction:column;gap:2px;max-height:34vh;overflow:auto">
      ${r.items.map(x => `<div class="row" style="gap:10px;padding:5px 0;border-bottom:1px solid var(--line-soft)">
        <span class="mono dim" style="flex:0 0 122px">${fmt(x.at, true)}</span>
        <span style="flex:0 0 62px;color:var(--ink-2)">${esc(OP_LABEL[x.op] || x.op)}</span>
        <span class="muted" style="min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.title || x.note || '')}</span>
        ${x.n > 1 ? `<span class="chip" style="flex:0 0 auto">×${x.n}</span>` : ''}
      </div>`).join('') || '<span class="dim">还没有记录</span>'}
    </div>
    <div class="dim" style="font-size:11px;line-height:1.7">自动保存很频繁，所以同一条记录的连续改动在这里合并成一行（右边的 ×N 是次数）。原始日志一条没少，都在 data/changelog.jsonl —— 将来手机端拉增量时用得上。</div>`,
    `<button class="btn btn-primary" data-m="close">关闭</button>`, { width: 'wide' });

  m.querySelectorAll('[data-restore]').forEach(b => b.onclick = async () => {
    b.disabled = true;
    try {
      await api('/api/experience/' + encodeURIComponent(b.dataset.restore) + '/restore', { method: 'POST', body: {} });
      await refresh();
      toast('已恢复');
      m.close();
      render();
      openChanges();
    } catch (e) { toast('恢复失败：' + e.message, 'bad'); b.disabled = false; }
  });
}

/* =============================== 杂项 =============================== */

async function loadRecs() {
  try {
    // 拉多一点：概览只取前 8 条，竞赛库视图的「按我专业推荐」要能看到更多
    const r = await api('/api/library/recommend?limit=30');
    S._recs = r.items || [];
  } catch (_) { S._recs = S._recs || []; }
}

$('#scrim').onclick = closeDrawer;

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  // 模态在最上层：它开着的时候 Esc 只关它，别把下面的抽屉一起关掉
  const m = $('#modal');
  if (m && m.open) return;
  if (openId) closeDrawer();
});

/* 浏览器前进/后退、手改地址栏都能用 */
window.addEventListener('hashchange', () => {
  const { view, id } = parseHash();
  if (view && view !== S.view && VIEWS[view]) { S.view = view; render(); }
  if (id && id !== openId) openDrawer(id);
  else if (!id && openId) { $('#drawer').hidden = true; $('#scrim').hidden = true; openId = null; }
});

window.addEventListener('DOMContentLoaded', async () => {
  try {
    await boot();
  } catch (e) {
    $('#view').innerHTML = `<div class="empty">
      <div class="empty-art">${ART.compass}</div>
      <h3>连不上本地服务</h3>
      <p>页面是打开了，但后台那个小服务没响应。<br>关掉黑色的命令窗口，重新双击 <span class="mono">start.bat</span> 就好。</p>
      <div class="dim" style="font-size:11.5px">${esc(e.message || e)}</div>
    </div>`;
  }
});
