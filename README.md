# Mapping the Motor Learning Literature — Interactive Citation Map

An interactive, browsable map of the **motor-learning research literature**
(~14,500 papers). Each dot is a paper; you can switch between a **citation-graph
layout** and **text-embedding (topic) layouts**, colour by topic / community /
year / citation count, search and filter, trace a paper's citations, and
"time-travel" to see how the field grew decade by decade.

This repository is the **static front-end only** — a dependency-free site
(sigma.js + graphology, loaded from CDN) plus the exported data bundles it reads.

## Run it locally

It's a static site, but module scripts and `fetch()` won't load from `file://`,
so serve the folder over HTTP:

```bash
python -m http.server 8123
# then open http://localhost:8123
```

(Any static file server works.) An internet connection is needed at runtime for
the CDN-hosted libraries.

## What you see

Each dot is a paper; dot size is total citation degree. Position depends on the
selected dataset:

- **Gemini – Topics** and **Specter – Topics** place papers by a **2D UMAP of
  their text embedding** — papers with similar content sit together.
- **ForceAtlas – Citations** uses a **force-directed layout of the citation
  graph** — papers that cite each other are pulled together (position reflects
  citation structure, not text).

You can:

- **Switch datasets** (Specter / Gemini topics, ForceAtlas citations).
- **Time-travel** (Gemini / ForceAtlas) with the **Time** control — re-lay-out the
  field as it stood up to ≤ 1980 / 1990 / 2000 / 2010, or "All" for today.
- **Colour by** topic/cluster, citation community, year, or citation count.
- **Search** by title / author / DOI; **filter** by publication, author, abstract,
  journal, keywords, and year range.
- **Hover** a paper for title/year/authors; **click** to draw its citation links
  and open a detail panel.
- Toggle the **citation-edge overlay** to see where the citation graph crosses the
  semantic map.
- **Click a topic** (Gemini dataset) for a detail panel including a **citation
  gaps** report: community pairs that share a topic but barely cite each other.

## Word heatmaps

Beyond the map itself, this repo carries tooling for asking **where a word sits
on the map** — papers matching a word are smoothed into a 2D density (a
fixed-bandwidth KDE) over the layout, so a word that belongs to one community
shows up as a red blob there.

```bash
uv run word_heatmap.py bird                 # abstracts of the ForceAtlas layout
uv run word_heatmap.py cerebellum --keywords
python3 regen_heatmaps.py                   # the whole set, three field settings
```

`compare.html` is the interactive version: it computes the same maps in the
browser and shows **abstract / keywords / both** side by side for any word you
type. Serve the folder over HTTP and open `compare.html`.

## Files

- `index.html` — page shell, controls panel, detail panel.
- `main.js` — the app: loads a dataset, builds the graph, search, filters,
  hover/click, citation-edge overlay, cluster labels.
- `styles.css` — styling.
- `data/` — the **SPECTER2** dataset bundle.
- `gemini_data/` — the **Gemini** dataset bundle.
- `forceatlas_data/` — the **ForceAtlas** (citation-graph) dataset bundle.
- `word_heatmap.py` — word-occurrence KDE heatmaps as PNGs (see above).
- `regen_heatmaps.py` — regenerates the whole `heatmaps/` set.
- `compare.html` / `compare.js` — live abstract-vs-keywords comparison page.
- `heatmaps/` — generated heatmaps, by field searched.
- `*.graphml` — the citation graph with each layout's coordinates, for Gephi.

Each bundle holds `nodes.json` (per-paper position/colour/metadata),
`clusters.json` / `topics.json` and `communities.json` (group labels & colours),
`abstracts.json` (lazily loaded), `edges_in.bin` / `edges_out.bin` (directed
citation edges, CSR uint32), and — for the Gemini / ForceAtlas bundles —
`snapshots.json` (per-cutoff-year layouts for the Time control).

## Status

This is a **temporary working repo**. The data bundles come from Eric
Griessbach's CitationMap repository, and this implementation is expected to be
absorbed into the main study repo later — so treat the layout of this
repository as provisional.

## Credits

Map and analysis by Mariana Duarte, Alfredo Hernandez and Eric Griessbach.
