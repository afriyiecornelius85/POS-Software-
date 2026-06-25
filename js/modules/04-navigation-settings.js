// #5 Breadcrumb labels for each view
const VIEW_LABELS = {
  dashboard: "Dashboard", pos: "Point of Sale", receipt: "Receipt",
  held: "Held Sales", returns: "Returns", notifications: "Notifications",
  patients: "Patients & Customers", history: "Sales History", summary: "Reports",
  reference: "Drug Reference", settings: "Settings", sync: "Sync & Backup",
  admin: "Inventory", "shift-log": "Shift Log", purchases: "Purchases & GRN",
  lowstock: "Low Stock", expiry: "Expiry Management"
};

function showView(view) {
  closeNavMenus();
  const requiredPermission = VIEW_PERMISSIONS[view];
  if (requiredPermission && !hasPermission(requiredPermission)) {
    const message = requiredPermission === "viewPurchases" || requiredPermission === "viewHistory"
      ? "Pharmacist or manager access required"
      : "Manager access required";
    showToast(message, 2500, "error");
    view = "pos";
  }
  const navView = ({
    receipt: "pos",
    held: "pos",
    returns: "returns",
    notifications: "",
    lowstock: "admin",
    expiry: "admin",
    summary: "reports",
    history: "reports",
    reference: "reference",
    "shift-log": "reports",
    settings: "settings",
    sync: "sync"
  }[view]) || view;
  document.querySelectorAll(".nav-btn,.nav-menu-item,.sidebar-subnav-btn").forEach(btn => btn.classList.toggle("active", btn.id === `nav-${navView}`));
  updatePosWorkflowTabs(view);
  document.getElementById("view-dashboard").classList.toggle("active", view === "dashboard");
  // #1 POS view: set display AND active class so CSS animation fires
  const posEl = document.getElementById("view-pos");
  posEl.style.display = view === "pos" ? "grid" : "none";
  posEl.classList.toggle("active", view === "pos");
  document.getElementById("view-receipt").classList.toggle("active", view === "receipt");
  document.getElementById("view-held").classList.toggle("active", view === "held");
  document.getElementById("view-returns")?.classList.toggle("active", view === "returns");
  document.getElementById("view-notifications")?.classList.toggle("active", view === "notifications");
  document.getElementById("view-patients").classList.toggle("active", view === "patients");
  document.getElementById("view-history").classList.toggle("active", view === "history");
  document.getElementById("view-summary").classList.toggle("active", view === "summary");
  document.getElementById("view-reference").classList.toggle("active", view === "reference");
  document.getElementById("view-settings")?.classList.toggle("active", view === "settings");
  document.getElementById("view-sync")?.classList.toggle("active", view === "sync");
  document.getElementById("view-admin").classList.toggle("active", view === "admin");
  document.getElementById("view-shift-log").classList.toggle("active", view === "shift-log");
  document.getElementById("view-purchases").classList.toggle("active", view === "purchases");
  document.getElementById("view-lowstock").classList.toggle("active", view === "lowstock");
  document.getElementById("view-expiry").classList.toggle("active", view === "expiry");
  if (view === "held") renderHeld();
  if (view === "returns") renderReturnsView();
  if (view === "notifications") renderNotifications();
  if (view === "dashboard") updateDashboard();
  if (view === "patients") {
    document.getElementById("view-patients")?.classList.remove("has-focused-subsection");
    document.querySelectorAll("#view-patients .patient-panel.is-active").forEach(panel => panel.classList.remove("is-active"));
    renderPatientProfiles();
  }
  if (view === "history") renderHistory();
  if (view === "summary") updateSummary();
  if (view === "shift-log") renderShiftLog();
  if (view === "reference") renderReference();
  if (view === "settings") renderSettingsView();
  if (view === "sync") renderSyncBackupView();
  if (view === "admin") { renderInventoryAdmin(); renderStockTransferForm(); }
  if (view === "purchases") renderPurchaseView();
  if (view === "expiry") renderExpiryView();
  applyWorkspaceSectionForView(view);
  updateSidebarNavigation(view);
  // #5 Breadcrumb update
  const bcEl = document.getElementById("topbarBreadcrumbView");
  if (bcEl) bcEl.textContent = VIEW_LABELS[view] || view;
  // #7 Browser history
  if (!window._skipHistoryPush) {
    try { history.pushState({ view }, "", "#" + view); } catch (_) {}
  }
  // #6 Animate nav pill to active button
  requestAnimationFrame(() => positionNavPill());
}

// #6 Position the sliding nav pill over the active nav button
function positionNavPill() {
  const pill = document.getElementById("navPillIndicator");
  if (!pill) return;
  const activeBtn = document.querySelector(".sidebar-nav-group .nav-btn.active");
  if (!activeBtn) { pill.style.opacity = "0"; return; }
  const container = pill.parentElement;
  if (!container) return;
  const containerRect = container.getBoundingClientRect();
  const btnRect = activeBtn.getBoundingClientRect();
  const newTop = Math.round(btnRect.top - containerRect.top + container.scrollTop);
  const oldTop = parseFloat(pill.style.top);
  const isFirstPlace = pill.style.opacity === "0" || pill.style.top === "";
  const isLargeJump = !isFirstPlace && Math.abs(newTop - oldTop) > 56;
  if (isFirstPlace || isLargeJump) {
    // Snap to position without animation to prevent sliding ghost
    pill.style.transition = "none";
    pill.style.top = newTop + "px";
    pill.style.height = Math.round(btnRect.height) + "px";
    pill.style.left = "0";
    pill.style.right = "0";
    pill.style.opacity = "1";
    // Re-enable transition after placement
    requestAnimationFrame(() => { pill.style.transition = ""; });
  } else {
    pill.style.top = newTop + "px";
    pill.style.height = Math.round(btnRect.height) + "px";
    pill.style.left = "0";
    pill.style.right = "0";
    pill.style.opacity = "1";
  }
}

// #7 Handle browser back/forward
window.addEventListener("popstate", event => {
  const view = event.state?.view || "dashboard";
  window._skipHistoryPush = true;
  showView(view);
  window._skipHistoryPush = false;
});

// #2 Position the sub-section sliding pill over the active subnav button
function positionSubnavPill(navGroup) {
  const subnav = navGroup?.querySelector(".sidebar-subnav");
  if (!subnav) return;
  let pill = subnav.querySelector(".subnav-pill-indicator");
  if (!pill) {
    pill = document.createElement("div");
    pill.className = "subnav-pill-indicator";
    subnav.insertBefore(pill, subnav.firstChild);
  }
  const activeBtn = subnav.querySelector(".sidebar-subnav-btn.active");
  if (!activeBtn) { pill.style.opacity = "0"; return; }
  const navRect = subnav.getBoundingClientRect();
  const btnRect = activeBtn.getBoundingClientRect();
  const newTop = Math.round(btnRect.top - navRect.top + subnav.scrollTop);
  const oldTop = parseFloat(pill.style.top);
  const isFirstPlace = pill.style.opacity === "0" || pill.style.top === "";
  if (isFirstPlace) {
    pill.style.transition = "none";
    pill.style.top = newTop + "px";
    pill.style.height = Math.round(btnRect.height) + "px";
    pill.style.left = "0";
    pill.style.right = "0";
    pill.style.opacity = "1";
    requestAnimationFrame(() => { pill.style.transition = ""; });
  } else {
    pill.style.top = newTop + "px";
    pill.style.height = Math.round(btnRect.height) + "px";
    pill.style.left = "0";
    pill.style.right = "0";
    pill.style.opacity = "1";
  }
}

// Hide all subnav pills (called when subnav groups close)
function hideSubnavPills() {
  document.querySelectorAll(".subnav-pill-indicator").forEach(p => { p.style.opacity = "0"; });
}

function showReportsHome() {
  showView("summary");
}

function showSyncBackup() {
  showWorkspaceSection("sync", activeWorkspaceSections.sync || "server");
}

function updatePosWorkflowTabs(view) {
  document.getElementById("posCurrentSaleTab")?.classList.toggle("active", view === "pos");
  document.getElementById("posHeldSaleTab")?.classList.toggle("active", view === "held");
}

function applySidebarState(collapsed = loadFromStorage(SIDEBAR_COLLAPSED_KEY, false)) {
  const shell = document.querySelector(".app-shell");
  const sidebar = document.querySelector(".app-sidebar");
  const button = document.getElementById("sidebarCollapseBtn");
  shell?.classList.toggle("sidebar-collapsed", !!collapsed);
  sidebar?.classList.toggle("is-collapsed", !!collapsed);
  if (button) {
    button.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
    button.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
    const icon = button.querySelector("i");
    if (icon) icon.className = collapsed ? "ti ti-chevron-right" : "ti ti-chevron-left";
  }
}

function toggleSidebar() {
  const shell = document.querySelector(".app-shell");
  const next = !shell?.classList.contains("sidebar-collapsed");
  saveToStorage(SIDEBAR_COLLAPSED_KEY, next);
  applySidebarState(next);
}

function getNotificationItems() {
  const branchId = getDashboardBranchId();
  const lowStock = getLowStockItemsForBranch(branchId);
  const expiryAlerts = getExpiryAlertsForBranch(branchId);
  const refillAlerts = getPatientRefillAlerts(branchId);
  const visibleDrafts = getRecordsForBranch(draftPurchaseOrders, branchId);
  const visibleHeld = getRecordsForBranch(heldSales, branchId);
  const lastBackupAt = loadFromStorage(STORAGE_KEYS.lastFullBackup, null);
  const lastBackupTime = lastBackupAt ? new Date(lastBackupAt).getTime() : 0;
  const backupDays = getBackupReminderDays();
  const backupStale = hasPermission("exportBackup") && (!lastBackupTime || (Date.now() - lastBackupTime) >= backupDays * 86400000);
  return [
    {
      tone: "expiring",
      icon: "ti-calendar-event",
      title: "Expiring Soon",
      message: `${expiryAlerts.length} product${expiryAlerts.length === 1 ? "" : "s"} require expiry review within 30 days`,
      count: expiryAlerts.length,
      action: "showView('expiry')",
      actionLabel: "Open expiry",
      actionable: expiryAlerts.length > 0
    },
    {
      tone: "low",
      icon: "ti-alert-triangle",
      title: "Low Stock",
      message: `${lowStock.length} product${lowStock.length === 1 ? "" : "s"} are below reorder level`,
      count: lowStock.length,
      action: "showLowStockPreview()",
      actionLabel: "Open low stock",
      actionable: lowStock.length > 0
    },
    {
      tone: "refill",
      icon: "ti-refresh",
      title: "Patient Refills",
      message: formatRefillAlertMessage(refillAlerts),
      count: refillAlerts.length,
      action: "openPatientRefillAlerts()",
      actionLabel: "Open patients",
      actionable: refillAlerts.length > 0
    },
    {
      tone: "grn",
      icon: "ti-truck-delivery",
      title: "GRN Pending",
      message: `${visibleDrafts.length} draft GRN${visibleDrafts.length === 1 ? "" : "s"} are waiting for stock receiving`,
      count: visibleDrafts.length,
      action: "showWorkspaceSection('purchases','grn')",
      actionLabel: "Open GRN",
      actionable: visibleDrafts.length > 0
    },
    {
      tone: visibleHeld.length ? "held" : "sync",
      icon: "ti-clock",
      title: "Held Sales",
      message: `${visibleHeld.length} held sale${visibleHeld.length === 1 ? "" : "s"} can be restored at POS`,
      count: visibleHeld.length,
      action: "showView('held')",
      actionLabel: "Open held sales",
      actionable: visibleHeld.length > 0
    },
    {
      tone: hasApiServer() ? "sync" : "low",
      icon: hasApiServer() ? "ti-cloud" : "ti-cloud-off",
      title: "Sync Status",
      message: hasApiServer() ? "Branch sync server is configured" : "Browser storage only",
      count: hasApiServer() ? "-" : "!",
      action: "showSyncBackup()",
      actionLabel: "Open sync",
      actionable: !hasApiServer()
    },
    {
      tone: backupStale ? "expiring" : "sync",
      icon: "ti-database",
      title: "Backup",
      message: backupStale ? `No full backup exported in ${backupDays} days` : "Backup reminder is clear",
      count: backupStale ? "!" : "-",
      action: "showSyncBackup()",
      actionLabel: "Open backup",
      actionable: backupStale
    }
  ];
}

function updateNotificationBadge() {
  const actionableCount = getNotificationItems().filter(item => item.actionable).length;
  const badge = document.getElementById("notificationBadge");
  if (!badge) return;
  badge.textContent = String(actionableCount);
  badge.classList.toggle("is-hidden", actionableCount === 0);
  renderNotificationDropdown();
}

function toggleNotificationsDropdown(event) {
  event?.stopPropagation();
  const menu = document.getElementById("notificationMenu");
  const trigger = menu?.querySelector(".notification-btn");
  const open = !menu?.classList.contains("open");
  if (open) renderNotificationDropdown();
  menu?.classList.toggle("open", open);
  trigger?.setAttribute("aria-expanded", String(open));
}

function closeNotificationsDropdown() {
  const menu = document.getElementById("notificationMenu");
  const trigger = menu?.querySelector(".notification-btn");
  menu?.classList.remove("open");
  trigger?.setAttribute("aria-expanded", "false");
}

function renderNotificationDropdown() {
  const list = document.getElementById("notificationDropdownList");
  const updated = document.getElementById("notificationDropdownUpdated");
  if (!list) return;
  const items = getNotificationItems();
  if (updated) updated.textContent = new Date().toLocaleTimeString("en-GH", { hour: "2-digit", minute: "2-digit" });
  const actionable = items.filter(item => item.actionable);
  const rows = actionable.length ? actionable : items.slice(0, 4);
  renderHtml(list, rows.map(item => `
    <button type="button" class="notification-feed-item notification-${item.tone}" onclick="closeNotificationsDropdown();${item.action}">
      <span class="notification-feed-icon"><i class="ti ${item.icon}"></i></span>
      <span class="notification-feed-copy">
        <strong>${sanitize(item.title)}</strong>
        <small>${sanitize(item.message)}</small>
      </span>
      <span class="notification-feed-count">${sanitize(String(item.count))}</span>
    </button>
  `).join(""));
}

function renderNotifications() {
  const summary = document.getElementById("notificationSummaryCards");
  const list = document.getElementById("notificationList");
  const updated = document.getElementById("notificationLastUpdated");
  const items = getNotificationItems();
  updateNotificationBadge();
  if (updated) updated.textContent = `Updated ${new Date().toLocaleTimeString("en-GH", { hour: "2-digit", minute: "2-digit" })}`;
  if (summary) {
    renderHtml(summary, items.slice(0, 4).map(item => `
      <button class="notification-summary-card notification-${item.tone}" onclick="${item.action}">
        <i class="ti ${item.icon}"></i>
        <span>${sanitize(item.title)}</span>
        <strong>${sanitize(String(item.count))}</strong>
      </button>
    `).join(""));
  }
  if (!list) return;
  renderHtml(list, items.map(item => `
    <button class="notification-feed-item notification-${item.tone}" onclick="${item.action}">
      <span class="notification-feed-icon"><i class="ti ${item.icon}"></i></span>
      <span class="notification-feed-copy">
        <strong>${sanitize(item.title)}</strong>
        <small>${sanitize(item.message)}</small>
      </span>
      <span class="notification-feed-count">${sanitize(String(item.count))}</span>
    </button>
  `).join(""));
}

function renderSettingsView() {
  const settings = getAppSettings();
  const currentBranchName = getCurrentBranchName();
  const allowedBranches = getSelectableBranchRecords();
  const visibleAudit = getScopedRecords(auditLog).slice().reverse().slice(0, 6);
  setText("settingsProfileBranch", currentBranchName);
  setText("settingsCurrentUser", currentUser ? `${currentUser.name} - ${currentUser.role || "staff"}` : "Guest");
  const directorMode = String(currentUser?.role || "").toLowerCase() === "director";
  setText("settingsBranchAccess", directorMode
    ? `${allowedBranches.length} branch${allowedBranches.length === 1 ? "" : "es"}`
    : "Director-only administration");
  setText("settingsAuditCount", `${visibleAudit.length} recent record${visibleAudit.length === 1 ? "" : "s"}`);
  const pharmacyName = document.getElementById("settingsPharmacyName");
  const pharmacyPhone = document.getElementById("settingsPharmacyPhone");
  const receiptFooter = document.getElementById("settingsReceiptFooter");
  const lowStockDefault = document.getElementById("settingsLowStockDefault");
  const backupCadence = document.getElementById("settingsBackupCadence");
  const inactivityMinutes = document.getElementById("settingsInactivityMinutes");
  const dataRetentionMonths = document.getElementById("settingsDataRetentionMonths");
  const autoBackupEnabled = document.getElementById("settingsAutoBackupEnabled");
  if (pharmacyName) pharmacyName.value = settings.pharmacyName;
  if (pharmacyPhone) pharmacyPhone.value = settings.pharmacyPhone;
  if (receiptFooter) receiptFooter.value = settings.receiptFooter;
  if (lowStockDefault) lowStockDefault.value = getOperationalLowStockDefault();
  if (backupCadence) backupCadence.value = getBackupReminderDays();
  if (inactivityMinutes) inactivityMinutes.value = parseInt(settings.inactivityMinutes, 10) || DEFAULT_APP_SETTINGS.inactivityMinutes;
  if (dataRetentionMonths) dataRetentionMonths.value = getDataRetentionMonths();
  if (autoBackupEnabled) autoBackupEnabled.checked = settings.autoBackupEnabled !== false;

  const printerType = document.getElementById("settingsPrinterType");
  const paperWidth = document.getElementById("settingsPaperWidth");
  if (printerType) printerType.value = settings.receiptPrinterType || "browser";
  if (paperWidth) paperWidth.value = String(settings.receiptPaperWidth || "80");
  ["Logo", "Branch", "Customer"].forEach(key => {
    const input = document.getElementById(`settingsReceiptShow${key}`);
    if (input) input.checked = settings[`receiptShow${key}`] !== false;
  });

  const schedule = getShiftSchedule();
  const morning = schedule.find(shift => shift.name === "Morning") || schedule[0] || DEFAULT_SHIFT_SCHEDULE[0];
  const afternoon = schedule.find(shift => shift.name === "Afternoon") || schedule[1] || DEFAULT_SHIFT_SCHEDULE[1];
  const shiftInputs = {
    settingsMorningStart: morning.start,
    settingsMorningEnd: morning.end,
    settingsAfternoonStart: afternoon.start,
    settingsAfternoonEnd: afternoon.end
  };
  Object.entries(shiftInputs).forEach(([id, value]) => {
    const input = document.getElementById(id);
    if (input) input.value = value;
  });

  renderUserEditorBranchOptions();
  renderRolePermissionsEditor();
  renderCategoryThresholdEditor();
  const branchSection = document.querySelector('[data-subsection="branches"]');
  branchSection?.querySelectorAll("input, button").forEach(control => {
    control.disabled = !directorMode;
  });

  const usersList = document.getElementById("settingsUsersList");
  if (usersList) {
    renderHtml(usersList, userProfiles.length ? userProfiles.map(user => `
      <button type="button" class="settings-list-row settings-list-button" data-key="user-${sanitize(user.username || "")}" data-username="${sanitize(user.username || "")}" onclick="editUserFromSettings(this.dataset.username)">
        <span><strong>${sanitize(user.name || user.username)}</strong><small>${sanitize(user.username || "--")}</small></span>
        <b>${sanitize(user.role || "staff")}</b>
      </button>
    `).join("") : `<div class="empty-cart"><i class="ti ti-users"></i><div>No user profiles loaded</div></div>`);
  }

  const branchesList = document.getElementById("settingsBranchesList");
  if (branchesList) {
    renderHtml(branchesList, branchRecords.map(branch => `
      <button type="button" class="settings-list-row settings-list-button" data-key="branch-${sanitize(branch.id)}" data-branch-id="${sanitize(branch.id)}" onclick="editBranchFromSettings(this.dataset.branchId)">
        <span><strong>${sanitize(branch.name)}</strong><small>${sanitize(getDashboardBranchCode(branch.id, branch.name))}</small></span>
        <b>${branch.id === getCurrentBranchId() ? "Active" : "Branch"}</b>
      </button>
    `).join(""));
  }

  const auditPreview = document.getElementById("settingsAuditPreview");
  if (auditPreview) {
    renderHtml(auditPreview, visibleAudit.length ? visibleAudit.map(entry => `
      <div class="settings-list-row" data-key="${sanitize(entry.id || entry.timestamp || entry.createdAt)}">
        <span><strong>${sanitize(entry.action || entry.type || "Activity")}</strong><small>${sanitize(entry.details || entry.message || entry.branch || "--")}</small></span>
        <b>${sanitize(formatDashboardTime(entry.date || entry.timestamp || entry.createdAt))}</b>
      </div>
    `).join("") : `<div class="empty-cart"><i class="ti ti-list-check"></i><div>No admin activity recorded</div></div>`);
  }
}

function renderUserEditorBranchOptions() {
  const branchSelect = document.getElementById("settingsUserBranch");
  const branchesContainer = document.getElementById("settingsUserBranches");
  const options = branchRecords.map(branch => `<option value="${sanitize(branch.id)}">${sanitize(branch.name)}</option>`).join("");
  if (branchSelect) renderHtml(branchSelect, options);
  if (branchesContainer) {
    renderHtml(branchesContainer, branchRecords.map(branch =>
      `<label class="branch-checkbox-item"><input type="checkbox" name="allowedBranch" value="${sanitize(branch.id)}" /> ${sanitize(branch.name)}</label>`
    ).join(""));
  }
}

function clearUserEditor() {
  ["settingsUserUsername", "settingsUserName", "settingsUserPassword"].forEach(id => {
    const input = document.getElementById(id);
    if (input) input.value = "";
  });
  const role = document.getElementById("settingsUserRole");
  if (role) role.value = "worker";
  const branch = document.getElementById("settingsUserBranch");
  if (branch) branch.value = getCurrentBranchId();
  const branchesContainer = document.getElementById("settingsUserBranches");
  if (branchesContainer) {
    const currentBranchId = getCurrentBranchId();
    branchesContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = cb.value === currentBranchId; });
  }
}

function editUserFromSettings(username) {
  const user = getUserProfile(username);
  if (!user) return;
  document.getElementById("settingsUserUsername").value = user.username || "";
  document.getElementById("settingsUserName").value = user.name || "";
  document.getElementById("settingsUserPassword").value = "";
  document.getElementById("settingsUserRole").value = user.role || "worker";
  const allowed = collectUserBranchIds(user);
  const defaultBranch = normalizeBranchId(user.branch_id || user.branchId || user.branch) || allowed[0] || getCurrentBranchId();
  document.getElementById("settingsUserBranch").value = defaultBranch;
  const branchesContainer = document.getElementById("settingsUserBranches");
  if (branchesContainer) {
    branchesContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = allowed.includes(cb.value) || cb.value === defaultBranch; });
  }
}

async function saveUserFromSettings() {
  if (!requirePermission("managerAccess", "Manager access required to edit users")) return;
  const username = document.getElementById("settingsUserUsername")?.value.trim().toLowerCase();
  const name = document.getElementById("settingsUserName")?.value.trim();
  const passwordInput = document.getElementById("settingsUserPassword");
  const password = passwordInput?.value || "";
  const role = document.getElementById("settingsUserRole")?.value || "worker";
  const defaultBranchId = normalizeBranchId(document.getElementById("settingsUserBranch")?.value) || getCurrentBranchId();
  const branchesContainer = document.getElementById("settingsUserBranches");
  const allowed = branchesContainer ? Array.from(branchesContainer.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value).filter(Boolean) : [];
  const branchIds = [...new Set([defaultBranchId, ...allowed])];
  if (!username) return showToast("Username is required", 2500, "error");
  if (!name) return showToast("Name is required", 2500, "error");
  const existing = getUserProfile(username);
  if (!existing && !password) return showToast("Password is required for a new user", 2500, "error");
  if (password && password.length < 10) return showToast("Password must be at least 10 characters", 3000, "error");
  if (password && new TextEncoder().encode(password).length > 72) return showToast("Password must be at most 72 UTF-8 bytes", 3000, "error");
  if (!hasApiServer()) return showToast("A secure sync server is required to save users", 3000, "error");
  const userInput = {
    ...userProfileForServer(existing || {}),
    username,
    name,
    role,
    branch_id: defaultBranchId,
    branchId: defaultBranchId,
    branch: getBranchNameById(defaultBranchId),
    branch_ids: branchIds,
    branchIds: branchIds,
    branches: branchIds.map(getBranchNameById)
  };
  if (passwordInput) passwordInput.value = "";
  let serverUser = null;
  try {
    serverUser = await apiPost("/users", { user: userInput, password }, { branch: "all" });
  } catch (error) {
    console.warn(error);
    return showToast(error.message || "User could not be saved", 3500, "error");
  }
  let offlineCredential = existing?.offlineCredential || null;
  if (password) {
    try {
      offlineCredential = await createOfflineCredential(password);
    } catch (error) {
      console.warn("Could not create the offline user credential", error);
    }
  }
  const user = sanitizeLocalUser({
    ...userInput,
    ...serverUser,
    ...(offlineCredential ? { offlineCredential } : {})
  });
  const index = userProfiles.findIndex(item => String(item.username || "").toLowerCase() === username);
  if (index >= 0) userProfiles[index] = user;
  else userProfiles.push(user);
  saveUserProfiles();
  if (currentUser?.username === username) {
    currentUser = normalizeUserBranch(user);
    saveToStorage(STORAGE_KEYS.user, currentUser);
    updateUserDisplay();
  }
  renderSettingsView();
  recordAudit("user-save", `Saved user ${username}`);
  showToast("User saved");
}

async function deleteSelectedUser() {
  if (!requirePermission("managerAccess", "Manager access required to delete users")) return;
  const username = document.getElementById("settingsUserUsername")?.value.trim().toLowerCase();
  if (!username) return showToast("Select a user first", 2500, "warning");
  if (currentUser?.username === username) return showToast("You cannot delete the signed-in user", 2500, "error");
  if (!hasApiServer()) return showToast("A secure sync server is required to delete users", 3000, "error");
  try {
    await apiDelete("/users", { username }, { branch: "all" });
  } catch (error) {
    console.warn(error);
    return showToast(error.message || "User could not be deleted", 3500, "error");
  }
  const before = userProfiles.length;
  userProfiles = userProfiles.filter(user => String(user.username || "").toLowerCase() !== username);
  if (userProfiles.length === before) return showToast("User not found", 2500, "error");
  saveUserProfiles();
  clearUserEditor();
  renderSettingsView();
  recordAudit("user-delete", `Deleted user ${username}`);
  showToast("User deleted");
}

function clearBranchEditor() {
  const id = document.getElementById("settingsBranchId");
  const name = document.getElementById("settingsBranchName");
  if (id) id.value = "";
  if (name) name.value = "";
}

function editBranchFromSettings(branchId) {
  const branch = getBranchById(branchId);
  if (!branch) return;
  document.getElementById("settingsBranchId").value = branch.id;
  document.getElementById("settingsBranchName").value = branch.name;
}

async function saveBranchFromSettings() {
  if (String(currentUser?.role || "").toLowerCase() !== "director") {
    return showToast("Only a director can edit branches", 3000, "error");
  }
  const rawId = document.getElementById("settingsBranchId")?.value.trim();
  const name = document.getElementById("settingsBranchName")?.value.trim();
  if (!name) return showToast("Branch name is required", 2500, "error");
  const id = slugifyBranchId(rawId || name);
  const existing = getBranchById(id);
  const oldName = existing?.name || "";
  const branch = { id, name };
  if (!hasApiServer()) return showToast("A secure sync server is required to save branches", 3000, "error");
  try {
    await apiPost("/branches", { branch }, { branch: null });
  } catch (error) {
    console.warn(error);
    return showToast(error.message || "Branch could not be saved", 3500, "error");
  }
  const index = branchRecords.findIndex(item => item.id === id);
  if (index >= 0) branchRecords[index] = branch;
  else branchRecords.push(branch);
  refreshBranchNames();
  if (oldName && oldName !== name) {
    drugs.forEach(drug => {
      if (drug.branchStock && Object.prototype.hasOwnProperty.call(drug.branchStock, oldName)) {
        drug.branchStock[name] = drug.branchStock[oldName];
        delete drug.branchStock[oldName];
      }
      if (drug.branchAvailability && Object.prototype.hasOwnProperty.call(drug.branchAvailability, oldName)) {
        drug.branchAvailability[name] = drug.branchAvailability[oldName];
        delete drug.branchAvailability[oldName];
      }
    });
    [...userProfiles, ...customers, ...salesHistory, ...purchaseHistory, ...auditLog, ...heldSales, ...stockAdjustments].forEach(record => {
      if (record.branch_id === id || record.branchId === id || record.branch === oldName) record.branch = name;
      if (Array.isArray(record.branches)) record.branches = record.branches.map(branchName => branchName === oldName ? name : branchName);
    });
  }
  drugs.forEach(drug => {
    drug.branchStock = drug.branchStock || {};
    ensureDrugBranchAvailability(drug);
    if (drug.branchStock[name] == null) drug.branchStock[name] = 0;
    if (drug.branchAvailability[name] == null) drug.branchAvailability[name] = true;
  });
  saveBranchRecords();
  saveDrugs();
  saveCustomers();
  saveUserProfiles();
  initBranchSelect();
  renderSettingsView();
  recordAudit("branch-save", `Saved branch ${name}`);
  showToast("Branch saved");
}

async function deleteSelectedBranch() {
  if (String(currentUser?.role || "").toLowerCase() !== "director") {
    return showToast("Only a director can delete branches", 3000, "error");
  }
  const branchId = normalizeBranchId(document.getElementById("settingsBranchId")?.value);
  if (!branchId) return showToast("Select a branch first", 2500, "warning");
  if (branchRecords.length <= 1) return showToast("At least one branch is required", 2500, "error");
  const inUse = [currentUser, ...userProfiles, ...customers, ...salesHistory, ...purchaseHistory, ...heldSales]
    .filter(Boolean)
    .some(record => collectUserBranchIds(record).includes(branchId) || getRecordBranchId(record) === branchId);
  if (inUse) return showToast("Branch is in use and cannot be deleted", 3000, "error");
  const branch = getBranchById(branchId);
  if (!hasApiServer()) return showToast("A secure sync server is required to delete branches", 3000, "error");
  try {
    await apiDelete("/branches", { id: branchId }, { branch: null });
  } catch (error) {
    console.warn(error);
    return showToast(error.message || "Branch could not be deleted", 3500, "error");
  }
  branchRecords = branchRecords.filter(item => item.id !== branchId);
  drugs.forEach(drug => {
    if (branch?.name && drug.branchStock) delete drug.branchStock[branch.name];
    if (branch?.name && drug.branchAvailability) delete drug.branchAvailability[branch.name];
    drug.batches = normalizeDrugBatches(drug).filter(batch => batch.branch_id !== branchId);
  });
  saveBranchRecords();
  saveDrugs();
  clearBranchEditor();
  initBranchSelect();
  renderSettingsView();
  recordAudit("branch-delete", `Deleted branch ${branch?.name || branchId}`);
  showToast("Branch deleted");
}

function renderRolePermissionsEditor() {
  const target = document.getElementById("rolePermissionsEditor");
  if (!target) return;
  const roles = ["cashier", "worker", "pharmacist", "manager", "director"];
  const canEdit = String(currentUser?.role || "").toLowerCase() === "director" && hasApiServer() && !!getSessionToken();
  renderHtml(target, `
    <div class="role-permission-row role-permission-head">
      <span>Permission</span>
      ${roles.map(role => `<b>${sanitize(role)}</b>`).join("")}
    </div>
    ${Object.keys(DEFAULT_ROLE_PERMISSIONS).map(permission => {
      const allowed = getPermissionRoles(permission);
      return `
        <div class="role-permission-row">
          <span>${sanitize(permission.replace(/([A-Z])/g, " $1").replace(/[-_]/g, " "))}</span>
          ${roles.map(role => `<label><input type="checkbox" data-permission="${sanitize(permission)}" data-role="${sanitize(role)}" ${allowed.includes(role) ? "checked" : ""} ${canEdit ? "" : "disabled"} /></label>`).join("")}
        </div>
      `;
    }).join("")}
    <small>${canEdit ? "Changes are saved to the server and apply to active sessions immediately." : "Only a signed-in director can edit role permissions."}</small>
  `);
  const saveButton = document.getElementById("saveRolePermissionsButton");
  if (saveButton) {
    saveButton.disabled = !canEdit;
    renderHtml(saveButton, canEdit
      ? '<i class="ti ti-device-floppy"></i> Save role permissions'
      : '<i class="ti ti-lock"></i> Director access required');
  }
}

async function saveRolePermissionsSettings() {
  if (String(currentUser?.role || "").toLowerCase() !== "director") {
    return showToast("Only a director can edit role permissions", 3000, "error");
  }
  if (!hasApiServer() || !getSessionToken()) {
    return showToast("A secure server session is required to edit permissions", 3000, "error");
  }
  const permissions = Object.fromEntries(Object.keys(DEFAULT_ROLE_PERMISSIONS).map(permission => {
    const roles = [...document.querySelectorAll(`input[data-permission="${permission}"]:checked`)]
      .map(input => String(input.dataset.role || "").toLowerCase());
    return [permission, roles];
  }));
  try {
    const response = await apiPost("/role-permissions", { permissions }, { branch: null });
    applyRolePermissions(response);
    updateUserDisplay();
    renderRolePermissionsEditor();
    showToast("Role permissions saved and enforced by the server", 3000, "success");
  } catch (error) {
    console.warn(error);
    showToast(error.message || "Role permissions could not be saved", 3500, "error");
  }
}

function renderCategoryThresholdEditor() {
  const target = document.getElementById("settingsCategoryThresholds");
  if (!target) return;
  const overrides = getCategoryLowStockOverrides();
  const categories = [...new Set(drugs.map(drug => drug.cat || "Uncategorized"))].sort();
  renderHtml(target, categories.map(cat => `
    <div class="settings-list-row">
      <span><strong>${sanitize(cat)}</strong><small>Blank uses default</small></span>
      <input class="category-threshold-input" data-category="${sanitize(cat)}" type="number" min="1" step="1" value="${sanitize(overrides[cat] ?? "")}" placeholder="${getOperationalLowStockDefault()}" />
    </div>
  `).join(""));
}

function saveCategoryThresholdSettings() {
  if (!requirePermission("managerAccess", "Manager access required to edit thresholds")) return;
  const overrides = {};
  document.querySelectorAll(".category-threshold-input").forEach(input => {
    const value = parseInt(input.value, 10);
    if (Number.isFinite(value) && value > 0) overrides[input.dataset.category] = value;
  });
  saveAppSettings({ categoryLowStock: overrides });
  updateLowStockBadge();
  updateDashboard();
  renderSettingsView();
  recordAudit("thresholds-update", "Updated category low-stock thresholds");
  showToast("Category thresholds saved");
}

async function changePassword() {
  const currentPassword = document.getElementById("settingsCurrentPassword")?.value || "";
  const newPassword = document.getElementById("settingsNewPassword")?.value || "";
  const confirmPassword = document.getElementById("settingsConfirmPassword")?.value || "";
  const errorEl = document.getElementById("changePasswordError");
  const showError = msg => { if (errorEl) { errorEl.textContent = msg; errorEl.style.display = "block"; } };
  if (errorEl) errorEl.style.display = "none";
  if (!currentPassword) return showError("Please enter your current password.");
  if (newPassword.length < 10) return showError("New password must be at least 10 characters.");
  if (newPassword !== confirmPassword) return showError("New password and confirmation do not match.");
  if (!hasApiServer() || !getSessionToken()) return showError("You must be connected to the server to change your password.");
  try {
    await apiPost("/auth/password", { currentPassword, newPassword });
    document.getElementById("settingsCurrentPassword").value = "";
    document.getElementById("settingsNewPassword").value = "";
    document.getElementById("settingsConfirmPassword").value = "";
    if (errorEl) errorEl.style.display = "none";
    showToast("Password changed successfully");
  } catch (err) {
    showError(err.message || "Password change failed.");
  }
}

function saveAdminSettings() {
  if (!requirePermission("managerAccess", "Manager access required to change settings")) return;
  saveAppSettings({
    pharmacyName: document.getElementById("settingsPharmacyName")?.value.trim() || DEFAULT_APP_SETTINGS.pharmacyName,
    pharmacyPhone: document.getElementById("settingsPharmacyPhone")?.value.trim() || DEFAULT_APP_SETTINGS.pharmacyPhone,
    receiptFooter: document.getElementById("settingsReceiptFooter")?.value.trim() || DEFAULT_APP_SETTINGS.receiptFooter
  });
  applyReceiptSettings();
  recordAudit("settings-update", "Updated pharmacy profile settings");
  renderSettingsView();
  showToast("Settings saved");
}

async function saveOperationalSettings() {
  if (!requirePermission("managerAccess", "Manager access required to change settings")) return;
  const lowStockDefault = Math.max(1, parseInt(document.getElementById("settingsLowStockDefault")?.value, 10) || DEFAULT_APP_SETTINGS.lowStockDefault);
  const backupCadenceDays = Math.max(1, parseInt(document.getElementById("settingsBackupCadence")?.value, 10) || DEFAULT_APP_SETTINGS.backupCadenceDays);
  const inactivityMinutes = Math.max(1, parseInt(document.getElementById("settingsInactivityMinutes")?.value, 10) || DEFAULT_APP_SETTINGS.inactivityMinutes);
  const dataRetentionMonths = Math.max(0, parseInt(document.getElementById("settingsDataRetentionMonths")?.value, 10) || 0);
  const autoBackupEnabled = !!document.getElementById("settingsAutoBackupEnabled")?.checked;
  saveAppSettings({ lowStockDefault, backupCadenceDays, inactivityMinutes, dataRetentionMonths, autoBackupEnabled });
  recordAudit("settings-rules", `Updated defaults: reorder ${lowStockDefault}, backup ${backupCadenceDays} days, timeout ${inactivityMinutes} min`);
  updateLowStockBadge();
  updateDashboard();
  resetInactivityTimer();
  await applyDataRetentionPolicy();
  await runAutoBackupCheck();
  renderSettingsView();
  showToast("Operating rules saved");
}

function handleReceiptLogoUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!/^image\/(?:png|jpeg|webp|gif)$/i.test(file.type || "")) {
    event.target.value = "";
    return showToast("Choose a PNG, JPEG, WebP, or GIF image", 3000, "error");
  }
  if (file.size > 1024 * 1024) {
    event.target.value = "";
    return showToast("Receipt logo must be 1 MB or smaller", 3000, "error");
  }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      saveAppSettings({ receiptLogoDataUrl: reader.result || "" });
      applyReceiptSettings();
      showToast("Receipt logo loaded");
    } catch (error) {
      console.warn(error);
      showToast("Receipt logo could not be stored", 3000, "error");
    }
  };
  reader.readAsDataURL(file);
}

function saveReceiptSettings() {
  if (!requirePermission("managerAccess", "Manager access required to change receipt settings")) return;
  saveAppSettings({
    receiptPrinterType: document.getElementById("settingsPrinterType")?.value || "browser",
    receiptPaperWidth: document.getElementById("settingsPaperWidth")?.value || "80",
    receiptShowLogo: !!document.getElementById("settingsReceiptShowLogo")?.checked,
    receiptShowBranch: !!document.getElementById("settingsReceiptShowBranch")?.checked,
    receiptShowCustomer: !!document.getElementById("settingsReceiptShowCustomer")?.checked
  });
  applyReceiptSettings();
  renderSettingsView();
  recordAudit("receipt-settings", "Updated receipt and printer settings");
  showToast("Receipt settings saved");
}

function saveShiftScheduleSettings() {
  if (!requirePermission("managerAccess", "Manager access required to edit shifts")) return;
  const schedule = [
    {
      name: "Morning",
      start: document.getElementById("settingsMorningStart")?.value || DEFAULT_SHIFT_SCHEDULE[0].start,
      end: document.getElementById("settingsMorningEnd")?.value || DEFAULT_SHIFT_SCHEDULE[0].end
    },
    {
      name: "Afternoon",
      start: document.getElementById("settingsAfternoonStart")?.value || DEFAULT_SHIFT_SCHEDULE[1].start,
      end: document.getElementById("settingsAfternoonEnd")?.value || DEFAULT_SHIFT_SCHEDULE[1].end
    }
  ];
  saveAppSettings({ shiftSchedule: schedule });
  setShiftSessionForNow();
  updateShiftTimer();
  updateScheduleChip();
  renderSettingsView();
  recordAudit("shift-settings", "Updated shift schedule");
  showToast("Shift schedule saved");
}

async function applyDataRetentionPolicy() {
  const months = getDataRetentionMonths();
  if (!months) return;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const before = salesHistory.length;
  const nextSales = salesHistory.filter(sale => {
    const date = new Date(sale.date);
    return Number.isNaN(date.getTime()) || date >= cutoff;
  });
  if (nextSales.length === before) return;
  if (!await saveMajorChangeBackup(`Before data retention cleanup (${months} months)`)) return;
  if (hasApiServer() && getSessionToken()) {
    try {
      await apiPost("/sales/retention", { cutoff: cutoff.toISOString() }, { branch: getBranchScope() });
    } catch (error) {
      console.warn(error);
      return showToast("Retention cleanup was not applied because the server update failed", 3500, "error");
    }
  }
  salesHistory = nextSales;
  saveSales();
  updateDashboard();
  updateSummary();
  recordAudit("retention-cleanup", `Removed ${before - nextSales.length} local sale record(s) older than ${months} month(s)`);
}

async function runAutoBackupCheck() {
  const settings = getAppSettings();
  if (settings.autoBackupEnabled === false) return;
  const lastAutoBackup = loadFromStorage(STORAGE_KEYS.lastAutoBackup, null);
  const lastTime = lastAutoBackup ? new Date(lastAutoBackup).getTime() : 0;
  const cadence = getBackupReminderDays();
  if (lastTime && (Date.now() - lastTime) < cadence * 86400000) return;
  const payload = buildFullBackupPayload();
  let encryptedPayload;
  try {
    encryptedPayload = await encryptBackupPayload(payload);
  } catch (error) {
    console.warn("Automatic encrypted backup failed", error);
    return;
  }
  const backups = loadFromStorage(STORAGE_KEYS.autoBackups, []);
  backups.unshift(encryptedPayload);
  if (backups.length > MAX_LOCAL_MAJOR_BACKUPS) backups.splice(MAX_LOCAL_MAJOR_BACKUPS);
  saveToStorage(STORAGE_KEYS.autoBackups, backups);
  saveToStorage(STORAGE_KEYS.lastAutoBackup, payload.exportedAt);
  updateNotificationBadge();
}

function renderSyncBackupView() {
  initSyncControls();
  const lastBackupAt = loadFromStorage(STORAGE_KEYS.lastFullBackup, null);
  const backupText = lastBackupAt
    ? `Last backup ${new Date(lastBackupAt).toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" })}`
    : "No full backup exported";
  setText("syncBackupSummary", backupText);
  setText("syncSnapshotTime", `Updated ${new Date().toLocaleTimeString("en-GH", { hour: "2-digit", minute: "2-digit" })}`);
  const grid = document.getElementById("syncSnapshotGrid");
  if (grid) {
    const branchId = getCurrentBranchId();
    const snapshot = [
      { icon: "ti-package", label: "Inventory", value: getDashboardInventoryProducts(branchId).length },
      { icon: "ti-receipt", label: "Sales", value: getRecordsForBranch(salesHistory, branchId).length },
      { icon: "ti-users", label: "Customers", value: getDashboardPatientsForBranch(branchId).length },
      { icon: "ti-clock", label: "Held Sales", value: getRecordsForBranch(heldSales, branchId).length },
      { icon: "ti-truck", label: "Purchases", value: getRecordsForBranch(purchaseHistory, branchId).length },
      { icon: "ti-list-check", label: "Audit Logs", value: getScopedRecords(auditLog).length }
    ];
    renderHtml(grid, snapshot.map(item => `
      <div class="sync-snapshot-item">
        <i class="ti ${item.icon}"></i>
        <span>${sanitize(item.label)}</span>
        <strong>${Number(item.value || 0).toLocaleString("en-GH")}</strong>
      </div>
    `).join(""));
  }
}
