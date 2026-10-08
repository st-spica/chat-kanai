/**
 * 里帰り出産の確定案内
 *
 * 公式: https://kanai.or.jp/obstetrics/checkup/#homecoming
 * 表示URLの #homecoming は削除しない。
 */

export const HOMECOMING_REF_PAGE = {
  url: "https://kanai.or.jp/obstetrics/checkup/#homecoming",
  title: "里帰り出産について",
};

/** 本文取得用（アンカーなしでページ取得してよい） */
export const HOMECOMING_FETCH_URL = "https://kanai.or.jp/obstetrics/checkup/";

const HOMECOMING_TOPIC_RE =
  /里帰り|里がえり|さとがえり|里帰(?:り)?出産|里帰り分娩/;

/**
 * @param {string} text
 */
export function mentionsHomecomingTopic(text) {
  return HOMECOMING_TOPIC_RE.test(String(text || ""));
}

/**
 * @param {string} userMessage
 */
export function isHomecomingDeliveryQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (!mentionsHomecomingTopic(msg)) return false;
  // 里帰り + 受診時期・予約・紹介状・手続き など
  if (
    /いつまで|何週|受診|予約|紹介状|手続|申し込み|申込|家族|本人|電話|必要|教えて|について|行き|来院|健診/.test(
      msg
    )
  ) {
    return true;
  }
  // 「里帰り出産は？」単体も案内
  if (/里帰り/.test(msg) && msg.length <= 40) return true;
  return false;
}

/**
 * @param {string} userMessage
 * @returns {{ answer: string, intent: string, referencedPages: Array<{url:string,title:string}>, focus: string }|null}
 */
export function buildHomecomingDeliveryAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isHomecomingDeliveryQuery(msg)) return null;

  // 紹介状
  if (/紹介状/.test(msg)) {
    return {
      answer: [
        "里帰り出産をご希望の場合、初回受診時に紹介状の持参が必要です。",
        "妊娠33週6日までに紹介状を持参して当院を受診してください。",
        "",
        "事前に分娩予約のお手続きも必要です。",
        "詳しいお手続きについては、下記のページをご確認ください。",
      ].join("\n"),
      intent: "homecoming_delivery",
      referencedPages: [HOMECOMING_REF_PAGE],
      focus: "referral_letter",
    };
  }

  // 予約方法・家族
  if (/予約|手続|申し込み|申込|家族|本人|来院して/.test(msg)) {
    return {
      answer: [
        "里帰り出産をご希望の場合は、事前に分娩予約のお手続きが必要です。",
        "分娩予約はご本人またはご家族が来院して行ってください。",
        "",
        "初回受診は妊娠33週6日までに紹介状を持参して受診し、",
        "その際は診察時間内にお電話で診察予約をお取りください。",
        "",
        "詳しいお手続きについては、下記のページをご確認ください。",
      ].join("\n"),
      intent: "homecoming_delivery",
      referencedPages: [HOMECOMING_REF_PAGE],
      focus: "reservation",
    };
  }

  // いつまで・何週（デフォルト含む）
  return {
    answer: [
      "里帰り出産をご希望の場合は、",
      "妊娠33週6日までに紹介状を持参して",
      "当院を受診してください。",
      "",
      "事前に分娩予約のお手続きも必要です。",
      "初回受診の際は、診察時間内に",
      "お電話で診察予約をお取りください。",
      "",
      "詳しいお手続きについては、",
      "下記のページをご確認ください。",
    ].join("\n"),
    intent: "homecoming_delivery",
    referencedPages: [HOMECOMING_REF_PAGE],
    focus: "deadline",
  };
}
