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
  test("update statuses, confidence, notes; validation", () => {
    const d = fresh();
    S.updateChapter(d, "3", { summary_status: "done", exercises_status: "in_progress", confidence: 2, notes: "discriminant" }, T);
    const c = ch(d, "3");
    assert.deepEqual([c.summary_status, c.exercises_status, c.confidence, c.notes], ["done", "in_progress", 2, "discriminant"]);
    assert.throws(() => S.updateChapter(d, "3", { summary_status: "finished" }, T), /summary_status must be/);
    assert.throws(() => S.updateChapter(d, "3", { confidence: 6 }, T), /Confidence/);
    assert.throws(() => S.updateChapter(d, "999", { confidence: 3 }, T), /not found/);
  });

  test("reviewed today stamps the date, logs history, schedules next, marks learnt", () => {
    const d = fresh();
    S.reviewChapter(d, "5", 2, "Ex 5A", T);
    const c = ch(d, "5");
    assert.deepEqual([c.last_reviewed, c.first_learnt, c.confidence, c.next_review, c.days_since, c.due],
      [T, T, 2, "2027-01-17", 0, false]);
    const h = S.chapterHistory(d, "5", T);
    assert.equal(h.reviews.length, 1);
    assert.equal(h.reviews[0].confidence_before, null);
    assert.equal(h.reviews[0].note, "Ex 5A");
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

  test("undo the latest review restores confidence", () => {
    const d = fresh();
    S.updateChapter(d, "7", { confidence: 3 }, T);
    S.reviewChapter(d, "7", 5, "", T);
    S.deleteReview(d, S.chapterHistory(d, "7", T).reviews[0].id);
    const c = ch(d, "7");
    assert.deepEqual([c.confidence, c.last_reviewed], [3, null]);
  });

  test("learnt today schedules the first review", () => {
    const d = fresh();
    S.markLearnt(d, "12", 3, T);
    let c = ch(d, "12");
    assert.deepEqual([c.first_learnt, c.learnt, c.confidence, c.next_review, c.last_reviewed, c.due],
      [T, true, 3, "2027-01-24", null, false]);
    assert.throws(() => S.markLearnt(d, "12", 3, T), /Already marked/);
    assert.throws(() => S.markLearnt(d, "13", 9, T), /Confidence/);
    // learnt on an earlier day: the first review counts from that day
    S.markLearnt(d, "14", 2, T, "2027-01-01");
    assert.deepEqual([ch(d, "14").first_learnt, ch(d, "14").next_review, ch(d, "14").due], ["2027-01-01", "2027-01-08", true]);
    assert.throws(() => S.markLearnt(d, "15", 2, T, "2027-02-01"), /future/);
    assert.throws(() => S.markLearnt(d, "15", 2, T, "soon"), /must be a date/);
    assert.equal(ch(d, "12", "2027-01-24").due, true);
    assert.ok(S.dueList(d, "2027-01-24").chapters.some((c) => c.id === "12"));
  });

  test("back-filling a first-learnt date", () => {
    const d = fresh();
    S.updateChapter(d, "6", { first_learnt: "2026-12-01", confidence: 4 }, T);
    let c = ch(d, "6");
    assert.deepEqual([c.first_learnt, c.next_review, c.due, c.days_since_learnt], ["2026-12-01", "2026-12-31", true, 40]);
    assert.throws(() => S.updateChapter(d, "6", { first_learnt: "2027-01-11" }, T), /future/);
    assert.throws(() => S.updateChapter(d, "6", { first_learnt: "nope" }, T), /must be a date/);
    S.updateChapter(d, "7", { first_learnt: T }, T);
    assert.equal(ch(d, "7").due, true); // learnt but unrated
    S.updateChapter(d, "7", { first_learnt: null }, T);
    assert.equal(ch(d, "7").learnt, false);
    S.reviewChapter(d, "6", 4, "", T);
    assert.throws(() => S.updateChapter(d, "6", { first_learnt: null }, T), /already reviewed/);
    // any past date can be chosen, even after the first review
    S.updateChapter(d, "6", { first_learnt: "2027-01-11" }, "2027-01-12");
    assert.equal(ch(d, "6", "2027-01-12").first_learnt, "2027-01-11");
  });
});

describe("due list", () => {
  test("sorted by priority; unlearnt never due; unrated learnt is due", () => {
    const d = fresh();
    S.updateChapter(d, "1", { first_learnt: "2026-11-01", confidence: 4 }, T);
    S.updateChapter(d, "2", { first_learnt: "2026-11-01", confidence: 1 }, T);
    S.updateChapter(d, "3", { first_learnt: "2027-01-01", confidence: 5 }, T);
    S.updateChapter(d, "4", { first_learnt: "2027-01-09" }, T);
    const due = S.dueList(d, T);
    const ids = due.chapters.map((c) => c.id);
    assert.deepEqual([...ids].sort(), ["1", "2", "4"]);
    assert.ok(ids.indexOf("2") < ids.indexOf("1"));
    const pr = due.chapters.map((c) => c.priority);
    assert.deepEqual(pr, [...pr].sort((a, b) => b - a));
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
    assert.deepEqual([db.streak, db.reviews_this_week], [2, 2]);
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
    assert.deepEqual([c2.first_learnt, c2.learnt, c2.marks_lost, c2.review_count], ["2026-11-11", true, 3, 1]);
    assert.equal(S.getChapter(d, "1", T).first_learnt, null);
    assert.deepEqual(S.settingsOf(d).priority_weights, { confidence: 40, overdue: 20, marks: 30, learnt: 10 });
    assert.deepEqual(Object.keys(d.settings), ["priority_weights"]);
    assert.equal(d.mistakes[0].retest_passed, false);
  });

  test("rejects files that aren't trackers or have broken references", () => {
    assert.throws(() => S.normalize({ format: "other" }), /isn't a Revision Tracker/);
    const d = fresh();
    d.reviews.push({ id: "r", chapter_id: "999", reviewed_on: T, confidence_before: null, confidence_after: 3, note: "", created_at: "" });
    assert.throws(() => S.normalize(d), /pointing at chapters/);
  });

  test("replace one table from CSV rows", () => {
    const d = fresh();
    const rows = d.chapters.map((c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v === null ? "" : String(v)])));
    rows[1].notes = "edited in a spreadsheet";
    rows[0].confidence = "4";
    S.replaceTable(d, "chapters", rows);
    assert.equal(S.getChapter(d, "2", T).notes, "edited in a spreadsheet");
    assert.equal(S.getChapter(d, "1", T).confidence, 4);
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

  test("questions survive JSON and CSV round trips; old trackers without questions still load", async () => {
    const { docToCSVs, parseCSV } = await import("../../web/js/files.js");
    const d = fresh();
    S.createBankQuestion(d, { chapter_id: "2", title: 'Surds, "rationalise"', files: [img("f1")], solution_files: [pdf("s1")] }, T, { id: "q" });
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
