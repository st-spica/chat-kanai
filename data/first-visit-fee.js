/**
 * 初診料の確定データ（一元管理）
 *
 * 金額は本ファイルのみに置く。3,300円（文書料など）と混同しない。
 * AI推測・サイト抜粋による金額上書き禁止。
 */

/** 確定：初診料（円） */
export const FIRST_VISIT_FEE_YEN = 1080;

export const FIRST_VISIT_FEE_DISPLAY = "1,080円";

/**
 * @param {number} yen
 */
function formatYen(yen) {
  return `${Number(yen).toLocaleString("ja-JP")}円`;
}

/**
 * 他料金との混同を除外
 * @param {string} msg
 */
function isOtherFeeTopic(msg) {
  return (
    /再診料|再診/.test(msg) ||
    /妊婦健診|健診料|健診費用|健診の料金/.test(msg) ||
    /分娩予約金|予納金|分娩費用|出産費用|入院費/.test(msg) ||
    /中絶|人工妊娠中絶/.test(msg) ||
    /予防接種|ワクチン|アブリスボ/.test(msg) ||
    /診断書|文書料|証明書/.test(msg) ||
    /産後ケア/.test(msg)
  );
}

/**
 * @param {string} userMessage
 */
export function isFirstVisitFeeQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isOtherFeeTopic(msg) && !/初診料/.test(msg)) return false;

  // 明示の初診料
  if (/初診料/.test(msg)) return true;

  // 初診＋料金系
  if (
    /初診/.test(msg) &&
    /(?:いくら|料金|費用|金額|代|円|かかる|必要)/.test(msg)
  ) {
    return true;
  }

  // 初めての受診／来院／診察
  if (
    /(?:初めて|はじめて|初回).{0,12}(?:受診|来院|診察|通院)/.test(msg) &&
    /(?:いくら|料金|費用|金額|代|円|かかる|必要)/.test(msg)
  ) {
    return true;
  }

  // 初回の診察料
  if (/初回の?(?:診察料|受診費用|診察代)/.test(msg)) return true;

  // 「初診はいくら」「初診の料金」
  if (/初診(?:は|の)?(?:いくら|料金|費用|診察代)/.test(msg)) return true;

  return false;
}

/**
 * 初回受診の合計費用を聞いているか（初診料そのものではない）
 * @param {string} msg
 */
function asksTotalFirstVisitCost(msg) {
  // 「初診料はいくら」「初診の料金」「初回の診察料」は初診料のみ
  if (/初診料|初回の診察料|初診の(?:料金|費用|診察代)/.test(msg) && !/必要|全部|合計|だけで/.test(msg)) {
    return false;
  }
  if (/初診はいくら/.test(msg)) return false;
  return (
    /全部で|合計|トータル|総額|必要な金額|いくらかかり/.test(msg) ||
    /初めて(?:の)?(?:受診|来院).{0,8}(?:いくら|費用|料金|必要)/.test(msg) ||
    /初めて受診するといくら|初診で必要な|初回の受診費用/.test(msg)
  );
}

/**
 * @param {string} userMessage
 * @returns {{
 *   answer: string,
 *   intent: string,
 *   firstVisitFeeYen: number,
 *   focus: "fee_only"|"total_with_exam"|"correction_3300"|"fee_only_enough",
 * }|null}
 */
export function buildFirstVisitFeeAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isFirstVisitFeeQuery(msg)) return null;

  const fee = FIRST_VISIT_FEE_DISPLAY;
  const feeYen = FIRST_VISIT_FEE_YEN;

  // 3,300円の誤認訂正（文書料などと混同されやすい）
  if (/3[,，]?300|３３００|三千三百/.test(msg)) {
    return {
      answer: [
        `いいえ。当院の初診料は${fee}です。`,
        "初回の受診時には、初診料に加えて検査料が必要となる場合があります。",
        "検査内容によって合計金額は異なります。",
      ].join("\n"),
      intent: "first_visit_fee",
      firstVisitFeeYen: feeYen,
      focus: "correction_3300",
    };
  }

  // 初診料だけで受診できるか
  if (/初診料だけ|それだけ|検査なし|検査なしで/.test(msg)) {
    return {
      answer: [
        `当院の初診料は${fee}です。`,
        "初回の受診時には、初診料とは別に検査料が必要となることがあります。",
        "検査内容によって金額が異なるため、初診料のみで確定するとは限りません。",
      ].join("\n"),
      intent: "first_visit_fee",
      firstVisitFeeYen: feeYen,
      focus: "fee_only_enough",
    };
  }

  // 初めての受診の合計・必要な金額
  if (asksTotalFirstVisitCost(msg)) {
    return {
      answer: [
        `初回の来院時に必要な金額は、初診料${fee}＋検査料です。`,
        "検査料は検査内容によって異なり、合計金額は一律ではありません。",
      ].join("\n"),
      intent: "first_visit_fee",
      firstVisitFeeYen: feeYen,
      focus: "total_with_exam",
    };
  }

  // デフォルト：初診料（電話案内は付けない）
  return {
    answer: `当院の初診料は${fee}です。`,
    intent: "first_visit_fee",
    firstVisitFeeYen: feeYen,
    focus: "fee_only",
  };
}

/** デバッグ・検証用 */
export function getFirstVisitFeeConfirmed() {
  return {
    amountYen: FIRST_VISIT_FEE_YEN,
    displayAmount: formatYen(FIRST_VISIT_FEE_YEN),
    source: "data/first-visit-fee.js",
  };
}
