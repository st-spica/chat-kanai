/**
 * 会話の話題解決：最新メッセージ優先・話題変更検出・緊急継続
 *
 * 履歴は同一話題のフォローアップ補助にのみ使い、
 * 別意図の最新質問を過去知識で上書きしない。
 */

import {
  isBreechPresentationQuery,
  mentionsBreechTopic,
} from "./pregnancy-breech.js";
import {
  isPregnancyWeightQuery,
  mentionsPregnancyWeightTopic,
} from "./pregnancy-weight.js";
import {
  isLaborHospitalContactQuery,
  mentionsLaborContactTopic,
} from "./labor-contact.js";
import { isMorningSicknessQuery } from "./morning-sickness.js";
import { isPregnancyWorkDocumentQuery } from "./pregnancy-work-document.js";
import { isPatientComplaintQuery } from "./patient-complaint.js";
import { isPostpartumCareQuery } from "./postpartum-care.js";
import { isHospitalMealsQuery } from "./hospital-meals.js";
import {
  isPregnancyFolicAcidQuery,
  isPregnancyMedicationQuery,
  isBreastfeedingMedicationQuery,
} from "./pregnancy-medication.js";
import {
  detectBirthPricingIntent,
  isBirthPricingQuery,
} from "./birth-pricing.js";
import { isHomecomingDeliveryQuery } from "./homecoming-delivery.js";
import { isFirstVisitFeeQuery } from "./first-visit-fee.js";
import { isFourDUltrasoundQuery } from "./four-d-ultrasound.js";
import {
  isFemaleDoctorQuery,
  isMaleDoctorQuery,
} from "./female-doctor.js";
import { isNewbornMaternityPhotoQuery } from "./newborn-maternity-photo.js";
import {
  isMilkcareQuery,
  isMilkcareReservationQuery,
} from "./milkcare.js";
import { isClinicFacilitiesQuery } from "./clinic-facilities.js";
import { isClinicAccessQuery } from "./clinic-access.js";
import { isPrenatalClassesQuery } from "./prenatal-classes.js";
import { isClinicHoursQuery } from "./clinic-hours.js";
import {
  isAppointmentGuidanceQuery,
  isPhoneNumberQuery,
  isUrgentContactQuery,
} from "./appointment-guidance.js";
import { isHpvVaccineQuery } from "./hpv-vaccine.js";
import {
  isCervicalCancerScreeningQuery,
  isHpvVaccineVsScreeningQuery,
} from "./cervical-cancer-screening.js";
import {
  isKidsRoomQuery,
  isEveningConsultationReservationQuery,
  isCelebrationDinnerAllergyQuery,
  isCelebrationDinnerFoodRequestQuery,
} from "./site-route-map.js";

/** @typedef {string|null} TopicIntent */

/**
 * @param {Array<{role?:string,content?:string}>} safeHistory
 * @returns {string|null}
 */
export function getLastUserMessage(safeHistory) {
  const list = Array.isArray(safeHistory) ? safeHistory : [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === "user" && String(list[i].content || "").trim()) {
      return String(list[i].content).trim();
    }
  }
  return null;
}

/**
 * ユーザー発話のみ連結（アシスタントの目安文から数値を拾わない）
 * @param {Array<{role?:string,content?:string}>} safeHistory
 * @param {string} [userMessage]
 */
export function userTurnsText(safeHistory, userMessage = "") {
  const parts = [];
  for (const h of safeHistory || []) {
    if (h?.role === "user") parts.push(String(h.content || ""));
  }
  if (userMessage) parts.push(String(userMessage));
  return parts.join("\n").slice(-4000);
}

/**
 * 最新メッセージ単体で成立する意図（履歴なし）
 * @param {string} userMessage
 * @returns {TopicIntent}
 */
export function detectStandaloneIntent(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return null;

  // クレーム・ご意見（他トピックより先）
  if (isPatientComplaintQuery(msg)) return "patient_complaint";

  // 母乳ケア（産後ケア全般より先）
  if (isMilkcareQuery(msg)) {
    if (isMilkcareReservationQuery(msg)) return "milkcare_reservation";
    if (/受付|再来機|待合|予約当日|来院後/.test(msg)) {
      return "milkcare_reception";
    }
    if (/料金|費用|いくら|値段|価格/.test(msg)) return "milkcare_price";
    if (/何曜日|曜日|いつ受け|実施日/.test(msg)) return "milkcare_schedule";
    return "milkcare_overview";
  }

  // 産後ケア全般
  if (isPostpartumCareQuery(msg)) return "postpartum_care";

  // 入院中の食事全般（お祝いディナーより先）
  if (isHospitalMealsQuery(msg)) return "hospital_meals";
  if (isCelebrationDinnerAllergyQuery(msg)) return "meal_allergy";
  if (isCelebrationDinnerFoodRequestQuery(msg)) return "meal_customization";

  // 明示参照は最優先
  if (/さっきの.{0,12}(?:逆子|さかご|骨盤位)|(?:逆子|さかご).{0,8}話/.test(msg)) {
    return "breech_presentation_consultation";
  }
  if (/さっきの.{0,12}(?:体重|BMI)|(?:体重|BMI).{0,8}話/.test(msg)) {
    return "pregnancy_weight_management";
  }
  if (/さっきの.{0,12}陣痛|陣痛.{0,8}話/.test(msg)) {
    return "labor_hospital_contact";
  }

  // キッズルーム等の施設（産科緊急と混同しにくい）
  if (isKidsRoomQuery(msg)) return "kids_room";

  // 里帰り出産（妊婦健診一般・分娩予約一般より先）
  if (isHomecomingDeliveryQuery(msg)) return "homecoming_delivery";

  // 初診料（他料金より先）
  if (isFirstVisitFeeQuery(msg)) return "first_visit_fee";

  // 4D超音波撮影（通常エコーより先）
  if (isFourDUltrasoundQuery(msg)) return "four_d_ultrasound";

  // 女性医師・指名
  if (isFemaleDoctorQuery(msg) || isMaleDoctorQuery(msg)) return "female_doctor";

  // ニューボーン＆マタニティフォト
  if (isNewbornMaternityPhotoQuery(msg)) return "newborn_maternity_photo";

  // 交通アクセス・最寄駅・駐車場
  if (isClinicAccessQuery(msg)) return "clinic_access";

  // 院内施設・入院部屋（未確認設備の推測禁止）
  if (isClinicFacilitiesQuery(msg)) return "clinic_facilities";

  // 産前産後教室（体重管理より先）
  if (isPrenatalClassesQuery(msg)) return "prenatal_classes";

  // 診療時間・休診日
  if (isClinicHoursQuery(msg)) return "clinic_hours";

  // 子宮頸がんワクチン／検診（共通語だけでまとめない）
  if (isHpvVaccineVsScreeningQuery(msg)) return "cervical_cancer_screening";
  if (isHpvVaccineQuery(msg)) return "hpv_vaccination";
  if (isCervicalCancerScreeningQuery(msg)) return "cervical_cancer_screening";

  // 緊急の病院連絡（電話番号案内可）
  if (isUrgentContactQuery(msg)) return "urgent_clinic_contact";

  // 予約方法一般・電話番号（サービス別予約より後・母乳ケア/夜診は先に判定済み）
  if (isAppointmentGuidanceQuery(msg)) {
    if (isPhoneNumberQuery(msg)) return "clinic_phone_number";
    if (/初診|初めて受診|初めて来院/.test(msg)) return "first_visit_reservation";
    return "reservation_method_guidance";
  }

  // 夜診予約（予約方法一般より後でも可。明示夜診はここでも拾う）
  if (isEveningConsultationReservationQuery(msg)) {
    return "reservation_availability";
  }

  // 分娩費用
  if (isBirthPricingQuery(msg)) {
    return detectBirthPricingIntent(msg) || "birth_pricing_overview";
  }

  // 骨盤位キーワードが最新文にある
  if (mentionsBreechTopic(msg)) return "breech_presentation_consultation";

  // 体重（太り・何キロ等）。陣痛・破水が同居する場合は産科緊急優先
  if (
    mentionsPregnancyWeightTopic(msg) &&
    isPregnancyWeightQuery(msg, "") &&
    !/陣痛|破水/.test(msg)
  ) {
    return "pregnancy_weight_management";
  }

  // 陣痛・破水・胎動・出血など（最新文にトピックがある場合のみ）
  if (mentionsLaborContactTopic(msg) && isLaborHospitalContactQuery(msg, "")) {
    return "labor_hospital_contact";
  }

  // 妊娠中の勤務調整・書類（つわりセルフケアより先）
  if (isPregnancyWorkDocumentQuery(msg)) {
    return "pregnancy_work_accommodation_document";
  }

  // つわり
  if (isMorningSicknessQuery(msg, "")) return "morning_sickness_consultation";

  // 葉酸 / 服薬
  if (isPregnancyFolicAcidQuery(msg)) return "pregnancy_folic_acid";
  if (isBreastfeedingMedicationQuery(msg)) {
    return "breastfeeding_medication_consultation";
  }
  if (isPregnancyMedicationQuery(msg, "")) {
    return "pregnancy_medication_consultation";
  }

  return null;
}

/**
 * @param {string} msg
 * @param {TopicIntent} previousIntent
 */
export function isFollowUpForIntent(msg, previousIntent) {
  const m = String(msg || "").trim();
  if (!m || !previousIntent) return false;

  if (previousIntent === "pregnancy_weight_management") {
    return (
      (/^\s*(?:BMI\s*)?\d{1,2}(?:\.\d+)?\s*(?:です|でした)?\s*$/i.test(m) ||
        /BMI|身長|妊娠前|普通体重|低体重|肥満/.test(m) ||
        /(?:kg|キロ|ｃｍ|cm)/i.test(m)) &&
      m.length <= 50 &&
      !mentionsLaborContactTopic(m) &&
      !mentionsBreechTopic(m)
    );
  }

  if (previousIntent === "breech_presentation_consultation") {
    return (
      /(?:妊娠)?\d{1,2}\s*週|何週|体操|外回転|帝王切開|自然分娩|治ら/.test(m) &&
      m.length <= 50 &&
      !mentionsPregnancyWeightTopic(m) &&
      !isBirthPricingQuery(m) &&
      !isKidsRoomQuery(m)
    );
  }

  if (previousIntent === "labor_hospital_contact") {
    return (
      (/初産|経産|初めて|2人目|3人目|一人目|\d+\s*分\s*(?:間隔|おき)|間隔です/.test(
        m
      ) ||
        isHesitationOrFearMessage(m)) &&
      m.length <= 60 &&
      !mentionsPregnancyWeightTopic(m) &&
      !mentionsBreechTopic(m) &&
      !isKidsRoomQuery(m) &&
      !isBirthPricingQuery(m)
    );
  }

  if (previousIntent === "morning_sickness_consultation") {
    return (
      /(?:水|水分|飲め|食べ|吐|におい|便秘|休め|いつまで)/.test(m) &&
      m.length <= 50 &&
      !isBirthPricingQuery(m)
    );
  }

  return false;
}

/**
 * @param {string} msg
 */
export function isHesitationOrFearMessage(msg) {
  return /怖い|不安|行けない|行きたくない|迷って|どうしよう|でも.{0,8}(?:病院|行く|連絡)/.test(
    String(msg || "")
  );
}

/**
 * 直前ユーザー発話が緊急産科症状か
 * @param {string} text
 */
export function isObstetricUrgentUserText(text) {
  const t = String(text || "");
  return (
    /破水|胎動が(?:少|ない|減)|胎動減少|大量出血|出血が多|生理以上|意識がもうろう|呼吸困難/.test(
      t
    )
  );
}

/**
 * @param {string} userMessage
 * @param {Array<{role?:string,content?:string}>} safeHistory
 */
export function isContinuingUrgentContext(userMessage, safeHistory) {
  const msg = String(userMessage || "").trim();
  const lastUser = getLastUserMessage(safeHistory);
  if (!lastUser || !isObstetricUrgentUserText(lastUser)) return false;
  // 新しい明確な別話題なら継続しない
  const standalone = detectStandaloneIntent(msg);
  if (
    standalone &&
    standalone !== "labor_hospital_contact" &&
    standalone !== "breech_presentation_consultation"
  ) {
    return false;
  }
  // 恐れ・迷い・短い確認は緊急継続
  if (isHesitationOrFearMessage(msg)) return true;
  if (msg.length <= 25 && !detectStandaloneIntent(msg)) return true;
  return false;
}

/**
 * @param {string} userMessage
 * @param {Array<{role?:string,content?:string}>} safeHistory
 */
export function resolveConversationTopic(userMessage, safeHistory = []) {
  const msg = String(userMessage || "").trim();
  const previousUser = getLastUserMessage(safeHistory);
  const previousIntent = previousUser
    ? detectStandaloneIntent(previousUser)
    : null;

  // 緊急症状の継続（破水のあと「怖い」など）
  if (isContinuingUrgentContext(msg, safeHistory)) {
    const urgentIntent = previousIntent || "labor_hospital_contact";
    return {
      latestUserMessage: msg,
      previousIntent,
      detectedIntent: urgentIntent,
      isTopicChange: false,
      continuingUrgent: true,
      useHistory: true,
    };
  }

  // 最新メッセージ単体の意図を最優先
  const standalone = detectStandaloneIntent(msg);
  if (standalone) {
    return {
      latestUserMessage: msg,
      previousIntent,
      detectedIntent: standalone,
      isTopicChange: Boolean(
        previousIntent && previousIntent !== standalone
      ),
      continuingUrgent: false,
      useHistory: previousIntent === standalone,
    };
  }

  // 同一話題のフォローアップ
  if (previousIntent && isFollowUpForIntent(msg, previousIntent)) {
    return {
      latestUserMessage: msg,
      previousIntent,
      detectedIntent: previousIntent,
      isTopicChange: false,
      continuingUrgent: false,
      useHistory: true,
    };
  }

  // モジュール側の文脈フォロー（厳格化した各 is*Query に委譲）
  if (isBreechPresentationQuery(msg, userTurnsText(safeHistory, msg))) {
    return {
      latestUserMessage: msg,
      previousIntent,
      detectedIntent: "breech_presentation_consultation",
      isTopicChange: previousIntent !== "breech_presentation_consultation",
      continuingUrgent: false,
      useHistory: true,
    };
  }
  if (isPregnancyWeightQuery(msg, userTurnsText(safeHistory, msg))) {
    return {
      latestUserMessage: msg,
      previousIntent,
      detectedIntent: "pregnancy_weight_management",
      isTopicChange: previousIntent !== "pregnancy_weight_management",
      continuingUrgent: false,
      useHistory: true,
    };
  }
  if (isLaborHospitalContactQuery(msg, userTurnsText(safeHistory, msg))) {
    return {
      latestUserMessage: msg,
      previousIntent,
      detectedIntent: "labor_hospital_contact",
      isTopicChange: previousIntent !== "labor_hospital_contact",
      continuingUrgent: false,
      useHistory: true,
    };
  }

  return {
    latestUserMessage: msg,
    previousIntent,
    detectedIntent: null,
    isTopicChange: Boolean(previousIntent),
    continuingUrgent: false,
    useHistory: false,
  };
}

/**
 * 回答が意図と明らかに食い違う場合 false
 * @param {string} answer
 * @param {TopicIntent} intent
 * @param {string} userMessage
 */
export function answerMatchesIntent(answer, intent, userMessage) {
  const a = String(answer || "");
  const msg = String(userMessage || "");
  if (!intent || !a) return true;

  // 緊急案内は削除しない
  if (
    /すぐに(?:当院へ)?お電話|今すぐお電話|119|破水したかもしれない/.test(a) &&
    /破水|出血|胎動|意識|息苦/.test(msg + a)
  ) {
    return true;
  }

  if (intent === "pregnancy_weight_management") {
    if (
      /陣痛が\d+分間隔|連絡の目安に達して|初産婦は10分|経産婦は15分/.test(a) &&
      !/体重|BMI|キロ|太/.test(a)
    ) {
      return false;
    }
  }

  if (intent === "labor_hospital_contact") {
    if (
      /体重増加の目安|BMI18\.5|ダイエット/.test(a) &&
      !/陣痛|破水|連絡|入院/.test(a)
    ) {
      return false;
    }
  }

  if (intent === "breech_presentation_consultation") {
    if (
      /陣痛が\d+分間隔|体重増加の目安|分娩予約金/.test(a) &&
      !/さかご|逆子|骨盤位|外回転/.test(a)
    ) {
      return false;
    }
  }

  if (
    intent === "birth_reservation_deposit" ||
    intent === "birth_pricing_overview" ||
    String(intent).startsWith("birth_")
  ) {
    if (/陣痛が\d+分|さかご|つわりが辛い/.test(a) && !/予約金|費用|円/.test(a)) {
      return false;
    }
  }

  if (intent === "kids_room") {
    if (/陣痛|体重増加|さかご|つわり/.test(a) && !/キッズ|お子さま|お子様/.test(a)) {
      return false;
    }
  }

  return true;
}

/**
 * clinic-knowledge id の目安
 * @param {TopicIntent} intent
 */
export function clinicKnowledgeIdForIntent(intent) {
  const map = {
    labor_hospital_contact: "labor-hospital-contact-timing",
    pregnancy_weight_management: "pregnancy-weight-gain",
    breech_presentation_consultation: "pregnancy-breech-presentation",
    morning_sickness_consultation: "pregnancy-morning-sickness",
    pregnancy_work_accommodation_document:
      "pregnancy-work-accommodation-document",
    patient_complaint: "patient-complaint",
    postpartum_care: "postpartum-care",
    hospital_meals: "hospital-meal-preferences",
    meal_customization: "celebration-dinner-food-request",
    meal_allergy: "celebration-dinner-allergy",
    pregnancy_medication_consultation: "pregnancy-medication-consultation",
    pregnancy_folic_acid: "pregnancy-folic-acid",
    homecoming_delivery: "obstetrics-homecoming-delivery",
    first_visit_fee: "clinic-first-visit-fee",
    four_d_ultrasound: "obstetrics-4d-ultrasound",
    female_doctor: "clinic-female-doctor",
    newborn_maternity_photo: "newborn-maternity-photo",
    milkcare_reservation: "postpartum-milkcare-reservation",
    milkcare_reception: "postpartum-milkcare-reservation",
    milkcare_schedule: "postpartum-milkcare-reservation",
    milkcare_price: "postpartum-milkcare-reservation",
    milkcare_overview: "postpartum-milkcare-reservation",
    clinic_facilities: "clinic-facilities",
    clinic_access: "clinic-access",
    prenatal_classes: "prenatal-classes",
    clinic_hours: "clinic-consultation-hours",
    hpv_vaccination: "cervical-cancer-hpv-vaccine",
    cervical_cancer_screening: "cervical-cancer-screening",
    reservation_method_guidance: "appointment-guidance",
    first_visit_reservation: "appointment-guidance",
    clinic_phone_number: "appointment-guidance",
    urgent_clinic_contact: "appointment-guidance",
    birth_reservation_deposit: "birth-reservation-deposit",
    kids_room: null,
  };
  return map[intent] ?? null;
}
