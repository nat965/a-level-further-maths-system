"""End-to-end test of the website in a real browser.

Runs the site with tools/dev-server.mjs (the real schema.sql in PGlite standing in for Supabase),
pretends today is 2027-01-10, and uses the site the way a student would: create a tracker, learn
and review chapters, log papers and mistakes, export, restore a backup, log out and back in,
use a second device at the same time, and check a friend's tracker is separate.

Needs Node (with `npm install` done) and Python Playwright (`pip install playwright` and
`playwright install chromium`). Run: python3 -m unittest discover -s tests/e2e -v
Set E2E_SCREENSHOTS=<folder> to save screenshots.
"""
import io
import json
import os
import re
import socket
import subprocess
import time
import unittest
import urllib.request
import zipfile
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None

ROOT = Path(__file__).resolve().parents[2]
CODE_RE = re.compile(r"^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def chromium_path():
    for p in (os.environ.get("CHROMIUM_PATH"), "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"):
        if p and os.path.exists(p):
            return p
    return None


@unittest.skipIf(sync_playwright is None, "playwright not installed")
class Website(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = free_port()
        cls.proc = subprocess.Popen(["node", "tools/dev-server.mjs", "--port", str(cls.port), "--today", "2027-01-10"],
                                    cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        cls.url = f"http://127.0.0.1:{cls.port}/"
        for _ in range(100):
            try:
                urllib.request.urlopen(cls.url, timeout=1)
                break
            except OSError:
                time.sleep(0.2)
        else:
            raise RuntimeError("dev server did not start")
        cls.shots = os.environ.get("E2E_SCREENSHOTS")
        cls.pw = sync_playwright().start()
        kw = {"executable_path": chromium_path()} if chromium_path() else {}
        cls.browser = cls.pw.chromium.launch(**kw)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.proc.terminate()
        cls.proc.wait(10)

    def new_page(self, **ctx):
        context = self.browser.new_context(**{"viewport": {"width": 1400, "height": 900}, "accept_downloads": True, **ctx})
        page = context.new_page()
        page.errors = []
        page.on("console", lambda m: page.errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: page.errors.append(str(e)))
        page.on("dialog", lambda d: d.accept())
        self.addCleanup(context.close)
        return page

    def shot(self, page, name):
        if self.shots:
            Path(self.shots).mkdir(parents=True, exist_ok=True)
            page.screenshot(path=f"{self.shots}/{name}.png", full_page=True)

    def create_tracker(self, page):
        page.goto(self.url)
        page.wait_for_selector("#login:not([hidden])")
        page.click("#create-tracker")
        page.wait_for_selector("#login-new:not([hidden])")
        code = page.inner_text("#new-code")
        self.assertRegex(code, CODE_RE)
        return code

    def log_in(self, page, code, remember=False):
        page.goto(self.url)
        page.wait_for_selector("#login:not([hidden])")
        page.fill("#login-code", code)
        if remember:
            page.check("#login-remember")
        page.click("#login-submit")
        page.wait_for_selector(".shell:not([hidden]) #main .page-head")

    def wait_saved(self, page):
        page.wait_for_selector("#save-status[data-state='saved']")

    # ------------------------------------------------------------------ the main journey

    def test_student_journey(self):
        page = self.new_page()

        # --- login screen: bad codes are explained
        page.goto(self.url)
        page.wait_for_selector("#login:not([hidden])")
        self.shot(page, "01-login")
        page.fill("#login-code", "abc")
        page.click("#login-submit")
        self.assertIn("12 letters", page.inner_text("#login-error"))
        page.fill("#login-code", "aaaabbbbcccc")
        self.assertEqual(page.input_value("#login-code"), "AAAA-BBBB-CCCC")  # formats as you type
        page.click("#login-submit")
        page.wait_for_selector("#login-error:has-text('No tracker has that code')")

        # --- start a new tracker
        code = self.create_tracker(page)
        self.shot(page, "02-new-code")
        page.click("#open-new")
        page.wait_for_selector("#learn-section")
        self.assertIn("Nothing due", page.inner_text("#review-section"))
        self.assertEqual(page.locator("#learn-section .due-item").count(), 6)
        self.shot(page, "03-due-empty")

        # --- learnt today from the "next to learn" list
        page.locator("#learn-section .due-item", has_text="Maths Y1 (red) ch 1").locator("button[data-action=learnt]").click()
        page.wait_for_selector(".modal:has-text('Learnt today')")
        page.keyboard.press("3")
        self.assertIn("First review in 14 days", page.inner_text("#next-preview"))
        page.keyboard.press("Enter")
        page.wait_for_selector("#learn-section .due-item:has-text('Maths Y1 (red) ch 2')")
        self.wait_saved(page)

        # --- back-fill chapters learnt before using the site (from the chapter panel)
        page.keyboard.press("2")
        page.wait_for_selector("#ch-table tbody tr")
        self.assertEqual(page.locator("#ch-table tbody tr").count(), 80)
        for title in ("Indices and surds", "Quadratic functions", "Polynomials"):
            page.click(f"#ch-table a[data-action=open]:text-is('{title}')")
            page.wait_for_selector(".drawer:has-text('Not learnt yet')")
            page.fill(".drawer input[data-change=first-learnt]", "2026-12-01")
            page.wait_for_selector(".drawer:has-text('Learnt 1 Dec 2026')")
            page.keyboard.press("Escape")
        # rate one of them inline in the table
        row = page.locator("#ch-table tbody tr", has_text="Indices and surds")
        row.locator("select[data-change=confidence]").select_option("2")
        self.wait_saved(page)
        page.select_option("select[data-filter=status]", "learnt")
        self.assertEqual(page.locator("#ch-table tbody tr").count(), 4)
        page.select_option("select[data-filter=status]", "")
        self.shot(page, "04-chapters")

        # --- due list: the three back-filled chapters (unrated ones need rating), by priority
        page.keyboard.press("1")
        page.wait_for_selector("#review-section .due-item")
        self.assertEqual(page.locator("#review-section .due-item").count(), 3)
        self.assertEqual(page.inner_text("#due-badge"), "3")
        first_id = page.locator("#review-section .due-item").first.get_attribute("data-id")
        page.keyboard.press("r")
        page.wait_for_selector(".modal .conf-picker")
        page.keyboard.press("4")
        page.keyboard.press("Enter")
        page.wait_for_function("document.querySelectorAll('#review-section .due-item').length === 2")
        self.assertEqual(page.locator(f"#review-section .due-item[data-id='{first_id}']").count(), 0)
        self.wait_saved(page)
        self.shot(page, "05-due")

        # --- past papers: attempt, question breakdown, boundaries, chart
        page.keyboard.press("4")
        page.wait_for_selector("#paper-form")
        page.select_option("#paper-form [name=paper_code]", "Y540")
        self.assertEqual(page.input_value("#paper-form [name=max_mark]"), "75")
        page.fill("#paper-form [name=series]", "June 2019")
        page.fill("#paper-form [name=sat_on]", "2027-01-09")
        page.fill("#paper-form [name=mark]", "61")
        page.fill("#paper-form [name=time_taken_min]", "85")
        page.click("#paper-form button[type=submit]")
        page.wait_for_selector("form.q-form")
        page.fill("form.q-form [name=q_num]", "8(b)")
        page.select_option("form.q-form [name=chapter_id]", label="Further Pure Core 1 (blue) 4: Complex numbers")
        page.fill("form.q-form [name=marks_lost]", "5")
        page.select_option("form.q-form [name=error_type]", "method")
        page.click("form.q-form button[type=submit]")
        page.wait_for_selector(".sub-table td:has-text('8(b)')")
        page.select_option("#bound-form [name=paper_code]", "Y540")
        page.fill("#bound-form [name=series]", "June 2019")
        page.fill("#bound-form [name=a_star]", "58")
        page.fill("#bound-form [name=a]", "50")
        page.click("#bound-form button[type=submit]")
        page.wait_for_selector(".pill:has-text('A*')")
        self.assertEqual(page.locator(".chart svg .dot").count(), 1)
        page.hover(".chart svg .hit")
        self.assertIn("81.3%", page.inner_text("#tooltip"))
        self.wait_saved(page)
        self.shot(page, "06-papers")

        # --- mistakes
        page.keyboard.press("5")
        page.wait_for_selector("#mistake-form")
        self.assertEqual(page.input_value("#mistake-form [name=retest_on]"), "2027-01-17")
        page.select_option("#mistake-form [name=chapter_id]", label="Maths Y1 (red) 3: Quadratic functions")
        page.fill("#mistake-form [name=what_wrong]", "Dropped the negative root")
        page.fill("#mistake-form [name=correct_method]", "Write ± before square-rooting")
        page.click("#mistake-form button[type=submit]")
        page.wait_for_selector("td:has-text('Dropped the negative root')")
        self.wait_saved(page)

        # --- dashboard
        page.keyboard.press("3")
        page.wait_for_selector("text=Top 10 weakest chapters")
        body = page.inner_text("main")
        self.assertIn("Learning pace", body)
        self.assertIn("Complex numbers", page.inner_text(".card:has-text('Top 10 weakest')"))
        self.assertRegex(page.inner_text(".card:has-text('Learnt so far')"), r"4\s*/\s*80")
        self.shot(page, "07-dashboard")

        # --- settings: the code, exports
        page.keyboard.press("6")
        page.wait_for_selector("#my-code")
        self.assertEqual(page.inner_text("#my-code"), code)
        with page.expect_download() as dl:
            page.click("button[data-action=export-json]")
        exported = json.loads(Path(dl.value.path()).read_text())
        self.assertEqual(exported["format"], "revision-tracker")
        self.assertEqual(len(exported["reviews"]), 1)
        self.assertEqual(len(exported["mistakes"]), 1)
        with page.expect_download() as dl:
            page.click("button[data-action=export-csv]")
        z = zipfile.ZipFile(io.BytesIO(Path(dl.value.path()).read_bytes()))
        self.assertIsNone(z.testzip())
        self.assertIn("chapters.csv", z.namelist())
        page.wait_for_selector("#backup-list table")
        self.assertEqual(page.locator("#backup-list tbody tr").count(), 1)  # start-of-day copy
        page.keyboard.press("t")
        page.wait_for_function("document.documentElement.dataset.theme === 'dark'")
        self.wait_saved(page)
        self.shot(page, "08-settings-dark")

        # --- log out, then back in with the code typed casually
        page.click("button[data-action=logout]")
        page.wait_for_selector("#login:not([hidden])")
        self.log_in(page, code.lower().replace("-", " "))
        self.assertEqual(page.evaluate("document.documentElement.dataset.theme"), "dark")  # settings sync
        page.keyboard.press("2")
        page.wait_for_selector("#ch-table tbody tr")
        cx = page.locator("#ch-table tbody tr", has_text="Complex numbers").first
        self.assertIn("5", cx.locator("td").nth(13).inner_text())  # marks lost column
        self.assertEqual(page.errors, [], page.errors)

        # --- restore the start-of-day backup: back to a fresh tracker
        page.keyboard.press("6")
        page.wait_for_selector("#backup-list table")
        page.click("#backup-list button[data-action=restore]")
        page.wait_for_selector(".toast:has-text('Backup restored')")
        page.keyboard.press("1")
        page.wait_for_selector("#learn-section")
        self.assertIn("Maths Y1 (red) ch 1", page.inner_text("#learn-section"))
        self.assertEqual(page.errors, [], page.errors)

    # ------------------------------------------------------------------ two devices, and a friend

    def test_two_devices_and_a_friend(self):
        laptop = self.new_page()
        code = self.create_tracker(laptop)
        laptop.click("#open-new")
        laptop.wait_for_selector("#learn-section")

        phone = self.new_page(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        self.log_in(phone, code, remember=True)
        self.assertTrue(phone.is_visible("nav.sidebar a[data-nav=chapters]"))  # menu works on a phone
        self.shot(phone, "09-phone")

        # both devices change something at the same time
        phone.locator("#learn-section .due-item", has_text="Further Stats ch 1").locator("button[data-action=learnt]").click()
        phone.wait_for_selector(".modal .conf-picker")
        phone.click(".conf-picker button[data-conf='2']")
        phone.click("#review-save")
        laptop.locator("#learn-section .due-item", has_text="Further Mechanics ch 1").locator("button[data-action=learnt]").click()
        laptop.wait_for_selector(".modal .conf-picker")
        laptop.click(".conf-picker button[data-conf='5']")
        laptop.click("#review-save")
        self.wait_saved(phone)
        self.wait_saved(laptop)

        # coming back to a tab picks up the other device's changes
        for page in (phone, laptop):
            page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        for page in (phone, laptop):
            page.wait_for_selector("#learn-section .due-item:has-text('Further Stats ch 2')")
            page.wait_for_selector("#learn-section .due-item:has-text('Further Mechanics ch 2')")

        # "keep me logged in" survives closing the browser tab on the phone
        phone.goto(self.url)
        phone.wait_for_selector(".shell:not([hidden]) #learn-section")

        # a friend's tracker is completely separate
        friend = self.new_page()
        friend_code = self.create_tracker(friend)
        self.assertNotEqual(friend_code, code)
        friend.click("#open-new")
        friend.wait_for_selector("#learn-section")
        friend.keyboard.press("2")
        friend.wait_for_selector("#ch-table tbody tr")
        friend.select_option("select[data-filter=status]", "learnt")
        self.assertEqual(friend.locator("#ch-table tbody tr").count(), 1)  # just the "no chapters" row
        self.assertIn("No chapters match", friend.inner_text("#ch-table tbody"))
        for p in (laptop, phone, friend):
            self.assertEqual(p.errors, [], p.errors)

    def test_import_desktop_app_export(self):
        page = self.new_page()
        self.create_tracker(page)
        page.click("#open-new")
        page.wait_for_selector("#learn-section")
        seed = json.loads((ROOT / "web" / "seed_chapters.json").read_text())
        export = {
            "format": "revision-tracker", "version": 1, "exported_at": "2026-11-20T10:00:00",
            "tables": {
                "chapters": [{"id": i + 1, **c, "terms": "[]", "summary_status": "done" if i == 0 else "not_started",
                              "exercises_status": "not_started", "examq_status": "not_started",
                              "confidence": 2 if i == 1 else None, "notes": "", "sort_order": i + 1}
                             for i, c in enumerate(seed)],
                "reviews": [{"id": 1, "chapter_id": 2, "reviewed_on": "2026-11-11", "confidence_before": None,
                             "confidence_after": 2, "note": "from the desktop app", "created_at": "x"}],
                "papers": [], "paper_questions": [], "boundaries": [], "mistakes": [],
                "settings": [{"key": "priority_weights",
                              "value": json.dumps({"confidence": 40, "overdue": 20, "marks": 30, "taught": 10})}],
            },
        }
        path = Path(self.id().replace(".", "_") + ".json")
        tmp = ROOT / "tests" / "e2e" / path
        tmp.write_text(json.dumps(export))
        self.addCleanup(tmp.unlink)
        page.keyboard.press("6")
        page.wait_for_selector("#import-json")
        page.set_input_files("#import-json", str(tmp))
        page.wait_for_selector(".toast:has-text('Import complete')")
        self.wait_saved(page)
        page.click("a[data-nav=due]")
        page.click("a[data-nav=settings]")
        page.wait_for_selector("#backup-list td:has-text('Before an import')")
        page.keyboard.press("1")
        page.wait_for_selector("#review-section .due-item")
        # chapter 2 was reviewed on 11 Nov at confidence 2 -> due 18 Nov -> overdue on 10 Jan
        self.assertIn("Indices and surds", page.inner_text("#review-section"))
        self.assertEqual(page.errors, [], page.errors)


if __name__ == "__main__":
    unittest.main()
