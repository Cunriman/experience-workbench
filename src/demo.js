'use strict';
/** 示例数据：只为让你一眼看到界面填满时的样子，随时可以整体清掉 */
const store = require('./store');

const DAY = 86400000;
/* 截止时间统一落在傍晚 18:00——不是随便的时分，看起来才像人填的 */
const at = d => {
  const t = new Date(Date.now() + d * DAY);
  t.setHours(18, 0, 0, 0);
  return t.toISOString();
};
const node = (title, kind, d, done) => ({
  id: store.uuid(), title, kind, dueAt: d === null ? '' : at(d),
  done: !!done, doneAt: done ? at(d) : '', remindDays: null, notifiedAt: []
});

const MARK = 'demo-';

function build() {
  const m1 = store.uuid(), m2 = store.uuid(), m3 = store.uuid(), m4 = store.uuid();
  return [
    {
      id: MARK + 'mcm', type: 'competition',
      title: '全国大学生数学建模竞赛',
      level: '国家级（榜单内）', track: '数理化生', role: '队长（建模 + 论文）',
      organizer: '中国工业与应用数学学会', stage: '进行中', status: 'active',
      startedAt: at(-62), endedAt: '',
      result: { award: '', rank: '', ratio: '', summary: '三人队，我负责模型构建与论文撰写。已进入国赛评审阶段。' },
      nodes: [
        node('校赛报名截止', 'deadline', -60, true),
        node('赛题公布', 'reminder', -3, true),
        node('作品提交截止', 'submit', 5),
        node('省评答辩', 'defense', 25),
        node('结果公布', 'result', 62)
      ],
      materials: [
        { id: m1, name: '论文 LaTeX 模板（校内通用）', file: '', kind: 'form', reusable: true, note: '年年能改一改用', addedAt: at(-61) },
        { id: m2, name: '校赛报名表', file: '', kind: 'form', reusable: true, note: '', addedAt: at(-61) }
      ],
      retro: { good: '', bad: '', reuse: '' },
      tags: ['数理化生', '计算机'], fromLibrary: { id: 'cn-mcm', libVersion: '2026.09', site: 'http://www.mcm.edu.cn/', window: '5-9 月报名，9 月比赛' }
    },
    {
      id: MARK + '3chuang', type: 'competition',
      title: '全国大学生电子商务“创新、创意及创业”挑战赛',
      level: '国家级（榜单内）', track: '经管金融', role: '产品 + 商业计划书',
      organizer: '教育部高等学校电子商务类专业教指委', stage: '筹备中', status: 'active',
      startedAt: at(-8), endedAt: '',
      result: { award: '', rank: '', ratio: '', summary: '' },
      nodes: [
        node('校赛报名截止', 'deadline', 2),
        node('校赛作品提交', 'submit', 21),
        node('省赛', 'submit', 58)
      ],
      materials: [],
      retro: { good: '', bad: '', reuse: '' },
      tags: ['经管金融'], fromLibrary: { id: 'cn-3chuang', libVersion: '2026.09', site: 'http://www.3chuang.net/', window: '9-12 月报名，次年校赛/省赛/国赛' }
    },
    {
      id: MARK + 'lanqiao', type: 'competition',
      title: '蓝桥杯全国软件和信息技术专业人才大赛',
      level: '国家级（榜单内）', track: '计算机', role: '个人赛 / Java 组',
      organizer: '工业和信息化部人才交流中心', stage: '已复盘', status: 'done',
      startedAt: at(-380), endedAt: at(-240),
      result: { award: '国家级二等奖', rank: '全国第 137 名', ratio: '8%', summary: 'Java 程序设计组。备赛两个月，主攻动态规划与图论，省赛一等奖、国赛二等奖。' },
      nodes: [
        node('报名截止', 'deadline', -300, true),
        node('省赛', 'submit', -272, true),
        node('国赛', 'submit', -255, true),
        node('结果公布', 'result', -240, true)
      ],
      materials: [
        { id: m3, name: '省赛一等奖证书', file: '', kind: 'cert', reusable: false, note: '扫描件待补', addedAt: at(-270) },
        { id: m4, name: '备赛题库整理（自己写的）', file: '', kind: 'doc', reusable: true, note: '学弟学妹要过两次', addedAt: at(-245) }
      ],
      retro: {
        good: '提前两个月开始，按题型分模块刷，最后三周只做真题限时。时间分配比算法技巧更决定成绩。',
        bad: '省赛到国赛之间松懈了两周，国赛第一题卡了 40 分钟才回头，应该先扫一遍全会做的。',
        reuse: '备赛题库整理、报名表模板、赛后证书命名规范（年份-赛事-奖项）都可以复用。'
      },
      tags: ['计算机'], fromLibrary: { id: 'cn-lanqiao', libVersion: '2026.09', site: 'http://dasai.lanqiao.cn/', window: '1-3 月' }
    },
    {
      id: MARK + 'proj', type: 'project',
      title: '校园二手书流转小程序',
      level: '校级大创项目', track: '项目', role: '前端负责人',
      organizer: '本校创新创业学院', stage: '进行中', status: 'active',
      startedAt: at(-120), endedAt: '',
      result: { award: '', rank: '', ratio: '', summary: '负责小程序端全部页面与登录鉴权，上线 3 个月累计 800+ 用户。' },
      nodes: [node('中期检查材料提交', 'submit', 12), node('结题答辩', 'defense', 96)],
      materials: [],
      retro: { good: '', bad: '', reuse: '' },
      tags: ['项目']
    },
    {
      id: MARK + 'award1', type: 'award',
      title: '校级一等奖学金',
      level: '校级', track: '奖学金', role: '',
      organizer: '本校', stage: '已出结果', status: 'done',
      startedAt: at(-300), endedAt: at(-280),
      result: { award: '一等奖学金', rank: '专业前 5%', ratio: '5%', summary: '2024-2025 学年，综测排名专业第 3。' },
      nodes: [],
      materials: [],
      retro: { good: '', bad: '', reuse: '' },
      tags: ['奖学金']
    }
  ];
}

function load() {
  let n = 0;
  for (const d of build()) { store.upsertExperience(d); n++; }
  store.appendLog({ op: 'demo.load', note: `导入示例 ${n} 条` });
  return n;
}

function clear() {
  const all = store.listExperiences(true).filter(e => String(e.id).startsWith(MARK) && !e.deletedAt);
  let n = 0;
  for (const e of all) { store.softDeleteExperience(e.id); n++; }
  store.appendLog({ op: 'demo.clear', note: `移除示例 ${n} 条` });
  return n;
}

module.exports = { load, clear, MARK };
