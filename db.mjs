import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { normalizeMedName, normalizeConditionName } from "./normalize.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "health.db");

let _db = null;

// ─── Initialization ──────────────────────────────────────────────

export function initDB() {
  if (_db) return _db;

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS specialties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      source_path TEXT,
      specialty_id INTEGER REFERENCES specialties(id),
      doctor_name TEXT,
      visit_date TEXT CHECK(visit_date IS NULL OR visit_date LIKE '____-__-__'),
      redacted_text TEXT,
      summary TEXT,
      raw_entities_json TEXT,
      processed_at TEXT DEFAULT (datetime('now'))
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      filename, redacted_text, summary,
      content=documents, content_rowid=id
    );

    CREATE TABLE IF NOT EXISTS medications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      dosage TEXT,
      prescriber_specialty_id INTEGER NOT NULL REFERENCES specialties(id),
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'discontinued', 'changed')),
      started_from_doc_id INTEGER REFERENCES documents(id),
      discontinued_from_doc_id INTEGER REFERENCES documents(id),
      started_date TEXT CHECK(started_date IS NULL OR started_date LIKE '____-__-__'),
      discontinued_date TEXT CHECK(discontinued_date IS NULL OR discontinued_date LIKE '____-__-__'),
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS conditions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'resolved', 'monitoring')),
      diagnosing_specialty_id INTEGER REFERENCES specialties(id),
      first_doc_id INTEGER REFERENCES documents(id),
      latest_doc_id INTEGER REFERENCES documents(id),
      first_seen_date TEXT CHECK(first_seen_date IS NULL OR first_seen_date LIKE '____-__-__'),
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('test', 'medication_change', 'lifestyle', 'referral', 'follow_up')),
      description TEXT NOT NULL,
      requesting_specialty_id INTEGER NOT NULL REFERENCES specialties(id),
      source_doc_id INTEGER REFERENCES documents(id),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'matched', 'completed')),
      matched_appointment_id INTEGER REFERENCES appointments(id),
      due_date TEXT CHECK(due_date IS NULL OR due_date LIKE '____-__-__'),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sheba_doc_id TEXT UNIQUE NOT NULL,
      appointment_type TEXT,
      service TEXT,
      location TEXT,
      appointment_date TEXT NOT NULL CHECK(appointment_date LIKE '____-__-__'),
      status TEXT DEFAULT 'NEW',
      invite_pdf_path TEXT,
      imported_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS entity_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL CHECK(source_type IN ('medication', 'condition', 'recommendation')),
      source_id INTEGER NOT NULL,
      target_type TEXT NOT NULL CHECK(target_type IN ('medication', 'condition', 'recommendation')),
      target_id INTEGER NOT NULL,
      relationship TEXT NOT NULL CHECK(relationship IN ('treats', 'caused_by', 'monitors', 'interacts_with', 'mentioned_in')),
      specialty_context_id INTEGER REFERENCES specialties(id),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_type TEXT NOT NULL CHECK(alert_type IN ('drug_interaction', 'condition_conflict', 'unmatched_recommendation')),
      severity TEXT DEFAULT 'info' CHECK(severity IN ('info', 'warning', 'critical')),
      description TEXT NOT NULL,
      related_entity_ids TEXT,
      resolved INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // FTS5 triggers — created separately because CREATE TRIGGER IF NOT EXISTS
  // can't be inside the same exec block as CREATE VIRTUAL TABLE IF NOT EXISTS
  const triggerExists = (name) =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name);

  if (!triggerExists("documents_ai")) {
    db.exec(`
      CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
        INSERT INTO documents_fts(rowid, filename, redacted_text, summary)
        VALUES (new.id, new.filename, new.redacted_text, new.summary);
      END;
    `);
  }

  if (!triggerExists("documents_ad")) {
    db.exec(`
      CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
        INSERT INTO documents_fts(documents_fts, rowid, filename, redacted_text, summary)
        VALUES ('delete', old.id, old.filename, old.redacted_text, old.summary);
      END;
    `);
  }

  if (!triggerExists("documents_au")) {
    db.exec(`
      CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
        INSERT INTO documents_fts(documents_fts, rowid) VALUES('delete', old.id);
        INSERT INTO documents_fts(rowid, filename, redacted_text, summary)
        VALUES (new.id, new.filename, new.redacted_text, new.summary);
      END;
    `);
  }

  // ── Schema migrations (safe to run repeatedly) ──
  const colExists = (table, col) =>
    db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, col);

  if (!colExists("appointments", "appointment_time")) {
    db.exec(`ALTER TABLE appointments ADD COLUMN appointment_time TEXT CHECK(appointment_time IS NULL OR appointment_time LIKE '__:__')`);
  }
  if (!colExists("medications", "latest_doc_id")) {
    db.exec(`ALTER TABLE medications ADD COLUMN latest_doc_id INTEGER REFERENCES documents(id)`);
  }

  _db = db;
  return db;
}

// ─── Specialties ─────────────────────────────────────────────────

export function getOrCreateSpecialty(name) {
  const db = initDB();
  const existing = db.prepare("SELECT id FROM specialties WHERE name = ?").get(name);
  if (existing) return existing.id;
  return db.prepare("INSERT INTO specialties (name) VALUES (?)").run(name).lastInsertRowid;
}

// ─── Documents ───────────────────────────────────────────────────

export function upsertDocument(doc) {
  const db = initDB();
  const specialtyId = doc.specialty ? getOrCreateSpecialty(doc.specialty) : null;
  const jsonString = doc.raw_entities_json != null ? JSON.stringify(
    typeof doc.raw_entities_json === "string" ? JSON.parse(doc.raw_entities_json) : doc.raw_entities_json
  ) : null;

  const existing = db.prepare("SELECT id FROM documents WHERE filename = ?").get(doc.filename);

  if (existing) {
    db.prepare(`
      UPDATE documents SET
        source_path = ?, specialty_id = ?, doctor_name = ?, visit_date = ?,
        redacted_text = ?, summary = ?, raw_entities_json = json(?),
        processed_at = datetime('now')
      WHERE id = ?
    `).run(
      doc.source_path ?? null, specialtyId, doc.doctor_name ?? null, doc.visit_date ?? null,
      doc.redacted_text ?? null, doc.summary ?? null, jsonString,
      existing.id
    );
    return existing.id;
  }

  return db.prepare(`
    INSERT INTO documents (filename, source_path, specialty_id, doctor_name, visit_date,
                           redacted_text, summary, raw_entities_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, json(?))
  `).run(
    doc.filename, doc.source_path ?? null, specialtyId, doc.doctor_name ?? null,
    doc.visit_date ?? null, doc.redacted_text ?? null, doc.summary ?? null, jsonString
  ).lastInsertRowid;
}

// ─── Appointments ────────────────────────────────────────────────

export function upsertAppointments(appointments) {
  const db = initDB();
  const upsert = db.prepare(`
    INSERT INTO appointments (sheba_doc_id, appointment_type, service, location, appointment_date, appointment_time, status, invite_pdf_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sheba_doc_id) DO UPDATE SET
      appointment_type = excluded.appointment_type,
      service = excluded.service,
      location = excluded.location,
      appointment_date = excluded.appointment_date,
      appointment_time = excluded.appointment_time,
      status = excluded.status,
      invite_pdf_path = excluded.invite_pdf_path
  `);

  const insertMany = db.transaction((items) => {
    for (const apt of items) {
      upsert.run(
        apt.sheba_doc_id, apt.appointment_type ?? null, apt.service ?? null,
        apt.location ?? null, apt.appointment_date, apt.appointment_time ?? null,
        apt.status ?? "NEW", apt.invite_pdf_path ?? null
      );
    }
  });

  insertMany(appointments);
}

// ─── Medications (immutable pattern) ─────────────────────────────

export function addMedication(med) {
  const db = initDB();
  const specialtyId = getOrCreateSpecialty(med.prescriber_specialty);
  return db.prepare(`
    INSERT INTO medications (name, dosage, prescriber_specialty_id, status,
                             started_from_doc_id, started_date, notes)
    VALUES (?, ?, ?, 'active', ?, ?, ?)
  `).run(
    med.name, med.dosage ?? null, specialtyId,
    med.started_from_doc_id ?? null, med.started_date ?? null, med.notes ?? null
  ).lastInsertRowid;
}

export function discontinueMedication(id, { docId, date, newStatus = "discontinued" } = {}) {
  const db = initDB();
  return db.prepare(`
    UPDATE medications SET status = ?, discontinued_from_doc_id = ?, discontinued_date = ?
    WHERE id = ?
  `).run(newStatus, docId ?? null, date ?? null, id);
}

// ─── Conditions ──────────────────────────────────────────────────

export function addCondition(cond) {
  const db = initDB();
  const specialtyId = cond.diagnosing_specialty ? getOrCreateSpecialty(cond.diagnosing_specialty) : null;
  return db.prepare(`
    INSERT INTO conditions (name, status, diagnosing_specialty_id, first_doc_id, latest_doc_id, first_seen_date, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    cond.name, cond.status ?? "active", specialtyId,
    cond.first_doc_id ?? null, cond.latest_doc_id ?? null,
    cond.first_seen_date ?? null, cond.notes ?? null
  ).lastInsertRowid;
}

export function updateCondition(id, updates) {
  const db = initDB();
  const fields = [];
  const values = [];

  if (updates.status !== undefined) { fields.push("status = ?"); values.push(updates.status); }
  if (updates.latest_doc_id !== undefined) { fields.push("latest_doc_id = ?"); values.push(updates.latest_doc_id); }
  if (updates.notes !== undefined) { fields.push("notes = ?"); values.push(updates.notes); }

  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE conditions SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

// ─── Recommendations ─────────────────────────────────────────────

export function addRecommendation(rec) {
  const db = initDB();
  const specialtyId = getOrCreateSpecialty(rec.requesting_specialty);
  return db.prepare(`
    INSERT INTO recommendations (type, description, requesting_specialty_id, source_doc_id, due_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    rec.type, rec.description, specialtyId,
    rec.source_doc_id ?? null, rec.due_date ?? null
  ).lastInsertRowid;
}

// ─── Graph ───────────────────────────────────────────────────────

export function addEntityLink(link) {
  const db = initDB();
  const specialtyId = link.specialty_context ? getOrCreateSpecialty(link.specialty_context) : null;
  return db.prepare(`
    INSERT INTO entity_links (source_type, source_id, target_type, target_id, relationship, specialty_context_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    link.source_type, link.source_id, link.target_type, link.target_id,
    link.relationship, specialtyId
  ).lastInsertRowid;
}

export function addAlert(alert) {
  const db = initDB();
  const entityIdsJson = alert.related_entity_ids != null
    ? JSON.stringify(Array.isArray(alert.related_entity_ids) ? alert.related_entity_ids : JSON.parse(alert.related_entity_ids))
    : null;
  return db.prepare(`
    INSERT INTO alerts (alert_type, severity, description, related_entity_ids)
    VALUES (?, ?, ?, json(?))
  `).run(
    alert.alert_type, alert.severity ?? "info", alert.description, entityIdsJson
  ).lastInsertRowid;
}

// ─── Queries ─────────────────────────────────────────────────────

export function getActiveMedications() {
  const db = initDB();
  return db.prepare(`
    SELECT m.*, s.name AS prescriber_specialty
    FROM medications m
    JOIN specialties s ON m.prescriber_specialty_id = s.id
    WHERE m.status = 'active'
  `).all();
}

export function getActiveConditions() {
  const db = initDB();
  return db.prepare(`
    SELECT c.*, s.name AS diagnosing_specialty
    FROM conditions c
    LEFT JOIN specialties s ON c.diagnosing_specialty_id = s.id
    WHERE c.status IN ('active', 'monitoring')
  `).all();
}

export function getPendingRecommendations() {
  const db = initDB();
  return db.prepare(`
    SELECT r.*, s.name AS requesting_specialty
    FROM recommendations r
    JOIN specialties s ON r.requesting_specialty_id = s.id
    WHERE r.status = 'pending'
  `).all();
}

export function getFutureAppointments() {
  const db = initDB();
  return db.prepare(`
    SELECT * FROM appointments
    WHERE appointment_date > date('now')
    ORDER BY appointment_date ASC
  `).all();
}

export function getUnmatchedRecommendations() {
  const db = initDB();
  return db.prepare(`
    SELECT r.*, s.name AS requesting_specialty
    FROM recommendations r
    JOIN specialties s ON r.requesting_specialty_id = s.id
    WHERE r.status = 'pending' AND r.matched_appointment_id IS NULL
  `).all();
}

export function matchRecommendationToAppointment(recId, aptId) {
  const db = initDB();
  return db.prepare(`
    UPDATE recommendations SET matched_appointment_id = ?, status = 'matched'
    WHERE id = ?
  `).run(aptId, recId);
}

export function searchDocuments(query) {
  const db = initDB();
  return db.prepare(`
    SELECT d.*, s.name AS specialty
    FROM documents_fts fts
    JOIN documents d ON fts.rowid = d.id
    LEFT JOIN specialties s ON d.specialty_id = s.id
    WHERE documents_fts MATCH ?
    ORDER BY rank
  `).all(query);
}

export function getUnresolvedAlerts() {
  const db = initDB();
  return db.prepare("SELECT * FROM alerts WHERE resolved = 0 ORDER BY created_at DESC").all();
}

export function getMedicationHistory(name) {
  const db = initDB();
  return db.prepare(`
    SELECT m.*, s.name AS prescriber_specialty
    FROM medications m
    JOIN specialties s ON m.prescriber_specialty_id = s.id
    WHERE m.name = ?
    ORDER BY m.started_date ASC
  `).all(name);
}

// ─── Entity Resolution ──────────────────────────────────────────

export function getDocumentByFilename(filename) {
  const db = initDB();
  return db.prepare("SELECT * FROM documents WHERE filename = ?").get(filename);
}

export function getAllActiveMedicationNames() {
  const db = initDB();
  return db.prepare("SELECT id, name FROM medications WHERE status = 'active'").all();
}

/**
 * Find an active medication by normalized name.
 * Fetches all active meds, normalizes each in JS, and matches against the given key.
 */
export function findMedicationByNormalizedName(key) {
  const meds = getAllActiveMedicationNames();
  for (const med of meds) {
    const { key: medKey } = normalizeMedName(med.name);
    if (medKey === key) {
      const db = initDB();
      return db.prepare(`
        SELECT m.*, s.name AS prescriber_specialty
        FROM medications m
        JOIN specialties s ON m.prescriber_specialty_id = s.id
        WHERE m.id = ?
      `).get(med.id);
    }
  }
  return null;
}

/**
 * Find a condition by normalized name.
 * Fetches all active/monitoring conditions, normalizes each in JS, matches.
 */
export function findConditionByNormalizedName(key) {
  const db = initDB();
  const conditions = db.prepare(
    "SELECT id, name FROM conditions WHERE status IN ('active', 'monitoring')"
  ).all();
  for (const cond of conditions) {
    const { key: condKey } = normalizeConditionName(cond.name);
    if (condKey === key) {
      return db.prepare(`
        SELECT c.*, s.name AS diagnosing_specialty
        FROM conditions c
        LEFT JOIN specialties s ON c.diagnosing_specialty_id = s.id
        WHERE c.id = ?
      `).get(cond.id);
    }
  }
  return null;
}

/**
 * Update medication after clinical review (action=continue).
 * Updates latest_doc_id and optionally notes.
 */
export function updateMedicationReview(id, { latest_doc_id, notes } = {}) {
  const db = initDB();
  const fields = [];
  const values = [];
  if (latest_doc_id !== undefined) { fields.push("latest_doc_id = ?"); values.push(latest_doc_id); }
  if (notes !== undefined) { fields.push("notes = ?"); values.push(notes); }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE medications SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

/**
 * Delete all recommendations tied to a specific document (for idempotent re-processing).
 */
export function deleteRecommendationsByDocId(docId) {
  const db = initDB();
  return db.prepare("DELETE FROM recommendations WHERE source_doc_id = ?").run(docId);
}

/**
 * Cascading delete of all entities tied to a document.
 * Used by --force re-processing to clear old data before re-extraction.
 */
export function deleteDocumentCascading(docId) {
  const db = initDB();
  const run = db.transaction(() => {
    // Delete entity links referencing medications/conditions/recommendations from this doc
    const medIds = db.prepare("SELECT id FROM medications WHERE started_from_doc_id = ?").all(docId).map(r => r.id);
    const condIds = db.prepare("SELECT id FROM conditions WHERE first_doc_id = ?").all(docId).map(r => r.id);
    const recIds = db.prepare("SELECT id FROM recommendations WHERE source_doc_id = ?").all(docId).map(r => r.id);

    const allIds = [
      ...medIds.map(id => ({ type: "medication", id })),
      ...condIds.map(id => ({ type: "condition", id })),
      ...recIds.map(id => ({ type: "recommendation", id })),
    ];

    for (const { type, id } of allIds) {
      db.prepare("DELETE FROM entity_links WHERE (source_type = ? AND source_id = ?) OR (target_type = ? AND target_id = ?)").run(type, id, type, id);
    }

    // Delete alerts referencing these entities
    db.prepare("DELETE FROM alerts WHERE related_entity_ids IS NOT NULL AND resolved = 0").run();

    // Delete the entities themselves
    db.prepare("DELETE FROM recommendations WHERE source_doc_id = ?").run(docId);
    db.prepare("DELETE FROM medications WHERE started_from_doc_id = ?").run(docId);
    db.prepare("DELETE FROM conditions WHERE first_doc_id = ?").run(docId);
  });
  run();
}

/**
 * Sync appointments from appointments.json into the database.
 * Splits dtAppointmentDate into date (YYYY-MM-DD) and time (HH:MM).
 */
export function syncAppointmentsFromJson(jsonPath) {
  const raw = readFileSync(jsonPath, "utf-8");
  const items = JSON.parse(raw);

  const mapped = items.map(item => {
    const dt = item.dtAppointmentDate ?? "";
    const [datePart, timePart] = dt.split("T");
    return {
      sheba_doc_id: item.sDocID,
      appointment_type: item.sAppointmentType ?? null,
      service: item.Service ?? null,
      location: item.sLocationDesc ?? null,
      appointment_date: datePart,
      appointment_time: timePart ? timePart.slice(0, 5) : null,
      status: item.sAppointmentStatus ?? "NEW",
      invite_pdf_path: null,
    };
  });

  upsertAppointments(mapped);
  return mapped.length;
}

// ─── Additional Queries ─────────────────────────────────────────

export function getRecentDocuments(limit = 10) {
  const db = initDB();
  return db.prepare(`
    SELECT d.*, s.name AS specialty
    FROM documents d
    LEFT JOIN specialties s ON d.specialty_id = s.id
    ORDER BY d.processed_at DESC
    LIMIT ?
  `).all(limit);
}

export function getAllAppointments() {
  const db = initDB();
  return db.prepare("SELECT * FROM appointments ORDER BY appointment_date ASC").all();
}
