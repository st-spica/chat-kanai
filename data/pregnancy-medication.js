/**
 * 妊娠中の服薬・葉酸相談（確定案内）
 *
 * AIが個別の薬の安全性・中止継続を判断しない。
 * 授乳中の服薬・小児予防接種とは分離する。
 */

/** @typedef {"urgent"|"consult"|"information"|"folic"} PregnancyMedSafetyLevel */

const DRUG_WORD_RE =
  /薬|お薬|服用|内服|市販薬|処方薬|頭痛薬|風邪薬|胃薬|解熱|鎮痛|飲み薬|サプリ/;

/**
 * 授乳中の服薬か（妊娠中の服薬と分離）
 * @param {string} userMessage
 */
export function isBreastfeedingMedicationQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (!/授乳|母乳/.test(msg)) return false;
  return DRUG_WORD_RE.test(msg) || /飲んで|飲んでも|飲み続け/.test(msg);
}

/**
 * 葉酸・葉酸サプリか
 * @param {string} userMessage
 */
export function isPregnancyFolicAcidQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isBreastfeedingMedicationQuery(msg) && !/葉酸/.test(msg)) return false;
  return /葉酸/.test(msg);
}

/**
 * 妊娠中の服薬相談か（葉酸・授乳・小児ワクチンは除外）
 * @param {string} userMessage
 * @param {string} [contextText]
 */
export function isPregnancyMedicationQuery(userMessage, contextText = "") {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isPregnancyFolicAcidQuery(msg)) return false;
  if (isBreastfeedingMedicationQuery(msg)) return false;
  // 小児予防接種は別ルート
  if (
    /(?:子供|子ども|こども|小児|赤ちゃん|お子).{0,12}(?:予防接種|ワクチン)/.test(
      msg
    )
  ) {
    return false;
  }

  const ctx = String(contextText || "");
  const pregnantCtx =
    /妊娠|妊婦|妊娠中|妊娠初期|妊娠に気づ/.test(msg) ||
    /妊娠|妊婦|妊娠中|お薬|服薬|薬について/.test(ctx);

  if (/妊娠に気づかず|妊娠初期に.{0,12}薬|妊娠中に.{0,12}薬|妊婦.{0,8}薬/.test(msg)) {
    return true;
  }
  if (/妊娠|妊婦/.test(msg) && DRUG_WORD_RE.test(msg)) return true;
  if (/妊娠|妊婦/.test(msg) && /飲んで|飲んでも|飲み続け|やめた方が/.test(msg)) {
    return true;
  }
  // 産婦人科チャットでの処方継続・中止相談（授乳・小児は除外済み）
  if (
    /(?:処方薬|飲み続け|やめた方がいい).{0,16}(?:大丈夫|薬)|妊娠したので薬をやめた/.test(
      msg
    )
  ) {
    return true;
  }
  // 直前が妊娠中の服薬相談で、頭痛薬などだけ続く
  if (
    /妊娠|妊婦|お薬|服薬|薬について/.test(ctx) &&
    (DRUG_WORD_RE.test(msg) ||
      /頭痛|風邪|胃|市販|処方|やめた|続けて|飲み/.test(msg)) &&
    msg.length <= 40 &&
    !/授乳|葉酸|予防接種|ワクチン/.test(msg)
  ) {
    return true;
  }
  return pregnantCtx && DRUG_WORD_RE.test(msg);
}

/**
 * @param {string} text
 */
export function mentionsPregnancyMedicationTopic(text) {
  return (
    isPregnancyMedicationQuery(text) ||
    (/妊娠|妊婦/.test(text) && DRUG_WORD_RE.test(text))
  );
}

/**
 * @param {Array<{role?:string,content?:string}>} safeHistory
 * @param {string} userMessage
 */
export function pregnancyMedContextText(safeHistory, userMessage = "") {
  const parts = [];
  for (const h of safeHistory || []) {
    if (h && (h.role === "user" || h.role === "assistant")) {
      parts.push(String(h.content || ""));
    }
  }
  parts.push(String(userMessage || ""));
  return parts.join("\n").slice(-4000);
}

/**
 * @param {string} msg
 */
function isUrgentMedicationReaction(msg) {
  return /呼吸困難|息が苦|顔.{0,6}腫|喉.{0,6}腫|意識.{0,6}障害|意識がもうろう|もうろう|強い腹痛|激しい腹痛|大量.{0,4}出血|血が止ま/.test(
    msg
  );
}

/**
 * 頭痛＋危険サイン（妊娠高血圧等の可能性）
 * @param {string} msg
 */
function isUrgentHeadacheWithWarning(msg) {
  return (
    /頭痛/.test(msg) &&
    /視覚|目のかすみ|見えにく|血圧|むくみが強|手足のしびれ|けいれん/.test(msg)
  );
}

function isUnawareTookMedication(msg) {
  return /気づかず|知ら(?:ないで|ず).{0,8}(?:飲|服用)|妊娠初期に.{0,16}(?:飲|服用)|飲んでしま/.test(
    msg
  );
}

function isSpecificDrugType(msg) {
  return /頭痛薬|風邪薬|胃薬|市販薬|処方薬|解熱|鎮痛/.test(msg);
}

function isContinueOrStopQuestion(msg) {
  return /飲み続け|継続|やめた方が|中止|やめたい|止めた方が/.test(msg);
}

/**
 * @param {string} userMessage
 * @param {Array<{role?:string,content?:string}>} [safeHistory]
 */
export function buildPregnancyFolicAcidAnswer(userMessage, safeHistory = []) {
  const msg = String(userMessage || "").trim();
  if (!isPregnancyFolicAcidQuery(msg)) return null;

  if (/販売|買える|売って|購入|病院で/.test(msg)) {
    return {
      answer: [
        "はい。当院でも葉酸のサプリメントを販売しております。",
        "摂取量や飲み方については、医師または薬剤師にご確認ください。",
      ].join("\n"),
      intent: "pregnancy_folic_acid",
      medicalSafetyLevel: /** @type {PregnancyMedSafetyLevel} */ ("folic"),
    };
  }

  return {
    answer: [
      "葉酸は、赤ちゃんの神経管閉鎖障害のリスクを減らすために大切な栄養素です。",
      "",
      "妊娠前から妊娠初期にかけては、食事に加えてサプリメントなどから葉酸を補うことが推奨されています。",
      "",
      "当院でも葉酸のサプリメントを販売しております。",
    ].join("\n"),
    intent: "pregnancy_folic_acid",
    medicalSafetyLevel: /** @type {PregnancyMedSafetyLevel} */ ("folic"),
  };
}

/**
 * @param {string} userMessage
 * @param {Array<{role?:string,content?:string}>} [safeHistory]
 */
export function buildPregnancyMedicationAnswer(userMessage, safeHistory = []) {
  const msg = String(userMessage || "").trim();
  const ctx = pregnancyMedContextText(safeHistory, userMessage);
  if (!isPregnancyMedicationQuery(msg, ctx)) return null;

  if (isUrgentMedicationReaction(msg) || isUrgentHeadacheWithWarning(msg)) {
    return {
      answer: [
        "今の症状からは、緊急性が高い可能性があります。",
        "我慢せず、すぐに医療機関へご連絡ください。夜間などで対応が必要と感じる場合は、119番も検討してください。",
        "当院へのご相談は 06-6931-2391（番号非通知は不可）までお電話ください。",
      ].join("\n"),
      intent: "pregnancy_medication_consultation",
      medicalSafetyLevel: /** @type {PregnancyMedSafetyLevel} */ ("urgent"),
    };
  }

  // 妊娠に気づかず服用した
  if (isUnawareTookMedication(msg)) {
    return {
      answer: [
        "妊娠に気づく前にお薬を飲まれたのですね。赤ちゃんへの影響が心配になりますよね。",
        "",
        "お薬の種類や服用した時期、量によって確認が必要な内容は異なります。",
        "",
        "飲んだお薬の名前や服用した時期がわかるものを用意して、当院にご相談ください。",
        "",
        "お薬を飲んだからといって、必ず赤ちゃんに影響が出るわけではありません。",
      ].join("\n"),
      intent: "pregnancy_medication_consultation",
      medicalSafetyLevel: /** @type {PregnancyMedSafetyLevel} */ ("consult"),
    };
  }

  // 処方薬の継続・中止（具体的な薬種案内より先）
  if (isContinueOrStopQuestion(msg)) {
    return {
      answer: [
        "服用中のお薬について、ご心配ですよね。",
        "",
        "妊娠中でも、治療のためにお薬の継続が必要な場合があります。",
        "自己判断で中止や変更をせず、当院の医師にご相談ください。",
      ].join("\n"),
      intent: "pregnancy_medication_consultation",
      medicalSafetyLevel: /** @type {PregnancyMedSafetyLevel} */ ("consult"),
    };
  }

  // 頭痛薬・風邪薬など具体的な種類（会話引き継ぎ含む）
  const drugFocus =
    msg.match(/頭痛薬|風邪薬|胃薬|市販薬|処方薬/)?.[0] ||
    (/頭痛/.test(msg) ? "頭痛薬" : null) ||
    (/風邪/.test(msg) ? "風邪薬" : null) ||
    (/胃薬|胃が/.test(msg) ? "胃薬" : null) ||
    (/市販/.test(msg) ? "市販薬" : null) ||
    (/処方/.test(msg) ? "処方薬" : null);

  const priorMed =
    /お薬|服薬|薬について|妊娠中のお薬|どのようなお薬/.test(ctx) &&
    mentionsPregnancyMedicationTopic(ctx);

  if (drugFocus || (priorMed && /頭痛|風邪|胃|市販|処方|薬です/.test(msg))) {
    const label = drugFocus || (/頭痛/.test(msg) ? "頭痛薬" : "お薬");
    /** @type {string[]} */
    const lines = [];
    if (/頭痛/.test(msg) && !/頭痛薬について/.test(msg)) {
      lines.push("頭痛があるのですね。", "");
    } else if (/風邪/.test(msg)) {
      lines.push("風邪の症状があるのですね。", "");
    }
    lines.push(`${label}についてですね。`);
    lines.push(
      "妊娠中に使用できるかは、お薬の種類や妊娠週数、体調によって異なります。"
    );
    lines.push("");
    lines.push(
      "市販薬も含め、自己判断で服用せず、当院の医師にご相談ください。"
    );
    return {
      answer: lines.join("\n"),
      intent: "pregnancy_medication_consultation",
      medicalSafetyLevel: /** @type {PregnancyMedSafetyLevel} */ ("consult"),
    };
  }

  // 一般的な「妊娠中に薬は大丈夫？」→ フォローアップ確認
  const askFollowUp =
    /大丈夫|飲んでいい|飲めますか|相談したい|影響/.test(msg) &&
    !isSpecificDrugType(msg) &&
    !isUnawareTookMedication(msg);

  if (askFollowUp) {
    return {
      answer: [
        "妊娠中のお薬について、ご心配ですよね。",
        "",
        "妊娠中は、お薬の種類や妊娠週数によって注意が必要な場合があります。",
        "一方で、治療のためにお薬が必要なこともありますので、自己判断で服用を始めたり中止したりせず、当院の医師にご相談ください。",
        "",
        "どのようなお薬についてのご相談でしょうか？",
      ].join("\n"),
      intent: "pregnancy_medication_consultation",
      medicalSafetyLevel: /** @type {PregnancyMedSafetyLevel} */ ("information"),
    };
  }

  return {
    answer: [
      "妊娠中のお薬について、ご心配ですよね。",
      "",
      "妊娠中は、お薬の種類や妊娠週数によって注意が必要な場合があります。",
      "一方で、治療のためにお薬が必要なこともありますので、自己判断で服用を始めたり中止したりせず、当院の医師にご相談ください。",
    ].join("\n"),
    intent: "pregnancy_medication_consultation",
    medicalSafetyLevel: /** @type {PregnancyMedSafetyLevel} */ ("information"),
  };
}

const BREASTFEEDING_MED_NO_INFO =
  "授乳中のお薬の服用については、現在このチャットでご案内できる院内情報が限られています。お薬の種類によって注意が必要な場合がありますので、自己判断せず、当院またはかかりつけの医師・薬剤師にご相談ください。";

/**
 * @param {string} userMessage
 */
export function buildBreastfeedingMedicationAnswer(userMessage) {
  if (!isBreastfeedingMedicationQuery(userMessage)) return null;
  return {
    answer: BREASTFEEDING_MED_NO_INFO,
    intent: "breastfeeding_medication_consultation",
    medicalSafetyLevel: /** @type {PregnancyMedSafetyLevel} */ ("consult"),
  };
}
