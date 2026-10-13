/**
 * 産後ケア全般の確定案内
 *
 * 公式: https://kanai.or.jp/aftersupport/
 * 母乳ケア（#milkcare）とは意図を分離する。
 * 未確認の料金・日帰り可否などを推測しない。
 * 他院出産の利用可否は公式記載どおり「利用可能」と先に答える。
 */

import { isMilkcareQuery } from "./milkcare.js";

export const POSTPARTUM_CARE_REF_PAGE = {
  url: "https://kanai.or.jp/aftersupport/",
  title: "産後ケアのご案内",
};

/** 公式ページで確認できた概要（断定しすぎない範囲） */
export const POSTPARTUM_CARE = {
  target: "出産後0か月から2か月未満のママと赤ちゃん",
  supports: ["からだサポート", "こころサポート", "育児サポート"],
  hasOvernight: true,
  reservationRequired: true,
  /** 公式 aftersupport に明記 */
  otherHospitalBirthAllowed: true,
};

export const POSTPARTUM_CARE_OVERVIEW_ANSWER = [
  "当院では、出産後のお母さんと赤ちゃんが",
  "安心して過ごせるよう、産後ケアを行っています。",
  "",
  "おっぱいの相談や授乳指導、",
  "育児に関するご相談など、",
  "お母さんの心と身体をサポートしています。",
  "",
  "対象となる方やケアの内容、料金などの詳細は、",
  "下記のページでご案内しておりますので、",
  "ぜひご覧ください。",
].join("\n");

/** 他院出産でも利用可（公式記載） */
export const POSTPARTUM_CARE_OTHER_HOSPITAL_ANSWER = [
  "はい、他院でご出産された方も、",
  "当院の産後ケアをご利用いただけます。",
  "",
  "産後のお身体のケアや授乳・育児に関する",
  "ご相談など、お母さんと赤ちゃんを",
  "サポートしています。",
  "",
  "ご利用条件やケアの内容については、",
  "下記のページをご覧ください。",
].join("\n");

/**
 * 他院・当院以外での出産でも産後ケアを使えるか、の質問か
 * @param {string} userMessage
 */
export function isPostpartumCareOtherHospitalQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  // 駐車場・アクセス等の別話題は除外（産後ケア明示時のみ例外）
  if (
    /駐車|アクセス|行き方|診療時間|面会/.test(msg) &&
    !/産後ケア|産後サポート/.test(msg)
  ) {
    return false;
  }

  const otherBirth =
    /他院|別の病院|別病院|他の病院|里帰り先で出産|里帰り出産/.test(msg) ||
    /(?:金井(?:産婦人科)?|当院|こちら)(?:産婦人科)?で(?:は)?(?:産んでい|出産してい|分娩してい)な/.test(
      msg
    ) ||
    /(?:金井(?:産婦人科)?|当院|こちら)(?:産婦人科)?で(?:は)?産んでいなくても/.test(
      msg
    ) ||
    /こちらで分娩してい/.test(msg) ||
    /当院で出産していなくても|当院で産んでいなくても/.test(msg);

  if (!otherBirth) return false;

  // 産後ケア明示
  if (/産後ケア|産後サポート/.test(msg)) return true;
  // 「他院出産でも利用・大丈夫？」系（出産文脈＋可否）
  if (
    /利用でき|受けられ|大丈夫|可能|対象|お願いでき/.test(msg) &&
    (/産後|ケア|サポート|出産|産ん|分娩/.test(msg) ||
      /(?:産んでい|出産してい|分娩してい)なくても/.test(msg))
  ) {
    return true;
  }
  return false;
}

/**
 * @param {string} userMessage
 */
export function isPostpartumCareQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  // 母乳ケア専用は milkcare モジュールへ
  if (isMilkcareQuery(msg)) return false;

  if (isPostpartumCareOtherHospitalQuery(msg)) return true;
  if (/産後ケア|産後サポート/.test(msg)) return true;
  if (
    /出産後.{0,16}(?:赤ちゃんと|母子で|ママと).{0,12}(?:利用|サービス|ケア)/.test(
      msg
    ) ||
    /産後に.{0,12}(?:利用できる|受けられる).{0,8}サービス/.test(msg)
  ) {
    return true;
  }
  return false;
}

/**
 * @param {string} msg
 */
function asksFee(msg) {
  return /料金|費用|いくら|値段|価格/.test(msg);
}

/**
 * @param {string} msg
 */
function asksReservation(msg) {
  return /予約|申し込み|申込|仮予約/.test(msg);
}

/**
 * @param {string} msg
 */
function asksEligibility(msg) {
  // 他院出産の可否は asksOtherHospital 側へ（期間・対象月齢の話と分離）
  if (isPostpartumCareOtherHospitalQuery(msg)) return false;
  return /対象|何ヶ月|何か月|いつまで|何ヵ月|利用できる期間|対象者/.test(msg);
}

/**
 * @param {string} msg
 */
function asksStayType(msg) {
  return /宿泊|ショートステイ|日帰り|デイ/.test(msg);
}

/**
 * @param {string} msg
 */
function asksContent(msg) {
  return /内容|何を|どんなこと|どんなサポート|何が受け/.test(msg);
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
export function buildPostpartumCareAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isPostpartumCareQuery(msg)) return null;

  const ref = [POSTPARTUM_CARE_REF_PAGE];

  // 利用可否（他院出産）を最優先で明確に答える
  if (isPostpartumCareOtherHospitalQuery(msg)) {
    return {
      answer: POSTPARTUM_CARE_OTHER_HOSPITAL_ANSWER,
      intent: "postpartum_care",
      focus: "other_hospital_eligibility",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  if (asksFee(msg)) {
    return {
      answer: [
        "はい、当院では産後ケアを行っています。",
        "",
        "料金はコースやご利用条件によって異なります。",
        "大阪市の産後ケア事業をご利用の場合と、",
        "当院オリジナルの産後ケアの場合で金額が異なります。",
        "",
        "最新の料金は、下記のページでご確認ください。",
      ].join("\n"),
      intent: "postpartum_care",
      focus: "fee",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  if (asksReservation(msg)) {
    return {
      answer: [
        "産後ケアは事前予約制です。",
        "",
        "仮予約フォームからのお申し込みなど、",
        "ご予約の流れや注意点は下記のページでご案内しています。",
        "",
        "詳しくは産後ケアのご案内ページをご確認ください。",
      ].join("\n"),
      intent: "postpartum_care",
      focus: "reservation",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  if (asksEligibility(msg)) {
    return {
      answer: [
        "産後ケアの対象は、出産後0か月から2か月未満の",
        "ママと赤ちゃんです。",
        "",
        "コースやご利用条件の詳細は、",
        "下記のページでご確認ください。",
      ].join("\n"),
      intent: "postpartum_care",
      focus: "eligibility",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  if (asksStayType(msg)) {
    if (/日帰り|デイ/.test(msg) && !/宿泊|ショートステイ/.test(msg)) {
      return {
        answer: [
          "産後ケアの日帰り利用について、",
          "こちらで確認できる範囲では断定できません。",
          "",
          "宿泊を伴うショートステイなどのコース案内は、",
          "下記のページでご確認ください。",
        ].join("\n"),
        intent: "postpartum_care",
        focus: "day_use_unknown",
        useExactAnswer: true,
        referencedPages: ref,
      };
    }
    return {
      answer: [
        "はい、産後ケアでは宿泊を伴うコース（ショートステイなど）の",
        "ご案内があります。",
        "",
        "ご利用時間や料金、注意点などの詳細は、",
        "下記のページでご確認ください。",
      ].join("\n"),
      intent: "postpartum_care",
      focus: "overnight",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  if (asksContent(msg)) {
    return {
      answer: [
        "産後ケアでは、お母さんの体調管理やおっぱい相談、",
        "育児相談、沐浴・スキンケア・授乳方法の指導など、",
        "からだ・こころ・育児のサポートを行っています。",
        "",
        "詳しい内容は、下記のページでご案内しております。",
      ].join("\n"),
      intent: "postpartum_care",
      focus: "content",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  return {
    answer: POSTPARTUM_CARE_OVERVIEW_ANSWER,
    intent: "postpartum_care",
    focus: "overview",
    useExactAnswer: true,
    referencedPages: ref,
  };
}
