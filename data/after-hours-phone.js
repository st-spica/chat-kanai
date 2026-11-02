/**
 * 診療時間外の電話問い合わせ
 *
 * 症状が書かれていないときは詳細を聞かない。
 * 緊急症状が明示されているときは、この案内ではなく安全案内を優先する。
 */

export const AFTER_HOURS_PHONE_PAGE = {
  url: "https://kanai.or.jp/beginner/",
  title: "診療時間のご案内",
};

export const AFTER_HOURS_PHONE_ANSWER = [
  "お電話いただいたのに、",
  "診療時間外のご案内となり申し訳ございません。",
  "",
  "当院のお電話は診療時間内に対応しておりますので、",
  "お急ぎでない場合は、",
  "診療時間内に改めてご連絡いただけますと幸いです。",
  "",
  "なお、緊急の症状がある場合は、",
  "診療時間を待たずに、",
  "救急医療機関へご相談ください。",
].join("\n");

/** 時間外案内に混ぜてはいけない聞き返し */
export const AFTER_HOURS_SYMPTOM_PROBES = [
  "お身体のことでお急ぎのご相談でしょうか？",
  "その場合は、状況をお聞かせください。",
  "どのような症状がありますか？",
  "詳しい状況を教えてください。",
];

/**
 * 患者が明示した緊急症状。時間外・電話不通だけでは真にしない。
 * @param {string} userMessage
 */
export function hasExplicitEmergencySymptom(userMessage) {
  const msg = String(userMessage || "");
  return /破水|大量.{0,6}出血|出血が(?:多|止ま)|血が止まら|強い腹痛|激しい腹痛|胎動が(?:少|ない|減)|胎動減少|意識がもうろう|呼吸困難|けいれん|高熱|耐えられない痛/.test(
    msg
  );
}

/**
 * 電話がつながらない・時間外・休診中の電話問い合わせか
 * @param {string} userMessage
 */
export function isAfterHoursPhoneQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (hasExplicitEmergencySymptom(msg)) return false;
  if (/電話番号|番号を教えて|TEL|tel\b/.test(msg) && !/つながら|繋がら|時間外|出ない/.test(msg)) {
    return false;
  }
  if (
    /電話が(?:つなが|繋が)ら|電話(?:は|が)?出ない|呼び出し(?:ても)?.{0,8}(?:出ない|つながら|繋がら)/.test(
      msg
    )
  ) {
    return true;
  }
  if (/時間外と(?:言|い)われた|時間外でした|時間外の(?:案内|電話|対応|メッセージ)/.test(msg)) {
    return true;
  }
  if (/診療時間外|受付時間外|診察時間外|時間外(?:です|ですが|なので|のため)/.test(msg)) {
    return true;
  }
  if (/電話/.test(msg) && /時間外|休診|つながら|繋がら|出ない/.test(msg)) {
    return true;
  }
  return false;
}

/**
 * @param {string} userMessage
 */
export function buildAfterHoursPhoneAnswer(userMessage) {
  if (!isAfterHoursPhoneQuery(userMessage)) return null;
  return {
    answer: AFTER_HOURS_PHONE_ANSWER,
    intent: "after_hours_phone",
    useExactAnswer: true,
    referencedPages: [AFTER_HOURS_PHONE_PAGE],
  };
}
