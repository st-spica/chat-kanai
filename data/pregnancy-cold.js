/**
 * 妊娠中の風邪（受診先・薬・セルフケア）
 *
 * 「風邪」だけで服薬相談に流さない。
 * 当院で風邪を診るかは院内根拠がない限り断定しない。
 */

/** @typedef {"urgent"|"consult"|"information"} PregnancyColdSafetyLevel */

export const PREGNANCY_COLD_WHERE_INTENT = "pregnancy_cold_where_to_visit";
export const PREGNANCY_COLD_MED_INTENT = "pregnancy_cold_medication";
export const PREGNANCY_COLD_SELF_CARE_INTENT = "pregnancy_cold_self_care";

const PREGNANT_RE = /妊娠|妊婦|妊娠中/;
const COLD_RE =
  /風邪|かぜ|発熱|熱が出|熱もあり|熱もあります|熱が|高熱|咳が|咳も|のどの痛|喉の痛|鼻水|鼻づまり/;
const DRUG_RE =
  /薬|お薬|服用|内服|市販薬|処方薬|風邪薬|解熱|鎮痛|飲み薬|飲んでも|飲んでいい|飲めます/;

/**
 * 当院で風邪を診るか等の院内固有質問
 * @param {string} userMessage
 */
export function isClinicColdServiceQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (!COLD_RE.test(msg) && !/風邪/.test(msg)) return false;
  return (
    /(?:金井|当院|本院).{0,20}(?:風邪|かぜ|熱|咳)/.test(msg) ||
    /(?:風邪|かぜ).{0,20}(?:診て|診察|見て|見てもらえ|対応|受けられ)/.test(msg) ||
    /(?:金井|当院).{0,12}(?:診て|診察|見て)/.test(msg)
  );
}

/**
 * 緊急・要注意の風邪関連症状
 * @param {string} msg
 */
export function pregnancyColdHasUrgentSigns(msg) {
  const t = String(msg || "");
  return (
    /息苦|呼吸が苦|呼吸困難|意識.{0,6}もうろう|もうろう|水分が取れない|水分がとれない|強い腹痛|激しい腹痛|性器出血|出血|破水|胎動が(?:少ない|弱い|なく)|胎動が明らかに/.test(
      t
    )
  );
}

/**
 * 受診先の質問か
 * @param {string} userMessage
 */
export function isPregnancyColdWhereToVisitQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isClinicColdServiceQuery(msg)) return false;
  if (!PREGNANT_RE.test(msg)) return false;
  if (!COLD_RE.test(msg) && !/内科|何科|どの科|どこに(?:行|受診)|受診先/.test(msg)) {
    return false;
  }
  // 薬の可否が主旨なら受診先ではない
  if (DRUG_RE.test(msg) && !/どこ|何科|内科|受診先|行けば|行ったら|行って/.test(msg)) {
    return false;
  }
  return (
    /どこに(?:受診|行|診て|行け)|何科|どの科|内科に(?:行|受診)|受診したらいい|受診すれば|受診すればいい|受診先|どこへ(?:行|受診)|どこを受診/.test(
      msg
    ) ||
    (/内科/.test(msg) && /(?:行|受診|診て|大丈夫|いいですか)/.test(msg)) ||
    (/熱/.test(msg) && /何科|どこ|内科|受診/.test(msg) && PREGNANT_RE.test(msg))
  );
}

/**
 * 風邪薬の質問か
 * @param {string} userMessage
 */
export function isPregnancyColdMedicationQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isPregnancyColdWhereToVisitQuery(msg)) return false;
  if (isClinicColdServiceQuery(msg)) return false;
  if (!PREGNANT_RE.test(msg)) return false;
  if (/風邪薬/.test(msg)) return true;
  if (/風邪|かぜ/.test(msg) && DRUG_RE.test(msg)) return true;
  return false;
}

/**
 * 風邪の一般的な対処法
 * @param {string} userMessage
 */
export function isPregnancyColdSelfCareQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isPregnancyColdWhereToVisitQuery(msg)) return false;
  if (isPregnancyColdMedicationQuery(msg)) return false;
  if (isClinicColdServiceQuery(msg)) return false;
  if (!PREGNANT_RE.test(msg)) return false;
  if (!/風邪|かぜ/.test(msg)) return false;
  return /対処|治す|早く治|楽に|どうしたら|どうすれば|安静|休息|ケア/.test(msg);
}

/**
 * 妊娠中の風邪関連（いずれか）
 * @param {string} userMessage
 */
export function isPregnancyColdQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (
    isPregnancyColdWhereToVisitQuery(msg) ||
    isPregnancyColdMedicationQuery(msg) ||
    isPregnancyColdSelfCareQuery(msg) ||
    isClinicColdServiceQuery(msg)
  ) {
    return true;
  }
  // 妊娠中＋風邪様症状＋緊急サイン（受診先質問でなくても医療安全優先）
  if (
    PREGNANT_RE.test(msg) &&
    pregnancyColdHasUrgentSigns(msg) &&
    (/熱|発熱|咳|風邪|かぜ|息苦/.test(msg) || COLD_RE.test(msg))
  ) {
    return true;
  }
  return false;
}

/**
 * @param {string} userMessage
 */
export function buildPregnancyColdAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isPregnancyColdQuery(msg)) return null;

  if (pregnancyColdHasUrgentSigns(msg)) {
    const needs119 = /息苦|呼吸困難|意識.{0,6}もうろう|もうろう|倒れ/.test(msg);
    const lines = [
      "今の症状からは、早めの医療機関への相談が必要な可能性があります。",
      "",
    ];
    if (needs119) {
      lines.push(
        "息苦しさや意識の変化がある場合は、ためらわず119番もご検討ください。"
      );
      lines.push("");
    }
    lines.push(
      "強い腹痛や出血、破水が疑われる症状、胎動が気になる場合は、",
      "速やかに当院へご連絡ください。",
      "夜間などで対応が必要と感じる場合は、救急外来の受診も検討してください。"
    );
    return {
      answer: lines.join("\n"),
      intent: PREGNANCY_COLD_WHERE_INTENT,
      focus: "urgent",
      medicalSafetyLevel: /** @type {PregnancyColdSafetyLevel} */ ("urgent"),
      suppressReferenceLinks: true,
    };
  }

  if (isClinicColdServiceQuery(msg)) {
    return {
      answer: [
        "当院で風邪症状の診察を受け付けているかどうかについては、",
        "現在このチャットで確認できる院内情報がありません。",
        "",
        "妊娠中の風邪症状は、内科やかかりつけの医療機関へご相談いただくのが一般的です。",
        "受診時は妊娠中であることと、妊娠週数をお伝えください。",
        "",
        "強い腹痛や出血など、妊娠に関する症状もある場合は、当院へご相談ください。",
      ].join("\n"),
      intent: PREGNANCY_COLD_WHERE_INTENT,
      focus: "clinic_service_unknown",
      medicalSafetyLevel: /** @type {PregnancyColdSafetyLevel} */ ("information"),
      suppressReferenceLinks: true,
    };
  }

  if (isPregnancyColdWhereToVisitQuery(msg)) {
    return {
      answer: [
        "妊娠中に風邪をひいた場合は、",
        "まず内科やかかりつけの医療機関にご相談ください。",
        "",
        "受診する際は、妊娠中であることと、",
        "現在の妊娠週数をお伝えください。",
        "",
        "発熱や咳などの症状がある場合は、",
        "受診前に医療機関へ連絡し、",
        "受診方法を確認しておくと安心です。",
        "",
        "強い腹痛や出血、お腹の張りなど、",
        "妊娠に関する症状もある場合は、",
        "当院へご相談ください。",
      ].join("\n"),
      intent: PREGNANCY_COLD_WHERE_INTENT,
      focus: "where_to_visit",
      medicalSafetyLevel: /** @type {PregnancyColdSafetyLevel} */ ("information"),
      suppressReferenceLinks: true,
    };
  }

  if (isPregnancyColdMedicationQuery(msg)) {
    return {
      answer: [
        "妊娠中の風邪薬についてですね。",
        "",
        "妊娠中に使用できるかは、",
        "お薬の種類や妊娠週数、体調によって異なります。",
        "",
        "市販薬も含め、自己判断で服用せず、",
        "医師または薬剤師にご相談ください。",
      ].join("\n"),
      intent: PREGNANCY_COLD_MED_INTENT,
      focus: "medication",
      medicalSafetyLevel: /** @type {PregnancyColdSafetyLevel} */ ("consult"),
      suppressReferenceLinks: true,
    };
  }

  // self_care
  return {
    answer: [
      "妊娠中に風邪をひいて、つらいかもしれませんね。",
      "",
      "一般的には、安静にして水分をこまめにとること、",
      "無理をせず体を休めることが大切です。",
      "",
      "症状が続く場合や悪化する場合は、",
      "内科やかかりつけの医療機関へご相談ください。",
      "受診時は妊娠中であることと妊娠週数をお伝えください。",
      "",
      "強い腹痛や出血など、妊娠に関する症状がある場合は、",
      "当院へご相談ください。",
    ].join("\n"),
    intent: PREGNANCY_COLD_SELF_CARE_INTENT,
    focus: "self_care",
    medicalSafetyLevel: /** @type {PregnancyColdSafetyLevel} */ ("information"),
    suppressReferenceLinks: true,
  };
}
