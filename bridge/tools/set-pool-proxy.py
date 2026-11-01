#!/usr/bin/env python3
"""Point every agy pool account at the local unlock proxy.

Why this is a separate step
---------------------------
  Starting the mitmproxy listener is only half the job. Something has to put
  HTTP(S)_PROXY into the environment of the *agy process itself*, and with
  dsh-agy-link that is the plugin, not your shell:

      const effectiveProxy = account?.proxyUrl || cfg.proxyUrl || detectSystemProxy()
      const env = { ...process.env, ...proxyEnvFor(effectiveProxy) }

  So the durable lever is `proxyUrl` on each account in

      ~/.dsh/agy-accounts/pool.json

  Without it, `agy` spawned by DSH egresses directly and the CLI prints the
  region wall -- even though the listener is up and a hand-run `agy` inside
  agy-unlock.cmd works fine. That asymmetry is the whole trap.

What this writes
----------------
  proxyUrl = <proxy>   on every account in the pool (primary + backups).
  Backs the file up first, writes atomically, then re-reads and verifies.

Usage
-----
  python set-pool-proxy.py                       # preview, no write
  python set-pool-proxy.py --apply               # write
  python set-pool-proxy.py --apply --proxy http://127.0.0.1:8899
  python set-pool-proxy.py --apply --clear       # undo (remove proxyUrl)

Dry run is the default on purpose: pool.json also holds quota and cooldown
state that a careless write would disturb.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import time

DEFAULT_POOL = os.path.join(os.path.expanduser("~"), ".dsh", "agy-accounts", "pool.json")
DEFAULT_PROXY = "http://127.0.0.1:8899"


def load_pool(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def write_atomic(path: str, data: dict) -> None:
    directory = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".pool.json.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        description="Set or clear proxyUrl for every account in the agy pool."
    )
    ap.add_argument("--pool", default=DEFAULT_POOL, help=f"pool.json path (default: {DEFAULT_POOL})")
    ap.add_argument("--proxy", default=DEFAULT_PROXY, help=f"proxy URL (default: {DEFAULT_PROXY})")
    ap.add_argument("--apply", action="store_true", help="actually write (default is a dry run)")
    ap.add_argument("--clear", action="store_true", help="remove proxyUrl instead of setting it")
    args = ap.parse_args(argv)

    if not os.path.exists(args.pool):
        print(f"ERROR: pool not found: {args.pool}", file=sys.stderr)
        print("       dsh-agy-link creates it on first run. Start DSH once, then retry.", file=sys.stderr)
        return 1

    data = load_pool(args.pool)
    accounts = data.get("accounts") or []
    if not accounts:
        print("ERROR: no accounts in pool.json", file=sys.stderr)
        return 1

    target = None if args.clear else args.proxy
    action = "clear proxyUrl" if args.clear else f"set proxyUrl = {args.proxy}"

    print(f"pool   : {args.pool}")
    print(f"action : {action}")
    print(f"mode   : {'APPLY' if args.apply else 'DRY RUN (pass --apply to write)'}")
    print("")

    changes = 0
    for acc in accounts:
        acc_id = acc.get("id", "?")
        before = acc.get("proxyUrl")
        after = target

        if before == after:
            print(f"  {acc_id:<28} unchanged ({before or 'none'})")
            continue

        changes += 1
        print(f"  {acc_id:<28} {before or '(none)'} -> {after or '(none)'}")
        if args.apply:
            if after is None:
                acc.pop("proxyUrl", None)
            else:
                acc["proxyUrl"] = after

    if changes == 0:
        print("\nNothing to change.")
        return 0

    if not args.apply:
        print(f"\n{changes} account(s) would change. Re-run with --apply.")
        return 0

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = f"{args.pool}.bak-{stamp}"
    shutil.copy2(args.pool, backup)
    write_atomic(args.pool, data)

    # Verify by re-reading from disk, not from the in-memory object.
    check = load_pool(args.pool)
    verified = 0
    for acc in check.get("accounts", []):
        if acc.get("proxyUrl") == target:
            verified += 1

    expected = len(check.get("accounts", [])) if target else verified
    print(f"\nbackup   : {backup}")
    print(f"verified : {verified}/{len(check.get('accounts', []))} accounts match target")

    if target and verified != len(check.get("accounts", [])):
        print("ERROR: verification failed", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
