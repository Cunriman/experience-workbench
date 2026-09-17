'use strict';
/**
 * 一次性脚本：把 PDF 抽出的纯文本转成结构化条目。
 * 输入 pdf-out.txt 由 tools/extract-pdf.py 生成。
 * 用法：node tools/parse-pdf-text.js <pdf-out.txt> <输出.json>
 */
const fs = require('fs');

const TIERS = ['国际级顶级赛事', '国际级赛事', '国家级顶级赛事', '国家级赛事'];

const src = process.argv[2];
const dst = process.argv[3];
if (!src || !dst) { console.error('用法: node parse-pdf-text.js <pdf-out.txt> <out.json>'); process.exit(1); }

// 四张表按出现顺序对应四个档次：表头是「序号 竞赛名称」，表内序号会重置回 1。
// globalNo 是全篇连续序号，映射表就按它写。
let tbl = -1;
const items = [];
for (const line of fs.readFileSync(src, 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (t === '序号 竞赛名称') { tbl++; continue; }
  if (tbl < 0) continue;
  const m = t.match(/^(\d{1,3})\s+(.+)$/);
  if (!m) continue;
  items.push({ no: items.length + 1, num: Number(m[1]), tier: TIERS[tbl], name: m[2].trim() });
}
if (tbl !== 3) throw new Error('表格数量不对，期望 4 张，实际 ' + (tbl + 1));
for (const it of items) if (!it.tier) throw new Error('第 ' + it.no + ' 条没分到档次');

fs.writeFileSync(dst, JSON.stringify({ source: src, count: items.length, tiers: TIERS, items }, null, 2) + '\n', 'utf8');
console.log(`解析 ${items.length} 条 → ${dst}`);
for (const t of TIERS) console.log('  ' + t + ' : ' + items.filter(i => i.tier === t).length);
