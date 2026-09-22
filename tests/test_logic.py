"""Unit tests for the date, spaced-repetition, learning-pace and priority calculations."""
import copy
import unittest
from datetime import date, timedelta

from revision_tracker import logic

S = copy.deepcopy(logic.DEFAULT_SETTINGS)
IV = S["intervals"]
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


class FirstLearnt(unittest.TestCase):
    def test_anchor_is_last_review_else_first_learnt(self):
        self.assertEqual(logic.schedule_anchor("2026-10-05", "2026-09-20"), D("2026-10-05"))
        self.assertEqual(logic.schedule_anchor(None, "2026-09-20"), D("2026-09-20"))
        self.assertIsNone(logic.schedule_anchor(None, None))

    def test_first_review_counts_from_first_learnt(self):
        anchor = logic.schedule_anchor(None, "2026-09-20")
        self.assertEqual(logic.next_review(anchor, 2, IV), D("2026-09-27"))


class LearningPace(unittest.TestCase):
    today = D("2026-10-31")
    target = D("2028-05-17")

    def test_counts_and_recent_pace(self):
        dates = ["2026-09-10", "2026-10-05", "2026-10-20", "2026-10-30", None, None]
        p = logic.learning_pace(dates, self.today, self.target)
        self.assertEqual((p["total"], p["learnt"], p["remaining"]), (6, 4, 2))
        self.assertEqual(p["recent"], 3)            # 2026-10-04 .. 2026-10-31 window
        self.assertEqual(p["per_week"], 0.75)       # 3 chapters in 4 weeks
        self.assertEqual(p["this_week"], 1)         # week starts Mon 2026-10-26
        self.assertEqual(p["days_left"], (self.target - self.today).days)
        self.assertEqual(p["required_per_week"], round(2 * 7 / p["days_left"], 2))
        self.assertEqual(p["verdict"], "ahead")
        self.assertEqual(p["projected_finish"], "2026-11-19")  # 2 chapters at 0.75/week = 19 days

    def test_behind_when_pace_too_slow(self):
        dates = ["2026-10-20"] + [None] * 79
        p = logic.learning_pace(dates, self.today, D("2027-01-31"))
        self.assertEqual(p["verdict"], "behind")
        self.assertGreater(p["required_per_week"], p["per_week"])

    def test_on_track_band(self):
        # need 1/week (4 left over 28 days); learnt 4 in the last 4 weeks -> exactly on pace
        dates = ["2026-10-04", "2026-10-11", "2026-10-18", "2026-10-25"] + [None] * 4
        p = logic.learning_pace(dates, self.today, self.today + timedelta(days=28))
        self.assertEqual((p["per_week"], p["required_per_week"], p["verdict"]), (1.0, 1.0, "on track"))

    def test_edge_verdicts(self):
        self.assertEqual(logic.learning_pace([None, None], self.today, self.target)["verdict"], "not started")
        self.assertEqual(logic.learning_pace(["2026-01-01"], self.today, self.target)["verdict"], "all learnt")
        self.assertEqual(logic.learning_pace(["2026-01-01", None], self.today, None)["verdict"], "no target")
        self.assertEqual(logic.learning_pace(["2026-01-01", None], self.today, D("2026-10-01"))["verdict"],
                         "behind")
        p = logic.learning_pace(["2025-01-01", None], self.today, self.target)
        self.assertIsNone(p["projected_finish"])   # no recent pace to project from

    def test_learn_target_setting_or_first_exam(self):
        s = copy.deepcopy(S)
        self.assertEqual(logic.learn_target(s), D("2028-05-17"))
        s["learn_by"] = "2028-03-31"
        self.assertEqual(logic.learn_target(s), D("2028-03-31"))
        s["learn_by"], s["exams"] = None, []
        self.assertIsNone(logic.learn_target(s))


class Due(unittest.TestCase):
    def test_due_when_next_review_reached(self):
        self.assertEqual(logic.is_due("2026-09-10", 3, True, IV, D("2026-09-23")), (False, D("2026-09-24")))
        self.assertEqual(logic.is_due("2026-09-10", 3, True, IV, D("2026-09-24")), (True, D("2026-09-24")))
        self.assertEqual(logic.is_due("2026-09-10", 3, True, IV, D("2026-10-30")), (True, D("2026-09-24")))

    def test_learnt_but_unrated_is_due(self):
        self.assertEqual(logic.is_due("2026-09-10", None, True, IV, D("2026-09-10")), (True, D("2026-09-10")))

    def test_not_learnt_is_never_due(self):
        self.assertEqual(logic.is_due(None, None, False, IV, D("2026-09-22")), (False, None))
        self.assertEqual(logic.is_due(None, 1, False, IV, D("2027-09-22")), (False, None))


class Priority(unittest.TestCase):
    today = D("2027-01-10")

    def p(self, **kw):
        args = dict(confidence=3, anchor="2027-01-10", learnt=True, marks_lost=0, settings=S, today=self.today)
        args.update(kw)
        return logic.priority(**args)

    def test_score_is_bounded(self):
        worst = self.p(confidence=1, anchor="2026-01-01", marks_lost=1000)
        best = self.p(confidence=5, anchor=None, learnt=False)
        self.assertLessEqual(worst["score"], 100)
        self.assertEqual(worst["score"], round(35 + 25 + 25 * 1000 / 1008 + 15, 1))
        self.assertEqual(best["score"], 0.0)

    def test_lower_confidence_scores_higher(self):
        scores = [self.p(confidence=c)["score"] for c in (1, 2, 3, 4, 5)]
        self.assertEqual(scores, sorted(scores, reverse=True))
        self.assertEqual(self.p(confidence=None)["components"]["confidence"], 1.0)

    def test_overdue_component(self):
        # conf 3 -> 14-day interval. Anchor 2026-12-20 -> due 2027-01-03 -> 7 days late on 01-10.
        self.assertAlmostEqual(self.p(anchor="2026-12-20")["components"]["overdue"], 0.5)
        self.assertEqual(self.p(anchor="2027-01-05")["components"]["overdue"], 0.0)
        self.assertEqual(self.p(anchor="2026-06-01")["components"]["overdue"], 1.0)  # capped

    def test_more_overdue_scores_higher(self):
        self.assertGreater(self.p(anchor="2026-12-15")["score"], self.p(anchor="2026-12-26")["score"])

    def test_learnt_unrated_counts_fully_overdue(self):
        self.assertEqual(self.p(confidence=None)["components"]["overdue"], 1.0)

    def test_not_learnt_is_never_overdue(self):
        r = self.p(learnt=False, anchor=None)
        self.assertEqual((r["components"]["overdue"], r["components"]["learnt"]), (0.0, 0.0))

    def test_marks_lost_saturates(self):
        half = S["marks_half_point"]
        self.assertEqual(self.p(marks_lost=0)["components"]["marks"], 0.0)
        self.assertAlmostEqual(self.p(marks_lost=half)["components"]["marks"], 0.5)
        m = [self.p(marks_lost=x)["score"] for x in (0, 2, 5, 10, 40)]
        self.assertEqual(m, sorted(m))
        self.assertLess(self.p(marks_lost=10_000)["components"]["marks"], 1.0 + 1e-9)

    def test_learnt_component(self):
        self.assertEqual(self.p(learnt=True)["components"]["learnt"], 1.0)
        self.assertGreater(self.p(learnt=True)["score"], self.p(learnt=False)["score"])

    def test_exact_weighted_score(self):
        # conf 2 -> 0.75; 7 days late on a 7-day interval -> overdue 1.0; 8 marks -> 0.5; learnt -> 1
        r = self.p(confidence=2, anchor="2026-12-27", marks_lost=8)
        self.assertEqual(r["components"], {"confidence": 0.75, "overdue": 1.0, "marks": 0.5, "learnt": 1.0})
        expected = 100 * (35 * 0.75 + 25 * 1.0 + 25 * 0.5 + 15 * 1.0) / 100
        self.assertEqual(r["score"], round(expected, 1))

    def test_custom_weights(self):
        s = copy.deepcopy(S)
        s["priority_weights"] = {"confidence": 0, "overdue": 0, "marks": 1, "learnt": 0}
        self.assertEqual(logic.priority(1, None, True, 8, s, self.today)["score"], 50.0)


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
