# Revision Tracker

A desktop revision tracker for **OCR A-level Maths (H240)** and **OCR A Further Maths (H245: Further Statistics + Further Mechanics)**. It runs entirely on your own computer, opens in its own window, and keeps all your data in one local file.

It comes pre-loaded with your 80 chapters (6 textbooks). Each has its strand, book, chapter number, sections and level (AS/A). Everything is scheduled around **when you first learnt each chapter**, not a school timetable.

---

## Setup (once)

You need **Python 3.9 or newer**. The app uses nothing else: no other installs and no internet.

### Mac

1. Install Python from **https://www.python.org/downloads/macos/**. Download the latest "macOS 64-bit universal2 installer" and run it.
2. Put this folder somewhere permanent, e.g. `Documents/Revision Tracker`.
3. **Right-click** `Mac - first time setup.command` → **Open** → **Open**. You only need to right-click the first time, because macOS is cautious about downloaded scripts.
   - It checks Python, lets the launcher run, puts a **Revision Tracker** alias on your Desktop and starts the app.

From then on: **double-click "Revision Tracker"** (on your Desktop or in this folder).

> If macOS says the app "can't be opened", right-click it → **Open** once. Setup normally prevents this.

### Windows

1. Install Python from **https://www.python.org/downloads/windows/**. In the installer, **tick "Add python.exe to PATH"**, then click *Install Now*.
2. Put this folder somewhere permanent, e.g. `Documents\Revision Tracker`.
3. Double-click **`Windows - first time setup.bat`**.
   - It checks Python, puts a **Revision Tracker** shortcut (with icon) on your Desktop and starts the app.

From then on: **double-click the "Revision Tracker" shortcut**. You can also double-click `Revision Tracker.pyw` in this folder. If that doesn't work, use `Start Revision Tracker (Windows).bat`.

### How it runs

- It opens as an **app window** if you have Chrome, Edge or Brave; otherwise it opens a normal browser tab. You can change this in Settings.
- No terminal window stays open. The app **closes itself a few minutes after you close its window**, or you can use *Settings → Quit*.
- Double-clicking while it's already running just opens another window onto the same app.

---

## Your data

| What | Where |
|---|---|
| Data file (SQLite) | Mac: `~/Library/Application Support/RevisionTracker/tracker.sqlite3`<br>Windows: `%APPDATA%\RevisionTracker\tracker.sqlite3` |
| Automatic backups | `backups/` next to the data file |

- Your data lives **outside this folder**, so replacing or updating the app never touches it. Settings shows the exact paths.
- **Automatic daily backup:** a copy is saved on each day you use the app, and the last 30 are kept. A backup is also saved before every import or restore. You can restore any of them from *Settings → Backups*.
- **Export:** *Settings → Export JSON* saves everything in one file; *Export CSV* saves a zip with one spreadsheet-friendly CSV per table.
- **Import:** *Import JSON* restores a full export. *Import CSV* replaces one table, e.g. `chapters.csv` after editing it in a spreadsheet.

---

## Using it

| Page | What it's for |
|---|---|
| **Due today** (home) | Chapters whose review date has arrived, plus mistake retests that are due, sorted by **priority**. Below that, **Next to learn** shows the first chapter you haven't learnt yet in each book. |
| **Chapters** | All 80 chapters. Filter by strand, book or status (e.g. learnt / not learnt yet); search; click any column header to sort. Set Summary / Exercises / Exam Qs status and confidence inline. Click a title for its **history timeline** and to set or change its **first learnt** date. |
| **Dashboard** | Progress by strand and by book, your **learning pace** (ahead or behind), top 10 weakest chapters, review streak and reviews this week, paper averages vs A*, and exam countdown. |
| **Past papers** | Log attempts (paper, series, date, mark, time) and the **questions you dropped marks on** (chapter, marks lost, error type, fix). Shows a chart of % over time per paper with the A* line, and your grade boundaries. |
| **Mistakes** | Date is added automatically. Log chapter, source, what went wrong and the correct method, with a **retest date** that feeds the due list. Tick "passed" when you've got it right. |
| **Settings** | Review intervals, priority weights, exam dates, learn-everything-by date, paper max marks, theme, and your data. |

**Learnt today** (★) appears on chapters you haven't learnt yet. It stamps today as the date you first learnt the chapter and asks for your confidence, which schedules the first review. For chapters you learnt before using the app, pick the date in the chapter's panel instead. Reviewing a chapter you haven't marked as learnt also marks it as learnt that day.

**Reviewed today** is on every learnt chapter. It stamps today's date and logs the review in the chapter's history. It also asks for your new confidence (1–5) and shows when the next review will be. You never type a review date. If you log one by mistake, use *Undo* in the chapter's history.

### Keyboard shortcuts (press `?` in the app)

| Key | Action |
|---|---|
| `1`–`6` | Due / Chapters / Dashboard / Papers / Mistakes / Settings |
| `j` `k` (or ↓ ↑) | Move selection |
| `l` | Learnt today for the selected chapter |
| `r` | Reviewed today for the selected chapter |
| `1`–`5`, then `Enter` | Set confidence in the review dialog |
| `Enter` / `o` | Open chapter history |
| `/` | Search chapters |
| `n` | New paper attempt / new mistake |
| `t` | Toggle dark mode |
| `Esc` | Close dialog or panel |

---

## How the numbers work

**Next review** = last review date (or, if you haven't reviewed it yet, the date you first learnt it) + interval for your current confidence. The defaults are 1 → 3 days, 2 → 7, 3 → 14, 4 → 30, 5 → 60; you can change them in Settings.

**Due** means you've learnt the chapter and either:
- its next review date is today or earlier, or
- you haven't rated your confidence yet (so it can be scheduled).

Chapters you haven't learnt yet are never due.

**Priority score (0–100)** is a weighted mix of four parts. The weights can be changed in Settings.

| Part | Default weight | 0 → 1 |
|---|---|---|
| Low confidence | 35 | confidence 5 → 0 … confidence 1 (or unrated) → 1 |
| How overdue | 25 | days past the review date ÷ that interval, capped at 1. A learnt chapter with no confidence rating counts as 1. |
| Marks lost in papers | 25 | *m* / (*m* + 8): 8 marks lost → 0.5, rising towards 1 |
| Learnt yet | 15 | learnt → 1, not learnt yet → 0 |

**Learning pace:** your pace is the number of chapters you first learnt in the last 4 weeks, per week. The pace needed is the chapters left divided by the weeks until your *learn everything by* date (set in Settings; blank means your first exam). You're **ahead** if your pace is at least 10% above what's needed, **behind** if it's more than 10% below, and **on track** in between. The projected finish date assumes you keep your current pace.

**Grades** come only from boundaries you enter for that paper and series. Nothing is pre-filled. The A* line on each chart is the average A* boundary (as a %) across the series you've entered for that paper.

---

## Assumptions (all editable in Settings)

- **Exam dates** are placeholders marked *est.* until OCR publishes the June 2028 timetable. Tick *confirmed* once you have the real dates.
- **Max marks:** H240/01, /02 and /03 are 100 marks each (checked against the OCR H240 specification). Y540–Y543 default to 75; check this against the H245 specification.
- The school teaching term from your spreadsheet is kept in the data file (and in exports) but isn't used anywhere.

---

## For developers

```
revision_tracker/
  logic.py        pure calculations: dates, spaced repetition, schedule, priority, grades
  db.py           SQLite schema, seeding, settings, backups, export/import
  service.py      application operations used by the API
  server.py       local HTTP server (127.0.0.1 only) + JSON API
  main.py         launcher: single instance, opens the window, auto-exit
  static/         the interface (plain HTML/CSS/JS, no build step)
  seed_chapters.json   the 80 chapters, generated from seed/Maths_Further_Maths_Tracker.xlsx
tests/
  test_logic.py   unit tests for dates and priority
  test_api.py     integration tests against a real server on a temp data folder
  test_e2e.py     launches the app and drives it in a real browser (needs Playwright)
```

Run the tests from this folder:

```
python3 -m unittest discover -s tests -t . -v
```

The browser test is skipped unless Playwright is installed (`pip install playwright && playwright install chromium`). Set `E2E_SCREENSHOTS=some/folder` to save screenshots of every page.

Useful options: `python3 -m revision_tracker --no-browser --port 8765 --data-dir ./my-data`. `REVISION_TRACKER_TODAY=2027-01-10` pretends it's a different day (for testing).

To regenerate the seed after editing the spreadsheet: `pip install openpyxl`, then `python3 tools/xlsx_to_seed.py seed/Maths_Further_Maths_Tracker.xlsx`. The seed is only used when the database is first created.
