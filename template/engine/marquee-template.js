/*
 * marquee-template.js — the session board template SHIM (the public contract: TEMPLATE.md in the cartridge specification).
 *
 * Ships in every template package as engine/marquee-template.js, beside the vendored
 * nunjucks (engine/nunjucks.js, 3.2.4, BSD-2). It is the only code a template must call
 * and the only code a host must talk to:
 *
 *   host → page   marquee.configure({ host })            once, optional (default "browser")
 *                 marquee.update(document)               one DATA DOCUMENT per render
 *   page → host   { type: "ready",    missingFonts, layouts, engine, data }
 *                 { type: "rendered", page, pageCount, renderMode }
 *                 { type: "error",    message, layout? }
 *                 { type: "log",      message }
 *                 — posted to window.webkit.messageHandlers.marquee when it exists,
 *                   and always dispatched as a CustomEvent("marquee", { detail }) on window.
 *
 * The page's shape (§5.3): a mount <div id="marquee-root"> and one template source per
 * layout, raw text the HTML parser does not touch:
 *   template.json: "layouts": { "now-next": { "source": "layouts/now-next.html", "style": "layouts/now-next.css" }, … }
 *   — each layout's nunjucks source is a FILE the shim fetches from the package at load (engine 1.2);
 *   a layout's optional "style" is linked into the page. Inline <script> sources are not read.
 * The manifest (template.json) is read from <script type="application/json"
 * id="marquee-manifest"> when the page inlines it (preview.html), else fetched from
 * ./template.json (a host serves the package folder). Fonts are written as @font-face
 * from the manifest's faces (§5.7); colours and the canvas as CSS custom properties and
 * classes on <html> (§5.4, §5.6). The shim never pages, never filters, never reads a
 * clock: it renders what it is given.
 *
 * Runs as a classic script in a page; its pure parts are exported for Node tests.
 */
(function (global) {
  "use strict";

  var ENGINE_FORMAT = "1.3";
  var DATA_FORMAT = "1.2";
  var MOUNT_ID = "marquee-root";
  var MANIFEST_ID = "marquee-manifest";
  var FONT_STYLE_ID = "marquee-fonts";

  // ── the canvas (§5.4) ──────────────────────────────────────────────────────

  var ASPECTS = [["9x16", 9 / 16], ["16x9", 16 / 9], ["3x4", 3 / 4], ["4x3", 4 / 3], ["1x1", 1]];
  var ASPECT_TOLERANCE = 0.10;

  /** The nearest of the six aspect families, "other" when none is within 10 %. */
  function aspectFamily(width, height) {
    if (!(width > 0) || !(height > 0)) return "other";
    var ratio = width / height, best = null;
    for (var i = 0; i < ASPECTS.length; i++) {
      var d = Math.abs(ratio - ASPECTS[i][1]) / ASPECTS[i][1];
      if (d <= ASPECT_TOLERANCE && (best === null || d < best.d)) best = { name: ASPECTS[i][0], d: d };
    }
    return best ? best.name : "other";
  }

  function orientationOf(width, height) {
    if (width > height) return "landscape";
    if (height > width) return "portrait";
    return "square";
  }

  function sizeTier(width, height) {
    var long = Math.max(width, height);
    if (long >= 3840) return "uhd";
    if (long >= 1920) return "fhd";
    if (long >= 1280) return "hd";
    return "small";
  }

  /** The classes and custom properties a canvas puts on <html>. Pure. */
  function canvasPresentation(canvas) {
    var width = Number(canvas && canvas.width) || 0, height = Number(canvas && canvas.height) || 0;
    var host = (canvas && typeof canvas.host === "string" && canvas.host) || "browser";
    var classes = [
      "marquee-" + orientationOf(width, height),
      "marquee-aspect-" + aspectFamily(width, height),
      "marquee-size-" + sizeTier(width, height),
      "marquee-host-" + host
    ];
    var scale = Math.max(width, height) > 0 ? Math.max(width, height) / 3840 : 1;
    var properties = {
      "--marquee-canvas-width": width + "px",
      "--marquee-canvas-height": height + "px",
      "--marquee-scale": String(Math.round(scale * 10000) / 10000)
    };
    return { classes: classes, properties: properties };
  }

  // ── modifiers (Modifiers-Proposal.md): the automatic set and the declared set ──

  var MODIFIER_ID = /^[a-z0-9-]{1,32}$/;

  /** The automatic classes beyond the canvas's: the ink, the layout, a projected clock. Pure. */
  function automaticClasses(doc) {
    var out = [];
    var ink = doc && doc.brand && doc.brand.ink === "onLight" ? "light" : "dark";
    out.push("marquee-ink-" + ink);
    var layout = doc && doc.board && typeof doc.board.renderMode === "string" ? doc.board.renderMode : "";
    if (/^[a-z0-9-]+$/.test(layout)) out.push("marquee-layout-" + layout);
    if (doc && doc.clock && doc.clock.projected === true) out.push("marquee-projected");
    return out;
  }

  /** The declared modifiers resolved against the manifest: { name: value } with every default
   *  filled, a value that is not an option (or not a boolean) falling back to the default. Pure. */
  function resolveModifiers(manifest, values) {
    var declared = (manifest && manifest.modifiers) || {};
    var given = values || {};
    var out = {}, warnings = [];
    Object.keys(declared).forEach(function (name) {
      var spec = declared[name] || {};
      if (!MODIFIER_ID.test(name) || name.indexOf("marquee") === 0) { warnings.push("modifier \"" + name + "\" has a name the shim will not put in a class"); return; }
      var value = given[name];
      if (spec.kind === "toggle") {
        if (typeof value !== "boolean") { if (value !== undefined) warnings.push("modifier " + name + ": " + JSON.stringify(value) + " is not a boolean — the default applies"); value = spec["default"] === true; }
        out[name] = value;
      } else {
        var options = Array.isArray(spec.options) ? spec.options.filter(function (o) { return typeof o === "string" && MODIFIER_ID.test(o); }) : [];
        if (typeof value !== "string" || options.indexOf(value) === -1) {
          if (value !== undefined) warnings.push("modifier " + name + ": " + JSON.stringify(value) + " is not one of " + options.join(", ") + " — the default applies");
          value = typeof spec["default"] === "string" && options.indexOf(spec["default"]) !== -1 ? spec["default"] : options[0];
        }
        if (value !== undefined) out[name] = value;
      }
    });
    return { modifiers: out, warnings: warnings };
  }

  /** The `mod-*` classes for resolved modifiers. Pure. */
  function modifierClasses(manifest, resolved) {
    var declared = (manifest && manifest.modifiers) || {};
    var out = [];
    Object.keys(resolved || {}).forEach(function (name) {
      var spec = declared[name] || {};
      var value = resolved[name];
      if (spec.kind === "toggle") { if (value === true) out.push("mod-" + name); }
      else if (typeof value === "string") out.push("mod-" + name + "-" + value);
    });
    return out;
  }

  // ── colours (§5.6) ─────────────────────────────────────────────────────────

  var HEX = /^#[0-9A-Fa-f]{6}$/;

  function kebab(name) {
    return String(name).replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  }

  /** The custom properties a document's roles, brand and ink set on :root. Pure. */
  function colourProperties(doc) {
    var out = {};
    var roles = (doc && doc.roles) || {};
    Object.keys(roles).forEach(function (role) {
      if (HEX.test(roles[role])) out["--marquee-role-" + kebab(role)] = roles[role];
    });
    var brand = (doc && doc.brand) || {};
    var palette = brand.palette || {};
    Object.keys(palette).forEach(function (slot) {
      if (HEX.test(palette[slot])) out["--marquee-palette-" + kebab(slot)] = palette[slot];
    });
    var text = brand.text || {};
    Object.keys(text).forEach(function (key) {
      if (HEX.test(text[key])) out["--marquee-text-" + kebab(key)] = text[key];
    });
    var ink = brand.ink === "onLight" ? "onLight" : "onDark";
    if (HEX.test(text[ink])) out["--marquee-ink"] = text[ink];
    var muted = ink === "onLight" ? text.mutedOnLight : text.mutedOnDark;
    if (HEX.test(muted)) out["--marquee-ink-muted"] = muted;
    return out;
  }

  // ── fonts (§5.7) ──────────────────────────────────────────────────────────

  /** The @font-face rules for a manifest's fonts. Pure. */
  function fontFaceCSS(manifest, base) {
    var fonts = (manifest && manifest.fonts) || [];
    var rules = [];
    fonts.forEach(function (font) {
      var faces = font.faces || [];
      faces.forEach(function (face) {
        if (!face || typeof face.file !== "string") return;
        var url = (base || "") + face.file;
        var format = /\.woff2$/i.test(face.file) ? "woff2" : /\.woff$/i.test(face.file) ? "woff" : null;
        rules.push(
          "@font-face{font-family:" + JSON.stringify(font.cssFamily) +
          ";font-weight:" + (face.weight || 400) +
          ";font-style:" + (face.style || "normal") +
          ";font-display:block;src:url(" + JSON.stringify(url) + ")" + (format ? " format(" + JSON.stringify(format) + ")" : "") + "}"
        );
      });
    });
    return rules.join("\n");
  }

  // ── filters (the kit's words, in the venue zone; the document carries the zone) ──

  function partsIn(ms, zone) {
    var f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour12: false, hour: "numeric", minute: "numeric" });
    var parts = {};
    f.formatToParts(new Date(ms)).forEach(function (p) { parts[p.type] = p.value; });
    return { hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
  }

  /** "8:30 a.m." — the kit's timeString. */
  function timeString(ms, zone) {
    var p = partsIn(ms, zone);
    var h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
    return h12 + ":" + String(p.minute).padStart(2, "0") + " " + (p.hour < 12 ? "a.m." : "p.m.");
  }

  /** "Wednesday, October 7" — the kit's dateLine. */
  function dateLine(ms, zone) {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long", month: "long", day: "numeric" }).format(new Date(ms));
  }

  // ── state ─────────────────────────────────────────────────────────────────

  var state = {
    host: "browser",
    manifest: null,
    document: null,
    env: null,
    templates: {},      // layout → compiled nunjucks Template
    layouts: [],
    mount: null,
    manual: false,
    ready: false,
    missingFonts: [],
    modifiers: {}
  };
  var listeners = {};

  function on(type, fn) { (listeners[type] = listeners[type] || []).push(fn); return api; }
  function off(type, fn) { listeners[type] = (listeners[type] || []).filter(function (f) { return f !== fn; }); return api; }
  function emit(type, payload) {
    (listeners[type] || []).slice().forEach(function (fn) { try { fn(payload); } catch (e) { report("error", { message: "listener for " + type + ": " + (e && e.message) }); } });
  }

  function post(message) {
    try {
      var wk = global.webkit && global.webkit.messageHandlers && global.webkit.messageHandlers.marquee;
      if (wk && typeof wk.postMessage === "function") wk.postMessage(message);
    } catch (e) { /* the host is not WebKit */ }
    try {
      if (typeof global.dispatchEvent === "function" && typeof global.CustomEvent === "function") {
        global.dispatchEvent(new global.CustomEvent("marquee", { detail: message }));
      }
    } catch (e) { /* no DOM */ }
  }

  function report(type, fields) {
    var message = Object.assign({ type: type }, fields || {});
    post(message);
    emit(type, message);
    return message;
  }

  function log(message) { report("log", { message: String(message) }); }

  // ── nunjucks ──────────────────────────────────────────────────────────────

  function nunjucksLib() {
    if (global.nunjucks) return global.nunjucks;
    if (typeof require === "function") { try { return require("./nunjucks.js"); } catch (e) { /* not here */ } }
    return null;
  }

  function makeEnvironment() {
    var nunjucks = nunjucksLib();
    if (!nunjucks) throw new Error("nunjucks is not loaded — engine/nunjucks.js must come before engine/marquee-template.js");
    var env = new nunjucks.Environment(null, { autoescape: true, throwOnUndefined: false, trimBlocks: true, lstripBlocks: true });
    env.addFilter("time", function (ms) {
      var zone = state.document && state.document.clock && state.document.clock.zone;
      return typeof ms === "number" && zone ? timeString(ms, zone) : "";
    });
    env.addFilter("date", function (ms) {
      var zone = state.document && state.document.clock && state.document.clock.zone;
      return typeof ms === "number" && zone ? dateLine(ms, zone) : "";
    });
    env.addFilter("role", function (name) {
      var roles = (state.document && state.document.roles) || {};
      return HEX.test(roles[name]) ? roles[name] : "";
    });
    return env;
  }

  /** Compiles template sources by layout. `sources` is { layout: text }. */
  function compileAll(sources, env) {
    var compiled = {}, errors = [];
    var nunjucks = nunjucksLib();
    Object.keys(sources).forEach(function (layout) {
      try {
        compiled[layout] = nunjucks.compile(sources[layout], env);
        compiled[layout].compile(); // surface syntax errors now, not at the first render
      } catch (e) {
        errors.push({ layout: layout, message: String(e && e.message || e) });
      }
    });
    return { templates: compiled, errors: errors };
  }

  /** Renders one document's layout to an HTML string with compiled templates. */
  function renderHTML(templates, doc, modifiers) {
    var layout = doc && doc.board && doc.board.renderMode;
    var template = templates[layout];
    if (!template) throw new Error("this template has no \"" + layout + "\" layout (it offers: " + Object.keys(templates).join(", ") + ")");
    // The context: the document, with the RESOLVED modifiers in place of what the host sent.
    var context = Object.assign({}, doc, { modifiers: modifiers || (doc && doc.modifiers) || {} });
    return template.render(context);
  }

  // ── the page ──────────────────────────────────────────────────────────────

  /** The layout sources the manifest names, fetched from the package: { layout: text }. A source
   *  that cannot be fetched is reported as that layout's error and left out. */
  function loadSources(manifest) {
    var layouts = manifest && manifest.layouts;
    if (!layouts || typeof layouts !== "object" || Array.isArray(layouts)) {
      report("error", { message: "template.json declares no layouts (an object of { source, style? } per layout)" });
      return Promise.resolve({});
    }
    if (typeof global.fetch !== "function") return Promise.resolve({});
    var out = {};
    return Promise.all(Object.keys(layouts).map(function (layout) {
      var spec = layouts[layout] || {};
      if (typeof spec.source !== "string") { report("error", { layout: layout, message: "layouts." + layout + " names no source file" }); return null; }
      return global.fetch(spec.source, { cache: "no-store" })
        .then(function (r) { if (!r.ok) throw new Error(spec.source + ": HTTP " + r.status); return r.text(); })
        .then(function (text) { out[layout] = text; })
        .catch(function (e) { report("error", { layout: layout, message: "the \"" + layout + "\" layout's source was not loaded (" + String(e && e.message || e) + ")" }); });
    })).then(function () { return out; });
  }

  /** Links each layout's own stylesheet (manifest layouts.<name>.style) into the page, once; resolves when loaded. */
  function applyLayoutStyles(manifest) {
    var layouts = (manifest && manifest.layouts && typeof manifest.layouts === "object") ? manifest.layouts : {};
    if (!global.document) return Promise.resolve();
    return Promise.all(Object.keys(layouts).map(function (layout) {
      var href = layouts[layout] && layouts[layout].style;
      if (typeof href !== "string") return null;
      var id = "marquee-layout-style-" + layout;
      if (global.document.getElementById(id)) return null;
      return new Promise(function (resolve) {
        var link = global.document.createElement("link");
        link.rel = "stylesheet"; link.href = href; link.id = id; link.setAttribute("data-marquee-layout", layout);
        link.onload = function () { resolve(); };
        link.onerror = function () { log("the \"" + layout + "\" layout's stylesheet was not loaded (" + href + ")"); resolve(); };
        global.document.head.appendChild(link);
      });
    }));
  }

  function applyCanvas(canvas) {
    if (!global.document) return;
    var html = global.document.documentElement;
    var p = canvasPresentation(canvas);
    Array.prototype.slice.call(html.classList).forEach(function (c) { if (c.indexOf("marquee-") === 0) html.classList.remove(c); });
    p.classes.forEach(function (c) { html.classList.add(c); });
    Object.keys(p.properties).forEach(function (k) { html.style.setProperty(k, p.properties[k]); });
  }

  /** The automatic `marquee-*` facts beyond the canvas, and the declared `mod-*` set. */
  function applyModifiers(doc) {
    var resolution = resolveModifiers(state.manifest, doc && doc.modifiers);
    state.modifiers = resolution.modifiers;
    resolution.warnings.forEach(function (w) { log(w); });
    if (!global.document) return;
    var html = global.document.documentElement;
    Array.prototype.slice.call(html.classList).forEach(function (c) { if (c.indexOf("mod-") === 0) html.classList.remove(c); });
    automaticClasses(doc).forEach(function (c) { html.classList.add(c); });
    modifierClasses(state.manifest, state.modifiers).forEach(function (c) { html.classList.add(c); });
  }

  function applyColours(doc) {
    if (!global.document) return;
    var html = global.document.documentElement;
    Array.prototype.slice.call(html.style).forEach(function (name) {
      if (name.indexOf("--marquee-role-") === 0 || name.indexOf("--marquee-palette-") === 0 ||
          name.indexOf("--marquee-text-") === 0 || name === "--marquee-ink" || name === "--marquee-ink-muted") {
        html.style.removeProperty(name);
      }
    });
    var props = colourProperties(doc);
    Object.keys(props).forEach(function (k) { html.style.setProperty(k, props[k]); });
  }

  function applyFonts(manifest) {
    if (!global.document) return;
    var style = global.document.getElementById(FONT_STYLE_ID);
    if (!style) {
      style = global.document.createElement("style");
      style.id = FONT_STYLE_ID;
      global.document.head.appendChild(style);
    }
    style.textContent = fontFaceCSS(manifest, "");
  }

  /** Loads EVERY declared face (a face no text uses yet is otherwise never fetched) and
   *  asserts it resolved — the brand spec §3.8's rule for templates. Resolves to the
   *  missing ones. */
  function checkFonts(manifest) {
    var fonts = (manifest && manifest.fonts) || [];
    var fontSet = global.document && global.document.fonts;
    if (!fontSet || typeof fontSet.load !== "function") return Promise.resolve([]);
    var checks = [];
    fonts.forEach(function (font) {
      (font.faces || []).forEach(function (face) {
        var spec = (face.weight || 400) + " " + (face.style || "normal") + " 16px " + JSON.stringify(font.cssFamily);
        var file = typeof face.file === "string" && face.file.indexOf("data:") === 0 ? "data:…" : face.file;
        checks.push(
          fontSet.load(spec).then(function (loaded) { return loaded && loaded.length ? null : { cssFamily: font.cssFamily, file: file, postScriptName: face.postScriptName || null }; },
                                  function () { return { cssFamily: font.cssFamily, file: file, postScriptName: face.postScriptName || null }; })
        );
      });
    });
    return Promise.all(checks).then(function (results) { return results.filter(Boolean); });
  }

  function loadManifest() {
    if (global.document) {
      var inline = global.document.getElementById(MANIFEST_ID);
      if (inline) {
        try { return Promise.resolve(JSON.parse(inline.textContent)); }
        catch (e) { return Promise.reject(new Error("the inline manifest is not JSON: " + e.message)); }
      }
    }
    if (typeof global.fetch !== "function") return Promise.resolve(null);
    return global.fetch("./template.json", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("template.json: HTTP " + r.status); return r.json(); })
      .catch(function (e) { log("template.json not loaded (" + e.message + ") — fonts and roles come from the document alone"); return null; });
  }

  function validateDocument(doc) {
    if (!doc || typeof doc !== "object") return "the data document is not an object";
    if (typeof doc.format !== "string") return "the data document has no format";
    if (doc.format.split(".")[0] !== DATA_FORMAT.split(".")[0]) return "data format " + doc.format + " is not this engine's " + DATA_FORMAT;
    if (!doc.board || typeof doc.board.renderMode !== "string") return "the data document has no board.renderMode";
    return null;
  }

  function render() {
    var doc = state.document;
    if (!doc || !state.mount) return;
    var html;
    try {
      html = renderHTML(state.templates, doc, state.modifiers);
    } catch (e) {
      report("error", { message: String(e && e.message || e), layout: doc.board.renderMode });
      return;
    }
    state.mount.innerHTML = html;
    var posted = false;
    var done = function () {
      if (posted) return;
      posted = true;
      report("rendered", { page: doc.board.page, pageCount: doc.board.pageCount, renderMode: doc.board.renderMode });
    };
    // Two animation frames let layout and paint settle. A page in a hidden window gets no
    // animation frames at all (the Apple host renders offscreen), so a short timer stands in.
    if (typeof global.requestAnimationFrame === "function") global.requestAnimationFrame(function () { global.requestAnimationFrame(done); });
    global.setTimeout(done, 80);
  }

  function update(doc) {
    var problem = validateDocument(doc);
    if (problem) { report("error", { message: problem }); return false; }
    state.document = doc;
    applyCanvas(doc.canvas || {});
    applyModifiers(doc);
    applyColours(doc);
    emit("update", doc);
    if (!state.manual) render();
    return true;
  }

  function configure(options) {
    options = options || {};
    if (typeof options.host === "string" && options.host) state.host = options.host;
    if (options.manifest) state.manifest = options.manifest;
    return api;
  }

  function start() {
    if (!global.document) return;
    state.mount = global.document.getElementById(MOUNT_ID);
    if (!state.mount) { report("error", { message: "no <div id=\"" + MOUNT_ID + "\"> in the page" }); return; }
    state.manual = state.mount.hasAttribute("data-marquee-manual");
    try { state.env = makeEnvironment(); } catch (e) { report("error", { message: e.message }); return; }

    loadManifest().then(function (manifest) {
      if (manifest) state.manifest = manifest;
      // The manifest first: it names the layout sources and styles (engine 1.2), the fonts and the roles.
      return Promise.all([loadSources(state.manifest), applyLayoutStyles(state.manifest)]);
    }).then(function (loaded) {
      var compiled = compileAll(loaded[0], state.env);
      state.templates = compiled.templates;
      state.layouts = Object.keys(compiled.templates);
      compiled.errors.forEach(function (err) { report("error", err); });
      if (state.manifest) applyFonts(state.manifest);
      var fontsReady = (global.document.fonts && global.document.fonts.ready) ? global.document.fonts.ready : Promise.resolve();
      return fontsReady.then(function () { return checkFonts(state.manifest); }).then(function (missing) {
        state.missingFonts = missing;
        state.ready = true;
        report("ready", { engine: ENGINE_FORMAT, data: DATA_FORMAT, layouts: state.layouts, missingFonts: state.missingFonts, host: state.host });
        if (global.__marqueeFixture) update(global.__marqueeFixture);
        if (state.document && !state.manual) render();
      });
    }).catch(function (e) { report("error", { message: String(e && e.message || e) }); });
  }

  var api = {
    engineFormat: ENGINE_FORMAT,
    dataFormat: DATA_FORMAT,
    configure: configure,
    update: update,
    render: render,
    on: on,
    off: off,
    log: log,
    get document() { return state.document; },
    get manifest() { return state.manifest; },
    get ready() { return state.ready; },
    get layouts() { return state.layouts.slice(); },
    get missingFonts() { return state.missingFonts.slice(); },
    get host() { return state.host; },
    get modifiers() { return Object.assign({}, state.modifiers); },
    /** Every class the shim set on <html>, for the inspector. */
    get classes() { return global.document ? Array.prototype.slice.call(global.document.documentElement.classList).filter(function (c) { return c.indexOf("marquee-") === 0 || c.indexOf("mod-") === 0; }) : []; },
    // pure parts, for tests and for hosts
    aspectFamily: aspectFamily,
    orientationOf: orientationOf,
    sizeTier: sizeTier,
    canvasPresentation: canvasPresentation,
    loadSources: loadSources,
    automaticClasses: automaticClasses,
    resolveModifiers: resolveModifiers,
    modifierClasses: modifierClasses,
    colourProperties: colourProperties,
    fontFaceCSS: fontFaceCSS,
    timeString: timeString,
    dateLine: dateLine,
    makeEnvironment: makeEnvironment,
    compileAll: compileAll,
    renderHTML: renderHTML,
    validateDocument: validateDocument,
    _setDocumentForTests: function (doc) { state.document = doc; }
  };

  global.marquee = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;

  if (global.document) {
    if (global.document.readyState === "loading") global.document.addEventListener("DOMContentLoaded", start);
    else start();
  }
})(typeof window !== "undefined" ? window : globalThis);
