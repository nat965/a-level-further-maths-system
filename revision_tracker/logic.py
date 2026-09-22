"""Pure calculation logic: dates, spaced repetition, school schedule, priority.

Everything here is side-effect free and takes ``today`` explicitly so it can be
unit-tested without touching the clock or the database.
"""
from datetime import date, timedelta

STATUSES = ("not_started", "in_progress", "done")
ERROR_TYPES = ("conceptual", "method", "algebra slip", "misread", "time", "presentation")
GRADES = ("A*", "A", "B", "C", "D", "E")

DEFAULT_SETTINGS = {
    # Days until the next review, keyed by confidence (1 = shaky, 5 = exam-ready).
    "intervals": {"1": 3, "2": 7, "3": 14, "4": 30, "5": 60},
    # School terms. Estimated from typical English school calendars; edit in Settings.
    "terms": [
        {"name": "Autumn Y12", "start": "2026-09-02", "end": "2026-12-18"},
        {"name": "Spring Y12", "start": "2027-01-04", "end": "2027-03-26"},
        {"name": "Summer Y12", "start": "2027-04-12", "end": "2027-07-21"},
        {"name": "Autumn Y13", "start": "2027-09-01", "end": "2027-12-17"},
        {"name": "Spring Y13", "start": "2028-01-04", "end": "2028-04-07"},
    ],
    # The June 2028 timetable is not published yet: these are placeholders.
    "exams": [
        {"name": "Further Maths Y540 Pure Core 1", "date": "2028-05-17", "confirmed": False},
        {"name": "Further Maths Y541 Pure Core 2", "date": "2028-05-24", "confirmed": False},
        {"name": "Maths H240/01 Pure Mathematics", "date": "2028-06-06", "confirmed": False},
        {"name": "Further Maths Y542 Statistics", "date": "2028-06-09", "confirmed": False},
        {"name": "Maths H240/02 Pure & Statistics", "date": "2028-06-13", "confirmed": False},
        {"name": "Further Maths Y543 Mechanics", "date": "2028-06-16", "confirmed": False},
        {"name": "Maths H240/03 Pure & Mechanics", "date": "2028-06-20", "confirmed": False},
    ],
    # H240 papers are 100 marks (OCR H240 specification). Y54x assumed 75 marks: check.
    "papers": [
        {"code": "H240/01", "name": "Pure Mathematics", "max": 100},
        {"code": "H240/02", "name": "Pure Mathematics and Statistics", "max": 100},
        {"code": "H240/03", "name": "Pure Mathematics and Mechanics", "max": 100},
        {"code": "Y540", "name": "Pure Core 1", "max": 75},
        {"code": "Y541", "name": "Pure Core 2", "max": 75},
        {"code": "Y542", "name": "Statistics", "max": 75},
        {"code": "Y543", "name": "Mechanics", "max": 75},
    ],
    # Relative weights of the four priority components (any positive numbers).
    "priority_weights": {"confidence": 35, "overdue": 25, "marks": 25, "taught": 15},
    # Marks lost at which the "marks lost" component reaches 0.5 (it saturates towards 1).
    "marks_half_point": 8,
    # Default gap before retesting a logged mistake.
    "mistake_retest_days": 7,
    "theme": "system",
    "open_in": "app_window",
}


# ---------------------------------------------------------------- dates

def parse_date(value):
    """ISO string / date / None -> date or None."""
    if value in (None, ""):
        return None
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def iso(d):
    return d.isoformat() if d else None


def days_since(last_reviewed, today):
    last = parse_date(last_reviewed)
    return None if last is None else (today - last).days


def interval_for(confidence, intervals):
    if confidence is None:
        return None
    return int(intervals[str(int(confidence))])


def next_review(last_reviewed, confidence, intervals):
    """Next review date = last review + interval for the current confidence."""
    last = parse_date(last_reviewed)
    gap = interval_for(confidence, intervals)
    if last is None or gap is None:
        return None
    return last + timedelta(days=gap)


# ---------------------------------------------------------------- school schedule

def _term_map(terms_cfg):
    return {t["name"]: (parse_date(t["start"]), parse_date(t["end"])) for t in terms_cfg}


def chapter_window(chapter_terms, terms_cfg):
    """(start of first term, start of last term, end of last term) for a chapter."""
    tm = _term_map(terms_cfg)
    spans = [tm[t] for t in chapter_terms if t in tm]
    if not spans:
        return None
    last = max(spans, key=lambda s: s[1])
    return min(s[0] for s in spans), last[0], last[1]


def taught_status(chapter_terms, terms_cfg, today):
    """'taught' once its (last) term has ended, 'in_progress' once its first term has
    started, otherwise 'not_yet'."""
    win = chapter_window(chapter_terms, terms_cfg)
    if win is None:
        return "not_yet"
    first_start, _, last_end = win
    if today > last_end:
        return "taught"
    if today >= first_start:
        return "in_progress"
    return "not_yet"


def expected_fraction(chapter_terms, terms_cfg, today):
    """How much of this chapter school should have finished by today (0..1), pro-rating
    the chapter's final term linearly."""
    win = chapter_window(chapter_terms, terms_cfg)
    if win is None:
        return 0.0
    _, start, end = win
    if today >= end:
        return 1.0
    if today < start:
        return 0.0
    return (today - start).days / max(1, (end - start).days)


def schedule_position(chapters, terms_cfg, today):
    """Compare chapters covered (exercises done) with where school should be.

    ``chapters``: iterable of dicts with ``terms`` (list) and ``exercises_status``.
    Returns overall figures and a per-term breakdown (multi-term chapters count in
    each of their terms, like the original spreadsheet).
    """
    chapters = list(chapters)
    expected = sum(expected_fraction(c["terms"], terms_cfg, today) for c in chapters)
    covered = sum(1 for c in chapters if c["exercises_status"] == "done")
    per_term = []
    for t in terms_cfg:
        in_term = [c for c in chapters if t["name"] in c["terms"]]
        start, end = parse_date(t["start"]), parse_date(t["end"])
        if today > end:
            state, frac = "finished", 1.0
        elif today >= start:
            state, frac = "current", (today - start).days / max(1, (end - start).days)
        else:
            state, frac = "upcoming", 0.0
        done = sum(1 for c in in_term if c["exercises_status"] == "done")
        exp = round(frac * len(in_term), 1)
        per_term.append({"term": t["name"], "state": state, "chapters": len(in_term),
                         "covered": done, "expected": exp, "diff": round(done - exp, 1)})
    diff = round(covered - expected, 1)
    if diff >= 0.5:
        verdict = "ahead"
    elif diff <= -0.5:
        verdict = "behind"
    else:
        verdict = "on track"
    return {"covered": covered, "expected": round(expected, 1), "diff": diff,
            "verdict": verdict, "per_term": per_term}


# ---------------------------------------------------------------- priority

def _clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def is_due(last_reviewed, confidence, taught, intervals, today):
    """Due if the next review date has passed, or school has taught it and it has never
    been reviewed. Returns (due: bool, due_date: date|None)."""
    nxt = next_review(last_reviewed, confidence, intervals)
    if nxt is not None:
        return nxt <= today, nxt
    if parse_date(last_reviewed) is None and taught == "taught":
        return True, None
    return False, None


def priority(confidence, last_reviewed, taught, marks_lost, settings, today):
    """Priority score 0..100 (higher = work on it sooner) plus its components (0..1).

    confidence: low confidence -> high. Unrated counts as 1.
    overdue:    days past the next review date / that interval (capped at 1). A chapter
                school has taught but you have never reviewed counts as fully overdue.
    marks:      marks lost in past papers, m / (m + half_point), saturating to 1.
    taught:     1 if school has finished it, 0.5 if its term is running, 0 if not yet.
    """
    intervals = settings["intervals"]
    conf_c = 1.0 if confidence is None else _clamp((5 - int(confidence)) / 4)

    nxt = next_review(last_reviewed, confidence, intervals)
    if nxt is not None:
        late = (today - nxt).days
        overdue_c = _clamp(late / interval_for(confidence, intervals)) if late > 0 else 0.0
    elif parse_date(last_reviewed) is None and taught == "taught":
        overdue_c = 1.0
    else:
        overdue_c = 0.0

    half = float(settings.get("marks_half_point", 8)) or 8.0
    m = max(0.0, float(marks_lost or 0))
    marks_c = m / (m + half)

    taught_c = {"taught": 1.0, "in_progress": 0.5}.get(taught, 0.0)

    w = settings["priority_weights"]
    total_w = sum(float(v) for v in w.values()) or 1.0
    raw = (float(w["confidence"]) * conf_c + float(w["overdue"]) * overdue_c
           + float(w["marks"]) * marks_c + float(w["taught"]) * taught_c)
    return {
        "score": round(100 * raw / total_w, 1),
        "components": {"confidence": round(conf_c, 3), "overdue": round(overdue_c, 3),
                       "marks": round(marks_c, 3), "taught": taught_c},
    }


def weakness(confidence, marks_lost, settings):
    """Score for the 'weakest chapters' list: only meaningful once a chapter has been
    rated or has lost marks. Returns None otherwise."""
    if confidence is None and not marks_lost:
        return None
    conf_c = 0.5 if confidence is None else (5 - int(confidence)) / 4
    half = float(settings.get("marks_half_point", 8)) or 8.0
    m = max(0.0, float(marks_lost or 0))
    return round(100 * (0.6 * conf_c + 0.4 * m / (m + half)), 1)


# ---------------------------------------------------------------- papers

def grade_for(mark, boundaries):
    """Highest grade whose raw-mark boundary the mark reaches. ``boundaries`` maps grade
    ('A*', 'A', ...) to a raw mark or None. Returns None if no boundaries are entered."""
    if mark is None or not boundaries:
        return None
    entered = [(g, boundaries.get(g)) for g in GRADES if boundaries.get(g) is not None]
    if not entered:
        return None
    for g, b in entered:
        if float(mark) >= float(b):
            return g
    return "U"


def percent(mark, max_mark):
    if mark is None or not max_mark:
        return None
    return round(100.0 * float(mark) / float(max_mark), 1)


# ---------------------------------------------------------------- habits

def review_streak(review_dates, today):
    """Consecutive days with at least one review, ending today (or yesterday if nothing
    has been reviewed yet today, so the streak isn't shown as broken mid-morning)."""
    days = {parse_date(d) for d in review_dates}
    cur = today if today in days else today - timedelta(days=1)
    streak = 0
    while cur in days:
        streak += 1
        cur -= timedelta(days=1)
    return streak


def week_start(today):
    return today - timedelta(days=today.weekday())


def reviews_this_week(review_dates, today):
    start = week_start(today)
    return sum(1 for d in review_dates if start <= parse_date(d) <= today)


def countdown(exams, today):
    out = []
    for e in exams:
        d = parse_date(e.get("date"))
        if d is None:
            continue
        out.append({**e, "days": (d - today).days})
    out.sort(key=lambda e: e["date"])
    return out
