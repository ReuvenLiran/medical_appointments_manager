#!/usr/bin/env node
/**
 * Production ingestion pipeline: PDF → PII redaction → Entity extraction → DB storage
 * with proper entity resolution and deduplication.
 *
 * Usage:
 *   node ingest.mjs <path-to-pdf-or-directory> [--remove 1,3,4,6] [--dry-run] [--force]
 */
import "dotenv/config";
import { basename, join, resolve } from "path";
import { readdirSync, statSync, existsSync } from "fs";
import { processDocument, DEFAULT_REMOVE } from "./entity-extractor.mjs";
import { PII_CATEGORIES } from "pii-tools/lib/constants.mjs";
import { normalizeMedName, normalizeConditionName } from "./normalize.mjs";
import { runAllChecks } from "./health-graph.mjs";
import {
  initDB,
  upsertDocument,
  getDocumentByFilename,
  addMedication,
  discontinueMedication,
  findMedicationByNormalizedName,
  updateMedicationReview,
  addCondition,
  updateCondition,
  findConditionByNormalizedName,
  addRecommendation,
  deleteRecommendationsByDocId,
  deleteDocumentCascading,
  addEntityLink,
  syncAppointmentsFromJson,
  getActiveMedications,
  getActiveConditions,
  getPendingRecommendations,
  getFutureAppointments,
} from "./db.mjs";

// ─── CLI Argument Parsing ───────────────────────────────────────

const args = process.argv.slice(2);

const removeIdx = args.indexOf("--remove");
let categoriesToRemove = DEFAULT_REMOVE;
if (removeIdx !== -1 && args[removeIdx + 1]) {
  const indices = args[removeIdx + 1].split(",").map(Number);
  categoriesToRemove = indices
    .filter(i => i >= 0 && i < PII_CATEGORIES.length)
    .map(i => PII_CATEGORIES[i]);
  if (categoriesToRemove.length === 0) {
    console.error("Invalid --remove indices. Valid range: 0-" + (PII_CATEGORIES.length - 1));
    console.error("Categories:", PII_CATEGORIES.map((c, i) => `  ${i}: ${c}`).join("\n"));
    process.exit(1);
  }
}

const flags = {
  dryRun: args.includes("--dry-run"),
  force: args.includes("--force"),
};

const removeValueIdx = removeIdx !== -1 ? removeIdx + 1 : -1;
const inputPath = args.find((a, i) => !a.startsWith("--") && i !== removeValueIdx);
if (!inputPath) {
  console.error("Usage: node ingest.mjs <path-to-pdf-or-directory> [--remove 0,2,3,5,6] [--dry-run] [--force]");
  console.error("\nPII categories:");
  PII_CATEGORIES.forEach((c, i) => console.error(`  ${i}: ${c}`));
  process.exit(1);
}

// ─── Collect PDFs ───────────────────────────────────────────────

function collectPDFs(inputPath) {
  const resolved = resolve(inputPath);
  const stat = statSync(resolved);

  if (stat.isFile() && resolved.endsWith(".pdf")) {
    return [resolved];
  }

  if (stat.isDirectory()) {
    return readdirSync(resolved)
      .filter(f => f.endsWith(".pdf"))
      .map(f => join(resolved, f))
      .sort();
  }

  console.error(`Not a PDF file or directory: ${resolved}`);
  process.exit(1);
}

// ─── Entity Resolution ─────────────────────────────────────────

function resolveMedications(medications, specialty, docId, visitDate, stats) {
  for (const med of medications) {
    const { key } = normalizeMedName(med.name);
    const existing = findMedicationByNormalizedName(key);

    switch (med.action) {
      case "continue":
        if (existing) {
          updateMedicationReview(existing.id, {
            latest_doc_id: docId,
            notes: med.notes || existing.notes,
          });
          console.log(`  ↻ Medication continued: ${med.name} (id=${existing.id})`);
          stats.medsUpdated++;
        } else {
          // First time seeing this med with "continue" — insert it
          const id = addMedication({
            name: med.name,
            dosage: med.dosage ?? null,
            prescriber_specialty: specialty,
            started_from_doc_id: docId,
            started_date: visitDate,
            notes: med.notes ?? null,
          });
          console.log(`  + Medication added (first seen as continue): ${med.name} (id=${id})`);
          stats.medsAdded++;
        }
        break;

      case "new":
        if (existing) {
          // Already exists — update review instead of duplicating
          updateMedicationReview(existing.id, {
            latest_doc_id: docId,
            notes: med.notes || existing.notes,
          });
          console.log(`  ↻ Medication already exists, updated: ${med.name} (id=${existing.id})`);
          stats.medsUpdated++;
        } else {
          const id = addMedication({
            name: med.name,
            dosage: med.dosage ?? null,
            prescriber_specialty: specialty,
            started_from_doc_id: docId,
            started_date: visitDate,
            notes: med.notes ?? null,
          });
          console.log(`  + Medication added: ${med.name} (id=${id})`);
          stats.medsAdded++;
        }
        break;

      case "stop":
        if (existing) {
          discontinueMedication(existing.id, {
            docId,
            date: visitDate,
            newStatus: "discontinued",
          });
          console.log(`  ✕ Medication discontinued: ${med.name} (id=${existing.id})`);
          stats.medsDiscontinued++;
        } else {
          console.log(`  ? Medication to stop not found in DB: ${med.name}`);
        }
        break;

      case "change":
        if (existing) {
          discontinueMedication(existing.id, {
            docId,
            date: visitDate,
            newStatus: "changed",
          });
          console.log(`  ✕ Medication changed (old discontinued): ${existing.name} (id=${existing.id})`);
        }
        const newId = addMedication({
          name: med.name,
          dosage: med.dosage ?? null,
          prescriber_specialty: specialty,
          started_from_doc_id: docId,
          started_date: visitDate,
          notes: med.notes ?? `Changed from previous dosage`,
        });
        console.log(`  + Medication added (changed): ${med.name} ${med.dosage ?? ""} (id=${newId})`);
        stats.medsAdded++;
        break;

      default:
        console.log(`  ? Unknown medication action "${med.action}" for ${med.name}`);
    }
  }
}

function resolveConditions(conditions, specialty, docId, visitDate, stats) {
  const resolvedConditionIds = [];

  for (const cond of conditions) {
    const { key } = normalizeConditionName(cond.name);
    const existing = findConditionByNormalizedName(key);

    if (existing) {
      updateCondition(existing.id, {
        latest_doc_id: docId,
        status: cond.status,
        notes: cond.notes || existing.notes,
      });
      console.log(`  ↻ Condition updated: ${cond.name} [${cond.status}] (id=${existing.id})`);
      resolvedConditionIds.push(existing.id);
      stats.condsUpdated++;
    } else {
      const id = addCondition({
        name: cond.name,
        status: cond.status,
        diagnosing_specialty: specialty,
        first_doc_id: docId,
        latest_doc_id: docId,
        first_seen_date: visitDate,
        notes: cond.notes ?? null,
      });
      console.log(`  + Condition added: ${cond.name} [${cond.status}] (id=${id})`);
      resolvedConditionIds.push(id);
      stats.condsAdded++;
    }
  }

  return resolvedConditionIds;
}

function resolveRecommendations(entities, specialty, docId, stats) {
  // Delete previous recommendations from this document (idempotent)
  const deleted = deleteRecommendationsByDocId(docId);
  if (deleted.changes > 0) {
    console.log(`  ⌫ Removed ${deleted.changes} old recommendations from this document`);
  }

  const allRecs = [
    ...entities.recommendations,
    ...(entities.tests_ordered ?? []).map(t => ({
      type: "test",
      description: t.description,
      target_specialty: t.target_specialty,
      due_date: t.due_date,
    })),
  ];

  const recIds = [];
  for (const rec of allRecs) {
    const targetSpec = rec.target_specialty && rec.target_specialty.trim() ? rec.target_specialty.trim() : null;
    const id = addRecommendation({
      type: rec.type,
      description: rec.description,
      requesting_specialty: specialty,
      target_specialty: targetSpec,
      source_doc_id: docId,
      due_date: rec.due_date ?? null,
    });
    const targetLabel = targetSpec ? ` → ${targetSpec}` : "";
    console.log(`  + Recommendation: [${rec.type}] ${rec.description}${targetLabel} (id=${id})`);
    recIds.push(id);
    stats.recsAdded++;
  }

  return recIds;
}

function createEntityLinks(conditionIds, medications, specialty, docId) {
  // Link medications to conditions they treat (from same specialty context)
  const activeMeds = getActiveMedications().filter(
    m => m.prescriber_specialty === specialty
  );

  for (const condId of conditionIds) {
    for (const med of activeMeds) {
      try {
        addEntityLink({
          source_type: "medication",
          source_id: med.id,
          target_type: "condition",
          target_id: condId,
          relationship: "treats",
          specialty_context: specialty,
        });
      } catch {
        // Duplicate link — ignore
      }
    }
  }
}

// ─── Main Pipeline ──────────────────────────────────────────────

async function ingestPDF(pdfPath, stats) {
  const filename = basename(pdfPath);
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Processing: ${filename}`);
  console.log(`${"─".repeat(60)}`);

  // Check if already processed
  const existingDoc = getDocumentByFilename(filename);
  if (existingDoc && !flags.force) {
    console.log(`  ⏭ Already processed (id=${existingDoc.id}). Use --force to re-process.`);
    stats.skipped++;
    return;
  }

  // Force re-processing: cascade delete old entities
  if (existingDoc && flags.force) {
    console.log(`  ⌫ Force re-processing: clearing old entities for doc id=${existingDoc.id}`);
    deleteDocumentCascading(existingDoc.id);
  }

  if (flags.dryRun) {
    console.log("  [DRY RUN] Would process this document. Skipping extraction.");
    return;
  }

  // Run extraction pipeline
  const { redactedText, entities } = await processDocument(pdfPath, { categoriesToRemove });

  // Store document
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
  console.log(`  Document stored (id=${docId})`);
  console.log(`  Specialty: ${entities.specialty}`);
  console.log(`  Summary: ${entities.summary?.slice(0, 100)}...`);

  // Entity resolution
  console.log("\n  ── Medications ──");
  resolveMedications(
    entities.medications, entities.specialty, docId, entities.visit_date, stats
  );

  console.log("\n  ── Conditions ──");
  const conditionIds = resolveConditions(
    entities.conditions, entities.specialty, docId, entities.visit_date, stats
  );

  console.log("\n  ── Recommendations ──");
  resolveRecommendations(entities, entities.specialty, docId, stats);

  // Entity links
  createEntityLinks(conditionIds, entities.medications, entities.specialty, docId);

  stats.processed++;
}

async function main() {
  console.log("═".repeat(60));
  console.log("  HEALTH DATA INGESTION PIPELINE");
  console.log("═".repeat(60));

  if (flags.dryRun) console.log("  Mode: DRY RUN (no data will be saved)");
  if (flags.force) console.log("  Mode: FORCE (will re-process existing documents)");

  initDB();

  const pdfs = collectPDFs(inputPath);
  console.log(`\nFound ${pdfs.length} PDF(s) to process.`);

  const stats = {
    processed: 0,
    skipped: 0,
    medsAdded: 0,
    medsUpdated: 0,
    medsDiscontinued: 0,
    condsAdded: 0,
    condsUpdated: 0,
    recsAdded: 0,
  };

  for (const pdf of pdfs) {
    await ingestPDF(pdf, stats);
  }

  // Sync appointments
  const appointmentsPath = join(resolve("."), "appointments.json");
  if (existsSync(appointmentsPath) && !flags.dryRun) {
    console.log(`\n${"─".repeat(60)}`);
    console.log("Syncing appointments from appointments.json...");
    const count = syncAppointmentsFromJson(appointmentsPath);
    console.log(`  Synced ${count} appointments.`);
  }

  // Run intelligence checks
  if (!flags.dryRun && stats.processed > 0) {
    console.log(`\n${"═".repeat(60)}`);
    console.log("  HEALTH INTELLIGENCE CHECKS");
    console.log("═".repeat(60));
    await runAllChecks();
  }

  // Print summary
  console.log(`\n${"═".repeat(60)}`);
  console.log("  INGESTION SUMMARY");
  console.log("═".repeat(60));
  console.log(`  Documents processed: ${stats.processed}`);
  console.log(`  Documents skipped:   ${stats.skipped}`);
  console.log(`  Medications added:   ${stats.medsAdded}`);
  console.log(`  Medications updated: ${stats.medsUpdated}`);
  console.log(`  Medications stopped: ${stats.medsDiscontinued}`);
  console.log(`  Conditions added:    ${stats.condsAdded}`);
  console.log(`  Conditions updated:  ${stats.condsUpdated}`);
  console.log(`  Recommendations:     ${stats.recsAdded}`);

  // DB state overview
  console.log(`\n${"─".repeat(60)}`);
  console.log("  DATABASE STATE");
  console.log("─".repeat(60));
  const meds = getActiveMedications();
  console.log(`  Active medications: ${meds.length}`);
  for (const m of meds) console.log(`    - ${m.name} ${m.dosage ?? ""} (${m.prescriber_specialty})`);

  const conds = getActiveConditions();
  console.log(`  Active conditions: ${conds.length}`);
  for (const c of conds) console.log(`    - ${c.name} [${c.status}] (${c.diagnosing_specialty ?? "?"})`);

  const recs = getPendingRecommendations();
  console.log(`  Pending recommendations: ${recs.length}`);
  for (const r of recs) console.log(`    - [${r.type}] ${r.description}`);

  const apts = getFutureAppointments();
  console.log(`  Future appointments: ${apts.length}`);
  for (const a of apts) console.log(`    - ${a.appointment_date} ${a.appointment_time ?? ""} ${a.appointment_type}`);

  console.log("\n" + "═".repeat(60));
  console.log("  DONE");
  console.log("═".repeat(60));
}

main().catch(err => {
  console.error("Pipeline error:", err);
  process.exit(1);
});
