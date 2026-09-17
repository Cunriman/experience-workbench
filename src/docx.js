'use strict';
/**
 * 最小可用的 .docx 生成器（零依赖）。
 *
 * 为什么自己写：项目从头到尾是「零依赖、双击就能跑」的形态，为了导出一个 Word
 * 去引 docx 库会把这条底线破掉。而 .docx 本质就是一个 zip 里放几段 XML，
 * Node 自带的 zlib 足够。
 *
 * 为什么不用「HTML 改后缀成 .doc」那种野路子：Word 打开会弹「文件格式与扩展名
 * 不一致」，而且格式飘。既然要做就做一个真的能被 Word/WPS 正常打开的包。
 *
 * 中文字体：OOXML 里西文和东亚字体是两个属性（w:ascii / w:eastAsia），
 * 只设 ascii 的话中文会掉到默认字体，行高和字重都会不对。
 */
const zlib = require('zlib');

/* ---------------- CRC32 + ZIP ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2)),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

/**
 * 打包成 zip（deflate）。
 * @param {Array<{name:string, data:Buffer|string}>} files
 */
function zip(files) {
  const { time, date } = dosTime(new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // flag: 文件名是 UTF-8
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);        // extra
    central.writeUInt16LE(0, 32);        // comment
    central.writeUInt16LE(0, 34);        // disk
    central.writeUInt16LE(0, 36);        // internal attr
    central.writeUInt32LE(0, 38);        // external attr
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + deflated.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([Buffer.concat(locals), centralBuf, eocd]);
}

/* ---------------- OOXML ---------------- */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // Word 里换行必须显式写成 <w:br/>，否则整段挤成一行
    ;
}

const EAST = '等线';
const WEST = 'Calibri';

function rPr(o) {
  const bits = [`<w:rFonts w:ascii="${WEST}" w:hAnsi="${WEST}" w:eastAsia="${EAST}"/>`];
  if (o.bold) bits.push('<w:b/>');
  if (o.italic) bits.push('<w:i/>');
  if (o.color) bits.push(`<w:color w:val="${o.color}"/>`);
  if (o.size) bits.push(`<w:sz w:val="${o.size}"/>`, `<w:szCs w:val="${o.size}"/>`);  // 半磅
  if (o.spacing) bits.push(`<w:spacing w:val="${o.spacing}"/>`);
  if (o.caps) bits.push('<w:caps/>');
  return `<w:rPr>${bits.join('')}</w:rPr>`;
}

function run(text, o) {
  o = o || {};
  const parts = String(text == null ? '' : text).split('\n');
  const body = parts.map((t, i) =>
    (i ? '<w:br/>' : '') + `<w:t xml:space="preserve">${esc(t)}</w:t>`).join('');
  return `<w:r>${rPr(o)}${body}</w:r>`;
}

/**
 * 一段。tab 用来做「左边标题、右边日期」的齐右——OOXML 里就是右对齐制表位。
 */
function para(runs, o) {
  o = o || {};
  const pPr = ['<w:pPr>'];
  if (o.style) pPr.push(`<w:pStyle w:val="${o.style}"/>`);
  if (o.align) pPr.push(`<w:jc w:val="${o.align}"/>`);
  if (o.tabs) pPr.push('<w:tabs><w:tab w:val="right" w:pos="9360"/></w:tabs>');
  if (o.border) {
    pPr.push('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="2" w:color="999999"/></w:pBdr>');
  }
  pPr.push(`<w:spacing w:before="${o.before || 0}" w:after="${o.after == null ? 60 : o.after}" w:line="${o.line || 260}" w:lineRule="auto"/>`);
  if (o.indent) pPr.push(`<w:ind w:left="${o.indent}" w:hanging="${o.hanging || 0}"/>`);
  pPr.push('</w:pPr>');
  return `<w:p>${pPr.join('')}${(runs || []).join('')}</w:p>`;
}

function heading(text) {
  return para([run(text, { bold: true, size: 21, color: '2F6F5E' })], { border: true, before: 200, after: 100 });
}

/**
 * 生成 docx。
 * @param {{blocks:Array, title?:string}} model
 *   blocks: {type:'title'|'meta'|'heading'|'entry'|'bullet'|'note'|'spacer', ...}
 */
function build(model) {
  const body = [];

  for (const b of model.blocks || []) {
    if (b.type === 'title') {
      body.push(para([run(b.text, { bold: true, size: 32 })], { align: 'center', after: 40 }));
    } else if (b.type === 'meta') {
      body.push(para([run(b.text, { size: 19, color: '595959' })], { align: 'center', after: 60 }));
    } else if (b.type === 'heading') {
      body.push(heading(b.text));
    } else if (b.type === 'entry') {
      // 左标题 + 制表位右日期
      const runs = [run(b.text, { bold: true, size: 21 })];
      if (b.right) runs.push(run('\t'), run(b.right, { size: 19, color: '595959' }));
      body.push(para(runs, { tabs: true, before: 100, after: 20 }));
      if (b.sub) body.push(para([run(b.sub, { size: 18, color: '6E6E6E' })], { after: 20 }));
    } else if (b.type === 'bullet') {
      body.push(para([run('· ', { size: 19 }), run(b.text, { size: 19 })], { indent: 240, hanging: 160, after: 20 }));
    } else if (b.type === 'note') {
      body.push(para([run(b.text, { size: 17, color: '8C8C8C', italic: true })], { after: 40 }));
    } else if (b.type === 'spacer') {
      body.push(para([], { after: 0 }));
    }
  }

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body>
</w:document>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${WEST}" w:hAnsi="${WEST}" w:eastAsia="${EAST}"/><w:sz w:val="20"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="60" w:line="260" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
</w:styles>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: styles }
  ]);
}

module.exports = { build, zip };
