/**
 * Hebrew/English medical entity normalization utilities.
 * Pure functions — no external dependencies.
 */

// ─── Drug Aliases ───────────────────────────────────────────────
// Curated map: Hebrew drug name → canonical English lowercase key.
// Add entries as new medications appear in documents.

export const DRUG_ALIASES = new Map([
  ["טיסברי", "tysabri"],
  ["נטליזומאב", "tysabri"],
  ["קופקסון", "copaxone"],
  ["גלטיראמר", "copaxone"],
  ["אימוראן", "imuran"],
  ["אזתיופרין", "imuran"],
  ["פרדניזון", "prednisone"],
  ["פרדניזולון", "prednisolone"],
  ["טקפידרה", "tecfidera"],
  ["אוקרבוס", "ocrevus"],
  ["אוקרליזומאב", "ocrevus"],
  ["ריטוקסימאב", "rituximab"],
  ["מבתרה", "mabthera"],
  ["אבונקס", "avonex"],
  ["רביף", "rebif"],
  ["בטפרון", "betaferon"],
  ["גילניה", "gilenya"],
  ["מייזנט", "mayzent"],
  ["לטרודה", "lemtrada"],
  ["קסגבה", "kesimpta"],
  ["אופליזומאב", "kesimpta"],
]);

// ─── Hebrew Diacritics ──────────────────────────────────────────

/**
 * Strips niqqud (Hebrew diacritical marks) from text.
 * Unicode ranges: U+0591–U+05BD, U+05BF–U+05C7
 */
export function hebrewStripDiacritics(text) {
  return text.replace(/[\u0591-\u05BD\u05BF-\u05C7]/g, "");
}

// ─── Medication Normalization ───────────────────────────────────

/**
 * Normalize a medication name for deduplication.
 *
 * Examples:
 *   "טיסברי (Tysabri)"  → { key: "tysabri", display: "Tysabri" }
 *   "Copaxone 40mg"     → { key: "copaxone", display: "Copaxone" }
 *   "פרדניזון"           → { key: "prednisone", display: "פרדניזון" }
 *   "UnknownDrug"       → { key: "unknowndrug", display: "UnknownDrug" }
 *
 * @param {string} name - Raw medication name from Gemini extraction
 * @returns {{ key: string, display: string }}
 */
export function normalizeMedName(name) {
  if (!name) return { key: "", display: "" };

  const trimmed = name.trim();

  // Extract English name from parentheses if present: "טיסברי (Tysabri)" → "Tysabri"
  const parenMatch = trimmed.match(/\(([A-Za-z][\w\s-]*)\)/);
  const englishInParen = parenMatch ? parenMatch[1].trim() : null;

  // Strip parenthetical content for the base name
  const baseName = trimmed.replace(/\s*\([^)]*\)\s*/g, "").trim();

  // Strip dosage info (e.g., "40mg", "500 mg", "x3/week")
  const nameOnly = baseName.replace(/\s*\d+\s*m[gG].*$/, "").trim();

  // Check Hebrew alias map (after stripping diacritics)
  const stripped = hebrewStripDiacritics(nameOnly);
  const aliasKey = DRUG_ALIASES.get(stripped);

  if (aliasKey) {
    return {
      key: aliasKey,
      display: englishInParen || nameOnly,
    };
  }

  // If the name is English, lowercase it as the key
  if (/^[A-Za-z]/.test(nameOnly)) {
    return {
      key: nameOnly.toLowerCase(),
      display: englishInParen || nameOnly,
    };
  }

  // Unknown Hebrew drug — return lowercased Hebrew as key
  return {
    key: stripped.toLowerCase(),
    display: nameOnly,
  };
}

// ─── Condition Normalization ────────────────────────────────────

/**
 * Normalize a medical condition name for deduplication.
 *
 * Strips:
 *   - ICD codes: "(362.74)", "(G35)"
 *   - Bracket annotations: "[MS]", "(MS)"
 *   - Extra whitespace
 *
 * Examples:
 *   "Multiple sclerosis (MS)"    → { key: "multiple sclerosis", display: "Multiple sclerosis" }
 *   "Multiple sclerosis [MS]"    → { key: "multiple sclerosis", display: "Multiple sclerosis" }
 *   "Glaucoma (365.11)"          → { key: "glaucoma", display: "Glaucoma" }
 *   "טרשת נפוצה"                 → { key: "טרשת נפוצה", display: "טרשת נפוצה" }
 *
 * @param {string} name - Raw condition name
 * @returns {{ key: string, display: string }}
 */
export function normalizeConditionName(name) {
  if (!name) return { key: "", display: "" };

  const trimmed = name.trim();

  // Strip ICD codes like (362.74), (G35), (H40.1)
  let cleaned = trimmed.replace(/\s*\([A-Z]?\d[\d.]*\)\s*/g, "");

  // Strip short bracket/paren annotations like [MS], (MS), [RRMS]
  cleaned = cleaned.replace(/\s*[\[(][A-Z]{1,6}[\])]\s*/g, "");

  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  const display = cleaned || trimmed;

  // For key: strip diacritics, lowercase
  const key = hebrewStripDiacritics(display).toLowerCase().trim();

  return { key, display };
}

// ─── Recommendation Normalization ───────────────────────────────

/**
 * Generate a deduplication key for a recommendation.
 * Combines type + simplified description to detect duplicates.
 *
 * @param {string} type - Recommendation type (test, referral, etc.)
 * @param {string} description - Recommendation description
 * @returns {string} Dedup key
 */
export function normalizeRecommendation(type, description) {
  if (!type || !description) return "";

  const normalizedDesc = hebrewStripDiacritics(description)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  return `${type}::${normalizedDesc}`;
}
