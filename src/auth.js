import QR from "qrcode-generator";

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const sha = async (t) => hex(await crypto.subtle.digest("SHA-256", enc.encode(t)));
export const eq = (a, b) => a.length === b.length && [...a].reduce((x, c, i) => x | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;
const now = () => Math.floor(Date.now() / 1000);

// ---------- 限流：同一 IP 15 分钟内错 5 次、全部来源累计错 20 次，均锁 15 分钟 ----------
const WIN = 900, MAX_IP = 5, MAX_ALL = 20;
export async function lockedFor(db, ip) {
  const { results } = await db.prepare("SELECT until FROM fails WHERE ip IN (?, '*')").bind(ip).all();
  const t = now();
  return Math.max(0, ...results.map((r) => r.until - t));
}
async function bump(db, key, max) {
  const r = await db.prepare("SELECT n,ts FROM fails WHERE ip=?").bind(key).first();
  const t = now();
  const fresh = r && t - r.ts < WIN;
  const n = fresh ? r.n + 1 : 1;
  await db.prepare("INSERT INTO fails(ip,n,ts,until) VALUES(?,?,?,?) ON CONFLICT(ip) DO UPDATE SET n=excluded.n, ts=excluded.ts, until=excluded.until")
    .bind(key, n, fresh ? r.ts : t, n >= max ? t + WIN : 0).run();
}
export async function failRecord(db, ip) {
  await bump(db, ip, MAX_IP);
  await bump(db, "*", MAX_ALL);
}
export const failClear = (db, ip) => db.prepare("DELETE FROM fails WHERE ip=?").bind(ip).run();

// ---------- 会话 ----------
const sessCache = new Map();
export async function newSession(db) {
  const raw = hex(crypto.getRandomValues(new Uint8Array(32)));
  await db.prepare("INSERT INTO sessions(h,exp) VALUES(?,?)").bind(await sha(raw), now() + 30 * 86400).run();
  await db.prepare("DELETE FROM sessions WHERE exp<?").bind(now()).run();
  return raw;
}
export async function sessionOk(db, token) {
  const h = await sha(token);
  const c = sessCache.get(h);
  if (c && Date.now() - c.at < 60000) return c.ok;
  const r = await db.prepare("SELECT exp FROM sessions WHERE h=?").bind(h).first();
  const ok = !!r && r.exp > now();
  sessCache.set(h, { at: Date.now(), ok });
  return ok;
}
export async function endSession(db, token) {
  await db.prepare("DELETE FROM sessions WHERE h=?").bind(await sha(token)).run();
  sessCache.clear();
}
export async function revokeAll(db, keepToken) {
  if (keepToken) await db.prepare("DELETE FROM sessions WHERE h<>?").bind(await sha(keepToken)).run();
  else await db.prepare("DELETE FROM sessions").run();
  sessCache.clear();
}

// ---------- 密码 ----------
export async function checkPassword(cfg, env, pw) {
  if (!pw) return false;
  if (cfg.pw_hash) return eq(await sha(cfg.pw_salt + pw), cfg.pw_hash);
  return !!env.ADMIN_TOKEN && eq(pw, env.ADMIN_TOKEN);
}
export async function pwRecord(pw) {
  const salt = crypto.randomUUID();
  return { pw_salt: salt, pw_hash: await sha(salt + pw) };
}

// ---------- TOTP (RFC 6238, SHA-1, 6 位, 30 秒) ----------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const b32enc = (bytes) => {
  let bits = 0, val = 0, out = "";
  for (const b of bytes) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
    val &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
};
const b32dec = (s) => {
  let bits = 0, val = 0; const out = [];
  for (const c of s.toUpperCase()) {
    const i = B32.indexOf(c); if (i < 0) continue;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
    val &= (1 << bits) - 1;
  }
  return new Uint8Array(out);
};
async function hotp(secret, counter) {
  const key = await crypto.subtle.importKey("raw", b32dec(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, BigInt(counter));
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
  const o = h[19] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, "0");
}
export async function totpOk(secret, code) {
  code = String(code || "").replace(/\s/g, "");
  if (!secret || !/^\d{6}$/.test(code)) return false;
  const c = Math.floor(Date.now() / 30000);
  let ok = false;
  for (const d of [-1, 0, 1]) if (eq(await hotp(secret, c + d), code)) ok = true;
  return ok;
}
export function totpNew() {
  const secret = b32enc(crypto.getRandomValues(new Uint8Array(20)));
  const uri = `otpauth://totp/TGScout:admin?secret=${secret}&issuer=TGScout&algorithm=SHA1&digits=6&period=30`;
  const qr = QR(0, "M"); qr.addData(uri); qr.make();
  return { secret, uri, svg: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) };
}

// ---------- 邮件（Resend） ----------
export const mailOn = (cfg) => !!(cfg.resend_key && cfg.notify_email);
export async function sendMail(cfg, subject, text) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + cfg.resend_key },
    body: JSON.stringify({ from: cfg.mail_from || "TGScout <onboarding@resend.dev>", to: [cfg.notify_email], subject, text }),
  });
  if (!r.ok) {
    const t = await r.text();
    if (r.status === 403 && /own email address/i.test(t)) throw new Error("未验证域名时，收件邮箱只能是注册 Resend 的邮箱");
    if (r.status === 401 || r.status === 400 && /api key/i.test(t)) throw new Error("Resend API Key 无效");
    throw new Error("邮件发送失败 " + r.status + " " + t.slice(0, 120));
  }
}
export const code6 = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, "0");
