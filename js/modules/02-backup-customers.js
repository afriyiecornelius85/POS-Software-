
function getProtectedDataSnapshot(reason) {
  return {
    id: makeClientId("BKP"),
    createdAt: new Date().toISOString(),
    reason,
    user: currentUser ? { username: currentUser.username, name: currentUser.name, role: currentUser.role } : null,
    branch_id: getCurrentBranchId(),
    branch: getCurrentBranchName(),
    data: JSON.parse(JSON.stringify({ drugs, salesHistory, customers, heldSales }))
  };
}

async function deriveBackupEncryptionKey(password, username) {
  if (!globalThis.crypto?.subtle) throw new Error("Secure browser cryptography is unavailable");
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(password || "")),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey({
    name: "PBKDF2",
    hash: "SHA-256",
    salt: new TextEncoder().encode(`akopharm-backup-v1:${String(username || "").toLowerCase()}`),
    iterations: 310000
  }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function prepareBackupEncryption(password, username) {
  backupEncryptionKey = await deriveBackupEncryptionKey(password, username);
  backupEncryptionUsername = String(username || "").toLowerCase();
}

function isEncryptedBackupEnvelope(value) {
  return value?.format === "akopharm-encrypted-backup" && value?.algorithm === "AES-GCM" && value?.ciphertext && value?.iv;
}

async function encryptBackupPayload(payload) {
  if (!backupEncryptionKey || !backupEncryptionUsername) throw new Error("Sign in again before creating an encrypted backup");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, backupEncryptionKey, plaintext);
  return {
    format: "akopharm-encrypted-backup",
    version: 1,
    algorithm: "AES-GCM",
    username: backupEncryptionUsername,
    createdAt: new Date().toISOString(),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext))
  };
}

async function migrateStoredBackupsToEncryption() {
  for (const key of [STORAGE_KEYS.majorBackups, STORAGE_KEYS.autoBackups]) {
    const backups = loadFromStorage(key, []);
    if (!Array.isArray(backups) || backups.every(isEncryptedBackupEnvelope)) continue;
    const migrated = [];
    for (const backup of backups) migrated.push(isEncryptedBackupEnvelope(backup) ? backup : await encryptBackupPayload(backup));
    saveToStorage(key, migrated);
  }
}

async function decryptBackupPayload(envelope) {
  if (!isEncryptedBackupEnvelope(envelope)) return envelope;
  const owner = String(envelope.username || "").toLowerCase();
  let key = owner === backupEncryptionUsername ? backupEncryptionKey : null;
  const decryptWithKey = async candidateKey => {
    const plaintext = await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: base64ToBytes(envelope.iv)
    }, candidateKey, base64ToBytes(envelope.ciphertext));
    return JSON.parse(new TextDecoder().decode(plaintext));
  };
  if (key) {
    try {
      return await decryptWithKey(key);
    } catch (_) {
      key = null;
    }
  }
  if (!key) {
    const password = window.prompt(`Enter the password for ${owner || "the backup owner"} to decrypt this backup:`);
    if (!password) throw new Error("Backup decryption was cancelled");
    key = await deriveBackupEncryptionKey(password, owner);
  }
  return decryptWithKey(key);
}

async function saveMajorChangeBackup(reason) {
  const snapshot = getProtectedDataSnapshot(reason);
  try {
    const encryptedSnapshot = await encryptBackupPayload(snapshot);
    const backups = loadFromStorage(STORAGE_KEYS.majorBackups, []);
    backups.unshift(encryptedSnapshot);
    if (backups.length > MAX_LOCAL_MAJOR_BACKUPS) backups.splice(MAX_LOCAL_MAJOR_BACKUPS);
    saveToStorage(STORAGE_KEYS.majorBackups, backups);
    return encryptedSnapshot;
  } catch (error) {
    console.error(error);
    showToast("Safety backup failed; change cancelled", 3500, "error");
    return null;
  }
}

function buildFullBackupPayload() {
  return {
    app: "Akopharmah POS",
    exportedAt: new Date().toISOString(),
    exportedBy: currentUser ? { username: currentUser.username, name: currentUser.name, role: currentUser.role } : null,
    branch_id: getCurrentBranchId(),
    branch: getCurrentBranchName(),
    data: {
      drugs,
      customers,
      salesHistory,
      heldSales,
      shiftHours,
      auditLog,
      suppliers,
      purchaseHistory,
      draftPurchaseOrders,
      stockAdjustments,
      referenceDrugs,
      branchRecords,
      appSettings: getAppSettings()
    }
  };
}

function backupDateStamp(date = new Date()) {
  return date.toISOString().slice(0, 19).replace(/[T:]/g, "-");
}

async function exportFullBackup() {
  if (!requirePermission("exportBackup", "Manager access required for full backup")) return;
  const payload = buildFullBackupPayload();
  let encryptedPayload;
  try {
    encryptedPayload = await encryptBackupPayload(payload);
  } catch (error) {
    console.warn(error);
    return showToast(error.message || "Encrypted backup could not be created", 3500, "error");
  }
  downloadJson(`akopharm-full-backup-${backupDateStamp()}.encrypted.json`, encryptedPayload);
  saveToStorage(STORAGE_KEYS.lastFullBackup, payload.exportedAt);
  recordAudit("backup-export", "Exported full localStorage backup");
  updateNotificationBadge();
  if (document.getElementById("view-sync")?.classList.contains("active")) renderSyncBackupView();
  showToast("Full backup exported");
}

function checkBackupReminder() {
  if (!currentUser || !hasPermission("exportBackup")) return;
  const lastBackupAt = loadFromStorage(STORAGE_KEYS.lastFullBackup, null);
  const lastTime = lastBackupAt ? new Date(lastBackupAt).getTime() : 0;
  const reminderDays = getBackupReminderDays();
  const stale = !lastTime || (Date.now() - lastTime) >= reminderDays * 86400000;
  if (stale) {
    updateNotificationBadge();
    if (document.getElementById("view-notifications")?.classList.contains("active")) renderNotifications();
  }
}

// Full persist kept for import/reset operations that touch everything at once
function persistAll() {
  saveDrugs();
  saveCustomers();
  saveHeld();
  saveSales();
  saveToStorage(STORAGE_KEYS.user, currentUser);
  saveToStorage(STORAGE_KEYS.branch, branchIndex);
  saveToStorage(STORAGE_KEYS.shiftSession, shiftSession);
  saveToStorage(STORAGE_KEYS.shiftHours, shiftHours);
  saveToStorage(STORAGE_KEYS.auditLog, auditLog);
  saveUserProfiles();
  saveBranchRecords();
  saveSuppliers();
  savePurchases();
  saveDraftPOs();
  saveStockAdj();
  saveReferenceDrugs();
}

// XSS sanitization helper
// Escapes untrusted strings before injecting them into innerHTML.
function sanitize(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizePatientProfile(customer) {
  if (!customer) return customer;
  const branchId = normalizeBranchId(customer.branch_id || customer.branchId || customer.branch) || getCurrentBranchId();
  customer.branch_id = branchId;
  customer.branchId = branchId;
  customer.branch = getBranchNameById(branchId);
  customer.dateOfBirth = customer.dateOfBirth || customer.dob || "";
  customer.dob = customer.dateOfBirth;
  customer.phone = customer.phone || "";
  customer.notes = customer.notes || "";
  customer.balance = Number(customer.balance || 0);
  customer.allergies = customer.allergies || "";
  customer.conditions = customer.conditions || "";
  customer.currentMedications = customer.currentMedications || "";
  customer.medicalNotes = customer.medicalNotes || customer.notes || "";
  customer.medicalRecords = Array.isArray(customer.medicalRecords) ? customer.medicalRecords : [];
  customer.lastVisit = customer.lastVisit || "";
  return customer;
}

function normalizePatientProfiles() {
  customers = customers.map(normalizePatientProfile);
  const firstPatient = getPatientsForCurrentBranch()[0] || customers[0];
  if (!selectedPatientId && firstPatient) selectedPatientId = firstPatient.id;
}

function isWalkInCustomer(customer) {
  return String(customer?.name || "").trim().toLowerCase() === "walk-in";
}

function getPatientsForCurrentBranch(branchId = getCurrentBranchId()) {
  return customers.filter(customer => {
    if (isWalkInCustomer(customer)) return false;
    const customerBranchId = normalizeBranchId(customer.branch_id || customer.branchId || customer.branch) || branchId;
    return customerBranchId === branchId;
  });
}

function getCustomersForCurrentSale() {
  const walkIn = customers.find(isWalkInCustomer) || { id: 1, name: "Walk-in", phone: "", notes: "", balance: 0 };
  return [walkIn, ...getPatientsForCurrentBranch()];
}

function calculateAgeLabel(dateOfBirth) {
  if (!dateOfBirth) return "--";
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return "--";
  const today = new Date();
  let years = today.getFullYear() - dob.getFullYear();
  const monthDelta = today.getMonth() - dob.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < dob.getDate())) years -= 1;
  if (years >= 2) return `${years} yrs`;
  const months = Math.max(0, (today.getFullYear() - dob.getFullYear()) * 12 + today.getMonth() - dob.getMonth());
  return `${months} mo`;
}

function estimateNextRefillDate(sales) {
  const latestSale = (sales || []).find(sale => !sale.refundAgainst && (Number(sale.total) || 0) >= 0);
  if (!latestSale) return "";
  const daysSupply = Number(latestSale.daysSupply ?? latestSale.refillDays);
  if (!Number.isFinite(daysSupply) || daysSupply <= 0) return "";
  const due = new Date(latestSale.date);
  if (Number.isNaN(due.getTime())) return "";
  due.setDate(due.getDate() + Math.round(daysSupply));
  return due.toISOString();
}

const REFILL_ALERT_LOOKAHEAD_DAYS = 3;

function getPatientRefillAlerts(branchId = getCurrentBranchId(), lookaheadDays = REFILL_ALERT_LOOKAHEAD_DAYS) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const alertUntil = new Date(today);
  alertUntil.setDate(alertUntil.getDate() + Math.max(0, Number(lookaheadDays) || 0));
  return getPatientsForCurrentBranch(branchId)
    .map(patient => {
      const summary = getPatientSummary(patient);
      if (!summary.nextRefill) return null;
      const due = new Date(summary.nextRefill);
      if (Number.isNaN(due.getTime())) return null;
      const dueDay = new Date(due);
      dueDay.setHours(0, 0, 0, 0);
      if (dueDay > alertUntil) return null;
      const daysUntil = Math.round((dueDay - today) / 86400000);
      return {
        patientId: patient.id,
        name: patient.name || "Patient",
        phone: patient.phone || "",
        branch: patient.branch || getBranchNameById(branchId),
        dueDate: due.toISOString(),
        daysUntil,
        overdue: daysUntil < 0,
        lastVisit: summary.lastVisit,
        purchaseCount: summary.count
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.daysUntil - b.daysUntil || String(a.name).localeCompare(String(b.name)));
}

function formatRefillAlertMessage(alerts) {
  if (!alerts.length) return "No patient refills are due in the next few days";
  const preview = alerts.slice(0, 2).map(alert => {
    const timing = alert.daysUntil < 0
      ? `${Math.abs(alert.daysUntil)} day${Math.abs(alert.daysUntil) === 1 ? "" : "s"} overdue`
      : alert.daysUntil === 0
        ? "due today"
        : `due in ${alert.daysUntil} day${alert.daysUntil === 1 ? "" : "s"}`;
    return `${alert.name} ${timing}`;
  }).join("; ");
  const more = alerts.length > 2 ? ` +${alerts.length - 2} more` : "";
  return `${preview}${more}`;
}

function openPatientRefillAlerts() {
  const branchId = typeof getDashboardBranchId === "function" ? getDashboardBranchId() : getCurrentBranchId();
  const alerts = getPatientRefillAlerts(branchId);
  if (alerts.length) selectedPatientId = Number(alerts[0].patientId);
  showView("patients");
}

function toggleAddCustomer() {
  const row = document.getElementById("addCustomerRow");
  const btn = document.getElementById("addCustomerToggle");
  const isOpen = row.style.display !== "none";
  row.style.display = isOpen ? "none" : "flex";
  btn.classList.toggle("on", !isOpen);
  if (!isOpen) {
    document.getElementById("newCustomerName").value = "";
    document.getElementById("newCustomerPhone").value = "";
    setTimeout(() => document.getElementById("newCustomerName").focus(), 50);
  }
}

async function saveNewCustomer() {
  if (!requirePermission("editPatients", "Patient-edit access is required to add a customer")) return;
  const name = document.getElementById("newCustomerName").value.trim();
  if (!name) return showToast("Customer name is required", 2500, "error");
  if (name.length < 2) return showToast("Customer name must be at least 2 characters", 2500, "error");
  const phone = document.getElementById("newCustomerPhone").value.trim();
  if (phone && !/^\+?\d{9,15}$/.test(phone.replace(/[\s\-().]/g, ""))) {
    return showToast("Phone number must be 9–15 digits", 2500, "error");
  }
  const newId = Math.max(Date.now(), customers.length ? Math.max(0, ...customers.map(c => Number(c.id) || 0)) + 1 : 1);
  let customer = normalizePatientProfile(setRecordBranch({ id: newId, name, phone, notes: "", balance: 0 }));
  try {
    const savedCustomer = await syncServerAction("/customers", { customer }, { branch: getCurrentBranchId() });
    if (savedCustomer) customer = normalizePatientProfile(savedCustomer);
  } catch (error) {
    console.warn(error);
    return showToast(error.message || "Customer was not saved because the server is unavailable", 3500, "error");
  }
  customers.push(customer);
  saveCustomers();
  selectedCustomerId = customer.id;
  selectedPatientId = customer.id;
  renderCustomerOptions();
  renderPatientProfiles();
  document.getElementById("addCustomerRow").style.display = "none";
  document.getElementById("addCustomerToggle").classList.remove("on");
  showToast(`Customer "${name}" added`);
  recordAudit("customer-add", `Added new customer: ${name}${phone ? " (" + phone + ")" : ""}`);
}

function renderCustomerOptions() {
  const select = document.getElementById("customerSelect");
  const saleCustomers = getCustomersForCurrentSale();
  renderHtml(select, saleCustomers.map(c => `
        <option value="${sanitize(c.id)}">${sanitize(c.name || "Customer")}${c.phone ? ` - ${sanitize(c.phone)}` : ""}${c.balance ? ` - owes GHS ${Number(c.balance || 0).toFixed(2)}` : ""}</option>
      `).join(""));
  if (!saleCustomers.some(customer => Number(customer.id) === Number(selectedCustomerId))) selectedCustomerId = saleCustomers[0]?.id || "";
  select.value = selectedCustomerId;
}

function selectCustomer(event) {
  selectedCustomerId = Number(event.target.value);
  if (selectedCustomerId) selectedPatientId = selectedCustomerId;
}

function getPatientById(id = selectedPatientId) {
  return customers.find(customer => Number(customer.id) === Number(id));
}

function getPatientSales(patient) {
  if (!patient) return [];
  const patientName = String(patient.name || "").toLowerCase();
  const sameNameCount = customers.filter(customer => String(customer.name || "").toLowerCase() === patientName).length;
  const branchId = normalizeBranchId(patient.branch_id || patient.branchId || patient.branch) || getCurrentBranchId();
  return getRecordsForBranch(salesHistory, branchId)
    .filter(sale => Number(sale.customerId) === Number(patient.id)
      || (sale.customerId == null && sameNameCount === 1 && String(sale.customer || "").toLowerCase() === patientName))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

function getPatientSummary(patient) {
  const sales = getPatientSales(patient);
  const totalSpent = sales.reduce((sum, sale) => sum + (Number(sale.total) || 0), 0);
  const lastVisit = patient?.lastVisit || sales[0]?.date || "";
  return {
    sales,
    count: sales.length,
    totalSpent,
    lastVisit,
    nextRefill: estimateNextRefillDate(sales)
  };
}

function formatPatientDate(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" });
}

function renderPatientProfiles() {
  const list = document.getElementById("patientList");
  if (!list) return;
  normalizePatientProfiles();
  const query = (document.getElementById("patientSearch")?.value || "").trim().toLowerCase();
  const source = getPatientsForCurrentBranch();
  const filtered = source.filter(customer => {
    if (!query) return true;
    return [customer.name, customer.phone, customer.conditions, customer.allergies, customer.branch]
      .some(value => String(value || "").toLowerCase().includes(query));
  });
  if (!filtered.length) {
    renderHtml(list, `<div class="empty-cart"><i class="ti ti-user-search"></i><div>No patient profiles found</div></div>`);
  } else {
    if (!filtered.some(patient => Number(patient.id) === Number(selectedPatientId))) selectedPatientId = filtered[0].id;
    renderHtml(list, filtered.map(patient => {
      const summary = getPatientSummary(patient);
      return `
        <button class="patient-list-item${Number(patient.id) === Number(selectedPatientId) ? " active" : ""}" onclick="selectPatientProfile(${Number(patient.id)})">
          <strong>${sanitize(patient.name || "Patient")}</strong>
          <span>${sanitize(patient.phone || "No phone")} - ${sanitize(patient.branch || getCurrentBranchName())} - ${summary.count} purchase${summary.count === 1 ? "" : "s"}</span>
        </button>
      `;
    }).join(""));
  }
  renderSelectedPatientProfile();
}

function selectPatientProfile(id) {
  selectedPatientId = Number(id);
  renderPatientProfiles();
}

async function createPatientProfile() {
  if (!requirePermission("editPatients", "Worker, pharmacist, or manager access required")) return;
  const nameInput = document.getElementById("patientNewName");
  const phoneInput = document.getElementById("patientNewPhone");
  const dobInput = document.getElementById("patientNewDob");
  const name = nameInput?.value.trim();
  if (!name) return showToast("Patient name is required", 2500, "error");
  if (name.length < 2) return showToast("Patient name must be at least 2 characters", 2500, "error");
  const phone = phoneInput?.value.trim() || "";
  if (phone && !/^\+?\d{9,15}$/.test(phone.replace(/[\s\-().]/g, ""))) {
    return showToast("Phone number must be 9–15 digits", 2500, "error");
  }
  const dateOfBirth = dobInput?.value || "";
  const newId = Math.max(Date.now(), customers.length ? Math.max(0, ...customers.map(c => Number(c.id) || 0)) + 1 : 1);
  let customer = normalizePatientProfile({
    id: newId,
    name,
    phone,
    dateOfBirth,
    dob: dateOfBirth,
    notes: "",
    balance: 0,
    medicalRecords: []
  });
  setRecordBranch(customer);
  try {
    const savedCustomer = await syncServerAction("/customers", { customer }, { branch: getCurrentBranchId() });
    if (savedCustomer) customer = normalizePatientProfile(savedCustomer);
  } catch (error) {
    console.warn(error);
    return showToast(error.message || "Patient was not saved because the server is unavailable", 3500, "error");
  }
  customers.push(customer);
  selectedPatientId = customer.id;
  selectedCustomerId = customer.id;
  saveCustomers();
  renderCustomerOptions();
  renderPatientProfiles();
  if (nameInput) nameInput.value = "";
  if (phoneInput) phoneInput.value = "";
  if (dobInput) dobInput.value = "";
  recordAudit("patient-add", `Created patient profile: ${name}${phone ? " (" + phone + ")" : ""}`);
  showToast("Patient profile created");
}

async function savePatientProfile() {
  if (!requirePermission("editPatients", "Worker, pharmacist, or manager access required")) return;
  const patient = getPatientById();
  if (!patient) return showToast("Select a patient first", 2500, "error");
  const nextBranchId = normalizeBranchId(document.getElementById("patientHomeBranch")?.value) || patient.branch_id || getCurrentBranchId();
  const draft = normalizePatientProfile({ ...patient });
  setRecordBranch(draft, nextBranchId);
  draft.dateOfBirth = document.getElementById("patientDob")?.value || "";
  draft.dob = draft.dateOfBirth;
  draft.allergies = document.getElementById("patientAllergies")?.value.trim() || "";
  draft.conditions = document.getElementById("patientConditions")?.value.trim() || "";
  draft.currentMedications = document.getElementById("patientMedications")?.value.trim() || "";
  draft.medicalNotes = document.getElementById("patientNotes")?.value.trim() || "";
  draft.notes = draft.medicalNotes;
  draft.updatedAt = new Date().toISOString();
  try {
    const savedPatient = await syncServerAction("/customers", { customer: draft }, { branch: nextBranchId });
    Object.assign(patient, normalizePatientProfile(savedPatient || draft));
  } catch (error) {
    console.warn(error);
    return showToast(error.message || "Profile was not saved because the server is unavailable", 3500, "error");
  }
  saveCustomers();
  renderPatientProfiles();
  renderCustomerOptions();
  recordAudit("patient-update", `Updated patient profile: ${patient.name}`);
  showToast("Patient profile saved");
}

async function addPatientMedicalRecord() {
  if (!requirePermission("editPatients", "Worker, pharmacist, or manager access required")) return;
  const patient = getPatientById();
  if (!patient) return showToast("Select a patient first", 2500, "error");
  const type = document.getElementById("patientRecordType")?.value || "Consultation";
  const note = document.getElementById("patientRecordNote")?.value.trim();
  const dateValue = document.getElementById("patientRecordDate")?.value;
  if (!note) return showToast("Record details are required", 2500, "error");
  const record = {
    id: makeClientId("REC"),
    type,
    date: dateValue ? new Date(`${dateValue}T12:00:00`).toISOString() : new Date().toISOString(),
    note,
    by: currentUser?.username || "system"
  };
  const draft = normalizePatientProfile({
    ...patient,
    medicalRecords: [record, ...(Array.isArray(patient.medicalRecords) ? patient.medicalRecords : [])],
    updatedAt: new Date().toISOString()
  });
  try {
    const savedPatient = await syncServerAction("/customers", { customer: draft }, { branch: patient.branch_id || getCurrentBranchId() });
    Object.assign(patient, normalizePatientProfile(savedPatient || draft));
  } catch (error) {
    console.warn(error);
    return showToast(error.message || "Medical record was not saved because the server is unavailable", 3500, "error");
  }
  saveCustomers();
  const noteInput = document.getElementById("patientRecordNote");
  if (noteInput) noteInput.value = "";
  renderPatientProfiles();
  recordAudit("patient-record", `Added ${type.toLowerCase()} record for ${patient.name}`);
  showToast("Medical record added");
}

function renderSelectedPatientProfile() {
  const patient = getPatientById();
  const nameEl = document.getElementById("patientProfileName");
  if (!nameEl) return;
  if (!patient || (!isWalkInCustomer(patient) && normalizeBranchId(patient.branch_id || patient.branchId || patient.branch) !== getCurrentBranchId())) {
    nameEl.textContent = "No patient selected";
    document.getElementById("patientProfileMeta").textContent = "Create or select a patient profile.";
    setText("patientAge", "--");
    setText("patientNextRefill", "--");
    return;
  }
  normalizePatientProfile(patient);
  const summary = getPatientSummary(patient);
  nameEl.textContent = patient.name || "Patient";
  document.getElementById("patientProfileMeta").textContent = `${patient.phone || "No phone"} - ${patient.branch || getCurrentBranchName()}${patient.conditions ? " - " + patient.conditions : ""}`;
  document.getElementById("patientPurchaseCount").textContent = summary.count;
  document.getElementById("patientTotalSpent").textContent = money(summary.totalSpent);
  document.getElementById("patientLastVisit").textContent = summary.lastVisit ? formatPatientDate(summary.lastVisit) : "--";
  setText("patientAge", calculateAgeLabel(patient.dateOfBirth || patient.dob));
  setText("patientNextRefill", summary.nextRefill ? formatPatientDate(summary.nextRefill) : "--");
  const branchSelect = document.getElementById("patientHomeBranch");
  if (branchSelect) {
    renderHtml(branchSelect, branchRecords.map(branch => `<option value="${sanitize(branch.id)}">${sanitize(branch.name)}</option>`).join(""));
    branchSelect.value = patient.branch_id || getCurrentBranchId();
  }
  const dobInput = document.getElementById("patientDob");
  if (dobInput) dobInput.value = patient.dateOfBirth || patient.dob || "";
  document.getElementById("patientAllergies").value = patient.allergies || "";
  document.getElementById("patientConditions").value = patient.conditions || "";
  document.getElementById("patientMedications").value = patient.currentMedications || "";
  document.getElementById("patientNotes").value = patient.medicalNotes || "";
  const recordDate = document.getElementById("patientRecordDate");
  if (recordDate && !recordDate.value) recordDate.value = new Date().toISOString().slice(0, 10);
  renderPatientPurchaseHistory(patient, summary.sales);
  renderPatientMedicineHistory(summary.sales);
  renderPatientMedicalRecords(patient);
}

function renderPatientPurchaseHistory(patient, sales = getPatientSales(patient)) {
  const target = document.getElementById("patientPurchaseHistory");
  if (!target) return;
  if (!sales.length) {
    renderHtml(target, `<div class="empty-cart"><i class="ti ti-receipt-off"></i><div>No previous purchases recorded</div></div>`);
    return;
  }
  renderHtml(target, sales.slice(0, 8).map(sale => {
    const itemNames = (sale.items || []).map(item => `${sanitize(item.name)} x${Number(item.qty || 0)}`).join(", ");
    return `
      <div class="dashboard-list-row">
        <div>
          <strong>${sanitize(sale.id || "Sale")}</strong>
          <span>${formatPatientDate(sale.date)} - ${sanitize(itemNames || "No items")}</span>
        </div>
        <b>${money(sale.total)}</b>
      </div>
    `;
  }).join(""));
}

function renderPatientMedicineHistory(sales) {
  const target = document.getElementById("patientMedicineHistory");
  if (!target) return;
  const medicines = new Map();
  sales.forEach(sale => {
    (sale.items || []).forEach(item => {
      const key = item.name || "Unknown medicine";
      const existing = medicines.get(key) || { qty: 0, last: sale.date, price: item.price || 0 };
      existing.qty += Number(item.qty || 0);
      if (new Date(sale.date) > new Date(existing.last)) existing.last = sale.date;
      medicines.set(key, existing);
    });
  });
  const rows = [...medicines.entries()].sort((a, b) => new Date(b[1].last) - new Date(a[1].last));
  if (!rows.length) {
    renderHtml(target, `<div class="empty-cart"><i class="ti ti-pill-off"></i><div>No medicine history yet</div></div>`);
    return;
  }
  renderHtml(target, rows.slice(0, 10).map(([name, stats]) => `
    <div class="dashboard-list-row">
      <div>
        <strong>${sanitize(name)}</strong>
        <span>${stats.qty} total unit${stats.qty === 1 ? "" : "s"} - last: ${formatPatientDate(stats.last)}</span>
      </div>
      <b>${money(stats.price)}</b>
    </div>
  `).join(""));
}

function renderPatientMedicalRecords(patient) {
  const target = document.getElementById("patientMedicalRecords");
  if (!target) return;
  const records = [...(patient.medicalRecords || [])].sort((a, b) => new Date(b.date) - new Date(a.date));
  if (!records.length) {
    renderHtml(target, `<div class="empty-cart"><i class="ti ti-file-off"></i><div>No medical records added</div></div>`);
    return;
  }
  renderHtml(target, records.map(record => `
    <div class="dashboard-list-row patient-record-row">
      <div>
        <strong>${sanitize(record.type || "Record")} - ${formatPatientDate(record.date)}</strong>
        <span>${sanitize(record.note || "")}</span>
      </div>
      <b>${sanitize(record.by || "system")}</b>
    </div>
  `).join(""));
}

function openSelectedPatientProfile() {
  if (selectedCustomerId) selectedPatientId = selectedCustomerId;
  showView("patients");
}

function startSaleForPatient() {
  const patient = getPatientById();
  if (!patient) return showToast("Select a patient first", 2500, "error");
  selectedCustomerId = patient.id;
  renderCustomerOptions();
  showView("pos");
  setTimeout(() => document.getElementById("searchInput")?.focus(), 50);
}
