'use strict';
/**
 * 方向标签补标（第二轮）。
 *
 * 为什么要单独一轮：
 *   第一轮的重标规则是按**竞赛名里的关键词**猜方向，对理工类很准，
 *   但对「传媒传播 / 农林食品 / 教育心理」这三个方向几乎没命中——
 *   这些竞赛的名字里根本不出现「农业」「教育」这种词（比如生命科学竞赛、
 *   海洋知识竞赛、经典诵写讲大赛）。结果就是：农林食品有 12 个专业类，
 *   却只对得上 1 项竞赛，这个方向的推荐基本是空的。
 *
 * 所以这一轮是**人工判定**，只加不删，并且每条都能说出理由。
 * 不新增竞赛条目——名单只从学会榜单和校内项目库里来，不自己编。
 *
 * 幂等：重复跑结果一致（只做集合去重）。
 */
const fs = require('fs');
const path = require('path');

const SEED = path.join(__dirname, '..', '..', 'src', 'seed', 'competitions.json');

/** 竞赛名 → 要补的方向标签（含理由） */
const ADD = {
  // —— 农林食品：12 个专业类只对上 1 项，必须补 ——
  '全国大学生生命科学竞赛': ['农林食品'],                    // 动植物 / 微生物方向，农学基础
  '全国大学生海洋知识竞赛': ['农林食品'],                    // 水产养殖、海洋渔业
  '全国大学生低碳循环科技创新大赛': ['农林食品'],              // 循环农业、农业面源污染治理
  '国际遗传工程机器大赛（iGEM Competition）': ['农林食品'],    // 合成生物学，含农业改良赛道
  '合成生物学竞赛': ['农林食品'],                            // 生物育种上游
  '“挑战杯”全国大学生课外学术科技作品竞赛': ['农林食品'],        // 自然科学类含生命科学组，农科可投

  // —— 传媒传播：只有广告艺术大赛一项，太少 ——
  '中国大学生公共关系策划创业大赛': ['传媒传播'],              // 公关策划就是传播实务
  '全国大学生数字媒体科技作品及创意竞赛': ['传媒传播'],          // 数字媒体内容生产
  '中国大学生计算机设计大赛': ['传媒传播'],                    // 设有数媒动漫与短片、微电影组

  // —— 教育心理：只有 2 项 ——
  '中华经典诵写讲大赛': ['教育心理'],                        // 面向师范生的教学技能展示
  '全国大学生语言文字能力大赛': ['教育心理'],                  // 语文教学基本功
  '全国大学生创新创业训练计划年会展示': ['教育心理']            // 大创是跨学科平台，教育学可投
};

const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
const byName = new Map(seed.items.map(i => [i.name, i]));

let touched = 0;
const miss = [];
for (const [name, tags] of Object.entries(ADD)) {
  const it = byName.get(name);
  if (!it) { miss.push(name); continue; }
  it.majorTags = it.majorTags || [];
  let changed = false;
  for (const t of tags) if (!it.majorTags.includes(t)) { it.majorTags.push(t); changed = true; }
  if (changed) { touched++; console.log('  + ' + tags.join(',') + '  →  ' + name); }
}

if (miss.length) {
  console.log('\n⚠️ 名字对不上（竞赛库改过名？）：');
  for (const m of miss) console.log('   ' + m);
}

if (touched) {
  fs.writeFileSync(SEED, JSON.stringify(seed, null, 2) + '\n', 'utf8');
}
console.log(`\n补标 ${touched} 条 · 库里共 ${seed.items.length} 条`);

const cnt = {};
for (const i of seed.items) for (const t of (i.majorTags || [])) cnt[t] = (cnt[t] || 0) + 1;
console.log('各方向竞赛数：' + Object.entries(cnt).map(([k, v]) => k + '=' + v).join('  '));
