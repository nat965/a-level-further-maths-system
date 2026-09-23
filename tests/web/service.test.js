// Tests for the tracker document operations (the website's equivalent of the old API tests).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as S from "../../web/js/service.js";

const SEED = JSON.parse(readFileSync(new URL("../../web/seed_chapters.json", import.meta.url), "utf8"));
const T = "2027-01-10";
const fresh = () => S.newTracker(SEED);
const ch = (doc, id, today = T) => S.getChapter(doc, id, today);

describe("new tracker", () => {
  test("seeded with the 80 chapters, nothing learnt or due", () => {
    const cs = S.listChapters(fresh(), T);
    assert.equal(cs.length, 80);
    const counts = {};
    for (const c of cs) counts[c.strand] = (counts[c.strand] || 0) + 1;
    assert.deepEqual(counts, { Pure: 30, "Pure Core": 17, Statistics: 6, "Further Stats": 9, Mechanics: 8, "Further Mechanics": 10 });
    assert.deepEqual([cs[0].book, cs[0].ch_num, cs[0].title, cs[0].level], ["Maths Y1 (red)", 1, "Proof and mathematical communication", "AS"]);
    assert.ok(cs.every((c) => !c.learnt && !c.due && c.first_learnt === null && !("terms" in c)));
  });
});

describe("chapters", () => {
  test("update statuses and notes; validation", () => {
    const d = fresh();
    S.updateChapter(d, "3", { summary_status: "done", exercises_status: "in_progress", notes: "discriminant" }, T);
    const c = ch(d, "3");
    assert.deepEqual([c.summary_status, c.exercises_status, c.notes], ["done", "in_progress", "discriminant"]);
    assert.throws(() => S.updateChapter(d, "3", { summary_status: "finished" }, T), /summary_status must be/);
    assert.throws(() => S.updateChapter(d, "3", { confidence: 3 }, T), /Nothing to update/);
    assert.throws(() => S.updateChapter(d, "999", { notes: "x" }, T), /not found/);
  });

  test("reviewing a whole chapter reviews every subtopic, marks it learnt and schedules the next review", () => {
    const d = fresh();
    S.reviewChapter(d, "5", 2, "Ex 5A", T);
    const c = ch(d, "5");
    assert.deepEqual([c.last_reviewed, c.first_learnt, c.confidence, c.next_review, c.days_since, c.due, c.review_count],
      [T, T, 2, "2027-01-17", 0, false, 6]);
    assert.ok(c.subtopics.every((x) => x.confidence === 2 && x.next_review === "2027-01-17"));
    const h = S.chapterHistory(d, "5", T);
    assert.equal(h.reviews.length, 6);
    assert.deepEqual([h.reviews[0].subtopic_title, h.reviews[0].confidence_before, h.reviews[0].note], ["Intersections of graphs", null, "Ex 5A"]);
    assert.throws(() => S.reviewChapter(d, "5", 0, "", T), /Confidence/);
  });

  test("days since recalculates on later days", () => {
    const d = fresh();
    S.reviewChapter(d, "5", 4, "", T);
    assert.equal(ch(d, "5", "2027-01-31").days_since, 21);
    assert.equal(ch(d, "5", "2027-01-31").days_until_review, 9);
    assert.equal(ch(d, "5", "2027-02-15").due, true);
    assert.equal(ch(d, "5", "2027-02-15").days_until_review, -6);
  });

  test("learnt: the date and a confidence for each subtopic schedule the first reviews", () => {
    const d = fresh();
    S.markLearnt(d, "12", 3, T);
    const c = ch(d, "12");
    assert.deepEqual([c.first_learnt, c.learnt, c.confidence, c.next_review, c.last_reviewed, c.due, c.subtopic_count],
      [T, true, 3, "2027-01-24", null, false, 4]);
    assert.throws(() => S.markLearnt(d, "12", 3, T), /Already marked/);
    assert.throws(() => S.markLearnt(d, "13", 9, T), /Confidence/);
    // learnt on an earlier day, rated per subtopic: each first review counts from that day
    S.markLearnt(d, "14", { "14.1": 2, "14.2": 5, "14.3": 3 }, T, "01/01/2027");
    const c14 = ch(d, "14");
    assert.deepEqual([c14.first_learnt, c14.next_review, c14.due, c14.due_count, c14.confidence], ["2027-01-01", "2027-01-08", true, 1, 3.3]);
    assert.deepEqual(c14.subtopics.map((x) => x.next_review), ["2027-01-08", "2027-03-02", "2027-01-15"]);
    assert.throws(() => S.markLearnt(d, "13", {}, T), /Tick at least one/);
    assert.throws(() => S.markLearnt(d, "15", 2, T, "2027-02-01"), /future/);
    assert.throws(() => S.markLearnt(d, "15", 2, T, "soon"), /isn't a date/);
    assert.equal(ch(d, "12", "2027-01-24").due, true);
    assert.ok(S.dueList(d, "2027-01-24").chapters.some((x) => x.id === "12"));
  });

  test("back-filling and changing the first-learnt date", () => {
    const d = fresh();
    S.updateChapter(d, "6", { first_learnt: "01/12/2026" }, T);
    let c = ch(d, "6");
    // learnt but its subtopics aren't rated yet: due now, to rate them
    assert.deepEqual([c.first_learnt, c.next_review, c.due, c.due_count, c.unrated_count, c.days_since_learnt],
      ["2026-12-01", null, true, 5, 5, 40]);
    assert.throws(() => S.updateChapter(d, "6", { first_learnt: "2027-01-11" }, T), /future/);
    assert.throws(() => S.updateChapter(d, "6", { first_learnt: "nope" }, T), /isn't a date/);
    S.updateChapter(d, "7", { first_learnt: T }, T);
    S.updateChapter(d, "7", { first_learnt: null }, T);
    assert.equal(ch(d, "7").learnt, false);
    S.reviewChapter(d, "6", 4, "", T);
    c = ch(d, "6");
    assert.deepEqual([c.due, c.next_review], [false, "2027-02-09"]);
    assert.throws(() => S.updateChapter(d, "6", { first_learnt: null }, T), /already reviewed/);
    // any past date can be chosen, even after the first review
    S.updateChapter(d, "6", { first_learnt: "2027-01-11" }, "2027-01-12");
    assert.equal(ch(d, "6", "2027-01-12").first_learnt, "2027-01-11");
  });
});

describe("subtopics", () => {
  test("every chapter starts with its textbook subheadings", () => {
    const d = fresh();
    assert.equal(d.subtopics.length, 332);
    const cs = S.listChapters(d, T);
    assert.ok(cs.every((c) => c.subtopic_count >= 1));
    assert.deepEqual(ch(d, "1").subtopics.map((x) => [x.id, x.num, x.title]).slice(0, 2),
      [["1.1", 1, "Mathematical structures and arguments"], ["1.2", 2, "Inequality notation"]]);
    const circ2 = cs.find((c) => c.book === "Further Mechanics" && c.ch_num === 9);
    assert.deepEqual(circ2.subtopics.map((x) => [x.title, x.a_only]), [
      ["Conservation of mechanical energy", false], ["Components of acceleration (a general model)", true], ["Problem solving situations", true]]);
    const poisson = cs.find((c) => c.book === "Further Stats" && c.ch_num === 3);
    assert.deepEqual(poisson.subtopics.map((x) => x.title), ["Using the Poisson model"]);
  });

  test("each subtopic has its own reviews, confidence and schedule", () => {
    const d = fresh();
    S.markLearnt(d, "3", 3, T, "2027-01-01");
    S.reviewSubtopics(d, "3", { "3.3": 1, "3.5": 4 }, "completing the square again", T, { on: "08/01/2027", reviewId: "r" });
    let c = ch(d, "3");
    const next = Object.fromEntries(c.subtopics.map((x) => [x.id, x.next_review]));
    assert.deepEqual([next["3.1"], next["3.3"], next["3.5"]], ["2027-01-15", "2027-01-11", "2027-02-07"]);
    assert.deepEqual([c.confidence, c.min_confidence, c.next_review, c.last_reviewed, c.review_count], [2.8, 1, "2027-01-11", "2027-01-08", 2]);
    assert.deepEqual(d.reviews.map((r) => [r.id, r.subtopic_id, r.reviewed_on, r.confidence_before, r.confidence_after]),
      [["r:3.3", "3.3", "2027-01-08", 3, 1], ["r:3.5", "3.5", "2027-01-08", 3, 4]]);
    // three days later only "Completing the square" is due
    const due = S.dueList(d, "2027-01-14").chapters.find((x) => x.id === "3");
    assert.deepEqual([due.due_count, due.due_subtopics.map((x) => x.title), due.overdue_days], [1, ["Completing the square"], 3]);
    // a review dated before a later one doesn't change the current confidence
    S.reviewSubtopics(d, "3", { "3.3": 2 }, "", T, { on: "2027-01-05", reviewId: "old" });
    c = ch(d, "3");
    assert.deepEqual([c.subtopics[2].confidence, c.subtopics[2].last_reviewed, d.reviews[2].confidence_before], [1, "2027-01-08", 3]);
    // validation
    assert.throws(() => S.reviewSubtopics(d, "3", { "3.3": 2 }, "", T, { on: "11/01/2027" }), /future/);
    assert.throws(() => S.reviewSubtopics(d, "3", { "3.3": 2 }, "", T, { on: "31/12/2026" }), /before you first learnt/);
    assert.throws(() => S.reviewSubtopics(d, "3", { "3.3": 2 }, "", T, { on: "31/02/2027" }), /real date/);
    assert.throws(() => S.reviewSubtopics(d, "3", {}, "", T), /Tick at least one/);
    assert.throws(() => S.reviewSubtopics(d, "3", { "4.1": 3 }, "", T), /isn't in this chapter/);
    assert.throws(() => S.reviewSubtopics(d, "3", { "3.1": 6 }, "", T), /Confidence/);
  });

  test("change a review's date, or undo it", () => {
    const d = fresh();
    S.markLearnt(d, "7", 3, T, "2027-01-01");
    S.reviewSubtopics(d, "7", { "7.2": 5 }, "", T, { on: "2027-01-09", reviewId: "a" });
    assert.equal(ch(d, "7").subtopics[1].next_review, "2027-03-10");
    S.updateReview(d, "a:7.2", { reviewed_on: "03/01/2027", note: "logs" }, T);
    assert.deepEqual([ch(d, "7").subtopics[1].next_review, d.reviews[0].note], ["2027-03-04", "logs"]);
    assert.throws(() => S.updateReview(d, "a:7.2", { reviewed_on: "2026-12-25" }, T), /before you first learnt/);
    assert.throws(() => S.updateReview(d, "a:7.2", { reviewed_on: "2027-02-01" }, T), /future/);
    S.deleteReview(d, "a:7.2");
    const x = ch(d, "7").subtopics[1];
    assert.deepEqual([x.confidence, x.last_reviewed, x.next_review], [3, null, "2027-01-15"]);
    assert.throws(() => S.deleteReview(d, "a:7.2"), /not found/);
    // several at once (a whole review session)
    S.reviewChapter(d, "7", 4, "", T, { reviewId: "b" });
    S.deleteReview(d, d.reviews.map((r) => r.id));
    assert.equal(d.reviews.length, 0);
  });

  test("add, rename and delete subtopics", () => {
    const d = fresh();
    S.reviewChapter(d, "2", 4, "", T);
    assert.equal(ch(d, "2").due, false);
    S.addSubtopic(d, "2", "  Rationalising denominators ", { id: "new" });
    let c = ch(d, "2");
    assert.deepEqual(c.subtopics.map((x) => x.title), ["Using the laws of indices", "Working with surds", "Rationalising denominators"]);
    assert.deepEqual([c.subtopics[2].num, c.subtopics[2].needs_rating, c.due, c.unrated_count], [3, true, true, 1]);
    S.renameSubtopic(d, "new", "Rationalising the denominator");
    assert.equal(ch(d, "2").subtopics[2].title, "Rationalising the denominator");
    assert.throws(() => S.renameSubtopic(d, "new", "  "), /name/);
    S.deleteSubtopic(d, "2.1");
    assert.deepEqual([ch(d, "2").subtopic_count, d.reviews.filter((r) => r.subtopic_id === "2.1").length], [2, 0]);
    S.deleteSubtopic(d, "new");
    assert.throws(() => S.deleteSubtopic(d, "2.2"), /at least one subtopic/);
    assert.throws(() => S.addSubtopic(d, "999", "x"), /Chapter not found/);
  });
});

describe("first learnt, per subtopic", () => {
  test("learn a chapter a few subtopics at a time, each with its own date", () => {
    const d = fresh();
    S.markLearnt(d, "3", { "3.1": 3, "3.2": 4 }, T, "02/01/2027");
    let c = ch(d, "3");
    assert.deepEqual([c.learnt, c.started, c.learnt_count, c.first_learnt], [false, true, 2, null]);
    assert.deepEqual(c.subtopics.map((x) => x.first_learnt), ["2027-01-02", "2027-01-02", null, null, null, null]);
    assert.deepEqual([c.subtopics[0].next_review, c.subtopics[1].next_review, c.subtopics[2].due], ["2027-01-16", "2027-02-01", false]);
    // still "next to learn" until every subtopic is learnt
    S.markLearnt(d, "1", 3, T);
    S.markLearnt(d, "2", 3, T);
    assert.ok(S.dueList(d, T).next_to_learn.some((x) => x.id === "3"));
    assert.throws(() => S.markLearnt(d, "3", { "3.1": 3 }, T), /already learnt/);
    // a number rates the rest
    S.markLearnt(d, "3", 2, T, "05/01/2027");
    c = ch(d, "3");
    // once they're all learnt the chapter takes the earliest date, and the rest keep their own
    assert.deepEqual([c.learnt, c.first_learnt, c.learnt_count], [true, "2027-01-02", 6]);
    assert.deepEqual(d.subtopics.filter((x) => x.chapter_id === "3").map((x) => x.first_learnt),
      [null, null, "2027-01-05", "2027-01-05", "2027-01-05", "2027-01-05"]);
    assert.deepEqual(c.subtopics.map((x) => x.own_date), [false, false, true, true, true, true]);
    assert.equal(c.subtopics[3].next_review, "2027-01-12");
    assert.throws(() => S.markLearnt(d, "3", 2, T), /Already marked/);
  });

  test("change one subtopic's date, or put it back to the chapter's", () => {
    const d = fresh();
    S.markLearnt(d, "7", 3, T, "2027-01-01");
    S.setSubtopicLearnt(d, "7.3", "08/01/2027", T);
    let c = ch(d, "7");
    assert.deepEqual([c.subtopics[2].first_learnt, c.subtopics[2].next_review, c.subtopics[0].next_review], ["2027-01-08", "2027-01-22", "2027-01-15"]);
    // setting it to the chapter's date is the same as inheriting it
    S.setSubtopicLearnt(d, "7.3", "2027-01-01", T);
    assert.equal(d.subtopics.find((x) => x.id === "7.3").first_learnt, null);
    S.setSubtopicLearnt(d, "7.3", "2027-01-04", T);
    S.setSubtopicLearnt(d, "7.3", "", T);
    assert.equal(ch(d, "7").subtopics[2].first_learnt, "2027-01-01");
    assert.throws(() => S.setSubtopicLearnt(d, "7.3", "2027-02-01", T), /future/);
    // changing the chapter's date moves the subtopics that use it
    S.setSubtopicLearnt(d, "7.4", "2027-01-06", T);
    S.updateChapter(d, "7", { first_learnt: "2026-12-20" }, T);
    assert.deepEqual(ch(d, "7").subtopics.map((x) => x.first_learnt), ["2026-12-20", "2026-12-20", "2026-12-20", "2027-01-06"]);
  });

  test("reviews can't be before a subtopic was learnt; reviewing an unlearnt one learns it", () => {
    const d = fresh();
    S.markLearnt(d, "4", 3, T, "2027-01-01");
    S.setSubtopicLearnt(d, "4.2", "2027-01-06", T);
    assert.throws(() => S.reviewSubtopics(d, "4", { "4.2": 3 }, "", T, { on: "2027-01-05" }), /before you first learnt Polynomial division/);
    S.reviewSubtopics(d, "4", { "4.1": 3 }, "", T, { on: "2027-01-05", reviewId: "r" });
    assert.throws(() => S.updateReview(d, "r:4.1", { reviewed_on: "2026-12-31" }, T), /before you first learnt Working with polynomials/);
    // an unlearnt chapter: reviewing some subtopics learns just those, on the review date
    S.reviewSubtopics(d, "5", { "5.2": 4 }, "", T, { on: "2027-01-07" });
    const c = ch(d, "5");
    assert.deepEqual([c.learnt, c.learnt_count, c.subtopics[1].first_learnt, c.subtopics[1].next_review], [false, 1, "2027-01-07", "2027-02-06"]);
    // it can't be un-learnt while it has reviews
    assert.throws(() => S.setSubtopicLearnt(d, "5.2", "", T), /already reviewed/);
  });

  test("per-subtopic dates survive JSON and CSV", async () => {
    const { docToCSVs, parseCSV } = await import("../../web/js/files.js");
    const d = fresh();
    S.markLearnt(d, "2", { "2.2": 4 }, T, "2027-01-03");
    assert.deepEqual(S.normalize(JSON.parse(JSON.stringify(d))), d);
    const copy = fresh();
    S.replaceTable(copy, "subtopics", parseCSV(docToCSVs(d)["subtopics.csv"]));
    assert.deepEqual(copy.subtopics, d.subtopics);
  });
});

describe("due list", () => {
  test("sorted by priority; unlearnt never due; unrated learnt is due", () => {
    const d = fresh();
    S.markLearnt(d, "1", 4, T, "2026-11-01");
    S.markLearnt(d, "2", 1, T, "2026-11-01");
    S.markLearnt(d, "3", 5, T, "2027-01-01");
    S.updateChapter(d, "4", { first_learnt: "2027-01-09" }, T);
    const due = S.dueList(d, T);
    const ids = due.chapters.map((c) => c.id);
    assert.deepEqual([...ids].sort(), ["1", "2", "4"]);
    assert.ok(ids.indexOf("2") < ids.indexOf("1"));
    const pr = due.chapters.map((c) => c.priority);
    assert.deepEqual(pr, [...pr].sort((a, b) => b - a));
    assert.deepEqual(due.chapters.find((c) => c.id === "4").due_subtopics.map((x) => x.needs_rating), [true, true, true, true]);
  });

  test("next to learn: first unlearnt chapter in each book", () => {
    const d = fresh();
    S.markLearnt(d, "1", 3, T);
    const nxt = S.dueList(d, T).next_to_learn;
    assert.equal(nxt.length, 6);
    assert.equal(new Set(nxt.map((c) => c.book)).size, 6);
    assert.equal(nxt.find((c) => c.book === "Maths Y1 (red)").ch_num, 2);
  });

  test("marks lost in papers feed priority and the top error type", () => {
    const d = fresh();
    const before = ch(d, "10").priority;
    S.createPaper(d, { paper_code: "H240/01", series: "June 2019", sat_on: "2027-01-09", mark: 71, max_mark: 100 }, { id: "p1" });
    S.addQuestion(d, "p1", { q_num: "7b", chapter_id: "10", marks_lost: 5, error_type: "method", fix: "R-alpha" });
    S.addQuestion(d, "p1", { q_num: "9", chapter_id: "10", marks_lost: 3, error_type: "algebra slip" });
    const c = ch(d, "10");
    assert.deepEqual([c.marks_lost, c.top_error, c.priority_parts.marks], [8, "method", 0.5]);
    assert.ok(c.priority > before);
  });

  test("mistake retests feed the due list", () => {
    const d = fresh();
    S.createMistake(d, { chapter_id: "4", source: "Ex 4B", what_wrong: "sign error", correct_method: "check f(-a)" }, T, { id: "m1" });
    const m = S.listMistakes(d, T)[0];
    assert.deepEqual([m.logged_on, m.retest_on], [T, "2027-01-17"]);
    assert.deepEqual(S.dueList(d, T).retests, []);
    const r = S.dueList(d, "2027-01-18").retests;
    assert.deepEqual([r.length, r[0].days_overdue, r[0].chapter_title], [1, 1, "Polynomials"]);
    S.retestMistake(d, "m1", false, "2027-01-18");
    assert.equal(S.listMistakes(d, T)[0].retest_on, "2027-01-25");
    S.retestMistake(d, "m1", true, "2027-01-18");
    assert.deepEqual([d.mistakes[0].retest_passed, d.mistakes[0].passed_on], [true, "2027-01-18"]);
    assert.deepEqual(S.dueList(d, "2027-02-01").retests, []);
    assert.throws(() => S.createMistake(d, { chapter_id: "4", what_wrong: " " }, T), /went wrong/);
  });
});

describe("papers", () => {
  test("grade from boundaries, upsert, and the chart", () => {
    const d = fresh();
    S.createPaper(d, { paper_code: "Y540", series: "June 2019", sat_on: "2027-01-05", mark: 60, max_mark: 75, time_taken_min: 88 }, { id: "p" });
    assert.deepEqual([S.listPapers(d)[0].percent, S.listPapers(d)[0].grade], [80, null]);
    S.upsertBoundary(d, { paper_code: "Y540", series: "June 2019", a_star: 58, a: 49, b: 41, c: 33, d: 25, e: 18 });
    assert.equal(S.listPapers(d)[0].grade, "A*");
    S.upsertBoundary(d, { paper_code: "Y540", series: "June 2019", a_star: 62, a: 50 });
    assert.equal(S.listBoundaries(d).length, 1);
    assert.equal(S.listPapers(d)[0].grade, "A");
    const chart = Object.fromEntries(S.paperChart(d).map((s) => [s.code, s]));
    assert.equal(Object.keys(chart).length, 7);
    assert.equal(chart.Y540.points[0].percent, 80);
    assert.equal(chart.Y540.a_star_percent, 82.7);
    assert.equal(chart["H240/02"].a_star_percent, null);
  });

  test("validation", () => {
    const d = fresh();
    assert.throws(() => S.createPaper(d, { paper_code: "X999", series: "J", sat_on: "2027-01-01", mark: 1, max_mark: 10 }), /Pick a paper/);
    assert.throws(() => S.createPaper(d, { paper_code: "Y541", series: "J", sat_on: "2027-01-01", mark: 80, max_mark: 75 }), /more than/);
    assert.throws(() => S.upsertBoundary(d, { paper_code: "Y541", series: "J", a_star: 40, a: 50 }), /go down/);
    S.createPaper(d, { paper_code: "H240/03", series: "June 2022", sat_on: "2027-01-01", mark: 50, max_mark: null }, { id: "q" });
    assert.equal(d.papers[0].max_mark, 100);
    assert.throws(() => S.addQuestion(d, "q", { q_num: "1", chapter_id: "3", marks_lost: 2, error_type: "guesswork" }), /Error type/);
  });

  test("deleting a paper deletes its questions", () => {
    const d = fresh();
    S.createPaper(d, { paper_code: "H240/02", series: "June 2023", sat_on: "2027-01-02", mark: 70, max_mark: 100 }, { id: "p" });
    S.addQuestion(d, "p", { q_num: "3", chapter_id: "50", marks_lost: 4, error_type: "misread" });
    assert.equal(ch(d, "50").marks_lost, 4);
    S.deletePaper(d, "p");
    assert.deepEqual([ch(d, "50").marks_lost, d.paper_questions.length], [0, 0]);
  });
});

describe("dashboard and settings", () => {
  test("dashboard figures", () => {
    const d = fresh();
    S.reviewChapter(d, "1", 1, "", "2027-01-04"); // Monday
    S.reviewChapter(d, "2", 2, "", "2027-01-05");
    S.updateChapter(d, "2", { exercises_status: "done" }, "2027-01-05");
    const db = S.dashboard(d, "2027-01-05");
    assert.deepEqual([db.streak, db.reviews_this_week], [2, 7]); // 5 + 2 subtopics
    assert.equal(db.weakest_subtopics.length, 7);
    assert.deepEqual([db.weakest_subtopics[0].chapter_id, db.weakest_subtopics[0].confidence, db.weakest_subtopics[6].confidence], ["1", 1, 2]);
    assert.equal(db.subtopics_due, 0);
    assert.equal(db.by_strand.length, 6);
    assert.equal(db.by_book.length, 6);
    assert.deepEqual([db.by_book[0].name, db.by_book[0].learnt, db.by_book[0].exercises_done], ["Maths Y1 (red)", 2, 1]);
    assert.deepEqual([db.pace.learnt, db.pace.remaining, db.pace.this_week, db.pace.target, db.pace.verdict],
      [2, 78, 2, "2028-05-17", "behind"]);
    assert.equal(db.weakest[0].id, "1");
    assert.equal(db.countdown.length, 7);
  });

  test("changing intervals reschedules; bad settings rejected; reset", () => {
    const d = fresh();
    S.reviewChapter(d, "5", 3, "", T);
    assert.equal(ch(d, "5").next_review, "2027-01-24");
    S.saveSettings(d, { intervals: { 1: 2, 2: 5, 3: 10, 4: 20, 5: 45 } });
    assert.equal(ch(d, "5").next_review, "2027-01-20");
    assert.throws(() => S.saveSettings(d, { intervals: { 1: 0, 2: 5, 3: 10, 4: 20, 5: 45 } }), /interval/);
    assert.throws(() => S.saveSettings(d, { bogus: 1 }), /Unknown setting/);
    S.resetSettings(d, ["intervals"]);
    assert.equal(S.settingsOf(d).intervals[3], 14);
    S.saveSettings(d, { learn_by: "2030-01-01" });
    assert.equal(S.dashboard(d, T).pace.target, "2030-01-01");
  });
});

describe("import", () => {
  test("round trip through JSON keeps everything", () => {
    const d = fresh();
    S.reviewChapter(d, "2", 3, "x", T);
    S.createPaper(d, { paper_code: "H240/01", series: "June 2018", sat_on: "2027-01-08", mark: 81, max_mark: 100 }, { id: "p" });
    S.addQuestion(d, "p", { q_num: "2", chapter_id: "2", marks_lost: 3, error_type: "time" });
    S.createMistake(d, { chapter_id: "2", what_wrong: "w" }, T);
    S.saveSettings(d, { mistake_retest_days: 5 });
    const back = S.normalize(JSON.parse(JSON.stringify(d)));
    assert.deepEqual(back, d);
  });

  test("imports a desktop-app export (numeric ids, settings rows, v1 without first_learnt)", () => {
    const exp = {
      format: "revision-tracker", version: 1, exported_at: "2026-11-20T10:00:00",
      tables: {
        chapters: SEED.slice(0, 3).map((c, i) => ({ id: i + 1, ...c, terms: '["Autumn Y12"]', summary_status: "done",
          exercises_status: "not_started", examq_status: "not_started", confidence: i === 1 ? 2 : null, notes: "", sort_order: i + 1 })),
        reviews: [{ id: 1, chapter_id: 2, reviewed_on: "2026-11-11", confidence_before: null, confidence_after: 2, note: "", created_at: "x" }],
        papers: [{ id: 1, paper_code: "H240/01", series: "June 2019", sat_on: "2026-11-12", mark: 70, max_mark: 100, time_taken_min: null, notes: "" }],
        paper_questions: [{ id: 1, paper_id: 1, q_num: "4", chapter_id: 2, marks_lost: 3, error_type: "method", fix: "" }],
        boundaries: [], mistakes: [{ id: 1, logged_on: "2026-11-12", chapter_id: 3, source: "", what_wrong: "w", correct_method: "",
          retest_on: "2026-11-19", retest_passed: 0, passed_on: null }],
        settings: [{ key: "priority_weights", value: JSON.stringify({ confidence: 40, overdue: 20, marks: 30, taught: 10 }) },
                   { key: "terms", value: "[]" }, { key: "open_in", value: '"browser"' }],
      },
    };
    const d = S.normalize(exp);
    const c2 = S.getChapter(d, "2", T);
    // the chapter review counts for both of its subtopics
    assert.deepEqual([c2.first_learnt, c2.learnt, c2.marks_lost, c2.review_count, c2.confidence, c2.next_review],
      ["2026-11-11", true, 3, 2, 2, "2026-11-18"]);
    assert.deepEqual(d.reviews.map((r) => r.id), ["1:2.1", "1:2.2"]);
    assert.equal(S.getChapter(d, "1", T).first_learnt, null);
    assert.deepEqual(S.settingsOf(d).priority_weights, { confidence: 40, overdue: 20, marks: 30, learnt: 10 });
    assert.deepEqual(Object.keys(d.settings), ["priority_weights"]);
    assert.equal(d.mistakes[0].retest_passed, false);
  });

  test("trackers from before subtopics are upgraded, the same way every time", () => {
    const old = fresh();
    delete old.subtopics;
    old.version = 2;
    for (const c of old.chapters) c.confidence = null;
    Object.assign(old.chapters[4], { first_learnt: "2027-01-01", confidence: 3 });
    Object.assign(old.chapters[5], { first_learnt: "2027-01-02", confidence: 4 });
    old.reviews.push({ id: "r1", chapter_id: "5", reviewed_on: "2027-01-05", confidence_before: 2, confidence_after: 3, note: "n", created_at: "t" });
    const d = S.normalize(JSON.parse(JSON.stringify(old)));
    assert.equal(d.version, 3);
    assert.equal(d.subtopics.length, 332);
    assert.ok(d.chapters.every((c) => !("confidence" in c)));
    assert.equal(d.reviews.length, 6);
    assert.deepEqual(d.reviews[0], { id: "r1:5.1", chapter_id: "5", subtopic_id: "5.1", reviewed_on: "2027-01-05",
      confidence_before: 2, confidence_after: 3, note: "n", created_at: "t" });
    assert.deepEqual([ch(d, "5").confidence, ch(d, "5").next_review], [3, "2027-01-19"]);
    assert.deepEqual([ch(d, "6").confidence, ch(d, "6").next_review, ch(d, "6").review_count], [4, "2027-02-01", 0]);
    assert.deepEqual(S.normalize(JSON.parse(JSON.stringify(d))), d);
    assert.deepEqual(S.normalize(JSON.parse(JSON.stringify(old))), d);
  });

  test("rejects files that aren't trackers or have broken references", () => {
    assert.throws(() => S.normalize({ format: "other" }), /isn't a Revision Tracker/);
    const d = fresh();
    d.reviews.push({ id: "r", chapter_id: "999", reviewed_on: T, confidence_before: null, confidence_after: 3, note: "", created_at: "" });
    assert.throws(() => S.normalize(d), /pointing at chapters/);
    const e = fresh();
    e.reviews.push({ id: "r", chapter_id: "2", subtopic_id: "3.1", reviewed_on: T, confidence_before: null, confidence_after: 3, note: "", created_at: "" });
    assert.throws(() => S.normalize(e), /pointing at chapters/);
  });

  test("replace one table from CSV rows", () => {
    const d = fresh();
    const rows = d.chapters.map((c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v === null ? "" : String(v)])));
    rows[1].notes = "edited in a spreadsheet";
    S.replaceTable(d, "chapters", rows);
    assert.equal(S.getChapter(d, "2", T).notes, "edited in a spreadsheet");
    assert.equal(d.subtopics.length, 332);
    assert.throws(() => S.replaceTable(d, "nope", []), /Unknown table/);
    assert.throws(() => S.replaceTable(d, "chapters", []), /empty/);
  });
});

describe("question bank", () => {
  const img = (id, extra = {}) => ({ id, name: `${id}.jpg`, mime: "image/jpeg", size: 1234, thumb_id: `${id}-t`, ...extra });
  const pdf = (id) => ({ id, name: `${id}.pdf`, mime: "application/pdf", size: 99999 });

  test("add a question with files and a model solution to a chapter", () => {
    const d = fresh();
    S.createBankQuestion(d, { chapter_id: "38", title: "Ex 2C Q7", source: "Textbook", status: "wrong",
      files: [img("f1"), pdf("f2")], solution_files: [img("s1")], solution_text: "Use de Moivre" }, T, { id: "q1" });
    const [q] = S.listBank(d);
    assert.deepEqual([q.id, q.chapter_title, q.title, q.status, q.added_on, q.files.length, q.has_solution],
      ["q1", "Powers and roots of complex numbers", "Ex 2C Q7", "wrong", T, 2, true]);
    assert.equal(S.getChapter(d, "38", T).question_count, 1);
    assert.deepEqual([...S.referencedFileIds(d)].sort(), ["f1", "f1-t", "f2", "s1", "s1-t"]);
    assert.deepEqual(S.questionFileIds(d.questions[0]).sort(), ["f1", "f1-t", "f2", "s1", "s1-t"]);
  });

  test("validation", () => {
    const d = fresh();
    assert.throws(() => S.createBankQuestion(d, { chapter_id: "999", files: [img("a")] }, T), /Pick the chapter/);
    assert.throws(() => S.createBankQuestion(d, { chapter_id: "1", files: [] }, T), /at least one photo or PDF/);
    assert.throws(() => S.createBankQuestion(d, { chapter_id: "1", files: [{ name: "x" }] }, T), /needs an id/);
    assert.throws(() => S.createBankQuestion(d, { chapter_id: "1", status: "meh", files: [img("a")] }, T), /Status/);
  });

  test("edit, add and remove files, move to another chapter", () => {
    const d = fresh();
    S.createBankQuestion(d, { chapter_id: "4", files: [img("f1")] }, T, { id: "q" });
    S.updateBankQuestion(d, "q", { title: "Factor theorem", status: "right", notes: "careful with signs", solution_text: "f(2)=0" });
    S.addBankFiles(d, "q", "solution", [pdf("s1")]);
    S.addBankFiles(d, "q", "question", [img("f2")]);
    let q = S.getBankQuestion(d, "q", T);
    assert.deepEqual([q.title, q.status, q.notes, q.files.length, q.solution_files.length], ["Factor theorem", "right", "careful with signs", 2, 1]);
    S.removeBankFile(d, "q", "f1");
    S.removeBankFile(d, "q", "s1");
    assert.throws(() => S.removeBankFile(d, "q", "f2"), /at least one file/);
    assert.throws(() => S.addBankFiles(d, "q", "answers", [pdf("x")]), /role/);
    S.createMistake(d, { chapter_id: "4", what_wrong: "sign", question_id: "q" }, T, { id: "m" });
    S.updateBankQuestion(d, "q", { chapter_id: "5" });
    assert.equal(d.mistakes[0].chapter_id, "5"); // linked mistakes follow the question
    q = S.getBankQuestion(d, "q", T);
    assert.deepEqual([q.files.map((f) => f.id), q.solution_files.length, q.chapter_title], [["f2"], 0, "Using graphs"]);
  });

  test("mistakes attached to a question", () => {
    const d = fresh();
    S.createBankQuestion(d, { chapter_id: "20", title: "Q3", files: [img("f")] }, T, { id: "q" });
    // logging a mistake from the question fills in its chapter
    S.createMistake(d, { question_id: "q", what_wrong: "forgot +c", correct_method: "always add +c" }, T, { id: "m1" });
    S.createMistake(d, { chapter_id: "20", what_wrong: "separate one" }, T, { id: "m2" });
    S.linkMistake(d, "q", "m2");
    let q = S.getBankQuestion(d, "q", T);
    assert.deepEqual([q.mistake_count, q.open_mistakes, q.mistakes.map((m) => m.id).sort()], [2, 2, ["m1", "m2"]]);
    assert.equal(d.mistakes.find((m) => m.id === "m1").chapter_id, "20");
    assert.equal(S.listMistakes(d, T).find((m) => m.id === "m1").question_title, "Q3");
    S.retestMistake(d, "m1", true, T);
    assert.equal(S.getBankQuestion(d, "q", T).open_mistakes, 1);
    // due retests say which question to redo
    const retest = S.dueList(d, "2027-01-17").retests.find((m) => m.id === "m2");
    assert.deepEqual([retest.question_id, retest.question_title], ["q", "Q3"]);
    S.unlinkMistake(d, "m2");
    assert.equal(S.getBankQuestion(d, "q", T).mistake_count, 1);
    assert.throws(() => S.createMistake(d, { question_id: "nope", what_wrong: "x" }, T), /Question not found/);
    // deleting the question keeps the mistakes but unlinks them
    S.deleteBankQuestion(d, "q");
    assert.deepEqual([d.questions.length, d.mistakes.length, d.mistakes[0].question_id], [0, 2, null]);
  });

  test("subtopics and their reviews survive a CSV round trip", async () => {
    const { docToCSVs, parseCSV } = await import("../../web/js/files.js");
    const d = fresh();
    S.markLearnt(d, "4", 3, T, "2027-01-02");
    S.reviewSubtopics(d, "4", { "4.2": 2 }, "division", T, { reviewId: "r" });
    S.renameSubtopic(d, "4.4", 'Sketching, "roughly"');
    const csv = docToCSVs(d);
    const copy = fresh();
    for (const t of ["chapters", "subtopics", "reviews"]) S.replaceTable(copy, t, parseCSV(csv[`${t}.csv`]));
    assert.deepEqual([copy.chapters, copy.subtopics, copy.reviews], [d.chapters, d.subtopics, d.reviews]);
  });

  test("a question can be on one subtopic of its chapter", () => {
    const d = fresh();
    S.createBankQuestion(d, { chapter_id: "3", subtopic_id: "3.3", title: "CTS", files: [img("f1")] }, T, { id: "q1" });
    S.createBankQuestion(d, { chapter_id: "3", title: "Mixed", files: [img("f2")] }, T, { id: "q2" });
    let [a, b] = ["q1", "q2"].map((id) => S.getBankQuestion(d, id, T));
    assert.deepEqual([a.subtopic_id, a.subtopic_title, a.subtopic_num, b.subtopic_id, b.subtopic_title], ["3.3", "Completing the square", 3, null, null]);
    const c = ch(d, "3");
    assert.deepEqual([c.question_count, c.subtopics[2].question_count, c.subtopics[0].question_count], [2, 1, 0]);
    assert.throws(() => S.createBankQuestion(d, { chapter_id: "3", subtopic_id: "4.1", files: [img("x")] }, T), /isn't in this question's chapter/);
    // move between subtopics, back to the whole chapter, and to another chapter
    S.updateBankQuestion(d, "q1", { subtopic_id: "3.4" });
    assert.equal(d.questions[0].subtopic_id, "3.4");
    S.updateBankQuestion(d, "q1", { subtopic_id: "" });
    assert.equal(d.questions[0].subtopic_id, null);
    S.updateBankQuestion(d, "q1", { subtopic_id: "3.5" });
    assert.throws(() => S.updateBankQuestion(d, "q1", { subtopic_id: "7.1" }), /isn't in/);
    S.updateBankQuestion(d, "q1", { chapter_id: "7" }); // its old subtopic doesn't apply any more
    assert.deepEqual([d.questions[0].chapter_id, d.questions[0].subtopic_id], ["7", null]);
    S.updateBankQuestion(d, "q1", { chapter_id: "3", subtopic_id: "3.6" });
    assert.equal(d.questions[0].subtopic_id, "3.6");
    // deleting the subtopic keeps the question in the chapter
    S.deleteSubtopic(d, "3.6");
    assert.deepEqual([d.questions.length, d.questions[0].chapter_id, d.questions[0].subtopic_id], [2, "3", null]);
    // bad references in a file are refused
    const broken = JSON.parse(JSON.stringify(d));
    broken.questions[0].subtopic_id = "5.1";
    assert.throws(() => S.normalize(broken), /pointing at chapters/);
  });

  test("questions survive JSON and CSV round trips; old trackers without questions still load", async () => {
    const { docToCSVs, parseCSV } = await import("../../web/js/files.js");
    const d = fresh();
    S.createBankQuestion(d, { chapter_id: "2", subtopic_id: "2.2", title: 'Surds, "rationalise"', files: [img("f1")], solution_files: [pdf("s1")] }, T, { id: "q" });
    S.createMistake(d, { question_id: "q", what_wrong: "w" }, T, { id: "m" });
    assert.deepEqual(S.normalize(JSON.parse(JSON.stringify(d))), d);
    const csv = docToCSVs(d);
    const copy = fresh();
    S.replaceTable(copy, "questions", parseCSV(csv["questions.csv"]));
    S.replaceTable(copy, "mistakes", parseCSV(csv["mistakes.csv"]));
    assert.deepEqual(copy.questions, d.questions);
    assert.equal(copy.mistakes[0].question_id, "q");
    const old = fresh();
    delete old.questions;
    assert.deepEqual(S.normalize(old).questions, []);
    const broken = fresh();
    broken.questions = [{ id: "x", chapter_id: "999", files: [] }];
    assert.throws(() => S.normalize(broken), /pointing at chapters/);
  });
});
