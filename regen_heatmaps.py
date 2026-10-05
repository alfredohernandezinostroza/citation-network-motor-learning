#!/usr/bin/env python3
"""Regenerate the whole heatmap set: every word below x {abstract, keywords,
abstract+keywords}, into heatmaps/<fields>/.

    python3 regen_heatmaps.py            # all three field settings
    python3 regen_heatmaps.py --dots     # ... with the grey paper dots

Defaults for --match/--weight/--mode; edit JOBS to change the vocabulary.
"""
import argparse, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

REPO = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(REPO, "word_heatmap.py")

# Phrases are kept as one quoted term: the filename sanitiser squashes their
# spaces ("augmented feedback" -> augmentedfeedback), so the names alone can't
# be fed back in - this list is the record of what was actually searched.
JOBS = [
    ["bird"], ["monkey"], ["mouse"], ["zebra"], ["human"], ["neuron"],
    ["performance"], ["optimization"], ["healthy"], ["rehabilitation"],
    ["coaching"], ["skill"], ["behavior"], ["computation"], ["computational"],
    ["applied"],
    ["sport"],                       # covers "sports" (whole-word + plural)
    ["athlete"],                     # covers "athletes"
    ["prosthesis"], ["prostheses"],  # irregular plural: needs both runs
    ["applied science"], ["internal model"], ["augmented feedback"],
    ["external focus"], ["schema theory"], ["reinforcement learning"],
    ["sequence learning"],
    ["mouse", "bird", "monkey"],
    ["zebra", "bird", "monkey", "mouse", "birdsong", "larva"],
    ["athlete", "coaching", "sport", "augmented feedback", "schema theory",
     "external focus"],
]

FIELDS = [("abstract", "abstract"),
          ("keywords", "keywords"),
          ("abstract,keywords", "abstract+keywords")]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="forceatlas_data")
    ap.add_argument("--outdir", default="heatmaps")
    ap.add_argument("--dots", action="store_true")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()
    data = os.path.join(REPO, args.data)

    def run(job):
        words, fields, outdir = job
        cmd = ["uv", "run", "--quiet", SCRIPT, *words, "--data", data,
               "--fields", fields] + (["--dots"] if args.dots else [])
        r = subprocess.run(cmd, cwd=outdir, capture_output=True, text=True)
        if r.returncode:
            return f"FAILED {words} ({fields}): {r.stderr.strip()[:200]}"
        head = next((l for l in r.stdout.splitlines() if l.startswith('"')), "")
        return f"{os.path.basename(outdir):18} {head}"

    jobs = []
    for fields, dirname in FIELDS:
        outdir = os.path.join(REPO, args.outdir, dirname)
        os.makedirs(outdir, exist_ok=True)
        jobs += [(w, fields, outdir) for w in JOBS]

    print(f"{len(jobs)} runs ({len(JOBS)} word sets x {len(FIELDS)} field settings)")
    fails = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for line in ex.map(run, jobs):
            if line.startswith("FAILED"):
                fails += 1
            print(line, flush=True)
    print(f"\ndone - {len(jobs) - fails} written, {fails} failed")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
