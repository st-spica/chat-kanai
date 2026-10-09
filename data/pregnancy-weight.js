/**
 * 妊娠中の体重増加・体重管理の確定案内
 *
 * BMI別の目安は院内資料に基づく。個別の適正体重・減量目標はAIが決定しない。
 * 責める表現・無理なダイエット推奨は禁止。
 */

/** @typedef {"urgent"|"consult"|"information"} WeightSafetyLevel */

/**
 * @typedef {{
 *   answer: string,
 *   intent: string,
 *   prePregnancyBMI: number|null,
 *   selectedWeightGuideline: string|null,
 *   medicalSafetyLevel: WeightSafetyLevel,
 * }} WeightAnswer
 */

const WEIGHT_TOPIC_RE =
  /体重|太り|太っ|やせ|痩せ|BMI|ｂｍｉ|ダイエット|体重管理|体重増加|食事管理|何\s*(?:kg|キロ|ｋｇ)|増えていい|増えて良い|(?:\d+\s*(?:kg|キロ|ｋｇ).{0,8}増)|(?:急に|急激|短期間).{0,12}増|増えすぎ|増えませ|増えない/;

/**
 * @param {string} text
 */
export function mentionsPregnancyWeightTopic(text) {
  const t = String(text || "");
  // 教室名だけの質問は prenatal-classes 側へ
  if (
    /マタニティヨーガ|マタニティヨガ|マタニティビクス|ママフィット|ママヨガ|産前教室|産後教室|後期クラス/.test(
      t
    ) &&
    !/体重|太り|BMI|ダイエット|増え/.test(t)
  ) {
    return false;
  }
  if (WEIGHT_TOPIC_RE.test(t)) return true;
  // 「妊娠中に運動」など体重管理文脈の運動（教室名なし）
  if (
    /妊娠中.{0,12}運動|運動.{0,12}妊娠/.test(t) &&
    !/マタニティ|教室|ヨーガ|ヨガ|ビクス/.test(t)
  ) {
    return true;
  }
  return false;
}

/**
 * @param {string} userMessage
 * @param {string} [contextText]
 */
export function isPregnancyWeightQuery(userMessage, contextText = "") {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;

  // つわり主体は morning-sickness 側へ
  if (/つわり|悪阻/.test(msg) && !/ダイエット|BMI|何(?:kg|キロ)|増えすぎ|太りすぎ/.test(msg)) {
    return false;
  }
  // 教室・運動可否は prenatal-classes 側へ
  if (
    /マタニティヨーガ|マタニティヨガ|マタニティビクス|ママフィット|ママヨガ|産前教室|産後教室|後期クラス|母親教室/.test(
      msg
    )
  ) {
    return false;
  }
  if (
    /妊娠中.{0,12}運動.{0,12}(?:大丈夫|いい|良い)|運動して(?:大丈夫|いい|良い)/.test(
      msg
    ) &&
    !/体重|BMI|ダイエット|太り/.test(msg)
  ) {
    return false;
  }
  // 陣痛・逆子など明確な別話題は履歴があっても体重にしない
  if (
    (/陣痛|破水|さかご|逆子|骨盤位|予約金|キッズルーム/.test(msg) &&
      !mentionsPregnancyWeightTopic(msg))
  ) {
    return false;
  }

  if (mentionsPregnancyWeightTopic(msg)) {
    // 妊娠・マタニティ文脈、または体重増加目安の明示
    if (
      /妊娠|妊婦|マタニティ|出産|赤ちゃん|健診/.test(msg) ||
      /BMI|体重増加|何\s*(?:kg|キロ|ｋｇ)|増えていい|増えて良い|増えすぎ|太りすぎ|ダイエット|体重管理|体重が増え|体重が減|増えませ|増えない/.test(
        msg
      )
    ) {
      return true;
    }
  }

  const ctx = String(contextText || "");
  if (!mentionsPregnancyWeightTopic(ctx)) return false;

  // 直前が体重相談で、BMI数値・身長体重だけ続く
  return (
    (/BMI|ｂｍｉ|\d{1,2}(?:\.\d+)?|身長|体重|cm|ｋｇ|kg|キロ/.test(msg) ||
      /普通体重|低体重|肥満|やせ|痩せ/.test(msg)) &&
    msg.length <= 40
  );
}

/**
 * @param {Array<{role?:string,content?:string}>} safeHistory
 * @param {string} userMessage
 */
export function pregnancyWeightContextText(safeHistory, userMessage = "") {
  const parts = [];
  for (const h of safeHistory || []) {
    if (h && (h.role === "user" || h.role === "assistant")) {
      parts.push(String(h.content || ""));
    }
  }
  parts.push(String(userMessage || ""));
  return parts.join("\n").slice(-4000);
}

/** ユーザー発話のみ */
export function pregnancyWeightUserTurnsText(safeHistory, userMessage = "") {
  const parts = [];
  for (const h of safeHistory || []) {
    if (h?.role === "user") parts.push(String(h.content || ""));
  }
  if (userMessage) parts.push(String(userMessage));
  return parts.join("\n").slice(-4000);
}

/**
 * @param {string} text
 * @returns {number|null}
 */
export function parsePrePregnancyBMI(text) {
  const s = String(text || "");

  // 明示 BMI
  let m =
    s.match(/BMI\s*(?:は|が|=|：|:)?\s*(\d{1,2}(?:\.\d+)?)/i) ||
    s.match(/ｂｍｉ\s*(?:は|が|=|：|:)?\s*(\d{1,2}(?:\.\d+)?)/i);
  if (m) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v >= 10 && v <= 50) return Math.round(v * 10) / 10;
  }

  // 「22です」「BMI22」フォロー（短い文）
  m = s.match(/(?:^|\n)\s*(?:BMI)?\s*(\d{1,2}(?:\.\d+)?)\s*(?:です|でした|だよ|だね)?\s*$/im);
  if (m && /BMI|体重|増え|太|ダイエット|目安/i.test(s)) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v >= 12 && v <= 45) return Math.round(v * 10) / 10;
  }

  // 身長・妊娠前体重から計算
  const heightM = parseHeightMeters(s);
  const weightKg = parsePrePregnancyWeightKg(s);
  if (heightM != null && weightKg != null) {
    const bmi = weightKg / (heightM * heightM);
    if (Number.isFinite(bmi) && bmi >= 10 && bmi <= 50) {
      return Math.round(bmi * 10) / 10;
    }
  }

  // カテゴリ表現
  if (/低体重|やせ型|痩せ型|やせ気味|痩せ気味/.test(s)) return 17.5;
  if (/普通体重|標準体重|ふつう体/.test(s)) return 22;
  if (/肥満|BMI\s*25\s*以上/.test(s) && !/30\s*以上/.test(s)) return 27;
  if (/BMI\s*30\s*以上|高度肥満/.test(s)) return 32;

  return null;
}

/**
 * @param {string} text
 * @returns {number|null}
 */
function parseHeightMeters(text) {
  const s = String(text || "");
  let m = s.match(/身長\s*(?:は|が)?\s*(\d{2,3}(?:\.\d+)?)\s*(?:cm|センチ|㎝)/i);
  if (m) {
    const cm = Number(m[1]);
    if (cm >= 120 && cm <= 200) return cm / 100;
  }
  m = s.match(/(\d{2,3}(?:\.\d+)?)\s*(?:cm|センチ|㎝)/i);
  if (m && /身長|cm|センチ/.test(s)) {
    const cm = Number(m[1]);
    if (cm >= 120 && cm <= 200) return cm / 100;
  }
  return null;
}

/**
 * @param {string} text
 * @returns {number|null}
 */
function parsePrePregnancyWeightKg(text) {
  const s = String(text || "");
  let m = s.match(
    /(?:妊娠前|妊娠前の|妊娠する前).{0,8}体重\s*(?:は|が)?\s*(\d{2,3}(?:\.\d+)?)\s*(?:kg|キロ|ｋｇ)?/i
  );
  if (m) {
    const kg = Number(m[1]);
    if (kg >= 30 && kg <= 150) return kg;
  }
  m = s.match(
    /体重\s*(?:は|が)?\s*(\d{2,3}(?:\.\d+)?)\s*(?:kg|キロ|ｋｇ).{0,12}妊娠前/i
  );
  if (m) {
    const kg = Number(m[1]);
    if (kg >= 30 && kg <= 150) return kg;
  }
  return null;
}

/**
 * @param {number} bmi
 */
export function selectWeightGuideline(bmi) {
  if (bmi == null || !Number.isFinite(bmi)) {
    return {
      id: "unknown",
      label: null,
      gainMin: null,
      gainMax: null,
      caution: true,
    };
  }
  if (bmi < 18.5) {
    return {
      id: "underweight_12_15",
      label: "低体重（BMI18.5未満）",
      gainMin: 12,
      gainMax: 15,
      caution: false,
    };
  }
  if (bmi < 25) {
    return {
      id: "normal_10_13",
      label: "普通体重（BMI18.5以上25未満）",
      gainMin: 10,
      gainMax: 13,
      caution: false,
    };
  }
  if (bmi < 30) {
    return {
      id: "overweight_7_10_with_caution",
      label: "BMI25以上",
      gainMin: 7,
      gainMax: 10,
      caution: true,
    };
  }
  return {
    id: "obese_bmi30plus_individual",
    label: "BMI30以上",
    gainMin: null,
    gainMax: null,
    caution: true,
  };
}

/**
 * @param {string} msg
 */
function isUrgentWeightRelated(msg) {
  return (
    /強い頭痛|激しい頭痛|頭痛が強い|頭が(?:割|痛).{0,6}強い/.test(msg) ||
    (/頭痛/.test(msg) && /体重|増え|むくみ|太/.test(msg)) ||
    /視界がチカチカ|目がチカチカ|見えにく|視野が|視覚|チカチカ/.test(msg) ||
    /息苦|呼吸が苦|呼吸困難/.test(msg) ||
    /意識がもうろう|もうろうと/.test(msg) ||
    /強い腹痛|激しい腹痛/.test(msg)
  );
}

/**
 * @param {string} msg
 */
function needsConsultWeight(msg) {
  return (
    /急に|急激|短期間|急増|一気に|いきなり/.test(msg) &&
      /(?:kg|キロ|ｋｇ|\d)\s*増|体重が増|増えました|増えた/.test(msg) ||
    /強いむくみ|むくみが強い|顔がむく|手足がむく|むくみがひど/.test(msg) ||
    /体重が減り続|減り続け|やせ続け|痩せ続け|体重が減ってい/.test(msg) ||
    /食事.{0,8}とれな|水分.{0,8}とれな|食べられな|飲めな/.test(msg)
  );
}

/**
 * @param {string} msg
 * @returns {string[]}
 */
function pickSelfCareTips(msg) {
  /** @type {string[]} */
  const tips = [];
  if (/運動|ヨガ|ヨーガ|ビクス|散歩/.test(msg)) {
    tips.push("体調に合った無理のない運動を取り入れる（医師確認のうえ）");
  }
  if (/食事|食べ|間食|ダイエット|栄養|外食/.test(msg)) {
    tips.push("栄養バランスを意識し、無理に食事を減らさない");
    tips.push("外食や加工食品に偏らないようにする");
  }
  if (/増えすぎ|太り|太っ|心配|管理/.test(msg)) {
    tips.push("週1回程度、できるだけ同じ条件で体重を確認する");
    if (tips.length < 3) tips.push("規則正しく食事をとる");
    if (tips.length < 3) tips.push("間食の内容や量を見直す");
  }
  if (/増えな|増えませ|増えない|少ない|やせ|痩せ|減/.test(msg)) {
    tips.push("無理のない範囲で規則正しく食事をとる");
    tips.push("必要に応じて食事を記録し、健診で相談する");
  }
  // デフォルト
  if (tips.length === 0) {
    tips.push("週1回程度、体重を確認する");
    tips.push("栄養バランスを意識する");
    tips.push("体調に合った運動を取り入れる（医師確認のうえ）");
  }
  // 重複除去して最大3
  return [...new Set(tips)].slice(0, 3);
}

/**
 * @param {number|null} bmi
 * @param {{id:string,label:string|null,gainMin:number|null,gainMax:number|null,caution:boolean}} guide
 */
function formatGuidelineAnswer(bmi, guide) {
  if (!guide || guide.id === "unknown") {
    return [
      "妊娠中の体重増加の目安は、妊娠前のBMIによって異なります。",
      "妊娠前のBMIがわかれば、一般的な体重増加の目安をご案内できます。",
      "個別の適正体重は健診時に医師と確認しましょう。",
    ].join("\n");
  }

  if (guide.id === "obese_bmi30plus_individual") {
    return [
      `妊娠前のBMIが${bmi}なのですね。`,
      "",
      "BMI30以上の場合は、一律の体重増加目標をあてはめず、個別の指導が必要です。",
      "院内資料の7〜10kgという目安をそのまま目標にはしませんので、健診時に医師へご相談ください。",
    ].join("\n");
  }

  if (guide.id === "overweight_7_10_with_caution") {
    return [
      `妊娠前のBMIが${bmi}なのですね。`,
      "",
      "BMI25以上の場合、院内資料では妊娠期間全体で7〜10kg程度の増加が目安として記載されています。",
      "ただしBMI25以上は個別の指導が大切ですので、健診時に医師と確認しましょう。",
    ].join("\n");
  }

  return [
    bmi != null ? `妊娠前のBMIが${bmi}なのですね。` : "",
    "",
    `${guide.label}の場合、妊娠期間全体で${guide.gainMin}〜${guide.gainMax}kg程度の体重増加が目安とされています。`,
    "ただし、妊娠経過によって適切な増え方は異なりますので、健診時に医師と確認しましょう。",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * @param {string} userMessage
 * @param {Array<{role?:string,content?:string}>} [safeHistory]
 * @returns {WeightAnswer|null}
 */
export function buildPregnancyWeightAnswer(userMessage, safeHistory = []) {
  const msg = String(userMessage || "").trim();
  const ctx = pregnancyWeightContextText(safeHistory, userMessage);
  if (!isPregnancyWeightQuery(msg, ctx)) return null;

  const userCtx = pregnancyWeightUserTurnsText(safeHistory, userMessage);
  let bmi = parsePrePregnancyBMI(msg);
  if (bmi == null && mentionsPregnancyWeightTopic(userCtx)) {
    const short = msg.match(
      /^\s*(?:BMI\s*)?(\d{1,2}(?:\.\d+)?)\s*(?:です|でした|だよ|だね)?\s*$/i
    );
    if (short) {
      const v = Number(short[1]);
      if (Number.isFinite(v) && v >= 12 && v <= 45) bmi = Math.round(v * 10) / 10;
    }
  }
  if (bmi == null && mentionsPregnancyWeightTopic(userCtx)) {
    bmi = parsePrePregnancyBMI(userCtx);
  }

  // 緊急症状（体重文脈でも受診優先）
  if (isUrgentWeightRelated(msg)) {
    let focus = "今の症状からは、";
    if (/頭痛/.test(msg)) focus = "頭痛があるとのこと、";
    else if (/チカチカ|見え|視野|視覚/.test(msg))
      focus = "視界の変化があるとのこと、";
    else if (/息苦|呼吸/.test(msg)) focus = "息苦しさがあるとのこと、";
    return {
      answer: [
        `${focus}体重の一般的なアドバイスより、速やかな確認が優先です。`,
        "我慢せず、すぐに当院へご連絡ください。夜間などで対応が必要と感じる場合は、119番も検討してください。",
        "当院：06-6931-2391（番号非通知は不可）",
      ].join("\n"),
      intent: "pregnancy_weight_management",
      prePregnancyBMI: bmi,
      selectedWeightGuideline: null,
      medicalSafetyLevel: "urgent",
    };
  }

  // 受診相談レベル
  if (needsConsultWeight(msg)) {
    const guide = selectWeightGuideline(bmi);
    const lines = [
      "短期間での体重の変化やむくみなどが気になるとのことですね。",
      "",
      "通常の体重管理のアドバイスより、健診や当院へのご相談を優先してください。",
      "妊娠高血圧症候群など、医師の確認が必要な場合もあります（診断は医師が行います）。",
    ];
    if (bmi != null && guide.id !== "unknown" && guide.id !== "obese_bmi30plus_individual") {
      lines.push(
        "",
        `参考までに、妊娠前BMIに応じた妊娠期間全体の増加目安は${guide.gainMin}〜${guide.gainMax}kg程度とされていますが、今の急な変化については医師へご確認ください。`
      );
    }
    return {
      answer: lines.join("\n"),
      intent: "pregnancy_weight_management",
      prePregnancyBMI: bmi,
      selectedWeightGuideline: guide.id,
      medicalSafetyLevel: "consult",
    };
  }

  // 運動一般（個別教室の案内は prenatal-classes 側。ここでは体重文脈のみ）
  if (/運動|散歩|体を動か/.test(msg)) {
    const tips = pickSelfCareTips(msg);
    return {
      answer: [
        "妊娠経過に問題がなければ、散歩などの無理のない運動が選択肢になります。",
        "運動を始める前に、現在の妊娠経過で行ってよいか医師に確認してください。",
        "",
        "産前産後の運動教室については、公式サイトの教室案内ページもご参照ください。",
        "",
        ...tips.map((t) => `・${t}`),
      ].join("\n"),
      intent: "pregnancy_weight_management",
      prePregnancyBMI: bmi,
      selectedWeightGuideline: null,
      medicalSafetyLevel: "information",
    };
  }

  // ダイエット
  if (/ダイエット|食事制限|痩せたい|やせたい|減量|体重を減ら/.test(msg)) {
    return {
      answer: [
        "体重の増加が気になっているのですね。",
        "",
        "妊娠中は赤ちゃんの成長に必要な栄養も大切なので、自己判断で食事を大きく減らしたり、無理なダイエットをしたりすることはおすすめできません。",
        "",
        "体重について心配なことがあれば、当院の健診でご相談ください。",
      ].join("\n"),
      intent: "pregnancy_weight_management",
      prePregnancyBMI: bmi,
      selectedWeightGuideline: null,
      medicalSafetyLevel: "information",
    };
  }

  // 体重が増えない・減っている
  if (/増えな|増えませ|増えない|増えません|体重が減|やせて|痩せて/.test(msg)) {
    const tips = pickSelfCareTips(msg);
    return {
      answer: [
        "体重の増え方が気になっているのですね。",
        "",
        "個人差がありますが、体重が増えにくい・減っている場合は、健診時に医師へ相談するのが安心です。",
        "無理にたくさん食べようとせず、とれるものを規則正しくとることが大切です。",
        "",
        ...tips.map((t) => `・${t}`),
      ].join("\n"),
      intent: "pregnancy_weight_management",
      prePregnancyBMI: bmi,
      selectedWeightGuideline: bmi != null ? selectWeightGuideline(bmi).id : "unknown",
      medicalSafetyLevel: "consult",
    };
  }

  // BMI明示 or カテゴリ → 目安案内
  if (bmi != null && (/BMI|ｂｍｉ|普通体重|低体重|肥満|やせ|痩せ|\d/.test(msg) || /何(?:kg|キロ)|目安|増えていい|増えすぎ|太り/.test(msg) || msg.length <= 20)) {
    const guide = selectWeightGuideline(bmi);
    // フォローで「22です」だけのときも
    if (
      /BMI|ｂｍｉ|普通体重|低体重|肥満|やせ|痩せ/.test(msg) ||
      /何(?:kg|キロ)|目安|増えていい/.test(msg) ||
      (msg.length <= 20 && /^\s*(?:BMI)?\s*\d{1,2}/.test(msg))
    ) {
      return {
        answer: formatGuidelineAnswer(bmi, guide),
        intent: "pregnancy_weight_management",
        prePregnancyBMI: bmi,
        selectedWeightGuideline: guide.id,
        medicalSafetyLevel: guide.id === "obese_bmi30plus_individual" ? "consult" : "information",
      };
    }
  }

  // 何kgまで / 目安
  if (/何(?:kg|キロ)|目安|どのくらい|どれくらい|増えていい|増えて良い/.test(msg)) {
    if (bmi != null) {
      const guide = selectWeightGuideline(bmi);
      return {
        answer: formatGuidelineAnswer(bmi, guide),
        intent: "pregnancy_weight_management",
        prePregnancyBMI: bmi,
        selectedWeightGuideline: guide.id,
        medicalSafetyLevel: "information",
      };
    }
    return {
      answer: [
        "妊娠中の体重増加の目安は、妊娠前のBMIによって異なります。",
        "",
        "BMI18.5未満：12〜15kg、BMI18.5以上25未満：10〜13kgが一般的な目安です。",
        "BMI25以上は個別指導が必要で、特にBMI30以上には一律の目標をあてはめません。",
        "",
        "妊娠前のBMIはわかりますか？",
      ].join("\n"),
      intent: "pregnancy_weight_management",
      prePregnancyBMI: null,
      selectedWeightGuideline: "unknown",
      medicalSafetyLevel: "information",
    };
  }

  // 増えすぎ・太りすぎ・心配（一般）
  if (/増えすぎ|太りすぎ|太って|太っ|心配|管理|増えました|増えて/.test(msg)) {
    const tips = pickSelfCareTips(msg);
    if (bmi != null) {
      const guide = selectWeightGuideline(bmi);
      return {
        answer: [
          formatGuidelineAnswer(bmi, guide),
          "",
          "食事は無理に減らさず、栄養バランスを意識してとることが大切です。",
          ...tips.slice(0, 2).map((t) => `・${t}`),
        ].join("\n"),
        intent: "pregnancy_weight_management",
        prePregnancyBMI: bmi,
        selectedWeightGuideline: guide.id,
        medicalSafetyLevel: "information",
      };
    }
    return {
      answer: [
        "妊娠中の体重の変化が気になっているのですね。",
        "",
        "妊娠中の体重増加の目安は、妊娠前のBMIによって異なります。",
        "食事は無理に減らさず、栄養バランスを意識してとることが大切です。",
        "",
        "妊娠前のBMIがわかれば、一般的な体重増加の目安をご案内できます。",
        "妊娠前のBMIはわかりますか？",
      ].join("\n"),
      intent: "pregnancy_weight_management",
      prePregnancyBMI: null,
      selectedWeightGuideline: "unknown",
      medicalSafetyLevel: "information",
    };
  }

  // BMIフォローのみ（会話継続）
  if (bmi != null) {
    const guide = selectWeightGuideline(bmi);
    return {
      answer: formatGuidelineAnswer(bmi, guide),
      intent: "pregnancy_weight_management",
      prePregnancyBMI: bmi,
      selectedWeightGuideline: guide.id,
      medicalSafetyLevel:
        guide.id === "obese_bmi30plus_individual" ? "consult" : "information",
    };
  }

  return {
    answer: [
      "妊娠中の体重については、妊娠前のBMIや妊娠経過に合わせて医師と確認することが大切です。",
      "妊娠前のBMIがわかれば、一般的な体重増加の目安をご案内できます。",
    ].join("\n"),
    intent: "pregnancy_weight_management",
    prePregnancyBMI: null,
    selectedWeightGuideline: "unknown",
    medicalSafetyLevel: "information",
  };
}
