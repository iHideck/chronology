// 国会の議席：データの組み立て・ある日の状態・扇の配置・SVG の描画。
// build.mjs（検査と README 用の SVG）と、diet-seats/index.html（ブラウザ）の両方がこのファイルを使う。
// ブラウザ版は timeline.mjs と連結して埋め込むので、下の import は build.mjs が取り除く。
import { toTime, ymd, DAY, parseDate } from './timeline.mjs';

export const HOUSES = {
  lower: { name: '衆議院', en: 'HOUSE OF REPRESENTATIVES', short: '衆' },
  upper: { name: '参議院', en: 'HOUSE OF COUNCILLORS', short: '参' },
};
const HOUSE_OF = { 衆議院: 'lower', 参議院: 'upper' };
const INDEPENDENT = ['無所属', '諸派'];
const VACANT = '欠員';
const NON_PARTY = [...INDEPENDENT, VACANT];
// 参議院は日本国憲法の施行（1947-05-03）で発足した
const UPPER_START = toTime('1947-05-03');

export const BLOC = { ruling: '#EF5A4C', outside: '#A878E0', opposition: '#4C8DF0', independent: '#6B7380' };
export const BLOC_NAME = { ruling: '与党', outside: '閣外協力', opposition: '野党', independent: '無所属・諸派・欠員' };

// ---------------------------------------------------------------- 日付と数

const pad = (n, w = 2) => String(n).padStart(w, '0');
export function isoOf(t) {
  const { y, m, d } = ymd(t);
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}
export const dotOf = (t) => isoOf(t).replaceAll('-', '.');
// 実在する YYYY-MM-DD だけを時刻にする（2月30日などは NaN）
export function dayOf(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s ?? '')) return NaN;
  const t = toTime(s);
  return Number.isFinite(t) && isoOf(t) === s ? t : NaN;
}
const intOf = (s) => (/^\d+$/.test(String(s ?? '').trim()) ? Number(s) : null);
export const CAMPAIGN_COLUMNS = ['院', '回', '通称', '通称の出どころ', '首相の説明', '野党の批判', '争点', '野党第一党', '党首', '党首の役職', '出典', 'メモ'];
const LEADER_COLUMNS = ['名前', 'Wikidata', '写真', '写真の出典', '写真のページ', '写真のライセンス'];
const splitOn = (s, sep) => String(s ?? '').split(sep).map((x) => x.trim()).filter(Boolean);
const urlsOf = (s) => String(s ?? '').split(' ; ').map((u) => u.trim()).filter(Boolean);
const isWebUrl = (u) => /^https?:\/\//i.test(u ?? '');

// 日付 t の n か月後（日が無い月は月末）
export function addMonths(t, n) {
  const { y, m, d } = ymd(t);
  const idx = y * 12 + (m - 1) + n;
  const yy = Math.floor(idx / 12);
  const mm = (idx % 12) + 1;
  let dd = d;
  while (Number.isNaN(dayOf(`${pad(yy, 4)}-${pad(mm)}-${pad(dd)}`)) && dd > 28) dd -= 1;
  return toTime(`${pad(yy, 4)}-${pad(mm)}-${pad(dd)}`);
}

// 「自由民主党・日本維新の会（2016年）」のような一覧。名前に「・」を含む党は、知っている名前を優先して読む
function splitParties(text, known) {
  const parts = String(text ?? '').split('・').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length;) {
    let take = 1;
    for (let j = parts.length; j > i; j -= 1) {
      if (known.has(parts.slice(i, j).join('・'))) { take = j - i; break; }
    }
    out.push(parts.slice(i, i + take).join('・'));
    i += take;
  }
  return out;
}

// ---------------------------------------------------------------- モデル

// CSV の行 → 型のそろったモデル。誤りがあっても止まらず、validateSeats が文にして返す
export function buildSeatsModel({ parties, results, governments, elections, primeMinisters = [], campaigns = [], leaders = [], asOf, files = {} }) {
  const F = { results: 'results.csv', parties: 'parties.csv', governments: 'governments.csv', campaigns: 'campaigns.csv', leaders: 'leaders.csv', ...files };
  const partyMap = new Map();
  const partyRows = parties.map((r, i) => {
    const p = {
      id: r['党'], name: r['名前'] || r['党'], short: r['略称'] || r['名前'] || r['党'],
      color: r['色'], colorSource: r['色の出典'], source: r['出典'], memo: r['メモ'],
      foundedStr: r['結党'] ?? '', dissolvedStr: r['解党'] ?? '', successor: r['後継'] ?? '',
      // 年・月までしか分からない結党はその期間の初め、解党はその期間の終わり（まで党があった）とする
      founded: r['結党'] ? (parseDate(r['結党']) ? toTime(r['結党']) : NaN) : null,
      dissolved: r['解党'] ? (parseDate(r['解党']) ? toTime(r['解党'], true) : NaN) : null,
      line: i + 2, order: i,
    };
    if (!partyMap.has(p.id)) partyMap.set(p.id, p);
    return p;
  });
  // 同じ名前の党が2つ以上ある（日本社会党の左派・右派、自由党など）ときは、注記に ID を書いて区別する
  const nameCount = new Map();
  for (const p of partyMap.values()) nameCount.set(p.name, (nameCount.get(p.name) ?? 0) + 1);
  for (const p of partyMap.values()) p.label = nameCount.get(p.name) > 1 ? p.id : p.name;

  const houses = { lower: [], upper: [] };
  for (const r of elections) {
    const key = HOUSE_OF[r['院']];
    if (!key) continue;
    houses[key].push({
      house: key, n: Number(r['回']), name: r['名前'], short: r['略称'],
      dateStr: r['投票日'], date: dayOf(r['投票日']),
      end: r['終了日'] ? dayOf(r['終了日']) : null, endStr: r['終了日'] ?? '',
      how: r['終わり方'] ?? '',
      turnout: r['投票率（%）'] === '' || r['投票率（%）'] == null ? null : Number(r['投票率（%）']),
      total: Number(r['定数']), regular: r['改選定数'] ? Number(r['改選定数']) : null,
      cabinet: r['内閣'] ?? '',
      seats: [], covered: false,
    });
  }
  for (const k of Object.keys(houses)) houses[k].sort((a, b) => a.date - b.date);
  const electionOf = new Map();
  for (const k of Object.keys(houses)) for (const e of houses[k]) electionOf.set(`${k}:${e.n}`, e);

  const orphans = [];
  const seatRows = results.map((r, i) => {
    const key = HOUSE_OF[r['院']] ?? null;
    const n = intOf(r['回']);
    const s = {
      houseName: r['院'], key, n, party: r['党'],
      wonRaw: r['当選'], holdoverRaw: r['非改選'], beforeRaw: r['選挙前'],
      won: intOf(r['当選']), holdover: intOf(r['非改選']), before: intOf(r['選挙前']),
      source: r['出典'] ?? '', memo: r['メモ'] ?? '', line: i + 2, order: i,
    };
    const e = key && n != null ? electionOf.get(`${key}:${n}`) : null;
    if (e) { e.seats.push(s); e.covered = true; } else orphans.push(s);
    return s;
  });

  const govs = governments.map((r, i) => {
    const known = new Set(partyMap.keys());
    return {
      startStr: r['開始日'], endStr: r['終了日'] ?? '',
      start: dayOf(r['開始日']), end: r['終了日'] ? dayOf(r['終了日']) : null,
      cabinet: r['内閣'], ruling: splitParties(r['与党'], known), outside: splitParties(r['閣外協力'], known),
      source: r['出典'] ?? '', memo: r['メモ'] ?? '', line: i + 2,
    };
  });

  const pms = primeMinisters.map((r) => ({
    name: r['氏名'], start: dayOf(r['就任日']), end: r['退任日'] ? dayOf(r['退任日']) : null, photo: r['写真'] ?? '',
  }));

  const campaignRows = campaigns.map((r, i) => ({
    houseName: r['院'], key: HOUSE_OF[r['院']] ?? null, n: intOf(r['回']),
    nickname: r['通称'] ?? '', nicknameBy: r['通称の出どころ'] ?? '', pmSays: r['首相の説明'] ?? '', oppSays: r['野党の批判'] ?? '',
    issues: splitOn(r['争点'], '／'), oppParty: r['野党第一党'] ?? '', leaders: splitOn(r['党首'], '・'), role: r['党首の役職'] ?? '',
    sourceRaw: r['出典'] ?? '', sources: urlsOf(r['出典']), memo: r['メモ'] ?? '', line: i + 2,
  }));
  const campaignMap = new Map(campaignRows.filter((c) => c.key && c.n != null).map((c) => [`${c.key}:${c.n}`, c]));
  const leaderRows = leaders.map((r, i) => ({
    name: r['名前'] ?? '', wikidata: r['Wikidata'] ?? '', photo: r['写真'] ?? '', credit: r['写真の出典'] ?? '',
    pageUrl: r['写真のページ'] ?? '', licenseUrl: r['写真のライセンス'] ?? '', line: i + 2,
  }));

  const covered = Object.values(houses).flat().filter((e) => e.covered);
  return {
    files: F,
    campaignHeader: campaigns.length ? Object.keys(campaigns[0]) : [], leaderHeader: Object.keys(leaders[0] ?? {}),
    campaignRows, campaigns: campaignMap, leaderRows, leaders: new Map(leaderRows.map((l) => [l.name, l])), electionOf, asOfStr: asOf, asOf: dayOf(asOf),
    parties: partyMap, partyRows, houses, seatRows, orphans, governments: govs, pms,
    first: covered.length ? Math.min(...covered.map((e) => e.date)) : NaN,
    firstOf: Object.fromEntries(Object.entries(houses).map(([k, l]) => [k, l.find((e) => e.covered)?.date ?? NaN])),
  };
}

// ---------------------------------------------------------------- 検査

export function validateSeats(model) {
  const P = [];
  const { files: F, parties, houses } = model;
  const at = (file, line, what) => `${file} ${line}行目（${what}）`;
  const checkUrls = (where, text) => {
    for (const u of urlsOf(text)) if (!isWebUrl(u)) P.push(`${where}: 出典「${u}」が http:// か https:// で始まっていません`);
  };

  // parties.csv
  const seen = new Set();
  for (const p of model.partyRows) {
    const where = at(F.parties, p.line, p.id);
    if (!p.id) { P.push(`${F.parties} ${p.line}行目: 党が空です`); continue; }
    if (seen.has(p.id)) P.push(`${where}: 党 ID が重複しています`);
    seen.add(p.id);
    if (!/^#[0-9A-Fa-f]{6}$/.test(p.color ?? '')) P.push(`${where}: 色「${p.color}」が #RRGGBB の形ではありません`);
    if (!NON_PARTY.includes(p.id) && !p.colorSource) P.push(`${where}: 色の出典が空です（URL か「系譜による」）`);
    if (p.colorSource && p.colorSource !== '系譜による' && !isWebUrl(p.colorSource)) P.push(`${where}: 色の出典「${p.colorSource}」が http(s) の URL でも「系譜による」でもありません`);
    checkUrls(where, p.source);
    if (p.foundedStr && Number.isNaN(p.founded)) P.push(`${where}: 結党「${p.foundedStr}」の書式が YYYY-MM-DD・YYYY-MM・YYYY のどれでもありません`);
    if (p.dissolvedStr && Number.isNaN(p.dissolved)) P.push(`${where}: 解党「${p.dissolvedStr}」の書式が YYYY-MM-DD・YYYY-MM・YYYY のどれでもありません`);
    if (p.founded != null && p.dissolved != null && p.dissolved < p.founded) P.push(`${where}: 解党が結党より前です`);
    if (p.successor && !parties.has(p.successor)) P.push(`${where}: 後継「${p.successor}」が ${F.parties} にありません`);
    if (p.successor && !p.dissolvedStr) P.push(`${where}: 後継があるのに解党が空です`);
    if (p.successor === p.id) P.push(`${where}: 後継が自分自身です`);
  }

  // results.csv
  for (const s of model.orphans) {
    P.push(`${at(F.results, s.line, `${s.houseName}第${s.n}回 ${s.party}`)}: この回が elections/elections.csv にありません（院は「衆議院」か「参議院」、回は整数）`);
  }
  const dup = new Set();
  const exists = (p, t) => p && !(p.founded != null && p.founded > t) && !(p.dissolved != null && p.dissolved <= t);
  for (const key of Object.keys(houses)) {
    houses[key].forEach((e, i) => {
      if (!e.covered) return;
      const label = `${HOUSES[key].name}第${e.n}回`;
      const whereE = `elections/elections.csv（${label}）`;
      if (Number.isNaN(e.date)) P.push(`${whereE}: 投票日「${e.dateStr}」が実在する YYYY-MM-DD ではありません`);
      if (!(Number.isInteger(e.total) && e.total > 0)) P.push(`${whereE}: 定数が正の整数ではありません`);
      if (key === 'lower' && e.how && e.how !== '解散' && !e.how.startsWith('任期満了')) P.push(`${whereE}: 終わり方「${e.how}」は「解散」か「任期満了…」です`);
      if (e.how === '解散') {
        const next = houses[key][i + 1];
        if (!e.endStr || Number.isNaN(e.end)) P.push(`${whereE}: 終わり方が解散なのに、終了日（解散の日）が無いか書式が違います`);
        else if (e.end <= e.date || (next && Number.isFinite(next.date) && e.end >= next.date)) P.push(`${whereE}: 解散の日（${e.endStr}）が、投票日と次の選挙の投票日のあいだにありません`);
      }
    });
    for (const e of houses[key]) {
      if (!e.covered) continue;
      const label = `${HOUSES[key].name}第${e.n}回`;
      let won = 0;
      let hold = 0;
      let beforeFilled = 0;
      for (const s of e.seats) {
        const where = at(F.results, s.line, `${label} ${s.party}`);
        const id = `${key}:${e.n}:${s.party}`;
        if (dup.has(id)) P.push(`${where}: 同じ回の同じ党が重複しています`);
        dup.add(id);
        if (!parties.has(s.party)) P.push(`${where}: 党「${s.party}」が ${F.parties} にありません`);
        else if (!NON_PARTY.includes(s.party) && Number.isFinite(e.date) && !exists(parties.get(s.party), e.date)) P.push(`${where}: 党「${s.party}」は投票日（${e.dateStr}）に結党前か解党後です（${F.parties} の結党・解党と合いません）`);
        if (!urlsOf(s.source).length) P.push(`${where}: 出典がありません`);
        checkUrls(where, s.source);
        if (s.won == null && !(s.party === VACANT && s.wonRaw === '')) P.push(`${where}: 当選「${s.wonRaw}」が 0 以上の整数ではありません`);
        if (key === 'upper') {
          if (s.holdover == null) P.push(`${where}: 非改選「${s.holdoverRaw}」が 0 以上の整数ではありません（参議院は必須）`);
          if (s.beforeRaw !== '') P.push(`${where}: 選挙前は衆議院だけの列です`);
        } else {
          if (s.holdoverRaw !== '') P.push(`${where}: 非改選は参議院だけの列です`);
          if (s.beforeRaw !== '' && s.before == null) P.push(`${where}: 選挙前「${s.beforeRaw}」が 0 以上の整数ではありません`);
          if (s.before != null) beforeFilled += 1;
        }
        won += s.won ?? 0;
        hold += s.holdover ?? 0;
      }
      if (key === 'lower' && beforeFilled && beforeFilled !== e.seats.length) {
        P.push(`${F.results}: ${label}の選挙前は、全部の党を埋めるか全部空にしてください（${e.seats.length}党のうち${beforeFilled}党だけ入っています）`);
      }
      if (key === 'lower' && won !== e.total) P.push(`${F.results}: ${label}の当選の合計（${won}）が定数（${e.total}）と合いません`);
      if (key === 'upper' && won + hold !== e.total) P.push(`${F.results}: ${label}の当選と非改選の合計（${won}＋${hold}＝${won + hold}）が定数（${e.total}）と合いません`);
    }
    // 最初に議席のある回から後は、途切れずに続いていること
    const list = houses[key];
    const firstIdx = list.findIndex((e) => e.covered);
    if (firstIdx >= 0) {
      for (const e of list.slice(firstIdx)) if (!e.covered) P.push(`${F.results}: ${HOUSES[key].name}第${e.n}回の議席がありません（第${list[firstIdx].n}回から現在まで途切れずに必要です）`);
    }
  }

  // campaigns.csv・leaders.csv
  const columnProblems = (file, have, want) => {
    if (!have.length || have.join() === want.join()) return;
    const missing = want.filter((c) => !have.includes(c));
    const extra = have.filter((c) => !want.includes(c));
    for (const c of missing) P.push(`${file}: 列「${c}」がありません（列は ${want.join('・')} の順）`);
    for (const c of extra) P.push(`${file}: 列「${c}」は決まりにありません（列は ${want.join('・')} の順）`);
    if (!missing.length && !extra.length) P.push(`${file}: 列の順番が違います（列は ${want.join('・')} の順）`);
  };
  columnProblems(F.campaigns, model.campaignHeader, CAMPAIGN_COLUMNS);
  columnProblems(F.leaders, model.leaderHeader, LEADER_COLUMNS);
  const leaderNames = new Set();
  for (const l of model.leaderRows) {
    const where = at(F.leaders, l.line, l.name);
    if (!l.name) { P.push(`${F.leaders} ${l.line}行目: 名前が空です`); continue; }
    if (leaderNames.has(l.name)) P.push(`${where}: 同じ名前が重複しています`);
    leaderNames.add(l.name);
    if (!/^Q\d+$/.test(l.wikidata)) P.push(`${where}: Wikidata「${l.wikidata}」が Q と数字の形ではありません`);
  }
  const pmNames = new Set(model.pms.map((p) => p.name));
  const seenCampaign = new Set();
  for (const c of model.campaignRows) {
    const where = at(F.campaigns, c.line, `${c.houseName}第${c.n}回`);
    const e = c.key && c.n != null ? model.electionOf.get(`${c.key}:${c.n}`) : null;
    if (!e) P.push(`${where}: この回が elections/elections.csv にありません（院は「衆議院」か「参議院」、回は整数）`);
    if (seenCampaign.has(`${c.key}:${c.n}`)) P.push(`${where}: 同じ回が重複しています`);
    seenCampaign.add(`${c.key}:${c.n}`);
    if (!c.sources.length) P.push(`${where}: 出典がありません`);
    checkUrls(where, c.sourceRaw);
    if (c.nickname && !c.nicknameBy) P.push(`${where}: 通称があるのに、通称の出どころが空です`);
    if (c.key === 'upper' && (c.pmSays || c.oppSays)) P.push(`${where}: 参議院は解散が無いので、首相の説明と野党の批判は空にします`);
    if (c.issues.some((x) => x.includes('/'))) P.push(`${where}: 争点は全角の「／」で区切ります`);
    if (c.oppParty) {
      const p = parties.get(c.oppParty);
      if (!p) P.push(`${where}: 野党第一党「${c.oppParty}」が ${F.parties} にありません`);
      else if (e && Number.isFinite(e.date)) {
        if (!exists(p, e.date)) P.push(`${where}: 野党第一党「${c.oppParty}」は投票日（${e.dateStr}）に結党前か解党後です（${F.parties} の結党・解党と合いません）`);
        const { date } = campaignTime(model, c.key, e);
        if (governmentAt(model, date)?.ruling.includes(c.oppParty)) P.push(`${where}: 野党第一党「${c.oppParty}」は、${isoOf(date)} の与党です（${F.governments}）`);
      }
    }
    if (c.leaders.length && !c.oppParty) P.push(`${where}: 野党第一党が空なのに党首があります`);
    if (new Set(c.leaders).size !== c.leaders.length) P.push(`${where}: 党首が重複しています`);
    if (c.leaders.length && !c.role) P.push(`${where}: 党首があるのに、党首の役職が空です`);
    if (c.role && !c.leaders.length) P.push(`${where}: 党首が空なのに、党首の役職があります`);
    for (const name of c.leaders) {
      if (!leaderNames.has(name) && !pmNames.has(name)) P.push(`${where}: 党首「${name}」が ${F.leaders} にも総理大臣の年表（prime-ministers/prime-ministers.csv）にもいません`);
    }
  }
  for (const [key, list] of Object.entries(model.houses)) {
    for (const e of list.filter((x) => x.covered && !model.campaigns.has(`${key}:${x.n}`))) {
      P.push(`${F.campaigns}: ${e.name}（${e.dateStr}）の行がありません（議席のある回は、空の欄があっても1行ずつ書きます）`);
    }
  }

  // governments.csv
  const gs = model.governments;
  gs.forEach((g, i) => {
    const where = at(F.governments, g.line, g.cabinet);
    if (Number.isNaN(g.start)) P.push(`${where}: 開始日「${g.startStr}」の書式が YYYY-MM-DD ではありません`);
    if (g.endStr && Number.isNaN(g.end)) P.push(`${where}: 終了日「${g.endStr}」の書式が YYYY-MM-DD ではありません`);
    if (!g.cabinet) P.push(`${where}: 内閣が空です`);
    checkUrls(where, g.source);
    for (const id of [...g.ruling, ...g.outside]) {
      const p = parties.get(id);
      if (!p) { P.push(`${where}: 党「${id}」が ${F.parties} にありません`); continue; }
      const stop = g.end ?? model.asOf;
      if (Number.isFinite(g.start) && ((p.founded != null && p.founded > g.start) || (p.dissolved != null && Number.isFinite(stop) && p.dissolved < stop))) {
        P.push(`${where}: 党「${id}」が、この行の期間（${g.startStr}〜${g.endStr || '現在'}）を通してはありません。結党・解党・名前の変更の日で行を分けてください`);
      }
    }
    for (const id of g.ruling) if (g.outside.includes(id)) P.push(`${where}: 党「${id}」が与党と閣外協力の両方に入っています`);
    const next = gs[i + 1];
    if (next) {
      if (!g.endStr) P.push(`${where}: 終了日が空なのは最後の行だけにしてください`);
      else if (Number.isFinite(g.end) && Number.isFinite(next.start) && g.end !== next.start) {
        P.push(`${where}: 終了日（${g.endStr}）が次の行の開始日（${next.startStr}）と同じではありません（${g.end < next.start ? 'すき間' : '重なり'}）`);
      }
    } else if (g.endStr) {
      P.push(`${where}: 最後の行の終了日は空にしてください（続いている政権）`);
    }
    if (Number.isFinite(g.start) && Number.isFinite(g.end) && g.end <= g.start) P.push(`${where}: 終了日が開始日以前です`);
  });
  if (!gs.length) P.push(`${F.governments}: 行がありません`);
  else if (Number.isFinite(model.first) && Number.isFinite(gs[0].start) && gs[0].start > model.first) {
    P.push(`${F.governments}: 最初の行（${gs[0].startStr}〜）がデータの最初の選挙の日（${isoOf(model.first)}）を覆っていません`);
  }
  if (!Number.isFinite(model.first)) P.push(`${F.results}: 議席のデータがありません`);
  return P;
}

// ---------------------------------------------------------------- ある日の状態

export function governmentAt(model, t) {
  return model.governments.find((g) => g.start <= t && (g.end == null || t < g.end)) ?? null;
}

// 選挙のときの党が t までに解党していれば、後継をたどって t にある党にする。後継のない党は null
function resolveParty(model, id, t) {
  let p = model.parties.get(id);
  for (let i = 0; p && p.dissolved != null && p.dissolved <= t; i += 1) {
    p = i < 20 && p.successor ? model.parties.get(p.successor) : null;
  }
  return p ? p.id : null;
}

function roleOf(model, id, gov, t) {
  if (NON_PARTY.includes(id)) return 'independent';
  const now = resolveParty(model, id, t);
  if (now && gov?.ruling.includes(now)) return 'ruling';
  if (now && gov?.outside.includes(now)) return 'outside';
  return 'opposition';
}

// 扇の左から右の並び：与党 → 閣外協力 → 最大野党以外の野党 → 無所属・諸派 → 欠員 → 最大野党
function arrange(groups, hasRuling) {
  const byCount = (a, b) => b.count - a.count || a.order - b.order;
  const of = (role) => groups.filter((g) => g.role === role).sort(byCount);
  const ruling = of('ruling');
  const outside = of('outside');
  const opposition = of('opposition');
  const indep = groups.filter((g) => INDEPENDENT.includes(g.party)).sort((a, b) => INDEPENDENT.indexOf(a.party) - INDEPENDENT.indexOf(b.party));
  const vacant = groups.filter((g) => g.party === VACANT);
  if (hasRuling && ruling.length) {
    const leader = opposition[0];
    return { list: [...ruling, ...outside, ...opposition.slice(1), ...indep, ...vacant, ...(leader ? [leader] : [])], leader: leader ?? null };
  }
  const named = [...outside, ...opposition].sort(byCount);
  return { list: [...named, ...indep, ...vacant], leader: null };
}

const majorityOf = (total) => Math.floor(total / 2) + 1;
const twoThirdsOf = (total) => Math.ceil((total * 2) / 3);
const statusOf = (ruling, maj, two) => (ruling >= two ? '3分の2以上' : ruling >= maj ? '過半数' : '過半数割れ');

function houseAt(model, key, t, gov) {
  const info = HOUSES[key];
  const list = model.houses[key].filter((e) => e.covered);
  const election = list.findLast((e) => e.date <= t) ?? null;
  if (!election || (key === 'upper' && t < UPPER_START)) {
    const reason = key === 'upper' && t < UPPER_START ? '参議院の発足前（1947年5月3日に発足）' : 'この日より前の議席のデータがありません';
    return { key, ...info, phase: 'none', reason, election: null, groups: [], total: 0 };
  }
  const dissolved = key === 'lower' && election.how === '解散' && election.end != null && t > election.end;
  const hasRuling = !!gov && gov.ruling.length > 0;
  const groups = election.seats.map((s) => {
    const p = model.parties.get(s.party);
    return {
      party: s.party, name: p?.name ?? s.party, short: p?.short ?? s.party, color: p?.color ?? '#8E949E',
      won: s.won ?? 0, holdover: s.holdover ?? 0, count: (s.won ?? 0) + (s.holdover ?? 0), before: s.before,
      role: roleOf(model, s.party, gov, t), order: s.order,
    };
  }).filter((g) => g.count > 0);
  const { list: ordered, leader } = arrange(groups, hasRuling);
  const total = election.total;
  const sum = (role) => groups.filter((g) => g.role === role).reduce((a, g) => a + g.count, 0);
  const ruling = sum('ruling');
  const outside = sum('outside');
  const majority = majorityOf(total);
  const twoThirds = twoThirdsOf(total);
  const independents = groups.filter((g) => g.party === '無所属').reduce((a, g) => a + g.count, 0);
  const stale = [...new Set(groups.filter((g) => {
    const p = model.parties.get(g.party);
    return p?.dissolved != null && p.dissolved > election.date && p.dissolved <= t;
  }).map((g) => {
    const now = resolveParty(model, g.party, t);
    const label = model.parties.get(g.party)?.label ?? g.name;
    return now ? `${label}は${model.parties.get(now)?.label ?? now}に引き継がれ` : `${label}は解党し`;
  }))];
  // 選挙のあとにできた与党の党は、選挙の結果に議席が無いので与党の議席に入らない
  const seated = new Set(groups.map((g) => resolveParty(model, g.party, t)));
  const absent = (gov?.ruling ?? []).filter((id) => !seated.has(id) && (model.parties.get(id)?.founded ?? -Infinity) > election.date)
    .map((id) => model.parties.get(id)?.label ?? id);
  let reach = '';
  if (hasRuling && ruling < majority) {
    if (ruling + outside >= majority) reach = '閣外協力を足すと過半数';
    else if (ruling + outside + independents >= majority) reach = outside ? '閣外協力と無所属を足すと過半数' : '無所属を足すと過半数';
  }
  return {
    key, ...info, phase: dissolved ? 'dissolved' : 'seated', election, dissolvedAt: dissolved ? election.end : null,
    total, majority, twoThirds, groups: ordered, leader,
    ruling, outside, opposition: sum('opposition'), hasRuling,
    status: hasRuling ? statusOf(ruling, majority, twoThirds) : null,
    reach,
    note: [
      stale.length ? `選挙のあと、${stale.join('、')}ました。議席は選挙のときのものです。` : '',
      absent.length ? `与党の${absent.join('・')}は選挙のあとにできた党で、この議席には入っていません。` : '',
    ].filter(Boolean).join(''),
  };
}

function parliamentStatus(lower, upper, gov) {
  if (lower.phase === 'dissolved') return { kind: 'dissolved', label: '衆議院は解散中', note: '' };
  if (lower.phase !== 'seated' || upper.phase !== 'seated') return { kind: null, label: '', note: '' };
  if (!gov || !gov.ruling.length) return { kind: 'noRuling', label: '与党なし', note: '' };
  const lowerMajority = lower.ruling >= lower.majority;
  const upperMajority = upper.ruling >= upper.majority;
  if (!lowerMajority) return { kind: 'minority', label: upperMajority ? '少数与党' : '衆参で少数与党', note: '' };
  if (!upperMajority) return { kind: 'twisted', label: 'ねじれ国会', note: lower.ruling >= lower.twoThirds ? '衆院で再可決が可能' : '' };
  return { kind: null, label: '', note: '' };
}

// 日付 t の国会：両院の構成・その日の内閣・状態
export function stateAt(model, t) {
  const government = governmentAt(model, t);
  const lower = houseAt(model, 'lower', t, government);
  const upper = houseAt(model, 'upper', t, government);
  return { t, government, lower, upper, status: parliamentStatus(lower, upper, government), notes: { lower: lower.note, upper: upper.note } };
}

// 構成が変わる日（選挙・解散・政権の交代）で区切り、ねじれ国会と少数与党の区間を返す
export function statusBands(model) {
  const end = model.asOf;
  const cuts = new Set([model.first]);
  for (const key of Object.keys(model.houses)) {
    for (const e of model.houses[key]) {
      if (!e.covered) continue;
      cuts.add(e.date);
      if (key === 'lower' && e.how === '解散' && e.end != null) cuts.add(e.end + DAY);
    }
  }
  for (const g of model.governments) cuts.add(g.start);
  // 合流・改称の日から、選挙のときの党が後継の党として与党に数えられる
  for (const p of model.parties.values()) if (p.dissolved != null) cuts.add(p.dissolved);
  const points = [...cuts].filter((t) => t >= model.first && t < end).sort((a, b) => a - b);
  const bands = [];
  points.forEach((start, i) => {
    const kind = stateAt(model, start).status.kind;
    if (kind !== 'twisted' && kind !== 'minority') return;
    const stop = points[i + 1] ?? end;
    const last = bands[bands.length - 1];
    if (last && last.kind === kind && last.end === start) last.end = stop;
    else bands.push({ start, end: stop, kind });
  });
  return bands;
}

// 政権の帯：与党第一党（議席の最も多い与党）の色と、内閣の名字
export function govBands(model) {
  return model.governments.map((g) => {
    const t = Math.max(g.start, model.first);
    const s = stateAt(model, t);
    const top = [s.lower, s.upper].find((h) => h.groups.some((x) => x.role === 'ruling'))?.groups.find((x) => x.role === 'ruling');
    const color = top?.color ?? model.parties.get(g.ruling[0])?.color ?? '#5A6270';
    return {
      start: g.start, end: g.end ?? model.asOf, cabinet: g.cabinet, color, gov: g,
      surname: g.cabinet.replace(/^第\d+次/, '').replace(/(改造)?(連立)?内閣.*$/, ''),
    };
  });
}

// 政権の名前・始まり・与党・閣外協力の表示用
export function govSummary(model, gov) {
  if (!gov) return null;
  const short = (id) => model.parties.get(id)?.short ?? id;
  // 与党が変わって行を分けた内閣も、内閣の始まりの日を出す
  const gs = model.governments;
  let first = gov;
  for (let j = gs.indexOf(gov) - 1; j >= 0 && gs[j].cabinet === gov.cabinet && gs[j].end === first.start; j -= 1) first = gs[j];
  const { y, m } = ymd(first.start);
  return {
    cabinet: gov.cabinet, since: `${y}.${pad(m)}`,
    ruling: gov.ruling.map(short), outside: gov.outside.map(short),
  };
}

// 時点を選べる選挙の日（衆議院と参議院、重複なし、古い順）
export function electionDates(model) {
  return [...new Set(Object.values(model.houses).flat().filter((e) => e.covered).map((e) => e.date))].sort((a, b) => a - b);
}

// ---------------------------------------------------------------- 見出し・数字・顔ぶれ

function governmentAtElection(model, e) {
  return governmentAt(model, e.date);
}

// パネルの一行。データから作り、人の評価の言葉は使わない
export function headline(model, house, election) {
  const gov = governmentAtElection(model, election);
  const rows = election.seats.map((s) => ({ ...s, p: model.parties.get(s.party), count: (s.won ?? 0) + (house === 'upper' ? s.holdover ?? 0 : 0) }))
    .filter((s) => !NON_PARTY.includes(s.party));
  const top = rows.sort((a, b) => b.count - a.count || a.order - b.order)[0];
  if (!top) return '';
  const name = top.p?.name ?? top.party;
  const total = election.total;
  if (house === 'lower') {
    const n = top.won ?? 0;
    if (n >= twoThirdsOf(total)) return `${name}が${n}議席を得て、単独で3分の2以上を占めた。`;
    if (n >= majorityOf(total)) return `${name}が${n}議席を得て、単独で過半数を占めた。`;
    return `${name}が${n}議席で第一党。単独では過半数に届かない。`;
  }
  const first = `${name}が改選${top.won ?? 0}議席。非改選と合わせて${top.count}議席。`;
  if (!gov || !gov.ruling.length) return first;
  const ruling = election.seats.filter((s) => gov.ruling.includes(resolveParty(model, s.party, election.date) ?? '')).reduce((a, s) => a + (s.won ?? 0) + (s.holdover ?? 0), 0);
  const st = statusOf(ruling, majorityOf(total), twoThirdsOf(total));
  const names = gov.ruling.map((id) => model.parties.get(id)?.short ?? id).join('・');
  return `${first}選挙のときの与党（${names}）は${ruling}議席で${st === '3分の2以上' ? '3分の2以上' : st === '過半数' ? '過半数' : '過半数割れ'}。`;
}

const turnoutText = (v) => `${v.toFixed(2)}%`;
const turnoutDiff = (v, prev) => {
  if (prev == null || v == null) return '';
  const d = Math.round((v - prev) * 100) / 100;
  return `前回比 ${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d).toFixed(2)}pt`;
};

// パネルの数字（3つ）
export function houseStats(model, house) {
  const e = house.election;
  if (!e) return [];
  const list = model.houses[house.key];
  const idx = list.indexOf(e);
  const prev = list[idx - 1] ?? null;
  const next = list[idx + 1] ?? null;
  const turnout = { label: '投票率', value: e.turnout == null ? '—' : turnoutText(e.turnout), sub: turnoutDiff(e.turnout, prev?.turnout) };
  if (house.key === 'upper') {
    const won = e.seats.reduce((a, s) => a + (s.won ?? 0), 0);
    const hold = e.seats.reduce((a, s) => a + (s.holdover ?? 0), 0);
    const year = ymd(e.date).y;
    return [
      turnout,
      { label: '改選／非改選', value: `${won}／${hold}`, sub: '3年ごとに半数' },
      { label: '次の通常選挙', value: next ? dotOf(next.date) : `${year + 3}年夏`, sub: `第${next ? next.n : e.n + 1}回` },
    ];
  }
  let gap = { value: '—', sub: '' };
  if (prev?.how === '解散' && prev.end != null) gap = { value: `${Math.round((e.date - prev.end) / DAY)}日`, sub: `解散 ${dotOf(prev.end)}` };
  else if (prev?.how.startsWith('任期満了')) gap = { value: '任期満了', sub: '前の議会は任期満了' };
  const { y, m, d } = ymd(e.date);
  const expiry = toTime(`${pad(y + 4, 4)}-${pad(m)}-${pad(d)}`) - DAY;
  const term = house.phase === 'dissolved'
    ? { label: '解散', value: dotOf(e.end), sub: '' }
    : { label: '任期満了', value: dotOf(expiry), sub: '解散がなければ' };
  return [turnout, { label: '解散から投票まで', ...gap }, term];
}

// 写真は、総理大臣の年表（官邸の肖像）にいる人はそれを、いなければ leaders.csv のものを使う
function portraitOf(model, name) {
  const pm = model.pms.find((p) => p.name === name && p.photo);
  if (pm) return { photo: pm.photo, from: 'pm' };
  const own = model.leaders.get(name)?.photo;
  return own ? { photo: own, from: 'own' } : { photo: '', from: '' };
}

export const campaignOf = (model, key, election) => model.campaigns.get(`${key}:${election.n}`) ?? null;

// 選挙の説明と顔ぶれの時点：衆議院は、その選挙を招いた解散の日（任期満了と最初の回は投票日）、参議院は投票日
export function campaignTime(model, key, e) {
  const prev = key === 'lower' ? model.houses.lower[model.houses.lower.indexOf(e) - 1] : null;
  const byDissolution = prev?.how === '解散' && prev.end != null;
  return { prev, byDissolution, date: byDissolution ? prev.end : e.date, when: byDissolution ? '解散時' : '選挙時' };
}

// 顔ぶれ：その時点の総理大臣と、野党第一党の党首。片方の側だけが並ばないように、
// 首相がいない日（首相の死去のあと）は「不在」、党首が空の回は党の名前で枠を出す
export function faces(model, house) {
  const e = house.election;
  if (!e) return [];
  const { date, when } = campaignTime(model, house.key, e);
  const pm = model.pms.find((p) => p.start <= date && (p.end == null || date < p.end));
  const pmColor = model.parties.get(governmentAt(model, date)?.ruling[0])?.color ?? '#8D96A4';
  const people = [pm
    ? { role: `首相（${when}）`, name: pm.name, ...portraitOf(model, pm.name), color: pmColor }
    : { role: `首相（${when}）`, name: '不在', photo: '', from: '', color: pmColor }];
  const c = campaignOf(model, house.key, e);
  const party = c?.oppParty ? model.parties.get(c.oppParty) : null;
  if (party) {
    const color = party.color ?? '#8D96A4';
    if (!c.leaders.length) people.push({ role: `野党第一党（${when}）`, name: party.name, photo: '', from: '', color });
    const role = `野党第一党（${when}・${[party.short, c.role].filter(Boolean).join(' ')}）`;
    for (const name of c.leaders) people.push({ role, name, ...portraitOf(model, name), color });
  }
  return people;
}

// 通称には、誰が使った呼び方かを添える（「報道の呼び方」「首相が記者会見で用いた呼び方」）
export const aliasOf = (c) => (c?.nickname ? `『${c.nickname}』（${c.nicknameBy}${/[でに]$/.test(c.nicknameBy) ? '用いた' : 'の'}呼び方）` : '');
// 首相が使った通称は、見出しにせず首相の説明の枠に入れる（一方の呼び方だけが大きく出ないように）
const pmAliasOf = (c) => (/^首相/.test(c?.nicknameBy ?? '') ? aliasOf(c) : '');

// 首相の説明と野党の批判は、両方そろった回だけ返す（片方だけでは偏って見えるため）。ページも README もこれで出す
export const saysOf = (c) => (c?.pmSays && c?.oppSays
  ? [{ label: '首相の説明', alias: pmAliasOf(c), text: c.pmSays }, { label: '野党の批判', alias: '', text: c.oppSays }]
  : []);

// 解散の箱：衆議院は解散（または任期満了）の日・通称・首相の説明と野党の批判、参議院は「解散なし」。
// 解散中に出ているのは、いまの解散の前の解散なので「前回の解散」とする
export function dissolutionBox(model, house) {
  const e = house.election;
  if (!e) return null;
  const c = campaignOf(model, house.key, e);
  const alias = pmAliasOf(c) ? '' : aliasOf(c);
  const sources = c?.sources ?? [];
  if (house.key === 'upper') return { title: '解散なし', sub: '任期満了（3年ごとの半数改選）', alias, says: [], sources };
  const { prev, byDissolution } = campaignTime(model, 'lower', e);
  const title = byDissolution ? `${house.phase === 'dissolved' ? '前回の解散' : '解散'} ${dotOf(prev.end)}` : prev?.how.startsWith('任期満了') ? '任期満了' : '解散';
  return { title, sub: '', alias, says: saysOf(c), sources };
}

export const issuesOf = (model, house) => (house.election ? campaignOf(model, house.key, house.election)?.issues ?? [] : []);

const deltaText = (d) => (d > 0 ? `+${d}` : d < 0 ? `−${Math.abs(d)}` : '±0');

// 凡例。政党別は党ごと、与党・野党は4つにまとめる
export function legendEntries(house, mode) {
  if (mode === 'bloc') {
    return ['ruling', 'outside', 'opposition', 'independent']
      .map((role) => {
        const gs = house.groups.filter((g) => g.role === role);
        const n = gs.reduce((a, g) => a + g.count, 0);
        const names = gs.map((g) => g.short).join('・');
        const label = role === 'ruling' || role === 'outside' ? `${BLOC_NAME[role]}${names ? `（${names}）` : ''}` : BLOC_NAME[role];
        return { key: role, label, color: BLOC[role], value: n, sub: '', delta: 0 };
      })
      .filter((x) => x.value > 0);
  }
  const hasBefore = house.key === 'lower' && house.election.seats.every((s) => s.before != null);
  return house.groups.map((g) => ({
    key: g.party, label: g.short, color: g.color, value: g.count,
    sub: house.key === 'upper' ? `${g.won}＋${g.holdover}` : hasBefore ? deltaText(g.count - (g.before ?? 0)) : '',
    delta: house.key === 'lower' && hasBefore ? g.count - (g.before ?? 0) : 0,
  }));
}

// ---------------------------------------------------------------- 扇の配置（ラフの layout と同じ考え）

export const FAN = { W: 600, H: 340, CX: 300, CY: 330, R: 296, R0: 118 };

// 左から右の点の配列。段の数は Math.round(Math.sqrt(total * 0.32))
export function hemicycle(total) {
  const { CX, CY, R, R0 } = FAN;
  const rows = Math.max(2, Math.round(Math.sqrt(total * 0.32)));
  const radii = Array.from({ length: rows }, (_, i) => R0 + ((R - R0) * i) / (rows - 1));
  const sum = radii.reduce((a, r) => a + r, 0);
  const counts = radii.map((r) => Math.round((total * r) / sum));
  counts[rows - 1] += total - counts.reduce((a, c) => a + c, 0);
  const dot = (((R - R0) / (rows - 1)) * 0.74) / 2;
  const pts = [];
  radii.forEach((r, i) => {
    const k = counts[i];
    for (let j = 0; j < k; j += 1) {
      const t = k === 1 ? Math.PI / 2 : Math.PI * (1 - j / (k - 1));
      pts.push({ x: CX + r * Math.cos(t), y: CY - r * Math.sin(t), t, ring: r, r: dot });
    }
  });
  return pts.sort((a, b) => b.t - a.t || a.ring - b.ring);
}

// 過半数の破線と3分の2の点線（座席の境目に引く）
export function fanLines(total) {
  const { CX, CY, R, R0 } = FAN;
  const pts = hemicycle(total);
  return [
    { kind: 'majority', seats: majorityOf(total), label: `過半数 ${majorityOf(total)}` },
    { kind: 'twoThirds', seats: twoThirdsOf(total), label: `3分の2 ${twoThirdsOf(total)}` },
  ].map((l) => {
    const th = l.seats < total ? (pts[l.seats - 1].t + pts[l.seats].t) / 2 : 0;
    const at = (rad) => [CX + rad * Math.cos(th), CY - rad * Math.sin(th)];
    const [x1, y1] = at(R0 - 10);
    const [x2, y2] = at(R + 10);
    const [lx, ly] = at(R + 16);
    return { ...l, x1, y1, x2, y2, lx, ly };
  });
}

// 点ごとの色と濃さ。参議院は、各党の今回改選を濃く、非改選を淡く
export function fanDots(house, mode = 'party') {
  const pts = hemicycle(house.total);
  const fade = house.phase === 'dissolved' ? 0.3 : 1;
  const dots = [];
  for (const g of house.groups) {
    const color = mode === 'bloc' ? BLOC[g.role] : g.color;
    const key = mode === 'bloc' ? g.role : g.party;
    const solid = house.key === 'upper' ? g.won : g.count;
    for (let i = 0; i < g.count && dots.length < pts.length; i += 1) {
      dots.push({ ...pts[dots.length], fill: color, opacity: (i < solid ? 1 : 0.5) * fade, key });
    }
  }
  while (dots.length < pts.length) dots.push({ ...pts[dots.length], fill: '#3A4250', opacity: 0.5 * fade, key: '' });
  return dots;
}

// ---------------------------------------------------------------- SVG

const SEAT_THEMES = {
  dark: { bg: '#12171F', ink: '#EDEBE6', muted: '#8D96A4', amber: '#F5A524', alert: '#F07A6E' },
  light: { bg: '#FFFFFF', ink: '#1C2029', muted: '#687080', amber: '#B8730F', alert: '#C23B2E' },
};
const FONT = '"BIZ UDPGothic", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, "Noto Sans JP", sans-serif';
const FONT_NUM = '"Inter Tight", "BIZ UDPGothic", "Hiragino Sans", "Noto Sans JP", sans-serif';
const FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const xml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f1 = (n) => n.toFixed(1);

// 1つの院の扇形（定数・過半数と3分の2の線・左右の注記まで含む）
export function renderHouseSVG(house, { mode = 'party', theme = 'dark', heading = false } = {}) {
  const { W, H, CX } = FAN;
  const T = SEAT_THEMES[theme];
  const head = heading ? 34 : 0;
  const y0 = -8 - head;
  const height = H + 34 - y0;
  const open = `<svg xmlns="http://www.w3.org/2000/svg" class="fan" viewBox="0 ${y0} ${W} ${height}" role="img" aria-label="${xml(`${house.name}の議席 ${house.phase === 'none' ? house.reason : `${house.total}議席`}`)}">`;
  const parts = [open];
  if (heading) {
    const e = house.election;
    const title = e ? `${house.name}　${e.short}　${e.dateStr.replaceAll('-', '.')}` : house.name;
    parts.push(`<text x="0" y="${y0 + 22}" font-family="${xml(FONT)}" font-size="22" font-weight="700" fill="${T.ink}">${xml(title)}</text>`);
  }
  if (house.phase === 'none') {
    parts.push(`<text x="${CX}" y="${H - 20}" text-anchor="middle" font-family="${xml(FONT)}" font-size="24" fill="${T.muted}">${xml(house.reason)}</text></svg>`);
    return parts.join('');
  }
  parts.push('<g class="dots">');
  for (const d of fanDots(house, mode)) {
    parts.push(`<circle cx="${f1(d.x)}" cy="${f1(d.y)}" r="${f1(d.r)}" fill="${d.fill}"${d.opacity < 1 ? ` opacity="${d.opacity.toFixed(2)}"` : ''}${d.key ? ` data-k="${xml(d.key)}"` : ''}/>`);
  }
  parts.push('</g><g class="marks">');
  for (const l of fanLines(house.total)) {
    const major = l.kind === 'majority';
    const color = T.ink;
    parts.push(`<line x1="${f1(l.x1)}" y1="${f1(l.y1)}" x2="${f1(l.x2)}" y2="${f1(l.y2)}" stroke="${color}" stroke-width="2" stroke-dasharray="${major ? '7 5' : '1.5 5'}" stroke-linecap="${major ? 'butt' : 'round'}"/>`);
    parts.push(`<text class="fan-line" x="${f1(l.lx)}" y="${f1(l.ly - 4)}" text-anchor="middle" font-family="${FONT_MONO}" font-size="11" font-weight="700" fill="${color}">${xml(l.label)}</text>`);
  }
  parts.push('</g>');
  parts.push(`<text class="fan-total" x="${CX}" y="${H - 28}" text-anchor="middle" font-family="${xml(FONT_NUM)}" font-size="56" font-weight="800" fill="${T.ink}">${house.total}</text>`);
  parts.push(`<text class="fan-cap" x="${CX}" y="${H - 8}" text-anchor="middle" font-family="${FONT_MONO}" font-size="11" letter-spacing="1.5" fill="${T.muted}">定数</text>`);
  parts.push(`<text class="fan-side" x="0" y="${H + 24}" font-family="${FONT_MONO}" font-size="11" fill="${T.muted}">← ${house.hasRuling ? '与党' : '第一党'}</text>`);
  if (house.leader) parts.push(`<text class="fan-side" x="${W}" y="${H + 24}" text-anchor="end" font-family="${FONT_MONO}" font-size="11" fill="${T.muted}">最大野党 →</text>`);
  parts.push('</svg>');
  return parts.join('');
}

// README 用：最新の時点の両院を並べた画像
export function renderSeatsSVG(model, state, { theme = 'dark', mode = 'party' } = {}) {
  const T = SEAT_THEMES[theme];
  const W = 1240;
  const gov = govSummary(model, state.government);
  const sub = [
    gov ? `${gov.cabinet}（${gov.since}〜）　与党：${gov.ruling.join('・') || 'なし'}${gov.outside.length ? `　閣外協力：${gov.outside.join('・')}` : ''}` : '',
    state.status.label ? `${state.status.label}${state.status.note ? `（${state.status.note}）` : ''}` : '',
  ].filter(Boolean).join('　／　');
  const houseSvg = (house, x) => renderHouseSVG(house, { mode, theme, heading: true })
    .replace('<svg ', `<svg x="${x}" y="84" width="590" height="410" `);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 520" width="${W}" height="520">`,
    `<rect width="${W}" height="520" rx="14" fill="${T.bg}"/>`,
    `<text x="24" y="44" font-family="${xml(FONT)}" font-size="26" font-weight="700" fill="${T.ink}">国会の議席　${dotOf(state.t)}</text>`,
    `<text x="24" y="70" font-family="${xml(FONT)}" font-size="14" fill="${T.muted}">${xml(sub)}</text>`,
    houseSvg(state.lower, 20),
    houseSvg(state.upper, 630),
    `<text x="${W - 24}" y="506" text-anchor="end" font-family="${xml(FONT)}" font-size="12" fill="${T.muted}">出典：diet-seats/results.csv ほか</text>`,
    '</svg>',
  ].join('\n');
}
