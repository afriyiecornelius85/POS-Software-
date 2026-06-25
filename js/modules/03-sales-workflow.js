function recordPatientSaleSnapshot(sale) {
  if (!sale?.customerId) return;
  const patient = getPatientById(sale.customerId);
  if (!patient || String(patient.name || "").toLowerCase() === "walk-in") return;
  normalizePatientProfile(patient);
  patient.lastVisit = sale.date;
  if (sale.prescription && !patient.medicalRecords.some(record => record.saleId === sale.id)) {
    patient.medicalRecords.unshift({
      id: makeClientId("RX"),
      type: "Prescription",
      date: sale.date,
      note: `Prescription ${sale.prescription} dispensed: ${(sale.items || []).map(item => `${item.name} x${item.qty}`).join(", ")}`,
      saleId: sale.id,
      by: currentUser?.username || "system"
    });
  }
  saveCustomers();
}

function renderCategories() {
  const categories = ["All", ...new Set(getAvailableDrugsForBranch().map(d => d.cat))];
  renderHtml(document.getElementById("catRow"), categories.map(cat => `
        <button class="cat-btn${cat === activeCat ? " active" : ""}" data-cat="${sanitize(cat ?? "")}" onclick="setCategory(this.dataset.cat)">${sanitize(cat || "Uncategorized")}</button>
      `).join(""));
}

function setCategory(cat) {
  activeCat = cat;
  renderCategories();
  filterDrugs();
}

function stockLabel(drug) {
  const stock = Number(drug.stock ?? 0);
  if (stock === 0) return `<span class="stock-pill stock-out">Out</span>`;
  const unit = formatDrugSaleUnit(drug, stock).toLowerCase();
  if (isDrugLowStock(drug)) return `<span class="stock-pill stock-low">${stock} ${sanitize(unit)} left</span>`;
  return `<span class="stock-pill stock-ok">${stock} ${sanitize(unit)}</span>`;
}

let _filterDrugsTimer = null;
function debouncedFilterDrugs() {
  clearTimeout(_filterDrugsTimer);
  _filterDrugsTimer = setTimeout(filterDrugs, 200);
}

function filterDrugs() {
  const query = document.getElementById("searchInput").value.trim().toLowerCase();
  const grid = document.getElementById("drugGrid");
  const list = getAvailableDrugsForBranch().filter(drug => {
    const name = String(drug.name || "");
    const category = String(drug.cat || "");
    const matchCategory = activeCat === "All" || category === activeCat;
    const matchText = !query || name.toLowerCase().includes(query) || category.toLowerCase().includes(query) || String(drug.brand || "").toLowerCase().includes(query) || String(drug.barcode || "").toLowerCase().includes(query);
    return matchCategory && matchText;
  });
  renderHtml(grid, list.length ? list.map(drug => {
    const stock = Number(drug.stock ?? 0);
    const drugId = Number(drug.id);
    const isSelectable = stock > 0 && Number.isFinite(drugId);
    return `
        <div class="drug-list-item${stock === 0 ? ' out' : ''}" data-key="drug-${drugId}" ${isSelectable ? `role="button" tabindex="0" onclick="addToCart(${drugId})" onkeydown="handleDrugSelectKeydown(event, ${drugId})"` : `aria-disabled="true"`}>
          <div class="dc-cat">${sanitize(drug.cat)}</div>
          <div class="dc-name">${sanitize(drug.name)}</div>
          <div class="dc-form">${sanitize(drug.form)} - sold per ${sanitize(getDrugSaleUnit(drug))}</div>
          <div class="dc-bottom">
            <div class="dc-price">GHS ${Number(drug.price || 0).toFixed(2)}</div>
            ${stockLabel(drug)}
          </div>
          ${drug.rx ? `<div class="rx-badge"><i class="ti ti-certificate"></i> Rx</div>` : ""}
        </div>
      `;
  }).join("") : '<div style="grid-column:1/-1;text-align:center;color:var(--muted);padding:30px;font-size:14px;">No products found</div>');
}

// ── Override reason modal (pharmacist interaction override) ────────────
function handleDrugSelectKeydown(event, id) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  event.stopPropagation();
  addToCart(id);
}

function openOverrideReasonModal(pairs, defaultReason) {
  return new Promise(resolve => {
    const modal = document.getElementById("overrideReasonModal");
    const pairsEl = document.getElementById("ormPairs");
    const reasonEl = document.getElementById("ormReason");
    const submitBtn = document.getElementById("ormSubmit");
    const cancelBtn = document.getElementById("ormCancel");
    if (!modal) { resolve(null); return; }
    pairsEl.textContent = pairs;
    reasonEl.value = defaultReason || "";
    modal.style.display = "flex";
    function cleanup() {
      modal.style.display = "none";
      submitBtn.removeEventListener("click", onSubmit);
      cancelBtn.removeEventListener("click", onCancel);
    }
    function onSubmit() {
      const val = reasonEl.value.trim();
      if (!val) { showToast("Please enter an override reason", 2000, "warning"); return; }
      cleanup(); resolve(val);
    }
    function onCancel() { cleanup(); resolve(null); }
    submitBtn.addEventListener("click", onSubmit);
    cancelBtn.addEventListener("click", onCancel);
    setTimeout(() => reasonEl.focus(), 60);
  });
}

// ── Price override modal ───────────────────────────────────────────────
function openPriceOverrideModal(drugName, currentPrice) {
  return new Promise(resolve => {
    const modal = document.getElementById("priceOverrideModal");
    const nameEl = document.getElementById("pomDrugName");
    const inputEl = document.getElementById("pomPrice");
    const submitBtn = document.getElementById("pomSubmit");
    const cancelBtn = document.getElementById("pomCancel");
    if (!modal) { resolve(null); return; }
    nameEl.textContent = drugName;
    inputEl.value = currentPrice.toFixed(2);
    modal.style.display = "flex";
    function cleanup() {
      modal.style.display = "none";
      submitBtn.removeEventListener("click", onSubmit);
      cancelBtn.removeEventListener("click", onCancel);
    }
    function onSubmit() {
      const val = parseFloat(inputEl.value);
      if (Number.isNaN(val) || val < 0) { showToast("Enter a valid price", 2000, "warning"); return; }
      cleanup(); resolve(parseFloat(val.toFixed(2)));
    }
    function onCancel() { cleanup(); resolve(null); }
    submitBtn.addEventListener("click", onSubmit);
    cancelBtn.addEventListener("click", onCancel);
    setTimeout(() => { inputEl.focus(); inputEl.select(); }, 60);
  });
}

function normalizeInteractionText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9+ ]+/g, " ").replace(/\s+/g, " ").trim();
}

function interactionDrugText(item) {
  return normalizeInteractionText([item.name, item.brand, item.dose, item.form, item.cat].join(" "));
}

function matchesInteractionTerm(item, terms) {
  const text = interactionDrugText(item);
  return terms.some(term => text.includes(normalizeInteractionText(term)));
}

function getInteractionSource(rule) {
  if (!rule?.source) return null;
  if (typeof rule.source === "string") return INTERACTION_SOURCES[rule.source] || null;
  if (typeof rule.source === "object") return rule.source;
  return null;
}

function safeExternalHref(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.href : "#";
  } catch (_) {
    return "#";
  }
}

function findCartInteractions(items = cart) {
  const alerts = [];
  const seen = new Set();
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const first = items[i];
      const second = items[j];
      DRUG_INTERACTION_RULES.forEach((rule, ruleIndex) => {
        const forward = matchesInteractionTerm(first, rule.a) && matchesInteractionTerm(second, rule.b);
        const reverse = matchesInteractionTerm(first, rule.b) && matchesInteractionTerm(second, rule.a);
        if (!forward && !reverse) return;
        const [lowId, highId] = [first.id, second.id].sort((a, b) => a - b);
        const key = `${ruleIndex}:${lowId}:${highId}`;
        if (seen.has(key)) return;
        seen.add(key);
        alerts.push({ ...rule, first, second, meta: INTERACTION_SEVERITY[rule.severity] || INTERACTION_SEVERITY.monitor });
      });
    }
  }
  return alerts.sort((a, b) => b.meta.rank - a.meta.rank);
}

function getBlockingInteractions(items = cart) {
  return findCartInteractions(items).filter(alert => alert.meta.blocksCheckout);
}

function summarizeInteractionsForSale(alerts) {
  return alerts.map(alert => ({
    severity: alert.severity,
    label: alert.meta.label,
    firstDrug: alert.first.name,
    secondDrug: alert.second.name,
    mechanism: alert.mechanism,
    action: alert.action,
    source: getInteractionSource(alert)?.name || "",
    sourceUrl: getInteractionSource(alert)?.url || ""
  }));
}

// Interaction review modal
// openInteractionReviewModal() is async and resolves with the chosen option
// object (or null if cancelled). Called by checkout().
function openInteractionReviewModal(blockingInteractions) {
  return new Promise(resolve => {
    const pairs = blockingInteractions.map(a => `<li><strong>${sanitize(a.first.name)}</strong> + <strong>${sanitize(a.second.name)}</strong></li>`).join("");
    const modal = document.getElementById("interactionReviewModal");
    const pairsEl = document.getElementById("irmPairs");
    const noteEl = document.getElementById("irmNote");
    const submitBtn = document.getElementById("irmSubmit");
    const cancelBtn = document.getElementById("irmCancel");
    if (!modal) { resolve(null); return; }
    renderHtml(pairsEl, `<ul style="margin:8px 0 0 16px;">${pairs}</ul>`);
    noteEl.value = "";
    // Clear any previous radio selection
    modal.querySelectorAll("input[name='irmOption']").forEach(r => r.checked = false);
    modal.style.display = "flex";
    const REVIEW_OPTIONS = {
      "same-patient": { code: "same-patient", label: "Same patient - pharmacist/manager required", needsOverride: true },
      "different-patients": { code: "different-patients", label: "Different patients", needsOverride: false },
      "patient-counselled": { code: "patient-counselled", label: "Patient already counselled", needsOverride: false },
      "prescriber-confirmed": { code: "prescriber-confirmed", label: "Prescriber confirmed", needsOverride: false }
    };
    function cleanup() {
      modal.style.display = "none";
      submitBtn.removeEventListener("click", onSubmit);
      cancelBtn.removeEventListener("click", onCancel);
    }
    function onSubmit() {
      const selected = modal.querySelector("input[name='irmOption']:checked");
      if (!selected) { showToast("Please select one option", 2000, "warning"); return; }
      const option = REVIEW_OPTIONS[selected.value];
      if (!option) { cleanup(); resolve(null); return; }
      cleanup();
      resolve({ ...option, note: noteEl.value.trim() });
    }
    function onCancel() { cleanup(); resolve(null); }
    submitBtn.addEventListener("click", onSubmit);
    cancelBtn.addEventListener("click", onCancel);
  });
}

// Kept for backward compatibility - checkout() now calls openInteractionReviewModal
function getInteractionReviewChoice(blockingInteractions) {
  return openInteractionReviewModal(blockingInteractions);
}

function renderInteractionAlerts() {
  const panel = document.getElementById("interactionAlerts");
  if (!panel) return [];
  const alerts = findCartInteractions();
  if (!alerts.length) {
    panel.style.display = "none";
    panel.className = "interaction-alert panel-card";
    renderHtml(panel, "");
    return alerts;
  }
  const highest = alerts[0].severity;
  const blocking = alerts.some(alert => alert.meta.blocksCheckout);
  const canOverride = blocking && hasPermission("overrideInteractions");
  panel.style.display = "flex";
  panel.className = `interaction-alert panel-card ${highest}`;
  renderHtml(panel, `
        <div class="interaction-alert-head">
          <i class="ti ti-alert-triangle"></i>
          <div>
            ${blocking ? "Serious interaction: Avoid combination" : "Drug interaction warning"}
            <div class="interaction-alert-note">${canOverride ? "Pharmacist/manager can override at checkout with a documented reason." : "Worker must classify the warning at checkout. Same-patient combinations require pharmacist/manager approval."}</div>
          </div>
        </div>
        <div class="interaction-alert-list">
          ${alerts.map(alert => `
            <div class="interaction-alert-item">
              <strong>${sanitize(alert.meta.label)}: ${sanitize(alert.first.name)} + ${sanitize(alert.second.name)}</strong>
              <div>${sanitize(alert.mechanism)}</div>
              <div><strong>Action:</strong> ${sanitize(alert.action)}</div>
              ${getInteractionSource(alert) ? `<div><strong>Source:</strong> <a href="${sanitize(safeExternalHref(getInteractionSource(alert).url))}" target="_blank" rel="noopener">${sanitize(getInteractionSource(alert).name)}</a></div>` : ""}
            </div>
          `).join("")}
        </div>
  `);
  return alerts;
}

function addToCart(id) {
  const previousBlockingCount = getBlockingInteractions().length;
  const drug = drugs.find(d => d.id === id);
  if (!drug) return;
  if (!isDrugAvailableAtBranch(drug)) {
    showToast(`${drug.name} is not available at this branch`, 3000, "error");
    return;
  }
  if (drug.stock === 0) {
    showToast(`${drug.name} is out of stock`, 2500, "warning");
    return;
  }
  const item = cart.find(i => i.id === id);
  if (item) {
    if (item.qty < drug.stock) item.qty++;
    else return showToast("Max stock reached", 2500, "warning");
  } else {
    cart.push({ ...drug, qty: 1 });
    if (isDrugLowStock(drug)) showToast(`Low stock: ${drug.name} (${drug.stock} left)`, 2500, "warning");
  }
  renderCart();
  focusCartQuantity(id);
  const blockingCount = getBlockingInteractions().length;
  if (blockingCount > previousBlockingCount) showToast("Serious interaction: Avoid combination", 3500, "error");
}

function changeQty(id, delta) {
  const item = cart.find(i => i.id === id);
  if (!item) return;
  const drug = drugs.find(d => d.id === id);
  const next = item.qty + delta;
  if (delta > 0 && drug && next > Number(drug.stock || 0)) {
    return showToast("Max stock reached", 2500, "warning");
  }
  item.qty = next;
  if (item.qty <= 0) cart = cart.filter(i => i.id !== id);
  renderCart();
}

function setQty(id, value) {
  const item = cart.find(i => i.id === id);
  if (!item) return;
  const qty = parseInt(value, 10);
  if (Number.isNaN(qty) || qty < 1) {
    cart = cart.filter(i => i.id !== id);
  } else {
    const drug = drugs.find(d => d.id === id);
    if (drug && qty > drug.stock) {
      item.qty = drug.stock;
      showToast("Max stock reached", 2500, "warning");
    } else {
      item.qty = qty;
    }
  }
  renderCart();
}

function focusCartQuantity(id) {
  setTimeout(() => {
    const input = document.getElementById(`qty-${id}`);
    if (input) {
      input.focus();
      input.select();
    }
  }, 30);
}

function updateCartQuantityDisplay(id) {
  const item = cart.find(i => i.id === id);
  if (!item) return;
  const countEl = document.getElementById("cartCount");
  if (countEl) countEl.textContent = cart.reduce((sum, i) => sum + i.qty, 0);
  const totalEl = document.getElementById(`item-total-${id}`);
  if (totalEl) totalEl.textContent = `GHS ${(Number(item.price || 0) * Number(item.qty || 0)).toFixed(2)}`;
  updateTotals();
}

function nudgeQuantityInput(id, delta, input) {
  const item = cart.find(i => i.id === id);
  if (!item) return;
  const drug = drugs.find(d => d.id === id);
  const maxQty = Math.max(1, Number(drug?.stock ?? item.stock ?? 1) || 1);
  const current = parseInt(input?.value, 10) || item.qty || 1;
  let next = Math.max(1, current + delta);
  if (next > maxQty) {
    next = maxQty;
    showToast("Max stock reached", 1800, "warning");
  }
  item.qty = next;
  if (input) {
    input.value = next;
    input.focus();
    input.select();
  }
  updateCartQuantityDisplay(id);
}

function handleQuantityKeydown(event, id) {
  if (event.key === "Enter") {
    event.preventDefault();
    setQty(id, event.currentTarget.value);
    if (cart.length) focusPaymentAmount();
    return;
  }
  if (event.key === "ArrowUp" || event.key === "ArrowRight") {
    event.preventDefault();
    nudgeQuantityInput(id, 1, event.currentTarget);
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
    event.preventDefault();
    nudgeQuantityInput(id, -1, event.currentTarget);
  }
}

async function overridePrice(id) {
  if (!requirePermission("overridePrice", "Price override requires pharmacist or manager access")) return;
  const item = cart.find(i => i.id === id);
  if (!item) return;
  // Use UI modal for price override
  const newPrice = await openPriceOverrideModal(item.name, item.price);
  if (newPrice === null) return; // cancelled
  const oldPrice = item.price;
  item.price = newPrice;
  recordAudit("price-override", `Overrode ${item.name} from GHS ${oldPrice.toFixed(2)} to GHS ${item.price.toFixed(2)}`);
  renderCart();
}

function removeItem(id) { cart = cart.filter(i => i.id !== id); renderCart(); }

function renderCart() {
  const container = document.getElementById("cartItems");
  const count = cart.reduce((sum, i) => sum + i.qty, 0);
  document.getElementById("cartCount").textContent = count;
  if (!cart.length) {
    renderHtml(container, `<div class="empty-cart"><i class="ti ti-pill"></i><div>Tap a drug to add it to the sale</div></div>`);
  } else {
    renderHtml(container, cart.map(item => `
          <div class="cart-item" data-key="cart-${item.id}">
            <div class="item-info">
              <div class="item-name">${sanitize(item.name)}</div>
              <div class="item-meta">${sanitize(item.form)} - sold per ${sanitize(getDrugSaleUnit(item))} - GHS ${Number(item.price || 0).toFixed(2)}${hasPermission("overridePrice") ? ` - <button class="action-btn" style="font-size:11px;padding:6px 8px;min-width:auto;" onclick="overridePrice(${item.id})">Override</button>` : ''}</div>
            </div>
            <div class="qty-controls">
              <button class="qty-btn" onclick="changeQty(${item.id},-1)">-</button>
              <input id="qty-${item.id}" class="qty-num" type="number" min="1" step="1" inputmode="numeric" value="${item.qty}" onchange="setQty(${item.id}, this.value)" oninput="this.value=this.value.replace(/[^0-9]/g,'')" onkeydown="handleQuantityKeydown(event, ${item.id})" aria-label="Quantity for ${sanitize(item.name)}" />
              <button class="qty-btn" onclick="changeQty(${item.id},1)">+</button>
            </div>
            <div class="item-total" id="item-total-${item.id}">GHS ${(Number(item.price || 0) * Number(item.qty || 0)).toFixed(2)}</div>
            <button class="remove-btn" onclick="removeItem(${item.id})"><i class="ti ti-x"></i></button>
          </div>
        `).join(""));
  }
  renderInteractionAlerts();
  updateTotals();
}

function updateTotals() {
  const blockingInteractions = getBlockingInteractions();
  const sub = cart.reduce((sum, i) => sum + (i.price || 0) * (i.qty || 0), 0);
  const discPct = parseFloat(document.getElementById("discountPct")?.value) || 0;
  const discAmt = parseFloat(((sub * discPct) / 100).toFixed(2)) || 0;
  const total = Math.max(0, sub - discAmt);
  const paid1 = parseFloat(document.getElementById("paymentAmount1")?.value) || 0;
  const paid = paid1;
  const change = parseFloat((paid - total).toFixed(2));
  const subTotalEl = document.getElementById("subTotal");
  if (subTotalEl) subTotalEl.textContent = `GHS ${sub.toFixed(2)}`;
  const discRow = document.getElementById("discRow");
  if (discAmt > 0 && discRow) {
    discRow.style.display = "flex";
    const discAmtEl = document.getElementById("discAmt");
    if (discAmtEl) discAmtEl.textContent = `-GHS ${discAmt.toFixed(2)}`;
  } else if (discRow) {
    discRow.style.display = "none";
  }
  const grandTotalEl = document.getElementById("grandTotal");
  if (grandTotalEl) grandTotalEl.textContent = `GHS ${total.toFixed(2)}`;
  const changeRow = document.getElementById("changeRow");
  if (paid > 0 && changeRow) {
    changeRow.style.display = "flex";
    const changeAmtEl = document.getElementById("changeAmt");
    if (changeAmtEl) changeAmtEl.textContent = change >= 0 ? `GHS ${change.toFixed(2)}` : `INSUFFICIENT GHS ${Math.abs(change).toFixed(2)}`;
  } else if (changeRow) {
    changeRow.style.display = "none";
  }
  const checkoutBtn = document.getElementById("checkoutBtn");
  if (checkoutBtn) checkoutBtn.disabled = cart.length === 0 || saleSubmissionInProgress;
  if (checkoutBtn) checkoutBtn.title = blockingInteractions.length
    ? "Serious interaction warning must be reviewed at checkout"
    : "";
  const balanceNote = document.getElementById("customerBalanceNote");
  if (balanceNote) {
    const customer = customers.find(c => c.id === selectedCustomerId);
    const isWalkIn = !customer || String(customer.name || "").trim().toLowerCase() === "walk-in";
    const balance = Number(customer?.balance || 0);
    if (!isWalkIn && balance !== 0) {
      balanceNote.style.display = "inline-flex";
      if (balance > 0) {
        balanceNote.className = "customer-balance-note customer-balance-debt";
        balanceNote.innerHTML = `<i class="ti ti-alert-circle"></i> Outstanding balance: GH&#8373;${balance.toFixed(2)}`;
      } else {
        balanceNote.className = "customer-balance-note customer-balance-credit";
        balanceNote.innerHTML = `<i class="ti ti-circle-check"></i> Credit: GH&#8373;${Math.abs(balance).toFixed(2)}`;
      }
    } else {
      balanceNote.style.display = "none";
    }
  }
}

function selectPay(btn) {
  document.querySelectorAll(".pay-method").forEach(e => e.classList.remove("active"));
  btn.classList.add("active");
  const method = btn.textContent.trim();
  const paymentMethod1 = document.getElementById("paymentMethod1");
  if (paymentMethod1) paymentMethod1.value = method;
  payMethod = method;
  updateTotals();
}

function holdSale() {
  if (!requirePermission("holdSale", "Worker, pharmacist, or manager access required to hold sales")) return;
  if (!cart.length) return showToast("Cart is empty", 2500, "warning");
  const subtotal = cart.reduce((sum, i) => sum + i.price * i.qty, 0);
  const id = makeClientId("HOLD");
  const selectedCustomer = customers.find(c => c.id === selectedCustomerId) || customers[0];
  const customer = selectedCustomer?.name || "Walk-in";
  heldSales.push(setRecordBranch({
    id,
    customer,
    customerId: selectedCustomer?.id || null,
    cart: JSON.parse(JSON.stringify(cart)),
    total: subtotal,
    time: new Date().toLocaleTimeString("en-GH", { hour: "2-digit", minute: "2-digit" })
  }));
  cart = []; renderCart(); renderHeld(); saveHeld(); showToast(`Sale held as ${id}`);
}

function updateHeldSaleBadge() {
  const count = heldSales.filter(sale => userCanSeeRecord(sale)).length;
  const badge = document.getElementById("posHeldCount");
  if (badge) badge.textContent = String(count);
}

function renderHeld() {
  updateHeldSaleBadge();
  const list = document.getElementById("heldList");
  if (!list) return;
  const visibleHeld = heldSales.map((sale, idx) => ({ sale, idx })).filter(row => userCanSeeRecord(row.sale));
  if (!visibleHeld.length) return renderHtml(list, `<div class="empty-cart"><i class="ti ti-clock-pause"></i><div>No held sales</div></div>`);
  renderHtml(list, visibleHeld.map(({ sale, idx }) => `
        <div class="held-sale" data-key="${sanitize(sale.id)}">
          <div>
            <div class="item-name">${sanitize(sale.id)} - ${sanitize(sale.customer)}</div>
            <div class="held-meta">${sale.cart.length} items - ${sanitize(sale.time)}</div>
          </div>
          <div>
            <div class="item-total">GHS ${sale.total.toFixed(2)}</div>
            <button class="restore-btn" onclick="restoreHeld(${idx})">Restore</button>
          </div>
        </div>
      `).join(""));
}

function restoreHeld(index) {
  const sale = heldSales[index];
  if (!sale) return showToast("Held sale not found", 2500, "error");
  cart = JSON.parse(JSON.stringify(sale.cart));
  selectedCustomerId = customers.find(c => Number(c.id) === Number(sale.customerId))?.id
    || customers.find(c => c.name === sale.customer)?.id
    || customers[0]?.id
    || null;
  document.getElementById("customerSelect").value = selectedCustomerId;
  heldSales.splice(index, 1); renderCart(); renderHeld(); showView("pos"); saveHeld(); showToast(`Restored ${sale.id}`);
}

function validateCartForCheckout(items = cart, branchId = getCurrentBranchId()) {
  for (const item of items) {
    const drug = drugs.find(candidate => candidate.id === item.id);
    const qty = Number(item.qty);
    if (!drug) return { ok: false, message: `${item.name || "An item"} is no longer in inventory` };
    if (!isDrugAvailableAtBranch(drug, branchId)) return { ok: false, message: `${drug.name} is not available at this branch` };
    if (!Number.isInteger(qty) || qty <= 0) return { ok: false, message: `Enter a valid quantity for ${drug.name}` };
    const available = Number(drug.stock) || 0;
    if (qty > available) return { ok: false, message: `Stock changed: only ${available} unit(s) of ${drug.name} are available` };
    const trackedBatchQty = normalizeDrugBatches(drug)
      .filter(batch => batch.branch_id === branchId)
      .reduce((sum, batch) => sum + (Number(batch.qty) || 0), 0);
    if (trackedBatchQty > 0 && qty > trackedBatchQty) {
      return { ok: false, message: `Batch stock for ${drug.name} is only ${trackedBatchQty} unit(s)` };
    }
  }
  return { ok: true };
}

async function checkout() {
  if (!requirePermission("sell", "Worker, pharmacist, or manager access required to sell")) return;
  if (!cart.length) return;
  if (saleSubmissionInProgress) return showToast("Sale is already being processed", 2000, "info");
  const discountText = document.getElementById("discountPct")?.value || "";
  const requestedDiscount = discountText.trim() ? Number(discountText) : 0;
  if (!Number.isFinite(requestedDiscount) || requestedDiscount < 0 || requestedDiscount > 100) {
    return showToast("Discount must be between 0% and 100%", 3000, "error");
  }
  if (requestedDiscount > 0 && !hasPermission("overridePrice")) {
    return showToast("Discounts require pharmacist or manager access", 3000, "error");
  }
  const cartValidation = validateCartForCheckout();
  if (!cartValidation.ok) {
    renderCart();
    return showToast(cartValidation.message, 3500, "error");
  }
  saleSubmissionInProgress = true;
  updateTotals();
  // #9 Button spinner
  const chkBtn = document.getElementById("checkoutBtn");
  const chkOrigHtml = chkBtn?.innerHTML;
  if (chkBtn) chkBtn.innerHTML = '<span class="btn-spinner"></span> Processing…';
  try {
  const blockingInteractions = getBlockingInteractions();
  let interactionOverride = null;
  let interactionReview = null;
  if (blockingInteractions.length) {
    renderInteractionAlerts();
    const reviewChoice = await getInteractionReviewChoice(blockingInteractions);
    if (!reviewChoice) {
      showToast("Interaction review required", 2500, "warning");
      return;
    }
    interactionReview = {
      by: currentUser?.username || "system",
      name: currentUser?.name || "System",
      role: currentUser?.role || "unknown",
      code: reviewChoice.code,
      label: reviewChoice.label,
      note: reviewChoice.note,
      at: new Date().toISOString(),
      interactions: summarizeInteractionsForSale(blockingInteractions)
    };
    if (reviewChoice.needsOverride || hasPermission("overrideInteractions")) {
      if (!hasPermission("overrideInteractions")) {
        showToast("Same patient: pharmacist/manager override required", 3500, "error");
        return;
      }
      // Use UI modal for the override reason
      const pairs = blockingInteractions.map(a => `${a.first.name} + ${a.second.name}`).join("; ");
      const defaultReason = reviewChoice.note ? `${reviewChoice.label}: ${reviewChoice.note}` : reviewChoice.label;
      const reason = await openOverrideReasonModal(pairs, defaultReason);
      if (!reason) {
        showToast("Override reason required", 2500, "warning");
        return;
      }
      interactionOverride = {
        by: currentUser?.username || "system",
        name: currentUser?.name || "System",
        role: currentUser?.role || "unknown",
        reason: reason.trim(),
        at: new Date().toISOString(),
        interactions: summarizeInteractionsForSale(blockingInteractions)
      };
    }
  }
  const sub = cart.reduce((s, i) => s + (i.price || 0) * (i.qty || 0), 0);
  const discPct = parseFloat(document.getElementById("discountPct")?.value) || 0;
  const cartDisc = parseFloat(((sub * discPct) / 100).toFixed(2)) || 0;
  const total = Math.max(0, sub - cartDisc);
  const tax = 0;
  const paymentMethod1 = document.getElementById("paymentMethod1")?.value || "Cash";
  const paymentAmount1 = parseFloat(document.getElementById("paymentAmount1")?.value) || 0;
  const paid = paymentAmount1;
  const customer = customers.find(c => c.id === selectedCustomerId) || (customers.length > 0 ? customers[0] : { id: 1, name: "Walk-in" });
  if (paid < total) return showToast("Payment incomplete", 2500, "error");
  const due = Math.max(0, total - paid);
  const change = parseFloat((paid - total).toFixed(2));
  const now = new Date();
  const ref = makeClientId("INV");
  const paymentDetails = paymentAmount1 > 0 ? [{ method: paymentMethod1, amount: total, tendered: paymentAmount1, change }] : [];
  const summaryMethod = paymentMethod1 || 'Cash';
  const branchId = getCurrentBranchId();
  const branchName = getBranchNameById(branchId);
  const stockMovements = [];
  let totalCost = 0;
  cart.forEach(item => {
    const drug = drugs.find(d => d.id === item.id);
    if (drug) {
      const batchAllocations = deductDrugBatchStock(drug, branchId, item.qty);
      item.batchAllocations = batchAllocations;
      stockMovements.push({ drug_id: drug.id, drugId: drug.id, name: drug.name, qty: -item.qty, branch_id: branchId, branch: branchName, reason: "sale", sale_id: ref, batch_allocations: batchAllocations });
      updateBranchStock(drug, -item.qty);
      const allocatedQty = batchAllocations.reduce((sum, allocation) => sum + (Number(allocation.qty) || 0), 0);
      totalCost += batchAllocations.reduce((sum, allocation) => sum + ((Number(allocation.cost) || 0) * (Number(allocation.qty) || 0)), 0);
      if (allocatedQty < item.qty) totalCost += (Number(drug.costPrice) || 0) * (item.qty - allocatedQty);
    }
  });
  const profit = total - totalCost;
  const sale = {
    id: ref,
    date: now.toISOString(),
    branch_id: branchId,
    branch: branchName,
    customer: customer.name,
    customerId: customer.id,
    payment: summaryMethod,
    paymentDetails,
    paid,
    due,
    onAccount: false,
    processedBy: currentUser?.username || "system",
    items: JSON.parse(JSON.stringify(cart)),
    total,
    totalCost,
    profit,
    discount: cartDisc,
    tax,
    interactionReview,
    interactionOverride,
    interactionWarnings: summarizeInteractionsForSale(findCartInteractions())
  };
  let savedSale = sale;
  try {
    const serverSale = await syncServerAction("/sales", { sale, stock_movements: stockMovements }, { branch: branchId });
    if (serverSale) savedSale = serverSale;
  } catch (error) {
    console.warn(error);
    stockMovements.forEach(movement => {
      const drug = drugs.find(d => d.id === movement.drug_id);
      if (drug) {
        updateBranchStock(drug, Math.abs(movement.qty));
        restoreDrugBatchAllocations(drug, movement.batch_allocations || movement.batchAllocations);
      }
    });
    const refreshed = hasApiServer() && currentUser
      ? await refreshServerData({ silent: true })
      : false;
    const recoveredSale = refreshed ? salesHistory.find(record => record.id === ref) : null;
    if (recoveredSale) {
      savedSale = recoveredSale;
    } else {
      const detail = error?.message ? `: ${error.message}` : "";
      showToast(`Sale not saved${detail}`, 4500, "error");
      return;
    }
  }
  dayStats.revenue += Number(savedSale.total) || 0;
  dayStats.txCount += 1;
  dayStats.items += (savedSale.items || []).reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
  (savedSale.paymentDetails || []).forEach(detail => {
    dayStats.payMethods[detail.method] = (dayStats.payMethods[detail.method] || 0) + 1;
  });
  salesHistory = salesHistory.filter(record => record.id !== savedSale.id);
  salesHistory.unshift(savedSale);
  saveSales(); saveDrugs();
  runAutoBackupCheck();
  await recordPatientSaleSnapshot(savedSale);
  renderPatientProfiles();
  updateDashboard();
  updateNotificationBadge();
  if (interactionReview && !interactionOverride) {
    recordAudit(
      "interaction-review",
      `${interactionReview.name} marked ${interactionReview.interactions.length} serious interaction(s) as ${interactionReview.label}${interactionReview.note ? ": " + interactionReview.note : ""}`
    );
  }
  if (interactionOverride) {
    recordAudit(
      "interaction-override",
      `${interactionOverride.name} overrode ${interactionOverride.interactions.length} serious interaction(s): ${interactionOverride.reason}`
    );
  }
  document.getElementById("rcBranch").textContent = `${branchName} Branch`;
  document.getElementById("rcDate").textContent = now.toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" });
  document.getElementById("rcRef").textContent = `Ref: ${savedSale.id}`;
  const rcCustomer = document.getElementById("rcCustomer");
  rcCustomer.style.display = "block";
  rcCustomer.textContent = `Customer: ${savedSale.customer}`;
  renderHtml(document.getElementById("rcItems"), (savedSale.items || []).map(item => `
        <div class="receipt-table-row">
          <strong>${sanitize(item.name)}</strong>
          <span>${Number(item.qty || 0)} ${sanitize(formatDrugSaleUnit(item, item.qty).toLowerCase())}</span>
          <strong>GHS ${(Number(item.price || 0) * Number(item.qty || 0)).toFixed(2)}</strong>
        </div>
  `).join(""));
  const savedSubtotal = Number(savedSale.subtotal ?? ((Number(savedSale.total) || 0) + (Number(savedSale.discount) || 0)));
  const savedDiscount = Number(savedSale.discount) || 0;
  const savedTotal = Number(savedSale.total) || 0;
  const savedPaid = Number(savedSale.paid) || savedTotal;
  const savedChange = Number(savedSale.change ?? (savedPaid - savedTotal)) || 0;
  document.getElementById("rcSub").textContent = `GHS ${savedSubtotal.toFixed(2)}`;
  if (savedDiscount > 0) { document.getElementById("rcDiscRow").style.display = "flex"; document.getElementById("rcDisc").textContent = `-GHS ${savedDiscount.toFixed(2)}`; } else document.getElementById("rcDiscRow").style.display = "none";
  document.getElementById("rcTotal").textContent = `GHS ${savedTotal.toFixed(2)}`;
  document.getElementById("rcPay").textContent = `${savedSale.payment || summaryMethod} - paid GHS ${savedPaid.toFixed(2)}${savedChange > 0 ? ` - change GHS ${savedChange.toFixed(2)}` : ""}`;
  cart = []; renderCart();
  document.getElementById("paymentAmount1").value = 0;
  document.getElementById("paymentMethod1").value = "Cash";
  if (document.getElementById("discountPct")) document.getElementById("discountPct").value = 0;
  updateTotals();
  renderCategories();
  filterDrugs();
  updateLowStockBadge();
  applyReceiptSettings();
  showView("receipt"); showToast("Sale completed");
  } finally {
    saleSubmissionInProgress = false;
    if (chkBtn && chkOrigHtml) chkBtn.innerHTML = chkOrigHtml;
    updateTotals();
  }
}
