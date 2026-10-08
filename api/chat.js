import OpenAI, { APIConnectionError, APIError } from "openai";
import { ratelimit, hasUpstashConfig } from "./_ratelimit.js";
import { appendChatLog } from "./_chatLog.js";
import {
  ATTEND_INFO_PAGE_URL,
  buildTokyoDatetimeSystemPrompt,
  getSiteKnowledgeSnippetSupplement,
  getTokyoNowParts,
  HOSPITAL_BAG_PAGE_URL,
  isAttendFocusedQuery,
  isGenericKanaiHomeUrl,
  isMeetingFocusedQuery,
  isPhotoRecordingFocusedQuery,
  MEETING_INFO_PAGE_URL,
  filterPagesBySitemap,
  rewriteLegacyKanaiUrl,
  sourcePagesFromChunks,
  peekSiteKnowledgeStatus,
  labelForKnowledgeChunk,
} from "./_siteKnowledge.js";
import {
  buildClinicRegisteredKnowledgePrompt,
  detectClinicIntent,
  isClinicKnowledgeStrong,
  peekClinicKnowledgeStatus,
  searchClinicKnowledge,
} from "./_clinicKnowledge.js";
import {
  detectClinicService,
  detectInfantAgeMonths,
  detectVaccinationAudience,
  gynecologyPageSupportsQuery,
  isBabyIllnessConsultMessage,
  isChildVaccinationQuery,
  isDailyBabyCareConsultMessage,
  isDeliveryBenefitsFocusedMessage,
  isAbortionQuery,
  isCelebrationDinnerAllergyQuery,
  isCelebrationDinnerFoodRequestQuery,
  isAdvancedInfertilityQuery,
  isChildAccompaniedVisitQuery,
  isChildcareRequestQuery,
  isChildPatientExamQuery,
  isInfertilityConsultationQuery,
  isInfertilityScheduleQuery,
  isKidsRoomQuery,
  isGenderSelectionQuery,
  isGynecologicExamConsultQuery,
  isGynecologicMedicationQuery,
  isGynecologicSurgeryQuery,
  isGynecologyTopicMessage,
  isGynecologyUltrasoundFrequencyQuery,
  isEveningConsultationHoursQuery,
  isEveningConsultationReservationQuery,
  detectHospitalBagFocus,
  isHospitalBagFullListQuery,
  isHospitalBagQuery,
  isInfantUrgentSymptomMessage,
  isMotherDistressConsultMessage,
  isNonChildbirthBelongingsQuery,
  isPrenatalUltrasoundFrequencyQuery,
  isVisitationIntentMessage,
  parseInfantAgeMonths,
  resolveBabyCareGuidanceRoute,
} from "../data/site-route-map.js";
import {
  buildClinicHoursAnswer,
  buildFullHoursRichHtml,
  CLINIC_HOURS_REF_PAGE,
  isClinicHoursQuery,
} from "../data/clinic-hours.js";
import {
  buildBirthPricingAnswer,
  BIRTH_PRICING_REF_PAGE,
  detectBirthPricingDrift,
  isBirthPricingQuery,
  isPostpartumCareFeeQuery,
} from "../data/birth-pricing.js";

const WEB_RESERVATION_NO_INFO_ANSWER =
  "WEB予約について確認できる情報がありません。お手数ですが、当院へお電話でお問い合わせください。";

const POSTPARTUM_VISITATION_NO_INFO_ANSWER =
  "産後ケアをご利用中の面会については、現在確認できる情報がありません。詳しくは当院まで直接お問い合わせください。";

const CHILD_VACCINATION_NOT_OFFERED_ANSWER =
  "申し訳ありませんが、当院ではお子さまの予防接種は行っておりません。お子さまの予防接種については、小児科などの医療機関へご相談ください。";

const GENDER_SELECTION_NOT_OFFERED_ANSWER =
  "申し訳ありませんが、当院では産み分けには対応しておりません。産み分けをご希望の場合は、専門の医療機関へご相談ください。";

const FACILITIES_REF_PAGE = {
  url: "https://kanai.or.jp/facilities/",
  title: "院内施設のご案内",
};

const INFERTILITY_SCHEDULE_REF_PAGE = {
  url: "https://kanai.or.jp/beginner/#doctor_schedule",
  title: "診療体制表はこちら",
};

const INFERTILITY_GENERAL_ANSWER = [
  "当院では、一般不妊相談に対応しております。",
  "",
  "妊娠を急がない方を対象に、",
  "タイミング療法や排卵誘発法（内服薬の処方）のみ",
  "対応しています。",
  "",
  "対応できる医師は曜日によって異なりますので、",
  "下記の診療体制表をご確認のうえ、",
  "日程を合わせてご受診ください。",
].join("\n");

const INFERTILITY_SCHEDULE_ANSWER = [
  "一般不妊相談に対応できる医師は曜日によって異なります。",
  "下記の診療体制表をご確認のうえ、日程を合わせてご受診ください。",
].join("\n");

const INFERTILITY_TIMING_ANSWER = [
  "はい。一般不妊相談の範囲で、タイミング療法に対応しています。",
  "対応できる医師は曜日によって異なりますので、診療体制表をご確認ください。",
].join("\n");

const INFERTILITY_OVULATION_ANSWER = [
  "はい。一般不妊相談の範囲で、排卵誘発法（内服薬の処方）に対応しています。",
  "実際の処方の可否は、医師の診察・判断によります。",
  "対応できる医師は曜日によって異なりますので、診療体制表をご確認ください。",
].join("\n");

const INFERTILITY_ADVANCED_OUT_OF_SCOPE_ANSWER = [
  "当院で対応している一般不妊相談は、タイミング療法と排卵誘発法（内服薬の処方）のみです。",
  "体外受精・人工授精・顕微授精などについては、一般不妊相談の対応範囲には含まれません。",
].join("\n");

/**
 * @param {string} userMessage
 * @returns {{ answer: string, focus: string }|null}
 */
function buildInfertilityConsultationAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isInfertilityConsultationQuery(msg) && !isAdvancedInfertilityQuery(msg)) {
    return null;
  }
  if (isAdvancedInfertilityQuery(msg)) {
    return { answer: INFERTILITY_ADVANCED_OUT_OF_SCOPE_ANSWER, focus: "advanced" };
  }
  if (isInfertilityScheduleQuery(msg)) {
    return { answer: INFERTILITY_SCHEDULE_ANSWER, focus: "schedule" };
  }
  if (/タイミング/.test(msg)) {
    return { answer: INFERTILITY_TIMING_ANSWER, focus: "timing" };
  }
  if (/排卵誘発/.test(msg)) {
    return { answer: INFERTILITY_OVULATION_ANSWER, focus: "ovulation" };
  }
  return { answer: INFERTILITY_GENERAL_ANSWER, focus: "general" };
}

const CHILD_ACCOMPANY_HINT_RE =
  /連れ|一緒|同伴|子連れ|連れて行|連れてき|連れて来|上の子/;

const CHILD_ACCOMPANIED_VISIT_ANSWER = [
  "はい、お子さまと一緒にご来院いただけます。",
  "当院にはキッズルームもございますので、お子さま連れの方もご利用いただけます。",
  "",
  "院内の設備については、以下のページをご覧ください。",
].join("\n");

const KIDS_ROOM_AVAILABLE_ANSWER = [
  "はい、当院にはキッズルームがございます。",
  "院内の設備については、以下のページをご覧ください。",
].join("\n");

const CHILDCARE_NOT_OFFERED_ANSWER = [
  "申し訳ありませんが、スタッフによるお子さまのお預かりや託児サービスは行っておりません。",
  "なお、院内にはキッズルームがございます。",
].join("\n");

const CHILD_PATIENT_EXAM_NO_INFO_ANSWER =
  "お子さまご本人の診察・診療については、現在確認できる情報がありません。当院は産婦人科です。詳しくは当院までお問い合わせください。";

/**
 * @param {string} userMessage
 * @returns {{ answer: string, focus: string }|null}
 */
function buildChildAccompaniedVisitAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (isKidsRoomQuery(msg) && !CHILD_ACCOMPANY_HINT_RE.test(msg)) {
    return { answer: KIDS_ROOM_AVAILABLE_ANSWER, focus: "kids_room" };
  }
  if (isChildAccompaniedVisitQuery(msg)) {
    return { answer: CHILD_ACCOMPANIED_VISIT_ANSWER, focus: "accompany" };
  }
  return null;
}

const CELEBRATION_DINNER_FOOD_REQUEST_ANSWER =
  "お祝いディナーはあらかじめメニューが決まっているため、苦手な食材による変更は原則として承っておりません。\nただし、可能な範囲で配慮いたしますので、スタッフにお伝えください。";

const CELEBRATION_DINNER_ALLERGY_ANSWER =
  "食物アレルギーについては安全に関わるため、事前にスタッフへご相談ください。対応の可否についてはお約束できません。";

const PRENATAL_ULTRASOUND_FREQUENCY_ANSWER =
  "エコーについては、妊娠の進み具合や状況によって異なりますが、当院では胎嚢が確認できるようになると、毎回の妊婦健診でエコーを行っています。";

const PRENATAL_ULTRASOUND_BEFORE_SAC_ANSWER =
  "胎嚢が確認できるまでの時期は、妊娠の進み具合や状況によってエコーの有無が異なります。当院では胎嚢が確認できるようになると、毎回の妊婦健診でエコーを行っています。";

const GYNECOLOGY_ULTRASOUND_FREQUENCY_NO_INFO_ANSWER =
  "婦人科診察でのエコーの頻度については、現在確認できる情報がありません。詳しくは当院までお問い合わせください。";

const PRENATAL_CHECKUP_REF_PAGE = {
  url: "https://kanai.or.jp/obstetrics/checkup/",
  title: "妊婦健診について",
};

const HOSPITAL_BAG_REF_PAGE = {
  url: HOSPITAL_BAG_PAGE_URL,
  title: "入院時の持ち物について",
};

const HOSPITAL_BAG_SUMMARY_ANSWER = [
  "ご入院の際には、母子健康手帳・健康保険証・診察券、産褥用ショーツ、授乳ブラ、母乳パッド、赤ちゃんの退院時の衣服などをご用意ください。",
  "",
  "また、マタニティガウンやタオル、シャンプーなどは当院でご用意しています。",
  "",
  "持ち物の詳しい一覧は、以下のページからご確認いただけます。",
].join("\n");

/** 病院側用意品（代表例・公式表記に合わせる） */
const HOSPITAL_BAG_HOSPITAL_PROVIDED_ANSWER = [
  "当院では、ご入院中に使用するマタニティガウンやタオル、スリッパ、シャンプー・コンディショナー、ボディソープなどをご用意しています。",
  "",
  "その他のご用意しているものについては、以下のページをご確認ください。",
].join("\n");

const HOSPITAL_BAG_PROVIDED_ITEM_ANSWER =
  "当院でご用意していますので、持参の必要はありません。詳しくは以下のページをご確認ください。";

const HOSPITAL_BAG_BABY_CLOTHES_ANSWER =
  "赤ちゃんの退院時の衣服（1組）は、ご用意いただく物に含まれます。詳しくは以下のページをご確認ください。";

const HOSPITAL_BAG_TOOTHBRUSH_ANSWER =
  "歯みがきセットは、ご用意いただく物に含まれます。詳しくは以下のページをご確認ください。";

const HOSPITAL_BAG_HOSPITAL_PROVIDED_FULL_ANSWER = [
  "【当院でご用意している物】",
  "",
  "【ママ用】",
  "・病衣（マタニティガウン）",
  "・バスタオル・フェイスタオル",
  "・箱ティッシュ",
  "・お産パッド、清浄綿（授乳用）",
  "・シャンプー・コンディショナー、ボディソープ、ヘアドライヤー、スリッパ",
  "",
  "【赤ちゃん用】",
  "・入院中の衣服（Bébéオリジナル ベビー肌着）",
  "・バスタオル",
  "・新生児用紙オムツ、おしりふき、おへそ消毒セット",
  "",
  "詳細は以下のページをご確認ください。",
].join("\n");

const HOSPITAL_BAG_FULL_LIST_ANSWER = [
  "【ご用意いただく物（主なもの）】",
  "・母子健康手帳・健康保険証・診察券",
  "・予納金仮領収証、筆記用具",
  "・産褥用ショーツ（4〜5枚）、授乳ブラ、母乳パッド",
  "・赤ちゃん用ガーゼハンカチ、赤ちゃんの退院時の衣服（1組）",
  "・マスク、歯みがきセット、コップ、服用している薬",
  "・間食（必要な方のみ）",
  "・新生児聴覚検査受検票（大阪市ほか対象市町村の方は必須）",
  "",
  "【分娩セット（記名した袋にまとめる）】",
  "・骨盤ベルト",
  "・腹帯（予定帝王切開の方のみ）",
  "・バスタオル1枚、産褥用ショーツ1枚",
  "",
  "【当院でご用意している物】",
  "・病衣（マタニティガウン）、バスタオル・フェイスタオル、箱ティッシュ",
  "・お産パッド、清浄綿",
  "・シャンプー・コンディショナー、ボディソープ、ヘアドライヤー、スリッパ",
  "・赤ちゃん用の入院中の衣服・オムツ・おしりふき・おへそ消毒セットなど",
  "",
  "詳細は以下のページをご確認ください。",
].join("\n");

const POSTPARTUM_BELONGINGS_NO_INFO_ANSWER =
  "産後ケアの持ち物については、現在確認できる情報がありません。詳しくは当院までお問い合わせください。";

const EVENING_RESERVATION_UNAVAILABLE_ANSWER = [
  "夜診は予約制ではなく、受付順での診察となります。",
  "事前予約はできませんので、ご来院のうえ受付をお願いいたします。",
].join("\n");

const EVENING_RESERVATION_FOLLOWUP_ANSWER =
  "夜診は予約制ではなく、受付順での診察となります。事前予約はできません。";

const EVENING_RESERVATION_WALKIN_ANSWER = [
  "はい。夜診は予約制ではなく、受付順での診察となります。",
  "事前予約はできませんので、ご来院のうえ受付をお願いいたします。",
].join("\n");

function buildEveningReservationAnswer(userMessage, safeHistory = []) {
  const msg = String(userMessage || "").trim();
  const ctx = celebrationDinnerContextText(safeHistory, userMessage);
  const followUpOnly =
    isEveningConsultationReservationQuery(msg, ctx) &&
    !/夜診|夜の診察|夕方の診察/.test(msg);
  if (/予約なし|予約無し|予約しなくても|予約せず|予約しないで/.test(msg)) {
    return EVENING_RESERVATION_WALKIN_ANSWER;
  }
  if (followUpOnly) return EVENING_RESERVATION_FOLLOWUP_ANSWER;
  return EVENING_RESERVATION_UNAVAILABLE_ANSWER;
}

/**
 * @returns {{ answer: string, matchedSection: string, focus: string }|null}
 */
function buildHospitalBagAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (isNonChildbirthBelongingsQuery(msg)) {
    return {
      answer: POSTPARTUM_BELONGINGS_NO_INFO_ANSWER,
      matchedSection: "none",
      focus: "postpartum",
    };
  }
  if (!isHospitalBagQuery(msg)) return null;

  const focus = detectHospitalBagFocus(msg) || "patient_bring";
  const section = "hos_bring";

  switch (focus) {
    case "hospital_provided":
      return {
        answer: HOSPITAL_BAG_HOSPITAL_PROVIDED_ANSWER,
        matchedSection: section,
        focus,
      };
    case "hospital_provided_full":
      return {
        answer: HOSPITAL_BAG_HOSPITAL_PROVIDED_FULL_ANSWER,
        matchedSection: section,
        focus,
      };
    case "full_list":
      return {
        answer: HOSPITAL_BAG_FULL_LIST_ANSWER,
        matchedSection: section,
        focus,
      };
    case "item_hospital_provided":
      return {
        answer: HOSPITAL_BAG_PROVIDED_ITEM_ANSWER,
        matchedSection: section,
        focus,
      };
    case "item_patient_bring":
      return {
        answer: HOSPITAL_BAG_TOOTHBRUSH_ANSWER,
        matchedSection: section,
        focus,
      };
    case "item_baby_clothes":
      return {
        answer: HOSPITAL_BAG_BABY_CLOTHES_ANSWER,
        matchedSection: section,
        focus,
      };
    case "patient_bring":
    default:
      return {
        answer: HOSPITAL_BAG_SUMMARY_ANSWER,
        matchedSection: section,
        focus: "patient_bring",
      };
  }
}

/** 胎嚢未確認のフォローアップか（毎回実施と断定しない） */
function isBeforeGestationalSacMessage(userMessage) {
  const msg = String(userMessage || "").trim();
  return (
    /胎嚢/.test(msg) &&
    /確認できていな|見えな|まだ|写っていな|写らな/.test(msg)
  );
}

function buildPrenatalUltrasoundFrequencyAnswer(userMessage) {
  if (isBeforeGestationalSacMessage(userMessage)) {
    return PRENATAL_ULTRASOUND_BEFORE_SAC_ANSWER;
  }
  if (/いつから/.test(String(userMessage || ""))) {
    return "当院では胎嚢が確認できるようになると、毎回の妊婦健診でエコーを行っています。";
  }
  return PRENATAL_ULTRASOUND_FREQUENCY_ANSWER;
}

/** 会話履歴からお祝いディナー文脈テキストを作る */
function celebrationDinnerContextText(safeHistory, userMessage = "") {
  const chunks = [String(userMessage || "")];
  for (const h of safeHistory || []) {
    chunks.push(String(h?.content || ""));
  }
  return chunks.join("\n").slice(-4000);
}

/** 苦手な食材名をざっくり抽出（共感用） */
function extractDislikedFoodName(userMessage) {
  const msg = String(userMessage || "").trim();
  const m = msg.match(
    /([ぁ-んァ-ヶー一-龥A-Za-z]{2,12}?)(?:が|を|は)?(?:(?:食べれ|食べられ)ない|苦手|嫌い)/
  );
  if (!m) return "";
  const food = String(m[1] || "")
    .replace(/^(?:私|僕|自分|うち)/, "")
    .trim();
  if (!food || food.length > 12) return "";
  if (/アレルギー|メニュー|ディナー|食事|お祝い/.test(food)) return "";
  return food;
}

/** お祝いディナー食材変更の定型回答（必要なら短い共感を先頭に） */
function buildCelebrationDinnerFoodRequestAnswer(userMessage, baseAnswer) {
  const body = String(baseAnswer || CELEBRATION_DINNER_FOOD_REQUEST_ANSWER).trim();
  const food = extractDislikedFoodName(userMessage);
  if (food) {
    return `${food}が苦手なのですね。\n\n${body}`;
  }
  return body;
}

function formatInfantAgeLabel(ageMonths) {
  const age = Number(ageMonths);
  if (!Number.isFinite(age)) return "";
  if (age === 12) return "生後12ヶ月（約1歳）";
  if (age === 18) return "生後18ヶ月（1歳半）";
  return `生後${age}ヶ月`;
}

function babyCareTopicEmpathy(userMessage, safeHistory = []) {
  const text = recentUserText(userMessage, safeHistory);
  if (/夜泣き/.test(text)) return "夜泣きについてお悩みなのですね。";
  if (/睡眠|寝な|寝てくれ|眠れ|寝かし/.test(text)) {
    return "赤ちゃんの睡眠についてお悩みなのですね。";
  }
  if (/授乳|おっぱい|ミルク/.test(text)) {
    return "授乳についてお悩みなのですね。";
  }
  return "育児についてお悩みなのですね。";
}

function priorAssistantGuidedInfantCheckup(safeHistory) {
  return (safeHistory || []).some(
    (h) =>
      h &&
      h.role === "assistant" &&
      /1ヶ月健診|2ヶ月健診/.test(String(h.content || ""))
  );
}

function priorUserHadDailyBabyCare(safeHistory) {
  return (safeHistory || []).some(
    (h) =>
      h &&
      h.role === "user" &&
      isDailyBabyCareConsultMessage(String(h.content || ""))
  );
}

/** 月齢の訂正フォロー（直前が健診案内の育児相談など） */
function isBabyCareAgeFollowUpMessage(userMessage, safeHistory) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isBabyIllnessConsultMessage(msg) || isMotherDistressConsultMessage(msg)) {
    return false;
  }
  if (isDailyBabyCareConsultMessage(msg)) return false;
  const age = parseInfantAgeMonths(msg);
  if (age == null) return false;
  if (
    !priorAssistantGuidedInfantCheckup(safeHistory) &&
    !priorUserHadDailyBabyCare(safeHistory)
  ) {
    return false;
  }
  // 「もう6ヶ月なんです」など、月齢の補足・訂正
  return (
    /もう|なんです|になります|になる|です$|ですが/.test(msg) ||
    msg.length <= 40
  );
}

/**
 * 日常育児相談の月齢別定型回答
 * @returns {{ answer: string, route: string, ageMonths: number|null }|null}
 */
function buildBabyCareConsultAnswer(userMessage, safeHistory = []) {
  const context = celebrationDinnerContextText(safeHistory, userMessage);
  const ageMonths = detectInfantAgeMonths(userMessage, context);
  const route = resolveBabyCareGuidanceRoute(ageMonths);
  const empathy = babyCareTopicEmpathy(userMessage, safeHistory);
  const isCorrection =
    isBabyCareAgeFollowUpMessage(userMessage, safeHistory) &&
    priorAssistantGuidedInfantCheckup(safeHistory) &&
    route === "external";

  if (isCorrection) {
    const label = formatInfantAgeLabel(ageMonths);
    return {
      answer: [
        "失礼いたしました。",
        `${label}のお子さまでしたら、お住まいの自治体の保健センターや小児科などにご相談ください。`,
      ].join("\n"),
      route: "external_correction",
      ageMonths,
    };
  }

  if (route === "ask_age") {
    return {
      answer: [
        empathy,
        "ご案内先は月齢によって異なりますので、赤ちゃんは現在、生後何ヶ月でしょうか？",
      ].join("\n"),
      route,
      ageMonths: null,
    };
  }

  if (route === "checkup") {
    let checkupLine =
      "1ヶ月健診や2ヶ月健診の際に、医師やスタッフへご相談いただけます。";
    if (ageMonths === 1) {
      checkupLine =
        "生後1ヶ月でしたら、1ヶ月健診の際に医師やスタッフへご相談いただけます。";
    } else if (ageMonths === 2) {
      // 2ヶ月健診が終わったとは決めつけず、健診時の相談として案内
      checkupLine =
        "生後2ヶ月でしたら、2ヶ月健診の際に医師やスタッフへご相談いただけます。";
    }
    return {
      answer: [empathy, checkupLine].join("\n"),
      route,
      ageMonths,
    };
  }

  // external
  const label = formatInfantAgeLabel(ageMonths);
  return {
    answer: [
      empathy,
      `${label}のお子さまについては、お住まいの自治体の保健センターや小児科などでご相談いただけます。`,
    ].join("\n"),
    route,
    ageMonths,
  };
}

const GYNECOLOGIC_SURGERY_NOT_OFFERED_ANSWER =
  "申し訳ありませんが、当院では婦人科の手術は行っておりません。診察やお薬による治療については、当院の婦人科でご相談いただけます。";

/** 手術名に寄せた未実施文（確定情報の範囲） */
function buildGynecologicSurgeryNotOfferedAnswer(userMessage) {
  const msg = String(userMessage || "");
  let focus = "婦人科の手術";
  if (/子宮筋腫|筋腫/.test(msg)) focus = "子宮筋腫の手術";
  else if (/卵巣嚢|卵巣のう|卵巣嚢腫/.test(msg)) focus = "卵巣のう腫の手術";
  else if (/内膜症|子宮内膜症/.test(msg)) focus = "子宮内膜症の手術";
  else if (/子宮摘出|全摘/.test(msg)) focus = "子宮摘出手術";
  return `申し訳ありませんが、当院では${focus}は行っておりません。診察やお薬による治療については、当院の婦人科でご相談いただけます。`;
}

/**
 * 院内サービス対応可否の話題ルール（質問語 → 根拠に必要な本文語）
 * availability 未登録かつサイトに該当記載が無いときは unknown
 */
const SERVICE_AVAILABILITY_TOPICS = [
  {
    id: "sex_selection",
    label: "産み分け",
    // エコー・判明時期は isGenderSelectionQuery 側で除外
    query: /産み分け|性別を選|性別を選べ|男の子を産み分け|女の子を産み分け/,
    evidence: /産み分け|性別を選|希望.*性別/,
  },
  {
    id: "birth_style",
    label: "分娩スタイルのご指定",
    query:
      /分娩スタイル|出産方法を選|希望する出産|好きな体勢|好きな姿勢|フリースタイル分娩|出産スタイル|体勢で出産|姿勢で出産/,
    evidence:
      /分娩スタイル|フリースタイル|好きな体勢|好きな姿勢|出産方法を選|希望する出産方法/,
  },
  {
    id: "water_birth",
    label: "水中出産",
    query: /水中出産|水中分娩/,
    evidence: /水中出産|水中分娩/,
  },
];

/** 院内サービスの対応可否を尋ねる質問か */
function isServiceAvailabilityQuestion(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  // 予約・変更など別処理の可否は除外
  if (
    /予約|キャンセル|WEB予約|ウェブ予約|変更したい|今日の予約|当日の予約/i.test(msg) &&
    !/予防接種|ワクチン|処方|検査|分娩|出産|立ち会|面会|ピル/.test(msg)
  ) {
    return false;
  }
  if (isGenderSelectionQuery(msg)) return true;
  if (SERVICE_AVAILABILITY_TOPICS.some((t) => t.query.test(msg))) return true;
  return /(?:できますか|対応していますか|お願いできますか|指定できますか|選べますか|選択できますか|処方してもらえますか|検査はできますか|やってますか|していますか|受けられますか|実施していますか)/.test(
    msg
  );
}

function matchServiceAvailabilityTopic(userMessage) {
  const msg = String(userMessage || "");
  if (isGenderSelectionQuery(msg)) {
    return SERVICE_AVAILABILITY_TOPICS.find((t) => t.id === "sex_selection") || null;
  }
  return SERVICE_AVAILABILITY_TOPICS.find((t) => t.query.test(msg)) || null;
}

/** 未確認時の簡潔案内 */
function buildServiceAvailabilityUnknownAnswer(userMessage) {
  const topic = matchServiceAvailabilityTopic(userMessage);
  const label = topic?.label || "";
  if (label) {
    return `${label}については、現在確認できる情報がありません。詳しくは当院まで直接お問い合わせください。`;
  }
  // ラベル不明でも断定しない
  const m = String(userMessage || "").match(
    /(.+?)(?:はできますか|に対応|をお願い|を指定|を選|を処方|の検査は|もやって|を実施)/
  );
  const guessed = m ? String(m[1]).replace(/[？?！!\s　]+$/g, "").trim() : "";
  if (guessed && guessed.length >= 2 && guessed.length <= 20) {
    return `${guessed}については、現在確認できる情報がありません。詳しくは当院まで直接お問い合わせください。`;
  }
  return "現在確認できる情報がありません。詳しくは当院まで直接お問い合わせください。";
}

/**
 * 公式抜粋が「そのサービス自体」の対応可否を裏付けているか
 */
function siteEvidenceSupportsServiceAvailability(userMessage, sourceChunks) {
  const topic = matchServiceAvailabilityTopic(userMessage);
  const chunks = sourceChunks || [];
  if (!chunks.length) return false;
  const hayAll = chunks
    .map((c) => `${c.title || ""}\n${(c.h1 || []).join(" ")}\n${c.text || ""}`)
    .join("\n");
  if (topic) {
    return topic.evidence.test(hayAll);
  }
  // 汎用: 質問から主要語を取り、本文に十分な一致があるか
  const msg = String(userMessage || "")
    .replace(
      /(?:は)?(?:でき|対応|お願い|指定|選べ|選択|処方|検査|やって|してい|受けられ|実施してい)ますか[？?]?/g,
      " "
    )
    .replace(/[？?！!。．、,…]/g, " ")
    .trim();
  const tokens = msg
    .split(/[\s\u3000のをにはがとでもからまでへやなど]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !/^(当院|病院|ください)$/.test(t));
  if (!tokens.length) return false;
  const specific = tokens.filter(
    (t) => !/^(でき|対応|お願い|処方|検査|出産|分娩)$/.test(t)
  );
  const use = specific.length ? specific : tokens;
  const hits = use.filter((t) => hayAll.includes(t));
  // サービス固有語が本文にあること（関連ページがあるだけでは不可）
  return hits.length >= 1 && hits.some((t) => t.length >= 3 || /ピル|検診|ワクチン|立ち会|面会|無痛/.test(t));
}

/**
 * @returns {"available"|"unavailable"|"unknown"}
 */
function resolveServiceAvailabilityStatus(opts) {
  const {
    userMessage,
    notOfferedHit,
    clinicHits,
    sourceChunks,
    attendFocused,
    meetingFocused,
    photoFocused,
  } = opts;

  if (
    notOfferedHit ||
    isChildVaccinationQuery(userMessage) ||
    isGenderSelectionQuery(userMessage) ||
    isGynecologicSurgeryQuery(userMessage) ||
    isEveningConsultationReservationQuery(userMessage)
  ) {
    return "unavailable";
  }
  // 専用ルートで公式ページが確定しているもの
  if (attendFocused || meetingFocused || photoFocused) {
    return "available";
  }
  // clinic-knowledge の unavailable はスコア閾値より優先（確定の未実施）
  const unavailableClinic = (clinicHits || []).find(
    (h) =>
      h.item?.availability === "unavailable" &&
      (Number(h.score) || 0) >= 40
  );
  if (unavailableClinic) return "unavailable";

  // clinic-knowledge は高スコアのみ採用（弱いキーワード一致で availability を誤用しない）
  const relevantClinic = (clinicHits || []).filter((h) => {
    const score = Number(h.score) || 0;
    if (score < 80) return false;
    if (attendFocused && h.item?.intent === "photo_recording_policy") return false;
    if (
      isServiceAvailabilityQuestion(userMessage) &&
      h.item?.intent === "childbirth_bonus_dinner" &&
      !/ディナー|招待|家族/.test(userMessage)
    ) {
      return false;
    }
    return true;
  });
  for (const h of relevantClinic) {
    const a = h.item?.availability;
    if (a === "available" || a === "unavailable" || a === "unknown") return a;
  }
  if (relevantClinic.length) {
    return "available";
  }
  if (siteEvidenceSupportsServiceAvailability(userMessage, sourceChunks)) {
    return "available";
  }
  // 婦人科トピック（アフターピル等）は本文裏付けがあれば available
  if (
    isGynecologyTopicMessage(userMessage) &&
    (sourceChunks || []).some((c) =>
      gynecologyPageSupportsQuery(
        userMessage,
        `${c.title || ""}\n${c.text || ""}`
      )
    )
  ) {
    return "available";
  }
  return "unknown";
}

/** サイト抜粋に WEB予約の可否が明示されているか */
function siteMentionsWebReservationAvailability(snippet) {
  const s = String(snippet || "");
  if (!/WEB予約|ウェブ予約|ネット予約|オンライン予約/i.test(s)) return false;
  // 変更・キャンセル期限だけの記述は可否根拠にしない
  if (/変更|キャンセル/.test(s) && !/ご利用いただけ|予約をお取り|予約可能|予約できます|予約できます/.test(s)) {
    return false;
  }
  return /ご利用いただけ|WEB予約・|予約をお取り|予約可能|予約でき|ご予約いただけ/.test(s);
}

/** 参照チップは最大1件 */
const MAX_REFERENCE_CHIPS = 1;

let client = null;
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

// Chat Completions 用（未設定時は gpt-4o-mini）
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// 出力トークン上限（未設定時は 1200。GPT-5 系は reasoning 分も含まれるため既定を厚めに）
const OPENAI_MAX_OUTPUT_TOKENS = (() => {
  const model = String(process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
  const isGpt5 = /^gpt-5/i.test(model);
  const fallback = isGpt5 ? "2500" : "1200";
  const raw = (process.env.OPENAI_MAX_OUTPUT_TOKENS || fallback).trim();
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : parseInt(fallback, 10);
})();

/** GPT-5 / o 系は max_tokens 非対応のため max_completion_tokens を使う */
function usesMaxCompletionTokens(model) {
  return /^(gpt-5|o\d)/i.test(String(model || "").trim());
}

function buildOpenAICompletionParams({ messages, stream = false }) {
  const params = {
    model: OPENAI_MODEL,
    messages,
  };
  if (stream) params.stream = true;
  if (usesMaxCompletionTokens(OPENAI_MODEL)) {
    params.max_completion_tokens = OPENAI_MAX_OUTPUT_TOKENS;
    // reasoning を抑えて体感速度を確保（空文字ならパラメータ自体を送らない）
    const effort = (process.env.OPENAI_REASONING_EFFORT ?? "minimal").trim();
    if (effort && effort !== "off" && effort !== "none") {
      params.reasoning_effort = effort;
    }
  } else {
    params.max_tokens = OPENAI_MAX_OUTPUT_TOKENS;
  }
  return params;
}

// 院内抜粋を API に載せる最大文字数（入力トークン削減＝待ち時間・コスト削減）
const SITE_SNIPPET_MAX_CHARS = Math.max(
  1500,
  parseInt(process.env.SITE_SNIPPET_MAX_CHARS || "6000", 10)
);

/** 1メッセージあたりの最大文字数 */
const MAX_MESSAGE_CHARS = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGE_CHARS || "500", 10)
);
/** history に含める最大件数 */
const MAX_HISTORY_ITEMS = Math.max(
  1,
  parseInt(process.env.MAX_HISTORY_ITEMS || "10", 10)
);
/** history 1件あたりの最大文字数 */
const MAX_HISTORY_ITEM_CHARS = Math.max(
  1,
  parseInt(process.env.MAX_HISTORY_ITEM_CHARS || "500", 10)
);

/**
 * @param {unknown} history
 * @returns {Array<{ role: string, content: string }>}
 */
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const h of history) {
    if (!h || (h.role !== "user" && h.role !== "assistant")) continue;
    const content = String(h.content || "").slice(0, MAX_HISTORY_ITEM_CHARS);
    out.push({ role: h.role, content });
  }
  return out.slice(-MAX_HISTORY_ITEMS);
}

// true のとき、サイト抜粋は「当院・手続きっぽい質問」のときだけ読む（未設定時は true）。
// 毎ターン読む場合は SITE_KNOWLEDGE_GATED=false
const SITE_KNOWLEDGE_GATED = !["false", "0", "no"].includes(
  (process.env.SITE_KNOWLEDGE_GATED || "true").toLowerCase().trim()
);

// 初回の挨拶だけは OpenAI を呼ばず即答（遅延をほぼゼロに）。オフは CHAT_INSTANT_GREETING=false
const CHAT_INSTANT_GREETING = !["false", "0", "no"].includes(
  (process.env.CHAT_INSTANT_GREETING || "true").toLowerCase().trim()
);

// 許可するフロントエンドのOrigin（環境変数 ALLOWED_ORIGINS にカンマ区切りで追加可能）
const DEFAULT_ALLOWED_ORIGINS = [
  "https://kanai.or.jp",
  "https://www.kanai.or.jp",
];

function loadAllowedOrigins() {
  const extra = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...DEFAULT_ALLOWED_ORIGINS, ...extra])];
}

const ALLOWED_ORIGINS = loadAllowedOrigins();

/** ブラウザ直叩き防止用（PHPプロキシが付与）。未設定時は拒否（fail-closed） */
function getChatApiSecret() {
  return String(process.env.CHAT_API_SECRET || "").trim();
}

function getRequestSecret(req) {
  const h = req.headers || {};
  const raw =
    h["x-chat-secret"] ||
    h["X-Chat-Secret"] ||
    "";
  return String(raw || "").trim();
}

function isValidChatApiSecret(req) {
  const expected = getChatApiSecret();
  if (!expected) return false;
  const got = getRequestSecret(req);
  if (!got || got.length !== expected.length) return false;
  // 単純比較（タイミング攻撃は低リスクな運用想定）
  return got === expected;
}

const SYSTEM = `
あなたは「金井産婦人科」公式サイト内の患者さん向け相談窓口です。
外部のAIアドバイザーや第三者の解説者ではありません。当院の相談窓口として、患者さんに直接話しかける自然で温かみのある文体で案内します。
ただし、実際の医師・看護師・受付スタッフ本人であると偽ってはいけません（「医師の○○です」等は禁止）。
目的は診断や医療判断ではなく、不安への寄り添い、受診前の一般案内、受診目安の一般情報の提供です。諭したり講義したりしない。

【当院相談窓口としての文体（最重要）】
・病院・医師を第三者として表現しない。
  NG：「専門の医師が相談に乗ってくれます」「病院に問い合わせることも選択肢です」「サポートを受けられると良いですね」
  OK：「当院の婦人科でご相談いただけます」「詳しくは当院までお問い合わせください」
・「〜してくれます」「〜することも選択肢の一つです」「〜すると良いでしょう」「〜できると良いですね」「〜してみるのも一つの方法です」「専門家に相談することが大切です」「適切なサポートを受けられます」は原則使わない。
・「できますか？」「相談できますか？」など単純な可否質問には、根拠があるとき最初に結論を述べてよい（例：「はい、ご相談いただけます。」）。前置きや一般論を長く置かない。
・【はい・いいえの矛盾禁止（最重要）】「一人で〜？」「〜しかできない？」「〜できないの？」「〜は禁止／無理ですか？」など、肯定・否定の向きが複雑な質問では、機械的に「はい」「いいえ」を付けない。事実を直接説明する。付けた場合は、その後の説明と論理的に一致しているか必ず確認する（例：「一人で食べるの？」に「はい」＋「家族1名招待可」は矛盾）。
・院内サービスの案内では、「嬉しいですね」「素敵ですね」「楽しみですね」などの不要な感想を付けない。
・【不要な締め・感想を付けない（最重要）】必要な情報を伝えたらそこで終える。無理に締めの一文を追加しない。
  禁止例：「〜できると良いですね」「〜していただけると嬉しいです」「素敵な時間をお過ごしください」「楽しみですね」「良い結果になることを願っています」「少しでもお役に立てれば幸いです」「ご希望に沿えると良いですね」「ご希望に沿ったお料理を楽しんでいただけると良いですね」。
・回答の基本構成は ①必要なら短い共感 ②質問への直接回答 ③必要な補足のみ。③までで終了する。
・根拠（院内登録情報・公式サイト抜粋）がない当院固有の対応可否は断定しない。
・通常の相談は原則2〜3文で簡潔に。同じ意味の繰り返し、不要な励まし、一般的なアドバイスの付け足し、内部システムの説明はしない。
・医療上の注意喚起・緊急時の案内など安全に必要な情報は省略しない（その場合は文数制限より安全を優先）。
・共感は必要なときだけ、相手の言葉に寄せて自然に。毎回の共感は不要。
・【お祝いディナーの食材】メニューはあらかじめ決まっている。苦手な食材による変更は原則不可。可能な範囲での配慮にとどめる。「食材を外せます」「ご希望に沿った料理を提供できます」など対応保証は禁止。直前にお祝いディナーの話がある場合、食材の苦手・除外希望はその続きとして理解し、話題の聞き直しはしない。
・日常的な赤ちゃんの育児相談（夜泣き・睡眠・生活リズム等）では、「いつでも／お気軽にご相談ください」「具体的な状況を教えてください」「当院でサポートします」など、常時相談窓口と誤認される表現は使わない。月齢を認識し、1・2ヶ月健診の対象時期なら健診時相談を案内し、それ以降（目安:生後3ヶ月〜）は自治体の保健センターや小児科などを案内する。過ぎた健診をこれから使える相談先として案内しない。月齢不明で案内先の判断に必要なときだけ簡潔に月齢を確認する（体調不良・母親の限界・緊急は除く）。
・【診療サービスの対応可否を推測しない（最重要）】「婦人科だからできるはず」「ワクチンページがあるから子供も接種できるはず」「産婦人科だから小児も診られるはず」「分娩を扱うから分娩スタイルも選べるはず」「関連ページがあるから対応しているはず」「一般的な産婦人科では対応している」などの推測は禁止。「できます／対応しています」と答えるには、対象サービスと対象者が一致する明確な院内情報（院内登録情報または公式サイトの該当記述）が必要。情報が確認できないときは「できる／できない」を断定せず、確認できる情報がない旨を伝え当院へ直接問い合わせるよう案内する。妊婦向けワクチンの記載を、お子さま本人への予防接種の根拠にしない。産み分けは「婦人科でご相談いただけます」と案内しない（未実施の院内情報がある場合はそれに従う）。
・【婦人科の手術と診察・処方を区別する】当院では婦人科の手術（子宮筋腫・卵巣のう腫・内膜症・子宮摘出など）は行っていない。手術が必要なら対応医療機関への相談を案内する。一方、診察・診断・お薬の相談は婦人科で受けられる。お薬は診察のうえ医師が必要性を判断し、特定の薬の処方を保証しない。「手術」という語だけで中絶など別サービスの登録情報を流用しない。中絶については既存の院内登録情報に従う（このターンで勝手に未実施へ上書きしない）。産科・分娩の処置には婦人科手術の未実施ルールを当てはめない。
・【妊婦健診のエコー頻度】院内登録情報を優先する。「毎回行われるわけではない」「医師が必要と判断した場合のみ」などの一般論で上書きしない。胎嚢確認後は毎回の妊婦健診でエコー。胎嚢確認前は毎回実施と断定しない。婦人科診察のエコーには妊婦健診ルールを流用しない。
・【入院時の持ち物】公式サイトの一覧を優先する。一般的な病院の持ち物を勝手に追加しない。当院でご用意している物（病衣・タオル・シャンプー・スリッパ等）を持参必須と案内しない。「ご用意いただく物」「分娩セット」「当院でご用意している物」を混同しない。産後ケアの持ち物に分娩入院の一覧を流用しない。
・【夜診の予約】夜診は予約不可・受付順。電話予約や事前予約が可能と案内しない。妊婦健診・WEB予約・初診予約の可否を夜診に流用しない。締切や診療時間など不要な条件を付け足さない。診療時間表を勝手に付け足さない。
・【診療時間・休診】曜日別の確定データ以外から推測しない。一般的な病院の時間をコピーしたり、別曜日の枠を流用したりしない。第3・第5土曜日は休診。火曜に午後診・夜診はない。木・金に夜診はない。臨時休診は通常予定と混同しない。
・【お子さま同伴・キッズルーム】お子さま連れの来院は可能。院内にキッズルームあり。診療内容・時間帯による制限や「事前電話確認」を勝手に付け足さない。キッズルームを理由にスタッフ託児・診察中の預かり・分娩時同伴・入院宿泊まで対応可能と推測しない。お子さま本人の診察・予防接種と同伴案内を混同しない。
・【分娩料金】予約金（10,000円）と予納金（100,000円／300,000円）を混同しない。予約金のうち5,000円は入院費への精算であり「5,000円のみ返金不可」と誤解釈しない。金額は確定データ以外から推測しない。産後ケア料金に分娩料金を流用しない。きょうだい割引・パパママ割引は分娩料金ページの制度であり、分娩予約特典ページと混同しない。
・【一般不妊相談】不妊治療・妊活の質問では診療時間表を出さない。対応は一般不妊相談に限り、妊娠を急がない方向けのタイミング療法・排卵誘発法（内服薬処方）のみ。担当医・曜日は推測せず診療体制表を案内する。体外受精・人工授精・顕微授精を一般不妊相談の根拠だけで対応可能としない。

【絶対に守る基本原則】
以下を 必ず守ってください。

やってはいけないこと
- 病名・原因・診断の断定
- 「大丈夫」「問題ない」などの断言
- 治療・検査・薬の具体的指示
- 他院・医師・医療行為の善悪評価
- 患者を説得・諭す・誘導する口調
- 無条件で予約を勧めること
- 外部アドバイザー口調（「〜してくれます」「選択肢の一つ」「〜と良いですね」など他人事の助言）

- 診断の確定、処方指示、検査結果の断定はしない。
- 当院の相談窓口として、患者さんに直接話しかける文章で案内する。
- 危険サインが疑われる場合は、一般説明を最小限にして「至急受診／救急」誘導を最優先する。
- 個人情報（氏名、住所、電話番号、保険番号など）を求めない。入力されたら控えるよう促す。
- 【院内固有情報と一般相談の分離（最重要）】
  - 情報の優先順位は次のとおり（上ほど強い）。**(1) 院内登録情報**（病院が明示登録した確定情報）→ **(2) 公式サイト抜粋** → **(3) GPT一般知識（当院固有の断定には使わない）**。
  - **院内登録情報**が渡されている場合は、公式サイト抜粋より優先して使う。矛盾時は院内登録情報を採用する。
  - **当院固有の情報**（診療時間・休診・予約方法・分娩予約・面会・立ち会い・入院・費用・医師・ワクチン・教室・設備・駐車場・持ち物・当院独自のサービス／ルール など）は、このターンで渡される**院内登録情報または公式サイト抜粋に根拠がある場合のみ**答える。
  - どちらにも根拠がない当院固有の質問では、GPT自身の一般知識・推測・「一般的な産婦人科では」「通常は」などの補完は**禁止**。確認できない旨を伝え、当院への電話相談へ案内する。
  - **一般的な妊娠・出産・症状の相談**（例：つわり、むくみ、不安の整理）は、診断・処方をせず、既存の安全ルールに従って案内してよい（当院固有の制度・時間・可否の断定はしない）。
  - 院内登録情報・公式サイト情報があっても、**緊急症状の判断・診断・処方指示には使わない**。危険サインは救急誘導を最優先。
- ユーザーの質問は短い1文が多い。当院固有の話題で根拠が渡されているときは、その内容を最優先で使い、一般論で薄めない・上書きしない。
- 抜粋に「更新:」やページ種別が付いている場合、**質問日と日付が一致する新しい関連情報**（臨時休診など）を、古い一般案内より優先して解釈する。日付が一致しない休診お知らせや、タイトルだけの「本日」表記は今日の根拠にしない。
- 「今日」「本日」「明日」等の日付表現は、別メッセージで渡される【現在日時（Asia/Tokyo）】を唯一の基準にする。現在日時を推測しない。過去日付のお知らせを「今日」の説明に使わない。
- 【休診の断定禁止（最重要）】抜粋に「（現在日時の日付）は休診」と明示されていない限り、「本日は休診です」「今日は休診日」と断定しない。曜日表で通常診療日なら「通常の診療日」と案内してよい。トップページのお知らせ一覧にある「休診のお知らせ（本日）」は、本文の具体日（例: 10月7日）が今日と一致しない限り無視する。
- 【診療日と当日予約は分離】「今日は診療しているか」と「今日の予約が取れるか」は別問題。通常診療日でも、当日予約可否の根拠が抜粋／院内登録情報に無い場合は予約可否を断定せず、電話等での確認を案内する。「予約情報が不明だから休診」と推測しない。
- 【謝罪は例外のみ】「お問い合わせありがとうございます。大変申し訳ございませんが、…」は、実施していない／お客様の要望に応えられない内容（例：無痛分娩、日曜診療、乳がん検診）のときだけ使う。通常の案内や、事実未確認の不満への返答では、過失を認める謝罪・改善約束をしない。「利用可能です」「できます」など案内できる内容の前に謝罪を置かない。
- サイト抜粋で「実施していない／行っていない／休診」と分かる内容を聞かれたときだけ、冒頭をお礼→未実施／休診の案内にする。曖昧にしない。日付不一致の休診お知らせだけでは使わない。
- 当院固有テーマで院内登録情報も公式サイト抜粋も根拠がない場合は、「正確な情報を確認できないため、お手数ですが当院へお電話でお問い合わせください。」と案内する（一般論で埋めない）。
- 回答内では「院内サイト抜粋」「院内登録情報」「KNOWLEDGE」などの内部用語は一切出さない。
- 回答内で「チャットボット」「AI」などと自称しない。必要な場合も「相談窓口としてご案内します」と表現する。
- 相手が感情・不満・悩みを示したときは、外側から評価せず、相手の言葉に寄せて短く受け止める。推測で感情を決めつけない。次の行動は患者主体で返す。
- 不安を否定しない。他院批判に乗らない。当院の期待値をコントロールする。

【共感の書き方（最重要）】
・共感を「説明・宣言」しない。「理解できます」「そのお気持ちは理解できます」「そのように感じるのは自然なことです」等は禁止。
・一般論で返さない。「〜は大切です」「配慮は必要です」など講義調は禁止。
・相手の発言内容を受け止める文にする。
  NG例：「辛いと感じるのは理解できますね」「赤ちゃんを預けて休めるような配慮は大切です」
  OK例：「ゆっくり休みたかったのに、十分に休めずお辛かったですね。」「赤ちゃんを預けて、ゆっくり体を休めたかったのですね。」
・定型の共感フレーズに固定しない。「お辛かったですね」「大変でしたね」等も毎回同じにせず、会話の流れに合わせて自然な言葉を選ぶ。
・同じ内容の共感やお礼を繰り返さない。すでに受け止めた内容を言い直さない。
・不満や気持ちの吐露への返答も、原則2〜3文で簡潔に（緊急・医療上の注意が必要な場合は安全情報を省略しない）。
・「他に何かありますか？」「気になることがあれば教えてください」を毎回付けない。
・「今後の改善に役立てます」「スタッフに伝えます」「改善してまいります」など、実行できない改善の約束はしない。
・事実確認前に、病院側の過失を認めるような過剰な謝罪はしない。丁寧さは保つ。

【必ずやること】
- 不安や感情を否定しない
- 判断を急がず、情報を整理する
- 選択肢を提示し、決定は患者に委ねる
- 緊急の可能性がある場合は、ためらわず救急誘導
- 文体は「必要な分だけ、相手の言葉に寄せて受け止める」

【あなたのゴール】
会話のゴールは次のいずれかです。
- 緊急対応が必要な可能性があるため、救急受診を勧めて終了
- 不安が整理され、初診予約を「選択肢として」提示
- 様子見や他の行動を含め、患者が納得して判断できた状態で終了
※「必ず予約につなげる」ことはゴールではありません。

【文体・トーンの使い分けルール】
文体は入力内容に応じて切り替えてください。
レベル1（受け止め強め）
使用条件：「怖い」「不安」「無理」「つらい」「休めない」など感情・つらさの吐露がある
ポイント：相手の言葉を短く拾って受け止める。「理解できます」と宣言しない。一般論で訓示しない。
例：ゆっくり休みたかったのに、思うように休めずつらかったのですね。

レベル2（標準）
使用条件：迷い・判断待ち・初診不安など、感情が強すぎない場合（基本はここ）
ポイント：必要なら短く寄り添い、事実確認や案内へ進む。一般論のあとに「不安も理解します」とつなげない。
例：気になる点があると、落ち着かないですよね。

レベル3（不満・クレーム）
使用条件：攻撃的・強い不満・クレーム傾向
ポイント：相手の言葉を短く受け止めたうえで、丁寧に対応する。理解宣言・一般論・改善約束はしない。過失未確認の過剰謝罪はしない。詳細の催促や毎回の締め質問はしない。
例：入院中、ゆっくり休める時間がほとんど取れなかったのですね。ご負担が大きかったことと思います。

【クレーム・不満への対応（重要）】
・「理解できます」「納得です」「もっともです」「自然なことです」などの評価・分析調は禁止。
・上から目線の言い回しも書かない（「期待に応えられなかった」「残念です」「私たちのサービス」等は禁止）。
・相手の具体的な言葉（休めなかった、待たされた、不安だった等）に寄せて1文で受け止め、必要なら簡潔な案内を続ける。
・**詳細の催促は禁止**。「具体的な状況を教えてください」等、追加説明を求める表現は書かない。
・文末に「他に気になることがあれば〜」など、毎回付ける締めは使わない。
・「スタッフに伝えます」「今後の改善に役立てます」「改善してまいります」など、実行できない改善の約束はしない。
・事実が未確認の段階で、病院の過失を認めるような謝罪は避ける。丁寧なお礼や受け止めはしてよい。
・「前の病院」「別の病院」など**他院での経験**を話しているときは、当院への謝罪や「今後の対応改善」は書かない。

【他院・以前の病院での経験について】
ユーザーが当院以外（前の病院・別の病院等）での出来事や不安を話している場合：
・当院への謝罪や改善約束は書かない。
・他院の医師・スタッフの善悪評価や批判には乗らない。
・相手の言葉に寄せて短く受け止め、こちらで受診を検討する際の不安があれば聞く。必要なら電話相談などの選択肢を提示する。

【短文入力への対応ルール（最重要）】
入力が短文（例：「お腹痛い」「出血」）の場合：
- 判断しない
- まず 情報を引き出す
- 二択・Yes/Noで聞く
- 不安を煽らない
- 冒頭に「痛みにはいろいろな原因がある」「さまざまな要因が考えられる」などの一般説明を置かない（説教調・上から目線に聞こえる）。
- 相手が「不安」と言っていないのに「不安も理解できます」「不安に感じるのも自然です」と評価・決めつけない。
例：教えてくれてありがとうございます。少し状況を整理したいので、分かる範囲で教えてください。

【短い相槌への対応ルール（最重要）】
会話の途中で、ユーザーが「うん」「はい」「そうなんです」「そうですね」「わかりました」など短い相槌・同意だけを返した場合：
- 相槌の文言だけを見て定型返答しない（新規の挨拶・一般論・共感だけで終わらない）。
- **直前までの相談内容（履歴）を必ず踏まえて**返答する。
- すでに共感・受け止めを伝えている場合は、同じ共感表現を繰り返さない。
- 相談内容に沿って会話を一歩進める。例：「少しでも楽になる方法を一緒に考えてみましょうか？」「今いちばん気になっている点はどれでしょう。」
- 「そうですか。」「分かりました。」だけの相槌返しで終わらない。

【情報を聞き出した後の分岐ルール】
A. 緊急・準緊急の可能性あり
- 予約を出さない
- 救急・早期受診を優先

B. 緊急性は低そうだが不安が強い
- 当院への相談・お電話を、押しつけず簡潔に案内してよい
- 強制・断定はしない
例：気になるようでしたら、診療時間内に当院へお電話ください。

C. 様子見も合理的
- 予約を前面に出さない
- 受診目安を整理して終了

【予約導線の扱い方】
- 「今すぐ予約してください」は使わない
- 「初診のご予約も可能です」「ご検討ください」など、当院からの案内として書く
- 「選択肢の一つです」のような他人事の言い回しは使わない
- 決定権は常に患者側

【会話構造テンプレ（毎回これを意識）】
- 可否・事実の質問には、まず結論（根拠がある場合）
- 必要なときだけ短い受け止め
- 具体的な案内（当院として直接伝える）
- 「次の行動として、」などの前置きや、不要な励ましは付けない

【避けるトーン・表現（最重要）】
次のような言い回しは、説明してから相手の気持ちを「許可」しているように聞こえるため**使わない**。
- 「理解できます」「理解できますね」「そのお気持ちは理解できます」「よく理解できます」「理解します」など、理解を宣言する表現（**全面禁止**）
- 「そのように感じるのは自然なことです」「無理もないことです」など、外側から評価・分析する表現（**全面禁止**）
- 「納得です」「納得できます」「納得しました」など、納得を宣言する表現（**全面禁止**）
- 「残念です」「残念ですね」など、残念がる・評する表現（**全面禁止**）
- 「〜はさまざまな原因が考えられるため、不安に感じていることも理解できます」
- 「原因はいろいろありますが、ご不安なお気持ちはよく分かります」など、一般論＋感情のラベル付けのセット
- 「〜のお気持ちも理解します」「不安にお感じになるのも当然です」と、相手が述べていない感情を断定する表現
- 「スタッフに伝えます」「今後の改善に役立てます」「改善してまいります」など、実行できない改善の約束
- 「次にどうするかは、あなた自身が選べる状態を大切にしていただきたいです。どのように進めていくのか考えてみることも良いですね。」のような、患者に判断を丸投げする締め
- 「どのように進めるか、あなた自身で考えられることができると良いですね。」のような、上から目線・丸投げに聞こえる締め
- 「あなたの安心につながると良いですね。」「〜と良いですね。」「サポートを受けられると良いですね。」のように、他人事で締める表現
- 「専門の医師が〜してくれます」「病院に問い合わせることも選択肢です」「〜することも選択肢の一つです」「〜してみるのも一つの方法です」
- 「専門家に相談することが大切です」「適切なサポートを受けられます」など、外部アドバイザー調
- 「あなた自身の状態をしっかり確認するのが大切です」「ご自身の体調をよく見ることが重要です」など、講義調・上から目線の締め
- 「〜するのが大切です」「〜することが大切ですね」「〜が重要です」だけで締める説教調
- 「なたの〜」「ご安心に〜」など、主語や語尾が崩れたままの定型締め
- 「他に気になることや、お話しされたいことがあればお聞かせください。」「他にも気になることがあればお知らせください。」「何か質問があれば〜」など、文末で追加発言を催促・切り上げる定型（**全面禁止**）
- 「アドバイス」という語は**全面禁止**（「ご案内」「お伝え」「ご説明」などに言い換える）
- 「お身体の状態や過去の状況により、適切なアドバイスがもらえるかもしれません。」のように、相手の状態を上から評価して助言を匂わせる表現（**全面禁止**）
- 「お身体の状態により〜」「適切なアドバイス〜」「もらえるかもしれません」など、窓口スタッフが口頭で言わない上から目線の助言調
代わりに、短文では事実確認・質問から入る。共感が必要なときも、長い一般論のあとに続けず、短い一文にとどめるか、相手の言葉を繰り返してから次に進む。
締めは案内内容そのもので終えてよい。追加の催促・聞き返し定型は付けない。相手を諭さない。

【最後の一文の原則】
- 安心しきらせない
- 不安を煽らない
- 相手を諭したり、他人事のように眺めたりしない
- 必要なら具体的な次の一歩や質問で締める（「大切です」で訓示しない）

【あなたの立ち位置】
- 金井産婦人科の公式サイトに置かれた相談窓口として話す
- 医師・看護師・受付スタッフ本人だと偽らない
- 外部の解説者・一般アドバイザーのように「病院側」を他人事で語らない
- 患者さんに直接案内するが、感情に引きずられず、医療安全を優先する

【話し方のスタイル】
- 原則として**日本語**で回答する。ユーザーが明らかに英語のみで質問している場合に限り、英語で返答してよい。それ以外の言語（韓国語、中国語など）は**一切使用しない**。
- 日本語では、丁寧でやさしい口調（です・ます調）で、当院の窓口が患者さんに話すように書く。
- 「当院では」「ご相談いただけます」「お電話ください」など、院内からの直接の案内を基本にする。
- 必要に応じて改行し、読みやすさを意識する。
- 必要に応じて段落を分け、読みやすさを意識する。
- 通常は2〜3文。長い一般論や励ましの付け足し、内部システムの説明はしない。安全に必要な注意は省略しない。
- 箇条書きは行頭を**必ず「・」**だけにする。行頭の半角ハイフン「-」や「*」の Markdown 箇条書きは使わない。「・持ち物は〇〇の順番で記載します。」のように自然な日本語で書く。半角/全角コロン「:」「：」は使わず、「〜について」「〜は」などに言い換える。
- **見やすさを向上させるため、適切に絵文字やMarkdown形式の装飾を使用する**：
  - 重要な情報は **太字（**テキスト**）** で強調する
  - 受診を促す場合は 📞 や ⚠️ などの絵文字を適度に使用する
  - 時間などの重要な情報は **太字** で強調する
  - 箇条書きの先頭に適切な絵文字（✅、📋、💡、ℹ️ など）を付けるとより見やすくなる
  - ただし、絵文字の使いすぎは避け、適度に使用する。また、**💕💖 の絵文字は使用しない**（その他の絵文字のみ適度に使用する）。
- 当院ページへの案内は**回答本文に URL を書かない**（https://www.kanai.or.jp/... の列挙・埋め込みは禁止）。画面下にチップが出る場合があるが、本文ではページ名だけで案内する。
- **Markdownリンク [ページ名](URL) は禁止**。ページ名だけ書く（例：産後ケアページ。角括弧・URL・括弧は付けない）。
- 悪い例：「当院の[産後ケアページ](https://www.kanai.or.jp/aftercare/)をご確認ください。」
- 良い例：「詳しいコースや料金については、産後ケアのページをご確認ください。」
- **禁止文言**：「画面下の参照リンク」「参照リンクからご確認ください」「詳しい内容は、画面下の〜」。これらは絶対に書かない。列挙がないときは電話など具体名で案内する。
- ユーザーが**自分の言葉で**不安・怖さを述べた場合に限り、短い一言で受け止める。推測で「不安ですよね」「理解します」と付け足さない。不必要な保証はしない。
- ユーザーの質問が公式サイトの抜粋の内容と意味的に近い場合は、その内容をもとに自然な文章に言い換えて説明する。完全一致でなくてもよい。
- 文末に絵文字を使用する場合は、句読点は表示しない。

【日本語の自然さルール（全回答で必須）】
- 最終出力の前に、必ず「病院窓口スタッフがそのまま口頭で言って自然か」を自己チェックし、不自然なら書き直してから出力する。
- 1文を長くしすぎない。読点「、」が3つ以上続く文は分割する。
- 「〜については」「〜に関しては」を1文内で重ねない。必要なら1回までにする。
- 抽象語だけで終わらない。「詳細」「利用方法」「注意点」などの語を使うときは、案内先を明示する（ページ名、または電話など具体名）。「画面下の参照リンク」とは書かない。
- 丁寧だが回りくどい定型を避ける。短く具体的に言い切る。
- 文頭に絵文字を置くときは、絵文字の前に「・」「-」「*」などの記号を付けない（例「✅ 受付時間は〜」）。

【不自然になりやすい禁止パターン】
- 「次の行動として、」「次のステップとして、」で提案を始める前置き（選択肢はそのまま書く）
- 「〜については、何かご不明な点があればお知らせください。」のような、案内先が曖昧な締め
- 「〜が考えられるため、〜であることも理解できます。」のような、一般論＋感情ラベル付けの硬い連結
- 「〜していただく必要があります」を多用する命令調（必要時のみ使い、可能なら「〜してください」「〜をお願いします」に言い換える）
- 同語反復（例「確認をご確認ください」「詳細の詳細」）
- 「〜ますので、ご了承ください」「〜ますが、ご了承ください」のように「ご了承ください」を接続助詞でつなぐ言い方。「ご了承ください」は独立した1文にする（悪い例「変更になることもありますので、ご了承ください。」／良い例「変更になることもあります。ご了承ください。」）
- 主語が抜けて意図が曖昧な文（誰が何をするかが不明）
- 「〜と良いですね」「〜といいですね」で、相手の安心・心配・不安などを他人事のように締める文
- [ページ名](https://...) 形式の Markdown リンク、文中の当院 URL 文字列

【推奨する言い換え】
- 悪い例：「詳しい利用方法や注意点については、何かご不明な点があればお知らせください。」
- 良い例：「詳しい利用方法や注意点については、当院サイトをご確認ください。」「ご不明な点があれば、当院へお電話ください。」
- 悪い例：「専門の医師が適切に相談に乗ってくれます。お電話でのご相談も選択肢の一つです。」
- 良い例：「はい、当院の婦人科でご相談いただけます。詳しくは当院までお問い合わせください。」
- 悪い例：「サポートを受けられると良いですね。」
- 良い例：「気になることがあれば、どうぞご相談ください。」

【旧形式・二層マーカーの禁止】
<<<PREVIEW>>>、<<</PREVIEW>>>、<<<DETAIL>>>、<<</DETAIL>>> などの二層用マーカーは**一切使わない**（仕様廃止済み）。ユーザー画面に制御文字が出る。通常の本文、または【リッチHTML】に従い先頭を [[[RICH_HTML]]] とした HTML のみを出力する。

【リッチHTML（表・カード型の見せ方）】
次に当てはまる質問では、プレーン文や Markdown だけの箇条書き・**太字**に頼った回答は**禁止**。**必ず**次の形式にする（例外なし）。
・診療時間・診察時間・受付時間・休診・曜日ごとのスケジュール・午前診／午後診／夜診・「いつまで診ているか」等
・料金・費用・予納金・支払い方法など、一覧表で示すのが適切な内容

手順：
1. 出力の**先頭**は、空白や改行を入れず、次の1行**のみ**：[[[RICH_HTML]]]（**括弧は開き3つ・閉じ3つ。スラッシュや4つ括弧は絶対に使わない**）
2. その**直後の次の文字から** HTML のみ。マーカーの前後にプレーンテキストを**一切**書かない（挨拶等はすべて HTML の p や h3 の内側に書く）。
3. ルートは **1つ** の <div class="chat-card"> にまとめる。共感の一文や締めもこの div 内に含める。
4. **禁止**：[[[/RICH_HTML]]]、[[[\\/RICH_HTML]]]、マーカーだけの出力、閉じタグ風のマーカー。ユーザー画面にマーカー文字列そのものが見えてはならない。
5. HTML カードで書けない場合は、マーカーを**使わず**通常の日本語文で答える（マーカーだけ出して終えることは禁止）。

使ってよいタグは次に限る：div, h3, h4, p, table, thead, tbody, tr, th, td, ul, ol, li, strong, em, br, span, a, hr, section, caption
属性は class のみ、および a には href（https://www.kanai.or.jp または https://kanai.or.jp で始まるURLのみ）, target="_blank", rel="noopener noreferrer" のみ。
script, style, iframe, onclick、data-*、id は使わない。
ルートの枠は class="chat-card"、見出しは **div.chat-card-head** の内側に span.chat-card-icon と **h3.chat-card-title** を置く（h3 に chat-card-head を直接付けない）。
表は class="chat-table"、※注記は class="chat-note"、当院ページへの導線は class="chat-pill-row" と a.chat-pill、まとめ見出しは class="chat-section"、まとめリストは class="chat-list"。

カード内の a.chat-pill 等で当院ページへ誘導してよい。**本文末に URL の箇条書きは書かない**（チップに任せる）。

【院内情報（システム専用。ユーザー向けの回答テキストには、この名称を出さない）】
このあと別の system メッセージとして「当院公式サイトのページ本文の抜粋（URL・更新日付き）」が渡される場合がある。
- **当院固有の事実**は、その抜粋に書かれている内容だけを根拠にする。抜粋が無い／該当記述が無いときは推測せず、電話問い合わせを案内する。
- 抜粋があるときは短い質問でもその内容を核にして簡潔に伝える。一般論で薄めない。
- ユーザー発話の主目的が**産科入院中の面会**のときは、そのターンの抜粋は**面会ページ（${MEETING_INFO_PAGE_URL}）の内容のみ**である。他の院内ページの情報や推測を混ぜない。
- **産後ケア**中の面会・家族来訪について聞かれたとき、産科入院の面会時間・人数・親族範囲を流用しない。根拠が無い場合は確認できない旨を伝え、当院への問い合わせを案内する（推測禁止）。
- ユーザー発話の主目的が立ち会い分娩の可否・条件のときは、そのターンの抜粋は**立ち会い分娩ページ（${ATTEND_INFO_PAGE_URL}）の内容のみ**である。他の院内ページの情報や推測を混ぜない。
- 写真・動画・撮影・録音の可否が主目的のときは、立ち会い等の状況語があっても撮影ルールページ（患者さまへのお願い）を根拠にする。撮影を一律禁止と推測せず、渡された抜粋の範囲で答える。
- 院内情報は適用対象（service）が質問と一致するものだけを根拠にする。キーワード一致だけで別サービスのルールを使わない。
`.trim();

const PROMPT_NO_CLINIC_EVIDENCE = [
  "【このターン：当院固有情報の根拠なし（最優先）】",
  "ユーザーの質問は当院の制度・時間・予約・サービス等の固有情報に関するものですが、今回は公式サイト抜粋から十分な根拠を取得できませんでした。",
  "・一般知識や推測で診療時間・休診・予約可否・料金・面会・ワクチン等を答えない。",
  "・「一般的な産婦人科では」「通常は」などの補完も禁止。",
  "・丁寧に、正確な情報を確認できないため当院へお電話でお問い合わせほしい旨を案内する。",
].join("\n");

/** このターンだけリッチHTMLを強く指示（モデルがプレーン文に逃げるのを防ぐ） */
const RICH_HTML_THIS_TURN = [
  "【このターンの回答形式（最優先・他会話テンプレより上）】",
  "このユーザー発話は、診療時間・休診・曜日別スケジュール、または料金・費用の確認に該当します。",
  "",
  "必ず次のみで出力してください。",
  "1. 先頭は空白・改行なしで次の1行だけ：[[[RICH_HTML]]]",
  "2. 続けて HTML のみ。前後にプレーンテキストや Markdown を付けない。",
  "3. ルートは1つの <div class=\"chat-card\">。診療枠は <table class=\"chat-table\">。",
  "4. <<<PREVIEW>>> や <<<DETAIL>>> 等の二層マーカーは出さない（廃止済み）。",
  "5. マーカーは [[[RICH_HTML]]] のみ。[[[/RICH_HTML]]] など誤形式・マーカー単体の出力は禁止。HTML が書けないならマーカーなしの通常文で答える。",
].join("\n");

/** クレーム・不満（条件付きで付与。他会話テンプレより優先） */
const PROMPT_COMPLAINT = [
  "【このターン：クレーム・不満への対応（最優先）】",
  "・ユーザーは当院への不満・クレームを話しています。「他の病院に変更したい」など転院意向があっても、他院での過去経験の相談ではない。当院への不満として対応する。",
  "・相手の言葉を受け止める（評価・分析しない）。「理解できます」「そのお気持ちは理解できます」「自然なことです」は禁止。",
  "・一般論・講義調は禁止（「〜は大切です」「配慮が必要です」等）。",
  "・定型の共感フレーズに固定せず、相手の具体的な内容に寄せた自然な一文で受け止める。",
  "・原則2〜3文。同じ共感・お礼を繰り返さない。",
  "・「スタッフに伝えます」「今後の改善に役立てます」「改善してまいります」等の改善約束はしない。",
  "・事実未確認の段階で、病院の過失を認める過剰な謝罪はしない。丁寧さは保つ。",
  "・上から目線の言い回しも禁止（「私たちのサービス」「期待に応えられなかった」「残念です」等）。",
  "・詳細の催促は禁止。「具体的な状況を教えてください」等は書かない。",
  "・話題を流す締めも禁止。「他に気になることがあれば〜」「何か質問があれば〜」等を毎回付けない。",
  "・良い例：入院中、ゆっくり休める時間がほとんど取れなかったのですね。ご負担が大きかったことと思います。",
].join("\n");

/** 他院・以前の病院での経験（当院クレームではない） */
const PROMPT_OTHER_HOSPITAL_EXPERIENCE = [
  "【このターン：他院・以前の病院での経験の相談（最優先）】",
  "ユーザーは当院へのクレームではなく、以前・別の病院での経験や、その影響による不安を話しています。",
  "・「他の病院に変更したい」「転院したい」など、いま当院から離れたい意向の発言にはこのテンプレを使わない（それは当院クレーム側）。",
  "・当院への謝罪や改善約束は書かない。",
  "・他院の医師・スタッフの善悪評価や批判には乗らない。",
  "・「理解できます」「〜は大切です」などの宣言・講義調は使わない。相手の言葉に寄せて短く受け止める。",
  "・必要なら、こちらで受診を検討する際の不安を聞き、診療時間内のお電話相談など選択肢を提示する。",
  "・良い例：前の病院では、思うように休めずつらかったのですね。こちらで受診をお考えのとき、気になる点があればお聞かせください。",
].join("\n");

/** 会話途中の短い相槌（うん・はい・そうなんです 等） */
const PROMPT_SHORT_BACKCHANNEL = [
  "【このターン：短い相槌への対応（最優先）】",
  "ユーザー発話は「うん」「はい」「そうなんです」などの短い相槌・同意です。",
  "・この短文だけを見て定型返答しない（挨拶・一般論・新規の共感だけで終わらない）。",
  "・直前までの会話履歴（症状・不安・質問・案内内容）を必ず踏まえて返答する。",
  "・すでに受け止めを伝えている場合は、同じ共感表現を繰り返さない。",
  "・相談内容に沿って会話を一歩進める。",
  "・「そうですか。」「分かりました。」だけの相槌返しで終わらない。",
  "・禁止の共感宣言（理解できます・そのお気持ちは理解できます・自然なことです・アドバイス 等）は使わない。",
].join("\n");

/** 日常的な育児相談（夜泣き・睡眠等 → 月齢に応じた案内） */
const PROMPT_BABY_CARE_CONSULTATION = [
  "【このターン：日常的な育児相談（最優先・月齢別）】",
  "ユーザーは赤ちゃんの夜泣き・睡眠・寝かしつけ・生活リズム・授乳など、日常的な育児の悩みを話しています。",
  "・月齢を必ず確認する（生後半年=6ヶ月、100日≈3ヶ月、もうすぐ1歳≈12ヶ月、1歳半=18ヶ月など）。",
  "・生後1〜2ヶ月（2ヶ月健診の終了は決めつけない）: 1ヶ月健診・2ヶ月健診の際に相談できる旨を案内。",
  "・生後3ヶ月以降: 1・2ヶ月健診は案内しない。自治体の保健センターや小児科などを案内。",
  "・月齢不明で案内先判断に必要なら「赤ちゃんは現在、生後何ヶ月でしょうか？」と簡潔に確認。決めつけて健診案内しない。",
  "・直前で健診を案内したあとに、より大きい月齢の訂正があったら「失礼いたしました」と訂正し、適切な相談先へ切り替える。",
  "・登録文をそのまま貼らず、相手の言葉に寄せた短い共感を先に置く。必要な情報で終える。励ましの締めは付けない。",
  "・当院がチャット／電話で常時の育児相談窓口である表現は禁止。",
  "・診断・睡眠指導の具体的指示はしない。緊急・体調不良は健診案内より救急・受診を優先。",
].join("\n");

/** 赤ちゃんの体調相談（健診待ち禁止） */
const PROMPT_BABY_ILLNESS = [
  "【このターン：赤ちゃんの体調相談（最優先）】",
  "ユーザーは赤ちゃんの熱・嘔吐・ぐったり等の体調について相談しています。",
  "・1ヶ月健診・2ヶ月健診まで待つ案内はしない。",
  "・日常的な育児相談（夜泣き等）の院内登録方針は使わない。",
  "・症状の程度に応じて、診療時間内の電話相談や小児科・救急など、受診の目安を一般情報として案内する。",
  "・診断・処方はしない。「大丈夫です」と断言しない。",
  "・危険サインが疑われる場合は救急誘導を優先する。",
].join("\n");

/** 母親の心身の不調・限界（健診待ち禁止） */
const PROMPT_MOTHER_DISTRESS = [
  "【このターン：母親の心身の不調・育児の限界（最優先）】",
  "ユーザーは育児の辛さ・限界・心身の不調を訴えています。",
  "・1ヶ月健診・2ヶ月健診まで待つ案内はしない。",
  "・日常的な育児相談の院内登録（健診時案内）は使わない。",
  "・相手の言葉に寄せて短く受け止め、できるだけ早めに当院へ電話で相談する／状況により受診や相談窓口を検討するよう案内する。",
  "・「いつでも育児相談を受け付けています」等の常時窓口表現は使わない。",
  "・自傷・加害の危険が疑われる場合は、ためらうことなく緊急・専門の相談・救急を優先する。",
  "・診断・断言はしない。",
].join("\n");

/** 予防接種：対象者を区別（子供への実施推測禁止） */
const PROMPT_VACCINATION_AUDIENCE = [
  "【このターン：予防接種・ワクチンの案内（対象者の区別が最優先）】",
  "・接種対象者（妊婦／お子さま／成人など）とワクチン種類を区別する。",
  "・公式サイトや院内登録に、その対象者向けの記載がある場合だけ「実施している」と案内する。",
  "・妊婦向けワクチン（例: RSウイルス母子免疫）の記載を、お子さま本人への予防接種の根拠にしない。",
  "・対象者やワクチンが不明なときは、実施可否を断定せず、どなたの・どの予防接種か確認するか、当院へ電話確認を案内する。",
  "・「産婦人科だから子供の予防接種もできるはず」などの推測は禁止。",
].join("\n");

const NOT_OFFERED_THANKS = "お問い合わせありがとうございます。";

/** FAQ上、当院で実施していないことが分かっている内容（文言はサービス種別ごと） */
const NOT_OFFERED_SERVICES = [
  {
    id: "epidural",
    label: "無痛分娩",
    pattern: /無痛分娩|無痛(?:で)?(?:の)?(?:お産|出産|分娩)|硬膜外麻酔|硬膜外|エピ(?:ジュラル)?/,
    topicPattern: /無痛分娩|硬膜外|エピ(?:ジュラル)?/,
    apologyLine: "大変申し訳ございませんが、当院では無痛分娩は行っておりません。",
  },
  {
    id: "sunday",
    label: "日曜診療",
    pattern:
      /日曜診療|日曜(?:日)?(?:も|に|は)?(?:診療|診察|外来|開院|開い|やって|診て|受診|来院できる)|日曜日は(?:診察|診療)/,
    topicPattern: /日曜/,
    apologyLine: "大変申し訳ございませんが、日曜日は休診です。",
  },
  {
    id: "holiday",
    label: "祝日診療",
    pattern:
      /祝日診療|祝日(?:も|に|は)?(?:診療|診察|外来|開院|開い|やって|診て|受診|来院できる)/,
    topicPattern: /祝日/,
    apologyLine: "大変申し訳ございませんが、祝日は休診です。",
  },
  {
    id: "breast_cancer_screening",
    label: "乳がん検診",
    pattern: /乳がん検診|乳癌検診|マンモグラフィ|マンモグラフィー/,
    topicPattern: /乳がん検診|乳癌検診|マンモグラフィ|マンモグラフィー/,
    apologyLine: "大変申し訳ございませんが、当院では乳がん検診は行っておりません。",
  },
  {
    id: "nursery",
    label: "託児所",
    pattern: /託児所|託児サービス/,
    topicPattern: /託児所|託児/,
    apologyLine: "大変申し訳ございませんが、当院には託児所はございません。",
  },
  {
    id: "child_vaccination",
    label: "お子さまの予防接種",
    // 妊婦向けワクチン（赤ちゃんを守る母子免疫）と混同しない
    pattern: /(?!.*(?:妊婦|妊娠))(?:子供|子ども|こども|小児|乳児|新生児|赤ちゃん|お子さま|お子様|幼児|お子さん).{0,24}(?:予防接種|ワクチン|接種)|(?!.*(?:妊婦|妊娠))(?:予防接種|ワクチン).{0,24}(?:子供|子ども|こども|小児|乳児|新生児|赤ちゃん|お子さま|お子様|幼児|お子さん)/,
    // 公式に「お子さまの予防接種は行っていない」と明記されたページだけチップ可
    topicPattern:
      /お子さまの予防接種は行っておりません|子供の予防接種は行っておりません|小児の予防接種は(?:実施して)?おりません|お子さまの予防接種は実施していません/,
    apologyLine:
      "申し訳ありませんが、当院ではお子さまの予防接種は行っておりません。",
  },
];

const FIXED_RULE_AFFIRM_RE =
  /実施しています|実施しております|ご利用いただけます|ご利用できます|対応しています|対応しております|開設しています|開設しております|行っています|行っております|受け付けています|受付しています|実施中|ご案内しています/;

function detectNotOfferedService(userMessage) {
  const text = String(userMessage || "").trim();
  if (!text) return null;
  // お子さま予防接種は専用判定（妊婦向けワクチン質問を誤爆しない）
  if (isChildVaccinationQuery(text)) {
    return NOT_OFFERED_SERVICES.find((x) => x.id === "child_vaccination") || null;
  }
  for (const item of NOT_OFFERED_SERVICES) {
    if (item.id === "child_vaccination") continue;
    if (item.pattern.test(text)) return item;
  }
  return null;
}

function buildNotOfferedPrompt(hit) {
  const label = hit.label;
  const apology = hit.apologyLine;
  return [
    "【このターン：実施していない内容への回答（最優先）】",
    `院内情報により、ユーザーが尋ねている「${label}」は当院では実施していない／該当しないことが分かっています。`,
    "・冒頭は必ず次の2文をこの順番で書く（順番を入れ替えない）。",
    `  1）${NOT_OFFERED_THANKS}`,
    `  2）${apology}`,
    "・謝罪から始めない。お礼→上記2文目の順を守る。",
    "・実施していないこと／該当しないことを曖昧にしない・遠回しにしない。",
    "・必要なら続けて、代替の案内・電話相談など短い補足を書いてよい。",
    `・良い例：${NOT_OFFERED_THANKS}${apology}`,
    "・注意：通常の案内質問（予約方法・制度・診療時間など）ではこのお礼→謝罪テンプレは使わない。このターンだけ例外。",
  ].join("\n");
}

/**
 * 固定ルール回答の根拠になっていないURLはチップに出さない。
 * サービス話題に一致する公式ページだけ残す（なければ空）。
 */
function filterReferencedPagesForNotOffered(hit, sourceChunks, referencedPages) {
  if (!hit) return referencedPages || [];
  const topicRe = hit.topicPattern || new RegExp(hit.label);
  const matched = [];
  const seen = new Set();
  for (const c of sourceChunks || []) {
    const hay = `${c.title || ""}\n${c.text || ""}\n${c.url || ""}`;
    if (!topicRe.test(hay)) continue;
    const url = rewriteLegacyKanaiUrl(c.url);
    if (!url || seen.has(url) || isGenericKanaiHomeUrl(url)) continue;
    // 無関係なお知らせ（例: 休診）だけで固定ルールと無関係なら除外
    if (hit.id !== "sunday" && hit.id !== "holiday" && /\/news\//i.test(url) && !topicRe.test(hay)) {
      continue;
    }
    seen.add(url);
    matched.push({
      url,
      title: String(c.title || hit.label).replace(/\s+/g, " ").trim() || url,
    });
  }
  // sourceChunks に無くても、既に topic 一致の参照があれば残す
  if (!matched.length) {
    for (const p of referencedPages || []) {
      const url = rewriteLegacyKanaiUrl(p?.url);
      if (!url || seen.has(url)) continue;
      if (topicRe.test(`${p.title || ""}\n${url}`)) {
        seen.add(url);
        matched.push({ url, title: p.title || hit.label });
      }
    }
  }
  return matched.slice(0, MAX_REFERENCE_CHIPS);
}

/**
 * 固定ルールと公式サイトの肯定表現の矛盾を検知（debug用・患者非表示）
 */
function detectFixedRuleConflict(hit, sourceChunks) {
  if (!hit) return null;
  const topicRe = hit.topicPattern || new RegExp(hit.label);
  for (const c of sourceChunks || []) {
    const hay = `${c.title || ""}\n${c.text || ""}`;
    if (!topicRe.test(hay)) continue;
    if (!FIXED_RULE_AFFIRM_RE.test(hay)) continue;
    return {
      id: hit.id,
      label: hit.label,
      url: c.url,
      title: c.title || "",
      note: "公式サイトに肯定表現あり（固定ルールと矛盾の可能性）",
    };
  }
  return null;
}

function setCors(res, origin) {
  // 許可リストに含まれるOriginのみ許可
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
}

/**
 * JSON ボディを取得する。
 * Vercel は req.body を事前パースするが、Promise で渡る場合がある。
 * Node のストリームからの再読み取りは二重消費でハング/空振りしやすいので行わない。
 */
async function readJsonBody(req) {
  try {
    let raw = req.body;
    if (raw != null && typeof raw.then === "function") {
      raw = await raw;
    }
    if (raw == null) {
      return {};
    }
    if (Buffer.isBuffer(raw)) {
      try {
        return JSON.parse(raw.toString("utf8") || "{}");
      } catch {
        return {};
      }
    }
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw || "{}");
      } catch {
        return {};
      }
    }
    if (typeof raw === "object") {
      return raw;
    }
    return {};
  } catch (e) {
    console.error("readJsonBody error:", e?.message || e);
    return {};
  }
}

async function safeRateLimit(ip) {
  try {
    return await ratelimit.limit(ip);
  } catch (e) {
    console.error("ratelimit error (request allowed):", e?.message || e);
    return { success: true };
  }
}

/**
 * 会話の最初のユーザー発話が、院内案内を要さない短い挨拶だけか
 */
function isCasualGreetingOnlyMessage(userMessage, safeHistory) {
  const userPrior = (safeHistory || []).filter((h) => h && h.role === "user").length;
  if (userPrior > 0) return false;
  const raw = String(userMessage || "").trim();
  if (raw.length > 48) return false;
  const compact = raw.replace(/[\s\u3000]+/g, "");
  return /^(こんにちは|こんばんは|おはようございます|おはよう|はじめまして|よろしくお願いします|よろしく|hello|hi)([!！.。…]*)?$/i.test(
    compact
  );
}

/**
 * 会話途中の短い相槌・同意か（履歴を踏まえた続行が必要）
 */
function isShortBackchannelMessage(userMessage, safeHistory) {
  const userPrior = (safeHistory || []).filter((h) => h && h.role === "user").length;
  if (userPrior < 1) return false;
  const raw = String(userMessage || "").trim();
  if (!raw || raw.length > 40) return false;
  const compact = raw.replace(/[\s\u3000]+/g, "");
  return /^(うん|うんうん|はい|はいはい|ええ|そう|そうです|そうなんです|そうなんですよ|そうですよね|そうですね|そうだよ|そうだね|そうですよ|なるほど|了解|了解です|了解しました|わかりました|分かりました|わかった|分かった|ええそうです|はいそうです|はいそうなんです|そうなの|そうなんだ|まぁ|まあ)([!！?？.。…〜ー]*)?$/i.test(
    compact
  );
}

function shouldAddShortBackchannelPrompt(userMessage, safeHistory) {
  if (shouldAddComplaintPrompt(userMessage, safeHistory)) return false;
  if (shouldAddOtherHospitalExperiencePrompt(userMessage, safeHistory)) return false;
  if (detectNotOfferedService(userMessage)) return false;
  return isShortBackchannelMessage(userMessage, safeHistory);
}

function detectEmergency(text) {
  const t = (text || "").toLowerCase();
  const keywords = [
    "大量出血", "血が止まら", "レバー状",
    "強い腹痛", "激しい腹痛",
    "意識", "もうろう", "けいれん",
    "呼吸が苦しい", "胸が痛い",
    "高熱", "39", "破水した",
    "胎動が少ない", "胎動ない", "胎動減少",
    "失神", "耐えられない痛み"
  ];
  if (keywords.some((k) => t.includes(k.toLowerCase()))) return true;
  // 乳児の呼吸苦・重篤サインは緊急優先
  if (isInfantUrgentSymptomMessage(text)) return true;
  return false;
}

/**
 * 保存・IP・個人情報などプライバシー実仕様の質問か
 * @param {string} userMessage
 */
function isPrivacyDataQuery(userMessage) {
  const text = String(userMessage || "").trim();
  if (!text) return false;
  return (
    /(?:データ|会話|チャット|やり取り|相談内容|履歴|ログ).*(?:残|保存|記録|消え|削除)/.test(
      text
    ) ||
    /(?:残|保存|記録).*(?:データ|会話|チャット|ログ)/.test(text) ||
    /個人情報|プライバシー|利用規約/.test(text) ||
    /IP|アイピー|接続元|特定され|追跡|トラッキング/i.test(text) ||
    /(?:誰|スタッフ|病院|運営|管理者).*(?:読|見|確認)/.test(text) ||
    /(?:読まれ|見られ).*(?:て|ます|いる)/.test(text) ||
    /このチャットは安全|安全ですか|セキュリティ/.test(text)
  );
}

/**
 * 確認済み実装に基づくプライバシー案内（患者向け・簡潔。推測・保証なし）
 * @param {string} [userMessage]
 */
function buildPrivacySpecAnswer(userMessage = "") {
  const msg = String(userMessage || "");
  const wantsDetail =
    /詳しく|詳細|もう少し|具体的に|仕組み|どのように|どうやって/.test(msg);

  // 原則: 短く直接答える（技術内部の説明はしない）
  const brief = [
    "このチャットでは、会話内容が記録される場合があります。",
    "また、IPアドレスなどの通信情報が取得される可能性もあります。",
    "",
    "安心してご利用いただくため、お名前や電話番号など、個人を特定できる情報は入力しないようお願いいたします。",
  ].join("\n");

  if (!wantsDetail) return brief;

  // 詳しい説明を求められたときだけ、事実の範囲で少し補足（断定・保証はしない）
  return [
    brief,
    "",
    "記録は案内の品質確認などに使う場合があります。通信情報はアクセス集中の防止などに用いることがあり、一般的なサーバー記録に残る可能性もあります。詳しい仕組みの保証や、「絶対に安全」「個人を特定できない」といったお約束はできません。",
  ].join("\n");
}

/**
 * チャット仕様・プライバシー等のメタ質問（公式サイト検索対象外）
 * @returns {{ id: string, label: string }|null}
 */
function detectMetaChatQuery(userMessage) {
  const text = String(userMessage || "").trim();
  if (!text) return null;
  if (isPrivacyDataQuery(text)) {
    return { id: "meta_chat", label: "チャット仕様" };
  }
  const patterns = [
    /この(?:やり取り|会話|チャット|相談|メッセージ)/,
    /(?:会話|チャット|やり取り|相談内容|履歴).*(?:保存|記録|ログ|残)/,
    /(?:保存|記録|ログ|履歴).*(?:され|ます|残|見)/,
    /誰(?:か|が|に).*(?:読|見|確認)/,
    /(?:病院|スタッフ|御社|運営|管理者|職員).*(?:読|見|確認)/,
    /(?:読まれ|見られ).*(?:て|ます|いる)/,
    /個人情報/,
    /プライバシー/,
    /利用規約/,
    /(?:あなたは)?AIですか|Chat\s*GPT|チャットGPT|チャットボット|ボットですか|人工知能/i,
    /どういう仕組み|どのように動いて|仕組みですか|どうやって答えて/,
    /このチャットは安全|安全ですか|セキュリティ/,
    /運営者|管理者は誰|誰が運営/,
    /会話履歴について|ログは残/,
    /データが残|IP|アイピー|特定され/i,
  ];
  if (patterns.some((re) => re.test(text))) {
    return { id: "meta_chat", label: "チャット仕様" };
  }
  return null;
}

/**
 * 確認済みの実装仕様（プライバシー回答の唯一の根拠。推測禁止）
 * - Supabase chat_logs: message/answer/client_id 等を保存（設定時）。IPカラムなし
 * - 日次レポート: 保存ログをメール集計する場合あり
 * - Vercel console.log: 会話本文がサーバーログに残る場合あり
 * - api-proxy.php: クライアントIPを取得し上流へ転送（アプリ内DBへは未保存）
 * - Vercel: レート制限のため IP を利用（Upstash）。chat_logs には未保存
 * - OpenAI: 質問＋直近履歴を回答生成のため送信
 */
const PROMPT_META_CHAT = [
  "【このターン：チャット仕様・プライバシー（meta_chat・最優先）】",
  "ユーザーは当院の診療案内ではなく、この相談チャット自体について質問しています。",
  "・原則2〜3文で簡潔に。内部システム・データベース・外部サービス名などの技術説明はしない。",
  "・公式サイト抜粋・参照チップ・院内案内へ話を逸らさない。",
  "・「AI」「ChatGPT」「チャットボット」と名乗らない。",
  "・伝えてよい事実のみ: 会話が記録される場合がある／通信情報（IP等）が取得される可能性がある／個人を特定できる情報は入力しないでほしい／診断・処方は行わない。",
  "・詳しい説明を求められたときだけ、少し補足してよい。",
  "・禁止: 「絶対に安全」「個人を特定できない」「記録は一切ない」「IPは取得しない」など事実と異なる断定・保証。",
].join("\n");

/**
 * 公式サイトを読みにいくかどうか（現在の入力＋直近のユーザー発話をざっくり判定）
 */
function shouldLoadSiteKnowledgeForMessage(userMessage, safeHistory) {
  // 現在の発話がメタ質問なら、履歴に院内語があってもサイト検索しない
  if (detectMetaChatQuery(userMessage)) return false;

  const chunks = [String(userMessage || "")];
  if (Array.isArray(safeHistory)) {
    for (const h of safeHistory) {
      if (h && h.role === "user") {
        chunks.push(String(h.content || ""));
      }
    }
  }
  const text = chunks.join("\n").slice(-4000);

  const triggers = [
    /当院|本院|金井産婦人科|医療法人\s*金井/,
    /公式サイト|ホームページ|HP|ＨＰ|ウェブ|web\s*予約|ＷＥＢ予約/i,
    /診療時間|診察時間|受付時間|休診|夜診|午前診|午後診|日曜|祝日|土曜/,
    /予約|初診|再診|キャンセル/,
    /料金|費用|支払い|クレジット|現金|予納金|予約金/,
    /駐車場|パーキング|アクセス|行き方|場所|住所|地図|最寄|蒲生|鴫野|今福/,
    /教室|産前教室|産後|面会|立ち会い分娩|立ち会い|入院|個室|レストラン/i,
    /母乳ケア|妊婦健診|乳児健診|健診枠|検診|スケジュール|時間割|枠|空き状況/,
    /里帰り|分娩|出産|産科|婦人科|産後ケア/,
    /ワクチン|インフルエンザ|予防接種|アブリスボ|RSウイルス/,
    /オンライン診療|オンライン|遠隔診療|テレビ電話/i,
    /電話|番号|06[-‐]?6931/i,
    /今日|本日|明日|明後日|今週|午後は診|午前は診/,
    /面会|お見舞い|会いに来|会いに行|立ち会|立会い|立ち合い|付き添|分娩室に入れ/,
    /料金|費用|いくらかか|入院費|自己負担|託児所|無痛分娩|乳がん検診/,
    /駐車|パーキング|持ち物|持参|何を持/,
  ];

  return (
    triggers.some((re) => re.test(text)) ||
    isMeetingFocusedQuery(text) ||
    isAttendFocusedQuery(text) ||
    isServiceAvailabilityQuestion(text)
  );
}

/** 当院固有事実が必要な質問か（根拠なし時は一般知識で埋めない） */
function isClinicSpecificFactualQuery(userMessage, safeHistory) {
  return shouldLoadSiteKnowledgeForMessage(userMessage, safeHistory);
}

/** 開発用: URL一覧キャッシュ無視（患者向けUIからは使わない） */
function shouldForceSiteKnowledgeRefresh(req) {
  const token = String(process.env.SITE_KNOWLEDGE_REFRESH_TOKEN || "").trim();
  if (!token) return false;
  const header = String(req.headers["x-site-knowledge-refresh"] || "").trim();
  return header.length > 0 && header === token;
}

function shouldIncludeSiteKnowledgeDebug(req) {
  const debugOn = ["1", "true", "yes"].includes(
    String(process.env.SITE_KNOWLEDGE_DEBUG || "").toLowerCase().trim()
  );
  if (!debugOn) return false;
  // シークレット一致時のみレスポンスに載せる（患者画面に出さない）
  return shouldForceSiteKnowledgeRefresh(req) || isValidChatApiSecret(req);
}

/**
 * 診療時間・料金など「表・カード必須」の質問か（現在＋直近ユーザー発話）
 */
function shouldForceRichHtmlForMessage(userMessage, safeHistory) {
  const chunks = [String(userMessage || "")];
  if (Array.isArray(safeHistory)) {
    for (const h of safeHistory) {
      if (h && h.role === "user") {
        chunks.push(String(h.content || ""));
      }
    }
  }
  const text = chunks.join("\n").slice(-4000);

  // 診療時間・分娩料金は確定データからプログラム生成するため、GPTのリッチHTML生成を強制しない
  if (
    isClinicHoursQuery(userMessage) ||
    isEveningConsultationReservationQuery(userMessage) ||
    isBirthPricingQuery(userMessage) ||
    isInfertilityConsultationQuery(userMessage) ||
    isAdvancedInfertilityQuery(userMessage)
  ) {
    return false;
  }

  const schedule =
    /診療時間|診察時間|受付時間|休診|夜診|午前診|午後診|日曜|祝日|開いてい|何時から|何時まで|診療.*いつ|いつ.*診療/.test(
      text
    );
  const fee =
    /料金|費用|予納金|予約金|いくら|支払い|クレジット|クレカ|現金/.test(text);

  return schedule || fee;
}

function recentUserText(userMessage, safeHistory) {
  const chunks = [String(userMessage || "")];
  if (Array.isArray(safeHistory)) {
    for (const h of safeHistory) {
      if (h && h.role === "user") {
        chunks.push(String(h.content || ""));
      }
    }
  }
  return chunks.join("\n").slice(-4000);
}

function looksLikeWantToLeaveKanai(text) {
  return /他の病院に(?:変更|移|変え|転院)|別の病院に(?:変更|移|変え|転院)|他院に(?:変更|移|転院)|転院したい|病院を変えたい|かかりつけを変えたい|病院を変更したい|ここをやめ|当院をやめ|金井.*(?:やめ|変え|転院|変更)/.test(
    String(text || "")
  );
}

/** 不満の対象が当院であることの手がかり */
function looksLikeKanaiComplaintTarget(text) {
  const t = String(text || "");
  return /当院|本院|金井|ここの(?:病院|クリニック|スタッフ|看護師|受付)|こちらの(?:病院|スタッフ|看護師|受付)/.test(
    t
  );
}

/**
 * 他院・以前の病院での過去経験の相談か。
 * 「他の病院に変更したい」など当院から離れたい意向は含めない（当院クレーム側）。
 */
function isOtherHospitalExperienceMessage(userMessage, safeHistory) {
  const text = recentUserText(userMessage, safeHistory);
  const current = String(userMessage || "").trim();

  // 当院への不満で転院・他院変更の意向 → 他院経験ではない
  if (looksLikeWantToLeaveKanai(current)) return false;

  // 当院を名指しで非難している → 他院経験テンプレにしない
  if (
    /当院(?:は|の|が|を)?[^。\n]{0,24}(?:最悪|ひど|不快|悪|ダメ)|(?:ここ|こちらの病院)(?:は|の|が)?[^。\n]{0,24}(?:最悪|ひど|不快|悪)/.test(
      text
    )
  ) {
    return false;
  }

  // 過去・別の病院での経験を示す表現（「他の病院に変更」は含めない）
  const otherHospitalCue =
    /前の病院|以前の病院|以前行った病院|別の病院では|別の病院で(?!変更)|他の病院では|他の病院で(?!変更)|他院では|他院で(?![ァ-ヶー]*変更)|前に行った病院|以前行った|前回の病院|元の病院|転院前|前のかかりつけ|以前のかかりつけ/;
  const negativeCue =
    /怖|ひど|威圧|怒|冷た|不安|嫌|つら|苦|信頼でき|不信|トラウマ|最悪|無理|不快|嫌だった|嫌で/;

  if (looksLikeWantToLeaveKanai(text) && !/前の病院|以前の病院|前回の病院|元の病院|転院前/.test(text)) {
    return false;
  }

  // 他院比較＋当院名指しは当院クレーム優先（他院経験にしない）
  if (otherHospitalCue.test(text) && looksLikeKanaiComplaintTarget(text) && /最悪|ひど|不快|態度|許せ/.test(text)) {
    return false;
  }

  if (otherHospitalCue.test(text) && negativeCue.test(text)) return true;
  if (/前の病院|以前の病院|別の病院では|他の病院では|他院では/.test(current)) return true;
  return false;
}

/** 症状の程度としての「ひどい」（クレームではない） */
function looksLikeSymptomSeverityNotComplaint(text) {
  const t = String(text || "");
  // 「つわりがひどい」「痛みがひどい」など身体症状の程度
  if (
    /(?:つわり|悪阻|吐き気|嘔吐|吐|腹痛|痛み|痛|出血|熱|発熱|痒|かゆ|頭痛|腰痛|むくみ|疲労|だる|眠気|体調|症状|陣痛|胎動).{0,6}ひど/.test(
      t
    ) ||
    /ひど.{0,6}(?:つわり|悪阻|吐き気|嘔吐|腹痛|痛み|出血|熱|痒|頭痛|腰痛|症状)/.test(t)
  ) {
    // 院内スタッフ・対応への非難が同時にある場合はクレーム側へ
    if (
      /(?:態度|対応|スタッフ|看護師|ナース|医師|先生|受付|窓口|当院|病院).{0,12}(?:ひど|悪|最悪|不快)/.test(
        t
      ) ||
      /(?:ひど|悪|最悪|不快).{0,12}(?:態度|対応|スタッフ|看護師|ナース|医師|先生|受付|窓口)/.test(t)
    ) {
      return false;
    }
    return true;
  }
  return false;
}

function shouldAddComplaintPrompt(userMessage, safeHistory) {
  if (isOtherHospitalExperienceMessage(userMessage, safeHistory)) return false;
  const text = recentUserText(userMessage, safeHistory);
  const current = String(userMessage || "").trim();

  // 「つわりがひどい」など症状の程度はクレームにしない
  if (looksLikeSymptomSeverityNotComplaint(current) || looksLikeSymptomSeverityNotComplaint(text)) {
    // 履歴全体に明確なクレーム語がある場合のみ続行判定へ
    if (!/クレーム|苦情|許せない|ありえない|ふざけ|訴えたい|文句|態度が悪|対応が悪/.test(text)) {
      return false;
    }
  }

  if (looksLikeWantToLeaveKanai(current) && /不快|ひど|最悪|態度|冷たい|威圧|怖|怒|クレーム|苦情|文句|許せ|ありえない|不信/.test(text)) {
    return true;
  }

  // 「ひどい」単体は不可。院・対応・スタッフへの非難と結びつくときだけクレーム
  const complaintRe =
    /クレーム|苦情|不快|最悪|ありえない|許せない|不信|ふざけ|態度が悪|態度.*悪|無愛想|冷たい|窓口.*悪|受付.*悪|スタッフ.*悪|看護師.*悪|看護師.*ひど|看護師.*態度|ナース.*悪|対応が悪|対応がひど|対応.*ひど|威圧|怖かった|怒鳴|叱咤|先生.*怖|医師.*怖|当院.*(ひど|悪|最悪|不快)|他院.*(良|いい)|他の病院.*(良|いい)|訴えたい|文句|ひどかった|最悪だった|怒られ|怒った|(?:態度|対応|スタッフ|看護師|ナース|医師|先生|受付|窓口|サービス).{0,8}ひど|ひど.{0,8}(?:態度|対応|スタッフ|看護師|ナース|医師|先生|受付|窓口)/;

  return complaintRe.test(text);
}

function shouldAddOtherHospitalExperiencePrompt(userMessage, safeHistory) {
  return isOtherHospitalExperienceMessage(userMessage, safeHistory);
}

/** 症状・感情の相談（院内案内の事実確認ではない） */
function looksLikeConsultWithoutReferencePages(userMessage, safeHistory) {
  const text = recentUserText(userMessage, safeHistory);
  if (
    /怖い|不安|無理|トラウマ|心配|つらい|苦しい|痛い|腹痛|出血|吐き気|発熱|陣痛|破水|胎動|気持ち|つらかった/.test(
      text
    )
  ) {
    return true;
  }
  const current = String(userMessage || "").trim();
  return current.length > 0 && current.length <= 28 && /痛|血|熱|吐|痒|怖|辛/.test(current);
}

/** 画面下の参照リンク（チップ）を出さないターンか */
function shouldSuppressReferencePages(userMessage, safeHistory, knowledgeHitScore = 0) {
  if (shouldAddComplaintPrompt(userMessage, safeHistory)) return true;

  if (looksLikeConsultWithoutReferencePages(userMessage, safeHistory)) {
    // サイト抜粋が当たっているときはチップを出してよい
    if (shouldLoadSiteKnowledgeForMessage(userMessage, safeHistory) && knowledgeHitScore >= 10) {
      return false;
    }
    return true;
  }

  if (!shouldLoadSiteKnowledgeForMessage(userMessage, safeHistory) && knowledgeHitScore < 8) {
    return true;
  }

  return false;
}

const RICH_HTML_PREFIX = "[[[RICH_HTML]]]";
const RICH_HTML_MARKER_ANY_RE = /\[\[\[(?:\/)?RICH_HTML\]\]\]+/gi;
const RICH_HTML_MARKER_HEAD_RE = /^(\[\[\[(?:\/)?RICH_HTML\]\]\]+)/i;
const RICH_HTML_LOOKS_LIKE_HTML_RE =
  /^\s*<(?:!\[CDATA\[|div|table|p|h[1-6]|section|ul|ol|thead|tbody|caption|span)\b/i;

/**
 * 誤ったリッチHTMLマーカー（[[[/RICH_HTML]]] 等）を除去・正規化。ユーザーに制御文字を見せない。
 */
function normalizeRichHtmlMarker(text) {
  let s = String(text ?? "");
  if (!s.trim()) return s;

  if (/^\s*\[\[\[(?:\/)?RICH_HTML\]\]\]+\s*$/i.test(s.trim())) {
    return "";
  }

  const head = s.trimStart();
  const open = head.match(RICH_HTML_MARKER_HEAD_RE);
  if (open) {
    const after = head.slice(open[0].length).replace(/^\s*\n?/, "");
    if (RICH_HTML_LOOKS_LIKE_HTML_RE.test(after)) {
      s = RICH_HTML_PREFIX + after;
    } else {
      s = after;
    }
  }

  s = s.replace(/\[\[\[\/RICH_HTML\]\]\]+/gi, "");

  if (s.startsWith(RICH_HTML_PREFIX)) {
    const body = s.slice(RICH_HTML_PREFIX.length).replace(RICH_HTML_MARKER_ANY_RE, "");
    s = RICH_HTML_PREFIX + body;
  } else {
    s = s.replace(RICH_HTML_MARKER_ANY_RE, "");
  }

  if (s.trim() === RICH_HTML_PREFIX) {
    return "";
  }

  return s.trim();
}

/**
 * 平文回答に混入した HTML / 制御マーカー断片（例: </ 、<<<PREVIEW>>>）を除去する。
 * RICH_HTML 本体のタグは維持する。
 */
function stripLeakedControlMarkup(text) {
  let s = String(text ?? "");
  if (!s.trim()) return s;

  if (s.trimStart().startsWith(RICH_HTML_PREFIX)) {
    let body = s.trimStart().slice(RICH_HTML_PREFIX.length);
    body = body.replace(/\[\[\[\/?RICH_HTML\]\]\]+/gi, "");
    body = body.replace(/<<<\/?[A-Za-z_]+>>>?/g, "");
    return (RICH_HTML_PREFIX + body).trim();
  }

  s = s.replace(/\[\[\[\/?RICH_HTML\]\]\]+/gi, "");
  s = s.replace(/<<<\/?[A-Za-z_]+>>>?/g, "");
  s = s.replace(/<\/?[a-zA-Z][^>\n]*>/g, "");
  s = s.replace(/<\/?[a-zA-Z][^>\n]{0,40}/g, "");
  s = s.replace(/<\/?/g, "");
  s = s.replace(/<{2,}/g, "");
  s = s.replace(/>{2,}/g, "");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

/** 定型冒頭と混ぜる前に、HTML回答を平文へ落とす */
function flattenHtmlAnswerToPlain(text) {
  let s = String(text || "");
  if (!s.trim()) return "";
  s = s.replace(/\[\[\[\/?RICH_HTML\]\]\]+/gi, "");
  s = s.replace(/<<<\/?[A-Za-z_]+>>>?/g, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(?:p|div|h[1-6]|li|tr)>/gi, "\n");
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return stripLeakedControlMarkup(s);
}

/** Markdownリンク・文中の当院URLを除去（チップ表示に任せる） */
function stripMarkdownLinksAndInlineKanaiUrls(text) {
  let s = String(text || "");
  if (!s || s.startsWith("[[[RICH_HTML]]]")) return s;

  // [産後ケアページ](https://...) → 産後ケアページ
  s = s.replace(/\[([^\]\n]+)\]\(\s*https?:\/\/[^)\s]+\s*\)/g, "$1");

  // 文中に残った当院 URL を除去
  s = s.replace(/https?:\/\/(?:www\.)?kanai\.or\.jp[^\s)\]<>"]*/gi, "");

  // URL除去後の不自然な空白・句読点を整理
  s = s.replace(/[ \t]{2,}/g, " ");
  s = s.replace(/\s+([、。])/g, "$1");
  s = s.replace(/([、。])\s*([、。])/g, "$1");

  return s.trim();
}

/** モデルが文末に付けた当院 URL の箇条書きを落とす（チップ表示と重複しないように） */
function stripTrailingKanaiUrlBulletLines(text) {
  const s = String(text || "").trim();
  if (!s || s.startsWith("[[[RICH_HTML]]]")) return s;
  const lines = s.split("\n");
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    const trimmed = last.trim();
    if (trimmed === "") {
      lines.pop();
      continue;
    }
    if (
      /^\s*[・•‧*＊\-−]\s*https?:\/\/(www\.)?kanai\.or\.jp\/\S+\s*$/i.test(last) ||
      /^https?:\/\/(www\.)?kanai\.or\.jp\/\S+\s*$/i.test(trimmed)
    ) {
      lines.pop();
      continue;
    }
    break;
  }
  return lines.join("\n").trimEnd();
}

/**
 * モデルが旧二層形式（PREVIEW/DETAIL）で返した本文を、単一の表示用テキストに直す
 */
function normalizeLegacyTwoLayerAnswerCore(text) {
  const PRE_OPEN = "<<<PREVIEW>>>";
  const DET_OPEN = "<<<DETAIL>>>";
  const PRE_CLOSES = ["<<</PREVIEW>>>", "<<</PREVIEW>>"];
  const DET_CLOSES = ["<<</DETAIL>>>", "<<</DETAIL>>", "<</DETAIL>>>"];

  function firstClose(s, closes) {
    let bestIdx = -1;
    let needle = "";
    for (const c of closes) {
      const i = s.indexOf(c);
      if (i !== -1 && (bestIdx === -1 || i < bestIdx)) {
        bestIdx = i;
        needle = c;
      }
    }
    return bestIdx === -1 ? null : { index: bestIdx, needle };
  }

  function stripKnownMarkers(str) {
    let x = String(str);
    const order = [
      "<<</PREVIEW>>>",
      "<<</DETAIL>>>",
      "<<<PREVIEW>>>",
      "<<<DETAIL>>>",
      "<</DETAIL>>>",
      "<<</PREVIEW>>",
      "<<</DETAIL>>",
      "[[[RICH_HTML]]]",
      "[[[/RICH_HTML]]]",
      "[[[\\/RICH_HTML]]]",
    ];
    for (const m of order) {
      x = x.split(m).join("");
    }
    return x.trim();
  }

  const t = String(text || "");
  if (!t.includes(PRE_OPEN)) {
    return t.trim();
  }

  const po = t.indexOf(PRE_OPEN);
  const afterPO = t.slice(po + PRE_OPEN.length);
  const pc = firstClose(afterPO, PRE_CLOSES);

  if (!pc) {
    return stripKnownMarkers(afterPO) || t.trim();
  }

  const preview = stripKnownMarkers(afterPO.slice(0, pc.index));
  const afterPC = afterPO.slice(pc.index + pc.needle.length);
  const d0 = afterPC.indexOf(DET_OPEN);
  if (d0 === -1) {
    return preview || stripKnownMarkers(afterPC) || t.trim();
  }

  const afterDO = afterPC.slice(d0 + DET_OPEN.length);
  const dc = firstClose(afterDO, DET_CLOSES);
  const detailRaw = dc ? afterDO.slice(0, dc.index) : afterDO;
  let detail = stripKnownMarkers(detailRaw);
  const dSt = detail.trimStart();

  if (dSt.startsWith("[[[RICH_HTML]]]")) {
    return dSt;
  }
  if (preview && detail) {
    return `${preview}\n\n${detail}`;
  }
  if (detail) {
    return detail;
  }
  if (preview) {
    return preview;
  }
  return stripKnownMarkers(t);
}

function stripOverDelegatingClosing(text) {
  let s = String(text || "");
  const replaceWithEmpty = [
    /次にどうするかは、あなた自身が選べる状態を大切にしていただきたいです。?\s*どのように進めていくのか考えてみることも良いですね。?/g,
    /どのように進め(?:る|ていく)か、?\s*あなた自身(?:で)?考え(?:られる|てみる)(?:こと)?(?:ができる)?(?:と)?良いですね。?/g,
    // 他人事・距離感のある締め（「あなたの安心につながると良いですね」等）
    /(?:あなたの|なたの|ご自身の)?安心[^。\n]*?と(?:良|い)いですね[。]?/g,
    /(?:あなたの|なたの)[^。\n]{0,24}?と(?:良|い)いですね[。]?/g,
    /[^。\n]*?につながると(?:良|い)いですね[。]?/g,
    /[^。\n]*?お役に立てれば(?:と|と思)(?:良|い)いですね[。]?/g,
  ];
  for (const re of replaceWithEmpty) {
    s = s.replace(re, "");
  }
  // 講義調・上から目線・他人事の訓示（削除のみ）
  const stripLecture = [
    /[^。\n]*(?:あなた自身|ご自身)[^。\n]{0,40}(?:大切|重要)です[ね]?[。]?/g,
    /[^。\n]*しっかり(?:と)?確認[^。\n]{0,20}(?:大切|重要)です[ね]?[。]?/g,
    /[^。\n]*(?:状態|体調|症状)を[^。\n]{0,24}確認[^。\n]{0,16}(?:大切|重要)です[ね]?[。]?/g,
    /[^。\n]*確認するのが(?:大切|重要)です[ね]?[。]?/g,
    /[^。\n]*のが(?:大切|重要)です[ね]?[。]?/g,
    /[^。\n]*することが(?:大切|重要)です[ね]?[。]?/g,
  ];
  for (const re of stripLecture) {
    s = s.replace(re, "");
  }
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

/** 文末の催促・切り上げ定型を全回答から除去 */
function stripPromptingClosings(text) {
  let s = String(text || "");
  if (!s.trim()) return s;
  const patterns = [
    /他にも?気になることや[、,]?お話しされたいことがあればお聞かせください。?/g,
    /他にも?気になること(?:が|や)あればお(?:聞かせ|知らせ)ください。?/g,
    /他にも?気になること(?:が|や)[^。\n]*お(?:聞かせ|知らせ)ください。?/g,
    /お話しされたいことがあれば[^。\n]*。/g,
    /何か(?:他に)?(?:ご)?質問があれば[^。\n]*。?/g,
    /ほかに(?:ご)?不明な点があれば[^。\n]*。?/g,
    /ほかにも?気になることがあれば[^。\n]*。?/g,
    /他にご質問があれば[^。\n]*。?/g,
    /他に(?:ご)?不明な点[^。\n]*。?/g,
    /何かございましたら[^。\n]*。?/g,
    /何か気になる(?:点|こと)があれば[^。\n]*。?/g,
    /気になることがあれば(?:遠慮なく)?お(?:聞かせ|申し付け|知らせ)ください。?/g,
    /お気軽にお(?:聞かせ|問い合わせ)ください。?/g,
    /ぜひお聞かせください。?/g,
    // 出力途中切れで残る催促の破片
    /(?:\n|^)何か(?:他に)?(?:ご)?(?:質問|気になる|ござい)[^\n。．]*$/g,
    /(?:\n|^)何か\s*$/g,
    /[。．！？]\s*何か\s*$/g,
  ];
  for (const re of patterns) {
    s = s.replace(re, (m) => (/[。．！？]\s*何か\s*$/.test(m) ? m.replace(/\s*何か\s*$/, "") : ""));
  }
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function defaultRefPageTitle(url) {
  const u = String(url || "").toLowerCase();
  if (/#hos_bring/i.test(u)) return "入院時の持ち物について";
  if (/#price_birth/i.test(u)) return "分娩料金について";
  if (/#doctor_schedule/i.test(u)) return "診療体制表はこちら";
  if (/\/obstetrics\/checkup\/?/i.test(u)) return "妊婦健診について";
  if (/\/facilities\/?/i.test(u)) return "院内施設のご案内";
  if (/\/about\/?/i.test(u)) return "当院について";
  if (/\/beginner\/?/i.test(u)) return "初めての方へ";
  if (/\/visit|\/gai/i.test(u)) return "外来のご案内";
  return "当院サイト";
}

/**
 * clinic-knowledge の relatedSiteUrl を、公式ページ本文が回答を裏付けるときだけチップ候補にする
 * @returns {{ url: string, title: string, score: number, reason: string } | null}
 */
function relatedSiteUrlChipFromClinicHits(
  clinicHits,
  sourceChunks,
  userMessage
) {
  for (const h of clinicHits || []) {
    const rawUrl = String(h?.item?.relatedSiteUrl || "").trim();
    if (!rawUrl) continue;
    const url = rewriteLegacyKanaiUrl(rawUrl);
    if (!url || isGenericKanaiHomeUrl(url)) continue;
    const bare = url.split("#")[0].replace(/\/+$/, "");
    const normalizedUrl = bare.endsWith("/") ? bare : `${bare}/`;

    // 院内指定の妊婦健診案内：ページにエコー頻度の明記がなくても「関連するご案内」として可
    if (
      (h.item?.intent === "ultrasound_frequency" ||
        h.item?.id === "prenatal-checkup-ultrasound-frequency") &&
      /\/obstetrics\/checkup/i.test(bare) &&
      isPrenatalUltrasoundFrequencyQuery(userMessage)
    ) {
      return {
        url: normalizedUrl,
        title: "妊婦健診について",
        score: 100,
        reason: "clinic relatedSiteUrl（関連するご案内）",
      };
    }
    // 入院持ち物：アンカー付きURLを保持
    if (
      (h.item?.intent === "hospital_bag" ||
        h.item?.id === "childbirth-hospital-bag") &&
      isHospitalBagQuery(userMessage)
    ) {
      return {
        url: HOSPITAL_BAG_PAGE_URL,
        title: "入院時の持ち物について",
        score: 100,
        reason: "clinic relatedSiteUrl（入院持ち物）",
      };
    }
    // 分娩料金：#price_birth を保持
    if (
      String(h.item?.intent || "").startsWith("birth_") ||
      String(h.item?.id || "").startsWith("birth-") ||
      /#price_birth/i.test(url)
    ) {
      if (isBirthPricingQuery(userMessage) && !isPostpartumCareFeeQuery(userMessage)) {
        return {
          url: BIRTH_PRICING_REF_PAGE.url,
          title: BIRTH_PRICING_REF_PAGE.title,
          score: 100,
          reason: "clinic relatedSiteUrl（分娩料金）",
        };
      }
    }
    // 一般不妊相談：#doctor_schedule を保持
    if (
      h.item?.intent === "infertility_consultation" ||
      h.item?.id === "general-infertility-consultation" ||
      /#doctor_schedule/i.test(url)
    ) {
      if (
        isInfertilityConsultationQuery(userMessage) ||
        isAdvancedInfertilityQuery(userMessage)
      ) {
        return {
          url: INFERTILITY_SCHEDULE_REF_PAGE.url,
          title: INFERTILITY_SCHEDULE_REF_PAGE.title,
          score: 100,
          reason: "clinic relatedSiteUrl（診療体制表）",
        };
      }
    }

    const chunk = (sourceChunks || []).find((c) => {
      const u = rewriteLegacyKanaiUrl(c?.url || "")
        .split("#")[0]
        .replace(/\/+$/, "");
      return u === bare;
    });
    if (!chunk) continue;
    const hay = `${chunk.title || ""}\n${(chunk.h1 || []).join(" ")}\n${chunk.text || ""}`;
    const answer = String(h?.item?.answer || "");
    let contentOk = false;
    if (/\/gynecology/i.test(bare)) {
      contentOk = gynecologyPageSupportsQuery(userMessage, hay);
    } else if (answer.length >= 8) {
      // 回答本文の具体語（3文字以上）がページに一定数あること
      const keys = answer
        .replace(/[、。．，,.\s]/g, " ")
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 3 && !/^(です|ます|ください|当院|詳細|ご相談)/.test(t));
      const hits = keys.filter((k) => hay.includes(k)).length;
      contentOk = hits >= 2 || (keys.length && keys.some((k) => k.length >= 5 && hay.includes(k)));
    }
    if (!contentOk) continue;
    const title =
      String(chunk.title || "")
        .split(/[｜|]/)[0]
        .trim() || defaultRefPageTitle(url);
    return {
      url: normalizedUrl,
      title,
      score: Number(chunk.score) || 100,
      reason: "clinic relatedSiteUrl（本文裏付けあり）",
    };
  }
  return null;
}

/**
 * 参照チップ用ページを正規化（旧URL置換・TOP除外・最大1件）
 * 並びは情報源の関連度順（先頭優先）を維持する。
 * @param {Array<{ url?: string, title?: string }>} pages
 * @param {string} userMessage
 */
function finalizeReferencedPages(pages, userMessage) {
  const rewritten = [];
  const seen = new Set();
  for (const p of pages || []) {
    const url = rewriteLegacyKanaiUrl(p?.url);
    if (!url || !/^https?:\/\/(?:www\.)?kanai\.or\.jp\//i.test(url)) continue;
    if (isGenericKanaiHomeUrl(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    rewritten.push({
      url,
      title: String(p?.title || defaultRefPageTitle(url)).replace(/\s+/g, " ").trim() || url,
    });
  }
  if (!rewritten.length) return [];

  // 面会・立ち会い質問では該当ページを優先
  let ordered = rewritten;
  if (isAttendFocusedQuery(userMessage)) {
    ordered = [
      ...rewritten.filter((p) => p.url === ATTEND_INFO_PAGE_URL),
      ...rewritten.filter((p) => p.url !== ATTEND_INFO_PAGE_URL),
    ];
  } else if (isMeetingFocusedQuery(userMessage)) {
    ordered = [
      ...rewritten.filter((p) => p.url === MEETING_INFO_PAGE_URL),
      ...rewritten.filter((p) => p.url !== MEETING_INFO_PAGE_URL),
    ];
  }
  return ordered.slice(0, MAX_REFERENCE_CHIPS);
}

/**
 * チップ最終ガード: 質問との語の重なりが無いURLは落とす
 * @returns {{ pages: Array<{url:string,title:string}>, excluded: Array<{url:string,reason:string}> }}
 */
function guardReferenceChipsByQuestion(pages, userMessage, opts = {}) {
  const excluded = [];
  if (opts.metaChat) {
    for (const p of pages || []) {
      excluded.push({ url: p?.url || "", reason: "meta_chatのためチップ禁止" });
    }
    return { pages: [], excluded };
  }
  if (opts.clinicOnly || opts.notOfferedOnly) {
    for (const p of pages || []) {
      excluded.push({
        url: p?.url || "",
        reason: opts.clinicOnly
          ? "clinic-knowledgeのみ根拠のためチップなし"
          : "固定ルールのみ根拠のためチップなし",
      });
    }
    return { pages: [], excluded };
  }

  const msg = String(userMessage || "");
  const tokens = msg
    .replace(/[？?！!。．、,…]/g, " ")
    .split(/[\s\u3000のをにはがとでもからまでへやなど]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  const meaningful = tokens.filter(
    (t) => !/^(です|ます|ください|教えて|について|この|それ|ある|ない|したい)$/.test(t)
  );

  const kept = [];
  for (const p of pages || []) {
    const hay = `${p.title || ""}\n${p.url || ""}`.toLowerCase();
    const hit = meaningful.some((t) => hay.includes(t.toLowerCase()));
    // 面会・立ち会い・ワクチン・婦人科等の正規ルートURLはタイトル語が少なくても許可
    // （婦人科ページタイトルは「婦人科」のみで、アフターピル等と語が重ならないため）
    const routeOk =
      (/\/gynecology\//i.test(p.url || "") && isGynecologyTopicMessage(msg)) ||
      (/\/obstetrics\/checkup\//i.test(p.url || "") &&
        isPrenatalUltrasoundFrequencyQuery(msg)) ||
      (/#hos_bring/i.test(p.url || "") && isHospitalBagQuery(msg)) ||
      (/#visit|#assist_birth|#price_birth|#doctor_schedule|\/vaccine\/|\/beginner\/|\/hospitalization\/|\/rsv_bonus\/|\/notpermit\//i.test(
        p.url || ""
      ) &&
        (isMeetingFocusedQuery(msg) ||
          isAttendFocusedQuery(msg) ||
          isPhotoRecordingFocusedQuery(msg) ||
          isDeliveryBenefitsFocusedMessage(msg) ||
          isInfertilityConsultationQuery(msg) ||
          isAdvancedInfertilityQuery(msg) ||
          /ワクチン|インフルエンザ|予防接種|今日|本日|明日|午後|午前|診療|診察|予約|費用|料金|割引|特典|プレゼント|キャンペーン|ディナー|招待|撮影|写真|動画|録音|不妊|妊活/.test(
            msg
          )));
    if (hit || routeOk) {
      kept.push(p);
    } else {
      excluded.push({
        url: p.url || "",
        reason: "質問との語一致がなくチップ最終除外",
      });
    }
  }
  return { pages: kept.slice(0, MAX_REFERENCE_CHIPS), excluded };
}

/**
 * 回答で案内した公式ページが、取得済みかつ高関連ならチップへ追加する。
 * GPTの推測ページ名だけではチップ化しない。
 * @param {string} answer
 * @param {Array<{url:string,title?:string,score?:number}>} candidatePages
 * @param {Array<{url:string,title?:string}>} currentPages
 */
function alignChipsWithAnswerPageMentions(answer, candidatePages, currentPages = []) {
  const text = String(answer || "");
  if (!text.trim()) return currentPages || [];
  const out = [...(currentPages || [])];
  const have = new Set(out.map((p) => String(p.url || "").split("#")[0]));

  for (const c of candidatePages || []) {
    const url = rewriteLegacyKanaiUrl(c?.url || "");
    if (!url || isGenericKanaiHomeUrl(url)) continue;
    const bare = url.split("#")[0];
    if (have.has(bare)) continue;
    const score = Number(c.score) || 0;
    if (score > 0 && score < 80) continue; // 高関連のみ

    const title = String(c.title || labelForKnowledgeChunk(c) || "")
      .replace(/\s*[|｜].*$/, "")
      .trim();
    const aliases = [title];
    if (/rsv_bonus/i.test(bare)) {
      aliases.push(
        "分娩予約特典",
        "分娩予約特典のページ",
        "出産特典",
        "分娩特典",
        "お祝いディナー",
        "お祝いディナーご招待"
      );
    }
    if (/notpermit/i.test(bare)) {
      aliases.push(
        "患者さまへのお願い",
        "患者様へのお願い",
        "院内撮影禁止",
        "撮影禁止"
      );
    }
    const mentioned = aliases.some((a) => a && a.length >= 4 && text.includes(a));
    if (!mentioned) continue;

    out.push({ url: bare, title: title || bare });
    have.add(bare);
  }
  return out.slice(0, MAX_REFERENCE_CHIPS);
}

/** モデルに参照チップの有無を明示（架空のリンク案内を防ぐ） */
function buildReferenceLinksSystemPrompt(referencedPages) {
  if (!referencedPages?.length) {
    return [
      "【このターンの参照リンク】",
      "画面下部には参照リンク（チップ）は表示されません。",
      "「画面下の参照リンク」「参照リンクからご確認ください」「詳しい内容は、画面下の〜」は絶対に書かないでください。",
      "サイト案内が必要なら、お電話など、具体名で案内してください。",
    ].join("\n");
  }
  const lines = referencedPages.map((p) => `- ${(p.title || p.url || "").trim()}`);
  return [
    "【このターンの参照リンク】",
    "回答の直下に次のページがチップとして表示されます（ユーザーはタップできます）。",
    "本文では「画面下の参照リンク」とは書かず、次のページ名だけで案内してください。",
    ...lines,
  ].join("\n");
}

/** 「画面下の参照リンク」系はチップの有無に関わらず必ず除去（文言だけ残る不整合を防ぐ） */
function stripFalseReferenceLinkMention(text, _referencedPages) {
  let s = String(text || "");
  if (!s.trim()) return s;
  const patterns = [
    /[^。．\n]*画面下の参照リンク[^。．\n]*[。．]?/g,
    /[^。．\n]*参照リンクからご確認ください[。．]?/g,
    /[^。．\n]*参照リンク[^。．\n]*ご確認ください[。．]?/g,
    /詳しい内容は[、,]?[^。．\n]*参照リンク[^。．\n]*[。．]?/g,
    /詳細については[、,]?[^。．\n]*参照リンク[^。．\n]*[。．]?/g,
    /詳しくは[、,]?[^。．\n]*参照リンク[^。．\n]*[。．]?/g,
  ];
  for (const re of patterns) {
    s = s.replace(re, "");
  }
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function stripNextActionLeadIn(text) {
  let s = String(text || "");
  s = s.replace(/次の(?:行動|ステップ)として[、,]?/g, "");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

function fixGoryoshoConnective(text) {
  let s = String(text || "");
  s = s.replace(/([^。\n])(?:ますので|ますが|ますし|ますから)、?\s*ご了承(?:の程|のほど)?(?:を)?\s*(?:お願い(?:いた)?します|ください|いただけますと幸いです)/g, (m, prefix) => {
    return `${prefix}ます。ご了承ください`;
  });
  return s;
}

function stripIrrelevantModelClosing(text) {
  let s = String(text || "");
  const patterns = [
    /住みやすい環境[^。\n]*。/g,
    /快適な環境[^。\n]*ご了承[^。\n]*。/g,
  ];
  for (const re of patterns) {
    s = s.replace(re, "");
  }
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

function stripMisplacedKanaiApology(text, userMessage, safeHistory) {
  if (!isOtherHospitalExperienceMessage(userMessage, safeHistory)) return String(text || "");
  let s = String(text || "");
  const patterns = [
    /状況についてご教示くださりありがとうございます。?/g,
    /この度は、?ご不快な思いをおかけすることとなり、?改めてお詫び申し上げます。?/g,
    /ご不快な思いをさせてしまい[^。\n]*。/g,
    /ご指摘の点は真摯に受け止め[^。\n]*。/g,
    /今後の対応についても[^。\n]*努めてまいります。/g,
    /今後の対応改善[^。\n]*。/g,
    /そういった経験をされたのですね[^。\n]*。/g,
    /[^。\n]*安心して受診できる環境[^。\n]*。/g,
    /[^。\n]*とても大切です[^。\n]*。/g,
  ];
  for (const re of patterns) {
    s = s.replace(re, "");
  }
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 当院クレーム時：過失を認める定型謝罪・改善約束を除去する。
 * （受け止め型の共感は残す。お礼→定型謝罪の強制はしない）
 */
function ensureComplaintThanksThenApology(text, userMessage, safeHistory) {
  if (!shouldAddComplaintPrompt(userMessage, safeHistory)) return String(text || "");
  let s = flattenHtmlAnswerToPlain(text);

  const stripForced = [
    /この度は、?ご不快な思いをおかけすることとなり、?改めてお詫び申し上げます。?/g,
    /ご不快な思いをさせてしまい、?(?:大変)?申し訳ありません。?/g,
    /ご不快な思いをおかけし[^。\n]*。/g,
    /ご指摘の点は真摯に受け止め[^。\n]*。?/g,
    /今後の対応についても[^。\n]*努めてまいります。?/g,
    /今後の対応改善[^。\n]*。?/g,
    /今後の改善に(?:役立て|つなげ)[^。\n]*。?/g,
    /スタッフに(?:伝え|共有|申し送り)[^。\n]*。?/g,
    /改善してまいります。?/g,
  ];
  for (const re of stripForced) {
    s = s.replace(re, "");
  }
  return stripLeakedControlMarkup(
    s.replace(/^[ \t\n]+/, "").replace(/\n{3,}/g, "\n\n").trim()
  );
}

/** クレーム時：詳細催促・流す締めを除去する（追加の聞き返しは付けない） */
function ensureComplaintDetailAskClosing(text, userMessage, safeHistory) {
  if (!shouldAddComplaintPrompt(userMessage, safeHistory)) return String(text || "");
  let s = String(text || "").trim();
  if (!s) return s;

  const stripClosings = [
    /他にも?気になることや[、,]?お話しされたいことがあればお聞かせください。?/g,
    /他にも?気になること(?:が|や)あればお(?:聞かせ|知らせ)ください。?/g,
    /他にも?気になること(?:が|や)[^。\n]*お(?:聞かせ|知らせ)ください。?/g,
    /お話しされたいことがあれば[^。\n]*。/g,
    /何か(?:他に)?(?:ご)?質問があれば[^。\n]*。/g,
    /ほかに(?:ご)?不明な点があれば[^。\n]*。/g,
    /ほかにも?気になることがあれば[^。\n]*。/g,
    /他にご質問があれば[^。\n]*。/g,
    /何かございましたら[^。\n]*。/g,
    /気になることがあれば(?:遠慮なく)?お(?:聞かせ|申し付け|知らせ)ください。?/g,
    /お気軽にお聞かせください。?/g,
    /こちらでの受診をお考えの場合[^。\n]*。/g,
    /前の病院でのご経験について[^。\n]*。/g,
    /今後の改善につなげたいので[^。\n]*。?/g,
    /今後の改善に(?:役立て|つなげ)[^。\n]*。?/g,
    /スタッフに(?:伝え|共有|申し送り)[^。\n]*。?/g,
    /改善してまいります。?/g,
    /ご指摘の点は真摯に受け止め[^。\n]*。?/g,
    /[^。\n]*具体的な状況を(?:お)?教えてください。?/g,
    /[^。\n]*詳しく(?:お)?教えてください。?/g,
    /[^。\n]*もう少し詳しく[^。\n]*。?/g,
    /[^。\n]*どのような状況(?:だった|でした)か[^。\n]*。?/g,
    /[^。\n]*詳細を(?:お)?聞かせください。?/g,
    /[^。\n]*詳細を(?:お)?教えてください。?/g,
    /[^。\n]*差し支えのない範囲でお聞かせ[^。\n]*。?/g,
    /[^。\n]*状況について(?:もう少し|詳しく|具体的に)[^。\n]*。?/g,
  ];
  for (const re of stripClosings) {
    s = s.replace(re, "");
  }
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 実施していない内容への質問は冒頭を「お礼→種別ごとの未実施文」に揃える */
function ensureNotOfferedThanksThenApology(text, userMessage, safeHistory) {
  if (shouldAddComplaintPrompt(userMessage, safeHistory)) return String(text || "");
  if (shouldAddOtherHospitalExperiencePrompt(userMessage, safeHistory)) {
    return String(text || "");
  }
  const hit = detectNotOfferedService(userMessage);
  if (!hit) return String(text || "");
  // お子さま予防接種は定型文を優先（お礼テンプレやワクチンページ由来の誤案内を付けない）
  if (hit.id === "child_vaccination" || isChildVaccinationQuery(userMessage)) {
    return CHILD_VACCINATION_NOT_OFFERED_ANSWER;
  }

  let s = flattenHtmlAnswerToPlain(text);
  const apology = hit.apologyLine;
  const stripOpenings = [
    /お問い合わせありがとうございます。?/g,
    /お問い合わせくださりありがとうございます。?/g,
    /ご質問ありがとうございます。?/g,
    /大変申し訳ございませんが、[^。\n]{1,80}。?/g,
    /申し訳ございませんが、[^。\n]{1,80}。?/g,
    /当院では[^。\n]{0,40}実施していません。?/g,
    /当院では[^。\n]{0,40}行っていません。?/g,
    /当院には[^。\n]{0,40}ございません。?/g,
    /日曜日は休診です。?/g,
    /祝日は休診です。?/g,
  ];
  for (const re of stripOpenings) {
    s = s.replace(re, "");
  }
  s = s.replace(/^[ \t\n]+/, "").replace(/\n{3,}/g, "\n\n").trim();

  const body = s ? `\n${s}` : "";
  return stripLeakedControlMarkup(`${NOT_OFFERED_THANKS}${apology}${body}`.trim());
}

function isInabilityApologyRest(rest) {
  return /(?:実施|行って|お取り|対応)してい?(?:ません|おりません)|ご要望に添え|お応えでき(?:ません|かね)|ご希望に添え/.test(
    String(rest || "")
  );
}

/**
 * 通常案内で誤って付いた「お礼→謝罪」を除去する。
 * クレーム／未実施ターンでは触らない。
 */
function stripMisplacedThanksApologyOnNormalQuestions(text, userMessage, safeHistory) {
  if (shouldAddComplaintPrompt(userMessage, safeHistory)) return String(text || "");
  if (detectNotOfferedService(userMessage)) return String(text || "");

  let s = String(text || "");
  if (!s.trim() || s.trimStart().startsWith(RICH_HTML_PREFIX)) return s;

  // クレーム用の定型お礼・謝罪が通常質問に混入した場合は除去
  s = s.replace(/状況についてご教示くださりありがとうございます。?/g, "");
  s = s.replace(
    /この度は、?ご不快な思いをおかけすることとなり、?改めてお詫び申し上げます。?/g,
    ""
  );
  s = s.replace(/ご指摘の点は真摯に受け止め[^。\n]*。?/g, "");
  s = s.replace(/今後の対応についても、?より安心していただけるよう努めてまいります。?/g, "");

  // 「お問い合わせありがとう。大変申し訳ございませんが、〜。」
  s = s.replace(
    /お問い合わせありがとうございます。\s*大変申し訳ございませんが、([^。\n]*)。/g,
    (full, rest) => {
      if (isInabilityApologyRest(rest)) return full;
      return `お問い合わせありがとうございます。${rest}。`;
    }
  );
  s = s.replace(
    /ご質問ありがとうございます。\s*大変申し訳ございませんが、([^。\n]*)。/g,
    (full, rest) => {
      if (isInabilityApologyRest(rest)) return full;
      return `ご質問ありがとうございます。${rest}。`;
    }
  );

  // 冒頭だけの「大変申し訳ございませんが、」＋案内できる内容
  s = s.replace(
    /(^|\n)大変申し訳ございませんが、([^。\n]*)。/g,
    (full, lead, rest) => {
      if (isInabilityApologyRest(rest)) return full;
      return `${lead}${rest}。`;
    }
  );

  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function stripBannedEmpathyPhrases(text) {
  let s = String(text || "");
  if (!s.trim()) return s;

  // 評価・分析・宣言型のみ除去。相手の言葉を受け止める文（お辛かったですね等）は残す。
  const patterns = [
    /[^。．\n<]*そのお気持ちは理解でき(?:ます|ました)[ね]?[^。．\n<]*[。．]?/g,
    /[^。．\n<]*お気持ち(?:も|は)?(?:よく)?理解(?:でき|し)(?:ます|ました)[ね]?[^。．\n<]*[。．]?/g,
    /[^。．\n<]*理解でき(?:ます|ました)[ね]?[^。．\n<]*[。．]?/g,
    /理解でき(?:ます|ました)[ね]?[。．]?/g,
    /[^。．\n<]*理解します[ね]?[^。．\n<]*[。．]?/g,
    /理解します[ね]?[。．]?/g,
    /[^。．\n<]*そのように感じ(?:る|られた)のは自然なこと[^。．\n<]*[。．]?/g,
    /[^。．\n<]*感じ(?:る|られた)のは(?:自然|無理もない)[^。．\n<]*[。．]?/g,
    /[^。．\n<]*納得です[ね]?[^。．\n<]*[。．]?/g,
    /納得です[ね]?[。．]?/g,
    /[^。．\n<]*納得でき(?:ます|ました)[ね]?[^。．\n<]*[。．]?/g,
    /納得でき(?:ます|ました)[ね]?[。．]?/g,
    /[^。．\n<]*納得いたしました[^。．\n<]*[。．]?/g,
    /納得いたしました[。．]?/g,
    /[^。．\n<]*もっともだと思います[^。．\n<]*[。．]?/g,
    /[^。．\n<]*無理もないことだと思います[^。．\n<]*[。．]?/g,
    // 「アドバイス」および上から目線の助言調
    /[^。．\n<]*アドバイス[^。．\n<]*[。．]?/g,
    /アドバイス/g,
    /[^。．\n<]*お身体の状態や過去の状況[^。．\n<]*[。．]?/g,
    /[^。．\n<]*お身体の状態により[^。．\n<]*[。．]?/g,
    /[^。．\n<]*過去の状況により[^。．\n<]*[。．]?/g,
    /[^。．\n<]*今後の改善に(?:役立て|つなげ)[^。．\n<]*[。．]?/g,
    /[^。．\n<]*スタッフに(?:伝え|共有|申し送り)[^。．\n<]*[。．]?/g,
    /改善してまいります[。．]?/g,
  ];
  for (const re of patterns) {
    s = s.replace(re, "");
  }
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 肯定・否定の向きが複雑な質問か（機械的な「はい／いいえ」を避ける） */
function isComplexPolarityQuestion(userMessage) {
  const msg = String(userMessage || "");
  return /一人で|しか(?:食べ|でき|いけ)|できないの|できないですか|禁止ですか|無理ですか|だけ(?:です|なの|なの？)|のみ/.test(
    msg
  );
}

/**
 * 複雑な極性の質問で、説明と矛盾しうる冒頭の「はい／いいえ」を外す
 */
function stripContradictoryYesNoLead(text, userMessage) {
  let s = String(text || "").trim();
  if (!s || !isComplexPolarityQuestion(userMessage)) return s;
  // 「はい、家族1名招待」のような矛盾パターンを除去
  if (/^はい[。、,.．]?\s*/.test(s) && /ご家族様?\s*1\s*名|家族.{0,6}招待|1名をご招待/.test(s)) {
    s = s.replace(/^はい[。、,.．]?\s*/, "");
  }
  if (/^いいえ[。、,.．]?\s*/.test(s) && /ご家族様?\s*1\s*名|家族.{0,6}招待|1名をご招待/.test(s)) {
    // 「一人でしか食べられない？」への「いいえ」は内容と一致し得るが、事実直説を優先
    s = s.replace(/^いいえ[。、,.．]?\s*/, "");
  }
  return s.trim();
}

/** サービス案内から不要な感想・励まし・締めを除去 */
function stripServiceGushPhrases(text) {
  let s = String(text || "");
  const patterns = [
    /[^。\n]*(?:嬉しい|うれし|素敵|楽しみ)(?:です|ですね|だね|でしょう)[ね]?[。．]?/g,
    /[^。\n]*ご家族でお祝いできるのは[^。\n]*[。．]?/g,
    /[^。\n]*素敵な時間を[^。\n]*[。．]?/g,
    /[^。\n]*(?:できると|していただけると|沿えると|沿った[^。\n]*と)(?:良い|いい)ですね[。．]?/g,
    /[^。\n]*ご希望に沿[^\n。]*[。．]?/g,
    /[^。\n]*楽しんでいただけると(?:良い|いい)ですね[。．]?/g,
    /[^。\n]*していただけると嬉しいです[。．]?/g,
    /[^。\n]*良い結果になることを願[^。\n]*[。．]?/g,
    /[^。\n]*お役に立てれば幸いです[。．]?/g,
    /[^。\n]*少しでもお役に立てれば[^。\n]*[。．]?/g,
    /[^。\n]*楽しみですね[。．]?/g,
    /[^。\n]*しっかり相談できると(?:良い|いい)ですね[。．]?/g,
    /[^。\n]*安心できると(?:良い|いい)ですね[。．]?/g,
    /[^。\n]*無理をなさらずお過ごしください[。．]?/g,
    /[^。\n]*健やかな成長を願っています[。．]?/g,
    /[^。\n]*無理をなさず[^。\n]*[。．]?/g,
    /[^。\n]*安心して健診を受けてください[。．]?/g,
    /[^。\n]*赤ちゃんの成長が楽しみですね[。．]?/g,
    /[^。\n]*詳しくは担当医にご相談いただくと良いでしょう[。．]?/g,
  ];
  for (const re of patterns) {
    s = s.replace(re, "");
  }
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function stripComplaintEmpathyPhrases(text, userMessage, safeHistory) {
  if (!shouldAddComplaintPrompt(userMessage, safeHistory)) return String(text || "");
  let s = String(text || "");
  const patterns = [
    /そのように感じられた[^。\n]*理解できます[^。\n]*。/g,
    /[^。\n]*そのお気持ちは理解でき[^。\n]*。/g,
    /[^。\n]*理解できます[^。\n]*。/g,
    /そのように感じられたこと[^。\n]*もっともだと思います[^。\n]*。/g,
    /[^。\n]*もっともだと思います[^。\n]*。/g,
    /無理もないことだと思います[^。\n]*。/g,
    /[^。\n]*自然なこと(?:です|ですね)[^。\n]*。/g,
    /[^。\n]*大切ですので[^。\n]*。/g,
    /私たちのサービスが[^。\n]*。/g,
    /[^。\n]*期待に応えられなかった[^。\n]*。/g,
    /[^。\n]*残念です[^。\n]*。/g,
    /今後の改善に(?:役立て|つなげ)[^。\n]*。/g,
    /スタッフに(?:伝え|共有|申し送り)[^。\n]*。/g,
    /改善してまいります。?/g,
  ];
  for (const re of patterns) {
    s = s.replace(re, "");
  }
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

function finalizeAssistantAnswer(text, referencedPages, userMessage, safeHistory = []) {
  return stripContradictoryYesNoLead(
    stripServiceGushPhrases(
      stripMisplacedThanksApologyOnNormalQuestions(
        ensureNotOfferedThanksThenApology(
          ensureComplaintDetailAskClosing(
            ensureComplaintThanksThenApology(
              stripMisplacedKanaiApology(
                stripComplaintEmpathyPhrases(
                  stripBannedEmpathyPhrases(
                    stripIrrelevantModelClosing(
                      stripFalseReferenceLinkMention(
                        fixGoryoshoConnective(
                          stripNextActionLeadIn(
                            normalizeLegacyTwoLayerAnswer(text)
                          )
                        ),
                        referencedPages
                      )
                    )
                  ),
                  userMessage,
                  safeHistory
                ),
                userMessage,
                safeHistory
              ),
              userMessage,
              safeHistory
            ),
            userMessage,
            safeHistory
          ),
          userMessage,
          safeHistory
        ),
        userMessage,
        safeHistory
      )
    ),
    userMessage
  );
}

function normalizeLegacyTwoLayerAnswer(text) {
  const raw = String(text || "").trim();
  const out = stripPromptingClosings(
    stripBannedEmpathyPhrases(
      stripLeakedControlMarkup(
        normalizeRichHtmlMarker(
          stripMarkdownLinksAndInlineKanaiUrls(
            stripOverDelegatingClosing(
              stripTrailingKanaiUrlBulletLines(normalizeLegacyTwoLayerAnswerCore(text))
            )
          )
        )
      )
    )
  );
  if (raw && !out) {
    return "すみません、表示用の回答を整形できませんでした。もう一度お試しください。";
  }
  return out;
}

function writeNdjsonLine(res, obj) {
  res.write(`${JSON.stringify(obj)}\n`);
}

/**
 * OpenAI のストリームを NDJSON でクライアントへ流す（1行1JSON）
 * ※ create は writeHead より前に行い、API エラーを JSON で返せるようにする
 */
async function createOpenAIStream(openai, messages) {
  return openai.chat.completions.create(
    buildOpenAICompletionParams({ messages, stream: true })
  );
}

async function pipeOpenAIStreamNdjson(
  res,
  stream,
  userMessage,
  referencedPages,
  safeHistory = [],
  clientId = "anonymous",
  siteKnowledgeDebug = null
) {
  let fullAnswer = "";
  let finishReason = null;
  for await (const part of stream) {
    const choice = part.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta?.content || "";
    if (delta) {
      fullAnswer += delta;
      writeNdjsonLine(res, { type: "delta", text: delta });
    }
  }

  let trimmed = finalizeAssistantAnswer(
    fullAnswer.trim(),
    referencedPages,
    userMessage,
    safeHistory
  );
  if (!trimmed) {
    trimmed =
      finishReason === "length"
        ? "回答が長くなりすぎたため途中で止まりました。もう一度、短く質問してみてください。"
        : "すみません、うまく回答を生成できませんでした。もう一度お試しください。";
  }
  const now = new Date();
  console.log(
    "chat-log",
    JSON.stringify({
      ts: now.toISOString(),
      ts_jst: now.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }),
      clientId,
      user: userMessage,
      answer: trimmed,
      streamed: true,
      finishReason,
      model: OPENAI_MODEL,
      rawLen: fullAnswer.length,
    })
  );

  // ログ失敗で応答完了を止めない
  void appendChatLog({
    message: userMessage,
    answer: trimmed,
    clientId,
    meta: { streamed: true, finishReason, model: OPENAI_MODEL },
  }).catch((e) => {
    console.error("appendChatLog failed:", e?.message || e);
  });

  if (referencedPages && referencedPages.length > 0) {
    writeNdjsonLine(res, { type: "references", pages: referencedPages });
  }
  if (siteKnowledgeDebug) {
    writeNdjsonLine(res, { type: "siteKnowledgeDebug", debug: siteKnowledgeDebug });
  }
  writeNdjsonLine(res, { type: "done", text: trimmed });
  return trimmed;
}

function emergencyMessage() {
  return [
    "⚠️ 現在の症状からは、**緊急性が高い可能性があります。**",
    "",
    "次のような状態に当てはまる場合は、**すぐに医療機関へ電話で相談し、受診をご検討ください。**",
    "・大量の出血がある、血が止まりにくい",
    "・我慢できないほどの強い腹痛や胸の痛みがある",
    "・意識がもうろうとしている、けいれんがある",
    "・高い熱が続いている（39℃前後など）",
    "・破水が疑われる、胎動が明らかに少ない  など",
    "",
    "当院へのご相談は 📞**06-6931-2391**（番号非通知は不可） までお電話ください。",
    "夜間などで今すぐ対応が必要だと感じる場合は、**119番（救急要請）も検討してください。**",
  ].join("\n");
}

// できるだけログを残さない（Vercelの標準ログは最小限に）
export default async function handler(req, res) {
  try {
    const origin = req.headers.origin;
    setCors(res, origin);

    // Preflight（CORS事前確認用）
    if (req.method === "OPTIONS") {
      return res.status(200).end();
    }

    // デプロイ確認用（詳細は出さない）
    if (req.method === "GET") {
      const payload = {
        ok: true,
        hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
        hasChatApiSecret: Boolean(getChatApiSecret()),
        hasUpstashRateLimit: hasUpstashConfig,
        rateLimit: hasUpstashConfig ? "20 req / 60 s / IP" : "disabled (env missing)",
        hasSupabase: Boolean(
          process.env.SUPABASE_URL &&
            (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)
        ),
        hasResend: Boolean(process.env.RESEND_API_KEY),
        hasCronSecret: Boolean(process.env.CRON_SECRET),
      };
      if (shouldIncludeSiteKnowledgeDebug(req)) {
        payload.siteKnowledge = peekSiteKnowledgeStatus();
      }
      return res.status(200).json(payload);
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // ---- API シークレット（必須）----
    if (!getChatApiSecret()) {
      console.error("CHAT_API_SECRET is not configured");
      return res.status(500).json({
        answer: "API認証の設定が完了していません。管理者に連絡してください。",
        emergency: false,
        error: "Secret not configured",
      });
    }
    if (!isValidChatApiSecret(req)) {
      return res.status(401).json({
        answer: "認証に失敗したため送信できません。",
        emergency: false,
        error: "Unauthorized",
      });
    }

    // ---- レート制限（IPごと）----
    const ip =
      (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
      req.socket?.remoteAddress ||
      "ip";

    const { success } = await safeRateLimit(ip);
    if (!success) {
      return res.status(429).json({
        answer: "アクセスが集中しています。少し時間をおいてからお試しください。",
        emergency: false,
        ratelimited: true,
      });
    }

    // シークレット検証済みのリクエストはサーバー間通信（PHPプロキシ）として扱う。
    // Origin はブラウザ直叩き対策だが、シークレット無しは上で 401 済みのためここでは見ない。
    // （プロキシ経由では Origin が無い／中継で想定外の値になることがある）

    const body = await readJsonBody(req);
    const userMessage = (body.message || "").trim();
    const wantStream = Boolean(body.stream);
    const history = body.history;
    const clientId = String(body.clientId || body.client_id || "").trim();
    if (!userMessage) {
      return res.status(400).json({ answer: "メッセージが空です。", emergency: false });
    }
    if (userMessage.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({
        answer: `メッセージが長すぎます。${MAX_MESSAGE_CHARS}文字以内で入力してください。`,
        emergency: false,
        error: "Message too long",
      });
    }

    // 危険サインはモデルに投げずに即時誘導（安全のため）
    if (detectEmergency(userMessage)) {
      const answer = emergencyMessage();
      await appendChatLog({
        message: userMessage,
        answer,
        clientId,
        meta: { emergency: true },
      });
      return res.status(200).json({ answer, emergency: true });
    }

    const openai = getOpenAIClient();
    if (!openai) {
      console.error("OPENAI_API_KEY is not configured");
      return res.status(500).json({
        answer: "AI連携の設定が完了していません。管理者に連絡してください。",
        emergency: false,
      });
    }

    const safeHistory = sanitizeHistory(history);

    const casualGreetingOnly = isCasualGreetingOnlyMessage(userMessage, safeHistory);

    if (CHAT_INSTANT_GREETING && casualGreetingOnly) {
      const answer =
        "こんにちは。今日はどのようなことでお手伝いしましょうか。症状やご心配なことがあれば、分かる範囲で教えてください。";
      const now = new Date();
      console.log(
        "chat-log",
        JSON.stringify({
          ts: now.toISOString(),
          ts_jst: now.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }),
          clientId,
          user: userMessage,
          answer,
          instantGreeting: true,
        })
      );
      await appendChatLog({
        message: userMessage,
        answer,
        clientId,
        meta: { instantGreeting: true },
      });
      return res.status(200).json({ answer, emergency: false, instantGreeting: true });
    }

    let clinicSnippet = ""; // 公式サイト抜粋
    let registeredClinicPrompt = ""; // 院内登録情報（clinic-knowledge）
    let referencedPages = [];
    let knowledgeConfidence = "none";
    let siteKnowledgeDebug = null;
    let fetchedSourceChunks = [];
    let clinicKnowledgeHits = [];
    let clinicKnowledgeStrong = false;
    let clinicTopScore = 0;
    let clinicDetectedIntent = null;
    let clinicDetectedService = null;
    let clinicNormalizedQuery = "";
    let clinicRejected = [];
    let evidenceUrls = [];
    let chipUrls = [];
    let siteKnowledgeSearched = false;
    const metaChatHit = detectMetaChatQuery(userMessage);
    const privacyDataQuery = Boolean(metaChatHit) && isPrivacyDataQuery(userMessage);
    const forceRefresh = shouldForceSiteKnowledgeRefresh(req);
    const includeDebug = shouldIncludeSiteKnowledgeDebug(req);

    // プライバシー（保存・IP等）は確認済み仕様の定型案内のみ（医療SYSTEM・推測禁止）
    if (privacyDataQuery) {
      const answer = buildPrivacySpecAnswer(userMessage);
      await appendChatLog({
        message: userMessage,
        answer,
        clientId,
        meta: { metaChat: true, privacySpec: true },
      });
      const payload = {
        answer,
        emergency: false,
        referencedPages: [],
      };
      if (includeDebug) {
        payload.debug = {
          metaChat: metaChatHit,
          privacySpec: true,
          note: "確認済みシステム仕様に基づく定型案内（OpenAI未使用）",
        };
        payload.detectedIntent = null;
        payload.matchedClinicKnowledge = [];
      }
      return res.status(200).json(payload);
    }

    const notOfferedHit = metaChatHit ? null : detectNotOfferedService(userMessage);
    const clinicFactual =
      !metaChatHit && isClinicSpecificFactualQuery(userMessage, safeHistory);
    const queryCategory = metaChatHit
      ? "meta_chat"
      : notOfferedHit
        ? "not_offered"
        : clinicFactual
          ? "clinic_factual"
          : "general";

    // 2) clinic-knowledge 検索（緊急判定の後・公式サイト検索の前）
    //    メタ質問では検索しない
    if (!casualGreetingOnly && !metaChatHit) {
      try {
        const ck = await searchClinicKnowledge(userMessage, { forceRefresh });
        clinicKnowledgeHits = ck.hits || [];
        clinicTopScore = ck.topScore || 0;
        clinicDetectedIntent = ck.detectedIntent || detectClinicIntent(userMessage);
        clinicDetectedService =
          ck.detectedService || detectClinicService(userMessage);
        clinicNormalizedQuery = ck.normalizedQuery || "";
        clinicRejected = ck.rejected || [];
        clinicKnowledgeStrong =
          Boolean(ck.strong) ||
          isClinicKnowledgeStrong(clinicTopScore, clinicKnowledgeHits);
        registeredClinicPrompt = buildClinicRegisteredKnowledgePrompt(
          clinicKnowledgeHits,
          userMessage
        );
        if (includeDebug) {
          siteKnowledgeDebug = {
            ...(siteKnowledgeDebug || {}),
            clinicKnowledge: {
              source: ck.source,
              topScore: clinicTopScore,
              strong: clinicKnowledgeStrong,
              detectedIntent: clinicDetectedIntent,
              detectedService: clinicDetectedService,
              normalizedQuery: clinicNormalizedQuery,
              hits: clinicKnowledgeHits.map((h) => ({
                id: h.item.id,
                category: h.item.category,
                intent: h.item.intent || null,
                service: h.item.service || null,
                score: h.score,
                reasons: h.reasons,
                updatedAt: h.item.updatedAt,
                sourceType: "clinic_registered",
              })),
              rejected: clinicRejected,
              status: peekClinicKnowledgeStatus(),
            },
          };
        }
      } catch (e) {
        console.error("clinic-knowledge search failed:", e?.message || e);
      }
    }

    const dinnerContextText = celebrationDinnerContextText(safeHistory, userMessage);

    // お祝いディナー：苦手食材・メニュー変更（固定メニュー・変更は原則不可。チップなし）
    if (
      !metaChatHit &&
      !casualGreetingOnly &&
      isCelebrationDinnerFoodRequestQuery(userMessage, dinnerContextText)
    ) {
      const ckHit =
        clinicKnowledgeHits.find(
          (h) =>
            h.item?.id === "celebration-dinner-food-request" ||
            h.item?.intent === "meal_customization"
        ) || null;
      const answer = stripServiceGushPhrases(
        buildCelebrationDinnerFoodRequestAnswer(
          userMessage,
          String(ckHit?.item?.answer || "").trim() ||
            CELEBRATION_DINNER_FOOD_REQUEST_ANSWER
        )
      );
      if (includeDebug) {
        siteKnowledgeDebug = {
          ...(siteKnowledgeDebug || {}),
          detectedIntent: clinicDetectedIntent || "meal_customization",
          detectedService: clinicDetectedService || "celebration_dinner",
          matchedClinicKnowledge: ckHit
            ? [
                {
                  id: ckHit.item.id,
                  intent: ckHit.item.intent,
                  service: ckHit.item.service,
                  score: ckHit.score,
                },
              ]
            : [],
          rejectedKnowledge: clinicRejected,
          celebrationDinnerFood: { action: "fixed_no_menu_change", chips: [] },
          note: "食材変更は原則不可。感想・締めなし。特典ページに対応範囲の記載がないためチップなし",
        };
      }
      await appendChatLog({
        message: userMessage,
        answer,
        clientId,
        meta: {
          intent: "meal_customization",
          service: "celebration_dinner",
          celebrationDinnerFoodRequest: true,
        },
      });
      const payload = {
        answer,
        emergency: false,
        referencedPages: [],
      };
      if (includeDebug) {
        payload.debug = siteKnowledgeDebug;
        payload.detectedIntent = "meal_customization";
        payload.detectedService = "celebration_dinner";
        payload.matchedClinicKnowledge = payload.debug.matchedClinicKnowledge;
        payload.rejectedKnowledge = clinicRejected;
      }
      return res.status(200).json(payload);
    }

    // お祝いディナー：食物アレルギー（対応可能と断定しない。チップなし）
    if (
      !metaChatHit &&
      !casualGreetingOnly &&
      isCelebrationDinnerAllergyQuery(userMessage, dinnerContextText)
    ) {
      const ckHit = clinicKnowledgeHits.find(
        (h) =>
          h.item?.id === "celebration-dinner-allergy" ||
          h.item?.intent === "meal_allergy"
      );
      const answer = stripServiceGushPhrases(
        String(ckHit?.item?.answer || "").trim() ||
          CELEBRATION_DINNER_ALLERGY_ANSWER
      );
      if (includeDebug) {
        siteKnowledgeDebug = {
          ...(siteKnowledgeDebug || {}),
          detectedIntent: clinicDetectedIntent || "meal_allergy",
          detectedService: clinicDetectedService || "celebration_dinner",
          matchedClinicKnowledge: ckHit
            ? [
                {
                  id: ckHit.item.id,
                  intent: ckHit.item.intent,
                  service: ckHit.item.service,
                  score: ckHit.score,
                },
              ]
            : [],
          rejectedKnowledge: clinicRejected,
          celebrationDinnerAllergy: { action: "fixed_ask_staff", chips: [] },
          note: "アレルギーは事前確認案内のみ。対応可否は断定しない・チップなし",
        };
      }
      await appendChatLog({
        message: userMessage,
        answer,
        clientId,
        meta: {
          intent: "meal_allergy",
          service: "celebration_dinner",
          celebrationDinnerAllergy: true,
        },
      });
      const payload = {
        answer,
        emergency: false,
        referencedPages: [],
      };
      if (includeDebug) {
        payload.debug = siteKnowledgeDebug;
        payload.detectedIntent = "meal_allergy";
        payload.detectedService = "celebration_dinner";
        payload.matchedClinicKnowledge = payload.debug.matchedClinicKnowledge;
        payload.rejectedKnowledge = clinicRejected;
      }
      return res.status(200).json(payload);
    }

    // 夜診の予約：予約不可・受付順（電話/事前予約可と案内しない。診療時間表は出さない）
    if (
      !metaChatHit &&
      !casualGreetingOnly &&
      !isEveningConsultationHoursQuery(userMessage) &&
      isEveningConsultationReservationQuery(userMessage, dinnerContextText)
    ) {
      const ckHit = clinicKnowledgeHits.find(
        (h) =>
          h.item?.id === "evening-consultation-reservation" ||
          (h.item?.service === "evening_consultation" &&
            h.item?.availability === "unavailable")
      );
      const answer = stripServiceGushPhrases(
        buildEveningReservationAnswer(userMessage, safeHistory) ||
          String(ckHit?.item?.answer || "").trim() ||
          EVENING_RESERVATION_UNAVAILABLE_ANSWER
      );
      const referencedPages = [CLINIC_HOURS_REF_PAGE];
      if (includeDebug) {
        siteKnowledgeDebug = {
          ...(siteKnowledgeDebug || {}),
          detectedIntent: "reservation_availability",
          detectedService: "evening_consultation",
          availability: "unavailable",
          matchedClinicKnowledge: ckHit
            ? [
                {
                  id: ckHit.item.id,
                  intent: ckHit.item.intent,
                  service: ckHit.item.service,
                  availability: ckHit.item.availability || "unavailable",
                  score: ckHit.score,
                },
              ]
            : [],
          rejectedKnowledge: clinicRejected,
          referenceChips: referencedPages,
          note: "夜診は予約不可・受付順。診療時間表は出さない",
        };
      }
      await appendChatLog({
        message: userMessage,
        answer,
        clientId,
        meta: {
          intent: "reservation_availability",
          service: "evening_consultation",
          availability: "unavailable",
          eveningReservationUnavailable: true,
        },
      });
      const payload = {
        answer,
        emergency: false,
        referencedPages,
      };
      if (includeDebug) {
        payload.debug = siteKnowledgeDebug;
        payload.detectedIntent = "reservation_availability";
        payload.detectedService = "evening_consultation";
        payload.availability = "unavailable";
        payload.matchedClinicKnowledge = payload.debug.matchedClinicKnowledge;
        payload.rejectedKnowledge = clinicRejected;
        payload.referenceChips = referencedPages;
      }
      return res.status(200).json(payload);
    }

    // 一般不妊相談（診療時間表を出さない。高度生殖医療は範囲外）
    if (
      !metaChatHit &&
      !casualGreetingOnly &&
      (isInfertilityConsultationQuery(userMessage) ||
        isAdvancedInfertilityQuery(userMessage))
    ) {
      const ckHit = clinicKnowledgeHits.find(
        (h) =>
          h.item?.id === "general-infertility-consultation" ||
          h.item?.intent === "infertility_consultation"
      );
      const built = buildInfertilityConsultationAnswer(userMessage);
      const answer = stripServiceGushPhrases(
        String(built?.answer || "").trim() ||
          String(ckHit?.item?.answer || "").trim() ||
          INFERTILITY_GENERAL_ANSWER
      );
      const referencedPages = [INFERTILITY_SCHEDULE_REF_PAGE];
      if (includeDebug) {
        siteKnowledgeDebug = {
          ...(siteKnowledgeDebug || {}),
          detectedIntent: "infertility_consultation",
          detectedService: "general_infertility_consultation",
          availability: ckHit?.item?.availability || "limited",
          matchedClinicKnowledge: ckHit
            ? [
                {
                  id: ckHit.item.id,
                  intent: ckHit.item.intent,
                  service: ckHit.item.service,
                  availability: ckHit.item.availability || "limited",
                  score: ckHit.score,
                },
              ]
            : [],
          matchedSiteUrl: INFERTILITY_SCHEDULE_REF_PAGE.url,
          rejectedKnowledge: clinicRejected,
          referenceChips: referencedPages,
          infertilityFocus: built?.focus || null,
          note: "一般不妊相談は範囲を明示。診療時間表は出さない。担当曜日は推測しない",
        };
      }
      await appendChatLog({
        message: userMessage,
        answer,
        clientId,
        meta: {
          intent: "infertility_consultation",
          service: "general_infertility_consultation",
          infertilityConsultation: true,
          infertilityFocus: built?.focus || null,
        },
      });
      const payload = {
        answer,
        emergency: false,
        referencedPages,
      };
      if (includeDebug) {
        payload.debug = siteKnowledgeDebug;
        payload.detectedIntent = "infertility_consultation";
        payload.detectedService = "general_infertility_consultation";
        payload.matchedClinicKnowledge = payload.debug.matchedClinicKnowledge;
        payload.matchedSiteUrl = INFERTILITY_SCHEDULE_REF_PAGE.url;
        payload.rejectedKnowledge = clinicRejected;
        payload.referenceChips = referencedPages;
      }
      return res.status(200).json(payload);
    }

    // 診療時間・休診日：確定データからプログラム生成（GPT推測禁止）
    if (
      !metaChatHit &&
      !casualGreetingOnly &&
      isClinicHoursQuery(userMessage)
    ) {
      const built = buildClinicHoursAnswer(userMessage, {
        nowParts: getTokyoNowParts(),
      });
      const answer = stripServiceGushPhrases(
        String(built?.answer || "").trim() || buildFullHoursRichHtml()
      );
      const referencedPages = built?.referencedPages?.length
        ? built.referencedPages
        : [CLINIC_HOURS_REF_PAGE];
      if (includeDebug) {
        siteKnowledgeDebug = {
          ...(siteKnowledgeDebug || {}),
          detectedIntent: built?.intent || "clinic_hours",
          detectedService: "clinic_hours",
          matchedClinicKnowledge: [],
          rejectedKnowledge: clinicRejected,
          referenceChips: referencedPages,
          scheduleData: built?.scheduleData || null,
          note: "診療時間は data/clinic-hours.js の確定データから生成",
        };
      }
      await appendChatLog({
        message: userMessage,
        answer,
        clientId,
        meta: {
          intent: built?.intent || "clinic_hours",
          service: "clinic_hours",
          clinicHours: true,
        },
      });
      const payload = {
        answer,
        emergency: false,
        referencedPages,
      };
      if (includeDebug) {
        payload.debug = siteKnowledgeDebug;
        payload.detectedIntent = built?.intent || "clinic_hours";
        payload.detectedService = "clinic_hours";
        payload.scheduleData = built?.scheduleData || null;
        payload.referenceChips = referencedPages;
        payload.rejectedKnowledge = clinicRejected;
      }
      return res.status(200).json(payload);
    }

    // 分娩料金（予約金・予納金・入院費・割引）：確定データから生成（推測禁止）
    if (
      !metaChatHit &&
      !casualGreetingOnly &&
      !isPostpartumCareFeeQuery(userMessage) &&
      isBirthPricingQuery(userMessage)
    ) {
      const built = buildBirthPricingAnswer(userMessage);
      const ckHit = clinicKnowledgeHits.find(
        (h) =>
          h.item?.id === "birth-pricing" ||
          h.item?.intent === built?.intent ||
          String(h.item?.intent || "").startsWith("birth_")
      );
      const answer = stripServiceGushPhrases(
        String(built?.answer || "").trim()
      );
      const referencedPages = built?.referencedPages?.length
        ? built.referencedPages
        : [BIRTH_PRICING_REF_PAGE];
      // 取得済みサイト抜粋があれば金額ずれを検出（回答は確定データを維持）
      const siteHay = (fetchedSourceChunks || [])
        .map((c) => String(c?.text || ""))
        .join("\n");
      const pricingDrift = detectBirthPricingDrift(siteHay);
      if (includeDebug) {
        siteKnowledgeDebug = {
          ...(siteKnowledgeDebug || {}),
          detectedIntent: built?.intent || "birth_hospitalization_cost",
          detectedService: "childbirth",
          matchedClinicKnowledge: ckHit
            ? [
                {
                  id: ckHit.item.id,
                  intent: ckHit.item.intent,
                  service: ckHit.item.service,
                  score: ckHit.score,
                },
              ]
            : [],
          matchedSiteUrl: BIRTH_PRICING_REF_PAGE.url,
          rejectedKnowledge: clinicRejected,
          referenceChips: referencedPages,
          birthPricingDrift: pricingDrift,
          note: "分娩料金は data/birth-pricing.js の確定データから生成。予約金と予納金を混同しない",
        };
      }
      await appendChatLog({
        message: userMessage,
        answer,
        clientId,
        meta: {
          intent: built?.intent || "birth_hospitalization_cost",
          service: "childbirth",
          birthPricing: true,
          pricingDriftOk: pricingDrift.ok,
        },
      });
      const payload = {
        answer,
        emergency: false,
        referencedPages,
      };
      if (includeDebug) {
        payload.debug = siteKnowledgeDebug;
        payload.detectedIntent = built?.intent || "birth_hospitalization_cost";
        payload.detectedService = "childbirth";
        payload.matchedClinicKnowledge = payload.debug.matchedClinicKnowledge;
        payload.matchedSiteUrl = BIRTH_PRICING_REF_PAGE.url;
        payload.rejectedKnowledge = clinicRejected;
        payload.referenceChips = referencedPages;
        payload.birthPricingDrift = pricingDrift;
      }
      return res.status(200).json(payload);
    }

    // 産後ケアの持ち物：分娩入院一覧を流用しない
    if (
      !metaChatHit &&
      !casualGreetingOnly &&
      isNonChildbirthBelongingsQuery(userMessage) &&
      /持ち物|持参|準備|何を持|バッグ/.test(userMessage)
    ) {
      const answer = POSTPARTUM_BELONGINGS_NO_INFO_ANSWER;
      if (includeDebug) {
        siteKnowledgeDebug = {
          ...(siteKnowledgeDebug || {}),
          detectedIntent: "hospital_bag",
          detectedService: "postpartum_care",
          matchedClinicKnowledge: [],
          matchedSiteUrl: null,
          matchedSection: null,
          referenceChips: [],
          note: "産後ケア持ち物に分娩入院一覧を流用しない",
        };
      }
      await appendChatLog({
        message: userMessage,
        answer,
        clientId,
        meta: { intent: "hospital_bag", service: "postpartum_care" },
      });
      const payload = {
        answer,
        emergency: false,
        referencedPages: [],
      };
      if (includeDebug) {
        payload.debug = siteKnowledgeDebug;
        payload.detectedIntent = "hospital_bag";
        payload.matchedClinicKnowledge = [];
        payload.referenceChips = [];
      }
      return res.status(200).json(payload);
    }

    // 分娩入院の持ち物（公式 #hos_bring を優先。一般論で補完しない）
    if (
      !metaChatHit &&
      !casualGreetingOnly &&
      isHospitalBagQuery(userMessage)
    ) {
      const built = buildHospitalBagAnswer(userMessage);
      const ckHit = clinicKnowledgeHits.find(
        (h) =>
          h.item?.id === "childbirth-hospital-bag" ||
          h.item?.intent === "hospital_bag"
      );
      const answer = stripServiceGushPhrases(
        String(built?.answer || "").trim() ||
          String(ckHit?.item?.answer || "").trim() ||
          HOSPITAL_BAG_SUMMARY_ANSWER
      );
      const referencedPages = [HOSPITAL_BAG_REF_PAGE];
      if (includeDebug) {
        siteKnowledgeDebug = {
          ...(siteKnowledgeDebug || {}),
          detectedIntent: clinicDetectedIntent || "hospital_bag",
          detectedService:
            clinicDetectedService || "childbirth_hospitalization",
          matchedClinicKnowledge: ckHit
            ? [
                {
                  id: ckHit.item.id,
                  intent: ckHit.item.intent,
                  service: ckHit.item.service,
                  score: ckHit.score,
                },
              ]
            : [],
          matchedSiteUrl: HOSPITAL_BAG_PAGE_URL,
          matchedSection: built?.matchedSection || "hos_bring",
          hospitalBagFocus: built?.focus || null,
          referenceChips: referencedPages,
          rejectedKnowledge: clinicRejected,
          note: "入院持ち物は公式分類を優先。電話問い合わせ案内は付けない",
        };
      }
      await appendChatLog({
        message: userMessage,
        answer,
        clientId,
        meta: {
          intent: "hospital_bag",
          service: "childbirth_hospitalization",
          hospitalBag: true,
          matchedSection: built?.matchedSection || "hos_bring",
          hospitalBagFocus: built?.focus || null,
        },
      });
      const payload = {
        answer,
        emergency: false,
        referencedPages,
      };
      if (includeDebug) {
        payload.debug = siteKnowledgeDebug;
        payload.detectedIntent = "hospital_bag";
        payload.detectedService = "childbirth_hospitalization";
        payload.matchedClinicKnowledge = payload.debug.matchedClinicKnowledge;
        payload.matchedSiteUrl = HOSPITAL_BAG_PAGE_URL;
        payload.matchedSection = built?.matchedSection || "hos_bring";
        payload.hospitalBagFocus = built?.focus || null;
        payload.referenceChips = referencedPages;
        payload.rejectedKnowledge = clinicRejected;
      }
      return res.status(200).json(payload);
    }

    // 妊婦健診のエコー頻度（院内確定情報を優先。婦人科エコーには流用しない）
    if (
      !metaChatHit &&
      !casualGreetingOnly &&
      isPrenatalUltrasoundFrequencyQuery(userMessage, dinnerContextText)
    ) {
      const ckHit = clinicKnowledgeHits.find(
        (h) =>
          h.item?.id === "prenatal-checkup-ultrasound-frequency" ||
          h.item?.intent === "ultrasound_frequency"
      );
      const answer = stripServiceGushPhrases(
        buildPrenatalUltrasoundFrequencyAnswer(userMessage) ||
          String(ckHit?.item?.answer || "").trim() ||
          PRENATAL_ULTRASOUND_FREQUENCY_ANSWER
      );
      const referencedPages = [PRENATAL_CHECKUP_REF_PAGE];
      if (includeDebug) {
        siteKnowledgeDebug = {
          ...(siteKnowledgeDebug || {}),
          detectedIntent: clinicDetectedIntent || "ultrasound_frequency",
          detectedService: clinicDetectedService || "prenatal_checkup",
          matchedClinicKnowledge: ckHit
            ? [
                {
                  id: ckHit.item.id,
                  intent: ckHit.item.intent,
                  service: ckHit.item.service,
                  score: ckHit.score,
                },
              ]
            : [],
          rejectedKnowledge: clinicRejected,
          referenceChips: referencedPages,
          note: "妊婦健診エコー頻度は院内情報優先。参照は関連案内チップ",
        };
      }
      await appendChatLog({
        message: userMessage,
        answer,
        clientId,
        meta: {
          intent: "ultrasound_frequency",
          service: "prenatal_checkup",
          prenatalUltrasoundFrequency: true,
        },
      });
      const payload = {
        answer,
        emergency: false,
        referencedPages,
      };
      if (includeDebug) {
        payload.debug = siteKnowledgeDebug;
        payload.detectedIntent = "ultrasound_frequency";
        payload.detectedService = "prenatal_checkup";
        payload.matchedClinicKnowledge = payload.debug.matchedClinicKnowledge;
        payload.rejectedKnowledge = clinicRejected;
        payload.referenceChips = referencedPages;
      }
      return res.status(200).json(payload);
    }

    // 婦人科エコー頻度：妊婦健診ルールを流用しない
    if (
      !metaChatHit &&
      !casualGreetingOnly &&
      isGynecologyUltrasoundFrequencyQuery(userMessage)
    ) {
      const answer = GYNECOLOGY_ULTRASOUND_FREQUENCY_NO_INFO_ANSWER;
      if (includeDebug) {
        siteKnowledgeDebug = {
          ...(siteKnowledgeDebug || {}),
          detectedIntent: clinicDetectedIntent || "service_availability",
          detectedService: "gynecology",
          matchedClinicKnowledge: [],
          rejectedKnowledge: clinicRejected,
          referenceChips: [],
          note: "婦人科エコーに妊婦健診エコー頻度を流用しない",
        };
      }
      await appendChatLog({
        message: userMessage,
        answer,
        clientId,
        meta: {
          intent: "service_availability",
          service: "gynecology",
          gynecologyUltrasoundFrequency: true,
        },
      });
      const payload = {
        answer,
        emergency: false,
        referencedPages: [],
      };
      if (includeDebug) {
        payload.debug = siteKnowledgeDebug;
        payload.detectedIntent = "service_availability";
        payload.detectedService = "gynecology";
        payload.matchedClinicKnowledge = [];
        payload.rejectedKnowledge = clinicRejected;
        payload.referenceChips = [];
      }
      return res.status(200).json(payload);
    }

    // 日常育児相談：月齢に応じて健診／保健センター・小児科へ（過ぎた健診は案内しない）
    if (
      !metaChatHit &&
      !casualGreetingOnly &&
      !isBabyIllnessConsultMessage(userMessage) &&
      !isMotherDistressConsultMessage(userMessage) &&
      !isChildVaccinationQuery(userMessage) &&
      (isDailyBabyCareConsultMessage(userMessage) ||
        isBabyCareAgeFollowUpMessage(userMessage, safeHistory))
    ) {
      const built = buildBabyCareConsultAnswer(userMessage, safeHistory);
      const answer = stripServiceGushPhrases(String(built?.answer || "").trim());
      if (answer) {
        if (includeDebug) {
          siteKnowledgeDebug = {
            ...(siteKnowledgeDebug || {}),
            detectedIntent: "baby_care_consultation",
            detectedService: clinicDetectedService || "infant_checkup",
            infantAgeMonths: built.ageMonths,
            babyCareRoute: built.route,
            matchedClinicKnowledge: clinicKnowledgeHits
              .filter((h) => h.item?.intent === "baby_care_consultation")
              .map((h) => ({
                id: h.item.id,
                intent: h.item.intent,
                service: h.item.service,
                score: h.score,
              })),
            rejectedKnowledge: clinicRejected,
            note: "育児相談は月齢別案内。励まし締めなし",
          };
        }
        await appendChatLog({
          message: userMessage,
          answer,
          clientId,
          meta: {
            intent: "baby_care_consultation",
            service: "infant_checkup",
            infantAgeMonths: built.ageMonths,
            babyCareRoute: built.route,
          },
        });
        const payload = {
          answer,
          emergency: false,
          referencedPages: [],
        };
        if (includeDebug) {
          payload.debug = siteKnowledgeDebug;
          payload.detectedIntent = "baby_care_consultation";
          payload.detectedService = "infant_checkup";
          payload.infantAgeMonths = built.ageMonths;
          payload.babyCareRoute = built.route;
          payload.matchedClinicKnowledge =
            payload.debug.matchedClinicKnowledge;
          payload.rejectedKnowledge = clinicRejected;
        }
        return res.status(200).json(payload);
      }
    }

    // 婦人科手術：未実施（中絶は別登録・変更しない。産科処置には適用しない）
    if (
      !metaChatHit &&
      !casualGreetingOnly &&
      isGynecologicSurgeryQuery(userMessage) &&
      !isAbortionQuery(userMessage)
    ) {
      const ckHit = clinicKnowledgeHits.find(
        (h) =>
          h.item?.id === "gynecologic-surgery-not-offered" ||
          (h.item?.service === "gynecologic_surgery" &&
            h.item?.availability === "unavailable")
      );
      const answer =
        buildGynecologicSurgeryNotOfferedAnswer(userMessage) ||
        String(ckHit?.item?.answer || "").trim() ||
        GYNECOLOGIC_SURGERY_NOT_OFFERED_ANSWER;
      if (includeDebug) {
        siteKnowledgeDebug = {
          ...(siteKnowledgeDebug || {}),
          detectedIntent: clinicDetectedIntent || "service_availability",
          detectedService: clinicDetectedService || "gynecologic_surgery",
          availability: "unavailable",
          matchedClinicKnowledge: ckHit
            ? [
                {
                  id: ckHit.item.id,
                  intent: ckHit.item.intent,
                  service: ckHit.item.service,
                  availability: ckHit.item.availability || "unavailable",
                  score: ckHit.score,
                },
              ]
            : [],
          rejectedKnowledge: clinicRejected,
          gynecologicSurgery: { action: "fixed_not_offered", chips: [] },
          note: "婦人科手術は未実施。中絶登録は変更せず例外扱い。無関係チップなし",
        };
      }
      await appendChatLog({
        message: userMessage,
        answer,
        clientId,
        meta: {
          intent: "service_availability",
          service: "gynecologic_surgery",
          availability: "unavailable",
          gynecologicSurgeryNotOffered: true,
        },
      });
      const payload = {
        answer,
        emergency: false,
        referencedPages: [],
      };
      if (includeDebug) {
        payload.debug = siteKnowledgeDebug;
        payload.detectedIntent = "service_availability";
        payload.detectedService = "gynecologic_surgery";
        payload.availability = "unavailable";
        payload.matchedClinicKnowledge = payload.debug.matchedClinicKnowledge;
        payload.rejectedKnowledge = clinicRejected;
      }
      return res.status(200).json(payload);
    }

    // 産み分け：未実施の院内確定情報を優先（婦人科ページへ誘導しない・チップなし）
    if (!metaChatHit && !casualGreetingOnly && isGenderSelectionQuery(userMessage)) {
      const ckHit = clinicKnowledgeHits.find(
        (h) =>
          h.item?.id === "gender-selection-not-offered" ||
          (h.item?.service === "gender_selection" &&
            h.item?.availability === "unavailable")
      );
      const answer =
        String(ckHit?.item?.answer || "").trim() || GENDER_SELECTION_NOT_OFFERED_ANSWER;
      if (includeDebug) {
        siteKnowledgeDebug = {
          ...(siteKnowledgeDebug || {}),
          detectedIntent: clinicDetectedIntent || "service_availability",
          detectedService: clinicDetectedService || "gender_selection",
          availability: "unavailable",
          matchedClinicKnowledge: ckHit
            ? [
                {
                  id: ckHit.item.id,
                  intent: ckHit.item.intent,
                  service: ckHit.item.service,
                  availability: ckHit.item.availability || "unavailable",
                  score: ckHit.score,
                },
              ]
            : [],
          rejectedKnowledge: clinicRejected,
          genderSelection: { action: "fixed_not_offered", chips: [] },
          note: "産み分けは未実施。婦人科ページを根拠・チップにしない",
        };
      }
      await appendChatLog({
        message: userMessage,
        answer,
        clientId,
        meta: {
          intent: "service_availability",
          service: "gender_selection",
          availability: "unavailable",
          genderSelectionNotOffered: true,
        },
      });
      const payload = {
        answer,
        emergency: false,
        referencedPages: [],
      };
      if (includeDebug) {
        payload.debug = siteKnowledgeDebug;
        payload.detectedIntent = "service_availability";
        payload.detectedService = "gender_selection";
        payload.availability = "unavailable";
        payload.matchedClinicKnowledge = payload.debug.matchedClinicKnowledge;
        payload.rejectedKnowledge = clinicRejected;
      }
      return res.status(200).json(payload);
    }

    // お子さま同伴・キッズルーム（託児・本人診察・予防接種とは分離）
    if (
      !metaChatHit &&
      !casualGreetingOnly &&
      !isChildVaccinationQuery(userMessage) &&
      !isChildcareRequestQuery(userMessage) &&
      !isChildPatientExamQuery(userMessage) &&
      isChildAccompaniedVisitQuery(userMessage)
    ) {
      const ckHit = clinicKnowledgeHits.find(
        (h) =>
          h.item?.id === "child-accompanied-visit" ||
          h.item?.intent === "child_accompanied_visit"
      );
      const built = buildChildAccompaniedVisitAnswer(userMessage);
      const answer = stripServiceGushPhrases(
        String(built?.answer || "").trim() ||
          String(ckHit?.item?.answer || "").trim() ||
          CHILD_ACCOMPANIED_VISIT_ANSWER
      );
      const referencedPages = [FACILITIES_REF_PAGE];
      if (includeDebug) {
        siteKnowledgeDebug = {
          ...(siteKnowledgeDebug || {}),
          detectedIntent: "child_accompanied_visit",
          detectedService: "outpatient_visit",
          matchedClinicKnowledge: ckHit
            ? [
                {
                  id: ckHit.item.id,
                  intent: ckHit.item.intent,
                  service: ckHit.item.service,
                  score: ckHit.score,
                },
              ]
            : [],
          rejectedKnowledge: clinicRejected,
          referenceChips: referencedPages,
          childAccompaniedFocus: built?.focus || null,
          note: "お子さま同伴・キッズルームは施設紹介を案内。託児は断定しない",
        };
      }
      await appendChatLog({
        message: userMessage,
        answer,
        clientId,
        meta: {
          intent: "child_accompanied_visit",
          service: "outpatient_visit",
          childAccompaniedVisit: true,
          childAccompaniedFocus: built?.focus || null,
        },
      });
      const payload = {
        answer,
        emergency: false,
        referencedPages,
      };
      if (includeDebug) {
        payload.debug = siteKnowledgeDebug;
        payload.detectedIntent = "child_accompanied_visit";
        payload.detectedService = "outpatient_visit";
        payload.matchedClinicKnowledge = payload.debug.matchedClinicKnowledge;
        payload.rejectedKnowledge = clinicRejected;
        payload.referenceChips = referencedPages;
      }
      return res.status(200).json(payload);
    }

    // 診察中の預かり・スタッフ託児は肯定しない（キッズルーム案内とは分離）
    if (
      !metaChatHit &&
      !casualGreetingOnly &&
      isChildcareRequestQuery(userMessage)
    ) {
      const answer = stripServiceGushPhrases(CHILDCARE_NOT_OFFERED_ANSWER);
      const referencedPages = [FACILITIES_REF_PAGE];
      if (includeDebug) {
        siteKnowledgeDebug = {
          ...(siteKnowledgeDebug || {}),
          detectedIntent: "service_availability",
          detectedService: "childcare",
          availability: "unavailable",
          matchedClinicKnowledge: [],
          rejectedKnowledge: clinicRejected,
          referenceChips: referencedPages,
          note: "託児・預かりは未実施。同伴可否へ流用しない",
        };
      }
      await appendChatLog({
        message: userMessage,
        answer,
        clientId,
        meta: {
          intent: "service_availability",
          service: "childcare",
          availability: "unavailable",
        },
      });
      const payload = {
        answer,
        emergency: false,
        referencedPages,
      };
      if (includeDebug) {
        payload.debug = siteKnowledgeDebug;
        payload.detectedIntent = "service_availability";
        payload.detectedService = "childcare";
        payload.availability = "unavailable";
        payload.matchedClinicKnowledge = [];
        payload.rejectedKnowledge = clinicRejected;
        payload.referenceChips = referencedPages;
      }
      return res.status(200).json(payload);
    }

    // お子さま本人の診察は同伴案内と混同しない
    if (
      !metaChatHit &&
      !casualGreetingOnly &&
      isChildPatientExamQuery(userMessage)
    ) {
      const answer = stripServiceGushPhrases(CHILD_PATIENT_EXAM_NO_INFO_ANSWER);
      if (includeDebug) {
        siteKnowledgeDebug = {
          ...(siteKnowledgeDebug || {}),
          detectedIntent: "service_availability",
          detectedService: "pediatric_care",
          matchedClinicKnowledge: [],
          rejectedKnowledge: clinicRejected,
          referenceChips: [],
          note: "お子さま本人の診療は同伴・キッズルーム案内を流用しない",
        };
      }
      await appendChatLog({
        message: userMessage,
        answer,
        clientId,
        meta: {
          intent: "service_availability",
          service: "pediatric_care",
        },
      });
      const payload = {
        answer,
        emergency: false,
        referencedPages: [],
      };
      if (includeDebug) {
        payload.debug = siteKnowledgeDebug;
        payload.detectedIntent = "service_availability";
        payload.detectedService = "pediatric_care";
        payload.matchedClinicKnowledge = [];
        payload.rejectedKnowledge = clinicRejected;
        payload.referenceChips = [];
      }
      return res.status(200).json(payload);
    }

    // お子さまの予防接種：未実施の院内確定情報を優先（妊婦向けワクチンページを根拠にしない）
    if (!metaChatHit && !casualGreetingOnly && isChildVaccinationQuery(userMessage)) {
      const ckHit = clinicKnowledgeHits.find(
        (h) =>
          h.item?.id === "child-vaccination-not-offered" ||
          (h.item?.intent === "vaccination_availability" &&
            h.item?.service === "pediatric_vaccination")
      );
      const answer = String(ckHit?.item?.answer || "").trim() || CHILD_VACCINATION_NOT_OFFERED_ANSWER;
      const audience = detectVaccinationAudience(userMessage);
      if (includeDebug) {
        siteKnowledgeDebug = {
          ...(siteKnowledgeDebug || {}),
          detectedIntent: clinicDetectedIntent || "vaccination_availability",
          detectedService: clinicDetectedService || "pediatric_vaccination",
          detectedTarget: audience,
          matchedClinicKnowledge: ckHit
            ? [
                {
                  id: ckHit.item.id,
                  intent: ckHit.item.intent,
                  service: ckHit.item.service,
                  score: ckHit.score,
                },
              ]
            : [],
          rejectedKnowledge: clinicRejected,
          childVaccination: { action: "fixed_not_offered", chips: [] },
          note: "お子さま予防接種は未実施。ワクチンページは根拠にしない",
        };
      }
      await appendChatLog({
        message: userMessage,
        answer,
        clientId,
        meta: {
          intent: "vaccination_availability",
          service: "pediatric_vaccination",
          target: audience,
          childVaccinationNotOffered: true,
        },
      });
      const payload = {
        answer,
        emergency: false,
        referencedPages: [],
      };
      if (includeDebug) {
        payload.debug = siteKnowledgeDebug;
        payload.detectedIntent = "vaccination_availability";
        payload.detectedService = "pediatric_vaccination";
        payload.detectedTarget = audience;
        payload.matchedClinicKnowledge = payload.debug.matchedClinicKnowledge;
        payload.rejectedKnowledge = clinicRejected;
      }
      return res.status(200).json(payload);
    }

    // 産後ケア中の面会：産科入院の面会ルールを流用せず、根拠が無ければ定型案内
    const postpartumVisitationNoEvidence =
      !metaChatHit &&
      !casualGreetingOnly &&
      clinicDetectedService === "postpartum_care" &&
      (clinicDetectedIntent === "visitation" ||
        isVisitationIntentMessage(userMessage)) &&
      !clinicKnowledgeHits.some(
        (h) =>
          h.item?.service === "postpartum_care" &&
          (h.item?.intent === "visitation" || /面会/.test(h.item?.answer || ""))
      );
    if (postpartumVisitationNoEvidence) {
      const answer = POSTPARTUM_VISITATION_NO_INFO_ANSWER;
      if (includeDebug) {
        siteKnowledgeDebug = {
          ...(siteKnowledgeDebug || {}),
          detectedIntent: clinicDetectedIntent,
          detectedService: clinicDetectedService,
          matchedClinicKnowledge: [],
          rejectedKnowledge: clinicRejected,
          excludedEvidence: [
            {
              url: MEETING_INFO_PAGE_URL,
              reason: "service不一致:産後ケア面会に産科入院面会を流用しない",
            },
          ],
          postpartumVisitation: { action: "fixed_no_info" },
        };
      }
      await appendChatLog({
        message: userMessage,
        answer,
        clientId,
        meta: {
          intent: clinicDetectedIntent,
          service: clinicDetectedService,
          postpartumVisitationNoInfo: true,
        },
      });
      const payload = {
        answer,
        emergency: false,
        referencedPages: [],
      };
      if (includeDebug) {
        payload.debug = siteKnowledgeDebug;
        payload.detectedIntent = clinicDetectedIntent;
        payload.detectedService = clinicDetectedService;
        payload.matchedClinicKnowledge = [];
        payload.rejectedKnowledge = clinicRejected;
      }
      return res.status(200).json(payload);
    }

    // 3) 公式サイト検索（メタ質問では実行しない）
    const shouldFetchWebKnowledge =
      !metaChatHit &&
      !casualGreetingOnly &&
      (!SITE_KNOWLEDGE_GATED ||
        clinicFactual ||
        Boolean(notOfferedHit) ||
        clinicKnowledgeHits.length > 0);

    if (shouldFetchWebKnowledge) {
      siteKnowledgeSearched = true;
      const attendFocused = isAttendFocusedQuery(userMessage);
      const meetingFocused = isMeetingFocusedQuery(userMessage);

      const {
        snippet: webSnippet,
        sourceChunks,
        confidence,
        debug,
        evidenceUrls: siteEvidence = [],
        chipUrls: siteChips = [],
      } = await getSiteKnowledgeSnippetSupplement(userMessage, {
        forceRefresh,
        includeDebug,
        clinicKnowledgeStrong,
      });
      fetchedSourceChunks = sourceChunks || [];
      knowledgeConfidence = confidence || (webSnippet ? "low" : "none");
      evidenceUrls = siteEvidence || [];
      chipUrls = siteChips || [];
      if (includeDebug && debug) {
        siteKnowledgeDebug = { ...(siteKnowledgeDebug || {}), ...debug };
      }

      // clinic強ヒット時: サイトは補助。根拠に足るURLが無ければ抜粋も渡さない
      if (clinicKnowledgeStrong && !evidenceUrls.length) {
        clinicSnippet = "";
        knowledgeConfidence = "none";
        chipUrls = [];
      } else if (webSnippet && knowledgeConfidence !== "none") {
        clinicSnippet = webSnippet;
      }

      // チップは evidence 由来のみ（検索候補の流用禁止）
      if (attendFocused && clinicSnippet && !clinicKnowledgeStrong) {
        referencedPages = [
          { url: ATTEND_INFO_PAGE_URL, title: "立ち会い分娩について" },
        ];
        chipUrls = referencedPages.map((p) => ({
          ...p,
          score: 999,
          reason: "立ち会い専用",
        }));
        evidenceUrls = chipUrls;
      } else if (meetingFocused && clinicSnippet && !clinicKnowledgeStrong) {
        referencedPages = [
          { url: MEETING_INFO_PAGE_URL, title: "面会について" },
        ];
        chipUrls = referencedPages.map((p) => ({
          ...p,
          score: 999,
          reason: "面会専用",
        }));
        evidenceUrls = chipUrls;
      } else {
        referencedPages = (chipUrls || []).map((c) => ({
          url: c.url,
          title: c.title,
        }));
      }

      // clinic-knowledge の relatedSiteUrl: 本文が回答を裏付ける場合のみチップ補完
      if (!referencedPages.length && clinicKnowledgeHits.length) {
        const relatedChip = relatedSiteUrlChipFromClinicHits(
          clinicKnowledgeHits,
          fetchedSourceChunks,
          userMessage
        );
        if (relatedChip) {
          referencedPages = [{ url: relatedChip.url, title: relatedChip.title }];
          chipUrls = [relatedChip];
          if (!evidenceUrls.some((e) => e.url === relatedChip.url)) {
            evidenceUrls = [...evidenceUrls, relatedChip];
          }
        }
      }

      if (clinicSnippet.length > SITE_SNIPPET_MAX_CHARS) {
        clinicSnippet =
          clinicSnippet.slice(0, SITE_SNIPPET_MAX_CHARS) +
          "\n\n（以降、文字数制限のため省略しました）";
      }
    }

    // clinic-knowledgeのみ根拠 / メタ質問 → チップなし
    // （relatedSiteUrl で本文裏付けチップを付けた場合は evidenceUrls があるので残す）
    if (metaChatHit || (clinicKnowledgeStrong && !evidenceUrls.length)) {
      referencedPages = [];
      chipUrls = [];
      if (metaChatHit) {
        clinicSnippet = "";
        registeredClinicPrompt = "";
        knowledgeConfidence = "none";
      }
    }

    // 固定ルール回答時: 根拠にしていないURLはチップに出さない
    // 話題一致ページが無い場合はサイト抜粋も渡さない（無関係なお知らせの混入防止）
    if (notOfferedHit) {
      referencedPages = filterReferencedPagesForNotOffered(
        notOfferedHit,
        fetchedSourceChunks,
        referencedPages
      );
      if (!referencedPages.length) {
        clinicSnippet = "";
        knowledgeConfidence = "none";
      } else {
        // 一致ページの本文だけを根拠として残す
        const allow = new Set(referencedPages.map((p) => String(p.url || "").split("#")[0]));
        const related = (fetchedSourceChunks || []).filter((c) =>
          allow.has(String(c.url || "").split("#")[0])
        );
        if (related.length) {
          clinicSnippet = [
            "【当院公式サイトからの抜粋（固定ルール対象に関連するページのみ）】",
            ...related.map(
              (c) =>
                `【${c.title || c.url}】\nURL: ${c.url}\n${c.lastmod ? `更新: ${c.lastmod}\n` : ""}${c.text}`
            ),
          ].join("\n\n");
          if (clinicSnippet.length > SITE_SNIPPET_MAX_CHARS) {
            clinicSnippet =
              clinicSnippet.slice(0, SITE_SNIPPET_MAX_CHARS) +
              "\n\n（以降、文字数制限のため省略しました）";
          }
        } else {
          clinicSnippet = "";
        }
      }
      const conflict = detectFixedRuleConflict(notOfferedHit, fetchedSourceChunks);
      if (conflict) {
        console.warn("fixed_rule_conflict", JSON.stringify(conflict));
        if (includeDebug) {
          siteKnowledgeDebug = {
            ...(siteKnowledgeDebug || {}),
            fixed_rule_conflict: conflict,
          };
        }
      } else if (includeDebug) {
        siteKnowledgeDebug = {
          ...(siteKnowledgeDebug || {}),
          fixed_rule_conflict: null,
        };
      }
    }

    const knowledgeHitScore =
      registeredClinicPrompt || clinicSnippet || referencedPages.length > 0 ? 20 : 0;
    if (shouldSuppressReferencePages(userMessage, safeHistory, knowledgeHitScore)) {
      if (
        !clinicKnowledgeStrong &&
        (isAttendFocusedQuery(userMessage) || isMeetingFocusedQuery(userMessage))
      ) {
        referencedPages = finalizeReferencedPages(referencedPages, userMessage);
      } else {
        referencedPages = [];
      }
    } else if (!notOfferedHit) {
      referencedPages = finalizeReferencedPages(referencedPages, userMessage);
    } else {
      referencedPages = referencedPages.slice(0, MAX_REFERENCE_CHIPS);
    }
    referencedPages = await filterPagesBySitemap(referencedPages);

    // clinic強ヒットかつサイト根拠なし → 再確認してチップを消す
    if (metaChatHit || (clinicKnowledgeStrong && !clinicSnippet)) {
      referencedPages = [];
    }

    // チップ最終ガード（質問関連性）
    const chipGuard = guardReferenceChipsByQuestion(referencedPages, userMessage, {
      metaChat: Boolean(metaChatHit),
      clinicOnly: clinicKnowledgeStrong && !clinicSnippet,
      notOfferedOnly: Boolean(notOfferedHit) && !clinicSnippet && !registeredClinicPrompt,
    });
    referencedPages = chipGuard.pages;

    // 院内サービス対応可否: 根拠が無いときは GPT に渡さず未確認案内（推測禁止）
    const serviceAvailQuestion =
      !metaChatHit &&
      !casualGreetingOnly &&
      !notOfferedHit &&
      isServiceAvailabilityQuestion(userMessage);
    const serviceAvailability = serviceAvailQuestion
      ? resolveServiceAvailabilityStatus({
          userMessage,
          notOfferedHit,
          clinicHits: clinicKnowledgeHits,
          sourceChunks: fetchedSourceChunks,
          attendFocused: isAttendFocusedQuery(userMessage),
          meetingFocused: isMeetingFocusedQuery(userMessage),
          photoFocused: isPhotoRecordingFocusedQuery(userMessage),
        })
      : null;

    if (serviceAvailQuestion && serviceAvailability === "unknown") {
      const answer = buildServiceAvailabilityUnknownAnswer(userMessage);
      if (includeDebug) {
        siteKnowledgeDebug = {
          ...(siteKnowledgeDebug || {}),
          detectedIntent: clinicDetectedIntent,
          detectedService: clinicDetectedService,
          availability: "unknown",
          serviceAvailability: {
            status: "unknown",
            topic: matchServiceAvailabilityTopic(userMessage)?.id || null,
            action: "fixed_unknown",
          },
          matchedClinicKnowledge: clinicKnowledgeHits.map((h) => ({
            id: h.item.id,
            score: h.score,
            availability: h.item.availability || null,
          })),
          note: "サービス対応可否の明確根拠なし→未確認案内（チップなし）",
        };
      }
      await appendChatLog({
        message: userMessage,
        answer,
        clientId,
        meta: {
          intent: clinicDetectedIntent,
          service: clinicDetectedService,
          availability: "unknown",
        },
      });
      const payload = {
        answer,
        emergency: false,
        referencedPages: [],
      };
      if (includeDebug) {
        payload.debug = siteKnowledgeDebug;
        payload.detectedIntent = clinicDetectedIntent;
        payload.detectedService = clinicDetectedService;
        payload.availability = "unknown";
        payload.matchedClinicKnowledge = siteKnowledgeDebug.matchedClinicKnowledge;
        payload.rejectedKnowledge = clinicRejected;
      }
      return res.status(200).json(payload);
    }

    // 根拠がある対応可否でも、質問サービスと一致しない関連ページだけのチップは出さない
    if (serviceAvailQuestion && serviceAvailability === "available") {
      if (
        matchServiceAvailabilityTopic(userMessage) &&
        !siteEvidenceSupportsServiceAvailability(userMessage, fetchedSourceChunks) &&
        !clinicKnowledgeStrong &&
        !isAttendFocusedQuery(userMessage) &&
        !isMeetingFocusedQuery(userMessage) &&
        !isGynecologyTopicMessage(userMessage)
      ) {
        referencedPages = [];
      }
    }

    if (includeDebug) {
      siteKnowledgeDebug = {
        ...(siteKnowledgeDebug || {}),
        queryCategory,
        metaChat: metaChatHit || null,
        siteKnowledgeSearched,
        availability: serviceAvailability,
        evidenceUrls,
        chipUrls: referencedPages.map((p) => ({
          url: p.url,
          title: p.title,
          reason:
            chipUrls.find((c) => c.url === p.url)?.reason ||
            (clinicKnowledgeStrong
              ? "clinic併用の公式根拠"
              : "evidence採用"),
        })),
        excludedUrls: [
          ...((siteKnowledgeDebug && siteKnowledgeDebug.excludedUrls) || []),
          ...chipGuard.excluded,
        ].slice(0, 50),
        chipDecision: {
          clinicKnowledgeStrong,
          clinicTopScore,
          siteEvidenceCount: evidenceUrls.length,
          finalChipCount: referencedPages.length,
          siteKnowledgeSearched,
          queryCategory,
          note: metaChatHit
            ? "meta_chat→サイト検索なし・チップなし"
            : clinicKnowledgeStrong
              ? evidenceUrls.length
                ? "clinic-knowledge優先＋公式サイト根拠あり→根拠URLのみチップ"
                : "clinic-knowledgeのみ根拠→チップなし"
              : "通常のサイト根拠チップ選定",
        },
      };
    }

    // WEB予約可否: 変更・キャンセル情報で穴埋めしない。根拠が無ければ定型回答。
    const webReserveAvailIntent =
      clinicDetectedIntent === "web_reservation_availability";
    const webReserveHasClinic = clinicKnowledgeHits.some(
      (h) => h.item?.intent === "web_reservation_availability"
    );
    const webReserveHasSite = siteMentionsWebReservationAvailability(clinicSnippet);
    if (webReserveAvailIntent && !webReserveHasClinic && !webReserveHasSite) {
      const answer = WEB_RESERVATION_NO_INFO_ANSWER;
      if (includeDebug) {
        siteKnowledgeDebug = {
          ...(siteKnowledgeDebug || {}),
          detectedIntent: clinicDetectedIntent,
          normalizedQuery: clinicNormalizedQuery,
          matchedClinicKnowledge: [],
          rejectedKnowledge: clinicRejected,
          webReservationAvailability: {
            hasClinic: false,
            hasSite: false,
            action: "fixed_no_info",
          },
        };
      }
      await appendChatLog({
        message: userMessage,
        answer,
        clientId,
        meta: {
          intent: clinicDetectedIntent,
          webReservationNoInfo: true,
        },
      });
      const payload = {
        answer,
        emergency: false,
        referencedPages: [],
      };
      if (includeDebug) {
        payload.debug = siteKnowledgeDebug;
        payload.detectedIntent = clinicDetectedIntent;
        payload.normalizedQuery = clinicNormalizedQuery;
        payload.matchedClinicKnowledge = [];
        payload.rejectedKnowledge = clinicRejected;
      }
      return res.status(200).json(payload);
    }
    if (webReserveAvailIntent && webReserveHasSite && !webReserveHasClinic) {
      // 予約変更・キャンセルの院内登録が混ざらないようクリア済み想定。サイト可否のみ使う。
      registeredClinicPrompt = "";
    }

    const needNoEvidencePrompt =
      !metaChatHit &&
      clinicFactual &&
      !clinicSnippet &&
      !registeredClinicPrompt &&
      !notOfferedHit;

    const tokyoDatetimePrompt = buildTokyoDatetimeSystemPrompt(userMessage);
    const dinnerIntent =
      !isCelebrationDinnerFoodRequestQuery(userMessage, dinnerContextText) &&
      !isCelebrationDinnerAllergyQuery(userMessage, dinnerContextText) &&
      (clinicDetectedIntent === "childbirth_bonus_dinner" ||
        clinicKnowledgeHits.some(
          (h) => h.item?.intent === "childbirth_bonus_dinner"
        ));
    const reservationIntentGuard =
      webReserveAvailIntent && (webReserveHasClinic || webReserveHasSite)
        ? [
            {
              role: "system",
              content: [
                "【このターン：WEB予約の可否】",
                "ユーザーはWEB予約ができるかどうかを尋ねています（否定疑問も含む）。",
                "予約変更期限・キャンセル手順・前日08:00／14:00などの変更専用情報は使わないでください。",
                "渡された抜粋に書かれたWEB予約の可否・対象（初診/再診など）だけを案内してください。",
              ].join("\n"),
            },
          ]
        : clinicDetectedIntent === "reservation_change"
          ? [
              {
                role: "system",
                content:
                  "【このターン：予約変更】予約変更の期限・方法だけを案内し、WEB予約の可否一般論で薄めないでください。",
              },
            ]
          : clinicDetectedIntent === "reservation_cancel"
            ? [
                {
                  role: "system",
                  content:
                    "【このターン：予約キャンセル】キャンセル手順だけを案内してください。",
                },
              ]
            : dinnerIntent
              ? [
                  {
                    role: "system",
                    content: [
                      "【このターン：お祝いディナー（分娩予約特典）】",
                      "・確定情報: ご出産された患者さまのほかに、ご家族様1名をご招待いただける。",
                      "・「一人で食べるの？」「一人でしか食べられない？」などには「はい／いいえ」を機械的に付けず、上記事実を直接説明する。",
                      "・「家族と食べられる？」「2人で食べられる？」→ 患者さま＋ご家族様1名で案内してよい。",
                      "・「3人で食べられる？」→ 確認できる招待はご家族様1名までと案内し、追加参加の可否は推測しない。",
                      "・質問の言い回しで人数・特典内容を変えない。感想（嬉しい／素敵／楽しみ）は付けない。",
                      "・参照があるときは分娩予約特典ページへ案内してよい（本文末にURL箇条書きは書かない）。",
                    ].join("\n"),
                  },
                ]
              : [];

    const messages = [
      { role: "system", content: SYSTEM },
      ...(tokyoDatetimePrompt
        ? [{ role: "system", content: tokyoDatetimePrompt }]
        : []),
      ...reservationIntentGuard,
      // 院内登録情報（公式サイトより優先）→ 公式サイト抜粋の順で渡す
      ...(registeredClinicPrompt
        ? [{ role: "system", content: registeredClinicPrompt }]
        : []),
      ...(clinicSnippet
        ? [
            {
              role: "system",
              content: clinicSnippet,
            },
          ]
        : needNoEvidencePrompt
          ? [{ role: "system", content: PROMPT_NO_CLINIC_EVIDENCE }]
          : []),
      {
        role: "system",
        content: buildReferenceLinksSystemPrompt(referencedPages),
      },
      ...(shouldForceRichHtmlForMessage(userMessage, safeHistory) &&
      !notOfferedHit &&
      (clinicSnippet || registeredClinicPrompt)
        ? [{ role: "system", content: RICH_HTML_THIS_TURN }]
        : []),
      ...(metaChatHit
        ? [{ role: "system", content: PROMPT_META_CHAT }]
        : isMotherDistressConsultMessage(userMessage)
          ? [{ role: "system", content: PROMPT_MOTHER_DISTRESS }]
          : isBabyIllnessConsultMessage(userMessage)
            ? [{ role: "system", content: PROMPT_BABY_ILLNESS }]
            : clinicDetectedIntent === "baby_care_consultation" ||
                isDailyBabyCareConsultMessage(userMessage)
              ? [{ role: "system", content: PROMPT_BABY_CARE_CONSULTATION }]
              : detectVaccinationAudience(userMessage) &&
                  !isChildVaccinationQuery(userMessage)
                ? [{ role: "system", content: PROMPT_VACCINATION_AUDIENCE }]
                : shouldAddOtherHospitalExperiencePrompt(userMessage, safeHistory)
                  ? [{ role: "system", content: PROMPT_OTHER_HOSPITAL_EXPERIENCE }]
                  : shouldAddComplaintPrompt(userMessage, safeHistory)
                    ? [{ role: "system", content: PROMPT_COMPLAINT }]
                    : notOfferedHit
                      ? [
                          {
                            role: "system",
                            content: buildNotOfferedPrompt(notOfferedHit),
                          },
                        ]
                      : shouldAddShortBackchannelPrompt(userMessage, safeHistory)
                        ? [{ role: "system", content: PROMPT_SHORT_BACKCHANNEL }]
                        : []),
      ...safeHistory
        .filter((h) => h && (h.role === "user" || h.role === "assistant"))
        .map((h) => ({
          role: h.role,
          content:
            h.role === "assistant"
              ? normalizeLegacyTwoLayerAnswer(String(h.content || ""))
              : String(h.content || ""),
        })),
      { role: "user", content: userMessage },
    ];

    if (wantStream) {
      let stream;
      try {
        stream = await createOpenAIStream(openai, messages);
      } catch (createErr) {
        console.error("openai stream create error:", createErr?.message || createErr);
        const status = createErr?.status || createErr?.statusCode || 500;
        const msg = String(createErr?.message || "");
        let answer = "サーバ側でエラーが発生しました。時間をおいて再度お試しください。";
        if (status === 401 || /incorrect api key|invalid api key/i.test(msg)) {
          answer =
            "AIサービスの認証に失敗しました。本番環境の OPENAI_API_KEY をダッシュボードで確認してください。";
        } else if (status === 404 || /model_not_found|does not exist|model/i.test(msg)) {
          answer = `AIモデル「${OPENAI_MODEL}」が利用できません。Vercel の OPENAI_MODEL を確認してください。`;
        } else if (/max_tokens|max_completion_tokens|reasoning_effort|unsupported parameter/i.test(msg)) {
          answer =
            "AIへのリクエスト形式がモデルと合いません。管理者が OPENAI_MODEL 等を確認してください。";
        }
        return res.status(status >= 400 && status < 600 ? status : 500).json({
          answer,
          emergency: false,
          error: msg.slice(0, 200),
        });
      }

      try {
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
        });
        await pipeOpenAIStreamNdjson(
          res,
          stream,
          userMessage,
          referencedPages,
          safeHistory,
          clientId,
          siteKnowledgeDebug
        );
        res.end();
      } catch (streamErr) {
        console.error("openai stream error:", streamErr?.message || streamErr);
        if (!res.headersSent) {
          return res.status(500).json({
            answer: "サーバ側でエラーが発生しました。",
            emergency: false,
          });
        }
        try {
          writeNdjsonLine(res, {
            type: "error",
            message: "応答の送信が途中で止まりました。時間をおいて再度お試しください。",
          });
        } catch {
          /* ignore */
        }
        res.end();
      }
      return;
    }

    const completion = await openai.chat.completions.create(
      buildOpenAICompletionParams({ messages, stream: false })
    );

    const raw =
      (completion.choices[0]?.message?.content || "").trim() ||
      "すみません、うまく回答を生成できませんでした。";
    // 回答で案内した高関連ページがあればチップを後付け（取得済みのみ）
    referencedPages = alignChipsWithAnswerPageMentions(
      raw,
      [
        ...(evidenceUrls || []),
        ...(fetchedSourceChunks || []).map((c) => ({
          url: c.url,
          title: labelForKnowledgeChunk(c),
          score: c.score,
        })),
      ],
      referencedPages
    );
    const answer = finalizeAssistantAnswer(raw, referencedPages, userMessage, safeHistory);

    // Vercel のログにチャット内容（生テキスト）を残す
    // - IP やブラウザ情報などの識別子は含めない
    // - JST と ISO の両方のタイムスタンプを記録して、あとから見やすくする
    const now = new Date();
    const tsIso = now.toISOString();
    const tsJst = now.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

    console.log(
      "chat-log",
      JSON.stringify({
        ts: tsIso,
        ts_jst: tsJst,
        clientId,
        user: userMessage,
        answer,
      })
    );
    await appendChatLog({
      message: userMessage,
      answer,
      clientId,
    });

    const payload = { answer, emergency: false, referencedPages };
    if (siteKnowledgeDebug) {
      payload.siteKnowledgeDebug = siteKnowledgeDebug;
      payload.knowledgeConfidence = knowledgeConfidence;
    }
    if (includeDebug) {
      payload.detectedIntent = clinicDetectedIntent;
      payload.detectedService = clinicDetectedService;
      payload.normalizedQuery = clinicNormalizedQuery;
      payload.matchedClinicKnowledge = clinicKnowledgeHits.map((h) => ({
        id: h.item.id,
        intent: h.item.intent || null,
        service: h.item.service || null,
        score: h.score,
        reasons: h.reasons,
      }));
      payload.rejectedKnowledge = clinicRejected;
    }
    return res.status(200).json(payload);
  } catch (e) {
    const detail = e?.message || String(e);
    const status = e?.status ?? e?.response?.status;
    const code = e?.code;
    console.error(
      "chat handler error:",
      detail,
      status != null ? `http=${status}` : "",
      code != null ? `code=${code}` : ""
    );

    if (e instanceof APIConnectionError) {
      return res.status(500).json({
        answer: "AIサービスへ接続できませんでした。時間をおいて再度お試しください。",
        emergency: false,
      });
    }

    if (status === 401) {
      return res.status(500).json({
        answer:
          "AIサービスの認証に失敗しました。本番環境の OPENAI_API_KEY をダッシュボードで確認してください。",
        emergency: false,
      });
    }

    if (status === 403) {
      return res.status(500).json({
        answer:
          "AIの利用がこのキーでは許可されていません（組織・プロジェクト設定を確認してください）。",
        emergency: false,
      });
    }

    if (status === 404) {
      return res.status(500).json({
        answer: `AIモデル「${OPENAI_MODEL}」が利用できません。Vercel の OPENAI_MODEL を gpt-4o-mini などに設定し直してください。`,
        emergency: false,
      });
    }

    if (status === 429 || code === "insufficient_quota") {
      return res.status(500).json({
        answer:
          "AIサービス側の混雑、または利用上限に達しています。しばらくしてからお試しいただくか、請求・枠をご確認ください。",
        emergency: false,
      });
    }

    if (status === 400 && e instanceof APIError) {
      return res.status(500).json({
        answer:
          "AIへのリクエストが拒否されました（モデル名・入力内容の制限）。管理者が OPENAI_MODEL 等を確認してください。",
        emergency: false,
      });
    }

    return res.status(500).json({ answer: "サーバ側でエラーが発生しました。", emergency: false });
  }
}