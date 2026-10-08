/**
 * 当院サイトの HTML を取得してテキスト化する（軽量RAG＋鮮度ルール）
 * - 既定: sitemap から URL+lastmod を収集
 * - SITE_PREFER_URL_LIST=true のときのみ SITE_URL_LIST を優先
 * - 本文は既定で毎回最新取得（SITE_KNOWLEDGE_CACHE_BODIES=true のときだけ短時間キャッシュ）
 * - sitemap URL一覧は短時間キャッシュ（SITE_URL_LIST_TTL_MS、既定30分）
 * - 正規ルート辞書: data/site-route-map.js（優先取得。絶対正解ではない）
 */

import { Redis } from "@upstash/redis";
import {
  gynecologyPageSupportsQuery,
  isAttendFocusedMessage,
  isChildVaccinationQuery,
  isDeliveryBenefitsFocusedMessage,
  isGynecologyTopicMessage,
  isHospitalBagQuery,
  isPhotoRecordingFocusedMessage,
  isVisitFocusedMessage,
  matchGynecologyTopicGroups,
  matchSiteRoutes,
  preferredUrlsForMessage,
} from "../data/site-route-map.js";

const RSV_BONUS_PAGE_URL = "https://kanai.or.jp/obstetrics/rsv_bonus/";
export const HOSPITAL_BAG_PAGE_URL =
  "https://kanai.or.jp/obstetrics/childbirth/#hos_bring";
const HOSPITAL_BAG_PAGE_BARE = "https://kanai.or.jp/obstetrics/childbirth/";

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
/** 参照チップに出す最低スコア（根拠URLのみ表示） */
const MIN_CHIP_SCORE = Math.max(
  MIN_SNIPPET_SCORE,
  parseInt(process.env.SITE_MIN_CHIP_SCORE || "90", 10) || 90
);
/** clinic-knowledge 強ヒット時にサイト根拠として採用する最低スコア */
const MIN_SITE_EVIDENCE_WITH_CLINIC = Math.max(
  MIN_CHIP_SCORE,
  parseInt(process.env.SITE_MIN_EVIDENCE_WITH_CLINIC || "120", 10) || 120
);

/** 1語だけで投稿を高評価しない汎用語 */
const GENERIC_SCORE_TOKENS = new Set([
  "変更",
  "予約",
  "母乳",
  "教室",
  "診療",
  "休み",
  "費用",
  "相談",
  "受付",
  "時間",
  "案内",
  "お知らせ",
  "開催",
  "曜日",
  "について",
]);

/** 鮮度の効くお知らせを残したい質問 */
export function needsNewsFreshnessQuery(userMessage) {
  return /今日|本日|明日|明後日|今週|休診|ワクチン|インフルエンザ|予防接種|面会制限|受付変更|臨時/.test(
    String(userMessage || "")
  );
}
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

/** id を持つ要素をネスト対応で切り出す */
function extractElementById(html, id) {
  const re = new RegExp(
    `<([a-z0-9]+)([^>]*\\bid=["']${id}["'][^>]*)>`,
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
 * 見出し・箇条書きの親子関係を残してテキスト化する
 * （分類見出しが消えてリストだけになるのを防ぐ）
 */
function htmlToStructuredText(html) {
  let h = String(html || "");
  h = h.replace(/<!--[\s\S]*?-->/g, " ");
  h = h.replace(/<script[\s\S]*?<\/script>/gi, " ");
  h = h.replace(/<style[\s\S]*?<\/style>/gi, " ");
  h = h.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, __, inner) => {
    const t = stripTagsToText(inner);
    return t ? `\n\n【${t}】\n` : "\n";
  });
  h = h.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, inner) => {
    const t = stripTagsToText(inner);
    return t ? `\n${t}\n` : "\n";
  });
  h = h.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => {
    const t = stripTagsToText(inner);
    return t ? `\n・${t}` : "";
  });
  h = h.replace(/<br\s*\/?>/gi, "\n");
  h = h.replace(/<\/(?:div|section|ul|ol|table|tr)>/gi, "\n");
  h = h.replace(/<[^>]+>/g, " ");
  h = h
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  h = h.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ");
  return h.trim();
}

/**
 * 質問に応じてページ内セクションを優先抽出
 * @param {string} html
 * @param {string} url
 * @param {{ focusAnchor?: string, focusHospitalBag?: boolean }} [opts]
 */
function extractFocusedHtml(html, url, opts = {}) {
  const hash = String(opts.focusAnchor || url.split("#")[1] || "").trim();
  if (hash === "hos_bring" || opts.focusHospitalBag) {
    const sec =
      extractElementById(html, "hos_bring") ||
      extractElementByClass(html, "hos_bring");
    if (sec && stripTagsToText(sec).length > 80) return sec;
  }
  if (hash) {
    const byId = extractElementById(html, hash);
    if (byId && stripTagsToText(byId).length > 80) return byId;
  }
  return extractMainHtml(html);
}

/**
 * @param {string} url
 * @param {number} maxChars
 * @param {{ lastmod?: string|null, pageType?: PageType, focusHospitalBag?: boolean, displayUrl?: string, displayTitle?: string }} [meta]
 * @returns {Promise<KnowledgeChunk|null>}
 */
async function fetchPageChunk(url, maxChars, meta = {}) {
  try {
    const fetchUrl = String(url || "").split("#")[0];
    const html = await fetchText(fetchUrl);
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const pageTitle = titleMatch
      ? titleMatch[1].replace(/\s+/g, " ").trim()
      : fetchUrl;
    const focusHospitalBag =
      Boolean(meta.focusHospitalBag) ||
      /#hos_bring/i.test(url) ||
      Boolean(meta.displayUrl && /#hos_bring/i.test(meta.displayUrl));
    const focusedHtml = extractFocusedHtml(html, url, {
      focusAnchor: String(url).includes("#") ? String(url).split("#")[1] : "",
      focusHospitalBag,
    });
    const useStructured = focusHospitalBag || /#hos_bring/i.test(url);
    const text = (
      useStructured
        ? htmlToStructuredText(focusedHtml)
        : htmlToText(focusedHtml)
    ).slice(0, maxChars);
    if (!text || text.length < 40) return null;
    const h1 = extractHeadings(focusedHtml, "h1");
    const h2 = [
      ...extractHeadings(focusedHtml, "h2"),
      ...extractHeadings(focusedHtml, "h3"),
    ].slice(0, 20);
    const { publishedAt, modifiedAt } = extractMetaDates(html);
    const pageType = meta.pageType || classifyPageType(fetchUrl);
    const lastmod = meta.lastmod || modifiedAt || publishedAt || null;
    const outUrl = meta.displayUrl || url;
    const title = meta.displayTitle || pageTitle;
    return {
      url: outUrl,
      title,
      text,
      h1: h1.length ? h1 : focusHospitalBag ? ["入院時の持ち物"] : h1,
      h2,
      pageType,
      lastmod,
      publishedAt,
      modifiedAt,
      charCount: text.length,
      matchedSection: focusHospitalBag ? "hos_bring" : url.split("#")[1] || null,
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
  return isVisitFocusedMessage(userMessage);
}

export function isAttendFocusedQuery(userMessage) {
  return isAttendFocusedMessage(userMessage);
}

export function isPhotoRecordingFocusedQuery(userMessage) {
  return isPhotoRecordingFocusedMessage(userMessage);
}

/** Asia/Tokyo の現在日時パーツ */
export function getTokyoNowParts(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).filter((p) => p.type !== "literal").map((p) => [p.type, p.value])
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const weekdayEn = String(parts.weekday || "");
  const weekdayJa =
    { Sun: "日", Mon: "月", Tue: "火", Wed: "水", Thu: "木", Fri: "金", Sat: "土" }[
      weekdayEn
    ] || "";
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return {
    year,
    month,
    day,
    hour,
    minute,
    weekdayJa,
    ymd: `${year}-${mm}-${dd}`,
  };
}

/** @param {{ year: number, month: number, day: number }} d */
export function formatJaYmd(d) {
  return `${d.year}年${d.month}月${d.day}日`;
}

function addTokyoDays(parts, deltaDays) {
  // UTC noon で日付加算し、Asia/Tokyo の暦日ずれを避ける
  const utc = Date.UTC(parts.year, parts.month - 1, parts.day + deltaDays, 12, 0, 0);
  return getTokyoNowParts(new Date(utc));
}

/**
 * 相対日付・明示日付を含む質問か（GPTへ現在日時を渡す対象）
 * @param {string} userMessage
 */
export function needsExplicitTokyoDatetime(userMessage) {
  const msg = String(userMessage || "");
  return /今日|本日|明日|明後日|今週|\d{1,2}月\d{1,2}日|\d{4}年\d{1,2}月\d{1,2}日|\d{4}\/\d{1,2}\/\d{1,2}|\d{1,2}\/\d{1,2}/.test(
    msg
  );
}

/**
 * GPT向け：現在日時を明示する system 文（ユーザー質問文は変更しない）
 * @param {string} userMessage
 * @param {Date} [now]
 */
export function buildTokyoDatetimeSystemPrompt(userMessage, now = new Date()) {
  if (!needsExplicitTokyoDatetime(userMessage)) return "";
  const p = getTokyoNowParts(now);
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  const wd = p.weekdayJa ? `（${p.weekdayJa}）` : "";
  return [
    "【現在日時（Asia/Tokyo。この値を基準に「今日」「明日」等を解釈すること。推測しない）】",
    `現在日時: ${formatJaYmd(p)}${wd} ${hh}:${mm} JST`,
    `ユーザーの質問: ${String(userMessage || "").trim()}`,
  ].join("\n");
}

/**
 * 検索スコア用の内部クエリ（ユーザー表示文は変えない）
 * 例: 「今日の午後は…」→「今日 2026年10月8日 午後 …」
 * @param {string} userMessage
 * @param {Date} [now]
 */
/**
 * 「休診のお知らせ（本日）」等で、具体日が今日以外の案内を本文から除去する。
 * トップの診療時間表は残し、誤った休診断定だけを防ぐ。
 * @param {string} text
 * @param {Date} [now]
 */
export function stripStaleTodayClosedNotices(text, now = new Date()) {
  const p = getTokyoNowParts(now);
  const todayO = ymdToOrdinal(p);
  let out = String(text || "");

  // トップの一覧テaser「休診のお知らせ（本日）」は本文日付が無いことが多い。
  // 前後120文字に「今日」の具体日が無い場合はタイトルごと除去する。
  out = out.replace(/休診のお知らせ[（(]本日[）)]/g, (match, offset, whole) => {
    const window = String(whole).slice(Math.max(0, offset - 120), offset + match.length + 160);
    const dates = extractMentionedDates(window, p);
    if (dates.some((d) => ymdToOrdinal(d) === todayO)) return match;
    return "";
  });

  out = out.replace(
    /本日[、,]?\s*\d{1,2}\s*月\s*\d{1,2}\s*日[^\n。]{0,100}休診[^\n。]{0,60}[。\n]?/g,
    (line) => {
      const dates = extractMentionedDates(line, p);
      if (dates.some((d) => ymdToOrdinal(d) === todayO)) return line;
      return "";
    }
  );

  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function expandQueryForSearch(userMessage, now = new Date()) {
  const msg = String(userMessage || "").trim();
  if (!msg) return msg;
  const today = getTokyoNowParts(now);
  const tomorrow = addTokyoDays(today, 1);
  const dayAfter = addTokyoDays(today, 2);
  const extras = [];
  if (/今日|本日/.test(msg)) extras.push(formatJaYmd(today));
  if (/明日/.test(msg)) extras.push(formatJaYmd(tomorrow));
  if (/明後日/.test(msg)) extras.push(formatJaYmd(dayAfter));
  if (/今週/.test(msg)) {
    extras.push(formatJaYmd(today), formatJaYmd(tomorrow), formatJaYmd(dayAfter));
  }
  // 休診語は「休み/休診」を聞かれたときだけ足す（診療予約質問に休診を混ぜない）
  if (/休み|休診|やってる|開いて/.test(msg)) {
    extras.push("休診", "診療");
  } else if (/診察|診療|診て/.test(msg)) {
    extras.push("診療時間", "午前診", "午後診");
  }
  if (isDeliveryBenefitsFocusedMessage(msg)) {
    extras.push("分娩予約特典", "割引", "特典", "プレゼント");
    if (/ディナー|食事|招待|家族|夫/.test(msg)) {
      extras.push("お祝いディナーご招待", "ご家族様1名");
    }
  }
  if (isPhotoRecordingFocusedMessage(msg)) {
    extras.push("院内撮影禁止", "写真", "動画", "録音", "患者さまへのお願い");
  }
  // 婦人科: アフターピル↔緊急避妊薬、性病↔性感染症 などの表記ゆれを吸収
  for (const g of matchGynecologyTopicGroups(msg)) {
    for (const term of g.expand || []) {
      if (term && !extras.includes(term)) extras.push(term);
    }
  }
  if (!extras.length) return msg;
  return `${msg} ${extras.join(" ")}`.replace(/\s+/g, " ").trim();
}

/**
 * タイトル・本文から具体日付を抽出（YYYY年M月D日 / M月D日 / YYYY/MM/DD / M/D）
 * @param {string} text
 * @param {{ year: number }} refYear
 * @returns {Array<{ year: number, month: number, day: number, ymd: string }>}
 */
export function extractMentionedDates(text, refYear) {
  const s = String(text || "");
  const out = [];
  const seen = new Set();
  const push = (y, m, d) => {
    if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return;
    const ymd = `${y}-${m}-${d}`;
    if (seen.has(ymd)) return;
    seen.add(ymd);
    out.push({ year: y, month: m, day: d, ymd });
  };
  for (const m of s.matchAll(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
    push(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  // YYYY/MM/DD・YYYY-MM-DD（ドット区切り YYYY.MM.DD は更新日表記が多いので除外）
  for (const m of s.matchAll(/(\d{4})\s*[\/-]\s*(\d{1,2})\s*[\/-]\s*(\d{1,2})/g)) {
    push(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  for (const m of s.matchAll(/(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
    push(Number(refYear.year), Number(m[1]), Number(m[2]));
  }
  for (const m of s.matchAll(/(?<!\d)(\d{1,2})\s*\/\s*(\d{1,2})(?!\s*[\/.-]\s*\d)/g)) {
    push(Number(refYear.year), Number(m[1]), Number(m[2]));
  }
  // タイトル用: （11-27） / 11-27（年付き YYYY-MM-DD は上で処理済み）
  for (const m of s.matchAll(/(?<!\d)(\d{1,2})\s*-\s*(\d{1,2})(?!\d)/g)) {
    push(Number(refYear.year), Number(m[1]), Number(m[2]));
  }
  return out;
}

function ymdToOrdinal(d) {
  return d.year * 10000 + d.month * 100 + d.day;
}

/**
 * 「今日/明日」質問と本文内の具体日付の整合で加減点
 * お知らせだけでなく、トップ等に埋め込まれた「本日＝別日」の休診案内にも適用する
 * @returns {{ points: number, reason: string|null }}
 */
function datedNoticeAdjustment(userMessage, chunk, nowParts) {
  const msg = String(userMessage || "");
  if (!/今日|本日|明日|明後日|今週/.test(msg)) {
    return { points: 0, reason: null };
  }
  const pageType = chunk.pageType || classifyPageType(chunk.url);
  const hay = `${chunk.title || ""}\n${(chunk.h1 || []).join(" ")}\n${chunk.text || ""}`;
  // 休診・診療系でなければ日付加点しない（教室曜日変更などの誤爆防止）
  if (!/休診|午後診|午前診|夜診|診療|診察|外来/.test(hay)) {
    return { points: 0, reason: null };
  }
  // 固定ページは、休診お知らせが本文に埋め込まれている場合のみ日付整合を見る
  if (pageType !== "news" && !/休診のお知らせ|本日[、,]\s*\d{1,2}月/.test(hay)) {
    return { points: 0, reason: null };
  }
  const dates = extractMentionedDates(hay, nowParts);
  const todayO = ymdToOrdinal(nowParts);
  const tomorrowO = ymdToOrdinal(addTokyoDays(nowParts, 1));
  const dayAfterO = ymdToOrdinal(addTokyoDays(nowParts, 2));

  let target = null;
  if (/今日|本日/.test(msg)) target = todayO;
  else if (/明後日/.test(msg)) target = dayAfterO;
  else if (/明日/.test(msg)) target = tomorrowO;

  // 「休診のお知らせ（本日）」だが本文の具体日が今日以外
  // → 診療時間表がある固定ページは減点せず本文サニタイズに任せる（スケジュール根拠を残す）
  // → それ以外（お知らせ単体など）は大きく減点
  if (
    target === todayO &&
    /休診のお知らせ（本日）|本日[、,]?\s*\d{1,2}\s*月\s*\d{1,2}\s*日/.test(hay)
  ) {
    const ordsProbe = dates.map(ymdToOrdinal);
    if (ordsProbe.length && !ordsProbe.includes(todayO)) {
      const hasScheduleTable =
        /診療時間/.test(hay) && /午前診/.test(hay) && /午後診/.test(hay);
      if (hasScheduleTable) {
        return {
          points: 0,
          reason: "本日表記の休診は対象外（診療時間表は維持・本文除去）",
        };
      }
      return {
        points: -180,
        reason: "本日表記の休診だが対象日が今日以外(-180)",
      };
    }
  }

  if (!dates.length) return { points: 0, reason: null };

  const ords = dates.map(ymdToOrdinal);
  const maxOrd = Math.max(...ords);
  const minOrd = Math.min(...ords);
  const hasScheduleTable =
    /診療時間/.test(hay) && /午前診/.test(hay) && /午後診/.test(hay);

  // 対象日と一致するお知らせは高評価
  if (target != null && ords.includes(target)) {
    return { points: 120, reason: `お知らせ日付が質問日と一致(+120)` };
  }
  // 今週で、今日以降の日付を含む
  if (/今週/.test(msg) && maxOrd >= todayO) {
    return { points: 60, reason: `今週内の未来日付お知らせ(+60)` };
  }
  // 過去日付のみ → お知らせ投稿は大きく減点。診療時間表付き固定ページは減点しない
  if (maxOrd < todayO) {
    if (pageType === "fixed" && hasScheduleTable) {
      return {
        points: 0,
        reason: "過去日付お知らせは無視（診療時間表は維持）",
      };
    }
    return { points: -200, reason: `過去日付のお知らせ(-200)` };
  }
  // 今日/明日質問で、日付はあるが対象外の未来日
  if (target != null && minOrd > target && minOrd > todayO) {
    if (pageType === "fixed" && hasScheduleTable) {
      return { points: 0, reason: null };
    }
    return { points: -40, reason: `対象日以外の未来お知らせ(-40)` };
  }
  return { points: 0, reason: null };
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

async function loadHospitalBagPageOnlyState() {
  const chunk = await fetchPageChunk(HOSPITAL_BAG_PAGE_URL, Math.max(DEFAULT_MAX_CHARS, 4500), {
    pageType: "fixed",
    focusHospitalBag: true,
    displayUrl: HOSPITAL_BAG_PAGE_URL,
    displayTitle: "入院時の持ち物について",
  });
  const chunks = chunk ? [chunk] : [];
  return {
    chunks,
    referenceUrls: [],
    knowledgeText: chunks.length
      ? chunks
          .map((c) => `【${c.title}】\nURL: ${c.url}\n${c.text}`)
          .join("\n\n")
      : `【入院時の持ち物について】\n${HOSPITAL_BAG_PAGE_URL} の本文を取得できませんでした。`,
    error: chunks.length ? null : "hospital_bag_only_failed",
    fetchMode: "hospital_bag_only",
    hospitalBagOnly: true,
    singlePageOnly: true,
    singlePageTitle: "入院時の持ち物について",
    singlePageUrl: HOSPITAL_BAG_PAGE_URL,
  };
}

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
function scoreChunkForQuery(userMessage, chunk, routeBoostMap, now = new Date()) {
  const originalMsg = String(userMessage || "");
  const searchMsg = expandQueryForSearch(originalMsg, now);
  const msg = searchMsg;
  const reasons = [];
  let score = 0;
  const tokyoNow = getTokyoNowParts(now);

  const bareUrl = String(chunk.url || "").split("#")[0];
  const pageType = chunk.pageType || classifyPageType(bareUrl);
  const typePts = pageTypeBasePoints(pageType);
  score += typePts.points;
  reasons.push(`${typePts.reason}(+${typePts.points})`);

  const fresh = freshnessPoints(chunk.lastmod || chunk.modifiedAt, pageType);
  // 鮮度は「関連がある」場合のみ後で加点（新しい＝関連、にしない）

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
  const bodyHead = body.slice(0, 500);
  const hayTitle = `${title}\n${h1}\n${h2}`.toLowerCase();
  const hayBody = body.toLowerCase();
  const hayBodyHead = bodyHead.toLowerCase();
  const tokens = tokenizeUserMessageForScoring(msg);
  const userLower = originalMsg.toLowerCase();

  let rel = 0;
  let specificHits = 0;
  let genericHits = 0;
  let titleSpecificHits = 0;
  let titleAnyHits = 0;
  for (const tok of tokens) {
    const t = tok.toLowerCase();
    if (t.length < 2) continue;
    const isGeneric = GENERIC_SCORE_TOKENS.has(tok) || GENERIC_SCORE_TOKENS.has(t);
    const inTitle = hayTitle.includes(t);
    const inBodyHead = hayBodyHead.includes(t);
    const inBody = hayBody.includes(t);
    if (!inTitle && !inBody) continue;

    if (inTitle) titleAnyHits += 1;
    if (isGeneric) {
      genericHits += 1;
      // 汎用語は加点を大幅に抑える（投稿の誤爆防止）
      if (pageType === "news") {
        rel += inTitle ? 2 : 1;
      } else {
        rel += inTitle ? Math.min(t.length * 2, 6) : 2;
        if (inTitle) reasons.push(`見出し一致:${tok}`);
      }
    } else {
      specificHits += 1;
      if (inTitle) {
        titleSpecificHits += 1;
        rel += t.length * 6;
        reasons.push(`見出し一致:${tok}`);
      } else if (inBodyHead) {
        rel += t.length * 4;
      } else if (inBody) {
        rel += t.length * 3;
      } else if (t.length === 2 && FACILITY_2CHAR.has(t) && inBody) {
        rel += 8;
      }
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
    [isVisitFocusedMessage, /面会|#visit|hospitalization|お見舞い/],
    [isAttendFocusedMessage, /立ち会い|立会い|#assist_birth|childbirth/],
    [
      isPhotoRecordingFocusedMessage,
      /院内撮影|撮影禁止|写真|動画|録音|notpermit|患者さまへのお願い|患者様へのお願い/,
    ],
    [(m) => /里帰り/.test(m), /里帰り|#homecoming/],
    [
      (m) =>
        /インフルエンザ|ワクチン|予防接種/.test(m) && !isChildVaccinationQuery(m),
      /ワクチン|インフルエンザ|\/vaccine/,
    ],
    [(m) => /子宮頸がん|子宮がん検診/.test(m), /子宮頸がん|子宮がん検診|\/gynecology/],
    [(m) => /産後ケア|産後サポート/.test(m), /産後ケア|産後サポート|\/aftersupport/],
    [(m) => /休診|診療時間|午後診|午前診|今日|本日|明日/.test(m), /休診|診療時間|午前診|午後診|夜診/],
    [isDeliveryBenefitsFocusedMessage, /分娩予約特典|rsv_bonus|出産費用割引|お祝いディナー|特典|割引|プレゼント/],
    [(m) => /分娩予約/.test(m), /分娩予約|分娩/],
    [(m) => /料金|費用|いくらかか|入院費|自己負担/.test(m), /費用|料金|#price_birth|円/],
    [
      isGynecologyTopicMessage,
      /\/gynecology\/|婦人科|アフターピル|緊急避妊|性感染症|更年期|月経|ブライダルチェック/,
    ],
    [
      isHospitalBagQuery,
      /入院時の持ち物|#hos_bring|ご用意いただく物|当院でご用意|分娩セット|シャンプー|スリッパ/,
    ],
  ];
  const hayAll = `${hayTitle}\n${hayBody}\n${bareUrl}`;
  for (const [msgTest, hayRe] of topicPairs) {
    const hit =
      typeof msgTest === "function" ? msgTest(originalMsg) : msgTest.test(originalMsg);
    if (hit && hayRe.test(hayAll)) {
      rel += 50;
      reasons.push("トピック一致(+50)");
      break;
    }
  }

  // 婦人科同義語: 質問語とページ記載の表記差を吸収（性病↔性感染症 等）
  const gyneGroups = matchGynecologyTopicGroups(originalMsg);
  let gyneContentHit = false;
  for (const g of gyneGroups) {
    if (g.page.test(hayAll)) {
      gyneContentHit = true;
      rel += 45;
      specificHits += 1;
      reasons.push(`婦人科トピック本文一致:${g.id}(+45)`);
      break;
    }
  }
  const hasPageContent = Boolean(title.trim() || body.trim());
  // ルート辞書で婦人科を優先しても、該当診療の記載が無いページは減点
  if (
    routeBoost > 0 &&
    /\/gynecology\//i.test(bareUrl) &&
    hasPageContent &&
    gyneGroups.length > 0 &&
    !gyneContentHit &&
    !gynecologyPageSupportsQuery(originalMsg, hayAll)
  ) {
    score -= routeBoost + 80;
    reasons.push("婦人科トピック未記載のためルート取消");
  }
  // お子さま予防接種の質問に妊婦向けワクチンページを根拠にしない
  if (isChildVaccinationQuery(originalMsg) && /\/vaccine\//i.test(bareUrl)) {
    score -= 200;
    reasons.push("お子さま予防接種のため妊婦向けワクチンページ除外(-200)");
  }

  // お知らせ本文の具体日付と「今日/明日」質問の整合（先に計算し、投稿ペナルティ判定で使う）
  const dateAdj = datedNoticeAdjustment(originalMsg, chunk, tokyoNow);

  // 関連度が十分あるときだけ鮮度を加点（順序: 関連 → その中で新しさ）
  const MIN_REL_FOR_FRESHNESS = 25;
  const relevanceOkForFreshness =
    rel >= MIN_REL_FOR_FRESHNESS ||
    specificHits >= 1 ||
    dateAdj.points > 0 ||
    (routeBoost > 0 && rel >= 10);
  if (relevanceOkForFreshness) {
    score += fresh.points;
    reasons.push(`鮮度:${fresh.reason}(${fresh.points >= 0 ? "+" : ""}${fresh.points})`);
  } else if (fresh.points !== 0) {
    reasons.push(`鮮度不加点(関連不足 rel=${rel})`);
  }

  // 投稿ページ: 意図一致を厳しく（1語・汎用語のみは原則不採用）
  // ※ URL段階（title/本文なし）ではペナルティしない（本文取得前に候補落ちするのを防ぐ）
  const hasContent = hasPageContent;
  if (pageType === "news" && hasContent) {
    // 対象日一致（dateAdj>0）または、日付が取れない鮮度系お知らせのみ「強い意図」
    // 未来の別日休診（dateAdj<0）はここに入れない
    const strongFreshIntent =
      dateAdj.points > 0 ||
      (dateAdj.points === 0 &&
        /休診|ワクチン|インフルエンザ|面会制限|受付変更|臨時/.test(hayTitle) &&
        needsNewsFreshnessQuery(originalMsg) &&
        specificHits >= 1 &&
        titleAnyHits >= 1 &&
        fresh.points >= 45);

    if (!strongFreshIntent) {
      if (specificHits === 0 && genericHits >= 1) {
        score -= 140;
        reasons.push("投稿:汎用語のみ一致(-140)");
      } else if (specificHits + genericHits <= 1) {
        score -= 120;
        reasons.push("投稿:一致語1語のみ(-120)");
      } else if (specificHits < 1 || titleSpecificHits < 1) {
        score -= 70;
        reasons.push("投稿:タイトル意図一致不足(-70)");
      }
      // 本文が薄い投稿
      if ((chunk.charCount || body.length) < 80) {
        score -= 30;
        reasons.push("投稿:本文薄い(-30)");
      }
    } else if (specificHits >= 1 || dateAdj.points > 0) {
      // 鮮度が重要な意図一致投稿は高評価を維持（関連確認済みのときのみ）
      if (relevanceOkForFreshness && fresh.points >= 70) {
        score += 30;
        reasons.push("投稿:鮮度重要かつ意図一致(+30)");
      }
    }

    if (rel < 30 && fresh.points < 40) {
      score -= 25;
      reasons.push("古い投稿かつ低関連(-25)");
    }
  }

  // 絶対関連度ガード: 関連がほぼ無いページは総合点を大きく落とす
  if (hasContent && rel < 12 && specificHits === 0 && routeBoost === 0 && dateAdj.points <= 0) {
    score -= 80;
    reasons.push(`絶対関連不足(-80 rel=${rel})`);
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
  // 新しいお知らせで関連が高いときは固定ページを超えられる（意図一致が十分なとき）
  if (
    pageType === "news" &&
    relevanceOkForFreshness &&
    specificHits >= 1 &&
    specificHits + genericHits >= 2 &&
    titleAnyHits >= 1 &&
    rel >= 40 &&
    fresh.points >= 70
  ) {
    score += 40;
    reasons.push("新しい関連お知らせ(+40)");
  }

  if (dateAdj.reason) {
    score += dateAdj.points;
    reasons.push(dateAdj.reason);
  }

  // 「今日/明日の診療」系は直近の休診お知らせを優先（関連がある場合のみ）
  if (
    relevanceOkForFreshness &&
    /今日|明日|明後日|今週|午後は診|午前は診|休診|本日/.test(originalMsg) &&
    pageType === "news" &&
    (/休診/.test(hayBody) || /休診/.test(hayTitle)) &&
    dateAdj.points >= 0
  ) {
    // 対象日一致ならさらに強く、日付なしの新着は控えめ
    const boost = dateAdj.points > 0 ? 80 : fresh.points >= 70 ? 50 : 10;
    score += boost;
    reasons.push(`休診お知らせ加点(+${boost})`);
  }
  // 日付のある臨時質問では、通常の診療時間表だけの固定ページ加点を抑える
  if (/今日|明日|明後日|本日|今週/.test(originalMsg) && pageType === "fixed" && routeBoost > 0) {
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

  return { score, reasons: uniqReasons.slice(0, 14) };
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
function scoreUrlEntryForQuery(userMessage, entry, routeBoostMap, now = new Date()) {
  const stub = {
    url: entry.url,
    title: "",
    text: "",
    h1: [],
    h2: [],
    pageType: entry.pageType || classifyPageType(entry.url),
    lastmod: entry.lastmod,
  };
  return scoreChunkForQuery(userMessage, stub, routeBoostMap, now);
}

/**
 * 本文に「分娩予約特典」リンク言及がある／特典質問なのに実ページ未取得なら追加取得する
 * @param {KnowledgeChunk[]} chunks
 * @param {string} userMessage
 * @param {number} maxChars
 */
async function ensureLinkedBenefitPageFetched(chunks, userMessage, maxChars) {
  const list = Array.isArray(chunks) ? [...chunks] : [];
  const hasBonus = list.some((c) => /\/obstetrics\/rsv_bonus\/?/i.test(String(c?.url || "")));
  if (hasBonus) return list;

  const benefitsQuery = isDeliveryBenefitsFocusedMessage(userMessage);
  const linkMention = list.some((c) => {
    const hay = `${c?.title || ""}\n${c?.text || ""}`;
    return /分娩予約特典|rsv_bonus|出産費用割引サービス|お祝いディナーご招待/.test(hay);
  });

  if (!benefitsQuery && !linkMention) return list;

  const bonus = await fetchPageChunk(RSV_BONUS_PAGE_URL, maxChars, {
    lastmod: null,
    pageType: "fixed",
  });
  if (bonus) {
    list.push(bonus);
  }
  return list;
}

async function loadFreshKnowledgeForQuery(
  userMessage,
  maxPages = DEFAULT_MAX_PAGES,
  maxChars = DEFAULT_MAX_CHARS,
  opts = {}
) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const searchQuery = expandQueryForSearch(userMessage, now);
  const list = await loadCandidateUrlList(opts);
  const routeBoostMap = buildRouteBoostMap(userMessage);
  const preferred = preferredUrlsForMessage(userMessage).map((u) => u.split("#")[0]);
  const clinicStrong = Boolean(opts.clinicKnowledgeStrong);
  const allowNews =
    !clinicStrong || needsNewsFreshnessQuery(userMessage) || Boolean(opts.allowNews);

  /** @type {UrlEntry[]} */
  let entries = [...(list.entries || [])];
  // 辞書の優先URLを候補先頭に必ず含める
  for (const u of preferred) {
    if (!entries.some((e) => e.url.split("#")[0] === u || e.url === u)) {
      entries.unshift({ url: u, lastmod: null, pageType: classifyPageType(u) });
    }
  }

  /** 除外ログ用 */
  const excludedCandidates = [];
  if (!allowNews) {
    const before = entries.length;
    entries = entries.filter((e) => {
      const pt = e.pageType || classifyPageType(e.url);
      if (pt === "news" || pt === "monologue") {
        excludedCandidates.push({
          url: e.url,
          reason: "clinic-knowledge強ヒットのため投稿候補を除外",
        });
        return false;
      }
      return true;
    });
    if (before && !entries.length) {
      // 固定が空なら preferred のみ残す
      entries = preferred.map((url) => ({
        url,
        lastmod: null,
        pageType: classifyPageType(url),
      }));
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
        candidateUrls: [],
        retrievedUrls: [],
        evidenceUrls: [],
        chipUrls: [],
        excludedUrls: excludedCandidates,
        scoredCandidates: [],
        fetched: [],
        passedToGpt: [],
        searchQuery,
        clinicKnowledgeStrong: clinicStrong,
        routeMatches: matchSiteRoutes(userMessage).map((r) => r.id),
      },
    };
  }

  const candidateUrls = entries.map((e) => e.url);
  const minSnippet = clinicStrong
    ? Math.max(MIN_SNIPPET_SCORE, Math.floor(MIN_SITE_EVIDENCE_WITH_CLINIC * 0.7))
    : MIN_SNIPPET_SCORE;

  const preScored = entries
    .map((e) => {
      const { score, reasons } = scoreUrlEntryForQuery(userMessage, e, routeBoostMap, now);
      return { entry: e, score, reasons };
    })
    .sort((a, b) => b.score - a.score);

  const positive = preScored.filter((s) => s.score > 0);
  const pickSource = positive.length ? positive : preScored;
  const picked = pickSource.slice(0, maxPages);

  /** @type {KnowledgeChunk[]} */
  let chunks = (
    await Promise.all(
      picked.map(({ entry }) =>
        fetchPageChunk(entry.url, maxChars, {
          lastmod: entry.lastmod,
          pageType: entry.pageType,
        })
      )
    )
  ).filter(Boolean);

  // 他ページの「分娩予約特典はこちら」リンク文だけで答えず、実ページを追加取得
  chunks = await ensureLinkedBenefitPageFetched(chunks, userMessage, maxChars);

  const retrievedUrls = chunks.map((c) => c.url);

  // 本文取得後に再スコア（内部検索クエリ＋元質問の日付整合）
  const rescored = chunks
    .map((c) => {
      const { score, reasons } = scoreChunkForQuery(userMessage, c, routeBoostMap, now);
      return { ...c, score, scoreReasons: reasons };
    })
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  // clinic強ヒット時は投稿をさらに厳しく落とす
  for (const c of rescored) {
    if (
      clinicStrong &&
      (c.pageType === "news" || classifyPageType(c.url) === "news") &&
      !needsNewsFreshnessQuery(userMessage)
    ) {
      c.score = (c.score || 0) - 100;
      c.scoreReasons = [...(c.scoreReasons || []), "clinic強ヒット時の投稿減点(-100)"];
      excludedCandidates.push({
        url: c.url,
        reason: "clinic-knowledgeで回答可能のため投稿を減点",
        score: c.score,
      });
    }
  }
  rescored.sort((a, b) => (b.score || 0) - (a.score || 0));

  const topScore = rescored[0]?.score || 0;
  // 先頭と大きく差がある低関連ページは GPT に渡さない（誤根拠防止）
  let strong = rescored.filter(
    (c) => (c.score || 0) >= minSnippet && (c.score || 0) >= topScore * 0.72
  );
  // 日付不一致のお知らせは GPT 根拠からも除外
  if (needsNewsFreshnessQuery(userMessage)) {
    strong = strong.filter((c) => {
      const pt = c.pageType || classifyPageType(c.url);
      if (pt !== "news") return true;
      const bad = (c.scoreReasons || []).some((r) => /対象日以外|過去日付/.test(r));
      if (bad) {
        excludedCandidates.push({
          url: c.url,
          reason: "日付不一致のお知らせをGPT根拠除外",
          score: c.score,
        });
      }
      return !bad;
    });
  }

  const evidenceMeta = selectEvidenceAndChipUrls(strong, {
    clinicKnowledgeStrong: clinicStrong,
    userMessage,
  });

  return {
    chunks: strong,
    allScoredChunks: rescored,
    referenceUrls: evidenceMeta.evidenceUrls.map((e) => e.url).slice(0, 40),
    knowledgeText: "",
    error: strong.length ? null : rescored.length ? "low_score" : "no_chunks",
    fetchMode: list.fetchMode,
    evidenceUrls: evidenceMeta.evidenceUrls,
    chipUrls: evidenceMeta.chipUrls,
    debug: {
      urlListFromCache: Boolean(list.fromCache),
      forceRefresh: Boolean(opts.forceRefresh),
      minSnippetScore: minSnippet,
      minChipScore: MIN_CHIP_SCORE,
      clinicKnowledgeStrong: clinicStrong,
      allowNews,
      candidateCount: entries.length,
      candidateUrls: candidateUrls.slice(0, 40),
      retrievedUrls,
      evidenceUrls: evidenceMeta.evidenceUrls,
      chipUrls: evidenceMeta.chipUrls,
      excludedUrls: [
        ...excludedCandidates,
        ...evidenceMeta.excluded.map((e) => ({
          url: e.url,
          reason: e.reason,
          score: e.score,
        })),
        ...rescored
          .filter((c) => !strong.some((s) => s.url === c.url))
          .map((c) => ({
            url: c.url,
            reason: `GPT根拠未満(score=${c.score}, min=${minSnippet})`,
            score: c.score,
          })),
      ].slice(0, 40),
      searchQuery,
      tokyoNow: formatJaYmd(getTokyoNowParts(now)),
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
        chipEligible: evidenceMeta.chipUrls.some((u) => u.url === rewriteLegacyKanaiUrl(c.url)),
      })),
    },
  };
}

/**
 * 回答根拠URLとチップURLを分離して選定
 * @param {KnowledgeChunk[]} chunks GPTに渡す候補
 * @param {{ clinicKnowledgeStrong?: boolean, userMessage?: string }} opts
 */
export function selectEvidenceAndChipUrls(chunks, opts = {}) {
  const clinicStrong = Boolean(opts.clinicKnowledgeStrong);
  const minEvidence = clinicStrong ? MIN_SITE_EVIDENCE_WITH_CLINIC : MIN_SNIPPET_SCORE;
  const minChip = clinicStrong
    ? Math.max(MIN_CHIP_SCORE, MIN_SITE_EVIDENCE_WITH_CLINIC)
    : MIN_CHIP_SCORE;

  /** @type {Array<{ url: string, title: string, score: number, reason: string }>} */
  const evidenceUrls = [];
  /** @type {Array<{ url: string, title: string, score: number, reason: string }>} */
  const chipUrls = [];
  /** @type {Array<{ url: string, reason: string, score?: number }>} */
  const excluded = [];

  for (const c of chunks || []) {
    const url = rewriteLegacyKanaiUrl(c?.url);
    const score = Number(c?.score) || 0;
    const title = String(labelForKnowledgeChunk(c)).replace(/\s+/g, " ").trim() || url;
    const pageType = c.pageType || classifyPageType(url);

    if (!url || isGenericKanaiHomeUrl(url)) {
      excluded.push({ url: c?.url || "", reason: "TOP/無効URL", score });
      continue;
    }
    if (score < minEvidence) {
      excluded.push({
        url,
        reason: `根拠スコア不足(${score}<${minEvidence})`,
        score,
      });
      continue;
    }
    // clinic強ヒット時、投稿は鮮度質問以外チップにしない
    if (
      clinicStrong &&
      pageType === "news" &&
      !needsNewsFreshnessQuery(opts.userMessage || "")
    ) {
      excluded.push({
        url,
        reason: "clinic-knowledge回答可能のため投稿をチップ除外",
        score,
      });
      continue;
    }
    // 今日/明日質問で「対象日以外」と判定された投稿は根拠・チップにしない
    const reasons = c.scoreReasons || [];
    // 婦人科: カテゴリ一致だけでは不可。質問トピックが本文に無い場合は根拠・チップ除外
    if (
      /\/gynecology\//i.test(url) &&
      matchGynecologyTopicGroups(opts.userMessage || "").length > 0
    ) {
      const pageHay = `${c.title || ""}\n${(c.h1 || []).join(" ")}\n${c.text || ""}`;
      if (
        reasons.some((r) => /婦人科トピック未記載/.test(r)) ||
        !gynecologyPageSupportsQuery(opts.userMessage || "", pageHay)
      ) {
        excluded.push({
          url,
          reason: "婦人科ページに該当診療の記載がなく根拠除外",
          score,
        });
        continue;
      }
    }
    if (
      pageType === "news" &&
      needsNewsFreshnessQuery(opts.userMessage || "") &&
      reasons.some((r) => /対象日以外|過去日付/.test(r))
    ) {
      excluded.push({
        url,
        reason: "日付不一致の休診お知らせを根拠除外",
        score,
      });
      continue;
    }
    if (reasons.some((r) => /絶対関連不足|汎用語のみ|一致語1語のみ|鮮度不加点/.test(r))) {
      // 鮮度不加点だけでは除外しないが、絶対関連不足・汎用語のみは除外
      if (reasons.some((r) => /絶対関連不足|汎用語のみ|一致語1語のみ/.test(r))) {
        excluded.push({
          url,
          reason: "関連ガードにより根拠除外",
          score,
        });
        continue;
      }
    }
    // 投稿はタイトル/見出し一致 or 複数関連語が無いとチップ不可
    if (pageType === "news") {
      const newsChipOk =
        reasons.some((r) => /見出し一致|お知らせ日付が質問日と一致|トピック一致/.test(r)) &&
        !reasons.some((r) => /汎用語のみ|一致語1語のみ|タイトル意図一致不足|絶対関連不足/.test(r));
      if (!newsChipOk) {
        excluded.push({
          url,
          reason: "投稿:タイトル/意図一致が弱くチップ除外",
          score,
        });
        // 根拠にも使わない（誤った休診案内防止）
        continue;
      }
    }

    evidenceUrls.push({
      url,
      title,
      score,
      reason: `GPT根拠採用(score=${score}>=${minEvidence})`,
    });

    if (score >= minChip) {
      chipUrls.push({
        url,
        title,
        score,
        reason: `チップ採用(score=${score}>=${minChip})`,
      });
    } else {
      excluded.push({
        url,
        reason: `チップ閾値未満(${score}<${minChip})・根拠のみ`,
        score,
      });
    }
  }

  return {
    evidenceUrls: evidenceUrls.slice(0, SNIPPET_TOP_CHUNKS),
    chipUrls: chipUrls.slice(0, 1),
    excluded,
  };
}

export function labelForKnowledgeChunk(c) {
  const url = String(c?.url || "");
  if (/#hos_bring/i.test(url) || c?.matchedSection === "hos_bring") {
    return "入院時の持ち物について";
  }
  if (/#price_birth/i.test(url)) {
    return "分娩料金について";
  }
  if (/\/facilities\/?/i.test(url)) {
    return "院内施設のご案内";
  }
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

export function sourcePagesFromChunks(chunks, opts = {}) {
  const { chipUrls } = selectEvidenceAndChipUrls(chunks || [], opts);
  return chipUrls.map((c) => ({ url: c.url, title: c.title }));
}

export function buildSiteKnowledgeSnippet(
  userMessage,
  state,
  { includeReferenceUrlList = true, now = new Date() } = {}
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
    const body = stripStaleTodayClosedNotices(c.text || "", now);
    return `【${labelForKnowledgeChunk(c)}】\nURL: ${c.url}${lm}\nページ種別: ${c.pageType || "other"}\n${body}`;
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
 * @param {{ forceRefresh?: boolean, includeDebug?: boolean, clinicKnowledgeStrong?: boolean }} [opts]
 */
export async function getSiteKnowledgeSnippetSupplement(userMessage, opts = {}) {
  // clinic-knowledgeが十分強いときは、単一ページ強制より通常検索（固定ページ補助）を優先しない
  // 面会・立ち会いは意図が明確なため従来どおり専用ページを根拠にする
  const forceTopicPage = !opts.clinicKnowledgeStrong;

  if (forceTopicPage && isAttendFocusedQuery(userMessage)) {
    const state = await loadAttendPageOnlyState();
    const built = buildSinglePageSnippet(state, "立ち会い分娩について", ATTEND_INFO_PAGE_URL);
    const chip = {
      url: ATTEND_INFO_PAGE_URL,
      title: "立ち会い分娩について",
      score: built.sourceChunks?.[0]?.score || MIN_CHIP_SCORE,
      reason: "立ち会い専用ページ",
    };
    return {
      ...built,
      state,
      evidenceUrls: [chip],
      chipUrls: [chip],
      debug: opts.includeDebug
        ? {
            mode: "attend_only",
            url: ATTEND_INFO_PAGE_URL,
            forceRefresh: opts.forceRefresh,
            evidenceUrls: [chip],
            chipUrls: [chip],
            candidateUrls: [ATTEND_INFO_PAGE_URL],
            retrievedUrls: built.sourceChunks?.map((c) => c.url) || [],
            excludedUrls: [],
          }
        : undefined,
    };
  }
  if (forceTopicPage && isMeetingFocusedQuery(userMessage)) {
    const state = await loadMeetingPageOnlyState();
    const built = buildSinglePageSnippet(state, "面会について", MEETING_INFO_PAGE_URL);
    const chip = {
      url: MEETING_INFO_PAGE_URL,
      title: "面会について",
      score: built.sourceChunks?.[0]?.score || MIN_CHIP_SCORE,
      reason: "面会専用ページ",
    };
    return {
      ...built,
      state,
      evidenceUrls: [chip],
      chipUrls: [chip],
      debug: opts.includeDebug
        ? {
            mode: "meeting_only",
            url: MEETING_INFO_PAGE_URL,
            forceRefresh: opts.forceRefresh,
            evidenceUrls: [chip],
            chipUrls: [chip],
            candidateUrls: [MEETING_INFO_PAGE_URL],
            retrievedUrls: built.sourceChunks?.map((c) => c.url) || [],
            excludedUrls: [],
          }
        : undefined,
    };
  }
  // 入院持ち物は #hos_bring 専用（一般論補完を防ぐ。clinic強でもページ根拠を優先）
  if (isHospitalBagQuery(userMessage)) {
    const state = await loadHospitalBagPageOnlyState();
    const built = buildSinglePageSnippet(
      state,
      "入院時の持ち物について",
      HOSPITAL_BAG_PAGE_URL
    );
    const chip = {
      url: HOSPITAL_BAG_PAGE_URL,
      title: "入院時の持ち物について",
      score: built.sourceChunks?.[0]?.score || MIN_CHIP_SCORE + 80,
      reason: "入院持ち物専用セクション",
    };
    return {
      ...built,
      state,
      evidenceUrls: [chip],
      chipUrls: [chip],
      debug: opts.includeDebug
        ? {
            mode: "hospital_bag_only",
            url: HOSPITAL_BAG_PAGE_URL,
            matchedSection: "hos_bring",
            forceRefresh: opts.forceRefresh,
            evidenceUrls: [chip],
            chipUrls: [chip],
            candidateUrls: [HOSPITAL_BAG_PAGE_URL],
            retrievedUrls: built.sourceChunks?.map((c) => c.url) || [],
            excludedUrls: [],
          }
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
  const now = opts.now instanceof Date ? opts.now : new Date();
  const { snippet, sourceChunks, confidence } = buildSiteKnowledgeSnippet(userMessage, state, {
    includeReferenceUrlList: false,
    now,
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
    evidenceUrls: built.evidenceUrls || [],
    chipUrls: built.chipUrls || [],
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
    minChipScore: MIN_CHIP_SCORE,
    minSiteEvidenceWithClinic: MIN_SITE_EVIDENCE_WITH_CLINIC,
  };
}
