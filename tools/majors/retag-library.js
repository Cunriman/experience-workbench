'use strict';
/**
 * 给竞赛库补上新增的方向标签（只加不删）。
 *
 * 背景：原先库里的 majorTags 只有 10 个（综合/计算机/电子通信/机械制造/土木建筑/
 * 数理化生/经管金融/文法外语/艺术设计/医学）。做「专业 → 竞赛方向」映射时发现
 * 农林、教育、传媒、体育这四类学生无处可去，于是给词表加了 4 个标签。
 * 但库里已有的 197 条竞赛没人带这 4 个新标签，农学专业的学生会一条都推不出来。
 * 这个脚本按关键词把它们补上。
 *
 * 纪律：
 *   1. **只加不删**——不动任何已有标签，避免把上一次的人工标注洗掉。
 *   2. **规则要从严**——宁可不标，不可错标。第一版用 /球/ 匹配「体育健康」，
 *      结果「全球校园人工智能算法精英大赛」也被打成体育赛事。
 *   3. 幂等——重复跑不会重复添加，也不会改变输出。
 *
 * 用法：node tools/majors/retag-library.js
 */
const fs = require('fs');
const path = require('path');

const SEED = path.join(__dirname, '..', '..', 'src', 'seed', 'competitions.json');

const RULES = {
  // 注意：不要用裸的「运动」「球」——「运动会」要，但「全球」不要
  '体育健康': /体育|运动会|健身|田径|武术|冰雪|赛艇|帆船|龙舟|健美操|啦啦操|足球|篮球|排球|乒乓球|羽毛球|网球|游泳|马拉松/,
  '农林食品': /农业|农林|林业|园艺|植物|作物|种业|兽医|畜牧|水产|草业|食品|粮食|茶|园林|生态修复|生物育种|咖啡|动物/,
  '教育心理': /教育|教师|师范|教学|心理|学前/,
  '传媒传播': /新闻|传媒|传播|广告|微电影|播音|主持|影视|融媒体|纪录片|短视频/
};

const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
const NEW_TAGS = Object.keys(RULES);

let changed = 0;
const log = [];

for (const it of seed.items) {
  const tags = it.majorTags || (it.majorTags = []);
  const add = [];
  for (const [tag, re] of Object.entries(RULES)) {
    if (tags.includes(tag)) continue;
    if (re.test(it.name)) add.push(tag);
  }
  if (add.length) {
    it.majorTags = tags.concat(add);
    changed++;
    log.push(`  ${it.id.padEnd(10)} ${it.name}  +${add.join(',')}`);
  }
}

// 顶层词表补齐（保持既有顺序，新标签追加在后面）
const declared = seed.majorTags || [];
for (const t of NEW_TAGS) if (!declared.includes(t)) declared.push(t);
seed.majorTags = declared;

fs.writeFileSync(SEED, JSON.stringify(seed, null, 1), 'utf8');

console.log(`补标 ${changed} 条竞赛`);
if (log.length) console.log(log.join('\n'));
console.log('词表：' + seed.majorTags.join(' / '));
