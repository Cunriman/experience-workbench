'use strict';
/**
 * 预置竞赛库 + 专业目录 + 推荐排序
 *
 * 骨架来源：
 *   - 中国高等教育学会《全国普通高校大学生竞赛分析报告》榜单 → 字段 tier
 *   - 某高校《本科生学业竞赛项目库（2024 修订）》 → 字段 recognition（校内认定档次）
 *   - 教育部《普通高等学校本科专业目录（2024年）》 → src/seed/majors.json
 *
 * 原则：只预置「稳定层」（名称/主办方/类别/官网/大致时间窗口/赛程模板）、
 *       当届精确日期属「易变层」，一律不预置——错的截止日期比没有更危险。
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');

const SEED_PATH = path.join(__dirname, 'seed', 'competitions.json');
const MAJOR_PATH = path.join(__dirname, 'seed', 'majors.json');

/** 赛程模板 → 生成的具体节点（日期留空由用户填） */
const STAGE_NODES = {
  '校赛省赛国赛': ['校赛报名截止', '校赛作品提交', '省赛', '国赛', '结果公布'],
  '省赛国赛': ['省赛报名截止', '省赛', '国赛', '结果公布'],
  '报名提交答辩': ['报名截止', '作品提交', '答辩', '结果公布'],
  '报名比赛评奖': ['报名截止', '初赛', '决赛', '结果公布'],
  '单轮': ['报名截止', '参赛', '结果公布']
};

const LEVEL_BY_TIER = { '榜单': '国家级（榜单内）', '观察': '国家级（观察目录）', '关联': '社会/行业级' };

/**
 * 校内认定档次（来自某高校《本科生学业竞赛项目库》）。
 * 这是保研/评奖时的加分口径，比学会榜单更贴近「学校认不认」，所以给足权重。
 * 一个竞赛可能在名单里出现两次（如 ACM-ICPC 既在「国际级顶级」又在「国家级顶级」，
 * 对应全球总决赛和国内赛），此时按最高的那档记。
 *
 * ⚠️ 这份档次表来自特定一所学校，换学校使用时应替换为母校自己的认定名单。
 */
const RECOGNITIONS = ['国际级顶级赛事', '国际级赛事', '国家级顶级赛事', '国家级赛事'];
const RECOGNITION_BONUS = {
  '国际级顶级赛事': 18,
  '国家级顶级赛事': 16,
  '国际级赛事': 10,
  '国家级赛事': 6
};

function readSeed() {
  return JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
}

/* ---------------- 专业目录 ---------------- */

let _majors = null;
function getMajors() {
  if (!_majors) _majors = JSON.parse(fs.readFileSync(MAJOR_PATH, 'utf8'));
  return _majors;
}

/** 专业类名 → 方向标签 */
function tracksOfCat(catName) {
  const m = getMajors();
  const c = (m.cats || []).find(x => x.name === catName);
  return c ? (c.tracks || []) : [];
}

/** 专业名 → {name, code, cat, disc, tracks} */
function majorInfo(name) {
  const m = getMajors();
  const hit = (m.majors || []).find(x => x.name === name);
  if (!hit) return null;
  return { ...hit, tracks: tracksOfCat(hit.cat) };
}

/** 一组专业名 → 去重后的方向标签并集 */
function tracksForMajors(names) {
  const out = [];
  for (const n of names || []) {
    for (const t of tracksOfCat((majorInfo(n) || {}).cat)) if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** 编辑距离（用于「打错字也能找回来」） */
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

/** q 的字符是否按顺序出现在 s 里（子序列）——「计算机科」能命中「计算机科学与技术」 */
function isSubsequence(q, s) {
  let i = 0;
  for (const ch of s) { if (ch === q[i]) i++; if (i >= q.length) return true; }
  return q.length === 0;
}

/**
 * 按用户输入找相近专业。
 * 打分顺序：完全一致 > 前缀 > 包含 > 专业类命中 > 门类命中 > 子序列 > 编辑距离兜底。
 * 返回里带上 cat/disc/tracks，前端可以直接告诉用户「你是学 XX 类的」。
 */
function searchMajors(q, limit) {
  const m = getMajors();
  const raw = String(q || '').trim();
  const query = raw.replace(/\s+/g, '').toLowerCase();
  const lim = limit || 8;
  if (!query) {
    // 没输入就给几个最常见的方向当例子，别让用户对着空列表发呆
    const common = ['计算机科学与技术', '软件工程', '电子信息工程', '自动化', '机械工程',
      '土木工程', '数学与应用数学', '金融学', '会计学', '临床医学', '汉语言文学', '法学'];
    return common
      .map(n => (m.majors || []).find(x => x.name === n))
      .filter(Boolean)
      .map(x => ({ ...x, tracks: tracksOfCat(x.cat), score: 0, how: '常见专业' }));
  }

  const scored = [];
  for (const it of m.majors || []) {
    const name = it.name;
    const lname = name.toLowerCase();
    let score = 0;
    let how = '';

    if (lname === query) { score = 1000; how = '完全一致'; }
    else if (lname.startsWith(query)) { score = 900 - (lname.length - query.length); how = '同名开头'; }
    else if (lname.includes(query)) { score = 800 - (lname.length - query.length); how = '名称包含'; }
    else if (it.cat && it.cat.includes(raw)) { score = 600; how = '同属' + it.cat; }
    else if (it.disc && (it.disc.includes(raw) || raw.includes(it.disc))) { score = 400; how = '同属' + it.disc + '门类'; }
    else if (query.length >= 2 && isSubsequence(query, lname)) { score = 300 - (lname.length - query.length); how = '名称相近'; }
    else {
      // 错别字兜底：允许 0.6 个字的差距
      const d = editDistance(query, lname);
      const tol = Math.max(1, Math.floor(query.length * 0.4));
      if (d <= tol) { score = 200 - d * 10; how = d === 1 ? '差一个字' : '拼写相近'; }
    }
    if (score > 0) scored.push({ ...it, tracks: tracksOfCat(it.cat), score, how });
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, lim);
}

/**
 * 库里的竞赛能不能接住这个专业的方向？
 * 用来给用户一句实话——有些专业（农学、体育）这库里确实没有对口的赛事，
 * 与其装作推荐得很准，不如直接说清楚，让他手动加。
 */
function majorCoverage(tags) {
  const lib = ensureLibrary();
  const out = {};
  let matched = 0;
  const seen = new Set();
  for (const it of lib.items) {
    const hit = (it.majorTags || []).some(t => (tags || []).includes(t));
    if (hit) { matched++; if (it.id) seen.add(it.id); }
  }
  out.matched = seen.size || matched;
  out.byTag = {};
  for (const t of tags || []) {
    out.byTag[t] = lib.items.filter(i => (i.majorTags || []).includes(t)).length;
  }
  return out;
}

/* ---------------- 竞赛库 ---------------- */

function ensureLibrary() {
  let lib = store.readJson('library', null);
  if (!lib || !Array.isArray(lib.items) || lib.items.length === 0) {
    lib = readSeed();
    lib.installedFrom = '内置骨架';
    lib.installedAt = store.nowIso();
    store.writeJson('library', lib);
    store.appendLog({ op: 'library.install', title: lib.libVersion, count: lib.items.length });
    return lib;
  }
  // 老版本的 library.json 可能缺后来补的顶层字段；缺了就从骨架回填，省得用户手动重置
  const seed = readSeed();
  let patched = false;
  for (const k of ['tierNote', 'majorTags', 'stageTemplates', 'source', 'caution', 'recognitionSource', 'recognitionNote']) {
    if (lib[k] == null && seed[k] != null) { lib[k] = seed[k]; patched = true; }
  }
  // 库里的条目也可能缺后来补的字段（例如新加的方向标签），按 id 从骨架补齐
  const byId = new Map((seed.items || []).map(i => [i.id, i]));
  for (const it of lib.items) {
    const s = byId.get(it.id);
    if (!s) continue;
    for (const k of ['recognition', 'category', 'window', 'site', 'organizer', 'stages']) {
      if (it[k] == null && s[k] != null) { it[k] = s[k]; patched = true; }
    }
    /* 方向标签取**并集**，不是「缺了才补」：
       骨架里补标的（见 tools/majors/retag-*.js）必须能进到已经装好的库里，
       否则改一次种子文件就得让用户手动重置一次库。
       同时是并集不是覆盖——用户在库里自己调过的标签不会被抹掉。 */
    if (Array.isArray(s.majorTags) && s.majorTags.length) {
      const cur = Array.isArray(it.majorTags) ? it.majorTags : [];
      const merged = cur.concat(s.majorTags.filter(t => !cur.includes(t)));
      if (merged.length !== cur.length) { it.majorTags = merged; patched = true; }
    } else if (it.majorTags == null && s.majorTags != null) {
      it.majorTags = s.majorTags; patched = true;
    }
  }
  if (patched) store.writeJson('library', lib);
  return lib;
}

function getLibrary() { return ensureLibrary(); }

function listLibrary() {
  const lib = ensureLibrary();
  const mj = getMajors();
  return {
    libVersion: lib.libVersion,
    dataAsOf: lib.dataAsOf,
    source: lib.source,
    caution: lib.caution,
    tierNote: lib.tierNote || null,
    recognitionSource: lib.recognitionSource || null,
    recognitionNote: lib.recognitionNote || null,
    recognitions: RECOGNITIONS,
    majorTags: lib.majorTags || [],
    majorCatalog: {
      source: mj.source,
      version: mj.version,
      counts: mj.counts,
      tags: mj.tags
    },
    count: lib.items.length,
    items: lib.items
  };
}

/** 从「4-6 月报名，9 月比赛」这类文本里抽出月份数字 */
function monthsOf(windowText) {
  const out = [];
  const re = /(\d{1,2})\s*月/g;
  let m;
  while ((m = re.exec(windowText || '')) !== null) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 12) out.push(n);
  }
  return out;
}

/** 距离当前月份还有多少个月（用于「即将开始」排序），0 表示就在本月 */
function monthsUntil(windowText, refMonth) {
  const ms = monthsOf(windowText);
  if (!ms.length) return 99;
  let best = 99;
  for (const m of ms) {
    const d = (m - refMonth + 12) % 12;
    if (d < best) best = d;
  }
  return best;
}

/**
 * 推荐排序：专业相关度 > 校内认定档次 > 榜单级别 > 时间窗口
 *
 * 专业这一环走的是「方向标签」：用户填的是具体专业（如「计算机科学与技术」），
 * 由 majors.json 把它归到「计算机类」，再取该专业类的方向标签。
 * 兼容老数据：profile.majors 里如果存的就是标签本身（上一版的用法），也能匹配上。
 */
function recommend(profile, opts) {
  const lib = ensureLibrary();
  const majors = (profile && profile.majors) || [];
  // 新数据读 majorTags；老数据没有这个字段时，现算一次（标签直接当专业名也认得出来）
  let tags = (profile && profile.majorTags) || [];
  if (!tags.length && majors.length) {
    const known = new Set(lib.majorTags || []);
    tags = majors.filter(m => known.has(m));
    if (!tags.length) tags = tracksForMajors(majors);
  }
  const refMonth = new Date().getMonth() + 1;
  const limit = (opts && opts.limit) || 30;

  const scored = lib.items.map(it => {
    const itemTags = it.majorTags || [];
    const hit = tags.filter(t => itemTags.includes(t));
    let score = 0;
    if (tags.length === 0) score += 30;                    // 未设置专业时不区分
    else score += hit.length ? 30 + (hit.length - 1) * 10 : 0;
    if (itemTags.includes('综合')) score += 8;              // 通用型赛事略提权

    score += it.tier === '榜单' ? 20 : it.tier === '观察' ? 10 : it.tier === '关联' ? 4 : 0;
    score += RECOGNITION_BONUS[it.recognition] || 0;       // 校内认定档次，学校看的就是这个
    if (it.id === 'cn-mcm' || it.id === 'cn-lanqiao' || it.id === 'cn-3chuang') score += 6;

    // 时间窗口：越近越靠前，满分 12。
    // 但「不知道什么时候办」≠「离得最远」——校内名单新增的那些没有窗口，
    // 若按最远算就等于白扣 12 分，它们永远浮不上来。所以未知按中位处理。
    const soon = monthsUntil(it.window, refMonth);
    score += soon >= 99 ? 6 : Math.max(0, 12 - soon);
    return { ...it, _score: score, _monthsUntil: soon, _majorHit: hit };
  });

  scored.sort((a, b) => b._score - a._score || a._monthsUntil - b._monthsUntil);
  return scored.slice(0, limit).map(x => {
    const { _score, _monthsUntil, _majorHit, ...rest } = x;
    return { ...rest, matchMajors: _majorHit, monthsUntil: _monthsUntil };
  });
}

/** 取得某条竞赛的默认赛程节点（日期留空） */
function stageNodesFor(item) {
  const template = STAGE_NODES[item.stages] || STAGE_NODES['报名比赛评奖'];
  return template.map((title, i) => ({
    id: store.uuid(),
    title,
    kind: i === 0 ? 'deadline' : (title.includes('答辩') ? 'defense' : title.includes('结果') ? 'result' : 'submit'),
    dueAt: '',
    done: false,
    remindDays: null,
    notifiedAt: []
  }));
}

/** 由库中一条竞赛生成一条「我在跟的竞赛」经历 */
function instantiate(item, extra) {
  return {
    type: 'competition',
    title: item.name,
    // 英文名有就带上：英文简历的标题优先用它
    titleEn: item.nameEn || '',
    // 优先用学会榜单口径；不在榜单里的（校内名单新增的那些）退回校内认定档次——
    // 学校认不认，本来就是保研时更该看的那一条。
    level: LEVEL_BY_TIER[item.tier] || item.recognition || '',
    track: item.category,
    role: '',
    organizer: item.organizer || '',
    stage: '筹备中',
    status: 'active',
    result: {},
    nodes: stageNodesFor(item),
    materials: [],
    retro: {},
    tags: [item.category].concat(item.majorTags || []),
    fromLibrary: { id: item.id, libVersion: ensureLibrary().libVersion, site: item.site || '', window: item.window || '' },
    ...(extra || {})
  };
}

/**
 * 导入更新包：{ libVersion, dataAsOf, source?, items: [...] }
 * 按 id 合并；已存在的更新字段，新的追加。
 */
function importPackage(pkg) {
  if (!pkg || !Array.isArray(pkg.items)) {
    throw new Error('更新包格式不对：需要包含 items 数组');
  }
  const lib = ensureLibrary();
  const byId = new Map(lib.items.map(it => [it.id, it]));
  let added = 0, updated = 0;
  for (const it of pkg.items) {
    if (!it || !it.id) continue;
    if (byId.has(it.id)) { byId.set(it.id, { ...byId.get(it.id), ...it }); updated++; }
    else { byId.set(it.id, it); added++; }
  }
  const next = {
    ...lib,
    ...pkg,
    items: Array.from(byId.values()),
    libVersion: pkg.libVersion || lib.libVersion,
    dataAsOf: pkg.dataAsOf || lib.dataAsOf,
    installedAt: store.nowIso(),
    installedFrom: '导入更新包'
  };
  delete next.count;
  store.writeJson('library', next);
  store.appendLog({ op: 'library.import', title: next.libVersion, note: `新增 ${added} / 更新 ${updated}` });
  return { added, updated, total: next.items.length, libVersion: next.libVersion, dataAsOf: next.dataAsOf };
}

/**
 * 手动添加一条竞赛（用户自己输入中英文名和网址）。
 * 与导入流水线无关——不需要档次、时间窗这些元信息，缺的就留空，界面照常显示。
 */
function addCustom(data) {
  const name = String((data && data.name) || '').trim();
  if (!name) throw new Error('竞赛中文名必填');
  const lib = ensureLibrary();
  // 重名不重复加：库里已有就原样返回，让前端提示「已经在了」
  const dup = lib.items.find(it => it.name === name);
  if (dup) { const e = new Error('库里已经有这条竞赛了'); e.dup = true; throw e; }
  const item = {
    id: 'u-' + store.uuid().slice(0, 8),
    name,
    short: name,
    nameEn: String((data && data.nameEn) || '').trim(),
    category: '自定义',
    tier: '',
    recognition: '',
    window: '',
    organizer: '',
    site: String((data && data.site) || '').trim(),
    stages: '报名比赛评奖',
    majorTags: [],
    custom: true
  };
  lib.items.push(item);
  store.writeJson('library', lib);
  store.appendLog({ op: 'library.custom.add', title: name });
  return item;
}

function resetLibrary() {
  // 重置回内置骨架，但用户自己加的竞赛（custom: true）要留住——那是他手敲的
  const customs = ensureLibrary().items.filter(it => it.custom);
  const lib = readSeed();
  lib.items = lib.items.concat(customs);
  lib.installedFrom = '内置骨架（重置）';
  lib.installedAt = store.nowIso();
  store.writeJson('library', lib);
  store.appendLog({ op: 'library.reset', title: lib.libVersion, note: customs.length ? `保留自定义 ${customs.length} 条` : '' });
  return lib;
}

/** 删掉自己加的一条竞赛。内置竞赛不允许删——那是骨架，删了推荐和档次就残了。 */
function removeCustom(id) {
  const lib = ensureLibrary();
  const it = lib.items.find(x => x.id === id);
  if (!it) throw new Error('没有这条竞赛');
  if (!it.custom) throw new Error('内置竞赛不能删除');
  lib.items = lib.items.filter(x => x.id !== id);
  store.writeJson('library', lib);
  store.appendLog({ op: 'library.custom.remove', title: it.name });
  return { ok: true, id };
}

module.exports = {
  STAGE_NODES, LEVEL_BY_TIER, RECOGNITIONS, RECOGNITION_BONUS,
  getLibrary, listLibrary, recommend, stageNodesFor, instantiate,
  importPackage, addCustom, removeCustom, resetLibrary, monthsOf, monthsUntil,
  getMajors, tracksOfCat, tracksForMajors, majorInfo, searchMajors, majorCoverage
};
