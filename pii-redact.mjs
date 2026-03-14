#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "fs";
import { basename, dirname, join } from "path";
import { PDFParse } from "pdf-parse";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

const PII_CATEGORIES = [
  "patient_names",
  "doctor_names",
  "patient_id",
  "patient_phone",
  "clinic_phones",
  "addresses",
  "emails",
];

const PII_LABELS = {
  patient_names: "[שם מטופל]",
  doctor_names: "[שם רופא]",
  patient_id: "[ת.ז.]",
  patient_phone: "[טלפון מטופל]",
  clinic_phones: "[טלפון מרפאה]",
  addresses: "[כתובת]",
  emails: "[אימייל]",
};

function redactText(text, report, categoriesToRemove) {
  let result = text;

  for (const category of categoriesToRemove) {
    const values = report[category] || [];
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

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Reverse word order in Hebrew lines.
 * PDF text extraction often gives reversed word order for RTL text.
 */
function fixHebrewOrder(text) {
  const hasHebrew = /[\u0590-\u05FF]/;
  return text.split("\n").map((line) => {
    // Handle tab-separated segments independently (table rows)
    const segments = line.split("\t");
    const fixed = segments.map((seg) => {
      if (!hasHebrew.test(seg)) return seg;
      return seg.split(/\s+/).reverse().join(" ");
    });
    return fixed.join("\t");
  }).join("\n");
}

function buildDarkModeHtml(redactedText, filename) {
  const fixedText = fixHebrewOrder(redactedText);
  const lines = fixedText.split("\n").map((line) => {
    let escaped = escapeHtml(line);
    // Highlight redaction placeholders
    escaped = escaped.replace(
      /\[(שם מטופל|שם רופא|ת\.ז\.|טלפון מטופל|טלפון מרפאה|כתובת|אימייל)\]/g,
      '<span class="redacted">[$1]</span>'
    );
    return escaped;
  });

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="UTF-8">
<style>
  @page { size: A4; margin: 20mm; }
  body {
    background: #1a1a2e;
    color: #e0e0e0;
    font-family: "Arial", "Helvetica", sans-serif;
    font-size: 12px;
    line-height: 1.6;
    direction: rtl;
    padding: 30px;
  }
  .header {
    text-align: center;
    color: #8888cc;
    font-size: 10px;
    margin-bottom: 20px;
    padding-bottom: 10px;
    border-bottom: 1px solid #333355;
  }
  .content {
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .redacted {
    background: #cc4444;
    color: #fff;
    padding: 1px 4px;
    border-radius: 3px;
    font-weight: bold;
    font-size: 11px;
  }
  .page-break {
    border-top: 1px dashed #444466;
    margin: 15px 0;
    color: #555577;
    font-size: 10px;
    text-align: center;
  }
</style>
</head>
<body>
<div class="header">Redacted Document — ${escapeHtml(filename)}</div>
<div class="content">${lines.join("\n")}</div>
</body>
</html>`;
}

async function htmlToPdf(html, outputPath) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle0" });
  await page.pdf({
    path: outputPath,
    format: "A4",
    printBackground: true,
    margin: { top: "15mm", bottom: "15mm", left: "15mm", right: "15mm" },
  });
  await browser.close();
}

// --- Parse args ---
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { pdfPath: null, reportPath: null, remove: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--report" && args[i + 1]) {
      parsed.reportPath = args[++i];
    } else if (args[i] === "--remove" && args[i + 1]) {
      parsed.remove = args[++i];
    } else if (!args[i].startsWith("--")) {
      parsed.pdfPath = args[i];
    }
  }

  return parsed;
}

const { pdfPath, reportPath, remove } = parseArgs();

if (!pdfPath || !remove) {
  console.error("Usage: node pii-redact.mjs <pdf> --remove <categories> [--report <json>]");
  console.error("");
  console.error("Categories (by number or name):");
  PII_CATEGORIES.forEach((cat, i) => console.error(`  ${i + 1}. ${cat}`));
  console.error("");
  console.error("Examples:");
  console.error("  node pii-redact.mjs doc.pdf --remove 1,3,4,6");
  console.error("  node pii-redact.mjs doc.pdf --report pii-report-doc.json --remove 1,3,4,6");
  process.exit(1);
}

// Find report file
const defaultReport = `pii-report-${basename(pdfPath, ".pdf")}.json`;
const actualReport = reportPath || defaultReport;

if (!existsSync(actualReport)) {
  console.error(`Report not found: ${actualReport}`);
  console.error(`Run pii-detect.mjs first: node pii-detect.mjs ${pdfPath}`);
  process.exit(1);
}

const { report } = JSON.parse(readFileSync(actualReport, "utf-8"));

// Parse categories
const categoriesToRemove = remove.split(",").map((v) => {
  v = v.trim();
  const num = parseInt(v);
  if (!isNaN(num) && num >= 1 && num <= PII_CATEGORIES.length) {
    return PII_CATEGORIES[num - 1];
  }
  if (PII_CATEGORIES.includes(v)) return v;
  console.error(`Unknown category: "${v}"`);
  process.exit(1);
});

// Extract text
const buffer = readFileSync(pdfPath);
const pdf = new PDFParse({ data: buffer });
await pdf.load();
const { text } = await pdf.getText();

// Redact
console.log(`Redacting: ${categoriesToRemove.join(", ")}`);
const redacted = redactText(text, report, categoriesToRemove);

// Generate dark mode PDF
const filename = basename(pdfPath);
const html = buildDarkModeHtml(redacted, filename);
const outPdf = `redacted-${basename(pdfPath)}`;

console.log("Generating dark mode PDF...");
await htmlToPdf(html, outPdf);
console.log(`Saved: ${outPdf}`);
