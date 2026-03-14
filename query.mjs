#!/usr/bin/env node
/**
 * Health data query tool: FTS5 search and Gemini-powered semantic queries.
 *
 * Usage:
 *   node query.mjs search "טרשת נפוצה"
 *   node query.mjs ask "מה הקשר בין התרופות שלי ללחץ העיני?"
 */
import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  initDB,
  searchDocuments,
  getActiveMedications,
  getActiveConditions,
  getPendingRecommendations,
  getFutureAppointments,
  getRecentDocuments,
} from "./db.mjs";

const [, , mode, ...queryParts] = process.argv;
const query = queryParts.join(" ");

if (!mode || !query) {
  console.error("Usage:");
  console.error('  node query.mjs search "search term"');
  console.error('  node query.mjs ask "your question in Hebrew or English"');
  process.exit(1);
}

initDB();

if (mode === "search") {
  runSearch(query);
} else if (mode === "ask") {
  await runAsk(query);
} else {
  console.error(`Unknown mode: "${mode}". Use "search" or "ask".`);
  process.exit(1);
}

// ─── FTS5 Search ────────────────────────────────────────────────

function runSearch(query) {
  console.log(`\nSearching for: "${query}"\n`);

  try {
    const results = searchDocuments(query);

    if (results.length === 0) {
      console.log("No documents found matching your query.");
      return;
    }

    console.log(`Found ${results.length} document(s):\n`);

    for (const doc of results) {
      console.log(`  ── ${doc.filename} ──`);
      if (doc.specialty) console.log(`  Specialty: ${doc.specialty}`);
      if (doc.visit_date) console.log(`  Date: ${doc.visit_date}`);
      if (doc.doctor_name) console.log(`  Doctor: ${doc.doctor_name}`);
      if (doc.summary) {
        console.log(`  Summary:`);
        console.log(`    ${doc.summary.replace(/\n/g, "\n    ")}`);
      }
      console.log();
    }
  } catch (err) {
    if (err.message.includes("fts5")) {
      console.error("FTS5 query syntax error. Try simpler search terms.");
      console.error("Tip: Use plain words, not special characters.");
    } else {
      throw err;
    }
  }
}

// ─── Gemini Semantic Query ──────────────────────────────────────

async function runAsk(question) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Set GEMINI_API_KEY in .env to use semantic queries.");
    process.exit(1);
  }

  console.log(`\nQuestion: "${question}"\n`);
  console.log("Gathering health context...");

  // Collect context from DB
  const meds = getActiveMedications();
  const conds = getActiveConditions();
  const recs = getPendingRecommendations();
  const apts = getFutureAppointments();
  const docs = getRecentDocuments(5);

  const context = buildContext(meds, conds, recs, apts, docs);

  console.log("Sending to Gemini...\n");

  const genAI = new GoogleGenerativeAI(apiKey);
  const modelName = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview";
  const model = genAI.getGenerativeModel({ model: modelName });

  const prompt = `אתה עוזר רפואי חכם. יש לך גישה לנתונים הרפואיים הבאים של המטופל.
ענה על השאלה בעברית בצורה ברורה ומפורטת. אם אתה לא בטוח, ציין זאת.

── נתוני המטופל ──
${context}

── השאלה ──
${question}

── התשובה ──`;

  const result = await model.generateContent(prompt);
  const answer = result.response.text();

  console.log("─".repeat(60));
  console.log(answer);
  console.log("─".repeat(60));
}

function buildContext(meds, conds, recs, apts, docs) {
  const parts = [];

  if (meds.length > 0) {
    parts.push("תרופות פעילות:");
    for (const m of meds) {
      parts.push(`  - ${m.name} ${m.dosage ?? ""} (${m.prescriber_specialty})`);
    }
  }

  if (conds.length > 0) {
    parts.push("\nמצבים רפואיים:");
    for (const c of conds) {
      parts.push(`  - ${c.name} [${c.status}] (${c.diagnosing_specialty ?? ""})`);
    }
  }

  if (recs.length > 0) {
    parts.push("\nהמלצות בהמתנה:");
    for (const r of recs) {
      parts.push(`  - [${r.type}] ${r.description} (${r.requesting_specialty})`);
    }
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
      if (d.summary) {
        parts.push(`  [${d.visit_date ?? "?"}] ${d.specialty ?? ""}: ${d.summary.slice(0, 200)}`);
      }
    }
  }

  return parts.join("\n");
}
