/**
 * 当院サイトの HTML を取得してテキスト化する（軽量RAG＋鮮度ルール）
 * - 既定: sitemap から URL+lastmod を収集
 * - SITE_PREFER_URL_LIST=true のときのみ SITE_URL_LIST を優先
 * - 本文は既定で毎回最新取得（SITE_KNOWLEDGE_CACHE_BODIES=true のときだけ短時間キャッシュ）
 * - sitemap URL一覧は短時間キャッシュ（SITE_URL_LIST_TTL_MS、既定30分）
 * - 正規ルート辞書: data/site-route-map.js（優先取得。絶対正解ではない）
 */

import { Redis } from "@upstash/redis";
import { matchSiteRoutes, preferredUrlsForMessage } from "../data/site-route-map.js";

const REDIS_KEY = "chat:site-knowledge:v6";

const DEFAULT_MAX_PAGES = parseInt(process.env.SITE_FETCH_MAX_PAGES || "16", 10);
const DEFAULT_MAX_CHARS = parseInt(process.env.SITE_MAX_CHARS_PER_PAGE || "3000", 10);
const SNIPPET_TOP_CHUNKS = Math.min(
  10,
  Math.max(1, parseInt(process.env.SITE_SNIPPET_TOP_CHUNKS || "2", 10))
);
/** これ未満の総合スコアは GPT に渡さない（低関連ページを根拠にしない） */
const MIN_SNIPPET_SCORE = Math.max(
  1,
  parseInt(process.env.SITE_MIN_SNIPPET_SCORE || "45", 10) || 45
);
const CACHE_BODIES = ["true", "1", "yes"].includes(
  String(process.env.SITE_KNOWLEDGE_CACHE_BODIES || "false").toLowerCase().trim()
);
const DEFAULT_TTL_MS = parseInt(
  process.env.SITE_KNOWLEDGE_TTL_MS || String(15 * 60 * 1000),
  10
);
const URL_LIST_TTL_MS = parseInt(
  process.env.SITE_URL_LIST_TTL_MS || String(30 * 60 * 1000),
  10
);
const FETCH_TIMEOUT_MS = parseInt(process.env.SITE_FETCH_TIMEOUT_MS || "8000", 10);
const MAX_SITEMAP_URLS = parseInt(process.env.SITE_SITEMAP_MAX_URLS || "300", 10);

const FACILITY_2CHAR = new Set([
  "料金",
  "費用",
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
  "駐車",
  "休診",
  "夜診",
  "日曜",
  "祝日",
  "教室",
  "面会",
  "入院",
  "健診",
  "検診",
  "産後",
  "母乳",
  "妊婦",
  "予納",
]);

/** @typedef {"fixed"|"news"|"monologue"|"other"} PageType */
/** @typedef {{ url: string, lastmod?: string|null, pageType?: PageType }} UrlEntry */
/** @typedef {{ url: string, title: string, text: string, h1?: string[], h2?: string[], pageType?: PageType, lastmod?: string|null, publishedAt?: string|null, modifiedAt?: string|null, score?: number, scoreReasons?: string[], charCount?: number }} KnowledgeChunk */

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
  chunks: /** @type {KnowledgeChunk[]} */ ([]),
  referenceUrls: [],
  knowledgeText: "",
  error: null,
  /** @type {"url_list"|"sitemap"|null} */
  fetchMode: null,
};

let urlListCache = {
  at: 0,
  /** @type {UrlEntry[]} */
  entries: [],
  /** @type {"url_list"|"sitemap"|null} */
  fetchMode: null,
  error: null,
};
let urlListInflight = null;

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
  if (/\/qa(?:\/|$|[?#])/i.test(s)) return true;
  if (/\/author(?:\/|$)/i.test(s)) return true;
  if (/\/library\//i.test(s)) return true; // 保護ページ(401)が多くノイズになる
  return /\.(xml|jpg|jpeg|png|gif|webp|svg|ico|pdf|zip|css|js|woff2?|ttf|eot)(\?|$)/i.test(s);
}

/** @param {string} url @returns {PageType} */
export function classifyPageType(url) {
  const u = String(url || "").toLowerCase();
  if (/\/monologue(?:\/|$)/i.test(u)) return "monologue";
  // Yoast: 固定ページは path が短いことが多い。投稿は日本語スラッグや日付系が多い
  if (/\/news(?:\/|$)/i.test(u)) return "news";
  // post-sitemap 由来の単独投稿（エンコード日本語スラッグ）は news 扱い
  try {
    const path = new URL(u).pathname.replace(/\/+$/, "") || "/";
    const segs = path.split("/").filter(Boolean);
    if (segs.length === 1 && /%[0-9a-f]{2}/i.test(segs[0])) return "news";
    if (segs.length === 1 && /お知らせ|休診|ワクチン接種の/.test(decodeURIComponent(segs[0]))) {
      return "news";
    }
  } catch {
    /* ignore */
  }
  if (
    /\/(beginner|lesson|obstetrics|gynecology|restaurant|about|aftersupport|access|facilities|prevention|documents|library)(?:\/|$)/i.test(
      u
    )
  ) {
    return "fixed";
  }
  if (u === "https://kanai.or.jp/" || /kanai\.or\.jp\/?$/i.test(u)) return "fixed";
  return "other";
}

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

/** sitemap から loc + lastmod を抽出 */
function extractUrlEntriesFromSitemapXml(xml) {
  /** @type {UrlEntry[]} */
  const entries = [];
  const re =
    /<url>\s*<loc>\s*([^<\s]+)\s*<\/loc>\s*(?:<lastmod>\s*([^<\s]+)\s*<\/lastmod>)?/gi;
  let m;
  while ((m = re.exec(xml))) {
    entries.push({ url: m[1].trim(), lastmod: m[2] ? m[2].trim() : null });
  }
  // loc のみ（index 子など）
  if (!entries.length) {
    const locRe = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
    while ((m = locRe.exec(xml))) {
      entries.push({ url: m[1].trim(), lastmod: null });
    }
  }
  return entries;
}

function isSitemapIndex(xml) {
  return /<sitemapindex/i.test(xml);
}

async function collectAllPageEntries(entrySitemapUrl) {
  const rootXml = await fetchText(entrySitemapUrl);
  const rootEntries = extractUrlEntriesFromSitemapXml(rootXml);

  if (isSitemapIndex(rootXml)) {
    /** @type {UrlEntry[]} */
    const pageEntries = [];
    const childSitemaps = rootEntries
      .map((e) => e.url)
      .filter((u) => /\.xml(\?|$)/i.test(u));
    for (const child of childSitemaps) {
      if (pageEntries.length >= MAX_SITEMAP_URLS) break;
      try {
        const childXml = await fetchText(child);
        pageEntries.push(...extractUrlEntriesFromSitemapXml(childXml));
      } catch (e) {
        console.error("child sitemap fetch failed:", child, e?.message || e);
      }
    }
    return dedupeUrlEntries(pageEntries);
  }

  return dedupeUrlEntries(rootEntries);
}

/** @param {UrlEntry[]} entries */
function dedupeUrlEntries(entries) {
  const map = new Map();
  for (const e of entries || []) {
    const url = String(e?.url || "").trim();
    if (!url) continue;
    const prev = map.get(url);
    if (!prev) {
      map.set(url, {
        url,
        lastmod: e.lastmod || null,
        pageType: classifyPageType(url),
      });
      continue;
    }
    // より新しい lastmod を残す
    if (e.lastmod && (!prev.lastmod || Date.parse(e.lastmod) > Date.parse(prev.lastmod))) {
      prev.lastmod = e.lastmod;
    }
  }
  return [...map.values()];
}

function filterUrlEntries(rawEntries, maxPages) {
  const filtered = [];
  for (const e of rawEntries) {
    if (filtered.length >= MAX_SITEMAP_URLS) break;
    try {
      const parsed = new URL(e.url);
      if (!allowedHost(parsed.hostname)) continue;
      if (isSkippableUrl(e.url)) continue;
      filtered.push({
        url: e.url,
        lastmod: e.lastmod || null,
        pageType: e.pageType || classifyPageType(e.url),
      });
    } catch {
      /* skip */
    }
  }
  const uniq = dedupeUrlEntries(filtered);
  uniq.sort((a, b) => {
    const ta = a.pageType === "fixed" ? 2 : a.pageType === "news" ? 1 : 0;
    const tb = b.pageType === "fixed" ? 2 : b.pageType === "news" ? 1 : 0;
    if (tb !== ta) return tb - ta;
    return a.url.localeCompare(b.url);
  });
  return uniq.slice(0, maxPages);
}

function stripTagsToText(html) {
  return String(html || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** class 名を持つ要素をネスト対応で切り出す */
function extractElementByClass(html, className) {
  const re = new RegExp(
    `<([a-z0-9]+)([^>]*\\bclass=["'][^"']*\\b${className}\\b[^"']*["'][^>]*)>`,
    "i"
  );
  const m = re.exec(html);
  if (!m) return null;
  const tag = m[1].toLowerCase();
  let i = m.index + m[0].length;
  let depth = 1;
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  const closeRe = new RegExp(`</${tag}>`, "gi");
  while (i < html.length && depth > 0) {
    openRe.lastIndex = i;
    closeRe.lastIndex = i;
    const open = openRe.exec(html);
    const close = closeRe.exec(html);
    if (!close) break;
    if (open && open.index < close.index) {
      depth += 1;
      i = open.index + open[0].length;
    } else {
      depth -= 1;
      i = close.index + close[0].length;
      if (depth === 0) return html.slice(m.index, i);
    }
  }
  return null;
}

/**
 * header/nav/footer 等を除き、本文領域を優先抽出
 */
function extractMainHtml(html) {
  let h = String(html || "");
  h = h.replace(/<!--[\s\S]*?-->/g, " ");
  h = h.replace(/<!\[if[\s\S]*?<!\[endif\]>/gi, " ");
  h = h.replace(/<script[\s\S]*?<\/script>/gi, " ");
  h = h.replace(/<style[\s\S]*?<\/style>/gi, " ");
  h = h.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");

  // ページ固有 wrapper（ネスト対応）を優先
  const preferredClasses = [
    "entry-content",
    "post-content",
    "page-content",
    "gynecology_wrapper",
    "obstetrics_wrapper",
    "beginner_wrapper",
    "aftersupport_wrapper",
    "lesson_wrapper",
    "about_wrapper",
    "access_wrapper",
    "facilities_wrapper",
    "restaurant_wrapper",
    "prevention_wrapper",
    "news_wrapper",
  ];
  for (const cls of preferredClasses) {
    const block = extractElementByClass(h, cls);
    if (block && stripTagsToText(block).length > 80) return block;
  }
  // *_wrapper 全般（header/footer/all 以外）
  const anyWrap = [
    ...h.matchAll(/class=["']([^"']*_wrapper[^"']*)["']/gi),
  ].map((m) => m[1].split(/\s+/).find((c) => /_wrapper$/i.test(c)));
  for (const cls of [...new Set(anyWrap)].filter(Boolean)) {
    if (/^(header_wrapper|footer_wrapper|all_wrapper)$/i.test(cls)) continue;
    const block = extractElementByClass(h, cls);
    if (block && stripTagsToText(block).length > 80) return block;
  }

  h = h.replace(/<header[\s\S]*?<\/header>/gi, " ");
  h = h.replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  h = h.replace(/<nav[\s\S]*?<\/nav>/gi, " ");
  h = h.replace(/<aside[\s\S]*?<\/aside>/gi, " ");
  for (const cls of ["header_wrapper", "footer_wrapper", "page_nav"]) {
    const block = extractElementByClass(h, cls);
    if (block) h = h.replace(block, " ");
  }

  const main = h.match(/<main[\s\S]*?<\/main>/i);
  if (main) return main[0];
  const article = h.match(/<article[\s\S]*?<\/article>/i);
  if (article) return article[0];
  return h;
}

function extractHeadings(html, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const t = stripTagsToText(m[1]);
    if (t && t.length <= 120) out.push(t);
  }
  return out.slice(0, 20);
}

function extractMetaDates(html) {
  const published =
    html.match(/article:published_time[^>]+content=["']([^"']+)/i)?.[1] ||
    html.match(/"datePublished"\s*:\s*"([^"]+)"/i)?.[1] ||
    null;
  const modified =
    html.match(/article:modified_time[^>]+content=["']([^"']+)/i)?.[1] ||
    html.match(/"dateModified"\s*:\s*"([^"]+)"/i)?.[1] ||
    null;
  return { publishedAt: published, modifiedAt: modified };
}

function htmlToText(html) {
  return stripTagsToText(html);
}

/**
 * @param {string} url
 * @param {number} maxChars
 * @param {{ lastmod?: string|null, pageType?: PageType }} [meta]
 * @returns {Promise<KnowledgeChunk|null>}
 */
async function fetchPageChunk(url, maxChars, meta = {}) {
  try {
    const html = await fetchText(url);
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : url;
    const mainHtml = extractMainHtml(html);
    const h1 = extractHeadings(mainHtml, "h1");
    const h2 = extractHeadings(mainHtml, "h2");
    const { publishedAt, modifiedAt } = extractMetaDates(html);
    const text = htmlToText(mainHtml).slice(0, maxChars);
    if (!text || text.length < 40) return null;
    const pageType = meta.pageType || classifyPageType(url);
    const lastmod = meta.lastmod || modifiedAt || publishedAt || null;
    return {
      url,
      title,
      text,
      h1,
      h2,
      pageType,
      lastmod,
      publishedAt,
      modifiedAt,
      charCount: text.length,
    };
  } catch (e) {
    console.error("page fetch failed:", url, e?.message || e);
    return null;
  }
}

export const MEETING_INFO_PAGE_URL =
  "https://kanai.or.jp/obstetrics/hospitalization/#visit";
export const ATTEND_INFO_PAGE_URL =
  "https://kanai.or.jp/obstetrics/childbirth/#assist_birth";

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
  if (/\/qa(?:\/|$|[?#])/i.test(u)) return "";
  return u;
}

export function isMeetingFocusedQuery(userMessage) {
  return /面会/.test(String(userMessage || "").trim());
}

export function isAttendFocusedQuery(userMessage) {
  return /立ち会い/.test(String(userMessage || "").trim());
}

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

async function ensureCachedSinglePage(url) {
  const bare = String(url || "").split("#")[0];
  if (!CACHE_BODIES) {
    return fetchPageChunk(url, DEFAULT_MAX_CHARS, { pageType: classifyPageType(bare) });
  }
  const now = Date.now();
  const cached = singlePageCache.get(bare);
  if (cached && now - cached.at < DEFAULT_TTL_MS) return cached.chunk;

  let pending = singlePageInflight.get(bare);
  if (!pending) {
    pending = fetchPageChunk(url, DEFAULT_MAX_CHARS, {
      pageType: classifyPageType(bare),
    }).finally(() => singlePageInflight.delete(bare));
    singlePageInflight.set(bare, pending);
  }
  const chunk = await pending;
  if (chunk) singlePageCache.set(bare, { at: Date.now(), chunk });
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
        ? chunks.map((c) => `【${c.title}】\nURL: ${c.url}\n${c.text}`).join("\n\n")
        : `【${title}】\n${url} の本文を取得できませんでした。`,
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
  const candidates = [
    "https://kanai.or.jp/sitemap_index.xml",
    "https://kanai.or.jp/sitemap.xml",
    "https://www.kanai.or.jp/sitemap_index.xml",
    "https://www.kanai.or.jp/sitemap.xml",
  ];
  for (const u of candidates) {
    try {
      const xml = await fetchText(u);
      if (xml && /<loc>/i.test(xml)) return u;
    } catch {
      /* next */
    }
  }
  throw new Error("sitemap が取得できませんでした（SITE_SITEMAP_URL を指定してください）");
}

export function normalizeKanaiPathKey(url) {
  try {
    const u = new URL(rewriteLegacyKanaiUrl(url) || url);
    if (!allowedHost(u.hostname)) return "";
    const path = (u.pathname || "/").replace(/\/+$/, "") || "/";
    return `https://kanai.or.jp${path === "/" ? "" : path}`;
  } catch {
    return "";
  }
}

export async function ensureSitemapAllowlist() {
  const now = Date.now();
  if (sitemapAllowCache.paths && now - sitemapAllowCache.at < URL_LIST_TTL_MS) {
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
      const entries = await collectAllPageEntries(entry);
      const paths = new Set();
      for (const e of entries) {
        const key = normalizeKanaiPathKey(e.url);
        if (key) paths.add(key);
      }
      paths.add("https://kanai.or.jp");
      sitemapAllowCache = { at: Date.now(), paths, entryUrl: entry, error: null };
      return { paths, entryUrl: entry, error: null };
    } catch (e) {
      const msg = e?.message || String(e);
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

export async function isUrlAllowedBySitemap(url) {
  const { paths } = await ensureSitemapAllowlist();
  if (!paths?.size) return true;
  const key = normalizeKanaiPathKey(url);
  if (!key) return false;
  const noSlash = key.replace(/\/$/, "") || "https://kanai.or.jp";
  return paths.has(key) || paths.has(noSlash) || paths.has(`${noSlash}/`);
}

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
    const ok = paths.has(key) || paths.has(noSlash) || paths.has(`${noSlash}/`);
    if (ok) out.push(p);
    else console.warn("drop chip not in sitemap:", url);
  }
  return out;
}

function bypassUrlListCache(opts = {}) {
  if (opts.forceRefresh) return true;
  if (["1", "true", "yes"].includes(String(process.env.SITE_KNOWLEDGE_FORCE_REFRESH || "").toLowerCase())) {
    return true;
  }
  return false;
}

async function loadCandidateUrlList(opts = {}) {
  const now = Date.now();
  const bypass = bypassUrlListCache(opts);
  if (!bypass && urlListCache.entries.length && now - urlListCache.at < URL_LIST_TTL_MS) {
    return {
      entries: urlListCache.entries,
      fetchMode: urlListCache.fetchMode,
      error: urlListCache.error,
      fromCache: true,
    };
  }
  if (!bypass && urlListInflight) return urlListInflight;

  const run = async () => {
    const registered = parseRegisteredUrlList();
    const preferList =
      registered.length > 0 &&
      ["true", "1", "yes"].includes(
        String(process.env.SITE_PREFER_URL_LIST || "").toLowerCase().trim()
      );
    try {
      /** @type {UrlEntry[]} */
      let entries;
      /** @type {"url_list"|"sitemap"} */
      let fetchMode;
      if (preferList) {
        fetchMode = "url_list";
        entries = registered.map((url) => ({
          url,
          lastmod: null,
          pageType: classifyPageType(url),
        }));
      } else {
        fetchMode = "sitemap";
        try {
          const entry = await resolveEntrySitemapUrl();
          const all = await collectAllPageEntries(entry);
          const paths = new Set();
          for (const e of all) {
            const key = normalizeKanaiPathKey(e.url);
            if (key) paths.add(key);
          }
          paths.add("https://kanai.or.jp");
          sitemapAllowCache = {
            at: Date.now(),
            paths,
            entryUrl: entry,
            error: null,
          };
          entries = filterUrlEntries(all, MAX_SITEMAP_URLS);
        } catch (e) {
          if (registered.length > 0) {
            console.warn("sitemap failed, fallback to SITE_URL_LIST:", e?.message || e);
            fetchMode = "url_list";
            entries = registered.map((url) => ({
              url,
              lastmod: null,
              pageType: classifyPageType(url),
            }));
          } else {
            throw e;
          }
        }
      }
      urlListCache = { at: Date.now(), entries, fetchMode, error: null };
      return { entries, fetchMode, error: null, fromCache: false };
    } catch (e) {
      const msg = e?.message || String(e);
      urlListCache = { at: Date.now(), entries: [], fetchMode: null, error: msg };
      return { entries: [], fetchMode: null, error: msg, fromCache: false };
    } finally {
      urlListInflight = null;
    }
  };

  if (bypass) return run();
  urlListInflight = run();
  return urlListInflight;
}

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

function freshnessPoints(lastmod, pageType) {
  if (!lastmod) {
    return { points: pageType === "fixed" ? 12 : 0, reason: "lastmodなし" };
  }
  const t = Date.parse(lastmod);
  if (!Number.isFinite(t)) return { points: 0, reason: "lastmod不正" };
  const ageDays = (Date.now() - t) / (24 * 60 * 60 * 1000);
  if (ageDays < 3) return { points: 90, reason: `更新${ageDays.toFixed(1)}日以内` };
  if (ageDays < 14) return { points: 70, reason: `更新${Math.floor(ageDays)}日以内` };
  if (ageDays < 45) return { points: 45, reason: `更新${Math.floor(ageDays)}日以内` };
  if (ageDays < 180) return { points: 20, reason: `更新約${Math.floor(ageDays)}日前` };
  if (ageDays < 400) return { points: 5, reason: `更新約${Math.floor(ageDays)}日前` };
  return { points: -15, reason: `古い更新(${Math.floor(ageDays)}日前)` };
}

function pageTypeBasePoints(pageType) {
  if (pageType === "fixed") return { points: 35, reason: "固定ページ" };
  if (pageType === "news") return { points: 10, reason: "お知らせ/投稿" };
  if (pageType === "monologue") return { points: 0, reason: "monologue" };
  return { points: 15, reason: "その他ページ" };
}

/**
 * 総合スコア（関連度＋種別＋鮮度＋ルート辞書）
 * @returns {{ score: number, reasons: string[] }}
 */
function scoreChunkForQuery(userMessage, chunk, routeBoostMap) {
  const msg = String(userMessage || "");
  const reasons = [];
  let score = 0;

  const bareUrl = String(chunk.url || "").split("#")[0];
  const pageType = chunk.pageType || classifyPageType(bareUrl);
  const typePts = pageTypeBasePoints(pageType);
  score += typePts.points;
  reasons.push(`${typePts.reason}(+${typePts.points})`);

  const fresh = freshnessPoints(chunk.lastmod || chunk.modifiedAt, pageType);
  score += fresh.points;
  reasons.push(`鮮度:${fresh.reason}(${fresh.points >= 0 ? "+" : ""}${fresh.points})`);

  // ルート辞書ブースト（優先取得。絶対正解ではない）
  const routeBoost = routeBoostMap.get(bareUrl) || routeBoostMap.get(chunk.url) || 0;
  if (routeBoost) {
    score += routeBoost;
    reasons.push(`ルート辞書(+${routeBoost})`);
  }

  const title = String(chunk.title || "");
  const h1 = (chunk.h1 || []).join(" ");
  const h2 = (chunk.h2 || []).join(" ");
  const body = String(chunk.text || "");
  const hayTitle = `${title}\n${h1}\n${h2}`.toLowerCase();
  const hayBody = body.toLowerCase();
  const tokens = tokenizeUserMessageForScoring(msg);
  const userLower = msg.toLowerCase();

  let rel = 0;
  for (const tok of tokens) {
    const t = tok.toLowerCase();
    if (t.length < 2) continue;
    if (hayTitle.includes(t)) {
      rel += t.length * 6;
      reasons.push(`見出し一致:${tok}`);
    } else if (hayBody.includes(t)) {
      rel += t.length * 3;
    } else if (t.length === 2 && FACILITY_2CHAR.has(t) && hayBody.includes(t)) {
      rel += 8;
    }
  }
  if (userLower.length >= 4 && userLower.length <= 80) {
    if (hayTitle.includes(userLower)) rel += 40;
    else if (hayBody.includes(userLower)) rel += 25;
  }

  // パスセグメント
  try {
    const path = decodeURIComponent(new URL(bareUrl).pathname).toLowerCase();
    for (const tok of tokens) {
      const t = tok.toLowerCase();
      if (t.length >= 2 && path.includes(t)) {
        rel += t.length * 5;
        reasons.push(`URL一致:${tok}`);
      }
    }
  } catch {
    /* ignore */
  }

  // トピックペア（本文中心。ナビ汚染を避けるため body/title のみ）
  const topicPairs = [
    [/面会/, /面会|#visit|hospitalization/],
    [/立ち会い/, /立ち会い|#assist_birth|childbirth/],
    [/里帰り/, /里帰り|#homecoming/],
    [/インフルエンザ|ワクチン|予防接種/, /ワクチン|インフルエンザ|\/vaccine/],
    [/子宮頸がん|子宮がん検診/, /子宮頸がん|子宮がん検診|\/gynecology/],
    [/産後ケア|産後サポート/, /産後ケア|産後サポート|\/aftersupport/],
    [/休診|診療時間|午後診|午前診/, /休診|診療時間|午前診|午後診|夜診/],
    [/分娩予約/, /分娩予約|分娩/],
  ];
  const hayAll = `${hayTitle}\n${hayBody}\n${bareUrl}`;
  for (const [msgRe, hayRe] of topicPairs) {
    if (msgRe.test(msg) && hayRe.test(hayAll)) {
      rel += 50;
      reasons.push("トピック一致(+50)");
      break;
    }
  }

  // 古いお知らせの過剰信頼を抑える（関連が弱いとき）
  if (pageType === "news" && rel < 30 && fresh.points < 40) {
    score -= 25;
    reasons.push("古い投稿かつ低関連(-25)");
  }
  // お知らせ一覧より個別投稿を優先
  try {
    const path = new URL(bareUrl).pathname.replace(/\/+$/, "") || "/";
    if (path === "/news") {
      score -= 40;
      reasons.push("お知らせ一覧ページ抑制(-40)");
    }
  } catch {
    /* ignore */
  }
  // 新しいお知らせで関連が高いときは固定ページを超えられる
  if (pageType === "news" && rel >= 40 && fresh.points >= 70) {
    score += 40;
    reasons.push("新しい関連お知らせ(+40)");
  }
  // 「今日/明日の診療」系は直近の休診お知らせを強く優先
  if (
    /今日|明日|今週|午後は診|午前は診|休診|本日/.test(msg) &&
    pageType === "news" &&
    (/休診/.test(hayBody) || /休診/.test(hayTitle))
  ) {
    score += 160;
    reasons.push("直近休診お知らせ(+160)");
  }
  // 日付のある臨時質問では、通常の診療時間表だけの固定ページ加点を抑える
  if (/今日|明日|本日|今週/.test(msg) && pageType === "fixed" && routeBoost > 0) {
    const cut = Math.floor(routeBoost * 0.55);
    score -= cut;
    reasons.push(`日付特定質問のため固定ルート抑制(-${cut})`);
  }

  score += rel;
  if (rel > 0) reasons.push(`関連度(+${rel})`);

  // 重複理由を軽く整理
  const uniqReasons = [];
  const seenR = new Set();
  for (const r of reasons) {
    if (seenR.has(r)) continue;
    seenR.add(r);
    uniqReasons.push(r);
  }

  return { score, reasons: uniqReasons.slice(0, 12) };
}

function buildRouteBoostMap(userMessage) {
  const map = new Map();
  for (const rule of matchSiteRoutes(userMessage)) {
    const boost = rule.boost ?? 180;
    for (const u of rule.urls || []) {
      const bare = String(u).split("#")[0];
      map.set(bare, Math.max(map.get(bare) || 0, boost));
      map.set(u, Math.max(map.get(u) || 0, boost));
    }
  }
  return map;
}

/**
 * URL段階の事前スコア（本文取得前）
 */
function scoreUrlEntryForQuery(userMessage, entry, routeBoostMap) {
  const stub = {
    url: entry.url,
    title: "",
    text: "",
    h1: [],
    h2: [],
    pageType: entry.pageType || classifyPageType(entry.url),
    lastmod: entry.lastmod,
  };
  return scoreChunkForQuery(userMessage, stub, routeBoostMap);
}

async function loadFreshKnowledgeForQuery(
  userMessage,
  maxPages = DEFAULT_MAX_PAGES,
  maxChars = DEFAULT_MAX_CHARS,
  opts = {}
) {
  const list = await loadCandidateUrlList(opts);
  const routeBoostMap = buildRouteBoostMap(userMessage);
  const preferred = preferredUrlsForMessage(userMessage).map((u) => u.split("#")[0]);

  /** @type {UrlEntry[]} */
  let entries = [...(list.entries || [])];
  // 辞書の優先URLを候補先頭に必ず含める
  for (const u of preferred) {
    if (!entries.some((e) => e.url.split("#")[0] === u || e.url === u)) {
      entries.unshift({ url: u, lastmod: null, pageType: classifyPageType(u) });
    }
  }

  if (!entries.length) {
    return {
      chunks: [],
      referenceUrls: [],
      knowledgeText: "",
      error: list.error || "no_urls",
      fetchMode: list.fetchMode,
      debug: {
        urlListFromCache: list.fromCache,
        candidateCount: 0,
        scoredCandidates: [],
        fetched: [],
        passedToGpt: [],
        routeMatches: matchSiteRoutes(userMessage).map((r) => r.id),
      },
    };
  }

  const preScored = entries
    .map((e) => {
      const { score, reasons } = scoreUrlEntryForQuery(userMessage, e, routeBoostMap);
      return { entry: e, score, reasons };
    })
    .sort((a, b) => b.score - a.score);

  const positive = preScored.filter((s) => s.score > 0);
  const pickSource = positive.length ? positive : preScored;
  const picked = pickSource.slice(0, maxPages);

  const chunks = (
    await Promise.all(
      picked.map(({ entry }) =>
        fetchPageChunk(entry.url, maxChars, {
          lastmod: entry.lastmod,
          pageType: entry.pageType,
        })
      )
    )
  ).filter(Boolean);

  // 本文取得後に再スコア
  const rescored = chunks
    .map((c) => {
      const { score, reasons } = scoreChunkForQuery(userMessage, c, routeBoostMap);
      return { ...c, score, scoreReasons: reasons };
    })
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  const topScore = rescored[0]?.score || 0;
  // 先頭と大きく差がある低関連ページは GPT に渡さない（誤根拠防止）
  const strong = rescored.filter(
    (c) => (c.score || 0) >= MIN_SNIPPET_SCORE && (c.score || 0) >= topScore * 0.72
  );

  return {
    chunks: strong,
    allScoredChunks: rescored,
    referenceUrls: strong.map((c) => c.url).slice(0, 40),
    knowledgeText: "",
    error: strong.length ? null : rescored.length ? "low_score" : "no_chunks",
    fetchMode: list.fetchMode,
    debug: {
      urlListFromCache: Boolean(list.fromCache),
      forceRefresh: Boolean(opts.forceRefresh),
      minSnippetScore: MIN_SNIPPET_SCORE,
      candidateCount: entries.length,
      routeMatches: matchSiteRoutes(userMessage).map((r) => ({
        id: r.id,
        label: r.label,
        urls: r.urls,
      })),
      scoredCandidates: pickSource.slice(0, 20).map((s) => ({
        url: s.entry.url,
        pageType: s.entry.pageType,
        lastmod: s.entry.lastmod,
        preScore: s.score,
        reasons: s.reasons,
      })),
      fetched: rescored.map((c) => ({
        url: c.url,
        pageType: c.pageType,
        lastmod: c.lastmod,
        score: c.score,
        reasons: c.scoreReasons,
        charCount: c.charCount,
        title: c.title,
      })),
      passedToGpt: strong.slice(0, SNIPPET_TOP_CHUNKS).map((c) => ({
        url: c.url,
        score: c.score,
        charCount: c.charCount,
      })),
    },
  };
}

export function labelForKnowledgeChunk(c) {
  const title = (c.title || "").trim();
  const pipeParts = title.split(/[｜|]/).map((x) => x.trim()).filter(Boolean);
  if (pipeParts.length >= 2) {
    const head = pipeParts[0];
    if (head.length >= 2 && head.length <= 100) return head;
  }
  if (c.h1?.[0]) return c.h1[0];
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

export function selectReferencedChunks(userMessage, state) {
  if (isSinglePageOnlyState(state)) {
    return (state.chunks || []).filter(Boolean).slice(0, SNIPPET_TOP_CHUNKS);
  }
  const chunks = state?.chunks || [];
  if (!chunks.length) return [];
  // すでにスコア済みならそのまま上位
  const sorted = [...chunks].sort((a, b) => (b.score || 0) - (a.score || 0));
  return sorted.filter((c) => (c.score || 0) >= MIN_SNIPPET_SCORE).slice(0, SNIPPET_TOP_CHUNKS);
}

export function sourcePagesFromChunks(chunks) {
  const seen = new Set();
  const out = [];
  for (const c of chunks || []) {
    const url = rewriteLegacyKanaiUrl(c?.url);
    if (!url || seen.has(url) || isGenericKanaiHomeUrl(url)) continue;
    // 低スコアはチップに出さない
    if (typeof c.score === "number" && c.score < MIN_SNIPPET_SCORE) continue;
    seen.add(url);
    out.push({
      url,
      title: String(labelForKnowledgeChunk(c)).replace(/\s+/g, " ").trim() || url,
    });
  }
  return out;
}

export function buildSiteKnowledgeSnippet(
  userMessage,
  state,
  { includeReferenceUrlList = true } = {}
) {
  if (isSinglePageOnlyState(state) && (state.chunks || []).length) {
    const use = state.chunks;
    const parts = use.map((c) => {
      const lm = c.lastmod ? `\n更新: ${c.lastmod}` : "";
      return `【${labelForKnowledgeChunk(c)}】\nURL: ${c.url}${lm}\nページ種別: ${c.pageType || "fixed"}\n${c.text}`;
    });
    const label = String(state.singlePageTitle || "指定ページ");
    return {
      snippet: `【当院公式サイトからの抜粋（${label}のページのみ。他ページの情報は含みません）】\n\n${parts.join(
        "\n\n---\n\n"
      )}`,
      sourceChunks: use,
      confidence: "high",
    };
  }

  const use = selectReferencedChunks(userMessage, state);
  if (!use.length) {
    return { snippet: "", sourceChunks: [], confidence: "none" };
  }

  const parts = use.map((c) => {
    const lm = c.lastmod ? `\n更新: ${c.lastmod}` : "";
    return `【${labelForKnowledgeChunk(c)}】\nURL: ${c.url}${lm}\nページ種別: ${c.pageType || "other"}\n${c.text}`;
  });
  let snippet = `【当院公式サイトからの抜粋（関連・鮮度を考慮して選定。これが院内情報の根拠です）】\n\n${parts.join(
    "\n\n---\n\n"
  )}`;
  if (includeReferenceUrlList && state?.referenceUrls?.length) {
    snippet += `\n\n【参考URL】\n${state.referenceUrls
      .slice(0, 8)
      .map((u) => `・${u}`)
      .join("\n")}`;
  }
  const top = use[0]?.score || 0;
  const confidence = top >= MIN_SNIPPET_SCORE + 40 ? "high" : "low";
  return { snippet, sourceChunks: use, confidence };
}

function buildSinglePageSnippet(state, fallbackTitle, fallbackUrl) {
  const c = state.chunks?.[0];
  if (c) {
    c.score = Math.max(c.score || 0, MIN_SNIPPET_SCORE + 80);
    return {
      snippet: `【当院公式サイトからの抜粋（${state.singlePageTitle || fallbackTitle}のページのみ。他ページの情報は含みません）】\n\n【${labelForKnowledgeChunk(
        c
      )}】\nURL: ${c.url}\n${c.lastmod ? `更新: ${c.lastmod}\n` : ""}${c.text}`,
      sourceChunks: [c],
      confidence: "high",
    };
  }
  return {
    snippet: "",
    sourceChunks: [],
    confidence: "none",
  };
}

/**
 * @param {string} userMessage
 * @param {{ forceRefresh?: boolean, includeDebug?: boolean }} [opts]
 */
export async function getSiteKnowledgeSnippetSupplement(userMessage, opts = {}) {
  if (isAttendFocusedQuery(userMessage)) {
    const state = await loadAttendPageOnlyState();
    const built = buildSinglePageSnippet(state, "立ち会い分娩について", ATTEND_INFO_PAGE_URL);
    return {
      ...built,
      state,
      debug: opts.includeDebug
        ? { mode: "attend_only", url: ATTEND_INFO_PAGE_URL, forceRefresh: opts.forceRefresh }
        : undefined,
    };
  }
  if (isMeetingFocusedQuery(userMessage)) {
    const state = await loadMeetingPageOnlyState();
    const built = buildSinglePageSnippet(state, "面会について", MEETING_INFO_PAGE_URL);
    return {
      ...built,
      state,
      debug: opts.includeDebug
        ? { mode: "meeting_only", url: MEETING_INFO_PAGE_URL, forceRefresh: opts.forceRefresh }
        : undefined,
    };
  }

  const built = await loadFreshKnowledgeForQuery(
    userMessage,
    DEFAULT_MAX_PAGES,
    DEFAULT_MAX_CHARS,
    opts
  );
  const state = {
    chunks: built.chunks,
    referenceUrls: built.referenceUrls,
    knowledgeText: built.knowledgeText,
    error: built.error,
    fetchMode: built.fetchMode,
  };
  const { snippet, sourceChunks, confidence } = buildSiteKnowledgeSnippet(userMessage, state, {
    includeReferenceUrlList: false,
  });

  memoryCache = {
    at: Date.now(),
    chunks: built.chunks,
    referenceUrls: built.referenceUrls,
    knowledgeText: built.knowledgeText,
    error: built.error,
    fetchMode: built.fetchMode ?? null,
  };

  return {
    snippet,
    sourceChunks,
    confidence,
    state,
    debug: opts.includeDebug ? built.debug : undefined,
  };
}

/** @deprecated */
export async function getSiteKnowledgeSnippet(userMessage, opts) {
  return getSiteKnowledgeSnippetSupplement(userMessage, opts);
}

/** 互換（本文キャッシュ利用時以外は都度取得） */
export async function ensureSiteKnowledgeLoaded(userMessage = "", opts = {}) {
  const built = await loadFreshKnowledgeForQuery(
    userMessage,
    DEFAULT_MAX_PAGES,
    DEFAULT_MAX_CHARS,
    opts
  );
  memoryCache = {
    at: Date.now(),
    chunks: built.chunks,
    referenceUrls: built.referenceUrls,
    knowledgeText: built.knowledgeText,
    error: built.error,
    fetchMode: built.fetchMode ?? null,
  };
  return { ...memoryCache, fromCache: "fresh", debug: built.debug };
}

export function peekSiteKnowledgeStatus() {
  const now = Date.now();
  return {
    cacheBodies: CACHE_BODIES,
    memoryCached: CACHE_BODIES && memoryCache.chunks.length > 0,
    chunkCount: memoryCache.chunks.length,
    lastError: memoryCache.error,
    fetchMode: memoryCache.fetchMode,
    urlListCached: urlListCache.entries.length > 0 && now - urlListCache.at < URL_LIST_TTL_MS,
    urlListCount: urlListCache.entries.length,
    sitemapEntryUrl: sitemapAllowCache.entryUrl || null,
    sitemapPathCount: sitemapAllowCache.paths?.size || 0,
    ttlMs: DEFAULT_TTL_MS,
    urlListTtlMs: URL_LIST_TTL_MS,
    maxPages: DEFAULT_MAX_PAGES,
    maxCharsPerPage: DEFAULT_MAX_CHARS,
    snippetTopChunks: SNIPPET_TOP_CHUNKS,
    minSnippetScore: MIN_SNIPPET_SCORE,
  };
}
