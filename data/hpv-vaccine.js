/**
 * 子宮頸がんワクチン（HPVワクチン）の確定案内
 *
 * 公式: https://kanai.or.jp/gynecology/#cervical_cancer
 * 子宮がん検診（#gyne_cancer）と混同しない。
 * 他ワクチン（インフル・RS・小児）と混同しない。
 * 通常回答では電話番号を表示しない。
 */

export const HPV_VACCINE_REF_PAGE = {
  url: "https://kanai.or.jp/gynecology/#cervical_cancer",
  title: "子宮頸がんワクチンについて",
};

/** 院内確認・公式記載に基づく確定情報 */
export const HPV_VACCINE = {
  available: true,
  serviceName: "子宮頸がんワクチン（HPVワクチン）",
  schedule: "木曜・金曜・土曜日の午前診",
  reservationRequired: true,
  reservationWindow: "平日13:00〜16:00に電話予約",
  // 料金は自治体により異なるため、詳細は公式ページへ
  feeNote:
    "大阪市・守口市・東大阪市の定期接種対象は無料。それ以外は有料（詳細は公式ページ）。",
};

export const HPV_VACCINE_AVAILABLE_ANSWER = [
  "はい、当院では子宮頸がんワクチン（HPVワクチン）の接種を行っております。",
  "",
  "接種は完全予約制で、木曜・金曜・土曜日の午前診に実施しています。",
  "",
  "ご予約は平日13:00〜16:00にお電話にて承っております。",
  "",
  "接種対象や料金などの詳細は、下記のページをご確認ください。",
].join("\n");

/**
 * @param {string} text
 */
export function mentionsHpvVaccine(text) {
  const t = String(text || "");
  return (
    /HPV\s*ワクチン|ヒトパピローマウイルス/.test(t) ||
    /シルガード|ガーダシル|サーバリックス/.test(t) ||
    /子宮頸がん(?:の)?(?:ワクチン|予防接種)|子宮頚がん(?:の)?(?:ワクチン|予防接種)/.test(
      t
    ) ||
    (/子宮頸がん|子宮頚がん/.test(t) &&
      /ワクチン|予防接種|接種|打て|打てます|打って/.test(t))
  );
}

/**
 * 検診・他ワクチンと分離
 * @param {string} msg
 */
function isOtherVaccineOrScreening(msg) {
  if (/インフルエンザ|アブリスボ|RSウイルス|風疹|小児|お子さま|赤ちゃん/.test(msg)) {
    // HPV明示があればHPV優先
    if (mentionsHpvVaccine(msg)) return false;
    return true;
  }
  // 検診のみ（ワクチン語なし）
  if (
    /検診|細胞診|検査を受け|検査はできます|がん検診/.test(msg) &&
    !/ワクチン|予防接種|接種|HPV|シルガード|打て/.test(msg)
  ) {
    return true;
  }
  return false;
}

/**
 * @param {string} userMessage
 */
export function isHpvVaccineQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isOtherVaccineOrScreening(msg)) return false;
  if (mentionsHpvVaccine(msg)) return true;
  return false;
}

/**
 * @param {string} msg
 */
function asksSchedule(msg) {
  return /何曜日|曜日|いつ|日時|午前診|木曜|金曜|土曜/.test(msg);
}

/**
 * @param {string} msg
 */
function asksReservation(msg) {
  return /予約|申し込み|申込|どうやって|どうしたらいい/.test(msg);
}

/**
 * @param {string} msg
 */
function asksFee(msg) {
  return /料金|費用|いくら|値段|価格|無料/.test(msg);
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
export function buildHpvVaccineAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isHpvVaccineQuery(msg)) return null;

  const ref = [HPV_VACCINE_REF_PAGE];

  if (asksFee(msg) && !asksReservation(msg)) {
    return {
      answer: [
        "はい、当院では子宮頸がんワクチン（HPVワクチン）の接種を行っております。",
        "",
        "料金は接種対象（自治体の定期接種対象かどうかなど）によって異なります。",
        "詳細は下記のページをご確認ください。",
      ].join("\n"),
      intent: "hpv_vaccination",
      focus: "fee",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  if (asksReservation(msg)) {
    return {
      answer: [
        "子宮頸がんワクチン（HPVワクチン）は完全予約制です。",
        "",
        "ご予約は平日13:00〜16:00にお電話にて承っております。",
        "接種は木曜・金曜・土曜日の午前診に実施しています。",
        "",
        "詳細は下記のページをご確認ください。",
      ].join("\n"),
      intent: "hpv_vaccination",
      focus: "reservation",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  if (asksSchedule(msg)) {
    return {
      answer: [
        "はい、当院では子宮頸がんワクチン（HPVワクチン）の接種を行っております。",
        "",
        "接種は木曜・金曜・土曜日の午前診に実施しています（完全予約制）。",
        "",
        "詳細は下記のページをご確認ください。",
      ].join("\n"),
      intent: "hpv_vaccination",
      focus: "schedule",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  return {
    answer: HPV_VACCINE_AVAILABLE_ANSWER,
    intent: "hpv_vaccination",
    focus: "availability",
    useExactAnswer: true,
    referencedPages: ref,
  };
}
