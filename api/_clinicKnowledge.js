/**
 * 院内登録情報（clinic-knowledge）
 *
 * - 公式サイト未掲載でも、病院が明示登録した確定情報をチャットで案内する
 * - 既定: data/clinic-knowledge.json を読み込む
 * - CLINIC_KNOWLEDGE_URL があれば HTTP GET で取得（将来の WP 管理画面連携用）
 * - 緊急判定・医療診断を上書きしない（呼び出し側で緊急を先に処理すること）
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  isAttendFocusedMessage,
  isFeeFocusedMessage,
  isVisitFocusedMessage,
  QUERY_NORMALIZERS,
} from "../data/site-route-map.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_JSON_PATH = join(__dirname, "../data/clinic-knowledge.json");

const TOP_ITEMS = Math.min(
  5,
  Math.max(1, parseInt(process.env.CLINIC_KNOWLEDGE_TOP_ITEMS || "2", 10))
);
/** このスコア未満は GPT に渡さない */
const MIN_PASS_SCORE = Math.max(
  1,
  parseInt(process.env.CLINIC_KNOWLEDGE_MIN_SCORE || "40", 10)
);
/** これ以上なら「clinic-knowledgeだけで十分回答可能」とみなし、サイト投稿チップを抑制 */
export const CLINIC_KNOWLEDGE_STRONG_SCORE = Math.max(
  MIN_PASS_SCORE,
  parseInt(process.env.CLINIC_KNOWLEDGE_STRONG_SCORE || "80", 10)
);
const CACHE_TTL_MS = Math.max(
  0,
  parseInt(process.env.CLINIC_KNOWLEDGE_TTL_MS || String(5 * 60 * 1000), 10)
);

/**
 * @typedef {{
 *   id: string,
 *   category: string,
 *   intent?: string|null,
 *   questionPatterns: string[],
 *   keywords: string[],
 *   answer: string,
 *   priority: number,
 *   updatedAt: string,
 *   enabled: boolean,
 *   relatedSiteUrl?: string,
 * }} ClinicKnowledgeItem
 */

/** @typedef {{ item: ClinicKnowledgeItem, score: number, reasons: string[] }} ClinicKnowledgeHit */
/** @typedef {{ id: string, intent?: string|null, score: number, reason: string }} ClinicKnowledgeRejection */

/** 予約系 intent（キーワード一致だけでは採用しない） */
export const RESERVATION_INTENTS = new Set([
  "reservation_availability",
  "web_reservation_availability",
  "reservation_change",
  "reservation_cancel",
  "first_visit_reservation",
  "revisit_reservation",
  "class_reservation",
]);

let memoryCache = {
  at: 0,
  /** @type {ClinicKnowledgeItem[]} */
  items: [],
  version: null,
  source: "none",
  error: null,
};

/**
 * 生JSON/配列を正規化（旧形式 question/url も吸収）
 * @param {any} raw
 * @returns {{ items: ClinicKnowledgeItem[], version: any, error: string|null }}
 */
export function normalizeClinicKnowledgePayload(raw) {
  try {
    const list = Array.isArray(raw) ? raw : raw?.items;
    if (!Array.isArray(list)) {
      return { items: [], version: null, error: "items 配列がありません" };
    }
    /** @type {ClinicKnowledgeItem[]} */
    const items = [];
    for (let i = 0; i < list.length; i++) {
      const n = normalizeOneItem(list[i], i);
      if (n) items.push(n);
    }
    return {
      items,
      version: Array.isArray(raw) ? 1 : raw?.version ?? null,
      error: items.length ? null : "有効な項目がありません",
    };
  } catch (e) {
    return { items: [], version: null, error: e?.message || String(e) };
  }
}

/**
 * @param {any} raw
 * @param {number} index
 * @returns {ClinicKnowledgeItem|null}
 */
function normalizeOneItem(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.enabled === false || raw.enabled === "false" || raw.enabled === 0) {
    // enabled=false は検索対象外（リストにも載せない）
    return null;
  }

  const answer = String(raw.answer ?? "").trim();
  if (!answer) return null;

  let questionPatterns = Array.isArray(raw.questionPatterns)
    ? raw.questionPatterns.map((p) => String(p || "").trim()).filter(Boolean)
    : [];
  // 旧形式互換
  if (!questionPatterns.length && raw.question) {
    questionPatterns = String(raw.question)
      .split(/[／/]/)
      .map((p) => p.trim())
      .filter(Boolean);
  }
  if (!questionPatterns.length) return null;

  let keywords = Array.isArray(raw.keywords)
    ? raw.keywords.map((k) => String(k || "").trim()).filter(Boolean)
    : [];
  if (!keywords.length) {
    keywords = inferKeywords(questionPatterns.join(" "), answer);
  }

  const id =
    String(raw.id || "").trim() ||
    `item-${String(index + 1).padStart(3, "0")}`;
  const category = String(raw.category ?? "").trim() || "other";
  const intentRaw = String(raw.intent || "").trim();
  const intent = intentRaw || inferItemIntent(id, category, questionPatterns);
  const priority = Number.isFinite(Number(raw.priority))
    ? Number(raw.priority)
    : 50;
  const updatedAt = String(raw.updatedAt || raw.updated_at || "").trim() || "";
  const relatedSiteUrl = String(
    raw.relatedSiteUrl || raw.url || ""
  ).trim();

  /** @type {ClinicKnowledgeItem} */
  const item = {
    id,
    category,
    intent,
    questionPatterns,
    keywords,
    answer,
    priority,
    updatedAt,
    enabled: true,
  };
  if (relatedSiteUrl) item.relatedSiteUrl = relatedSiteUrl;
  return item;
}

/**
 * @param {string} id
 * @param {string} category
 * @param {string[]} patterns
 */
function inferItemIntent(id, category, patterns) {
  const hay = `${id}\n${category}\n${(patterns || []).join("\n")}`.toLowerCase();
  if (/reservation_cancel|キャンセル/.test(hay) && /予約|reservation/.test(hay)) {
    return "reservation_cancel";
  }
  if (/reservation_change|予約変更|変更したい/.test(hay)) {
    return "reservation_change";
  }
  if (/web_reservation|web予約|ウェブ予約/.test(hay)) {
    return "web_reservation_availability";
  }
  if (/first_visit|初診/.test(hay) && /予約|reservation/.test(hay)) {
    return "first_visit_reservation";
  }
  if (/revisit|再診/.test(hay) && /予約|reservation/.test(hay)) {
    return "revisit_reservation";
  }
  if (/class_reservation|教室/.test(hay) && /予約|reservation/.test(hay)) {
    return "class_reservation";
  }
  if (/reception-001|当日予約|reservation_availability/.test(hay)) {
    return "reservation_availability";
  }
  if (/childbirth_bonus_dinner|お祝いディナー|ディナーご招待/.test(hay)) {
    return "childbirth_bonus_dinner";
  }
  return null;
}

function inferKeywords(question, answer) {
  const text = `${question}\n${answer}`;
  const base = [
    "駐車場",
    "駐車",
    "面会",
    "立ち会い",
    "持ち物",
    "予約",
    "キャンセル",
    "入院",
    "個室",
    "ワクチン",
    "ピル",
    "休診",
    "診療時間",
    "クレジット",
    "予納",
    "里帰り",
    "産後",
    "母乳",
  ];
  return base.filter((k) => text.includes(k)).slice(0, 10);
}

/**
 * データ取得（差し替えポイント）
 * - CLINIC_KNOWLEDGE_URL: WordPress 等の API
 * - それ以外: ローカル JSON
 * @param {{ forceRefresh?: boolean }} [opts]
 */
export async function loadClinicKnowledgeSource(opts = {}) {
  const now = Date.now();
  if (
    !opts.forceRefresh &&
    CACHE_TTL_MS > 0 &&
    memoryCache.items.length &&
    now - memoryCache.at < CACHE_TTL_MS
  ) {
    return {
      items: memoryCache.items,
      version: memoryCache.version,
      source: memoryCache.source,
      error: memoryCache.error,
      fromCache: true,
    };
  }

  const remoteUrl = String(process.env.CLINIC_KNOWLEDGE_URL || "").trim();
  let payload = null;
  let source = "file";
  let error = null;

  if (remoteUrl) {
    source = "remote";
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 8000);
      const res = await fetch(remoteUrl, {
        signal: ac.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      payload = await res.json();
    } catch (e) {
      error = `remote_fetch_failed: ${e?.message || e}`;
      console.error("clinic-knowledge remote load failed:", error);
      // リモート失敗時はローカルへフォールバック
      source = "file_fallback";
    }
  }

  if (!payload) {
    try {
      const path = String(process.env.CLINIC_KNOWLEDGE_PATH || DEFAULT_JSON_PATH);
      payload = JSON.parse(readFileSync(path, "utf-8"));
      if (source !== "file_fallback") source = "file";
    } catch (e) {
      error = e?.message || String(e);
      console.error("clinic-knowledge file load failed:", error);
      memoryCache = { at: now, items: [], version: null, source, error };
      return { items: [], version: null, source, error, fromCache: false };
    }
  }

  const normalized = normalizeClinicKnowledgePayload(payload);
  memoryCache = {
    at: now,
    items: normalized.items,
    version: normalized.version,
    source,
    error: normalized.error || error,
  };
  return {
    items: memoryCache.items,
    version: memoryCache.version,
    source: memoryCache.source,
    error: memoryCache.error,
    fromCache: false,
  };
}

/** 同期アクセス用（起動時プリロード兼用） */
function getCachedItemsSync() {
  if (memoryCache.items.length) return memoryCache.items;
  try {
    const path = String(process.env.CLINIC_KNOWLEDGE_PATH || DEFAULT_JSON_PATH);
    const payload = JSON.parse(readFileSync(path, "utf-8"));
    const normalized = normalizeClinicKnowledgePayload(payload);
    memoryCache = {
      at: Date.now(),
      items: normalized.items,
      version: normalized.version,
      source: "file",
      error: normalized.error,
    };
  } catch (e) {
    memoryCache = {
      at: Date.now(),
      items: [],
      version: null,
      source: "file",
      error: e?.message || String(e),
    };
  }
  return memoryCache.items;
}

// コールドスタート用に同期プリロード
getCachedItemsSync();

function normalizeQueryText(text) {
  return String(text || "")
    .trim()
    .replace(/[？?！!。．、,…〜~･・]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 予約系の表記ゆれ・否定疑問を正規化（意味は「可否を問う」）
 * @param {string} userMessage
 */
export function normalizeReservationQuery(userMessage) {
  let s = String(userMessage || "").trim();
  s = s.replace(/ウェブ予約|ネット予約|オンライン予約/gi, "WEB予約");
  s = s.replace(/ウェブで予約|ネットで予約|オンラインで予約/gi, "WEBで予約");
  // 否定疑問も「できますか」と同じ意図へ
  s = s.replace(
    /WEB(?:で)?予約(?:は)?(?:できませんか|できないの|できないですか|できないでしょうか|できないよね|できないんだっけ)/g,
    "WEB予約はできますか"
  );
  s = s.replace(/WEB(?:で)?予約(?:は)?できますか/g, "WEB予約はできますか");
  s = s.replace(/WEB予約(?:は)?可能ですか/g, "WEB予約はできますか");
  return normalizeQueryText(s);
}

/**
 * 質問の clinic intent を推定（予約系を優先分離）
 * @param {string} userMessage
 * @returns {string|null}
 */
export function detectClinicIntent(userMessage) {
  const raw = String(userMessage || "").trim();
  if (!raw) return null;
  const msg = normalizeReservationQuery(raw);
  const hasReserve = /予約/.test(msg);
  const hasWeb = /WEB|ウェブ|ネット|オンライン/i.test(msg);
  const hasChange = /変更/.test(msg);
  const hasCancel = /キャンセル|取り消|取消/.test(msg);

  // お祝いディナー（分娩予約特典）
  if (
    /お祝いディナー|出産祝いの食事|お祝いの食事/.test(msg) ||
    (/(?:ディナー|食事)/.test(msg) &&
      /(?:家族|夫|旦那|パートナー|招待|呼べ|食べ)/.test(msg)) ||
    /(?:何人|何名).{0,10}招待|招待.{0,10}(?:何人|何名)/.test(msg)
  ) {
    return "childbirth_bonus_dinner";
  }

  // 変更・キャンセルは可否より優先
  if (hasReserve && hasChange) {
    return "reservation_change";
  }
  if (hasReserve && hasCancel) {
    return "reservation_cancel";
  }

  // WEB予約の可否（否定疑問含む）
  if (
    hasWeb &&
    hasReserve &&
    /でき|可能|利用|取れ|取れます|申し込め|申込め/.test(msg)
  ) {
    return "web_reservation_availability";
  }
  if (/^WEB予約はできますか$/.test(msg) || /WEB予約/.test(msg) && /でき|可能/.test(msg)) {
    return "web_reservation_availability";
  }

  if (/産前産後教室|教室/.test(msg) && hasReserve) {
    return "class_reservation";
  }
  if (/初診/.test(msg) && hasReserve) {
    return "first_visit_reservation";
  }
  if (/再診/.test(msg) && hasReserve) {
    return "revisit_reservation";
  }
  if (/(?:当日|今日|本日)/.test(msg) && hasReserve) {
    return "reservation_availability";
  }
  if (hasReserve && /でき|可能|取れ|申し込め|申込め/.test(msg)) {
    return "reservation_availability";
  }
  return null;
}

/**
 * QUERY_NORMALIZERS 等で質問を拡張したマッチ用テキスト
 * @param {string} userMessage
 */
function expandMessageForClinicMatch(userMessage) {
  const msg = normalizeReservationQuery(userMessage);
  const extras = [];
  if (isVisitFocusedMessage(msg)) extras.push("面会", "お見舞い");
  if (isAttendFocusedMessage(msg)) extras.push("立ち会い", "立会い");
  if (isFeeFocusedMessage(msg)) extras.push("費用", "料金");
  for (const n of Object.values(QUERY_NORMALIZERS || {})) {
    if (n?.pattern?.test(msg) && n.label) extras.push(n.label);
  }
  if (/駐車|パーキング|車で来|車で行/.test(msg)) extras.push("駐車場", "駐車");
  if (/持ち物|何を持|持参/.test(msg)) extras.push("持ち物");
  return normalizeQueryText(`${msg} ${extras.join(" ")}`);
}

function patternActionTags(text) {
  const t = String(text || "");
  return {
    change: /変更/.test(t),
    cancel: /キャンセル|取り消|取消/.test(t),
    availability: /でき|可能|利用|取れ|取れます|申し込め|申込め|ありますか/.test(t),
  };
}

/**
 * @param {string} userMessage
 * @param {ClinicKnowledgeItem} item
 * @param {{ queryIntent?: string|null }} [opts]
 * @returns {{ score: number, reasons: string[], rejected?: boolean, rejectReason?: string }}
 */
export function scoreClinicKnowledgeItem(userMessage, item, opts = {}) {
  const msg = String(userMessage || "").trim();
  if (!msg || !item?.enabled) {
    return { score: 0, reasons: [], rejected: true, rejectReason: "empty" };
  }

  const queryIntent =
    opts.queryIntent !== undefined ? opts.queryIntent : detectClinicIntent(msg);
  const itemIntent = item.intent || null;
  const normalizedQuery = normalizeReservationQuery(msg);
  const expanded = expandMessageForClinicMatch(msg);
  const msgNorm = normalizedQuery.toLowerCase();
  const expLower = expanded.toLowerCase();
  const reasons = [];

  // intent 不一致は除外（予約系のみ厳格）
  if (
    queryIntent &&
    RESERVATION_INTENTS.has(queryIntent) &&
    itemIntent &&
    RESERVATION_INTENTS.has(itemIntent) &&
    queryIntent !== itemIntent
  ) {
    return {
      score: 0,
      reasons: [`intent不一致:query=${queryIntent}/item=${itemIntent}`],
      rejected: true,
      rejectReason: `intent不一致(query=${queryIntent}, item=${itemIntent})`,
    };
  }

  let score = 0;
  let bestPattern = 0;
  const qAct = patternActionTags(normalizedQuery);

  for (const pat of item.questionPatterns || []) {
    const p = normalizeQueryText(pat).toLowerCase();
    if (!p) continue;
    const pAct = patternActionTags(p);

    // アクション（変更/キャンセル/可否）が食い違うパターンは使わない
    if (qAct.change !== pAct.change || qAct.cancel !== pAct.cancel) {
      continue;
    }
    if (
      RESERVATION_INTENTS.has(queryIntent || "") &&
      qAct.availability &&
      (pAct.change || pAct.cancel) &&
      !qAct.change &&
      !qAct.cancel
    ) {
      continue;
    }

    if (msgNorm === p || msgNorm.includes(p) || p.includes(msgNorm)) {
      bestPattern = Math.max(bestPattern, 120);
      reasons.push(`pattern一致:${pat.slice(0, 24)}`);
    } else {
      const toks = p.split(/\s+/).filter((t) => t.length >= 2);
      let hit = 0;
      for (const t of toks) {
        if (expLower.includes(t)) hit += 1;
      }
      if (toks.length && hit === toks.length) {
        bestPattern = Math.max(bestPattern, 90);
        reasons.push(`pattern語全一致:${pat.slice(0, 24)}`);
      } else if (hit >= 2 && !RESERVATION_INTENTS.has(itemIntent || "")) {
        // 予約系は部分一致だけで高得点にしない
        bestPattern = Math.max(bestPattern, 20 * hit);
      }
    }
  }
  score += bestPattern;

  // keywords: 予約系は pattern があるときだけ補助点。keyword単独では通過させない
  let kwHits = 0;
  let kwScore = 0;
  for (const kw of item.keywords || []) {
    const k = String(kw || "").toLowerCase();
    if (k.length < 2) continue;
    if (expLower.includes(k) || msgNorm.includes(k)) {
      kwHits += 1;
      kwScore += k.length >= 3 ? 16 : 10;
      reasons.push(`keyword:${kw}`);
    }
  }
  if (kwHits >= 2) kwScore += 10;

  const isReservationItem = RESERVATION_INTENTS.has(itemIntent || "");
  if (isReservationItem) {
    if (bestPattern >= 90) {
      score += Math.min(30, kwScore);
    } else if (bestPattern > 0) {
      score += Math.min(12, kwScore);
    } else {
      // keywordのみ → 通過不可
      return {
        score: Math.min(35, kwScore + Math.min(15, (Number(item.priority) || 0) * 0.1)),
        reasons: [...reasons, "keywordのみ(予約intentはpattern必須)"],
        rejected: true,
        rejectReason: "keywordのみでpattern不一致",
      };
    }
  } else {
    score += kwScore;
  }

  if (queryIntent && itemIntent && queryIntent === itemIntent) {
    score += 40;
    reasons.push(`intent一致:${queryIntent}`);
  }

  const cat = String(item.category || "").toLowerCase();
  if (cat && !isReservationItem && (expLower.includes(cat) || msgNorm.includes(cat))) {
    score += 12;
    reasons.push("category一致");
  }

  score += Math.min(30, Math.max(0, Number(item.priority) || 0) * 0.15);

  const uniq = [];
  const seen = new Set();
  for (const r of reasons) {
    if (seen.has(r)) continue;
    seen.add(r);
    uniq.push(r);
  }
  return { score: Math.round(score), reasons: uniq.slice(0, 12) };
}

/**
 * @param {string} userMessage
 * @param {{ forceRefresh?: boolean, items?: ClinicKnowledgeItem[] }} [opts]
 * @returns {Promise<{
 *   hits: ClinicKnowledgeHit[],
 *   topScore: number,
 *   source: string,
 *   strong: boolean,
 *   detectedIntent: string|null,
 *   normalizedQuery: string,
 *   rejected: ClinicKnowledgeRejection[],
 * }>}
 */
export async function searchClinicKnowledge(userMessage, opts = {}) {
  const loaded = opts.items
    ? { items: opts.items, source: "provided" }
    : await loadClinicKnowledgeSource(opts);
  const items = loaded.items || [];
  const detectedIntent = detectClinicIntent(userMessage);
  const normalizedQuery = normalizeReservationQuery(userMessage);

  if (!items.length) {
    return {
      hits: [],
      topScore: 0,
      source: loaded.source || "none",
      strong: false,
      detectedIntent,
      normalizedQuery,
      rejected: [],
    };
  }

  /** @type {ClinicKnowledgeRejection[]} */
  const rejected = [];
  const scored = [];
  for (const item of items) {
    const { score, reasons, rejected: isRejected, rejectReason } =
      scoreClinicKnowledgeItem(userMessage, item, { queryIntent: detectedIntent });
    if (isRejected || score < MIN_PASS_SCORE) {
      if (isRejected || (detectedIntent && RESERVATION_INTENTS.has(detectedIntent))) {
        rejected.push({
          id: item.id,
          intent: item.intent || null,
          score,
          reason: rejectReason || (score < MIN_PASS_SCORE ? `スコア不足(${score})` : "除外"),
        });
      }
      continue;
    }
    scored.push({ item, score, reasons });
  }
  scored.sort(
    (a, b) => b.score - a.score || (b.item.priority || 0) - (a.item.priority || 0)
  );

  const topScore = scored[0]?.score || 0;
  if (!topScore) {
    return {
      hits: [],
      topScore: 0,
      source: loaded.source,
      strong: false,
      detectedIntent,
      normalizedQuery,
      rejected: rejected.slice(0, 20),
    };
  }

  const minKeep = Math.max(topScore * 0.55, topScore - 40, MIN_PASS_SCORE);
  const hits = scored.filter((h) => h.score >= minKeep).slice(0, TOP_ITEMS);
  return {
    hits,
    topScore,
    source: loaded.source,
    strong: isClinicKnowledgeStrong(topScore, hits),
    detectedIntent,
    normalizedQuery,
    rejected: rejected.slice(0, 20),
  };
}

/**
 * clinic-knowledge が高信頼か（サイト投稿チップ抑制の判定）
 * @param {number} topScore
 * @param {ClinicKnowledgeHit[]} [hits]
 */
export function isClinicKnowledgeStrong(topScore, hits = []) {
  if (Number(topScore) >= CLINIC_KNOWLEDGE_STRONG_SCORE) return true;
  // pattern一致相当の理由があれば強ヒットとみなす
  const top = hits[0];
  if (top && top.score >= MIN_PASS_SCORE + 40) {
    const reasons = top.reasons || [];
    if (reasons.some((r) => /pattern一致|pattern語全一致/.test(r))) return true;
  }
  return false;
}

/**
 * GPT 用 system 文（公式サイト抜粋とは別枠）
 * @param {ClinicKnowledgeHit[]} hits
 */
export function buildClinicRegisteredKnowledgePrompt(hits) {
  if (!hits?.length) return "";
  const blocks = hits.map(({ item, score }) => {
    return [
      `【院内登録情報】`,
      `id: ${item.id}`,
      `カテゴリ: ${item.category || "-"}`,
      `更新日: ${item.updatedAt || "不明"}`,
      `関連スコア: ${score}`,
      `回答:`,
      item.answer,
    ].join("\n");
  });
  return [
    "【院内登録情報（病院が明示登録した確定情報。公式サイト情報より優先する）】",
    "・以下は公式サイト未掲載でも案内してよい院内確定情報です。",
    "・公式サイト抜粋や一般知識と矛盾する場合は、院内登録情報を優先してください。",
    "・緊急症状の判断・診断・処方指示には使わないでください。",
    "・回答内に「院内登録情報」「FAQ」などの内部用語は出さないでください。",
    "",
    blocks.join("\n\n---\n\n"),
  ].join("\n");
}

/** @deprecated 互換: 旧 buildClinicKnowledgeSnippet */
export function buildClinicKnowledgeSnippet(userMessage) {
  const items = getCachedItemsSync();
  const scored = items
    .map((item) => {
      const { score, reasons } = scoreClinicKnowledgeItem(userMessage, item);
      return { item, score, reasons };
    })
    .filter((h) => h.score >= MIN_PASS_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_ITEMS);
  return buildClinicRegisteredKnowledgePrompt(scored);
}

/** @deprecated 互換 */
export function rankClinicKnowledge(userMessage) {
  const items = getCachedItemsSync();
  const scored = items
    .map((item) => ({
      item,
      score: scoreClinicKnowledgeItem(userMessage, item).score,
    }))
    .filter((s) => s.score >= MIN_PASS_SCORE)
    .sort((a, b) => b.score - a.score);
  return {
    items: scored.slice(0, TOP_ITEMS).map((s) => s.item),
    topScore: scored[0]?.score || 0,
  };
}

/** clinic-knowledge は患者向け Web チップに使わない */
export function selectReferencedPagesFromCsv() {
  return [];
}

export function shouldSupplementWithWeb() {
  // 併用方針: 常に公式サイト検索も許可（呼び出し側で制御）
  return true;
}

export function peekClinicKnowledgeStatus() {
  return {
    source: memoryCache.source,
    version: memoryCache.version,
    itemCount: memoryCache.items.length,
    loadError: memoryCache.error,
    minPassScore: MIN_PASS_SCORE,
    topItems: TOP_ITEMS,
    cacheTtlMs: CACHE_TTL_MS,
    remoteUrlConfigured: Boolean(String(process.env.CLINIC_KNOWLEDGE_URL || "").trim()),
    jsonPath: "data/clinic-knowledge.json",
  };
}
