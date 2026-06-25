const BLOCKED_ELEMENTS = new Set(["SCRIPT", "IFRAME", "OBJECT", "EMBED", "BASE", "META"]);
const BLOCKED_URL = /^\s*(?:javascript|vbscript|data\s*:\s*text\/html)/i;
const LEGACY_EVENT_ATTRIBUTES = ["onclick", "onchange", "oninput", "onkeydown", "onkeyup", "onblur", "onfocus", "onsubmit"];

function resolveTarget(target) {
  if (typeof target === "string") return document.querySelector(target);
  return target || null;
}

function createContextualFragment(target, markup) {
  const range = document.createRange();
  range.selectNodeContents(target);
  return range.createContextualFragment(String(markup ?? ""));
}

function fallbackSanitize(fragment) {
  fragment.querySelectorAll("*").forEach(element => {
    if (BLOCKED_ELEMENTS.has(element.tagName)) {
      element.remove();
      return;
    }
    [...element.attributes].forEach(attribute => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if ((name.startsWith("on") && !LEGACY_EVENT_ATTRIBUTES.includes(name))
        || ((name === "href" || name === "src" || name === "xlink:href") && BLOCKED_URL.test(value))) {
        element.removeAttribute(attribute.name);
      }
    });
  });
  return fragment;
}

function sanitizeFragment(target, markup) {
  const fragment = createContextualFragment(target, markup);
  if (globalThis.DOMPurify?.sanitize) {
    return globalThis.DOMPurify.sanitize(fragment, {
      RETURN_DOM_FRAGMENT: true,
      USE_PROFILES: { html: true },
      ADD_ATTR: LEGACY_EVENT_ATTRIBUTES
    });
  }
  return fallbackSanitize(fragment);
}

function nodeKey(node) {
  if (node?.nodeType !== Node.ELEMENT_NODE) return "";
  return node.getAttribute("data-key") || node.id || "";
}

function syncAttributes(current, next) {
  [...current.attributes].forEach(attribute => {
    if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  });
  [...next.attributes].forEach(attribute => {
    if (current.getAttribute(attribute.name) !== attribute.value) {
      current.setAttribute(attribute.name, attribute.value);
    }
  });

  if (current instanceof HTMLInputElement) {
    current.checked = next.checked;
    if (document.activeElement !== current && current.value !== next.value) current.value = next.value;
  } else if (current instanceof HTMLTextAreaElement || current instanceof HTMLSelectElement) {
    if (document.activeElement !== current && current.value !== next.value) current.value = next.value;
  }
}

function patchChildren(current, next) {
  const keyed = new Map();
  [...current.childNodes].forEach(child => {
    const key = nodeKey(child);
    if (key) keyed.set(key, child);
  });

  const desiredChildren = [...next.childNodes];
  desiredChildren.forEach((desired, index) => {
    const key = nodeKey(desired);
    let existing = key ? keyed.get(key) : current.childNodes[index];
    if (key && existing && existing !== current.childNodes[index]) {
      current.insertBefore(existing, current.childNodes[index] || null);
    }
    if (!existing) {
      current.insertBefore(desired.cloneNode(true), current.childNodes[index] || null);
      return;
    }
    patchNode(existing, desired);
  });

  while (current.childNodes.length > desiredChildren.length) {
    current.removeChild(current.lastChild);
  }
}

function patchNode(current, next) {
  if (!current || !next) return;
  if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName || nodeKey(current) !== nodeKey(next)) {
    current.replaceWith(next.cloneNode(true));
    return;
  }
  if (current.nodeType === Node.TEXT_NODE || current.nodeType === Node.COMMENT_NODE) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    return;
  }
  syncAttributes(current, next);
  patchChildren(current, next);
}

export function renderHtml(target, markup) {
  const element = resolveTarget(target);
  if (!element) return null;
  const next = document.createElement(element.tagName || "div");
  next.appendChild(sanitizeFragment(element, markup));
  patchChildren(element, next);
  return element;
}

export function renderList(target, items, renderItem, keyOf = item => item?.id) {
  const markup = (items || []).map((item, index) => {
    const key = String(keyOf(item, index) ?? index);
    return `<div data-key="${key.replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character])}">${renderItem(item, index)}</div>`;
  }).join("");
  return renderHtml(target, markup);
}

export const domRenderer = Object.freeze({ renderHtml, renderList });
