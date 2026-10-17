let ready = false;
export async function ensure(db) {
  if (ready) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS strategies(
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, chats TEXT NOT NULL DEFAULT '[]',
      keywords TEXT NOT NULL DEFAULT '[]', match_mode TEXT NOT NULL DEFAULT 'any',
      prompt TEXT NOT NULL DEFAULT '', interval_min INTEGER NOT NULL DEFAULT 5,
      last_run INTEGER NOT NULL DEFAULT 0, cursors TEXT NOT NULL DEFAULT '{}')`),
    db.prepare(`CREATE TABLE IF NOT EXISTS hits(
      id INTEGER PRIMARY KEY AUTOINCREMENT, strategy_id INTEGER, strategy_name TEXT,
      chat TEXT, msg_id INTEGER, sender TEXT, text TEXT, reason TEXT, link TEXT, ts INTEGER)`),
    db.prepare("CREATE INDEX IF NOT EXISTS hits_ts ON hits(ts DESC)"),
    db.prepare("CREATE TABLE IF NOT EXISTS sessions(h TEXT PRIMARY KEY, exp INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS fails(ip TEXT PRIMARY KEY, n INTEGER NOT NULL, ts INTEGER NOT NULL, until INTEGER NOT NULL DEFAULT 0)"),
    db.prepare("CREATE TABLE IF NOT EXISTS usage(day TEXT PRIMARY KEY, inp INTEGER NOT NULL DEFAULT 0, outp INTEGER NOT NULL DEFAULT 0, tot INTEGER NOT NULL DEFAULT 0)"),
  ]);
  for (const col of ["range_n INTEGER NOT NULL DEFAULT 50", "push INTEGER NOT NULL DEFAULT 0", "last_status TEXT NOT NULL DEFAULT ''", "last_err TEXT NOT NULL DEFAULT ''", "fail_n INTEGER NOT NULL DEFAULT 0", "@hits tin INTEGER NOT NULL DEFAULT 0", "@hits tout INTEGER NOT NULL DEFAULT 0", "@hits ttot INTEGER NOT NULL DEFAULT 0"]) {
    try { await db.prepare(col.startsWith("@hits ") ? "ALTER TABLE hits ADD COLUMN " + col.slice(6) : "ALTER TABLE strategies ADD COLUMN " + col).run(); } catch {}
  }
  ready = true;
}
export async function getSettings(db) {
  const { results } = await db.prepare("SELECT k,v FROM settings").all();
  return Object.fromEntries(results.map((r) => [r.k, r.v]));
}
export async function setSettings(db, obj) {
  const st = db.prepare("INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v");
  await db.batch(Object.entries(obj).map(([k, v]) => st.bind(k, v == null ? "" : String(v))));
}
export async function delSetting(db, k) {
  await db.prepare("DELETE FROM settings WHERE k=?").bind(k).run();
}

const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
export const rowToStrategy = (r) => ({ ...r, enabled: !!r.enabled, push: !!r.push, chats: J(r.chats, []), keywords: J(r.keywords, []), cursors: J(r.cursors, {}) });

export async function listStrategies(db) {
  const { results } = await db.prepare("SELECT * FROM strategies ORDER BY id").all();
  return results.map(rowToStrategy);
}
function clean(b) {
  const type = b.type === "ai" ? "ai" : "keyword";
  const n = Number(b.interval_min);
  const manual = type === "ai" && n === 0; // 频率 0 = 手动运行（仅 AI 策略）
  if (!manual && (!Number.isInteger(n) || n < 1 || n > 1440)) throw new Error("频率需为 1–1440 分钟");
  return {
    name: String(b.name || "").slice(0, 60) || "未命名",
    type,
    enabled: b.enabled === false || b.enabled === 0 ? 0 : 1,
    chats: JSON.stringify(Array.isArray(b.chats) ? b.chats.map(String) : []),
    keywords: JSON.stringify(type === "keyword" && Array.isArray(b.keywords) ? b.keywords.map(String).filter(Boolean) : []),
    match_mode: ["any", "all", "regex"].includes(b.match_mode) ? b.match_mode : "any",
    prompt: type === "ai" ? String(b.prompt || "") : "",
    interval_min: manual ? 0 : n,
    range_n: Math.max(1, Math.min(200, parseInt(b.range_n) || 50)),
    push: b.push ? 1 : 0,
  };
}
export async function createStrategy(db, b) {
  const c = clean(b);
  const r = await db.prepare("INSERT INTO strategies(name,type,enabled,chats,keywords,match_mode,prompt,interval_min,range_n,push) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .bind(c.name, c.type, c.enabled, c.chats, c.keywords, c.match_mode, c.prompt, c.interval_min, c.range_n, c.push).run();
  return r.meta.last_row_id;
}
export async function updateStrategy(db, id, b) {
  const c = clean(b);
  // 改范围或类型时重置游标，避免回灌历史
  await db.prepare("UPDATE strategies SET name=?,type=?,enabled=?,chats=?,keywords=?,match_mode=?,prompt=?,interval_min=?,range_n=?,push=?,cursors='{}' WHERE id=?")
    .bind(c.name, c.type, c.enabled, c.chats, c.keywords, c.match_mode, c.prompt, c.interval_min, c.range_n, c.push, id).run();
}
export async function deleteStrategy(db, id) {
  await db.batch([
    db.prepare("DELETE FROM strategies WHERE id=?").bind(id),
    db.prepare("DELETE FROM hits WHERE strategy_id=?").bind(id),
  ]);
}

// 按北京时间自然日统计 AI token
const dayKey = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
export async function addUsage(db, u) {
  if (!u) return;
  const i = +u.prompt_tokens || 0, o = +u.completion_tokens || 0, t = +u.total_tokens || i + o;
  if (!i && !o && !t) return;
  await db.prepare("INSERT INTO usage(day,inp,outp,tot) VALUES(?,?,?,?) ON CONFLICT(day) DO UPDATE SET inp=inp+excluded.inp, outp=outp+excluded.outp, tot=tot+excluded.tot")
    .bind(dayKey(), i, o, t).run();
}
export async function getUsage(db) {
  const all = await db.prepare("SELECT COALESCE(SUM(inp),0) i, COALESCE(SUM(outp),0) o, COALESCE(SUM(tot),0) t FROM usage").first();
  const td = await db.prepare("SELECT inp i, outp o, tot t FROM usage WHERE day=?").bind(dayKey()).first();
  return { total: { in: all.i, out: all.o, tot: all.t }, today: { in: td?.i || 0, out: td?.o || 0, tot: td?.t || 0 } };
}
