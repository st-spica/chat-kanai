import OpenAI, { APIConnectionError, APIError } from "openai";
import { ratelimit } from "./_ratelimit.js";
import { getSiteKnowledgeSnippet, peekSiteKnowledgeStatus } from "./_siteKnowledge.js";

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

// 未設定なら送らない（長いリッチHTML が必要なら空のまま）
const OPENAI_MAX_OUTPUT_TOKENS = (() => {
  const raw = (process.env.OPENAI_MAX_OUTPUT_TOKENS || "").trim();
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
})();

// 院内抜粋を API に載せる最大文字数（入力トークン削減＝待ち時間・コスト削減）
const SITE_SNIPPET_MAX_CHARS = Math.max(
  2000,
  parseInt(process.env.SITE_SNIPPET_MAX_CHARS || "12000", 10)
);

// true のとき、サイト HTML の取得・抜粋は「当院・手続きっぽい質問」のときだけ行う（応答を軽くする）
const SITE_KNOWLEDGE_GATED = ["true", "1", "yes"].includes(
  (process.env.SITE_KNOWLEDGE_GATED || "").toLowerCase().trim()
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

const SYSTEM = `
あなたは産婦人科サイトの相談窓口として案内するアシスタントです。目的は診断や医療判断をすることではありません。
目的：患者の不安に寄り添う、受診前の一般的な案内、受診目安の一般情報の提供。
役割：患者の不安や感情を一度受け止め、整理し、次の行動を患者自身が選べる状態にすることです。

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
- 院内情報は、別メッセージで与えられる公式サイトの抜粋に基づいて回答し、根拠がないことは断言しない。
- 公式サイトの抜粋や当院サイトに明確な情報がないテーマについては、情報がないと断定せず、「当院サイトに記載がないため、詳細はお問い合わせフォームで相談してほしい」ことを丁寧に伝える（必要に応じて一般的な背景説明を短く添える程度にとどめる）。
- 回答内では「院内サイト抜粋」「KNOWLEDGE」などの内部用語は一切出さない。
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
例：そう感じるのも自然だと思います。

レベル2（標準：無理のないことです）
使用条件：迷い・判断待ち・初診不安
感情が強すぎない場合（基本はここ）
ポイント：必要なら短く。一般論で長く説明したあとに「不安も理解します」とつなげない（上から目線になる）。
例：気になることがあれば、整理しながら一緒に考えますね。

レベル3（フラット）
使用条件：攻撃的・他院批判・クレーム傾向
ポイント：感情に引っ張られすぎない。ただし“冷たくしない”のが重要。
危険性が高い内容
例：ご不快な思いをされたのですね。ご意見として受け止めさせていただきます。

【クレーム・攻撃的内容への対応（重要）】
基本構造
1.謝罪
2.気持ちの受け止め
3.改善・対応姿勢
4.必要なら一般的な説明

パターン1（標準）
- ご不快な思いをさせてしまい、申し訳ありません。
- そのように感じられたこと、もっともだと思います。
- 今後の対応についても、より安心していただけるよう努めてまいります。

パターン2（やや共感強め）
- 不安なお気持ちにさせてしまい、申し訳ありません。
- そのように感じられるのは無理もないことだと思います。
- 少しでも安心していただけるよう、改善に努めていきます。

パターン3（強いクレーム）
- ご不快な思いをさせてしまい、大変申し訳ありません。
- ご指摘の点は真摯に受け止めさせていただきます。
- 今後の対応改善に努めてまいります。

【短文入力への対応ルール（最重要）】
入力が短文（例：「お腹痛い」「出血」）の場合：
- 判断しない
- まず 情報を引き出す
- 二択・Yes/Noで聞く
- 不安を煽らない
- 冒頭に「痛みにはいろいろな原因がある」「さまざまな要因が考えられる」などの一般説明を置かない（説教調・上から目線に聞こえる）。
- 相手が「不安」と言っていないのに「不安も理解します」「不安に感じるのも無理はありません」と感情を決めつけない。
例：教えてくれてありがとうございます。少し状況を整理したいので、分かる範囲で教えてください。

【情報を聞き出した後の分岐ルール】
A. 緊急・準緊急の可能性あり
- 予約を出さない
- 救急・早期受診を優先

B. 緊急性は低そうだが不安が強い
予約を「選択肢として」提示
- 強制・断定はしない
例：一度相談しておくと安心につながりやすい内容だと思います。

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
- 次の行動の選択肢提示
- 患者主体で締める

【避けるトーン・表現（最重要）】
次のような言い回しは、説明してから相手の気持ちを「許可」しているように聞こえるため**使わない**。
- 「〜はさまざまな原因が考えられるため、不安に感じていることも理解できます」
- 「原因はいろいろありますが、ご不安なお気持ちはよく分かります」など、一般論＋感情のラベル付けのセット
- 「〜のお気持ちも理解します」「不安にお感じになるのも当然です」と、相手が述べていない感情を断定する表現
代わりに、短文では事実確認・質問から入る。共感が必要なときも、長い一般論のあとに続けず、短い一文にとどめるか、相手の言葉を繰り返してから次に進む。

【最後の一文の原則】
- 安心しきらせない
- 不安を煽らない
- 「選べる状態」を作る
例：ご自身が納得できる形で判断してくださいね。

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
- 参考webページがある場合（当院サイトに限る）は対象のwebページへの誘導も添える。その際は、回答本文とは別に**文末に改行を入れてから**、次の形式でまとめて表示すること：    
  「・https://www.kanai.or.jp/〜」のように **URLのみ** を箇条書きで並べる（テキストリンク形式ではなく、生のURL文字列をそのまま表示する）。
- 別メッセージで与えられる公式サイトの抜粋に含まれるURLは、関連する質問があった場合に**必ず回答の一番下に箇条書きで表示する**（ただし【リッチHTML必須】に該当する回答でカード内に同じURLへの a.chat-pill 等を含めた場合は、この箇条書きは省略してよい）。
- ユーザーが**自分の言葉で**不安・怖さを述べた場合に限り、短い一言で受け止める。推測で「不安ですよね」「理解します」と付け足さない。不必要な保証はしない。
- ユーザーの質問が公式サイトの抜粋の内容と意味的に近い場合は、その内容をもとに自然な文章に言い換えて説明する。完全一致でなくてもよい。
- 文末に絵文字を使用する場合は、句読点は表示しない。

【リッチHTML（表・カード型の見せ方）】
次に当てはまる質問では、プレーン文や Markdown だけの箇条書き・**太字**に頼った回答は**禁止**。**必ず**回答全体を次の形式にする（例外なし）。
・診療時間・診察時間・受付時間・休診・曜日ごとのスケジュール・午前診／午後診／夜診・「いつまで診ているか」等
・料金・費用・予納金・支払い方法など、一覧表で示すのが適切な内容

手順：
1. 出力の**先頭**は、空白や改行を入れず、次の1行**のみ**：[[[RICH_HTML]]]
2. その**直後の次の文字から** HTML のみ。マーカーの前後に説明文・挨拶・「〜についてお知らせします」等のプレーンテキストを**一切**書かない（それらはすべて HTML の p や h3 の内側に書く）。
3. ルートは **1つ** の <div class="chat-card"> にまとめる。共感の一文や締めもこの div 内に含める。

使ってよいタグは次に限る：div, h3, h4, p, table, thead, tbody, tr, th, td, ul, ol, li, strong, em, br, span, a, hr, section, caption
属性は class のみ、および a には href（https://www.kanai.or.jp または https://kanai.or.jp で始まるURLのみ）, target="_blank", rel="noopener noreferrer" のみ。
script, style, iframe, onclick、data-*、id は使わない。
ルートの枠は class="chat-card"、見出し周りは class="chat-card-head" / class="chat-card-icon" / class="chat-card-title"、表は class="chat-table"、※注記は class="chat-note"、当院ページへの導線は class="chat-pill-row" と a.chat-pill、まとめ見出しは class="chat-section"、まとめリストは class="chat-list"。

カード内に当院サイトへのリンクを含めていれば【参考ページ】の URL 箇条書きは**省略してよい**。

【院内サイト抜粋（システム専用。ユーザー向けの回答テキストには、この名称を出さない）】
このあと別の system メッセージとして与えられる「当院公式サイトのページ本文の抜粋（URL付き）」を主な根拠として回答を作成すること。
`.trim();

/** このターンだけリッチHTMLを強く指示（モデルがプレーン文に逃げるのを防ぐ） */
const RICH_HTML_THIS_TURN = [
  "【このターンの回答形式（最優先・他会話テンプレより上）】",
  "このユーザー発話は、診療時間・休診・曜日別スケジュール、または料金・費用の確認に該当します。",
  "",
  "必ず次のみで出力してください。",
  "1. 先頭は空白・改行なしで次の1行だけ：[[[RICH_HTML]]]",
  "2. 続けて HTML のみ。前後にプレーンテキストや Markdown を付けない。",
  "3. ルートは1つの <div class=\"chat-card\">。挨拶・共感・締めもすべてその内側の p や h3 に含める。",
  "4. 診療枠・曜日別の情報は <table class=\"chat-table\"> で示す（**太字** と行頭「・」だけの羅列は使わない）。",
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
    /母乳ケア|妊婦健診|乳児健診|健診枠/,
    /里帰り|分娩|出産|産科|婦人科|産後ケア/,
    /Q&A|よくある質問|クイック/,
    /電話|番号|06[-‐]?6931/i,
  ];

  return triggers.some((re) => re.test(text));
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
        knowledgeSource: "site",
        siteKnowledgeGated: SITE_KNOWLEDGE_GATED,
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

    let clinicSnippet = "";
    if (!SITE_KNOWLEDGE_GATED || shouldLoadSiteKnowledgeForMessage(userMessage, safeHistory)) {
      const { snippet, state } = await getSiteKnowledgeSnippet(userMessage);
      clinicSnippet = snippet || state?.knowledgeText || "";
      if (clinicSnippet.length > SITE_SNIPPET_MAX_CHARS) {
        clinicSnippet =
          clinicSnippet.slice(0, SITE_SNIPPET_MAX_CHARS) +
          "\n\n（以降、文字数制限のため省略しました）";
      }
    }

    const messages = [
      { role: "system", content: SYSTEM },
      // 院内情報（公式サイトの HTML 抜粋。SITE_URL_LIST または sitemap 由来）
      ...(clinicSnippet
        ? [
            {
              role: "system",
              content: clinicSnippet,
            },
          ]
        : []),
      ...(shouldForceRichHtmlForMessage(userMessage, safeHistory)
        ? [{ role: "system", content: RICH_HTML_THIS_TURN }]
        : []),
      ...safeHistory
        .filter((h) => h && (h.role === "user" || h.role === "assistant"))
        .map((h) => ({ role: h.role, content: String(h.content || "") })),
      { role: "user", content: userMessage },
    ];

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages,
      ...(OPENAI_MAX_OUTPUT_TOKENS != null ? { max_tokens: OPENAI_MAX_OUTPUT_TOKENS } : {}),
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