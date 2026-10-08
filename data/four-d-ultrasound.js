/**
 * 4D超音波撮影の確定案内
 *
 * 公式: https://kanai.or.jp/obstetrics/checkup/#ultraimaging
 * 表示URLの #ultraimaging は削除しない。
 * 「実施していない」と回答しない。
 */

export const FOUR_D_ULTRASOUND_REF_PAGE = {
  url: "https://kanai.or.jp/obstetrics/checkup/#ultraimaging",
  title: "4D超音波撮影について",
};

/** 本文取得用 */
export const FOUR_D_ULTRASOUND_FETCH_URL =
  "https://kanai.or.jp/obstetrics/checkup/";

/** 院内確認・公式記載に基づく確定情報（推測で増やさない） */
export const FOUR_D_ULTRASOUND = {
  available: true,
  serviceName: "4D超音波撮影",
  aliases: ["4Dエコー", "4D超音波", "4D撮影", "4次元エコー", "四次元エコー"],
  description:
    "お腹の赤ちゃんの様子を立体的な動画で見ることができます。動画データを保存したオリジナルUSBメモリと一緒に写真もお渡しします。",
  target: "当院通院中の方",
  gestationalWeeks: { min: 20, max: 30 },
  priceYen: { first: 5000, subsequent: 3000 },
  reservationRequired: true,
};

const FOUR_D_RE =
  /4\s*[DdＤｄ]|４\s*[DdＤｄ]|4次元|４次元|四次元|立体(?:エコー|超音波)|4D超音波撮影|4Dエコー|4D撮影/;

/**
 * @param {string} text
 */
export function mentionsFourDUltrasound(text) {
  return FOUR_D_RE.test(String(text || ""));
}

/**
 * 通常の健診エコー・動画DL等は除外
 * @param {string} msg
 */
function isOtherUltrasoundTopic(msg) {
  if (mentionsFourDUltrasound(msg)) return false;
  if (/エコー動画|動画.?ダウンロード|ダウンロード/.test(msg)) return true;
  if (/性別|男の子|女の子/.test(msg) && /エコー|超音波|わかる|判明/.test(msg)) {
    return true;
  }
  if (
    /(?:普通の|通常の|健診の)?(?:エコー|超音波).{0,12}(?:毎回|いつ|頻度)/.test(
      msg
    ) ||
    /(?:毎回|いつ).{0,12}(?:エコー|超音波)/.test(msg)
  ) {
    return true;
  }
  return false;
}

/**
 * @param {string} userMessage
 */
export function isFourDUltrasoundQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isOtherUltrasoundTopic(msg)) return false;
  if (mentionsFourDUltrasound(msg)) return true;
  // 「赤ちゃんを立体的に見られる」
  if (/立体的に見|立体で見|立体映像|立体動画/.test(msg) && /赤ちゃ|胎児|お腹/.test(msg)) {
    return true;
  }
  return false;
}

/**
 * @param {string} userMessage
 * @returns {{
 *   answer: string,
 *   intent: string,
 *   available: true,
 *   focus: string,
 *   referencedPages: Array<{url:string,title:string}>,
 * }|null}
 */
export function buildFourDUltrasoundAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isFourDUltrasoundQuery(msg)) return null;

  const ref = [FOUR_D_ULTRASOUND_REF_PAGE];
  const info = FOUR_D_ULTRASOUND;

  // 料金
  if (/料金|費用|いくら|金額|値段|円/.test(msg)) {
    return {
      answer: [
        "当院では、4D超音波撮影（4Dエコー）を実施しています。",
        "",
        `料金は、初回${info.priceYen.first.toLocaleString("ja-JP")}円、2回目以降${info.priceYen.subsequent.toLocaleString("ja-JP")}円です。`,
        "対象は当院通院中の方（妊娠20〜30週）で、完全予約制です。",
        "",
        "詳しいご案内は、下記のページをご確認ください。",
      ].join("\n"),
      intent: "four_d_ultrasound",
      available: true,
      focus: "price",
      referencedPages: ref,
    };
  }

  // 週数
  if (/何週|いつから|週から|時期|いつできる/.test(msg)) {
    return {
      answer: [
        "当院では、4D超音波撮影（4Dエコー）を実施しています。",
        "",
        `撮影可能な時期は、妊娠${info.gestationalWeeks.min}〜${info.gestationalWeeks.max}週です（当院通院中の方）。`,
        "完全予約制です。",
        "",
        "詳しいご案内は、下記のページをご確認ください。",
      ].join("\n"),
      intent: "four_d_ultrasound",
      available: true,
      focus: "weeks",
      referencedPages: ref,
    };
  }

  // 予約
  if (/予約/.test(msg)) {
    return {
      answer: [
        "当院では、4D超音波撮影（4Dエコー）を実施しています。",
        "",
        "4D超音波撮影は完全予約制です。",
        `対象は当院通院中の方（妊娠${info.gestationalWeeks.min}〜${info.gestationalWeeks.max}週）です。`,
        "",
        "詳しいご案内は、下記のページをご確認ください。",
      ].join("\n"),
      intent: "four_d_ultrasound",
      available: true,
      focus: "reservation",
      referencedPages: ref,
    };
  }

  // デフォルト：概要
  return {
    answer: [
      "当院では、4D超音波撮影（4Dエコー）を実施しています。",
      "",
      "4D超音波撮影では、お腹の赤ちゃんの様子を立体的な動画で見ることができます。",
      "",
      "撮影についての詳しいご案内は、下記のページをご確認ください。",
    ].join("\n"),
    intent: "four_d_ultrasound",
    available: true,
    focus: "overview",
    referencedPages: ref,
  };
}
