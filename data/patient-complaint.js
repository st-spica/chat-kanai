/**
 * 患者さんからのクレーム・ご意見への対応
 *
 * - 初回：謝罪 → 具体的受け止め（言い訳冒頭禁止）
 * - 継続：「謝ってほしいわけじゃない」等は文脈を見て未回答点へ進む
 * - 謝罪の繰り返し・空虚な共感だけで終わらせない
 * - 未確認の過失事実・偽の報告完了は断定しない
 * - 関連リンクは原則出さない
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
 * 謝罪拒否・説明要求など、クレーム継続の短い合図
 * @param {string} msg
 */
export function isComplaintFollowUpCue(msg) {
  const m = String(msg || "").trim();
  if (!m) return false;
  if (m.length > 80 && isPatientComplaintContent(m)) return false;
  return (
    /謝ってほしいわけじゃ|謝ってほしくない|謝らなくて|謝罪はいい|謝罪はいらない|お詫びはいい/.test(
      m
    ) ||
    /そういうことじゃな|そうじゃなくて|違うんで|ちがうんで|そうではない|そういう意味じゃな/.test(
      m
    ) ||
    /だから何|だからなに|ちゃんと答えて|ちゃんと説明|それは分かってる|分かってるけど|わかってるけど/.test(
      m
    ) ||
    /^(?:なんで|なぜ|どうして)[？?！!。．\s]*$/.test(m) ||
    /^(?:説明して|理由を教えて|理由は)[？?！!。．\s]*$/.test(m) ||
    (/改善して|改善してほしい|改善してください/.test(m) && m.length <= 40)
  );
}

/**
 * 内容のある初回クレームか（フォロー合図を除く）
 * @param {string} msg
 */
export function isPatientComplaintContent(msg) {
  const t = String(msg || "").trim();
  if (!t) return false;
  if (isOtherHospitalPastExperience(t)) return false;
  if (isSymptomSeverityOnly(t)) return false;
  if (isComplaintFollowUpCue(t) && t.length <= 40) return false;

  if (/クレーム|苦情|改善して|改善してほしい|改善を求め|文句|許せない|ありえない/.test(t)) {
    return true;
  }
  if (
    /待ち時間|待たされ|待たせる|待っています|待ってる|お待ち|全然呼ばれ|いつまで待|長く待|長すぎ|待たされ/.test(
      t
    ) &&
    /待|呼ばれ|予約|長|おかしい|不便|疲|うんざり|ひど|不満|混/.test(t)
  ) {
    return true;
  }
  if (/全然呼ばれ|いつまで待たせる|呼ばれません|呼ばれない/.test(t)) return true;
  if (
    /(?:後に来|後から来|あとから来).{0,16}(?:先に呼ば|先に診|先に案内)|順番がおかしい|呼ばれる順番|診察の順番|順番を飛ば|飛ばされた/.test(
      t
    )
  ) {
    return true;
  }
  if (
    /受付.{0,8}(?:態度|対応)|看護師.{0,8}(?:態度|対応|冷た)|ナース.{0,8}(?:態度|対応|冷た)|先生.{0,8}(?:説明|態度|対応)|医師.{0,8}(?:説明|態度)|スタッフ.{0,8}(?:態度|対応)|対応が(?:悪|ひど|冷たい)|態度が悪|不親切|冷たかっ|嫌な思い|不快|納得できない/.test(
      t
    )
  ) {
    return true;
  }
  if (
    /座(?:れ|る|りたい)|座る場所|座るところ|席が(?:ない|なかっ)|座席|椅子が|イスが/.test(
      t
    )
  ) {
    return true;
  }
  if (
    /もう(?:二度と)?来たく(?:ない|ありません)|もう来たく(?:ない|ありません)|二度と来(?:ない|ません)|他の病院に(?:変更|移|変え)|転院したい|かかりつけを変えたい/.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

/**
 * @param {string} userMessage
 * @param {Array<{role?:string,content?:string}>} [safeHistory]
 */
export function isPatientComplaintQuery(userMessage, safeHistory = []) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isPatientComplaintContent(msg)) return true;
  if (isComplaintFollowUpCue(msg) && findPriorComplaintMessage(safeHistory, msg)) {
    return true;
  }
  return false;
}

/**
 * @param {Array<{role?:string,content?:string}>} safeHistory
 * @param {string} [currentMsg]
 */
export function findPriorComplaintMessage(safeHistory, currentMsg = "") {
  const list = Array.isArray(safeHistory) ? safeHistory : [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role !== "user") continue;
    const t = String(list[i].content || "").trim();
    if (!t || t === String(currentMsg || "").trim()) continue;
    if (isPatientComplaintContent(t)) return t;
  }
  return null;
}

/**
 * @param {Array<{role?:string,content?:string}>} safeHistory
 */
function findLastAssistantMessage(safeHistory) {
  const list = Array.isArray(safeHistory) ? safeHistory : [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === "assistant") {
      return String(list[i].content || "").trim();
    }
  }
  return "";
}

/**
 * @param {string} text
 */
export function extractComplaintAspects(text) {
  const t = String(text || "");
  return {
    waitTime: /待ち時間|待たされ|長く待|長すぎ|待っています|待たされ|お待たせ|混んで/.test(
      t
    ),
    seating:
      /座(?:れ|る|りたい)|座る場所|座るところ|席が(?:ない|なかっ)|座席|椅子|イス/.test(
        t
      ),
    reservationWhy:
      /予約/.test(t) &&
      /(?:なんで|なぜ|どうして|混|待|おかしい)/.test(t),
    reservation: /予約/.test(t),
    callOrder:
      /(?:後に来|後から来).{0,20}(?:先に)|順番がおかしい|診察の順番|呼ばれる順番/.test(
        t
      ),
    reception: /受付.{0,10}(?:態度|対応|悪|ひど)/.test(t),
    nurse: /看護師|ナース/.test(t) && /態度|対応|冷た|悪|ひど|不親切/.test(t),
    doctorExplain:
      /(?:先生|医師).{0,12}(?:説明|不十分)|説明が不十分|説明不足/.test(t),
    neverReturn: /もう(?:二度と)?来たく|二度と来/.test(t),
    improvement: /改善して|改善してほしい|改善を求め/.test(t),
  };
}

/**
 * @param {string} answer
 */
function extractAnswerCoverage(answer) {
  const a = String(answer || "");
  return {
    apologized: /申し訳|お詫び|ごめん/.test(a),
    waitMentioned: /お待たせ|待ち時間|お待ちいただく/.test(a),
    waitExplained:
      /診察にかかる時間|診療状況|当日の診療|お待ちいただく時間が長くなる場合/.test(
        a
      ),
    seatingMentioned: /座|席|待合/.test(a),
    reservationMentioned: /予約/.test(a),
    improvementMentioned: /改善/.test(a),
    receptionMentioned: /受付|接遇/.test(a),
  };
}

/**
 * @param {string} msg
 */
function followUpWantsExplanation(msg) {
  return (
    /謝ってほしいわけじゃ|謝ってほしくない|謝罪はいい|そうじゃなくて|そういうことじゃな|ちゃんと答えて|ちゃんと説明|それは分かってる|分かってるけど/.test(
      msg
    ) ||
    /^(?:なんで|なぜ|どうして)[？?！!。．\s]*$/.test(msg) ||
    /説明して|理由を/.test(msg)
  );
}

/**
 * @param {string} msg
 */
function followUpWantsImprovement(msg) {
  return /改善して|改善してほしい|改善してください|良くして|なんとかして/.test(
    msg
  );
}

/**
 * @param {string} msg
 */
function followUpRejectsApologyFraming(msg) {
  return /謝ってほしいわけじゃ|謝ってほしくない|謝罪はいい|謝罪はいらない|お詫びはいい|そういうことじゃな|そうじゃなくて/.test(
    msg
  );
}

/**
 * 初回：複合クレーム向け回答
 * @param {string} msg
 * @param {ReturnType<typeof extractComplaintAspects>} aspects
 */
function buildInitialCompoundAnswer(msg, aspects) {
  const emptyRefs = [];

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
      phase: "initial",
    };
  }

  // 待ち＋座席＋予約の複合
  if (aspects.waitTime && (aspects.seating || aspects.reservationWhy)) {
    const lines = [
      aspects.reservation
        ? "ご予約いただいていたにもかかわらず、長い時間お待たせしてしまい、申し訳ございません。"
        : "長い時間お待たせしてしまい、申し訳ございません。",
      "",
    ];
    if (aspects.seating) {
      lines.push(
        "座りたいのに座れないほど混雑していたとのこと、",
        "ご負担も大きかったことと思います。"
      );
      lines.push("");
    }
    if (aspects.reservationWhy || aspects.reservation) {
      lines.push(
        "ご予約をいただいても、診察にかかる時間や当日の診療状況によって、",
        "お待ちいただく時間が長くなる場合があります。"
      );
      lines.push("");
    }
    if (aspects.seating) {
      lines.push(
        "待合の座席や混雑については、",
        "改善が必要な点として真摯に受け止めます。"
      );
    } else {
      lines.push(
        "お寄せいただいたご意見を大切にし、",
        "今後の診療環境の改善に役立ててまいります。"
      );
    }
    return {
      answer: lines.join("\n"),
      intent: PATIENT_COMPLAINT_INTENT,
      focus: "wait_compound",
      useExactAnswer: true,
      medicalSafetyLevel: "information",
      referencedPages: emptyRefs,
      suppressReferenceLinks: true,
      phase: "initial",
    };
  }

  if (aspects.callOrder) {
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
      phase: "initial",
    };
  }

  if (aspects.seating && !aspects.waitTime) {
    return {
      answer: [
        "座る場所がなく、ご不便をおかけし申し訳ございません。",
        "",
        "お立ちのままでお待ちいただくことになり、",
        "ご負担が大きかったことと思います。",
        "",
        "待合の座席や混雑については、",
        "改善が必要な点として真摯に受け止めます。",
      ].join("\n"),
      intent: PATIENT_COMPLAINT_INTENT,
      focus: "seating",
      useExactAnswer: true,
      medicalSafetyLevel: "information",
      referencedPages: emptyRefs,
      suppressReferenceLinks: true,
      phase: "initial",
    };
  }

  if (aspects.waitTime && aspects.reservation) {
    return {
      answer: [
        "ご予約いただいていたにもかかわらず、",
        "長い時間お待たせしてしまい、",
        "申し訳ございません。",
        "",
        "お待ちいただく時間が長くなると、",
        "ご予定にも影響が出てしまうことと思います。",
        "",
        "ご予約をいただいても、診察にかかる時間や当日の診療状況によって、",
        "お待ちいただく時間が長くなる場合があります。",
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
      phase: "initial",
    };
  }

  if (aspects.waitTime) {
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
      phase: "initial",
    };
  }

  if (aspects.reception) {
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
      phase: "initial",
    };
  }

  if (aspects.nurse) {
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
      phase: "initial",
    };
  }

  if (aspects.doctorExplain) {
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
      phase: "initial",
    };
  }

  if (aspects.neverReturn) {
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
      phase: "initial",
    };
  }

  if (aspects.improvement) {
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
      phase: "initial",
    };
  }

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
    phase: "initial",
  };
}

/**
 * 継続ターン：謝罪を繰り返さず未回答点へ進む
 * @param {string} followUp
 * @param {string} priorComplaint
 * @param {string} lastAssistant
 */
function buildFollowUpAnswer(followUp, priorComplaint, lastAssistant) {
  const aspects = extractComplaintAspects(priorComplaint);
  const covered = extractAnswerCoverage(lastAssistant);
  const emptyRefs = [];
  const wantsWhy = followUpWantsExplanation(followUp);
  const wantsImprove = followUpWantsImprovement(followUp);
  const rejectsApology = followUpRejectsApologyFraming(followUp);

  // 改善要望
  if (wantsImprove || (aspects.seating && /改善/.test(followUp))) {
    if (aspects.seating) {
      return {
        answer: [
          "座る場所がなくお待ちいただく状況について、",
          "待合の座席や混雑の改善を求めるお声として、",
          "具体的に受け止めました。",
          "",
          "お寄せいただいたご意見を大切にし、",
          "今後の診療環境の改善に役立ててまいります。",
        ].join("\n"),
        intent: PATIENT_COMPLAINT_INTENT,
        focus: "followup_seating_improvement",
        useExactAnswer: true,
        medicalSafetyLevel: "information",
        referencedPages: emptyRefs,
        suppressReferenceLinks: true,
        phase: "followup",
      };
    }
    if (aspects.reception) {
      return {
        answer: [
          "受付の対応についての改善要望として、",
          "具体的に受け止めました。",
          "",
          "お寄せいただいたご意見を大切にし、",
          "今後の接遇の改善に役立ててまいります。",
        ].join("\n"),
        intent: PATIENT_COMPLAINT_INTENT,
        focus: "followup_reception_improvement",
        useExactAnswer: true,
        medicalSafetyLevel: "information",
        referencedPages: emptyRefs,
        suppressReferenceLinks: true,
        phase: "followup",
      };
    }
    return {
      answer: [
        "改善を求めるお声として、具体的に受け止めました。",
        "",
        "お寄せいただいたご意見を大切にし、",
        "今後の診療や接遇の改善に役立ててまいります。",
      ].join("\n"),
      intent: PATIENT_COMPLAINT_INTENT,
      focus: "followup_improvement",
      useExactAnswer: true,
      medicalSafetyLevel: "information",
      referencedPages: emptyRefs,
      suppressReferenceLinks: true,
      phase: "followup",
    };
  }

  // 待ち時間・予約の説明、座席が未回答
  if (
    (wantsWhy || rejectsApology) &&
    (aspects.waitTime || aspects.reservation || aspects.reservationWhy)
  ) {
    const lines = [];
    if (rejectsApology) {
      lines.push(
        "そうですよね。",
        aspects.reservation || aspects.reservationWhy
          ? "謝罪だけではなく、なぜ予約しているのに長時間待つことになるのか、"
          : "謝罪だけではなく、なぜそのような状況になったのか、",
        "きちんと説明してほしいということですよね。",
        ""
      );
    }
    if (aspects.reservation || aspects.reservationWhy) {
      lines.push(
        "ご予約をいただいても、診察にかかる時間や当日の診療状況によって、",
        "お待ちいただく時間が長くなる場合があります。"
      );
    } else {
      lines.push(
        "診察にかかる時間や当日の診療状況によって、",
        "お待ちいただく時間が長くなる場合があります。"
      );
    }
    lines.push(
      "当日の混雑の具体的な原因までは、こちらでは確認できません。"
    );
    // 謝罪拒否時は、初回で軽く触れていても座席・改善を改めて明示する
    if (aspects.seating) {
      lines.push(
        "",
        "ただ、座る場所もないほど混雑していたことについては、",
        "待合環境も含めて改善が必要な点だと受け止めています。"
      );
    } else if (!covered.improvementMentioned || rejectsApology) {
      lines.push(
        "",
        "お待ちいただく負担を減らすよう、",
        "ご意見を今後の改善に役立ててまいります。"
      );
    }
    return {
      answer: lines.join("\n"),
      intent: PATIENT_COMPLAINT_INTENT,
      focus: "followup_wait_explanation",
      useExactAnswer: true,
      medicalSafetyLevel: "information",
      referencedPages: emptyRefs,
      suppressReferenceLinks: true,
      phase: "followup",
    };
  }

  // 座席のみ未回答の継続
  if ((wantsWhy || rejectsApology) && aspects.seating) {
    return {
      answer: [
        "座る場所がなくお待ちいただく状況について、",
        "ご負担が大きかった点として受け止めています。",
        "",
        "待合の座席や混雑については、",
        "改善が必要な点だと受け止めています。",
      ].join("\n"),
      intent: PATIENT_COMPLAINT_INTENT,
      focus: "followup_seating",
      useExactAnswer: true,
      medicalSafetyLevel: "information",
      referencedPages: emptyRefs,
      suppressReferenceLinks: true,
      phase: "followup",
    };
  }

  // 受付など：意図が曖昧なときだけ確認
  if (rejectsApology && aspects.reception) {
    return {
      answer: [
        "受付の対応について、謝罪以外に気になっている点があるのですね。",
        "",
        "差し支えなければ、特に気になった点を教えていただけますか。",
        "いただいた内容を、接遇の改善に役立ててまいります。",
      ].join("\n"),
      intent: PATIENT_COMPLAINT_INTENT,
      focus: "followup_reception_clarify",
      useExactAnswer: true,
      medicalSafetyLevel: "information",
      referencedPages: emptyRefs,
      suppressReferenceLinks: true,
      phase: "followup",
    };
  }

  // 一般フォロー
  if (rejectsApology || wantsWhy) {
    return {
      answer: [
        "謝罪だけではなく、状況の説明や今後の改善について",
        "きちんと受け止めてほしいということですね。",
        "",
        "お寄せいただいたご意見を大切にし、",
        "今後の診療環境の改善に役立ててまいります。",
      ].join("\n"),
      intent: PATIENT_COMPLAINT_INTENT,
      focus: "followup_general",
      useExactAnswer: true,
      medicalSafetyLevel: "information",
      referencedPages: emptyRefs,
      suppressReferenceLinks: true,
      phase: "followup",
    };
  }

  return {
    answer: [
      "お寄せいただいたご意見を大切にし、",
      "今後の改善に役立ててまいります。",
    ].join("\n"),
    intent: PATIENT_COMPLAINT_INTENT,
    focus: "followup_ack",
    useExactAnswer: true,
    medicalSafetyLevel: "information",
    referencedPages: emptyRefs,
    suppressReferenceLinks: true,
    phase: "followup",
  };
}

/**
 * @param {string} userMessage
 * @param {Array<{role?:string,content?:string}>} [safeHistory]
 * @returns {{
 *   answer: string,
 *   intent: string,
 *   focus: string,
 *   useExactAnswer: boolean,
 *   medicalSafetyLevel: "urgent"|"consult"|"information",
 *   referencedPages: Array<{url:string,title:string}>,
 *   suppressReferenceLinks: boolean,
 *   phase?: string,
 * }|null}
 */
export function buildPatientComplaintAnswer(userMessage, safeHistory = []) {
  const msg = String(userMessage || "").trim();
  if (!isPatientComplaintQuery(msg, safeHistory)) return null;

  const prior = findPriorComplaintMessage(safeHistory, msg);
  const lastAssistant = findLastAssistantMessage(safeHistory);

  // 継続：謝罪拒否・説明要求・改善要求
  if (isComplaintFollowUpCue(msg) && prior) {
    return buildFollowUpAnswer(msg, prior, lastAssistant);
  }

  // 継続中に改善要望が単独で来た場合（内容クレーム扱いでも prior がある）
  if (
    prior &&
    /改善して|改善してほしい|改善してください/.test(msg) &&
    msg.length <= 40
  ) {
    return buildFollowUpAnswer(msg, prior, lastAssistant);
  }

  const aspects = extractComplaintAspects(msg);
  return buildInitialCompoundAnswer(msg, aspects);
}
