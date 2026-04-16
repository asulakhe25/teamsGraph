const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Supabase config (set these as Render environment variables) ──
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function sbHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-ado-token", "Authorization"],
}));
app.options("*", cors());
app.use(express.json({ limit: "5mb" }));

app.get("/", (req, res) => res.json({ status: "ok", service: "Azure DevOps Proxy + Supabase" }));

// GET /members?org=Sogolytics
app.get("/members", async (req, res) => {
  const org = req.query.org || "Sogolytics";
  const pat = req.headers["x-ado-token"] || process.env.ADO_PAT;
  if (!pat) return res.status(401).json({ error: "Missing x-ado-token header or ADO_PAT env var" });

  const b64 = Buffer.from(`:${pat}`).toString("base64");
  const headers = { Authorization: `Basic ${b64}`, "Content-Type": "application/json" };

  // Helper: fetch as text, reject HTML login redirects
  async function adoFetch(url) {
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

  try {
    // Validate PAT with projects API
    const r1 = await adoFetch(`https://dev.azure.com/${org}/_apis/projects?api-version=7.1`);
    if (!r1.ok) return res.status(r1.status).json({ error: r1.error });

    // Try 1: Graph Users API
    const r2 = await adoFetch(`https://vssps.dev.azure.com/${org}/_apis/graph/users?api-version=7.1-preview.1`);
    if (r2.ok) {
      const members = (r2.data.value || [])
        .filter(u => u.subjectKind === "user" && u.displayName && !u.displayName.includes("\\"))
        .map(u => ({
          id: u.descriptor,
          displayName: u.displayName,
          email: u.mailAddress || u.principalName || "",
        }));
      return res.json({ members, count: members.length, source: "graph" });
    }

    // Try 2: User Entitlements API
    const r4 = await adoFetch(`https://vsaex.dev.azure.com/${org}/_apis/userentitlements?api-version=7.1-preview.3`);
    if (r4.ok) {
      const members = (r4.data.members || r4.data.value || []).map(u => ({
        id: u.id || u.user?.subjectDescriptor || u.user?.principalName,
        displayName: u.user?.displayName || u.user?.principalName || "Unknown",
        email: u.user?.mailAddress || u.user?.principalName || "",
      })).filter(u => u.displayName !== "Unknown");
      return res.json({ members, count: members.length, source: "entitlements" });
    }

    // Last resort: PAT owner from Connection Data
    const r3 = await adoFetch(`https://app.vssps.visualstudio.com/_apis/connectiondata`);
    if (!r3.ok) {
      return res.status(401).json({
        error: "PAT is valid but lacks required scopes. Regenerate your PAT with: Graph > Read, Member Entitlement Management > Read"
      });
    }
    const self = r3.data.authenticatedUser;

    return res.json({
      members: [{ id: self?.subjectDescriptor || "self", displayName: self?.providerDisplayName || "You", email: self?.mailAddress || "" }],
      count: 1,
      source: "self",
      warning: "Only loaded the PAT owner. Add 'Member Entitlement Management > Read' scope to your PAT to load all members."
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /teams?org=Sogolytics — list ADO project teams
app.get("/teams", async (req, res) => {
  const org = req.query.org || "Sogolytics";
  const pat = req.headers["x-ado-token"] || process.env.ADO_PAT;
  if (!pat) return res.status(401).json({ error: "Missing x-ado-token header or ADO_PAT env var" });

  const b64 = Buffer.from(`:${pat}`).toString("base64");
  const headers = { Authorization: `Basic ${b64}`, "Content-Type": "application/json" };

  async function adoFetch(url) {
    const r = await fetch(url, { headers, redirect: "manual" });
    if (r.status >= 300 && r.status < 400) return { ok: false, status: r.status, error: "Redirected to login — PAT is invalid or expired" };
    const text = await r.text();
    if (text.trim().startsWith("<")) return { ok: false, status: r.status, error: `PAT rejected (${r.status})` };
    if (!r.ok) return { ok: false, status: r.status, error: `Azure DevOps error ${r.status}: ${text.slice(0, 200)}` };
    return { ok: true, data: JSON.parse(text) };
  }

  try {
    // Get all projects
    const r1 = await adoFetch(`https://dev.azure.com/${org}/_apis/projects?api-version=7.1`);
    if (!r1.ok) return res.status(r1.status).json({ error: r1.error });

    const projects = r1.data.value || [];
    const teams = [];

    // Get teams for each project
    for (const proj of projects) {
      const r2 = await adoFetch(`https://dev.azure.com/${org}/_apis/projects/${proj.id}/teams?api-version=7.1`);
      if (r2.ok) {
        for (const t of (r2.data.value || [])) {
          teams.push({ id: t.id, name: t.name, project: proj.name });
        }
      }
    }

    return res.json({ teams, count: teams.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Supabase File endpoints ──────────────────────────────────────────────

// GET /files — list all skill files (newest first)
app.get("/files", async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: "SUPABASE_URL or SUPABASE_KEY not configured" });
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/skill_files?order=uploaded_at.desc`, { headers: sbHeaders() });
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: t }); }
    const rows = await r.json();
    return res.json({ files: rows, count: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /files — upload a new skill file
app.post("/files", async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: "SUPABASE_URL or SUPABASE_KEY not configured" });
  const { id, filename, title, description, uploader, email, size, uploaded_at, content, folder, category } = req.body;
  if (!id || !filename || !uploader || !content) return res.status(400).json({ error: "Missing required fields: id, filename, uploader, content" });
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/skill_files`, {
      method: "POST",
      headers: sbHeaders(),
      body: JSON.stringify({ id, filename, title, description, uploader, email, size, uploaded_at, content, folder: folder || "General", category: category || "" }),
    });
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: t }); }
    const rows = await r.json();
    return res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /files/:id — delete a skill file
app.delete("/files/:id", async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: "SUPABASE_URL or SUPABASE_KEY not configured" });
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/skill_files?id=eq.${encodeURIComponent(req.params.id)}`, {
      method: "DELETE",
      headers: sbHeaders(),
    });
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: t }); }
    return res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));