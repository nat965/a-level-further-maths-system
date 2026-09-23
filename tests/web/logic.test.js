// Unit tests for the date, spaced-repetition, learning-pace and priority calculations.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as L from "../../web/js/logic.js";

const S = structuredClone(L.DEFAULT_SETTINGS);
const IV = S.intervals;

describe("dates and intervals", () => {
  test("parseDate", () => {
    assert.equal(L.parseDate("2026-09-22"), "2026-09-22");
    assert.equal(L.parseDate("2026-09-22T10:00:00"), "2026-09-22");
    assert.equal(L.parseDate(null), null);
    assert.equal(L.parseDate(""), null);
    assert.throws(() => L.parseDate("not a date"));
    assert.throws(() => L.parseDate("2026-02-30"));
  });
  test("daysSince", () => {
    assert.equal(L.daysSince("2026-09-01", "2026-09-22"), 21);
    assert.equal(L.daysSince("2026-09-22", "2026-09-22"), 0);
    assert.equal(L.daysSince(null, "2026-09-22"), null);
    assert.equal(L.daysSince("2028-02-27", "2028-03-01"), 3); // 2028 is a leap year
  });
  test("addDays across month, year and the clocks changing", () => {
    assert.equal(L.addDays("2026-12-20", 30), "2027-01-19");
    assert.equal(L.addDays("2027-03-27", 2), "2027-03-29"); // UK clocks go forward 28 Mar 2027
    assert.equal(L.addDays("2026-10-24", 2), "2026-10-26"); // and back 25 Oct 2026
  });
  test("localToday uses the local calendar date", () => {
    assert.equal(L.localToday(new Date(2027, 0, 10, 23, 59)), "2027-01-10");
  });
  test("default intervals match the brief", () => {
    assert.deepEqual([1, 2, 3, 4, 5].map((c) => L.intervalFor(c, IV)), [3, 7, 14, 30, 60]);
    assert.equal(L.intervalFor(null, IV), null);
  });
  test("next review counts from the last review", () => {
    for (const [c, gap] of [[1, 3], [2, 7], [3, 14], [4, 30], [5, 60]]) {
      assert.equal(L.nextReview("2026-09-22", c, IV), L.addDays("2026-09-22", gap));
    }
    assert.equal(L.nextReview("2026-12-20", 4, IV), "2027-01-19");
    assert.equal(L.nextReview(null, 3, IV), null);
    assert.equal(L.nextReview("2026-09-22", null, IV), null);
    assert.equal(L.nextReview("2026-09-22", 3, { 1: 1, 2: 2, 3: 4, 4: 8, 5: 16 }), "2026-09-26");
  });
});

describe("first learnt", () => {
  test("anchor is the last review, else first learnt", () => {
    assert.equal(L.scheduleAnchor("2026-10-05", "2026-09-20"), "2026-10-05");
    assert.equal(L.scheduleAnchor(null, "2026-09-20"), "2026-09-20");
    assert.equal(L.scheduleAnchor(null, null), null);
    assert.equal(L.nextReview(L.scheduleAnchor(null, "2026-09-20"), 2, IV), "2026-09-27");
  });
});

describe("learning pace", () => {
  const today = "2026-10-31", target = "2028-05-17";
  test("counts and recent pace", () => {
    const p = L.learningPace(["2026-09-10", "2026-10-05", "2026-10-20", "2026-10-30", null, null], today, target);
    assert.deepEqual([p.total, p.learnt, p.remaining], [6, 4, 2]);
    assert.equal(p.recent, 3);             // window 2026-10-04 .. 2026-10-31
    assert.equal(p.per_week, 0.75);
    assert.equal(p.this_week, 1);          // week starts Mon 2026-10-26
    assert.equal(p.days_left, L.daysBetween(today, target));
    assert.equal(p.required_per_week, L.round((2 * 7) / p.days_left, 2));
    assert.equal(p.verdict, "ahead");
    assert.equal(p.projected_finish, "2026-11-19");
  });
  test("behind when too slow", () => {
    const p = L.learningPace(["2026-10-20", ...Array(79).fill(null)], today, "2027-01-31");
    assert.equal(p.verdict, "behind");
    assert.ok(p.required_per_week > p.per_week);
  });
  test("on-track band", () => {
    const p = L.learningPace(["2026-10-04", "2026-10-11", "2026-10-18", "2026-10-25", null, null, null, null],
      today, L.addDays(today, 28));
    assert.deepEqual([p.per_week, p.required_per_week, p.verdict], [1, 1, "on track"]);
  });
  test("edge verdicts", () => {
    assert.equal(L.learningPace([null, null], today, target).verdict, "not started");
    assert.equal(L.learningPace(["2026-01-01"], today, target).verdict, "all learnt");
    assert.equal(L.learningPace(["2026-01-01", null], today, null).verdict, "no target");
    assert.equal(L.learningPace(["2026-01-01", null], today, "2026-10-01").verdict, "behind");
    assert.equal(L.learningPace(["2025-01-01", null], today, target).projected_finish, null);
  });
  test("target is the setting, else the first exam", () => {
    const s = structuredClone(S);
    assert.equal(L.learnTarget(s), "2028-05-17");
    s.learn_by = "2028-03-31";
    assert.equal(L.learnTarget(s), "2028-03-31");
    s.learn_by = null; s.exams = [];
    assert.equal(L.learnTarget(s), null);
  });
});

describe("due", () => {
  test("due once the next review date arrives", () => {
    assert.deepEqual(L.isDue("2026-09-10", 3, true, IV, "2026-09-23"), { due: false, dueDate: "2026-09-24" });
    assert.deepEqual(L.isDue("2026-09-10", 3, true, IV, "2026-09-24"), { due: true, dueDate: "2026-09-24" });
    assert.deepEqual(L.isDue("2026-09-10", 3, true, IV, "2026-10-30"), { due: true, dueDate: "2026-09-24" });
  });
  test("learnt but unrated is due; not learnt never is", () => {
    assert.deepEqual(L.isDue("2026-09-10", null, true, IV, "2026-09-10"), { due: true, dueDate: "2026-09-10" });
    assert.deepEqual(L.isDue(null, null, false, IV, "2026-09-22"), { due: false, dueDate: null });
    assert.deepEqual(L.isDue(null, 1, false, IV, "2027-09-22"), { due: false, dueDate: null });
  });
});

describe("priority", () => {
  const today = "2027-01-10";
  const p = (kw = {}) => {
    const a = { confidence: 3, anchor: "2027-01-10", learnt: true, marks: 0, settings: S, ...kw };
    return L.priority(a.confidence, a.anchor, a.learnt, a.marks, a.settings, today);
  };
  test("bounded", () => {
    assert.equal(p({ confidence: 1, anchor: "2026-01-01", marks: 1000 }).score, L.round(35 + 25 + (25 * 1000) / 1008 + 15, 1));
    assert.equal(p({ confidence: 5, anchor: null, learnt: false }).score, 0);
  });
  test("lower confidence scores higher; unrated counts as 1", () => {
    const scores = [1, 2, 3, 4, 5].map((c) => p({ confidence: c }).score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
    assert.equal(p({ confidence: null }).components.confidence, 1);
  });
  test("overdue component", () => {
    assert.equal(p({ anchor: "2026-12-20" }).components.overdue, 0.5);   // 7 days late on 14
    assert.equal(p({ anchor: "2027-01-05" }).components.overdue, 0);
    assert.equal(p({ anchor: "2026-06-01" }).components.overdue, 1);     // capped
    assert.ok(p({ anchor: "2026-12-15" }).score > p({ anchor: "2026-12-26" }).score);
    assert.equal(p({ confidence: null }).components.overdue, 1);         // learnt, unrated
    const nl = p({ learnt: false, anchor: null }).components;
    assert.deepEqual([nl.overdue, nl.learnt], [0, 0]);
  });
  test("marks lost saturates", () => {
    assert.equal(p({ marks: 0 }).components.marks, 0);
    assert.equal(p({ marks: 8 }).components.marks, 0.5);
    const m = [0, 2, 5, 10, 40].map((x) => p({ marks: x }).score);
    assert.deepEqual(m, [...m].sort((a, b) => a - b));
    assert.ok(p({ marks: 10000 }).components.marks <= 1);
  });
  test("learnt component", () => {
    assert.equal(p().components.learnt, 1);
    assert.ok(p().score > p({ learnt: false }).score);
  });
  test("exact weighted score", () => {
    const r = p({ confidence: 2, anchor: "2026-12-27", marks: 8 });
    assert.deepEqual(r.components, { confidence: 0.75, overdue: 1, marks: 0.5, learnt: 1 });
    assert.equal(r.score, L.round(35 * 0.75 + 25 + 25 * 0.5 + 15, 1));
  });
  test("custom weights", () => {
    const s = structuredClone(S);
    s.priority_weights = { confidence: 0, overdue: 0, marks: 1, learnt: 0 };
    assert.equal(L.priority(1, null, true, 8, s, today).score, 50);
  });
});

describe("papers and habits", () => {
  const B = { "A*": 80, A: 68, B: 56, C: 44, D: 33, E: 22 };
  test("gradeFor", () => {
    assert.equal(L.gradeFor(80, B), "A*");
    assert.equal(L.gradeFor(79.5, B), "A");
    assert.equal(L.gradeFor(22, B), "E");
    assert.equal(L.gradeFor(10, B), "U");
    assert.equal(L.gradeFor(50, null), null);
    assert.equal(L.gradeFor(50, { "A*": null }), null);
    assert.equal(L.gradeFor(null, B), null);
    assert.equal(L.gradeFor(70, { "A*": 80, A: 68 }), "A");
    assert.equal(L.gradeFor(50, { "A*": 80, A: 68 }), "U");
  });
  test("percent", () => {
    assert.equal(L.percent(73, 100), 73);
    assert.equal(L.percent(50, 75), 66.7);
    assert.equal(L.percent(null, 100), null);
  });
  test("streak", () => {
    const t = "2026-09-22";
    assert.equal(L.reviewStreak([], t), 0);
    assert.equal(L.reviewStreak(["2026-09-22", "2026-09-21", "2026-09-20", "2026-09-18"], t), 3);
    assert.equal(L.reviewStreak(["2026-09-21", "2026-09-20"], t), 2);
    assert.equal(L.reviewStreak(["2026-09-20"], t), 0);
    assert.equal(L.reviewStreak(["2026-09-22", "2026-09-22"], t), 1);
  });
  test("reviews this week start on Monday", () => {
    assert.equal(L.weekStart("2026-09-24"), "2026-09-21");
    assert.equal(L.weekStart("2026-09-21"), "2026-09-21");
    assert.equal(L.weekStart("2026-09-27"), "2026-09-21"); // Sunday
    assert.equal(L.reviewsThisWeek(["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-22", "2026-09-24"], "2026-09-24"), 4);
  });
  test("countdown", () => {
    const c = L.countdown([{ name: "b", date: "2028-06-13" }, { name: "a", date: "2028-05-17" }], "2026-09-22");
    assert.deepEqual(c.map((e) => e.name), ["a", "b"]);
    assert.equal(c[0].days, 603);
  });
});

test("dates are shown and typed as dd/mm/yyyy", () => {
  assert.equal(L.formatDMY("2027-01-03"), "03/01/2027");
  assert.equal(L.formatDMY(null), "");
  for (const s of ["03/01/2027", "3/1/2027", "3-1-27", "3.1.2027", " 03 / 01 / 2027 ", "2027-01-03"]) assert.equal(L.parseDMY(s), "2027-01-03", s);
  assert.equal(L.parseDMY(""), null);
  assert.throws(() => L.parseDMY("31/02/2027"), /real date/);
  assert.throws(() => L.parseDMY("01/13/2027"), /real date/);
  assert.throws(() => L.parseDMY("tomorrow"), /dd\/mm\/yyyy/);
});
