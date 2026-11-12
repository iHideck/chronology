#!/usr/bin/env node
// 各ディレクトリの chronology.json と CSV から、年表を作り直す。
//   node build.mjs                    … 今日（日本時間）を「時点」として生成
//   node build.mjs --as-of=2026-10-30 … 時点の日付を指定して生成
//   node build.mjs --check            … データの検査だけをして、何も書かずに終わる
// 出力: 各ディレクトリの index.html（ブラウザで開く版）・timeline-light.svg / timeline-dark.svg（README用）・README.md、
//       トップの index.html（年表の一覧）と README.md の一覧
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as TL from './src/timeline.mjs';
import * as SM from './src/seats.mjs';
import * as SB from './src/seats-build.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFile(join(root, p), 'utf8');
const write = (p, s) => writeFile(join(root, p), s);

const arg = process.argv.find((a) => a.startsWith('--as-of='));
const asOf = arg ? arg.slice('--as-of='.length) : new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
const SITE_URL = 'https://ihideck.github.io/chronology/';
const REPO_URL = 'https://github.com/iHideck/chronology';

// ---- 読み込み（chronology.json のあるディレクトリが1つの年表）
const sets = {};
for (const d of await readdir(root, { withFileTypes: true })) {
  if (!d.isDirectory() || d.name.startsWith('.') || !existsSync(join(root, d.name, 'chronology.json'))) continue;
  const conf = JSON.parse(await read(`${d.name}/chronology.json`));
  const rows = TL.parseCSV(await read(`${d.name}/${conf.data.file}`));
  // 議席のページは年表と別の形（results.csv に parties.csv と governments.csv が付く）
  if (conf.kind === 'seats') {
    if (!conf.data.parties || !conf.data.governments) throw new Error(`${d.name}/chronology.json: 議席のページの data には parties と governments のファイル名が要ります`);
    const extra = { parties: TL.parseCSV(await read(`${d.name}/${conf.data.parties}`)), governments: TL.parseCSV(await read(`${d.name}/${conf.data.governments}`)) };
    sets[d.name] = { dir: d.name, conf, rows, extra };
    continue;
  }
  const photoCredit = conf.credits?.find((c) => c.photos)?.short;
  sets[d.name] = { dir: d.name, conf, rows, spec: { ...conf.data, title: conf.title, photoCredit } };
}

// ---- データの点検（日付の書式、順序、列の名前、写真のファイル）
const problems = [];
const seatsSets = Object.values(sets).filter((s) => s.conf.kind === 'seats');
const timelineSets = Object.values(sets).filter((s) => s.conf.kind !== 'seats');
const ONGOING = new Set(['継続中', '在任中', '現在']);
const isDate = (s) => TL.parseDate(s) != null;
// リンクにしてよいのは http(s) の URL だけ（javascript: などをページに書き出さない）
const isWebUrl = (u) => /^https?:\/\//i.test(u ?? '');
// 写真の出典は Commons から取った文と URL なので、README の Markdown のリンクや書式にならないようにする
const mdUrl = (u) => u.replace(/[\s()<>\\]/g, (c) => ({ '(': '%28', ')': '%29' })[c] ?? encodeURIComponent(c));
const mdText = (s) => String(s ?? '').replace(/[\\[\]<>*_`~]/g, '\\$&');
for (const s of timelineSets) {
  const { spec, rows, dir } = s;
  const C = { ...TL.DEFAULT_COLUMNS, ...spec.columns };
  const file = `${dir}/${spec.file}`;
  const head = Object.keys(rows[0] ?? {});
  for (const [role, col] of Object.entries(C)) {
    if (role === 'end' && spec.points && !head.includes(col)) continue;
    // 観測値のデータは、名前（日付から作る）と終了日（次の行の日）の列を持たない
    if (spec.series && (role === 'name' || role === 'end') && !head.includes(col)) continue;
    if (!head.includes(col)) problems.push(`${file}: 列「${col}」（${role}）がありません`);
  }
  if (spec.series && !s.conf.page) problems.push(`${dir}/chronology.json: 観測値のデータ（series）には、折れ線の目盛りなどを書いた page が要ります`);
  const within = spec.check?.consecutiveWithin;
  const lastNumber = new Map();
  const lastInGroup = new Map();
  rows.forEach((r, i) => {
    const where = `${file} ${i + 2}行目（${spec.series ? r[C.start] : r[C.name]}）`;
    const st = r[C.start];
    const en = r[C.end] ?? '';
    if (!isDate(st)) problems.push(`${where}: 開始日「${st}」の書式が YYYY-MM-DD・YYYY-MM・YYYY のどれでもありません`);
    if (en && !ONGOING.has(en) && !isDate(en)) problems.push(`${where}: 終了日「${en}」の書式が違います（続いているものは空か「継続中」）`);
    if (isDate(st) && isDate(en) && TL.toTime(en, true) < TL.toTime(st)) problems.push(`${where}: 終了日が開始日より前です`);
    const prev = rows[i - 1];
    if (prev && isDate(st) && isDate(prev[C.start]) && TL.toTime(st) < TL.toTime(prev[C.start])) problems.push(`${where}: 開始日の順に並んでいません`);
    if (spec.series && isDate(st)) {
      const key = C.group ? r[C.group] : '';
      if (lastInGroup.has(key) && TL.toTime(st) <= lastInGroup.get(key)) problems.push(`${where}: 同じ${key ? `区分（${key}）` : 'データ'}の前の行と同じ日付です`);
      lastInGroup.set(key, TL.toTime(st));
    }
    if (spec.check?.sequential) {
      if (!en && i !== rows.length - 1) problems.push(`${where}: 終了日が空なのは最後の行（続いているもの）だけにしてください`);
      if (prev && isDate(prev[C.end]) && isDate(st) && TL.toTime(st) < TL.toTime(prev[C.end])) problems.push(`${where}: 前の行の終了日より前に始まっています`);
    }
    if (spec.check?.consecutive && prev && Number(r[C.ordinal]) !== Number(prev[C.ordinal]) + 1) problems.push(`${where}: ${C.ordinal}が前の行から連番になっていません`);
    if (within) {
      const n = Number(r[within.number]);
      const before = lastNumber.get(r[within.group]);
      if (!Number.isInteger(n)) problems.push(`${where}: ${within.number}「${r[within.number]}」が整数ではありません`);
      else if (before != null && n !== before + 1) problems.push(`${where}: ${r[within.group]}の${within.number}が前の行（${before}）から連番になっていません`);
      lastNumber.set(r[within.group], n);
    }
    for (const [col, [lo, hi]] of Object.entries(spec.check?.range ?? {})) {
      const v = r[col] ?? '';
      if (v !== '' && !(Number(v) >= lo && Number(v) <= hi)) problems.push(`${where}: ${col}「${v}」が${lo}〜${hi}の数ではありません`);
    }
    for (const [col, limit] of Object.entries(spec.check?.atMost ?? {})) {
      const v = r[col] ?? '';
      const lim = r[limit] ?? '';
      if (v !== '' && lim !== '' && !(Number(v) <= Number(lim))) problems.push(`${where}: ${col}「${v}」が${limit}「${lim}」を超えています`);
    }
    const bd = spec.check?.breakdown;
    if (bd && (r[bd.column] ?? '') !== '') {
      const parts = TL.parseBreakdown(r[bd.column]);
      const sum = parts.reduce((s, p) => s + p.seats, 0);
      if (!parts.length) problems.push(`${where}: ${bd.column}「${r[bd.column]}」を「名前 数・名前 数」の形で読めません`);
      else if (String(sum) !== (r[bd.sum] ?? '')) problems.push(`${where}: ${bd.column}の合計（${sum}）が${bd.sum}「${r[bd.sum] ?? ''}」と合いません`);
    }
    if (C.photo && r[C.photo] && !existsSync(join(root, dir, r[C.photo]))) problems.push(`${where}: 写真 ${r[C.photo]} がありません`);
    for (const col of [C.url, C.photoUrl, C.photoLicense]) {
      if (col === C.photoUrl && r[col] === 'なし' && !r[C.photo]) continue;
      if (col && r[col] && !isWebUrl(r[col])) problems.push(`${where}: ${col}「${r[col]}」が http:// か https:// で始まっていません`);
    }
    if (spec.groups && C.group && r[C.group] && !(r[C.group] in spec.groups)) problems.push(`${where}: 区分「${r[C.group]}」が chronology.json の groups にありません`);
    if (spec.lanes && C.lane && r[C.lane] && !(r[C.lane] in spec.lanes)) problems.push(`${where}: ${C.lane}「${r[C.lane]}」が chronology.json の lanes にありません`);
    if (!en && !spec.points && isDate(st) && st > asOf) problems.push(`${where}: 時点（${asOf}）より後に始まっています`);
  });
}
if (seatsSets.length) problems.push(...SB.checkTemplates({ page: await read('src/seats.html'), timeline: await read('src/timeline.mjs'), seats: await read('src/seats.mjs') }));
for (const s of seatsSets) {
  s.model = SB.seatsModelOf(s, sets, asOf);
  problems.push(...SM.validateSeats(s.model));
  for (const u of [...(s.conf.sources ?? []), ...(s.conf.related ?? [])]) {
    if (u.url && !isWebUrl(u.url) && !u.url.startsWith('../')) problems.push(`${s.dir}/chronology.json: URL「${u.url}」が http:// か https:// で始まっていません`);
  }
}
if (problems.length) {
  console.error(`データに問題があります:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
if (process.argv.includes('--check')) {
  console.log('データの検査を通りました');
  process.exit(0);
}

// ---- ページの設定。page がなければ、そのデータだけを1列に並べる
function pageOf(s) {
  if (s.conf.page) return s.conf.page;
  return {
    title: s.conf.title,
    lede: s.conf.description,
    spine: { position: 'left', bands: { data: 'eras', lane: 0 }, wareki: { data: 'eras', lane: 0 }, headline: '和暦' },
    jump: [],
    columns: [{ id: 'a', data: s.dir, side: 'right', title: s.conf.title, short: s.conf.short, color: s.conf.color ?? 'blue', colorBy: s.conf.colorBy, photos: !!s.conf.data.columns?.photo, fixed: true }],
  };
}

// ページで使うデータを集め、写真などのパスをページのディレクトリから見た相対パスにする
function datasetsFor(dir, page) {
  const colIds = new Set(page.columns.map((c) => c.data));
  const ids = new Set(colIds);
  for (const src of [page.spine?.bands, page.spine?.wareki]) if (src) ids.add(src.data);
  const out = {};
  for (const id of ids) {
    if (!sets[id]) continue;
    const rel = relative(dir, id);
    let rows = sets[id].rows;
    // 帯（元号・時代）にだけ使うデータは、名前と日付などの列だけにして、ページに埋め込む量を減らす
    if (!colIds.has(id)) {
      const C = { ...TL.DEFAULT_COLUMNS, ...sets[id].spec.columns };
      const keep = [C.name, C.short, C.start, C.end, C.lane, C.group].filter(Boolean);
      rows = rows.map((r) => Object.fromEntries(keep.map((k) => [k, r[k] ?? ''])));
    }
    out[id] = { spec: sets[id].spec, rows, base: rel ? `${rel}/` : '' };
  }
  return out;
}

// データがまだないものは、ページの列や帯から外す
function usable(page, datasets) {
  const missing = [];
  const keep = (src) => {
    if (!src || datasets[src.data]) return src;
    missing.push(src.data);
    return undefined;
  };
  const p = {
    ...page,
    columns: page.columns.filter((c) => keep(c)),
    spine: page.spine ? { ...page.spine, bands: keep(page.spine.bands), wareki: keep(page.spine.wareki) } : undefined,
  };
  for (const c of p.columns) if (c.counter) c.counter = c.counter.filter((id) => p.columns.some((x) => x.id === id));
  return { page: p, missing: [...new Set(missing)] };
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const link = (x) => (isWebUrl(x.url) ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>` : esc(x.title));
// <script> の中に埋め込む JSON。データに「</script>」などが入っても、スクリプトの外に出られないよう < を \u003c にする
const scriptJSON = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='6' y='3' width='8' height='26' rx='2' fill='%23d4452c'/%3E%3Crect x='18' y='9' width='8' height='20' rx='2' fill='%232c5aa0'/%3E%3C/svg%3E";

function htmlDoc({ title, description, url, head, body }) {
  return [
    '<!doctype html>',
    '<html lang="ja">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    `<link rel="icon" href="${ICON}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:locale" content="ja_JP">',
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${url}">`,
    '<style>body{margin:0}[hidden]{display:none!important}</style>',
    head.trim(),
    '</head>',
    '<body>',
    body.trim(),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// 観測値のデータの一覧表（Markdown）。CSV の行をそのまま並べ、数の列は右に寄せる
function rowsMarkdownTable(s) {
  const skip = new Set(s.spec.hidden ?? []);
  const heads = Object.keys(s.rows[0] ?? {}).filter((h) => !skip.has(h));
  const isNum = (v) => /^-?\d+(\.\d+)?$/.test(v);
  const date = { ...TL.DEFAULT_COLUMNS, ...s.spec.columns }.start;
  const numeric = new Set(heads.filter((h) => h !== date && s.rows.some((r) => isNum(r[h])) && s.rows.every((r) => r[h] === '' || isNum(r[h]))));
  const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [
    `| ${heads.join(' | ')} |`,
    `|${heads.map((h) => (numeric.has(h) ? '---:' : '---')).join('|')}|`,
    ...s.rows.map((r) => `| ${heads.map((h) => cell(numeric.has(h) ? TL.fmtNum(r[h]) : r[h])).join(' | ')} |`),
  ].join('\n');
}

// README の一覧表（Markdown）
function markdownTable(model, c) {
  const extra = [];
  for (const t of c.terms) for (const [k] of t.details) if (!extra.includes(k)) extra.push(k);
  const hasOrd = c.terms.some((t) => t.ordFrom != null);
  const durable = c.terms.some((t) => !t.point);
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const heads = [
    ...(hasOrd ? ['代'] : []),
    c.spec.nameLabel ?? '名前',
    durable ? c.spec.startLabel ?? '開始' : '日付',
    ...(durable ? [c.spec.endLabel ?? '終了', c.spec.durationLabel ?? '期間'] : []),
    ...(c.colorBy === 'group' ? ['区分'] : []),
    ...extra,
  ];
  const lines = [`| ${heads.join(' | ')} |`, `|${heads.map((h) => (h === '代' ? '---:' : '---')).join('|')}|`];
  for (const t of c.terms) {
    const m = new Map(t.details);
    const ord = t.ordFrom == null ? '' : t.ordFrom === t.ordTo ? t.ordFrom : `${t.ordFrom}〜${t.ordTo}`;
    lines.push(`| ${[
      ...(hasOrd ? [ord] : []),
      t.name,
      `${TL.fmtStr(t.startStr)}${t.approx ? '頃' : ''}`,
      ...(durable ? [t.point ? '' : t.ongoing ? TL.ongoingText(t, c.spec) : TL.fmtStr(t.endStr), TL.durationText(t, c.spec, model.asOf).replace(/^\S+ /, '')] : []),
      ...(c.colorBy === 'group' ? [t.group] : []),
      ...extra.map((k) => m.get(k) ?? ''),
    ].map(cell).join(' | ')} |`);
  }
  return lines.join('\n');
}

const template = await read('src/page.html');
const lib = await read('src/timeline.mjs');
const pages = [];

for (const s of timelineSets) {
  const dir = s.dir;
  const { page, missing } = usable(pageOf(s), datasetsFor(dir, pageOf(s)));
  if (missing.length) console.warn(`${dir}: データ ${missing.join('、')} がまだないので、その列を外して作ります`);
  const datasets = datasetsFor(dir, page);
  const model = TL.buildModel({ page, datasets, asOf });
  const used = Object.keys(datasets).filter((id) => page.columns.some((c) => c.data === id));
  // 注記と出典は、このディレクトリのデータの分だけ載せ、ほかの列はそれぞれの年表へのリンクにする
  const own = used.includes(dir) ? [dir] : used;
  const others = used.filter((id) => !own.includes(id)).map((id) => ({ title: sets[id].conf.page?.title ?? sets[id].conf.title, url: `../${id}/` }));
  const sources = [...new Map(own.flatMap((id) => sets[id].conf.sources ?? []).map((x) => [x.url ?? x.title, x])).values()];
  // 同じ文の出典（各国の肖像など）は1つにまとめ、どの列の分かを括弧に書く
  const merged = new Map();
  for (const id of used) {
    for (const c of sets[id].conf.credits ?? []) {
      const key = JSON.stringify([c.title, c.text, c.license, c.licenseUrl]);
      if (!merged.has(key)) merged.set(key, { credit: c, from: [] });
      merged.get(key).from.push(page.columns.find((col) => col.data === id)?.short ?? sets[id].conf.short);
    }
  }
  const credits = [...merged.values()].map(({ credit, from }) => (from.length > 1 ? { ...credit, title: `${credit.title}（${from.join('、')}）` } : credit));
  const notes = [...new Set([...(page.notes ?? []), ...own.flatMap((id) => sets[id].conf.notes ?? [])])];

  // ---- README 用の SVG（ライト／ダーク）。写真は小さい版を埋め込む（画像として表示される SVG は外部の画像を読めないため）
  const pv = page.preview ?? {};
  const g = TL.layout(model, { width: pv.width ?? 760, footer: true, hidden: new Set(pv.hidden ?? []) });
  const photoData = {};
  for (const c of model.columns) {
    for (const t of c.terms) {
      if (!t.photo || photoData[t.photo]) continue;
      const small = join(root, dir, TL.smallPhoto(t.photo));
      if (!existsSync(small)) throw new Error(`写真の小さい版（48px）がありません: ${relative(root, small)}`);
      photoData[t.photo] = `data:image/jpeg;base64,${(await readFile(small)).toString('base64')}`;
    }
  }
  const footer = [
    `出典：${sources.map((x) => x.title).join('、')}　${TL.fmtDate(model.asOf)}時点`,
    ...(pv.footnote ? [pv.footnote] : []),
  ];
  for (const theme of ['light', 'dark']) {
    const svg = TL.renderSVG(model, g, { style: TL.staticStyle(g, theme), background: true, footer, photoData });
    await write(`${dir}/timeline-${theme}.svg`, `${svg}\n`);
  }

  // ---- ブラウザ版（1ファイルで完結する HTML。写真だけは同じディレクトリなどのファイルを読む）
  const fill = (str) => str
    .replaceAll('@@TITLE@@', esc(page.title))
    .replaceAll('@@DESCRIPTION@@', esc(page.description ?? s.conf.description))
    .replaceAll('@@LEDE@@', esc(page.lede ?? s.conf.description))
    .replaceAll('@@HOW@@', esc(page.how ?? '棒や名前にカーソルを合わせる（スマホではタップする）と、くわしい情報が表示されます。上の欄には、横線の位置の項目が出ます。'))
    .replaceAll('@@MAXWIDTH@@', String(page.maxWidth ?? 820))
    .replaceAll('@@HOME@@', '../')
    .replaceAll('@@DIR@@', esc(dir))
    .replace('@@NOTES@@', () => [
      ...notes.map((n) => `<li>${esc(n)}</li>`),
      ...(others.length ? [`<li>ほかの列の定義・注記・出典は、それぞれの年表に載せています：${others.map((x) => `<a href="${x.url}">${esc(x.title)}</a>`).join('、')}</li>`] : []),
    ].join('\n      '))
    .replace('@@SOURCES@@', () => sources.map(link).join('、'))
    .replace('@@CREDITS@@', () => credits.map((c) => `<p>${esc(c.title)}：${esc(c.text)}${c.license ? `（${link({ title: c.license, url: c.licenseUrl })}）` : ''}</p>`).join('\n    '));
  const data = scriptJSON({ page, datasets, asOf, dir });
  const html = fill(template)
    .replace('/*@@TIMELINE@@*/', () => lib)
    .replace('/*@@DATA@@*/null', () => data);
  const [head, body] = html.split('<!--@@BODY@@-->');
  await write(`${dir}/index.html`, htmlDoc({ title: page.title, description: page.description ?? s.conf.description, url: `${SITE_URL}${dir}/`, head, body }));
  // --page=パス を付けると、総理大臣の年表の <head> などを含まない本文だけの版も書き出す（埋め込み用。写真も埋め込む）
  const pageOut = process.argv.find((a) => a.startsWith('--page='));
  if (pageOut && dir === 'prime-ministers') {
    const inlined = {};
    for (const [id, d] of Object.entries(datasets)) {
      const col = d.spec.columns?.photo;
      const rows = [];
      for (const r of d.rows) {
        const file = col && r[col] ? join(root, id, r[col]) : null;
        rows.push(file && existsSync(file) ? { ...r, [col]: `data:image/jpeg;base64,${(await readFile(file)).toString('base64')}` } : r);
      }
      inlined[id] = { ...d, rows, base: '' };
    }
    const embed = fill(template)
      .replace('/*@@TIMELINE@@*/', () => lib)
      .replace('/*@@DATA@@*/null', () => scriptJSON({ page, datasets: inlined, asOf, dir }))
      .replaceAll('href="../"', `href="${SITE_URL}"`);
    await writeFile(pageOut.slice('--page='.length), embed.replace('<!--@@BODY@@-->\n', ''));
  }

  // ---- README（マーカーの間だけ書き換える。なければ作る）
  const BEGIN = '<!-- ここから下は build.mjs が書き換えます -->';
  const END = '<!-- ここまで -->';
  // 画像ごとの作者とライセンス（写真の列に出典の列があるデータだけ）
  const photoCredits = (() => {
    const C = { ...TL.DEFAULT_COLUMNS, ...sets[dir].spec.columns };
    if (!C.photo || !C.photoCredit) return [];
    const seen = new Set();
    return sets[dir].rows
      .filter((r) => r[C.photo] && !seen.has(r[C.photo]) && seen.add(r[C.photo]))
      .map((r) => {
        const links = [['画像のページ', r[C.photoUrl]], ['ライセンス', r[C.photoLicense]]].filter(([, u]) => isWebUrl(u)).map(([text, u]) => `[${text}](${mdUrl(u)})`);
        return `- ${r[C.name]}：${mdText(r[C.photoCredit])}${links.length ? `（${links.join('・')}）` : ''}`;
      });
  })();
  const ownColumns = model.columns.filter((c) => c.data === dir && !c.chart);
  const tables = ownColumns
    .map((c) => ['<details>', `<summary>${ownColumns.length > 1 ? `${c.title}の` : ''}一覧（${c.terms.length}件）</summary>`, '', markdownTable(model, c), '', '</details>'].join('\n'));
  if (s.spec.series) tables.push(['<details>', `<summary>一覧（${s.rows.length}件）</summary>`, '', rowsMarkdownTable(s), '', '</details>'].join('\n'));
  const generated = [
    BEGIN,
    `<a href="${SITE_URL}${dir}/">`,
    '<picture>',
    '  <source media="(prefers-color-scheme: dark)" srcset="timeline-dark.svg">',
    `  <img src="timeline-light.svg" width="${Math.min(760, pv.width ?? 760)}" alt="${esc(`${page.title}の年表`)}">`,
    '</picture>',
    '</a>',
    '',
    '## 一覧',
    '',
    ...tables,
    '',
    ...(notes.length || others.length ? ['## 注記', '', ...notes.map((n) => `- ${n}`), ...(others.length ? [`- ほかの列の定義・注記・出典は、それぞれの年表に載せています：${others.map((x) => `[${x.title}](${x.url})`).join('、')}`] : []), ''] : []),
    '## 出典',
    '',
    ...(sets[dir].conf.sources ?? []).map((x) => `- ${isWebUrl(x.url) ? `[${x.title}](${x.url})` : x.title}`),
    ...(credits.length ? ['', ...credits.map((c) => `- ${c.title}：${c.text}${c.license ? `（${isWebUrl(c.licenseUrl) ? `[${c.license}](${c.licenseUrl})` : c.license}）` : ''}`)] : []),
    ...(photoCredits.length ? ['', '### 写真の出典', '', ...photoCredits] : []),
    END,
  ].join('\n');
  const readmePath = join(root, dir, 'README.md');
  if (existsSync(readmePath)) {
    const readme = await readFile(readmePath, 'utf8');
    const a = readme.indexOf(BEGIN);
    const b = readme.indexOf(END);
    if (a >= 0 && b > a) await write(`${dir}/README.md`, readme.slice(0, a) + generated + readme.slice(b + END.length));
    else console.warn(`${dir}/README.md に書き換えのマーカーがないため、更新しませんでした`);
  } else {
    await write(`${dir}/README.md`, [
      `# ${page.title}`,
      '',
      page.lede ?? s.conf.description,
      '',
      `**動く版：[ihideck.github.io/chronology/${dir}](${SITE_URL}${dir}/)**　データ：[${s.conf.data.file}](${s.conf.data.file})（[書き方](../README.md#年表の足し方)）`,
      '',
      generated,
      '',
    ].join('\n'));
  }

  const ownTerms = model.columns.filter((c) => c.data === dir).flatMap((c) => c.terms);
  const yearOf = (str) => TL.parseDate(str).y;
  // 観測値のデータの期間は、最初の行の年から最後の行の年まで（最後の値が時点まで続くことは「現在」としない）
  const startCol = { ...TL.DEFAULT_COLUMNS, ...s.spec.columns }.start;
  pages.push({
    dir, conf: s.conf, page, model,
    count: s.rows.length,
    span: s.spec.series
      ? [yearOf(s.rows[0][startCol]), yearOf(s.rows[s.rows.length - 1][startCol])]
      : ownTerms.length ? [Math.min(...ownTerms.map((t) => yearOf(t.startStr))), ownTerms.some((t) => t.ongoing) ? null : Math.max(...ownTerms.map((t) => yearOf(t.endStr || t.startStr)))] : null,
  });
}

// ---- 議席のページ
if (seatsSets.length) {
  const templates = { page: await read('src/seats.html'), timeline: lib, seats: await read('src/seats.mjs') };
  const helpers = { esc, link, isWebUrl, mdUrl, mdText, scriptJSON, htmlDoc, SITE_URL };
  for (const s of seatsSets) {
    await SB.writeSeatsPage({ root, set: s, sets, model: s.model, asOf, templates, h: helpers });
    pages.push(SB.seatsCard(s, s.model));
  }
}

// ---- トップページ（年表の一覧）とルートの README の一覧。分類ごとに、分類の中は order の順
const CATEGORY_ORDER = ['政治と首脳', '日本の歴史', '文化', 'テクノロジー'];
const catIndex = (p) => { const i = CATEGORY_ORDER.indexOf(p.conf.category); return i < 0 ? CATEGORY_ORDER.length : i; };
pages.sort((a, b) => catIndex(a) - catIndex(b) || (a.conf.order ?? 99) - (b.conf.order ?? 99) || a.dir.localeCompare(b.dir));
const spanText = (p) => (p.span ? `${TL.yearText(p.span[0])}年〜${p.span[1] == null ? '現在' : `${TL.yearText(p.span[1])}年`}` : '');
const categories = [...new Set(pages.map((p) => p.conf.category ?? 'その他'))];
const home = await read('src/home.html');
const cards = categories.map((cat) => [
  `<section><h2>${esc(cat)}</h2><ul class="cards">`,
  ...pages.filter((p) => (p.conf.category ?? 'その他') === cat).map((p) => {
    const colors = p.colors ?? p.page.columns.slice(0, 6).map((c) => (c.colorBy === 'group' ? sets[c.data]?.conf.color ?? 'gray' : c.color ?? 'gray'));
    return `<li><a href="${p.dir}/"><span class="bars" aria-hidden="true">${colors.map((c) => `<i style="background:${c.startsWith('#') ? c : `var(--${c})`}"></i>`).join('')}</span><b>${esc(p.page.title)}</b><span class="desc">${esc(p.conf.description)}</span><span class="meta">${esc(spanText(p))}・${p.count}件</span></a></li>`;
  }),
  '</ul></section>',
].join('\n')).join('\n');
const [homeHead, homeBody] = home
  .replace('@@CARDS@@', () => cards)
  .replace('@@ASOF@@', TL.fmtDate(TL.toTime(asOf)))
  .split('<!--@@BODY@@-->');
await write('index.html', htmlDoc({ title: 'chronology — 年表のあつまり', description: '歴代総理大臣、元号、偉人の生没年など、いろいろな年表をひとつの時間軸の見せ方で並べたサイト', url: SITE_URL, head: homeHead, body: homeBody }));

{
  const BEGIN = '<!-- 年表の一覧ここから（build.mjs が書き換えます） -->';
  const END = '<!-- 年表の一覧ここまで -->';
  const list = [
    BEGIN,
    '| 分類 | 年表 | 期間 | 件数 | ディレクトリ |',
    '|---|---|---|---:|---|',
    ...pages.map((p) => `| ${p.conf.category ?? 'その他'} | [${p.page.title}](${SITE_URL}${p.dir}/) | ${spanText(p)} | ${p.count} | [${p.dir}/](${p.dir}/) |`),
    END,
  ].join('\n');
  const readme = await read('README.md');
  const a = readme.indexOf(BEGIN);
  const b = readme.indexOf(END);
  if (a >= 0 && b > a) await write('README.md', readme.slice(0, a) + list + readme.slice(b + END.length));
  else console.warn('README.md に一覧のマーカーが見つからないため、一覧は更新しませんでした');
}

console.log(`生成しました（${TL.fmtDate(TL.toTime(asOf))}時点）: ${pages.map((p) => `${p.dir}/`).join(' ')} と index.html, README.md`);
