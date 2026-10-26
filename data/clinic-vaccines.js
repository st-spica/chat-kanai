/**
 * ワクチン案内の分類と統合
 *
 * 産科: https://kanai.or.jp/obstetrics/vaccine/
 *   - 妊婦さま向けRSウイルスワクチン
 *   - インフルエンザワクチン
 * 婦人科: https://kanai.or.jp/gynecology/#cervical_cancer
 *   - 子宮頸がん予防ワクチン（HPVワクチン）
 *
 * 「ワクチン」「予防接種」だけでは産科ページを選ばない。
 * 全般の質問は両方の知識を統合し、ワクチン名がある質問はその種類を優先する。
 * 子宮がん検診（#gyne_cancer）とは別サービス。
 */

import { isChildVaccinationQuery } from "./site-route-map.js";
import { isHpvVaccineQuery, mentionsHpvVaccine } from "./hpv-vaccine.js";
import {
  isCervicalCancerScreeningQuery,
  isHpvVaccineVsScreeningQuery,
} from "./cervical-cancer-screening.js";

export const OBSTETRIC_VACCINE_REF_PAGE = {
  url: "https://kanai.or.jp/obstetrics/vaccine/",
  title: "妊婦さま向けワクチンのご案内",
};

export const HPV_VACCINE_GUIDE_PAGE = {
  url: "https://kanai.or.jp/gynecology/#cervical_cancer",
  title: "子宮頸がんワクチンのご案内",
};

/** 公式ページに基づく確定情報（回答の統合元） */
export const VACCINE_CATALOG = {
  rsv: {
    kind: "rsv",
    id: "obstetric-rsv-vaccine",
    intent: "rsv_vaccination",
    service: "obstetric_vaccination",
    department: "obstetrics",
    name: "RSウイルスワクチン",
    available: true,
  },
  flu: {
    kind: "flu",
    id: "obstetric-influenza-vaccine",
    intent: "influenza_vaccination",
    service: "obstetric_vaccination",
    department: "obstetrics",
    name: "インフルエンザワクチン",
    available: true,
  },
  hpv: {
    kind: "hpv",
    id: "cervical-cancer-hpv-vaccine",
    intent: "hpv_vaccination",
    service: "hpv_vaccination",
    department: "gynecology",
    name: "子宮頸がん予防ワクチン（HPVワクチン）",
    available: true,
  },
};

const GENERAL_VACCINE_ANSWER = [
  "はい、当院ではワクチン接種を行っています。",
  "",
  "妊婦さま向けのRSウイルスワクチンやインフルエンザワクチンのほか、婦人科では子宮頸がん予防ワクチン（HPVワクチン）にも対応しています。",
  "",
  "ワクチンの種類によって接種対象や予約方法が異なりますので、詳しくは下記のページをご確認ください。",
].join("\n");

const PREGNANT_VACCINE_ANSWER = [
  "はい、当院では妊婦さま向けのワクチン接種を行っています。",
  "",
  "RSウイルスワクチンとインフルエンザワクチンに対応しています。",
  "",
  "ワクチンの種類によって接種対象や予約方法が異なりますので、詳しくは下記のページをご確認ください。",
].join("\n");

const FLU_VACCINE_ANSWER = [
  "はい、当院ではインフルエンザワクチンの接種を行っています。",
  "",
  "対象は、当院に通院中で、接種当日に妊婦健診のご予約がある方です。",
  "接種は本館の午前1診・午後診で行い、夜診は対応していません。",
  "料金は3,520円（税込）です。",
  "",
  "詳しくは下記のページをご確認ください。",
].join("\n");

const RSV_AVAILABILITY_ANSWER = [
  "はい、当院では妊婦さま向けのRSウイルスワクチン（アブリスボ）の接種を行っています。",
  "",
  "予約制です。当院で妊婦健診を受けている方は、健診時にスタッフへお申し込みください。",
  "他院で受診中の方は、診療時間内にお電話でお申し込みいただけます。",
  "",
  "料金や接種時期は、下記のページをご確認ください。",
].join("\n");

const RSV_FEE_ANSWER = [
  "RSウイルスワクチン（アブリスボ）の料金は、接種日当日に大阪市・守口市・東大阪市に住民票がある方は無料です。",
  "",
  "それ以外の方は30,800円（税込）です。他院で妊婦健診を受けている方は、別途診察料1,100円がかかります。",
  "",
  "東大阪市の定期接種は、市への事前申し込みが必要です。対象週数や手続きの詳細は、下記のページをご確認ください。",
].join("\n");

/**
 * @param {string} text
 */
export function mentionsRsvVaccine(text) {
  return /RS\s*ウイルス|ＲＳ\s*ウイルス|アブリスボ|abrysvo/i.test(String(text || ""));
}

/**
 * @param {string} text
 */
export function mentionsInfluenzaVaccine(text) {
  return /インフルエンザ|インフル/.test(String(text || ""));
}

/**
 * @param {string} text
 */
function mentionsPregnantAudience(text) {
  return /妊婦|妊娠中|妊娠している|妊娠\d/.test(String(text || ""));
}

/**
 * @param {string} text
 */
function mentionsGenericVaccine(text) {
  return /ワクチン|予防接種/.test(String(text || ""));
}

/**
 * @param {string} userMessage
 * @returns {{
 *   focus: "general"|"pregnant"|"rsv"|"flu"|"hpv"|"named"|"child",
 *   kinds: string[],
 * }|null}
 */
export function classifyClinicVaccineQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return null;
  if (isHpvVaccineVsScreeningQuery(msg)) return null;
  if (isCervicalCancerScreeningQuery(msg) && !isHpvVaccineQuery(msg)) return null;

  const hpv = isHpvVaccineQuery(msg) || mentionsHpvVaccine(msg);
  const rsv = mentionsRsvVaccine(msg);
  const flu = mentionsInfluenzaVaccine(msg);
  const named = [];
  if (hpv && !isHpvVaccineVsScreeningQuery(msg)) named.push("hpv");
  if (rsv) named.push("rsv");
  if (flu) named.push("flu");

  // お子さま本人の予防接種は妊婦向け・HPVの知識に流さない
  if (
    isChildVaccinationQuery(msg) &&
    !mentionsPregnantAudience(msg) &&
    !hpv
  ) {
    return { focus: "child", kinds: [] };
  }

  if (named.length === 1) {
    return { focus: named[0], kinds: named };
  }
  if (named.length > 1) {
    return { focus: "named", kinds: named };
  }

  if (!mentionsGenericVaccine(msg)) return null;

  if (mentionsPregnantAudience(msg)) {
    return { focus: "pregnant", kinds: ["rsv", "flu"] };
  }
  return { focus: "general", kinds: ["rsv", "flu", "hpv"] };
}

/**
 * @param {{ focus?: string }|null|undefined} cls
 */
export function intentForVaccineClass(cls) {
  if (!cls) return null;
  if (cls.focus === "hpv") return "hpv_vaccination";
  if (cls.focus === "rsv") return "rsv_vaccination";
  if (cls.focus === "flu") return "influenza_vaccination";
  if (cls.focus === "pregnant") return "obstetric_vaccination";
  if (cls.focus === "child") return "vaccination_availability";
  return "clinic_vaccination";
}

/**
 * @param {object|null|undefined} item
 * @returns {"rsv"|"flu"|"hpv"|"overview"|null}
 */
export function vaccineItemKind(item) {
  if (!item) return null;
  if (item.vaccineKind) return item.vaccineKind;
  if (item.id === "cervical-cancer-hpv-vaccine" || item.intent === "hpv_vaccination") {
    return "hpv";
  }
  if (item.id === "obstetric-rsv-vaccine" || item.intent === "rsv_vaccination") {
    return "rsv";
  }
  if (
    item.id === "obstetric-influenza-vaccine" ||
    item.intent === "influenza_vaccination"
  ) {
    return "flu";
  }
  if (item.id === "clinic-vaccination-overview" || item.intent === "clinic_vaccination") {
    return "overview";
  }
  return null;
}

/**
 * この質問で参照してよいワクチン知識の種類。
 * ワクチン質問でなければ null（呼び出し側はワクチン項目を除外する）。
 * @param {string} userMessage
 * @returns {Set<string>|null}
 */
export function wantedVaccineKinds(userMessage) {
  const cls = classifyClinicVaccineQuery(userMessage);
  if (!cls || cls.focus === "child") return null;
  const wanted = new Set(cls.kinds || []);
  if (cls.focus === "general") wanted.add("overview");
  return wanted;
}

/**
 * 複数診療科にまたがるワクチン知識を、質問の具体性に合わせて残す。
 * 全般は産科・婦人科の両方。特定名はその種類だけ。
 * @param {string} userMessage
 * @param {Array<{ item: object, score: number, reasons?: string[] }>} scoredHits
 * @returns {Array<{ item: object, score: number, reasons?: string[] }>|null}
 */
export function selectVaccineKnowledgeHits(userMessage, scoredHits) {
  const wanted = wantedVaccineKinds(userMessage);
  if (!wanted) return null;
  const scoped = (scoredHits || []).filter((h) => wanted.has(vaccineItemKind(h.item)));
  const cls = classifyClinicVaccineQuery(userMessage);
  if (!cls || cls.kinds.length <= 1) return scoped;
  const seen = new Set();
  const merged = [];
  for (const h of scoped) {
    const id = h.item?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(h);
  }
  return merged;
}

/**
 * @param {string[]} kinds
 */
export function referencePagesForVaccineKinds(kinds) {
  const list = kinds || [];
  const pages = [];
  if (list.includes("rsv") || list.includes("flu")) {
    pages.push({ ...OBSTETRIC_VACCINE_REF_PAGE });
  }
  if (list.includes("hpv")) {
    pages.push({ ...HPV_VACCINE_GUIDE_PAGE });
  }
  return pages;
}

/**
 * @param {string} msg
 */
function asksFee(msg) {
  return /料金|費用|いくら|値段|価格|無料/.test(msg);
}

/**
 * 全般・妊婦向け・RS・インフルエンザの回答。
 * HPV単体とお子さま予防接種は専用処理に任せる。
 * @param {string} userMessage
 * @returns {{
 *   answer: string,
 *   intent: string,
 *   focus: string,
 *   kinds: string[],
 *   referencedPages: Array<{url:string,title:string}>,
 * }|null}
 */
export function buildClinicVaccineAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  const cls = classifyClinicVaccineQuery(msg);
  if (!cls) return null;
  if (cls.focus === "child" || cls.focus === "hpv") return null;

  const kinds = cls.kinds.filter((k) => VACCINE_CATALOG[k]?.available);
  const referencedPages = referencePagesForVaccineKinds(kinds);
  const intent = intentForVaccineClass(cls);

  if (cls.focus === "rsv") {
    return {
      answer: asksFee(msg) ? RSV_FEE_ANSWER : RSV_AVAILABILITY_ANSWER,
      intent,
      focus: asksFee(msg) ? "fee" : "availability",
      kinds,
      referencedPages,
    };
  }

  if (cls.focus === "flu") {
    return {
      answer: FLU_VACCINE_ANSWER,
      intent,
      focus: asksFee(msg) ? "fee" : "availability",
      kinds,
      referencedPages,
    };
  }

  if (cls.focus === "pregnant") {
    return {
      answer: PREGNANT_VACCINE_ANSWER,
      intent,
      focus: "pregnant",
      kinds,
      referencedPages,
    };
  }

  if (cls.focus === "named") {
    const names = kinds.map((k) => VACCINE_CATALOG[k].name);
    const answer = [
      "はい、当院ではワクチン接種を行っています。",
      "",
      `${names.join("と")}についてご案内できます。`,
      "接種対象や予約方法は種類によって異なりますので、詳しくは下記のページをご確認ください。",
    ].join("\n");
    return {
      answer,
      intent,
      focus: "named",
      kinds,
      referencedPages,
    };
  }

  const hasObstetric = kinds.includes("rsv") && kinds.includes("flu");
  const hasHpv = kinds.includes("hpv");
  const answer =
    hasObstetric && hasHpv
      ? GENERAL_VACCINE_ANSWER
      : [
          "はい、当院ではワクチン接種を行っています。",
          "",
          "対応しているワクチンの接種対象や予約方法は種類によって異なりますので、詳しくは下記のページをご確認ください。",
        ].join("\n");

  return {
    answer,
    intent,
    focus: "general",
    kinds,
    referencedPages,
  };
}
