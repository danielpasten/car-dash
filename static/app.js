'use strict';

// ── Tiny DOM helpers (text is always set as text, never HTML) ─────────
const SVGNS = 'http://www.w3.org/2000/svg';

function h(tag, attrs, ...kids) {
  return fill(document.createElement(tag), attrs, kids);
}
function s(tag, attrs, ...kids) {
  return fill(document.createElementNS(SVGNS, tag), attrs, kids);
}
function fill(el, attrs, kids) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const view = document.getElementById('view');
const tabs = document.getElementById('tabs');
const tip = document.getElementById('tip');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── Formatting ────────────────────────────────────────────────────────
const money = (v) => v == null ? '—'
  : '$' + v.toLocaleString('en-US', { minimumFractionDigits: v >= 1000 ? 0 : 2, maximumFractionDigits: v >= 1000 ? 0 : 2 });
const kwh = (v) => v == null ? '—' : `${v.toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: v < 100 ? 1 : 0 })} kWh`;
const rate = (v) => v == null ? '—' : v < 1 ? `${(v * 100).toFixed(v * 100 < 10 ? 1 : 0)}¢` : money(v);
const num = (v, d = 0) => v == null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: d });
const dur = (m) => m == null ? '—' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? (m % 60) + ' min' : ''}`.trim();
const clock = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const monthName = (key, withYear = true) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', withYear ? { month: 'long', year: 'numeric' } : { month: 'short' });
};
function dayLabel(iso) {
  const d = new Date(iso), today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
function ago(iso) {
  if (!iso) return 'never';
  const min = Math.round((Date.now() - new Date(iso)) / 6e4);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 60 * 24) return `${Math.round(min / 60)} h ago`;
  return dayLabel(iso);
}
const thisMonth = () => new Date().toLocaleDateString('en-CA').slice(0, 7);
const shiftMonth = (key, n) => {
  const [y, m] = key.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}`;
};
function priceText(p) {
  if (!p.rate && !p.fee) return 'Free';
  const unit = p.billing === 'per_minute' ? 'minute' : 'kWh';
  const base = p.rate ? `${rate(p.rate)} per ${unit}` : '';
  const fee = p.fee ? `${money(p.fee)} per session` : '';
  return [base, fee].filter(Boolean).join(' plus ');
}

// Place → color slot. Places take slots in id order so a place keeps its
// color forever; Supercharger is fixed; Untagged is neutral gray.
let placeOrder = [];
function placeClass(place, kind) {
  if (kind === 'supercharger') return 'psc';
  if (kind === 'untagged') return 'pnone';
  const i = placeOrder.indexOf(place);
  return i >= 0 && i < 5 ? `p${i + 1}` : 'pnone';
}

// ── API + stale-while-revalidate cache ────────────────────────────────
// A view renders at once from the last copy it saw, then quietly re-renders
// if the server has something newer. Tab switches feel instant.
class SignedOut extends Error {}
const cache = new Map();
let fresh = false;          // true while a pull-to-refresh / live refresh re-render runs
let staleReads = [];        // paths served from cache during the current render

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== '/api/login') throw new SignedOut();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.error || `Request failed (${res.status})`);
  return data;
}

async function load(path) {
  if (!fresh && cache.has(path)) {
    staleReads.push(path);
    return cache.get(path).data;
  }
  const data = await api(path);
  cache.set(path, { data, json: JSON.stringify(data) });
  return data;
}

function invalidate(prefix) {
  for (const k of [...cache.keys()]) if (!prefix || k.startsWith(prefix)) cache.delete(k);
}

async function mutate(path, opts) {
  const out = await api(path, opts);
  invalidate('/api/');       // costs and places touch every screen
  return out;
}

// ── Tooltip ───────────────────────────────────────────────────────────
function showTip(x, y, ...lines) {
  tip.replaceChildren(...lines.filter(Boolean).map((l, i) => h('div', null, i === 0 ? h('b', null, l) : l)));
  tip.hidden = false;
  const w = tip.offsetWidth / 2 + 8;
  tip.style.left = Math.min(Math.max(x, w), window.innerWidth - w) + 'px';
  tip.style.top = Math.max(y, tip.offsetHeight + 16) + 'px';
}
const hideTip = () => { tip.hidden = true; };
window.addEventListener('scroll', hideTip, { passive: true });

// ── Motion helpers (first paint of a view only; never on quiet refresh) ─
let animate = true;
function countUp(el, to, suffix = '') {
  if (!animate || reduceMotion || to == null) { el.textContent = `${to ?? '—'}${suffix}`; return; }
  const t0 = performance.now(), d = 700;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / d), e = 1 - Math.pow(1 - k, 3);
    el.textContent = `${Math.round(to * e)}${suffix}`;
    if (k < 1) requestAnimationFrame(step);
  };
  el.textContent = `0${suffix}`;
  requestAnimationFrame(step);
}

// ── Charts (hand-built SVG) ───────────────────────────────────────────
function niceMax(v) {
  if (!v || v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// Monthly spend: one series, current month emphasized, the rest gray.
function spendChart(history, current, onPick) {
  const wrap = h('div', { class: 'chart' });
  const grow = animate && !reduceMotion;
  requestAnimationFrame(() => {
    const W = Math.max(280, wrap.clientWidth), H = 150, L = 40, T = 18, B = 22;
    const plotH = H - T - B, band = (W - L) / history.length;
    const max = niceMax(Math.max(...history.map((d) => d.cost)));
    const y = (v) => T + plotH - (v / max) * plotH;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img',
      'aria-label': `Charging spend for the 12 months ending ${monthName(current)}` });

    for (const t of [0, max / 2, max]) {
      svg.append(s('line', { class: t ? 'grid' : 'base', x1: L, x2: W, y1: y(t), y2: y(t) }));
      svg.append(s('text', { x: L - 6, y: y(t) + 4, 'text-anchor': 'end' }, money(t).replace('.00', '')));
    }
    history.forEach((d, i) => {
      const cx = L + band * i + band / 2, bw = Math.min(24, band * 0.62);
      const top = y(d.cost), hgt = Math.max(0, T + plotH - top);
      const isCur = d.month === current;
      if (hgt > 0) {
        const r = Math.min(4, hgt, bw / 2);
        svg.append(s('path', { class: 'col' + (isCur ? ' is-current' : '') + (grow ? ' grow' : ''),
          style: grow ? { animationDelay: `${i * 35}ms` } : null,
          d: `M${cx - bw / 2},${T + plotH} V${top + r} q0,-${r} ${r},-${r} H${cx + bw / 2 - r} q${r},0 ${r},${r} V${T + plotH} Z` }));
      }
      if (isCur && d.cost > 0) {
        const lastCol = i === history.length - 1;
        // on the last column the label runs left over its neighbour, so lift it clear of that bar too
        const capY = (lastCol && i > 0 ? Math.min(top, y(history[i - 1].cost)) : top) - 6;
        svg.append(s('text', { class: 'cap' + (grow ? ' fade-late' : ''), x: lastCol ? cx + bw / 2 : cx, y: capY,
          'text-anchor': lastCol ? 'end' : 'middle' }, money(d.cost)));
      }
      svg.append(s('text', { x: cx, y: H - 6, 'text-anchor': 'middle' }, monthName(d.month, false).slice(0, 1)));
      const hit = s('rect', { class: 'col-hit', x: L + band * i, y: T, width: band, height: plotH + B, tabindex: 0,
        role: 'button', 'aria-label': `${monthName(d.month)}: ${money(d.cost)} for ${kwh(d.kwh)}` });
      const show = () => {
        const b = hit.getBoundingClientRect();
        showTip(b.left + b.width / 2, b.top + (top - T) * (b.height / (plotH + B)),
          monthName(d.month), `${money(d.cost)} for ${kwh(d.kwh)}`,
          d.missing ? `${d.missing} without a cost` : null);
      };
      hit.addEventListener('pointerenter', show);
      hit.addEventListener('focus', show);
      hit.addEventListener('pointerleave', hideTip);
      hit.addEventListener('blur', hideTip);
      hit.addEventListener('click', () => { hideTip(); onPick(d.month); });
      hit.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(d.month); } });
      svg.append(hit);
    });
    wrap.append(svg);
  });
  return wrap;
}

// Line over time: 2px line + 10% wash, crosshair on hover/drag. Single series,
// so no legend; the section title names it. `tipLines(p)` builds the tooltip,
// `onHover(i|null)` lets a map follow along.
function lineChart(points, { value, unit, tipLines, onHover, height = 170, zero = false, xLabel = clock, tight = false }) {
  const pts = points.filter((p) => value(p) != null);
  if (pts.length < 2) return h('p', { class: 'meta' }, 'Not enough readings to draw this.');
  const wrap = h('div', { class: 'chart' });
  const draw = animate && !reduceMotion;
  requestAnimationFrame(() => {
    const W = Math.max(280, wrap.clientWidth), H = height, L = 38, T = 22, B = 22, R = 8;
    const t0 = new Date(pts[0].t).getTime(), t1 = new Date(pts[pts.length - 1].t).getTime();
    const vals = pts.map(value);
    let hi = niceMax(Math.max(...vals, 0));
    let lo = Math.min(...vals);
    lo = zero || lo >= 0 ? Math.min(0, lo < 0 ? -niceMax(-lo) : 0) : Math.floor(lo / 10) * 10;
    if (!zero && lo > 0) lo = 0;
    if (!zero && Math.min(...vals) > 0) { lo = Math.floor(Math.min(...vals) / 10) * 10; hi = Math.max(hi, lo + 10); }
    if (tight) {    // slow-moving values (e.g. battery range): frame the data, not zero
      lo = Math.floor((Math.min(...vals) * 0.96) / 10) * 10;
      hi = Math.ceil((Math.max(...vals) * 1.02) / 10) * 10;
    }
    const x = (t) => L + ((new Date(t).getTime() - t0) / Math.max(1, t1 - t0)) * (W - L - R);
    const y = (v) => T + (H - T - B) - ((v - lo) / (hi - lo || 1)) * (H - T - B);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img',
      'aria-label': `${unit}: from ${num(Math.min(...vals))} to ${num(Math.max(...vals))}` });
    const ticks = lo < 0 ? [lo, 0, hi] : [lo, (lo + hi) / 2, hi];
    for (const t of ticks) {
      svg.append(s('line', { class: t === 0 || t === lo ? 'base' : 'grid', x1: L, x2: W - R, y1: y(t), y2: y(t) }));
      svg.append(s('text', { x: L - 6, y: y(t) + 4, 'text-anchor': 'end' }, num(t)));
    }
    svg.append(s('text', { x: 0, y: 10 }, unit));
    // first, middle-of-span and last times (readings can bunch up, so not the middle reading)
    const mid = new Date((t0 + t1) / 2).toISOString();
    for (const [t, anchor] of [[pts[0].t, 'start'], [mid, 'middle'], [pts[pts.length - 1].t, 'end']]) {
      svg.append(s('text', { x: x(t), y: H - 6, 'text-anchor': anchor }, xLabel(t)));
    }
    const base = y(Math.max(lo, 0));
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(value(p)).toFixed(1)}`).join('');
    svg.append(s('path', { class: 'area' + (draw ? ' fade-late' : ''), d: `${line}L${x(pts[pts.length - 1].t)},${base}L${x(pts[0].t)},${base}Z` }));
    const path = s('path', { class: 'line', d: line });
    svg.append(path);
    const cross = s('line', { class: 'cross', y1: T, y2: H - B, visibility: 'hidden' });
    const marker = s('circle', { class: 'marker', r: 5, visibility: 'hidden' });
    svg.append(cross, marker);

    const hit = s('rect', { x: L, y: 0, width: W - L - R, height: H, fill: 'transparent' });
    const move = (e) => {
      const b = svg.getBoundingClientRect();
      const px = ((e.clientX - b.left) / b.width) * W;
      let bi = 0;
      pts.forEach((p, i) => { if (Math.abs(x(p.t) - px) < Math.abs(x(pts[bi].t) - px)) bi = i; });
      const best = pts[bi], bx = x(best.t), by = y(value(best));
      cross.setAttribute('x1', bx); cross.setAttribute('x2', bx); cross.setAttribute('visibility', 'visible');
      marker.setAttribute('cx', bx); marker.setAttribute('cy', by); marker.setAttribute('visibility', 'visible');
      showTip(b.left + (bx / W) * b.width, b.top + (by / H) * b.height, xLabel(best.t), ...tipLines(best));
      onHover?.(best);
    };
    const leave = () => { cross.setAttribute('visibility', 'hidden'); marker.setAttribute('visibility', 'hidden'); hideTip(); onHover?.(null); };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', leave);
    hit.addEventListener('pointercancel', leave);
    svg.append(hit);
    wrap.append(svg);
    if (draw) {
      const len = path.getTotalLength();
      path.style.strokeDasharray = `${len}`;
      path.style.strokeDashoffset = `${len}`;
      requestAnimationFrame(() => path.classList.add('draw'));
    }
  });
  return wrap;
}

const powerChart = (curve) => lineChart(curve, { value: (p) => p.kw, unit: 'kW', zero: true,
  tipLines: (p) => [`${p.kw} kW, battery ${p.pct}%`] });

// Columns with a reference line (e.g. weekly Wh/mi against the car's rated figure).
function refColumns(items, { value, label, ref, refLabel, current, tipLines, unit }) {
  const wrap = h('div', { class: 'chart' });
  const grow = animate && !reduceMotion;
  requestAnimationFrame(() => {
    const W = Math.max(280, wrap.clientWidth), H = 160, L = 40, T = 18, B = 22, R = 4;
    const plotH = H - T - B, band = (W - L - R) / items.length;
    const vals = items.map(value).filter((v) => v != null);
    const max = niceMax(Math.max(...vals, ref || 0) * 1.08);
    const y = (v) => T + plotH - (v / max) * plotH;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': unit });
    for (const t of [0, max / 2, max]) {
      svg.append(s('line', { class: t ? 'grid' : 'base', x1: L, x2: W - R, y1: y(t), y2: y(t) }));
      svg.append(s('text', { x: L - 6, y: y(t) + 4, 'text-anchor': 'end' }, num(t)));
    }
    items.forEach((d, i) => {
      const v = value(d);
      const cx = L + band * i + band / 2, bw = Math.min(24, band * 0.62);
      if (v != null && v > 0) {
        const top = y(v), hgt = T + plotH - top, r = Math.min(4, hgt, bw / 2);
        svg.append(s('path', { class: 'col' + (current(d) ? ' is-current' : '') + (grow ? ' grow' : ''),
          style: grow ? { animationDelay: `${i * 30}ms` } : null,
          d: `M${cx - bw / 2},${T + plotH} V${top + r} q0,-${r} ${r},-${r} H${cx + bw / 2 - r} q${r},0 ${r},${r} V${T + plotH} Z` }));
      }
      if (i % 2 === (items.length - 1) % 2) svg.append(s('text', { x: cx, y: H - 6, 'text-anchor': 'middle' }, label(d)));
      const hit = s('rect', { class: 'col-hit', x: L + band * i, y: T, width: band, height: plotH + B, tabindex: 0,
        'aria-label': tipLines(d).join(', ') });
      const show = () => { const b = hit.getBoundingClientRect(); showTip(b.left + b.width / 2, b.top + (v ? (y(v) - T) * (b.height / (plotH + B)) : 0), ...tipLines(d)); };
      hit.addEventListener('pointerenter', show); hit.addEventListener('focus', show);
      hit.addEventListener('pointerleave', hideTip); hit.addEventListener('blur', hideTip);
      svg.append(hit);
    });
    if (ref) {
      svg.append(s('line', { class: 'refline', x1: L, x2: W - R, y1: y(ref), y2: y(ref) }));
      svg.append(s('text', { class: 'reflabel', x: W - R, y: y(ref) - 5, 'text-anchor': 'end' }, refLabel));
    }
    wrap.append(svg);
  });
  return wrap;
}

// Efficiency against outside temperature: one dot per drive, rated as a reference line.
function tempScatter(rows, { rated, unit, tunit }) {
  const wrap = h('div', { class: 'chart' });
  if (rows.length < 3) return h('p', { class: 'meta' }, 'A few more drives and this fills in.');
  requestAnimationFrame(() => {
    const W = Math.max(280, wrap.clientWidth), H = 190, L = 40, T = 16, B = 26, R = 8;
    const xs = rows.map((r) => r.temp), ys = rows.map((r) => r.wh_per);
    const x0 = Math.floor(Math.min(...xs) / 10) * 10, x1 = Math.ceil(Math.max(...xs) / 10) * 10 || x0 + 10;
    const sorted = [...ys].sort((a, b) => a - b);
    const cap = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.97))] * 1.15;
    const yMax = Math.ceil(Math.max(Math.min(Math.max(...ys), cap), rated || 0) * 1.06 / 25) * 25;
    const floor = sorted[Math.floor(sorted.length * 0.03)] * 0.85;
    const yMin = Math.max(0, Math.floor(Math.min(Math.max(sorted[0], floor), rated || 1e9) * 0.92 / 25) * 25);
    const X = (v) => L + ((v - x0) / (x1 - x0 || 1)) * (W - L - R);
    const Y = (v) => T + (H - T - B) - ((Math.min(Math.max(v, yMin), yMax) - yMin) / (yMax - yMin || 1)) * (H - T - B);   // outliers sit on the edge
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Energy use per ${unit} by outside temperature` });
    for (const t of [yMin, (yMin + yMax) / 2, yMax]) {
      svg.append(s('line', { class: t === yMin ? 'base' : 'grid', x1: L, x2: W - R, y1: Y(t), y2: Y(t) }));
      svg.append(s('text', { x: L - 6, y: Y(t) + 4, 'text-anchor': 'end' }, num(t)));
    }
    for (let t = x0; t <= x1; t += x1 - x0 > 40 ? 20 : 10) svg.append(s('text', { x: X(t), y: H - 8, 'text-anchor': 'middle' }, `${t}°`));
    if (rated) svg.append(s('line', { class: 'refline', x1: L, x2: W - R, y1: Y(rated), y2: Y(rated) }));
    const dots = rows.map((r) => s('circle', { class: 'dot-pt', cx: X(r.temp), cy: Y(r.wh_per), r: 4 }));
    svg.append(...dots);
    if (rated) svg.append(s('text', { class: 'reflabel', x: L + 4, y: Y(rated) + 15 }, `Rated ${rated}`));
    const hit = s('rect', { x: L, y: 0, width: W - L - R, height: H, fill: 'transparent' });
    hit.addEventListener('pointermove', (e) => {
      const b = svg.getBoundingClientRect();
      const px = ((e.clientX - b.left) / b.width) * W, py = ((e.clientY - b.top) / b.height) * H;
      let bi = 0, bd = Infinity;
      rows.forEach((r, i) => { const d = (X(r.temp) - px) ** 2 + (Y(r.wh_per) - py) ** 2; if (d < bd) { bd = d; bi = i; } });
      dots.forEach((d, i) => d.classList.toggle('on', i === bi));
      const r = rows[bi];
      showTip(b.left + (X(r.temp) / W) * b.width, b.top + (Y(r.wh_per) / H) * b.height,
        `${r.temp}°${tunit}`, `${r.wh_per} Wh/${unit} over ${num(r.distance, 1)} ${unit}`);
    });
    hit.addEventListener('pointerleave', () => { dots.forEach((d) => d.classList.remove('on')); hideTip(); });
    svg.append(hit);
    wrap.append(svg);
  });
  return wrap;
}

// ── Map (OpenStreetMap tiles) ─────────────────────────────────────────
const TILE = 256;
// Tile server and credit come from the server (MAP_TILES / MAP_CREDIT) via <meta> tags.
const metaContent = (name, fallback) => document.querySelector(`meta[name="${name}"]`)?.content || fallback;
const TILE_URL = metaContent('map-tiles', 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
const TILE_CREDIT = metaContent('map-credit', '© OpenStreetMap');
const lon2x = (lon, z) => ((lon + 180) / 360) * TILE * 2 ** z;
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z;
};
const x2lon = (x, z) => (x / (TILE * 2 ** z)) * 360 - 180;
const y2lat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / (TILE * 2 ** z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

// Pannable, zoomable tile map. Overlays redraw through `onPaint(project, size)`.
function tileMap({ lat, lon, zoom = 15, height, label, onPaint, onMoveEnd, onTap }) {
  let z = zoom, cx = lon2x(lon, z), cy = lat2y(lat, z);
  const tiles = h('div', { class: 'map-tiles' });
  const overlay = s('svg', { class: 'map-overlay' });
  const zoomBtns = h('div', { class: 'map-zoom' },
    h('button', { type: 'button', 'aria-label': 'Zoom in', onclick: () => zoomBy(1) }, '+'),
    h('button', { type: 'button', 'aria-label': 'Zoom out', onclick: () => zoomBy(-1) }, '−'));
  const el = h('div', { class: 'map', role: 'application', 'aria-label': label, style: height ? { height: `${height}px` } : null },
    tiles, overlay, zoomBtns, h('span', { class: 'map-credit' }, TILE_CREDIT));
  const imgs = new Map();
  const project = (la, lo) => [lon2x(lo, z) - cx + el.clientWidth / 2, lat2y(la, z) - cy + el.clientHeight / 2];

  function paint() {
    const w = el.clientWidth, ht = el.clientHeight;
    if (!w) return;
    const n = 2 ** z;
    const x0 = Math.floor((cx - w / 2) / TILE), x1 = Math.floor((cx + w / 2) / TILE);
    const y0 = Math.floor((cy - ht / 2) / TILE), y1 = Math.floor((cy + ht / 2) / TILE);
    const keep = new Set();
    for (let tx = x0; tx <= x1; tx++) for (let ty = y0; ty <= y1; ty++) {
      if (ty < 0 || ty >= n) continue;
      const wx = ((tx % n) + n) % n;
      const key = `${z}/${wx}/${ty}`;
      keep.add(key);
      let img = imgs.get(key);
      if (!img) {
        img = h('img', { alt: '', draggable: 'false', referrerpolicy: 'strict-origin-when-cross-origin',
          src: TILE_URL.replace('{z}', z).replace('{x}', wx).replace('{y}', ty) });
        img.addEventListener('load', () => img.classList.add('in'));
        imgs.set(key, img);
        tiles.append(img);
      }
      img.style.transform = `translate(${Math.round(tx * TILE - cx + w / 2)}px, ${Math.round(ty * TILE - cy + ht / 2)}px)`;
    }
    for (const [k, img] of imgs) if (!keep.has(k)) { img.remove(); imgs.delete(k); }
    overlay.setAttribute('viewBox', `0 0 ${w} ${ht}`);
    onPaint?.(project, { w, h: ht, z, overlay });
  }
  const center = () => ({ lat: y2lat(cy, z), lon: x2lon(cx, z) });
  function zoomBy(d) {
    const nz = Math.min(19, Math.max(3, z + d));
    if (nz === z) return;
    const c = center();
    z = nz; cx = lon2x(c.lon, z); cy = lat2y(c.lat, z);
    paint();
  }
  function fit(bounds, pad = 16) {
    const w = el.clientWidth || 340, ht = el.clientHeight || 260;
    const [s0, w0, n0, e0] = bounds;
    for (z = 18; z > 3; z--) {
      if (lon2x(e0, z) - lon2x(w0, z) <= w - pad * 2 && lat2y(s0, z) - lat2y(n0, z) <= ht - pad * 2) break;
    }
    cx = (lon2x(w0, z) + lon2x(e0, z)) / 2; cy = (lat2y(s0, z) + lat2y(n0, z)) / 2;
    paint();
  }

  // drag to pan, two fingers to zoom, tap for onTap
  const ptrs = new Map();
  let drag = null, pinch = null, moved = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    el.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    moved = false;
    if (ptrs.size === 1) drag = { x: e.clientX, y: e.clientY, cx, cy };
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), done: 0 };
      drag = null;
    }
    el.classList.add('dragging');
  });
  el.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const k = Math.log2(Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d);
      const step = Math.trunc(k * 1.4);
      if (step !== pinch.done) { zoomBy(step - pinch.done); pinch.done = step; }
      moved = true;
      return;
    }
    if (!drag) return;
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) moved = true;
    cx = drag.cx - (e.clientX - drag.x);
    cy = drag.cy - (e.clientY - drag.y);
    requestAnimationFrame(paint);
  });
  const end = (e) => {
    ptrs.delete(e.pointerId);
    if (ptrs.size) return;
    el.classList.remove('dragging');
    if (!moved && onTap) {
      const r = el.getBoundingClientRect();
      onTap(e.clientX - r.left, e.clientY - r.top);
    }
    if (drag || pinch) onMoveEnd?.(center());
    drag = null; pinch = null;
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', () => zoomBy(1));
  requestAnimationFrame(paint);
  new ResizeObserver(paint).observe(el);
  return { el, paint, fit, center, moveTo(p) { cx = lon2x(p.lon, z); cy = lat2y(p.lat, z); paint(); onMoveEnd?.(center()); } };
}

// Place picker: the map moves under a fixed pin; the circle is the geofence.
function placeMap({ lat, lon, radius, car, onMove }) {
  const ring = s('circle', { class: 'map-ring' });
  const pin = s('circle', { class: 'map-pin', r: 6 });
  const carDot = s('circle', { class: 'map-car-dot', r: 7, visibility: 'hidden' });
  const m = tileMap({ lat, lon, zoom: 17,
    label: 'Map. Drag to move the place; the circle is the area that counts as this place.',
    onMoveEnd: (c) => onMove(c),
    onPaint: (project, { w, h: ht, z, overlay }) => {
      if (!ring.parentNode) overlay.append(ring, carDot, pin);
      const c = m?.center() || { lat };
      const mpp = (156543.03392 * Math.cos((c.lat * Math.PI) / 180)) / 2 ** z;
      ring.setAttribute('cx', w / 2); ring.setAttribute('cy', ht / 2); ring.setAttribute('r', Math.max(4, radius / mpp));
      pin.setAttribute('cx', w / 2); pin.setAttribute('cy', ht / 2);
      if (car) {
        const [x, y] = project(car.lat, car.lon);
        carDot.setAttribute('cx', x); carDot.setAttribute('cy', y); carDot.setAttribute('visibility', 'visible');
      }
    } });
  return { el: m.el, setRadius(r) { radius = r; m.paint(); }, moveTo: (p) => m.moveTo(p) };
}

// Routes colored by efficiency class (-2..2). `routes` = [{id, points:[[lat,lon],...], e | per-point e}]
const EFF_LABEL = { '-2': 'Much better than rated', '-1': 'Better than rated', 0: 'About rated', 1: 'Worse than rated', 2: 'Much worse than rated' };
function routeMap({ routes, height = 300, onPick, fitTo }) {
  let follower = null;
  const all = routes.flatMap((r) => r.points);
  const lats = all.map((p) => p[0]), lons = all.map((p) => p[1]);
  const bounds = [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)];
  const m = tileMap({ lat: (bounds[0] + bounds[2]) / 2, lon: (bounds[1] + bounds[3]) / 2, zoom: 13, height,
    label: 'Map of drives, colored by efficiency',
    onTap: onPick && ((x, y) => {
      // nearest route within 18px
      let best = null, bd = 18 * 18;
      for (const r of routes) for (const p of r.points) {
        const [px, py] = proj(p[0], p[1]);
        const d = (px - x) ** 2 + (py - y) ** 2;
        if (d < bd) { bd = d; best = r; }
      }
      if (best) onPick(best);
    }),
    onPaint: (project, { overlay }) => {
      proj = project;
      overlay.replaceChildren();
      for (const r of routes) {
        const pts = r.points.map((p) => project(p[0], p[1]));
        const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
        overlay.append(s('path', { class: 'route-casing', d }));
      }
      for (const r of routes) {
        const pts = r.points.map((p) => project(p[0], p[1]));
        if (r.pointClasses) {
          // split into runs of the same class so each run is one path
          let run = [pts[0]], cls = r.pointClasses[0];
          const flush = () => { if (run.length > 1) overlay.append(s('path', { class: `route e${cls ?? 'x'}`,
            d: run.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('') })); };
          for (let i = 1; i < pts.length; i++) {
            const c = r.pointClasses[i] ?? cls;
            run.push(pts[i]);
            if (c !== cls) { flush(); run = [pts[i]]; cls = c; }
          }
          flush();
        } else {
          overlay.append(s('path', { class: `route e${r.e ?? 'x'}`,
            d: pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('') }));
        }
      }
      if (routes.length === 1) {
        const p = routes[0].points;
        const a = project(p[0][0], p[0][1]), b = project(p[p.length - 1][0], p[p.length - 1][1]);
        overlay.append(s('circle', { class: 'route-start', cx: a[0], cy: a[1], r: 6 }),
          s('circle', { class: 'route-end', cx: b[0], cy: b[1], r: 7 }));
      }
      follower = s('circle', { class: 'route-follow', r: 7, visibility: 'hidden' });
      overlay.append(follower);
    } });
  let proj = () => [0, 0];
  requestAnimationFrame(() => m.fit(fitTo || bounds));
  return {
    el: m.el,
    follow(p) {
      if (!follower) return;
      if (!p) { follower.setAttribute('visibility', 'hidden'); return; }
      const [x, y] = proj(p.lat, p.lon);
      follower.setAttribute('cx', x); follower.setAttribute('cy', y); follower.setAttribute('visibility', 'visible');
    },
  };
}

function effLegend() {
  return h('div', { class: 'map-legend', role: 'img', 'aria-label': 'Color scale: blue is better than the car’s rated efficiency, gray is about rated, red is worse' },
    h('span', null, 'Better'),
    h('span', { class: 'eff-ramp' }, [-2, -1, 0, 1, 2].map((k) => h('i', { class: `e${k}` }))),
    h('span', null, 'Worse'));
}

// ── Icons (stroke glyphs on a 24px grid) ──────────────────────────────
const ICONS = {
  back: 'M15 5l-7 7 7 7',
  fwd: 'M9 5l7 7-7 7',
  bolt: 'M13 2.5 4.5 13.5h6.5L10 21.5l8.5-11h-6.5z',
  road: 'M9 3 5 21M15 3l4 18M12 5v2.5M12 10.5v3M12 16.5v3',
  battery: 'M4 8h13.5A1.5 1.5 0 0 1 19 9.5v5a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 14.5v-5A1.5 1.5 0 0 1 4 8zM21.5 11v2M5.5 11v2M8.5 11v2',
  gauge: 'M4.2 17.5a8.5 8.5 0 1 1 15.6 0M12 13.5l3.8-4.3M12 13.5h.01',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5a7.5 7.5 0 0 1 15 0',
  plus: 'M12 5v14M5 12h14',
  pin: 'M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21zM12 12.3a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6z',
  bell: 'M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0',
  fuel: 'M5 20.5V5a1.5 1.5 0 0 1 1.5-1.5h6A1.5 1.5 0 0 1 14 5v15.5M3.5 20.5h12M14 9.5h2a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 0 3 0V8l-2.5-2.5M7.5 7.5h4',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3',
  server: 'M4 4.5h16v6H4zM4 13.5h16v6H4zM8 7.5h.01M8 16.5h.01',
  phone: 'M7.5 2.5h9A1.5 1.5 0 0 1 18 4v16a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20V4a1.5 1.5 0 0 1 1.5-1.5zM10.5 18.5h3',
  ext: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  x: 'M6 6l12 12M18 6 6 18',
  alert: 'M12 3.5 2.5 20h19zM12 10v4.5M12 17.5v.01',
  location: 'M3.5 11 20.5 3.5 13 20.5l-2-7.5z',
  leaf: 'M5 19c0-8.5 5.5-13.5 14.5-14-.5 9-5.5 14.5-14 14.5zM5 19l7.5-7.5',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  bang: 'M12 6.5v7M12 17.5v.01',
  dot: 'M12 12h.01',
};
function icon(name, cls = 'ico') {
  return s('svg', { class: cls, viewBox: '0 0 24 24', 'aria-hidden': 'true' }, s('path', { d: ICONS[name] }));
}
const tileIcon = (name, color) => h('span', { class: `ico-tile ${color}`, 'aria-hidden': 'true' },
  name === 'faceid' ? h('span', { class: 'faceid' }) : icon(name));

// ── Shared pieces ─────────────────────────────────────────────────────
// Large title with trailing round buttons (Settings is reachable from every tab).
function largeTitle(text, { sub, actions = [] } = {}) {
  return h('header', { class: 'lt' },
    h('div', { class: 'lt-text' }, h('h1', { class: 'large-title' }, text), sub && h('p', { class: 'lt-sub' }, sub)),
    h('div', { class: 'lt-actions' }, ...actions,
      h('a', { class: 'round-btn', href: '#/account', 'aria-label': 'Settings' }, icon('person'))));
}

function navBar(href, label, onclick) {
  return h('nav', { class: 'nav', 'aria-label': 'Back' },
    h('a', { class: 'nav-back', href, onclick }, icon('back'), label));
}

function pageHead(title, ...meta) {
  return h('header', { class: 'page-head' }, h('h1', { class: 'title2' }, title),
    meta.filter(Boolean).map((m) => typeof m === 'string' ? h('p', { class: 'meta' }, m) : m));
}

function secHead(title, end) {
  return h('div', { class: 'sec-head' }, h('h2', { class: 'sec-title' }, title), end);
}

// Inset grouped list. Rows are cells (or <li>s); header and footer are optional.
function group({ head, foot, footClass, cls, listCls } = {}, ...rows) {
  return h('section', { class: 'grp' + (cls ? ` ${cls}` : '') },
    head && (typeof head === 'string' ? h('h2', { class: 'grp-head' }, head) : head),
    h('ul', { class: 'list' + (listCls ? ` ${listCls}` : '') },
      rows.flat(Infinity).filter(Boolean).map((r) => r.tagName === 'LI' ? r : h('li', null, r))),
    foot && h('p', { class: 'grp-foot' + (footClass ? ` ${footClass}` : '') }, foot));
}

function cell({ href, onclick, lead, title, sub, value, end, chevron, cls, target }) {
  const tag = href ? 'a' : onclick ? 'button' : 'div';
  return h(tag, { class: 'cell' + (cls ? ` ${cls}` : ''), href, target, rel: target ? 'noopener' : null,
    type: tag === 'button' ? 'button' : null, onclick },
  lead,
  h('div', { class: 'cell-main' }, h('div', { class: 'cell-title' }, title), sub && h('div', { class: 'cell-sub' }, sub)),
  value != null && h('div', { class: 'cell-value' }, value),
  end,
  (chevron ?? (tag === 'a' && !target)) && h('i', { class: 'chev', 'aria-hidden': 'true' }));
}

function card(...kids) { return h('section', { class: 'card' }, ...kids); }
// Size a right-aligned inline number field to its content so a "$" prefix sits next to the digits.
function autoWidth(input) {
  const fit = () => { input.style.width = `${Math.max(String(input.value || input.placeholder || '').length, 1) + 0.6}ch`; };
  input.addEventListener('input', fit);
  fit();
  return input;
}

function cardHead(title, end, ic) {
  return h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, ic, title), end);
}

// Big number with a quieter unit: 189 kWh
const valueWithUnit = (v, unit) => [v, unit && h('small', null, unit)];
function stat(label, value, unit) {
  return h('div', null, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, valueWithUnit(value, unit)));
}

function statGrid(pairs) {
  return h('dl', { class: 'stats' }, pairs.filter(Boolean).map(([k, v]) => h('div', null, h('dt', null, k), h('dd', null, v))));
}

function tile({ href, icon: ic, tone, label, value, unit, sub }) {
  return h(href ? 'a' : 'div', { class: 'tile', href },
    h('div', { class: `tile-label ${tone}` }, icon(ic), label, href && h('i', { class: 'chev', 'aria-hidden': 'true' })),
    h('div', null, h('div', { class: 'tile-value' }, valueWithUnit(value, unit)), sub && h('div', { class: 'tile-sub' }, sub)));
}

function batteryBar(pct, charging) {
  const fillEl = h('span', { class: [charging && 'is-charging', !charging && pct != null && pct <= 20 && 'low',
    animate && !reduceMotion && 'fill-in'].filter(Boolean).join(' '), style: { width: `${pct ?? 0}%` } });
  return h('div', { class: 'battery', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100,
    'aria-valuenow': pct ?? 0, 'aria-label': 'Battery' }, fillEl);
}

const effClass = (ratio) => ratio == null ? null : ratio < 0.7 ? -2 : ratio < 0.9 ? -1 : ratio <= 1.1 ? 0 : ratio <= 1.3 ? 1 : 2;

// "12% worse than rated" as a pill with the matching efficiency color.
function ratioPill(ratio, rated, unit, estimated) {
  if (ratio == null || !rated) return null;
  const pct = Math.round(Math.abs(ratio - 1) * 100);
  const text = pct < 3 ? `At rated ${rated} Wh/${unit}` : `${pct}% ${ratio < 1 ? 'better' : 'worse'} than rated`;
  return h('span', { class: 'pill-note', title: estimated ? 'Rated figure is a typical one for this model until TeslaMate learns your car’s own' : null },
    h('span', { class: `dot eff e${effClass(ratio)}`, 'aria-hidden': 'true' }), text);
}

async function signOut() {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  invalidate();
  if (navigator.serviceWorker?.controller) navigator.serviceWorker.controller.postMessage('clear-api');
  route();
}

// ── Views ─────────────────────────────────────────────────────────────
const STATUS = { charging: ['Charging', 'on'], online: ['Parked', 'ok'], asleep: ['Asleep', 'idle'],
  offline: ['Offline', 'warn'], unknown: ['Last seen', 'idle'] };
let liveTimer = null;

async function carView() {
  const st = await load('/api/status');
  if (st.onboarded === false) { setTimeout(() => location.replace('#/welcome')); return skeletonView(); }
  if (!st.car) return notConnected(st);
  const unit = st.units.length;
  const driving = st.activity === 'driving', charging = st.activity === 'charging';
  // keep charging/driving fresh while the app is open
  if (charging || driving) scheduleLive();
  const [bat, nudge] = await Promise.all([load('/api/battery').catch(() => null), passkeyNudge()]);

  const [label, tone] = driving ? ['Driving', 'drive'] : STATUS[st.activity] || STATUS.unknown;
  const big = st.range != null ? Math.round(st.range) : st.battery;
  const bigEl = h('span', { class: 'hero-num' });
  countUp(bigEl, big);
  const unsaved = !driving && st.position && !st.place_id;
  const out = [
    largeTitle(st.car.name, { sub: st.cars.length > 1 ? `${st.cars.length} cars` : (st.car.model && st.car.model !== st.car.name ? st.car.model : null) }),
    h('section', { class: 'car-hero', 'aria-label': 'Car status' },
      h('div', { class: 'hero-line' }, bigEl, h('span', { class: 'hero-unit' }, st.range != null ? unit : '%'),
        st.range != null && st.battery != null && h('span', { class: 'hero-pct' }, `${st.battery}%`)),
      batteryBar(st.battery, charging),
      h('div', { class: 'status-row' },
        h('p', { class: 'status' }, h('span', { class: `status-dot ${tone}`, 'aria-hidden': 'true' }),
          h('span', null, driving ? 'Driving' : `${label} · ${st.place || 'Unknown place'}`)),
        unsaved && h('a', { class: 'btn small tinted',
          href: `#/place/new?lat=${st.position.lat}&lon=${st.position.lon}&name=${encodeURIComponent(st.place || '')}` },
        icon('plus'), 'Save place')),
      h('p', { class: 'status-meta num' }, [`Updated ${ago(st.updated)}`,
        st.outside_temp != null && `${st.outside_temp}° outside`,
        st.inside_temp != null && `${st.inside_temp}° inside`].filter(Boolean).join(' · '))),
    h('div', { class: 'home-gap' }),
  ];

  if (st.stale) out.push(staleNotice(st));

  const c = st.charging;
  if (c) {
    out.push(h('a', { class: 'card live', href: '#/charging' },
      cardHead('Charging', h('span', { class: 'meta num' }, `since ${clock(c.start)}`), icon('bolt', 'ico fill')),
      h('div', { class: 'trio' },
        stat('Added', num(c.added_kwh, 1), 'kWh'),
        stat('Power', c.now_kw ?? '—', 'kW'),
        stat('Battery', `${c.now_pct ?? '—'}`, '%'))));
  }

  const d = st.last_drive;
  const haveHealth = bat && bat.points && bat.points.length >= 2;
  out.push(h('div', { class: 'tiles' },
    tile({ href: '#/charging', icon: 'bolt', tone: 't-green', label: 'This month',
      value: money(st.month.cost),
      sub: st.month.missing ? `${st.month.missing} without a cost` : kwh(st.month.kwh) }),
    d ? tile({ href: `#/drive/${d.id}`, icon: 'road', tone: 't-blue', label: 'Last drive',
      value: num(d.distance, 1), unit, sub: `${d.to || 'Unknown'} · ${dayLabel(d.start)}` })
      : tile({ icon: 'road', tone: 't-blue', label: 'Last drive', value: '—', sub: 'No drives yet' }),
    tile({ href: '#/battery', icon: 'battery', tone: 't-green', label: 'Battery',
      value: haveHealth ? num(bat.now) : (st.usable_battery != null ? `${st.usable_battery}` : '—'),
      unit: haveHealth ? unit : '%', sub: haveHealth ? 'Range at 100%' : 'Usable now' }),
    tile({ icon: 'gauge', tone: 't-gray', label: 'Odometer',
      value: st.odometer != null ? num(st.odometer) : '—', unit, sub: 'Total' })));

  if (nudge) out.push(nudge);
  return out;
}

// TeslaMate went quiet. Usually the car is just parked and asleep; if it has
// been driven since, Tesla has probably signed TeslaMate out.
function staleNotice(st) {
  return h('div', { class: 'banner warn', role: 'status' }, icon('alert'),
    h('div', { class: 'banner-main' },
      h('div', { class: 'banner-title' }, `No data since ${dayLabel(st.last_seen)}`),
      h('div', { class: 'banner-sub' }, 'Driven since? TeslaMate may be signed out.',
        st.teslamate_url && [' ', h('a', { href: st.teslamate_url, target: '_blank', rel: 'noopener' }, 'Open TeslaMate')])));
}

async function batteryView() {
  const b = await load('/api/battery');
  const unit = b.units.length;
  const out = [navBar('#/car', 'Car'), pageHead('Battery health')];
  if (b.points.length < 2) {
    out.push(card(h('div', { class: 'empty-state' }, icon('battery'),
      h('div', { class: 'title' }, 'Not enough charges yet'),
      h('p', null, 'Fills in after a few charges that end at 50% or more.'))));
    return out;
  }
  const since = new Date(b.since).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  let trend;
  if (b.change_pct != null) {
    const pct = Math.abs(b.change_pct);
    trend = pct < 1 ? `Steady since ${since}` : `${b.change_pct < 0 ? '↓' : '↑'} ${pct}% since ${since}`;
  } else trend = 'Trend after ~10 charges';
  out.push(card(
    h('div', { class: 'duo' }, stat('Range at 100%', num(b.now), unit),
      stat('Usable capacity', b.kwh_now != null ? num(b.kwh_now, 1) : '—', b.kwh_now != null ? 'kWh' : null)),
    h('p', { class: 'caption' }, h('span', { class: 'pill-note' }, trend))));
  out.push(h('section', { class: 'card', style: { marginTop: '12px' } },
    cardHead('Range at 100%', h('span', { class: 'meta' }, `${b.points.length} charges`)),
    lineChart(b.points, { value: (p) => p.range, unit, height: 180, tight: true,
      xLabel: (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      tipLines: (p) => [`${num(p.range)} ${unit} at 100%`, `about ${num(p.kwh, 1)} kWh usable`] }),
    h('p', { class: 'caption' }, 'One point per charge. Temperature and charge level move it a little.')));
  out.push(group({ head: 'Details', foot: b.rated_estimated ? 'Capacity uses a typical figure for this model until TeslaMate learns your car’s.' : null },
    cell({ title: 'When tracking started', value: `${num(b.first)} ${unit}` }),
    cell({ title: 'Now', value: `${num(b.now)} ${unit}` }),
    cell({ title: 'Charges counted', value: num(b.points.length) })));
  return out;
}

function notConnected(st) {
  return [
    largeTitle('Car'),
    card(h('div', { class: 'empty-state' }, icon('server'),
      h('div', { class: 'title' }, 'No car connected'),
      h('p', null, 'TeslaMate collects the data this app shows.')),
    h('ol', { class: 'steps' },
      h('li', null, 'Get your Tesla access and refresh tokens (e.g. from Tesla Auth).'),
      h('li', null, 'Open ', st.teslamate_url ? h('a', { href: st.teslamate_url, target: '_blank', rel: 'noopener' }, 'TeslaMate') : 'TeslaMate', ', sign in and paste them.'),
      h('li', null, 'Come back. The car shows up within a minute.'))),
  ];
}

async function chargingView(month) {
  month = month || thisMonth();
  const data = await load(`/api/charging?month=${month}`);
  if (data.car === null) return notConnected(await load('/api/status'));
  placeOrder = data.place_order;
  const sum = data.summary, unit = data.units.length;
  const first = data.first_month || month;
  const out = [largeTitle('Charging')];

  out.push(h('div', { class: 'stepper' },
    h('a', { class: 'step', href: `#/charging/${shiftMonth(month, -1)}`, 'aria-label': 'Previous month',
      'aria-disabled': month <= first ? 'true' : null }, icon('back')),
    h('h2', { class: 'stepper-label', 'aria-live': 'polite' }, monthName(month)),
    h('a', { class: 'step', href: `#/charging/${shiftMonth(month, 1)}`, 'aria-label': 'Next month',
      'aria-disabled': month >= thisMonth() ? 'true' : null }, icon('fwd'))));

  const bits = [`${sum.count} charge${sum.count === 1 ? '' : 's'}`];
  const ratesKnown = !(sum.missing && !sum.cost);
  if (ratesKnown && sum.per_kwh != null) bits.push(`${rate(sum.per_kwh)}/kWh`);
  if (ratesKnown && data.per_distance != null) bits.push(`${rate(data.per_distance)}/${unit} driven`);
  out.push(card(
    h('div', { class: 'duo' }, stat('Spent', money(sum.cost)), stat('Charged', num(sum.kwh), 'kWh')),
    h('p', { class: 'caption num' }, bits.join(' · '))));

  if (sum.missing) {
    out.push(h('div', { class: 'banner', role: 'status' }, icon('alert'),
      h('div', { class: 'banner-main' },
        h('div', { class: 'banner-title' }, `${sum.missing} charge${sum.missing > 1 ? 's' : ''} without a cost`),
        h('div', { class: 'banner-sub' }, 'The total is low until you add them below.'))));
  }

  if (sum.places.length) {
    const grow = animate && !reduceMotion;
    const stack = h('div', { class: 'stack' + (grow ? ' grow' : ''), 'aria-hidden': 'true' },
      sum.places.map((p) => h('span', { class: placeClass(p.place, p.kind), style: { flex: `${p.kwh} 1 0` } })));
    out.push(secHead('By location'), card(stack,
      h('ul', { class: 'legend' }, sum.places.map((p) => h('li', null,
        h('span', { class: `dot ${placeClass(p.place, p.kind)}`, 'aria-hidden': 'true' }),
        h('div', { class: 'name' }, h('div', null, p.place),
          h('div', { class: 'share' }, `${Math.round((100 * p.kwh) / (sum.kwh || 1))}%`)),
        h('span', { class: 'num kwh' }, kwh(p.kwh)),
        h('span', { class: 'num' }, p.missing && !p.cost ? '—' : money(p.cost)))))));
  }

  if (data.history.some((d) => d.cost > 0)) {
    const paid = data.history.filter((d) => d.cost > 0);
    const avg = paid.reduce((a, d) => a + d.cost, 0) / paid.length;
    out.push(secHead('Monthly spend', h('span', { class: 'meta num' }, `avg ${money(avg)}`)),
      card(spendChart(data.history, month, (m) => { location.hash = `#/charging/${m}`; })));
  }

  const gas = data.gas;
  if (gas && gas.cost != null) {
    const mi = unit === 'mi';
    const saved = gas.saved;
    out.push(secHead('Gas savings'), h('a', { class: 'card', href: '#/account' },
      h('div', { class: 'card-head' },
        h('div', { class: 'stat-value' }, money(Math.abs(saved)),
          h('small', null, saved >= 0 ? 'saved' : 'more than gas')),
        h('i', { class: 'chev', 'aria-hidden': 'true' })),
      h('div', { class: 'duo' }, stat('Gas would cost', money(gas.cost)), stat('Charging cost', money(sum.cost))),
      h('p', { class: 'caption num' },
        `${num(data.distance)} ${unit} at ${num(gas.economy, 1)} ${mi ? 'mpg' : 'L/100 km'}, ${money(gas.price)}/${mi ? 'gal' : 'L'}`
        + (gas.partial ? ' · some charges have no cost yet' : ''))));
  } else if (gas && !gas.set && data.distance) {
    out.push(group({ cls: 'spaced' }, cell({ href: '#/account', lead: tileIcon('fuel', 'orange'), title: 'Compare with a gas car' })));
  }

  out.push(secHead('History'));
  if (!data.charges.length) {
    out.push(card(h('div', { class: 'empty-state' }, icon('bolt'), h('div', { class: 'title' }, 'No charges'),
      h('p', null, `Nothing in ${monthName(month)}.`))));
  } else {
    out.push(h('ul', { class: 'list dots' }, data.charges.map((c) => h('li', null, chargeRow(c)))));
  }
  return out;
}

function chargeRow(c) {
  const where = c.place_kind === 'untagged' ? (c.address || 'Untagged') : c.place;
  const needs = c.cost == null && !c.ongoing;
  return h('a', { class: 'cell', href: `#/charge/${c.id}` },
    h('span', { class: `dot ${placeClass(c.place, c.place_kind)}`, 'aria-hidden': 'true' }),
    h('div', { class: 'cell-main' },
      h('div', { class: 'cell-title' }, where),
      h('div', { class: 'cell-sub num' },
        c.ongoing ? `Charging since ${clock(c.start)}` : `${dayLabel(c.start)} · ${clock(c.start)}`)),
    h('div', { class: 'cell-end' },
      needs ? h('span', { class: 'tag' }, 'Add cost') : h('div', { class: 'num' }, c.ongoing ? '…' : money(c.cost)),
      h('div', { class: 'cell-sub num' }, kwh(c.added_kwh))));
}

async function chargeView(id) {
  const c = await load(`/api/charges/${id}`);
  if (c.place_order) placeOrder = c.place_order;
  const month = c.start.slice(0, 7);
  const out = [
    navBar(`#/charging/${month}`, monthName(month)),
    pageHead(c.place_kind === 'untagged' ? (c.address || 'Untagged place') : c.place,
      `${dayLabel(c.start)}, ${clock(c.start)}${c.end ? ` – ${clock(c.end)}` : ''}`,
      c.place_kind === 'supercharger' && c.address),
  ];

  const input = h('input', { type: 'number', inputmode: 'decimal', step: '0.01', min: '0', id: 'cost',
    'aria-label': 'Cost in dollars', value: c.cost_source === 'manual' ? c.cost.toFixed(2) : '',
    placeholder: c.cost != null && c.cost_source !== 'manual' ? c.cost.toFixed(2) : '0.00' });
  const err = h('p', { class: 'error', role: 'alert' });
  const save = h('button', { class: 'btn', type: 'submit' }, 'Save');
  const form = h('form', { class: 'cost-form', onsubmit: async (e) => {
    e.preventDefault();
    const v = input.value.trim() === '' ? null : Number(input.value);
    if (v != null && (Number.isNaN(v) || v < 0)) { err.textContent = 'Enter an amount like 12.40.'; return; }
    save.disabled = true; err.textContent = '';
    try {
      await mutate(`/api/charges/${id}`, { method: 'PATCH', body: { cost: v } });
      toast(v == null ? 'Back to the place’s price' : 'Cost saved');
      await render({ quiet: true });
    } catch (x) { err.textContent = x.message; save.disabled = false; }
  } }, h('div', { class: 'money-in' }, input), save);

  const price = (r) => priceShort({ billing: r.per || r.billing, rate: r.rate, fee: r.fee });
  const how = {
    manual: 'Entered by you. Clear it and save to use the place’s price.',
    stored: c.rate ? `From ${c.place}’s price, ${price(c.rate)}.` : 'Worked out when the charge ended.',
    rate: c.rate && `From ${c.place}’s price, ${price(c.rate)}.`,
    free: 'Free Supercharging on this car.',
    tesla: `From Tesla’s bill${c.bill_site ? ` at ${c.bill_site}` : ''}.`,
    missing: c.place_kind === 'supercharger'
      ? 'Enter what Tesla billed (Tesla app › Charging), or connect Tesla in Settings.'
      : 'This place has no price. Enter what you paid, or save it as a place.',
  }[c.cost_source];

  out.push(card(
    h('div', { class: 'stat-label' }, 'Cost'),
    h('div', { class: 'stat-value', style: { fontSize: '34px', lineHeight: '41px' } }, c.cost == null ? 'Not set' : money(c.cost)),
    h('p', { class: 'caption', style: { marginTop: '4px' } }, how),
    form, err));

  if (c.place_kind === 'untagged' && c.lat != null) {
    out.push(group({ foot: 'Every charge here, past and future, then uses its price.' },
      cell({ href: `#/place/new?lat=${c.lat}&lon=${c.lon}&name=${encodeURIComponent(c.address || '')}`,
        lead: tileIcon('pin', 'blue'), title: 'Save as a place', cls: 'action' })));
  } else if (c.place_kind === 'geofence' && c.geofence_id) {
    out.push(group({}, cell({ href: `#/place/${c.geofence_id}`, lead: tileIcon('pin', 'blue'), title: `Edit ${c.place}` })));
  }

  out.push(secHead('Details'), card(statGrid([
    ['Added', kwh(c.added_kwh)],
    ['From charger', c.used_kwh ? kwh(c.used_kwh) : '—'],
    ['Time', dur(c.minutes)],
    ['Lost as heat', c.loss_pct != null ? `${c.loss_pct}%` : '—'],
    ['Battery', `${c.start_pct ?? '—'}% → ${c.end_pct ?? '—'}%`],
    ['Peak power', c.max_kw != null ? `${c.max_kw} kW` : '—'],
  ])));

  out.push(secHead('Charging power'), card(powerChart(c.curve)));
  return out;
}

function driveRow(d, unit) {
  const cls = effClass(d.ratio);
  return h('a', { class: 'cell', href: `#/drive/${d.id}` },
    h('span', { class: `dot eff e${cls ?? 'x'}`, 'aria-hidden': 'true' }),
    h('div', { class: 'cell-main' },
      h('div', { class: 'cell-title' }, `${d.from || 'Unknown'} → ${d.to || 'Unknown'}`),
      h('div', { class: 'cell-sub num' }, `${dayLabel(d.start)} · ${clock(d.start)}`)),
    h('div', { class: 'cell-end' }, h('div', { class: 'num' }, `${num(d.distance, 1)} ${unit}`),
      h('div', { class: 'cell-sub num' }, d.wh_per ? `${d.wh_per} Wh/${unit}` : kwh(d.kwh))));
}

// Parking-lot shuffles (TeslaMate logs every move) fold into one row per run; tap to show them.
function shortMoves(run, unit) {
  const total = run.reduce((a, d) => a + (d.distance || 0), 0);
  const newest = run[0], oldest = run[run.length - 1];
  const li = h('li');
  li.append(h('button', { class: 'cell', type: 'button', 'aria-expanded': 'false', onclick: () => {
    const rows = run.map((d) => h('li', null, driveRow(d, unit)));
    li.replaceWith(...rows);
    rows[0].querySelector('a').focus({ preventScroll: true });
  } },
  h('span', { class: 'dot eff ex', 'aria-hidden': 'true' }),
  h('div', { class: 'cell-main' }, h('div', { class: 'cell-title' }, `${run.length} short moves`),
    h('div', { class: 'cell-sub num' }, `${dayLabel(oldest.start)} · ${clock(oldest.start)} – ${clock(newest.start)}`)),
  h('div', { class: 'cell-end' }, h('div', { class: 'num' }, `${num(total, 1)} ${unit}`), h('div', { class: 'cell-sub' }, 'Show'))));
  return li;
}

async function drivesView() {
  const [data, eff, rts] = await Promise.all([load('/api/drives'), load('/api/efficiency'), load('/api/routes?days=30')]);
  const unit = data.units.length, tunit = data.units.temp;
  const out = [largeTitle('Drives')];

  const l = eff.last30;
  if (l && l.drives) {
    out.push(card(
      cardHead('Last 30 days', ratioPill(l.ratio, eff.rated_wh, unit, eff.rated_estimated)),
      h('div', { class: 'trio' },
        stat('Efficiency', `${l.wh_per}`, `Wh/${unit}`),
        stat('Distance', num(l.distance), unit),
        stat('Cost', l.cost_per_distance != null ? rate(l.cost_per_distance) : '—', l.cost_per_distance != null ? `/${unit}` : null)),
      h('p', { class: 'caption num' }, `${l.drives} drives · rated ${eff.rated_wh} Wh/${unit}${eff.rated_estimated ? ' (typical for this model)' : ''}`)));
  }

  if (rts.routes.length) {
    const map = routeMap({ routes: rts.routes, height: 300, onPick: (r) => { location.hash = `#/drive/${r.id}`; } });
    out.push(secHead('Routes', h('span', { class: 'meta' }, 'Tap one to open')),
      h('div', { class: 'map-card' }, map.el, effLegend()));
  }

  if (eff.weeks.some((w) => w.wh_per)) {
    const thisWeek = eff.weeks[eff.weeks.length - 1].week;
    out.push(secHead('Weekly efficiency', h('span', { class: 'meta' }, `Wh/${unit}`)), card(
      refColumns(eff.weeks, { value: (w) => w.wh_per, unit: `Wh per ${unit}, by week`,
        label: (w) => new Date(w.week + 'T12:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' }),
        ref: eff.rated_wh, refLabel: `Rated ${eff.rated_wh}`, current: (w) => w.week === thisWeek,
        tipLines: (w) => [`Week of ${new Date(w.week + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
          w.wh_per ? `${w.wh_per} Wh/${unit} over ${num(w.distance)} ${unit}` : 'No drives'] })));
  }

  if (eff.by_temp.length >= 3) {
    out.push(secHead('Temperature', h('span', { class: 'meta' }, `Wh/${unit} by °${tunit}`)), card(
      tempScatter(eff.by_temp, { rated: eff.rated_wh, unit, tunit }),
      h('p', { class: 'caption' }, 'One dot per drive. Cold weather costs range.')));
  }

  // Nike-style month sections; a month's totals show once all its drives are loaded.
  const listWrap = h('div', { class: 'drive-months' });
  const months = new Map();
  let last = null, curKey = null;
  const SHORT = unit === 'mi' ? 0.25 : 0.4;
  let run = [], runUl = null;
  const flush = () => {
    if (run.length === 1) runUl.append(h('li', null, driveRow(run[0], unit)));
    else if (run.length > 1) runUl.append(shortMoves(run, unit));
    run = [];
  };
  const complete = (key) => {
    const m = months.get(key);
    m.end.textContent = `${m.count} drive${m.count === 1 ? '' : 's'} · ${num(m.dist)} ${unit}`;
  };
  const add = (drives, more) => {
    for (const d of drives) {
      const key = new Date(d.start).toLocaleDateString('en-CA').slice(0, 7);
      if (!months.has(key)) {
        flush();
        if (curKey) complete(curKey);
        const end = h('span', { class: 'end num' });
        const ul = h('ul', { class: 'list dots' });
        listWrap.append(h('section', { class: 'grp' },
          h('h2', { class: 'grp-head month' }, h('span', null, monthName(key)), end), ul));
        months.set(key, { count: 0, dist: 0, end, ul });
        curKey = key;
      }
      const m = months.get(key);
      m.count += 1; m.dist += d.distance || 0;
      if ((d.distance ?? 0) < SHORT) {
        if (runUl !== m.ul || (run.length && dayLabel(run[0].start) !== dayLabel(d.start))) { flush(); runUl = m.ul; }
        run.push(d);
      } else {
        flush();
        m.ul.append(h('li', null, driveRow(d, unit)));
      }
      last = d;
    }
    flush();
    if (!more && curKey) complete(curKey);
  };
  if (!data.drives.length) {
    listWrap.append(card(h('div', { class: 'empty-state' }, icon('road'), h('div', { class: 'title' }, 'No drives yet'),
      h('p', null, 'They show up after the car’s first trip.'))));
  }
  add(data.drives, data.more);
  out.push(h('div', { style: { marginTop: '28px' } }, listWrap));
  if (data.more) {
    const more = h('button', { class: 'btn tinted block', type: 'button', onclick: async () => {
      more.disabled = true;
      const next = await api(`/api/drives?before=${encodeURIComponent(last.start)}`);
      add(next.drives, next.more);
      if (next.more) more.disabled = false; else more.remove();
    } }, 'Show older drives');
    out.push(h('p', { class: 'actions' }, more));
  }
  return out;
}

async function driveView(id) {
  const d = await load(`/api/drives/${id}`);
  const unit = d.units.length, tunit = d.units.temp;
  const pts = d.points;
  const out = [];

  let map = null;
  if (pts.length > 1) {
    map = routeMap({ height: 330, routes: [{ id: d.id, points: pts.map((p) => [p.lat, p.lon]), pointClasses: pts.map((p) => p.e) }] });
    out.push(h('div', { class: 'bleed' }, map.el,
      h('a', { class: 'float-back', href: '#/drives', 'aria-label': 'Back to Drives' }, icon('back')),
      effLegend()));
  } else {
    out.push(navBar('#/drives', 'Drives'));
  }

  out.push(pageHead(d.from && d.to ? `${d.from} → ${d.to}` : 'Drive',
    `${dayLabel(d.start)}, ${clock(d.start)}${d.end ? ` – ${clock(d.end)}` : ', still driving'}`));

  const spd = unit === 'mi' ? 'mph' : 'km/h';
  out.push(card(
    h('div', { class: 'trio' },
      stat('Distance', d.distance != null ? num(d.distance, 1) : '—', unit),
      stat('Time', d.minutes == null ? '—' : d.minutes < 60 ? `${d.minutes}` : `${Math.floor(d.minutes / 60)}:${String(d.minutes % 60).padStart(2, '0')}`,
        d.minutes == null ? null : d.minutes < 60 ? 'min' : 'h'),
      stat('Efficiency', d.wh_per ?? '—', d.wh_per ? `Wh/${unit}` : null)),
    d.wh_per && h('p', { class: 'caption' }, ratioPill(d.ratio, d.rated_wh, unit, d.rated_estimated))));

  out.push(secHead('Details'), card(statGrid([
    ['Energy used', kwh(d.kwh)],
    ['Cost', d.cost != null ? money(d.cost) : '—'],
    ['Average speed', d.avg_speed != null ? `${d.avg_speed} ${spd}` : '—'],
    ['Top speed', d.max_speed != null ? `${num(d.max_speed)} ${spd}` : '—'],
    ['Battery', `${d.start_pct ?? '—'}% → ${d.end_pct ?? '—'}%`],
    ['Outside', d.temp != null ? `${d.temp}°${tunit}` : '—'],
    ['Climbed', d.ascent != null ? `${num(d.ascent)} ${unit === 'mi' ? 'ft' : 'm'}` : '—'],
    ['Peak regen', d.max_regen_kw != null ? `${d.max_regen_kw} kW` : '—'],
  ]), d.cost != null && h('p', { class: 'caption num' }, `Cost at your recent average of ${rate(d.price_per_kwh)}/kWh.`)));

  const follow = (p) => map?.follow(p);
  if (pts.some((p) => p.speed != null)) {
    out.push(secHead('Speed'), card(lineChart(pts, { value: (p) => p.speed, unit: spd,
      tipLines: (p) => [`${p.speed} ${spd}`], onHover: follow })));
  }
  if (pts.some((p) => p.kw != null)) {
    out.push(secHead('Power'), card(lineChart(pts, { value: (p) => p.kw, unit: 'kW', zero: true,
      tipLines: (p) => [p.kw < 0 ? `${-p.kw} kW back from regen` : `${p.kw} kW`], onHover: follow }),
    h('p', { class: 'caption' }, 'Below zero is regen.')));
  }
  if (pts.some((p) => p.elev != null)) {
    const eu = unit === 'mi' ? 'ft' : 'm';
    out.push(secHead('Elevation'), card(lineChart(pts, { value: (p) => p.elev, unit: eu, height: 140,
      tipLines: (p) => [`${num(p.elev)} ${eu}`], onHover: follow })));
  }
  return out;
}

// "17¢/kWh", "17¢/kWh + $1.00", "$0.30/min", "Free"
function priceShort(p) {
  if (!p.rate && !p.fee) return 'Free';
  const unit = p.billing === 'per_minute' ? 'min' : 'kWh';
  const base = p.rate ? `${rate(p.rate)}/${unit}` : '';
  const fee = p.fee ? `${money(p.fee)} fee` : '';
  return [base, fee].filter(Boolean).join(' + ');
}

async function placesView() {
  const data = await load('/api/places');
  placeOrder = data.places.map((p) => p.name);
  const car = data.car_position;
  const addHref = car ? `#/place/new?lat=${car.lat}&lon=${car.lon}` : '#/place/new';
  const out = [largeTitle('Places', { actions: [h('a', { class: 'round-btn', href: addHref, 'aria-label': 'Add place' }, icon('plus'))] })];

  if (!data.places.length) {
    out.push(card(h('div', { class: 'empty-state' }, icon('pin'),
      h('div', { class: 'title' }, 'No places yet'),
      h('p', null, 'Save where you charge, like Home and Work, with what it costs.'),
      h('a', { class: 'btn', href: car ? `#/place/new?lat=${car.lat}&lon=${car.lon}&name=Home` : '#/place/new' }, 'Add place'))));
  } else {
    out.push(group({ head: 'Saved', listCls: 'dots' }, data.places.map((p) =>
      cell({ href: `#/place/${p.id}`, lead: h('span', { class: `dot ${placeClass(p.name, 'geofence')}`, 'aria-hidden': 'true' }),
        title: p.name, sub: `${priceShort(p)} · ${p.count ? `${p.count} charge${p.count > 1 ? 's' : ''}` : 'no charges yet'}`,
        value: p.count ? money(p.cost) : null }))));
  }

  if (data.suggestions.length) {
    out.push(group({ head: 'Suggested', foot: 'You’ve charged here but haven’t saved it.', listCls: 'dots' },
      data.suggestions.map((g) => cell({
        href: `#/place/new?lat=${g.lat}&lon=${g.lon}&name=${encodeURIComponent(g.address || '')}`,
        lead: h('span', { class: 'dot pnone', 'aria-hidden': 'true' }),
        title: g.address || 'Unnamed spot',
        sub: `${g.count} charge${g.count > 1 ? 's' : ''} · last ${dayLabel(g.last)}`,
        end: h('span', { class: 'tag' }, 'Save'), chevron: false }))));
  }
  return out;
}

async function placeForm(id, params) {
  const data = await load('/api/places');
  const existing = id !== 'new' ? data.places.find((p) => String(p.id) === id) : null;
  if (id !== 'new' && !existing) throw new Error('That place doesn’t exist anymore.');
  const car = data.car_position;
  const startLat = existing ? existing.lat : Number(params.get('lat')) || car?.lat;
  const startLon = existing ? existing.lon : Number(params.get('lon')) || car?.lon;
  if (startLat == null) throw new Error('No location yet. Connect your car first.');

  const st = {
    name: existing ? existing.name : (params.get('name') || ''),
    lat: startLat, lon: startLon,
    radius: existing ? existing.radius : 75,
    kind: existing ? (!existing.rate && !existing.fee ? 'free' : existing.billing) : 'per_kwh',
    rate: existing?.rate ?? null,
    fee: existing?.fee ?? null,
  };

  const map = placeMap({ lat: st.lat, lon: st.lon, radius: st.radius, car,
    onMove: (p) => { st.lat = p.lat; st.lon = p.lon; } });
  const radiusOut = h('output', { for: 'radius', class: 'cell-value' }, `${st.radius} m`);
  const radiusIn = h('input', { type: 'range', id: 'radius', min: 20, max: 300, step: 5, value: st.radius,
    oninput: (e) => { st.radius = Number(e.target.value); radiusOut.textContent = `${st.radius} m`; map.setRadius(st.radius); } });

  const nameIn = h('input', { type: 'text', id: 'pname', maxlength: 60, required: true, value: st.name,
    placeholder: 'Home', autocomplete: 'off' });
  const rateIn = h('input', { type: 'number', inputmode: 'decimal', step: '0.001', min: '0', id: 'prate',
    value: st.rate ?? '', placeholder: '0.17' });
  const feeIn = h('input', { type: 'number', inputmode: 'decimal', step: '0.01', min: '0', id: 'pfee',
    value: st.fee ?? '', placeholder: '0.00' });
  const rateUnit = h('span', { class: 'unit' });
  const rateRow = h('li', null, h('label', { class: 'cell field', for: 'prate' }, h('span', { class: 'cell-title' }, 'Price'),
    h('span', { class: 'money-in' }, autoWidth(rateIn)), rateUnit));
  const feeRow = h('li', null, h('label', { class: 'cell field', for: 'pfee' }, h('span', { class: 'cell-title' }, 'Session fee'),
    h('span', { class: 'money-in' }, autoWidth(feeIn)), h('span', { class: 'unit' }, '/charge')));

  const seg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Pricing' });
  const kinds = [['free', 'Free'], ['per_kwh', 'Per kWh'], ['per_minute', 'Per minute']];
  const syncKind = () => {
    for (const b of seg.children) b.setAttribute('aria-checked', String(b.dataset.kind === st.kind));
    rateRow.hidden = feeRow.hidden = st.kind === 'free';
    rateUnit.textContent = st.kind === 'per_minute' ? '/min' : '/kWh';
  };
  for (const [k, label] of kinds) {
    seg.append(h('button', { type: 'button', role: 'radio', 'data-kind': k,
      onclick: () => { st.kind = k; syncKind(); if (k !== 'free') rateIn.focus(); } }, label));
  }
  syncKind();

  const repriceIn = existing && h('input', { type: 'checkbox', class: 'switch', id: 'reprice', checked: true, role: 'switch' });

  const err = h('p', { class: 'error', role: 'alert' });
  const saveBtn = h('button', { class: 'btn block', type: 'submit' }, existing ? 'Save' : 'Save place');
  const back = existing ? '#/places' : (history.length > 1 ? null : '#/places');

  const form = h('form', { class: 'place-form', onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    const body = {
      name: nameIn.value.trim(), lat: st.lat, lon: st.lon, radius: st.radius,
      billing: st.kind === 'per_minute' ? 'per_minute' : 'per_kwh',
      rate: st.kind === 'free' ? 0 : rateIn.value === '' ? null : Number(rateIn.value),
      fee: st.kind === 'free' || feeIn.value === '' ? null : Number(feeIn.value),
      reprice: !!(repriceIn && repriceIn.checked),
    };
    if (!body.name) { err.textContent = 'Give the place a name.'; nameIn.focus(); return; }
    if (st.kind !== 'free' && (body.rate == null || Number.isNaN(body.rate))) { err.textContent = 'Enter a price, or choose Free.'; rateIn.focus(); return; }
    saveBtn.disabled = true;
    try {
      await mutate(existing ? `/api/places/${existing.id}` : '/api/places', { method: existing ? 'PUT' : 'POST', body });
      toast(existing ? `${body.name} updated` : `${body.name} saved`);
      location.hash = '#/places';
    } catch (x) { err.textContent = x.message; saveBtn.disabled = false; }
  } },
    group({}, h('li', null, h('label', { class: 'cell field', for: 'pname' }, h('span', { class: 'cell-title' }, 'Name'), nameIn))),
    h('section', { class: 'grp' }, h('h2', { class: 'grp-head' }, 'Location'),
      h('div', { class: 'map-card' }, map.el,
        car && h('button', { type: 'button', class: 'map-btn', onclick: () => map.moveTo(car) }, icon('location'), 'Car’s location')),
      h('p', { class: 'grp-foot' }, 'Drag the map to put the pin on the charger.')),
    group({ foot: 'Charges inside the circle count as this place.' },
      h('li', null, h('div', { class: 'cell vstack radius-cell' },
        h('div', { class: 'cell field' , style: { padding: 0, minHeight: '28px' } }, h('label', { class: 'cell-title', for: 'radius' }, 'Radius'), radiusOut),
        radiusIn))),
    group({ head: 'Price' },
      h('li', null, h('div', { class: 'cell' }, h('div', { class: 'cell-main' }, seg))),
      rateRow, feeRow),
    repriceIn && group({ foot: 'Costs you typed in yourself stay as they are.' },
      h('li', null, h('label', { class: 'cell', for: 'reprice' }, h('div', { class: 'cell-main' }, 'Apply to past charges'), repriceIn))),
    err,
    h('div', { class: 'form-submit' }, saveBtn),
    existing && group({}, deleteButton(existing)));

  return [
    navBar(back || '#/places', 'Places', back ? null : (e) => { e.preventDefault(); history.back(); }),
    pageHead(existing ? existing.name : 'New place'),
    form,
  ];
}

function deleteButton(p) {
  return armedCell('Delete place', 'Tap again to delete', async () => {
    await mutate(`/api/places/${p.id}`, { method: 'DELETE' });
    toast(`${p.name} deleted`);
    location.hash = '#/places';
  });
}

function signInView() {
  const input = h('input', { type: 'password', id: 'pw', class: 'text', autocomplete: 'current-password', required: true,
    placeholder: 'Password', 'aria-label': 'Password' });
  const err = h('p', { class: 'error', role: 'alert' });
  const btn = h('button', { class: 'btn' + (hasPasskeys() ? ' tinted' : ''), type: 'submit' }, 'Sign in');
  const pk = hasPasskeys() && h('button', { class: 'btn passkey', type: 'button', onclick: async () => {
    pk.disabled = true; err.textContent = '';
    try { await passkeySignIn(); invalidate(); route(); }
    catch (x) { err.textContent = x.message; pk.disabled = false; }
  } }, h('span', { class: 'faceid', 'aria-hidden': 'true' }), 'Sign in with passkey');
  return [h('div', { class: 'signin' },
    h('img', { class: 'app-icon', src: '/icons/icon-180-v4.png', alt: '' }),
    h('h1', null, 'Car'),
    h('p', { class: 'meta' }, 'Sign in to see your car.'),
    pk, pk && h('p', { class: 'or' }, 'or'),
    h('form', { onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true; err.textContent = '';
      try { await api('/api/login', { method: 'POST', body: { password: input.value } }); invalidate(); route(); }
      catch (x) { err.textContent = x.message; btn.disabled = false; input.select(); }
    } }, input, err, btn))];
}

// ── Passkeys ──────────────────────────────────────────────────────────
const hasPasskeys = () => !!window.PublicKeyCredential && !!navigator.credentials;
const b64u = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (str) => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4)), (c) => c.charCodeAt(0)),
};
function passkeyError(e) {
  if (e && e.name === 'NotAllowedError') return new Error('Passkey sign-in was cancelled.');
  if (e && e.name === 'InvalidStateError') return new Error('This device already has a passkey for Car.');
  return e instanceof Error ? e : new Error(String(e));
}

async function passkeySignIn() {
  const o = await api('/api/passkeys/login/options', { method: 'POST' });
  let cred;
  try {
    cred = await navigator.credentials.get({ publicKey: {
      challenge: b64u.dec(o.challenge), rpId: o.rpId, timeout: o.timeout,
      userVerification: o.userVerification, allowCredentials: [] } });
  } catch (e) { throw passkeyError(e); }
  const r = cred.response;
  await api('/api/passkeys/login', { method: 'POST', body: { credential: {
    id: cred.id, rawId: b64u.enc(cred.rawId), type: cred.type,
    response: { clientDataJSON: b64u.enc(r.clientDataJSON), authenticatorData: b64u.enc(r.authenticatorData),
      signature: b64u.enc(r.signature), userHandle: r.userHandle ? b64u.enc(r.userHandle) : null },
    clientExtensionResults: cred.getClientExtensionResults?.() || {},
    authenticatorAttachment: cred.authenticatorAttachment || null } } });
}

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'This device';
}

async function passkeyAdd() {
  const o = await api('/api/passkeys/register/options', { method: 'POST' });
  let cred;
  try {
    cred = await navigator.credentials.create({ publicKey: {
      ...o,
      challenge: b64u.dec(o.challenge),
      user: { ...o.user, id: b64u.dec(o.user.id) },
      excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64u.dec(c.id) })) } });
  } catch (e) { throw passkeyError(e); }
  const r = cred.response;
  return mutate('/api/passkeys/register', { method: 'POST', body: { name: deviceName(), credential: {
    id: cred.id, rawId: b64u.enc(cred.rawId), type: cred.type,
    response: { clientDataJSON: b64u.enc(r.clientDataJSON), attestationObject: b64u.enc(r.attestationObject),
      transports: r.getTransports?.() || [] },
    clientExtensionResults: cred.getClientExtensionResults?.() || {},
    authenticatorAttachment: cred.authenticatorAttachment || null } } });
}

// Slim, dismissible banner on the Car screen until this browser has a passkey.
async function passkeyNudge() {
  if (!hasPasskeys() || localStorage.getItem('passkey-nudge') === 'no') return null;
  const { passkeys } = await load('/api/passkeys').catch(() => ({ passkeys: [1] }));
  if (passkeys.length) return null;
  const add = h('button', { class: 'btn small tinted', type: 'button', onclick: async () => {
    add.disabled = true;
    try { await passkeyAdd(); toast('Passkey added'); banner.remove(); }
    catch (x) { toast(x.message); add.disabled = false; }
  } }, 'Add');
  const banner = h('div', { class: 'banner' },
    h('span', { class: 'faceid', 'aria-hidden': 'true' }),
    h('div', { class: 'banner-main' },
      h('div', { class: 'banner-title' }, 'Sign in with Face ID'),
      h('div', { class: 'banner-sub' }, 'Add a passkey to skip the password.')),
    add,
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss',
      onclick: () => { localStorage.setItem('passkey-nudge', 'no'); banner.remove(); } }, icon('x')));
  return banner;
}

async function accountView(_arg, params) {
  const [{ passkeys }, st, gas, push, tesla] = await Promise.all([load('/api/passkeys'), load('/api/status'),
    load('/api/settings/gas'), load('/api/push'), load('/api/tesla')]);
  const teslaResult = params?.get('tesla');
  if (teslaResult) {
    toast({ connected: 'Tesla account connected', cancelled: 'Tesla sign-in cancelled', error: 'Couldn’t connect to Tesla' }[teslaResult] || 'Done');
    history.replaceState(null, '', '#/account');
  }

  const add = hasPasskeys() && cell({ title: 'Add a passkey', cls: 'action', lead: tileIcon('plus', 'green'), onclick: async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { await passkeyAdd(); toast('Passkey added'); render({ quiet: true }); }
    catch (x) { toast(x.message); b.disabled = false; }
  } });

  return [
    navBar('#/car', 'Car'),
    h('header', { class: 'lt' }, h('h1', { class: 'large-title' }, 'Settings')),
    group({ head: 'Passkeys', listCls: 'lead', foot: 'Sign in with Face ID or Touch ID. The password keeps working.' },
      passkeys.map((k) => cell({ lead: tileIcon('faceid', 'green'), title: k.name,
        sub: k.last_used ? `Last used ${ago(k.last_used)}` : `Added ${dayLabel(k.created)}`, end: removeKeyButton(k) })),
      !passkeys.length && cell({ lead: tileIcon('faceid', 'gray'), title: 'No passkeys', sub: 'Signing in with the password' }),
      add),
    notificationsGroup(push),
    gasGroup(gas),
    teslaGroup(tesla),
    group({ head: 'TeslaMate', listCls: 'lead', foot: st.stale
      ? 'That’s a while. If the car has been driven since, TeslaMate is probably signed out.' : null, footClass: 'warn' },
    cell({ lead: tileIcon('server', 'gray'), title: st.car ? st.car.name : 'Not connected',
      sub: st.car ? `Last heard from ${ago(st.last_seen)}` : null }),
    st.teslamate_url && cell({ href: st.teslamate_url, target: '_blank', title: 'Open TeslaMate', cls: 'action', lead: tileIcon('ext', 'blue') })),
    group({ head: 'Sessions', listCls: 'lead', foot: 'Devices stay signed in for 400 days. This one stays signed in.' },
      armedCell('Sign out all other devices', 'Tap again to confirm', async () => {
        await mutate('/api/sessions/revoke', { method: 'POST' });
        toast('Other devices signed out');
      }, tileIcon('phone', 'blue'))),
    group({ listCls: 'lead' }, cell({ href: '#/welcome', lead: tileIcon('check', 'green'), title: 'Setup guide' })),
    group({}, cell({ title: 'Sign out', cls: 'danger center', onclick: signOut })),
  ];
}

// A destructive row that needs a second tap within 3 s (for things that are hard to undo).
function armedCell(label, armedLabel, action, lead) {
  let armed = null;
  const text = h('div', { class: 'cell-main' }, label);
  const btn = h('button', { class: 'cell danger' + (lead ? '' : ' center'), type: 'button', onclick: async () => {
    if (!armed) {
      text.textContent = armedLabel; btn.classList.add('armed');
      armed = setTimeout(() => { armed = null; text.textContent = label; btn.classList.remove('armed'); }, 3000);
      return;
    }
    clearTimeout(armed); armed = null; btn.disabled = true;
    try { await action(); }
    catch (x) { toast(x.message); }
    text.textContent = label; btn.classList.remove('armed'); btn.disabled = false;
  } }, lead, text);
  return btn;
}

// ── Notifications (Web Push) ──────────────────────────────────────────
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iPhone|iPad/.test(navigator.userAgent);

async function currentSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function pushSubscribe(push) {
  if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications weren’t allowed.');
  const reg = await navigator.serviceWorker.ready;
  const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u.dec(push.public_key) });
  const j = s.toJSON();
  await mutate('/api/push/subscribe', { method: 'POST', body: { endpoint: j.endpoint, keys: j.keys, name: deviceName() } });
}

function notificationsGroup(push) {
  const lead = tileIcon('bell', 'red');
  const sw = h('input', { type: 'checkbox', class: 'switch', role: 'switch', id: 'push-toggle', disabled: true });
  const row = h('label', { class: 'cell', for: 'push-toggle' }, lead,
    h('div', { class: 'cell-main' }, h('div', { class: 'cell-title' }, 'Unsaved charge places'),
      h('div', { class: 'cell-sub wrap' }, 'When a charge ends somewhere new')), sw);
  const foot = h('p', { class: 'grp-foot' }, 'On this device.');
  const list = h('ul', { class: 'list lead' }, h('li', null, row));
  const grp = h('section', { class: 'grp' }, h('h2', { class: 'grp-head' }, 'Notifications'), list, foot);

  if (!pushSupported()) {
    foot.textContent = isIOS()
      ? 'On iPhone, add Car to the Home Screen (Share › Add to Home Screen) and open it from there to turn this on.'
      : 'This browser can’t show notifications from Car.';
    return grp;
  }
  (async () => {
    const sub = await currentSubscription().catch(() => null);
    const others = push.devices - (sub ? 1 : 0);
    const alsoOn = others > 0 ? ` Also on for ${others} other device${others > 1 ? 's' : ''}.` : '';
    sw.checked = !!sub;
    if (sub) {
      foot.textContent = `On for this device.${alsoOn}`;
      sw.disabled = false;
      list.append(h('li', null, cell({ title: 'Send a test', cls: 'action', lead: tileIcon('bell', 'gray'), onclick: async (e) => {
        const b = e.currentTarget; b.disabled = true;
        try { await api('/api/push/test', { method: 'POST', body: { endpoint: sub.endpoint } }); toast('Test sent'); }
        catch (x) { toast(x.message); }
        b.disabled = false;
      } })));
    } else if (Notification.permission === 'denied') {
      foot.textContent = `Blocked in this browser’s settings.${alsoOn}`;
    } else {
      foot.textContent = `Off for this device.${alsoOn}`;
      sw.disabled = false;
    }
    sw.addEventListener('change', async () => {
      sw.disabled = true;
      if (sub) {
        await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
        await sub.unsubscribe().catch(() => {});
        invalidate('/api/push'); toast('Notifications off'); render({ quiet: true });
        return;
      }
      try {
        await pushSubscribe(push);
        toast('Notifications on'); render({ quiet: true });
      } catch (x) { toast(x.message); sw.checked = false; sw.disabled = false; }
    });
  })();
  return grp;
}

// ── Supercharger bills (Tesla Fleet API) ──────────────────────────────
function teslaGroup(t) {
  const lead = tileIcon('receipt', 'indigo');
  const head = 'Supercharger bills';
  if (!t.configured) {
    return group({ head, listCls: 'lead', foot: 'Needs a Tesla developer app first. Steps are in the car-dash README under “Supercharger bills”.' },
      cell({ lead, title: 'Tesla account', value: 'Not set up' }));
  }
  const run = (title, fn, ic) => cell({ title, cls: 'action', lead: ic, onclick: async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { await fn(); } catch (x) { toast(x.message); }
    b.disabled = false;
  } });
  if (!t.connected) {
    return group({ head, listCls: 'lead', foot: [
      'Fills in Supercharger costs from Tesla’s bills every 6 hours. Tesla bundles this with permission to start and stop charging; Car only reads history.',
      t.error && h('span', { class: 'error', style: { display: 'block' } }, t.error)] },
    cell({ lead, title: 'Tesla account', value: 'Not connected' }),
    run('Connect Tesla account', async () => { const { url } = await api('/api/tesla/connect'); location.href = url; }, tileIcon('ext', 'blue')),
    !t.registered && run('Register this site with Tesla', async () => {
      await mutate('/api/tesla/register', { method: 'POST' }); toast('Registered with Tesla'); render({ quiet: true });
    }, tileIcon('server', 'gray')));
  }
  return group({ head, listCls: 'lead', foot: t.error ? h('span', { class: 'error' }, t.error) : null },
    cell({ lead, title: 'Connected', sub: t.last_sync ? `Checked ${ago(t.last_sync)}` : 'Not checked yet',
      value: t.last_sync ? money(t.total) : null }),
    t.last_sync && cell({ lead: tileIcon('bolt', 'green'), title: 'Bills matched', value: `${t.matched} of ${t.bills}` }),
    run('Check now', async () => { await mutate('/api/tesla/sync', { method: 'POST' }); toast('Bills updated'); render({ quiet: true }); },
      tileIcon('receipt', 'gray')),
    armedCell('Disconnect', 'Tap again to disconnect', async () => {
      await mutate('/api/tesla/disconnect', { method: 'POST' }); toast('Tesla account disconnected'); render({ quiet: true });
    }, tileIcon('x', 'red')));
}

// ── Gas comparison settings ───────────────────────────────────────────
// iOS-style inline fields; saves when a value is committed (blur or return).
function gasGroup(g) {
  const mi = g.units.length === 'mi';
  const price = h('input', { type: 'number', inputmode: 'decimal', step: '0.01', min: '0', id: 'gprice', value: g.price ?? '',
    placeholder: mi ? '3.29' : '1.75', 'aria-label': `Gas price per ${mi ? 'gallon' : 'litre'}` });
  const econ = h('input', { type: 'number', inputmode: 'decimal', step: '0.1', min: '1', id: 'gecon', value: g.economy ?? '',
    placeholder: mi ? '28' : '8.5', 'aria-label': mi ? 'Gas car mileage in miles per gallon' : 'Gas car use in litres per 100 km' });
  const err = h('span', { class: 'error', role: 'alert' });
  let saved = JSON.stringify({ price: g.price ?? null, economy: g.economy ?? null });
  const save = async () => {
    err.textContent = '';
    const body = { price: price.value === '' ? null : Number(price.value), economy: econ.value === '' ? null : Number(econ.value) };
    const json = JSON.stringify(body);
    if (json === saved) return;
    try { await mutate('/api/settings/gas', { method: 'PUT', body }); saved = json; toast('Saved'); }
    catch (x) { err.textContent = x.message; }
  };
  price.addEventListener('change', save);
  econ.addEventListener('change', save);
  const form = h('form', { class: 'grp', onsubmit: (e) => { e.preventDefault(); document.activeElement?.blur(); save(); } },
    h('h2', { class: 'grp-head' }, 'Gas comparison'),
    h('ul', { class: 'list lead' },
      h('li', null, h('label', { class: 'cell field', for: 'gprice' }, tileIcon('fuel', 'orange'),
        h('span', { class: 'cell-title' }, 'Gas price'), h('span', { class: 'money-in' }, autoWidth(price)),
        h('span', { class: 'unit' }, mi ? '/gal' : '/L'))),
      h('li', null, h('label', { class: 'cell field', for: 'gecon' }, tileIcon('gauge', 'orange'),
        h('span', { class: 'cell-title' }, mi ? 'Mileage' : 'Consumption'), econ,
        h('span', { class: 'unit' }, mi ? 'mpg' : 'L/100 km')))),
    h('p', { class: 'grp-foot' }, 'Charging shows what the same miles would cost in a gas car. ', err),
    h('button', { type: 'submit', hidden: true }));
  return form;
}

function removeKeyButton(k) {
  let armed = null;
  const btn = h('button', { class: 'btn small danger', type: 'button', onclick: async () => {
    if (!armed) {
      btn.textContent = 'Remove?'; btn.classList.add('armed');
      armed = setTimeout(() => { armed = null; btn.textContent = 'Remove'; btn.classList.remove('armed'); }, 3000);
      return;
    }
    clearTimeout(armed); btn.disabled = true;
    try { await mutate(`/api/passkeys/${k.id}`, { method: 'DELETE' }); toast('Passkey removed'); render({ quiet: true }); }
    catch (x) { toast(x.message); btn.disabled = false; }
  } }, 'Remove');
  return btn;
}

function skeletonView() {
  return [h('header', { class: 'lt' }, h('div', { class: 'ghost', style: { width: '45%', height: '36px' } })),
    h('div', { class: 'ghost', style: { width: '55%', height: '68px', marginTop: '4px' } }),
    h('div', { class: 'ghost', style: { width: '100%', height: '6px', marginTop: '14px' } }),
    h('div', { class: 'ghost', style: { width: '40%', height: '20px', marginTop: '16px' } })];
}

// ── Onboarding (#/welcome/<step>) ─────────────────────────────────────
// First-run guide for a fresh install: what the app does, a check of the TeslaMate
// connection, then the few things worth setting up. The server remembers once it's been
// seen through (/api/onboarding); Settings › Setup guide runs it again.
const OB_STEPS = ['hello', 'check', 'passkey', 'home', 'gas', 'device', 'done'];
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const obNext = (step) => `#/welcome/${OB_STEPS[Math.min(OB_STEPS.indexOf(step) + 1, OB_STEPS.length - 1)]}`;
const obLink = (label, href, cls = 'btn block') => h('a', { class: cls, href }, label);
const heroTile = (name, color) => h('span', { class: `ico-tile ${color}`, 'aria-hidden': 'true' },
  name === 'faceid' ? h('span', { class: 'faceid' }) : icon(name));
const obMark = (state) => h('span', { class: `ob-mark ${state}`, role: 'img',
  'aria-label': { ok: 'Done', warn: 'Needs attention', info: 'Note' }[state] },
icon({ ok: 'check', warn: 'bang', info: 'dot' }[state]));

function obShell(step, { hero, title, sub, body, primary, secondary }) {
  const i = OB_STEPS.indexOf(step);
  return h('div', { class: 'ob' },
    h('div', { class: 'ob-top' },
      i > 0 && step !== 'done' ? h('a', { class: 'nav-back', href: `#/welcome/${OB_STEPS[i - 1]}`, 'aria-label': 'Back' }, icon('back'))
        : h('span', { class: 'ob-spacer' }),
      h('div', { class: 'ob-dots', role: 'img', 'aria-label': `Step ${i + 1} of ${OB_STEPS.length}` },
        OB_STEPS.map((_, k) => h('i', { class: k === i ? 'on' : k < i ? 'past' : null }))),
      h('span', { class: 'ob-spacer' })),
    h('div', { class: 'ob-hero' }, hero),
    h('h1', { class: 'ob-title' }, title),
    sub && h('p', { class: 'ob-sub' }, sub),
    body && h('div', { class: 'ob-body' }, body),
    h('div', { class: 'ob-actions' }, primary, secondary));
}

async function obFinish() {
  await mutate('/api/onboarding', { method: 'POST', body: { done: true } }).catch(() => {});
  location.hash = '#/car';
}

async function welcomeView(step, params) {
  step = OB_STEPS.includes(step) ? step : 'hello';
  const fn = { hello: obHello, check: obCheck, passkey: obPasskey, home: obHome, gas: obGas, device: obDevice, done: obDone }[step];
  return [await fn(step, params)];
}

function obHello(step) {
  return obShell(step, {
    hero: h('img', { class: 'ob-icon', src: '/icons/icon-180-v4.png', alt: '' }),
    title: 'Welcome to Car',
    sub: 'Your TeslaMate data, made for your phone. A few quick steps and you’re set.',
    body: group({ listCls: 'lead' },
      cell({ lead: tileIcon('bolt', 'green'), title: 'Charging costs', sub: 'What every charge cost, by place' }),
      cell({ lead: tileIcon('road', 'blue'), title: 'Drives', sub: 'Routes colored by efficiency' }),
      cell({ lead: tileIcon('battery', 'green'), title: 'Battery health', sub: 'Range at 100% over time' })),
    primary: obLink('Get started', obNext(step)),
    secondary: h('button', { class: 'btn plain block', type: 'button', onclick: obFinish }, 'Skip setup'),
  });
}

async function obCheck(step) {
  const s = await load('/api/setup');
  const row = (state, title, sub) => cell({ lead: obMark(state), title, sub });
  const p = s.permissions || {};
  const missing = [!p.places && 'places', !p.costs && 'charge costs', !p.drives && 'drives'].filter(Boolean);
  const hostOk = location.hostname === s.rp_id;
  const u = s.units.length;
  const rows = [
    s.car ? row('ok', `Found ${s.car.name}`, [s.cars > 1 && `${s.cars} cars`, s.car.odometer != null && `${num(s.car.odometer)} ${u}`].filter(Boolean).join(' · ') || 'In TeslaMate')
      : row('warn', 'No car yet', 'Sign in to TeslaMate with your Tesla account. The car shows up within a minute.'),
    s.car && (s.last_seen
      ? row(s.stale ? 'warn' : 'ok', s.stale ? `Quiet since ${dayLabel(s.last_seen)}` : 'Receiving data',
        s.stale ? 'Fine if the car is parked. If it’s been driven, TeslaMate may be signed out.' : `Last update ${ago(s.last_seen)}`)
      : row('warn', 'No data yet', 'TeslaMate hasn’t recorded anything for this car.')),
    s.counts.drives || s.counts.charges
      ? row('ok', 'History', `${num(s.counts.drives)} drives · ${num(s.counts.charges)} charges`)
      : row('info', 'No history yet', 'Drives and charges show up as TeslaMate records them.'),
    missing.length ? row('warn', 'Read-only', `The car_dash database role can’t change ${missing.join(', ')}. Run setup.sql again.`)
      : row('ok', 'Can edit places and costs', 'Database permissions look right'),
    hostOk ? row('ok', 'Passkeys ready', `Bound to ${s.rp_id}`)
      : row('warn', 'Passkeys won’t work here', `RP_ID is ${s.rp_id}, but this page is ${location.hostname}.`),
    row('info', `${u === 'mi' ? 'Miles' : 'Kilometres'} and °${s.units.temp}`, 'From TeslaMate’s settings'),
  ];
  const problems = !s.car || missing.length || !hostOk;
  return obShell(step, {
    hero: heroTile('server', problems ? 'orange' : 'green'),
    title: problems ? 'Almost connected' : 'Connected to TeslaMate',
    sub: problems ? 'A few things need attention. You can carry on and fix them later.' : 'Everything Car needs is in place.',
    body: group({ listCls: 'lead' }, rows),
    primary: obLink('Continue', obNext(step)),
    secondary: problems && s.teslamate_url && h('a', { class: 'btn plain block', href: s.teslamate_url, target: '_blank', rel: 'noopener' }, 'Open TeslaMate'),
  });
}

async function obPasskey(step) {
  const { passkeys } = await load('/api/passkeys');
  const add = (label, cls) => {
    const b = h('button', { class: cls, type: 'button', onclick: async () => {
      b.disabled = true;
      try { await passkeyAdd(); toast('Passkey added'); render({ quiet: true }); }
      catch (x) { toast(x.message); b.disabled = false; }
    } }, label);
    return b;
  };
  if (!hasPasskeys()) {
    return obShell(step, { hero: heroTile('faceid', 'gray'), title: 'Passkeys',
      sub: 'This browser can’t use passkeys, so you’ll sign in with the password here.',
      primary: obLink('Continue', obNext(step)) });
  }
  if (passkeys.length) {
    return obShell(step, { hero: heroTile('faceid', 'green'), title: 'Face ID is set up',
      sub: `${passkeys.length} passkey${passkeys.length > 1 ? 's' : ''} saved. The password still works as a backup.`,
      primary: obLink('Continue', obNext(step)), secondary: add('Add this device too', 'btn plain block') });
  }
  return obShell(step, { hero: heroTile('faceid', 'green'), title: 'Sign in with Face ID',
    sub: 'Add a passkey on this device and you won’t need the password. It keeps working as a backup.',
    primary: add('Add passkey', 'btn block'), secondary: obLink('Not now', obNext(step), 'btn plain block') });
}

async function obHome(step, params) {
  const data = await load('/api/places');
  placeOrder = data.places.map((p) => p.name);
  const home = data.places.find((p) => /home/i.test(p.name));
  if (home && params?.get('new') !== '1') {
    return obShell(step, { hero: heroTile('pin', 'blue'), title: 'Home charging',
      sub: 'Your places already have prices, so charges there get a cost on their own.',
      body: group({ listCls: 'dots' }, data.places.slice(0, 4).map((p) => cell({ href: `#/place/${p.id}`,
        lead: h('span', { class: `dot ${placeClass(p.name, 'geofence')}`, 'aria-hidden': 'true' }), title: p.name, sub: priceShort(p) }))),
      primary: obLink('Continue', obNext(step)),
      secondary: obLink('Add another place', '#/welcome/home?new=1', 'btn plain block') });
  }
  // Start where most charging happened (a place not saved yet), else where the car is.
  const sug = [...data.suggestions].sort((a, b) => b.kwh - a.kwh)[0];
  const car = data.car_position;
  const start = sug || car;
  const title = home ? 'Add a place' : 'Home charging';
  const sub = 'Set what charging costs here. Every charge at this spot, past and future, gets a cost.';
  if (!start) {
    return obShell(step, { hero: heroTile('pin', 'blue'), title, sub: 'There’s no location from the car yet. Add places later from the Places tab.',
      primary: obLink('Continue', obNext(step)) });
  }
  const st = { lat: start.lat, lon: start.lon };
  const map = placeMap({ lat: st.lat, lon: st.lon, radius: 75, car, onMove: (p) => { st.lat = p.lat; st.lon = p.lon; } });
  const nameIn = h('input', { type: 'text', id: 'ob-name', maxlength: 60, value: home ? '' : 'Home', placeholder: home ? 'Work' : 'Home', autocomplete: 'off' });
  const rateIn = autoWidth(h('input', { type: 'number', inputmode: 'decimal', step: '0.001', min: '0', id: 'ob-rate', placeholder: '0.15' }));
  const err = h('p', { class: 'error', role: 'alert' });
  const save = h('button', { class: 'btn block', type: 'submit', form: 'ob-home' }, 'Save');
  const form = h('form', { id: 'ob-home', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    const name = nameIn.value.trim(), rate = rateIn.value === '' ? null : Number(rateIn.value);
    if (!name) { err.textContent = 'Give the place a name.'; nameIn.focus(); return; }
    if (rate == null || Number.isNaN(rate) || rate < 0) { err.textContent = 'Enter the price per kWh, like 0.15 (0 if it’s free).'; rateIn.focus(); return; }
    save.disabled = true;
    try {
      await mutate('/api/places', { method: 'POST', body: { name, lat: st.lat, lon: st.lon, radius: 75, billing: 'per_kwh', rate, fee: null, reprice: true } });
      toast(`${name} saved`);
      location.hash = obNext(step);
    } catch (x) { err.textContent = x.message; save.disabled = false; }
  } },
  group({},
    h('li', null, h('label', { class: 'cell field', for: 'ob-name' }, h('span', { class: 'cell-title' }, 'Name'), nameIn)),
    h('li', null, h('label', { class: 'cell field', for: 'ob-rate' }, h('span', { class: 'cell-title' }, 'Price'),
      h('span', { class: 'money-in' }, rateIn), h('span', { class: 'unit' }, '/kWh')))),
  h('section', { class: 'grp' },
    h('div', { class: 'map-card' }, map.el,
      car && sug && h('button', { type: 'button', class: 'map-btn', onclick: () => map.moveTo(car) }, icon('location'), 'Car’s location')),
    h('p', { class: 'grp-foot' }, sug ? 'Placed where you’ve charged most. Drag the map to adjust.' : 'Placed where the car is now. Drag the map to adjust.')),
  err);
  return obShell(step, { hero: heroTile('pin', 'blue'), title, sub, body: form, primary: save,
    secondary: obLink(home ? 'Done' : 'I don’t charge at home', obNext(step), 'btn plain block') });
}

async function obGas(step) {
  const g = await load('/api/settings/gas');
  const mi = g.units.length === 'mi';
  const price = autoWidth(h('input', { type: 'number', inputmode: 'decimal', step: '0.01', min: '0', id: 'ob-gprice', value: g.price ?? '', placeholder: mi ? '3.29' : '1.75' }));
  const econ = h('input', { type: 'number', inputmode: 'decimal', step: '0.1', min: '1', id: 'ob-gecon', value: g.economy ?? '', placeholder: mi ? '28' : '8.5' });
  const err = h('p', { class: 'error', role: 'alert' });
  const save = h('button', { class: 'btn block', type: 'submit', form: 'ob-gas' }, 'Save');
  const form = h('form', { id: 'ob-gas', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    const body = { price: price.value === '' ? null : Number(price.value), economy: econ.value === '' ? null : Number(econ.value) };
    if (body.price == null || body.economy == null) { err.textContent = 'Enter both, or skip this step.'; return; }
    save.disabled = true;
    try { await mutate('/api/settings/gas', { method: 'PUT', body }); location.hash = obNext(step); }
    catch (x) { err.textContent = x.message; save.disabled = false; }
  } },
  group({ listCls: 'lead', foot: 'Use your old car’s figures, or a typical one.' },
    h('li', null, h('label', { class: 'cell field', for: 'ob-gprice' }, tileIcon('fuel', 'orange'),
      h('span', { class: 'cell-title' }, 'Gas price'), h('span', { class: 'money-in' }, price), h('span', { class: 'unit' }, mi ? '/gal' : '/L'))),
    h('li', null, h('label', { class: 'cell field', for: 'ob-gecon' }, tileIcon('gauge', 'orange'),
      h('span', { class: 'cell-title' }, mi ? 'Mileage' : 'Consumption'), econ, h('span', { class: 'unit' }, mi ? 'mpg' : 'L/100 km')))),
  err);
  return obShell(step, { hero: heroTile('fuel', 'orange'), title: 'Compare with gas',
    sub: 'See what the same miles would have cost in a gas car, every month.',
    body: form, primary: save, secondary: obLink('Skip', obNext(step), 'btn plain block') });
}

async function obDevice(step) {
  const next = obLink('Continue', obNext(step));
  if (isIOS() && !isStandalone()) {
    return obShell(step, { hero: heroTile('phone', 'blue'), title: 'Add to Home Screen',
      sub: 'Car works best as an app: full screen, Face ID and charge notifications.',
      body: h('ol', { class: 'ob-steps' },
        h('li', null, 'Tap ', h('b', null, 'Share'), ' in Safari'),
        h('li', null, 'Choose ', h('b', null, 'Add to Home Screen')),
        h('li', null, 'Open Car from your Home Screen')),
      primary: next });
  }
  if (!pushSupported()) {
    return obShell(step, { hero: heroTile('bell', 'gray'), title: 'Notifications',
      sub: 'This browser can’t show notifications from Car.', primary: next });
  }
  const push = await load('/api/push');
  const subscribed = await currentSubscription().catch(() => null);
  if (subscribed) {
    return obShell(step, { hero: heroTile('bell', 'red'), title: 'Notifications are on', sub: 'This device gets charge alerts.', primary: next });
  }
  if (Notification.permission === 'denied') {
    return obShell(step, { hero: heroTile('bell', 'gray'), title: 'Notifications are blocked',
      sub: 'Allow them for this site in the browser’s settings to get charge alerts.', primary: next });
  }
  const on = h('button', { class: 'btn block', type: 'button', onclick: async () => {
    on.disabled = true;
    try { await pushSubscribe(push); toast('Notifications on'); location.hash = obNext(step); }
    catch (x) { toast(x.message); on.disabled = false; }
  } }, 'Turn on notifications');
  return obShell(step, { hero: heroTile('bell', 'red'), title: 'Charge alerts',
    sub: 'Get a notification when a charge ends somewhere you haven’t saved, so you can name it and set its price.',
    primary: on, secondary: obLink('Not now', obNext(step), 'btn plain block') });
}

async function obDone(step) {
  // Seeing this screen counts as finished, so links from here don't bring the guide back.
  if (!(await load('/api/status')).onboarded) await mutate('/api/onboarding', { method: 'POST', body: { done: true } }).catch(() => {});
  const [{ passkeys }, places, gas] = await Promise.all([load('/api/passkeys'), load('/api/places'), load('/api/settings/gas')]);
  const pushOn = pushSupported() && !!(await currentSubscription().catch(() => null));
  const item = (on, title, subOn, subOff, href) => cell({ lead: obMark(on ? 'ok' : 'info'), title, sub: on ? subOn : subOff, href: on ? null : href });
  return obShell(step, { hero: heroTile('check', 'green'), title: 'You’re all set',
    sub: 'Anything you skipped is in Settings and Places whenever you want it.',
    body: group({ listCls: 'lead' },
      item(passkeys.length, 'Face ID', 'Passkey saved', 'Add a passkey in Settings', '#/account'),
      item(places.places.length, 'Places', `${places.places.length} saved with prices`, 'Add them from the Places tab', '#/places'),
      item(gas.price != null && gas.economy != null, 'Gas comparison', 'On', 'Set it up in Settings', '#/account'),
      item(pushOn, 'Notifications', 'On for this device', 'Turn on in Settings', '#/account')),
    primary: h('button', { class: 'btn block', type: 'button', onclick: obFinish }, 'Open Car') });
}

// ── Toast ─────────────────────────────────────────────────────────────
let toastEl = null;
function toast(text) {
  toastEl?.remove();
  toastEl = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(toastEl);
  const me = toastEl;
  setTimeout(() => me.classList.add('out'), 2200);
  setTimeout(() => me.remove(), 2600);
}

// ── Router ────────────────────────────────────────────────────────────
const ROUTES = { car: carView, charging: chargingView, charge: chargeView, drives: drivesView, drive: driveView,
  places: placesView, place: placeForm, account: accountView, battery: batteryView, welcome: welcomeView };
const DEPTH = { charge: 1, place: 1, account: 1, drive: 1, battery: 1 };
const TAB_OF = { charge: 'charging', place: 'places', account: 'car', drive: 'drives', battery: 'car' };
let lastRoute = null;

function showTabs(on) {
  tabs.hidden = !on;
  document.body.classList.toggle('no-tabs', !on);
}

function parseHash() {
  const [path, query = ''] = (location.hash || '#/car').slice(2).split('?');
  const [name = 'car', arg] = path.split('/');
  return { name: ROUTES[name] ? name : 'car', arg, params: new URLSearchParams(query), key: location.hash || '#/car' };
}

async function build(r) {
  staleReads = [];
  const fn = ROUTES[r.name];
  return fn(r.arg, r.params);
}

function swap(nodes, direction) {
  const apply = () => { view.replaceChildren(...nodes.flat(Infinity).filter(Boolean)); };
  if (direction && document.startViewTransition && !reduceMotion) {
    document.documentElement.dataset.nav = direction;
    return document.startViewTransition(apply).finished.finally(() => { delete document.documentElement.dataset.nav; });
  }
  apply();
  return Promise.resolve();
}

async function render({ quiet = false, direction = null } = {}) {
  const r = parseHash();
  const tab = TAB_OF[r.name] || r.name;
  for (const a of tabs.querySelectorAll('a')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  hideTip();
  clearTimeout(liveTimer);
  animate = !quiet;
  const scroll = window.scrollY;
  if (!quiet && !view.childElementCount) view.replaceChildren(...skeletonView());
  try {
    const nodes = await build(r);
    const stale = staleReads.slice();
    showTabs(r.name !== 'welcome');
    await swap(nodes, quiet ? null : direction);
    if (quiet) window.scrollTo(0, scroll);
    if (stale.length) revalidate(r.key, stale);
  } catch (e) {
    if (e instanceof SignedOut) {
      showTabs(false);
      await swap(signInView(), null);
      document.getElementById('pw')?.focus();
    } else {
      showTabs(true);           // keep the tabs so a failed first load isn't a dead end
      await swap([h('div', { class: 'card', style: { marginTop: '20vh' } }, h('div', { class: 'empty-state' }, icon('alert'),
        h('div', { class: 'title' }, 'Couldn’t load this page'),
        h('p', null, e.message),
        h('button', { class: 'btn tinted', type: 'button', onclick: () => render() }, 'Try again')))], null);
    }
  } finally {
    animate = true;
  }
}

// After rendering from cache, fetch the real thing; re-render only if it changed.
async function revalidate(key, paths) {
  let changed = false;
  for (const p of paths) {
    try {
      const data = await api(p);
      const json = JSON.stringify(data);
      if (cache.get(p)?.json !== json) { cache.set(p, { data, json }); changed = true; }
    } catch (e) { if (e instanceof SignedOut) { invalidate(); return render(); } }
  }
  if (changed && parseHash().key === key && !document.querySelector('form :focus')) render({ quiet: true });
}

function scheduleLive() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => { if (!document.hidden) refresh(); else scheduleLive(); }, 30000);
}

async function refresh() {
  fresh = true;
  try { await render({ quiet: true }); } finally { fresh = false; }
}

function route() {
  const r = parseHash();
  let direction = 'tab';
  if (lastRoute) {
    const a = DEPTH[lastRoute.name] || 0, b = DEPTH[r.name] || 0;
    direction = b > a ? 'push' : b < a ? 'pop' : (lastRoute.name === r.name ? null : 'tab');
    if (r.name === 'welcome' && lastRoute.name === 'welcome') {      // guide steps slide like a stack
      const i = OB_STEPS.indexOf(r.arg || 'hello'), j = OB_STEPS.indexOf(lastRoute.arg || 'hello');
      direction = i > j ? 'push' : i < j ? 'pop' : null;
    }
  } else direction = null;
  if (!lastRoute || lastRoute.key !== r.key) window.scrollTo(0, 0);
  lastRoute = r;
  render({ direction });
}

window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => { if (!document.hidden && lastRoute) refresh(); });

// ── Pull to refresh (touch) ───────────────────────────────────────────
(() => {
  const ind = h('div', { class: 'ptr', 'aria-hidden': 'true' }, h('span'));
  document.body.append(ind);
  let y0 = null, dy = 0, busy = false;
  const MAX = 90, TRIGGER = 64;
  window.addEventListener('touchstart', (e) => {
    if (busy || window.scrollY > 0 || e.target.closest('.map, input, .chart')) { y0 = null; return; }
    y0 = e.touches[0].clientY; dy = 0;
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    dy = Math.max(0, Math.min(MAX, (e.touches[0].clientY - y0) * 0.5));
    ind.style.transform = `translate(-50%, ${dy - 44}px) rotate(${dy * 4}deg)`;
    ind.classList.toggle('ready', dy >= TRIGGER);
  }, { passive: true });
  window.addEventListener('touchend', async () => {
    if (y0 == null) return;
    y0 = null;
    if (dy >= TRIGGER) {
      busy = true;
      ind.classList.add('spin');
      ind.style.transform = 'translate(-50%, 20px)';
      try { await refresh(); } finally {
        busy = false;
        ind.classList.remove('spin', 'ready');
        ind.style.transform = '';
      }
    } else {
      ind.style.transform = '';
      ind.classList.remove('ready');
    }
  });
})();

route();

// Updates: check for a new version whenever the app comes back to the front
// (an installed iPhone app usually resumes instead of reloading), and reload
// once the new version has taken over.
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading || document.querySelector('form :focus')) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
}
