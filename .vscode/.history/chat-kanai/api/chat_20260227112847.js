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
    const formattedItems = [];
    const referenceUrls = [];
    
    faqItems.forEach(item => {
      // 回答がURLのみの場合（参考URLとして扱う）
      if (item.answer && (item.answer.startsWith("http://") || item.answer.startsWith("https://"))) {
        referenceUrls.push(`${item.question}: ${item.answer}`);
      } else {
        // 通常のQ&A形式
        let text = `Q: ${item.question}\nA: ${item.answer}`;
        // カテゴリが空の場合はカテゴリ表示をスキップ（基本情報など）
        if (item.category && item.category.trim() !== "") {
          text = `[${item.category}] ${text}`;
        }
        formattedItems.push(text);
      }
    });
    
    let knowledgeText = `【金井産婦人科（院内FAQ要約・抜粋）】\n\n${formattedItems.join("\n\n")}`;
    
    // 参考URLがある場合は追加
    if (referenceUrls.length > 0) {
      knowledgeText += `\n\n【参考URL】\n${referenceUrls.map(url => `- ${url}`).join("\n")}`;
    }
    
    return knowledgeText;
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
- 院内情報は、以下の「院内情報データ」に基づいて回答し、根拠がないことは断言しない。
- 受診を促す場合（「受診してください」「来院してください」「ご相談ください」など）は、必ず電話番号（06-6931-2391）も併せて表示する。
- 以下の院内情報データや当院サイトに明確な情報がないテーマについては、情報がないと断定せず、「当院サイトに記載がないため、詳細はお電話で相談してほしい」ことを丁寧に伝える（必要に応じて一般的な背景説明を短く添える程度にとどめる）。
- 回答内では「院内情報データ」や「KNOWLEDGE」などの内部用語は一切出さない。

【話し方のスタイル】
- 日本語で、丁寧でやさしい口調（です・ます調）で話す。
- 一般的には会話文のように、人間が話す文章に近い自然な文で答える。
- 相談に答えるような、寄り添った文章で話す。
- 必要に応じて改行し、読みやすさを意識する。
- 必要に応じて段落を分け、読みやすさを意識する。
- 箇条書きは、注意点や選択肢を整理するときにだけ使い、それ以外は文章中心で説明する。
- **見やすさを向上させるため、適切に絵文字やMarkdown形式の装飾を使用する**：
  - 重要な情報は **太字（**テキスト**）** で強調する
  - 受診を促す場合は 📞 や ⚠️ などの絵文字を適度に使用する
  - 電話番号や時間などの重要な情報は **太字** で強調する
  - 箇条書きの先頭に適切な絵文字（✅、📋、💡、ℹ️ など）を付けるとより見やすくなる
  - ただし、絵文字の使いすぎは避け、適度に使用する
- 参考webページがある場合（当院サイトに限る）は対象のwebページへの誘導も添える。
- 以下の院内情報データの「参考URL」セクションに記載されているURLは、関連する質問があった場合に回答の最後に箇条書きで表示する。
- ユーザーが不安そうな場合は、安心感を与える一言を添える。ただし不必要な保証はしない。
- ユーザーの質問が以下の院内情報データ内の質問と意味的に近い場合は、対応する回答をもとに、自然な文章に言い換えて説明する。完全一致でなくてもよい。

【院内情報データ（システム専用。ユーザー向けの回答テキストには、この名称を出さない）】
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
    "⚠️ 現在の症状からは、**緊急性が高い可能性があります。**",
    "",
    "次のような状態に当てはまる場合は、**すぐに医療機関へ電話で相談し、受診をご検討ください。**",
    "・大量の出血がある、血が止まりにくい",
    "・我慢できないほどの強い腹痛や胸の痛みがある",
    "・意識がもうろうとしている、けいれんがある",
    "・高い熱が続いている（39℃前後など）",
    "・破水が疑われる、胎動が明らかに少ない  など",
    "",
    "当院へのご相談は **06-6931-2391**（番号非通知は不可） までお電話ください。",
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