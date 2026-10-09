/**
 * 予約方法・電話番号案内
 *
 * - 通常回答では電話番号を表示しない（緊急時は例外）
 * - 「電話で予約できる」と診療内容なしで断定しない
 * - サービス別の確定予約方法（母乳ケア・夜診など）を優先
 */

export const APPOINTMENT_GUIDANCE_REF_PAGE = {
  url: "https://kanai.or.jp/beginner/",
  title: "初めての方へ・ご予約のご案内",
};

export const CLINIC_PHONE_DISPLAY = "06-6931-2391";

export const GENERIC_PHONE_RESERVATION_ANSWER = [
  "ご予約については、診療内容によってご案内が異なります。",
  "",
  "初めて当院を受診される方の予約方法や、受診までの流れについては、下記のページで詳しくご案内しております。",
  "",
  "ご希望の診療内容に合わせてご確認ください。",
].join("\n");

export const FIRST_VISIT_RESERVATION_ANSWER = [
  "初めて当院を受診される方の予約方法や、受診までの流れについては、下記のページで詳しくご案内しております。",
  "",
  "ご希望の内容に合わせてご確認ください。",
].join("\n");

export const PHONE_NUMBER_GUIDANCE_ANSWER = [
  "当院の電話番号は、公式サイトでご確認いただけます。",
  "",
  "予約方法や受診の流れについても、下記のページでご案内しております。",
].join("\n");

export const URGENT_CONTACT_ANSWER = [
  "お急ぎの場合は、直ちに当院へお電話でご連絡ください。",
  "",
  `当院：${CLINIC_PHONE_DISPLAY}（番号非通知は不可）`,
  "",
  "大量の出血、強い腹痛、破水が疑われる、胎動が明らかに少ない、意識がもうろうとしているなど、生命に危険があると感じる場合は、ためらうことなく119番へご連絡ください。",
].join("\n");

const CLINIC_PHONE_RE =
  /(?:📞\s*)?(?:\*{0,2})?0?6[-‐−–]?\s*6931[-‐−–]?\s*2391(?:\*{0,2})?(?:\s*（番号非通知[^）]*）)?/g;

/**
 * 通常回答から院内電話番号を除去（緊急案内では使わない）
 * @param {string} text
 */
export function stripClinicPhoneNumbers(text) {
  let s = String(text || "");
  s = s.replace(CLINIC_PHONE_RE, "");
  s = s.replace(/当院へのご相談は\s*までお電話ください。?/g, "");
  s = s.replace(/お電話は\s*まで[。．]?/g, "");
  s = s.replace(/当院：\s*\n?/g, "");
  s = s.replace(/[ \t]{2,}/g, " ");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

/**
 * 回答に院内電話番号が含まれるか
 * @param {string} text
 */
export function containsClinicPhoneNumber(text) {
  return /06[-‐−–]?\s*6931[-‐−–]?\s*2391/.test(String(text || ""));
}

/**
 * 電話番号そのものを聞いているか（予約方法とは別）
 * @param {string} userMessage
 */
export function isPhoneNumberQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isUrgentContactQuery(msg)) return false;
  // 予約方法が主目的なら電話番号質問にしない
  if (
    /予約方法|どう予約|予約の仕方|電話で予約|電話予約|予約できますか/.test(msg) &&
    !/電話番号|問い合わせ先|どこに電話|何番/.test(msg)
  ) {
    return false;
  }
  return (
    /電話番号|TEL|tel\b|問い合わせ先|連絡先/.test(msg) ||
    /(?:どこに|何番に|どの番号に)電話/.test(msg) ||
    /(?:予約の)?電話番号を教えて/.test(msg) ||
    /病院の電話番号|当院の電話番号|クリニックの電話番号/.test(msg)
  );
}

/**
 * 緊急性のある連絡希望（電話番号案内を許可）
 * @param {string} userMessage
 */
export function isUrgentContactQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  // 陣痛・破水など産科緊急の詳細は labor 側
  if (/陣痛|破水|胎動|大量出血|強い腹痛/.test(msg)) return false;
  return (
    /今すぐ.{0,8}(?:連絡|電話|病院)|すぐに.{0,8}(?:連絡|電話)|至急.{0,6}(?:連絡|電話)/.test(
      msg
    ) ||
    /(?:緊急で|急ぎで).{0,8}(?:電話|連絡)/.test(msg) ||
    /病院に(?:今すぐ)?連絡したい|すぐに受診したい/.test(msg)
  );
}

/**
 * サービス特定なしの予約方法・電話予約一般質問か
 * @param {string} userMessage
 */
export function isGenericReservationMethodQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isPhoneNumberQuery(msg)) return false;
  if (isUrgentContactQuery(msg)) return false;

  // サービス別は他モジュールへ
  if (
    /母乳ケア|母乳相談|おっぱいケア|授乳相談|母乳外来/.test(msg) ||
    /夜診|夜の診察|夕方の診察/.test(msg) ||
    /産前産後教室|マタニティ|ママフィット|ママヨガ|後期クラス|教室予約/.test(
      msg
    ) ||
    /WEB予約|ウェブ予約|ネット予約|オンライン予約/.test(msg) ||
    /当日予約|今日の予約|本日の予約/.test(msg) ||
    /里帰り|分娩予約|出産予約/.test(msg)
  ) {
    return false;
  }

  if (/電話で予約|電話予約|予約は電話|電話で診察予約/.test(msg)) return true;
  if (/初診の?予約方法|初めて.{0,8}予約|初めて受診する場合は予約/.test(msg)) {
    return true;
  }
  if (
    /予約方法|予約の仕方|予約はどうしたらいい|どうやって予約|予約をしたい|診察の予約方法/.test(
      msg
    )
  ) {
    return true;
  }
  if (/初めて受診したい|初めて来院したい|初診で受診したい/.test(msg)) {
    return true;
  }
  return false;
}

/**
 * @param {string} userMessage
 */
export function isAppointmentGuidanceQuery(userMessage) {
  return (
    isPhoneNumberQuery(userMessage) ||
    isUrgentContactQuery(userMessage) ||
    isGenericReservationMethodQuery(userMessage)
  );
}

/**
 * @param {string} userMessage
 * @returns {{
 *   answer: string,
 *   intent: string,
 *   focus: string,
 *   allowPhone: boolean,
 *   useExactAnswer: boolean,
 *   referencedPages: Array<{url:string,title:string}>,
 * }|null}
 */
export function buildAppointmentGuidanceAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isAppointmentGuidanceQuery(msg)) return null;

  const ref = [APPOINTMENT_GUIDANCE_REF_PAGE];

  if (isUrgentContactQuery(msg)) {
    return {
      answer: URGENT_CONTACT_ANSWER,
      intent: "urgent_clinic_contact",
      focus: "urgent_contact",
      allowPhone: true,
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  if (isPhoneNumberQuery(msg)) {
    return {
      answer: PHONE_NUMBER_GUIDANCE_ANSWER,
      intent: "clinic_phone_number",
      focus: "phone_number",
      allowPhone: false,
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  if (/初診|初めて受診|初めて来院|初めて当院/.test(msg)) {
    return {
      answer: FIRST_VISIT_RESERVATION_ANSWER,
      intent: "first_visit_reservation",
      focus: "first_visit",
      allowPhone: false,
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  return {
    answer: GENERIC_PHONE_RESERVATION_ANSWER,
    intent: "reservation_method_guidance",
    focus: "generic_phone_reservation",
    allowPhone: false,
    useExactAnswer: true,
    referencedPages: ref,
  };
}
