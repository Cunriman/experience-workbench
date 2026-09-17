'use strict';
/**
 * 成果导出：四套口径 × 语言 × 多套版式 × 四种格式。
 *
 * 结构：
 *   1. 先把经历整理成与版式无关的「内容模型」(model)
 *   2. 再由版式 (template) 决定怎么把它排出来
 *   3. 最后交给不同的输出器：HTML（页面预览 / 下载）、docx（Word）、Markdown
 *
 * 口径指的是**写什么**（保研看名次、求学看过程、出国要英文、自定义全都要），
 * 版式指的是**怎么排**，语言（中文 / 英文）是独立选项。三者正交。
 *
 * —— 关于 PDF ——
 * 不自己生成 PDF。原因：PDF 里嵌中文字体要么带一个几 MB 的子集字体，
 * 要么走 CID 映射，两条路都会把「零依赖双击即用」这条底线破坏掉，
 * 而且排版断行还得自己写一遍。浏览器自己就有排版引擎和字体，
 * 走 `window.print()` + `@page A4` 出来的是**真 PDF、矢量、文字可选中**，
 * 比任何自制方案都稳。所以预览页本身就是 A4 尺寸的打印稿，所见即所得。
 *
 * —— 关于版式出处 ——
 * 内置版式参考了这些开源简历项目（只取版式思路，CSS 是自己写的）：
 *   classic  jakegut/resume        MIT
 *   plain    sb2nov/resume         MIT
 *   academic posquit0/Awesome-CV   CC BY-SA 4.0
 *   compact  deedy/Deedy-Resume    Apache-2.0
 *   sidebar  liantze/AltaCV        LPPL-1.3c
 *   banner   YAAC (rstilling)      MIT
 *   elegant  xdanaux/moderncv      LPPL-1.3c
 *   fresh    cspagnuolo/twentysecondcv MIT
 *   dense    billryan/resume       MIT
 * 提醒一句：机器筛选（ATS）读双栏简历时会把左右两栏串成一行，
 * 所以默认给单栏，双栏留作「给人看」的场合。
 *
 * —— 关于自定义模板 ——
 * 用户可以在「更多模板」里上传自己的版式：一份 JSON（元信息 + CSS）。
 * CSS 作用在本渲染器产出的固定骨架上（.a4/.name/.contact/h2/.entry/.elist…），
 * 样例文件见 /api/export/template-sample。
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');
const taxonomy = require('./taxonomy');
const docx = require('./docx');

const CUSTOM_TPL_FILE = path.join(__dirname, '..', 'data', 'custom-templates.json');

const PROFILES = {
  baoyan: {
    label: '保研', en: 'Graduate Admission',
    desc: '重级别、名次、排名占比、指导老师——评审最关心「这个奖有多硬」。'
  },
  qiuxue: {
    label: '求职', en: 'Job Application',
    desc: '重实习、项目和你在里面干了什么——面试官要看得出你能干活。'
  },
  chuguo: {
    label: '出国', en: 'Overseas Application',
    desc: '动词开头、量化结果、国际可比性。固定英文稿，中文内容会标出来等你翻译。'
  }
};

/** 导出语言：zh = 中文稿，en = 英文骨架稿（结构化字段翻成英文，正文仍是录入的原文） */
const LANGS = { zh: '中文', en: 'English' };

const TEMPLATES = [
  {
    key: 'classic', label: '经典单栏', layout: 'one', thumb: 'center',
    desc: '最通用的一种。姓名居中、章节带分隔线，机器筛选最不容易出错。',
    credit: { name: "Jake's Resume", repo: 'jakegut/resume', license: 'MIT' }
  },
  {
    key: 'plain', label: '极简留白', layout: 'one', thumb: 'plain',
    desc: '没有分隔线，靠字重和留白分区。投邮箱附件时显得最干净。',
    credit: { name: 'sb2nov/resume', repo: 'sb2nov/resume', license: 'MIT' }
  },
  {
    key: 'academic', label: '学术履历', layout: 'one', thumb: 'academic',
    desc: '顶部加「研究方向」，章节编号、行距松。适合保研、夏令营、申请材料。',
    credit: { name: 'Awesome-CV', repo: 'posquit0/Awesome-CV', license: 'CC BY-SA 4.0' }
  },
  {
    key: 'compact', label: '紧凑双栏', layout: 'two', thumb: 'two',
    desc: '左侧放联系方式与技能，右侧放经历，信息密度最高。注意：机器筛选会读乱双栏。',
    credit: { name: 'Deedy-Resume', repo: 'deedy/Deedy-Resume', license: 'Apache-2.0' }
  },
  {
    key: 'sidebar', label: '侧栏色块', layout: 'two', thumb: 'side',
    desc: '左侧一整条深色竖栏，姓名和联系方式反白排在里面，视觉分量最重。',
    credit: { name: 'AltaCV', repo: 'liantze/AltaCV', license: 'LPPL-1.3c' }
  },
  {
    key: 'banner', label: '顶部横幅', layout: 'banner', thumb: 'banner',
    desc: '姓名压在一条通栏色带上，正文单栏。比侧栏克制，又比纯文字醒目。',
    credit: { name: 'YAAC (Awesome Source CV)', repo: 'rstilling/awesome-source-cv', license: 'MIT' }
  },
  {
    key: 'elegant', label: '典雅衬线', layout: 'one', thumb: 'elegant',
    desc: '居中姓名配细双线，章节标题用字距拉开的小字号，整体最「文气」。',
    credit: { name: 'moderncv', repo: 'xdanaux/moderncv', license: 'LPPL-1.3c' }
  },
  {
    key: 'fresh', label: '清新双栏', layout: 'fresh', thumb: 'fresh',
    desc: '顶部圆角色带 + 下方两栏，颜色最跳的一套，适合设计、传媒类场合。',
    credit: { name: 'twentysecondcv', repo: 'cspagnuolo/twentysecondcv', license: 'MIT' }
  },
  {
    key: 'dense', label: '高密度', layout: 'one', thumb: 'dense',
    desc: '字号最小、行距最紧、边距最窄，条目多的时候能压进更少的页数。',
    credit: { name: 'billryan/resume', repo: 'billryan/resume', license: 'MIT' }
  }
];

/* ---------------- 自定义（上传）模板 ---------------- */

/** 读用户上传的模板。坏文件就当没有，别让导出整个挂掉。 */
function loadCustomTemplates() {
  try {
    const raw = fs.readFileSync(CUSTOM_TPL_FILE, 'utf8').trim();
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

function saveCustomTemplates(list) {
  fs.mkdirSync(path.dirname(CUSTOM_TPL_FILE), { recursive: true });
  fs.writeFileSync(CUSTOM_TPL_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function normalizeCustomTpl(t) {
  // 四种骨架都放行——照片位置跟着骨架走（one 右上角 / two、fresh 侧栏顶部 / banner 色带右端），
  // 上传什么骨架就按什么渲染，不再一刀切回单栏
  const LAYOUTS = { one: 'center', two: 'two', banner: 'banner', fresh: 'fresh' };
  const layout = LAYOUTS[t.layout] ? t.layout : 'one';
  return {
    key: String(t.key || ''),
    label: String(t.label || '自定义模板').slice(0, 16),
    desc: String(t.desc || '').slice(0, 80),
    layout,
    thumb: LAYOUTS[layout],
    css: String(t.css || ''),
    credit: { name: '自己上传', repo: '', license: '' },
    custom: true
  };
}

/** 内置 + 上传的合并列表（前端「更多模板」子域用） */
function listTemplates() {
  return TEMPLATES.concat(loadCustomTemplates().map(normalizeCustomTpl));
}

function findTemplate(key) {
  return listTemplates().find(t => t.key === key) || null;
}

/** 上传 / 覆盖一个自定义模板。key 冲突时覆盖同 key 的旧版。 */
function upsertCustomTemplate(input) {
  const label = String(input && input.label || '').trim();
  if (!label) throw new Error('模板需要一个名字（label）');
  const css = String(input.css || '').trim();
  if (!css) throw new Error('模板需要 css 字段（作用在 .a4 骨架上的样式）');
  if (css.length > 60000) throw new Error('css 太长了（上限 60000 字符）');
  const key = 'u_' + label.toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, '_').slice(0, 24);
  const list = loadCustomTemplates().filter(t => t.key !== key);
  const one = normalizeCustomTpl({ ...input, key, label, css });
  list.push(one);
  saveCustomTemplates(list);
  return one;
}

function deleteCustomTemplate(key) {
  const list = loadCustomTemplates();
  const next = list.filter(t => t.key !== key);
  if (next.length === list.length) return false;
  saveCustomTemplates(next);
  return true;
}

/* ---------------- 内容模型（与版式无关） ---------------- */

const AWARD_RANK = { '特等奖': 1, '一等奖': 2, '金奖': 2, '二等奖': 3, '银奖': 3, '三等奖': 4, '铜奖': 4, '优秀奖': 5, '入围': 6 };

function awardRank(exp) {
  const a = (exp.result && exp.result.award) || '';
  for (const k of Object.keys(AWARD_RANK)) if (a.includes(k)) return AWARD_RANK[k];
  return 9;
}

function ym(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return String(iso).slice(0, 7);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function period(exp) {
  let a = exp.startedAt, b = exp.endedAt;
  if (!a || !b) {
    const dates = (exp.nodes || []).map(n => n.dueAt).filter(Boolean).sort();
    if (dates.length) { a = a || dates[0]; b = b || dates[dates.length - 1]; }
  }
  const s = ym(a), e = ym(b);
  if (s && e) return s === e ? s : `${s} – ${e}`;
  return s || e || '';
}

function doneNodes(exp) {
  return (exp.nodes || []).filter(n => n.dueAt)
    .sort((x, y) => String(x.dueAt).localeCompare(String(y.dueAt)));
}

function enLevel(lv) {
  if (!lv) return '';
  if (lv.includes('国家级')) return 'National Level';
  if (lv.includes('省级')) return 'Provincial Level';
  if (lv.includes('校级')) return 'University Level';
  if (lv.includes('国际')) return 'International Level';
  return lv;
}

function enAward(a) {
  const map = [['特等', 'Grand Prize'], ['一等', 'First Prize'], ['二等', 'Second Prize'], ['三等', 'Third Prize'],
    ['金', 'Gold Award'], ['银', 'Silver Award'], ['铜', 'Bronze Award'], ['优秀', 'Honorable Mention'], ['入围', 'Finalist']];
  for (const [k, v] of map) if (a.includes(k)) return v;
  return a;
}

/** 英文骨架稿的分节名。自定义类型的分节名没有翻译，原样输出。 */
const SECTION_EN = {
  '竞赛经历': 'Competitions', '项目经历': 'Projects', '论文与专利': 'Publications & Patents',
  '获奖与荣誉': 'Honors & Awards', '学生工作': 'Leadership & Activities', '实习经历': 'Internships',
  '志愿服务': 'Volunteering', '技能证书': 'Certificates', '其他': 'Others'
};

/**
 * 一条经历 → 标题 / 右侧日期 / 副标题 / 若干行
 * @returns {{title:string,right:string,sub:string,lines:Array<{text:string,kind:string}>}}
 */
function entryContent(exp, key, tax, lang) {
  const r = exp.result || {};
  const tl = taxonomy.byKey(tax, exp.type);
  const typeLabel = tl ? tl.label : '';
  const facts = [];
  if (exp.level) facts.push(lang === 'en' ? enLevel(exp.level) : exp.level);
  if (exp.track) facts.push(exp.track);
  if (exp.role) facts.push(exp.role);
  if (exp.organizer) facts.push(exp.organizer);

  const lines = [];
  const gaps = [];
  /**
   * 'draft' 不是正文，是「这条还缺东西」的提醒。
   * 它只应该出现在导出页的屏幕预览里——投出去的 PDF / Word 上不能印着
   * 「评审最看这一项，建议补上」这种话。所以这里直接分流，不进 lines。
   */
  const push = (text, kind) => {
    if (!text) return;
    if (kind === 'draft') { gaps.push({ title: exp.title, text }); return; }
    lines.push({ text, kind: kind || 'cn' });
  };

  const rankBits = () => {
    const bits = [];
    if (r.rank && r.ratio) bits.push(`名次 ${r.rank}（排名前 ${r.ratio}）`);
    else if (r.rank) bits.push(`名次 ${r.rank}`);
    else if (r.ratio) bits.push(`排名前 ${r.ratio}`);
    return bits.join('，');
  };

  if (lang === 'en') {
    // 英文骨架稿：结构化字段翻成英文，描述性内容保持原文。
    if (r.award) push(enAward(r.award));
    if (exp.level) push(enLevel(exp.level));
    if (r.rank || r.ratio) push(`Rank ${r.rank || '-'}${r.ratio ? `, top ${r.ratio}` : ''}`);
    if (r.summary) push(r.summary);
    push('English draft: structured fields are translated; narrative text stays as entered. Rewrite it into verb-first bullets before sending.', 'draft');
  } else if (key === 'baoyan') {
    const bits = rankBits();
    if (bits) push(bits);
    if (exp.track || (exp.tags || []).length) push(`赛道 / 方向：${exp.track || (exp.tags || []).join('、')}`);
    if (r.summary) push(`成果摘要：${r.summary}`);
    if (!bits && !r.summary) push('级别与名次待补——评审最看这一项，建议补上', 'draft');
  } else if (key === 'qiuxue') {
    if (exp.role) push(`我在其中的位置：${exp.role}`);
    const dn = doneNodes(exp);
    if (dn.length) {
      push('关键节点：' + dn.map(n => `${String(n.dueAt).slice(5, 10)} ${n.title}`).join('　·　'));
    }
    push(r.summary ? `我具体做了什么：${r.summary}` : '我具体做了什么：待补——面试主要问这一段', r.summary ? 'cn' : 'draft');
    if (exp.retro && exp.retro.good) push(`可讲的能力点：${exp.retro.good}`);
  } else if (key === 'custom') {
    // 不做取舍：有的全写上
    if (exp.role) push(`角色：${exp.role}`);
    const bits = rankBits();
    if (bits) push(bits);
    if (exp.track || (exp.tags || []).length) push(`赛道 / 方向：${exp.track || (exp.tags || []).join('、')}`);
    if (r.summary) push(`成果摘要：${r.summary}`);
    const dn = doneNodes(exp);
    if (dn.length) push('关键节点：' + dn.map(n => `${String(n.dueAt).slice(5, 10)} ${n.title}`).join('　·　'));
    if (exp.retro && exp.retro.good) push(`可讲的能力点：${exp.retro.good}`);
    if (!bits && !r.summary && !dn.length) push('这条还没填实质内容（名次 / 摘要 / 节点至少补一样）', 'draft');
  } else {
    // chuguo 的中文稿：偏成果表述
    if (r.award) push(`${r.award}${exp.level ? '（' + exp.level + '）' : ''}`);
    const bits = rankBits();
    if (bits) push(bits);
    if (r.summary) push(`成果摘要：${r.summary}`);
    if (!r.award && !bits && !r.summary) push('获奖与成果待补', 'draft');
  }

  // 类型专属字段（专利号、职务之类）统一塞在 meta 里，按词表顺序输出。
  // 英文稿里字段名也用英文（词表里每个字段带 en 标签），冒号跟着语言走。
  const metaBits = (tl && tl.fields || [])
    .map(f => ({ f, v: (exp.meta || {})[f.key] }))
    .filter(x => x.v)
    .map(x => lang === 'en'
      ? `${x.f.en || x.f.label}: ${x.v}`
      : `${x.f.label}：${x.v}`);
  if (metaBits.length) push(metaBits.join('　·　'));

  const awardTail = r.award && lang === 'en' ? '' : (r.award ? ' · ' + r.award : '');

  // —— 英文稿的「待翻译」标注 ——
  // 出国稿是纯英文，但系统翻不了用户手敲的中文（成果摘要、角色、赛道……）。
  // 与其让中文悄悄混进英文简历，不如在纸上标黄 + 在预览下方的缺口清单里点名，
  // 用户看到就知道该去哪补。补完英文名 / 英文摘要后标注自动消失。
  const CJK = /[\u4e00-\u9fff]/;
  let untranslated = false;
  let title = lang === 'en' && exp.titleEn ? exp.titleEn : `${exp.title}${awardTail}`;
  if (lang === 'en' && !exp.titleEn && CJK.test(exp.title)) {
    title = '【待译】' + title;
    untranslated = true;
    gaps.push({ title: exp.title, text: '缺英文标题（英文名），英文稿里只能先放中文' });
  }
  let sub = facts.join('　·　');
  if (lang === 'en' && CJK.test(sub)) {
    sub = '【待译】' + sub;
    untranslated = true;
  }
  const outLines = lines.map(l => {
    if (lang === 'en' && l.kind !== 'draft' && CJK.test(l.text)) {
      untranslated = true;
      return { ...l, kind: 'zh' };
    }
    return l;
  });
  if (lang === 'en' && untranslated) {
    gaps.push({ title: exp.title, text: '这条经历还有中文内容没翻译，英文稿里已标黄' });
  }

  return {
    // 英文稿的标题优先用英文名（竞赛/项目的官方英文名，抽屉里填）；
    // 没填就在原名前打「待译」标记，纸面上高亮，逼着自己补上。
    title,
    untranslated,
    right: period(exp),
    sub,
    lines: outLines,
    gaps,
    typeLabel
  };
}

/**
 * 三种口径各读什么顺序：同样的经历，摆法不一样。
 * 保研评审先找「奖硬不硬」；HR 先看「在哪干过什么」；国外招生先看研究产出。
 */
const PROFILE_SECTION_ORDER = {
  baoyan: [
    '获奖与荣誉', '竞赛经历', '论文与专利', '项目经历',
    '实习经历', '学生工作', '技能证书', '志愿服务', '其他'
  ],
  qiuxue: [
    '实习经历', '项目经历', '竞赛经历', '学生工作',
    '技能证书', '论文与专利', '获奖与荣誉', '志愿服务', '其他'
  ],
  chuguo: [
    '论文与专利', '项目经历', '竞赛经历', '获奖与荣誉',
    '实习经历', '学生工作', '技能证书', '志愿服务', '其他'
  ]
};

/** 简历排序：用户手填的小号在前；没填的（空 / 非正数）一律排到有号的后面 */
function rOrderOf(e) {
  const n = Number(e && e.rOrder);
  return Number.isFinite(n) && n > 0 ? n : 9999;
}

/**
 * 教育背景条目：由基本信息拼出来，不占经历。
 * 只要有学校或专业其中一样就成节；什么都没填就不出这一节（缺什么的提示走 gaps）。
 */
function educationEntry(profile, lang) {
  const en = lang === 'en';
  const school = profile.school || '';
  const majors = (profile.majors || []).join(' / ');
  if (!school && !majors && !profile.grade) return null;
  const subBits = [profile.college, majors, profile.grade].filter(Boolean);
  const lines = [];
  if (profile.studyYears) lines.push({ text: profile.studyYears, kind: '' });
  const gpaBits = [];
  if (profile.gpa) gpaBits.push(en ? `GPA: ${profile.gpa}` : `GPA：${profile.gpa}`);
  if (profile.majorRank) gpaBits.push(en ? `Rank: ${profile.majorRank}` : `专业排名：${profile.majorRank}`);
  if (gpaBits.length) lines.push({ text: gpaBits.join(en ? ' · ' : '　·　'), kind: '' });
  if (profile.englishScore) lines.push({
    text: (en ? 'English: ' : '英语：') + profile.englishScore, kind: ''
  });
  return {
    title: school || (en ? '(School pending)' : '（学校待填）'),
    sub: subBits.join(' · '),
    right: '',
    lines,
    gaps: []
  };
}

/**
 * 组装内容模型。
 * @param {{profile?:string, template?:string, lang?:string, includeTypes?:string[], includeIds?:string[]}} opts
 */
function build(opts) {
  opts = opts || {};
  const key = PROFILES[opts.profile] ? opts.profile : 'baoyan';
  const meta = PROFILES[key];
  // 出国申请没有中文简历一说——口径选了出国，就算查询串写了 zh 也按英文出
  const lang = opts.lang === 'en' || key === 'chuguo' ? 'en' : 'zh';
  const allTpls = listTemplates();
  const tplMeta = allTpls.find(t => t.key === opts.template) || allTpls[0];
  const tpl = tplMeta.key;
  const profile = store.getProfile();
  const tax = taxonomy.buildTaxonomy(profile.customTypes);
  const all = store.listExperiences(false);

  let picked = all;
  if (opts.includeIds && opts.includeIds.length) {
    picked = picked.filter(e => opts.includeIds.includes(e.id));
  } else if (opts.includeTypes && opts.includeTypes.length) {
    picked = picked.filter(e => opts.includeTypes.includes(e.type));
  }

  // 按 section 分组。节的先后不再是一套死的：
  // 保研先把奖项和竞赛亮出来，求职让实习和项目打头，出国把论文和科研放最前——
  // 读者最先看到的就是这份简历的卖点。
  const bySection = new Map();
  for (const e of picked) {
    const t = taxonomy.byKey(tax, e.type);
    const sec = (t && t.section) || '其他';
    if (!bySection.has(sec)) bySection.set(sec, []);
    bySection.get(sec).push(e);
  }
  const order = PROFILE_SECTION_ORDER[key] || taxonomy.SECTIONS.slice();
  const gaps = [];
  const sections = Array.from(bySection.keys())
    .sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    })
    .map(name => {
      const entries = bySection.get(name)
        // 简历排序（rOrder，小号在前）优先于含金量与时间——用户亲自定的顺序最大
        .sort((a, b) => rOrderOf(a) - rOrderOf(b) ||
          awardRank(a) - awardRank(b) ||
          String(b.endedAt || '').localeCompare(String(a.endedAt || '')))
        .map(e => entryContent(e, key, tax, lang));
      for (const en of entries) for (const g of (en.gaps || [])) gaps.push(g);
      return { name, nameEn: SECTION_EN[name] || name, entries };
    });

  // 教育背景不是经历，是简历的第一节：学校 / 学院 / 专业 / 年份 / GPA / 排名 / 英语
  const edu = educationEntry(profile, lang);
  if (edu) sections.unshift({ name: '教育背景', nameEn: 'Education', entries: [edu] });

  const contact = [
    profile.school,
    profile.college,
    (profile.majors || []).join(' / '),
    profile.grade,
    // 电话 / 邮箱 / 主页是简历 Contact 栏的标准件，基本信息里填了就带上
    profile.phone,
    profile.email,
    profile.homepage
  ].filter(Boolean);

  // 英文稿抬头用英文名（没填就退回中文名）；导出时间也按语言格式化
  const en = lang === 'en';
  const display = new Date();
  const generatedAt = en
    ? display.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    : display.toLocaleString('zh-CN');

  // 简历的必需信息没填就明说——提示只出现在屏幕预览里，但缺口要在导出前补上
  const required = [
    [en ? '姓名还没填' : '姓名还没填', !profile.name],
    [en ? '英文名（nameEn）还没填，英文稿抬头只能先用中文名' : '', en && !profile.nameEn && profile.name],
    ['学校还没填（教育背景一节空着）', !profile.school],
    ['专业还没填（「基本信息」里选一下）', !(profile.majors || []).length],
    ['电话和邮箱至少填一样，不然 HR / 评审联系不上你', !profile.phone && !profile.email],
    ['证件照没传（「基本信息」里上传；导出时选了「放上」也出不来）', opts.photo && !profile.photo]
  ];
  for (const [text, missing] of required) {
    if (text && missing) gaps.push({ title: '基本信息', text });
  }

  const model = {
    profileKey: key,
    label: meta.label,
    labelEn: meta.en,
    lang,
    template: tpl,
    templateMeta: tplMeta,
    // 证件照：选了「放上」且基本信息里传过照片才进纸面；Word / Markdown 出不了图，只有 HTML / PDF 有
    photo: opts.photo && profile.photo ? `/attachment/${profile.photo}` : '',
    name: en
      ? (profile.nameEn || profile.name || '(Name pending)')
      : (profile.name || '（姓名待填）'),
    contact,
    sections,
    gaps,
    count: picked.length,
    generatedAt,
    // 「研究方向」用专业方向标签拼，学术版式会用
    research: (profile.majorTags || []).length
      ? (profile.majorTags || []).join(' · ')
      : (profile.majors || []).join(' / ')
  };

  return {
    ...model,
    html: renderHtml(model, opts),
    blocks: renderBlocks(model),
    markdown: renderMarkdown(model)
  };
}

/* ---------------- 版式：HTML ---------------- */

const PRINT_CSS = `
/* 打印页边距归零：纸张自身的 padding 就是页边距，一张 .a4 严格对应一页 A4，
   分页脚本拆出来的每一张纸在打印时都从新的一页开始 */
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body {
  color: #1b1b19;
  font: 400 10.5pt/1.55 "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", Georgia, serif;
  -webkit-font-smoothing: antialiased;
}
.a4 { width: 210mm; min-height: 297mm; padding: 14mm 15mm; margin: 0 auto; background: #fff; }
@media screen { .a4 + .a4 { margin-top: 6mm; } }
h1 { margin: 0; }
a { color: inherit; text-decoration: none; }
.entry { break-inside: avoid; page-break-inside: avoid; }
.sect { break-inside: auto; }
.band { break-inside: avoid; }
.cols { break-inside: auto; }
/* 分节标题不许孤零零落在页尾：后面至少要跟得下一条 */
h2 { break-after: avoid; page-break-after: avoid; }
.ehead, .esub { break-after: avoid; page-break-after: avoid; }
.elist li { break-inside: avoid; }

/* 证件照按版式各就各位：单栏版式钉在纸右上角；
   侧栏版式（compact / sidebar / fresh）放侧栏顶部居中；
   横幅版式（banner）进色带右端。不是所有版式都往一个角落一塞了事。 */
.a4 { position: relative; }
.photo {
  position: absolute; top: 10mm; right: 13mm;
  width: 22mm; height: 30mm; object-fit: cover;
  border-radius: 1.5mm; border: .4pt solid #d8d8d2;
}
.col-l .photo {
  position: static; display: block;
  margin: 0 auto 5mm; width: 26mm; height: 34mm;
}
.band .photo {
  position: static; flex: 0 0 auto;
  width: 20mm; height: 26mm; margin: 0;
  border-color: rgba(255, 255, 255, .45);
}
.band-main { min-width: 0; }

/* 单栏版式照片钉右上角后，联系行（居中、可能很长）右端会伸到照片底下——
   :has(> .photo) 只命中把照片当直接子元素的单栏骨架，侧栏 / 色带版式不受影响。
   让出照片所在的 36mm；联系项多时宁可换行也不许压在照片下面。
   dense 的联系行是左对齐的，只让右边即可。 */
.a4:has(> .photo) .contact { padding: 0 36mm; }
.a4:has(> .photo) .headrow .contact { padding: 0 36mm 0 0; }
.a4:has(> .photo) .research { padding: 0 36mm; }

/* 英文稿里没翻完的中文：标黄 + 虚线框，一眼能认出「这段还是中文」。
   这是刻意印到纸上的信号（跟 .gaps 只在屏幕上显示不同）——
   带着黄色块投出去难看，正好逼自己翻译完再导出。 */
.zh-draft { background: #fff3bf; box-shadow: 0 0 0 2.5pt #fff3bf; outline: .6pt dashed #c9a800; }

/* 「还差这些」——屏幕预览专用，排在 A4 纸外面，不占纸面。
   打印（也就是导出 PDF）时整块消失，所以纸上永远不会出现这段提示。 */
.gaps {
  width: 210mm; max-width: 100%; margin: 8mm auto 16mm; padding: 5mm 6mm;
  border: .6pt dashed #a9c2b7; border-radius: 2mm; background: #f3f8f5;
  font: 400 9.5pt/1.65 "PingFang SC", "Microsoft YaHei", -apple-system, sans-serif;
  color: #2c4a3f;
}
.gaps b { display: block; font-size: 10.5pt; margin-bottom: 2.4mm; }
.gaps ul { margin: 0; padding-left: 5mm; }
.gaps li { margin: 1mm 0; }
.gaps-where { font-weight: 600; }
.gaps-note { margin-top: 3mm; padding-top: 2mm; border-top: .5pt solid #cfe0d8; font-size: 8.5pt; color: #5d7a6e; }
@media print {
  .gaps { display: none !important; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .a4 { break-after: page; page-break-after: always; }
  .a4:last-of-type { break-after: auto; page-break-after: auto; }
}
`;

/* 分页脚本：跟 HTML 一起发给浏览器（预览和下载的文件里都有）。
   等字体和图片就绪后量一遍内容，放不下一页就把装不下的条目搬进新的一张纸；
   一节太长就按条目拆，小标题在续页补「（续）」。双栏/侧栏版式整体涂色的
   flex 拆了会破版，明确跳过，交给打印分页兜底。 */
const PAGINATE_JS = `
(function () {
  'use strict';
  var MM = 96 / 25.4;
  function pageH() { return Math.round(297 * MM); }

  function flowKids(sheet) {
    return Array.prototype.filter.call(sheet.children, function (el) {
      return !(el.classList && el.classList.contains('photo'));
    });
  }

  function bottomIn(el, sheet) {
    return el.getBoundingClientRect().bottom - sheet.getBoundingClientRect().top;
  }

  // 判据要用「外边距盒子」的底边：margin-bottom 不进 getBoundingClientRect，
  // 却实实在在占纸上的高度。少了它，最后一条的外边距就成了看不见的溢出——
  // 实测过：整段的底边 1066、可用到 1070，看着装得下，scrollHeight 却是 1131，
  // 多出来的 8px 就是最后一条的 3.1mm 外边距。
  function outerBottom(el, sheet) {
    var mb = parseFloat(getComputedStyle(el).marginBottom);
    return bottomIn(el, sheet) + (isNaN(mb) ? 0 : mb);
  }

  function newSheet(after) {
    var s = document.createElement('div');
    s.className = 'a4';
    after.parentNode.insertBefore(s, after.nextSibling);
    return s;
  }

  function split(sheet) {
    if (sheet.querySelector('.cols')) return false;
    var cs = getComputedStyle(sheet);
    var limit = pageH() - parseFloat(cs.paddingBottom);
    var kids = flowKids(sheet);
    var boundary = null;
    // 判据就是 limit，不留容差：留 1px 会让「底边正好压在边界上」的那一段被放过去，
    // 而它后面还藏着看不见的高度（末条的外边距、行盒等），最后整张纸顶出十几像素。
    for (var i = 0; i < kids.length; i++) {
      if (outerBottom(kids[i], sheet) > limit) { boundary = kids[i]; break; }
    }
    // 兜底：纸确实超了，却没有任何子元素的底边越过 limit——多出来的高度藏在最后一个
    // 元素内部，光看子元素底边永远逮不到。这时把最后一个子元素整体挪到下一页。
    if (!boundary) {
      if (kids.length < 2) return false;
      boundary = kids[kids.length - 1];
    }

    var next = newSheet(sheet);
    if (boundary.classList.contains('sect')) {
      var entries = Array.prototype.filter.call(boundary.children, function (el) {
        return el.classList && el.classList.contains('entry');
      });
      var cut = null;
      for (var j = 0; j < entries.length; j++) {
        if (outerBottom(entries[j], sheet) > limit) { cut = entries[j]; break; }
      }
      if (cut && cut !== entries[0]) {
        var cont = document.createElement('section');
        cont.className = 'sect';
        var h2 = boundary.querySelector('h2');
        if (h2) {
          var h2c = h2.cloneNode(true);
          // 同一节连跨三页时，第二页的标题本身已经是续页标题了；靠这个标记避免
          // 再拼一次后缀，否则会出现「…（续）（续）」。
          if (!h2c.hasAttribute('data-cont')) {
            h2c.textContent += (document.documentElement.lang === 'en' ? ' (cont.)' : '（续）');
            h2c.setAttribute('data-cont', '1');
          }
          cont.appendChild(h2c);
        }
        next.appendChild(cont);
        while (cut) { var nx = cut.nextSibling; cont.appendChild(cut); cut = nx; }
        return next;
      }
    }
    while (boundary) { var n = boundary.nextSibling; next.appendChild(boundary); boundary = n; }
    return next;
  }

  function run() {
    // 队列式：split 产生的新页要重新量——快照遍历会漏掉最后拆出的那张（真实踩过）
    var queue = Array.prototype.slice.call(document.querySelectorAll('.a4'));
    var guard = 0;
    while (queue.length && guard < 80) {
      var s = queue.shift();
      while (s.scrollHeight > pageH() + 2 && guard < 80) {
        guard++;
        var nxt = split(s);
        if (!nxt) break;
        queue.unshift(nxt);
      }
    }
    // 预览外壳（父页面）在拆页完成后校正页数与翻页条
    window.__pagesReady = true;
    if (typeof window.__onPaginated === 'function') window.__onPaginated();
  }

  function start() {
    var imgs = Array.prototype.slice.call(document.images);
    var wait = imgs.map(function (im) {
      return im.complete ? null : new Promise(function (r) { im.onload = im.onerror = r; });
    }).filter(Boolean);
    Promise.all(wait).then(function () {
      return (document.fonts && document.fonts.ready) ? document.fonts.ready : null;
    }).then(run);
  }

  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start);
  window.__paginate = run;
})();
`;

/* 每套版式各自的外观。只写「这一套和别的不一样」的地方，公共部分在上面 */
const TPL_CSS = {
  classic: `
.a4 { font-family: "Songti SC", "Source Han Serif SC", "SimSun", Georgia, serif; }
.name { text-align: center; font-size: 21pt; font-weight: 700; letter-spacing: .02em; }
.contact { text-align: center; font-size: 9.5pt; color: #4a4a46; margin-top: 3mm; }
.contact span + span::before { content: " · "; color: #b9b9b4; }
h2 {
  font-size: 10.5pt; font-weight: 700; letter-spacing: .16em; color: #1d3b31;
  margin: 6.5mm 0 2.4mm; padding-bottom: 1.1mm; border-bottom: .5pt solid #c8c8c2;
}
.entry { margin: 0 0 3.1mm; }
.ehead { display: flex; align-items: baseline; gap: 3mm; }
.etitle { font-weight: 700; }
.edate { margin-left: auto; white-space: nowrap; font-size: 9.5pt; color: #4a4a46; }
.esub { font-size: 9.5pt; color: #4a4a46; margin-top: .7mm; }
.elist { margin: 1.1mm 0 0; padding-left: 4.6mm; }
.elist li { margin: .5mm 0; }
.draft { color: #8a8a84; font-style: italic; }
.foot { margin-top: 7mm; padding-top: 2mm; border-top: .5pt solid #dededa; font-size: 8.5pt; color: #8a8a84; }
`,
  plain: `
.a4 { font-family: "PingFang SC", "Microsoft YaHei", -apple-system, "Helvetica Neue", sans-serif; }
.name { font-size: 19pt; font-weight: 650; letter-spacing: -.01em; }
.contact { font-size: 9.5pt; color: #55554f; margin-top: 2mm; }
.contact span + span::before { content: " ／ "; color: #c4c4be; }
h2 {
  font-size: 8.8pt; font-weight: 600; letter-spacing: .2em; color: #6b6b64;
  text-transform: uppercase; margin: 7mm 0 2.6mm;
}
.entry { margin: 0 0 3.4mm; }
.ehead { display: flex; align-items: baseline; gap: 3mm; }
.etitle { font-weight: 600; }
.edate { margin-left: auto; white-space: nowrap; font-size: 9.3pt; color: #8a8a84; }
.esub { font-size: 9.3pt; color: #6b6b64; margin-top: .8mm; }
.elist { margin: 1.2mm 0 0; padding-left: 4.4mm; }
.elist li { margin: .6mm 0; }
.draft { color: #9a9a94; font-style: italic; }
.foot { margin-top: 8mm; font-size: 8.5pt; color: #9a9a94; }
`,
  academic: `
.a4 { font-family: "Songti SC", "Source Han Serif SC", "SimSun", Georgia, serif; }
.head { text-align: center; border-bottom: 1.2pt solid #1d3b31; padding-bottom: 3.4mm; }
.name { font-size: 20pt; font-weight: 700; letter-spacing: .06em; }
.contact { font-size: 9.5pt; color: #4a4a46; margin-top: 2.4mm; }
.contact span + span::before { content: "　|　"; color: #c8c8c2; }
.research { font-size: 9.8pt; margin-top: 2.6mm; color: #1d3b31; }
.research b { letter-spacing: .08em; }
h2 {
  font-size: 10.8pt; font-weight: 700; color: #12261f;
  margin: 6mm 0 2.6mm; padding-bottom: 1mm; border-bottom: .5pt solid #d8d8d2;
  counter-increment: sect;
}
h2::before { content: counter(sect) ". "; color: #7f9c90; }
.a4 { counter-reset: sect; }
.entry { margin: 0 0 3.6mm; }
.ehead { display: flex; align-items: baseline; gap: 3mm; }
.etitle { font-weight: 700; }
.edate { margin-left: auto; white-space: nowrap; font-size: 9.5pt; color: #4a4a46; }
.esub { font-size: 9.6pt; color: #4a4a46; margin-top: .8mm; font-style: italic; }
.elist { margin: 1.2mm 0 0; padding-left: 4.6mm; }
.elist li { margin: .55mm 0; }
.draft { color: #8a8a84; font-style: italic; }
.foot { margin-top: 8mm; padding-top: 2mm; border-top: .5pt solid #dededa; font-size: 8.5pt; color: #8a8a84; }
`,
  compact: `
.a4 { font-family: "PingFang SC", "Microsoft YaHei", -apple-system, sans-serif; padding: 0; }
.cols { display: flex; min-height: 297mm; }
.col-l { width: 33%; background: #f4f4f1; padding: 13mm 6mm 13mm 10mm; }
.col-r { width: 67%; padding: 13mm 10mm 13mm 7mm; }
.name { font-size: 16pt; font-weight: 650; line-height: 1.25; }
.side-h {
  font-size: 8.2pt; font-weight: 600; letter-spacing: .16em; color: #6b6b64;
  margin: 5.4mm 0 1.8mm; text-transform: uppercase;
}
.side-txt { font-size: 9.2pt; color: #33332f; line-height: 1.6; }
.side-txt b { display: block; font-weight: 600; }
h2 {
  font-size: 9.2pt; font-weight: 700; letter-spacing: .14em; color: #1d3b31;
  margin: 5.4mm 0 2.2mm; padding-bottom: .9mm; border-bottom: .5pt solid #cfcfc9;
}
h2:first-of-type { margin-top: 0; }
.entry { margin: 0 0 2.9mm; }
.ehead { display: flex; align-items: baseline; gap: 2.4mm; }
.etitle { font-weight: 650; font-size: 10.2pt; }
.edate { margin-left: auto; white-space: nowrap; font-size: 8.8pt; color: #6b6b64; }
.esub { font-size: 9pt; color: #55554f; margin-top: .6mm; }
.elist { margin: 1mm 0 0; padding-left: 4.2mm; }
.elist li { margin: .45mm 0; font-size: 9.6pt; line-height: 1.5; }
.draft { color: #8a8a84; font-style: italic; }
.foot { font-size: 8.2pt; color: #8a8a84; margin-top: 6mm; }
`,
  sidebar: `
.a4 { font-family: "PingFang SC", "Microsoft YaHei", -apple-system, sans-serif; padding: 0; }
.cols { display: flex; min-height: 297mm; }
.col-l { width: 36%; background: #1d3b31; color: #f2f6f4; padding: 13mm 7mm; }
.col-l .photo { border-color: rgba(255, 255, 255, .4); }
.col-r { width: 64%; padding: 13mm 10mm; }
.name { font-size: 15.5pt; font-weight: 700; line-height: 1.3; color: #fff; }
.side-h {
  font-size: 8pt; font-weight: 600; letter-spacing: .18em; color: #9dc3b5;
  margin: 5.6mm 0 1.8mm; text-transform: uppercase;
}
.side-txt { font-size: 9pt; color: #dce9e3; line-height: 1.65; }
.side-txt b { display: block; font-weight: 600; color: #fff; }
h2 {
  font-size: 9.4pt; font-weight: 700; letter-spacing: .14em; color: #1d3b31;
  margin: 5.2mm 0 2.2mm; padding-bottom: .9mm; border-bottom: .8pt solid #1d3b31;
}
h2:first-of-type { margin-top: 0; }
.entry { margin: 0 0 3mm; }
.ehead { display: flex; align-items: baseline; gap: 2.4mm; }
.etitle { font-weight: 650; font-size: 10.2pt; }
.edate { margin-left: auto; white-space: nowrap; font-size: 8.8pt; color: #6b6b64; }
.esub { font-size: 9pt; color: #55554f; margin-top: .6mm; }
.elist { margin: 1mm 0 0; padding-left: 4.2mm; }
.elist li { margin: .45mm 0; font-size: 9.6pt; line-height: 1.5; }
.draft { color: #8a8a84; font-style: italic; }
.foot { font-size: 8.2pt; color: #8a8a84; margin-top: 6mm; }
`,
  banner: `
.a4 { font-family: "PingFang SC", "Microsoft YaHei", -apple-system, sans-serif; padding: 0 15mm 14mm; }
.band { background: #1d3b31; color: #fff; margin: 0 -15mm 8mm; padding: 9mm 15mm 8mm;
  display: flex; align-items: center; justify-content: space-between; gap: 6mm; }
.band-main { min-width: 0; }
.name { font-size: 19pt; font-weight: 700; letter-spacing: .02em; color: #fff; }
.contact { font-size: 9.3pt; color: #cfe0d8; margin-top: 2.2mm; }
.contact span + span::before { content: " · "; color: #6f9587; }
h2 {
  font-size: 9.4pt; font-weight: 700; letter-spacing: .16em; color: #1d3b31;
  margin: 5.8mm 0 2.2mm; padding-bottom: .9mm; border-bottom: .5pt solid #c8c8c2;
}
.entry { margin: 0 0 3mm; }
.ehead { display: flex; align-items: baseline; gap: 2.6mm; }
.etitle { font-weight: 650; }
.edate { margin-left: auto; white-space: nowrap; font-size: 9.2pt; color: #6b6b64; }
.esub { font-size: 9.2pt; color: #55554f; margin-top: .6mm; }
.elist { margin: 1mm 0 0; padding-left: 4.4mm; }
.elist li { margin: .5mm 0; }
.draft { color: #8a8a84; font-style: italic; }
.foot { margin-top: 7mm; padding-top: 2mm; border-top: .5pt solid #dededa; font-size: 8.5pt; color: #8a8a84; }
`,
  elegant: `
.a4 { font-family: "Songti SC", "Source Han Serif SC", "SimSun", Georgia, serif; }
.name { text-align: center; font-size: 22pt; font-weight: 400; letter-spacing: .3em; text-indent: .3em; }
.contact { text-align: center; font-size: 9.3pt; color: #55554f; margin-top: 2.6mm; }
.contact span + span::before { content: " ✦ "; color: #b9b9b4; font-size: 7pt; }
.head { border-bottom: .5pt solid #1b1b19; padding-bottom: 3mm; position: relative; }
.head::after { content: ""; display: block; border-bottom: 2.2pt solid #1b1b19; margin-top: 1.1mm; }
h2 {
  font-size: 10pt; font-weight: 400; letter-spacing: .34em; text-indent: .34em;
  text-align: center; color: #1b1b19; margin: 6.6mm 0 2.8mm;
}
h2::before, h2::after { content: "——"; color: #c8c8c2; font-size: 8pt; letter-spacing: 0; text-indent: 0; margin: 0 2.4mm; vertical-align: .28em; }
.entry { margin: 0 0 3.4mm; }
.ehead { display: flex; align-items: baseline; gap: 3mm; }
.etitle { font-weight: 700; }
.edate { margin-left: auto; white-space: nowrap; font-size: 9.4pt; color: #55554f; font-style: italic; }
.esub { font-size: 9.4pt; color: #55554f; margin-top: .7mm; }
.elist { margin: 1.1mm 0 0; padding-left: 4.6mm; }
.elist li { margin: .55mm 0; }
.draft { color: #8a8a84; font-style: italic; }
.foot { margin-top: 8mm; padding-top: 2mm; border-top: .5pt solid #dededa; font-size: 8.5pt; color: #8a8a84; text-align: center; }
`,
  fresh: `
.a4 { font-family: "PingFang SC", "Microsoft YaHei", -apple-system, sans-serif; padding: 0; }
.band { background: #3f7d6b; color: #fff; padding: 8mm 10mm 7mm; }
.name { font-size: 18pt; font-weight: 700; color: #fff; }
.contact { font-size: 9.2pt; color: #d5e8e0; margin-top: 2mm; }
.contact span + span::before { content: " · "; color: #9dc3b5; }
.cols { display: flex; min-height: 250mm; }
.col-l { width: 32%; padding: 11mm 6mm 11mm 10mm; background: #f2f7f4; }
.col-r { width: 68%; padding: 11mm 10mm 11mm 7mm; }
.side-h {
  font-size: 8.2pt; font-weight: 600; letter-spacing: .16em; color: #3f7d6b;
  margin: 5mm 0 1.8mm; text-transform: uppercase;
}
.side-txt { font-size: 9.2pt; color: #33332f; line-height: 1.6; }
.side-txt b { display: block; font-weight: 600; }
h2 {
  font-size: 9.4pt; font-weight: 700; letter-spacing: .12em; color: #3f7d6b;
  margin: 5.2mm 0 2.2mm; padding-bottom: .9mm; border-bottom: .5pt solid #cfe0d8;
}
h2:first-of-type { margin-top: 0; }
.entry { margin: 0 0 3mm; }
.ehead { display: flex; align-items: baseline; gap: 2.4mm; }
.etitle { font-weight: 650; font-size: 10.2pt; }
.edate { margin-left: auto; white-space: nowrap; font-size: 8.8pt; color: #6b6b64; }
.esub { font-size: 9pt; color: #55554f; margin-top: .6mm; }
.elist { margin: 1mm 0 0; padding-left: 4.2mm; }
.elist li { margin: .45mm 0; font-size: 9.6pt; line-height: 1.5; }
.draft { color: #8a8a84; font-style: italic; }
.foot { font-size: 8.2pt; color: #8a8a84; margin-top: 6mm; }
`,
  dense: `
.a4 { font-family: "PingFang SC", "Microsoft YaHei", -apple-system, sans-serif; padding: 10mm 11mm; font-size: 9.4pt; line-height: 1.42; }
.headrow { display: flex; align-items: baseline; gap: 4mm; border-bottom: 1.4pt solid #1b1b19; padding-bottom: 2mm; }
.name { font-size: 16pt; font-weight: 700; letter-spacing: 0; }
.contact { font-size: 8.6pt; color: #55554f; margin-top: 1.2mm; }
.contact span + span::before { content: " · "; color: #b9b9b4; }
h2 {
  font-size: 9pt; font-weight: 700; letter-spacing: .1em; color: #1b1b19;
  margin: 4.2mm 0 1.6mm; padding-bottom: .6mm; border-bottom: .5pt solid #d8d8d2;
}
.entry { margin: 0 0 2.2mm; }
.ehead { display: flex; align-items: baseline; gap: 2.4mm; }
.etitle { font-weight: 650; font-size: 9.8pt; }
.edate { margin-left: auto; white-space: nowrap; font-size: 8.6pt; color: #6b6b64; }
.esub { font-size: 8.8pt; color: #55554f; margin-top: .4mm; }
.elist { margin: .7mm 0 0; padding-left: 4mm; }
.elist li { margin: .3mm 0; font-size: 9pt; line-height: 1.45; }
.draft { color: #8a8a84; font-style: italic; }
.foot { margin-top: 5mm; padding-top: 1.4mm; border-top: .5pt solid #dededa; font-size: 8pt; color: #8a8a84; }
`
};

function tplCss(tplMeta) {
  if (tplMeta && tplMeta.custom) return tplMeta.css || '';
  return TPL_CSS[tplMeta ? tplMeta.key : 'classic'] || TPL_CSS.classic;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function contactHtml(model, tag = 'span') {
  if (!model.contact.length) return '';
  return `<div class="contact">${model.contact.map(c => `<${tag}>${esc(c)}</${tag}>`).join('')}</div>`;
}

function sectionHtml(sec, lang) {
  const head = lang === 'en' ? sec.nameEn : sec.name;
  const items = sec.entries.map(e => {
    const lines = e.lines.length
      ? `<ul class="elist">${e.lines.map(l =>
          `<li class="${l.kind === 'draft' ? 'draft' : ''}${l.kind === 'zh' ? ' zh-draft' : ''}">${esc(l.text)}</li>`).join('')}</ul>`
      : '';
    // 英文稿里没翻完的中文统一标黄——包括没填英文名的标题
    const sub = e.sub ? `<div class="esub${e.untranslated ? ' zh-draft' : ''}">${esc(e.sub)}</div>` : '';
    const right = e.right ? `<span class="edate">${esc(e.right)}</span>` : '';
    const titleCls = e.untranslated ? 'etitle zh-draft' : 'etitle';
    return `<div class="entry">
      <div class="ehead"><span class="${titleCls}">${esc(e.title)}</span>${right}</div>
      ${sub}${lines}
    </div>`;
  }).join('');
  return `<section class="sect"><h2>${esc(head)}</h2>${items}</section>`;
}

/**
 * 证件照。放哪儿由版式结构决定：单栏版式插在 .a4 里（CSS 绝对定位到右上角），
 * 侧栏版式插进左栏顶部，横幅版式插进色带右端——位置配合上面的 .photo 分支样式。
 */
function photoHtml(model) {
  if (!model.photo) return '';
  return `<img class="photo" src="${esc(model.photo)}" alt="photo">`;
}

function footHtml(model) {
  const label = model.lang === 'en' ? model.labelEn : model.label;
  if (model.lang === 'en') {
    return `<div class="foot">Generated ${esc(model.generatedAt)} · Profile: ${esc(label)} · Template: ${esc(model.templateMeta.label)} · Data: local workbench</div>`;
  }
  return `<div class="foot">导出时间 ${esc(model.generatedAt)}　·　口径：${esc(label)}　·　版式：${esc(model.templateMeta.label)}　·　数据来源：本地工作台</div>`;
}

/**
 * 「还差这些」清单——只给屏幕预览看。
 * 同一个类型缺同一样东西会在每条经历上重复一次（比如 5 条都没填级别），
 * 所以先按文案合并，再列出涉及哪些条目。
 */
function gapsBlock(model) {
  const list = model.gaps || [];
  if (!list.length) return '';
  const seen = new Map();
  const uniq = [];
  for (const g of list) {
    const hit = seen.get(g.text);
    if (hit) {
      hit.n++;
      if (!hit.titles.includes(g.title)) hit.titles.push(g.title);
      continue;
    }
    const o = { text: g.text, n: 1, titles: [g.title] };
    seen.set(g.text, o);
    uniq.push(o);
  }
  return `<div class="gaps">
    <b>这份稿子还差这些（${list.length} 处）</b>
    <ul>${uniq.map(u => `<li><span class="gaps-where">${esc(u.titles.slice(0, 3).join('、'))}${u.titles.length > 3 ? ` 等 ${u.titles.length} 项` : ''}</span>　${esc(u.text)}</li>`).join('')}</ul>
    <div class="gaps-note">这段提示只显示在屏幕上，打印和下载的文件里不会有——所以你可以放心接着改。</div>
  </div>`;
}

/** 左右两栏版式公用的侧栏（compact / sidebar / fresh / 上传的双栏）。
 *  fresh 的姓名已经在顶部色带里了，侧栏里再来一个就是重复——withName 关掉。 */
function asideHtml(model, photo, withName = true) {
  const zh = model.lang !== 'en';
  return `<aside class="col-l">
    ${photo || ''}
    ${withName ? `<div class="name">${esc(model.name)}</div>` : ''}
    <div class="side-h">${zh ? '联系' : 'Contact'}</div><div class="side-txt">${model.contact.map(esc).join('<br>')}</div>
    ${model.research ? `<div class="side-h">${zh ? '方向' : 'Focus'}</div><div class="side-txt">${esc(model.research)}</div>` : ''}
    ${model.sections.length ? `<div class="side-h">${zh ? '经历概览' : 'Overview'}</div><div class="side-txt">${model.sections.map(s => `<b>${esc(zh ? s.name : s.nameEn)}</b>${s.entries.length} ${zh ? '项' : 'items'}`).join('')}</div>` : ''}
  </aside>`;
}

function renderHtml(model, opts) {
  opts = opts || {};
  const tplMeta = model.templateMeta;
  const layout = tplMeta.layout || 'one';
  const body = model.sections.length
    ? model.sections.map(s => sectionHtml(s, model.lang)).join('')
    : `<p class="draft">${model.lang === 'en' ? 'Nothing to export yet. Add an experience first.' : '还没有可导出的经历。先去「经历档案」录一条。'}</p>`;
  const gaps = opts.preview ? gapsBlock(model) : '';
  const css = PRINT_CSS + tplCss(tplMeta);

  if (layout === 'two') {
    return `<!DOCTYPE html><html lang="${model.lang === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8">
<title>${esc(model.name)} · ${esc(model.label)}</title><style>${css}</style></head>
<body><div class="a4"><div class="cols">${asideHtml(model, photoHtml(model))}<main class="col-r">${body}${footHtml(model)}</main></div></div>${gaps}<script>${PAGINATE_JS}</script></body></html>`;
  }

  if (layout === 'banner' || layout === 'fresh') {
    if (layout === 'banner') {
      // 照片进色带右端：色带本身是 flex，姓名联系方式在左、照片在右
      const band = `<div class="band"><div class="band-main"><div class="name">${esc(model.name)}</div>${contactHtml(model)}</div>${photoHtml(model)}</div>`;
      return `<!DOCTYPE html><html lang="${model.lang === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8">
<title>${esc(model.name)} · ${esc(model.label)}</title><style>${css}</style></head>
<body><div class="a4">${band}${body}${footHtml(model)}</div>${gaps}<script>${PAGINATE_JS}</script></body></html>`;
    }
    const band = `<div class="band"><div class="name">${esc(model.name)}</div>${contactHtml(model)}</div>`;
    return `<!DOCTYPE html><html lang="${model.lang === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8">
<title>${esc(model.name)} · ${esc(model.label)}</title><style>${css}</style></head>
<body><div class="a4">${band}<div class="cols">${asideHtml(model, photoHtml(model), false)}<main class="col-r">${body}${footHtml(model)}</main></div></div>${gaps}<script>${PAGINATE_JS}</script></body></html>`;
  }

  // dense：姓名左、联系右同一行
  const head = tplMeta.key === 'dense'
    ? `<div class="headrow"><div><div class="name">${esc(model.name)}</div>${contactHtml(model)}</div></div>`
    : tplMeta.key === 'academic'
      ? `<div class="head"><div class="name">${esc(model.name)}</div>${contactHtml(model)}
        ${model.research ? `<div class="research"><b>${model.lang === 'en' ? 'Focus' : '研究方向'}　</b>${esc(model.research)}</div>` : ''}</div>`
      : `<div class="name">${esc(model.name)}</div>${contactHtml(model)}`;

  return `<!DOCTYPE html><html lang="${model.lang === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8">
<title>${esc(model.name)} · ${esc(model.label)}</title><style>${css}</style></head>
<body><div class="a4">${photoHtml(model)}${head}${body}${footHtml(model)}</div>${gaps}<script>${PAGINATE_JS}</script></body></html>`;
}

/* ---------------- 版式：docx 块 ---------------- */

/**
 * Word 版统一按单栏排。
 * 双栏在 Word 里靠 section break 实现，改一个点就可能跑版，
 * 而且 ATS 一样读不好——所以这里不做双栏，宁可老实一点。
 */
function renderBlocks(model) {
  const blocks = [{ type: 'title', text: model.name }];
  if (model.contact.length) blocks.push({ type: 'meta', text: model.contact.join('　·　') });

  for (const sec of model.sections) {
    blocks.push({ type: 'heading', text: model.lang === 'en' ? sec.nameEn : sec.name });
    for (const e of sec.entries) {
      blocks.push({ type: 'entry', text: e.title, right: e.right, sub: e.sub });
      for (const l of e.lines) blocks.push({ type: 'bullet', text: l.text });
      blocks.push({ type: 'spacer' });
    }
  }
  if (!model.sections.length) blocks.push({ type: 'note', text: '还没有可导出的经历。' });
  const label = model.lang === 'en' ? model.labelEn : model.label;
  blocks.push({ type: 'note', text: `导出时间 ${model.generatedAt}　·　口径：${label}　·　数据来源：本地工作台` });
  return blocks;
}

/* ---------------- 版式：Markdown ---------------- */

/**
 * Markdown 是纯文本，不套任何版式——所以选了 Markdown 就没有模板什么事。
 * 结构保持和 A4 稿一致：姓名 → 联系方式 → 分节 → 条目（缩进要点）。
 */
function renderMarkdown(model) {
  const out = [];
  out.push(`# ${model.name}`);
  if (model.contact.length) out.push(model.contact.join(' · '));
  out.push('');
  if (!model.sections.length) {
    out.push(model.lang === 'en' ? 'Nothing to export yet.' : '还没有可导出的经历。');
  }
  for (const sec of model.sections) {
    out.push(`## ${model.lang === 'en' ? sec.nameEn : sec.name}`);
    out.push('');
    for (const e of sec.entries) {
      const date = e.right ? `（${e.right}）` : '';
      out.push(`- **${e.title}**${date}${e.sub ? `  \n  ${e.sub}` : ''}`);
      for (const l of e.lines) out.push(`  - ${l.text}`);
      out.push('');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** 给「上传模板」当样例：格式本身就是一份最小可用的模板定义 */
function sampleTemplate() {
  return {
    label: '我的蓝调版式',
    desc: '示例：把标题换成蓝色、姓名左对齐的单栏版式',
    layout: 'one',
    css: [
      '/* 这些 class 是渲染器固有的骨架，你的 css 只负责改变量。',
      '   layout 决定结构，也决定照片放哪：one=右上角（22×30mm，注意给右上角留空）、',
      '   two=侧栏顶部居中、banner=色带右端、fresh=侧栏顶部（姓名在色带里）。 */',
      '.a4 { font-family: "Microsoft YaHei", sans-serif; }',
      '.name { font-size: 22pt; font-weight: 700; color: #1a4f8a; }',
      '.contact { font-size: 9.5pt; color: #4a4a46; margin-top: 2mm; }',
      '.contact span + span::before { content: " · "; color: #b9b9b4; }',
      'h2 { font-size: 10.5pt; color: #1a4f8a; margin: 6mm 0 2mm; border-bottom: 1pt solid #1a4f8a; }',
      '.entry { margin: 0 0 3mm; }',
      '.ehead { display: flex; align-items: baseline; gap: 3mm; }',
      '.etitle { font-weight: 700; }',
      '.edate { margin-left: auto; font-size: 9.5pt; color: #4a4a46; }',
      '.esub { font-size: 9.5pt; color: #4a4a46; margin-top: .5mm; }',
      '.elist { margin: 1mm 0 0; padding-left: 4.5mm; }',
      '.foot { margin-top: 7mm; border-top: .5pt solid #dededa; font-size: 8.5pt; color: #8a8a84; }'
    ].join('\n')
  };
}

function buildDocx(model) {
  return docx.build({ blocks: model.blocks });
}

module.exports = {
  PROFILES, LANGS, TEMPLATES,
  listTemplates, findTemplate, upsertCustomTemplate, deleteCustomTemplate, sampleTemplate,
  build, buildDocx, renderHtml, renderMarkdown,
  entryContent, period, awardRank
};
