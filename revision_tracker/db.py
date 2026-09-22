"""SQLite storage: schema, seeding, settings, backups and export/import."""
import csv
import io
import json
import os
import sqlite3
import sys
import zipfile
from contextlib import contextmanager
from datetime import date, datetime
from pathlib import Path

from . import logic

SCHEMA_VERSION = 2
DB_NAME = "tracker.sqlite3"
KEEP_DAILY_BACKUPS = 30

SCHEMA = """
CREATE TABLE IF NOT EXISTS chapters (
    id INTEGER PRIMARY KEY,
    strand TEXT NOT NULL,
    book TEXT NOT NULL,
    ch_num INTEGER NOT NULL,
    title TEXT NOT NULL,
    sections TEXT NOT NULL DEFAULT '',
    level TEXT NOT NULL DEFAULT '',
    terms TEXT NOT NULL DEFAULT '[]',
    summary_status TEXT NOT NULL DEFAULT 'not_started',
    exercises_status TEXT NOT NULL DEFAULT 'not_started',
    examq_status TEXT NOT NULL DEFAULT 'not_started',
    confidence INTEGER CHECK (confidence BETWEEN 1 AND 5),
    first_learnt TEXT,
    notes TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY,
    chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    reviewed_on TEXT NOT NULL,
    confidence_before INTEGER,
    confidence_after INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_chapter ON reviews(chapter_id, reviewed_on);
CREATE TABLE IF NOT EXISTS papers (
    id INTEGER PRIMARY KEY,
    paper_code TEXT NOT NULL,
    series TEXT NOT NULL,
    sat_on TEXT NOT NULL,
    mark REAL,
    max_mark REAL NOT NULL,
    time_taken_min INTEGER,
    notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS paper_questions (
    id INTEGER PRIMARY KEY,
    paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    q_num TEXT NOT NULL DEFAULT '',
    chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
    marks_lost REAL NOT NULL DEFAULT 0,
    error_type TEXT NOT NULL DEFAULT '',
    fix TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_pq_chapter ON paper_questions(chapter_id);
CREATE TABLE IF NOT EXISTS boundaries (
    id INTEGER PRIMARY KEY,
    paper_code TEXT NOT NULL,
    series TEXT NOT NULL,
    a_star REAL, a REAL, b REAL, c REAL, d REAL, e REAL,
    UNIQUE (paper_code, series)
);
CREATE TABLE IF NOT EXISTS mistakes (
    id INTEGER PRIMARY KEY,
    logged_on TEXT NOT NULL,
    chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
    source TEXT NOT NULL DEFAULT '',
    what_wrong TEXT NOT NULL DEFAULT '',
    correct_method TEXT NOT NULL DEFAULT '',
    retest_on TEXT,
    retest_passed INTEGER NOT NULL DEFAULT 0,
    passed_on TEXT
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

# Tables in dependency order (parents first) for export/import.
TABLES = ("chapters", "reviews", "papers", "paper_questions", "boundaries", "mistakes", "settings")
BOUNDARY_COLS = {"A*": "a_star", "A": "a", "B": "b", "C": "c", "D": "d", "E": "e"}


def default_data_dir():
    override = os.environ.get("REVISION_TRACKER_DATA")
    if override:
        return Path(override)
    home = Path.home()
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / "RevisionTracker"
    if os.name == "nt":
        return Path(os.environ.get("APPDATA", home)) / "RevisionTracker"
    return Path(os.environ.get("XDG_DATA_HOME", home / ".local" / "share")) / "revision-tracker"


class Store:
    def __init__(self, data_dir):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.backup_dir = self.data_dir / "backups"
        self.backup_dir.mkdir(exist_ok=True)
        self.path = self.data_dir / DB_NAME
        self._last_backup_day = None
        with self.tx() as con:
            con.executescript(SCHEMA)
            migrate(con)
            if con.execute("SELECT COUNT(*) FROM chapters").fetchone()[0] == 0:
                seed_chapters(con)

    def connect(self):
        con = sqlite3.connect(self.path, timeout=10)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys = ON")
        return con

    @contextmanager
    def tx(self):
        """Connection that commits on success, rolls back on error and always closes."""
        con = self.connect()
        try:
            yield con
            con.commit()
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()

    # ------------------------------------------------------------ settings

    def settings(self, con=None):
        own = con is None
        con = con or self.connect()
        try:
            stored = {r["key"]: json.loads(r["value"]) for r in con.execute("SELECT * FROM settings")}
        finally:
            if own:
                con.close()
        merged = json.loads(json.dumps(logic.DEFAULT_SETTINGS))
        merged.update({k: v for k, v in stored.items() if k in merged})  # drop retired keys
        if set(merged["priority_weights"]) != set(logic.DEFAULT_SETTINGS["priority_weights"]):
            merged["priority_weights"] = dict(logic.DEFAULT_SETTINGS["priority_weights"])
        return merged

    def save_settings(self, updates):
        validate_settings(updates)
        with self.tx() as con:
            for k, v in updates.items():
                if k not in logic.DEFAULT_SETTINGS:
                    raise ValueError(f"Unknown setting: {k}")
                con.execute("INSERT INTO settings(key, value) VALUES (?, ?) "
                            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                            (k, json.dumps(v)))
        return self.settings()

    # ------------------------------------------------------------ backups

    def backup(self, label=None, today=None):
        """Copy the database with SQLite's online backup API (safe while in use)."""
        if label is None:
            label = f"daily-{(today or date.today()).isoformat()}"
        dest = self.backup_dir / f"tracker-{label}.sqlite3"
        src = self.connect()
        try:
            dst = sqlite3.connect(dest)
            try:
                src.backup(dst)
            finally:
                dst.close()
        finally:
            src.close()
        return dest

    def daily_backup(self, today=None):
        """Make today's backup if it doesn't exist yet, then prune old daily backups."""
        today = today or date.today()
        if self._last_backup_day == today:
            return None
        made = None
        target = self.backup_dir / f"tracker-daily-{today.isoformat()}.sqlite3"
        if not target.exists():
            made = self.backup(today=today)
        self._last_backup_day = today
        dailies = sorted(self.backup_dir.glob("tracker-daily-*.sqlite3"))
        for old in dailies[:-KEEP_DAILY_BACKUPS]:
            old.unlink()
        return made

    def list_backups(self):
        out = []
        for p in sorted(self.backup_dir.glob("tracker-*.sqlite3"), key=lambda p: p.stat().st_mtime,
                        reverse=True):
            st = p.stat()
            out.append({"name": p.name, "size": st.st_size,
                        "modified": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds")})
        return out

    def restore_backup(self, name):
        src_path = self.backup_dir / name
        if (not name.startswith("tracker-") or not name.endswith(".sqlite3") or "/" in name
                or "\\" in name or not src_path.exists()):
            raise ValueError("No such backup")
        self.backup(label="pre-restore-" + datetime.now().strftime("%Y%m%d-%H%M%S"))
        src = sqlite3.connect(src_path)
        try:
            dst = self.connect()
            try:
                src.backup(dst)
            finally:
                dst.close()
        finally:
            src.close()

    # ------------------------------------------------------------ export / import

    def export_tables(self):
        with self.tx() as con:
            return {t: [dict(r) for r in con.execute(f"SELECT * FROM {t} ORDER BY rowid")]
                    for t in TABLES}

    def export_json(self):
        return {"format": "revision-tracker", "version": SCHEMA_VERSION,
                "exported_at": datetime.now().isoformat(timespec="seconds"),
                "tables": self.export_tables()}

    def export_csv_zip(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for table, rows in self.export_tables().items():
                zf.writestr(f"{table}.csv", table_to_csv(self, table, rows))
        return buf.getvalue()

    def columns(self, table):
        with self.tx() as con:
            return [r["name"] for r in con.execute(f"PRAGMA table_info({table})")]

    def import_json(self, payload):
        if not isinstance(payload, dict) or payload.get("format") != "revision-tracker":
            raise ValueError("Not a Revision Tracker export file")
        tables = payload.get("tables") or {}
        missing = [t for t in ("chapters",) if not tables.get(t)]
        if missing:
            raise ValueError("Export file has no chapters")
        self.backup(label="pre-import-" + datetime.now().strftime("%Y%m%d-%H%M%S"))
        with self.tx() as con:
            con.execute("PRAGMA foreign_keys = OFF")
            try:
                for t in reversed(TABLES):
                    con.execute(f"DELETE FROM {t}")
                for t in TABLES:
                    self._insert_rows(con, t, tables.get(t) or [])
                bad = con.execute("PRAGMA foreign_key_check").fetchall()
                if bad:
                    raise ValueError(f"Import has {len(bad)} broken references")
                migrate(con)  # an export from an older version may need upgrading
                con.commit()
            except Exception:
                con.rollback()
                raise
            finally:
                con.execute("PRAGMA foreign_keys = ON")

    def import_csv(self, table, text):
        if table not in TABLES:
            raise ValueError(f"Unknown table: {table}")
        rows = list(csv.DictReader(io.StringIO(text.lstrip("﻿"))))
        cols = self.columns(table)
        if rows and set(rows[0].keys()) - set(cols):
            raise ValueError(f"Unexpected columns for {table}: "
                             f"{sorted(set(rows[0].keys()) - set(cols))}")
        rows = [{k: (None if v == "" and k not in TEXT_NOT_NULL.get(table, ()) else v)
                 for k, v in r.items()} for r in rows]
        if table == "chapters" and not rows:
            raise ValueError("chapters.csv is empty")
        self.backup(label="pre-import-" + datetime.now().strftime("%Y%m%d-%H%M%S"))
        with self.tx() as con:
            con.execute("PRAGMA foreign_keys = OFF")
            try:
                con.execute(f"DELETE FROM {table}")
                self._insert_rows(con, table, rows)
                bad = con.execute("PRAGMA foreign_key_check").fetchall()
                if bad:
                    raise ValueError(f"Import has {len(bad)} broken references")
                migrate(con)  # an export from an older version may need upgrading
                con.commit()
            except Exception:
                con.rollback()
                raise
            finally:
                con.execute("PRAGMA foreign_keys = ON")
        return len(rows)

    def _insert_rows(self, con, table, rows):
        cols = [r["name"] for r in con.execute(f"PRAGMA table_info({table})")]
        for row in rows:
            keys = [k for k in row if k in cols]
            con.execute(f"INSERT INTO {table} ({', '.join(keys)}) VALUES "
                        f"({', '.join('?' for _ in keys)})", [row[k] for k in keys])


# Text columns that are NOT NULL: keep empty strings rather than converting to NULL.
TEXT_NOT_NULL = {
    "chapters": ("strand", "book", "title", "sections", "level", "terms", "summary_status",
                 "exercises_status", "examq_status", "notes"),
    "reviews": ("note", "reviewed_on", "created_at"),
    "papers": ("paper_code", "series", "sat_on", "notes"),
    "paper_questions": ("q_num", "error_type", "fix"),
    "boundaries": ("paper_code", "series"),
    "mistakes": ("logged_on", "source", "what_wrong", "correct_method"),
    "settings": ("key", "value"),
}


def table_to_csv(store, table, rows):
    out = io.StringIO()
    w = csv.DictWriter(out, fieldnames=store.columns(table), lineterminator="\n")
    w.writeheader()
    for r in rows:
        w.writerow(r)
    return out.getvalue()


def migrate(con):
    """Bring an older database up to the current schema, keeping all data."""
    cols = [r[1] for r in con.execute("PRAGMA table_info(chapters)")]
    if "first_learnt" not in cols:
        # v1 -> v2: chapters get a 'first learnt' date.
        con.execute("ALTER TABLE chapters ADD COLUMN first_learnt TEXT")
    con.execute("UPDATE chapters SET first_learnt = (SELECT MIN(reviewed_on) FROM reviews "
                "WHERE reviews.chapter_id = chapters.id) WHERE first_learnt IS NULL")
    row = con.execute("SELECT value FROM settings WHERE key = 'priority_weights'").fetchone()
    if row:
        w = json.loads(row[0])
        if "taught" in w:  # the 'taught by school' weight became 'learnt yet'
            w["learnt"] = w.pop("taught")
            con.execute("UPDATE settings SET value = ? WHERE key = 'priority_weights'", (json.dumps(w),))
    con.execute("DELETE FROM settings WHERE key = 'terms'")
    con.execute("INSERT INTO meta(key, value) VALUES ('schema_version', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (str(SCHEMA_VERSION),))


def seed_chapters(con):
    seed = json.loads((Path(__file__).parent / "seed_chapters.json").read_text(encoding="utf-8"))
    for i, c in enumerate(seed):
        con.execute(
            "INSERT INTO chapters (strand, book, ch_num, title, sections, level, terms, sort_order) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (c["strand"], c["book"], c["ch_num"], c["title"], c["sections"], c["level"],
             json.dumps(c["terms"]), i + 1))


def validate_settings(s):
    if "intervals" in s:
        iv = s["intervals"]
        if set(iv.keys()) != {"1", "2", "3", "4", "5"}:
            raise ValueError("Intervals need confidence levels 1-5")
        for v in iv.values():
            if not isinstance(v, int) or not 1 <= v <= 365:
                raise ValueError("Each interval must be a whole number of days, 1-365")
    if "learn_by" in s and s["learn_by"] not in (None, "") and logic.parse_date(s["learn_by"]) is None:
        raise ValueError("Learn-by date must be a date or empty")
    if "exams" in s:
        for e in s["exams"]:
            if not e.get("name") or logic.parse_date(e.get("date")) is None:
                raise ValueError("Each exam needs a name and a date")
    if "papers" in s:
        for p in s["papers"]:
            if not p.get("code") or not isinstance(p.get("max"), (int, float)) or p["max"] <= 0:
                raise ValueError("Each paper needs a code and a positive max mark")
    if "priority_weights" in s:
        w = s["priority_weights"]
        if set(w) != {"confidence", "overdue", "marks", "learnt"}:
            raise ValueError("Priority weights: confidence, overdue, marks, learnt")
        if any(not isinstance(v, (int, float)) or v < 0 for v in w.values()) or sum(w.values()) <= 0:
            raise ValueError("Priority weights must be non-negative and not all zero")
    if "marks_half_point" in s and (not isinstance(s["marks_half_point"], (int, float))
                                    or s["marks_half_point"] <= 0):
        raise ValueError("Marks half-point must be positive")
    if "mistake_retest_days" in s and (not isinstance(s["mistake_retest_days"], int)
                                       or not 1 <= s["mistake_retest_days"] <= 365):
        raise ValueError("Mistake retest gap must be 1-365 days")
    if "theme" in s and s["theme"] not in ("system", "light", "dark"):
        raise ValueError("Theme must be system, light or dark")
    if "open_in" in s and s["open_in"] not in ("app_window", "browser"):
        raise ValueError("open_in must be app_window or browser")
