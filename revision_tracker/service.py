"""Application operations: combine stored rows with the calculations in logic.py."""
from collections import Counter, defaultdict
from datetime import datetime, timedelta

from . import logic
from .db import BOUNDARY_COLS

STATUS_FIELDS = ("summary_status", "exercises_status", "examq_status")


class NotFound(Exception):
    pass


def _chapter_row(row):
    c = dict(row)
    c.pop("terms", None)  # school teaching terms are no longer used
    return c


def _loss_stats(con):
    """marks lost per chapter and most common error type per chapter."""
    lost = defaultdict(float)
    errors = defaultdict(Counter)
    for r in con.execute("SELECT chapter_id, marks_lost, error_type FROM paper_questions "
                         "WHERE chapter_id IS NOT NULL"):
        lost[r["chapter_id"]] += r["marks_lost"] or 0
        if r["error_type"]:
            errors[r["chapter_id"]][r["error_type"]] += r["marks_lost"] or 1
    top = {cid: cnt.most_common(1)[0][0] for cid, cnt in errors.items() if cnt}
    return lost, top


def list_chapters(store, today):
    settings = store.settings()
    with store.tx() as con:
        rows = [_chapter_row(r) for r in con.execute("SELECT * FROM chapters ORDER BY sort_order, id")]
        last = {r["chapter_id"]: (r["last"], r["n"]) for r in con.execute(
            "SELECT chapter_id, MAX(reviewed_on) AS last, COUNT(*) AS n FROM reviews GROUP BY chapter_id")}
        lost, top_err = _loss_stats(con)
    out = []
    for c in rows:
        last_on, n = last.get(c["id"], (None, 0))
        out.append(enrich(c, last_on, n, lost.get(c["id"], 0.0), top_err.get(c["id"]), settings, today))
    return out


def enrich(c, last_on, n_reviews, marks_lost, top_error, settings, today):
    learnt = c["first_learnt"] is not None
    anchor = logic.schedule_anchor(last_on, c["first_learnt"])
    due, _ = logic.is_due(anchor, c["confidence"], learnt, settings["intervals"], today)
    nxt = logic.next_review(anchor, c["confidence"], settings["intervals"]) if learnt else None
    pr = logic.priority(c["confidence"], anchor, learnt, marks_lost, settings, today)
    return {
        **c,
        "learnt": learnt,
        "days_since_learnt": logic.days_since(c["first_learnt"], today),
        "last_reviewed": last_on,
        "review_count": n_reviews,
        "days_since": logic.days_since(last_on, today),
        "next_review": logic.iso(nxt),
        "days_until_review": None if nxt is None else (nxt - today).days,
        "due": due,
        "marks_lost": round(marks_lost, 1),
        "top_error": top_error,
        "priority": pr["score"],
        "priority_parts": pr["components"],
        "weakness": logic.weakness(c["confidence"], marks_lost, settings),
    }


def get_chapter(store, chapter_id, today):
    for c in list_chapters(store, today):
        if c["id"] == chapter_id:
            return c
    raise NotFound("chapter")


def update_chapter(store, chapter_id, data, today):
    fields = {}
    for k in STATUS_FIELDS:
        if k in data:
            if data[k] not in logic.STATUSES:
                raise ValueError(f"{k} must be one of {logic.STATUSES}")
            fields[k] = data[k]
    if "confidence" in data:
        v = data["confidence"]
        if v is not None and (not isinstance(v, int) or not 1 <= v <= 5):
            raise ValueError("confidence must be 1-5 or empty")
        fields["confidence"] = v
    if "notes" in data:
        fields["notes"] = str(data["notes"])
    if "first_learnt" in data:
        fields["first_learnt"] = data["first_learnt"]
    if not fields:
        raise ValueError("Nothing to update")
    with store.tx() as con:
        if "first_learnt" in fields:
            fields["first_learnt"] = _check_first_learnt(con, chapter_id, fields["first_learnt"], today)
        cur = con.execute(f"UPDATE chapters SET {', '.join(k + ' = ?' for k in fields)} WHERE id = ?",
                          [*fields.values(), chapter_id])
        if cur.rowcount == 0:
            raise NotFound("chapter")
    return get_chapter(store, chapter_id, today)


def _check_first_learnt(con, chapter_id, value, today):
    first_review = con.execute("SELECT MIN(reviewed_on) FROM reviews WHERE chapter_id = ?",
                               (chapter_id,)).fetchone()[0]
    if value in (None, ""):
        if first_review:
            raise ValueError("You've already reviewed this chapter, so it can't be marked as not learnt. "
                             "Undo its reviews first.")
        return None
    try:
        d = logic.parse_date(value)
    except ValueError:
        raise ValueError("First learnt must be a date")
    if d > today:
        raise ValueError("First learnt can't be in the future")
    if first_review and d.isoformat() > first_review:
        raise ValueError(f"First learnt must be on or before your first review ({first_review})")
    return d.isoformat()


def mark_learnt(store, chapter_id, confidence, today):
    """'Learnt today': stamp today's date as the day you first learnt it, with a confidence
    rating that sets when the first review is due."""
    if not isinstance(confidence, int) or not 1 <= confidence <= 5:
        raise ValueError("confidence must be 1-5")
    with store.tx() as con:
        row = con.execute("SELECT first_learnt FROM chapters WHERE id = ?", (chapter_id,)).fetchone()
        if row is None:
            raise NotFound("chapter")
        if row["first_learnt"]:
            raise ValueError(f"Already marked as learnt on {row['first_learnt']}")
        con.execute("UPDATE chapters SET first_learnt = ?, confidence = ? WHERE id = ?",
                    (today.isoformat(), confidence, chapter_id))
    return get_chapter(store, chapter_id, today)


def review_chapter(store, chapter_id, confidence, note, today):
    """'Reviewed today': stamp today's date, log it, and set the new confidence."""
    if not isinstance(confidence, int) or not 1 <= confidence <= 5:
        raise ValueError("confidence must be 1-5")
    with store.tx() as con:
        row = con.execute("SELECT confidence FROM chapters WHERE id = ?", (chapter_id,)).fetchone()
        if row is None:
            raise NotFound("chapter")
        con.execute("INSERT INTO reviews (chapter_id, reviewed_on, confidence_before, confidence_after,"
                    " note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (chapter_id, today.isoformat(), row["confidence"], confidence, note or "",
                     datetime.now().isoformat(timespec="seconds")))
        con.execute("UPDATE chapters SET confidence = ? WHERE id = ?", (confidence, chapter_id))
        # Reviewing a chapter you hadn't marked as learnt means you've learnt it by now.
        con.execute("UPDATE chapters SET first_learnt = ? WHERE id = ? AND first_learnt IS NULL",
                    (today.isoformat(), chapter_id))
    return get_chapter(store, chapter_id, today)


def delete_review(store, review_id, today):
    """Remove a review logged by mistake. If it was the latest review for its chapter the
    chapter's confidence goes back to what it was before."""
    with store.tx() as con:
        r = con.execute("SELECT * FROM reviews WHERE id = ?", (review_id,)).fetchone()
        if r is None:
            raise NotFound("review")
        latest = con.execute("SELECT id FROM reviews WHERE chapter_id = ? ORDER BY reviewed_on DESC, id DESC"
                             " LIMIT 1", (r["chapter_id"],)).fetchone()
        con.execute("DELETE FROM reviews WHERE id = ?", (review_id,))
        if latest and latest["id"] == review_id:
            con.execute("UPDATE chapters SET confidence = ? WHERE id = ?",
                        (r["confidence_before"], r["chapter_id"]))
    return get_chapter(store, r["chapter_id"], today)


def chapter_history(store, chapter_id, today):
    chapter = get_chapter(store, chapter_id, today)
    with store.tx() as con:
        reviews = [dict(r) for r in con.execute(
            "SELECT * FROM reviews WHERE chapter_id = ? ORDER BY reviewed_on DESC, id DESC", (chapter_id,))]
        questions = [dict(r) for r in con.execute(
            "SELECT q.*, p.paper_code, p.series, p.sat_on FROM paper_questions q JOIN papers p "
            "ON p.id = q.paper_id WHERE q.chapter_id = ? ORDER BY p.sat_on DESC", (chapter_id,))]
        mistakes = [dict(r) for r in con.execute(
            "SELECT * FROM mistakes WHERE chapter_id = ? ORDER BY logged_on DESC, id DESC", (chapter_id,))]
    return {"chapter": chapter, "reviews": reviews, "questions": questions, "mistakes": mistakes}


# ---------------------------------------------------------------- due list

def due_list(store, today):
    chapters = [c for c in list_chapters(store, today) if c["due"]]
    chapters.sort(key=lambda c: (-c["priority"], c["next_review"] or "", c["sort_order"]))
    with store.tx() as con:
        retests = [dict(r) for r in con.execute(
            "SELECT m.*, c.title AS chapter_title, c.strand AS chapter_strand FROM mistakes m "
            "LEFT JOIN chapters c ON c.id = m.chapter_id WHERE m.retest_passed = 0 "
            "AND m.retest_on IS NOT NULL AND m.retest_on <= ? ORDER BY m.retest_on, m.id",
            (today.isoformat(),))]
    for m in retests:
        m["days_overdue"] = (today - logic.parse_date(m["retest_on"])).days
    everything = list_chapters(store, today)
    upcoming = sorted((c for c in everything
                       if not c["due"] and c["days_until_review"] is not None and c["days_until_review"] <= 7),
                      key=lambda c: c["days_until_review"])
    # Next chapter to learn in each book (book order), for when little is due.
    next_up = {}
    for c in sorted(everything, key=lambda c: c["sort_order"]):
        if not c["learnt"] and c["book"] not in next_up:
            next_up[c["book"]] = c
    return {"chapters": chapters, "retests": retests, "upcoming": upcoming[:10],
            "next_to_learn": list(next_up.values())}


# ---------------------------------------------------------------- papers

def _paper_cfg(settings):
    return {p["code"]: p for p in settings["papers"]}


def _boundary_map(con):
    out = {}
    for r in con.execute("SELECT * FROM boundaries"):
        out[(r["paper_code"], r["series"])] = {g: r[col] for g, col in BOUNDARY_COLS.items()}
    return out


def list_papers(store, today):
    with store.tx() as con:
        papers = [dict(r) for r in con.execute("SELECT * FROM papers ORDER BY sat_on DESC, id DESC")]
        bmap = _boundary_map(con)
        qs = defaultdict(list)
        for q in con.execute("SELECT q.*, c.title AS chapter_title FROM paper_questions q "
                             "LEFT JOIN chapters c ON c.id = q.chapter_id ORDER BY q.id"):
            qs[q["paper_id"]].append(dict(q))
    for p in papers:
        p["percent"] = logic.percent(p["mark"], p["max_mark"])
        b = bmap.get((p["paper_code"], p["series"]))
        p["grade"] = logic.grade_for(p["mark"], b)
        p["has_boundaries"] = b is not None
        p["questions"] = qs.get(p["id"], [])
        p["marks_lost_logged"] = round(sum(q["marks_lost"] for q in p["questions"]), 1)
    return papers


def _paper_fields(data, settings, partial=False):
    cfg = _paper_cfg(settings)
    f = {}
    if "paper_code" in data or not partial:
        code = data.get("paper_code")
        if code not in cfg:
            raise ValueError("Pick a paper from the list")
        f["paper_code"] = code
    if "series" in data or not partial:
        series = str(data.get("series") or "").strip()
        if not series:
            raise ValueError("Series/year is required (e.g. June 2019)")
        f["series"] = series
    if "sat_on" in data or not partial:
        d = logic.parse_date(data.get("sat_on"))
        if d is None:
            raise ValueError("Date sat is required")
        f["sat_on"] = d.isoformat()
    if "max_mark" in data or not partial:
        mx = data.get("max_mark")
        if mx in (None, ""):
            mx = cfg[f.get("paper_code") or data.get("paper_code")]["max"] if (
                f.get("paper_code") or data.get("paper_code")) in cfg else None
        if not isinstance(mx, (int, float)) or mx <= 0:
            raise ValueError("Max mark must be positive")
        f["max_mark"] = mx
    if "mark" in data or not partial:
        m = data.get("mark")
        if m in ("", None):
            m = None
        elif not isinstance(m, (int, float)) or m < 0:
            raise ValueError("Mark must be a number ≥ 0")
        f["mark"] = m
    if "time_taken_min" in data:
        t = data.get("time_taken_min")
        if t in ("", None):
            t = None
        elif not isinstance(t, int) or t < 0:
            raise ValueError("Time taken must be whole minutes")
        f["time_taken_min"] = t
    if "notes" in data:
        f["notes"] = str(data["notes"] or "")
    if f.get("mark") is not None and f.get("max_mark") is not None and f["mark"] > f["max_mark"]:
        raise ValueError("Mark can't be more than the max mark")
    return f


def create_paper(store, data, today):
    f = _paper_fields(data, store.settings())
    with store.tx() as con:
        cur = con.execute(f"INSERT INTO papers ({', '.join(f)}) VALUES ({', '.join('?' for _ in f)})",
                          list(f.values()))
        pid = cur.lastrowid
    return _one_paper(store, pid, today)


def update_paper(store, paper_id, data, today):
    f = _paper_fields(data, store.settings(), partial=True)
    if not f:
        raise ValueError("Nothing to update")
    with store.tx() as con:
        cur = con.execute(f"UPDATE papers SET {', '.join(k + ' = ?' for k in f)} WHERE id = ?",
                          [*f.values(), paper_id])
        if cur.rowcount == 0:
            raise NotFound("paper")
        row = con.execute("SELECT mark, max_mark FROM papers WHERE id = ?", (paper_id,)).fetchone()
        if row["mark"] is not None and row["mark"] > row["max_mark"]:
            raise ValueError("Mark can't be more than the max mark")
    return _one_paper(store, paper_id, today)


def _one_paper(store, paper_id, today):
    for p in list_papers(store, today):
        if p["id"] == paper_id:
            return p
    raise NotFound("paper")


def delete_row(store, table, row_id):
    assert table in ("papers", "paper_questions", "mistakes", "boundaries")
    with store.tx() as con:
        if con.execute(f"DELETE FROM {table} WHERE id = ?", (row_id,)).rowcount == 0:
            raise NotFound(table)


def _question_fields(data, con, partial=False):
    f = {}
    if "q_num" in data or not partial:
        f["q_num"] = str(data.get("q_num") or "").strip()
        if not f["q_num"]:
            raise ValueError("Question number is required")
    if "chapter_id" in data or not partial:
        cid = data.get("chapter_id")
        if cid is None or con.execute("SELECT 1 FROM chapters WHERE id = ?", (cid,)).fetchone() is None:
            raise ValueError("Pick the chapter this question tests")
        f["chapter_id"] = cid
    if "marks_lost" in data or not partial:
        m = data.get("marks_lost")
        if not isinstance(m, (int, float)) or m < 0:
            raise ValueError("Marks lost must be a number ≥ 0")
        f["marks_lost"] = m
    if "error_type" in data or not partial:
        e = data.get("error_type") or ""
        if e not in logic.ERROR_TYPES:
            raise ValueError(f"Error type must be one of: {', '.join(logic.ERROR_TYPES)}")
        f["error_type"] = e
    if "fix" in data:
        f["fix"] = str(data["fix"] or "")
    return f


def add_question(store, paper_id, data):
    with store.tx() as con:
        if con.execute("SELECT 1 FROM papers WHERE id = ?", (paper_id,)).fetchone() is None:
            raise NotFound("paper")
        f = _question_fields(data, con)
        f["paper_id"] = paper_id
        cur = con.execute(f"INSERT INTO paper_questions ({', '.join(f)}) VALUES "
                          f"({', '.join('?' for _ in f)})", list(f.values()))
        return dict(con.execute("SELECT * FROM paper_questions WHERE id = ?", (cur.lastrowid,)).fetchone())


def update_question(store, qid, data):
    with store.tx() as con:
        f = _question_fields(data, con, partial=True)
        if not f:
            raise ValueError("Nothing to update")
        if con.execute(f"UPDATE paper_questions SET {', '.join(k + ' = ?' for k in f)} WHERE id = ?",
                       [*f.values(), qid]).rowcount == 0:
            raise NotFound("question")
        return dict(con.execute("SELECT * FROM paper_questions WHERE id = ?", (qid,)).fetchone())


def list_boundaries(store):
    with store.tx() as con:
        return [dict(r) for r in con.execute("SELECT * FROM boundaries ORDER BY paper_code, series")]


def upsert_boundary(store, data):
    settings = store.settings()
    code = data.get("paper_code")
    cfg = _paper_cfg(settings)
    if code not in cfg:
        raise ValueError("Pick a paper from the list")
    series = str(data.get("series") or "").strip()
    if not series:
        raise ValueError("Series is required")
    vals = {}
    prev = None
    for g, col in BOUNDARY_COLS.items():
        v = data.get(col)
        if v in ("", None):
            vals[col] = None
            continue
        if not isinstance(v, (int, float)) or not 0 <= v <= cfg[code]["max"]:
            raise ValueError(f"{g} boundary must be between 0 and {cfg[code]['max']}")
        if prev is not None and v > prev:
            raise ValueError("Boundaries must go down from A* to E")
        prev = v
        vals[col] = v
    if all(v is None for v in vals.values()):
        raise ValueError("Enter at least one boundary")
    with store.tx() as con:
        con.execute(
            "INSERT INTO boundaries (paper_code, series, a_star, a, b, c, d, e) VALUES (?,?,?,?,?,?,?,?) "
            "ON CONFLICT(paper_code, series) DO UPDATE SET a_star=excluded.a_star, a=excluded.a, "
            "b=excluded.b, c=excluded.c, d=excluded.d, e=excluded.e",
            (code, series, *vals.values()))
        return dict(con.execute("SELECT * FROM boundaries WHERE paper_code = ? AND series = ?",
                                (code, series)).fetchone())


def paper_chart(store, today):
    """Percentage over time per paper type, plus the mean A* boundary % for that paper."""
    settings = store.settings()
    cfg = _paper_cfg(settings)
    papers = list_papers(store, today)
    with store.tx() as con:
        bounds = [dict(r) for r in con.execute("SELECT paper_code, a_star FROM boundaries "
                                               "WHERE a_star IS NOT NULL")]
    series = []
    for code, p in cfg.items():
        pts = sorted(({"date": x["sat_on"], "percent": x["percent"], "series": x["series"],
                       "grade": x["grade"]} for x in papers
                      if x["paper_code"] == code and x["percent"] is not None), key=lambda d: d["date"])
        astars = [b["a_star"] / p["max"] * 100 for b in bounds if b["paper_code"] == code]
        series.append({
            "code": code, "name": p["name"], "points": pts,
            "a_star_percent": round(sum(astars) / len(astars), 1) if astars else None,
            "a_star_series_count": len(astars),
            "average": round(sum(x["percent"] for x in pts) / len(pts), 1) if pts else None,
        })
    return series


# ---------------------------------------------------------------- mistakes

def list_mistakes(store, today):
    with store.tx() as con:
        rows = [dict(r) for r in con.execute(
            "SELECT m.*, c.title AS chapter_title, c.strand AS chapter_strand FROM mistakes m "
            "LEFT JOIN chapters c ON c.id = m.chapter_id ORDER BY m.logged_on DESC, m.id DESC")]
    for m in rows:
        d = logic.parse_date(m["retest_on"])
        m["retest_due"] = bool(not m["retest_passed"] and d is not None and d <= today)
    return rows


def _mistake_fields(data, con, settings, today, partial=False):
    f = {}
    if "chapter_id" in data or not partial:
        cid = data.get("chapter_id")
        if cid is None or con.execute("SELECT 1 FROM chapters WHERE id = ?", (cid,)).fetchone() is None:
            raise ValueError("Pick a chapter")
        f["chapter_id"] = cid
    for k in ("source", "what_wrong", "correct_method"):
        if k in data:
            f[k] = str(data[k] or "")
    if not partial and not f.get("what_wrong", "").strip():
        raise ValueError("Say what went wrong")
    if "retest_on" in data:
        d = logic.parse_date(data["retest_on"]) if data["retest_on"] else None
        f["retest_on"] = logic.iso(d)
    elif not partial:
        f["retest_on"] = (today + timedelta(days=int(settings["mistake_retest_days"]))).isoformat()
    return f


def create_mistake(store, data, today):
    settings = store.settings()
    with store.tx() as con:
        f = _mistake_fields(data, con, settings, today)
        f["logged_on"] = today.isoformat()
        cur = con.execute(f"INSERT INTO mistakes ({', '.join(f)}) VALUES ({', '.join('?' for _ in f)})",
                          list(f.values()))
        mid = cur.lastrowid
    return _one_mistake(store, mid, today)


def update_mistake(store, mid, data, today):
    settings = store.settings()
    with store.tx() as con:
        f = _mistake_fields(data, con, settings, today, partial=True)
        if not f:
            raise ValueError("Nothing to update")
        if con.execute(f"UPDATE mistakes SET {', '.join(k + ' = ?' for k in f)} WHERE id = ?",
                       [*f.values(), mid]).rowcount == 0:
            raise NotFound("mistake")
    return _one_mistake(store, mid, today)


def retest_mistake(store, mid, passed, today):
    """Record a retest: passed -> ticked off; not passed -> retest again after the usual gap."""
    settings = store.settings()
    with store.tx() as con:
        if con.execute("SELECT 1 FROM mistakes WHERE id = ?", (mid,)).fetchone() is None:
            raise NotFound("mistake")
        if passed:
            con.execute("UPDATE mistakes SET retest_passed = 1, passed_on = ? WHERE id = ?",
                        (today.isoformat(), mid))
        else:
            nxt = today + timedelta(days=int(settings["mistake_retest_days"]))
            con.execute("UPDATE mistakes SET retest_passed = 0, passed_on = NULL, retest_on = ? "
                        "WHERE id = ?", (nxt.isoformat(), mid))
    return _one_mistake(store, mid, today)


def _one_mistake(store, mid, today):
    for m in list_mistakes(store, today):
        if m["id"] == mid:
            return m
    raise NotFound("mistake")


# ---------------------------------------------------------------- dashboard

def dashboard(store, today):
    settings = store.settings()
    chapters = list_chapters(store, today)
    with store.tx() as con:
        review_dates = [r[0] for r in con.execute("SELECT reviewed_on FROM reviews")]
        open_retests = con.execute("SELECT COUNT(*) FROM mistakes WHERE retest_passed = 0").fetchone()[0]

    def group(key_fn, keys):
        out = []
        for k in keys:
            cs = [c for c in chapters if k in key_fn(c)]
            rated = [c["confidence"] for c in cs if c["confidence"] is not None]
            out.append({
                "name": k, "chapters": len(cs),
                "summary_done": sum(c["summary_status"] == "done" for c in cs),
                "exercises_done": sum(c["exercises_status"] == "done" for c in cs),
                "examq_done": sum(c["examq_status"] == "done" for c in cs),
                "learnt": sum(c["learnt"] for c in cs),
                "avg_confidence": round(sum(rated) / len(rated), 1) if rated else None,
                "weak": sum(1 for r in rated if r <= 2),
                "due": sum(c["due"] for c in cs),
            })
        return out

    strands = list(dict.fromkeys(c["strand"] for c in chapters))
    weakest = sorted((c for c in chapters if c["weakness"] is not None),
                     key=lambda c: (-c["weakness"], c["sort_order"]))[:10]
    return {
        "today": today.isoformat(),
        "by_strand": group(lambda c: [c["strand"]], strands),
        "by_book": group(lambda c: [c["book"]], list(dict.fromkeys(c["book"] for c in chapters))),
        "pace": logic.learning_pace([c["first_learnt"] for c in chapters], today, logic.learn_target(settings)),
        "weakest": [{k: c[k] for k in ("id", "title", "strand", "book", "ch_num", "confidence",
                                       "marks_lost", "top_error", "weakness", "priority")}
                    for c in weakest],
        "streak": logic.review_streak(review_dates, today),
        "reviews_this_week": logic.reviews_this_week(review_dates, today),
        "reviews_total": len(review_dates),
        "due_count": sum(c["due"] for c in chapters),
        "open_retests": open_retests,
        "countdown": logic.countdown(settings["exams"], today),
        "totals": {
            "chapters": len(chapters),
            "exercises_done": sum(c["exercises_status"] == "done" for c in chapters),
            "rated": sum(c["confidence"] is not None for c in chapters),
        },
        "papers": paper_chart(store, today),
    }
