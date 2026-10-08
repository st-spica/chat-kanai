/**
 * 質問 → 優先確認ページ（正規ルート辞書）
 *
 * - patterns: ユーザー発話にマッチしたら、urls を「優先取得」候補に加える
 * - 絶対正解にはしない（鮮度・関連度の総合スコアで最終決定）
 * - 追加・修正はこのファイルだけで行う
 *
 * @typedef {{ id: string, label: string, patterns: RegExp[], urls: string[], boost?: number }} SiteRouteRule
 */

/**
 * 面会・立ち会いなど、表記ゆれ・活用形を吸収する正規化パターン。
 * ルート辞書と is*Focused 判定の両方から参照する。
 */
export const QUERY_NORMALIZERS = {
  visit: {
    id: "visit",
    label: "面会",
    /**
     * 会いに来る / お見舞い / 家族は来れますか など
     * 「夫も一緒に出産」は立ち会い側へ（ここには含めない）
     */
    pattern:
      /面会|お見舞い|見舞いに来|会いに(?:行|来)|(?:家族|夫|旦那|親|父母|母|父|パートナー|主人|赤ちゃん|お子|子供|子ども)[^。\n]{0,16}(?:会える|会えま|会えません|来れる|来れま|来られ|来る|来ます)|入院中に会|(?:赤ちゃん|お子|子供|子ども)に会/,
  },
  attend: {
    id: "attend",
    label: "立ち会い分娩",
    pattern:
      /立ち?会[いえ]|立会い|立ち合い|(?:旦那|夫|パートナー|主人|彼氏)[^。\n]{0,12}一緒[^。\n]{0,12}(?:出産|分娩|お産)|(?:出産|分娩|お産)[^。\n]{0,12}一緒|(?:出産|分娩)に付き添|分娩室に入れ|立ち会(?:える|えます|いできる)/,
  },
  fee: {
    id: "fee",
    label: "出産費用",
    pattern:
      /料金|費用|予納|いくらかか|お金はいくら|自己負担|入院費|分娩費用|出産費用|出産はいくら|費用はいくら/,
  },
  delivery_benefits: {
    id: "delivery_reservation_benefits",
    label: "分娩予約特典",
    /**
     * 割引・特典・キャンペーン・プレゼント等（分娩/出産文脈）
     * ＋お祝いディナー（家族招待）系
     */
    pattern:
      /(?:分娩|出産|お産).{0,12}(?:割引|特典|キャンペーン|プレゼント|優待|お得)|(?:割引|特典|キャンペーン|プレゼント|優待|お得).{0,12}(?:分娩|出産|お産)|分娩予約特典|出産特典|分娩特典|出産したら.{0,8}(?:特典|プレゼント)|出産すると.{0,8}(?:特典|プレゼント)|お祝いディナー|お祝いの食事|出産祝いの食事|家族とディナー|夫とディナー|家族も一緒に食べ|ディナーに呼|ディナーを食べ|(?:何人|何名).{0,8}招待|招待.{0,8}(?:何人|何名)|家族.{0,12}ディナー|ディナー.{0,12}(?:家族|夫|招待)|夫.{0,12}ディナー|お祝いディナーご招待/,
  },
};

/** @param {string} userMessage */
export function isAttendFocusedMessage(userMessage) {
  return QUERY_NORMALIZERS.attend.pattern.test(String(userMessage || "").trim());
}

/** @param {string} userMessage */
export function isVisitFocusedMessage(userMessage) {
  const msg = String(userMessage || "").trim();
  // 「立ち会えます」等は立ち会い優先（面会の「会える」と混同しない）
  if (isAttendFocusedMessage(msg)) return false;
  return QUERY_NORMALIZERS.visit.pattern.test(msg);
}

/** @param {string} userMessage */
export function isFeeFocusedMessage(userMessage) {
  return QUERY_NORMALIZERS.fee.pattern.test(String(userMessage || "").trim());
}

/** @param {string} userMessage */
export function isDeliveryBenefitsFocusedMessage(userMessage) {
  return QUERY_NORMALIZERS.delivery_benefits.pattern.test(
    String(userMessage || "").trim()
  );
}

/** @type {SiteRouteRule[]} */
export const SITE_ROUTE_MAP = [
  {
    id: "visit",
    label: "面会",
    patterns: [QUERY_NORMALIZERS.visit.pattern],
    urls: ["https://kanai.or.jp/obstetrics/hospitalization/#visit"],
    boost: 200,
  },
  {
    id: "attend",
    label: "立ち会い分娩",
    patterns: [QUERY_NORMALIZERS.attend.pattern],
    urls: ["https://kanai.or.jp/obstetrics/childbirth/#assist_birth"],
    boost: 200,
  },
  {
    id: "homecoming",
    label: "里帰り出産",
    patterns: [/里帰り/],
    urls: ["https://kanai.or.jp/obstetrics/childbirth/#homecoming"],
    boost: 200,
  },
  {
    id: "vaccine",
    label: "ワクチン",
    patterns: [
      /インフルエンザ|インフル|ワクチン|予防接種|アブリスボ|RSウイルス|RS\s*ウイルス/,
    ],
    urls: ["https://kanai.or.jp/obstetrics/vaccine/"],
    boost: 200,
  },
  {
    id: "cervical_screening",
    label: "子宮頸がん検診",
    patterns: [/子宮頸がん|子宮がん検診|婦人科検診/],
    urls: ["https://kanai.or.jp/gynecology/#gyne_cancer", "https://kanai.or.jp/gynecology/"],
    boost: 220,
  },
  {
    id: "gynecology",
    label: "婦人科",
    patterns: [/婦人科|ピル|ブライダルチェック|性感染症|子宮筋腫|内膜症/],
    urls: ["https://kanai.or.jp/gynecology/"],
    boost: 180,
  },
  {
    id: "hours",
    label: "診療時間",
    patterns: [/診療時間|診察時間|受付時間|夜診|午前診|午後診|何時から|何時まで/],
    // トップに曜日別診療時間表がある。beginner は初診案内の補助
    urls: ["https://kanai.or.jp/", "https://kanai.or.jp/beginner/"],
    boost: 160,
  },
  {
    id: "hours_today",
    label: "本日・直近の診療可否",
    patterns: [
      /今日|本日|明日|明後日|今週|\d{1,2}月\d{1,2}日|午後は診|午前は診|休診.*今日|今日.*休診|診療して|診てもら/,
    ],
    // トップの診療時間表を優先。日付不一致の「休診のお知らせ（本日）」は本文除去する
    urls: ["https://kanai.or.jp/", "https://kanai.or.jp/beginner/"],
    boost: 120,
  },
  {
    id: "delivery_reservation_benefits",
    label: "分娩予約特典",
    patterns: [QUERY_NORMALIZERS.delivery_benefits.pattern],
    urls: ["https://kanai.or.jp/obstetrics/rsv_bonus/"],
    boost: 240,
  },
  {
    id: "delivery_booking",
    label: "分娩予約",
    patterns: [/分娩予約|出産予約|分娩の予約|お産の予約/],
    urls: [
      "https://kanai.or.jp/obstetrics/childbirth/",
      "https://kanai.or.jp/obstetrics/rsv_bonus/",
    ],
    boost: 200,
  },
  {
    id: "hospitalization",
    label: "入院",
    patterns: [/入院|個室|LDR|母子同室/],
    urls: ["https://kanai.or.jp/obstetrics/hospitalization/", "https://kanai.or.jp/facilities/"],
    boost: 180,
  },
  {
    id: "checkup",
    label: "妊婦健診",
    patterns: [/妊婦健診|妊婦検|健診枠/],
    urls: ["https://kanai.or.jp/obstetrics/checkup/"],
    boost: 200,
  },
  {
    id: "aftercare",
    label: "産後ケア",
    patterns: [/産後ケア|産後サポート|母乳ケア/],
    urls: ["https://kanai.or.jp/aftersupport/", "https://kanai.or.jp/aftersupport/#aftercare"],
    boost: 200,
  },
  {
    id: "lesson",
    label: "教室",
    patterns: [/教室|産前教室|産後教室|ママフィット|離乳食/],
    urls: ["https://kanai.or.jp/lesson/"],
    boost: 180,
  },
  {
    id: "fee",
    label: "出産費用",
    patterns: [QUERY_NORMALIZERS.fee.pattern],
    // 費用表の正式アンカーを最優先（beginner は費用未掲載のため含めない）
    urls: ["https://kanai.or.jp/obstetrics/childbirth/#price_birth"],
    boost: 220,
  },
  {
    id: "access",
    label: "アクセス",
    patterns: [/アクセス|駐車場|行き方|地図|最寄/],
    urls: ["https://kanai.or.jp/access/"],
    boost: 200,
  },
  {
    id: "first_visit",
    label: "初めての方・予約",
    patterns: [/初診|初めて|予約の仕方|WEB予約|ウェブ予約/i],
    urls: ["https://kanai.or.jp/beginner/"],
    boost: 160,
  },
  {
    id: "web_reservation",
    label: "WEB予約可否",
    patterns: [
      /WEB予約|ウェブ予約|ネット予約|オンライン予約|WEBで予約|ネットで予約|オンラインで予約/i,
    ],
    urls: ["https://kanai.or.jp/beginner/"],
    boost: 200,
  },
];

/**
 * @param {string} userMessage
 * @returns {Array<SiteRouteRule & { matchedPattern?: string }>}
 */
export function matchSiteRoutes(userMessage) {
  const msg = String(userMessage || "");
  if (!msg.trim()) return [];
  const attendHit = isAttendFocusedMessage(msg);
  const out = [];
  for (const rule of SITE_ROUTE_MAP) {
    // 立ち会い質問では面会ルートを付けない
    if (rule.id === "visit" && attendHit) continue;
    for (const re of rule.patterns || []) {
      if (re.test(msg)) {
        out.push({ ...rule, matchedPattern: String(re) });
        break;
      }
    }
  }
  return out;
}

/**
 * マッチしたルールの優先URL（重複除去・ハッシュ付き可）
 * @param {string} userMessage
 * @returns {string[]}
 */
export function preferredUrlsForMessage(userMessage) {
  const urls = [];
  const seen = new Set();
  for (const rule of matchSiteRoutes(userMessage)) {
    for (const u of rule.urls || []) {
      const key = String(u || "").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      urls.push(key);
    }
  }
  return urls;
}
