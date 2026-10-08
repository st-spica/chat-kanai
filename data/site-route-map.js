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
  photo_recording: {
    id: "photo_recording",
    label: "院内撮影・録音",
    /**
     * 写真・動画・録画・録音の可否が主目的の質問
     * （立ち会い・分娩は状況語になり得るため、撮影語があるときはこちらを優先）
     */
    pattern:
      /(?:写真|動画|映像|画像|撮影|録画|録音|撮[っれり]|SNS投稿|インスタ|SNS)/,
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
  gynecology: {
    id: "gynecology",
    label: "婦人科診療",
    /**
     * 婦人科ページ掲載の診療項目（同義語含む）
     * カテゴリ一致だけではチップにしない（本文裏付けは呼び出し側で確認）
     */
    pattern:
      /婦人科|アフターピル|緊急避妊薬|緊急避妊ピル|緊急避妊|低用量ピル|ピル|ブライダルチェック|性感染症|性病|STI|STD|更年期|生理不順|月経不順|月経困難|月経前緊張|子宮筋腫|内膜症|子宮頸がん|子宮がん検診/i,
  },
};

/**
 * 婦人科トピックの同義語グループ（質問語 ↔ 公式ページ記載）
 * @type {Array<{ id: string, query: RegExp, page: RegExp, expand: string[] }>}
 */
export const GYNECOLOGY_TOPIC_GROUPS = [
  {
    id: "emergency_contraception",
    query: /アフターピル|緊急避妊薬|緊急避妊ピル|緊急避妊/,
    page: /アフターピル|緊急避妊/,
    expand: ["アフターピル", "緊急避妊ピル", "緊急避妊薬"],
  },
  {
    id: "sti",
    query: /性感染症|性病|\bSTI\b|\bSTD\b/i,
    page: /性感染症|性病|クラミジア|淋菌|トリコモナス|梅毒|HIV|ヒトパピローマ/,
    expand: ["性感染症", "性病", "STI"],
  },
  {
    id: "menopause",
    query: /更年期/,
    page: /更年期/,
    expand: ["更年期", "更年期障害"],
  },
  {
    id: "menstrual",
    query: /生理不順|月経不順|月経困難|月経前緊張|生理痛/,
    page: /月経困難|月経前緊張|月経不順|月経|生理/,
    expand: ["月経困難症", "月経前緊張症", "月経不順"],
  },
  {
    id: "pill",
    query: /低用量ピル|(?<!アフター)ピル(?!処方の項目)/,
    page: /低用量ピル|ピル|アンジュ|マーベロン/,
    expand: ["ピル", "低用量ピル"],
  },
  {
    id: "bridal_check",
    query: /ブライダルチェック/,
    page: /ブライダルチェック/,
    expand: ["ブライダルチェック"],
  },
  {
    id: "myoma_endometriosis",
    query: /子宮筋腫|内膜症|卵巣のう腫/,
    page: /子宮筋腫|内膜症|卵巣のう腫/,
    expand: ["子宮筋腫", "子宮内膜症"],
  },
];

/** @param {string} userMessage */
export function matchGynecologyTopicGroups(userMessage) {
  const msg = String(userMessage || "");
  if (!msg.trim()) return [];
  return GYNECOLOGY_TOPIC_GROUPS.filter((g) => g.query.test(msg));
}

/**
 * 婦人科の診療内容に関する質問か（産後ケア・産科だけの文脈は除外）
 * @param {string} userMessage
 */
export function isGynecologyTopicMessage(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (/産後ケア|産後サポート|産後デイ|ショートステイ/.test(msg)) return false;
  if (QUERY_NORMALIZERS.gynecology.pattern.test(msg)) return true;
  return matchGynecologyTopicGroups(msg).length > 0;
}

/**
 * 公式ページ本文に、質問の婦人科トピックが実際に記載されているか
 * @param {string} userMessage
 * @param {string} pageText
 */
export function gynecologyPageSupportsQuery(userMessage, pageText) {
  const hay = String(pageText || "");
  if (!hay.trim()) return false;
  const groups = matchGynecologyTopicGroups(userMessage);
  if (groups.length) {
    return groups.some((g) => g.page.test(hay));
  }
  // 「婦人科」一般質問: ページが婦人科診療の説明であること
  return /婦人科|ピル|性感染|検診|ブライダル|更年期|月経/.test(hay);
}

/** @param {string} userMessage */
export function isPhotoRecordingFocusedMessage(userMessage) {
  return QUERY_NORMALIZERS.photo_recording.pattern.test(
    String(userMessage || "").trim()
  );
}

/** 赤ちゃん・乳児への言及か */
function mentionsInfant(msg) {
  return /赤ちゃん|新生児|乳児|生後|子ども|子供|お子さん/.test(msg);
}

const CHILD_AUDIENCE_RE =
  /子供|子ども|こども|小児|乳児|新生児|赤ちゃん|お子さま|お子様|幼児|お子さん/;
const VACCINATION_TOPIC_RE = /ワクチン|予防接種|接種/;

/**
 * 予防接種・ワクチン質問の対象者
 * @returns {"child"|"pregnant"|"adult_female"|"unspecified"|null}
 */
export function detectVaccinationAudience(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg || !VACCINATION_TOPIC_RE.test(msg)) return null;
  // 妊婦向け（赤ちゃんを守る母子免疫含む）を先に判定
  if (/妊婦|妊娠中|妊娠\d|妊婦さま|妊婦さん/.test(msg)) {
    return "pregnant";
  }
  if (CHILD_AUDIENCE_RE.test(msg)) {
    return "child";
  }
  if (/大人|成人|婦人科|女性の/.test(msg)) {
    return "adult_female";
  }
  return "unspecified";
}

/** お子さま（小児・乳児等）への予防接種可否の質問か */
export function isChildVaccinationQuery(userMessage) {
  return detectVaccinationAudience(userMessage) === "child";
}

/** 中絶・人工妊娠中絶の可否質問か（婦人科手術の一般ルールとは別扱い） */
export function isAbortionQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  return /中絶|人工妊娠中絶|妊娠を中断|妊娠中断/.test(msg);
}

/**
 * 婦人科手術（筋腫・卵巣嚢腫・内膜症・子宮摘出等）の可否か
 * 中絶・産科処置は含めない
 * @param {string} userMessage
 */
export function isGynecologicSurgeryQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg || isAbortionQuery(msg)) return false;
  // 産科・分娩関連の処置は除外
  if (
    /帝王切開|無痛分娩|吸引分娩|鉗子分娩|会陰切開|立ち会|分娩誘発/.test(msg) &&
    !/子宮筋腫|卵巣|内膜症|子宮摘出|婦人科手術/.test(msg)
  ) {
    return false;
  }
  const asksSurgery = /手術|オペ|摘出|切除|摘出術/.test(msg);
  if (!asksSurgery) return false;
  return /子宮筋腫|筋腫|卵巣嚢|卵巣のう|卵巣嚢腫|内膜症|子宮内膜症|子宮摘出|全摘|部分摘出|婦人科/.test(
    msg
  );
}

/** 婦人科疾患の診察・相談（手術を求めない） */
export function isGynecologicExamConsultQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg || isAbortionQuery(msg) || isGynecologicSurgeryQuery(msg)) return false;
  if (/薬|処方|内服/.test(msg)) return false;
  return (
    /子宮筋腫|卵巣嚢|卵巣のう|卵巣嚢腫|内膜症|子宮内膜症|婦人科疾患/.test(msg) &&
    /診(?:て|てもら)|見(?:て|てもら)|相談|診察|検査|チェック/.test(msg)
  );
}

/** 婦人科疾患の薬・処方（特定薬の保証はしない） */
export function isGynecologicMedicationQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg || isAbortionQuery(msg) || isGynecologicSurgeryQuery(msg)) return false;
  return (
    /子宮筋腫|卵巣嚢|卵巣のう|卵巣嚢腫|内膜症|子宮内膜症|婦人科/.test(msg) &&
    /薬|処方|内服|ホルモン/.test(msg)
  );
}

/**
 * 産み分け（性別選択）の可否・相談か
 * 「性別はいつ分かる」「エコーで性別を教えて」は含まない
 * @param {string} userMessage
 */
export function isGenderSelectionQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  // 性別の判明時期・エコー確認は産み分けではない
  if (
    /(?:エコー|超音波).{0,12}性別|性別.{0,12}(?:エコー|超音波|教えて|分か|わか|判定)|(?:いつ|何時).{0,8}性別|性別.{0,8}(?:いつ|何時)/.test(
      msg
    ) &&
    !/産み分け|選べます|選ぶ|選んで|希望して.*産/.test(msg)
  ) {
    return false;
  }
  if (/産み分け/.test(msg)) return true;
  if (/(?:性別を選|性別.*選べ|選べ.*性別|性別を希望)/.test(msg)) return true;
  if (/(?:男の子|女の子).{0,16}(?:産み分け|選べ|選ぶ|希望)/.test(msg)) return true;
  if (/産み分けの相談/.test(msg)) return true;
  return false;
}

/**
 * 赤ちゃんの体調・症状相談（健診まで待たせない）
 * @param {string} userMessage
 */
export function isBabyIllnessConsultMessage(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg || !mentionsInfant(msg)) return false;
  return /熱|発熱|ひきつけ|けいれん|痙攣|吐[いたく]|嘔吐|下痢|血便|発疹|黄疸|呼吸|ミルクを飲まない|母乳を飲まない|顔色が悪|元気がない|ぐったり|泣き止まない.*熱|水分が取れ/.test(
    msg
  );
}

/**
 * 母親の心身の不調・限界（健診まで待たせない）
 * @param {string} userMessage
 */
export function isMotherDistressConsultMessage(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (
    /死にたい|消えたい|自殺|自分を傷つけ|殺してしまい|赤ちゃんを傷|虐待しそう/.test(
      msg
    )
  ) {
    return true;
  }
  if (
    /育児.{0,16}(?:辛|つら|限界|疲れ|憂鬱|うつ|もう無理)|(?:辛|つら|限界|もう無理).{0,16}育児/.test(
      msg
    )
  ) {
    return true;
  }
  if (
    /(?:限界|もう無理|倒れそう|気持ちが沈|うつ)/.test(msg) &&
    /育児|子育て|赤ちゃん|産後|ママ/.test(msg)
  ) {
    return true;
  }
  return false;
}

/**
 * 日常的な育児の悩み（夜泣き・睡眠・生活リズム等 → 健診時相談案内）
 * 体調・母親の限界・緊急は含めない
 * @param {string} userMessage
 */
export function isDailyBabyCareConsultMessage(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isBabyIllnessConsultMessage(msg) || isMotherDistressConsultMessage(msg)) {
    return false;
  }
  if (/育児相談|育児の相談|子育て相談|育児について相談/.test(msg)) return true;
  if (
    /夜泣き|寝かしつけ|夜寝な|寝てくれな|眠れな[いく]|生活リズム|寝不足|寝かし/.test(
      msg
    ) &&
    (mentionsInfant(msg) || /夜泣き|育児|子育て|授乳/.test(msg))
  ) {
    return true;
  }
  if (
    mentionsInfant(msg) &&
    /(?:睡眠|寝る|眠|リズム|授乳|おっぱい|ミルク|育児).{0,16}(?:相談|悩|辛|つら|大変|疲れ)/.test(
      msg
    )
  ) {
    return true;
  }
  if (
    mentionsInfant(msg) &&
    /夜.{0,8}寝|寝.{0,8}(?:辛|つら|大変)|眠.{0,8}(?:辛|つら)/.test(msg)
  ) {
    return true;
  }
  return false;
}

/**
 * 質問の対象サービス（適用範囲）を推定する。
 * 同じ「面会」でも産科入院と産後ケアではルールが異なるため必須。
 * @param {string} userMessage
 * @returns {string|null}
 */
export function detectClinicService(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return null;
  // より具体的なサービスを先に判定
  if (/産後ケア|産後サポート|産後デイ|産後のデイ|ショートステイ/.test(msg)) {
    return "postpartum_care";
  }
  if (/産前産後教室|産前教室|産後教室|ママフィット|アクティブクラス/.test(msg)) {
    return "prenatal_postnatal_class";
  }
  // お子さまの予防接種（未実施サービス）
  if (isChildVaccinationQuery(msg)) {
    return "pediatric_vaccination";
  }
  // 産み分け（未実施）
  if (isGenderSelectionQuery(msg)) {
    return "gender_selection";
  }
  // 婦人科手術（未実施・中絶は別扱い）
  if (isGynecologicSurgeryQuery(msg)) {
    return "gynecologic_surgery";
  }
  // 日常的な育児相談 → 乳児健診の案内範囲（体調・母親限界は別扱い）
  if (isDailyBabyCareConsultMessage(msg)) {
    return "infant_checkup";
  }
  if (
    isGynecologyTopicMessage(msg) &&
    !/産科|分娩|出産|お産/.test(msg)
  ) {
    return "gynecology";
  }
  if (
    /入院中|産科入院|出産後の入院|分娩後.{0,8}入院|入院中の面会|入院の面会|面会時間/.test(
      msg
    ) ||
    (/入院/.test(msg) && /面会|お見舞い|夫|家族|友達|友人/.test(msg))
  ) {
    return "obstetric_hospitalization";
  }
  if (/立ち?会|立会い|分娩室|LDR/.test(msg) || /分娩予約|お産の予約/.test(msg)) {
    return "delivery";
  }
  if (/外来|初診|再診|WEB予約|ウェブ予約/.test(msg)) {
    return "outpatient";
  }
  return null;
}

/** 面会・お見舞い系の意図か（サービス判定とは独立） */
export function isVisitationIntentMessage(userMessage) {
  const msg = String(userMessage || "").trim();
  return (
    QUERY_NORMALIZERS.visit.pattern.test(msg) ||
    /面会|お見舞い|呼べる|呼んで|呼んでいい|来てもいい|来ていい|友達が来|友人が来/.test(
      msg
    )
  );
}

/** @param {string} userMessage */
export function isAttendFocusedMessage(userMessage) {
  const msg = String(userMessage || "").trim();
  // 撮影・録画の可否が主目的なら立ち会い専用ページに寄せない
  if (isPhotoRecordingFocusedMessage(msg)) return false;
  return QUERY_NORMALIZERS.attend.pattern.test(msg);
}

/** @param {string} userMessage */
export function isVisitFocusedMessage(userMessage) {
  const msg = String(userMessage || "").trim();
  // 「立ち会えます」等は立ち会い優先（面会の「会える」と混同しない）
  if (isAttendFocusedMessage(msg) || isPhotoRecordingFocusedMessage(msg)) {
    return false;
  }
  // 産後ケア中の面会は産科入院の面会ページ対象外
  if (detectClinicService(msg) === "postpartum_care") {
    return false;
  }
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
    id: "photo_recording",
    label: "院内撮影・録音",
    patterns: [QUERY_NORMALIZERS.photo_recording.pattern],
    urls: ["https://kanai.or.jp/notpermit/"],
    boost: 240,
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
    patterns: [QUERY_NORMALIZERS.gynecology.pattern],
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
  const photoHit = isPhotoRecordingFocusedMessage(msg);
  const service = detectClinicService(msg);
  const out = [];
  for (const rule of SITE_ROUTE_MAP) {
    // 立ち会い質問では面会ルートを付けない
    if (rule.id === "visit" && attendHit) continue;
    // 撮影可否が主目的のときは立ち会いルートを付けない（状況語の誤優先防止）
    if (rule.id === "attend" && photoHit) continue;
    // 産後ケアの面会では産科入院の面会ルートを付けない
    if (rule.id === "visit" && service === "postpartum_care") continue;
    // お子さまの予防接種は妊婦向けワクチンページを根拠にしない
    if (rule.id === "vaccine" && isChildVaccinationQuery(msg)) continue;
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
