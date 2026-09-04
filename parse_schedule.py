#!/usr/bin/env python3
"""Convert the ENGR101 office hours Excel schedule into schedule.json."""

import json
import sys
from datetime import time
from pathlib import Path

try:
    import openpyxl
except ImportError:
    raise SystemExit("Install openpyxl: pip install openpyxl")

DEFAULT_XLSX = Path.home() / "Downloads/F26 Lab and Office Hours Schedule + Attendance.xlsx"
OUT = Path(__file__).resolve().parent / "schedule.json"
DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
OH_COLS = range(10, 16)
TOTAL_COL = 16


def parse_schedule(xlsx_path: Path) -> dict:
    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    ws = wb["The ScheduleTM"]
    schedule = {}

    for day in DAYS:
        start = next((r + 1 for r in range(1, ws.max_row + 1) if ws.cell(r, 1).value == day), None)
        if not start:
            continue

        end = ws.max_row + 1
        for r in range(start, ws.max_row + 1):
            if ws.cell(r, 1).value in DAYS:
                end = r
                break

        slots = []
        for r in range(start, end):
            slot_time = ws.cell(r, 1).value
            if not isinstance(slot_time, time):
                continue

            staff = []
            for col in OH_COLS:
                value = ws.cell(r, col).value
                if (
                    value
                    and isinstance(value, str)
                    and value.strip()
                    and "Slot" not in value
                    and value != "STAFF MEETING"
                ):
                    staff.append(value.strip())

            total = ws.cell(r, TOTAL_COL).value
            if staff or total:
                slots.append(
                    {
                        "time": slot_time.strftime("%H:%M"),
                        "staff": staff,
                        "total": int(total) if total else len(staff),
                    }
                )

        schedule[day.lower()] = slots

    return {
        "source": xlsx_path.name,
        "timezone": "America/Detroit",
        "schedule": schedule,
    }


def main():
    xlsx = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_XLSX
    if not xlsx.is_file():
        raise SystemExit(f"Schedule file not found: {xlsx}")

    OUT.write_text(json.dumps(parse_schedule(xlsx), indent=2))
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
