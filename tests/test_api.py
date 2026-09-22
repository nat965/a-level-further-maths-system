"""Integration tests: run the real HTTP server on a temp data folder with a fixed 'today'."""
import csv
import io
import json
import os
import shutil
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile
from datetime import date

from revision_tracker import service
from revision_tracker.db import Store
from revision_tracker.server import App


class ApiTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="rt-test-")
        self.set_today("2027-01-10")
        self.store = Store(self.tmp)
        self.app = App(self.store, 0, log_fn=lambda *_: None, auto_exit=False)
        self.thread = threading.Thread(target=self.app.serve, daemon=True)
        self.thread.start()
        self.base = self.app.url.rstrip("/")

    def tearDown(self):
        self.app.httpd.shutdown()
        self.thread.join(5)
        os.environ.pop("REVISION_TRACKER_TODAY", None)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def set_today(self, iso):
        os.environ["REVISION_TRACKER_TODAY"] = iso

    def call(self, method, path, body=None, raw=False, headers=None, expect=200):
        data = None
        hdrs = dict(headers or {})
        if body is not None:
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            hdrs.setdefault("Content-Type", "application/json")
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(req) as r:
                status, payload = r.status, r.read()
        except urllib.error.HTTPError as e:
            status, payload = e.code, e.read()
        self.assertEqual(status, expect, payload[:300])
        return payload if raw else json.loads(payload)

    def chapter(self, cid):
        return next(c for c in self.call("GET", "/api/chapters") if c["id"] == cid)


class SeedAndChapters(ApiTestCase):
    def test_seeded_with_80_chapters(self):
        cs = self.call("GET", "/api/chapters")
        self.assertEqual(len(cs), 80)
        by_strand = {}
        for c in cs:
            by_strand[c["strand"]] = by_strand.get(c["strand"], 0) + 1
        self.assertEqual(by_strand, {"Pure": 30, "Pure Core": 17, "Statistics": 6, "Further Stats": 9,
                                     "Mechanics": 8, "Further Mechanics": 10})
        first = cs[0]
        self.assertEqual((first["book"], first["ch_num"], first["title"], first["level"], first["terms"]),
                         ("Maths Y1 (red)", 1, "Proof and mathematical communication", "AS", ["Autumn Y12"]))
        two_term = next(c for c in cs if c["title"] == "Functions")
        self.assertEqual(two_term["terms"], ["Autumn Y12", "Spring Y12"])

    def test_update_statuses_confidence_notes(self):
        c = self.call("PATCH", "/api/chapters/3", {"summary_status": "done", "exercises_status": "in_progress",
                                                   "confidence": 2, "notes": "revise discriminant"})
        self.assertEqual((c["summary_status"], c["exercises_status"], c["confidence"], c["notes"]),
                         ("done", "in_progress", 2, "revise discriminant"))
        self.call("PATCH", "/api/chapters/3", {"summary_status": "finished"}, expect=400)
        self.call("PATCH", "/api/chapters/3", {"confidence": 6}, expect=400)
        self.call("PATCH", "/api/chapters/999", {"confidence": 3}, expect=404)

    def test_review_stamps_today_and_schedules_next(self):
        c = self.call("POST", "/api/chapters/5/review", {"confidence": 2, "note": "Ex 5A"})
        self.assertEqual(c["last_reviewed"], "2027-01-10")
        self.assertEqual(c["confidence"], 2)
        self.assertEqual(c["next_review"], "2027-01-17")  # confidence 2 -> 7 days
        self.assertEqual(c["days_since"], 0)
        self.assertFalse(c["due"])
        hist = self.call("GET", "/api/chapters/5/history")
        self.assertEqual(len(hist["reviews"]), 1)
        self.assertEqual(hist["reviews"][0]["confidence_before"], None)
        self.assertEqual(hist["reviews"][0]["note"], "Ex 5A")
        self.call("POST", "/api/chapters/5/review", {"confidence": 0}, expect=400)

    def test_days_since_recalculated_on_later_day(self):
        self.call("POST", "/api/chapters/5/review", {"confidence": 4})
        self.set_today("2027-01-31")
        c = self.chapter(5)
        self.assertEqual(c["days_since"], 21)
        self.assertEqual(c["days_until_review"], 9)  # 30-day interval
        self.set_today("2027-02-15")
        c = self.chapter(5)
        self.assertTrue(c["due"])
        self.assertEqual(c["days_until_review"], -6)

    def test_undo_latest_review_restores_confidence(self):
        self.call("PATCH", "/api/chapters/7", {"confidence": 3})
        self.call("POST", "/api/chapters/7/review", {"confidence": 5})
        rid = self.call("GET", "/api/chapters/7/history")["reviews"][0]["id"]
        c = self.call("DELETE", f"/api/reviews/{rid}")
        self.assertEqual((c["confidence"], c["last_reviewed"]), (3, None))


class DueList(ApiTestCase):
    def test_due_sorted_by_priority(self):
        # Autumn Y12 ended 2026-12-18, so on 2027-01-10 its chapters are taught.
        self.set_today("2026-12-01")
        self.call("POST", "/api/chapters/1/review", {"confidence": 4})   # due 2026-12-31
        self.call("POST", "/api/chapters/2/review", {"confidence": 1})   # due 2026-12-04
        self.call("POST", "/api/chapters/3/review", {"confidence": 5})   # due 2027-01-30: not due
        self.set_today("2027-01-10")
        due = self.call("GET", "/api/due")
        ids = [c["id"] for c in due["chapters"]]
        self.assertIn(1, ids)
        self.assertIn(2, ids)
        self.assertNotIn(3, ids)
        self.assertLess(ids.index(2), ids.index(1))  # lower confidence & more overdue first
        prios = [c["priority"] for c in due["chapters"]]
        self.assertEqual(prios, sorted(prios, reverse=True))
        # taught-but-never-reviewed Autumn chapters are due too
        self.assertIn(4, ids)
        # Spring Y12 chapters (being taught now) aren't due without a review
        spring = [c for c in due["chapters"] if c["terms"] == ["Spring Y12"]]
        self.assertEqual(spring, [])

    def test_suggestions_when_nothing_due(self):
        self.set_today("2026-09-22")
        due = self.call("GET", "/api/due")
        self.assertEqual(due["chapters"], [])
        self.assertEqual(len(due["suggested"]), 5)
        self.assertTrue(all(c["taught"] == "in_progress" for c in due["suggested"]))

    def test_marks_lost_feed_priority(self):
        before = self.chapter(10)["priority"]
        p = self.call("POST", "/api/papers", {"paper_code": "H240/01", "series": "June 2019",
                                             "sat_on": "2027-01-09", "mark": 71, "max_mark": 100})
        self.call("POST", f"/api/papers/{p['id']}/questions",
                  {"q_num": "7b", "chapter_id": 10, "marks_lost": 5, "error_type": "method", "fix": "R-alpha"})
        self.call("POST", f"/api/papers/{p['id']}/questions",
                  {"q_num": "9", "chapter_id": 10, "marks_lost": 3, "error_type": "algebra slip"})
        c = self.chapter(10)
        self.assertEqual(c["marks_lost"], 8)
        self.assertEqual(c["top_error"], "method")
        self.assertEqual(c["priority_parts"]["marks"], 0.5)
        self.assertGreater(c["priority"], before)

    def test_mistake_retest_feeds_due_list(self):
        m = self.call("POST", "/api/mistakes", {"chapter_id": 4, "source": "Ex 4B", "what_wrong": "sign error",
                                                "correct_method": "check f(-a)"})
        self.assertEqual(m["logged_on"], "2027-01-10")
        self.assertEqual(m["retest_on"], "2027-01-17")  # default 7 days
        self.assertEqual(self.call("GET", "/api/due")["retests"], [])
        self.set_today("2027-01-18")
        retests = self.call("GET", "/api/due")["retests"]
        self.assertEqual([r["id"] for r in retests], [m["id"]])
        self.assertEqual(retests[0]["days_overdue"], 1)
        again = self.call("POST", f"/api/mistakes/{m['id']}/retest", {"passed": False})
        self.assertEqual(again["retest_on"], "2027-01-25")
        done = self.call("POST", f"/api/mistakes/{m['id']}/retest", {"passed": True})
        self.assertEqual((done["retest_passed"], done["passed_on"]), (1, "2027-01-18"))
        self.set_today("2027-02-01")
        self.assertEqual(self.call("GET", "/api/due")["retests"], [])


class Papers(ApiTestCase):
    def test_grade_from_boundaries_and_chart(self):
        p = self.call("POST", "/api/papers", {"paper_code": "Y540", "series": "June 2019", "sat_on": "2027-01-05",
                                             "mark": 60, "max_mark": 75, "time_taken_min": 88})
        self.assertEqual((p["percent"], p["grade"]), (80.0, None))
        self.call("PUT", "/api/boundaries", {"paper_code": "Y540", "series": "June 2019", "a_star": 58, "a": 49,
                                             "b": 41, "c": 33, "d": 25, "e": 18})
        p = next(x for x in self.call("GET", "/api/papers") if x["id"] == p["id"])
        self.assertEqual(p["grade"], "A*")
        # upsert replaces
        self.call("PUT", "/api/boundaries", {"paper_code": "Y540", "series": "June 2019", "a_star": 62, "a": 50})
        self.assertEqual(len(self.call("GET", "/api/boundaries")), 1)
        p = next(x for x in self.call("GET", "/api/papers") if x["id"] == p["id"])
        self.assertEqual(p["grade"], "A")
        chart = {s["code"]: s for s in self.call("GET", "/api/papers/chart")}
        self.assertEqual(len(chart), 7)
        self.assertEqual(chart["Y540"]["points"][0]["percent"], 80.0)
        self.assertEqual(chart["Y540"]["a_star_percent"], round(62 / 75 * 100, 1))
        self.assertIsNone(chart["H240/02"]["a_star_percent"])

    def test_validation(self):
        self.call("POST", "/api/papers", {"paper_code": "X999", "series": "J", "sat_on": "2027-01-01", "mark": 1,
                                          "max_mark": 10}, expect=400)
        self.call("POST", "/api/papers", {"paper_code": "Y541", "series": "June 2019", "sat_on": "2027-01-01",
                                          "mark": 80, "max_mark": 75}, expect=400)
        self.call("PUT", "/api/boundaries", {"paper_code": "Y541", "series": "June 2019", "a_star": 40, "a": 50},
                  expect=400)
        p = self.call("POST", "/api/papers", {"paper_code": "H240/03", "series": "June 2022",
                                             "sat_on": "2027-01-01", "mark": 50, "max_mark": None})
        self.assertEqual(p["max_mark"], 100)  # default from settings
        self.call("POST", f"/api/papers/{p['id']}/questions", {"q_num": "1", "chapter_id": 3, "marks_lost": 2,
                                                               "error_type": "guesswork"}, expect=400)

    def test_delete_paper_cascades_questions(self):
        p = self.call("POST", "/api/papers", {"paper_code": "H240/02", "series": "June 2023",
                                             "sat_on": "2027-01-02", "mark": 70, "max_mark": 100})
        self.call("POST", f"/api/papers/{p['id']}/questions", {"q_num": "3", "chapter_id": 50, "marks_lost": 4,
                                                               "error_type": "misread"})
        self.assertEqual(self.chapter(50)["marks_lost"], 4)
        self.call("DELETE", f"/api/papers/{p['id']}")
        self.assertEqual(self.chapter(50)["marks_lost"], 0)


class DashboardAndSettings(ApiTestCase):
    def test_dashboard(self):
        self.set_today("2027-01-04")  # Monday
        self.call("POST", "/api/chapters/1/review", {"confidence": 1})
        self.set_today("2027-01-05")
        self.call("POST", "/api/chapters/2/review", {"confidence": 2})
        self.call("PATCH", "/api/chapters/2", {"exercises_status": "done"})
        d = self.call("GET", "/api/dashboard")
        self.assertEqual(d["streak"], 2)
        self.assertEqual(d["reviews_this_week"], 2)
        self.assertEqual(len(d["by_strand"]), 6)
        self.assertEqual(sum(s["chapters"] for s in d["by_strand"]), 80)
        self.assertEqual(d["by_term"][0]["name"], "Autumn Y12")
        self.assertEqual(d["by_term"][0]["chapters"], 30)
        self.assertEqual(d["schedule"]["covered"], 1)
        self.assertEqual(d["schedule"]["verdict"], "behind")
        self.assertEqual(d["weakest"][0]["id"], 1)
        self.assertLessEqual(len(d["weakest"]), 10)
        self.assertEqual(len(d["countdown"]), 7)

    def test_settings_intervals_change_schedule(self):
        self.call("POST", "/api/chapters/5/review", {"confidence": 3})
        self.assertEqual(self.chapter(5)["next_review"], "2027-01-24")
        self.call("PUT", "/api/settings", {"intervals": {"1": 2, "2": 5, "3": 10, "4": 20, "5": 45}})
        self.assertEqual(self.chapter(5)["next_review"], "2027-01-20")
        self.call("PUT", "/api/settings", {"intervals": {"1": 0, "2": 5, "3": 10, "4": 20, "5": 45}}, expect=400)
        self.call("PUT", "/api/settings", {"bogus": 1}, expect=400)
        s = self.call("POST", "/api/settings/reset", {"keys": ["intervals"]})
        self.assertEqual(s["intervals"]["3"], 14)

    def test_exam_dates_editable(self):
        self.call("PUT", "/api/settings", {"exams": [{"name": "H240/01", "date": "2028-06-02", "confirmed": True}]})
        d = self.call("GET", "/api/dashboard")
        self.assertEqual([(e["name"], e["days"]) for e in d["countdown"]], [("H240/01", 509)])

    def test_cross_origin_writes_refused(self):
        self.call("PATCH", "/api/chapters/1", {"confidence": 2}, headers={"Origin": "https://evil.example"},
                  expect=403)
        self.call("PATCH", "/api/chapters/1", {"confidence": 2}, headers={"Origin": self.base})


class BackupExportImport(ApiTestCase):
    def test_daily_backup_made_once_per_day(self):
        self.call("GET", "/api/chapters")
        names = [b["name"] for b in self.call("GET", "/api/backups")["backups"]]
        self.assertIn("tracker-daily-2027-01-10.sqlite3", names)
        self.set_today("2027-01-11")
        self.call("GET", "/api/chapters")
        self.call("GET", "/api/chapters")
        names = [b["name"] for b in self.call("GET", "/api/backups")["backups"]]
        self.assertEqual(sum(n.startswith("tracker-daily-") for n in names), 2)

    def test_json_round_trip(self):
        self.call("POST", "/api/chapters/2/review", {"confidence": 3, "note": "x"})
        p = self.call("POST", "/api/papers", {"paper_code": "H240/01", "series": "June 2018",
                                             "sat_on": "2027-01-08", "mark": 81, "max_mark": 100})
        self.call("POST", f"/api/papers/{p['id']}/questions", {"q_num": "2", "chapter_id": 2, "marks_lost": 3,
                                                               "error_type": "time"})
        self.call("POST", "/api/mistakes", {"chapter_id": 2, "what_wrong": "w"})
        self.call("PUT", "/api/settings", {"mistake_retest_days": 5})
        exported = self.call("GET", "/api/export/json")
        self.assertEqual(exported["format"], "revision-tracker")
        # wreck the data, then restore from the export
        self.call("PATCH", "/api/chapters/2", {"notes": "changed"})
        self.call("DELETE", f"/api/papers/{p['id']}")
        self.call("POST", "/api/import/json", exported)
        c = self.chapter(2)
        self.assertEqual((c["notes"], c["marks_lost"], c["review_count"], c["confidence"]), ("", 3, 1, 3))
        self.assertEqual(self.call("GET", "/api/settings")["mistake_retest_days"], 5)
        self.assertEqual(len(self.call("GET", "/api/mistakes")), 1)
        names = [b["name"] for b in self.call("GET", "/api/backups")["backups"]]
        self.assertTrue(any(n.startswith("tracker-pre-import-") for n in names))

    def test_bad_import_rejected_and_data_untouched(self):
        self.call("POST", "/api/import/json", {"format": "something-else"}, expect=400)
        bad = self.call("GET", "/api/export/json")
        bad["tables"]["reviews"] = [{"id": 1, "chapter_id": 9999, "reviewed_on": "2027-01-01",
                                     "confidence_after": 3, "note": "", "created_at": "x"}]
        self.call("POST", "/api/import/json", bad, expect=400)
        self.assertEqual(len(self.call("GET", "/api/chapters")), 80)

    def test_csv_export_and_import(self):
        self.call("PATCH", "/api/chapters/1", {"summary_status": "done", "confidence": 4})
        z = zipfile.ZipFile(io.BytesIO(self.call("GET", "/api/export/csv", raw=True)))
        self.assertEqual(sorted(z.namelist()), sorted(f"{t}.csv" for t in
                                                      ("chapters", "reviews", "papers", "paper_questions",
                                                       "boundaries", "mistakes", "settings")))
        text = z.read("chapters.csv").decode()
        rows = list(csv.DictReader(io.StringIO(text)))
        self.assertEqual(len(rows), 80)
        rows[1]["notes"] = "edited in a spreadsheet"
        out = io.StringIO()
        w = csv.DictWriter(out, fieldnames=rows[0].keys())
        w.writeheader()
        w.writerows(rows)
        r = self.call("POST", "/api/import/csv/chapters", out.getvalue().encode(), headers={"Content-Type": "text/csv"})
        self.assertEqual(r["rows"], 80)
        self.assertEqual(self.chapter(2)["notes"], "edited in a spreadsheet")
        c1 = self.chapter(1)
        self.assertEqual((c1["summary_status"], c1["confidence"]), ("done", 4))
        self.call("POST", "/api/import/csv/nope", b"a,b\n1,2\n", headers={"Content-Type": "text/csv"}, expect=400)

    def test_restore_backup(self):
        self.call("PATCH", "/api/chapters/1", {"notes": "before"})
        name = self.call("POST", "/api/backups")["name"]
        self.call("PATCH", "/api/chapters/1", {"notes": "after"})
        self.call("POST", "/api/backups/restore", {"name": name})
        self.assertEqual(self.chapter(1)["notes"], "before")
        self.call("POST", "/api/backups/restore", {"name": "../../etc/passwd"}, expect=400)

    def test_data_survives_restart(self):
        self.call("POST", "/api/chapters/9/review", {"confidence": 2})
        self.app.httpd.shutdown()
        self.thread.join(5)
        store2 = Store(self.tmp)  # a fresh process would do exactly this
        reviewed = [c["id"] for c in service.list_chapters(store2, date(2027, 1, 10)) if c["review_count"]]
        self.assertEqual(reviewed, [9])
        # restart the server for tearDown
        self.app = App(store2, 0, log_fn=lambda *_: None, auto_exit=False)
        self.thread = threading.Thread(target=self.app.serve, daemon=True)
        self.thread.start()

    def test_static_files_served(self):
        html = self.call("GET", "/", raw=True).decode()
        self.assertIn("Revision Tracker", html)
        self.assertIn("app.js", html)
        self.assertEqual(self.call("GET", "/../revision_tracker/db.py", raw=True).decode(), html)  # no escape


class AutoExit(unittest.TestCase):
    """The server quits by itself once its window has gone, so nothing is left running."""

    def make_app(self, **timing):
        tmp = tempfile.mkdtemp(prefix="rt-exit-")
        self.addCleanup(shutil.rmtree, tmp, True)
        app = App(Store(tmp), 0, log_fn=lambda *_: None, auto_exit=True)
        app.WATCH_INTERVAL = 0.05
        for k, v in timing.items():
            setattr(app, k, v)
        t = threading.Thread(target=app.serve, daemon=True)
        t.start()
        return app, t

    def post(self, app, path):
        req = urllib.request.Request(app.url + path.lstrip("/"), data=b"", method="POST")
        urllib.request.urlopen(req).read()

    def test_quits_after_window_closes(self):
        app, t = self.make_app(CLOSE_GRACE=0.3, IDLE_TIMEOUT=60)
        self.post(app, "/api/heartbeat")
        self.post(app, "/api/bye")
        t.join(5)
        self.assertFalse(t.is_alive())

    def test_reload_within_grace_keeps_running(self):
        app, t = self.make_app(CLOSE_GRACE=0.6, IDLE_TIMEOUT=60)
        self.post(app, "/api/bye")
        self.post(app, "/api/heartbeat")  # the reloaded page checks in again
        t.join(1.0)
        self.assertTrue(t.is_alive())
        app.shutdown_soon(0)
        t.join(5)

    def test_quits_when_heartbeats_stop(self):
        app, t = self.make_app(IDLE_TIMEOUT=0.3)
        self.post(app, "/api/heartbeat")
        t.join(5)
        self.assertFalse(t.is_alive())


if __name__ == "__main__":
    unittest.main()
