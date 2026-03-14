import "dotenv/config";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { extractText } from "pii-tools/lib/pdf.mjs";
import { ollamaDetectPII, mergeKnownPII } from "pii-tools/lib/detector.mjs";
import { redactByCategories } from "pii-tools/lib/redactor.mjs";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("Set GEMINI_API_KEY in .env");
  process.exit(1);
}

const DEFAULT_REMOVE = ["patient_names", "patient_id", "patient_phone", "addresses", "emails"];

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const responseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    specialty: {
      type: SchemaType.STRING,
      description: "Medical specialty name in Hebrew (e.g., נוירולוגיה, עיניים, אורתופדיה)",
    },
    doctor_name: {
      type: SchemaType.STRING,
      description: "Doctor's name as it appears in the document",
    },
    visit_date: {
      type: SchemaType.STRING,
      description: "Visit date, must be exactly YYYY-MM-DD format",
    },
    summary: {
      type: SchemaType.STRING,
      description: "Visit summary in Hebrew, 2-4 sentences",
    },
    medications: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          name: { type: SchemaType.STRING, description: "Medication name" },
          dosage: { type: SchemaType.STRING, description: "Dosage, e.g., 40mg x3/week" },
          action: {
            type: SchemaType.STRING,
            description: "new = newly prescribed, continue = continuing, stop = discontinued, change = dosage/regimen change",
          },
          notes: { type: SchemaType.STRING, description: "Additional notes" },
        },
        required: ["name", "action"],
      },
    },
    conditions: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          name: { type: SchemaType.STRING, description: "Diagnosis or medical condition name" },
          status: {
            type: SchemaType.STRING,
            description: "active = currently active, resolved = resolved, monitoring = under observation",
          },
          notes: { type: SchemaType.STRING, description: "Additional notes" },
        },
        required: ["name", "status"],
      },
    },
    tests_ordered: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          type: {
            type: SchemaType.STRING,
            description: "Test type: MRI, blood, imaging, other",
          },
          description: { type: SchemaType.STRING, description: "Test description" },
          urgency: {
            type: SchemaType.STRING,
            description: "routine or urgent",
          },
          due_date: {
            type: SchemaType.STRING,
            description: "Must be exactly YYYY-MM-DD format if available, otherwise empty string",
          },
        },
        required: ["type", "description"],
      },
    },
    recommendations: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          type: {
            type: SchemaType.STRING,
            description: "test | medication_change | lifestyle | referral | follow_up",
          },
          description: { type: SchemaType.STRING, description: "Recommendation description" },
          due_date: {
            type: SchemaType.STRING,
            description: "Must be exactly YYYY-MM-DD format if available, otherwise empty string",
          },
        },
        required: ["type", "description"],
      },
    },
    lifestyle: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          directive: { type: SchemaType.STRING, description: "The directive" },
          category: {
            type: SchemaType.STRING,
            description: "diet | exercise | sleep | vitamins | other",
          },
        },
        required: ["directive", "category"],
      },
    },
  },
  required: ["specialty", "summary", "medications", "conditions", "recommendations"],
};

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview";

const model = genAI.getGenerativeModel({
  model: GEMINI_MODEL,
  generationConfig: {
    responseMimeType: "application/json",
    responseSchema,
  },
});

const PROMPT = `You are an expert at analyzing Hebrew medical documents. The following text is a medical visit summary with patient-identifying information already redacted.

Extract all structured information from the document accurately.

Critical rules:
- All dates must be in YYYY-MM-DD format only. If no date is available, leave the field empty.
- The specialty name must be in Hebrew (e.g., נוירולוגיה, עיניים, אורתופדיה).
- For medications: extract ONLY medications that the authoring doctor directly manages or prescribes. Do NOT include medications mentioned as background or managed by a different clinic/specialty. The "action" field must be one of: new, continue, stop, change.
- For conditions: "status" must be one of: active, resolved, monitoring.
- For recommendations: "type" must be one of: test, medication_change, lifestyle, referral, follow_up.
- The summary must be written in Hebrew, 2-4 sentences.

הטקסט:
---
`;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeDate(value) {
  if (value == null || value === "") return null;
  if (ISO_DATE_RE.test(value)) return value;

  // Attempt to parse non-ISO date strings
  const parsed = new Date(value);
  if (!isNaN(parsed.getTime())) {
    const iso = parsed.toISOString().slice(0, 10);
    console.warn(`Date normalized: "${value}" → "${iso}"`);
    return iso;
  }

  console.warn(`Unparseable date discarded: "${value}"`);
  return null;
}

function normalizeDatesInResult(result) {
  result.visit_date = normalizeDate(result.visit_date);

  for (const test of result.tests_ordered ?? []) {
    test.due_date = normalizeDate(test.due_date);
  }
  for (const rec of result.recommendations ?? []) {
    rec.due_date = normalizeDate(rec.due_date);
  }

  return result;
}

export async function extractEntities(redactedText) {
  const result = await model.generateContent(PROMPT + redactedText + "\n---");
  const text = result.response.text();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Fallback: extract JSON object via regex
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        throw new Error(`Failed to parse Gemini response as JSON: ${text.slice(0, 200)}...`);
      }
    } else {
      throw new Error(`No JSON found in Gemini response: ${text.slice(0, 200)}...`);
    }
  }

  // Ensure arrays exist even if Gemini omitted them
  parsed.medications ??= [];
  parsed.conditions ??= [];
  parsed.tests_ordered ??= [];
  parsed.recommendations ??= [];
  parsed.lifestyle ??= [];

  return normalizeDatesInResult(parsed);
}

export async function processDocument(pdfPath) {
  console.log("Extracting text from PDF...");
  const rawText = await extractText(pdfPath);

  if (!rawText.trim()) {
    throw new Error("No text found in PDF (may be a scanned image)");
  }
  console.log(`Extracted ${rawText.length} characters`);

  console.log("Detecting PII via Ollama...");
  const detected = await ollamaDetectPII(rawText);
  const report = mergeKnownPII(detected, {
    patientId: process.env.SHEBA_PATIENT_ID,
    mobile: process.env.SHEBA_MOBILE,
    fullName: process.env.PATIENT_FULL_NAME,
  });

  console.log(`Redacting: ${DEFAULT_REMOVE.join(", ")}`);
  const redactedText = redactByCategories(rawText, report, DEFAULT_REMOVE);

  console.log("Extracting entities via Gemini...");
  const entities = await extractEntities(redactedText);

  return { redactedText, entities };
}
