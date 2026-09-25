"use strict";
/**
 * Minimal, dependency-free local server for the White Mountain Handyman scheduler.
 *
 * What it does:
 *  - Serves the static app files (index.html, landing.html, customer-intake-form.html, images).
 *  - Holds the scheduler data (customers, jobs, photos, notes) in server memory and
 *    persists it to disk (server/data/state.json) so it survives restarts.
 *  - Accepts customer intake form submissions directly over HTTP (POST /api/intake)
 *    instead of relying on the customer emailing a JSON file back. The moment a customer
 *    hits Submit, the server creates the matching customer + job records in state.json
 *    so the scheduler's fields are populated automatically — no manual import step.
 *
 * Run with: node server.js   (or "npm start" from this folder)
 * Then open: http://localhost:3000/index.html
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const ROOT_DIR = path.join(__dirname, "..");
const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const INTAKE_FILE = path.join(DATA_DIR, "intake-log.json");

const MAX_STATE_BYTES = 25 * 1024 * 1024; // schedule data + photos
const MAX_INTAKE_BYTES = 5 * 1024 * 1024; // a single intake submission

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const DEFAULT_STATE = { version: 1, businessNotes: "", customers: [], jobs: [], photos: [] };

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) fs.writeFileSync(STATE_FILE, JSON.stringify(DEFAULT_STATE, null, 2));
  if (!fs.existsSync(INTAKE_FILE)) fs.writeFileSync(INTAKE_FILE, JSON.stringify([], null, 2));
}

function readJsonFile(file, fallback) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("Payload too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJsonBody(req, maxBytes) {
  const text = await readRequestBody(req, maxBytes);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { statusCode: 400 });
  }
}

function isValidState(d) {
  return d && Array.isArray(d.customers) && Array.isArray(d.jobs) && Array.isArray(d.photos);
}

function cleanText(v, max = 5000) {
  return String(v ?? "").slice(0, max);
}

// --- Static file serving -------------------------------------------------

function serveStatic(req, res, urlPath) {
  let relPath = decodeURIComponent(urlPath.split("?")[0]);
  if (relPath === "/" || relPath === "") relPath = "/index.html";
  const safeRel = path.normalize(relPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(ROOT_DIR, safeRel);

  // Prevent path traversal outside the schedule/ directory.
  if (!filePath.startsWith(ROOT_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}

// --- API handlers ----------------------------------------------------------

async function handleGetState(req, res) {
  const state = readJsonFile(STATE_FILE, DEFAULT_STATE);
  sendJson(res, 200, state);
}

async function handlePutState(req, res) {
  const body = await readJsonBody(req, MAX_STATE_BYTES);
  if (!isValidState(body)) {
    sendJson(res, 400, { error: "Body must include customers[], jobs[], and photos[] arrays." });
    return;
  }
  const state = {
    version: 1,
    businessNotes: cleanText(body.businessNotes, 20000),
    customers: body.customers,
    jobs: body.jobs,
    photos: body.photos
  };
  writeJsonFile(STATE_FILE, state);
  sendJson(res, 200, { ok: true, savedAt: new Date().toISOString() });
}

async function handleGetIntakeLog(req, res) {
  const log = readJsonFile(INTAKE_FILE, []);
  sendJson(res, 200, log);
}

// Creates the customer + job immediately so the scheduler is populated as soon as the
// customer hits Submit — no manual import step. The log entry is kept for visibility only.
async function handlePostIntake(req, res) {
  const body = await readJsonBody(req, MAX_INTAKE_BYTES);
  const customer = body.customer || {};
  const job = body.job || {};

  const name = cleanText(customer.name, 200).trim();
  const title = cleanText(job.title, 200).trim();
  if (!name || !title) {
    sendJson(res, 400, { error: "Customer name and job title are required." });
    return;
  }

  const cleanCustomer = {
    name,
    phone: cleanText(customer.phone, 60).trim(),
    email: cleanText(customer.email, 200).trim(),
    address: cleanText(customer.address, 300).trim()
  };
  const cleanJob = {
    title,
    description: cleanText(job.description, 5000).trim(),
    materials: cleanText(job.materials, 5000).trim(),
    preferredDate: cleanText(job.preferredDate, 20).trim()
  };

  const state = readJsonFile(STATE_FILE, DEFAULT_STATE);
  const customerId = Date.now();
  const jobId = customerId + 1;
  state.customers.push({ id: customerId, ...cleanCustomer });
  state.jobs.push({
    id: jobId,
    customerId,
    title: cleanJob.title,
    description: cleanJob.description,
    materials: cleanJob.materials,
    estimate: 0,
    scheduledDate: cleanJob.preferredDate || "",
    status: "scheduled"
  });
  writeJsonFile(STATE_FILE, state);

  const entry = {
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    customerId,
    jobId,
    customer: cleanCustomer,
    job: cleanJob
  };
  const log = readJsonFile(INTAKE_FILE, []);
  log.push(entry);
  writeJsonFile(INTAKE_FILE, log);

  sendJson(res, 201, { ok: true, id: entry.id, customerId, jobId });
}

// Removes a log entry only; the customer/job it already created stays in state.json.
async function handleDeleteIntakeLogEntry(req, res, id) {
  const log = readJsonFile(INTAKE_FILE, []);
  const next = log.filter(e => e.id !== id);
  if (next.length === log.length) {
    sendJson(res, 404, { error: "Log entry not found." });
    return;
  }
  writeJsonFile(INTAKE_FILE, next);
  sendJson(res, 200, { ok: true });
}

// --- Router ------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = req.url || "/";

  try {
    if (url === "/api/state" && req.method === "GET") return await handleGetState(req, res);
    if (url === "/api/state" && req.method === "PUT") return await handlePutState(req, res);
    if (url === "/api/intake" && req.method === "GET") return await handleGetIntakeLog(req, res);
    if (url === "/api/intake" && req.method === "POST") return await handlePostIntake(req, res);

    const deleteMatch = url.match(/^\/api\/intake\/([^/]+)$/);
    if (deleteMatch && req.method === "DELETE") return await handleDeleteIntakeLogEntry(req, res, deleteMatch[1]);

    if (url.startsWith("/api/")) {
      sendJson(res, 404, { error: "Unknown API route." });
      return;
    }

    serveStatic(req, res, url);
  } catch (err) {
    const statusCode = err.statusCode || 500;
    sendJson(res, statusCode, { error: err.message || "Server error" });
  }
});

ensureDataFiles();
server.listen(PORT, () => {
  console.log(`White Mountain scheduler server running at http://localhost:${PORT}/index.html`);
  console.log(`Data stored in ${DATA_DIR}`);
});
