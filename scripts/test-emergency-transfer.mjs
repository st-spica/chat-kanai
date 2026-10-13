/**
 * 母体・新生児救急搬送（OGCS/NMCS）テスト
 */
import {
  isEmergencyMaternalNeonatalTransferQuery,
  buildEmergencyMaternalNeonatalTransferAnswer,
  EMERGENCY_TRANSFER_REF_PAGE,
} from "../data/emergency-maternal-neonatal-transfer.js";
import { detectClinicIntent, searchClinicKnowledge } from "../api/_clinicKnowledge.js";
import { resolveConversationTopic } from "../data/conversation-topic.js";
import { preferredUrlsForMessage } from "../data/site-route-map.js";

const cases = [
  {
    q: "出産時に何かあったら搬送されますか？",
    focus: ["overview", "maternal_ogcs", "neonatal_nmcs"],
    must: ["OGCS", "NMCS", "救急搬送"],
    mustNot: ["受診時に医師にお尋ね"],
  },
  {
    q: "赤ちゃんに異常があったらどうなりますか？",
    focus: ["neonatal_nmcs", "overview"],
    must: ["OGCS", "NMCS"],
    mustNot: ["NICUがあります"],
  },
  {
    q: "母体搬送の体制はありますか？",
    focus: ["maternal_ogcs", "overview"],
    must: ["OGCS"],
    mustNot: [],
  },
  {
    q: "どこの病院に搬送されますか？",
    focus: ["destination"],
    must: ["状況に応じて", "お約束することはできません"],
    mustNot: ["必ず", "必ず搬送"],
  },
  {
    q: "金井産婦人科にはNICUがありますか？",
    focus: ["nicu_vs_transfer"],
    must: ["NMCS"],
    mustNot: ["NICUがあります", "NICUを設置"],
  },
  {
    q: "もし出産時に何かあった時は、他の病院に搬送されるんですか？",
    focus: ["overview", "maternal_ogcs", "neonatal_nmcs"],
    must: ["OGCS", "NMCS"],
    mustNot: [],
  },
];

let fail = 0;

for (const c of cases) {
  const problems = [];
  const hit = isEmergencyMaternalNeonatalTransferQuery(c.q);
  if (!hit) problems.push("detector=false");
  const intent = detectClinicIntent(c.q);
  const topic = resolveConversationTopic(c.q, []).detectedIntent;
  if (intent !== "emergency_maternal_neonatal_transfer") {
    problems.push(`intent=${intent}`);
  }
  if (topic !== "emergency_maternal_neonatal_transfer") {
    problems.push(`topic=${topic}`);
  }
  const built = buildEmergencyMaternalNeonatalTransferAnswer(c.q);
  if (!built) problems.push("no built answer");
  else {
    if (!c.focus.includes(built.focus)) problems.push(`focus=${built.focus}`);
    for (const m of c.must) {
      if (!built.answer.includes(m)) problems.push(`missing ${m}`);
    }
    for (const m of c.mustNot) {
      if (built.answer.includes(m)) problems.push(`forbidden ${m}`);
    }
    const url = built.referencedPages?.[0]?.url;
    if (url !== EMERGENCY_TRANSFER_REF_PAGE.url) {
      problems.push(`chip=${url}`);
    }
  }
  const routes = preferredUrlsForMessage(c.q);
  if (!routes.some((u) => /about\/feature/.test(u))) {
    problems.push(`route missing feature: ${routes.slice(0, 3).join(",")}`);
  }
  const searched = await searchClinicKnowledge(c.q, { limit: 3 });
  const top = searched.hits[0]?.item?.id;
  if (top !== "emergency-maternal-neonatal-transfer") {
    problems.push(`knowledge top=${top}`);
  }
  const ok = problems.length === 0;
  if (!ok) fail += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${c.q}` +
      (problems.length ? `\n  ${problems.join("; ")}` : "")
  );
}

// サイト本文に搬送セクションがあること（ネットワーク）
try {
  const res = await fetch("https://kanai.or.jp/about/feature/");
  const html = await res.text();
  const ok =
    html.includes("母体搬送および新生児搬送") &&
    html.includes("OGCS") &&
    html.includes("NMCS");
  console.log(ok ? "PASS site HTML has transfer section" : "FAIL site HTML");
  if (!ok) fail += 1;
} catch (e) {
  console.log("WARN site fetch skipped:", e.message);
}

console.log(fail === 0 ? "\nALL PASS" : `\nFAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
