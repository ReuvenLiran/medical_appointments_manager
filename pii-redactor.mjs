/**
 * Shared PII detection and redaction utilities.
 * Used by summarize.mjs for the automated pipeline.
 */

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434/api/generate";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1:8b";

export const PII_CATEGORIES = [
  "patient_names",
  "doctor_names",
  "patient_id",
  "patient_phone",
  "clinic_phones",
  "addresses",
  "emails",
];

export const PII_LABELS = {
  patient_names: "[שם מטופל]",
  doctor_names: "[שם רופא]",
  patient_id: "[ת.ז.]",
  patient_phone: "[טלפון מטופל]",
  clinic_phones: "[טלפון מרפאה]",
  addresses: "[כתובת]",
  emails: "[אימייל]",
};

export async function ollamaDetectPII(text) {
  const prompt = `Analyze this document and find ALL personally identifiable information (PII).
Return ONLY a JSON object with these exact keys:
- patient_names: array of patient name strings found
- doctor_names: array of doctor/physician/nurse name strings found
- patient_id: array of patient ID numbers found
- patient_phone: array of patient mobile/personal phone numbers found
- clinic_phones: array of clinic/hospital phone numbers found
- addresses: array of street addresses found
- emails: array of email addresses found

If a category has no matches, use an empty array.
Return ONLY valid JSON, no commentary.

Text:
${text}`;

  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0, num_predict: 1024 },
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama request failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  const response = data.response.trim();

  let detected;
  try {
    const match = response.match(/\{[\s\S]*\}/);
    if (match) {
      const fixed = match[0].replace(/(\w)"(\w)/g, "$1'$2");
      detected = JSON.parse(fixed);
    }
  } catch {
    console.warn("Warning: Could not parse Ollama response:", response);
  }

  const result = {};
  for (const cat of PII_CATEGORIES) {
    result[cat] = detected && Array.isArray(detected[cat])
      ? detected[cat].map((v) => String(v))
      : [];
  }
  return result;
}

export function mergeKnownPII(detected, { patientId, mobile, fullName } = {}) {
  const result = {};
  for (const cat of PII_CATEGORIES) {
    result[cat] = [...(detected[cat] || [])];
  }

  if (patientId && !result.patient_id.includes(patientId)) {
    result.patient_id.push(patientId);
  }
  if (mobile && !result.patient_phone.includes(mobile)) {
    result.patient_phone.push(mobile);
  }
  if (fullName && !result.patient_names.some((n) => n.includes(fullName) || fullName.includes(n))) {
    result.patient_names.push(fullName);
  }

  return result;
}

export function redactByCategories(text, piiReport, categoriesToRemove) {
  let result = text;

  for (const category of categoriesToRemove) {
    const values = piiReport[category] || [];
    const placeholder = PII_LABELS[category] || `[${category}]`;

    for (const value of values) {
      if (value.length < 2) continue;
      result = result.replaceAll(value, placeholder);

      if (category === "patient_id") {
        const padded = value.padStart(10, "0");
        result = result.replaceAll(padded, placeholder);
        const dashed = value.replace(/(\d{3})(\d{3})(\d{3})/, "$1-$2-$3");
        result = result.replaceAll(dashed, placeholder);
      }

      if (category === "patient_phone" || category === "clinic_phones") {
        const withDash = value.replace(/^(\d{3})(\d{7})$/, "$1-$2");
        result = result.replaceAll(withDash, placeholder);
        const withDashes = value.replace(/^(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3");
        result = result.replaceAll(withDashes, placeholder);
      }

      if (category === "patient_names" || category === "doctor_names") {
        const parts = value.split(/\s+/);
        if (parts.length >= 2) {
          const reversed = [...parts].reverse().join(" ");
          result = result.replaceAll(reversed, placeholder);
        }
        for (const part of parts) {
          if (part.length >= 2) {
            result = result.replaceAll(part, placeholder);
          }
        }
      }
    }
  }

  return result;
}
