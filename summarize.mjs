import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { basename, join, extname } from "path";
import { PDFParse } from "pdf-parse";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { ollamaDetectPII, mergeKnownPII, redactByCategories, PII_CATEGORIES } from "./pii-redactor.mjs";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("Set GEMINI_API_KEY in .env");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// Default: redact only patient PII, keep doctor info
const DEFAULT_REMOVE = ["patient_names", "patient_id", "patient_phone", "addresses", "emails"];

async function extractText(pdfPath) {
  const buffer = readFileSync(pdfPath);
  const pdf = new PDFParse({ data: buffer });
  await pdf.load();
  const result = await pdf.getText();
  return result.text;
}

async function summarizeText(redactedText) {
  const prompt = `אתה עוזר רפואי. הטקסט הבא הוא סיכום ביקור רפואי ממרכז רפואי שיבא, לאחר שהוסרו ממנו פרטים מזהים.

אנא ספק את המידע הבא בצורה מסודרת:

## סיכום הביקור
סכם בקצרה מה קרה בביקור (2-3 משפטים)

## המלצות הרופא
רשום את כל ההמלצות שניתנו

## תרופות
שינויים בתרופות, מרשמים חדשים, או הנחיות לגבי תרופות קיימות

## בדיקות ומעקב
בדיקות שהוזמנו, תורים עתידיים, או הנחיות למעקב

## מחלקה/התמחות
באיזו מחלקה או התמחות היה הביקור

---
${redactedText}
---`;

  const result = await model.generateContent(prompt);
  return result.response.text();
}

async function processFile(pdfPath, categoriesToRemove) {
  const filename = basename(pdfPath);
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${filename}`);
  console.log(`${"═".repeat(60)}`);

  console.log("\nExtracting text from PDF...");
  const rawText = await extractText(pdfPath);

  if (!rawText.trim()) {
    console.log("No text found in PDF (may be a scanned image).");
    return null;
  }

  console.log(`Extracted ${rawText.length} characters`);

  console.log("Detecting PII...");
  const detected = await ollamaDetectPII(rawText);
  const report = mergeKnownPII(detected, {
    patientId: process.env.SHEBA_PATIENT_ID,
    mobile: process.env.SHEBA_MOBILE,
    fullName: process.env.PATIENT_FULL_NAME,
  });

  console.log(`Redacting: ${categoriesToRemove.join(", ")}`);
  const redactedText = redactByCategories(rawText, report, categoriesToRemove);

  console.log("\n--- Redacted text (verify no PII) ---");
  console.log(redactedText);
  console.log("--- End redacted text ---\n");

  console.log("Sending to Gemini for summarization...");
  const summary = await summarizeText(redactedText);

  console.log("\n" + summary);

  return {
    source: filename,
    rawLength: rawText.length,
    redactedText,
    summary,
    processedAt: new Date().toISOString(),
  };
}

function getPdfFiles(pathArg) {
  const stat = statSync(pathArg);
  if (stat.isDirectory()) {
    return readdirSync(pathArg)
      .filter((f) => extname(f).toLowerCase() === ".pdf")
      .map((f) => join(pathArg, f));
  }
  return [pathArg];
}

function parseRemoveArg() {
  const idx = process.argv.indexOf("--remove");
  if (idx === -1) return DEFAULT_REMOVE;

  const value = process.argv[idx + 1];
  if (!value) return DEFAULT_REMOVE;

  return value.split(",").map((v) => {
    v = v.trim();
    const num = parseInt(v);
    if (!isNaN(num) && num >= 1 && num <= PII_CATEGORIES.length) {
      return PII_CATEGORIES[num - 1];
    }
    return v;
  });
}

async function main() {
  const pathArg = process.argv[2];
  if (!pathArg || pathArg.startsWith("--")) {
    console.error("Usage: node summarize.mjs <path-to-pdf> [--remove categories]");
    console.error("  node summarize.mjs document.pdf");
    console.error("  node summarize.mjs document.pdf --remove 1,3,4,6");
    console.error("  Default removes: patient_names, patient_id, patient_phone, addresses, emails");
    process.exit(1);
  }

  const categoriesToRemove = parseRemoveArg();
  const pdfFiles = getPdfFiles(pathArg);

  if (!pdfFiles.length) {
    console.log("No PDF files found.");
    return;
  }

  console.log(`Found ${pdfFiles.length} PDF file(s) to process.`);
  mkdirSync("summaries", { recursive: true });
  const results = [];

  for (const pdfPath of pdfFiles) {
    try {
      const result = await processFile(pdfPath, categoriesToRemove);
      if (result) {
        results.push(result);
        const jsonName = basename(pdfPath, ".pdf") + ".json";
        writeFileSync(join("summaries", jsonName), JSON.stringify(result, null, 2));
      }
    } catch (err) {
      console.error(`\nError processing ${basename(pdfPath)}: ${err.message}`);
    }
  }

  if (results.length) {
    writeFileSync("summaries/all-summaries.json", JSON.stringify(results, null, 2));
    console.log(`\nSaved ${results.length} summary(ies) to summaries/`);
  }
}

main();
