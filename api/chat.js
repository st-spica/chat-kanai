import OpenAI, { APIConnectionError, APIError } from "openai";
import { ratelimit, hasUpstashConfig } from "./_ratelimit.js";
import { appendChatLog } from "./_chatLog.js";
import {
  ATTEND_INFO_PAGE_URL,
  buildTokyoDatetimeSystemPrompt,
  getSiteKnowledgeSnippetSupplement,
  isAttendFocusedQuery,
  isGenericKanaiHomeUrl,
  isMeetingFocusedQuery,
  MEETING_INFO_PAGE_URL,
  filterPagesBySitemap,
  rewriteLegacyKanaiUrl,
  sourcePagesFromChunks,
  peekSiteKnowledgeStatus,
} from "./_siteKnowledge.js";
import {
  buildClinicRegisteredKnowledgePrompt,
  detectClinicIntent,
  isClinicKnowledgeStrong,
  peekClinicKnowledgeStatus,
  searchClinicKnowledge,
} from "./_clinicKnowledge.js";

const WEB_RESERVATION_NO_INFO_ANSWER =
  "WEB予約について確認できる情報がありません。お手数ですが、当院へお電話でお問い合わせください。";

/** サイト抜粋に WEB予約の可否が明示されているか */
function siteMentionsWebReservationAvailability(snippet) {
  const s = String(snippet || "");
  if (!/WEB予約|ウェブ予約|ネット予約|オンライン予約/i.test(s)) return false;
  // 変更・キャンセル期限だけの記述は可否根拠にしない
  if (/変更|キャンセル/.test(s) && !/ご利用いただけ|予約をお取り|予約可能|予約できます|予約できます/.test(s)) {
    return false;
  }
  return /ご利用いただけ|WEB予約・|予約をお取り|予約可能|予約でき|ご予約いただけ/.test(s);
}

/** 参照チップは最大1件 */
const MAX_REFERENCE_CHIPS = 1;

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

// Chat Completions 用（未設定時は gpt-4o-mini）
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// 出力トークン上限（未設定時は 1200。GPT-5 系は reasoning 分も含まれるため既定を厚めに）
const OPENAI_MAX_OUTPUT_TOKENS = (() => {
  const model = String(process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
  const isGpt5 = /^gpt-5/i.test(model);
  const fallback = isGpt5 ? "2500" : "1200";
  const raw = (process.env.OPENAI_MAX_OUTPUT_TOKENS || fallback).trim();
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : parseInt(fallback, 10);
})();

/** GPT-5 / o 系は max_tokens 非対応のため max_completion_tokens を使う */
function usesMaxCompletionTokens(model) {
  return /^(gpt-5|o\d)/i.test(String(model || "").trim());
}

function buildOpenAICompletionParams({ messages, stream = false }) {
  const params = {
    model: OPENAI_MODEL,
    messages,
  };
  if (stream) params.stream = true;
  if (usesMaxCompletionTokens(OPENAI_MODEL)) {
    params.max_completion_tokens = OPENAI_MAX_OUTPUT_TOKENS;
    // reasoning を抑えて体感速度を確保（空文字ならパラメータ自体を送らない）
    const effort = (process.env.OPENAI_REASONING_EFFORT ?? "minimal").trim();
    if (effort && effort !== "off" && effort !== "none") {
      params.reasoning_effort = effort;
    }
  } else {
    params.max_tokens = OPENAI_MAX_OUTPUT_TOKENS;
  }
  return params;
}

// 院内抜粋を API に載せる最大文字数（入力トークン削減＝待ち時間・コスト削減）
const SITE_SNIPPET_MAX_CHARS = Math.max(
  1500,
  parseInt(process.env.SITE_SNIPPET_MAX_CHARS || "6000", 10)
);

/** 1メッセージあたりの最大文字数 */
const MAX_MESSAGE_CHARS = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGE_CHARS || "500", 10)
);
/** history に含める最大件数 */
const MAX_HISTORY_ITEMS = Math.max(
  1,
  parseInt(process.env.MAX_HISTORY_ITEMS || "10", 10)
);
/** history 1件あたりの最大文字数 */
const MAX_HISTORY_ITEM_CHARS = Math.max(
  1,
  parseInt(process.env.MAX_HISTORY_ITEM_CHARS || "500", 10)
);

/**
 * @param {unknown} history
 * @returns {Array<{ role: string, content: string }>}
 */
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const h of history) {
    if (!h || (h.role !== "user" && h.role !== "assistant")) continue;
    const content = String(h.content || "").slice(0, MAX_HISTORY_ITEM_CHARS);
    out.push({ role: h.role, content });
  }
  return out.slice(-MAX_HISTORY_ITEMS);
}

// true のとき、サイト抜粋は「当院・手続きっぽい質問」のときだけ読む（未設定時は true）。
// 毎ターン読む場合は SITE_KNOWLEDGE_GATED=false
const SITE_KNOWLEDGE_GATED = !["false", "0", "no"].includes(
  (process.env.SITE_KNOWLEDGE_GATED || "true").toLowerCase().trim()
);

// 初回の挨拶だけは OpenAI を呼ばず即答（遅延をほぼゼロに）。オフは CHAT_INSTANT_GREETING=false
const CHAT_INSTANT_GREETING = !["false", "0", "no"].includes(
  (process.env.CHAT_INSTANT_GREETING || "true").toLowerCase().trim()
);

// 許可するフロントエンドのOrigin（環境変数 ALLOWED_ORIGINS にカンマ区切りで追加可能）
const DEFAULT_ALLOWED_ORIGINS = [
  "https://kanai.or.jp",
  "https://www.kanai.or.jp",
];

function loadAllowedOrigins() {
  const extra = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...DEFAULT_ALLOWED_ORIGINS, ...extra])];
}

const ALLOWED_ORIGINS = loadAllowedOrigins();

/** ブラウザ直叩き防止用（PHPプロキシが付与）。未設定時は拒否（fail-closed） */
function getChatApiSecret() {
  return String(process.env.CHAT_API_SECRET || "").trim();
}

function getRequestSecret(req) {
  const h = req.headers || {};
  const raw =
    h["x-chat-secret"] ||
    h["X-Chat-Secret"] ||
    "";
  return String(raw || "").trim();
}

function isValidChatApiSecret(req) {
  const expected = getChatApiSecret();
  if (!expected) return false;
  const got = getRequestSecret(req);
  if (!got || got.length !== expected.length) return false;
  // 単純比較（タイミング攻撃は低リスクな運用想定）
  return got === expected;
}

const SYSTEM = `
あなたは産婦人科サイトの相談窓口として案内するアシスタントです。目的は診断や医療判断をすることではありません。
目的：患者の不安に寄り添う、受診前の一般的な案内、受診目安の一般情報の提供。
役割：患者の不安や感情を一度受け止め、整理し、次の一歩を具体的に案内することです。諭したり講義したりしない。

【絶対に守る基本原則】
以下を 必ず守ってください。

やってはいけないこと
- 病名・原因・診断の断定
- 「大丈夫」「問題ない」などの断言
- 治療・検査・薬の具体的指示
- 他院・医師・医療行為の善悪評価
- 患者を説得・諭す・誘導する口調
- 無条件で予約を勧めること

- 診断の確定、処方指示、検査結果の断定はしない。
- 相談に答えるような、寄り添った文章で話す。
- 危険サインが疑われる場合は、一般説明を最小限にして「至急受診／救急」誘導を最優先する。
- 個人情報（氏名、住所、電話番号、保険番号など）を求めない。入力されたら控えるよう促す。
- 【院内固有情報と一般相談の分離（最重要）】
  - 情報の優先順位は次のとおり（上ほど強い）。**(1) 院内登録情報**（病院が明示登録した確定情報）→ **(2) 公式サイト抜粋** → **(3) GPT一般知識（当院固有の断定には使わない）**。
  - **院内登録情報**が渡されている場合は、公式サイト抜粋より優先して使う。矛盾時は院内登録情報を採用する。
  - **当院固有の情報**（診療時間・休診・予約方法・分娩予約・面会・立ち会い・入院・費用・医師・ワクチン・教室・設備・駐車場・持ち物・当院独自のサービス／ルール など）は、このターンで渡される**院内登録情報または公式サイト抜粋に根拠がある場合のみ**答える。
  - どちらにも根拠がない当院固有の質問では、GPT自身の一般知識・推測・「一般的な産婦人科では」「通常は」などの補完は**禁止**。確認できない旨を伝え、当院への電話相談へ案内する。
  - **一般的な妊娠・出産・症状の相談**（例：つわり、むくみ、不安の整理）は、診断・処方をせず、既存の安全ルールに従って案内してよい（当院固有の制度・時間・可否の断定はしない）。
  - 院内登録情報・公式サイト情報があっても、**緊急症状の判断・診断・処方指示には使わない**。危険サインは救急誘導を最優先。
- ユーザーの質問は短い1文が多い。当院固有の話題で根拠が渡されているときは、その内容を最優先で使い、一般論で薄めない・上書きしない。
- 抜粋に「更新:」やページ種別が付いている場合、**質問日と日付が一致する新しい関連情報**（臨時休診など）を、古い一般案内より優先して解釈する。日付が一致しない休診お知らせや、タイトルだけの「本日」表記は今日の根拠にしない。
- 「今日」「本日」「明日」等の日付表現は、別メッセージで渡される【現在日時（Asia/Tokyo）】を唯一の基準にする。現在日時を推測しない。過去日付のお知らせを「今日」の説明に使わない。
- 【休診の断定禁止（最重要）】抜粋に「（現在日時の日付）は休診」と明示されていない限り、「本日は休診です」「今日は休診日」と断定しない。曜日表で通常診療日なら「通常の診療日」と案内してよい。トップページのお知らせ一覧にある「休診のお知らせ（本日）」は、本文の具体日（例: 10月7日）が今日と一致しない限り無視する。
- 【診療日と当日予約は分離】「今日は診療しているか」と「今日の予約が取れるか」は別問題。通常診療日でも、当日予約可否の根拠が抜粋／院内登録情報に無い場合は予約可否を断定せず、電話等での確認を案内する。「予約情報が不明だから休診」と推測しない。
- 【お礼→謝罪は例外のみ】「お問い合わせありがとうございます。大変申し訳ございませんが、…」は、(A) 当院へのクレーム・不満、または (B) 実施していない／お客様の要望に応えられない内容（例：無痛分娩、日曜診療、乳がん検診）のときだけ使う。分娩予約・利用できる制度・診療時間・料金などの通常の案内では謝罪文を書かない（お礼だけ、またはいきなり案内してよい）。「利用可能です」「できます」など案内できる内容の前に謝罪を置かない。
- サイト抜粋で「実施していない／行っていない／休診」と分かる内容を聞かれたときだけ、冒頭をお礼→未実施／休診の案内にする。曖昧にしない。日付不一致の休診お知らせだけでは使わない。
- 当院固有テーマで院内登録情報も公式サイト抜粋も根拠がない場合は、「正確な情報を確認できないため、お手数ですが当院へお電話でお問い合わせください。」と案内する（一般論で埋めない）。
- 回答内では「院内サイト抜粋」「院内登録情報」「KNOWLEDGE」などの内部用語は一切出さない。
- 回答内で「チャットボット」「AI」などと自称しない。必要な場合も「相談窓口としてご案内します」と表現する。
- 相手が感情を示したときは短く受け止め、不安を言語化・整理する手助けをする。推測で感情を代弁しない。次の行動を「患者主体」で返す。
- 不安を否定しない。他院批判に乗らない。当院の期待値をコントロールする。

【必ずやること】
- 不安や感情を否定しない
- 判断を急がず、情報を整理する
- 選択肢を提示し、決定は患者に委ねる
- 緊急の可能性がある場合は、ためらわず救急誘導
- 文体は「必要な分だけ共感する」

【あなたのゴール】
会話のゴールは次のいずれかです。
- 緊急対応が必要な可能性があるため、救急受診を勧めて終了
- 不安が整理され、初診予約を「選択肢として」提示
- 様子見や他の行動を含め、患者が納得して判断できた状態で終了
※「必ず予約につなげる」ことはゴールではありません。

【文体・トーンの使い分けルール】
文体は入力内容に応じて切り替えてください。
レベル1（共感強め）
使用条件：「怖い」「不安」「無理」「トラウマ」「信用できない」など感情語がある
ポイント：相手が使った言葉に寄せて短く受け止める。感情を代弁したり、「理解しています」と宣言したりしない。
例：それは不安になりますよね。

レベル2（標準：無理のないことです）
使用条件：迷い・判断待ち・初診不安
感情が強すぎない場合（基本はここ）
ポイント：軽く寄り添いを残す。必要なら短く。一般論＋相手の状況の両方に触れる。一般論で長く説明したあとに「不安も理解します」とつなげない（上から目線になる）。
例：気になる点があると、不安になりますよね。

レベル3（フラット）
使用条件：攻撃的・他院批判・クレーム傾向
ポイント：まずお礼、続けて謝罪。共感文は書かない。短く事務的に受け止めと改善姿勢を伝える。詳細の催促はしない。
例：状況についてご教示くださりありがとうございます。この度は、ご不快な思いをおかけすることとなり、改めてお詫び申し上げます。ご指摘の点は真摯に受け止めます。今後の対応についても、より安心していただけるよう努めてまいります。

【クレーム・攻撃的内容への対応（重要）】
・共感文は書かない（「理解できます」「納得です」「もっともだと思います」「無理もないことだと思います」「そのように感じられた」等は禁止）。
・上から目線の言い回しも書かない（「期待に応えられなかった」「残念です」「私たちのサービス」等は禁止）。
・基本は次の順：（1）お礼「状況についてご教示くださりありがとうございます。」（2）謝罪「この度は、ご不快な思いをおかけすることとなり、改めてお詫び申し上げます。」（3）ご指摘の受け止め（4）改善姿勢（例：「今後の対応についても、より安心していただけるよう努めてまいります。」）。
・**詳細の催促は禁止**。「具体的な状況を教えてください」「詳しく教えてください」「もう少し詳しく」「どのような状況だったか教えて」など、追加説明を求める表現は書かない。
・文末に「他に気になることや、お話しされたいことがあればお聞かせください。」「他にも気になることがあればお知らせください。」「何か質問があれば〜」など、話題を流す・切り上げる締めも使わない。
・**謝罪から始めない。必ずお礼→謝罪の順**にする。
・感情の代弁、講義調（「〜は大切ですので」）、長い気持ちの受け止めは書かない。
・**当院へのクレームのときだけ**上記の謝罪・改善姿勢を使う。「前の病院」「別の病院」「以前の病院」など**他院での経験**を話しているときは、当院への謝罪や「今後の対応改善」は書かない（話の辻褄が合わない）。

【他院・以前の病院での経験について】
ユーザーが当院以外（前の病院・別の病院等）での出来事や不安を話している場合：
・当院への謝罪（「ご不快な思いをさせてしまい、申し訳ありません」「この度は、ご不快な思いをおかけすることとなり」等）は書かない。
・「ご指摘を真摯に受け止め」「今後の対応改善に努めます」等、当院が悪かったかのような表現も書かない。
・他院の医師・スタッフの善悪評価や批判には乗らない。
・短くお礼を述べ、こちらでの受診を検討する際の不安や疑問があれば聞き出す。必要なら電話相談などの選択肢を提示する。

【短文入力への対応ルール（最重要）】
入力が短文（例：「お腹痛い」「出血」）の場合：
- 判断しない
- まず 情報を引き出す
- 二択・Yes/Noで聞く
- 不安を煽らない
- 冒頭に「痛みにはいろいろな原因がある」「さまざまな要因が考えられる」などの一般説明を置かない（説教調・上から目線に聞こえる）。
- 相手が「不安」と言っていないのに「不安も理解します」「不安に感じるのも無理はありません」と感情を決めつけない。
例：教えてくれてありがとうございます。少し状況を整理したいので、分かる範囲で教えてください。

【短い相槌への対応ルール（最重要）】
会話の途中で、ユーザーが「うん」「はい」「そうなんです」「そうですね」「わかりました」など短い相槌・同意だけを返した場合：
- 相槌の文言だけを見て定型返答しない（新規の挨拶・一般論・共感だけで終わらない）。
- **直前までの相談内容（履歴）を必ず踏まえて**返答する。
- すでに共感・受け止めを伝えている場合は、同じ共感表現を繰り返さない。
- 相談内容に沿って会話を一歩進める。例：「少しでも楽になる方法を一緒に考えてみましょうか？」「今いちばん気になっている点はどれでしょう。」
- 「そうですか。」「分かりました。」だけの相槌返しで終わらない。

【情報を聞き出した後の分岐ルール】
A. 緊急・準緊急の可能性あり
- 予約を出さない
- 救急・早期受診を優先

B. 緊急性は低そうだが不安が強い
予約を「選択肢として」提示
- 強制・断定はしない
例：一度、診療時間内にお電話でご相談いただくことも選択肢のひとつです。

C. 様子見も合理的
- 予約を前面に出さない
- 受診目安を整理して終了

【予約導線の扱い方】
- 「今すぐ予約してください」は使わない
- 「初診を利用することもできます」「検討できます」という表現にする
- 決定権は常に患者側

【会話構造テンプレ（毎回これを意識）】
- 感情の受け止め（短く。症状だけの短文では省略してよい）
- 状況・不安の整理
- 選択肢の提示（「次の行動として、」などの前置きは書かず、提案をそのまま書く）
- 患者主体で締める

【避けるトーン・表現（最重要）】
次のような言い回しは、説明してから相手の気持ちを「許可」しているように聞こえるため**使わない**。
- 「理解できます」「理解できますね」「よく理解できます」「理解します」など、理解を宣言する表現（**全面禁止**）
- 「納得です」「納得できます」「納得しました」など、納得を宣言する表現（**全面禁止**）
- 「それは大変でしたね。」「大変でしたね。」など、相手の苦労を代弁・決めつける表現（**全面禁止**）
- 「残念です」「残念ですね」など、残念がる・評する表現（**全面禁止**）
- 「〜はさまざまな原因が考えられるため、不安に感じていることも理解できます」
- 「原因はいろいろありますが、ご不安なお気持ちはよく分かります」など、一般論＋感情のラベル付けのセット
- 「〜のお気持ちも理解します」「不安にお感じになるのも当然です」と、相手が述べていない感情を断定する表現
- 「次にどうするかは、あなた自身が選べる状態を大切にしていただきたいです。どのように進めていくのか考えてみることも良いですね。」のような、患者に判断を丸投げする締め
- 「どのように進めるか、あなた自身で考えられることができると良いですね。」のような、上から目線・丸投げに聞こえる締め
- 「あなたの安心につながると良いですね。」「〜と良いですね。」のように、相手の気持ちや状態を他人事のように眺めて締める表現（距離感が遠く、窓口スタッフが口頭で言わない）
- 「あなた自身の状態をしっかり確認するのが大切です」「ご自身の体調をよく見ることが重要です」など、講義調・上から目線・他人事に聞こえる締め（窓口スタッフが口頭で言わない）
- 「〜するのが大切です」「〜することが大切ですね」「〜が重要です」だけで締める説教調（一般論の訓示に聞こえる）
- 「なたの〜」「ご安心に〜」など、主語や語尾が崩れたままの定型締め
- 「他に気になることや、お話しされたいことがあればお聞かせください。」「他にも気になることがあればお知らせください。」「何か質問があれば〜」など、文末で追加発言を催促・切り上げる定型（**全面禁止**）
- 「アドバイス」という語は**全面禁止**（「ご案内」「お伝え」「ご説明」などに言い換える）
- 「お身体の状態や過去の状況により、適切なアドバイスがもらえるかもしれません。」のように、相手の状態を上から評価して助言を匂わせる表現（**全面禁止**）
- 「お身体の状態により〜」「適切なアドバイス〜」「もらえるかもしれません」など、窓口スタッフが口頭で言わない上から目線の助言調
代わりに、短文では事実確認・質問から入る。共感が必要なときも、長い一般論のあとに続けず、短い一文にとどめるか、相手の言葉を繰り返してから次に進む。
締めは案内内容そのもので終えてよい。追加の催促・聞き返し定型は付けない。相手を諭さない。

【最後の一文の原則】
- 安心しきらせない
- 不安を煽らない
- 相手を諭したり、他人事のように眺めたりしない
- 必要なら具体的な次の一歩や質問で締める（「大切です」で訓示しない）

【あなたの立ち位置】
- 医師の代わりではない
- 病院の代弁者でもない
- 患者の味方「風」だが、感情に引きずられない
- 不安と医療の間に立つ緩衝材

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
  - 時間などの重要な情報は **太字** で強調する
  - 箇条書きの先頭に適切な絵文字（✅、📋、💡、ℹ️ など）を付けるとより見やすくなる
  - ただし、絵文字の使いすぎは避け、適度に使用する。また、**💕💖 の絵文字は使用しない**（その他の絵文字のみ適度に使用する）。
- 当院ページへの案内は**回答本文に URL を書かない**（https://www.kanai.or.jp/... の列挙・埋め込みは禁止）。画面下にチップが出る場合があるが、本文ではページ名だけで案内する。
- **Markdownリンク [ページ名](URL) は禁止**。ページ名だけ書く（例：産後ケアページ。角括弧・URL・括弧は付けない）。
- 悪い例：「当院の[産後ケアページ](https://www.kanai.or.jp/aftercare/)をご確認ください。」
- 良い例：「詳しいコースや料金については、産後ケアのページをご確認ください。」
- **禁止文言**：「画面下の参照リンク」「参照リンクからご確認ください」「詳しい内容は、画面下の〜」。これらは絶対に書かない。列挙がないときは電話など具体名で案内する。
- ユーザーが**自分の言葉で**不安・怖さを述べた場合に限り、短い一言で受け止める。推測で「不安ですよね」「理解します」と付け足さない。不必要な保証はしない。
- ユーザーの質問が公式サイトの抜粋の内容と意味的に近い場合は、その内容をもとに自然な文章に言い換えて説明する。完全一致でなくてもよい。
- 文末に絵文字を使用する場合は、句読点は表示しない。

【日本語の自然さルール（全回答で必須）】
- 最終出力の前に、必ず「病院窓口スタッフがそのまま口頭で言って自然か」を自己チェックし、不自然なら書き直してから出力する。
- 1文を長くしすぎない。読点「、」が3つ以上続く文は分割する。
- 「〜については」「〜に関しては」を1文内で重ねない。必要なら1回までにする。
- 抽象語だけで終わらない。「詳細」「利用方法」「注意点」などの語を使うときは、案内先を明示する（ページ名、または電話など具体名）。「画面下の参照リンク」とは書かない。
- 丁寧だが回りくどい定型を避ける。短く具体的に言い切る。
- 文頭に絵文字を置くときは、絵文字の前に「・」「-」「*」などの記号を付けない（例「✅ 受付時間は〜」）。

【不自然になりやすい禁止パターン】
- 「次の行動として、」「次のステップとして、」で提案を始める前置き（選択肢はそのまま書く）
- 「〜については、何かご不明な点があればお知らせください。」のような、案内先が曖昧な締め
- 「〜が考えられるため、〜であることも理解できます。」のような、一般論＋感情ラベル付けの硬い連結
- 「〜していただく必要があります」を多用する命令調（必要時のみ使い、可能なら「〜してください」「〜をお願いします」に言い換える）
- 同語反復（例「確認をご確認ください」「詳細の詳細」）
- 「〜ますので、ご了承ください」「〜ますが、ご了承ください」のように「ご了承ください」を接続助詞でつなぐ言い方。「ご了承ください」は独立した1文にする（悪い例「変更になることもありますので、ご了承ください。」／良い例「変更になることもあります。ご了承ください。」）
- 主語が抜けて意図が曖昧な文（誰が何をするかが不明）
- 「〜と良いですね」「〜といいですね」で、相手の安心・心配・不安などを他人事のように締める文
- [ページ名](https://...) 形式の Markdown リンク、文中の当院 URL 文字列

【推奨する言い換え】
- 悪い例  
  「詳しい利用方法や注意点については、何かご不明な点があればお知らせください。」
- 良い例  
  「詳しい利用方法や注意点については、当院サイトをご確認ください。」
  「ご不明な点があれば、お電話でご相談ください。」

【旧形式・二層マーカーの禁止】
<<<PREVIEW>>>、<<</PREVIEW>>>、<<<DETAIL>>>、<<</DETAIL>>> などの二層用マーカーは**一切使わない**（仕様廃止済み）。ユーザー画面に制御文字が出る。通常の本文、または【リッチHTML】に従い先頭を [[[RICH_HTML]]] とした HTML のみを出力する。

【リッチHTML（表・カード型の見せ方）】
次に当てはまる質問では、プレーン文や Markdown だけの箇条書き・**太字**に頼った回答は**禁止**。**必ず**次の形式にする（例外なし）。
・診療時間・診察時間・受付時間・休診・曜日ごとのスケジュール・午前診／午後診／夜診・「いつまで診ているか」等
・料金・費用・予納金・支払い方法など、一覧表で示すのが適切な内容

手順：
1. 出力の**先頭**は、空白や改行を入れず、次の1行**のみ**：[[[RICH_HTML]]]（**括弧は開き3つ・閉じ3つ。スラッシュや4つ括弧は絶対に使わない**）
2. その**直後の次の文字から** HTML のみ。マーカーの前後にプレーンテキストを**一切**書かない（挨拶等はすべて HTML の p や h3 の内側に書く）。
3. ルートは **1つ** の <div class="chat-card"> にまとめる。共感の一文や締めもこの div 内に含める。
4. **禁止**：[[[/RICH_HTML]]]、[[[\\/RICH_HTML]]]、マーカーだけの出力、閉じタグ風のマーカー。ユーザー画面にマーカー文字列そのものが見えてはならない。
5. HTML カードで書けない場合は、マーカーを**使わず**通常の日本語文で答える（マーカーだけ出して終えることは禁止）。

使ってよいタグは次に限る：div, h3, h4, p, table, thead, tbody, tr, th, td, ul, ol, li, strong, em, br, span, a, hr, section, caption
属性は class のみ、および a には href（https://www.kanai.or.jp または https://kanai.or.jp で始まるURLのみ）, target="_blank", rel="noopener noreferrer" のみ。
script, style, iframe, onclick、data-*、id は使わない。
ルートの枠は class="chat-card"、見出しは **div.chat-card-head** の内側に span.chat-card-icon と **h3.chat-card-title** を置く（h3 に chat-card-head を直接付けない）。
表は class="chat-table"、※注記は class="chat-note"、当院ページへの導線は class="chat-pill-row" と a.chat-pill、まとめ見出しは class="chat-section"、まとめリストは class="chat-list"。

カード内の a.chat-pill 等で当院ページへ誘導してよい。**本文末に URL の箇条書きは書かない**（チップに任せる）。

【院内情報（システム専用。ユーザー向けの回答テキストには、この名称を出さない）】
このあと別の system メッセージとして「当院公式サイトのページ本文の抜粋（URL・更新日付き）」が渡される場合がある。
- **当院固有の事実**は、その抜粋に書かれている内容だけを根拠にする。抜粋が無い／該当記述が無いときは推測せず、電話問い合わせを案内する。
- 抜粋があるときは短い質問でもその内容を核にして簡潔に伝える。一般論で薄めない。
- ユーザー発話に「面会」が含まれるときは、そのターンの抜粋は**面会ページ（${MEETING_INFO_PAGE_URL}）の内容のみ**である。他の院内ページの情報や推測を混ぜない。
- ユーザー発話に「立ち会い」が含まれるときは、そのターンの抜粋は**立ち会い分娩ページ（${ATTEND_INFO_PAGE_URL}）の内容のみ**である。他の院内ページの情報や推測を混ぜない。
`.trim();

const PROMPT_NO_CLINIC_EVIDENCE = [
  "【このターン：当院固有情報の根拠なし（最優先）】",
  "ユーザーの質問は当院の制度・時間・予約・サービス等の固有情報に関するものですが、今回は公式サイト抜粋から十分な根拠を取得できませんでした。",
  "・一般知識や推測で診療時間・休診・予約可否・料金・面会・ワクチン等を答えない。",
  "・「一般的な産婦人科では」「通常は」などの補完も禁止。",
  "・丁寧に、正確な情報を確認できないため当院へお電話でお問い合わせほしい旨を案内する。",
].join("\n");

/** このターンだけリッチHTMLを強く指示（モデルがプレーン文に逃げるのを防ぐ） */
const RICH_HTML_THIS_TURN = [
  "【このターンの回答形式（最優先・他会話テンプレより上）】",
  "このユーザー発話は、診療時間・休診・曜日別スケジュール、または料金・費用の確認に該当します。",
  "",
  "必ず次のみで出力してください。",
  "1. 先頭は空白・改行なしで次の1行だけ：[[[RICH_HTML]]]",
  "2. 続けて HTML のみ。前後にプレーンテキストや Markdown を付けない。",
  "3. ルートは1つの <div class=\"chat-card\">。診療枠は <table class=\"chat-table\">。",
  "4. <<<PREVIEW>>> や <<<DETAIL>>> 等の二層マーカーは出さない（廃止済み）。",
  "5. マーカーは [[[RICH_HTML]]] のみ。[[[/RICH_HTML]]] など誤形式・マーカー単体の出力は禁止。HTML が書けないならマーカーなしの通常文で答える。",
].join("\n");

/** クレーム・不満（条件付きで付与。他会話テンプレより優先） */
const PROMPT_COMPLAINT = [
  "【このターン：クレーム・不満への対応（最優先）】",
  "・ユーザーは当院への不満・クレームを話しています。「他の病院に変更したい」など転院・他院変更の意向があっても、他院での過去経験の相談ではない。当院クレームとして対応する。",
  "・冒頭は必ず次の2文をこの順番で書く（順番を入れ替えない）。",
  "  1）状況についてご教示くださりありがとうございます。",
  "  2）この度は、ご不快な思いをおかけすることとなり、改めてお詫び申し上げます。",
  "・謝罪から始めない。お礼→謝罪の順を守る。",
  "・共感は一切書かない。「理解できます」「納得です」「もっともだと思います」「無理もないことだと思います」「そのように感じられた」「大切ですので」等は禁止。",
  "・上から目線の言い回しも禁止。「私たちのサービス」「期待に応えられなかった」「残念です」「残念ですね」等は書かない。",
  "・感情の代弁・気持ちの言語化・講義調の説明は書かない。混雑や待ち時間について「残念ですね」と評さない。",
  "・続けてご指摘の受け止めと改善姿勢を伝える（例：「ご指摘の点は真摯に受け止めます。」「今後の対応についても、より安心していただけるよう努めてまいります。」）。",
  "・「こちらでの受診をお考えの場合」「前の病院でのご経験について」など、他院経験向け・新規受診向けの定型文は書かない。",
  "・詳細の催促は禁止。「具体的な状況を教えてください」「詳しく教えてください」「もう少し詳しく」「どのような状況だったか教えて」「差し支えのない範囲でお聞かせください」など、追加説明を求める文は書かない。",
  "・話題を流す締めも禁止。「他に気になることや、お話しされたいことがあればお聞かせください。」「他にも気になることがあればお知らせください。」「何か質問があれば〜」等。",
  "・良い例：状況についてご教示くださりありがとうございます。この度は、ご不快な思いをおかけすることとなり、改めてお詫び申し上げます。ご指摘の点は真摯に受け止めます。今後の対応についても、より安心していただけるよう努めてまいります。",
].join("\n");

/** 他院・以前の病院での経験（当院クレームではない） */
const PROMPT_OTHER_HOSPITAL_EXPERIENCE = [
  "【このターン：他院・以前の病院での経験の相談（最優先）】",
  "ユーザーは当院へのクレームではなく、以前・別の病院での経験や、その影響による不安を話しています。",
  "・「他の病院に変更したい」「転院したい」など、いま当院から離れたい意向の発言にはこのテンプレを使わない（それは当院クレーム側）。",
  "・当院への謝罪は書かない（「ご不快な思いをさせてしまい、申し訳ありません」「この度は、ご不快な思いをおかけすることとなり」等は禁止）。",
  "・「ご指摘の点は真摯に受け止め」「今後の対応改善に努めます」等、当院が悪かったかのような改善約束も書かない。",
  "・他院の医師・スタッフの善悪評価や批判には乗らない。",
  "・「そういった経験をされたのですね」「〜は大切です」などの感情代弁・講義調も書かない。",
  "・短くお礼を述べ、こちらで受診を検討する際に気になる点があれば聞き出す。必要なら診療時間内のお電話相談など選択肢を提示する。",
  "・良い例：前の病院でのご経験についてお聞かせいただき、ありがとうございます。こちらで受診をお考えの場合、気になることがあれば遠慮なくお聞かせください。診療時間内にお電話でご相談いただくこともできます。",
].join("\n");

/** 会話途中の短い相槌（うん・はい・そうなんです 等） */
const PROMPT_SHORT_BACKCHANNEL = [
  "【このターン：短い相槌への対応（最優先）】",
  "ユーザー発話は「うん」「はい」「そうなんです」などの短い相槌・同意です。",
  "・この短文だけを見て定型返答しない（挨拶・一般論・新規の共感だけで終わらない）。",
  "・直前までの会話履歴（症状・不安・質問・案内内容）を必ず踏まえて返答する。",
  "・すでに共感・受け止めを伝えている場合は、同じ共感表現を繰り返さない。",
  "・相談内容に沿って会話を一歩進める。例：「少しでも楽になる方法を一緒に考えてみましょうか？」「今いちばん気になっている点はどれでしょう。」",
  "・「そうですか。」「分かりました。」だけの相槌返しで終わらない。",
  "・禁止の共感宣言（理解できます・大変でしたね・アドバイス 等）は使わない。",
].join("\n");

const COMPLAINT_THANKS =
  "状況についてご教示くださりありがとうございます。";
const COMPLAINT_APOLOGY =
  "この度は、ご不快な思いをおかけすることとなり、改めてお詫び申し上げます。";

const NOT_OFFERED_THANKS = "お問い合わせありがとうございます。";

/** FAQ上、当院で実施していないことが分かっている内容（文言はサービス種別ごと） */
const NOT_OFFERED_SERVICES = [
  {
    id: "epidural",
    label: "無痛分娩",
    pattern: /無痛分娩|無痛(?:で)?(?:の)?(?:お産|出産|分娩)|硬膜外麻酔|硬膜外|エピ(?:ジュラル)?/,
    topicPattern: /無痛分娩|硬膜外|エピ(?:ジュラル)?/,
    apologyLine: "大変申し訳ございませんが、当院では無痛分娩は行っておりません。",
  },
  {
    id: "sunday",
    label: "日曜診療",
    pattern:
      /日曜診療|日曜(?:日)?(?:も|に|は)?(?:診療|診察|外来|開院|開い|やって|診て|受診|来院できる)|日曜日は(?:診察|診療)/,
    topicPattern: /日曜/,
    apologyLine: "大変申し訳ございませんが、日曜日は休診です。",
  },
  {
    id: "holiday",
    label: "祝日診療",
    pattern:
      /祝日診療|祝日(?:も|に|は)?(?:診療|診察|外来|開院|開い|やって|診て|受診|来院できる)/,
    topicPattern: /祝日/,
    apologyLine: "大変申し訳ございませんが、祝日は休診です。",
  },
  {
    id: "breast_cancer_screening",
    label: "乳がん検診",
    pattern: /乳がん検診|乳癌検診|マンモグラフィ|マンモグラフィー/,
    topicPattern: /乳がん検診|乳癌検診|マンモグラフィ|マンモグラフィー/,
    apologyLine: "大変申し訳ございませんが、当院では乳がん検診は行っておりません。",
  },
  {
    id: "nursery",
    label: "託児所",
    pattern: /託児所|託児サービス/,
    topicPattern: /託児所|託児/,
    apologyLine: "大変申し訳ございませんが、当院には託児所はございません。",
  },
];

const FIXED_RULE_AFFIRM_RE =
  /実施しています|実施しております|ご利用いただけます|ご利用できます|対応しています|対応しております|開設しています|開設しております|行っています|行っております|受け付けています|受付しています|実施中|ご案内しています/;

function detectNotOfferedService(userMessage) {
  const text = String(userMessage || "").trim();
  if (!text) return null;
  for (const item of NOT_OFFERED_SERVICES) {
    if (item.pattern.test(text)) return item;
  }
  return null;
}

function buildNotOfferedPrompt(hit) {
  const label = hit.label;
  const apology = hit.apologyLine;
  return [
    "【このターン：実施していない内容への回答（最優先）】",
    `院内情報により、ユーザーが尋ねている「${label}」は当院では実施していない／該当しないことが分かっています。`,
    "・冒頭は必ず次の2文をこの順番で書く（順番を入れ替えない）。",
    `  1）${NOT_OFFERED_THANKS}`,
    `  2）${apology}`,
    "・謝罪から始めない。お礼→上記2文目の順を守る。",
    "・実施していないこと／該当しないことを曖昧にしない・遠回しにしない。",
    "・必要なら続けて、代替の案内・電話相談など短い補足を書いてよい。",
    `・良い例：${NOT_OFFERED_THANKS}${apology}`,
    "・注意：通常の案内質問（予約方法・制度・診療時間など）ではこのお礼→謝罪テンプレは使わない。このターンだけ例外。",
  ].join("\n");
}

/**
 * 固定ルール回答の根拠になっていないURLはチップに出さない。
 * サービス話題に一致する公式ページだけ残す（なければ空）。
 */
function filterReferencedPagesForNotOffered(hit, sourceChunks, referencedPages) {
  if (!hit) return referencedPages || [];
  const topicRe = hit.topicPattern || new RegExp(hit.label);
  const matched = [];
  const seen = new Set();
  for (const c of sourceChunks || []) {
    const hay = `${c.title || ""}\n${c.text || ""}\n${c.url || ""}`;
    if (!topicRe.test(hay)) continue;
    const url = rewriteLegacyKanaiUrl(c.url);
    if (!url || seen.has(url) || isGenericKanaiHomeUrl(url)) continue;
    // 無関係なお知らせ（例: 休診）だけで固定ルールと無関係なら除外
    if (hit.id !== "sunday" && hit.id !== "holiday" && /\/news\//i.test(url) && !topicRe.test(hay)) {
      continue;
    }
    seen.add(url);
    matched.push({
      url,
      title: String(c.title || hit.label).replace(/\s+/g, " ").trim() || url,
    });
  }
  // sourceChunks に無くても、既に topic 一致の参照があれば残す
  if (!matched.length) {
    for (const p of referencedPages || []) {
      const url = rewriteLegacyKanaiUrl(p?.url);
      if (!url || seen.has(url)) continue;
      if (topicRe.test(`${p.title || ""}\n${url}`)) {
        seen.add(url);
        matched.push({ url, title: p.title || hit.label });
      }
    }
  }
  return matched.slice(0, MAX_REFERENCE_CHIPS);
}

/**
 * 固定ルールと公式サイトの肯定表現の矛盾を検知（debug用・患者非表示）
 */
function detectFixedRuleConflict(hit, sourceChunks) {
  if (!hit) return null;
  const topicRe = hit.topicPattern || new RegExp(hit.label);
  for (const c of sourceChunks || []) {
    const hay = `${c.title || ""}\n${c.text || ""}`;
    if (!topicRe.test(hay)) continue;
    if (!FIXED_RULE_AFFIRM_RE.test(hay)) continue;
    return {
      id: hit.id,
      label: hit.label,
      url: c.url,
      title: c.title || "",
      note: "公式サイトに肯定表現あり（固定ルールと矛盾の可能性）",
    };
  }
  return null;
}

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

/**
 * 会話途中の短い相槌・同意か（履歴を踏まえた続行が必要）
 */
function isShortBackchannelMessage(userMessage, safeHistory) {
  const userPrior = (safeHistory || []).filter((h) => h && h.role === "user").length;
  if (userPrior < 1) return false;
  const raw = String(userMessage || "").trim();
  if (!raw || raw.length > 40) return false;
  const compact = raw.replace(/[\s\u3000]+/g, "");
  return /^(うん|うんうん|はい|はいはい|ええ|そう|そうです|そうなんです|そうなんですよ|そうですよね|そうですね|そうだよ|そうだね|そうですよ|なるほど|了解|了解です|了解しました|わかりました|分かりました|わかった|分かった|ええそうです|はいそうです|はいそうなんです|そうなの|そうなんだ|まぁ|まあ)([!！?？.。…〜ー]*)?$/i.test(
    compact
  );
}

function shouldAddShortBackchannelPrompt(userMessage, safeHistory) {
  if (shouldAddComplaintPrompt(userMessage, safeHistory)) return false;
  if (shouldAddOtherHospitalExperiencePrompt(userMessage, safeHistory)) return false;
  if (detectNotOfferedService(userMessage)) return false;
  return isShortBackchannelMessage(userMessage, safeHistory);
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
 * チャット仕様・プライバシー等のメタ質問（公式サイト検索対象外）
 * @returns {{ id: string, label: string }|null}
 */
function detectMetaChatQuery(userMessage) {
  const text = String(userMessage || "").trim();
  if (!text) return null;
  const patterns = [
    /この(?:やり取り|会話|チャット|相談|メッセージ)/,
    /(?:会話|チャット|やり取り|相談内容|履歴).*(?:保存|記録|ログ|残)/,
    /(?:保存|記録|ログ|履歴).*(?:され|ます|残|見)/,
    /誰(?:か|が|に).*(?:読|見|確認)/,
    /(?:病院|スタッフ|御社|運営|管理者|職員).*(?:読|見|確認)/,
    /(?:読まれ|見られ).*(?:て|ます|いる)/,
    /個人情報/,
    /プライバシー/,
    /利用規約/,
    /(?:あなたは)?AIですか|Chat\s*GPT|チャットGPT|チャットボット|ボットですか|人工知能/i,
    /どういう仕組み|どのように動いて|仕組みですか|どうやって答えて/,
    /このチャットは安全|安全ですか|セキュリティ/,
    /運営者|管理者は誰|誰が運営/,
    /会話履歴について|ログは残/,
  ];
  if (patterns.some((re) => re.test(text))) {
    return { id: "meta_chat", label: "チャット仕様" };
  }
  return null;
}

const PROMPT_META_CHAT = [
  "【このターン：チャット仕様・プライバシー（meta_chat・最優先）】",
  "ユーザーは当院の診療案内ではなく、この相談チャット自体（保存・閲覧・AI・安全性など）について質問しています。",
  "・公式サイト抜粋やお知らせは使わない。参照リンク（チップ）の案内も書かない。",
  "・「AI」「ChatGPT」「チャットボット」などと名乗らない。「相談窓口としてご案内します」と表現する。",
  "・次の内容を、丁寧で簡潔に伝える（嘘や過剰な安心はしない）。",
  "  1）この画面は当院の相談窓口としての案内チャットであること",
  "  2）会話内容は、案内品質の確認や改善のため、当院側で記録・確認される場合があること",
  "  3）診断や処方は行わず、一般的な案内と受診の目安をお伝えする場であること",
  "  4）個人を特定する情報の入力はできるだけ避けてほしいこと",
  "・診療時間・休診・予約など院内案内へ話を逸らさない。",
].join("\n");

/**
 * 公式サイトを読みにいくかどうか（現在の入力＋直近のユーザー発話をざっくり判定）
 */
function shouldLoadSiteKnowledgeForMessage(userMessage, safeHistory) {
  // 現在の発話がメタ質問なら、履歴に院内語があってもサイト検索しない
  if (detectMetaChatQuery(userMessage)) return false;

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
    /ワクチン|インフルエンザ|予防接種|アブリスボ|RSウイルス/,
    /オンライン診療|オンライン|遠隔診療|テレビ電話/i,
    /電話|番号|06[-‐]?6931/i,
    /今日|本日|明日|明後日|今週|午後は診|午前は診/,
    /面会|お見舞い|会いに来|会いに行|立ち会|立会い|立ち合い|付き添|分娩室に入れ/,
    /料金|費用|いくらかか|入院費|自己負担|託児所|無痛分娩|乳がん検診/,
    /駐車|パーキング|持ち物|持参|何を持/,
  ];

  return (
    triggers.some((re) => re.test(text)) ||
    isMeetingFocusedQuery(text) ||
    isAttendFocusedQuery(text)
  );
}

/** 当院固有事実が必要な質問か（根拠なし時は一般知識で埋めない） */
function isClinicSpecificFactualQuery(userMessage, safeHistory) {
  return shouldLoadSiteKnowledgeForMessage(userMessage, safeHistory);
}

/** 開発用: URL一覧キャッシュ無視（患者向けUIからは使わない） */
function shouldForceSiteKnowledgeRefresh(req) {
  const token = String(process.env.SITE_KNOWLEDGE_REFRESH_TOKEN || "").trim();
  if (!token) return false;
  const header = String(req.headers["x-site-knowledge-refresh"] || "").trim();
  return header.length > 0 && header === token;
}

function shouldIncludeSiteKnowledgeDebug(req) {
  const debugOn = ["1", "true", "yes"].includes(
    String(process.env.SITE_KNOWLEDGE_DEBUG || "").toLowerCase().trim()
  );
  if (!debugOn) return false;
  // シークレット一致時のみレスポンスに載せる（患者画面に出さない）
  return shouldForceSiteKnowledgeRefresh(req) || isValidChatApiSecret(req);
}

/**
 * 診療時間・料金など「表・カード必須」の質問か（現在＋直近ユーザー発話）
 */
function shouldForceRichHtmlForMessage(userMessage, safeHistory) {
  const chunks = [String(userMessage || "")];
  if (Array.isArray(safeHistory)) {
    for (const h of safeHistory) {
      if (h && h.role === "user") {
        chunks.push(String(h.content || ""));
      }
    }
  }
  const text = chunks.join("\n").slice(-4000);

  const schedule =
    /診療時間|診察時間|受付時間|休診|夜診|午前診|午後診|日曜|祝日|開いてい|何時から|何時まで|診療.*いつ|いつ.*診療/.test(
      text
    );
  const fee =
    /料金|費用|予納金|予約金|いくら|支払い|クレジット|クレカ|現金/.test(text);

  return schedule || fee;
}

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

function looksLikeWantToLeaveKanai(text) {
  return /他の病院に(?:変更|移|変え|転院)|別の病院に(?:変更|移|変え|転院)|他院に(?:変更|移|転院)|転院したい|病院を変えたい|かかりつけを変えたい|病院を変更したい|ここをやめ|当院をやめ|金井.*(?:やめ|変え|転院|変更)/.test(
    String(text || "")
  );
}

/** 不満の対象が当院であることの手がかり */
function looksLikeKanaiComplaintTarget(text) {
  const t = String(text || "");
  return /当院|本院|金井|ここの(?:病院|クリニック|スタッフ|看護師|受付)|こちらの(?:病院|スタッフ|看護師|受付)/.test(
    t
  );
}

/**
 * 他院・以前の病院での過去経験の相談か。
 * 「他の病院に変更したい」など当院から離れたい意向は含めない（当院クレーム側）。
 */
function isOtherHospitalExperienceMessage(userMessage, safeHistory) {
  const text = recentUserText(userMessage, safeHistory);
  const current = String(userMessage || "").trim();

  // 当院への不満で転院・他院変更の意向 → 他院経験ではない
  if (looksLikeWantToLeaveKanai(current)) return false;

  // 当院を名指しで非難している → 他院経験テンプレにしない
  if (
    /当院(?:は|の|が|を)?[^。\n]{0,24}(?:最悪|ひど|不快|悪|ダメ)|(?:ここ|こちらの病院)(?:は|の|が)?[^。\n]{0,24}(?:最悪|ひど|不快|悪)/.test(
      text
    )
  ) {
    return false;
  }

  // 過去・別の病院での経験を示す表現（「他の病院に変更」は含めない）
  const otherHospitalCue =
    /前の病院|以前の病院|以前行った病院|別の病院では|別の病院で(?!変更)|他の病院では|他の病院で(?!変更)|他院では|他院で(?![ァ-ヶー]*変更)|前に行った病院|以前行った|前回の病院|元の病院|転院前|前のかかりつけ|以前のかかりつけ/;
  const negativeCue =
    /怖|ひど|威圧|怒|冷た|不安|嫌|つら|苦|信頼でき|不信|トラウマ|最悪|無理|不快|嫌だった|嫌で/;

  if (looksLikeWantToLeaveKanai(text) && !/前の病院|以前の病院|前回の病院|元の病院|転院前/.test(text)) {
    return false;
  }

  // 他院比較＋当院名指しは当院クレーム優先（他院経験にしない）
  if (otherHospitalCue.test(text) && looksLikeKanaiComplaintTarget(text) && /最悪|ひど|不快|態度|許せ/.test(text)) {
    return false;
  }

  if (otherHospitalCue.test(text) && negativeCue.test(text)) return true;
  if (/前の病院|以前の病院|別の病院では|他の病院では|他院では/.test(current)) return true;
  return false;
}

/** 症状の程度としての「ひどい」（クレームではない） */
function looksLikeSymptomSeverityNotComplaint(text) {
  const t = String(text || "");
  // 「つわりがひどい」「痛みがひどい」など身体症状の程度
  if (
    /(?:つわり|悪阻|吐き気|嘔吐|吐|腹痛|痛み|痛|出血|熱|発熱|痒|かゆ|頭痛|腰痛|むくみ|疲労|だる|眠気|体調|症状|陣痛|胎動).{0,6}ひど/.test(
      t
    ) ||
    /ひど.{0,6}(?:つわり|悪阻|吐き気|嘔吐|腹痛|痛み|出血|熱|痒|頭痛|腰痛|症状)/.test(t)
  ) {
    // 院内スタッフ・対応への非難が同時にある場合はクレーム側へ
    if (
      /(?:態度|対応|スタッフ|看護師|ナース|医師|先生|受付|窓口|当院|病院).{0,12}(?:ひど|悪|最悪|不快)/.test(
        t
      ) ||
      /(?:ひど|悪|最悪|不快).{0,12}(?:態度|対応|スタッフ|看護師|ナース|医師|先生|受付|窓口)/.test(t)
    ) {
      return false;
    }
    return true;
  }
  return false;
}

function shouldAddComplaintPrompt(userMessage, safeHistory) {
  if (isOtherHospitalExperienceMessage(userMessage, safeHistory)) return false;
  const text = recentUserText(userMessage, safeHistory);
  const current = String(userMessage || "").trim();

  // 「つわりがひどい」など症状の程度はクレームにしない
  if (looksLikeSymptomSeverityNotComplaint(current) || looksLikeSymptomSeverityNotComplaint(text)) {
    // 履歴全体に明確なクレーム語がある場合のみ続行判定へ
    if (!/クレーム|苦情|許せない|ありえない|ふざけ|訴えたい|文句|態度が悪|対応が悪/.test(text)) {
      return false;
    }
  }

  if (looksLikeWantToLeaveKanai(current) && /不快|ひど|最悪|態度|冷たい|威圧|怖|怒|クレーム|苦情|文句|許せ|ありえない|不信/.test(text)) {
    return true;
  }

  // 「ひどい」単体は不可。院・対応・スタッフへの非難と結びつくときだけクレーム
  const complaintRe =
    /クレーム|苦情|不快|最悪|ありえない|許せない|不信|ふざけ|態度が悪|態度.*悪|無愛想|冷たい|窓口.*悪|受付.*悪|スタッフ.*悪|看護師.*悪|看護師.*ひど|看護師.*態度|ナース.*悪|対応が悪|対応がひど|対応.*ひど|威圧|怖かった|怒鳴|叱咤|先生.*怖|医師.*怖|当院.*(ひど|悪|最悪|不快)|他院.*(良|いい)|他の病院.*(良|いい)|訴えたい|文句|ひどかった|最悪だった|怒られ|怒った|(?:態度|対応|スタッフ|看護師|ナース|医師|先生|受付|窓口|サービス).{0,8}ひど|ひど.{0,8}(?:態度|対応|スタッフ|看護師|ナース|医師|先生|受付|窓口)/;

  return complaintRe.test(text);
}

function shouldAddOtherHospitalExperiencePrompt(userMessage, safeHistory) {
  return isOtherHospitalExperienceMessage(userMessage, safeHistory);
}

/** 症状・感情の相談（院内案内の事実確認ではない） */
function looksLikeConsultWithoutReferencePages(userMessage, safeHistory) {
  const text = recentUserText(userMessage, safeHistory);
  if (
    /怖い|不安|無理|トラウマ|心配|つらい|苦しい|痛い|腹痛|出血|吐き気|発熱|陣痛|破水|胎動|気持ち|つらかった/.test(
      text
    )
  ) {
    return true;
  }
  const current = String(userMessage || "").trim();
  return current.length > 0 && current.length <= 28 && /痛|血|熱|吐|痒|怖|辛/.test(current);
}

/** 画面下の参照リンク（チップ）を出さないターンか */
function shouldSuppressReferencePages(userMessage, safeHistory, knowledgeHitScore = 0) {
  if (shouldAddComplaintPrompt(userMessage, safeHistory)) return true;

  if (looksLikeConsultWithoutReferencePages(userMessage, safeHistory)) {
    // サイト抜粋が当たっているときはチップを出してよい
    if (shouldLoadSiteKnowledgeForMessage(userMessage, safeHistory) && knowledgeHitScore >= 10) {
      return false;
    }
    return true;
  }

  if (!shouldLoadSiteKnowledgeForMessage(userMessage, safeHistory) && knowledgeHitScore < 8) {
    return true;
  }

  return false;
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

/**
 * 平文回答に混入した HTML / 制御マーカー断片（例: </ 、<<<PREVIEW>>>）を除去する。
 * RICH_HTML 本体のタグは維持する。
 */
function stripLeakedControlMarkup(text) {
  let s = String(text ?? "");
  if (!s.trim()) return s;

  if (s.trimStart().startsWith(RICH_HTML_PREFIX)) {
    let body = s.trimStart().slice(RICH_HTML_PREFIX.length);
    body = body.replace(/\[\[\[\/?RICH_HTML\]\]\]+/gi, "");
    body = body.replace(/<<<\/?[A-Za-z_]+>>>?/g, "");
    return (RICH_HTML_PREFIX + body).trim();
  }

  s = s.replace(/\[\[\[\/?RICH_HTML\]\]\]+/gi, "");
  s = s.replace(/<<<\/?[A-Za-z_]+>>>?/g, "");
  s = s.replace(/<\/?[a-zA-Z][^>\n]*>/g, "");
  s = s.replace(/<\/?[a-zA-Z][^>\n]{0,40}/g, "");
  s = s.replace(/<\/?/g, "");
  s = s.replace(/<{2,}/g, "");
  s = s.replace(/>{2,}/g, "");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

/** 定型冒頭と混ぜる前に、HTML回答を平文へ落とす */
function flattenHtmlAnswerToPlain(text) {
  let s = String(text || "");
  if (!s.trim()) return "";
  s = s.replace(/\[\[\[\/?RICH_HTML\]\]\]+/gi, "");
  s = s.replace(/<<<\/?[A-Za-z_]+>>>?/g, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(?:p|div|h[1-6]|li|tr)>/gi, "\n");
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return stripLeakedControlMarkup(s);
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
  const replaceWithEmpty = [
    /次にどうするかは、あなた自身が選べる状態を大切にしていただきたいです。?\s*どのように進めていくのか考えてみることも良いですね。?/g,
    /どのように進め(?:る|ていく)か、?\s*あなた自身(?:で)?考え(?:られる|てみる)(?:こと)?(?:ができる)?(?:と)?良いですね。?/g,
    // 他人事・距離感のある締め（「あなたの安心につながると良いですね」等）
    /(?:あなたの|なたの|ご自身の)?安心[^。\n]*?と(?:良|い)いですね[。]?/g,
    /(?:あなたの|なたの)[^。\n]{0,24}?と(?:良|い)いですね[。]?/g,
    /[^。\n]*?につながると(?:良|い)いですね[。]?/g,
    /[^。\n]*?お役に立てれば(?:と|と思)(?:良|い)いですね[。]?/g,
  ];
  for (const re of replaceWithEmpty) {
    s = s.replace(re, "");
  }
  // 講義調・上から目線・他人事の訓示（削除のみ）
  const stripLecture = [
    /[^。\n]*(?:あなた自身|ご自身)[^。\n]{0,40}(?:大切|重要)です[ね]?[。]?/g,
    /[^。\n]*しっかり(?:と)?確認[^。\n]{0,20}(?:大切|重要)です[ね]?[。]?/g,
    /[^。\n]*(?:状態|体調|症状)を[^。\n]{0,24}確認[^。\n]{0,16}(?:大切|重要)です[ね]?[。]?/g,
    /[^。\n]*確認するのが(?:大切|重要)です[ね]?[。]?/g,
    /[^。\n]*のが(?:大切|重要)です[ね]?[。]?/g,
    /[^。\n]*することが(?:大切|重要)です[ね]?[。]?/g,
  ];
  for (const re of stripLecture) {
    s = s.replace(re, "");
  }
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

/** 文末の催促・切り上げ定型を全回答から除去 */
function stripPromptingClosings(text) {
  let s = String(text || "");
  if (!s.trim()) return s;
  const patterns = [
    /他にも?気になることや[、,]?お話しされたいことがあればお聞かせください。?/g,
    /他にも?気になること(?:が|や)あればお(?:聞かせ|知らせ)ください。?/g,
    /他にも?気になること(?:が|や)[^。\n]*お(?:聞かせ|知らせ)ください。?/g,
    /お話しされたいことがあれば[^。\n]*。/g,
    /何か(?:他に)?(?:ご)?質問があれば[^。\n]*。?/g,
    /ほかに(?:ご)?不明な点があれば[^。\n]*。?/g,
    /ほかにも?気になることがあれば[^。\n]*。?/g,
    /他にご質問があれば[^。\n]*。?/g,
    /他に(?:ご)?不明な点[^。\n]*。?/g,
    /何かございましたら[^。\n]*。?/g,
    /何か気になる(?:点|こと)があれば[^。\n]*。?/g,
    /気になることがあれば(?:遠慮なく)?お(?:聞かせ|申し付け|知らせ)ください。?/g,
    /お気軽にお(?:聞かせ|問い合わせ)ください。?/g,
    /ぜひお聞かせください。?/g,
    // 出力途中切れで残る催促の破片
    /(?:\n|^)何か(?:他に)?(?:ご)?(?:質問|気になる|ござい)[^\n。．]*$/g,
    /(?:\n|^)何か\s*$/g,
    /[。．！？]\s*何か\s*$/g,
  ];
  for (const re of patterns) {
    s = s.replace(re, (m) => (/[。．！？]\s*何か\s*$/.test(m) ? m.replace(/\s*何か\s*$/, "") : ""));
  }
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function defaultRefPageTitle(url) {
  const u = String(url || "").toLowerCase();
  if (/\/about\/?/i.test(u)) return "当院について";
  if (/\/beginner\/?/i.test(u)) return "初めての方へ";
  if (/\/visit|\/gai/i.test(u)) return "外来のご案内";
  return "当院サイト";
}

/**
 * 参照チップ用ページを正規化（旧URL置換・TOP除外・最大1件）
 * 並びは情報源の関連度順（先頭優先）を維持する。
 * @param {Array<{ url?: string, title?: string }>} pages
 * @param {string} userMessage
 */
function finalizeReferencedPages(pages, userMessage) {
  const rewritten = [];
  const seen = new Set();
  for (const p of pages || []) {
    const url = rewriteLegacyKanaiUrl(p?.url);
    if (!url || !/^https?:\/\/(?:www\.)?kanai\.or\.jp\//i.test(url)) continue;
    if (isGenericKanaiHomeUrl(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    rewritten.push({
      url,
      title: String(p?.title || defaultRefPageTitle(url)).replace(/\s+/g, " ").trim() || url,
    });
  }
  if (!rewritten.length) return [];

  // 面会・立ち会い質問では該当ページを優先
  let ordered = rewritten;
  if (isAttendFocusedQuery(userMessage)) {
    ordered = [
      ...rewritten.filter((p) => p.url === ATTEND_INFO_PAGE_URL),
      ...rewritten.filter((p) => p.url !== ATTEND_INFO_PAGE_URL),
    ];
  } else if (isMeetingFocusedQuery(userMessage)) {
    ordered = [
      ...rewritten.filter((p) => p.url === MEETING_INFO_PAGE_URL),
      ...rewritten.filter((p) => p.url !== MEETING_INFO_PAGE_URL),
    ];
  }
  return ordered.slice(0, MAX_REFERENCE_CHIPS);
}

/**
 * チップ最終ガード: 質問との語の重なりが無いURLは落とす
 * @returns {{ pages: Array<{url:string,title:string}>, excluded: Array<{url:string,reason:string}> }}
 */
function guardReferenceChipsByQuestion(pages, userMessage, opts = {}) {
  const excluded = [];
  if (opts.metaChat) {
    for (const p of pages || []) {
      excluded.push({ url: p?.url || "", reason: "meta_chatのためチップ禁止" });
    }
    return { pages: [], excluded };
  }
  if (opts.clinicOnly || opts.notOfferedOnly) {
    for (const p of pages || []) {
      excluded.push({
        url: p?.url || "",
        reason: opts.clinicOnly
          ? "clinic-knowledgeのみ根拠のためチップなし"
          : "固定ルールのみ根拠のためチップなし",
      });
    }
    return { pages: [], excluded };
  }

  const msg = String(userMessage || "");
  const tokens = msg
    .replace(/[？?！!。．、,…]/g, " ")
    .split(/[\s\u3000のをにはがとでもからまでへやなど]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  const meaningful = tokens.filter(
    (t) => !/^(です|ます|ください|教えて|について|この|それ|ある|ない|したい)$/.test(t)
  );

  const kept = [];
  for (const p of pages || []) {
    const hay = `${p.title || ""}\n${p.url || ""}`.toLowerCase();
    const hit = meaningful.some((t) => hay.includes(t.toLowerCase()));
    // 面会・立ち会い・ワクチン等の正規ルートURLはタイトル語が少なくても許可
    const routeOk =
      /#visit|#assist_birth|#price_birth|\/vaccine\/|\/beginner\/|\/hospitalization\//i.test(
        p.url || ""
      ) &&
      (isMeetingFocusedQuery(msg) ||
        isAttendFocusedQuery(msg) ||
        /ワクチン|インフルエンザ|予防接種|今日|本日|明日|午後|午前|診療|診察|予約|費用|料金/.test(
          msg
        ));
    if (hit || routeOk) {
      kept.push(p);
    } else {
      excluded.push({
        url: p.url || "",
        reason: "質問との語一致がなくチップ最終除外",
      });
    }
  }
  return { pages: kept.slice(0, MAX_REFERENCE_CHIPS), excluded };
}

/** モデルに参照チップの有無を明示（架空のリンク案内を防ぐ） */
function buildReferenceLinksSystemPrompt(referencedPages) {
  if (!referencedPages?.length) {
    return [
      "【このターンの参照リンク】",
      "画面下部には参照リンク（チップ）は表示されません。",
      "「画面下の参照リンク」「参照リンクからご確認ください」「詳しい内容は、画面下の〜」は絶対に書かないでください。",
      "サイト案内が必要なら、お電話など、具体名で案内してください。",
    ].join("\n");
  }
  const lines = referencedPages.map((p) => `- ${(p.title || p.url || "").trim()}`);
  return [
    "【このターンの参照リンク】",
    "回答の直下に次のページがチップとして表示されます（ユーザーはタップできます）。",
    "本文では「画面下の参照リンク」とは書かず、次のページ名だけで案内してください。",
    ...lines,
  ].join("\n");
}

/** 「画面下の参照リンク」系はチップの有無に関わらず必ず除去（文言だけ残る不整合を防ぐ） */
function stripFalseReferenceLinkMention(text, _referencedPages) {
  let s = String(text || "");
  if (!s.trim()) return s;
  const patterns = [
    /[^。．\n]*画面下の参照リンク[^。．\n]*[。．]?/g,
    /[^。．\n]*参照リンクからご確認ください[。．]?/g,
    /[^。．\n]*参照リンク[^。．\n]*ご確認ください[。．]?/g,
    /詳しい内容は[、,]?[^。．\n]*参照リンク[^。．\n]*[。．]?/g,
    /詳細については[、,]?[^。．\n]*参照リンク[^。．\n]*[。．]?/g,
    /詳しくは[、,]?[^。．\n]*参照リンク[^。．\n]*[。．]?/g,
  ];
  for (const re of patterns) {
    s = s.replace(re, "");
  }
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function stripNextActionLeadIn(text) {
  let s = String(text || "");
  s = s.replace(/次の(?:行動|ステップ)として[、,]?/g, "");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

function fixGoryoshoConnective(text) {
  let s = String(text || "");
  s = s.replace(/([^。\n])(?:ますので|ますが|ますし|ますから)、?\s*ご了承(?:の程|のほど)?(?:を)?\s*(?:お願い(?:いた)?します|ください|いただけますと幸いです)/g, (m, prefix) => {
    return `${prefix}ます。ご了承ください`;
  });
  return s;
}

function stripIrrelevantModelClosing(text) {
  let s = String(text || "");
  const patterns = [
    /住みやすい環境[^。\n]*。/g,
    /快適な環境[^。\n]*ご了承[^。\n]*。/g,
  ];
  for (const re of patterns) {
    s = s.replace(re, "");
  }
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

function stripMisplacedKanaiApology(text, userMessage, safeHistory) {
  if (!isOtherHospitalExperienceMessage(userMessage, safeHistory)) return String(text || "");
  let s = String(text || "");
  const patterns = [
    /状況についてご教示くださりありがとうございます。?/g,
    /この度は、?ご不快な思いをおかけすることとなり、?改めてお詫び申し上げます。?/g,
    /ご不快な思いをさせてしまい[^。\n]*。/g,
    /ご指摘の点は真摯に受け止め[^。\n]*。/g,
    /今後の対応についても[^。\n]*努めてまいります。/g,
    /今後の対応改善[^。\n]*。/g,
    /そういった経験をされたのですね[^。\n]*。/g,
    /[^。\n]*安心して受診できる環境[^。\n]*。/g,
    /[^。\n]*とても大切です[^。\n]*。/g,
  ];
  for (const re of patterns) {
    s = s.replace(re, "");
  }
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

/** 当院クレーム時は冒頭を必ず「お礼→謝罪」の順に揃える */
function ensureComplaintThanksThenApology(text, userMessage, safeHistory) {
  if (!shouldAddComplaintPrompt(userMessage, safeHistory)) return String(text || "");
  let s = flattenHtmlAnswerToPlain(text);

  const stripOpenings = [
    /状況についてご教示くださりありがとうございます。?/g,
    /(?:ご状況|状況)について(?:お聞かせ|ご教示|教えて)くださり[^。\n]*ありがとう[^。\n]*。/g,
    /この度は、?ご不快な思いをおかけすることとなり、?改めてお詫び申し上げます。?/g,
    /ご不快な思いをさせてしまい、?(?:大変)?申し訳ありません。?/g,
    /ご不快な思いをおかけし[^。\n]*。/g,
    /大変申し訳ありません。?/g,
  ];
  for (const re of stripOpenings) {
    s = s.replace(re, "");
  }
  s = s.replace(/^[ \t\n]+/, "").replace(/\n{3,}/g, "\n\n").trim();

  const body = s ? `\n${s}` : "";
  return stripLeakedControlMarkup(`${COMPLAINT_THANKS}${COMPLAINT_APOLOGY}${body}`.trim());
}

/** クレーム時：詳細催促・流す締めを除去する（追加の聞き返しは付けない） */
function ensureComplaintDetailAskClosing(text, userMessage, safeHistory) {
  if (!shouldAddComplaintPrompt(userMessage, safeHistory)) return String(text || "");
  let s = String(text || "").trim();
  if (!s) return s;

  const stripClosings = [
    /他にも?気になることや[、,]?お話しされたいことがあればお聞かせください。?/g,
    /他にも?気になること(?:が|や)あればお(?:聞かせ|知らせ)ください。?/g,
    /他にも?気になること(?:が|や)[^。\n]*お(?:聞かせ|知らせ)ください。?/g,
    /お話しされたいことがあれば[^。\n]*。/g,
    /何か(?:他に)?(?:ご)?質問があれば[^。\n]*。/g,
    /ほかに(?:ご)?不明な点があれば[^。\n]*。/g,
    /ほかにも?気になることがあれば[^。\n]*。/g,
    /他にご質問があれば[^。\n]*。/g,
    /何かございましたら[^。\n]*。/g,
    /気になることがあれば(?:遠慮なく)?お(?:聞かせ|申し付け|知らせ)ください。?/g,
    /お気軽にお聞かせください。?/g,
    /こちらでの受診をお考えの場合[^。\n]*。/g,
    /前の病院でのご経験について[^。\n]*。/g,
    /今後の改善につなげたいので[^。\n]*。?/g,
    /[^。\n]*具体的な状況を(?:お)?教えてください。?/g,
    /[^。\n]*詳しく(?:お)?教えてください。?/g,
    /[^。\n]*もう少し詳しく[^。\n]*。?/g,
    /[^。\n]*どのような状況(?:だった|でした)か[^。\n]*。?/g,
    /[^。\n]*詳細を(?:お)?聞かせください。?/g,
    /[^。\n]*詳細を(?:お)?教えてください。?/g,
    /[^。\n]*差し支えのない範囲でお聞かせ[^。\n]*。?/g,
    /[^。\n]*状況について(?:もう少し|詳しく|具体的に)[^。\n]*。?/g,
  ];
  for (const re of stripClosings) {
    s = s.replace(re, "");
  }
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 実施していない内容への質問は冒頭を「お礼→種別ごとの未実施文」に揃える */
function ensureNotOfferedThanksThenApology(text, userMessage, safeHistory) {
  if (shouldAddComplaintPrompt(userMessage, safeHistory)) return String(text || "");
  if (shouldAddOtherHospitalExperiencePrompt(userMessage, safeHistory)) {
    return String(text || "");
  }
  const hit = detectNotOfferedService(userMessage);
  if (!hit) return String(text || "");

  let s = flattenHtmlAnswerToPlain(text);
  const apology = hit.apologyLine;
  const stripOpenings = [
    /お問い合わせありがとうございます。?/g,
    /お問い合わせくださりありがとうございます。?/g,
    /ご質問ありがとうございます。?/g,
    /大変申し訳ございませんが、[^。\n]{1,80}。?/g,
    /申し訳ございませんが、[^。\n]{1,80}。?/g,
    /当院では[^。\n]{0,40}実施していません。?/g,
    /当院では[^。\n]{0,40}行っていません。?/g,
    /当院には[^。\n]{0,40}ございません。?/g,
    /日曜日は休診です。?/g,
    /祝日は休診です。?/g,
  ];
  for (const re of stripOpenings) {
    s = s.replace(re, "");
  }
  s = s.replace(/^[ \t\n]+/, "").replace(/\n{3,}/g, "\n\n").trim();

  const body = s ? `\n${s}` : "";
  return stripLeakedControlMarkup(`${NOT_OFFERED_THANKS}${apology}${body}`.trim());
}

function isInabilityApologyRest(rest) {
  return /(?:実施|行って|お取り|対応)してい?(?:ません|おりません)|ご要望に添え|お応えでき(?:ません|かね)|ご希望に添え/.test(
    String(rest || "")
  );
}

/**
 * 通常案内で誤って付いた「お礼→謝罪」を除去する。
 * クレーム／未実施ターンでは触らない。
 */
function stripMisplacedThanksApologyOnNormalQuestions(text, userMessage, safeHistory) {
  if (shouldAddComplaintPrompt(userMessage, safeHistory)) return String(text || "");
  if (detectNotOfferedService(userMessage)) return String(text || "");

  let s = String(text || "");
  if (!s.trim() || s.trimStart().startsWith(RICH_HTML_PREFIX)) return s;

  // クレーム用の定型お礼・謝罪が通常質問に混入した場合は除去
  s = s.replace(/状況についてご教示くださりありがとうございます。?/g, "");
  s = s.replace(
    /この度は、?ご不快な思いをおかけすることとなり、?改めてお詫び申し上げます。?/g,
    ""
  );
  s = s.replace(/ご指摘の点は真摯に受け止め[^。\n]*。?/g, "");
  s = s.replace(/今後の対応についても、?より安心していただけるよう努めてまいります。?/g, "");

  // 「お問い合わせありがとう。大変申し訳ございませんが、〜。」
  s = s.replace(
    /お問い合わせありがとうございます。\s*大変申し訳ございませんが、([^。\n]*)。/g,
    (full, rest) => {
      if (isInabilityApologyRest(rest)) return full;
      return `お問い合わせありがとうございます。${rest}。`;
    }
  );
  s = s.replace(
    /ご質問ありがとうございます。\s*大変申し訳ございませんが、([^。\n]*)。/g,
    (full, rest) => {
      if (isInabilityApologyRest(rest)) return full;
      return `ご質問ありがとうございます。${rest}。`;
    }
  );

  // 冒頭だけの「大変申し訳ございませんが、」＋案内できる内容
  s = s.replace(
    /(^|\n)大変申し訳ございませんが、([^。\n]*)。/g,
    (full, lead, rest) => {
      if (isInabilityApologyRest(rest)) return full;
      return `${lead}${rest}。`;
    }
  );

  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function stripBannedEmpathyPhrases(text) {
  let s = String(text || "");
  if (!s.trim()) return s;

  const patterns = [
    /[^。．\n<]*理解でき(?:ます|ました)[ね]?[^。．\n<]*[。．]?/g,
    /理解でき(?:ます|ました)[ね]?[。．]?/g,
    /[^。．\n<]*理解します[ね]?[^。．\n<]*[。．]?/g,
    /理解します[ね]?[。．]?/g,
    /[^。．\n<]*納得です[ね]?[^。．\n<]*[。．]?/g,
    /納得です[ね]?[。．]?/g,
    /[^。．\n<]*納得でき(?:ます|ました)[ね]?[^。．\n<]*[。．]?/g,
    /納得でき(?:ます|ました)[ね]?[。．]?/g,
    /[^。．\n<]*納得いたしました[^。．\n<]*[。．]?/g,
    /納得いたしました[。．]?/g,
    /[^。．\n<]*それは大変でしたね[。．]?/g,
    /それは大変でしたね[。．]?/g,
    /[^。．\n<]*大変でしたね[。．]?/g,
    /大変でしたね[。．]?/g,
    /[^。．\n<]*それはつらい(?:です|でした)ね[。．]?/g,
    /[^。．\n<]*お辛かったですね[。．]?/g,
    // 「アドバイス」および上から目線の助言調
    /[^。．\n<]*アドバイス[^。．\n<]*[。．]?/g,
    /アドバイス/g,
    /[^。．\n<]*お身体の状態や過去の状況[^。．\n<]*[。．]?/g,
    /[^。．\n<]*お身体の状態により[^。．\n<]*[。．]?/g,
    /[^。．\n<]*過去の状況により[^。．\n<]*[。．]?/g,
  ];
  for (const re of patterns) {
    s = s.replace(re, "");
  }
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function stripComplaintEmpathyPhrases(text, userMessage, safeHistory) {
  if (!shouldAddComplaintPrompt(userMessage, safeHistory)) return String(text || "");
  let s = String(text || "");
  const patterns = [
    /そのように感じられた[^。\n]*理解できます[^。\n]*。/g,
    /[^。\n]*理解できます[^。\n]*。/g,
    /そのように感じられたこと[^。\n]*もっともだと思います[^。\n]*。/g,
    /[^。\n]*もっともだと思います[^。\n]*。/g,
    /無理もないことだと思います[^。\n]*。/g,
    /[^。\n]*大切ですので[^。\n]*。/g,
    /ご不快な思いをされたのですね[^。\n]*。/g,
    /私たちのサービスが[^。\n]*。/g,
    /[^。\n]*期待に応えられなかった[^。\n]*。/g,
    /[^。\n]*残念です[^。\n]*。/g,
  ];
  for (const re of patterns) {
    s = s.replace(re, "");
  }
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

function finalizeAssistantAnswer(text, referencedPages, userMessage, safeHistory = []) {
  return stripMisplacedThanksApologyOnNormalQuestions(
    ensureNotOfferedThanksThenApology(
      ensureComplaintDetailAskClosing(
        ensureComplaintThanksThenApology(
          stripMisplacedKanaiApology(
            stripComplaintEmpathyPhrases(
              stripBannedEmpathyPhrases(
                stripIrrelevantModelClosing(
                  stripFalseReferenceLinkMention(
                    fixGoryoshoConnective(
                      stripNextActionLeadIn(
                        normalizeLegacyTwoLayerAnswer(text)
                      )
                    ),
                    referencedPages
                  )
                )
              ),
              userMessage,
              safeHistory
            ),
            userMessage,
            safeHistory
          ),
          userMessage,
          safeHistory
        ),
        userMessage,
        safeHistory
      ),
      userMessage,
      safeHistory
    ),
    userMessage,
    safeHistory
  );
}

function normalizeLegacyTwoLayerAnswer(text) {
  const raw = String(text || "").trim();
  const out = stripPromptingClosings(
    stripBannedEmpathyPhrases(
      stripLeakedControlMarkup(
        normalizeRichHtmlMarker(
          stripMarkdownLinksAndInlineKanaiUrls(
            stripOverDelegatingClosing(
              stripTrailingKanaiUrlBulletLines(normalizeLegacyTwoLayerAnswerCore(text))
            )
          )
        )
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
 * ※ create は writeHead より前に行い、API エラーを JSON で返せるようにする
 */
async function createOpenAIStream(openai, messages) {
  return openai.chat.completions.create(
    buildOpenAICompletionParams({ messages, stream: true })
  );
}

async function pipeOpenAIStreamNdjson(
  res,
  stream,
  userMessage,
  referencedPages,
  safeHistory = [],
  clientId = "anonymous",
  siteKnowledgeDebug = null
) {
  let fullAnswer = "";
  let finishReason = null;
  for await (const part of stream) {
    const choice = part.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta?.content || "";
    if (delta) {
      fullAnswer += delta;
      writeNdjsonLine(res, { type: "delta", text: delta });
    }
  }

  let trimmed = finalizeAssistantAnswer(
    fullAnswer.trim(),
    referencedPages,
    userMessage,
    safeHistory
  );
  if (!trimmed) {
    trimmed =
      finishReason === "length"
        ? "回答が長くなりすぎたため途中で止まりました。もう一度、短く質問してみてください。"
        : "すみません、うまく回答を生成できませんでした。もう一度お試しください。";
  }
  const now = new Date();
  console.log(
    "chat-log",
    JSON.stringify({
      ts: now.toISOString(),
      ts_jst: now.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }),
      clientId,
      user: userMessage,
      answer: trimmed,
      streamed: true,
      finishReason,
      model: OPENAI_MODEL,
      rawLen: fullAnswer.length,
    })
  );

  // ログ失敗で応答完了を止めない
  void appendChatLog({
    message: userMessage,
    answer: trimmed,
    clientId,
    meta: { streamed: true, finishReason, model: OPENAI_MODEL },
  }).catch((e) => {
    console.error("appendChatLog failed:", e?.message || e);
  });

  if (referencedPages && referencedPages.length > 0) {
    writeNdjsonLine(res, { type: "references", pages: referencedPages });
  }
  if (siteKnowledgeDebug) {
    writeNdjsonLine(res, { type: "siteKnowledgeDebug", debug: siteKnowledgeDebug });
  }
  writeNdjsonLine(res, { type: "done", text: trimmed });
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

    // デプロイ確認用（詳細は出さない）
    if (req.method === "GET") {
      const payload = {
        ok: true,
        hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
        hasChatApiSecret: Boolean(getChatApiSecret()),
        hasUpstashRateLimit: hasUpstashConfig,
        rateLimit: hasUpstashConfig ? "20 req / 60 s / IP" : "disabled (env missing)",
        hasSupabase: Boolean(
          process.env.SUPABASE_URL &&
            (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)
        ),
        hasResend: Boolean(process.env.RESEND_API_KEY),
        hasCronSecret: Boolean(process.env.CRON_SECRET),
      };
      if (shouldIncludeSiteKnowledgeDebug(req)) {
        payload.siteKnowledge = peekSiteKnowledgeStatus();
      }
      return res.status(200).json(payload);
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // ---- API シークレット（必須）----
    if (!getChatApiSecret()) {
      console.error("CHAT_API_SECRET is not configured");
      return res.status(500).json({
        answer: "API認証の設定が完了していません。管理者に連絡してください。",
        emergency: false,
        error: "Secret not configured",
      });
    }
    if (!isValidChatApiSecret(req)) {
      return res.status(401).json({
        answer: "認証に失敗したため送信できません。",
        emergency: false,
        error: "Unauthorized",
      });
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

    // シークレット検証済みのリクエストはサーバー間通信（PHPプロキシ）として扱う。
    // Origin はブラウザ直叩き対策だが、シークレット無しは上で 401 済みのためここでは見ない。
    // （プロキシ経由では Origin が無い／中継で想定外の値になることがある）

    const body = await readJsonBody(req);
    const userMessage = (body.message || "").trim();
    const wantStream = Boolean(body.stream);
    const history = body.history;
    const clientId = String(body.clientId || body.client_id || "").trim();
    if (!userMessage) {
      return res.status(400).json({ answer: "メッセージが空です。", emergency: false });
    }
    if (userMessage.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({
        answer: `メッセージが長すぎます。${MAX_MESSAGE_CHARS}文字以内で入力してください。`,
        emergency: false,
        error: "Message too long",
      });
    }

    // 危険サインはモデルに投げずに即時誘導（安全のため）
    if (detectEmergency(userMessage)) {
      const answer = emergencyMessage();
      await appendChatLog({
        message: userMessage,
        answer,
        clientId,
        meta: { emergency: true },
      });
      return res.status(200).json({ answer, emergency: true });
    }

    const openai = getOpenAIClient();
    if (!openai) {
      console.error("OPENAI_API_KEY is not configured");
      return res.status(500).json({
        answer: "AI連携の設定が完了していません。管理者に連絡してください。",
        emergency: false,
      });
    }

    const safeHistory = sanitizeHistory(history);

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
          clientId,
          user: userMessage,
          answer,
          instantGreeting: true,
        })
      );
      await appendChatLog({
        message: userMessage,
        answer,
        clientId,
        meta: { instantGreeting: true },
      });
      return res.status(200).json({ answer, emergency: false, instantGreeting: true });
    }

    let clinicSnippet = ""; // 公式サイト抜粋
    let registeredClinicPrompt = ""; // 院内登録情報（clinic-knowledge）
    let referencedPages = [];
    let knowledgeConfidence = "none";
    let siteKnowledgeDebug = null;
    let fetchedSourceChunks = [];
    let clinicKnowledgeHits = [];
    let clinicKnowledgeStrong = false;
    let clinicTopScore = 0;
    let clinicDetectedIntent = null;
    let clinicNormalizedQuery = "";
    let clinicRejected = [];
    let evidenceUrls = [];
    let chipUrls = [];
    let siteKnowledgeSearched = false;
    const metaChatHit = detectMetaChatQuery(userMessage);
    const notOfferedHit = metaChatHit ? null : detectNotOfferedService(userMessage);
    const clinicFactual =
      !metaChatHit && isClinicSpecificFactualQuery(userMessage, safeHistory);
    const forceRefresh = shouldForceSiteKnowledgeRefresh(req);
    const includeDebug = shouldIncludeSiteKnowledgeDebug(req);
    const queryCategory = metaChatHit
      ? "meta_chat"
      : notOfferedHit
        ? "not_offered"
        : clinicFactual
          ? "clinic_factual"
          : "general";

    // 2) clinic-knowledge 検索（緊急判定の後・公式サイト検索の前）
    //    メタ質問では検索しない
    if (!casualGreetingOnly && !metaChatHit) {
      try {
        const ck = await searchClinicKnowledge(userMessage, { forceRefresh });
        clinicKnowledgeHits = ck.hits || [];
        clinicTopScore = ck.topScore || 0;
        clinicDetectedIntent = ck.detectedIntent || detectClinicIntent(userMessage);
        clinicNormalizedQuery = ck.normalizedQuery || "";
        clinicRejected = ck.rejected || [];
        clinicKnowledgeStrong =
          Boolean(ck.strong) ||
          isClinicKnowledgeStrong(clinicTopScore, clinicKnowledgeHits);
        registeredClinicPrompt = buildClinicRegisteredKnowledgePrompt(clinicKnowledgeHits);
        if (includeDebug) {
          siteKnowledgeDebug = {
            ...(siteKnowledgeDebug || {}),
            clinicKnowledge: {
              source: ck.source,
              topScore: clinicTopScore,
              strong: clinicKnowledgeStrong,
              detectedIntent: clinicDetectedIntent,
              normalizedQuery: clinicNormalizedQuery,
              hits: clinicKnowledgeHits.map((h) => ({
                id: h.item.id,
                category: h.item.category,
                intent: h.item.intent || null,
                score: h.score,
                reasons: h.reasons,
                updatedAt: h.item.updatedAt,
                sourceType: "clinic_registered",
              })),
              rejected: clinicRejected,
              status: peekClinicKnowledgeStatus(),
            },
          };
        }
      } catch (e) {
        console.error("clinic-knowledge search failed:", e?.message || e);
      }
    }

    // 3) 公式サイト検索（メタ質問では実行しない）
    const shouldFetchWebKnowledge =
      !metaChatHit &&
      !casualGreetingOnly &&
      (!SITE_KNOWLEDGE_GATED ||
        clinicFactual ||
        Boolean(notOfferedHit) ||
        clinicKnowledgeHits.length > 0);

    if (shouldFetchWebKnowledge) {
      siteKnowledgeSearched = true;
      const attendFocused = isAttendFocusedQuery(userMessage);
      const meetingFocused = isMeetingFocusedQuery(userMessage);

      const {
        snippet: webSnippet,
        sourceChunks,
        confidence,
        debug,
        evidenceUrls: siteEvidence = [],
        chipUrls: siteChips = [],
      } = await getSiteKnowledgeSnippetSupplement(userMessage, {
        forceRefresh,
        includeDebug,
        clinicKnowledgeStrong,
      });
      fetchedSourceChunks = sourceChunks || [];
      knowledgeConfidence = confidence || (webSnippet ? "low" : "none");
      evidenceUrls = siteEvidence || [];
      chipUrls = siteChips || [];
      if (includeDebug && debug) {
        siteKnowledgeDebug = { ...(siteKnowledgeDebug || {}), ...debug };
      }

      // clinic強ヒット時: サイトは補助。根拠に足るURLが無ければ抜粋も渡さない
      if (clinicKnowledgeStrong && !evidenceUrls.length) {
        clinicSnippet = "";
        knowledgeConfidence = "none";
        chipUrls = [];
      } else if (webSnippet && knowledgeConfidence !== "none") {
        clinicSnippet = webSnippet;
      }

      // チップは evidence 由来のみ（検索候補の流用禁止）
      if (attendFocused && clinicSnippet && !clinicKnowledgeStrong) {
        referencedPages = [
          { url: ATTEND_INFO_PAGE_URL, title: "立ち会い分娩について" },
        ];
        chipUrls = referencedPages.map((p) => ({
          ...p,
          score: 999,
          reason: "立ち会い専用",
        }));
        evidenceUrls = chipUrls;
      } else if (meetingFocused && clinicSnippet && !clinicKnowledgeStrong) {
        referencedPages = [
          { url: MEETING_INFO_PAGE_URL, title: "面会について" },
        ];
        chipUrls = referencedPages.map((p) => ({
          ...p,
          score: 999,
          reason: "面会専用",
        }));
        evidenceUrls = chipUrls;
      } else {
        referencedPages = (chipUrls || []).map((c) => ({
          url: c.url,
          title: c.title,
        }));
      }

      if (clinicSnippet.length > SITE_SNIPPET_MAX_CHARS) {
        clinicSnippet =
          clinicSnippet.slice(0, SITE_SNIPPET_MAX_CHARS) +
          "\n\n（以降、文字数制限のため省略しました）";
      }
    }

    // clinic-knowledgeのみ根拠 / メタ質問 → チップなし
    if (metaChatHit || (clinicKnowledgeStrong && !evidenceUrls.length)) {
      referencedPages = [];
      chipUrls = [];
      if (metaChatHit) {
        clinicSnippet = "";
        registeredClinicPrompt = "";
        knowledgeConfidence = "none";
      }
    }

    // 固定ルール回答時: 根拠にしていないURLはチップに出さない
    // 話題一致ページが無い場合はサイト抜粋も渡さない（無関係なお知らせの混入防止）
    if (notOfferedHit) {
      referencedPages = filterReferencedPagesForNotOffered(
        notOfferedHit,
        fetchedSourceChunks,
        referencedPages
      );
      if (!referencedPages.length) {
        clinicSnippet = "";
        knowledgeConfidence = "none";
      } else {
        // 一致ページの本文だけを根拠として残す
        const allow = new Set(referencedPages.map((p) => String(p.url || "").split("#")[0]));
        const related = (fetchedSourceChunks || []).filter((c) =>
          allow.has(String(c.url || "").split("#")[0])
        );
        if (related.length) {
          clinicSnippet = [
            "【当院公式サイトからの抜粋（固定ルール対象に関連するページのみ）】",
            ...related.map(
              (c) =>
                `【${c.title || c.url}】\nURL: ${c.url}\n${c.lastmod ? `更新: ${c.lastmod}\n` : ""}${c.text}`
            ),
          ].join("\n\n");
          if (clinicSnippet.length > SITE_SNIPPET_MAX_CHARS) {
            clinicSnippet =
              clinicSnippet.slice(0, SITE_SNIPPET_MAX_CHARS) +
              "\n\n（以降、文字数制限のため省略しました）";
          }
        } else {
          clinicSnippet = "";
        }
      }
      const conflict = detectFixedRuleConflict(notOfferedHit, fetchedSourceChunks);
      if (conflict) {
        console.warn("fixed_rule_conflict", JSON.stringify(conflict));
        if (includeDebug) {
          siteKnowledgeDebug = {
            ...(siteKnowledgeDebug || {}),
            fixed_rule_conflict: conflict,
          };
        }
      } else if (includeDebug) {
        siteKnowledgeDebug = {
          ...(siteKnowledgeDebug || {}),
          fixed_rule_conflict: null,
        };
      }
    }

    const knowledgeHitScore =
      registeredClinicPrompt || clinicSnippet || referencedPages.length > 0 ? 20 : 0;
    if (shouldSuppressReferencePages(userMessage, safeHistory, knowledgeHitScore)) {
      if (
        !clinicKnowledgeStrong &&
        (isAttendFocusedQuery(userMessage) || isMeetingFocusedQuery(userMessage))
      ) {
        referencedPages = finalizeReferencedPages(referencedPages, userMessage);
      } else {
        referencedPages = [];
      }
    } else if (!notOfferedHit) {
      referencedPages = finalizeReferencedPages(referencedPages, userMessage);
    } else {
      referencedPages = referencedPages.slice(0, MAX_REFERENCE_CHIPS);
    }
    referencedPages = await filterPagesBySitemap(referencedPages);

    // clinic強ヒットかつサイト根拠なし → 再確認してチップを消す
    if (metaChatHit || (clinicKnowledgeStrong && !clinicSnippet)) {
      referencedPages = [];
    }

    // チップ最終ガード（質問関連性）
    const chipGuard = guardReferenceChipsByQuestion(referencedPages, userMessage, {
      metaChat: Boolean(metaChatHit),
      clinicOnly: clinicKnowledgeStrong && !clinicSnippet,
      notOfferedOnly: Boolean(notOfferedHit) && !clinicSnippet && !registeredClinicPrompt,
    });
    referencedPages = chipGuard.pages;

    if (includeDebug) {
      siteKnowledgeDebug = {
        ...(siteKnowledgeDebug || {}),
        queryCategory,
        metaChat: metaChatHit || null,
        siteKnowledgeSearched,
        evidenceUrls,
        chipUrls: referencedPages.map((p) => ({
          url: p.url,
          title: p.title,
          reason:
            chipUrls.find((c) => c.url === p.url)?.reason ||
            (clinicKnowledgeStrong
              ? "clinic併用の公式根拠"
              : "evidence採用"),
        })),
        excludedUrls: [
          ...((siteKnowledgeDebug && siteKnowledgeDebug.excludedUrls) || []),
          ...chipGuard.excluded,
        ].slice(0, 50),
        chipDecision: {
          clinicKnowledgeStrong,
          clinicTopScore,
          siteEvidenceCount: evidenceUrls.length,
          finalChipCount: referencedPages.length,
          siteKnowledgeSearched,
          queryCategory,
          note: metaChatHit
            ? "meta_chat→サイト検索なし・チップなし"
            : clinicKnowledgeStrong
              ? evidenceUrls.length
                ? "clinic-knowledge優先＋公式サイト根拠あり→根拠URLのみチップ"
                : "clinic-knowledgeのみ根拠→チップなし"
              : "通常のサイト根拠チップ選定",
        },
      };
    }

    // WEB予約可否: 変更・キャンセル情報で穴埋めしない。根拠が無ければ定型回答。
    const webReserveAvailIntent =
      clinicDetectedIntent === "web_reservation_availability";
    const webReserveHasClinic = clinicKnowledgeHits.some(
      (h) => h.item?.intent === "web_reservation_availability"
    );
    const webReserveHasSite = siteMentionsWebReservationAvailability(clinicSnippet);
    if (webReserveAvailIntent && !webReserveHasClinic && !webReserveHasSite) {
      const answer = WEB_RESERVATION_NO_INFO_ANSWER;
      if (includeDebug) {
        siteKnowledgeDebug = {
          ...(siteKnowledgeDebug || {}),
          detectedIntent: clinicDetectedIntent,
          normalizedQuery: clinicNormalizedQuery,
          matchedClinicKnowledge: [],
          rejectedKnowledge: clinicRejected,
          webReservationAvailability: {
            hasClinic: false,
            hasSite: false,
            action: "fixed_no_info",
          },
        };
      }
      await appendChatLog({
        message: userMessage,
        answer,
        clientId,
        meta: {
          intent: clinicDetectedIntent,
          webReservationNoInfo: true,
        },
      });
      const payload = {
        answer,
        emergency: false,
        referencedPages: [],
      };
      if (includeDebug) {
        payload.debug = siteKnowledgeDebug;
        payload.detectedIntent = clinicDetectedIntent;
        payload.normalizedQuery = clinicNormalizedQuery;
        payload.matchedClinicKnowledge = [];
        payload.rejectedKnowledge = clinicRejected;
      }
      return res.status(200).json(payload);
    }
    if (webReserveAvailIntent && webReserveHasSite && !webReserveHasClinic) {
      // 予約変更・キャンセルの院内登録が混ざらないようクリア済み想定。サイト可否のみ使う。
      registeredClinicPrompt = "";
    }

    const needNoEvidencePrompt =
      !metaChatHit &&
      clinicFactual &&
      !clinicSnippet &&
      !registeredClinicPrompt &&
      !notOfferedHit;

    const tokyoDatetimePrompt = buildTokyoDatetimeSystemPrompt(userMessage);
    const reservationIntentGuard =
      webReserveAvailIntent && (webReserveHasClinic || webReserveHasSite)
        ? [
            {
              role: "system",
              content: [
                "【このターン：WEB予約の可否】",
                "ユーザーはWEB予約ができるかどうかを尋ねています（否定疑問も含む）。",
                "予約変更期限・キャンセル手順・前日08:00／14:00などの変更専用情報は使わないでください。",
                "渡された抜粋に書かれたWEB予約の可否・対象（初診/再診など）だけを案内してください。",
              ].join("\n"),
            },
          ]
        : clinicDetectedIntent === "reservation_change"
          ? [
              {
                role: "system",
                content:
                  "【このターン：予約変更】予約変更の期限・方法だけを案内し、WEB予約の可否一般論で薄めないでください。",
              },
            ]
          : clinicDetectedIntent === "reservation_cancel"
            ? [
                {
                  role: "system",
                  content:
                    "【このターン：予約キャンセル】キャンセル手順だけを案内してください。",
                },
              ]
            : [];

    const messages = [
      { role: "system", content: SYSTEM },
      ...(tokyoDatetimePrompt
        ? [{ role: "system", content: tokyoDatetimePrompt }]
        : []),
      ...reservationIntentGuard,
      // 院内登録情報（公式サイトより優先）→ 公式サイト抜粋の順で渡す
      ...(registeredClinicPrompt
        ? [{ role: "system", content: registeredClinicPrompt }]
        : []),
      ...(clinicSnippet
        ? [
            {
              role: "system",
              content: clinicSnippet,
            },
          ]
        : needNoEvidencePrompt
          ? [{ role: "system", content: PROMPT_NO_CLINIC_EVIDENCE }]
          : []),
      {
        role: "system",
        content: buildReferenceLinksSystemPrompt(referencedPages),
      },
      ...(shouldForceRichHtmlForMessage(userMessage, safeHistory) &&
      !notOfferedHit &&
      (clinicSnippet || registeredClinicPrompt)
        ? [{ role: "system", content: RICH_HTML_THIS_TURN }]
        : []),
      ...(metaChatHit
        ? [{ role: "system", content: PROMPT_META_CHAT }]
        : shouldAddOtherHospitalExperiencePrompt(userMessage, safeHistory)
          ? [{ role: "system", content: PROMPT_OTHER_HOSPITAL_EXPERIENCE }]
          : shouldAddComplaintPrompt(userMessage, safeHistory)
            ? [{ role: "system", content: PROMPT_COMPLAINT }]
            : notOfferedHit
              ? [
                  {
                    role: "system",
                    content: buildNotOfferedPrompt(notOfferedHit),
                  },
                ]
              : shouldAddShortBackchannelPrompt(userMessage, safeHistory)
                ? [{ role: "system", content: PROMPT_SHORT_BACKCHANNEL }]
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
      let stream;
      try {
        stream = await createOpenAIStream(openai, messages);
      } catch (createErr) {
        console.error("openai stream create error:", createErr?.message || createErr);
        const status = createErr?.status || createErr?.statusCode || 500;
        const msg = String(createErr?.message || "");
        let answer = "サーバ側でエラーが発生しました。時間をおいて再度お試しください。";
        if (status === 401 || /incorrect api key|invalid api key/i.test(msg)) {
          answer =
            "AIサービスの認証に失敗しました。本番環境の OPENAI_API_KEY をダッシュボードで確認してください。";
        } else if (status === 404 || /model_not_found|does not exist|model/i.test(msg)) {
          answer = `AIモデル「${OPENAI_MODEL}」が利用できません。Vercel の OPENAI_MODEL を確認してください。`;
        } else if (/max_tokens|max_completion_tokens|reasoning_effort|unsupported parameter/i.test(msg)) {
          answer =
            "AIへのリクエスト形式がモデルと合いません。管理者が OPENAI_MODEL 等を確認してください。";
        }
        return res.status(status >= 400 && status < 600 ? status : 500).json({
          answer,
          emergency: false,
          error: msg.slice(0, 200),
        });
      }

      try {
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
        });
        await pipeOpenAIStreamNdjson(
          res,
          stream,
          userMessage,
          referencedPages,
          safeHistory,
          clientId,
          siteKnowledgeDebug
        );
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

    const completion = await openai.chat.completions.create(
      buildOpenAICompletionParams({ messages, stream: false })
    );

    const raw =
      (completion.choices[0]?.message?.content || "").trim() ||
      "すみません、うまく回答を生成できませんでした。";
    const answer = finalizeAssistantAnswer(raw, referencedPages, userMessage, safeHistory);

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
        clientId,
        user: userMessage,
        answer,
      })
    );
    await appendChatLog({
      message: userMessage,
      answer,
      clientId,
    });

    const payload = { answer, emergency: false, referencedPages };
    if (siteKnowledgeDebug) {
      payload.siteKnowledgeDebug = siteKnowledgeDebug;
      payload.knowledgeConfidence = knowledgeConfidence;
    }
    if (includeDebug) {
      payload.detectedIntent = clinicDetectedIntent;
      payload.normalizedQuery = clinicNormalizedQuery;
      payload.matchedClinicKnowledge = clinicKnowledgeHits.map((h) => ({
        id: h.item.id,
        intent: h.item.intent || null,
        score: h.score,
        reasons: h.reasons,
      }));
      payload.rejectedKnowledge = clinicRejected;
    }
    return res.status(200).json(payload);
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