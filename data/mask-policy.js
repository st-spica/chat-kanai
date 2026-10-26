/**
 * 院内のマスク：着用ルールと配布を分ける。
 *
 * 公式（2026-10-20公開）:
 * https://kanai.or.jp/令和8年11月01日以降のマスク着用と有料化について/
 * - 院内全てのエリアでマスク着用
 * - 病棟エリアへの面会・付添いも着用
 * - 外来診療時に未持参の方は、令和8年10月31日まで無料、11月1日から1枚50円
 * - 忘れは受付へ。マスク代は会計時に精算
 *
 * 50円配布を面会・入院・スタッフへ広げない。
 * 「マスク」という語だけでは配布知識を選ばない。
 * においづわり対策のマスク、入院持ち物の持参確認とは混ぜない。
 */

export const MASK_POLICY_PAGE = {
  url: "https://kanai.or.jp/%e4%bb%a4%e5%92%8c8%e5%b9%b411%e6%9c%8801%e6%97%a5%e4%bb%a5%e9%99%8d%e3%81%ae%e3%83%9e%e3%82%b9%e3%82%af%e7%9d%80%e7%94%a8%e3%81%a8%e6%9c%96%e6%96%99%e5%8c%96%e3%81%ab%e3%81%a4%e3%81%84%e3%81%a6/",
  title: "令和8年11月01日以降のマスク着用と有料化について",
};

export const MASK_WEAR_GENERAL_ANSWER = [
  "当院では感染防止のため、院内全てのエリアでマスクの着用をお願いしております。",
  "受診される患者さま、面会の方、病棟へ付添いの方も対象です。",
  "",
  "ご来院の際はマスクをご用意ください。外来診療時にマスクをお持ちでない方には、令和8年11月1日から1枚50円でお配りします。",
].join("\n");

export const MASK_WEAR_OUTPATIENT_ANSWER = [
  "はい。外来診療でも、マスクの着用をお願いしております。",
  "ご来院の際はマスクをご用意ください。",
  "",
  "令和8年11月1日からは、外来診療時にマスクをお持ちでない方へ1枚50円でお配りします。お忘れの場合は受付スタッフにお声がけください。マスク代は会計時に精算します。",
].join("\n");

export const MASK_WEAR_VISITOR_ANSWER = [
  "はい。病棟エリアへ面会の方にも、マスクの着用をお願いしております。",
  "ご来院の際はマスクをご用意ください。",
  "",
  "1枚50円の配布は、外来診療時にマスクをお持ちでない方への案内です。",
].join("\n");

export const MASK_WEAR_BIRTH_ATTENDANT_ANSWER = [
  "立ち会いの方にも、入館の際のマスク着用をお願いしています。院内全てのエリアが対象です。",
  "",
  "1枚50円の配布は、外来診療時にマスクをお持ちでない方への案内です。",
].join("\n");

export const MASK_WEAR_STAFF_ANSWER = [
  "院内全てのエリアでマスクの着用をお願いしております。",
  "",
  "スタッフだけを対象にしたルールや、スタッフへの有料配布は、この案内では確認できません。1枚50円の配布は、外来診療時にマスクをお持ちでない方への案内です。",
].join("\n");

export const MASK_WEAR_ATTENDANT_ANSWER = [
  "はい。病棟エリアへ付添いの方にも、マスクの着用をお願いしております。",
  "ご来院の際はマスクをご用意ください。",
  "",
  "1枚50円の配布は、外来診療時にマスクをお持ちでない方への案内です。",
].join("\n");

export const MASK_WEAR_INPATIENT_ANSWER = [
  "院内全てのエリアでマスクの着用をお願いしております。入院中のエリアも対象です。",
  "",
  "1枚50円の配布は、外来診療時にマスクをお持ちでない方への案内です。",
].join("\n");

export const MASK_OUTPATIENT_DISTRIBUTION_ANSWER = [
  "外来診療時にマスクをお持ちでない方への配布は、令和8年10月31日までは無料、令和8年11月1日からは1枚50円です。",
  "",
  "お忘れの場合は受付スタッフにお声がけください。マスク代は会計時に精算します。",
].join("\n");

export const MASK_NON_OUTPATIENT_DISTRIBUTION_ANSWER = [
  "1枚50円の配布は、外来診療時にマスクをお持ちでない方への案内です。",
  "面会・付添い・入院中の方への配布料金は、この案内では確認できません。",
  "",
  "院内全てのエリアでマスクの着用をお願いしておりますので、ご来院の際はマスクをご用意ください。",
].join("\n");

export const MASK_ADMISSION_BELONGINGS_ANSWER = [
  "入院の際のマスクは、ご用意いただく物に含まれます。",
  "",
  "1枚50円の配布は、外来診療時にマスクをお持ちでない方への案内です。入院の持ち物としての配布料金は、この案内では確認できません。",
].join("\n");

const PROVISION_RE =
  /もら(?:え|える|えます|った|いたい|えるか)|くれ(?:る|ます|ますか)|配布|配っ|配付|無料|有料|提供|忘れた|忘れ|買い忘れ|持って(?:ない|いない)|お持ちで(?:ない|ありません)|予備|販売して|売って|50円|料金|いくら|値段|価格/;

const WEARING_RE =
  /必要|着用|つけな|着けな|しないと|しなきゃ|しなければ|必須|ルール|だけ(?:です|ですか|かな)|誰|だれ|患者(?:さん|さま)?だけ|してくださ|お願いします|しなくて|着ける|つける|マスク(?:は|を)?(?:し|着|つ)/;

/**
 * においづわりの対策としてのマスク。院内ルールの質問ではない。
 * @param {string} msg
 */
function isSmellCountermeasureMask(msg) {
  if (!/におい|匂い|臭い|つわり|悪阻/.test(msg)) return false;
  return !/受診|診察|外来|面会|患者|来院|着用|もら|配布|無料|提供/.test(msg);
}

/**
 * 入院持ち物としての持参確認。着用ルールや提供の質問は含めない。
 * @param {string} msg
 */
function isAdmissionMaskBelongingsQuery(msg) {
  if (!/マスク/.test(msg)) return false;
  if (!/入院|出産|分娩|陣痛バッグ|入院バッグ/.test(msg)) return false;
  if (!/持ち物|持参|持っていく|持っていけ|バッグに/.test(msg)) return false;
  if (PROVISION_RE.test(msg)) return false;
  if (/着用|診察|受診|外来|面会|だけ/.test(msg)) return false;
  return true;
}

/**
 * @param {string} msg
 * @returns {"outpatient"|"inpatient"|"visitor"|"attendant"|"birth_attendant"|"staff"|"patient"}[]
 */
export function maskAudiences(msg) {
  const text = String(msg || "");
  /** @type {string[]} */
  const roles = [];
  if (/受診|診察|外来|通院/.test(text)) roles.push("outpatient");
  if (/入院患者|入院中|病室/.test(text)) roles.push("inpatient");
  if (/面会|お見舞い/.test(text)) roles.push("visitor");
  if (/立ち?会[いえ]|立会い|立ち合い/.test(text)) roles.push("birth_attendant");
  if (/付き添|付添/.test(text) && !roles.includes("birth_attendant")) {
    roles.push("attendant");
  }
  if (/スタッフ|職員|看護師|医師|先生/.test(text)) roles.push("staff");
  if (/患者/.test(text) && !roles.includes("inpatient") && !roles.includes("outpatient")) {
    roles.push("patient");
  }
  return roles;
}

/**
 * @param {string} userMessage
 * @returns {"wear"|"provide"|"belongings"|null}
 */
export function maskPolicyPurpose(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!/マスク/.test(msg)) return null;
  if (isSmellCountermeasureMask(msg)) return null;
  if (isAdmissionMaskBelongingsQuery(msg)) return "belongings";
  if (PROVISION_RE.test(msg)) return "provide";
  if (WEARING_RE.test(msg)) return "wear";
  if (/マスク(?:は|って|について|のルール|の着用)/.test(msg)) return "wear";
  return null;
}

/**
 * @param {string} userMessage
 */
export function isMaskPolicyQuery(userMessage) {
  return maskPolicyPurpose(userMessage) != null;
}

/**
 * @param {string} userMessage
 */
export function isMaskWearingQuery(userMessage) {
  return maskPolicyPurpose(userMessage) === "wear";
}

/**
 * @param {string} userMessage
 */
export function isMaskProvisionQuery(userMessage) {
  return maskPolicyPurpose(userMessage) === "provide";
}

/**
 * 着用対象の範囲を聞いている（「患者さんだけ？」）
 * @param {string} msg
 */
function isWearingScopeQuestion(msg) {
  return /だけ(?:です|ですか|かな|なの)|患者(?:さん|さま)?だけ|誰が|だれが|誰も/.test(msg);
}

/**
 * @param {string} userMessage
 * @returns {{
 *   answer: string,
 *   intent: string,
 *   focus: string,
 *   purpose: "wear"|"provide"|"belongings",
 *   audiences: string[],
 *   useExactAnswer: boolean,
 *   referencedPages: Array<{url:string,title:string}>,
 * }|null}
 */
export function buildMaskPolicyAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  const purpose = maskPolicyPurpose(msg);
  if (!purpose) return null;
  const pages = [MASK_POLICY_PAGE];

  if (purpose === "provide") {
    const audiences = maskAudiences(msg);
    const only = (role) => audiences.length === 1 && audiences[0] === role;
    const outpatient =
      audiences.length === 0 ||
      audiences.includes("outpatient") ||
      audiences.includes("patient");
    const answer = outpatient
      ? MASK_OUTPATIENT_DISTRIBUTION_ANSWER
      : only("staff")
        ? MASK_WEAR_STAFF_ANSWER
        : MASK_NON_OUTPATIENT_DISTRIBUTION_ANSWER;
    return {
      answer,
      intent: "mask_provision",
      focus: outpatient ? "outpatient_paid" : "provision_other",
      purpose,
      audiences,
      useExactAnswer: true,
      referencedPages: pages,
    };
  }

  if (purpose === "belongings") {
    return {
      answer: MASK_ADMISSION_BELONGINGS_ANSWER,
      intent: "mask_provision",
      focus: "admission_belongings",
      purpose,
      audiences: maskAudiences(msg),
      useExactAnswer: true,
      referencedPages: pages,
    };
  }

  const audiences = maskAudiences(msg);
  const only = (role) => audiences.length === 1 && audiences[0] === role;

  let answer = MASK_WEAR_GENERAL_ANSWER;
  let focus = "general";

  if (isWearingScopeQuestion(msg) || audiences.length === 0 || audiences.length > 1) {
    answer = MASK_WEAR_GENERAL_ANSWER;
    focus = isWearingScopeQuestion(msg) ? "scope" : "general";
  } else if (only("staff")) {
    answer = MASK_WEAR_STAFF_ANSWER;
    focus = "staff";
  } else if (only("attendant")) {
    answer = MASK_WEAR_ATTENDANT_ANSWER;
    focus = "attendant";
  } else if (only("birth_attendant")) {
    answer = MASK_WEAR_BIRTH_ATTENDANT_ANSWER;
    focus = "birth_attendant";
  } else if (only("inpatient")) {
    answer = MASK_WEAR_INPATIENT_ANSWER;
    focus = "inpatient";
  } else if (only("visitor")) {
    answer = MASK_WEAR_VISITOR_ANSWER;
    focus = "visitor";
  } else if (only("outpatient") || only("patient")) {
    answer = MASK_WEAR_OUTPATIENT_ANSWER;
    focus = only("patient") ? "patient" : "outpatient";
  }

  return {
    answer,
    intent: "mask_wearing",
    focus,
    purpose,
    audiences,
    useExactAnswer: true,
    referencedPages: pages,
  };
}
