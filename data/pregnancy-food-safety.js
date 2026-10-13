/**
 * 妊娠中の飲食物の安全性（生ハム・生もの等）
 *
 * 服薬相談・カフェイン相談と分離する。
 */

/** @typedef {"urgent"|"consult"|"information"} PregnancyFoodSafetyLevel */

export const PREGNANCY_FOOD_SAFETY_INTENT = "pregnancy_food_safety";

const CAFFEINE_DRINK_RE =
  /コーヒー|カフェイン|紅茶|エナジードリンク|エナドリ/;

const FOOD_SAFETY_RE =
  /生ハム|生もの|ナマモノ|刺身|サシミ|生卵|半熟卵|温玉|ゆで卵|レバー|チーズ|未加熱|加熱せず|パテ|スモークサーモン|なまもの|寿司|すし|魚の刺身|ソーセージ|アルコール|お酒|ビール|ワイン|日本酒|焼酎/;

const DRUG_WORD_RE =
  /薬|お薬|服用|内服|市販薬|処方薬|頭痛薬|風邪薬|胃薬/;

/**
 * @param {string} userMessage
 */
export function isPregnancyFoodSafetyQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (CAFFEINE_DRINK_RE.test(msg)) return false;
  if (DRUG_WORD_RE.test(msg)) return false;
  if (!FOOD_SAFETY_RE.test(msg)) return false;
  if (/食べ|食|たべ|摂|口に/.test(msg)) return true;
  if (/妊娠|妊婦/.test(msg) && FOOD_SAFETY_RE.test(msg)) return true;
  return false;
}

/**
 * @param {string} userMessage
 */
export function buildPregnancyFoodSafetyAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isPregnancyFoodSafetyQuery(msg)) return null;

  const isRawMeat =
    /生ハム|生もの|ナマモノ|刺身|なまもの|未加熱|加熱せず|パテ|スモークサーモン/.test(
      msg
    );
  const isAlcohol = /アルコール|お酒|ビール|ワイン|日本酒|焼酎/.test(msg);

  /** @type {string[]} */
  const lines = [];

  if (isRawMeat) {
    lines.push(
      "妊娠中に生ハムや生ものを食べてしまい、",
      "赤ちゃんへの影響が心配になったのですね。",
      ""
    );
  } else if (isAlcohol) {
    lines.push(
      "妊娠中にお酒を摂ってしまい、",
      "赤ちゃんへの影響が心配になったのですね。",
      ""
    );
  } else {
    lines.push(
      "妊娠中の食事について、",
      "ご心配ですよね。",
      ""
    );
  }

  lines.push(
    "妊娠中は、加熱が不十分な食品や生ものなど、",
    "食中毒や感染のリスクに注意が必要とされています。",
    "1回少量摂ったからといって、必ず問題が起きるわけではありません。",
    ""
  );

  lines.push(
    "今後は加熱して食べる、生ものを避けるなど、",
    "可能な範囲で気をつけると安心です。",
    "食べた内容や体調、妊娠週数が気になる場合は、当院へご相談ください。"
  );

  return {
    answer: lines.join("\n"),
    intent: PREGNANCY_FOOD_SAFETY_INTENT,
    medicalSafetyLevel: /** @type {PregnancyFoodSafetyLevel} */ (
      "information"
    ),
  };
}
