import argparse
import json
import sys
from pathlib import Path

import httpx

from ember_seed_data.client import SeedError, seed_lahaina
from ember_seed_data.lahaina import lahaina


def main(argv: list[str] | None = None, transport: httpx.BaseTransport | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ember-seed-data")
    sub = parser.add_subparsers(dest="command", required=True)
    cmd = sub.add_parser("lahaina", help="seed the Lahaina demo watch zone")
    cmd.add_argument("--api", help="api base URL, e.g. http://localhost:4001")
    cmd.add_argument("--key", help="operator key sent as a bearer token")
    cmd.add_argument("--out", type=Path, help="write the fixture JSON here instead of posting")
    cmd.add_argument("--phone", help="E.164 number texts for one seeded civilian go to")
    cmd.add_argument(
        "--phone-civilian",
        type=int,
        default=4,
        help="which seeded civilian (1-8) gets --phone; default 4, in Lahaina Bypass Homes",
    )
    args = parser.parse_args(argv)

    seed = lahaina()
    if args.out:
        args.out.write_text(json.dumps(seed.to_json(), indent=2) + "\n")
        print(f"wrote {args.out}")
        return 0
    if not args.api:
        parser.error("lahaina needs --api URL or --out FILE")

    headers = {"Authorization": f"Bearer {args.key}"} if args.key else {}
    try:
        with httpx.Client(
            base_url=args.api, headers=headers, transport=transport, timeout=30
        ) as client:
            summary = seed_lahaina(client, seed, args.phone, args.phone_civilian)
    except (SeedError, httpx.HTTPError) as error:
        print(f"seed failed: {error}", file=sys.stderr)
        return 1
    print(
        f"zone {summary.zone_id}: {summary.edge_servers} edge servers, "
        f"{summary.responders_created} responders created, {summary.civilians} civilians"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
