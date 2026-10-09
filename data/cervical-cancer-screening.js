/**
 * 子宮がん検診の確定案内
 *
 * 公式: https://kanai.or.jp/gynecology/#gyne_cancer
 * 子宮頸がんワクチン（#cervical_cancer）と混同しない。
 */

import { isHpvVaccineQuery, HPV_VACCINE_REF_PAGE } from "./hpv-vaccine.js";

export const CERVICAL_SCREENING_REF_PAGE = {
  url: "https://kanai.or.jp/gynecology/#gyne_cancer",
  title: "子宮がん検診について",
};

export const CERVICAL_SCREENING_AVAILABLE_ANSWER = [
  "はい、当院では子宮頸がん・子宮体がん検診を実施しています。",
  "",
  "診療時間内であれば随時検査を行っています。",
  "詳細は下記のページをご確認ください。",
].join("\n");

/**
 * @param {string} text
 */
export function mentionsCervicalScreening(text) {
  const t = String(text || "");
  return (
    /子宮がん検診|子宮頸がん検診|子宮体がん検診|婦人科検診/.test(t) ||
    (/子宮頸がん|子宮頚がん|子宮がん/.test(t) &&
      /検診|細胞診|検査/.test(t) &&
      !/ワクチン|予防接種|接種|HPV|シルガード|打て/.test(t))
  );
}

/**
 * ワクチンと検診の違いを聞いているか
 * @param {string} msg
 */
export function isHpvVaccineVsScreeningQuery(msg) {
  const t = String(msg || "");
  return (
    /ワクチン/.test(t) &&
    /検診|検査/.test(t) &&
    /違い|ちが|別|異なる|違う/.test(t)
  );
}

/**
 * @param {string} userMessage
 */
export function isCervicalCancerScreeningQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isHpvVaccineVsScreeningQuery(msg)) return true;
  if (isHpvVaccineQuery(msg)) return false;
  return mentionsCervicalScreening(msg);
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
export function buildCervicalCancerScreeningAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isCervicalCancerScreeningQuery(msg)) return null;

  if (isHpvVaccineVsScreeningQuery(msg)) {
    return {
      answer: [
        "はい、子宮頸がんワクチンと子宮がん検診は別の医療サービスです。",
        "",
        "ワクチン（HPVワクチン）は予防のための接種で、当院では木曜・金曜・土曜日の午前診・完全予約制で実施しています。",
        "検診は子宮頸がん・子宮体がんの検査で、診療時間内に随時受けられます。",
        "",
        "それぞれの詳細は、下記のページをご確認ください。",
      ].join("\n"),
      intent: "cervical_cancer_screening",
      focus: "vs_vaccine",
      useExactAnswer: true,
      referencedPages: [HPV_VACCINE_REF_PAGE, CERVICAL_SCREENING_REF_PAGE],
    };
  }

  if (/料金|費用|いくら|値段|価格/.test(msg)) {
    return {
      answer: [
        "はい、当院では子宮がん検診を実施しています。",
        "",
        "費用は検査内容や自治体の補助対象などによって異なります。",
        "詳細は下記のページをご確認ください。",
      ].join("\n"),
      intent: "cervical_cancer_screening",
      focus: "fee",
      useExactAnswer: true,
      referencedPages: [CERVICAL_SCREENING_REF_PAGE],
    };
  }

  return {
    answer: CERVICAL_SCREENING_AVAILABLE_ANSWER,
    intent: "cervical_cancer_screening",
    focus: "availability",
    useExactAnswer: true,
    referencedPages: [CERVICAL_SCREENING_REF_PAGE],
  };
}
