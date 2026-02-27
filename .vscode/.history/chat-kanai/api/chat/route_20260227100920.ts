// app/api/chat/route.ts
import OpenAI from "openai";
import { CLINIC_KNOWLEDGE } from "@/lib/clinic_knowledge";

export const runtime = "nodejs"; // Edgeでも可だが、まずはnode推奨

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type ChatRequest = {
  message: string;
  history?: { role: "user" | "assistant"; content: string }[];
};

function detectEmergency(text: string) {
  // 産婦人科の「危険サイン」ざっくり検知（最小MVP）
  const t = text.toLowerCase();

  const keywords = [
    "大量出血",
    "血が止まら",
    "レバー状",
    "強い腹痛",
    "激しい腹痛",
    "意識",
    "もうろう",
    "けいれん",
    "呼吸が苦しい",
    "胸が痛い",
    "高熱",
    "39",
    "破水",
    "胎動が",
    "胎動ない",
    "胎動が少ない",
    "失神",
    "耐えられない痛み",
  ];

  return keywords.some((k) => t.includes(k.toLowerCase()));
}

function emergencyMessage() {
  return [
    "緊急性が高い可能性があります。",
    "次のいずれかに当てはまる場合は、**すぐに医療機関へ連絡・受診**してください：",
    "- 大量の出血、強い腹痛、意識がもうろう／けいれん、高熱、破水が疑われる、胎動が明らかに少ない など",
    "",
    "今すぐ対応が必要と感じる場合は **119** も検討してください。",
    "",
    "（個人情報は入力せず）差し支えなければ「妊娠中かどうか／妊娠週数の目安」「出血や痛みの程度」「発熱の有無」だけ教えてください。",
  ].join("\n");
}

const SYSTEM_PROMPT = `
あなたは産婦人科サイトの相談チャットボットです。
目的：受診前の一般的な案内、院内FAQに基づく手続き案内、受診目安の一般情報の提供。

【最重要ルール】
- 診断の確定、処方指示、検査結果の断定はしない。
- 危険サインが疑われる場合は、一般説明を最小限にして「至急受診／救急」誘導を最優先する。
- 個人情報（氏名、住所、電話番号、保険番号、具体的な連絡先など）を求めない。入力されたら控えるよう促す。
- 院内情報（予約方法、費用、駐車場、検査対応など）は「提供された院内FAQ（KNOWLEDGE）」を最優先し、根拠がないことは断言しない。
- 回答は日本語で簡潔に。箇条書きを多用。最後に必要なら受診先案内を添える。

【KNOWLEDGE】
${CLINIC_KNOWLEDGE}
`.trim();

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ChatRequest;

    const userMessage = (body.message || "").trim();
    if (!userMessage) {
      return Response.json({ answer: "メッセージが空です。", emergency: false }, { status: 400 });
    }

    // 1) 危険サイン判定（MVP）
    const emergency = detectEmergency(userMessage);
    if (emergency) {
      return Response.json({ answer: emergencyMessage(), emergency: true });
    }

    // 2) OpenAI Responses API 呼び出し（推奨）
    // ドキュメント：Responses API create  [oai_citation:3‡OpenAI Platform](https://platform.openai.com/docs/api-reference/responses/create?lang=node.js&utm_source=chatgpt.com)
    const history = (body.history || []).slice(-8); // 長くなりすぎ防止

    const input = [
      { role: "system" as const, content: SYSTEM_PROMPT },
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user" as const, content: userMessage },
    ];

    const resp = await client.responses.create({
      model: "gpt-4.1-mini",
      input,
    });

    const answer =
      resp.output_text?.trim() ||
      "すみません、うまく回答を生成できませんでした。少し内容を変えてもう一度お試しください。";

    return Response.json({ answer, emergency: false });
  } catch (e: any) {
    console.error(e);
    return Response.json(
      { answer: "サーバ側でエラーが発生しました。時間をおいてお試しください。", emergency: false },
      { status: 500 }
    );
  }
}