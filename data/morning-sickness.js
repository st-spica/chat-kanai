/**
 * つわり（妊娠初期の吐き気・嘔吐等）相談の確定データと回答生成
 *
 * 診断名の断定・処方指示はしない。緊急性・受診優先は medicalSafety に従う。
 */

export const MORNING_SICKNESS_SELF_CARE = [
  {
    id: "hydration",
    title: "水分を少しずつとる",
    advice:
      "吐き気があるときは、水分をこまめに少量ずつとってみてください。飲めるもので水分補給してください。",
    relatedSymptoms: ["吐き気", "嘔吐", "水分不足"],
  },
  {
    id: "small_meals",
    title: "少量ずつ食べる",
    advice:
      "空腹で気分が悪くなる場合は、食べられるものを少量ずつ、回数を分けて口にしてみてください。",
    relatedSymptoms: ["空腹時の吐き気", "食欲不振"],
  },
  {
    id: "eat_when_possible",
    title: "食べられるときに食べる",
    advice:
      "無理に食べようとせず、食べられるときに、食べられるものを少しずつ口にしてみてください。",
    relatedSymptoms: ["食欲不振", "食べられない"],
  },
  {
    id: "rest",
    title: "無理をせず休む",
    advice: "無理をせず、休めるときは体を休めてください。",
    relatedSymptoms: ["疲労", "だるさ", "吐き気"],
  },
  {
    id: "food_preference",
    title: "食べやすいものを選ぶ",
    advice:
      "栄養バランスにこだわりすぎず、食べられるものを選んで、食べられる範囲で少量ずつとってみてください。",
    relatedSymptoms: ["食欲不振", "食べ物の好みの変化"],
  },
  {
    id: "food_temperature",
    title: "食べ物の温度を工夫する",
    advice:
      "温かい食べ物のにおいが気になる場合は、冷たいものや常温のものを試してみてください。",
    relatedSymptoms: ["においがつらい", "吐き気"],
  },
  {
    id: "refreshing_food",
    title: "さっぱりしたものを試す",
    advice:
      "食べられそうであれば、さっぱりしたものや酸味のあるものを試してみてください。",
    relatedSymptoms: ["食欲不振", "吐き気"],
  },
  {
    id: "avoid_smells",
    title: "苦手なにおいを避ける",
    advice:
      "苦手なにおいをできるだけ避けたり、換気したりすることも対策のひとつです。",
    relatedSymptoms: ["においがつらい", "吐き気"],
  },
  {
    id: "constipation",
    title: "便秘にも気をつける",
    advice:
      "便秘がある場合は、体調に合わせて水分や食物繊維をとってみてください。無理に食べる必要はありません。",
    relatedSymptoms: ["便秘", "お腹の張り"],
  },
];

export const MORNING_SICKNESS_COURSE =
  "つわりは妊娠16〜20週頃に落ち着くことが多いですが、個人差があります。";

/** @typedef {"urgent"|"consult"|"self_care"|"course_info"} MorningSicknessSafetyLevel */

const MAX_TIPS = 3;

/**
 * @param {string} text
 */
export function mentionsMorningSicknessTopic(text) {
  return /つわり|悪阻|妊娠.{0,10}(?:気持|むかつ|吐|吐き|吐き気|におい|食欲)/.test(
    String(text || "")
  );
}

const MORNING_SICKNESS_SYMPTOM_ALONE_RE =
  /食べ物を受け付け|吐き気が続|毎日吐|何度も吐|繰り返し吐|においが[つ辛]ら|食べ物のにおい|妊娠中で気持|妊娠中に食欲|水も飲め|水分がとれ|水分が取れ|水分もとれ|つわり/;

/**
 * @param {string} userMessage
 * @param {string} [contextText]
 */
export function isMorningSicknessQuery(userMessage, contextText = "") {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (mentionsMorningSicknessTopic(msg)) return true;
  if (MORNING_SICKNESS_SYMPTOM_ALONE_RE.test(msg)) return true;
  const ctx = String(contextText || "");
  if (!mentionsMorningSicknessTopic(ctx) && !/つわり|悪阻/.test(ctx)) {
    return false;
  }
  // 直前がつわり相談で、水分・食事・嘔吐などの続き
  return /(?:水|水分|飲め|食べ|吐|におい|便秘|体重|気持|むかつ|だる|休め|いつまで)/.test(
    msg
  );
}

/**
 * @param {string} msg
 */
function isUrgentMorningSickness(msg) {
  return /意識.{0,6}もうろう|もうろう|立てない|強い腹痛|激しい腹痛|大量.{0,4}出血|血が止ま/.test(
    msg
  );
}

/**
 * 受診案内を優先すべき症状
 * @param {string} msg
 */
function needsClinicConsult(msg) {
  return (
    /水分.{0,8}(?:とれ|取れ|飲め)(?:ない|ません)|水も(?:飲め|とれ|取れ)(?:ない|ません)|水が(?:飲め|とれ)(?:ない|ません)|飲め(?:ない|ません)|水分不足/.test(
      msg
    ) ||
    /(?:何度も|繰り返し|毎日|ずっと).{0,8}吐|吐.{0,8}(?:続け|止まら|何度|毎日)|毎日吐いて/.test(
      msg
    ) ||
    /尿(?:の)?量.{0,6}少|おしっこ.{0,6}出ない|尿が少ない/.test(msg) ||
    /体重が減|体重減少|やせてきた|痩せてきた/.test(msg) ||
    /日常生活.{0,8}支障|動けない|起き上がれない|仕事にならない/.test(msg) ||
    /食事がほとんどとれ|何も食べられ(?:ない|ません)|まったく食べられ(?:ない|ません)/.test(
      msg
    )
  );
}

/**
 * @param {string} msg
 * @returns {string[]} tip ids
 */
export function selectMorningSicknessTips(msg) {
  /** @type {string[]} */
  const ids = [];
  const add = (id) => {
    if (!ids.includes(id) && ids.length < MAX_TIPS) ids.push(id);
  };

  if (/便秘/.test(msg)) add("constipation");
  if (/におい|臭い|においが|臭いが/.test(msg)) {
    add("avoid_smells");
    add("food_temperature");
  }
  if (
    /食べられ|受け付け|食欲|食事がとれ|食事をとれ|食べれない|食べられませ/.test(
      msg
    )
  ) {
    add("eat_when_possible");
    add("small_meals");
    add("food_preference");
  }
  if (
    /吐|吐き|吐き気|むかつ|気持/.test(msg) &&
    !/食べられ|受け付け|におい/.test(msg)
  ) {
    add("hydration");
    add("eat_when_possible");
  }
  // におい・便秘など具体症状があるときは一般の「休息」を足しすぎない
  if (
    /辛い|つらい|ひどい|しんどい|疲|だる/.test(msg) &&
    !/におい|便秘|受け付け/.test(msg)
  ) {
    add("rest");
    add("eat_when_possible");
  }
  if (!ids.length) {
    add("rest");
    add("eat_when_possible");
    add("hydration");
  }
  return ids.slice(0, MAX_TIPS);
}

/**
 * @param {string[]} tipIds
 */
function tipsByIds(tipIds) {
  return tipIds
    .map((id) => MORNING_SICKNESS_SELF_CARE.find((t) => t.id === id))
    .filter(Boolean);
}

/**
 * @param {Array<{role?:string,content?:string}>} safeHistory
 * @param {string} userMessage
 */
export function morningSicknessContextText(safeHistory, userMessage = "") {
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
 * @param {string} userMessage
 * @param {Array<{role?:string,content?:string}>} [safeHistory]
 * @returns {{
 *   answer: string,
 *   intent: string,
 *   selectedSelfCareTips: {id:string,title:string}[],
 *   medicalSafetyLevel: MorningSicknessSafetyLevel,
 *   askFollowUp: boolean,
 * }|null}
 */
export function buildMorningSicknessAnswer(userMessage, safeHistory = []) {
  const msg = String(userMessage || "").trim();
  const ctx = morningSicknessContextText(safeHistory, userMessage);
  if (!isMorningSicknessQuery(msg, ctx)) return null;

  const hay = `${msg}\n${ctx}`;

  // 緊急（既存 detectEmergency と重複しうるが、明示案内）
  if (isUrgentMorningSickness(msg) || isUrgentMorningSickness(hay)) {
    return {
      answer: [
        "今の症状からは、緊急性が高い可能性があります。",
        "我慢せず、すぐに医療機関へご連絡ください。夜間などで対応が必要と感じる場合は、119番も検討してください。",
        "当院へのご相談は 06-6931-2391（番号非通知は不可）までお電話ください。",
      ].join("\n"),
      intent: "morning_sickness_consultation",
      selectedSelfCareTips: [],
      medicalSafetyLevel: "urgent",
      askFollowUp: false,
    };
  }

  // 受診優先
  if (needsClinicConsult(msg) || (needsClinicConsult(hay) && msg.length <= 40)) {
    let empathy = "つらくてお辛い状況なのですね。";
    if (/水|水分|飲め/.test(msg)) {
      empathy = "水分もとれない状態なのですね。";
    } else if (/吐/.test(msg)) {
      empathy = "何度も吐いてしまうほどつらいのですね。";
    } else if (/体重/.test(msg)) {
      empathy = "体重が減っているとのこと、心配ですよね。";
    } else if (/食べ/.test(msg)) {
      empathy = "食事がとれないほどつらいのですね。";
    }
    return {
      answer: [
        empathy,
        "脱水につながるおそれがあるため、我慢せず早めに当院へご連絡ください。",
      ].join("\n"),
      intent: "morning_sickness_consultation",
      selectedSelfCareTips: [],
      medicalSafetyLevel: "consult",
      askFollowUp: false,
    };
  }

  // 経過の質問
  if (/いつまで|いつ頃|どのくらい続|いつおさま|いつ治/.test(msg)) {
    return {
      answer: [
        MORNING_SICKNESS_COURSE,
        "",
        "症状が強い場合や、水分がとれない状態が続く場合は、無理をせず当院にご相談ください。",
      ].join("\n"),
      intent: "morning_sickness_consultation",
      selectedSelfCareTips: [],
      medicalSafetyLevel: "course_info",
      askFollowUp: false,
    };
  }

  const tipIds = selectMorningSicknessTips(msg);
  const tips = tipsByIds(tipIds);
  const askFollowUp =
    /^(つわりが?[辛つら]い|つわりがひどい|つわりがしんどい|吐き気が続|妊娠中で気持ち悪)/.test(
      msg.replace(/[！!？?。．\s　]+$/g, "")
    ) && tipIds.length <= 2;

  let empathy = "つわりがつらいのですね。";
  if (/におい/.test(msg)) empathy = "においがつらいのですね。";
  else if (/食べられ|受け付け|食欲/.test(msg)) {
    empathy = "食事がとれないほどつらいのですね。";
  } else if (/吐|吐き/.test(msg)) empathy = "気持ち悪さが続いてつらいのですね。";
  else if (/便秘/.test(msg)) empathy = "つわりの時期に便秘もあるのですね。";
  else if (/ひどい|しんどい/.test(msg)) {
    empathy = "つわりがとてもつらいのですね。";
  }

  const adviceLines = tips.map((t) => t.advice);
  /** @type {string[]} */
  const parts = [empathy, ""];
  if (/気持|むかつ|吐き/.test(msg) && /食べ|食事/.test(msg) === false) {
    parts.push("気持ち悪さが続くと、食事をとるのも大変ですよね。");
    parts.push("");
  }
  for (const line of adviceLines) {
    parts.push(line);
  }
  if (askFollowUp) {
    parts.push("");
    parts.push("食事や水分はとれていますか？");
  } else if (/食べられ|受け付け/.test(msg)) {
    parts.push("");
    parts.push("水分もとれない場合は、我慢せず当院にご相談ください。");
  }

  return {
    answer: parts.filter((p, i, arr) => !(p === "" && arr[i - 1] === "")).join("\n").trim(),
    intent: "morning_sickness_consultation",
    selectedSelfCareTips: tips.map((t) => ({ id: t.id, title: t.title })),
    medicalSafetyLevel: "self_care",
    askFollowUp,
  };
}
