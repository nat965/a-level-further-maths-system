"""One-off developer tool: convert the original tracker spreadsheet into seed JSON.

The website never needs openpyxl; it reads web/seed_chapters.json.
Usage: python tools/xlsx_to_seed.py seed/Maths_Further_Maths_Tracker.xlsx
"""
import json
import sys
from pathlib import Path

import openpyxl

HEADERS = ["Strand", "Book", "Ch", "Chapter", "Sections", "Level"]


def main(path):
    ws = openpyxl.load_workbook(path).worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    header_idx = next(i for i, r in enumerate(rows) if r and r[0] == "Strand")
    assert list(rows[header_idx][:6]) == HEADERS, rows[header_idx]
    chapters = []
    for r in rows[header_idx + 1:]:
        if not r[0]:
            continue
        chapters.append({
            "strand": r[0], "book": r[1], "ch_num": int(r[2]), "title": r[3],
            "sections": r[4], "level": r[5],
        })
    out = Path(__file__).resolve().parent.parent / "web" / "seed_chapters.json"
    out.write_text(json.dumps(chapters, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {len(chapters)} chapters to {out}")


if __name__ == "__main__":
    main(sys.argv[1])
