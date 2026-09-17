'use strict';
/**
 * 把教育部《本科专业目录（2024年）》的纯文本解析成结构化清单。
 *
 * 输入：tools/majors/moe-2024.txt（由 extract.py 用 pypdf 抽出）
 * 输出：src/seed/majors.json
 *
 * PDF 抽出来的文本是「一个单元格一行」，行结构固定：
 *   序号 / 专业类 / 专业代码 / 专业名称 / 学位授予门类 / 修业年限 / [增设年度]
 * 所以以「专业代码」为锚点往前找专业类、往后找名称最稳。
 * 学科门类不从表里抽——直接用专业代码前两位推导（01哲学 02经济学 …），
 * 比解析页眉页脚可靠得多。
 *
 * 用法：node tools/majors/parse.js
 */
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');
const TXT = path.join(HERE, 'moe-2024.txt');
const OUT = path.join(ROOT, 'src', 'seed', 'majors.json');

const DISC_BY_PREFIX = {
  '01': '哲学', '02': '经济学', '03': '法学', '04': '教育学', '05': '文学',
  '06': '历史学', '07': '理学', '08': '工学', '09': '农学', '10': '医学',
  '12': '管理学', '13': '艺术学'
};

/**
 * 专业类 → 竞赛方向标签（这一层是我定的，不是官方口径）。
 * 判断依据：这个专业类的学生「做出来的作品长什么样」，以及他们天然对口的赛事类型。
 * 例如「测绘类」的学生写代码也跑野外，但作品更偏工程测量与空间信息 → 归土木建筑 + 电子通信。
 * 一个专业类可以给多个标签，推荐时取并集。
 *
 * 标签词表必须与 src/seed/competitions.json 里的 majorTags 一致，否则匹配不上。
 */
const TRACKS_BY_CAT = {
  // —— 哲学 / 历史 / 文学 / 法学：文本、思辨、公共表达 ——
  '哲学类': ['文法外语'],
  '历史学类': ['文法外语'],
  '中国语言文学类': ['文法外语'],
  '外国语言文学类': ['文法外语'],
  '新闻传播学类': ['传媒传播', '文法外语'],
  '法学类': ['文法外语'],
  '政治学类': ['文法外语'],
  '社会学类': ['文法外语'],
  '民族学类': ['文法外语'],
  '马克思主义理论类': ['文法外语'],
  '公安学类': ['文法外语'],
  '公安技术类': ['文法外语', '计算机'],

  // —— 经济学 / 管理学：商业、财务、组织 ——
  '经济学类': ['经管金融'],
  '财政学类': ['经管金融'],
  '金融学类': ['经管金融'],
  '经济与贸易类': ['经管金融'],
  '管理科学与工程类': ['经管金融'],
  '工商管理类': ['经管金融'],
  '农业经济管理类': ['经管金融', '农林食品'],
  '公共管理类': ['经管金融', '文法外语'],
  '图书情报与档案管理类': ['经管金融', '文法外语'],
  '物流管理与工程类': ['经管金融', '机械制造'],
  '工业工程类': ['经管金融', '机械制造'],
  '电子商务类': ['经管金融', '计算机'],
  '旅游管理类': ['经管金融'],

  // —— 教育学：教学、心理、表达 ——
  '教育学类': ['教育心理'],
  '心理学类': ['教育心理', '医学'],
  '体育学类': ['体育健康'],

  // —— 理学：数理化生地 ——
  '数学类': ['数理化生'],
  '物理学类': ['数理化生'],
  '化学类': ['数理化生'],
  '天文学类': ['数理化生'],
  '地理科学类': ['数理化生', '土木建筑'],
  '大气科学类': ['数理化生'],
  '海洋科学类': ['数理化生'],
  '地球物理学类': ['数理化生'],
  '地质学类': ['数理化生'],
  '生物科学类': ['数理化生'],
  '统计学类': ['数理化生', '经管金融'],

  // —— 工学 ——
  '力学类': ['数理化生', '机械制造'],
  '机械类': ['机械制造'],
  '仪器类': ['机械制造', '电子通信'],
  '材料类': ['数理化生', '机械制造'],
  '能源动力类': ['机械制造', '数理化生'],
  '电气类': ['电子通信', '机械制造'],
  '电子信息类': ['电子通信', '计算机'],
  '自动化类': ['电子通信', '计算机', '机械制造'],
  '计算机类': ['计算机'],
  '土木类': ['土木建筑'],
  '建筑类': ['土木建筑', '艺术设计'],
  '水利类': ['土木建筑'],
  '测绘类': ['土木建筑', '电子通信'],
  '化工与制药类': ['数理化生'],
  '地质类': ['数理化生', '土木建筑'],
  '矿业类': ['机械制造', '土木建筑'],
  '纺织类': ['机械制造', '艺术设计'],
  '轻工类': ['机械制造', '艺术设计'],
  '交通运输类': ['机械制造', '土木建筑'],
  '海洋工程类': ['机械制造'],
  '航空航天类': ['机械制造', '电子通信'],
  '兵器类': ['机械制造', '电子通信'],
  '核工程类': ['数理化生', '机械制造'],
  '农业工程类': ['农林食品', '机械制造'],
  '林业工程类': ['农林食品', '机械制造'],
  '环境科学与工程类': ['数理化生', '土木建筑'],
  '生物医学工程类': ['医学', '电子通信'],
  '食品科学与工程类': ['农林食品', '医学'],
  '安全科学与工程类': ['机械制造'],
  '生物工程类': ['数理化生'],

  // —— 农学 ——
  '植物生产类': ['农林食品'],
  '自然保护与环境生态类': ['农林食品', '数理化生'],
  '动物生产类': ['农林食品'],
  '动物医学类': ['农林食品', '医学'],
  '林学类': ['农林食品'],
  '水产类': ['农林食品'],
  '草学类': ['农林食品'],

  // —— 医学 ——
  '基础医学类': ['医学'],
  '临床医学类': ['医学'],
  '口腔医学类': ['医学'],
  '公共卫生与预防医学类': ['医学'],
  '中医学类': ['医学'],
  '中西医结合类': ['医学'],
  '药学类': ['医学', '数理化生'],
  '中药学类': ['医学', '农林食品'],
  '法医学类': ['医学', '文法外语'],
  '医学技术类': ['医学'],
  '护理学类': ['医学'],

  // —— 艺术学 ——
  '艺术学理论类': ['艺术设计', '文法外语'],
  '音乐与舞蹈学类': ['艺术设计'],
  '戏剧与影视学类': ['艺术设计', '传媒传播'],
  '美术学类': ['艺术设计'],
  '设计学类': ['艺术设计'],

  // —— 交叉学科（2023 年新设专业类）——
  '交叉工程类': ['综合']
};

const NOISE = [
  /^—\s*\d+\s*—$/,                    // 页码
  /^序号$/, /^门类、专业类$/, /^专业代码$/, /^专业名称$/,
  /^学位授予$/, /^修业年限$/, /^增设$/, /^年度$/, /^门类$/,
  /^附件$/, /^2$/, /^普通高等学校本科专业目录/
];

function readLines() {
  const raw = fs.readFileSync(TXT, 'utf8');
  return raw.split(/\r?\n/).map(s => s.trim()).filter(s => s && !NOISE.some(re => re.test(s)));
}

const DISC_NAMES = ['哲学', '经济学', '法学', '教育学', '文学', '历史学', '理学', '工学', '农学', '医学', '管理学', '艺术学'];
const YEARS = /^(二|三|四|五|六|八)年(,(二|三|四|五|六|八)年)*$/;
// 专业代码绝大多数是 6 位，但 2018 年之后追加的少数特设专业是 7 位（如 0502100T 语言学）。
// 只写 \d{6} 会静默漏掉这 4 个——当时的症状是「总数比官方少 4 个但一行错误都不报」。
const CODE = /^\d{6,7}[TK]{0,2}$/;

/**
 * 「学位授予」字段可能是 1 个或 2 个门类（逗号分隔），例如「理学,工学」。
 * 而且 PDF 换行会把这一格劈成两截（「管理学,经」+「济学」），专业名本身也可能
 * 被劈成两截（「飞行器环境与生命保障工」+「程」）。所以不能按位置取，
 * 得把这一段拼起来、从**尾部**匹配最长的合法学位串，剩下的才是专业名。
 */
const DEGREES = (() => {
  const one = DISC_NAMES.slice();
  const two = [];
  for (const a of DISC_NAMES) for (const b of DISC_NAMES) if (a !== b) two.push(a + ',' + b);
  return one.concat(two).sort((x, y) => y.length - x.length);
})();

function parse() {
  const lines = readLines();
  const majors = [];
  const problems = [];

  for (let i = 0; i < lines.length; i++) {
    if (!CODE.test(lines[i])) continue;
    const code = lines[i];

    // 往前：专业类（中间可能夹着序号）
    let j = i - 1;
    if (/^\d+$/.test(lines[j] || '')) j--;
    const cat = lines[j] || '';

    // 往后：先找到「修业年限」，它之前的所有行都是专业名 + 学位授予（两格都可能被换行劈开）
    let yIdx = -1;
    for (let k = i + 1; k < Math.min(i + 8, lines.length); k++) {
      if (YEARS.test(lines[k])) { yIdx = k; break; }
    }
    if (yIdx < 0) { problems.push({ code, name: lines[i + 1] || '', why: '往后 8 行内找不到修业年限' }); continue; }

    const joined = lines.slice(i + 1, yIdx).join('');
    const degree = DEGREES.find(d => joined.length > d.length && joined.endsWith(d));
    if (!degree) { problems.push({ code, name: lines[i + 1] || '', why: '尾部匹配不到合法学位串: ' + joined }); continue; }
    const name = joined.slice(0, joined.length - degree.length);

    const disc = DISC_BY_PREFIX[code.slice(0, 2)] || '';
    if (!disc) problems.push({ code, name, why: '专业代码前两位无法识别门类' });

    majors.push({
      code,
      name,
      cat,
      catCode: code.slice(0, 4),
      disc,
      flag: code.replace(/^\d+/, '')
    });
  }

  // 去重（同一专业代码只应出现一次）
  const seen = new Map();
  for (const m of majors) {
    if (seen.has(m.code)) problems.push({ code: m.code, name: m.name, why: '重复出现' });
    else seen.set(m.code, m);
  }
  const list = Array.from(seen.values());

  // 专业类 → 方向标签；顺带查出没有映射的专业类（不能静默漏掉）
  const catNames = Array.from(new Set(list.map(m => m.cat))).sort();
  const unmapped = catNames.filter(c => !TRACKS_BY_CAT[c]);
  const extraMapped = Object.keys(TRACKS_BY_CAT).filter(c => !catNames.includes(c));

  const cats = catNames.map(c => {
    const inCat = list.filter(m => m.cat === c);
    return {
      code: inCat[0].catCode,
      name: c,
      disc: inCat[0].disc,
      count: inCat.length,
      tracks: TRACKS_BY_CAT[c] || []
    };
  });

  const tags = Array.from(new Set(cats.flatMap(c => c.tracks))).sort();

  parse.report = { problems, unmapped, extraMapped };

  return {
    source: '教育部《普通高等学校本科专业目录（2024年）》',
    sourceUrl: 'https://www.moe.gov.cn/srcsite/A08/moe_1034/s4930/202403/W020240319305498791768.pdf',
    version: '2024',
    generatedAt: new Date().toISOString(),
    note: '专业名/专业类/门类取自教育部目录原文；「方向标签」是把专业类映射到竞赛类型的自定义口径，不是官方分类。',
    counts: {
      disc: new Set(list.map(m => m.disc)).size,
      cat: cats.length,
      major: list.length
    },
    tags,
    discs: DISC_BY_PREFIX,
    cats,
    majors: list
  };
}

const data = parse();
fs.writeFileSync(OUT, JSON.stringify(data, null, 1), 'utf8');

console.log('门类', data.counts.disc, '｜专业类', data.counts.cat, '｜专业', data.counts.major);
console.log('方向标签(' + data.tags.length + ')：' + data.tags.join(' / '));
console.log('→ ' + OUT);

const report = parse.report;
if (report.problems.length) {
  console.log('\n⚠️ 有 ' + report.problems.length + ' 行没能解析（这些专业会丢，必须处理）：');
  for (const p of report.problems.slice(0, 40)) console.log('   ', p.code, p.name, '::', p.why);
} else {
  console.log('\n解析无异常行。');
}
if (report.unmapped.length) {
  console.log('\n⚠️ 以下专业类没有方向标签映射（这些专业推荐不出东西）：');
  console.log('   ', report.unmapped.join(' / '));
}
if (report.extraMapped.length) {
  console.log('\n提示：映射表里有目录中不存在的专业类名，可能是笔误：');
  console.log('   ', report.extraMapped.join(' / '));
}
if (data.counts.major !== 816) console.log('\n⚠️ 官方公布 816 个专业，当前 ' + data.counts.major + '，差 ' + (816 - data.counts.major) + ' 个');
