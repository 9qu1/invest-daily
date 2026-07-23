// 新着記事をThreadsに自動投稿する (ローカルのスケジュール実行から呼ばれる)
// 使い方: node scripts/post-threads.mjs articles/2026-07-23-daily.md
// 認証情報は .secrets.json (gitignore済み・このPCにのみ保存) から読む。
// 未設定なら何もせず正常終了する。トークンの延長(60日期限)は自動で行う。
//
// Meta側の一時的なブロック(「API access blocked」等)対策:
//   - 一時エラーは指数バックオフ付きで自動リトライする
//   - コンテナ作成 → 公開 の間と、日本語 → 英語 の間に十分な間隔を空ける
//   - 投稿済みの記事×言語は .sns-posted.json に記録し、再実行時に二重投稿しない
//     (同じ文面の連投はMeta側のスパム判定を招くため)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRETS_PATH = join(ROOT, '.secrets.json');
const STATE_PATH = join(ROOT, '.sns-posted.json');
const API = 'https://graph.threads.net';

// 投稿ペース(ミリ秒)。Metaは短時間の連続投稿をスパムとみなすことがあるため広めに取る。
const WAIT_BEFORE_PUBLISH = 25_000; // コンテナ作成後、公開までの待ち時間
const WAIT_BETWEEN_POSTS = 90_000; // 1本目と2本目の投稿の間隔(±ジッター)
const RETRY_DELAYS = [10_000, 45_000, 150_000, 420_000]; // 一時エラー時のバックオフ

if (!existsSync(SECRETS_PATH)) {
  console.log('.secrets.json が無いためThreads投稿をスキップします');
  process.exit(0);
}
const secrets = JSON.parse(readFileSync(SECRETS_PATH, 'utf8'));
const t = secrets.threads;
if (!t || !t.token || /ここに|PASTE/i.test(t.token)) {
  console.log('Threadsトークン未設定のためスキップします');
  process.exit(0);
}

const mdPath = process.argv[2];
if (!mdPath) { console.error('記事ファイルを指定してください'); process.exit(1); }

const save = () => writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2));
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
// 機械的に等間隔で叩かないよう、待ち時間に±20%のゆらぎを持たせる
const jitter = (ms) => Math.round(ms * (0.8 + Math.random() * 0.4));

// ---- 一時的な失敗の判定とリトライ ----
// 恒久的な設定ミス(権限不足・トークン失効など)まで待たされないよう、
// レート制限や一時ブロックに該当するものだけを再試行する。
const RATE_LIMIT_CODES = new Set([1, 2, 4, 17, 32, 341, 368, 613]);
function isTransient(err) {
  if (err.status >= 500 || err.status === 429) return true;
  if (RATE_LIMIT_CODES.has(err.code)) return true;
  // code 200 は権限エラー全般だが、「API access blocked」は一時的なブロック
  if (err.code === 200 && /blocked|temporar|rate|limit|try again/i.test(err.message)) return true;
  return false;
}

async function request(label, run) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (!isTransient(err) || attempt >= RETRY_DELAYS.length) throw err;
      const wait = jitter(RETRY_DELAYS[attempt]);
      console.log(`⏳ ${label} が一時エラー(${err.message})。${Math.round(wait / 1000)}秒待って再試行します(${attempt + 1}/${RETRY_DELAYS.length})`);
      await sleep(wait);
    }
  }
}

function apiError(label, status, json) {
  const e = json.error || json || {};
  const err = new Error(`${label} failed: ${JSON.stringify(e)}`);
  err.status = status;
  err.code = e.code;
  return err;
}

const get = (url) => request(url.split('?')[0], async () => {
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok) throw apiError(url.split('?')[0], r.status, j);
  return j;
});

const post = (path, params) => request(path, async () => {
  const r = await fetch(`${API}/v1.0/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, access_token: t.token }),
  });
  const j = await r.json();
  if (!r.ok) throw apiError(path, r.status, j);
  return j;
});

// ---- トークンを長期トークンとして維持する ----
const DAY = 24 * 60 * 60 * 1000;
async function ensureToken() {
  const age = t.refreshedAt ? Date.now() - new Date(t.refreshedAt).getTime() : Infinity;
  if (age < 7 * DAY) return; // 7日以内に更新済みなら何もしない
  try {
    // 長期トークンの延長(取得から24時間経過後に可能。新たに60日有効になる)
    const j = await get(`${API}/refresh_access_token?grant_type=th_refresh_token&access_token=${t.token}`);
    t.token = j.access_token;
    t.refreshedAt = new Date().toISOString();
    save();
    console.log('トークンを延長しました(60日)');
  } catch (e) {
    if (t.appSecret && !/ここに/.test(t.appSecret)) {
      // 短期トークンが貼られた初回: 長期トークンに交換する
      try {
        const j = await get(`${API}/access_token?grant_type=th_exchange_token&client_secret=${t.appSecret}&access_token=${t.token}`);
        t.token = j.access_token;
        t.refreshedAt = new Date().toISOString();
        save();
        console.log('短期トークンを長期トークン(60日)に交換しました');
      } catch {
        // 発行直後(24時間未満)の長期トークンは延長も交換もできないが、投稿には使える
        if (!t.refreshedAt) console.log('トークンをそのまま使用します(延長は後日自動実行)');
        else throw e;
      }
    } else if (!t.refreshedAt) {
      console.log('トークン延長は24時間経過後に自動実行します');
    } else {
      throw e;
    }
  }
}

await ensureToken();

// ユーザーIDを取得(初回のみAPIで解決してキャッシュ)
if (!t.userId) {
  const j = await get(`${API}/v1.0/me?fields=id,username&access_token=${t.token}`);
  t.userId = j.id;
  save();
  console.log(`Threadsユーザー確認: @${j.username}`);
}

// ---- 記事情報から投稿文を作る ----
const site = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));
const raw = readFileSync(join(ROOT, mdPath), 'utf8');
const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
const meta = {};
if (fm) for (const line of fm[1].split(/\r?\n/)) {
  const i = line.indexOf(':');
  if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const slug = basename(mdPath).replace(/\.md$/, '');
const url = `${site.url}/${slug}.html`;

// 投稿文: <記事名>.sns.json (ペルソナ文体・日英) があればそれを使い、無ければタイトル+説明文
const posts = [];
const sidecarPath = join(ROOT, mdPath.replace(/\.md$/, '.sns.json'));
if (existsSync(sidecarPath)) {
  const s = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  if (s.ja) posts.push({ body: s.ja, lang: 'ja' });
  if (s.en) posts.push({ body: s.en, lang: 'en' });
}
if (!posts.length) {
  let desc = meta.description || '';
  const fixedLen = `【${meta.title}】\n\n`.length;
  if (fixedLen + desc.length > 440) desc = desc.slice(0, 439 - fixedLen) + '…';
  posts.push({ body: `【${meta.title}】\n\n${desc}`, lang: 'ja' });
}

// ---- 二重投稿の防止 ----
// 途中で失敗した回の再実行で、成功済みの分をもう一度投げないようにする。
const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {};
const done = state.threads || (state.threads = {});
const saveState = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

// ---- 投稿(コンテナ作成 → 公開) ----
let failed = 0;
let posted = 0;
for (const p of posts) {
  const key = `${slug}:${p.lang}`;
  if (done[key]) {
    console.log(`⏭  投稿済みのためスキップします(${p.lang}): ${done[key].permalink || done[key].id}`);
    continue;
  }
  if (posted > 0) {
    const wait = jitter(WAIT_BETWEEN_POSTS);
    console.log(`次の投稿まで${Math.round(wait / 1000)}秒待ちます`);
    await sleep(wait);
  }

  let body = p.body.trim();
  if ([...body].length > 440) body = [...body].slice(0, 439).join('') + '…';
  const text = `${body}\n${url}`;

  try {
    const container = await post(`${t.userId}/threads`, { media_type: 'TEXT', text });
    // コンテナはサーバー側の処理完了を待ってから公開する(直後だと失敗しやすい)
    await sleep(WAIT_BEFORE_PUBLISH);
    const published = await post(`${t.userId}/threads_publish`, { creation_id: container.id });
    posted++;

    let permalink = null;
    try {
      const info = await get(`${API}/v1.0/${published.id}?fields=permalink&access_token=${t.token}`);
      permalink = info.permalink;
    } catch { /* パーマリンクが取れなくても投稿自体は成功している */ }
    done[key] = { id: published.id, permalink, at: new Date().toISOString() };
    saveState();
    console.log(`✅ Threadsに投稿しました(${p.lang}): ${permalink || `media_id=${published.id}`}`);
  } catch (err) {
    // 1本失敗しても残りは試す。成功分は記録済みなので再実行しても重複しない。
    failed++;
    console.error(`❌ Threads投稿に失敗しました(${p.lang}): ${err.message}`);
  }
}

if (failed) {
  console.error(`Threads: ${failed}件が未投稿です。時間をおいて同じコマンドを再実行してください(成功分はスキップされます)。`);
  process.exit(1);
}
