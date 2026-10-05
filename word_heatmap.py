#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = ["numpy", "scipy", "matplotlib"]
# ///
"""Heatmap of where a word occurs on the map.

Papers whose abstract matches the word are smoothed into a 2D density (a
histogram + Gaussian blur, i.e. a KDE with a fixed bandwidth) over the layout
coordinates of a dataset bundle, so a word that lives in one community shows up
as a red blob there and the rest of the map stays empty. The PNG has a
transparent background by default (--bg white for an opaque one).

    uv run word_heatmap.py bird
    uv run word_heatmap.py bird song --panels
    uv run word_heatmap.py sleep --mode enrichment --fields abstract,title

Without uv: pip install numpy scipy matplotlib, then python word_heatmap.py ...
"""
import argparse, json, math, os, re, sys

import numpy as np
from matplotlib import pyplot as plt
from matplotlib.colors import LinearSegmentedColormap
from scipy.ndimage import gaussian_filter

# Single-hue sequential ramp (ColorBrewer Reds), light -> dark.
REDS = ["#fff5f0", "#fee0d2", "#fcbba1", "#fc9272", "#fb6a4a",
        "#ef3b2c", "#cb181d", "#a50f15", "#67000d"]
INK, MUTED, DOT = "#1a1a1a", "#6b6b6b", "#d7d7d7"


def heat_cmap(fade=0.15):
    """Reds, with the bottom `fade` of the range ramped to transparent so the
    empty map stays clear and the paper dots stay visible underneath."""
    cmap = LinearSegmentedColormap.from_list("reds", REDS, N=256)
    rgba = cmap(np.linspace(0, 1, 256))
    rgba[:, 3] = np.clip(np.linspace(0, 1, 256) / max(fade, 1e-6), 0, 1)
    return LinearSegmentedColormap.from_list("reds_fade", rgba)


def load(bundle):
    nodes = json.load(open(os.path.join(bundle, "nodes.json")))["nodes"]
    abstracts = json.load(open(os.path.join(bundle, "abstracts.json")))
    path = os.path.join(bundle, "communities.json")
    communities = json.load(open(path)) if os.path.exists(path) else {}
    return nodes, abstracts, communities


def plurals(word):
    """English plural forms of `word`, so "rat" also finds "rats" - but never
    "rates" (the -es plural only follows s/x/z/ch/sh)."""
    forms = {word, word + "s"}
    if re.search(r"(?:s|x|z|ch|sh)$", word, re.I):
        forms.add(word + "es")
    if re.search(r"[^aeiou]y$", word, re.I):
        forms.add(word[:-1] + "ies")
    return forms


def matcher(words, mode="word"):
    """word: whole word, plural allowed (rat -> rat, rats; not rate/rationale).
    prefix: any word starting with it (bird -> birdsong). substring: anywhere."""
    pat = "|".join(re.escape(w) for w in words)
    if mode == "substring":
        return re.compile(pat, re.I)
    if mode == "prefix":
        return re.compile(r"\b(?:%s)" % pat, re.I)
    forms = "|".join(re.escape(f) for w in words for f in sorted(plurals(w)))
    return re.compile(r"\b(?:%s)\b" % forms, re.I)


def occurrences(nodes, abstracts, rx, fields):
    """How many times the pattern occurs in each paper, and how long its text
    is (in words) - the two numbers every weighting scheme is built from."""
    counts = np.zeros(len(nodes), dtype=int)
    lengths = np.zeros(len(nodes), dtype=int)
    for i, nd in enumerate(nodes):
        text = " ".join(
            abstracts.get(nd["id"], "") if f == "abstract" else str(nd.get(f) or "")
            for f in fields
        )
        counts[i] = len(rx.findall(text))
        lengths[i] = len(text.split())
    return counts, lengths


def weights_for(counts, lengths, how):
    """Per-paper weight fed to the KDE. A weighted KDE is just the sum of each
    point's kernel scaled by its weight, so any of these is legitimate - they
    answer different questions, see --weight."""
    if how == "presence":
        return (counts > 0).astype(float)
    if how == "count":
        return counts.astype(float)
    if how == "log":
        return np.log1p(counts)
    # rate: mentions per 1000 words, so long abstracts don't win by length alone
    return counts / np.maximum(lengths, 1) * 1000


def density(x, y, extent, grid, sigma_units, w=None):
    """Gaussian-smoothed 2D density on a `grid` x `grid` raster. `w` weights
    each point's contribution (None = every point counts once)."""
    x0, x1, y0, y1 = extent
    counts, _, _ = np.histogram2d(y, x, bins=grid, range=[[y0, y1], [x0, x1]],
                                  weights=w)
    # `grid` bins on both axes over a non-square extent means the cells are
    # rectangular, so each axis needs its own sigma - one shared sigma would
    # blur a circle into an ellipse. Array is [y, x].
    cell_x, cell_y = (x1 - x0) / grid, (y1 - y0) / grid
    return gaussian_filter(counts, (sigma_units / cell_y, sigma_units / cell_x),
                           mode="constant")


def field_for(w, xs, ys, extent, args, background):
    hits = density(xs, ys, extent, args.grid, args.bw, w)
    if args.mode == "density":
        f = hits
    else:  # enrichment: share of local papers that match, not how many.
        # Faded out where there are barely any papers, so empty regions can't
        # blow up the ratio (and the fade avoids a hard mask edge).
        ratio = np.divide(hits, background, out=np.zeros_like(hits),
                          where=background > 0)
        f = ratio * np.clip(background / (background.max() * args.floor), 0, 1)
    return f / f.max() if f.max() > 0 else f


def panel(ax, field, extent, xs, ys, mask, args, cmap):
    ax.set_facecolor(args.bg)
    dots_z, heat_z = (2, 1) if args.heat_under else (1, 2)
    if args.dots:
        ax.scatter(xs, ys, s=1.2, c=DOT, linewidths=0, zorder=dots_z)
    im = ax.imshow(field, extent=extent, origin="lower", cmap=cmap,
                   vmin=0, vmax=1, interpolation="bilinear", zorder=heat_z)
    if args.points:
        ax.scatter(xs[mask], ys[mask], s=5, facecolors="none",
                   edgecolors="#67000d", linewidths=0.5, alpha=0.8, zorder=3)
    ax.set_xlim(extent[0], extent[1])
    ax.set_ylim(extent[2], extent[3])
    ax.set_aspect("equal")
    ax.set_xticks([]); ax.set_yticks([])
    for s in ax.spines.values():
        s.set_visible(False)
    return im


def report(words, counts, nodes, communities, top, forms):
    mask = counts > 0
    n = int(mask.sum())
    print(f'\n"{" / ".join(words)}" [{forms}]: {n} papers '
          f'({100*n/len(nodes):.2f}% of corpus), {int(counts.sum())} mentions')
    if not n:
        return
    from collections import Counter
    hit_counts = Counter(nodes[i]["community"] for i in np.flatnonzero(mask))
    said = Counter()
    for i in np.flatnonzero(mask):
        said[nodes[i]["community"]] += int(counts[i])
    all_counts = Counter(nd["community"] for nd in nodes)
    print(f"  {'community':<34}{'papers':>8}{'mentions':>10}{'of hits':>9}{'of comm.':>10}")
    for cid, c in hit_counts.most_common(top):
        name = (communities.get(str(cid)) or {}).get("name", f"#{cid}")
        print(f"  {name[:32]:<34}{c:>8}{said[cid]:>10}"
              f"{100*c/n:>8.1f}%{100*c/all_counts[cid]:>9.1f}%")


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("words", nargs="+", help="word(s) to look for")
    p.add_argument("--data", default="forceatlas_data", help="dataset bundle directory")
    p.add_argument("--out", default=None, help="output PNG (default: word_heatmap_<words>.png)")
    p.add_argument("--fields", default="abstract",
                   help="comma-separated: abstract,title,keywords,journal,authors")
    p.add_argument("--keywords", dest="fields", action="store_const",
                   const="keywords",
                   help="search the author keywords instead of the abstract "
                        "(shorthand for --fields keywords; only 77%% of papers "
                        "have keywords at all)")
    p.add_argument("--mode", choices=["density", "enrichment"], default="density",
                   help="density: where the matching papers are. "
                        "enrichment: what fraction of local papers match")
    p.add_argument("--weight", choices=["presence", "count", "log", "rate"],
                   default="presence",
                   help="what each paper contributes to the KDE. presence "
                        "(default): 1 if it matches at all. count: how many "
                        "times the word occurs. log: log(1+count), so one "
                        "obsessive abstract can't dominate. rate: mentions per "
                        "1000 words, correcting for abstract length")
    p.add_argument("--panels", action="store_true",
                   help="one panel per word instead of one map for all of them")
    p.add_argument("--bw", type=float, default=None,
                   help="KDE bandwidth in layout units (default: 2%% of map width)")
    p.add_argument("--grid", type=int, default=600, help="raster resolution")
    p.add_argument("--floor", type=float, default=0.03,
                   help="enrichment: ignore cells below this share of peak paper density")
    p.add_argument("--match", choices=["word", "prefix", "substring"], default="word",
                   help="word (default): whole word, plural allowed - rat matches "
                        "rat/rats but not rate or rationale. prefix: any word "
                        "starting with it - bird also matches birdsong. "
                        "substring: anywhere - rat also matches rationale")
    p.add_argument("--substring", dest="match", action="store_const", const="substring",
                   help=argparse.SUPPRESS)
    p.add_argument("--dots", action="store_true",
                   help="draw every paper as a faint grey dot, for context")
    p.add_argument("--points", action="store_true",
                   help="ring each matching paper on top of the heat")
    p.add_argument("--heat-under", action="store_true",
                   help="draw the heat behind the grey dots instead of over "
                        "them (implies --dots)")
    p.add_argument("--top", type=int, default=6, help="communities listed per word")
    p.add_argument("--trim", type=float, default=0.0,
                   help="crop this %% off each end of each axis when framing, to drop "
                        "far-flung outliers (they are still counted, just off-view)")
    p.add_argument("--bg", default="none",
                   help='page background: "none" for a transparent PNG (default), '
                        'or any matplotlib colour, e.g. white')
    p.add_argument("--dpi", type=int, default=200)
    args = p.parse_args()

    args.dots = args.dots or args.heat_under
    nodes, abstracts, communities = load(args.data)
    fields = [f.strip() for f in args.fields.split(",") if f.strip()]
    xs = np.array([nd["x"] for nd in nodes])
    ys = np.array([nd["y"] for nd in nodes])

    lo, hi = args.trim, 100 - args.trim
    x0, x1 = np.percentile(xs, [lo, hi])
    y0, y1 = np.percentile(ys, [lo, hi])
    pad = 0.03 * max(x1 - x0, y1 - y0)
    extent = (x0 - pad, x1 + pad, y0 - pad, y1 + pad)
    if args.bw is None:
        args.bw = 0.02 * max(x1 - x0, y1 - y0)

    groups = [[w] for w in args.words] if args.panels else [args.words]
    rxs = [matcher(g, args.match) for g in groups]
    counted = [occurrences(nodes, abstracts, rx, fields) for rx in rxs]
    weights = [weights_for(c, ln, args.weight) for c, ln in counted]
    background = density(xs, ys, extent, args.grid, args.bw)
    fields_ = [field_for(w, xs, ys, extent, args, background) for w in weights]

    cmap = heat_cmap()
    ncols = min(len(groups), math.ceil(math.sqrt(len(groups))) if len(groups) > 2 else 2)
    nrows = math.ceil(len(groups) / ncols)
    aspect = (extent[1] - extent[0]) / (extent[3] - extent[2])
    panel_h = 5.2 if len(groups) == 1 else 4.0
    header = 0.85  # inches reserved at the top for title + subtitle
    fig_w, fig_h = panel_h * ncols * min(aspect, 1.8), panel_h * nrows + header
    fig, axes = plt.subplots(nrows, ncols, figsize=(fig_w, fig_h),
                             squeeze=False, facecolor=args.bg)
    fig.subplots_adjust(top=1 - header / fig_h)
    axes = axes.ravel()
    for ax in axes[len(groups):]:
        ax.set_visible(False)

    for ax, g, rx, (c, _), f in zip(axes, groups, rxs, counted, fields_):
        im = panel(ax, f, extent, xs, ys, c > 0, args, cmap)
        if len(groups) > 1:
            ax.set_title(f'"{g[0]}" · {int((c > 0).sum())} papers, '
                         f'{int(c.sum())} mentions',
                         color=INK, fontsize=11, loc="left", pad=6)
        report(g, c, nodes, communities, args.top,
               "|".join(sorted(plurals(g[0]))) if args.match == "word" else args.match)

    label = " / ".join(args.words)
    total = int(np.any([c > 0 for c, _ in counted], axis=0).sum())
    unit = {"presence": "matching papers", "count": "mentions",
            "log": "log mentions", "rate": "mentions per 1000 words"}[args.weight]
    what = (f"density of {unit}" if args.mode == "density"
            else f"local {unit} per paper")
    fig.text(0.02, 1 - 0.30 / fig_h,
             f'"{label}" in {"+".join(f if f.endswith("s") else f + "s" for f in fields)}'
             f' — {total} of {len(nodes)} papers'
             + (f", {int(sum(c.sum() for c, _ in counted))} mentions"
                if args.weight != "presence" else ""),
             color=INK, fontsize=13, ha="left", va="center")
    fig.text(0.02, 1 - 0.60 / fig_h,
             f"{os.path.basename(args.data.rstrip('/')) } layout · {what}, "
             f"smoothed at bw={args.bw:,.3g} "
             f"layout units"
             + (" · grey dots are all papers" if args.dots else ""),
             color=MUTED, fontsize=8.5, ha="left", va="center")

    cbar = fig.colorbar(im, ax=axes.tolist(), fraction=0.02, pad=0.01,
                        shrink=0.45, aspect=28)
    cbar.set_ticks([0, 1])
    cbar.set_ticklabels(["none", "peak"])
    cbar.ax.tick_params(length=0, colors=MUTED, labelsize=8.5)
    cbar.outline.set_visible(False)

    # Name the file after everything that changes the picture, so runs that
    # differ only in where we searched (or how) can't overwrite each other.
    bundle = os.path.basename(args.data.rstrip("/\\")).replace("_data", "") or "data"
    parts = ["word_heatmap", bundle, "+".join(fields),
             "_".join(re.sub(r"\W+", "", word) for word in args.words)[:60]]
    if args.match != "word":
        parts.append(args.match)
    if args.weight != "presence":
        parts.append(args.weight)
    if args.mode != "density":
        parts.append(args.mode)
    out = args.out or ("_".join(parts) + ".png")
    fig.savefig(out, dpi=args.dpi, bbox_inches="tight", facecolor=args.bg,
                transparent=args.bg == "none")
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()
