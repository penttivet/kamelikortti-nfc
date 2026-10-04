// Kamelikortti API — runs on Vercel, talks to Supabase and Anthropic.
const crypto = require("crypto");

// ---------- environment (accepts several variable names) ----------
const ENV_USED = {};
function findEnv(label, exactNames, test) {
  for (const n of exactNames) if (process.env[n]) { ENV_USED[label] = n; return String(process.env[n]).trim(); }
  const k = Object.keys(process.env).find((key) => test(key.toLowerCase()));
  ENV_USED[label] = k || null;
  return k ? String(process.env[k]).trim() : "";
}
const SB_URL = findEnv("url", ["SUPABASE_URL", "supabase"], (l) => l.includes("supabase") && l.includes("url")).replace(/\/+$/, "");
const SB_KEY = findEnv("key", ["SUPABASE_SECRET_KEY", "supabase_secret_key", "SUPABASE_SERVICE_ROLE_KEY"],
  (l) => l.includes("supabase") && (l.includes("secret") || l.includes("service")));
const APP_PIN = findEnv("pin", ["APP_PIN", "app_pin", "PIN", "pin"], (l) => l.includes("pin") && !l.startsWith("vercel"));
const ANTHROPIC_KEY = findEnv("anthropic", ["ANTHROPIC_API_KEY", "anthropic_api_key"], (l) => l.includes("anthropic"));

const COOKIE = "kk_session";
const BUCKET = "photos";

function sessionToken() {
  return crypto.createHmac("sha256", SB_KEY || "x").update("pin:" + APP_PIN).digest("hex");
}
function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  const m = raw.split(/;\s*/).find((c) => c.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : "";
}
function isAuthed(req) {
  const t = getCookie(req, COOKIE);
  const good = sessionToken();
  return t.length === good.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(good));
}

// ---------- Supabase helpers ----------
function sbHeaders(extra) {
  const h = Object.assign({ apikey: SB_KEY }, extra || {});
  if (SB_KEY.startsWith("eyJ")) h.Authorization = "Bearer " + SB_KEY; // legacy service_role key
  return h;
}
async function sb(path, opts) {
  opts = opts || {};
  const r = await fetch(SB_URL + "/rest/v1/" + path, {
    method: opts.method || "GET",
    headers: sbHeaders(Object.assign({ "Content-Type": "application/json" }, opts.headers || {})),
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error("Database error " + r.status + ": " + text.slice(0, 300));
  return text ? JSON.parse(text) : null;
}
const enc = encodeURIComponent;
const withId = (rows) => (rows || []).map((r) => Object.assign({}, r.data, { _id: r.id }));
function dueDay(d) {
  if (!d) return null;
  const s = String(d).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// ---------- actions ----------
const actions = {
  async ping() { return true; },

  async getCamel({ tag }) {
    const rows = await sb("camels?tag=eq." + enc(tag) + "&select=data");
    return rows && rows[0] ? rows[0].data : null;
  },

  async resolveTag({ tag }) {
    const pat = String(tag || "").replace(/[\\_%*]/g, (c) => "\\" + c);
    const rows = await sb("camels?tag=ilike." + enc(pat) + "&select=tag&limit=1");
    return rows && rows[0] ? rows[0].tag : null;
  },

  async listCamels() {
    const rows = await sb("camels?select=data&order=name.asc.nullslast&limit=300");
    return rows.map((r) => r.data);
  },

  async saveCamel({ tag, data }) {
    if (!tag) throw new Error("Missing tag");
    await sb("camels?on_conflict=tag", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: { tag, name: (data && data.name) || null, data: data || {}, updated_at: new Date().toISOString() },
    });
    return true;
  },

  async listRecords({ tag, category }) {
    let q = "records?camel_tag=eq." + enc(tag) + "&select=id,data&order=created_at.desc&limit=200";
    if (category) q += "&category=eq." + enc(category);
    return withId(await sb(q));
  },

  async addRecord({ doc }) {
    if (!doc || !doc.camelTag) throw new Error("Missing camel");
    const rows = await sb("records", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: {
        camel_tag: doc.camelTag,
        category: doc.category || null,
        due_date: dueDay(doc.dueDate),
        data: doc,
        created_at: doc.createdAt || new Date().toISOString(),
      },
    });
    return { id: rows && rows[0] ? rows[0].id : null };
  },

  async deleteRecord({ id }) {
    await sb("records?id=eq." + enc(id), { method: "DELETE" });
    return true;
  },

  async listDue() {
    return withId(await sb("records?due_date=not.is.null&select=id,data&order=due_date.asc&limit=80"));
  },

  async listByCategory({ cat }) {
    return withId(await sb("records?category=eq." + enc(cat) + "&select=id,data&limit=500"));
  },

  async upload({ base64, contentType, ext }) {
    if (!base64) throw new Error("No file");
    const buf = Buffer.from(base64, "base64");
    const safeExt = String(ext || "jpg").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "bin";
    const id = crypto.randomUUID().replace(/-/g, "") + "." + safeExt;
    const r = await fetch(SB_URL + "/storage/v1/object/" + BUCKET + "/" + id, {
      method: "POST",
      headers: sbHeaders({ "Content-Type": contentType || "application/octet-stream", "x-upsert": "true" }),
      body: buf,
    });
    if (!r.ok) throw new Error("Photo upload failed " + r.status + ": " + (await r.text()).slice(0, 200));
    return { id };
  },

  async ai({ prompt }) {
    if (!ANTHROPIC_KEY) throw new Error("AI key is not set in Vercel.");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 800,
        messages: [{ role: "user", content: String(prompt || "").slice(0, 8000) }],
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error("AI error: " + ((j.error && j.error.message) || r.status));
    const text = (j.content || []).map((c) => c.text || "").join("");
    const m = text.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
    if (!m) return {};
    try { return JSON.parse(m[0]); } catch (e) { return {}; }
  },
};

// ---------- photo download (GET /_blob/<id>) ----------
async function servePhoto(req, res, id) {
  if (!isAuthed(req)) { res.statusCode = 401; return res.end("PIN required"); }
  const safe = String(id).replace(/[^A-Za-z0-9._-]/g, "");
  const r = await fetch(SB_URL + "/storage/v1/object/" + BUCKET + "/" + safe, { headers: sbHeaders() });
  if (!r.ok) { res.statusCode = 404; return res.end("Not found"); }
  res.setHeader("Content-Type", r.headers.get("content-type") || "application/octet-stream");
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.end(Buffer.from(await r.arrayBuffer()));
}

// ---------- main handler ----------
module.exports = async (req, res) => {
  const send = (status, obj) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
  try {
    if (!SB_URL || !SB_KEY) return send(500, { error: "Supabase settings are missing in Vercel." });
    if (!APP_PIN) return send(500, { error: "PIN is not set in Vercel." });

    if (req.method === "GET") {
      const url = new URL(req.url, "http://x");
      const photo = url.searchParams.get("photo");
      if (photo) return servePhoto(req, res, photo);
      if (url.searchParams.get("diag")) {
        if (!isAuthed(req)) return send(401, { error: "Open the app and enter the PIN first." });
        let test = null;
        try {
          const r = await fetch(SB_URL + "/rest/v1/camels?select=tag&limit=1", { headers: sbHeaders() });
          test = r.status + " " + (await r.text()).slice(0, 120);
        } catch (e) { test = "fetch failed: " + e.message; }
        return send(200, {
          variables_used: ENV_USED,
          supabase_url: SB_URL,
          key_starts_with: SB_KEY.slice(0, 8),
          key_length: SB_KEY.length,
          key_has_spaces: /\s/.test(SB_KEY),
          all_supabase_variable_names: Object.keys(process.env).filter((k) => k.toLowerCase().includes("supabase")),
          database_test: test,
        });
      }
      return send(200, { ok: true });
    }
    if (req.method !== "POST") return send(405, { error: "Method not allowed" });

    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const action = body.action;

    if (action === "login") {
      if (String(body.pin || "").trim() !== APP_PIN) {
        await new Promise((r) => setTimeout(r, 800)); // slow down guessing
        return send(401, { error: "Wrong PIN." });
      }
      res.setHeader("Set-Cookie", COOKIE + "=" + sessionToken() + "; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax");
      return send(200, { result: true });
    }
    if (action === "logout") {
      res.setHeader("Set-Cookie", COOKIE + "=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
      return send(200, { result: true });
    }

    if (!isAuthed(req)) return send(401, { error: "PIN required" });
    const fn = actions[action];
    if (!fn) return send(400, { error: "Unknown action" });
    const result = await fn(body);
    return send(200, { result: result === undefined ? null : result });
  } catch (e) {
    return send(500, { error: (e && e.message) || String(e) });
  }
};
