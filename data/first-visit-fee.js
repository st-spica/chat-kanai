/**
 * 初診料の確定データ（一元管理）
 *
 * 金額は本ファイルのみに置く。3,300円（文書料など）と混同しない。
 * 回答は固定文。初診料のみで終わらせず、検査料・合計非一律を必ず含める。
 */

/** 確定：初診料（円） */
export const FIRST_VISIT_FEE_YEN = 1080;

export const FIRST_VISIT_FEE_DISPLAY = "1,080円";

/**
 * 必須3点を含む固定回答（言い換え禁止）
 */
export const FIRST_VISIT_FEE_FIXED_ANSWER =
  "当院の初診料は1,080円です。初回の来院時に必要な金額は、初診料1,080円＋検査料となります。検査料は検査内容によって異なるため、合計金額は一律ではありません。";

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
 * 初診の持ち物・持参物（費用ではない）
 * 「初診に必要な持ち物」の「必要」が料金判定に誤ヒットしないよう除外する
 * @param {string} msg
 */
function isFirstVisitBelongingsTopic(msg) {
  return (
    /持ち物|持参|持ってい|持っていく|何を持|必要なもの|必要な物/.test(msg) ||
    /保険証|マイナ保険証|資格確認書|医療証|受給者証|紹介状/.test(msg)
  );
}

/**
 * @param {string} userMessage
 */
export function isFirstVisitFeeQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isOtherFeeTopic(msg) && !/初診料/.test(msg)) return false;
  // 持ち物質問は費用に流さない（「必要な持ち物」の「必要」誤ヒット防止）
  if (isFirstVisitBelongingsTopic(msg) && !/初診料|いくら|料金|費用|金額|円|かかる/.test(msg)) {
    return false;
  }

  // 明示の初診料
  if (/初診料/.test(msg)) return true;

  // 初診＋料金系（「必要」単独は持ち物と衝突するため除外）
  if (
    /初診/.test(msg) &&
    /(?:いくら|料金|費用|金額|代|円|かかる|くらいかか)/.test(msg)
  ) {
    return true;
  }
  // 「初診で必要な金額」など金額文脈の「必要」のみ許可
  if (
    /初診/.test(msg) &&
    /必要/.test(msg) &&
    /(?:金額|費用|料金|お金|円)/.test(msg)
  ) {
    return true;
  }

  // 初めての受診／来院／診察
  if (
    /(?:初めて|はじめて|初回).{0,12}(?:受診|来院|診察|通院)/.test(msg) &&
    /(?:いくら|料金|費用|金額|代|円|かかる)/.test(msg) &&
    !isFirstVisitBelongingsTopic(msg)
  ) {
    return true;
  }

  // 初回の診察料・診察費用
  if (/初回の?(?:診察料|受診費用|診察代|診察費用)/.test(msg)) return true;

  // 「初診はいくら」「初診の料金」「初診診察の料金」
  if (/初診(?:時|診察)?(?:は|の)?(?:いくら|料金|費用|診察代)/.test(msg)) {
    return true;
  }

  return false;
}

/**
 * @param {string} userMessage
 * @returns {{
 *   answer: string,
 *   intent: string,
 *   firstVisitFeeYen: number,
 *   focus: string,
 *   useExactAnswer: boolean,
 * }|null}
 */
export function buildFirstVisitFeeAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isFirstVisitFeeQuery(msg)) return null;

  const feeYen = FIRST_VISIT_FEE_YEN;
  const fixed = FIRST_VISIT_FEE_FIXED_ANSWER;

  // 3,300円の誤認訂正（文書料などと混同されやすい）
  if (/3[,，]?300|３３００|三千三百/.test(msg)) {
    return {
      answer: `いいえ。${fixed}`,
      intent: "first_visit_fee",
      firstVisitFeeYen: feeYen,
      focus: "correction_3300",
      useExactAnswer: true,
    };
  }

  // 初診料だけで済むか／以外にかかるか
  if (
    /初診料だけ|1,?080円だけ|それだけ|検査なし|だけで済み|以外に|別途|検査料/.test(
      msg
    )
  ) {
    return {
      answer: fixed,
      intent: "first_visit_fee",
      firstVisitFeeYen: feeYen,
      focus: "with_exam_required",
      useExactAnswer: true,
    };
  }

  // すべての初診料金質問で固定回答（必須3点を省略しない）
  return {
    answer: fixed,
    intent: "first_visit_fee",
    firstVisitFeeYen: feeYen,
    focus: "fixed",
    useExactAnswer: true,
  };
}

/** デバッグ・検証用 */
export function getFirstVisitFeeConfirmed() {
  return {
    amountYen: FIRST_VISIT_FEE_YEN,
    displayAmount: formatYen(FIRST_VISIT_FEE_YEN),
    fixedAnswer: FIRST_VISIT_FEE_FIXED_ANSWER,
    source: "data/first-visit-fee.js",
  };
}
