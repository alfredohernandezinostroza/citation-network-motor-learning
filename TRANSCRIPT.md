# Working transcript — GraphML export + word heatmaps

Session with Claude Code (Opus 5), 2026-09-14 → 2026-09-15.

**User turns are quoted verbatim. Assistant turns are condensed** to the reasoning,
the commands actually run, and the numbers they produced — the full prose replies
were longer. Everything factual below (counts, file names, flags) was verified in
the session, not recalled.

---

## 1. Convert the Gemini bundle to GraphML

> from that repo, it's a website that shows the citation network and the embeddings.
> What I need is to convert the mebedding gemini graph to a graphml file, so I can
> open it in gephi. The data is in ./gemini_data if I'm not mistaken. Can you do it?

Inspected the bundle: `nodes.json` (14,511 papers with `x`/`y`/`cluster`/`community`/
metadata), `clusters.json`, `communities.json`, and `edges_out.bin` / `edges_in.bin`.
The `.bin` files are CSR: little-endian `uint32` `n`, then `offsets[n+1]`, then
`targets[m]` — decoded the same way `main.js:414` (`parseCSR`) does.

Wrote a converter and produced **`gemini_embedding.graphml`** (26 MB): 14,511 nodes,
166,003 directed edges. Each node carries `label`/`title`, `authors`, `keywords`,
`year`, `journal`, `doi`, `cluster` + resolved `cluster_name`, `community` +
`community_name`, both hex colours, `x`, `y`, `size`, `indegree`, `degree` — plus
Gephi's `viz:position` / `viz:color` / `viz:size`, so it opens already laid out in
the UMAP embedding and coloured by topic. Validated by re-parsing with ElementTree.

## 2. What do the edges represent?

> I am confused about what the edges represent

They are **citations, not embedding similarity**. Confirmed the direction from the
app: `outCSR` neighbours render as "cites N", `inCSR` as "cited by N"
(`main.js:1097-1105`), so `source → target` means **source cites target**. Position
comes from the text embedding; the edges come from the citation graph. Two findings:

- `md5sum` shows `edges_out.bin` / `edges_in.bin` are **byte-identical across all
  three bundles** (`data/`, `gemini_data/`, `forceatlas_data/`). There is only one
  citation graph in the project; bundles differ only in coordinates and clustering.
- The stored `indegree` attribute is ≥ the in-degree computed from the edges for
  4,590 nodes (176,076 vs 166,003 total) — e.g. *Adaptive representation of dynamics
  during learning of a motor task*: `indegree` 835, incoming edges 805. The edge
  files hold only **within-corpus** citations, so Gephi's computed in-degree will be
  slightly lower than the attribute.

## 3. Same thing for the ForceAtlas bundle

> ok can you get me the graphml too for ForceAtlas - Citations ?

**`forceatlas_citations.graphml`** (26 MB) — same nodes and edges, `viz:position`
from the force-directed layout instead (node `n2` at `(-2202.6, 545.5)` vs
`(12.8, 5.0)` in the Gemini file), and `cluster_name` from that bundle's own
`clusters.json`. Shared `id` scheme, so the two files can be joined.

## 4. Word-occurrence heatmap (KDE)

> I want to make a heatmap of the occurence of some words in the abstract of the
> papers in the forceatlas_citations_graphml. So for exmaple, I know the wordd bird
> mostly appears on a community on the bottom lef, so the heatmap should show some
> higly red blobs around there, while mostly everything else white. I believe the KDE
> plot concept could help, maybe?

Built **`word_heatmap.py`**. It reads `nodes.json` + `abstracts.json` from a bundle
(not the GraphML — abstracts aren't in there), matches a regex, bins matching papers
into a 600×600 raster and Gaussian-blurs it: a fixed-bandwidth KDE, much faster than
`scipy.stats.gaussian_kde` at this grid size. Single-hue ColorBrewer Reds ramp with
an alpha fade at the bottom.

The expectation checked out: **"bird" = 99 papers, 93 of them in *Vocal Learning***,
a blob at the bottom-left. System `python3` has no numpy, so the script carries a
PEP 723 header and runs under `uv run` with no setup.

Two modes: `--mode density` (where matching papers are) and `--mode enrichment`
(share of local papers that match — for common words, where plain density just
redraws overall crowding). Enrichment fades out where papers are sparse so empty
regions can't blow up the ratio.

## 5. Transparent background

> GREAT! but can you make it so the background is transparent though?

Transparent is now the default (`--bg white` for opaque, `--bg` takes any matplotlib
colour). Verified RGBA with corner alpha 0. Flagged that the grey dots, the ramp's
light end and the near-black title text all wash out on a dark slide.

## 6. What happens with more than one word

> explain the command usage again, I am confused what happens if I put more than one word

Multiple words are **OR'd into one map**; `--panels` splits them into one map per
word. Measured: `bird` = 99, `song` = 180, `bird song` = **189** (the union, not
279 — a paper matching both is one dot). No AND. Phrases need quotes.

## 7. Drop the dots by default

> delete the dots outline by default so we keep pnly the KDE heatmap color. (add a
> flag to restore the dots though just in case for later)

Both dot layers are now off by default — heat only on transparency. `--dots` restores
the faint grey per-paper dots, `--points` the dark-red rings around matching papers.
The subtitle drops its "grey dots" note automatically.

## 8. Layer order

> add a flag so invert the layers so that the heatmap is behind the grey dots

Added `--heat-under` (implies `--dots`). Noted honestly that with the heat behind,
the dots punch light holes through the hottest region — papers are densest exactly
where the word is densest — so the over-the-top version is the cleaner picture.

## 9. Switching bundles

> how do I switch to the gemini embedding?

`--data gemini_data`. Bandwidth auto-scales (2% of map width → 0.372 for Gemini vs
264 for ForceAtlas), so `--bw` needs no touching. Fixed a cosmetic bug this exposed:
the subtitle printed `bw=0` because Gemini coordinates rounded to zero (`:,.0f` →
`:,.3g`). Also made output filenames include the bundle, which they previously
didn't — the two bundles' PNGs were silently overwriting each other.

In the Gemini embedding the bird papers form a **detached island** at the bottom; in
the ForceAtlas citation layout they sit as a lobe attached to the left edge.

## 10. The "rat" false-positive bug

> if I put the word rat, will this script consider words that contain the word rat,
> thus giving a false positive? such as rationale for example

Yes — a real bug. The pattern was `\brat`, anchored only at the start:

| `--match` | "rat" matches | papers |
|---|---|---|
| `word` (new default) | rat, rats | **349** |
| `prefix` (old behaviour) | + rate, rather, rationale… | 2,664 |
| `substring` | + separate, strategy… | 10,430 |

87% of the old hits were false: `rate` (1,415 papers), `rather` (799), `rates`,
`ratio`, `rating`, `rationale`. The first fix regressed — `(?:e?s)?` made "rat"
match **rates** (705 papers) — so the plural rule became: `-s` always, `-es` only
after s/x/z/ch/sh, consonant+y → `-ies`. Verified: "The rat was trained" ✓,
"Error rates increased" ✗, "rationale for" ✗, "Rather than" ✗, "rats and mice" ✓.

Consequence: **"bird" is now 78 papers, not 99** — the old count included
*birdsong*. `--match prefix` restores it. The report line now prints the forms it
actually searched, e.g. `"bird" [bird|birds]`.

## 11. Irregular plurals

> I see you are putting safeguards for plurals, sucha as detecting rat and rats. What
> do you do with irregular words such as prostheses vs prosthesis, or mouse and mice?

**Not handled.** `prosthesis` generates prosthesis/prosthesises/prosthesiss and
misses every paper saying *prostheses*; `mouse` misses *mice*. Workaround: pass both
(`word_heatmap.py mouse mice`), since words are OR'd. A Latin/Greek rule set
(-is→-es, -us→-i, -um→-a, -ex→-ices) plus an irregular table is **still open**.

## 12. Weighting the KDE by occurrence count

> how plausible is it to do the heatmap but istead of coloring a node binary-wise (in
> other words, good if it has the word false if it's not) we count the number of times
> the word appear in the abstract and make the heatmap according to that? I am not
> sure if KDE is compatible with this

Fully compatible — a weighted KDE is each point's kernel scaled by its weight, and
`np.histogram2d` takes `weights=` directly. Added `--weight`:

| value | each paper contributes | for "bird" |
|---|---|---|
| `presence` (default) | 1 if it matches at all | 78 papers, total weight 78 |
| `count` | number of occurrences | 165 mentions, max 7 in one abstract |
| `log` | log(1+count) | max weight 2.08 |
| `rate` | mentions per 1000 words | 2.8–29.6 per paper |

Caveats raised: `count` partly maps abstract length (use `rate`) and is heavy-tailed,
so one abstract can create a hotspot (use `log`). Reports now show mentions per
community; paper counts are identical across weightings, only the heat changes.

## 13. Search keywords instead of abstracts

> add a flag to run the script but by searching on the keywords rather than the abstract

Added `--keywords` (shorthand for `--fields keywords`). Keyword hits are the papers
*about* a thing: "cerebellum" is 1,216 papers in abstracts but **721 in keywords**,
and those concentrate harder (45.8% in *Cerebellum: synaptic plasticity*).

Two caveats: only **76.6%** of papers have keywords at all (11,114 of 14,511), and
availability is journal-dependent — a cold region may mean "no keywords here". And
rare words vanish: "bird" is 5 papers in keywords vs 78 in abstracts, because that
literature tags itself *Birdsong* / *Zebra finch* / *Vocal learning*.

## 14. Filenames that record what was searched

> I don't like that you are not naming the final file according to where we searched

Filenames are now `word_heatmap_<bundle>_<fields>_<words>[_match][_weight][_mode].png`,
with the last three appended only when off their defaults:

```
bird                                    -> word_heatmap_forceatlas_abstract_bird.png
bird --keywords                         -> word_heatmap_forceatlas_keywords_bird.png
bird --fields abstract,title            -> word_heatmap_forceatlas_abstract+title_bird.png
bird --keywords --weight count          -> word_heatmap_forceatlas_keywords_bird_count.png
bird --data gemini_data                 -> word_heatmap_gemini_abstract_bird.png
bird --match prefix --mode enrichment   -> word_heatmap_forceatlas_abstract_bird_prefix_enrichment.png
```

I mis-guessed that an existing `word_heatmap_forceatlas_human_in_keywords.png` came
from a bad command; the user had simply renamed it by hand:

> nono, that one is just the result of searching human in keywords, and then I changed
> the name adding _in_keywords at the end

(That file predates the plural fix, so it used the old `\bhuman` prefix match — it
includes "humans" but also "humanoid". `--match prefix` reproduces it.)

## 15. Sharing the code

> what do I need to share this code?

`word_heatmap.py` plus the data bundles — and the bundles are **already committed**
and on `git@github.com:alfredohernandezinostroza/citation-network-motor-learning.git`.
A recipient needs only:

```bash
git clone git@github.com:alfredohernandezinostroza/citation-network-motor-learning.git
cd citation-network-motor-learning
uv run word_heatmap.py bird     # uv installs numpy/scipy/matplotlib from the PEP 723 header
```

Without uv: `pip install numpy scipy matplotlib && python word_heatmap.py bird`. Run
from the repo root (bundle paths are relative) or pass an absolute `--data`.

---

## State of the work

**In the repo, untracked:** `word_heatmap.py`, `gemini_embedding.graphml`,
`forceatlas_citations.graphml`, the `word_heatmap_*.png` outputs, `heatmaps/`.

**Open items:**

1. `word_heatmap.py` is not committed — nothing to clone yet.
2. The GraphML converter (`to_graphml.py`) exists **only in the session scratchpad**
   and will be deleted. It should move into the repo (e.g. `tools/`) if the Gephi
   export is to stay reproducible. It takes a bundle dir and an output path, and
   works for all three bundles.
3. Irregular plurals (§11) unimplemented.
4. Decide what ships: the two 26 MB `.graphml` files and the PNGs are regenerable
   outputs; the converter is source.

## `word_heatmap.py` flags

| flag | effect |
|---|---|
| `--data DIR` | bundle: `forceatlas_data` (default), `gemini_data`, `data` |
| `--fields` / `--keywords` | where to search; default `abstract` |
| `--match word\|prefix\|substring` | whole word + plurals (default), prefix, or anywhere |
| `--weight presence\|count\|log\|rate` | per-paper contribution to the KDE |
| `--mode density\|enrichment` | absolute vs. share-of-local-papers |
| `--panels` | one map per word instead of OR'ing them |
| `--dots`, `--points`, `--heat-under` | grey paper dots, rings on matches, layer order |
| `--bg`, `--trim`, `--bw`, `--grid`, `--floor`, `--dpi`, `--top`, `--out` | rendering knobs |
