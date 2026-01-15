import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ★ここを固定（許可するフロントURL）
const ALLOWED_ORIGIN = "https://chat.kanai.or.jp";

// 重要：院内情報（まずはMVP要約。必要に応じて増やしてOK）
const CLINIC_KNOWLEDGE = `
【金井産婦人科（院内FAQ要約・抜粋）】
- 当日受診：当日の予約は取らず、直接来院。
- 支払い：クレジットカード利用可。ただし予納金・予約金は現金のみ。
- 駐車場：8台。利用可能時間 8:30〜20:00。20:00以降は翌朝8:30まで閉鎖。出入りは今里筋から。
- 妊娠判定の受診目安：生理予定日から7〜10日遅れたら受診の目安。
- 初診費用の目安：約10,000円目安（初診料＋超音波＋必要なら尿検査）。
- 子宮がん検診：予約なしでも受付時間内なら随時。電話予約の運用あり（番号非通知は不可）。
- 検査結果：当日には出ない。検査により1〜2週間程度必要。
- 乳がん検診：現在行っていない。
- アフターピル：診療時間内に随時対応可能。
`.trim();

const SYSTEM = `
あなたは産婦人科サイトの相談チャットボットです。
目的：受診前の一般的な案内、院内FAQに基づく手続き案内、受診目安の一般情報の提供。

【最重要ルール】
- 診断の確定、処方指示、検査結果の断定はしない。
- 危険サインが疑われる場合は、一般説明を最小限にして「至急受診／救急」誘導を最優先する。
- 個人情報（氏名、住所、電話番号、保険番号など）を求めない。入力されたら控えるよう促す。
- 院内情報は「KNOWLEDGE」を最優先し、根拠がないことは断言しない。
- 回答は日本語、簡潔、箇条書き中心。

【KNOWLEDGE】
${CLINIC_KNOWLEDGE}
`.trim();

function setCors(res, origin) {
  // Origin一致のみ許可
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
  const origin = req.headers.origin;
  setCors(res, origin);

  // Preflight
  if (req.method === "OPTIONS") return res.status(204).end();

  // Origin一致以外は拒否（直叩き対策）
  if (origin !== ALLOWED_ORIGIN) {
    return res.status(403).json({ error: "Forbidden origin" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { message, history } = req.body || {};
    const userMessage = (message || "").trim();
    if (!userMessage) return res.status(400).json({ answer: "メッセージが空です。", emergency: false });

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
  } catch {
    return res.status(500).json({ answer: "サーバ側でエラーが発生しました。", emergency: false });
  }
}