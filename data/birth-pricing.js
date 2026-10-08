/**
 * 分娩料金の確定データ（一元管理）
 *
 * 金額は本ファイルのみに置く。clinic-knowledge 等へ金額を重複登録しない。
 * 回答は本モジュールからプログラム生成する（一般的な産婦人科料金の推測禁止）。
 *
 * 公式: https://kanai.or.jp/obstetrics/childbirth/#price_birth
 */

export const BIRTH_PRICING_REF_PAGE = {
  url: "https://kanai.or.jp/obstetrics/childbirth/#price_birth",
  title: "分娩料金について",
};

/** @typedef {"birth_reservation_deposit"|"birth_advance_payment"|"birth_hospitalization_cost"|"birth_cost_discount"|"birth_pricing_overview"} BirthPricingIntent */

/**
 * 金額・条件の確定データ（円は number）
 */
export const BIRTH_PRICING = {
  reservationDeposit: {
    amountYen: 10000,
    when: "分娩予約時",
    refundable: false,
    /** 退院時に入院費として精算する額（返金ではなく充当） */
    settleToHospitalBillYen: 5000,
  },
  advancePayment: {
    fromPregnancyWeek: 36,
    cashOnly: true,
    withDirectPaymentSystemYen: 100000,
    withoutDirectPaymentSystemYen: 300000,
    settleAtDischarge: true,
    fullRefundOnTransfer: true,
    nonDeliveryHospitalizationYen: 20000,
  },
  hospitalization: {
    normalPrimipara: { minYen: 600000, maxYen: 650000, days: 6 },
    normalMultipara: { minYen: 570000, maxYen: 620000, days: 5 },
    abnormal: { minYen: 600000, maxYen: 660000, days: 7 },
    normalFullySelfPay: true,
    abnormalPartialInsurance: true,
    lumpSumDirectPaymentYen: 500000,
  },
  discounts: {
    siblingYen: 15000,
    papaMamaYen: 10000,
  },
};

/** @param {number} yen */
export function formatYen(yen) {
  return `${Number(yen).toLocaleString("ja-JP")}円`;
}

/** @param {{ minYen: number, maxYen: number }} range */
function formatYenRange(range) {
  return `約${formatYen(range.minYen)}〜${formatYen(range.maxYen)}`;
}

/**
 * 産後ケア等の料金（分娩料金と分離）
 * @param {string} userMessage
 */
export function isPostpartumCareFeeQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (!/産後ケア|産後サポート|母乳ケア|ショートステイ/.test(msg)) return false;
  return /料金|費用|いくら|値段|価格/.test(msg);
}

/**
 * 分娩予約金か（予納金と混同しない）
 * @param {string} userMessage
 */
export function isBirthReservationDepositQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg || isPostpartumCareFeeQuery(msg)) return false;
  if (/予納/.test(msg)) return false;
  return (
    /分娩予約金|出産(?:の)?予約金|予約金/.test(msg) ||
    (/分娩予約|出産予約/.test(msg) && /(?:お金|費用|料金|いくら|必要|払)/.test(msg))
  );
}

/**
 * 分娩予納金か
 * @param {string} userMessage
 */
export function isBirthAdvancePaymentQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg || isPostpartumCareFeeQuery(msg)) return false;
  if (isBirthReservationDepositQuery(msg) && !/予納/.test(msg)) return false;
  return (
    /分娩予納金|予納金/.test(msg) ||
    (/出産前|入院前/.test(msg) && /(?:いくら|払|納め|支払)/.test(msg)) ||
    (/予納/.test(msg) && /(?:現金|いつ|転院|返)/.test(msg))
  );
}

/**
 * 出産費用割引（きょうだい・パパママ）。分娩予約特典（rsv_bonus）とは別
 * @param {string} userMessage
 */
export function isBirthCostDiscountQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg || isPostpartumCareFeeQuery(msg)) return false;
  if (/ディナー|特典|プレゼント|キャンペーン|お祝い/.test(msg) && !/割引/.test(msg)) {
    return false;
  }
  if (/きょうだい割引|兄弟割引|姉妹割引|パパママ割引/.test(msg)) return true;
  if (
    /割引/.test(msg) &&
    /(?:出産|分娩|入院|2人目|二人目|２人目|第二子|夫が|旦那が|当院で生|金井)/.test(msg)
  ) {
    return true;
  }
  return false;
}

/**
 * 入院費・分娩費用・概算
 * @param {string} userMessage
 */
export function isBirthHospitalizationCostQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg || isPostpartumCareFeeQuery(msg)) return false;
  if (isBirthReservationDepositQuery(msg)) return false;
  if (isBirthAdvancePaymentQuery(msg)) return false;
  if (isBirthCostDiscountQuery(msg)) return false;
  return (
    /出産費用|分娩費用|分娩料金|入院費|概算料金/.test(msg) ||
    /(?:初産|経産|2人目|二人目|帝王切開).{0,12}(?:費用|料金|いくら)/.test(msg) ||
    /(?:費用|料金|いくら).{0,12}(?:初産|経産|帝王切開)/.test(msg) ||
    /出産育児一時金/.test(msg) ||
    /出産(?:は|って)?いくら/.test(msg)
  );
}

/**
 * 分娩料金まわり全般（産後ケア料金は除外）
 * @param {string} userMessage
 */
export function isBirthPricingQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg || isPostpartumCareFeeQuery(msg)) return false;
  return (
    isBirthReservationDepositQuery(msg) ||
    isBirthAdvancePaymentQuery(msg) ||
    isBirthHospitalizationCostQuery(msg) ||
    isBirthCostDiscountQuery(msg) ||
    /出産費用を?(全部|すべて|全て)|分娩料金を?(全部|すべて|全て)|料金を?(全部|すべて|全て)知り/.test(
      msg
    )
  );
}

/**
 * @param {string} userMessage
 * @returns {BirthPricingIntent|null}
 */
export function detectBirthPricingIntent(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg || isPostpartumCareFeeQuery(msg)) return null;
  if (
    /出産費用を?(全部|すべて|全て)|分娩料金を?(全部|すべて|全て)|料金の?(全部|すべて|全て)|概算料金/.test(
      msg
    )
  ) {
    return "birth_pricing_overview";
  }
  if (isBirthReservationDepositQuery(msg)) return "birth_reservation_deposit";
  if (isBirthAdvancePaymentQuery(msg)) return "birth_advance_payment";
  if (isBirthCostDiscountQuery(msg)) return "birth_cost_discount";
  if (isBirthHospitalizationCostQuery(msg)) return "birth_hospitalization_cost";
  if (isBirthPricingQuery(msg)) return "birth_pricing_overview";
  return null;
}

function buildReservationDepositAnswer(msg) {
  const d = BIRTH_PRICING.reservationDeposit;
  if (/返金|戻/.test(msg)) {
    return [
      `分娩予約金（${formatYen(d.amountYen)}）は返金不可です。`,
      `なお、うち${formatYen(d.settleToHospitalBillYen)}は退院時に入院費として精算いたします。`,
    ].join("\n");
  }
  if (/含まれ|充当|精算|入院費/.test(msg)) {
    return [
      `分娩予約金は${formatYen(d.amountYen)}です（${d.when}にお支払い、返金不可）。`,
      `うち${formatYen(d.settleToHospitalBillYen)}は退院時に入院費として精算いたします。`,
    ].join("\n");
  }
  return [
    `分娩予約金は${formatYen(d.amountYen)}です。`,
    `${d.when}にお支払いいただき、返金はできません。`,
    `うち${formatYen(d.settleToHospitalBillYen)}は退院時に入院費として精算いたします。`,
  ].join("\n");
}

function buildAdvancePaymentAnswer(msg) {
  const a = BIRTH_PRICING.advancePayment;
  if (/いつ|何時|週/.test(msg)) {
    return `分娩予納金は、妊娠${a.fromPregnancyWeek}週に入ってからお支払いいただきます${
      a.cashOnly ? "（現金のみ）" : ""
    }。`;
  }
  if (/現金/.test(msg)) {
    return "分娩予納金は現金のみでのお支払いとなります。";
  }
  if (/転院|返/.test(msg)) {
    return a.fullRefundOnTransfer
      ? "他院へ転院される場合、予納金は全額返金いたします。"
      : "転院時の予納金の取り扱いについて、確認できる情報がありません。";
  }
  if (/分娩以外|出産以外/.test(msg)) {
    return `分娩以外での入院の予納金は${formatYen(a.nonDeliveryHospitalizationYen)}です。`;
  }
  return [
    `分娩予納金は、出産育児一時金直接支払制度の利用ありで${formatYen(
      a.withDirectPaymentSystemYen
    )}、利用なしで${formatYen(a.withoutDirectPaymentSystemYen)}です。`,
    `妊娠${a.fromPregnancyWeek}週に入ってから、現金のみでお支払いいただきます。`,
    "退院時に入院費として精算し、他院転院時は全額返金いたします。",
  ].join("\n");
}

function buildHospitalizationCostAnswer(msg) {
  const h = BIRTH_PRICING.hospitalization;
  if (/出産育児一時金/.test(msg)) {
    return [
      "当院では出産育児一時金直接支払制度に対応しています。",
      `制度を利用する場合、出産育児一時金${formatYen(
        h.lumpSumDirectPaymentYen
      )}を入院費として精算いたします。`,
      `分娩予納金は、制度利用あり${formatYen(
        BIRTH_PRICING.advancePayment.withDirectPaymentSystemYen
      )}／利用なし${formatYen(
        BIRTH_PRICING.advancePayment.withoutDirectPaymentSystemYen
      )}です。`,
    ].join("\n");
  }
  if (/帝王切開|異常分娩/.test(msg)) {
    return [
      `異常分娩（帝王切開等）の入院費は、${formatYenRange(h.abnormal)}（入院${h.abnormal.days}日間の場合）です。`,
      "異常分娩の場合は、入院費の一部に保険が適用されます。",
    ].join("\n");
  }
  if (/経産|2人目|二人目|２人目|第二子/.test(msg)) {
    return `経産婦さまの正常分娩の入院費は、${formatYenRange(
      h.normalMultipara
    )}（入院${h.normalMultipara.days}日間の場合）です。正常分娩は全額自費扱いとなります。`;
  }
  if (/初産/.test(msg)) {
    return `初産婦さまの正常分娩の入院費は、${formatYenRange(
      h.normalPrimipara
    )}（入院${h.normalPrimipara.days}日間の場合）です。正常分娩は全額自費扱いとなります。`;
  }
  return [
    "入院費の目安は次のとおりです。",
    `・正常分娩（初産婦）：${formatYenRange(h.normalPrimipara)}（入院${h.normalPrimipara.days}日間）`,
    `・正常分娩（経産婦）：${formatYenRange(h.normalMultipara)}（入院${h.normalMultipara.days}日間）`,
    `・異常分娩（帝王切開等）：${formatYenRange(h.abnormal)}（入院${h.abnormal.days}日間）`,
    "正常分娩は全額自費、異常分娩は入院費の一部に保険が適用されます。",
    `出産育児一時金直接支払制度を利用する場合は、${formatYen(
      h.lumpSumDirectPaymentYen
    )}を入院費として精算いたします。`,
  ].join("\n");
}

function buildDiscountAnswer(msg) {
  const d = BIRTH_PRICING.discounts;
  const wantSibling =
    /きょうだい|兄弟|姉妹|2人目|二人目|２人目|第二子|過去に|以前に|前に当院/.test(msg);
  const wantPapaMama =
    /パパママ|夫が|旦那が|妻が|自分が|当院で生|金井で生|母子手帳/.test(msg);
  if (wantPapaMama && !wantSibling) {
    return `パパママ割引があります。ご夫婦のどちらかが当院でお生まれになった方は、出産費用より${formatYen(
      d.papaMamaYen
    )}割引いたします。`;
  }
  if (wantSibling && !wantPapaMama) {
    return `きょうだい割引があります。過去に当院でご出産された方は、出産費用より${formatYen(
      d.siblingYen
    )}割引いたします。`;
  }
  return [
    "出産費用の割引制度があります。",
    `・きょうだい割引：過去に当院でご出産された方は${formatYen(d.siblingYen)}割引`,
    `・パパママ割引：ご夫婦のどちらかが当院でお生まれになった方は${formatYen(
      d.papaMamaYen
    )}割引`,
  ].join("\n");
}

function buildOverviewAnswer() {
  const d = BIRTH_PRICING.reservationDeposit;
  const a = BIRTH_PRICING.advancePayment;
  const h = BIRTH_PRICING.hospitalization;
  const disc = BIRTH_PRICING.discounts;
  return [
    "【分娩予約金】",
    `${formatYen(d.amountYen)}（${d.when}・返金不可。うち${formatYen(
      d.settleToHospitalBillYen
    )}は退院時に入院費として精算）`,
    "",
    "【分娩予納金】",
    `妊娠${a.fromPregnancyWeek}週以降・現金のみ。直接支払制度あり${formatYen(
      a.withDirectPaymentSystemYen
    )}／なし${formatYen(a.withoutDirectPaymentSystemYen)}`,
    "",
    "【入院費の目安】",
    `正常分娩（初産） ${formatYenRange(h.normalPrimipara)}（${h.normalPrimipara.days}日間）`,
    `正常分娩（経産） ${formatYenRange(h.normalMultipara)}（${h.normalMultipara.days}日間）`,
    `異常分娩 ${formatYenRange(h.abnormal)}（${h.abnormal.days}日間）`,
    "",
    "【割引】",
    `きょうだい割引 ${formatYen(disc.siblingYen)}／パパママ割引 ${formatYen(disc.papaMamaYen)}`,
  ].join("\n");
}

/**
 * @param {string} userMessage
 * @returns {{ answer: string, intent: BirthPricingIntent, referencedPages: {url:string,title:string}[], pricingData: object }|null}
 */
export function buildBirthPricingAnswer(userMessage) {
  const intent = detectBirthPricingIntent(userMessage);
  if (!intent) return null;
  const msg = String(userMessage || "").trim();
  let answer = "";
  if (intent === "birth_reservation_deposit") {
    answer = buildReservationDepositAnswer(msg);
  } else if (intent === "birth_advance_payment") {
    answer = buildAdvancePaymentAnswer(msg);
  } else if (intent === "birth_cost_discount") {
    answer = buildDiscountAnswer(msg);
  } else if (intent === "birth_hospitalization_cost") {
    answer = buildHospitalizationCostAnswer(msg);
  } else {
    answer = buildOverviewAnswer();
  }
  return {
    answer,
    intent,
    referencedPages: [BIRTH_PRICING_REF_PAGE],
    pricingData: BIRTH_PRICING,
  };
}

/**
 * 公式サイト抜粋と確定データの金額ずれを検出（自動上書きはしない）
 * @param {string} siteText
 * @returns {{ ok: boolean, mismatches: { key: string, expected: string, found: boolean }[] }}
 */
export function detectBirthPricingDrift(siteText) {
  const raw = String(siteText || "");
  if (!raw.trim()) {
    return { ok: true, mismatches: [], note: "サイト本文なし（比較スキップ）" };
  }
  const normalized = raw.replace(/[，,\s]/g, "");
  /** @type {{ key: string, expected: string, patterns: RegExp[] }[]} */
  const checks = [
    {
      key: "reservationDeposit",
      expected: formatYen(BIRTH_PRICING.reservationDeposit.amountYen),
      patterns: [/10000円/, /1万(?:円|)/],
    },
    {
      key: "advanceWithDirectPayment",
      expected: formatYen(BIRTH_PRICING.advancePayment.withDirectPaymentSystemYen),
      patterns: [/100000円/, /10万(?:円|)/],
    },
    {
      key: "advanceWithoutDirectPayment",
      expected: formatYen(BIRTH_PRICING.advancePayment.withoutDirectPaymentSystemYen),
      patterns: [/300000円/, /30万(?:円|)/],
    },
    {
      key: "siblingDiscount",
      expected: formatYen(BIRTH_PRICING.discounts.siblingYen),
      patterns: [/15000円/, /1万5千/],
    },
    {
      key: "papaMamaDiscount",
      expected: formatYen(BIRTH_PRICING.discounts.papaMamaYen),
      patterns: [/10000円/, /1万(?:円|)/],
    },
  ];
  // 料金セクションらしき文言が無い場合は比較しない
  if (!/予約金|予納金|入院費|分娩料金|出産費用割引/.test(raw)) {
    return { ok: true, mismatches: [], note: "料金セクション未検出（比較スキップ）" };
  }
  const mismatches = [];
  for (const c of checks) {
    const found = c.patterns.some((re) => re.test(normalized) || re.test(raw));
    if (!found) {
      mismatches.push({ key: c.key, expected: c.expected, found: false });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}
