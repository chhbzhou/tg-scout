import { mailOn, sendMail } from "./auth.js";

// 渠道类型及需要脱敏的字段（读取配置时只返回掩码）
export const SECRET_FIELDS = { tg_bot: ["token"], webhook: ["url", "secret"], bark: ["key"], serverchan: ["key"], ntfy: ["token"] };
export const TYPES = Object.keys(SECRET_FIELDS);

const enc = new TextEncoder();
async function hmacB64(key, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)))));
}
const trimSlash = (u) => String(u).replace(/\/+$/, "");

async function post(url, body, headers = {}, form = false) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json", ...headers },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  if (!r.ok) throw new Error(`HTTP ${r.status} ${t.slice(0, 120)}`);
  return j;
}

// m: { title, text, link, strategy, chat, reason }
export async function sendChannel(ch, m) {
  const c = ch.config || {};
  const head = m.title ? `${m.title}\n` : "";
  const full = `${head}${m.text}${m.link ? "\n" + m.link : ""}`;
  switch (ch.type) {
    case "tg_bot": {
      if (!c.token || !c.chat_id) throw new Error("缺少 Bot Token 或 Chat ID");
      const j = await post(`https://api.telegram.org/bot${c.token}/sendMessage`, { chat_id: c.chat_id, text: full.slice(0, 4000), disable_web_page_preview: true });
      if (!j?.ok) throw new Error(j?.description || "Bot 发送失败");
      return;
    }
    case "webhook": {
      if (!c.url) throw new Error("缺少 Webhook 地址");
      let url = c.url, body, fmt = c.format || "json";
      if (fmt === "feishu") {
        body = { msg_type: "text", content: { text: full } };
        if (c.secret) { const ts = String(Math.floor(Date.now() / 1000)); body.timestamp = ts; body.sign = await hmacB64(`${ts}\n${c.secret}`, ""); }
      } else if (fmt === "dingtalk") {
        body = { msgtype: "text", text: { content: full } };
        if (c.secret) { const ts = Date.now(); url += (url.includes("?") ? "&" : "?") + `timestamp=${ts}&sign=${encodeURIComponent(await hmacB64(c.secret, `${ts}\n${c.secret}`))}`; }
      } else if (fmt === "wecom") body = { msgtype: "text", text: { content: full } };
      else if (fmt === "discord") body = { content: full.slice(0, 2000) };
      else if (fmt === "slack") body = { text: full };
      else body = { title: m.title || "", text: m.text, link: m.link || "", strategy: m.strategy || "", chat: m.chat || "", reason: m.reason || "", ts: Math.floor(Date.now() / 1000) };
      const j = await post(url, body);
      // 飞书、钉钉、企业微信即使失败也返回 200，要看业务码
      if (fmt === "feishu" && j && j.code !== undefined && j.code !== 0) throw new Error(`飞书 ${j.code} ${j.msg || ""}`);
      if ((fmt === "dingtalk" || fmt === "wecom") && j && j.errcode) throw new Error(`${fmt === "wecom" ? "企业微信" : "钉钉"} ${j.errcode} ${j.errmsg || ""}`);
      return;
    }
    case "bark": {
      if (!c.key) throw new Error("缺少 Bark Key");
      const j = await post(`${trimSlash(c.server || "https://api.day.app")}/${c.key}`, { title: m.title || "TG Scout", body: m.text, url: m.link || undefined, group: "tg-scout" });
      if (j && j.code && j.code !== 200) throw new Error(`Bark ${j.code} ${j.message || ""}`);
      return;
    }
    case "serverchan": {
      if (!c.key) throw new Error("缺少 SendKey");
      const j = await post(`https://sctapi.ftqq.com/${c.key}.send`, { title: (m.title || "TG Scout").slice(0, 100), desp: `${m.text}${m.link ? "\n\n" + m.link : ""}` }, {}, true);
      if (j && j.code !== undefined && j.code !== 0) throw new Error(`Server酱 ${j.code} ${j.message || ""}`);
      return;
    }
    case "ntfy": {
      if (!c.topic) throw new Error("缺少主题");
      const headers = c.token ? { authorization: "Bearer " + c.token } : {};
      await post(trimSlash(c.server || "https://ntfy.sh"), { topic: c.topic, title: m.title || "TG Scout", message: m.text.slice(0, 3800), click: m.link || undefined }, headers);
      return;
    }
    default:
      throw new Error("未知渠道类型");
  }
}

// 向 Telegram 会话推送（需要已连接的客户端）
export async function tgSelf(c, cfg, text) {
  const target = cfg.target_chat || "me";
  await c.sendMessage(/^-?\d+$/.test(target) ? await c.getEntity(BigInt(target)) : target, { message: text, linkPreview: false });
}

// 按策略选的渠道逐个推送，返回失败列表；单个失败不影响其他渠道
export async function pushAll({ cfg, channels, ids, msg, c }) {
  const errs = [];
  const full = `${msg.title ? msg.title + "\n" : ""}${msg.text}${msg.link ? "\n" + msg.link : ""}`;
  for (const id of ids) {
    try {
      if (id === "tg") { if (!c) throw new Error("Telegram 未连接"); await tgSelf(c, cfg, full); }
      else if (id === "email") {
        if (!mailOn(cfg)) throw new Error("邮件未启用");
        await sendMail(cfg, (msg.title || "TG Scout 通知").slice(0, 80), full);
      } else {
        const ch = channels.find((x) => String(x.id) === id);
        if (!ch || !ch.enabled) continue;
        await sendChannel(ch, msg);
      }
    } catch (e) {
      errs.push(`${id === "tg" ? "Telegram" : id === "email" ? "邮件" : channels.find((x) => String(x.id) === id)?.name || id}: ${String(e.message || e).slice(0, 80)}`);
    }
  }
  return errs;
}
