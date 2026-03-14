#!/usr/bin/env node
import { readFileSync, writeFileSync } from "fs";
import { basename } from "path";
import { PDFParse } from "pdf-parse";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434/api/generate";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1:8b";

const PII_CATEGORIES = [
  "patient_names",
  "doctor_names",
  "patient_id",
  "patient_phone",
  "clinic_phones",
  "addresses",
  "emails",
];

const PII_DISPLAY = {
  patient_names: "Patient names (שמות מטופל)",
  doctor_names: "Doctor names (שמות רופאים)",
  patient_id: "Patient ID (ת.ז.)",
  patient_phone: "Patient phone (טלפון מטופל)",
  clinic_phones: "Clinic phones (טלפון מרפאה)",
  addresses: "Addresses (כתובות)",
  emails: "Emails (אימייל)",
};

async function detectPII(text) {
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

// --- Main ---
const pdfPath = process.argv[2];
if (!pdfPath) {
  console.error("Usage: node pii-detect.mjs <path-to-pdf>");
  process.exit(1);
}

const buffer = readFileSync(pdfPath);
const pdf = new PDFParse({ data: buffer });
await pdf.load();
const { text } = await pdf.getText();

console.log("Scanning for PII...\n");
const report = await detectPII(text);

console.log("PII found in document:");
console.log("─".repeat(50));
for (let i = 0; i < PII_CATEGORIES.length; i++) {
  const cat = PII_CATEGORIES[i];
  const values = report[cat];
  const display = values.length ? values.join(", ") : "(none)";
  console.log(`  ${i + 1}. ${PII_DISPLAY[cat]}`);
  console.log(`     ${display}`);
}
console.log("─".repeat(50));

const outPath = `pii-report-${basename(pdfPath, ".pdf")}.json`;
writeFileSync(outPath, JSON.stringify({ pdfPath, report }, null, 2));
console.log(`\nSaved to ${outPath}`);
console.log("\nTo redact, run:");
console.log(`  node pii-redact.mjs ${pdfPath} --report ${outPath} --remove 1,3,4,6`);
