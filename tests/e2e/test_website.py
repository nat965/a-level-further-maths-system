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
import shutil
import socket
import struct
import subprocess
import time
import unittest
import urllib.request
import zipfile
import zlib
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


def make_png(width=1200, height=800):
    """A real PNG (stripes) without needing an image library."""
    raw = b"".join(b"\x00" + bytes((x * 7 + y * 3) % 256 for x in range(width)) for y in range(height))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def make_pdf(text="Q7: Solve x^2 - 5x + 6 = 0"):
    """A one-page PDF with some text."""
    stream = f"BT /F1 24 Tf 72 720 Td ({text}) Tj ET".encode()
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offsets = b"%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offsets)
    return out + b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)


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
        page.wait_for_selector(".modal .sub-rate")
        self.assertEqual(page.input_value("#review-on"), "10/01/2027")
        page.keyboard.press("3")  # rates every subtopic 3
        self.assertEqual(page.locator(".sub-rate td.next").all_inner_texts(), ["24/01/2027"] * 5)
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
            page.fill(".drawer input[data-change=first-learnt]", "01/12/2026")
            page.keyboard.press("Enter")
            page.wait_for_selector(".drawer:has-text('Learnt 01/12/2026')")
            page.keyboard.press("Escape")
        # review one subtopic straight from the table
        page.locator("#ch-table tr.ch-row", has_text="Indices and surds").locator("button[data-action=toggle-subs]").click()
        sub = page.locator("#ch-table tr.sub-row", has_text="Using the laws of indices")
        sub.locator("button[data-action=review-sub]").click()
        page.wait_for_selector(".modal .sub-rate")
        self.assertEqual(page.locator(".sub-rate input.tick:checked").count(), 1)
        page.keyboard.press("2")
        page.keyboard.press("Enter")
        page.wait_for_selector("#ch-table tr.sub-row:has-text('Using the laws of indices') .conf.c2")
        self.wait_saved(page)
        page.locator("#ch-table tr.ch-row", has_text="Indices and surds").locator("button[data-action=toggle-subs]").click()
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
        page.wait_for_selector(".modal .sub-rate")
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
        page.keyboard.press("7")
        page.wait_for_selector("#my-code")
        self.assertEqual(page.inner_text("#my-code"), code)
        with page.expect_download() as dl:
            page.click("button[data-action=export-json]")
        exported = json.loads(Path(dl.value.path()).read_text())
        self.assertEqual(exported["format"], "revision-tracker")
        self.assertEqual(len(exported["subtopics"]), 332)
        self.assertGreaterEqual(len(exported["reviews"]), 2)
        self.assertTrue(all(r["subtopic_id"] for r in exported["reviews"]))
        self.assertEqual(len(exported["mistakes"]), 1)
        with page.expect_download() as dl:
            page.click("button[data-action=export-csv]")
        z = zipfile.ZipFile(io.BytesIO(Path(dl.value.path()).read_bytes()))
        self.assertIsNone(z.testzip())
        self.assertIn("chapters.csv", z.namelist())
        self.assertIn("subtopics.csv", z.namelist())
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
        page.keyboard.press("7")
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
        phone.wait_for_selector(".modal .sub-rate")
        phone.click(".rate.all button[data-all='2']")
        phone.click("#review-save")
        laptop.locator("#learn-section .due-item", has_text="Further Mechanics ch 1").locator("button[data-action=learnt]").click()
        laptop.wait_for_selector(".modal .sub-rate")
        laptop.click(".rate.all button[data-all='5']")
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

    # ------------------------------------------------------------------ first-learnt dates and the question bank

    def rpc(self, name, args):
        req = urllib.request.Request(f"{self.url}rest/v1/rpc/{name}", data=json.dumps(args).encode(),
                                     headers={"Content-Type": "application/json", "apikey": "dev"})
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read() or b"null")

    def test_first_learnt_dates_and_question_bank(self):
        page = self.new_page()
        code = self.create_tracker(page)
        page.click("#open-new")
        page.wait_for_selector("#learn-section")

        # --- "learnt" can be dated in the past
        page.locator("#learn-section .due-item", has_text="Maths Y1 (red) ch 1").locator("button[data-action=learnt]").click()
        page.wait_for_selector(".modal #review-on")
        page.fill("#review-on", "01/01/2027")
        page.click(".rate.all button[data-all='3']")
        self.assertEqual(page.locator(".sub-rate td.next").first.inner_text(), "15/01/2027")
        page.click("#review-save")
        page.wait_for_selector("#learn-section .due-item:has-text('Maths Y1 (red) ch 2')")
        self.wait_saved(page)

        # --- first-learnt dates can be changed any time, straight in the chapters table
        page.keyboard.press("2")
        page.wait_for_selector("#ch-table tbody tr")
        row = page.locator("#ch-table tbody tr").first
        self.assertEqual(row.locator("input[data-change=first-learnt]").input_value(), "01/01/2027")
        row.locator("input[data-change=first-learnt]").fill("20/12/2026")
        row.locator("input[data-change=first-learnt]").press("Enter")
        page.wait_for_selector(".toast:has-text('First learnt: 20/12/2026')")
        self.wait_saved(page)
        quad = page.locator("#ch-table tr.ch-row", has_text="Quadratic functions").first
        quad.locator("input[data-change=first-learnt]").fill("1/11/2026")
        quad.locator("input[data-change=first-learnt]").press("Enter")
        page.wait_for_selector(".toast:has-text('First learnt: 01/11/2026')")
        quad.locator("input[data-change=first-learnt]").fill("15/10/2026")
        quad.locator("input[data-change=first-learnt]").press("Enter")
        page.wait_for_selector(".toast:has-text('First learnt: 15/10/2026')")
        self.wait_saved(page)
        self.assertEqual(quad.locator("input[data-change=first-learnt]").input_value(), "15/10/2026")
        page.click("#ch-table a[data-action=open]:text-is('Quadratic functions')")
        page.wait_for_selector(".drawer:has-text('Learnt 15/10/2026')")
        self.shot(page, "10-first-learnt")

        # --- add a question (photo + PDF) with a model solution from the chapter panel
        tmp = ROOT / "tests" / "e2e" / f"tmp_{self._testMethodName}"
        tmp.mkdir(exist_ok=True)
        self.addCleanup(shutil.rmtree, tmp, True)
        (tmp / "question.png").write_bytes(make_png(3000, 1800))
        (tmp / "paper.pdf").write_bytes(make_pdf())
        (tmp / "solution.png").write_bytes(make_png(600, 400))
        page.click(".drawer button[data-action=add-question]:not([data-sub])")
        page.wait_for_selector("#upload-form")
        self.assertEqual(page.locator("#upload-form [name=chapter_id] option:checked").inner_text(), "Maths Y1 (red) 3: Quadratic functions")
        self.assertEqual(page.locator("#upload-form [name=subtopic_id] option:checked").inner_text(), "Whole chapter (no one subtopic)")
        page.select_option("#upload-form [name=subtopic_id]", label="3.3 Completing the square")
        page.fill("#upload-form [name=title]", "Ex 3E Q7")
        page.fill("#upload-form [name=source]", "Textbook")
        page.set_input_files("#upload-form [name=files]", [str(tmp / "question.png"), str(tmp / "paper.pdf")])
        page.click("#upload-form summary")
        page.set_input_files("#upload-form [name=solution_files]", str(tmp / "solution.png"))
        page.fill("#upload-form [name=solution_text]", "Factorise: (x-2)(x-3)=0 so x = 2 or 3")
        page.click("#upload-go")
        page.wait_for_selector(".viewer")
        self.assertEqual(page.input_value(".viewer .title-input"), "Ex 3E Q7")
        self.assertIn("3.3 Completing the square", page.inner_text(".viewer"))
        page.wait_for_function("[...document.querySelectorAll('.viewer [data-src-file]')].every(e => e.src.startsWith('blob:'))")
        self.assertEqual(page.locator(".viewer .q-file").count(), 3)
        self.assertEqual(page.locator(".viewer iframe.pdf").count(), 1)
        # the big photo was shrunk before uploading
        self.assertEqual(page.evaluate("document.querySelector('.viewer img').naturalWidth"), 2000)
        self.assertIn("paper.pdf", page.inner_text(".viewer"))
        page.click(".viewer details.solution summary")
        self.assertIn("(x-2)(x-3)", page.input_value(".viewer textarea[data-field=solution_text]"))
        self.wait_saved(page)

        # --- log a mistake on it, from the question
        page.fill("#q-mistake-form [name=what_wrong]", "Sign error when factorising")
        page.fill("#q-mistake-form [name=correct_method]", "Expand back out to check")
        page.click("#q-mistake-form button[type=submit]")
        page.wait_for_selector(".viewer td:has-text('Sign error when factorising')")
        # mark it as partly right
        page.click(".viewer button[data-status=partly]")
        page.wait_for_selector(".viewer button.primary[data-status=partly]")
        self.wait_saved(page)
        self.shot(page, "11-question")
        page.keyboard.press("Escape")
        page.wait_for_selector(".viewer", state="detached")
        page.wait_for_selector("#drawer-questions .q-card:has-text('Ex 3E Q7')")
        # it's listed under its subtopic too
        cts = page.locator(".drawer details.sub", has_text="Completing the square")
        self.assertIn("1 question", cts.locator(".sub-meta").inner_text())
        cts.locator("summary .sub-name").click()
        self.assertEqual(cts.locator(".q-card").count(), 1)
        self.assertEqual(page.locator(".drawer details.sub", has_text="The discriminant").locator(".q-card").count(), 0)
        page.keyboard.press("Escape")

        # --- the Questions page and the Mistakes page link up
        page.keyboard.press("6")
        page.wait_for_selector(".q-card")
        self.assertEqual(page.locator(".q-card").count(), 1)
        page.wait_for_function("document.querySelector('.q-card img')?.src.startsWith('blob:')")
        self.assertIn("Partly right", page.inner_text(".q-card"))
        self.assertIn("› 3.3 Completing the square", page.inner_text(".q-card"))
        # filter by chapter, then subtopic
        page.select_option("select[data-qfilter=chapter]", label="Maths Y1 (red) 3: Quadratic functions")
        page.select_option("select[data-qfilter=subtopic]", label="3.5 The discriminant")
        page.wait_for_selector(".empty:has-text('No questions match')")
        page.select_option("select[data-qfilter=subtopic]", label="3.3 Completing the square")
        page.wait_for_selector(".q-card")
        page.select_option("select[data-qfilter=chapter]", "")
        self.shot(page, "12-question-bank")
        page.keyboard.press("5")
        page.wait_for_selector("td:has-text('Sign error when factorising')")
        page.click("a[data-action=open-question]:has-text('Ex 3E Q7')")
        page.wait_for_selector(".viewer")
        file_id = page.locator(".viewer .q-file").first.get_attribute("data-file-id")
        # make the retest due today
        page.fill(".viewer input[data-change=retest-date]", "2027-01-10")
        self.wait_saved(page)
        page.keyboard.press("Escape")

        # --- on another device: the retest is due and the question (with its files) opens
        other = self.new_page()
        self.log_in(other, code)
        other.wait_for_selector(".due-item button[data-action=open-question]")
        other.click("button[data-action=open-question]")
        other.wait_for_selector(".viewer")
        other.wait_for_function("[...document.querySelectorAll('.viewer [data-src-file]')].every(e => e.src.startsWith('blob:'))")
        self.assertEqual(other.evaluate("document.querySelector('.viewer img').naturalWidth"), 2000)

        # --- remove the PDF, then delete the question: the mistake stays in the log
        other.locator(".viewer .q-file", has_text="paper.pdf").locator("button[data-action=remove-file]").click()
        other.wait_for_function("document.querySelectorAll('.viewer .q-file').length === 2")
        other.click(".viewer button[data-action=delete-question]")
        other.wait_for_selector(".viewer", state="detached")
        self.wait_saved(other)
        other.keyboard.press("6")
        other.wait_for_selector(".empty:has-text('Your question bank is empty')")
        other.keyboard.press("5")
        other.wait_for_selector("td:has-text('Sign error when factorising')")
        self.assertEqual(other.locator("a[data-action=open-question]").count(), 0)
        other.keyboard.press("7")
        other.wait_for_selector("#file-usage:has-text('of 100 MB')")

        # --- files belong to one tracker: a friend's code can't read them
        friend = self.new_page()
        friend_code = self.create_tracker(friend)
        self.assertIsNone(self.rpc("get_file_chunk", {"p_code": friend_code, "p_file_id": file_id, "p_seq": 0}))
        self.assertIsNotNone(self.rpc("get_file_chunk", {"p_code": code, "p_file_id": file_id, "p_seq": 0}))
        for p in (page, other, friend):
            self.assertEqual(p.errors, [], p.errors)

    # ------------------------------------------------------------------ subtopics, each with its own reviews

    def test_subtopic_reviews(self):
        page = self.new_page()
        self.create_tracker(page)
        page.click("#open-new")
        page.wait_for_selector("#learn-section")

        # learn Quadratic functions on 1 Jan, rating each subtopic
        page.locator("#learn-section .due-item", has_text="Maths Y1 (red) ch 1").locator("button[data-action=learnt]").click()
        page.wait_for_selector(".modal .sub-rate")
        page.keyboard.press("Escape")
        page.keyboard.press("2")
        page.wait_for_selector("#ch-table tbody tr")
        page.locator("#ch-table tr.ch-row", has_text="Quadratic functions").locator("button[data-action=learnt]").click()
        page.wait_for_selector(".modal .sub-rate")
        self.assertEqual(page.locator(".sub-rate tbody tr").count(), 6)
        page.fill("#review-on", "1/1/2027")
        self.assertTrue(page.is_disabled("#review-save"))  # every subtopic needs a rating
        page.keyboard.press("Tab")  # leave the date box
        page.click(".rate.all button[data-all='4']")
        page.locator(".sub-rate tbody tr", has_text="Completing the square").locator("button[data-conf='1']").click()
        self.assertEqual(page.locator(".sub-rate tbody tr", has_text="Completing the square").locator("td.next").inner_text(), "04/01/2027")
        self.shot(page, "13-learnt-subtopics")
        page.click("#review-save")
        page.wait_for_selector("#ch-table tr.ch-row:has-text('Quadratic functions') .pill:has-text('1/6 due')")

        # the due list shows just the due subtopic
        page.keyboard.press("1")
        page.wait_for_selector("#review-section .due-item")
        item = page.locator("#review-section .due-item", has_text="Quadratic functions")
        self.assertEqual(item.locator(".sub-due li").count(), 1)
        self.assertIn("Completing the square", item.inner_text())
        self.assertIn("6 days overdue", item.inner_text())
        self.shot(page, "14-due-subtopics")

        # review it yesterday: tick another subtopic too, with its own rating
        item.locator("button[data-action=review]").click()
        page.wait_for_selector(".modal .sub-rate")
        self.assertEqual(page.locator(".sub-rate input.tick:checked").count(), 1)  # the due one
        page.click("button[data-set-date='2027-01-09']")
        self.assertEqual(page.input_value("#review-on"), "09/01/2027")
        page.locator(".sub-rate tbody tr", has_text="Completing the square").locator("button[data-conf='3']").click()
        page.locator(".sub-rate tbody tr", has_text="The discriminant").locator("button[data-conf='5']").click()
        self.assertEqual(page.locator(".sub-rate input.tick:checked").count(), 2)  # rating ticks it
        page.fill("#review-note", "Ex 3C")
        self.assertIn("2 subtopics", page.inner_text("#review-save"))
        page.click("#review-save")
        page.wait_for_selector(".toast:has-text('Logged review of 2 subtopics on 09/01/2027')")
        page.wait_for_selector("#review-section:has-text('Nothing due')")

        # each subtopic has its own history, in dd/mm/yyyy, and a review's date can be changed
        page.keyboard.press("2")
        page.wait_for_selector("#ch-table tbody tr")
        page.click("#ch-table a[data-action=open]:text-is('Quadratic functions')")
        self.assertIn("Reviewed 2 subtopics", page.inner_text(".drawer .timeline"))
        sub = page.locator(".drawer details.sub", has_text="Completing the square")
        self.assertIn("last reviewed 09/01/2027", sub.inner_text())
        self.assertIn("next 23/01/2027", sub.inner_text())
        sub.locator("summary .sub-name").click()
        date = sub.locator("input[data-change=review-date]")
        self.assertEqual(date.input_value(), "09/01/2027")
        date.fill("05/01/2027")
        date.press("Enter")
        page.wait_for_selector(".toast:has-text('Review date changed')")
        sub = page.locator(".drawer details.sub", has_text="Completing the square")
        page.wait_for_function("document.querySelector('.drawer details.sub[open]')?.innerText.includes('next 19/01/2027')")
        self.assertIn("1 → 3", sub.inner_text())
        # a date in the future is refused
        sub.locator("input[data-change=review-date]").fill("20/01/2027")
        sub.locator("input[data-change=review-date]").press("Enter")
        page.wait_for_selector(".toast.error:has-text('future')")
        self.assertEqual(page.locator(".drawer details.sub[open] input[data-change=review-date]").input_value(), "05/01/2027")
        self.shot(page, "15-subtopic-history")

        # edit the list: add, rename, delete
        page.click(".drawer button[data-action=edit-subs]")
        page.fill("#add-sub-form [name=title]", "Solving quadratics by formula")
        page.press("#add-sub-form [name=title]", "Enter")
        page.wait_for_selector(".drawer input[data-change=rename-sub][value='Solving quadratics by formula']")
        page.fill(".drawer input[data-change=rename-sub][value='Solving quadratics by formula']", "The quadratic formula")
        page.press(".drawer input[data-change=rename-sub][value='Solving quadratics by formula']", "Tab")
        page.wait_for_selector(".toast:has-text('Renamed')")
        page.locator(".drawer .sub-edit", has=page.locator("input[value='Review of quadratic equations']")).locator("button[data-action=del-sub]").click()
        page.wait_for_selector(".toast:has-text('Subtopic deleted')")
        page.click(".drawer button[data-action=edit-subs]")
        titles = page.locator(".drawer details.sub .sub-name").all_inner_texts()
        self.assertEqual(len(titles), 6)
        self.assertEqual(titles[-1], "The quadratic formula")
        self.assertIn("Learnt — rate", page.inner_text(".drawer .chip-row"))  # the new one needs rating
        page.keyboard.press("Escape")

        # searching finds subtopics and opens their chapter's list
        page.fill("#ch-search", "discriminant")
        page.wait_for_selector("#ch-table tr.sub-row.match")
        self.assertEqual(page.locator("#ch-table tr.ch-row").count(), 2)  # Quadratic functions, Using graphs
        self.assertEqual(page.locator("#ch-table tr.sub-row.match").count(), 2)
        self.assertEqual(page.errors, [], page.errors)

    def test_subtopic_learnt_dates(self):
        page = self.new_page()
        self.create_tracker(page)
        page.click("#open-new")
        page.wait_for_selector("#learn-section")
        page.keyboard.press("2")
        page.wait_for_selector("#ch-table tbody tr")
        page.locator("#ch-table tr.ch-row[data-id='4']").locator("button[data-action=toggle-subs]").click()
        row = lambda title: page.locator("#ch-table tr.sub-row", has_text=title)

        # type a date for one subtopic: just that one is learnt (and needs rating)
        row("Polynomial division").locator("input[data-change=sub-learnt]").fill("03/01/2027")
        row("Polynomial division").locator("input[data-change=sub-learnt]").press("Enter")
        page.wait_for_selector(".toast:has-text('Polynomial division: first learnt 03/01/2027')")
        self.assertEqual(row("Polynomial division").locator("button[data-action=review-sub]").count(), 1)
        self.assertEqual(row("The factor theorem").locator("button[data-action=learn-sub]").count(), 1)
        chapter = page.locator("#ch-table tr.ch-row[data-id='4']")
        self.assertEqual(chapter.locator("input[data-change=first-learnt]").input_value(), "")
        self.assertEqual(chapter.locator("button[data-action=learnt]").count(), 1)  # the rest still to learn

        # mark one more as learnt on another day
        row("The factor theorem").locator("button[data-action=learn-sub]").click()
        page.wait_for_selector(".modal .sub-rate")
        self.assertEqual(page.locator(".sub-rate tbody tr").count(), 3)  # only the ones not learnt yet
        self.assertEqual(page.locator(".sub-rate input.tick:checked").count(), 1)
        page.fill("#review-on", "05/01/2027")
        page.click(".rate.all button[data-all='4']")
        page.click("#review-save")
        page.wait_for_selector(".toast:has-text('Marked 1 subtopic as learnt')")

        # then the rest, today
        chapter.locator("button[data-action=learnt]").click()
        page.wait_for_selector(".modal .sub-rate")
        self.assertEqual(page.locator(".sub-rate tbody tr").count(), 2)
        page.keyboard.press("3")
        page.keyboard.press("Enter")
        page.wait_for_selector(".toast:has-text('Marked 2 subtopics as learnt')")
        self.wait_saved(page)
        # the chapter takes the earliest date; the others keep their own
        chapter = page.locator("#ch-table tr.ch-row[data-id='4']")
        self.assertEqual(chapter.locator("input[data-change=first-learnt]").input_value(), "03/01/2027")
        dates = {t: row(t).locator("input[data-change=sub-learnt]").input_value() for t in
                 ("Working with polynomials", "Polynomial division", "The factor theorem", "Sketching polynomial functions")}
        self.assertEqual(dates, {"Working with polynomials": "10/01/2027", "Polynomial division": "03/01/2027",
                                 "The factor theorem": "05/01/2027", "Sketching polynomial functions": "10/01/2027"})
        self.assertEqual(row("Polynomial division").locator(".inherited").count(), 1)  # same as the chapter
        self.shot(page, "16-subtopic-learnt-dates")

        # in the chapter panel: clear one subtopic's own date and it goes back to the chapter's
        page.click("#ch-table a[data-action=open]:text-is('Polynomials')")
        sub = page.locator(".drawer details.sub", has_text="The factor theorem")
        self.assertIn("Learnt 05/01/2027", sub.locator(".sub-meta").inner_text())
        sub.locator("summary .sub-name").click()
        sub.locator("input[data-change=sub-learnt]").fill("")
        sub.locator("input[data-change=sub-learnt]").press("Enter")
        page.wait_for_selector(".toast:has-text('The factor theorem: first learnt 03/01/2027')")
        sub = page.locator(".drawer details.sub", has_text="The factor theorem")
        self.assertIn("Same as the chapter", sub.inner_text())
        self.assertEqual(page.errors, [], page.errors)

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
        page.keyboard.press("7")
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
