import OpenAI, { APIConnectionError, APIError } from "openai";
import { ratelimit } from "./_ratelimit.js";
import {
  buildClinicKnowledgeSnippet,
  peekClinicKnowledgeStatus,
  rankClinicKnowledge,
  selectReferencedPagesFromCsv,
  shouldSupplementWithWeb,
} from "./_clinicKnowledge.js";
import {
  ATTEND_INFO_PAGE_URL,
  getSiteKnowledgeSnippetSupplement,
  isAttendFocusedQuery,
  isMeetingFocusedQuery,
  labelForKnowledgeChunk,
  MEETING_INFO_PAGE_URL,
  peekSiteKnowledgeStatus,
  selectReferencedChunks,
  selectReferencedPagesForChips,
} from "./_siteKnowledge.js";

let client = null;
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

// Chat Completions 用（未設定時は利用しやすい gpt-4o-mini）
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// 出力トークン上限（未設定時は 1200。リッチHTML 用に env で上書き可）
const OPENAI_MAX_OUTPUT_TOKENS = (() => {
  const raw = (process.env.OPENAI_MAX_OUTPUT_TOKENS || "1200").trim();
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1200;
})();

// 院内抜粋を API に載せる最大文字数（入力トークン削減＝待ち時間・コスト削減）
const SITE_SNIPPET_MAX_CHARS = Math.max(
  1500,
  parseInt(process.env.SITE_SNIPPET_MAX_CHARS || "6000", 10)
);

// false のとき JSON のみ（Web 補完なし）。未設定時は true＝ハイブリッド
const CLINIC_WEB_SUPPLEMENT = !["false", "0", "no"].includes(
  (process.env.CLINIC_WEB_SUPPLEMENT || "true").toLowerCase().trim()
);

// true のとき、サイト抜粋は「当院・手続きっぽい質問」のときだけ読む（未設定時は true＝挨拶だけで全ページ取得しない）。
// 従来どおり毎ターン必ず読む場合は SITE_KNOWLEDGE_GATED=false
const SITE_KNOWLEDGE_GATED = !["false", "0", "no"].includes(
  (process.env.SITE_KNOWLEDGE_GATED || "true").toLowerCase().trim()
);

// 初回の挨拶だけは OpenAI を呼ばず即答（遅延をほぼゼロに）。オフは CHAT_INSTANT_GREETING=false
const CHAT_INSTANT_GREETING = !["false", "0", "no"].includes(
  (process.env.CHAT_INSTANT_GREETING || "true").toLowerCase().trim()
);

// 許可するフロントエンドのOrigin（環境変数 ALLOWED_ORIGINS にカンマ区切りで追加可能）
const DEFAULT_ALLOWED_ORIGINS = [
  "https://spica8217.xsrv.jp",
  "https://www.spica8217.xsrv.jp",
];

function loadAllowedOrigins() {
  const extra = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...DEFAULT_ALLOWED_ORIGINS, ...extra])];
}

const ALLOWED_ORIGINS = loadAllowedOrigins();

const SYSTEM_CORE = `
あなたは金井産婦人科の相談窓口です。診断・処方・検査結果の断定はしません。受診前の一般案内と、当院の手続き・施設の案内が役割です。

【回答の優先順位】
1. 別メッセージで渡される院内FAQの事実
2. 安全（緊急キーワードはサーバ側で先に処理される）
3. 簡潔に要点を伝える
4. 必要な分だけ共感する

【禁止】
病名・原因の断定、「大丈夫」等の断言、治療・薬の具体指示、他院・医師の批判、無条件の予約勧奨、個人情報の要求、FAQ・サイト抜粋にない内容の断言、内部用語（JSON・KNOWLEDGE・院内抜粋など）、AI・チャットボットの自称

【根拠の取り方】
院内FAQおよび必要時のサイト抜粋のみを根拠にする。記載がなければ「当院サイトに記載がないため、お問い合わせフォームでご相談ください」と伝える。

【出力形式】
日本語・ですます調。自然な会話文。箇条書きの行頭は「・」のみ（- や * は使わない）。重要語は**太字**。絵文字は適度に（💕💖は不可）。半角・全角コロンは避け「〜は」「〜について」に言い換える。
本文に URL や [ページ名](URL) 形式は書かない。ページ名だけ（例：産後ケアページ）。当院ページの詳細は画面下の参照リンクを案内する一文を入れる。

【避ける締め・言い回し】
感情の決めつけ、一般論のあとに共感を足す硬い言い回し、「〜と良いですね」系の他人事な締め、判断の丸投げ、案内先が曖昧な「何かあればお知らせください」だけの締め

【予約の言い方】
「今すぐ予約」と言わない。「検討できます」「選択肢のひとつです」など患者主体の表現にする。

【制御文字】
<<<PREVIEW>>> 等の旧マーカー、[[[/RICH_HTML]]] 等の誤ったリッチHTMLマーカーは出力しない。

【院内抜粋の使い方（別メッセージ）】
FAQを優先する。発話に「面会」→面会お知らせページ（${MEETING_INFO_PAGE_URL}）の内容のみ。「立ち会い」→立ち会い分娩ページ（${ATTEND_INFO_PAGE_URL}）の内容のみ。他ページの推測を混ぜない。
`.trim();

/** 院内案内の事実質問向け（条件付きで付与） */
const PROMPT_SHORT_ANSWER = `
【このターン：短答モード】
院内の手続き・時間・料金・アクセス等の事実質問です。
・冒頭の共感や前置きは不要。最初の1〜2文でFAQの事実を答える。
・要点は箇条書き2〜5行まで。プレーン文でよい（リッチHTMLは不要）。
・詳細は画面下の参照リンクへ1文で案内する。
`.trim();

/** 症状・不安相談向け（条件付きで付与） */
const PROMPT_TONE_SYMPTOM = `
【このターン：症状・不安への対応】
・診断・原因の断定はしない。短文（腹痛・出血など）は一般論の前置きなく、事実確認の質問から入る（Yes/No・二択可）。
・相手が「不安」と言っていないのに不安と決めつけない。「理解しています」と宣言しない。
・感情語があるときだけ、相手の言葉に寄せて短く1文受け止める。
・緊急が疑われるときは救急・早期受診を優先し、予約は出さない。
・それ以外は選択肢を提示し、予約は強制しない。
`.trim();

/** クレーム・強い不満向け（条件付きで付与） */
const PROMPT_COMPLAINT = `
【このターン：クレーム・不満への対応】
謝罪→気持ちの受け止め→改善姿勢の順で、短く丁寧に。冷たくならず、感情に引っ張られすぎない。
`.trim();

/** 表形式が適切なときだけ付与（診療枠一覧・料金内訳など） */
const RICH_HTML_THIS_TURN = [
  "【このターンの回答形式（最優先）】",
  "曜日別スケジュールや料金内訳など、表で示すのが適切な質問です。",
  "",
  "1. 先頭は空白・改行なしで次の1行だけ：[[[RICH_HTML]]]",
  "2. 続けて HTML のみ。ルートは1つの <div class=\"chat-card\">。表は <table class=\"chat-table\">。",
  "3. マーカーは [[[RICH_HTML]]] のみ。誤形式・マーカー単体は禁止。HTMLが書けない場合はマーカーなしのプレーン文で答える。",
  "4. <<<PREVIEW>>> 等の旧マーカーは使わない。",
  "使ってよいタグ：div, h3, h4, p, table, thead, tbody, tr, th, td, ul, ol, li, strong, em, br, span, a, section, caption",
  "class のみ。a は href（https://www.kanai.or.jp または https://kanai.or.jp）, target=\"_blank\", rel=\"noopener noreferrer\" のみ。",
].join("\n");

function setCors(res, origin) {
  // 許可リストに含まれるOriginのみ許可
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
}

/**
 * JSON ボディを取得する。
 * Vercel は req.body を事前パースするが、Promise で渡る場合がある。
 * Node のストリームからの再読み取りは二重消費でハング/空振りしやすいので行わない。
 */
async function readJsonBody(req) {
  try {
    let raw = req.body;
    if (raw != null && typeof raw.then === "function") {
      raw = await raw;
    }
    if (raw == null) {
      return {};
    }
    if (Buffer.isBuffer(raw)) {
      try {
        return JSON.parse(raw.toString("utf8") || "{}");
      } catch {
        return {};
      }
    }
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw || "{}");
      } catch {
        return {};
      }
    }
    if (typeof raw === "object") {
      return raw;
    }
    return {};
  } catch (e) {
    console.error("readJsonBody error:", e?.message || e);
    return {};
  }
}

async function safeRateLimit(ip) {
  try {
    return await ratelimit.limit(ip);
  } catch (e) {
    console.error("ratelimit error (request allowed):", e?.message || e);
    return { success: true };
  }
}

/**
 * 会話の最初のユーザー発話が、院内案内を要さない短い挨拶だけか
 */
function isCasualGreetingOnlyMessage(userMessage, safeHistory) {
  const userPrior = (safeHistory || []).filter((h) => h && h.role === "user").length;
  if (userPrior > 0) return false;
  const raw = String(userMessage || "").trim();
  if (raw.length > 48) return false;
  const compact = raw.replace(/[\s\u3000]+/g, "");
  return /^(こんにちは|こんばんは|おはようございます|おはよう|はじめまして|よろしくお願いします|よろしく|hello|hi)([!！.。…]*)?$/i.test(
    compact
  );
}

function detectEmergency(text) {
  const t = (text || "").toLowerCase();
  const keywords = [
    "大量出血", "血が止まら", "レバー状",
    "強い腹痛", "激しい腹痛",
    "意識", "もうろう", "けいれん",
    "呼吸が苦しい", "胸が痛い",
    "高熱", "39", "破水した",
    "胎動が少ない", "胎動ない", "胎動減少",
    "失神", "耐えられない痛み"
  ];
  return keywords.some(k => t.includes(k.toLowerCase()));
}

/**
 * 公式サイトを読みにいくかどうか（現在の入力＋直近のユーザー発話をざっくり判定）
 */
function shouldLoadSiteKnowledgeForMessage(userMessage, safeHistory) {
  const chunks = [String(userMessage || "")];
  if (Array.isArray(safeHistory)) {
    for (const h of safeHistory) {
      if (h && h.role === "user") {
        chunks.push(String(h.content || ""));
      }
    }
  }
  const text = chunks.join("\n").slice(-4000);

  const triggers = [
    /当院|本院|金井産婦人科|医療法人\s*金井/,
    /公式サイト|ホームページ|HP|ＨＰ|ウェブ|web\s*予約|ＷＥＢ予約/i,
    /診療時間|診察時間|受付時間|休診|夜診|午前診|午後診|日曜|祝日|土曜/,
    /予約|初診|再診|キャンセル/,
    /料金|費用|支払い|クレジット|現金|予納金|予約金/,
    /駐車場|パーキング|アクセス|行き方|場所|住所|地図|最寄|蒲生|鴫野|今福/,
    /教室|産前教室|産後|面会|立ち会い分娩|立ち会い|入院|個室|レストラン/i,
    /母乳ケア|妊婦健診|乳児健診|健診枠|検診|スケジュール|時間割|枠|空き状況/,
    /里帰り|分娩|出産|産科|婦人科|産後ケア/,
    /Q&A|よくある質問|クイック/,
    /電話|番号|06[-‐]?6931/i,
  ];

  return triggers.some((re) => re.test(text));
}

/** 現在＋直近ユーザー発話を結合（末尾4000文字） */
function recentUserText(userMessage, safeHistory) {
  const chunks = [String(userMessage || "")];
  if (Array.isArray(safeHistory)) {
    for (const h of safeHistory) {
      if (h && h.role === "user") {
        chunks.push(String(h.content || ""));
      }
    }
  }
  return chunks.join("\n").slice(-4000);
}

function looksLikeSymptomOrEmotionConsult(userMessage, safeHistory) {
  const text = recentUserText(userMessage, safeHistory);
  if (
    /怖い|不安|無理|トラウマ|信用できない|心配|つらい|苦しい|痛い|腹痛|出血|吐き気|発熱|陣痛|破水|胎動/.test(
      text
    )
  ) {
    return true;
  }
  const current = String(userMessage || "").trim();
  return current.length > 0 && current.length <= 24 && /痛|血|熱|吐|痒/.test(current);
}

function shouldAddComplaintPrompt(userMessage, safeHistory) {
  const text = recentUserText(userMessage, safeHistory);
  return /クレーム|苦情|不快|ひどい|最悪|ありえない|許せない|不信|ふざけ|態度が悪|他院.*(良|いい)|他の病院.*(良|いい)|訴えたい|文句/.test(
    text
  );
}

/**
 * 表・カードHTMLが適切な質問か（曜日別一覧・料金内訳など。単純な「診療時間は？」は含めない）
 */
function shouldForceRichHtmlForMessage(userMessage, safeHistory) {
  const text = recentUserText(userMessage, safeHistory);

  const scheduleTable =
    /曜日別|曜日ごと|スケジュール|時間割|診療.*一覧|休診.*(曜|日)|午前診.*午後診|午前.*午後.*夜診|平日.*土日|土日祝/.test(
      text
    );
  const feeTable =
    /料金表|料金.*一覧|料金.*内訳|費用.*一覧|費用.*内訳|予納金.*一覧|支払い.*(方法|一覧)|各.*料金|コース.*料金/.test(
      text
    );

  return scheduleTable || feeTable;
}

/** 院内FAQベースの事実質問（症状・クレーム・表形式を除く） */
function shouldUseShortAnswerMode(userMessage, safeHistory) {
  if (!shouldLoadSiteKnowledgeForMessage(userMessage, safeHistory)) return false;
  if (shouldForceRichHtmlForMessage(userMessage, safeHistory)) return false;
  if (looksLikeSymptomOrEmotionConsult(userMessage, safeHistory)) return false;
  if (shouldAddComplaintPrompt(userMessage, safeHistory)) return false;
  return true;
}

/** ターンごとに付与する条件付き system プロンプト */
function buildConditionalSystemPrompts(userMessage, safeHistory) {
  const prompts = [];
  if (shouldForceRichHtmlForMessage(userMessage, safeHistory)) {
    prompts.push(RICH_HTML_THIS_TURN);
  } else if (shouldUseShortAnswerMode(userMessage, safeHistory)) {
    prompts.push(PROMPT_SHORT_ANSWER);
  }
  if (looksLikeSymptomOrEmotionConsult(userMessage, safeHistory)) {
    prompts.push(PROMPT_TONE_SYMPTOM);
  }
  if (shouldAddComplaintPrompt(userMessage, safeHistory)) {
    prompts.push(PROMPT_COMPLAINT);
  }
  return prompts;
}

const RICH_HTML_PREFIX = "[[[RICH_HTML]]]";
const RICH_HTML_MARKER_ANY_RE = /\[\[\[(?:\/)?RICH_HTML\]\]\]+/gi;
const RICH_HTML_MARKER_HEAD_RE = /^(\[\[\[(?:\/)?RICH_HTML\]\]\]+)/i;
const RICH_HTML_LOOKS_LIKE_HTML_RE =
  /^\s*<(?:!\[CDATA\[|div|table|p|h[1-6]|section|ul|ol|thead|tbody|caption|span)\b/i;

/**
 * 誤ったリッチHTMLマーカー（[[[/RICH_HTML]]] 等）を除去・正規化。ユーザーに制御文字を見せない。
 */
function normalizeRichHtmlMarker(text) {
  let s = String(text ?? "");
  if (!s.trim()) return s;

  if (/^\s*\[\[\[(?:\/)?RICH_HTML\]\]\]+\s*$/i.test(s.trim())) {
    return "";
  }

  const head = s.trimStart();
  const open = head.match(RICH_HTML_MARKER_HEAD_RE);
  if (open) {
    const after = head.slice(open[0].length).replace(/^\s*\n?/, "");
    if (RICH_HTML_LOOKS_LIKE_HTML_RE.test(after)) {
      s = RICH_HTML_PREFIX + after;
    } else {
      s = after;
    }
  }

  s = s.replace(/\[\[\[\/RICH_HTML\]\]\]+/gi, "");

  if (s.startsWith(RICH_HTML_PREFIX)) {
    const body = s.slice(RICH_HTML_PREFIX.length).replace(RICH_HTML_MARKER_ANY_RE, "");
    s = RICH_HTML_PREFIX + body;
  } else {
    s = s.replace(RICH_HTML_MARKER_ANY_RE, "");
  }

  if (s.trim() === RICH_HTML_PREFIX) {
    return "";
  }

  return s.trim();
}

/** Markdownリンク・文中の当院URLを除去（チップ表示に任せる） */
function stripMarkdownLinksAndInlineKanaiUrls(text) {
  let s = String(text || "");
  if (!s || s.startsWith("[[[RICH_HTML]]]")) return s;

  // [産後ケアページ](https://...) → 産後ケアページ
  s = s.replace(/\[([^\]\n]+)\]\(\s*https?:\/\/[^)\s]+\s*\)/g, "$1");

  // 文中に残った当院 URL を除去
  s = s.replace(/https?:\/\/(?:www\.)?kanai\.or\.jp[^\s)\]<>"]*/gi, "");

  // URL除去後の不自然な空白・句読点を整理
  s = s.replace(/[ \t]{2,}/g, " ");
  s = s.replace(/\s+([、。])/g, "$1");
  s = s.replace(/([、。])\s*([、。])/g, "$1");

  return s.trim();
}

/** モデルが文末に付けた当院 URL の箇条書きを落とす（チップ表示と重複しないように） */
function stripTrailingKanaiUrlBulletLines(text) {
  const s = String(text || "").trim();
  if (!s || s.startsWith("[[[RICH_HTML]]]")) return s;
  const lines = s.split("\n");
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    const trimmed = last.trim();
    if (trimmed === "") {
      lines.pop();
      continue;
    }
    if (
      /^\s*[・•‧*＊\-−]\s*https?:\/\/(www\.)?kanai\.or\.jp\/\S+\s*$/i.test(last) ||
      /^https?:\/\/(www\.)?kanai\.or\.jp\/\S+\s*$/i.test(trimmed)
    ) {
      lines.pop();
      continue;
    }
    break;
  }
  return lines.join("\n").trimEnd();
}

/**
 * モデルが旧二層形式（PREVIEW/DETAIL）で返した本文を、単一の表示用テキストに直す
 */
function normalizeLegacyTwoLayerAnswerCore(text) {
  const PRE_OPEN = "<<<PREVIEW>>>";
  const DET_OPEN = "<<<DETAIL>>>";
  const PRE_CLOSES = ["<<</PREVIEW>>>", "<<</PREVIEW>>"];
  const DET_CLOSES = ["<<</DETAIL>>>", "<<</DETAIL>>", "<</DETAIL>>>"];

  function firstClose(s, closes) {
    let bestIdx = -1;
    let needle = "";
    for (const c of closes) {
      const i = s.indexOf(c);
      if (i !== -1 && (bestIdx === -1 || i < bestIdx)) {
        bestIdx = i;
        needle = c;
      }
    }
    return bestIdx === -1 ? null : { index: bestIdx, needle };
  }

  function stripKnownMarkers(str) {
    let x = String(str);
    const order = [
      "<<</PREVIEW>>>",
      "<<</DETAIL>>>",
      "<<<PREVIEW>>>",
      "<<<DETAIL>>>",
      "<</DETAIL>>>",
      "<<</PREVIEW>>",
      "<<</DETAIL>>",
      "[[[RICH_HTML]]]",
      "[[[/RICH_HTML]]]",
      "[[[\\/RICH_HTML]]]",
    ];
    for (const m of order) {
      x = x.split(m).join("");
    }
    return x.trim();
  }

  const t = String(text || "");
  if (!t.includes(PRE_OPEN)) {
    return t.trim();
  }

  const po = t.indexOf(PRE_OPEN);
  const afterPO = t.slice(po + PRE_OPEN.length);
  const pc = firstClose(afterPO, PRE_CLOSES);

  if (!pc) {
    return stripKnownMarkers(afterPO) || t.trim();
  }

  const preview = stripKnownMarkers(afterPO.slice(0, pc.index));
  const afterPC = afterPO.slice(pc.index + pc.needle.length);
  const d0 = afterPC.indexOf(DET_OPEN);
  if (d0 === -1) {
    return preview || stripKnownMarkers(afterPC) || t.trim();
  }

  const afterDO = afterPC.slice(d0 + DET_OPEN.length);
  const dc = firstClose(afterDO, DET_CLOSES);
  const detailRaw = dc ? afterDO.slice(0, dc.index) : afterDO;
  let detail = stripKnownMarkers(detailRaw);
  const dSt = detail.trimStart();

  if (dSt.startsWith("[[[RICH_HTML]]]")) {
    return dSt;
  }
  if (preview && detail) {
    return `${preview}\n\n${detail}`;
  }
  if (detail) {
    return detail;
  }
  if (preview) {
    return preview;
  }
  return stripKnownMarkers(t);
}

function stripOverDelegatingClosing(text) {
  let s = String(text || "");
  const fallback = "何か質問があれば、ぜひお聞かせください。";
  const patterns = [
    /次にどうするかは、あなた自身が選べる状態を大切にしていただきたいです。?\s*どのように進めていくのか考えてみることも良いですね。?/g,
    /どのように進め(?:る|ていく)か、?\s*あなた自身(?:で)?考え(?:られる|てみる)(?:こと)?(?:ができる)?(?:と)?良いですね。?/g,
    // 他人事・距離感のある締め（「あなたの安心につながると良いですね」等）
    /(?:あなたの|なたの|ご自身の)?安心[^。\n]*?と(?:良|い)いですね[。]?/g,
    /(?:あなたの|なたの)[^。\n]{0,24}?と(?:良|い)いですね[。]?/g,
    /[^。\n]*?につながると(?:良|い)いですね[。]?/g,
    /[^。\n]*?お役に立てれば(?:と|と思)(?:良|い)いですね[。]?/g,
  ];
  for (const re of patterns) {
    s = s.replace(re, fallback);
  }
  s = s.replace(/(?:何か質問があれば、ぜひお聞かせください。\s*){2,}/g, `${fallback}\n`);
  // 締め置換だけが残った行を整理
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

function normalizeLegacyTwoLayerAnswer(text) {
  const raw = String(text || "").trim();
  const out = normalizeRichHtmlMarker(
    stripMarkdownLinksAndInlineKanaiUrls(
      stripOverDelegatingClosing(
        stripTrailingKanaiUrlBulletLines(normalizeLegacyTwoLayerAnswerCore(text))
      )
    )
  );
  if (raw && !out) {
    return "すみません、表示用の回答を整形できませんでした。もう一度お試しください。";
  }
  return out;
}

function writeNdjsonLine(res, obj) {
  res.write(`${JSON.stringify(obj)}\n`);
}

/**
 * OpenAI のストリームを NDJSON でクライアントへ流す（1行1JSON）
 */
async function pipeOpenAIStreamNdjson(res, openai, userMessage, messages, referencedPages) {
  const stream = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages,
    stream: true,
    max_tokens: OPENAI_MAX_OUTPUT_TOKENS,
  });

  let fullAnswer = "";
  for await (const part of stream) {
    const delta = part.choices[0]?.delta?.content || "";
    if (delta) {
      fullAnswer += delta;
      writeNdjsonLine(res, { type: "delta", text: delta });
    }
  }

  const trimmed = normalizeLegacyTwoLayerAnswer(fullAnswer.trim());
  const now = new Date();
  console.log(
    "chat-log",
    JSON.stringify({
      ts: now.toISOString(),
      ts_jst: now.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }),
      user: userMessage,
      answer: trimmed,
      streamed: true,
    })
  );

  if (referencedPages && referencedPages.length > 0) {
    writeNdjsonLine(res, { type: "references", pages: referencedPages });
  }
  writeNdjsonLine(res, { type: "done" });
  return trimmed;
}

function emergencyMessage() {
  return [
    "⚠️ 現在の症状からは、**緊急性が高い可能性があります。**",
    "",
    "次のような状態に当てはまる場合は、**すぐに医療機関へ電話で相談し、受診をご検討ください。**",
    "・大量の出血がある、血が止まりにくい",
    "・我慢できないほどの強い腹痛や胸の痛みがある",
    "・意識がもうろうとしている、けいれんがある",
    "・高い熱が続いている（39℃前後など）",
    "・破水が疑われる、胎動が明らかに少ない  など",
    "",
    "当院へのご相談は 📞**06-6931-2391**（番号非通知は不可） までお電話ください。",
    "夜間などで今すぐ対応が必要だと感じる場合は、**119番（救急要請）も検討してください。**",
  ].join("\n");
}

// できるだけログを残さない（Vercelの標準ログは最小限に）
export default async function handler(req, res) {
  try {
    const origin = req.headers.origin;
    setCors(res, origin);

    // Preflight（CORS事前確認用）
    if (req.method === "OPTIONS") {
      return res.status(200).end();
    }

    // デプロイ確認・設定確認用（ブラウザで開かない想定）
    if (req.method === "GET") {
      return res.status(200).json({
        ok: true,
        hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
        model: OPENAI_MODEL,
        maxOutputTokens: OPENAI_MAX_OUTPUT_TOKENS ?? null,
        siteSnippetMaxChars: SITE_SNIPPET_MAX_CHARS,
        emergencyRoutingWorks: detectEmergency("大量出血しています"),
        knowledgeSource: "hybrid_json_web",
        clinicWebSupplement: CLINIC_WEB_SUPPLEMENT,
        siteKnowledgeGated: SITE_KNOWLEDGE_GATED,
        instantGreeting: CHAT_INSTANT_GREETING,
        clinicKnowledge: peekClinicKnowledgeStatus(),
        siteKnowledge: peekSiteKnowledgeStatus(),
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // ---- レート制限（IPごと）----
    const ip =
      (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
      req.socket?.remoteAddress ||
      "ip";

    const { success } = await safeRateLimit(ip);
    if (!success) {
      return res.status(429).json({
        answer: "アクセスが集中しています。少し時間をおいてからお試しください。",
        emergency: false,
        ratelimited: true,
      });
    }

    // 許可していないOriginからのアクセスは拒否（ブラウザの fetch では Origin ヘッダが付く）
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
      return res.status(403).json({
        answer:
          "接続元が許可されていないため送信できません。（ページの公開URLとサーバ設定の許可リストをご確認ください）",
        emergency: false,
        error: "Forbidden origin",
      });
    }

    const body = await readJsonBody(req);
    const userMessage = (body.message || "").trim();
    const wantStream = Boolean(body.stream);
    const history = body.history;
    if (!userMessage) {
      return res.status(400).json({ answer: "メッセージが空です。", emergency: false });
    }

    // 危険サインはモデルに投げずに即時誘導（安全のため）
    if (detectEmergency(userMessage)) {
      return res.status(200).json({ answer: emergencyMessage(), emergency: true });
    }

    const openai = getOpenAIClient();
    if (!openai) {
      console.error("OPENAI_API_KEY is not configured");
      return res.status(500).json({
        answer: "AI連携の設定が完了していません。管理者に連絡してください。",
        emergency: false,
      });
    }

    const safeHistory = Array.isArray(history) ? history.slice(-4) : [];

    const casualGreetingOnly = isCasualGreetingOnlyMessage(userMessage, safeHistory);

    if (CHAT_INSTANT_GREETING && casualGreetingOnly) {
      const answer =
        "こんにちは。今日はどのようなことでお手伝いしましょうか。症状やご心配なことがあれば、分かる範囲で教えてください。";
      const now = new Date();
      console.log(
        "chat-log",
        JSON.stringify({
          ts: now.toISOString(),
          ts_jst: now.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }),
          user: userMessage,
          answer,
          instantGreeting: true,
        })
      );
      return res.status(200).json({ answer, emergency: false, instantGreeting: true });
    }

    let clinicSnippet = "";
    let referencedPages = [];
    const needsClinicKnowledge =
      !casualGreetingOnly &&
      (!SITE_KNOWLEDGE_GATED || shouldLoadSiteKnowledgeForMessage(userMessage, safeHistory));

    if (needsClinicKnowledge) {
      const { topScore: csvTopScore } = rankClinicKnowledge(userMessage);
      clinicSnippet = buildClinicKnowledgeSnippet(userMessage);

      const seenUrl = new Set();
      for (const page of selectReferencedPagesFromCsv(userMessage)) {
        if (!page?.url || seenUrl.has(page.url)) continue;
        seenUrl.add(page.url);
        referencedPages.push(page);
      }

      if (CLINIC_WEB_SUPPLEMENT && shouldSupplementWithWeb(userMessage, csvTopScore)) {
        const { snippet: webSnippet, state } = await getSiteKnowledgeSnippetSupplement(userMessage);
        if (webSnippet) {
          clinicSnippet = clinicSnippet
            ? `${clinicSnippet}\n\n---\n\n${webSnippet}`
            : webSnippet;
        }

        let chunks = selectReferencedPagesForChips(userMessage, state);
        if (
          !chunks.length &&
          webSnippet &&
          ((state?.singlePageOnly ?? state?.meetingOnly) ||
            shouldLoadSiteKnowledgeForMessage(userMessage, safeHistory))
        ) {
          chunks = selectReferencedChunks(userMessage, state);
        }
        for (const c of chunks) {
          if (!c?.url || seenUrl.has(c.url)) continue;
          seenUrl.add(c.url);
          referencedPages.push({
            url: c.url,
            title: String(labelForKnowledgeChunk(c)).replace(/\s+/g, " ").trim() || c.url,
          });
        }
        if (state?.attendOnly && !referencedPages.some((p) => p.url === ATTEND_INFO_PAGE_URL)) {
          referencedPages.push({
            url: ATTEND_INFO_PAGE_URL,
            title: "立ち会い分娩について",
          });
        } else if (state?.meetingOnly && !referencedPages.some((p) => p.url === MEETING_INFO_PAGE_URL)) {
          referencedPages.push({
            url: MEETING_INFO_PAGE_URL,
            title: "面会について",
          });
        }
      } else if (isAttendFocusedQuery(userMessage) && !referencedPages.length) {
        referencedPages.push({ url: ATTEND_INFO_PAGE_URL, title: "立ち会い分娩について" });
      } else if (isMeetingFocusedQuery(userMessage) && !referencedPages.length) {
        referencedPages.push({ url: MEETING_INFO_PAGE_URL, title: "面会について" });
      }

      if (clinicSnippet.length > SITE_SNIPPET_MAX_CHARS) {
        clinicSnippet =
          clinicSnippet.slice(0, SITE_SNIPPET_MAX_CHARS) +
          "\n\n（以降、文字数制限のため省略しました）";
      }

    }

    const messages = [
      { role: "system", content: SYSTEM_CORE },
      ...buildConditionalSystemPrompts(userMessage, safeHistory).map((content) => ({
        role: "system",
        content,
      })),
      // 院内情報（JSON 優先。不足時のみ Web 抜粋を付加）
      ...(clinicSnippet
        ? [
            {
              role: "system",
              content: clinicSnippet,
            },
          ]
        : []),
      ...safeHistory
        .filter((h) => h && (h.role === "user" || h.role === "assistant"))
        .map((h) => ({
          role: h.role,
          content:
            h.role === "assistant"
              ? normalizeLegacyTwoLayerAnswer(String(h.content || ""))
              : String(h.content || ""),
        })),
      { role: "user", content: userMessage },
    ];

    if (wantStream) {
      try {
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
        });
        await pipeOpenAIStreamNdjson(res, openai, userMessage, messages, referencedPages);
        res.end();
      } catch (streamErr) {
        console.error("openai stream error:", streamErr?.message || streamErr);
        if (!res.headersSent) {
          return res.status(500).json({
            answer: "サーバ側でエラーが発生しました。",
            emergency: false,
          });
        }
        try {
          writeNdjsonLine(res, {
            type: "error",
            message: "応答の送信が途中で止まりました。時間をおいて再度お試しください。",
          });
        } catch {
          /* ignore */
        }
        res.end();
      }
      return;
    }

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages,
      max_tokens: OPENAI_MAX_OUTPUT_TOKENS,
    });

    const raw =
      (completion.choices[0]?.message?.content || "").trim() ||
      "すみません、うまく回答を生成できませんでした。";
    const answer = normalizeLegacyTwoLayerAnswer(raw);

    // Vercel のログにチャット内容（生テキスト）を残す
    // - IP やブラウザ情報などの識別子は含めない
    // - JST と ISO の両方のタイムスタンプを記録して、あとから見やすくする
    const now = new Date();
    const tsIso = now.toISOString();
    const tsJst = now.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

    console.log(
      "chat-log",
      JSON.stringify({
        ts: tsIso,
        ts_jst: tsJst,
        user: userMessage,
        answer,
      })
    );

    return res.status(200).json({ answer, emergency: false, referencedPages });
  } catch (e) {
    const detail = e?.message || String(e);
    const status = e?.status ?? e?.response?.status;
    const code = e?.code;
    console.error(
      "chat handler error:",
      detail,
      status != null ? `http=${status}` : "",
      code != null ? `code=${code}` : ""
    );

    if (e instanceof APIConnectionError) {
      return res.status(500).json({
        answer: "AIサービスへ接続できませんでした。時間をおいて再度お試しください。",
        emergency: false,
      });
    }

    if (status === 401) {
      return res.status(500).json({
        answer:
          "AIサービスの認証に失敗しました。本番環境の OPENAI_API_KEY をダッシュボードで確認してください。",
        emergency: false,
      });
    }

    if (status === 403) {
      return res.status(500).json({
        answer:
          "AIの利用がこのキーでは許可されていません（組織・プロジェクト設定を確認してください）。",
        emergency: false,
      });
    }

    if (status === 404) {
      return res.status(500).json({
        answer: `AIモデル「${OPENAI_MODEL}」が利用できません。Vercel の OPENAI_MODEL を gpt-4o-mini などに設定し直してください。`,
        emergency: false,
      });
    }

    if (status === 429 || code === "insufficient_quota") {
      return res.status(500).json({
        answer:
          "AIサービス側の混雑、または利用上限に達しています。しばらくしてからお試しいただくか、請求・枠をご確認ください。",
        emergency: false,
      });
    }

    if (status === 400 && e instanceof APIError) {
      return res.status(500).json({
        answer:
          "AIへのリクエストが拒否されました（モデル名・入力内容の制限）。管理者が OPENAI_MODEL 等を確認してください。",
        emergency: false,
      });
    }

    return res.status(500).json({ answer: "サーバ側でエラーが発生しました。", emergency: false });
  }
}