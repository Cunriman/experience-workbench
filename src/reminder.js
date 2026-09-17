'use strict';
/**
 * 提醒模块（A 方案：本地开机补发）
 *
 * 运转：开机自启 → 每天定点扫描未来 N 天的节点 → 找出「该提醒但还没发过」的 → 汇总发出
 *
 * 补发逻辑：对每个已配置的提前量 d，若 daysLeft <= d 且 d 还没发过，就发 d 这一档；
 *          剩余比 d 更宽的档位（如 7 天）一并标记为已发（因为窗口已过）。
 *          这样电脑关机几天后开机，会把漏掉的那一档补上，且不会重复轰炸。
 * 逾期：工具内标红，不再发邮件。
 */
const path = require('path');
const { execFile } = require('child_process');
const store = require('./store');

const DAY = 86400000;
const STATE_FILE = 'reminder-state';

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) { nodemailer = null; }

/* ---------------- 计算 ---------------- */

function normDays(days) {
  const arr = (Array.isArray(days) && days.length ? days : [7, 3, 1])
    .map(Number).filter(n => Number.isFinite(n) && n >= 0);
  return Array.from(new Set(arr)).sort((a, b) => b - a);
}

function daysLeftOf(dueAt, now) {
  const t = new Date(dueAt).getTime();
  if (!Number.isFinite(t)) return null;
  const diff = t - now.getTime();
  if (diff < 0) return -1;
  return Math.max(0, Math.ceil(diff / DAY));
}

const TIER_COPY = {
  7: { tag: '有件事来了', lead: '还有一周。先记下，不用今天动手。' },
  3: { tag: '该准备了', lead: '还剩三天，材料该准备了。' },
  1: { tag: '今天必须交', lead: '就是明天（或今天），这是最后一道防线。' }
};

function tierCopy(d) {
  return TIER_COPY[d] || { tag: `还剩 ${d} 天`, lead: `距离截止还有 ${d} 天。` };
}

/**
 * 扫描：返回需要发出的提醒条目
 */
function scan(now, profile) {
  now = now || new Date();
  profile = profile || store.getProfile();
  const days = normDays(profile.remind && profile.remind.days);
  const items = store.listExperiences(false);
  const out = [];
  const overdue = [];

  for (const exp of items) {
    for (const node of exp.nodes || []) {
      // 「完成」类节点是里程碑（获奖公布、拿证），只记录不提醒——逾期也不算
      if (node.done || node.kind === 'done' || !node.dueAt) continue;
      const dl = daysLeftOf(node.dueAt, now);
      if (dl === null) continue;

      if (dl < 0) {
        overdue.push({
          expId: exp.id, expTitle: exp.title, nodeId: node.id, nodeTitle: node.title,
          dueAt: node.dueAt, daysLeft: dl
        });
        continue;
      }

      const thresholds = (node.remindDays && node.remindDays.length ? normDays(node.remindDays) : days)
        .filter(d => d >= dl);
      if (!thresholds.length) continue;

      const tier = Math.min(...thresholds);          // 最紧急的那一档
      const missed = thresholds.filter(d => d > tier);
      const sent = Array.isArray(node.notifiedAt) ? node.notifiedAt : [];
      const key = String(tier);
      if (sent.includes(key)) continue;

      // 「补发」只在真的漏发时才算：这一档本该在 dueAt - tier 天发出，
      // 若那条经历那时还不存在，就是刚建的，不是漏发——别给用户看错的解释。
      const dueT = new Date(node.dueAt).getTime();
      const tierAt = dueT - tier * DAY;
      const existedThen = !exp.createdAt || new Date(exp.createdAt).getTime() <= tierAt;

      out.push({
        expId: exp.id,
        expTitle: exp.title,
        expType: exp.type,
        nodeId: node.id,
        nodeTitle: node.title,
        kind: node.kind,
        dueAt: node.dueAt,
        daysLeft: dl,
        tier,
        catchUp: dl < tier && existedThen,
        missedTiers: missed,
        superseded: thresholds
      });
    }
  }

  out.sort((a, b) => a.daysLeft - b.daysLeft);
  return { items: out, overdue, days };
}

/* ---------------- 组装内容 ---------------- */

function fmtTime(iso, withTime) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const p = n => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${base} ${p(d.getHours())}:${p(d.getMinutes())}` : base;
}

function buildDigest(scanResult, now) {
  now = now || new Date();
  const { items, overdue } = scanResult;
  const dateStr = fmtTime(now.toISOString(), false);
  const urgent = items.filter(i => i.tier <= 1).length;

  let subject;
  if (!items.length && !overdue.length) subject = `[经历工作台] ${dateStr} 今天没有要处理的事`;
  else if (urgent) subject = `[经历工作台] ${dateStr} 有 ${urgent} 件事今天必须交`;
  else subject = `[经历工作台] ${dateStr} 有 ${items.length} 件事在日程上`;

  const lines = [];
  lines.push(`今天是 ${dateStr}。`);
  if (!items.length && !overdue.length) {
    lines.push('');
    lines.push('未来没有临近的节点。安心。');
  }
  if (items.length) {
    lines.push('');
    lines.push(`需要处理的（${items.length} 件）：`);
    for (const it of items) {
      const d = it.daysLeft === 0 ? '今天 → 明天截止' : `还剩 ${it.daysLeft} 天`;
      lines.push(`  · [${tierCopy(it.tier).tag}] ${it.expTitle} — ${it.nodeTitle}（${d}）`);
      const when = fmtTime(it.dueAt, true);
      lines.push(`    截止：${when}${it.catchUp ? '（此前的提醒因电脑未开机漏发，现补上）' : ''}`);
    }
  }
  if (overdue.length) {
    lines.push('');
    lines.push(`已经逾期（${overdue.length} 件，不再重复提醒，请到工作台处理）：`);
    for (const it of overdue) {
      lines.push(`  · ${it.expTitle} — ${it.nodeTitle}（截止 ${fmtTime(it.dueAt, true)}）`);
    }
  }

  const text = lines.join('\n');

  // 通知卡片用的短文案：最多两条，多了就「等 N 件」
  const shortParts = items.slice(0, 2).map(it => {
    const d = it.daysLeft === 0 ? '今天截止' : `${it.daysLeft} 天后截止`;
    return `${it.expTitle} · ${it.nodeTitle}（${d}）`;
  });
  if (items.length > 2) shortParts.push(`等 ${items.length} 件事`);
  const short = shortParts.join('　/　') || '未来没有临近的节点';

  const rowStyle = 'padding:10px 12px;border-bottom:1px solid #EDE9E3;';
  const rows = items.map(it => `
    <tr>
      <td style="${rowStyle}white-space:nowrap;font-size:12px;color:#8A8178">${tierCopy(it.tier).tag}</td>
      <td style="${rowStyle}">
        <div style="font-size:14px;color:#24211D">${esc(it.expTitle)}</div>
        <div style="font-size:12px;color:#8A8178;margin-top:2px">${esc(it.nodeTitle)} · 截止 ${fmtTime(it.dueAt, true)}${it.catchUp ? ' · 漏发补上' : ''}</div>
      </td>
      <td style="${rowStyle}text-align:right;font-size:12px;color:#B4453A;white-space:nowrap">${it.daysLeft === 0 ? '今天' : it.daysLeft + ' 天'}</td>
    </tr>`).join('');

  const overdueRows = overdue.map(it => `
    <div style="font-size:12px;color:#8A8178;padding:4px 0">· ${esc(it.expTitle)} — ${esc(it.nodeTitle)}</div>`).join('');

  const html = `<!DOCTYPE html><html><body style="margin:0;background:#FAF8F5;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:24px">
    <div style="font-size:12px;color:#8A8178;letter-spacing:.08em">经历工作台 · 每日提醒</div>
    <h1 style="font-size:19px;font-weight:500;color:#24211D;margin:8px 0 4px">${esc(subject.replace(/^\[经历工作台\]\s*/, ''))}</h1>
    <div style="font-size:13px;color:#8A8178">${dateStr}</div>
    ${items.length ? `<table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #EDE9E3;border-radius:12px;overflow:hidden;margin-top:16px">${rows}</table>` : ''}
    ${!items.length && !overdue.length ? '<div style="margin-top:16px;padding:20px;background:#fff;border:1px solid #EDE9E3;border-radius:12px;font-size:13px;color:#8A8178">未来没有临近的节点。安心。</div>' : ''}
    ${overdue.length ? `<div style="margin-top:16px;padding:12px 14px;background:#FDF4F2;border:1px solid #F2DED8;border-radius:12px">
      <div style="font-size:12px;color:#B4453A;margin-bottom:6px">已逾期（不再重复提醒，请到工作台处理）</div>${overdueRows}</div>` : ''}
    <div style="font-size:11px;color:#B0A79C;margin-top:20px;line-height:1.7">
      这封邮件只负责提醒，不能替你操作。<br>
      确认参加、更新节点请打开工作台：http://127.0.0.1:8777
    </div>
  </div></body></html>`;

  return { subject, text, html, short, count: items.length, overdueCount: overdue.length };
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------------- 送达 ---------------- */

/**
 * 桌面 Toast 通知（Windows）
 *
 * 实现要点（都是踩过的坑）：
 *  1. 走 PowerShell -EncodedCommand（UTF-16LE 编码），中文才不会乱码。
 *  2. GetTemplateContent() 返回的本身就是 XmlDocument，
 *     要在它上面直接 GetElementsByTagName / CreateTextNode；
 *     先调 .GetXml() 会拿到 string，再往下点就会报「String 不包含 GetElementsByTagName」。
 *  3. AUMID 用自定义的 WorkBuddy.CompetitionWorkbench，并先在 HKCU 注册 DisplayName，
 *     这样通知卡片上显示的是「经历工作台」而不是「Windows PowerShell」。
 */
const AUMID = 'WorkBuddy.CompetitionWorkbench';

function desktopNotify(title, body) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve({ ok: false, reason: '非 Windows 平台，跳过桌面通知' });
    const t = String(title).replace(/'/g, "''");
    const b = String(body).replace(/'/g, "''");
    const script = [
      '$ErrorActionPreference = "Stop"',
      'try {',
      // 注册/修正本条通知的显示名（幂等，写在当前用户下，不需要管理员）
      '  $key = "HKCU:\\Software\\Classes\\AppUserModelId\\' + AUMID + '"',
      '  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }',
      '  Set-ItemProperty -Path $key -Name "DisplayName" -Value "经历工作台" -Force',
      // WinRT
      '  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
      '  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null',
      '  $tpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
      '  $nodes = $tpl.GetElementsByTagName("text")',
      "  $nodes.Item(0).AppendChild($tpl.CreateTextNode('" + t + "')) | Out-Null",
      "  $nodes.Item(1).AppendChild($tpl.CreateTextNode('" + b + "')) | Out-Null",
      '  $toast = New-Object Windows.UI.Notifications.ToastNotification $tpl',
      '  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("' + AUMID + '")',
      '  $notifier.Show($toast)',
      '  exit 0',
      '} catch {',
      '  $m = $_.Exception.Message',
      '  [System.IO.File]::WriteAllText("$env:TEMP\\wb-toast-error.txt", $m, [System.Text.Encoding]::UTF8)',
      '  exit 1',
      '}'
    ].join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 15000 },
      (err) => {
        if (!err) return resolve({ ok: true, channel: 'desktop', aumid: AUMID });
        let detail = '';
        try { detail = require('fs').readFileSync(path.join(process.env.TEMP || '', 'wb-toast-error.txt'), 'utf8').trim(); } catch (_) {}
        resolve({ ok: false, reason: detail || String(err.message || err) });
      });
  });
}

async function sendMail(profile, digest) {
  const smtp = profile.remind && profile.remind.smtp;
  if (!smtp || !smtp.host || !smtp.to) {
    const file = store.writeOutbox(digest.subject, digest.text, digest.html);
    return { channel: 'outbox', file, reason: '未配置邮箱，邮件已落盘' };
  }
  if (!nodemailer) {
    const file = store.writeOutbox(digest.subject, digest.text, digest.html);
    return { channel: 'outbox', file, reason: 'nodemailer 未安装，邮件已落盘（在项目目录执行 npm install 即可启用发送）' };
  }
  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: Number(smtp.port || 465),
      secure: smtp.secure !== false,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined
    });
    await transporter.sendMail({
      from: smtp.from || smtp.user,
      to: smtp.to,
      subject: digest.subject,
      text: digest.text,
      html: digest.html
    });
    return { channel: 'email', to: smtp.to };
  } catch (e) {
    const file = store.writeOutbox(digest.subject, digest.text, digest.html);
    return { channel: 'outbox', file, reason: '发送失败：' + String(e.message || e) };
  }
}

/* ---------------- 执行 ---------------- */

let lastResult = null;

async function run(opts) {
  const now = new Date();
  const profile = store.getProfile();
  const result = scan(now, profile);

  if (!result.items.length) {
    lastResult = { at: store.nowIso(), sent: false, reason: '没有需要提醒的节点', scan: result };
    return lastResult;
  }

  const digest = buildDigest(result, now);
  const channels = (profile.remind && profile.remind.channels) || ['desktop'];
  const deliveries = [];

  if (channels.includes('desktop') && !(opts && opts.skipNotify)) {
    const r = await desktopNotify(digest.subject.replace(/^\[经历工作台\]\s*/, ''), digest.short);
    deliveries.push({ channel: 'desktop', ...r });
  }
  if (channels.includes('email') && !(opts && opts.skipNotify)) {
    deliveries.push(await sendMail(profile, digest));
  }

  // 标记已发：最紧急那一档 + 被它取代的更宽档位
  const stamp = fmtTime(now.toISOString(), false);
  for (const it of result.items) {
    for (const d of it.superseded) store.markNotified(it.expId, it.nodeId, String(d));
    store.markNotified(it.expId, it.nodeId, 'last@' + stamp);
  }

  lastResult = { at: store.nowIso(), sent: true, digest, deliveries, scan: result };
  store.appendLog({
    op: 'reminder.run',
    note: `发出 ${result.items.length} 条（${deliveries.map(d => d.channel + (d.ok === false || d.reason ? '!' : '')).join(',') || '无渠道'}）`
  });
  return lastResult;
}

/* ---------------- 调度 ---------------- */

let timer = null;

function getState() { return store.readJson(STATE_FILE, { lastRunDate: null, lastRunAt: null }); }
function setState(s) { store.writeJson(STATE_FILE, s); }

/** 启动补跑：开机后立刻检查是否有漏下的（不重复发已发过的档位） */
async function catchUpOnBoot() {
  const profile = store.getProfile();
  if (!profile.remind || profile.remind.enabled === false) return;
  try { await run(); } catch (e) { console.warn('[reminder] 启动补跑失败：' + (e.message || e)); }
}

function startScheduler() {
  const tick = async () => {
    const profile = store.getProfile();
    if (!profile.remind || profile.remind.enabled === false) return;
    const now = new Date();
    const today = fmtTime(now.toISOString(), false);
    const st = getState();
    if (st.lastRunDate === today) return;
    const [hh, mm] = String(profile.remind.time || '08:00').split(':').map(Number);
    const target = new Date(now); target.setHours(hh || 8, mm || 0, 0, 0);
    if (now >= target) {
      setState({ lastRunDate: today, lastRunAt: store.nowIso() });
      try { await run(); } catch (e) { console.warn('[reminder] 定时执行失败：' + (e.message || e)); }
    }
  };
  if (timer) clearInterval(timer);
  timer = setInterval(() => { tick().catch(() => {}); }, 60 * 1000);
  tick().catch(() => {});
}

function preview(now) {
  const profile = store.getProfile();
  const result = scan(now, profile);
  const digest = buildDigest(result, now || new Date());
  return {
    items: result.items,
    overdue: result.overdue,
    thresholds: result.days,
    digest,
    smtpReady: !!(profile.remind && profile.remind.smtp && profile.remind.smtp.host),
    nodemailerReady: !!nodemailer,
    lastResult,
    state: getState()
  };
}

module.exports = { scan, buildDigest, run, startScheduler, catchUpOnBoot, preview, desktopNotify, daysLeftOf, normDays };
