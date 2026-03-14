#!/usr/bin/env node
/**
 * Full pipeline test: PDF → PII redaction → Entity extraction → DB storage
 */
import "dotenv/config";
import { basename } from "path";
import { processDocument } from "./entity-extractor.mjs";
import {
  initDB,
  upsertDocument,
  addMedication,
  addCondition,
  addRecommendation,
  getActiveMedications,
  getActiveConditions,
  getPendingRecommendations,
} from "./db.mjs";

const pdfPath = process.argv[2] || "medical_summaries/סיכום נוירולוג 21-12-2025.pdf";

console.log("═".repeat(60));
console.log("  FULL PIPELINE TEST");
console.log("═".repeat(60));
console.log(`\nInput: ${pdfPath}\n`);

// Step 1-3: Extract text, detect/redact PII, extract entities
console.log("── Step 1-3: PDF → PII Redaction → Entity Extraction ──\n");
const { redactedText, entities } = await processDocument(pdfPath);

console.log("\n── Extracted Entities ──\n");
console.log(JSON.stringify(entities, null, 2));

// Step 4: Store in DB
console.log("\n── Step 4: Storing in Database ──\n");
const db = initDB();
console.log("Database initialized.");

const filename = basename(pdfPath);
const docId = upsertDocument({
  filename,
  source_path: pdfPath,
  specialty: entities.specialty,
  doctor_name: entities.doctor_name ?? null,
  visit_date: entities.visit_date ?? null,
  redacted_text: redactedText,
  summary: entities.summary,
  raw_entities_json: entities,
});
console.log(`Document stored (id=${docId})`);

// Store medications
for (const med of entities.medications) {
  const medId = addMedication({
    name: med.name,
    dosage: med.dosage ?? null,
    prescriber_specialty: entities.specialty,
    started_from_doc_id: docId,
    started_date: entities.visit_date ?? null,
    notes: med.notes ?? `action: ${med.action}`,
  });
  console.log(`  Medication: ${med.name} (id=${medId}, action=${med.action})`);
}

// Store conditions
for (const cond of entities.conditions) {
  const condId = addCondition({
    name: cond.name,
    status: cond.status,
    diagnosing_specialty: entities.specialty,
    first_doc_id: docId,
    latest_doc_id: docId,
    first_seen_date: entities.visit_date ?? null,
    notes: cond.notes ?? null,
  });
  console.log(`  Condition: ${cond.name} (id=${condId}, status=${cond.status})`);
}

// Store recommendations
for (const rec of entities.recommendations) {
  const recId = addRecommendation({
    type: rec.type,
    description: rec.description,
    requesting_specialty: entities.specialty,
    source_doc_id: docId,
    due_date: rec.due_date ?? null,
  });
  console.log(`  Recommendation: ${rec.description} (id=${recId}, type=${rec.type})`);
}

// Verify DB state
console.log("\n── Database Summary ──\n");

const meds = getActiveMedications();
console.log(`Active medications: ${meds.length}`);
for (const m of meds) {
  console.log(`  - ${m.name} ${m.dosage ?? ""} (${m.prescriber_specialty})`);
}

const conds = getActiveConditions();
console.log(`Active/monitoring conditions: ${conds.length}`);
for (const c of conds) {
  console.log(`  - ${c.name} [${c.status}] (${c.diagnosing_specialty ?? "unknown"})`);
}

const recs = getPendingRecommendations();
console.log(`Pending recommendations: ${recs.length}`);
for (const r of recs) {
  console.log(`  - [${r.type}] ${r.description} (${r.requesting_specialty})`);
}

console.log("\n" + "═".repeat(60));
console.log("  PIPELINE TEST COMPLETE");
console.log("═".repeat(60));
