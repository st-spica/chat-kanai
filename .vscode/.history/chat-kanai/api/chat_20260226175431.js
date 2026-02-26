import OpenAI from "openai";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 許可するフロントエンドのOrigin（今回は Xserver 上のページのみ許可）
const ALLOWED_ORIGINS = [
  "https://spica8217.xsrv.jp",
];

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
    
    // 質問と回答のペアを明確に提示する形式で整形
    const formattedItems = faqItems.map(item => {
      let text = `Q: ${item.question}\nA: ${item.answer}`;
      if (item.category) {
        text = `[${item.category}] ${text}`;
      }
      return text;
    });
    
    return `【金井産婦人科（院内FAQ要約・抜粋）】\n\n${formattedItems.join("\n\n")}`;
  } catch (error) {
    // フォールバック：デフォルト値
    console.error("CSVファイルの読み込みに失敗しました:", error.message);
    return `【金井産婦人科（院内FAQ要約・抜粋）】\n- 情報の読み込みに失敗しました。`;
  }
}

// 起動時に1回だけ読み込む（処理を軽くするため）
const CLINIC_KNOWLEDGE = loadClinicKnowledge();

const SYSTEM = `
あなたは産婦人科サイトの相談チャットボットです。
目的：受診前の一般的な案内、院内FAQに基づく手続き案内、受診目安の一般情報の提供。

【最重要ルール】
- 診断の確定、処方指示、検査結果の断定はしない。
- 危険サインが疑われる場合は、一般説明を最小限にして「至急受診／救急」誘導を最優先する。
- 個人情報（氏名、住所、電話番号、保険番号など）を求めない。入力されたら控えるよう促す。
- 院内情報は「KNOWLEDGE」を最優先し、根拠がないことは断言しない。
- 回答は日本語、簡潔、箇条書き中心。
- ユーザーの質問が「KNOWLEDGE」内の質問と意味的に近い場合は、対応する回答を参照して回答してください。完全一致でなくても、意味が近ければ適切な回答を提供できます。

【KNOWLEDGE】
${CLINIC_KNOWLEDGE}
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

function detectEmergency(text) {
  const t = (text || "").toLowerCase();
  const keywords = [
    "大量出血", "血が止まら", "レバー状",
    "強い腹痛", "激しい腹痛",
    "意識", "もうろう", "けいれん",
    "呼吸が苦しい", "胸が痛い",
    "高熱", "39", "破水",
    "胎動が少ない", "胎動ない", "胎動減少",
    "失神", "耐えられない痛み"
  ];
  return keywords.some(k => t.includes(k.toLowerCase()));
}

function emergencyMessage() {
  return [
    "緊急性が高い可能性があります。",
    "次のような場合は、**すぐに医療機関へ連絡・受診**してください：",
    "- 大量の出血、強い腹痛、意識がもうろう／けいれん、高熱、破水が疑われる、胎動が明らかに少ない など",
    "",
    "今すぐ対応が必要と感じる場合は **119** も検討してください。",
    "",
    "（個人情報は入力せず）差し支えなければ「妊娠中かどうか／妊娠週数の目安」「出血や痛みの程度」「発熱の有無」だけ教えてください。"
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

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // 許可していないOriginからのアクセスは拒否
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
      return res.status(403).json({ error: "Forbidden origin" });
    }

    const { message, history } = req.body || {};
    const userMessage = (message || "").trim();
    if (!userMessage) {
      return res.status(400).json({ answer: "メッセージが空です。", emergency: false });
    }

    // 危険サインはモデルに投げずに即時誘導（安全のため）
    if (detectEmergency(userMessage)) {
      return res.status(200).json({ answer: emergencyMessage(), emergency: true });
    }

    const safeHistory = Array.isArray(history) ? history.slice(-8) : [];

    const input = [
      { role: "system", content: SYSTEM },
      ...safeHistory.map(h => ({ role: h.role, content: String(h.content || "") })),
      { role: "user", content: userMessage }
    ];

    const resp = await client.responses.create({
      model: "gpt-4.1-mini",
      input
    });

    const answer = (resp.output_text || "").trim() || "すみません、うまく回答を生成できませんでした。";
    return res.status(200).json({ answer, emergency: false });
  } catch (e) {
    console.error("chat handler error:", e);
    return res.status(500).json({ answer: "サーバ側でエラーが発生しました。", emergency: false });
  }
}