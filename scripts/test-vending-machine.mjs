/**
 * 自動販売機は2026-10-26撤去。ミネラルウォーターは院内1本150円の販売予定。
 */
import {
  buildClinicFacilitiesAnswer,
  buildVendingMachineAnswer,
  isClinicFacilitiesQuery,
  isVendingMachineQuery,
  isVendingOrMineralWaterQuery,
  VENDING_MACHINE_REMOVED_ANSWER,
} from "../data/clinic-facilities.js";
import { detectClinicIntent, searchClinicKnowledge } from "../api/_clinicKnowledge.js";
import { detectClinicService } from "../data/site-route-map.js";
import { resolveConversationTopic } from "../data/conversation-topic.js";

const cases = [
  {
    q: "自動販売機はありますか？",
    must: ["2026年10月26日に撤去", "自動販売機はありません", "1本150円"],
    mustNot: ["自動販売機があります", "設置しています"],
  },
  {
    q: "自販機でジュースは買えますか？",
    must: ["撤去", "ありません", "150円"],
    mustNot: ["自販機があります", "自動販売機があります"],
  },
  {
    q: "ミネラルウォーターはいくらですか？",
    must: ["1本150円", "販売する予定"],
    mustNot: ["自動販売機があります"],
  },
  {
    q: "水は売っていますか？",
    must: ["150円", "販売する予定"],
    mustNot: ["自動販売機があります"],
  },
];

let failed = 0;

for (const c of cases) {
  const built = buildVendingMachineAnswer(c.q);
  const answer = built?.answer || "";
  const intent = detectClinicIntent(c.q);
  const service = detectClinicService(c.q);
  const topic = resolveConversationTopic(c.q, []);
  const searched = await searchClinicKnowledge(c.q);
  const problems = [];
  if (!isVendingOrMineralWaterQuery(c.q)) problems.push("query判定がfalse");
  if (isClinicFacilitiesQuery(c.q)) problems.push("施設概要に吸われた");
  if (answer !== VENDING_MACHINE_REMOVED_ANSWER) problems.push("回答文が固定文と違う");
  if (intent !== "vending_machine") problems.push(`intent=${intent}`);
  if (service !== "vending_machine") problems.push(`service=${service}`);
  if (topic?.detectedIntent !== "vending_machine") {
    problems.push(`topic=${topic?.detectedIntent}`);
  }
  const ids = (searched.hits || []).map((h) => h.item?.id).filter(Boolean);
  if (!ids.includes("vending-machine-removed")) {
    problems.push(`hitに撤去情報がない: ${ids.join(",")}`);
  }
  if (ids.includes("clinic-facilities")) {
    problems.push("施設概要がヒットした");
  }
  for (const s of c.must) {
    if (!answer.includes(s)) problems.push(`不足: ${s}`);
  }
  for (const s of c.mustNot) {
    if (answer.includes(s)) problems.push(`余剰: ${s}`);
  }
  if ((built?.referencedPages || []).length) problems.push("関連ページが付いた");
  if (problems.length) {
    failed += 1;
    console.log("NG", c.q, problems.join(" / "), "hits", ids);
  } else {
    console.log("OK", c.q);
  }
}

if (isVendingMachineQuery("自動受付機はありますか？")) {
  failed += 1;
  console.log("NG 自動受付機を自販機と判定した");
} else {
  console.log("OK 自動受付機は自販機ではない");
}

const facilities = buildClinicFacilitiesAnswer("院内施設について知りたい");
if (!facilities?.answer || /自動販売機|150円/.test(facilities.answer)) {
  failed += 1;
  console.log("NG 施設概要に自販機の話が混ざった");
} else {
  console.log("OK 施設概要は自販機の話を混ぜない");
}

if (failed) {
  console.log(`failed ${failed}`);
  process.exit(1);
}
console.log("all passed");
