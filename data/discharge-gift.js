/**
 * 退院プレゼント（出産・入院・退院の文脈ではお土産も同じ案内）
 *
 * 公式: https://kanai.or.jp/obstetrics/hospitalization/ 「退院プレゼント」
 * オリジナルBébéグッズ（臍帯箱・フード付きバスタオル・トートバッグ）
 * 生まれて1日目の赤ちゃんのお写真
 *
 * 会話が別のお土産（レストラン、販売品など）を指しているときは案内しない。
 */

export const DISCHARGE_GIFT_PAGE = {
  url: "https://kanai.or.jp/obstetrics/hospitalization/",
  title: "入院中の生活・退院プレゼント",
};

export const DISCHARGE_GIFT_ANSWER = [
  "当院では、ご出産された方へ、退院時のプレゼントをご用意しています。",
  "",
  "オリジナルBébéグッズ（臍帯箱・フード付きバスタオル・トートバッグ）や、生まれて1日目の赤ちゃんのお写真などをお渡ししています。",
  "",
  "詳しくは下記のページをご覧ください。",
].join("\n");

/** 検索用に揃える同義語 */
export const DISCHARGE_GIFT_SEARCH_TERMS = [
  "退院プレゼント",
  "臍帯箱",
  "生まれて1日目の赤ちゃんのお写真",
];

const DIRECT_RE =
  /退院プレゼント|退院祝い|出産プレゼント|出産記念品|出産の記念|記念品|退院時にもら|退院(?:するとき|のとき|時).{0,12}もら|臍帯箱|フード付(?:き)?バスタオル|Bébéグッズ|ベベグッズ/;

const SOUVENIR_RE = /おみやげ|お土産|みやげ/;

const OTHER_SOUVENIR_RE =
  /レストラン|お祝いディナー|ディナー|骨盤ベルト|腹帯|トコちゃん|売店|自動販売|自販機|マスク|教室|レッスン|ワクチン/;

/**
 * 直前の話題が退院プレゼント以外のお土産だと分かる場合
 * @param {string} userMessage
 * @param {string} [contextText]
 */
export function isOtherSouvenirContext(userMessage, contextText = "") {
  const msg = String(userMessage || "").trim();
  const ctx = String(contextText || "");
  if (!SOUVENIR_RE.test(msg) && !/もら/.test(msg)) return false;
  if (OTHER_SOUVENIR_RE.test(msg) && !/退院|臍帯|記念品/.test(msg)) return true;
  const short = msg.length <= 16 && (SOUVENIR_RE.test(msg) || /^何かもらえますか[？?]?$/.test(msg));
  if (!short) return false;
  if (/退院|出産プレゼント|記念品|臍帯|退院プレゼント/.test(ctx)) return false;
  return OTHER_SOUVENIR_RE.test(ctx);
}

/**
 * @param {string} userMessage
 * @param {string} [contextText]
 */
export function isDischargeGiftQuery(userMessage, contextText = "") {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isOtherSouvenirContext(msg, contextText)) return false;

  if (DIRECT_RE.test(msg)) return true;

  if (/^(?:お)?みやげ$|^(?:お)?土産$/.test(msg)) return true;
  if (SOUVENIR_RE.test(msg) && msg.length <= 24 && !OTHER_SOUVENIR_RE.test(msg)) {
    return true;
  }

  if (
    /赤ちゃんの写真|1日目の(?:赤ちゃんの)?写真|生まれて.?1日目/.test(msg) &&
    /もら|いただけ|くれ|ほしい|欲しい|ある|もらえ/.test(msg) &&
    !/ニューボーン|マタニティフォト|カメラマン|撮影して|フォトグラファー/.test(msg)
  ) {
    return true;
  }

  if (/退院|出産|入院/.test(`${ctxLine(contextText)} ${msg}`) && SOUVENIR_RE.test(msg)) {
    return true;
  }

  return false;
}

/**
 * @param {string} contextText
 */
function ctxLine(contextText) {
  return String(contextText || "");
}

/**
 * 同義語を退院プレゼントの検索語へ揃える
 * @param {string} userMessage
 * @param {string} [contextText]
 * @returns {string[]}
 */
export function dischargeGiftSearchTerms(userMessage, contextText = "") {
  if (!isDischargeGiftQuery(userMessage, contextText)) return [];
  return DISCHARGE_GIFT_SEARCH_TERMS;
}

/**
 * @param {string} userMessage
 * @param {string} [contextText]
 */
export function buildDischargeGiftAnswer(userMessage, contextText = "") {
  if (!isDischargeGiftQuery(userMessage, contextText)) return null;
  return {
    answer: DISCHARGE_GIFT_ANSWER,
    intent: "discharge_gift",
    focus: /写真/.test(String(userMessage || "")) ? "photo" : "gift",
    useExactAnswer: true,
    referencedPages: [DISCHARGE_GIFT_PAGE],
  };
}
