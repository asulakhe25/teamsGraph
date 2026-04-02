const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-ado-token", "Authorization"],
}));
app.options("*", cors());
app.use(express.json());

app.get("/", (req, res) => res.json({ status: "ok", service: "Azure DevOps Proxy" }));

// GET /members?org=Sogolytics
app.get("/members", async (req, res) => {
  const org = req.query.org || "Sogolytics";
  const pat = req.headers["x-ado-token"];
  if (!pat) return res.status(401).json({ error: "Missing x-ado-token header" });

  const b64 = Buffer.from(`:${pat}`).toString("base64");
  const headers = { Authorization: `Basic ${b64}`, "Content-Type": "application/json" };

  try {
    // Try 1: Core Members API (works with basic PAT, no Graph scope needed)
    const r1 = await fetch(
      `https://dev.azure.com/${org}/_apis/projects?api-version=7.1`,
      { headers }
    );

    if (!r1.ok) {
      const text = await r1.text();
      const isHtml = text.trim().startsWith("<");
      return res.status(r1.status).json({
        error: isHtml
          ? `PAT rejected by Azure DevOps (${r1.status}) — check PAT is valid and not expired`
          : `Azure DevOps error ${r1.status}: ${text.slice(0, 200)}`
      });
    }

    // Try 2: Get members via Teams API
    const r2 = await fetch(
      `https://vssps.dev.azure.com/${org}/_apis/graph/users?api-version=7.1-preview.1`,
      { headers }
    );

    if (r2.ok) {
      const data = await r2.json();
      const members = (data.value || [])
        .filter(u => u.subjectKind === "user" && u.displayName && !u.displayName.includes("\\"))
        .map(u => ({
          id: u.descriptor,
          displayName: u.displayName,
          email: u.mailAddress || u.principalName || "",
        }));
      return res.json({ members, count: members.length, source: "graph" });
    }

    // Fallback: Get members via Connection Data (works with Member Read scope)
    const r3 = await fetch(
      `https://app.vssps.visualstudio.com/_apis/connectiondata`,
      { headers }
    );
    const cd = await r3.json();
    const self = cd.authenticatedUser;

    // Get org members via REST
    const r4 = await fetch(
      `https://vsaex.dev.azure.com/${org}/_apis/userentitlements?api-version=7.1-preview.3`,
      { headers }
    );

    if (r4.ok) {
      const data = await r4.json();
      const members = (data.members || data.value || []).map(u => ({
        id: u.id || u.user?.subjectDescriptor || u.user?.principalName,
        displayName: u.user?.displayName || u.user?.principalName || "Unknown",
        email: u.user?.mailAddress || u.user?.principalName || "",
      })).filter(u => u.displayName !== "Unknown");
      return res.json({ members, count: members.length, source: "entitlements" });
    }

    // Last resort: return just the PAT owner
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

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));