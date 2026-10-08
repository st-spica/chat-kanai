/**
 * 母乳ケアの確定案内
 *
 * 公式: https://kanai.or.jp/aftersupport/#milkcare
 * 予約方法（電話のみ）と来院後の受付（再来機）を混同しない。
 * WEB予約・他診療の予約方法を適用しない。
 */

export const MILKCARE_REF_PAGE = {
  url: "https://kanai.or.jp/aftersupport/#milkcare",
  title: "母乳ケアについて",
};

export const MILKCARE_FETCH_URL = "https://kanai.or.jp/aftersupport/";

/** 院内確認・公式記載に基づく確定情報 */
export const MILKCARE = {
  serviceName: "母乳ケア",
  aliases: [
    "母乳ケア",
    "母乳相談",
    "母乳外来",
    "おっぱいケア",
    "授乳相談",
  ],
  schedule: "水・木・金・第2・4土曜日",
  location: "本館5F",
  duration: "約45分",
  priceYen: 3000,
  reservationRequired: true,
  reservationMethod: "telephone_only",
  webReservation: false,
  reception:
    "本館1階の再来機で受付をし、その後2階の待合でお待ちください。",
};

export const MILKCARE_RESERVATION_ANSWER = [
  "母乳ケアは完全予約制で、お電話でのみご予約を承っております。",
  "",
  "ご希望の方は、事前に当院までお電話にてご予約ください。",
  "",
  "詳しいご案内は、下記のページをご確認ください。",
].join("\n");

export const MILKCARE_WEB_RESERVATION_ANSWER = [
  "母乳ケアはWEB予約には対応しておらず、お電話でのみご予約を承っております。",
  "",
  "ご希望の方は、事前に当院までお電話にてご予約ください。",
  "",
  "詳しいご案内は、下記のページをご確認ください。",
].join("\n");

export const MILKCARE_RECEPTION_ANSWER = [
  "母乳ケアの予約当日は、本館1階の再来機で受付をし、その後2階の待合でお待ちください。",
  "",
  "なお、ご予約自体はお電話でのみ承っております（WEB予約・再来機での予約手続きはできません）。",
  "",
  "詳しいご案内は、下記のページをご確認ください。",
].join("\n");

/**
 * @param {string} text
 */
export function mentionsMilkcare(text) {
  const t = String(text || "");
  return /母乳ケア|母乳相談|母乳外来|おっぱいケア|授乳相談/.test(t);
}

/**
 * 産後ケア宿泊・服薬相談など、母乳ケア案内の対象外
 * @param {string} msg
 */
function isOtherMilkcareAdjacentTopic(msg) {
  // 服薬（授乳中の薬）は別モジュール
  if (/薬|内服|服用|処方/.test(msg) && /授乳|母乳/.test(msg)) return true;
  // 産後ケア宿泊・ショートステイ主体（母乳ケア言及なし）
  if (
    /産後ケア|ショートステイ|産後デイ/.test(msg) &&
    !mentionsMilkcare(msg)
  ) {
    return true;
  }
  // 母乳が出ない等の症状相談のみ（予約・料金・曜日・受付なし）→ overview で扱うので除外しない
  return false;
}

/**
 * 母乳ケア関連の質問か（予約・受付・料金・曜日など）
 * @param {string} userMessage
 */
export function isMilkcareQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isOtherMilkcareAdjacentTopic(msg)) return false;
  return mentionsMilkcare(msg);
}

/**
 * 予約方法の質問か（内容・料金・曜日だけの質問は含めない）
 * @param {string} userMessage
 */
export function isMilkcareReservationQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isMilkcareQuery(msg)) return false;

  // 受付・曜日・料金が主目的なら予約意図にしない
  if (isMilkcareReceptionFocus(msg) && !/予約方法|どう予約|予約はどう|予約したい/.test(msg)) {
    return false;
  }
  if (isMilkcareScheduleFocus(msg) && !/予約/.test(msg)) return false;
  if (isMilkcarePriceFocus(msg) && !/予約/.test(msg)) return false;

  return (
    /予約/.test(msg) ||
    /電話予約|ネット予約|WEB予約|Web予約|web予約|オンライン予約/.test(msg) ||
    /予約したい|予約できる|予約方法|どうしたらいい|どうやって予約/.test(msg)
  );
}

/**
 * @param {string} msg
 */
function isMilkcareReceptionFocus(msg) {
  return (
    /受付|再来機|どこで待|待合|当日はどこ|来院後|来院したら/.test(msg) ||
    (/予約当日|当日の受付|当日はどこ/.test(msg) && /受付|どこ|待/.test(msg))
  );
}

/**
 * @param {string} msg
 */
function isMilkcareScheduleFocus(msg) {
  return /何曜日|曜日|いつ受け|いつやって|実施日|どの曜日|スケジュール/.test(
    msg
  );
}

/**
 * @param {string} msg
 */
function isMilkcarePriceFocus(msg) {
  return /料金|費用|いくら|値段|価格|円/.test(msg);
}

/**
 * @param {string} msg
 */
function isMilkcareWebFocus(msg) {
  return /ネット予約|WEB予約|Web予約|web予約|オンライン予約|インターネット予約/.test(
    msg
  );
}

/**
 * @param {string} userMessage
 * @returns {{
 *   answer: string,
 *   intent: string,
 *   focus: string,
 *   useExactAnswer: boolean,
 *   referencedPages: Array<{url:string,title:string}>,
 * }|null}
 */
export function buildMilkcareAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isMilkcareQuery(msg)) return null;

  const ref = [MILKCARE_REF_PAGE];
  const price = MILKCARE.priceYen.toLocaleString("ja-JP");

  // 受付（予約当日）— 予約方法と混同しない
  if (isMilkcareReceptionFocus(msg)) {
    return {
      answer: MILKCARE_RECEPTION_ANSWER,
      intent: "milkcare_reception",
      focus: "reception",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  // WEB/ネット予約の可否
  if (isMilkcareWebFocus(msg)) {
    return {
      answer: MILKCARE_WEB_RESERVATION_ANSWER,
      intent: "milkcare_reservation",
      focus: "web",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  // 料金（予約方法に流さない）
  if (isMilkcarePriceFocus(msg) && !/予約方法|どう予約|電話予約/.test(msg)) {
    return {
      answer: [
        `母乳ケアの料金は${price}円です。`,
        "医師の診察を受けられた場合には、別途診察料が必要となります。",
        "",
        "なお、母乳ケアは完全予約制で、お電話でのみご予約を承っております。",
        "",
        "詳しいご案内は、下記のページをご確認ください。",
      ].join("\n"),
      intent: "milkcare_price",
      focus: "price",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  // 実施曜日
  if (isMilkcareScheduleFocus(msg) && !/予約方法|どう予約/.test(msg)) {
    return {
      answer: [
        `母乳ケアは、${MILKCARE.schedule}に実施しています（完全予約制）。`,
        "ご予約はお電話でのみ承っております。",
        "",
        "詳しいご案内は、下記のページをご確認ください。",
      ].join("\n"),
      intent: "milkcare_schedule",
      focus: "schedule",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  // 予約方法（電話のみ）
  if (isMilkcareReservationQuery(msg)) {
    return {
      answer: MILKCARE_RESERVATION_ANSWER,
      intent: "milkcare_reservation",
      focus: "reservation",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  // 概要
  return {
    answer: [
      "産後のママを対象に母乳ケアを行っています。",
      `実施日時は${MILKCARE.schedule}（完全予約制）、所要時間は${MILKCARE.duration}、料金は${price}円です。`,
      "ご予約はお電話でのみ承っております。",
      "",
      "詳しいご案内は、下記のページをご確認ください。",
    ].join("\n"),
    intent: "milkcare_overview",
    focus: "overview",
    useExactAnswer: true,
    referencedPages: ref,
  };
}
