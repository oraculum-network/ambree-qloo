// The demo page: a real MCP client of the planner's server at /mcp. Plain JSON-RPC over
// Streamable HTTP (2025-11-25), no build step. It renders text only (textContent), never
// HTML from a reply. Nothing is stored: reload and it is gone.

const PROTOCOL = "2025-11-25";
const KINDS = [
  ["music", "Music (artist)"],
  ["film", "Film"],
  ["tv", "TV show"],
  ["book", "Book"],
  ["podcast", "Podcast"],
  ["game", "Game"],
  ["food", "Food"],
  ["brand", "Brand"],
  ["person", "Person"],
  ["place", "Place"],
];
const MAX_TASTES = 6;
const EXAMPLES = [
  [["music", "Bob Marley"], ["food", "seafood"], ["film", "Life of Pi"]],
  [["music", "Miles Davis"], ["food", "cafe"], ["book", "Norwegian Wood"]],
  [["film", "Moana"], ["food", "street food"], ["music", "Jack Johnson"]],
];
const SLOT_LABEL = { morning: "Morning", lunch: "Lunch", afternoon: "Afternoon", evening: "Evening" };
const KIND_LABEL = { thing_to_do: "Thing to do", restaurant: "Restaurant", bar: "Bar" };

const $ = (id) => document.getElementById(id);
const rows = $("rows");
const form = $("plan");
const go = $("go");
const speechEl = $("speech");
const readBtn = $("read");
const dayEl = $("day");
const turnsEl = $("turns");
const banner = $("demo-banner");

let nextId = 1;
let initialised = false;
let lastSpeech = "";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---- Taste rows ----------------------------------------------------------------

function addRow(kind = "music", name = "") {
  if (rows.children.length >= MAX_TASTES) return;
  const n = rows.children.length + 1;
  const li = el("li", "row");
  const select = el("select");
  select.setAttribute("aria-label", `Taste ${n} kind`);
  for (const [value, label] of KINDS) {
    const opt = el("option", "", label);
    opt.value = value;
    select.append(opt);
  }
  select.value = kind;
  const input = el("input");
  input.type = "text";
  input.maxLength = 60;
  input.value = name;
  input.placeholder = "e.g. Bob Marley, Life of Pi, street food";
  input.setAttribute("aria-label", `Taste ${n} name`);
  const remove = el("button", "ghost remove", "Remove");
  remove.type = "button";
  remove.setAttribute("aria-label", `Remove taste ${n}`);
  remove.addEventListener("click", () => {
    li.remove();
    if (!rows.children.length) addRow();
    syncAdd();
  });
  li.append(select, input, remove);
  rows.append(li);
  syncAdd();
  return input;
}

function syncAdd() {
  $("add").disabled = rows.children.length >= MAX_TASTES;
}

function setRows(list) {
  rows.replaceChildren();
  for (const [kind, name] of list) addRow(kind, name);
}

function readTastes() {
  return [...rows.children]
    .map((li) => ({ kind: li.querySelector("select").value, name: li.querySelector("input").value.trim() }))
    .filter((t) => t.name);
}

// ---- MCP client ------------------------------------------------------------------

async function post(message, withVersion) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (withVersion) headers["MCP-Protocol-Version"] = PROTOCOL;
  const res = await fetch("/mcp", { method: "POST", headers, body: JSON.stringify(message) });
  if (res.status === 202) return null;
  const body = await res.json().catch(() => null);
  if (!body) throw new Error(`The server answered ${res.status}.`);
  if (body.error) throw new Error(body.error.message || `The server answered ${res.status}.`);
  return body.result;
}

async function rpc(method, params, trace) {
  const started = performance.now();
  try {
    const result = await post({ jsonrpc: "2.0", id: nextId++, method, params }, method !== "initialize");
    trace.push({ label: method === "tools/call" ? `tools/call ${params.name}` : method, ms: Math.round(performance.now() - started), ok: !result?.isError });
    return result;
  } catch (e) {
    trace.push({ label: method, ms: Math.round(performance.now() - started), ok: false });
    throw e;
  }
}

async function ensureInitialised(trace) {
  if (initialised) return;
  await rpc("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "ambree-qloo-page", version: "0.1.0" } }, trace);
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, true);
  initialised = true;
}

// ---- Rendering -------------------------------------------------------------------

function showMode(mode, notice) {
  if (mode !== "demo") {
    banner.hidden = true;
    return;
  }
  $("demo-detail").textContent =
    notice === "live_unavailable"
      ? "Live Qloo access isn't available right now, so every place below is invented and marked (demo)."
      : "No Qloo key is set on this server, so every place below is invented and marked (demo).";
  banner.hidden = false;
}

function setSpeech(text) {
  lastSpeech = text;
  speechEl.textContent = text;
  readBtn.hidden = !("speechSynthesis" in window) || !text;
}

function renderDay(out) {
  dayEl.replaceChildren();
  const area = $("area");
  area.hidden = !out.area;
  area.textContent = out.area ? `A day around ${out.area.around}: every stop within ${out.area.radius_km} km of the first.` : "";
  for (const stop of out.day) {
    const li = el("li", "card");
    const slot = el("p", "label card-slot", SLOT_LABEL[stop.slot] || stop.slot);
    if (KIND_LABEL[stop.kind]) slot.append(el("span", "card-kind", ` · ${KIND_LABEL[stop.kind]}`));
    li.append(slot);
    li.append(el("h3", "card-name", stop.place));
    const where = [stop.town, typeof stop.km_from_start === "number" ? `${stop.km_from_start} km from the first stop` : ""].filter(Boolean);
    if (where.length) li.append(el("p", "card-town", where.join(" · ")));
    if (stop.tags.length) {
      const tags = el("ul", "card-tags");
      for (const t of stop.tags) tags.append(el("li", "", t));
      li.append(tags);
    }
    li.append(el("p", "card-why", stop.why));
    // 0 means Qloo sent no score (live insights may leave out query.affinity): no line then.
    if (stop.affinity > 0) li.append(el("p", "card-score", `Qloo affinity ${stop.affinity.toFixed(2)}`));
    dayEl.append(li);
  }
  const missed = out.unresolved.map((u) => u.input);
  $("unresolved").hidden = !missed.length;
  $("unresolved").textContent = missed.length ? `Qloo had no match for: ${missed.join(", ")}.` : "";
}

function renderTurn(trace, out) {
  $("hood-empty").hidden = true;
  const li = el("li", "hood-turn");
  const head = el("p", "");
  head.append(el("span", out && out.mode === "demo" ? "badge badge-demo" : "badge", out ? (out.mode === "demo" ? "Demo data" : "Live Qloo") : "Error"));
  li.append(head);
  const calls = el("ol", "calls");
  for (const t of trace) {
    calls.append(el("li", "call-mcp", `${t.label} · ${t.ms} ms · ${t.ok ? "ok" : "error"}`));
    if (t.label === "tools/call plan_day" && out) {
      for (const q of out.qloo_calls) calls.append(el("li", "call-qloo", `↳ Qloo GET ${q.endpoint} · ${q.ms} ms${q.cached ? " · cached" : ""}`));
    }
  }
  li.append(calls);
  turnsEl.prepend(li);
}

// ---- Planning --------------------------------------------------------------------

async function plan() {
  const tastes = readTastes();
  const error = $("form-error");
  if (!tastes.length) {
    error.textContent = "Add at least one taste first.";
    error.hidden = false;
    rows.querySelector("input")?.focus();
    return;
  }
  error.hidden = true;
  const args = { tastes, pace: $("pace").value };
  const town = $("town").value.trim();
  if (town) args.town = town;

  go.disabled = true;
  go.textContent = "Planning…";
  const trace = [];
  try {
    await ensureInitialised(trace);
    const result = await rpc("tools/call", { name: "plan_day", arguments: args }, trace);
    if (result.isError) {
      const text = result.content?.[0]?.text || "Something went wrong.";
      setSpeech(text);
      dayEl.replaceChildren();
      $("area").hidden = true;
      renderTurn(trace, null);
      return;
    }
    const out = result.structuredContent;
    showMode(out.mode, out.notice);
    setSpeech(out.speech);
    renderDay(out);
    renderTurn(trace, out);
  } catch (e) {
    setSpeech(`Sorry, that didn't work: ${e instanceof Error ? e.message : "unknown error"}`);
    renderTurn(trace, null);
  } finally {
    go.disabled = false;
    go.textContent = "Plan my day";
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void plan();
});

$("add").addEventListener("click", () => addRow("music", "")?.focus());

for (const chip of document.querySelectorAll(".chip")) {
  chip.addEventListener("click", () => {
    setRows(EXAMPLES[Number(chip.dataset.example)] || []);
    void plan();
  });
}

readBtn.addEventListener("click", () => {
  if (!("speechSynthesis" in window) || !lastSpeech) return;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(lastSpeech));
});

// The mode before the first plan: /healthz says whether a Qloo key is set.
fetch("/healthz")
  .then((r) => r.json())
  .then((h) => showMode(h.mode))
  .catch(() => {});

if (window.matchMedia("(max-width: 959px)").matches) $("hood").removeAttribute("open");
addRow("music", "");
