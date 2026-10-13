/**
 * アフターピル（緊急避妊薬）の処方案内
 *
 * 公式: https://kanai.or.jp/gynecology/ 「ピル」
 * ・緊急避妊ピル（アフターピル）の処方に対応
 * ・ピルの処方は必ず医師の診察が必要
 * ・即時処方・診察なし処方は保証しない
 * 妊娠中の服薬相談・低用量ピル継続とは分離する
 */

export const EMERGENCY_CONTRACEPTION_REF_PAGE = {
  url: "https://kanai.or.jp/gynecology/",
  title: "婦人科のご案内",
};

export const EMERGENCY_CONTRACEPTION_ANSWER = [
  "はい、当院ではアフターピル",
  "（緊急避妊薬）の処方に対応しています。",
  "",
  "アフターピルは、避妊に失敗した場合などに",
  "使用するお薬で、できるだけ早く服用することが",
  "大切です。",
  "",
  "処方には医師の診察が必要ですので、",
  "お早めに当院へご連絡いただき、",
  "受診についてご相談ください。",
  "",
  "なお、すぐに処方できるかどうかは、",
  "診療状況によって異なります。",
].join("\n");

/** 服用期限・タイミング */
export const EMERGENCY_CONTRACEPTION_TIMING_ANSWER = [
  "アフターピル（緊急避妊薬）は、",
  "避妊に失敗したあと、できるだけ早く服用することが大切です。",
  "",
  "当院ではアフターピルの処方に対応しています。",
  "処方には医師の診察が必要ですので、",
  "お早めに当院へご連絡いただき、受診についてご相談ください。",
  "",
  "服用の目安や可否は、状況によって異なります。",
  "すぐに処方できるかどうかも、診療状況によって異なります。",
].join("\n");

/** 避妊失敗の訴え（処方希望が明示されていなくても案内） */
export const EMERGENCY_CONTRACEPTION_FAILURE_ANSWER = [
  "避妊に失敗されたとのこと、ご不安かと思います。",
  "",
  "当院ではアフターピル（緊急避妊薬）の処方に対応しています。",
  "できるだけ早く服用することが大切ですので、",
  "お早めに当院へご連絡いただき、受診についてご相談ください。",
  "",
  "処方には医師の診察が必要です。",
  "すぐに処方できるかどうかは、診療状況によって異なります。",
].join("\n");

/**
 * @param {string} text
 */
function mentionsEmergencyContraceptionTopic(text) {
  return /アフターピル|緊急避妊|モーニングアフター|ノルレボ|プラノバール|避妊に失敗|コンドームが破/.test(
    String(text || "")
  );
}

/**
 * アフターピル／緊急避妊の相談か
 * @param {string} userMessage
 * @param {Array<{role?:string,content?:string}>|string} [contextOrHistory]
 */
export function isEmergencyContraceptionQuery(
  userMessage,
  contextOrHistory = []
) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;

  // 妊娠中の服薬・授乳中の服薬は別
  if (
    /妊娠中|妊婦|授乳中|母乳/.test(msg) &&
    /風邪薬|頭痛薬|市販薬|解熱|鎮痛/.test(msg) &&
    !/アフターピル|緊急避妊|モーニングアフター/.test(msg)
  ) {
    return false;
  }
  // 低用量ピルの継続・開始（緊急避妊ではない）
  if (
    /低用量ピル|アンジュ|マーベロン|ピルの処方|ピルを飲み|ピルを始め/.test(msg) &&
    !/アフター|緊急避妊|モーニングアフター|ノルレボ|プラノバール/.test(msg)
  ) {
    // 「ピル」単独＋緊急避妊文脈以外は除外
    if (!/緊急|アフター|避妊に失敗|コンドーム|破れた/.test(msg)) {
      return false;
    }
  }

  if (
    /アフターピル|緊急避妊薬|緊急避妊ピル|緊急避妊|モーニングアフターピル|モーニングアフター|ノルレボ|プラノバール/.test(
      msg
    )
  ) {
    return true;
  }

  // 避妊失敗・コンドーム破損など（緊急避妊の相談になりやすい）
  if (
    /避妊に失敗|避妊せず|避妊しなかった|コンドームが破|ゴムが破|避妊に失敗しました/.test(
      msg
    )
  ) {
    return true;
  }

  // 直前がアフターピル相談で「今日中に処方できますか」など
  const ctx = Array.isArray(contextOrHistory)
    ? contextOrHistory
        .filter((h) => h?.role === "user")
        .map((h) => String(h.content || ""))
        .join("\n")
    : String(contextOrHistory || "");
  if (
    mentionsEmergencyContraceptionTopic(ctx) &&
    /(?:今日|すぐ|すぐに|本日).{0,12}処方|処方(?:して|できる|もらえ)|もらえますか|いただけますか/.test(
      msg
    ) &&
    msg.length <= 40
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
export function buildEmergencyContraceptionAnswer(
  userMessage,
  contextOrHistory = []
) {
  const msg = String(userMessage || "").trim();
  if (!isEmergencyContraceptionQuery(msg, contextOrHistory)) return null;

  const ref = [EMERGENCY_CONTRACEPTION_REF_PAGE];

  // 服用期限・何時間以内
  if (
    /何時間|いつまで|何日以内|何時間以内|期限|タイミング|飲むもの|飲まないといけ|早めに飲/.test(
      msg
    )
  ) {
    return {
      answer: EMERGENCY_CONTRACEPTION_TIMING_ANSWER,
      intent: "emergency_contraception_prescription",
      focus: "timing",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  // 避妊失敗の訴え（処方希望より状況共有が先）
  if (
    /避妊に失敗|避妊せず|コンドームが破|ゴムが破/.test(msg) &&
    !/アフターピル|緊急避妊|処方|ほしい|もらえ/.test(msg)
  ) {
    return {
      answer: EMERGENCY_CONTRACEPTION_FAILURE_ANSWER,
      intent: "emergency_contraception_prescription",
      focus: "contraception_failure",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  // 今日中・すぐ処方（保証しない）
  let focus = "prescription_availability";
  if (/今日|すぐ|すぐに|今すぐ|本日|早い|早め/.test(msg)) {
    focus = "same_day_urgency";
  }

  return {
    answer: EMERGENCY_CONTRACEPTION_ANSWER,
    intent: "emergency_contraception_prescription",
    focus,
    useExactAnswer: true,
    referencedPages: ref,
  };
}
