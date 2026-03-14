#!/usr/bin/env node
/**
 * API server for ShebaConnect web dashboard.
 * Serves JSON API endpoints and static files from web/dist.
 *
 * Usage: node server.mjs
 */
import "dotenv/config";
import { createServer } from "http";
import { readFileSync, existsSync, createReadStream } from "fs";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import {
  initDB,
  getActiveMedications,
  getActiveConditions,
  getPendingRecommendations,
  getUnmatchedRecommendations,
  getFutureAppointments,
  getAllAppointments,
  getUnresolvedAlerts,
  getRecentDocuments,
  searchDocuments,
  getMatchesForAppointment,
  getMatchesForRecommendation,
  getMedicationHistory,
  syncAppointmentsFromJson,
} from "./db.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const DIST_DIR = join(__dirname, "web", "dist");

initDB();

// ─── Helpers ────────────────────────────────────────────────────

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function error(res, msg, status = 400) {
  json(res, { error: msg }, status);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function serveStatic(res, filePath) {
  if (!existsSync(filePath)) return false;
  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  createReadStream(filePath).pipe(res);
  return true;
}

// ─── Routes ─────────────────────────────────────────────────────

const routes = {
  "GET /api/medications": () => getActiveMedications(),

  "GET /api/medications/all": () => {
    const db = initDB();
    return db.prepare(`
      SELECT m.*, s.name AS prescriber_specialty
      FROM medications m
      JOIN specialties s ON m.prescriber_specialty_id = s.id
      ORDER BY m.status ASC, m.name ASC
    `).all();
  },

  "GET /api/medications/history/:name": (_body, params) => {
    return getMedicationHistory(decodeURIComponent(params.name));
  },

  "GET /api/conditions": () => getActiveConditions(),

  "GET /api/recommendations": () => getPendingRecommendations(),

  "GET /api/recommendations/unmatched": () => getUnmatchedRecommendations(),

  "GET /api/recommendations/:id/matches": (_body, params) => {
    return getMatchesForRecommendation(Number(params.id));
  },

  "GET /api/appointments": () => getAllAppointments(),

  "GET /api/appointments/future": () => getFutureAppointments(),

  "GET /api/appointments/:id/matches": (_body, params) => {
    return getMatchesForAppointment(Number(params.id));
  },

  "GET /api/alerts": () => getUnresolvedAlerts(),

  "POST /api/alerts/:id/resolve": (_body, params) => {
    const db = initDB();
    db.prepare("UPDATE alerts SET resolved = 1 WHERE id = ?").run(Number(params.id));
    return { ok: true };
  },

  "GET /api/documents": () => getRecentDocuments(20),

  "GET /api/search": (_body, _params, query) => {
    const q = query.get("q");
    if (!q) return [];
    try {
      return searchDocuments(q);
    } catch {
      return [];
    }
  },

  "POST /api/ask": async (body) => {
    const { question } = body;
    if (!question) return { error: "No question provided" };

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return { error: "GEMINI_API_KEY not configured" };

    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(apiKey);
    const modelName = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview";
    const model = genAI.getGenerativeModel({ model: modelName });

    const meds = getActiveMedications();
    const conds = getActiveConditions();
    const recs = getPendingRecommendations();
    const apts = getFutureAppointments();
    const docs = getRecentDocuments(5);

    const context = buildContext(meds, conds, recs, apts, docs);

    const prompt = `אתה עוזר רפואי חכם. יש לך גישה לנתונים הרפואיים הבאים של המטופל.
ענה על השאלה בעברית בצורה ברורה ומפורטת. אם אתה לא בטוח, ציין זאת.

── נתוני המטופל ──
${context}

── השאלה ──
${question}

── התשובה ──`;

    const result = await model.generateContent(prompt);
    return { answer: result.response.text() };
  },

  "POST /api/sync": () => {
    const jsonPath = join(__dirname, "appointments.json");
    if (!existsSync(jsonPath)) return { error: "appointments.json not found" };
    const count = syncAppointmentsFromJson(jsonPath);
    return { ok: true, count };
  },
};

function buildContext(meds, conds, recs, apts, docs) {
  const parts = [];
  if (meds.length > 0) {
    parts.push("תרופות פעילות:");
    for (const m of meds) parts.push(`  - ${m.name} ${m.dosage ?? ""} (${m.prescriber_specialty})`);
  }
  if (conds.length > 0) {
    parts.push("\nמצבים רפואיים:");
    for (const c of conds) parts.push(`  - ${c.name} [${c.status}] (${c.diagnosing_specialty ?? ""})`);
  }
  if (recs.length > 0) {
    parts.push("\nהמלצות בהמתנה:");
    for (const r of recs) parts.push(`  - [${r.type}] ${r.description} (${r.requesting_specialty})`);
  }
  if (apts.length > 0) {
    parts.push("\nתורים עתידיים:");
    for (const a of apts) {
      const time = a.appointment_time ? ` ${a.appointment_time}` : "";
      parts.push(`  - ${a.appointment_date}${time} ${a.appointment_type} (${a.location ?? ""})`);
    }
  }
  if (docs.length > 0) {
    parts.push("\nסיכומי ביקורים אחרונים:");
    for (const d of docs) {
      if (d.summary) parts.push(`  [${d.visit_date ?? "?"}] ${d.specialty ?? ""}: ${d.summary.slice(0, 200)}`);
    }
  }
  return parts.join("\n");
}

// ─── Route Matching ─────────────────────────────────────────────

function matchRoute(method, pathname) {
  for (const routeKey of Object.keys(routes)) {
    const [routeMethod, routePattern] = routeKey.split(" ", 2);
    if (routeMethod !== method) continue;

    const routeParts = routePattern.split("/");
    const pathParts = pathname.split("/");
    if (routeParts.length !== pathParts.length) continue;

    const params = {};
    let match = true;
    for (let i = 0; i < routeParts.length; i++) {
      if (routeParts[i].startsWith(":")) {
        params[routeParts[i].slice(1)] = pathParts[i];
      } else if (routeParts[i] !== pathParts[i]) {
        match = false;
        break;
      }
    }
    if (match) return { handler: routes[routeKey], params };
  }
  return null;
}

// ─── Server ─────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  // CORS for dev
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // API routes
  if (pathname.startsWith("/api")) {
    const matched = matchRoute(req.method, pathname);
    if (matched) {
      try {
        const body = req.method === "POST" ? await parseBody(req) : {};
        const result = await matched.handler(body, matched.params, url.searchParams);
        json(res, result);
      } catch (err) {
        console.error("API error:", err);
        error(res, err.message, 500);
      }
    } else {
      error(res, "Not found", 404);
    }
    return;
  }

  // Static file serving (production build)
  if (existsSync(DIST_DIR)) {
    const filePath = join(DIST_DIR, pathname === "/" ? "index.html" : pathname);
    if (serveStatic(res, filePath)) return;
    // SPA fallback
    if (serveStatic(res, join(DIST_DIR, "index.html"))) return;
  }

  error(res, "Not found", 404);
});

server.listen(PORT, () => {
  console.log(`ShebaConnect API server running on http://localhost:${PORT}`);
});
