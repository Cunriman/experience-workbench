'use strict';
/**
 * 把「学校认定竞赛名单」并入内置竞赛库。
 *
 * 用法：
 *   node tools/merge-uni-list.js                     # 用默认的 tools/uni-list-2024.json
 *   node tools/merge-uni-list.js <清单.json>          # 换一份清单
 *
 * 幂等：重复跑结果一致。所以直接改 src/seed/competitions.json 是安全的；
 * 想回到并入之前的骨架，把并入前的 src/seed/competitions.json 备份覆盖回去即可。
 *
 * 为什么用一张手写的映射表，而不是自动模糊匹配：
 *   试过自动匹配，结果是错的——「美国大学生数学建模竞赛」被判成了
 *   「全国大学生数学建模竞赛」，「月球基地2050国际创新大赛」被并进了
 *   「中国国际大学生创新大赛」。因为归一化会把「全国/大学生/竞赛/大赛」
 *   这些区分性很弱的词抹掉，剩下就没有区别了。
 *   拿不准的一律「新增」而不是「合并」：错并会丢掉一条真实赛事，
 *   新增最多只是库里多一条。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SEED = path.join(ROOT, 'src', 'seed', 'competitions.json');
const LIST = process.argv[2] || path.join(__dirname, 'uni-list-2024.json');

/* ---------- 清单来源与说明（写进库的顶层字段） ---------- */
const META = {
  id: 'uni-list-2024',
  libVersion: '2026.09',
  recognitionSource: '某高校《本科生学业竞赛项目库（2024 年修订）》',
  recognitionNote: '该名单把认定的竞赛分四档，依次为：国际级顶级赛事、国际级赛事、国家级顶级赛事、国家级赛事。保研与评奖时按此档次认定，国际级顶级最硬。',
  source: '中国高等教育学会《全国普通高校大学生竞赛分析报告》榜单（84 项）；某高校《本科生学业竞赛项目库（2024 年修订）》',
  caution: '本库只收录「稳定信息」：名称、校内认定档次、类别、专业方向、常见赛程。当届精确报名与截止日期每年变化，一律不预置——请以赛事官网公告为准。'
};

/* ---------- 人工逐条核对过的映射表：清单序号 → 库里已有的 id ---------- */
const MERGE = {
  1: 'cn-innovation',
  2: 'cn-tzb-datiao',
  3: 'cn-tzb-xiaotiao',
  7: 'cn-icpc',            // 同一赛事的「全球总决赛」条目
  17: 'cn-maker',
  28: 'cn-icpc',           // ACM-ICPC 在清单里出现两次（国际级顶级 / 国家级顶级），取高的一档
  29: 'cn-mcm',
  30: 'cn-nuedc',
  32: 'cn-medskill',
  33: 'cn-umic',
  34: 'cn-structure',      // 库名「结构设计竞赛」，清单写「结构设计大赛」
  35: 'cn-ada',
  36: 'cn-smartcar',
  37: 'cn-3chuang',
  38: 'cn-jnjp',
  39: 'cn-gcxl',
  40: 'cn-logistics',
  41: 'cn-unipus',
  42: 'cn-srtp',           // 清单给的正是库名的原名
  43: 'cn-curc',
  44: 'cn-siemens',
  45: 'cn-iche',
  46: 'cn-chengtu',
  47: 'cn-3dds',
  48: 'cn-jsjds',
  49: 'cn-cssc',
  50: 'cn-fwwb',
  51: 'cn-huacan',
  52: 'cn-c4',
  53: 'cn-robocup',
  54: 'cn-ciscn',
  55: 'cn-zpy',
  56: 'cn-gczbds',
  57: 'cn-lanqiao',
  58: 'cn-jxds',
  59: 'cn-softbei',
  60: 'cn-opto',
  61: 'cn-ncda',
  62: 'cn-geo',
  63: 'cn-milano',
  64: 'cn-ict',
  65: 'cn-caairobot',
  66: 'cn-cubec',
  67: 'cn-cdec',
  68: 'cn-xuechuang',
  69: 'cn-datang',
  70: 'cn-physics-exp',
  73: 'cn-culsc',
  74: 'cn-huawei-ict',
  75: 'cn-robotcontest',
  76: 'cn-socchina',
  81: 'cn-iot',
  85: 'cn-cid',
  114: 'cn-cteic',
  119: 'cn-jcyxds',
  137: 'cn-tjjm',
  145: 'cn-uiaec',
  146: 'cn-ican',
  154: 'cn-energy-econ',
  158: 'cn-sflep'
};

const RANK = { '国际级顶级赛事': 4, '国家级顶级赛事': 3, '国际级赛事': 2, '国家级赛事': 1 };

/* ---------- 归类 ---------- */
// 顺序即优先级。要点：把「设计 / 创意 / 创新」这类贪心词放最后——
// 否则「飞行器设计大赛」「生物分子设计大赛」「高分子材料创新创业大赛」会被艺术设计抢走。
const CAT_RULES = [
  ['语言文化', /英语|翻译|口译|外语|俄语|日语|德语|法语|西班牙语|汉语|演讲|跨文化|语言文字|写作|诵读|模拟法庭|法庭|仲裁|法律/],
  ['医学', /医学|医药|药学|中药|临床|口腔|中医|检验|形态学|药苑|基础医学/],
  ['化工', /化工|化学工程/],
  ['机器人', /机器人/],
  ['电子通信', /电子|通信|集成电路|芯片|光电|自动化|电气|嵌入式|物联网|5G/],
  ['计算机', /计算机|软件|程序|算法|人工智能|网络|信息安全|密码|数据|智能/],
  ['测绘地理', /测绘|地质|海洋|水利|地理|国土空间/],
  // 刻意不含「规划」——否则「全国大学生职业规划大赛」会被判成土木建筑
  ['土木建筑', /建筑|土木|建造|城市|景观|人居环境|建协|混凝土|斯维尔|BIM|桥梁|建材/],
  ['数理化生', /数学|物理|化学|生物|生命|力学|高分子|材料|统计|合成生物/],
  ['工程机械', /机械|工程|装备|制造|飞行器|航天|车辆|航空/],
  ['经管金融', /经管|金融|会计|财会|市场|商业|商务|物流|创业|管理|案例分析|税收|企业竞争|贸易|毕马威|尖烽/],
  ['能源环境', /能源|太阳能|低碳|可再生|新能源|动力电池|节能|绿色|环保/],
  ['艺术设计', /设计|美术|艺术|漆画|音乐|钢琴|舞蹈|摄影|视觉|绘画|展览|作品展|创意/],
  ['综合创新', /创新|挑战杯|综合|创新创业/]
];
// 规则管不住的个别条目，人工指定（按清单序号）
const CAT_OVERRIDE = {
  5: '数理化生'   // 国际遗传工程机器大赛（iGEM）——名字里只有「工程机器」，没有「生物」
};

const CAT_TAGS = {
  '综合创新': ['综合'], '计算机': ['计算机'], '电子通信': ['电子通信', '计算机'],
  '机器人': ['计算机', '机械制造'], '工程机械': ['机械制造'], '机械制造': ['机械制造'],
  '土木建筑': ['土木建筑'], '化工': ['数理化生'], '医学': ['医学'], '数理化生': ['数理化生'],
  '能源环境': ['数理化生', '机械制造'], '测绘地理': ['土木建筑', '数理化生'],
  '艺术设计': ['艺术设计'], '经管金融': ['经管金融'], '语言文化': ['文法外语'], '国际赛事': ['综合']
};

function categorize(name, no) {
  if (CAT_OVERRIDE[no]) return CAT_OVERRIDE[no];
  for (const [cat, re] of CAT_RULES) if (re.test(name)) return cat;
  return '综合创新';
}
// PDF 表格换行会在词中间留空格（「形态学 技能大赛」），只吃掉两个汉字之间的空格，
// 不动「计划 2.0」这种数字前的空格。
function cleanName(s) {
  return String(s)
    .replace(/（原名[:：][^）]*）/g, '')
    .replace(/([\u4e00-\u9fa5])[ \t]+([\u4e00-\u9fa5])/g, '$1$2')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
function shortOf(name) {
  const s = name.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '')
    .replace(/^(全国普通高等学校|全国高等院校|全国高校|中国高校|全国大学生|中国大学生|全国|中国)/, '').trim();
  return s.length >= 4 ? s : name.replace(/（[^）]*）/g, '').trim();
}

/* ---------- 执行 ---------- */
const list = JSON.parse(fs.readFileSync(LIST, 'utf8'));
if (!Array.isArray(list.items) || !list.items.length) throw new Error('清单里没有 items：' + LIST);
const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
const byId = new Map(seed.items.map(it => [it.id, it]));

for (const [no, id] of Object.entries(MERGE)) {
  if (!byId.has(id)) throw new Error(`映射表第 ${no} 条指向了不存在的 id：${id}`);
}

// 1) 命中的条目补上（或刷新）校内档次；同一赛事出现多次时取最高的那档
const best = new Map();
for (const it of list.items) {
  const target = MERGE[it.no];
  if (!target) continue;
  const prev = best.get(target);
  if (!prev || RANK[it.tier] > RANK[prev]) best.set(target, it.tier);
}
let stamped = 0;
for (const [id, tier] of best) {
  if (byId.get(id).recognition !== tier) stamped++;
  byId.get(id).recognition = tier;
}

// 2) 其余按 `uni-<序号>` 新增（已存在则跳过，保证幂等）
const added = [];
let skipped = 0;
for (const it of list.items) {
  if (MERGE[it.no]) continue;
  const id = META.id.split('-')[0] + '-' + String(it.no).padStart(3, '0');
  if (byId.has(id)) { skipped++; continue; }
  const cat = categorize(it.name, it.no);
  const item = {
    id,
    name: cleanName(it.name),
    short: shortOf(it.name),
    category: cat,
    recognition: it.tier,
    organizer: '',
    site: '',
    window: '',
    stages: '报名比赛评奖',
    majorTags: CAT_TAGS[cat] || ['综合']
  };
  added.push(item);
  byId.set(id, item);
}

const next = {
  ...seed,
  libVersion: META.libVersion,
  source: META.source,
  caution: META.caution,
  recognitionSource: META.recognitionSource,
  recognitionNote: META.recognitionNote
};
// 命中的旧条目保持原顺序在前，新增的追加在后
next.items = seed.items.concat(added);
fs.writeFileSync(SEED, JSON.stringify(next, null, 2) + '\n', 'utf8');

/* ---------- 报告 ---------- */
const dist = {};
for (const it of next.items) if (it.recognition) dist[it.recognition] = (dist[it.recognition] || 0) + 1;
console.log(`清单 ${list.items.length} 条 | 命中已有 ${best.size} | 新增 ${added.length} | 已存在跳过 ${skipped}`);
console.log(`库：${seed.items.length} → ${next.items.length} 条`);
for (const t of list.tiers || Object.keys(RANK)) console.log(`  ${t} = ${dist[t] || 0}`);
console.log(`  名单外（学校未认定） = ${next.items.filter(i => !i.recognition).length}`);
console.log(`写回 ${SEED}`);
