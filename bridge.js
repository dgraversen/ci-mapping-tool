/*
 * CI Mapping Toolkit – storage bridge.
 * Runs in the extension's isolated world and gives the page script (quickfunction.js, MAIN world)
 * access to chrome.storage.local, so templates are shared across all CPI tenants and tabs.
 */
(function () {
  "use strict";
  if (window.__cpiQuickFunctionBridge) return;
  window.__cpiQuickFunctionBridge = true;


  function reply(id, payload) {
    window.postMessage(Object.assign({ source: "cpiqf-bridge", id }, payload), location.origin);
  }

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.source !== "cpiqf-page") return;
    try {
      if (d.op === "hello") reply(d.id, { result: true });
      else if (d.op === "get") chrome.storage.local.get(d.key, (r) => reply(d.id, { result: r[d.key] }));
      else if (d.op === "set") chrome.storage.local.set({ [d.key]: d.value }, () => reply(d.id, { result: true }));
    } catch (err) {
      reply(d.id, { error: String(err) });
    }
  });
})();
