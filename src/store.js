'use strict';
/**
 * 数据层：纯本地 JSON 存储
 * - UUID 主键 / updatedAt + deviceId / 软删除 deletedAt / 变更日志 changelog.jsonl
 * - 每次改动即写盘；写盘前把上一版滚动备份到 data/backups/（只留最新一份）
 * - 主文件损坏时自动回退到备份
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const taxonomy = require('./taxonomy');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const OUTBOX_DIR = path.join(DATA_DIR, 'outbox');
const ATTACH_DIR = path.join(ROOT, 'attachments');

for (const d of [DATA_DIR, BACKUP_DIR, OUTBOX_DIR, ATTACH_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

const DEVICE_ID = (() => {
  const p = path.join(DATA_DIR, 'device.id');
  try {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  } catch (_) {}
  const id = crypto.randomUUID();
  try { fs.writeFileSync(p, id, 'utf8'); } catch (_) {}
  return id;
})();

function uuid() { return crypto.randomUUID(); }
function nowIso() { return new Date().toISOString(); }
function hostName() { try { return os.hostname(); } catch (_) { return 'unknown'; } }

const DEFAULT_PROFILE = {
  name: '',
  school: '',
  // majors 存用户输入/选中的专业名（人看的），majorTags 存由专业目录解析出来的
  // 「竞赛方向」标签（机器用的）。分开存是因为推荐要靠标签，而导出要显示专业名。
  majors: [],
  majorTags: [],
  // 用户自己加的经历类型（内置的 9 类之外），[{key,label}]
  customTypes: [],
  grade: '',
  remind: {
    enabled: true,
    time: '08:00',
    days: [7, 3, 1],
    channels: ['desktop'],
    smtp: null
  },
  // export.lang：中文稿 / 英文骨架稿；favorites：用户在「更多模板」里收藏的版式（最多上屏 3 个）
  export: { profile: 'baoyan', template: 'classic', lang: 'zh', favorites: ['classic', 'academic', 'compact'] },
  ui: { reduceMotion: false, showThree: false },
  createdAt: null,
  updatedAt: null
};

function filePath(name) { return path.join(DATA_DIR, name + '.json'); }
function backupPath(name) { return path.join(BACKUP_DIR, name + '.latest.json'); }

function readJson(name, fallback) {
  const p = filePath(name);
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, 'utf8').trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    try {
      const b = backupPath(name);
      if (fs.existsSync(b)) {
        const rec = JSON.parse(fs.readFileSync(b, 'utf8'));
        console.warn('[store] ' + name + '.json 读取失败，已回退到备份');
        return rec;
      }
    } catch (_e) {}
    return fallback;
  }
}

function writeJson(name, data) {
  const p = filePath(name);
  if (fs.existsSync(p)) {
    try { fs.copyFileSync(p, backupPath(name)); } catch (_) {}
  }
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function appendLog(entry) {
  try {
    fs.appendFileSync(
      path.join(DATA_DIR, 'changelog.jsonl'),
      JSON.stringify({ at: nowIso(), device: DEVICE_ID, ...entry }) + '\n',
      'utf8'
    );
  } catch (_) {}
}

function readChangelog(limit) {
  try {
    const p = path.join(DATA_DIR, 'changelog.jsonl');
    if (!fs.existsSync(p)) return [];
    const lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-(limit || 200)).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

/**
 * 「近期变更」用的人类可读摘要。
 * changelog.jsonl 本身原样保留（将来手机端拉增量要用），只在展示时折叠：
 * 同一条记录在 windowMs 内被连续改动（自动保存会这样）合并成一行，带次数。
 * 返回按时间倒序，最新在前。
 */
function recentChanges(limit, windowMs) {
  const win = windowMs || 10 * 60 * 1000;
  const raw = readChangelog(limit || 500);
  const runs = [];
  let prev = null;
  for (const c of raw) {
    const key = c.op + '|' + (c.id || '');
    const t = new Date(c.at).getTime();
    if (prev && prev._key === key && t - prev.lastT <= win) {
      prev.n += 1;
      prev.lastT = t;
      prev.at = c.at;          // 显示这一段里最近的一次
      continue;
    }
    const item = { op: c.op, id: c.id, title: c.title, note: c.note, at: c.at, firstAt: c.at, n: 1, _key: key, lastT: t };
    runs.push(item);
    prev = item;
  }
  return runs.reverse().map(({ _key, lastT, firstAt, ...rest }) => ({ ...rest, firstAt }));
}

/* ---------------- profile ---------------- */

function getProfile() {
  const p = readJson('profile', null);
  if (!p) {
    const fresh = { ...DEFAULT_PROFILE, createdAt: nowIso(), updatedAt: nowIso() };
    writeJson('profile', fresh);
    return fresh;
  }
  return {
    ...DEFAULT_PROFILE,
    ...p,
    remind: { ...DEFAULT_PROFILE.remind, ...(p.remind || {}) },
    export: { ...DEFAULT_PROFILE.export, ...(p.export || {}) },
    ui: { ...DEFAULT_PROFILE.ui, ...(p.ui || {}) }
  };
}

function saveProfile(patch) {
  const cur = getProfile();
  const next = {
    ...cur,
    ...patch,
    remind: { ...cur.remind, ...(patch.remind || {}) },
    export: { ...cur.export, ...(patch.export || {}) },
    ui: { ...cur.ui, ...(patch.ui || {}) }
  };
  // 无实质变化就既不写盘也不记日志。
  // 设置页里"点了一下但没改任何东西"（下拉重选同一项、复选框点两下、SMTP 输入框
  // 进出但没输入）都会走到这里，否则变更日志会被这种空写入刷屏，updatedAt 也会
  // 无意义地跳动——而 updatedAt 是将来手机端判断增量的依据。
  const strip = o => JSON.stringify({ ...o, updatedAt: null });
  if (strip(next) === strip(cur)) return cur;
  next.updatedAt = nowIso();
  writeJson('profile', next);
  appendLog({ op: 'profile.update', id: 'profile' });
  return next;
}

/* ---------------- experiences ---------------- */

const TYPES = taxonomy.TYPE_KEYS;

/**
 * 类型校验采取「从宽」策略：内置类型照单全收；用户自定义类型（x_ 前缀）也收；
 * 只有完全不认识的才退回 competition。
 * 为什么不严格按 profile.customTypes 白名单校验：自定义类型是用户自己加的，
 * 如果他删了某个类型定义，那条经历不该因此变成「竞赛」——宁可留住原始 key。
 */
function normalizeType(t) {
  const s = String(t || '');
  if (TYPES.includes(s)) return s;
  if (s && /^[\w\u4e00-\u9fa5-]{1,32}$/.test(s)) return s;
  return 'competition';
}

function normalizeExperience(raw, isNew) {
  const now = nowIso();
  const e = {
    id: raw.id || uuid(),
    type: normalizeType(raw.type),
    title: (raw.title || '').trim(),
    // 官方英文名：英文简历的标题优先用它（竞赛从库里带，其他类型手填）
    titleEn: (raw.titleEn || '').trim(),
    // 简历排序：数字小的在导出稿里排前面；空 / 非正数 = 不指定，按默认规则排
    rOrder: (() => { const n = Number(raw.rOrder); return Number.isFinite(n) && n > 0 ? Math.floor(n) : null; })(),
    level: raw.level || '',
    track: raw.track || '',
    role: raw.role || '',
    organizer: raw.organizer || '',
    // 类型专属字段（专利号、担任职务…）统一放这里，键由 taxonomy 决定
    meta: (raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta))
      ? Object.fromEntries(Object.entries(raw.meta)
        .filter(([k, v]) => v != null && v !== '')
        .map(([k, v]) => [String(k).slice(0, 40), String(v).slice(0, 300)]))
      : {},
    stage: raw.stage || '筹备中',
    status: raw.status || 'active',
    startedAt: raw.startedAt || '',
    endedAt: raw.endedAt || '',
    result: {
      award: (raw.result && raw.result.award) || '',
      rank: (raw.result && raw.result.rank) || '',
      ratio: (raw.result && raw.result.ratio) || '',
      summary: (raw.result && raw.result.summary) || ''
    },
    nodes: Array.isArray(raw.nodes) ? raw.nodes.map(n => ({
      id: n.id || uuid(),
      title: (n.title || '').trim(),
      kind: n.kind || 'reminder',
      dueAt: n.dueAt || '',
      done: !!n.done,
      doneAt: n.doneAt || '',
      remindDays: Array.isArray(n.remindDays) && n.remindDays.length ? n.remindDays : null,
      notifiedAt: Array.isArray(n.notifiedAt) ? n.notifiedAt : []
    })) : [],
    materials: Array.isArray(raw.materials) ? raw.materials.map(m => ({
      id: m.id || uuid(),
      name: m.name || '',
      file: m.file || '',
      kind: m.kind || 'doc',
      reusable: !!m.reusable,
      note: m.note || '',
      addedAt: m.addedAt || now
    })) : [],
    retro: {
      good: (raw.retro && raw.retro.good) || '',
      bad: (raw.retro && raw.retro.bad) || '',
      reuse: (raw.retro && raw.retro.reuse) || ''
    },
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    fromLibrary: raw.fromLibrary || null,
    createdAt: raw.createdAt || now,
    updatedAt: now,
    deviceId: DEVICE_ID,
    deletedAt: isNew ? null : (raw.deletedAt || null)
  };
  return e;
}

function getExperiences() {
  const d = readJson('experiences', { items: [] });
  const items = Array.isArray(d.items) ? d.items : [];
  return { items };
}

function listExperiences(includeDeleted) {
  const items = getExperiences().items;
  return includeDeleted ? items : items.filter(e => !e.deletedAt);
}

function getExperience(id) {
  return getExperiences().items.find(e => e.id === id) || null;
}

function upsertExperience(raw) {
  const data = getExperiences();
  const idx = data.items.findIndex(e => e.id === raw.id);
  const isNew = idx < 0;
  const next = normalizeExperience(raw, isNew);
  if (isNew) data.items.push(next);
  else data.items[idx] = { ...data.items[idx], ...next };
  writeJson('experiences', data);
  appendLog({ op: isNew ? 'experience.create' : 'experience.update', id: next.id, title: next.title });
  return next;
}

function softDeleteExperience(id) {
  const data = getExperiences();
  const e = data.items.find(x => x.id === id);
  if (!e) return null;
  e.deletedAt = nowIso();
  e.updatedAt = nowIso();
  writeJson('experiences', data);
  appendLog({ op: 'experience.delete', id, title: e.title });
  return e;
}

function restoreExperience(id) {
  const data = getExperiences();
  const e = data.items.find(x => x.id === id);
  if (!e) return null;
  e.deletedAt = null;
  e.updatedAt = nowIso();
  writeJson('experiences', data);
  appendLog({ op: 'experience.restore', id, title: e.title });
  return e;
}

/** 标记某个节点已发出的提醒（提醒补发的判断依据） */
function markNotified(expId, nodeId, stamp) {
  const data = getExperiences();
  const e = data.items.find(x => x.id === expId);
  if (!e) return false;
  const n = (e.nodes || []).find(x => x.id === nodeId);
  if (!n) return false;
  n.notifiedAt = Array.isArray(n.notifiedAt) ? n.notifiedAt : [];
  if (!n.notifiedAt.includes(stamp)) n.notifiedAt.push(stamp);
  e.updatedAt = nowIso();
  writeJson('experiences', data);
  return true;
}

/* ---------------- attachments ---------------- */

function saveAttachment(originalName, base64) {
  const ext = (path.extname(originalName || '').toLowerCase() || '.bin').slice(0, 10);
  const safe = (path.basename(originalName || 'file', path.extname(originalName || ''))
    .replace(/[^\w\u4e00-\u9fa5.\-() ]+/g, '_').slice(0, 60)) || 'file';
  const name = safe + '-' + Date.now().toString(36) + ext;
  fs.writeFileSync(path.join(ATTACH_DIR, name), Buffer.from(base64, 'base64'));
  appendLog({ op: 'attachment.add', id: name, title: originalName });
  return name;
}

function attachmentPath(name) {
  const p = path.join(ATTACH_DIR, path.basename(name));
  return fs.existsSync(p) ? p : null;
}

/* ---------------- misc ---------------- */

function writeOutbox(subject, text, html) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(OUTBOX_DIR, `${stamp}.eml`);
  const body = [
    'Subject: ' + subject,
    'X-Workbench: 本地落盘（未配置 SMTP）',
    'Content-Type: text/html; charset=utf-8',
    '',
    html || text || ''
  ].join('\r\n');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function stats() {
  const items = listExperiences(false);
  const lib = readJson('library', null);
  let nodes = 0, materials = 0;
  for (const e of items) {
    nodes += (e.nodes || []).length;
    materials += (e.materials || []).length;
  }
  return {
    experiences: items.length,
    nodes,
    materials,
    device: hostName(),
    dataDir: DATA_DIR
  };
}

module.exports = {
  DATA_DIR, BACKUP_DIR, OUTBOX_DIR, ATTACH_DIR, DEVICE_ID,
  uuid, nowIso, hostName,
  getProfile, saveProfile,
  getExperiences, listExperiences, getExperience, upsertExperience,
  softDeleteExperience, restoreExperience, markNotified,
  saveAttachment, attachmentPath,
  writeOutbox, readChangelog, recentChanges, appendLog, readJson, writeJson, stats
};
