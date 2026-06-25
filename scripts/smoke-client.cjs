"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const sourceFiles = [
  "server.js",
  "index.html",
  "pos.css",
  "package.json",
  "package-lock.json",
  "render.yaml",
  "README-sync-backend.md",
  "js/app.js",
  "js/app-runtime.js",
  "js/core/dom-renderer.js",
  "js/modules/00-state-config.js",
  "js/modules/01-storage-api-session.js",
  "js/modules/02-backup-customers.js",
  "js/modules/03-sales-workflow.js",
  "js/modules/04-navigation-settings.js",
  "js/modules/05-dashboard-reports.js",
  "js/modules/06-returns-inventory-purchases.js",
  "js/modules/07-sync-shortcuts-expiry-init.js",
  "scripts/build-esm-runtime.cjs",
  "scripts/migrate-passwords.cjs",
  "scripts/smoke-bootstrap.cjs",
  "scripts/smoke-client.cjs",
  "scripts/smoke-server.cjs",
  "data/seed.json",
  "data/akopharmah-sync.json"
];
const moduleFiles = sourceFiles.filter(file => /^js\/modules\//.test(file));
const storageValues = new Map();
const storage = {
  getItem(key) { return storageValues.has(key) ? storageValues.get(key) : null; },
  setItem(key, value) { storageValues.set(key, String(value)); },
  removeItem(key) { storageValues.delete(key); }
};

const context = vm.createContext({
  console,
  crypto: crypto.webcrypto,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  ArrayBuffer,
  Date,
  Math,
  JSON,
  Object,
  Number,
  String,
  Boolean,
  RegExp,
  Map,
  Set,
  Promise,
  localStorage: storage,
  sessionStorage: storage,
  btoa(value) { return Buffer.from(value, "binary").toString("base64"); },
  atob(value) { return Buffer.from(value, "base64").toString("binary"); },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Blob,
  URL,
  window: null,
  document: {
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return { click() {}, remove() {}, style: {} }; },
    body: { appendChild() {}, removeChild() {}, classList: { toggle() {} } }
  }
});
context.window = {
  location: { hostname: "localhost", protocol: "http:", origin: "http://localhost:3000" },
  addEventListener() {},
  removeEventListener() {},
  open() { return null; },
  prompt() { return null; }
};
context.globalThis = context;

for (const file of [
  "js/modules/00-state-config.js",
  "js/modules/01-storage-api-session.js",
  "js/modules/02-backup-customers.js",
  "js/modules/03-sales-workflow.js",
  "js/modules/04-navigation-settings.js",
  "js/modules/05-dashboard-reports.js",
  "js/modules/06-returns-inventory-purchases.js"
]) {
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
}

async function run() {
  sourceFiles.forEach(file => {
    const filePath = path.join(root, file);
    if (file === "data/akopharmah-sync.json" && !fs.existsSync(filePath)) return;
    assert(fs.existsSync(filePath), `${file} is missing`);
    const bytes = fs.readFileSync(filePath);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assert.notEqual(text.charCodeAt(0), 0xFEFF, `${file} contains a UTF-8 BOM`);
    assert(!/(?:\u00c3[\u0080-\u00bf]|\u00c2[\u0080-\u00bf]|\u00e2[\u0080-\u00bf]{2}|[\u00e2\u00c3\u00c2]|\ufffd)/u.test(text),
      `${file} contains a common mojibake sequence`);
  });

  const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const renderConfig = fs.readFileSync(path.join(root, "render.yaml"), "utf8");
  const migrateScript = fs.readFileSync(path.join(root, "scripts", "migrate-passwords.cjs"), "utf8");
  const appModule = fs.readFileSync(path.join(root, "js", "app.js"), "utf8");
  const runtimeModule = fs.readFileSync(path.join(root, "js", "app-runtime.js"), "utf8");
  const rendererModule = fs.readFileSync(path.join(root, "js", "core", "dom-renderer.js"), "utf8");
  const customerModule = fs.readFileSync(path.join(root, "js", "modules", "02-backup-customers.js"), "utf8");
  const salesModule = fs.readFileSync(path.join(root, "js", "modules", "03-sales-workflow.js"), "utf8");
  assert(serverSource.includes("DATABASE_URL") && serverSource.includes("akopharmah_state"),
    "Server is missing PostgreSQL production storage support");
  assert(renderConfig.includes("fromDatabase:") && renderConfig.includes("akopharmah-pos-db"),
    "Render blueprint is missing the PostgreSQL database wiring");
  assert(migrateScript.includes("fs.existsSync(filePath)"),
    "Password migration script still crashes when the optional sync JSON file is missing");
  assert(indexHtml.includes('<script type="module" src="js/app.js"></script>'), "Index does not use the module entry point");
  assert(!indexHtml.includes('src="js/modules/00-state-config.js"'), "Index still loads classic application scripts");
  assert(appModule.includes('import { domRenderer }'), "Module entry does not declare its renderer dependency");
  assert(runtimeModule.includes('export { initializeApplication, browserEventHandlers }'), "Generated runtime does not export its public API");
  assert(rendererModule.includes("function patchNode") && rendererModule.includes("DOMPurify"), "Safe DOM patch renderer is missing");
  assert(!customerModule.includes("saved locally; server sync failed"), "Patient writes still report false local success");
  assert(salesModule.includes("saleSubmissionInProgress"), "Checkout lacks duplicate-submission protection");
  assert(!salesModule.includes("approveRx") && !salesModule.includes("containsPrescriptionDrug"),
    "Checkout still contains software prescription approval guards");
  assert(salesModule.includes("requestedDiscount > 100"), "Checkout lacks the 0-100% discount guard");
  assert(indexHtml.includes('id="drugSaleUnit"'), "Drug editor lacks a selling-unit selector");
  assert(indexHtml.includes('oninput="autoCalcCost()"'), "Selling price does not calculate cost price");
  const inventoryModule = fs.readFileSync(path.join(root, "js", "modules", "06-returns-inventory-purchases.js"), "utf8");
  assert(inventoryModule.includes("String(s.id) === String(supplierId)"),
    "GRN supplier matching still breaks string supplier IDs");
  assert(inventoryModule.includes("error?.message || \"Drug could not be deleted\""),
    "Inventory deletion still hides the server rejection reason");
  assert(inventoryModule.includes("force: hasStock") && inventoryModule.includes("Remove drug and branch stock"),
    "Director stocked-drug branch removal is not explicitly confirmed");
  assert(inventoryModule.includes("drug.branchAvailability[branchName] = false")
      && !inventoryModule.includes("drugs = drugs.filter(d => d.id !== id)"),
    "Inventory deletion still removes the shared drug record");
  const htmlIds = [...indexHtml.matchAll(/\bid\s*=\s*(["'])([^"']+)\1/gi)].map(match => match[2]);
  assert.equal(new Set(htmlIds).size, htmlIds.length, "Index contains duplicate element IDs");
  const allModuleSource = moduleFiles.map(file => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
  const declarations = new Set(
    [...allModuleSource.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map(match => match[1])
  );
  for (const match of allModuleSource.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) declarations.add(match[1]);
  const inlineCalls = new Set();
  for (const attribute of indexHtml.matchAll(/\bon(?:click|change|input|submit|keydown|keyup|blur|focus)\s*=\s*(["'])([\s\S]*?)\1/gi)) {
    for (const call of attribute[2].matchAll(/(?<!\.)\b([A-Za-z_$][\w$]*)\s*\(/g)) inlineCalls.add(call[1]);
  }
  const missingHandlers = [...inlineCalls].filter(name => !declarations.has(name) && !["if", "for", "while", "switch"].includes(name));
  assert.deepEqual(missingHandlers, [], `Index references missing handlers: ${missingHandlers.join(", ")}`);

  storage.setItem("akopharm_api_base", "https://attacker.example/api");
  context.window.location = { hostname: "akopharmah.onrender.com", protocol: "https:", origin: "https://akopharmah.onrender.com" };
  assert.equal(vm.runInContext("readApiBaseUrl()", context), "/api", "Hosted deployments accepted an external API override");
  storage.removeItem("akopharm_api_base");
  context.window.location = { hostname: "localhost", protocol: "http:", origin: "http://localhost:3000" };

  const offlineCredential = await vm.runInContext("createOfflineCredential('offline-password')", context);
  context.testOfflineCredential = offlineCredential;
  assert.equal(await vm.runInContext("verifyOfflineCredential('offline-password', testOfflineCredential)", context), true,
    "Fresh offline credential did not verify");
  context.expiredOfflineCredential = { ...offlineCredential, expiresAt: new Date(Date.now() - 1000).toISOString() };
  assert.equal(await vm.runInContext("verifyOfflineCredential('offline-password', expiredOfflineCredential)", context), false,
    "Expired offline credential was accepted");

  await vm.runInContext("prepareBackupEncryption('correct horse battery staple', 'director')", context);
  const envelope = await vm.runInContext("encryptBackupPayload({ patient: 'Private Patient', total: 42 })", context);
  assert.equal(envelope.format, "akopharm-encrypted-backup");
  assert(!JSON.stringify(envelope).includes("Private Patient"), "Encrypted backup leaked plaintext");
  context.testEnvelope = envelope;
  const decrypted = await vm.runInContext("decryptBackupPayload(testEnvelope)", context);
  assert.deepEqual(decrypted, { patient: "Private Patient", total: 42 });

  await vm.runInContext(`
    currentUser = { username: "director", name: "Director", role: "director" };
    drugs = [{ id: 1, name: "Drug", stock: 1, branchStock: { "Kwame Danso Main": 1 } }];
    customers = [{ id: 2, name: "Private Patient" }];
    salesHistory = [{ id: "SALE-1", date: new Date().toISOString(), items: [{ id: 1, name: "Drug", qty: 1, price: 10 }], total: 10 }];
    heldSales = [];
    saveMajorChangeBackup("test");
  `, context);
  await new Promise(resolve => setTimeout(resolve, 25));
  const storedBackups = storage.getItem("akopharm_major_change_backups");
  assert(storedBackups && !storedBackups.includes("Private Patient"), "Local safety backup stored readable patient data");

  const refundValidation = vm.runInContext(`validateSalesImport([{
    id: "RFND-1",
    date: new Date().toISOString(),
    refundAgainst: "SALE-1",
    items: [{ id: 1, name: "Drug", qty: 1, price: 10 }],
    total: -10,
    paid: -10,
    discount: 0
  }])`, context);
  assert.equal(refundValidation.ok, true, refundValidation.message);

  const backupValidation = vm.runInContext(`validateFullDataImport({ data: {
    drugs: [],
    customers: [],
    salesHistory: [],
    heldSales: [],
    shiftHours: {},
    referenceDrugs: [],
    auditLog: [],
    suppliers: [],
    purchaseHistory: [],
    draftPurchaseOrders: [],
    stockAdjustments: [],
    branchRecords: [{ id: "main", name: "Main" }],
    appSettings: {}
  }})`, context);
  assert.equal(backupValidation.ok, true, backupValidation.message);

  const normalizedRole = vm.runInContext(`
    userProfiles = [{ username: "worker", role: "manager", name: "Stale Local Role", branch_id: "kwame-danso-main" }];
    normalizeUserBranch({ username: "worker", role: "worker", name: "Server Role", branch_id: "kwame-danso-main", branch_ids: ["kwame-danso-main"] });
  `, context);
  assert.equal(normalizedRole.role, "worker", "Stale local role overrode the server role");

  const permissionChecks = vm.runInContext(`(() => {
    const permissions = cloneRolePermissions(DEFAULT_ROLE_PERMISSIONS);
    permissions.viewSummary = ["pharmacist"];
    permissions.managerAccess = ["manager"];
    applyRolePermissions({ permissions }, { persist: false });
    return {
      pharmacistSummary: hasPermission("viewSummary", { role: "pharmacist" }),
      managerSummary: hasPermission("viewSummary", { role: "manager" }),
      directorSummary: hasPermission("viewSummary", { role: "director" }),
      directorManagerAccess: hasPermission("managerAccess", { role: "director" })
    };
  })()`, context);
  assert.equal(permissionChecks.pharmacistSummary, true, "Downloaded permissions were not applied");
  assert.equal(permissionChecks.managerSummary, false, "Manager retained a revoked permission");
  assert.equal(permissionChecks.directorSummary, false, "Director incorrectly inherited manager permissions");
  assert.equal(permissionChecks.directorManagerAccess, true, "Director administrative access could be locked out");
  vm.runInContext("applyRolePermissions(DEFAULT_ROLE_PERMISSIONS, { persist: false })", context);

  const paymentDetails = vm.runInContext(`getAccountingPaymentDetails({
    total: 10,
    paid: 20,
    payment: "Cash",
    paymentDetails: [{ method: "Cash", amount: 20 }]
  })`, context);
  assert.equal(paymentDetails[0].amount, 10, "Cash report counted tendered cash instead of net sale value");

  const reciprocalPricing = vm.runInContext(`(() => {
    const originalGetElementById = document.getElementById;
    const fields = { drugCost: { value: "10" }, drugPrice: { value: "" } };
    document.getElementById = id => fields[id] || null;
    autoCalcPrice();
    const selling = fields.drugPrice.value;
    fields.drugPrice.value = "13";
    fields.drugCost.value = "";
    autoCalcCost();
    const cost = fields.drugCost.value;
    document.getElementById = originalGetElementById;
    return { selling, cost };
  })()`, context);
  assert.deepEqual(reciprocalPricing, { selling: "13.00", cost: "10.00" },
    "Cost and selling prices do not calculate in both directions");

  const refundSummary = vm.runInContext(`summarizeSales([
    {
      id: "SALE",
      total: 10,
      totalCost: 4,
      profit: 6,
      payment: "Cash",
      items: [{ id: 1, name: "Drug", cat: "Pain", qty: 1, price: 10 }]
    },
    {
      id: "REFUND",
      refundAgainst: "SALE",
      total: -10,
      totalCost: -4,
      profit: -6,
      payment: "Refund",
      items: [{ id: 1, name: "Drug", cat: "Pain", qty: 1, price: 10 }]
    }
  ])`, context);
  assert.equal(refundSummary.itemCount, 1, "Refund quantities inflated items sold");
  assert.equal(refundSummary.categoryTotals.Pain, 0, "Refund revenue was added to category revenue");
  assert.equal(refundSummary.topItems.Drug.units, 0, "Refund quantities were added to top-selling units");

  const historyTotals = vm.runInContext(`getHistoryTotals([
    { total: "10", profit: "6" },
    { refundAgainst: "SALE", total: "-10", profit: "-6" }
  ])`, context);
  assert.deepEqual(historyTotals, { revenue: 0, profit: 0, transactions: 1, returns: 1 },
    "History totals counted refunds as sales or concatenated numeric strings");

  const branchScopedReports = vm.runInContext(`(() => {
    branchRecords = [
      { id: "kwame-danso-main", name: "Kwame Danso Main" },
      { id: "techimantia", name: "Techimantia" }
    ];
    refreshBranchNames();
    branchIndex = 0;
    currentUser = {
      username: "director",
      role: "director",
      branch_id: "kwame-danso-main",
      branch_ids: ["kwame-danso-main", "techimantia"]
    };
    const now = new Date().toISOString();
    salesHistory = [
      { id: "MAIN", date: now, branch_id: "kwame-danso-main", branch: "Kwame Danso Main", total: 10 },
      { id: "TECH", date: now, branch_id: "techimantia", branch: "Techimantia", total: 20 }
    ];
    return {
      history: getFilteredHistorySales().map(sale => sale.id),
      report: getSalesInRange(new Date(Date.now() - 1000), new Date(Date.now() + 1000)).map(sale => sale.id)
    };
  })()`, context);
  assert.deepEqual(branchScopedReports.history, ["MAIN"], "History mixed sales from another branch");
  assert.deepEqual(branchScopedReports.report, ["MAIN"], "Summary/report calculations mixed branches");

  vm.runInContext(`
    drugs = [{ id: 1, stock: 2 }];
    cart = [{ id: 1, qty: 2 }];
    renderCart = function () {};
    showToast = function () {};
    changeQty(1, 1);
  `, context);
  assert.equal(vm.runInContext("cart[0].qty", context), 2, "Cart quantity exceeded available stock");

  const staleCart = vm.runInContext(`(() => {
    branchRecords = [{ id: "kwame-danso-main", name: "Kwame Danso Main" }];
    refreshBranchNames();
    branchIndex = 0;
    drugs = [{ id: 1, name: "Drug", stock: 1, branchStock: { "Kwame Danso Main": 1 }, batches: [] }];
    return validateCartForCheckout([{ id: 1, name: "Drug", qty: 2 }], "kwame-danso-main");
  })()`, context);
  assert.equal(staleCart.ok, false, "Checkout accepted a cart quantity above current stock");

  const branchAvailability = vm.runInContext(`(() => {
    branchRecords = [
      { id: "kwame-danso-main", name: "Kwame Danso Main" },
      { id: "techimantia", name: "Techimantia" }
    ];
    refreshBranchNames();
    branchIndex = 0;
    drugs = [{
      id: 1,
      name: "Branch Drug",
      stock: 0,
      branchStock: { "Kwame Danso Main": 0, "Techimantia": 4 },
      branchAvailability: { "Kwame Danso Main": false, "Techimantia": true },
      batches: []
    }];
    const checkout = validateCartForCheckout([{ id: 1, name: "Branch Drug", qty: 1 }], "kwame-danso-main");
    return {
      mainVisible: isDrugAvailableAtBranch(drugs[0], "kwame-danso-main"),
      techVisible: isDrugAvailableAtBranch(drugs[0], "techimantia"),
      currentList: getAvailableDrugsForBranch().map(drug => drug.id),
      checkout
    };
  })()`, context);
  assert.equal(branchAvailability.mainVisible, false, "A branch-removed drug remained available at that branch");
  assert.equal(branchAvailability.techVisible, true, "Branch removal hid the drug at another branch");
  assert.deepEqual(branchAvailability.currentList, [], "Branch-removed drug remained in the current branch list");
  assert.equal(branchAvailability.checkout.ok, false, "Checkout accepted a drug removed from the branch");

  const heldCustomerId = vm.runInContext(`(() => {
    branchRecords = [{ id: "kwame-danso-main", name: "Kwame Danso Main" }];
    refreshBranchNames();
    branchIndex = 0;
    currentUser = { username: "worker", name: "Worker", role: "worker", branch_id: "kwame-danso-main" };
    customers = [
      { id: 2, name: "Duplicate Name" },
      { id: 3, name: "Duplicate Name" }
    ];
    selectedCustomerId = 3;
    cart = [{ id: 1, name: "Drug", qty: 1, price: 10 }];
    heldSales = [];
    renderCart = function () {};
    renderHeld = function () {};
    showToast = function () {};
    holdSale();
    return heldSales[0]?.customerId;
  })()`, context);
  assert.equal(heldCustomerId, 3, "Held sale did not retain the selected patient ID");

  const restoredLegacyReturn = vm.runInContext(`(() => {
    branchRecords = [{ id: "kwame-danso-main", name: "Kwame Danso Main" }];
    refreshBranchNames();
    branchIndex = 0;
    const drug = { id: 1, name: "Legacy Drug", costPrice: 2, stock: 0, branchStock: { "Kwame Danso Main": 0 }, batches: [] };
    restoreReturnedItemStock(drug, { id: 1, name: "Legacy Drug", qty: 1 }, "kwame-danso-main", "LEGACY-SALE");
    return { stock: drug.stock, branchStock: drug.branchStock["Kwame Danso Main"], batches: drug.batches };
  })()`, context);
  assert.equal(restoredLegacyReturn.stock, 1, "Legacy return did not restore branch stock");
  assert.equal(restoredLegacyReturn.branchStock, 1, "Legacy return did not restore named branch stock");
  assert.equal(restoredLegacyReturn.batches.reduce((sum, batch) => sum + batch.qty, 0), 1,
    "Legacy return did not create matching batch stock");

  console.log("Client release audit passed: UTF-8, handlers, reports, encrypted backups, permissions, returns, and stock limits work.");
}

run().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
