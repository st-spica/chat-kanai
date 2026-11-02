/**
 * 現在の患者発言だけを見る緊急症状の判定。
 *
 * 「39」を数字の部分一致で拾わない。
 * 電話番号 06-6931-2391 の「2391」は熱の 39 度ではない。
 * 否定されている症状（〜ありません）は緊急にしない。
 */

/**
 * 一致位置の直後が否定か。
 * 「かもしれません」は否定にしない。
 * @param {string} text
 * @param {number} start
 * @param {number} length
 */
export function isNegatedAt(text, start, length) {
  const tail = String(text || "").slice(start + length, start + length + 24);
  if (/^(?:した)?かもしれません|^(?:した)?かもしれない|^かも(?!う)/.test(tail)) {
    return false;
  }
  return /^(?:し(?:て(?:い)?|た))?ません|^(?:は|では|では)?ありません|^ではありません|^くありません|^くない|^ではない|^じゃない|^して(?:い)?ない|^はない|^ないです|^ありません|^ません/.test(
    tail
  );
}

const SYMPTOM_RULES = [
  { rule: "heavy_bleeding", re: /大量出血|大量.{0,6}出血|血が止まら/g },
  { rule: "lever_clot", re: /レバー状/g },
  { rule: "severe_pain", re: /強い腹痛|激しい腹痛|耐えられない痛み|胸が痛い/g },
  { rule: "consciousness", re: /意識がもうろう|意識.{0,8}もうろう|もうろう/g },
  { rule: "seizure", re: /けいれん/g },
  { rule: "breathing", re: /呼吸が苦しい|呼吸困難/g },
  { rule: "high_fever_word", re: /高熱/g },
  { rule: "rupture", re: /破水した|破水/g },
  { rule: "fetal_movement", re: /胎動が少ない|胎動ない|胎動減少|胎動が(?:少|ない|減)/g },
  { rule: "syncope", re: /失神/g },
  { rule: "allergy_swelling", re: /顔.{0,6}腫れ|喉.{0,6}腫れ/g },
];

/**
 * 39 を体温として見る。前後が数字の「2391」などは除外する。
 * @param {string} text
 * @returns {{ rule: string, start: number, length: number }|null}
 */
function matchTemperature(text) {
  const patterns = [
    /熱.{0,8}(39(?:\.\d)?)(?!\d)/g,
    /(?:^|[^\d])(39(?:\.\d)?)(?!\d)\s*(?:度|℃|°|ど)/g,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (!m) continue;
    const digit = m[1];
    const start = m.index + m[0].indexOf(digit);
    if (isNegatedAt(text, start, digit.length)) continue;
    return { rule: "temperature_39", start, length: digit.length };
  }
  return null;
}

/**
 * @param {string} text
 * @returns {{ rule: string, reason: string }[]}
 */
function rejectedEmbedded39(text) {
  const raw = String(text || "");
  if (!/(?<=\d)39|39(?=\d)/.test(raw)) return [];
  if (matchTemperature(raw)) return [];
  return [{ rule: "39", reason: "embedded_in_longer_number" }];
}

/**
 * 現在の発言テキストだけを判定する。履歴やシステム文は渡さない。
 * @param {string} text
 * @returns {{
 *   emergency: boolean,
 *   rule: string|null,
 *   matchStart: number|null,
 *   matchLength: number|null,
 *   textKind: "current_user_message",
 *   rejected: { rule: string, reason: string }[],
 * }}
 */
export function explainEmergencyKeywords(text) {
  const raw = String(text || "");
  const rejected = rejectedEmbedded39(raw);
  const temperature = matchTemperature(raw);
  if (temperature) {
    return {
      emergency: true,
      rule: temperature.rule,
      matchStart: temperature.start,
      matchLength: temperature.length,
      textKind: "current_user_message",
      rejected,
    };
  }
  for (const item of SYMPTOM_RULES) {
    item.re.lastIndex = 0;
    let m;
    while ((m = item.re.exec(raw))) {
      if (isNegatedAt(raw, m.index, m[0].length)) {
        rejected.push({ rule: item.rule, reason: "negated" });
        continue;
      }
      return {
        emergency: true,
        rule: item.rule,
        matchStart: m.index,
        matchLength: m[0].length,
        textKind: "current_user_message",
        rejected,
      };
    }
  }
  return {
    emergency: false,
    rule: null,
    matchStart: null,
    matchLength: null,
    textKind: "current_user_message",
    rejected,
  };
}
