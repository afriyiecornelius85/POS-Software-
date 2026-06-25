import { domRenderer } from "./core/dom-renderer.js";

async function loadPublicSeed() {
  const response = await fetch("/data/seed.json", {
    credentials: "same-origin",
    headers: { Accept: "application/json" }
  });
  if (!response.ok) throw new Error(`Seed data request failed (${response.status})`);
  return response.json();
}

globalThis.AKOPHARMAH_DOM = domRenderer;
globalThis.AKOPHARMAH_SEED = await loadPublicSeed();

const runtime = await import("./app-runtime.js");
export const initializeApplication = runtime.initializeApplication;
export const browserEventHandlers = runtime.browserEventHandlers;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeApplication, { once: true });
} else {
  await initializeApplication();
}
