/**
 * Cross-specialty health intelligence module.
 * Drug interaction checking, condition-treatment conflict detection,
 * recommendation-to-appointment matching, and cross-specialty awareness.
 */
import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  initDB,
  getActiveMedications,
  getActiveConditions,
  getPendingRecommendations,
  getFutureAppointments,
  getUnmatchedRecommendations,
  matchRecommendationToAppointment,
  addAlert,
  addEntityLink,
} from "./db.mjs";
import { normalizeMedName } from "./normalize.mjs";

// ─── Gemini Setup ───────────────────────────────────────────────

let _geminiModel = null;
function getGeminiModel() {
  if (_geminiModel) return _geminiModel;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const genAI = new GoogleGenerativeAI(apiKey);
  _geminiModel = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview",
  });
  return _geminiModel;
}

// ─── Known Drug Interactions ────────────────────────────────────
// Hardcoded interactions relevant to the patient's medication profile.
// Each entry: [drugKeyA, drugKeyB, severity, description]

const KNOWN_INTERACTIONS = [
  ["prednisone", "imuran", "warning",
    "Prednisone + Imuran: combined immunosuppression increases infection risk. Monitor CBC and liver function."],
  ["prednisone", "tysabri", "warning",
    "Prednisone + Tysabri: double immunosuppression. Risk of PML and opportunistic infections."],
  ["imuran", "tysabri", "critical",
    "Imuran + Tysabri: concurrent use is contraindicated due to severe immunosuppression risk."],
  ["prednisone", "nsaids", "warning",
    "Prednisone + NSAIDs: increased risk of GI bleeding and ulcers."],
  ["copaxone", "tysabri", "info",
    "Copaxone → Tysabri switch: ensure adequate washout period between immunomodulators."],
  ["imuran", "ocrevus", "critical",
    "Imuran + Ocrevus: concurrent immunosuppressants contraindicated with anti-CD20 therapy."],
  ["prednisone", "prednisolone", "info",
    "Prednisone and Prednisolone are the same corticosteroid — verify intended prescription."],
];

/**
 * Check active medications for known drug interactions,
 * then optionally run a Gemini supplementary check for interactions
 * not covered by the hardcoded rules.
 */
export async function checkDrugInteractions() {
  initDB();
  const meds = getActiveMedications();
  const alerts = [];

  // Build a set of normalized medication keys
  const medKeys = new Map(); // key → medication record
  for (const med of meds) {
    const { key } = normalizeMedName(med.name);
    medKeys.set(key, med);
  }

  // Phase 1: Hardcoded rules
  const checkedPairs = new Set();
  for (const [keyA, keyB, severity, description] of KNOWN_INTERACTIONS) {
    const medA = medKeys.get(keyA);
    const medB = medKeys.get(keyB);

    if (medA && medB) {
      checkedPairs.add(`${keyA}::${keyB}`);
      const alertId = addAlert({
        alert_type: "drug_interaction",
        severity,
        description,
        related_entity_ids: [medA.id, medB.id],
      });

      try {
        addEntityLink({
          source_type: "medication",
          source_id: medA.id,
          target_type: "medication",
          target_id: medB.id,
          relationship: "interacts_with",
          specialty_context: medA.prescriber_specialty,
        });
      } catch {
        // Duplicate link — ignore
      }

      alerts.push({ alertId, severity, description });
      console.log(`  ⚠ [${severity.toUpperCase()}] ${description}`);
    }
  }

  // Phase 2: Gemini supplementary check (when 2+ active meds)
  if (meds.length >= 2) {
    const model = getGeminiModel();
    if (model) {
      try {
        const geminiAlerts = await geminiDrugInteractionCheck(meds, checkedPairs);
        for (const ga of geminiAlerts) {
          const alertId = addAlert({
            alert_type: "drug_interaction",
            severity: ga.severity,
            description: ga.description,
            related_entity_ids: ga.relatedIds,
          });
          alerts.push({ alertId, severity: ga.severity, description: ga.description });
          console.log(`  ⚠ [${ga.severity.toUpperCase()}] (Gemini) ${ga.description}`);
        }
      } catch (err) {
        console.log(`  ⚠ Gemini interaction check failed: ${err.message}`);
      }
    }
  }

  if (alerts.length === 0) {
    console.log("  ✓ No drug interactions detected.");
  }

  return alerts;
}

/**
 * Send active medications to Gemini for supplementary interaction analysis.
 * Skips pairs already covered by hardcoded rules.
 */
async function geminiDrugInteractionCheck(meds, checkedPairs) {
  const model = getGeminiModel();
  if (!model) return [];

  const medList = meds.map(m =>
    `- ${m.name} ${m.dosage ?? ""} (prescribed by ${m.prescriber_specialty})`
  ).join("\n");

  const alreadyChecked = checkedPairs.size > 0
    ? `\nAlready flagged pairs (skip these): ${[...checkedPairs].join(", ")}`
    : "";

  const prompt = `You are a clinical pharmacist. Given these active medications from different specialists, identify drug-drug interactions, therapeutic duplications, or safety concerns.
${alreadyChecked}

Active medications:
${medList}

Return a JSON array (empty if no concerns). Each item:
{"severity": "info|warning|critical", "drugs": ["DrugA", "DrugB"], "description": "Explanation in English"}

Only return interactions NOT already listed above. Return [] if none found.`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) parsed = JSON.parse(match[0]);
    else return [];
  }

  if (!Array.isArray(parsed)) return [];

  // Map drug names back to medication IDs
  return parsed.filter(item => item.severity && item.description).map(item => {
    const relatedIds = (item.drugs ?? [])
      .map(name => {
        const { key } = normalizeMedName(name);
        return meds.find(m => normalizeMedName(m.name).key === key)?.id;
      })
      .filter(Boolean);
    return {
      severity: ["info", "warning", "critical"].includes(item.severity) ? item.severity : "info",
      description: item.description,
      relatedIds,
    };
  });
}

// ─── Condition-Treatment Conflict Detection ─────────────────────

/**
 * Check for conflicts between active conditions managed by one specialty
 * and medications prescribed by a different specialty.
 * E.g., a drug that affects liver function when a hepatologist is monitoring liver disease.
 */
export async function checkConditionConflicts() {
  initDB();
  const meds = getActiveMedications();
  const conds = getActiveConditions();
  const alerts = [];

  if (meds.length === 0 || conds.length === 0) {
    console.log("  ✓ No condition-treatment conflicts to check.");
    return alerts;
  }

  // Only check cross-specialty pairs
  const crossSpecialtyPairs = [];
  for (const med of meds) {
    for (const cond of conds) {
      if (cond.diagnosing_specialty && med.prescriber_specialty !== cond.diagnosing_specialty) {
        crossSpecialtyPairs.push({ med, cond });
      }
    }
  }

  if (crossSpecialtyPairs.length === 0) {
    console.log("  ✓ No cross-specialty medication-condition pairs to check.");
    return alerts;
  }

  const model = getGeminiModel();
  if (!model) {
    console.log("  ⚠ Gemini not available — skipping condition-treatment conflict check.");
    return alerts;
  }

  const pairsText = crossSpecialtyPairs.map(({ med, cond }) =>
    `- Medication "${med.name}" ${med.dosage ?? ""} (${med.prescriber_specialty}) vs Condition "${cond.name}" [${cond.status}] (${cond.diagnosing_specialty})`
  ).join("\n");

  const prompt = `You are a clinical safety reviewer. Check if any of these medications could adversely affect the listed conditions, considering they are managed by different specialists who may not be coordinating.

${pairsText}

Return a JSON array of conflicts found (empty array if none). Each item:
{"severity": "info|warning|critical", "medication": "name", "condition": "name", "description": "Explanation in English"}

Focus on clinically significant conflicts only. Return [] if none found.`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) parsed = JSON.parse(match[0]);
      else return alerts;
    }

    if (!Array.isArray(parsed)) return alerts;

    for (const item of parsed) {
      if (!item.description) continue;
      const severity = ["info", "warning", "critical"].includes(item.severity) ? item.severity : "info";

      const relatedMed = meds.find(m => m.name.includes(item.medication));
      const relatedCond = conds.find(c => c.name.includes(item.condition));
      const relatedIds = [relatedMed?.id, relatedCond?.id].filter(Boolean);

      const alertId = addAlert({
        alert_type: "condition_conflict",
        severity,
        description: `Condition-treatment conflict: ${item.description}`,
        related_entity_ids: relatedIds,
      });

      alerts.push({ alertId, severity, description: item.description });
      console.log(`  ⚠ [${severity.toUpperCase()}] ${item.description}`);
    }
  } catch (err) {
    console.log(`  ⚠ Gemini condition conflict check failed: ${err.message}`);
  }

  if (alerts.length === 0) {
    console.log("  ✓ No condition-treatment conflicts detected.");
  }

  return alerts;
}

// ─── Recommendation-to-Appointment Matching ─────────────────────

/**
 * Match pending recommendations to future appointments via Gemini.
 * Sends all recommendations and appointments in a single prompt and
 * lets Gemini decide the best matches.
 */
export async function matchRecommendationsToAppointments() {
  initDB();
  const recs = getPendingRecommendations();
  const apts = getFutureAppointments();
  const matches = [];

  if (recs.length === 0) {
    console.log("  No pending recommendations to match.");
    return matches;
  }
  if (apts.length === 0) {
    console.log("  No future appointments to match against.");
    return matches;
  }

  const model = getGeminiModel();
  if (!model) {
    console.log("  ⚠ Gemini not available — cannot match recommendations to appointments.");
    return matches;
  }

  const recsText = recs.map((r, i) =>
    `  R${i}: [${r.type}] ${r.description} (from ${r.requesting_specialty}${r.target_specialty ? `, target: ${r.target_specialty}` : ""}${r.due_date ? `, due: ${r.due_date}` : ""})`
  ).join("\n");

  const aptsText = apts.map((a, i) =>
    `  A${i}: ${a.appointment_date}${a.appointment_time ? " " + a.appointment_time : ""} — ${a.appointment_type}${a.service ? " / " + a.service : ""} at ${a.location ?? "unknown"}`
  ).join("\n");

  const prompt = `You are a medical scheduling assistant. Match each recommendation to the most appropriate upcoming appointment, if one exists.

Each recommendation has a "from" (who wrote it) and optionally a "target" (which specialty should fulfill it). Use target_specialty to guide matching — e.g., a recommendation with target: עיניים should match ophthalmology appointments, not neurology.

Important matching rules:
- A general referral like "המשך מעקב" (continue follow-up) at some clinic should NEVER be matched to any appointment. These are ongoing care instructions, not specific schedulable actions. Only match recommendations that describe a specific test, procedure, or a concrete follow-up visit ordered by the authoring doctor.
- Only match a recommendation to an appointment if the recommendation describes a specific action that the appointment directly fulfills (e.g., "MRI מוח" → brain MRI appointment, "OCT" → OCT appointment, "ביקורת במרפאת גלאוקומה" → glaucoma clinic visit).
- Each test recommendation should match exactly ONE appointment (the most specific match).
- When multiple similar appointments exist (e.g., two OCT exams on different dates), use the due_date to pick the one closest in time. The due_date reflects when the ordering doctor intended the test to be done.
- Do NOT match a referral/follow_up from specialty A to an appointment that was clearly scheduled by specialty B for its own purposes.

Recommendations:
${recsText}

Appointments:
${aptsText}

Return a JSON array of matches. Each item: {"rec": <R index>, "apt": <A index>, "reason": "brief explanation"}
Only include matches where the appointment clearly fulfills the recommendation.
If a recommendation has no matching appointment, omit it. Return [] if no matches.`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) parsed = JSON.parse(match[0]);
      else {
        console.log("  ⚠ Could not parse Gemini matching response.");
        return matches;
      }
    }

    if (!Array.isArray(parsed)) return matches;

    for (const item of parsed) {
      // Handle both numeric (0) and prefixed string ("R0") formats
      const parseIdx = (val) => {
        if (typeof val === "number") return val;
        if (typeof val === "string") return parseInt(val.replace(/^[RA]/i, ""), 10);
        return NaN;
      };
      const recIdx = parseIdx(item.rec);
      const aptIdx = parseIdx(item.apt);
      if (isNaN(recIdx) || isNaN(aptIdx)) continue;
      if (recIdx < 0 || recIdx >= recs.length || aptIdx < 0 || aptIdx >= apts.length) continue;

      const rec = recs[recIdx];
      const apt = apts[aptIdx];

      matchRecommendationToAppointment(rec.id, apt.id, item.reason);
      matches.push({
        recId: rec.id,
        aptId: apt.id,
        recDescription: rec.description,
        aptType: apt.appointment_type,
        aptDate: apt.appointment_date,
        reason: item.reason ?? "",
      });
      console.log(`  ✓ Matched: "${rec.description}" → ${apt.appointment_type} (${apt.appointment_date})`);
      if (item.reason) console.log(`    Reason: ${item.reason}`);
    }
  } catch (err) {
    console.log(`  ⚠ Gemini recommendation matching failed: ${err.message}`);
  }

  if (matches.length === 0) {
    console.log("  No recommendation-to-appointment matches found.");
  }

  return matches;
}

/**
 * Find pending recommendations with no matching appointment and create alerts.
 */
export function findAndAlertUnmatchedRecommendations() {
  initDB();
  const unmatched = getUnmatchedRecommendations();
  const alerts = [];

  for (const rec of unmatched) {
    const alertId = addAlert({
      alert_type: "unmatched_recommendation",
      severity: "info",
      description: `Unmatched recommendation from ${rec.requesting_specialty}: [${rec.type}] ${rec.description}`,
      related_entity_ids: [rec.id],
    });
    alerts.push({ alertId, rec });
    console.log(`  ! Unmatched: [${rec.type}] ${rec.description} (${rec.requesting_specialty})`);
  }

  if (alerts.length === 0) {
    console.log("  ✓ All recommendations are matched to appointments.");
  }

  return alerts;
}

/**
 * Check for cross-specialty medication overlaps.
 * When a medication is prescribed by Specialty A and mentioned/modified by Specialty B,
 * create both an entity_link and an info-level alert.
 */
export function crossSpecialtyCheck() {
  initDB();
  const meds = getActiveMedications();
  const alerts = [];

  // Group medications by normalized name
  const medsByKey = new Map();
  for (const med of meds) {
    const { key } = normalizeMedName(med.name);
    if (!medsByKey.has(key)) medsByKey.set(key, []);
    medsByKey.get(key).push(med);
  }

  // Find medications mentioned by multiple specialties
  for (const [key, medGroup] of medsByKey) {
    const specialties = [...new Set(medGroup.map(m => m.prescriber_specialty))];
    if (specialties.length > 1) {
      const description =
        `Cross-specialty overlap: "${medGroup[0].name}" is managed by multiple specialties: ${specialties.join(", ")}. ` +
        `Ensure coordinated care.`;

      const alertId = addAlert({
        alert_type: "condition_conflict",
        severity: "info",
        description,
        related_entity_ids: medGroup.map(m => m.id),
      });

      // Create entity links between the cross-specialty instances
      for (let i = 0; i < medGroup.length - 1; i++) {
        try {
          addEntityLink({
            source_type: "medication",
            source_id: medGroup[i].id,
            target_type: "medication",
            target_id: medGroup[i + 1].id,
            relationship: "mentioned_in",
            specialty_context: medGroup[i + 1].prescriber_specialty,
          });
        } catch {
          // Duplicate link
        }
      }

      alerts.push({ alertId, description });
      console.log(`  ⚠ ${description}`);
    }
  }

  if (alerts.length === 0) {
    console.log("  ✓ No cross-specialty medication overlaps detected.");
  }

  return alerts;
}

/**
 * Run all intelligence checks. Called from ingest.mjs after entity resolution.
 */
export async function runAllChecks() {
  console.log("\n── Drug Interaction Check ──");
  const interactions = await checkDrugInteractions();

  console.log("\n── Condition-Treatment Conflict Check ──");
  const conditionConflicts = await checkConditionConflicts();

  console.log("\n── Recommendation Matching ──");
  const matches = await matchRecommendationsToAppointments();

  console.log("\n── Unmatched Recommendations ──");
  const unmatched = findAndAlertUnmatchedRecommendations();

  console.log("\n── Cross-Specialty Check ──");
  const crossSpecialty = crossSpecialtyCheck();

  return { interactions, conditionConflicts, matches, unmatched, crossSpecialty };
}
