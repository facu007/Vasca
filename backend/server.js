const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const tls = require("node:tls");
const { URL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");

const ROOT_DIR = path.resolve(__dirname, "..");
const FRONTEND_DIR = path.join(ROOT_DIR, "frontend");
const DB_PATH = path.join(__dirname, "db", "vasca.sqlite");
const SCHEMA_PATH = path.join(__dirname, "db", "schema.sql");
const SEED_PATH = path.join(__dirname, "db", "seed.sql");

loadEnv(path.join(__dirname, ".env"));

const config = {
  port: Number(process.env.PORT || 3000),
  sessionSecret: process.env.SESSION_SECRET || "change-me-session-secret",
  appBaseUrl: process.env.APP_BASE_URL || "http://localhost:3000",
  gmailUser: process.env.GMAIL_USER || "",
  gmailAppPassword: process.env.GMAIL_APP_PASSWORD || "",
  businessEmail: process.env.BUSINESS_EMAIL || ""
};

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON;");
db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
migrateUsersRemoveGoogleIdIfNeeded(db);

const hasEmployees = db.prepare("SELECT COUNT(*) AS count FROM employees").get().count;
if (!hasEmployees) {
  db.exec(fs.readFileSync(SEED_PATH, "utf8"));
}

const sessions = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url, config.appBaseUrl);

    const path = reqUrl.pathname;
    const needsCors =
      req.method === "OPTIONS" && (path.startsWith("/api/") || path.startsWith("/auth/"));
    if (needsCors) {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400"
      });
      return res.end();
    }

    if (reqUrl.pathname === "/auth/verify" && req.method === "GET") {
      return handleMagicVerify(reqUrl, res);
    }

    if (reqUrl.pathname === "/api/auth/magic-link" && req.method === "POST") {
      return handleMagicLinkRequest(req, res);
    }

    if (reqUrl.pathname === "/api/auth/register" && req.method === "POST") {
      return handleRegister(req, res);
    }

    if (reqUrl.pathname === "/api/session" && req.method === "GET") {
      return handleSession(req, res);
    }

    if (reqUrl.pathname === "/api/logout" && req.method === "POST") {
      return handleLogout(req, res);
    }

    if (reqUrl.pathname === "/api/employees" && req.method === "GET") {
      return sendJson(res, 200, {
        employees: db.prepare("SELECT id, name FROM employees WHERE is_active = 1 ORDER BY id").all()
      });
    }

    if (reqUrl.pathname === "/api/services" && req.method === "GET") {
      return sendJson(res, 200, {
        services: db.prepare("SELECT id, name, description, duration_minutes, price_ars FROM services WHERE is_active = 1 ORDER BY id").all()
      });
    }

    if (reqUrl.pathname === "/api/slots" && req.method === "GET") {
      return handleSlots(reqUrl, res);
    }

    if (reqUrl.pathname === "/api/appointments" && req.method === "POST") {
      return handleCreateAppointment(req, res);
    }

    if (reqUrl.pathname === "/api/appointments/me" && req.method === "GET") {
      return handleMyAppointments(req, res);
    }

    return serveStatic(reqUrl.pathname, res);
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: "Error interno del servidor." });
  }
});

server.listen(config.port, () => {
  console.log(`Vasca turnos corriendo en ${config.appBaseUrl}`);
});

function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean || clean.startsWith("#")) continue;
    const idx = clean.indexOf("=");
    if (idx < 1) continue;
    const key = clean.slice(0, idx).trim();
    const value = clean.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

function migrateUsersRemoveGoogleIdIfNeeded(database) {
  let hasGoogleId = false;
  try {
    const cols = database.prepare("PRAGMA table_info(users)").all();
    hasGoogleId = cols.some((c) => c.name === "google_id");
  } catch {
    return;
  }
  if (!hasGoogleId) return;

  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE users__new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO users__new (id, email, name, created_at)
    SELECT id, email, name, created_at FROM users;
    DROP TABLE users;
    ALTER TABLE users__new RENAME TO users;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

function toBase64Url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64UrlToBuffer(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  const padded = pad ? b64 + "=".repeat(4 - pad) : b64;
  return Buffer.from(padded, "base64");
}

function signMagicToken(payload) {
  const payloadB64 = toBase64Url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = crypto.createHmac("sha256", config.sessionSecret).update(payloadB64).digest();
  const sigB64 = toBase64Url(sig);
  return `${payloadB64}.${sigB64}`;
}

function verifyMagicToken(token) {
  if (!token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  let expected;
  try {
    expected = toBase64Url(crypto.createHmac("sha256", config.sessionSecret).update(payloadB64).digest());
  } catch {
    return null;
  }
  const expBuf = Buffer.from(expected, "utf8");
  const sigBuf = Buffer.from(sigB64, "utf8");
  if (expBuf.length !== sigBuf.length) return null;
  if (!crypto.timingSafeEqual(expBuf, sigBuf)) return null;
  let payload;
  try {
    payload = JSON.parse(fromBase64UrlToBuffer(payloadB64).toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload.email !== "string" || typeof payload.name !== "string") return null;
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
  return payload;
}

function sanitizeRedirectPath(redirect) {
  const s = String(redirect || "").trim();
  if (!s.startsWith("/") || s.startsWith("//")) return "/turnos.html";
  return s;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  for (const pair of raw.split(";")) {
    const [k, ...rest] = pair.trim().split("=");
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join("="));
  }
  return out;
}

function createSession(user) {
  const sid = crypto.randomBytes(24).toString("hex");
  sessions.set(sid, {
    user,
    createdAt: Date.now()
  });
  return sid;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const sid = cookies.sid;
  if (!sid) return null;
  return sessions.get(sid) || null;
}

function clearSession(req) {
  const cookies = parseCookies(req);
  const sid = cookies.sid;
  if (sid) sessions.delete(sid);
}

function setSessionCookie(res, sid) {
  res.setHeader("Set-Cookie", `sid=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

function sendJson(res, statusCode, data) {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  res.end(payload);
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  return JSON.parse(raw);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function upsertUserRecord(email, name) {
  const upsert = db.prepare(`
    INSERT INTO users (email, name)
    VALUES (?, ?)
    ON CONFLICT(email) DO UPDATE SET name=excluded.name
  `);
  upsert.run(email, name);
}

async function handleRegister(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: "JSON invalido." });
  }

  const email = normalizeEmail(body.email);
  const name = String(body.name || "").trim();

  if (!email || !EMAIL_RE.test(email)) {
    return sendJson(res, 400, { error: "Ingresa un correo valido." });
  }
  if (!name) {
    return sendJson(res, 400, { error: "Ingresa tu nombre." });
  }

  try {
    upsertUserRecord(email, name);
  } catch (err) {
    console.error("register:", err);
    return sendJson(res, 500, { error: "No se pudo guardar en la base de datos." });
  }

  return sendJson(res, 200, {
    ok: true,
    message: "Cuenta guardada en la base de datos. Usa «Enviar enlace» para iniciar sesion y reservar."
  });
}

async function handleMagicLinkRequest(req, res) {
  if (!config.gmailUser || !config.gmailAppPassword) {
    return sendJson(res, 503, {
      error: "Correo no configurado. Completa GMAIL_USER y GMAIL_APP_PASSWORD en backend/.env."
    });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: "JSON invalido." });
  }

  const email = normalizeEmail(body.email);
  const name = String(body.name || "").trim();
  const redirectTo = sanitizeRedirectPath(body.redirect);

  if (!email || !EMAIL_RE.test(email)) {
    return sendJson(res, 400, { error: "Ingresa un correo valido." });
  }
  if (!name) {
    return sendJson(res, 400, { error: "Ingresa tu nombre." });
  }

  const payload = {
    email,
    name,
    redirectTo,
    exp: Date.now() + MAGIC_LINK_TTL_MS
  };
  const token = signMagicToken(payload);
  const verifyUrl = new URL("/auth/verify", config.appBaseUrl);
  verifyUrl.searchParams.set("token", token);

  const text = [
    `Hola ${name},`,
    "",
    "Para entrar a Vasca y reservar tu turno, abri este enlace (vence en 15 minutos):",
    verifyUrl.toString(),
    "",
    "Si no pediste este correo, ignoralo.",
    "",
    "Vasca | Lashes & Eyebrows"
  ].join("\n");

  try {
    await sendGmailSmtp({
      from: config.gmailUser,
      to: email,
      subject: "Entra a Vasca para reservar tu turno",
      text
    });
  } catch (err) {
    console.error("Error enviando enlace de acceso:", err.message);
    return sendJson(res, 502, { error: "No se pudo enviar el correo. Intenta de nuevo mas tarde." });
  }

  return sendJson(res, 200, {
    ok: true,
    message: "Si el correo es valido, te enviamos un enlace para iniciar sesion. Revisa tambien spam."
  });
}

function handleMagicVerify(reqUrl, res) {
  const rawToken = reqUrl.searchParams.get("token");
  const payload = verifyMagicToken(rawToken);
  const fallbackRedirect = "/turnos.html";

  if (!payload) {
    return redirectWithAuthError(res, fallbackRedirect, "El enlace expiro o no es valido. Pedí uno nuevo.");
  }

  const redirectTo = sanitizeRedirectPath(payload.redirectTo);

  upsertUserRecord(payload.email, payload.name);

  const user = db.prepare("SELECT id, email, name FROM users WHERE email = ?").get(payload.email);
  const sid = createSession(user);
  setSessionCookie(res, sid);
  redirect(res, redirectTo);
}

function redirectWithAuthError(res, redirectTo, message) {
  const target = new URL(redirectTo, config.appBaseUrl);
  target.searchParams.set("auth_error", message);
  redirect(res, target.pathname + target.search);
}

function handleSession(req, res) {
  const session = getSession(req);
  if (!session) return sendJson(res, 200, { authenticated: false });
  return sendJson(res, 200, { authenticated: true, user: session.user });
}

function handleLogout(req, res) {
  clearSession(req);
  clearSessionCookie(res);
  return sendJson(res, 200, { ok: true });
}

function parseTimeToMinutes(time) {
  const [hh, mm] = time.split(":").map(Number);
  return hh * 60 + mm;
}

function minutesToTime(minutes) {
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function isToday(dateStr) {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return dateStr === `${y}-${m}-${day}`;
}

function getCurrentMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function handleSlots(reqUrl, res) {
  const date = reqUrl.searchParams.get("date");
  const employeeId = Number(reqUrl.searchParams.get("employeeId"));
  const serviceId = Number(reqUrl.searchParams.get("serviceId"));
  if (!date || !employeeId || !serviceId) {
    return sendJson(res, 400, { error: "Parámetros requeridos: date, employeeId, serviceId." });
  }

  const service = db.prepare("SELECT id, duration_minutes FROM services WHERE id = ? AND is_active = 1").get(serviceId);
  if (!service) return sendJson(res, 404, { error: "Servicio no encontrado." });

  const day = new Date(`${date}T00:00:00`);
  const weekday = day.getDay();
  const availability = db
    .prepare("SELECT start_time, end_time FROM employee_availability WHERE employee_id = ? AND weekday = ?")
    .all(employeeId, weekday);

  if (!availability.length) return sendJson(res, 200, { slots: [] });

  const booked = db
    .prepare("SELECT start_time, end_time FROM appointments WHERE employee_id = ? AND date = ? AND status = 'booked'")
    .all(employeeId, date);

  const slots = [];
  const step = 30;
  const nowMinutes = getCurrentMinutes();
  for (const row of availability) {
    const start = parseTimeToMinutes(row.start_time);
    const end = parseTimeToMinutes(row.end_time);
    for (let cursor = start; cursor + service.duration_minutes <= end; cursor += step) {
      const slotStart = minutesToTime(cursor);
      const slotEnd = minutesToTime(cursor + service.duration_minutes);
      const overlap = booked.some((b) => !(b.end_time <= slotStart || b.start_time >= slotEnd));
      const pastToday = isToday(date) && cursor <= nowMinutes;
      if (!overlap && !pastToday) slots.push({ start_time: slotStart, end_time: slotEnd });
    }
  }
  return sendJson(res, 200, { slots });
}

async function handleCreateAppointment(req, res) {
  const session = getSession(req);
  if (!session) return sendJson(res, 401, { error: "Necesitás iniciar sesión." });

  const body = await readJsonBody(req);
  const employeeId = Number(body.employeeId);
  const serviceId = Number(body.serviceId);
  const date = String(body.date || "");
  const startTime = String(body.startTime || "");
  const notes = String(body.notes || "");

  if (!employeeId || !serviceId || !date || !startTime) {
    return sendJson(res, 400, { error: "Faltan datos obligatorios para reservar." });
  }

  const employee = db.prepare("SELECT id, name FROM employees WHERE id = ? AND is_active = 1").get(employeeId);
  const service = db.prepare("SELECT id, name, duration_minutes, price_ars FROM services WHERE id = ? AND is_active = 1").get(serviceId);
  if (!employee || !service) return sendJson(res, 404, { error: "Empleado o servicio no válido." });

  const startMinutes = parseTimeToMinutes(startTime);
  const endTime = minutesToTime(startMinutes + service.duration_minutes);

  const day = new Date(`${date}T00:00:00`);
  const weekday = day.getDay();
  const availRows = db
    .prepare("SELECT start_time, end_time FROM employee_availability WHERE employee_id = ? AND weekday = ?")
    .all(employeeId, weekday);
  const validInAvailability = availRows.some((row) => row.start_time <= startTime && row.end_time >= endTime);
  if (!validInAvailability) {
    return sendJson(res, 400, { error: "Ese horario no está disponible para el empleado seleccionado." });
  }

  const conflicts = db
    .prepare(`
      SELECT COUNT(*) AS count
      FROM appointments
      WHERE employee_id = ?
        AND date = ?
        AND status = 'booked'
        AND NOT (end_time <= ? OR start_time >= ?)
    `)
    .get(employeeId, date, startTime, endTime).count;

  if (conflicts > 0) return sendJson(res, 409, { error: "El horario ya fue tomado. Elegí otro." });

  const insert = db.prepare(`
    INSERT INTO appointments
    (user_id, employee_id, service_id, client_email, client_name, date, start_time, end_time, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = insert.run(
    session.user.id,
    employeeId,
    serviceId,
    session.user.email,
    session.user.name,
    date,
    startTime,
    endTime,
    notes
  );

  const appointmentId = Number(result.lastInsertRowid);
  const appointment = db
    .prepare(`
      SELECT a.id, a.date, a.start_time, a.end_time, a.client_email, a.client_name, s.name AS service_name, s.price_ars,
             e.name AS employee_name
      FROM appointments a
      JOIN services s ON s.id = a.service_id
      JOIN employees e ON e.id = a.employee_id
      WHERE a.id = ?
    `)
    .get(appointmentId);

  const recipients = [config.businessEmail, appointment.client_email].filter(Boolean);
  try {
    if (recipients.length && config.gmailUser && config.gmailAppPassword) {
      await sendGmailSmtp({
        from: config.gmailUser,
        to: recipients,
        subject: `Turno confirmado - ${appointment.service_name} (${appointment.date} ${appointment.start_time})`,
        text: renderAppointmentEmail(appointment)
      });
    }
  } catch (err) {
    console.error("Error enviando email:", err.message);
  }

  return sendJson(res, 201, { ok: true, appointment });
}

function handleMyAppointments(req, res) {
  const session = getSession(req);
  if (!session) return sendJson(res, 401, { error: "No autenticado." });
  const rows = db
    .prepare(`
      SELECT a.id, a.date, a.start_time, a.end_time, s.name AS service_name, s.price_ars, e.name AS employee_name
      FROM appointments a
      JOIN services s ON s.id = a.service_id
      JOIN employees e ON e.id = a.employee_id
      WHERE a.user_id = ?
      ORDER BY a.date DESC, a.start_time DESC
    `)
    .all(session.user.id);
  return sendJson(res, 200, { appointments: rows });
}

function renderAppointmentEmail(app) {
  return [
    "Tu turno fue reservado con exito.",
    "",
    `Cliente: ${app.client_name}`,
    `Servicio: ${app.service_name}`,
    `Profesional: ${app.employee_name}`,
    `Fecha: ${app.date}`,
    `Horario: ${app.start_time} - ${app.end_time}`,
    `Precio: $${app.price_ars.toLocaleString("es-AR")}`,
    "",
    "Vasca | Lashes & Eyebrows"
  ].join("\n");
}

async function sendGmailSmtp({ from, to, subject, text }) {
  const toHeader = Array.isArray(to) ? to.join(", ") : to;
  const payload =
    `From: ${from}\r\n` +
    `To: ${toHeader}\r\n` +
    `Subject: ${subject}\r\n` +
    "MIME-Version: 1.0\r\n" +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    "Content-Transfer-Encoding: 8bit\r\n" +
    "\r\n" +
    `${text}\r\n`;

  await smtpSend({
    host: "smtp.gmail.com",
    port: 465,
    user: config.gmailUser,
    pass: config.gmailAppPassword,
    from,
    to: Array.isArray(to) ? to : [to],
    data: payload
  });
}

async function smtpSend({ host, port, user, pass, from, to, data }) {
  const socket = tls.connect(port, host, { servername: host });
  socket.setEncoding("utf8");

  const waitLine = () =>
    new Promise((resolve, reject) => {
      const onData = (chunk) => {
        const lines = chunk.split(/\r?\n/).filter(Boolean);
        const last = lines[lines.length - 1] || "";
        if (/^\d{3}[ -]/.test(last)) {
          socket.off("data", onData);
          resolve(last);
        }
      };
      socket.on("data", onData);
      socket.once("error", reject);
    });

  const sendCmd = async (cmd, okCodes = ["250"]) => {
    socket.write(`${cmd}\r\n`);
    const line = await waitLine();
    const code = line.slice(0, 3);
    if (!okCodes.includes(code)) throw new Error(`SMTP ${code}: ${line}`);
    return line;
  };

  await waitLine();
  await sendCmd("EHLO localhost");
  await sendCmd("AUTH LOGIN", ["334"]);
  await sendCmd(Buffer.from(user, "utf8").toString("base64"), ["334"]);
  await sendCmd(Buffer.from(pass, "utf8").toString("base64"), ["235"]);
  await sendCmd(`MAIL FROM:<${from}>`);
  for (const address of to) await sendCmd(`RCPT TO:<${address}>`);
  await sendCmd("DATA", ["354"]);
  socket.write(`${data}\r\n.\r\n`);
  const dataResp = await waitLine();
  if (!dataResp.startsWith("250")) throw new Error(`SMTP DATA error: ${dataResp}`);
  await sendCmd("QUIT", ["221"]);
  socket.end();
}

async function serveStatic(pathname, res) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const fullPath = path.normalize(path.join(FRONTEND_DIR, cleanPath));

  if (!fullPath.startsWith(FRONTEND_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Forbidden");
  }

  try {
    const data = await fsp.readFile(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}
