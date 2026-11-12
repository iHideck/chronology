#!/usr/bin/env node
// 年表の人物写真を Wikimedia Commons から取り込む。
//   node photos.mjs <ディレクトリ>...
// 取り込む CSV は chronology.json の data.file。photos.file があれば、そちらを取り込む（写真の列は既定の名前）。
// <ディレクトリ>/chronology.json と CSV を読み、Wikidata 列の ID から肖像を探して、顔を中心にした正方形に切り出し、
// photos/<ID>.jpg（128px）と photos/small/<ID>.jpg（48px）に書く。作者とライセンスも CSV に書く。
// Mac 専用（顔の検出に Vision を使う）。swiftc と ImageMagick（magick）が要る。
// 写真のファイルがある人は取り直さない。新しく取った人は、その人のすべての行の写真の欄を書き直す。
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DEFAULT_COLUMNS, parseCSV } from './src/timeline.mjs';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

const USER_AGENT = 'chronology-photos/1.0 (https://github.com/iHideck/chronology)';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const THUMB_WIDTH = 960;
const BATCH = 50;
const REQUEST_GAP_MS = 300;
const RETRIES = 4;
const PHOTO_SIZE = 128;
const SMALL_SIZE = 48;
const JPEG_QUALITY = 85;
// 既存の写真（us-presidents/photos の46枚）に顔検出をかけた中央値。顔の高さ÷枠の1辺と、
// 顔の中心の枠の中心からの縦のずれ÷枠の1辺（上が負）。横のずれは -0.001 なので顔を横の中央に置く
const FACE_HEIGHT_RATIO = 0.5085;
const FACE_CENTER_DY = -0.0834;

const PHOTO_COLUMNS = { photo: '写真', photoCredit: '写真の出典', photoUrl: '写真のページ', photoLicense: '写真のライセンス' };
// 写真のページにこう書いた人は、写真を取らない（Wikidata の画像が肖像に向かないときなど）
export const NO_PHOTO = 'なし';
const PHOTO_ROLES = Object.keys(PHOTO_COLUMNS);

class UserError extends Error {}

// ---------------------------------------------------------------- 純粋な部分

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// Commons の作者欄は、言語違いの同じ文を display:none で隠して並べることがある。隠した部分は捨てる
export function plainText(html) {
  return String(html ?? '')
    .replace(/<(span|div)\b[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(?:br|p|div|li|ul|ol|table|tr|td)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (all, dec, hex, name) => {
      if (name) return ENTITIES[name.toLowerCase()] ?? all;
      const code = dec ? Number(dec) : parseInt(hex, 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : all;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

const UNKNOWN_AUTHOR = /^(?:(?:unknown|unbekannt|inconnu|desconocido|anonymous|anonyme|anonymus|not specified|неизвестен|неизвестный автор|不明|不詳|作者不明)(?: (?:author|photographer|artist|painter|creator))?(?: or not provided)?|author|photographer|artist|painter|creator)\s*(?:[;,.(].*)?$/i;

export function authorOf(html) {
  let text = plainText(html);
  const assumed = /^No machine-readable author provided\.\s*(.+?) assumed \(based on copyright claims\)\.?$/i.exec(text);
  if (assumed) text = assumed[1];
  text = text.replace(/\s*\[\d+\]/g, '').replace(/^(?:photo(?:graph(?:y|er)?)?|image)(?: by|:)\s+/i, '').trim();
  return text === '' || /^No machine-readable author provided/i.test(text) || UNKNOWN_AUTHOR.test(text) ? '作者不明' : text;
}

// 表示の仕方をライセンスの持ち主が決めている画像（Bundesarchiv など）は、その文を作者の欄より優先する。
// 末尾のライセンス名は、出典の文の最後に足すので省く
export function creditAuthor(meta) {
  const attribution = plainText(meta.Attribution?.value)
    .replace(/\s*\(Photographer name\)/i, '')
    .replace(/\s*[/,]\s*CC[- ]BY(?:-SA)?(?:[- ]\d\.\d)?(?:[- ][a-z]{2,3})?$/i, '')
    .replace(/\s*\/\s*(?:unknown(?: author)?|unbekannt|o\.\s?Ang\.)$/i, '');
  return attribution || authorOf(meta.Artist?.value);
}

// creativecommons.org の URL は日本語の解説ページ（…/deed.ja）にそろえる。CC 以外の URL は ''
function ccDeed(url) {
  let u;
  try { u = new URL(url); } catch { return ''; }
  if (u.hostname.replace(/^www\./, '') !== 'creativecommons.org') return '';
  return `https://creativecommons.org${u.pathname.replace(/\/(?:deed|legalcode)(?:\.[\w-]+)?$/i, '').replace(/\/+$/, '')}/deed.ja`;
}

// 自由に使えると分かるライセンスだけを通す（許可リスト）。ここに無いものは null で、その写真は使わない
export function classifyLicense({ code = '', shortName = '', url = '' }) {
  const id = code.trim().toLowerCase();
  const name = shortName.trim();
  if (/^pd(?:-|$)/.test(id) || /^(?:public domain|pd\b)/i.test(name)) return { label: 'パブリックドメイン', url: '' };
  if (id === 'cc0' || id === 'cc-zero' || /^cc0\b/i.test(name)) {
    return { label: 'CC0', url: ccDeed(url) || ccDeed('https://creativecommons.org/publicdomain/zero/1.0/') };
  }
  const cc = /^CC[- ]BY(-SA)?[- ](\d\.\d)(?:[- ]([a-z]{2,3}))?$/i.exec(name);
  if (cc) {
    const [, sa, version, port] = cc;
    const kind = sa ? 'by-sa' : 'by';
    return {
      label: `CC ${kind.toUpperCase()} ${version}${port ? ` ${port.toUpperCase()}` : ''}`,
      url: ccDeed(url) || ccDeed(`https://creativecommons.org/licenses/${kind}/${version}/${port ? `${port.toLowerCase()}/` : ''}`),
    };
  }
  if (/^(?:OGL|Open Government Licen[cs]e|KOGL Type 1|Licence Ouverte)\b/i.test(name)) return { label: name, url };
  // Commons の {{Attribution}}。著作者を示せば、改変も含めてどんな目的にも使える
  if (/^Attribution$/i.test(name)) return { label: 'Attribution', url: url || 'https://commons.wikimedia.org/wiki/Template:Attribution' };
  return null;
}

export function commonsTitle(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.hostname !== 'commons.wikimedia.org' && u.hostname !== 'commons.m.wikimedia.org') return null;
  const raw = u.pathname.startsWith('/wiki/') ? u.pathname.slice('/wiki/'.length) : u.searchParams.get('title');
  if (!raw) return null;
  let title;
  try { title = decodeURIComponent(raw).replaceAll('_', ' ').trim(); } catch { return null; }
  return /^File:.+/i.test(title) ? `File:${title.slice(5).trim()}` : null;
}

export function pickP18(claims) {
  const usable = (claims ?? []).filter((c) => c.mainsnak?.snaktype === 'value' && c.rank !== 'deprecated');
  return (usable.find((c) => c.rank === 'preferred') ?? usable[0])?.mainsnak.datavalue.value ?? null;
}

export function cropSquare(face, width, height) {
  const side = Math.min(width, height);
  if (!face) return { size: side, x: Math.round((width - side) / 2), y: 0 };
  const size = Math.round(Math.min(side, face.h / FACE_HEIGHT_RATIO));
  const x = Math.round(face.x + face.w / 2 - size / 2);
  const y = Math.round(face.y + face.h / 2 - size / 2 - FACE_CENTER_DY * size);
  return { size, x: Math.min(Math.max(x, 0), width - size), y: Math.min(Math.max(y, 0), height - size) };
}

// 既存の CSV の書き方（引用符はカンマ・引用符・改行を含む欄だけ、LF、末尾に改行）。processDataset が元のファイルとの一致を確かめる
export function serializeCSV(header, rows) {
  const cell = (s) => (/[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
  return `${[header, ...rows.map((r) => header.map((h) => r[h] ?? ''))].map((cells) => cells.map(cell).join(',')).join('\n')}\n`;
}

// ---------------------------------------------------------------- Wikidata・Commons

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function createCommons() {
  const p18s = new Map();
  const infos = new Map();
  let last = 0;

  async function request(url, init = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const wait = last + REQUEST_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      const backoff = 1000 * 2 ** attempt;
      let res;
      try {
        res = await fetch(url, { ...init, headers: { 'User-Agent': USER_AGENT, ...init.headers }, signal: AbortSignal.timeout(60_000) });
      } catch (e) {
        if (attempt >= RETRIES) throw new Error(`${url} に届きません（${e.cause?.code ?? e.message}）`);
        await sleep(backoff);
        continue;
      }
      if (res.ok) return res;
      await res.arrayBuffer().catch(() => {});
      if ((res.status !== 429 && res.status < 500) || attempt >= RETRIES) throw new Error(`${url} が HTTP ${res.status} を返しました`);
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, 60_000) : backoff);
    }
  }

  return {
    async p18(qid) {
      if (!p18s.has(qid)) {
        const json = await (await request(`${WIKIDATA_API}?action=wbgetclaims&format=json&property=P18&entity=${qid}`)).json();
        if (json.error) throw new Error(`Wikidata: ${json.error.info}`);
        p18s.set(qid, pickP18(json.claims?.P18));
      }
      return p18s.get(qid);
    },

    // 題名が50個で URL に収まらないことがあるので、POST で送る
    async infos(titles) {
      const todo = [...new Set(titles)].filter((t) => !infos.has(t));
      for (let i = 0; i < todo.length; i += BATCH) {
        const batch = todo.slice(i, i + BATCH);
        const body = new URLSearchParams({
          action: 'query', format: 'json', formatversion: '2', redirects: '1', prop: 'imageinfo',
          iiprop: 'url|extmetadata|size|mime|sha1', iiurlwidth: String(THUMB_WIDTH),
          iiextmetadatafilter: 'Artist|Attribution|License|LicenseShortName|LicenseUrl', titles: batch.join('|'),
        });
        const json = await (await request(COMMONS_API, { method: 'POST', body })).json();
        if (json.error) throw new Error(`Commons: ${json.error.info}`);
        const alias = new Map([...(json.query?.normalized ?? []), ...(json.query?.redirects ?? [])].map((x) => [x.from, x.to]));
        const pages = new Map((json.query?.pages ?? []).map((p) => [p.title, p]));
        for (const title of batch) {
          let key = title;
          for (let n = 0; n < 5 && alias.has(key); n += 1) key = alias.get(key);
          const page = pages.get(key);
          infos.set(title, page?.imageinfo?.[0] ? { title: page.title, ...page.imageinfo[0] } : null);
        }
      }
      return infos;
    },

    async download(info, cacheDir) {
      const url = info.thumburl ?? info.url;
      const ext = /\.([a-z0-9]+)$/i.exec(new URL(url).pathname)?.[1].toLowerCase() ?? 'jpg';
      const file = join(cacheDir, `${info.sha1}-${info.thumbwidth ?? 'full'}.${ext}`);
      if (existsSync(file)) return file;
      const res = await request(url);
      const type = res.headers.get('content-type') ?? '';
      if (!type.startsWith('image/')) throw new Error(`${url} が画像ではありません（${type}）`);
      await mkdir(cacheDir, { recursive: true });
      const part = `${file}.${process.pid}.part`;
      await writeFile(part, Buffer.from(await res.arrayBuffer()));
      await rename(part, file);
      return file;
    },
  };
}

// ---------------------------------------------------------------- 画像の加工

async function magick(args) {
  try {
    await execFileAsync('magick', args);
  } catch (e) {
    throw new Error(`magick が失敗しました: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
  }
}

const normalize = (src, dst) => magick([`${src}[0]`, '-auto-orient', '-background', 'white', '-alpha', 'remove', '-alpha', 'off', '-colorspace', 'sRGB', '-quality', '95', dst]);

async function detectFaces(bin, files) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(bin, files, { maxBuffer: 1 << 26 }));
  } catch (e) {
    throw new UserError(`顔の検出（src/faces.swift）が失敗しました: ${String(e.stderr || e.message).trim()}`);
  }
  return new Map(stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).map((r) => [r.file, r]));
}

// .part に書き、[.part, 置き場所] を parts に足す。置き場所への名前の付け替えは、CSV を書いたあとに呼び出し元がする。
// 写真のファイルがあると「取得済み」とみなすので、先に置くと、途中で止まったときに古い出典のまま残る
async function writePhotos(norm, box, dir, dest, parts) {
  // 小さい版の置き場所は build.mjs が README の画像に埋め込むときの規則と同じ
  const outputs = [[join(dir, dest), PHOTO_SIZE], [join(dir, dest.replace(/([^/]+)$/, 'small/$1')), SMALL_SIZE]];
  for (const [out, px] of outputs) {
    await mkdir(dirname(out), { recursive: true });
    const part = `${out}.part.jpg`;
    parts.push([part, out]);
    await magick([norm, '-crop', `${box.size}x${box.size}+${box.x}+${box.y}`, '+repage', '-filter', 'Lanczos', '-resize', `${px}x${px}!`,
      '-strip', '-interlace', 'Plane', '-sampling-factor', '4:2:0', '-quality', String(JPEG_QUALITY), part]);
  }
}

async function prepareTools() {
  if (process.platform !== 'darwin') throw new UserError('photos.mjs は Mac でだけ動きます（顔の検出に Vision を使うため）');
  for (const [cmd, hint] of [['magick', 'ImageMagick（brew install imagemagick）'], ['swiftc', 'Xcode のコマンドラインツール（xcode-select --install）']]) {
    try { await execFileAsync(cmd, ['--version']); } catch { throw new UserError(`${cmd} が見つかりません。${hint}を入れてください`); }
  }
  const work = await mkdtemp(join(tmpdir(), 'chronology-photos-'));
  const faces = join(work, 'faces');
  try {
    await execFileAsync('swiftc', ['-O', join(here, 'src', 'faces.swift'), '-o', faces]);
  } catch (e) {
    throw new UserError(`src/faces.swift をコンパイルできません: ${String(e.stderr || e.message).trim()}`);
  }
  return { work, faces };
}

// ---------------------------------------------------------------- 年表ごとの処理

async function loadDataset(arg) {
  const dir = resolve(arg);
  const label = basename(dir);
  let conf;
  try { conf = JSON.parse(await readFile(join(dir, 'chronology.json'), 'utf8')); } catch { throw new UserError(`${label}/chronology.json を読めません`); }
  // 議席のページのように主な CSV に人物がいない年表は、photos.file に写真用の CSV を書く（列は既定の名前）
  const file = conf.photos?.file ?? conf.data?.file;
  if (!file) throw new UserError(`${label}/chronology.json に data.file（CSV のファイル名）がありません`);
  const columns = conf.photos?.file ? { ...PHOTO_COLUMNS, ...conf.photos.columns } : conf.data.columns;
  const lacking = PHOTO_ROLES.filter((role) => !columns?.[role]);
  if (lacking.length) {
    throw new UserError(`${label}/chronology.json の data.columns に ${lacking.join('・')} がありません（${lacking.map((r) => `"${r}": "${PHOTO_COLUMNS[r]}"`).join('、')} のように足してください）`);
  }
  const cols = { ...DEFAULT_COLUMNS, ...columns };
  const csvFile = join(dir, file);
  const text = await readFile(csvFile, 'utf8');
  const rows = parseCSV(text);
  const header = Object.keys(rows[0] ?? {});
  if (!header.includes('Wikidata')) throw new UserError(`${label}/${file} に Wikidata の列（人物の QID）がありません`);
  return { dir, label, csvFile, text, rows, header, cols };
}

// 写真のある人の、まだ写真のない行に写す。埋まっている欄は書き換えない。書いたら true。CSV に無い列は空とみなす
function fillEmpty(row, cols, values) {
  let changed = false;
  for (const role of PHOTO_ROLES) {
    if ((row[cols[role]] ?? '') === '') { row[cols[role]] = values[role]; changed = true; }
  }
  return changed;
}

// 新しく取った画像の欄。前の画像の出典やライセンスが残らないように、4つとも書き直す。
// 埋まっていて違う値だった欄は replaced に返す（手で直した出典などを、書き換えたと知らせるため）
function setAll(row, cols, values) {
  let changed = false;
  const replaced = [];
  for (const role of PHOTO_ROLES) {
    const old = row[cols[role]] ?? '';
    if (old === values[role]) continue;
    if (old !== '') replaced.push(`${cols[role]}「${old.length > 40 ? `${old.slice(0, 40)}…` : old}」`);
    row[cols[role]] = values[role];
    changed = true;
  }
  return { changed, replaced };
}

// CSV を読み込んで書き直したとき、元のファイルと一字も違わないことを確かめる。違うと、読み込みで落ちる欄
// （引用符のない欄の中のカンマで列の数が合わない行、重複した列名など）が書き直しで消える
function assertRewritable({ label, csvFile, text, rows, header }) {
  const again = serializeCSV(header, rows);
  if (again === text) return;
  const a = text.split('\n');
  const b = again.split('\n');
  let i = 0;
  while (i < a.length && a[i] === b[i]) i += 1;
  throw new UserError(`${label}/${basename(csvFile)} は、読み込んで書き直すと${i + 1}行目から元と違ってしまうので、書き換えません。引用符のない欄の中のカンマ・行ごとに違う列の数・重複した列名・CRLF の改行・末尾の改行がないこと・欄の前後の空白などを直してから、もう一度実行してください`);
}

const safeRelative = (p) => !isAbsolute(p) && !p.split('/').includes('..') && /\.jpe?g$/i.test(p);

async function processDataset(ds, session) {
  const { dir, label, rows, header, cols } = ds;
  const get = (row, role) => row[cols[role]] ?? '';
  const entries = rows.map((row, i) => ({ row, line: i + 2, qid: row.Wikidata, name: row[cols.name], status: '', notes: [], changed: false }));
  const warn = (e, msg) => {
    e.notes.push(msg);
    console.warn(`警告 ${label} ${e.line}行目（${e.name}、${e.qid || 'ID なし'}）: ${msg}`);
  };
  const hasPhoto = (e) => get(e.row, 'photo') !== '' && existsSync(join(dir, get(e.row, 'photo')));
  const fail = (g, msg) => g.pending.forEach((e) => { e.status = '除外'; warn(e, msg); });
  const copyFrom = (donor, e) => {
    const values = Object.fromEntries(PHOTO_ROLES.map((r) => [r, get(donor.row, r)]));
    if (PHOTO_ROLES.some((r) => get(e.row, r) !== '' && get(e.row, r) !== values[r])) {
      e.status = '除外';
      warn(e, `同じ人物の${donor.line}行目と違う写真が指定されています。写真は人物ごとに1枚なので、どちらかの指定を消してください`);
      return;
    }
    e.changed = fillEmpty(e.row, cols, values);
    e.status = '複写';
  };

  const groups = new Map();
  for (const e of entries) {
    if (get(e.row, 'photoUrl') === NO_PHOTO) {
      e.status = '写真なし';
      continue;
    }
    if (!/^Q\d+$/.test(e.qid)) {
      e.status = '除外';
      warn(e, e.qid ? `Wikidata の ID「${e.qid}」が QID（Q と数字）ではありません` : 'Wikidata の ID がありません');
      continue;
    }
    if (!groups.has(e.qid)) groups.set(e.qid, { qid: e.qid, donor: null, pending: [] });
    const g = groups.get(e.qid);
    if (hasPhoto(e)) { e.status = '済み'; g.donor ??= e; } else g.pending.push(e);
  }
  const todo = [...groups.values()].filter((g) => g.pending.length);
  if (!todo.length) return printTable(ds, entries);
  assertRewritable(ds);

  for (const g of todo.filter((x) => x.donor)) g.pending.forEach((e) => copyFrom(g.donor, e));

  const jobs = todo.filter((g) => !g.donor).map((g) => ({ g, lead: g.pending[0], title: '' }));
  if (jobs.length) {
    const tools = await session.tools();
    const attempt = async (job, fn) => { try { await fn(job); } catch (e) { job.error = e.message; } };
    const live = () => jobs.filter((j) => !j.error);

    for (const job of jobs) {
      await attempt(job, async (j) => {
        const page = get(j.lead.row, 'photoUrl');
        const dest = get(j.lead.row, 'photo') || `photos/${j.g.qid}.jpg`;
        if (!safeRelative(dest)) throw new Error(`${cols.photo}「${dest}」は、ディレクトリの中の .jpg を指していません`);
        j.dest = dest;
        if (page) {
          j.title = commonsTitle(page);
          if (!j.title) throw new Error(`${cols.photoUrl}「${page}」から Commons のファイル名を読み取れません`);
        } else {
          const name = await session.commons.p18(j.g.qid);
          if (!name) throw new Error('Wikidata に画像（P18）がありません。写真のページに Commons のファイルを書くと、それを使います');
          j.title = `File:${name}`;
        }
      });
    }

    let infos = new Map();
    try {
      infos = await session.commons.infos(live().map((j) => j.title));
    } catch (e) {
      for (const j of live()) j.error = e.message;
    }

    for (const job of live()) {
      await attempt(job, async (j) => {
        const info = infos.get(j.title);
        if (!info) throw new Error(`Commons に ${j.title} がありません`);
        if (!info.mime?.startsWith('image/')) throw new Error(`${j.title} は画像ではありません（${info.mime}）`);
        if (!info.descriptionurl?.startsWith('https://commons.wikimedia.org/wiki/File:')) throw new Error(`${j.title} のページの URL が読み取れません`);
        const meta = info.extmetadata ?? {};
        const license = classifyLicense({ code: meta.License?.value, shortName: meta.LicenseShortName?.value, url: meta.LicenseUrl?.value });
        if (!license) {
          throw new Error(`${info.title} のライセンス「${meta.LicenseShortName?.value ?? '不明'}」は、自由に使えると確認できません。別の画像を ${cols.photoUrl} に書いてください（${info.descriptionurl}）`);
        }
        j.info = info;
        j.license = license;
        j.author = creditAuthor(meta);
        j.norm = join(tools.work, `${j.g.qid}.jpg`);
        const cached = await session.commons.download(info, session.cacheDir);
        try {
          await normalize(cached, j.norm);
        } catch (e) {
          await rm(cached, { force: true });
          throw e;
        }
      });
    }

    const found = live().length ? await detectFaces(tools.faces, live().map((j) => j.norm)) : new Map();
    for (const job of live()) {
      await attempt(job, async (j) => {
        const result = found.get(j.norm);
        if (!result || result.error) throw new Error(`顔の検出に失敗しました（${result?.error ?? '結果なし'}）`);
        const face = result.faces.reduce((a, b) => (!a || b.h > a.h ? b : a), null);
        const box = cropSquare(face, result.width, result.height);
        if (!face) warn(j.lead, '顔が見つかりません。上の中央を正方形に切り出したので、確認してください');
        if (result.faces.length > 1) warn(j.lead, `顔が${result.faces.length}個見つかりました。いちばん大きい顔で切り出したので、確認してください`);
        if (box.size < PHOTO_SIZE) warn(j.lead, `元の画像が小さく（切り出し${box.size}px）、ぼやけます`);
        if (j.author.length > 60) warn(j.lead, `作者名が長いので、確認してください（${j.author.slice(0, 60)}…）`);
        if (j.author === '作者不明' && !['パブリックドメイン', 'CC0'].includes(j.license.label)) {
          warn(j.lead, '作者が分かりません。表示の要るライセンスなので、画像のページで出所を確かめ、写真の出典を直してください');
        }
        await writePhotos(j.norm, box, dir, j.dest, (j.parts = []));
      });
    }

    for (const j of jobs) {
      if (j.error) { fail(j.g, j.error); continue; }
      const values = { photo: j.dest, photoCredit: `${j.author}・${j.license.label}`, photoUrl: j.info.descriptionurl, photoLicense: j.license.url };
      for (const e of j.g.pending) {
        const { changed, replaced } = setAll(e.row, cols, values);
        e.changed = changed;
        e.status = e === j.lead ? '取得' : '複写';
        if (replaced.length) warn(e, `新しく取った画像に合わせて、${replaced.join('・')}を書き換えました。手で直した値なら、もう一度直してください`);
      }
    }
  }

  const columns = PHOTO_ROLES.map((r) => cols[r]).filter((c) => !header.includes(c));
  if (columns.length || entries.some((e) => e.changed)) {
    const part = `${ds.csvFile}.part`;
    await writeFile(part, serializeCSV([...header, ...columns], rows));
    await rename(part, ds.csvFile);
  }
  for (const j of jobs) {
    for (const [part, out] of j.parts ?? []) {
      if (j.error) await rm(part, { force: true });
      else await rename(part, out);
    }
  }
  printTable(ds, entries);
}

function printTable({ label, cols }, entries) {
  const cell = (s) => String(s ?? '').replaceAll('|', '\\|');
  console.log(`\n### ${label}\n`);
  console.log('| 状態 | QID | 名前 | Commons のファイル | 出典 | 注意 |');
  console.log('|---|---|---|---|---|---|');
  for (const e of entries) {
    const file = commonsTitle(e.row[cols.photoUrl] ?? '') ?? '';
    console.log(`| ${[e.status, e.qid, e.name, file, e.row[cols.photoCredit] ?? '', e.notes.join(' / ')].map(cell).join(' | ')} |`);
  }
}

function createSession() {
  const commons = createCommons();
  let tools;
  return {
    commons,
    cacheDir: join(tmpdir(), 'chronology-photos-cache'),
    async tools() { tools ??= await prepareTools(); return tools; },
    async close() { if (tools) await rm(tools.work, { recursive: true, force: true }); },
  };
}

async function main(args) {
  if (!args.length || args.some((a) => a.startsWith('-'))) {
    console.error('使い方: node photos.mjs <ディレクトリ>...\n年表のディレクトリ（chronology.json のあるところ）を指定します');
    process.exit(2);
  }
  const session = createSession();
  try {
    const datasets = [];
    const problems = [];
    for (const arg of args) {
      try { datasets.push(await loadDataset(arg)); } catch (e) { if (!(e instanceof UserError)) throw e; problems.push(e.message); }
    }
    if (problems.length) throw new UserError(problems.map((p) => `- ${p}`).join('\n'));
    for (const ds of datasets) await processDataset(ds, session);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    await session.close();
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main(process.argv.slice(2));
