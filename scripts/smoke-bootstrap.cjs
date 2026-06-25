"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const port = 41000 + Math.floor(Math.random() * 10000);
const dataFile = path.join(os.tmpdir(), `akopharmah-bootstrap-smoke-${process.pid}-${Date.now()}.json`);
const username = `bootstrap-${Date.now()}`;
const password = crypto.randomBytes(24).toString("base64url");
const baseUrl = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, ["server.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    AKOPHARMAH_DATA_FILE: dataFile,
    AKOPHARMAH_BOOTSTRAP_USERNAME: username,
    AKOPHARMAH_BOOTSTRAP_PASSWORD: password,
    RENDER: "false"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
child.stdout.on("data", chunk => { output += chunk.toString(); });
child.stderr.on("data", chunk => { output += chunk.toString(); });

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Bootstrap server exited early.\n${output}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Bootstrap server did not become ready.\n${output}`);
}

async function run() {
  await waitForHealth();
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const login = await loginResponse.json();
  if (!loginResponse.ok || login.user?.role !== "director" || !login.token) {
    throw new Error(`Bootstrap director could not sign in: ${JSON.stringify(login)}`);
  }
  const state = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  if (state.users.length !== 1 || state.users[0].username !== username) {
    throw new Error("Fresh database did not contain exactly the configured bootstrap director");
  }
  if (!/^\$2[aby]\$10\$/.test(state.users[0].passwordHash || "") || state.users[0].password) {
    throw new Error("Bootstrap password was not stored as a bcrypt cost-10 hash");
  }
  if (state.drugs.some(drug => Object.values(drug.branchStock || {}).some(value => Number(value) !== 0))) {
    throw new Error("Fresh database contained non-zero stock");
  }
  if (state.customers.length !== 1 || state.customers[0].name !== "Walk-in") {
    throw new Error("Fresh database contained demonstration patients");
  }
  console.log("Fresh-deployment smoke test passed: secret bootstrap director, zero stock, and no demonstration patients.");
}

run()
  .catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    child.kill();
    try { fs.rmSync(dataFile, { force: true }); } catch (_) {}
    try { fs.rmSync(`${dataFile}.tmp`, { force: true }); } catch (_) {}
  });
