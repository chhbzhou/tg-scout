import { connect } from "cloudflare:sockets";
import { Buffer } from "node:buffer";

const closed = () => new Error("socket closed");

async function socks5(sock, host, port, user, pass) {
  const w = sock.writable.getWriter();
  const r = sock.readable.getReader();
  let buf = Buffer.alloc(0);
  const need = async (n) => {
    while (buf.length < n) {
      const { value, done } = await r.read();
      if (done) throw closed();
      buf = Buffer.concat([buf, Buffer.from(value)]);
    }
    const out = buf.subarray(0, n);
    buf = buf.subarray(n);
    return out;
  };
  const auth = user != null;
  await w.write(Buffer.from(auth ? [5, 2, 0, 2] : [5, 1, 0]));
  const m = await need(2);
  if (m[1] === 2) {
    const u = Buffer.from(user), p = Buffer.from(pass || "");
    await w.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
    if ((await need(2))[1] !== 0) throw new Error("socks5 auth failed");
  } else if (m[1] !== 0) throw new Error("socks5 no acceptable method");
  const isV4 = /^\d+\.\d+\.\d+\.\d+$/.test(host);
  const addr = isV4
    ? Buffer.from([1, ...host.split(".").map(Number)])
    : Buffer.concat([Buffer.from([3, Buffer.byteLength(host)]), Buffer.from(host)]);
  await w.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, Buffer.from([port >> 8, port & 255])]));
  const h = await need(4);
  if (h[1] !== 0) throw new Error("socks5 connect failed: " + h[1]);
  await need(h[3] === 1 ? 6 : h[3] === 4 ? 18 : (await need(1))[0] + 2);
  w.releaseLock();
  r.releaseLock();
  return buf;
}

// 与 gramjs PromisedNetSockets 同接口，底层用 cloudflare:sockets，可选 SOCKS5 出口
export function makeSockets(proxy) {
  return class WorkerSockets {
    constructor() {
      this.closed = true;
      this.stream = Buffer.alloc(0);
    }
    async connect(port, ip) {
      this.stream = Buffer.alloc(0);
      let extra = Buffer.alloc(0);
      if (proxy?.host) {
        this.sock = connect({ hostname: proxy.host, port: proxy.port });
        extra = await socks5(this.sock, ip, port, proxy.username || null, proxy.password);
      } else {
        this.sock = connect({ hostname: ip, port });
      }
      await this.sock.opened;
      this.writer = this.sock.writable.getWriter();
      this.closed = false;
      this.canRead = new Promise((res) => (this.resolveRead = res));
      if (extra.length) this.push(extra);
      this.pump();
      return this;
    }
    push(chunk) {
      this.stream = Buffer.concat([this.stream, Buffer.from(chunk)]);
      this.resolveRead?.(true);
    }
    async pump() {
      try {
        const r = this.sock.readable.getReader();
        for (;;) {
          const { value, done } = await r.read();
          if (done) break;
          this.push(value);
        }
      } catch {}
      this.closed = true;
      this.resolveRead?.(false);
    }
    async readExactly(n) {
      let out = Buffer.alloc(0);
      while (n > 0) {
        const part = await this.read(n);
        out = Buffer.concat([out, part]);
        n -= part.length;
      }
      return out;
    }
    async read(n) {
      if (this.closed && !this.stream.length) throw closed();
      await this.canRead;
      if (this.closed && !this.stream.length) throw closed();
      const out = this.stream.subarray(0, n);
      this.stream = this.stream.subarray(n);
      if (!this.stream.length) this.canRead = new Promise((res) => (this.resolveRead = res));
      return out;
    }
    async readAll() {
      if (this.closed && !this.stream.length) throw closed();
      await this.canRead;
      const out = this.stream;
      this.stream = Buffer.alloc(0);
      this.canRead = new Promise((res) => (this.resolveRead = res));
      return out;
    }
    write(data) {
      if (this.closed) throw closed();
      this.writer.write(data).catch(() => {});
    }
    async close() {
      this.closed = true;
      try { await this.sock?.close(); } catch {}
      this.resolveRead?.(false);
    }
    toString() { return "WorkerSockets"; }
  };
}

const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

// 经代理访问：1) 查出口 IP 与地区  2) 连 Telegram DC 看耗时
export async function probeProxy(proxy) {
  const out = {};
  const open = async (host, port) => {
    const sock = connect({ hostname: proxy.host, port: proxy.port });
    await withTimeout(sock.opened, 8000, "连不上代理");
    const left = await withTimeout(socks5(sock, host, port, proxy.username || null, proxy.password), 8000, "代理握手超时");
    return { sock, left };
  };
  {
    const { sock, left } = await open("ip-api.com", 80);
    const w = sock.writable.getWriter();
    await w.write(Buffer.from("GET /json?fields=query,country,city,isp HTTP/1.1\r\nHost: ip-api.com\r\nConnection: close\r\n\r\n"));
    const r = sock.readable.getReader();
    let buf = Buffer.from(left), t = "";
    await withTimeout((async () => { for (;;) { const { value, done } = await r.read(); if (done) break; buf = Buffer.concat([buf, Buffer.from(value)]); if (/\}\s*$/.test(buf.toString())) break; } })(), 8000, "获取出口信息超时");
    t = buf.toString();
    try { Object.assign(out, JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1))); } catch {}
    try { await sock.close(); } catch {}
  }
  {
    const t0 = Date.now();
    const { sock } = await open("149.154.167.51", 443);
    out.tg_ms = Date.now() - t0;
    try { await sock.close(); } catch {}
  }
  return out;
}
