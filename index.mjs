import "dotenv/config";
import { createInterface } from "readline/promises";
import { randomUUID } from "crypto";
import { writeFileSync, mkdirSync } from "fs";
import { SmsClient } from "sms-client";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

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

puppeteer.use(StealthPlugin());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

async function humanType(page, selector, text) {
  await humanClick(page, selector);
  await sleep(rand(300, 600));
  for (const ch of text) {
    await page.keyboard.type(ch);
    await sleep(rand(80, 220));
  }
  await sleep(rand(400, 800));
}

async function humanMove(page, targetX, targetY, steps = 25) {
  const start = await page.evaluate(() => ({
    x: window.__lastMouseX || 100,
    y: window.__lastMouseY || 100,
  }));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = start.x + (targetX - start.x) * t + rand(-3, 3);
    const y = start.y + (targetY - start.y) * t + rand(-2, 2);
    await page.mouse.move(x, y);
    await sleep(rand(10, 30));
  }
  await page.evaluate((x, y) => {
    window.__lastMouseX = x;
    window.__lastMouseY = y;
  }, targetX, targetY);
}

async function humanClick(page, selector) {
  const el = await page.waitForSelector(selector);
  const box = await el.boundingBox();
  const x = box.x + box.width / 2 + rand(-3, 3);
  const y = box.y + box.height / 2 + rand(-2, 2);
  await humanMove(page, x, y);
  await sleep(rand(100, 300));
  await page.mouse.click(x, y);
}

async function solveRecaptcha() {
  const browser = await puppeteer.launch({
    headless: false,
    args: ["--window-size=700,600"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 700, height: 600 });

  await page.goto("https://shebaconnect.sheba.co.il", { waitUntil: "networkidle0" });
  await sleep(rand(1500, 2500));

  await page.waitForSelector("#idNumber", { timeout: 10000 });

  await humanType(page, "#idNumber", PATIENT_ID);
  await sleep(rand(500, 1000));
  await humanType(page, "#phoneNumber", MOBILE);
  await sleep(rand(800, 1500));

  const submitBtn = await page.waitForSelector("button.login-submit");
  await submitBtn.scrollIntoViewIfNeeded();
  await sleep(rand(300, 600));
  await humanClick(page, "button.login-submit");

  await page.waitForSelector("re-captcha, iframe[src*='recaptcha'], .g-recaptcha", { timeout: 20000 });
  await page.waitForSelector("iframe[src*='recaptcha']", { timeout: 15000 });
  await sleep(rand(2000, 4000));

  await humanMove(page, rand(200, 400), rand(200, 300));
  await sleep(rand(500, 1000));
  await humanMove(page, rand(100, 300), rand(250, 350));
  await sleep(rand(1000, 2000));

  const recaptchaEl = await page.waitForSelector("iframe[title='reCAPTCHA']");
  const recaptchaBox = await recaptchaEl.boundingBox();
  const checkboxX = recaptchaBox.x + 33 + rand(-4, 4);
  const checkboxY = recaptchaBox.y + 33 + rand(-4, 4);
  await humanMove(page, checkboxX, checkboxY, 35);
  await sleep(rand(200, 500));
  await page.mouse.click(checkboxX, checkboxY);

  const token = await page.evaluate(() => {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("reCAPTCHA timeout")), 120000);
      const check = setInterval(() => {
        try {
          const resp = grecaptcha.getResponse();
          if (resp) { clearInterval(check); clearTimeout(timeout); resolve(resp); }
        } catch {}
      }, 500);
    });
  });

  await browser.close();
  return token;
}

async function sendOTP(recaptchaToken = "") {
  console.log(`Sending OTP to ${MOBILE}...`);
  const data = await apiPost("/Authentication/SendOTPByMobile", {
    PatientID: PATIENT_ID,
    IsVoiceMailChecked: false,
    Mobile: MOBILE,
    GRecaptchaResponse: recaptchaToken,
  });

  if (!data.Success) {
    console.error("SendOTP response:", JSON.stringify(data, null, 2));
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

const sms = new SmsClient();

async function prompt(rl, message) {
  const answer = await rl.question(message);
  return answer.trim();
}

async function main() {
  const autoOtp = process.argv.includes("--auto-otp");
  const rl = autoOtp ? null : createInterface({ input: process.stdin, output: process.stdout });

  try {
    try {
      await sendOTP();
    } catch {
      console.log("Captcha required, opening browser...");
      const recaptchaToken = await solveRecaptcha();
      await sendOTP(recaptchaToken);
    }

    let otpCode;
    if (autoOtp) {
      console.log("\nWaiting for OTP from SMS Forwarder...");
      otpCode = await sms.waitForOtp({
        senderPattern: "ShebaOTP",
        otpPattern: "#(\\d{6})",
      });
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
  }
}

main();
