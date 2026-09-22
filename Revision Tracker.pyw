"""Windows double-click launcher (runs with pythonw, so no console window appears).

Also works on any OS as `python "Revision Tracker.pyw"`.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from revision_tracker.main import main  # noqa: E402

main()
