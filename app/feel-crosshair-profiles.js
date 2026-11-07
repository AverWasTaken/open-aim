/* Crosshair profiles: a named list of crosshair codes, switched from the Crosshair settings.
   The list lives in localStorage (KEY). Applying a profile goes through the game's own
   crosshair code panel ([data-role="crosshair-code"]): its textarea + import button. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (!root.__aimCrosshairProfiles) { root.__aimCrosshairProfiles = api; api.startUi(); }
})(globalThis, function () {
  "use strict";
  const KEY = "es-crosshair-profiles-v1", CURRENT = "al-crosshair-v1";
  const MAX = 50, NAME_MAX = 32, CODE_MAX = 2000;
  const SOURCES = ["manual", "valorant", "preset"];

  const validCode = code => typeof code === "string" && code.length <= CODE_MAX && /^0(;|$)/.test(code);
  // Names are user text (also from imported files): one line, no control characters, 32 chars max.
  function cleanName(name) {
    const s = String(name ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
    return Array.from(s).slice(0, NAME_MAX).join("").trim();
  }
  let counter = 0;
  const newId = () => "x" + Date.now().toString(36) + (counter++).toString(36) + Math.random().toString(36).slice(2, 6);
  const empty = () => ({ v: 1, list: [] });

  function sanitize(data) {
    const out = empty();
    if (!data || typeof data !== "object" || !Array.isArray(data.list)) return out;
    const ids = new Set();
    for (const p of data.list) {
      if (out.list.length >= MAX) break;
      if (!p || typeof p !== "object" || !validCode(p.code)) continue;
      const name = cleanName(p.name);
      if (!name) continue;
      let id = typeof p.id === "string" && /^[\w-]{1,40}$/.test(p.id) ? p.id : newId();
      while (ids.has(id)) id = newId();
      ids.add(id);
      out.list.push({ id, name, code: p.code, source: SOURCES.includes(p.source) ? p.source : "manual",
        updatedAt: Number.isFinite(p.updatedAt) ? p.updatedAt : 0 });
    }
    return out;
  }
  function load(storage) {
    try { return sanitize(JSON.parse(storage.getItem(KEY) || "null")); } catch { return empty(); }
  }
  const save = (storage, state) => storage.setItem(KEY, JSON.stringify(sanitize(state)));
  const copy = state => ({ v: 1, list: sanitize(state).list.map(p => ({ ...p })) });
  const findByCode = (state, code) => state.list.find(p => p.code === code) || null;

  // Save a code under a name. Same name (any case) updates that profile; otherwise adds one.
  function upsert(state, { name, code, source = "manual" }, now = Date.now()) {
    const next = copy(state), clean = cleanName(name);
    if (!clean) return { state, error: "Enter a name." };
    if (!validCode(code)) return { state, error: "This crosshair code can't be saved." };
    const same = next.list.find(p => p.name.toLowerCase() === clean.toLowerCase());
    if (same) { Object.assign(same, { name: clean, code, updatedAt: now }); return { state: next, entry: same, updated: true }; }
    if (next.list.length >= MAX) return { state, error: `Limit is ${MAX} profiles. Delete one first.` };
    const entry = { id: newId(), name: clean, code, source: SOURCES.includes(source) ? source : "manual", updatedAt: now };
    next.list.push(entry);
    return { state: next, entry, updated: false };
  }
  function rename(state, id, name, now = Date.now()) {
    const next = copy(state), clean = cleanName(name), entry = next.list.find(p => p.id === id);
    if (!entry) return { state, error: "Profile not found." };
    if (!clean) return { state, error: "Enter a name." };
    if (next.list.some(p => p !== entry && p.name.toLowerCase() === clean.toLowerCase())) return { state, error: "A profile with that name already exists." };
    Object.assign(entry, { name: clean, updatedAt: now });
    return { state: next, entry };
  }
  function remove(state, id) {
    const next = copy(state), before = next.list.length;
    next.list = next.list.filter(p => p.id !== id);
    return { state: next, removed: next.list.length < before };
  }
  // Imported VALORANT profiles ({name, code}) in file order: existing entries stay, exact
  // duplicate codes are skipped, new ones are added until the list holds MAX.
  function mergeImported(state, profiles, now = Date.now()) {
    const next = copy(state);
    let added = 0, duplicates = 0, notAdded = 0, invalid = 0;
    (Array.isArray(profiles) ? profiles : []).forEach((p, i) => {
      if (!p || !validCode(p.code)) { invalid++; return; }
      if (findByCode(next, p.code)) { duplicates++; return; }
      if (next.list.length >= MAX) { notAdded++; return; }
      next.list.push({ id: newId(), name: cleanName(p.name) || "VALORANT " + (i + 1), code: p.code, source: "valorant", updatedAt: now });
      added++;
    });
    return { state: next, added, duplicates, notAdded, invalid };
  }

  function startUi() {
    if (typeof document === "undefined") return;
    // The code panel is a flex column in the in-round dialog and a grid in the lobby Settings,
    // where every direct div child is put in the button cell; the strip takes a full row instead.
    // The lobby's right column (crosshair lab + code panel) is taller than the screen and did not
    // scroll, which left the strip under the bottom bar; it scrolls while it holds the strip.
    const css = `.feel-xprof{grid-area:auto/1/auto/-1!important;display:flex!important;flex-direction:column;gap:8px;padding-top:10px;border-top:1px solid var(--h-border,rgba(255,255,255,.1))}
.feel-xprof .feel-xprof-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.feel-xprof .feel-xprof-label{font-size:12px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--h-text)}
.feel-xprof select,.feel-xprof input{flex:1 1 160px;min-width:0;height:32px;box-sizing:border-box;padding:0 10px;font:inherit;font-size:12.5px;color:var(--h-text);background:var(--h-surface);border:1px solid var(--h-border);border-radius:6px;outline:none}
.st-view .feel-xprof select,.st-view .feel-xprof input{border:0;border-radius:0;box-shadow:inset 0 0 0 1px var(--st-line,var(--h-border))}
.feel-xprof select:focus,.feel-xprof input:focus{border-color:var(--h-accent);box-shadow:inset 0 0 0 1px var(--h-accent)}
.feel-xprof select option{color:var(--h-text);background:var(--h-surface)}
.feel-xprof .feel-xprof-row .hall-dialog-btn{flex:1 1 0;padding:0 10px;white-space:nowrap}
.feel-xprof .hall-dialog-btn.feel-xprof-danger{color:var(--h-danger);box-shadow:inset 0 0 0 1px var(--h-danger)}
.feel-xprof .feel-xprof-status{min-height:1.4em;font-size:12px;color:var(--h-text-muted)}
.feel-xprof .feel-xprof-status.is-bad{font-weight:700;color:var(--h-danger)}
.feel-xprof [hidden]{display:none!important}
.st-side:has(.feel-xprof){overflow-y:auto;min-height:0;overscroll-behavior:contain}`;
    let lastCode = null;
    const store = () => { try { return localStorage; } catch { return null; } };
    const current = () => { try { return localStorage.getItem(CURRENT); } catch { return null; } };
    const tick = () => new Promise(r => setTimeout(r));

    function addCss() {
      if (document.getElementById("feel-xprof-css")) return;
      const style = document.createElement("style"); style.id = "feel-xprof-css"; style.textContent = css;
      document.head.appendChild(style);
    }
    // The game panel's import button, found by structure (its label is translated).
    // The button row is the panel's last div other than the strip itself.
    const importButton = panel => [...panel.querySelectorAll(':scope > div:not([data-role="crosshair-profiles"])')].pop()
      ?.querySelector(':scope > button:not(.is-primary)') || null;

    function build(panel) {
      const button = importButton(panel), textarea = panel.querySelector("textarea");
      if (!button || !textarea) return;
      addCss();
      const scoped = [...panel.attributes].filter(a => a.name.startsWith("data-v-")).map(a => a.name);
      const btnClass = [...button.classList].filter(c => c !== "is-primary").join(" ");
      const el = (tag, cls, text) => {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        for (const a of scoped) node.setAttribute(a, "");
        return node;
      };
      const btn = (text, action) => { const b = el("button", btnClass, text); b.type = "button"; b.dataset.xprof = action; return b; };
      const strip = el("div", "feel-xprof"); strip.dataset.role = "crosshair-profiles";
      const pick = el("div", "feel-xprof-row"), label = el("span", "feel-xprof-label", "Profiles");
      const select = el("select"); select.setAttribute("aria-label", "Crosshair profile");
      pick.append(label, select);
      const row = el("div", "feel-xprof-row");
      const saveAs = btn("Save current as…", "save"), renameBtn = btn("Rename", "rename"), del = btn("Delete", "delete");
      row.append(saveAs, renameBtn, del);
      const edit = el("div", "feel-xprof-row"); edit.hidden = true;
      const input = el("input"); input.type = "text"; input.maxLength = NAME_MAX; input.placeholder = "Profile name"; input.setAttribute("aria-label", "Profile name");
      const ok = btn("Save", "ok"), cancel = btn("Cancel", "cancel");
      edit.append(input, ok, cancel);
      const status = el("small", "feel-xprof-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
      strip.append(pick, row, edit, status);
      // Typing a name must not trigger drill key binds.
      for (const type of ["keydown", "keyup", "keypress"]) strip.addEventListener(type, e => e.stopPropagation());

      let mode = null, confirmTimer = 0, busy = false;
      const say = (text, bad = false) => { status.textContent = text; status.classList.toggle("is-bad", bad); };
      const state = () => { const s = store(); return s ? load(s) : empty(); };
      const write = next => { try { save(localStorage, next); return true; } catch { say("Could not save profiles.", true); return false; } };
      const selected = () => state().list.find(p => p.id === select.value) || null;
      function resetDelete() { clearTimeout(confirmTimer); del.textContent = "Delete"; del.classList.remove("feel-xprof-danger"); del.dataset.confirm = ""; }
      function render() {
        const s = state(), code = current(), match = code ? findByCode(s, code) : null;
        lastCode = code;
        const opts = [];
        if (!match) { const o = document.createElement("option"); o.value = ""; o.text = s.list.length ? "— (edited)" : "— (no profiles yet)"; opts.push(o); }
        for (const p of s.list) { const o = document.createElement("option"); o.value = p.id; o.text = p.name; opts.push(o); }
        select.replaceChildren(...opts);
        select.value = match ? match.id : "";
        renameBtn.disabled = del.disabled = !match;
        if (!match && del.dataset.confirm) resetDelete();
      }
      function closeEdit() { mode = null; edit.hidden = true; row.hidden = false; }
      function openEdit(kind) {
        resetDelete();
        const p = selected();
        if (kind === "rename" && !p) return;
        mode = kind; input.value = kind === "rename" ? p.name : ""; ok.textContent = kind === "rename" ? "Rename" : "Save";
        row.hidden = true; edit.hidden = false; say(""); input.focus(); input.select();
      }
      function commitEdit() {
        if (mode === "save") {
          // Before the first change the game has stored nothing; the panel then shows the default code.
          const code = current() ?? textarea.value.trim();
          if (!validCode(code)) { say("No crosshair to save yet. Change a setting first.", true); return; }
          const r = upsert(state(), { name: input.value, code });
          if (r.error) { say(r.error, true); return; }
          if (!write(r.state)) return;
          closeEdit(); render(); say((r.updated ? "Updated " : "Saved ") + r.entry.name);
        } else if (mode === "rename") {
          const p = selected();
          const r = p ? rename(state(), p.id, input.value) : { error: "Profile not found." };
          if (r.error) { say(r.error, true); return; }
          if (!write(r.state)) return;
          closeEdit(); render(); say("Renamed to " + r.entry.name);
        }
      }
      async function apply(id) {
        const p = state().list.find(x => x.id === id);
        if (!p || busy) { render(); return; }
        busy = true; select.disabled = true;
        try {
          const message = panel.querySelector('[data-role="crosshair-code-message"]');
          const target = importButton(panel), area = panel.querySelector("textarea");
          if (!target || !area) throw new Error();
          area.value = p.code; area.dispatchEvent(new Event("input", { bubbles: true }));
          target.click();
          await tick();
          if (message?.classList.contains("is-bad")) throw new Error();
          const now = current();
          // The game may rewrite the code in its own form; keep the profile in step so it stays selected.
          if (now && now !== p.code && validCode(now)) {
            const s = state(), e = s.list.find(x => x.id === p.id);
            if (e && !findByCode(s, now)) { e.code = now; write(s); }
          }
          say("Applied " + p.name);
        } catch { say("Could not apply " + p.name + ".", true); }
        finally { busy = false; select.disabled = false; render(); }
      }
      select.onchange = () => { resetDelete(); if (select.value) apply(select.value); };
      saveAs.onclick = () => openEdit("save");
      renameBtn.onclick = () => openEdit("rename");
      ok.onclick = commitEdit;
      cancel.onclick = () => { closeEdit(); say(""); };
      input.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
        else if (e.key === "Escape") { e.preventDefault(); closeEdit(); say(""); select.focus(); }
      });
      del.onclick = () => {
        const p = selected();
        if (!p) return;
        if (del.dataset.confirm !== p.id) {
          del.dataset.confirm = p.id; del.textContent = "Confirm delete"; del.classList.add("feel-xprof-danger");
          clearTimeout(confirmTimer); confirmTimer = setTimeout(resetDelete, 4000); return;
        }
        resetDelete();
        if (write(remove(state(), p.id).state)) { render(); say("Deleted " + p.name); }
      };
      panel.appendChild(strip);
      render();
      // Sliders and presets change the crosshair elsewhere in the dialog; follow along cheaply.
      const timer = setInterval(() => {
        if (!strip.isConnected) { clearInterval(timer); return; }
        if (!busy && mode === null && current() !== lastCode && document.activeElement !== select) render();
      }, 500);
      strip.__render = render;
    }

    function mount() {
      for (const panel of document.querySelectorAll('[data-role="crosshair-code"]')) {
        if (!panel.querySelector(':scope > [data-role="crosshair-profiles"]')) build(panel);
      }
    }
    // Another tab or the importer can change the list.
    addEventListener("storage", e => {
      if (e.key !== KEY && e.key !== CURRENT && e.key !== null) return;
      for (const s of document.querySelectorAll('[data-role="crosshair-profiles"]')) s.__render?.();
    });
    let queued = false;
    const schedule = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; mount(); }); };
    if (window.__aimWatchPage) window.__aimWatchPage(schedule, { childList: true, subtree: true });
    else new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    mount();
  }

  return { KEY, MAX, NAME_MAX, validCode, cleanName, sanitize, load, save, findByCode, upsert, rename, remove, mergeImported, startUi };
});
