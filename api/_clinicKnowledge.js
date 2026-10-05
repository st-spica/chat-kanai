/**
 * data/clinic-knowledge.json を起動時に1回読み込み、質問に関連する項目だけ抜粋する。
 * Web 取得より軽量な院内知識の主データソース。
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { rewriteLegacyKanaiUrl } from "./_siteKnowledge.js";

const JSON_TOP_ITEMS = Math.min(
  10,
  Math.max(1, parseInt(process.env.CSV_SNIPPET_TOP_ITEMS || process.env.JSON_SNIPPET_TOP_ITEMS || "3", 10))
);
/** 参照チップに載せる FAQ 項目の最低スコア（短い質問が多いので低め） */
const REFERENCE_CHIP_MIN_FAQ_SCORE = Math.max(
  1,
  parseInt(process.env.REFERENCE_CHIP_MIN_FAQ_SCORE || "5", 10)
);
/** このスコア未満なら Web 補完を検討（FAQヒット時は Web で上書きしない） */
const JSON_WEB_SUPPLEMENT_MIN_SCORE = Math.max(
  1,
  parseInt(process.env.CSV_WEB_SUPPLEMENT_MIN_SCORE || process.env.JSON_WEB_SUPPLEMENT_MIN_SCORE || "12", 10)
);

/** 短い質問向けトピック対応（user含む → FAQ側に語があれば加点） */
const TOPIC_BOOSTS = [
  { user: /立ち会い/, faq: /立ち会い/, score: 50 },
  { user: /面会/, faq: /面会/, score: 50 },
  { user: /駐車|パーキング/, faq: /駐車|パーキング/, score: 45 },
  { user: /キャンセル|取消|取り消/, faq: /キャンセル/, score: 45 },
  { user: /ピル|アフターピル|避妊薬/, faq: /ピル|避妊/, score: 45 },
  { user: /診療時間|診察時間|受付時間|休診|何時から|何時まで/, faq: /診療時間|午前診|午後診|夜診|休診/, score: 45 },
  // 料金系は「概算・分娩」を短い一般質問の第一候補にする
  {
    user: /料金|費用|いくら|値段/,
    faq: /概算料金|予約金|予納金|分娩料|入院費/,
    score: 55,
  },
  {
    user: /料金|費用|いくら|値段|予約金|予納/,
    faq: /料金|費用|予約金|予納|いくら/,
    score: 25,
  },
  { user: /オンライン/, faq: /オンライン/, score: 50 },
  { user: /不妊/, faq: /不妊/, score: 50 },
  { user: /個室/, faq: /個室/, score: 50 },
  { user: /クレジット|カード決済|支払い|払える/, faq: /クレジット|支払|現金/, score: 45 },
  { user: /里帰り/, faq: /里帰り/, score: 50 },
  { user: /無痛/, faq: /無痛/, score: 50 },
  { user: /レストラン|食事|食堂/, faq: /レストラン|食事|食堂|ディナー/, score: 40 },
  { user: /母乳|搾乳|ミルクケア/, faq: /母乳|ミルク|授乳/, score: 40 },
  { user: /産後ケア|アフターサポート/, faq: /産後ケア|アフター|aftercare|aftersupport/i, score: 40 },
  { user: /持ち物|入院準備|何を持/, faq: /持ち物|ご用意|入院セット|お産セット/, score: 45 },
  { user: /WEB予約|ウェブ予約|ネット予約/, faq: /WEB予約|ウェブ予約|予約/, score: 35 },
  { user: /子宮がん|がん検診/, faq: /子宮がん|がん検診/, score: 45 },
  { user: /性病|性感染症|STD|クラミジア|淋病/, faq: /性病|性感染症|クラミジア/, score: 45 },
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const JSON_PATH = join(__dirname, "../data/clinic-knowledge.json");

function normalizeFaqItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const category = String(raw.category ?? "").trim();
  const question = String(raw.question ?? "").trim();
  const answer = String(raw.answer ?? "").trim();
  const url = rewriteLegacyKanaiUrl(String(raw.url ?? "").trim());
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

const SCORING_STOP_TOKENS = new Set([
  "必要",
  "教え",
  "ほしい",
  "ある",
  "ない",
  "です",
  "ます",
  "ください",
  "教えて",
  "したい",
  "やりたい",
  "もらえる",
  "できる",
  "ですか",
  "ますか",
  "のか",
  "どう",
]);

/** 短い口語質問を正規化（助詞・疑問表現を落とす） */
function normalizeUserQuery(text) {
  return String(text || "")
    .trim()
    .replace(/診察中/g, "診療中")
    .replace(/先生/g, "医師")
    .replace(/必要なもの/g, "持ち物")
    .replace(/入院する|入院のとき|入院時/g, "入院")
    .replace(/[？?！!。．、,…〜~･・]/g, " ")
    .replace(
      /してもいいですか|していいですか|してよいですか|できますか|できる\s*|ありますか|ある\s*|やってる|やってますか|もらえる|したい|知りたい|教えて(ください)?|お願いします|について|ですか|ますか|なの|のか|どうなの/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeForScoring(text) {
  const raw = normalizeUserQuery(text);
  if (!raw) return [];

  const parts = raw
    .split(/[\s\u3000のをにはがとでもからまでへやなどって]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (SCORING_STOP_TOKENS.has(key)) continue;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  // 短い質問で分割できない場合は全文を1トークンとして使う
  if (!out.length && raw.length >= 2) out.push(raw);

  // 「面会時間」→「面会」「時間」のように複合語を2文字単位で分解（3文字は誤爆しやすい）
  const expanded = [];
  for (const p of out) {
    expanded.push(p);
    if (p.length >= 4) {
      for (let i = 0; i <= p.length - 2; i++) {
        const sub = p.slice(i, i + 2);
        if (!SCORING_STOP_TOKENS.has(sub)) expanded.push(sub);
      }
    }
  }
  const seen2 = new Set();
  const final = [];
  for (const p of expanded) {
    const key = p.toLowerCase();
    if (seen2.has(key)) continue;
    seen2.add(key);
    final.push(p);
  }
  return final;
}

/**
 * @param {string} userMessage
 * @param {{ category: string, question: string, answer: string, url: string }} item
 */
function scoreFaqItem(userMessage, item) {
  const text = String(userMessage || "").trim();
  if (!text) return 0;
  const normalizedText = normalizeUserQuery(text);
  const lowered = normalizedText.toLowerCase();
  const qHay = `${item.category}\n${item.question}`.toLowerCase();
  const aHay = String(item.answer || "").toLowerCase();
  const hayFull = `${item.category}\n${item.question}\n${item.answer}`;
  let score = 0;

  // 1) トピック一致（短い1文向け・最重要）
  for (const t of TOPIC_BOOSTS) {
    if (t.user.test(text) && t.faq.test(hayFull)) {
      score += t.score;
      // 質問文側にトピックがあるときはさらに加点
      if (t.faq.test(`${item.category}\n${item.question}`)) score += 12;
    }
  }

  // 2) ユーザー語が FAQ 質問に含まれる（回答ヒットはごく小さく：短い質問の誤爆防止）
  const tokens = tokenizeForScoring(text);
  let qHit = 0;
  for (const tok of tokens) {
    const t = tok.toLowerCase();
    if (t.length >= 3 && qHay.includes(t)) {
      score += t.length * 5;
      qHit += 1;
    } else if (t.length === 2 && qHay.includes(t)) {
      score += 12;
      qHit += 1;
    } else if (t.length >= 3 && aHay.includes(t)) score += Math.min(t.length, 3);
    else if (t.length === 2 && aHay.includes(t)) score += 1;
  }
  // 質問文側に複数ヒットした項目を優先（短い複合語向け）
  if (qHit >= 2) score += 25;

  // 3) FAQ質問の主要語がユーザー語と一致（部分包含の誤爆を避ける）
  const userTokSet = new Set(tokens.map((t) => t.toLowerCase()));
  const qTokens = String(item.question || "")
    .replace(/[？?！!。．]/g, " ")
    .split(/[\s、・,?／/のをにはがとでも]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !SCORING_STOP_TOKENS.has(t));
  for (const tok of qTokens) {
    const t = tok.toLowerCase();
    if (userTokSet.has(t)) {
      score += t.length >= 3 ? t.length * 3 : 8;
    }
  }

  if (item.category) {
    const cat = String(item.category).toLowerCase();
    if (lowered.includes(cat)) score += 8;
    // カテゴリの先頭語（例: 診療/受付 → 診療）
    const catHead = cat.split(/[/\s]/)[0];
    if (catHead.length >= 2 && lowered.includes(catHead)) score += 4;
  }

  // 正規化後の短文が質問にほぼ含まれる
  if (lowered.length >= 2 && lowered.length <= 40 && qHay.includes(lowered)) {
    score += 35;
  }

  const doctorGenderQuery =
    /(?:医師|担当医|主治医).*(?:男性|女性|性別)|(?:男性|女性).*(?:医師|担当医)|男性医師|女性医師|男の医師|女の医師|男性のみ|女性のみ|先生は男性|先生は女性/.test(
      text
    );
  if (
    doctorGenderQuery &&
    /医師|担当医|診療体制|指名|女性医師|男性医師|男性のみ/.test(hayFull)
  ) {
    score += 20;
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

  // ヒットなしのとき無関係な先頭FAQを混ぜない（短い質問で誤誘導しやすい）
  if (!scored.length) {
    return { scored: [], topScore: 0 };
  }

  const topScore = scored[0].score;
  // 短い質問は原則1件だけ渡し、JSONが薄まらないようにする
  const isShort = String(userMessage || "").trim().length <= 24;
  const maxItems = isShort ? 1 : JSON_TOP_ITEMS;
  const minKeep = Math.max(topScore * (isShort ? 0.55 : 0.45), topScore - (isShort ? 20 : 30));
  const filtered = scored.filter((s) => s.score >= minKeep).slice(0, maxItems);

  return { scored: filtered.length ? filtered : scored.slice(0, 1), topScore };
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

  const { scored, topScore } = rankClinicKnowledgeScored(userMessage);
  if (!scored.length || topScore <= 0) return "";

  const parts = formatFaqItems(scored.map((s) => s.item));
  return [
    "【金井産婦人科（院内FAQ・最優先の根拠）】",
    "次の Q&A を最優先で使い、矛盾する一般知識や推測で上書きしないでください。",
    "短い質問でも、下記の該当項目の回答内容をそのまま分かりやすく伝えてください。",
    "",
    parts.join("\n\n"),
  ].join("\n");
}

/** サイトTOPなど、チップとして出しても案内にならない汎用URLか */
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

/** URLの具体性（深いパス・アンカーほど高い） */
function urlSpecificityScore(url) {
  try {
    const u = new URL(String(url || "").trim());
    const path = (u.pathname || "/").replace(/\/+$/, "") || "/";
    const segments = path.split("/").filter(Boolean);
    let s = segments.length * 12;
    if (u.hash) s += 18;
    if (u.search) s += 4;
    if (isGenericKanaiHomeUrl(url)) s -= 100;
    return s;
  } catch {
    return 0;
  }
}

/**
 * 参照チップ用（関連 FAQ のうち、最も具体的な URL を1件）
 * TOP（サイトルート）は出さない。該当がTOPのみなら空配列。
 * @returns {Array<{ url: string, title: string }>}
 */
export function selectReferencedPagesFromCsv(userMessage) {
  const { scored, topScore } = rankClinicKnowledgeScored(userMessage);
  const isShort = String(userMessage || "").trim().length <= 24;
  const minScore = isShort
    ? Math.min(REFERENCE_CHIP_MIN_FAQ_SCORE, 4)
    : REFERENCE_CHIP_MIN_FAQ_SCORE;
  if (topScore < minScore) return [];

  const candidates = scored
    .filter(({ score, item }) => {
      if (score < minScore) return false;
      if (score < topScore - 15 && score < topScore * 0.7) return false;
      if (!item.url || !/^https?:\/\//i.test(item.url)) return false;
      if (isGenericKanaiHomeUrl(item.url)) return false;
      return true;
    })
    .map(({ item, score }) => ({
      item,
      score,
      specificity: urlSpecificityScore(item.url),
    }))
    .sort((a, b) => b.score - a.score || b.specificity - a.specificity);

  if (!candidates.length) return [];

  const best = candidates[0];
  const title =
    (best.item.question || best.item.category || best.item.url)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || best.item.url;
  return [{ url: best.item.url, title }];
}

/** JSON だけでは不足と判断するか（Web 補完のトリガー） */
export function shouldSupplementWithWeb(userMessage, jsonTopScore) {
  const text = String(userMessage || "").trim();
  if (!text) return false;

  if (/最新|更新|今の|現在の|変更|改定/.test(text)) {
    return true;
  }

  // 短い質問で FAQ がヒットしているときは Web を足さない（JSONを優先）
  const isShort = text.length <= 24;
  if (isShort && jsonTopScore >= 5) {
    return false;
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
