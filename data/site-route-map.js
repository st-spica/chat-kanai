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
      /料金|費用|予納|予約金|いくらかか|お金はいくら|自己負担|入院費|分娩費用|出産費用|出産はいくら|費用はいくら|分娩料金|きょうだい割引|パパママ割引/,
  },
  delivery_benefits: {
    id: "delivery_reservation_benefits",
    label: "分娩予約特典",
    /**
     * 特典・キャンペーン・プレゼント・お祝いディナー（家族招待）系
     * ※きょうだい割引・パパママ割引（出産費用割引）は #price_birth 側
     */
    pattern:
      /(?:分娩|出産|お産).{0,12}(?:特典|キャンペーン|プレゼント|優待|お得)|(?:特典|キャンペーン|プレゼント|優待|お得).{0,12}(?:分娩|出産|お産)|分娩予約特典|出産特典|分娩特典|出産したら.{0,8}(?:特典|プレゼント)|出産すると.{0,8}(?:特典|プレゼント)|お祝いディナー|お祝いの食事|出産祝いの食事|家族とディナー|夫とディナー|家族も一緒に食べ|ディナーに呼|ディナーを食べ|(?:何人|何名).{0,8}招待|招待.{0,8}(?:何人|何名)|家族.{0,12}ディナー|ディナー.{0,12}(?:家族|夫|招待)|夫.{0,12}ディナー|お祝いディナーご招待/,
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
  return /赤ちゃん|新生児|乳児|生後|子ども|子供|お子さん|お子さま|お子様/.test(msg);
}

const KANJI_MONTH = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

/**
 * 文言から赤ちゃんの月齢（ヶ月）を推定する。不明なら null。
 * 生後半年→6、生後100日→約3、もうすぐ1歳→約12、1歳半→18 など。
 * @param {string} text
 * @returns {number|null}
 */
export function parseInfantAgeMonths(text) {
  const t = String(text || "");
  if (!t.trim()) return null;

  if (/1歳半|一歳半/.test(t)) return 18;
  if (/(?:もうすぐ|まもなく|もうすぐで)\s*1歳|1歳手前/.test(t)) return 12;

  const ageYears = t.match(/(?:^|[^0-9])(\d{1,2})\s*歳(?!半)/);
  if (ageYears) {
    const y = parseInt(ageYears[1], 10);
    if (y >= 0 && y <= 5) return y * 12;
  }
  if (/一歳(?!半)/.test(t)) return 12;

  if (
    /生後\s*半年|半年になる|半年です|半年なん|半年の赤ちゃん|赤ちゃん.{0,8}半年/.test(t)
  ) {
    return 6;
  }

  const monthNum = t.match(
    /(?:生後\s*)?(\d{1,2})\s*(?:か|カ|ヶ|箇)?\s*月/
  );
  if (monthNum) {
    const m = parseInt(monthNum[1], 10);
    if (m >= 0 && m <= 60) return m;
  }

  const monthKanji = t.match(
    /(?:生後\s*)?([一二三四五六七八九十])\s*(?:か|カ|ヶ|箇)?\s*月/
  );
  if (monthKanji && KANJI_MONTH[monthKanji[1]] != null) {
    return KANJI_MONTH[monthKanji[1]];
  }

  const days = t.match(/生後\s*(\d{1,3})\s*日/);
  if (days) {
    const d = parseInt(days[1], 10);
    if (d >= 0 && d <= 800) return Math.max(0, Math.round(d / 30));
  }

  const mou = t.match(/もう\s*(\d{1,2})\s*(?:か|カ|ヶ|箇)?\s*月/);
  if (mou) {
    const m = parseInt(mou[1], 10);
    if (m >= 0 && m <= 60) return m;
  }

  return null;
}

/**
 * 現在メッセージを優先し、なければ文脈から月齢を取る。
 * @param {string} userMessage
 * @param {string} [contextText]
 * @returns {number|null}
 */
export function detectInfantAgeMonths(userMessage, contextText = "") {
  const fromMsg = parseInfantAgeMonths(userMessage);
  if (fromMsg != null) return fromMsg;
  return parseInfantAgeMonths(contextText);
}

/**
 * 日常育児相談の案内先
 * - checkup: 1・2ヶ月健診時の相談（生後2ヶ月は健診済みと決めつけない）
 * - external: 保健センター・小児科など
 * - ask_age: 月齢確認が必要
 * @param {number|null|undefined} ageMonths
 * @returns {"checkup"|"external"|"ask_age"}
 */
export function resolveBabyCareGuidanceRoute(ageMonths) {
  if (ageMonths == null || !Number.isFinite(Number(ageMonths))) {
    return "ask_age";
  }
  const age = Number(ageMonths);
  // 生後2ヶ月までは健診対象時期として案内（終了済みとは断定しない）
  if (age <= 2) return "checkup";
  return "external";
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

const CHILD_ACCOMPANY_AUDIENCE_RE =
  /子供|子ども|こども|お子さま|お子様|お子さん|赤ちゃん|乳児|幼児|上の子|子連れ/;

const KIDS_ROOM_RE =
  /キッズ(?:ルーム|スペース)|子供が(?:遊べ|待て)|子どもが(?:遊べ|待て)|こどもが(?:遊べ|待て)|(?:子供|子ども|こども)が遊べる(?:場所|ところ)|待てる場所/;

const CHILD_ACCOMPANY_ACTION_RE =
  /連れ|一緒に(?:来|行|受診|病院)|同伴|子連れ|連れて行|連れてき|連れて来|連れてって|連れていって/;

/**
 * キッズルーム／キッズスペースの有無の質問か
 * @param {string} userMessage
 */
export function isKidsRoomQuery(userMessage) {
  return KIDS_ROOM_RE.test(String(userMessage || ""));
}

/**
 * スタッフ託児・診察中の預かりなど（同伴・キッズルームとは別）
 * @param {string} userMessage
 */
export function isChildcareRequestQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (
    !CHILD_ACCOMPANY_AUDIENCE_RE.test(msg) &&
    !/キッズ|託児/.test(msg)
  ) {
    return false;
  }
  return /預か|託児|保育士|見て(?:て|い)て|見守って|(?:に|を)預ける|預かり/.test(
    msg
  );
}

/**
 * お子さま本人の診察・診療可否（同伴来院とは別）
 * @param {string} userMessage
 */
export function isChildPatientExamQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isChildVaccinationQuery(msg)) return false;
  if (CHILD_ACCOMPANY_ACTION_RE.test(msg) || isKidsRoomQuery(msg)) return false;
  if (isChildcareRequestQuery(msg)) return false;
  if (!CHILD_ACCOMPANY_AUDIENCE_RE.test(msg) && !/小児/.test(msg)) return false;
  return /診察|診て(?:もらえ|もらえる|くれ)|診療|受診|小児科/.test(msg);
}

/**
 * お子さま同伴での来院／キッズルーム案内か
 * （予防接種・本人診察・託児預かり・育児相談とは分離）
 * @param {string} userMessage
 */
export function isChildAccompaniedVisitQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isChildVaccinationQuery(msg)) return false;
  if (isChildcareRequestQuery(msg)) return false;
  if (isChildPatientExamQuery(msg)) return false;
  if (isDailyBabyCareConsultMessage(msg) && !CHILD_ACCOMPANY_ACTION_RE.test(msg)) {
    return false;
  }
  if (isBabyIllnessConsultMessage(msg) && !CHILD_ACCOMPANY_ACTION_RE.test(msg)) {
    return false;
  }
  if (isKidsRoomQuery(msg)) return true;
  if (!CHILD_ACCOMPANY_AUDIENCE_RE.test(msg)) return false;
  return CHILD_ACCOMPANY_ACTION_RE.test(msg);
}

/** 中絶・人工妊娠中絶の可否質問か（婦人科手術の一般ルールとは別扱い） */
export function isAbortionQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  return /中絶|人工妊娠中絶|妊娠を中断|妊娠中断/.test(msg);
}

const INFERTILITY_TOPIC_RE =
  /不妊治療|不妊相談|不妊|妊活|タイミング療法|排卵誘発|排卵誘発剤|排卵誘発薬/;

const ADVANCED_INFERTILITY_RE =
  /体外受精|人工授精|顕微授精|ART|IVF|ICSI|採卵|胚移植|精子提供/;

/**
 * 高度生殖医療（一般不妊相談の範囲外）か
 * @param {string} userMessage
 */
export function isAdvancedInfertilityQuery(userMessage) {
  return ADVANCED_INFERTILITY_RE.test(String(userMessage || ""));
}

/**
 * 一般不妊相談・タイミング・排卵誘発の質問か
 * @param {string} userMessage
 */
export function isInfertilityConsultationQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isAdvancedInfertilityQuery(msg) && !INFERTILITY_TOPIC_RE.test(msg)) {
    // 体外受精のみの質問も不妊関連として扱う（範囲外案内用）
    return true;
  }
  return INFERTILITY_TOPIC_RE.test(msg);
}

/**
 * 不妊相談の曜日・担当医の質問か（推測禁止・体制表案内）
 * @param {string} userMessage
 */
export function isInfertilityScheduleQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isInfertilityConsultationQuery(msg)) return false;
  return /何曜日|どの曜日|曜日|いつ行け|いつ来|どの先生|担当|先生が|誰が|スケジュール|体制表/.test(
    msg
  );
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

/** お祝いディナー／院内食事の話題か（履歴含む） */
export function mentionsCelebrationDinnerTopic(text) {
  return /お祝いディナー|(?:お祝い|出産祝い)の食事|ディナーご招待|(?:お祝い)?ディナー|レストランBebe|レストランBébé/.test(
    String(text || "")
  );
}

/**
 * 苦手・好き嫌い・メニュー変更・特定食材を出したくない等の食事カスタム要望か
 * （アレルギーは含めない）
 * @param {string} userMessage
 */
export function isFoodDislikeOrRemovalRequest(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg || /アレルギー/.test(msg)) return false;
  if (
    /メニュー(?:を)?変更|メニューは?選べ|メニューを?選|食材(?:を|は)?選|食材変更|メニューを?変え/.test(
      msg
    )
  ) {
    return true;
  }
  if (/嫌いな(?:食材|食べ物)|苦手な(?:食材|食べ物)|好き嫌い/.test(msg)) {
    return true;
  }
  if (
    /抜いてほし|外してほし|除いてほし|使わないで|入れないで|出して(?:欲|ほ)しく(?:ない|無い)|出さないで/.test(
      msg
    )
  ) {
    return true;
  }
  // 「にんじん食べれないので出して欲しくない」など
  if (
    /(?:食べれ|食べられ)ない|苦手|嫌い/.test(msg) &&
    /出して(?:欲|ほ)しく(?:ない|無い)|抜いて|外して|入れないで|使わないで/.test(
      msg
    )
  ) {
    return true;
  }
  return false;
}

/**
 * お祝いディナー等の食物アレルギー確認か（好き嫌い・メニュー変更とは別）
 * @param {string} userMessage
 * @param {string} [contextText] 直前の会話など（ディナー文脈の補完）
 */
export function isCelebrationDinnerAllergyQuery(userMessage, contextText = "") {
  const msg = String(userMessage || "").trim();
  if (!msg || !/アレルギー/.test(msg)) return false;
  // 薬剤・検査など食事以外のアレルギーは除外
  if (/薬|薬物|造影|麻酔|ヨード|抗生物質|ペニシリン|ラテックス|ワクチン/.test(msg)) {
    return false;
  }
  const ctx = `${msg}\n${String(contextText || "")}`;
  if (
    mentionsCelebrationDinnerTopic(ctx) ||
    /レストラン|入院食|入院中の食事|お食事|食材/.test(ctx)
  ) {
    return true;
  }
  // 「アレルギーがあるのですが対応できますか」など短い食事アレルギー確認
  return /対応|避け|できますか|大丈夫/.test(msg);
}

/**
 * お祝いディナーの苦手食材・好き嫌い・メニュー変更か（アレルギーは含めない）
 * @param {string} userMessage
 * @param {string} [contextText] 直前の会話など（ディナー文脈の補完）
 */
export function isCelebrationDinnerFoodRequestQuery(userMessage, contextText = "") {
  const msg = String(userMessage || "").trim();
  if (!msg || isCelebrationDinnerAllergyQuery(msg, contextText)) return false;
  if (!isFoodDislikeOrRemovalRequest(msg)) return false;
  const ctx = `${msg}\n${String(contextText || "")}`;
  if (mentionsCelebrationDinnerTopic(ctx) || /レストラン/.test(ctx)) {
    return true;
  }
  // ディナー未言及でも、院内の食事カスタム要望として扱う（当院の確定情報はお祝いディナー）
  return true;
}

/** 夜診・夜間診察の言及か */
export function mentionsEveningConsultation(text) {
  return /夜診|夜の診察|夕方の診察|夜間診|夜の外来/.test(String(text || ""));
}

/**
 * 夜診の診療時間・曜日のみの質問か（予約可否は含めない）
 * @param {string} userMessage
 */
export function isEveningConsultationHoursQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg || !mentionsEveningConsultation(msg)) return false;
  if (/予約/.test(msg)) return false;
  return /何時|時間|から|まで|開い|やって|何時台|何曜日|どの曜日|曜日|ありますか/.test(
    msg
  );
}

/**
 * 夜診の予約可否・受付順か（他の診療予約・時間のみ質問と分離）
 * @param {string} userMessage
 * @param {string} [contextText] 直前会話（夜診文脈の補完）
 */
export function isEveningConsultationReservationQuery(
  userMessage,
  contextText = ""
) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  // 他サービスの予約には流用しない
  if (
    /妊婦健診|婦人科|初診|再診|産前産後教室|教室予約|WEB予約|ウェブ予約|ネット予約/.test(
      msg
    ) &&
    !mentionsEveningConsultation(msg)
  ) {
    return false;
  }
  if (isEveningConsultationHoursQuery(msg)) return false;

  const ctx = `${msg}\n${String(contextText || "")}`;
  const eveningInMsg = mentionsEveningConsultation(msg);
  const eveningInCtx = mentionsEveningConsultation(contextText);
  // 直前が夜診で、今回が「予約できますか？」だけ
  const followUpReserve =
    eveningInCtx &&
    !eveningInMsg &&
    /予約/.test(msg) &&
    msg.length <= 40 &&
    !/妊婦健診|婦人科|初診|WEB|ウェブ/.test(msg);

  if (!eveningInMsg && !followUpReserve) return false;

  return (
    /予約|受付順|予約なし|予約無し|予約しなくても|予約せず|予約しないで|取りたい|取れる/.test(
      msg
    ) || followUpReserve
  );
}

/**
 * 産後ケア等、分娩入院以外の持ち物か
 * @param {string} userMessage
 */
export function isNonChildbirthBelongingsQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  return /産後ケア|産後サポート|ショートステイ|産後デイ/.test(msg);
}

/**
 * 分娩・出産入院の持ち物／入院バッグ／持参の要否か
 * 産後ケアの持ち物は含めない
 * @param {string} userMessage
 */
export function isHospitalBagQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg || isNonChildbirthBelongingsQuery(msg)) return false;

  if (
    /入院時の持ち物|入院の持ち物|入院するとき何が必要|出産の入院準備|入院バッグ|陣痛バッグ|入院準備を|持ち物を知りたい|持ち物を全部|必要な持ち物を全部|持ち物を教えて|何を持っていけば/.test(
      msg
    )
  ) {
    return true;
  }
  if (
    /(?:入院|出産|分娩).{0,16}(?:持ち物|準備|何を持|バッグ)|(?:持ち物|何を持|バッグ).{0,16}(?:入院|出産|分娩)/.test(
      msg
    )
  ) {
    return true;
  }
  // 病院側の用意・アメニティ・持参不要
  if (
    /(?:病院|当院).{0,12}(?:用意|支給|貸|置いて)|(?:用意|支給|貸).{0,12}(?:病院|当院)|アメニティ|持っていかなくて|持参しなくて|持参不要|自分で持っていかなくて|支給される|貸してもらえる/.test(
      msg
    )
  ) {
    return true;
  }
  // 個別品目の持参要否（分娩入院文脈）
  if (
    /(?:パジャマ|ルームウェア|スリッパ|シャンプー|リンス|コンディショナー|ボディソープ|タオル|病衣|マタニティガウン|歯ブラシ|歯みがき|歯磨き|ドライヤー).{0,16}(?:持|必要|持参|持って|用意|ある|あります)|(?:持|必要|持参|持って|用意).{0,16}(?:パジャマ|ルームウェア|スリッパ|シャンプー|リンス|コンディショナー|ボディソープ|タオル|歯ブラシ|歯みがき|歯磨き)/.test(
      msg
    )
  ) {
    return true;
  }
  if (/赤ちゃんの(?:退院時の)?(?:服|衣服).{0,12}(?:必要|持|持参)/.test(msg)) {
    return true;
  }
  return false;
}

/**
 * 持ち物の全一覧希望か
 * @param {string} userMessage
 */
export function isHospitalBagFullListQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isHospitalBagQuery(msg)) return false;
  return /全部|すべて|全て|一覧|詳しく|詳細/.test(msg);
}

/**
 * 入院持ち物の質問フォーカス
 * @returns {"patient_bring"|"hospital_provided"|"hospital_provided_full"|"full_list"|"item_hospital_provided"|"item_patient_bring"|"item_baby_clothes"|null}
 */
export function detectHospitalBagFocus(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg || !isHospitalBagQuery(msg)) return null;

  const wantsFull = isHospitalBagFullListQuery(msg);
  const hospitalProvidedAsk =
    /(?:病院|当院).{0,12}(?:用意|支給|貸|置いて)|(?:用意|支給|貸).{0,12}(?:病院|当院)|アメニティ|持っていかなくて|持参しなくて|持参不要|自分で持っていかなくて|支給される|貸してもらえる|用意してくれる|用意してくれ/.test(
      msg
    );

  if (wantsFull && hospitalProvidedAsk) return "hospital_provided_full";
  if (wantsFull) return "full_list";

  // 個別品目（先に判定）
  if (/歯ブラシ|歯みがき|歯磨き/.test(msg)) return "item_patient_bring";
  if (/赤ちゃんの(?:退院時の)?(?:服|衣服)/.test(msg)) return "item_baby_clothes";
  if (
    /パジャマ|ルームウェア|スリッパ|シャンプー|リンス|コンディショナー|ボディソープ|タオル|ドライヤー|病衣|マタニティガウン|箱ティッシュ|お産パッド|清浄綿/.test(
      msg
    ) &&
    /持|必要|持参|持って|用意|ある|あります|支給|貸/.test(msg)
  ) {
    return "item_hospital_provided";
  }

  if (hospitalProvidedAsk) return "hospital_provided";
  return "patient_bring";
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

/** 妊婦健診・妊娠経過の文脈か */
export function mentionsPrenatalCheckupTopic(text) {
  return /妊婦健診|妊婦検|健診枠|妊娠|妊婦|胎嚢|産科|健診/.test(
    String(text || "")
  );
}

/**
 * 婦人科診察でのエコー頻度か（妊婦健診ルールを流用しない）
 * @param {string} userMessage
 */
export function isGynecologyUltrasoundFrequencyQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (!/エコー|超音波/.test(msg)) return false;
  if (!/婦人科/.test(msg)) return false;
  return /毎回|頻度|いつから|してもらえ/.test(msg) || /診察/.test(msg);
}

/**
 * 妊婦健診でのエコー頻度・胎嚢確認前後の案内か
 * @param {string} userMessage
 * @param {string} [contextText] 直前会話（妊婦健診文脈の補完）
 */
export function isPrenatalUltrasoundFrequencyQuery(
  userMessage,
  contextText = ""
) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isGynecologyUltrasoundFrequencyQuery(msg)) return false;

  const ctx = `${msg}\n${String(contextText || "")}`;

  // 胎嚢未確認のフォロー（エコー頻度の文脈）
  if (
    /胎嚢/.test(msg) &&
    /確認できていな|見えな|まだ|写っていな|写らな/.test(msg)
  ) {
    return (
      mentionsPrenatalCheckupTopic(ctx) ||
      /エコー|超音波/.test(ctx) ||
      mentionsPrenatalCheckupTopic(msg)
    );
  }

  if (!/エコー|超音波/.test(msg)) return false;
  if (!/毎回|いつから|頻度|毎回来/.test(msg)) return false;

  // 明示的に妊婦健診／妊娠／胎嚢
  if (/妊婦健診|妊婦|妊娠|胎嚢|産科/.test(msg)) return true;
  // 直前が妊婦健診の話
  if (mentionsPrenatalCheckupTopic(contextText)) return true;
  // 産婦人科チャットでは「エコーは毎回？」を妊婦健診として扱う（婦人科明示時は上で除外済み）
  return true;
}

/**
 * 赤ちゃんの体調・症状相談（健診まで待たせない）
 * @param {string} userMessage
 */
export function isBabyIllnessConsultMessage(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg || !mentionsInfant(msg)) return false;
  return /熱|発熱|ひきつけ|けいれん|痙攣|吐[いたく]|嘔吐|下痢|血便|発疹|黄疸|呼吸|息苦|息が苦|ミルクを飲まない|母乳を飲まない|顔色が悪|元気がない|ぐったり|泣き止まない.*熱|水分が取れ/.test(
    msg
  );
}

/**
 * 乳児の緊急性が高い呼吸・意識などの訴えか
 * @param {string} userMessage
 */
export function isInfantUrgentSymptomMessage(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg || !mentionsInfant(msg)) return false;
  return /息苦|息が苦|呼吸しづら|呼吸困難|呼吸が速|顔色が悪|ぐったり|けいれん|痙攣|ひきつけ|意識/.test(
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
  // 分娩入院の持ち物
  if (isHospitalBagQuery(msg)) {
    return "childbirth_hospitalization";
  }
  // 夜診の予約（受付順・予約不可）
  if (isEveningConsultationReservationQuery(msg)) {
    return "evening_consultation";
  }
  // お子さま同伴・キッズルーム（託児・本人診察・予防接種とは分離）
  if (isChildAccompaniedVisitQuery(msg)) {
    return "outpatient_visit";
  }
  // 一般不妊相談（高度生殖医療の可否断定はしない）
  if (isInfertilityConsultationQuery(msg) || isAdvancedInfertilityQuery(msg)) {
    return "general_infertility_consultation";
  }
  // つわり・妊娠中の服薬・葉酸
  if (
    /つわり|悪阻|妊娠.{0,8}(?:気持|吐き気|吐)|葉酸|妊娠中.{0,12}薬|妊婦.{0,8}薬/.test(
      msg
    )
  ) {
    return "pregnancy_health_support";
  }
  // 分娩料金（産後ケア料金は除外）
  if (
    /予約金|予納金|出産費用|分娩費用|分娩料金|入院費|きょうだい割引|パパママ割引|出産育児一時金/.test(
      msg
    ) &&
    !/産後ケア|産後サポート|母乳ケア/.test(msg)
  ) {
    return "childbirth";
  }
  // 診療時間・休診（確定データ）
  if (
    /診療時間|診察時間|休診|午前診|午後診|夜診|第[1-5]土曜|何時から|何時まで/.test(
      msg
    )
  ) {
    return "clinic_hours";
  }
  // 妊婦健診のエコー頻度
  if (isPrenatalUltrasoundFrequencyQuery(msg)) {
    return "prenatal_checkup";
  }
  // 婦人科のエコー頻度（妊婦健診と分離）
  if (isGynecologyUltrasoundFrequencyQuery(msg)) {
    return "gynecology";
  }
  // お祝いディナー（家族招待・食材変更・アレルギー）
  if (
    isCelebrationDinnerAllergyQuery(msg) ||
    isCelebrationDinnerFoodRequestQuery(msg) ||
    /お祝いディナー|出産祝いの食事|お祝いの食事/.test(msg) ||
    (/ディナー/.test(msg) && /(?:家族|夫|旦那|パートナー|招待)/.test(msg))
  ) {
    return "celebration_dinner";
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
  const msg = String(userMessage || "").trim();
  // 出産費用割引（きょうだい・パパママ）は分娩料金ページへ（特典ページと分離）
  if (
    /きょうだい割引|兄弟割引|姉妹割引|パパママ割引|独自.{0,8}割引|割引制度/.test(
      msg
    ) ||
    (/割引/.test(msg) &&
      /(?:出産費用|分娩費用|入院費|2人目|二人目|２人目|第二子|当院で生|夫が|旦那が|夫婦で受診)/.test(
        msg
      ) &&
      !/特典|プレゼント|キャンペーン|ディナー|お祝い/.test(msg))
  ) {
    return false;
  }
  return QUERY_NORMALIZERS.delivery_benefits.pattern.test(msg);
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
    id: "infertility_consultation",
    label: "一般不妊相談",
    patterns: [
      /不妊治療|不妊相談|不妊|妊活|タイミング療法|排卵誘発|排卵誘発剤/,
      /体外受精|人工授精|顕微授精/,
    ],
    urls: ["https://kanai.or.jp/beginner/#doctor_schedule"],
    boost: 260,
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
    id: "hospital_bag",
    label: "入院時の持ち物",
    patterns: [
      /入院時の持ち物|入院の持ち物|入院バッグ|陣痛バッグ|出産の入院準備|入院するとき何が必要|持ち物を知りたい|持ち物を全部|何を持っていけば/,
      /(?:病院|当院).{0,12}(?:用意|支給)|アメニティ|持っていかなくて|持参しなくて|用意してくれる/,
      /(?:パジャマ|スリッパ|シャンプー|歯ブラシ|歯みがき|退院時の(?:服|衣服)).{0,12}(?:持|必要|持参|用意)/,
      /(?:入院|出産|分娩).{0,12}(?:持ち物|準備|何を持)/,
    ],
    urls: ["https://kanai.or.jp/obstetrics/childbirth/#hos_bring"],
    boost: 260,
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
    id: "child_accompanied_visit",
    label: "お子さま同伴・キッズルーム",
    patterns: [
      /子連れ|連れて行|連れてき|連れて来|上の子を連れ|赤ちゃんを連れ/,
      /(?:子供|子ども|こども|お子さま|お子様|赤ちゃん).{0,12}(?:一緒|連れ|同伴)/,
      /キッズ(?:ルーム|スペース)|遊べる(?:場所|ところ)|待てる場所/,
    ],
    urls: ["https://kanai.or.jp/facilities/"],
    boost: 250,
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
    patterns: [
      /妊婦健診|妊婦検|健診枠/,
      /(?:エコー|超音波).{0,12}(?:毎回|いつから)|(?:毎回|いつから).{0,12}(?:エコー|超音波)/,
    ],
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
    id: "birth_reservation_deposit",
    label: "分娩予約金",
    patterns: [
      /分娩予約金|出産(?:の)?予約金|予約金/,
      /分娩予約.{0,8}(?:お金|費用|料金|いくら)/,
    ],
    urls: ["https://kanai.or.jp/obstetrics/childbirth/#price_birth"],
    boost: 280,
  },
  {
    id: "birth_advance_payment",
    label: "分娩予納金",
    patterns: [/分娩予納金|予納金/, /出産前.{0,10}(?:いくら|払|支払)/],
    urls: ["https://kanai.or.jp/obstetrics/childbirth/#price_birth"],
    boost: 280,
  },
  {
    id: "birth_cost_discount",
    label: "出産費用割引",
    patterns: [
      /きょうだい割引|兄弟割引|パパママ割引/,
      /独自.{0,8}割引|割引制度|出産費用が安|分娩費用が安/,
      /(?:出産|分娩).{0,10}割引|割引.{0,10}(?:出産|分娩)|2人目.{0,8}割引|二人目.{0,8}割引/,
      /夫婦で受診.{0,8}割引|(?:夫|旦那).{0,12}生まれ/,
    ],
    urls: ["https://kanai.or.jp/obstetrics/childbirth/#price_birth"],
    boost: 270,
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
    // 食材変更・アレルギーは特典ページに対応範囲の記載がないためルート付けしない
    if (
      (rule.id === "delivery_reservation_benefits" ||
        rule.id === "delivery_benefits") &&
      (isCelebrationDinnerFoodRequestQuery(msg) ||
        isCelebrationDinnerAllergyQuery(msg))
    ) {
      continue;
    }
    // 分娩入院の持ち物は #hos_bring 専用。一般入院・産後ケアルートを付けない
    if (isHospitalBagQuery(msg)) {
      if (rule.id === "hospitalization" || rule.id === "aftercare") continue;
    }
    if (rule.id === "hospital_bag" && isNonChildbirthBelongingsQuery(msg)) {
      continue;
    }
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
