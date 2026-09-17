'use strict';
/**
 * 经历类型词表 —— 服务端和前端共用的唯一真源。
 *
 * 为什么单独一个文件：
 *   类型既要在服务端做校验和归一化，又要在前端渲染选择器、筛选、看板配色、导出分节。
 *   两边各写一份必然漂移（之前就是这样：前端 TYPE_LABEL 只有 5 类，
 *   服务端 TYPES 也是 5 类，加一类要改两个地方还容易漏）。
 *   现在统一从这里出，通过 /api/state 下发给前端。
 *
 * 每种类型可以带自己的「专属字段」（fields）。学生工作和专利需要的字段
 * 跟竞赛完全不是一回事——专利要专利号，学生工作要职务——但为了不把数据结构
 * 撑成十几张表，这些字段统一存在 exp.meta 这个自由对象里，按 key 取值。
 */

/** 导出时按 section 分节；同 section 的类型合并成一个小标题 */
const SECTIONS = [
  '竞赛经历', '项目经历', '论文与专利', '获奖与荣誉',
  '学生工作', '实习经历', '志愿服务', '技能证书', '其他'
];

const TYPES = [
  {
    key: 'competition', label: '竞赛', section: '竞赛经历', icon: 'ic-trophy',
    // 竞赛的专属信息（级别/赛道/名次/获奖）早就有一等公民字段了，这里不需要再补
    fields: []
  },
  {
    key: 'project', label: '项目', section: '项目经历', icon: 'ic-board',
    fields: [
      { key: 'source', label: '项目来源', en: 'Source', placeholder: '如：导师课题 / 自主立项 / 企业合作' }
    ]
  },
  {
    key: 'paper', label: '论文', section: '论文与专利', icon: 'ic-doc',
    fields: [
      { key: 'venue', label: '期刊 / 会议', en: 'Venue', placeholder: '如：某某学报 / CVPR' },
      { key: 'authorOrder', label: '作者次序', en: 'Authorship', placeholder: '如：第一作者 / 共同一作' },
      { key: 'indexing', label: '收录情况', en: 'Indexing', placeholder: '如：SCI 二区 / EI / 中文核心' }
    ]
  },
  {
    key: 'patent', label: '专利', section: '论文与专利', icon: 'ic-bulb',
    fields: [
      { key: 'patentKind', label: '专利类型', en: 'Patent type', placeholder: '发明专利 / 实用新型 / 外观设计' },
      { key: 'patentNo', label: '专利（申请）号', en: 'Patent No.', placeholder: '如：CN2024xxxxxxx' },
      { key: 'applicant', label: '申请人 / 专利权人', en: 'Applicant' },
      { key: 'grantedAt', label: '授权公告日', en: 'Granted', type: 'date' }
    ]
  },
  {
    key: 'award', label: '奖项', section: '获奖与荣誉', icon: 'ic-medal',
    fields: [
      { key: 'awardedFor', label: '因何获奖', en: 'For', placeholder: '如：综合测评优秀学生' }
    ]
  },
  {
    key: 'student_work', label: '学生工作', section: '学生工作', icon: 'ic-people',
    fields: [
      { key: 'org', label: '组织 / 部门', en: 'Organization', placeholder: '如：校学生会 / 班级 / 社团' },
      { key: 'position', label: '担任职务', en: 'Role', placeholder: '如：学习部部长 / 班长' },
      { key: 'scale', label: '工作规模', en: 'Scope', placeholder: '如：负责 12 人团队 / 服务 800 人次' }
    ]
  },
  {
    key: 'internship', label: '实习', section: '实习经历', icon: 'ic-briefcase',
    fields: [
      { key: 'department', label: '部门 / 岗位', en: 'Position' },
      { key: 'mentor', label: '带教 / 汇报对象', en: 'Mentor' }
    ]
  },
  {
    key: 'volunteer', label: '志愿服务', section: '志愿服务', icon: 'ic-heart',
    fields: [
      { key: 'org', label: '组织方', en: 'Organizer' },
      { key: 'hours', label: '服务时长', en: 'Hours', placeholder: '如：120 小时' }
    ]
  },
  {
    key: 'certificate', label: '证书', section: '技能证书', icon: 'ic-badge',
    fields: [
      { key: 'issuer', label: '发证机构', en: 'Issuer' },
      { key: 'certNo', label: '证书编号', en: 'Certificate No.' },
      { key: 'validTo', label: '有效期至', en: 'Valid until', type: 'date' }
    ]
  },
  {
    key: 'exchange', label: '交换经历', section: '其他', icon: 'ic-people',
    fields: [
      { key: 'org', label: '学校 / 机构', en: 'Institution', placeholder: '如：某某大学交换一学期' },
      { key: 'period', label: '交换时间', en: 'Period', placeholder: '如：2025.09 – 2026.01' }
    ]
  }
];

const TYPE_KEYS = TYPES.map(t => t.key);

/** 自定义类型的 key 前缀，用来和内置类型区分（内置类型以后可以安全增删） */
const CUSTOM_PREFIX = 'x_';

function isCustom(key) { return String(key || '').startsWith(CUSTOM_PREFIX); }

/** 由用户输入的名称生成一个稳定的自定义类型 key */
function customKey(label) {
  const slug = String(label || '').trim().toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '_').slice(0, 24) || 'type';
  return CUSTOM_PREFIX + slug;
}

/**
 * 把内置类型 + 用户自定义类型合成一份完整词表。
 * @param {Array<{key:string,label:string}>} customTypes 来自 profile.customTypes
 */
function buildTaxonomy(customTypes) {
  const custom = (customTypes || [])
    .filter(t => t && t.label)
    .map(t => ({
      key: t.key && isCustom(t.key) ? t.key : customKey(t.label),
      label: String(t.label).trim().slice(0, 12),
      section: String(t.label).trim().slice(0, 12),
      icon: t.icon || 'ic-tag',
      fields: [],
      custom: true
    }));
  // 同名去重，自定义的不能顶掉内置的
  const seen = new Set(TYPE_KEYS);
  const merged = custom.filter(t => {
    if (seen.has(t.key)) return false;
    seen.add(t.key);
    return true;
  });
  return TYPES.concat(merged);
}

/** key → 类型定义；未知 key 兜底成「其他」 */
function byKey(taxonomy, key) {
  return (taxonomy || TYPES).find(t => t.key === key) || null;
}

function labelOf(taxonomy, key) {
  const t = byKey(taxonomy, key);
  return t ? t.label : (key || '其他');
}

module.exports = {
  TYPES, TYPE_KEYS, SECTIONS, CUSTOM_PREFIX,
  isCustom, customKey, buildTaxonomy, byKey, labelOf
};
