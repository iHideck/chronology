// 年表のデータ整形・レイアウト・SVG描画。
// build.mjs（README 用の静的SVGの生成）と、各年表の index.html（ブラウザでの描画）の両方がこのファイルを使う。
// 時間は上から下へ一定の縮尺で流れる。中央（または左端）に西暦と時代の帯を通し、その左右に列を並べる。

export const DAY = 86400000;
export const YEAR = 365.2425 * DAY;

// ---------------------------------------------------------------- 日付

// 日付は "YYYY-MM-DD"・"YYYY-MM"・"YYYY" のどれか（年は4桁以上）。紀元前は負の年で書く（紀元前221年 → "-0221"。0年はない）。
// 1582年10月15日より前はユリウス暦、それ以後はグレゴリオ暦の日付として読む（日本史・世界史の慣例どおり）。
const EPOCH_JDN = 2440588; // 1970年1月1日のユリウス通日
const GREGORIAN_JDN = 2299161; // グレゴリオ暦の始まり（1582年10月15日）

export function parseDate(s) {
  const m = /^(-?)(\d{4,6})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const year = Number(m[2]);
  if (m[1] && year === 0) return null;
  const mo = m[3] ? Number(m[3]) : 1;
  const d = m[4] ? Number(m[4]) : 1;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // y は天文学的な年（紀元前1年 = 0、紀元前2年 = -1）
  return { y: m[1] ? 1 - year : year, m: mo, d, prec: m[4] ? 'd' : m[3] ? 'm' : 'y' };
}

function toJdn(y, m, d) {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  const base = d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4);
  const gregorian = y > 1582 || (y === 1582 && (m > 10 || (m === 10 && d >= 15)));
  return gregorian ? base - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045 : base - 32083;
}

function fromJdn(j) {
  let f = j + 1401;
  if (j >= GREGORIAN_JDN) f += Math.floor((Math.floor((4 * j + 274277) / 146097) * 3) / 4) - 38;
  const e = 4 * f + 3;
  const h = 5 * Math.floor((e % 1461) / 4) + 2;
  const d = Math.floor((h % 153) / 5) + 1;
  const m = ((Math.floor(h / 153) + 2) % 12) + 1;
  return { y: Math.floor(e / 1461) - 4716 + Math.floor((14 - m) / 12), m, d };
}

export const fromYMD = (y, m = 1, d = 1) => (toJdn(y, m, d) - EPOCH_JDN) * DAY;

// end を付けると、年・月までしかない日付はその期間の終わり（翌年・翌月の初め）にする
export function toTime(s, end = false) {
  const p = parseDate(s);
  if (!p) return NaN;
  if (end && p.prec === 'y') return fromYMD(p.y + 1);
  if (end && p.prec === 'm') return p.m === 12 ? fromYMD(p.y + 1) : fromYMD(p.y, p.m + 1);
  return fromYMD(p.y, p.m, p.d);
}

export function ymd(t) {
  return fromJdn(Math.floor(t / DAY) + EPOCH_JDN);
}

// 西暦の年の表記。紀元前は「紀元前」、狭いところでは「前」を付ける
export const yearText = (y) => (y <= 0 ? `紀元前${1 - y}` : `${y}`);
export const yearShort = (y) => (y <= 0 ? `前${1 - y}` : `${y}`);

export function fmtDate(t) {
  const { y, m, d } = ymd(t);
  return `${yearText(y)}年${m}月${d}日`;
}

export function fmtDot(t) {
  const { y, m, d } = ymd(t);
  return `${yearShort(y)}.${m}.${d}`;
}

// データに書かれた精度のまま表す（"1543" → "1543年"、"1543-03" → "1543年3月"）
export function fmtStr(s) {
  const p = parseDate(s);
  if (!p) return String(s ?? '');
  const y = `${yearText(p.y)}年`;
  return p.prec === 'y' ? y : p.prec === 'm' ? `${y}${p.m}月` : `${y}${p.m}月${p.d}日`;
}

export function fmtNum(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// 西暦の日付を和暦（元号＋年）に。eras は開始順の元号。
// retro を付けると、最初の元号より前の日付もその元号の元年として扱う（明治改元より前の1868年を明治元年とする、など）。
export function wareki(t, eras, retro = false) {
  let era = null;
  for (const e of eras) if (e.start <= t) era = e;
  if (!era && retro) era = eras[0];
  if (!era || (era.end != null && t >= era.end && era !== eras[eras.length - 1])) return null;
  const year = Math.max(1, ymd(t).y - ymd(era.start).y + 1);
  return { era: era.name, year, text: `${era.name}${year === 1 ? '元' : year}年` };
}

// ---------------------------------------------------------------- CSV

// 引用符（"…"）で囲んだ値の中のカンマ・改行・二重引用符（""）にも対応する
export function parseCSV(text) {
  const s = text.replace(/^﻿/, '');
  const lines = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i += 1;
      row.push(cell);
      lines.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) { row.push(cell); lines.push(row); }
  const rows = lines.filter((r) => r.some((c) => c.trim() !== ''));
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const r = {};
    head.forEach((h, i) => { r[h] = (cells[i] ?? '').trim(); });
    return r;
  });
}

// ---------------------------------------------------------------- 項目

const ONGOING = new Set(['継続中', '在任中', '現在']);

// CSV の列の役割。chronology.json の data.columns で列名を変えられる。
export const DEFAULT_COLUMNS = { name: '名前', start: '開始日', end: '終了日' };

// CSV の行を年表の項目にする。spec は chronology.json の data、base は写真のパスの前に付けるディレクトリ。
// 同じ人が続けて務めた行（例：吉田茂の第48〜51代）は、spec.merge があれば1本にまとめる。
// 年・月までの終了日はふつうその期間の終わりまでとするが、spec.endAt が "start" なら初めで区切る
// （時代区分の「奈良 〜794年」「平安 794年〜」のように、終わりの年が次の始まりの年と同じ書き方のデータ向け）。
export function makeItems(rows, spec, asOfT, base = '') {
  const C = { ...DEFAULT_COLUMNS, ...spec.columns };
  const roles = new Set(Object.values(C));
  const hidden = new Set(spec.hidden ?? []);
  const items = [];
  for (const r of rows) {
    const name = r[C.name];
    const endStr = r[C.end] ?? '';
    const point = endStr === '' && !!spec.points;
    const ongoing = !point && (endStr === '' || ONGOING.has(endStr));
    const start = toTime(r[C.start]);
    const end = point ? start : ongoing ? Math.max(asOfT, start) : toTime(endStr, spec.endAt !== 'start');
    const ord = C.ordinal && r[C.ordinal] !== '' && r[C.ordinal] != null ? Number(r[C.ordinal]) : null;
    const prev = items[items.length - 1];
    if (spec.merge && prev && !prev.ongoing && prev.name === name && prev.end === start) {
      Object.assign(prev, { end, endStr, ongoing, ordTo: ord ?? prev.ordTo });
      continue;
    }
    const laneVal = C.lane ? r[C.lane] ?? '' : '';
    items.push({
      name,
      short: (C.short && r[C.short]) || name,
      reading: (C.reading && r[C.reading]) || '',
      startStr: r[C.start],
      endStr: point ? '' : endStr,
      startPrec: parseDate(r[C.start])?.prec ?? 'd',
      endPrec: parseDate(endStr)?.prec ?? 'd',
      start, end, ongoing, point,
      approx: !!(C.approx && r[C.approx]),
      ordFrom: ord, ordTo: ord,
      group: (C.group && r[C.group]) || '',
      lane: laneVal === '' ? null : spec.lanes?.[laneVal] ?? (Number.isFinite(Number(laneVal)) ? Number(laneVal) : null),
      photo: C.photo && r[C.photo] ? base + r[C.photo] : '',
      photoCredit: (C.photoCredit && r[C.photoCredit]) || '',
      photoUrl: (C.photoUrl && r[C.photoUrl]) || '',
      url: (C.url && r[C.url]) || '',
      details: Object.keys(r).filter((h) => !roles.has(h) && !hidden.has(h) && r[h] !== '').map((h) => [h, r[h]]),
    });
  }
  return items;
}

// 在任日数など。総理は首相官邸の数え方（就任日と退任日を両方含む）、大統領は就任日から退任日までの日数。
export function countDays(t, spec) {
  return Math.round((t.end - t.start) / DAY) + (spec.days === 'inclusive' ? 1 : 0);
}

const monthsOf = (s) => { const p = parseDate(s); return p ? p.y * 12 + p.m : NaN; };

// 期間の長さの文。spec.days で数え方を選ぶ（inclusive / exclusive は日数、months は月数、age は満年齢、なしは年数）
export function durationText(t, spec, asOfT) {
  if (t.point || t.kind === 'lead') return '';
  const label = spec.durationLabel ?? '期間';
  if (spec.days === 'inclusive' || spec.days === 'exclusive') {
    return `${label} ${fmtNum(t.days)}日${t.ongoing ? `（${fmtDate(asOfT)}時点）` : ''}`;
  }
  if (spec.days === 'months' && !t.ongoing) {
    return `${label} ${monthsOf(t.endStr) - monthsOf(t.startStr)}か月`;
  }
  if (spec.days === 'age') {
    const a = parseDate(t.startStr);
    const b = t.ongoing ? ymd(asOfT) : parseDate(t.endStr);
    if (!a || !b) return '';
    const exact = a.prec === 'd' && (t.ongoing || b.prec === 'd');
    const age = b.y - a.y - (exact && (b.m < a.m || (b.m === a.m && b.d < a.d)) ? 1 : 0);
    if (t.ongoing) return `存命（${age}歳）`;
    return exact && !t.approx ? `満${age}歳で没` : `${age}歳ごろ没`;
  }
  const years = (t.end - t.start) / YEAR;
  if (years < 2 && parseDate(t.startStr)?.prec === 'd') return `${label} ${fmtNum(t.days)}日`;
  return `${label} 約${Math.max(1, Math.round(years))}年`;
}

export function ordText(t) {
  if (t.ordFrom == null) return '';
  return t.ordFrom === t.ordTo ? `第${t.ordFrom}代` : `第${t.ordFrom}〜${t.ordTo}代`;
}

// spec.ongoing は続いているものの呼び方（在任中・存命など）
export function rangeText(t, spec = {}) {
  if (t.point) return fmtStr(t.startStr);
  const end = t.ongoing ? spec.ongoing ?? '現在' : fmtStr(t.endStr);
  return `${fmtStr(t.startStr)} 〜 ${end}`;
}

export function yearsText(t) {
  const a = parseDate(t.startStr)?.y ?? ymd(t.start).y;
  if (t.point) return yearShort(a);
  if (t.ongoing) return `${yearShort(a)}–`;
  const b = parseDate(t.endStr)?.y ?? ymd(t.end).y;
  return a === b ? yearShort(a) : `${yearShort(a)}–${yearShort(b)}`;
}

// その時点の項目。重なりのある列では、その時点のものをすべて返す。
export function termsAt(col, t) {
  const out = [];
  for (const x of col.terms) {
    if (x.point) continue;
    if (x.start <= t && (t < x.end || (x.ongoing && t <= x.end))) out.push(x);
  }
  return out;
}

// ---------------------------------------------------------------- モデル

// page は chronology.json の page、datasets はデータ名 → { spec, rows, base }。
export function buildModel({ page, datasets, asOf }) {
  const asOfT = toTime(asOf);
  const cache = new Map();
  const itemsOf = (id) => {
    if (!cache.has(id)) {
      const d = datasets[id];
      if (!d) throw new Error(`データ「${id}」が見つかりません`);
      cache.set(id, makeItems(d.rows, d.spec, asOfT, d.base ?? ''));
    }
    return cache.get(id);
  };
  const pick = (src) => {
    let list = itemsOf(src.data);
    if (src.group) list = list.filter((x) => [].concat(src.group).includes(x.group));
    if (src.lane != null) list = list.filter((x) => (x.lane ?? 0) === src.lane);
    if (src.after) list = list.filter((x) => x.start >= toTime(src.after));
    return list;
  };

  // 範囲。指定がなければ、列の最初の項目から最後の項目（続いているものは時点）まで。
  const all = page.columns.flatMap((c) => pick(c));
  const range = page.range ?? {};
  const first = Math.min(...all.map((x) => x.start));
  const last = Math.max(...all.map((x) => (x.ongoing ? asOfT : x.end)));
  const start = range.start ? toTime(range.start) : fromYMD(Math.floor(ymd(first).y / 10) * 10);
  const end = (range.end ? toTime(range.end) : last) + (range.pad ?? 450) * DAY;

  const byId = new Map();
  const columns = page.columns.map((c) => {
    const spec = datasets[c.data].spec;
    const terms = pick(c)
      .filter((x) => x.end > start || (x.point && x.start >= start))
      .filter((x) => x.start < end)
      .map((x, i) => ({ ...x, id: `${c.id}${i}`, col: c.id }));
    const col = { ...c, spec, terms, title: c.title ?? spec.title ?? c.data, role: c.role ?? spec.role ?? '' };
    for (const t of terms) t.days = countDays(t, spec);
    if (c.lead) {
      col.lead = { id: `${c.id}-lead`, col: c.id, kind: 'lead', name: c.lead.name, text: c.lead.text, start, end: toTime(c.lead.until) };
      byId.set(col.lead.id, col.lead);
    }
    // 同じ人が何度か務めたときの通算
    col.persons = new Map();
    for (const t of terms) {
      if (!col.persons.has(t.name)) col.persons.set(t.name, { terms: [], days: 0 });
      const p = col.persons.get(t.name);
      p.terms.push(t);
      p.days += t.days;
    }
    assignLanes(col);
    for (const t of terms) byId.set(t.id, t);
    return col;
  });
  const colById = new Map(columns.map((c) => [c.id, c]));
  // 同じ時期の他の列の項目（吹き出しの「同じ時期の…」と強調に使う）
  for (const c of columns) {
    const others = (c.counter ?? []).map((id) => colById.get(id)).filter(Boolean);
    for (const t of c.terms) {
      t.counter = others.flatMap((o) => o.terms.filter((u) => !u.point && u.start < t.end && u.end > t.start).map((u) => u.id));
    }
  }

  // 帯（元号・時代）と和暦
  const sp = page.spine ?? {};
  const bands = sp.bands
    ? pick(sp.bands).filter((x) => x.end > start && x.start < end).map((x) => ({ name: x.name, short: x.short, start: x.start, end: x.ongoing ? null : x.end, startStr: x.startStr }))
    : [];
  const eras = sp.wareki ? pick(sp.wareki).map((x) => ({ name: x.name, start: x.start, end: x.ongoing ? null : x.end })) : [];

  return {
    page, columns, colById, byId, bands, eras,
    retro: !!sp.retro,
    start, end,
    asOf: asOfT,
  };
}

// 重なる期間を別の段に分ける。lane の指定（南朝=0、北朝=1 など）があればその段を優先する。
// 一日の出来事（点）は段0に並べ、期間のあるものは段1から使う。
// 月・年までしか分からない日付どうし（例：「1372-05」に終わり「1372-05」に始まる）は、その精度の分の重なりを許す。
const SLACK = { d: 0, m: 31 * DAY, y: 366 * DAY };
function assignLanes(col) {
  const hasPoints = col.terms.some((t) => t.point);
  const first = hasPoints ? 1 : 0;
  const last = [];
  for (const t of col.terms) {
    if (t.point) { t.laneIdx = 0; continue; }
    const pref = first + (t.lane ?? 0);
    const tries = [pref];
    for (let i = first; i <= Math.max(pref, last.length); i += 1) if (i !== pref) tries.push(i);
    for (const i of tries) {
      const p = last[i];
      if (!p || p.end <= t.start + Math.max(SLACK[p.endPrec] ?? 0, SLACK[t.startPrec] ?? 0)) {
        t.laneIdx = i;
        last[i] = t;
        break;
      }
    }
  }
  col.nLanes = Math.max(1, last.length, hasPoints ? 1 : 0);
  col.hasPoints = hasPoints;
}

// ---------------------------------------------------------------- レイアウト

// 全角はほぼ1em、数字とラテン文字は約0.6emとして幅を見積もる（ラベル幅の判定用）。
export function textWidth(s, size) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    w += (c > 0x2e80 ? 1 : 0.6) * size;
  }
  return w;
}

// ラベルを縦方向に重ならないよう並べる。順番は保ち、本来の位置からのずれ（二乗和）が最小になるよう塊ごとに寄せる。
function dodge(items, lo, hi) {
  const clusters = [];
  const place = (c) => {
    let off = 0;
    let sum = 0;
    for (const x of c.items) { sum += x.target - off - x.h / 2; off += x.h; }
    c.top = Math.max(lo, Math.min(hi - c.h, sum / c.items.length));
  };
  for (const it of items) {
    const c = { items: [it], h: it.h, top: 0 };
    place(c);
    clusters.push(c);
    while (clusters.length > 1) {
      const b = clusters[clusters.length - 1];
      const a = clusters[clusters.length - 2];
      if (a.top + a.h <= b.top + 0.01) break;
      a.items.push(...b.items);
      a.h += b.h;
      clusters.pop();
      place(a);
    }
  }
  for (const c of clusters) {
    let off = 0;
    for (const x of c.items) { x.center = c.top + off + x.h / 2; off += x.h; }
  }
}

// 目盛りの間隔（年）。縮尺が小さいほど粗くする。
function tickSteps(ppy) {
  if (ppy >= 12) return { major: 10, minor: 1 };
  if (ppy >= 5) return { major: 50, minor: 10 };
  if (ppy >= 2.5) return { major: 100, minor: 10 };
  return { major: 200, minor: 50 };
}

const isTick = (y, step) => (y <= 0 ? (1 - y) % step === 0 : y % step === 0);

export function layout(model, opts = {}) {
  const P = model.page;
  const width = Math.round(opts.width ?? 760);
  const narrow = width < 600;
  const g = { width, narrow };
  const [ppyWide, ppyNarrow] = P.ppy ?? [24, 22];
  g.ppy = opts.ppy ?? (narrow ? ppyNarrow : ppyWide);
  g.headerH = narrow ? 58 : 70;
  g.footerH = opts.footer ? 70 : 24;
  g.top = g.headerH;
  g.t0 = model.start;
  g.t1 = model.end;
  g.yOf = (t) => g.top + ((t - g.t0) / YEAR) * g.ppy;
  g.tOf = (y) => g.t0 + ((y - g.top) / g.ppy) * YEAR;
  g.plotBottom = g.yOf(g.t1);
  g.height = Math.ceil(g.plotBottom + g.footerH);

  g.nameSize = narrow ? 12.5 : 13.5;
  g.yearSize = narrow ? 10.5 : 11;
  g.labelH = narrow ? 15.5 : 17;
  g.photo = narrow ? 24 : 30;
  g.labelGap = narrow ? 11 : 15;
  g.insideSize = narrow ? 11 : 12;
  const barGap = narrow ? 5 : 7;
  let colGap = narrow ? 10 : 16;

  // ---- 帯
  g.spinePos = P.spine?.position ?? 'center';
  g.spineW = g.spinePos === 'left' ? (narrow ? 56 : 72) : (narrow ? 66 : 92);

  // ---- 列
  const hidden = opts.hidden ?? new Set();
  const cols = model.columns.filter((c) => !hidden.has(c.id)).map((c) => {
    const barW = c.bar ?? (c.labels === 'inside' ? (narrow ? 18 : 22) : (narrow ? 10 : 14));
    const laneGap = 2;
    return {
      c, side: g.spinePos === 'left' ? 'right' : c.side ?? 'right',
      barW, laneGap,
      barsW: c.nLanes * barW + (c.nLanes - 1) * laneGap,
      mode: c.labels ?? 'side',
      photo: !!c.photos,
    };
  });
  // ラベル付きの列が多いページは、列のあいだを少し詰める
  if (!narrow && cols.filter((x) => x.mode === 'side').length > 5) {
    g.labelGap = 11;
    colGap = 10;
  }
  // 各側でいちばん帯に近いラベル付きの列（総理・米大統領など）を主な列とし、名前を省略しない
  for (const side of ['left', 'right']) {
    const first = cols.find((x) => x.side === side && x.mode === 'side');
    if (first) first.primary = true;
  }
  const labelWidth = (col, t, withYears) => {
    let w = textWidth(t.short, g.nameSize);
    if (withYears) w += 6 + textWidth(yearsText(t), g.yearSize);
    if (col.photo && t.photo) w += g.photo + 6;
    return w;
  };
  // ラベルに要る幅。狭い画面では、とくに長い名前（上位1割）は省略してよいことにして配分する
  const need = (col) => {
    if (col.mode !== 'side' || !col.labeled) return 0;
    const ws = col.c.terms.map((t) => labelWidth(col, t, col.withYears)).sort((a, b) => a - b);
    const widest = narrow || !col.primary ? ws[Math.floor((ws.length - 1) * 0.9)] ?? 0 : Math.max(0, ...ws, col.c.lead ? textWidth(col.c.lead.name, g.nameSize) : 0);
    return g.labelGap + Math.min(widest, narrow ? 150 : 230) + 4;
  };
  const sideNeed = (side) => cols
    .filter((x) => x.side === side)
    .reduce((s, x) => s + x.barsW + need(x) + (x.mode === 'side' && x.labeled ? colGap : Math.max(4, (narrow ? 10 : 11) + 3 - x.barsW)), barGap);

  // 棒の中に名前を書く列が入りきらなければ、棒を細くして文字も小さくする
  const avail = width - g.spineW;
  const insideCols = cols.filter((x) => x.mode === 'inside');
  if (insideCols.length) {
    const fixed = cols.filter((x) => x.mode !== 'inside').reduce((s, x) => s + x.barsW + (x.mode === 'side' ? 120 : 4), 0);
    const lanes = insideCols.reduce((s, x) => s + x.c.nLanes, 0);
    const room = avail - fixed - colGap * insideCols.length - barGap * 2;
    const per = Math.floor(room / lanes) - 2;
    if (per < insideCols[0].barW) {
      const barW = Math.max(12, per);
      for (const x of insideCols) {
        x.barW = barW;
        x.barsW = x.c.nLanes * barW + (x.c.nLanes - 1) * x.laneGap;
      }
      g.insideSize = Math.max(9, Math.min(g.insideSize, barW - 5));
    }
  }

  // 入りきらなければ、設定の後ろの列から順に年の表示をやめ（主な列の年はなるべく残す）、
  // それでも入らなければ外側以外の列のラベルを省く
  const fits = () => {
    const L = sideNeed('left');
    const R = sideNeed('right');
    return g.spinePos === 'left' ? R <= avail : L + R <= avail;
  };
  for (const x of cols) {
    x.labeled = x.mode === 'side';
    x.withYears = true;
  }
  for (const x of [...cols].reverse()) {
    if (fits()) break;
    x.withYears = false;
  }
  if (!fits()) {
    for (const side of ['left', 'right']) {
      const labeled = cols.filter((x) => x.side === side && x.labeled);
      for (const x of labeled.slice(1).reverse()) {
        if (fits()) break;
        x.labeled = false;
      }
    }
  }
  g.showYears = cols.some((x) => x.labeled && x.withYears);

  // 帯の位置。両側が半分ずつに収まれば中央、そうでなければ広い側に寄せる
  if (g.spinePos === 'left') {
    g.spineX0 = 0;
  } else {
    const L = sideNeed('left');
    const R = sideNeed('right');
    const half = avail / 2;
    let left = half;
    if (L > half || R > half) left = L + R <= avail ? Math.max(L, Math.min(half, avail - R)) : (avail * L) / (L + R);
    g.spineX0 = Math.round(left);
  }
  g.spineX1 = g.spineX0 + g.spineW;
  g.cx = g.spineX0 + g.spineW / 2;

  // ラベルのない細い列のあとの間隔。縦書きの見出し（1文字ぶんの幅）が隣と重ならないようにする
  const thinGap = (col) => Math.max(4, (narrow ? 10 : 11) + 3 - col.barsW);

  // 列を帯の外側へ順に置く。ラベルのない細い列は帯の側に寄せ、いちばん外側のラベル付きの列は画面の端までラベルを広げてよい
  for (const side of ['left', 'right']) {
    const list = [...cols.filter((x) => x.side === side && !x.labeled), ...cols.filter((x) => x.side === side && x.labeled)];
    const lastLabeled = [...list].reverse().find((x) => x.labeled);
    let x = side === 'right' ? g.spineX1 + barGap : g.spineX0 - barGap;
    for (const col of list) {
      const n = need(col);
      if (side === 'right') {
        col.barsX0 = x;
        col.barsX1 = x + col.barsW;
        col.laneX = (i) => col.barsX0 + i * (col.barW + col.laneGap);
        if (col.labeled) {
          col.labelX = col.barsX1 + g.labelGap;
          col.labelEdge = col === lastLabeled ? width - 4 : col.barsX1 + n;
          x = col.labelEdge + colGap;
        } else {
          x = col.barsX1 + thinGap(col);
        }
      } else {
        col.barsX1 = x;
        col.barsX0 = x - col.barsW;
        col.laneX = (i) => col.barsX1 - (i + 1) * col.barW - i * col.laneGap;
        if (col.labeled) {
          col.labelX = col.barsX0 - g.labelGap;
          col.labelEdge = col === lastLabeled ? 4 : col.barsX0 - n;
          x = col.labelEdge - colGap;
        } else {
          x = col.barsX0 - thinGap(col);
        }
      }
      col.labelRoom = col.labeled ? Math.abs(col.labelX - col.labelEdge) : 0;
    }
    // 列の見出しは、次の列の棒の手前（いちばん外側の列は画面の端）まで使える
    list.forEach((col, i) => {
      const next = list[i + 1];
      if (col.labeled) col.headRoom = side === 'right' ? (next ? next.barsX0 : width) - col.labelX - 6 : col.labelX - (next ? next.barsX1 : 0) - 6;
      else col.headRoom = side === 'right' ? (next ? next.barsX0 : width) - col.barsX0 - 3 : col.barsX1 - (next ? next.barsX1 : 0) - 3;
    });
  }
  g.cols = cols;

  // ---- 棒とラベル
  for (const col of cols) {
    const c = col.c;
    col.bars = c.terms.map((t) => {
      const clipped = t.start < g.t0;
      const y0 = Math.max(g.top, g.yOf(t.start));
      const y1 = Math.min(g.plotBottom, g.yOf(t.end));
      const h = col.labeled && col.photo && t.photo ? Math.max(g.labelH, g.photo + 4) : g.labelH;
      const anchor = t.point ? y0 : y0 + Math.min((y1 - y0) / 2, g.labelH / 2);
      return { term: t, y0, y1, h, target: anchor, anchor, clipped, x: col.laneX(t.laneIdx) };
    });
    if (c.lead) {
      const y0 = g.yOf(c.lead.start);
      col.lead = { term: c.lead, y0: Math.max(g.top, y0), y1: g.yOf(c.lead.end), h: g.labelH, x: col.laneX(0) };
      col.lead.target = col.lead.anchor = g.top + g.labelH / 2;
    }
    if (col.labeled) {
      const items = [...(col.lead ? [col.lead] : []), ...col.bars].map((b) => ({ ref: b, target: b.target, h: b.h }));
      dodge(items, g.top, g.plotBottom);
      for (const it of items) it.ref.labelY = it.center;
    }
  }

  // ---- 帯（元号・時代）と目盛り
  const bands = model.bands;
  g.eraBands = bands.map((e, i) => {
    const next = bands[i + 1];
    return {
      era: e, i,
      y0: i === 0 ? g.top : Math.max(g.top, g.yOf(e.start)),
      y1: next ? g.yOf(next.start) : e.end != null ? Math.min(g.plotBottom, g.yOf(e.end)) : g.plotBottom,
    };
  });
  // 帯の名前は、次の区切りまでの長さに応じて「名前と日付」「名前だけ」「出さない」を選ぶ
  g.eraMarks = g.eraBands
    .map((b) => ({ era: b.era, i: b.i, y: b.i === 0 && b.era.start < g.t0 ? g.top : g.yOf(b.era.start), room: b.y1 - Math.max(g.top, g.yOf(b.era.start)) }))
    .filter((m) => m.y >= g.top && m.y <= g.plotBottom)
    .map((m) => ({ ...m, show: m.room >= 46 ? 2 : m.room >= 26 ? 1 : 0 }));
  g.asOfY = g.yOf(model.asOf);
  g.showAsOf = model.columns.some((c) => c.terms.some((t) => t.ongoing)) && g.asOfY < g.plotBottom;

  const steps = tickSteps(g.ppy);
  g.steps = steps;
  const startYear = ymd(g.t0).y;
  const endYear = ymd(g.t1).y;
  g.years = [];
  for (let y = startYear; y <= endYear; y += 1) {
    if (!isTick(y, steps.minor) && !(y === 1 && startYear < 1)) continue;
    const yy = g.yOf(fromYMD(y));
    if (yy >= g.top && yy <= g.plotBottom) g.years.push({ year: y, y: yy, major: isTick(y, steps.major) || (y === 1 && startYear < 1) });
  }
  const blocked = [
    ...g.eraMarks.filter((m) => m.show).map((m) => [m.y - 4, m.y + (m.show === 2 ? 44 : 30)]),
    ...(g.showAsOf ? [[g.asOfY - 4, g.asOfY + 34]] : []),
  ];
  g.decades = g.years
    .filter((d) => d.major)
    .map((d) => ({ ...d, hidden: blocked.some(([a, b]) => d.y + 19 > a && d.y - 10 < b) }));

  return g;
}

// ---------------------------------------------------------------- SVG

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r1 = (n) => Math.round(n * 10) / 10;

// 上下の角を個別に丸められる棒の形
function barPath(x, y, w, h, roundTop, roundBottom) {
  const r = Math.min(3, h / 2, w / 2);
  const t = roundTop ? r : 0;
  const b = roundBottom ? r : 0;
  const X = r1(x), Y = r1(y), R = r1(x + w), B = r1(y + h);
  return `M${X} ${r1(y + t)}Q${X} ${Y} ${r1(x + t)} ${Y}H${r1(x + w - t)}Q${R} ${Y} ${R} ${r1(y + t)}V${r1(y + h - b)}Q${R} ${B} ${r1(x + w - b)} ${B}H${r1(x + b)}Q${X} ${B} ${X} ${r1(y + h - b)}Z`;
}

// 棒の色。列の色か、区分（group）ごとの色。"hatch" は斜線、"gray" は灰色。
export function fillOf(col, t) {
  const groups = col.spec.groups ?? {};
  const name = col.colorBy === 'group' ? groups[t.group]?.color ?? 'gray' : col.color ?? 'gray';
  return name;
}

export function termSummary(t, col, model) {
  const head = [ordText(t), col.role].filter(Boolean).join('');
  const dur = durationText(t, col.spec, model.asOf);
  return `${head ? `${head} ` : ''}${t.name}　${rangeText(t, col.spec)}${dur ? `（${dur}）` : ''}`;
}

// 幅に入らない文字列は、末尾を「…」にして縮める
function fitText(text, size, room) {
  if (textWidth(text, size) <= room) return text;
  const chars = [...text];
  while (chars.length > 1 && textWidth(`${chars.join('')}…`, size) > room) chars.pop();
  return `${chars.join('')}…`;
}

// 縦書きのラベルが入るか（棒の幅と長さで判定。縦書きでは1文字がほぼ1em）
function insideFits(text, w, h, size) {
  return w >= size + 4 && h >= [...String(text)].length * size + 8;
}

export function renderSVG(model, g, opts = {}) {
  const { interactive = false, style = '', background = false, footer = null, titleTag = null, photoData = null } = opts;
  const W = g.width;
  const H = g.height;
  const title = titleTag || model.page.title;
  const o = [];
  const a11y = interactive ? `role="group" aria-label="${esc(title)}の年表"` : 'role="img" aria-labelledby="tl-title"';
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" class="tl" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" ${a11y}>`);
  if (!interactive) o.push(`<title id="tl-title">${esc(title)}</title>`);
  if (style) o.push(`<style>${style}</style>`);

  o.push('<defs>');
  o.push('<pattern id="tl-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" class="hatch-bg"/><line x1="0" y1="0" x2="0" y2="6" class="hatch-line"/></pattern>');
  o.push('<clipPath id="tl-round" clipPathUnits="objectBoundingBox"><circle cx="0.5" cy="0.5" r="0.5"/></clipPath>');
  o.push('</defs>');

  if (background) o.push(`<rect class="bg" x="0" y="0" width="${W}" height="${H}" rx="14"/>`);

  // 見出し（列名と、帯の「西暦／和暦」）
  const hy = g.headerH - 26;
  for (const col of g.cols) {
    const c = col.c;
    const fill = c.colorBy === 'group' ? 'gray' : c.color ?? 'gray';
    const x = col.side === 'right' ? col.barsX0 : col.barsX1 - col.barW;
    const text = g.narrow || (col.labeled && textWidth(c.title, 14.5) > col.headRoom) ? c.short ?? c.title : c.title;
    if (col.labeled) {
      o.push(`<rect class="f-${fill}" x="${r1(x)}" y="${hy - 11}" width="${col.barW}" height="14" rx="3"/>`);
      const tx = col.labelX;
      o.push(`<text class="lane-h" x="${r1(tx)}" y="${hy}"${col.side === 'left' ? ' text-anchor="end"' : ''}>${esc(text)}</text>`);
    } else {
      // ラベルを外に出さない列は、棒の上に名前を出す。正式名・略称・1文字の順に、横書きで入るものを使い、
      // どれも入らない細い列は縦書きの短い名前にする
      const size = g.narrow ? 11.5 : 13;
      const names = [c.title, c.short, c.mark].filter(Boolean);
      const name = names.find((n) => textWidth(n, size) <= Math.max(col.barsW + 2, col.headRoom));
      if (name) {
        o.push(`<text class="lane-s" x="${r1(col.barsX0)}" y="${hy - 4}">${esc(name)}</text>`);
      } else {
        const cx = (col.barsX0 + col.barsX1) / 2;
        o.push(`<text class="lane-v" x="${r1(cx)}" y="${r1(hy - 24)}" writing-mode="vertical-rl">${esc(c.mark ?? c.short ?? c.title)}</text>`);
      }
      o.push(`<rect class="f-${fill}" x="${r1(col.barsX0)}" y="${hy + 2}" width="${r1(col.barsW)}" height="6" rx="2"/>`);
    }
  }
  const sp = model.page.spine ?? {};
  o.push(`<text class="spine-h" x="${r1(g.cx)}" y="${hy - 3}" text-anchor="middle">西暦</text>`);
  if (sp.headline) o.push(`<text class="spine-h2" x="${r1(g.cx)}" y="${hy + 10}" text-anchor="middle">${esc(sp.headline)}</text>`);

  // 中央の帯（元号・時代ごとに色を交互に）
  if (g.eraBands.length) {
    for (const b of g.eraBands) {
      const y0 = Math.max(g.top, b.y0);
      const y1 = Math.min(g.plotBottom, b.y1);
      if (y1 <= y0) continue;
      o.push(`<rect class="${b.i % 2 ? 'spine-b' : 'spine-a'}" x="${r1(g.spineX0)}" y="${r1(y0)}" width="${g.spineW}" height="${r1(y1 - y0)}"/>`);
    }
  } else {
    o.push(`<rect class="spine-a" x="${r1(g.spineX0)}" y="${r1(g.top)}" width="${g.spineW}" height="${r1(g.plotBottom - g.top)}"/>`);
  }

  // 大きな目盛りの横線（全幅）。帯の区切りのすぐ近くでは二重線に見えるので引かない。
  for (const d of g.decades) {
    if (d.hidden) continue;
    o.push(`<line class="grid" x1="0" x2="${W}" y1="${r1(d.y)}" y2="${r1(d.y)}"/>`);
  }
  // 帯の区切り線（全幅）
  for (const m of g.eraMarks) {
    if (m.i === 0 && m.y <= g.top) continue;
    o.push(`<line class="era-line" x1="0" x2="${W}" y1="${r1(m.y)}" y2="${r1(m.y)}"/>`);
  }

  // 年の目盛り（帯の両端）
  for (const d of g.years) {
    const len = d.major ? 9 : isTick(d.year, g.steps.minor * 5) ? 6 : 3;
    const y = r1(d.y);
    o.push(`<path class="tick" d="M${r1(g.spineX0)} ${y}h${len}M${r1(g.spineX1)} ${y}h-${len}"/>`);
  }
  // 大きな目盛りの年（西暦＋和暦）
  for (const d of g.decades) {
    if (d.hidden) continue;
    o.push(`<text class="dec-y" x="${r1(g.cx)}" y="${r1(d.y + 4.5)}" text-anchor="middle">${yearShort(d.year)}</text>`);
    const w = model.eras.length ? wareki(fromYMD(d.year), model.eras, model.retro) : null;
    if (w) o.push(`<text class="dec-w" x="${r1(g.cx)}" y="${r1(d.y + 18)}" text-anchor="middle">${esc(w.text)}</text>`);
  }
  // 帯の見出し
  for (const m of g.eraMarks) {
    if (!m.show) continue;
    // 帯の幅に入らない名前は略称にし、それでも入らなければ文字を小さくする
    const size = g.narrow ? 17 : 19;
    const room = g.spineW - 8;
    const label = textWidth(m.era.name, size) > room && m.era.short ? m.era.short : m.era.name;
    const fit = Math.min(size, room / Math.max(1, textWidth(label, 1)));
    const fs = fit < size ? ` style="font-size:${r1(fit)}px"` : '';
    o.push(`<text class="era-name" x="${r1(g.cx)}" y="${r1(m.y + 23)}" text-anchor="middle"${fs}>${esc(label)}</text>`);
    if (m.show === 2) {
      const p = parseDate(m.era.startStr);
      const date = p && p.prec === 'd' ? fmtDot(m.era.start) : p ? yearShort(p.y) : '';
      if (date) o.push(`<text class="era-date" x="${r1(g.cx)}" y="${r1(m.y + 37)}" text-anchor="middle">${date}</text>`);
    }
  }
  // データの時点
  if (g.showAsOf) {
    const xs = g.cols.flatMap((c) => [c.barsX0, c.barsX1]);
    o.push(`<line class="asof-line" x1="${r1(Math.min(g.spineX0, ...xs) - 4)}" x2="${r1(Math.max(g.spineX1, ...xs) + 4)}" y1="${r1(g.asOfY)}" y2="${r1(g.asOfY)}"/>`);
    o.push(`<text class="era-date" x="${r1(g.cx)}" y="${r1(g.asOfY + 14)}" text-anchor="middle">${fmtDot(model.asOf)}</text>`);
    o.push(`<text class="era-date" x="${r1(g.cx)}" y="${r1(g.asOfY + 27)}" text-anchor="middle">時点</text>`);
  }

  // 列のはじまりより前の期間（内閣制度発足前など）
  for (const col of g.cols) {
    const p = col.lead;
    if (!p) continue;
    const h = r1(p.y1 - p.y0 - 1);
    o.push(`<g class="term lead" data-id="${p.term.id}"${interactive ? ` tabindex="0" aria-label="${esc(`${p.term.name}。${p.term.text}`)}"` : ''}>`);
    if (!interactive) o.push(`<title>${esc(p.term.text)}</title>`);
    const reach = col.labeled ? 120 : 0;
    const hx0 = col.side === 'left' ? p.x - reach : p.x;
    o.push(`<rect class="hit" x="${r1(hx0)}" y="${r1(p.y0)}" width="${r1(col.barW + reach)}" height="${h}"/>`);
    o.push(`<rect class="bar-lead" x="${r1(p.x)}" y="${r1(p.y0)}" width="${col.barW}" height="${h}" rx="3"/>`);
    if (col.labeled) {
      const name = fitText(p.term.name, g.nameSize, Math.abs(col.labelX - col.labelEdge));
      o.push(`<text class="label" x="${r1(col.labelX)}" y="${r1(p.labelY + g.nameSize * 0.36)}"${col.side === 'left' ? ' text-anchor="end"' : ''}><tspan class="name lead-name">${esc(name)}</tspan></text>`);
    }
    o.push('</g>');
  }

  // 読み取り用の横線（棒とラベルの下に敷く）
  if (interactive) {
    o.push(`<g class="xhair" transform="translate(0 ${g.top})" aria-hidden="true"><line class="xhair-line" x1="0" x2="${W}" y1="0" y2="0"/></g>`);
  }

  // ホバー用の当たり判定（描画はしない）。棒とラベルより下に置き、ラベルの上では隣の期間に負けないようにする。
  if (interactive) {
    o.push('<g class="hits">');
    for (const col of g.cols) {
      for (const b of col.bars) {
        let x0;
        let x1;
        if (col.labeled) {
          const reach = Math.min(col.labelRoom, col.withYears ? 160 : 104);
          x0 = col.side === 'left' ? col.labelX - reach : b.x;
          x1 = col.side === 'left' ? b.x + col.barW : col.labelX + reach;
        } else {
          x0 = b.x - 3;
          x1 = b.x + col.barW + 3;
        }
        const ly = b.labelY ?? b.anchor;
        const y0 = Math.min(b.y0, col.labeled ? ly - b.h / 2 : b.y0) - (b.term.point ? 5 : 0);
        const y1 = Math.max(b.y1, col.labeled ? ly + b.h / 2 : b.y1, b.y0 + 4) + (b.term.point ? 5 : 0);
        o.push(`<rect class="hit" data-id="${b.term.id}" x="${r1(x0)}" y="${r1(y0)}" width="${r1(x1 - x0)}" height="${r1(y1 - y0)}"/>`);
      }
    }
    o.push('</g>');
  }

  // 期間の棒・出来事の点・ラベル
  for (const col of g.cols) {
    const c = col.c;
    if (col.c.hasPoints) {
      // 点を並べる軸
      const x = r1(col.laneX(0) + col.barW / 2);
      o.push(`<line class="axis" x1="${x}" x2="${x}" y1="${r1(g.top)}" y2="${r1(g.plotBottom)}"/>`);
    }
    for (const b of col.bars) {
      const t = b.term;
      const fill = fillOf(c, t);
      const attrs = interactive ? ` tabindex="0" aria-label="${esc(termSummary(t, c, model))}"` : '';
      o.push(`<g class="term c-${c.id}" data-id="${t.id}" data-person="${esc(`${c.id}:${t.name}`)}"${attrs}>`);
      if (!interactive) o.push(`<title>${esc(termSummary(t, c, model))}</title>`);
      const x = b.x;
      if (t.point) {
        const cy = r1(b.y0);
        o.push(`<circle class="dot f-${fill}" cx="${r1(x + col.barW / 2)}" cy="${cy}" r="${g.narrow ? 3.5 : 4}"/>`);
      } else {
        const gapTop = 1;
        const gapBottom = t.ongoing ? 0 : 1;
        let y0 = b.y0 + gapTop;
        let h = b.y1 - b.y0 - gapTop - gapBottom;
        if (h < 3) { y0 = b.y0 + (b.y1 - b.y0) / 2 - 1.5; h = 3; }
        const cls = `${fill === 'hatch' ? 'bar-hatch' : `bar f-${fill}`}${c.fadeApprox && t.approx ? ' approx' : ''}`;
        if ((t.ongoing || b.clipped) && fill !== 'hatch') {
          // 在任中は下端を、年表の始まりより前から続くものは上端を薄くして、棒が続いていることを示す
          const yTop = b.clipped ? b.y0 : y0;
          const yBot = t.ongoing ? b.y1 : b.y1 - gapBottom;
          const gid = `tl-g-${t.id}`;
          const [g1, g2, o1, o2] = t.ongoing ? [yBot - 22, yBot, 1, 0] : [yTop, yTop + 22, 0, 1];
          o.push(`<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="0" y1="${r1(g1)}" x2="0" y2="${r1(g2)}"><stop offset="0" class="s-${fill}" stop-opacity="${o1}"/><stop offset="1" class="s-${fill}" stop-opacity="${o2}"/></linearGradient>`);
          o.push(`<path class="bar-open" d="${barPath(x, yTop, col.barW, yBot - yTop, !b.clipped, !t.ongoing)}" fill="url(#${gid})"/>`);
        } else if (t.end > model.asOf && fill !== 'hatch') {
          // 終了がまだ先のもの（予定）は、時点より後を薄くする
          const split = Math.max(y0, Math.min(y0 + h, g.yOf(model.asOf)));
          if (split > y0) o.push(`<rect class="${cls}" x="${r1(x)}" y="${r1(y0)}" width="${col.barW}" height="${r1(split - y0)}" rx="${r1(Math.min(3, (split - y0) / 2))}"/>`);
          o.push(`<rect class="${cls} future" x="${r1(x)}" y="${r1(split)}" width="${col.barW}" height="${r1(y0 + h - split)}" rx="${r1(Math.min(3, (y0 + h - split) / 2))}"/>`);
        } else {
          o.push(`<rect class="${cls}" x="${r1(x)}" y="${r1(y0)}" width="${col.barW}" height="${r1(h)}" rx="${r1(Math.min(3, h / 2))}"/>`);
        }
        // 棒の中の縦書きの名前
        if (col.mode === 'inside') {
          const text = t.short;
          if (insideFits(text, col.barW, h, g.insideSize)) {
            o.push(`<text class="inside${fill === 'hatch' || fill === 'gray' ? ' on-pale' : ''}" x="${r1(x + col.barW / 2)}" y="${r1(y0 + 5)}" writing-mode="vertical-rl">${esc(text)}</text>`);
          }
        }
      }
      if (col.labeled) {
        // 引き出し線（ラベルが本来の位置からずれたときと、外側の段の棒をまたぐときだけ）
        const dy = b.labelY - b.anchor;
        const photo = col.photo && t.photo;
        const crosses = col.c.nLanes > 1 && col.bars.some((o) => o.term.laneIdx > t.laneIdx && !o.term.point && o.y0 <= b.anchor && o.y1 >= b.anchor);
        if (Math.abs(dy) > 1.5 || crosses) {
          if (col.side === 'left') {
            const xb = x - 1.5;
            o.push(`<path class="leader" d="M${r1(xb)} ${r1(b.anchor)}h-4L${r1(col.labelX + 4)} ${r1(b.labelY)}h-2"/>`);
          } else {
            const xb = x + col.barW + 1.5;
            o.push(`<path class="leader" d="M${r1(xb)} ${r1(b.anchor)}h4L${r1(col.labelX - 4)} ${r1(b.labelY)}h2"/>`);
          }
        }
        const ty = r1(b.labelY + g.nameSize * 0.36);
        const yrs = esc(yearsText(t));
        let tx = col.labelX;
        if (photo) {
          const px = col.side === 'left' ? col.labelX - g.photo : col.labelX;
          const py = b.labelY - g.photo / 2;
          const href = photoData?.[t.photo] ?? t.photo;
          o.push(`<circle class="photo-ring" cx="${r1(px + g.photo / 2)}" cy="${r1(b.labelY)}" r="${r1(g.photo / 2 + 1)}"/>`);
          o.push(`<image href="${esc(href)}" x="${r1(px)}" y="${r1(py)}" width="${g.photo}" height="${g.photo}" clip-path="url(#tl-round)" preserveAspectRatio="xMidYMid slice"/>`);
          tx = col.side === 'left' ? px - 6 : px + g.photo + 6;
        }
        const room = Math.abs(tx - col.labelEdge);
        const withYears = col.withYears && textWidth(t.short, g.nameSize) + 6 + textWidth(yearsText(t), g.yearSize) <= room;
        // 入りきらない名前は末尾を「…」にする（全文は吹き出しと読み取り欄に出る）
        const nm = esc(fitText(t.short, g.nameSize, room));
        if (col.side === 'left') {
          const inner = withYears ? `<tspan class="yrs">${yrs}</tspan><tspan class="name" dx="6">${nm}</tspan>` : `<tspan class="name">${nm}</tspan>`;
          o.push(`<text class="label" x="${r1(tx)}" y="${ty}" text-anchor="end">${inner}</text>`);
        } else {
          const inner = withYears ? `<tspan class="name">${nm}</tspan><tspan class="yrs" dx="6">${yrs}</tspan>` : `<tspan class="name">${nm}</tspan>`;
          o.push(`<text class="label" x="${r1(tx)}" y="${ty}">${inner}</text>`);
        }
      }
      o.push('</g>');
    }
  }

  // 横線が棒と交わる点（棒の上に重ねる）。段が1つの列だけ。
  if (interactive) {
    o.push(`<g class="xhair xhair-dots" transform="translate(0 ${g.top})" aria-hidden="true">`);
    for (const col of g.cols) {
      if (col.c.nLanes !== 1 || col.c.hasPoints) continue;
      const fill = col.c.colorBy === 'group' ? 'gray' : col.c.color ?? 'gray';
      o.push(`<circle class="xhair-dot f-${fill}" data-col="${col.c.id}" cx="${r1(col.laneX(0) + col.barW / 2)}" cy="0" r="${g.narrow ? 4 : 5}"/>`);
    }
    o.push('</g>');
  }

  if (footer) {
    const fy = g.plotBottom + 30;
    footer.forEach((line, i) => {
      o.push(`<text class="foot" x="${W / 2}" y="${r1(fy + i * 16)}" text-anchor="middle">${esc(line)}</text>`);
    });
  }

  o.push('</svg>');
  return o.join('\n');
}

// ---------------------------------------------------------------- 静的SVG用のスタイル

// 列の色。名前は色相で付け、ページ側の CSS 変数と同じものを使う（ライト／ダークそれぞれ検証済み）。
export const HUES = ['red', 'blue', 'amber', 'violet', 'green', 'teal'];

export const THEMES = {
  light: {
    paper: '#fcfcfd', ink: '#1c2029', ink2: '#4b5260', muted: '#687080',
    rule: '#e8eaef', rule2: '#c3c8d2', spineA: '#f0f1f5', spineB: '#e6e8ef',
    red: '#d4452c', blue: '#2c5aa0', amber: '#b8730f', violet: '#7a4fc4', green: '#138a60', teal: '#00897b',
    gray: '#9aa0ab',
  },
  dark: {
    paper: '#14171f', ink: '#e6e8ee', ink2: '#b2b8c4', muted: '#8d94a3',
    rule: '#232833', rule2: '#3d4452', spineA: '#1b1f29', spineB: '#222733',
    red: '#e5604a', blue: '#678bd2', amber: '#c98500', violet: '#9085e9', green: '#199e70', teal: '#1f9fa1',
    gray: '#6b7280',
  },
};

export const FONT_BODY = '"BIZ UDPGothic", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", YuGothic, Meiryo, "Noto Sans JP", "Noto Sans CJK JP", sans-serif';
export const FONT_DISPLAY = '"Shippori Mincho B1", "Hiragino Mincho ProN", "Yu Mincho", YuMincho, "BIZ UDPMincho", "Noto Serif JP", "Noto Serif CJK JP", serif';

// 色以外の見た目。ページ側では var(--…) をページのトークンに対応させる。
export function svgRules(g) {
  const fills = [...HUES, 'gray'].map((h) => `.tl .f-${h}{fill:var(--${h})}\n.tl .s-${h}{stop-color:var(--${h})}`).join('\n');
  return `
.tl .bg{fill:var(--paper)}
.tl .spine-a{fill:var(--spine-a)}
.tl .spine-b{fill:var(--spine-b)}
.tl .grid{stroke:var(--rule);stroke-width:1}
.tl .era-line{stroke:var(--rule2);stroke-width:1}
.tl .asof-line{stroke:var(--muted);stroke-width:1}
.tl .tick{stroke:var(--rule2);stroke-width:1;fill:none}
.tl .axis{stroke:var(--rule2);stroke-width:1}
.tl text{font-family:var(--font-body)}
.tl .dec-y{font-size:${g.narrow ? 12 : 13}px;font-weight:700;fill:var(--ink);font-variant-numeric:tabular-nums}
.tl .dec-w{font-size:${g.narrow ? 9.5 : 10.5}px;fill:var(--muted)}
.tl .era-name{font-family:var(--font-display);font-size:${g.narrow ? 17 : 19}px;font-weight:800;fill:var(--ink)}
.tl .era-date{font-size:${g.narrow ? 9.5 : 10}px;fill:var(--muted);font-variant-numeric:tabular-nums}
.tl .spine-h{font-size:10.5px;font-weight:700;fill:var(--ink2)}
.tl .spine-h2{font-size:10.5px;fill:var(--muted)}
.tl .lane-h{font-size:${g.narrow ? 13 : 14.5}px;font-weight:700;fill:var(--ink)}
.tl .lane-v{font-size:${g.narrow ? 10 : 11}px;font-weight:700;fill:var(--ink2)}
.tl .lane-s{font-size:${g.narrow ? 11.5 : 13}px;font-weight:700;fill:var(--ink)}
${fills}
.tl .future{opacity:0.4}
.tl .approx{opacity:0.45}
.tl .bar-lead{fill:url(#tl-hatch)}
.tl .bar-hatch{fill:url(#tl-hatch);stroke:var(--rule2);stroke-width:1}
.tl .hatch-bg{fill:var(--spine-a)}
.tl .hatch-line{stroke:var(--rule2);stroke-width:1.5}
.tl .dot{stroke:var(--paper);stroke-width:2}
.tl .photo-ring{fill:var(--spine-b)}
.tl .label{font-size:${g.nameSize}px}
.tl .name{fill:var(--ink)}
.tl .lead-name{fill:var(--muted)}
.tl .yrs{font-size:${g.yearSize}px;fill:var(--muted);font-variant-numeric:tabular-nums}
.tl .inside{font-size:${g.insideSize}px;font-weight:700;fill:#fff;letter-spacing:0.04em}
.tl .inside.on-pale{fill:var(--ink)}
.tl .leader{stroke:var(--rule2);stroke-width:1;fill:none}
.tl .hit{fill:transparent}
.tl .foot{font-size:11px;fill:var(--muted)}
`;
}

export function themeVars(c) {
  return `--paper:${c.paper};--ink:${c.ink};--ink2:${c.ink2};--muted:${c.muted};--rule:${c.rule};--rule2:${c.rule2};--spine-a:${c.spineA};--spine-b:${c.spineB};${[...HUES, 'gray'].map((h) => `--${h}:${c[h]}`).join(';')}`;
}

export function staticStyle(g, theme) {
  return `
.tl{${themeVars(THEMES[theme])};--font-body:${FONT_BODY};--font-display:${FONT_DISPLAY}}
${svgRules(g)}`;
}
