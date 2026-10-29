#!/usr/bin/env node
// data/*.csv から年表を作り直す。
//   node build.mjs                    … 今日（日本時間）を「時点」として生成
//   node build.mjs --as-of=2026-10-30 … 時点の日付を指定して生成
// 出力: timeline-light.svg / timeline-dark.svg（README用）, index.html（ブラウザで開く版）, README.md の一覧表
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as TL from './src/timeline.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFile(join(root, p), 'utf8');
const write = (p, s) => writeFile(join(root, p), s);

const arg = process.argv.find((a) => a.startsWith('--as-of='));
const asOf = arg ? arg.slice('--as-of='.length) : new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());

const pmRows = TL.parseCSV(await read('data/prime-ministers.csv'));
const usRows = TL.parseCSV(await read('data/us-presidents.csv'));
const eraRows = TL.parseCSV(await read('data/eras.csv'));

// ---- データの点検（日付の書式、順序、在任中は最後の1行だけ）
const problems = [];
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(TL.toTime(s));
for (const [file, rows] of [['prime-ministers.csv', pmRows], ['us-presidents.csv', usRows]]) {
  rows.forEach((r, i) => {
    const where = `${file} ${i + 2}行目（${r['氏名']}）`;
    if (!isDate(r['就任日'])) problems.push(`${where}: 就任日の書式が YYYY-MM-DD ではありません`);
    if (r['退任日'] && !isDate(r['退任日'])) problems.push(`${where}: 退任日の書式が YYYY-MM-DD ではありません`);
    if (!r['退任日'] && i !== rows.length - 1) problems.push(`${where}: 退任日が空なのは最後の行（在任中）だけにしてください`);
    if (r['退任日'] && r['退任日'] < r['就任日']) problems.push(`${where}: 退任日が就任日より前です`);
    const prev = rows[i - 1];
    if (prev) {
      if (Number(r['代']) !== Number(prev['代']) + 1) problems.push(`${where}: 代が前の行から連番になっていません`);
      if (prev['退任日'] && r['就任日'] < prev['退任日']) problems.push(`${where}: 前の行の退任日より前に就任しています`);
    }
  });
}
const lastStart = [pmRows, usRows].map((rows) => rows[rows.length - 1]['就任日']).sort().pop();
if (asOf < lastStart) problems.push(`時点（${asOf}）が最後の就任日（${lastStart}）より前です`);
if (problems.length) {
  console.error(`データに問題があります:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

const model = TL.buildModel({ pmRows, usRows, eraRows, asOf });

// ---- README 用の SVG（ライト／ダーク）
const g = TL.layout(model, { width: 760, footer: true });
const footer = [
  `出典：首相官邸「歴代内閣」ほか　${TL.fmtDate(model.asOf)}時点`,
  '総理の棒の切れ目は臨時兼任・臨時代理の期間。同じ人が続けて務めた代は1本にまとめています。',
];
for (const theme of ['light', 'dark']) {
  const svg = TL.renderSVG(model, g, { style: TL.staticStyle(g, theme), background: true, footer });
  await write(`timeline-${theme}.svg`, `${svg}\n`);
}

// ---- ブラウザ版（1ファイルで完結する HTML）
const template = await read('src/page.html');
const lib = await read('src/timeline.mjs');
const data = JSON.stringify({ pm: pmRows, us: usRows, eras: eraRows, asOf });
const page = template
  .replace('/*@@TIMELINE@@*/', () => lib)
  .replace('/*@@DATA@@*/null', () => data);
const [head, body] = page.split('<!--@@BODY@@-->');
const SITE_URL = 'https://ihideck.github.io/chronology/';
const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='6' y='3' width='8' height='26' rx='2' fill='%23d4452c'/%3E%3Crect x='18' y='9' width='8' height='20' rx='2' fill='%232c5aa0'/%3E%3C/svg%3E";
await write('index.html', [
  '<!doctype html>',
  '<html lang="ja">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  `<link rel="icon" href="${ICON}">`,
  '<meta property="og:type" content="website">',
  '<meta property="og:locale" content="ja_JP">',
  '<meta property="og:title" content="歴代総理大臣・歴代米大統領">',
  '<meta property="og:description" content="1868年から今日まで、日本の内閣総理大臣とアメリカ合衆国大統領の在任期間をひとつの時間軸に並べた年表">',
  `<meta property="og:url" content="${SITE_URL}">`,
  '<style>body{margin:0}[hidden]{display:none!important}</style>',
  head.trim(),
  '</head>',
  '<body>',
  body.trim(),
  '</body>',
  '</html>',
  '',
].join('\n'));
// --page=パス を付けると、<head> などを含まない本文だけの版も書き出す（埋め込み用）
const pageOut = process.argv.find((a) => a.startsWith('--page='));
if (pageOut) await writeFile(pageOut.slice('--page='.length), page.replace('<!--@@BODY@@-->\n', ''));

// ---- README の一覧表（マーカーの間だけ書き換える）
const BEGIN = '<!-- 一覧ここから（build.mjs が書き換えます） -->';
const END = '<!-- 一覧ここまで -->';
const days = (s, e, inclusive) => Math.round((TL.toTime(e) - TL.toTime(s)) / 86400000) + (inclusive ? 1 : 0);
const table = (rows, inclusive) => {
  const lines = ['| 代 | 氏名 | 就任日 | 退任日 | 在任日数 |', '|---:|---|---|---|---:|'];
  for (const r of rows) {
    const end = r['退任日'] || asOf;
    lines.push(`| ${r['代']} | ${r['氏名']} | ${r['就任日']} | ${r['退任日'] || '在任中'} | ${TL.fmtNum(days(r['就任日'], end, inclusive))} |`);
  }
  return lines.join('\n');
};
const list = [
  BEGIN,
  '<details>',
  `<summary>日本の内閣総理大臣（第${pmRows[0]['代']}〜${pmRows[pmRows.length - 1]['代']}代）</summary>`,
  '',
  table(pmRows, true),
  '',
  '</details>',
  '',
  '<details>',
  `<summary>アメリカ合衆国大統領（第${usRows[0]['代']}〜${usRows[usRows.length - 1]['代']}代）</summary>`,
  '',
  table(usRows, false),
  '',
  '</details>',
  END,
].join('\n');
const readme = await read('README.md');
const a = readme.indexOf(BEGIN);
const b = readme.indexOf(END);
if (a >= 0 && b > a) {
  await write('README.md', readme.slice(0, a) + list + readme.slice(b + END.length));
} else {
  console.warn('README.md に一覧のマーカーが見つからないため、一覧表は更新しませんでした');
}

console.log(`生成しました（${TL.fmtDate(model.asOf)}時点）: timeline-light.svg, timeline-dark.svg, index.html, README.md`);
