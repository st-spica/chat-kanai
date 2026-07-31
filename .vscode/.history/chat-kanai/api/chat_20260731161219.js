import OpenAI, { APIConnectionError, APIError } from "openai";
import { ratelimit, hasUpstashConfig } from "./_ratelimit.js";
import { appendChatLog } from "./_chatLog.js";
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
  "https://kanailc.xbiz.jp",
  "https://www.kanailc.xbiz.jp",
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
- 院内情報は、別メッセージで与えられる院内FAQ（JSON）および必要時の公式サイト抜粋に基づいて回答し、根拠がないことは断言しない。
- 公式サイトの抜粋や当院サイトに明確な情報がないテーマについては、情報がないと断定せず、「当院サイトに記載がないため、詳細は電話で相談してほしい」ことを丁寧に伝える（必要に応じて一般的な背景説明を短く添える程度にとどめる）。
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
例：それは不安になりますよね。

レベル2（標準：無理のないことです）
使用条件：迷い・判断待ち・初診不安
感情が強すぎない場合（基本はここ）
ポイント：軽く寄り添いを残す。必要なら短く。一般論＋相手の状況の両方に触れる。一般論で長く説明したあとに「不安も理解します」とつなげない（上から目線になる）。
例：気になる点があると、不安になりますよね。

レベル3（フラット）
使用条件：攻撃的・他院批判・クレーム傾向
ポイント：謝罪から入り、共感文は書かない。短く事務的に受け止めと改善姿勢を伝える。
例：ご不快な思いをさせてしまい、大変申し訳ありません。ご指摘の点は真摯に受け止めます。今後の対応についても、より安心していただけるよう努めてまいります。

【クレーム・攻撃的内容への対応（重要）】
・共感文は書かない（「理解できます」「もっともだと思います」「無理もないことだと思います」「そのように感じられた」等は禁止）。
・上から目線の言い回しも書かない（「期待に応えられなかった」「残念です」「私たちのサービス」等は禁止）。
・基本は3文構成：（1）謝罪「ご不快な思いをさせてしまい、大変申し訳ありません。」（2）ご指摘の受け止め（3）改善姿勢（例：「今後の対応についても、より安心していただけるよう努めてまいります。」）。
・感情の代弁、講義調（「〜は大切ですので」）、長い気持ちの受け止めは書かない。
・**当院へのクレームのときだけ**上記の謝罪・改善姿勢を使う。「前の病院」「別の病院」「以前の病院」など**他院での経験**を話しているときは、当院への謝罪や「今後の対応改善」は書かない（話の辻褄が合わない）。

【他院・以前の病院での経験について】
ユーザーが当院以外（前の病院・別の病院等）での出来事や不安を話している場合：
・当院への謝罪（「ご不快な思いをさせてしまい、申し訳ありません」等）は書かない。
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
- 「〜はさまざまな原因が考えられるため、不安に感じていることも理解できます」
- 「原因はいろいろありますが、ご不安なお気持ちはよく分かります」など、一般論＋感情のラベル付けのセット
- 「〜のお気持ちも理解します」「不安にお感じになるのも当然です」と、相手が述べていない感情を断定する表現
- 「次にどうするかは、あなた自身が選べる状態を大切にしていただきたいです。どのように進めていくのか考えてみることも良いですね。」のような、患者に判断を丸投げする締め
- 「どのように進めるか、あなた自身で考えられることができると良いですね。」のような、上から目線・丸投げに聞こえる締め
- 「あなたの安心につながると良いですね。」「〜と良いですね。」のように、相手の気持ちや状態を他人事のように眺めて締める表現（距離感が遠く、窓口スタッフが口頭で言わない）
- 「なたの〜」「ご安心に〜」など、主語や語尾が崩れたままの定型締め
代わりに、短文では事実確認・質問から入る。共感が必要なときも、長い一般論のあとに続けず、短い一文にとどめるか、相手の言葉を繰り返してから次に進む。

【最後の一文の原則】
- 安心しきらせない
- 不安を煽らない
- 「選べる状態」を作る

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
- 当院ページへの案内は、画面下の**参照リンク（チップ）**に任せる。**回答本文に URL を書かない**（https://www.kanai.or.jp/... の列挙・埋め込みは禁止）。
- **Markdownリンク [ページ名](URL) は禁止**。ページ名だけ書く（例：産後ケアページ。角括弧・URL・括弧は付けない）。
- 悪い例：「当院の[産後ケアページ](https://www.kanai.or.jp/aftercare/)をご確認ください。」
- 良い例：「詳しいコースや料金については、産後ケアページの内容を画面下の参照リンクからご確認ください。」
- **「画面下の参照リンク」**は、別メッセージ【このターンの参照リンク】でページが列挙されているときだけ案内する。列挙がないときは書かない（お問い合わせフォームやお電話など具体名で案内する）。
- ユーザーが**自分の言葉で**不安・怖さを述べた場合に限り、短い一言で受け止める。推測で「不安ですよね」「理解します」と付け足さない。不必要な保証はしない。
- ユーザーの質問が公式サイトの抜粋の内容と意味的に近い場合は、その内容をもとに自然な文章に言い換えて説明する。完全一致でなくてもよい。
- 文末に絵文字を使用する場合は、句読点は表示しない。

【日本語の自然さルール（全回答で必須）】
- 最終出力の前に、必ず「病院窓口スタッフがそのまま口頭で言って自然か」を自己チェックし、不自然なら書き直してから出力する。
- 1文を長くしすぎない。読点「、」が3つ以上続く文は分割する。
- 「〜については」「〜に関しては」を1文内で重ねない。必要なら1回までにする。
- 抽象語だけで終わらない。「詳細」「利用方法」「注意点」などの語を使うときは、案内先を明示する（参照リンクが表示される場合は画面下の参照リンク、表示されない場合はお問い合わせフォームや電話など具体名）。
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
このあと別の system メッセージとして与えられる「院内FAQ（JSON）」および必要時の「当院公式サイトのページ本文の抜粋（URL付き）」を主な根拠として回答を作成すること。両方ある場合は FAQ を優先し、サイト抜粋は補足として使う。
- ユーザー発話に「面会」が含まれるときは、そのターンの抜粋は**面会のお知らせページ（${MEETING_INFO_PAGE_URL}）の内容のみ**である。他の院内ページの情報や推測を混ぜない。
- ユーザー発話に「立ち会い」が含まれるときは、そのターンの抜粋は**立ち会い分娩ページ（${ATTEND_INFO_PAGE_URL}）の内容のみ**である。他の院内ページの情報や推測を混ぜない。
- ユーザー発話に「面会」が含まれるときは、そのターンの抜粋は**面会のお知らせページ（${MEETING_INFO_PAGE_URL}）の内容のみ**である。他の院内ページの情報や推測を混ぜない。
`.trim();

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
  "・冒頭は「ご不快な思いをさせてしまい、大変申し訳ありません。」で始める。",
  "・共感は一切書かない。「理解できます」「もっともだと思います」「無理もないことだと思います」「そのように感じられた」「大切ですので」等は禁止。",
  "・上から目線の言い回しも禁止。「私たちのサービス」「期待に応えられなかった」「残念です」等は書かない。",
  "・感情の代弁・気持ちの言語化・講義調の説明は書かない。",
  "・続けて2文、ご指摘の受け止めと改善姿勢を伝える（例：「ご指摘の点は真摯に受け止めます。」「今後の対応についても、より安心していただけるよう努めてまいります。」）。",
  "・良い例：ご不快な思いをさせてしまい、大変申し訳ありません。ご指摘の点は真摯に受け止めます。今後の対応についても、より安心していただけるよう努めてまいります。",
].join("\n");

/** 他院・以前の病院での経験（当院クレームではない） */
const PROMPT_OTHER_HOSPITAL_EXPERIENCE = [
  "【このターン：他院・以前の病院での経験の相談（最優先）】",
  "ユーザーは当院へのクレームではなく、以前・別の病院での経験や、その影響による不安を話しています。",
  "・当院への謝罪は書かない（「ご不快な思いをさせてしまい、申し訳ありません」等は禁止）。",
  "・「ご指摘の点は真摯に受け止め」「今後の対応改善に努めます」等、当院が悪かったかのような改善約束も書かない。",
  "・他院の医師・スタッフの善悪評価や批判には乗らない。",
  "・「そういった経験をされたのですね」「〜は大切です」などの感情代弁・講義調も書かない。",
  "・短くお礼を述べ、こちらで受診を検討する際に気になる点があれば聞き出す。必要なら診療時間内のお電話相談など選択肢を提示する。",
  "・良い例：前の病院でのご経験についてお聞かせいただき、ありがとうございます。こちらで受診をお考えの場合、気になることがあれば遠慮なくお聞かせください。診療時間内にお電話でご相談いただくこともできます。",
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
    /オンライン診療|オンライン|遠隔診療|テレビ電話/i,
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

function isOtherHospitalExperienceMessage(userMessage, safeHistory) {
  const text = recentUserText(userMessage, safeHistory);
  const current = String(userMessage || "").trim();
  const otherHospitalCue =
    /前の病院|以前の病院|以前行った病院|別の病院|他の病院|他院では|他院で|前に行った病院|以前行った|前回の病院|元の病院|転院前|かかりつけが変わ|病院を変え|病院が変わ/;
  const negativeCue =
    /怖|ひど|威圧|怒|冷た|不安|嫌|つら|苦|信頼でき|不信|トラウマ|最悪|無理|不快|嫌だった|嫌で/;

  if (otherHospitalCue.test(text) && negativeCue.test(text)) return true;
  if (/前の病院|以前の病院|別の病院では|他の病院では|他院では/.test(current)) return true;
  return false;
}

function shouldAddComplaintPrompt(userMessage, safeHistory) {
  if (isOtherHospitalExperienceMessage(userMessage, safeHistory)) return false;
  const text = recentUserText(userMessage, safeHistory);
  return /クレーム|苦情|不快|ひどい|最悪|ありえない|許せない|不信|ふざけ|態度が悪|態度.*悪|無愛想|冷たい|窓口.*悪|受付.*悪|スタッフ.*悪|対応が悪|威圧|怖かった|怖く|怒鳴|叱咤|先生.*怖|医師.*怖|他院.*(良|いい)|他の病院.*(良|いい)|訴えたい|文句|ひどかった|最悪だった|怒られ|怒った/.test(
    text
  );
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
function shouldSuppressReferencePages(userMessage, safeHistory, faqTopScore = 0) {
  if (shouldAddComplaintPrompt(userMessage, safeHistory)) return true;

  if (looksLikeConsultWithoutReferencePages(userMessage, safeHistory)) {
    if (shouldLoadSiteKnowledgeForMessage(userMessage, safeHistory) && faqTopScore >= 10) {
      return false;
    }
    return true;
  }

  if (!shouldLoadSiteKnowledgeForMessage(userMessage, safeHistory) && faqTopScore < 8) {
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

function defaultRefPageTitle(url) {
  const u = String(url || "").toLowerCase();
  if (/\/qa\/?/i.test(u)) return "よくある質問（Q&A）";
  if (/\/about\/?/i.test(u)) return "当院について";
  if (/\/visit|\/gai/i.test(u)) return "外来のご案内";
  return "当院サイト";
}

/** FAQ 抜粋内の「参考ページ: URL」からチップを補完（スコア閾値で漏れた場合の保険） */
function enrichReferencedPagesFromSnippet(clinicSnippet, referencedPages) {
  const out = [...(referencedPages || [])];
  const seen = new Set(out.map((p) => p.url));
  const re = /参考ページ:\s*(https?:\/\/\S+)/g;
  let m;
  while ((m = re.exec(String(clinicSnippet || "")))) {
    const url = m[1].replace(/[).、]+$/, "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: defaultRefPageTitle(url) });
  }
  return out;
}

/** モデルに参照チップの有無を明示（架空のリンク案内を防ぐ） */
function buildReferenceLinksSystemPrompt(referencedPages) {
  if (!referencedPages?.length) {
    return [
      "【このターンの参照リンク】",
      "画面下部には参照リンク（チップ）は表示されません。",
      "「画面下の参照リンク」「参照リンクからご確認ください」という案内は書かないでください。",
      "サイト案内が必要なら、お電話など、具体名で案内してください。",
    ].join("\n");
  }
  const lines = referencedPages.map((p) => `- ${(p.title || p.url || "").trim()}`);
  return [
    "【このターンの参照リンク】",
    "回答の直下に次のページがチップとして表示されます。",
    "サイト案内するときは「画面下の参照リンクからご確認ください」と書いてよいです。",
    ...lines,
  ].join("\n");
}

function stripFalseReferenceLinkMention(text, referencedPages) {
  if (referencedPages && referencedPages.length > 0) return String(text || "");
  let s = String(text || "");
  s = s.replace(/[^。\n]*画面下の参照リンク[^。\n]*。/g, "");
  s = s.replace(/[^。\n]*参照リンク[^。\n]*ご確認ください。/g, "");
  return s.replace(/\n{3,}/g, "\n\n").trim();
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
  return stripMisplacedKanaiApology(
    stripComplaintEmpathyPhrases(
      stripIrrelevantModelClosing(
        stripFalseReferenceLinkMention(
          fixGoryoshoConnective(
            stripNextActionLeadIn(
              normalizeLegacyTwoLayerAnswer(text)
            )
          ),
          referencedPages
        )
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
async function pipeOpenAIStreamNdjson(res, openai, userMessage, messages, referencedPages, safeHistory = [], clientId = "anonymous") {
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

  const trimmed = finalizeAssistantAnswer(fullAnswer.trim(), referencedPages, userMessage, safeHistory);
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
    })
  );
  await appendChatLog({
    message: userMessage,
    answer: trimmed,
    clientId,
    meta: { streamed: true },
  });

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

    // デプロイ確認用（詳細は出さない）
    if (req.method === "GET") {
      return res.status(200).json({
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
      });
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

    let clinicSnippet = "";
    let referencedPages = [];
    let csvTopScore = 0;
    const needsClinicKnowledgeJson = !casualGreetingOnly;
    const shouldFetchWebKnowledge =
      needsClinicKnowledgeJson &&
      (!SITE_KNOWLEDGE_GATED || shouldLoadSiteKnowledgeForMessage(userMessage, safeHistory));

    if (needsClinicKnowledgeJson) {
      const ranked = rankClinicKnowledge(userMessage);
      csvTopScore = ranked.topScore;
      clinicSnippet = buildClinicKnowledgeSnippet(userMessage);

      const seenUrl = new Set();
      for (const page of selectReferencedPagesFromCsv(userMessage)) {
        if (!page?.url || seenUrl.has(page.url)) continue;
        seenUrl.add(page.url);
        referencedPages.push(page);
      }

      if (CLINIC_WEB_SUPPLEMENT && shouldFetchWebKnowledge && shouldSupplementWithWeb(userMessage, csvTopScore)) {
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
          ((state?.singlePageOnly ?? state?.meetingOnly) || shouldFetchWebKnowledge)
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

      referencedPages = enrichReferencedPagesFromSnippet(clinicSnippet, referencedPages);
    }

    if (shouldSuppressReferencePages(userMessage, safeHistory, csvTopScore)) {
      referencedPages = [];
    }

    const messages = [
      { role: "system", content: SYSTEM },
      // 院内情報（JSON 優先。不足時のみ Web 抜粋を付加）
      ...(clinicSnippet
        ? [
            {
              role: "system",
              content: clinicSnippet,
            },
          ]
        : []),
      {
        role: "system",
        content: buildReferenceLinksSystemPrompt(referencedPages),
      },
      ...(shouldForceRichHtmlForMessage(userMessage, safeHistory)
        ? [{ role: "system", content: RICH_HTML_THIS_TURN }]
        : []),
      ...(shouldAddOtherHospitalExperiencePrompt(userMessage, safeHistory)
        ? [{ role: "system", content: PROMPT_OTHER_HOSPITAL_EXPERIENCE }]
        : shouldAddComplaintPrompt(userMessage, safeHistory)
          ? [{ role: "system", content: PROMPT_COMPLAINT }]
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
        await pipeOpenAIStreamNdjson(
          res,
          openai,
          userMessage,
          messages,
          referencedPages,
          safeHistory,
          clientId
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

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages,
      max_tokens: OPENAI_MAX_OUTPUT_TOKENS,
    });

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