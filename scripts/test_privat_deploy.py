#!/usr/bin/env python3
"""The private copy (glimt_privat_deploy.py): built out of the portal's reach,
swapped in whole, and the old copy never lost when the swap fails.

    python3 scripts/test_privat_deploy.py

Writes only under a fresh folder in /tmp, with a made-up song (a sine tone),
never the real one.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import glimt_privat_deploy as d  # noqa: E402

failures = 0


def check(ok: bool, what: str) -> None:
    global failures
    print(f"{'ok  ' if ok else 'FAIL'}  {what}")
    if not ok:
        failures += 1


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="glimt-privat-test-"))
    song = root / "song.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", str(song)], check=True)
    uploads = root / "uploads"
    scratch = root / "scratch"
    ut = uploads / "glimt-episod1"
    stand_in = d.stand_in_path(1)

    # While it builds, the served folder holds nothing new: the song is
    # transcoded into the scratch folder.
    seen = {}
    real = d.transcode

    def watching(src: Path, out: Path) -> None:
        seen["out"] = out
        seen["uploads"] = sorted(p.name for p in uploads.iterdir()) if uploads.exists() else []
        real(src, out)

    d.transcode = watching
    try:
        cache = d.deploy(song, ut, 1, scratch)
    finally:
        d.transcode = real
    check(scratch in seen["out"].parents, f"the song is written in the scratch folder ({seen['out']})")
    check(seen["uploads"] == [], f"and nothing is in the uploads folder while it builds ({seen['uploads']})")
    check((ut / d.MARK).is_file() and (ut / stand_in).is_file(), "the copy is in place, marked, with the song at the stand-in's path")
    check((ut / stand_in).read_bytes() != (d.REPO / stand_in).read_bytes(), "the song is not the stand-in")
    check("-privat-" in cache, f"its cache has its own name ({cache})")
    check(list(scratch.iterdir()) == [], f"the scratch folder is cleaned up ({[p.name for p in scratch.iterdir()]})")
    check(sorted(p.name for p in uploads.iterdir()) == ["glimt-episod1"], "nothing else is left next to it")
    index = (ut / "index.html").read_text(encoding="utf-8")
    check("?kapitel=episod1" in index, "its index sends the walker to episode 1")

    # A swap whose second rename fails puts the old copy back.
    (ut / "gammal.txt").write_text("the copy before", encoding="utf-8")
    real_rename = Path.rename

    def failing(self: Path, target):
        if Path(target) == ut and self.name == ut.name and self.parent != uploads:
            raise OSError("simulated: the new copy could not be moved in")
        return real_rename(self, target)

    Path.rename = failing
    failed = False
    try:
        d.deploy(song, ut, 1, scratch)
    except OSError:
        failed = True
    finally:
        Path.rename = real_rename
    check(failed, "the failed swap is reported")
    check((ut / "gammal.txt").is_file(), "and the old copy is back at the address, not deleted")
    left = list(scratch.iterdir())
    check(len(left) == 1, f"the half-done build stays in the scratch folder to look at ({[p.name for p in left]})")

    # Not over a folder the script did not make, not inside the repo.
    other = uploads / "something-else"
    other.mkdir()
    for target, what in ((other, "a folder it did not make"), (d.REPO / "glimt-test", "the repo")):
        try:
            d.check_target(target)
            check(False, f"refuses {what}")
        except SystemExit:
            check(True, f"refuses {what}")

    # An episode with no file to name its stand-in says so.
    try:
        d.stand_in_path(99)
        check(False, "an unknown episode is refused")
    except SystemExit as e:
        check("episod-99.json" in str(e), f"an unknown episode is refused ({e})")
    check(d.default_ut(2).name == "glimt-episod2", "episode 2 gets its own folder")

    if failures:
        print(f"\n{failures} failed (left {root})")
        return 1
    subprocess.run(["rm", "-rf", str(root)], check=True)
    print("\nprivat deploy ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
