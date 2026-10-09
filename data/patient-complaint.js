/**
 * 患者さんからのクレーム・ご意見への対応
 *
 * - 最初に謝罪（ご不便・ご不快へのお詫び）
 * - 具体内容への共感
 * - 必要な場合のみ短い説明（言い訳から始めない）
 * - 未確認の過失事実は断定しない
 * - 「報告しました」等の未実行共有は言わない
 * - 関連リンクは原則出さない
 * - 医療症状が含まれる場合は医療安全を優先
 */

export const PATIENT_COMPLAINT_INTENT = "patient_complaint";

/**
 * 他院での過去経験（当院クレームではない）
 * @param {string} msg
 */
function isOtherHospitalPastExperience(msg) {
  const t = String(msg || "");
  if (
    /他の病院に(?:変更|移|変え|転院)|転院したい|もう(?:二度と)?来たく(?:ない|ありません)/.test(
      t
    )
  ) {
    return false;
  }
  return /前の病院|以前の病院|別の病院では|他の病院では|他院では|転院前|前のかかりつけ/.test(
    t
  );
}

/**
 * 症状の程度のみ（クレームではない）
 * @param {string} msg
 */
function isSymptomSeverityOnly(msg) {
  const t = String(msg || "");
  if (
    /(?:つわり|悪阻|吐き気|腹痛|痛み|出血|熱|頭痛|腰痛|陣痛|胎動).{0,6}ひど/.test(
      t
    ) ||
    /ひど.{0,6}(?:つわり|悪阻|吐き気|腹痛|痛み|出血|熱|症状)/.test(t)
  ) {
    if (
      /(?:態度|対応|スタッフ|看護師|受付|窓口|先生|医師|待ち時間|順番|呼ばれ)/.test(
        t
      )
    ) {
      return false;
    }
    return true;
  }
  return false;
}

/**
 * クレーム中の身体症状（医療安全優先）
 * @param {string} msg
 */
export function complaintHasMedicalConcern(msg) {
  const t = String(msg || "");
  return (
    /お腹(?:が|も)?痛|腹痛|痛みが出|痛くなって|出血|破水|胎動|意識|息苦|胸が痛|倒れ|ふらつ|吐血/.test(
      t
    ) &&
    /待ち時間|待た|呼ばれ|順番|受付|対応|クレーム|苦情|おかしい|ひど/.test(t)
  );
}

/**
 * @param {string} userMessage
 */
export function isPatientComplaintQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isOtherHospitalPastExperience(msg)) return false;
  if (isSymptomSeverityOnly(msg)) return false;

  // 明示
  if (/クレーム|苦情|改善して|改善してほしい|改善を求め|文句|許せない|ありえない/.test(msg)) {
    return true;
  }

  // 待ち時間
  if (
    /待ち時間|待たされ|待たせる|待っています|待ってる|お待ち|全然呼ばれ|いつまで待|長く待|長すぎ/.test(
      msg
    ) &&
    /待|呼ばれ|予約|長|おかしい|不便|疲|うんざり|ひど|不満/.test(msg)
  ) {
    return true;
  }
  if (/全然呼ばれ|いつまで待たせる|呼ばれません|呼ばれない/.test(msg)) {
    return true;
  }

  // 診察順
  if (
    /(?:後に来|後から来|あとから来).{0,16}(?:先に呼ば|先に診|先に案内)|順番がおかしい|呼ばれる順番|診察の順番|順番を飛ば|飛ばされた/.test(
      msg
    )
  ) {
    return true;
  }

  // スタッフ対応
  if (
    /受付.{0,8}(?:態度|対応)|看護師.{0,8}(?:態度|対応|冷た)|ナース.{0,8}(?:態度|対応|冷た)|先生.{0,8}(?:説明|態度|対応)|医師.{0,8}(?:説明|態度)|スタッフ.{0,8}(?:態度|対応)|対応が(?:悪|ひど|冷たい)|態度が悪|不親切|冷たかっ|嫌な思い|不快|納得できない/.test(
      msg
    )
  ) {
    return true;
  }

  // 来院拒否・強い不満
  if (
    /もう(?:二度と)?来たく(?:ない|ありません)|もう来たく(?:ない|ありません)|二度と来(?:ない|ません)|他の病院に(?:変更|移|変え)|転院したい|かかりつけを変えたい/.test(
      msg
    )
  ) {
    return true;
  }

  return false;
}

/**
 * @param {string} msg
 */
function isWaitTimeFocus(msg) {
  return /待ち時間|待たされ|待たせる|待っています|長く待|長すぎ|1時間|一時間|３０分|30分|ずっと待/.test(
    msg
  );
}

/**
 * @param {string} msg
 */
function isNotCalledFocus(msg) {
  return /全然呼ばれ|呼ばれません|呼ばれない|いつまで待たせる/.test(msg);
}

/**
 * @param {string} msg
 */
function isCallOrderFocus(msg) {
  return (
    /(?:後に来|後から来|あとから来).{0,20}(?:先に|先を)|順番がおかしい|診察の順番|呼ばれる順番|順番を飛ば/.test(
      msg
    )
  );
}

/**
 * @param {string} msg
 */
function isReceptionFocus(msg) {
  return /受付.{0,10}(?:態度|対応|悪|ひど)/.test(msg);
}

/**
 * @param {string} msg
 */
function isNurseFocus(msg) {
  return /看護師|ナース/.test(msg) && /態度|対応|冷た|悪|ひど|不親切/.test(msg);
}

/**
 * @param {string} msg
 */
function isDoctorExplainFocus(msg) {
  return (
    /(?:先生|医師).{0,12}(?:説明|不十分|わかりにく|分かりにく|教えてくれな)/.test(
      msg
    ) || /説明が不十分|説明不足/.test(msg)
  );
}

/**
 * @param {string} msg
 */
function isNeverReturnFocus(msg) {
  return /もう(?:二度と)?来たく(?:ない|ありません)|もう来たく(?:ない|ありません)|二度と来(?:ない|ません)|他の病院に|転院したい/.test(
    msg
  );
}

/**
 * @param {string} msg
 */
function isImprovementFocus(msg) {
  return /改善して|改善してほしい|改善を求め|改善してください/.test(msg);
}

/**
 * @param {string} msg
 */
function mentionsReservation(msg) {
  return /予約/.test(msg);
}

/**
 * @param {string} userMessage
 * @returns {{
 *   answer: string,
 *   intent: string,
 *   focus: string,
 *   useExactAnswer: boolean,
 *   medicalSafetyLevel: "urgent"|"consult"|"information",
 *   referencedPages: Array<{url:string,title:string}>,
 *   suppressReferenceLinks: boolean,
 * }|null}
 */
export function buildPatientComplaintAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isPatientComplaintQuery(msg)) return null;

  const emptyRefs = [];

  // 医療症状を含むクレーム → 謝罪＋受診案内
  if (complaintHasMedicalConcern(msg)) {
    return {
      answer: [
        "ご不便とご心配をおかけし、申し訳ございません。",
        "",
        "お待ちいただく中でお腹の痛みなどが出てきたとのこと、",
        "つらい状況かと思います。",
        "",
        "症状がある場合は、遠慮なく受付やスタッフへお声がけください。",
        "強い痛みや出血など気になる症状が続く場合は、",
        "早めに医療機関へご相談ください。",
      ].join("\n"),
      intent: PATIENT_COMPLAINT_INTENT,
      focus: "medical_with_complaint",
      useExactAnswer: true,
      medicalSafetyLevel: "consult",
      referencedPages: emptyRefs,
      suppressReferenceLinks: true,
    };
  }

  if (isCallOrderFocus(msg)) {
    return {
      answer: [
        "お呼びする順番について、",
        "ご不快な思いをさせてしまい",
        "申し訳ございません。",
        "",
        "お待ちいただいている中で、",
        "後から来られた方が先に呼ばれると、",
        "疑問やご不満を感じられることと思います。",
        "",
        "診察の内容などによって",
        "ご案内の順番が前後する場合もございますが、",
        "ご不安や疑問を感じさせてしまったことを",
        "お詫び申し上げます。",
      ].join("\n"),
      intent: PATIENT_COMPLAINT_INTENT,
      focus: "call_order",
      useExactAnswer: true,
      medicalSafetyLevel: "information",
      referencedPages: emptyRefs,
      suppressReferenceLinks: true,
    };
  }

  if (isNotCalledFocus(msg)) {
    return {
      answer: [
        "長い時間お呼びできず、申し訳ございません。",
        "",
        "お待ちいただく時間が続くと、",
        "ご不安やご負担も大きくなることと思います。",
        "",
        "ご不便をおかけしていることをお詫び申し上げます。",
      ].join("\n"),
      intent: PATIENT_COMPLAINT_INTENT,
      focus: "not_called",
      useExactAnswer: true,
      medicalSafetyLevel: "information",
      referencedPages: emptyRefs,
      suppressReferenceLinks: true,
    };
  }

  if (isWaitTimeFocus(msg) && mentionsReservation(msg)) {
    return {
      answer: [
        "ご予約いただいていたにもかかわらず、",
        "長い時間お待たせしてしまい、",
        "申し訳ございません。",
        "",
        "お待ちいただく時間が長くなると、",
        "ご予定にも影響が出てしまうことと思います。",
        "",
        "ご不便をおかけしていることを",
        "お詫び申し上げます。",
      ].join("\n"),
      intent: PATIENT_COMPLAINT_INTENT,
      focus: "wait_with_reservation",
      useExactAnswer: true,
      medicalSafetyLevel: "information",
      referencedPages: emptyRefs,
      suppressReferenceLinks: true,
    };
  }

  if (isWaitTimeFocus(msg) || /待ち時間が長/.test(msg)) {
    return {
      answer: [
        "長い時間お待たせしてしまい、",
        "申し訳ございません。",
        "",
        "お待ちいただくことで、",
        "お身体にもご負担をおかけしたことと思います。",
        "",
        "お寄せいただいたご意見を大切にし、",
        "今後の診療環境の改善に役立ててまいります。",
      ].join("\n"),
      intent: PATIENT_COMPLAINT_INTENT,
      focus: "wait_time",
      useExactAnswer: true,
      medicalSafetyLevel: "information",
      referencedPages: emptyRefs,
      suppressReferenceLinks: true,
    };
  }

  if (isReceptionFocus(msg)) {
    return {
      answer: [
        "受付の対応について、ご不快な思いをさせてしまい、",
        "申し訳ございません。",
        "",
        "来院時の対応で嫌な思いをされると、",
        "安心してお過ごしいただくことが難しくなりますよね。",
        "",
        "お寄せいただいたご意見を真摯に受け止め、",
        "今後の接遇の改善に役立ててまいります。",
      ].join("\n"),
      intent: PATIENT_COMPLAINT_INTENT,
      focus: "reception_attitude",
      useExactAnswer: true,
      medicalSafetyLevel: "information",
      referencedPages: emptyRefs,
      suppressReferenceLinks: true,
    };
  }

  if (isNurseFocus(msg)) {
    return {
      answer: [
        "看護師の対応について、ご不快な思いをさせてしまい、",
        "申し訳ございません。",
        "",
        "冷たい印象を受けられると、",
        "不安や寂しさを感じてしまうことと思います。",
        "",
        "お寄せいただいたご意見を大切にし、",
        "より安心していただける対応に努めてまいります。",
      ].join("\n"),
      intent: PATIENT_COMPLAINT_INTENT,
      focus: "nurse_attitude",
      useExactAnswer: true,
      medicalSafetyLevel: "information",
      referencedPages: emptyRefs,
      suppressReferenceLinks: true,
    };
  }

  if (isDoctorExplainFocus(msg)) {
    return {
      answer: [
        "ご説明が不十分に感じられ、ご不安やご不満を与えてしまい、",
        "申し訳ございません。",
        "",
        "診察の内容が分かりにくいと、",
        "ご心配も残ってしまうことと思います。",
        "",
        "お寄せいただいたご意見を受け止め、",
        "より分かりやすいご説明に努めてまいります。",
      ].join("\n"),
      intent: PATIENT_COMPLAINT_INTENT,
      focus: "doctor_explanation",
      useExactAnswer: true,
      medicalSafetyLevel: "information",
      referencedPages: emptyRefs,
      suppressReferenceLinks: true,
    };
  }

  if (isNeverReturnFocus(msg)) {
    return {
      answer: [
        "ご不快な思いをさせてしまい、申し訳ございません。",
        "",
        "二度と来たくないと感じられるほど、",
        "つらいご経験だったことと思います。",
        "",
        "お寄せいただいたお気持ちを真摯に受け止め、",
        "今後の診療や接遇の改善に役立ててまいります。",
      ].join("\n"),
      intent: PATIENT_COMPLAINT_INTENT,
      focus: "never_return",
      useExactAnswer: true,
      medicalSafetyLevel: "information",
      referencedPages: emptyRefs,
      suppressReferenceLinks: true,
    };
  }

  if (isImprovementFocus(msg)) {
    return {
      answer: [
        "ご不便やご不快な思いをおかけし、申し訳ございません。",
        "",
        "改善を求めるお声をいただけたこと、",
        "ありがたく受け止めております。",
        "",
        "お寄せいただいたご意見を大切にし、",
        "今後の診療環境の改善に役立ててまいります。",
      ].join("\n"),
      intent: PATIENT_COMPLAINT_INTENT,
      focus: "improvement_request",
      useExactAnswer: true,
      medicalSafetyLevel: "information",
      referencedPages: emptyRefs,
      suppressReferenceLinks: true,
    };
  }

  // 一般クレーム
  return {
    answer: [
      "ご不快な思いをさせてしまい、申し訳ございません。",
      "",
      "ご不便やご不満を感じられたことと思います。",
      "",
      "お寄せいただいたご意見を大切にし、",
      "今後の改善に役立ててまいります。",
    ].join("\n"),
    intent: PATIENT_COMPLAINT_INTENT,
    focus: "general",
    useExactAnswer: true,
    medicalSafetyLevel: "information",
    referencedPages: emptyRefs,
    suppressReferenceLinks: true,
  };
}
