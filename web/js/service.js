// The tracker is one JSON document (chapters, reviews, papers, ...). This module reads it
// ("queries") and changes it ("ops"). Ops change the document they're given in place and throw
// an Error with a readable message if the input is invalid. Anything random (new ids, the
// current time) is passed in, so an op can be replayed on a newer copy of the document.
import * as L from "./logic.js";

export const FORMAT = "revision-tracker";
export const DOC_VERSION = 2;
export const TABLES = ["chapters", "reviews", "papers", "paper_questions", "boundaries", "mistakes"];
const STATUS_FIELDS = ["summary_status", "exercises_status", "examq_status"];
export const BOUNDARY_COLS = { "A*": "a_star", A: "a", B: "b", C: "c", D: "d", E: "e" };

const fail = (msg) => { throw new Error(msg); };
const str = (v) => (v === null || v === undefined || v === "" ? null : String(v));
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const byId = (list, id) => list.find((x) => x.id === String(id));
export const newId = () =>
  (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

// ---------------------------------------------------------------- documents

export function newTracker(seed) {
  return {
    format: FORMAT, version: DOC_VERSION,
    chapters: seed.map((c, i) => ({
      id: String(i + 1), strand: c.strand, book: c.book, ch_num: c.ch_num, title: c.title,
      sections: c.sections || "", level: c.level || "",
      summary_status: "not_started", exercises_status: "not_started", examq_status: "not_started",
      confidence: null, first_learnt: null, notes: "", sort_order: i + 1,
    })),
    reviews: [], papers: [], paper_questions: [], boundaries: [], mistakes: [], settings: {},
  };
}

// Accepts this website's document or an export from the desktop app (tables of rows with
// numeric ids, settings as key/value rows), and returns a clean, current document.
export function normalize(raw) {
  if (!raw || typeof raw !== "object" || raw.format !== FORMAT) fail("That isn't a Revision Tracker file.");
  const t = raw.tables || raw;
  if (!Array.isArray(t.chapters) || !t.chapters.length) fail("That file has no chapters in it.");
  const rows = (name) => (Array.isArray(t[name]) ? t[name] : []);
  const doc = {
    format: FORMAT, version: DOC_VERSION,
    chapters: rows("chapters").map((c, i) => ({
      id: String(c.id), strand: String(c.strand || ""), book: String(c.book || ""), ch_num: num(c.ch_num),
      title: String(c.title || ""), sections: String(c.sections || ""), level: String(c.level || ""),
      summary_status: L.STATUSES.includes(c.summary_status) ? c.summary_status : "not_started",
      exercises_status: L.STATUSES.includes(c.exercises_status) ? c.exercises_status : "not_started",
      examq_status: L.STATUSES.includes(c.examq_status) ? c.examq_status : "not_started",
      confidence: num(c.confidence), first_learnt: str(c.first_learnt), notes: String(c.notes || ""),
      sort_order: num(c.sort_order) ?? i + 1,
    })),
    reviews: rows("reviews").map((r) => ({
      id: String(r.id), chapter_id: String(r.chapter_id), reviewed_on: String(r.reviewed_on).slice(0, 10),
      confidence_before: num(r.confidence_before), confidence_after: num(r.confidence_after),
      note: String(r.note || ""), created_at: String(r.created_at || ""),
    })),
    papers: rows("papers").map((p) => ({
      id: String(p.id), paper_code: String(p.paper_code), series: String(p.series), sat_on: String(p.sat_on).slice(0, 10),
      mark: num(p.mark), max_mark: num(p.max_mark), time_taken_min: num(p.time_taken_min), notes: String(p.notes || ""),
    })),
    paper_questions: rows("paper_questions").map((q) => ({
      id: String(q.id), paper_id: String(q.paper_id), q_num: String(q.q_num || ""), chapter_id: str(q.chapter_id),
      marks_lost: num(q.marks_lost) || 0, error_type: String(q.error_type || ""), fix: String(q.fix || ""),
    })),
    boundaries: rows("boundaries").map((b) => ({
      id: String(b.id), paper_code: String(b.paper_code), series: String(b.series),
      ...Object.fromEntries(Object.values(BOUNDARY_COLS).map((k) => [k, num(b[k])])),
    })),
    mistakes: rows("mistakes").map((m) => ({
      id: String(m.id), logged_on: String(m.logged_on).slice(0, 10), chapter_id: str(m.chapter_id),
      source: String(m.source || ""), what_wrong: String(m.what_wrong || ""), correct_method: String(m.correct_method || ""),
      retest_on: str(m.retest_on), retest_passed: [true, 1, "1", "true", "TRUE", "True"].includes(m.retest_passed),
      passed_on: str(m.passed_on),
    })),
    settings: {},
  };
  // settings: an object, or the desktop app's [{key, value: "<json>"}] rows
  let s = t.settings || {};
  if (Array.isArray(s)) s = Object.fromEntries(s.map((r) => [r.key, typeof r.value === "string" ? JSON.parse(r.value) : r.value]));
  if (s.priority_weights && "taught" in s.priority_weights) {
    const { taught, ...rest } = s.priority_weights;
    s.priority_weights = { ...rest, learnt: taught };
  }
  for (const [k, v] of Object.entries(s)) if (k in L.DEFAULT_SETTINGS) doc.settings[k] = v;
  // anything reviewed was learnt by its first review
  for (const c of doc.chapters) {
    if (!c.first_learnt) {
      const first = doc.reviews.filter((r) => r.chapter_id === c.id).map((r) => r.reviewed_on).sort()[0];
      if (first) c.first_learnt = first;
    }
  }
  checkReferences(doc);
  return doc;
}

function checkReferences(doc) {
  const ch = new Set(doc.chapters.map((c) => c.id));
  const pp = new Set(doc.papers.map((p) => p.id));
  let bad = 0;
  bad += doc.reviews.filter((r) => !ch.has(r.chapter_id)).length;
  bad += doc.paper_questions.filter((q) => !pp.has(q.paper_id) || (q.chapter_id !== null && !ch.has(q.chapter_id))).length;
  bad += doc.mistakes.filter((m) => m.chapter_id !== null && !ch.has(m.chapter_id)).length;
  for (const t of TABLES) if (new Set(doc[t].map((x) => x.id)).size !== doc[t].length) fail(`Duplicate ids in ${t}`);
  if (bad) fail(`That file has ${bad} rows pointing at chapters or papers that don't exist.`);
}

export function settingsOf(doc) {
  const merged = structuredClone(L.DEFAULT_SETTINGS);
  for (const [k, v] of Object.entries(doc.settings || {})) if (k in merged) merged[k] = v;
  const want = Object.keys(L.DEFAULT_SETTINGS.priority_weights).sort().join();
  if (Object.keys(merged.priority_weights || {}).sort().join() !== want) merged.priority_weights = { ...L.DEFAULT_SETTINGS.priority_weights };
  return merged;
}

// ---------------------------------------------------------------- chapters

function lossStats(doc) {
  const lost = {}, errors = {};
  for (const q of doc.paper_questions) {
    if (q.chapter_id === null) continue;
    lost[q.chapter_id] = (lost[q.chapter_id] || 0) + (q.marks_lost || 0);
    if (q.error_type) {
      const e = (errors[q.chapter_id] ||= {});
      e[q.error_type] = (e[q.error_type] || 0) + (q.marks_lost || 1);
    }
  }
  const top = {};
  for (const [cid, counts] of Object.entries(errors)) {
    top[cid] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  }
  return { lost, top };
}

export function listChapters(doc, today) {
  const settings = settingsOf(doc);
  const last = {};
  for (const r of doc.reviews) {
    const e = (last[r.chapter_id] ||= { last: null, n: 0 });
    e.n++;
    if (!e.last || r.reviewed_on > e.last) e.last = r.reviewed_on;
  }
  const { lost, top } = lossStats(doc);
  return [...doc.chapters]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((c) => enrich(c, last[c.id] || { last: null, n: 0 }, lost[c.id] || 0, top[c.id] || null, settings, today));
}

function enrich(c, rv, marksLost, topError, settings, today) {
  const learnt = Boolean(c.first_learnt);
  const anchor = L.scheduleAnchor(rv.last, c.first_learnt);
  const { due } = L.isDue(anchor, c.confidence, learnt, settings.intervals, today);
  const nxt = learnt ? L.nextReview(anchor, c.confidence, settings.intervals) : null;
  const pr = L.priority(c.confidence, anchor, learnt, marksLost, settings, today);
  return {
    ...c,
    learnt,
    days_since_learnt: L.daysSince(c.first_learnt, today),
    last_reviewed: rv.last,
    review_count: rv.n,
    days_since: L.daysSince(rv.last, today),
    next_review: nxt,
    days_until_review: nxt === null ? null : L.daysBetween(today, nxt),
    due,
    marks_lost: L.round(marksLost, 1),
    top_error: topError,
    priority: pr.score,
    priority_parts: pr.components,
    weakness: L.weakness(c.confidence, marksLost, settings),
  };
}

export function getChapter(doc, id, today) {
  return listChapters(doc, today).find((c) => c.id === String(id)) || fail("Chapter not found");
}

export function chapterHistory(doc, id, today) {
  const chapter = getChapter(doc, id, today);
  const papers = Object.fromEntries(doc.papers.map((p) => [p.id, p]));
  const desc = (k) => (a, b) => (a[k] < b[k] ? 1 : a[k] > b[k] ? -1 : 0);
  return {
    chapter,
    reviews: doc.reviews.filter((r) => r.chapter_id === chapter.id).sort((a, b) => desc("reviewed_on")(a, b) || desc("created_at")(a, b)),
    questions: doc.paper_questions.filter((q) => q.chapter_id === chapter.id)
      .map((q) => ({ ...q, paper_code: papers[q.paper_id]?.paper_code, series: papers[q.paper_id]?.series, sat_on: papers[q.paper_id]?.sat_on }))
      .sort(desc("sat_on")),
    mistakes: doc.mistakes.filter((m) => m.chapter_id === chapter.id).sort(desc("logged_on")),
  };
}

function chapterOrFail(doc, id) { return byId(doc.chapters, id) || fail("Chapter not found"); }

function checkFirstLearnt(doc, chapterId, value, today) {
  const firstReview = doc.reviews.filter((r) => r.chapter_id === chapterId).map((r) => r.reviewed_on).sort()[0];
  if (value === null || value === undefined || value === "") {
    if (firstReview) fail("You've already reviewed this chapter, so it can't be marked as not learnt. Undo its reviews first.");
    return null;
  }
  let d;
  try { d = L.parseDate(value); } catch { fail("First learnt must be a date"); }
  if (d > today) fail("First learnt can't be in the future");
  if (firstReview && d > firstReview) fail(`First learnt must be on or before your first review (${firstReview})`);
  return d;
}

export function updateChapter(doc, id, data, today) {
  const c = chapterOrFail(doc, id);
  const f = {};
  for (const k of STATUS_FIELDS) {
    if (k in data) {
      if (!L.STATUSES.includes(data[k])) fail(`${k} must be one of ${L.STATUSES.join(", ")}`);
      f[k] = data[k];
    }
  }
  if ("confidence" in data) {
    const v = data.confidence;
    if (v !== null && !(Number.isInteger(v) && v >= 1 && v <= 5)) fail("Confidence must be 1-5 or empty");
    f.confidence = v;
  }
  if ("notes" in data) f.notes = String(data.notes ?? "");
  if ("first_learnt" in data) f.first_learnt = checkFirstLearnt(doc, c.id, data.first_learnt, today);
  if (!Object.keys(f).length) fail("Nothing to update");
  Object.assign(c, f);
  return doc;
}

const checkConfidence = (v) => { if (!(Number.isInteger(v) && v >= 1 && v <= 5)) fail("Confidence must be 1-5"); };

// "Learnt today": today is the day you first learnt it; the confidence schedules the first review.
export function markLearnt(doc, id, confidence, today) {
  checkConfidence(confidence);
  const c = chapterOrFail(doc, id);
  if (c.first_learnt) fail(`Already marked as learnt on ${c.first_learnt}`);
  c.first_learnt = today;
  c.confidence = confidence;
  return doc;
}

// "Reviewed today": log a review dated today and set the new confidence.
export function reviewChapter(doc, id, confidence, note, today, { reviewId = newId(), now = new Date().toISOString() } = {}) {
  checkConfidence(confidence);
  const c = chapterOrFail(doc, id);
  doc.reviews.push({ id: reviewId, chapter_id: c.id, reviewed_on: today, confidence_before: c.confidence,
                     confidence_after: confidence, note: note || "", created_at: now });
  c.confidence = confidence;
  if (!c.first_learnt) c.first_learnt = today; // reviewing it means you've learnt it by now
  return doc;
}

// Remove a review logged by mistake; undoing the latest one restores the previous confidence.
export function deleteReview(doc, reviewId) {
  const r = byId(doc.reviews, reviewId) || fail("Review not found");
  const latest = doc.reviews.filter((x) => x.chapter_id === r.chapter_id)
    .sort((a, b) => (a.reviewed_on + a.created_at < b.reviewed_on + b.created_at ? 1 : -1))[0];
  doc.reviews = doc.reviews.filter((x) => x.id !== r.id);
  if (latest && latest.id === r.id) chapterOrFail(doc, r.chapter_id).confidence = r.confidence_before;
  return doc;
}

// ---------------------------------------------------------------- due list

export function dueList(doc, today) {
  const all = listChapters(doc, today);
  const chapters = all.filter((c) => c.due)
    .sort((a, b) => b.priority - a.priority || (a.next_review || "").localeCompare(b.next_review || "") || a.sort_order - b.sort_order);
  const titles = Object.fromEntries(doc.chapters.map((c) => [c.id, c]));
  const retests = doc.mistakes
    .filter((m) => !m.retest_passed && m.retest_on && m.retest_on <= today)
    .sort((a, b) => a.retest_on.localeCompare(b.retest_on))
    .map((m) => ({ ...m, chapter_title: titles[m.chapter_id]?.title || null, chapter_strand: titles[m.chapter_id]?.strand || null,
                   days_overdue: L.daysBetween(m.retest_on, today) }));
  const upcoming = all.filter((c) => !c.due && c.days_until_review !== null && c.days_until_review <= 7)
    .sort((a, b) => a.days_until_review - b.days_until_review).slice(0, 10);
  const nextUp = new Map();
  for (const c of all) if (!c.learnt && !nextUp.has(c.book)) nextUp.set(c.book, c);
  return { chapters, retests, upcoming, next_to_learn: [...nextUp.values()] };
}

// ---------------------------------------------------------------- papers

const paperCfg = (settings) => Object.fromEntries(settings.papers.map((p) => [p.code, p]));

function boundaryMap(doc) {
  const out = {};
  for (const b of doc.boundaries) {
    out[`${b.paper_code}\u0000${b.series}`] = Object.fromEntries(Object.entries(BOUNDARY_COLS).map(([g, k]) => [g, b[k]]));
  }
  return out;
}

export function listPapers(doc) {
  const bmap = boundaryMap(doc);
  const titles = Object.fromEntries(doc.chapters.map((c) => [c.id, c.title]));
  return [...doc.papers]
    .sort((a, b) => (a.sat_on < b.sat_on ? 1 : a.sat_on > b.sat_on ? -1 : 0))
    .map((p) => {
      const b = bmap[`${p.paper_code}\u0000${p.series}`];
      const questions = doc.paper_questions.filter((q) => q.paper_id === p.id)
        .map((q) => ({ ...q, chapter_title: titles[q.chapter_id] || null }));
      return { ...p, percent: L.percent(p.mark, p.max_mark), grade: L.gradeFor(p.mark, b || null), has_boundaries: Boolean(b),
               questions, marks_lost_logged: L.round(questions.reduce((s, q) => s + q.marks_lost, 0), 1) };
    });
}

function paperFields(doc, data, partial) {
  const cfg = paperCfg(settingsOf(doc));
  const f = {};
  if ("paper_code" in data || !partial) {
    if (!(data.paper_code in cfg)) fail("Pick a paper from the list");
    f.paper_code = data.paper_code;
  }
  if ("series" in data || !partial) {
    const s = String(data.series || "").trim();
    if (!s) fail("Series/year is required (e.g. June 2019)");
    f.series = s;
  }
  if ("sat_on" in data || !partial) {
    let d = null;
    try { d = L.parseDate(data.sat_on); } catch { /* reported below */ }
    if (!d) fail("Date sat is required");
    f.sat_on = d;
  }
  if ("max_mark" in data || !partial) {
    let mx = data.max_mark;
    if (mx === null || mx === undefined || mx === "") mx = cfg[f.paper_code || data.paper_code]?.max;
    if (!isNum(mx) || mx <= 0) fail("Max mark must be positive");
    f.max_mark = mx;
  }
  if ("mark" in data || !partial) {
    let m = data.mark;
    if (m === "" || m === undefined) m = null;
    if (m !== null && (!isNum(m) || m < 0)) fail("Mark must be a number ≥ 0");
    f.mark = m;
  }
  if ("time_taken_min" in data) {
    let t = data.time_taken_min;
    if (t === "" || t === undefined) t = null;
    if (t !== null && !(Number.isInteger(t) && t >= 0)) fail("Time taken must be whole minutes");
    f.time_taken_min = t;
  }
  if ("notes" in data) f.notes = String(data.notes || "");
  return f;
}

export function createPaper(doc, data, { id = newId() } = {}) {
  const f = paperFields(doc, data, false);
  const p = { id, time_taken_min: null, notes: "", ...f };
  if (p.mark !== null && p.mark > p.max_mark) fail("Mark can't be more than the max mark");
  doc.papers.push(p);
  return doc;
}

export function updatePaper(doc, id, data) {
  const p = byId(doc.papers, id) || fail("Paper not found");
  const f = paperFields(doc, data, true);
  if (!Object.keys(f).length) fail("Nothing to update");
  const next = { ...p, ...f };
  if (next.mark !== null && next.mark > next.max_mark) fail("Mark can't be more than the max mark");
  Object.assign(p, f);
  return doc;
}

export function deletePaper(doc, id) {
  byId(doc.papers, id) || fail("Paper not found");
  doc.papers = doc.papers.filter((p) => p.id !== String(id));
  doc.paper_questions = doc.paper_questions.filter((q) => q.paper_id !== String(id));
  return doc;
}

function questionFields(doc, data, partial) {
  const f = {};
  if ("q_num" in data || !partial) {
    f.q_num = String(data.q_num || "").trim();
    if (!f.q_num) fail("Question number is required");
  }
  if ("chapter_id" in data || !partial) {
    if (!data.chapter_id || !byId(doc.chapters, data.chapter_id)) fail("Pick the chapter this question tests");
    f.chapter_id = String(data.chapter_id);
  }
  if ("marks_lost" in data || !partial) {
    if (!isNum(data.marks_lost) || data.marks_lost < 0) fail("Marks lost must be a number ≥ 0");
    f.marks_lost = data.marks_lost;
  }
  if ("error_type" in data || !partial) {
    if (!L.ERROR_TYPES.includes(data.error_type)) fail(`Error type must be one of: ${L.ERROR_TYPES.join(", ")}`);
    f.error_type = data.error_type;
  }
  if ("fix" in data) f.fix = String(data.fix || "");
  return f;
}

export function addQuestion(doc, paperId, data, { id = newId() } = {}) {
  byId(doc.papers, paperId) || fail("Paper not found");
  doc.paper_questions.push({ id, paper_id: String(paperId), fix: "", ...questionFields(doc, data, false) });
  return doc;
}

export function updateQuestion(doc, id, data) {
  const q = byId(doc.paper_questions, id) || fail("Question not found");
  const f = questionFields(doc, data, true);
  if (!Object.keys(f).length) fail("Nothing to update");
  Object.assign(q, f);
  return doc;
}

export function deleteQuestion(doc, id) {
  byId(doc.paper_questions, id) || fail("Question not found");
  doc.paper_questions = doc.paper_questions.filter((q) => q.id !== String(id));
  return doc;
}

export const listBoundaries = (doc) =>
  [...doc.boundaries].sort((a, b) => a.paper_code.localeCompare(b.paper_code) || a.series.localeCompare(b.series));

export function upsertBoundary(doc, data, { id = newId() } = {}) {
  const cfg = paperCfg(settingsOf(doc));
  const code = data.paper_code;
  if (!(code in cfg)) fail("Pick a paper from the list");
  const series = String(data.series || "").trim();
  if (!series) fail("Series is required");
  const vals = {};
  let prev = null;
  for (const [g, k] of Object.entries(BOUNDARY_COLS)) {
    const v = data[k];
    if (v === null || v === undefined || v === "") { vals[k] = null; continue; }
    if (!isNum(v) || v < 0 || v > cfg[code].max) fail(`${g} boundary must be between 0 and ${cfg[code].max}`);
    if (prev !== null && v > prev) fail("Boundaries must go down from A* to E");
    prev = v;
    vals[k] = v;
  }
  if (Object.values(vals).every((v) => v === null)) fail("Enter at least one boundary");
  const existing = doc.boundaries.find((b) => b.paper_code === code && b.series === series);
  if (existing) Object.assign(existing, vals);
  else doc.boundaries.push({ id, paper_code: code, series, ...vals });
  return doc;
}

export function deleteBoundary(doc, id) {
  byId(doc.boundaries, id) || fail("Boundary not found");
  doc.boundaries = doc.boundaries.filter((b) => b.id !== String(id));
  return doc;
}

// Percentage over time per paper, plus the mean A* boundary (as a %) for that paper.
export function paperChart(doc) {
  const settings = settingsOf(doc);
  const papers = listPapers(doc);
  return settings.papers.map((cfg) => {
    const points = papers.filter((p) => p.paper_code === cfg.code && p.percent !== null)
      .map((p) => ({ date: p.sat_on, percent: p.percent, series: p.series, grade: p.grade }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const astars = doc.boundaries.filter((b) => b.paper_code === cfg.code && b.a_star !== null).map((b) => (b.a_star / cfg.max) * 100);
    return {
      code: cfg.code, name: cfg.name, points,
      a_star_percent: astars.length ? L.round(astars.reduce((a, b) => a + b, 0) / astars.length, 1) : null,
      a_star_series_count: astars.length,
      average: points.length ? L.round(points.reduce((a, p) => a + p.percent, 0) / points.length, 1) : null,
    };
  });
}

// ---------------------------------------------------------------- mistakes

export function listMistakes(doc, today) {
  const ch = Object.fromEntries(doc.chapters.map((c) => [c.id, c]));
  return [...doc.mistakes]
    .sort((a, b) => (a.logged_on < b.logged_on ? 1 : a.logged_on > b.logged_on ? -1 : 0))
    .map((m) => ({ ...m, chapter_title: ch[m.chapter_id]?.title || null, chapter_strand: ch[m.chapter_id]?.strand || null,
                   retest_due: Boolean(!m.retest_passed && m.retest_on && m.retest_on <= today) }));
}

function mistakeFields(doc, data, today, partial) {
  const f = {};
  if ("chapter_id" in data || !partial) {
    if (!data.chapter_id || !byId(doc.chapters, data.chapter_id)) fail("Pick a chapter");
    f.chapter_id = String(data.chapter_id);
  }
  for (const k of ["source", "what_wrong", "correct_method"]) if (k in data) f[k] = String(data[k] || "");
  if (!partial && !String(f.what_wrong || "").trim()) fail("Say what went wrong");
  if ("retest_on" in data) {
    let d = null;
    if (data.retest_on) { try { d = L.parseDate(data.retest_on); } catch { fail("Retest date must be a date"); } }
    f.retest_on = d;
  } else if (!partial) {
    f.retest_on = L.addDays(today, Number(settingsOf(doc).mistake_retest_days));
  }
  return f;
}

export function createMistake(doc, data, today, { id = newId() } = {}) {
  const f = mistakeFields(doc, data, today, false);
  doc.mistakes.push({ id, logged_on: today, source: "", correct_method: "", retest_passed: false, passed_on: null, ...f });
  return doc;
}

export function updateMistake(doc, id, data, today) {
  const m = byId(doc.mistakes, id) || fail("Mistake not found");
  const f = mistakeFields(doc, data, today, true);
  if (!Object.keys(f).length) fail("Nothing to update");
  Object.assign(m, f);
  return doc;
}

// Passed -> ticked off. Not passed -> retest again after the usual gap.
export function retestMistake(doc, id, passed, today) {
  const m = byId(doc.mistakes, id) || fail("Mistake not found");
  if (passed) Object.assign(m, { retest_passed: true, passed_on: today });
  else Object.assign(m, { retest_passed: false, passed_on: null, retest_on: L.addDays(today, Number(settingsOf(doc).mistake_retest_days)) });
  return doc;
}

export function deleteMistake(doc, id) {
  byId(doc.mistakes, id) || fail("Mistake not found");
  doc.mistakes = doc.mistakes.filter((m) => m.id !== String(id));
  return doc;
}

// ---------------------------------------------------------------- settings

export function validateSettings(s) {
  if ("intervals" in s) {
    const iv = s.intervals;
    if (Object.keys(iv).sort().join() !== "1,2,3,4,5") fail("Intervals need confidence levels 1-5");
    for (const v of Object.values(iv)) if (!Number.isInteger(v) || v < 1 || v > 365) fail("Each interval must be a whole number of days, 1-365");
  }
  if ("exams" in s) {
    for (const e of s.exams) {
      let ok = false;
      try { ok = Boolean(e.name && String(e.name).trim() && L.parseDate(e.date)); } catch { /* not ok */ }
      if (!ok) fail("Each exam needs a name and a date");
    }
  }
  if ("papers" in s) for (const p of s.papers) if (!p.code || !isNum(p.max) || p.max <= 0) fail("Each paper needs a code and a positive max mark");
  if ("priority_weights" in s) {
    const w = s.priority_weights;
    if (Object.keys(w).sort().join() !== "confidence,learnt,marks,overdue") fail("Priority weights: confidence, overdue, marks, learnt");
    if (Object.values(w).some((v) => !isNum(v) || v < 0) || Object.values(w).reduce((a, b) => a + b, 0) <= 0) {
      fail("Priority weights must be non-negative and not all zero");
    }
  }
  if ("marks_half_point" in s && (!isNum(s.marks_half_point) || s.marks_half_point <= 0)) fail("Marks half-point must be positive");
  if ("mistake_retest_days" in s && !(Number.isInteger(s.mistake_retest_days) && s.mistake_retest_days >= 1 && s.mistake_retest_days <= 365)) {
    fail("Mistake retest gap must be 1-365 days");
  }
  if ("learn_by" in s && s.learn_by) { try { L.parseDate(s.learn_by); } catch { fail("Learn-by date must be a date or empty"); } }
  if ("theme" in s && !["system", "light", "dark"].includes(s.theme)) fail("Theme must be system, light or dark");
}

export function saveSettings(doc, updates) {
  for (const k of Object.keys(updates)) if (!(k in L.DEFAULT_SETTINGS)) fail(`Unknown setting: ${k}`);
  validateSettings(updates);
  doc.settings = { ...(doc.settings || {}), ...structuredClone(updates) };
  return doc;
}

export function resetSettings(doc, keys) {
  for (const k of keys) delete doc.settings[k];
  return doc;
}

// ---------------------------------------------------------------- import

// Replace one table from spreadsheet rows (CSV import). Rows use this site's column names.
export function replaceTable(doc, table, rows) {
  if (!TABLES.includes(table) && table !== "settings") fail(`Unknown table: ${table}`);
  if (table === "chapters" && !rows.length) fail("chapters.csv is empty");
  const next = { ...doc, [table]: rows, format: FORMAT };
  if (table === "settings") next.settings = rows;
  const clean = normalize(next);
  Object.assign(doc, clean);
  return doc;
}

// ---------------------------------------------------------------- dashboard

export function dashboard(doc, today) {
  const settings = settingsOf(doc);
  const chapters = listChapters(doc, today);
  const reviewDates = doc.reviews.map((r) => r.reviewed_on);
  const group = (keyFn, keys) => keys.map((name) => {
    const cs = chapters.filter((c) => keyFn(c) === name);
    const rated = cs.map((c) => c.confidence).filter((v) => v !== null);
    const count = (k) => cs.filter((c) => c[k] === "done").length;
    return {
      name, chapters: cs.length, summary_done: count("summary_status"), exercises_done: count("exercises_status"),
      examq_done: count("examq_status"), learnt: cs.filter((c) => c.learnt).length,
      avg_confidence: rated.length ? L.round(rated.reduce((a, b) => a + b, 0) / rated.length, 1) : null,
      weak: rated.filter((r) => r <= 2).length, due: cs.filter((c) => c.due).length,
    };
  });
  const uniq = (k) => [...new Set(chapters.map((c) => c[k]))];
  const weakest = chapters.filter((c) => c.weakness !== null)
    .sort((a, b) => b.weakness - a.weakness || a.sort_order - b.sort_order).slice(0, 10)
    .map(({ id, title, strand, book, ch_num, confidence, marks_lost, top_error, weakness, priority }) =>
      ({ id, title, strand, book, ch_num, confidence, marks_lost, top_error, weakness, priority }));
  return {
    today,
    by_strand: group((c) => c.strand, uniq("strand")),
    by_book: group((c) => c.book, uniq("book")),
    pace: L.learningPace(chapters.map((c) => c.first_learnt), today, L.learnTarget(settings)),
    weakest,
    streak: L.reviewStreak(reviewDates, today),
    reviews_this_week: L.reviewsThisWeek(reviewDates, today),
    reviews_total: reviewDates.length,
    due_count: chapters.filter((c) => c.due).length,
    open_retests: doc.mistakes.filter((m) => !m.retest_passed).length,
    countdown: L.countdown(settings.exams, today),
    papers: paperChart(doc),
  };
}
