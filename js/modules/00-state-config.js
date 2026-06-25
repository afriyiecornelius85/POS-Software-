/* Akopharmah POS - Application Logic
 * Extracted from akopharm-pos.html
 * Edit this file for all business logic, data, and UI behaviour.
 */

// Global constants
const DEFAULT_MARGIN = 0.30;   // 30% markup on cost price (selling price = cost x 1.3) - change here to update everywhere
const APP_VERSION = "2.0.0";
const APP_VERSION_LABEL = `Version ${APP_VERSION} Upgrade`;
const DEFAULT_REORDER_QUANTITY = 0;
const DEFAULT_MAX_STOCK = 0;

const STORAGE_KEYS = {
  drugs: "akopharm_drugs", customers: "akopharm_customers", sales: "akopharm_sales",
  held: "akopharm_held", user: "akopharm_user", branch: "akopharm_branch",
  shiftSession: "akopharm_shift_session", shiftHours: "akopharm_shift_hours",
  auditLog: "akopharm_audit_log", suppliers: "akopharm_suppliers",
  purchases: "akopharm_purchases", draftPOs: "akopharm_draft_pos",
  stockAdj: "akopharm_stock_adjustments",
  users: "akopharm_users",
  branches: "akopharm_branches",
  rolePermissions: "akopharm_role_permissions",
  referenceDrugs: "akopharm_reference_drugs",
  lastFullBackup: "akopharm_last_full_backup",
  lastAutoBackup: "akopharm_last_auto_backup",
  majorBackups: "akopharm_major_change_backups",
  autoBackups: "akopharm_auto_backups",
  apiBase: "akopharm_api_base"
};

const APP_SETTINGS_KEY = "akopharm_admin_settings";
const SIDEBAR_COLLAPSED_KEY = "akopharm_sidebar_collapsed";
const SESSION_TOKEN_KEY = "akopharm_session_token";
const DEFAULT_APP_SETTINGS = Object.freeze({
  pharmacyName: "Akopharmah Pharmacy",
  pharmacyPhone: "+233248718050 | +233541100007",
  receiptFooter: "Thank you for choosing Akopharmah Pharmacy.",
  lowStockDefault: 15,
  backupCadenceDays: 7,
  inactivityMinutes: 12,
  dataRetentionMonths: 24,
  autoBackupEnabled: true,
  receiptPrinterType: "browser",
  receiptPaperWidth: "80",
  receiptLogoDataUrl: "",
  receiptShowLogo: true,
  receiptShowBranch: true,
  receiptShowCustomer: true,
  shiftSchedule: [
    { name: "Morning", start: "07:30", end: "15:00" },
    { name: "Afternoon", start: "15:00", end: "22:00" }
  ],
  categoryLowStock: {}
});

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
let ROLE_PERMISSIONS = readCachedRolePermissions();

const VIEW_PERMISSIONS = Object.freeze({
  held: "viewHeld",
  patients: "viewPatients",
  history: "viewHistory",
  reference: "viewReference",
  admin: "viewInventory",
  summary: "viewSummary",
  purchases: "viewPurchases",
  "shift-log": "viewShiftLog",
  expiry: "viewExpiry",
  lowstock: "viewInventory",
  returns: "processReturns",
  settings: "managerAccess",
  sync: "managerAccess"
});

const BACKUP_REMINDER_DAYS = 7;
const MAX_LOCAL_MAJOR_BACKUPS = 8;
const OFFLINE_CREDENTIAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PHARMACY_ID = "akopharmah";
const PHARMACY_NAME = "Akopharmah";

function renderHtml(target, markup) {
  if (typeof moduleRenderHtml === "function") return moduleRenderHtml(target, markup);
  if (target) target.textContent = String(markup ?? "");
  return target;
}

function readApiBaseUrl() {
  if (shouldUseHostedApiBase()) return "/api";
  const configured = (window.AKOPHARMAH_API_BASE || localStorage.getItem(STORAGE_KEYS.apiBase) || "").trim().replace(/\/$/, "");
  return configured;
}

function isLocalHostName(hostname = window.location.hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function shouldUseHostedApiBase(hostname = window.location.hostname) {
  const protocol = String(window.location.protocol || "");
  return /^https?:$/i.test(protocol) && !isLocalHostName(hostname);
}

let API_BASE_URL = readApiBaseUrl();
const LIVE_SYNC_MS = 15000;

const FALLBACK_SEED_DATA = Object.freeze({
  branches: [
    { id: "kwame-danso-main", name: "Kwame Danso Main" },
    { id: "kwame-danso-annex", name: "Kwame Danso Annex" },
    { id: "techimantia", name: "Techimantia" },
    { id: "derma", name: "Derma" },
    { id: "abuakwa", name: "Abuakwa" }
  ],
  users: [],
  drugs: [],
  customers: [{ id: 1, name: "Walk-in", phone: "", notes: "", balance: 0 }],
  referenceDrugs: []
});
const APP_SEED_DATA = (window.AKOPHARMAH_SEED && typeof window.AKOPHARMAH_SEED === "object") ? window.AKOPHARMAH_SEED : FALLBACK_SEED_DATA;

function cloneSeedValue(value) {
  if (Array.isArray(value)) return value.map(item => cloneSeedValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneSeedValue(item)]));
  }
  return value;
}

function getSeedArray(key) {
  const value = APP_SEED_DATA[key] || FALLBACK_SEED_DATA[key] || [];
  return Array.isArray(value) ? cloneSeedValue(value) : [];
}

function dedupeReferenceDrugs(rows) {
  const seen = new Set();
  return (rows || []).filter(row => {
    const key = [(row[0] || "").toLowerCase().trim(), (row[2] || "").toLowerCase().trim(), (row[3] || "").toLowerCase().trim()].join("||");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cloneRolePermissions(source = DEFAULT_ROLE_PERMISSIONS) {
  return Object.fromEntries(Object.entries(source).map(([permission, roles]) => [permission, [...roles]]));
}

function normalizeRolePermissions(source) {
  const validRoles = new Set(["cashier", "worker", "pharmacist", "manager", "director"]);
  const incoming = source && typeof source === "object" ? source : {};
  const normalized = Object.fromEntries(Object.entries(DEFAULT_ROLE_PERMISSIONS).map(([permission, defaults]) => {
    const roles = Array.isArray(incoming[permission]) ? incoming[permission] : defaults;
    return [permission, [...new Set(roles.map(role => String(role || "").toLowerCase()).filter(role => validRoles.has(role)))]];
  }));
  if (!normalized.managerAccess.includes("director")) normalized.managerAccess.push("director");
  // Backfill cashier into any permission it should have by default, for existing stored data
  Object.keys(DEFAULT_ROLE_PERMISSIONS).forEach(perm => {
    if (DEFAULT_ROLE_PERMISSIONS[perm].includes("cashier") && !normalized[perm].includes("cashier")) {
      normalized[perm].unshift("cashier");
    }
  });
  return normalized;
}

function readCachedRolePermissions() {
  try {
    return normalizeRolePermissions(JSON.parse(localStorage.getItem(STORAGE_KEYS.rolePermissions) || "null"));
  } catch (_) {
    return cloneRolePermissions(DEFAULT_ROLE_PERMISSIONS);
  }
}

function applyRolePermissions(payload, { persist = true } = {}) {
  ROLE_PERMISSIONS = normalizeRolePermissions(payload?.permissions || payload);
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEYS.rolePermissions, JSON.stringify(ROLE_PERMISSIONS));
    } catch (_) {}
  }
  return cloneRolePermissions(ROLE_PERMISSIONS);
}

function getPermissionRoles(permission) {
  const roles = ROLE_PERMISSIONS[permission];
  return Array.isArray(roles) ? roles : [];
}

// Browser checks control visibility; the server independently enforces protected actions.
function hasPermission(permission, user = currentUser) {
  const roles = getPermissionRoles(permission);
  const role = String(user?.role || "").toLowerCase();
  return !!user && roles.includes(role);
}

function requirePermission(permission, message = "Access denied") {
  if (hasPermission(permission)) return true;
  showToast(message, 2500, "error");
  return false;
}
const LOGIN_SUGGESTIONS_KEY = "akopharm_login_usernames";
const DEFAULT_SHIFT_SCHEDULE = [
  { name: "Morning", start: "07:30", end: "15:00" },
  { name: "Afternoon", start: "15:00", end: "22:00" }
];
let currentUser = null;
let shiftSession = null;
let saleSubmissionInProgress = false;
let shiftHours = {};
let shiftTimer = null;
let editingDrugId = null;
let inventoryViewMode = 'all';
let historyFilterType = 'today';
let historyStartDate = null;
let historyEndDate = null;
let returnsFilterType = "open";
let summaryFilterType = 'today';
let summaryStartDate = null;
let summaryEndDate = null;
let recentUsernames = [];
// ── User profiles ──
let userProfiles = getSeedArray("users");
let auditLog = [];
let suppliers = [];
let purchaseHistory = [];
let draftPurchaseOrders = [];

// ── Collapsible panel helper ──────────────────────────────────────────
function toggleCollapsible(bodyId, toggleEl) {
  const body = document.getElementById(bodyId);
  if (!body) return;
  const isOpen = body.classList.toggle("open");
  if (toggleEl) toggleEl.classList.toggle("open", isOpen);
  if (isOpen) {
    body.onclick = event => {
      if (event.target === body) closeCollapsibleModal(bodyId, toggleEl?.id);
    };
  } else {
    body.onclick = null;
  }
  updateCollapsibleModalState();
}

function closeCollapsibleModal(bodyId, toggleId) {
  const body = document.getElementById(bodyId);
  if (!body) return;
  body.classList.remove("open");
  body.onclick = null;
  const toggle = toggleId
    ? document.getElementById(toggleId)
    : document.querySelector(`[onclick*="${bodyId}"]`);
  if (toggle) toggle.classList.remove("open");
  updateCollapsibleModalState();
}

function updateCollapsibleModalState() {
  const anyOpen = !!document.querySelector(".collapsible-body.open");
  document.body?.classList.toggle("panel-modal-open", anyOpen);
}
let stockAdjustments = [];
let inactivityTimer = null;
const DEFAULT_INACTIVITY_LIMIT_MS = 12 * 60 * 1000;
const DEFAULT_REORDER_POINT = 15;
let defaultDrugs = getSeedArray("drugs");

let defaultCustomers = getSeedArray("customers");

let referenceDrugs = dedupeReferenceDrugs(getSeedArray("referenceDrugs"));
let referenceSortCol = 1;
let referenceSortAsc = true;
let editingReferenceIndex = null;

let drugs = [];
let customers = [];
let cart = [];
let heldSales = [];
let salesHistory = [];
let activeCat = "All";
let payMethod = "Cash";
let selectedCustomerId = null;
let selectedPatientId = null;
let dayStats = { revenue: 0, txCount: 0, items: 0, payMethods: {} };
const SUMMARY_START_MINUTES = 7 * 60 + 30;
const SUMMARY_END_MINUTES = 22 * 60;
const SUMMARY_SLOT_MINUTES = 30;
const SUMMARY_SLOT_COUNT = Math.floor((SUMMARY_END_MINUTES - SUMMARY_START_MINUTES) / SUMMARY_SLOT_MINUTES) + 1;
const SUMMARY_HOURLY_LABELS = Array.from({ length: SUMMARY_SLOT_COUNT }, (_, index) => {
  const totalMinutes = SUMMARY_START_MINUTES + (index * SUMMARY_SLOT_MINUTES);
  const hours24 = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const suffix = hours24 >= 12 ? "pm" : "am";
  const hours12 = ((hours24 + 11) % 12) + 1;
  return `${hours12}:${String(minutes).padStart(2, "0")}${suffix}`;
});
let hourlyData = Array(SUMMARY_SLOT_COUNT).fill(0);
let summaryChart = null;
let dashboardHourlyChart = null;
let summaryDetailCharts = {};
let summaryChartMetric = "hourly";
let summaryChartType = "bar";
let summaryChartData = {
  hourly: Array(SUMMARY_SLOT_COUNT).fill(0),
  hourlyLabels: SUMMARY_HOURLY_LABELS,
  hourlyTitle: "Hourly revenue (GHS)",
  hourlySubtitle: "Sales grouped from 7:30am to 10:00pm",
  payments: [],
  categories: []
};
let topDrugs = {};
let branchRecords = getSeedArray("branches");
let branches = branchRecords.map(branch => branch.name);
let branchIndex = 0;
let liveSyncTimer = null;
let scannerBuffer = "";
let scannerTimer = null;
let pendingConfirmAction = null;
let backupEncryptionKey = null;
let backupEncryptionUsername = "";
const DEFAULT_LOW_STOCK_THRESHOLD = 15;

function makeClientId(prefix) {
  const uuid = globalThis.crypto?.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${uuid}`;
}

const INTERACTION_SEVERITY = {
  contraindicated: { label: "Contraindicated", rank: 4, blocksCheckout: true },
  serious: { label: "Serious interaction: Avoid combination", rank: 3, blocksCheckout: true },
  monitor: { label: "Monitor closely", rank: 2, blocksCheckout: false },
  minor: { label: "Minor interaction", rank: 1, blocksCheckout: false }
};

const INTERACTION_SOURCES = Object.freeze({
  ciprofloxacinDailyMed: {
    name: "DailyMed: Ciprofloxacin drug interactions",
    url: "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=888dc7f9-ad9c-4c00-8d50-8ddfd9bd27c0"
  },
  fluconazoleDailyMed: {
    name: "DailyMed: Fluconazole drug interactions",
    url: "https://dailymed.nlm.nih.gov/dailymed/lookup.cfm?setid=4eaf5b04-c026-4a49-879f-2925b375f903"
  },
  tramadolDailyMed: {
    name: "DailyMed: Tramadol drug interactions",
    url: "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=f5ca9de8-2f03-1578-e053-2a95a90add47"
  },
  warfarinDailyMed: {
    name: "DailyMed: Warfarin drug interactions",
    url: "https://www.dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=2cbcc99d-9107-4d39-a1e9-e19305de8b5d"
  },
  spironolactoneDailyMed: {
    name: "DailyMed: Spironolactone drug interactions",
    url: "https://dailymed.nlm.nih.gov/dailymed/lookup.cfm?setid=beaf74db-4159-3b59-ef99-575c3ac99aa1"
  },
  lisinoprilDailyMed: {
    name: "DailyMed: Lisinopril drug interactions",
    url: "https://www.dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=e56f3738-3103-3ba4-e053-2a95a90aebb4"
  },
  ondansetronDailyMed: {
    name: "DailyMed: Ondansetron warnings and interactions",
    url: "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=4ae18cf9-450f-4b42-a11e-8506b5783f02"
  },
  azithromycinDailyMed: {
    name: "DailyMed: Azithromycin drug interactions",
    url: "https://dailymed.awsprod.nlm.nih.gov/dailymed/drugInfo.cfm?setid=f4c5422c-356c-8fcf-e053-2995a90ae0d9"
  },
  simvastatinDailyMed: {
    name: "DailyMed: Simvastatin drug interactions",
    url: "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=4fd79a00-7215-4fb5-8284-688687d99bef"
  },
  atorvastatinDailyMed: {
    name: "DailyMed: Atorvastatin drug interactions",
    url: "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=f87b565f-40fc-4615-b58c-60182c8079f3"
  },
  dolutegravirDailyMed: {
    name: "DailyMed: Tivicay (dolutegravir) drug interactions",
    url: "https://dailymed.nlm.nih.gov/dailymed/lookup.cfm?setid=485bc9db-8665-9f5a-e063-6394a90a7921&version=1"
  },
  levothyroxineDailyMed: {
    name: "DailyMed: Levothyroxine absorption interactions",
    url: "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=59a99739-2da5-46a7-8811-1169123bed9b"
  },
  cotrimoxazoleDailyMed: {
    name: "DailyMed: Sulfamethoxazole/trimethoprim interactions",
    url: "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=b000150f-3be6-2e6c-e053-2995a90a67d5"
  },
  doxycyclineDailyMed: {
    name: "DailyMed: Doxycycline absorption interactions",
    url: "https://dailymed.nlm.nih.gov/dailymed/lookup.cfm?setid=fad03768-f1d2-459f-965e-0ec29f189f1f"
  },
  sertralineDailyMed: {
    name: "DailyMed: Sertraline bleeding and serotonergic interactions",
    url: "https://www.dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=1f99e897-1b70-40b0-8c19-71d0bba19422"
  },
  metoclopramideDailyMed: {
    name: "DailyMed: Metoclopramide antipsychotic interaction",
    url: "https://dailymed.nlm.nih.gov/dailymed/lookup.cfm?setid=23f11d3c-1529-4bb6-a61e-e4bab1a3e98e"
  }
});

const NON_ASPIRIN_NSAID_TERMS = ["ibuprofen", "diclofenac", "naproxen", "ketorolac"];
const NSAID_TERMS = [...NON_ASPIRIN_NSAID_TERMS, "aspirin"];
const ACE_ARB_TERMS = ["lisinopril", "enalapril", "captopril", "losartan", "valsartan", "telmisartan", "irbesartan"];
const SULFONYLUREA_TERMS = ["glibenclamide", "glimepiride", "glyburide"];
const MINERAL_SUPPLEMENT_TERMS = ["calcium", "ferrous", "iron", "zinc sulfate", "zinc tablet", "zinc supplement", "multivitamin"];
const SEROTONERGIC_TERMS = ["sertraline", "fluoxetine", "amitriptyline", "tramadol"];
const ANTIPSYCHOTIC_TERMS = ["haloperidol", "olanzapine", "quetiapine", "risperidone", "clozapine"];
const QT_RISK_TERMS = [
  "ondansetron", "azithromycin", "erythromycin", "clarithromycin", "fluconazole", "ketoconazole",
  "quinine", "hydroxychloroquine", "chloroquine", "amitriptyline", "domperidone", "promethazine",
  ...ANTIPSYCHOTIC_TERMS
];

const DRUG_INTERACTION_RULES = [
  {
    a: ["tramadol", "codeine", "morphine"],
    b: ["diazepam"],
    severity: "serious",
    mechanism: "Opioid plus benzodiazepine/CNS depressant use can cause profound sedation and respiratory depression.",
    action: "Avoid routine co-use; require pharmacist/prescriber confirmation and counsel on sedation and breathing risk.",
    source: "tramadolDailyMed"
  },
  {
    a: ["tramadol"],
    b: ["sertraline", "fluoxetine", "amitriptyline"],
    severity: "serious",
    mechanism: "Tramadol has serotonergic activity; SSRIs/TCAs increase serotonin syndrome and seizure risk.",
    action: "Avoid or verify prescriber approval; counsel for agitation, sweating, tremor, diarrhea, fever, or seizures.",
    source: "tramadolDailyMed"
  },
  {
    a: ["ondansetron"],
    b: SEROTONERGIC_TERMS,
    severity: "monitor",
    mechanism: "5-HT3 antagonists have reported serotonin syndrome with serotonergic medicines.",
    action: "Counsel patient and review other serotonergic medicines before dispensing.",
    source: "ondansetronDailyMed"
  },
  {
    a: ["ciprofloxacin"],
    b: ["theophylline"],
    severity: "serious",
    mechanism: "Ciprofloxacin can increase theophylline exposure and serious CNS or other adverse reactions.",
    action: "Avoid co-use where possible; confirm prescriber plan and monitoring.",
    source: "ciprofloxacinDailyMed"
  },
  {
    a: ["ciprofloxacin"],
    b: SULFONYLUREA_TERMS,
    severity: "serious",
    mechanism: "Fluoroquinolones may potentiate sulfonylurea glucose-lowering effects; severe hypoglycemia is reported.",
    action: "Confirm indication and counsel to monitor blood glucose closely.",
    source: "ciprofloxacinDailyMed"
  },
  {
    a: ["ciprofloxacin"],
    b: ["warfarin"],
    severity: "serious",
    mechanism: "Ciprofloxacin may enhance warfarin anticoagulant effect and raise bleeding risk.",
    action: "Require INR/prothrombin-time monitoring plan before dispensing together.",
    source: "ciprofloxacinDailyMed"
  },
  {
    a: ["ciprofloxacin"],
    b: QT_RISK_TERMS.filter(term => term !== "ciprofloxacin"),
    severity: "serious",
    mechanism: "Ciprofloxacin can further prolong QT interval when combined with QT-prolonging medicines.",
    action: "Avoid in high-risk patients; verify ECG/electrolyte risk and prescriber approval.",
    source: "ciprofloxacinDailyMed"
  },
  {
    a: ["azithromycin", "erythromycin", "clarithromycin"],
    b: QT_RISK_TERMS.filter(term => !["azithromycin", "erythromycin", "clarithromycin"].includes(term)),
    severity: "serious",
    mechanism: "Macrolides can prolong QT interval; risk rises with other QT-prolonging medicines.",
    action: "Avoid in high-risk patients; check cardiac history, electrolytes, and prescriber plan.",
    source: "azithromycinDailyMed"
  },
  {
    a: ["fluconazole", "ketoconazole"],
    b: QT_RISK_TERMS.filter(term => !["fluconazole", "ketoconazole", "azithromycin", "erythromycin", "clarithromycin"].includes(term)),
    severity: "serious",
    mechanism: "Azole antifungals are associated with QT prolongation and may amplify QT risk with interacting medicines.",
    action: "Avoid in high-risk patients; verify prescriber plan and monitor for palpitations, dizziness, or syncope.",
    source: "fluconazoleDailyMed"
  },
  {
    a: ["fluconazole"],
    b: SULFONYLUREA_TERMS,
    severity: "serious",
    mechanism: "Fluconazole can increase sulfonylurea effect; clinically significant hypoglycemia has been reported.",
    action: "Confirm glucose-monitoring plan and counsel patient on hypoglycemia symptoms.",
    source: "fluconazoleDailyMed"
  },
  {
    a: ["fluconazole"],
    b: ["warfarin"],
    severity: "serious",
    mechanism: "Fluconazole with warfarin has been associated with increased prothrombin time and bleeding events.",
    action: "Require INR/prothrombin-time monitoring plan before dispensing together.",
    source: "fluconazoleDailyMed"
  },
  {
    a: ["metronidazole", "co-trimoxazole", "sulfamethoxazole", "trimethoprim", "azithromycin", "erythromycin", "clarithromycin"],
    b: ["warfarin"],
    severity: "serious",
    mechanism: "Antibiotics and antifungals can alter INR; several inventory antibiotics are documented warfarin interactors.",
    action: "Require INR/prothrombin-time monitoring plan before dispensing together.",
    source: "warfarinDailyMed"
  },
  {
    a: ["doxycycline", "ciprofloxacin"],
    b: MINERAL_SUPPLEMENT_TERMS,
    severity: "monitor",
    mechanism: "Minerals can reduce antibiotic absorption.",
    action: "Separate doses by the product label timing; ciprofloxacin commonly needs 2 hours before or 6 hours after minerals.",
    source: "doxycyclineDailyMed"
  },
  {
    a: ["dolutegravir"],
    b: MINERAL_SUPPLEMENT_TERMS,
    severity: "monitor",
    mechanism: "Calcium, iron, and multivitamins can reduce dolutegravir exposure when taken fasting.",
    action: "Give dolutegravir 2 hours before or 6 hours after mineral supplements unless taken together with food per label.",
    source: "dolutegravirDailyMed"
  },
  {
    a: ["dolutegravir"],
    b: ["metformin"],
    severity: "monitor",
    mechanism: "Dolutegravir can increase metformin plasma concentrations through OCT2/MATE1 inhibition.",
    action: "Confirm metformin dose and monitor glucose/GI intolerance after starting or stopping dolutegravir.",
    source: "dolutegravirDailyMed"
  },
  {
    a: ["dolutegravir"],
    b: ["carbamazepine"],
    severity: "serious",
    mechanism: "Carbamazepine can reduce dolutegravir exposure.",
    action: "Verify HIV regimen and dose-adjustment plan before dispensing together.",
    source: "dolutegravirDailyMed"
  },
  {
    a: ["levothyroxine"],
    b: ["calcium", "ferrous", "iron", "multivitamin"],
    severity: "monitor",
    mechanism: "Calcium and iron can bind levothyroxine and reduce thyroid hormone absorption.",
    action: "Separate dosing by at least 4 hours and keep timing consistent.",
    source: "levothyroxineDailyMed"
  },
  {
    a: ACE_ARB_TERMS,
    b: ["spironolactone"],
    severity: "serious",
    mechanism: "ACE inhibitors/ARBs with spironolactone can cause significant hyperkalemia.",
    action: "Confirm potassium and renal monitoring plan before dispensing together.",
    source: "spironolactoneDailyMed"
  },
  {
    a: ["co-trimoxazole", "sulfamethoxazole", "trimethoprim"],
    b: [...ACE_ARB_TERMS, "spironolactone"],
    severity: "serious",
    mechanism: "Trimethoprim can cause hyperkalemia, especially with ACE inhibitors, ARBs, or potassium-sparing diuretics.",
    action: "Confirm potassium/renal monitoring plan or alternative antibiotic before dispensing.",
    source: "cotrimoxazoleDailyMed"
  },
  {
    a: NSAID_TERMS,
    b: ["warfarin"],
    severity: "serious",
    mechanism: "Warfarin with NSAIDs or aspirin increases bleeding risk.",
    action: "Avoid unless specifically intended; confirm bleeding-risk plan and INR monitoring.",
    source: "warfarinDailyMed"
  },
  {
    a: NON_ASPIRIN_NSAID_TERMS,
    b: ["aspirin", "clopidogrel"],
    severity: "monitor",
    mechanism: "NSAIDs with antiplatelet therapy increase GI bleeding risk.",
    action: "Avoid duplicate pain relief where possible; counsel on bleeding and consider gastroprotection where appropriate.",
    source: "warfarinDailyMed"
  },
  {
    a: NSAID_TERMS,
    b: ["sertraline", "fluoxetine"],
    severity: "monitor",
    mechanism: "SSRIs/SNRIs can increase bleeding risk, especially with NSAIDs or aspirin.",
    action: "Counsel on bruising, black stools, vomiting blood, or unusual bleeding.",
    source: "sertralineDailyMed"
  },
  {
    a: NON_ASPIRIN_NSAID_TERMS,
    b: ["prednisolone", "dexamethasone"],
    severity: "serious",
    mechanism: "NSAIDs with systemic corticosteroids increase GI ulcer and bleeding risk.",
    action: "Use an alternative or confirm gastroprotection and prescriber approval.",
    source: "warfarinDailyMed"
  },
  {
    a: NON_ASPIRIN_NSAID_TERMS,
    b: [...ACE_ARB_TERMS, "furosemide", "hydrochlorothiazide", "spironolactone"],
    severity: "monitor",
    mechanism: "NSAIDs can reduce antihypertensive/diuretic effect and may worsen renal function in susceptible patients.",
    action: "Review renal risk, hydration, blood pressure control, and monitoring plan.",
    source: "lisinoprilDailyMed"
  },
  {
    a: ["simvastatin"],
    b: ["erythromycin", "clarithromycin", "ketoconazole"],
    severity: "contraindicated",
    mechanism: "Strong CYP3A4 inhibitors can greatly increase simvastatin exposure and myopathy/rhabdomyolysis risk.",
    action: "Do not dispense together without changing therapy; hold simvastatin or use an alternative per prescriber.",
    source: "simvastatinDailyMed"
  },
  {
    a: ["atorvastatin"],
    b: ["clarithromycin", "erythromycin", "fluconazole", "ketoconazole"],
    severity: "serious",
    mechanism: "Macrolides and azole antifungals can increase atorvastatin exposure and myopathy/rhabdomyolysis risk.",
    action: "Use lowest necessary atorvastatin dose, hold statin during short anti-infective course, or verify prescriber plan.",
    source: "atorvastatinDailyMed"
  },
  {
    a: ["atenolol", "propranolol"],
    b: ["salbutamol"],
    severity: "monitor",
    mechanism: "Beta-blockers may reduce bronchodilator effect and can worsen bronchospasm in susceptible patients.",
    action: "Check asthma/COPD history and counsel to report breathing difficulty.",
    source: "lisinoprilDailyMed"
  },
  {
    a: ["metoclopramide"],
    b: ANTIPSYCHOTIC_TERMS,
    severity: "serious",
    mechanism: "Metoclopramide with antipsychotics can increase EPS, tardive dyskinesia, and neuroleptic malignant syndrome risk.",
    action: "Avoid routine co-use; verify indication and counsel on involuntary movements, rigidity, fever, or confusion.",
    source: "metoclopramideDailyMed"
  },
  {
    a: ["doxycycline"],
    b: ["carbamazepine"],
    severity: "monitor",
    mechanism: "Carbamazepine can decrease doxycycline half-life and may reduce antibiotic exposure.",
    action: "Confirm prescriber plan or alternative antibiotic if treatment response is a concern.",
    source: "doxycyclineDailyMed"
  },
  {
    a: ["carbamazepine"],
    b: ["warfarin"],
    severity: "monitor",
    mechanism: "Carbamazepine can induce warfarin metabolism and reduce anticoagulant effect.",
    action: "Confirm INR monitoring plan when starting or stopping carbamazepine.",
    source: "warfarinDailyMed"
  }
];
