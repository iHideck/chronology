// 国会の議席のページ（kind: "seats"）の書き出し。build.mjs から呼ぶ。検査は seats.mjs の validateSeats。
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as SM from './seats.mjs';

const PM_DIR = 'prime-ministers';
const ELECTION_COLUMNS = ['院', '回', '名前', '略称', '投票日', '終了日', '終わり方', '投票率（%）', '定数', '改選定数', '内閣'];

export function seatsModelOf(set, sets, asOf) {
  return SM.buildSeatsModel({
    parties: set.extra.parties,
    results: set.rows,
    governments: set.extra.governments,
    elections: sets.elections?.rows ?? [],
    primeMinisters: sets[PM_DIR]?.rows ?? [],
    asOf,
    files: { results: `${set.dir}/${set.conf.data.file}`, parties: `${set.dir}/${set.conf.data.parties}`, governments: `${set.dir}/${set.conf.data.governments}` },
  });
}

// トップの一覧のカード用：最新の衆議院の上位の党の色、期間、件数
export function seatsCard(set, model) {
  const latest = SM.stateAt(model, model.asOf).lower;
  const colors = [...latest.groups].filter((g) => !['無所属', '諸派', '欠員'].includes(g.party)).sort((a, b) => b.count - a.count).slice(0, 4).map((g) => g.color);
  const elections = Object.values(model.houses).flat().filter((e) => e.covered);
  return {
    dir: set.dir, conf: set.conf, page: { title: set.conf.title }, model, colors,
    count: elections.length,
    span: [new Date(model.first + 12 * 3600000).getUTCFullYear(), null],
  };
}

const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

function houseTables(model, key, h) {
  const elections = model.houses[key].filter((e) => e.covered).reverse();
  const upper = key === 'upper';
  const blocks = elections.map((e) => {
    const hasBefore = !upper && e.seats.every((s) => s.before != null);
    const head = upper ? ['党', '当選', '非改選', '計'] : ['党', '当選', ...(hasBefore ? ['選挙前'] : [])];
    const rows = e.seats.map((s) => {
      const name = model.parties.get(s.party)?.name ?? s.party;
      return upper ? [name, s.won, s.holdover ?? 0, (s.won ?? 0) + (s.holdover ?? 0)] : [name, s.won, ...(hasBefore ? [s.before] : [])];
    });
    const sources = [...new Set(e.seats.flatMap((s) => s.source.split(' ; ').map((u) => u.trim()).filter(Boolean)))];
    const memos = e.seats.filter((s) => s.memo).map((s) => `- ${cell(h.mdText(model.parties.get(s.party)?.name ?? s.party))}：${cell(h.mdText(s.memo))}`);
    return [
      `#### ${e.name}（${e.dateStr}・定数${e.total}）`,
      '',
      `| ${head.join(' | ')} |`,
      `|${head.map((x, i) => (i ? '---:' : '---')).join('|')}|`,
      ...rows.map((r) => `| ${r.map((x) => cell(h.mdText(x))).join(' | ')} |`),
      '',
      `出典：${sources.map((u, i) => (h.isWebUrl(u) ? `[${i + 1}](${h.mdUrl(u)})` : cell(u))).join(' ')}`,
      ...(memos.length ? ['', ...memos] : []),
    ].join('\n');
  });
  return ['<details>', `<summary>${key === 'lower' ? '衆議院' : '参議院'}の党派別の議席（${elections.length}回）</summary>`, '', blocks.join('\n\n'), '', '</details>'].join('\n');
}

// ブラウザ版は timeline.mjs・seats.mjs・seats.html のスクリプトを1つのモジュールにつなぐので、トップレベルの名前が重なると読み込みで止まる
export function checkTemplates(templates) {
  const names = (src) => new Set([...src.matchAll(/^(?:export )?(?:const|let|function|class) +([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));
  const clash = [...names(templates.seats), ...names(templates.page)].filter((n) => names(templates.timeline).has(n) || (names(templates.seats).has(n) && names(templates.page).has(n)));
  return clash.length ? [`src/timeline.mjs・src/seats.mjs・src/seats.html のスクリプトで名前が重なっています（連結して埋め込むため）: ${[...new Set(clash)].join('、')}`] : [];
}

export async function writeSeatsPage({ root, set, sets, model, asOf, templates, h }) {
  const { dir, conf } = set;
  const write = (p, s) => writeFile(join(root, p), s);
  const state = SM.stateAt(model, model.asOf);
  const pmConf = sets[PM_DIR]?.conf;
  const photoCredit = pmConf?.credits?.find((c) => c.photos);

  // README 用の画像
  for (const theme of ['light', 'dark']) await write(`${dir}/seats-${theme}.svg`, `${SM.renderSeatsSVG(model, state, { theme })}\n`);

  // ブラウザ版。timeline.mjs と seats.mjs をつないで埋め込む（seats.mjs の import は連結で不要になる）。
  // 1つのモジュールの中に並ぶので、トップレベルの名前が重なると読み込みで止まる
  const clash = checkTemplates(templates);
  if (clash.length) throw new Error(clash.join('\n'));
  const lib = `${templates.timeline}\n${templates.seats.replace(/^import .* from '\.\/timeline\.mjs';\n/m, '')}`;
  const elections = (sets.elections?.rows ?? []).map((r) => Object.fromEntries(ELECTION_COLUMNS.map((c) => [c, r[c] ?? ''])));
  const data = h.scriptJSON({
    asOf, dir, files: model.files,
    parties: set.extra.parties, results: set.rows, governments: set.extra.governments, elections,
    pms: sets[PM_DIR]?.rows ?? [], pmBase: `../${PM_DIR}/`,
    related: conf.related ?? [],
  });
  const panelRe = /<!--@@PANEL-->([\s\S]*?)<!--@@\/PANEL-->/;
  const panel = panelRe.exec(templates.page)[1];
  const panels = ['lower', 'upper'].map((k) => panel.replaceAll('@@HOUSE@@', k).replace('@@FAN@@', () => SM.renderHouseSVG(state[k], { mode: 'party' }))).join('\n');
  const first = new Date(model.first + 12 * 3600000).getUTCFullYear();
  const credits = photoCredit
    ? `<p>${h.esc(photoCredit.title)}：${h.esc(photoCredit.text)}${photoCredit.license ? `（${h.link({ title: photoCredit.license, url: photoCredit.licenseUrl })}）` : ''}</p>`
    : '';
  const html = templates.page
    .replace(panelRe, () => panels)
    .replaceAll('@@TITLE@@', () => h.esc(conf.title))
    .replaceAll('@@DESCRIPTION@@', () => h.esc(conf.description))
    .replaceAll('@@HOME@@', '../')
    .replaceAll('@@DIR@@', () => h.esc(dir))
    .replaceAll('@@FIRST@@', String(first))
    .replace('@@NOTES@@', () => (conf.notes ?? []).map((n) => `<li>${h.esc(n)}</li>`).join('\n      '))
    .replace('@@SOURCES@@', () => (conf.sources ?? []).map(h.link).join('、'))
    .replace('@@CREDITS@@', () => credits)
    .replace('/*@@LIB@@*/', () => lib)
    .replace('/*@@DATA@@*/null', () => data);
  const [head, body] = html.split('<!--@@BODY@@-->');
  await write(`${dir}/index.html`, h.htmlDoc({ title: `${conf.title} ${first}〜現在`, description: conf.description, url: `${h.SITE_URL}${dir}/`, head, body }));

  // README（マーカーの間だけ書き換える。なければ作る）
  const BEGIN = '<!-- ここから下は build.mjs が書き換えます -->';
  const END = '<!-- ここまで -->';
  const generated = [
    BEGIN,
    `<a href="${h.SITE_URL}${dir}/">`,
    '<picture>',
    '  <source media="(prefers-color-scheme: dark)" srcset="seats-dark.svg">',
    `  <img src="seats-light.svg" width="760" alt="${h.esc(`${conf.title}（${SM.dotOf(model.asOf)}時点の衆議院と参議院）`)}">`,
    '</picture>',
    '</a>',
    '',
    '## 一覧',
    '',
    houseTables(model, 'lower', h),
    '',
    houseTables(model, 'upper', h),
    '',
    '## 注記',
    '',
    ...(conf.notes ?? []).map((n) => `- ${n}`),
    '',
    '## 出典',
    '',
    ...(conf.sources ?? []).map((x) => `- ${h.isWebUrl(x.url) ? `[${x.title}](${x.url})` : x.title}`),
    ...(photoCredit ? ['', `- ${photoCredit.title}：${photoCredit.text}${photoCredit.license ? `（${h.isWebUrl(photoCredit.licenseUrl) ? `[${photoCredit.license}](${photoCredit.licenseUrl})` : photoCredit.license}）` : ''}`] : []),
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
      `# ${conf.title}`,
      '',
      conf.description,
      '',
      `**動く版：[ihideck.github.io/chronology/${dir}](${h.SITE_URL}${dir}/)**　データ：[${conf.data.file}](${conf.data.file})・[${conf.data.parties}](${conf.data.parties})・[${conf.data.governments}](${conf.data.governments})（[決まり](../README.md#しくみ)）`,
      '',
      generated,
      '',
    ].join('\n'));
  }
}
