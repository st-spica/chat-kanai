/**
 * ニューボーン＆マタニティフォト（外部サービス紹介・固定回答）
 *
 * 公式: https://kanai.or.jp/photographer/
 * 提携・院内運営・専属カメラマン等の表現は禁止。
 * 通常回答は指定文を言い換えない。
 */

export const NEWBORN_MATERNITY_PHOTO_REF_PAGE = {
  url: "https://kanai.or.jp/photographer/",
  title: "ニューボーン＆マタニティフォトについて",
};

/** 指定の固定回答（言い換え禁止） */
export const NEWBORN_MATERNITY_PHOTO_FIXED_ANSWER =
  "当院でご出産の方は特別価格（ご家族さま1回限り）にてご案内しております。ご興味のある方は、参照リンク先のLINEからお友だち登録のうえ、「当院でのご出産予定であること」をメッセージに添えて、お気軽にお問い合わせください。";

const TOPIC_RE =
  /ニューボーン|newborn|マタニティフォト|マタニティ写真|妊婦写真|ベビーフォト|新生児フォト|新生児写真|出産記念写真|出産記念の写真|フォトグラファー|カメラマン紹介|写真撮影の特別価格|特別価格.{0,12}(?:写真|フォト)|赤ちゃんの写真/;

/**
 * @param {string} text
 */
export function mentionsNewbornMaternityPhoto(text) {
  return TOPIC_RE.test(String(text || ""));
}

/**
 * 4D・院内撮影ルール・分娩中撮影などと分離
 * @param {string} msg
 */
function isOtherPhotoTopic(msg) {
  if (/4\s*[DdＤｄ]|４\s*[DdＤｄ]|4次元|四次元|エコー/.test(msg)) return true;
  if (/出産中|分娩中|陣痛中|立ち会い.{0,8}写真|入院中.{0,8}写真/.test(msg)) {
    return true;
  }
  // 院内撮影・録音ルール（notpermit）— ただし「院内でニューボーン撮影」は本意図
  if (
    /(?:院内|病院内).{0,12}(?:撮影|写真|録画|録音)/.test(msg) &&
    !mentionsNewbornMaternityPhoto(msg) &&
    !/撮ってもら|撮影してもら|撮影サービス/.test(msg)
  ) {
    return true;
  }
  return false;
}

/**
 * @param {string} userMessage
 */
export function isNewbornMaternityPhotoQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  // 「出産中に写真」「4Dエコーの写真」は別意図
  if (/出産中|分娩中|陣痛中/.test(msg)) return false;
  if (/4\s*[DdＤｄ]|エコー/.test(msg)) return false;

  if (mentionsNewbornMaternityPhoto(msg)) return true;

  // 赤ちゃん／新生児の撮影サービス（一般的な「写真」だけでは不可）
  if (
    /(?:赤ちゃん|新生児).{0,12}(?:写真|フォト|撮影)/.test(msg) &&
    /(?:サービス|撮|あり|予約|料金|いくら|教え|知り)/.test(msg)
  ) {
    return true;
  }

  // 特別価格の回数・内容（このサービスの案内文脈）
  if (/特別価格/.test(msg) && /(?:何回|1回|一回|回数|利用|写真|フォト)/.test(msg)) {
    return true;
  }

  // 院内／当院で撮影してもらえるか（外部紹介であることの確認）
  if (
    /(?:院内|病院|当院)で(?:撮影|写真).{0,10}(?:してもら|撮ってもら|できます|あります|やっています)/.test(
      msg
    )
  ) {
    return true;
  }

  return false;
}

/**
 * @param {string} userMessage
 * @returns {{
 *   answer: string,
 *   intent: string,
 *   focus: string,
 *   referencedPages: Array<{url:string,title:string}>,
 *   useExactAnswer: boolean,
 * }|null}
 */
export function buildNewbornMaternityPhotoAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isNewbornMaternityPhotoQuery(msg)) return null;

  const ref = [NEWBORN_MATERNITY_PHOTO_REF_PAGE];

  // 提携・院内運営の直接質問 → 明確に否定＋固定案内
  if (
    /提携|専属|当院が(?:撮影|運営|提供)|院内で撮|病院で撮|院内撮影してもら|当院で撮ってもら|直接撮/.test(
      msg
    )
  ) {
    return {
      answer: [
        "ニューボーン＆マタニティフォトは、外部の撮影サービスをご紹介しているものです。",
        "当院との提携関係はなく、当院が直接撮影を行うサービスではありません。",
        "",
        NEWBORN_MATERNITY_PHOTO_FIXED_ANSWER,
      ].join("\n"),
      intent: "newborn_maternity_photo",
      focus: "clarification_not_partner",
      referencedPages: ref,
      useExactAnswer: false,
    };
  }

  // 特別価格の回数
  if (/何回|1回|一回|回数|何度/.test(msg) && /特別価格|特別/.test(msg)) {
    return {
      answer: NEWBORN_MATERNITY_PHOTO_FIXED_ANSWER,
      intent: "newborn_maternity_photo",
      focus: "special_price_limit",
      referencedPages: ref,
      useExactAnswer: true,
    };
  }

  // デフォルト：固定回答のみ（言い換え禁止）
  return {
    answer: NEWBORN_MATERNITY_PHOTO_FIXED_ANSWER,
    intent: "newborn_maternity_photo",
    focus: "fixed",
    referencedPages: ref,
    useExactAnswer: true,
  };
}
