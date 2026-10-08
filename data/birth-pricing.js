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
    /** @type {{ id: string, name: string, amountYen: number, condition: string }[]} */
    items: [
      {
        id: "sibling",
        name: "きょうだい割引",
        amountYen: 15000,
        condition: "過去に当院で出産された方",
      },
      {
        id: "papaMama",
        name: "パパママ割引",
        amountYen: 10000,
        condition: "ご夫婦のどちらかが当院で生まれた方",
      },
    ],
    get siblingYen() {
      return this.items.find((x) => x.id === "sibling")?.amountYen ?? 15000;
    },
    get papaMamaYen() {
      return this.items.find((x) => x.id === "papaMama")?.amountYen ?? 10000;
    },
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
  // お祝いディナー等の特典ページとは分離
  if (
    /ディナー|プレゼント|キャンペーン|お祝い/.test(msg) &&
    !/割引/.test(msg)
  ) {
    return false;
  }
  if (/特典/.test(msg) && !/割引/.test(msg) && !/独自|制度/.test(msg)) {
    return false;
  }
  if (/きょうだい割引|兄弟割引|姉妹割引|パパママ割引/.test(msg)) return true;
  if (/独自.{0,8}割引|割引制度|割引はあります|割引があります|安くなる制度|費用が安/.test(msg)) {
    return true;
  }
  if (
    /割引/.test(msg) &&
    /(?:出産|分娩|入院|2人目|二人目|２人目|第二子|夫|旦那|妻|パートナー|夫婦|一緒|同伴|付き添|当院で生|金井|受診)/.test(
      msg
    )
  ) {
    return true;
  }
  // 「夫がこちらで生まれた場合は？」など割引語がなくてもパパママ条件の確認
  if (
    /(?:夫|旦那|妻|自分|パートナー).{0,12}(?:生まれ|お生まれ)|(?:生まれ|お生まれ).{0,12}(?:夫|旦那|妻)/.test(
      msg
    ) &&
    /(?:割引|安く|制度|なりますか|ありますか|場合)/.test(msg)
  ) {
    return true;
  }
  if (
    /(?:夫|旦那|妻|自分|パートナー).{0,12}(?:生まれ|お生まれ)|(?:こちら|当院|金井).{0,8}(?:で)?(?:生まれ|お生まれ)/.test(
      msg
    ) &&
    msg.length <= 40
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

function getDiscountItem(id) {
  return BIRTH_PRICING.discounts.items.find((x) => x.id === id) || null;
}

function formatDiscountOverview() {
  const sibling = getDiscountItem("sibling");
  const papaMama = getDiscountItem("papaMama");
  return [
    "はい、当院では出産費用に関する『きょうだい割引』と『パパママ割引』をご用意しています。",
    "",
    `${sibling.name}（${formatYen(sibling.amountYen)}）`,
    `${sibling.condition}が対象です。`,
    "",
    `${papaMama.name}（${formatYen(papaMama.amountYen)}）`,
    `${papaMama.condition}が対象です。`,
    "",
    "詳しくは、以下のページをご確認ください。",
  ].join("\n");
}

/**
 * 同伴・一緒受診だけで割引になるかと聞いている（適用条件の誤推測を防ぐ）
 * @param {string} msg
 */
function isCompanionOnlyDiscountQuery(msg) {
  // 出生・当院出産歴など確定条件に触れている場合は同伴のみではない
  if (
    /生まれ|お生まれ|出産された|出産歴|パパママ割引|きょうだい割引/.test(msg)
  ) {
    return false;
  }
  return (
    /(?:夫婦|夫|旦那|妻|パートナー|家族).{0,12}(?:一緒|同伴|付き添|来院|受診)/.test(
      msg
    ) ||
    /(?:一緒|同伴|付き添).{0,12}(?:来院|受診|割引)/.test(msg) ||
    /夫婦で受診|パートナーと一緒|付き添いがいる/.test(msg)
  );
}

function buildDiscountAnswer(msg) {
  const sibling = getDiscountItem("sibling");
  const papaMama = getDiscountItem("papaMama");

  // 同伴のみでは対象外（「パートナーと来院で割引」等の誤案内を防ぐ）
  if (isCompanionOnlyDiscountQuery(msg)) {
    return [
      "ご夫婦やパートナーと一緒にご受診・ご来院いただくだけでは、割引の対象にはなりません。",
      "",
      `出産費用の割引は次の制度です。`,
      `・${sibling.name}（${formatYen(sibling.amountYen)}）：${sibling.condition}`,
      `・${papaMama.name}（${formatYen(papaMama.amountYen)}）：${papaMama.condition}`,
      "",
      "詳しくは、以下のページをご確認ください。",
    ].join("\n");
  }

  const askSiblingName = /きょうだい割引|兄弟割引|姉妹割引/.test(msg);
  const askPapaMamaName = /パパママ割引/.test(msg);
  const wantSibling =
    askSiblingName ||
    /2人目|二人目|２人目|第二子|過去に.{0,8}出産|以前に.{0,8}出産|前に当院/.test(
      msg
    );
  const wantPapaMama =
    askPapaMamaName ||
    /(?:夫|旦那|妻|自分|パートナー).{0,16}(?:生まれ|お生まれ)|(?:生まれ|お生まれ).{0,12}(?:夫|旦那|妻)|当院で生|金井で生|こちらで生/.test(
      msg
    );

  if (wantPapaMama && !wantSibling) {
    return [
      `${papaMama.name}があります。`,
      `${papaMama.condition}は、出産費用より${formatYen(papaMama.amountYen)}割引いたします。`,
      "",
      "詳しくは、以下のページをご確認ください。",
    ].join("\n");
  }
  if (wantSibling && !wantPapaMama) {
    // 「二人目なら必ず割引」ではなく、当院での出産歴が条件
    if (/2人目|二人目|２人目|第二子/.test(msg) && !askSiblingName) {
      return [
        `二人目以降の出産であることだけでは割引にはなりません。`,
        `${sibling.name}（${formatYen(sibling.amountYen)}）は、${sibling.condition}が対象です。`,
        "",
        "詳しくは、以下のページをご確認ください。",
      ].join("\n");
    }
    return [
      `${sibling.name}があります。`,
      `${sibling.condition}は、出産費用より${formatYen(sibling.amountYen)}割引いたします。`,
      "",
      "詳しくは、以下のページをご確認ください。",
    ].join("\n");
  }
  return formatDiscountOverview();
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
    ...disc.items.map(
      (x) => `${x.name} ${formatYen(x.amountYen)}（${x.condition}）`
    ),
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
