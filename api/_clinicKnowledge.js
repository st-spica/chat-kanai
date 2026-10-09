/**
 * 院内登録情報（clinic-knowledge）
 *
 * - 公式サイト未掲載でも、病院が明示登録した確定情報をチャットで案内する
 * - 既定: data/clinic-knowledge.json を読み込む
 * - CLINIC_KNOWLEDGE_URL があれば HTTP GET で取得（将来の WP 管理画面連携用）
 * - 緊急判定・医療診断を上書きしない（呼び出し側で緊急を先に処理すること）
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  detectClinicService,
  detectVaccinationAudience,
  isAttendFocusedMessage,
  isBabyIllnessConsultMessage,
  isAbortionQuery,
  isCelebrationDinnerAllergyQuery,
  isCelebrationDinnerFoodRequestQuery,
  isChildVaccinationQuery,
  isDailyBabyCareConsultMessage,
  detectInfantAgeMonths,
  isGenderSelectionQuery,
  isGynecologicExamConsultQuery,
  isGynecologicMedicationQuery,
  isGynecologicSurgeryQuery,
  isGynecologyUltrasoundFrequencyQuery,
  isFeeFocusedMessage,
  isAdvancedInfertilityQuery,
  isChildAccompaniedVisitQuery,
  isChildcareRequestQuery,
  isChildPatientExamQuery,
  isEveningConsultationHoursQuery,
  isEveningConsultationReservationQuery,
  isHospitalBagQuery,
  isInfertilityConsultationQuery,
  isInfertilityScheduleQuery,
  isKidsRoomQuery,
  isMotherDistressConsultMessage,
  isNonChildbirthBelongingsQuery,
  isPhotoRecordingFocusedMessage,
  isPrenatalUltrasoundFrequencyQuery,
  isVisitFocusedMessage,
  isVisitationIntentMessage,
  resolveBabyCareGuidanceRoute,
  QUERY_NORMALIZERS,
} from "../data/site-route-map.js";
import { isClinicHoursQuery } from "../data/clinic-hours.js";
import {
  buildBirthPricingAnswer,
  detectBirthPricingIntent,
  isBirthPricingQuery,
  isPostpartumCareFeeQuery,
} from "../data/birth-pricing.js";
import { isMorningSicknessQuery } from "../data/morning-sickness.js";
import {
  isBreastfeedingMedicationQuery,
  isPregnancyFolicAcidQuery,
  isPregnancyMedicationQuery,
} from "../data/pregnancy-medication.js";
import { isBreechPresentationQuery } from "../data/pregnancy-breech.js";
import { isPregnancyWeightQuery } from "../data/pregnancy-weight.js";
import { isLaborHospitalContactQuery } from "../data/labor-contact.js";
import { isHomecomingDeliveryQuery } from "../data/homecoming-delivery.js";
import { isFirstVisitFeeQuery } from "../data/first-visit-fee.js";
import { isFourDUltrasoundQuery } from "../data/four-d-ultrasound.js";
import {
  isFemaleDoctorQuery,
  isMaleDoctorQuery,
} from "../data/female-doctor.js";
import { isNewbornMaternityPhotoQuery } from "../data/newborn-maternity-photo.js";
import {
  isMilkcareQuery,
  isMilkcareReservationQuery,
} from "../data/milkcare.js";
import { isClinicFacilitiesQuery } from "../data/clinic-facilities.js";
import { isPrenatalClassesQuery } from "../data/prenatal-classes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_JSON_PATH = join(__dirname, "../data/clinic-knowledge.json");

const TOP_ITEMS = Math.min(
  5,
  Math.max(1, parseInt(process.env.CLINIC_KNOWLEDGE_TOP_ITEMS || "2", 10))
);
/** このスコア未満は GPT に渡さない */
const MIN_PASS_SCORE = Math.max(
  1,
  parseInt(process.env.CLINIC_KNOWLEDGE_MIN_SCORE || "40", 10)
);
/** これ以上なら「clinic-knowledgeだけで十分回答可能」とみなし、サイト投稿チップを抑制 */
export const CLINIC_KNOWLEDGE_STRONG_SCORE = Math.max(
  MIN_PASS_SCORE,
  parseInt(process.env.CLINIC_KNOWLEDGE_STRONG_SCORE || "80", 10)
);
const CACHE_TTL_MS = Math.max(
  0,
  parseInt(process.env.CLINIC_KNOWLEDGE_TTL_MS || String(5 * 60 * 1000), 10)
);

/**
 * @typedef {{
 *   id: string,
 *   category: string,
 *   intent?: string|null,
 *   service?: string|null,
 *   questionPatterns: string[],
 *   keywords: string[],
 *   answer: string,
 *   priority: number,
 *   updatedAt: string,
 *   enabled: boolean,
 *   relatedSiteUrl?: string,
 *   availability?: "available"|"unavailable"|"unknown"|"limited"|null,
 * }} ClinicKnowledgeItem
 */

/** @param {any} raw */
function normalizeAvailability(raw) {
  const v = String(raw?.availability ?? "").trim().toLowerCase();
  if (
    v === "available" ||
    v === "unavailable" ||
    v === "unknown" ||
    v === "limited" ||
    v === "information"
  ) {
    return v;
  }
  // 回答文からのゆるい推定（明示フィールドが無い既存JSON向け）
  const ans = String(raw?.answer || "");
  if (/行っておりません|実施していません|対応していません|ご用意がありません|行っていません/.test(ans)) {
    return "unavailable";
  }
  if (/のみ対応|限定|一般不妊相談に対応/.test(ans)) {
    return "limited";
  }
  if (/対応しています|行っています|ご利用いただけます|ご招待いただけます|処方は可能|可能です|できます/.test(ans)) {
    return "available";
  }
  return null;
}

/** @typedef {{ item: ClinicKnowledgeItem, score: number, reasons: string[] }} ClinicKnowledgeHit */
/** @typedef {{ id: string, intent?: string|null, score: number, reason: string }} ClinicKnowledgeRejection */

/** 予約系 intent（キーワード一致だけでは採用しない） */
export const RESERVATION_INTENTS = new Set([
  "reservation_availability",
  "web_reservation_availability",
  "reservation_change",
  "reservation_cancel",
  "first_visit_reservation",
  "revisit_reservation",
  "class_reservation",
]);

/** intent 不一致時に除外する（誤適用防止） */
export const STRICT_MATCH_INTENTS = new Set([
  ...RESERVATION_INTENTS,
  "baby_care_consultation",
  "vaccination_availability",
  "service_availability",
  "meal_customization",
  "meal_allergy",
  "childbirth_bonus_dinner",
  "ultrasound_frequency",
  "hospital_bag",
  "child_accompanied_visit",
  "infertility_consultation",
  "morning_sickness_consultation",
  "pregnancy_medication_consultation",
  "pregnancy_folic_acid",
  "breech_presentation_consultation",
  "pregnancy_weight_management",
  "labor_hospital_contact",
  "homecoming_delivery",
  "first_visit_fee",
  "four_d_ultrasound",
  "female_doctor",
  "newborn_maternity_photo",
  "milkcare_reservation",
  "milkcare_reception",
  "milkcare_schedule",
  "milkcare_price",
  "milkcare_overview",
  "clinic_facilities",
  "prenatal_classes",
  "birth_reservation_deposit",
  "birth_advance_payment",
  "birth_hospitalization_cost",
  "birth_cost_discount",
  "birth_pricing_overview",
]);

let memoryCache = {
  at: 0,
  /** @type {ClinicKnowledgeItem[]} */
  items: [],
  version: null,
  source: "none",
  error: null,
};

/**
 * 生JSON/配列を正規化（旧形式 question/url も吸収）
 * @param {any} raw
 * @returns {{ items: ClinicKnowledgeItem[], version: any, error: string|null }}
 */
export function normalizeClinicKnowledgePayload(raw) {
  try {
    const list = Array.isArray(raw) ? raw : raw?.items;
    if (!Array.isArray(list)) {
      return { items: [], version: null, error: "items 配列がありません" };
    }
    /** @type {ClinicKnowledgeItem[]} */
    const items = [];
    for (let i = 0; i < list.length; i++) {
      const n = normalizeOneItem(list[i], i);
      if (n) items.push(n);
    }
    return {
      items,
      version: Array.isArray(raw) ? 1 : raw?.version ?? null,
      error: items.length ? null : "有効な項目がありません",
    };
  } catch (e) {
    return { items: [], version: null, error: e?.message || String(e) };
  }
}

/**
 * @param {any} raw
 * @param {number} index
 * @returns {ClinicKnowledgeItem|null}
 */
function normalizeOneItem(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.enabled === false || raw.enabled === "false" || raw.enabled === 0) {
    // enabled=false は検索対象外（リストにも載せない）
    return null;
  }

  const answer = String(raw.answer ?? "").trim();
  if (!answer) return null;

  let questionPatterns = Array.isArray(raw.questionPatterns)
    ? raw.questionPatterns.map((p) => String(p || "").trim()).filter(Boolean)
    : [];
  // 旧形式互換
  if (!questionPatterns.length && raw.question) {
    questionPatterns = String(raw.question)
      .split(/[／/]/)
      .map((p) => p.trim())
      .filter(Boolean);
  }
  if (!questionPatterns.length) return null;

  let keywords = Array.isArray(raw.keywords)
    ? raw.keywords.map((k) => String(k || "").trim()).filter(Boolean)
    : [];
  if (!keywords.length) {
    keywords = inferKeywords(questionPatterns.join(" "), answer);
  }

  const id =
    String(raw.id || "").trim() ||
    `item-${String(index + 1).padStart(3, "0")}`;
  const category = String(raw.category ?? "").trim() || "other";
  const intentRaw = String(raw.intent || "").trim();
  const intent = intentRaw || inferItemIntent(id, category, questionPatterns);
  const serviceRaw = String(raw.service || "").trim();
  const service =
    serviceRaw ||
    inferItemService(id, category, questionPatterns, relatedSiteUrlHint(raw));
  const priority = Number.isFinite(Number(raw.priority))
    ? Number(raw.priority)
    : 50;
  const updatedAt = String(raw.updatedAt || raw.updated_at || "").trim() || "";
  const relatedSiteUrl = String(
    raw.relatedSiteUrl || raw.url || ""
  ).trim();

  /** @type {ClinicKnowledgeItem} */
  const item = {
    id,
    category,
    intent,
    service,
    questionPatterns,
    keywords,
    answer,
    priority,
    updatedAt,
    enabled: true,
  };
  if (relatedSiteUrl) item.relatedSiteUrl = relatedSiteUrl;
  const availability = normalizeAvailability(raw);
  if (availability) item.availability = availability;
  return item;
}

function relatedSiteUrlHint(raw) {
  return String(raw?.relatedSiteUrl || raw?.url || "").trim();
}

/**
 * @param {string} id
 * @param {string} category
 * @param {string[]} patterns
 * @param {string} relatedUrl
 */
function inferItemService(id, category, patterns, relatedUrl) {
  const hay = `${id}\n${category}\n${(patterns || []).join("\n")}\n${relatedUrl}`.toLowerCase();
  if (/postpartum|産後ケア|aftersupport|aftercare/.test(hay)) {
    return "postpartum_care";
  }
  if (/hospitalization|#visit|産科入院|入院中/.test(hay)) {
    return "obstetric_hospitalization";
  }
  if (/gynecology|婦人科/.test(hay)) return "gynecology";
  if (/lesson|教室/.test(hay)) return "prenatal_postnatal_class";
  if (
    /celebration_dinner|お祝いディナー|meal_customization|meal_allergy|childbirth_bonus_dinner/.test(
      hay
    )
  ) {
    return "celebration_dinner";
  }
  if (
    /ultrasound_frequency|prenatal-checkup-ultrasound|prenatal_checkup/.test(hay)
  ) {
    return "prenatal_checkup";
  }
  if (
    /hospital_bag|childbirth-hospital-bag|入院時の持ち物|hos_bring/.test(hay)
  ) {
    return "childbirth_hospitalization";
  }
  if (
    /evening_consultation|evening-consultation|夜診/.test(hay)
  ) {
    return "evening_consultation";
  }
  if (/assist_birth|立ち会い|分娩|rsv_bonus|childbirth/.test(hay)) {
    return "delivery";
  }
  if (/beginner|外来|初診|再診|outpatient|reception/.test(hay)) {
    return "outpatient";
  }
  return null;
}

/**
 * @param {string} id
 * @param {string} category
 * @param {string[]} patterns
 */
function inferItemIntent(id, category, patterns) {
  const hay = `${id}\n${category}\n${(patterns || []).join("\n")}`.toLowerCase();
  if (/reservation_cancel|キャンセル/.test(hay) && /予約|reservation/.test(hay)) {
    return "reservation_cancel";
  }
  if (/reservation_change|予約変更|変更したい/.test(hay)) {
    return "reservation_change";
  }
  if (/web_reservation|web予約|ウェブ予約/.test(hay)) {
    return "web_reservation_availability";
  }
  if (/first_visit|初診/.test(hay) && /予約|reservation/.test(hay)) {
    return "first_visit_reservation";
  }
  if (/revisit|再診/.test(hay) && /予約|reservation/.test(hay)) {
    return "revisit_reservation";
  }
  if (/class_reservation|教室/.test(hay) && /予約|reservation/.test(hay)) {
    return "class_reservation";
  }
  if (/reception-001|当日予約|reservation_availability/.test(hay)) {
    return "reservation_availability";
  }
  if (/meal_allergy|アレルギー/.test(hay) && /ディナー|食事|レストラン/.test(hay)) {
    return "meal_allergy";
  }
  if (
    /meal_customization|苦手|好き嫌い|メニュー変更|食材変更/.test(hay) &&
    /ディナー|食事|お祝い/.test(hay)
  ) {
    return "meal_customization";
  }
  if (/ultrasound_frequency|エコー|超音波/.test(hay) && /毎回|胎嚢|妊婦健診/.test(hay)) {
    return "ultrasound_frequency";
  }
  if (/hospital_bag|持ち物|入院バッグ|陣痛バッグ|hos_bring/.test(hay)) {
    return "hospital_bag";
  }
  if (/childbirth_bonus_dinner|お祝いディナー|ディナーご招待/.test(hay)) {
    return "childbirth_bonus_dinner";
  }
  if (/photo_recording|撮影|録音|notpermit|other-081/.test(hay)) {
    return "photo_recording_policy";
  }
  return null;
}

function inferKeywords(question, answer) {
  const text = `${question}\n${answer}`;
  const base = [
    "駐車場",
    "駐車",
    "面会",
    "立ち会い",
    "持ち物",
    "予約",
    "キャンセル",
    "入院",
    "個室",
    "ワクチン",
    "ピル",
    "休診",
    "診療時間",
    "クレジット",
    "予納",
    "里帰り",
    "産後",
    "母乳",
  ];
  return base.filter((k) => text.includes(k)).slice(0, 10);
}

/**
 * データ取得（差し替えポイント）
 * - CLINIC_KNOWLEDGE_URL: WordPress 等の API
 * - それ以外: ローカル JSON
 * @param {{ forceRefresh?: boolean }} [opts]
 */
export async function loadClinicKnowledgeSource(opts = {}) {
  const now = Date.now();
  if (
    !opts.forceRefresh &&
    CACHE_TTL_MS > 0 &&
    memoryCache.items.length &&
    now - memoryCache.at < CACHE_TTL_MS
  ) {
    return {
      items: memoryCache.items,
      version: memoryCache.version,
      source: memoryCache.source,
      error: memoryCache.error,
      fromCache: true,
    };
  }

  const remoteUrl = String(process.env.CLINIC_KNOWLEDGE_URL || "").trim();
  let payload = null;
  let source = "file";
  let error = null;

  if (remoteUrl) {
    source = "remote";
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 8000);
      const res = await fetch(remoteUrl, {
        signal: ac.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      payload = await res.json();
    } catch (e) {
      error = `remote_fetch_failed: ${e?.message || e}`;
      console.error("clinic-knowledge remote load failed:", error);
      // リモート失敗時はローカルへフォールバック
      source = "file_fallback";
    }
  }

  if (!payload) {
    try {
      const path = String(process.env.CLINIC_KNOWLEDGE_PATH || DEFAULT_JSON_PATH);
      payload = JSON.parse(readFileSync(path, "utf-8"));
      if (source !== "file_fallback") source = "file";
    } catch (e) {
      error = e?.message || String(e);
      console.error("clinic-knowledge file load failed:", error);
      memoryCache = { at: now, items: [], version: null, source, error };
      return { items: [], version: null, source, error, fromCache: false };
    }
  }

  const normalized = normalizeClinicKnowledgePayload(payload);
  memoryCache = {
    at: now,
    items: normalized.items,
    version: normalized.version,
    source,
    error: normalized.error || error,
  };
  return {
    items: memoryCache.items,
    version: memoryCache.version,
    source: memoryCache.source,
    error: memoryCache.error,
    fromCache: false,
  };
}

/** 同期アクセス用（起動時プリロード兼用） */
function getCachedItemsSync() {
  if (memoryCache.items.length) return memoryCache.items;
  try {
    const path = String(process.env.CLINIC_KNOWLEDGE_PATH || DEFAULT_JSON_PATH);
    const payload = JSON.parse(readFileSync(path, "utf-8"));
    const normalized = normalizeClinicKnowledgePayload(payload);
    memoryCache = {
      at: Date.now(),
      items: normalized.items,
      version: normalized.version,
      source: "file",
      error: normalized.error,
    };
  } catch (e) {
    memoryCache = {
      at: Date.now(),
      items: [],
      version: null,
      source: "file",
      error: e?.message || String(e),
    };
  }
  return memoryCache.items;
}

// コールドスタート用に同期プリロード
getCachedItemsSync();

function normalizeQueryText(text) {
  return String(text || "")
    .trim()
    .replace(/[？?！!。．、,…〜~･・]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 予約系の表記ゆれ・否定疑問を正規化（意味は「可否を問う」）
 * @param {string} userMessage
 */
export function normalizeReservationQuery(userMessage) {
  let s = String(userMessage || "").trim();
  s = s.replace(/ウェブ予約|ネット予約|オンライン予約/gi, "WEB予約");
  s = s.replace(/ウェブで予約|ネットで予約|オンラインで予約/gi, "WEBで予約");
  // 否定疑問も「できますか」と同じ意図へ
  s = s.replace(
    /WEB(?:で)?予約(?:は)?(?:できませんか|できないの|できないですか|できないでしょうか|できないよね|できないんだっけ)/g,
    "WEB予約はできますか"
  );
  s = s.replace(/WEB(?:で)?予約(?:は)?できますか/g, "WEB予約はできますか");
  s = s.replace(/WEB予約(?:は)?可能ですか/g, "WEB予約はできますか");
  return normalizeQueryText(s);
}

/**
 * 質問の clinic intent を推定（予約系を優先分離）
 * @param {string} userMessage
 * @returns {string|null}
 */
export function detectClinicIntent(userMessage) {
  const raw = String(userMessage || "").trim();
  if (!raw) return null;
  const msg = normalizeReservationQuery(raw);
  const hasReserve = /予約/.test(msg);
  const hasWeb = /WEB|ウェブ|ネット|オンライン/i.test(msg);
  const hasChange = /変更/.test(msg);
  const hasCancel = /キャンセル|取り消|取消/.test(msg);

  // 院内撮影・録音の可否（立ち会い等の状況語より優先）
  if (isPhotoRecordingFocusedMessage(msg)) {
    return "photo_recording_policy";
  }

  // お子さまの予防接種（未実施）／予防接種の可否
  if (isChildVaccinationQuery(msg) || detectVaccinationAudience(msg)) {
    return "vaccination_availability";
  }

  // お子さま同伴・キッズルーム（託児・本人診察とは分離）
  if (isChildAccompaniedVisitQuery(msg) || isKidsRoomQuery(msg)) {
    return "child_accompanied_visit";
  }

  // 一般不妊相談（診療時間・高度生殖医療の可否断定と分離）
  if (isInfertilityConsultationQuery(msg) || isAdvancedInfertilityQuery(msg)) {
    return "infertility_consultation";
  }

  // つわり相談（診断断定なし・セルフケア／受診案内）
  if (isMorningSicknessQuery(msg)) {
    return "morning_sickness_consultation";
  }

  // 骨盤位（さかご）。帝王切開の一般相談と混同しない
  if (isBreechPresentationQuery(msg)) {
    return "breech_presentation_consultation";
  }

  // 産前産後教室（体重管理より先。教室名を体重トピックに流さない）
  if (isPrenatalClassesQuery(msg)) {
    return "prenatal_classes";
  }

  // 妊娠中の体重管理（つわり主体・一般ダイエットと混同しない）
  if (isPregnancyWeightQuery(msg)) {
    return "pregnancy_weight_management";
  }

  // 陣痛の病院連絡タイミング（破水・出血・胎動減少は連絡優先）
  if (isLaborHospitalContactQuery(msg)) {
    return "labor_hospital_contact";
  }

  // 里帰り出産（妊婦健診一般と混同しない）
  if (isHomecomingDeliveryQuery(msg)) {
    return "homecoming_delivery";
  }

  // 初診料（文書料3,300円・他料金と混同しない）
  if (isFirstVisitFeeQuery(msg)) {
    return "first_visit_fee";
  }

  // 4D超音波撮影（通常エコー・未実施推測と混同しない）
  if (isFourDUltrasoundQuery(msg)) {
    return "four_d_ultrasound";
  }

  // 女性医師・医師指名（診療体制表へ。曜日はハードコードしない）
  if (isFemaleDoctorQuery(msg) || isMaleDoctorQuery(msg)) {
    return "female_doctor";
  }

  // ニューボーン＆マタニティフォト（外部紹介・固定回答）
  if (isNewbornMaternityPhotoQuery(msg)) {
    return "newborn_maternity_photo";
  }

  // 母乳ケア（予約方法と来院後受付・他診療WEB予約と混同しない）
  if (isMilkcareQuery(msg)) {
    if (isMilkcareReservationQuery(msg)) return "milkcare_reservation";
    if (/受付|再来機|待合|予約当日|来院後/.test(msg)) {
      return "milkcare_reception";
    }
    if (/料金|費用|いくら|値段|価格/.test(msg)) return "milkcare_price";
    if (/何曜日|曜日|いつ受け|実施日/.test(msg)) return "milkcare_schedule";
    return "milkcare_overview";
  }

  // 院内施設・入院部屋（未確認設備の推測禁止）
  if (isClinicFacilitiesQuery(msg)) {
    return "clinic_facilities";
  }

  // 葉酸 / 妊娠中の服薬 / 授乳中の服薬（混同禁止）
  if (isPregnancyFolicAcidQuery(msg)) {
    return "pregnancy_folic_acid";
  }
  if (isBreastfeedingMedicationQuery(msg)) {
    return "breastfeeding_medication_consultation";
  }
  if (isPregnancyMedicationQuery(msg)) {
    return "pregnancy_medication_consultation";
  }

  // 分娩料金（予約金・予納金・入院費・割引）。産後ケア料金は含めない
  {
    const birthIntent = detectBirthPricingIntent(msg);
    if (birthIntent) return birthIntent;
  }

  // 産み分け（未実施）
  if (isGenderSelectionQuery(msg)) {
    return "service_availability";
  }

  // 婦人科手術／診察／処方の可否
  if (
    isGynecologicSurgeryQuery(msg) ||
    isGynecologicExamConsultQuery(msg) ||
    isGynecologicMedicationQuery(msg)
  ) {
    return "service_availability";
  }

  // 日常的な育児相談（体調・母親の限界は別扱い。緊急は呼び出し側で先に処理）
  if (isDailyBabyCareConsultMessage(msg)) {
    return "baby_care_consultation";
  }

  // 分娩入院の持ち物
  if (isHospitalBagQuery(msg)) {
    return "hospital_bag";
  }

  // 夜診の予約可否（時間のみの質問は含めない）
  if (isEveningConsultationReservationQuery(msg)) {
    return "reservation_availability";
  }

  // 妊婦健診のエコー頻度（婦人科エコーは流用しない）
  if (isPrenatalUltrasoundFrequencyQuery(msg)) {
    return "ultrasound_frequency";
  }

  // 面会（サービスは detectClinicService で別判定）
  if (isVisitationIntentMessage(msg)) {
    return "visitation";
  }

  // お祝いディナー：アレルギー／食材変更／家族招待を分離
  if (isCelebrationDinnerAllergyQuery(msg)) {
    return "meal_allergy";
  }
  if (isCelebrationDinnerFoodRequestQuery(msg)) {
    return "meal_customization";
  }
  if (
    /お祝いディナー|出産祝いの食事|お祝いの食事/.test(msg) ||
    (/(?:ディナー|食事)/.test(msg) &&
      /(?:家族|夫|旦那|パートナー|招待|呼べ|食べ)/.test(msg)) ||
    /(?:何人|何名).{0,10}招待|招待.{0,10}(?:何人|何名)/.test(msg)
  ) {
    return "childbirth_bonus_dinner";
  }

  // 変更・キャンセルは可否より優先
  if (hasReserve && hasChange) {
    return "reservation_change";
  }
  if (hasReserve && hasCancel) {
    return "reservation_cancel";
  }

  // WEB予約の可否（否定疑問含む）
  if (
    hasWeb &&
    hasReserve &&
    /でき|可能|利用|取れ|取れます|申し込め|申込め/.test(msg)
  ) {
    return "web_reservation_availability";
  }
  if (/^WEB予約はできますか$/.test(msg) || /WEB予約/.test(msg) && /でき|可能/.test(msg)) {
    return "web_reservation_availability";
  }

  if (/産前産後教室|教室/.test(msg) && hasReserve) {
    return "class_reservation";
  }
  if (/初診/.test(msg) && hasReserve) {
    return "first_visit_reservation";
  }
  if (/再診/.test(msg) && hasReserve) {
    return "revisit_reservation";
  }
  if (/(?:当日|今日|本日)/.test(msg) && hasReserve) {
    return "reservation_availability";
  }
  if (hasReserve && /でき|可能|取れ|申し込め|申込め/.test(msg)) {
    return "reservation_availability";
  }
  return null;
}

/**
 * QUERY_NORMALIZERS 等で質問を拡張したマッチ用テキスト
 * @param {string} userMessage
 */
function expandMessageForClinicMatch(userMessage) {
  const msg = normalizeReservationQuery(userMessage);
  const extras = [];
  if (isVisitFocusedMessage(msg)) extras.push("面会", "お見舞い");
  if (isAttendFocusedMessage(msg)) extras.push("立ち会い", "立会い");
  if (isPhotoRecordingFocusedMessage(msg)) {
    extras.push("撮影", "動画", "写真", "録音", "院内撮影禁止");
  }
  if (isFeeFocusedMessage(msg)) extras.push("費用", "料金");
  for (const n of Object.values(QUERY_NORMALIZERS || {})) {
    if (n?.pattern?.test(msg) && n.label) extras.push(n.label);
  }
  if (/駐車|パーキング|車で来|車で行/.test(msg)) extras.push("駐車場", "駐車");
  if (/持ち物|何を持|持参/.test(msg)) extras.push("持ち物");
  return normalizeQueryText(`${msg} ${extras.join(" ")}`);
}

function patternActionTags(text) {
  const t = String(text || "");
  return {
    change: /変更/.test(t),
    cancel: /キャンセル|取り消|取消/.test(t),
    availability: /でき|可能|利用|取れ|取れます|申し込め|申込め|ありますか/.test(t),
  };
}

/**
 * @param {string} userMessage
 * @param {ClinicKnowledgeItem} item
 * @param {{ queryIntent?: string|null }} [opts]
 * @returns {{ score: number, reasons: string[], rejected?: boolean, rejectReason?: string }}
 */
export function scoreClinicKnowledgeItem(userMessage, item, opts = {}) {
  const msg = String(userMessage || "").trim();
  if (!msg || !item?.enabled) {
    return { score: 0, reasons: [], rejected: true, rejectReason: "empty" };
  }

  const queryIntent =
    opts.queryIntent !== undefined ? opts.queryIntent : detectClinicIntent(msg);
  const queryService =
    opts.queryService !== undefined ? opts.queryService : detectClinicService(msg);
  const itemIntent = item.intent || null;
  const itemService = item.service || null;
  const normalizedQuery = normalizeReservationQuery(msg);
  const expanded = expandMessageForClinicMatch(msg);
  const msgNorm = normalizedQuery.toLowerCase();
  const expLower = expanded.toLowerCase();
  const reasons = [];

  // 対象サービス不一致は除外（異なる診療サービスのルール流用防止）
  if (queryService && itemService && queryService !== itemService) {
    return {
      score: 0,
      reasons: [`service不一致:query=${queryService}/item=${itemService}`],
      rejected: true,
      rejectReason: `service不一致(query=${queryService}, item=${itemService})`,
    };
  }

  // intent 不一致は除外（予約系・育児相談など厳格 intent）
  if (
    queryIntent &&
    STRICT_MATCH_INTENTS.has(queryIntent) &&
    itemIntent &&
    STRICT_MATCH_INTENTS.has(itemIntent) &&
    queryIntent !== itemIntent
  ) {
    return {
      score: 0,
      reasons: [`intent不一致:query=${queryIntent}/item=${itemIntent}`],
      rejected: true,
      rejectReason: `intent不一致(query=${queryIntent}, item=${itemIntent})`,
    };
  }
  // 小児予防接種の未実施情報は、子供向け質問以外に流用しない
  if (itemIntent === "vaccination_availability" && itemService === "pediatric_vaccination") {
    if (!isChildVaccinationQuery(msg)) {
      return {
        score: 0,
        reasons: ["小児予防接種未実施:対象者が子供ではない"],
        rejected: true,
        rejectReason: "pediatric_vaccinationは子供向け質問のみ",
      };
    }
  }
  // 産み分け未実施情報は産み分け質問以外に流用しない（性別判明時期などと混同しない）
  if (itemService === "gender_selection" || item.id === "gender-selection-not-offered") {
    if (!isGenderSelectionQuery(msg)) {
      return {
        score: 0,
        reasons: ["産み分け未実施:性別確認質問等のため除外"],
        rejected: true,
        rejectReason: "gender_selectionは産み分け質問のみ",
      };
    }
  }
  // 婦人科手術未実施は中絶・産科処置・診察のみの質問に流用しない
  if (
    itemService === "gynecologic_surgery" ||
    item.id === "gynecologic-surgery-not-offered"
  ) {
    if (!isGynecologicSurgeryQuery(msg)) {
      return {
        score: 0,
        reasons: ["婦人科手術未実施:対象外質問のため除外"],
        rejected: true,
        rejectReason: "gynecologic_surgeryは婦人科手術質問のみ",
      };
    }
  }
  // 分娩入院の持ち物は産後ケア等に流用しない
  if (
    item.id === "childbirth-hospital-bag" ||
    itemIntent === "hospital_bag"
  ) {
    if (isNonChildbirthBelongingsQuery(msg) || !isHospitalBagQuery(msg)) {
      return {
        score: 0,
        reasons: ["入院持ち物:対象外質問のため除外"],
        rejected: true,
        rejectReason: "hospital_bagは分娩入院の持ち物のみ",
      };
    }
  }
  // 夜診予約不可は夜診予約質問以外に流用しない（時間のみ・他診療予約と分離）
  if (
    item.id === "evening-consultation-reservation" ||
    itemService === "evening_consultation"
  ) {
    if (
      isEveningConsultationHoursQuery(msg) ||
      isClinicHoursQuery(msg) ||
      !isEveningConsultationReservationQuery(msg)
    ) {
      return {
        score: 0,
        reasons: ["夜診予約:対象外質問のため除外"],
        rejected: true,
        rejectReason: "evening_consultationは夜診の予約可否のみ",
      };
    }
  }
  // 診療時間の確定データ要約は診療時間質問以外に流用しない
  if (
    item.id === "clinic-hours-schedule" ||
    itemIntent === "clinic_hours" ||
    itemService === "clinic_hours"
  ) {
    if (!isClinicHoursQuery(msg)) {
      return {
        score: 0,
        reasons: ["診療時間:対象外質問のため除外"],
        rejected: true,
        rejectReason: "clinic_hoursは診療時間・休診質問のみ",
      };
    }
  }
  // お子さま同伴・キッズルームは同伴／施設質問以外に流用しない
  if (
    item.id === "child-accompanied-visit" ||
    itemIntent === "child_accompanied_visit"
  ) {
    if (
      !isChildAccompaniedVisitQuery(msg) ||
      isChildcareRequestQuery(msg) ||
      isChildPatientExamQuery(msg) ||
      isChildVaccinationQuery(msg)
    ) {
      return {
        score: 0,
        reasons: ["お子さま同伴:対象外質問のため除外"],
        rejected: true,
        rejectReason: "child_accompanied_visitは同伴・キッズルームのみ",
      };
    }
  }
  // 一般不妊相談は不妊・妊活質問以外に流用しない
  if (
    item.id === "general-infertility-consultation" ||
    itemIntent === "infertility_consultation" ||
    itemService === "general_infertility_consultation"
  ) {
    if (
      !isInfertilityConsultationQuery(msg) &&
      !isAdvancedInfertilityQuery(msg)
    ) {
      return {
        score: 0,
        reasons: ["不妊相談:対象外質問のため除外"],
        rejected: true,
        rejectReason: "infertility_consultationは不妊・妊活質問のみ",
      };
    }
  }
  // つわり相談は対象質問以外に流用しない
  if (
    item.id === "pregnancy-morning-sickness" ||
    itemIntent === "morning_sickness_consultation"
  ) {
    if (!isMorningSicknessQuery(msg)) {
      return {
        score: 0,
        reasons: ["つわり相談:対象外質問のため除外"],
        rejected: true,
        rejectReason: "morning_sickness_consultationはつわり関連のみ",
      };
    }
  }
  // 骨盤位はさかご・逆子関連以外（帝王切開一般など）に流用しない
  if (
    item.id === "pregnancy-breech-presentation" ||
    itemIntent === "breech_presentation_consultation"
  ) {
    if (!isBreechPresentationQuery(msg)) {
      return {
        score: 0,
        reasons: ["骨盤位:対象外質問のため除外"],
        rejected: true,
        rejectReason: "breech_presentationはさかご・逆子関連のみ",
      };
    }
  }
  // 体重管理は妊娠体重関連以外に流用しない
  if (
    item.id === "pregnancy-weight-gain" ||
    itemIntent === "pregnancy_weight_management"
  ) {
    if (!isPregnancyWeightQuery(msg)) {
      return {
        score: 0,
        reasons: ["体重管理:対象外質問のため除外"],
        rejected: true,
        rejectReason: "pregnancy_weight_managementは妊娠中の体重関連のみ",
      };
    }
  }
  // 陣痛連絡は対象外（持ち物・料金など）に流用しない
  if (
    item.id === "labor-hospital-contact-timing" ||
    itemIntent === "labor_hospital_contact"
  ) {
    if (!isLaborHospitalContactQuery(msg)) {
      return {
        score: 0,
        reasons: ["陣痛連絡:対象外質問のため除外"],
        rejected: true,
        rejectReason: "labor_hospital_contactは陣痛・破水・出血・胎動関連のみ",
      };
    }
  }
  // 里帰り出産は対象外に流用しない
  if (
    item.id === "obstetrics-homecoming-delivery" ||
    itemIntent === "homecoming_delivery"
  ) {
    if (!isHomecomingDeliveryQuery(msg)) {
      return {
        score: 0,
        reasons: ["里帰り出産:対象外質問のため除外"],
        rejected: true,
        rejectReason: "homecoming_deliveryは里帰り出産関連のみ",
      };
    }
  }
  // 初診料は対象外（再診・健診・分娩料金など）に流用しない
  if (
    item.id === "clinic-first-visit-fee" ||
    itemIntent === "first_visit_fee"
  ) {
    if (!isFirstVisitFeeQuery(msg)) {
      return {
        score: 0,
        reasons: ["初診料:対象外質問のため除外"],
        rejected: true,
        rejectReason: "first_visit_feeは初診料関連のみ",
      };
    }
  }
  // 4D超音波は対象外（通常エコー等）に流用しない
  if (
    item.id === "obstetrics-4d-ultrasound" ||
    itemIntent === "four_d_ultrasound"
  ) {
    if (!isFourDUltrasoundQuery(msg)) {
      return {
        score: 0,
        reasons: ["4D超音波:対象外質問のため除外"],
        rejected: true,
        rejectReason: "four_d_ultrasoundは4D超音波撮影関連のみ",
      };
    }
  }
  // 女性医師・指名は対象外に流用しない
  if (item.id === "clinic-female-doctor" || itemIntent === "female_doctor") {
    if (!isFemaleDoctorQuery(msg) && !isMaleDoctorQuery(msg)) {
      return {
        score: 0,
        reasons: ["女性医師:対象外質問のため除外"],
        rejected: true,
        rejectReason: "female_doctorは女性医師・指名関連のみ",
      };
    }
  }
  // ニューボーン／マタニティフォトは対象外（4D・院内撮影ルール等）に流用しない
  if (
    item.id === "newborn-maternity-photo" ||
    itemIntent === "newborn_maternity_photo"
  ) {
    if (!isNewbornMaternityPhotoQuery(msg)) {
      return {
        score: 0,
        reasons: ["ニューボーンフォト:対象外質問のため除外"],
        rejected: true,
        rejectReason: "newborn_maternity_photoは該当撮影紹介のみ",
      };
    }
  }
  // 母乳ケアは対象外（一般診療予約・産後ケア宿泊等）に流用しない
  if (
    item.id === "postpartum-milkcare-reservation" ||
    String(itemIntent || "").startsWith("milkcare_")
  ) {
    if (!isMilkcareQuery(msg)) {
      return {
        score: 0,
        reasons: ["母乳ケア:対象外質問のため除外"],
        rejected: true,
        rejectReason: "milkcareは母乳ケア関連のみ",
      };
    }
  }
  // 院内施設は対象外（母乳ケア・面会・個室料金等）に流用しない
  if (
    item.id === "clinic-facilities" ||
    itemIntent === "clinic_facilities"
  ) {
    if (!isClinicFacilitiesQuery(msg)) {
      return {
        score: 0,
        reasons: ["院内施設:対象外質問のため除外"],
        rejected: true,
        rejectReason: "clinic_facilitiesは施設・入院部屋関連のみ",
      };
    }
  }
  // 産前産後教室は対象外（体重管理・フォト等）に流用しない
  if (
    item.id === "prenatal-classes" ||
    itemIntent === "prenatal_classes"
  ) {
    if (!isPrenatalClassesQuery(msg)) {
      return {
        score: 0,
        reasons: ["産前産後教室:対象外質問のため除外"],
        rejected: true,
        rejectReason: "prenatal_classesは教室関連のみ",
      };
    }
  }
  // 葉酸は葉酸質問以外に流用しない
  if (
    item.id === "pregnancy-folic-acid" ||
    itemIntent === "pregnancy_folic_acid"
  ) {
    if (!isPregnancyFolicAcidQuery(msg)) {
      return {
        score: 0,
        reasons: ["葉酸:対象外質問のため除外"],
        rejected: true,
        rejectReason: "pregnancy_folic_acidは葉酸関連のみ",
      };
    }
  }
  // 妊娠中の服薬は対象外（授乳・葉酸・つわり）に流用しない
  if (
    item.id === "pregnancy-medication-consultation" ||
    itemIntent === "pregnancy_medication_consultation"
  ) {
    if (
      !isPregnancyMedicationQuery(msg) ||
      isPregnancyFolicAcidQuery(msg) ||
      isBreastfeedingMedicationQuery(msg)
    ) {
      return {
        score: 0,
        reasons: ["妊娠中服薬:対象外質問のため除外"],
        rejected: true,
        rejectReason: "pregnancy_medicationは妊娠中の服薬のみ",
      };
    }
  }
  // 分娩料金系は該当 intent 以外・産後ケア料金に流用しない
  if (
    itemIntent === "birth_reservation_deposit" ||
    itemIntent === "birth_advance_payment" ||
    itemIntent === "birth_hospitalization_cost" ||
    itemIntent === "birth_cost_discount" ||
    itemIntent === "birth_pricing_overview" ||
    String(item.id || "").startsWith("birth-")
  ) {
    // 割引条件を予約金・入院費エントリへ流用しない（上で id 接頭辞に含む）
    if (isPostpartumCareFeeQuery(msg) || !isBirthPricingQuery(msg)) {
      return {
        score: 0,
        reasons: ["分娩料金:対象外質問のため除外"],
        rejected: true,
        rejectReason: "分娩料金情報は分娩料金質問のみ",
      };
    }
    const qIntent = detectBirthPricingIntent(msg);
    if (
      qIntent &&
      itemIntent &&
      itemIntent !== qIntent &&
      itemIntent !== "birth_pricing_overview" &&
      qIntent !== "birth_pricing_overview"
    ) {
      // 予約金質問に予納金エントリを当てない等
      if (
        (itemIntent === "birth_reservation_deposit" &&
          qIntent !== "birth_reservation_deposit") ||
        (itemIntent === "birth_advance_payment" &&
          qIntent !== "birth_advance_payment")
      ) {
        return {
          score: 0,
          reasons: ["分娩料金:予約金と予納金の混同防止"],
          rejected: true,
          rejectReason: "予約金と予納金を混同しない",
        };
      }
    }
  }
  // 夜診予約質問に当日予約一般・WEB予約一般を流用しない
  if (
    isEveningConsultationReservationQuery(msg) &&
    (item.id === "reception-001" ||
      itemIntent === "web_reservation_availability" ||
      (itemIntent === "reservation_availability" &&
        itemService !== "evening_consultation"))
  ) {
    return {
      score: 0,
      reasons: ["夜診予約:他の予約ルール流用禁止"],
      rejected: true,
      rejectReason: "夜診予約には夜診専用情報を使う",
    };
  }

  // 妊婦健診エコー頻度は婦人科エコー質問に流用しない
  if (
    item.id === "prenatal-checkup-ultrasound-frequency" ||
    itemIntent === "ultrasound_frequency"
  ) {
    if (
      isGynecologyUltrasoundFrequencyQuery(msg) ||
      !isPrenatalUltrasoundFrequencyQuery(msg)
    ) {
      return {
        score: 0,
        reasons: ["エコー頻度:妊婦健診以外のため除外"],
        rejected: true,
        rejectReason: "ultrasound_frequencyは妊婦健診エコーのみ",
      };
    }
  }

  // お祝いディナー：食材変更／アレルギー／家族招待を相互流用しない
  if (
    item.id === "celebration-dinner-food-request" ||
    itemIntent === "meal_customization"
  ) {
    if (!isCelebrationDinnerFoodRequestQuery(msg)) {
      return {
        score: 0,
        reasons: ["食材変更:対象外質問のため除外"],
        rejected: true,
        rejectReason: "meal_customizationは苦手食材・メニュー変更のみ",
      };
    }
  }
  if (
    item.id === "celebration-dinner-allergy" ||
    itemIntent === "meal_allergy"
  ) {
    if (!isCelebrationDinnerAllergyQuery(msg)) {
      return {
        score: 0,
        reasons: ["アレルギー:対象外質問のため除外"],
        rejected: true,
        rejectReason: "meal_allergyは食物アレルギー質問のみ",
      };
    }
  }
  if (
    item.id === "childbirth_bonus_dinner" ||
    itemIntent === "childbirth_bonus_dinner"
  ) {
    if (
      isCelebrationDinnerFoodRequestQuery(msg) ||
      isCelebrationDinnerAllergyQuery(msg)
    ) {
      return {
        score: 0,
        reasons: ["家族招待:食材変更/アレルギー質問へ流用禁止"],
        rejected: true,
        rejectReason: "childbirth_bonus_dinnerは家族招待のみ",
      };
    }
  }
  // 中絶の登録情報は「手術」ワードだけでは他手術に流用しない
  if (
    item.id === "item-045" ||
    /中絶/.test(`${item.category || ""}${(item.keywords || []).join("")}`)
  ) {
    if (!isAbortionQuery(msg) && /手術|オペ/.test(msg)) {
      return {
        score: 0,
        reasons: ["中絶情報:他の手術質問へ流用禁止"],
        rejected: true,
        rejectReason: "中絶手術情報は中絶質問のみ",
      };
    }
  }
  // 診察・処方の案内は手術可否質問に使わない
  if (
    (item.id === "gynecologic-condition-exam" ||
      item.id === "gynecologic-medication-consult") &&
    isGynecologicSurgeryQuery(msg)
  ) {
    return {
      score: 0,
      reasons: ["診察/処方案内:手術質問には不使用"],
      rejected: true,
      rejectReason: "手術質問には手術未実施情報を使う",
    };
  }

  // 育児相談JSONは日常悩み専用。体調・母親限界には流用しない
  if (itemIntent === "baby_care_consultation") {
    if (isBabyIllnessConsultMessage(msg) || isMotherDistressConsultMessage(msg)) {
      return {
        score: 0,
        reasons: ["育児相談:体調/母親不調のため健診案内を除外"],
        rejected: true,
        rejectReason: "baby_careは日常育児のみ（体調・母親不調は除外）",
      };
    }
    if (queryIntent && queryIntent !== "baby_care_consultation") {
      return {
        score: 0,
        reasons: [`育児相談:queryIntent不一致:${queryIntent}`],
        rejected: true,
        rejectReason: `baby_care_consultation以外のintent(${queryIntent})`,
      };
    }
    if (!queryIntent && !isDailyBabyCareConsultMessage(msg)) {
      return {
        score: 0,
        reasons: ["育児相談:日常育児相談ではない"],
        rejected: true,
        rejectReason: "日常育児相談ではない",
      };
    }
    // 過ぎた健診案内の流用禁止（生後3ヶ月以降は保健センター等へ）
    const ageMonths = detectInfantAgeMonths(msg);
    const route = resolveBabyCareGuidanceRoute(ageMonths);
    const answerMentionsCheckup = /1ヶ月健診|2ヶ月健診/.test(
      String(item.answer || "")
    );
    if (answerMentionsCheckup && route === "external") {
      return {
        score: 0,
        reasons: ["育児相談:月齢が健診案内対象外"],
        rejected: true,
        rejectReason: "3ヶ月以降に1・2ヶ月健診案内を使わない",
      };
    }
    if (
      item.id === "baby-care-consultation-external" &&
      route !== "external"
    ) {
      return {
        score: 0,
        reasons: ["外部相談先:健診対象月齢のため除外"],
        rejected: true,
        rejectReason: "baby-care-externalは3ヶ月以降のみ",
      };
    }
  }

  let score = 0;
  let bestPattern = 0;
  const qAct = patternActionTags(normalizedQuery);

  for (const pat of item.questionPatterns || []) {
    const p = normalizeQueryText(pat).toLowerCase();
    if (!p) continue;
    const pAct = patternActionTags(p);

    // アクション（変更/キャンセル/可否）が食い違うパターンは使わない
    if (qAct.change !== pAct.change || qAct.cancel !== pAct.cancel) {
      continue;
    }
    if (
      RESERVATION_INTENTS.has(queryIntent || "") &&
      qAct.availability &&
      (pAct.change || pAct.cancel) &&
      !qAct.change &&
      !qAct.cancel
    ) {
      continue;
    }

    if (msgNorm === p || msgNorm.includes(p) || p.includes(msgNorm)) {
      bestPattern = Math.max(bestPattern, 120);
      reasons.push(`pattern一致:${pat.slice(0, 24)}`);
    } else {
      const toks = p.split(/\s+/).filter((t) => t.length >= 2);
      let hit = 0;
      for (const t of toks) {
        if (expLower.includes(t)) hit += 1;
      }
      if (toks.length && hit === toks.length) {
        bestPattern = Math.max(bestPattern, 90);
        reasons.push(`pattern語全一致:${pat.slice(0, 24)}`);
      } else if (hit >= 2 && !RESERVATION_INTENTS.has(itemIntent || "")) {
        // 予約系は部分一致だけで高得点にしない
        bestPattern = Math.max(bestPattern, 20 * hit);
      }
    }
  }
  score += bestPattern;

  // keywords: 予約系は pattern があるときだけ補助点。keyword単独では通過させない
  let kwHits = 0;
  let kwScore = 0;
  for (const kw of item.keywords || []) {
    const k = String(kw || "").toLowerCase();
    if (k.length < 2) continue;
    if (expLower.includes(k) || msgNorm.includes(k)) {
      kwHits += 1;
      kwScore += k.length >= 3 ? 16 : 10;
      reasons.push(`keyword:${kw}`);
    }
  }
  if (kwHits >= 2) kwScore += 10;

  const isReservationItem = RESERVATION_INTENTS.has(itemIntent || "");
  if (isReservationItem) {
    if (bestPattern >= 90) {
      score += Math.min(30, kwScore);
    } else if (bestPattern > 0) {
      score += Math.min(12, kwScore);
    } else {
      // keywordのみ → 通過不可
      return {
        score: Math.min(35, kwScore + Math.min(15, (Number(item.priority) || 0) * 0.1)),
        reasons: [...reasons, "keywordのみ(予約intentはpattern必須)"],
        rejected: true,
        rejectReason: "keywordのみでpattern不一致",
      };
    }
  } else {
    score += kwScore;
  }

  if (queryIntent && itemIntent && queryIntent === itemIntent) {
    score += 40;
    reasons.push(`intent一致:${queryIntent}`);
  }
  if (queryService && itemService && queryService === itemService) {
    score += 35;
    reasons.push(`service一致:${queryService}`);
  }

  const cat = String(item.category || "").toLowerCase();
  if (cat && !isReservationItem && (expLower.includes(cat) || msgNorm.includes(cat))) {
    score += 12;
    reasons.push("category一致");
  }

  score += Math.min(30, Math.max(0, Number(item.priority) || 0) * 0.15);

  const uniq = [];
  const seen = new Set();
  for (const r of reasons) {
    if (seen.has(r)) continue;
    seen.add(r);
    uniq.push(r);
  }
  return { score: Math.round(score), reasons: uniq.slice(0, 12) };
}

/**
 * @param {string} userMessage
 * @param {{ forceRefresh?: boolean, items?: ClinicKnowledgeItem[] }} [opts]
 * @returns {Promise<{
 *   hits: ClinicKnowledgeHit[],
 *   topScore: number,
 *   source: string,
 *   strong: boolean,
 *   detectedIntent: string|null,
 *   detectedService: string|null,
 *   normalizedQuery: string,
 *   rejected: ClinicKnowledgeRejection[],
 * }>}
 */
export async function searchClinicKnowledge(userMessage, opts = {}) {
  const loaded = opts.items
    ? { items: opts.items, source: "provided" }
    : await loadClinicKnowledgeSource(opts);
  const items = loaded.items || [];
  const detectedIntent = detectClinicIntent(userMessage);
  const detectedService = detectClinicService(userMessage);
  const normalizedQuery = normalizeReservationQuery(userMessage);

  if (!items.length) {
    return {
      hits: [],
      topScore: 0,
      source: loaded.source || "none",
      strong: false,
      detectedIntent,
      detectedService,
      normalizedQuery,
      rejected: [],
    };
  }

  /** @type {ClinicKnowledgeRejection[]} */
  const rejected = [];
  const scored = [];
  for (const item of items) {
    const { score, reasons, rejected: isRejected, rejectReason } =
      scoreClinicKnowledgeItem(userMessage, item, {
        queryIntent: detectedIntent,
        queryService: detectedService,
      });
    if (isRejected || score < MIN_PASS_SCORE) {
      if (
        isRejected ||
        (detectedIntent && RESERVATION_INTENTS.has(detectedIntent)) ||
        detectedService
      ) {
        rejected.push({
          id: item.id,
          intent: item.intent || null,
          service: item.service || null,
          score,
          reason: rejectReason || (score < MIN_PASS_SCORE ? `スコア不足(${score})` : "除外"),
        });
      }
      continue;
    }
    scored.push({ item, score, reasons });
  }
  scored.sort(
    (a, b) => b.score - a.score || (b.item.priority || 0) - (a.item.priority || 0)
  );

  const topScore = scored[0]?.score || 0;
  if (!topScore) {
    return {
      hits: [],
      topScore: 0,
      source: loaded.source,
      strong: false,
      detectedIntent,
      detectedService,
      normalizedQuery,
      rejected: rejected.slice(0, 20),
    };
  }

  const minKeep = Math.max(topScore * 0.55, topScore - 40, MIN_PASS_SCORE);
  const hits = scored.filter((h) => h.score >= minKeep).slice(0, TOP_ITEMS);
  return {
    hits,
    topScore,
    source: loaded.source,
    strong: isClinicKnowledgeStrong(topScore, hits),
    detectedIntent,
    detectedService,
    normalizedQuery,
    rejected: rejected.slice(0, 20),
  };
}

/**
 * clinic-knowledge が高信頼か（サイト投稿チップ抑制の判定）
 * @param {number} topScore
 * @param {ClinicKnowledgeHit[]} [hits]
 */
export function isClinicKnowledgeStrong(topScore, hits = []) {
  if (Number(topScore) >= CLINIC_KNOWLEDGE_STRONG_SCORE) return true;
  // pattern一致相当の理由があれば強ヒットとみなす
  const top = hits[0];
  if (top && top.score >= MIN_PASS_SCORE + 40) {
    const reasons = top.reasons || [];
    if (reasons.some((r) => /pattern一致|pattern語全一致/.test(r))) return true;
  }
  return false;
}

/**
 * GPT 用 system 文（公式サイト抜粋とは別枠）
 * @param {ClinicKnowledgeHit[]} hits
 */
export function buildClinicRegisteredKnowledgePrompt(hits, userMessage = "") {
  if (!hits?.length) return "";
  const hasBabyCare = hits.some(
    (h) => h.item?.intent === "baby_care_consultation"
  );
  const hasBirthPricing = hits.some(
    (h) =>
      String(h.item?.intent || "").startsWith("birth_") ||
      String(h.item?.id || "").startsWith("birth-")
  );
  const birthBuilt = hasBirthPricing
    ? buildBirthPricingAnswer(userMessage)
    : null;
  const blocks = hits.map(({ item, score }) => {
    let answer = item.answer;
    // 金額は data/birth-pricing.js に一元化（JSON回答のプレースホルダを置換）
    if (
      birthBuilt?.answer &&
      (String(item.intent || "").startsWith("birth_") ||
        String(item.id || "").startsWith("birth-"))
    ) {
      answer = birthBuilt.answer;
    }
    return [
      `【院内登録情報】`,
      `id: ${item.id}`,
      `カテゴリ: ${item.category || "-"}`,
      `更新日: ${item.updatedAt || "不明"}`,
      `関連スコア: ${score}`,
      `回答:`,
      answer,
    ].join("\n");
  });
  return [
    "【院内登録情報（病院が明示登録した確定情報。公式サイト情報より優先する）】",
    "・以下は公式サイト未掲載でも案内してよい院内確定情報です。",
    "・公式サイト抜粋や一般知識と矛盾する場合は、院内登録情報を優先してください。",
    "・緊急症状の判断・診断・処方指示には使わないでください。",
    "・回答内に「院内登録情報」「FAQ」などの内部用語は出さないでください。",
    ...(hasBirthPricing
      ? [
          "・分娩予約金と分娩予納金は別費用。金額を取り違えない。",
          "・予約金のうち入院費精算分を「一部のみ返金不可」と誤案内しない（予約金全体が返金不可）。",
          "・産後ケア料金に分娩料金を流用しない。一般的な産婦人科料金の推測禁止。",
        ]
      : []),
    ...(hasBabyCare
      ? [
          "・育児相談は月齢で案内先を変える。1〜2ヶ月は健診時相談、3ヶ月以降は保健センター・小児科。過ぎた健診を案内しない。",
          "・登録文をそのまま貼らず、短い共感のあとに案内する。励ましの締めは付けない。",
          "・「いつでも／お気軽にご相談ください」「具体的な状況を教えてください」「当院でサポートします」は使わないでください。",
        ]
      : []),
    ...(hits.some((h) => h.item?.intent === "childbirth_bonus_dinner")
      ? [
          "・お祝いディナーの人数・招待内容はこの登録情報の範囲で案内する（ご出産された患者さま＋ご家族様1名）。質問の言い回しで人数を変えない。",
          "・「一人で食べるの？」「一人でしか食べられない？」などには、機械的な「はい／いいえ」を付けず、家族1名招待できる事実を直接説明する。",
          "・3名以上など、登録情報を超える追加参加の可否は推測・断定しない。",
          "・『嬉しいですね』『素敵ですね』などの感想は付けない。",
        ]
      : []),
    ...(hits.some((h) => h.item?.intent === "meal_customization")
      ? [
          "・お祝いディナーは固定メニュー。苦手な食材・好き嫌いによるメニュー変更は原則不可。",
          "・可能な範囲での「配慮」にとどめ、変更対応・個別対応を約束しない。",
          "・「できる限り対応します」「変更できます」「ご安心ください」「ご希望に合わせて」は使わない。",
          "・公式サイトに無い具体案内（例: 出産後1日目の昼食時に伺う）は追加しない。",
        ]
      : []),
    ...(hits.some((h) => h.item?.intent === "meal_allergy")
      ? [
          "・食物アレルギーは好き嫌いと別扱い。安全のため事前にスタッフへ確認を案内する。",
          "・アレルギー対応が可能とは断定しない。変更・個別対応の約束はしない。",
          "・「できる限り対応します」「ご安心ください」は使わない。",
        ]
      : []),
    ...(hits.some((h) => h.item?.intent === "ultrasound_frequency")
      ? [
          "・妊婦健診のエコー頻度は院内登録情報を優先する。一般論（毎回ではない／医師判断のみ等）で上書きしない。",
          "・胎嚢確認後は毎回の妊婦健診でエコー、確認前は毎回実施と断定しない。",
          "・婦人科診察のエコーにはこの情報を使わない。",
          "・「安心して健診を」「成長が楽しみ」などの締めは付けない。",
        ]
      : []),
    ...(hits.some((h) => h.item?.intent === "hospital_bag")
      ? [
          "・入院持ち物は公式サイトの分類を守る。「ご用意いただく物」「分娩セット」「当院でご用意している物」を混同しない。",
          "・当院で用意している物（病衣・タオル・シャンプー・スリッパ等）を持参必須と案内しない。",
          "・公式サイトにない一般的な持ち物を追加しない。条件付き（予定帝王切開のみ・必要な方のみ・対象市町村のみ）を全員必須にしない。",
          "・一覧の詳細は公式ページへ案内し、チャットで全部を無理に列挙しなくてよい（全部教えてと求められた場合を除く）。",
        ]
      : []),
    ...(hits.some((h) => h.item?.service === "evening_consultation")
      ? [
          "・夜診は予約不可・受付順。電話予約や事前予約が可能と案内しない。",
          "・締切時刻・診療時間など、質問に不要な条件を勝手に付け足さない。",
          "・妊婦健診やWEB予約の可否を夜診に流用しない。",
        ]
      : []),
    "",
    blocks.join("\n\n---\n\n"),
  ].join("\n");
}

/** @deprecated 互換: 旧 buildClinicKnowledgeSnippet */
export function buildClinicKnowledgeSnippet(userMessage) {
  const items = getCachedItemsSync();
  const scored = items
    .map((item) => {
      const { score, reasons } = scoreClinicKnowledgeItem(userMessage, item);
      return { item, score, reasons };
    })
    .filter((h) => h.score >= MIN_PASS_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_ITEMS);
  return buildClinicRegisteredKnowledgePrompt(scored);
}

/** @deprecated 互換 */
export function rankClinicKnowledge(userMessage) {
  const items = getCachedItemsSync();
  const scored = items
    .map((item) => ({
      item,
      score: scoreClinicKnowledgeItem(userMessage, item).score,
    }))
    .filter((s) => s.score >= MIN_PASS_SCORE)
    .sort((a, b) => b.score - a.score);
  return {
    items: scored.slice(0, TOP_ITEMS).map((s) => s.item),
    topScore: scored[0]?.score || 0,
  };
}

/** clinic-knowledge は患者向け Web チップに使わない */
export function selectReferencedPagesFromCsv() {
  return [];
}

export function shouldSupplementWithWeb() {
  // 併用方針: 常に公式サイト検索も許可（呼び出し側で制御）
  return true;
}

export function peekClinicKnowledgeStatus() {
  return {
    source: memoryCache.source,
    version: memoryCache.version,
    itemCount: memoryCache.items.length,
    loadError: memoryCache.error,
    minPassScore: MIN_PASS_SCORE,
    topItems: TOP_ITEMS,
    cacheTtlMs: CACHE_TTL_MS,
    remoteUrlConfigured: Boolean(String(process.env.CLINIC_KNOWLEDGE_URL || "").trim()),
    jsonPath: "data/clinic-knowledge.json",
  };
}
