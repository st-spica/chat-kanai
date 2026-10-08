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
const CACHE_TTL_MS = Math.max(
  0,
  parseInt(process.env.CLINIC_KNOWLEDGE_TTL_MS || String(5 * 60 * 1000), 10)
);

/**
 * @typedef {{
 *   id: string,
 *   category: string,
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
 * QUERY_NORMALIZERS 等で質問を拡張したマッチ用テキスト
 * @param {string} userMessage
 */
function expandMessageForClinicMatch(userMessage) {
  const msg = String(userMessage || "");
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

/**
 * @param {string} userMessage
 * @param {ClinicKnowledgeItem} item
 * @returns {{ score: number, reasons: string[] }}
 */
export function scoreClinicKnowledgeItem(userMessage, item) {
  const msg = String(userMessage || "").trim();
  if (!msg || !item?.enabled) return { score: 0, reasons: [] };

  const expanded = expandMessageForClinicMatch(msg);
  const msgNorm = normalizeQueryText(msg).toLowerCase();
  const expLower = expanded.toLowerCase();
  const reasons = [];
  let score = 0;

  // 1) questionPatterns（最重要）
  let bestPattern = 0;
  for (const pat of item.questionPatterns || []) {
    const p = normalizeQueryText(pat).toLowerCase();
    if (!p) continue;
    if (msgNorm === p || msgNorm.includes(p) || p.includes(msgNorm)) {
      bestPattern = Math.max(bestPattern, 120);
      reasons.push(`pattern一致:${pat.slice(0, 24)}`);
    } else {
      // パターン語の部分一致
      const toks = p.split(/\s+/).filter((t) => t.length >= 2);
      let hit = 0;
      for (const t of toks) {
        if (expLower.includes(t)) hit += 1;
      }
      if (toks.length && hit === toks.length) {
        bestPattern = Math.max(bestPattern, 90);
        reasons.push(`pattern語全一致:${pat.slice(0, 24)}`);
      } else if (hit > 0) {
        bestPattern = Math.max(bestPattern, 25 * hit);
      }
    }
  }
  score += bestPattern;

  // 2) keywords
  let kwHits = 0;
  for (const kw of item.keywords || []) {
    const k = String(kw || "").toLowerCase();
    if (k.length < 2) continue;
    if (expLower.includes(k) || msgNorm.includes(k)) {
      kwHits += 1;
      score += k.length >= 3 ? 28 : 18;
      reasons.push(`keyword:${kw}`);
    }
  }
  if (kwHits >= 2) score += 20;

  // 3) category / 関連
  const cat = String(item.category || "").toLowerCase();
  if (cat && (expLower.includes(cat) || msgNorm.includes(cat))) {
    score += 12;
    reasons.push("category一致");
  }
  const catHead = cat.split(/[/\s]/)[0];
  if (catHead.length >= 2 && expLower.includes(catHead)) {
    score += 6;
  }

  // priority は微調整（本スコアを上書きしない）
  score += Math.min(30, Math.max(0, Number(item.priority) || 0) * 0.15);

  // 重複理由を整理
  const uniq = [];
  const seen = new Set();
  for (const r of reasons) {
    if (seen.has(r)) continue;
    seen.add(r);
    uniq.push(r);
  }
  return { score: Math.round(score), reasons: uniq.slice(0, 10) };
}

/**
 * @param {string} userMessage
 * @param {{ forceRefresh?: boolean, items?: ClinicKnowledgeItem[] }} [opts]
 * @returns {Promise<{ hits: ClinicKnowledgeHit[], topScore: number, source: string }>}
 */
export async function searchClinicKnowledge(userMessage, opts = {}) {
  const loaded = opts.items
    ? { items: opts.items, source: "provided" }
    : await loadClinicKnowledgeSource(opts);
  const items = loaded.items || [];
  if (!items.length) {
    return { hits: [], topScore: 0, source: loaded.source || "none" };
  }

  const scored = items
    .map((item) => {
      const { score, reasons } = scoreClinicKnowledgeItem(userMessage, item);
      return { item, score, reasons };
    })
    .filter((h) => h.score >= MIN_PASS_SCORE)
    .sort((a, b) => b.score - a.score || (b.item.priority || 0) - (a.item.priority || 0));

  const topScore = scored[0]?.score || 0;
  if (!topScore) return { hits: [], topScore: 0, source: loaded.source };

  const minKeep = Math.max(topScore * 0.55, topScore - 40, MIN_PASS_SCORE);
  const hits = scored.filter((h) => h.score >= minKeep).slice(0, TOP_ITEMS);
  return { hits, topScore, source: loaded.source };
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
