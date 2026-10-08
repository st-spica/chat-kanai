/**
 * 骨盤位（さかご・逆子）相談の確定案内
 *
 * 妊娠週数に応じて案内。体操・薬・外回転術の実施可否はAIが判断しない。
 * 帝王切開の一般相談とは混同しない。
 */

/** @typedef {"urgent"|"consult"|"information"} BreechSafetyLevel */

const BREECH_TOPIC_RE =
  /さかご|逆子|骨盤位|胎位|外回転|骨盤位整復|さかご体操|逆子体操/;

/**
 * @param {string} text
 */
export function mentionsBreechTopic(text) {
  return BREECH_TOPIC_RE.test(String(text || ""));
}

/**
 * 骨盤位相談か（帝王切開のみの一般質問は含めない）
 * @param {string} userMessage
 * @param {string} [contextText]
 */
export function isBreechPresentationQuery(userMessage, contextText = "") {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (mentionsBreechTopic(msg)) return true;
  const ctx = String(contextText || "");
  if (!mentionsBreechTopic(ctx)) return false;
  // 直前が骨盤位相談で、週数・帝王切開時期・体操などだけ続く
  return (
    /(?:妊娠)?\d{1,2}\s*週|何週|体操|外回転|帝王切開|自然分娩|普通分娩|治ら|不安|破水|出血|腹痛|胎動|張り/.test(
      msg
    ) && msg.length <= 40
  );
}

/**
 * @param {string} text
 * @returns {number|null}
 */
export function parseGestationalWeek(text) {
  const s = String(text || "");
  const m =
    s.match(/妊娠\s*(\d{1,2})\s*週/) ||
    s.match(/(?:^|[^\d])(\d{1,2})\s*週/) ||
    s.match(/(\d{1,2})\s*しゅう/);
  if (!m) return null;
  const w = Number(m[1]);
  if (!Number.isFinite(w) || w < 4 || w > 42) return null;
  return w;
}

/**
 * @param {Array<{role?:string,content?:string}>} safeHistory
 * @param {string} userMessage
 */
export function breechContextText(safeHistory, userMessage = "") {
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
function isUrgentBreechRelated(msg) {
  return (
    /破水|水が(?:出|漏れ)|出血|血が出|強い腹痛|激しい腹痛|規則的.{0,8}(?:お腹|おなか).{0,6}張|強い.{0,6}張|胎動が(?:少|ない|減)|胎動減少|胎動が減/.test(
      msg
    )
  );
}

/**
 * @param {string} userMessage
 * @param {Array<{role?:string,content?:string}>} [safeHistory]
 */
export function buildBreechPresentationAnswer(userMessage, safeHistory = []) {
  const msg = String(userMessage || "").trim();
  const ctx = breechContextText(safeHistory, userMessage);
  if (!isBreechPresentationQuery(msg, ctx)) return null;

  const week =
    parseGestationalWeek(msg) ?? parseGestationalWeek(ctx) ?? null;

  // 緊急症状（骨盤位文脈でも通常説明より優先）
  if (isUrgentBreechRelated(msg)) {
    let focus = "今の症状からは、";
    if (/破水/.test(msg)) focus = "破水が疑われるとのこと、";
    else if (/出血|血が/.test(msg)) focus = "出血があるとのこと、";
    else if (/胎動/.test(msg)) focus = "胎動が少ないとのこと、";
    else if (/腹痛|張/.test(msg)) focus = "お腹の痛みや張りが強いとのこと、";
    return {
      answer: [
        `${focus}速やかな確認が必要です。`,
        "我慢せず、すぐに当院へご連絡ください。夜間などで対応が必要と感じる場合は、119番も検討してください。",
        "当院：06-6931-2391（番号非通知は不可）",
      ].join("\n"),
      intent: "breech_presentation_consultation",
      gestationalWeek: week,
      medicalSafetyLevel: /** @type {BreechSafetyLevel} */ ("urgent"),
    };
  }

  // 外回転術
  if (/外回転|骨盤位整復/.test(msg)) {
    return {
      answer: [
        "当院では、妊娠36週になってもさかごの場合、外回転術（骨盤位整復術）を検討することがあります。",
        "",
        "お腹の外から赤ちゃんの向きを変える処置ですが、羊水が少ない場合や、赤ちゃん・お母さんの状態によっては実施できないことがあります。",
        "処置中に赤ちゃんの心拍が悪くなった場合は、緊急帝王切開となることもあります。",
        "",
        "実施の可否は医師が判断しますので、健診時にご相談ください。",
      ].join("\n"),
      intent: "breech_presentation_consultation",
      gestationalWeek: week,
      medicalSafetyLevel: /** @type {BreechSafetyLevel} */ ("information"),
    };
  }

  // さかご体操
  if (/体操|さかご体操|逆子体操/.test(msg)) {
    return {
      answer: [
        "当院では、妊娠週数が進んでもさかごが続く場合、外来でさかご体操について説明しています。",
        "",
        "自己判断で体操を始めず、医師の指示に従ってください。",
        "状況によっては、子宮収縮抑制剤を内服していただくこともあります（使用は医師が判断します）。",
      ].join("\n"),
      intent: "breech_presentation_consultation",
      gestationalWeek: week,
      medicalSafetyLevel: /** @type {BreechSafetyLevel} */ ("information"),
    };
  }

  // 帝王切開の時期
  if (/帝王切開.{0,12}いつ|手術.{0,8}いつ|いつ.{0,8}帝王切開|予定日の/.test(msg)) {
    return {
      answer: [
        "さかごが改善しない場合、当院では母子の安全のため帝王切開を行います。",
        "",
        "通常は出産予定日の1〜2週間前を目安に手術を行いますが、実際の日程は妊娠経過や医師の判断で決まります。",
      ].join("\n"),
      intent: "breech_presentation_consultation",
      gestationalWeek: week,
      medicalSafetyLevel: /** @type {BreechSafetyLevel} */ ("information"),
    };
  }

  // 自然分娩・普通分娩・帝王切開になるか
  if (/自然分娩|普通分娩|経腟|帝王切開になります|帝王切開ですか|改善しない/.test(msg)) {
    return {
      answer: [
        "さかごが改善しない場合、当院では母子の安全のため帝王切開を行います。",
        "",
        "通常は出産予定日の1〜2週間前を目安に手術を行います。詳しい方針は健診時に医師へご確認ください。",
      ].join("\n"),
      intent: "breech_presentation_consultation",
      gestationalWeek: week,
      medicalSafetyLevel: /** @type {BreechSafetyLevel} */ ("information"),
    };
  }

  // 週数あり：36週頃
  if (week != null && week >= 36) {
    return {
      answer: [
        `妊娠${week}週なのですね。`,
        "",
        "当院では、妊娠36週でもさかごの場合、外回転術を検討することがあります。",
        "ただし、赤ちゃんやお母さんの状態によって実施できない場合がありますので、健診時に医師へご相談ください。",
        "",
        "改善しない場合は、母子の安全のため帝王切開を行います。",
      ].join("\n"),
      intent: "breech_presentation_consultation",
      gestationalWeek: week,
      medicalSafetyLevel: /** @type {BreechSafetyLevel} */ ("consult"),
    };
  }

  // 週数あり：30週超〜35週
  if (week != null && week > 30) {
    return {
      answer: [
        `妊娠${week}週でさかごとのこと、心配になりますよね。`,
        "",
        "当院ではこの時期、外来でさかご体操について説明しています。",
        "状況によっては子宮収縮抑制剤を使うこともありますが、体操やお薬は自己判断で行わず、医師の指示に従ってください。",
      ].join("\n"),
      intent: "breech_presentation_consultation",
      gestationalWeek: week,
      medicalSafetyLevel: /** @type {BreechSafetyLevel} */ ("consult"),
    };
  }

  // 週数あり：〜30週
  if (week != null && week <= 30) {
    return {
      answer: [
        `妊娠${week}週でさかごと言われたのですね。`,
        "",
        "妊娠30週頃までは、さかごでも過度に心配する必要はありません。",
        "今後の健診で赤ちゃんの向きを確認していきますので、健診時に医師へご相談ください。",
      ].join("\n"),
      intent: "breech_presentation_consultation",
      gestationalWeek: week,
      medicalSafetyLevel: /** @type {BreechSafetyLevel} */ ("information"),
    };
  }

  // 週数不明：治らない・続いている（30週前の安心材料を先に出さない）
  if (/治ら|続い|改善しな/.test(msg)) {
    return {
      answer: [
        "さかごが続いているとのこと、心配になりますよね。",
        "",
        "当院では妊娠週数や赤ちゃんの状態に合わせて対応しています。",
        "今は妊娠何週頃でしょうか？",
      ].join("\n"),
      intent: "breech_presentation_consultation",
      gestationalWeek: null,
      medicalSafetyLevel: /** @type {BreechSafetyLevel} */ ("information"),
    };
  }

  // 週数不明：初回の不安・告知
  if (
    /言われ|不安|心配|さかごです|逆子です|骨盤位です/.test(msg) ||
    mentionsBreechTopic(msg)
  ) {
    return {
      answer: [
        "赤ちゃんがさかごと言われたのですね。心配になりますよね。",
        "",
        "妊娠30週頃までは、さかごでも過度に心配する必要はありません。",
        "当院では妊娠週数や赤ちゃんの状態に合わせて対応しています。",
        "",
        "今は妊娠何週頃でしょうか？",
      ].join("\n"),
      intent: "breech_presentation_consultation",
      gestationalWeek: null,
      medicalSafetyLevel: /** @type {BreechSafetyLevel} */ ("information"),
    };
  }

  return {
    answer: [
      "骨盤位（さかご）については、妊娠週数や赤ちゃんの状態に合わせて対応しています。",
      "今は妊娠何週頃でしょうか？健診時に医師へご相談ください。",
    ].join("\n"),
    intent: "breech_presentation_consultation",
    gestationalWeek: week,
    medicalSafetyLevel: /** @type {BreechSafetyLevel} */ ("information"),
  };
}
