"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const bcrypt = require("../vendor/bcryptjs.cjs");

const root = path.resolve(__dirname, "..");
const port = 32000 + Math.floor(Math.random() * 10000);
const dataFile = path.join(os.tmpdir(), `akopharmah-sync-smoke-${process.pid}-${Date.now()}.json`);
const baseUrl = `http://127.0.0.1:${port}`;
const directorUsername = `smoke-director-${Date.now()}`;
const directorPassword = crypto.randomBytes(18).toString("base64url");
const seed = JSON.parse(fs.readFileSync(path.join(root, "data", "seed.json"), "utf8"));
seed.drugs[0].stock = 100;
seed.drugs[0].saleUnit = "Strip";
seed.drugs[0].branchStock = Object.fromEntries(seed.branches.map(branch => [branch.name, branch.id === "kwame-danso-main" ? 100 : 0]));
seed.drugs[0].batches = [{
  id: "SMOKE-BATCH-1",
  batch: "SMOKE-1",
  expiry: "2030-12-31",
  qty: 100,
  initialQty: 100,
  branch_id: "kwame-danso-main",
  cost: seed.drugs[0].costPrice
}];
seed.drugs[1].batches = [{
  id: "SMOKE-BATCH-2",
  batch: "SMOKE-2",
  expiry: "2030-12-31",
  qty: 1,
  initialQty: 1,
  branch_id: "kwame-danso-main",
  cost: seed.drugs[1].costPrice
}];
seed.drugs[1].stock = 1;
seed.drugs[1].branchStock = Object.fromEntries(seed.branches.map(branch => [branch.name, branch.id === "kwame-danso-main" ? 1 : 0]));
const prescriptionDrug = seed.drugs.find(drug => drug.rx);
if (!prescriptionDrug) throw new Error("Smoke seed does not contain a prescription medicine");
prescriptionDrug.stock = 1;
prescriptionDrug.branchStock = Object.fromEntries(seed.branches.map(branch => [branch.name, branch.id === "kwame-danso-main" ? 1 : 0]));
seed.drugs.push({
  id: 997,
  name: "Branch Scoped Delete Drug",
  form: "Tablet",
  cat: "Test",
  price: 8,
  costPrice: 4,
  stock: 3,
  branch_id: "kwame-danso-main",
  branchStock: Object.fromEntries(seed.branches.map(branch => [
    branch.name,
    branch.id === "kwame-danso-main" ? 3 : branch.id === "techimantia" ? 4 : 0
  ])),
  batches: [
    {
      id: "BRANCH-DELETE-MAIN",
      batch: "MAIN",
      expiry: "2035-01-01",
      qty: 3,
      initialQty: 3,
      branch_id: "kwame-danso-main",
      cost: 4
    },
    {
      id: "BRANCH-DELETE-TECH",
      batch: "TECH",
      expiry: "2035-01-01",
      qty: 4,
      initialQty: 4,
      branch_id: "techimantia",
      cost: 4
    }
  ]
});
seed.drugs.push({
  id: 998,
  name: "Legacy Branch Stock",
  form: "Tablet",
  cat: "Test",
  price: 5,
  costPrice: 2,
  stock: 7,
  branch_id: "techimantia"
});
seed.drugs.push({
  id: 999,
  name: "Legacy Return Drug",
  form: "Tablet",
  cat: "Test",
  price: 10,
  costPrice: 4,
  stock: 0,
  branch_id: "kwame-danso-main",
  branchStock: Object.fromEntries(seed.branches.map(branch => [branch.name, 0])),
  batches: []
});
const legacySale = {
  id: "LEGACY-SALE-NO-BATCH",
  date: new Date().toISOString(),
  branch_id: "kwame-danso-main",
  branch: "Kwame Danso Main",
  customer: "Walk-in",
  payment: "Cash",
  paid: 10,
  items: [{ id: 999, drug_id: 999, name: "Legacy Return Drug", qty: 1, price: 10 }],
  total: 10,
  totalCost: 4,
  profit: 6,
  discount: 0
};
seed.users.push({
  username: directorUsername,
  name: "Smoke Test Director",
  role: "director",
  branch_id: "kwame-danso-main",
  branch_ids: seed.branches.map(branch => branch.id),
  passwordHash: bcrypt.hashSync(directorPassword, 10)
});
fs.writeFileSync(dataFile, JSON.stringify({
  ...seed,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  sales: [legacySale],
  suppliers: [],
  purchases: [],
  heldSales: [],
  auditLog: [],
  stockTransfers: [],
  stockWriteoffs: []
}, null, 2));

const child = spawn(process.execPath, ["server.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    AKOPHARMAH_DATA_FILE: dataFile,
    RENDER: "false"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
child.stdout.on("data", chunk => { output += chunk.toString(); });
child.stderr.on("data", chunk => { output += chunk.toString(); });

async function rawRequest(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { response, payload, text };
}

async function request(pathname, options = {}) {
  const result = await rawRequest(pathname, options);
  if (!result.response.ok) {
    throw new Error(`${options.method || "GET"} ${pathname} failed (${result.response.status}): ${result.text}`);
  }
  return result.payload;
}

function authHeaders(token, extra = {}) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "X-Branch-Id": "kwame-danso-main",
    ...extra
  };
}

async function waitForServer() {
  let lastError = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited early.\n${output}`);
    try {
      return await request("/api/health");
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw lastError || new Error("Server did not become ready");
}

async function run() {
  const health = await waitForServer();
  if (!health?.ok || !health.storage?.configured) throw new Error("Health endpoint did not report ready persistent storage");

  const publicCustomers = await rawRequest("/api/customers");
  if (publicCustomers.response.status !== 401) throw new Error("Customers endpoint allowed an unauthenticated request");
  const publicSeed = await rawRequest("/data/seed.json");
  if (publicSeed.response.status !== 200 || !Array.isArray(publicSeed.payload?.drugs)) {
    throw new Error("Public ES-module seed endpoint was not available");
  }
  if (publicSeed.payload.drugs.some(drug =>
    Number(drug.stock) !== 0 || Object.values(drug.branchStock || {}).some(value => Number(value) !== 0))) {
    throw new Error("Public seed invented opening stock for a fresh deployment");
  }
  if (publicSeed.text.includes("passwordHash") || publicSeed.text.includes("Mr. Kwame Mensah")) {
    throw new Error("Public seed JSON exposed credentials or patient data");
  }
  const crossOrigin = await rawRequest("/api/health", { headers: { Origin: "https://attacker.example" } });
  if (crossOrigin.response.status !== 403) throw new Error("Unapproved cross-origin request was allowed");

  const forgedDelete = await rawRequest("/api/users", {
    method: "DELETE",
    headers: { "Content-Type": "application/json", "X-Role": "director" },
    body: JSON.stringify({ username: "abena" })
  });
  if (forgedDelete.response.status !== 401) throw new Error("Forged X-Role header was accepted");

  const loginResult = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: directorUsername, password: directorPassword })
  });
  if (loginResult?.user?.role !== "director" || !loginResult?.token) throw new Error("Login did not return a director session");
  if (!loginResult?.rolePermissions?.managerAccess?.includes("director")) {
    throw new Error("Login did not return the server role permission matrix");
  }
  const token = loginResult.token;

  const normalizedDrugs = await request("/api/drugs?branch=all", { headers: authHeaders(token) });
  const normalizedLegacyStock = normalizedDrugs.find(drug => drug.id === 998);
  if (normalizedLegacyStock.branchStock.Techimantia !== 7
      || Object.entries(normalizedLegacyStock.branchStock).some(([branch, qty]) => branch !== "Techimantia" && Number(qty) !== 0)) {
    throw new Error("Legacy single-branch stock was multiplied across every branch");
  }

  const weakPassword = await rawRequest("/api/users", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      user: {
        username: `weak-${Date.now()}`,
        name: "Weak Password",
        role: "worker",
        branch_id: "kwame-danso-main",
        branch_ids: ["kwame-danso-main"]
      },
      password: "short"
    })
  });
  if (weakPassword.response.status !== 400) throw new Error("A weak password was accepted");

  const invalidRole = await rawRequest("/api/users", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      user: {
        username: `invalid-role-${Date.now()}`,
        name: "Invalid Role",
        role: "administrator",
        branch_id: "kwame-danso-main",
        branch_ids: ["kwame-danso-main"]
      },
      password: crypto.randomBytes(18).toString("base64url")
    })
  });
  if (invalidRole.response.status !== 400) throw new Error("An unknown user role was accepted");

  const testUsername = `smoke-${Date.now()}`;
  const testPassword = crypto.randomBytes(18).toString("base64url");
  const savedUser = await request("/api/users", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      user: {
        username: testUsername,
        name: "Smoke Test User",
        role: "worker",
        branch_id: "kwame-danso-main",
        branch_ids: ["kwame-danso-main"]
      },
      password: testPassword
    })
  });
  if (savedUser.password || savedUser.passwordHash) throw new Error("User endpoint exposed credential data");

  const workerLogin = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: testUsername, password: testPassword })
  });
  const workerToken = workerLogin.token;
  const storedState = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  const storedUser = storedState.users.find(user => user.username === testUsername);
  if (!storedUser || !/^\$2[aby]\$10\$/.test(storedUser.passwordHash || "") || storedUser.password) {
    throw new Error("Stored user credential is not a bcrypt cost-10 hash");
  }

  const workerPrescriptionSale = await request("/api/sales", {
    method: "POST",
    headers: authHeaders(workerToken),
    body: JSON.stringify({
      sale: {
        id: `SMOKE-WORKER-RX-${Date.now()}`,
        items: [{ id: prescriptionDrug.id, qty: 1 }],
        paid: 1000,
        payment: "Cash"
      }
    })
  });
  if (workerPrescriptionSale.processedBy !== testUsername || workerPrescriptionSale.items[0].id !== prescriptionDrug.id) {
    throw new Error("A worker could not sell an Rx-marked medicine without software approval");
  }

  const workerInteractionReview = await request("/api/sales", {
    method: "POST",
    headers: authHeaders(workerToken),
    body: JSON.stringify({
      sale: {
        id: `SMOKE-WORKER-INTERACTION-${Date.now()}`,
        items: [{ id: 1, qty: 1 }],
        paid: 1000,
        payment: "Cash",
        interactionReview: {
          by: "forged-user",
          role: "director",
          code: "different-patients",
          label: "Forged label"
        }
      }
    })
  });
  if (workerInteractionReview.interactionReview?.by !== testUsername
      || workerInteractionReview.interactionReview?.role !== "worker"
      || workerInteractionReview.interactionReview?.label !== "Different patients") {
    throw new Error("Worker interaction review was rejected or trusted forged identity fields");
  }

  const forgedInteractionOverride = await rawRequest("/api/sales", {
    method: "POST",
    headers: authHeaders(workerToken),
    body: JSON.stringify({
      sale: {
        id: `SMOKE-FORGED-INTERACTION-${Date.now()}`,
        items: [{ id: 1, qty: 1 }],
        paid: 1000,
        payment: "Cash",
        interactionOverride: { reason: "Forged approval" }
      }
    })
  });
  if (forgedInteractionOverride.response.status !== 403) throw new Error("A worker forged an interaction override");

  const legacyRefund = await request("/api/returns", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      refund: { id: `SMOKE-LEGACY-REFUND-${Date.now()}` },
      original_sale_id: legacySale.id
    })
  });
  if (legacyRefund.refundAgainst !== legacySale.id) throw new Error("Legacy sale could not be refunded");
  const legacyResale = await request("/api/sales", {
    method: "POST",
    headers: authHeaders(workerToken),
    body: JSON.stringify({
      sale: {
        id: `SMOKE-LEGACY-RESALE-${Date.now()}`,
        items: [{ id: 999, qty: 1 }],
        paid: 10,
        payment: "Cash"
      }
    })
  });
  if (legacyResale.items[0]?.id !== 999) throw new Error("Returned legacy stock could not be sold from its restored batch");

  const forgedDiscount = await rawRequest("/api/sales", {
    method: "POST",
    headers: authHeaders(workerToken),
    body: JSON.stringify({
      sale: {
        id: `SMOKE-FORGED-DISCOUNT-${Date.now()}`,
        items: [{ id: 1, qty: 1 }],
        discount: 1,
        paid: 10,
        payment: "Cash"
      }
    })
  });
  if (forgedDiscount.response.status !== 403) throw new Error("A worker submitted an unauthorized discount");

  const sale = await request("/api/sales", {
    method: "POST",
    headers: authHeaders(workerToken),
    body: JSON.stringify({
      sale: {
        id: `SMOKE-SALE-${Date.now()}`,
        customer: "Walk-in",
        items: [{ id: 1, name: "Forged name", qty: 2, price: 0.01 }],
        total: 999999,
        paid: 999999,
        payment: "Cash",
        paymentDetails: [{ method: "Cash", amount: 999999 }]
      },
      stock_movements: []
    })
  });
  if (sale.total !== 9 || sale.items[0].name !== "Paracetamol 500mg"
      || sale.items[0].saleUnit !== "Strip" || sale.processedBy !== testUsername) {
    throw new Error("Server did not canonicalize sale price, product, selling unit, total, and operator");
  }

  const managerUsername = `smoke-manager-${Date.now()}`;
  const managerPassword = crypto.randomBytes(18).toString("base64url");
  await request("/api/users", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      user: {
        username: managerUsername,
        name: "Smoke Test Manager",
        role: "manager",
        branch_id: "kwame-danso-main",
        branch_ids: ["kwame-danso-main"]
      },
      password: managerPassword
    })
  });
  const managerLogin = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: managerUsername, password: managerPassword })
  });
  const managerUsers = await request("/api/users", { headers: authHeaders(managerLogin.token) });
  if (managerUsers.some(user => user.role === "director")) {
    throw new Error("A manager could enumerate director accounts");
  }

  const managerBranchEdit = await rawRequest("/api/branches", {
    method: "POST",
    headers: authHeaders(managerLogin.token),
    body: JSON.stringify({ branch: { id: "unauthorized-branch", name: "Unauthorized Branch" } })
  });
  if (managerBranchEdit.response.status !== 403) throw new Error("A manager was allowed to alter the global branch list");

  const temporaryBranchId = `smoke-empty-${Date.now()}`;
  const temporaryBranch = await request("/api/branches", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ branch: { id: temporaryBranchId, name: "Smoke Empty Branch" } })
  });
  const drugForTemporaryBatch = (await request("/api/drugs?branch=all", { headers: authHeaders(token) }))
    .find(drug => drug.id === 1);
  await request("/api/drugs/1", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      drug: {
        ...drugForTemporaryBatch,
        batches: [
          ...(drugForTemporaryBatch.batches || []),
          {
            id: "SMOKE-ZERO-BATCH",
            batch: "ZERO",
            expiry: "2035-01-01",
            qty: 0,
            branch_id: temporaryBranch.id
          }
        ]
      },
      branch_stocks: {
        ...(drugForTemporaryBatch.branchStock || {}),
        [temporaryBranch.name]: 0
      }
    })
  });
  await request("/api/branches", {
    method: "DELETE",
    headers: authHeaders(token),
    body: JSON.stringify({ id: temporaryBranch.id })
  });
  const stateAfterBranchDelete = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  if (stateAfterBranchDelete.branches.some(branch => branch.id === temporaryBranch.id)
      || stateAfterBranchDelete.drugs.some(drug => (drug.batches || []).some(batch => batch.id === "SMOKE-ZERO-BATCH"))) {
    throw new Error("Deleting an empty branch migrated or retained its stale batch records");
  }

  const crossBranchCustomerId = Date.now();
  await request("/api/customers", {
    method: "POST",
    headers: authHeaders(token, { "X-Branch-Id": "techimantia" }),
    body: JSON.stringify({
      customer: {
        id: crossBranchCustomerId,
        name: "Techimantia Patient",
        branch_id: "techimantia"
      }
    })
  });
  const crossBranchOverwrite = await rawRequest("/api/customers", {
    method: "POST",
    headers: authHeaders(managerLogin.token),
    body: JSON.stringify({
      customer: {
        id: crossBranchCustomerId,
        name: "Overwritten Patient",
        branch_id: "kwame-danso-main"
      }
    })
  });
  if (crossBranchOverwrite.response.status !== 403) throw new Error("A same-ID patient overwrote a record in another branch");

  const managerSync = await rawRequest("/api/sync", {
    method: "POST",
    headers: authHeaders(managerLogin.token),
    body: JSON.stringify({ customers: [] })
  });
  if (managerSync.response.status !== 403) throw new Error("A manager was allowed to bulk-import browser data");

  const maliciousBatchUpdate = await request("/api/drugs/1", {
    method: "POST",
    headers: authHeaders(managerLogin.token),
    body: JSON.stringify({
      drug: {
        id: 1,
        name: seed.drugs[0].name,
        batches: [
          { ...seed.drugs[0].batches[0], qty: 98 },
          {
            id: "FORGED-TECHIMANTIA-BATCH",
            batch: "FORGED",
            expiry: "2035-01-01",
            qty: 500,
            branch_id: "techimantia"
          }
        ]
      },
      branch_stocks: {
        "Kwame Danso Main": 98,
        Techimantia: 500
      }
    })
  });
  if (maliciousBatchUpdate.batches.some(batch => batch.id === "FORGED-TECHIMANTIA-BATCH")
      || Object.prototype.hasOwnProperty.call(maliciousBatchUpdate.branchStock || {}, "Techimantia")) {
    throw new Error("A branch manager changed inventory data for an unauthorized branch");
  }

  const deleteStockedDrug = await rawRequest("/api/drugs/1", {
    method: "DELETE",
    headers: authHeaders(managerLogin.token),
    body: "{}"
  });
  if (deleteStockedDrug.response.status !== 409) throw new Error("A stocked inventory item was deleted");

  const managerForcedDelete = await rawRequest("/api/drugs/1", {
    method: "DELETE",
    headers: authHeaders(managerLogin.token),
    body: JSON.stringify({ force: true })
  });
  if (managerForcedDelete.response.status !== 403) throw new Error("A manager force-deleted a stocked inventory item");

  const directorBranchDelete = await request("/api/drugs/997", {
    method: "DELETE",
    headers: authHeaders(token, { "X-Branch-Id": "kwame-danso-main" }),
    body: JSON.stringify({ branch_id: "kwame-danso-main", force: true })
  });
  if (!directorBranchDelete.ok || directorBranchDelete.scope !== "branch" || directorBranchDelete.discardedStock !== 3) {
    throw new Error("Director branch deletion did not report the removed branch stock");
  }
  const stateAfterBranchDrugDelete = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  const branchDeletedDrug = stateAfterBranchDrugDelete.drugs.find(drug => drug.id === 997);
  if (!branchDeletedDrug) throw new Error("Branch deletion removed the global drug record");
  if (branchDeletedDrug.branchAvailability?.["Kwame Danso Main"] !== false
      || Number(branchDeletedDrug.branchStock?.["Kwame Danso Main"] || 0) !== 0
      || Number(branchDeletedDrug.branchStock?.Techimantia || 0) !== 4
      || (branchDeletedDrug.batches || []).some(batch => batch.branch_id === "kwame-danso-main")
      || !(branchDeletedDrug.batches || []).some(batch => batch.id === "BRANCH-DELETE-TECH" && batch.qty === 4)) {
    throw new Error("Branch deletion changed another branch or retained deleted-branch stock");
  }
  const managerDrugsAfterBranchDelete = await request("/api/drugs", { headers: authHeaders(managerLogin.token) });
  if (managerDrugsAfterBranchDelete.some(drug => drug.id === 997)) {
    throw new Error("Branch-deleted drug remained visible at the removed branch");
  }
  const directorDrugsAfterBranchDelete = await request("/api/drugs?branch=all", { headers: authHeaders(token) });
  const directorBranchDrug = directorDrugsAfterBranchDelete.find(drug => drug.id === 997);
  if (!directorBranchDrug || Number(directorBranchDrug.branchStock?.Techimantia || 0) !== 4) {
    throw new Error("Branch-deleted drug was not preserved for another branch");
  }

  const directorForcedDelete = await request("/api/drugs/998", {
    method: "DELETE",
    headers: authHeaders(token),
    body: JSON.stringify({ force: true, scope: "global" })
  });
  if (!directorForcedDelete.ok || directorForcedDelete.discardedStock !== 7) {
    throw new Error("A director could not explicitly delete a stocked inventory item");
  }
  const stateAfterForcedDelete = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  if (stateAfterForcedDelete.drugs.some(drug => drug.id === 998)) {
    throw new Error("Director force-delete left the drug in server storage");
  }

  const fractionalTransfer = await rawRequest("/api/stock-transfers", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      drug_id: 1,
      from_branch_id: "kwame-danso-main",
      to_branch_id: "kwame-danso-annex",
      qty: 1.5
    })
  });
  if (fractionalTransfer.response.status !== 400) throw new Error("A fractional stock transfer was accepted");

  const forgedSupplierPurchase = await rawRequest("/api/purchases", {
    method: "POST",
    headers: authHeaders(managerLogin.token),
    body: JSON.stringify({
      purchase: {
        id: `SMOKE-GRN-${Date.now()}`,
        branch_id: "kwame-danso-main",
        supplierId: "not-a-real-supplier",
        supplier: "Forged Supplier",
        items: [{ drug_id: 1, qty: 1, cost: 1, batch: "GRN-1", expiry: "2035-01-01" }]
      }
    })
  });
  if (forgedSupplierPurchase.response.status !== 400) throw new Error("A purchase with a forged supplier was accepted");
  const serverPermissions = await request("/api/role-permissions", { headers: authHeaders(token) });
  const managerPermissionEdit = await rawRequest("/api/role-permissions", {
    method: "POST",
    headers: authHeaders(managerLogin.token),
    body: JSON.stringify({ permissions: serverPermissions.permissions })
  });
  if (managerPermissionEdit.response.status !== 403) {
    throw new Error("A manager was allowed to edit role permissions");
  }

  const updatedPermissions = JSON.parse(JSON.stringify(serverPermissions.permissions));
  updatedPermissions.sell = updatedPermissions.sell.filter(role => role !== "worker");
  const savedPermissions = await request("/api/role-permissions", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ permissions: updatedPermissions })
  });
  if (savedPermissions.permissions.sell.includes("worker")) {
    throw new Error("Director role permission change was not saved");
  }
  const deniedWorkerSale = await rawRequest("/api/sales", {
    method: "POST",
    headers: authHeaders(workerToken),
    body: JSON.stringify({
      sale: {
        id: `SMOKE-DENIED-SALE-${Date.now()}`,
        customer: "Walk-in",
        items: [{ id: 1, qty: 1 }],
        payment: "Cash"
      }
    })
  });
  if (deniedWorkerSale.response.status !== 403) {
    throw new Error("Updated sell permission was not enforced for an active worker session");
  }
  const stateAfterPermissionChange = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  if (stateAfterPermissionChange.rolePermissions.sell.includes("worker")) {
    throw new Error("Role permission changes were not persisted to server storage");
  }

  const oversizedWriteoff = await rawRequest("/api/stock-writeoffs", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ drug_id: 1, branch_id: "kwame-danso-main", qty: 999999 })
  });
  if (oversizedWriteoff.response.status !== 409) throw new Error("Oversized write-off was accepted");
  await request("/api/stock-writeoffs", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ drug_id: 1, branch_id: "kwame-danso-main", batch_id: "SMOKE-BATCH-1", qty: 1 })
  });
  const stateAfterWriteoff = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  const writtenBatch = stateAfterWriteoff.drugs.find(drug => drug.id === 1).batches.find(batch => batch.id === "SMOKE-BATCH-1");
  if (writtenBatch.qty !== 97 || writtenBatch.initialQty !== 100) throw new Error("Write-off changed immutable batch receipt quantity");

  const inconsistentTransfer = await rawRequest("/api/stock-transfers", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      drug_id: 2,
      from_branch_id: "kwame-danso-main",
      to_branch_id: "kwame-danso-annex",
      qty: 2
    })
  });
  if (inconsistentTransfer.response.status !== 409) throw new Error("Transfer ignored insufficient batch quantities");

  await request("/api/users", {
    method: "DELETE",
    headers: authHeaders(token),
    body: JSON.stringify({ username: testUsername })
  });
  await request("/api/users", {
    method: "DELETE",
    headers: authHeaders(token),
    body: JSON.stringify({ username: managerUsername })
  });
  const usersAfterDelete = await request("/api/users", { headers: authHeaders(token) });
  if (usersAfterDelete.some(user => user.username === testUsername)) throw new Error("Deleted user was recreated from seed data");

  const publicSeedScript = await fetch(`${baseUrl}/data/seed.js`).then(response => response.text());
  if (publicSeedScript.includes("passwordHash") || publicSeedScript.includes("Mr. Kwame Mensah")) {
    throw new Error("Public seed script contains credentials or patient data");
  }

  const index = await fetch(`${baseUrl}/`).then(response => response.text());
  if (!index.includes("Akopharmah Limited POS")) throw new Error("The web service did not serve the POS application");
  if (!index.includes('<script type="module" src="js/app.js"></script>')) {
    throw new Error("The POS application did not load through the ES-module entry point");
  }
  const appModule = await fetch(`${baseUrl}/js/app.js`).then(response => response.text());
  const runtimeModule = await fetch(`${baseUrl}/js/app-runtime.js`).then(response => response.text());
  if (!appModule.includes("await import(\"./app-runtime.js\")") || !runtimeModule.includes("export { initializeApplication")) {
    throw new Error("ES-module application files were not served correctly");
  }

  await request("/api/auth/logout", { method: "POST", headers: authHeaders(token), body: "{}" });
  const afterLogout = await rawRequest("/api/users", { headers: authHeaders(token) });
  if (afterLogout.response.status !== 401) throw new Error("Logged-out session remained valid");

  console.log("Render security smoke test passed: sessions, director-only permission edits, live enforcement, canonical sales, static isolation, deletion, and stock bounds work.");
}

run()
  .catch(error => {
    console.error(error.stack || error.message);
    if (output) console.error(output.trim());
    process.exitCode = 1;
  })
  .finally(() => {
    child.kill();
    try { fs.rmSync(dataFile, { force: true }); } catch (_) {}
    try { fs.rmSync(`${dataFile}.tmp`, { force: true }); } catch (_) {}
  });
