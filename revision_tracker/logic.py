"""Pure calculation logic: dates, spaced repetition, learning pace, priority.

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
    "priority_weights": {"confidence": 35, "overdue": 25, "marks": 25, "learnt": 15},
    # Marks lost at which the "marks lost" component reaches 0.5 (it saturates towards 1).
    "marks_half_point": 8,
    # Default gap before retesting a logged mistake.
    "mistake_retest_days": 7,
    # Date by which you want to have learnt every chapter (None = your first exam).
    "learn_by": None,
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


def schedule_anchor(last_reviewed, first_learnt):
    """Reviews are scheduled from the last review, or from the day you first learnt the
    chapter if you haven't reviewed it yet."""
    return parse_date(last_reviewed) or parse_date(first_learnt)


def next_review(anchor, confidence, intervals):
    """Next review date = anchor (last review, else first learnt) + interval for the
    current confidence."""
    last = parse_date(anchor)
    gap = interval_for(confidence, intervals)
    if last is None or gap is None:
        return None
    return last + timedelta(days=gap)


# ---------------------------------------------------------------- learning pace

def learn_target(settings):
    """The date to have learnt everything by: the setting, else the first exam."""
    t = parse_date(settings.get("learn_by"))
    if t:
        return t
    exams = [parse_date(e.get("date")) for e in settings.get("exams", [])]
    exams = [d for d in exams if d]
    return min(exams) if exams else None


def learning_pace(first_learnt_dates, today, target, window_days=28):
    """Compare your recent learning pace with the pace needed to learn every chapter by
    ``target``.

    first_learnt_dates: one entry per chapter, a date/ISO string or None if not learnt.
    Recent pace = chapters first learnt in the last ``window_days`` days, per week.
    """
    dates = [parse_date(d) for d in first_learnt_dates]
    total = len(dates)
    learnt = sum(1 for d in dates if d is not None and d <= today)
    remaining = total - learnt
    window_start = today - timedelta(days=window_days - 1)
    recent = sum(1 for d in dates if d is not None and window_start <= d <= today)
    per_week = round(recent * 7 / window_days, 2)
    this_week = sum(1 for d in dates if d is not None and week_start(today) <= d <= today)
    days_left = (target - today).days if target else None
    required = None
    if days_left is not None and days_left > 0 and remaining:
        required = round(remaining * 7 / days_left, 2)
    projected = None
    if remaining and per_week > 0:
        projected = today + timedelta(days=int(-(-remaining * 7 // per_week)))  # ceil

    if remaining == 0:
        verdict = "all learnt"
    elif target is None:
        verdict = "no target"
    elif days_left <= 0:
        verdict = "behind"
    elif learnt == 0:
        verdict = "not started"
    elif per_week >= required * 1.1:
        verdict = "ahead"
    elif per_week >= required * 0.9:
        verdict = "on track"
    else:
        verdict = "behind"
    return {"total": total, "learnt": learnt, "remaining": remaining, "recent": recent,
            "per_week": per_week, "required_per_week": required, "this_week": this_week,
            "target": iso(target), "days_left": days_left, "projected_finish": iso(projected),
            "verdict": verdict}


# ---------------------------------------------------------------- priority

def _clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def is_due(anchor, confidence, learnt, intervals, today):
    """Returns (due, due_date). Chapters you haven't learnt yet are never due. A learnt
    chapter with no confidence rating is due straight away (it needs rating); otherwise
    it's due once its next review date arrives."""
    if not learnt:
        return False, None
    nxt = next_review(anchor, confidence, intervals)
    if nxt is None:
        return True, parse_date(anchor)
    return nxt <= today, nxt


def priority(confidence, anchor, learnt, marks_lost, settings, today):
    """Priority score 0..100 (higher = work on it sooner) plus its components (0..1).

    confidence: low confidence -> high. Unrated counts as 1.
    overdue:    days past the next review date / that interval (capped at 1). A learnt
                chapter with no confidence rating counts as fully overdue.
    marks:      marks lost in past papers, m / (m + half_point), saturating to 1.
    learnt:     1 once you've learnt the chapter, 0 before.
    """
    intervals = settings["intervals"]
    conf_c = 1.0 if confidence is None else _clamp((5 - int(confidence)) / 4)

    nxt = next_review(anchor, confidence, intervals) if learnt else None
    if nxt is not None:
        late = (today - nxt).days
        overdue_c = _clamp(late / interval_for(confidence, intervals)) if late > 0 else 0.0
    elif learnt:
        overdue_c = 1.0
    else:
        overdue_c = 0.0

    half = float(settings.get("marks_half_point", 8)) or 8.0
    m = max(0.0, float(marks_lost or 0))
    marks_c = m / (m + half)

    learnt_c = 1.0 if learnt else 0.0

    w = settings["priority_weights"]
    total_w = sum(float(v) for v in w.values()) or 1.0
    raw = (float(w["confidence"]) * conf_c + float(w["overdue"]) * overdue_c
           + float(w["marks"]) * marks_c + float(w["learnt"]) * learnt_c)
    return {
        "score": round(100 * raw / total_w, 1),
        "components": {"confidence": round(conf_c, 3), "overdue": round(overdue_c, 3),
                       "marks": round(marks_c, 3), "learnt": learnt_c},
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
