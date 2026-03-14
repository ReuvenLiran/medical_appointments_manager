# ShebaConnect Tool

A health intelligence platform that integrates with Sheba Medical Center (Clalit Healthcare, Israel) to fetch appointments, process medical documents, and provide AI-powered cross-specialty health insights.

## Features

- **Appointment Fetching** — Automated login to Sheba Connect portal with reCAPTCHA solving and OTP verification
- **Medical Document Processing** — PDF text extraction with configurable PII redaction
- **AI Entity Extraction** — Structured extraction of medications, conditions, recommendations, and tests using Google Gemini
- **Drug Interaction Detection** — Hardcoded rules + AI-powered supplementary checks for dangerous combinations
- **Cross-Specialty Awareness** — Flags condition-treatment conflicts across different medical specialties
- **Recommendation Matching** — AI-powered matching of medical recommendations to scheduled appointments
- **Health Dashboard** — CLI dashboard showing medications, conditions, upcoming appointments, and alerts
- **Semantic Search** — Full-text search (FTS5) and Gemini-powered natural language queries over health records
- **Privacy-First** — PII detection runs locally via Ollama; medical text is redacted before cloud API calls

## Architecture

```
┌─────────────────────┐
│   Sheba Connect API │
│  (appointments.json)│
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐     ┌──────────────────────┐
│  index.mjs          │────▶│  Downloaded PDFs      │
│  (Auth & Fetch)     │     └──────────────────────┘
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  ingest.mjs         │
│  (Pipeline)         │
└──────────┬──────────┘
           │
    ┌──────┴──────┐
    ▼              ▼
┌──────────────┐  ┌───────────────┐
│ entity-      │  │ normalize.mjs │
│ extractor.mjs│  │ (Dedup)       │
│ (Gemini AI)  │  └───────────────┘
└──────┬───────┘
       │
       ▼
┌─────────────────────┐
│    health.db        │
│    (SQLite)         │
└──────────┬──────────┘
           │
    ┌──────┼───────────┬─────────────┐
    ▼      ▼           ▼             ▼
dashboard  query.mjs   health-       sync-
.mjs       (Search)    graph.mjs     appointments
(CLI)                  (Intelligence) .mjs
```

## Prerequisites

- **Node.js** 18+
- **Ollama** running locally with a model (default: `llama3.1:8b`) for PII detection
- **Google Gemini API key** for entity extraction and health intelligence
- Local npm packages:
  - `pii-tools` at `../pii-tools`
  - `sms-client` at `../sms-forwarder/client`

## Installation

```bash
git clone https://github.com/ReuvenLiran/medical_appointments_manager.git shebaconnect-tool
cd shebaconnect-tool
npm install
```

## Configuration

Create a `.env` file in the project root:

```env
SHEBA_PATIENT_ID=your_israeli_id
SHEBA_MOBILE=your_phone_number
PATIENT_FULL_NAME=your_full_name        # optional
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.1-pro-preview     # optional
OLLAMA_MODEL=llama3.1:8b                # optional
```

## Usage

### Fetch Appointments

```bash
npm start
```

Authenticates with Sheba Connect, solves reCAPTCHA, verifies OTP via SMS, and downloads appointment PDFs.

### Process Medical Documents

```bash
# Process a single PDF
node ingest.mjs path/to/document.pdf

# Process all PDFs in a directory
node ingest.mjs path/to/directory/

# Remove a document and its entities
node ingest.mjs --remove path/to/document.pdf

# Dry run (no database changes)
node ingest.mjs --dry-run path/to/document.pdf
```

### Health Dashboard

```bash
node dashboard.mjs
```

Displays active medications, conditions, upcoming appointments, pending recommendations, and alerts with severity badges.

### Search & Query

```bash
# Full-text search
node query.mjs search "MRI"

# Semantic query (Hebrew or English)
node query.mjs ask "what medications am I taking for MS?"
```

### Sync Appointments

```bash
node sync-appointments.mjs
```

Imports `appointments.json` into the database and runs recommendation-to-appointment matching.

### Test Pipeline

```bash
node test-pipeline.mjs [path/to/test.pdf]
```

## Database Schema

| Table | Description |
|-------|-------------|
| `specialties` | Medical specialties (neurology, ophthalmology, etc.) |
| `documents` | Ingested PDFs with redacted text and summaries |
| `documents_fts` | FTS5 full-text search index |
| `medications` | Tracked medications with status (active/discontinued/changed) |
| `conditions` | Diagnosed conditions with status (active/resolved/monitoring) |
| `recommendations` | Follow-up recommendations (tests, referrals, medication changes) |
| `appointments` | Scheduled appointments from Sheba |
| `alerts` | Drug interactions, condition conflicts, unmatched recommendations |
| `entity_links` | Relationship graph (treats, caused_by, monitors, interacts_with) |
| `recommendation_matches` | Links between recommendations and matching appointments |

## Key Modules

| Module | Lines | Description |
|--------|-------|-------------|
| `index.mjs` | ~350 | Sheba API authentication, reCAPTCHA, OTP, PDF download |
| `db.mjs` | ~600 | Database schema, CRUD, FTS5, entity resolution |
| `entity-extractor.mjs` | ~250 | PDF parsing, PII redaction, Gemini entity extraction |
| `health-graph.mjs` | ~400 | Drug interactions, conflicts, recommendation matching |
| `ingest.mjs` | ~200 | Pipeline orchestration (extract, store, health check) |
| `dashboard.mjs` | ~150 | ANSI-colored CLI health status display |
| `query.mjs` | ~170 | FTS5 search and Gemini semantic queries |
| `normalize.mjs` | ~160 | Hebrew/English medical term normalization |
| `sync-appointments.mjs` | ~50 | Appointment import and recommendation matching |

## Privacy & Security

- **Local PII detection**: Ollama runs locally — medical text never leaves your machine for PII analysis
- **Redaction before cloud**: All text is redacted before being sent to Gemini API
- **Configurable redaction**: Choose which PII categories to redact (names, IDs, phones, addresses, emails)
- **Local database**: Health data stored in local SQLite — no cloud database
- **Sensitive files gitignored**: `.env`, `health.db`, `appointments.json`, medical PDFs, and redacted outputs are all excluded from version control
