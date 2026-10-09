/**
 * 院内施設・入院部屋の確定案内
 *
 * 公式: https://kanai.or.jp/facilities/
 * 確認できない設備（授乳スペース・休憩スペース等）を推測で作らない。
 * 母乳ケア・キッズルーム・面会・個室料金とは分離する。
 */

import { isKidsRoomQuery } from "./site-route-map.js";
import { isMilkcareQuery } from "./milkcare.js";

export const FACILITIES_REF_PAGE = {
  url: "https://kanai.or.jp/facilities/",
  title: "院内施設のご案内",
};

/** 院内確認：設置していない共用設備 */
export const UNAVAILABLE_FACILITIES = [
  "共用の授乳スペース",
  "共用の休憩スペース",
];

export const FACILITIES_OVERVIEW_ANSWER = [
  "当院の院内施設や設備については、公式サイトの施設案内ページでご紹介しています。",
  "",
  "院内の様子や各施設の詳細をご覧いただけますので、下記のページをご確認ください。",
].join("\n");

export const FACILITIES_ROOM_ANSWER = [
  "当院の入院部屋については、公式サイトの施設案内ページでご紹介しています。",
  "",
  "お部屋の様子などをご確認いただけますので、下記のページをご覧ください。",
].join("\n");

export const FACILITIES_NO_NURSING_SPACE_ANSWER = [
  "当院には、共用の授乳スペース（授乳室）は設置しておりません。",
  "",
  "院内施設の詳細は、公式サイトの施設案内ページをご確認ください。",
].join("\n");

export const FACILITIES_NO_REST_SPACE_ANSWER = [
  "当院には、共用の休憩スペース（休憩室）は設置しておりません。",
  "",
  "院内施設の詳細は、公式サイトの施設案内ページをご確認ください。",
].join("\n");

/**
 * 他トピックへ流さない
 * @param {string} msg
 */
function isOtherFacilitiesAdjacentTopic(msg) {
  if (isMilkcareQuery(msg)) return true;
  // キッズルーム単体は既存ハンドラへ
  if (
    isKidsRoomQuery(msg) &&
    !/院内施設|施設案内|院内設備|設備|入院部屋|病室|授乳スペース|授乳室|休憩スペース|休憩室|施設の写真|院内の様子/.test(
      msg
    )
  ) {
    return true;
  }
  // 面会
  if (/面会|お見舞い/.test(msg) && !/施設|部屋|病室|設備/.test(msg)) {
    return true;
  }
  // 個室料金
  if (/個室/.test(msg) && /料金|費用|いくら|差額|値段/.test(msg)) return true;
  // 母子同室の制度・開始時期のみ（施設案内ではない）
  if (
    /母子同室/.test(msg) &&
    !/施設|入院部屋|病室|個室|写真|様子|設備/.test(msg)
  ) {
    return true;
  }
  return false;
}

/**
 * @param {string} userMessage
 */
export function isClinicFacilitiesQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isOtherFacilitiesAdjacentTopic(msg)) return false;

  if (
    /院内施設|施設案内|院内設備|病院の(?:中|設備|施設)|院内の様子|施設の写真|院内の写真/.test(
      msg
    )
  ) {
    return true;
  }
  if (
    /入院部屋|病室|入院する部屋|入院中の部屋|お部屋の様子|部屋の写真|病室の写真/.test(
      msg
    )
  ) {
    return true;
  }
  if (/個室/.test(msg) && !/料金|費用|いくら|差額/.test(msg)) return true;
  if (/授乳スペース|授乳室/.test(msg)) return true;
  if (/休憩スペース|休憩室/.test(msg)) return true;
  if (/どんな設備|設備がありますか|施設を見たい|病院の中はどんな/.test(msg)) {
    return true;
  }
  return false;
}

/**
 * @param {string} msg
 */
function isNursingSpaceFocus(msg) {
  return /授乳スペース|授乳室/.test(msg);
}

/**
 * @param {string} msg
 */
function isRestSpaceFocus(msg) {
  return /休憩スペース|休憩室/.test(msg);
}

/**
 * @param {string} msg
 */
function isRoomFocus(msg) {
  return (
    /入院部屋|病室|入院する部屋|入院中の部屋|個室|部屋の写真|病室の写真|お部屋/.test(
      msg
    ) && !isNursingSpaceFocus(msg) && !isRestSpaceFocus(msg)
  );
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
export function buildClinicFacilitiesAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isClinicFacilitiesQuery(msg)) return null;

  const ref = [FACILITIES_REF_PAGE];

  if (isNursingSpaceFocus(msg)) {
    return {
      answer: FACILITIES_NO_NURSING_SPACE_ANSWER,
      intent: "clinic_facilities",
      focus: "no_nursing_space",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  if (isRestSpaceFocus(msg)) {
    return {
      answer: FACILITIES_NO_REST_SPACE_ANSWER,
      intent: "clinic_facilities",
      focus: "no_rest_space",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  if (isRoomFocus(msg)) {
    return {
      answer: FACILITIES_ROOM_ANSWER,
      intent: "clinic_facilities",
      focus: "room",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  return {
    answer: FACILITIES_OVERVIEW_ANSWER,
    intent: "clinic_facilities",
    focus: "overview",
    useExactAnswer: true,
    referencedPages: ref,
  };
}
