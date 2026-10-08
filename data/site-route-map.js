/**
 * 質問 → 優先確認ページ（正規ルート辞書）
 *
 * - patterns: ユーザー発話にマッチしたら、urls を「優先取得」候補に加える
 * - 絶対正解にはしない（鮮度・関連度の総合スコアで最終決定）
 * - 追加・修正はこのファイルだけで行う
 *
 * @typedef {{ id: string, label: string, patterns: RegExp[], urls: string[], boost?: number }} SiteRouteRule
 */

/** @type {SiteRouteRule[]} */
export const SITE_ROUTE_MAP = [
  {
    id: "visit",
    label: "面会",
    patterns: [/面会/],
    urls: ["https://kanai.or.jp/obstetrics/hospitalization/#visit"],
    boost: 200,
  },
  {
    id: "attend",
    label: "立ち会い分娩",
    patterns: [/立ち会い/],
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
    urls: ["https://kanai.or.jp/beginner/"],
    boost: 160,
  },
  {
    id: "hours_today",
    label: "本日・直近の診療可否",
    patterns: [/今日|明日|今週|午後は診|午前は診|本日.*診|休診.*今日|今日.*休診/],
    // 個別のお知らせ投稿は sitemap+鮮度スコアで拾う（一覧ページは優先しすぎない）
    urls: ["https://kanai.or.jp/beginner/"],
    boost: 80,
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
    label: "料金",
    patterns: [/料金|費用|予納|いくらかか/],
    urls: ["https://kanai.or.jp/beginner/", "https://kanai.or.jp/obstetrics/childbirth/"],
    boost: 140,
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
];

/**
 * @param {string} userMessage
 * @returns {Array<SiteRouteRule & { matchedPattern?: string }>}
 */
export function matchSiteRoutes(userMessage) {
  const msg = String(userMessage || "");
  if (!msg.trim()) return [];
  const out = [];
  for (const rule of SITE_ROUTE_MAP) {
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
