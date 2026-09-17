'use strict';
/**
 * 修正三处讲不通的「专业类 → 竞赛方向」映射。
 * 幂等：已经是目标值就跳过，可以反复跑。
 *
 * 只改这三条，其他类的映射是对着中国高等教育学会那份榜单的分类逐条核过的。
 * 保持 1 空格缩进（原始文件就是这个风格）。
 */
const fs = require('fs');
const path = require('path');

const P = path.join(__dirname, '../../src/seed/majors.json');

// 公安学类（侦查学、治安学…）：原本挂在「文法外语」下，讲不通。
// 这类专业真正对得上的是挑战杯、互联网+ 这类综合性赛事 → 改挂「综合」。
// 公安技术类（刑事科学技术、网络安全与执法）：偏计算机，保留计算机并改挂综合。
// 法医学类：本来就是医学，不需要「文法外语」。
const FIX = {
  '公安学类': ['综合'],
  '公安技术类': ['计算机', '综合'],
  '法医学类': ['医学']
};

const m = JSON.parse(fs.readFileSync(P, 'utf8'));
let n = 0;
for (const c of m.cats || []) {
  const want = FIX[c.name];
  if (!want) continue;
  if (JSON.stringify(c.tracks) === JSON.stringify(want)) continue;
  console.log(`  ${c.name}：${(c.tracks || []).join(',') || '(空)'} → ${want.join(',')}`);
  c.tracks = want;
  n++;
}
if (n) {
  m.generatedAt = new Date().toISOString();
  fs.writeFileSync(P, JSON.stringify(m, null, 1) + '\n', 'utf8');
}
console.log(`修正 ${n} 条（共 ${(m.cats || []).length} 个专业类）`);
