"use strict";

const bcrypt = require("../vendor/bcryptjs.cjs");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const bcryptWorkFactor = 10;
const bcryptPattern = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

function migrateUsers(users) {
  return (Array.isArray(users) ? users : []).map(user => {
    const nextUser = { ...user };
    const storedHash = String(nextUser.passwordHash || "");
    const legacyPassword = String(nextUser.password || "");
    if (bcryptPattern.test(storedHash)) {
      nextUser.passwordHash = storedHash;
    } else if (legacyPassword || storedHash) {
      nextUser.passwordHash = bcrypt.hashSync(legacyPassword || storedHash, bcryptWorkFactor);
    }
    delete nextUser.password;
    delete nextUser.offlineCredential;
    return nextUser;
  });
}

function migrateJsonFile(relativePath) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) {
    console.log(`Skipped missing JSON data file: ${relativePath}`);
    return null;
  }
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  data.users = migrateUsers(data.users);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return data;
}

const seed = migrateJsonFile(path.join("data", "seed.json"));
migrateJsonFile(path.join("data", "akopharmah-sync.json"));

const walkIn = seed.customers.find(customer => String(customer.name || "").trim().toLowerCase() === "walk-in")
  || { id: 1, name: "Walk-in" };
seed.customers = [{ ...walkIn, id: walkIn.id || 1, name: "Walk-in", phone: "", notes: "", balance: 0 }];
seed.drugs = seed.drugs.map(drug => ({ ...drug, stock: 0, quantity: 0, batches: [] }));
fs.writeFileSync(path.join(root, "data", "seed.json"), `${JSON.stringify(seed, null, 2)}\n`, "utf8");

console.log("Password migration complete: backend stores bcrypt hashes and the seed contains no patient or opening-stock data.");
