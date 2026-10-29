// 年表のデータ整形・レイアウト・SVG描画。
// build.mjs（静的SVGの生成）と index.html（ブラウザでの描画）の両方がこのファイルを使う。

const DAY = 86400000;
const YEAR = 365.2425 * DAY;

export const CHART_START = '1868-01-01';
export const CABINET_START = '1885-12-22';

// ---------------------------------------------------------------- 日付

export function toTime(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function ymd(t) {
  const d = new Date(t);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

export function fmtDate(t) {
  const { y, m, d } = ymd(t);
  return `${y}年${m}月${d}日`;
}

export function fmtDot(t) {
  const { y, m, d } = ymd(t);
  return `${y}.${m}.${d}`;
}

export function fmtNum(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// 西暦の日付を和暦（元号＋年）に。明治改元（1868年10月23日）より前の1868年は明治元年として扱う。
export function wareki(t, eras) {
  let era = eras[0];
  for (const e of eras) if (e.start <= t) era = e;
  const year = ymd(t).y - ymd(era.start).y + 1;
  return { era: era.name, year, text: `${era.name}${year === 1 ? '元' : year}年` };
}

// ---------------------------------------------------------------- CSV

export function parseCSV(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const head = lines[0].split(',').map((s) => s.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    head.forEach((h, i) => { row[h] = (cells[i] ?? '').trim(); });
    return row;
  });
}

// ---------------------------------------------------------------- モデル

// 同じ人物が続けて務めた代（例：吉田茂の第48〜51代）は1本の在任期間にまとめる。
// 在任日数は、総理は首相官邸の数え方（就任日と退任日を両方含む）、大統領は就任日から退任日までの日数。
export function buildModel({ pmRows, usRows, eraRows, asOf }) {
  const asOfT = toTime(asOf);
  const eras = eraRows.map((r) => ({
    name: r['元号'],
    start: toTime(r['開始日']),
    end: r['終了日'] ? toTime(r['終了日']) : null,
  }));

  const merge = (rows, side, countDays) => {
    const terms = [];
    for (const r of rows) {
      const name = r['氏名'];
      const dai = Number(r['代']);
      const start = toTime(r['就任日']);
      const ongoing = !r['退任日'];
      const end = ongoing ? asOfT : toTime(r['退任日']);
      const prev = terms[terms.length - 1];
      if (prev && prev.name === name && prev.end === start) {
        prev.end = end;
        prev.ongoing = ongoing;
        prev.daiTo = dai;
      } else {
        terms.push({
          side, name, short: r['表示名'] || name,
          daiFrom: dai, daiTo: dai, start, end, ongoing,
        });
      }
    }
    terms.forEach((t, i) => {
      t.id = `${side}${i}`;
      t.person = `${side}:${t.name}`;
      t.days = countDays(t.start, t.end);
    });
    return terms;
  };

  const jp = merge(pmRows, 'jp', (s, e) => Math.round((e - s) / DAY) + 1);
  const us = merge(usRows, 'us', (s, e) => Math.round((e - s) / DAY));

  const persons = new Map();
  for (const t of [...jp, ...us]) {
    if (!persons.has(t.person)) persons.set(t.person, { terms: [], days: 0 });
    const p = persons.get(t.person);
    p.terms.push(t);
    p.days += t.days;
  }
  for (const t of jp) t.counter = us.filter((u) => u.start < t.end && u.end > t.start).map((u) => u.id);
  for (const u of us) u.counter = jp.filter((t) => t.start < u.end && t.end > u.start).map((t) => t.id);

  const byId = new Map([...jp, ...us].map((t) => [t.id, t]));
  const start = toTime(CHART_START);
  const pre = { id: 'jp-pre', side: 'jp', kind: 'pre', start, end: toTime(CABINET_START) };

  return {
    jp, us, pre, eras, persons, byId,
    start,
    end: asOfT + 450 * DAY,
    asOf: asOfT,
    pmRows, usRows,
  };
}

export function daiText(t) {
  return t.daiFrom === t.daiTo ? `第${t.daiFrom}代` : `第${t.daiFrom}〜${t.daiTo}代`;
}

export function yearsText(t) {
  const a = ymd(t.start).y;
  if (t.ongoing) return `${a}–`;
  const b = ymd(t.end).y;
  return a === b ? `${a}` : `${a}–${b}`;
}

// その時点の在任者。見つからなければ null（臨時兼任・代理の期間など）。
export function termAt(terms, t) {
  for (const x of terms) {
    if (x.start <= t && (t < x.end || (x.ongoing && t <= x.end))) return x;
  }
  return null;
}

// ---------------------------------------------------------------- レイアウト

// 全角はほぼ1em、数字とラテン文字は約0.6emとして幅を見積もる（ラベル幅の判定用）。
export function textWidth(s, size) {
  let w = 0;
  for (const ch of s) {
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

export function layout(model, opts = {}) {
  const width = Math.round(opts.width ?? 760);
  const narrow = width < 600;
  const g = { width, narrow };
  g.ppy = opts.ppy ?? (narrow ? 22 : 24);
  g.headerH = narrow ? 58 : 70;
  g.footerH = opts.footer ? 70 : 24;
  g.top = g.headerH;
  g.t0 = model.start;
  g.t1 = model.end;
  g.yOf = (t) => g.top + ((t - g.t0) / YEAR) * g.ppy;
  g.tOf = (y) => g.t0 + ((y - g.top) / g.ppy) * YEAR;
  g.plotBottom = g.yOf(g.t1);
  g.height = Math.ceil(g.plotBottom + g.footerH);

  g.spineW = narrow ? 66 : 92;
  g.barW = narrow ? 10 : 14;
  const barGap = narrow ? 5 : 7;
  g.labelGap = narrow ? 11 : 15;
  const cx = width / 2;
  g.spineX0 = cx - g.spineW / 2;
  g.spineX1 = cx + g.spineW / 2;
  g.jpBarX1 = g.spineX0 - barGap;
  g.jpBarX0 = g.jpBarX1 - g.barW;
  g.usBarX0 = g.spineX1 + barGap;
  g.usBarX1 = g.usBarX0 + g.barW;
  g.jpLabelX = g.jpBarX0 - g.labelGap;
  g.usLabelX = g.usBarX1 + g.labelGap;
  g.labelRoom = g.jpLabelX - 4;

  g.nameSize = narrow ? 12.5 : 13.5;
  g.yearSize = narrow ? 10.5 : 11;
  g.labelH = narrow ? 15.5 : 17;

  const widest = (terms) => Math.max(...terms.map((t) => textWidth(t.short, g.nameSize) + 6 + textWidth(yearsText(t), g.yearSize)));
  g.showYears = Math.max(widest(model.jp), widest(model.us)) <= g.labelRoom;

  const bars = (terms) => terms.map((t) => {
    const clipped = t.start < g.t0;
    const y0 = Math.max(g.top, g.yOf(t.start));
    const y1 = g.yOf(t.end);
    const anchor = y0 + Math.min((y1 - y0) / 2, g.labelH / 2);
    return { term: t, y0, y1, h: y1 - y0, target: anchor, anchor, clipped };
  });

  g.jp = bars(model.jp);
  g.us = bars(model.us);
  g.pre = { y0: g.yOf(model.pre.start), y1: g.yOf(model.pre.end), target: g.top + g.labelH / 2, anchor: g.top + g.labelH / 2 };

  const lo = g.top;
  const hi = g.plotBottom;
  const jpItems = [g.pre, ...g.jp].map((b) => ({ ref: b, target: b.target, h: g.labelH }));
  const usItems = g.us.map((b) => ({ ref: b, target: b.target, h: g.labelH }));
  dodge(jpItems, lo, hi);
  dodge(usItems, lo, hi);
  for (const it of [...jpItems, ...usItems]) it.ref.labelY = it.center;

  // 元号の区切りと十年ごとの目盛り
  g.eraMarks = model.eras
    .map((e, i) => ({ era: e, i, y: g.yOf(e.start) }))
    .filter((m) => m.y >= g.top && m.y <= g.plotBottom);
  g.eraBands = model.eras.map((e, i) => {
    const next = model.eras[i + 1];
    return {
      era: e, i,
      y0: i === 0 ? g.top : g.yOf(e.start),
      y1: next ? g.yOf(next.start) : g.plotBottom,
    };
  });
  g.asOfY = g.yOf(model.asOf);

  const startYear = ymd(g.t0).y;
  const endYear = ymd(g.t1).y;
  g.years = [];
  for (let y = startYear; y <= endYear; y += 1) {
    const yy = g.yOf(Date.UTC(y, 0, 1));
    if (yy >= g.top && yy <= g.plotBottom) g.years.push({ year: y, y: yy });
  }
  const blocked = [
    ...g.eraMarks.map((m) => [m.y - 4, m.y + 44]),
    [g.asOfY - 4, g.asOfY + 34],
  ];
  g.decades = g.years
    .filter((d) => d.year % 10 === 0)
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

export function termSummary(t, model) {
  const role = t.side === 'jp' ? '内閣総理大臣' : 'アメリカ合衆国大統領';
  const end = t.ongoing ? `在任中（${fmtDate(model.asOf)}時点）` : fmtDate(t.end);
  return `${daiText(t)}${role} ${t.name}　${fmtDate(t.start)}〜${end}（${fmtNum(t.days)}日）`;
}

export function renderSVG(model, g, opts = {}) {
  const { interactive = false, style = '', background = false, footer = null, titleTag = null } = opts;
  const W = g.width;
  const H = g.height;
  const o = [];
  const a11y = interactive
    ? `role="group" aria-label="歴代総理大臣と歴代米大統領の年表"`
    : `role="img" aria-labelledby="tl-title"`;
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" class="tl" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" ${a11y}>`);
  if (!interactive) o.push(`<title id="tl-title">${esc(titleTag || '歴代総理大臣・歴代米大統領')}</title>`);
  if (style) o.push(`<style>${style}</style>`);

  o.push('<defs>');
  o.push('<pattern id="tl-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" class="hatch-bg"/><line x1="0" y1="0" x2="0" y2="6" class="hatch-line"/></pattern>');
  o.push('</defs>');

  if (background) o.push(`<rect class="bg" x="0" y="0" width="${W}" height="${H}" rx="14"/>`);

  // 見出し（左右の列名と、中央の「西暦／和暦」）
  const hy = g.headerH - 26;
  const jpHead = g.narrow ? '日本の総理大臣' : '日本の内閣総理大臣';
  const usHead = g.narrow ? '米国の大統領' : 'アメリカ合衆国大統領';
  o.push(`<rect class="bar jp" x="${r1(g.jpBarX0)}" y="${hy - 11}" width="${g.barW}" height="14" rx="3"/>`);
  o.push(`<text class="lane-h" x="${r1(g.jpLabelX)}" y="${hy}" text-anchor="end">${jpHead}</text>`);
  o.push(`<rect class="bar us" x="${r1(g.usBarX0)}" y="${hy - 11}" width="${g.barW}" height="14" rx="3"/>`);
  o.push(`<text class="lane-h" x="${r1(g.usLabelX)}" y="${hy}">${usHead}</text>`);
  o.push(`<text class="spine-h" x="${W / 2}" y="${hy - 3}" text-anchor="middle">西暦</text>`);
  o.push(`<text class="spine-h2" x="${W / 2}" y="${hy + 10}" text-anchor="middle">和暦</text>`);

  // 中央の帯（元号ごとに色を交互に）
  for (const b of g.eraBands) {
    const y0 = Math.max(g.top, b.y0);
    const y1 = Math.min(g.plotBottom, b.y1);
    if (y1 <= y0) continue;
    o.push(`<rect class="${b.i % 2 ? 'spine-b' : 'spine-a'}" x="${r1(g.spineX0)}" y="${r1(y0)}" width="${g.spineW}" height="${r1(y1 - y0)}"/>`);
  }

  // 十年ごとの横線（全幅）。元号の区切りのすぐ近くでは二重線に見えるので引かない。
  for (const d of g.decades) {
    if (d.hidden) continue;
    o.push(`<line class="grid" x1="0" x2="${W}" y1="${r1(d.y)}" y2="${r1(d.y)}"/>`);
  }
  // 元号の区切り線（全幅）
  for (const m of g.eraMarks) {
    o.push(`<line class="era-line" x1="0" x2="${W}" y1="${r1(m.y)}" y2="${r1(m.y)}"/>`);
  }

  // 年の目盛り（帯の両端）
  for (const d of g.years) {
    const len = d.year % 10 === 0 ? 9 : d.year % 5 === 0 ? 6 : 3;
    const y = r1(d.y);
    o.push(`<path class="tick" d="M${r1(g.spineX0)} ${y}h${len}M${r1(g.spineX1)} ${y}h-${len}"/>`);
  }
  // 十年ごとの年号（西暦＋和暦）
  for (const d of g.decades) {
    if (d.hidden) continue;
    const w = wareki(Date.UTC(d.year, 0, 1), model.eras);
    o.push(`<text class="dec-y" x="${W / 2}" y="${r1(d.y + 4.5)}" text-anchor="middle">${d.year}</text>`);
    o.push(`<text class="dec-w" x="${W / 2}" y="${r1(d.y + 18)}" text-anchor="middle">${w.text}</text>`);
  }
  // 元号の見出し
  for (const m of g.eraMarks) {
    o.push(`<text class="era-name" x="${W / 2}" y="${r1(m.y + 23)}" text-anchor="middle">${esc(m.era.name)}</text>`);
    o.push(`<text class="era-date" x="${W / 2}" y="${r1(m.y + 37)}" text-anchor="middle">${fmtDot(m.era.start)}</text>`);
  }
  // データの時点
  o.push(`<line class="asof-line" x1="${r1(g.jpBarX0 - 4)}" x2="${r1(g.usBarX1 + 4)}" y1="${r1(g.asOfY)}" y2="${r1(g.asOfY)}"/>`);
  o.push(`<text class="era-date" x="${W / 2}" y="${r1(g.asOfY + 14)}" text-anchor="middle">${fmtDot(model.asOf)}</text>`);
  o.push(`<text class="era-date" x="${W / 2}" y="${r1(g.asOfY + 27)}" text-anchor="middle">時点</text>`);

  // 内閣制度発足前
  {
    const p = g.pre;
    const h = r1(p.y1 - p.y0 - 1);
    o.push(`<g class="term pre" data-id="jp-pre"${interactive ? ' tabindex="0" aria-label="内閣制度発足前（太政官制）。1885年12月22日に内閣制度が発足"' : ''}>`);
    if (!interactive) o.push('<title>1885年12月22日に内閣制度が発足し、伊藤博文が初代内閣総理大臣に就任するまでは太政官制</title>');
    o.push(`<rect class="hit" x="${r1(g.jpBarX0 - 120)}" y="${r1(p.y0)}" width="${r1(g.jpBarX1 - g.jpBarX0 + 120)}" height="${h}"/>`);
    o.push(`<rect class="bar-pre" x="${r1(g.jpBarX0)}" y="${r1(p.y0)}" width="${g.barW}" height="${h}" rx="3"/>`);
    o.push(`<text class="label" x="${r1(g.jpLabelX)}" y="${r1(p.labelY + g.nameSize * 0.36)}" text-anchor="end"><tspan class="name pre-name">内閣制度発足前</tspan></text>`);
    o.push('</g>');
  }

  // 読み取り用の横線（棒とラベルの下に敷く）
  if (interactive) {
    o.push(`<g class="xhair" transform="translate(0 ${g.top})" aria-hidden="true"><line class="xhair-line" x1="0" x2="${W}" y1="0" y2="0"/></g>`);
  }

  // ホバー用の当たり判定（描画はしない）。棒とラベルより下に置き、ラベルの上では隣の期間に負けないようにする。
  if (interactive) {
    o.push('<g class="hits">');
    const reach = g.showYears ? 160 : 104;
    for (const [list, side] of [[g.jp, 'jp'], [g.us, 'us']]) {
      for (const b of list) {
        const x0 = side === 'jp' ? g.jpLabelX - reach : g.usBarX0;
        const x1 = side === 'jp' ? g.jpBarX1 : g.usLabelX + reach;
        const y0 = Math.min(b.y0, b.labelY - g.labelH / 2);
        const y1 = Math.max(b.y1, b.labelY + g.labelH / 2);
        o.push(`<rect class="hit" data-id="${b.term.id}" x="${r1(x0)}" y="${r1(y0)}" width="${r1(x1 - x0)}" height="${r1(y1 - y0)}"/>`);
      }
    }
    o.push('</g>');
  }

  // 在任期間
  const drawSide = (list, side) => {
    for (const b of list) {
      const t = b.term;
      const gapTop = 1;
      const gapBottom = t.ongoing ? 0 : 1;
      let y0 = b.y0 + gapTop;
      let h = b.y1 - b.y0 - gapTop - gapBottom;
      if (h < 3) { y0 = b.y0 + (b.y1 - b.y0) / 2 - 1.5; h = 3; }
      const x = side === 'jp' ? g.jpBarX0 : g.usBarX0;
      const rx = Math.min(3, h / 2);
      const attrs = interactive
        ? ` tabindex="0" aria-label="${esc(termSummary(t, model))}"`
        : '';
      o.push(`<g class="term ${side}" data-id="${t.id}" data-person="${esc(t.person)}"${attrs}>`);
      if (!interactive) o.push(`<title>${esc(termSummary(t, model))}</title>`);
      if (t.ongoing || b.clipped) {
        // 在任中は下端を、年表の始まり（1868年）より前から在任していた人は上端を薄くして、棒が続いていることを示す
        const yTop = b.clipped ? b.y0 : y0;
        const yBot = t.ongoing ? b.y1 : b.y1 - gapBottom;
        const gid = `tl-g-${t.id}`;
        const [g1, g2, o1, o2] = t.ongoing ? [yBot - 22, yBot, 1, 0] : [yTop, yTop + 22, 0, 1];
        o.push(`<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="0" y1="${r1(g1)}" x2="0" y2="${r1(g2)}"><stop offset="0" class="stop-${side}" stop-opacity="${o1}"/><stop offset="1" class="stop-${side}" stop-opacity="${o2}"/></linearGradient>`);
        o.push(`<path class="bar-open ${side}" d="${barPath(x, yTop, g.barW, yBot - yTop, !b.clipped, !t.ongoing)}" fill="url(#${gid})"/>`);
      } else {
        o.push(`<rect class="bar ${side}" x="${r1(x)}" y="${r1(y0)}" width="${g.barW}" height="${r1(h)}" rx="${r1(rx)}"/>`);
      }
      // 引き出し線（ラベルが本来の位置からずれたときだけ）
      const dy = b.labelY - b.anchor;
      if (Math.abs(dy) > 1.5) {
        if (side === 'jp') {
          const xb = g.jpBarX0 - 1.5;
          o.push(`<path class="leader" d="M${r1(xb)} ${r1(b.anchor)}h-4L${r1(g.jpLabelX + 4)} ${r1(b.labelY)}h-2"/>`);
        } else {
          const xb = g.usBarX1 + 1.5;
          o.push(`<path class="leader" d="M${r1(xb)} ${r1(b.anchor)}h4L${r1(g.usLabelX - 4)} ${r1(b.labelY)}h2"/>`);
        }
      }
      const ty = r1(b.labelY + g.nameSize * 0.36);
      const yrs = esc(yearsText(t));
      const nm = esc(t.short);
      if (side === 'jp') {
        const inner = g.showYears
          ? `<tspan class="yrs">${yrs}</tspan><tspan class="name" dx="6">${nm}</tspan>`
          : `<tspan class="name">${nm}</tspan>`;
        o.push(`<text class="label" x="${r1(g.jpLabelX)}" y="${ty}" text-anchor="end">${inner}</text>`);
      } else {
        const inner = g.showYears
          ? `<tspan class="name">${nm}</tspan><tspan class="yrs" dx="6">${yrs}</tspan>`
          : `<tspan class="name">${nm}</tspan>`;
        o.push(`<text class="label" x="${r1(g.usLabelX)}" y="${ty}">${inner}</text>`);
      }
      o.push('</g>');
    }
  };
  drawSide(g.jp, 'jp');
  drawSide(g.us, 'us');

  // 横線が棒と交わる点（棒の上に重ねる）
  if (interactive) {
    o.push(`<g class="xhair xhair-dots" transform="translate(0 ${g.top})" aria-hidden="true">`);
    o.push(`<circle class="xhair-dot jp" cx="${r1(g.jpBarX0 + g.barW / 2)}" cy="0" r="${g.narrow ? 4 : 5}"/>`);
    o.push(`<circle class="xhair-dot us" cx="${r1(g.usBarX0 + g.barW / 2)}" cy="0" r="${g.narrow ? 4 : 5}"/>`);
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

export const THEMES = {
  light: {
    paper: '#fcfcfd', ink: '#1c2029', ink2: '#4b5260', muted: '#687080',
    rule: '#e8eaef', rule2: '#c3c8d2', spineA: '#f0f1f5', spineB: '#e6e8ef',
    jp: '#d4452c', us: '#2c5aa0', hatch: '#e3e5eb',
  },
  dark: {
    paper: '#14171f', ink: '#e6e8ee', ink2: '#b2b8c4', muted: '#8d94a3',
    rule: '#232833', rule2: '#3d4452', spineA: '#1b1f29', spineB: '#222733',
    jp: '#e5604a', us: '#678bd2', hatch: '#2a303c',
  },
};

export const FONT_BODY = '"BIZ UDPGothic", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", YuGothic, Meiryo, "Noto Sans JP", "Noto Sans CJK JP", sans-serif';
export const FONT_DISPLAY = '"Shippori Mincho B1", "Hiragino Mincho ProN", "Yu Mincho", YuMincho, "BIZ UDPMincho", "Noto Serif JP", "Noto Serif CJK JP", serif';

// 色以外の見た目。ページ側では var(--…) をページのトークンに対応させる。
export function svgRules(g) {
  return `
.tl .bg{fill:var(--paper)}
.tl .spine-a{fill:var(--spine-a)}
.tl .spine-b{fill:var(--spine-b)}
.tl .grid{stroke:var(--rule);stroke-width:1}
.tl .era-line{stroke:var(--rule2);stroke-width:1}
.tl .asof-line{stroke:var(--muted);stroke-width:1}
.tl .tick{stroke:var(--rule2);stroke-width:1;fill:none}
.tl text{font-family:var(--font-body)}
.tl .dec-y{font-size:${g.narrow ? 12 : 13}px;font-weight:700;fill:var(--ink);font-variant-numeric:tabular-nums}
.tl .dec-w{font-size:${g.narrow ? 9.5 : 10.5}px;fill:var(--muted)}
.tl .era-name{font-family:var(--font-display);font-size:${g.narrow ? 17 : 19}px;font-weight:800;fill:var(--ink)}
.tl .era-date{font-size:${g.narrow ? 9.5 : 10}px;fill:var(--muted);font-variant-numeric:tabular-nums}
.tl .spine-h{font-size:10.5px;font-weight:700;fill:var(--ink2)}
.tl .spine-h2{font-size:10.5px;fill:var(--muted)}
.tl .lane-h{font-size:${g.narrow ? 13 : 14.5}px;font-weight:700;fill:var(--ink)}
.tl .bar.jp{fill:var(--jp)}
.tl .bar.us{fill:var(--us)}
.tl .stop-jp{stop-color:var(--jp)}
.tl .stop-us{stop-color:var(--us)}
.tl .bar-pre{fill:url(#tl-hatch)}
.tl .hatch-bg{fill:var(--spine-a)}
.tl .hatch-line{stroke:var(--rule2);stroke-width:1.5}
.tl .label{font-size:${g.nameSize}px}
.tl .name{fill:var(--ink)}
.tl .pre-name{fill:var(--muted)}
.tl .yrs{font-size:${g.yearSize}px;fill:var(--muted);font-variant-numeric:tabular-nums}
.tl .leader{stroke:var(--rule2);stroke-width:1;fill:none}
.tl .hit{fill:transparent}
.tl .foot{font-size:11px;fill:var(--muted)}
`;
}

export function staticStyle(g, theme) {
  const c = THEMES[theme];
  return `
.tl{--paper:${c.paper};--ink:${c.ink};--ink2:${c.ink2};--muted:${c.muted};--rule:${c.rule};--rule2:${c.rule2};--spine-a:${c.spineA};--spine-b:${c.spineB};--jp:${c.jp};--us:${c.us};--font-body:${FONT_BODY};--font-display:${FONT_DISPLAY}}
${svgRules(g)}`;
}
