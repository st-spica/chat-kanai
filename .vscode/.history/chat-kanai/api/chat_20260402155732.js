import OpenAI, { APIConnectionError, APIError } from "openai";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { ratelimit } from "./_ratelimit.js";

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

// CSVファイルから院内情報を読み込み（起動時に1回だけ実行）
function loadClinicKnowledge() {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const filePath = join(__dirname, "../data/clinic-knowledge.csv");
    const csvContent = readFileSync(filePath, "utf-8");
    
    // CSVをパース（カテゴリ,質問,回答,参照URLの形式）
    const lines = csvContent
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.length > 0);
    
    if (lines.length < 2) {
      throw new Error("CSVファイルの形式が正しくありません");
    }
    
    // ヘッダー行をスキップしてデータを処理
    const faqItems = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      // CSVのカンマ区切りを解析（ダブルクォート内のカンマに対応）
      const columns = [];
      let current = "";
      let inQuotes = false;
      
      for (let j = 0; j < line.length; j++) {
        const char = line[j];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          columns.push(current.trim());
          current = "";
        } else {
          current += char;
        }
      }
      columns.push(current.trim()); // 最後の列
      
      if (columns.length >= 3) {
        const [category, question, answer, url] = columns;
        faqItems.push({
          category: category || "",
          question: question || "",
          answer: answer || "",
          url: url || ""
        });
      }
    }
    
    // 質問と回答のペアを明確に提示する形式で整形（全文用）
    const formattedItems = [];
    const referenceUrls = [];
    
    faqItems.forEach(item => {
      const hasHttpAnswer =
        item.answer && (item.answer.startsWith("http://") || item.answer.startsWith("https://"));

      // 回答がURLのみの場合（純粋な参考URLとして扱う）
      if (hasHttpAnswer && (!item.question || item.question.trim() === "")) {
        referenceUrls.push(item.answer);
        return;
      }

      // 通常のQ&A形式
      let text = `Q: ${item.question}\nA: ${item.answer}`;

      // 参照URL列がある場合は、回答の末尾に「参考ページ」としてURLを添える
      if (item.url && (item.url.startsWith("http://") || item.url.startsWith("https://"))) {
        text += `\n参考ページ: ${item.url}`;
      }

      // カテゴリが空の場合はカテゴリ表示をスキップ（基本情報など）
      if (item.category && item.category.trim() !== "") {
        text = `[${item.category}] ${text}`;
      }

      formattedItems.push(text);
    });
    
    let knowledgeText = `【金井産婦人科（院内FAQ要約・抜粋）】\n\n${formattedItems.join("\n\n")}`;
    
    // 参考URLがある場合は追加
    if (referenceUrls.length > 0) {
      knowledgeText += `\n\n【参考URL】\n${referenceUrls.map(url => `- ${url}`).join("\n")}`;
    }

    return {
      faqItems,
      referenceUrls,
      knowledgeText,
    };
  } catch (error) {
    // フォールバック：デフォルト値
    console.error("CSVファイルの読み込みに失敗しました:", error.message);
    return {
      faqItems: [],
      referenceUrls: [],
      knowledgeText: `【金井産婦人科（院内FAQ要約・抜粋）】\n- 情報の読み込みに失敗しました。`,
    };
  }
}

// 起動時に1回だけ読み込む（処理を軽くするため）
const { faqItems: CLINIC_FAQ_ITEMS, referenceUrls: CLINIC_REFERENCE_URLS, knowledgeText: CLINIC_KNOWLEDGE_TEXT } =
  loadClinicKnowledge();

// ユーザーの質問に関連が高そうな院内情報だけを数件ピックアップして渡す
function buildClinicKnowledgeSnippet(userMessage) {
  const text = (userMessage || "").trim();
  if (!text || !Array.isArray(CLINIC_FAQ_ITEMS) || CLINIC_FAQ_ITEMS.length === 0) {
    return CLINIC_KNOWLEDGE_TEXT || "";
  }

  const lowered = text.toLowerCase();

  const scored = CLINIC_FAQ_ITEMS.map((item) => {
    const q = String(item.question || "");
    const tokens = q.split(/[\s、。・,]+/).filter((t) => t.length >= 2);
    let score = 0;
    for (const tok of tokens) {
      if (lowered.includes(tok.toLowerCase())) {
        score += tok.length;
      }
    }
    // カテゴリ名も少しだけ重みをつける
    if (item.category && lowered.includes(String(item.category).toLowerCase())) {
      score += 3;
    }
    return { item, score };
  });

  // スコア順に並べて上位数件だけ使う
  const top = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(({ item }) => item);

  // 一致がまったくないときは、全文よりも軽い「代表的な数件」を返す
  const useItems = top.length > 0 ? top : CLINIC_FAQ_ITEMS.slice(0, 5);

  const parts = useItems.map((item) => {
    let text = `Q: ${item.question}\nA: ${item.answer}`;
    if (item.url && (item.url.startsWith("http://") || item.url.startsWith("https://"))) {
      text += `\n参考ページ: ${item.url}`;
    }
    if (item.category && item.category.trim() !== "") {
      text = `[${item.category}] ${text}`;
    }
    return text;
  });

  let snippet = `【金井産婦人科（院内FAQ 抜粋・関連が高そうな項目のみ）】\n\n${parts.join("\n\n")}`;

  // 参考URLを軽く添える
  if (Array.isArray(CLINIC_REFERENCE_URLS) && CLINIC_REFERENCE_URLS.length > 0) {
    snippet += `\n\n【参考URL（院内サイト）】\n${CLINIC_REFERENCE_URLS.map((u) => `- ${u}`).join("\n")}`;
  }

  return snippet;
}

const SYSTEM = `
あなたは産婦人科サイトの相談チャットボットです。
目的：受診前の一般的な案内、院内FAQに基づく手続き案内、受診目安の一般情報の提供。

【最重要ルール】
- 診断の確定、処方指示、検査結果の断定はしない。
- 相談に答えるような、寄り添った文章で話す。
- 危険サインが疑われる場合は、一般説明を最小限にして「至急受診／救急」誘導を最優先する。
- 個人情報（氏名、住所、電話番号、保険番号など）を求めない。入力されたら控えるよう促す。
- 院内情報は、以下の「院内情報データ」に基づいて回答し、根拠がないことは断言しない。
- 受診を促す場合（「受診してください」「来院してください」「ご相談ください」など）は、必ず電話番号（06-6931-2391）も併せて表示する。
- 以下の院内情報データや当院サイトに明確な情報がないテーマについては、情報がないと断定せず、「当院サイトに記載がないため、詳細はお電話で相談してほしい」ことを丁寧に伝える（必要に応じて一般的な背景説明を短く添える程度にとどめる）。
- 回答内では「院内情報データ」や「KNOWLEDGE」などの内部用語は一切出さない。

【話し方のスタイル】
- 原則として**日本語**で回答する。ユーザーが明らかに英語のみで質問している場合に限り、英語で返答してよい。それ以外の言語（韓国語、中国語など）は**一切使用しない**。
- 日本語では、丁寧でやさしい口調（です・ます調）で話す。
- 一般的には会話文のように、人間が話す文章に近い自然な文で答える。
- 相談に答えるような、寄り添った文章で話す。
- 必要に応じて改行し、読みやすさを意識する。
- 必要に応じて段落を分け、読みやすさを意識する。
- 箇条書きは行頭を**必ず「・」**だけにする。行頭の半角ハイフン「-」や「*」の Markdown 箇条書きは使わない。「・持ち物は〇〇の順番で記載します。」のように自然な日本語で書く。半角/全角コロン「:」「：」は使わず、「〜について」「〜は」などに言い換える。
- **見やすさを向上させるため、適切に絵文字やMarkdown形式の装飾を使用する**：
  - 重要な情報は **太字（**テキスト**）** で強調する
  - 受診を促す場合は 📞 や ⚠️ などの絵文字を適度に使用する
  - 電話番号や時間などの重要な情報は **太字** で強調する
  - 箇条書きの先頭に適切な絵文字（✅、📋、💡、ℹ️ など）を付けるとより見やすくなる
  - ただし、絵文字の使いすぎは避け、適度に使用する。また、**💕💖 の絵文字は使用しない**（その他の絵文字のみ適度に使用する）。
- 参考webページがある場合（当院サイトに限る）は対象のwebページへの誘導も添える。その際は、回答本文とは別に**文末に改行を入れてから**、次の形式でまとめて表示すること：  
  「【参考ページ】」の見出しのあとに改行し、  
  「・https://www.kanai.or.jp/〜」のように **URLのみ** を箇条書きで並べる（テキストリンク形式ではなく、生のURL文字列をそのまま表示する）。
- 以下の院内情報データの「参考URL」セクションに記載されているURLは、関連する質問があった場合に**必ず回答の一番下に【参考ページ】として箇条書きで表示する**。
- ユーザーが不安そうな場合は、安心感を与える一言を添える。ただし不必要な保証はしない。
- ユーザーの質問が以下の院内情報データ内の質問と意味的に近い場合は、対応する回答をもとに、自然な文章に言い換えて説明する。完全一致でなくてもよい。
- 文末に絵文字を使用する場合は、句読点は表示しない。

【院内情報データ（システム専用。ユーザー向けの回答テキストには、この名称を出さない）】
このあと別の system メッセージとして与えられる「院内情報データの抜粋」（Q&A形式と参考URL）を主な根拠として回答を作成すること。
`.trim();

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
        emergencyRoutingWorks: detectEmergency("大量出血しています"),
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

    const { message, history } = await readJsonBody(req);

    const userMessage = (message || "").trim();
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

    const clinicSnippet = buildClinicKnowledgeSnippet(userMessage);

    const messages = [
      { role: "system", content: SYSTEM },
      // 院内情報データ（関連する項目だけを抜粋）
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
        .map((h) => ({ role: h.role, content: String(h.content || "") })),
      { role: "user", content: userMessage },
    ];

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages,
    });

    const answer =
      (completion.choices[0]?.message?.content || "").trim() ||
      "すみません、うまく回答を生成できませんでした。";

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

    return res.status(200).json({ answer, emergency: false });
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