const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// Allow requests from anywhere (artifact, your domain, etc.)
app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => res.json({ status: "ok", service: "Azure DevOps Proxy" }));

/**
 * GET /members?org=Sogolytics
 * Header: x-ado-token: <PAT>
 * Returns list of Azure DevOps users
 */
app.get("/members", async (req, res) => {
  const org = req.query.org || "Sogolytics";
  const pat = req.headers["x-ado-token"];

  if (!pat) return res.status(401).json({ error: "Missing x-ado-token header" });

  const b64 = Buffer.from(`:${pat}`).toString("base64");

  try {
    const response = await fetch(
      `https://vssps.dev.azure.com/${org}/_apis/graph/users?api-version=7.1-preview.1`,
      {
        headers: {
          Authorization: `Basic ${b64}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.message || `Azure DevOps error ${response.status}` });
    }

    const data = await response.json();

    const members = (data.value || [])
      .filter(u => u.subjectKind === "user" && u.displayName && !u.displayName.includes("\\"))
      .map(u => ({
        id: u.descriptor,
        displayName: u.displayName,
        email: u.mailAddress || u.principalName || "",
      }));

    res.json({ members, count: members.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));