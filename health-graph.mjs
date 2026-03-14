/**
 * Cross-specialty health intelligence module.
 * Drug interaction checking, recommendation-to-appointment matching,
 * and cross-specialty awareness.
 */
import {
  initDB,
  getActiveMedications,
  getPendingRecommendations,
  getFutureAppointments,
  getUnmatchedRecommendations,
  matchRecommendationToAppointment,
  addAlert,
  addEntityLink,
} from "./db.mjs";
import { normalizeMedName } from "./normalize.mjs";

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
 * Check active medications for known drug interactions.
 * Returns array of generated alerts.
 */
export function checkDrugInteractions() {
  initDB();
  const meds = getActiveMedications();
  const alerts = [];

  // Build a set of normalized medication keys
  const medKeys = new Map(); // key → medication record
  for (const med of meds) {
    const { key } = normalizeMedName(med.name);
    medKeys.set(key, med);
  }

  for (const [keyA, keyB, severity, description] of KNOWN_INTERACTIONS) {
    const medA = medKeys.get(keyA);
    const medB = medKeys.get(keyB);

    if (medA && medB) {
      const alertId = addAlert({
        alert_type: "drug_interaction",
        severity,
        description,
        related_entity_ids: [medA.id, medB.id],
      });

      // Create entity link
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

  if (alerts.length === 0) {
    console.log("  ✓ No drug interactions detected.");
  }

  return alerts;
}

// ─── Recommendation-to-Appointment Matching ─────────────────────

// Keyword matching rules: recommendation keywords → appointment keywords
const MATCH_RULES = [
  { recKeywords: ["mri", "MRI"], aptKeywords: ["MRI", "mri"] },
  { recKeywords: ["עיניים", "רשתית", "גלאוקומה", "נוירואופטלמולוגיה", "oct", "OCT"],
    aptKeywords: ["עיניים", "רשתית", "גלאוקומה", "דימות עיניים", "O.C.T"] },
  { recKeywords: ["דם", "blood", "בדיקת דם", "CBC", "ספירת דם"],
    aptKeywords: ["מעבדה", "דם", "blood"] },
  { recKeywords: ["נוירולוג", "טרשת"],
    aptKeywords: ["נוירולוג", "טרשת נפוצה", "מרכז לטרשת"] },
];

function textContainsAny(text, keywords) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw.toLowerCase()));
}

/**
 * Match pending recommendations to future appointments.
 * Returns array of { recId, aptId, recDescription, aptType }.
 */
export function matchRecommendationsToAppointments() {
  initDB();
  const recs = getPendingRecommendations();
  const apts = getFutureAppointments();
  const matches = [];

  for (const rec of recs) {
    for (const apt of apts) {
      const aptText = [apt.appointment_type, apt.service, apt.location].join(" ");
      const recText = rec.description;

      let matched = false;

      for (const rule of MATCH_RULES) {
        if (textContainsAny(recText, rule.recKeywords) &&
            textContainsAny(aptText, rule.aptKeywords)) {
          matched = true;
          break;
        }
      }

      if (matched) {
        matchRecommendationToAppointment(rec.id, apt.id);
        matches.push({
          recId: rec.id,
          aptId: apt.id,
          recDescription: rec.description,
          aptType: apt.appointment_type,
          aptDate: apt.appointment_date,
        });
        console.log(`  ✓ Matched: "${rec.description}" → ${apt.appointment_type} (${apt.appointment_date})`);
        break; // One match per recommendation
      }
    }
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
export function runAllChecks() {
  console.log("\n── Drug Interaction Check ──");
  const interactions = checkDrugInteractions();

  console.log("\n── Recommendation Matching ──");
  const matches = matchRecommendationsToAppointments();

  console.log("\n── Unmatched Recommendations ──");
  const unmatched = findAndAlertUnmatchedRecommendations();

  console.log("\n── Cross-Specialty Check ──");
  const crossSpecialty = crossSpecialtyCheck();

  return { interactions, matches, unmatched, crossSpecialty };
}
