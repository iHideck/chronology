#!/usr/bin/env node
// 各ディレクトリの chronology.json と CSV から、年表を作り直す。
//   node build.mjs                    … 今日（日本時間）を「時点」として生成
//   node build.mjs --as-of=2026-10-30 … 時点の日付を指定して生成
// 出力: 各ディレクトリの index.html（ブラウザで開く版）・timeline-light.svg / timeline-dark.svg（README用）・README.md、
//       トップの index.html（年表の一覧）と README.md の一覧
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as TL from './src/timeline.mjs';

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
  const photoCredit = conf.credits?.find((c) => c.photos)?.short;
  sets[d.name] = { dir: d.name, conf, rows, spec: { ...conf.data, title: conf.title, photoCredit } };
}

// ---- データの点検（日付の書式、順序、列の名前、写真のファイル）
const problems = [];
const ONGOING = new Set(['継続中', '在任中', '現在']);
const isDate = (s) => TL.parseDate(s) != null;
// リンクにしてよいのは http(s) の URL だけ（javascript: などをページに書き出さない）
const isWebUrl = (u) => /^https?:\/\//i.test(u ?? '');
for (const s of Object.values(sets)) {
  const { spec, rows, dir } = s;
  const C = { ...TL.DEFAULT_COLUMNS, ...spec.columns };
  const file = `${dir}/${spec.file}`;
  const head = Object.keys(rows[0] ?? {});
  for (const [role, col] of Object.entries(C)) if (!head.includes(col)) problems.push(`${file}: 列「${col}」（${role}）がありません`);
  rows.forEach((r, i) => {
    const where = `${file} ${i + 2}行目（${r[C.name]}）`;
    const st = r[C.start];
    const en = r[C.end] ?? '';
    if (!isDate(st)) problems.push(`${where}: 開始日「${st}」の書式が YYYY-MM-DD・YYYY-MM・YYYY のどれでもありません`);
    if (en && !ONGOING.has(en) && !isDate(en)) problems.push(`${where}: 終了日「${en}」の書式が違います（続いているものは空か「継続中」）`);
    if (isDate(st) && isDate(en) && TL.toTime(en, true) < TL.toTime(st)) problems.push(`${where}: 終了日が開始日より前です`);
    const prev = rows[i - 1];
    if (prev && isDate(st) && isDate(prev[C.start]) && TL.toTime(st) < TL.toTime(prev[C.start])) problems.push(`${where}: 開始日の順に並んでいません`);
    if (spec.check?.sequential) {
      if (!en && i !== rows.length - 1) problems.push(`${where}: 終了日が空なのは最後の行（続いているもの）だけにしてください`);
      if (prev && isDate(prev[C.end]) && isDate(st) && TL.toTime(st) < TL.toTime(prev[C.end])) problems.push(`${where}: 前の行の終了日より前に始まっています`);
    }
    if (spec.check?.consecutive && prev && Number(r[C.ordinal]) !== Number(prev[C.ordinal]) + 1) problems.push(`${where}: ${C.ordinal}が前の行から連番になっていません`);
    if (C.photo && r[C.photo] && !existsSync(join(root, dir, r[C.photo]))) problems.push(`${where}: 写真 ${r[C.photo]} がありません`);
    if (C.url && r[C.url] && !isWebUrl(r[C.url])) problems.push(`${where}: リンク「${r[C.url]}」が http:// か https:// で始まっていません`);
    if (spec.groups && C.group && r[C.group] && !(r[C.group] in spec.groups)) problems.push(`${where}: 区分「${r[C.group]}」が chronology.json の groups にありません`);
    if (spec.lanes && C.lane && r[C.lane] && !(r[C.lane] in spec.lanes)) problems.push(`${where}: ${C.lane}「${r[C.lane]}」が chronology.json の lanes にありません`);
    if (!en && !spec.points && isDate(st) && st > asOf) problems.push(`${where}: 時点（${asOf}）より後に始まっています`);
  });
}
if (problems.length) {
  console.error(`データに問題があります:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

// ---- ページの設定。page がなければ、そのデータだけを1列に並べる
function pageOf(s) {
  if (s.conf.page) return s.conf.page;
  return {
    title: s.conf.title,
    lede: s.conf.description,
    spine: { position: 'left', bands: { data: 'eras', lane: 0 }, wareki: { data: 'eras', lane: 0 }, headline: '和暦' },
    jump: [],
    columns: [{ id: 'a', data: s.dir, side: 'right', title: s.conf.title, short: s.conf.short, color: s.conf.color ?? 'blue', colorBy: s.conf.colorBy, fixed: true }],
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
      ...(durable ? [t.point ? '' : t.ongoing ? c.spec.ongoing ?? '現在' : TL.fmtStr(t.endStr), TL.durationText(t, c.spec, model.asOf).replace(/^\S+ /, '')] : []),
      ...(c.colorBy === 'group' ? [t.group] : []),
      ...extra.map((k) => m.get(k) ?? ''),
    ].map(cell).join(' | ')} |`);
  }
  return lines.join('\n');
}

const template = await read('src/page.html');
const lib = await read('src/timeline.mjs');
const pages = [];

for (const s of Object.values(sets)) {
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
  const credits = used.flatMap((id) => sets[id].conf.credits ?? []);
  const notes = [...new Set([...(page.notes ?? []), ...own.flatMap((id) => sets[id].conf.notes ?? [])])];

  // ---- README 用の SVG（ライト／ダーク）。写真は小さい版を埋め込む（画像として表示される SVG は外部の画像を読めないため）
  const pv = page.preview ?? {};
  const g = TL.layout(model, { width: pv.width ?? 760, footer: true, hidden: new Set(pv.hidden ?? []) });
  const photoData = {};
  for (const c of model.columns) {
    for (const t of c.terms) {
      if (!t.photo || photoData[t.photo]) continue;
      const small = join(root, dir, t.photo.replace(/([^/]+)$/, 'small/$1'));
      if (existsSync(small)) photoData[t.photo] = `data:image/jpeg;base64,${(await readFile(small)).toString('base64')}`;
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
  const tables = model.columns
    .filter((c) => c.data === dir)
    .map((c) => ['<details>', `<summary>一覧（${c.terms.length}件）</summary>`, '', markdownTable(model, c), '', '</details>'].join('\n'));
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

  const main = model.columns.find((c) => c.data === dir) ?? model.columns[0];
  pages.push({
    dir, conf: s.conf, page, model,
    count: s.rows.length,
    span: main && main.terms.length ? [TL.parseDate(main.terms[0].startStr).y, main.terms.some((t) => t.ongoing) ? null : TL.parseDate(main.terms[main.terms.length - 1].endStr || main.terms[main.terms.length - 1].startStr).y] : null,
  });
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
    const colors = p.page.columns.slice(0, 6).map((c) => (c.colorBy === 'group' ? sets[c.data]?.conf.color ?? 'gray' : c.color ?? 'gray'));
    return `<li><a href="${p.dir}/"><span class="bars" aria-hidden="true">${colors.map((c) => `<i style="background:var(--${c})"></i>`).join('')}</span><b>${esc(p.page.title)}</b><span class="desc">${esc(p.conf.description)}</span><span class="meta">${esc(spanText(p))}・${p.count}件</span></a></li>`;
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
