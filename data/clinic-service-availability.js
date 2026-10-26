/**
 * 院内サービスの実施可否
 *
 * ① 実施が確認できる → 実施しています
 * ② 未実施が確認できる → 実施しておりません
 * ③ どちらも確認できない → 実施しているか確認できません
 *
 * 公式サイトに無いことだけでは②にしない。
 * 関連ページがあるだけでは①にしない。
 * 一般的な妊娠・出産・育児の相談は、ここへ入れない。
 */

const GENERIC_EVIDENCE_TOKEN =
  /^(教室|クラス|学級|コース|サービス|ページ|案内|予約|実施|当院|病院|診療|内容|詳細|ご案内)$/;

/**
 * 公式サイトに記載がないサービスを、実施の有無として聞いているか
 * @param {string} userMessage
 */
export function isUndocumentedServiceMetaQuery(userMessage) {
  const msg = String(userMessage || "");
  return /公式サイトに(?:は)?(?:記載|載って)(?:の)?ない|載っていないサービス|未掲載のサービス|サイトにないサービス/.test(
    msg
  );
}

/**
 * ページ本文が、質問されたサービスそのものの実施を述べているか。
 * 「教室のページがある」だけでは不可。
 * @param {string} userMessage
 * @param {string} pageText
 */
export function pageConfirmsNamedService(userMessage, pageText) {
  const hay = String(pageText || "");
  if (!hay.trim()) return false;
  const msg = String(userMessage || "")
    .replace(
      /(?:は)?(?:でき|対応|お願い|やって|してい|受けられ|実施してい|あり)ますか[？?]?/g,
      " "
    )
    .replace(/[？?！!。．、,…]/g, " ");
  const tokens = msg
    .split(/[\s\u3000のをにはがとでもからまでへやなど]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !GENERIC_EVIDENCE_TOKEN.test(t));
  const specific = tokens.filter((t) => t.length >= 3);
  if (!specific.length) return false;
  return specific.some((t) => hay.includes(t));
}

/**
 * 確認できない院内サービスへの案内。未実施とは断定しない。
 * @param {string} userMessage
 * @param {string} [serviceLabel]
 */
export function buildUnconfirmedClinicServiceAnswer(userMessage, serviceLabel = "") {
  const msg = String(userMessage || "").trim();
  if (isUndocumentedServiceMetaQuery(msg)) {
    return [
      "現在確認できる情報では、実施しているか確認できません。",
      "",
      "公式サイトや院内の登録情報にないサービスを、実施しているとはご案内できません。",
    ].join("\n");
  }
  const label = String(serviceLabel || "").trim();
  if (label && label.length >= 2 && label.length <= 40) {
    return `${label}については、現在確認できる情報では、実施しているか確認できません。`;
  }
  return "現在確認できる情報では、実施しているか確認できません。";
}
