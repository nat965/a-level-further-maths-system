"""End-to-end test: launch the app exactly as the launchers do, then drive it in a real
browser. Skipped automatically if Playwright isn't installed (it's a dev-only extra:
`pip install playwright` then `playwright install chromium`).

Set E2E_SCREENSHOTS=/some/folder to save a screenshot of every page.
"""
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None


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
class EndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="rt-e2e-")
        cls.port = free_port()
        env = dict(os.environ, REVISION_TRACKER_DATA=cls.tmp, REVISION_TRACKER_TODAY="2027-01-10")
        cls.proc = subprocess.Popen([sys.executable, "-m", "revision_tracker", "--no-browser",
                                     "--port", str(cls.port)], cwd=ROOT, env=env)
        cls.url = f"http://127.0.0.1:{cls.port}/"
        for _ in range(50):
            try:
                urllib.request.urlopen(cls.url + "api/health", timeout=1)
                break
            except OSError:
                time.sleep(0.2)
        else:
            raise RuntimeError("app did not start")
        cls.shots = os.environ.get("E2E_SCREENSHOTS")

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(10)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def shot(self, page, name):
        if self.shots:
            Path(self.shots).mkdir(parents=True, exist_ok=True)
            page.screenshot(path=f"{self.shots}/{name}.png", full_page=True)

    def test_second_launch_reuses_running_instance(self):
        env = dict(os.environ, REVISION_TRACKER_DATA=self.tmp)
        r = subprocess.run([sys.executable, "-m", "revision_tracker", "--no-browser", "--port", str(self.port)],
                           cwd=ROOT, env=env, timeout=20)
        self.assertEqual(r.returncode, 0)
        log = (Path(self.tmp) / "app.log").read_text()
        self.assertIn("Already running", log)

    def test_full_workflow(self):
        with sync_playwright() as pw:
            kw = {"executable_path": chromium_path()} if chromium_path() else {}
            browser = pw.chromium.launch(**kw)
            page = browser.new_page(viewport={"width": 1400, "height": 900})
            errors = []
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("dialog", lambda d: d.accept())

            # --- Home: Due today (Autumn Y12 has ended by 2027-01-10, nothing reviewed yet)
            page.goto(self.url)
            page.wait_for_selector(".due-item")
            self.assertIn("#/due", page.url)
            n_due = page.locator(".due-list .due-item").count()
            self.assertEqual(n_due, 28)  # 30 Autumn Y12 chapters minus 2 that run on into Spring
            self.assertEqual(page.locator("#due-badge").inner_text(), str(n_due))
            first_title = page.locator(".due-item .t").first.inner_text()
            first_id = page.locator(".due-item").first.get_attribute("data-id")
            self.shot(page, "01-due")

            # --- Keyboard: r opens review dialog for selected item, 2 then Enter logs it
            page.keyboard.press("r")
            page.wait_for_selector(".modal .conf-picker")
            self.assertIn(first_title, page.locator(".modal h2").inner_text())
            page.keyboard.press("2")
            self.assertIn("7 days", page.locator("#next-preview").inner_text())
            self.shot(page, "02-review-modal")
            page.keyboard.press("Enter")
            page.wait_for_selector(".toast")
            page.wait_for_function(f"document.querySelectorAll('.due-list .due-item').length === {n_due - 1}")
            self.assertEqual(page.locator(f".due-item[data-id='{first_id}']").count(), 0)

            # --- Chapters: search, filter, sort, inline status, drawer timeline
            page.keyboard.press("2")
            page.wait_for_selector("#ch-table tbody tr")
            self.assertEqual(page.locator("#ch-table tbody tr").count(), 80)
            page.keyboard.press("/")
            page.keyboard.type("polar")
            page.wait_for_function("document.querySelectorAll('#ch-table tbody tr').length === 1")
            page.fill("#ch-search", "")
            page.select_option("select[data-filter=strand]", "Further Mechanics")
            self.assertEqual(page.locator("#ch-table tbody tr").count(), 10)
            page.select_option("select[data-filter=strand]", "")
            page.select_option("select[data-filter=term]", "Spring Y13")
            self.assertEqual(page.locator("#ch-table tbody tr").count(), 6)
            page.select_option("select[data-filter=term]", "")
            page.select_option("select[data-filter=status]", "never")
            self.assertEqual(page.locator("#ch-table tbody tr").count(), 79)
            page.select_option("select[data-filter=status]", "")
            page.click("th[data-sort=priority]")
            prios = [float(t) for t in page.locator("#ch-table tbody .prio").all_inner_texts()]
            self.assertEqual(prios, sorted(prios, reverse=True))
            row = page.locator("#ch-table tbody tr", has_text="Indices and surds")
            row.locator("select[data-field=exercises_status]").select_option("done")
            page.wait_for_timeout(300)
            row = page.locator("#ch-table tbody tr", has_text="Indices and surds")
            self.assertEqual(row.locator("select[data-field=exercises_status]").input_value(), "done")
            self.shot(page, "03-chapters")
            page.click(f"#ch-table a[data-action=open][data-id='{first_id}']")
            page.wait_for_selector(".drawer .timeline li")
            self.assertIn("Reviewed", page.locator(".drawer .timeline").inner_text())
            page.fill(".drawer textarea[data-change=notes]", "Remember the proof by exhaustion template")
            page.locator(".drawer h1").click()  # blur -> autosave
            page.wait_for_selector(".toast:has-text('Notes saved')")
            self.shot(page, "04-drawer")
            page.keyboard.press("Escape")
            self.assertEqual(page.locator(".drawer").count(), 0)

            # --- Past papers: log an attempt and a question breakdown, then boundaries
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
            page.fill("form.q-form [name=fix]", "Draw the Argand diagram first")
            page.click("form.q-form button[type=submit]")
            page.wait_for_selector(".sub-table td:has-text('8(b)')")
            page.select_option("#bound-form [name=paper_code]", "Y540")
            page.fill("#bound-form [name=series]", "June 2019")
            page.fill("#bound-form [name=a_star]", "58")
            page.fill("#bound-form [name=a]", "50")
            page.click("#bound-form button[type=submit]")
            page.wait_for_selector(".pill:has-text('A*')")
            self.assertEqual(page.locator(".chart svg .dot").count(), 1)
            self.assertEqual(page.locator(".chart svg .ref").count(), 1)
            page.hover(".chart svg .hit")
            self.assertIn("81.3%", page.locator("#tooltip").inner_text())
            self.shot(page, "05-papers")

            # marks lost now feed that chapter's priority
            page.keyboard.press("2")
            page.wait_for_selector("#ch-table tbody tr")
            cx = page.locator("#ch-table tbody tr", has_text="Complex numbers").first
            self.assertIn("5", cx.locator("td").nth(13).inner_text())

            # --- Mistakes: auto-dated, retest date defaults to +7 days
            page.keyboard.press("5")
            page.wait_for_selector("#mistake-form")
            self.assertEqual(page.input_value("#mistake-form [name=retest_on]"), "2027-01-17")
            page.click("#mistake-form button[data-retest-days='3']")
            self.assertEqual(page.input_value("#mistake-form [name=retest_on]"), "2027-01-13")
            page.select_option("#mistake-form [name=chapter_id]", label="Maths Y1 (red) 3: Quadratic functions")
            page.fill("#mistake-form [name=source]", "Ex 3E Q7")
            page.fill("#mistake-form [name=what_wrong]", "Dropped the negative root")
            page.fill("#mistake-form [name=correct_method]", "Write ± before square-rooting")
            page.click("#mistake-form button[type=submit]")
            page.wait_for_selector("td:has-text('Dropped the negative root')")
            self.assertIn("10 Jan 2027", page.locator("tbody tr").first.inner_text())
            self.shot(page, "06-mistakes")

            # --- Dashboard
            page.keyboard.press("3")
            page.wait_for_selector("text=Top 10 weakest chapters")
            body = page.locator("main").inner_text()
            self.assertIn("review streak", body.lower())
            self.assertIn("Ahead or behind school?", body)
            self.assertIn("Behind by", body)
            self.assertIn("Complex numbers", page.locator(".card:has-text('Top 10 weakest')").inner_text())
            self.assertIn("1 review this week", body)
            self.shot(page, "07-dashboard")

            # --- Settings: change an interval, dark mode
            page.keyboard.press("6")
            page.wait_for_selector("form[data-settings=intervals]")
            page.fill("form[data-settings=intervals] [name='2']", "5")
            page.click("form[data-settings=intervals] button.primary")
            page.wait_for_selector(".toast:has-text('Settings saved')")
            self.assertIn("tracker.sqlite3", page.locator("main").inner_text())
            page.keyboard.press("t")
            page.wait_for_function("document.documentElement.dataset.theme === 'dark'")
            self.shot(page, "08-settings-dark")
            page.keyboard.press("1")
            page.wait_for_selector(".due-item")
            self.shot(page, "09-due-dark")

            # the reviewed chapter's next review now uses the new 5-day interval
            page.keyboard.press("2")
            page.wait_for_selector("#ch-table tbody tr")
            r = page.locator(f"#ch-table tbody tr[data-id='{first_id}']")
            self.assertIn("15 Jan", r.inner_text())

            # --- reload: everything persisted
            page.reload()
            page.wait_for_selector("#ch-table tbody tr")
            self.assertEqual(page.evaluate("document.documentElement.dataset.theme"), "dark")
            self.assertIn("Done", page.locator("#ch-table tbody tr", has_text="Indices and surds")
                          .locator("select[data-field=exercises_status] option:checked").inner_text())

            self.assertEqual(errors, [], f"console errors: {errors}")
            browser.close()


if __name__ == "__main__":
    unittest.main()
