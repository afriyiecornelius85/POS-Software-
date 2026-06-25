const WORKSPACE_SECTION_GROUPS = Object.freeze({
  inventory: {
    view: "admin",
    parentId: "nav-admin",
    groupId: "sidebar-group-inventory",
    defaultSection: "list",
    panelSelector: "#view-admin .view-subsection[data-subsection]",
    nav: {
      list: "nav-inventory-list",
      editor: "nav-inventory-editor",
      transfer: "nav-inventory-transfer",
      audit: "nav-inventory-audit"
    }
  },
  purchases: {
    view: "purchases",
    parentId: "nav-purchases",
    groupId: "sidebar-group-purchases",
    defaultSection: "grn",
    panelSelector: "#view-purchases .view-subsection[data-subsection]",
    nav: {
      overview: "nav-purchases-overview",
      grn: "nav-purchases-grn",
      suppliers: "nav-purchases-suppliers",
      history: "nav-purchases-history"
    }
  },
  reports: {
    parentId: "nav-reports",
    groupId: "sidebar-group-reports",
    defaultSection: "summary",
    nav: {
      summary: "nav-reports-summary",
      history: "nav-reports-history",
      "shift-log": "nav-reports-shift-log"
    },
    views: {
      summary: "summary",
      history: "history",
      "shift-log": "shift-log"
    }
  },
  settings: {
    view: "settings",
    parentId: "nav-settings",
    groupId: "sidebar-group-settings",
    defaultSection: "profile",
    panelSelector: "#view-settings .settings-card[data-subsection]",
    nav: {
      profile: "nav-settings-profile",
      users: "nav-settings-users",
      branches: "nav-settings-branches",
      rules: "nav-settings-rules",
      receipt: "nav-settings-receipt",
      shifts: "nav-settings-shifts",
      lowstock: "nav-settings-lowstock",
      roles: "nav-settings-roles",
      activity: "nav-settings-activity"
    }
  },
  sync: {
    view: "sync",
    parentId: "nav-sync",
    groupId: "sidebar-group-sync",
    defaultSection: "server",
    panelSelector: "#view-sync .sync-backup-card[data-subsection]",
    nav: {
      server: "nav-sync-server",
      backup: "nav-sync-backup",
      status: "nav-sync-status"
    }
  }
});

const VIEW_TO_SECTION_GROUP = Object.freeze({
  admin: "inventory",
  purchases: "purchases",
  settings: "settings",
  sync: "sync",
  summary: "reports",
  history: "reports",
  "shift-log": "reports",
  lowstock: "inventory",
  expiry: "inventory"
});

const activeWorkspaceSections = {
  inventory: "list",
  purchases: "grn",
  reports: "summary",
  settings: "profile",
  sync: "server"
};

function setSidebarGroupOpen(groupKey, open) {
  const config = WORKSPACE_SECTION_GROUPS[groupKey];
  if (!config) return;
  const group = document.getElementById(config.groupId);
  const parent = document.getElementById(config.parentId);
  group?.classList.toggle("is-open", !!open);
  parent?.setAttribute("aria-expanded", String(!!open));
}

function closeSidebarGroups(exceptGroup = "") {
  Object.keys(WORKSPACE_SECTION_GROUPS).forEach(groupKey => {
    if (groupKey !== exceptGroup) setSidebarGroupOpen(groupKey, false);
  });
}

function toggleSidebarGroup(groupKey) {
  const config = WORKSPACE_SECTION_GROUPS[groupKey];
  if (!config) return;
  const group = document.getElementById(config.groupId);
  if (document.querySelector(".app-shell")?.classList.contains("sidebar-collapsed")) {
    saveToStorage(SIDEBAR_COLLAPSED_KEY, false);
    applySidebarState(false);
  }
  const willOpen = !group?.classList.contains("is-open");
  closeSidebarGroups(willOpen ? groupKey : "");
  setSidebarGroupOpen(groupKey, willOpen);
  if (willOpen) document.body.dataset.sidebarGroup = groupKey;
}

function showWorkspaceSection(groupKey, sectionKey) {
  const config = WORKSPACE_SECTION_GROUPS[groupKey];
  if (!config) return;
  const section = sectionKey || config.defaultSection;
  activeWorkspaceSections[groupKey] = section;
  const view = config.views?.[section] || config.view;
  if (view) showView(view);
}

function applyWorkspaceSection(groupKey) {
  const config = WORKSPACE_SECTION_GROUPS[groupKey];
  if (!config?.panelSelector) return;
  document.querySelectorAll(".collapsible-body.open").forEach(body => {
    body.classList.remove("open");
    body.onclick = null;
  });
  document.querySelectorAll(".collapsible-toggle.open").forEach(toggle => toggle.classList.remove("open"));
  document.body?.classList.remove("panel-modal-open");
  const section = activeWorkspaceSections[groupKey] || config.defaultSection;
  const panels = document.querySelectorAll(config.panelSelector);
  if (!panels.length) return;
  panels.forEach(panel => panel.classList.toggle("is-active", panel.dataset.subsection === section));
  const rootView = config.view ? document.getElementById(`view-${config.view}`) : null;
  rootView?.classList.toggle("has-focused-subsection", true);
}

function applyWorkspaceSectionForView(view) {
  const groupKey = VIEW_TO_SECTION_GROUP[view];
  if (view === "lowstock") activeWorkspaceSections.inventory = "lowstock";
  if (view === "expiry") activeWorkspaceSections.inventory = "expiry";
  if (["summary", "history", "shift-log"].includes(view)) activeWorkspaceSections.reports = view;
  if (!groupKey) return;
  applyWorkspaceSection(groupKey);
}

function updateSidebarNavigation(view) {
  document.querySelectorAll(".app-sidebar .nav-btn, .app-sidebar .sidebar-subnav-btn").forEach(btn => btn.classList.remove("active"));
  const simpleNav = {
    dashboard: "nav-dashboard",
    pos: "nav-pos",
    held: "nav-pos",
    receipt: "nav-pos",
    returns: "nav-returns",
    patients: "nav-patients",
    reference: "nav-reference"
  }[view];
  const groupKey = VIEW_TO_SECTION_GROUP[view] || "";
  closeSidebarGroups(groupKey);
  document.body.dataset.sidebarGroup = groupKey;
  if (simpleNav) {
    document.getElementById(simpleNav)?.classList.add("active");
    // Hide any open subnav pills when switching to a simple nav item
    if (typeof hideSubnavPills === "function") hideSubnavPills();
    return;
  }
  const config = WORKSPACE_SECTION_GROUPS[groupKey];
  if (!config) return;
  setSidebarGroupOpen(groupKey, true);
  document.getElementById(config.parentId)?.classList.add("active");
  let section = activeWorkspaceSections[groupKey] || config.defaultSection;
  if (view === "lowstock") section = "lowstock";
  if (view === "expiry") section = "expiry";
  if (["summary", "history", "shift-log"].includes(view)) section = view;
  const navId = config.nav?.[section] || (view === "lowstock" ? "nav-inventory-lowstock" : view === "expiry" ? "nav-inventory-expiry" : "");
  if (navId) document.getElementById(navId)?.classList.add("active");
  // #2 Position subnav pill after active class is set
  requestAnimationFrame(() => {
    const group = document.querySelector(`.sidebar-menu-group[id="sidebar-group-${groupKey}"]`);
    if (group && typeof positionSubnavPill === "function") positionSubnavPill(group);
  });
}

function updateStatusChip() {
  const status = document.getElementById("statusChipText");
  const now = new Date();
  const time = now.toLocaleTimeString("en-GH", { hour: "2-digit", minute: "2-digit" });
  updateDashboardShell({ now });
  if (!status) return;
  if (!currentUser) {
    status.textContent = `Guest - ${time}`;
    return;
  }
  const activeShift = getActiveShift(now);
  const shiftLabel = activeShift ? activeShift.name : "Off shift";
  status.textContent = `${currentUser.name} - ${shiftLabel} - ${time}`;
}

function updateSyncStatus(state, detail = "") {
  const normalized = state || (hasApiServer() ? "ready" : "local");
  const chip = document.getElementById("syncChip");
  const chipText = document.getElementById("syncChipText");
  const syncPageStatusText = document.getElementById("syncPageStatusText");
  const labels = {
    local: "Local Storage",
    ready: "Server Connected",
    syncing: "Syncing",
    online: "Server Connected",
    offline: "Server Offline"
  };
  const titles = {
    local: "Sync: browser storage only",
    ready: "Sync: server configured",
    syncing: "Sync: checking server",
    online: "Sync: server connected",
    offline: "Sync: server unavailable"
  };
  const icons = {
    local: "ti-cloud",
    ready: "ti-cloud",
    syncing: "ti-cloud-up",
    online: "ti-cloud",
    offline: "ti-cloud-x"
  };
  if (chip) {
    chip.classList.remove("sync-local", "sync-ready", "sync-syncing", "sync-online", "sync-offline");
    chip.classList.add(`sync-${normalized}`);
    const chipLabel = detail ? `Sync ${labels[normalized] || labels.local}: ${detail}` : (titles[normalized] || titles.local);
    chip.title = chipLabel;
    chip.setAttribute("aria-label", chipLabel);
    const icon = chip.querySelector("i");
    if (icon) icon.className = `ti ${icons[normalized] || icons.local}`;
  }
  if (chipText) chipText.textContent = labels[normalized] || labels.local;
  if (syncPageStatusText) {
    const fallback = {
      local: "Browser storage only",
      ready: "Server configured",
      syncing: "Syncing branch data...",
      online: "Server connected",
      offline: "Server unavailable"
    };
    syncPageStatusText.textContent = detail || fallback[normalized] || fallback.local;
  }
}

function initSyncControls() {
  const syncInput = document.getElementById("syncApiBaseInput");
  if (syncInput) {
    syncInput.value = API_BASE_URL;
    syncInput.readOnly = shouldUseHostedApiBase();
    syncInput.title = shouldUseHostedApiBase() ? "Hosted deployments always use the same-origin /api endpoint" : "";
  }
  updateSyncStatus(hasApiServer() ? "ready" : "local");
}

function saveSyncServerUrl() {
  if (!requirePermission("managerAccess", "Manager access required to change sync settings")) return;
  if (shouldUseHostedApiBase()) {
    localStorage.removeItem(STORAGE_KEYS.apiBase);
    API_BASE_URL = "/api";
    const hostedInput = document.getElementById("syncApiBaseInput");
    if (hostedInput) hostedInput.value = API_BASE_URL;
    return showToast("Hosted deployments securely use this site's /api endpoint", 3000, "info");
  }
  const input = document.getElementById("syncApiBaseInput");
  const nextUrl = (input?.value || "").trim().replace(/\/$/, "");
  if (nextUrl) localStorage.setItem(STORAGE_KEYS.apiBase, nextUrl);
  else localStorage.removeItem(STORAGE_KEYS.apiBase);
  API_BASE_URL = readApiBaseUrl();
  document.getElementById("syncApiBaseInput") && (document.getElementById("syncApiBaseInput").value = API_BASE_URL);
  if (hasApiServer() && currentUser) {
    updateSyncStatus("ready", "Server configured");
    refreshServerData({ silent: false });
    startLiveSync();
    showToast("Sync server saved", 2000, "success");
  } else {
    stopLiveSync();
    updateSyncStatus("local", "Browser storage only");
    showToast("Sync server cleared", 2000, "info");
  }
}

async function testServerSync() {
  if (!hasApiServer()) return showToast("Enter a sync server URL first", 2500, "warning");
  try {
    updateSyncStatus("syncing", "Checking server...");
    const health = await apiGet("/health", {}, { branch: null });
    updateSyncStatus("online", `${health.pharmacy || PHARMACY_NAME} server online`);
    showToast("Sync server connected", 2000, "success");
  } catch (error) {
    console.warn(error);
    updateSyncStatus("offline", "Server unavailable");
    showToast("Sync server unavailable", 3000, "error");
  }
}

async function pullServerSync() {
  if (!hasApiServer()) return showToast("Enter a sync server URL first", 2500, "warning");
  if (!currentUser) return showToast("Sign in before syncing", 2500, "warning");
  await refreshServerData({ silent: false });
}

function getLocalSyncPayload() {
  return {
    pharmacy_id: PHARMACY_ID,
    pharmacy: PHARMACY_NAME,
    exportedAt: new Date().toISOString(),
    drugs: JSON.parse(JSON.stringify(drugs)),
    customers: JSON.parse(JSON.stringify(getScopedRecords(customers))),
    suppliers: JSON.parse(JSON.stringify(getScopedRecords(suppliers)))
  };
}

function pushLocalDataToServer() {
  if (String(currentUser?.role || "").toLowerCase() !== "director") {
    return showToast("Only a director can push local data to the server", 3000, "error");
  }
  if (!hasApiServer()) return showToast("Enter a sync server URL first", 2500, "warning");
  openConfirmModal({
    title: "Push local data",
    confirmText: "Push to server",
    icon: "ti-cloud-upload",
    body: `
          <p>Merge this browser's inventory, stock balances, customers, and suppliers into the sync server? Verify the displayed local stock first. Financial history, users, and branches are never imported through bulk sync.</p>
          <div class="confirm-context">
            <div><span>Inventory</span><strong>${drugs.length}</strong></div>
            <div><span>Suppliers</span><strong>${suppliers.length}</strong></div>
            <div><span>Customers</span><strong>${customers.length}</strong></div>
          </div>
        `,
    onConfirm: () => runPushLocalDataToServer()
  });
}

async function runPushLocalDataToServer() {
  if (String(currentUser?.role || "").toLowerCase() !== "director") {
    return showToast("Only a director can push local data to the server", 3000, "error");
  }
  try {
    updateSyncStatus("syncing", "Pushing local data...");
    await apiPost("/sync", getLocalSyncPayload(), { branch: "all" });
    await refreshServerData({ silent: true });
    updateSyncStatus("online", `Pushed ${new Date().toLocaleTimeString("en-GH", { hour: "2-digit", minute: "2-digit" })}`);
    showToast("Local data pushed to server", 2500, "success");
  } catch (error) {
    console.warn(error);
    updateSyncStatus("offline", "Server push failed");
    showToast("Server push failed", 3000, "error");
  }
}
function updateClock() { updateStatusChip(); }

function findDrugForSaleInput(code) {
  const query = String(code || "").trim().toLowerCase();
  if (!query) return null;
  const candidates = drugs.filter(item => {
    if (!isDrugAvailableAtBranch(item)) return false;
    const stock = Number(item.stock ?? 0);
    if (stock <= 0) return false;
    return String(item.barcode || "").toLowerCase() === query ||
      String(item.name || "").toLowerCase() === query ||
      String(item.name || "").toLowerCase().includes(query) ||
      String(item.brand || "").toLowerCase().includes(query);
  });
  return candidates[0] || null;
}

function focusSaleSearch() {
  showView("pos");
  setTimeout(() => {
    const input = document.getElementById("searchInput");
    if (input) {
      input.focus();
      input.select();
    }
  }, 30);
}

function focusPaymentAmount() {
  showView("pos");
  setTimeout(() => {
    const input = document.getElementById("paymentAmount1");
    if (input) {
      input.focus();
      input.select();
    }
  }, 30);
}

function closeActiveShortcutLayer() {
  closeNotificationsDropdown();
  closeDataUtil();
  closeBranchDropdown();
  const confirmModal = document.getElementById("confirmModal");
  if (confirmModal && !confirmModal.classList.contains("is-hidden")) {
    closeConfirmModal();
    return true;
  }
  const writeOffModal = document.getElementById("writeOffModal");
  if (writeOffModal && !writeOffModal.classList.contains("is-hidden")) {
    closeWriteOffModal();
    return true;
  }
  for (const id of ["interactionReviewModal", "overrideReasonModal", "priceOverrideModal"]) {
    const modal = document.getElementById(id);
    if (modal && modal.style.display !== "none") {
      modal.style.display = "none";
      return true;
    }
  }
  return false;
}

function handleBarcodeScan(code) {
  const drug = findDrugForSaleInput(code);
  if (drug) {
    addToCart(drug.id);
    showToast(`Scanned ${drug.name}`);
    const search = document.getElementById("searchInput");
    if (search) search.value = "";
    filterDrugs();
  } else {
    showToast(`Barcode not found: ${code}`, 2500, "error");
  }
}
function toggleDataUtil() {
  const menu = document.getElementById("dataUtilMenu");
  const chevron = document.getElementById("dataUtilChevron");
  if (!menu || !chevron) return;
  const isOpen = menu.style.display === "block";
  menu.style.display = isOpen ? "none" : "block";
  chevron.style.transform = isOpen ? "" : "rotate(180deg)";
}
function closeDataUtil() {
  const menu = document.getElementById("dataUtilMenu");
  const chevron = document.getElementById("dataUtilChevron");
  if (menu) menu.style.display = "none";
  if (chevron) chevron.style.transform = "";
}
// Close dropdown when clicking outside
document.addEventListener("click", function (e) {
  const wrap = document.getElementById("dataUtilWrap");
  if (wrap && !wrap.contains(e.target)) closeDataUtil();
});

// #8 Keyboard shortcut overlay
function openShortcutOverlay() {
  document.getElementById("shortcutOverlay")?.classList.add("open");
}
function closeShortcutOverlay() {
  document.getElementById("shortcutOverlay")?.classList.remove("open");
}

window.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    // Close shortcut overlay first if open
    const overlay = document.getElementById("shortcutOverlay");
    if (overlay?.classList.contains("open")) {
      closeShortcutOverlay();
      event.preventDefault();
      return;
    }
    if (closeActiveShortcutLayer()) {
      event.preventDefault();
      return;
    }
    if (document.getElementById("view-receipt")?.classList.contains("active")) {
      event.preventDefault();
      newSale();
      focusSaleSearch();
      return;
    }
  }
  if (document.getElementById("view-receipt")?.classList.contains("active")) {
    if (event.key === "Enter") {
      event.preventDefault();
      printReceipt();
      return;
    }
    if (event.key.toLowerCase() === "n") {
      event.preventDefault();
      newSale();
      focusSaleSearch();
      return;
    }
  }

  const tag = event.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    if (event.target.id === "searchInput" && event.key === "Enter") {
      const val = event.target.value.trim();
      if (val) {
        handleBarcodeScan(val);
      }
    } else if (event.target.id === "paymentAmount1" && event.key === "Enter") {
      if (!document.getElementById("checkoutBtn")?.disabled) checkout();
    }
    return;
  }
  
  // #8 ? key opens shortcut overlay
  if (event.key === "?") { openShortcutOverlay(); return; }
  if (event.key === "Enter") { if (scannerBuffer.length) { handleBarcodeScan(scannerBuffer); scannerBuffer = ""; clearTimeout(scannerTimer); } return; }
  if (event.key.length === 1 && /[A-Za-z0-9]/.test(event.key)) { scannerBuffer += event.key; clearTimeout(scannerTimer); scannerTimer = setTimeout(() => { scannerBuffer = ""; }, 120); }
});

// Expiry Management View
let expiryFilterMode = "expired"; // "expired" | "7" | "30" | "90" | "all"
let expirySortCol = 4;         // default: sort by days-left ascending
let expirySortAsc = true;
let writeOffDrugId = null;      // drug id pending write-off confirmation
let writeOffBatchId = null;     // batch id pending write-off confirmation

function getExpiryDays(drug) {
  if (!drug.expiry) return null;
  const expiryDate = new Date(`${drug.expiry}T23:59:59`);
  const ms = expiryDate.getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.ceil((ms - Date.now()) / 86400000) - 1;
}

function getAllExpiryDrugs() {
  return getBatchExpiryRows(getCurrentBranchId()).filter(row => (Number(row.stock) || 0) > 0);
}

function getExpiryCounts() {
  const all = getAllExpiryDrugs();
  const now = Date.now();
  return {
    expired: all.filter(d => new Date(d.expiry).getTime() < now).length,
    d7: all.filter(d => { const ms = new Date(d.expiry).getTime(); return ms >= now && ms <= now + 7 * 86400000; }).length,
    d30: all.filter(d => { const ms = new Date(d.expiry).getTime(); return ms >= now && ms <= now + 30 * 86400000; }).length,
    d90: all.filter(d => { const ms = new Date(d.expiry).getTime(); return ms >= now && ms <= now + 90 * 86400000; }).length,
  };
}

function getExpiryStatusBadge(days) {
  if (days === null) return `<span class="expiry-status-badge expiry-status-90">No date</span>`;
  if (days < 0) return `<span class="expiry-status-badge expiry-status-expired"><i class="ti ti-skull" style="font-size:10px;"></i> Expired ${Math.abs(days)}d ago</span>`;
  if (days === 0) return `<span class="expiry-status-badge expiry-status-expired"><i class="ti ti-alarm" style="font-size:10px;"></i> Expires TODAY</span>`;
  if (days <= 7) return `<span class="expiry-status-badge expiry-status-7"><i class="ti ti-alarm" style="font-size:10px;"></i> ${days}d left</span>`;
  if (days <= 30) return `<span class="expiry-status-badge expiry-status-30"><i class="ti ti-clock-exclamation" style="font-size:10px;"></i> ${days}d left</span>`;
  return `<span class="expiry-status-badge expiry-status-90"><i class="ti ti-clock" style="font-size:10px;"></i> ${days}d left</span>`;
}

function filterExpiryRows(allRows) {
  const now = Date.now();
  if (expiryFilterMode === "expired") return allRows.filter(d => new Date(d.expiry).getTime() < now);
  if (expiryFilterMode === "7") return allRows.filter(d => { const ms = new Date(d.expiry).getTime(); return ms >= now && ms <= now + 7 * 86400000; });
  if (expiryFilterMode === "30") return allRows.filter(d => { const ms = new Date(d.expiry).getTime(); return ms >= now && ms <= now + 30 * 86400000; });
  if (expiryFilterMode === "90") return allRows.filter(d => { const ms = new Date(d.expiry).getTime(); return ms >= now && ms <= now + 90 * 86400000; });
  return allRows; // "all"
}

function sortExpiryRows(rows) {
  return [...rows].sort((a, b) => {
    let valA, valB;
    const daysA = getExpiryDays(a);
    const daysB = getExpiryDays(b);
    switch (expirySortCol) {
      case 0: valA = (a.name || "").toLowerCase(); valB = (b.name || "").toLowerCase(); break;
      case 1: valA = (a.batch || "").toLowerCase(); valB = (b.batch || "").toLowerCase(); break;
      case 2: valA = (a.cat || "").toLowerCase(); valB = (b.cat || "").toLowerCase(); break;
      case 3: valA = a.expiry || ""; valB = b.expiry || ""; break;
      case 4: valA = daysA ?? 9999; valB = daysB ?? 9999; break;
      case 5: valA = a.stock ?? 0; valB = b.stock ?? 0; break;
      case 6: valA = (a.stock ?? 0) * (a.price || 0); valB = (b.stock ?? 0) * (b.price || 0); break;
      default: return 0;
    }
    if (valA < valB) return expirySortAsc ? -1 : 1;
    if (valA > valB) return expirySortAsc ? 1 : -1;
    return 0;
  });
}

function renderExpiryView() {
  // Update summary counts
  const counts = getExpiryCounts();
  document.getElementById("expiryCountExpired").textContent = counts.expired;
  document.getElementById("expiryCount7").textContent = counts.d7;
  document.getElementById("expiryCount30").textContent = counts.d30;
  document.getElementById("expiryCount90").textContent = counts.d90;

  // Highlight active filter button
  document.querySelectorAll(".expiry-filter-btn").forEach(btn => btn.classList.remove("active"));
  const activeBtn = document.getElementById(`expiryFilter-${expiryFilterMode}`);
  if (activeBtn) activeBtn.classList.add("active");

  // Update column sort indicators
  document.querySelectorAll("#expiryTable th[data-ecol]").forEach(th => {
    const col = Number(th.dataset.ecol);
    const icon = th.querySelector("i");
    if (!icon) return;
    if (col === expirySortCol) {
      icon.className = expirySortAsc ? "ti ti-sort-ascending" : "ti ti-sort-descending";
      icon.style.color = "var(--accent-blue)";
    } else {
      icon.className = "ti ti-arrows-sort";
      icon.style.color = "";
    }
  });

  const allRows = getAllExpiryDrugs();
  const filtered = filterExpiryRows(allRows);
  const sorted = sortExpiryRows(filtered);

  const tbody = document.getElementById("expiryRows");
  const noResults = document.getElementById("expiryNoResults");

  if (!sorted.length) {
    renderHtml(tbody, "");
    showHiddenElement(noResults);
    return;
  }
  hideHiddenElement(noResults);

  renderHtml(tbody, sorted.map(row => {
    const days = getExpiryDays(row);
    const value = ((row.stock ?? 0) * (row.price || 0)).toFixed(2);
    const zeroStock = (row.stock ?? 0) === 0;
    return `
          <tr style="${days !== null && days < 0 ? 'background:rgba(220,38,38,.03);' : ''}">
            <td style="font-weight:700;">${sanitize(row.name)}</td>
            <td style="font-family:monospace;font-size:13px;">${sanitize(row.batch || "--")}</td>
            <td><span class="cat-tag">${sanitize(row.cat || "--")}</span></td>
            <td style="font-family:monospace;font-size:13px;">${sanitize(row.expiry || "--")}</td>
            <td>${days === null ? "--" : days < 0 ? `${Math.abs(days)}d overdue` : `${days}d`}</td>
            <td><strong style="color:${zeroStock ? 'var(--muted)' : (days !== null && days < 0 ? '#dc2626' : 'var(--text)')};">${row.stock ?? 0}</strong></td>
            <td style="color:var(--muted);">GHS ${value}</td>
            <td>${getExpiryStatusBadge(days)}</td>
            <td>
              <button class="writeoff-btn" data-drug-id="${sanitize(row.drugId)}" data-batch-id="${sanitize(row.batchId)}" onclick="openWriteOffModalFromButton(this)" ${zeroStock ? 'disabled title="Stock already zero"' : ''}>
                <i class="ti ti-trash"></i> Write off
              </button>
            </td>
          </tr>
        `;
  }).join(""));
}

function setExpiryFilter(mode) {
  expiryFilterMode = mode;
  renderExpiryView();
}

function sortExpiryTable(col) {
  if (expirySortCol === col) {
    expirySortAsc = !expirySortAsc;
  } else {
    expirySortCol = col;
    expirySortAsc = col === 4; // days-left sorts ascending by default
  }
  renderExpiryView();
}

// Write-off modal
function openWriteOffModalFromButton(button) {
  openWriteOffModal(Number(button.dataset.drugId), button.dataset.batchId);
}

function openWriteOffModal(drugId, batchId) {
  const drug = drugs.find(d => d.id === drugId);
  if (!drug) return;
  const batch = findDrugBatch(drug, batchId);
  if (!batch) return showToast("Batch not found", 2500, "error");
  writeOffDrugId = drugId;
  writeOffBatchId = batch.id;
  const row = {
    ...drug,
    expiry: batch.expiry,
    stock: Number(batch.qty) || 0,
    batch: batch.batch || "--"
  };
  const days = getExpiryDays(row);
  const value = ((row.stock ?? 0) * (drug.price || 0)).toFixed(2);
  const statusText = days === null ? "no expiry recorded"
    : days < 0 ? `expired ${Math.abs(days)} day(s) ago`
      : days === 0 ? "expiring today"
        : `expiring in ${days} day(s)`;
  renderHtml(document.getElementById("writeOffMsg"),
    `You are about to write off <strong>${sanitize(drug.name)}</strong> (${sanitize(drug.form || "")}), ` +
    `batch <strong>${sanitize(row.batch)}</strong>, ${statusText}. Batch stock: <strong>${row.stock ?? 0} units</strong> ` +
    `valued at <strong>GHS ${value}</strong>.`);
  const modal = document.getElementById("writeOffModal");
  modal.classList.remove("is-hidden");
  modal.style.display = "flex";
}

function closeWriteOffModal(event) {
  // Close only if clicking directly on the backdrop, or called directly
  if (event && event.target !== document.getElementById("writeOffModal")) return;
  const modal = document.getElementById("writeOffModal");
  modal.style.display = "none";
  modal.classList.add("is-hidden");
  writeOffDrugId = null;
  writeOffBatchId = null;
}

async function confirmWriteOff() {
  if (!requirePermission("writeOffStock", "Manager access required to write off stock")) return;
  if (!writeOffDrugId || !writeOffBatchId) return;
  const drug = drugs.find(d => d.id === writeOffDrugId);
  if (!drug) return;
  const batch = findDrugBatch(drug, writeOffBatchId);
  if (!batch) return showToast("Batch not found", 2500, "error");
  const branchId = batch.branch_id || getCurrentBranchId();
  const branchName = getBranchNameById(branchId);
  const oldStock = Number(batch.qty) || 0;
  const oldBranchStock = Number(drug.branchStock?.[branchName] ?? drug.stock ?? 0) || 0;
  const value = (oldStock * (drug.price || 0)).toFixed(2);
  if (!oldStock) return showToast("Batch stock is already zero", 2500, "warning");
  if (!await saveMajorChangeBackup(`Before write-off ${drug.name} batch ${batch.batch || ""}`)) return;
  drug.branchStock = drug.branchStock || {};
  batch.qty = 0;
  drug.branchStock[branchName] = Math.max(0, oldBranchStock - oldStock);
  if (branchId === getCurrentBranchId()) drug.stock = drug.branchStock[branchName];
  try {
    await syncServerAction("/stock-writeoffs", {
      drug_id: drug.id,
      drugId: drug.id,
      name: drug.name,
      qty: oldStock,
      batch_id: batch.id,
      batchId: batch.id,
      batch: batch.batch || "",
      branch_id: branchId,
      branch: branchName,
      value,
      expiry: batch.expiry || "",
      performedBy: currentUser?.username || "system",
      date: new Date().toISOString()
    }, { branch: branchId });
  } catch (error) {
    console.warn(error);
    batch.qty = oldStock;
    drug.branchStock[branchName] = oldBranchStock;
    if (branchId === getCurrentBranchId()) drug.stock = oldBranchStock;
    return showToast("Write-off not saved: server sync failed", 3500, "error");
  }
  saveDrugs();
  recordAudit(
    "expiry-writeoff",
    `Wrote off ${oldStock} unit(s) of ${drug.name} batch ${batch.batch || "--"} (expiry: ${batch.expiry || "unknown"}, value: GHS ${value}) at ${branchName}`
  );
  const modal = document.getElementById("writeOffModal");
  modal.style.display = "none";
  modal.classList.add("is-hidden");
  writeOffDrugId = null;
  writeOffBatchId = null;
  // Refresh badge counts, inventory, and the expiry view
  updateExpiryNavBadge();
  checkExpiryOnLogin();
  renderExpiryView();
  filterDrugs();
  showToast(`Written off: ${drug.name} batch ${batch.batch || "--"}`);
}

// Expiry badge on nav
function updateExpiryNavBadge() {
  const counts = getExpiryCounts();
  const total = counts.expired + counts.d7 + counts.d30;
  const badge = document.getElementById("expiryBadge");
  if (badge) {
    badge.textContent = total;
    badge.style.display = total ? "inline" : "none";
  }
}

// Export helpers
function exportExpiryCSV() {
  const allRows = getAllExpiryDrugs();
  const filtered = filterExpiryRows(allRows);
  const sorted = sortExpiryRows(filtered);
  const now = Date.now();
  const rows = [
    ["Drug name", "Batch no.", "Category", "Expiry date", "Days left", "Stock", "Selling price (GHS)", "Stock value (GHS)", "Status"]
  ].concat(sorted.map(d => {
    const days = getExpiryDays(d);
    const status = days === null ? "No date"
      : days < 0 ? `Expired ${Math.abs(days)}d ago`
        : days === 0 ? "Expires today"
          : `${days}d left`;
    return [
      d.name, d.batch || "", d.cat || "", d.expiry || "",
      days ?? "", d.stock ?? 0,
      (d.price || 0).toFixed(2),
      ((d.stock ?? 0) * (d.price || 0)).toFixed(2),
      status
    ];
  }));
  const label = expiryFilterMode === "expired" ? "expired"
    : expiryFilterMode === "all" ? "all"
      : `within_${expiryFilterMode}days`;
  downloadCsv(`expiry_${label}_${new Date().toISOString().slice(0, 10)}.csv`, rows);
  showToast(`Exported ${sorted.length} row(s)`);
}

function printExpiryList() {
  const allRows = getAllExpiryDrugs();
  const filtered = filterExpiryRows(allRows);
  const sorted = sortExpiryRows(filtered);
  const branch = getCurrentBranchName() || "Main";
  const now = new Date().toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" });
  const filterLabel = expiryFilterMode === "expired" ? "Expired drugs"
    : expiryFilterMode === "all" ? "All drugs with expiry dates"
      : `Drugs expiring within ${expiryFilterMode} days`;
  let html = `<!doctype html><html><head><meta charset="utf-8"><title>Expiry Report</title>
        <style>body{font-family:Arial,sans-serif;color:#111;padding:18px}h1{font-size:17px}
        table{width:100%;border-collapse:collapse;margin-top:12px;font-size:12px}
        th,td{padding:7px 10px;text-align:left;border-bottom:1px solid #eee}
        th{background:#f7f9fc;font-size:11px}
        .exp{color:#dc2626;font-weight:700}.ok{color:#16a34a}</style>
        </head><body>`;
  html += `<h1>Akopharmah Pharmacy - Expiry Report</h1>`;
  html += `<div>${sanitize(branch)} &nbsp;|&nbsp; ${sanitize(now)} &nbsp;|&nbsp; ${sanitize(filterLabel)}</div>`;
  html += `<table><thead><tr><th>Drug</th><th>Batch</th><th>Category</th><th>Expiry</th><th>Days left</th><th>Stock</th><th>Value (GHS)</th></tr></thead><tbody>`;
  sorted.forEach(d => {
    const days = getExpiryDays(d);
    const cls = (days !== null && days < 0) ? 'class="exp"' : '';
    const daysLabel = days === null ? "--"
      : days < 0 ? `Expired ${Math.abs(days)}d ago`
        : days === 0 ? "TODAY"
          : days + "d";
    html += `<tr ${cls}><td>${sanitize(d.name)}</td><td>${sanitize(d.batch || "")}</td><td>${sanitize(d.cat || "")}</td><td>${sanitize(d.expiry || "")}</td><td>${sanitize(daysLabel)}</td><td>${sanitize(d.stock ?? 0)}</td><td>${((d.stock ?? 0) * (d.price || 0)).toFixed(2)}</td></tr>`;
  });
  html += `</tbody></table>`;
  html += `<script>window.onload=function(){window.print();setTimeout(function(){window.close();},300);}<\/script></body></html>`;
  const w = window.open("", "_blank");
  if (!w) { showToast("Popup blocked - allow popups to print", 2500, "error"); return; }
  w.document.write(html);
  w.document.close();
}

function updateScheduleChip() {
  const chip = document.getElementById("scheduleChipText");
  const dropdown = document.getElementById("scheduleDropdown");
  if (!chip || !dropdown) return;
  const schedule = getShiftSchedule();
  const now = new Date();
  const activeShift = getActiveShift(now);
  const label = activeShift ? `${activeShift.name} Shift` : "Schedule";
  chip.textContent = label;
  dropdown.innerHTML = schedule.map(shift => {
    const isActive = activeShift && activeShift.name === shift.name;
    return `<div class="schedule-dropdown-row${isActive ? " schedule-dropdown-active" : ""}">
      <span class="shift-name">${sanitize(shift.name)} Shift</span>
    </div>`;
  }).join('<hr class="schedule-dropdown-divider">');
}

function toggleScheduleDropdown(event) {
  event.stopPropagation();
  const dropdown = document.getElementById("scheduleDropdown");
  const chip = document.getElementById("scheduleChip");
  if (!dropdown) return;
  const isOpen = dropdown.classList.contains("open");
  dropdown.classList.toggle("open", !isOpen);
  chip?.setAttribute("aria-expanded", String(!isOpen));
}

function closeScheduleDropdown() {
  const dropdown = document.getElementById("scheduleDropdown");
  const chip = document.getElementById("scheduleChip");
  dropdown?.classList.remove("open");
  chip?.setAttribute("aria-expanded", "false");
}

function showOfflineBanner(show) {
  const banner = document.getElementById("offlineBanner");
  if (!banner) return;
  if (show) banner.classList.remove("is-hidden");
  else banner.classList.add("is-hidden");
}

async function initializeApplication() {
  await initStore();
  initSyncControls();
  updateUserDisplay();
  if (!currentUser) { clearShiftSession(); showLogin(); } else {
    hideLogin();
    await refreshServerData({ silent: true });
    startLiveSync();
    showView("dashboard");
  }
  renderCategories();
  filterDrugs();
  renderCart();
  renderHeld();
  applySidebarState();
  applyReceiptSettings();
  updateNotificationBadge();
  renderHistory();
  renderReferenceCategories();
  renderReference();
  renderInventoryAdmin();
  renderPatientProfiles();
  renderSettingsView();
  renderSyncBackupView();
  updateDashboard();
  updateSummary();
  updateClock();
  updateThemeToggle();
  startShiftTimer();
  updateScheduleChip();
  setInterval(updateClock, 60000);
  document.getElementById("referenceSearch").addEventListener("input", renderReference);
  setHistoryFilter(historyFilterType);
  setSummaryFilter(summaryFilterType);

  document.getElementById("inventorySearch").addEventListener("input", renderInventoryAdmin);
  document.getElementById("referenceCat").addEventListener("change", renderReference);
  applyDataRetentionPolicy();
  runAutoBackupCheck();
  checkBackupReminder();
  async function checkServerOnline() {
    if (!hasApiServer()) { showOfflineBanner(!navigator.onLine); return; }
    try { await apiGet("/health", {}, { branch: null }); showOfflineBanner(false); }
    catch { showOfflineBanner(true); }
  }
  checkServerOnline();
  window.addEventListener("offline", checkServerOnline);
  window.addEventListener("online", checkServerOnline);
  // #6 Position nav pill after initial render
  requestAnimationFrame(() => { if (typeof positionNavPill === "function") positionNavPill(); });
  // #7 Handle initial URL hash for browser history
  const initialHash = location.hash.replace("#", "");
  if (initialHash && typeof VIEW_LABELS !== "undefined" && VIEW_LABELS[initialHash]) {
    window._skipHistoryPush = true;
    showView(initialHash);
    window._skipHistoryPush = false;
  }
  document.addEventListener("click", event => {
    resetInactivityTimer();
    if (!event.target.closest(".nav-menu")) closeNavMenus();
    if (!event.target.closest(".topbar-branch-control")) closeBranchDropdown();
    if (!event.target.closest(".notification-menu")) closeNotificationsDropdown();
    if (!event.target.closest(".schedule-chip-wrapper")) closeScheduleDropdown();
    // #8 Close shortcut overlay on outside click
    if (!event.target.closest(".shortcut-panel")) closeShortcutOverlay();
  });
  document.addEventListener("keydown", resetInactivityTimer);
  document.addEventListener("mousemove", resetInactivityTimer);
  document.addEventListener("touchstart", resetInactivityTimer);
  resetInactivityTimer();
  document.querySelectorAll("#referenceTable th[data-col]").forEach(th => {
    th.addEventListener("click", () => {
      const col = Number(th.dataset.col);
      if (referenceSortCol === col) referenceSortAsc = !referenceSortAsc;
      else { referenceSortCol = col; referenceSortAsc = true; }
      renderReference();
    });
  });
}

window.addEventListener("beforeunload", handleAppClose);
window.addEventListener("unload", handleAppClose);
