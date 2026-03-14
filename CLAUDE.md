# ShebaConnect Tool

Health intelligence platform that fetches appointments from Sheba Medical Center, processes medical PDFs with PII redaction, and provides cross-specialty health intelligence via Google Gemini AI.

## Tech Stack

- **Runtime**: Node.js (ESM modules, `.mjs` extension)
- **Database**: SQLite via better-sqlite3 (WAL mode, FTS5 full-text search)
- **AI**: Google Gemini API (entity extraction, health intelligence, semantic queries)
- **PII Detection**: Ollama (local LLM, default: llama3.1:8b)
- **Web Automation**: Puppeteer + stealth plugin (reCAPTCHA solving, appointment fetching)
- **Local Packages**: `pii-tools` (../pii-tools), `sms-client` (../sms-forwarder/client)

## Commands

| Command | Description |
|---------|-------------|
| `npm start` | Authenticate with Sheba and fetch appointments (auto OTP) |
| `node ingest.mjs <pdf-or-dir>` | Process PDFs: extract text, redact PII, extract entities, store in DB |
| `node ingest.mjs --remove <pdf>` | Remove a document and its entities from DB |
| `node dashboard.mjs` | Display health status dashboard (medications, conditions, alerts) |
| `node query.mjs search "term"` | Full-text search medical documents |
| `node query.mjs ask "question"` | Semantic query with Gemini (Hebrew/English) |
| `node sync-appointments.mjs` | Import appointments.json and run recommendation matching |
| `node test-pipeline.mjs [pdf]` | Test full pipeline with a sample PDF |

## Architecture

| Module | Role |
|--------|------|
| `index.mjs` | Authentication, OTP handling, appointment fetching, PDF download |
| `entity-extractor.mjs` | PDF text extraction, PII redaction, Gemini-powered entity extraction |
| `db.mjs` | SQLite schema, CRUD operations, FTS5 search, entity resolution |
| `health-graph.mjs` | Drug interactions, condition conflicts, recommendation-appointment matching |
| `ingest.mjs` | Production pipeline orchestrating extraction, storage, and health checks |
| `dashboard.mjs` | ANSI-colored CLI health status display |
| `query.mjs` | FTS5 search and Gemini semantic query interface |
| `sync-appointments.mjs` | Import appointments and match to recommendations |
| `normalize.mjs` | Hebrew/English medical entity normalization, deduplication |

## Environment Variables (.env)

- `SHEBA_PATIENT_ID` — Israeli ID number (required for Sheba API)
- `SHEBA_MOBILE` — Phone number for SMS OTP (required)
- `PATIENT_FULL_NAME` — Optional, used for PII detection
- `GEMINI_API_KEY` — Google AI API key (required for entity extraction and health intelligence)
- `GEMINI_MODEL` — Model name (default: gemini-3.1-flash-lite-preview)
- `OLLAMA_MODEL` — Local LLM for PII detection (default: llama3.1:8b)

## Key Patterns

- **Immutable medications**: Medication status changes create new records; old records are marked discontinued with a link to the new record. Never update medication records in-place.
- **PII-first design**: All medical text is redacted before being sent to cloud APIs. PII detection runs locally via Ollama.
- **Local-first**: SQLite database and Ollama keep data local. Only Gemini API calls go to cloud.
- **Hebrew language support**: Entity extraction, normalization, and UI handle Hebrew medical terminology with diacritical mark stripping.
- **Cascading deletes**: Removing a document cascades to all extracted entities (medications, conditions, recommendations).

## Database

SQLite database at `health.db` with tables: `specialties`, `documents`, `documents_fts`, `medications`, `conditions`, `recommendations`, `appointments`, `alerts`, `entity_links`, `recommendation_matches`.

## No Build Step

Pure ESM JavaScript — no transpilation, bundling, or build process. No linter or test framework configured.
