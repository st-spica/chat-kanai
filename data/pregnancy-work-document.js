/**
 * 妊娠中の勤務調整・休業のための書類案内
 *
 * 確定: 母性健康管理指導事項連絡カード（母健連絡カード）
 * - 記入希望時は受診が必要
 * - 医師が診察で症状・体調を確認し、必要に応じて記入
 * - 記入を無条件に保証しない
 *
 * 診断書・傷病手当金等とは混同しない。
 * 費用・未確認書類の発行可否は推測しない。
 * 通常回答では電話番号を出さない。
 */

export const WORK_DOCUMENT_REF_PAGE = {
  url: "https://kanai.or.jp/beginner/",
  title: "初めての方へ・ご受診のご案内",
};

export const MATERNITY_HEALTH_CARD_NAME =
  "母性健康管理指導事項連絡カード（母健連絡カード）";

/** 院内確認済みの確定情報 */
export const PREGNANCY_WORK_DOCUMENT = {
  maternityHealthCard: {
    fullName: "母性健康管理指導事項連絡カード",
    shortName: "母健連絡カード",
    purpose:
      "妊娠中の健康状態に応じた医師等の指導事項を勤務先へ伝えるための書類",
    visitRequired: true,
    doctorJudgmentRequired: true,
    guaranteed: false,
  },
};

export const WORK_DOCUMENT_BASIC_ANSWER = [
  "つわりがおつらいのですね。",
  "お仕事への影響も心配かと思います。",
  "",
  "お仕事を休むための書類として、",
  "『母性健康管理指導事項連絡カード",
  "（母健連絡カード）』があります。",
  "",
  "当院では、受診時に医師が症状や体調を確認し、",
  "必要に応じて記入いたします。",
  "",
  "書類の記入には診察が必要となりますので、",
  "ご希望の場合はご受診ください。",
].join("\n");

/**
 * 勤務調整・休業書類の相談か
 * （「つわり」単独の一般相談とは分離）
 * @param {string} userMessage
 */
export function isPregnancyWorkDocumentQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;

  // 明示の母健連絡カード
  if (
    /母健連絡カード|母性健康管理指導事項連絡カード|母性健康管理カード|母健カード/.test(
      msg
    )
  ) {
    return true;
  }

  // つわり／妊娠＋診断書（診断書と母健カードを分離して案内）
  if (
    /つわり|悪阻|妊娠|妊婦/.test(msg) &&
    /診断書/.test(msg)
  ) {
    return true;
  }

  // 妊娠・つわり等と、勤務／書類／会社の組み合わせ
  const pregnancyContext =
    /つわり|悪阻|妊娠|妊婦|体調|吐き気|吐/.test(msg) ||
    /勤務|仕事|会社|休職|出勤|休業|休みたい|休め/.test(msg);

  const workSignal =
    /仕事|勤務|会社|出勤|休職|休業|休みたい|休め|休む|勤務時間|時短|短くしたい/.test(
      msg
    );

  const documentSignal =
    /書類|診断書|証明書|カード|書いて|書いてもら|書いてくれ|発行|提出/.test(
      msg
    );

  // 母健カード以外でも、妊娠関連の勤務調整＋書類
  if (pregnancyContext && workSignal && documentSignal) return true;

  // 「つわりで仕事を休みたい」「妊娠中なので休職したい」など書類明示なしでも勤務調整相談
  if (
    (/つわり|悪阻|妊娠中|妊婦/.test(msg) &&
      /仕事を休|仕事が休|休めない|休めませ|休みたい|休職|出勤でき|勤務時間|時短|短くしたい/.test(
        msg
      )) ||
    (/妊娠中|妊婦/.test(msg) && /休職|勤務時間|時短/.test(msg))
  ) {
    return true;
  }

  // 会社提出用書類（妊娠文脈）
  if (
    /会社に提出|会社へ提出|勤務先に提出|会社提出/.test(msg) &&
    /書類|診断書|証明書|カード/.test(msg)
  ) {
    return true;
  }

  // 「病院で何か書いてもらえる」＋仕事／休み
  if (
    /病院で.{0,12}書|何か書いてもら|書類を書いて/.test(msg) &&
    /仕事|休|会社|勤務/.test(msg)
  ) {
    return true;
  }

  return false;
}

/**
 * @param {string} msg
 */
function asksDiagnosisCertificate(msg) {
  return /診断書/.test(msg);
}

/**
 * @param {string} msg
 */
function asksWithoutVisit(msg) {
  return (
    /受診し(?:ない|なくても)|来院し(?:ない|なくても)|行かなくても|診察なし|電話で書|チャットで|オンラインで発行|受診しないと/.test(
      msg
    )
  );
}

/**
 * @param {string} msg
 */
function asksShorterHours(msg) {
  return /勤務時間|時短|短くしたい|短時間勤務|勤務を短/.test(msg);
}

/**
 * @param {string} msg
 */
function mentionsMorningSickness(msg) {
  return /つわり|悪阻/.test(msg);
}

/**
 * 医療安全を優先すべき重い症状
 * @param {string} msg
 */
export function hasSevereMorningSicknessSymptoms(msg) {
  const t = String(msg || "");
  return (
    /水分.{0,10}(?:とれ|取れ|飲め)(?:ない|ません)|水も(?:飲め|とれ|取れ)(?:ない|ません)|水分も(?:とれ|取れ)/.test(
      t
    ) ||
    /(?:飲んでも)?繰り返し吐|何度も吐|吐いてばかり/.test(t) ||
    /尿が極端に少|おしっこ.{0,6}出ない|尿が少ない/.test(t) ||
    /強いふらつき|ふらつきが強/.test(t) ||
    /意識.{0,6}もうろう|もうろうとしている/.test(t)
  );
}

/**
 * @param {string} msg
 */
function isUrgentSymptom(msg) {
  return /意識.{0,6}もうろう|もうろう|立てない|強い腹痛|大量.{0,4}出血/.test(
    msg
  );
}

/**
 * @param {string} userMessage
 * @returns {{
 *   answer: string,
 *   intent: string,
 *   focus: string,
 *   useExactAnswer: boolean,
 *   medicalSafetyLevel: "urgent"|"consult"|"information",
 *   referencedPages: Array<{url:string,title:string}>,
 * }|null}
 */
export function buildPregnancyWorkDocumentAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isPregnancyWorkDocumentQuery(msg)) return null;

  const ref = [WORK_DOCUMENT_REF_PAGE];

  // 重い症状 → 医療安全優先（書類だけで終わらせない）
  if (isUrgentSymptom(msg) || hasSevereMorningSicknessSymptoms(msg)) {
    const empathy = mentionsMorningSickness(msg)
      ? "つわりがおつらいのですね。水分も十分にとれない状態は心配です。"
      : "おつらい症状があるとのこと、心配です。";
    return {
      answer: [
        empathy,
        "",
        "脱水などにつながるおそれがあるため、",
        "書類の手続きより先に、できるだけ早く医療機関へご相談・ご受診ください。",
        "",
        "なお、お仕事を休むための書類として",
        "『母性健康管理指導事項連絡カード（母健連絡カード）』があります。",
        "記入には診察が必要で、医師が症状や体調を確認し、必要に応じて記入します。",
        "ご希望の場合は受診時にご相談ください。",
      ].join("\n"),
      intent: "pregnancy_work_accommodation_document",
      focus: "severe_symptoms",
      useExactAnswer: true,
      medicalSafetyLevel: isUrgentSymptom(msg) ? "urgent" : "consult",
      referencedPages: ref,
    };
  }

  // 診断書（母健連絡カードと混同しない）
  if (asksDiagnosisCertificate(msg) && !/母健|母性健康管理/.test(msg)) {
    const empathy = mentionsMorningSickness(msg)
      ? "つわりがおつらいのですね。\nお仕事への影響も心配かと思います。\n\n"
      : "";
    return {
      answer: [
        empathy +
          "ご質問の『診断書』と、妊娠中の勤務調整などで使う",
        "『母性健康管理指導事項連絡カード（母健連絡カード）』は、",
        "別の書類です。",
        "",
        "妊娠中の症状に応じて勤務先へ医師の指導事項を伝える書類としては、",
        "母健連絡カードがあります。",
        "当院で記入を希望される場合は受診が必要で、",
        "医師が診察で症状や体調を確認し、必要に応じて記入します。",
        "",
        "診断書そのものの発行内容や費用などについては、",
        "こちらでは断定できませんので、ご受診のうえご相談ください。",
      ].join("\n"),
      intent: "pregnancy_work_accommodation_document",
      focus: "diagnosis_certificate",
      useExactAnswer: true,
      medicalSafetyLevel: "information",
      referencedPages: ref,
    };
  }

  // 受診なしで発行できるか
  if (asksWithoutVisit(msg)) {
    return {
      answer: [
        "母性健康管理指導事項連絡カード（母健連絡カード）の記入には、",
        "診察が必要です。",
        "",
        "受診せずに、お電話やチャットだけで発行・記入することはできません。",
        "",
        "医師が診察で症状や体調を確認し、必要に応じて記入します。",
        "ご希望の場合はご受診ください。",
        "",
        "受診の流れについては、下記のページもご確認ください。",
      ].join("\n"),
      intent: "pregnancy_work_accommodation_document",
      focus: "visit_required",
      useExactAnswer: true,
      medicalSafetyLevel: "information",
      referencedPages: ref,
    };
  }

  // 勤務時間短縮
  if (asksShorterHours(msg)) {
    return {
      answer: [
        "妊娠中の勤務時間の調整について、会社へ医師の指導事項を伝える書類として、",
        "『母性健康管理指導事項連絡カード（母健連絡カード）』があります。",
        "",
        "当院では、受診時に医師が症状や体調を確認し、",
        "必要に応じて記入いたします。",
        "",
        "必ず記入されることをお約束するものではありません。",
        "ご希望の場合はご受診ください。",
      ].join("\n"),
      intent: "pregnancy_work_accommodation_document",
      focus: "shorter_hours",
      useExactAnswer: true,
      medicalSafetyLevel: "information",
      referencedPages: ref,
    };
  }

  // 母健カード明示（つわり共感は症状言及時のみ）
  if (/母健連絡カード|母性健康管理指導事項連絡カード|母性健康管理カード|母健カード/.test(msg)) {
    const empathy = mentionsMorningSickness(msg)
      ? "つわりがおつらいのですね。\n\n"
      : "";
    return {
      answer: [
        empathy +
          "はい、『母性健康管理指導事項連絡カード（母健連絡カード）』は、",
        "妊娠中の健康状態に応じた指導事項を勤務先へ伝えるための書類です。",
        "",
        "当院で記入を希望される場合は受診が必要です。",
        "医師が診察で症状や体調を確認し、必要に応じて記入します。",
        "",
        "必ず記入されることをお約束するものではありません。",
        "ご希望の場合はご受診ください。",
      ].join("\n"),
      intent: "pregnancy_work_accommodation_document",
      focus: "maternity_health_card",
      useExactAnswer: true,
      medicalSafetyLevel: "information",
      referencedPages: ref,
    };
  }

  // つわり＋仕事を休みたい／書類（基本回答）
  if (mentionsMorningSickness(msg) || /仕事を休|休みたい|休職|出勤でき/.test(msg)) {
    // 基本文はつわり共感付き。つわり語が無い場合は言い換え
    if (mentionsMorningSickness(msg)) {
      return {
        answer: WORK_DOCUMENT_BASIC_ANSWER,
        intent: "pregnancy_work_accommodation_document",
        focus: "basic_with_sickness",
        useExactAnswer: true,
        medicalSafetyLevel: "information",
        referencedPages: ref,
      };
    }
    return {
      answer: [
        "お仕事への影響が心配なのですね。",
        "",
        "妊娠中の症状によりお仕事を休む・調整するための書類として、",
        "『母性健康管理指導事項連絡カード（母健連絡カード）』があります。",
        "",
        "当院では、受診時に医師が症状や体調を確認し、",
        "必要に応じて記入いたします。",
        "",
        "書類の記入には診察が必要となりますので、",
        "ご希望の場合はご受診ください。",
      ].join("\n"),
      intent: "pregnancy_work_accommodation_document",
      focus: "work_leave",
      useExactAnswer: true,
      medicalSafetyLevel: "information",
      referencedPages: ref,
    };
  }

  // 会社提出用書類など一般
  return {
    answer: [
      "会社へ提出する書類のうち、妊娠中の健康状態に応じた指導事項を伝えるものとして、",
      "『母性健康管理指導事項連絡カード（母健連絡カード）』があります。",
      "",
      "当院で記入を希望される場合は受診が必要です。",
      "医師が診察で症状や体調を確認し、必要に応じて記入します。",
      "",
      "必ず記入されることをお約束するものではありません。",
      "ご希望の場合はご受診ください。",
    ].join("\n"),
    intent: "pregnancy_work_accommodation_document",
    focus: "company_document",
    useExactAnswer: true,
    medicalSafetyLevel: "information",
    referencedPages: ref,
  };
}
