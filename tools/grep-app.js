'use strict';
/* 一次性小工具：改完前端后核对「该清的清干净了、该有的都有」。
   直接跑 node tools/grep-app.js 即可，不属于产品代码。 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const files = ['public/app.js', 'public/index.html', 'public/styles.css'];

const GONE = ['exportOut', '_expView', 'mdToHtml', 'genExport', 'downloadText',
  'export-gen', 'export-save', 'export-copy', 'data-major', 'data-eview'];

const WANT = {
  'public/app.js': ['function typeIcon', 'function tplThumb', 'function exportNow', 'function addTypeModal',
    'function suggestMajors', 'function addMajor', 'function removeMajor', 'function paintCoverage',
    'function syncExportPreview', 'function presentedTypes', 'function exportQuery',
    'function curExportTemplate', 'data-deltype', 'data-etype', 'data-tpl', 'data-meta',
    'applyTaxonomy(st.taxonomy)', "bindActs($('#topbarActions'))"],
  'public/index.html': ['ic-trophy', 'ic-doc', 'ic-bulb', 'ic-medal', 'ic-people', 'ic-briefcase',
    'ic-heart', 'ic-badge', 'ic-tag', 'ic-print'],
  'public/styles.css': ['svg.ic', '.tpl-grid', '.a4-frame', '.major-search', '.sugg-list', '.adv-body']
};

let bad = 0;
console.log('=== 应当已经消失的符号 ===');
for (const f of files) {
  const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const k of GONE) {
    const n = t.split(k).length - 1;
    if (n) { console.log(`  ✗ 残留 ${f}  ${k}  ×${n}`); bad++; }
  }
}

console.log('=== 应当存在的符号 ===');
for (const [f, keys] of Object.entries(WANT)) {
  const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const k of keys) {
    const ok = t.includes(k);
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} ${f}  ${k}`);
  }
}

console.log(bad ? `\n${bad} 处需要处理` : '\n全部通过');
process.exit(bad ? 1 : 0);
