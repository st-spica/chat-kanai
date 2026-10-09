/**
 * 入院中の食事全般（好き嫌い・変更相談）
 *
 * お祝いディナー（meal_customization）とは分離する。
 * 食物アレルギーは好き嫌いと別扱い（安全のため申告案内）。
 */

export const HOSPITAL_MEALS_INTENT = "hospital_meals";

export const HOSPITAL_MEAL_PREFERENCES_ANSWER = [
  "はい、もちろんです。",
  "",
  "苦手な食べ物がございましたら、",
  "遠慮なくスタッフにご相談ください。",
  "",
  "すべてのご希望にお応えできるとは限りませんが、",
  "可能な範囲で配慮させていただきますので、",
  "お気軽にお申し付けください。",
].join("\n");

export const HOSPITAL_MEAL_CHANGE_ANSWER = [
  "入院中の食事について、苦手な食べ物やご希望がございましたら、",
  "スタッフにご相談ください。",
  "",
  "すべてのご希望にお応えできるとは限りませんが、",
  "可能な範囲で配慮させていただきます。",
].join("\n");

export const FOOD_ALLERGY_SAFETY_ANSWER = [
  "食物アレルギーについては、安全に関わる大切な情報です。",
  "",
  "必ずスタッフへ事前にご申告・ご相談ください。",
  "対応の可否や具体的な内容については、",
  "こちらではお約束できませんので、院内でご確認ください。",
].join("\n");

/**
 * お祝いディナー明示（celebration 側へ回す）
 * @param {string} text
 */
function mentionsCelebrationDinner(text) {
  return /お祝いディナー|(?:お祝い|出産祝い)の食事|ディナーご招待|特別ディナー|お祝い膳/.test(
    String(text || "")
  );
}

/**
 * 入院中の食事全般の話題か
 * @param {string} msg
 */
export function mentionsHospitalMealsTopic(msg) {
  const t = String(msg || "");
  return (
    /入院中の食事|入院食|病院のご飯|病院のごはん|入院中のごはん|入院中のご飯|病院食|入院中のお食事/.test(
      t
    ) ||
    (/入院/.test(t) && /食事|ご飯|ごはん|お食事|食べ/.test(t))
  );
}

/**
 * 食物アレルギー（薬剤等は除外）
 * @param {string} userMessage
 */
export function isFoodAllergyQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg || !/アレルギー/.test(msg)) return false;
  if (/薬|薬物|造影|麻酔|ヨード|抗生物質|ペニシリン|ラテックス|ワクチン/.test(msg)) {
    return false;
  }
  return (
    /食物|食材|食べ|食事|卵|小麦|乳|そば|落花生|ナッツ|えび|エビ|かに|カニ|甲殻|アレルギー対応/.test(
      msg
    ) ||
    /アレルギーがあります|アレルギーなのですが|アレルギーです/.test(msg)
  );
}

/**
 * 好き嫌い・苦手・変更希望（アレルギーは含めない）
 * @param {string} userMessage
 */
export function isMealPreferenceRequest(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg || /アレルギー/.test(msg)) return false;
  if (
    /嫌いな(?:食材|食べ物)|苦手な(?:食材|食べ物)|好き嫌い|食べられないもの|食べれないもの/.test(
      msg
    )
  ) {
    return true;
  }
  if (
    /嫌い|苦手/.test(msg) &&
    /言って|相談|伝えて|抜いて|外して|変更|変え|配慮|言っても/.test(msg)
  ) {
    return true;
  }
  if (
    /食事(?:を|は|の)?変更|ご飯(?:を|は)?変更|メニュー(?:を|は)?変更|食べられない|食べれない/.test(
      msg
    )
  ) {
    return true;
  }
  if (
    /(?:が|を)嫌い|苦手なので|苦手なんですが/.test(msg) &&
    /抜いて|外して|除いて|変更|変え/.test(msg)
  ) {
    return true;
  }
  return false;
}

/**
 * 入院中の食事全般の質問か（お祝いディナー明示時は除外）
 * @param {string} userMessage
 * @param {string} [contextText]
 */
export function isHospitalMealsQuery(userMessage, contextText = "") {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;

  // お祝いディナー明示は celebration 側へ
  if (mentionsCelebrationDinner(msg)) return false;
  if (mentionsCelebrationDinner(contextText) && !mentionsHospitalMealsTopic(msg)) {
    // 履歴がディナーでも、今回が入院食明示なら入院食優先
    return false;
  }

  if (isFoodAllergyQuery(msg)) {
    if (mentionsCelebrationDinner(`${msg}\n${contextText}`)) return false;
    return true;
  }

  if (mentionsHospitalMealsTopic(msg) && isMealPreferenceRequest(msg)) {
    return true;
  }
  if (mentionsHospitalMealsTopic(msg) && /変更|嫌い|苦手|食べられ|食べれな/.test(msg)) {
    return true;
  }
  // ディナー非明示の好き嫌い・変更相談（入院食として案内）
  if (isMealPreferenceRequest(msg) && !mentionsCelebrationDinner(msg)) {
    return true;
  }
  return false;
}

/**
 * @param {string} userMessage
 * @param {string} [contextText]
 * @returns {{
 *   answer: string,
 *   intent: string,
 *   focus: string,
 *   useExactAnswer: boolean,
 *   referencedPages: Array<{url:string,title:string}>,
 * }|null}
 */
export function buildHospitalMealsAnswer(userMessage, contextText = "") {
  const msg = String(userMessage || "").trim();
  if (!isHospitalMealsQuery(msg, contextText)) return null;

  if (isFoodAllergyQuery(msg)) {
    return {
      answer: FOOD_ALLERGY_SAFETY_ANSWER,
      intent: HOSPITAL_MEALS_INTENT,
      focus: "food_allergy",
      useExactAnswer: true,
      referencedPages: [],
    };
  }

  if (/変更できますか|変更できる|メニュー変更|変えられますか/.test(msg)) {
    return {
      answer: HOSPITAL_MEAL_CHANGE_ANSWER,
      intent: HOSPITAL_MEALS_INTENT,
      focus: "change",
      useExactAnswer: true,
      referencedPages: [],
    };
  }

  return {
    answer: HOSPITAL_MEAL_PREFERENCES_ANSWER,
    intent: HOSPITAL_MEALS_INTENT,
    focus: "preferences",
    useExactAnswer: true,
    referencedPages: [],
  };
}
