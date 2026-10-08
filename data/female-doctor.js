/**
 * 女性医師・医師指名の確定案内
 *
 * 公式: https://kanai.or.jp/beginner/#doctor_schedule
 * 診療体制は変更され得るため、曜日・時間はハードコードしない。
 * （体制表の医師名はページ上でJS描画のため、静的HTMLからは取得できない）
 */

export const DOCTOR_SCHEDULE_REF_PAGE = {
  url: "https://kanai.or.jp/beginner/#doctor_schedule",
  title: "診療体制表はこちら",
};

export const FEMALE_DOCTOR = {
  femaleDoctorAvailable: true,
  doctorDesignationAllowed: false,
};

const FEMALE_DOC_RE =
  /女性医師|女性の医師|女医|女性の先生|女性のドクター|女性ドクター|女性の先生方/;

/**
 * @param {string} text
 */
export function mentionsFemaleDoctor(text) {
  return FEMALE_DOC_RE.test(String(text || ""));
}

/**
 * @param {string} text
 */
export function mentionsDoctorDesignation(text) {
  const t = String(text || "");
  return (
    /指名|担当医を選|先生を選|医師を選|希望して受診|指定して/.test(t) ||
    (/予約/.test(t) && mentionsFemaleDoctor(t))
  );
}

/**
 * 男性医師の質問（女性医師知識を流用しない）
 * @param {string} msg
 */
export function isMaleDoctorQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (mentionsFemaleDoctor(msg)) return false;
  return /男性医師|男性の医師|男医|男性の先生|男性のドクター/.test(msg);
}

/**
 * @param {string} userMessage
 */
export function isFemaleDoctorQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isMaleDoctorQuery(msg)) return false;

  if (mentionsFemaleDoctor(msg)) return true;

  // 一般の医師指名（女性文脈なしでも指名不可は同じ）
  if (
    /(?:担当医|先生|医師).{0,8}(?:指名|選[べえ]|選べる|希望)/.test(msg) ||
    /(?:指名|選[べえ]).{0,8}(?:担当医|先生|医師)/.test(msg) ||
    /先生の指名|医師の指名|担当医を選べ/.test(msg)
  ) {
    return true;
  }

  return false;
}

/**
 * @param {string} userMessage
 * @returns {{
 *   answer: string,
 *   intent: string,
 *   focus: string,
 *   referencedPages: Array<{url:string,title:string}>,
 * }|null}
 */
export function buildFemaleDoctorAnswer(userMessage) {
  const msg = String(userMessage || "").trim();

  // 男性医師
  if (isMaleDoctorQuery(msg)) {
    return {
      answer: [
        "当院には男性医師・女性医師が在籍しております。",
        "",
        "医師の指名は承っておりません。",
        "診療日時については、下記の診療体制表をご確認ください。",
      ].join("\n"),
      intent: "female_doctor",
      focus: "male_doctor",
      referencedPages: [DOCTOR_SCHEDULE_REF_PAGE],
    };
  }

  if (!isFemaleDoctorQuery(msg)) return null;

  const ref = [DOCTOR_SCHEDULE_REF_PAGE];
  const wantsDesignation = mentionsDoctorDesignation(msg);
  const wantsSchedule =
    /何曜日|いつ|診療時間|診療日時|スケジュール|体制表|曜日/.test(msg);
  const female = mentionsFemaleDoctor(msg);

  // 指名・予約で医師を指定できるか
  if (wantsDesignation) {
    if (female) {
      return {
        answer: [
          "当院には女性医師が在籍しておりますが、",
          "医師の指名は承っておりません。",
          "",
          "女性医師をご希望の場合は、",
          "下記の診療体制表をご確認のうえ、",
          "診療日時を合わせてご来院ください。",
        ].join("\n"),
        intent: "female_doctor",
        focus: "designation",
        referencedPages: ref,
      };
    }
    return {
      answer: [
        "医師の指名は承っておりません。",
        "",
        "ご希望の条件がある場合は、下記の診療体制表をご確認のうえ、",
        "診療日時を合わせてご来院ください。",
      ].join("\n"),
      intent: "female_doctor",
      focus: "designation_general",
      referencedPages: ref,
    };
  }

  // 何曜日・診療時間
  if (wantsSchedule && female) {
    return {
      answer: [
        "女性医師の診療日時は、当院の診療体制表でご案内しています。",
        "",
        "診療体制が変更となる場合もありますので、",
        "下記のページをご確認ください。",
      ].join("\n"),
      intent: "female_doctor",
      focus: "schedule",
      referencedPages: ref,
    };
  }

  // 診てもらいたい／希望（指名断定はせず体制表へ）
  if (female && /診てもら|希望|受けたい|お願い/.test(msg)) {
    return {
      answer: [
        "当院には女性医師が在籍しております。",
        "",
        "医師の指名は承っておりませんので、",
        "下記の診療体制表をご確認のうえ、",
        "診療日時を合わせてご来院ください。",
      ].join("\n"),
      intent: "female_doctor",
      focus: "prefer_visit",
      referencedPages: ref,
    };
  }

  // 在籍確認
  if (female) {
    return {
      answer: [
        "はい、当院には女性医師が在籍しております。",
        "",
        "女性医師の診療日時については、",
        "下記の診療体制表をご確認ください。",
      ].join("\n"),
      intent: "female_doctor",
      focus: "availability",
      referencedPages: ref,
    };
  }

  return {
    answer: [
      "医師の指名は承っておりません。",
      "診療体制については、下記の診療体制表をご確認ください。",
    ].join("\n"),
    intent: "female_doctor",
    focus: "designation_general",
    referencedPages: ref,
  };
}
