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
    campaigns: set.extra.campaigns,
    leaders: set.extra.leaders,
    asOf,
    files: {
      results: `${set.dir}/${set.conf.data.file}`, parties: `${set.dir}/${set.conf.data.parties}`, governments: `${set.dir}/${set.conf.data.governments}`,
      campaigns: `${set.dir}/${set.conf.data.campaigns}`, leaders: `${set.dir}/${set.conf.photos.file}`,
    },
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

// 党首の写真：ファイルがあること、画像のページとライセンスが URL であること。
// 写真を載せる人は、作者とライセンスを表示しなければならないので、出典と画像のページ（パブリックドメインでなければライセンスも）が要る
export function leaderPhotoProblems(model, root, dir) {
  const F = model.files;
  const P = [];
  for (const l of model.leaderRows) {
    const where = `${F.leaders} ${l.line}行目（${l.name}）`;
    if (l.photo && !existsSync(join(root, dir, l.photo))) P.push(`${where}: 写真 ${l.photo} がありません`);
    for (const [col, v] of [['写真のページ', l.pageUrl], ['写真のライセンス', l.licenseUrl]]) {
      if (v && !(col === '写真のページ' && v === 'なし' && !l.photo) && !/^https?:\/\//i.test(v)) P.push(`${where}: ${col}「${v}」が http:// か https:// で始まっていません`);
    }
    if (!l.photo) continue;
    if (!l.credit) P.push(`${where}: 写真があるのに、写真の出典（作者とライセンス）が空です`);
    if (!l.pageUrl) P.push(`${where}: 写真があるのに、写真のページが空です`);
    if (!l.licenseUrl && !l.credit.includes('パブリックドメイン')) P.push(`${where}: 写真のライセンスの URL が空です（空にできるのはパブリックドメインだけです）`);
  }
  return P;
}

// 写真の出典（Commons から取った党首だけ。総理大臣の年表の写真は、総理大臣の年表の出典に載る）
const leaderCredits = (model) => model.leaderRows.filter((l) => l.photo && l.credit);

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
function campaignBlocks(model, key, h) {
  const elections = model.houses[key].filter((e) => e.covered).reverse();
  const blocks = elections.map((e) => {
    const c = SM.campaignOf(model, key, e);
    if (!c) return '';
    const party = c.oppParty ? model.parties.get(c.oppParty)?.name ?? c.oppParty : '';
    const line = (label, text) => (text ? `- ${label}：${cell(h.mdText(text))}` : '');
    return [
      `#### ${e.name}（${e.dateStr}）`,
      '',
      line('通称', SM.aliasOf(c)),
      ...SM.saysOf(c).map((x) => line(x.label, x.text)),
      line('争点', c.issues.join('、')),
      line('野党第一党', party && (c.leaders.length ? `${party}（${[c.leaders.join('・'), c.role].filter(Boolean).join(' ')}）` : party)),
      `- 出典：${c.sources.map((u, i) => `[${i + 1}](${h.mdUrl(u)})`).join(' ')}`,
    ].filter((x, i) => i < 2 || x).join('\n');
  }).filter(Boolean);
  return ['<details>', `<summary>${key === 'lower' ? '衆議院' : '参議院'}の選挙の説明（${blocks.length}回）</summary>`, '', blocks.join('\n\n'), '', '</details>'].join('\n');
}

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
    // メモは画面に出さないので送らない
    campaigns: set.extra.campaigns.map(({ メモ, ...r }) => r), leaders: set.extra.leaders,
    pms: sets[PM_DIR]?.rows ?? [], pmBase: `../${PM_DIR}/`,
    related: conf.related ?? [],
  });
  const panelRe = /<!--@@PANEL-->([\s\S]*?)<!--@@\/PANEL-->/;
  const panel = panelRe.exec(templates.page)[1];
  const panels = ['lower', 'upper'].map((k) => panel.replaceAll('@@HOUSE@@', k).replace('@@FAN@@', () => SM.renderHouseSVG(state[k], { mode: 'party' }))).join('\n');
  const first = new Date(model.first + 12 * 3600000).getUTCFullYear();
  const creditP = (c) => `<p>${h.esc(c.title)}：${h.esc(c.text)}${c.license ? `（${h.link({ title: c.license, url: c.licenseUrl })}）` : ''}</p>`;
  const ownCredits = leaderCredits(model);
  // 写真の加工（切り抜き・縮小）の表示はライセンスが求めるので、ページにも README にも出す
  const creditList = [...(photoCredit ? [photoCredit] : []), ...(conf.credits ?? [])];
  const credits = [
    ...creditList.map(creditP),
    ...(ownCredits.length ? [`<ul>${ownCredits.map((l) => `<li>${h.esc(l.name)}：${h.esc(l.credit)}${[['画像のページ', l.pageUrl], ['ライセンス', l.licenseUrl]].filter(([, u]) => h.isWebUrl(u)).map(([title, url]) => `（${h.link({ title, url })}）`).join('')}</li>`).join('')}</ul>`] : []),
  ].join('\n    ');
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
    '## 選挙の説明',
    '',
    campaignBlocks(model, 'lower', h),
    '',
    campaignBlocks(model, 'upper', h),
    '',
    '## 注記',
    '',
    ...(conf.notes ?? []).map((n) => `- ${n}`),
    '',
    '## 出典',
    '',
    ...(conf.sources ?? []).map((x) => `- ${h.isWebUrl(x.url) ? `[${x.title}](${x.url})` : x.title}`),
    ...(creditList.length ? ['', ...creditList.map((c) => `- ${c.title}：${c.text}${c.license ? `（${h.isWebUrl(c.licenseUrl) ? `[${c.license}](${c.licenseUrl})` : c.license}）` : ''}`)] : []),
    ...(ownCredits.length ? ['', '### 写真の出典', '', ...ownCredits.map((l) => {
      const links = [['画像のページ', l.pageUrl], ['ライセンス', l.licenseUrl]].filter(([, u]) => h.isWebUrl(u)).map(([text, u]) => `[${text}](${h.mdUrl(u)})`);
      return `- ${h.mdText(l.name)}：${h.mdText(l.credit)}${links.length ? `（${links.join('・')}）` : ''}`;
    })] : []),
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
      `**動く版：[ihideck.github.io/chronology/${dir}](${h.SITE_URL}${dir}/)**　データ：[${conf.data.file}](${conf.data.file})・[${conf.data.parties}](${conf.data.parties})・[${conf.data.governments}](${conf.data.governments})・[${conf.data.campaigns}](${conf.data.campaigns})・[${conf.photos.file}](${conf.photos.file})（[決まり](../README.md#しくみ)）`,
      '',
      generated,
      '',
    ].join('\n'));
  }
}
