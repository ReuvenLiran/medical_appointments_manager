#!/usr/bin/env node
/**
 * CLI Health Status Dashboard.
 * Displays active medications, conditions, appointments, recommendations, and alerts.
 *
 * Usage: node dashboard.mjs
 */
import {
  initDB,
  getActiveMedications,
  getActiveConditions,
  getFutureAppointments,
  getPendingRecommendations,
  getUnmatchedRecommendations,
  getUnresolvedAlerts,
  getRecentDocuments,
  getAllAppointments,
} from "./db.mjs";

// ─── ANSI Colors ────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgRed: "\x1b[41m",
  bgYellow: "\x1b[43m",
  bgGreen: "\x1b[42m",
};

function header(title) {
  console.log();
  console.log(`${C.bold}${C.cyan}╔${"═".repeat(58)}╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║${C.reset}  ${C.bold}${title.padEnd(56)}${C.cyan}║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚${"═".repeat(58)}╝${C.reset}`);
}

function section(title, count) {
  const countStr = count !== undefined ? ` (${count})` : "";
  console.log(`\n  ${C.bold}${C.white}── ${title}${countStr} ${"─".repeat(Math.max(0, 44 - title.length - countStr.length))}${C.reset}`);
}

function severityColor(severity) {
  switch (severity) {
    case "critical": return C.red;
    case "warning": return C.yellow;
    case "info": return C.blue;
    default: return C.dim;
  }
}

function severityBadge(severity) {
  switch (severity) {
    case "critical": return `${C.bgRed}${C.white} CRITICAL ${C.reset}`;
    case "warning": return `${C.bgYellow}${C.white} WARNING ${C.reset}`;
    case "info": return `${C.bgGreen}${C.white} INFO ${C.reset}`;
    default: return severity;
  }
}

// ─── Dashboard ──────────────────────────────────────────────────

function main() {
  initDB();

  const today = new Date().toISOString().slice(0, 10);
  header(`Health Dashboard — ${today}`);

  // Active Medications
  const meds = getActiveMedications();
  section("Active Medications", meds.length);
  if (meds.length === 0) {
    console.log(`    ${C.dim}No active medications.${C.reset}`);
  } else {
    // Group by specialty
    const bySpecialty = new Map();
    for (const m of meds) {
      const sp = m.prescriber_specialty || "Unknown";
      if (!bySpecialty.has(sp)) bySpecialty.set(sp, []);
      bySpecialty.get(sp).push(m);
    }
    for (const [specialty, group] of bySpecialty) {
      console.log(`    ${C.magenta}${specialty}:${C.reset}`);
      for (const m of group) {
        const dosage = m.dosage ? ` ${C.dim}${m.dosage}${C.reset}` : "";
        console.log(`      ${C.green}●${C.reset} ${m.name}${dosage}`);
      }
    }
  }

  // Active Conditions
  const conds = getActiveConditions();
  section("Active Conditions", conds.length);
  if (conds.length === 0) {
    console.log(`    ${C.dim}No active conditions.${C.reset}`);
  } else {
    for (const c of conds) {
      const status = c.status === "monitoring" ? `${C.yellow}[monitoring]${C.reset}` : `${C.red}[active]${C.reset}`;
      const specialty = c.diagnosing_specialty ? ` ${C.dim}(${c.diagnosing_specialty})${C.reset}` : "";
      console.log(`    ${status} ${c.name}${specialty}`);
    }
  }

  // Upcoming Appointments (next 30 days)
  const allApts = getFutureAppointments();
  const thirtyDaysOut = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const upcoming = allApts.filter(a => a.appointment_date <= thirtyDaysOut);
  const later = allApts.filter(a => a.appointment_date > thirtyDaysOut);

  section("Upcoming Appointments (30 days)", upcoming.length);
  if (upcoming.length === 0) {
    console.log(`    ${C.dim}No upcoming appointments in the next 30 days.${C.reset}`);
  } else {
    for (const a of upcoming) {
      const time = a.appointment_time ? ` ${a.appointment_time}` : "";
      const service = a.service ? ` ${C.dim}— ${a.service}${C.reset}` : "";
      console.log(`    ${C.blue}${a.appointment_date}${time}${C.reset}  ${a.appointment_type}${service}`);
      if (a.location) {
        console.log(`      ${C.dim}📍 ${a.location}${C.reset}`);
      }
    }
  }

  if (later.length > 0) {
    section("Later Appointments", later.length);
    for (const a of later) {
      const time = a.appointment_time ? ` ${a.appointment_time}` : "";
      const service = a.service ? ` ${C.dim}— ${a.service}${C.reset}` : "";
      console.log(`    ${C.dim}${a.appointment_date}${time}${C.reset}  ${a.appointment_type}${service}`);
    }
  }

  // Pending Recommendations
  const recs = getPendingRecommendations();
  const unmatched = getUnmatchedRecommendations();
  section("Pending Recommendations", recs.length);
  if (recs.length === 0) {
    console.log(`    ${C.dim}No pending recommendations.${C.reset}`);
  } else {
    for (const r of recs) {
      const isUnmatched = unmatched.some(u => u.id === r.id);
      const badge = isUnmatched
        ? `${C.yellow}⚠ UNMATCHED${C.reset}`
        : `${C.green}✓ matched${C.reset}`;
      console.log(`    [${C.cyan}${r.type}${C.reset}] ${r.description} ${badge}`);
      console.log(`      ${C.dim}From: ${r.requesting_specialty}${C.reset}`);
    }
  }

  // Alerts
  const alerts = getUnresolvedAlerts();
  section("Unresolved Alerts", alerts.length);
  if (alerts.length === 0) {
    console.log(`    ${C.green}✓ No unresolved alerts.${C.reset}`);
  } else {
    for (const a of alerts) {
      console.log(`    ${severityBadge(a.severity)} ${a.description}`);
      console.log(`      ${C.dim}${a.created_at}${C.reset}`);
    }
  }

  // Recent Documents
  const docs = getRecentDocuments(5);
  section("Recently Processed Documents", docs.length);
  if (docs.length === 0) {
    console.log(`    ${C.dim}No documents processed yet.${C.reset}`);
  } else {
    for (const d of docs) {
      const specialty = d.specialty ? ` ${C.magenta}(${d.specialty})${C.reset}` : "";
      const date = d.visit_date ?? d.processed_at?.slice(0, 10) ?? "";
      console.log(`    ${C.dim}${date}${C.reset} ${d.filename}${specialty}`);
    }
  }

  console.log();
  console.log(`${C.bold}${C.cyan}${"─".repeat(60)}${C.reset}`);
}

main();
