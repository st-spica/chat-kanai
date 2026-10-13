/**
 * ローカル再現テスト（本番 Vercel / OpenAI 呼び出しなし）
 * - 履歴による公式サイト検索の誤発火
 * - 10ターン連続質問の経路分類
 * - 履歴サイズの上限
 * - OpenAI エラー分類
 */
import {
  shouldLoadSiteKnowledgeForMessage,
  messageTriggersSiteKnowledge,
  sanitizeHistory,
  classifyOpenAIError,
  PATIENT_TEMP_ERROR_ANSWER,
} from "../api/chat.js";
import { APIConnectionError, APIError } from "openai";

const QUESTIONS = [
  "妊娠中にコーヒーを飲んでしまいました",
  "食べずわりにおすすめの食べ物は？",
  "妊娠線はどうしたら防げますか？",
  "出産後は何kgくらい体重が減りますか？",
  "産後ケアについて教えてください",
  "面会時間を教えてください",
  "妊娠中に風邪をひいたら何科に行けばいい？",
  "金井産婦人科の診療時間を教えてください",
  "つわりで仕事を休む書類はもらえますか？",
  "妊娠中のむくみ対策を教えてください",
];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function approxRequestBytes(history, message) {
  const safe = sanitizeHistory(history);
  const body = JSON.stringify({
    message,
    history: safe,
    stream: true,
    clientId: "testclient0123456789",
  });
  return { historyCount: safe.length, bytes: Buffer.byteLength(body, "utf8") };
}

console.log("=== 1) 履歴汚染によるサイト検索誤発火の修正確認 ===");
{
  const polluted = [
    { role: "user", content: "金井産婦人科の診療時間を教えてください" },
    { role: "assistant", content: "診療時間のご案内です。" },
    { role: "user", content: "面会時間を教えてください" },
    { role: "assistant", content: "面会のご案内です。" },
  ];
  // 一般健康相談は現メッセージ基準 → サイト検索しない
  assert(
    !shouldLoadSiteKnowledgeForMessage("妊娠中のむくみ対策を教えてください", polluted),
    "一般相談が履歴の院内語でサイト検索されてはいけない"
  );
  // 院内事実は現メッセージで発火
  assert(
    shouldLoadSiteKnowledgeForMessage("金井産婦人科の診療時間を教えてください", polluted),
    "診療時間はサイト検索対象"
  );
  assert(
    shouldLoadSiteKnowledgeForMessage("面会時間を教えてください", []),
    "面会はサイト検索対象"
  );
  // 短い追質問は直前ユーザーのみ参照
  assert(
    shouldLoadSiteKnowledgeForMessage("何時まで？", [
      { role: "user", content: "面会時間を教えてください" },
      { role: "assistant", content: "面会は…" },
    ]),
    "短い追質問は直前の院内話題を引き継ぐ"
  );
  assert(
    !shouldLoadSiteKnowledgeForMessage("何時まで？", [
      { role: "user", content: "妊娠中のむくみ対策を教えてください" },
      { role: "assistant", content: "むくみは…" },
    ]),
    "直前が一般相談なら短い追質問でもサイト検索しない"
  );
  console.log("OK");
}

console.log("=== 2) 10ターン連続: 経路フラグとリクエストサイズ ===");
{
  /** @type {Array<{role:string,content:string}>} */
  const history = [];
  const rows = [];
  for (let i = 0; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i];
    const site = shouldLoadSiteKnowledgeForMessage(q, history);
    const size = approxRequestBytes(history, q);
    rows.push({
      turn: i + 1,
      siteSearchLikely: site,
      historyCount: size.historyCount,
      requestBytes: size.bytes,
      qPreview: q.slice(0, 24),
    });
    // 履歴は会話が進んだ体で蓄積（回答はダミー短文）
    history.push({ role: "user", content: q });
    history.push({
      role: "assistant",
      content: "テスト回答です。".repeat(20),
    });
  }
  console.table(rows);

  // 履歴上限: 10件（user+assistantで最大10）
  const capped = sanitizeHistory(history);
  assert(capped.length <= 10, `履歴は最大10件であるべき: got ${capped.length}`);
  assert(
    capped.every((h) => String(h.content).length <= 500),
    "1件あたり500文字制限"
  );

  // ターンが増えてもリクエストが極端に肥大化しない（概ね 8KB 未満）
  const last = rows[rows.length - 1];
  assert(
    last.requestBytes < 12000,
    `10ターン目のリクエストが大きすぎる: ${last.requestBytes}`
  );
  console.log("OK historyCap=", capped.length, "lastBytes=", last.requestBytes);
}

console.log("=== 3) OpenAI エラー分類 ===");
{
  const conn = classifyOpenAIError(
    new APIConnectionError({ message: "connection failed" })
  );
  assert(conn.errorCode === "openai_connection" && conn.retryable, "connection");
  assert(conn.patientAnswer === PATIENT_TEMP_ERROR_ANSWER, "patient safe");

  const rate = classifyOpenAIError(
    Object.assign(new APIError(429, undefined, "rate", undefined), {
      status: 429,
    })
  );
  assert(rate.errorCode === "openai_rate_limit" && rate.retryable, "429");

  const auth = classifyOpenAIError({ status: 401, message: "Incorrect API key" });
  assert(auth.errorCode === "openai_auth" && !auth.retryable, "401");

  const s5 = classifyOpenAIError({ status: 503, message: "unavailable" });
  assert(s5.errorCode === "openai_upstream_5xx" && s5.retryable, "5xx");

  console.log("OK");
}

console.log("=== 4) messageTriggers サンプル ===");
{
  for (const q of QUESTIONS) {
    console.log(
      `- ${messageTriggersSiteKnowledge(q) ? "SITE" : "----"} | ${q}`
    );
  }
}

console.log("\nALL LOCAL CHECKS PASSED");
console.log(
  "NOTE: 本番の OpenAI/Vercel ストリーム挙動はデプロイ後に Vercel ログの [chat-error]/[chat-timing] で確認してください。"
);
