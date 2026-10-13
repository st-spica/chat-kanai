/**
 * 一般的な医学・健康相談（B類）
 *
 * 公式サイト未掲載でも、診断・処方をせず一般的な知識で案内する。
 * 当院の販売・治療の可否（A類）は isClinicSpecificHealthServiceQuery で分離。
 */

export const GENERAL_HEALTH_INTENT = "general_health_consultation";
export const PREGNANCY_STRETCH_MARKS_INTENT = "pregnancy_stretch_marks";

/**
 * 妊娠線など、当院の販売・治療・サービスとしての確認
 * @param {string} userMessage
 */
export function isClinicSpecificHealthServiceQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (/妊娠線|ストライア/.test(msg)) {
    if (
      /販売|売って|買え|購入|当院|院内|クリーム|治療は|治療を|提供|処方/.test(
        msg
      )
    ) {
      return true;
    }
    if (
      /診察|受診|相談/.test(msg) &&
      /できますか|できる|受けられ|お願い/.test(msg)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 妊娠線の一般的な予防・ケア相談
 * @param {string} userMessage
 */
export function isPregnancyStretchMarksGeneralQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isClinicSpecificHealthServiceQuery(msg)) return false;
  return (
    /妊娠線|ストライア|stretch/i.test(msg) ||
    (/妊娠|妊婦/.test(msg) &&
      /お腹.{0,6}(?:線|模様|シマ)|線が(?:でき|出)/.test(msg))
  );
}

/**
 * 妊娠中の便秘（つわり専用モジュールと重ならない単独相談）
 * @param {string} userMessage
 */
export function isPregnancyConstipationGeneralQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (!/便秘/.test(msg)) return false;
  if (/つわり|悪阻|吐き気|嘔吐/.test(msg) && /つわり|悪阻/.test(msg)) {
    return false;
  }
  return /妊娠|妊婦|妊娠中/.test(msg) || /どうしたら|対処|改善|なったら/.test(msg);
}

/**
 * 妊娠中の睡眠・寝姿勢
 * @param {string} userMessage
 */
export function isPregnancySleepPositionQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (!/妊娠|妊婦|妊娠中/.test(msg) && !/寝|睡眠|横向き|仰向け|左側|姿勢/.test(msg)) {
    return false;
  }
  return (
    /(?:どんな|どの).{0,6}姿勢.{0,8}寝|寝.{0,8}姿勢|横向き|仰向け|左側|睡眠姿勢|寝方/.test(
      msg
    ) ||
    (/妊娠|妊婦/.test(msg) && /寝|睡眠/.test(msg) && /いい|良い|おすすめ|どう/.test(msg))
  );
}

/**
 * B類：一般的な健康相談（サイト根拠なしでも回答してよい）
 * @param {string} userMessage
 */
export function isGeneralHealthConsultationQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isClinicSpecificHealthServiceQuery(msg)) return false;
  return (
    isPregnancyStretchMarksGeneralQuery(msg) ||
    isPregnancyConstipationGeneralQuery(msg) ||
    isPregnancySleepPositionQuery(msg)
  );
}

/**
 * @param {string} userMessage
 */
export function buildPregnancyStretchMarksAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isPregnancyStretchMarksGeneralQuery(msg)) return null;

  return {
    answer: [
      "妊娠線ができないか、気になりますよね。",
      "",
      "妊娠線を完全に防ぐ方法はありませんが、",
      "肌の乾燥を防ぐために、",
      "保湿クリームなどでやさしくケアするのがおすすめです。",
      "",
      "また、妊娠中は無理な食事制限を避けながら、",
      "体重が急激に増えないよう意識することも大切です。",
      "",
      "妊娠線は体質などによっても",
      "できやすさが異なるため、",
      "ケアをしていてもできることがあります。",
      "",
      "あまり気にしすぎず、",
      "お肌をいたわってあげてくださいね。",
    ].join("\n"),
    intent: PREGNANCY_STRETCH_MARKS_INTENT,
    focus: "prevention_care",
    medicalSafetyLevel: "information",
    suppressReferenceLinks: true,
  };
}

/**
 * @param {string} userMessage
 */
function buildPregnancyConstipationAnswer(userMessage) {
  if (!isPregnancyConstipationGeneralQuery(userMessage)) return null;
  return {
    answer: [
      "妊娠中に便秘がつらいのですね。",
      "",
      "妊娠中はホルモンの影響などで便秘になりやすいことがあります。",
      "水分をこまめにとる、食物繊維を意識する、",
      "無理のない範囲で体を動かすなどが一般的な対処のひとつです。",
      "",
      "下剤やお薬は自己判断で使わず、",
      "つらい場合や続く場合は当院へご相談ください。",
    ].join("\n"),
    intent: GENERAL_HEALTH_INTENT,
    focus: "constipation",
    medicalSafetyLevel: "information",
    suppressReferenceLinks: true,
  };
}

/**
 * @param {string} userMessage
 */
function buildPregnancySleepPositionAnswer(userMessage) {
  if (!isPregnancySleepPositionQuery(userMessage)) return null;
  return {
    answer: [
      "妊娠中の寝方が気になっているのですね。",
      "",
      "妊娠後期は、仰向けより横向き（特に左側）で休むと、",
      "お腹への負担が少なくなると言われることが多いです。",
      "枕やクッションで体を支えると楽になることもあります。",
      "",
      "眠れない、強い不快感、息苦しさなどがある場合は、",
      "我慢せず当院へご相談ください。",
    ].join("\n"),
    intent: GENERAL_HEALTH_INTENT,
    focus: "sleep_position",
    medicalSafetyLevel: "information",
    suppressReferenceLinks: true,
  };
}

/**
 * @param {string} userMessage
 */
export function buildGeneralHealthConsultationAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return null;

  const stretch = buildPregnancyStretchMarksAnswer(msg);
  if (stretch) return stretch;

  const constipation = buildPregnancyConstipationAnswer(msg);
  if (constipation) return constipation;

  const sleep = buildPregnancySleepPositionAnswer(msg);
  if (sleep) return sleep;

  return null;
}
