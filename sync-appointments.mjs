#!/usr/bin/env node
/**
 * Standalone appointment sync: imports appointments.json into the database
 * and runs recommendation matching.
 *
 * Usage: node sync-appointments.mjs [path-to-appointments.json]
 */
import { join, resolve } from "path";
import { existsSync } from "fs";
import {
  initDB,
  syncAppointmentsFromJson,
  getFutureAppointments,
} from "./db.mjs";
import { matchRecommendationsToAppointments, findAndAlertUnmatchedRecommendations } from "./health-graph.mjs";

const jsonPath = process.argv[2]
  ? resolve(process.argv[2])
  : join(resolve("."), "appointments.json");

if (!existsSync(jsonPath)) {
  console.error(`File not found: ${jsonPath}`);
  process.exit(1);
}

initDB();

console.log(`Syncing appointments from ${jsonPath}...`);
const count = syncAppointmentsFromJson(jsonPath);
console.log(`Synced ${count} appointment(s).`);

const apts = getFutureAppointments();
console.log(`\nFuture appointments: ${apts.length}`);
for (const a of apts) {
  const time = a.appointment_time ? ` ${a.appointment_time}` : "";
  const pdf = a.invite_pdf_path ? " [PDF linked]" : "";
  console.log(`  ${a.appointment_date}${time}  ${a.appointment_type}${pdf}`);
  if (a.location) console.log(`    📍 ${a.location}`);
}

console.log("\n── Recommendation Matching ──");
await matchRecommendationsToAppointments();

console.log("\n── Unmatched Recommendations ──");
findAndAlertUnmatchedRecommendations();

console.log("\nDone.");
