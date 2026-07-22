// AIデイリー 静的サイトジェネレーター
// articles/*.md と pages/*.md を dist/ のフラットなHTMLに変換する。
// 内部リンクはすべて相対パスなので、github.io のサブパスでも独自ドメインでも動く。
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');
const site = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));
const ads = JSON.parse(readFileSync(join(ROOT, 'config', 'ads.json'), 'utf8'));

marked.setOptions({ gfm: true });

const CATEGORY = {
  news: { label: '市況・ニュース', cls: 'cat-news' },
  guide: { label: '投資入門', cls: 'cat-guide' },
  column: { label: 'コラム', cls: 'cat-tools' },
};

const esc = (s = '') =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: raw.slice(m[0].length) };
}

function fmtDate(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const w = ['日', '月', '火', '水', '木', '金', '土'][d.getUTCDay()];
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日(${w})`;
}

function adSlot(html) {
  if (!html || !html.trim()) return '';
  return `<aside class="ad-slot"><span class="ad-label">スポンサーリンク</span>${html}</aside>`;
}

// ---- 記事の読み込み ----
function loadDir(dir) {
  const full = join(ROOT, dir);
  let files = [];
  try { files = readdirSync(full).filter(f => f.endsWith('.md')); } catch { return []; }
  return files.map(f => {
    const { meta, body } = parseFrontmatter(readFileSync(join(full, f), 'utf8'));
    return {
      slug: f.replace(/\.md$/, ''),
      title: meta.title || f,
      date: meta.date || '',
      category: meta.category || 'news',
      description: meta.description || '',
      tags: (meta.tags || '').split(',').map(t => t.trim()).filter(Boolean),
      html: marked.parse(body),
    };
  });
}

const articles = loadDir('articles').sort((a, b) => (a.date < b.date ? 1 : -1));
const pages = loadDir('pages');
const url = slug => `${site.url}/${slug}.html`;

// ---- 共通レイアウト ----
const FAVICON =
  'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>📈</text></svg>';

function layout({ title, description, pageUrl, body, jsonld = '', ogType = 'website' }) {
  return `<!DOCTYPE html>
<html lang="${site.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${pageUrl}">
<meta property="og:site_name" content="${esc(site.title)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="${ogType}">
<meta property="og:url" content="${pageUrl}">
<meta name="twitter:card" content="summary">
<link rel="icon" href="${FAVICON}">
<link rel="alternate" type="application/rss+xml" title="${esc(site.title)}" href="./feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="./styles.css">
${jsonld}
</head>
<body>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="./index.html">📈 ${esc(site.title)}</a>
    <nav class="nav">
      <a href="./index.html">ホーム</a>
      <a href="./news.html">市況・ニュース</a>
      <a href="./guides.html">入門・コラム</a>
      <a href="./about.html">サイトについて</a>
    </nav>
  </div>
</header>
<main class="wrap">
${body}
</main>
<footer class="site-footer">
  <div class="wrap">
    ${adSlot(ads.footer_banner)}
    <p class="footer-note">本サイトはプロモーション(広告・アフィリエイトリンク)を含みます。掲載情報は情報提供を目的としたものであり、投資助言ではありません。投資判断はご自身の責任でお願いします。</p>
    <nav class="footer-nav">
      <a href="./about.html">サイトについて</a>
      <a href="./privacy.html">プライバシーポリシー</a>
      <a href="./contact.html">お問い合わせ</a>
      <a href="./feed.xml">RSS</a>
      ${site.bluesky ? `<a rel="me" target="_blank" href="https://bsky.app/profile/${site.bluesky}">Bluesky</a>` : ''}
    </nav>
    <p class="copyright">© 2026 ${esc(site.title)}</p>
  </div>
</footer>
</body>
</html>`;
}

// ---- 記事カード ----
function card(a, big = false) {
  const cat = CATEGORY[a.category] || CATEGORY.news;
  return `<a class="card${big ? ' card-big' : ''}" href="./${a.slug}.html">
  <div class="card-meta"><span class="chip ${cat.cls}">${cat.label}</span><time datetime="${a.date}">${fmtDate(a.date)}</time></div>
  <h3 class="card-title">${esc(a.title)}</h3>
  <p class="card-desc">${esc(a.description)}</p>
</a>`;
}

// ---- 記事ページ ----
function articlePage(a, i) {
  const cat = CATEGORY[a.category] || CATEGORY.news;
  const prev = articles[i + 1];
  const next = articles[i - 1];
  const share = encodeURIComponent(`${a.title} | ${site.title}`);
  const shareUrl = encodeURIComponent(url(a.slug));
  const jsonld = `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: a.title,
    description: a.description,
    datePublished: a.date,
    inLanguage: 'ja',
    author: { '@type': 'Organization', name: site.author },
    mainEntityOfPage: url(a.slug),
  })}</script>`;
  const body = `<article class="article">
  <div class="card-meta"><span class="chip ${cat.cls}">${cat.label}</span><time datetime="${a.date}">${fmtDate(a.date)}</time></div>
  <h1>${esc(a.title)}</h1>
  <p class="pr-note">※本記事にはアフィリエイト広告(PR)を含む場合があります。</p>
  ${adSlot(ads.article_top)}
  <div class="article-body">
${a.html}
  </div>
  <div class="disclaimer">※本記事は情報提供を目的としたものであり、特定の金融商品の売買を推奨するものではありません。掲載データの正確性は保証されません。投資に関する最終決定はご自身の判断と責任で行ってください。</div>
  ${adSlot(ads.article_bottom)}
  <div class="share">
    <span>この記事をシェア:</span>
    <a rel="nofollow noopener" target="_blank" href="https://twitter.com/intent/tweet?text=${share}&url=${shareUrl}">X</a>
    <a rel="nofollow noopener" target="_blank" href="https://bsky.app/intent/compose?text=${share}%20${shareUrl}">Bluesky</a>
    <a rel="nofollow noopener" target="_blank" href="https://b.hatena.ne.jp/entry/${url(a.slug).replace(/^https?:\/\//, '')}">はてブ</a>
    <a rel="nofollow noopener" target="_blank" href="https://social-plugins.line.me/lineit/share?url=${shareUrl}">LINE</a>
  </div>
  <nav class="prevnext">
    ${next ? `<a class="pn pn-next" href="./${next.slug}.html">← 新しい記事<span>${esc(next.title)}</span></a>` : '<span></span>'}
    ${prev ? `<a class="pn pn-prev" href="./${prev.slug}.html">古い記事 →<span>${esc(prev.title)}</span></a>` : '<span></span>'}
  </nav>
</article>`;
  return layout({ title: `${a.title} | ${site.title}`, description: a.description, pageUrl: url(a.slug), body, jsonld, ogType: 'article' });
}

// ---- 一覧ページ ----
function listPage(items, heading, lead, slug) {
  const body = `<section class="list-page">
  <h1>${esc(heading)}</h1>
  <p class="lead">${esc(lead)}</p>
  <div class="grid">${items.map(a => card(a)).join('\n')}</div>
</section>`;
  return layout({ title: `${heading} | ${site.title}`, description: lead, pageUrl: url(slug), body });
}

// ---- トップページ ----
function indexPage() {
  const [hero, ...rest] = articles;
  const guides = articles.filter(a => a.category !== 'news').slice(0, 6);
  const recent = rest.filter(a => a.category === 'news').slice(0, 8);
  const jsonld = `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: site.title,
    description: site.description,
    url: site.url,
    inLanguage: 'ja',
  })}</script>`;
  const body = `<section class="hero">
  <h1>${esc(site.tagline)}</h1>
  <p class="lead">${esc(site.description)}</p>
</section>
${hero ? `<section><h2 class="sec-title">最新の記事</h2><div class="grid grid-hero">${card(hero, true)}</div></section>` : ''}
${recent.length ? `<section><h2 class="sec-title">最新の市況・ニュース</h2><div class="grid">${recent.map(a => card(a)).join('\n')}</div><p class="more"><a href="./news.html">市況・ニュース一覧へ →</a></p></section>` : ''}
${guides.length ? `<section><h2 class="sec-title">投資入門・コラム</h2><div class="grid">${guides.map(a => card(a)).join('\n')}</div><p class="more"><a href="./guides.html">入門・コラム一覧へ →</a></p></section>` : ''}`;
  return layout({ title: `${site.title} — ${site.tagline}`, description: site.description, pageUrl: `${site.url}/`, body, jsonld });
}

// ---- 固定ページ ----
function staticPage(p) {
  const body = `<article class="article"><h1>${esc(p.title)}</h1><div class="article-body">${p.html}</div></article>`;
  return layout({ title: `${p.title} | ${site.title}`, description: p.description || site.description, pageUrl: url(p.slug), body });
}

// ---- RSS / sitemap / robots ----
function rss() {
  const items = articles.slice(0, 20).map(a => `  <item>
    <title>${esc(a.title)}</title>
    <link>${url(a.slug)}</link>
    <guid>${url(a.slug)}</guid>
    <pubDate>${new Date(a.date + 'T07:00:00+09:00').toUTCString()}</pubDate>
    <description>${esc(a.description)}</description>
  </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>${esc(site.title)}</title>
  <link>${site.url}/</link>
  <description>${esc(site.description)}</description>
  <language>ja</language>
${items}
</channel></rss>`;
}

function sitemap() {
  const urls = [
    `${site.url}/`,
    ...['news', 'guides', 'about', 'privacy', 'contact'].map(s => url(s)),
    ...articles.map(a => url(a.slug)),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${u}</loc></url>`).join('\n')}
</urlset>`;
}

// ---- 出力 ----
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
copyFileSync(join(ROOT, 'src', 'styles.css'), join(DIST, 'styles.css'));

writeFileSync(join(DIST, 'index.html'), indexPage());
writeFileSync(join(DIST, 'news.html'), listPage(articles.filter(a => a.category === 'news'), '市況・ニュース一覧', '東京市場・米国市場の動きを1日3回お届けしています。', 'news'));
writeFileSync(join(DIST, 'guides.html'), listPage(articles.filter(a => a.category !== 'news'), '投資入門・コラム一覧', 'はじめての人向けのやさしい解説と読み物です。', 'guides'));
articles.forEach((a, i) => writeFileSync(join(DIST, `${a.slug}.html`), articlePage(a, i)));
pages.forEach(p => writeFileSync(join(DIST, `${p.slug}.html`), staticPage(p)));
writeFileSync(join(DIST, 'feed.xml'), rss());
writeFileSync(join(DIST, 'sitemap.xml'), sitemap());
writeFileSync(join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${site.url}/sitemap.xml\n`);
writeFileSync(join(DIST, '404.html'), layout({ title: `ページが見つかりません | ${site.title}`, description: site.description, pageUrl: site.url, body: '<section class="hero"><h1>404 — ページが見つかりません</h1><p class="lead"><a href="./index.html">トップページへ戻る</a></p></section>' }));
if (articles[0]) {
  writeFileSync(join(DIST, 'latest.json'), JSON.stringify({
    slug: articles[0].slug, title: articles[0].title, description: articles[0].description,
    date: articles[0].date, url: url(articles[0].slug),
  }, null, 2));
}

console.log(`✅ build完了: 記事${articles.length}本 / 固定ページ${pages.length}本 → dist/`);
