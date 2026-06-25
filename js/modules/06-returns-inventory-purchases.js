function setReturnsFilter(filter) {
  returnsFilterType = ["open", "refunded", "all"].includes(filter) ? filter : "open";
  renderReturnsView();
}

function saleMatchesReturnsSearch(sale, query) {
  if (!query) return true;
  const itemText = (sale.items || []).map(item => `${item.name} ${item.qty}`).join(" ");
  return [sale.id, sale.customer, sale.payment, sale.processedBy, itemText]
    .some(value => String(value || "").toLowerCase().includes(query));
}

function renderReturnsView() {
  const list = document.getElementById("returnsList");
  if (!list) return;
  const query = (document.getElementById("returnsSearch")?.value || "").trim().toLowerCase();
  const branchSales = getRecordsForBranch(salesHistory, getCurrentBranchId());
  const refunds = branchSales.filter(sale => sale.refundAgainst || (Number(sale.total) || 0) < 0);
  const refundedIds = new Set(refunds.map(refund => refund.refundAgainst).filter(Boolean));
  const returnable = branchSales.filter(sale => !sale.refundAgainst && (Number(sale.total) || 0) >= 0 && !refundedIds.has(sale.id));
  const refundValue = refunds.reduce((sum, refund) => sum + Math.abs(Number(refund.total) || 0), 0);
  setText("returnsOpenCount", String(returnable.length));
  setText("returnsRefundCount", String(refunds.length));
  setText("returnsRefundValue", money(refundValue));
  document.getElementById("returnsFilterOpen")?.classList.toggle("active", returnsFilterType === "open");
  document.getElementById("returnsFilterRefunded")?.classList.toggle("active", returnsFilterType === "refunded");
  document.getElementById("returnsFilterAll")?.classList.toggle("active", returnsFilterType === "all");
  const source = returnsFilterType === "refunded" ? refunds : returnsFilterType === "all" ? [...returnable, ...refunds] : returnable;
  const rows = source
    .filter(sale => saleMatchesReturnsSearch(sale, query))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  if (!rows.length) {
    renderHtml(list, `<div class="empty-cart"><i class="ti ti-receipt-refund"></i><div>No return records match this view</div></div>`);
    return;
  }
  renderHtml(list, rows.map(sale => {
    const isRefund = sale.refundAgainst || (Number(sale.total) || 0) < 0;
    const itemCount = (sale.items || []).reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
    return `
      <div class="held-sale returns-sale-row">
        <div>
          <div class="item-name">${sanitize(sale.id)} - ${sanitize(sale.customer || "Walk-in")}</div>
          <div class="held-meta">${sanitize(new Date(sale.date).toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" }))} - ${itemCount} item(s) - ${sanitize(sale.branch || getCurrentBranchName())}${isRefund ? ` - Refund of ${sanitize(sale.refundAgainst || "")}` : ""}</div>
        </div>
        <div>
          <div class="item-total">${money(sale.total)}</div>
          ${isRefund ? `<span class="cat-tag">Refunded</span>` : `<button class="action-btn" data-sale-id="${sanitize(sale.id || "")}" onclick="processReturn(this.dataset.saleId)">Process return</button>`}
        </div>
      </div>
    `;
  }).join(""));
}

function processReturn(saleId) {
  if (!requirePermission("processReturns", "Pharmacist or manager access required to process returns")) return;
  const sale = salesHistory.find(s => s.id === saleId);
  if (!sale) return showToast("Sale not found", 2500, "error");
  if (sale.refundAgainst) return showToast("Refund record cannot be returned again", 2500, "error");
  const itemCount = sale.items?.reduce((sum, item) => sum + (item.qty || 0), 0) || 0;
  openConfirmModal({
    title: "Process return",
    confirmText: "Process return",
    icon: "ti-receipt-refund",
    body: `
          <p>Refund sale <strong>${sanitize(sale.id)}</strong> for <strong>GHS ${(sale.total || 0).toFixed(2)}</strong>.</p>
          <div class="confirm-context">
            <div><span>Customer</span><strong>${sanitize(sale.customer || "Walk-in")}</strong></div>
            <div><span>Items returning to stock</span><strong>${itemCount}</strong></div>
            <div><span>Branch</span><strong>${sanitize(sale.branch || getCurrentBranchName() || "Unknown")}</strong></div>
          </div>
          <p class="confirm-note">Returned quantities will be added back to inventory and a refund record will be created.</p>
        `,
    onConfirm: () => completeReturn(saleId)
  });
}

async function completeReturn(saleId) {
  if (!requirePermission("processReturns", "Pharmacist or manager access required to process returns")) return;
  const sale = salesHistory.find(s => s.id === saleId);
  if (!sale) return showToast("Sale not found", 2500, "error");
  if (sale.refundAgainst) return showToast("Refund record cannot be returned again", 2500, "error");
  if (!await saveMajorChangeBackup(`Before return ${sale.id}`)) return;
  const branchId = getRecordBranchId(sale);
  const branchName = getBranchNameById(branchId);
  const stockMovements = [];
  const stockSnapshots = new Map();
  (sale.items || []).forEach(item => {
    const drug = drugs.find(d => d.id === item.id);
    if (drug) {
      if (!stockSnapshots.has(drug.id)) {
        stockSnapshots.set(drug.id, {
          stock: drug.stock,
          branchStock: JSON.parse(JSON.stringify(drug.branchStock || {})),
          batches: JSON.parse(JSON.stringify(normalizeDrugBatches(drug)))
        });
      }
      const batchAllocations = item.batchAllocations || item.batch_allocations || [];
      stockMovements.push({ drug_id: drug.id, drugId: drug.id, name: drug.name, qty: item.qty, branch_id: branchId, branch: branchName, reason: "return", sale_id: sale.id, batch_allocations: batchAllocations });
      restoreReturnedItemStock(drug, item, branchId, sale.id);
    }
  });
  const now = new Date();
  const refundId = makeClientId("RFND");
  const refund = {
    id: refundId,
    date: now.toISOString(),
    branch_id: branchId,
    branch: branchName,
    customer: sale.customer,
    customerId: sale.customerId,
    payment: 'Refund',
    paymentDetails: [{ method: 'Refund', amount: -Math.abs(Number(sale.total) || 0) }],
    paid: -sale.total,
    due: 0,
    onAccount: false,
    refundAgainst: sale.id,
    processedBy: currentUser?.username || "system",
    items: JSON.parse(JSON.stringify(sale.items)),
    total: -sale.total,
    totalCost: -(sale.totalCost || 0),
    profit: -(sale.profit || 0),
    discount: 0,
    tax: 0
  };
  let savedRefund = refund;
  try {
    const serverRefund = await syncServerAction("/returns", { refund, original_sale_id: sale.id, stock_movements: stockMovements }, { branch: branchId });
    if (serverRefund) savedRefund = serverRefund;
  } catch (error) {
    console.warn(error);
    const refreshed = hasApiServer() && currentUser
      ? await refreshServerData({ silent: true })
      : false;
    const recoveredRefund = refreshed
      ? salesHistory.find(record => record.id === refundId || record.refundAgainst === sale.id)
      : null;
    if (recoveredRefund) {
      savedRefund = recoveredRefund;
    } else {
      if (!refreshed) {
        stockSnapshots.forEach((snapshot, drugId) => {
          const drug = drugs.find(item => item.id === drugId);
          if (!drug) return;
          drug.stock = snapshot.stock;
          drug.branchStock = snapshot.branchStock;
          drug.batches = snapshot.batches;
        });
      }
      return showToast("Return not saved: server stock update failed", 3500, "error");
    }
  }
  if (sale.onAccount && sale.customerId) {
    const customer = customers.find(c => c.id === sale.customerId);
    if (customer) customer.balance = Math.max(0, (customer.balance || 0) - sale.total);
  }
  salesHistory = salesHistory.filter(record => record.id !== savedRefund.id);
  salesHistory.unshift(savedRefund);
  saveSales(); saveDrugs(); saveCustomers();
  renderHistory();
  renderReturnsView();
  updateNotificationBadge();
  showToast(`Return processed: ${savedRefund.id}`);
}

function renderReference() {
  const query = document.getElementById("referenceSearch")?.value.trim().toLowerCase() || "";
  const category = document.getElementById("referenceCat")?.value || "";
  let rows = referenceDrugs.map((row, sourceIndex) => ({ row, sourceIndex })).filter(entry => {
    const row = entry.row;
    const matchesCategory = !category || row[4] === category;
    if (!matchesCategory) return false;
    if (!query) return true;
    return row.slice(0, 5).some(cell => String(cell).toLowerCase().includes(query));
  });
  if (referenceSortCol >= 0) {
    rows = [...rows].sort((a, b) => {
      const left = String(a.row[referenceSortCol]).toLowerCase();
      const right = String(b.row[referenceSortCol]).toLowerCase();
      if (left === right) return 0;
      return (left > right ? 1 : -1) * (referenceSortAsc ? 1 : -1);
    });
  }
  const canEdit = hasPermission("editReference");
  renderHtml(document.getElementById("referenceBody"), rows.map((entry, index) => {
    const row = entry.row;
    return `
        <tr>
          <td>${index + 1}</td>
          <td class="td-generic">${sanitize(row[0])}</td>
          <td class="td-brand">${sanitize(row[1])}</td>
          <td class="td-dose">${sanitize(row[2])}</td>
          <td class="td-form">${sanitize(row[3])}</td>
          <td><span class="cat-tag">${sanitize(row[4])}</span></td>
          <td class="reference-row-actions">
            ${canEdit ? `
              <button type="button" class="action-btn reference-action-btn" onclick="editReferenceEntry(${entry.sourceIndex})" aria-label="Edit ${sanitize(row[0])}" title="Edit reference"><i class="ti ti-edit"></i></button>
              <button type="button" class="action-btn danger reference-action-btn" onclick="deleteReferenceEntry(${entry.sourceIndex})" aria-label="Delete ${sanitize(row[0])}" title="Delete reference"><i class="ti ti-trash"></i></button>
            ` : `<span class="muted-text">View only</span>`}
          </td>
        </tr>
      `;
  }).join(""));
  document.getElementById("referenceCount").textContent = rows.length;
  const noResultsRef = document.getElementById("noResultsRef");
  if (rows.length) hideHiddenElement(noResultsRef); else showHiddenElement(noResultsRef);
  document.querySelectorAll("#referenceTable th").forEach(th => {
    const col = Number(th.dataset.col);
    th.classList.toggle("sorted", col === referenceSortCol);
    th.classList.toggle("desc", col === referenceSortCol && !referenceSortAsc);
  });
}

function renderReferenceCategories() {
  const select = document.getElementById("referenceCat");
  const categoryList = document.getElementById("referenceCategoryList");
  const selected = select?.value || "";
  const categories = ["", ...new Set(referenceDrugs.map(row => row[4]))];
  if (select) {
    renderHtml(select, categories.map(cat => `
        <option value="${sanitize(cat)}">${sanitize(cat || "All Categories")}</option>
      `).join(""));
    select.value = categories.includes(selected) ? selected : "";
  }
  if (categoryList) {
    renderHtml(categoryList, categories.filter(Boolean).map(cat => `<option value="${sanitize(cat)}"></option>`).join(""));
  }
}

function clearReferenceEditor() {
  editingReferenceIndex = null;
  ["referenceGeneric", "referenceBrand", "referenceDose", "referenceForm", "referenceCategory"].forEach(id => {
    const input = document.getElementById(id);
    if (input) input.value = "";
  });
  const saveButton = document.getElementById("referenceSaveBtn");
  if (saveButton) renderHtml(saveButton, '<i class="ti ti-device-floppy"></i> Add reference');
}

function getReferenceEditorRow() {
  return [
    document.getElementById("referenceGeneric")?.value.trim() || "",
    document.getElementById("referenceBrand")?.value.trim() || "",
    document.getElementById("referenceDose")?.value.trim() || "",
    document.getElementById("referenceForm")?.value.trim() || "",
    document.getElementById("referenceCategory")?.value.trim() || ""
  ];
}

function getReferenceRowKey(row) {
  return [row[0], row[2], row[3]].map(value => String(value || "").trim().toLowerCase()).join("||");
}

function saveReferenceEntry() {
  if (!requirePermission("editReference", "Pharmacist or manager access required to edit references")) return;
  const row = getReferenceEditorRow();
  if (!row[0]) return showToast("Generic name is required", 2500, "error");
  if (!row[3]) return showToast("Dosage form is required", 2500, "error");
  if (!row[4]) return showToast("Category is required", 2500, "error");
  const duplicateIndex = referenceDrugs.findIndex((existing, index) =>
    index !== editingReferenceIndex && getReferenceRowKey(existing) === getReferenceRowKey(row)
  );
  if (duplicateIndex >= 0) return showToast("This reference already exists", 2500, "warning");

  const action = editingReferenceIndex === null ? "reference-add" : "reference-update";
  const actionLabel = editingReferenceIndex === null ? "Added" : "Updated";
  if (editingReferenceIndex === null) referenceDrugs.push(row);
  else referenceDrugs[editingReferenceIndex] = row;
  referenceDrugs = dedupeReferenceDrugs(referenceDrugs);
  saveReferenceDrugs();
  clearReferenceEditor();
  renderReferenceCategories();
  renderReference();
  recordAudit(action, `${actionLabel} drug reference: ${row[0]}${row[2] ? ` ${row[2]}` : ""}`);
  showToast(`${actionLabel} drug reference`);
}

function editReferenceEntry(index) {
  if (!requirePermission("editReference", "Pharmacist or manager access required to edit references")) return;
  const row = referenceDrugs[index];
  if (!row) return showToast("Reference entry not found", 2500, "error");
  editingReferenceIndex = index;
  ["referenceGeneric", "referenceBrand", "referenceDose", "referenceForm", "referenceCategory"].forEach((id, column) => {
    const input = document.getElementById(id);
    if (input) input.value = row[column] || "";
  });
  const saveButton = document.getElementById("referenceSaveBtn");
  if (saveButton) renderHtml(saveButton, '<i class="ti ti-device-floppy"></i> Update reference');
  document.querySelector(".reference-editor-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  document.getElementById("referenceGeneric")?.focus();
}

function deleteReferenceEntry(index) {
  if (!requirePermission("editReference", "Pharmacist or manager access required to edit references")) return;
  const row = referenceDrugs[index];
  if (!row) return showToast("Reference entry not found", 2500, "error");
  openConfirmModal({
    title: "Delete drug reference",
    body: `Delete ${sanitize(row[0])}${row[2] ? ` ${sanitize(row[2])}` : ""} from the reference list?`,
    confirmText: "Delete",
    icon: "ti-trash",
    onConfirm: () => {
      referenceDrugs.splice(index, 1);
      saveReferenceDrugs();
      if (editingReferenceIndex === index) clearReferenceEditor();
      else if (editingReferenceIndex !== null && editingReferenceIndex > index) editingReferenceIndex -= 1;
      renderReferenceCategories();
      renderReference();
      recordAudit("reference-delete", `Deleted drug reference: ${row[0]}${row[2] ? ` ${row[2]}` : ""}`);
      showToast("Drug reference deleted");
    }
  });
}

function getNewDrugId() {
  return Math.max(Date.now(), drugs.length ? Math.max(0, ...drugs.map(d => Number(d.id) || 0)) + 1 : 1);
}

function renderStockTransferForm() {
  const drugSelect = document.getElementById("transferDrug");
  const fromSelect = document.getElementById("transferFromBranch");
  const toSelect = document.getElementById("transferToBranch");
  if (!drugSelect || !fromSelect || !toSelect) return;
  const currentDrug = drugSelect.value;
  const availableDrugs = getAvailableDrugsForBranch();
  renderHtml(drugSelect, [...availableDrugs]
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
    .map(drug => `<option value="${drug.id}">${sanitize(drug.name)}${drug.brand ? ` - ${sanitize(drug.brand)}` : ""}</option>`)
    .join(""));
  if (currentDrug && availableDrugs.some(drug => String(drug.id) === currentDrug)) drugSelect.value = currentDrug;
  const branchOptions = branches.map(branch => `<option value="${sanitize(branch)}">${sanitize(branch)}</option>`).join("");
  const currentFrom = fromSelect.value || getCurrentBranchName() || branches[0];
  const currentTo = toSelect.value || branches.find(branch => branch !== currentFrom) || branches[0];
  renderHtml(fromSelect, branchOptions);
  renderHtml(toSelect, branchOptions);
  fromSelect.value = branches.includes(currentFrom) ? currentFrom : branches[0];
  toSelect.value = branches.includes(currentTo) ? currentTo : (branches.find(branch => branch !== fromSelect.value) || branches[0]);
  if (fromSelect.value === toSelect.value) toSelect.value = branches.find(branch => branch !== fromSelect.value) || toSelect.value;
  updateTransferPreview();
}

function updateTransferPreview() {
  const drug = drugs.find(item => String(item.id) === document.getElementById("transferDrug")?.value);
  const fromBranch = document.getElementById("transferFromBranch")?.value;
  const toBranch = document.getElementById("transferToBranch")?.value;
  const fromStock = document.getElementById("transferFromStock");
  const toStock = document.getElementById("transferToStock");
  if (!drug || !fromBranch || !toBranch) {
    if (fromStock) fromStock.textContent = "Source stock: --";
    if (toStock) toStock.textContent = "Destination stock: --";
    return;
  }
  drug.branchStock = drug.branchStock || {};
  const sourceQty = drug.branchStock[fromBranch] ?? 0;
  const destQty = drug.branchStock[toBranch] ?? 0;
  if (fromStock) fromStock.textContent = `Source stock: ${sourceQty}`;
  if (toStock) toStock.textContent = `Destination stock: ${destQty}`;
}

async function submitStockTransfer() {
  if (!requirePermission("transferStock", "Manager access required to transfer stock")) return;
  const drug = drugs.find(item => String(item.id) === document.getElementById("transferDrug")?.value);
  const fromBranch = document.getElementById("transferFromBranch")?.value;
  const toBranch = document.getElementById("transferToBranch")?.value;
  const qty = parseInt(document.getElementById("transferQty")?.value, 10);
  if (!drug) return showToast("Select a drug to transfer", 2500, "error");
  if (!fromBranch || !toBranch) return showToast("Select transfer branches", 2500, "error");
  if (fromBranch === toBranch) return showToast("Choose two different branches", 2500, "error");
  if (!isDrugAvailableAtBranch(drug, fromBranch)) return showToast(`This drug is not available at ${fromBranch}`, 3000, "error");
  if (!isDrugAvailableAtBranch(drug, toBranch)) return showToast(`This drug is not available at ${toBranch}`, 3000, "error");
  if (!Number.isFinite(qty) || qty <= 0) return showToast("Enter a valid quantity", 2500, "error");
  drug.branchStock = drug.branchStock || {};
  const sourceQty = drug.branchStock[fromBranch] ?? 0;
  const destQty = drug.branchStock[toBranch] ?? 0;
  if (sourceQty < qty) return showToast(`Only ${sourceQty} unit(s) available at ${fromBranch}`, 3000, "error");
  if (!await saveMajorChangeBackup(`Before stock transfer ${drug.name}`)) return;
  // #9 Button spinner
  const tfrBtn = document.querySelector("[onclick='submitStockTransfer()']");
  const tfrOrigHtml = tfrBtn?.innerHTML;
  if (tfrBtn) { tfrBtn.innerHTML = '<span class="btn-spinner"></span> Transferring…'; tfrBtn.disabled = true; }
  const fromBranchId = getBranchIdByName(fromBranch);
  const toBranchId = getBranchIdByName(toBranch);
  const previousBatches = JSON.stringify(normalizeDrugBatches(drug));
  const batchAllocations = transferDrugBatchStock(drug, fromBranchId, toBranchId, qty);
  const transfer = {
    id: `TRF-${Date.now()}`,
    drug_id: drug.id,
    drugId: drug.id,
    name: drug.name,
    qty,
    from_branch_id: fromBranchId,
    from_branch: fromBranch,
    to_branch_id: toBranchId,
    to_branch: toBranch,
    branch_id: fromBranchId,
    branch: fromBranch,
    batch_allocations: batchAllocations,
    batchAllocations,
    transferredBy: currentUser?.username || "system",
    date: new Date().toISOString()
  };
  drug.branchStock[fromBranch] = sourceQty - qty;
  drug.branchStock[toBranch] = destQty + qty;
  drug.stock = drug.branchStock[getCurrentBranchName()] ?? drug.stock ?? 0;
  try {
    await syncServerAction("/stock-transfers", transfer, { branch: "all" });
  } catch (error) {
    console.warn(error);
    drug.branchStock[fromBranch] = sourceQty;
    drug.branchStock[toBranch] = destQty;
    drug.batches = JSON.parse(previousBatches);
    drug.stock = drug.branchStock[getCurrentBranchName()] ?? drug.stock ?? 0;
    return showToast("Transfer not saved: server sync failed", 3500, "error");
  }
  saveDrugs();
  recordAudit("stock-transfer", `Transferred ${qty} unit(s) of ${drug.name} from ${fromBranch} to ${toBranch}`);
  updateBranchStocksToCurrent();
  renderInventoryAdmin();
  filterDrugs();
  updateTransferPreview();
  if (tfrBtn && tfrOrigHtml) { tfrBtn.innerHTML = tfrOrigHtml; tfrBtn.disabled = false; }
  showToast(`Transferred ${qty} unit(s) of ${drug.name}`);
}

function setInventoryViewMode(mode) {
  inventoryViewMode = mode === "low" ? "low" : "all";
  renderInventoryAdmin();
}

function updateInventoryTabs() {
  document.getElementById("inventoryTabAll")?.classList.toggle("active", inventoryViewMode !== "low");
  document.getElementById("inventoryTabLow")?.classList.toggle("active", inventoryViewMode === "low");
}

function renderInventoryAdmin() {
  updateInventoryTabs();
  // #10 Skeleton loading: show shimmer rows while data renders
  const skeletonBody = document.getElementById("inventoryRows");
  if (skeletonBody && !skeletonBody.dataset.loaded) {
    skeletonBody.dataset.loaded = "1";
    renderHtml(skeletonBody, Array(6).fill(0).map(() =>
      `<tr><td colspan="9"><div class="skeleton-row"></div></td></tr>`
    ).join(""));
  }
  const query = document.getElementById("inventorySearch")?.value.trim().toLowerCase() || "";
  let rows = getAvailableDrugsForBranch().filter(drug => {
    if (!query) return true;
    return [drug.name, drug.form, getDrugSaleUnit(drug), drug.cat, drug.route, drug.shelfLocation, drug.barcode]
      .some(value => String(value || "").toLowerCase().includes(query));
  });
  if (typeof inventoryViewMode !== 'undefined' && inventoryViewMode === 'low') {
    rows = rows.filter(isDrugLowStock);
  }
  const body = document.getElementById("inventoryRows");
  if (!rows.length) {
    renderHtml(body, `<tr><td colspan="9" style="text-align:center;padding:20px;color:var(--muted)">No inventory results found.</td></tr>`);
  } else {
    renderHtml(body, rows.map(drug => `
          <tr data-key="inventory-${drug.id}">
            <td>${sanitize(drug.name)}</td>
            <td><strong>${sanitize(drug.dose || "--")}</strong><div class="td-form">${sanitize(drug.form || "--")} - sold per ${sanitize(getDrugSaleUnit(drug))}</div></td>
            <td>${sanitize(drug.route || "--")}</td>
            <td>${normalizeDrugBatches(drug).length}</td>
            <td>GHS ${parseFloat(drug.price || 0).toFixed(2)}</td>
            <td>${drug.stock ?? 0}</td>
            <td>${getDrugLowThreshold(drug)}</td>
            <td>${drug.rx ? "Rx" : "OTC"}</td>
            <td>
              <button class="action-btn" onclick="openDrugEditor(${drug.id})">Edit</button>
              ${hasPermission("deleteInventory") ? `<button class="action-btn danger" onclick="deleteDrugItem(${drug.id})">Delete</button>` : `<button class="action-btn danger" disabled title="Managers only">Delete</button>`}
            </td>
          </tr>
        `).join(""));
  }
  renderAuditLog();
  // update low-stock badge
  try { updateLowStockBadge(); } catch (e) { }
}

function getExpiryAlerts() {
  const thresholdMs = 1000 * 60 * 60 * 24 * 30;
  const now = Date.now();
  return getBatchExpiryRows(getCurrentBranchId()).filter(row => {
    const expiry = new Date(row.expiry).getTime();
    return expiry > 0 && expiry <= now + thresholdMs && (row.stock ?? 0) > 0;
  });
}

function checkExpiryOnLogin() {
  const alerts = getExpiryAlerts();
  // Update the badge on inventory page too
  const badge = document.getElementById("expiryBadge");
  if (badge) badge.textContent = alerts.length;
  updateExpiryNavBadge();
  if (!alerts.length) return;

  const now = Date.now();
  const expired = alerts.filter(d => new Date(d.expiry).getTime() < now);
  const expiring = alerts.filter(d => new Date(d.expiry).getTime() >= now);

  let html = "";
  if (expired.length) {
    html += `<strong style="color:#991b1b;">Expired (${expired.length}):</strong> `;
    html += expired.map(d => `${sanitize(d.name)} batch ${sanitize(d.batch || "--")} (expired ${sanitize(d.expiry)})`).join(", ");
    html += "<br>";
  }
  if (expiring.length) {
    html += `<strong style="color:#b45309;">Expiring within 30 days (${expiring.length}):</strong> `;
    html += expiring.map(d => {
      const days = Math.floor((new Date(d.expiry).getTime() - now) / 86400000);
      return `${sanitize(d.name)} batch ${sanitize(d.batch || "--")} (${days}d left)`;
    }).join(", ");
  }

  const banner = document.getElementById("expiryBanner");
  const body = document.getElementById("expiryBannerBody");
  if (banner && body) {
    renderHtml(body, html);
    banner.style.display = "flex";
  }
}

function updatePurchaseSupplierOptions() {
  const purchaseSupplier = document.getElementById("purchaseSupplier");
  const drugSupplier = document.getElementById("drugSupplier");
  const visibleSuppliers = getRecordsForBranch(suppliers, getCurrentBranchId());
  const options = visibleSuppliers.length ? visibleSuppliers.map(s => `<option value="${sanitize(s.id)}">${sanitize(s.name)}</option>`).join("") : `<option value="">No suppliers</option>`;
  const preferredOptions = `<option value="">No preferred supplier</option>` + (visibleSuppliers.length ? visibleSuppliers.map(s => `<option value="${sanitize(s.id)}">${sanitize(s.name)}</option>`).join("") : "");
  if (purchaseSupplier) renderHtml(purchaseSupplier, options);
  if (drugSupplier) renderHtml(drugSupplier, preferredOptions);
}

function renderSupplierList() {
  const rows = document.getElementById("supplierRows");
  const noResults = document.getElementById("noResultsSuppliers");
  const visibleSuppliers = getRecordsForBranch(suppliers, getCurrentBranchId());
  if (!visibleSuppliers.length) {
    renderHtml(rows, "");
    showHiddenElement(noResults);
  } else {
    hideHiddenElement(noResults);
    renderHtml(rows, visibleSuppliers.map((supplier, index) => `
          <tr>
            <td>${sanitize(supplier.name)}</td>
            <td>${sanitize(supplier.phone || "--")}</td>
            <td>${sanitize(supplier.email || "--")}</td>
            <td>${sanitize(supplier.notes || "--")}</td>
          </tr>
        `).join(""));
  }
  document.getElementById("supplierCount").textContent = visibleSuppliers.length;
  updatePurchaseSupplierOptions();
}

function prepareNewPurchase() {
  activeWorkspaceSections.purchases = "grn";
  if (!document.getElementById("view-purchases")?.classList.contains("active")) {
    showView("purchases");
  } else {
    applyWorkspaceSection("purchases");
    updateSidebarNavigation("purchases");
  }
  document.getElementById("purchaseInvoice").value = "";
  document.getElementById("purchaseDate").value = new Date().toISOString().slice(0, 10);
  clearGrnTable();
  if (!getRecordsForBranch(suppliers, getCurrentBranchId()).length) {
    activeWorkspaceSections.purchases = "suppliers";
    applyWorkspaceSection("purchases");
    updateSidebarNavigation("purchases");
    showToast("Add a supplier before receiving stock", 2500, "error");
    return;
  }
  renderSupplierList();
  showToast("Ready to record a new GRN", 2500, "info");
}

function renderPurchaseView() {
  const alerts = getExpiryAlerts();
  const visiblePurchases = getRecordsForBranch(purchaseHistory, getCurrentBranchId());
  document.getElementById("purchaseHistoryCount").textContent = visiblePurchases.length;
  document.getElementById("draftCount").textContent = draftPurchaseOrders.length;
  document.getElementById("draftOrdersCard").textContent = draftPurchaseOrders.length;
  document.getElementById("expiryAlertCount").textContent = alerts.length;
  renderSupplierList();
  const historyList = document.getElementById("purchaseHistoryList");
  if (!visiblePurchases.length) {
    renderHtml(historyList, `<div class="empty-cart"><i class="ti ti-calendar-event"></i><div>No purchase history recorded</div></div>`);
    return;
  }
  renderHtml(historyList, visiblePurchases.slice().reverse().map(entry => `
        <div class="held-sale">
          <div>
            <div class="item-name">${sanitize(entry.invoice || entry.id)} - ${sanitize(entry.supplier || "--")}</div>
            <div class="held-meta">${sanitize(new Date(entry.date).toLocaleString('en-GH', { dateStyle: 'medium', timeStyle: 'short' }))} - ${(entry.items || []).length} item(s)</div>
          </div>
          <div class="item-total">GHS ${Number(entry.total || 0).toFixed(2)}</div>
        </div>
      `).join(""));
}

async function saveSupplier() {
  if (!requirePermission("managePurchases", "Pharmacist or manager access required to manage suppliers")) return;
  const name = document.getElementById("supplierName").value.trim();
  const phone = document.getElementById("supplierPhone").value.trim();
  const email = document.getElementById("supplierEmail").value.trim();
  const notes = document.getElementById("supplierNotes").value.trim();
  if (!name) return showToast("Supplier name is required", 2500, "error");
  const supplier = setRecordBranch({ id: Math.max(Date.now(), suppliers.length ? Math.max(0, ...suppliers.map(s => Number(s.id) || 0)) + 1 : 1), name, phone, email, notes });
  try {
    await syncServerAction("/suppliers", supplier, { branch: supplier.branch_id });
  } catch (error) {
    console.warn(error);
    return showToast("Supplier not saved: server sync failed", 3500, "error");
  }
  suppliers.push(supplier);
  saveSuppliers();
  renderSupplierList();
  showToast("Supplier saved");
  document.getElementById("supplierName").value = "";
  document.getElementById("supplierPhone").value = "";
  document.getElementById("supplierEmail").value = "";
  document.getElementById("supplierNotes").value = "";
}

// GRN row-by-row table
let _grnRowId = 0;
function addGrnRow() {
  const tbody = document.getElementById("grnRows");
  const empty = document.getElementById("grnEmpty");
  if (empty) empty.style.display = "none";
  const id = ++_grnRowId;
  const listId = `grnDrugList-${id}`;
  const tr = document.createElement("tr");
  tr.id = `grn-row-${id}`;
  tr.style.cssText = "border-top:1px solid rgba(37,99,235,.08);";
  renderHtml(tr, `
        <td style="padding:8px 12px;">
          <input list="${listId}" placeholder="Type drug name..." oninput="updateGrnTotal()"
            style="width:100%;min-width:180px;padding:8px 10px;border-radius:10px;border:1px solid rgba(37,99,235,.2);font-size:13px;" />
          <datalist id="${listId}">${getAvailableDrugsForBranch().map(d => `<option value="${sanitize(d.name)}">`).join("")}</datalist>
        </td>
        <td style="padding:8px 12px;">
          <input type="number" min="1" step="1" placeholder="0" oninput="updateGrnTotal()"
            style="width:72px;padding:8px 10px;border-radius:10px;border:1px solid rgba(37,99,235,.2);font-size:13px;" />
        </td>
        <td style="padding:8px 12px;">
          <input type="number" min="0" step="0.01" placeholder="0.00" oninput="updateGrnTotal()"
            style="width:90px;padding:8px 10px;border-radius:10px;border:1px solid rgba(37,99,235,.2);font-size:13px;" />
        </td>
        <td style="padding:8px 12px;">
          <input type="text" placeholder="Batch no."
            style="width:100px;padding:8px 10px;border-radius:10px;border:1px solid rgba(37,99,235,.2);font-size:13px;" />
        </td>
        <td style="padding:8px 12px;">
          <input type="date"
            style="width:130px;padding:8px 10px;border-radius:10px;border:1px solid rgba(37,99,235,.2);font-size:13px;" />
        </td>
        <td style="padding:8px 8px;text-align:center;">
          <button onclick="removeGrnRow(${id})" style="background:none;border:none;cursor:pointer;color:var(--danger);font-size:18px;line-height:1;" title="Remove row">
            <i class="ti ti-x"></i>
          </button>
        </td>
      `);
  tbody.appendChild(tr);
  tr.querySelector("input").focus();
  updateGrnTotal();
}

function removeGrnRow(id) {
  const row = document.getElementById(`grn-row-${id}`);
  if (row) row.remove();
  const tbody = document.getElementById("grnRows");
  const empty = document.getElementById("grnEmpty");
  if (empty) empty.style.display = tbody.children.length === 0 ? "block" : "none";
  updateGrnTotal();
}

function updateGrnTotal() {
  const rows = document.querySelectorAll("#grnRows tr");
  let total = 0;
  rows.forEach(row => {
    const inputs = row.querySelectorAll("input");
    const qty = parseFloat(inputs[1]?.value) || 0;
    const cost = parseFloat(inputs[2]?.value) || 0;
    total += qty * cost;
  });
  const el = document.getElementById("grnTotal");
  if (el) el.textContent = `GHS ${total.toFixed(2)}`;
}

function clearGrnTable() {
  const tbody = document.getElementById("grnRows");
  if (tbody) renderHtml(tbody, "");
  const empty = document.getElementById("grnEmpty");
  if (empty) empty.style.display = "block";
  updateGrnTotal();
}

async function recordPurchaseGRN() {
  if (!requirePermission("managePurchases", "Pharmacist or manager access required to receive stock")) return;
  const supplierId = document.getElementById("purchaseSupplier").value;
  const supplier = getRecordsForBranch(suppliers, getCurrentBranchId()).find(s => String(s.id) === String(supplierId));
  const invoice = document.getElementById("purchaseInvoice").value.trim();
  const date = document.getElementById("purchaseDate").value || new Date().toISOString().slice(0, 10);
  if (!supplier) return showToast("Please select a supplier", 2500, "error");
  if (!invoice) return showToast("Invoice / GRN number is required", 2500, "error");

  // Read rows from the GRN table
  const rows = document.querySelectorAll("#grnRows tr");
  if (!rows.length) return showToast("Add at least one item to the GRN", 2500, "error");
  if (!await saveMajorChangeBackup(`Before GRN ${invoice || supplier.name}`)) return;
  // #9 Button spinner
  const grnBtn = document.querySelector("[onclick='recordPurchaseGRN()']");
  const grnOrigHtml = grnBtn?.innerHTML;
  if (grnBtn) { grnBtn.innerHTML = '<span class="btn-spinner"></span> Receiving…'; grnBtn.disabled = true; }

  const items = [];
  const branchId = getCurrentBranchId();
  const branch = getBranchNameById(branchId);
  const stockMovements = [];
  const preparedRows = [];
  const previousCosts = new Map();
  let rowNum = 0;
  for (const row of rows) {
    rowNum++;
    const inputs = row.querySelectorAll("input");
    const drugKey = inputs[0]?.value.trim();
    const qty = parseInt(inputs[1]?.value, 10);
    const cost = parseFloat(inputs[2]?.value);
    const batch = inputs[3]?.value.trim() || "";
    const expiry = inputs[4]?.value || "";

    if (!drugKey) return showToast(`Row ${rowNum}: drug name is required`, 2500, "error");
    if (!Number.isFinite(qty) || qty <= 0) return showToast(`Row ${rowNum}: quantity must be a positive number`, 2500, "error");
    if (!Number.isFinite(cost) || cost < 0) return showToast(`Row ${rowNum}: cost must be a valid number`, 2500, "error");
    if (!batch) return showToast(`Row ${rowNum}: batch number is required`, 2500, "error");
    if (!expiry) return showToast(`Row ${rowNum}: expiry date is required`, 2500, "error");
    const expiryDate = new Date(expiry);
    if (Number.isNaN(expiryDate.getTime()) || expiryDate < new Date(new Date().toISOString().slice(0, 10))) {
      return showToast(`Row ${rowNum}: expiry date must be today or in the future`, 2500, "error");
    }

    const drug = getAvailableDrugsForBranch().find(d => [d.name, d.brand].some(v => String(v || "").toLowerCase() === drugKey.toLowerCase()));
    if (!drug) return showToast(`Row ${rowNum}: unknown drug "${drugKey}" - check spelling or add it to inventory first`, 2500, "error");
    preparedRows.push({ drug, qty, cost, batch, expiry });
  }

  for (const { drug, qty, cost, batch, expiry } of preparedRows) {
    if (!previousCosts.has(drug.id)) previousCosts.set(drug.id, drug.costPrice);
    drug.stock = (drug.stock || 0) + qty;
    drug.branchStock = drug.branchStock || {};
    drug.branchStock[branch] = (drug.branchStock[branch] || 0) + qty;
    drug.branch_id = branchId;
    drug.branch = branch;
    drug.costPrice = cost;
    const batchRecord = addDrugBatchStock(drug, {
      qty,
      cost,
      batch,
      expiry,
      branch_id: branchId,
      branch,
      supplierId: supplier.id,
      supplier: supplier.name,
      invoice,
      receivedDate: date
    });
    const item = { drugId: drug.id, drug_id: drug.id, name: drug.name, qty, cost, batch, batchId: batchRecord?.id || "", expiry, branch_id: branchId, branch };
    items.push(item);
    stockMovements.push({
      drug_id: drug.id,
      drugId: drug.id,
      name: drug.name,
      qty,
      branch_id: branchId,
      branch,
      reason: "purchase",
      invoice,
      batch,
      batch_id: batchRecord?.id || "",
      expiry,
      cost,
      supplierId: supplier.id,
      supplier: supplier.name,
      receivedDate: date
    });
  }

  const total = items.reduce((sum, item) => sum + item.qty * item.cost, 0);
  const purchase = {
    id: `GRN-${Date.now()}`,
    branch_id: branchId,
    branch,
    supplier: supplier.name,
    supplierId: supplier.id,
    invoice,
    date,
    items,
    total,
    receivedBy: currentUser?.username || "system"
  };
  try {
    await syncServerAction("/purchases", { purchase, stock_movements: stockMovements }, { branch: branchId });
  } catch (error) {
    console.warn(error);
    stockMovements.forEach(movement => {
      const drug = drugs.find(d => d.id === movement.drug_id);
      if (drug) {
        updateDrugStockForBranch(drug, branchId, -Math.abs(movement.qty));
        rollbackAddedDrugBatchStock(drug, movement.batch_id || movement.batchId, Math.abs(movement.qty));
        if (previousCosts.has(drug.id)) drug.costPrice = previousCosts.get(drug.id);
      }
    });
    return showToast("GRN not saved: server stock update failed", 3500, "error");
  }
  purchaseHistory.push(purchase);
  stockAdjustments.push({ id: `ADJ-${Date.now()}`, type: "receipt", branch_id: branchId, branch, date, performedBy: currentUser?.username || "system", details: `Received ${items.length} item(s) from ${supplier.name}`, items });
  saveDrugs(); savePurchases(); saveStockAdj();
  renderPurchaseView();
  renderCategories();
  renderInventoryAdmin();
  clearGrnTable();
  if (grnBtn && grnOrigHtml) { grnBtn.innerHTML = grnOrigHtml; grnBtn.disabled = false; }
  showToast(`GRN recorded - ${items.length} item(s) received from ${supplier.name}`);
}

function setSelectValueOrAppend(selectId, value) {
  const select = document.getElementById(selectId);
  if (!select) return;
  const nextValue = String(value || "");
  if (nextValue && !Array.from(select.options).some(option => option.value === nextValue || option.textContent === nextValue)) {
    select.add(new Option(nextValue, nextValue));
  }
  select.value = nextValue;
}

function autoCalcPrice() {
  const costInput = document.getElementById("drugCost");
  const priceInput = document.getElementById("drugPrice");
  const cost = parseFloat(costInput.value);
  if (Number.isFinite(cost) && cost >= 0) {
    priceInput.value = (cost * (1 + DEFAULT_MARGIN)).toFixed(2);
  } else {
    priceInput.value = "";
  }
}

function autoCalcCost() {
  const costInput = document.getElementById("drugCost");
  const priceInput = document.getElementById("drugPrice");
  const price = parseFloat(priceInput.value);
  if (Number.isFinite(price) && price >= 0) {
    costInput.value = (price / (1 + DEFAULT_MARGIN)).toFixed(2);
  } else {
    costInput.value = "";
  }
}

function updateDrugOpeningQtyLabel() {
  const label = document.getElementById("drugOpeningQtyLabel");
  if (!label) return;
  const saleUnit = document.getElementById("drugSaleUnit")?.value || "Unit";
  label.textContent = `Opening quantity (${getCurrentBranchName()}, in ${formatDrugSaleUnit({ saleUnit }, 2).toLowerCase()})`;
}

function openDrugEditor(id) {
  if (!requirePermission("editInventory", "Manager access required to edit inventory")) return;
  editingDrugId = id;
  const drug = drugs.find(d => d.id === id) || {
    name: "",
    dose: "",
    form: "",
    cat: "",
    route: "",
    shelfLocation: "",
    price: 0,
    costPrice: "",
    barcode: "",
    rx: false,
    saleUnit: "Unit",
    branchStock: {},
    batches: [],
    reorderQuantity: DEFAULT_REORDER_QUANTITY,
    maxStock: DEFAULT_MAX_STOCK
  };
  normalizeDrugBatches(drug);
  updatePurchaseSupplierOptions();
  document.getElementById("drugName").value = drug.name || "";
  document.getElementById("drugDose").value = drug.dose || "";
  setSelectValueOrAppend("drugForm", drug.form || "");
  setSelectValueOrAppend("drugSaleUnit", getDrugSaleUnit(drug));
  setSelectValueOrAppend("drugCat", drug.cat || "");
  setSelectValueOrAppend("drugRoute", drug.route || "");
  document.getElementById("drugShelf").value = drug.shelfLocation || drug.shelf || "";
  document.getElementById("drugCost").value = drug.costPrice ?? "";
  document.getElementById("drugPrice").value = drug.price ?? 0;
  document.getElementById("drugBarcode").value = drug.barcode || "";
  document.getElementById("drugReorder").value = getDrugLowThreshold(drug);
  document.getElementById("drugReorderQty").value = getDrugReorderQuantity(drug);
  document.getElementById("drugMaxStock").value = getDrugMaxStock(drug);
  setSelectValueOrAppend("drugSupplier", drug.preferredSupplierId || drug.supplierId || "");
  document.getElementById("drugRx").value = drug.rx ? "true" : "false";
  updateDrugOpeningQtyLabel();
  const openingQtyInput = document.getElementById("drugOpeningQty");
  const openingExpiryInput = document.getElementById("drugOpeningExpiry");
  const openingBatchInput = document.getElementById("drugOpeningBatch");
  if (openingQtyInput) openingQtyInput.value = "";
  if (openingExpiryInput) openingExpiryInput.value = "";
  if (openingBatchInput) openingBatchInput.value = "";
  renderDrugBatchTable(drug);
  activeWorkspaceSections.inventory = "editor";
  showView("admin");
  setTimeout(() => document.getElementById("drugName")?.focus(), 150);
}

async function saveDrugItem() {
  if (!requirePermission("editInventory", "Manager access required to edit inventory")) return;
  const name = document.getElementById("drugName").value.trim();
  if (!name) return showToast("Please enter a drug name", 2500, "error");
  const dose = document.getElementById("drugDose").value.trim();
  const form = document.getElementById("drugForm").value.trim();
  const saleUnit = document.getElementById("drugSaleUnit").value.trim();
  const cat = document.getElementById("drugCat").value.trim();
  const route = document.getElementById("drugRoute").value.trim();
  const shelfLocation = document.getElementById("drugShelf").value.trim();
  if (!form) return showToast("Please select a dosage form", 2500, "error");
  if (!saleUnit) return showToast("Please select how this product is sold", 2500, "error");
  if (!cat) return showToast("Please select a category", 2500, "error");
  if (!route) return showToast("Please select a route", 2500, "error");
  const cost = parseFloat(document.getElementById("drugCost").value);
  const priceInput = parseFloat(document.getElementById("drugPrice").value);
  if (!Number.isFinite(priceInput) || priceInput < 0) {
    return showToast("Please enter a valid selling price", 2500, "error");
  }
  const price = Number(priceInput.toFixed(2));
  const barcode = document.getElementById("drugBarcode").value.trim();
  const preferredSupplierId = document.getElementById("drugSupplier").value;
  const preferredSupplier = getRecordsForBranch(suppliers, getCurrentBranchId()).find(s => String(s.id) === String(preferredSupplierId));
  const lowStockThreshold = Math.max(1, parseInt(document.getElementById("drugReorder").value, 10) || DEFAULT_LOW_STOCK_THRESHOLD);
  const reorderQuantity = Math.max(0, parseInt(document.getElementById("drugReorderQty").value, 10) || DEFAULT_REORDER_QUANTITY);
  const maxStock = Math.max(0, parseInt(document.getElementById("drugMaxStock").value, 10) || DEFAULT_MAX_STOCK);
  const rx = document.getElementById("drugRx").value === "true";
  const openingQtyText = document.getElementById("drugOpeningQty")?.value.trim() || "";
  const openingExpiry = document.getElementById("drugOpeningExpiry")?.value || "";
  const openingBatch = document.getElementById("drugOpeningBatch")?.value.trim() || "";
  const openingQtyValue = Number(openingQtyText);
  const openingQty = openingQtyText ? openingQtyValue : 0;
  if (openingQtyText && (!Number.isInteger(openingQtyValue) || openingQtyValue <= 0)) {
    return showToast("Opening quantity must be a positive number", 2500, "error");
  }
  if (!openingQty && (openingExpiry || openingBatch)) {
    return showToast("Enter an opening quantity before adding batch details", 2500, "error");
  }
  if (openingQty > 0 && !openingExpiry) {
    return showToast("Please enter an opening expiry date", 2500, "error");
  }
  if (openingQty > 0 && !openingBatch) {
    return showToast("Please enter a batch/lot number for opening stock", 2500, "error");
  }
  if (!await saveMajorChangeBackup(`Before inventory ${editingDrugId ? "update" : "create"}: ${name}`)) return;
  const previousDrugs = JSON.parse(JSON.stringify(drugs));
  const branchId = getCurrentBranchId();
  const branch = getBranchNameById(branchId);
  const openingReceivedDate = new Date().toISOString().slice(0, 10);
  let drug = drugs.find(d => d.id === editingDrugId);
  const existingDrug = drug ? { price: drug.price } : null;
  let auditAction = "";
  let auditDetails = "";
  if (!drug) {
    drug = {
      id: getNewDrugId(),
      stock: 0,
      branchStock: Object.fromEntries(branches.map(branchName => [branchName, 0])),
      branchAvailability: Object.fromEntries(branches.map(branchName => [branchName, branchName === branch])),
      batches: []
    };
    drugs.push(drug);
  }
  normalizeDrugBatches(drug);
  drug.name = name;
  drug.brand = "";
  drug.dose = dose;
  drug.form = form;
  drug.saleUnit = saleUnit;
  drug.cat = cat;
  drug.route = route;
  drug.shelfLocation = shelfLocation;
  drug.costPrice = Number.isFinite(cost) ? cost : drug.costPrice || 0;
  drug.price = price;
  drug.barcode = barcode;
  drug.preferredSupplierId = preferredSupplierId;
  drug.preferredSupplier = preferredSupplier?.name || "";
  drug.lowStockThreshold = lowStockThreshold;
  drug.reorderPoint = lowStockThreshold;
  drug.reorderMinimum = lowStockThreshold;
  drug.reorderQuantity = reorderQuantity;
  drug.maxStock = maxStock;
  drug.rx = rx;
  delete drug.supplierId;
  delete drug.expiry;
  delete drug.batch;
  drug.branchStock = drug.branchStock || Object.fromEntries(branches.map(branch => [branch, 0]));
  ensureDrugBranchAvailability(drug);
  drug.branchAvailability[branch] = true;
  drug.stock = drug.branchStock[getCurrentBranchName()] ?? drug.stock ?? 0;
  drug.branch_id = branchId;
  drug.branch = branch;
  let openingBatchRecord = null;
  if (openingQty > 0) {
    updateDrugStockForBranch(drug, branchId, openingQty);
    openingBatchRecord = addDrugBatchStock(drug, {
      qty: openingQty,
      cost: Number.isFinite(cost) ? cost : drug.costPrice || 0,
      batch: openingBatch,
      expiry: openingExpiry,
      branch_id: branchId,
      branch,
      supplierId: preferredSupplierId,
      supplier: preferredSupplier?.name || "",
      invoice: "Opening stock",
      receivedDate: openingReceivedDate
    });
  }
  if (existingDrug) {
    const changes = [];
    if (existingDrug.price !== drug.price) changes.push(`price ${existingDrug.price} -> ${drug.price}`);
    if (openingQty > 0) changes.push(`opening stock +${openingQty} (${openingBatch}, exp ${openingExpiry})`);
    if (changes.length) {
      auditAction = "inventory-update";
      auditDetails = `Updated ${drug.name}: ${changes.join("; ")}`;
    }
  } else {
    const openingDetails = openingQty > 0 ? ` with opening stock ${openingQty} (${openingBatch}, exp ${openingExpiry})` : "";
    auditAction = "inventory-create";
    auditDetails = `Added new drug ${drug.name} at GHS ${drug.price}${openingDetails}`;
  }
  try {
    await syncServerAction(`/drugs/${drug.id}`, { drug, branch_stocks: drug.branchStock || {} }, { branch: "all" });
  } catch (error) {
    console.warn(error);
    drugs = previousDrugs;
    return showToast("Drug not saved: server sync failed", 3500, "error");
  }
  if (auditAction) recordAudit(auditAction, auditDetails);
  if (openingQty > 0) {
    stockAdjustments.push({
      id: `ADJ-${Date.now()}`,
      type: "opening-stock",
      branch_id: branchId,
      branch,
      date: openingReceivedDate,
      performedBy: currentUser?.username || "system",
      details: `Opening stock for ${drug.name}`,
      items: [{
        drugId: drug.id,
        drug_id: drug.id,
        name: drug.name,
        qty: openingQty,
        cost: Number.isFinite(cost) ? cost : drug.costPrice || 0,
        batch: openingBatch,
        batchId: openingBatchRecord?.id || "",
        expiry: openingExpiry,
        branch_id: branchId,
        branch
      }]
    });
  }
  persistAll(); // saves drugs + audit log written by recordAudit above
  renderCategories();
  filterDrugs();
  renderInventoryAdmin();
  showToast(`Drug ${editingDrugId ? "updated" : "added"}`);
  editingDrugId = null;
  resetDrugEditor();
}

function deleteDrugItem(id) {
  if (!requirePermission("deleteInventory", "Manager access required to delete inventory")) return;
  const drug = drugs.find(d => d.id === id);
  if (!drug) return showToast("Drug not found", 2500, "error");
  const currentBranch = getCurrentBranchName() || "Current branch";
  const currentBranchId = getCurrentBranchId();
  const currentStock = drug.branchStock?.[currentBranch] ?? drug.stock ?? 0;
  const totalStock = Object.values(drug.branchStock || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const currentBatchStock = normalizeDrugBatches(drug)
    .filter(batch => batch.branch_id === currentBranchId)
    .reduce((sum, batch) => sum + (Number(batch.qty) || 0), 0);
  const hasStock = Number(currentStock) > 0 || currentBatchStock > 0;
  const canForceDelete = String(currentUser?.role || "").toLowerCase() === "director";
  if (hasStock && !canForceDelete) {
    return showToast("Only a director can remove a drug that still has stock at this branch", 4000, "error");
  }
  openConfirmModal({
    title: `Remove drug from ${currentBranch}`,
    confirmText: hasStock ? "Remove drug and branch stock" : "Remove from branch",
    icon: "ti-trash",
    body: `
          <p>Remove <strong>${sanitize(drug.name)}</strong> from ${sanitize(currentBranch)}?</p>
          <div class="confirm-context">
            <div><span>Form</span><strong>${sanitize(drug.form || "--")}</strong></div>
            <div><span>${sanitize(currentBranch)} stock</span><strong>${currentStock}</strong></div>
            <div><span>Stock at other branches</span><strong>${Math.max(0, totalStock - Number(currentStock || 0))}</strong></div>
          </div>
          <p class="confirm-note">${hasStock
            ? `Director confirmation will discard ${Number(currentStock) || currentBatchStock} unit(s) at ${sanitize(currentBranch)}. The drug and stock at other branches will remain unchanged.`
            : `The drug will disappear only from ${sanitize(currentBranch)}. Other branches will remain unchanged.`}</p>
        `,
    onConfirm: () => completeDeleteDrugItem(id, { force: hasStock })
  });
}

async function completeDeleteDrugItem(id, { force = false } = {}) {
  if (!requirePermission("deleteInventory", "Manager access required to delete inventory")) return;
  const drug = drugs.find(d => d.id === id);
  if (!drug) return showToast("Drug not found", 2500, "error");
  if (force && String(currentUser?.role || "").toLowerCase() !== "director") {
    return showToast("Only a director can remove a drug that still has stock at this branch", 4000, "error");
  }
  const branchId = getCurrentBranchId();
  const branchName = getCurrentBranchName();
  const branchStock = Number(drug.branchStock?.[branchName] ?? drug.stock ?? 0) || 0;
  if (!await saveMajorChangeBackup(`Before removing ${drug?.name || "inventory item"} from ${branchName}`)) return;
  const auditDetails = `Removed ${drug.name} from ${branchName}; discarded branch stock was ${branchStock}. Other branches were unchanged.`;
  try {
    await apiDelete(`/drugs/${id}`, {
      branch_id: branchId,
      branch: branchName,
      force
    }, { branch: branchId });
  } catch (error) {
    if (hasApiServer()) {
      console.warn(error);
      return showToast(error?.message || "Drug could not be deleted", 4500, "error");
    }
  }
  ensureDrugBranchAvailability(drug);
  drug.branchAvailability[branchName] = false;
  drug.branchStock = drug.branchStock || {};
  drug.branchStock[branchName] = 0;
  drug.stock = 0;
  drug.batches = normalizeDrugBatches(drug).filter(batch => batch.branch_id !== branchId);
  cart = cart.filter(item => item.id !== id);
  renderCart();
  recordAudit("inventory-delete-branch", auditDetails);
  saveDrugs();
  renderStockTransferForm();
  renderCategories();
  filterDrugs();
  renderInventoryAdmin();
  showToast(`${drug.name} was removed from ${branchName}. Other branches were not changed.`);
  if (editingDrugId === id) editingDrugId = null;
}

function renderAuditLog() {
  const list = document.getElementById("auditLogList");
  if (!list) return;
  const entries = getScopedRecords(auditLog).slice(0, 12);
  if (!entries.length) {
    renderHtml(list, `<div class="empty-cart"><i class="ti ti-list-check"></i><div>No audit entries yet</div></div>`);
    return;
  }
  renderHtml(list, entries.map(entry => `
        <div class="held-sale" data-key="${sanitize(entry.id || entry.timestamp)}">
          <div>
            <div class="item-name">${sanitize(String(entry.action).replace(/[-_]/g, ' '))}</div>
            <div class="held-meta">${new Date(entry.timestamp).toLocaleString('en-GH', { dateStyle: 'short', timeStyle: 'short' })} - ${sanitize(entry.user)} - ${sanitize(entry.branch)}</div>
          </div>
          <div class="item-total">${sanitize(entry.details || 'No details')}</div>
        </div>
      `).join(""));
}

function resetDrugEditor() {
  openDrugEditor(null);
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidNumber(value, { min = -Infinity } = {}) {
  return typeof value === "number" && Number.isFinite(value) && value >= min;
}

function validateDrugItem(drug, index) {
  const label = `Inventory row ${index + 1}`;
  if (!isPlainObject(drug)) return `${label} must be an object`;
  if (!isValidNumber(drug.id, { min: 1 })) return `${label}: id must be a positive number`;
  if (!String(drug.name || "").trim()) return `${label}: name is required`;
  if (!String(drug.cat || "").trim()) return `${label}: category is required`;
  if (!isValidNumber(drug.price, { min: 0 })) return `${label}: price must be a non-negative number`;
  if (!isValidNumber(drug.stock, { min: 0 })) return `${label}: stock must be a non-negative number`;
  if (drug.costPrice != null && !isValidNumber(drug.costPrice, { min: 0 })) return `${label}: cost price must be a non-negative number`;
  if (drug.lowStockThreshold != null && !isValidNumber(drug.lowStockThreshold, { min: 1 })) return `${label}: low-stock threshold must be a positive number`;
  if (drug.reorderPoint != null && !isValidNumber(drug.reorderPoint, { min: 1 })) return `${label}: reorder point must be a positive number`;
  if (drug.reorderQuantity != null && !isValidNumber(drug.reorderQuantity, { min: 0 })) return `${label}: reorder quantity must be a non-negative number`;
  if (drug.maxStock != null && !isValidNumber(drug.maxStock, { min: 0 })) return `${label}: maximum stock must be a non-negative number`;
  if (drug.branchStock != null) {
    if (!isPlainObject(drug.branchStock)) return `${label}: branchStock must be an object`;
    for (const [branch, qty] of Object.entries(drug.branchStock)) {
      if (!branches.includes(branch)) return `${label}: unknown branch "${branch}"`;
      if (!isValidNumber(qty, { min: 0 })) return `${label}: branch stock for ${branch} must be a non-negative number`;
    }
  }
  if (drug.batches != null) {
    if (!Array.isArray(drug.batches)) return `${label}: batches must be an array`;
    for (let batchIndex = 0; batchIndex < drug.batches.length; batchIndex++) {
      const batch = drug.batches[batchIndex];
      if (!isPlainObject(batch)) return `${label}: batch ${batchIndex + 1} must be an object`;
      if (!isValidNumber(batch.qty ?? 0, { min: 0 })) return `${label}: batch ${batchIndex + 1} quantity must be a non-negative number`;
    }
  }
  return null;
}

function validateInventoryImport(value) {
  if (!Array.isArray(value)) return { ok: false, message: "Inventory file must contain an array of drugs" };
  const ids = new Set();
  for (let i = 0; i < value.length; i++) {
    const error = validateDrugItem(value[i], i);
    if (error) return { ok: false, message: error };
    if (ids.has(value[i].id)) return { ok: false, message: `Inventory row ${i + 1}: duplicate drug id ${value[i].id}` };
    ids.add(value[i].id);
  }
  return { ok: true, value };
}

function validateCustomerItem(customer, index) {
  const label = `Customer row ${index + 1}`;
  if (!isPlainObject(customer)) return `${label} must be an object`;
  if (!isValidNumber(customer.id, { min: 1 })) return `${label}: id must be a positive number`;
  if (!String(customer.name || "").trim()) return `${label}: name is required`;
  if (customer.balance != null && !isValidNumber(customer.balance, { min: 0 })) return `${label}: balance must be a non-negative number`;
  return null;
}

function validateCustomersImport(value) {
  if (!Array.isArray(value)) return { ok: false, message: "customers must be an array" };
  const ids = new Set();
  for (let i = 0; i < value.length; i++) {
    const error = validateCustomerItem(value[i], i);
    if (error) return { ok: false, message: error };
    if (ids.has(value[i].id)) return { ok: false, message: `Customer row ${i + 1}: duplicate customer id ${value[i].id}` };
    ids.add(value[i].id);
  }
  return { ok: true, value };
}

function validateSaleItem(item, index, context = "Sale item") {
  const label = `${context} ${index + 1}`;
  if (!isPlainObject(item)) return `${label} must be an object`;
  if (!isValidNumber(item.id, { min: 1 })) return `${label}: id must be a positive number`;
  if (!String(item.name || "").trim()) return `${label}: name is required`;
  if (!isValidNumber(item.qty, { min: 1 })) return `${label}: quantity must be a positive number`;
  if (!isValidNumber(item.price, { min: 0 })) return `${label}: price must be a non-negative number`;
  return null;
}

function validateSaleRecord(sale, index) {
  const label = `Sale row ${index + 1}`;
  if (!isPlainObject(sale)) return `${label} must be an object`;
  if (!String(sale.id || "").trim()) return `${label}: id is required`;
  if (!sale.date || Number.isNaN(new Date(sale.date).getTime())) return `${label}: date is invalid`;
  if (!Array.isArray(sale.items) || !sale.items.length) return `${label}: items must be a non-empty array`;
  for (let i = 0; i < sale.items.length; i++) {
    const error = validateSaleItem(sale.items[i], i, `${label} item`);
    if (error) return error;
  }
  const isRefund = !!sale.refundAgainst || Number(sale.total) < 0;
  if (!isValidNumber(sale.total, isRefund ? {} : { min: 0 })) return `${label}: total is invalid`;
  if (sale.paid != null && !isValidNumber(sale.paid, isRefund ? {} : { min: 0 })) return `${label}: paid is invalid`;
  if (sale.discount != null && !isValidNumber(sale.discount, { min: 0 })) return `${label}: discount must be a non-negative number`;
  return null;
}

function validateSalesImport(value) {
  if (!Array.isArray(value)) return { ok: false, message: "Sales history file must contain an array of sales" };
  const ids = new Set();
  for (let i = 0; i < value.length; i++) {
    const error = validateSaleRecord(value[i], i);
    if (error) return { ok: false, message: error };
    if (ids.has(value[i].id)) return { ok: false, message: `Sale row ${i + 1}: duplicate sale id ${value[i].id}` };
    ids.add(value[i].id);
  }
  return { ok: true, value };
}

function validateHeldSaleRecord(sale, index) {
  const label = `Held sale row ${index + 1}`;
  if (!isPlainObject(sale)) return `${label} must be an object`;
  if (!String(sale.id || "").trim()) return `${label}: id is required`;
  if (!String(sale.customer || "").trim()) return `${label}: customer is required`;
  if (sale.customerId != null && !isValidNumber(Number(sale.customerId), { min: 1 })) return `${label}: customerId must be a positive number`;
  if (!Array.isArray(sale.cart) || !sale.cart.length) return `${label}: cart must be a non-empty array`;
  for (let i = 0; i < sale.cart.length; i++) {
    const error = validateSaleItem(sale.cart[i], i, `${label} cart item`);
    if (error) return error;
  }
  if (!isValidNumber(sale.total, { min: 0 })) return `${label}: total must be a non-negative number`;
  return null;
}

function validateHeldSalesImport(value) {
  if (!Array.isArray(value)) return { ok: false, message: "heldSales must be an array" };
  for (let i = 0; i < value.length; i++) {
    const error = validateHeldSaleRecord(value[i], i);
    if (error) return { ok: false, message: error };
  }
  return { ok: true, value };
}

function validateShiftHoursImport(value) {
  if (!isPlainObject(value)) return { ok: false, message: "shiftHours must be an object" };
  for (const [date, records] of Object.entries(value)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isPlainObject(records)) return { ok: false, message: `Invalid shiftHours entry for ${date}` };
    for (const [username, seconds] of Object.entries(records)) {
      if (!String(username || "").trim() || !isValidNumber(seconds, { min: 0 })) return { ok: false, message: `Invalid shift hours for ${date}` };
    }
  }
  return { ok: true, value };
}

function validateReferenceDrugsImport(value) {
  if (!Array.isArray(value)) return { ok: false, message: "referenceDrugs must be an array" };
  for (let index = 0; index < value.length; index++) {
    const row = value[index];
    if (!Array.isArray(row) || row.length < 5) return { ok: false, message: `Reference row ${index + 1} must contain five columns` };
    if (!String(row[0] || "").trim()) return { ok: false, message: `Reference row ${index + 1}: generic name is required` };
    if (!String(row[3] || "").trim()) return { ok: false, message: `Reference row ${index + 1}: dosage form is required` };
    if (!String(row[4] || "").trim()) return { ok: false, message: `Reference row ${index + 1}: category is required` };
  }
  return { ok: true, value: dedupeReferenceDrugs(value.map(row => row.slice(0, 5).map(cell => String(cell || "").trim()))) };
}

function validateFullDataImport(data) {
  if (!isPlainObject(data)) return { ok: false, message: "Data file must contain an object" };
  const source = isPlainObject(data.data) ? data.data : data;
  const allowedKeys = [
    "drugs", "customers", "salesHistory", "heldSales", "shiftHours", "referenceDrugs",
    "auditLog", "suppliers", "purchaseHistory", "draftPurchaseOrders", "stockAdjustments",
    "branchRecords", "appSettings"
  ];
  const presentKeys = allowedKeys.filter(key => Object.prototype.hasOwnProperty.call(source, key));
  if (!presentKeys.length) return { ok: false, message: "Data file does not contain recognized POS data" };
  const validators = {
    drugs: validateInventoryImport,
    customers: validateCustomersImport,
    salesHistory: validateSalesImport,
    heldSales: validateHeldSalesImport,
    shiftHours: validateShiftHoursImport,
    referenceDrugs: validateReferenceDrugsImport,
    auditLog: value => Array.isArray(value) ? { ok: true, value } : { ok: false, message: "auditLog must be an array" },
    suppliers: value => Array.isArray(value) ? { ok: true, value } : { ok: false, message: "suppliers must be an array" },
    purchaseHistory: value => Array.isArray(value) ? { ok: true, value } : { ok: false, message: "purchaseHistory must be an array" },
    draftPurchaseOrders: value => Array.isArray(value) ? { ok: true, value } : { ok: false, message: "draftPurchaseOrders must be an array" },
    stockAdjustments: value => Array.isArray(value) ? { ok: true, value } : { ok: false, message: "stockAdjustments must be an array" },
    branchRecords: value => Array.isArray(value) && value.length ? { ok: true, value } : { ok: false, message: "branchRecords must be a non-empty array" },
    appSettings: value => isPlainObject(value) ? { ok: true, value } : { ok: false, message: "appSettings must be an object" }
  };
  for (const key of presentKeys) {
    const result = validators[key](source[key]);
    if (!result.ok) return { ok: false, message: `${key}: ${result.message}` };
  }
  return { ok: true, value: source };
}

function readJsonFile(event, onValidJson, invalidMessage) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    let parsed;
    try {
      parsed = JSON.parse(e.target.result);
    } catch {
      showToast(invalidMessage, 2500, "error");
      event.target.value = "";
      return;
    }
    try {
      await onValidJson(parsed);
    } catch (error) {
      console.error(error);
      showToast("Import failed", 3500, "error");
    } finally {
      event.target.value = "";
    }
  };
  reader.readAsText(file);
}

function exportInventory() {
  if (!requirePermission("exportBackup", "Manager access required to export inventory")) return;
  downloadJson(`inventory-${backupDateStamp()}.json`, drugs);
  showToast("Inventory exported");
}
function importInventory(event) {
  if (!requirePermission("importData", "Director access required to import inventory")) { event.target.value = ""; return; }
  readJsonFile(event, async data => {
    const result = validateInventoryImport(data);
    if (!result.ok) return showToast(result.message, 3500, "error");
    if (!await saveMajorChangeBackup("Before inventory import")) return;
    if (hasApiServer() && getSessionToken()) {
      await apiPost("/sync", { drugs: result.value }, { branch: "all" });
    }
    drugs = result.value;
    normalizeDrugThresholds();
    ensureDrugBranchStock();
    updateBranchStocksToCurrent();
    renderCategories();
    filterDrugs();
    renderInventoryAdmin();
    renderStockTransferForm();
    persistAll();
    if (hasApiServer() && getSessionToken()) await refreshServerData({ silent: true });
    showToast("Inventory imported");
  }, "Invalid inventory file");
}
function getLowStockItems() {
  // Ensure branch-specific stocks are applied
  updateBranchStocksToCurrent();
  return getAvailableDrugsForBranch()
    .filter(isDrugLowStock)
    .map(d => ({ id: d.id, name: d.name, brand: d.brand || "", form: d.form || "", cat: d.cat || "", stock: d.stock, threshold: getDrugLowThreshold(d) }));
}

function printLowStock() {
  const items = getLowStockItems();
  const branch = getCurrentBranchName() || "Main";
  const now = new Date().toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" });
  let html = '<!doctype html><html><head><meta charset="utf-8"><title>Low stock list</title>' +
    '<style>body{font-family:Arial,Helvetica,sans-serif;color:#111;padding:18px}h1{font-size:18px}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{padding:8px;text-align:left;border-bottom:1px solid #eee;font-size:13px}th{background:#f7f9fc}</style>' +
    '</head><body>';
  html += '<h1>AkoPharm Pharmacy - Low Stock List</h1>';
  html += '<div>' + sanitize(branch) + ' - ' + sanitize(now) + '</div>';
  html += '<div style="margin-top:8px">Contact: +233248718050 | +233541100007 - akopharmahcompanylimited.com.gh</div>';
  html += '<table><thead><tr><th>Item</th><th>Brand</th><th>Form</th><th>Category</th><th>Stock</th><th>Threshold</th></tr></thead><tbody>';
  items.forEach(function (it) {
    html += '<tr><td>' + sanitize(it.name) + '</td><td>' + sanitize(it.brand || '') + '</td><td>' + sanitize(it.form || '') + '</td><td>' + sanitize(it.cat || '') + '</td><td>' + sanitize(it.stock) + '</td><td>' + sanitize(it.threshold) + '</td></tr>';
  });
  if (!items.length) html += '<tr><td colspan="6">No low-stock items found.</td></tr>';
  html += '</tbody></table>';
  html += '<script>window.onload=function(){window.print();setTimeout(function(){window.close();},300);}<\/script>';
  html += '</body></html>';
  const w = window.open('', '_blank');
  if (!w) { showToast('Popup blocked - allow popups to print', 2500, 'error'); return }
  w.document.write(html);
  w.document.close();
  showToast(`Prepared ${items.length} low-stock item(s) for printing`);
}

function updateLowStockBadge() {
  const items = getLowStockItems();
  const el = document.getElementById('lowStockBadge');
  if (!el) return;
  el.textContent = items.length;
  el.style.display = items.length ? 'inline-block' : 'none';
}

function downloadCsv(filename, rows) {
  const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function showHiddenElement(el, display = "block") {
  if (!el) return;
  el.classList.remove("is-hidden");
  el.style.display = display;
}

function hideHiddenElement(el) {
  if (!el) return;
  el.style.display = "none";
  el.classList.add("is-hidden");
}

function spreadsheetCell(value) {
  if (typeof value === "number") return value;
  const text = String(value ?? "");
  return /^[=+\-@]/.test(text.trim()) ? `'${text}` : text;
}

function downloadExcel(filename, worksheetTitle, rows) {
  const tableRows = rows.map((row, rowIndex) => {
    const tag = rowIndex === 0 ? "th" : "td";
    return `<tr>${row.map(cell => `<${tag}>${sanitize(spreadsheetCell(cell))}</${tag}>`).join("")}</tr>`;
  }).join("");
  const workbook = `<!doctype html>
        <html>
          <head>
            <meta charset="utf-8">
            <style>
              body{font-family:Arial,Helvetica,sans-serif;color:#111}
              h1{font-size:18px;margin:0 0 6px}
              .meta{margin:0 0 12px;color:#475569;font-size:12px}
              table{border-collapse:collapse;width:100%}
              th,td{border:1px solid #d9e2ef;padding:8px;text-align:left;font-size:12px}
              th{background:#eaf2ff;font-weight:700}
            </style>
          </head>
          <body>
            <h1>${sanitize(worksheetTitle)}</h1>
            <div class="meta">Branch: ${sanitize(getCurrentBranchName() || "Main")} | Generated: ${sanitize(new Date().toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" }))}</div>
            <table>${tableRows}</table>
          </body>
        </html>`;
  const blob = new Blob(["\ufeff", workbook], { type: "application/vnd.ms-excel;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

function showLowStockPreview() {
  inventoryViewMode = 'low';
  renderInventoryAdmin();
  const items = getLowStockItems();
  const body = document.getElementById('lowStockPreviewBody');
  const no = document.getElementById('lowStockPreviewNo');
  const count = document.getElementById('lowStockPreviewCount');
  count.textContent = `${items.length} low-stock item(s)`;
  if (!items.length) {
    renderHtml(body, "");
    showHiddenElement(no);
  } else {
    hideHiddenElement(no);
    renderHtml(body, items.map(item => `
          <tr>
            <td>${sanitize(item.name)}</td>
            <td>${sanitize(item.brand || '--')}</td>
            <td>${sanitize(item.form || '--')}</td>
            <td>${sanitize(item.cat || '--')}</td>
            <td>${item.stock}</td>
            <td>${item.threshold}</td>
          </tr>
        `).join(""));
  }
  showView('lowstock');
}

function exportLowStockExcel() {
  const items = getLowStockItems();
  if (!items.length) { showToast('No low-stock items', 2500, 'warning'); return; }
  const rows = [['Item', 'Brand', 'Form', 'Category', 'Stock', 'Threshold']].concat(
    items.map(i => [i.name, i.brand || '', i.form || '', i.cat || '', Number(i.stock || 0), Number(i.threshold || 0)])
  );
  downloadExcel(`low-stock-${new Date().toISOString().slice(0, 10)}.xls`, 'Akopharmah Pharmacy - Low Stock List', rows);
  showToast(`Exported ${items.length} low-stock item(s) to Excel`);
}

function importData(event) {
  if (!requirePermission("importData", "Director access required to import data")) { event.target.value = ""; return; }
  readJsonFile(event, async data => {
    try {
      data = await decryptBackupPayload(data);
    } catch (error) {
      return showToast(error.message || "Backup could not be decrypted", 3500, "error");
    }
    const result = validateFullDataImport(data);
    if (!result.ok) return showToast(result.message, 3500, "error");
    if (hasApiServer() && String(currentUser?.role || "").toLowerCase() !== "director") {
      return showToast("Only a director can restore a full backup to the server", 3500, "error");
    }
    if (!await saveMajorChangeBackup("Before full data import")) return;
    const validated = result.value;
    if (hasApiServer() && getSessionToken()) {
      for (const branch of validated.branchRecords || branchRecords) await apiPost("/branches", { branch }, { branch: null });
      await apiPost("/sync", {
        restore: true,
        drugs: validated.drugs || [],
        customers: validated.customers || [],
        suppliers: validated.suppliers || [],
        salesHistory: validated.salesHistory || [],
        purchaseHistory: validated.purchaseHistory || [],
        auditLog: validated.auditLog || []
      }, { branch: "all" });
    }
    if (Object.prototype.hasOwnProperty.call(validated, "drugs")) drugs = validated.drugs;
    if (Object.prototype.hasOwnProperty.call(validated, "customers")) customers = validated.customers;
    if (Object.prototype.hasOwnProperty.call(validated, "salesHistory")) salesHistory = validated.salesHistory;
    if (Object.prototype.hasOwnProperty.call(validated, "heldSales")) heldSales = validated.heldSales;
    if (Object.prototype.hasOwnProperty.call(validated, "shiftHours")) shiftHours = validated.shiftHours;
    if (Object.prototype.hasOwnProperty.call(validated, "referenceDrugs")) referenceDrugs = validated.referenceDrugs;
    if (Object.prototype.hasOwnProperty.call(validated, "auditLog")) auditLog = validated.auditLog;
    if (Object.prototype.hasOwnProperty.call(validated, "suppliers")) suppliers = validated.suppliers;
    if (Object.prototype.hasOwnProperty.call(validated, "purchaseHistory")) purchaseHistory = validated.purchaseHistory;
    if (Object.prototype.hasOwnProperty.call(validated, "draftPurchaseOrders")) draftPurchaseOrders = validated.draftPurchaseOrders;
    if (Object.prototype.hasOwnProperty.call(validated, "stockAdjustments")) stockAdjustments = validated.stockAdjustments;
    if (Object.prototype.hasOwnProperty.call(validated, "branchRecords")) {
      branchRecords = validated.branchRecords.map(normalizeBranchRecordLocal);
      refreshBranchNames();
      initBranchSelect();
    }
    if (Object.prototype.hasOwnProperty.call(validated, "appSettings")) saveAppSettings(validated.appSettings);
    normalizeDrugThresholds();
    ensureDrugBranchStock();
    updateBranchStocksToCurrent();
    renderCategories();
    filterDrugs();
    renderCustomerOptions();
    renderHeld();
    renderHistory();
    renderReferenceCategories();
    renderReference();
    renderInventoryAdmin();
    renderStockTransferForm();
    updateSummary();
    persistAll();
    if (hasApiServer() && getSessionToken()) {
      await refreshServerData({ silent: true });
    }
    showToast("Data imported");
  }, "Invalid data file");
}
async function exportSalesHistory() {
  if (!requirePermission("exportBackup", "Manager access required to export sales history")) return;
  let encrypted;
  try {
    encrypted = await encryptBackupPayload({ app: "Akopharmah POS", type: "salesHistory", data: salesHistory });
  } catch (error) {
    return showToast(error.message || "Sales export could not be encrypted", 3500, "error");
  }
  downloadJson(`sales-history-${backupDateStamp()}.encrypted.json`, encrypted);
  showToast("History exported");
}
function importSalesHistory(event) {
  if (!requirePermission("importData", "Director access required to import sales history")) { event.target.value = ""; return; }
  readJsonFile(event, async data => {
    try {
      data = await decryptBackupPayload(data);
    } catch (error) {
      return showToast(error.message || "Sales history could not be decrypted", 3500, "error");
    }
    if (isPlainObject(data) && data.type === "salesHistory") data = data.data;
    const result = validateSalesImport(data);
    if (!result.ok) return showToast(result.message, 3500, "error");
    if (hasApiServer() && String(currentUser?.role || "").toLowerCase() !== "director") {
      return showToast("Only a director can restore sales history to the server", 3500, "error");
    }
    if (!await saveMajorChangeBackup("Before sales history import")) return;
    if (hasApiServer() && getSessionToken()) {
      await apiPost("/sync", { restore: true, salesHistory: result.value }, { branch: "all" });
    }
    salesHistory = result.value;
    renderHistory();
    updateSummary();
    persistAll();
    if (hasApiServer() && getSessionToken()) {
      await refreshServerData({ silent: true });
    }
    showToast("History imported");
  }, "Invalid history file");
}


function printReceipt() {
  const receipt = document.querySelector("#view-receipt .receipt-card");
  if (!receipt) return showToast("No receipt available", 2500, "error");
  applyReceiptSettings();
  const settings = getAppSettings();
  const paperWidth = String(settings.receiptPaperWidth || "80") === "58" ? 58 : 80;
  const cardWidth = Math.max(50, paperWidth - 8);
  const printable = receipt.cloneNode(true);
  const actions = printable.querySelector(".receipt-actions");
  if (actions) actions.remove();
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>AkoPharm Receipt</title>
  <style>
    @page { size: ${paperWidth}mm auto; margin: 4mm; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #fff; color: #000; font-family: Arial, Helvetica, sans-serif; }
    .receipt-card { width: ${cardWidth}mm; margin: 0 auto; padding: 0; border: 0; box-shadow: none; }
    .receipt-header { text-align: center; margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px dashed #000; }
    .receipt-logo { display: none; }
    .receipt-title { font-size: 16px; font-weight: 700; }
    .receipt-sub, .receipt-row, .receipt-footer { font-size: 11px; line-height: 1.35; }
    .receipt-items { margin: 10px 0; }
    .receipt-table-header, .receipt-table-row { display: grid; grid-template-columns: 1.8fr .55fr .9fr; gap: 4px; padding: 5px 0; font-size: 10px; border-bottom: 1px dotted #999; }
    .receipt-table-header { font-weight: 700; border-bottom: 1px solid #000; }
    .receipt-row { display: flex; justify-content: space-between; padding: 3px 0; }
    .receipt-row.grand { margin-top: 5px; padding-top: 6px; border-top: 1px solid #000; font-weight: 700; font-size: 13px; }
    .receipt-footer { text-align: center; margin-top: 10px; padding-top: 8px; border-top: 1px dashed #000; }
    i { display: none; }
  </style>
</head>
<body>${printable.outerHTML}<script>window.onload=function(){window.focus();window.print();setTimeout(function(){window.close();},500);};<\/script></body>
</html>`;
  const printWindow = window.open("", "akopharm-receipt-print", "width=420,height=640");
  if (!printWindow) return showToast("Popup blocked - allow popups to print", 2500, "error");
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
  showToast("Receipt print dialog opened");
}
function sendToWhatsApp() {
  // Build a plain-text receipt from the currently displayed receipt
  const settings = getAppSettings();
  const branch = document.getElementById("rcBranch")?.textContent || "";
  const date = document.getElementById("rcDate")?.textContent || "";
  const ref = document.getElementById("rcRef")?.textContent || "";
  const sub = document.getElementById("rcSub")?.textContent || "";
  const total = document.getElementById("rcTotal")?.textContent || "";
  const payment = document.getElementById("rcPay")?.textContent || "";

  // Collect line items from the receipt table rows
  const itemEls = document.querySelectorAll("#rcItems .receipt-table-row");
  const itemLines = Array.from(itemEls).map(row => {
    const cells = row.querySelectorAll("strong, span");
    return Array.from(cells).map(c => c.textContent.trim()).join("  ");
  });

  const text = [
    `*${settings.pharmacyName || "Akopharmah Pharmacy"}*`,
    branch, date, ref,
    "-----------------",
    ...itemLines,
    "-----------------",
    `Subtotal: ${sub}`,
    `Total: *${total}*`,
    `Payment: ${payment}`,
    "-----------------",
    settings.receiptFooter || "Thank you for your purchase!",
    settings.pharmacyPhone || "+233248718050 | +233541100007",
    "akopharmahcompanylimited.com.gh"
  ].join("\n");

  // Use the selected customer's phone if available, else open chat picker
  const customer = customers.find(c => c.id === selectedCustomerId);
  const phone = customer?.phone ? customer.phone.replace(/\D/g, "") : "";
  const url = phone
    ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}`
    : `https://wa.me/?text=${encodeURIComponent(text)}`;

  window.open(url, "_blank");
}
function newSale() { showView("pos"); }
