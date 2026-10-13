/**
 * 初診来院時の持ち物（初めての方へ）
 *
 * 公式: https://kanai.or.jp/beginner/ 「来院される際の持ち物」
 * 初診料・入院持ち物（#hos_bring）と混同しない。
 */

export const FIRST_VISIT_WHAT_TO_BRING_REF_PAGE = {
  url: "https://kanai.or.jp/beginner/",
  title: "初めての方へ",
};

export const FIRST_VISIT_WHAT_TO_BRING_ANSWER = [
  "初めて当院を受診される際は、",
  "以下のものをお持ちください。",
  "",
  "・健康保険証（マイナ保険証・資格確認書）",
  "・医療証（受給者証）（お持ちの方）",
  "・紹介状・検査結果・服用されている",
  "  お薬の情報など（該当する方）",
  "",
  "初診の受付方法や診療の流れについては、",
  "下記のページでもご案内しています。",
].join("\n");

/**
 * 初診来院の持ち物・持参物の質問か（入院バッグ・初診料とは分離）
 * @param {string} userMessage
 */
export function isFirstVisitWhatToBringQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;

  // 入院・分娩の持ち物は hospital_bag へ
  if (
    /入院|陣痛バッグ|入院バッグ|#hos_bring|出産の入院|分娩入院/.test(msg) &&
    !/初診|初めて(?:の方|受診|来院)/.test(msg)
  ) {
    return false;
  }
  // 産後ケア持ち物は別
  if (/産後ケア|産後サポート|ショートステイ/.test(msg)) return false;
  // 初診料・費用は first-visit-fee へ
  if (
    /初診料|いくらかか|いくらくらい|診察代|検査料/.test(msg) ||
    (/初診/.test(msg) &&
      /(?:いくら|料金|費用|金額|円|かかる)/.test(msg) &&
      !/(?:持ち物|持参|持って|保険証|紹介状|医療証)/.test(msg))
  ) {
    return false;
  }

  const belongingsCue =
    /持ち物|持参|持ってい|持っていく|持ってく|何を持|何が必要|必要なもの|必要な物|準備するもの|準備する物/.test(
      msg
    ) ||
    /保険証|マイナ保険証|資格確認書|医療証|受給者証/.test(msg) ||
    /紹介状(?:は|が)?(?:必要|要る|いる|持)/.test(msg);

  if (!belongingsCue) return false;

  // 初診・初めて来院の文脈、または保険証・紹介状単体の持参確認
  if (
    /初診|初めて(?:の方|受診|来院|行く|の診察)|はじめて(?:受診|来院|行く)/.test(
      msg
    )
  ) {
    return true;
  }
  if (
    /保険証|マイナ保険証|資格確認書|医療証|受給者証|紹介状/.test(msg) &&
    /(?:必要|要る|いる|持|持参|持って)/.test(msg) &&
    !/(?:入院|出産|分娩)/.test(msg)
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
 *   useExactAnswer: boolean,
 *   referencedPages: Array<{url:string,title:string}>,
 * }|null}
 */
export function buildFirstVisitWhatToBringAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isFirstVisitWhatToBringQuery(msg)) return null;

  let focus = "belongings";
  if (/紹介状/.test(msg) && !/保険証|医療証|持ち物|持って/.test(msg)) {
    focus = "referral_letter";
  } else if (/保険証|マイナ|資格確認書/.test(msg) && !/持ち物|持って|紹介状/.test(msg)) {
    focus = "insurance_card";
  }

  return {
    answer: FIRST_VISIT_WHAT_TO_BRING_ANSWER,
    intent: "first_visit_what_to_bring",
    focus,
    useExactAnswer: true,
    referencedPages: [FIRST_VISIT_WHAT_TO_BRING_REF_PAGE],
  };
}
