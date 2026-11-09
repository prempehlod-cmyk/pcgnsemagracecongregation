// Grace Congregation, Nsema-Aburaso: online storage + login for Netlify.
// One function, reached at /api. Data lives in Netlify Blobs (no database to set up).
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const MIN = 60000;
const DAY = 86400000;
const COLS = new Set(["church", "members", "attendance", "gallery", "backups"]);
const SEG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,120}$/;

const J = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const str = (v) => (v == null ? "" : String(v));
const norm = (v) => str(v).trim().toLowerCase();
const sys = (k) => "_sys/" + k;

function validPath(p) {
  const s = str(p).split("/");
  return (s.length === 2 || s.length === 4) && COLS.has(s[0]) && s.every((x) => SEG.test(x));
}
function validCol(c) {
  const s = str(c).split("/");
  return (s.length === 1 || s.length === 3) && COLS.has(s[0]) && s.every((x) => SEG.test(x));
}

async function getJ(s, k) {
  try {
    return await s.get(k, { type: "json" });
  } catch {
    return null;
  }
}
async function listKeys(s, prefix) {
  const out = [];
  for await (const page of s.list({ prefix, paginate: true })) {
    for (const b of page.blobs) out.push(b.key);
  }
  return out;
}

// ---- passwords and tokens ----
const sha = (v) => crypto.createHash("sha256").update(str(v)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
function hashPass(pass, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(str(pass), salt, 32).toString("hex") };
}
function passMatches(rec, pass) {
  const h = crypto.scryptSync(str(pass), rec.salt, 32).toString("hex");
  return safeEq(h, rec.hash);
}
const defaultUser = () => str(process.env.ADMIN_USER || "admin").trim();
const defaultPass = () => str(process.env.ADMIN_PASS || "grace2026").trim();

async function secret(s) {
  if (process.env.TOKEN_SECRET) return process.env.TOKEN_SECRET;
  let x = await getJ(s, sys("secret"));
  if (!x || !x.k) {
    x = { k: crypto.randomBytes(32).toString("hex") };
    await s.setJSON(sys("secret"), x);
  }
  return x.k;
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
async function makeToken(s, ver) {
  const exp = Date.now() + 30 * DAY;
  const p = b64({ ver, exp });
  const sig = crypto.createHmac("sha256", await secret(s)).update(p).digest("base64url");
  return { token: p + "." + sig, exp };
}
async function isAdminReq(req, s) {
  const h = req.headers.get("authorization") || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  const [p, sig] = t.split(".");
  if (!p || !sig) return false;
  const want = crypto.createHmac("sha256", await secret(s)).update(p).digest("base64url");
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return false;
  let d;
  try {
    d = JSON.parse(Buffer.from(p, "base64url").toString());
  } catch {
    return false;
  }
  if (!d || !(d.exp > Date.now())) return false;
  const rec = await getJ(s, sys("auth"));
  return d.ver === (rec ? rec.ver : 1);
}

// ---- simple brute-force protection (per visitor address) ----
async function rl(s, name, ip, max, win) {
  const k = sys("rl/" + name + "-" + str(ip).replace(/[^A-Za-z0-9]/g, "_"));
  const r = await getJ(s, k);
  const live = r && Date.now() - r.t < win;
  return {
    blocked: !!(live && r.n >= max),
    fail: async () => s.setJSON(k, { n: live ? r.n + 1 : 1, t: live ? r.t : Date.now() }),
    ok: async () => {
      if (r) await s.delete(k);
    },
  };
}

const bump = (s) => s.setJSON(sys("stamp"), { t: Date.now(), r: Math.random() });

function stub(m) {
  return {
    userId: m.userId,
    group: m.group || "",
    interestGroup: m.interestGroup || "",
    communicant: m.communicant || "",
  };
}
function cleanText(d) {
  const x = Object.assign({}, d);
  delete x.passcode;
  delete x.smsSignups;
  return x;
}
// ---- birthday index: only name + day/month are kept here; years of birth are never exposed ----
const mdOf = (dob) => (/^\d{4}-\d{2}-\d{2}$/.test(str(dob)) ? str(dob).slice(5) : "");
async function bidxBuild(s) {
  const m = {};
  const keys = (await listKeys(s, "members/")).filter((k) => !k.slice(8).includes("/"));
  for (let i = 0; i < keys.length; i += 25) {
    const vals = await Promise.all(keys.slice(i, i + 25).map((k) => getJ(s, k)));
    vals.forEach((v, j) => {
      const md = v && mdOf(v.dob);
      if (md) m[keys[i + j].slice(8)] = { n: str(v.name), md };
    });
  }
  const idx = { m };
  await s.setJSON(sys("bidx"), idx);
  return idx;
}
async function bidxUpdate(s, path, data) {
  if (!/^members\/[^/]+$/.test(path)) return;
  const idx = (await getJ(s, sys("bidx"))) || (await bidxBuild(s));
  const id = path.slice(8), md = data ? mdOf(data.dob) : "";
  if (md) idx.m[id] = { n: str(data.name), md };
  else delete idx.m[id];
  await s.setJSON(sys("bidx"), idx);
}
async function smsList(s) {
  const keys = (await listKeys(s, sys("sms/"))).sort();
  const vals = await Promise.all(keys.map((k) => getJ(s, k)));
  return vals.filter(Boolean);
}

export default async (req, context) => {
  if (req.method !== "POST") return J({ error: "POST only" }, 405);
  let body;
  try {
    body = await req.json();
  } catch {
    return J({ error: "Bad request" }, 400);
  }
  const s = getStore({ name: "grace-congregation", consistency: "strong" });
  const ip =
    (context && context.ip) ||
    req.headers.get("x-nf-client-connection-ip") ||
    str(req.headers.get("x-forwarded-for")).split(",")[0] ||
    "unknown";
  try {
    switch (body.op) {
      case "stamp": {
        const st = await getJ(s, sys("stamp"));
        return J({ stamp: st ? String(st.t) + ":" + st.r : "0", admin: await isAdminReq(req, s) });
      }

      case "list": {
        const col = str(body.col);
        if (!validCol(col)) return J({ error: "Bad collection" }, 400);
        const admin = await isAdminReq(req, s);
        if (col.split("/")[0] === "backups" && !admin) return J({ docs: [], next: null, admin });
        const prefix = col + "/";
        let keys = (await listKeys(s, prefix)).filter((k) => !k.slice(prefix.length).includes("/")).sort();
        if (body.after) keys = keys.filter((k) => k > str(body.after));
        const chunk = col === "gallery" || col === "church" ? 5 : 25;
        // Replies stay well under Netlify's 6 MB limit: big collections come back in pages.
        const docs = [];
        let size = 0,
          lastKey = null,
          more = false;
        outer: for (let i = 0; i < keys.length; i += chunk) {
          const part = keys.slice(i, i + chunk);
          const vals = await Promise.all(part.map((k) => getJ(s, k)));
          for (let j = 0; j < part.length; j++) {
            if (vals[j] == null) {
              lastKey = part[j];
              continue;
            }
            const data = col === "members" && !admin ? stub(vals[j]) : vals[j];
            const sz = JSON.stringify(data).length;
            if (docs.length && size + sz > 4500000) {
              more = true;
              break outer;
            }
            size += sz;
            docs.push({ id: part[j].slice(prefix.length), data });
            lastKey = part[j];
          }
          if (size >= 3500000 && i + chunk < keys.length) {
            more = true;
            break;
          }
        }
        return J({ docs, next: more ? lastKey : null, admin });
      }

      case "get": {
        const path = str(body.path);
        if (!validPath(path)) return J({ error: "Bad path" }, 400);
        const admin = await isAdminReq(req, s);
        if (path.startsWith("backups/") && !admin) return J({ data: null });
        let d = await getJ(s, path);
        if (path === "church/content") {
          d = d ? cleanText(d) : null;
          if (admin) d = Object.assign({}, d || {}, { smsSignups: await smsList(s) });
        } else if (path.startsWith("members/") && d && !admin) {
          d = stub(d);
        }
        return J({ data: d || null });
      }

      case "set":
      case "delete": {
        if (!(await isAdminReq(req, s))) return J({ error: "Please log in as admin again." }, 401);
        const path = str(body.path);
        if (!validPath(path)) return J({ error: "Bad path" }, 400);
        let saved = null;
        if (body.op === "delete") {
          await s.delete(path);
        } else {
          let data = body.data;
          if (!data || typeof data !== "object" || Array.isArray(data)) return J({ error: "Bad data" }, 400);
          if (JSON.stringify(data).length > 1500000) return J({ error: "That item is too large." }, 413);
          if (path === "church/content") data = cleanText(data);
          await s.setJSON(path, data);
          saved = data;
        }
        await bidxUpdate(s, path, saved);
        await bump(s);
        return J({ ok: true });
      }

      case "birthdays": {
        // Public: only people whose birthday falls in the next few days, and only name, day/month, group and photo.
        const days = Math.min(14, Math.max(0, parseInt(body.days, 10) || 7));
        const idx = (await getJ(s, sys("bidx"))) || (await bidxBuild(s));
        const base = new Date();
        base.setUTCHours(0, 0, 0, 0);
        const hits = [];
        for (let i = 0; i <= days; i++) {
          const d = new Date(base.getTime() + i * DAY);
          const md = String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
          const y = d.getUTCFullYear();
          const noLeap = !((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0);
          for (const [id, v] of Object.entries(idx.m || {})) {
            if (v.md === md || (noLeap && md === "02-28" && v.md === "02-29")) hits.push([id, v]);
          }
        }
        const list = [];
        for (const [id, v] of hits.slice(0, 40)) {
          const m = await getJ(s, "members/" + id);
          list.push({ name: v.n, md: v.md, group: m ? str(m.group) : "", photo: m ? str(m.photo) : "" });
        }
        return J({ list });
      }

      case "login": {
        const lim = await rl(s, "login", ip, 8, 15 * MIN);
        if (lim.blocked) return J({ error: "Too many wrong attempts. Wait 15 minutes." }, 429);
        const user = norm(body.user),
          pass = str(body.pass).trim();
        const rec = await getJ(s, sys("auth"));
        let userOk, passOk;
        if (rec) {
          userOk = safeEq(norm(rec.user), user);
          passOk = passMatches(rec, pass);
        } else {
          userOk = safeEq(norm(defaultUser()), user);
          passOk = safeEq(defaultPass(), pass);
        }
        if (!(userOk && passOk)) {
          await lim.fail();
          return J({ error: "Incorrect name or passcode." }, 401);
        }
        await lim.ok();
        const t = await makeToken(s, rec ? rec.ver : 1);
        return J({ token: t.token, exp: t.exp, user: rec ? rec.user : defaultUser() });
      }

      case "change": {
        if (!(await isAdminReq(req, s))) return J({ error: "Please log out and log in again, then retry." }, 401);
        const lim = await rl(s, "change", ip, 8, 15 * MIN);
        if (lim.blocked) return J({ error: "Too many wrong attempts. Wait 15 minutes." }, 429);
        const rec = await getJ(s, sys("auth"));
        const cur = str(body.current).trim();
        const curOk = rec ? passMatches(rec, cur) : safeEq(defaultPass(), cur);
        if (!curOk) {
          await lim.fail();
          return J({ error: "The current passcode is not correct." }, 401);
        }
        const user = str(body.user).trim(),
          pass = str(body.pass).trim();
        if (user.length < 3 || user.length > 40) return J({ error: "The admin name must be 3 to 40 characters." }, 400);
        if (pass.length < 6 || pass.length > 100) return J({ error: "The passcode must be 6 to 100 characters." }, 400);
        await lim.ok();
        const ver = (rec ? rec.ver : 1) + 1;
        await s.setJSON(sys("auth"), Object.assign({ user, ver }, hashPass(pass)));
        const t = await makeToken(s, ver);
        return J({ token: t.token, exp: t.exp, user });
      }

      case "memberlogin": {
        const lim = await rl(s, "member", ip, 10, 15 * MIN);
        if (lim.blocked) return J({ error: "Too many attempts. Please try again in a few minutes." }, 429);
        const name = norm(body.name),
          pass = norm(body.pass);
        let found = null;
        const matches = (m) =>
          (norm(m.name) === name || norm(m.userId) === name) && norm(m.passcode) === pass && pass !== "";
        if (/^gc-\d+$/.test(name)) {
          const m = await getJ(s, "members/" + name.toUpperCase());
          if (m && matches(m)) found = m;
        } else if (name) {
          const keys = (await listKeys(s, "members/")).filter((k) => !k.slice(8).includes("/"));
          for (let i = 0; i < keys.length && !found; i += 25) {
            const vals = await Promise.all(keys.slice(i, i + 25).map((k) => getJ(s, k)));
            found = vals.find((m) => m && matches(m)) || null;
          }
        }
        if (!found) {
          await lim.fail();
          return J({ error: "Name or passcode not recognized." }, 401);
        }
        await lim.ok();
        const m = Object.assign({}, found);
        delete m.passcode;
        return J({ member: m });
      }

      case "sms": {
        const lim = await rl(s, "sms", ip, 10, 60 * MIN);
        if (lim.blocked) return J({ error: "Too many sign-ups from this connection. Try again later." }, 429);
        const name = str(body.name).trim().slice(0, 100),
          phone = str(body.phone).trim().slice(0, 30);
        if (!name || phone.length < 5) return J({ error: "Please enter your name and phone number." }, 400);
        await lim.fail(); // counts every sign-up toward the hourly limit
        const id = Date.now() + "-" + crypto.randomBytes(3).toString("hex");
        await s.setJSON(sys("sms/" + id), { name, phone, at: new Date().toISOString() });
        return J({ ok: true });
      }

      default:
        return J({ error: "Unknown request" }, 400);
    }
  } catch (e) {
    console.error(e);
    return J({ error: "Server problem. Please try again." }, 500);
  }
};

export const config = { path: "/api" };
