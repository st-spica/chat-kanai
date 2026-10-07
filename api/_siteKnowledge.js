/**
 * 当院サイトの HTML を取得してテキスト化する。
 * - 既定: 最新 sitemap（Yoast の sitemap_index.xml）から URL を収集
 * - SITE_PREFER_URL_LIST=true のときのみ SITE_URL_LIST を優先（旧URL固定を避けるため既定オフ）
 * - 本文は既定で毎回最新取得（SITE_KNOWLEDGE_CACHE_BODIES=true のときだけ短時間キャッシュ）
 * - sitemap の URL 一覧だけ短時間キャッシュ（SITE_URL_LIST_TTL_MS）
 */

import { Redis } from "@upstash/redis";

// v5: 本文は毎リクエスト最新取得が既定。旧 Redis 本文キャッシュは使わない
const REDIS_KEY = "chat:site-knowledge:v5";

// 質問ごとに関連度の高いページを最新取得する件数（未設定時 16）
const DEFAULT_MAX_PAGES = parseInt(process.env.SITE_FETCH_MAX_PAGES || "16", 10);
const DEFAULT_MAX_CHARS = parseInt(process.env.SITE_MAX_CHARS_PER_PAGE || "3000", 10);
/** 1リクエストあたりプロンプトに載せる関連チャンク数（小さいほど入力が軽く速い） */
const SNIPPET_TOP_CHUNKS = Math.min(
  10,
  Math.max(1, parseInt(process.env.SITE_SNIPPET_TOP_CHUNKS || "2", 10))
);
/** 参照チップを出す最低スコア（症状語の部分一致だけでは出さない） */
const REFERENCE_CHIP_MIN_SCORE = Math.max(
  1,
  Math.min(500, parseInt(process.env.REFERENCE_CHIP_MIN_SCORE || "10", 10) || 10)
);

/** 2 文字でも院内案内として意味が強い語だけチップ用スコアに使う（「痛い」等は含めない） */
const FACILITY_2CHAR = new Set([
  "料金",
  "費用",
  "金額",
  "時間",
  "予約",
  "診療",
  "受付",
  "初診",
  "再診",
  "外来",
  "妊娠",
  "分娩",
  "出産",
  "産科",
  "婦人",
  "帝王",
  "駐車",
  "住所",
  "番号",
  "電話",
  "地図",
  "休診",
  "夜診",
  "日曜",
  "祝日",
  "教室",
  "面会",
  "入院",
  "個室",
  "里帰",
  "健診",
  "検診",
  "産前",
  "産後",
  "母乳",
  "妊婦",
  "来院",
  "支払",
  "予納",
  "土曜",
  "面談",
]);
// 本文キャッシュを使うときのみ有効（既定オフ＝毎回最新HTML）
const CACHE_BODIES = ["true", "1", "yes"].includes(
  String(process.env.SITE_KNOWLEDGE_CACHE_BODIES || "false").toLowerCase().trim()
);
// 本文キャッシュ利用時の TTL（既定15分）。SITE_KNOWLEDGE_TTL_MS で上書き可
const DEFAULT_TTL_MS = parseInt(
  process.env.SITE_KNOWLEDGE_TTL_MS || String(15 * 60 * 1000),
  10
);
// sitemap URL一覧の TTL（本文とは別。既定30分）
const URL_LIST_TTL_MS = parseInt(
  process.env.SITE_URL_LIST_TTL_MS || String(30 * 60 * 1000),
  10
);
const FETCH_TIMEOUT_MS = parseInt(process.env.SITE_FETCH_TIMEOUT_MS || "8000", 10);
const MAX_SITEMAP_URLS = parseInt(process.env.SITE_SITEMAP_MAX_URLS || "300", 10);

/** sitemap 由来の許可パス（ハッシュ除く）。チップURL検証用 */
let sitemapAllowCache = {
  at: 0,
  /** @type {Set<string>|null} */
  paths: null,
  entryUrl: "",
  error: null,
};
let sitemapAllowInflight = null;

let memoryCache = {
  at: 0,
  chunks: [],
  referenceUrls: [],
  knowledgeText: "",
  error: null,
  /** @type {"url_list"|"sitemap"|null} */
  fetchMode: null,
};

let inflight = null;

/** sitemap 等の URL 一覧キャッシュ（本文は含めない） */
let urlListCache = {
  at: 0,
  urls: /** @type {string[]} */ ([]),
  /** @type {"url_list"|"sitemap"|null} */
  fetchMode: null,
  error: null,
};
let urlListInflight = null;

/** 面会・立ち会いなど単一ページのメモリキャッシュ（URL → { at, chunk }）※CACHE_BODIES時のみ） */
const singlePageCache = new Map();
let singlePageInflight = new Map();

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function allowedHost(hostname) {
  return hostname === "www.kanai.or.jp" || hostname === "kanai.or.jp";
}

function isSkippableUrl(u) {
  const s = String(u || "");
  // 新サイトに FAQ ページは存在しない
  if (/\/qa(?:\/|$|[?#])/i.test(s)) return true;
  return /\.(xml|jpg|jpeg|png|gif|webp|svg|ico|pdf|zip|css|js|woff2?|ttf|eot)(\?|$)/i.test(s);
}

/** 質問に依存しないベース優先度（取得候補の並び用） */
function urlPriority(u) {
  let s = 0;
  if (/\/beginner|\/lesson|\/obstetrics|\/gynecology|\/restaurant|\/about|\/aftersupport/i.test(u)) s += 8;
  if (/\/obstetrics\/vaccine|\/prevention\b/i.test(u)) s += 4;
  if (/\/news|\/info|\/column/i.test(u)) s += 3;
  return s;
}

/**
 * 質問と URL の対応付けボーナス／ペナルティ。
 * 共通ナビに「子宮がん検診」「ワクチン」と書いてある他ページへの誤ヒットを抑える。
 */
function queryPathBoost(userMessage, url) {
  const msg = String(userMessage || "");
  const u = String(url || "");
  let b = 0;
  if (/子宮頸がん|子宮がん検診|婦人科検診|婦人科疾患|コルポ/i.test(msg) && /\/gynecology/i.test(u)) b += 240;
  if (
    /インフルエンザ|インフル|ワクチン|予防接種|アブリスボ|RSウイルス|RS\s*ウイルス/i.test(msg) &&
    /\/obstetrics\/vaccine|\/prevention\b/i.test(u)
  ) {
    b += 240;
  }
  if (/産後ケア|産後サポート|母乳ケア|アフター/i.test(msg) && /\/aftersupport/i.test(u)) b += 240;
  if (/産後ケア|産後サポート|母乳ケア/i.test(msg) && /\/vaccine|\/prevention\b/i.test(u)) b -= 200;
  if (/妊婦健診|妊婦検/i.test(msg) && /\/obstetrics\/checkup/i.test(u)) b += 240;
  if (/子宮頸がん|子宮がん検診|婦人科検診/i.test(msg) && /\/obstetrics\//i.test(u)) b -= 120;
  // 具体トピックなのに about / トップ寄りのページが勝たないように
  if (
    /子宮頸|子宮がん|ワクチン|インフルエンザ|検診|健診|分娩|面会|産後|立ち会い/i.test(msg) &&
    /\/about(\/|$)/i.test(u)
  ) {
    b -= 100;
  }
  // 「検診」質問でワクチンページを出さない（ナビに検診リンクがあるだけ）
  if (/検診|健診/i.test(msg) && !/ワクチン|予防接種|インフルエンザ|アブリスボ|RS/i.test(msg) && /\/vaccine/i.test(u)) {
    b -= 200;
  }
  // 「ワクチン」質問で婦人科検診本文ページを優先しすぎない（必要ならワクチンURLが勝つ）
  if (/ワクチン|予防接種|インフルエンザ/i.test(msg) && !/検診|健診/i.test(msg) && /\/gynecology/i.test(u)) {
    b -= 80;
  }
  return b;
}

/** 共通ヘッダー／グローバルナビを除いた本文寄りのテキスト（スコア用） */
function contentBodyForScoring(c) {
  const text = String(c?.text || "");
  if (!text) return "";
  const label = String(labelForKnowledgeChunk(c) || "").trim();
  if (label.length >= 2) {
    const first = text.indexOf(label);
    if (first >= 0) {
      const second = text.indexOf(label, first + label.length);
      if (second >= 0 && second < text.length - 80) return text.slice(second);
    }
  }
  // 先頭の共通ナビ想定領域を落とす
  return text.length > 1100 ? text.slice(1000) : text;
}

/**
 * Vercel の SITE_URL_LIST に登録した URL のみ取得する（sitemap 不要・速い）
 * 区切り: 改行 / カンマ / |
 */
function parseRegisteredUrlList() {
  const raw = (process.env.SITE_URL_LIST || "").trim();
  if (!raw) return [];

  const parts = raw
    .split(/[\n\r|,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const out = [];
  for (const p of parts) {
    if (!/^https?:\/\//i.test(p)) continue;
    try {
      const { hostname } = new URL(p);
      if (!allowedHost(hostname)) continue;
      if (isSkippableUrl(p)) continue;
      out.push(p);
    } catch {
      /* skip */
    }
  }
  return [...new Set(out)];
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      cache: "no-store",
      headers: {
        "User-Agent": "KanaiHospitalChat/1.0 (+https://www.kanai.or.jp/)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

function extractLocs(xml) {
  const urls = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) {
    urls.push(m[1].trim());
  }
  return urls;
}

function isSitemapIndex(xml) {
  return /<sitemapindex/i.test(xml);
}

async function collectAllPageUrls(entrySitemapUrl) {
  const rootXml = await fetchText(entrySitemapUrl);
  const locs = extractLocs(rootXml);

  if (isSitemapIndex(rootXml)) {
    const pageUrls = [];
    const childSitemaps = locs.filter((u) => /\.xml(\?|$)/i.test(u));
    for (const child of childSitemaps) {
      if (pageUrls.length >= MAX_SITEMAP_URLS) break;
      try {
        const childXml = await fetchText(child);
        pageUrls.push(...extractLocs(childXml));
      } catch (e) {
        console.error("child sitemap fetch failed:", child, e?.message || e);
      }
    }
    return [...new Set(pageUrls)];
  }

  return [...new Set(locs)];
}

function filterAndRankUrls(rawUrls, maxPages) {
  const filtered = [];
  for (const u of rawUrls) {
    if (filtered.length >= MAX_SITEMAP_URLS) break;
    try {
      const parsed = new URL(u);
      if (!allowedHost(parsed.hostname)) continue;
      if (isSkippableUrl(u)) continue;
      if (!/^https?:\/\//i.test(u)) continue;
      filtered.push(u);
    } catch {
      /* skip */
    }
  }

  const uniq = [...new Set(filtered)];
  uniq.sort((a, b) => urlPriority(b) - urlPriority(a));
  return uniq.slice(0, maxPages);
}

function htmlToText(html) {
  return html
    // HTMLコメントを先に除去して、非表示の注釈・旧文言を学習対象から外す
    .replace(/<!--[\s\S]*?-->/g, " ")
    // 古いIE向け条件付きコメントも除去
    .replace(/<!\[if[\s\S]*?<!\[endif\]>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchPageChunk(url, maxChars) {
  try {
    const html = await fetchText(url);
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : url;
    const text = htmlToText(html).slice(0, maxChars);
    if (!text || text.length < 40) return null;
    return { url, title, text };
  } catch (e) {
    console.error("page fetch failed:", url, e?.message || e);
    return null;
  }
}

function buildFullKnowledgeText(chunks) {
  if (!chunks.length) {
    return "【当院サイト】\n- ページ本文の取得に失敗したか、対象URLがありませんでした。";
  }
  return (
    `【当院公式サイトから取得した抜粋（参考。最新・詳細は必ず各ページでご確認ください）】\n\n` +
    chunks.map((c) => `【${c.title}】\nURL: ${c.url}\n${c.text}`).join("\n\n---\n\n")
  );
}

/** 「面会」「立ち会い」など特定ワード含む発話では、対応ページだけを取得して回答する */
export const MEETING_INFO_PAGE_URL =
  "https://kanai.or.jp/obstetrics/hospitalization/#visit";
export const ATTEND_INFO_PAGE_URL =
  "https://kanai.or.jp/obstetrics/childbirth/#assist_birth";

/**
 * 旧サイトURLを現行URLへ置換（404チップ防止）
 * @param {string} url
 * @returns {string}
 */
export function rewriteLegacyKanaiUrl(url) {
  let u = String(url || "").trim();
  if (!u) return "";
  u = u.replace(/^https?:\/\/www\.kanai\.or\.jp/i, "https://kanai.or.jp");
  if (/\/news\/meeting\.php/i.test(u)) return MEETING_INFO_PAGE_URL;
  if (/\/news\/attend\.php/i.test(u)) return ATTEND_INFO_PAGE_URL;
  if (/\/aftercare\/?/i.test(u)) return "https://kanai.or.jp/aftersupport/#aftercare";
  if (/\/visit\/?/i.test(u)) return "https://kanai.or.jp/beginner/";
  if (/\/obstetrics\/2\/?/i.test(u)) return "https://kanai.or.jp/obstetrics/childbirth/";
  if (/\/obstetrics\/1\/?/i.test(u)) return "https://kanai.or.jp/obstetrics/checkup/";
  if (/\/lesson\/[12]\/?/i.test(u)) return "https://kanai.or.jp/lesson/";
  if (/\/news\/rs_virus\.php/i.test(u)) return "https://kanai.or.jp/news/";
  // 新サイトに FAQ（/qa/）ページは存在しない → 参照リンクに使わない
  if (/\/qa(?:\/|$|[?#])/i.test(u)) return "";
  return u;
}

export function isMeetingFocusedQuery(userMessage) {
  return /面会/.test(String(userMessage || "").trim());
}

export function isAttendFocusedQuery(userMessage) {
  return /立ち会い/.test(String(userMessage || "").trim());
}

async function ensureCachedSinglePage(url) {
  if (!CACHE_BODIES) {
    return fetchPageChunk(url, DEFAULT_MAX_CHARS);
  }
  const now = Date.now();
  const cached = singlePageCache.get(url);
  if (cached && now - cached.at < DEFAULT_TTL_MS) {
    return cached.chunk;
  }

  let pending = singlePageInflight.get(url);
  if (!pending) {
    pending = fetchPageChunk(url, DEFAULT_MAX_CHARS).finally(() => {
      singlePageInflight.delete(url);
    });
    singlePageInflight.set(url, pending);
  }

  const chunk = await pending;
  if (chunk) {
    singlePageCache.set(url, { at: Date.now(), chunk });
  }
  return chunk;
}

function buildSinglePageState(url, title, fetchMode, flagKey) {
  return async () => {
    const chunk = await ensureCachedSinglePage(url);
    const chunks = chunk ? [chunk] : [];
    return {
      chunks,
      referenceUrls: [],
      knowledgeText: chunks.length
        ? buildFullKnowledgeText(chunks)
        : `【${title}】\n${url} の本文を取得できませんでした。ブラウザで直接ご確認ください。`,
      error: chunks.length ? null : `${fetchMode}_failed`,
      fetchMode,
      [flagKey]: true,
      singlePageOnly: true,
      singlePageTitle: title,
      singlePageUrl: url,
    };
  };
}

const loadMeetingPageOnlyState = buildSinglePageState(
  MEETING_INFO_PAGE_URL,
  "面会について",
  "meeting_only",
  "meetingOnly"
);

const loadAttendPageOnlyState = buildSinglePageState(
  ATTEND_INFO_PAGE_URL,
  "立ち会い分娩について",
  "attend_only",
  "attendOnly"
);

function isSinglePageOnlyState(state) {
  return Boolean(state && state.singlePageOnly === true);
}

async function resolveEntrySitemapUrl() {
  const custom = (process.env.SITE_SITEMAP_URL || "").trim();
  if (custom) return custom;

  // 新サイト（Yoast）: sitemap.xml → sitemap_index.xml
  const candidates = [
    "https://kanai.or.jp/sitemap_index.xml",
    "https://kanai.or.jp/sitemap.xml",
    "https://www.kanai.or.jp/sitemap_index.xml",
    "https://www.kanai.or.jp/sitemap.xml",
    "https://kanai.or.jp/wp-sitemap.xml",
    "https://www.kanai.or.jp/wp-sitemap.xml",
  ];

  for (const u of candidates) {
    try {
      const xml = await fetchText(u);
      if (xml && /<loc>/i.test(xml)) return u;
    } catch {
      /* try next */
    }
  }
  throw new Error("sitemap が取得できませんでした（SITE_SITEMAP_URL を指定してください）");
}

/** パスを比較用に正規化（ホスト統一・末尾スラッシュ除去・ハッシュ除去） */
export function normalizeKanaiPathKey(url) {
  try {
    const u = new URL(String(url || "").trim().replace(/^https?:\/\/www\.kanai\.or\.jp/i, "https://kanai.or.jp"));
    if (!allowedHost(u.hostname)) return "";
    let path = u.pathname || "/";
    if (path.length > 1) path = path.replace(/\/+$/, "");
    return `https://kanai.or.jp${path === "" ? "/" : path}`;
  } catch {
    return "";
  }
}

/**
 * 最新 sitemap の URL 一覧を取得してキャッシュ（チップ検証・知識取得の共通基盤）
 * @returns {Promise<{ paths: Set<string>, entryUrl: string, error: string|null }>}
 */
export async function ensureSitemapAllowlist() {
  const now = Date.now();
  if (sitemapAllowCache.paths && now - sitemapAllowCache.at < DEFAULT_TTL_MS) {
    return {
      paths: sitemapAllowCache.paths,
      entryUrl: sitemapAllowCache.entryUrl,
      error: sitemapAllowCache.error,
    };
  }
  if (sitemapAllowInflight) return sitemapAllowInflight;

  sitemapAllowInflight = (async () => {
    try {
      const entry = await resolveEntrySitemapUrl();
      const allUrls = await collectAllPageUrls(entry);
      const paths = new Set();
      for (const u of allUrls) {
        const key = normalizeKanaiPathKey(u);
        if (key) paths.add(key);
      }
      // ルートは常に許可
      paths.add("https://kanai.or.jp");
      paths.add("https://kanai.or.jp/");
      sitemapAllowCache = {
        at: Date.now(),
        paths,
        entryUrl: entry,
        error: paths.size ? null : "empty_sitemap",
      };
      return {
        paths: sitemapAllowCache.paths,
        entryUrl: sitemapAllowCache.entryUrl,
        error: sitemapAllowCache.error,
      };
    } catch (e) {
      const msg = e?.message || String(e);
      console.error("ensureSitemapAllowlist error:", msg);
      // 失敗時は前回キャッシュがあれば継続利用
      if (sitemapAllowCache.paths?.size) {
        return {
          paths: sitemapAllowCache.paths,
          entryUrl: sitemapAllowCache.entryUrl,
          error: msg,
        };
      }
      sitemapAllowCache = { at: Date.now(), paths: new Set(), entryUrl: "", error: msg };
      return { paths: sitemapAllowCache.paths, entryUrl: "", error: msg };
    } finally {
      sitemapAllowInflight = null;
    }
  })();

  return sitemapAllowInflight;
}

/** sitemap に載っているページか（#fragment は無視してパスで判定） */
export async function isUrlInSitemap(url) {
  const key = normalizeKanaiPathKey(url);
  if (!key) return false;
  const { paths } = await ensureSitemapAllowlist();
  if (!paths?.size) return true; // sitemap取得失敗時はブロックしない（可用性優先）
  const noSlash = key.replace(/\/$/, "") || "https://kanai.or.jp";
  return paths.has(key) || paths.has(noSlash) || paths.has(`${noSlash}/`);
}

/**
 * 参照チップ候補を sitemap にあるURLだけに絞る
 * @param {Array<{ url?: string, title?: string }>} pages
 */
export async function filterPagesBySitemap(pages) {
  const list = Array.isArray(pages) ? pages : [];
  if (!list.length) return [];
  const { paths, error } = await ensureSitemapAllowlist();
  if (!paths?.size) {
    if (error) console.warn("filterPagesBySitemap: sitemap empty, keep pages:", error);
    return list;
  }
  const out = [];
  for (const p of list) {
    const url = String(p?.url || "").trim();
    if (!url) continue;
    const key = normalizeKanaiPathKey(url);
    const noSlash = key.replace(/\/$/, "") || "https://kanai.or.jp";
    const ok =
      paths.has(key) ||
      paths.has(noSlash) ||
      paths.has(`${noSlash}/`);
    if (ok) out.push(p);
    else console.warn("drop chip not in sitemap:", url);
  }
  return out;
}

/**
 * sitemap / SITE_URL_LIST から候補 URL 一覧を取得（本文は取らない）
 */
async function loadCandidateUrlList() {
  const now = Date.now();
  if (urlListCache.urls.length && now - urlListCache.at < URL_LIST_TTL_MS) {
    return {
      urls: urlListCache.urls,
      fetchMode: urlListCache.fetchMode,
      error: urlListCache.error,
      fromCache: true,
    };
  }
  if (urlListInflight) return urlListInflight;

  urlListInflight = (async () => {
    const registered = parseRegisteredUrlList();
    const preferList =
      registered.length > 0 &&
      ["true", "1", "yes"].includes(
        String(process.env.SITE_PREFER_URL_LIST || "").toLowerCase().trim()
      );

    try {
      /** @type {string[]} */
      let urls;
      /** @type {"url_list"|"sitemap"} */
      let fetchMode;

      if (preferList) {
        fetchMode = "url_list";
        urls = registered;
      } else {
        fetchMode = "sitemap";
        try {
          const entry = await resolveEntrySitemapUrl();
          const allUrls = await collectAllPageUrls(entry);
          const paths = new Set();
          for (const u of allUrls) {
            const key = normalizeKanaiPathKey(u);
            if (key) paths.add(key);
          }
          paths.add("https://kanai.or.jp");
          sitemapAllowCache = {
            at: Date.now(),
            paths,
            entryUrl: entry,
            error: null,
          };
          // ランク前の全候補（上限あり）。質問ごとにここから関連ページを選んで最新取得する
          urls = filterAndRankUrls(allUrls, MAX_SITEMAP_URLS);
        } catch (e) {
          if (registered.length > 0) {
            console.warn("sitemap failed, fallback to SITE_URL_LIST:", e?.message || e);
            fetchMode = "url_list";
            urls = registered;
          } else {
            throw e;
          }
        }
      }

      urlListCache = {
        at: Date.now(),
        urls,
        fetchMode,
        error: null,
      };
      return { urls, fetchMode, error: null, fromCache: false };
    } catch (e) {
      const msg = e?.message || String(e);
      urlListCache = { at: Date.now(), urls: [], fetchMode: null, error: msg };
      return { urls: [], fetchMode: null, error: msg, fromCache: false };
    } finally {
      urlListInflight = null;
    }
  })();

  return urlListInflight;
}

/** URLパスと質問の簡易スコア（本文取得前の候補選定） */
function scoreUrlForQuery(userMessage, url) {
  const stub = { url, title: "", text: "" };
  // topicUrlBoost 内で queryPathBoost 済み
  let score = urlPriority(url) * 10 + topicUrlBoost(userMessage, stub);
  try {
    const path = decodeURIComponent(new URL(url).pathname).toLowerCase();
    for (const tok of tokenizeUserMessageForScoring(userMessage)) {
      const t = tok.toLowerCase();
      if (t.length >= 2 && path.includes(t)) score += t.length * 8;
    }
  } catch {
    /* ignore */
  }
  return score;
}

/**
 * 質問に関連する URL を選び、各ページ本文を毎回最新取得する
 */
async function loadFreshKnowledgeForQuery(userMessage, maxPages = DEFAULT_MAX_PAGES, maxChars = DEFAULT_MAX_CHARS) {
  const list = await loadCandidateUrlList();
  if (!list.urls?.length) {
    return {
      chunks: [],
      referenceUrls: [],
      knowledgeText: "",
      error: list.error || "no_urls",
      fetchMode: list.fetchMode,
    };
  }

  const scored = list.urls
    .map((url) => ({ url, score: scoreUrlForQuery(userMessage, url) }))
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));

  const positive = scored.filter((s) => s.score > 0).map((s) => s.url);
  // 関連スコアが付いたページを優先。無いときだけ優先度順の先頭を使う
  const picked = (positive.length ? positive : scored.map((s) => s.url)).slice(0, maxPages);

  const chunks = (
    await Promise.all(picked.map((u) => fetchPageChunk(u, maxChars)))
  ).filter(Boolean);

  return {
    chunks,
    referenceUrls: picked.slice(0, 40),
    knowledgeText: buildFullKnowledgeText(chunks),
    error: chunks.length ? null : "no_chunks",
    fetchMode: list.fetchMode,
  };
}

/** @deprecated 互換。本文キャッシュ利用時のみ */
async function buildFreshKnowledge(maxPages, maxChars) {
  return loadFreshKnowledgeForQuery("", maxPages, maxChars);
}

async function readFromRedis() {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(REDIS_KEY);
    if (!raw || typeof raw !== "string") return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.chunks)) return null;
    const age = Date.now() - (parsed.builtAt || 0);
    if (age > DEFAULT_TTL_MS) return null;
    return {
      chunks: parsed.chunks,
      referenceUrls: parsed.referenceUrls || [],
      knowledgeText: parsed.knowledgeText || "",
      error: parsed.error || null,
      fetchMode: parsed.fetchMode ?? null,
      fromRedis: true,
      builtAt: parsed.builtAt,
    };
  } catch (e) {
    console.error("site knowledge redis read error:", e?.message || e);
    return null;
  }
}

async function writeToRedis(payload) {
  const redis = getRedis();
  if (!redis) return;
  try {
    const body = JSON.stringify({
      ...payload,
      builtAt: Date.now(),
    });
    const ttlSec = Math.ceil(DEFAULT_TTL_MS / 1000);
    await redis.set(REDIS_KEY, body, { ex: ttlSec });
  } catch (e) {
    console.error("site knowledge redis write error:", e?.message || e);
  }
}

/**
 * サイト知識をロード。
 * 既定は本文キャッシュなし（呼び出し側で質問ごとに最新取得）。
 * SITE_KNOWLEDGE_CACHE_BODIES=true のときだけメモリ/Redis を使う。
 */
export async function ensureSiteKnowledgeLoaded(userMessage = "") {
  if (!CACHE_BODIES) {
    try {
      const built = await loadFreshKnowledgeForQuery(
        userMessage,
        DEFAULT_MAX_PAGES,
        DEFAULT_MAX_CHARS
      );
      memoryCache = {
        at: Date.now(),
        chunks: built.chunks,
        referenceUrls: built.referenceUrls,
        knowledgeText: built.knowledgeText,
        error: built.error,
        fetchMode: built.fetchMode ?? null,
      };
      return { ...memoryCache, fromCache: "fresh" };
    } catch (e) {
      console.error("ensureSiteKnowledgeLoaded error:", e?.message || e);
      return {
        at: Date.now(),
        chunks: [],
        referenceUrls: [],
        knowledgeText: "",
        error: e?.message || String(e),
        fetchMode: null,
        fromCache: "error",
      };
    }
  }

  const now = Date.now();
  if (memoryCache.chunks.length && now - memoryCache.at < DEFAULT_TTL_MS) {
    return { ...memoryCache, fromCache: "memory", fetchMode: memoryCache.fetchMode };
  }

  const fromRedis = await readFromRedis();
  if (fromRedis) {
    memoryCache = {
      at: now,
      chunks: fromRedis.chunks,
      referenceUrls: fromRedis.referenceUrls,
      knowledgeText: fromRedis.knowledgeText,
      error: fromRedis.error,
      fetchMode: fromRedis.fetchMode ?? null,
    };
    return { ...memoryCache, fromCache: "redis" };
  }

  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const built = await loadFreshKnowledgeForQuery(
        userMessage,
        DEFAULT_MAX_PAGES,
        DEFAULT_MAX_CHARS
      );
      memoryCache = {
        at: Date.now(),
        chunks: built.chunks,
        referenceUrls: built.referenceUrls,
        knowledgeText: built.knowledgeText,
        error: built.error,
        fetchMode: built.fetchMode ?? null,
      };
      await writeToRedis({
        chunks: built.chunks,
        referenceUrls: built.referenceUrls,
        knowledgeText: built.knowledgeText,
        error: built.error,
        fetchMode: built.fetchMode,
      });
      return { ...memoryCache, fromCache: "fresh" };
    } catch (e) {
      console.error("ensureSiteKnowledgeLoaded error:", e?.message || e);
      memoryCache = {
        at: Date.now(),
        chunks: [],
        referenceUrls: [],
        knowledgeText: "",
        error: e?.message || String(e),
        fetchMode: null,
      };
      return { ...memoryCache, fromCache: "error" };
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * チップ・抜粋見出し用。多くのページで <title> が「ページ名｜法人名」または法人名のみのため、ページ名を優先する。
 * @param {{ url: string, title: string, text?: string }} c
 */
export function labelForKnowledgeChunk(c) {
  const title = (c.title || "").trim();
  const pipeParts = title.split(/[｜|]/).map((x) => x.trim()).filter(Boolean);
  if (pipeParts.length >= 2) {
    const head = pipeParts[0];
    if (head.length >= 2 && head.length <= 100) return head;
  }
  try {
    const path = new URL(c.url).pathname;
    const seg = path.split("/").filter(Boolean).pop();
    if (seg) {
      const dec = decodeURIComponent(seg).replace(/-/g, " ");
      if (dec.length >= 2 && dec.length <= 80) return dec;
    }
  } catch {
    /* ignore */
  }
  return title || c.url;
}

/** 日本語が続く文を意味のある語に分割してスコアリングする */
function tokenizeUserMessageForScoring(text) {
  const raw = String(text || "")
    .trim()
    .replace(/について/g, " ")
    .replace(/に関して/g, " ")
    .replace(/教えてください/g, " ")
    .replace(/お願いします/g, " ");
  if (!raw) return [];
  const JP_SPLIT =
    /[\s\u3000、。・,.!?？!のをにはがとでもからまでへやなどってございますかだけたいです対してもの中をからの]+/;
  const parts = raw
    .split(JP_SPLIT)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

/** URL パス・代表的トピック語と質問文の突き合わせで加点（日本語がトークン化されない問題の補正） */
function topicUrlBoost(userMessage, c) {
  const msg = String(userMessage || "");
  const msgL = msg.toLowerCase();
  const body = contentBodyForScoring(c);
  const urlAndHead = `${c.url}\n${c.title}\n${body.slice(0, 1800)}`.toLowerCase();
  let bonus = queryPathBoost(msg, c.url);
  try {
    const path = decodeURIComponent(new URL(c.url).pathname.toLowerCase());
    for (const seg of path.split("/").filter((x) => x.length >= 2)) {
      const sNorm = seg.replace(/-/g, "").replace(/_/g, "");
      if (sNorm.length >= 3 && msgL.includes(sNorm)) bonus += 48;
      else if (sNorm.length === 2 && msgL.includes(sNorm)) bonus += 12;
    }
  } catch {
    /* ignore */
  }

  const isCervicalScreening = /子宮頸がん|子宮がん検診|婦人科検診/.test(msg);
  const isVaccineQuery =
    /インフルエンザ|インフル|ワクチン|予防接種|アブリスボ|RSウイルス|RS\s*ウイルス/.test(msg) &&
    !isCervicalScreening;

  const pairs = [
    [/レストラン|レスト|食堂|食事|ランチ|ディナー|beb|béb|ベベ/i, /restaurant|bebe|bebé|dining|lunch|dinner|meal|cafe|レストラン/],
    [/駐車|パーキング|駐車場|車でお越し/, /parking|park|駐車場|\/access\/.*parking/],
    [/外来|受診|初診|予約|診察|アクセス|行き方|地図/, /\/visit\/|\/beginner\/|outpatient|appointment|gai|\/access\//],
    [/面会/, /\/hospitalization\/|#visit|面会/],
    [/立ち会い/, /\/childbirth\/|#assist_birth|立ち会い/],
    [
      /子宮頸がん|子宮がん検診|婦人科検診|婦人科疾患/,
      /\/gynecology|子宮頸がん|子宮がん検診|婦人科/,
    ],
    [
      /インフルエンザ|インフル|ワクチン|予防接種|アブリスボ|RSウイルス|RS\s*ウイルス/,
      /\/vaccine|\/prevention|インフルエンザ|アブリスボ|RSウイルス|ワクチン接種/,
    ],
    [/産婦人科|分娩|出産|妊娠|帝王切開/, /obstetrics|gynecology|delivery|pregnancy|産科|婦人/],
    [/お知らせ|ニュース/, /\/news\/|\/info\/|column|notice/],
    [/料金|費用|支払|予納/, /fee|price|cost|payment/],
    [
      /診療時間|受付時間|休診|曜日|スケジュール|診療枠|時間割/,
      /schedule|hours|time|休診|診療|calendar|枠/,
    ],
  ];
  // 一般の健診語は、子宮頸がん検診・ワクチン専用質問では使わない（誤ページ誘発防止）
  if (!isCervicalScreening && !isVaccineQuery) {
    pairs.push([
      /検診|健診|妊婦検|乳児検|検査予約|母子手帳/,
      /健診|kenshin|screening|乳児|妊婦|検診|checkup|exam|母子/,
    ]);
  }
  for (const [msgRe, hayRe] of pairs) {
    if (msgRe.test(msg) && hayRe.test(urlAndHead)) bonus += 140;
  }
  return bonus;
}

/**
 * 参照チップ用スコア（短文の症状語だけでは上がらないようにトークン条件を厳しめ）
 */
function chunkScoreForChips(userMessage, c) {
  const text = (userMessage || "").trim();
  const body = contentBodyForScoring(c);
  const hay = `${c.title}\n${c.url}\n${body}`.toLowerCase();
  let score = topicUrlBoost(userMessage, c);
  const userTokens = tokenizeUserMessageForScoring(text);
  const userLower = text.toLowerCase();
  for (const tok of userTokens) {
    const t = tok.toLowerCase();
    if (t.length >= 3 && hay.includes(t)) score += t.length;
    else if (t.length === 2 && FACILITY_2CHAR.has(t) && hay.includes(t)) score += 12;
  }
  if (userLower.length >= 4 && userLower.length <= 100 && hay.includes(userLower)) score += 35;
  return score;
}

/**
 * 画面下部の参照チップに載せるチャンク（関連が十分高いときだけ）
 * @returns {Array<{ url: string, title: string, text: string }>}
 */
export function selectReferencedPagesForChips(userMessage, state) {
  if (isSinglePageOnlyState(state)) {
    return (state.chunks || []).filter(Boolean).slice(0, SNIPPET_TOP_CHUNKS);
  }
  const chunks = state?.chunks || [];
  if (!chunks.length) return [];

  const scored = chunks.map((c) => ({
    c,
    score: chunkScoreForChips(userMessage, c),
  }));
  const maxS = scored.reduce((m, s) => Math.max(m, s.score), 0);
  if (maxS < REFERENCE_CHIP_MIN_SCORE) return [];

  const top = scored
    .filter((s) => s.score >= REFERENCE_CHIP_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, SNIPPET_TOP_CHUNKS)
    .map((s) => s.c);

  const seenUrl = new Set();
  const out = [];
  for (const c of top) {
    if (!c?.url || seenUrl.has(c.url)) continue;
    seenUrl.add(c.url);
    out.push(c);
  }
  return out;
}

/**
 * ユーザーメッセージに関連しそうなチャンク（抜粋に載せる集合＝情報源）
 * スコア0のページは載せない（無関係な先頭ページへのフォールバックはしない）
 * @returns {Array<{ url: string, title: string, text: string }>}
 */
export function selectReferencedChunks(userMessage, state) {
  if (isSinglePageOnlyState(state)) {
    return (state.chunks || []).filter(Boolean).slice(0, SNIPPET_TOP_CHUNKS);
  }
  const text = (userMessage || "").trim();
  const chunks = state?.chunks || [];
  if (!chunks.length) {
    return [];
  }

  const userTokens = tokenizeUserMessageForScoring(text);
  const userLower = text.toLowerCase();

  const scored = chunks.map((c) => {
    const body = contentBodyForScoring(c);
    const hay = `${c.title}\n${c.url}\n${body}`.toLowerCase();
    let score = topicUrlBoost(userMessage, c);
    for (const tok of userTokens) {
      const t = tok.toLowerCase();
      if (t.length >= 2 && hay.includes(t)) score += t.length;
    }
    if (userLower.length >= 4 && userLower.length <= 100 && hay.includes(userLower)) score += 35;
    return { c, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, SNIPPET_TOP_CHUNKS)
    .map((s) => s.c);
}

/**
 * 抜粋に載せたチャンクから参照ページ一覧を作る（チップ＝情報源）
 * @returns {Array<{ url: string, title: string }>}
 */
export function sourcePagesFromChunks(chunks) {
  const seen = new Set();
  const out = [];
  for (const c of chunks || []) {
    const url = rewriteLegacyKanaiUrl(c?.url);
    if (!url || seen.has(url) || isGenericKanaiHomeUrl(url)) continue;
    seen.add(url);
    out.push({
      url,
      title: String(labelForKnowledgeChunk(c)).replace(/\s+/g, " ").trim() || url,
    });
  }
  return out;
}

/**
 * ユーザーメッセージに関連しそうなチャンクだけを system 用にまとめる
 * @returns {{ snippet: string, sourceChunks: Array<{ url: string, title: string, text: string }> }}
 */
export function buildSiteKnowledgeSnippet(userMessage, state, { includeReferenceUrlList = true } = {}) {
  if (isSinglePageOnlyState(state) && (state.chunks || []).length) {
    const use = state.chunks;
    const parts = use.map((c) => `【${labelForKnowledgeChunk(c)}】\nURL: ${c.url}\n${c.text}`);
    const label = String(state.singlePageTitle || "指定ページ");
    return {
      snippet: `【当院公式サイトからの抜粋（${label}のページのみ。他ページの情報は含みません）】\n\n${parts.join(
        "\n\n---\n\n"
      )}`,
      sourceChunks: use,
    };
  }
  const referenceUrls = state?.referenceUrls || [];
  const use = selectReferencedChunks(userMessage, state);

  if (!use.length) {
    return { snippet: "", sourceChunks: [] };
  }

  const parts = use.map((c) => `【${labelForKnowledgeChunk(c)}】\nURL: ${c.url}\n${c.text}`);

  let snippet = `【当院公式サイトからの抜粋（関連が高そうなページのみ）】\n\n${parts.join("\n\n---\n\n")}`;

  if (includeReferenceUrlList && referenceUrls.length > 0) {
    snippet += `\n\n【参考URL（院内サイト・sitemap 由来）】\n${referenceUrls
      .slice(0, 12)
      .map((u) => `・${u}`)
      .join("\n")}`;
  }

  return { snippet, sourceChunks: use };
}

function buildSinglePageSnippet(state, fallbackTitle, fallbackUrl) {
  const c = state.chunks?.[0];
  if (c) {
    return {
      snippet: `【当院公式サイトからの抜粋（${state.singlePageTitle || fallbackTitle}のページのみ。他ページの情報は含みません）】\n\n【${labelForKnowledgeChunk(
        c
      )}】\nURL: ${c.url}\n${c.text}`,
      sourceChunks: [c],
    };
  }
  return {
    snippet: `【${fallbackTitle}】\n${fallbackUrl} の本文を取得できませんでした。お手数ですがブラウザで直接ご確認ください。`,
    sourceChunks: [{ url: fallbackUrl, title: fallbackTitle, text: "" }],
  };
}

/** サイトルートなどチップに不向きなURLか */
export function isGenericKanaiHomeUrl(url) {
  try {
    const u = new URL(String(url || "").trim());
    if (!/(?:^|\.)kanai\.or\.jp$/i.test(u.hostname)) return true;
    const path = (u.pathname || "/").replace(/\/+$/, "") || "/";
    return path === "/" && !u.hash && !u.search;
  } catch {
    return true;
  }
}

/**
 * 公式サイトURLからの知識抜粋（主データソース）
 * - 関連ページを選び、本文は毎回最新取得（既定）
 * - sourceChunks = プロンプトに載せた情報源（参照チップもこれと同一）
 */
export async function getSiteKnowledgeSnippetSupplement(userMessage) {
  if (isAttendFocusedQuery(userMessage)) {
    const state = await loadAttendPageOnlyState();
    const { snippet, sourceChunks } = buildSinglePageSnippet(
      state,
      "立ち会い分娩について",
      ATTEND_INFO_PAGE_URL
    );
    return { snippet, state, sourceChunks };
  }
  if (isMeetingFocusedQuery(userMessage)) {
    const state = await loadMeetingPageOnlyState();
    const { snippet, sourceChunks } = buildSinglePageSnippet(
      state,
      "面会について",
      MEETING_INFO_PAGE_URL
    );
    return { snippet, state, sourceChunks };
  }
  const state = await ensureSiteKnowledgeLoaded(userMessage);
  const { snippet, sourceChunks } = buildSiteKnowledgeSnippet(userMessage, state, {
    includeReferenceUrlList: false,
  });
  return { snippet, state, sourceChunks };
}

/** @deprecated 互換用。新規は getSiteKnowledgeSnippetSupplement を利用 */
export async function getSiteKnowledgeSnippet(userMessage) {
  return getSiteKnowledgeSnippetSupplement(userMessage);
}

/** GET ヘルス用。ネットワーク取得は行わず、メモリ上の状況だけ返す */
export function peekSiteKnowledgeStatus() {
  const now = Date.now();
  const fresh = memoryCache.chunks.length > 0 && now - memoryCache.at < DEFAULT_TTL_MS;
  const registeredCount = parseRegisteredUrlList().length;
  const preferUrlList = ["true", "1", "yes"].includes(
    String(process.env.SITE_PREFER_URL_LIST || "").toLowerCase().trim()
  );
  return {
    cacheBodies: CACHE_BODIES,
    memoryCached: CACHE_BODIES && fresh,
    chunkCount: memoryCache.chunks.length,
    lastError: memoryCache.error,
    fetchMode: memoryCache.fetchMode,
    registeredUrlCount: registeredCount,
    preferUrlList,
    urlListCached: urlListCache.urls.length > 0 && now - urlListCache.at < URL_LIST_TTL_MS,
    urlListCount: urlListCache.urls.length,
    sitemapEntryUrl: sitemapAllowCache.entryUrl || null,
    sitemapPathCount: sitemapAllowCache.paths?.size || 0,
    sitemapError: sitemapAllowCache.error,
    ttlMs: DEFAULT_TTL_MS,
    urlListTtlMs: URL_LIST_TTL_MS,
    maxPages: DEFAULT_MAX_PAGES,
    maxCharsPerPage: DEFAULT_MAX_CHARS,
    snippetTopChunks: SNIPPET_TOP_CHUNKS,
    singlePageCacheCount: singlePageCache.size,
  };
}
