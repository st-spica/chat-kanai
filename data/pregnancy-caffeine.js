/**
 * 妊娠中のカフェイン摂取（コーヒー・紅茶・エナジードリンク等）
 *
 * 妊娠中の服薬相談・葉酸と混同しない。
 * 個別の安全性を断定せず、一般的な目安と過度な不安を避ける案内。
 */

/** @typedef {"urgent"|"consult"|"information"} PregnancyCaffeineSafetyLevel */

export const PREGNANCY_CAFFEINE_INTENT = "pregnancy_caffeine";

const CAFFEINE_DRINK_RE =
  /コーヒー|カフェイン|紅茶|烏龍|ウーロン|緑茶|お茶|抹茶|エナジードリンク|エナドリ|リポビタン|レッドブル|コーラ|ペプシ|カフェオレ|エスプレッソ|ラテ|アメリカーノ|ドリップ|インスタントコーヒー|カフェインレス|デカフェ|カフェラテ|モカ|カプチーノ/;

const DRUG_WORD_RE =
  /薬|お薬|服用|内服|市販薬|処方薬|頭痛薬|風邪薬|胃薬|解熱|鎮痛|飲み薬/;

/**
 * @param {string} userMessage
 */
export function isPregnancyCaffeineQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (DRUG_WORD_RE.test(msg) && !CAFFEINE_DRINK_RE.test(msg)) return false;
  if (CAFFEINE_DRINK_RE.test(msg)) return true;
  if (/カフェイン/.test(msg) && /妊娠|妊婦|赤ちゃん|胎児|影響|悪い|大丈夫|控え/.test(msg)) {
    return true;
  }
  return false;
}

/**
 * @param {string} msg
 */
function isLargeIntakeOrSymptoms(msg) {
  return (
    /大量|たくさん|飲みすぎ|飲み過ぎ|(?:[3-9]|十|何十)杯|動悸|心臓|息切れ|強い吐き気|激しい吐き気|眠れない|不眠が続/.test(
      msg
    ) && /コーヒー|カフェイン|紅茶|エナジー|飲/.test(msg)
  );
}

/**
 * @param {string} userMessage
 */
export function buildPregnancyCaffeineAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isPregnancyCaffeineQuery(msg)) return null;

  if (isLargeIntakeOrSymptoms(msg)) {
    return {
      answer: [
        "カフェインを多く摂取した、または体調に変化があるとのこと、心配ですよね。",
        "",
        "摂取量や体調によっては、医師に相談した方が安心な場合があります。",
        "気になる症状が続く場合は、我慢せず当院へご相談ください。",
      ].join("\n"),
      intent: PREGNANCY_CAFFEINE_INTENT,
      medicalSafetyLevel: /** @type {PregnancyCaffeineSafetyLevel} */ ("consult"),
    };
  }

  const drankRecently =
    /飲んでしま|飲んじゃ|飲みました|飲んだけ|1杯|一杯|少量|ちょっと/.test(msg);
  const askPermission = /飲んでも|飲んでいい|控えた方が|減らした方が|やめた方が/.test(
    msg
  );

  /** @type {string[]} */
  const lines = [];

  if (drankRecently && /コーヒー/.test(msg)) {
    lines.push(
      "妊娠中にコーヒーを飲んで、",
      "赤ちゃんへの影響が心配になったのですね。",
      ""
    );
  } else if (/エナジー|エナドリ/.test(msg)) {
    lines.push(
      "妊娠中にエナジードリンクを飲んで、",
      "赤ちゃんへの影響が心配になったのですね。",
      ""
    );
  } else if (/紅茶|お茶|緑茶/.test(msg)) {
    lines.push(
      "妊娠中にお茶を飲んで、",
      "カフェインや赤ちゃんへの影響が心配になったのですね。",
      ""
    );
  } else if (/カフェイン/.test(msg) && /悪い|影響|有害/.test(msg)) {
    lines.push(
      "妊娠中のカフェインが赤ちゃんに与える影響について、",
      "気になっているのですね。",
      ""
    );
  } else {
    lines.push(
      "妊娠中のカフェイン摂取について、",
      "ご心配ですよね。",
      ""
    );
  }

  lines.push(
    "コーヒーや紅茶などにはカフェインが含まれていますが、",
    "妊娠中に少量摂ったからといって、",
    "すぐに赤ちゃんに影響が出るわけではありませんので、",
    "過度に心配しなくても大丈夫ですよ。",
    ""
  );

  lines.push(
    "妊娠中はカフェインの摂りすぎに注意が必要です。",
    "一般的な目安として、1日200mg以下に抑える考え方があります。",
    "コーヒーの種類や抽出方法、量によって含有量は異なります。",
    ""
  );

  if (askPermission || drankRecently) {
    lines.push(
      "今後は量を控えめにしたり、",
      "カフェインレスの飲み物を選んだりすると安心です。",
      "摂取量や体調が気になる場合は、当院へご相談ください。"
    );
  } else {
    lines.push(
      "今後は量を控えめにしたり、",
      "カフェインレスの飲み物を選ぶことも選択肢のひとつです。",
      "摂取量や体調が気になる場合は、当院へご相談ください。"
    );
  }

  return {
    answer: lines.join("\n"),
    intent: PREGNANCY_CAFFEINE_INTENT,
    medicalSafetyLevel: /** @type {PregnancyCaffeineSafetyLevel} */ ("information"),
  };
}
