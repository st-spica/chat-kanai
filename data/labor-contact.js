/**
 * 陣痛開始後の病院連絡タイミング（院内基準）
 *
 * 初産婦: 規則的な陣痛が10分間隔
 * 経産婦: 規則的な陣痛が15分間隔
 * 破水・出血・胎動減少などは間隔を待たず連絡
 */

/** @typedef {"primipara"|"multipara"|null} Parity */
/** @typedef {"urgent"|"contact_now"|"information"} LaborSafetyLevel */

/**
 * @typedef {{
 *   answer: string,
 *   intent: string,
 *   parity: Parity,
 *   contractionInterval: number|null,
 *   medicalSafetyLevel: LaborSafetyLevel,
 * }} LaborContactAnswer
 */

const CLINIC_PHONE = "06-6931-2391（番号非通知は不可）";

const LABOR_TOPIC_RE =
  /陣痛|子宮収縮|破水|胎動|入院.?連絡|いつ(?:電話|連絡|入院)|何分間隔|分間隔|分おき|早めに(?:来る|来て|入院)|早く来るように|早めの入院/;

/**
 * @param {string} text
 */
export function mentionsLaborContactTopic(text) {
  const t = String(text || "");
  // 陣痛バッグ・持ち物は別意図
  if (/陣痛バッグ|入院バッグ|持ち物/.test(t) && !/陣痛が|陣痛は|破水|胎動/.test(t)) {
    return false;
  }
  if (LABOR_TOPIC_RE.test(t)) return true;
  if (/出血|血が(?:多い|出)/.test(t) && /妊娠|陣痛|破水|出産|お腹|おなか|おりもの/.test(t)) {
    return true;
  }
  // 単独の破水・胎動・多量出血も産科緊急として扱う
  if (/破水|胎動が(?:少|ない|減)|胎動減少|大量出血|出血が多|生理以上/.test(t)) {
    return true;
  }
  // 医師の早め入院指示
  if (/医師.{0,16}(?:早め|早く).{0,10}(?:来|入院|連絡)/.test(t)) {
    return true;
  }
  return false;
}

/**
 * 明確な別話題（体重・逆子・費用など）なら陣痛扱いにしない
 * @param {string} msg
 */
function isClearOtherTopicMessage(msg) {
  return (
    (/体重|太り|太っ|BMI|ダイエット|何\s*(?:kg|キロ)|増えすぎ|セーフ/.test(msg) &&
      !/陣痛|破水/.test(msg)) ||
    (/さかご|逆子|骨盤位|外回転/.test(msg) && !/陣痛/.test(msg)) ||
    /キッズルーム|予約金|分娩費用|入院費|つわり|悪阻|葉酸/.test(msg)
  );
}

/**
 * @param {string} userMessage
 * @param {string} [contextText]
 */
export function isLaborHospitalContactQuery(userMessage, contextText = "") {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;

  // 骨盤位文脈の破水等は breech 側へ
  if (/さかご|逆子|骨盤位|外回転/.test(msg)) return false;
  // 体重など明確な別話題は履歴があっても陣痛にしない
  if (isClearOtherTopicMessage(msg)) return false;
  // 「今すぐ連絡したい」だけの一般連絡は appointment-guidance 側へ
  if (
    /今すぐ|すぐに|至急/.test(msg) &&
    /連絡|電話/.test(msg) &&
    !/陣痛|破水|胎動|出血|間隔|初産|経産/.test(msg)
  ) {
    return false;
  }

  if (mentionsLaborContactTopic(msg)) return true;

  const ctx = String(contextText || "");
  if (!mentionsLaborContactTopic(ctx)) return false;

  // 直前が陣痛相談で、初産/経産・間隔・恐れの短い続きのみ
  // ※ msg.length だけで広く拾わない（話題変更の誤検知防止）
  return (
    (/初産|経産|初めての(?:ご)?出産|2人目|3人目|一人目|ふたりめ|\d+\s*分\s*(?:間隔|おき)|間隔です|規則的|不規則/.test(
      msg
    ) ||
      /怖い|不安|行けない|行きたくない|迷って|どうしよう|でも.{0,8}(?:病院|行く|連絡)/.test(
        msg
      )) &&
    msg.length <= 60
  );
}

/**
 * @param {Array<{role?:string,content?:string}>} safeHistory
 * @param {string} userMessage
 */
export function laborContactContextText(safeHistory, userMessage = "") {
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
 * ユーザー発話のみ（アシスタントの「初産婦は10分間隔」等を状態と誤認しない）
 * @param {Array<{role?:string,content?:string}>} safeHistory
 * @param {string} userMessage
 */
export function laborUserTurnsText(safeHistory, userMessage = "") {
  const parts = [];
  for (const h of safeHistory || []) {
    if (h?.role === "user") parts.push(String(h.content || ""));
  }
  if (userMessage) parts.push(String(userMessage));
  return parts.join("\n").slice(-4000);
}

/**
 * @param {string} text
 * @returns {Parity}
 */
export function parseParity(text) {
  const s = String(text || "");
  if (
    /初産婦|初産|初めての(?:ご)?出産|はじめての(?:ご)?出産|一人目|1人目|１人目|初回の出産/.test(
      s
    )
  ) {
    return "primipara";
  }
  if (
    /経産婦|経産|2人目|３人目|3人目|二人目|三人目|ふたりめ|出産経験|前の子|前回の出産|経産婦さん/.test(
      s
    )
  ) {
    return "multipara";
  }
  return null;
}

/**
 * @param {string} text
 * @returns {number|null}
 */
export function parseContractionInterval(text) {
  const s = String(text || "");
  const m =
    s.match(/(\d{1,2})\s*分\s*(?:間隔|おき|ごと|毎)/) ||
    s.match(/(?:間隔|おき)\s*(?:が|は)?\s*(\d{1,2})\s*分/) ||
    s.match(/(\d{1,2})\s*ふん\s*(?:かんかく|おき)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1 || n > 60) return null;
  return n;
}

/**
 * @param {string} msg
 */
function isLifeThreatening(msg) {
  return (
    /意識がもうろう|もうろうと|失神|呼吸困難|息ができない|血が止まら|大量出血|レバー状/.test(
      msg
    )
  );
}

/**
 * @param {string} msg
 */
function hasRupture(msg) {
  return /破水|水が(?:出|漏れ)|羊水/.test(msg);
}

/**
 * @param {string} msg
 */
function hasHeavyBleeding(msg) {
  return (
    /大量出血|出血が多|血が多|生理以上|レバー状|血が止まら/.test(msg) ||
    (/出血|血が出/.test(msg) && !/少量|ちょっと|ピンク|茶色のおりもの/.test(msg))
  );
}

/**
 * @param {string} msg
 */
function hasDecreasedFetalMovement(msg) {
  return /胎動が(?:少|ない|減)|胎動減少|胎動が減|胎動を感じな/.test(msg);
}

/**
 * @param {string} msg
 */
function hasDoctorEarlyInstruction(msg) {
  return /医師.{0,12}(?:早め|早く).{0,8}(?:来|入院|連絡)|早めに(?:来る|来て|入院)|早く来るように|個別.{0,6}指示/.test(
    msg
  );
}

/**
 * @param {string} msg
 */
function hasStrongPainIrregular(msg) {
  return (
    (/不規則/.test(msg) && /痛|強い|つらい|激しい/.test(msg)) ||
    /痛みが強い|強い痛み|激しい腹痛|強い腹痛|規則的な強い/.test(msg)
  );
}

/**
 * @param {Parity} parity
 * @param {number} interval
 */
function shouldContactByInterval(parity, interval) {
  if (interval == null) return false;
  if (interval <= 5) return true; // どの場合も連絡
  if (parity === "primipara") return interval <= 10;
  if (parity === "multipara") return interval <= 15;
  // 不明でも10分以下は連絡を妨げない
  if (interval <= 10) return true;
  return false;
}

/**
 * @returns {LaborContactAnswer}
 */
function callNowAnswer(leadLines, parity, interval, level = /** @type {LaborSafetyLevel} */ ("contact_now")) {
  const body = leadLines.filter(Boolean).join("\n");
  const needsCallLine = !/お電話|ご連絡ください/.test(body);
  return {
    answer: [
      body,
      "",
      needsCallLine
        ? "チャットでの相談を続けず、今すぐお電話でご連絡ください。"
        : "チャットでの相談を続けず、現在の状況を病院へお伝えください。",
      `当院：${CLINIC_PHONE}`,
    ].join("\n"),
    intent: "labor_hospital_contact",
    parity,
    contractionInterval: interval,
    medicalSafetyLevel: level,
  };
}

/**
 * @param {string} userMessage
 * @param {Array<{role?:string,content?:string}>} [safeHistory]
 * @returns {LaborContactAnswer|null}
 */
export function buildLaborHospitalContactAnswer(userMessage, safeHistory = []) {
  const msg = String(userMessage || "").trim();
  const ctx = laborContactContextText(safeHistory, userMessage);
  const userCtx = laborUserTurnsText(safeHistory, userMessage);
  if (!isLaborHospitalContactQuery(msg, ctx) && !isLaborHospitalContactQuery(msg, userCtx)) {
    // 緊急継続（直前ユーザーが破水等）は履歴参照で通す
    const priorUsers = laborUserTurnsText(safeHistory, "");
    if (
      !(
        /怖い|不安|行けない|でも.{0,8}病院/.test(msg) &&
        /破水|出血が多|胎動が(?:少|ない|減)/.test(priorUsers)
      )
    ) {
      return null;
    }
  }

  // 初産/間隔はユーザー発話からのみ（AI目安文の「10分間隔」を患者状態としない）
  const parity = parseParity(msg) ?? parseParity(userCtx);
  const interval =
    parseContractionInterval(msg) ?? parseContractionInterval(userCtx);

  // 直前の破水等が続き、恐れ・迷いだけの発言 → 連絡優先を維持
  if (
    !hasRupture(msg) &&
    !hasHeavyBleeding(msg) &&
    !hasDecreasedFetalMovement(msg) &&
    /怖い|不安|行けない|行きたくない|迷って|どうしよう|でも.{0,8}(?:病院|行く|連絡)/.test(
      msg
    ) &&
    /破水|出血が多|胎動が(?:少|ない|減)/.test(userCtx)
  ) {
    if (/破水/.test(userCtx)) {
      return {
        answer: [
          "破水の疑いがある状況は続いているため、不安でも病院へのご連絡を優先してください。",
          "陣痛がなくても、すぐに当院へお電話ください。",
          "清潔なナプキンを当て、入浴やビデの使用は控えてください。",
          "",
          `当院：${CLINIC_PHONE}`,
        ].join("\n"),
        intent: "labor_hospital_contact",
        parity,
        contractionInterval: interval,
        medicalSafetyLevel: "urgent",
      };
    }
    return callNowAnswer(
      [
        "先ほどお伝えいただいた症状は、まだ確認が必要な可能性があります。",
        "不安なときでも、チャットを続けず当院へお電話ください。",
      ],
      parity,
      interval,
      "urgent"
    );
  }

  // 生命危険 → 119
  if (isLifeThreatening(msg)) {
    return {
      answer: [
        "今の症状からは、速やかな対応が必要です。",
        "ただちに119番へ連絡し、あわせて当院にもお電話ください。",
        `当院：${CLINIC_PHONE}`,
      ].join("\n"),
      intent: "labor_hospital_contact",
      parity,
      contractionInterval: interval,
      medicalSafetyLevel: "urgent",
    };
  }

  // 破水
  if (hasRupture(msg)) {
    return {
      answer: [
        "破水したかもしれないのですね。",
        "",
        "陣痛がなくても、すぐに当院へお電話ください。",
        "清潔なナプキンを当て、入浴やビデの使用は控えてください。",
        "",
        `当院：${CLINIC_PHONE}`,
      ].join("\n"),
      intent: "labor_hospital_contact",
      parity,
      contractionInterval: interval,
      medicalSafetyLevel: "urgent",
    };
  }

  // 出血
  if (hasHeavyBleeding(msg)) {
    return {
      answer: [
        "出血があるとのこと、すぐに当院へお電話ください。",
        "量や色の判断はこちらではできませんので、チャットを続けず病院へ現在の状況をお伝えください。",
        "",
        `当院：${CLINIC_PHONE}`,
      ].join("\n"),
      intent: "labor_hospital_contact",
      parity,
      contractionInterval: interval,
      medicalSafetyLevel: "urgent",
    };
  }

  // 胎動減少
  if (hasDecreasedFetalMovement(msg)) {
    return {
      answer: [
        "胎動が少ないとのこと、速やかな確認が必要です。",
        "陣痛の間隔を待たず、すぐに当院へお電話ください。",
        "",
        `当院：${CLINIC_PHONE}`,
      ].join("\n"),
      intent: "labor_hospital_contact",
      parity,
      contractionInterval: interval,
      medicalSafetyLevel: "urgent",
    };
  }

  // 医師の早め入院指示
  if (hasDoctorEarlyInstruction(msg)) {
    return callNowAnswer(
      [
        "医師から早めに来るよう指示を受けているのですね。",
        "一般的な陣痛間隔より、医師の個別指示を優先してください。",
        "指示どおり、今すぐ当院へご連絡・ご来院ください。",
      ],
      parity,
      interval,
      "contact_now"
    );
  }

  // 強い痛み（不規則でも連絡を妨げない）
  if (hasStrongPainIrregular(msg)) {
    return callNowAnswer(
      [
        "痛みが強いとのこと、心配になりますよね。",
        "陣痛の間隔が不規則でも、症状が強いときは間隔を待たずご連絡ください。",
      ],
      parity,
      interval,
      "urgent"
    );
  }

  // 一般的な「いつ電話」ガイド（間隔・緊急症状なし）
  const isTimingGuide =
    /いつ(?:電話|連絡|入院)|何分間隔|何分で|連絡すれば|電話すれば|どうすれば/.test(
      msg
    ) ||
    (/初産|経産/.test(msg) && /何分|いつ|連絡|電話/.test(msg));

  // 間隔に基づく連絡判定
  if (interval != null && shouldContactByInterval(parity, interval)) {
    if (parity === "primipara") {
      return callNowAnswer(
        [
          `初めてのご出産で、陣痛が${interval}分間隔になっているのですね。`,
          "当院への連絡の目安に達していますので、今すぐお電話でご連絡ください。",
        ],
        parity,
        interval
      );
    }
    if (parity === "multipara") {
      return callNowAnswer(
        [
          `経産婦さんで、陣痛が${interval}分間隔になっているのですね。`,
          "当院への連絡の目安に達していますので、今すぐお電話でご連絡ください。",
        ],
        parity,
        interval
      );
    }
    //  parity不明だが間隔が短い
    return callNowAnswer(
      [
        `陣痛が${interval}分間隔になっているのですね。`,
        "すぐに当院へお電話ください。",
      ],
      parity,
      interval
    );
  }

  // 初産・経産それぞれの基準を尋ねられた
  if (/初産/.test(msg) && /何分|いつ|連絡|電話/.test(msg) && interval == null) {
    return {
      answer: [
        "初めてのご出産（初産婦）の場合、当院では規則的な陣痛が10分間隔になった頃を病院へのご連絡の目安としています。",
        "",
        "破水や出血、胎動の減少がある場合は、陣痛の間隔を待たずにご連絡ください。",
        `当院：${CLINIC_PHONE}`,
      ].join("\n"),
      intent: "labor_hospital_contact",
      parity: "primipara",
      contractionInterval: null,
      medicalSafetyLevel: "information",
    };
  }

  if (
    (/経産|2人目|二人目/.test(msg) && /何分|いつ|連絡|電話/.test(msg) && interval == null) ||
    (/経産婦/.test(msg) && /何分|間隔/.test(msg))
  ) {
    return {
      answer: [
        "出産経験のある方（経産婦）の場合、当院では規則的な陣痛が15分間隔になった頃を病院へのご連絡の目安としています。",
        "",
        "破水や出血、胎動の減少がある場合は、陣痛の間隔を待たずにご連絡ください。",
        `当院：${CLINIC_PHONE}`,
      ].join("\n"),
      intent: "labor_hospital_contact",
      parity: "multipara",
      contractionInterval: null,
      medicalSafetyLevel: "information",
    };
  }

  // 間隔はあるが閾値未達（例: 20分）
  if (interval != null && !shouldContactByInterval(parity, interval)) {
    if (parity == null) {
      return {
        answer: [
          `陣痛が${interval}分間隔とのことですね。`,
          "",
          "当院では、初めてのご出産の方は10分間隔、出産経験のある方は15分間隔になった頃をご連絡の目安としています。",
          "初めてのご出産でしょうか？それとも出産経験がありますか？",
          "",
          "破水・出血・胎動の減少や、痛みが強い場合は間隔を待たずご連絡ください。",
          `当院：${CLINIC_PHONE}`,
        ].join("\n"),
        intent: "labor_hospital_contact",
        parity: null,
        contractionInterval: interval,
        medicalSafetyLevel: "information",
      };
    }
    const threshold = parity === "primipara" ? 10 : 15;
    const parityLabel =
      parity === "primipara" ? "初めてのご出産の方" : "出産経験のある方";
    return {
      answer: [
        `${parityLabel}で、陣痛が${interval}分間隔とのことですね。`,
        "",
        `当院の目安は規則的な陣痛が${threshold}分間隔になった頃です。`,
        "まだ目安より間隔が空いている場合も、破水・出血・胎動の減少や痛みが強いときはすぐにご連絡ください。",
        "外来で早めの入院を指示されている場合は、その指示を優先してください。",
        `当院：${CLINIC_PHONE}`,
      ].join("\n"),
      intent: "labor_hospital_contact",
      parity,
      contractionInterval: interval,
      medicalSafetyLevel: "information",
    };
  }

  // 一般ガイド
  if (isTimingGuide || /陣痛が(?:来|き)た|陣痛が始|陣痛かも|お腹の張りが規則/.test(msg)) {
    // 陣痛開始のみ → 初産/経産を安全に確認（緊急症状なし）
    if (
      /陣痛が(?:来|き)た|陣痛が始|陣痛かも|お腹の張り/.test(msg) &&
      !isTimingGuide &&
      parity == null &&
      interval == null
    ) {
      return {
        answer: [
          "陣痛が始まったのですね。",
          "初めてのご出産でしょうか？それとも出産経験がありますか？",
          "",
          "破水や出血、胎動の減少がある場合は、質問の前にすぐに当院へご連絡ください。",
          `当院：${CLINIC_PHONE}`,
        ].join("\n"),
        intent: "labor_hospital_contact",
        parity: null,
        contractionInterval: null,
        medicalSafetyLevel: "information",
      };
    }

    return {
      answer: [
        "当院では、陣痛が規則的になり、初めてのご出産の方は10分間隔、出産経験のある方は15分間隔になった頃を病院へご連絡いただく目安としています。",
        "",
        "破水や出血、胎動の減少がある場合は、陣痛の間隔を待たずにご連絡ください。",
        "外来で早めの入院を指示されている場合は、医師の個別指示を優先してください。",
        `当院：${CLINIC_PHONE}`,
      ].join("\n"),
      intent: "labor_hospital_contact",
      parity,
      contractionInterval: interval,
      medicalSafetyLevel: "information",
    };
  }

  // フォロー: 初産です / 経産です のみ
  if (parity != null && interval == null && msg.length <= 20) {
    const threshold = parity === "primipara" ? 10 : 15;
    const label =
      parity === "primipara" ? "初めてのご出産（初産婦）" : "出産経験のある方（経産婦）";
    return {
      answer: [
        `${label}なのですね。`,
        `当院では、規則的な陣痛が${threshold}分間隔になった頃をご連絡の目安としています。`,
        "",
        "いま陣痛は何分間隔くらいでしょうか？",
        "破水・出血・胎動の減少がある場合は間隔を待たずご連絡ください。",
        `当院：${CLINIC_PHONE}`,
      ].join("\n"),
      intent: "labor_hospital_contact",
      parity,
      contractionInterval: null,
      medicalSafetyLevel: "information",
    };
  }

  return {
    answer: [
      "当院では、規則的な陣痛が初産婦は10分間隔、経産婦は15分間隔になった頃を病院へのご連絡の目安としています。",
      "破水・出血・胎動の減少がある場合は、すぐにご連絡ください。",
      `当院：${CLINIC_PHONE}`,
    ].join("\n"),
    intent: "labor_hospital_contact",
    parity,
    contractionInterval: interval,
    medicalSafetyLevel: "information",
  };
}
