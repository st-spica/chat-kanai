/**
 * 産後の体重変化（分娩直後の減少・妊娠前への戻り）
 *
 * 妊娠中の体重増加（pregnancy-weight.js）と分離する。
 * 無理なダイエット・減量目標の断定はしない。
 */

/** @typedef {"urgent"|"consult"|"information"} PostpartumWeightSafetyLevel */

export const POSTPARTUM_WEIGHT_LOSS_INTENT = "postpartum_weight_loss";
export const POSTPARTUM_WEIGHT_RECOVERY_INTENT = "postpartum_weight_recovery";

const POSTPARTUM_TIME_RE =
  /分娩後|出産後|産後|出産した|産んだ|分娩した|赤ちゃんを産|お産のあと|お産の後/;

const LOSS_RE =
  /落ち|減る|減り|減っ|減量|やせ|痩せ|何\s*(?:kg|キロ)|どれくらい|どのくらい|何キロ/;

const RECOVERY_RE =
  /戻ら|戻り|戻る|戻せ|妊娠前.{0,8}体重|体重.{0,8}妊娠前|なかなか戻|いつ戻|元の体重/;

/**
 * 産後の体重減少・戻りか（妊娠中の増加相談ではない）
 * @param {string} userMessage
 */
export function isPostpartumWeightQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (!/体重|キロ|kg|ｋｇ|やせ|痩せ|落ち|減/.test(msg)) return false;

  // 妊娠中の増加が主旨なら除外
  if (
    /妊娠中|妊婦/.test(msg) &&
    /増え|増加|増えていい|何kg増|太り/.test(msg) &&
    !POSTPARTUM_TIME_RE.test(msg)
  ) {
    return false;
  }

  if (POSTPARTUM_TIME_RE.test(msg) && (/体重|キロ|kg|落ち|減|戻|やせ|痩せ/.test(msg))) {
    return true;
  }
  if (
    /出産|分娩|産んだ/.test(msg) &&
    /体重/.test(msg) &&
    LOSS_RE.test(msg)
  ) {
    return true;
  }
  return false;
}

/**
 * 出産直後の減少量の目安質問
 * @param {string} userMessage
 */
export function isPostpartumWeightLossQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isPostpartumWeightQuery(msg)) return false;
  if (isPostpartumWeightRecoveryQuery(msg) && !LOSS_RE.test(msg)) return false;
  // 戻り方が主でも「すぐ戻る？」は recovery
  if (
    RECOVERY_RE.test(msg) &&
    /なかなか|1か月|1ヶ月|一か月|一ヶ月|戻らな|戻りませ/.test(msg)
  ) {
    return false;
  }
  if (/すぐ.{0,8}戻|すぐに妊娠前|すぐ妊娠前/.test(msg)) {
    return false;
  }
  return LOSS_RE.test(msg) || /変わり|変化/.test(msg) || /減りますか|落ちますか/.test(msg);
}

/**
 * 産後の体重の戻り方
 * @param {string} userMessage
 */
export function isPostpartumWeightRecoveryQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isPostpartumWeightQuery(msg)) return false;
  return (
    RECOVERY_RE.test(msg) ||
    /すぐ.{0,8}戻|すぐに妊娠前|産後\s*\d+\s*(?:か|ヶ|カ)?月|産後1/.test(msg)
  );
}

/**
 * @param {string} userMessage
 */
export function buildPostpartumWeightAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isPostpartumWeightQuery(msg)) return null;

  if (isPostpartumWeightRecoveryQuery(msg)) {
    const soon = /すぐ|すぐに|すぐ戻/.test(msg);
    const month = /1か月|1ヶ月|一か月|一ヶ月|産後\s*1/.test(msg);
    return {
      answer: [
        soon
          ? "産後すぐに妊娠前の体重に戻るかどうか、気になりますよね。"
          : month
            ? "産後1か月で体重が戻りきらないとのこと、気になりますよね。"
            : "産後の体重の戻り方が気になっているのですね。",
        "",
        soon
          ? "出産直後に減るのは主に赤ちゃん・胎盤・羊水などの重さで、一般的に4〜6kg程度といわれることが多いです。"
          : "出産直後は赤ちゃん・胎盤・羊水などにより一般的に4〜6kg程度減ることがありますが、",
        soon
          ? "妊娠前の体重まで一気に戻るわけではなく、その後も水分の排出などで少しずつ変化していきます。"
          : "妊娠前の体重に戻るまでの期間には個人差があります。",
        "",
        "焦って食事を極端に減らしたり、急なダイエットをしたりすることはおすすめしません。",
        "授乳中や産後の体調を優先しながら、健診や医師のアドバイスに沿ってゆっくり整えていきましょう。",
        "強い不安や急な体重の変化がある場合は、当院へご相談ください。",
      ].join("\n"),
      intent: POSTPARTUM_WEIGHT_RECOVERY_INTENT,
      focus: soon ? "immediate_recovery" : month ? "one_month" : "recovery",
      medicalSafetyLevel: /** @type {PostpartumWeightSafetyLevel} */ (
        "information"
      ),
      suppressReferenceLinks: true,
    };
  }

  // 減少量の目安（デフォルト）
  return {
    answer: [
      "出産後にどれくらい体重が減るのか、",
      "気になりますよね。",
      "",
      "出産直後は、赤ちゃん・胎盤・羊水などの",
      "重さによって、一般的に4〜6kg程度",
      "体重が減ることがあります。",
      "",
      "その後も、妊娠中に増えた水分が",
      "排出されることで、産後数日から数週間かけて",
      "少しずつ体重が減っていくことがあります。",
      "",
      "体重の戻り方には個人差があるので、",
      "焦らず、まずは産後の体を",
      "ゆっくり休めてくださいね。",
    ].join("\n"),
    intent: POSTPARTUM_WEIGHT_LOSS_INTENT,
    focus: "immediate_loss",
    medicalSafetyLevel: /** @type {PostpartumWeightSafetyLevel} */ (
      "information"
    ),
    suppressReferenceLinks: true,
  };
}
