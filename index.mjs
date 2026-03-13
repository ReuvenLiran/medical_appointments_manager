import "dotenv/config";
import { createInterface } from "readline/promises";
import { randomUUID } from "crypto";
import { writeFileSync, mkdirSync } from "fs";
import { startServer, waitForOtp, stopServer } from "./sms-server.mjs";

const BASE_URL = "https://shebaconnect.sheba.co.il/SCDmzService.API/api";
const SESSION_IP = randomUUID();

const PATIENT_ID = process.env.SHEBA_PATIENT_ID;
const MOBILE = process.env.SHEBA_MOBILE;

if (!PATIENT_ID || PATIENT_ID === "YOUR_ID_HERE") {
  console.error("Set SHEBA_PATIENT_ID in .env");
  process.exit(1);
}
if (!MOBILE || MOBILE === "YOUR_PHONE_HERE") {
  console.error("Set SHEBA_MOBILE in .env");
  process.exit(1);
}

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/plain, */*",
  ipaddress: SESSION_IP,
  Origin: "https://shebaconnect.sheba.co.il",
  Referer: "https://shebaconnect.sheba.co.il/",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0",
};

async function apiPost(endpoint, body) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`Response body: ${body}`);
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

async function sendOTP() {
  console.log(`Sending OTP to ${MOBILE}...`);
  const data = await apiPost("/Authentication/SendOTPByMobile", {
    PatientID: PATIENT_ID,
    IsVoiceMailChecked: false,
    Mobile: MOBILE,
    GRecaptchaResponse: "",
  });

  if (!data.Success) {
    throw new Error(`SendOTP failed: ${data.Error?.Description || "unknown error"}`);
  }

  console.log("OTP sent successfully.");
  return data.Payload.GAToken;
}

async function verifyOTP(otpCode) {
  console.log("Verifying OTP...");
  const data = await apiPost("/Authentication/LoginUserByOTP", {
    PatientID: PATIENT_ID,
    OTPPassword: otpCode,
    UserToken: null,
  });

  if (!data.Success) {
    throw new Error(`Login failed: ${data.Error?.Description || "unknown error"}`);
  }

  const info = data.Payload.oLoginInfo;
  console.log(`Logged in as ${info.FirstName} ${info.SurName}`);
  return data.Payload.UserToken;
}

async function getAppointments(userToken, { future = true } = {}) {
  const now = new Date();
  let from, to;

  if (future) {
    from = new Date(now);
    from.setHours(0, 0, 0, 0);
    to = new Date(now);
    to.setFullYear(to.getFullYear() + 1);
    to.setMonth(to.getMonth() + 6);
  } else {
    from = new Date(now);
    from.setFullYear(from.getFullYear() - 1);
    to = new Date(now);
    to.setHours(23, 59, 59, 0);
  }

  const paddedID = PATIENT_ID.padStart(10, "0");
  const data = await apiPost("/Document/GetAppointmentDocuments", {
    dtDocumentDateRangeFrom: from.toISOString(),
    dtDocumentDateRangeTo: to.toISOString(),
    eDocType: 2,
    UserToken: userToken,
    PatientID: paddedID,
  });

  if (!data.Success) {
    throw new Error(`GetAppointments failed: ${data.Error?.Description || "unknown error"}`);
  }

  const list = data.Payload?.lDocumentlist?.list || [];
  return {
    appointments: list.map((item) => item[0]),
    userToken: data.Payload?.UserToken,
  };
}

async function downloadInvite(appt, userToken) {
  const paddedID = PATIENT_ID.padStart(10, "0");
  const data = await apiPost("/Document/GetSingleDocument", {
    DocDate: appt.dtCreatedOn,
    DocType: 2,
    DocVersion: appt.sDocVersion,
    objectGUID: appt.objectGUID,
    UserToken: userToken,
    PatientID: paddedID,
  });

  if (!data.Success) {
    console.error(`Download error response:`, JSON.stringify(data));
    throw new Error(`Download failed for ${appt.sDocID}: ${data.Error?.Description || "unknown"}`);
  }

  const pdfBuffer = Buffer.from(data.Payload.arrDoc, "base64");
  const d = new Date(appt.dtAppointmentDate);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  let name;
  if (appt.sLocationDesc === "מרכז לטרשת נפוצה" && appt.Service === "אחות בחדר טיפולים") {
    name = "טיפול טרשת נפוצה";
  } else if (appt.Service) {
    name = `${appt.sAppointmentType} - ${appt.Service}`;
  } else {
    name = appt.sAppointmentType;
  }
  const filename = `${name} - ${dd}-${mm}-${yyyy}.pdf`;

  writeFileSync(`זימונים/${filename}`, pdfBuffer);
  console.log(`  Saved: ${filename}`);

  return data.Payload.UserToken;
}

function formatDate(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleDateString("he-IL", {
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function printAppointments(appointments) {
  if (!appointments.length) {
    console.log("No appointments found.");
    return;
  }

  const sorted = [...appointments].sort(
    (a, b) => new Date(a.dtAppointmentDate) - new Date(b.dtAppointmentDate)
  );

  console.log("\n" + "=".repeat(70));
  console.log(` Found ${sorted.length} appointment(s)`);
  console.log("=".repeat(70));

  for (const appt of sorted) {
    console.log();
    console.log(`  Date:     ${formatDate(appt.dtAppointmentDate)}`);
    console.log(`  Type:     ${appt.sAppointmentType}`);
    console.log(`  Service:  ${appt.Service}`);
    console.log(`  Location: ${appt.sLocationDesc}`);
    console.log(`  Status:   ${appt.sAppointmentStatus}`);
    console.log(`  ID:       ${appt.sDocID}`);
    console.log("  " + "-".repeat(50));
  }
}

async function prompt(rl, message) {
  const answer = await rl.question(message);
  return answer.trim();
}

async function main() {
  const autoOtp = process.argv.includes("--auto-otp");
  const rl = autoOtp ? null : createInterface({ input: process.stdin, output: process.stdout });

  try {
    if (autoOtp) {
      await startServer();
    }

    await sendOTP();

    let otpCode;
    if (autoOtp) {
      console.log("\nWaiting for OTP from SMS Forwarder...");
      otpCode = await waitForOtp();
      console.log(`Received OTP: ${otpCode}`);
    } else {
      otpCode = await prompt(rl, "\nEnter the SMS code: ");
    }
    const userToken = await verifyOTP(otpCode);

    console.log("\nFetching future appointments...");
    const result = await getAppointments(userToken, { future: true });
    const futureAppts = result.appointments;
    printAppointments(futureAppts);

    if (futureAppts.length) {
      writeFileSync("appointments.json", JSON.stringify(futureAppts, null, 2));
      console.log("\nSaved appointments.json");

      mkdirSync("זימונים", { recursive: true });
      console.log("Downloading invites...");
      let token = result.userToken;
      for (const appt of futureAppts) {
        token = await downloadInvite(appt, token);
      }
      console.log("Done!");
    }
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  } finally {
    if (rl) rl.close();
    if (autoOtp) stopServer();
  }
}

main();
