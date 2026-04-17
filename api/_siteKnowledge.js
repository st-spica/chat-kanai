/**
 * 当院サイトの HTML を取得してテキスト化する。
 * - 優先: 環境変数 SITE_URL_LIST（改行・カンマ・| 区切り）で URL を直接指定 → sitemap を読まず高速
 * - 未指定時: sitemap から URL を収集
 * - メモリキャッシュ + 任意で Upstash Redis（既存の UPSTASH_* があれば利用）
 */

import { Redis } from "@upstash/redis";

const REDIS_KEY = "chat:site-knowledge:v1";

const DEFAULT_MAX_PAGES = parseInt(process.env.SITE_FETCH_MAX_PAGES || "12", 10);
const DEFAULT_MAX_CHARS = parseInt(process.env.SITE_MAX_CHARS_PER_PAGE || "5000", 10);
/** 1リクエストあたりプロンプトに載せる関連チャンク数（小さいほど入力が軽く速い） */
const SNIPPET_TOP_CHUNKS = Math.min(
  10,
  Math.max(1, parseInt(process.env.SITE_SNIPPET_TOP_CHUNKS || "4", 10))
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
const DEFAULT_TTL_MS = parseInt(process.env.SITE_KNOWLEDGE_TTL_MS || String(24 * 60 * 60 * 1000), 10);
const FETCH_TIMEOUT_MS = parseInt(process.env.SITE_FETCH_TIMEOUT_MS || "8000", 10);
const MAX_SITEMAP_URLS = parseInt(process.env.SITE_SITEMAP_MAX_URLS || "300", 10);

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
  return /\.(xml|jpg|jpeg|png|gif|webp|svg|ico|pdf|zip|css|js|woff2?|ttf|eot)(\?|$)/i.test(u);
}

function urlPriority(u) {
  let s = 0;
  if (/\/qa\//i.test(u)) s += 15;
  if (/\/visit|\/lesson|\/obstetrics|\/gynecology|\/restaurant|\/about/i.test(u)) s += 8;
  if (/\/news|\/info|\/column/i.test(u)) s += 3;
  return s;
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
      headers: {
        "User-Agent": "KanaiHospitalChat/1.0 (+https://www.kanai.or.jp/)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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

/** 「面会」含む発話では、このページだけを取得して回答する（他ページの抜粋は載せない） */
export const MEETING_INFO_PAGE_URL = "https://www.kanai.or.jp/news/meeting.php";

export function isMeetingFocusedQuery(userMessage) {
  return /面会/.test(String(userMessage || "").trim());
}

async function loadMeetingPageOnlyState() {
  const chunk = await fetchPageChunk(MEETING_INFO_PAGE_URL, DEFAULT_MAX_CHARS);
  const chunks = chunk ? [chunk] : [];
  return {
    chunks,
    referenceUrls: [],
    knowledgeText: chunks.length
      ? buildFullKnowledgeText(chunks)
      : `【面会について】\n${MEETING_INFO_PAGE_URL} の本文を取得できませんでした。ブラウザで直接ご確認ください。`,
    error: chunks.length ? null : "meeting_page_failed",
    fetchMode: "meeting_only",
    meetingOnly: true,
  };
}

function isMeetingOnlyState(state) {
  return Boolean(state && state.meetingOnly === true);
}

async function resolveEntrySitemapUrl() {
  const custom = (process.env.SITE_SITEMAP_URL || "").trim();
  if (custom) return custom;

  const candidates = [
    "https://www.kanai.or.jp/wp-sitemap.xml",
    "https://www.kanai.or.jp/sitemap.xml",
  ];

  for (const u of candidates) {
    try {
      const xml = await fetchText(u);
      if (xml && xml.includes("<loc>")) return u;
    } catch {
      /* try next */
    }
  }
  throw new Error("sitemap が取得できませんでした（SITE_SITEMAP_URL を指定してください）");
}

async function buildFreshKnowledge(maxPages, maxChars) {
  const registered = parseRegisteredUrlList();
  let picked;
  /** @type {"url_list"|"sitemap"} */
  let fetchMode;

  if (registered.length > 0) {
    fetchMode = "url_list";
    picked = registered.slice(0, maxPages);
  } else {
    fetchMode = "sitemap";
    const entry = await resolveEntrySitemapUrl();
    const allUrls = await collectAllPageUrls(entry);
    picked = filterAndRankUrls(allUrls, maxPages);
  }

  const chunks = (await Promise.all(picked.map((u) => fetchPageChunk(u, maxChars)))).filter(Boolean);

  const referenceUrls = picked.slice(0, 40);
  const knowledgeText = buildFullKnowledgeText(chunks);

  return {
    chunks,
    referenceUrls,
    knowledgeText,
    error: chunks.length ? null : "no_chunks",
    fetchMode,
  };
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
 * サイト知識をロード（Redis / メモリTTL / 再取得）
 */
export async function ensureSiteKnowledgeLoaded() {
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
      const maxPages = DEFAULT_MAX_PAGES;
      const maxChars = DEFAULT_MAX_CHARS;
      const built = await buildFreshKnowledge(maxPages, maxChars);
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
  const urlAndHead = `${c.url}\n${c.title}\n${(c.text || "").slice(0, 1500)}`.toLowerCase();
  let bonus = 0;
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

  const pairs = [
    [/レストラン|レスト|食堂|食事|ランチ|ディナー|beb|béb|ベベ/i, /restaurant|bebe|bebé|dining|lunch|dinner|meal|cafe|レストラン/],
    [/駐車|パーキング|駐車場|車でお越し/, /parking|park|駐車場|\/access\/.*parking/],
    [/外来|受診|初診|予約|診察|アクセス|行き方|地図/, /\/visit\/|outpatient|appointment|gai|\/access\//],
    [/産婦人科|分娩|出産|妊娠|帝王切開/, /obstetrics|gynecology|delivery|pregnancy|産科|婦人/],
    [/お知らせ|ニュース/, /\/news\/|\/info\/|column|notice/],
    [/料金|費用|支払|予納/, /fee|price|cost|payment/],
    [
      /診療時間|受付時間|休診|曜日|スケジュール|診療枠|時間割/,
      /schedule|hours|time|休診|診療|calendar|枠/,
    ],
    [
      /検診|健診|妊婦検|乳児検|検査予約|予防接種|母子手帳/,
      /健診|kenshin|screening|乳児|妊婦|検診|checkup|exam|母子/,
    ],
  ];
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
  const hay = `${c.title}\n${c.url}\n${c.text}`.toLowerCase();
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
  if (isMeetingOnlyState(state)) {
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
 * ユーザーメッセージに関連しそうなチャンク（抜粋に使うものと同じ集合）
 * @returns {Array<{ url: string, title: string, text: string }>}
 */
export function selectReferencedChunks(userMessage, state) {
  if (isMeetingOnlyState(state)) {
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
    const hay = `${c.title}\n${c.url}\n${c.text}`.toLowerCase();
    let score = topicUrlBoost(userMessage, c);
    for (const tok of userTokens) {
      const t = tok.toLowerCase();
      if (t.length >= 2 && hay.includes(t)) score += t.length;
    }
    if (userLower.length >= 4 && userLower.length <= 100 && hay.includes(userLower)) score += 35;
    return { c, score };
  });

  const top = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, SNIPPET_TOP_CHUNKS)
    .map((s) => s.c);

  const use = top.length > 0 ? top : chunks.slice(0, SNIPPET_TOP_CHUNKS);
  return use;
}

/**
 * ユーザーメッセージに関連しそうなチャンクだけを system 用にまとめる
 */
export function buildSiteKnowledgeSnippet(userMessage, state) {
  if (isMeetingOnlyState(state) && (state.chunks || []).length) {
    const use = state.chunks;
    const parts = use.map((c) => `【${labelForKnowledgeChunk(c)}】\nURL: ${c.url}\n${c.text}`);
    return `【当院公式サイトからの抜粋（面会についてのページのみ。他ページの情報は含みません）】\n\n${parts.join("\n\n---\n\n")}`;
  }
  const referenceUrls = state?.referenceUrls || [];
  const use = selectReferencedChunks(userMessage, state);

  if (!use.length) {
    return state?.knowledgeText || "";
  }

  const parts = use.map((c) => `【${labelForKnowledgeChunk(c)}】\nURL: ${c.url}\n${c.text}`);

  let snippet = `【当院公式サイトからの抜粋（関連が高そうなページのみ）】\n\n${parts.join("\n\n---\n\n")}`;

  if (referenceUrls.length > 0) {
    snippet += `\n\n【参考URL（院内サイト・sitemap 由来）】\n${referenceUrls
      .slice(0, 25)
      .map((u) => `・${u}`)
      .join("\n")}`;
  }

  return snippet;
}

export async function getSiteKnowledgeSnippet(userMessage) {
  if (isMeetingFocusedQuery(userMessage)) {
    const state = await loadMeetingPageOnlyState();
    const c = state.chunks[0];
    const snippet = c
      ? `【当院公式サイトからの抜粋（面会についてのページのみ。他ページの情報は含みません）】\n\n【${labelForKnowledgeChunk(
          c
        )}】\nURL: ${c.url}\n${c.text}`
      : `【面会について】\n${MEETING_INFO_PAGE_URL} の本文を取得できませんでした。お手数ですがブラウザで直接ご確認ください。\n（このターンでは上記URLのみを参照対象としています）`;
    return { snippet, state };
  }
  const state = await ensureSiteKnowledgeLoaded();
  return { snippet: buildSiteKnowledgeSnippet(userMessage, state), state };
}

/** GET ヘルス用。ネットワーク取得は行わず、メモリ上のキャッシュ状況だけ返す */
export function peekSiteKnowledgeStatus() {
  const now = Date.now();
  const fresh = memoryCache.chunks.length > 0 && now - memoryCache.at < DEFAULT_TTL_MS;
  const registeredCount = parseRegisteredUrlList().length;
  return {
    memoryCached: fresh,
    chunkCount: fresh ? memoryCache.chunks.length : 0,
    lastError: memoryCache.error,
    fetchMode: memoryCache.fetchMode,
    registeredUrlCount: registeredCount,
    ttlMs: DEFAULT_TTL_MS,
    maxPages: DEFAULT_MAX_PAGES,
    snippetTopChunks: SNIPPET_TOP_CHUNKS,
  };
}
