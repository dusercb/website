"""Set the site's domain, profile links and contact email in one go.

    python tools/configure.py --domain https://example.com \
        --linkedin https://www.linkedin.com/in/you --github https://github.com/you \
        --email you@example.com

Any option can be given alone. Safe to re-run: the values last applied are kept
in tools/.site_config.json, so the next run replaces those instead of the
original placeholders.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.normpath(os.path.join(HERE, "..", "site"))
STATE = os.path.join(HERE, ".site_config.json")
FILES = ["index.html", "robots.txt", "sitemap.xml"]
PLACEHOLDERS = {
    "domain": "https://YOUR-DOMAIN",
    "linkedin": "https://www.linkedin.com/in/YOUR-LINKEDIN",
    "github": "https://github.com/YOUR-GITHUB",
    "email": "YOUR-EMAIL@example.com",
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for key in PLACEHOLDERS:
        ap.add_argument(f"--{key}")
    args = vars(ap.parse_args())
    current = dict(PLACEHOLDERS)
    if os.path.exists(STATE):
        current.update(json.load(open(STATE, encoding="utf-8")))
    changes = {k: v.rstrip("/") if k == "domain" else v for k, v in args.items() if v}
    if not changes:
        print("Nothing to do. Current values:")
        for k, v in current.items():
            print(f"  {k:9} {v}")
        return 0
    for name in FILES:
        path = os.path.join(SITE, name)
        text = open(path, encoding="utf-8").read()
        before = text
        for key, new in changes.items():
            text = text.replace(current[key], new)
        if text != before:
            open(path, "w", encoding="utf-8").write(text)
            print(f"updated {name}")
    current.update(changes)
    json.dump(current, open(STATE, "w", encoding="utf-8"), indent=2)
    print("now:", json.dumps(current, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
