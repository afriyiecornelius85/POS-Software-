function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function getDashboardHourlyRevenue(todaySales, now = new Date()) {
  const saleHours = todaySales
    .map(sale => new Date(sale.date))
    .filter(date => !Number.isNaN(date.getTime()))
    .map(date => date.getHours());
  const startHour = Math.min(8, ...saleHours);
  const endHour = Math.max(20, now.getHours(), ...saleHours);
  const hours = Array.from({ length: endHour - startHour + 1 }, (_, index) => startHour + index);
  const values = hours.map(hour => todaySales.reduce((sum, sale) => {
    const saleDate = new Date(sale.date);
    if (Number.isNaN(saleDate.getTime()) || saleDate.getHours() !== hour) return sum;
    return sum + (Number(sale.total) || 0);
  }, 0));
  return {
    labels: hours.map(hour => `${String(hour).padStart(2, "0")}:00`),
    values
  };
}

function getLocalDateKey(date = new Date()) {
  const safeDate = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(safeDate.getTime())) return "";
  const year = safeDate.getFullYear();
  const month = String(safeDate.getMonth() + 1).padStart(2, "0");
  const day = String(safeDate.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getRecentDateKeys(days = 7, now = new Date()) {
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(now);
    date.setDate(now.getDate() - (days - 1 - index));
    return getLocalDateKey(date);
  });
}

function getDailyMetricSeries(branchSales, metric, now = new Date()) {
  const keys = getRecentDateKeys(7, now);
  const totals = Object.fromEntries(keys.map(key => [key, 0]));
  branchSales.forEach(sale => {
    const key = getLocalDateKey(sale.date);
    if (!Object.prototype.hasOwnProperty.call(totals, key)) return;
    if (metric === "profit") {
      const explicitProfit = Number(sale.profit);
      totals[key] += Number.isFinite(explicitProfit) ? explicitProfit : ((Number(sale.total) || 0) - (Number(sale.totalCost) || 0));
    } else {
      totals[key] += Number(sale.total) || 0;
    }
  });
  return keys.map(key => totals[key]);
}

function formatDashboardTrend(current, previous, emptyLabel) {
  if (!previous && !current) return emptyLabel;
  if (!previous) return current > 0 ? "New activity today" : "Net returns today";
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  const arrow = pct >= 0 ? "\u2191" : "\u2193";
  return `${arrow} ${Math.abs(pct).toFixed(1)}% vs yesterday`;
}

function valuesToSparklinePath(values, width = 92, height = 28, padding = 2) {
  const normalized = (values || []).map(value => Number(value) || 0);
  const safeValues = normalized.length >= 2 ? normalized : [0, ...normalized, 0];
  const min = Math.min(...safeValues);
  const max = Math.max(...safeValues);
  const spread = max - min || 1;
  const step = (width - padding * 2) / Math.max(1, safeValues.length - 1);
  const points = safeValues.map((value, index) => {
    const x = padding + (index * step);
    const y = height - padding - (((value - min) / spread) * (height - padding * 2));
    return [x, y];
  });
  return points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
}

function updateSparklinePath(selector, values) {
  const path = document.querySelector(selector);
  if (path) path.setAttribute("d", valuesToSparklinePath(values));
}

function getLowStockSparklineValues(lowStock, branchInventory) {
  const total = Math.max(1, branchInventory.length);
  const buckets = [0, .25, .5, .75, 1].map(limit => lowStock.filter(item => {
    const threshold = Math.max(1, Number(item.threshold) || 1);
    return (Number(item.stock) || 0) <= threshold * limit;
  }).length);
  return [0, ...buckets, lowStock.length, Math.round((lowStock.length / total) * 10)];
}

function getExpirySparklineValues(branchId = getDashboardBranchId()) {
  const rows = getBatchExpiryRows(branchId).filter(row => (row.stock ?? 0) > 0);
  const now = Date.now();
  const countWithin = days => rows.filter(row => {
    const expiry = new Date(row.expiry).getTime();
    return expiry > 0 && expiry <= now + days * 86400000;
  }).length;
  const expired = rows.filter(row => {
    const expiry = new Date(row.expiry).getTime();
    return expiry > 0 && expiry < now;
  }).length;
  return [expired, countWithin(7), countWithin(14), countWithin(30), countWithin(60), countWithin(90), rows.length];
}

function renderDashboardHourlyChart(todaySales, now = new Date()) {
  const canvas = document.getElementById("dashboardHourlyChart");
  const empty = document.getElementById("dashboardHourlyChartEmpty");
  if (!canvas) return;
  if (typeof Chart === "undefined") {
    if (empty) { empty.textContent = "Chart.js could not load"; showHiddenElement(empty, "grid"); }
    canvas.style.display = "none";
    return;
  }

  const { labels, values } = getDashboardHourlyRevenue(todaySales, now);
  const hasData = values.some(value => value !== 0);
  if (hasData) hideHiddenElement(empty); else showHiddenElement(empty, "grid");
  canvas.style.display = "block";

  const chartData = {
    labels,
    datasets: [{
      label: "Hourly revenue",
      data: values,
      borderColor: "#2563eb",
      backgroundColor: "rgba(37,99,235,.12)",
      pointBackgroundColor: "#dc2626",
      pointBorderColor: "#ffffff",
      pointBorderWidth: 2,
      pointRadius: 4,
      pointHoverRadius: 6,
      borderWidth: 3,
      fill: true,
      tension: .36
    }]
  };
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: context => `Revenue: ${money(context.parsed.y)}`
        }
      }
    },
    scales: {
      y: {
        beginAtZero: true,
        ticks: { callback: value => `GHS ${value}` },
        grid: { color: "rgba(148,163,184,.22)" }
      },
      x: {
        grid: { display: false },
        ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 }
      }
    }
  };

  if (dashboardHourlyChart) {
    dashboardHourlyChart.data = chartData;
    dashboardHourlyChart.options = options;
    dashboardHourlyChart.update();
    return;
  }
  dashboardHourlyChart = new Chart(canvas, { type: "line", data: chartData, options });
}

function getDashboardBranchId() {
  if (currentUser && !canSwitchBranch(currentUser)) return currentUser.branchId || currentUser.branch_id || getCurrentBranchId();
  return getCurrentBranchId();
}

function getCustomerHomeBranchId(customer) {
  return customer.branch_id || customer.branchId || (customer.branch ? getBranchIdByName(customer.branch) : branchRecords[0].id);
}

function getDashboardPatientsForBranch(branchId, branchSales) {
  const sales = branchSales || getRecordsForBranch(salesHistory, branchId);
  const salePatientIds = new Set(sales.map(sale => Number(sale.customerId)).filter(Number.isFinite));
  const salePatientNames = new Set(sales.map(sale => String(sale.customer || "").trim().toLowerCase()).filter(Boolean));
  return customers.filter(customer => {
    const name = String(customer.name || "").trim().toLowerCase();
    if (!name || name === "walk-in") return false;
    return getCustomerHomeBranchId(customer) === branchId || salePatientIds.has(Number(customer.id)) || salePatientNames.has(name);
  });
}

function getLowStockItemsForBranch(branchId = getDashboardBranchId()) {
  return drugs
    .filter(drug => isDrugAvailableAtBranch(drug, branchId))
    .map(drug => {
      const stock = getBranchStockValue(drug, branchId);
      return { id: drug.id, name: drug.name, brand: drug.brand || "", form: drug.form || "", cat: drug.cat || "", stock, threshold: getDrugLowThreshold(drug) };
    })
    .filter(item => item.stock >= 0 && item.stock < item.threshold);
}

function getExpiryAlertsForBranch(branchId = getDashboardBranchId()) {
  const thresholdMs = 1000 * 60 * 60 * 24 * 30;
  const now = Date.now();
  return getBatchExpiryRows(branchId).filter(row => {
    if ((row.stock ?? 0) <= 0) return false;
    const expiry = new Date(row.expiry).getTime();
    return expiry > 0 && expiry <= now + thresholdMs;
  });
}

function getDashboardInventoryProducts(branchId = getDashboardBranchId()) {
  return drugs
    .filter(drug => !drug.referenceItem && isDrugAvailableAtBranch(drug, branchId))
    .map(drug => ({ ...drug, stock: getBranchStockValue(drug, branchId) }));
}

function updateDashboard() {
  if (!document.getElementById("view-dashboard")) return;
  const now = new Date();
  const { start, end } = getDayRange(now);
  const branchId = getDashboardBranchId();
  const branchName = getBranchNameById(branchId);
  const branchSales = getRecordsForBranch(salesHistory, branchId);
  const todaySales = branchSales.filter(sale => {
    const saleDate = new Date(sale.date);
    return saleDate >= start && saleDate <= end;
  });
  const revenue = todaySales.reduce((sum, sale) => sum + (Number(sale.total) || 0), 0);
  const profit = todaySales.reduce((sum, sale) => {
    const explicitProfit = Number(sale.profit);
    if (Number.isFinite(explicitProfit)) return sum + explicitProfit;
    return sum + ((Number(sale.total) || 0) - (Number(sale.totalCost) || 0));
  }, 0);
  const profitMargin = revenue > 0 ? Math.round((profit / revenue) * 100) : 0;
  const txCount = todaySales.filter(sale => !sale.refundAgainst && (Number(sale.total) || 0) >= 0).length;
  const patientProfiles = getDashboardPatientsForBranch(branchId, branchSales);
  const patientIds = new Set(patientProfiles.map(patient => Number(patient.id)));
  const patientNames = new Set(patientProfiles.map(patient => String(patient.name || "").trim().toLowerCase()).filter(Boolean));
  const linkedPatientSales = branchSales.filter(sale => patientIds.has(Number(sale.customerId)) || patientNames.has(String(sale.customer || "").trim().toLowerCase())).length;
  const visibleSuppliers = getRecordsForBranch(suppliers, branchId);
  const visiblePurchases = getRecordsForBranch(purchaseHistory, branchId);
  const branchInventory = getDashboardInventoryProducts(branchId);
  const lowStock = getLowStockItemsForBranch(branchId);
  const expiryAlerts = getExpiryAlertsForBranch(branchId);
  const visibleHeld = getRecordsForBranch(heldSales, branchId);
  const visibleDrafts = getRecordsForBranch(draftPurchaseOrders, branchId);
  const stockValue = branchInventory.reduce((sum, drug) => sum + ((Number(drug.stock) || 0) * (Number(drug.costPrice) || 0)), 0);
  const outstandingDebt = patientProfiles.reduce((sum, patient) => sum + (Number(patient.balance) || 0), 0);
  const salesSeries = getDailyMetricSeries(branchSales, "sales", now);
  const profitSeries = getDailyMetricSeries(branchSales, "profit", now);
  const todaySalesTotal = salesSeries[salesSeries.length - 1] || revenue;
  const yesterdaySalesTotal = salesSeries[salesSeries.length - 2] || 0;
  const todayProfitTotal = profitSeries[profitSeries.length - 1] || profit;
  const yesterdayProfitTotal = profitSeries[profitSeries.length - 2] || 0;
  setText("dashboardGreeting", currentUser ? `Welcome, ${currentUser.name}` : "Welcome");
  setText("dashboardBranch", branchName || "Current branch");
  setText("dashSalesTotal", money(revenue));
  setText("dashSalesCount", formatDashboardTrend(todaySalesTotal, yesterdaySalesTotal, "0 transactions today"));
  setText("dashProfitTotal", money(profit));
  setText("dashProfitNote", formatDashboardTrend(todayProfitTotal, yesterdayProfitTotal, "No sales profit yet"));
  setText("dashLowStockCount", `${lowStock.length}`);
  setText("dashLowStock", "View products");
  setText("dashExpiryCount", `${expiryAlerts.length}`);
  setText("dashExpiryNote", "Within 30 days");
  setText("dashFooterProducts", `${branchInventory.length.toLocaleString("en-GH")}`);
  setText("dashFooterStockValue", money(stockValue));
  setText("dashFooterCustomers", `${patientProfiles.length.toLocaleString("en-GH")}`);
  setText("dashFooterDebt", money(outstandingDebt));
  updateDashboardShell({
    now,
    branchId,
    branchName,
    lowStockCount: lowStock.length,
    expiryCount: expiryAlerts.length,
    draftCount: visibleDrafts.length
  });
  renderDashboardHourlyChart(todaySales, now);
  updateSparklinePath(".dashboard-stat-sales .dashboard-sparkline path", salesSeries);
  updateSparklinePath(".dashboard-stat-profit .dashboard-sparkline path", profitSeries);
  updateSparklinePath(".dashboard-stat-low .dashboard-sparkline path", getLowStockSparklineValues(lowStock, branchInventory));
  updateSparklinePath(".dashboard-stat-expiry .dashboard-sparkline path", getExpirySparklineValues(branchId));
  // #15 KPI progress bars: show today vs yesterday as a percentage fill
  const setKpiBar = (id, today, yesterday) => {
    const el = document.getElementById(id);
    if (!el) return;
    const pct = yesterday > 0 ? Math.min(100, Math.round((today / yesterday) * 100)) : (today > 0 ? 100 : 0);
    requestAnimationFrame(() => { el.style.width = pct + "%"; });
  };
  setKpiBar("dashSalesProgress", todaySalesTotal, yesterdaySalesTotal || 1);
  setKpiBar("dashProfitProgress", todayProfitTotal, yesterdayProfitTotal || 1);
  const totalProducts = branchInventory.length || 1;
  setKpiBar("dashLowProgress", Math.min(lowStock.length, totalProducts), totalProducts);
  setKpiBar("dashExpiryProgress", Math.min(expiryAlerts.length, totalProducts), totalProducts);

  const recent = document.getElementById("dashboardRecentSales");
  if (recent) {
    const saleRows = branchSales.slice(0, 5).map(sale => ({
      date: sale.date,
      type: "Sale",
      tone: "sale",
      description: `${sanitize(sale.id || "Sale")} ${sale.refundAgainst ? "refund" : ""}`.trim(),
      by: getUserDisplayName(sale.processedBy),
      branch: sale.branch || branchName
    }));
    const purchaseRows = visiblePurchases.slice(0, 4).map(purchase => ({
      date: purchase.date || purchase.receivedDate || purchase.createdAt,
      type: "GRN",
      tone: "grn",
      description: sanitize(purchase.invoice || purchase.id || "Goods received"),
      by: getUserDisplayName(purchase.receivedBy || purchase.performedBy || purchase.createdBy),
      branch: purchase.branch || branchName
    }));
    const productRows = getRecordsForBranch(stockAdjustments, branchId).slice(0, 3).map(entry => ({
      date: entry.date || entry.timestamp,
      type: "Product",
      tone: "product",
      description: sanitize(entry.details || entry.action || "Inventory updated"),
      by: getUserDisplayName(entry.performedBy || entry.user),
      branch: entry.branch || branchName
    }));
    const rows = [...saleRows, ...purchaseRows, ...productRows]
      .filter(row => row.date)
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 5);
    renderHtml(recent, `
      <table class="dashboard-data-table">
        <thead><tr><th>Time</th><th>Type</th><th>Description</th><th>By</th><th>Branch</th></tr></thead>
        <tbody>
          ${rows.length ? rows.map(row => `
            <tr>
              <td>${sanitize(formatDashboardTime(row.date))}</td>
              <td><span class="dashboard-type-badge type-${row.tone}">${sanitize(row.type)}</span></td>
              <td>${sanitize(row.description)}</td>
              <td>${sanitize(row.by)}</td>
              <td>${sanitize(row.branch || branchName)}</td>
            </tr>
          `).join("") : `<tr><td colspan="5" class="dashboard-empty-cell">No activity recorded yet</td></tr>`}
        </tbody>
      </table>
      <button class="dashboard-table-link" onclick="showView('history')">View all activity</button>
    `);
  }

  const attention = document.getElementById("dashboardAttention");
  if (attention) {
    const alertRows = [
      { type: "Expiring Soon", tone: "expiring", icon: "ti-alert-triangle", description: `${expiryAlerts.length} product${expiryAlerts.length === 1 ? "" : "s"} expire within 30 days`, items: expiryAlerts.length, action: "showView('expiry')" },
      { type: "Low Stock", tone: "low", icon: "ti-alert-triangle", description: `${lowStock.length} product${lowStock.length === 1 ? "" : "s"} are below reorder level`, items: lowStock.length, action: "showLowStockPreview()" },
      { type: "GRN Pending", tone: "grn", icon: "ti-info-circle", description: `${visibleDrafts.length} GRN${visibleDrafts.length === 1 ? "" : "s"} pending approval`, items: visibleDrafts.length, action: "showWorkspaceSection('purchases','grn')" },
      { type: "Sync Status", tone: "sync", icon: "ti-circle-check", description: hasApiServer() ? "All data is up to date" : "Browser storage only", items: "-", action: "showSyncBackup()" }
    ];
    renderHtml(attention, `
      <table class="dashboard-data-table dashboard-alert-table">
        <thead><tr><th>Type</th><th>Description</th><th>Items</th></tr></thead>
        <tbody>
          ${alertRows.map(row => `
            <tr onclick="${row.action}" role="button" tabindex="0">
              <td><span class="dashboard-alert-type alert-${row.tone}"><i class="ti ${row.icon}"></i>${sanitize(row.type)}</span></td>
              <td>${sanitize(row.description)}</td>
              <td class="dashboard-alert-count alert-${row.tone}">${sanitize(String(row.items))}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      <button class="dashboard-table-link" onclick="showView('notifications')">View all alerts</button>
    `);
  }
}

function getUserDisplayName(username) {
  if (!username) return currentUser?.name || "System";
  if (currentUser && String(currentUser.username || "").toLowerCase() === String(username).toLowerCase()) return currentUser.name || username;
  const user = getUserProfile(username);
  return user?.name || username || "System";
}

function formatDashboardTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleTimeString("en-GH", { hour: "2-digit", minute: "2-digit" });
}

function formatDashboardDate(value = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function getDashboardBranchCode(branchId, branchName) {
  if (branchId === "kwame-danso-main") return "KD-MAIN";
  if (branchId === "kwame-danso-annex") return "KD-ANNEX";
  return String(branchName || branchId || "BRANCH")
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part.slice(0, 3).toUpperCase())
    .join("-");
}

function updateDashboardShell(context = {}) {
  const now = context.now || new Date();
  const branchId = context.branchId || getCurrentBranchId();
  const branchName = context.branchName || getCurrentBranchName();
  setText("sidebarBranchName", branchName || "Current Branch");
  setText("sidebarBranchCode", getDashboardBranchCode(branchId, branchName));
  setText("sidebarPharmacyId", String(PHARMACY_ID || "akopharmah").toUpperCase());
  setText("sidebarDate", formatDashboardDate(now));
  setText("sidebarTime", now.toLocaleTimeString("en-GH", { hour: "2-digit", minute: "2-digit" }));
  updateNotificationBadge();
  updateHeldSaleBadge();
}

function money(value) {
  return `GHS ${(Number(value) || 0).toFixed(2)}`;
}

function getDayRange(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function getSalesInRange(start, end) {
  return getRecordsForBranch(salesHistory, getCurrentBranchId()).filter(sale => {
    const saleDate = new Date(sale.date);
    return saleDate >= start && saleDate <= end;
  });
}

function getLiveShiftHoursForDate(dateKey) {
  const records = { ...(shiftHours[dateKey] || {}) };
  if (shiftSession?.username && shiftSession.sessionStart && new Date(shiftSession.sessionStart).toISOString().slice(0, 10) === dateKey) {
    const liveSeconds = Math.max(0, Math.floor((new Date() - new Date(shiftSession.sessionStart)) / 1000));
    records[shiftSession.username] = (records[shiftSession.username] || 0) + liveSeconds;
  }
  return records;
}

function getCurrentShiftReportRange(now = new Date()) {
  const activeWindow = getActiveShiftWindow(now);
  if (activeWindow) {
    const { shift, start, end: scheduledEnd } = activeWindow;
    return { start, end: now < scheduledEnd ? now : scheduledEnd, label: shift.name, scheduled: `${shift.start} - ${shift.end}` };
  }
  if (shiftSession?.sessionStart) {
    return { start: new Date(shiftSession.sessionStart), end: now, label: shiftSession.shiftName || "Off shift", scheduled: "Current session" };
  }
  const day = getDayRange(now);
  return { start: day.start, end: now, label: "Current day", scheduled: "No active shift" };
}

function getAccountingPaymentDetails(sale) {
  const details = sale.paymentDetails?.length
    ? sale.paymentDetails
    : [{ method: sale.payment || "Unknown", amount: sale.total || 0 }];
  if (details.length === 1) {
    return [{ ...details[0], amount: Number(sale.total) || 0 }];
  }
  return details.map(detail => ({ ...detail, amount: Number(detail.amount) || 0 }));
}

function summarizeSales(sales) {
  const paymentTotals = {};
  const paymentCounts = {};
  const categoryTotals = {};
  const workerTotals = {};
  const topItems = {};
  let totalCost = 0;
  let totalProfit = 0;
  let totalDiscount = 0;
  let itemCount = 0;
  sales.forEach(sale => {
    const isRefund = !!sale.refundAgainst || (Number(sale.total) || 0) < 0;
    const itemSign = isRefund ? -1 : 1;
    const details = getAccountingPaymentDetails(sale);
    details.forEach(detail => {
      const method = detail.method || "Unknown";
      paymentTotals[method] = (paymentTotals[method] || 0) + (detail.amount || 0);
      paymentCounts[method] = (paymentCounts[method] || 0) + 1;
    });
    totalCost += Number(sale.totalCost) || 0;
    totalProfit += Number(sale.profit) || 0;
    totalDiscount += Number(sale.discount) || 0;
    const worker = sale.processedBy || "Unknown";
    if (!workerTotals[worker]) workerTotals[worker] = { revenue: 0, tx: 0 };
    workerTotals[worker].revenue += Number(sale.total) || 0;
    if (!sale.refundAgainst && (Number(sale.total) || 0) >= 0) workerTotals[worker].tx += 1;
    sale.items?.forEach(item => {
      const qty = item.qty || 0;
      const net = Math.max(0, (item.price || 0) - (parseFloat(item.itemDiscount) || 0));
      const category = item.cat || item.category || "Uncategorized";
      categoryTotals[category] = (categoryTotals[category] || 0) + (net * qty * itemSign);
      if (!isRefund) itemCount += qty;
      if (!topItems[item.name]) topItems[item.name] = { units: 0, revenue: 0 };
      topItems[item.name].units += qty * itemSign;
      topItems[item.name].revenue += net * qty * itemSign;
    });
  });
  return {
    revenue: sales.reduce((sum, sale) => sum + (Number(sale.total) || 0), 0),
    transactions: sales.filter(sale => !sale.refundAgainst && (Number(sale.total) || 0) >= 0).length,
    returns: sales.filter(sale => sale.refundAgainst || (Number(sale.total) || 0) < 0).length,
    itemCount,
    totalCost,
    totalProfit,
    totalDiscount,
    paymentTotals,
    paymentCounts,
    categoryTotals,
    workerTotals,
    topItems
  };
}

function setSummaryChartMetric(metric) {
  summaryChartMetric = metric;
  renderSummaryChart();
}

function setSummaryChartType(type) {
  summaryChartType = type;
  renderSummaryChart();
}

function refreshSummaryChartControls() {
  ["hourly", "payments", "categories"].forEach(metric => document.getElementById(`chartMetric-${metric}`)?.classList.toggle("active", summaryChartMetric === metric));
  ["bar", "line", "pie"].forEach(type => document.getElementById(`chartType-${type}`)?.classList.toggle("active", summaryChartType === type));
}

function getSummaryTimeSlotIndex(date) {
  const saleDate = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(saleDate.getTime())) return -1;
  const minutes = saleDate.getHours() * 60 + saleDate.getMinutes();
  if (minutes < SUMMARY_START_MINUTES || minutes > SUMMARY_END_MINUTES) return -1;
  return Math.floor((minutes - SUMMARY_START_MINUTES) / SUMMARY_SLOT_MINUTES);
}

function renderSummaryChart() {
  refreshSummaryChartControls();
  const canvas = document.getElementById("summaryChart");
  const empty = document.getElementById("summaryChartEmpty");
  const title = document.getElementById("summaryChartTitle");
  const subtitle = document.getElementById("summaryChartSubtitle");
  if (!canvas) return;
  if (typeof Chart === "undefined") {
    if (empty) { showHiddenElement(empty, "grid"); empty.textContent = "Chart.js could not load"; }
    canvas.style.display = "none";
    return;
  }
  const palettes = ["#2563eb", "#dc2626", "#16a34a", "#f59e0b", "#7c3aed", "#0891b2", "#be123c", "#475569"];
  let labels = [];
  let values = [];
  let chartTitle = "Hourly revenue (GHS)";
  let chartSubtitle = "Sales grouped from 7:30am to 10:00pm";
  if (summaryChartMetric === "hourly") {
    labels = summaryChartData.hourlyLabels || SUMMARY_HOURLY_LABELS;
    values = summaryChartData.hourly;
    chartTitle = summaryChartData.hourlyTitle || chartTitle;
    chartSubtitle = summaryChartData.hourlySubtitle || chartSubtitle;
  } else if (summaryChartMetric === "payments") {
    labels = summaryChartData.payments.map(row => row[0]);
    values = summaryChartData.payments.map(row => row[1]);
    chartTitle = "Payment methods (GHS)";
    chartSubtitle = "Payment totals with hover values";
  } else {
    labels = summaryChartData.categories.map(row => row[0]);
    values = summaryChartData.categories.map(row => row[1]);
    chartTitle = "Sales by category (GHS)";
    chartSubtitle = "Top categories by revenue";
  }
  if (title) title.textContent = chartTitle;
  if (subtitle) subtitle.textContent = chartSubtitle;
  const hasData = values.some(value => value !== 0);
  if (hasData) hideHiddenElement(empty); else showHiddenElement(empty, "grid");
  canvas.style.display = hasData ? "block" : "none";
  if (!hasData) {
    if (summaryChart) { summaryChart.destroy(); summaryChart = null; }
    return;
  }
  if (summaryChart) summaryChart.destroy();
  const isPie = summaryChartType === "pie";
  const isLine = summaryChartType === "line";
  summaryChart = new Chart(canvas, {
    type: summaryChartType,
    data: {
      labels,
      datasets: [{
        label: chartTitle,
        data: values,
        backgroundColor: isPie ? labels.map((_, index) => palettes[index % palettes.length]) : "rgba(37,99,235,.32)",
        borderColor: isPie ? "#ffffff" : "#2563eb",
        borderWidth: isPie ? 2 : 2,
        fill: isLine ? false : true,
        tension: .35,
        pointRadius: isLine ? 4 : 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: isPie, position: "bottom" },
        tooltip: { callbacks: { label: context => `${context.label}: ${money(context.parsed.y ?? context.parsed)}` } }
      },
      scales: isPie ? {} : {
        y: { beginAtZero: true, ticks: { callback: value => `GHS ${value}` }, grid: { color: "rgba(148,163,184,.22)" } },
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: summaryChartMetric === "hourly" ? Math.min(12, Math.max(6, labels.length)) : 10 } }
      }
    }
  });
}

function renderSummaryDetailChart(key, config) {
  const canvas = document.getElementById(config.canvasId);
  const empty = document.getElementById(config.emptyId);
  if (!canvas) return;
  if (typeof Chart === "undefined") {
    if (empty) { showHiddenElement(empty, "grid"); empty.textContent = "Chart.js could not load"; }
    canvas.style.display = "none";
    return;
  }
  const labels = config.labels || [];
  const values = (config.values || []).map(value => Number(value) || 0);
  const hasData = values.some(value => value !== 0);
  if (hasData) hideHiddenElement(empty); else showHiddenElement(empty, "grid");
  canvas.style.display = hasData ? "block" : "none";
  if (summaryDetailCharts[key]) {
    summaryDetailCharts[key].destroy();
    summaryDetailCharts[key] = null;
  }
  if (!hasData) return;

  const palette = config.palette || ["#1d4ed8", "#b42318", "#16a34a", "#b7791f", "#7c3aed", "#0891b2", "#475569"];
  const isHorizontal = config.indexAxis === "y";
  const trimLabel = label => {
    const text = String(label ?? "");
    return text.length > 20 ? `${text.slice(0, 19)}...` : text;
  };
  const formatAxisValue = value => {
    if (config.axisFormatter) return config.axisFormatter(value);
    return Number.isFinite(Number(value)) ? Number(value).toLocaleString("en-GH") : value;
  };
  summaryDetailCharts[key] = new Chart(canvas, {
    type: config.type || "bar",
    data: {
      labels,
      datasets: [{
        label: config.label || "",
        data: values,
        backgroundColor: labels.map((_, index) => palette[index % palette.length]),
        borderColor: labels.map((_, index) => palette[index % palette.length]),
        borderWidth: 1,
        borderRadius: 6,
        maxBarThickness: config.maxBarThickness || 34
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: config.indexAxis || "x",
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: context => {
              const value = isHorizontal ? context.parsed.x : context.parsed.y;
              const extra = config.subLabels?.[context.dataIndex] ? ` - ${config.subLabels[context.dataIndex]}` : "";
              return `${config.valueFormatter ? config.valueFormatter(value) : money(value)}${extra}`;
            }
          }
        }
      },
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: isHorizontal ? "rgba(148,163,184,.18)" : "transparent" },
          ticks: { maxTicksLimit: 5, callback: function (value) { return isHorizontal ? formatAxisValue(value) : trimLabel(this.getLabelForValue(value)); } }
        },
        y: {
          beginAtZero: true,
          grid: { color: isHorizontal ? "transparent" : "rgba(148,163,184,.18)" },
          ticks: { callback: function (value) { return isHorizontal ? trimLabel(this.getLabelForValue(value)) : formatAxisValue(value); } }
        }
      }
    }
  });
}

function formatSummaryDuration(seconds) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  return `${Math.floor(safeSeconds / 3600)}h ${Math.floor((safeSeconds % 3600) / 60)}m`;
}

function renderSummaryBars(targetId, rows, options = {}) {
  const target = document.getElementById(targetId);
  if (!target) return;
  const visibleRows = (rows || []).filter(row => Number(row.value) > 0);
  if (!visibleRows.length) {
    renderHtml(target, options.empty || `<div class="empty-cart"><div>No data recorded yet</div></div>`);
    return;
  }
  const max = Math.max(...visibleRows.map(row => Number(row.value) || 0), 1);
  const total = options.total ?? visibleRows.reduce((sum, row) => sum + (Number(row.value) || 0), 0);
  const palette = ["#2563eb", "#dc2626", "#16a34a", "#f59e0b", "#7c3aed", "#0891b2"];
  renderHtml(target, `
    <div class="summary-viz">
      ${visibleRows.map((row, index) => {
        const value = Number(row.value) || 0;
        const width = Math.max(4, Math.round((value / max) * 100));
        const share = total ? Math.round((value / total) * 100) : 0;
        const color = row.color || palette[index % palette.length];
        const valueLabel = options.formatValue ? options.formatValue(value, row) : money(value);
        return `
          <div class="summary-viz-row">
            <div class="summary-viz-head">
              <span>${sanitize(row.label)}</span>
              <strong>${sanitize(valueLabel)}</strong>
            </div>
            <div class="summary-viz-track" aria-label="${sanitize(row.label)} ${sanitize(valueLabel)}">
              <div class="summary-viz-fill" style="width:${width}%;background:${color};"></div>
            </div>
            <div class="summary-viz-meta">
              <span>${sanitize(row.sub || "")}</span>
              <b>${share}%</b>
            </div>
          </div>
        `;
      }).join("")}
      ${options.footerHtml || ""}
    </div>
  `);
}

function updateSummary() {
  const summaryRange = getSummaryRange();
  updateSummaryFilterButtons();
  updateSummaryRangeInputs();
  const trendButton = document.getElementById("chartMetric-hourly");
  if (trendButton) trendButton.textContent = summaryRange.isSingleDay ? "Hourly" : "Daily";
  const selectedSales = getRecordsForBranch(salesHistory, getCurrentBranchId()).filter(sale => saleFallsInSummaryRange(sale, summaryRange));
  const revenue = selectedSales.reduce((sum, sale) => sum + (Number(sale.total) || 0), 0);
  const txCount = selectedSales.filter(sale => !sale.refundAgainst && (Number(sale.total) || 0) >= 0).length;
  const items = selectedSales.reduce((sum, sale) => {
    if (sale.refundAgainst || (Number(sale.total) || 0) < 0) return sum;
    return sum + (sale.items?.reduce((itemSum, item) => itemSum + (Number(item.qty) || 0), 0) || 0);
  }, 0);
  const paymentCounts = {};
  const paymentTotals = {};
  const categoryTotals = {};
  const branchTotals = {};
  const workerTotals = {};
  const revenueTrend = buildSummaryRevenueTrend(selectedSales, summaryRange);
  let totalDiscount = 0;
  let totalProfit = 0;
  let totalCost = 0;
  let expectedCash = 0;

  selectedSales.forEach(sale => {
    const itemSign = sale.refundAgainst || (Number(sale.total) || 0) < 0 ? -1 : 1;
    const details = getAccountingPaymentDetails(sale);
    details.forEach(detail => {
      const method = detail.method || 'Unknown';
      const amount = detail.amount || 0;
      paymentCounts[method] = (paymentCounts[method] || 0) + 1;
      paymentTotals[method] = (paymentTotals[method] || 0) + amount;
      if (String(method).toLowerCase() === "cash") expectedCash += amount;
    });
    totalDiscount += Number(sale.discount) || 0;
    totalProfit += Number(sale.profit) || 0;
    totalCost += Number(sale.totalCost) || 0;
    const branch = sale.branch || 'Unknown';
    if (!branchTotals[branch]) branchTotals[branch] = { revenue: 0, tx: 0 };
    branchTotals[branch].revenue += Number(sale.total) || 0;
    if (!sale.refundAgainst) branchTotals[branch].tx += 1;
    const worker = sale.processedBy || 'Unknown';
    if (!workerTotals[worker]) workerTotals[worker] = { revenue: 0, tx: 0 };
    workerTotals[worker].revenue += Number(sale.total) || 0;
    if (!sale.refundAgainst) workerTotals[worker].tx += 1;
    sale.items?.forEach(item => {
      const category = item.cat || item.category || 'Uncategorized';
      const net = Math.max(0, (item.price || 0) - (parseFloat(item.itemDiscount) || 0));
      categoryTotals[category] = (categoryTotals[category] || 0) + net * (Number(item.qty) || 0) * itemSign;
    });
  });

  hourlyData = revenueTrend.values;
  topDrugs = {};
  selectedSales.forEach(sale => {
    const itemSign = sale.refundAgainst || (Number(sale.total) || 0) < 0 ? -1 : 1;
    sale.items?.forEach(item => {
      const net = Math.max(0, (item.price || 0) - (parseFloat(item.itemDiscount) || 0));
      if (!topDrugs[item.name]) topDrugs[item.name] = { units: 0, rev: 0 };
      topDrugs[item.name].units += (Number(item.qty) || 0) * itemSign;
      topDrugs[item.name].rev += net * (Number(item.qty) || 0) * itemSign;
    });
  });

  document.getElementById("sumRev").textContent = `GHS ${revenue.toFixed(2)}`;
  document.getElementById("sumTx").textContent = txCount;
  document.getElementById("sumItems").textContent = items;
  setText("sumRevSub", `${txCount} transaction${txCount === 1 ? "" : "s"}`);
  setText("sumTxSub", summaryRange.label);
  const topMethodEntry = Object.entries(paymentCounts || {}).sort((a, b) => b[1] - a[1])[0] || null;
  document.getElementById("sumPay").textContent = topMethodEntry ? topMethodEntry[0] : 'Cash';
  document.getElementById("sumPaySub").textContent = topMethodEntry ? `${topMethodEntry[1]} times` : 'No sales yet';
  const low = getLowStockItems().length;
  document.getElementById("sumLow").textContent = low;
  document.getElementById("sumLowSub").textContent = low ? `${low} low-stock item(s)` : "Inventory healthy";
  document.getElementById("sumDate").textContent = summaryRange.label;

  const periodHours = getLiveShiftHoursForSummaryRange(summaryRange);
  const currentUsername = currentUser?.username;
  const currentTotal = periodHours[currentUsername] || 0;
  const currentLabel = currentTotal ? formatSummaryDuration(currentTotal) : "0h 00m";
  document.getElementById("sumWorkerHours").textContent = currentLabel;
  document.getElementById("sumWorkerHoursSub").textContent = currentUsername ? `${currentUsername}'s total for ${summaryRange.label}` : "No worker logged in";

  const workerRows = Object.entries(periodHours).sort((a, b) => b[1] - a[1]);
  renderSummaryDetailChart("workerHours", {
    canvasId: "workerHoursChart",
    emptyId: "workerHoursChartEmpty",
    label: "Worker hours",
    labels: workerRows.map(([username]) => username),
    values: workerRows.map(([, seconds]) => seconds / 3600),
    subLabels: workerRows.map(([, seconds]) => formatSummaryDuration(seconds)),
    valueFormatter: value => `${value.toFixed(2)}h`,
    axisFormatter: value => `${value}h`,
    indexAxis: "y",
    palette: ["#1d4ed8", "#16a34a", "#b7791f", "#7c3aed"]
  });


  const sortedDrugs = Object.entries(topDrugs)
    .filter(([, stats]) => stats.units > 0)
    .sort((a, b) => b[1].units - a[1].units)
    .slice(0, 5);
  renderSummaryBars(
    "topDrugsList",
    sortedDrugs.map(([name, stats], idx) => ({
      label: `${idx + 1}. ${name}`,
      value: stats.units,
      sub: `${money(stats.rev)} revenue`
    })),
    {
      formatValue: value => `${value} unit${value === 1 ? "" : "s"}`,
      empty: `<div class="empty-cart"><div>No sales yet</div></div>`
    }
  );

  const categoryRows = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]).slice(0, 6);
  renderSummaryDetailChart("categoryBreakdown", {
    canvasId: "categoryBreakdownChart",
    emptyId: "categoryBreakdownChartEmpty",
    label: "Category revenue",
    labels: categoryRows.map(([cat]) => cat),
    values: categoryRows.map(([, value]) => value),
    valueFormatter: value => money(value),
    axisFormatter: value => `GHS ${value}`,
    indexAxis: "y",
    palette: ["#1d4ed8", "#b42318", "#16a34a", "#b7791f", "#7c3aed", "#0891b2"]
  });

  const branchRows = Object.entries(branchTotals).sort((a, b) => b[1].revenue - a[1].revenue);
  renderSummaryDetailChart("branchComparison", {
    canvasId: "branchComparisonChart",
    emptyId: "branchComparisonChartEmpty",
    label: "Branch revenue",
    labels: branchRows.map(([branch]) => branch),
    values: branchRows.map(([, stats]) => stats.revenue),
    subLabels: branchRows.map(([, stats]) => `${stats.tx} sale${stats.tx === 1 ? "" : "s"}`),
    valueFormatter: value => money(value),
    axisFormatter: value => `GHS ${value}`,
    indexAxis: "y",
    palette: ["#1d4ed8", "#b42318", "#16a34a", "#b7791f", "#7c3aed"]
  });

  const paymentRows = Object.entries(paymentTotals).sort((a, b) => b[1] - a[1]);
  setText("expectedCashTotal", money(expectedCash));
  renderSummaryDetailChart("paymentBreakdown", {
    canvasId: "paymentBreakdownChart",
    emptyId: "paymentBreakdownChartEmpty",
    label: "Payment totals",
    labels: paymentRows.map(([method]) => method),
    values: paymentRows.map(([, value]) => value),
    subLabels: paymentRows.map(([method]) => `${paymentCounts[method]} payment${paymentCounts[method] === 1 ? "" : "s"}`),
    valueFormatter: value => money(value),
    axisFormatter: value => `GHS ${value}`,
    indexAxis: "y",
    palette: ["#1d4ed8", "#16a34a", "#b42318", "#b7791f"]
  });

  summaryChartData = {
    hourly: revenueTrend.values,
    hourlyLabels: revenueTrend.labels,
    hourlyTitle: revenueTrend.title,
    hourlySubtitle: revenueTrend.subtitle,
    payments: paymentRows,
    categories: categoryRows
  };
  renderSummaryChart();

  const workerPerfRows = Object.entries(workerTotals).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 5);
  renderSummaryDetailChart("workerPerformance", {
    canvasId: "workerPerformanceChart",
    emptyId: "workerPerformanceChartEmpty",
    label: "Worker revenue",
    labels: workerPerfRows.map(([worker], idx) => `${idx + 1}. ${worker}${worker === currentUsername ? " (you)" : ""}`),
    values: workerPerfRows.map(([, stats]) => stats.revenue),
    subLabels: workerPerfRows.map(([, stats]) => `${stats.tx} transaction${stats.tx === 1 ? "" : "s"}`),
    valueFormatter: value => money(value),
    axisFormatter: value => `GHS ${value}`,
    indexAxis: "y",
    palette: ["#1d4ed8", "#b42318", "#16a34a", "#b7791f", "#7c3aed"]
  });
}

function renderShiftLog() {
  const today = new Date().toISOString().slice(0, 10);
  const records = { ...(shiftHours[today] || {}) };
  if (shiftSession && shiftSession.username) {
    const liveSeconds = Math.floor((new Date() - new Date(shiftSession.sessionStart)) / 1000);
    records[shiftSession.username] = (records[shiftSession.username] || 0) + liveSeconds;
  }
  const entries = Object.entries(records).sort((a, b) => b[1] - a[1]);
  const list = document.getElementById("shiftLogList");
  document.getElementById("shiftLogHeader").textContent = `Shift hours for ${today}`;
  if (!entries.length) {
    renderHtml(list, `<div class="empty-cart"><i class="ti ti-clock"></i><div>No shift records for today</div></div>`);
    return;
  }
  renderHtml(list, entries.map(([username, seconds], idx) => `
        <div class="held-sale" data-key="shift-${sanitize(username)}">
          <div>
            <div class="item-name">${idx + 1}. ${sanitize(username)}</div>
            <div class="held-meta">${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m</div>
          </div>
        </div>
      `).join(""));
}

function renderHistory() {
  const list = document.getElementById("historyList");
  const filteredSales = getFilteredHistorySales();
  if (!filteredSales.length) return renderHtml(list, `<div class="empty-cart"><i class="ti ti-calendar"></i><div>No history for ${sanitize(formatDateLabel())}</div></div>`);
  const totals = getHistoryTotals(filteredSales);
  const profitLabel = totals.profit !== 0 ? ` - Profit GHS ${totals.profit.toFixed(2)}` : "";
  renderHtml(list, `
        <div class="summary-card" style="margin-bottom:16px;">
          <div class="section-header"><i class="ti ti-chart-line"></i> History Summary</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;">
            <div><strong>GHS ${totals.revenue.toFixed(2)}</strong><div style="color:var(--muted);">Revenue</div></div>
            <div><strong>${totals.transactions}</strong><div style="color:var(--muted);">Transactions</div></div>
            <div><strong>GHS ${totals.profit.toFixed(2)}</strong><div style="color:var(--muted);">Profit</div></div>
            <div><strong>${totals.returns}</strong><div style="color:var(--muted);">Returns</div></div>
          </div>
          <div style="margin-top:12px;color:var(--muted);">Range: ${sanitize(formatDateLabel())}</div>
        </div>
      ` + filteredSales.map(sale => `
        <div class="held-sale" data-key="${sanitize(sale.id)}">
          <div>
            <div class="item-name">${sanitize(sale.id)} - ${sanitize(sale.customer || "Walk-in")}</div>
            <div class="held-meta">${sanitize(new Date(sale.date).toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" }))} - ${sanitize(sale.payment || "Unknown")}${sale.onAccount ? ` - On account` : ""}${sale.refundAgainst ? ` - Refund of ${sanitize(sale.refundAgainst)}` : ""}</div>
          </div>
          <div>
            <div class="item-total">GHS ${Number(sale.total || 0).toFixed(2)}</div>
          </div>
        </div>
      `).join(""));
}

function reportEscape(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function buildReportRows(entries, emptyText, formatter) {
  if (!entries.length) return `<tr><td colspan="3" class="empty-row">${emptyText}</td></tr>`;
  return entries.map(formatter).join("");
}

function getReportExportData(sales, hoursRecords) {
  const summary = summarizeSales(sales);
  return {
    summary,
    paymentRows: Object.entries(summary.paymentTotals).sort((a, b) => b[1] - a[1]),
    categoryRows: Object.entries(summary.categoryTotals).filter(([, value]) => value !== 0).sort((a, b) => b[1] - a[1]).slice(0, 10),
    topRows: Object.entries(summary.topItems).filter(([, stats]) => stats.units > 0).sort((a, b) => b[1].units - a[1].units).slice(0, 10),
    workerRows: Object.entries(summary.workerTotals).sort((a, b) => b[1].revenue - a[1].revenue),
    hourRows: Object.entries(hoursRecords || {}).sort((a, b) => b[1] - a[1])
  };
}

function safeReportFilename(title) {
  const date = new Date().toISOString().slice(0, 10);
  return `${String(title || "report").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}-${date}.pdf`;
}

function downloadPdfReport(title, meta, sales, hoursRecords) {
  const JsPDF = window.jspdf?.jsPDF || window.jsPDF;
  if (!JsPDF || !window.jspdf || typeof window.jspdf.jsPDF !== "function") {
    openPdfReportWindow(title, meta, sales, hoursRecords);
    showToast("PDF library unavailable; opened printable report", 3000, "warning");
    return;
  }
  const doc = new JsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  if (typeof doc.autoTable !== "function") {
    openPdfReportWindow(title, meta, sales, hoursRecords);
    showToast("PDF table library unavailable; opened printable report", 3000, "warning");
    return;
  }
  const { summary, paymentRows, categoryRows, topRows, workerRows, hourRows } = getReportExportData(sales, hoursRecords);
  const generated = new Date().toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" });
  const margin = 42;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  let y = 42;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("Akopharmah Pharmacy", margin, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text("+233248718050 | +233541100007 | akopharmahcompanylimited.com.gh", margin, y + 15);
  doc.text(`Generated ${generated}`, pageWidth - margin, y, { align: "right" });
  doc.text(currentUser?.username || "system", pageWidth - margin, y + 15, { align: "right" });
  y += 48;
  doc.setDrawColor(37, 99, 235);
  doc.setLineWidth(2);
  doc.line(margin, y, pageWidth - margin, y);
  y += 24;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text(title, margin, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(meta, margin, y + 15);
  y += 36;

  doc.autoTable({
    startY: y,
    margin: { left: margin, right: margin },
    theme: "grid",
    head: [["Metric", "Value", "Metric", "Value"]],
    body: [
      ["Revenue", money(summary.revenue), "Transactions", summary.transactions],
      ["Items sold", summary.itemCount, "Profit", money(summary.totalProfit)],
      ["Discounts", money(summary.totalDiscount), "Cost", money(summary.totalCost)],
      ["Returns", summary.returns, "Branch", getCurrentBranchName()]
    ],
    styles: { fontSize: 8, cellPadding: 5 },
    headStyles: { fillColor: [37, 99, 235] }
  });
  y = doc.lastAutoTable.finalY + 18;

  const addTable = (heading, head, body, emptyRow) => {
    if (y > pageHeight - 140) { doc.addPage(); y = 42; }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(heading, margin, y);
    y += 8;
    doc.autoTable({
      startY: y,
      margin: { left: margin, right: margin },
      head: [head],
      body: body.length ? body : [emptyRow],
      theme: "striped",
      styles: { fontSize: 8, cellPadding: 5 },
      headStyles: { fillColor: [30, 64, 175] }
    });
    y = doc.lastAutoTable.finalY + 18;
  };

  addTable("Payment summary", ["Method", "Count", "Amount"], paymentRows.map(([method, value]) => [method, summary.paymentCounts[method] || 0, money(value)]), ["No payments recorded", "", ""]);
  addTable("Category breakdown", ["Category", "", "Revenue"], categoryRows.map(([cat, value]) => [cat, "", money(value)]), ["No category sales recorded", "", ""]);
  addTable("Top selling drugs", ["Drug", "Units", "Revenue"], topRows.map(([name, stats]) => [name, stats.units, money(stats.revenue)]), ["No items sold", "", ""]);
  addTable("Worker sales", ["Worker", "Transactions", "Revenue"], workerRows.map(([worker, stats]) => [worker, stats.tx, money(stats.revenue)]), ["No worker sales recorded", "", ""]);
  addTable("Worker hours", ["Worker", "", "Hours"], hourRows.map(([worker, seconds]) => [worker, "", `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`]), ["No worker hours recorded", "", ""]);

  if (y > pageHeight - 50) { doc.addPage(); y = 42; }
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text("Manager signature: __________________________", margin, y + 12);
  doc.text("Generated from Akopharmah POS", pageWidth - margin, y + 12, { align: "right" });
  doc.save(safeReportFilename(title));
  showToast("PDF report downloaded", 2500, "success");
}

function openPdfReportWindow(title, meta, sales, hoursRecords) {
  const { summary, paymentRows, categoryRows, topRows, workerRows, hourRows } = getReportExportData(sales, hoursRecords);
  const generated = new Date().toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${reportEscape(title)}</title>
        <style>
          @page{size:A4;margin:14mm}*{box-sizing:border-box}body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#0f172a;background:#fff}.report{max-width:980px;margin:0 auto}.brand{display:flex;align-items:center;justify-content:space-between;gap:18px;border-bottom:4px solid #2563eb;padding-bottom:18px}.brand-left{display:flex;align-items:center;gap:14px}.logo{width:54px;height:54px;border-radius:16px;background:linear-gradient(135deg,#dc2626,#2563eb);color:#fff;display:grid;place-items:center;font-weight:800;font-size:24px}.brand h1{margin:0;font-size:22px}.brand p,.meta{margin:4px 0 0;color:#475569;font-size:12px}.title{margin:22px 0 14px}.title h2{margin:0;font-size:20px}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0}.card{border:1px solid #dbeafe;border-radius:12px;padding:12px;background:#f8fafc}.card small{display:block;text-transform:uppercase;letter-spacing:.06em;color:#64748b;font-size:10px}.card strong{display:block;margin-top:6px;font-size:16px}.section{margin-top:20px;break-inside:avoid}.section h3{font-size:14px;margin:0 0 8px;color:#1e40af}table{width:100%;border-collapse:collapse;font-size:11px}th,td{padding:8px 9px;text-align:left;border-bottom:1px solid #e2e8f0}th{background:#eff6ff;color:#1e3a8a;text-transform:uppercase;font-size:10px}.amount{text-align:right;font-weight:700}.empty-row{text-align:center;color:#64748b;padding:18px}.footer{margin-top:24px;padding-top:12px;border-top:1px solid #e2e8f0;color:#64748b;font-size:11px;display:flex;justify-content:space-between;gap:12px}@media print{button{display:none}.section{break-inside:avoid}}
        </style></head><body><div class="report">
        <div class="brand"><div class="brand-left"><div class="logo">A</div><div><h1>Akopharmah Pharmacy</h1><p>+233248718050 | +233541100007 | akopharmahcompanylimited.com.gh</p></div></div><div class="meta">Generated ${reportEscape(generated)}<br>${reportEscape(currentUser?.username || "system")}</div></div>
        <div class="title"><h2>${reportEscape(title)}</h2><div class="meta">${reportEscape(meta)}</div></div>
        <div class="cards"><div class="card"><small>Revenue</small><strong>${money(summary.revenue)}</strong></div><div class="card"><small>Transactions</small><strong>${summary.transactions}</strong></div><div class="card"><small>Items sold</small><strong>${summary.itemCount}</strong></div><div class="card"><small>Profit</small><strong>${money(summary.totalProfit)}</strong></div><div class="card"><small>Discounts</small><strong>${money(summary.totalDiscount)}</strong></div><div class="card"><small>Cost</small><strong>${money(summary.totalCost)}</strong></div><div class="card"><small>Returns</small><strong>${summary.returns}</strong></div><div class="card"><small>Branch</small><strong>${reportEscape(getCurrentBranchName())}</strong></div></div>
        <div class="section"><h3>Payment summary</h3><table><thead><tr><th>Method</th><th>Count</th><th class="amount">Amount</th></tr></thead><tbody>${buildReportRows(paymentRows, "No payments recorded", ([method, value]) => `<tr><td>${reportEscape(method)}</td><td>${summary.paymentCounts[method] || 0}</td><td class="amount">${money(value)}</td></tr>`)}</tbody></table></div>
        <div class="section"><h3>Category breakdown</h3><table><thead><tr><th>Category</th><th></th><th class="amount">Revenue</th></tr></thead><tbody>${buildReportRows(categoryRows, "No category sales recorded", ([cat, value]) => `<tr><td>${reportEscape(cat)}</td><td></td><td class="amount">${money(value)}</td></tr>`)}</tbody></table></div>
        <div class="section"><h3>Top selling drugs</h3><table><thead><tr><th>Drug</th><th>Units</th><th class="amount">Revenue</th></tr></thead><tbody>${buildReportRows(topRows, "No items sold", ([name, stats]) => `<tr><td>${reportEscape(name)}</td><td>${stats.units}</td><td class="amount">${money(stats.revenue)}</td></tr>`)}</tbody></table></div>
        <div class="section"><h3>Worker sales</h3><table><thead><tr><th>Worker</th><th>Transactions</th><th class="amount">Revenue</th></tr></thead><tbody>${buildReportRows(workerRows, "No worker sales recorded", ([worker, stats]) => `<tr><td>${reportEscape(worker)}</td><td>${stats.tx}</td><td class="amount">${money(stats.revenue)}</td></tr>`)}</tbody></table></div>
        <div class="section"><h3>Worker hours</h3><table><thead><tr><th>Worker</th><th></th><th class="amount">Hours</th></tr></thead><tbody>${buildReportRows(hourRows, "No worker hours recorded", ([worker, seconds]) => `<tr><td>${reportEscape(worker)}</td><td></td><td class="amount">${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m</td></tr>`)}</tbody></table></div>
        <div class="footer"><span>Manager signature: __________________________</span><span>Printed from Akopharmah POS</span></div>
        </div><script>window.onload=function(){window.focus();window.print();setTimeout(function(){window.close();},500);};<\/script></body></html>`;
  const w = window.open("", "akopharm-pdf-report", "width=960,height=720");
  if (!w) return showToast("Popup blocked - allow popups to generate PDF", 2500, "error");
  w.document.open();
  w.document.write(html);
  w.document.close();
  showToast("PDF report print dialog opened");
}

function printEndOfDayReport() {
  const now = new Date();
  const range = getDayRange(now);
  const sales = getSalesInRange(range.start, range.end);
  const dateKey = now.toISOString().slice(0, 10);
  const meta = `${getCurrentBranchName()} | ${range.start.toLocaleDateString("en-GH", { dateStyle: "medium" })} | Full trading day`;
  downloadPdfReport("End-of-Day Report", meta, sales, getLiveShiftHoursForDate(dateKey));
}

function printEndOfShiftReport() {
  const now = new Date();
  const range = getCurrentShiftReportRange(now);
  const sales = getSalesInRange(range.start, range.end);
  const dateKey = range.start.toISOString().slice(0, 10);
  const meta = `${getCurrentBranchName()} | ${range.label} (${range.scheduled}) | ${range.start.toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" })} - ${range.end.toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" })}`;
  downloadPdfReport("End-of-Shift Report", meta, sales, getLiveShiftHoursForDate(dateKey));
}
