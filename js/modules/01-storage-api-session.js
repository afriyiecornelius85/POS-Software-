function loadFromStorage(key, fallback) {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function saveToStorage(key, data) {
  const serialized = JSON.stringify(data);
  try {
    localStorage.setItem(key, serialized);
  } catch (error) {
    const quotaExceeded = error?.name === "QuotaExceededError" || error?.code === 22 || error?.code === 1014;
    if (!quotaExceeded) throw error;
    if (key !== STORAGE_KEYS.autoBackups) localStorage.removeItem(STORAGE_KEYS.autoBackups);
    if (key !== STORAGE_KEYS.majorBackups) localStorage.removeItem(STORAGE_KEYS.majorBackups);
    localStorage.setItem(key, serialized);
  }
}

function getSessionToken() {
  return sessionStorage.getItem(SESSION_TOKEN_KEY) || "";
}

function setSessionToken(token) {
  if (token) sessionStorage.setItem(SESSION_TOKEN_KEY, token);
  else sessionStorage.removeItem(SESSION_TOKEN_KEY);
}

const OFFLINE_CREDENTIAL_ALGORITHM = "PBKDF2-SHA-256";
const OFFLINE_CREDENTIAL_ITERATIONS = 210000;
const OFFLINE_CREDENTIAL_BYTES = 32;

function bytesToBase64(bytes) {
  let binary = "";
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function constantTimeBytesEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function deriveOfflinePassword(password, salt, iterations = OFFLINE_CREDENTIAL_ITERATIONS) {
  if (!globalThis.crypto?.subtle) throw new Error("Secure browser cryptography is unavailable");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(password || "")),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt,
    iterations
  }, key, OFFLINE_CREDENTIAL_BYTES * 8);
  return new Uint8Array(bits);
}

async function createOfflineCredential(password) {
  if (!password || !globalThis.crypto?.getRandomValues) return null;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveOfflinePassword(password, salt);
  return {
    version: 1,
    algorithm: OFFLINE_CREDENTIAL_ALGORITHM,
    iterations: OFFLINE_CREDENTIAL_ITERATIONS,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + OFFLINE_CREDENTIAL_TTL_MS).toISOString(),
    salt: bytesToBase64(salt),
    hash: bytesToBase64(hash)
  };
}

async function verifyOfflineCredential(password, credential) {
  if (!credential || credential.algorithm !== OFFLINE_CREDENTIAL_ALGORITHM) return false;
  const expiresAt = new Date(credential.expiresAt || 0).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
  const iterations = Number(credential.iterations);
  if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000) return false;
  try {
    const expected = base64ToBytes(credential.hash);
    const actual = await deriveOfflinePassword(password, base64ToBytes(credential.salt), iterations);
    return constantTimeBytesEqual(actual, expected);
  } catch (error) {
    console.warn("Offline credential verification failed", error);
    return false;
  }
}

function sanitizeLocalUser(user = {}) {
  const { password, passwordHash, ...safeUser } = user;
  return safeUser;
}

function userProfileForServer(user = {}) {
  const { password, passwordHash, offlineCredential, ...safeUser } = user;
  return safeUser;
}

async function migrateLocalUserProfiles(profiles) {
  const migrated = [];
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    const legacyPassword = typeof profile?.password === "string" ? profile.password : "";
    const safeProfile = sanitizeLocalUser(profile);
    if (legacyPassword && !safeProfile.offlineCredential) {
      try {
        safeProfile.offlineCredential = await createOfflineCredential(legacyPassword);
      } catch (error) {
        console.warn(`Could not migrate offline credential for ${safeProfile.username || "user"}`, error);
      }
    }
    migrated.push(safeProfile);
  }
  return migrated;
}

function getAppSettings() {
  const stored = loadFromStorage(APP_SETTINGS_KEY, {});
  return { ...DEFAULT_APP_SETTINGS, ...(stored && typeof stored === "object" ? stored : {}) };
}

function saveAppSettings(settings) {
  saveToStorage(APP_SETTINGS_KEY, { ...getAppSettings(), ...settings });
}

function getOperationalLowStockDefault() {
  const value = parseInt(getAppSettings().lowStockDefault, 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_APP_SETTINGS.lowStockDefault;
}

function getBackupReminderDays() {
  const value = parseInt(getAppSettings().backupCadenceDays, 10);
  return Number.isFinite(value) && value > 0 ? value : BACKUP_REMINDER_DAYS;
}

function getInactivityLimitMs() {
  const value = parseInt(getAppSettings().inactivityMinutes, 10);
  return Number.isFinite(value) && value > 0 ? value * 60 * 1000 : DEFAULT_INACTIVITY_LIMIT_MS;
}

function getShiftSchedule() {
  const configured = getAppSettings().shiftSchedule;
  const source = Array.isArray(configured) && configured.length ? configured : DEFAULT_SHIFT_SCHEDULE;
  return source
    .map(shift => ({
      name: shift.name || "Shift",
      start: /^\d{2}:\d{2}$/.test(String(shift.start || "")) ? shift.start : "07:30",
      end: /^\d{2}:\d{2}$/.test(String(shift.end || "")) ? shift.end : "15:00"
    }))
    .filter(shift => shift.start && shift.end);
}

function getDataRetentionMonths() {
  const value = parseInt(getAppSettings().dataRetentionMonths, 10);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_APP_SETTINGS.dataRetentionMonths;
}

function getCategoryLowStockOverrides() {
  const configured = getAppSettings().categoryLowStock;
  return configured && typeof configured === "object" ? configured : {};
}

function applyReceiptSettings() {
  const settings = getAppSettings();
  const title = document.querySelector(".receipt-title");
  if (title) title.textContent = settings.pharmacyName || DEFAULT_APP_SETTINGS.pharmacyName;
  const logoWrap = document.querySelector(".receipt-logo");
  const logoImg = document.querySelector(".receipt-logo img");
  if (logoImg) logoImg.src = settings.receiptLogoDataUrl || "logo.png";
  if (logoWrap) logoWrap.style.display = settings.receiptShowLogo === false ? "none" : "";
  const branch = document.getElementById("rcBranch");
  if (branch) branch.style.display = settings.receiptShowBranch === false ? "none" : "";
  const customer = document.getElementById("rcCustomer");
  if (customer) customer.style.display = settings.receiptShowCustomer === false ? "none" : customer.textContent ? "block" : "none";
  const footer = document.getElementById("receiptFooter");
  if (footer) {
    const lines = String(settings.receiptFooter || DEFAULT_APP_SETTINGS.receiptFooter)
      .split(/\r?\n/)
      .map(line => sanitize(line.trim()))
      .filter(Boolean);
    renderHtml(footer, `${lines.join("<br />")}<br />Phone: ${sanitize(settings.pharmacyPhone)}<br />Web: akopharmahcompanylimited.com.gh`);
  }
}

function hasSameOriginApiServer() {
  if (API_BASE_URL || !/^https?:$/i.test(window.location.protocol)) return false;
  if (window.AKOPHARMAH_ASSUME_SAME_ORIGIN_API === true) return true;
  return isLocalHostName();
}

function hasApiServer() {
  return !!API_BASE_URL || hasSameOriginApiServer();
}

function getBranchById(branchId) {
  if (!branchId || !branchRecords) return null;
  return branchRecords.find(branch => branch && branch.id === branchId) || null;
}

function getBranchByName(branchName) {
  if (!branchName || !branchRecords) return null;
  return branchRecords.find(branch => branch && branch.name === branchName) || null;
}

function getBranchIdByName(branchName) {
  const found = getBranchByName(branchName);
  return found?.id || (branchRecords && branchRecords.length > 0 ? branchRecords[0].id : null);
}

function getBranchNameById(branchId) {
  const found = getBranchById(branchId);
  return found?.name || (branchRecords && branchRecords.length > 0 ? branchRecords[0].name : null);
}

function getCurrentBranchName() {
  return branches && branches[branchIndex] ? branches[branchIndex] : (branchRecords && branchRecords.length > 0 ? branchRecords[0].name : "");
}

function getCurrentBranchId() {
  return branchRecords[branchIndex]?.id || getBranchIdByName(getCurrentBranchName());
}

function slugifyBranchId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || `branch-${Date.now().toString().slice(-5)}`;
}

function normalizeBranchRecordLocal(branch, index = 0) {
  const name = String(branch?.name || branch?.branch || `Branch ${index + 1}`).trim();
  const id = slugifyBranchId(branch?.id || branch?.branch_id || name);
  return { id, name };
}

function refreshBranchNames() {
  branchRecords = (branchRecords || []).map(normalizeBranchRecordLocal);
  if (!branchRecords.length) branchRecords = getSeedArray("branches").map(normalizeBranchRecordLocal);
  branches = branchRecords.map(branch => branch.name);
  if (branchIndex < 0 || branchIndex >= branches.length) branchIndex = 0;
}

function saveUserProfiles() {
  userProfiles = userProfiles.map(sanitizeLocalUser);
  saveToStorage(STORAGE_KEYS.users, userProfiles);
}

function saveBranchRecords() {
  refreshBranchNames();
  saveToStorage(STORAGE_KEYS.branches, branchRecords);
}

function getRecordBranchId(record = {}) {
  return record.branch_id || record.branchId || getBranchIdByName(record.branch);
}

function setRecordBranch(record, branchId = getCurrentBranchId()) {
  record.branch_id = branchId;
  record.branchId = branchId;
  record.branch = getBranchNameById(branchId);
  return record;
}

function normalizeBranchId(value) {
  if (!value) return "";
  const text = String(value).trim();
  return getBranchById(text)?.id || getBranchByName(text)?.id || "";
}

function getUserProfile(username) {
  return userProfiles.find(item => String(item.username || "").toLowerCase() === String(username || "").toLowerCase()) || null;
}

function collectUserBranchIds(user = {}) {
  user = user || {};
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
  return [...new Set(values.map(normalizeBranchId).filter(Boolean))];
}

function getUserAllowedBranchIds(user = currentUser) {
  if (!user) return [];
  const profile = getUserProfile(user.username);
  return [...new Set([...collectUserBranchIds(profile || {}), ...collectUserBranchIds(user)])];
}

function getDefaultBranchIdForUser(user = currentUser) {
  const allowed = getUserAllowedBranchIds(user);
  const preferred = normalizeBranchId(user?.branch_id || user?.branchId || user?.branch);
  if (preferred && (!allowed.length || allowed.includes(preferred))) return preferred;
  return allowed[0] || (branchRecords && branchRecords.length > 0 ? branchRecords[0].id : null);
}

function canSwitchBranch(user = currentUser) {
  if (!user) return false;
  return hasPermission("switchBranch", user) || getUserAllowedBranchIds(user).length > 1;
}

function userCanAccessBranch(branchId, user = currentUser) {
  if (!user) return false;
  if (hasPermission("switchBranch", user)) return true;
  const allowed = getUserAllowedBranchIds(user);
  return allowed.length ? allowed.includes(branchId) : branchId === (user.branchId || user.branch_id);
}

function getSelectableBranchRecords(user = currentUser) {
  if (user && hasPermission("switchBranch", user)) return branchRecords;
  const allowed = getUserAllowedBranchIds(user);
  const records = allowed.map(getBranchById).filter(Boolean);
  return records.length ? records : branchRecords;
}

function normalizeUserBranch(user) {
  if (!user) return null;
  const username = user.username;
  const profile = getUserProfile(username);
  const mergedUser = { ...(profile || {}), ...user };
  const branchIds = getUserAllowedBranchIds(mergedUser);
  const requestedBranchId = normalizeBranchId(user.branch_id || user.branchId || user.branch || profile?.branch_id || profile?.branchId || profile?.branch);
  const defaultBranchId = branchRecords && branchRecords.length > 0 ? branchRecords[0].id : null;
  const branchId = branchIds.includes(requestedBranchId) ? requestedBranchId : (branchIds[0] || defaultBranchId);
  return {
    username,
    name: user.name || profile?.name || username,
    role: String(user.role || profile?.role || "").toLowerCase(),
    branch: getBranchNameById(branchId),
    branch_id: branchId,
    branchId,
    branch_ids: branchIds,
    branchIds,
    branches: branchIds.map(getBranchNameById)
  };
}

function getBranchScope(user = currentUser) {
  if (!user) return getCurrentBranchId();
  return hasPermission("managerAccess", user) ? "all" : (user.branchId || user.branch_id || getCurrentBranchId());
}

function userCanSeeRecord(record, user = currentUser) {
  if (!user) return true;
  if (hasPermission("switchBranch", user)) return true;
  const allowed = getUserAllowedBranchIds(user);
  return allowed.length ? allowed.includes(getRecordBranchId(record)) : getRecordBranchId(record) === (user.branchId || user.branch_id);
}

function getScopedRecords(records) {
  return (records || []).filter(record => userCanSeeRecord(record));
}

function recordMatchesBranch(record, branchId = getCurrentBranchId()) {
  return getRecordBranchId(record) === branchId;
}

function getRecordsForBranch(records, branchId = getCurrentBranchId()) {
  return (records || []).filter(record => recordMatchesBranch(record, branchId));
}

function getBranchStockValue(drug, branchId = getCurrentBranchId()) {
  const branchName = getBranchNameById(branchId);
  if (drug?.branchStock && drug.branchStock[branchName] != null) return Number(drug.branchStock[branchName]) || 0;
  if (branchId === getCurrentBranchId()) return Number(drug?.stock ?? 0) || 0;
  return 0;
}

function getDrugBranchName(branchRef = getCurrentBranchId()) {
  if (!branchRef) return getCurrentBranchName();
  return getBranchById(branchRef)?.name || getBranchByName(branchRef)?.name || String(branchRef);
}

function ensureDrugBranchAvailability(drug) {
  if (!drug) return {};
  const source = drug.branchAvailability || drug.branchAvailabilities || drug.branch_availability;
  drug.branchAvailability = source && typeof source === "object" ? { ...source } : {};
  branches.forEach(branch => {
    if (drug.branchAvailability[branch] == null) drug.branchAvailability[branch] = true;
  });
  delete drug.branchAvailabilities;
  delete drug.branch_availability;
  return drug.branchAvailability;
}

function isDrugAvailableAtBranch(drug, branchRef = getCurrentBranchId()) {
  if (!drug) return false;
  const branchName = getDrugBranchName(branchRef);
  const availability = ensureDrugBranchAvailability(drug);
  return availability[branchName] !== false;
}

function getAvailableDrugsForBranch(branchRef = getCurrentBranchId()) {
  return drugs.filter(drug => isDrugAvailableAtBranch(drug, branchRef));
}

function apiUrl(path, params = {}) {
  const origin = window.location.origin && window.location.origin !== "null" ? window.location.origin : "http://localhost:3000";
  const base = /^https?:\/\//i.test(API_BASE_URL) ? API_BASE_URL : origin;
  const prefix = /^https?:\/\//i.test(API_BASE_URL) ? "" : API_BASE_URL;
  const url = new URL(`${prefix}${path.startsWith("/") ? path : `/${path}`}`, base);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  });
  return url.toString();
}

async function apiRequest(path, { method = "GET", params = {}, body = null, branch = getBranchScope() } = {}) {
  if (!hasApiServer()) throw new Error("API server is not configured");
  const query = { pharmacy_id: PHARMACY_ID, pharmacy: PHARMACY_NAME, ...params };
  if (branch && !Object.prototype.hasOwnProperty.call(query, "branch")) query.branch = branch;
  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Pharmacy-Id": PHARMACY_ID,
      "X-Branch-Id": currentUser?.branchId || currentUser?.branch_id || getCurrentBranchId()
    }
  };
  const sessionToken = getSessionToken();
  if (sessionToken) options.headers.Authorization = `Bearer ${sessionToken}`;
  if (body !== null) options.body = JSON.stringify(body);
  const requestUrl = apiUrl(path, query);
  const credentialRequest = path === "/auth/login" || (path === "/users" && !!body?.password);
  if (credentialRequest) {
    const parsedUrl = new URL(requestUrl);
    const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(parsedUrl.hostname);
    if (parsedUrl.protocol !== "https:" && !isLoopback) {
      throw new Error("Password requests require HTTPS");
    }
  }
  const response = await fetch(requestUrl, options);
  if (response.status === 204) return null;
  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {
    payload = null;
  }
  if (payload === null && response.ok) {
    const error = new Error(`API ${method} ${path} did not return JSON`);
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(payload?.error || `API ${method} ${path} failed (${response.status})`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function apiGet(path, params = {}, options = {}) {
  return apiRequest(path, { ...options, method: "GET", params });
}

function apiPost(path, body = {}, options = {}) {
  return apiRequest(path, { ...options, method: "POST", body });
}

function apiDelete(path, body = {}, options = {}) {
  return apiRequest(path, { ...options, method: "DELETE", body });
}

async function syncServerAction(path, body, options = {}) {
  if (!hasApiServer()) return null;
  return apiPost(path, { pharmacy_id: PHARMACY_ID, pharmacy: PHARMACY_NAME, ...body }, options);
}

function normalizeDrugForBranch(drug, branchId = getRecordBranchId(drug)) {
  const branchName = getBranchNameById(branchId);
  const next = { ...drug };
  next.id = Number(next.id ?? next.drug_id);
  next.branch_id = branchId;
  next.branch = branchName;
  next.branchStock = { ...(next.branchStock || next.branchStocks || {}) };
  next.branchAvailability = {
    ...(next.branchAvailability || next.branchAvailabilities || next.branch_availability || {})
  };
  if (next.stock == null && next.quantity != null) next.stock = next.quantity;
  if (next.branchStock[branchName] == null) next.branchStock[branchName] = Number(next.stock ?? 0);
  next.stock = next.branchStock[getCurrentBranchName()] ?? next.stock ?? 0;
  return next;
}

function applyServerDrugs(payload) {
  if (!Array.isArray(payload)) return;
  if (payload.length && Array.isArray(payload[0]?.drugs)) {
    const byId = new Map();
    payload.forEach(group => {
      const branchId = group.branch_id || group.branchId || getBranchIdByName(group.branch || group.name);
      const branchName = getBranchNameById(branchId);
      group.drugs.forEach(item => {
        const normalized = normalizeDrugForBranch(item, branchId);
        const id = normalized.id;
        const existing = byId.get(id) || { ...normalized, branchStock: {} };
        existing.branchStock = { ...(existing.branchStock || {}), [branchName]: Number(item.stock ?? normalized.stock ?? 0) };
        byId.set(id, existing);
      });
    });
    drugs = [...byId.values()];
  } else {
    drugs = payload.map(item => normalizeDrugForBranch(item));
  }
  normalizeDrugThresholds();
  ensureDrugBranchStock();
  updateBranchStocksToCurrent();
  saveDrugs();
}

function applyServerCollection(name, payload) {
  if (!Array.isArray(payload)) return;
  if (name === "customers") {
    customers = payload.map(item => normalizePatientProfile({ ...item }));
    return;
  }
  const normalized = payload.map(item => setRecordBranch({ ...item }, getRecordBranchId(item)));
  if (name === "sales") salesHistory = normalized;
  if (name === "suppliers") suppliers = normalized;
  if (name === "purchases") purchaseHistory = normalized;
  if (name === "audit-log") auditLog = normalized;
}

async function refreshServerData({ silent = false } = {}) {
  if (!hasApiServer() || !currentUser) return false;
  try {
    const [serverCurrentUser, serverRolePermissions] = await Promise.all([
      apiGet("/auth/me", {}, { branch: null }),
      apiGet("/role-permissions", {}, { branch: null })
    ]);
    applyRolePermissions(serverRolePermissions);
    currentUser = normalizeUserBranch(serverCurrentUser);
    if (!userCanAccessBranch(getCurrentBranchId(), currentUser)) {
      const nextBranchId = getDefaultBranchIdForUser(currentUser);
      branchIndex = Math.max(0, branchRecords.findIndex(branch => branch.id === nextBranchId));
      saveToStorage(STORAGE_KEYS.branch, branchIndex);
    }
    saveToStorage(STORAGE_KEYS.user, currentUser);
    updateUserDisplay();
    const branch = getBranchScope();
    updateSyncStatus("syncing", "Syncing branch data...");
    const canViewDrugs = ["sell", "viewInventory", "viewPurchases", "processReturns", "viewExpiry"].some(permission => hasPermission(permission));
    const canViewSales = ["sell", "viewHistory", "viewSummary", "processReturns"].some(permission => hasPermission(permission));
    const canViewCustomers = ["viewPatients", "sell"].some(permission => hasPermission(permission));
    const baseRequests = [
      canViewDrugs ? apiGet("/drugs", {}, { branch }) : Promise.resolve([]),
      canViewSales ? apiGet("/sales", {}, { branch }) : Promise.resolve([]),
      canViewCustomers ? apiGet("/customers", {}, { branch }) : Promise.resolve([]),
      apiGet("/branches", {}, { branch: null })
    ];
    const canManage = hasPermission("managerAccess");
    const canViewPurchases = hasPermission("viewPurchases");
    const elevatedRequests = [
      canViewPurchases ? apiGet("/suppliers", {}, { branch }) : Promise.resolve([]),
      canViewPurchases ? apiGet("/purchases", {}, { branch }) : Promise.resolve([]),
      canManage ? apiGet("/audit-log", {}, { branch }) : Promise.resolve([]),
      canManage ? apiGet("/users", {}, { branch: null }) : Promise.resolve(null)
    ];
    const [serverDrugs, serverSales, serverCustomers, serverBranches, serverSuppliers, serverPurchases, serverAudit, serverUsers] =
      await Promise.all([...baseRequests, ...elevatedRequests]);
    if (Array.isArray(serverBranches) && serverBranches.length) {
      branchRecords = serverBranches.map(normalizeBranchRecordLocal);
      refreshBranchNames();
      saveBranchRecords();
      initBranchSelect();
    }
    if (Array.isArray(serverUsers)) {
      const offlineByUsername = new Map(userProfiles.map(user => [String(user.username || "").toLowerCase(), user.offlineCredential]));
      userProfiles = serverUsers.map(user => ({
        ...user,
        ...(offlineByUsername.get(String(user.username || "").toLowerCase()) ? { offlineCredential: offlineByUsername.get(String(user.username || "").toLowerCase()) } : {})
      }));
      saveUserProfiles();
      const refreshedCurrentUser = userProfiles.find(user => String(user.username || "").toLowerCase() === String(currentUser?.username || "").toLowerCase());
      if (refreshedCurrentUser) {
        currentUser = normalizeUserBranch(refreshedCurrentUser);
        saveToStorage(STORAGE_KEYS.user, currentUser);
        updateUserDisplay();
      }
    }
    applyServerDrugs(serverDrugs);
    applyServerCollection("sales", serverSales);
    applyServerCollection("suppliers", serverSuppliers);
    applyServerCollection("purchases", serverPurchases);
    applyServerCollection("audit-log", serverAudit);
    applyServerCollection("customers", serverCustomers);
    saveSales(); saveSuppliers(); savePurchases(); saveCustomers(); saveToStorage(STORAGE_KEYS.auditLog, auditLog);
    renderCustomerOptions();
    renderCategories();
    filterDrugs();
    renderInventoryAdmin();
    updateSummary();
    renderReturnsView();
    updateNotificationBadge();
    if (document.getElementById("view-notifications")?.classList.contains("active")) renderNotifications();
    if (document.getElementById("view-sync")?.classList.contains("active")) renderSyncBackupView();
    if (document.getElementById("view-settings")?.classList.contains("active")) renderRolePermissionsEditor();
    updateSyncStatus("online", `Last sync ${new Date().toLocaleTimeString("en-GH", { hour: "2-digit", minute: "2-digit" })}`);
    if (!silent) showToast("Live branch data synced", 2000, "info");
    return true;
  } catch (error) {
    console.warn(error);
    if (error.status === 401) {
      setSessionToken("");
      forceShiftLogout("Session expired. Please sign in again.");
      return false;
    }
    updateSyncStatus("offline", "Server unavailable");
    if (!silent) showToast("Server sync unavailable; using local data", 3000, "warning");
    return false;
  }
}

function startLiveSync() {
  if (liveSyncTimer) clearInterval(liveSyncTimer);
  if (!hasApiServer() || !currentUser) {
    updateSyncStatus(hasApiServer() ? "ready" : "local");
    return;
  }
  liveSyncTimer = setInterval(() => refreshServerData({ silent: true }), LIVE_SYNC_MS);
}

function stopLiveSync() {
  if (liveSyncTimer) clearInterval(liveSyncTimer);
  liveSyncTimer = null;
  updateSyncStatus(hasApiServer() ? "ready" : "local");
}

function getDrugLowThreshold(drug) {
  const defaultThreshold = getOperationalLowStockDefault();
  const categoryOverride = getCategoryLowStockOverrides()[drug?.cat || ""];
  const raw = categoryOverride ?? drug?.lowStockThreshold ?? drug?.reorderPoint ?? defaultThreshold;
  const threshold = parseInt(raw, 10);
  return Number.isFinite(threshold) && threshold > 0 ? threshold : defaultThreshold;
}

function getDrugReorderQuantity(drug) {
  const raw = drug?.reorderQuantity ?? drug?.reorderQty ?? DEFAULT_REORDER_QUANTITY;
  const value = parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_REORDER_QUANTITY;
}

function getDrugMaxStock(drug) {
  const raw = drug?.maxStock ?? drug?.maximumStock ?? DEFAULT_MAX_STOCK;
  const value = parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MAX_STOCK;
}

function getDrugSaleUnit(drug) {
  return String(drug?.saleUnit || drug?.sellingUnit || drug?.unit || "Unit").trim() || "Unit";
}

function formatDrugSaleUnit(drug, qty = 1) {
  const unit = getDrugSaleUnit(drug);
  if (Math.abs(Number(qty) || 0) === 1) return unit;
  const lower = unit.toLowerCase();
  if (lower === "box") return "Boxes";
  if (lower.endsWith("s")) return unit;
  return `${unit}s`;
}

function isDrugLowStock(drug) {
  const stock = drug?.stock ?? 0;
  return stock >= 0 && stock < getDrugLowThreshold(drug);
}

function normalizeDrugThresholds() {
  drugs.forEach(drug => {
    const threshold = getDrugLowThreshold(drug);
    drug.lowStockThreshold = threshold;
    drug.reorderPoint = threshold;
    drug.reorderMinimum = threshold;
    drug.reorderQuantity = getDrugReorderQuantity(drug);
    drug.maxStock = getDrugMaxStock(drug);
  });
}

// Theme toggle
const THEME_KEY = "akopharm_theme";
function updateThemeToggle(theme = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark") {
  const toggle = document.getElementById("themeToggle");
  if (!toggle) return;
  const isLight = theme === "light";
  toggle.setAttribute("aria-pressed", String(isLight));
  toggle.title = isLight ? "Switch to dark mode" : "Switch to light mode";
}
function applyTheme(theme) {
  if (theme === "light") document.documentElement.setAttribute("data-theme", "light");
  else document.documentElement.removeAttribute("data-theme");
  updateThemeToggle(theme === "light" ? "light" : "dark");
}
function toggleTheme() {
  const isLight = document.documentElement.getAttribute("data-theme") === "light";
  const next = isLight ? "dark" : "light";
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch (_) { }
}
// Restore persisted theme on load (called before DOMContentLoaded)
(function () {
  try { applyTheme(localStorage.getItem(THEME_KEY) || "dark"); } catch (_) { }
})();

// Toast notification system
// type: "success" | "error" | "warning" | "info"
const TOAST_ICONS = { success: "ti-check", error: "ti-x", warning: "ti-alert-triangle", info: "ti-info-circle" };
const TOAST_TYPES = ["success", "error", "warning", "info"];
function showToast(message, duration = 2500, type = "success") {
  const toast = document.getElementById("toast");
  const iconEl = document.getElementById("toastIcon");
  const msgEl = document.getElementById("toastMsg");
  const progressBar = document.getElementById("toastProgressBar");
  TOAST_TYPES.forEach(t => toast.classList.remove(`toast--${t}`));
  toast.classList.add(`toast--${type}`);
  if (iconEl) {
    iconEl.className = "";
    iconEl.classList.add("ti", TOAST_ICONS[type] || TOAST_ICONS.success);
  }
  msgEl.textContent = message;
  // #11 Reset and animate progress bar
  if (progressBar) {
    progressBar.style.transition = "none";
    progressBar.style.transform = "scaleX(1)";
    void progressBar.offsetWidth; // force reflow
    progressBar.style.transition = `transform ${duration}ms linear`;
    progressBar.style.transform = "scaleX(0)";
  }
  toast.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("show"), duration);
}

function setLoginError(message) {
  const errorEl = document.getElementById("loginError");
  if (!errorEl) return;
  errorEl.textContent = message || "";
  errorEl.classList.toggle("show", !!message);
}

function clearLoginError() {
  setLoginError("");
}

function openConfirmModal({ title, body, confirmText = "Confirm", icon = "ti-alert-triangle", onConfirm }) {
  pendingConfirmAction = typeof onConfirm === "function" ? onConfirm : null;
  const modal = document.getElementById("confirmModal");
  const titleEl = document.getElementById("confirmModalTitle");
  const bodyEl = document.getElementById("confirmModalBody");
  const actionEl = document.getElementById("confirmModalAction");
  const iconEl = modal?.querySelector(".confirm-modal-header i");
  if (!modal || !titleEl || !bodyEl || !actionEl) return;
  titleEl.textContent = title || "Confirm action";
  renderHtml(bodyEl, body || "");
  renderHtml(actionEl, `<i class="ti ti-check"></i> ${sanitize(confirmText)}`);
  if (iconEl) iconEl.className = `ti ${icon}`;
  modal.classList.remove("is-hidden");
  modal.style.display = "flex";
}

function closeConfirmModal(event) {
  const modal = document.getElementById("confirmModal");
  if (event && event.target !== modal) return;
  if (modal) {
    modal.style.display = "none";
    modal.classList.add("is-hidden");
  }
  pendingConfirmAction = null;
}

function confirmModalAccept() {
  const action = pendingConfirmAction;
  const modal = document.getElementById("confirmModal");
  if (modal) {
    modal.style.display = "none";
    modal.classList.add("is-hidden");
  }
  pendingConfirmAction = null;
  if (action) action();
}
function recordAudit(action, details = "") {
  const branchId = getCurrentBranchId();
  const entry = {
    id: makeClientId("AUD"),
    timestamp: new Date().toISOString(),
    user: currentUser?.username || "system",
    branch_id: branchId,
    branch: getBranchNameById(branchId),
    action,
    details
  };
  auditLog.unshift(entry);
  if (auditLog.length > 200) auditLog.splice(200);
  saveToStorage(STORAGE_KEYS.auditLog, auditLog);
  syncServerAction("/audit-log", entry, { branch: branchId }).catch(error => console.warn(error));
}

function resetInactivityTimer() {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  if (!currentUser) return;
  inactivityTimer = setTimeout(() => {
    if (currentUser) {
      showToast("Logged out due to inactivity", 2500, "warning");
      logout();
    }
  }, getInactivityLimitMs());
}

function clearInactivityTimer() {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = null;
}

function showLogin() {
  loadRecentUserLogins();
  const versionEl = document.getElementById("loginVersion");
  if (versionEl) versionEl.textContent = APP_VERSION_LABEL;
  document.getElementById("view-login").classList.add("active");
  document.querySelector(".app").style.display = "none";
}

function hideLogin() {
  document.getElementById("view-login").classList.remove("active");
  document.querySelector(".app").style.display = "block";
}

function closeNavMenus() {
  document.querySelectorAll(".nav-menu").forEach(menu => {
    menu.classList.remove("open");
    menu.querySelector(".nav-btn")?.setAttribute("aria-expanded", "false");
  });
  document.body.classList.remove("nav-modal-open");
}

function updateManagerAccess() {
  // Sidebar group visibility — hide entire groups the current role cannot access
  const groupInventory = document.getElementById("sidebar-group-inventory");
  const groupPurchases = document.getElementById("sidebar-group-purchases");
  const groupReports = document.getElementById("sidebar-group-reports");
  const groupSettings = document.getElementById("sidebar-group-settings");
  const groupSync = document.getElementById("sidebar-group-sync");
  const navReturns = document.getElementById("nav-returns");
  const navReference = document.getElementById("nav-reference");
  const expiryBtn = document.getElementById("nav-expiry");
  const discountInput = document.getElementById("discountPct");

  if (groupInventory) groupInventory.style.display = hasPermission("viewInventory") ? "" : "none";
  if (groupPurchases) groupPurchases.style.display = hasPermission("viewPurchases") ? "" : "none";
  if (groupReports) groupReports.style.display = hasPermission("viewReportsMenu") ? "" : "none";
  if (groupSettings) groupSettings.style.display = hasPermission("managerAccess") ? "" : "none";
  if (groupSync) groupSync.style.display = hasPermission("managerAccess") ? "" : "none";
  if (navReturns) navReturns.style.display = hasPermission("processReturns") ? "flex" : "none";
  if (navReference) navReference.style.display = hasPermission("viewReference") ? "flex" : "none";
  if (expiryBtn) expiryBtn.style.display = hasPermission("viewExpiry") ? "flex" : "none";
  if (discountInput) {
    const allowed = hasPermission("overridePrice");
    discountInput.disabled = !allowed;
    discountInput.title = allowed ? "" : "Discounts require pharmacist or manager access";
    if (!allowed) discountInput.value = "0";
  }

  // Apply cashier mode — full-width POS with no sidebar
  const role = String(currentUser?.role || "").toLowerCase();
  document.querySelector(".app-shell")?.classList.toggle("cashier-mode", !!currentUser && role === "cashier");
}

function loadRecentUserLogins() {
  recentUsernames = loadFromStorage(LOGIN_SUGGESTIONS_KEY, []);
  const list = document.getElementById("userList");
  if (!list) return;
  renderHtml(list, [...new Set(recentUsernames)].map(user => `<option value="${sanitize(user)}"></option>`).join(""));
  if (!document.getElementById("loginUser").value && recentUsernames.length) {
    document.getElementById("loginUser").value = recentUsernames[0];
  }
}

function saveRecentUsername(username) {
  if (!username) return;
  const cleaned = username.trim();
  if (!cleaned) return;
  recentUsernames = [cleaned, ...recentUsernames.filter(u => u !== cleaned)].slice(0, 5);
  saveToStorage(LOGIN_SUGGESTIONS_KEY, recentUsernames);
  loadRecentUserLogins();
}

function setHistoryFilter(range) {
  historyFilterType = range;
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);
  if (range === 'today') {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (range === 'week') {
    const day = now.getDay();
    const diff = (day + 6) % 7;
    start.setDate(now.getDate() - diff);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (range === 'month') {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    end.setMonth(end.getMonth() + 1);
    end.setDate(0);
    end.setHours(23, 59, 59, 999);
  } else if (range === 'all') {
    historyStartDate = null;
    historyEndDate = null;
    const startInput = document.getElementById('historyStart');
    const endInput = document.getElementById('historyEnd');
    if (startInput) startInput.value = '';
    if (endInput) endInput.value = '';
    renderHistory();
    return;
  }
  historyStartDate = start;
  historyEndDate = end;
  const startInput = document.getElementById('historyStart');
  const endInput = document.getElementById('historyEnd');
  if (startInput) startInput.value = start.toISOString().slice(0, 10);
  if (endInput) endInput.value = end.toISOString().slice(0, 10);
  renderHistory();
}

function updateHistoryDates() {
  historyFilterType = 'custom';
  const startVal = document.getElementById('historyStart').value;
  const endVal = document.getElementById('historyEnd').value;
  historyStartDate = startVal ? new Date(`${startVal}T00:00:00`) : null;
  historyEndDate = endVal ? new Date(`${endVal}T23:59:59.999`) : null;
  renderHistory();
}

function getFilteredHistorySales() {
  return getRecordsForBranch(salesHistory, getCurrentBranchId()).filter(sale => {
    if (!historyStartDate || !historyEndDate) return true;
    const saleDate = new Date(sale.date);
    return saleDate >= historyStartDate && saleDate <= historyEndDate;
  });
}

function getHistoryTotals(filtered) {
  return filtered.reduce((acc, sale) => {
    const isRefund = !!sale.refundAgainst || (Number(sale.total) || 0) < 0;
    acc.revenue += Number(sale.total) || 0;
    acc.profit += Number(sale.profit) || 0;
    if (isRefund) acc.returns += 1;
    else acc.transactions += 1;
    return acc;
  }, { revenue: 0, profit: 0, transactions: 0, returns: 0 });
}

function formatDateLabel() {
  if (historyFilterType === 'today') return 'Today';
  if (historyFilterType === 'week') return 'This week';
  if (historyFilterType === 'month') return 'This month';
  if (historyFilterType === 'custom' && historyStartDate && historyEndDate) {
    return `${historyStartDate.toLocaleDateString('en-GH')} - ${historyEndDate.toLocaleDateString('en-GH')}`;
  }
  return 'All history';
}

function toDateInputValue(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getSummaryPresetRange(range, now = new Date()) {
  const start = new Date(now);
  const end = new Date(now);
  if (range === "today") {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }
  if (range === "yesterday") {
    start.setDate(now.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    end.setDate(now.getDate() - 1);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }
  if (range === "week") {
    const day = now.getDay();
    const diff = (day + 6) % 7;
    start.setDate(now.getDate() - diff);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }
  if (range === "month") {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }
  return { start: null, end: null };
}

function updateSummaryFilterButtons() {
  ["today", "yesterday", "week", "month", "all"].forEach(range => {
    document.getElementById(`summaryFilter-${range}`)?.classList.toggle("active", summaryFilterType === range);
  });
}

function updateSummaryRangeInputs() {
  const startInput = document.getElementById("summaryStart");
  const endInput = document.getElementById("summaryEnd");
  if (startInput) startInput.value = summaryStartDate ? toDateInputValue(summaryStartDate) : "";
  if (endInput) endInput.value = summaryEndDate ? toDateInputValue(summaryEndDate) : "";
}

function setSummaryFilter(range) {
  const allowed = ["today", "yesterday", "week", "month", "all"];
  summaryFilterType = allowed.includes(range) ? range : "today";
  const preset = getSummaryPresetRange(summaryFilterType);
  summaryStartDate = preset.start;
  summaryEndDate = preset.end;
  updateSummaryRangeInputs();
  updateSummaryFilterButtons();
  updateSummary();
}

function updateSummaryDates() {
  summaryFilterType = "custom";
  const startVal = document.getElementById("summaryStart")?.value;
  const endVal = document.getElementById("summaryEnd")?.value;
  summaryStartDate = startVal ? new Date(`${startVal}T00:00:00`) : null;
  summaryEndDate = endVal ? new Date(`${endVal}T23:59:59.999`) : null;
  if (summaryStartDate && summaryEndDate && summaryStartDate > summaryEndDate) {
    const previousStart = summaryStartDate;
    summaryStartDate = new Date(summaryEndDate);
    summaryStartDate.setHours(0, 0, 0, 0);
    summaryEndDate = new Date(previousStart);
    summaryEndDate.setHours(23, 59, 59, 999);
    updateSummaryRangeInputs();
  }
  updateSummaryFilterButtons();
  updateSummary();
}

function isSameCalendarDate(first, second) {
  return first && second &&
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate();
}

function formatSummaryPeriodLabel(range) {
  if (summaryFilterType === "today") return "Today";
  if (summaryFilterType === "yesterday") return "Yesterday";
  if (summaryFilterType === "week") return "This week";
  if (summaryFilterType === "month") return "This month";
  if (summaryFilterType === "all" || !range.start || !range.end) return "All history";
  if (isSameCalendarDate(range.start, range.end)) {
    return range.start.toLocaleDateString("en-GH", { dateStyle: "medium" });
  }
  return `${range.start.toLocaleDateString("en-GH", { dateStyle: "medium" })} - ${range.end.toLocaleDateString("en-GH", { dateStyle: "medium" })}`;
}

function getSummaryRange() {
  let start = summaryStartDate;
  let end = summaryEndDate;
  if ((!start || !end) && summaryFilterType !== "all") {
    const preset = getSummaryPresetRange(summaryFilterType);
    start = preset.start;
    end = preset.end;
  }
  if (start && end && start > end) [start, end] = [end, start];
  const range = { start, end };
  range.label = formatSummaryPeriodLabel(range);
  range.isSingleDay = !!(start && end && isSameCalendarDate(start, end));
  return range;
}

function saleFallsInSummaryRange(sale, range) {
  if (!range.start || !range.end) return true;
  const saleDate = new Date(sale.date);
  if (Number.isNaN(saleDate.getTime())) return false;
  return saleDate >= range.start && saleDate <= range.end;
}

function getDateKeysForSummaryRange(range) {
  if (!range.start || !range.end) {
    const keys = new Set(Object.keys(shiftHours || {}));
    if (shiftSession?.sessionStart) keys.add(new Date(shiftSession.sessionStart).toISOString().slice(0, 10));
    return [...keys].sort();
  }
  const keys = [];
  const cursor = new Date(range.start);
  cursor.setHours(0, 0, 0, 0);
  const last = new Date(range.end);
  last.setHours(0, 0, 0, 0);
  while (cursor <= last) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

function getLiveShiftHoursForSummaryRange(range) {
  return getDateKeysForSummaryRange(range).reduce((totals, dateKey) => {
    const records = getLiveShiftHoursForDate(dateKey);
    Object.entries(records).forEach(([username, seconds]) => {
      totals[username] = (totals[username] || 0) + seconds;
    });
    return totals;
  }, {});
}

function formatSummaryTrendDate(dateKey) {
  return new Date(`${dateKey}T00:00:00`).toLocaleDateString("en-GH", { month: "short", day: "numeric" });
}

function buildSummaryRevenueTrend(sales, range) {
  if (range.isSingleDay) {
    const values = Array(SUMMARY_SLOT_COUNT).fill(0);
    sales.forEach(sale => {
      const hourIndex = getSummaryTimeSlotIndex(sale.date);
      if (hourIndex >= 0) values[hourIndex] += Number(sale.total) || 0;
    });
    return {
      labels: SUMMARY_HOURLY_LABELS,
      values,
      title: "Hourly revenue (GHS)",
      subtitle: "Sales grouped from 7:30am to 10:00pm"
    };
  }

  const totalsByDay = new Map();
  sales.forEach(sale => {
    const saleDate = new Date(sale.date);
    if (Number.isNaN(saleDate.getTime())) return;
    const key = saleDate.toISOString().slice(0, 10);
    totalsByDay.set(key, (totalsByDay.get(key) || 0) + (Number(sale.total) || 0));
  });

  let keys = [];
  if (range.start && range.end) {
    const rangeKeys = getDateKeysForSummaryRange(range);
    keys = rangeKeys.length <= 62 ? rangeKeys : [...totalsByDay.keys()].sort();
  } else {
    keys = [...totalsByDay.keys()].sort();
  }

  return {
    labels: keys.map(formatSummaryTrendDate),
    values: keys.map(key => totalsByDay.get(key) || 0),
    title: "Daily revenue trend (GHS)",
    subtitle: `Sales trend for ${range.label}`
  };
}

function updateUserDisplay() {
  const branchSelect = document.getElementById("branchSelect");
  if (branchSelect) branchSelect.disabled = !currentUser || !canSwitchBranch(currentUser);
  const branchTrigger = document.getElementById("branchSwitchTrigger");
  if (branchTrigger) {
    const disabled = !currentUser || !canSwitchBranch(currentUser);
    branchTrigger.disabled = disabled;
    branchTrigger.classList.toggle("is-disabled", disabled);
    branchTrigger.title = disabled ? "You can only access your assigned pharmacy" : "Switch branch";
  }
  renderBranchDropdown();
  updateManagerAccess();
  updateStatusChip();
}

async function authenticateLocalUser(username, password) {
  const normalizedUsername = String(username || "").trim().toLowerCase();
  const user = userProfiles.find(u => String(u.username || "").toLowerCase() === normalizedUsername);
  if (!user || !await verifyOfflineCredential(password, user.offlineCredential)) return null;
  return normalizeUserBranch(user);
}

async function rememberOfflineLogin(serverUser, password) {
  const username = String(serverUser?.username || "").trim().toLowerCase();
  if (!username) return;
  const existingIndex = userProfiles.findIndex(user => String(user.username || "").toLowerCase() === username);
  const existing = existingIndex >= 0 ? userProfiles[existingIndex] : {};
  let offlineCredential = existing.offlineCredential || null;
  try {
    offlineCredential = await createOfflineCredential(password);
  } catch (error) {
    console.warn("Could not cache an offline login credential", error);
  }
  const profile = sanitizeLocalUser({
    ...existing,
    ...serverUser,
    username,
    ...(offlineCredential ? { offlineCredential } : {})
  });
  if (existingIndex >= 0) userProfiles[existingIndex] = profile;
  else userProfiles.push(profile);
  saveUserProfiles();
}

async function authenticateUser(username, password) {
  if (!username || !password) return null;
  if (hasApiServer()) {
    try {
      const loginResult = await apiPost("/auth/login", { username, password, pharmacy_id: PHARMACY_ID }, { branch: null });
      const serverUser = loginResult?.user;
      if (!serverUser || !loginResult?.token) throw new Error("Login response did not include a secure session");
      setSessionToken(loginResult.token);
      applyRolePermissions(loginResult.rolePermissions);
      if (serverUser) await rememberOfflineLogin(serverUser, password);
      return serverUser ? normalizeUserBranch(serverUser) : null;
    } catch (error) {
      if (error.status === 401) return null;
      if (error.status && error.status < 500) throw error;
      setSessionToken("");
      const localUser = await authenticateLocalUser(username, password);
      if (localUser) {
        localUser.syncWarning = true;
        console.warn("Server login unavailable; signed in with local account", error);
        return localUser;
      }
      throw error;
    }
  }
  return authenticateLocalUser(username, password);
}

async function login() {
  const username = document.getElementById("loginUser").value.trim();
  const passwordInput = document.getElementById("loginPass");
  const password = passwordInput.value;
  clearLoginError();
  if (!username || !password) {
    setLoginError("Enter both username and password.");
    return showToast("Enter username and password", 2500, "error");
  }
  passwordInput.value = "";
  let user = null;
  try {
    user = await authenticateUser(username, password);
  } catch (error) {
    console.warn(error);
    const detail = error.status ? ` (${error.status})` : "";
    setLoginError(`Server login unavailable${detail}. Please check the sync server or try again.`);
    return showToast(`Server login unavailable${detail}`, 3500, "error");
  }
  if (!user) {
    setLoginError("Invalid username or password. Please check your login details.");
    passwordInput.focus();
    return showToast("Invalid username or password", 3500, "error");
  }
  clearLoginError();
  currentUser = user;
  try {
    await prepareBackupEncryption(password, currentUser.username);
    await migrateStoredBackupsToEncryption();
  } catch (error) {
    console.warn("Encrypted backup key could not be prepared", error);
  }
  if (!canSwitchBranch(currentUser)) {
    branchIndex = branches.indexOf(currentUser.branch);
    if (branchIndex < 0) branchIndex = 0;
  } else if (!userCanAccessBranch(getCurrentBranchId(), currentUser)) {
    branchIndex = branches.indexOf(getBranchNameById(getDefaultBranchIdForUser(currentUser)));
    if (branchIndex < 0) branchIndex = 0;
  }
  setRecordBranch(currentUser, getCurrentBranchId());
  saveRecentUsername(username);
  localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(currentUser));
  saveToStorage(STORAGE_KEYS.branch, branchIndex);
  initBranchSelect();
  updateBranchStocksToCurrent();
  setShiftSessionForNow();
  updateUserDisplay();
  hideLogin();
  if (!currentUser.syncWarning) {
    await refreshServerData({ silent: true });
    startLiveSync();
  } else {
    stopLiveSync();
  }
  if (currentUser.syncWarning) {
    showToast("Signed in locally; server sync unavailable", 3500, "warning");
    delete currentUser.syncWarning;
    saveToStorage(STORAGE_KEYS.user, currentUser);
  } else {
    showToast(`Welcome ${currentUser.name}`);
  }
  recordAudit("login", `User logged in from branch ${getCurrentBranchName()}`);
  resetInactivityTimer();
  startShiftTimer();
  checkExpiryOnLogin();
  checkBackupReminder();
  showView(String(currentUser.role || "").toLowerCase() === "cashier" ? "pos" : "dashboard");
}

async function logout() {
  if (shiftSession && shiftSession.sessionStart) {
    const elapsed = Math.floor((new Date() - new Date(shiftSession.sessionStart)) / 1000);
    if (elapsed > 0) addShiftHours(elapsed);
  }
  if (currentUser) {
    recordAudit("logout", `User logged out from branch ${getCurrentBranchName()}`);
  }
  if (hasApiServer() && getSessionToken()) {
    try {
      await apiPost("/auth/logout", {}, { branch: null });
    } catch (error) {
      console.warn("Server logout failed", error);
    }
  }
  currentUser = null;
  backupEncryptionKey = null;
  backupEncryptionUsername = "";
  setSessionToken("");
  localStorage.removeItem(STORAGE_KEYS.user);
  stopLiveSync();
  clearShiftSession();
  if (shiftTimer) clearInterval(shiftTimer);
  clearInactivityTimer();
  updateUserDisplay();
  const expiryBanner = document.getElementById("expiryBanner");
  if (expiryBanner) expiryBanner.style.display = "none";
  showLogin();
}

function forceShiftLogout(reason) {
  if (shiftSession && shiftSession.sessionStart) {
    const elapsed = Math.floor((new Date() - new Date(shiftSession.sessionStart)) / 1000);
    if (elapsed > 0) addShiftHours(elapsed);
  }
  currentUser = null;
  backupEncryptionKey = null;
  backupEncryptionUsername = "";
  setSessionToken("");
  localStorage.removeItem(STORAGE_KEYS.user);
  stopLiveSync();
  clearShiftSession();
  backupEncryptionKey = null;
  backupEncryptionUsername = "";
  updateUserDisplay();
  showLogin();
  showToast(reason || "Shift ended");
  if (shiftTimer) clearInterval(shiftTimer);
}

function handleAppClose() {
  if (shiftSession && shiftSession.sessionStart && currentUser?.username) {
    const elapsed = Math.floor((new Date() - new Date(shiftSession.sessionStart)) / 1000);
    if (elapsed > 0) addShiftHours(elapsed);
  }
  clearShiftSession();
  setSessionToken("");
  localStorage.removeItem(STORAGE_KEYS.user);
}

function parseShiftTime(time, date) {
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes, 0, 0);
}

function getShiftWindow(shift, date) {
  let start = parseShiftTime(shift.start, date);
  let end = parseShiftTime(shift.end, date);
  if (end <= start) end = new Date(end.getTime() + 86400000);
  if (end > start && date < start && shift.end <= shift.start) {
    start = new Date(start.getTime() - 86400000);
    end = new Date(end.getTime() - 86400000);
  }
  return { shift, start, end };
}

function getActiveShiftWindow(date = new Date()) {
  return getShiftSchedule()
    .map(shift => getShiftWindow(shift, date))
    .find(window => date >= window.start && date < window.end) || null;
}

function getActiveShift(date) {
  return getActiveShiftWindow(date)?.shift || null;
}

function getNextShift(date) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  const sorted = [...getShiftSchedule()].sort((a, b) => {
    const [ah, am] = a.start.split(":").map(Number);
    const [bh, bm] = b.start.split(":").map(Number);
    return ah * 60 + am - (bh * 60 + bm);
  });
  for (const shift of sorted) {
    const [sh, sm] = shift.start.split(":").map(Number);
    if (minutes < sh * 60 + sm) return shift;
  }
  return sorted[0];
}

function formatDuration(seconds) {
  const hrs = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const mins = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const secs = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${hrs}:${mins}:${secs}`;
}

function saveShiftSession() {
  if (shiftSession) saveToStorage(STORAGE_KEYS.shiftSession, shiftSession);
  else localStorage.removeItem(STORAGE_KEYS.shiftSession);
}

function addShiftHours(seconds) {
  if (!currentUser || !currentUser.username) return;
  const today = new Date().toISOString().slice(0, 10);
  shiftHours[today] = shiftHours[today] || {};
  shiftHours[today][currentUser.username] = (shiftHours[today][currentUser.username] || 0) + seconds;
  saveToStorage(STORAGE_KEYS.shiftHours, shiftHours);
}

function clearShiftSession() {
  shiftSession = null;
  localStorage.removeItem(STORAGE_KEYS.shiftSession);
}

function setShiftSessionForNow() {
  const now = new Date();
  const activeShift = getActiveShift(now);
  shiftSession = {
    username: currentUser?.username || "",
    sessionStart: now.toISOString(),
    shiftName: activeShift ? activeShift.name : "Off shift",
    shiftStart: activeShift ? activeShift.start : null,
    shiftEnd: activeShift ? activeShift.end : null
  };
  saveShiftSession();
}

function updateShiftTimer() {
  const status = document.getElementById("statusChipText");
  if (!currentUser) {
    updateStatusChip();
    return;
  }
  const now = new Date();
  const activeShift = getActiveShift(now);
  if (!shiftSession) setShiftSessionForNow();
  const sessionStart = shiftSession?.sessionStart ? new Date(shiftSession.sessionStart) : now;
  const elapsedSeconds = Math.max(0, Math.floor((now - sessionStart) / 1000));
  let newText = "";
  if (activeShift) {
    const endTime = parseShiftTime(activeShift.end, now);
    const remainingSeconds = Math.floor((endTime - now) / 1000);
    newText = `${currentUser.name} - ${activeShift.name} - ${formatDuration(elapsedSeconds)} - ${now.toLocaleTimeString("en-GH", { hour: "2-digit", minute: "2-digit" })}`;
    if (remainingSeconds <= 0) {
      forceShiftLogout("Shift ended - signing out");
      return;
    }
  } else {
    const nextShift = getNextShift(now);
    newText = `${currentUser.name} - Off shift - next ${nextShift.name} ${nextShift.start} - ${now.toLocaleTimeString("en-GH", { hour: "2-digit", minute: "2-digit" })}`;
  }
  // Only touch the DOM when the displayed text actually changes
  if (status && status.textContent !== newText) status.textContent = newText;
}

function startShiftTimer() {
  if (shiftTimer) clearInterval(shiftTimer);
  updateShiftTimer();
  shiftTimer = setInterval(updateShiftTimer, 1000);
}

function getBranchStock(drug) {
  const branch = getCurrentBranchName();
  if (drug.branchStock && drug.branchStock[branch] != null) return drug.branchStock[branch];
  return Number(drug.stock ?? 0) || 0;
}

function updateBranchStock(drug, change) {
  drug.branchStock = drug.branchStock || {};
  const branch = getCurrentBranchName();
  const current = drug.branchStock[branch] ?? drug.stock ?? 0;
  drug.branchStock[branch] = Math.max(0, Number(current || 0) + change);
  drug.stock = drug.branchStock[branch];
  drug.branch_id = getCurrentBranchId();
  drug.branch = branch;
}

function updateDrugStockForBranch(drug, branchId, change) {
  drug.branchStock = drug.branchStock || {};
  const branch = getBranchNameById(branchId);
  const current = drug.branchStock[branch] ?? (branchId === getCurrentBranchId() ? drug.stock : 0) ?? 0;
  drug.branchStock[branch] = Math.max(0, Number(current || 0) + change);
  if (branchId === getCurrentBranchId()) drug.stock = drug.branchStock[branch];
  drug.branch_id = branchId;
  drug.branch = branch;
}

function updateBranchStocksToCurrent() {
  drugs.forEach(drug => drug.stock = getBranchStock(drug));
}

function ensureDrugBranchStock() {
  drugs.forEach(drug => {
    drug.branchStock = drug.branchStock || {};
    ensureDrugBranchAvailability(drug);
    branches.forEach(branch => {
      if (drug.branchStock[branch] == null) {
        drug.branchStock[branch] = branch === getCurrentBranchName() ? Number(drug.stock ?? 0) || 0 : 0;
      }
    });
    normalizeDrugBatches(drug);
  });
}

function normalizeBatchIdPart(value) {
  return String(value || "none").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "none";
}

function makeBatchRecordId(drugId, batch, expiry, branchId, invoice = "") {
  return `BATCH-${drugId}-${normalizeBatchIdPart(branchId)}-${normalizeBatchIdPart(batch)}-${normalizeBatchIdPart(expiry)}-${normalizeBatchIdPart(invoice)}`;
}

function normalizeDrugBatches(drug) {
  if (!drug) return [];
  const normalized = [];
  const rawBatches = Array.isArray(drug.batches) ? drug.batches : [];
  rawBatches.forEach((batch, index) => {
    if (!batch || typeof batch !== "object") return;
    const branchId = batch.branch_id || batch.branchId || getBranchIdByName(batch.branch) || drug.branch_id || getCurrentBranchId();
    const branch = getBranchNameById(branchId);
    const batchNo = String(batch.batch || batch.batchNo || batch.lot || "").trim();
    const expiry = batch.expiry || batch.expiryDate || "";
    const qty = Math.max(0, parseInt(batch.qty ?? batch.stock ?? batch.quantity ?? 0, 10) || 0);
    const initialQty = Math.max(qty, parseInt(batch.initialQty ?? batch.initial_qty ?? qty, 10) || qty);
    const id = batch.id || makeBatchRecordId(drug.id || drug.drug_id || index, batchNo, expiry, branchId, batch.invoice || batch.grn || "");
    normalized.push({
      ...batch,
      id,
      batch: batchNo,
      batchNo,
      expiry,
      qty,
      initialQty,
      branch_id: branchId,
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
      const branchId = getBranchIdByName(branch);
      const qty = Number(drug.branchStock?.[branch] ?? (branch === getCurrentBranchName() ? drug.stock : 0) ?? 0) || 0;
      if (qty <= 0) return;
      const batchNo = drug.batch || "Legacy";
      const alreadyExists = normalized.some(batch => batch.branch_id === branchId && batch.expiry === drug.expiry && batch.batch === batchNo);
      if (alreadyExists) return;
      normalized.push({
        id: makeBatchRecordId(drug.id, batchNo, drug.expiry, branchId, "legacy"),
        batch: batchNo,
        batchNo,
        expiry: drug.expiry,
        qty,
        initialQty: qty,
        branch_id: branchId,
        branch,
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

function findDrugBatch(drug, batchId) {
  return normalizeDrugBatches(drug).find(batch => String(batch.id) === String(batchId));
}

function addDrugBatchStock(drug, details) {
  const branchId = details.branch_id || details.branchId || getCurrentBranchId();
  const branch = getBranchNameById(branchId);
  const batchNo = String(details.batch || details.batchNo || "").trim();
  const expiry = details.expiry || "";
  const invoice = details.invoice || "";
  const qty = Math.max(0, parseInt(details.qty, 10) || 0);
  if (!qty) return null;
  const batches = normalizeDrugBatches(drug);
  const existing = batches.find(batch =>
    batch.branch_id === branchId &&
    batch.batch === batchNo &&
    batch.expiry === expiry
  );
  if (existing) {
    existing.qty += qty;
    existing.initialQty = (Number(existing.initialQty) || 0) + qty;
    existing.cost = Number(details.cost ?? existing.cost ?? 0) || 0;
    existing.supplierId = details.supplierId || existing.supplierId || "";
    existing.supplier = details.supplier || existing.supplier || "";
    existing.invoice = invoice || existing.invoice || "";
    existing.receivedDate = details.receivedDate || existing.receivedDate || "";
    return existing;
  }
  const batch = {
    id: makeBatchRecordId(drug.id, batchNo, expiry, branchId, invoice || Date.now()),
    batch: batchNo,
    batchNo,
    expiry,
    qty,
    initialQty: qty,
    branch_id: branchId,
    branch,
    cost: Number(details.cost ?? 0) || 0,
    supplierId: details.supplierId || "",
    supplier: details.supplier || "",
    invoice,
    receivedDate: details.receivedDate || ""
  };
  batches.push(batch);
  return batch;
}

function deductDrugBatchStock(drug, branchId, qty) {
  let remaining = Math.max(0, parseInt(qty, 10) || 0);
  const allocations = [];
  const batches = normalizeDrugBatches(drug)
    .filter(batch => batch.branch_id === branchId && (Number(batch.qty) || 0) > 0)
    .sort((a, b) => {
      const expA = a.expiry ? new Date(a.expiry).getTime() : Number.MAX_SAFE_INTEGER;
      const expB = b.expiry ? new Date(b.expiry).getTime() : Number.MAX_SAFE_INTEGER;
      return expA - expB;
    });
  batches.forEach(batch => {
    if (remaining <= 0) return;
    const take = Math.min(Number(batch.qty) || 0, remaining);
    if (take <= 0) return;
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

function transferDrugBatchStock(drug, fromBranchId, toBranchId, qty) {
  const allocations = deductDrugBatchStock(drug, fromBranchId, qty);
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
    });
  });
  return allocations;
}

function restoreDrugBatchAllocations(drug, allocations = []) {
  if (!Array.isArray(allocations)) return;
  allocations.forEach(allocation => {
    const batch = findDrugBatch(drug, allocation.batchId || allocation.batch_id);
    if (!batch) return;
    batch.qty = Math.max(0, (Number(batch.qty) || 0) + (Number(allocation.qty) || 0));
  });
}

function restoreReturnedItemStock(drug, item, branchId, saleId) {
  const qty = Math.max(0, parseInt(item?.qty, 10) || 0);
  const allocations = Array.isArray(item?.batchAllocations || item?.batch_allocations)
    ? (item.batchAllocations || item.batch_allocations)
    : [];
  let remaining = qty;
  allocations.forEach(allocation => {
    if (remaining <= 0) return;
    const batch = findDrugBatch(drug, allocation.batchId || allocation.batch_id);
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
      branch_id: branchId,
      cost: Number(item?.cost ?? item?.costPrice ?? drug.costPrice ?? 0) || 0,
      invoice: `Return ${saleId}`,
      receivedDate: new Date().toISOString().slice(0, 10)
    });
  }
  const branchName = getBranchNameById(branchId);
  ensureDrugBranchAvailability(drug);
  drug.branchAvailability[branchName] = true;
  updateDrugStockForBranch(drug, branchId, qty);
}

function reduceDrugBatchQty(drug, batchId, qty) {
  const batch = findDrugBatch(drug, batchId);
  if (!batch) return false;
  const amount = Math.max(0, Number(qty) || 0);
  if (amount > (Number(batch.qty) || 0)) return false;
  batch.qty = Math.max(0, (Number(batch.qty) || 0) - amount);
  return true;
}

function rollbackAddedDrugBatchStock(drug, batchId, qty) {
  const batches = normalizeDrugBatches(drug);
  const index = batches.findIndex(batch => String(batch.id) === String(batchId));
  if (index < 0) return false;
  const batch = batches[index];
  const amount = Math.max(0, Number(qty) || 0);
  batch.qty = Math.max(0, (Number(batch.qty) || 0) - amount);
  batch.initialQty = Math.max(batch.qty, (Number(batch.initialQty) || 0) - amount);
  if (batch.qty === 0 && batch.initialQty === 0) batches.splice(index, 1);
  return true;
}

function getBatchExpiryRows(branchId = getCurrentBranchId()) {
  const rows = [];
  drugs.forEach(drug => {
    if (!isDrugAvailableAtBranch(drug, branchId)) return;
    normalizeDrugBatches(drug).forEach(batch => {
      if (branchId && batch.branch_id !== branchId) return;
      if (!batch.expiry || new Date(batch.expiry).getTime() <= 0) return;
      rows.push({
        drugId: drug.id,
        batchId: batch.id,
        name: drug.name,
        brand: drug.brand || "",
        form: drug.form || "",
        cat: drug.cat || "",
        route: drug.route || "",
        batch: batch.batch || "--",
        expiry: batch.expiry,
        stock: Number(batch.qty) || 0,
        price: Number(drug.price || 0),
        branch_id: batch.branch_id,
        branch: batch.branch,
        supplier: batch.supplier || "",
        invoice: batch.invoice || ""
      });
    });
  });
  return rows;
}

function renderDrugBatchTable(drug) {
  const wrapper = document.getElementById("drugBatchTable");
  if (!wrapper) return;
  const rows = normalizeDrugBatches(drug)
    .slice()
    .sort((a, b) => {
      const branchA = String(a.branch || "").localeCompare(String(b.branch || ""));
      if (branchA) return branchA;
      const expA = a.expiry ? new Date(a.expiry).getTime() : Number.MAX_SAFE_INTEGER;
      const expB = b.expiry ? new Date(b.expiry).getTime() : Number.MAX_SAFE_INTEGER;
      return expA - expB;
    });
  if (!rows.length) {
    renderHtml(wrapper, `<div class="drug-batch-empty">No batch records yet. Add opening stock here or receive stock through GRN.</div>`);
    return;
  }
  renderHtml(wrapper, `
    <div class="drug-batch-scroll">
      <table>
        <thead>
          <tr>
            <th>Batch no.</th>
            <th>Expiry date</th>
            <th>Quantity</th>
            <th>Branch</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(batch => `
            <tr>
              <td>${sanitize(batch.batch || "--")}</td>
              <td>${sanitize(batch.expiry || "--")}</td>
              <td>${Number(batch.qty || 0)}</td>
              <td>${sanitize(batch.branch || "--")}</td>
              <td>GHS ${Number(batch.cost || 0).toFixed(2)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `);
}

function initBranchSelect() {
  const select = document.getElementById("branchSelect");
  const selectable = getSelectableBranchRecords();
  if (select) {
    renderHtml(select, selectable.map(branch => `<option value="${sanitize(branch.name)}">${sanitize(branch.name)}</option>`).join(""));
    select.value = getCurrentBranchName();
  }
  renderBranchDropdown();
}

function renderBranchDropdown() {
  const label = document.getElementById("branchSwitchLabel");
  const menu = document.getElementById("branchDropdown");
  const trigger = document.getElementById("branchSwitchTrigger");
  const currentBranchName = getCurrentBranchName();
  const selectable = getSelectableBranchRecords();
  if (label) label.textContent = currentBranchName;
  if (trigger) trigger.setAttribute("aria-label", `Current branch: ${currentBranchName}`);
  if (!menu) return;
  renderHtml(menu, selectable.map(branch => {
    const active = branch.id === getCurrentBranchId();
    return `
      <button type="button" class="branch-option${active ? " active" : ""}" role="option" aria-selected="${active}" data-branch-name="${sanitize(branch.name)}">
        <span class="branch-option-icon"><i class="ti ti-building-store"></i></span>
        <span class="branch-option-copy">
          <strong>${sanitize(branch.name)}</strong>
          <small>${sanitize(getDashboardBranchCode(branch.id, branch.name))}</small>
        </span>
        ${active ? `<span class="branch-option-check"><i class="ti ti-check"></i></span>` : ""}
      </button>
    `;
  }).join(""));
  menu.querySelectorAll(".branch-option").forEach(button => {
    button.addEventListener("click", event => {
      event.stopPropagation();
      const branchName = button.dataset.branchName;
      closeBranchDropdown();
      setBranch(branchName);
    });
  });
}

function toggleBranchDropdown(event) {
  event?.stopPropagation();
  if (!currentUser) return;
  if (!canSwitchBranch(currentUser)) {
    showToast("You can only access your assigned pharmacy", 2500, "error");
    return;
  }
  const control = document.getElementById("branchSwitchControl");
  const trigger = document.getElementById("branchSwitchTrigger");
  const willOpen = !control?.classList.contains("open");
  document.querySelectorAll(".topbar-branch-control.open").forEach(item => item.classList.remove("open"));
  control?.classList.toggle("open", willOpen);
  trigger?.setAttribute("aria-expanded", String(!!willOpen));
  if (willOpen) renderBranchDropdown();
}

function closeBranchDropdown() {
  document.getElementById("branchSwitchControl")?.classList.remove("open");
  document.getElementById("branchSwitchTrigger")?.setAttribute("aria-expanded", "false");
}

async function setBranch(value) {
  const nextIndex = typeof value === "number" ? value : branches.indexOf(value);
  const safeIndex = nextIndex < 0 ? 0 : nextIndex;
  const nextBranchId = branchRecords[safeIndex]?.id || branchRecords[0].id;
  if (currentUser && !userCanAccessBranch(nextBranchId, currentUser)) {
    showToast("You can only access your assigned pharmacy", 2500, "error");
    if (document.getElementById("branchSelect")) document.getElementById("branchSelect").value = currentUser.branch;
    return;
  }
  branchIndex = safeIndex;
  if (currentUser) {
    setRecordBranch(currentUser, nextBranchId);
    saveToStorage(STORAGE_KEYS.user, currentUser);
  }
  saveToStorage(STORAGE_KEYS.branch, branchIndex);
  if (document.getElementById("branchSelect")) document.getElementById("branchSelect").value = getCurrentBranchName();
  renderBranchDropdown();
  if (cart.length) {
    cart = [];
    renderCart();
    showToast("Branch changed, cart cleared.", 2500, "warning");
  }
  await refreshServerData({ silent: true });
  updateBranchStocksToCurrent();
  renderCustomerOptions();
  renderCategories();
  filterDrugs();
  updateDashboard();
  if (document.getElementById("view-patients")?.classList.contains("active")) renderPatientProfiles();
  if (document.getElementById("view-history")?.classList.contains("active")) renderHistory();
  if (document.getElementById("view-returns")?.classList.contains("active")) renderReturnsView();
  if (document.getElementById("view-summary")?.classList.contains("active")) updateSummary();
  if (document.getElementById("view-purchases")?.classList.contains("active")) renderPurchaseView();
  if (document.getElementById("view-notifications")?.classList.contains("active")) renderNotifications();
  if (document.getElementById("view-settings")?.classList.contains("active")) renderSettingsView();
  if (document.getElementById("view-sync")?.classList.contains("active")) renderSyncBackupView();
}

async function initStore() {
  branchRecords = loadFromStorage(STORAGE_KEYS.branches, branchRecords).map(normalizeBranchRecordLocal);
  refreshBranchNames();
  userProfiles = await migrateLocalUserProfiles(loadFromStorage(STORAGE_KEYS.users, userProfiles));
  saveUserProfiles();
  drugs = loadFromStorage(STORAGE_KEYS.drugs, defaultDrugs);
  customers = loadFromStorage(STORAGE_KEYS.customers, defaultCustomers);
  referenceDrugs = dedupeReferenceDrugs(loadFromStorage(STORAGE_KEYS.referenceDrugs, referenceDrugs));
  normalizePatientProfiles();
  heldSales = loadFromStorage(STORAGE_KEYS.held, []);
  salesHistory = loadFromStorage(STORAGE_KEYS.sales, []);
  currentUser = loadFromStorage(STORAGE_KEYS.user, null);
  if (currentUser && hasApiServer() && !getSessionToken()) {
    currentUser = null;
    localStorage.removeItem(STORAGE_KEYS.user);
  }
  shiftSession = loadFromStorage(STORAGE_KEYS.shiftSession, null);
  shiftHours = loadFromStorage(STORAGE_KEYS.shiftHours, {});
  auditLog = loadFromStorage(STORAGE_KEYS.auditLog, []);
  suppliers = loadFromStorage(STORAGE_KEYS.suppliers, []);
  purchaseHistory = loadFromStorage(STORAGE_KEYS.purchases, []);
  draftPurchaseOrders = loadFromStorage(STORAGE_KEYS.draftPOs, []);
  stockAdjustments = loadFromStorage(STORAGE_KEYS.stockAdj, []);
  branchIndex = loadFromStorage(STORAGE_KEYS.branch, 0);
  if (branchIndex < 0 || branchIndex >= branches.length) branchIndex = 0;
  if (currentUser) {
    currentUser = normalizeUserBranch(currentUser);
    if (!canSwitchBranch(currentUser)) {
      branchIndex = branches.indexOf(currentUser.branch);
      if (branchIndex < 0) branchIndex = 0;
    } else if (!userCanAccessBranch(getCurrentBranchId(), currentUser)) {
      branchIndex = branches.indexOf(getBranchNameById(getDefaultBranchIdForUser(currentUser)));
      if (branchIndex < 0) branchIndex = 0;
    }
    setRecordBranch(currentUser, getCurrentBranchId());
    saveToStorage(STORAGE_KEYS.user, currentUser);
    saveToStorage(STORAGE_KEYS.branch, branchIndex);
  }
  normalizeDrugThresholds();
  ensureDrugBranchStock();
  initBranchSelect();
  updateBranchStocksToCurrent();
  renderCustomerOptions();
  renderCategories();
  loadRecentUserLogins();
}

// Targeted save functions (call only what changed)
function saveDrugs() { saveToStorage(STORAGE_KEYS.drugs, drugs); }
function saveCustomers() { saveToStorage(STORAGE_KEYS.customers, customers); }
function saveHeld() { saveToStorage(STORAGE_KEYS.held, heldSales); }
function saveSales() { saveToStorage(STORAGE_KEYS.sales, salesHistory); }
function saveSuppliers() { saveToStorage(STORAGE_KEYS.suppliers, suppliers); }
function savePurchases() { saveToStorage(STORAGE_KEYS.purchases, purchaseHistory); }
function saveDraftPOs() { saveToStorage(STORAGE_KEYS.draftPOs, draftPurchaseOrders); }
function saveStockAdj() { saveToStorage(STORAGE_KEYS.stockAdj, stockAdjustments); }
function saveReferenceDrugs() { saveToStorage(STORAGE_KEYS.referenceDrugs, referenceDrugs); }
