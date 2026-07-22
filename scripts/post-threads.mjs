// 新着記事をThreadsに自動投稿する (ローカルのスケジュール実行から呼ばれる)
// 使い方: node scripts/post-threads.mjs articles/2026-07-23-daily.md
// 認証情報は .secrets.json (gitignore済み・このPCにのみ保存) から読む。
// 未設定なら何もせず正常終了する。トークンの延長(60日期限)は自動で行う。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRETS_PATH = join(ROOT, '.secrets.json');
const API = 'https://graph.threads.net';

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
const get = async (url) => {
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok) throw new Error(`${url.split('?')[0]} failed: ${JSON.stringify(j.error || j)}`);
  return j;
};

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

// ---- 投稿(コンテナ作成 → 公開) ----
const post = async (path, params) => {
  const r = await fetch(`${API}/v1.0/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, access_token: t.token }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path} failed: ${JSON.stringify(j.error || j)}`);
  return j;
};

for (const p of posts) {
  let body = p.body.trim();
  if ([...body].length > 440) body = [...body].slice(0, 439).join('') + '…';
  const text = `${body}\n${url}`;
  const container = await post(`${t.userId}/threads`, { media_type: 'TEXT', text });
  let published;
  try {
    published = await post(`${t.userId}/threads_publish`, { creation_id: container.id });
  } catch {
    await new Promise(res => setTimeout(res, 5000)); // 処理待ちで失敗することがあるため1回だけ再試行
    published = await post(`${t.userId}/threads_publish`, { creation_id: container.id });
  }
  try {
    const info = await get(`${API}/v1.0/${published.id}?fields=permalink&access_token=${t.token}`);
    console.log(`✅ Threadsに投稿しました(${p.lang}): ${info.permalink}`);
  } catch {
    console.log(`✅ Threadsに投稿しました(${p.lang}): media_id=${published.id}`);
  }
  await new Promise(r => setTimeout(r, 3000));
}
