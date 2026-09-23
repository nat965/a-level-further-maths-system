# Revision Tracker

A revision tracker website for **OCR A-level Maths (H240)** and **OCR A Further Maths (H245: Further Statistics + Further Mechanics)**. It covers spaced repetition, past papers, question-level analysis and a mistakes log.

- **Open it anywhere** (laptop, phone, school computer) at the site's address. Type in your code and you're in your own tracker.
- **Everyone gets their own tracker.** Press *Start a new tracker* to get a new code. Each tracker starts with the same 80 chapters and is completely separate from everyone else's.
- **Nothing to download or update.** Changes to the site go live automatically.

Everything is scheduled around **when you first learnt each chapter**.

---

## Your code

- Your code (like `X9RZ-Q5E6-JU2C`) **is your login**. There's no email or password.
- **Keep it private:** anyone with it can open and change your tracker.
- **Write it down:** if you lose it, the tracker can't be recovered. You can always see it in *Settings*.
- Typing it in, capitals, spaces and dashes don't matter.
- Tick *Keep me logged in on this device* on your own phone or laptop. Leave it unticked on shared computers.
- The site only stores a scrambled (hashed) version of each code. Even someone with access to the database can't read codes out of it.

## Using two devices

Changes save automatically, and the status in the menu says when everything's saved. If you change things on your phone and laptop at the same time, both sets of changes are kept. When you switch back to a tab, it picks up anything you did on the other device.

If you lose your connection, keep the tab open: your changes save when you're back online.

## Backups, export and import

- **Automatic backups:** the server keeps a copy of your tracker from the start of each day you use it, for 14 days. It also keeps one before every import and restore. Restore any of them from *Settings → Backups*.
- **Export:** *Settings → Export JSON* downloads everything as one file. *Export CSV* downloads a zip with one spreadsheet-friendly file per table.
- **Import:** *Import JSON* replaces your tracker with an export. This also works with files from the old desktop app, so you can move your data across. *Import CSV* replaces one table.

---

## Using it

| Page | What it's for |
|---|---|
| **Due today** (home) | Chapters whose review date has arrived, plus mistake retests that are due, sorted by **priority**. Below that, **Next to learn** shows the first chapter you haven't learnt yet in each book. |
| **Chapters** | All 80 chapters. Filter by strand, book or status (e.g. learnt / not learnt yet); search; click any column header to sort. Set Summary / Exercises / Exam Qs status and confidence inline. Click a title for its **history timeline** and to set or change its **first learnt** date. |
| **Dashboard** | Progress by strand and by book, your **learning pace** (ahead or behind), top 10 weakest chapters, review streak and reviews this week, paper averages vs A*, and exam countdown. |
| **Past papers** | Log attempts (paper, series, date, mark, time) and the **questions you dropped marks on** (chapter, marks lost, error type, fix). Shows a chart of % over time per paper with the A* line, and your grade boundaries. |
| **Mistakes** | Date is added automatically. Log chapter, source, what went wrong and the correct method, with a **retest date** that feeds the due list. Tick "passed" when you've got it right. |
| **Settings** | Review intervals, priority weights, exam dates, learn-everything-by date, paper max marks and theme. Also your code, log out, backups, and export/import. |

**Learnt today** (★) appears on chapters you haven't learnt yet. It stamps today as the date you first learnt the chapter and asks for your confidence, which schedules the first review. For chapters you learnt before you started using the site, pick the date in the chapter's panel instead. Reviewing a chapter you haven't marked as learnt also marks it as learnt that day.

**Reviewed today** is on every learnt chapter. It stamps today's date and logs the review in the chapter's history. It also asks for your new confidence (1–5) and shows when the next review will be. You never type a review date. If you log one by mistake, use *Undo* in the chapter's history.

### Keyboard shortcuts (on a computer; press `?` on the site)

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

---

## Setting up the website (once)

The site is static files on **GitHub Pages**, and the data lives in a free **Supabase** database. This takes about 10 minutes. Both services are free.

### 1. Create the database (Supabase)

1. Sign up at **https://supabase.com** and click **New project**. Pick any name and database password, and choose the **London** region.
2. When it's ready, open **SQL Editor → New query**. Paste in the whole of [`supabase/schema.sql`](supabase/schema.sql) and press **Run**. You should see "Success. No rows returned".
3. Open **Project Settings → API Keys** (or **Connect**) and copy two things:
   - the **Project URL**, like `https://abcdefghijklmnop.supabase.co`
   - the **publishable key** (`sb_publishable_…`), or on older projects the **anon public** key.

   Both are safe to share: the database only allows the functions in `schema.sql`, and each needs a tracker's code. **Never use the `secret` / `service_role` key.**

### 2. Publish the site (GitHub Pages)

1. GitHub only hosts Pages for private repositories on a paid plan. So make this repository public: **Settings → General → Danger Zone → Change visibility → Public**. Only the code becomes visible. Trackers live in Supabase and need their codes.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Settings → Secrets and variables → Actions → Variables tab → New repository variable.** Add:
   - `SUPABASE_URL` = your Project URL
   - `SUPABASE_KEY` = your publishable (or anon) key
4. **Actions → Test and publish website → Run workflow.** After a minute or two the site is live at **https://nat965.github.io/a-level-further-maths-system/**.

From then on, every change pushed to the repository runs the tests and updates the live site automatically.

### Good to know

- **Supabase pauses free projects after a week with no activity** (for example, over a holiday). If the site says it can't reach the server, open your Supabase dashboard and press **Restore project**. No data is lost.
- The site allows at most **500 trackers**, so a stranger can't fill the free database. Each tracker is limited to 5 MB, far more than a tracker will ever need.
- To change the database later, edit `supabase/schema.sql` and run it again in the SQL Editor. It's safe to re-run and keeps all trackers.

---

## For developers

```
web/                  the website (plain HTML/CSS/JS modules, no build step)
  js/logic.js         pure calculations: dates, spaced repetition, pace, priority, grades
  js/service.js       the tracker document and every change you can make to it
  js/sync.js          talks to Supabase; saves in the background, merges changes from other devices
  js/files.js         CSV and zip export/import
  js/app.js           the pages
  config.js           Supabase URL + key (filled in by the publish workflow)
  seed_chapters.json  the 80 chapters (from seed/Maths_Further_Maths_Tracker.xlsx)
supabase/schema.sql   database tables and functions
tools/dev-server.mjs  runs the whole site locally, with the real schema in PGlite instead of Supabase
tests/web/            unit and database tests (node --test)
tests/e2e/            browser test of the whole site (Playwright)
```

```
npm install
npm run dev              # http://127.0.0.1:8080, no Supabase account needed
npm test                 # logic, tracker operations, sync and database tests
python3 -m unittest discover -s tests/e2e -v   # needs: pip install playwright && playwright install chromium
```

`npm run dev -- --today 2027-01-10` pretends it's another day, and `--data .devdata` keeps local data between runs.

To regenerate the chapter list after editing the spreadsheet: `pip install openpyxl`, then `python3 tools/xlsx_to_seed.py seed/Maths_Further_Maths_Tracker.xlsx`. New trackers start from this list.
