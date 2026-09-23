// Pure calculations: dates, spaced repetition, learning pace, priority, grades.
// Dates are ISO strings ("2027-01-10"); nothing here reads the clock, so `today` is always
// passed in, which keeps every function easy to test.

export const STATUSES = ["not_started", "in_progress", "done"];
export const ERROR_TYPES = ["conceptual", "method", "algebra slip", "misread", "time", "presentation"];
export const GRADES = ["A*", "A", "B", "C", "D", "E"];

export const DEFAULT_SETTINGS = {
  // Days until the next review, keyed by confidence (1 = shaky, 5 = exam-ready).
  intervals: { 1: 3, 2: 7, 3: 14, 4: 30, 5: 60 },
  // The June 2028 timetable isn't published yet: these are placeholders.
  exams: [
    { name: "Further Maths Y540 Pure Core 1", date: "2028-05-17", confirmed: false },
    { name: "Further Maths Y541 Pure Core 2", date: "2028-05-24", confirmed: false },
    { name: "Maths H240/01 Pure Mathematics", date: "2028-06-06", confirmed: false },
    { name: "Further Maths Y542 Statistics", date: "2028-06-09", confirmed: false },
    { name: "Maths H240/02 Pure & Statistics", date: "2028-06-13", confirmed: false },
    { name: "Further Maths Y543 Mechanics", date: "2028-06-16", confirmed: false },
    { name: "Maths H240/03 Pure & Mechanics", date: "2028-06-20", confirmed: false },
  ],
  // H240 papers are 100 marks (OCR H240 specification). Y54x assumed 75 marks: check.
  papers: [
    { code: "H240/01", name: "Pure Mathematics", max: 100 },
    { code: "H240/02", name: "Pure Mathematics and Statistics", max: 100 },
    { code: "H240/03", name: "Pure Mathematics and Mechanics", max: 100 },
    { code: "Y540", name: "Pure Core 1", max: 75 },
    { code: "Y541", name: "Pure Core 2", max: 75 },
    { code: "Y542", name: "Statistics", max: 75 },
    { code: "Y543", name: "Mechanics", max: 75 },
  ],
  // Relative weights of the four priority components.
  priority_weights: { confidence: 35, overdue: 25, marks: 25, learnt: 15 },
  // Marks lost at which the "marks lost" component reaches 0.5 (it saturates towards 1).
  marks_half_point: 8,
  // Default gap before retesting a logged mistake.
  mistake_retest_days: 7,
  // Date by which you want to have learnt every chapter (null = your first exam).
  learn_by: null,
  theme: "system",
};

// ---------------------------------------------------------------- dates

const DAY = 86400000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}/;

export function parseDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value);
  if (!ISO_RE.test(s)) throw new Error(`Not a date: ${s}`);
  const iso = s.slice(0, 10);
  const [y, m, d] = iso.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  if (new Date(t).toISOString().slice(0, 10) !== iso) throw new Error(`Not a date: ${s}`);
  return iso;
}

// Dates are shown and typed as dd/mm/yyyy.
export function formatDMY(value) {
  const d = parseDate(value);
  return d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "";
}

// "3/1/2027", "03-01-27", "3.1.2027" and "2027-01-03" all mean 3 January 2027. Blank -> null.
export function parseDMY(text) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    try { return parseDate(s); } catch { throw new Error(`${s} isn't a real date`); }
  }
  const m = s.match(/^(\d{1,2})\s*[/.\- ]\s*(\d{1,2})\s*[/.\- ]\s*(\d{4}|\d{2})$/);
  if (!m) throw new Error(`"${s}" isn't a date: type it as dd/mm/yyyy`);
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  try { return parseDate(`${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`); } catch { throw new Error(`${s} isn't a real date`); }
}

const dayNum = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY;
export const addDays = (iso, n) => new Date((dayNum(iso) + n) * DAY).toISOString().slice(0, 10);
export const daysBetween = (from, to) => dayNum(to) - dayNum(from);

export function localToday(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function round(x, n = 0) {
  const f = 10 ** n;
  return Math.round((x + Number.EPSILON * Math.sign(x)) * f) / f;
}

export function daysSince(last, today) {
  const d = parseDate(last);
  return d === null ? null : daysBetween(d, today);
}

export function intervalFor(confidence, intervals) {
  if (confidence === null || confidence === undefined) return null;
  return Number(intervals[String(confidence)]);
}

// Reviews are scheduled from the last review, or from the day you first learnt the chapter
// if you haven't reviewed it yet.
export const scheduleAnchor = (lastReviewed, firstLearnt) => parseDate(lastReviewed) || parseDate(firstLearnt);

export function nextReview(anchor, confidence, intervals) {
  const a = parseDate(anchor);
  const gap = intervalFor(confidence, intervals);
  return a === null || gap === null ? null : addDays(a, gap);
}

// ---------------------------------------------------------------- learning pace

export function learnTarget(settings) {
  const t = parseDate(settings.learn_by);
  if (t) return t;
  const exams = (settings.exams || []).map((e) => parseDate(e.date)).filter(Boolean).sort();
  return exams[0] || null;
}

export function weekStart(today) {
  const dow = (new Date(dayNum(today) * DAY).getUTCDay() + 6) % 7; // Monday = 0
  return addDays(today, -dow);
}

// Compare your recent learning pace (chapters first learnt in the last 4 weeks, per week) with
// the pace needed to learn every chapter by `target`.
export function learningPace(firstLearntDates, today, target, windowDays = 28) {
  const dates = firstLearntDates.map(parseDate);
  const total = dates.length;
  const learnt = dates.filter((d) => d !== null && d <= today).length;
  const remaining = total - learnt;
  const windowStart = addDays(today, -(windowDays - 1));
  const recent = dates.filter((d) => d !== null && d >= windowStart && d <= today).length;
  const perWeek = round((recent * 7) / windowDays, 2);
  const ws = weekStart(today);
  const thisWeek = dates.filter((d) => d !== null && d >= ws && d <= today).length;
  const daysLeft = target ? daysBetween(today, target) : null;
  const required = daysLeft !== null && daysLeft > 0 && remaining ? round((remaining * 7) / daysLeft, 2) : null;
  const projected = remaining && perWeek > 0 ? addDays(today, Math.ceil((remaining * 7) / perWeek)) : null;
  let verdict;
  if (remaining === 0) verdict = "all learnt";
  else if (!target) verdict = "no target";
  else if (daysLeft <= 0) verdict = "behind";
  else if (learnt === 0) verdict = "not started";
  else if (perWeek >= required * 1.1) verdict = "ahead";
  else if (perWeek >= required * 0.9) verdict = "on track";
  else verdict = "behind";
  return { total, learnt, remaining, recent, per_week: perWeek, required_per_week: required, this_week: thisWeek,
           target: target || null, days_left: daysLeft, projected_finish: projected, verdict };
}

// ---------------------------------------------------------------- due & priority

const clamp = (x) => Math.max(0, Math.min(1, x));

// Chapters you haven't learnt are never due. A learnt chapter with no confidence rating is due
// straight away (it needs rating); otherwise it's due once its next review date arrives.
export function isDue(anchor, confidence, learnt, intervals, today) {
  if (!learnt) return { due: false, dueDate: null };
  const nxt = nextReview(anchor, confidence, intervals);
  if (nxt === null) return { due: true, dueDate: parseDate(anchor) };
  return { due: nxt <= today, dueDate: nxt };
}

// Priority score 0..100 (higher = work on it sooner) plus its four components (each 0..1).
export function priority(confidence, anchor, learnt, marksLost, settings, today) {
  const intervals = settings.intervals;
  const confC = confidence === null || confidence === undefined ? 1 : clamp((5 - confidence) / 4);
  const nxt = learnt ? nextReview(anchor, confidence, intervals) : null;
  let overdueC = 0;
  if (nxt !== null) {
    const late = daysBetween(nxt, today);
    overdueC = late > 0 ? clamp(late / intervalFor(confidence, intervals)) : 0;
  } else if (learnt) {
    overdueC = 1;
  }
  const half = Number(settings.marks_half_point) || 8;
  const m = Math.max(0, Number(marksLost) || 0);
  const marksC = m / (m + half);
  const learntC = learnt ? 1 : 0;
  const w = settings.priority_weights;
  const totalW = Object.values(w).reduce((a, b) => a + Number(b), 0) || 1;
  const raw = w.confidence * confC + w.overdue * overdueC + w.marks * marksC + w.learnt * learntC;
  return {
    score: round((100 * raw) / totalW, 1),
    components: { confidence: round(confC, 3), overdue: round(overdueC, 3), marks: round(marksC, 3), learnt: learntC },
  };
}

// Score for the "weakest chapters" list; null until a chapter is rated or has lost marks.
export function weakness(confidence, marksLost, settings) {
  const noConf = confidence === null || confidence === undefined;
  if (noConf && !marksLost) return null;
  const confC = noConf ? 0.5 : (5 - confidence) / 4;
  const half = Number(settings.marks_half_point) || 8;
  const m = Math.max(0, Number(marksLost) || 0);
  return round(100 * (0.6 * confC + (0.4 * m) / (m + half)), 1);
}

// ---------------------------------------------------------------- papers

// Highest grade whose raw-mark boundary the mark reaches; null if no boundaries entered.
export function gradeFor(mark, boundaries) {
  if (mark === null || mark === undefined || !boundaries) return null;
  const entered = GRADES.filter((g) => boundaries[g] !== null && boundaries[g] !== undefined);
  if (!entered.length) return null;
  for (const g of entered) if (Number(mark) >= Number(boundaries[g])) return g;
  return "U";
}

export function percent(mark, max) {
  if (mark === null || mark === undefined || !max) return null;
  return round((100 * Number(mark)) / Number(max), 1);
}

// ---------------------------------------------------------------- habits

// Consecutive days with a review, ending today (or yesterday if nothing's been reviewed yet
// today, so the streak isn't shown as broken first thing in the morning).
export function reviewStreak(reviewDates, today) {
  const days = new Set(reviewDates.map(parseDate));
  let cur = days.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (days.has(cur)) { streak++; cur = addDays(cur, -1); }
  return streak;
}

export function reviewsThisWeek(reviewDates, today) {
  const start = weekStart(today);
  return reviewDates.map(parseDate).filter((d) => d >= start && d <= today).length;
}

export function countdown(exams, today) {
  return exams
    .filter((e) => parseDate(e.date))
    .map((e) => ({ ...e, days: daysBetween(today, parseDate(e.date)) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
