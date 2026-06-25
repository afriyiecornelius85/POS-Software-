"use strict";

const crypto = require("crypto");
const bcrypt = require("./vendor/bcryptjs.cjs");
const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT_DIR = __dirname;
const LOCAL_DATA_FILE = path.join(ROOT_DIR, "data", "akopharmah-sync.json");
const SEED_FILE = path.join(ROOT_DIR, "data", "seed.json");
const IS_RENDER = process.env.RENDER === "true";
const CONFIGURED_DATA_FILE = String(process.env.AKOPHARMAH_DATA_FILE || "").trim();
const DATA_FILE = CONFIGURED_DATA_FILE || LOCAL_DATA_FILE;
const DATA_DIR = path.dirname(DATA_FILE);
const DATABASE_URL = String(process.env.AKOPHARMAH_DATABASE_URL || process.env.DATABASE_URL || "").trim();
const USE_POSTGRES = !!DATABASE_URL;
const POSTGRES_STATE_ID = String(process.env.AKOPHARMAH_POSTGRES_STATE_ID || "primary").trim() || "primary";
const POSTGRES_SSL = String(process.env.AKOPHARMAH_DATABASE_SSL || "").toLowerCase() === "true"
  || /[?&]sslmode=require(?:&|$)/i.test(DATABASE_URL);
const PORT = Number(process.env.PORT || process.env.AKOPHARMAH_PORT || 3000);
const HOST = process.env.AKOPHARMAH_HOST || "0.0.0.0";
const BCRYPT_WORK_FACTOR = 10;
const MIN_PASSWORD_LENGTH = 10;
const MAX_BCRYPT_PASSWORD_BYTES = 72;
const SESSION_TTL_MS = Math.max(15 * 60 * 1000, Number(process.env.AKOPHARMAH_SESSION_TTL_MS) || 12 * 60 * 60 * 1000);
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 6;
const sessions = new Map();
const loginFailures = new Map();
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("akopharmah-invalid-login", BCRYPT_WORK_FACTOR);
let stateWriteQueue = Promise.resolve();
const AUDIT_LOG_ACTIVE_CAP = Math.max(100, Number(process.env.AKOPHARMAH_AUDIT_CAP) || 500);
const API_RATE_WINDOW_MS = 60_000;
const API_RATE_MAX = Number(process.env.AKOPHARMAH_API_RATE_MAX) || 120;
const apiRateMap = new Map();
const FIELD_ENC_KEY_HEX = String(process.env.AKOPHARMAH_FIELD_ENCRYPTION_KEY || "").trim();
const FIELD_ENC_KEY = FIELD_ENC_KEY_HEX.length === 64 ? Buffer.from(FIELD_ENC_KEY_HEX, "hex") : null;
setInterval(() => {
  const now = Date.now();
  sessions.forEach((session, token) => {
    if (session.expiresAt <= now) sessions.delete(token);
  });
  loginFailures.forEach((record, key) => {
    if (record.windowEndsAt <= now) loginFailures.delete(key);
  });
  apiRateMap.forEach((record, key) => {
    if (now - record.windowStart > API_RATE_WINDOW_MS * 2) apiRateMap.delete(key);
  });
  if (USE_POSTGRES) {
    getPostgresPool()
      .query("DELETE FROM akopharmah_sessions WHERE expires_at <= now()")
      .catch(err => console.warn("[sessions] Cleanup failed:", err.message));
  }
}, 10 * 60 * 1000).unref();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml"
};

const API_ROUTES = new Set([
  "/health",
  "/branches",
  "/users",
  "/customers",
  "/customers/payment",
  "/sync",
  "/auth/login",
  "/auth/logout",
  "/auth/me",
  "/auth/password",
  "/role-permissions",
  "/drugs",
  "/sales",
  "/sales/retention",
  "/returns",
  "/suppliers",
  "/purchases",
  "/audit-log",
  "/stock-transfers",
  "/stock-writeoffs",
  "/csp-report"
]);

const DEFAULT_BRANCHES = [
  { id: "kwame-danso-main", name: "Kwame Danso Main" },
  { id: "kwame-danso-annex", name: "Kwame Danso Annex" },
  { id: "techimantia", name: "Techimantia" },
  { id: "derma", name: "Derma" },
  { id: "abuakwa", name: "Abuakwa" }
];
const VALID_ROLES = Object.freeze(["cashier", "worker", "pharmacist", "manager", "director"]);
const DEFAULT_ROLE_PERMISSIONS = Object.freeze({
  sell: ["cashier", "worker", "pharmacist", "manager", "director"],
  holdSale: ["cashier", "worker", "pharmacist", "manager", "director"],
  viewHeld: ["cashier", "worker", "pharmacist", "manager", "director"],
  viewPatients: ["cashier", "worker", "pharmacist", "manager", "director"],
  editPatients: ["cashier", "worker", "pharmacist", "manager", "director"],
  viewHistory: ["pharmacist", "manager", "director"],
  viewReference: ["worker", "pharmacist", "manager", "director"],
  editReference: ["pharmacist", "manager", "director"],
  viewReportsMenu: ["pharmacist", "manager", "director"],
  viewPurchases: ["pharmacist", "manager", "director"],
  managePurchases: ["pharmacist", "manager", "director"],
  overridePrice: ["pharmacist", "manager", "director"],
  overrideInteractions: ["pharmacist", "manager", "director"],
  processReturns: ["pharmacist", "manager", "director"],
  viewInventory: ["manager", "director"],
  editInventory: ["manager", "director"],
  deleteInventory: ["manager", "director"],
  transferStock: ["manager", "director"],
  writeOffStock: ["manager", "director"],
  viewSummary: ["manager", "director"],
  viewShiftLog: ["manager", "director"],
  viewExpiry: ["manager", "director"],
  switchBranch: ["director"],
  exportBackup: ["manager", "director"],
  importData: ["director"],
  managerAccess: ["manager", "director"],
  pharmacistAccess: ["pharmacist", "manager", "director"]
});
let seedCache = null;
let postgresPool = null;
let postgresReady = false;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(2).toString("hex")}`;
}

function getSeedCache() {
  if (!seedCache) {
    let seed = {};
    try {
      seed = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
    } catch (error) {
      console.warn(`Could not read seed data from ${SEED_FILE}:`, error.message);
    }
    seedCache = {
      branches: Array.isArray(seed.branches) ? clone(seed.branches) : clone(DEFAULT_BRANCHES),
      users: Array.isArray(seed.users) ? clone(seed.users) : [],
      drugs: Array.isArray(seed.drugs) ? clone(seed.drugs) : [],
      customers: Array.isArray(seed.customers) ? clone(seed.customers) : [{ id: 1, name: "Walk-in", phone: "", notes: "", balance: 0 }],
      referenceDrugs: Array.isArray(seed.referenceDrugs) ? clone(seed.referenceDrugs) : []
    };
  }
  return seedCache;
}

function getBootstrapUsers(branches) {
  const password = String(process.env.AKOPHARMAH_BOOTSTRAP_PASSWORD || "");
  if (!password) {
    throw new Error("AKOPHARMAH_BOOTSTRAP_PASSWORD is required when creating a new database");
  }
  if (password.length < MIN_PASSWORD_LENGTH || Buffer.byteLength(password, "utf8") > MAX_BCRYPT_PASSWORD_BYTES) {
    throw new Error(`AKOPHARMAH_BOOTSTRAP_PASSWORD must be ${MIN_PASSWORD_LENGTH}-${MAX_BCRYPT_PASSWORD_BYTES} UTF-8 bytes`);
  }
  const username = String(process.env.AKOPHARMAH_BOOTSTRAP_USERNAME || "director").trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
    throw new Error("AKOPHARMAH_BOOTSTRAP_USERNAME must be 3-64 letters, numbers, dots, underscores, or hyphens");
  }
  const branchId = branchIdFromAny(process.env.AKOPHARMAH_BOOTSTRAP_BRANCH, branches) || branches[0]?.id || DEFAULT_BRANCHES[0].id;
  return [{
    username,
    name: String(process.env.AKOPHARMAH_BOOTSTRAP_NAME || "Initial Director").trim() || "Initial Director",
    role: "director",
    branch_id: branchId,
    branch_ids: branches.map(branch => branch.id),
    passwordHash: bcrypt.hashSync(password, BCRYPT_WORK_FACTOR)
  }];
}

function seedState() {
  const { branches, drugs, customers } = getSeedCache();
  const walkIn = customers.find(customer => String(customer.name || "").trim().toLowerCase() === "walk-in")
    || { id: 1, name: "Walk-in", phone: "", notes: "", balance: 0 };
  const emptyStock = Object.fromEntries(branches.map(branch => [branch.name, 0]));
  const catalog = drugs.map(drug => ({
    ...drug,
    stock: 0,
    quantity: 0,
    branchStock: { ...emptyStock },
    batches: []
  }));
  return normalizeState({
    pharmacy_id: "akopharmah",
    pharmacy: "Akopharmah",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    branches,
    users: getBootstrapUsers(branches),
    drugs: catalog,
    customers: [{ ...walkIn, id: walkIn.id || 1, name: "Walk-in", phone: "", notes: "", balance: 0 }],
    sales: [],
    suppliers: [],
    purchases: [],
    heldSales: [],
    auditLog: [],
    stockTransfers: [],
    stockWriteoffs: [],
    rolePermissions: clone(DEFAULT_ROLE_PERMISSIONS)
  });
}

function getPostgresPool() {
  if (postgresPool) return postgresPool;
  let Pool;
  try {
    ({ Pool } = require("pg"));
  } catch (error) {
    throw new Error("PostgreSQL storage needs the pg package. Run npm install before deploying.");
  }
  const max = Math.max(1, Number(process.env.AKOPHARMAH_DATABASE_POOL_MAX || 10) || 10);
  postgresPool = new Pool({
    connectionString: DATABASE_URL,
    max,
    ...(POSTGRES_SSL ? { ssl: { rejectUnauthorized: false } } : {})
  });
  postgresPool.on("error", error => {
    console.error("Unexpected PostgreSQL client error:", error.message);
  });
  return postgresPool;
}

function parseStateText(rawText) {
  const rawState = JSON.parse(rawText);
  if (!rawState || typeof rawState !== "object" || Array.isArray(rawState)) {
    throw new SyntaxError("Database root must be an object");
  }
  return rawState;
}

function writeFileState(nextState) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  nextState.updatedAt = nowIso();
  const tempFile = `${DATA_FILE}.tmp`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify(nextState, null, 2));
    fs.renameSync(tempFile, DATA_FILE);
  } catch (err) {
    console.error("[CRITICAL] State file write failed:", err.message);
    try { fs.unlinkSync(tempFile); } catch {}
    throw err;
  }
}

function readExistingFileStateForImport() {
  if (!fs.existsSync(DATA_FILE)) return null;
  try {
    const rawState = parseStateText(fs.readFileSync(DATA_FILE, "utf8"));
    return normalizeState(rawState);
  } catch (error) {
    const backup = `${DATA_FILE}.postgres-import-failed-${Date.now()}`;
    try {
      fs.copyFileSync(DATA_FILE, backup);
      console.warn(`Existing data file could not be imported into PostgreSQL. A backup was saved to ${backup}`);
    } catch (backupError) {
      console.warn("Existing data file could not be imported into PostgreSQL:", backupError.message);
    }
    return null;
  }
}

function ensureFileState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) writeFileState(seedState());
}

function readFileState() {
  ensureFileState();
  let rawText = "";
  try {
    rawText = fs.readFileSync(DATA_FILE, "utf8");
  } catch (error) {
    error.statusCode = 500;
    throw error;
  }
  let rawState;
  try {
    rawState = parseStateText(rawText);
  } catch (error) {
    const backup = `${DATA_FILE}.corrupt-${Date.now()}`;
    fs.copyFileSync(DATA_FILE, backup);
    console.warn(`Data file was invalid. A backup was saved to ${backup}`);
    const replacement = seedState();
    writeFileState(replacement);
    return replacement;
  }
  const shouldMigratePasswords = hasLegacyPasswordCredentials(rawState);
  const state = normalizeState(rawState);
  if (shouldMigratePasswords) writeFileState(state);
  return state;
}

async function writePostgresState(nextState) {
  nextState.updatedAt = nowIso();
  await getPostgresPool().query(
    `INSERT INTO akopharmah_state (id, data, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (id)
     DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [POSTGRES_STATE_ID, JSON.stringify(nextState)]
  );
}

async function ensurePostgresState() {
  if (postgresReady) return;
  const pool = getPostgresPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS akopharmah_state (
      id text PRIMARY KEY,
      data jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS akopharmah_sessions (
      token text PRIMARY KEY,
      username text NOT NULL,
      expires_at timestamptz NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_akopharmah_sessions_expires ON akopharmah_sessions(expires_at);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS akopharmah_audit_archive (
      id text,
      timestamp timestamptz,
      username text,
      branch_id text,
      action text,
      details text,
      archived_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_audit_archive_ts ON akopharmah_audit_archive(timestamp DESC);
  `);
  const existing = await pool.query("SELECT 1 FROM akopharmah_state WHERE id = $1", [POSTGRES_STATE_ID]);
  if (!existing.rowCount) {
    const importedState = readExistingFileStateForImport();
    const initialState = importedState || seedState();
    await writePostgresState(initialState);
    console.log(importedState
      ? `PostgreSQL state initialized from existing data file: ${DATA_FILE}`
      : "PostgreSQL state initialized from fresh seed data");
  }
  postgresReady = true;
}

async function ensureStorage() {
  if (USE_POSTGRES) return ensurePostgresState();
  ensureFileState();
}

async function readPostgresState() {
  await ensurePostgresState();
  const result = await getPostgresPool().query("SELECT data FROM akopharmah_state WHERE id = $1", [POSTGRES_STATE_ID]);
  if (!result.rowCount) {
    const replacement = seedState();
    await writePostgresState(replacement);
    return replacement;
  }
  const rawState = typeof result.rows[0].data === "string" ? JSON.parse(result.rows[0].data) : result.rows[0].data;
  if (!rawState || typeof rawState !== "object" || Array.isArray(rawState)) {
    throw Object.assign(new Error("PostgreSQL state row is invalid"), { statusCode: 500 });
  }
  const shouldMigratePasswords = hasLegacyPasswordCredentials(rawState);
  const state = normalizeState(rawState);
  if (shouldMigratePasswords) await writePostgresState(state);
  return state;
}

async function readState() {
  return USE_POSTGRES ? readPostgresState() : readFileState();
}

function encryptField(plaintext) {
  if (!FIELD_ENC_KEY) return plaintext;
  const value = typeof plaintext === "string" ? plaintext : JSON.stringify(plaintext);
  if (!value) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", FIELD_ENC_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString("base64")}.${ciphertext.toString("base64")}.${tag.toString("base64")}`;
}

function decryptField(value, parseJson = false) {
  if (!FIELD_ENC_KEY || typeof value !== "string" || !value.startsWith("enc:")) return value;
  try {
    const parts = value.slice(4).split(".");
    if (parts.length !== 3) return value;
    const iv = Buffer.from(parts[0], "base64");
    const ciphertext = Buffer.from(parts[1], "base64");
    const tag = Buffer.from(parts[2], "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", FIELD_ENC_KEY, iv);
    decipher.setAuthTag(tag);
    const plaintext = decipher.update(ciphertext) + decipher.final("utf8");
    return parseJson ? JSON.parse(plaintext) : plaintext;
  } catch {
    return value;
  }
}

function serializeForStorage(state) {
  if (!FIELD_ENC_KEY) return state;
  return {
    ...state,
    customers: state.customers.map(c => ({
      ...c,
      phone: encryptField(c.phone || ""),
      notes: encryptField(c.notes || ""),
      medicalRecords: Array.isArray(c.medicalRecords) && c.medicalRecords.length
        ? encryptField(JSON.stringify(c.medicalRecords))
        : c.medicalRecords
    }))
  };
}

function archiveAuditEntries(entries) {
  if (!entries.length) return;
  if (USE_POSTGRES) {
    const pool = getPostgresPool();
    for (const entry of entries) {
      pool.query(
        `INSERT INTO akopharmah_audit_archive (id, timestamp, username, branch_id, action, details)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [entry.id, entry.timestamp, entry.user, entry.branch_id, entry.action, String(entry.details || "")]
      ).catch(err => console.warn("[audit-archive] Insert failed:", err.message));
    }
  } else {
    const archiveFile = path.join(DATA_DIR, "akopharmah-audit-archive.ndjson");
    const lines = entries.map(e => JSON.stringify(e)).join("\n") + "\n";
    fs.appendFile(archiveFile, lines, err => {
      if (err) console.warn("[audit-archive] File append failed:", err.message);
    });
  }
}

function checkApiRateLimit(req) {
  const ip = String(req.socket?.remoteAddress || req.headers?.["x-forwarded-for"] || "unknown").split(",")[0].trim();
  const now = Date.now();
  const record = apiRateMap.get(ip) || { count: 0, windowStart: now };
  if (now - record.windowStart > API_RATE_WINDOW_MS) {
    record.count = 0;
    record.windowStart = now;
  }
  record.count += 1;
  apiRateMap.set(ip, record);
  return record.count <= API_RATE_MAX;
}

async function writeState(nextState) {
  nextState.updatedAt = nowIso();
  const storageState = serializeForStorage(nextState);
  if (USE_POSTGRES) {
    await getPostgresPool().query(
      `INSERT INTO akopharmah_state (id, data, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [POSTGRES_STATE_ID, JSON.stringify(storageState)]
    );
    return;
  }
  const tempFile = `${DATA_FILE}.tmp`;
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(tempFile, JSON.stringify(storageState, null, 2));
    fs.renameSync(tempFile, DATA_FILE);
  } catch (err) {
    console.error("[CRITICAL] State write failed:", err.message);
    try { fs.unlinkSync(tempFile); } catch {}
    throw err;
  }
}

function storageHealth() {
  if (USE_POSTGRES) {
    return {
      configured: true,
      persistent: true,
      mode: "postgres",
      stateId: POSTGRES_STATE_ID
    };
  }
  return {
    configured: !!CONFIGURED_DATA_FILE,
    persistent: IS_RENDER ? !!CONFIGURED_DATA_FILE : true,
    mode: "json-file"
  };
}

function normalizeState(value) {
  const state = value && typeof value === "object" ? value : {};
  const seed = getSeedCache();
  state.pharmacy_id = state.pharmacy_id || "akopharmah";
  state.pharmacy = state.pharmacy || "Akopharmah";
  state.branches = Array.isArray(state.branches) && state.branches.length ? state.branches : clone(seed.branches.length ? seed.branches : DEFAULT_BRANCHES);
  state.users = Array.isArray(state.users) ? state.users.map(user => normalizeUser(user, state.branches)) : [];
  state.drugs = Array.isArray(state.drugs) ? state.drugs.map(drug => normalizeDrug(drug, state.branches)).filter(drug => Number.isFinite(drug.id)) : [];
  state.customers = Array.isArray(state.customers) ? state.customers.map(customer => normalizeCustomer(customer, state.branches)) : [];
  state.sales = Array.isArray(state.sales || state.salesHistory) ? (state.sales || state.salesHistory).map(record => normalizeBranchRecord(record, state.branches)) : [];
  state.suppliers = Array.isArray(state.suppliers) ? state.suppliers.map(record => normalizeBranchRecord(record, state.branches)) : [];
  state.purchases = Array.isArray(state.purchases || state.purchaseHistory) ? (state.purchases || state.purchaseHistory).map(record => normalizeBranchRecord(record, state.branches)) : [];
  state.heldSales = Array.isArray(state.heldSales) ? state.heldSales.map(record => normalizeBranchRecord(record, state.branches)) : [];
  state.auditLog = Array.isArray(state.auditLog) ? state.auditLog.map(record => normalizeBranchRecord(record, state.branches)) : [];
  state.stockTransfers = Array.isArray(state.stockTransfers) ? state.stockTransfers : [];
  state.stockWriteoffs = Array.isArray(state.stockWriteoffs) ? state.stockWriteoffs.map(record => normalizeBranchRecord(record, state.branches)) : [];
  state.rolePermissions = normalizeRolePermissions(state.rolePermissions);
  state.createdAt = state.createdAt || nowIso();
  state.updatedAt = state.updatedAt || nowIso();
  return state;
}

function normalizeRolePermissions(value, { strict = false } = {}) {
  if (strict && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw Object.assign(new Error("A complete role permission matrix is required"), { statusCode: 400 });
  }
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const permissions = {};
  Object.entries(DEFAULT_ROLE_PERMISSIONS).forEach(([permission, defaultRoles]) => {
    const incoming = source[permission];
    if (strict && !Array.isArray(incoming)) {
      throw Object.assign(new Error(`Permission ${permission} must contain a role list`), { statusCode: 400 });
    }
    const roles = Array.isArray(incoming) ? incoming : defaultRoles;
    const normalizedRoles = [...new Set(roles.map(role => String(role || "").toLowerCase()))];
    if (strict && normalizedRoles.some(role => !VALID_ROLES.includes(role))) {
      throw Object.assign(new Error(`Permission ${permission} contains an invalid role`), { statusCode: 400 });
    }
    permissions[permission] = normalizedRoles.filter(role => VALID_ROLES.includes(role));
  });
  if (!permissions.managerAccess.includes("director")) permissions.managerAccess.push("director");
  permissions.importData = ["director"];
  // Backfill cashier permissions from defaults for existing stored state
  Object.keys(DEFAULT_ROLE_PERMISSIONS).forEach(perm => {
    if (DEFAULT_ROLE_PERMISSIONS[perm].includes("cashier") && !permissions[perm].includes("cashier")) {
      permissions[perm].unshift("cashier");
    }
  });
  return permissions;
}

function isBcryptHash(value) {
  return /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(String(value || ""));
}

function hasLegacyPasswordCredentials(value) {
  return Array.isArray(value?.users) && value.users.some(user => {
    const password = String(user?.password || "");
    const passwordHash = String(user?.passwordHash || "");
    return !!password || (!!passwordHash && !isBcryptHash(passwordHash));
  });
}

function normalizePasswordHash(user = {}) {
  const storedHash = String(user.passwordHash || "");
  if (isBcryptHash(storedHash)) return storedHash;
  const legacyPassword = String(user.password || storedHash || "");
  if (!legacyPassword) return "";
  if (isBcryptHash(legacyPassword)) return legacyPassword;
  return bcrypt.hashSync(legacyPassword, BCRYPT_WORK_FACTOR);
}

function normalizeUserBranchIds(user = {}, branches = DEFAULT_BRANCHES) {
  const values = [];
  const push = value => {
    if (Array.isArray(value)) value.forEach(push);
    else if (value) values.push(value);
  };
  push(user.branch_ids);
  push(user.branchIds);
  push(user.allowedBranchIds);
  push(user.assignedBranchIds);
  push(user.branches);
  push(user.branch_id);
  push(user.branchId);
  push(user.branch);
  const ids = [...new Set(values.map(value => branchIdFromAny(value, branches)).filter(Boolean))];
  return ids.length ? ids : [branches[0]?.id || DEFAULT_BRANCHES[0].id];
}

function normalizeUser(user, branches = DEFAULT_BRANCHES) {
  const passwordHash = normalizePasswordHash(user);
  const safeSource = { ...user };
  delete safeSource.password;
  delete safeSource.passwordHash;
  delete safeSource.offlineCredential;
  const branchIds = normalizeUserBranchIds(user, branches);
  const preferredBranchId = branchIdFromAny(user.branch_id || user.branchId || user.branch, branches);
  const defaultBranchId = branches && branches.length > 0 ? branches[0].id : DEFAULT_BRANCHES[0].id;
  const branchId = branchIds.includes(preferredBranchId) ? preferredBranchId : (branchIds[0] || defaultBranchId);
  return {
    ...safeSource,
    ...(passwordHash ? { passwordHash } : {}),
    role: String(user.role || "").toLowerCase(),
    branch_id: branchId,
    branchId,
    branch: branchNameFromId(branchId, branches),
    branch_ids: branchIds,
    branchIds,
    branches: branchIds.map(id => branchNameFromId(id, branches))
  };
}

function normalizeCustomer(customer, branches = DEFAULT_BRANCHES) {
  const branchId = branchIdFromAny(customer.branch_id || customer.branchId || customer.branch, branches) || branches[0]?.id || DEFAULT_BRANCHES[0].id;
  const incomingId = Number(customer.id);
  const rawMedicalRecords = (() => {
    const mr = customer.medicalRecords;
    if (typeof mr === "string" && mr.startsWith("enc:")) {
      const decoded = decryptField(mr, true);
      return Array.isArray(decoded) ? decoded : [];
    }
    return Array.isArray(mr) ? mr : [];
  })();
  return {
    ...customer,
    id: Number.isFinite(incomingId) && incomingId > 0 ? incomingId : Date.now(),
    name: String(customer.name || "Customer"),
    phone: decryptField(customer.phone || ""),
    notes: decryptField(customer.notes || ""),
    medicalRecords: rawMedicalRecords,
    balance: Number(customer.balance || 0),
    dateOfBirth: customer.dateOfBirth || customer.dob || "",
    dob: customer.dateOfBirth || customer.dob || "",
    branch_id: branchId,
    branchId,
    branch: branchNameFromId(branchId, branches)
  };
}

function normalizeDrug(drug, branches) {
  const id = Number(drug.id ?? drug.drug_id ?? drug.drugId);
  const fallbackStock = Number.isFinite(Number(drug.stock ?? drug.quantity)) ? Number(drug.stock ?? drug.quantity) : 0;
  const preferredBranchId = branchIdFromAny(drug.branch_id || drug.branchId || drug.branch, branches)
    || branches[0]?.id
    || DEFAULT_BRANCHES[0].id;
  const stock = normalizeBranchStock(
    drug.branchStock || drug.branchStocks || drug.branch_stocks,
    branches,
    fallbackStock,
    preferredBranchId
  );
  const branchAvailability = normalizeBranchAvailability(
    drug.branchAvailability || drug.branchAvailabilities || drug.branch_availability,
    branches
  );
  const preferredBranch = branchNameFromId(preferredBranchId, branches);
  const reorderMinimum = Number(drug.lowStockThreshold || drug.reorderMinimum || drug.reorderPoint || 15) || 15;
  const normalized = {
    ...drug,
    id,
    drug_id: id,
    branchStock: stock,
    branchAvailability,
    stock: Number(stock[preferredBranch] ?? fallbackStock ?? 0),
    branch_id: preferredBranchId,
    branchId: preferredBranchId,
    branch: preferredBranch,
    lowStockThreshold: reorderMinimum,
    reorderPoint: reorderMinimum,
    reorderMinimum,
    reorderQuantity: Math.max(0, Number(drug.reorderQuantity ?? drug.reorderQty ?? 0) || 0),
    maxStock: Math.max(0, Number(drug.maxStock ?? drug.maximumStock ?? 0) || 0)
  };
  normalizeDrugBatches(normalized, branches);
  return normalized;
}

function normalizeBranchStock(rawStock, branches, fallbackStock = 0, fallbackBranchId = "") {
  const stock = Object.fromEntries(branches.map(branch => [branch.name, 0]));
  let recognizedStock = false;
  if (rawStock && typeof rawStock === "object") {
    Object.entries(rawStock).forEach(([key, value]) => {
      const branch = findBranch(branches, key);
      if (branch) {
        recognizedStock = true;
        stock[branch.name] = Math.max(0, Number(value) || 0);
      }
    });
  }
  if (!recognizedStock && Number(fallbackStock) > 0) {
    const fallbackBranch = findBranch(branches, fallbackBranchId) || branches[0];
    if (fallbackBranch) stock[fallbackBranch.name] = Math.max(0, Number(fallbackStock) || 0);
  }
  return stock;
}

function normalizeBranchAvailability(rawAvailability, branches) {
  const availability = Object.fromEntries(branches.map(branch => [branch.name, true]));
  if (!rawAvailability || typeof rawAvailability !== "object") return availability;
  Object.entries(rawAvailability).forEach(([key, value]) => {
    const branch = findBranch(branches, key);
    if (branch) availability[branch.name] = value !== false;
  });
  return availability;
}

function normalizeBatchIdPart(value) {
  return String(value || "none").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "none";
}

function makeBatchRecordId(drugId, batch, expiry, branchId, invoice = "") {
  return `BATCH-${drugId}-${normalizeBatchIdPart(branchId)}-${normalizeBatchIdPart(batch)}-${normalizeBatchIdPart(expiry)}-${normalizeBatchIdPart(invoice)}`;
}

function normalizeDrugBatches(drug, branches) {
  const normalized = [];
  const rawBatches = Array.isArray(drug.batches) ? drug.batches : [];
  rawBatches.forEach((batch, index) => {
    if (!batch || typeof batch !== "object") return;
    const branchId = branchIdFromAny(batch.branch_id || batch.branchId || batch.branch, branches) || branches[0]?.id || DEFAULT_BRANCHES[0].id;
    const branch = branchNameFromId(branchId, branches);
    const batchNo = String(batch.batch || batch.batchNo || batch.lot || "").trim();
    const expiry = batch.expiry || batch.expiryDate || "";
    const qty = Math.max(0, Number(batch.qty ?? batch.stock ?? batch.quantity ?? 0) || 0);
    const initialQty = Math.max(qty, Number(batch.initialQty ?? batch.initial_qty ?? qty) || qty);
    normalized.push({
      ...batch,
      id: batch.id || makeBatchRecordId(drug.id || drug.drug_id || index, batchNo, expiry, branchId, batch.invoice || batch.grn || ""),
      batch: batchNo,
      batchNo,
      expiry,
      qty,
      initialQty,
      branch_id: branchId,
      branchId,
      branch,
      cost: Number(batch.cost ?? batch.costPrice ?? 0) || 0,
      supplierId: batch.supplierId || batch.supplier_id || "",
      supplier: batch.supplier || "",
      invoice: batch.invoice || "",
      receivedDate: batch.receivedDate || batch.received_date || batch.date || ""
    });
  });
  if (drug.expiry) {
    branches.forEach(branch => {
      const qty = Number(drug.branchStock?.[branch.name] ?? 0) || 0;
      if (qty <= 0) return;
      const batchNo = drug.batch || "Legacy";
      if (normalized.some(batch => batch.branch_id === branch.id && batch.expiry === drug.expiry && batch.batch === batchNo)) return;
      normalized.push({
        id: makeBatchRecordId(drug.id, batchNo, drug.expiry, branch.id, "legacy"),
        batch: batchNo,
        batchNo,
        expiry: drug.expiry,
        qty,
        initialQty: qty,
        branch_id: branch.id,
        branchId: branch.id,
        branch: branch.name,
        cost: Number(drug.costPrice || 0) || 0,
        supplierId: drug.preferredSupplierId || drug.supplierId || "",
        supplier: "",
        invoice: "Legacy",
        receivedDate: ""
      });
    });
  }
  drug.batches = normalized;
  delete drug.expiry;
  delete drug.batch;
  return drug.batches;
}

function normalizeBranchRecord(record, branches) {
  const branchId = branchIdFromAny(record.branch_id || record.branchId || record.branch, branches) || branches[0]?.id || DEFAULT_BRANCHES[0].id;
  return {
    ...record,
    branch_id: branchId,
    branchId,
    branch: branchNameFromId(branchId, branches)
  };
}

function findBranch(branches, value) {
  if (!value) return null;
  const raw = String(value);
  return branches.find(branch => branch.id === raw || branch.name === raw) || null;
}

function branchIdFromAny(value, branches = DEFAULT_BRANCHES) {
  if (!value) return null;
  const branch = findBranch(branches, value);
  return branch ? branch.id : null;
}

function branchNameFromId(id, branches = DEFAULT_BRANCHES) {
  const found = branches.find(branch => branch.id === id);
  if (found) return found.name;
  if (branches && branches.length > 0) return branches[0].name;
  return DEFAULT_BRANCHES[0]?.name || "Main";
}

function getAuthorizedBranchIds(user, state) {
  if (!user) return [];
  if (String(user.role || "").toLowerCase() === "director") return state.branches.map(branch => branch.id);
  return normalizeUserBranchIds(user, state.branches);
}

function assertBranchAccess(req, branchId, state) {
  if (!branchId || getAuthorizedBranchIds(req.authUser, state).includes(branchId)) return branchId;
  const error = new Error("Branch access denied");
  error.statusCode = 403;
  throw error;
}

function branchScopeFromRequest(req, url, state) {
  const value = url.searchParams.get("branch") || req.headers["x-branch-id"] || "";
  const allowed = getAuthorizedBranchIds(req.authUser, state);
  if (!value || value === "all") return String(req.authUser?.role || "").toLowerCase() === "director" ? "all" : allowed;
  const branchId = branchIdFromAny(value, state.branches);
  if (!branchId) {
    const error = new Error("Unknown branch");
    error.statusCode = 400;
    throw error;
  }
  return assertBranchAccess(req, branchId, state);
}

function currentBranchFromRequest(req, state) {
  const requested = branchIdFromAny(req.headers["x-branch-id"], state.branches);
  const fallback = branchIdFromAny(req.authUser?.branch_id || req.authUser?.branchId || req.authUser?.branch, state.branches);
  return assertBranchAccess(req, requested || fallback || getAuthorizedBranchIds(req.authUser, state)[0], state);
}

function recordInScope(record, scope, state) {
  if (!scope || scope === "all") return true;
  const branchId = branchIdFromAny(record.branch_id || record.branchId || record.branch, state.branches);
  return Array.isArray(scope) ? scope.includes(branchId) : branchId === scope;
}

function scopedRecords(records, scope, state) {
  return records.filter(record => recordInScope(record, scope, state));
}

function responseDrug(drug, req, scope, state) {
  const currentBranchId = typeof scope === "string" && scope !== "all" ? scope : currentBranchFromRequest(req, state);
  const branchName = branchNameFromId(currentBranchId, state.branches);
  const allowedBranchIds = getAuthorizedBranchIds(req.authUser, state);
  const branchStock = Object.fromEntries(state.branches
    .filter(branch => allowedBranchIds.includes(branch.id))
    .map(branch => [branch.name, Number(drug.branchStock?.[branch.name] ?? 0)]));
  const branchAvailability = Object.fromEntries(state.branches
    .filter(branch => allowedBranchIds.includes(branch.id))
    .map(branch => [branch.name, drug.branchAvailability?.[branch.name] !== false]));
  const batches = normalizeDrugBatches(clone(drug), state.branches)
    .filter(batch => allowedBranchIds.includes(batch.branch_id));
  return {
    ...drug,
    branch_id: currentBranchId,
    branchId: currentBranchId,
    branch: branchName,
    branchStock,
    branchAvailability,
    batches,
    stock: Number(drug.branchStock?.[branchName] ?? drug.stock ?? 0)
  };
}

function drugAvailableInScope(drug, scope, state) {
  if (!scope || scope === "all") return true;
  const branchIds = Array.isArray(scope) ? scope : [scope];
  return branchIds.some(branchId => {
    const branchName = branchNameFromId(branchId, state.branches);
    return drug.branchAvailability?.[branchName] !== false;
  });
}

function isDrugAvailableAtBranch(drug, branchId, state) {
  const branchName = branchNameFromId(branchId, state.branches);
  return drug.branchAvailability?.[branchName] !== false;
}

function sendJson(res, status, payload) {
  const body = payload === null ? "" : JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function sendError(res, status, message, details) {
  sendJson(res, status, { error: message, details });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 10 * 1024 * 1024) {
        reject(Object.assign(new Error("Request body is too large"), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("Invalid JSON body"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function hasRolePermission(state, user, permission) {
  const role = String(user?.role || "").toLowerCase();
  return !!role && Array.isArray(state.rolePermissions?.[permission]) && state.rolePermissions[permission].includes(role);
}

function requirePermission(req, state, permission) {
  if (!hasRolePermission(state, req.authUser, permission)) {
    const error = new Error("Access denied");
    error.statusCode = 403;
    throw error;
  }
}

function requireAnyPermission(req, state, permissions) {
  if (!permissions.some(permission => hasRolePermission(state, req.authUser, permission))) {
    const error = new Error("Access denied");
    error.statusCode = 403;
    throw error;
  }
}

function requireDirector(req) {
  if (String(req.authUser?.role || "").toLowerCase() !== "director") {
    const error = new Error("Only a director can edit role permissions");
    error.statusCode = 403;
    throw error;
  }
}

function getBearerToken(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const username = String(user.username || "").toLowerCase();
  sessions.set(token, { username, expiresAt });
  if (USE_POSTGRES) {
    getPostgresPool().query(
      "INSERT INTO akopharmah_sessions (token, username, expires_at) VALUES ($1, $2, to_timestamp($3 / 1000.0)) ON CONFLICT (token) DO NOTHING",
      [token, username, expiresAt]
    ).catch(err => console.warn("[sessions] Persist failed:", err.message));
  }
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

function authenticateRequest(req, state) {
  const token = getBearerToken(req);
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    const error = new Error("Authentication required");
    error.statusCode = 401;
    throw error;
  }
  const user = state.users.find(item => String(item.username || "").toLowerCase() === session.username);
  if (!user) {
    sessions.delete(token);
    const error = new Error("Session is no longer valid");
    error.statusCode = 401;
    throw error;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  req.sessionToken = token;
  req.authUser = normalizeUser(user, state.branches);
  return req.authUser;
}

function loginFailureKey(req, username) {
  return `${req.socket.remoteAddress || "unknown"}:${String(username || "").toLowerCase()}`;
}

function getLoginFailureRecord(req, username) {
  const key = loginFailureKey(req, username);
  const current = loginFailures.get(key);
  if (!current || current.windowEndsAt <= Date.now()) {
    const next = { count: 0, windowEndsAt: Date.now() + LOGIN_WINDOW_MS };
    loginFailures.set(key, next);
    return { key, record: next };
  }
  return { key, record: current };
}

function recordLoginFailure(req, username) {
  const { key, record } = getLoginFailureRecord(req, username);
  record.count += 1;
  loginFailures.set(key, record);
  return record;
}

function clearLoginFailures(req, username) {
  loginFailures.delete(loginFailureKey(req, username));
}

function withoutPassword(user) {
  const { password, passwordHash, offlineCredential, ...safeUser } = user;
  return safeUser;
}

function withoutCredentialInput(user = {}) {
  const { password, passwordHash, offlineCredential, ...safeUser } = user;
  return safeUser;
}

function mergeSyncedUserProfiles(state, incomingUsers) {
  incomingUsers.forEach(incomingUser => {
    const safeIncoming = withoutCredentialInput(incomingUser);
    const username = String(safeIncoming.username || "").trim().toLowerCase();
    if (!username) return;
    const index = state.users.findIndex(user => String(user.username || "").toLowerCase() === username);
    if (index < 0) return;
    state.users[index] = normalizeUser({ ...state.users[index], ...safeIncoming, username }, state.branches);
  });
}

function isDirector(user) {
  return String(user?.role || "").toLowerCase() === "director";
}

function visibleUsersForRequest(state, req) {
  if (isDirector(req.authUser)) return state.users;
  const requester = String(req.authUser?.username || "").toLowerCase();
  const allowedBranches = new Set(getAuthorizedBranchIds(req.authUser, state));
  return state.users.filter(user => {
    const username = String(user.username || "").toLowerCase();
    const role = String(user.role || "").toLowerCase();
    if (username === requester) return true;
    if (role === "manager" || role === "director") return false;
    return normalizeUserBranchIds(user, state.branches).some(branchId => allowedBranches.has(branchId));
  });
}

async function upsertUserCredential(state, body, req) {
  const incoming = withoutCredentialInput(body.user || body);
  const username = String(incoming.username || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!username) throw Object.assign(new Error("Username is required"), { statusCode: 400 });
  const index = state.users.findIndex(user => String(user.username || "").toLowerCase() === username);
  const existing = index >= 0 ? state.users[index] : null;
  const requesterRole = String(req.authUser?.role || "").toLowerCase();
  const incomingRole = String(incoming.role || existing?.role || "worker").toLowerCase();
  if (!VALID_ROLES.includes(incomingRole)) {
    throw Object.assign(new Error("Role must be cashier, worker, pharmacist, manager, or director"), { statusCode: 400 });
  }
  if (requesterRole !== "director" && (["manager", "director"].includes(incomingRole) || ["manager", "director"].includes(String(existing?.role || "").toLowerCase()))) {
    throw Object.assign(new Error("Only a director can manage manager or director accounts"), { statusCode: 403 });
  }
  if (!existing && !password) {
    throw Object.assign(new Error("Password is required for a new user"), { statusCode: 400 });
  }
  if (password && password.length < MIN_PASSWORD_LENGTH) {
    throw Object.assign(new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`), { statusCode: 400 });
  }
  if (password && Buffer.byteLength(password, "utf8") > MAX_BCRYPT_PASSWORD_BYTES) {
    throw Object.assign(new Error(`Password must be at most ${MAX_BCRYPT_PASSWORD_BYTES} UTF-8 bytes`), { statusCode: 400 });
  }
  if (requesterRole !== "director") {
    const allowed = new Set(getAuthorizedBranchIds(req.authUser, state));
    const requested = normalizeUserBranchIds(incoming, state.branches);
    if (requested.some(branchId => !allowed.has(branchId))) {
      throw Object.assign(new Error("You can only assign users to your authorized branches"), { statusCode: 403 });
    }
  }
  const passwordHash = password
    ? await bcrypt.hash(password, BCRYPT_WORK_FACTOR)
    : existing?.passwordHash;
  const user = normalizeUser({
    ...(existing || {}),
    ...incoming,
    username,
    ...(passwordHash ? { passwordHash } : {})
  }, state.branches);
  if (index >= 0) state.users[index] = user;
  else state.users.push(user);
  return user;
}

function upsertById(records, nextRecord, idField = "id") {
  const id = nextRecord[idField];
  const index = records.findIndex(record => record[idField] === id);
  if (index >= 0) records[index] = { ...records[index], ...nextRecord };
  else records.unshift(nextRecord);
  return index < 0;
}

function assertExistingRecordAccess(records, id, req, state) {
  const existing = records.find(record => String(record.id) === String(id));
  if (existing) assertBranchAccess(req, existing.branch_id || existing.branchId || existing.branch, state);
  return existing;
}

function upsertDrug(state, incomingDrug, branchStocks) {
  const id = Number(incomingDrug.id ?? incomingDrug.drug_id ?? incomingDrug.drugId);
  if (!Number.isFinite(id) || id <= 0) {
    const error = new Error("Drug id is required");
    error.statusCode = 400;
    throw error;
  }
  const existing = state.drugs.find(drug => drug.id === id);
  const merged = normalizeDrug({
    ...(existing || {}),
    ...incomingDrug,
    id,
    branchStock: {
      ...(existing?.branchStock || {}),
      ...(incomingDrug.branchStock || {}),
      ...(incomingDrug.branchStocks || {}),
      ...(branchStocks || {})
    },
    branchAvailability: {
      ...(existing?.branchAvailability || {}),
      ...(incomingDrug.branchAvailability || {}),
      ...(incomingDrug.branchAvailabilities || {}),
      ...(incomingDrug.branch_availability || {})
    }
  }, state.branches);
  const index = state.drugs.findIndex(drug => drug.id === id);
  if (index >= 0) state.drugs[index] = merged;
  else state.drugs.push(merged);
  return merged;
}

function upsertAuthorizedDrug(state, req, incomingDrug, branchStocks) {
  const {
    branchStock: ignoredStock,
    branchStocks: ignoredStocks,
    branch_stocks: ignoredSnakeStocks,
    branchAvailability: ignoredAvailability,
    branchAvailabilities: ignoredAvailabilities,
    branch_availability: ignoredSnakeAvailability,
    ...safeIncoming
  } = incomingDrug;
  const allowedIds = new Set(getAuthorizedBranchIds(req.authUser, state));
  const allowedNames = new Set([...allowedIds].map(id => branchNameFromId(id, state.branches)));
  const requestedStocks = branchStocks || ignoredStock || ignoredStocks || ignoredSnakeStocks || {};
  const safeStocks = Object.fromEntries(Object.entries(requestedStocks).filter(([branchName]) => allowedNames.has(branchName)));
  const requestedAvailability = ignoredAvailability || ignoredAvailabilities || ignoredSnakeAvailability || {};
  const safeAvailability = Object.fromEntries(
    Object.entries(requestedAvailability).filter(([branchName]) => allowedNames.has(branchName))
  );
  const id = Number(safeIncoming.id ?? safeIncoming.drug_id ?? safeIncoming.drugId);
  const existing = state.drugs.find(drug => drug.id === id);
  if (existing) {
    safeIncoming.branchAvailability = safeAvailability;
  } else {
    const currentBranchName = branchNameFromId(currentBranchFromRequest(req, state), state.branches);
    safeIncoming.branchAvailability = {
      ...Object.fromEntries(state.branches.map(branch => [branch.name, false])),
      [currentBranchName]: true,
      ...safeAvailability
    };
  }
  if (Object.prototype.hasOwnProperty.call(safeIncoming, "batches")) {
    const currentBranchId = currentBranchFromRequest(req, state);
    const requestedBatches = Array.isArray(safeIncoming.batches) ? safeIncoming.batches : [];
    const authorizedBatches = requestedBatches.filter(batch => {
      const branchId = branchIdFromAny(batch.branch_id || batch.branchId || batch.branch, state.branches) || currentBranchId;
      return allowedIds.has(branchId);
    });
    const preservedBatches = existing
      ? normalizeDrugBatches(clone(existing), state.branches).filter(batch => !allowedIds.has(batch.branch_id))
      : [];
    safeIncoming.batches = [...preservedBatches, ...authorizedBatches];
  }
  return upsertDrug(state, safeIncoming, safeStocks);
}

function getDrugStock(drug, branchId, state) {
  const branchName = branchNameFromId(branchId, state.branches);
  drug.branchStock = drug.branchStock || normalizeBranchStock(null, state.branches, Number(drug.stock || 0), branchId);
  return Number(drug.branchStock[branchName] ?? 0);
}

function setDrugStock(drug, branchId, qty, state) {
  const branchName = branchNameFromId(branchId, state.branches);
  drug.branchStock = drug.branchStock || normalizeBranchStock(null, state.branches, Number(drug.stock || 0), branchId);
  drug.branchStock[branchName] = Math.max(0, Number(qty) || 0);
  drug.stock = Number(drug.branchStock[branchName] || 0);
  drug.branch_id = branchId;
  drug.branch = branchName;
}

function findDrugBatch(drug, batchId, state) {
  return normalizeDrugBatches(drug, state.branches).find(batch => String(batch.id) === String(batchId));
}

function addDrugBatchStock(drug, movement, branchId, state) {
  const qty = Math.max(0, Number(movement.qty) || 0);
  if (!qty) return;
  const batchNo = String(movement.batch || movement.batchNo || "").trim();
  const expiry = movement.expiry || "";
  const invoice = movement.invoice || "";
  const branch = branchNameFromId(branchId, state.branches);
  const batches = normalizeDrugBatches(drug, state.branches);
  const existing = batches.find(batch => batch.branch_id === branchId && batch.batch === batchNo && batch.expiry === expiry);
  if (existing) {
    existing.qty += qty;
    existing.initialQty = (Number(existing.initialQty) || 0) + qty;
    existing.cost = Number(movement.cost ?? existing.cost ?? 0) || 0;
    existing.supplierId = movement.supplierId || movement.supplier_id || existing.supplierId || "";
    existing.supplier = movement.supplier || existing.supplier || "";
    existing.invoice = invoice || existing.invoice || "";
    existing.receivedDate = movement.receivedDate || movement.received_date || existing.receivedDate || "";
    return;
  }
  batches.push({
    id: movement.batch_id || movement.batchId || makeBatchRecordId(drug.id, batchNo, expiry, branchId, invoice || Date.now()),
    batch: batchNo,
    batchNo,
    expiry,
    qty,
    initialQty: qty,
    branch_id: branchId,
    branchId,
    branch,
    cost: Number(movement.cost ?? 0) || 0,
    supplierId: movement.supplierId || movement.supplier_id || "",
    supplier: movement.supplier || "",
    invoice,
    receivedDate: movement.receivedDate || movement.received_date || ""
  });
}

function reduceDrugBatchQty(drug, batchId, qty, state) {
  const batch = findDrugBatch(drug, batchId, state);
  if (!batch) return false;
  const amount = Math.max(0, Number(qty) || 0);
  if (amount > (Number(batch.qty) || 0)) return false;
  batch.qty = Math.max(0, (Number(batch.qty) || 0) - amount);
  return true;
}

function restoreDrugBatchAllocations(drug, allocations, state) {
  if (!Array.isArray(allocations)) return false;
  let restored = false;
  allocations.forEach(allocation => {
    const batch = findDrugBatch(drug, allocation.batchId || allocation.batch_id, state);
    if (!batch) return;
    batch.qty = Math.max(0, (Number(batch.qty) || 0) + (Number(allocation.qty) || 0));
    restored = true;
  });
  return restored;
}

function restoreReturnedItemStock(drug, item, branchId, saleId, state) {
  const qty = positiveInteger(item.qty, `Return quantity for ${item.name || drug.name}`);
  const allocations = Array.isArray(item.batchAllocations || item.batch_allocations)
    ? (item.batchAllocations || item.batch_allocations)
    : [];
  let remaining = qty;
  allocations.forEach(allocation => {
    if (remaining <= 0) return;
    const batch = findDrugBatch(drug, allocation.batchId || allocation.batch_id, state);
    if (!batch || batch.branch_id !== branchId) return;
    const amount = Math.min(remaining, Math.max(0, Number(allocation.qty) || 0));
    if (!amount) return;
    batch.qty = Math.max(0, (Number(batch.qty) || 0) + amount);
    remaining -= amount;
  });
  if (remaining > 0) {
    addDrugBatchStock(drug, {
      qty: remaining,
      batch: `RETURN-${saleId}`,
      expiry: "",
      cost: Number(item.cost ?? item.costPrice ?? drug.costPrice ?? 0) || 0,
      invoice: `Return ${saleId}`,
      receivedDate: nowIso().slice(0, 10)
    }, branchId, state);
  }
  drug.branchAvailability = normalizeBranchAvailability(drug.branchAvailability, state.branches);
  drug.branchAvailability[branchNameFromId(branchId, state.branches)] = true;
  setDrugStock(drug, branchId, getDrugStock(drug, branchId, state) + qty, state);
}

function deductDrugBatchStock(drug, branchId, qty, state) {
  let remaining = Math.max(0, Number(qty) || 0);
  const allocations = [];
  const batches = normalizeDrugBatches(drug, state.branches)
    .filter(batch => batch.branch_id === branchId && (Number(batch.qty) || 0) > 0)
    .sort((a, b) => {
      const expA = a.expiry ? new Date(a.expiry).getTime() : Number.MAX_SAFE_INTEGER;
      const expB = b.expiry ? new Date(b.expiry).getTime() : Number.MAX_SAFE_INTEGER;
      return expA - expB;
    });
  batches.forEach(batch => {
    if (remaining <= 0) return;
    const take = Math.min(Number(batch.qty) || 0, remaining);
    batch.qty -= take;
    remaining -= take;
    allocations.push({
      batchId: batch.id,
      batch: batch.batch,
      expiry: batch.expiry,
      qty: take,
      branch_id: branchId,
      branch: batch.branch,
      cost: Number(batch.cost || 0) || 0,
      supplierId: batch.supplierId || "",
      supplier: batch.supplier || "",
      invoice: batch.invoice || "",
      receivedDate: batch.receivedDate || ""
    });
  });
  return allocations;
}

function transferDrugBatchStock(drug, fromBranchId, toBranchId, qty, state) {
  const allocations = deductDrugBatchStock(drug, fromBranchId, qty, state);
  allocations.forEach(allocation => {
    addDrugBatchStock(drug, {
      qty: allocation.qty,
      batch: allocation.batch,
      expiry: allocation.expiry,
      branch_id: toBranchId,
      cost: allocation.cost,
      supplierId: allocation.supplierId,
      supplier: allocation.supplier,
      invoice: allocation.invoice,
      receivedDate: allocation.receivedDate
    }, toBranchId, state);
  });
  return allocations;
}

function applyBatchMovement(drug, branchId, movement, state) {
  const qty = Number(movement.qty || 0);
  const allocations = movement.batch_allocations || movement.batchAllocations || [];
  if (qty > 0) {
    if (allocations.length && restoreDrugBatchAllocations(drug, allocations, state)) return;
    if (movement.batch || movement.expiry || movement.batch_id || movement.batchId) addDrugBatchStock(drug, movement, branchId, state);
    return;
  }
  if (qty < 0) {
    if (allocations.length) {
      allocations.forEach(allocation => reduceDrugBatchQty(drug, allocation.batchId || allocation.batch_id, allocation.qty, state));
      return;
    }
    deductDrugBatchStock(drug, branchId, Math.abs(qty), state);
  }
}

function buildMovementPlan(state, movements) {
  const balances = new Map();
  (movements || []).forEach(movement => {
    const drugId = Number(movement.drug_id ?? movement.drugId ?? movement.id);
    const drug = state.drugs.find(item => item.id === drugId);
    if (!drug) {
      const error = new Error(`Drug ${drugId} was not found`);
      error.statusCode = 409;
      throw error;
    }
    const qty = Number(movement.qty || 0);
    if (!Number.isFinite(qty)) {
      const error = new Error("Stock movement quantity is invalid");
      error.statusCode = 400;
      throw error;
    }
    const branchId = branchIdFromAny(movement.branch_id || movement.branchId || movement.branch, state.branches) || state.branches[0].id;
    const key = `${drugId}:${branchId}`;
    const existing = balances.get(key);
    const current = existing ? existing.qty : getDrugStock(drug, branchId, state);
    const next = current + qty;
    if (next < 0) {
      const error = new Error(`Insufficient stock for ${drug.name || drugId} at ${branchNameFromId(branchId, state.branches)}`);
      error.statusCode = 409;
      error.details = { drug_id: drugId, branch_id: branchId, available: current, requested: Math.abs(qty) };
      throw error;
    }
    balances.set(key, { drug, branchId, qty: next, movements: [...(existing?.movements || []), movement] });
  });
  return [...balances.values()];
}

function applyMovementPlan(plan, state) {
  plan.forEach(item => {
    setDrugStock(item.drug, item.branchId, item.qty, state);
    (item.movements || []).forEach(movement => applyBatchMovement(item.drug, item.branchId, movement, state));
  });
}

function addAudit(state, req, action, details, branchId) {
  const safeBranchId = branchId || currentBranchFromRequest(req, state);
  const entry = normalizeBranchRecord({
    id: makeId("AUD"),
    timestamp: nowIso(),
    user: req.authUser?.username || "server",
    branch_id: safeBranchId,
    action,
    details
  }, state.branches);
  state.auditLog.unshift(entry);
  if (state.auditLog.length > AUDIT_LOG_ACTIVE_CAP) {
    const overflow = state.auditLog.splice(AUDIT_LOG_ACTIVE_CAP);
    archiveAuditEntries(overflow);
  }
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    const error = new Error(`${label} must be a positive whole number`);
    error.statusCode = 400;
    throw error;
  }
  return number;
}

function nonNegativeNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    const error = new Error(`${label} must be a non-negative number`);
    error.statusCode = 400;
    throw error;
  }
  return Number(number.toFixed(2));
}

function isPriceOverrideAllowed(state, req) {
  return hasRolePermission(state, req.authUser, "overridePrice");
}

function normalizeSaleItems(state, req, incomingItems, branchId) {
  if (!Array.isArray(incomingItems) || !incomingItems.length) {
    const error = new Error("Sale must contain at least one item");
    error.statusCode = 400;
    throw error;
  }
  const grouped = new Map();
  incomingItems.forEach((incoming, index) => {
    const drugId = Number(incoming.id ?? incoming.drug_id ?? incoming.drugId);
    const drug = state.drugs.find(item => item.id === drugId);
    if (!drug) {
      const error = new Error(`Sale item ${index + 1} was not found`);
      error.statusCode = 409;
      throw error;
    }
    if (!isDrugAvailableAtBranch(drug, branchId, state)) {
      const error = new Error(`${drug.name || drugId} is not available at this branch`);
      error.statusCode = 409;
      throw error;
    }
    const qty = positiveInteger(incoming.qty, `Quantity for ${drug.name || drugId}`);
    const existing = grouped.get(drugId);
    if (existing) {
      existing.qty += qty;
      return;
    }
    const storedPrice = nonNegativeNumber(drug.price || 0, `Price for ${drug.name || drugId}`);
    const requestedPrice = Number(incoming.price);
    const price = isPriceOverrideAllowed(state, req) && Number.isFinite(requestedPrice) && requestedPrice >= 0
      ? Number(requestedPrice.toFixed(2))
      : storedPrice;
    grouped.set(drugId, { drug, qty, price });
  });
  const items = [...grouped.values()];
  items.forEach(({ drug, qty }) => {
    const available = getDrugStock(drug, branchId, state);
    if (available < qty) {
      const error = new Error(`Insufficient stock for ${drug.name || drug.id}`);
      error.statusCode = 409;
      error.details = { drug_id: drug.id, branch_id: branchId, available, requested: qty };
      throw error;
    }
  });
  return items;
}

function allocateSaleStock(state, normalizedItems, branchId) {
  let totalCost = 0;
  const items = normalizedItems.map(({ drug, qty, price }) => {
    const trackedBefore = normalizeDrugBatches(drug, state.branches)
      .filter(batch => batch.branch_id === branchId)
      .reduce((sum, batch) => sum + (Number(batch.qty) || 0), 0);
    const batchAllocations = deductDrugBatchStock(drug, branchId, qty, state);
    const allocatedQty = batchAllocations.reduce((sum, allocation) => sum + (Number(allocation.qty) || 0), 0);
    if (trackedBefore > 0 && allocatedQty !== qty) {
      const error = new Error(`Batch quantities for ${drug.name || drug.id} do not match branch stock`);
      error.statusCode = 409;
      throw error;
    }
    setDrugStock(drug, branchId, getDrugStock(drug, branchId, state) - qty, state);
    const itemCost = batchAllocations.length
      ? batchAllocations.reduce((sum, allocation) => sum + ((Number(allocation.cost) || 0) * (Number(allocation.qty) || 0)), 0)
      : (Number(drug.costPrice) || 0) * qty;
    totalCost += itemCost;
    return {
      id: drug.id,
      drug_id: drug.id,
      name: drug.name || "",
      brand: drug.brand || "",
      form: drug.form || "",
      saleUnit: String(drug.saleUnit || drug.sellingUnit || drug.unit || "Unit").trim() || "Unit",
      cat: drug.cat || drug.category || "Uncategorized",
      category: drug.cat || drug.category || "Uncategorized",
      qty,
      price,
      batchAllocations,
      batch_allocations: batchAllocations
    };
  });
  return { items, totalCost: Number(totalCost.toFixed(2)) };
}

function buildCanonicalSale(state, req, body) {
  const incoming = body.sale || body;
  const interactionReviewOptions = {
    "same-patient": "Same patient - pharmacist/manager required",
    "different-patients": "Different patients",
    "patient-counselled": "Patient already counselled",
    "prescriber-confirmed": "Prescriber confirmed"
  };
  let interactionReview = null;
  if (incoming.interactionReview != null) {
    const code = String(incoming.interactionReview?.code || "").trim();
    if (!interactionReviewOptions[code]) {
      throw Object.assign(new Error("Invalid interaction review choice"), { statusCode: 400 });
    }
    interactionReview = {
      by: req.authUser.username,
      name: req.authUser.name || req.authUser.username,
      role: req.authUser.role,
      code,
      label: interactionReviewOptions[code],
      note: String(incoming.interactionReview?.note || "").trim().slice(0, 500),
      at: nowIso(),
      interactions: Array.isArray(incoming.interactionReview?.interactions)
        ? clone(incoming.interactionReview.interactions.slice(0, 20))
        : []
    };
  }
  let interactionOverride = null;
  if (incoming.interactionOverride != null) {
    if (!hasRolePermission(state, req.authUser, "overrideInteractions")) {
      throw Object.assign(new Error("Interaction override requires pharmacist access"), { statusCode: 403 });
    }
    const reason = String(incoming.interactionOverride?.reason || "").trim();
    if (!reason) throw Object.assign(new Error("Interaction override reason is required"), { statusCode: 400 });
    interactionOverride = {
      by: req.authUser.username,
      name: req.authUser.name || req.authUser.username,
      role: req.authUser.role,
      reason: reason.slice(0, 500),
      at: nowIso(),
      interactions: Array.isArray(incoming.interactionOverride?.interactions)
        ? clone(incoming.interactionOverride.interactions.slice(0, 20))
        : []
    };
  }
  if (interactionReview?.code === "same-patient" && !interactionOverride) {
    throw Object.assign(new Error("Same-patient interaction requires pharmacist approval"), { statusCode: 403 });
  }
  const requestedBranch = branchIdFromAny(incoming.branch_id || incoming.branchId || incoming.branch, state.branches);
  const branchId = assertBranchAccess(req, requestedBranch || currentBranchFromRequest(req, state), state);
  const normalizedItems = normalizeSaleItems(state, req, incoming.items, branchId);
  const subtotal = normalizedItems.reduce((sum, item) => sum + item.price * item.qty, 0);
  const discount = Math.min(subtotal, nonNegativeNumber(incoming.discount || 0, "Discount"));
  if (discount > 0 && !hasRolePermission(state, req.authUser, "overridePrice")) {
    throw Object.assign(new Error("Discounts require pharmacist or manager access"), { statusCode: 403 });
  }
  const total = Number(Math.max(0, subtotal - discount).toFixed(2));
  const suppliedDetails = Array.isArray(incoming.paymentDetails) ? incoming.paymentDetails : [];
  const tendered = nonNegativeNumber(
    incoming.paid ?? suppliedDetails.reduce((sum, detail) => sum + (Number(detail?.tendered ?? detail?.amount) || 0), 0),
    "Payment"
  );
  if (tendered < total) {
    const error = new Error("Payment is less than the sale total");
    error.statusCode = 400;
    throw error;
  }
  const requestedMethod = String(suppliedDetails[0]?.method || incoming.payment || "Cash").trim() || "Cash";
  const allowedPaymentMethods = new Set(["Cash", "MoMo", "Card", "NHIS"]);
  const method = allowedPaymentMethods.has(requestedMethod) ? requestedMethod : "Cash";
  const { items, totalCost } = allocateSaleStock(state, normalizedItems, branchId);
  const id = String(incoming.id || makeId("INV"));
  const branch = branchNameFromId(branchId, state.branches);
  const requestedCustomerId = Number(incoming.customerId);
  const storedCustomer = Number.isFinite(requestedCustomerId)
    ? state.customers.find(customer => Number(customer.id) === requestedCustomerId && (
      String(customer.name || "").trim().toLowerCase() === "walk-in" || recordInScope(customer, branchId, state)
    ))
    : null;
  return normalizeBranchRecord({
    id,
    date: incoming.date && !Number.isNaN(new Date(incoming.date).getTime()) ? incoming.date : nowIso(),
    branch_id: branchId,
    branch,
    customer: storedCustomer?.name || "Walk-in",
    customerId: storedCustomer?.id || null,
    payment: method,
    paymentDetails: [{ method, amount: total, tendered, change: Number((tendered - total).toFixed(2)) }],
    paid: tendered,
    change: Number((tendered - total).toFixed(2)),
    due: 0,
    onAccount: false,
    processedBy: req.authUser.username,
    items,
    subtotal: Number(subtotal.toFixed(2)),
    total,
    totalCost,
    profit: Number((total - totalCost).toFixed(2)),
    discount,
    tax: 0,
    interactionReview,
    interactionOverride,
    interactionWarnings: Array.isArray(incoming.interactionWarnings)
      ? clone(incoming.interactionWarnings.slice(0, 20))
      : []
  }, state.branches);
}

function updateCustomerAfterSale(state, sale) {
  if (!sale?.customerId) return;
  const customer = state.customers.find(item => Number(item.id) === Number(sale.customerId));
  if (!customer || String(customer.name || "").trim().toLowerCase() === "walk-in") return;
  customer.lastVisit = sale.date;
  const due = Number(sale.due) || 0;
  if (due > 0 || sale.onAccount === true) {
    const debtAmount = sale.onAccount ? (Number(sale.total) || 0) : due;
    customer.balance = Number((Number(customer.balance || 0) + debtAmount).toFixed(2));
  }
  if (!sale.prescription) return;
  customer.medicalRecords = Array.isArray(customer.medicalRecords) ? customer.medicalRecords : [];
  if (customer.medicalRecords.some(record => record.saleId === sale.id)) return;
  customer.medicalRecords.unshift({
    id: makeId("RX"),
    type: "Prescription",
    date: sale.date,
    note: `Prescription ${sale.prescription} dispensed: ${(sale.items || []).map(item => `${item.name} x${item.qty}`).join(", ")}`,
    saleId: sale.id,
    by: sale.processedBy
  });
}

function buildCanonicalRefund(state, req, body) {
  const originalId = String(body.original_sale_id || body.originalSaleId || body.refund?.refundAgainst || "").trim();
  const original = state.sales.find(record => record.id === originalId && !record.refundAgainst);
  if (!original) {
    const error = new Error("Original sale was not found");
    error.statusCode = 404;
    throw error;
  }
  assertBranchAccess(req, original.branch_id, state);
  if (state.sales.some(record => record.refundAgainst === original.id)) {
    const error = new Error("This sale has already been refunded");
    error.statusCode = 409;
    throw error;
  }
  (original.items || []).forEach(item => {
    const drug = state.drugs.find(candidate => candidate.id === Number(item.id ?? item.drug_id));
    if (!drug) return;
    restoreReturnedItemStock(drug, item, original.branch_id, original.id, state);
  });
  const incomingId = String(body.refund?.id || "");
  const id = incomingId || makeId("RFND");
  return normalizeBranchRecord({
    id,
    date: nowIso(),
    branch_id: original.branch_id,
    customer: original.customer,
    customerId: original.customerId ?? null,
    payment: "Refund",
    paymentDetails: [{ method: "Refund", amount: -Math.abs(Number(original.total) || 0) }],
    paid: -Math.abs(Number(original.total) || 0),
    due: 0,
    onAccount: false,
    refundAgainst: original.id,
    processedBy: req.authUser.username,
    items: clone(original.items || []),
    total: -Math.abs(Number(original.total) || 0),
    totalCost: -Math.abs(Number(original.totalCost) || 0),
    profit: -(Number(original.profit) || 0),
    discount: 0,
    tax: 0
  }, state.branches);
}

function buildCanonicalPurchase(state, req, body) {
  const incoming = body.purchase || body;
  const requestedBranch = branchIdFromAny(incoming.branch_id || incoming.branchId || incoming.branch, state.branches);
  const branchId = assertBranchAccess(req, requestedBranch || currentBranchFromRequest(req, state), state);
  if (!Array.isArray(incoming.items) || !incoming.items.length) {
    const error = new Error("Purchase must contain at least one item");
    error.statusCode = 400;
    throw error;
  }
  const supplierId = incoming.supplierId ?? incoming.supplier_id;
  const supplier = state.suppliers.find(record =>
    String(record.id) === String(supplierId) && recordInScope(record, branchId, state));
  if (!supplier) {
    const error = new Error("Select a supplier registered for this branch");
    error.statusCode = 400;
    throw error;
  }
  const prepared = incoming.items.map((item, index) => {
    const drugId = Number(item.drug_id ?? item.drugId ?? item.id);
    const drug = state.drugs.find(candidate => candidate.id === drugId);
    if (!drug) {
      const error = new Error(`Purchase item ${index + 1} was not found`);
      error.statusCode = 409;
      throw error;
    }
    if (!isDrugAvailableAtBranch(drug, branchId, state)) {
      const error = new Error(`${drug.name || drugId} is not available at this branch`);
      error.statusCode = 409;
      throw error;
    }
    const qty = positiveInteger(item.qty, `Purchase quantity for ${drug.name || drugId}`);
    const cost = nonNegativeNumber(item.cost, `Purchase cost for ${drug.name || drugId}`);
    const batch = String(item.batch || "").trim();
    const expiry = String(item.expiry || "").trim();
    if (!batch || !expiry || Number.isNaN(new Date(expiry).getTime())) {
      const error = new Error(`Purchase item ${index + 1} requires a valid batch and expiry date`);
      error.statusCode = 400;
      throw error;
    }
    return { drug, qty, cost, batch, expiry };
  });
  const branch = branchNameFromId(branchId, state.branches);
  const items = prepared.map(({ drug, qty, cost, batch, expiry }) => {
    setDrugStock(drug, branchId, getDrugStock(drug, branchId, state) + qty, state);
    drug.costPrice = cost;
    const batchId = makeBatchRecordId(drug.id, batch, expiry, branchId, incoming.invoice || incoming.id || Date.now());
    addDrugBatchStock(drug, {
      qty,
      cost,
      batch,
      batch_id: batchId,
      expiry,
      supplierId: supplier.id,
      supplier: supplier.name || "",
      invoice: incoming.invoice || "",
      receivedDate: incoming.date || nowIso().slice(0, 10)
    }, branchId, state);
    return { drugId: drug.id, drug_id: drug.id, name: drug.name, qty, cost, batch, batchId, expiry, branch_id: branchId, branch };
  });
  return normalizeBranchRecord({
    id: String(incoming.id || makeId("GRN")),
    branch_id: branchId,
    supplier: String(supplier.name || ""),
    supplierId: supplier.id,
    invoice: String(incoming.invoice || ""),
    date: incoming.date || nowIso().slice(0, 10),
    items,
    total: Number(items.reduce((sum, item) => sum + item.qty * item.cost, 0).toFixed(2)),
    receivedBy: req.authUser.username
  }, state.branches);
}

function applySyncPayload(state, body, req) {
  const isRestore = body.restore === true;
  if (isRestore && String(req.authUser?.role || "").toLowerCase() !== "director") {
    throw Object.assign(new Error("Only a director can restore financial history"), { statusCode: 403 });
  }
  if (isRestore) {
    if (Array.isArray(body.drugs)) {
      const drugIds = new Set();
      body.drugs.forEach((drug, index) => {
        const id = Number(drug.id ?? drug.drug_id ?? drug.drugId);
        if (!Number.isFinite(id) || id <= 0) throw Object.assign(new Error(`Restored drug at row ${index + 1} has invalid id`), { statusCode: 400 });
        if (drugIds.has(id)) throw Object.assign(new Error(`Duplicate drug id ${id} in restore payload`), { statusCode: 400 });
        drugIds.add(id);
        const stock = Number(drug.stock ?? drug.quantity ?? 0);
        if (stock < 0) throw Object.assign(new Error(`Drug "${drug.name || id}" has negative stock`), { statusCode: 400 });
        const price = Number(drug.price ?? 0);
        const costPrice = Number(drug.costPrice ?? drug.cost_price ?? 0);
        if (price < 0 || costPrice < 0) throw Object.assign(new Error(`Drug "${drug.name || id}" has negative price`), { statusCode: 400 });
      });
      state.drugs = body.drugs.map(drug => normalizeDrug(drug, state.branches)).filter(drug => Number.isFinite(drug.id));
    }
    if (Array.isArray(body.customers)) {
      const customerIds = new Set();
      body.customers.forEach((customer, index) => {
        if (!String(customer.name || "").trim()) throw Object.assign(new Error(`Customer at row ${index + 1} is missing name`), { statusCode: 400 });
        const id = Number(customer.id);
        if (Number.isFinite(id) && id > 0) {
          if (customerIds.has(id)) throw Object.assign(new Error(`Duplicate customer id ${id} in restore payload`), { statusCode: 400 });
          customerIds.add(id);
        }
      });
      state.customers = body.customers.map(customer => normalizeCustomer(customer, state.branches));
    }
    if (Array.isArray(body.suppliers)) {
      state.suppliers = body.suppliers.map(record => normalizeBranchRecord(record, state.branches));
    }
    if (Array.isArray(body.salesHistory || body.sales)) {
      const saleIds = new Set();
      state.sales = (body.salesHistory || body.sales).map((record, index) => {
        if (!record || !String(record.id || "").trim() || !Array.isArray(record.items) || !Number.isFinite(Number(record.total)) || Number.isNaN(new Date(record.date).getTime())) {
          throw Object.assign(new Error(`Invalid restored sale at row ${index + 1}: missing id, items, total, or date`), { statusCode: 400 });
        }
        if (saleIds.has(record.id)) throw Object.assign(new Error(`Duplicate sale id "${record.id}" in restore payload`), { statusCode: 400 });
        saleIds.add(record.id);
        return normalizeBranchRecord(record, state.branches);
      });
    }
    if (Array.isArray(body.purchaseHistory || body.purchases)) {
      (body.purchaseHistory || body.purchases).forEach((record, index) => {
        if (!Array.isArray(record.items)) throw Object.assign(new Error(`Purchase at row ${index + 1} is missing items array`), { statusCode: 400 });
      });
      state.purchases = (body.purchaseHistory || body.purchases).map(record => normalizeBranchRecord(record, state.branches));
    }
    if (Array.isArray(body.auditLog)) {
      state.auditLog = body.auditLog.map(record => normalizeBranchRecord(record, state.branches)).slice(0, AUDIT_LOG_ACTIVE_CAP);
    }
    addAudit(state, req, "backup-restore", "Restored encrypted browser backup data to the sync server", currentBranchFromRequest(req, state));
    return;
  }
  if (Array.isArray(body.customers)) {
    body.customers.map(customer => normalizeCustomer(customer, state.branches)).forEach(customer => {
      assertBranchAccess(req, customer.branch_id, state);
      assertExistingRecordAccess(state.customers, customer.id, req, state);
      upsertById(state.customers, customer);
    });
  }
  if (Array.isArray(body.drugs)) {
    body.drugs.forEach(drug => upsertAuthorizedDrug(state, req, drug, drug.branchStock || drug.branchStocks || drug.branch_stocks));
  }
  if (Array.isArray(body.suppliers)) {
    body.suppliers.map(record => normalizeBranchRecord(record, state.branches)).forEach(record => {
      assertBranchAccess(req, record.branch_id, state);
      assertExistingRecordAccess(state.suppliers, record.id, req, state);
      upsertById(state.suppliers, record);
    });
  }
  addAudit(state, req, "sync-upload", "Merged local inventory, customer, and supplier data into the sync server", currentBranchFromRequest(req, state));
}

function syncSnapshot(state, scope, req) {
  const effectiveScope = scope === "all" && !isDirector(req.authUser)
    ? getAuthorizedBranchIds(req.authUser, state)
    : scope;
  return {
    pharmacy_id: state.pharmacy_id,
    pharmacy: state.pharmacy,
    updatedAt: state.updatedAt,
    branches: state.branches,
    users: visibleUsersForRequest(state, req).map(withoutPassword),
    drugs: state.drugs
      .filter(drug => drugAvailableInScope(drug, effectiveScope, state))
      .map(drug => responseDrug(drug, req, effectiveScope, state)),
    customers: state.customers.filter(customer =>
      String(customer.name || "").trim().toLowerCase() === "walk-in" || recordInScope(customer, effectiveScope, state)),
    sales: scopedRecords(state.sales, effectiveScope, state),
    salesHistory: scopedRecords(state.sales, effectiveScope, state),
    suppliers: scopedRecords(state.suppliers, effectiveScope, state),
    purchases: scopedRecords(state.purchases, effectiveScope, state),
    purchaseHistory: scopedRecords(state.purchases, effectiveScope, state),
    heldSales: scopedRecords(state.heldSales, effectiveScope, state),
    auditLog: scopedRecords(state.auditLog, effectiveScope, state),
    stockTransfers: scopedRecords(state.stockTransfers, effectiveScope, state),
    stockWriteoffs: scopedRecords(state.stockWriteoffs, effectiveScope, state),
    rolePermissions: clone(state.rolePermissions)
  };
}

async function handleApi(req, res, route, url) {
  const state = await readState();
  const segments = route.split("/").filter(Boolean);
  const method = req.method;

  if (method === "GET" && route === "/health") {
    let dbPing = USE_POSTGRES ? "unchecked" : "n/a";
    if (USE_POSTGRES) {
      try {
        await getPostgresPool().query("SELECT 1");
        dbPing = "ok";
      } catch (pingErr) {
        dbPing = "error";
        console.error("[health] PostgreSQL ping failed:", pingErr.message);
        return sendJson(res, 503, { ok: false, service: "akopharmah-pos-sync", dbPing, error: "Database unreachable" });
      }
    }
    return sendJson(res, 200, {
      ok: true,
      service: "akopharmah-pos-sync",
      pharmacy_id: state.pharmacy_id,
      pharmacy: state.pharmacy,
      branches: state.branches.length,
      drugs: state.drugs.length,
      updatedAt: state.updatedAt,
      storage: storageHealth(),
      dbPing
    });
  }

  if (method === "POST" && route === "/auth/login") {
    const body = await readBody(req);
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    const { record } = getLoginFailureRecord(req, username);
    if (record.count >= LOGIN_MAX_FAILURES) {
      return sendError(res, 429, "Too many failed login attempts. Try again later.");
    }
    const user = state.users.find(item => String(item.username || "").toLowerCase() === username);
    const passwordMatches = await bcrypt.compare(password, user?.passwordHash || DUMMY_PASSWORD_HASH);
    if (!user || !passwordMatches) {
      recordLoginFailure(req, username);
      return sendError(res, 401, "Invalid username or password");
    }
    clearLoginFailures(req, username);
    const normalizedUser = normalizeUser(user, state.branches);
    const session = createSession(normalizedUser);
    return sendJson(res, 200, {
      user: withoutPassword(normalizedUser),
      rolePermissions: clone(state.rolePermissions),
      ...session
    });
  }

  if (method === "POST" && route === "/csp-report") {
    const body = await readBody(req).catch(() => ({}));
    console.warn("[CSP] Violation:", JSON.stringify(body).slice(0, 500));
    return sendJson(res, 204, {});
  }

  if (!checkApiRateLimit(req)) {
    return sendError(res, 429, "Too many requests — please slow down");
  }

  authenticateRequest(req, state);

  if (method === "POST" && route === "/auth/logout") {
    sessions.delete(req.sessionToken);
    if (USE_POSTGRES) {
      getPostgresPool().query("DELETE FROM akopharmah_sessions WHERE token = $1", [req.sessionToken])
        .catch(err => console.warn("[sessions] Logout delete failed:", err.message));
    }
    return sendJson(res, 200, { ok: true });
  }
  if (method === "GET" && route === "/auth/me") return sendJson(res, 200, withoutPassword(req.authUser));

  if (method === "POST" && route === "/auth/password") {
    const body = await readBody(req);
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");
    const userRecord = state.users.find(u => String(u.username || "").toLowerCase() === req.authUser.username.toLowerCase());
    if (!userRecord) return sendError(res, 404, "User not found");
    const valid = await bcrypt.compare(currentPassword, userRecord.passwordHash || DUMMY_PASSWORD_HASH);
    if (!valid) return sendError(res, 401, "Current password is incorrect");
    if (newPassword.length < MIN_PASSWORD_LENGTH) return sendError(res, 400, `New password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    if (Buffer.byteLength(newPassword, "utf8") > MAX_BCRYPT_PASSWORD_BYTES) return sendError(res, 400, "New password is too long");
    if (currentPassword === newPassword) return sendError(res, 400, "New password must differ from current password");
    const snapshot = clone(state);
    try {
      userRecord.passwordHash = await bcrypt.hash(newPassword, BCRYPT_WORK_FACTOR);
      addAudit(state, req, "password-change", `User ${req.authUser.username} changed their password`, currentBranchFromRequest(req, state));
      await writeState(state);
    } catch (err) {
      Object.assign(state, snapshot);
      throw err;
    }
    return sendJson(res, 200, { ok: true });
  }
  if (method === "GET" && route === "/role-permissions") {
    return sendJson(res, 200, { permissions: clone(state.rolePermissions), updatedAt: state.updatedAt });
  }
  if (method === "POST" && route === "/role-permissions") {
    requireDirector(req);
    const body = await readBody(req);
    state.rolePermissions = normalizeRolePermissions(body.permissions || body, { strict: true });
    addAudit(state, req, "role-permissions-update", "Updated the server role permission matrix", currentBranchFromRequest(req, state));
    await writeState(state);
    return sendJson(res, 200, { permissions: clone(state.rolePermissions), updatedAt: state.updatedAt });
  }
  const scope = branchScopeFromRequest(req, url, state);

  if (method === "GET" && route === "/branches") return sendJson(res, 200, state.branches);
  if (method === "POST" && route === "/branches") {
    requireDirector(req);
    const body = await readBody(req);
    const incoming = body.branch || body;
    const id = String(incoming.id || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const name = String(incoming.name || "").trim();
    if (!id || !name) return sendError(res, 400, "Branch id and name are required");
    const existing = state.branches.find(branch => branch.id === id);
    const oldName = existing?.name || "";
    if (existing) existing.name = name;
    else state.branches.push({ id, name });
    state.drugs.forEach(drug => {
      drug.branchStock = drug.branchStock || {};
      drug.branchAvailability = drug.branchAvailability || {};
      if (oldName && oldName !== name && Object.prototype.hasOwnProperty.call(drug.branchStock, oldName)) {
        drug.branchStock[name] = drug.branchStock[oldName];
        delete drug.branchStock[oldName];
      }
      if (oldName && oldName !== name && Object.prototype.hasOwnProperty.call(drug.branchAvailability, oldName)) {
        drug.branchAvailability[name] = drug.branchAvailability[oldName];
        delete drug.branchAvailability[oldName];
      }
      if (drug.branchStock[name] == null) drug.branchStock[name] = 0;
      if (drug.branchAvailability[name] == null) drug.branchAvailability[name] = true;
      normalizeDrugBatches(drug, state.branches).forEach(batch => {
        if (batch.branch_id === id) batch.branch = name;
      });
    });
    const collections = [state.users, state.customers, state.sales, state.suppliers, state.purchases, state.heldSales, state.auditLog, state.stockTransfers, state.stockWriteoffs];
    collections.forEach(records => records.forEach(record => {
      if (record.branch_id === id || record.branchId === id || (oldName && record.branch === oldName)) record.branch = name;
      if (Array.isArray(record.branches) && oldName) record.branches = record.branches.map(branchName => branchName === oldName ? name : branchName);
    }));
    addAudit(state, req, "branch-save", `Saved branch ${name}`, id);
    await writeState(state);
    return sendJson(res, 200, { id, name });
  }
  if (method === "DELETE" && route === "/branches") {
    requireDirector(req);
    const body = await readBody(req);
    const id = branchIdFromAny(body.id || body.branch_id || body.branch, state.branches);
    if (!id) return sendError(res, 404, "Branch not found");
    if (state.branches.length <= 1) return sendError(res, 409, "At least one branch is required");
    const branch = state.branches.find(item => item.id === id);
    const hasStock = state.drugs.some(drug => {
      const branchStock = Number(drug.branchStock?.[branch.name]) || 0;
      const batchStock = normalizeDrugBatches(drug, state.branches)
        .filter(batch => batch.branch_id === id)
        .reduce((sum, batch) => sum + (Number(batch.qty) || 0), 0);
      return branchStock > 0 || batchStock > 0;
    });
    const inUse = [state.users, state.customers, state.sales, state.suppliers, state.purchases, state.heldSales]
      .some(records => records.some(record => normalizeUserBranchIds(record, state.branches).includes(id) || branchIdFromAny(record.branch_id || record.branchId || record.branch, state.branches) === id));
    if (hasStock || inUse) return sendError(res, 409, "Branch is in use or still has stock");
    state.drugs.forEach(drug => {
      drug.batches = normalizeDrugBatches(drug, state.branches).filter(batch => batch.branch_id !== id);
      if (drug.branchStock) delete drug.branchStock[branch.name];
      if (drug.branchAvailability) delete drug.branchAvailability[branch.name];
    });
    state.branches = state.branches.filter(item => item.id !== id);
    addAudit(state, req, "branch-delete", `Deleted branch ${branch.name}`, currentBranchFromRequest(req, state));
    await writeState(state);
    return sendJson(res, 200, { ok: true, id });
  }
  if (method === "GET" && route === "/users") {
    requirePermission(req, state, "managerAccess");
    return sendJson(res, 200, visibleUsersForRequest(state, req).map(withoutPassword));
  }

  if (method === "POST" && route === "/users") {
    requirePermission(req, state, "managerAccess");
    const body = await readBody(req);
    const user = await upsertUserCredential(state, body, req);
    addAudit(state, req, "user-save", `Saved user ${user.username}`, user.branch_id);
    await writeState(state);
    return sendJson(res, 200, withoutPassword(user));
  }

  if (method === "DELETE" && route === "/users") {
    requirePermission(req, state, "managerAccess");
    const body = await readBody(req);
    const username = String(body.username || "").trim().toLowerCase();
    const index = state.users.findIndex(user => String(user.username || "").toLowerCase() === username);
    if (index < 0) return sendError(res, 404, "User not found");
    if (username === String(req.authUser.username || "").toLowerCase()) return sendError(res, 409, "You cannot delete the signed-in user");
    const targetRole = String(state.users[index].role || "").toLowerCase();
    if (String(req.authUser.role || "").toLowerCase() !== "director" && ["manager", "director"].includes(targetRole)) {
      return sendError(res, 403, "Only a director can delete manager or director accounts");
    }
    const [deletedUser] = state.users.splice(index, 1);
    addAudit(state, req, "user-delete", `Deleted user ${username}`, deletedUser.branch_id);
    await writeState(state);
    return sendJson(res, 200, { ok: true, username });
  }

  if (method === "GET" && route === "/sync") {
    requirePermission(req, state, "exportBackup");
    return sendJson(res, 200, syncSnapshot(state, scope, req));
  }

  if (method === "POST" && route === "/sync") {
    requireDirector(req);
    const body = await readBody(req);
    applySyncPayload(state, body, req);
    await writeState(state);
    return sendJson(res, 200, syncSnapshot(state, "all", req));
  }

  if (method === "GET" && route === "/customers") {
    requireAnyPermission(req, state, ["viewPatients", "sell"]);
    const visibleCustomers = state.customers.filter(customer =>
      String(customer.name || "").trim().toLowerCase() === "walk-in" || recordInScope(customer, scope, state));
    return sendJson(res, 200, visibleCustomers);
  }

  if (method === "POST" && route === "/customers") {
    requirePermission(req, state, "editPatients");
    const body = await readBody(req);
    const customer = normalizeCustomer(body.customer || body, state.branches);
    const customerBranchId = branchIdFromAny(customer.branch_id || customer.branchId || customer.branch, state.branches) || currentBranchFromRequest(req, state);
    assertBranchAccess(req, customerBranchId, state);
    const existingCustomer = assertExistingRecordAccess(state.customers, customer.id, req, state);
    const isWalkIn = String(customer.name || "").trim().toLowerCase() === "walk-in";
    if (isWalkIn && !existingCustomer) return sendError(res, 409, "The Walk-in customer already exists");
    if (existingCustomer && String(existingCustomer.name || "").trim().toLowerCase() === "walk-in") {
      return sendError(res, 403, "The built-in Walk-in customer cannot be edited");
    }
    Object.assign(customer, normalizeBranchRecord({ ...customer, branch_id: customerBranchId }, state.branches));
    upsertById(state.customers, customer);
    addAudit(state, req, "customer-save", `Saved customer ${customer.name}`, customerBranchId);
    await writeState(state);
    return sendJson(res, 200, customer);
  }

  if (method === "POST" && route === "/customers/payment") {
    requireAnyPermission(req, state, ["editPatients", "sell"]);
    const body = await readBody(req);
    const customerId = Number(body.customerId || body.customer_id);
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return sendError(res, 400, "Payment amount must be a positive number");
    const customer = state.customers.find(c => Number(c.id) === customerId);
    if (!customer || String(customer.name || "").trim().toLowerCase() === "walk-in") return sendError(res, 404, "Customer not found");
    assertBranchAccess(req, customer.branch_id, state);
    const snapshot = clone(state);
    try {
      customer.balance = Number(Math.max(0, (Number(customer.balance || 0) - amount)).toFixed(2));
      addAudit(state, req, "customer-payment", `Received GH₵${amount.toFixed(2)} from ${customer.name} (new balance: GH₵${customer.balance.toFixed(2)})`, customer.branch_id);
      await writeState(state);
    } catch (err) {
      Object.assign(state, snapshot);
      throw err;
    }
    return sendJson(res, 200, { ok: true, customerId, balance: customer.balance });
  }

  if (method === "GET" && route === "/drugs") {
    requireAnyPermission(req, state, ["sell", "viewInventory", "viewPurchases", "processReturns", "viewExpiry"]);
    return sendJson(res, 200, state.drugs
      .filter(drug => drugAvailableInScope(drug, scope, state))
      .map(drug => responseDrug(drug, req, scope, state)));
  }

  if ((method === "POST" || method === "PUT") && segments[0] === "drugs" && segments[1]) {
    requirePermission(req, state, "editInventory");
    const body = await readBody(req);
    const incoming = { ...(body.drug || body), id: Number(segments[1]) };
    const drug = upsertAuthorizedDrug(state, req, incoming, body.branch_stocks || body.branchStock || body.branchStocks);
    addAudit(state, req, "inventory-save", `Saved inventory item ${drug.name || drug.id}`, currentBranchFromRequest(req, state));
    await writeState(state);
    return sendJson(res, 200, responseDrug(drug, req, "all", state));
  }

  if (method === "DELETE" && segments[0] === "drugs" && segments[1]) {
    requirePermission(req, state, "deleteInventory");
    const body = await readBody(req);
    const id = Number(segments[1]);
    const index = state.drugs.findIndex(drug => drug.id === id);
    if (index < 0) return sendError(res, 404, "Drug not found");
    const drugToDelete = state.drugs[index];
    const forceDelete = body.force === true;
    const globalDelete = body.scope === "global";

    if (globalDelete) {
      if (!isDirector(req.authUser)) return sendError(res, 403, "Only a director can delete a drug from every branch");
      const totalStock = Object.values(drugToDelete.branchStock || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
      const batchStock = normalizeDrugBatches(drugToDelete, state.branches).reduce((sum, batch) => sum + (Number(batch.qty) || 0), 0);
      const hasStock = totalStock > 0 || batchStock > 0;
      if (hasStock && !forceDelete) {
        return sendError(res, 409, "This drug still has stock. A director must confirm deletion with stock.", {
          branchStock: totalStock,
          batchStock
        });
      }
      const [drug] = state.drugs.splice(index, 1);
      const stockNote = hasStock ? ` and discarded ${totalStock} branch-stock unit(s) (${batchStock} batch-tracked)` : "";
      addAudit(state, req, "inventory-delete-global", `Deleted inventory item ${drug.name || id} from every branch${stockNote}`, currentBranchFromRequest(req, state));
      await writeState(state);
      return sendJson(res, 200, { ok: true, id, scope: "global", discardedStock: hasStock ? totalStock : 0 });
    }

    const requestedBranchId = branchIdFromAny(body.branch_id || body.branchId || body.branch, state.branches);
    const branchId = assertBranchAccess(req, requestedBranchId || currentBranchFromRequest(req, state), state);
    const branchName = branchNameFromId(branchId, state.branches);
    const branchStock = getDrugStock(drugToDelete, branchId, state);
    const branchBatches = normalizeDrugBatches(drugToDelete, state.branches)
      .filter(batch => batch.branch_id === branchId);
    const batchStock = branchBatches.reduce((sum, batch) => sum + (Number(batch.qty) || 0), 0);
    const hasStock = branchStock > 0 || batchStock > 0;
    if (hasStock && !forceDelete) {
      return sendError(res, 409, `This drug still has stock at ${branchName}. A director must confirm branch removal with stock.`, {
        branchStock,
        batchStock,
        branch_id: branchId
      });
    }
    if (hasStock && !isDirector(req.authUser)) {
      return sendError(res, 403, "Only a director can remove a drug that still has stock at this branch");
    }
    drugToDelete.branchAvailability = normalizeBranchAvailability(drugToDelete.branchAvailability, state.branches);
    drugToDelete.branchAvailability[branchName] = false;
    setDrugStock(drugToDelete, branchId, 0, state);
    drugToDelete.batches = normalizeDrugBatches(drugToDelete, state.branches)
      .filter(batch => batch.branch_id !== branchId);
    const stockNote = hasStock ? ` and discarded ${branchStock} branch-stock unit(s) (${batchStock} batch-tracked)` : "";
    addAudit(state, req, "inventory-delete-branch", `Removed ${drugToDelete.name || id} from ${branchName}${stockNote}`, branchId);
    await writeState(state);
    return sendJson(res, 200, {
      ok: true,
      id,
      scope: "branch",
      branch_id: branchId,
      discardedStock: hasStock ? branchStock : 0
    });
  }

  if (method === "GET" && route === "/sales") {
    requireAnyPermission(req, state, ["sell", "viewHistory", "viewSummary", "processReturns"]);
    return sendJson(res, 200, scopedRecords(state.sales, scope, state));
  }

  if (method === "POST" && route === "/sales") {
    requirePermission(req, state, "sell");
    const body = await readBody(req);
    const requestedId = String(body.sale?.id || body.id || "");
    const existing = requestedId ? state.sales.find(record => record.id === requestedId) : null;
    if (existing) {
      assertBranchAccess(req, existing.branch_id, state);
      return sendJson(res, 200, existing);
    }
    const sale = buildCanonicalSale(state, req, body);
    const snapshot = clone(state);
    try {
      state.sales.unshift(sale);
      updateCustomerAfterSale(state, sale);
      addAudit(state, req, "sale-save", `Saved sale ${sale.id}`, sale.branch_id);
      await writeState(state);
    } catch (err) {
      Object.assign(state, snapshot);
      throw err;
    }
    return sendJson(res, 200, sale);
  }

  if (method === "POST" && route === "/returns") {
    requirePermission(req, state, "processReturns");
    const body = await readBody(req);
    const requestedId = String(body.refund?.id || body.id || "");
    const existing = requestedId ? state.sales.find(record => record.id === requestedId) : null;
    if (existing) {
      assertBranchAccess(req, existing.branch_id, state);
      return sendJson(res, 200, existing);
    }
    const refund = buildCanonicalRefund(state, req, body);
    const snapshot = clone(state);
    try {
      state.sales.unshift(refund);
      addAudit(state, req, "return-save", `Processed return ${refund.id} for sale ${refund.refundAgainst || ""}`, refund.branch_id);
      await writeState(state);
    } catch (err) {
      Object.assign(state, snapshot);
      throw err;
    }
    return sendJson(res, 200, refund);
  }

  if (method === "POST" && route === "/sales/retention") {
    requirePermission(req, state, "importData");
    const body = await readBody(req);
    const cutoff = new Date(body.cutoff);
    if (Number.isNaN(cutoff.getTime())) return sendError(res, 400, "A valid retention cutoff is required");
    const before = state.sales.length;
    state.sales = state.sales.filter(sale => !recordInScope(sale, scope, state) || new Date(sale.date).getTime() >= cutoff.getTime());
    const removed = before - state.sales.length;
    addAudit(state, req, "retention-cleanup", `Removed ${removed} sale record(s) before ${cutoff.toISOString()}`, currentBranchFromRequest(req, state));
    await writeState(state);
    return sendJson(res, 200, { ok: true, removed });
  }

  if (method === "GET" && route === "/suppliers") {
    requirePermission(req, state, "viewPurchases");
    return sendJson(res, 200, scopedRecords(state.suppliers, scope, state));
  }

  if (method === "POST" && route === "/suppliers") {
    requirePermission(req, state, "managePurchases");
    const body = await readBody(req);
    const supplier = normalizeBranchRecord(body.supplier || body, state.branches);
    assertBranchAccess(req, supplier.branch_id, state);
    if (!supplier.id) supplier.id = Date.now();
    assertExistingRecordAccess(state.suppliers, supplier.id, req, state);
    upsertById(state.suppliers, supplier);
    addAudit(state, req, "supplier-save", `Saved supplier ${supplier.name || supplier.id}`, supplier.branch_id);
    await writeState(state);
    return sendJson(res, 200, supplier);
  }

  if (method === "GET" && route === "/purchases") {
    requirePermission(req, state, "viewPurchases");
    return sendJson(res, 200, scopedRecords(state.purchases, scope, state));
  }

  if (method === "POST" && route === "/purchases") {
    requirePermission(req, state, "managePurchases");
    const body = await readBody(req);
    const requestedId = String(body.purchase?.id || body.id || "");
    const existing = requestedId ? state.purchases.find(record => record.id === requestedId) : null;
    if (existing) {
      assertBranchAccess(req, existing.branch_id, state);
      return sendJson(res, 200, existing);
    }
    const purchase = buildCanonicalPurchase(state, req, body);
    const snapshot = clone(state);
    try {
      state.purchases.unshift(purchase);
      addAudit(state, req, "purchase-save", `Saved GRN ${purchase.invoice || purchase.id}`, purchase.branch_id);
      await writeState(state);
    } catch (err) {
      Object.assign(state, snapshot);
      throw err;
    }
    return sendJson(res, 200, purchase);
  }

  if (method === "GET" && route === "/audit-log") {
    requirePermission(req, state, "managerAccess");
    if (url.searchParams.get("archived") === "true") {
      requireDirector(req);
      if (USE_POSTGRES) {
        const result = await getPostgresPool().query(
          "SELECT id, timestamp::text, username, branch_id, action, details FROM akopharmah_audit_archive ORDER BY timestamp DESC LIMIT 1000"
        );
        return sendJson(res, 200, result.rows);
      }
      const archiveFile = path.join(DATA_DIR, "akopharmah-audit-archive.ndjson");
      if (!fs.existsSync(archiveFile)) return sendJson(res, 200, []);
      const lines = fs.readFileSync(archiveFile, "utf8").trim().split("\n").filter(Boolean);
      const parsed = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      return sendJson(res, 200, parsed.reverse().slice(0, 1000));
    }
    return sendJson(res, 200, scopedRecords(state.auditLog, scope, state));
  }

  if (method === "POST" && route === "/audit-log") {
    const body = await readBody(req);
    const entry = normalizeBranchRecord({
      ...body,
      id: body.id || makeId("AUD"),
      timestamp: nowIso(),
      user: req.authUser.username
    }, state.branches);
    assertBranchAccess(req, entry.branch_id, state);
    assertExistingRecordAccess(state.auditLog, entry.id, req, state);
    upsertById(state.auditLog, entry);
    if (state.auditLog.length > AUDIT_LOG_ACTIVE_CAP) {
      const overflow = state.auditLog.splice(AUDIT_LOG_ACTIVE_CAP);
      archiveAuditEntries(overflow);
    }
    await writeState(state);
    return sendJson(res, 200, entry);
  }

  if (method === "GET" && route === "/stock-transfers") {
    requirePermission(req, state, "transferStock");
    return sendJson(res, 200, scopedRecords(state.stockTransfers, scope, state));
  }

  if (method === "POST" && route === "/stock-transfers") {
    requirePermission(req, state, "transferStock");
    const transfer = await readBody(req);
    const id = transfer.id || makeId("TRF");
    const existingTransfer = state.stockTransfers.find(record => record.id === id);
    if (existingTransfer) {
      assertBranchAccess(req, existingTransfer.from_branch_id || existingTransfer.branch_id, state);
      return sendJson(res, 200, existingTransfer);
    }
    const drugId = Number(transfer.drug_id ?? transfer.drugId);
    const drug = state.drugs.find(item => item.id === drugId);
    if (!drug) return sendError(res, 404, "Drug not found");
    const fromBranchId = branchIdFromAny(transfer.from_branch_id || transfer.fromBranchId || transfer.from_branch, state.branches);
    const toBranchId = branchIdFromAny(transfer.to_branch_id || transfer.toBranchId || transfer.to_branch, state.branches);
    let qty = 0;
    try {
      qty = positiveInteger(transfer.qty, "Transfer quantity");
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
    if (!fromBranchId || !toBranchId || fromBranchId === toBranchId) {
      return sendError(res, 400, "Invalid stock transfer");
    }
    assertBranchAccess(req, fromBranchId, state);
    assertBranchAccess(req, toBranchId, state);
    if (!isDrugAvailableAtBranch(drug, fromBranchId, state)) {
      return sendError(res, 409, `This drug is not available at ${branchNameFromId(fromBranchId, state.branches)}`);
    }
    if (!isDrugAvailableAtBranch(drug, toBranchId, state)) {
      return sendError(res, 409, `This drug is not available at ${branchNameFromId(toBranchId, state.branches)}`);
    }
    const available = getDrugStock(drug, fromBranchId, state);
    if (available < qty) {
      return sendError(res, 409, "Insufficient stock for transfer", { available, requested: qty });
    }
    const trackedBatchQty = normalizeDrugBatches(drug, state.branches)
      .filter(batch => batch.branch_id === fromBranchId)
      .reduce((sum, batch) => sum + (Number(batch.qty) || 0), 0);
    if (trackedBatchQty > 0 && trackedBatchQty < qty) {
      return sendError(res, 409, "Batch quantities do not cover the requested transfer", { available: trackedBatchQty, requested: qty });
    }
    const batchAllocations = transferDrugBatchStock(drug, fromBranchId, toBranchId, qty, state);
    const allocatedQty = batchAllocations.reduce((sum, allocation) => sum + (Number(allocation.qty) || 0), 0);
    if (trackedBatchQty > 0 && allocatedQty !== qty) {
      return sendError(res, 409, "Batch transfer allocation failed", { allocated: allocatedQty, requested: qty });
    }
    setDrugStock(drug, fromBranchId, available - qty, state);
    setDrugStock(drug, toBranchId, getDrugStock(drug, toBranchId, state) + qty, state);
    const normalizedTransfer = {
      ...transfer,
      id,
      branch_id: fromBranchId,
      branch: branchNameFromId(fromBranchId, state.branches),
      from_branch_id: fromBranchId,
      from_branch: branchNameFromId(fromBranchId, state.branches),
      to_branch_id: toBranchId,
      to_branch: branchNameFromId(toBranchId, state.branches),
      batch_allocations: batchAllocations,
      batchAllocations,
      date: transfer.date || nowIso()
    };
    const snapshot = clone(state);
    try {
      state.stockTransfers.unshift(normalizedTransfer);
      addAudit(state, req, "stock-transfer", `Transferred ${qty} unit(s) of ${drug.name || drugId}`, fromBranchId);
      await writeState(state);
    } catch (err) {
      Object.assign(state, snapshot);
      throw err;
    }
    return sendJson(res, 200, normalizedTransfer);
  }

  if (method === "GET" && route === "/stock-writeoffs") {
    requirePermission(req, state, "writeOffStock");
    return sendJson(res, 200, scopedRecords(state.stockWriteoffs, scope, state));
  }

  if (method === "POST" && route === "/stock-writeoffs") {
    requirePermission(req, state, "writeOffStock");
    const writeoff = await readBody(req);
    const requestedId = String(writeoff.id || "");
    const existingWriteoff = requestedId ? state.stockWriteoffs.find(record => record.id === requestedId) : null;
    if (existingWriteoff) {
      assertBranchAccess(req, existingWriteoff.branch_id, state);
      return sendJson(res, 200, existingWriteoff);
    }
    const drugId = Number(writeoff.drug_id ?? writeoff.drugId);
    const drug = state.drugs.find(item => item.id === drugId);
    if (!drug) return sendError(res, 404, "Drug not found");
    const branchId = branchIdFromAny(writeoff.branch_id || writeoff.branchId || writeoff.branch, state.branches) || currentBranchFromRequest(req, state);
    assertBranchAccess(req, branchId, state);
    const oldStock = getDrugStock(drug, branchId, state);
    const qty = positiveInteger(writeoff.qty ?? oldStock, "Write-off quantity");
    if (qty > oldStock) return sendError(res, 409, "Write-off exceeds branch stock", { available: oldStock, requested: qty });
    const batchId = writeoff.batch_id || writeoff.batchId;
    if (batchId) {
      const batch = findDrugBatch(drug, batchId, state);
      if (!batch || batch.branch_id !== branchId) return sendError(res, 404, "Batch was not found at this branch");
      if (qty > (Number(batch.qty) || 0)) {
        return sendError(res, 409, "Write-off exceeds batch stock", { available: Number(batch.qty) || 0, requested: qty });
      }
      reduceDrugBatchQty(drug, batchId, qty, state);
    } else {
      const trackedBatchQty = normalizeDrugBatches(drug, state.branches)
        .filter(batch => batch.branch_id === branchId)
        .reduce((sum, batch) => sum + (Number(batch.qty) || 0), 0);
      if (trackedBatchQty > 0 && trackedBatchQty < qty) {
        return sendError(res, 409, "Batch quantities do not cover this write-off", { available: trackedBatchQty, requested: qty });
      }
      deductDrugBatchStock(drug, branchId, qty, state);
    }
    setDrugStock(drug, branchId, oldStock - qty, state);
    const normalizedWriteoff = normalizeBranchRecord({
      ...writeoff,
      id: writeoff.id || makeId("WOF"),
      qty,
      date: writeoff.date || nowIso()
    }, state.branches);
    const snapshot = clone(state);
    try {
      state.stockWriteoffs.unshift(normalizedWriteoff);
      addAudit(state, req, "stock-writeoff", `Wrote off ${qty} unit(s) of ${drug.name || drugId}`, branchId);
      await writeState(state);
    } catch (err) {
      Object.assign(state, snapshot);
      throw err;
    }
    return sendJson(res, 200, normalizedWriteoff);
  }

  return sendError(res, 404, "API route not found");
}

function stripApiPrefix(pathname) {
  if (pathname === "/api") return "/";
  if (pathname.startsWith("/api/")) return pathname.slice(4);
  return pathname;
}

function isApiRoute(route) {
  if (API_ROUTES.has(route)) return true;
  if (/^\/drugs\/[^/]+$/.test(route)) return true;
  return false;
}

function isStateMutation(method, route) {
  return ["POST", "PUT", "DELETE"].includes(method) && route !== "/auth/login";
}

function withStateWriteLock(task) {
  const run = stateWriteQueue.then(task, task);
  stateWriteQueue = run.catch(err => {
    console.error("[CRITICAL] State write lock error — state may be inconsistent:", err?.message || err);
  });
  return run;
}

function isAllowedStaticPath(pathname) {
  return [
    "/index.html",
    "/pos.css",
    "/logo.png",
    "/data/seed.js",
    "/data/seed.json",
    "/js/app.js",
    "/js/app-runtime.js",
    "/js/chart.min.js",
    "/js/core/dom-renderer.js"
  ].includes(pathname)
    || /^\/js\/modules\/0[0-7]-[a-z0-9-]+\.js$/i.test(pathname);
}

function publicSeedPayload() {
  const seed = getSeedCache();
  const walkIn = seed.customers.find(customer => String(customer.name || "").toLowerCase() === "walk-in")
    || { id: 1, name: "Walk-in", phone: "", notes: "", balance: 0 };
  return {
    pharmacy_id: "akopharmah",
    pharmacy: "Akopharmah",
    version: 1,
    branches: seed.branches,
    users: [],
    drugs: seed.drugs.map(drug => ({
      ...drug,
      stock: 0,
      quantity: 0,
      branchStock: Object.fromEntries(seed.branches.map(branch => [branch.name, 0])),
      batches: []
    })),
    customers: [{ id: walkIn.id || 1, name: "Walk-in", phone: "", notes: "", balance: 0 }],
    referenceDrugs: seed.referenceDrugs
  };
}

function publicSeedScript() {
  return `window.AKOPHARMAH_SEED = ${JSON.stringify(publicSeedPayload()).replace(/</g, "\\u003c")};`;
}

function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return sendError(res, 404, "Not found");
  let safePath = "";
  try {
    safePath = decodeURIComponent(pathname.split("?")[0]);
  } catch {
    return sendError(res, 400, "Bad request");
  }
  if (safePath === "/" || safePath === "") safePath = "/index.html";
  if (safePath === "/favicon.ico") safePath = "/logo.png";
  if (safePath === "/logo.ico.png") safePath = "/logo.png";
  if (!isAllowedStaticPath(safePath)) return sendError(res, 404, "File not found");
  if (safePath === "/data/seed.js") {
    const script = publicSeedScript();
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    return req.method === "HEAD" ? res.end() : res.end(script);
  }
  if (safePath === "/data/seed.json") {
    return sendJson(res, 200, publicSeedPayload());
  }
  const filePath = path.resolve(ROOT_DIR, `.${safePath}`);
  const relative = path.relative(ROOT_DIR, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return sendError(res, 403, "Forbidden");
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return sendError(res, 404, "File not found");
  const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(filePath).pipe(res);
}

function applyCors(req, res) {
  const origin = String(req.headers.origin || "");
  if (!origin) return true;
  const configured = String(process.env.AKOPHARMAH_CORS_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  const forwardedProtocol = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProtocol || (req.socket.encrypted ? "https" : "http");
  const sameOrigin = `${protocol}://${req.headers.host || ""}`;
  if (origin !== sameOrigin && !configured.includes(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  return true;
}

const server = http.createServer(async (req, res) => {
  if (!applyCors(req, res)) return sendError(res, 403, "Origin is not allowed");
  const forwardedProtocol = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  if (forwardedProtocol === "https" || req.socket.encrypted) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,X-Pharmacy-Id,X-Branch-Id");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net data:; img-src 'self' data: blob:; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; report-uri /csp-report");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const route = stripApiPrefix(url.pathname);
  try {
    if (isApiRoute(route)) {
      const handle = () => handleApi(req, res, route, url);
      return isStateMutation(req.method, route) ? await withStateWriteLock(handle) : await handle();
    }
    return serveStatic(req, res, url.pathname);
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error(error);
    return sendError(res, status, error.message || "Server error", error.details);
  }
});

function validateEnvironment() {
  if (!Number.isFinite(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error(`PORT "${process.env.PORT}" is not a valid port number (1-65535)`);
  }
  if (USE_POSTGRES) {
    console.log(`[startup] Storage: PostgreSQL (state row "${POSTGRES_STATE_ID}")`);
    if (!POSTGRES_SSL) console.warn("[startup] Warning: PostgreSQL connection does not use SSL. Consider enabling sslmode=require for production.");
    console.info("[startup] Security: For maximum data protection, enable at-rest encryption at the PostgreSQL provider level (e.g., Render Postgres uses encrypted storage by default).");
  } else {
    console.log(`[startup] Storage: JSON file at ${DATA_FILE}`);
    if (IS_RENDER && !CONFIGURED_DATA_FILE) {
      throw new Error(
        "FATAL: Running on Render without persistent storage. " +
        "Set DATABASE_URL for PostgreSQL or AKOPHARMAH_DATA_FILE pointing to a mounted disk path. " +
        "Without this, all data is lost on every restart."
      );
    }
  }
  if (FIELD_ENC_KEY) {
    console.log("[startup] Field-level encryption: enabled (AES-256-GCM)");
  } else if (FIELD_ENC_KEY_HEX) {
    throw new Error("AKOPHARMAH_FIELD_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)");
  } else {
    console.warn("[startup] Field-level encryption: disabled. Set AKOPHARMAH_FIELD_ENCRYPTION_KEY=<64 hex chars> to encrypt patient PII at rest.");
  }
  console.log(`[startup] Session TTL: ${Math.round(SESSION_TTL_MS / 60000)} minutes | Audit cap: ${AUDIT_LOG_ACTIVE_CAP} | API rate limit: ${API_RATE_MAX} req/min`);
}

async function loadSessionsFromPostgres() {
  if (!USE_POSTGRES) return;
  try {
    const result = await getPostgresPool().query(
      "SELECT token, username, EXTRACT(EPOCH FROM expires_at) * 1000 AS expires_ms FROM akopharmah_sessions WHERE expires_at > now()"
    );
    for (const row of result.rows) {
      sessions.set(row.token, { username: row.username, expiresAt: Number(row.expires_ms) });
    }
    if (result.rowCount > 0) console.log(`[startup] Restored ${result.rowCount} active session(s) from PostgreSQL`);
  } catch (err) {
    console.warn("[startup] Could not restore sessions from PostgreSQL:", err.message);
  }
}

async function startServer() {
  validateEnvironment();
  await ensureStorage();
  await loadSessionsFromPostgres();
  server.listen(PORT, HOST, () => {
    console.log(`Akopharmah POS sync server running at http://${HOST}:${PORT}`);
  });
}

startServer().catch(error => {
  console.error("Could not start Akopharmah POS sync server:", error);
  process.exitCode = 1;
});

