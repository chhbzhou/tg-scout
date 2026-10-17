import { listStrategies, getSettings, addUsage, listChannels } from "./db.js";
import { pushAll } from "./notify.js";
import { withClient, listDialogs } from "./tg.js";
import { keywordMatch, aiMatch, aiTask } from "./match.js";
import { mailOn, sendMail } from "./auth.js";

const AI_BATCH = 30;
const ALERT_AFTER = 3, ALERT_GAP = 3600;

const setStat = (db, id, err) => err
  ? db.prepare("UPDATE strategies SET last_status='err', last_err=?, fail_n=fail_n+1 WHERE id=?").bind(String(err).slice(0, 300), id).run()
  : db.prepare("UPDATE strategies SET last_status='ok', last_err='', fail_n=0 WHERE id=?").bind(id).run();

// 连续失败达到阈值且已配邮箱时汇总发一封，两封之间至少隔 1 小时
async function maybeAlert(db) {
  const cfg = await getSettings(db);
  const now = Math.floor(Date.now() / 1000);
  if (!mailOn(cfg) || now - (+cfg.alert_sent || 0) < ALERT_GAP) return;
  const { results } = await db.prepare("SELECT name,last_err,fail_n FROM strategies WHERE enabled=1 AND interval_min>0 AND fail_n>=?").bind(ALERT_AFTER).all();
  if (!results.length) return;
  const lines = results.map((r) => `· ${r.name}：连续失败 ${r.fail_n} 次，${r.last_err}`).join("\n");
  try {
    await sendMail(cfg, "TGScout 运行失败告警", `以下策略连续运行失败：\n${lines}\n\n常见原因：出口代理失效、Telegram 会话被踢、AI 接口异常。`);
    await db.prepare("INSERT INTO settings(k,v) VALUES('alert_sent',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(String(now)).run();
  } catch {}
}

function link(chat, entity, id) {
  const u = entity?.username;
  if (u) return `https://t.me/${u}/${id}`;
  const cid = String(chat).replace(/^-100/, "");
  return /^-100/.test(String(chat)) ? `https://t.me/c/${cid}/${id}` : "";
}

export async function runDue(env, { force = false, only = null } = {}) {
  const db = env.DB;
  const cfg = await getSettings(db);
  if (!cfg.session) return { skipped: "未登录" };
  const now = Math.floor(Date.now() / 1000);
  const all = await listStrategies(db);
  const due = all.filter((s) => s.interval_min > 0 && s.enabled && (only ? s.id === only : force || now - s.last_run >= s.interval_min * 60 - 20));
  if (!due.length) return { ran: 0 };
  const report = [];
  let fatal = null;
  try {
  await withClient(cfg, async (c) => {
    const dialogs = await listDialogs(c); // 同时填充实体缓存
    const channels = await listChannels(db);
    for (const s of due) {
      const r = { id: s.id, new: 0, hits: 0, err: null };
      try {
        const chats = s.chats.length ? s.chats : dialogs.map((d) => d.id).filter((id) => id !== String(cfg.target_chat || ""));
        const cursors = { ...s.cursors };
        const found = [];
        for (const chat of chats) {
          let entity;
          try { entity = await c.getEntity(chat.match(/^-?\d+$/) ? BigInt(chat) : chat); } catch { continue; }
          const last = cursors[chat];
          if (last == null) {
            const [m] = await c.getMessages(entity, { limit: 1 });
            cursors[chat] = m ? m.id : 0; // 首次只记位置，不回灌
            continue;
          }
          const msgs = (await c.getMessages(entity, { limit: 100, minId: last })).filter((m) => m.message && !m.out);
          if (!msgs.length) continue;
          cursors[chat] = Math.max(last, ...msgs.map((m) => m.id));
          const title = dialogs.find((d) => d.id === chat)?.title || entity.title || entity.username || chat;
          const items = msgs.reverse().map((m) => ({ id: m.id, text: m.message, sender: m.sender?.firstName || m.sender?.title || m.sender?.username || "", chat, title, link: link(chat, entity, m.id) }));
          r.new += items.length;
          if (s.type === "keyword") {
            for (const it of items) { const why = keywordMatch(it.text, s); if (why) found.push({ ...it, reason: why }); }
          } else {
            for (let i = 0; i < items.length; i += AI_BATCH) {
              const part = items.slice(i, i + AI_BATCH);
              let u = null;
              const res = await aiMatch(cfg, s.prompt, part, (x) => { u = x; return addUsage(db, x); });
              for (const [k, why] of Object.entries(res)) found.push({ ...part[+k], reason: why, usage: u });
            }
          }
        }
        for (const f of found) {
          const fu = tok(f.usage);
          await db.prepare("INSERT INTO hits(strategy_id,strategy_name,chat,msg_id,sender,text,reason,link,ts,tin,tout,ttot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(s.id, s.name, f.title, f.id, f.sender, f.text.slice(0, 2000), f.reason, f.link, now, fu.i, fu.o, fu.t).run();
          if (s.channels.length) {
            const errs = await pushAll({
              cfg, channels, ids: s.channels, c,
              msg: { title: `【${s.name}】${f.title}`, text: `${f.sender ? f.sender + "：" : ""}${f.text.slice(0, 800)}\n理由：${f.reason}`, link: f.link, strategy: s.name, chat: f.title, reason: f.reason },
            });
            if (errs.length) r.err = "推送失败 " + errs.join("；");
          }
        }
        r.hits = found.length;
        await db.prepare("UPDATE strategies SET cursors=?, last_run=? WHERE id=?").bind(JSON.stringify(cursors), now, s.id).run();
      } catch (e) {
        r.err = String(e.message || e);
        await db.prepare("UPDATE strategies SET last_run=? WHERE id=?").bind(now, s.id).run();
      }
      await setStat(db, s.id, r.err);
      report.push(r);
    }
  });
  } catch (e) {
    // 连接层失败（代理不通、会话失效等）：本轮到期的策略都记失败
    fatal = String(e.message || e);
    for (const s of due) {
      if (report.some((x) => x.id === s.id)) continue;
      await db.prepare("UPDATE strategies SET last_run=? WHERE id=?").bind(now, s.id).run();
      await setStat(db, s.id, fatal);
    }
  }
  await maybeAlert(db).catch(() => {});
  return { ran: report.length, report, error: fatal };
}

const tok = (u) => { const i = +u?.prompt_tokens || 0, o = +u?.completion_tokens || 0; return { i, o, t: +u?.total_tokens || i + o }; };
const MAX_CHARS = 60000;
export async function runTask(env, id) {
  const db = env.DB;
  const cfg = await getSettings(db);
  const s = (await listStrategies(db)).find((x) => x.id === id);
  if (!s || s.interval_min !== 0) throw new Error("不是手动策略");
  if (!s.chats.length) throw new Error("请先选择会话");
  const now = Math.floor(Date.now() / 1000);
  const results = [];
  const pushErrs = [];
  const channels = await listChannels(db);
  try {
  await withClient(cfg, async (c) => {
    const dialogs = await listDialogs(c);
    for (const chat of s.chats) {
      const entity = await c.getEntity(chat.match(/^-?\d+$/) ? BigInt(chat) : chat);
      const title = dialogs.find((d) => d.id === chat)?.title || entity.title || entity.username || chat;
      const msgs = (await c.getMessages(entity, { limit: s.range_n })).filter((m) => m.message).reverse();
      if (!msgs.length) { results.push({ title, text: "（没有可处理的文本消息）" }); continue; }
      let text = msgs.map((m) => `${m.sender?.firstName || m.sender?.title || m.sender?.username || "?"}: ${m.message}`).join("\n");
      if (text.length > MAX_CHARS) text = text.slice(text.length - MAX_CHARS);
      let u = null;
      const out = await aiTask(cfg, s.prompt, text, (x) => { u = x; return addUsage(db, x); });
      const tk = tok(u);
      results.push({ title, text: out, count: msgs.length, usage: { in: tk.i, out: tk.o, tot: tk.t } });
      await db.prepare("INSERT INTO hits(strategy_id,strategy_name,chat,msg_id,sender,text,reason,link,ts,tin,tout,ttot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(s.id, s.name, title, 0, "", out.slice(0, 20000), `任务结果 · ${msgs.length} 条`, "", now, tk.i, tk.o, tk.t).run();
      if (s.channels.length) {
        pushErrs.push(...await pushAll({
          cfg, channels, ids: s.channels, c,
          msg: { title: `【${s.name}】${title}`, text: out.slice(0, 3500), strategy: s.name, chat: title, reason: `任务结果 · ${msgs.length} 条` },
        }));
      }
    }
  });
  } catch (e) {
    await setStat(db, id, e.message || e);
    throw e;
  }
  await db.prepare("UPDATE strategies SET last_run=? WHERE id=?").bind(now, id).run();
  await setStat(db, id, null);
  return { results, pushErrs };
}
