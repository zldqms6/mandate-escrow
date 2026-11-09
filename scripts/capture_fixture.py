"""Save Hyperliquid's real answers for a window, page by page, exactly as the
contract requests them (same bodies, same paging), for the tests.
    python scripts/capture_fixture.py <name> <account> <from ISO hour> <to ISO hour>
"""
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HL = "https://api.hyperliquid.xyz/info"
PAGE = {"fills": 2000, "funding": 500}


def post(kind, account, start_ms, end_ms):
    body = {"type": "userFillsByTime" if kind == "fills" else "userFunding",
            "user": account, "startTime": start_ms, "endTime": end_ms}
    req = urllib.request.Request(f"{HL}?{kind}={account}&from={start_ms}", data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json", "user-agent": "mandate-escrow-fixtures"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode()


def pages(kind, account, start_ms, end_ms):
    out, cursor = [], start_ms
    for _ in range(5):
        text = post(kind, account, cursor, end_ms)
        rows = json.loads(text)
        out.append({"from_ms": cursor, "body": text})
        if len(rows) < PAGE[kind]:
            break
        cursor = int(rows[-1]["time"])
        time.sleep(0.5)
    return out


def ts(iso):
    return int(datetime.fromisoformat(iso).replace(tzinfo=timezone.utc).timestamp())


if __name__ == "__main__":
    name, account, a, b = sys.argv[1:5]
    ps, pe = ts(a), ts(b)
    fx = {"account": account.lower(), "from": ps, "to": pe,
          "captured": datetime.now(timezone.utc).isoformat(timespec="seconds"),
          "fills": pages("fills", account.lower(), ps * 1000, pe * 1000 - 1),
          "funding": pages("funding", account.lower(), ps * 1000, pe * 1000 - 1)}
    out = Path(__file__).parent.parent / "tests" / "fixtures" / f"{name}.json"
    out.write_text(json.dumps(fx, indent=1), encoding="utf-8")
    print(name, "fill pages", [len(json.loads(p["body"])) for p in fx["fills"]],
          "funding pages", [len(json.loads(p["body"])) for p in fx["funding"]])
