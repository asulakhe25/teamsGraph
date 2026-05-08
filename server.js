const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Supabase config ──
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// ── Delete password (server-side only) ──
const DELETE_PASSWORD = process.env.DELETE_PASSWORD || "delete234";

function sbHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

// ── CORS — whitelist known origins, fallback open for dev ──
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(null, false);
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-ado-token", "x-delete-password", "Authorization"],
}));
app.options("*", cors());
app.use(express.json({ limit: "5mb" }));

// ── Serve static frontend files ──
const path = require("path");
app.use(express.static(path.join(__dirname)));

// ── Simple in-memory rate limiter ──
const rateBuckets = {};
function rateLimit(windowMs, maxReqs) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    if (!rateBuckets[ip]) rateBuckets[ip] = [];
    rateBuckets[ip] = rateBuckets[ip].filter(t => now - t < windowMs);
    if (rateBuckets[ip].length >= maxReqs) {
      return res.status(429).json({ error: "Too many requests. Please try again later." });
    }
    rateBuckets[ip].push(now);
    next();
  };
}
// Clean up stale IPs every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const ip of Object.keys(rateBuckets)) {
    rateBuckets[ip] = rateBuckets[ip].filter(t => now - t < 60000);
    if (rateBuckets[ip].length === 0) delete rateBuckets[ip];
  }
}, 300000);

// Apply rate limiting: 100 requests per minute per IP
app.use(rateLimit(60000, 100));

// ── Shared ADO fetch helper ──
async function adoFetch(url, pat) {
  const b64 = Buffer.from(`:${pat}`).toString("base64");
  const headers = { Authorization: `Basic ${b64}`, "Content-Type": "application/json" };
  const r = await fetch(url, { headers, redirect: "manual" });
  if (r.status >= 300 && r.status < 400) {
    return { ok: false, status: r.status, error: "Redirected to login — PAT is invalid or expired" };
  }
  const text = await r.text();
  if (text.trim().startsWith("<")) {
    return { ok: false, status: r.status, error: `PAT rejected by Azure DevOps (${r.status})` };
  }
  if (!r.ok) {
    return { ok: false, status: r.status, error: `Azure DevOps error ${r.status}: ${text.slice(0, 200)}` };
  }
  return { ok: true, status: r.status, data: JSON.parse(text) };
}

// ── Health check ──
app.get("/", (req, res) => res.json({ status: "ok", service: "Azure DevOps Proxy + Supabase", version: "2.0" }));

// ── GET /members ──
app.get("/members", async (req, res) => {
  const org = req.query.org || "Sogolytics";
  const pat = req.headers["x-ado-token"] || process.env.ADO_PAT;
  if (!pat) return res.status(401).json({ error: "Missing x-ado-token header or ADO_PAT env var" });

  try {
    const r1 = await adoFetch(`https://dev.azure.com/${org}/_apis/projects?api-version=7.1`, pat);
    if (!r1.ok) return res.status(r1.status).json({ error: r1.error });

    // Try 1: Graph Users API
    const r2 = await adoFetch(`https://vssps.dev.azure.com/${org}/_apis/graph/users?api-version=7.1-preview.1`, pat);
    if (r2.ok) {
      const members = (r2.data.value || [])
        .filter(u => u.subjectKind === "user" && u.displayName && !u.displayName.includes("\\"))
        .map(u => ({ id: u.descriptor, displayName: u.displayName, email: u.mailAddress || u.principalName || "" }));
      return res.json({ members, count: members.length, source: "graph" });
    }

    // Try 2: User Entitlements API
    const r4 = await adoFetch(`https://vsaex.dev.azure.com/${org}/_apis/userentitlements?api-version=7.1-preview.3`, pat);
    if (r4.ok) {
      const members = (r4.data.members || r4.data.value || []).map(u => ({
        id: u.id || u.user?.subjectDescriptor || u.user?.principalName,
        displayName: u.user?.displayName || u.user?.principalName || "Unknown",
        email: u.user?.mailAddress || u.user?.principalName || "",
      })).filter(u => u.displayName !== "Unknown");
      return res.json({ members, count: members.length, source: "entitlements" });
    }

    // Last resort: PAT owner
    const r3 = await adoFetch(`https://app.vssps.visualstudio.com/_apis/connectiondata`, pat);
    if (!r3.ok) {
      return res.status(401).json({ error: "PAT is valid but lacks required scopes. Regenerate with: Graph > Read, Member Entitlement Management > Read" });
    }
    const self = r3.data.authenticatedUser;
    return res.json({
      members: [{ id: self?.subjectDescriptor || "self", displayName: self?.providerDisplayName || "You", email: self?.mailAddress || "" }],
      count: 1, source: "self",
      warning: "Only loaded the PAT owner. Add 'Member Entitlement Management > Read' scope to load all members."
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /teams ──
app.get("/teams", async (req, res) => {
  const org = req.query.org || "Sogolytics";
  const pat = req.headers["x-ado-token"] || process.env.ADO_PAT;
  if (!pat) return res.status(401).json({ error: "Missing x-ado-token header or ADO_PAT env var" });

  try {
    const r1 = await adoFetch(`https://dev.azure.com/${org}/_apis/projects?api-version=7.1`, pat);
    if (!r1.ok) return res.status(r1.status).json({ error: r1.error });

    const projects = r1.data.value || [];
    const teams = [];
    for (const proj of projects) {
      const r2 = await adoFetch(`https://dev.azure.com/${org}/_apis/projects/${proj.id}/teams?api-version=7.1`, pat);
      if (r2.ok) {
        for (const t of (r2.data.value || [])) {
          teams.push({ id: t.id, name: t.name, project: proj.name });
        }
      }
    }
    return res.json({ teams, count: teams.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Supabase File endpoints ──

// GET /files — list with pagination & optional filtering
app.get("/files", async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: "SUPABASE_URL or SUPABASE_KEY not configured" });
  try {
    const page = Math.max(1, Number.parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    let url = `${SUPABASE_URL}/rest/v1/skill_files?order=uploaded_at.desc&offset=${offset}&limit=${limit}`;
    // Optional filters
    if (req.query.folder) url += `&folder=eq.${encodeURIComponent(req.query.folder)}`;
    if (req.query.category) url += `&category=eq.${encodeURIComponent(req.query.category)}`;
    if (req.query.uploader) url += `&uploader=eq.${encodeURIComponent(req.query.uploader)}`;

    const countHeaders = { ...sbHeaders(), Prefer: "count=exact" };
    const r = await fetch(url, { headers: countHeaders });
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: t }); }
    const rows = await r.json();
    const total = Number.parseInt(r.headers.get("content-range")?.split("/")[1] || rows.length);

    return res.json({ files: rows, count: rows.length, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /files — upload a new skill file
app.post("/files", async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: "SUPABASE_URL or SUPABASE_KEY not configured" });
  const { id, filename, title, description, uploader, email, size, uploaded_at, content, folder, category, tags } = req.body;
  if (!id || !filename || !uploader || !content) return res.status(400).json({ error: "Missing required fields: id, filename, uploader, content" });
  if (size && size > 5 * 1024 * 1024) return res.status(400).json({ error: "File too large. Max 5MB." });
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/skill_files`, {
      method: "POST", headers: sbHeaders(),
      body: JSON.stringify({
        id, filename, title, description, uploader, email, size, uploaded_at, content,
        folder: folder || "General", category: category || "", tags: tags || "",
        version: 1, updated_at: uploaded_at
      }),
    });
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: t }); }
    const rows = await r.json();
    return res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /files/:id — update file metadata or content
app.put("/files/:id", async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: "SUPABASE_URL or SUPABASE_KEY not configured" });
  const allowed = ["title", "description", "category", "folder", "content", "tags"];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No valid fields to update" });
  updates.updated_at = Date.now();
  try {
    // Increment version
    const getR = await fetch(`${SUPABASE_URL}/rest/v1/skill_files?id=eq.${encodeURIComponent(req.params.id)}&select=version`, { headers: sbHeaders() });
    if (getR.ok) {
      const rows = await getR.json();
      if (rows.length > 0) updates.version = (rows[0].version || 1) + 1;
    }
    const r = await fetch(`${SUPABASE_URL}/rest/v1/skill_files?id=eq.${encodeURIComponent(req.params.id)}`, {
      method: "PATCH", headers: sbHeaders(), body: JSON.stringify(updates),
    });
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: t }); }
    const rows = await r.json();
    return res.json(rows[0] || { updated: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /files/:id — delete with server-side password validation
app.delete("/files/:id", async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: "SUPABASE_URL or SUPABASE_KEY not configured" });
  const pwd = req.headers["x-delete-password"];
  if (!pwd || pwd !== DELETE_PASSWORD) return res.status(403).json({ error: "Invalid delete password" });
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/skill_files?id=eq.${encodeURIComponent(req.params.id)}`, {
      method: "DELETE", headers: sbHeaders(),
    });
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: t }); }
    return res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
