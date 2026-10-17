import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { ConnectionTCPObfuscated } from "telegram/network/connection/TCPObfuscated.js";
import { makeSockets } from "./sockets.js";

export function parseProxy(s) {
  // socks5://[user:pass@]host:port ，空则直连
  if (!s) return null;
  const m = s.trim().match(/^(?:socks5h?:\/\/)?(?:([^:@]*):([^@]*)@)?([^:\/]+):(\d+)\/?$/);
  if (!m) throw new Error("代理格式错误");
  return { username: m[1] ? decodeURIComponent(m[1]) : null, password: m[2] ? decodeURIComponent(m[2]) : "", host: m[3], port: +m[4] };
}

export function makeClient(cfg, session = "") {
  if (!cfg.tg_api_id || !cfg.tg_api_hash) throw new Error("缺少 api_id / api_hash");
  return new TelegramClient(new StringSession(session), +cfg.tg_api_id, cfg.tg_api_hash, {
    connection: ConnectionTCPObfuscated,
    networkSocket: makeSockets(parseProxy(cfg.proxy)),
    useWSS: false,
    connectionRetries: 2,
    autoReconnect: false,
    deviceModel: cfg.device_model || "Desktop",
    appVersion: "1.0",
  });
}

export async function sendCode(cfg, phone) {
  const c = makeClient(cfg);
  await c.connect();
  const r = await c.sendCode({ apiId: +cfg.tg_api_id, apiHash: cfg.tg_api_hash }, phone);
  const session = c.session.save();
  await c.disconnect();
  return { phone_code_hash: r.phoneCodeHash, temp_session: session };
}

export async function signIn(cfg, { phone, code, password, phone_code_hash, temp_session }) {
  const c = makeClient(cfg, temp_session);
  await c.connect();
  try {
    try {
      await c.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash: phone_code_hash, phoneCode: code }));
    } catch (e) {
      if (e.errorMessage !== "SESSION_PASSWORD_NEEDED") throw e;
      if (!password) return { need_password: true };
      await c.signInWithPassword({ apiId: +cfg.tg_api_id, apiHash: cfg.tg_api_hash }, { password: async () => password, onError: (er) => { throw er; } });
    }
    const me = await c.getMe();
    return { session: c.session.save(), me: { id: String(me.id), name: [me.firstName, me.lastName].filter(Boolean).join(" "), username: me.username || "" } };
  } finally {
    await c.disconnect().catch(() => {});
  }
}

export async function withClient(cfg, fn) {
  if (!cfg.session) throw new Error("未登录");
  const c = makeClient(cfg, cfg.session);
  await c.connect();
  try { return await fn(c); } finally { await c.disconnect().catch(() => {}); }
}

export async function listDialogs(c) {
  const ds = await c.getDialogs({ limit: 300 });
  return ds.map((d) => ({
    id: String(d.id),
    title: d.title || d.name || "",
    kind: d.isChannel ? "channel" : d.isGroup ? "group" : d.isUser ? "user" : "other",
    unread: d.unreadCount || 0,
  }));
}
