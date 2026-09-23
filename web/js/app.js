// Revision Tracker website: plain JS modules, no dependencies.
import CONFIG from "../config.js";
import * as L from "./logic.js";
import * as svc from "./service.js";
import { Remote, Tracker, formatCode, normalizeCode } from "./sync.js";
import { docToCSVs, parseCSV, zip } from "./files.js";

const S = {
  tracker: null,       // the open tracker (see sync.js)
  boot: null,          // today, settings and option lists derived from the tracker
  chapters: [],        // enriched chapters
  route: "due",
  sel: 0,              // keyboard-selected row index in the current list
  filters: { q: "", strand: "", book: "", status: "" },
  sort: { key: "sort_order", dir: 1 },
  papersOpen: new Set(),
  mistakeFilter: "open",
};

// ------------------------------------------------------------------ helpers

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const STATUS_LABEL = { not_started: "Not started", in_progress: "In progress", done: "Done" };
const CONF_LABEL = { 1: "Shaky", 2: "Weak", 3: "OK", 4: "Good", 5: "Exam-ready" };

function parseISO(s) { if (!s) return null; const [y, m, d] = s.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); }
function fmtDate(s, withYear = true) {
  const d = parseISO(s); if (!d) return "—";
  return d.toLocaleDateString("en-GB", withYear ? { day: "numeric", month: "short", year: "numeric" } : { weekday: "short", day: "numeric", month: "short" });
}
function addDays(iso, n) { const d = parseISO(iso); d.setDate(d.getDate() + n); return toISO(d); }
function toISO(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function plural(n, w) { return `${n} ${w}${n === 1 ? "" : "s"}`; }
function relDays(n) {
  if (n === null || n === undefined) return "—";
  if (n === 0) return "today";
  if (n > 0) return `in ${plural(n, "day")}`;
  return `${plural(-n, "day")} ago`;
}
function chapterLabel(c) { return `${c.book} · Ch ${c.ch_num} — ${c.title}`; }
function chapterById(id) { return S.chapters.find((c) => c.id === id); }
function isTyping(e) { const t = e.target; return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)); }

const today = () => CONFIG.today || L.localToday();

// The pages ask for data with api("GET", "/api/...") and change it with other methods. Reads come
// from the tracker document on this device; changes are applied straight away and saved to the
// database in the background by the Tracker.
async function api(method, path, body = {}) {
  const T = today(), doc = S.tracker.doc;
  const m = (re) => path.match(re);
  let r;
  if (method === "GET") {
    if (path === "/api/chapters") return svc.listChapters(doc, T);
    if (path === "/api/due") return svc.dueList(doc, T);
    if ((r = m(/^\/api\/chapters\/([^/]+)\/history$/))) return svc.chapterHistory(doc, r[1], T);
    if (path === "/api/dashboard") return svc.dashboard(doc, T);
    if (path === "/api/papers") return svc.listPapers(doc);
    if (path === "/api/papers/chart") return svc.paperChart(doc);
    if (path === "/api/boundaries") return svc.listBoundaries(doc);
    if (path === "/api/mistakes") return svc.listMistakes(doc, T);
    if (path === "/api/settings") return svc.settingsOf(doc);
    throw new Error(`Unknown page data: ${path}`);
  }
  const change = (op, result) => { S.tracker.apply(op); return result ? result(S.tracker.doc) : { ok: true }; };
  const id = svc.newId();
  if ((r = m(/^\/api\/chapters\/([^/]+)$/)) && method === "PATCH") return change((d) => svc.updateChapter(d, r[1], body, T), (d) => svc.getChapter(d, r[1], T));
  if ((r = m(/^\/api\/chapters\/([^/]+)\/learnt$/))) return change((d) => svc.markLearnt(d, r[1], body.confidence, T));
  if ((r = m(/^\/api\/chapters\/([^/]+)\/review$/))) {
    const now = new Date().toISOString();
    return change((d) => svc.reviewChapter(d, r[1], body.confidence, body.note, T, { reviewId: id, now }));
  }
  if ((r = m(/^\/api\/reviews\/([^/]+)$/)) && method === "DELETE") return change((d) => svc.deleteReview(d, r[1]));
  if (path === "/api/papers" && method === "POST") return change((d) => svc.createPaper(d, body, { id }), (d) => svc.listPapers(d).find((p) => p.id === id));
  if ((r = m(/^\/api\/papers\/([^/]+)$/)) && method === "DELETE") return change((d) => svc.deletePaper(d, r[1]));
  if ((r = m(/^\/api\/papers\/([^/]+)\/questions$/))) return change((d) => svc.addQuestion(d, r[1], body, { id }));
  if ((r = m(/^\/api\/questions\/([^/]+)$/)) && method === "DELETE") return change((d) => svc.deleteQuestion(d, r[1]));
  if (path === "/api/boundaries" && method === "PUT") return change((d) => svc.upsertBoundary(d, body, { id }));
  if ((r = m(/^\/api\/boundaries\/([^/]+)$/)) && method === "DELETE") return change((d) => svc.deleteBoundary(d, r[1]));
  if (path === "/api/mistakes" && method === "POST") return change((d) => svc.createMistake(d, body, T, { id }));
  if ((r = m(/^\/api\/mistakes\/([^/]+)$/)) && method === "PATCH") return change((d) => svc.updateMistake(d, r[1], body, T));
  if ((r = m(/^\/api\/mistakes\/([^/]+)\/retest$/))) return change((d) => svc.retestMistake(d, r[1], Boolean(body.passed), T));
  if ((r = m(/^\/api\/mistakes\/([^/]+)$/)) && method === "DELETE") return change((d) => svc.deleteMistake(d, r[1]));
  if (path === "/api/settings" && method === "PUT") return change((d) => svc.saveSettings(d, body), (d) => svc.settingsOf(d));
  if (path === "/api/settings/reset") return change((d) => svc.resetSettings(d, body.keys || []), (d) => svc.settingsOf(d));
  throw new Error(`Unknown change: ${method} ${path}`);
}

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`; el.textContent = msg;
  const root = $("#toast-root");
  root.appendChild(el);
  while (root.children.length > 3) root.firstChild.remove();
  setTimeout(() => el.remove(), kind === "error" ? 5000 : 2600);
}
async function guard(fn) { try { return await fn(); } catch (e) { toast(e.message, "error"); throw e; } }

function confBadge(c) { return c ? `<span class="conf c${c}" title="${CONF_LABEL[c]}">${c}</span>` : `<span class="conf" title="Not rated">–</span>`; }
function prioBadge(p) { return `<span class="prio" title="Priority score (0–100)"><span class="bar"><i style="width:${Math.min(100, p)}%"></i></span>${p.toFixed(0)}</span>`; }
function learntPill(c) { return c.learnt ? `<span class="pill good">✓ Learnt ${fmtDate(c.first_learnt)}</span>` : `<span class="pill">Not learnt yet</span>`; }
function dueReason(c) {
  if (c.next_review) {
    const late = -c.days_until_review;
    return late > 0 ? `<span class="pill bad">⚠ ${plural(late, "day")} overdue</span>` : `<span class="pill warn">● Due today</span>`;
  }
  return `<span class="pill warn">● Learnt — rate your confidence</span>`;
}
function statusSelect(c, field) {
  return `<select class="st-${c[field]}" data-change="status" data-id="${c.id}" data-field="${field}" aria-label="${field.replace("_status", "")} status">` +
    S.boot.statuses.map((s) => `<option value="${s}" ${c[field] === s ? "selected" : ""}>${STATUS_LABEL[s]}</option>`).join("") + `</select>`;
}
function chapterOptions(selected) {
  const groups = {};
  for (const c of S.chapters) (groups[c.strand] ||= []).push(c);
  return `<option value="">Choose chapter…</option>` + Object.entries(groups).map(([g, cs]) =>
    `<optgroup label="${esc(g)}">` + cs.map((c) => `<option value="${c.id}" ${c.id === selected ? "selected" : ""}>${esc(c.book)} ${c.ch_num}: ${esc(c.title)}</option>`).join("") + `</optgroup>`).join("");
}
function paperOptions(selected) { return S.boot.settings.papers.map((p) => `<option value="${esc(p.code)}" ${p.code === selected ? "selected" : ""}>${esc(p.code)} — ${esc(p.name)}</option>`).join(""); }
function seriesDatalist() {
  const years = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027];
  const opts = years.map((y) => `June ${y}`).concat(["November 2020", "November 2021", "Sample assessment", "Practice paper set 1", "Practice paper set 2"]);
  return `<datalist id="series-list">${opts.map((o) => `<option value="${o}">`).join("")}</datalist>`;
}

// ------------------------------------------------------------------ data loading

async function loadBoot() {
  S.boot = { today: today(), settings: svc.settingsOf(S.tracker.doc), statuses: L.STATUSES, error_types: L.ERROR_TYPES,
             grades: L.GRADES, tables: [...svc.TABLES, "settings"] };
  applyTheme();
}
async function loadChapters() { S.chapters = await api("GET", "/api/chapters"); updateBadges(); }
function updateBadges() {
  const n = S.chapters.filter((c) => c.due).length;
  const b = $("#due-badge"); b.hidden = n === 0; b.textContent = n;
  $("#today-label").textContent = "Today: " + fmtDate(S.boot.today, false);
}
async function refreshStreak() {
  try { const d = await api("GET", "/api/dashboard"); $("#streak-label").textContent = `🔥 ${plural(d.streak, "day")} streak · ${d.reviews_this_week} this week`; } catch (_) { /* non-critical */ }
}

// ------------------------------------------------------------------ theme

function applyTheme() {
  const t = S.boot.settings.theme;
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
}
async function cycleTheme() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark" ||
    (!document.documentElement.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
  const next = dark ? "light" : "dark";
  S.boot.settings = await api("PUT", "/api/settings", { theme: next });
  applyTheme();
  if (S.route === "settings") render();
}

// ------------------------------------------------------------------ router

const PAGES = { due: renderDue, chapters: renderChapters, dashboard: renderDashboard, papers: renderPapers, mistakes: renderMistakes, settings: renderSettings };

function currentRoute() { const r = location.hash.replace(/^#\/?/, "").split("?")[0]; return PAGES[r] ? r : "due"; }
async function render() {
  S.route = currentRoute();
  $$(".sidebar a").forEach((a) => a.classList.toggle("active", a.dataset.nav === S.route));
  try { await PAGES[S.route]($("#main")); }
  catch (e) { $("#main").innerHTML = `<div class="empty">Something went wrong: ${esc(e.message)}</div>`; }
  highlightSelection(false);
}
window.addEventListener("hashchange", () => { S.sel = 0; render(); $("#main").focus(); });

// ------------------------------------------------------------------ Due today

async function renderDue(main) {
  const [due] = await Promise.all([api("GET", "/api/due"), loadChapters()]);
  const nC = due.chapters.length, nR = due.retests.length;
  let html = `<div class="page-head"><h1>Due today</h1><span class="muted">${fmtDate(S.boot.today, false)}</span><div class="spacer"></div>
    <span class="muted small">Sorted by priority · <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>r</kbd> reviewed today · <kbd>l</kbd> learnt today · <kbd>Enter</kbd> details</span></div>`;
  html += `<div class="grid cols-3">
    <div class="card stat"><div class="label">Chapters due</div><div class="big">${nC}</div><div class="sub">${due.chapters.filter((c) => c.days_until_review !== null && c.days_until_review < 0).length} overdue · ${due.chapters.filter((c) => !c.last_reviewed).length} first reviews</div></div>
    <div class="card stat"><div class="label">Mistake retests due</div><div class="big">${nR}</div><div class="sub">from your mistakes log</div></div>
    <div class="card stat"><div class="label">Coming up (7 days)</div><div class="big">${due.upcoming.length}</div><div class="sub">${due.upcoming[0] ? esc(due.upcoming[0].title) + " " + relDays(due.upcoming[0].days_until_review) : "nothing scheduled"}</div></div></div>`;

  html += `<div class="section" id="review-section"><h2>Chapters to review</h2>`;
  html += nC ? dueCards(due.chapters, true) : `<div class="empty">🎉 Nothing due for review. ${S.chapters.some((c) => c.learnt) ? "Nice work." : "Mark chapters as learnt and their reviews will be scheduled from that day."}</div>`;
  html += `</div>`;
  if (nR) {
    html += `<div class="section"><h2>Mistake retests</h2><div class="due-list">` + due.retests.map((m) => `
      <div class="due-item" data-row>
        <div><div class="t">${esc(m.what_wrong)}</div>
          <div class="meta">${m.days_overdue > 0 ? `<span class="pill bad">⚠ ${plural(m.days_overdue, "day")} overdue</span>` : `<span class="pill warn">● Due today</span>`}
          <span>${esc(m.chapter_title || "No chapter")}</span>${m.source ? `<span>Source: ${esc(m.source)}</span>` : ""}<span>Logged ${fmtDate(m.logged_on)}</span></div>
          <details class="reveal"><summary>Show correct method</summary><div>${esc(m.correct_method) || "<i>No method recorded</i>"}</div></details></div>
        <div class="actions"><button data-action="retest" data-id="${m.id}" data-passed="0">✗ Not yet</button><button class="primary" data-action="retest" data-id="${m.id}" data-passed="1">✓ Passed retest</button></div>
      </div>`).join("") + `</div></div>`;
  }
  if (due.upcoming.length) {
    html += `<div class="section"><h2>Coming up this week</h2><div class="table-wrap"><table class="compact"><tbody>` +
      due.upcoming.map((c) => `<tr><td class="title-cell"><a data-action="open" data-id="${c.id}">${esc(c.title)}</a></td><td>${esc(c.strand)}</td><td>${confBadge(c.confidence)}</td><td>${fmtDate(c.next_review, false)} (${relDays(c.days_until_review)})</td></tr>`).join("") +
      `</tbody></table></div></div>`;
  }
  if (due.next_to_learn.length) {
    html += `<div class="section" id="learn-section"><h2>Next to learn</h2><p class="small muted" style="margin:-4px 0 8px">The first chapter you haven't learnt yet in each book. Press <b>Learnt today</b> when you've learnt it (<kbd>l</kbd>).</p>${dueCards(due.next_to_learn, false)}</div>`;
  }
  main.innerHTML = html;
}

function dueCards(list, isDue) {
  return `<div class="due-list">` + list.map((c) => `
      <div class="due-item" data-row data-id="${c.id}">
        <div><div class="t" data-action="open" data-id="${c.id}">${esc(c.title)}</div>
          <div class="meta">${isDue ? dueReason(c) : learntPill(c)} <span>${esc(c.strand)} · ${esc(c.book)} ch ${c.ch_num}</span>
          ${c.learnt ? `<span>Confidence ${confBadge(c.confidence)}</span>` : ""}
          ${c.last_reviewed ? `<span>Last reviewed ${relDays(-c.days_since)}</span>` : c.learnt ? `<span>Learnt ${relDays(-c.days_since_learnt)}</span>` : ""}
          ${c.marks_lost ? `<span class="pill bad">−${c.marks_lost} marks in papers${c.top_error ? " · " + esc(c.top_error) : ""}</span>` : ""}</div></div>
        <div class="actions">${isDue ? prioBadge(c.priority) : ""}${actionButton(c, true)}</div>
      </div>`).join("") + `</div>`;
}

function actionButton(c, big) {
  return c.learnt
    ? `<button class="${big ? "primary" : "small"}" data-action="review" data-id="${c.id}" title="Reviewed today (r)">✓ Reviewed${big ? " today" : ""}</button>`
    : `<button class="${big ? "primary" : "small"}" data-action="learnt" data-id="${c.id}" title="Learnt today (l)">★ Learnt${big ? " today" : ""}</button>`;
}

// ------------------------------------------------------------------ Chapters

const CH_COLS = [
  ["strand", "Strand"], ["book", "Book"], ["ch_num", "Ch"], ["title", "Chapter"], ["level", "Level"], ["first_learnt", "First learnt"],
  ["summary_status", "Summary"], ["exercises_status", "Exercises"], ["examq_status", "Exam Qs"], ["confidence", "Conf"],
  ["last_reviewed", "Last review"], ["days_since", "Days since"], ["next_review", "Next review"], ["marks_lost", "Marks lost"], ["priority", "Priority"],
];
const STATUS_FILTERS = {
  "": "Any status", learnt: "Learnt", not_learnt: "Not learnt yet", due: "Due for review", never: "Learnt, never reviewed", not_started: "Not started (all three)",
  in_progress: "In progress", done: "Complete (all three done)", weak: "Confidence 1–2", lost: "Lost marks in papers",
};

function filteredChapters() {
  const f = S.filters, q = f.q.trim().toLowerCase();
  let list = S.chapters.filter((c) => {
    if (f.strand && c.strand !== f.strand) return false;
    if (f.book && c.book !== f.book) return false;
    if (q && !(`${c.title} ${c.sections} ${c.book} ${c.strand} ${c.notes}`.toLowerCase().includes(q))) return false;
    const st = [c.summary_status, c.exercises_status, c.examq_status];
    switch (f.status) {
      case "due": return c.due;
      case "learnt": return c.learnt;
      case "not_learnt": return !c.learnt;
      case "never": return c.learnt && !c.last_reviewed;
      case "not_started": return st.every((s) => s === "not_started");
      case "in_progress": return st.some((s) => s !== "not_started") && !st.every((s) => s === "done");
      case "done": return st.every((s) => s === "done");
      case "weak": return c.confidence && c.confidence <= 2;
      case "lost": return c.marks_lost > 0;
    }
    return true;
  });
  const { key, dir } = S.sort;
  const val = (c) => { const v = c[key]; if (key.endsWith("_status")) return S.boot.statuses.indexOf(v); return v; };
  list.sort((a, b) => {
    const x = val(a), y = val(b);
    if (x === y) return a.sort_order - b.sort_order;
    if (x === null || x === undefined) return 1;      // blanks always last
    if (y === null || y === undefined) return -1;
    return (x < y ? -1 : 1) * dir;
  });
  return list;
}

async function renderChapters(main) {
  await loadChapters();
  const uniq = (k) => [...new Set(S.chapters.map((c) => c[k]))];
  const opt = (vals, cur, all) => `<option value="">${all}</option>` + vals.map((v) => `<option ${v === cur ? "selected" : ""}>${esc(v)}</option>`).join("");
  const f = S.filters;
  main.innerHTML = `<div class="page-head"><h1>Chapters</h1><span class="muted" id="ch-count"></span><div class="spacer"></div>
      <span class="muted small"><kbd>/</kbd> search · <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>l</kbd> learnt today · <kbd>r</kbd> reviewed today · <kbd>Enter</kbd> history</span></div>
    <div class="filters">
      <input type="search" id="ch-search" placeholder="Search chapters, sections, notes…" value="${esc(f.q)}" aria-label="Search">
      <select data-filter="strand" aria-label="Strand">${opt(uniq("strand"), f.strand, "All strands")}</select>
      <select data-filter="book" aria-label="Book">${opt(uniq("book"), f.book, "All books")}</select>
      <select data-filter="status" aria-label="Status">${Object.entries(STATUS_FILTERS).map(([k, v]) => `<option value="${k}" ${k === f.status ? "selected" : ""}>${v}</option>`).join("")}</select>
      <button class="ghost small" data-action="clear-filters">Clear filters</button>
    </div>
    <div class="table-wrap"><table id="ch-table"><thead></thead><tbody></tbody></table></div>`;
  drawChapterTable();
}

function drawChapterTable() {
  const list = filteredChapters();
  $("#ch-count").textContent = `${list.length} of ${S.chapters.length}`;
  $("#ch-table thead").innerHTML = `<tr>${CH_COLS.map(([k, label]) => `<th class="sortable" data-sort="${k}">${label}${S.sort.key === k ? ` <span class="arrow">${S.sort.dir > 0 ? "▲" : "▼"}</span>` : ""}</th>`).join("")}<th></th></tr>`;
  $("#ch-table tbody").innerHTML = list.map((c) => `<tr data-row data-id="${c.id}">
    <td>${esc(c.strand)}</td><td class="small">${esc(c.book)}</td><td class="num">${c.ch_num}</td>
    <td class="title-cell"><a data-action="open" data-id="${c.id}">${esc(c.title)}</a></td>
    <td>${esc(c.level)}</td><td class="small nowrap">${c.first_learnt ? fmtDate(c.first_learnt) : "—"}</td>
    <td>${statusSelect(c, "summary_status")}</td><td>${statusSelect(c, "exercises_status")}</td><td>${statusSelect(c, "examq_status")}</td>
    <td><select data-change="confidence" data-id="${c.id}" aria-label="Confidence"><option value="">–</option>${[1, 2, 3, 4, 5].map((n) => `<option ${c.confidence === n ? "selected" : ""}>${n}</option>`).join("")}</select></td>
    <td class="small">${c.last_reviewed ? fmtDate(c.last_reviewed) : "—"}</td>
    <td class="num">${c.days_since ?? "—"}</td>
    <td class="small">${c.next_review ? (c.due ? `<span class="pill ${c.days_until_review < 0 ? "bad" : "warn"}">${fmtDate(c.next_review, false)}</span>` : fmtDate(c.next_review, false)) : c.due ? `<span class="pill warn">now</span>` : "—"}</td>
    <td class="num">${c.marks_lost || "—"}</td>
    <td>${prioBadge(c.priority)}</td>
    <td>${actionButton(c, false)}</td></tr>`).join("") ||
    `<tr><td colspan="${CH_COLS.length + 1}" class="muted" style="text-align:center;padding:24px">No chapters match these filters.</td></tr>`;
  highlightSelection(false);
}

// ------------------------------------------------------------------ chapter drawer (history timeline)

async function openChapter(id) {
  const h = await api("GET", `/api/chapters/${id}/history`);
  const c = h.chapter;
  const events = [
    ...(c.first_learnt ? [{ date: c.first_learnt, kind: "l", html: `<b>First learnt</b> ★` }] : []),
    ...h.reviews.map((r) => ({ date: r.reviewed_on, kind: "r", html: `<b>Reviewed</b> — confidence ${r.confidence_before ?? "–"} → <b>${r.confidence_after}</b>${r.note ? `<div>${esc(r.note)}</div>` : ""} <button class="ghost small danger" data-action="del-review" data-id="${r.id}" title="Delete this review">Undo</button>` })),
    ...h.questions.map((q) => ({ date: q.sat_on, kind: "q", html: `<b>Lost ${q.marks_lost} mark${q.marks_lost === 1 ? "" : "s"}</b> on ${esc(q.paper_code)} ${esc(q.series)} Q${esc(q.q_num)} <span class="pill">${esc(q.error_type)}</span>${q.fix ? `<div class="small">Fix: ${esc(q.fix)}</div>` : ""}` })),
    ...h.mistakes.map((m) => ({ date: m.logged_on, kind: "m", html: `<b>Mistake logged</b>: ${esc(m.what_wrong)} ${m.retest_passed ? `<span class="pill good">✓ retest passed ${fmtDate(m.passed_on)}</span>` : m.retest_on ? `<span class="pill">retest ${fmtDate(m.retest_on)}</span>` : ""}` })),
  ].sort((a, b) => (a.date < b.date ? 1 : -1));
  const parts = c.priority_parts;
  $("#drawer-root").innerHTML = `<div class="backdrop" data-action="close-drawer"></div>
    <aside class="drawer" tabindex="-1" role="dialog" aria-label="${esc(c.title)}">
      <button class="ghost close-x" data-action="close-drawer" aria-label="Close">✕</button>
      <div class="muted small">${esc(c.strand)} · ${esc(c.book)} · Chapter ${c.ch_num} · ${esc(c.level)}</div>
      <h1 style="margin:4px 0 10px">${esc(c.title)}</h1>
      <div class="chip-row" style="margin-bottom:12px">${learntPill(c)}${c.due ? dueReason(c) : ""}</div>
      <p class="small muted" style="margin-top:0">${esc(c.sections)}</p>
      ${actionButton(c, true)}
      <div class="card section">
        <dl class="kv">
          <dt>First learnt</dt><dd><input type="date" data-change="first-learnt" data-id="${c.id}" value="${c.first_learnt || ""}" max="${S.boot.today}" aria-label="First learnt date"> <span class="small muted">${c.learnt ? relDays(-c.days_since_learnt) : "pick a past date if you learnt it before using this site"}</span></dd>
          <dt>Confidence</dt><dd>${confBadge(c.confidence)} ${c.confidence ? CONF_LABEL[c.confidence] : "Not rated yet"}</dd>
          <dt>Last reviewed</dt><dd>${c.last_reviewed ? `${fmtDate(c.last_reviewed)} (${c.days_since === 0 ? "today" : plural(c.days_since, "day") + " ago"})` : "Never"}</dd>
          <dt>Next review</dt><dd>${c.next_review ? `${fmtDate(c.next_review)} (${relDays(c.days_until_review)})` : c.learnt ? "Rate your confidence to schedule it" : "Scheduled once you've learnt it"}</dd>
          <dt>Reviews logged</dt><dd>${c.review_count}</dd>
          <dt>Marks lost in papers</dt><dd>${c.marks_lost}${c.top_error ? ` · most common error: <b>${esc(c.top_error)}</b>` : ""}</dd>
          <dt>Priority</dt><dd>${prioBadge(c.priority)} <span class="small muted">confidence ${parts.confidence} · overdue ${parts.overdue} · marks ${parts.marks} · learnt ${parts.learnt}</span></dd>
        </dl>
      </div>
      <div class="card section">
        <div class="form-row">
          <label class="field">Summary ${statusSelect(c, "summary_status")}</label>
          <label class="field">Exercises ${statusSelect(c, "exercises_status")}</label>
          <label class="field">Exam Qs ${statusSelect(c, "examq_status")}</label>
        </div>
        <label class="field" style="margin-top:10px">Notes <textarea data-change="notes" data-id="${c.id}" placeholder="Anything to remember about this chapter… (saves automatically)">${esc(c.notes)}</textarea></label>
      </div>
      <div class="section"><h2>History</h2>
        ${events.length ? `<ul class="timeline">${events.map((e) => `<li class="${e.kind}"><div class="when">${fmtDate(e.date, false)} ${fmtDate(e.date).slice(-4)}</div>${e.html}</li>`).join("")}</ul>` : `<div class="empty">Nothing yet. Press <b>Learnt today</b> when you first learn this chapter.</div>`}
      </div>
    </aside>`;
  S.drawerId = id;
  $(".drawer").focus();
}
function closeDrawer() { $("#drawer-root").innerHTML = ""; S.drawerId = null; }

// ------------------------------------------------------------------ review modal

// mode "review" (Reviewed today) or "learnt" (Learnt today): both stamp today's date and
// ask for a confidence rating, which sets when the next review is due.
function openReview(id, mode = "review") {
  const c = chapterById(id); if (!c) return;
  if (mode === "learnt" && c.learnt) mode = "review";
  const learning = mode === "learnt";
  let chosen = learning ? null : c.confidence || null;
  const iv = S.boot.settings.intervals;
  $("#modal-root").innerHTML = `<div class="backdrop modal-backdrop" data-action="close-modal"></div>
    <div class="modal" role="dialog" aria-label="${learning ? "Learnt today" : "Log review"}">
      <button class="ghost close-x" data-action="close-modal" aria-label="Close">✕</button>
      <div class="muted small">${learning ? "★ Learnt today" : "Reviewed today"} · ${fmtDate(S.boot.today)}</div>
      <h2 style="margin:4px 0 2px">${esc(c.title)}</h2>
      <div class="muted small">How confident are you ${learning ? "with it" : "now"}? Press <kbd>1</kbd>–<kbd>5</kbd>, then <kbd>Enter</kbd>.</div>
      <div class="conf-picker">${[1, 2, 3, 4, 5].map((n) => `<button data-conf="${n}"><b>${n}</b><span>${CONF_LABEL[n]}</span></button>`).join("")}</div>
      <div class="small muted" id="next-preview">&nbsp;</div>
      ${learning ? "" : `<label class="field" style="margin-top:10px">Note (optional)<textarea id="review-note" placeholder="What did you do? e.g. Ex 4B + 5 exam Qs"></textarea></label>`}
      <div class="form-row" style="justify-content:flex-end;margin-top:12px"><button data-action="close-modal">Cancel</button><button class="primary" id="review-save" disabled>${learning ? "Mark as learnt" : "Log review"}</button></div>
    </div>`;
  const pick = (n) => {
    chosen = n;
    $$(".conf-picker button").forEach((b) => b.classList.toggle("chosen", +b.dataset.conf === n));
    $("#review-save").disabled = false;
    $("#next-preview").textContent = `${learning ? "First review" : "Next review"} in ${plural(iv[n], "day")}: ${fmtDate(addDays(S.boot.today, iv[n]), false)}`;
  };
  if (chosen) pick(chosen);
  $$(".conf-picker button").forEach((b) => b.addEventListener("click", () => pick(+b.dataset.conf)));
  const save = async () => {
    if (!chosen) return;
    $("#review-save").disabled = true;
    try {
      if (learning) await api("POST", `/api/chapters/${id}/learnt`, { confidence: chosen });
      else await api("POST", `/api/chapters/${id}/review`, { confidence: chosen, note: $("#review-note").value.trim() });
      closeModal();
      toast(`${learning ? "Marked as learnt" : "Logged review"} · ${learning ? "first review" : "next"} in ${plural(iv[chosen], "day")}`);
      await afterChange(id);
    } catch (e) { toast(e.message, "error"); $("#review-save").disabled = false; }
  };
  $("#review-save").addEventListener("click", save);
  S.modalKeys = (e) => {
    if (/^[1-5]$/.test(e.key) && e.target.id !== "review-note") { pick(+e.key); e.preventDefault(); return true; }
    if (e.key === "Enter" && e.target.closest("[data-action=close-modal]")) return false;
    if (e.key === "Enter" && !(e.target.id === "review-note" && e.shiftKey)) { save(); e.preventDefault(); return true; }
    return false;
  };
  (chosen ? $("#review-save") : $(".conf-picker button")).focus();
}
function closeModal() { $("#modal-root").innerHTML = ""; S.modalKeys = null; }

async function afterChange(chapterId) {
  await render();
  refreshStreak();
  if (S.drawerId && (chapterId === undefined || chapterId === S.drawerId)) await openChapter(S.drawerId);
}

// ------------------------------------------------------------------ Dashboard

async function renderDashboard(main) {
  const d = await api("GET", "/api/dashboard");
  const pace = d.pace;
  const next = d.countdown.find((e) => e.days >= 0);
  const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
  const progRow = (g) => `<tr><td><b>${esc(g.name)}</b></td><td class="num">${g.chapters}</td>
      ${["learnt", "summary_done", "exercises_done", "examq_done"].map((k) => `<td><div style="display:flex;gap:8px;align-items:center"><div class="progress" style="flex:1"><i style="width:${pct(g[k], g.chapters)}%"></i></div><span class="num small">${g[k]}/${g.chapters}</span></div></td>`).join("")}
      <td class="num">${g.avg_confidence ?? "—"}</td><td class="num">${g.weak || "—"}</td><td class="num">${g.due || "—"}</td></tr>`;
  const progTable = (rows, first) => `<div class="table-wrap"><table class="compact"><thead><tr><th>${first}</th><th>Chapters</th><th>Learnt</th><th>Summary</th><th>Exercises</th><th>Exam Qs</th><th>Avg conf</th><th>Conf 1–2</th><th>Due</th></tr></thead><tbody>${rows.map(progRow).join("")}</tbody></table></div>`;

  main.innerHTML = `<div class="page-head"><h1>Dashboard</h1><span class="muted">${fmtDate(d.today)}</span></div>
    <div class="grid cols-4">
      <div class="card stat"><div class="label">Next exam</div>${next ? `<div class="big">${next.days}<span style="font-size:14px;font-weight:600"> days</span></div><div class="sub">${esc(next.name)} · ${fmtDate(next.date)}${next.confirmed ? "" : " (estimated)"}</div>` : `<div class="big">—</div><div class="sub">Add exam dates in Settings</div>`}</div>
      <div class="card stat"><div class="label">Learnt so far</div><div class="big">${pace.learnt}<span style="font-size:14px;font-weight:600"> / ${pace.total}</span></div><div class="sub">${paceLine(pace)}</div></div>
      <div class="card stat"><div class="label">Review streak</div><div class="big">🔥 ${d.streak}</div><div class="sub">${plural(d.reviews_this_week, "review")} this week · ${d.reviews_total} total</div></div>
      <div class="card stat"><div class="label">Overdue now</div><div class="big" style="color:var(${d.due_count ? "--bad" : "--text"})">${d.due_count}</div><div class="sub">chapters due · ${plural(d.open_retests, "open retest")}</div></div>
    </div>

    <div class="grid cols-2 section">
      <div class="card"><h2>Learning pace</h2>
        <p class="small muted" style="margin-top:0">Your pace over the last 4 weeks compared with the pace you need to learn every chapter by <b>${pace.target ? fmtDate(pace.target) : "—"}</b> (change this in Settings).</p>
        <div class="hero ${pace.verdict === "behind" ? "bad" : pace.verdict === "ahead" || pace.verdict === "all learnt" ? "good" : ""}">${PACE_LABEL[pace.verdict]}</div>
        <dl class="kv" style="margin-top:10px">
          <dt>Learnt</dt><dd>${pace.learnt} of ${pace.total} chapters · ${pace.remaining} to go</dd>
          <dt>This week</dt><dd>${plural(pace.this_week, "chapter")}</dd>
          <dt>Your pace</dt><dd>${pace.per_week} chapters/week <span class="small muted">(${pace.recent} in the last 4 weeks)</span></dd>
          <dt>Needed</dt><dd>${pace.required_per_week !== null ? pace.required_per_week + " chapters/week" : "—"}${pace.days_left !== null && pace.days_left > 0 ? ` <span class="small muted">(${plural(pace.days_left, "day")} left)</span>` : ""}</dd>
          <dt>Projected finish</dt><dd>${pace.projected_finish ? fmtDate(pace.projected_finish) : pace.remaining ? "— (learn a few chapters to see this)" : "Done!"}</dd>
        </dl></div>
      <div class="card"><h2>Exam countdown</h2>
        <table class="compact"><tbody>${d.countdown.map((e) => `<tr><td>${esc(e.name)}</td><td class="small">${fmtDate(e.date)}${e.confirmed ? "" : ` <span class="pill warn" title="Placeholder — update in Settings when OCR publishes the timetable">est.</span>`}</td><td class="num"><b>${e.days >= 0 ? plural(e.days, "day") : "done"}</b></td></tr>`).join("") || `<tr><td class="muted">No exams set — add them in Settings.</td></tr>`}</tbody></table></div>
    </div>

    <div class="section"><h2>Progress by strand</h2>${progTable(d.by_strand, "Strand")}</div>
    <div class="section"><h2>Progress by book</h2>${progTable(d.by_book, "Book")}</div>

    <div class="grid cols-2 section">
      <div class="card"><h2>Top 10 weakest chapters</h2>
        ${d.weakest.length ? `<table class="compact"><thead><tr><th>#</th><th>Chapter</th><th>Conf</th><th>Marks lost</th><th>Main error</th></tr></thead><tbody>${d.weakest.map((c, i) => `<tr><td class="num">${i + 1}</td><td class="title-cell"><a data-action="open" data-id="${c.id}">${esc(c.title)}</a><div class="small muted">${esc(c.strand)}</div></td><td>${confBadge(c.confidence)}</td><td class="num">${c.marks_lost || "—"}</td><td class="small">${esc(c.top_error || "—")}</td></tr>`).join("")}</tbody></table>`
          : `<div class="empty">Rate your confidence on some chapters (or log paper questions) and your weakest will show here.</div>`}</div>
      <div class="card"><h2>Past papers vs A*</h2>
        <table class="compact"><thead><tr><th>Paper</th><th>Attempts</th><th>Average</th><th>A* boundary</th><th>Gap</th></tr></thead><tbody>
        ${d.papers.map((p) => `<tr><td><b>${esc(p.code)}</b><div class="small muted">${esc(p.name)}</div></td><td class="num">${p.points.length}</td><td class="num">${p.average !== null ? p.average + "%" : "—"}</td><td class="num">${p.a_star_percent !== null ? p.a_star_percent + "%" : `<span class="muted small">not entered</span>`}</td>
          <td>${p.average !== null && p.a_star_percent !== null ? `<span class="pill ${p.average >= p.a_star_percent ? "good" : "bad"}">${p.average >= p.a_star_percent ? "▲ +" : "▼ "}${(p.average - p.a_star_percent).toFixed(1)}</span>` : "—"}</td></tr>`).join("")}
        </tbody></table></div>
    </div>`;
}

const PACE_LABEL = { "ahead": "▲ Ahead of pace", "on track": "● On track", "behind": "▼ Behind pace", "not started": "Not started yet", "all learnt": "✓ Everything learnt", "no target": "Set a target date" };
function paceLine(p) {
  if (p.verdict === "all learnt") return "Every chapter learnt";
  if (p.required_per_week === null) return `${p.per_week}/week recently`;
  return `${PACE_LABEL[p.verdict]} · ${p.per_week}/week vs ${p.required_per_week}/week needed`;
}

// ------------------------------------------------------------------ charts

function lineChart(s) {
  const W = 320, H = 170, L = 30, R = 12, T = 12, B = 24;
  const pts = s.points;
  const ts = pts.map((p) => parseISO(p.date).getTime());
  let t0 = Math.min(...ts), t1 = Math.max(...ts);
  if (!pts.length) { t0 = 0; t1 = 1; }
  if (t0 === t1) { t0 -= 86400000 * 15; t1 += 86400000 * 15; }
  const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - v / 100) * (H - T - B);
  let g = "";
  for (const v of [0, 25, 50, 75, 100]) g += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-text" x="${L - 5}" y="${y(v) + 3}" text-anchor="end">${v}%</text>`;
  if (pts.length) {
    const fmt = (t) => new Date(t).toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
    g += `<text class="axis-text" x="${L}" y="${H - 6}">${fmt(t0)}</text><text class="axis-text" x="${W - R}" y="${H - 6}" text-anchor="end">${fmt(t1)}</text>`;
  }
  if (s.a_star_percent !== null) {
    const yy = y(s.a_star_percent);
    g += `<line class="ref" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text class="ref-label" x="${W - R}" y="${yy - 4}" text-anchor="end">A* ${s.a_star_percent}%</text>`;
  }
  if (pts.length > 1) g += `<polyline class="series" points="${pts.map((p, i) => `${x(ts[i])},${y(p.percent)}`).join(" ")}"/>`;
  pts.forEach((p, i) => {
    const tip = `${esc(s.code)} · ${esc(p.series)}<br>${fmtDate(p.date)} · <b>${p.percent}%</b>${p.grade ? ` · ${esc(p.grade)}` : ""}`;
    g += `<circle class="dot" cx="${x(ts[i])}" cy="${y(p.percent)}" r="4.5"/><circle class="hit" cx="${x(ts[i])}" cy="${y(p.percent)}" r="11" data-tip="${esc(tip)}"/>`;
  });
  return `<div class="chart" role="img" aria-label="${esc(s.code)} percentage over time"><svg viewBox="0 0 ${W} ${H}">${g}</svg></div>`;
}

document.addEventListener("mouseover", (e) => {
  const t = e.target.closest("[data-tip]"); const tip = $("#tooltip");
  if (!t) { tip.hidden = true; return; }
  tip.innerHTML = t.dataset.tip; tip.hidden = false;
  const r = t.getBoundingClientRect();
  tip.style.left = `${Math.min(innerWidth - 270, r.left + r.width / 2 + 8)}px`; tip.style.top = `${r.top - 44}px`;
});

// ------------------------------------------------------------------ Past papers

async function renderPapers(main) {
  const [papers, chart, bounds] = await Promise.all([api("GET", "/api/papers"), api("GET", "/api/papers/chart"), api("GET", "/api/boundaries"), loadChapters()]);
  const cfg = Object.fromEntries(S.boot.settings.papers.map((p) => [p.code, p]));
  const first = S.boot.settings.papers[0];
  main.innerHTML = `<div class="page-head"><h1>Past papers</h1><div class="spacer"></div><span class="muted small"><kbd>n</kbd> new attempt</span></div>
    ${seriesDatalist()}
    <form class="card" id="paper-form"><h2>Log an attempt</h2>
      <div class="form-row">
        <label class="field">Paper<select name="paper_code" required>${paperOptions(first.code)}</select></label>
        <label class="field">Series / year<input name="series" list="series-list" placeholder="June 2019" required size="16"></label>
        <label class="field">Date sat<input name="sat_on" type="date" value="${S.boot.today}" required></label>
        <label class="field">Mark<input name="mark" type="number" step="0.5" min="0" required style="width:80px"></label>
        <label class="field">Out of<input name="max_mark" type="number" min="1" value="${first.max}" required style="width:80px"></label>
        <label class="field">Time (min)<input name="time_taken_min" type="number" min="0" step="1" style="width:90px"></label>
        <label class="field" style="flex:1;min-width:160px">Notes<input name="notes" placeholder="optional"></label>
        <button class="primary" type="submit">Add attempt</button>
      </div></form>

    <div class="section"><h2>Percentage over time</h2>
      <div class="grid cols-4">${chart.map((s) => `<div class="card chart-card"><h3>${esc(s.code)}</h3><div class="small muted">${esc(s.name)}${s.average !== null ? ` · avg ${s.average}%` : ""}</div>${s.points.length ? lineChart(s) : `<div class="empty small" style="margin-top:8px">No attempts yet</div>`}</div>`).join("")}</div>
      <p class="small muted">Dashed line: average A* boundary across the series you've entered for that paper.</p></div>

    <div class="section"><h2>Attempts</h2>
      ${papers.length ? `<div class="table-wrap"><table class="compact"><thead><tr><th>Date</th><th>Paper</th><th>Series</th><th>Mark</th><th>%</th><th>Grade</th><th>Time</th><th>Questions</th><th></th></tr></thead><tbody>
        ${papers.map((p) => paperRow(p, cfg)).join("")}</tbody></table></div>` : `<div class="empty">No attempts logged yet. Add one above, then log the questions you dropped marks on.</div>`}
    </div>

    <div class="section card"><h2>Grade boundaries</h2>
      <p class="small muted" style="margin-top:0">Enter raw-mark boundaries for each paper and series (from OCR's published grade boundaries). Grades are worked out from these; nothing is pre-filled.</p>
      <form id="bound-form" class="form-row">
        <label class="field">Paper<select name="paper_code">${paperOptions()}</select></label>
        <label class="field">Series<input name="series" list="series-list" required size="14" placeholder="June 2019"></label>
        ${["a_star", "a", "b", "c", "d", "e"].map((k, i) => `<label class="field">${S.boot.grades[i]}<input name="${k}" type="number" min="0" step="1" style="width:64px"></label>`).join("")}
        <button type="submit">Save boundaries</button></form>
      ${bounds.length ? `<div class="table-wrap section"><table class="compact"><thead><tr><th>Paper</th><th>Series</th>${S.boot.grades.map((g) => `<th>${g}</th>`).join("")}<th></th></tr></thead><tbody>
        ${bounds.map((b) => `<tr><td>${esc(b.paper_code)}</td><td>${esc(b.series)}</td>${["a_star", "a", "b", "c", "d", "e"].map((k) => `<td class="num">${b[k] ?? "—"}</td>`).join("")}<td class="inline-actions"><button class="small" data-action="edit-bound" data-b='${esc(JSON.stringify(b))}'>Edit</button><button class="small danger" data-action="del-bound" data-id="${b.id}">Delete</button></td></tr>`).join("")}
      </tbody></table></div>` : ""}
    </div>`;

  const form = $("#paper-form");
  const pf = (k) => form.elements.namedItem(k);
  pf("paper_code").addEventListener("change", () => { pf("max_mark").value = cfg[pf("paper_code").value].max; });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const num = (k) => (fd.get(k) === "" ? null : Number(fd.get(k)));
    const body = { paper_code: fd.get("paper_code"), series: fd.get("series"), sat_on: fd.get("sat_on"), mark: num("mark"), max_mark: num("max_mark"), time_taken_min: num("time_taken_min"), notes: fd.get("notes") };
    const p = await guard(() => api("POST", "/api/papers", body));
    S.papersOpen.add(p.id);
    toast(`Logged ${p.paper_code}: ${p.percent}%${p.grade ? " (" + p.grade + ")" : ""}`);
    render();
  });
  $("#bound-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = { paper_code: fd.get("paper_code"), series: fd.get("series") };
    for (const k of ["a_star", "a", "b", "c", "d", "e"]) body[k] = fd.get(k) === "" ? null : Number(fd.get(k));
    await guard(() => api("PUT", "/api/boundaries", body));
    toast("Boundaries saved"); render();
  });
  $$("form.q-form").forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    const body = { q_num: fd.get("q_num"), chapter_id: fd.get("chapter_id") || null, marks_lost: fd.get("marks_lost") === "" ? null : Number(fd.get("marks_lost")), error_type: fd.get("error_type"), fix: fd.get("fix") };
    await guard(() => api("POST", `/api/papers/${f.dataset.paper}/questions`, body));
    toast("Question logged — chapter priority updated"); render();
  }));
}

function paperRow(p, cfg) {
  const open = S.papersOpen.has(p.id);
  const qRows = p.questions.map((q) => `<tr><td class="num">${esc(q.q_num)}</td><td>${esc(q.chapter_title || "—")}</td><td class="num">${q.marks_lost}</td><td>${esc(q.error_type)}</td><td>${esc(q.fix)}</td><td><button class="small ghost danger" data-action="del-question" data-id="${q.id}" aria-label="Delete question">✕</button></td></tr>`).join("");
  return `<tr data-row><td class="small">${fmtDate(p.sat_on)}</td><td><b>${esc(p.paper_code)}</b></td><td>${esc(p.series)}</td><td class="num">${p.mark ?? "—"} / ${p.max_mark}</td><td class="num"><b>${p.percent ?? "—"}${p.percent !== null ? "%" : ""}</b></td>
    <td>${p.grade ? `<span class="pill ${p.grade === "A*" ? "good" : p.grade === "A" ? "info" : ""}">${esc(p.grade)}</span>` : `<span class="small muted" title="Enter this series' boundaries below">no boundaries</span>`}</td>
    <td class="num">${p.time_taken_min ? p.time_taken_min + " min" : "—"}</td>
    <td><button class="small" data-action="toggle-paper" data-id="${p.id}">${open ? "▾" : "▸"} ${plural(p.questions.length, "question")} (−${p.marks_lost_logged})</button></td>
    <td><button class="small ghost danger" data-action="del-paper" data-id="${p.id}">Delete</button></td></tr>
    ${open ? `<tr class="question-row"><td colspan="9">
      ${p.notes ? `<div class="small" style="margin-bottom:6px">Notes: ${esc(p.notes)}</div>` : ""}
      ${p.questions.length ? `<table class="compact sub-table"><thead><tr><th>Q</th><th>Chapter</th><th>Marks lost</th><th>Error type</th><th>Fix</th><th></th></tr></thead><tbody>${qRows}</tbody></table>` : `<div class="small muted">Log each question you dropped marks on:</div>`}
      <form class="form-row q-form" data-paper="${p.id}" style="margin-top:6px">
        <label class="field">Q no.<input name="q_num" required style="width:64px" placeholder="7(b)"></label>
        <label class="field" style="flex:1;min-width:220px">Chapter<select name="chapter_id" required>${chapterOptions()}</select></label>
        <label class="field">Marks lost<input name="marks_lost" type="number" min="0" step="0.5" required style="width:80px"></label>
        <label class="field">Error type<select name="error_type" required><option value="">Choose…</option>${S.boot.error_types.map((t) => `<option>${t}</option>`).join("")}</select></label>
        <label class="field" style="flex:1;min-width:180px">Fix<input name="fix" placeholder="What will you do differently?"></label>
        <button type="submit" class="primary">Add</button></form></td></tr>` : ""}`;
}

// ------------------------------------------------------------------ Mistakes

async function renderMistakes(main) {
  const [rows] = await Promise.all([api("GET", "/api/mistakes"), loadChapters()]);
  const retestDays = S.boot.settings.mistake_retest_days;
  const f = S.mistakeFilter;
  const shown = rows.filter((m) => f === "all" || (f === "open" && !m.retest_passed) || (f === "due" && m.retest_due) || (f === "passed" && m.retest_passed));
  main.innerHTML = `<div class="page-head"><h1>Mistakes log</h1><div class="spacer"></div><span class="muted small"><kbd>n</kbd> new mistake</span></div>
    <form class="card" id="mistake-form"><h2>Log a mistake <span class="muted small" style="font-weight:500">· dated ${fmtDate(S.boot.today)} automatically</span></h2>
      <div class="form-row">
        <label class="field" style="flex:2;min-width:240px">Chapter<select name="chapter_id" required>${chapterOptions()}</select></label>
        <label class="field" style="flex:1;min-width:160px">Source<input name="source" placeholder="e.g. June 2019 H240/01 Q7, Ex 4C Q12"></label>
      </div>
      <div class="form-row" style="margin-top:8px">
        <label class="field" style="flex:1;min-width:240px">What went wrong<textarea name="what_wrong" required placeholder="e.g. Forgot the ± when square-rooting"></textarea></label>
        <label class="field" style="flex:1;min-width:240px">Correct method<textarea name="correct_method" placeholder="How to do it properly"></textarea></label>
      </div>
      <div class="form-row" style="margin-top:8px">
        <label class="field">Retest on<input name="retest_on" type="date" value="${addDays(S.boot.today, retestDays)}"></label>
        <div class="chip-row" style="padding-bottom:4px">${[3, 7, 14, 30].map((n) => `<button type="button" class="small" data-retest-days="${n}">+${n}d</button>`).join("")}</div>
        <div class="spacer" style="flex:1"></div><button class="primary" type="submit">Log mistake</button>
      </div></form>
    <div class="section"><div class="filters">
      ${[["open", "Open"], ["due", "Retest due"], ["passed", "Passed"], ["all", "All"]].map(([k, v]) => `<button class="small ${f === k ? "primary" : ""}" data-action="mistake-filter" data-f="${k}">${v} (${rows.filter((m) => k === "all" || (k === "open" && !m.retest_passed) || (k === "due" && m.retest_due) || (k === "passed" && m.retest_passed)).length})</button>`).join("")}</div>
      ${shown.length ? `<div class="table-wrap"><table class="compact"><thead><tr><th>Date</th><th>Chapter</th><th>Source</th><th>What went wrong</th><th>Correct method</th><th>Retest</th><th>Passed</th><th></th></tr></thead><tbody>
        ${shown.map((m) => `<tr data-row><td class="small">${fmtDate(m.logged_on)}</td><td class="title-cell">${m.chapter_id ? `<a data-action="open" data-id="${m.chapter_id}">${esc(m.chapter_title)}</a>` : "—"}</td><td class="small">${esc(m.source)}</td><td>${esc(m.what_wrong)}</td><td class="small">${esc(m.correct_method)}</td>
          <td class="small">${m.retest_passed ? "—" : `<input type="date" value="${m.retest_on || ""}" data-change="retest-date" data-id="${m.id}" aria-label="Retest date"> ${m.retest_due ? `<span class="pill bad">due</span>` : ""}`}</td>
          <td><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-change="passed" data-id="${m.id}" ${m.retest_passed ? "checked" : ""}> ${m.retest_passed ? `<span class="small muted">${fmtDate(m.passed_on)}</span>` : ""}</label></td>
          <td><button class="small ghost danger" data-action="del-mistake" data-id="${m.id}">Delete</button></td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty">No mistakes here.</div>`}</div>`;

  const form = $("#mistake-form");
  $$("[data-retest-days]", form).forEach((b) => b.addEventListener("click", () => { form.elements.namedItem("retest_on").value = addDays(S.boot.today, +b.dataset.retestDays); }));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    await guard(() => api("POST", "/api/mistakes", { chapter_id: fd.get("chapter_id"), source: fd.get("source"), what_wrong: fd.get("what_wrong"), correct_method: fd.get("correct_method"), retest_on: fd.get("retest_on") || null }));
    toast("Mistake logged"); render();
  });
}

// ------------------------------------------------------------------ Settings

async function renderSettings(main) {
  const s = S.boot.settings = await api("GET", "/api/settings");
  main.innerHTML = `<div class="page-head"><h1>Settings</h1></div>
  <div class="grid cols-2">
    <form class="card" data-settings="intervals"><h2>Spaced repetition intervals</h2>
      <p class="small muted" style="margin-top:0">Days from your last review until the next one, by confidence.</p>
      <div class="form-row">${[1, 2, 3, 4, 5].map((n) => `<label class="field">${n} · ${CONF_LABEL[n]}<input type="number" min="1" max="365" name="${n}" value="${s.intervals[n]}" style="width:90px"></label>`).join("")}</div>
      <div class="form-row" style="margin-top:10px"><button class="primary">Save</button><button type="button" class="ghost small" data-reset="intervals">Reset to 3/7/14/30/60</button></div></form>

    <form class="card" data-settings="priority"><h2>Priority score</h2>
      <p class="small muted" style="margin-top:0">Relative weights of each part of the 0–100 score used to sort the due list.</p>
      <div class="form-row">${[["confidence", "Low confidence"], ["overdue", "How overdue"], ["marks", "Marks lost"], ["learnt", "Learnt yet"]].map(([k, l]) => `<label class="field">${l}<input type="number" min="0" step="1" name="${k}" value="${s.priority_weights[k]}" style="width:90px"></label>`).join("")}
        <label class="field" title="Marks lost at which the marks part reaches half weight">Marks half-point<input type="number" min="1" step="1" name="marks_half_point" value="${s.marks_half_point}" style="width:90px"></label></div>
      <div class="form-row" style="margin-top:10px"><button class="primary">Save</button><button type="button" class="ghost small" data-reset="priority_weights,marks_half_point">Reset</button></div></form>

    <form class="card" data-settings="exams"><h2>Exam dates</h2>
      <p class="small muted" style="margin-top:0">Placeholders until OCR publishes the June 2028 timetable. Tick "confirmed" once you have the real date.</p>
      <div id="exam-rows">${s.exams.map((e) => examRow(e)).join("")}</div>
      <div class="form-row" style="margin-top:10px"><button type="button" class="small" data-action="add-exam">+ Add exam</button><div style="flex:1"></div><button class="primary">Save</button></div></form>

    <form class="card" data-settings="papers"><h2>Papers &amp; max marks</h2>
      <p class="small muted" style="margin-top:0">H240 papers are 100 marks each (OCR spec). Y540–Y543 default to 75 — check against the H245 specification.</p>
      ${s.papers.map((p, i) => `<div class="form-row" style="margin-bottom:6px"><label class="field" style="width:90px">${i === 0 ? "Code" : ""}<input value="${esc(p.code)}" disabled></label><label class="field" style="flex:1">${i === 0 ? "Name" : ""}<input name="name-${i}" value="${esc(p.name)}"></label><label class="field">${i === 0 ? "Max mark" : ""}<input type="number" min="1" name="max-${i}" value="${p.max}" style="width:90px"></label></div>`).join("")}
      <div class="form-row" style="margin-top:10px"><button class="primary">Save</button></div></form>

    <form class="card" data-settings="general"><h2>General</h2>
      <div class="form-row">
        <label class="field">Theme<select name="theme">${["system", "light", "dark"].map((t) => `<option ${s.theme === t ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        <label class="field">Mistake retest gap (days)<input type="number" min="1" max="365" name="mistake_retest_days" value="${s.mistake_retest_days}" style="width:90px"></label>
        <label class="field" title="Used for the learning pace on the Dashboard">Learn every chapter by<input type="date" name="learn_by" value="${s.learn_by || ""}"></label>
        <span class="small muted" style="padding-bottom:8px">blank = your first exam</span>
      </div>
      <div class="form-row" style="margin-top:10px"><button class="primary">Save</button></div></form>
  </div>

  <div class="card section"><h2>Your tracker</h2>
    <dl class="kv"><dt>Your code</dt><dd><code class="code-big" id="my-code">${esc(S.tracker.code)}</code> <button class="small" data-action="copy-code">Copy</button></dd></dl>
    <p class="small muted">Use this code to open your tracker on any device. Keep it private: anyone with it can open and change your tracker, and it can't be recovered if you lose it.</p>
    <div class="form-row"><button data-action="logout">Log out on this device</button></div>
    <h3 class="section">Download your data</h3>
    <div class="form-row">
      <button data-action="export-json">Export JSON (everything)</button>
      <button data-action="export-csv">Export CSV (zip of tables)</button>
    </div>
    <h3 class="section">Import</h3>
    <p class="small muted" style="margin-top:0">Works with exports from this site and from the old desktop app. A backup is kept first, so you can undo an import from the list below.</p>
    <div class="form-row">
      <label class="field">Import JSON export (replaces all data)<input type="file" accept=".json,application/json" id="import-json"></label>
      <label class="field">Import CSV into table<select id="import-table">${S.boot.tables.map((t) => `<option>${t}</option>`).join("")}</select></label>
      <label class="field">CSV file (replaces that table)<input type="file" accept=".csv,text/csv" id="import-csv"></label>
    </div>
    <h3 class="section">Backups</h3>
    <p class="small muted" style="margin-top:0">The server keeps a copy of your tracker from the start of each day you use it (last 14 days), plus one before every restore.</p>
    <div id="backup-list" class="muted small">Loading…</div>
  </div>`;
  loadBackups();

  $$("form[data-settings]").forEach((form) => form.addEventListener("submit", (e) => { e.preventDefault(); saveSettingsForm(form); }));
  $("#import-json").addEventListener("change", async (e) => {
    const file = e.target.files[0]; if (!file) return;
    let doc;
    try { doc = svc.normalize(JSON.parse(await file.text())); } catch (err) { toast(err instanceof SyntaxError ? "That file isn't valid JSON" : err.message, "error"); e.target.value = ""; return; }
    if (!confirm(`Replace ALL your data with this file (${doc.chapters.length} chapters, ${doc.reviews.length} reviews, ${doc.papers.length} papers, ${doc.mistakes.length} mistakes)?`)) { e.target.value = ""; return; }
    try { await S.tracker.flush(); await S.tracker.remote.backupNow(S.tracker.code); }
    catch (err) { toast(`Import cancelled: couldn't back up your current data first (${err.message})`, "error"); e.target.value = ""; return; }
    S.tracker.replace(doc);
    toast("Import complete"); await reloadAll();
  });
  $("#import-csv").addEventListener("change", async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const table = $("#import-table").value;
    const rows = parseCSV(await file.text());
    if (!confirm(`Replace the whole "${table}" table with the ${rows.length} rows in this CSV?`)) { e.target.value = ""; return; }
    try { await S.tracker.flush(); await S.tracker.remote.backupNow(S.tracker.code); }
    catch (err) { toast(`Import cancelled: couldn't back up your current data first (${err.message})`, "error"); e.target.value = ""; return; }
    try { S.tracker.apply((d) => svc.replaceTable(d, table, rows)); } catch (err) { toast(err.message, "error"); e.target.value = ""; return; }
    toast(`Imported ${rows.length} rows into ${table}`); await reloadAll();
  });
}

function examRow(e) {
  return `<div class="form-row exam-row" style="margin-bottom:6px"><input name="exam-name" value="${esc(e.name)}" placeholder="Exam name" style="flex:1;min-width:180px" required>
    <input type="date" name="exam-date" value="${e.date}" required><label class="small" style="display:flex;gap:4px;align-items:center"><input type="checkbox" name="exam-confirmed" ${e.confirmed ? "checked" : ""}> confirmed</label>
    <button type="button" class="small ghost danger" data-action="remove-exam" aria-label="Remove">✕</button></div>`;
}

async function saveSettingsForm(form) {
  const s = S.boot.settings, kind = form.dataset.settings, fd = new FormData(form);
  let body;
  if (kind === "intervals") body = { intervals: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [String(n), parseInt(fd.get(String(n)), 10)])) };
  if (kind === "priority") body = { priority_weights: Object.fromEntries(["confidence", "overdue", "marks", "learnt"].map((k) => [k, Number(fd.get(k))])), marks_half_point: Number(fd.get("marks_half_point")) };
  if (kind === "exams") body = { exams: $$(".exam-row", form).map((r) => ({ name: $("[name=exam-name]", r).value.trim(), date: $("[name=exam-date]", r).value, confirmed: $("[name=exam-confirmed]", r).checked })) };
  if (kind === "papers") body = { papers: s.papers.map((p, i) => ({ code: p.code, name: fd.get(`name-${i}`), max: Number(fd.get(`max-${i}`)) })) };
  if (kind === "general") body = { theme: fd.get("theme"), mistake_retest_days: parseInt(fd.get("mistake_retest_days"), 10), learn_by: fd.get("learn_by") || null };
  S.boot.settings = await guard(() => api("PUT", "/api/settings", body));
  applyTheme(); await loadChapters(); toast("Settings saved");
}

async function reloadAll() { await loadBoot(); await render(); refreshStreak(); }

async function loadBackups() {
  const el = $("#backup-list");
  try {
    await S.tracker.flush();
    const list = await S.tracker.remote.listBackups(S.tracker.code);
    if (!el.isConnected) return;
    el.classList.remove("muted", "small");
    el.innerHTML = list.length ? `<div class="table-wrap"><table class="compact"><thead><tr><th>Saved</th><th>Kind</th><th>Size</th><th></th></tr></thead><tbody>${list.map((b) =>
      `<tr><td class="small">${esc(new Date(b.saved_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }))}</td><td class="small">${{ daily: "Start of day", "pre-restore": "Before a restore", "pre-import": "Before an import" }[b.kind] || esc(b.kind)}</td><td class="small num">${Math.max(1, Math.round(b.size / 1024))} KB</td><td><button class="small" data-action="restore" data-backup="${b.id}" data-when="${esc(new Date(b.saved_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }))}">Restore</button></td></tr>`).join("")}</tbody></table></div>`
      : `<span class="muted small">No backups yet. The first one is made the first time you save something on a new day.</span>`;
  } catch (e) {
    if (el.isConnected) el.textContent = `Couldn't load backups: ${e.message}`;
  }
}

function download(filename, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ------------------------------------------------------------------ events

document.addEventListener("click", async (e) => {
  const sortTh = e.target.closest("th[data-sort]");
  if (sortTh) {
    const k = sortTh.dataset.sort;
    S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : (["priority", "marks_lost", "days_since"].includes(k) ? -1 : 1) };
    drawChapterTable(); return;
  }
  const el = e.target.closest("[data-action]"); if (!el) return;
  const id = el.dataset.id || null;
  const a = el.dataset.action;
  if (el.tagName === "A") e.preventDefault();
  switch (a) {
    case "open": return openChapter(id);
    case "review": return openReview(id);
    case "learnt": return openReview(id, "learnt");
    case "close-drawer": return closeDrawer();
    case "close-modal": return closeModal();
    case "theme": return cycleTheme();
    case "help": return openHelp();
    case "clear-filters": S.filters = { q: "", strand: "", book: "", status: "" }; return render();
    case "del-review":
      if (!confirm("Delete this review from the history?")) return;
      await guard(() => api("DELETE", `/api/reviews/${id}`)); toast("Review removed"); return afterChange(S.drawerId);
    case "retest": {
      const passed = el.dataset.passed === "1";
      await guard(() => api("POST", `/api/mistakes/${id}/retest`, { passed }));
      toast(passed ? "Retest passed ✓" : `Rescheduled in ${plural(S.boot.settings.mistake_retest_days, "day")}`); return render();
    }
    case "toggle-paper": S.papersOpen.has(id) ? S.papersOpen.delete(id) : S.papersOpen.add(id); return render();
    case "del-paper": if (!confirm("Delete this attempt and its question breakdown?")) return; await guard(() => api("DELETE", `/api/papers/${id}`)); return render();
    case "del-question": await guard(() => api("DELETE", `/api/questions/${id}`)); return render();
    case "del-bound": await guard(() => api("DELETE", `/api/boundaries/${id}`)); return render();
    case "edit-bound": {
      const b = JSON.parse(el.dataset.b), f = $("#bound-form");
      const fld = (k) => f.elements.namedItem(k);
      fld("paper_code").value = b.paper_code; fld("series").value = b.series;
      for (const k of ["a_star", "a", "b", "c", "d", "e"]) fld(k).value = b[k] ?? "";
      fld("a_star").focus(); return;
    }
    case "mistake-filter": S.mistakeFilter = el.dataset.f; return render();
    case "del-mistake": if (!confirm("Delete this mistake?")) return; await guard(() => api("DELETE", `/api/mistakes/${id}`)); return render();
    case "add-exam": $("#exam-rows").insertAdjacentHTML("beforeend", examRow({ name: "", date: S.boot.today, confirmed: false })); return;
    case "remove-exam": el.closest(".exam-row").remove(); return;
    case "restore":
      if (!confirm(`Restore your tracker to how it was on ${el.dataset.when}? Your current data is kept as a backup first.`)) return;
      await guard(async () => { await S.tracker.flush(); await S.tracker.remote.restoreBackup(S.tracker.code, Number(el.dataset.backup)); await S.tracker.refresh(); });
      toast("Backup restored"); return reloadAll();
    case "export-json":
      return download(`revision-tracker-${today()}.json`, JSON.stringify({ ...S.tracker.doc, exported_at: new Date().toISOString() }, null, 1), "application/json");
    case "export-csv":
      return download(`revision-tracker-csv-${today()}.zip`, zip(docToCSVs(S.tracker.doc)), "application/zip");
    case "copy-code":
      try { await navigator.clipboard.writeText(S.tracker.code); toast("Code copied"); } catch { toast("Couldn't copy: select the code and copy it yourself", "error"); }
      return;
    case "logout":
      if (S.tracker.unsaved && !confirm("Some changes haven't saved yet. Log out anyway?")) return;
      if (!confirm("Log out on this device? You'll need your code to open your tracker again.")) return;
      forgetCode(); location.hash = ""; location.reload(); return;
  }
});

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-reset]"); if (!b) return;
  const keys = b.dataset.reset.split(",");
  guard(async () => { S.boot.settings = await api("POST", "/api/settings/reset", { keys }); toast("Reset to defaults"); render(); });
});

document.addEventListener("change", async (e) => {
  const el = e.target;
  if (el.dataset.filter) { S.filters[el.dataset.filter] = el.value; S.sel = 0; return drawChapterTable(); }
  const kind = el.dataset.change; if (!kind) return;
  const id = el.dataset.id;
  if (kind === "status") { await guard(() => api("PATCH", `/api/chapters/${id}`, { [el.dataset.field]: el.value })); el.className = `st-${el.value}`; return softRefresh(id); }
  if (kind === "confidence") { await guard(() => api("PATCH", `/api/chapters/${id}`, { confidence: el.value ? Number(el.value) : null })); return softRefresh(id); }
  if (kind === "first-learnt") {
    try { await api("PATCH", `/api/chapters/${id}`, { first_learnt: el.value || null }); toast(el.value ? "First learnt date saved" : "Marked as not learnt"); }
    catch (err) { toast(err.message, "error"); }
    return softRefresh(id);
  }
  if (kind === "notes") { await guard(() => api("PATCH", `/api/chapters/${id}`, { notes: el.value })); toast("Notes saved"); return loadChapters(); }
  if (kind === "retest-date") { await guard(() => api("PATCH", `/api/mistakes/${id}`, { retest_on: el.value || null })); toast("Retest date updated"); return render(); }
  if (kind === "passed") { await guard(() => api("POST", `/api/mistakes/${id}/retest`, { passed: el.checked })); if (!el.checked) toast("Marked not passed — retest rescheduled"); return render(); }
});

// Keep focus and scroll position when changing a status inline.
async function softRefresh(id) {
  await loadChapters();
  if (S.route === "chapters") drawChapterTable();
  else if (S.route !== "settings") await render();
  if (S.drawerId === id) await openChapter(id);
}

document.addEventListener("input", (e) => {
  if (e.target.id === "ch-search") { S.filters.q = e.target.value; S.sel = 0; drawChapterTable(); }
});

// ------------------------------------------------------------------ keyboard

function rows() { return $$("#main [data-row]"); }
function highlightSelection(scroll = true) {
  const r = rows(); if (!r.length) return;
  S.sel = Math.max(0, Math.min(S.sel, r.length - 1));
  r.forEach((el, i) => el.classList.toggle("selected", i === S.sel));
  if (scroll) r[S.sel].scrollIntoView({ block: "nearest" });
}
function selectedId() { const r = rows()[S.sel]; return r && r.dataset.id ? r.dataset.id : null; }

function openHelp() {
  const keys = [["1 – 6", "Go to Due / Chapters / Dashboard / Papers / Mistakes / Settings"], ["j / k or ↓ / ↑", "Move selection"], ["l", "Learnt today (selected chapter)"], ["r", "Reviewed today (selected chapter)"], ["Enter or o", "Open chapter history"], ["1 – 5 then Enter", "Set confidence in the review dialog"], ["/", "Search chapters"], ["n", "New paper attempt / mistake (on those pages)"], ["t", "Toggle dark mode"], ["Esc", "Close dialog / panel"], ["?", "This help"]];
  $("#modal-root").innerHTML = `<div class="backdrop modal-backdrop" data-action="close-modal"></div><div class="modal" role="dialog" aria-label="Keyboard shortcuts">
    <button class="ghost close-x" data-action="close-modal" aria-label="Close">✕</button><h2>Keyboard shortcuts</h2>
    <table class="compact shortcuts"><tbody>${keys.map(([k, v]) => `<tr><td><kbd>${k}</kbd></td><td>${v}</td></tr>`).join("")}</tbody></table></div>`;
  S.modalKeys = () => false;
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if ($("#modal-root").innerHTML) { closeModal(); e.preventDefault(); return; }
    if (S.drawerId) { closeDrawer(); e.preventDefault(); return; }
    if (isTyping(e)) { e.target.blur(); return; }
  }
  if ($("#modal-root").innerHTML) { if (S.modalKeys) S.modalKeys(e); return; }
  if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  const pages = ["due", "chapters", "dashboard", "papers", "mistakes", "settings"];
  if (/^[1-6]$/.test(e.key)) { location.hash = `#/${pages[+e.key - 1]}`; e.preventDefault(); return; }
  switch (e.key) {
    case "j": case "ArrowDown": if (S.drawerId) return; S.sel++; highlightSelection(); e.preventDefault(); return;
    case "k": case "ArrowUp": if (S.drawerId) return; S.sel--; highlightSelection(); e.preventDefault(); return;
    case "r": { const id = S.drawerId || selectedId(); if (id) { openReview(id); e.preventDefault(); } return; }
    case "l": { const id = S.drawerId || selectedId(); if (id) { openReview(id, "learnt"); e.preventDefault(); } return; }
    case "Enter": case "o": { if (S.drawerId || e.target.closest("button, a, summary")) return; const id = selectedId(); if (id) { openChapter(id); e.preventDefault(); } return; }
    case "/": if (S.route !== "chapters") { location.hash = "#/chapters"; setTimeout(() => $("#ch-search")?.focus(), 150); } else $("#ch-search").focus(); e.preventDefault(); return;
    case "n": { const f = $("#paper-form [name=series]") || $("#mistake-form [name=chapter_id]"); if (f) { f.focus(); e.preventDefault(); } return; }
    case "t": cycleTheme(); return;
    case "?": openHelp(); return;
  }
});

// ------------------------------------------------------------------ login & lifecycle

const CODE_KEY = "rt-code";
function rememberedCode() {
  try { return sessionStorage.getItem(CODE_KEY) || localStorage.getItem(CODE_KEY); } catch { return null; }
}
function rememberCode(code, keep) {
  try {
    sessionStorage.setItem(CODE_KEY, code);
    if (keep) localStorage.setItem(CODE_KEY, code); else localStorage.removeItem(CODE_KEY);
  } catch { /* private browsing: the code just isn't remembered */ }
}
function forgetCode() {
  try { sessionStorage.removeItem(CODE_KEY); localStorage.removeItem(CODE_KEY); } catch { /* ignore */ }
}

const STATUS_TEXT = { saved: "✓ All changes saved", saving: "Saving…", offline: "Offline — will save when you're back online", error: "Couldn't save" };
function showStatus(state, detail) {
  const el = $("#save-status");
  el.textContent = state === "error" && detail ? `Couldn't save: ${detail}` : STATUS_TEXT[state];
  el.dataset.state = state;
  $("#offline").hidden = state !== "offline";
}

function makeRemote() { return new Remote({ url: CONFIG.supabaseUrl, key: CONFIG.supabaseKey }); }

async function openTracker(code, keep) {
  const tracker = new Tracker(makeRemote(), code, {
    onStatus: showStatus,
    onChange: async (info) => {
      await loadBoot(); await render(); refreshStreak();
      if (S.drawerId) { try { await openChapter(S.drawerId); } catch { closeDrawer(); } }
      if (info.dropped?.length) toast(`Updated from another device. ${plural(info.dropped.length, "change")} couldn't be applied: ${info.dropped[0]}`, "error");
      else if (info.merged) toast("Merged with changes from another device");
    },
  });
  await tracker.open();
  S.tracker = tracker;
  rememberCode(tracker.code, keep);
  $("#login").hidden = true;
  $(".shell").hidden = false;
  showStatus("saved");
  await loadBoot();
  if (!location.hash || location.hash === "#") history.replaceState(null, "", "#/due");
  await render();
  refreshStreak();
}

function showLogin(message) {
  $(".shell").hidden = true;
  const root = $("#login");
  root.hidden = false;
  if (!CONFIG.supabaseUrl || !CONFIG.supabaseKey) {
    root.querySelector(".login-card").innerHTML = `<h1>Revision Tracker</h1><p>This site isn't connected to its database yet. Whoever runs it needs to fill in <code>config.js</code> (see the README).</p>`;
    return;
  }
  const err = $("#login-error");
  err.textContent = message || "";
  err.hidden = !message;
  $("#login-code").focus();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("#login-code").value;
  const btn = $("#login-submit");
  if (normalizeCode(code).length !== 12) return showLogin("Codes are 12 letters and numbers, like ABCD-EFGH-JKMN.");
  btn.disabled = true; btn.textContent = "Opening…";
  try { await openTracker(code, $("#login-remember").checked); }
  catch (err) { showLogin(err.message); }
  finally { btn.disabled = false; btn.textContent = "Open my tracker"; }
});
$("#login-code").addEventListener("input", (e) => {
  const raw = normalizeCode(e.target.value).slice(0, 12);
  const pretty = formatCode(raw);
  if (pretty !== e.target.value) e.target.value = pretty;
});

$("#create-tracker").addEventListener("click", async () => {
  const btn = $("#create-tracker");
  btn.disabled = true; btn.textContent = "Creating…";
  try {
    const seed = await (await fetch("seed_chapters.json")).json();
    const code = await makeRemote().create(svc.newTracker(seed));
    $("#login-choose").hidden = true;
    $("#login-new").hidden = false;
    $("#new-code").textContent = code;
    $("#open-new").onclick = () => openTracker(code, $("#new-remember").checked).catch((err) => showLogin(err.message));
    $("#copy-new").onclick = async () => {
      try { await navigator.clipboard.writeText(code); toast("Code copied"); } catch { toast("Couldn't copy: select the code and copy it yourself", "error"); }
    };
  } catch (err) {
    showLogin(`Couldn't create a tracker: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = "Start a new tracker";
  }
});

// Pick up changes from your other devices when you come back to this tab, and roll over to a
// new day at midnight.
document.addEventListener("visibilitychange", async () => {
  if (document.hidden || !S.tracker) return;
  try { await S.tracker.refresh(); } catch { /* offline: try again next time */ }
  if (S.boot && today() !== S.boot.today) { await loadBoot(); render(); refreshStreak(); }
});
setInterval(() => {
  if (S.tracker && S.boot && today() !== S.boot.today) { loadBoot().then(() => { render(); refreshStreak(); }); }
}, 60000);
window.addEventListener("beforeunload", (e) => {
  if (S.tracker?.unsaved) { e.preventDefault(); e.returnValue = ""; }
});

(async function start() {
  const code = rememberedCode();
  if (!code || !CONFIG.supabaseUrl) return showLogin();
  try {
    let keep = false;
    try { keep = localStorage.getItem(CODE_KEY) === code; } catch { /* ignore */ }
    await openTracker(code, keep);
  } catch (e) {
    if (e.status === 404) forgetCode();
    showLogin(e.message);
  }
})();
