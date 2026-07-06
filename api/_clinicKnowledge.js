/**
 * data/clinic-knowledge.json を起動時に1回読み込み、質問に関連する項目だけ抜粋する。
 * Web 取得より軽量な院内知識の主データソース。
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const JSON_TOP_ITEMS = Math.min(
  10,
  Math.max(1, parseInt(process.env.CSV_SNIPPET_TOP_ITEMS || process.env.JSON_SNIPPET_TOP_ITEMS || "5", 10))
);
/** 参照チップに載せる FAQ 項目の最低スコア（抜粋に含まれる項目と揃える） */
const REFERENCE_CHIP_MIN_FAQ_SCORE = Math.max(
  1,
  parseInt(process.env.REFERENCE_CHIP_MIN_FAQ_SCORE || "3", 10)
);
/** このスコア未満なら Web 補完を検討 */
const JSON_WEB_SUPPLEMENT_MIN_SCORE = Math.max(
  1,
  parseInt(process.env.CSV_WEB_SUPPLEMENT_MIN_SCORE || process.env.JSON_WEB_SUPPLEMENT_MIN_SCORE || "10", 10)
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const JSON_PATH = join(__dirname, "../data/clinic-knowledge.json");

function normalizeFaqItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const category = String(raw.category ?? "").trim();
  const question = String(raw.question ?? "").trim();
  const answer = String(raw.answer ?? "").trim();
  const url = String(raw.url ?? "").trim();
  if (!question && !answer) return null;
  return { category, question, answer, url };
}

function loadClinicKnowledge() {
  try {
    const raw = readFileSync(JSON_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed?.items;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error("JSONファイルの形式が正しくありません（items 配列が必要です）");
    }

    const faqItems = [];
    for (const entry of list) {
      const item = normalizeFaqItem(entry);
      if (item) faqItems.push(item);
    }

    if (!faqItems.length) {
      throw new Error("有効な FAQ 項目がありません");
    }

    const referenceUrls = [];
    for (const item of faqItems) {
      if (
        item.url &&
        (item.url.startsWith("http://") || item.url.startsWith("https://")) &&
        !referenceUrls.includes(item.url)
      ) {
        referenceUrls.push(item.url);
      }
    }

    return { faqItems, referenceUrls, loadError: null };
  } catch (error) {
    console.error("JSONファイルの読み込みに失敗しました:", error?.message || error);
    return { faqItems: [], referenceUrls: [], loadError: error?.message || String(error) };
  }
}

const {
  faqItems: CLINIC_FAQ_ITEMS,
  referenceUrls: CLINIC_REFERENCE_URLS,
  loadError: CLINIC_JSON_LOAD_ERROR,
} = loadClinicKnowledge();

function tokenizeForScoring(text) {
  const raw = String(text || "")
    .trim()
    .replace(/について/g, " ")
    .replace(/教えてください/g, " ")
    .replace(/お願いします/g, " ");
  if (!raw) return [];

  const parts = raw
    .split(/[\s\u3000、。・,.!?？!のをにはがとでもからまでへやなどって]+/)
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

/**
 * @param {string} userMessage
 * @param {{ category: string, question: string, answer: string, url: string }} item
 */
function scoreFaqItem(userMessage, item) {
  const text = String(userMessage || "").trim();
  const lowered = text.toLowerCase();
  const hay = `${item.category}\n${item.question}\n${item.answer}`.toLowerCase();
  let score = 0;

  const qTokens = String(item.question || "")
    .split(/[\s、。・,]+/)
    .filter((t) => t.length >= 2);
  for (const tok of qTokens) {
    if (lowered.includes(tok.toLowerCase())) {
      score += tok.length;
    }
  }

  for (const tok of tokenizeForScoring(text)) {
    const t = tok.toLowerCase();
    if (t.length >= 3 && hay.includes(t)) score += t.length;
    else if (t.length === 2 && hay.includes(t)) score += 6;
  }

  if (item.category && lowered.includes(String(item.category).toLowerCase())) {
    score += 5;
  }

  if (lowered.length >= 4 && lowered.length <= 80 && hay.includes(lowered)) {
    score += 30;
  }

  const hayFull = `${item.category}\n${item.question}\n${item.answer}`;
  if (
    /担当医|主治医|医師.*(性別|男性|女性)|男性医師|女性医師|男の医師|女の医師|指名|診療体制/.test(
      text
    ) &&
    /医師|担当医|診療体制|指名/.test(hayFull)
  ) {
    score += 12;
  }

  return score;
}

/**
 * @returns {{ scored: Array<{ item, score }>, topScore: number }}
 */
function rankClinicKnowledgeScored(userMessage) {
  if (!CLINIC_FAQ_ITEMS.length) {
    return { scored: [], topScore: 0 };
  }

  const scored = CLINIC_FAQ_ITEMS.map((item) => ({
    item,
    score: scoreFaqItem(userMessage, item),
  }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length > 0) {
    return { scored: scored.slice(0, JSON_TOP_ITEMS), topScore: scored[0].score };
  }

  return {
    scored: CLINIC_FAQ_ITEMS.slice(0, Math.min(3, JSON_TOP_ITEMS)).map((item) => ({
      item,
      score: 0,
    })),
    topScore: 0,
  };
}

/**
 * @returns {{ items: Array, topScore: number }}
 */
export function rankClinicKnowledge(userMessage) {
  const { scored, topScore } = rankClinicKnowledgeScored(userMessage);
  return { items: scored.map((s) => s.item), topScore };
}

function formatFaqItems(items) {
  return items.map((item) => {
    let block = `Q: ${item.question}\nA: ${item.answer}`;
    if (item.url && /^https?:\/\//i.test(item.url)) {
      block += `\n参考ページ: ${item.url}`;
    }
    if (item.category && item.category.trim() !== "") {
      block = `[${item.category}] ${block}`;
    }
    return block;
  });
}

/** ユーザーメッセージに関連する FAQ 項目だけを system 用テキストにまとめる */
export function buildClinicKnowledgeSnippet(userMessage) {
  if (!CLINIC_FAQ_ITEMS.length) {
    return CLINIC_JSON_LOAD_ERROR
      ? `【金井産婦人科（院内FAQ）】\n- 情報の読み込みに失敗しました。`
      : "";
  }

  const { items } = rankClinicKnowledge(userMessage);
  const parts = formatFaqItems(items);
  return `【金井産婦人科（院内FAQ 抜粋・関連が高そうな項目のみ）】\n\n${parts.join("\n\n")}`;
}

/**
 * 参照チップ用（関連 FAQ 項目の URL）
 * @returns {Array<{ url: string, title: string }>}
 */
export function selectReferencedPagesFromCsv(userMessage) {
  const { scored, topScore } = rankClinicKnowledgeScored(userMessage);
  if (topScore <= 0) return [];

  const seen = new Set();
  const out = [];
  for (const { item, score } of scored) {
    if (score < REFERENCE_CHIP_MIN_FAQ_SCORE) continue;
    if (!item.url || !/^https?:\/\//i.test(item.url) || seen.has(item.url)) continue;
    seen.add(item.url);
    const title =
      (item.question || item.category || item.url).replace(/\s+/g, " ").trim().slice(0, 80) ||
      item.url;
    out.push({ url: item.url, title });
  }
  return out.slice(0, JSON_TOP_ITEMS);
}

/** JSON だけでは不足と判断するか（Web 補完のトリガー） */
export function shouldSupplementWithWeb(userMessage, jsonTopScore) {
  const text = String(userMessage || "").trim();
  if (!text) return false;

  if (/最新|更新|今の|現在の|変更|改定/.test(text)) {
    return true;
  }

  if (jsonTopScore < JSON_WEB_SUPPLEMENT_MIN_SCORE) {
    return true;
  }

  return false;
}

export function peekClinicKnowledgeStatus() {
  return {
    jsonPath: "data/clinic-knowledge.json",
    itemCount: CLINIC_FAQ_ITEMS.length,
    referenceUrlCount: CLINIC_REFERENCE_URLS.length,
    loadError: CLINIC_JSON_LOAD_ERROR,
    topItemsPerRequest: JSON_TOP_ITEMS,
    webSupplementMinScore: JSON_WEB_SUPPLEMENT_MIN_SCORE,
  };
}
