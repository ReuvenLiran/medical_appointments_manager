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
      description: "שם ההתמחות בעברית, למשל: נוירולוגיה, עיניים, אורתופדיה",
    },
    doctor_name: {
      type: SchemaType.STRING,
      description: "שם הרופא כפי שמופיע במסמך",
    },
    visit_date: {
      type: SchemaType.STRING,
      description: "Must be exactly YYYY-MM-DD format. תאריך הביקור",
    },
    summary: {
      type: SchemaType.STRING,
      description: "סיכום הביקור בעברית, 2-4 משפטים",
    },
    medications: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          name: { type: SchemaType.STRING, description: "שם התרופה" },
          dosage: { type: SchemaType.STRING, description: "מינון, למשל: 40mg x3/week" },
          action: {
            type: SchemaType.STRING,
            description: "new = תרופה חדשה, continue = ממשיכים, stop = הפסקה, change = שינוי מינון",
          },
          notes: { type: SchemaType.STRING, description: "הערות נוספות" },
        },
        required: ["name", "action"],
      },
    },
    conditions: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          name: { type: SchemaType.STRING, description: "שם האבחנה / מצב רפואי" },
          status: {
            type: SchemaType.STRING,
            description: "active = פעיל, resolved = נפתר, monitoring = במעקב",
          },
          notes: { type: SchemaType.STRING, description: "הערות נוספות" },
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
            description: "סוג הבדיקה: MRI, blood, imaging, other",
          },
          description: { type: SchemaType.STRING, description: "תיאור הבדיקה" },
          urgency: {
            type: SchemaType.STRING,
            description: "routine = שגרתי, urgent = דחוף",
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
          description: { type: SchemaType.STRING, description: "תיאור ההמלצה" },
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
          directive: { type: SchemaType.STRING, description: "ההנחיה" },
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

const model = genAI.getGenerativeModel({
  model: "gemini-3.1-flash-lite-preview",
  generationConfig: {
    responseMimeType: "application/json",
    responseSchema,
  },
});

const PROMPT = `אתה מומחה לניתוח מסמכים רפואיים בעברית. הטקסט הבא הוא סיכום ביקור רפואי לאחר שהוסרו ממנו פרטים מזהים של המטופל.

חלץ את כל המידע המובנה מהמסמך בצורה מדויקת.

כללים חשובים:
- כל התאריכים חייבים להיות בפורמט YYYY-MM-DD בלבד
- אם אין תאריך, השאר שדה ריק
- שם ההתמחות חייב להיות בעברית (נוירולוגיה, עיניים, אורתופדיה וכו׳)
- עבור תרופות: action חייב להיות אחד מ: new, continue, stop, change
- עבור מצבים רפואיים: status חייב להיות אחד מ: active, resolved, monitoring
- עבור המלצות: type חייב להיות אחד מ: test, medication_change, lifestyle, referral, follow_up
- הסיכום צריך להיות בעברית, 2-4 משפטים

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
