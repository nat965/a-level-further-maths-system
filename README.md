# Revision Tracker

A revision tracker website for **OCR A-level Maths (H240)** and **OCR A Further Maths (H245: Further Statistics + Further Mechanics)**. It covers spaced repetition, past papers, question-level analysis, a mistakes log and a **question bank** of photos/PDFs of questions you've done.

- **Open it anywhere** (laptop, phone, school computer) at the site's address. Type in your code and you're in your own tracker.
- **Everyone gets their own tracker.** Press *Start a new tracker* to get a new code. Each tracker starts with the same 80 chapters and is completely separate from everyone else's.
- **Nothing to download or update.** Changes to the site go live automatically.

Every chapter is split into its textbook **subtopics** (332 in all), and **each subtopic has its own reviews and schedule**, counted from when you first learnt the chapter. Dates are shown and typed as **dd/mm/yyyy**.

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
| **Due today** (home) | Subtopics whose review date has arrived, grouped by chapter and sorted by **priority**, plus mistake retests that are due. Below that, **Next to learn** shows the first chapter you haven't learnt yet in each book. |
| **Chapters** | All 80 chapters. Filter by strand, book or status (e.g. learnt / not learnt yet); search; click any column header to sort. Set Summary / Exercises / Exam Qs status and the **first learnt** date inline. Press ▸ (or *Show all subtopics*) to see each chapter's subtopics with their own confidence, last review, next review and a *Review* button. Searching also finds subtopics. Click a title for the chapter's **subtopics and their review history**, its **history timeline** and its **question bank**. |
| **Dashboard** | Progress by strand and by book, your **learning pace** (ahead or behind), top 10 weakest chapters and weakest subtopics, review streak and subtopic reviews this week, paper averages vs A*, and exam countdown. |
| **Past papers** | Log attempts (paper, series, date, mark, time) and the **questions you dropped marks on** (chapter, marks lost, error type, fix). Shows a chart of % over time per paper with the A* line, and your grade boundaries. |
| **Mistakes** | Date is added automatically. Log chapter, source, what went wrong and the correct method, with a **retest date** that feeds the due list. Tick "passed" when you've got it right. |
| **Questions** | Your question bank: every question you've uploaded, filtered by strand, chapter or result, with thumbnails. See [Question bank](#question-bank) below. |
| **Settings** | Review intervals, priority weights, exam dates, learn-everything-by date, paper max marks and theme. Also your code, log out, backups, export/import, and how much file storage you've used. |

### Subtopics and reviews

Each chapter's subtopics are its textbook sections (for example, *Quadratic functions* has *Review of quadratic equations*, *Graphs of quadratic functions*, *Completing the square*, …). Sections marked **A only** are A-level only. You can rename, add or delete subtopics in the chapter's panel (*Edit list*).

**Learnt** (★) appears on chapters you haven't fully learnt yet. It lists the subtopics you haven't learnt yet, all ticked.
- **Pick what you learnt.** Untick any you haven't done yet: you can learn a chapter a few subtopics at a time.
- **Rate each one.** Press `1`–`5` to rate them all, then change any that differ.
- **Set the date.** It's today unless you change it.

Each subtopic's first review is scheduled from its own date and rating. A single subtopic also has its own ★ *Learnt* button, in the Chapters table and in the chapter's panel.

**When you first learnt each subtopic:**
- **The chapter's date sets them all.** The *First learnt* date on a chapter applies to every subtopic that doesn't have its own date.
- **Give one subtopic its own date** in its row of the Chapters table, or in the chapter's panel (open the subtopic). A date that matches the chapter's is shown greyed. Clear a subtopic's own date and it goes back to the chapter's.
- **When the chapter counts as learnt.** A chapter counts as learnt (for your learning pace and *Next to learn*) once all its subtopics are. It then takes the earliest of their dates.

**Review** is on every learnt chapter, and on each of its subtopics.
- **Pick what you reviewed.** It opens with the subtopics that are due already ticked. Tick any others you went over, and rate each one 1–5 for how confident you are now. Rating a subtopic ticks it.
- **Set the date.** The review is dated today unless you change it: type a date as dd/mm/yyyy, press *Yesterday*, or use the 📅 calendar.
- **See the schedule.** The dialog shows each subtopic's next review date before you save.

Each ticked subtopic gets its own dated review and its own next review.

**A chapter's summary comes from its subtopics.** Its confidence is the average of its subtopics' ratings (the panel also shows the lowest). Its next review is its earliest subtopic's. It's due when any of its subtopics is due.

**Review history:** open a chapter and click a subtopic to see every review of it, with dates in dd/mm/yyyy. You can change a review's date there, or *Undo* it. The chapter's *History* shows each review session. *Undo* there removes the whole session.

**Changing when you first learnt a chapter:** change the *First learnt* date at any time, in the Chapters table or in the chapter's panel. Subtopics that use the chapter's date and haven't been reviewed since are rescheduled from the new date. Once a chapter has reviews, the date can still be changed but not cleared (undo its reviews first). A review can't be dated before its subtopic was learnt. Reviewing a subtopic you haven't marked as learnt marks it as learnt on the review date.

**Trackers from before subtopics** upgrade automatically the first time you open them. Each old chapter review becomes a review of every subtopic in that chapter, with the same date and confidence, so nothing is lost. If you have the site open in another tab, reload it.

### Keyboard shortcuts (on a computer; press `?` on the site)

| Key | Action |
|---|---|
| `1`–`7` | Due / Chapters / Dashboard / Papers / Mistakes / Questions / Settings |
| `j` `k` (or ↓ ↑) | Move selection |
| `l` | Learnt, for the selected chapter |
| `r` | Review the selected chapter (or the selected subtopic in the Chapters table) |
| `1`–`5`, then `Enter` | Rate every ticked subtopic in the review dialog, then save |
| `Enter` / `o` | Open the chapter and its subtopics (or the selected question) |
| `/` | Search chapters and subtopics |
| `n` | New paper attempt / mistake / question |
| `t` | Toggle dark mode |
| `Esc` | Close dialog or panel |

### Question bank

Every chapter has its own question bank, and a question can be on **one subtopic** or the whole chapter. Add a question from the chapter's panel: *+ Add question* for the chapter, or open a subtopic and use its own *+ Add question*. You can also add one from the **Questions** page:

- **Upload the question** as photos (straight from your phone camera works) and/or PDFs. Big photos are shrunk before uploading so they're quick and still readable. Each file can be up to 10 MB.
- Pick its **subtopic** (or leave it as the whole chapter). You can change it later in the question's view.
- Give it a title and source (e.g. *Ex 3E Q7*, *June 2019 Y540 Q8*) and say how it went: not tried yet, wrong, partly right or right.
- **Finding a subtopic's questions:**
  - Its questions show under that subtopic in the chapter's panel.
  - A subtopic with questions has a 📄 count in the Chapters table and in the due list. Click it to see them.
  - On the Questions page, pick a chapter and then a subtopic to filter.
- **Model solution:** attach photos/PDFs of the worked solution or mark scheme, and/or type it out. It stays hidden behind *Show model solution*, so you can redo the question first.
- **Mistakes log:** log mistakes straight on the question (they appear in the Mistakes page too, with a link back), or link a mistake you'd already logged for that chapter. When a retest is due, the due list has an *Open question* button so you can redo the actual question.

Files are private to your tracker: they're stored in the same database and can only be opened with your code. Each tracker can store **100 MB** of files (a phone photo after shrinking is usually 0.3–1 MB). *Settings → Question files* shows how much you've used, can download them all as a zip, and can tidy up files no question uses any more. JSON/CSV exports include the question details but not the files themselves.

---

## How the numbers work

Everything below is worked out **for each subtopic**.

**Next review** = the subtopic's last review date (or, if you haven't reviewed it yet, the date you first learnt it) + the interval for its current confidence. The defaults are 1 → 3 days, 2 → 7, 3 → 14, 4 → 30, 5 → 60; you can change them in Settings. Its current confidence is the one from its latest review by date. A review you back-date to before a later one doesn't change it.

**Due** means you've learnt the subtopic and either:
- the subtopic's next review date is today or earlier, or
- the subtopic hasn't been rated yet (for example, one you've just added), so it can be scheduled.

Subtopics you haven't learnt yet are never due.

**Priority score (0–100)** is a weighted mix of four parts, and a chapter's priority is its most urgent subtopic's. The weights can be changed in Settings.

| Part | Default weight | 0 → 1 |
|---|---|---|
| Low confidence | 35 | confidence 5 → 0 … confidence 1 (or unrated) → 1 |
| How overdue | 25 | days past the review date ÷ that interval, capped at 1. An unrated subtopic of a learnt chapter counts as 1. |
| Marks lost in papers | 25 | *m* / (*m* + 8), where *m* is the marks lost on the chapter: 8 marks lost → 0.5, rising towards 1 |
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
- The site allows at most **500 trackers**, so a stranger can't fill the free database. Each tracker (not counting question files) is limited to 5 MB, far more than a tracker will ever need.
- Question files are limited to 100 MB per tracker and 350 MB for the whole site, to stay inside Supabase's free 500 MB database. Deleted files are kept for 14 days so restoring a backup brings them back.
- To change the database later, edit `supabase/schema.sql` and run it again in the SQL Editor. It's safe to re-run and keeps all trackers.
- **After an update that changes `schema.sql`, run it again** (SQL Editor → paste the whole file → Run). The question bank needs this: until then, uploading says the database needs updating.

---

## For developers

```
web/                  the website (plain HTML/CSS/JS modules, no build step)
  js/logic.js         pure calculations: dates, spaced repetition, pace, priority, grades
  js/service.js       the tracker document and every change you can make to it
  js/syllabus.js      every chapter's subtopics (textbook sections)
  js/sync.js          talks to Supabase; saves in the background, merges changes from other devices
  js/files.js         CSV and zip export/import
  js/filestore.js     uploads/downloads question files in 1 MB chunks
  js/images.js        shrinks photos and makes thumbnails before uploading
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

To regenerate the chapter list after editing the spreadsheet: `pip install openpyxl`, then `python3 tools/xlsx_to_seed.py seed/Maths_Further_Maths_Tracker.xlsx`. New trackers start from this list. Each chapter's subtopics come from `web/js/syllabus.js` (keyed by book and chapter number).
