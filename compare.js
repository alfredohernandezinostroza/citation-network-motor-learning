// Word maps — abstract vs keywords, computed in the browser.
//
// Same maths as word_heatmap.py: match a word in each paper's text, drop the
// matching papers onto the layout, blur with a Gaussian (a fixed-bandwidth KDE),
// normalise to the panel's own peak. Nothing is precomputed and no server is
// involved — the dataset bundles are small enough to live in the page.

// ── Config ────────────────────────────────────────────────────────────────
// The SPECTER2 bundle groups papers by `topic`/topics.json; the other two by
// `community`/communities.json. Everything else about them is the same shape.
const DATASETS = {
  forceatlas: { dir: "forceatlas_data", label: "ForceAtlas — citations",
                group: "community", groupFile: "communities.json", groupLabel: "communities" },
  gemini: { dir: "gemini_data", label: "Gemini — topics",
            group: "community", groupFile: "communities.json", groupLabel: "communities" },
  specter: { dir: "data", label: "SPECTER2 — topics",
             group: "topic", groupFile: "topics.json", groupLabel: "topics" },
};

// The three comparisons, left to right. `both` reuses the other two scans.
const PANELS = [
  { key: "abstract", label: "Abstract" },
  { key: "keywords", label: "Keywords" },
  { key: "both", label: "Abstract + keywords" },
];

const REDS = ["#fff5f0", "#fee0d2", "#fcbba1", "#fc9272", "#fb6a4a",
              "#ef3b2c", "#cb181d", "#a50f15", "#67000d"];
const FADE = 0.15;      // bottom of the ramp fades to transparent
const GRID_W = 340;     // KDE raster width in cells; height follows the aspect
const EXPORT_W = 2800;  // pixel width of a saved PNG
const EXPORT_GRID = 1000; // KDE raster width used for exports
// Screen sits on the dark page; an exported PNG has a transparent background
// and is usually viewed on white, so it borrows the script's dot style.
const DOT_COLOR = "rgba(230, 233, 239, 0.22)";
const DOT_COLOR_EXPORT = "rgba(215, 215, 215, 0.85)";
const RING_COLOR = "#67000d";   // same ring colour as word_heatmap.py

const state = {
  dataset: null,
  nodes: null,        // { xs, ys, ids, kw, comm }
  abstracts: null,    // id -> text
  communities: null,
  extent: null,       // [x0, x1, y0, y1]
  grid: null,         // { gx, gy, cell }
  background: null,   // blurred all-paper density, for enrichment + reuse
  lengths: null,      // { abstract, keywords } word counts per paper
  token: 0,           // cancels superseded recomputes
  last: null,         // weights/counts of the current view, for PNG export
};

const el = (id) => document.getElementById(id);
const status = el("status");

// ── Colour ramp ───────────────────────────────────────────────────────────
const LUT = buildLut();

function buildLut() {
  const stops = REDS.map((h) => [
    parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16),
  ]);
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const p = t * (stops.length - 1);
    const a = Math.min(Math.floor(p), stops.length - 2);
    const f = p - a;
    for (let c = 0; c < 3; c++) {
      lut[i * 4 + c] = stops[a][c] + (stops[a + 1][c] - stops[a][c]) * f;
    }
    lut[i * 4 + 3] = 255 * Math.min(1, t / FADE);
  }
  return lut;
}

// ── Matching (ported from word_heatmap.py) ────────────────────────────────
function plurals(word) {
  const forms = new Set([word, word + "s"]);
  if (/(?:s|x|z|ch|sh)$/i.test(word)) forms.add(word + "es");
  if (/[^aeiou]y$/i.test(word)) forms.add(word.slice(0, -1) + "ies");
  return [...forms];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function buildMatcher(words, mode) {
  if (!words.length) return null;
  if (mode === "substring") {
    return { re: new RegExp(words.map(escapeRe).join("|"), "gi"), forms: words };
  }
  if (mode === "prefix") {
    return {
      re: new RegExp("\\b(?:" + words.map(escapeRe).join("|") + ")", "gi"),
      forms: words.map((w) => w + "…"),
    };
  }
  const forms = words.flatMap(plurals).sort();
  return {
    re: new RegExp("\\b(?:" + forms.map(escapeRe).join("|") + ")\\b", "gi"),
    forms,
  };
}

// Quoted phrases stay whole; bare words are OR'd, exactly like the CLI.
function parseWords(str) {
  const out = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(str))) {
    const w = (m[1] || m[2]).trim();
    if (w) out.push(w);
  }
  return out;
}

// ── Loading ───────────────────────────────────────────────────────────────
async function fetchWithProgress(url, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body) return res.json();
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    const mb = (got / 1048576).toFixed(1);
    status.textContent = total
      ? `Loading ${label}… ${mb} MB of ${(total / 1048576).toFixed(1)} MB`
      : `Loading ${label}… ${mb} MB`;
  }
  const buf = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { buf.set(c, at); at += c.length; }
  status.textContent = `Parsing ${label}…`;
  await new Promise((r) => setTimeout(r, 0));
  return JSON.parse(new TextDecoder().decode(buf));
}

async function loadDataset(name) {
  state.dataset = name;
  state.abstracts = null;
  const dir = DATASETS[name].dir;

  status.className = "";
  status.textContent = "Loading papers…";
  const cfg = DATASETS[name];
  const [payload, groups] = await Promise.all([
    fetch(`${dir}/nodes.json`).then((r) => r.json()),
    fetch(`${dir}/${cfg.groupFile}`).then((r) => (r.ok ? r.json() : {})),
  ]);

  const nodes = payload.nodes;
  const n = nodes.length;
  const xs = new Float64Array(n), ys = new Float64Array(n);
  const ids = new Array(n), kw = new Array(n), comm = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = nodes[i].x; ys[i] = nodes[i].y;
    ids[i] = nodes[i].id; kw[i] = nodes[i].keywords || "";
    comm[i] = nodes[i][cfg.group];
  }
  state.nodes = { xs, ys, ids, kw, comm, n };
  state.communities = groups;

  // Extent + raster geometry, with the same 3% margin the script uses.
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    if (xs[i] < x0) x0 = xs[i]; if (xs[i] > x1) x1 = xs[i];
    if (ys[i] < y0) y0 = ys[i]; if (ys[i] > y1) y1 = ys[i];
  }
  const pad = 0.03 * Math.max(x1 - x0, y1 - y0);
  state.extent = [x0 - pad, x1 + pad, y0 - pad, y1 + pad];
  const [ex0, ex1, ey0, ey1] = state.extent;
  const gx = GRID_W;
  const gy = Math.max(1, Math.round(GRID_W * (ey1 - ey0) / (ex1 - ex0)));
  state.grid = { gx, gy, cell: (ex1 - ex0) / gx };

  state.lengths = null;
  state.background = null;

  status.textContent = `Loading abstracts (6 MB, once)…`;
  state.abstracts = await fetchWithProgress(`${dir}/abstracts.json`, "abstracts");
  status.textContent = "";
  recompute();
}

// ── KDE ───────────────────────────────────────────────────────────────────
function histogram(weights) {
  const { gx, gy } = state.grid;
  const [x0, x1, y0, y1] = state.extent;
  const { xs, ys, n } = state.nodes;
  const h = new Float32Array(gx * gy);
  const sx = gx / (x1 - x0), sy = gy / (y1 - y0);
  for (let i = 0; i < n; i++) {
    const w = weights ? weights[i] : 1;
    if (!w) continue;
    const cx = Math.min(gx - 1, Math.max(0, (xs[i] - x0) * sx | 0));
    const cy = Math.min(gy - 1, Math.max(0, (ys[i] - y0) * sy | 0));
    h[cy * gx + cx] += w;
  }
  return h;
}

// Separable Gaussian blur, sigma in cells.
function blur(src, gx, gy, sigma) {
  if (sigma < 0.3) return src;
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += k[i + r];
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;

  const tmp = new Float32Array(gx * gy);
  for (let y = 0; y < gy; y++) {
    for (let x = 0; x < gx; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i;
        if (xx >= 0 && xx < gx) acc += src[y * gx + xx] * k[i + r];
      }
      tmp[y * gx + x] = acc;
    }
  }
  const out = new Float32Array(gx * gy);
  for (let y = 0; y < gy; y++) {
    for (let x = 0; x < gx; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i;
        if (yy >= 0 && yy < gy) acc += tmp[yy * gx + x] * k[i + r];
      }
      out[y * gx + x] = acc;
    }
  }
  return out;
}

function sigmaCells() {
  const [x0, x1, y0, y1] = state.extent;
  const pct = Number(el("bw").value) / 1000; // slider 5..60 -> 0.5%..6%
  return (pct * Math.max(x1 - x0, y1 - y0)) / state.grid.cell;
}

function backgroundField(sigma) {
  const { gx, gy } = state.grid;
  return blur(histogram(null), gx, gy, sigma);
}

function field(weights, sigma, mode, background) {
  const { gx, gy } = state.grid;
  let f = blur(histogram(weights), gx, gy, sigma);
  if (mode === "enrichment") {
    let bgMax = 0;
    for (let i = 0; i < background.length; i++) bgMax = Math.max(bgMax, background[i]);
    const floor = bgMax * 0.03;
    const out = new Float32Array(f.length);
    for (let i = 0; i < f.length; i++) {
      if (background[i] > 0) {
        out[i] = (f[i] / background[i]) * Math.min(1, background[i] / floor);
      }
    }
    f = out;
  }
  let max = 0;
  for (let i = 0; i < f.length; i++) max = Math.max(max, f[i]);
  if (max > 0) for (let i = 0; i < f.length; i++) f[i] /= max;
  return f;
}

// ── Counting + weighting ──────────────────────────────────────────────────
function countMatches(matcher, which) {
  const { n, ids, kw } = state.nodes;
  const counts = new Int32Array(n);
  if (!matcher) return counts;
  for (let i = 0; i < n; i++) {
    const text = which === "abstract" ? (state.abstracts[ids[i]] || "") : kw[i];
    if (!text) continue;
    const m = text.match(matcher.re);
    if (m) counts[i] = m.length;
  }
  return counts;
}

function wordLengths(which) {
  if (!state.lengths) state.lengths = {};
  if (state.lengths[which]) return state.lengths[which];
  const { n, ids, kw } = state.nodes;
  const len = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const text = which === "abstract" ? (state.abstracts[ids[i]] || "") : kw[i];
    len[i] = text ? text.split(/\s+/).length : 0;
  }
  state.lengths[which] = len;
  return len;
}

function weightsFrom(counts, lengths, how) {
  const w = new Float32Array(counts.length);
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i];
    if (!c) continue;
    if (how === "presence") w[i] = 1;
    else if (how === "count") w[i] = c;
    else if (how === "log") w[i] = Math.log1p(c);
    else w[i] = (c / Math.max(1, lengths[i])) * 1000;
  }
  return w;
}

// ── Painting ──────────────────────────────────────────────────────────────
// Draw a field onto a canvas. `grid` says what raster `f` is on; `pxW` sets the
// pixel width (the screen uses the CSS width x devicePixelRatio, exports use a
// much larger one). Mark sizes scale with pxW so an export looks like the
// screen, only sharper.
function paint(canvas, f, counts, grid, pxW, setStyle, exporting) {
  const { gx, gy } = grid;
  const [x0, x1, y0, y1] = state.extent;
  canvas.width = Math.round(pxW);
  canvas.height = Math.round(pxW * (gy / gx));
  if (setStyle) canvas.style.height = Math.round(canvas.height / (window.devicePixelRatio || 1)) + "px";

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const sx = canvas.width / (x1 - x0), sy = canvas.height / (y1 - y0);
  const k = canvas.width / 420;            // mark scale, 1 at screen size

  if (el("dots").checked) {
    const { xs, ys, n } = state.nodes;
    ctx.fillStyle = exporting ? DOT_COLOR_EXPORT : DOT_COLOR;
    const sz = Math.max(1, 1.1 * k);
    for (let i = 0; i < n; i++) {
      // canvas y grows downward, data y grows up
      ctx.fillRect((xs[i] - x0) * sx, canvas.height - (ys[i] - y0) * sy, sz, sz);
    }
  }

  const img = new ImageData(gx, gy);
  for (let y = 0; y < gy; y++) {
    for (let x = 0; x < gx; x++) {
      const v = f[(gy - 1 - y) * gx + x];           // flip to image order
      const t = Math.max(0, Math.min(255, Math.round(v * 255)));
      const o = (y * gx + x) * 4;
      img.data[o] = LUT[t * 4];
      img.data[o + 1] = LUT[t * 4 + 1];
      img.data[o + 2] = LUT[t * 4 + 2];
      img.data[o + 3] = LUT[t * 4 + 3];
    }
  }
  const off = document.createElement("canvas");
  off.width = gx; off.height = gy;
  off.getContext("2d").putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(off, 0, 0, gx, gy, 0, 0, canvas.width, canvas.height);

  // Ring each matching paper, on top of the heat (the script's --points).
  if (counts && el("rings").checked) {
    const { xs, ys, n } = state.nodes;
    const r = Math.max(1.5, 2.2 * k);
    ctx.strokeStyle = RING_COLOR;
    ctx.lineWidth = Math.max(0.8, 0.9 * k);
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      if (!counts[i]) continue;
      const px = (xs[i] - x0) * sx, py = canvas.height - (ys[i] - y0) * sy;
      ctx.moveTo(px + r, py);
      ctx.arc(px, py, r, 0, Math.PI * 2);
    }
    ctx.stroke();
  }
}

function topCommunities(counts, limit = 3) {
  const { comm, n } = state.nodes;
  const papers = new Map();
  for (let i = 0; i < n; i++) {
    if (counts[i] > 0) papers.set(comm[i], (papers.get(comm[i]) || 0) + 1);
  }
  return [...papers.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([cid, c]) => ({
      name: (state.communities[String(cid)] || {}).name || `#${cid}`,
      count: c,
    }));
}

// ── Panels ────────────────────────────────────────────────────────────────
function buildPanels() {
  const grid = el("grid");
  grid.innerHTML = "";
  for (const p of PANELS) {
    const div = document.createElement("div");
    div.className = "panel";
    div.innerHTML = `
      <h2>${p.label}</h2>
      <div class="count" id="count-${p.key}"></div>
      <canvas id="canvas-${p.key}"></canvas>
      <div class="comm" id="comm-${p.key}"></div>
      <button class="save" data-key="${p.key}">Save PNG</button>`;
    grid.appendChild(div);
  }
  grid.querySelectorAll(".save").forEach((b) => {
    b.addEventListener("click", () => savePng(b.dataset.key));
  });
}

// Exports are re-rendered from scratch: the KDE is recomputed on a much finer
// raster and drawn at EXPORT_W pixels, so the file isn't an upscaled screenshot.
function savePng(key) {
  const last = state.last;
  if (!last || !last.weights[key]) return;
  const btn = document.querySelector(`.save[data-key="${key}"]`);
  const label = btn.textContent;
  btn.textContent = "Rendering…";

  setTimeout(() => {
    const [x0, x1, y0, y1] = state.extent;
    const gx = EXPORT_GRID;
    const gy = Math.max(1, Math.round(gx * (y1 - y0) / (x1 - x0)));
    const grid = { gx, gy, cell: (x1 - x0) / gx };

    const saved = state.grid;
    state.grid = grid;                       // field()/histogram() read state.grid
    const sigma = sigmaCells();
    const bg = last.mode === "enrichment" ? backgroundField(sigma) : null;
    const f = field(last.weights[key], sigma, last.mode, bg);
    state.grid = saved;

    const canvas = document.createElement("canvas");
    paint(canvas, f, last.counts[key], grid, EXPORT_W, false, true);

    const words = parseWords(el("words").value).join("_").replace(/\W+/g, "") || "map";
    const a = document.createElement("a");
    a.download = `wordmap_${state.dataset}_${key}_${words}_${EXPORT_W}px.png`;
    a.href = canvas.toDataURL("image/png");
    a.click();
    btn.textContent = label;
  }, 0);
}

// ── Recompute ─────────────────────────────────────────────────────────────
let timer = null;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(recompute, 220);
}

async function recompute() {
  if (!state.nodes || !state.abstracts) return;
  const token = ++state.token;

  const words = parseWords(el("words").value);
  const matcher = buildMatcher(words, el("match").value);
  el("forms").innerHTML = matcher
    ? `searching <code>${matcher.forms.join(" | ")}</code>`
    : "";
  if (!matcher) {
    status.textContent = "Type a word to search.";
    for (const p of PANELS) {
      el(`count-${p.key}`).textContent = "";
      el(`comm-${p.key}`).innerHTML = "";
      const c = el(`canvas-${p.key}`);
      c.getContext("2d").clearRect(0, 0, c.width, c.height);
    }
    return;
  }

  status.textContent = "Computing…";
  await new Promise((r) => setTimeout(r, 0));
  if (token !== state.token) return;

  // Two scans; "both" is their sum, which also avoids a phrase matching across
  // the join between an abstract and its keyword list.
  const counts = {
    abstract: countMatches(matcher, "abstract"),
    keywords: countMatches(matcher, "keywords"),
  };
  counts.both = counts.abstract.map((c, i) => c + counts.keywords[i]);
  if (token !== state.token) return;

  const sigma = sigmaCells();
  const how = el("weight").value;
  const mode = el("mode").value;
  const background = mode === "enrichment" ? backgroundField(sigma) : null;
  // Kept so "Save PNG" can re-render at export resolution without rescanning.
  state.last = { counts, weights: {}, mode };

  for (const p of PANELS) {
    if (token !== state.token) return;
    const c = counts[p.key];
    let lengths = null;
    if (how === "rate") {
      lengths = p.key === "both"
        ? wordLengths("abstract").map((v, i) => v + wordLengths("keywords")[i])
        : wordLengths(p.key);
    }
    const w = weightsFrom(c, lengths, how);
    state.last.weights[p.key] = w;
    const f = field(w, sigma, mode, background);
    const canvas = el(`canvas-${p.key}`);
    const dpr = window.devicePixelRatio || 1;
    paint(canvas, f, c, state.grid, (canvas.clientWidth || 360) * dpr, true);

    let papers = 0, mentions = 0;
    for (let i = 0; i < c.length; i++) { if (c[i]) { papers++; mentions += c[i]; } }
    const pct = (100 * papers / state.nodes.n).toFixed(2);
    el(`count-${p.key}`).textContent =
      `${papers.toLocaleString()} papers (${pct}%) · ${mentions.toLocaleString()} mentions`;
    const top = topCommunities(c);
    el(`comm-${p.key}`).innerHTML = top.length
      ? `<div class="comm-head">top ${DATASETS[state.dataset].groupLabel}</div>` +
        top.map((t) => `<div><span class="name">${t.name}</span>` +
                       `<span class="n">${t.count}</span></div>`).join("")
      : `<div><span class="name">no matches</span></div>`;
    await new Promise((r) => setTimeout(r, 0));
  }
  if (token === state.token) status.textContent = "";
}

// ── Wiring ────────────────────────────────────────────────────────────────
function init() {
  const sel = el("dataset");
  for (const [key, cfg] of Object.entries(DATASETS)) {
    const o = document.createElement("option");
    o.value = key; o.textContent = cfg.label;
    sel.appendChild(o);
  }
  buildPanels();

  el("words").addEventListener("input", schedule);
  el("match").addEventListener("change", recompute);
  el("weight").addEventListener("change", recompute);
  el("mode").addEventListener("change", recompute);
  el("dots").addEventListener("change", recompute);
  el("rings").addEventListener("change", recompute);
  el("bw").addEventListener("input", () => {
    el("bw-val").textContent = (Number(el("bw").value) / 10).toFixed(1) + "%";
    schedule();
  });
  sel.addEventListener("change", () => {
    loadDataset(sel.value).catch(fail);
  });
  let rt = null;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(recompute, 200);
  });

  loadDataset("forceatlas").catch(fail);
}

function fail(err) {
  status.className = "err";
  status.textContent =
    `${err.message} — serve the folder over HTTP (python -m http.server 8123), ` +
    `fetch() won't read file:// URLs.`;
  console.error(err);
}

init();
