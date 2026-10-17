import * as db from "./db.js";
import * as tg from "./tg.js";
import { runDue, runTask } from "./run.js";
import { PAGE } from "./ui.js";
import { probeProxy } from "./sockets.js";
import * as A from "./auth.js";
import { SECRET_FIELDS, TYPES, sendChannel, tgSelf } from "./notify.js";

const SECRET_KEYS = ["ai_key", "tg_api_hash", "session", "temp_session", "resend_key"];
const SETTING_KEYS = ["resend_key", "notify_email", "mail_from", "hits_days", "ai_base", "ai_key", "ai_model", "proxy", "tg_api_id", "tg_api_hash", "target_chat"];
const mask = (v) => (v ? "••••" + v.slice(-3) : "");
const json = (o, status = 200) => Response.json(o, { status });

const bearer = (req) => (req.headers.get("authorization") || "").replace(/^Bearer /, "");
const authed = async (req, env) => { const t = bearer(req); return !!t && (await A.sessionOk(env.DB, t)); };

// 登录、找回等无需登录的接口
async function publicAuth(p, env, body, ip) {
  const cfg = await db.getSettings(env.DB);
  const now = Math.floor(Date.now() / 1000);
  if (p === "auth/info") return json({ totp: cfg.totp_on === "1", mail: A.mailOn(cfg) });
  const lock = await A.lockedFor(env.DB, ip);
  if (lock) return json({ error: `尝试次数过多，请 ${Math.ceil(lock / 60)} 分钟后再试`, locked: lock }, 429);
  if (p === "auth/login") {
    const needTotp = cfg.totp_on === "1" && !!cfg.totp_secret;
    const okPw = await A.checkPassword(cfg, env, String(body.password || ""));
    const okTotp = !needTotp || (await A.totpOk(cfg.totp_secret, body.code));
    if (!okPw || !okTotp) { await A.failRecord(env.DB, ip); return json({ error: needTotp ? "密码或动态码错误" : "密码错误" }, 401); }
    await A.failClear(env.DB, ip);
    return json({ token: await A.newSession(env.DB) });
  }
  if (p === "auth/forgot") {
    if (!A.mailOn(cfg)) return json({ error: "未启用邮箱找回" }, 400);
    if (now - (+cfg.reset_sent || 0) < 60) return json({ error: "请 60 秒后再试" }, 429);
    const code = A.code6();
    await db.setSettings(env.DB, { reset_hash: await A.sha("rst:" + code), reset_exp: now + 600, reset_tries: 0, reset_sent: now });
    await A.sendMail(cfg, "TGScout 重设密码验证码", `验证码：${code}\n10 分钟内有效。找回成功后会同时关闭两步验证。\n若非本人操作请忽略。`);
    return json({ ok: true });
  }
  if (p === "auth/reset") {
    const pw = String(body.password || "");
    if (pw.length < 8) return json({ error: "新密码至少 8 位" }, 400);
    const tries = +cfg.reset_tries || 0;
    if (!cfg.reset_hash || +cfg.reset_exp < now || tries >= 5) return json({ error: "验证码无效或已过期，请重新获取" }, 400);
    if (!A.eq(await A.sha("rst:" + String(body.code || "").trim()), cfg.reset_hash)) {
      await db.setSettings(env.DB, { reset_tries: tries + 1 });
      await A.failRecord(env.DB, ip);
      return json({ error: "验证码错误" }, 401);
    }
    await db.setSettings(env.DB, { ...(await A.pwRecord(pw)), totp_on: "0" });
    for (const k of ["totp_secret", "totp_pending", "reset_hash", "reset_exp", "reset_tries"]) await db.delSetting(env.DB, k);
    await A.revokeAll(env.DB);
    await A.failClear(env.DB, ip);
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return new Response(PAGE, { headers: { "content-type": "text/html;charset=utf-8" } });
    await db.ensure(env.DB);
    const p = url.pathname.slice(5);
    const body = req.method === "GET" || req.method === "DELETE" ? {} : await req.json().catch(() => ({}));
    if (p.startsWith("auth/") && p !== "auth/logout") {
      try { return await publicAuth(p, env, body, req.headers.get("cf-connecting-ip") || "?"); }
      catch (e) { return json({ error: String(e.message || e) }, 500); }
    }
    if (!(await authed(req, env))) return json({ error: "unauthorized" }, 401);
    const token = bearer(req);
    try {
      if (p === "auth/logout") { await A.endSession(env.DB, token); return json({ ok: true }); }
      if (p === "totp/setup" && req.method === "POST") {
        const t = A.totpNew();
        await db.setSettings(env.DB, { totp_pending: t.secret });
        return json({ secret: t.secret, svg: t.svg });
      }
      if (p === "totp/enable" && req.method === "POST") {
        const cfg = await db.getSettings(env.DB);
        if (!cfg.totp_pending || !(await A.totpOk(cfg.totp_pending, body.code))) return json({ error: "动态码不正确" }, 400);
        await db.setSettings(env.DB, { totp_secret: cfg.totp_pending, totp_on: "1" });
        await db.delSetting(env.DB, "totp_pending");
        await A.revokeAll(env.DB, token);
        return json({ ok: true });
      }
      if (p === "totp/disable" && req.method === "POST") {
        const cfg = await db.getSettings(env.DB);
        if (!(await A.totpOk(cfg.totp_secret, body.code))) return json({ error: "动态码不正确" }, 400);
        await db.setSettings(env.DB, { totp_on: "0" });
        await db.delSetting(env.DB, "totp_secret");
        return json({ ok: true });
      }
      if (p === "mail/test" && req.method === "POST") {
        const cfg = await db.getSettings(env.DB);
        if (!A.mailOn(cfg)) return json({ error: "请先填写 Resend Key 和收件邮箱并保存" }, 400);
        await A.sendMail(cfg, "TGScout 测试邮件", "邮件通道正常。");
        return json({ ok: true });
      }
      if (p === "settings" && req.method === "GET") {
        const s = await db.getSettings(env.DB);
        const out = {};
        for (const k of SETTING_KEYS) out[k] = SECRET_KEYS.includes(k) ? mask(s[k]) : s[k] || "";
        return json({ settings: out, logged_in: !!s.session, me: s.me ? JSON.parse(s.me) : null, totp_on: s.totp_on === "1", mail_on: A.mailOn(s) });
      }
      if (p === "settings" && req.method === "PUT") {
        const upd = {};
        for (const k of SETTING_KEYS) if (k in body && !(SECRET_KEYS.includes(k) && String(body[k]).startsWith("••••"))) upd[k] = body[k];
        if (upd.proxy) tg.parseProxy(upd.proxy);
        await db.setSettings(env.DB, upd);
        return json({ ok: true });
      }
      if (p === "password" && req.method === "POST") {
        const pw = String(body.new || "");
        if (pw.length < 8) return json({ error: "新密码至少 8 位" }, 400);
        await db.setSettings(env.DB, await A.pwRecord(pw));
        await A.revokeAll(env.DB, token);
        return json({ ok: true });
      }
      if (p === "ai/test" && req.method === "POST") {
        const saved = await db.getSettings(env.DB);
        const pick = (k) => { const v = String(body[k] || "").trim(); return !v || v.startsWith("••••") ? saved[k] : v; };
        const base = pick("ai_base"), key = pick("ai_key"), model = pick("ai_model");
        if (!base || !key || !model) return json({ error: "接口地址、模型、密钥都要填" }, 400);
        const t0 = Date.now();
        const r = await fetch(base.replace(/\/+$/, "") + "/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + key },
          body: JSON.stringify({ model, max_tokens: 64, messages: [{ role: "user", content: "hello" }] }),
        });
        const txt = await r.text();
        if (!r.ok) return json({ error: `AI ${r.status} ${txt.slice(0, 160)}` }, 502);
        let reply = "";
        try { const jj = JSON.parse(txt); reply = jj.choices?.[0]?.message?.content || ""; await db.addUsage(env.DB, jj.usage); } catch {}
        return json({ ms: Date.now() - t0, reply: reply.slice(0, 200) });
      }
      if (p === "usage/reset" && req.method === "POST") { await env.DB.prepare("DELETE FROM usage").run(); return json({ ok: true }); }
      if (p === "usage" && req.method === "GET") return json(await db.getUsage(env.DB));
      if (p === "proxy/test" && req.method === "POST") {
        const raw = String(body.proxy || "").trim() || (await db.getSettings(env.DB)).proxy;
        const px = tg.parseProxy(raw);
        if (!px) return json({ error: "未填写代理" }, 400);
        return json(await probeProxy(px));
      }
      if (p === "channels" && req.method === "GET") {
        const cfg = await db.getSettings(env.DB);
        const custom = (await db.listChannels(env.DB)).map((c) => ({ ...c, config: Object.fromEntries(Object.entries(c.config).map(([k, v]) => [k, (SECRET_FIELDS[c.type] || []).includes(k) ? mask(String(v)) : v])) }));
        return json({ builtin: [{ id: "tg", name: "Telegram 会话", ready: !!cfg.session, detail: cfg.target_chat && cfg.target_chat !== "me" ? cfg.target_chat : "已保存消息" }, { id: "email", name: "邮件", ready: A.mailOn(cfg), detail: cfg.notify_email || "" }], custom });
      }
      if (p === "channels" && req.method === "POST") {
        if (!TYPES.includes(body.type)) return json({ error: "不支持的渠道类型" }, 400);
        return json({ id: await db.saveChannel(env.DB, 0, body) });
      }
      if (p === "channels/test" && req.method === "POST") {
        const cfg = await db.getSettings(env.DB);
        const text = "这是一条来自 TG Scout 的测试消息";
        if (body.id === "tg") { await tg.withClient(cfg, (c) => tgSelf(c, cfg, `【TG Scout】${text}`)); return json({ ok: true }); }
        if (body.id === "email") { if (!A.mailOn(cfg)) return json({ error: "邮件未启用" }, 400); await A.sendMail(cfg, "TG Scout 测试", text); return json({ ok: true }); }
        if (!TYPES.includes(body.type)) return json({ error: "不支持的渠道类型" }, 400);
        const saved = body.id ? (await db.listChannels(env.DB)).find((x) => String(x.id) === String(body.id)) : null;
        const config = { ...(body.config || {}) };
        for (const k of SECRET_FIELDS[body.type]) if (String(config[k] || "").startsWith("••••") && saved) config[k] = saved.config[k];
        await sendChannel({ type: body.type, config }, { title: "【TG Scout】测试", text, strategy: "test", chat: "", reason: "" });
        return json({ ok: true });
      }
      const cm = p.match(/^channels\/(\d+)$/);
      if (cm && req.method === "PUT") {
        if (!TYPES.includes(body.type)) return json({ error: "不支持的渠道类型" }, 400);
        const old = (await db.listChannels(env.DB)).find((x) => x.id === +cm[1]);
        if (!old) return json({ error: "渠道不存在" }, 404);
        const config = { ...(body.config || {}) };
        for (const k of SECRET_FIELDS[body.type]) if (String(config[k] || "").startsWith("••••") && old.type === body.type) config[k] = old.config[k];
        await db.saveChannel(env.DB, +cm[1], { ...body, config });
        return json({ ok: true });
      }
      if (cm && req.method === "DELETE") { await db.deleteChannel(env.DB, +cm[1]); return json({ ok: true }); }
      if (p === "strategies" && req.method === "GET") return json(await db.listStrategies(env.DB));
      if (p === "strategies" && req.method === "POST") return json({ id: await db.createStrategy(env.DB, body) });
      const sm = p.match(/^strategies\/(\d+)(\/run)?$/);
      if (sm) {
        const id = +sm[1];
        if (sm[2] && req.method === "POST") {
          const st = (await db.listStrategies(env.DB)).find((x) => x.id === id);
          return json(st?.interval_min === 0 ? await runTask(env, id) : await runDue(env, { only: id }));
        }
        if (req.method === "PUT") { await db.updateStrategy(env.DB, id, body); return json({ ok: true }); }
        if (req.method === "DELETE") { await db.deleteStrategy(env.DB, id); return json({ ok: true }); }
      }
      if (p === "hits") {
        const sid = url.searchParams.get("strategy");
        const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
        const cols = "id,strategy_id,strategy_name,chat,reason,link,ts,tin,tout,ttot,substr(text,1,100) AS preview,length(text) AS len";
        const where = [], args = [];
        if (sid) { where.push("strategy_id=?"); args.push(+sid); }
        if (q) {
          const like = "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
          where.push("(text LIKE ? ESCAPE '\\' OR chat LIKE ? ESCAPE '\\' OR reason LIKE ? ESCAPE '\\' OR strategy_name LIKE ? ESCAPE '\\' OR sender LIKE ? ESCAPE '\\')");
          args.push(like, like, like, like, like);
        }
        const sql = `SELECT ${cols} FROM hits${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT 200`;
        return json((await env.DB.prepare(sql).bind(...args).all()).results);
      }
      const hm = p.match(/^hits\/(\d+)$/);
      if (hm && req.method === "GET") {
        const row = await env.DB.prepare("SELECT * FROM hits WHERE id=?").bind(+hm[1]).first();
        return row ? json(row) : json({ error: "记录不存在" }, 404);
      }
      if (hm && req.method === "DELETE") { await env.DB.prepare("DELETE FROM hits WHERE id=?").bind(+hm[1]).run(); return json({ ok: true }); }
      if (p === "hits/clear" && req.method === "POST") { await env.DB.prepare("DELETE FROM hits").run(); return json({ ok: true }); }
      if (p === "tg/send-code") {
        const cfg = await db.getSettings(env.DB);
        const r = await tg.sendCode(cfg, body.phone);
        await db.setSettings(env.DB, { phone: body.phone, phone_code_hash: r.phone_code_hash, temp_session: r.temp_session });
        return json({ ok: true });
      }
      if (p === "tg/sign-in") {
        const cfg = await db.getSettings(env.DB);
        const r = await tg.signIn(cfg, { phone: cfg.phone, code: body.code, password: body.password, phone_code_hash: cfg.phone_code_hash, temp_session: cfg.temp_session });
        if (r.need_password) return json({ need_password: true });
        await db.setSettings(env.DB, { session: r.session, me: JSON.stringify(r.me) });
        for (const k of ["temp_session", "phone_code_hash", "phone"]) await db.delSetting(env.DB, k);
        return json({ ok: true, me: r.me });
      }
      if (p === "tg/logout") {
        for (const k of ["session", "me"]) await db.delSetting(env.DB, k);
        return json({ ok: true });
      }
      if (p === "tg/dialogs") {
        const cfg = await db.getSettings(env.DB);
        return json(await tg.withClient(cfg, tg.listDialogs));
      }
      if (p === "run" && req.method === "POST") return json(await runDue(env, { force: true }));
    } catch (e) {
      return json({ error: String(e.errorMessage || e.message || e) }, 500);
    }
    return json({ error: "not found" }, 404);
  },
  async scheduled(_evt, env, ctx) {
    await db.ensure(env.DB);
    if (new Date(_evt.scheduledTime).getUTCMinutes() === 0) {
      ctx.waitUntil((async () => {
        const days = parseInt((await db.getSettings(env.DB)).hits_days ?? "30");
        if (days > 0) await env.DB.prepare("DELETE FROM hits WHERE ts < ?").bind(Math.floor(Date.now() / 1000) - days * 86400).run();
      })().catch(() => {}));
    }
    ctx.waitUntil(runDue(env).catch((e) => console.log("run error", e?.message)));
  },
};
