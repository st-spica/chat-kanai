/**
 * マスクの着用と提供を混同しない
 */
import {
  buildMaskPolicyAnswer,
  isMaskPolicyQuery,
  isMaskProvisionQuery,
  isMaskWearingQuery,
  MASK_OUTPATIENT_DISTRIBUTION_ANSWER,
  MASK_POLICY_PAGE,
  MASK_WEAR_GENERAL_ANSWER,
  MASK_WEAR_OUTPATIENT_ANSWER,
  MASK_WEAR_VISITOR_ANSWER,
} from "../data/mask-policy.js";
import { detectClinicIntent, searchClinicKnowledge } from "../api/_clinicKnowledge.js";
import { detectClinicService } from "../data/site-route-map.js";
import { resolveConversationTopic } from "../data/conversation-topic.js";

const FORBIDDEN = [
  "提供は、入院",
  "限られます",
  "入院中の患者さまに限",
  "各自でご用意をお願いします",
  "無料で配っています",
  "マスクをもらえます",
];

const cases = [
  {
    q: "診察のときマスクは必要ですか？",
    purpose: "wear",
    intent: "mask_wearing",
    answer: MASK_WEAR_OUTPATIENT_ANSWER,
    hit: "mask-wearing-rules",
    absent: "mask-provision-unconfirmed",
  },
  {
    q: "患者もマスクをしないといけませんか？",
    purpose: "wear",
    intent: "mask_wearing",
    answer: MASK_WEAR_OUTPATIENT_ANSWER,
    hit: "mask-wearing-rules",
    absent: "mask-provision-unconfirmed",
  },
  {
    q: "面会者もマスクが必要ですか？",
    purpose: "wear",
    intent: "mask_wearing",
    answer: MASK_WEAR_VISITOR_ANSWER,
    hit: "mask-wearing-rules",
    absent: "mask-provision-unconfirmed",
  },
  {
    q: "マスクは患者さんだけですか？",
    purpose: "wear",
    intent: "mask_wearing",
    answer: MASK_WEAR_GENERAL_ANSWER,
    hit: "mask-wearing-rules",
    absent: "mask-provision-unconfirmed",
  },
  {
    q: "マスクは必要ですか？",
    purpose: "wear",
    intent: "mask_wearing",
    answer: MASK_WEAR_GENERAL_ANSWER,
    hit: "mask-wearing-rules",
    absent: "mask-provision-unconfirmed",
  },
  {
    q: "マスクを忘れたらもらえますか？",
    purpose: "provide",
    intent: "mask_provision",
    answer: MASK_OUTPATIENT_DISTRIBUTION_ANSWER,
    hit: "mask-provision-unconfirmed",
    absent: "mask-wearing-rules",
  },
  {
    q: "マスクは無料で配っていますか？",
    purpose: "provide",
    intent: "mask_provision",
    answer: MASK_OUTPATIENT_DISTRIBUTION_ANSWER,
    hit: "mask-provision-unconfirmed",
    absent: "mask-wearing-rules",
  },
];

let failed = 0;

for (const c of cases) {
  const built = buildMaskPolicyAnswer(c.q);
  const problems = [];
  if (c.purpose === "wear" && !isMaskWearingQuery(c.q)) problems.push("着用判定がfalse");
  if (c.purpose === "provide" && !isMaskProvisionQuery(c.q)) problems.push("提供判定がfalse");
  if (c.purpose === "wear" && isMaskProvisionQuery(c.q)) problems.push("着用を提供と判定");
  if (c.purpose === "provide" && isMaskWearingQuery(c.q)) problems.push("提供を着用と判定");
  if (built?.answer !== c.answer) problems.push("回答文が想定と違う");
  if (detectClinicIntent(c.q) !== c.intent) problems.push(`intent=${detectClinicIntent(c.q)}`);
  if (detectClinicService(c.q) !== "mask_policy") {
    problems.push(`service=${detectClinicService(c.q)}`);
  }
  if (resolveConversationTopic(c.q, []).detectedIntent !== c.intent) {
    problems.push(`topic=${resolveConversationTopic(c.q, []).detectedIntent}`);
  }
  const searched = await searchClinicKnowledge(c.q);
  const ids = (searched.hits || []).map((h) => h.item?.id);
  if (!ids.includes(c.hit)) problems.push(`hit不足: ${ids.join(",")}`);
  if (ids.includes(c.absent)) problems.push(`混入: ${c.absent}`);
  if (ids.includes("pregnancy-smell-sensitivity")) problems.push("においづわりがヒット");
  for (const s of FORBIDDEN) {
    if ((built?.answer || "").includes(s)) problems.push(`禁止表現: ${s}`);
  }
  if (/06-6931-2391/.test(built?.answer || "")) problems.push("電話番号");
  const chip = (built?.referencedPages || []).map((p) => p.url);
  if (!chip.includes(MASK_POLICY_PAGE.url)) problems.push("公式ページのチップがない");
  if (problems.length) {
    failed += 1;
    console.log("NG", c.q);
    for (const p of problems) console.log("  ", p);
  } else {
    console.log("OK", c.q);
  }
}

const staff = buildMaskPolicyAnswer("スタッフはマスクが必要ですか？");
if (
  !staff?.answer.includes("確認できません") ||
  /スタッフは1枚50円|スタッフは不要/.test(staff?.answer || "")
) {
  failed += 1;
  console.log("NG スタッフの配布を推測した", staff?.answer);
} else {
  console.log("OK スタッフへの50円配布は未確認");
}

const attendant = buildMaskPolicyAnswer("付き添いの人もマスクは必要ですか？");
if (
  !attendant?.answer.includes("付添い") ||
  !attendant?.answer.includes("着用") ||
  /付添いの方は1枚50円/.test(attendant?.answer || "")
) {
  failed += 1;
  console.log("NG 付添いの着用", attendant?.answer);
} else {
  console.log("OK 付添いは着用。50円は外来");
}

const inpatient = buildMaskPolicyAnswer("入院中の病室でもマスクは必要ですか？");
if (
  !inpatient?.answer.includes("院内全てのエリア") ||
  /入院中の方は1枚50円|限られます/.test(inpatient?.answer || "")
) {
  failed += 1;
  console.log("NG 入院中の着用", inpatient?.answer);
} else {
  console.log("OK 院内全てのエリア。50円は外来");
}

const visitForgot = buildMaskPolicyAnswer("面会でマスクを忘れたらもらえますか？");
if (
  !visitForgot?.answer.includes("外来診療") ||
  /面会の方へ、1枚50円/.test(visitForgot?.answer || "")
) {
  failed += 1;
  console.log("NG 面会の忘れに50円を適用した", visitForgot?.answer);
} else {
  console.log("OK 面会の忘れは外来の50円にしない");
}

if (isMaskPolicyQuery("においがつらくて外出時はマスクをしています")) {
  failed += 1;
  console.log("NG におい対策を院内ルールにした");
} else {
  console.log("OK におい対策は院内ルールにしない");
}

const continued = resolveConversationTopic("マスクは患者さんだけですか？", [
  { role: "user", content: "においがつらくて気持ち悪いです" },
]);
if (continued.detectedIntent !== "mask_wearing") {
  failed += 1;
  console.log("NG においの続きに吸われた", continued.detectedIntent);
} else {
  console.log("OK においの続きでも着用対象の質問");
}

if (failed) {
  console.log(`failed ${failed}`);
  process.exit(1);
}
console.log("all passed");
