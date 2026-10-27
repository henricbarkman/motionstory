#!/usr/bin/env python3
"""The private copy (glimt_privat_deploy.py): built out of the portal's reach,
swapped in whole, and the old copy never lost when the swap fails.

    python3 scripts/test_privat_deploy.py

Writes only under a fresh folder in /tmp, with a made-up song and made-up
licensed sounds (sine tones), never the real ones.
"""
from __future__ import annotations

import json
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
    ljud = root / "ljud"
    ljud.mkdir()
    for name, hz in (("bed.opus", 220), ("riser.opus", 660)):
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"sine=frequency={hz}:duration=1",
                        "-c:a", "libopus", str(ljud / name)], check=True)
    (ljud / "ljud.json").write_text(json.dumps({"bed": "bed.opus", "riser": "riser.opus"}), encoding="utf-8")
    uploads = root / "uploads"
    scratch = root / "scratch"
    ut = uploads / "glimt-episod1"
    stand_in = d.song_path(1)

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
        cache = d.deploy(song, ut, 1, scratch, ljud)
    finally:
        d.transcode = real
    check(scratch in seen["out"].parents, f"the song is written in the scratch folder ({seen['out']})")
    check(seen["uploads"] == [], f"and nothing is in the uploads folder while it builds ({seen['uploads']})")
    check((ut / d.MARK).is_file() and (ut / stand_in).is_file(), "the copy is in place, marked, with the song where the episode says")
    extra = json.loads((ut / "glimt" / "ljud.json").read_text(encoding="utf-8"))
    named = [extra.get("bed"), extra.get("riser"), (extra.get("credits") or {}).get("glimt-e1")]
    check(all(n and (ut / n).is_file() for n in named), f"its ljud.json names the bed, the riser and the song, all there ({extra})")
    check((ut / extra["bed"]).read_bytes() == (ljud / "bed.opus").read_bytes(), "the bed is the one from the --ljud folder")
    public = json.loads((d.REPO / "glimt" / "ljud.json").read_text(encoding="utf-8"))
    check(not any(public.get(k) for k in ("bed", "riser", "credits")), f"and the public ljud.json names none of them ({public})")
    check("-privat-" in cache, f"its cache has its own name ({cache})")
    check(list(scratch.iterdir()) == [], f"the scratch folder is cleaned up ({[p.name for p in scratch.iterdir()]})")
    check(sorted(p.name for p in uploads.iterdir()) == ["glimt-episod1"], "nothing else is left next to it")
    index = (ut / "index.html").read_text(encoding="utf-8")
    check("?kapitel=episod1" in index, "its index sends the walker to episode 1")

    # The cache name follows the whole copy (code review 18/10, Medel 3): a
    # phone never keeps old code or old voices under a name it already has.
    sw = ut / "service-worker.js"
    check(cache.endswith("-privat-" + d.tree_tag(ut, sw)), f"the name is the hash of the copy as it is served ({cache})")
    probe = root / "probe"
    (probe / "glimt").mkdir(parents=True)
    (probe / "audio").mkdir()
    (probe / "glimt" / "app.js").write_text("a", encoding="utf-8")
    (probe / "audio" / "s1.mp3").write_bytes(b"x")
    probe_sw = probe / "service-worker.js"
    probe_sw.write_text("sw", encoding="utf-8")
    tags = [d.tree_tag(probe, probe_sw)]
    (probe / "glimt" / "app.js").write_text("b", encoding="utf-8")
    tags.append(d.tree_tag(probe, probe_sw))
    (probe / "audio" / "s1.mp3").write_bytes(b"y")
    tags.append(d.tree_tag(probe, probe_sw))
    (probe / "audio" / "s1.mp3").rename(probe / "audio" / "s2.mp3")
    tags.append(d.tree_tag(probe, probe_sw))
    check(len(set(tags)) == 4, f"a change to the code, a voice or a file name changes it ({tags})")
    probe_sw.write_text("sw with the new name", encoding="utf-8")
    check(d.tree_tag(probe, probe_sw) == tags[-1], "the service worker itself does not, since it carries the name")

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
        d.deploy(song, ut, 1, scratch, ljud)
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

    # Without the licensed sounds there is no copy.
    try:
        d.deploy(song, uploads / "glimt-utan", 1, scratch, root / "inget")
        check(False, "a missing --ljud folder is refused")
    except SystemExit as e:
        check("ljud" in str(e) and not (uploads / "glimt-utan").exists(), f"a missing --ljud folder is refused ({e})")

    # An episode with no file to say where its song goes says so.
    try:
        d.song_path(99)
        check(False, "an unknown episode is refused")
    except SystemExit as e:
        check("episod-99.json" in str(e), f"an unknown episode is refused ({e})")
    check(d.default_ut(2).name == "glimt-episod2", "episode 2 gets its own folder")
    # The English episode has its own file and folder: a copy of it never
    # replaces the Swedish one.
    check(d.default_ut("1en").name == "glimt-episode1-en", "episode 1 in English gets its own folder")
    check(d.default_ut("1").name == "glimt-episod1", "the Swedish episode keeps its folder")
    check(d.kapitel("1en") == "episode1en" and d.kapitel(1) == "episod1", "each sends the walker to its own episode")
    check(d.episode_file("1en")["language"] == "en", "1en reads episode-1.json")

    if failures:
        print(f"\n{failures} failed (left {root})")
        return 1
    subprocess.run(["rm", "-rf", str(root)], check=True)
    print("\nprivat deploy ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
