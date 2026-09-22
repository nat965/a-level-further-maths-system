"""Unit tests for the date, spaced-repetition, schedule and priority calculations."""
import copy
import unittest
from datetime import date, timedelta

from revision_tracker import logic

S = copy.deepcopy(logic.DEFAULT_SETTINGS)
IV = S["intervals"]
TERMS = S["terms"]
D = date.fromisoformat


class DaysAndIntervals(unittest.TestCase):
    def test_parse_date(self):
        self.assertEqual(logic.parse_date("2026-09-22"), D("2026-09-22"))
        self.assertEqual(logic.parse_date("2026-09-22T10:00:00"), D("2026-09-22"))
        self.assertIsNone(logic.parse_date(None))
        self.assertIsNone(logic.parse_date(""))

    def test_days_since(self):
        self.assertEqual(logic.days_since("2026-09-01", D("2026-09-22")), 21)
        self.assertEqual(logic.days_since("2026-09-22", D("2026-09-22")), 0)
        self.assertIsNone(logic.days_since(None, D("2026-09-22")))

    def test_days_since_across_month_and_leap_day(self):
        self.assertEqual(logic.days_since("2028-02-27", D("2028-03-01")), 3)  # 2028 is a leap year

    def test_default_intervals_match_brief(self):
        self.assertEqual([logic.interval_for(c, IV) for c in (1, 2, 3, 4, 5)], [3, 7, 14, 30, 60])
        self.assertIsNone(logic.interval_for(None, IV))

    def test_next_review_counts_from_last_review(self):
        for conf, gap in ((1, 3), (2, 7), (3, 14), (4, 30), (5, 60)):
            self.assertEqual(logic.next_review("2026-09-22", conf, IV), D("2026-09-22") + timedelta(days=gap))

    def test_next_review_crosses_year_end(self):
        self.assertEqual(logic.next_review("2026-12-20", 4, IV), D("2027-01-19"))

    def test_next_review_needs_both_review_and_confidence(self):
        self.assertIsNone(logic.next_review(None, 3, IV))
        self.assertIsNone(logic.next_review("2026-09-22", None, IV))

    def test_custom_intervals(self):
        custom = {"1": 1, "2": 2, "3": 4, "4": 8, "5": 16}
        self.assertEqual(logic.next_review("2026-09-22", 3, custom), D("2026-09-26"))


class Schedule(unittest.TestCase):
    def test_taught_status_single_term(self):
        t = ["Autumn Y12"]
        self.assertEqual(logic.taught_status(t, TERMS, D("2026-08-30")), "not_yet")
        self.assertEqual(logic.taught_status(t, TERMS, D("2026-09-02")), "in_progress")
        self.assertEqual(logic.taught_status(t, TERMS, D("2026-12-18")), "in_progress")  # last day of term
        self.assertEqual(logic.taught_status(t, TERMS, D("2026-12-19")), "taught")

    def test_taught_status_two_terms_uses_last_term(self):
        t = ["Autumn Y12", "Spring Y12"]
        self.assertEqual(logic.taught_status(t, TERMS, D("2026-12-25")), "in_progress")  # holiday between terms
        self.assertEqual(logic.taught_status(t, TERMS, D("2027-03-27")), "taught")

    def test_unknown_term_is_not_yet(self):
        self.assertEqual(logic.taught_status(["Summer Y13"], TERMS, D("2028-06-01")), "not_yet")

    def test_expected_fraction_pro_rates_current_term(self):
        t = ["Autumn Y12"]  # 2026-09-02 .. 2026-12-18 = 107 days
        self.assertEqual(logic.expected_fraction(t, TERMS, D("2026-09-01")), 0.0)
        self.assertAlmostEqual(logic.expected_fraction(t, TERMS, D("2026-10-01")), 29 / 107)
        self.assertEqual(logic.expected_fraction(t, TERMS, D("2026-12-18")), 1.0)

    def test_schedule_position_ahead_behind(self):
        chapters = [{"terms": ["Autumn Y12"], "exercises_status": "done"} for _ in range(3)] + \
                   [{"terms": ["Autumn Y12"], "exercises_status": "not_started"} for _ in range(7)] + \
                   [{"terms": ["Spring Y12"], "exercises_status": "done"}]
        # Just after Autumn Y12 ends: school expects all 10 Autumn chapters, you've done 4.
        pos = logic.schedule_position(chapters, TERMS, D("2026-12-20"))
        self.assertEqual(pos["expected"], 10.0)
        self.assertEqual(pos["covered"], 4)
        self.assertEqual(pos["diff"], -6.0)
        self.assertEqual(pos["verdict"], "behind")
        autumn = next(t for t in pos["per_term"] if t["term"] == "Autumn Y12")
        self.assertEqual((autumn["state"], autumn["chapters"], autumn["covered"]), ("finished", 10, 3))
        spring = next(t for t in pos["per_term"] if t["term"] == "Spring Y12")
        self.assertEqual((spring["state"], spring["expected"], spring["diff"]), ("upcoming", 0.0, 1.0))

    def test_schedule_position_ahead(self):
        chapters = [{"terms": ["Spring Y12"], "exercises_status": "done"}]
        pos = logic.schedule_position(chapters, TERMS, D("2026-10-01"))
        self.assertEqual((pos["verdict"], pos["diff"]), ("ahead", 1.0))


class Due(unittest.TestCase):
    def test_due_when_next_review_reached(self):
        self.assertEqual(logic.is_due("2026-09-10", 3, "taught", IV, D("2026-09-23")), (False, D("2026-09-24")))
        self.assertEqual(logic.is_due("2026-09-10", 3, "taught", IV, D("2026-09-24")), (True, D("2026-09-24")))
        self.assertEqual(logic.is_due("2026-09-10", 3, "taught", IV, D("2026-10-30")), (True, D("2026-09-24")))

    def test_taught_but_never_reviewed_is_due(self):
        self.assertEqual(logic.is_due(None, None, "taught", IV, D("2027-01-05")), (True, None))
        self.assertEqual(logic.is_due(None, 2, "taught", IV, D("2027-01-05")), (True, None))

    def test_not_taught_and_never_reviewed_is_not_due(self):
        self.assertEqual(logic.is_due(None, None, "in_progress", IV, D("2026-09-22")), (False, None))
        self.assertEqual(logic.is_due(None, None, "not_yet", IV, D("2026-09-22")), (False, None))


class Priority(unittest.TestCase):
    today = D("2027-01-10")

    def p(self, **kw):
        args = dict(confidence=3, last_reviewed=None, taught="taught", marks_lost=0, settings=S, today=self.today)
        args.update(kw)
        return logic.priority(**args)

    def test_score_is_bounded(self):
        worst = self.p(confidence=1, last_reviewed="2026-01-01", marks_lost=1000)
        best = self.p(confidence=5, last_reviewed=self.today.isoformat(), taught="not_yet")
        self.assertLessEqual(worst["score"], 100)
        self.assertGreaterEqual(best["score"], 0)
        self.assertEqual(best["score"], 0.0)

    def test_lower_confidence_scores_higher(self):
        scores = [self.p(confidence=c, last_reviewed="2027-01-10")["score"] for c in (1, 2, 3, 4, 5)]
        self.assertEqual(scores, sorted(scores, reverse=True))
        self.assertEqual(self.p(confidence=None)["components"]["confidence"], 1.0)

    def test_overdue_component(self):
        # conf 3 -> 14-day interval. Reviewed 2026-12-20 -> due 2027-01-03 -> 7 days late on 01-10.
        r = self.p(confidence=3, last_reviewed="2026-12-20")
        self.assertAlmostEqual(r["components"]["overdue"], 0.5)
        not_yet_due = self.p(confidence=3, last_reviewed="2027-01-05")
        self.assertEqual(not_yet_due["components"]["overdue"], 0.0)
        very_late = self.p(confidence=3, last_reviewed="2026-06-01")
        self.assertEqual(very_late["components"]["overdue"], 1.0)  # capped

    def test_more_overdue_scores_higher(self):
        a = self.p(last_reviewed="2026-12-26")["score"]   # 1 day late
        b = self.p(last_reviewed="2026-12-15")["score"]   # 12 days late
        self.assertGreater(b, a)

    def test_taught_never_reviewed_counts_fully_overdue(self):
        self.assertEqual(self.p(last_reviewed=None, taught="taught")["components"]["overdue"], 1.0)
        self.assertEqual(self.p(last_reviewed=None, taught="in_progress")["components"]["overdue"], 0.0)

    def test_marks_lost_saturates(self):
        half = S["marks_half_point"]
        self.assertEqual(self.p(marks_lost=0)["components"]["marks"], 0.0)
        self.assertAlmostEqual(self.p(marks_lost=half)["components"]["marks"], 0.5)
        m = [self.p(marks_lost=x)["score"] for x in (0, 2, 5, 10, 40)]
        self.assertEqual(m, sorted(m))
        self.assertLess(self.p(marks_lost=10_000)["components"]["marks"], 1.0 + 1e-9)

    def test_taught_component(self):
        self.assertEqual(self.p(taught="taught")["components"]["taught"], 1.0)
        self.assertEqual(self.p(taught="in_progress")["components"]["taught"], 0.5)
        self.assertEqual(self.p(taught="not_yet")["components"]["taught"], 0.0)
        self.assertGreater(self.p(taught="taught")["score"], self.p(taught="not_yet")["score"])

    def test_exact_weighted_score(self):
        # conf 2 -> 0.75; 7 days late on a 7-day interval -> overdue 1.0; 8 marks -> 0.5; taught -> 1
        r = self.p(confidence=2, last_reviewed="2026-12-27", marks_lost=8)
        self.assertEqual(r["components"], {"confidence": 0.75, "overdue": 1.0, "marks": 0.5, "taught": 1.0})
        expected = 100 * (35 * 0.75 + 25 * 1.0 + 25 * 0.5 + 15 * 1.0) / 100
        self.assertEqual(r["score"], round(expected, 1))

    def test_custom_weights(self):
        s = copy.deepcopy(S)
        s["priority_weights"] = {"confidence": 0, "overdue": 0, "marks": 1, "taught": 0}
        r = logic.priority(1, None, "taught", 8, s, self.today)
        self.assertEqual(r["score"], 50.0)


class PapersAndHabits(unittest.TestCase):
    B = {"A*": 80, "A": 68, "B": 56, "C": 44, "D": 33, "E": 22}

    def test_grade_for(self):
        self.assertEqual(logic.grade_for(80, self.B), "A*")
        self.assertEqual(logic.grade_for(79.5, self.B), "A")
        self.assertEqual(logic.grade_for(22, self.B), "E")
        self.assertEqual(logic.grade_for(10, self.B), "U")
        self.assertIsNone(logic.grade_for(50, None))
        self.assertIsNone(logic.grade_for(50, {"A*": None}))
        self.assertIsNone(logic.grade_for(None, self.B))

    def test_grade_with_partial_boundaries(self):
        self.assertEqual(logic.grade_for(70, {"A*": 80, "A": 68}), "A")
        self.assertEqual(logic.grade_for(50, {"A*": 80, "A": 68}), "U")

    def test_percent(self):
        self.assertEqual(logic.percent(73, 100), 73.0)
        self.assertEqual(logic.percent(50, 75), 66.7)
        self.assertIsNone(logic.percent(None, 100))

    def test_streak(self):
        t = D("2026-09-22")
        self.assertEqual(logic.review_streak([], t), 0)
        self.assertEqual(logic.review_streak(["2026-09-22", "2026-09-21", "2026-09-20", "2026-09-18"], t), 3)
        # nothing yet today, but yesterday counts: streak still alive
        self.assertEqual(logic.review_streak(["2026-09-21", "2026-09-20"], t), 2)
        self.assertEqual(logic.review_streak(["2026-09-20"], t), 0)
        # several reviews on one day count once
        self.assertEqual(logic.review_streak(["2026-09-22", "2026-09-22"], t), 1)

    def test_reviews_this_week_starts_monday(self):
        t = D("2026-09-24")  # Thursday
        dates = ["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-22", "2026-09-24"]
        self.assertEqual(logic.week_start(t), D("2026-09-21"))
        self.assertEqual(logic.reviews_this_week(dates, t), 4)

    def test_countdown(self):
        c = logic.countdown([{"name": "b", "date": "2028-06-13"}, {"name": "a", "date": "2028-05-17"}],
                            D("2026-09-22"))
        self.assertEqual([e["name"] for e in c], ["a", "b"])
        self.assertEqual(c[0]["days"], (D("2028-05-17") - D("2026-09-22")).days)


if __name__ == "__main__":
    unittest.main()
