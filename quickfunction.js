/*
 * CI Mapping Toolkit (formerly CPI Quick Function)
 * Space or Ctrl+Space (or the Mapping Toolkit button next to Simulate) in the SAP Cloud Integration message
 * mapping editor opens a search box:
 *  - pick a function and it is added to the Mapping Expression. If the selected target field is not
 *    mapped yet, a mapping is created and the function is connected to the field.
 *  - "constant" asks for the value first.
 *  - save the mapping of the selected field as a template (for this mapping or for all mappings),
 *    and insert templates again, with or without their source fields.
 *
 * Runs in the page's MAIN world so it can reach the SAPUI5 controls of the mapping editor.
 * Templates are stored through bridge.js (chrome.storage.local).
 */
(function () {
  "use strict";
  if (window.__cpiQuickFunction) return;
  window.__cpiQuickFunction = true;
  console.info("[CI Mapping Toolkit] v2.2.3 loaded in", location.href);

  const PALETTE_TYPE = "com.sap.it.spc.webui.expressionedit.FunctionPalette";
  const EDITOR_TYPE = "com.sap.it.spc.webui.expressionedit.ExpressionEditorControl";
  const VIEWER_TYPE = "com.sap.it.spc.mappingcontrol.views.MappingViewerControl";
  const CANVAS_SEL = ".cpides-webuiEECanvasWrapper";
  const RECENT_KEY = "cpiQuickFunction.recent";
  const TEMPLATES_KEY = "cpiQuickFunction.templates";
  const MAX_RESULTS = 60;

  let mouse = { x: -1, y: -1 };
  document.addEventListener("mousemove", (e) => { mouse = { x: e.clientX, y: e.clientY }; }, true);

  // Last click on the expression canvas (canvas coordinates), used to know which function the user selected.
  let lastCanvasClick = null;
  document.addEventListener("mousedown", (e) => {
    const canvas = e.target && e.target.closest && e.target.closest(CANVAS_SEL);
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    let target = null;
    try { target = getSelectedTarget(getContext()); } catch (_) { /* editor not ready */ }
    lastCanvasClick = { x: e.clientX - r.left + canvas.scrollLeft, y: e.clientY - r.top + canvas.scrollTop, xpath: target && target.xpath };
  }, true);

  // ---------- bridge to bridge.js (chrome.storage) ----------
  let reqId = 0;
  function bridge(op, extra, timeout) {
    return new Promise((resolve, reject) => {
      const id = "q" + (++reqId);
      const onMsg = (e) => {
        const d = e.data;
        if (e.source !== window || !d || d.source !== "cpiqf-bridge" || d.id !== id) return;
        window.removeEventListener("message", onMsg);
        clearTimeout(timer);
        d.error ? reject(new Error(d.error)) : resolve(d.result);
      };
      const timer = setTimeout(() => { window.removeEventListener("message", onMsg); reject(new Error("bridge timeout")); }, timeout || 1500);
      window.addEventListener("message", onMsg);
      window.postMessage(Object.assign({ source: "cpiqf-page", id, op }, extra), location.origin);
    });
  }

  // Templates live in chrome.storage.local; if the bridge is missing we fall back to this tenant's localStorage.
  const store = {
    async get() {
      try { return (await bridge("get", { key: TEMPLATES_KEY })) || []; }
      catch (_) { try { return JSON.parse(localStorage.getItem(TEMPLATES_KEY)) || []; } catch (__) { return []; } }
    },
    async set(list) {
      try { await bridge("set", { key: TEMPLATES_KEY, value: list }); }
      catch (_) { localStorage.setItem(TEMPLATES_KEY, JSON.stringify(list)); }
    },
  };

  // ---------- SAPUI5 access ----------
  function allElements() {
    const core = window.sap && sap.ui && sap.ui.core;
    if (!core) return [];
    if (core.Element && core.Element.registry) return Object.values(core.Element.registry.all());
    const c = sap.ui.getCore && sap.ui.getCore();
    return c && c.mElements ? Object.values(c.mElements) : [];
  }

  const typeOf = (e) => { try { return e.getMetadata().getName(); } catch (_) { return ""; } };
  const isShown = (c) => { const d = c && c.getDomRef && c.getDomRef(); return !!d && d.isConnected && d.offsetWidth > 0; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

  // Everything we need from the open mapping editor. CPI can keep a hidden copy of the editor
  // around, so we take the visible MappingViewerControl and the expression editor of the same view.
  function getContext() {
    const els = allElements();
    const viewers = els.filter((e) => typeOf(e) === VIEWER_TYPE && isShown(e));
    const viewer = viewers[viewers.length - 1];
    let controller = null;
    for (let v = viewer; v && !controller; v = v.getParent && v.getParent()) {
      const c = v.getController && v.getController();
      if (c && typeof c._createConstantMapping === "function") controller = c;
    }
    const prefix = viewer ? viewer.getId().split("--")[0] + "--" : "";
    const editors = els.filter((e) => typeOf(e) === EDITOR_TYPE);
    const editor = editors.find((e) => prefix && e.getId().startsWith(prefix)) || editors.find(isShown) ||
      (editors.length === 1 ? editors[0] : null);
    const palette = (editor && editor._oFunctionPalette) || els.find((e) => typeOf(e) === PALETTE_TYPE && isShown(e)) || null;
    return { viewer, controller, editor, palette, renderer: editor && editor._oExpressionRenderer };
  }

  function findPalette() { return getContext().palette; }

  function getFunctions(palette) {
    const md = palette._getMetaData ? palette._getMetaData() : (palette.getModel() && palette.getModel().getData());
    return (md && md.functionModels) || [];
  }

  function getCanvas() {
    const list = [...document.querySelectorAll(CANVAS_SEL)];
    return list.find((c) => c.getClientRects().length > 0) || null;
  }

  function isEditMode(ctx) {
    if (ctx.controller && ctx.controller.getEditMode) return !!ctx.controller.getEditMode();
    return !ctx.renderer || ctx.renderer._bEditMode !== false;
  }

  // The selected row of the target structure: { xpath, name }.
  function getSelectedTarget(ctx) {
    try {
      const t = ctx.viewer._getTargetTable();
      const i = t.getSelectedIndex();
      const c = i >= 0 && t.getContextByIndex(i);
      const o = c && c.getObject();
      return o && o.xpath ? { xpath: o.xpath, name: o.name || o.xpath.split("/").pop() } : null;
    } catch (_) { return null; }
  }

  // The stored mapping (id, sourcePaths, targetPaths, fn, destination) of a target field, if it has one.
  function getMappingOf(ctx, xpath) {
    try {
      const tr = ctx.viewer.getTransformation();
      const sel = ctx.viewer._getSelectedMapping && ctx.viewer._getSelectedMapping();
      if (sel && (sel.targetPaths || []).includes(xpath)) return sel;
      return tr.getMappings().find((m) => (m.targetPaths || []).includes(xpath)) || null;
    } catch (_) { return null; }
  }

  // Identifies the open mapping: tenant host + path of the mapping (".../resources/mapping/x.mmap" or ".../messagemappings/x").
  function mappingKey() {
    const p = location.pathname.replace(/\/+$/, "");
    const m = p.match(/^(.*?\.mmap)/i) || p.match(/^(.*\/messagemappings\/[^\/]+)/i);
    return location.host + (m ? m[1] : p);
  }
  function mappingName() {
    const k = mappingKey();
    return decodeURIComponent(k.split("/").pop().replace(/\.mmap$/i, ""));
  }

  // The expression of the selected mapping: { nodes: {id: node}, connections: [{fromId, fromPin, toId, toPin}] }.
  // The target field itself is the node with type "Dst".
  function getExpression(ctx) {
    return (ctx.renderer && ctx.renderer._oExpression) || (ctx.editor && ctx.editor._oExpressionModel) || null;
  }
  function getTargetNode(expr) {
    return expr && expr.nodes ? Object.values(expr.nodes).find((n) => n.type === "Dst") || null : null;
  }
  function isTargetMapped(expr, dst) {
    return (expr.connections || []).some((c) => c.toId === dst.id);
  }

  // Redraw the canvas and hand the change to the mapping (same as the renderer does after its own edits).
  function commit(ctx, expr) {
    ctx.renderer.fireModelUpdate(true);
    ctx.renderer.renderExpression(expr);
  }

  function connect(expr, fromNode, dst, toPin) {
    const models = com.sap.it.spc.webui.mapping.expression.models;
    expr.connections = expr.connections || [];
    const c = new models.Connection(dst.id, fromNode.id, 0, 0);
    if (toPin) c.toPin = toPin;
    expr.connections.push(c);
  }

  // Free inputs of the boxes drawn on the canvas, from the open expression (canvas px): the target field first,
  // then top to bottom. Same shape as freeInputs() so pickInputOnCanvas() can show either.
  function expressionInputs(ctx, targetName) {
    const expr = getExpression(ctx);
    if (!expr || !expr.nodes) return [];
    const fns = ctx.palette ? getFunctions(ctx.palette) : [];
    const used = new Set((expr.connections || []).map((c) => c.toId + ":" + c.toPin));
    const out = [];
    Object.values(expr.nodes).forEach((n) => {
      if (typeof n.x !== "number" || n.type === "Src") return;
      const isDst = n.type === "Dst";
      const pins = isDst ? 1 : (n.noOfArguments || 0);
      const fn = !isDst && fns.find((f) => f.name === n.key);
      const args = (fn && fn.signature && fn.signature.arguments) || [];
      const expanded = !!n.expansionState && !isDst;
      const h = expanded ? LAYOUT.nodeHeight + (pins + (n.valueBindingArgs || []).length) * LAYOUT.rowHeight : LAYOUT.nodeHeight;
      const box = { x: n.x, y: n.y, w: NODE_W, h };
      for (let i = 0; i < pins; i++) {
        if (used.has(n.id + ":" + i)) continue;
        const arg = args[i] && (args[i].displayName || args[i].name);
        out.push({ node: n, pin: i, index: i, isDst, title: isDst ? targetName : (n.name || n.key), arg: arg || "input " + (i + 1),
          rect: expanded ? { x: n.x, y: n.y + LAYOUT.nodeHeight + i * LAYOUT.rowHeight, w: NODE_W, h: LAYOUT.rowHeight, box } : Object.assign({ box }, box) });
      }
    });
    return out.sort((a, b) => (b.isDst - a.isDst) || a.rect.box.y - b.rect.box.y || a.rect.box.x - b.rect.box.x || a.index - b.index);
  }

  function setConstantValue(node, value) {
    node.valueBindingArgs = [{ name: "value", value }];
    node.name = value;
  }

  // Adds fn to the open expression and returns the new node.
  function addNode(ctx, fn, x, y) {
    const expr = getExpression(ctx);
    const before = new Set(expr && expr.nodes ? Object.keys(expr.nodes) : []);
    // The expression editor places new nodes at (_xPrev + 20, _yPrev + 20), in canvas coordinates.
    if (typeof x === "number") { ctx.editor._xPrev = Math.max(0, x - 20); ctx.editor._yPrev = Math.max(0, y - 20); }
    ctx.palette.fireFunctionSelect({ fn });
    const after = getExpression(ctx);
    return after && after.nodes ? Object.values(after.nodes).find((n) => !before.has(n.id) && n.type !== "Dst") || null : null;
  }

  function mousePosOnCanvas() {
    const canvas = getCanvas();
    if (!canvas || mouse.x < 0) return null;
    const r = canvas.getBoundingClientRect();
    if (mouse.x < r.left || mouse.x > r.right || mouse.y < r.top || mouse.y > r.bottom) return null;
    return { x: mouse.x - r.left + canvas.scrollLeft, y: mouse.y - r.top + canvas.scrollTop };
  }

  // Selected field already has a mapping: add the node (at the mouse when it is over the canvas).
  // If nothing is connected to the target field yet, connect the new node to it.
  // In a mapped field the user moves a selection box to the input the function should feed (or picks "not connected").
  async function insertIntoMapping(ctx, fn, constValue) {
    const expr = getExpression(ctx);
    const dst = getTargetNode(expr);
    const autoConnect = !!(dst && !isTargetMapped(expr, dst));
    let pos = mousePosOnCanvas();
    let chosen = null;
    if (!autoConnect) {
      const inputs = expressionInputs(ctx, (getSelectedTarget(ctx) || {}).name || dst && dst.name || "the target field");
      if (inputs.length) {
        const c = await pickInputOnCanvas(inputs, { name: fn.displayName || fn.name });
        if (c === undefined) return; // cancelled
        if (c && c !== "none") { chosen = c; pos = { x: Math.max(0, c.node.x - 220), y: c.node.y + c.index * LAYOUT.rowHeight }; }
        ctx = getContext(); // the editor may have been redrawn while the user was choosing
      }
    }
    if (!pos && autoConnect && typeof dst.x === "number") pos = { x: Math.max(0, dst.x - 220), y: dst.y || 0 };
    const node = addNode(ctx, fn, pos && pos.x, pos && pos.y);
    if (!node) return;
    const cur = getExpression(ctx);
    if (constValue !== undefined) setConstantValue(node, constValue);
    if (autoConnect) connect(cur, node, getTargetNode(cur));
    else if (chosen && cur.nodes[chosen.node.id]) connect(cur, node, cur.nodes[chosen.node.id], chosen.pin);
    if (constValue !== undefined || autoConnect || chosen) commit(ctx, cur);
  }

  // Selected field has no mapping: create one the way CPI's own constant assignment does,
  // then swap the constant for the chosen function when it is not a constant.
  async function createMapping(ctx, target, fn, constValue) {
    ctx.controller._createConstantMapping(constValue !== undefined ? constValue : "", target.xpath);
    if (isConstant(fn)) return;
    let expr = null;
    for (let i = 0; i < 20 && !(expr && getTargetNode(expr)); i++) { await sleep(50); expr = getExpression(getContext()); }
    const c2 = getContext();
    expr = getExpression(c2);
    const dst = getTargetNode(expr);
    const cst = expr && Object.values(expr.nodes).find((n) => n.type === "Func" && n.key === "const");
    if (!dst || !cst) return;
    const node = addNode(c2, fn, cst.x, cst.y);
    if (!node) return;
    const cur = getExpression(c2);
    delete cur.nodes[cst.id];
    cur.connections = (cur.connections || []).filter((c) => c.fromId !== cst.id && c.toId !== cst.id);
    connect(cur, node, getTargetNode(cur));
    commit(c2, cur);
  }

  function isConstant(fn) { return fn && fn.name === "const" && (!fn.group || fn.group === "Standard"); }

  function applyFunction(fn, constValue) {
    const ctx = getContext();
    const expr = getExpression(ctx);
    const target = getSelectedTarget(ctx);
    const dst = getTargetNode(expr);
    rememberRecent(fn);
    bumpUsage(fn);
    // A stale expression can remain after selecting an unmapped field, so match it to the selected row.
    if (dst && (!target || !dst.xpath || dst.xpath === target.xpath)) return insertIntoMapping(ctx, fn, constValue);
    if (target && ctx.controller) return createMapping(ctx, target, fn, constValue);
    throw new Error("no target field selected");
  }

  // ---------- templates ----------
  // A mapping's destination is a tree: the target field (Dst) has pinins; each pinin's
  // pinout.expressionReference is a graphicalFunction (with its own pinins) or a graphicalNode (a source field).
  // A template is a copy of the target field's pinins, i.e. everything that leads up to the field.
  function walkRefs(pinins, visit) {
    (pinins || []).forEach((pin) => {
      const ref = pin && pin.pinout && pin.pinout.expressionReference;
      if (!ref) return;
      visit(ref, pin);
      if (ref.graphicalFunction && ref.graphicalFunction.expressionDetails) walkRefs(ref.graphicalFunction.expressionDetails.pinins, visit);
    });
  }

  // A box (function or source field) that feeds several inputs is stored in full once; the other inputs hold
  // {exprReference: <objectId of that box>}. boxes maps objectId -> box for everything reachable from the given pins/nodes.
  function collectBoxes(pinins, boxes) {
    (pinins || []).forEach((pin) => {
      const ref = pin && pin.pinout && pin.pinout.expressionReference;
      const n = ref && (ref.graphicalFunction || ref.graphicalNode);
      if (!n || !n.expressionDetails) return;
      if (n.expressionDetails.objectId) boxes.set(n.expressionDetails.objectId, n);
      collectBoxes(n.expressionDetails.pinins, boxes);
    });
    return boxes;
  }
  function boxesOfMapping(m) {
    const boxes = new Map();
    collectBoxes(m.destination && m.destination.expressionDetails && m.destination.expressionDetails.pinins, boxes);
    (m.unconnected || []).forEach((u) => {
      const n = (u && (u.graphicalFunction || u.graphicalNode)) || u;
      if (n && n.expressionDetails) {
        if (n.expressionDetails.objectId) boxes.set(n.expressionDetails.objectId, n);
        collectBoxes(n.expressionDetails.pinins, boxes);
      }
    });
    return boxes;
  }

  function describeTemplate(pinins) {
    const fns = [];
    const sources = [];
    walkRefs(pinins, (ref) => {
      if (ref.graphicalFunction) fns.push(ref.graphicalFunction.key || ref.graphicalFunction.name);
      if (ref.graphicalNode && ref.graphicalNode.expressionPath) sources.push(ref.graphicalNode.expressionPath);
    });
    return { fns, sources: [...new Set(sources)] };
  }

  // Removes the source fields, and the inputs that only pointed at a removed source.
  function stripSources(pinins) {
    const removed = new Set();
    const strip = (pins) => (pins || []).forEach((pin) => {
      const ref = pin && pin.pinout && pin.pinout.expressionReference;
      if (!ref) return;
      if (ref.graphicalNode) {
        if (ref.graphicalNode.expressionDetails && ref.graphicalNode.expressionDetails.objectId) removed.add(ref.graphicalNode.expressionDetails.objectId);
        delete pin.pinout;
      } else if (ref.graphicalFunction && ref.graphicalFunction.expressionDetails) strip(ref.graphicalFunction.expressionDetails.pinins);
    });
    const unlink = (pins) => (pins || []).forEach((pin) => {
      const ref = pin && pin.pinout && pin.pinout.expressionReference;
      if (!ref) return;
      if (ref.exprReference && removed.has(ref.exprReference)) delete pin.pinout;
      else if (ref.graphicalFunction && ref.graphicalFunction.expressionDetails) unlink(ref.graphicalFunction.expressionDetails.pinins);
    });
    strip(pinins);
    unlink(pinins);
  }

  // Gives every box a new objectId and keeps the {exprReference} pointers between the boxes valid.
  function renewIds(o) {
    const ids = new Map();
    (function renew(x) {
      if (!x || typeof x !== "object") return;
      if (typeof x.objectId === "string") { const id = newId(); ids.set(x.objectId, id); x.objectId = id; }
      for (const k in x) renew(x[k]);
    })(o);
    (function relink(x) {
      if (!x || typeof x !== "object") return;
      if (typeof x.exprReference === "string" && ids.has(x.exprReference)) x.exprReference = ids.get(x.exprReference);
      for (const k in x) relink(x[k]);
    })(o);
  }

  // Text form of the expression, e.g. readProperty(const("x"),"").
  function expressionText(pinins) {
    const boxes = collectBoxes(pinins, new Map());
    const ref = (pin) => {
      let r = pin && pin.pinout && pin.pinout.expressionReference;
      if (r && r.exprReference) { const b = boxes.get(r.exprReference); r = b && (b.key ? { graphicalFunction: b } : { graphicalNode: b }); }
      if (!r) return "";
      if (r.graphicalNode) return r.graphicalNode.expressionPath || "";
      const f = r.graphicalFunction;
      if (!f) return "";
      const vals = (f.valueBindingArguments || []).map((a) => JSON.stringify(a.value == null ? "" : String(a.value)));
      if (f.key === "const") return "const(" + (vals[0] || '""') + ")";
      const pins = ((f.expressionDetails && f.expressionDetails.pinins) || []).slice().sort((a, b) => a.pinNum - b.pinNum);
      return (f.key || f.name) + "(" + pins.map(ref).concat(vals).join(",") + ")";
    };
    return ref((pinins || [])[0]);
  }

  // The function (or source field) node the user last clicked on the canvas, if it is in the open expression.
  const NODE_W = 150; // canvas px
  function getClickedNode(ctx, tolerance) {
    const expr = getExpression(ctx);
    if (!lastCanvasClick || !expr || !expr.nodes) return null;
    const p = lastCanvasClick;
    const target = getSelectedTarget(ctx);
    if (p.xpath && target && p.xpath !== target.xpath) return null; // click belonged to another field's mapping
    let best = null;
    let bestD = tolerance === undefined ? 60 : tolerance + 1; // px tolerance around a node
    Object.values(expr.nodes).forEach((n) => {
      if (n.type === "Dst" || typeof n.x !== "number") return;
      const h = n.expansionState ? LAYOUT.nodeHeight + ((n.noOfArguments || 0) + ((n.valueBindingArgs || []).length)) * LAYOUT.rowHeight : LAYOUT.nodeHeight;
      const dx = p.x < n.x ? n.x - p.x : p.x > n.x + NODE_W ? p.x - n.x - NODE_W : 0;
      const dy = p.y < n.y ? n.y - p.y : p.y > n.y + h ? p.y - n.y - h : 0;
      const d = Math.hypot(dx, dy);
      if (d < bestD) { best = n; bestD = d; }
    });
    return best;
  }

  // Finds the expressionReference with this objectId in the mapping's destination tree (or its unconnected nodes).
  function findRef(m, objectId) {
    let found = null;
    const visit = (ref) => {
      const n = ref.graphicalFunction || ref.graphicalNode;
      if (!found && n && n.expressionDetails && n.expressionDetails.objectId === objectId) found = ref;
    };
    walkRefs(m.destination && m.destination.expressionDetails && m.destination.expressionDetails.pinins, visit);
    (m.unconnected || []).forEach((u) => {
      const ref = u.graphicalFunction || u.graphicalNode ? u : { graphicalFunction: u };
      visit(ref);
      const n = ref.graphicalFunction || ref.graphicalNode;
      if (n && n.expressionDetails) walkRefs(n.expressionDetails.pinins, visit);
    });
    return found;
  }

  // What would be saved: the node the user clicked (and everything feeding it), else the whole target field.
  function templateSource(ctx) {
    const target = getSelectedTarget(ctx);
    const m = target && getMappingOf(ctx, target.xpath);
    if (!m || !m.destination) return null;
    // A box picked through its "•••" menu wins over the last click on the canvas.
    const expr = getExpression(ctx);
    const viaMenu = menuNode && Date.now() - menuNode.at < 60000 && expr && expr.nodes && expr.nodes[menuNode.id];
    const node = viaMenu || getClickedNode(ctx);
    const ref = node && findRef(m, node.id);
    if (ref) {
      const n = ref.graphicalFunction || ref.graphicalNode;
      return { m, target, pinins: [{ pinNum: 0, pinout: { pinNum: 0, expressionReference: ref } }],
        label: n.key === "const" ? "constant " + (((n.valueBindingArguments || [])[0] || {}).value || "") : (n.name || n.key || n.expressionPath || "").split("/").pop(),
        isNode: true };
    }
    const det = m.destination.expressionDetails;
    if (!det || !(det.pinins || []).some((p) => p.pinout)) return null;
    return { m, target, pinins: det.pinins, label: target.name, isNode: false };
  }

  // A template saved from a function gets its target field placed one column right of that function.
  function nodeDstPosition(pinins) {
    const ref = pinins[0].pinout.expressionReference;
    const n = ref.graphicalFunction || ref.graphicalNode;
    const p = (n.expressionDetails && n.expressionDetails.position) || { x: 50, y: 40 };
    return { x: Math.round(p.x + LAYOUT.colWidth / LAYOUT.scaleX), y: Math.round(p.y) };
  }

  // src: what to save, worked out when the box opened (the box forgets the clicked function once it closes).
  async function saveTemplate(name, scope, srcIn) {
    const ctx = getContext();
    const src = srcIn || templateSource(ctx);
    if (!src) throw new Error("The selected field has no mapping to save.");
    const { m, target } = src;
    const det = m.destination.expressionDetails;
    const pinins = clone(src.pinins);
    const info = describeTemplate(pinins);
    const tpl = {
      id: newId(),
      name: name || target.name,
      scope,
      mappingKey: mappingKey(),
      mappingName: mappingName(),
      targetName: target.name,
      targetXPath: target.xpath,
      dstPosition: src.isNode ? nodeDstPosition(pinins) : det.position || { x: 200, y: 40 },
      pinins,
      sourcePaths: info.sources.length || src.isNode ? info.sources : (m.sourcePaths || []).slice(),
      functions: info.fns,
      created: new Date().toISOString(),
    };
    const list = await store.get();
    list.push(tpl);
    await store.set(list);
    templates = list;
    return tpl;
  }

  async function deleteTemplate(tpl) {
    const list = (await store.get()).filter((t) => t.id !== tpl.id);
    await store.set(list);
    templates = list;
  }

  // Replaces the selected field's mapping with the template (or creates the mapping when the field has none).
  function applyTemplate(tpl, withSources) {
    const ctx = getContext();
    const target = getSelectedTarget(ctx);
    if (!target || !ctx.controller) throw new Error("no target field selected");
    const pinins = clone(tpl.pinins);
    if (!withSources) stripSources(pinins);
    renewIds(pinins);
    const sources = withSources ? (tpl.sourcePaths || []).slice() : [];
    let m = getMappingOf(ctx, target.xpath);
    if (!m) m = ctx.controller._createConstantMapping("", target.xpath);
    const isXml = !!(m.destination && m.destination.isXml);
    m.destination = {
      expressionPath: target.xpath,
      isXml,
      expressionDetails: { gid: "0", objectId: newId(), position: clone(tpl.dstPosition || { x: 200, y: 40 }), pinins, type: "Dst" },
      displayPath: target.xpath,
    };
    m.unconnected = [];
    m.sourcePaths = sources;
    m.fn = { expression: expressionText(pinins) };
    roundPositions(m.destination);
    // Same steps CPI takes after a mapping changes: redraw the expression, the lines between the structures, validate.
    if (ctx.controller.iview && ctx.controller.iview.setDirty) ctx.controller.iview.setDirty();
    ctx.controller._showGraphicalExpression(m);
    if (ctx.viewer._onMappingUpdate) ctx.viewer._onMappingUpdate("", "", { mapping: m });
    if (ctx.controller.validateMapping) ctx.controller.validateMapping();
    if (ctx.controller._refreshUI) ctx.controller._refreshUI();
  }

  let templates = [];
  store.get().then((l) => { templates = l; });

  // ---------- format (auto layout) ----------
  // Lays a mapping out in columns: the target field on the right, each function one column left of what it
  // feeds, sources and constants furthest left; inputs keep their pin order top to bottom.
  // Sizes below are in canvas pixels. CPI stores positions scaled down: canvas x = stored x * 1.8,
  // canvas y = stored y * 1.2 (a stored Dst at 200,40 is drawn at 360,48), so we divide when storing.
  const LAYOUT = {
    scaleX: 1.8, scaleY: 1.2,
    left: 20, top: 40,
    boxWidth: 135,   // CPI draws boxes at least ~135px wide
    colGap: 120,     // about one box between two columns
    gap: 22,         // vertical space between boxes
    nodeHeight: 40, rowHeight: 30,
    colWidth: 255,   // boxWidth + colGap, used where no widths are known
  };
  // CPI saves whole numbers only; a decimal position makes the save fail.
  const toStored = (x, y) => ({ x: Math.round(x / LAYOUT.scaleX), y: Math.round(y / LAYOUT.scaleY) });
  function roundPositions(o) {
    if (!o || typeof o !== "object") return o;
    if (o.position && typeof o.position === "object") o.position = { x: Math.round(+o.position.x || 0), y: Math.round(+o.position.y || 0) };
    for (const k in o) if (k !== "position") roundPositions(o[k]);
    return o;
  }

  function childrenOf(det) {
    return ((det && det.pinins) || []).slice().sort((a, b) => a.pinNum - b.pinNum)
      .map((pin) => pin.pinout && pin.pinout.expressionReference)
      .map((ref) => ref && (ref.graphicalFunction || ref.graphicalNode))
      .filter((n) => n && n.expressionDetails);
  }

  function nodeHeight(n) {
    if (!n.key && !n.name) return LAYOUT.nodeHeight; // source field
    if (n.expansionState === false || n.key === "const") return LAYOUT.nodeHeight;
    const pins = ((n.expressionDetails && n.expressionDetails.pinins) || []).length;
    const params = (n.valueBindingArguments || []).length;
    return LAYOUT.nodeHeight + (pins + params) * LAYOUT.rowHeight;
  }

  // Estimated box width (canvas px) from the text CPI shows in it.
  function nodeWidth(n, label) {
    let text = label || "";
    if (n) {
      if (n.key === "const") text = String(((n.valueBindingArguments || [])[0] || {}).value || "Constant");
      else if (n.key || n.name) text = n.name || n.key;
      else text = String(n.expressionPath || "").split("/").pop();
    }
    return Math.max(LAYOUT.boxWidth, Math.min(320, Math.round(text.length * 8.5 + 50)));
  }

  // Lays out one tree whose root is a Dst details object or an unconnected node; returns the bottom y used (canvas px).
  // A box that feeds several inputs shows up several times in the tree. Source fields are one box per path, other
  // boxes one per objectId; a copy may even lack its own details, so the tree is followed through the pins.
  function layoutTree(rootDet, rootNode, startY, rootLabel, boxes) {
    const item = (node, det) => ({ node, det });
    const kidsOf = (it) => ((it.det && it.det.pinins) || []).slice().sort((a, b) => a.pinNum - b.pinNum)
      .map((pin) => pin.pinout && pin.pinout.expressionReference)
      .map((ref) => ref && (ref.exprReference ? boxes && boxes.get(ref.exprReference) : ref.graphicalFunction || ref.graphicalNode))
      .filter(Boolean).map((n) => item(n, n.expressionDetails));
    const keyOf = (it) => it.node && it.node.expressionPath && !it.node.key ? "src:" + it.node.expressionPath
      : it.det ? (it.det.objectId || it.det) : it.node;
    const root = item(rootNode, rootDet);
    const depth = new Map();   // box key -> longest distance from the root
    const byId = new Map();    // box key -> node (first occurrence)
    const copies = [];         // every occurrence of every box
    (function measure(it, d, trail) {
      const id = keyOf(it);
      copies.push(it);
      if (trail.has(id)) return;
      if (!byId.has(id)) byId.set(id, it.node);
      if ((depth.get(id) || -1) < d) depth.set(id, d);
      trail.add(id);
      kidsOf(it).forEach((c) => measure(c, d + 1, trail));
      trail.delete(id);
    })(root, 0, new Set());
    const maxDepth = Math.max(...depth.values());
    // Column 0 is the leftmost (deepest) one; x of a column = widths of the columns before it plus a gap each.
    const colW = new Array(maxDepth + 1).fill(0);
    depth.forEach((d, id) => {
      const col = maxDepth - d;
      colW[col] = Math.max(colW[col], nodeWidth(byId.get(id), byId.get(id) ? "" : rootLabel));
    });
    const colX = [];
    colW.reduce((x, w, i) => { colX[i] = x; return x + w + LAYOUT.colGap; }, LAYOUT.left);
    let nextY = startY;
    const placed = new Set();
    const positions = new Map(); // box key -> new stored position
    (function place(it) {
      const id = keyOf(it);
      if (placed.has(id)) return null;
      placed.add(id);
      const kids = kidsOf(it).map(place).filter((y) => y !== null);
      const h = it.node ? nodeHeight(it.node) : LAYOUT.nodeHeight;
      let y;
      if (kids.length) y = Math.round((kids[0] + kids[kids.length - 1]) / 2);
      else { y = nextY; }
      nextY = Math.max(nextY, y + h + LAYOUT.gap);
      positions.set(id, toStored(colX[maxDepth - depth.get(id)], y));
      return y;
    })(root);
    // CPI may draw a shared box from any of its copies, so every copy gets the same position.
    copies.forEach((it) => { const pos = positions.get(keyOf(it)); if (pos && it.det) it.det.position = { x: pos.x, y: pos.y }; });
    return nextY;
  }

  function formatMapping(m) {
    const det = m && m.destination && m.destination.expressionDetails;
    if (!det) return false;
    const boxes = boxesOfMapping(m);
    let bottom = layoutTree(det, null, LAYOUT.top, String((m.targetPaths || [""])[0]).split("/").pop(), boxes);
    (m.unconnected || []).forEach((u) => {
      const node = u.graphicalFunction || u.graphicalNode || u;
      if (node && node.expressionDetails) bottom = layoutTree(node.expressionDetails, node, bottom + LAYOUT.gap, undefined, boxes);
    });
    return true;
  }

  function refreshAfterFormat(ctx, current) {
    if (ctx.controller.iview && ctx.controller.iview.setDirty && isEditMode(ctx)) ctx.controller.iview.setDirty();
    if (current) ctx.controller._showGraphicalExpression(current, true);
  }

  function formatSelected() {
    const ctx = getContext();
    const target = getSelectedTarget(ctx);
    const m = target && getMappingOf(ctx, target.xpath);
    if (!formatMapping(m)) throw new Error("the selected field has no mapping");
    refreshAfterFormat(ctx, m);
  }

  function formatAll() {
    const ctx = getContext();
    const all = ctx.viewer.getTransformation().getMappings();
    let n = 0;
    all.forEach((m) => { try { if (formatMapping(m)) n++; } catch (err) { console.warn("[CI Mapping Toolkit] format", m.id, err); } });
    const target = getSelectedTarget(ctx);
    refreshAfterFormat(ctx, target && getMappingOf(ctx, target.xpath));
    return n;
  }

  // Runs an action outside the search box and reports errors as a toast.
  function runAction(label, fn) {
    return Promise.resolve().then(fn).catch((err) => fail("could not " + label, err));
  }

  // Safety net: just before CPI saves the mapping, make every box position a whole number
  // (older versions of this extension stored decimals, which CPI refuses to save).
  function guardSave() {
    const c = getContext().controller;
    if (!c || c.__ciMappingToolkitSave || typeof c.onSave !== "function") return;
    const orig = c.onSave;
    c.onSave = function () {
      try { this._getTransformationObject().mappings.forEach((m) => { roundPositions(m.destination); roundPositions(m.unconnected); }); }
      catch (err) { console.warn("[CI Mapping Toolkit] could not tidy positions before save", err); }
      return orig.apply(this, arguments);
    };
    c.__ciMappingToolkitSave = true;
  }

  // Redraws a mapping after we changed it: expression canvas, lines between the structures, validation.
  function refreshMapping(ctx, m) {
    roundPositions(m.destination);
    roundPositions(m.unconnected);
    if (ctx.controller.iview && ctx.controller.iview.setDirty) ctx.controller.iview.setDirty();
    ctx.controller._showGraphicalExpression(m);
    if (ctx.viewer._onMappingUpdate) ctx.viewer._onMappingUpdate("", "", { mapping: m });
    if (ctx.controller.validateMapping) ctx.controller.validateMapping();
    if (ctx.controller._refreshUI) ctx.controller._refreshUI();
  }

  // ---------- templates added unconnected ----------
  const nodeOf = (u) => (u && (u.graphicalFunction || u.graphicalNode)) || u;

  function collectDetails(node, out) {
    if (!node || !node.expressionDetails || out.includes(node.expressionDetails)) return out;
    out.push(node.expressionDetails);
    childrenOf(node.expressionDetails).forEach((c) => collectDetails(c, out));
    return out;
  }

  function allDetails(m) {
    const out = [];
    if (m.destination && m.destination.expressionDetails) collectDetails(m.destination, out);
    (m.unconnected || []).forEach((u) => collectDetails(nodeOf(u), out));
    return out;
  }

  // New mapping with an unconnected target field, like after deleting its only connection.
  function createEmptyMapping(ctx, target) {
    const m = ctx.controller._createConstantMapping("", target.xpath);
    m.destination = {
      expressionPath: target.xpath, isXml: false, displayPath: target.xpath,
      expressionDetails: { gid: "0", objectId: newId(), position: { x: 200, y: 40 }, pinins: [{ pinNum: 0 }], type: "Dst" },
    };
    m.sourcePaths = [];
    m.fn = { expression: "" };
    return m;
  }

  // ---------- source fields added from the keyboard ----------
  // Every field of the source structure, in document order: [{xpath, name}].
  function sourceEntries(ctx) {
    const tr = ctx.viewer.getTransformation();
    const msg = tr.getSourceMessage ? tr.getSourceMessage() : tr.source;
    const out = [];
    const seen = new Set();
    const visited = new Set();
    (function walk(o, d) {
      if (!o || typeof o !== "object" || visited.has(o) || d > 60) return;
      visited.add(o);
      if (typeof o.xpath === "string" && !seen.has(o.xpath)) {
        seen.add(o.xpath);
        out.push({ xpath: o.xpath, name: o.name || o.xpath.split("/").pop() });
      }
      for (const k in o) { const v = o[k]; if (v && typeof v === "object") walk(v, d + 1); }
    })(msg, 0);
    return out;
  }

  // The row selected in the source structure, if any.
  function getSelectedSourcePath(ctx) {
    try {
      const t = ctx.viewer._getSourceTable();
      const i = t.getSelectedIndex();
      const o = i >= 0 && t.getContextByIndex(i).getObject();
      return o && o.xpath || null;
    } catch (_) { return null; }
  }

  // Inputs of the mapping that can take a source field: {detId, pinNum, name, desc, x, y}.
  // The target field comes first, then the free inputs of every function, then those of unconnected functions.
  function freeInputs(ctx, m, targetName) {
    const fns = ctx.palette ? getFunctions(ctx.palette) : [];
    const out = [];
    const seen = new Set();
    // rect: where the input is drawn on the canvas (canvas px), worked out the same way as the format layout.
    const rectOf = (det, node, title, i) => {
      const p = det.position;
      if (!p) return null;
      const x = p.x * LAYOUT.scaleX;
      const y = p.y * LAYOUT.scaleY;
      const w = nodeWidth(node, node ? "" : title);
      const collapsed = !node || node.expansionState === false || node.key === "const";
      const h = collapsed ? LAYOUT.nodeHeight : nodeHeight(node);
      return collapsed ? { x, y, w, h, box: { x, y, w, h } }
        : { x, y: y + LAYOUT.nodeHeight + i * LAYOUT.rowHeight, w, h: LAYOUT.rowHeight, box: { x, y, w, h } };
    };
    const visit = (det, node, title, fn) => {
      if (!det || seen.has(det)) return;
      seen.add(det);
      const args = (fn && fn.signature && fn.signature.arguments) || [];
      (det.pinins || []).slice().sort((a, b) => a.pinNum - b.pinNum).forEach((pin, i) => {
        const ref = pin.pinout && pin.pinout.expressionReference;
        if (!ref) {
          const arg = args[i] && (args[i].displayName || args[i].name);
          out.push({ detId: det.objectId, pinNum: pin.pinNum, index: i, title, arg: arg || "input " + (i + 1), isDst: det.type === "Dst",
            rect: rectOf(det, node, title, i) });
        } else if (ref.graphicalFunction) {
          const f = ref.graphicalFunction;
          visit(f.expressionDetails, f, f.name || f.key, fns.find((g) => g.name === f.key));
        }
      });
    };
    visit(m.destination.expressionDetails, null, targetName, null);
    (m.unconnected || []).forEach((u) => {
      const n = nodeOf(u);
      if (n && n.expressionDetails) visit(n.expressionDetails, n, n.name || n.key, fns.find((f) => f.name === n.key));
    });
    return out;
  }

  // Lets the user move a selection box over the free inputs on the canvas with the arrow keys.
  // Resolves with the chosen input, null for "not connected", or undefined when cancelled.
  let pickerActive = false;
  function pickInputOnCanvas(inputs, entry) {
    return new Promise((resolve) => {
      const canvas = getCanvas();
      const cands = inputs.filter((c) => c.rect);
      if (!canvas || !cands.length) return resolve("none");
      const bottom = Math.max(...cands.map((c) => c.rect.box.y + c.rect.box.h));
      const loose = { loose: true, arg: "not connected", title: "", rect: { x: 10, y: bottom + 30, w: 150, h: LAYOUT.nodeHeight } };
      loose.rect.box = loose.rect;
      const list = cands.concat([loose]);
      let cur = 0;

      const layer = document.createElement("div");
      Object.assign(layer.style, { position: "fixed", zIndex: 2147483645, overflow: "hidden", pointerEvents: "none" });
      const boxEl = document.createElement("div");
      const rowEl = document.createElement("div");
      Object.assign(boxEl.style, { position: "absolute", border: "2px dashed #0a6ed1", borderRadius: "6px", boxSizing: "border-box" });
      Object.assign(rowEl.style, { position: "absolute", background: "rgba(10,110,209,.28)", border: "2px solid #0a6ed1", borderRadius: "4px", boxSizing: "border-box" });
      layer.append(boxEl, rowEl);
      const hud = document.createElement("div");
      Object.assign(hud.style, { position: "fixed", bottom: "32px", left: "50%", transform: "translateX(-50%)", zIndex: 2147483647,
        background: "#32363a", color: "#fff", padding: "10px 16px", borderRadius: "8px", font: '14px "72", Arial, sans-serif',
        boxShadow: "0 4px 16px rgba(0,0,0,.3)", maxWidth: "90vw" });
      document.body.append(layer, hud);

      const place = (r, el) => {
        Object.assign(el.style, { left: r.x - canvas.scrollLeft + "px", top: r.y - canvas.scrollTop + "px", width: r.w + "px", height: r.h + "px" });
      };
      const draw = () => {
        const c = list[cur];
        const cr = canvas.getBoundingClientRect();
        Object.assign(layer.style, { left: cr.left + "px", top: cr.top + "px", width: cr.width + "px", height: cr.height + "px" });
        // keep the selection in view
        const b = c.rect.box;
        if (b.y < canvas.scrollTop) canvas.scrollTop = Math.max(0, b.y - 20);
        else if (b.y + b.h > canvas.scrollTop + cr.height) canvas.scrollTop = b.y + b.h - cr.height + 20;
        if (b.x < canvas.scrollLeft) canvas.scrollLeft = Math.max(0, b.x - 20);
        else if (b.x + b.w > canvas.scrollLeft + cr.width) canvas.scrollLeft = b.x + b.w - cr.width + 20;
        place(b, boxEl);
        place(c.rect, rowEl);
        boxEl.style.display = c.rect.y === b.y && c.rect.h === b.h ? "none" : "block";
        hud.textContent = "Add " + entry.name + " – " + (c.loose ? "not connected" : c.isDst ? "connect to the target field" : "connect to " + c.arg + " of " + c.title) +
          "   ·   ←↑↓→ move   ·   Enter place   ·   Esc cancel";
      };
      const move = (dx, dy) => {
        const c = list[cur].rect;
        const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
        let best = -1, bestScore = Infinity;
        list.forEach((o, i) => {
          if (i === cur) return;
          const ox = o.rect.x + o.rect.w / 2 - cx, oy = o.rect.y + o.rect.h / 2 - cy;
          const along = dx ? ox * dx : oy * dy;
          const across = dx ? Math.abs(oy) : Math.abs(ox);
          if (along <= 1) return;
          const s = along + 2 * across;
          if (s < bestScore) { bestScore = s; best = i; }
        });
        if (best < 0 && dy) best = (cur + dy + list.length) % list.length;
        if (best >= 0) { cur = best; draw(); }
      };
      const done = (v) => {
        pickerActive = false;
        window.removeEventListener("keydown", onKey, true);
        layer.remove(); hud.remove();
        resolve(v);
      };
      const onKey = (e) => {
        const k = e.key;
        if (k === "ArrowUp") move(0, -1);
        else if (k === "ArrowDown") move(0, 1);
        else if (k === "ArrowLeft") move(-1, 0);
        else if (k === "ArrowRight") move(1, 0);
        else if (k === "Tab") { cur = (cur + (e.shiftKey ? -1 : 1) + list.length) % list.length; draw(); }
        else if (k === "Enter") return finish(e, list[cur].loose ? null : list[cur]);
        else if (k === "Escape") return finish(e, undefined);
        else return;
        e.preventDefault(); e.stopPropagation();
      };
      const finish = (e, v) => { e.preventDefault(); e.stopPropagation(); done(v); };
      pickerActive = true;
      window.addEventListener("keydown", onKey, true);
      draw();
    });
  }

  // A source-field box for the mapping. Copies the shape of one CPI made itself when the mapping has one.
  function makeSourceNode(ctx, entry, position) {
    let sample = null;
    ctx.viewer.getTransformation().getMappings().forEach((mp) => {
      if (sample || !mp.destination || !mp.destination.expressionDetails) return;
      walkRefs(mp.destination.expressionDetails.pinins, (ref) => { if (!sample && ref.graphicalNode) sample = ref.graphicalNode; });
    });
    let node;
    if (sample) {
      node = clone(sample);
      const oldPath = sample.expressionPath;
      const oldName = String(oldPath || "").split("/").pop();
      (function swap(o) {
        for (const k in o) {
          const v = o[k];
          if (typeof v === "string") { if (v === oldPath) o[k] = entry.xpath; else if (v && v === oldName) o[k] = entry.name; }
          else if (v && typeof v === "object") swap(v);
        }
      })(node);
    } else {
      node = { expressionPath: entry.xpath, displayPath: entry.xpath, isXml: true, expressionDetails: { gid: "0", type: "Src", pinins: [] } };
    }
    renewIds(node);
    node.expressionPath = entry.xpath;
    node.expressionDetails = node.expressionDetails || { gid: "0", type: "Src", pinins: [] };
    node.expressionDetails.objectId = node.expressionDetails.objectId || newId();
    node.expressionDetails.position = position;
    return node;
  }

  // slot: an item of freeInputs (connect there) or null (add to the mapping, not connected).
  function addSourceField(entry, slot) {
    const ctx = getContext();
    const target = getSelectedTarget(ctx);
    if (!target || !ctx.controller) throw new Error("no target field selected");
    const m = getMappingOf(ctx, target.xpath) || createEmptyMapping(ctx, target);
    let det = null;
    let pin = null;
    if (slot) {
      det = slot.toTarget ? m.destination.expressionDetails : allDetails(m).find((d) => d.objectId === slot.detId);
      pin = det && (det.pinins || []).find((p) => p.pinNum === (slot.toTarget ? 0 : slot.pinNum));
      if (!pin) throw new Error("that input is gone – open the source picker again");
    }
    let position;
    if (pin) {
      const p = det.position || { x: 200, y: 40 };
      position = { x: Math.max(0, p.x - 140), y: p.y + (slot.index || 0) * 40 };
    } else {
      const existing = allDetails(m).filter((d) => d.position);
      position = { x: 10, y: existing.length ? Math.max(...existing.map((d) => d.position.y)) + 60 : 20 };
    }
    const node = makeSourceNode(ctx, entry, position);
    if (pin) pin.pinout = { pinNum: pin.pinNum, expressionReference: { graphicalNode: node } };
    else m.unconnected = (m.unconnected || []).concat([node]);
    m.sourcePaths = [...new Set((m.sourcePaths || []).concat([entry.xpath]))];
    if (pin) m.fn = Object.assign(m.fn || {}, { expression: expressionText(m.destination.expressionDetails.pinins) });
    refreshMapping(ctx, m);
  }

  // Adds the template to the selected field's mapping without connecting it, below what is already there,
  // so several templates can be combined and wired up by hand.
  function addTemplateUnconnected(tpl, withSources) {
    const ctx = getContext();
    const target = getSelectedTarget(ctx);
    if (!target || !ctx.controller) throw new Error("no target field selected");
    const pinins = clone(tpl.pinins);
    if (!withSources) stripSources(pinins);
    renewIds(pinins);
    const roots = pinins.map((p) => p.pinout && p.pinout.expressionReference).map(nodeOf).filter((n) => n && n.expressionDetails);
    if (!roots.length) throw new Error("the template has nothing left without its source fields");
    const m = getMappingOf(ctx, target.xpath) || createEmptyMapping(ctx, target);
    // Stored units (canvas / scale). Start below the lowest box already in the mapping.
    const existing = allDetails(m).filter((d) => d.position);
    let top = existing.length ? Math.max(...existing.map((d) => d.position.y)) + 60 : 20;
    roots.forEach((root) => {
      const dets = collectDetails(root, []).filter((d) => d.position);
      if (dets.length) {
        const minX = Math.min(...dets.map((d) => d.position.x));
        const minY = Math.min(...dets.map((d) => d.position.y));
        dets.forEach((d) => { d.position = { x: d.position.x - minX + 10, y: d.position.y - minY + top }; });
        top = Math.max(...dets.map((d) => d.position.y)) + 60;
      }
      m.unconnected = (m.unconnected || []).concat([root]);
    });
    if (withSources) m.sourcePaths = [...new Set((m.sourcePaths || []).concat(tpl.sourcePaths || []))];
    refreshMapping(ctx, m);
  }

  // ---------- "•••" menu on the canvas boxes ----------
  // CPI's expression renderer shows customData.customActions in a box's menu (targetControl = node type).
  let menuNode = null; // box whose menu was used for "Save as template…"

  function addCanvasMenuActions() {
    allElements().filter((e) => typeOf(e) === EDITOR_TYPE).forEach((ed) => {
      const r = ed._oExpressionRenderer;
      if (!r || r.__ciMappingToolkit) return;
      r.__ciMappingToolkit = true;
      r.customData = r.customData || {};
      r.customData.customActions = r.customData.customActions || [];
      const boxOfMenu = () => { try { const d = r.getShapeManager().getShapeData(r._oPaletteDock); return d && d.id; } catch (_) { return null; } };
      const add = (title, types, handler) => types.forEach((t) => r.customData.customActions.push({
        data: {
          uiInfo: { title, navigationType: "Active", tooltip: title, styles: ["gec-overflow"], speedIcon: "" },
          enabler: () => ({ visible: isEditMode(getContext()) }),
          handler: () => { const id = boxOfMenu(); setTimeout(() => handler(id), 350); }, // after CPI closed its menu
        },
        targetControl: t,
      }));
      add("Format mapping", ["Func", "Src", "Dst"], () => runAction("format mapping", () => { formatSelected(); toast("Mapping Toolkit: formatted."); }));
      add("Save as template…", ["Func", "Src"], (id) => { menuNode = { id, at: Date.now() }; open({ startSave: true }); });
    });
  }

  // ---------- switch to Edit mode ----------
  const parentId = (c) => { try { return c.getParent().getId(); } catch (_) { return ""; } };
  const isButton = (c) => /Button/.test(typeOf(c));

  function iflowSaveVisible() {
    return allElements().some((e) => isButton(e) && e.getText && e.getText() === "Save" && e.getVisible() && /iflowObjectPageHeader|sheet/.test(parentId(e)));
  }

  // The integration flow editor (view com.sap.it.spc.myproj.views.iflowdetail) of the open flow, if any.
  function iflowController() {
    const v = allElements().find((e) => /XMLView/.test(typeOf(e)) && e.getViewName && e.getViewName() === "com.sap.it.spc.myproj.views.iflowdetail");
    return v && v.getController && v.getController();
  }

  function closeLoadErrorDialogs() {
    allElements().filter((e) => e.isOpen && typeof e.isOpen === "function" && e.isOpen()).forEach((d) => {
      const text = (d.getDomRef && d.getDomRef() && d.getDomRef().innerText) || "";
      if (/MAPPING_DETAILS_COULD_NOT_BE_LOADED/.test(text)) { try { d.close(); } catch (_) { /* ignore */ } }
    });
  }

  // Presses Edit and makes the open mapping editable, without leaving it.
  // A mapping opened while its integration flow was read-only stays read-only (and CPI may even fail to
  // reload it), so once the flow is in Edit mode we open the mapping again the way the flow editor itself
  // does – with EditMode taken from the flow.
  async function switchToEditMode() {
    const ctx = getContext();
    const md = (ctx.controller && ctx.controller.metadatalookup && ctx.controller.metadatalookup._metaData) || {};
    const mappingFile = (md.MappingName || mappingName()) + ".mmap";
    const resLocation = md.resourceLocation;
    const flow = iflowController();
    const edits = allElements().filter((e) => isButton(e) && e.getText && e.getText() === "Edit" && e.getVisible() && (!e.getEnabled || e.getEnabled()));
    const flowBtn = edits.find((b) => /iflowObjectPageHeader/.test(parentId(b))) || edits.find((b) => /sheet/.test(parentId(b)));
    const btn = (flow && flowBtn) || edits.find((b) => /mapping/i.test(parentId(b) + b.getId())) || edits[0];
    if (!btn) throw new Error("no Edit button found – is it locked by someone else?");
    btn.firePress();
    toast("Mapping Toolkit: switching to Edit mode…");
    // Wait for Edit mode; CPI may ask first (e.g. to unlock an older session of yours).
    const inEdit = () => (flow && flow.isIFlowInEdit ? flow.isIFlowInEdit() : isEditMode(getContext()));
    for (let i = 0; i < 480 && !inEdit(); i++) await sleep(250);
    if (!inEdit()) { toast("Mapping Toolkit: still read-only (was CPI's question cancelled?)."); return; }
    if (!flow) { toast("Mapping Toolkit: the mapping is in Edit mode."); return; }
    await sleep(800);
    closeLoadErrorDialogs();
    if (!isEditMode(getContext())) {
      if (typeof flow._handleResourceProblemNavigation !== "function") {
        toast("Mapping Toolkit: the integration flow is in Edit mode – open the mapping from the flow to edit it.");
        return;
      }
      flow._handleResourceProblemNavigation({ resourceName: mappingFile, resourceLocation: resLocation });
    }
    for (let i = 0; i < 120; i++) {
      await sleep(250);
      closeLoadErrorDialogs();
      const c = getContext();
      if (c.viewer && c.controller && isEditMode(c)) { toast("Mapping Toolkit: the mapping is in Edit mode."); return; }
    }
    toast("Mapping Toolkit: the integration flow is in Edit mode – open the mapping from the flow to edit it.");
  }

  // ---------- export / import of the field mappings ----------
  const EXPORT_FORMAT = "ci-mapping-toolkit/mappings";

  function exportMappings() {
    const ctx = getContext();
    const list = ctx.viewer.getTransformation().getMappings().map((m) => ({
      targetPaths: m.targetPaths || [], sourcePaths: m.sourcePaths || [], fn: m.fn || null,
      destination: m.destination || null, unconnected: m.unconnected || [], groupId: m.groupId,
    }));
    const data = { format: EXPORT_FORMAT, version: 1, mappingName: mappingName(), exportedFrom: mappingKey(), exported: new Date().toISOString(), mappings: list };
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = mappingName() + ".mappings.json";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return list.length;
  }

  // Every xpath in a message structure (walks the model generically).
  function structurePaths(msg) {
    const paths = new Set();
    const seen = new Set();
    (function walk(o, d) {
      if (!o || typeof o !== "object" || seen.has(o) || d > 60) return;
      seen.add(o);
      if (typeof o.xpath === "string") paths.add(o.xpath);
      for (const k in o) { const v = o[k]; if (v && typeof v === "object") walk(v, d + 1); }
    })(msg, 0);
    return paths;
  }

  // The file input is attached to the page while the dialog is open: a detached input can be garbage
  // collected before Chrome delivers the chosen file, and then nothing happens at all.
  function pickFile() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.style.display = "none";
      document.body.appendChild(input);
      const done = (file) => { input.remove(); resolve(file || null); };
      input.addEventListener("change", () => done(input.files && input.files[0]));
      input.addEventListener("cancel", () => done(null));
      input.click();
    });
  }

  // replaceExisting: overwrite fields that are already mapped; otherwise only fill unmapped fields.
  async function importMappings(file, replaceExisting) {
    const data = JSON.parse(await file.text());
    if (!data || data.format !== EXPORT_FORMAT || !Array.isArray(data.mappings)) throw new Error("not a Mapping Toolkit export file");
    const ctx = getContext();
    const tr = ctx.viewer.getTransformation();
    const targets = structurePaths(tr.getTargetMessage ? tr.getTargetMessage() : tr.target);
    const sources = structurePaths(tr.getSourceMessage ? tr.getSourceMessage() : tr.source);
    let added = 0, replaced = 0, kept = 0, noTarget = 0, missingSources = 0;
    for (const e of data.mappings) {
      const tps = e.targetPaths || [];
      if (!tps.length || !e.destination) continue;
      if (targets.size && !tps.every((p) => targets.has(p))) { noTarget++; continue; }
      let m = getMappingOf(ctx, tps[0]);
      if (m && !replaceExisting) { kept++; continue; }
      if (m) replaced++; else { m = ctx.controller._createConstantMapping("", tps[0]); added++; }
      const dest = clone(e.destination);
      const unc = clone(e.unconnected || []);
      renewIds({ dest, unc }); // one pass, so pointers between the connected and unconnected boxes stay valid
      m.targetPaths = tps.slice();
      m.destination = dest;
      m.unconnected = unc;
      m.sourcePaths = (e.sourcePaths || []).slice();
      m.fn = e.fn ? clone(e.fn) : { expression: "" };
      roundPositions(m.destination);
      roundPositions(m.unconnected);
      if (sources.size && m.sourcePaths.some((p) => !sources.has(p))) missingSources++;
      if (ctx.viewer._onMappingUpdate) ctx.viewer._onMappingUpdate("", "", { mapping: m });
    }
    if (ctx.controller.iview && ctx.controller.iview.setDirty) ctx.controller.iview.setDirty();
    if (ctx.controller.validateMapping) ctx.controller.validateMapping();
    if (ctx.controller._refreshUI) ctx.controller._refreshUI();
    const target = getSelectedTarget(ctx);
    const cur = target && getMappingOf(ctx, target.xpath);
    if (cur) ctx.controller._showGraphicalExpression(cur);
    return { added, replaced, kept, noTarget, missingSources };
  }

  // ---------- usage in the current mapping ----------
  // The editor loads the whole mapping as JSON from ".../resources/<name>.mmap?modelType=MappingModelTO".
  // We re-read that same resource and count every function node (namespace + key).
  let usage = { cacheKey: null, counts: {}, promise: null };

  function usageKeyOfFn(fn) {
    const ns = fn.group === "Standard" || !fn.namespace ? "dflt" : fn.namespace;
    return ns + "|" + fn.name;
  }

  function mappingResourceUrl() {
    const m = location.pathname.match(/\/([^\/]+\.mmap)/i);
    const entries = performance.getEntriesByType("resource").map((r) => r.name)
      .filter((n) => /\.mmap\?.*modelType=MappingModelTO/i.test(n) && (!m || n.includes("/" + m[1] + "?")));
    return entries.length ? { url: entries[entries.length - 1], n: entries.length } : null;
  }

  function countFunctions(json) {
    const counts = {};
    const seen = new Set();
    (function walk(o) {
      if (!o || typeof o !== "object" || seen.has(o)) return;
      seen.add(o);
      if (typeof o.key === "string" && typeof o.name === "string" && "namespace" in o) {
        const k = (o.namespace || "dflt") + "|" + o.key;
        counts[k] = (counts[k] || 0) + 1;
      }
      for (const k in o) walk(o[k]);
    })(json.mappings || json);
    return counts;
  }

  function loadUsage() {
    const res = mappingResourceUrl();
    if (!res) return Promise.resolve(usage.counts);
    const cacheKey = res.url + "#" + res.n;
    if (usage.cacheKey === cacheKey && usage.promise) return usage.promise;
    usage.cacheKey = cacheKey;
    usage.promise = fetch(res.url, { headers: { Accept: "application/json" }, credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((json) => { usage.counts = countFunctions(json); return usage.counts; })
      .catch((err) => { console.warn("[CI Mapping Toolkit] could not analyse mapping", err); usage.counts = {}; return usage.counts; });
    return usage.promise;
  }

  function usageCount(fn) { return usage.counts[usageKeyOfFn(fn)] || 0; }
  function bumpUsage(fn) { const k = usageKeyOfFn(fn); usage.counts[k] = (usage.counts[k] || 0) + 1; }

  // ---------- recent functions ----------
  function fnKey(fn) { return (fn.category && fn.category.key ? fn.category.key : "") + "/" + fn.name; }
  function loadRecent() { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch (_) { return []; } }
  function rememberRecent(fn) {
    try {
      const k = fnKey(fn);
      const list = [k, ...loadRecent().filter((x) => x !== k)].slice(0, 15);
      localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch (_) { /* ignore */ }
  }

  // ---------- matching ----------
  function scoreText(q, texts) {
    let best = 0;
    for (const orig of texts) {
      const n = (orig || "").toLowerCase();
      if (!n) continue;
      if (n === q) best = Math.max(best, 1000);
      else if (n.startsWith(q)) best = Math.max(best, 800 - n.length);
      else {
        // camelCase / word start match, e.g. "fbe" -> formatByExample
        const initials = orig.replace(/[^A-Za-z0-9]/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2")
          .split(/\s+/).filter(Boolean).map((w) => w[0].toLowerCase()).join("");
        if (initials.startsWith(q)) best = Math.max(best, 650);
        const idx = n.indexOf(q);
        if (idx > 0) best = Math.max(best, 500 - idx);
        else if (subsequence(q, n)) best = Math.max(best, 200 - n.length);
      }
    }
    return best;
  }

  function score(query, fn, recentIdx) {
    const q = query.toLowerCase();
    const recentBoost = recentIdx >= 0 ? 30 - recentIdx : 0;
    if (!q) return recentIdx >= 0 ? 1000 - recentIdx : 1;
    let best = scoreText(q, [fn.displayName || "", fn.name || ""]);
    if (!best) {
      const cat = ((fn.category && fn.category.displayText) || "").toLowerCase();
      const desc = (fn.description || "").toLowerCase();
      if (cat.includes(q)) best = 120;
      else if (desc.includes(q)) best = 80;
    }
    const used = usageCount(fn);
    const usageBoost = used ? Math.min(160, Math.round(30 * Math.log2(1 + used))) : 0;
    return best ? best + recentBoost + usageBoost : 0;
  }

  function scoreTemplate(query, tpl) {
    const q = query.toLowerCase();
    let best = scoreText(q, [tpl.name || "", tpl.targetName || ""]);
    if (!best && (tpl.functions || []).some((f) => (f || "").toLowerCase().includes(q))) best = 150;
    if (!best && q.startsWith("tem")) best = 100; // "template" lists them all
    return best ? best + 60 : 0;
  }

  function subsequence(q, s) {
    let i = 0;
    for (const ch of s) if (ch === q[i]) i++;
    return i === q.length;
  }

  // ---------- UI ----------
  let host = null;

  const CSS = `
    :host { all: initial; }
    .backdrop { position: fixed; inset: 0; z-index: 2147483646; background: rgba(0,0,0,.15); }
    .box { position: fixed; z-index: 2147483647; top: 18vh; left: 50%; transform: translateX(-50%);
      width: min(600px, calc(100vw - 32px)); background: #fff; color: #1d2d3e; border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0,0,0,.28); font: 14px/1.35 "72", "72full", Arial, Helvetica, sans-serif;
      overflow: hidden; border: 1px solid #d9d9d9; }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #eee; }
    .fx { font: italic bold 15px Georgia, serif; color: #0a6ed1; white-space: nowrap; }
    input { flex: 1; border: 0; outline: 0; font: inherit; font-size: 16px; color: inherit; background: transparent; min-width: 0; }
    .hint { font-size: 11px; color: #6a6d70; white-space: nowrap; }
    ul { list-style: none; margin: 0; padding: 4px 0; max-height: 50vh; overflow-y: auto; }
    li { padding: 6px 12px; cursor: pointer; display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; }
    li.sel { background: #e8f2ff; box-shadow: inset 3px 0 0 #0a6ed1; }
    .name { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sig { color: #6a6d70; font-weight: 400; }
    .cat { font-size: 11px; color: #fff; background: #5b738b; border-radius: 8px; padding: 1px 7px; align-self: center; white-space: nowrap; }
    .cat.udf { background: #7858ff; }
    .cat.local { background: #188918; }
    .cat.global { background: #0a6ed1; }
    .cat.action { background: #e76500; }
    .desc { grid-column: 1 / -1; font-size: 12px; color: #6a6d70; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    li.hdr { display: block; cursor: default; padding: 8px 12px 4px; font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .04em; color: #0a6ed1; position: sticky; top: -4px; background: #fff; }
    .tags { display: flex; gap: 6px; align-items: center; }
    .cnt { font-size: 11px; font-weight: 700; color: #0a6ed1; background: #e8f2ff; border-radius: 8px; padding: 1px 7px; }
    .empty { padding: 14px 12px; color: #6a6d70; }
    mark { background: #fff3b8; color: inherit; }
  `;

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function highlight(text, q) {
    if (!q) return esc(text);
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length));
  }

  function close() {
    if (host) { host.remove(); host = null; }
    menuNode = null;
  }

  function toast(msg) {
    const t = document.createElement("div");
    t.textContent = msg;
    Object.assign(t.style, {
      position: "fixed", bottom: "32px", left: "50%", transform: "translateX(-50%)", zIndex: 2147483647,
      background: "#32363a", color: "#fff", padding: "10px 16px", borderRadius: "8px",
      font: '14px "72", Arial, sans-serif', boxShadow: "0 4px 16px rgba(0,0,0,.3)",
    });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  function fail(what, err) {
    console.error("[CI Mapping Toolkit]", err);
    toast("Mapping Toolkit: " + what + (err && err.message ? " – " + err.message : ""));
  }

  async function open(opts) {
    opts = opts || {};
    if (host) { const keep = menuNode; close(); if (!opts.startSave && !opts.startSource) return; menuNode = keep; }
    const ctx = getContext();
    const palette = ctx.palette;
    if (!palette || !ctx.editor) {
      toast("Mapping Toolkit: open a message mapping first.");
      return;
    }
    const readOnly = !isEditMode(ctx);
    const target = getSelectedTarget(ctx);
    // Nothing selected: only the mapping-wide actions (format all, export, import) are offered.
    const noTarget = !target && !getTargetNode(getExpression(ctx));
    const targetName = target ? target.name : (getTargetNode(getExpression(ctx)) || {}).name || "";
    const targetMapping = target && getMappingOf(ctx, target.xpath);
    const canSaveTemplate = !!(targetMapping && targetMapping.destination && targetMapping.destination.expressionDetails &&
      (targetMapping.destination.expressionDetails.pinins || []).some((p) => p.pinout));
    // A function clicked on the canvas is saved with its inputs; otherwise the whole mapping of the field.
    const saveSource = templateSource(ctx);
    const saveLabel = saveSource ? saveSource.label : targetName;
    const saveAction = !saveSource ? [] : saveSource.isNode
      ? [{ kind: "action", id: "save", name: "Save " + saveLabel + " and its inputs as template…", tag: "template",
          desc: "Saves the selected function and everything that leads up to it (click another box first to change)", words: "save template" }]
      : [{ kind: "action", id: "save", name: "Save mapping of " + targetName + " as template…", tag: "template",
          desc: "Saves everything that leads up to " + targetName + " – click a function first to save only that part", words: "save template" }];
    const fns = getFunctions(palette);
    if (!fns.length) { toast("Mapping Toolkit: no functions found in the palette."); return; }
    const thisMapping = mappingKey();
    templates = await store.get();
    const visibleTemplates = () => templates.filter((t) => t.scope === "global" || t.mappingKey === thisMapping);

    host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${CSS}</style>
      <div class="backdrop"></div>
      <div class="box" role="dialog" aria-label="Add function">
        <div class="head"><span class="fx">fx</span>
          <input type="text" placeholder="Type a function or template name…" spellcheck="false" autocomplete="off">
          <span class="hint">↑↓ Enter · Esc · F1 keys</span></div>
        <ul role="listbox"></ul>
      </div>`;
    document.body.appendChild(host);

    const input = root.querySelector("input");
    const ul = root.querySelector("ul");
    const fx = root.querySelector(".fx");
    const hint = root.querySelector(".hint");
    let items = [];   // what the list shows: {kind: "fn"|"tpl"|"action"|"choice", ...}
    let sel = 0;
    let mode = null;  // null = search; otherwise {onEnter(item, text), items, live: bool}

    // Keep keystrokes away from the SAPUI5 editor underneath.
    ["keydown", "keyup", "keypress"].forEach((t) => host.addEventListener(t, (e) => e.stopPropagation()));
    root.querySelector(".backdrop").addEventListener("mousedown", close);

    const byName = (a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name);

    // Returns [{title, items}] sections for the search mode.
    function buildSections(q) {
      const recent = loadRecent();
      const actions = [{ kind: "action", id: "addSource", name: "Add source field to " + targetName + "…", tag: "source", tagClass: "local",
        desc: "Pick a field of the source structure with the arrow keys, then the input it goes to (Alt+S)", words: "add source field input connect" },
      ].concat(saveAction).concat(canSaveTemplate ? [
        { kind: "action", id: "format", name: "Format mapping of " + targetName, tag: "format",
          desc: "Arrange the steps in order: sources left, then each function, the target field on the right (Ctrl+Shift+F)", words: "format layout arrange tidy order" },
      ] : []).concat([
        { kind: "action", id: "formatAll", name: "Format all mappings in " + mappingName(), tag: "format",
          desc: "Arrange the steps of every field's mapping in order", words: "format all layout arrange tidy order" },
        { kind: "action", id: "export", name: "Export mappings of " + mappingName() + "…", tag: "export", tagClass: "global",
          desc: "Downloads every field mapping of this message mapping as a JSON file", words: "export download save file json" },
        { kind: "action", id: "import", name: "Import mappings from a file…", tag: "import", tagClass: "global",
          desc: "Loads an exported JSON file; fields are matched by their path in the target structure", words: "import upload load file json" },
      ]);
      actions.push({ kind: "action", id: "help", name: "Keyboard shortcuts", tag: "help", tagClass: "global",
        desc: "All keys and how to navigate (F1)", words: "help keyboard shortcuts keys navigation hotkeys" });
      if (noTarget) return [{ title: "No target field selected", items: q ? actions.filter((a) => a.words.includes(q.toLowerCase()) || a.name.toLowerCase().includes(q.toLowerCase())) : actions }];
      const tplItems = visibleTemplates().map((t) => ({ kind: "tpl", tpl: t }));
      if (q) {
        const ql = q.toLowerCase();
        const acts = actions.filter((a) => ql.length >= 2 && (a.words.split(" ").some((w) => w.startsWith(ql)) || a.words.includes(ql) || a.name.toLowerCase().includes(ql)));
        const tpls = tplItems.map((it) => ({ it, s: scoreTemplate(q, it.tpl) })).filter((r) => r.s > 0);
        const fnl = fns.map((fn) => ({ it: { kind: "fn", fn }, s: score(q, fn, recent.indexOf(fnKey(fn))) })).filter((r) => r.s > 0);
        const list = tpls.concat(fnl).sort((a, b) => b.s - a.s).slice(0, MAX_RESULTS).map((r) => r.it);
        return [{ title: null, items: acts.concat(list) }];
      }
      const listed = fns.filter((f) => !isConstant(f)); // the constant is pinned to the top instead
      const used = listed.filter((f) => usageCount(f) > 0).sort((a, b) => usageCount(b) - usageCount(a) || byName(a, b));
      const usedSet = new Set(used);
      const rec = recent.map((k) => listed.find((f) => fnKey(f) === k)).filter((f) => f && !usedSet.has(f));
      const recSet = new Set(rec);
      const rest = listed.filter((f) => !usedSet.has(f) && !recSet.has(f)).sort(byName);
      const asFn = (l) => l.map((fn) => ({ kind: "fn", fn }));
      tplItems.sort((a, b) => (a.tpl.scope === b.tpl.scope ? a.tpl.name.localeCompare(b.tpl.name) : a.tpl.scope === "local" ? -1 : 1));
      // With a target field selected, Enter on an empty box adds a constant.
      const constFn = fns.find(isConstant);
      return [
        { title: null, items: constFn ? [{ kind: "fn", fn: constFn }] : [] },
        { title: null, items: actions },
        { title: `Templates (${tplItems.length})`, items: tplItems },
        { title: usageLoading ? "Analysing mapping…" : `Used in this mapping (${used.length})`, items: asFn(used) },
        { title: "Recently used", items: asFn(rec) },
        { title: "All functions", items: asFn(rest) },
      ].filter((s) => s.items.length || (s.title && s.title.startsWith("Analysing")));    }

    function renderItem(it, idx, q) {
      const cls = idx === sel ? "sel" : "";
      if (it.kind === "fn") {
        const fn = it.fn;
        const args = (fn.signature && fn.signature.arguments || []).map((a) => a.displayName || a.name).join(", ");
        const cat = (fn.category && fn.category.displayText) || "";
        const udf = fn.group && fn.group !== "Standard";
        const used = usageCount(fn);
        return `<li role="option" data-i="${idx}" class="${cls}">
          <span class="name">${highlight(fn.displayName || fn.name, q)}<span class="sig">(${esc(args)})</span></span>
          <span class="tags">${used ? `<span class="cnt" title="Used ${used}× in this mapping">×${used}</span>` : ""}<span class="cat${udf ? " udf" : ""}">${esc(cat)}</span></span>
          ${fn.description ? `<span class="desc" title="${esc(fn.description)}">${esc(fn.description)}</span>` : ""}
        </li>`;
      }
      if (it.kind === "tpl") {
        const t = it.tpl;
        const where = t.scope === "global" ? "Global" : "Local";
        const src = (t.sourcePaths || []).length ? ` · ${t.sourcePaths.length} source field${t.sourcePaths.length > 1 ? "s" : ""}` : "";
        const from = t.mappingKey === thisMapping ? "" : ` · from ${t.mappingName}`;
        const desc = ((t.functions || []).join(" → ") || "source only") + src + from + " · Del to delete";
        return `<li role="option" data-i="${idx}" class="${cls}">
          <span class="name">▦ ${highlight(t.name, q)}</span>
          <span class="tags"><span class="cat ${t.scope}">${where} template</span></span>
          <span class="desc" title="${esc(desc)}">${esc(desc)}</span>
        </li>`;
      }
      return `<li role="option" data-i="${idx}" class="${cls}">
        <span class="name">${esc(it.name)}</span>
        <span class="tags">${it.tag ? `<span class="cat ${it.tagClass || "action"}">${esc(it.tag)}</span>` : ""}</span>
        ${it.desc ? `<span class="desc" title="${esc(it.desc)}">${esc(it.desc)}</span>` : ""}
      </li>`;
    }

    function render() {
      const q = mode ? "" : input.value.trim();
      const sections = mode ? [{ title: mode.title || null, items: mode.build ? mode.build(input.value.trim()) : mode.items }] : buildSections(q);
      items = sections.flatMap((s) => s.items);
      sel = Math.min(sel, Math.max(0, items.length - 1));
      if (!items.length) {
        ul.innerHTML = `<div class="empty">${mode ? esc(mode.empty || "") : `No function or template matches “${esc(q)}”`}</div>`;
        return;
      }
      let i = 0;
      ul.innerHTML = sections.map((s) =>
        (s.title ? `<li class="hdr" role="presentation">${esc(s.title)}</li>` : "") +
        s.items.map((it) => renderItem(it, i++, q)).join("")
      ).join("");
      const el = ul.querySelector("li.sel");
      if (el) el.scrollIntoView({ block: "nearest" });
    }

    // Switches the box to a follow-up step (constant value, template name, with/without sources, …).
    function step(opts) {
      mode = opts;
      sel = opts.sel || 0;
      input.value = opts.value || "";
      input.placeholder = opts.placeholder || "";
      input.readOnly = !!opts.readOnly;
      fx.textContent = opts.icon || "fx";
      hint.textContent = opts.hint || "Enter · Esc";
      render();
      input.focus();
      input.select();
    }

    let usageLoading = true;
    loadUsage().then(() => { usageLoading = false; if (host && !mode) render(); });

    function run(label, fn) {
      close();
      Promise.resolve().then(fn).catch((err) => fail("could not " + label, err));
    }

    function askConstantValue(fn) {
      step({
        icon: "“ ”", placeholder: "Constant value" + (targetName ? " for " + targetName : "") + "…",
        hint: "Enter to insert · Esc", items: [], empty: "Type the value and press Enter (leave empty for an empty constant).",
        onEnter: (_, text) => run("insert constant", () => applyFunction(fn, text)),
      });
    }

    function askSaveTemplate() {
      const suggested = saveLabel;
      step({
        icon: "▦", value: suggested, placeholder: "Template name…", hint: "Name, then choose where · Enter · Esc",
        title: "Save template",
        items: [
          { kind: "choice", scope: "local", name: "Save for this mapping (local)", tag: "Local", tagClass: "local",
            desc: "Only offered in " + mappingName() },
          { kind: "choice", scope: "global", name: "Save for all mappings (global)", tag: "Global", tagClass: "global",
            desc: "Offered in every message mapping, inserted without source fields outside this mapping" },
        ],
        onEnter: (it, text) => run("save template", async () => {
          const t = await saveTemplate(text.trim() || suggested, it.scope, saveSource);
          toast(`Mapping Toolkit: template “${t.name}” saved (${t.scope}).`);
        }),
      });
    }

    // Default is to add the template unconnected, so several templates can be combined in one mapping.
    function askInsertTemplate(tpl) {
      const sameMapping = tpl.mappingKey === thisMapping;
      const hasSources = sameMapping && (tpl.sourcePaths || []).length > 0;
      const srcNames = (tpl.sourcePaths || []).map((p) => p.split("/").pop()).join(", ");
      const connectVerb = targetMapping ? "Replace mapping of " + targetName + " with it" : "Connect it to " + targetName;
      const variants = hasSources ? [[true, " – with source mappings"], [false, " – without source mappings"]] : [[false, ""]];
      const choices = [];
      variants.forEach(([src, suffix]) => choices.push({ kind: "choice", connect: false, sources: src,
        name: "Add to the mapping, not connected" + suffix, tag: "add", tagClass: "local",
        desc: src ? "Source fields: " + srcNames : "Wire it up yourself – you can add more templates next to it" }));
      variants.forEach(([src, suffix]) => choices.push({ kind: "choice", connect: true, sources: src,
        name: connectVerb + suffix, tag: targetMapping ? "replace" : "connect", tagClass: "action",
        desc: src ? "Source fields: " + srcNames : (tpl.functions || []).join(" → ") }));
      step({
        icon: "▦", value: tpl.name, readOnly: true, hint: "↑↓ Enter · Esc",
        title: "Insert template" + (!sameMapping && (tpl.sourcePaths || []).length ? " (from " + tpl.mappingName + ", without source fields)" : ""),
        items: choices,
        onEnter: (it) => run("insert template", () => it.connect ? applyTemplate(tpl, it.sources) : addTemplateUnconnected(tpl, it.sources)),
      });
    }

    // Step 1: pick the source field (type to filter, arrows to move). Step 2: pick the input it goes to.
    function askSourceField() {
      if (readOnly || !target) { toast("Mapping Toolkit: select a target field in an editable mapping first."); return close(); }
      let entries;
      try { entries = sourceEntries(ctx); } catch (err) { close(); return fail("could not read the source structure", err); }
      const used = new Set((targetMapping && targetMapping.sourcePaths) || []);
      const current = getSelectedSourcePath(ctx);
      const depthOf = (e) => e.xpath.split("/").filter(Boolean).length - 1;
      const toItem = (e) => ({ kind: "choice", entry: e, name: "  ".repeat(Math.max(0, depthOf(e))) + e.name,
        tag: used.has(e.xpath) ? "used" : "", tagClass: "local", desc: e.xpath });
      const startAt = Math.max(0, entries.findIndex((e) => e.xpath === current));
      step({
        icon: "→", placeholder: "Source field for " + targetName + " – type to filter…", hint: "↑↓ Enter · Esc",
        title: "Add source field", sel: startAt, empty: "No source field matches.",
        build: (q) => {
          const ql = q.toLowerCase();
          const list = ql ? entries.filter((e) => e.xpath.toLowerCase().includes(ql))
            .sort((a, b) => (b.name.toLowerCase().startsWith(ql) ? 1 : 0) - (a.name.toLowerCase().startsWith(ql) ? 1 : 0)) : entries;
          return list.slice(0, 400).map(toItem);
        },
        onEnter: (it) => { if (it) askSourceSlot(it.entry); },
      });
    }

    function askSourceSlot(entry) {
      const slots = targetMapping ? freeInputs(ctx, targetMapping, targetName) : [];
      // Preferred: move a selection box over the mapping on the canvas.
      if (slots.some((s) => s.rect) && getCanvas()) {
        close();
        pickInputOnCanvas(slots, entry).then((c) => {
          if (c === undefined) return;
          if (c === "none") return toast("Mapping Toolkit: the mapping is not visible – could not show the selection.");
          runAction("add source field", () => addSourceField(entry, c));
        });
        return;
      }
      const choices = slots.map((s) => ({ kind: "choice", slot: s,
        name: s.isDst ? "Connect to " + targetName : "Connect to " + s.arg + " of " + s.title,
        tag: s.isDst ? "target" : "input", tagClass: s.isDst ? "action" : "local",
        desc: s.isDst ? "The field takes " + entry.name + " directly" : entry.name + " feeds " + s.title + ", input " + (s.index + 1) }));
      if (!targetMapping) choices.push({ kind: "choice", slot: { toTarget: true }, name: "Connect to " + targetName, tag: "target", tagClass: "action",
        desc: "The field is not mapped yet – it takes " + entry.name + " directly" });
      choices.push({ kind: "choice", slot: null, name: "Add to the mapping, not connected", tag: "add", tagClass: "local",
        desc: "Wire it up yourself" });
      step({
        icon: "→", value: entry.name, readOnly: true, hint: "↑↓ Enter · Esc", title: "Where should " + entry.name + " go?", items: choices,
        onEnter: (it) => { if (it) run("add source field", () => addSourceField(entry, it.slot)); },
      });
    }

    function askHelp() {
      const row = (keys, name, desc) => ({ kind: "choice", name, tag: keys, tagClass: "action", desc });
      step({
        icon: "?", value: "", readOnly: true, placeholder: "Keyboard shortcuts", hint: "Enter or Esc to close", title: "Keyboard shortcuts",
        items: [
          row("Space", "Open this box", "For the selected target field, when you are not typing in a field"),
          row("Ctrl+Space", "Open this box (always works)", "Also closes it again"),
          row("Alt+S", "Add a source field", "Pick the field, then move the selection box on the canvas to the input"),
          row("Tab / Shift+Tab", "Switch between source, target and mapping expression", "Outside the box; the active part is outlined in blue"),
          row("← ↑ ↓ →  Tab", "Move the selection box", "On the canvas, after picking a source field or a function in a mapped field; Enter places it, Esc cancels"),
          row("Ctrl+Shift+F", "Format the selected mapping", "Arranges sources, functions and the target field in order"),
          row("↑ ↓  PgUp PgDn", "Move through the list", "In this box and in the source field picker"),
          row("Enter", "Choose / insert", "Goes to the next step where there is one"),
          row("Del", "Delete the selected template", "In the list, on a template"),
          row("Del", "Delete the box you clicked", "On the canvas: a function, constant or source field (not the target field)"),
          row("F1", "Show this list", "Inside the box"),
          row("Esc", "Close / cancel", ""),
        ],
        onEnter: () => close(),
      });
    }

    function askImport() {
      step({
        icon: "⇪", value: "", readOnly: true, placeholder: "Import mappings", hint: "↑↓ Enter · Esc", title: "Import mappings from a file",
        items: [
          { kind: "choice", replace: true, name: "Import all – overwrite fields that are already mapped", tag: "overwrite", tagClass: "action",
            desc: "Every field in the file replaces the mapping it has here" },
          { kind: "choice", replace: false, name: "Import only into fields that are not mapped yet", tag: "keep existing", tagClass: "local",
            desc: "Fields that already have a mapping here are left as they are" },
        ],
        onEnter: (it) => {
          const picked = pickFile(); // must start inside the key press / click
          close();
          runAction("import mappings", async () => {
            const file = await picked;
            if (!file) { toast("Mapping Toolkit: import cancelled – no file chosen."); return; }
            toast(`Mapping Toolkit: importing ${file.name}…`);
            console.info("[CI Mapping Toolkit] importing", file.name, it.replace ? "(overwrite)" : "(only unmapped)");
            const r = await importMappings(file, it.replace);
            console.info("[CI Mapping Toolkit] import result", r);
            toast(`Mapping Toolkit: import done – ${r.added} fields added, ${r.replaced} overwritten, ${r.kept} already mapped and left unchanged` +
              (r.noTarget ? `, ${r.noTarget} not in this target structure` : "") +
              (r.missingSources ? `, ${r.missingSources} use source fields missing here` : "") + ".");
          });
        },
      });
    }

    function askDeleteTemplate(tpl) {
      step({
        icon: "▦", value: tpl.name, readOnly: true, hint: "Enter · Esc", title: "Delete template",
        items: [
          { kind: "choice", del: true, name: "Delete template “" + tpl.name + "”", tag: tpl.scope, tagClass: tpl.scope },
          { kind: "choice", del: false, name: "Keep it" },
        ],
        onEnter: (it) => it.del ? run("delete template", async () => { await deleteTemplate(tpl); toast(`Mapping Toolkit: template “${tpl.name}” deleted.`); }) : close(),
      });
    }

    function choose(i) {
      const it = items[i];
      if (mode) { if (mode.onEnter) mode.onEnter(it, input.value); return; }
      if (!it) return;
      if (it.kind === "action" && it.id === "help") return askHelp();
      if (it.kind === "action" && it.id === "addSource") return askSourceField();
      if (it.kind === "action" && it.id === "save") return askSaveTemplate();
      if (it.kind === "action" && it.id === "format") return run("format mapping", formatSelected);
      if (it.kind === "action" && it.id === "formatAll") {
        return run("format mappings", () => toast(`Mapping Toolkit: formatted ${formatAll()} mappings.`));
      }
      if (it.kind === "action" && it.id === "export") {
        return run("export mappings", () => toast(`Mapping Toolkit: exported ${exportMappings()} mappings.`));
      }
      if (it.kind === "action" && it.id === "import") return askImport();
      if (it.kind === "tpl") return askInsertTemplate(it.tpl);
      if (it.kind === "fn") {
        if (isConstant(it.fn)) return askConstantValue(it.fn);
        run("insert " + (it.fn.displayName || it.fn.name), () => applyFunction(it.fn));
      }
    }

    input.addEventListener("input", () => { if (mode && !mode.build) return; sel = 0; render(); });
    input.addEventListener("keydown", (e) => {
      const n = items.length;
      if (e.key === "ArrowDown") { sel = Math.min(n - 1, sel + 1); render(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
      else if (e.key === "PageDown") { sel = Math.min(n - 1, sel + 8); render(); e.preventDefault(); }
      else if (e.key === "PageUp") { sel = Math.max(0, sel - 8); render(); e.preventDefault(); }
      else if (e.key === "Enter") { choose(sel); e.preventDefault(); }
      else if (e.key === "Delete" && !mode && items[sel] && items[sel].kind === "tpl") { askDeleteTemplate(items[sel].tpl); e.preventDefault(); }
      else if (e.key === "F1") { askHelp(); e.preventDefault(); }
      else if (e.key === "Escape" || (e.key === " " && e.ctrlKey)) { close(); e.preventDefault(); }
    });
    ul.addEventListener("mousemove", (e) => {
      const li = e.target.closest("li[data-i]");
      if (li && +li.dataset.i !== sel) { sel = +li.dataset.i; ul.querySelectorAll("li[data-i]").forEach((x) => x.classList.toggle("sel", +x.dataset.i === sel)); }
    });
    ul.addEventListener("click", (e) => { const li = e.target.closest("li[data-i]"); if (li) { sel = +li.dataset.i; choose(sel); } });

    render();
    input.focus();
    if (readOnly) {
      const inFlow = /\/integrationflows\//.test(location.pathname);
      step({
        icon: "✎", value: "", readOnly: true, placeholder: "The mapping is read-only", hint: "Enter · Esc", title: "Edit mode",
        items: [{ kind: "choice", name: "Switch " + (inFlow ? "the integration flow" : "the mapping") + " to Edit mode", tag: "edit", tagClass: "action",
          desc: inFlow ? "Presses Edit on the integration flow and opens this mapping again in Edit mode" : "Presses Edit" }],
        onEnter: () => run("switch to Edit mode", switchToEditMode),
      });
    } else if (opts.startSource) askSourceField();
    else if (opts.startSave && saveAction.length) askSaveTemplate();
  }

  // ---------- toolbar button next to Simulate ----------
  // The logo is embedded so the page never loads a chrome-extension:// URL.
  const ICON_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAADoklEQVR4nO1aSWgTURj+ZibNRmJrk7bWakyLG0WsO3iIIC4Vq6AiiAhuIO1BCj1IFUWqF0FFUKlVQSsoHhREUDyoICooUqopqFSwrV3U2NaaLk6apJPxoJnpm06meQltEsl3yvv/lzffN//y3mTCQAPmyiZRyz9Z4C+UMJF8qo5kIa6EmhDCkKzElRgthA1/SBXyAMmV1ZqYCmCB1Lr7YYQ5p3wEmFS8+6OR8hFIC0g00gISDV28C1gMLCpW2VG2YArm5RlgNXJg/230Az4B0498gDiBfS4uAYU2PR4dLIIjW6/qf9fpm1DyQJwpVL/HEZE8ALzt9MWzfFSIOQKu2RYsn2UmbHUvenHy0Q8M+IS4iUWLmCOwodhKjIWQOOnkgTgELHGYiPGnH/5JJw9QnoWK841oODw3qrnHH3iwdr4Fq+ZYJFvP4AiKTzaDD4Qkm92iw7Oq2Siyy7XU2hvAuvMt8AwEx70OVQSWKXJeC40dPI7c/050oRyrDuUumzQ261ncK3cS5L96gyirbY2KPEApQFm0kSCKfzuQu8uHO41ewle1JgcWAwuOZXBzrwNLHfKaPYMjKKttRUdfIGpOMR2nT23JR+XqHGk8EhKRe+g9/CNjl3Jk6+E+Og8Gnfz4XfPQg1k2PfatzJZsXl5A6cUWvP82TMUlpiJePJMs4GaPX5U8AHT0BVD3vJewHduYR5Af8oew5XIbNXkgRgELC0gBTV3aG9bpJ934xcsdSsfK0fAFQ9h+tQ0N7XwsVOgFFNn1yDRxhM09joB+n4CzT7tVfbuut+Pl59+0NCRQC1g0wzTGNl4EMk0cdizNUvVNMXKq9mhBLaBEIUAUtQVYDCzuVxSOSbswajZNIwqcFvQRUBRwS68fQ/6Q6lxjBoO7B5xY4ZRbpWcgiIAgF7zTpke5y05LQwJ9BBR3MlL+Z3AMbu93Ejuxlxew+VIbbrzuI+ZWr8/FVHNsqUQloCArAzlW8gCrlj4cy6B+twOlow58fCCEbVfa8PH7MM487ibabpaZQ3VpHi13AJQC1ArYrTjzMwxQt3MGti7KlGxBQcTOa+148+Vvq/zWH8T1Vz+J75W7bCi0RX62iAQqAcoCBoCmLnLzObe9ALtWTJXGIRE4cKsTT5sHiXlnn/RgOChHQc8xOLF5Gg0dAOlf5hKPtIBEIy0g0UgLSDRYrZfIyQ7+QgmT+hEAtF/lJyvCnP+PCACpFYXRXP+vP3sokSxCtLLjD+F+NDF+W1PxAAAAAElFTkSuQmCC";

  function addToolbarButton() {
    const els = allElements();
    const headers = els.filter((e) => /--mappingPageHeaderTitle$/.test(e.getId && e.getId()) && e.insertAction);
    headers.forEach((h) => {
      const id = h.getId() + "-cpiQuickFunction";
      if (sap.ui.getCore().byId(id)) return;
      const Button = (sap.uxap && sap.uxap.ObjectPageHeaderActionButton) || (sap.m && sap.m.Button);
      if (!Button) return;
      const btn = new Button(id, {
        icon: ICON_URL, text: "Mapping Toolkit", hideText: false, type: "Transparent",
        tooltip: "CI Mapping Toolkit (Space / Ctrl+Space): functions, constants, templates, format, export/import\nAlt+S add source field · Ctrl+Shift+F format · F1 in the box: all keys",
        press: () => open(),
      });
      const acts = h.getActions();
      const sim = acts.findIndex((a) => /Simulate/i.test(a.getId()) || (a.getText && a.getText() === "Simulate"));
      h.insertAction(btn, sim >= 0 ? sim : 0);
    });
  }
  setInterval(() => {
    try { addToolbarButton(); } catch (_) { /* editor not ready */ }
    try { addCanvasMenuActions(); } catch (_) { /* editor not ready */ }
    try { guardSave(); } catch (_) { /* editor not ready */ }
  }, 2000);

  // Ctrl+Shift+F: format the mapping of the selected target field.
  function formatShortcut() {
    const ctx = getContext();
    if (!ctx.viewer || !ctx.controller) return false;
    if (host) close();
    if (!isEditMode(ctx)) { toast("Mapping Toolkit: the mapping is read-only – press Space to switch to Edit mode."); return true; }
    const target = getSelectedTarget(ctx);
    if (!target || !getMappingOf(ctx, target.xpath)) { toast("Mapping Toolkit: select a mapped target field to format."); return true; }
    try { formatSelected(); toast("Mapping Toolkit: formatted " + target.name + "."); }
    catch (err) { fail("could not format", err); }
    return true;
  }

  // Plain Space may open the box only when it would not type or press anything: focus must not be in a text
  // field, code editor, button, link or checkbox, and a message mapping must be showing.
  const NO_SPACE_SEL = "input, textarea, select, button, a[href], [contenteditable=''], [contenteditable='true'], " +
    "[role='textbox'], [role='combobox'], [role='button'], [role='checkbox'], [role='radio'], [role='switch'], [role='menuitem'], .ace_editor";
  function typingInField() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return !!(el && el !== document.body && el.closest && el.closest(NO_SPACE_SEL));
  }
  function spaceMayOpen() {
    if (typingInField()) return false;
    const ctx = getContext();
    return !!(ctx.viewer && ctx.editor);
  }

  // ---------- Tab cycles source structure → target structure → mapping expression ----------
  function paneElements(ctx) {
    const dom = (t) => { try { return t && t.getDomRef && t.getDomRef(); } catch (_) { return null; } };
    let src = null, tgt = null;
    try { src = dom(ctx.viewer._getSourceTable()); } catch (_) { /* older/newer editor */ }
    try { tgt = dom(ctx.viewer._getTargetTable()); } catch (_) { /* older/newer editor */ }
    return [
      { id: "source", label: "Source structure", el: src },
      { id: "target", label: "Target structure", el: tgt },
      { id: "expression", label: "Mapping expression", el: getCanvas() },
    ].filter((p) => p.el && p.el.isConnected && p.el.offsetWidth > 0);
  }

  function paneOfNode(panes, node) {
    while (node && node.nodeType !== 1) node = node.parentNode || node.host;
    return panes.find((p) => p.el.contains(node)) || null;
  }

  let paneBadge = null;
  let paneBadgeTimer = null;
  let lastOutlined = null;
  function outlinePane(pane) {
    if (lastOutlined && lastOutlined !== (pane && pane.el)) lastOutlined.style.outline = "";
    lastOutlined = pane ? pane.el : null;
    if (!pane) return;
    Object.assign(pane.el.style, { outline: "2px solid #0a6ed1", outlineOffset: "-2px" });
    if (!paneBadge) {
      paneBadge = document.createElement("div");
      Object.assign(paneBadge.style, { position: "fixed", zIndex: 2147483645, pointerEvents: "none", background: "#0a6ed1", color: "#fff",
        padding: "2px 10px", borderRadius: "0 0 6px 0", font: '12px "72", Arial, sans-serif' });
      document.body.appendChild(paneBadge);
    }
    const r = pane.el.getBoundingClientRect();
    paneBadge.textContent = pane.label + "  ·  Tab: next";
    Object.assign(paneBadge.style, { left: r.left + "px", top: r.top + "px", display: "block" });
    clearTimeout(paneBadgeTimer);
    paneBadgeTimer = setTimeout(() => { if (paneBadge) paneBadge.style.display = "none"; }, 1800);
  }

  function focusPane(pane) {
    const el = pane.el;
    let f = null;
    if (pane.id !== "expression") {
      // UI5 tables keep the current cell at tabindex 0; prefer the selected row.
      f = el.querySelector("tr.sapUiTableRowSel [tabindex='0'], tr.sapUiTableRowSel [tabindex]") || el.querySelector("[tabindex='0']") || el.querySelector("[tabindex]");
    }
    if (!f) { if (el.tabIndex < 0 && !el.hasAttribute("tabindex")) el.tabIndex = -1; f = el; }
    f.focus({ preventScroll: true });
    outlinePane(pane);
  }

  // Tab / Shift+Tab. Returns true when the key was used.
  function cyclePanes(back) {
    if (host || pickerActive || typingInField()) return false;
    const ctx = getContext();
    if (!ctx.viewer || !ctx.editor) return false;
    const panes = paneElements(ctx);
    if (panes.length < 2) return false;
    const from = paneOfNode(panes, document.activeElement) || paneOfNode(panes, lastPaneClick);
    if (!from && document.activeElement && document.activeElement !== document.body) return false; // focus is somewhere else on the page
    const i = from ? panes.indexOf(from) : (back ? 0 : -1);
    focusPane(panes[(i + (back ? -1 : 1) + panes.length) % panes.length]);
    return true;
  }

  // Keep the outline in step with clicks and focus that did not come from Tab.
  let lastPaneClick = null;
  document.addEventListener("mousedown", (e) => { lastPaneClick = e.target; }, true);
  document.addEventListener("focusin", (e) => {
    try {
      if (host) return;
      const ctx = getContext();
      if (!ctx.viewer) return;
      outlinePane(paneOfNode(paneElements(ctx), e.target));
    } catch (_) { /* editor not ready */ }
  }, true);
  document.addEventListener("mouseup", () => {
    try {
      if (host) return;
      const ctx = getContext();
      if (!ctx.viewer) return;
      const p = paneOfNode(paneElements(ctx), lastPaneClick);
      if (p) outlinePane(p);
    } catch (_) { /* editor not ready */ }
  }, true);

  // Delete: remove the box last clicked on the canvas (a function, constant or source field – never the target field).
  function deleteClickedNode() {
    if (host || pickerActive || typingInField()) return false;
    const ctx = getContext();
    if (!ctx.viewer || !ctx.editor || !ctx.renderer || !isEditMode(ctx)) return false;
    const node = getClickedNode(ctx, 0); // the click has to be on the box itself
    if (!node) return false;
    const expr = getExpression(ctx);
    delete expr.nodes[node.id];
    expr.connections = (expr.connections || []).filter((c) => c.fromId !== node.id && c.toId !== node.id);
    lastCanvasClick = null;
    commit(ctx, expr);
    toast("Mapping Toolkit: deleted " + (node.name || node.key || "the box") + ".");
    return true;
  }

  window.addEventListener("keydown", (e) => {
    if (!host && e.key === " " && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && !e.repeat && spaceMayOpen()) {
      e.preventDefault();
      e.stopPropagation();
      open();
      return;
    }
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      try { if (cyclePanes(e.shiftKey)) { e.preventDefault(); e.stopPropagation(); } } catch (err) { fail("could not switch", err); }
      return;
    }
    if (e.key === "Delete" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      try { if (deleteClickedNode()) { e.preventDefault(); e.stopPropagation(); } } catch (err) { fail("could not delete", err); }
      return;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyS") {
      // Alt+S: add a source field to the selected target field's mapping (works from anywhere in the mapping editor).
      const c = getContext();
      if (c.viewer && c.editor) { e.preventDefault(); e.stopPropagation(); open({ startSource: true }); }
      return;
    }
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.code === "KeyF" || e.key === "F" || e.key === "f")) {
      if (formatShortcut()) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && (e.code === "Space" || e.key === " ")) {
      if (host) return; // handled inside the box
      // Only act in the mapping editor, so Ctrl+Space autocomplete keeps working in e.g. the script editor.
      if (!/\.mmap|mapping/i.test(location.href) && !findPalette()) {
        console.info("[CI Mapping Toolkit] Ctrl+Space ignored: no mapping editor / function palette found");
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      open();
    }
  }, true);
})();
