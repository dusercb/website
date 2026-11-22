"""Copy the Lumina app (../REA/app) into site/lumina/ so the site can host it live.

    python tools/sync_lumina.py

The app is plain static files (HTML, ES modules, MediaPipe's WebAssembly and
models), so a straight copy is all it needs. Re-run after changing Lumina.
"""
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.normpath(os.path.join(HERE, "..", "..", "REA", "app"))
DST = os.path.normpath(os.path.join(HERE, "..", "site", "lumina"))


def main() -> int:
    if not os.path.isfile(os.path.join(SRC, "index.html")):
        print(f"Lumina not found at {SRC}")
        return 1
    if os.path.isdir(DST):
        shutil.rmtree(DST)
    shutil.copytree(SRC, DST)
    total = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(DST) for f in fs)
    print(f"copied {SRC} -> {DST} ({total / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
