/**
 * クレーム文脈の「予約」vs 夜診予約ルールの分離テスト
 */
import {
  isPatientComplaintQuery,
  isPatientComplaintContent,
  buildPatientComplaintAnswer,
} from "../data/patient-complaint.js";
import { isEveningConsultationReservationQuery } from "../data/site-route-map.js";
import { resolveConversationTopic } from "../data/conversation-topic.js";
import { searchClinicKnowledge } from "../api/_clinicKnowledge.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

let fail = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}

const history = [
  { role: "user", content: "予約して行ったのに待ち時間が長すぎます" },
  {
    role: "assistant",
    content:
      "ご予約いただいていたにもかかわらず、長い時間お待たせしてしまい、申し訳ございません。",
  },
  { role: "user", content: "私より後に来た人が先に呼ばれたし" },
  {
    role: "assistant",
    content:
      "お呼びする順番について、ご不快な思いをさせてしまい申し訳ございません。夜診は受付順での診察となります。",
  },
];

check("turn1 wait complaint", () => {
  const q = "予約して行ったのに待ち時間が長すぎます";
  assert(isPatientComplaintContent(q), "should be complaint");
  const built = buildPatientComplaintAnswer(q, []);
  assert(
    built?.focus?.includes("wait") || built?.answer.includes("お待たせ"),
    built?.focus
  );
  assert(!/夜診は予約制/.test(built.answer), "no evening rule");
});

check("turn2 call order", () => {
  const q = "私より後に来た人が先に呼ばれたし";
  const hist = history.slice(0, 2);
  assert(isPatientComplaintQuery(q, hist), "complaint in context");
  const built = buildPatientComplaintAnswer(q, hist);
  assert(/順番|呼ば/.test(built.answer), "call order response");
  assert(!/夜診は予約制/.test(built.answer), "no evening rule");
});

check("turn3 next appointment explain missing", () => {
  const q = "次の予約の説明もなかったし";
  assert(isPatientComplaintContent(q), "standalone complaint content");
  assert(isPatientComplaintQuery(q, history), "complaint with history");
  assert(
    !isEveningConsultationReservationQuery(
      q,
      history.map((h) => h.content).join("\n")
    ),
    "evening must not match even with 夜診 in assistant text"
  );
  const topic = resolveConversationTopic(q, history);
  assert(
    topic.detectedIntent === "patient_complaint",
    `topic=${topic.detectedIntent}`
  );
  const built = buildPatientComplaintAnswer(q, history);
  assert(built, "built answer");
  assert(
    /次回の予約|説明がなかった/.test(built.answer),
    `answer=${built.answer.slice(0, 60)}`
  );
  assert(!/夜診/.test(built.answer), "must not mention 夜診");
  assert(!/受付順/.test(built.answer), "must not mention 受付順");
  assert(
    built.suppressReferenceLinks === true &&
      Array.isArray(built.referencedPages) &&
      built.referencedPages.length === 0,
    "no chips"
  );
});

check("alone evening reservation still works", () => {
  const q = "夜診は予約できますか？";
  assert(!isPatientComplaintQuery(q, []), "not complaint");
  assert(isEveningConsultationReservationQuery(q), "evening yes");
});

check("B next reservation how-to is not complaint-lack", () => {
  const q = "次の予約はどうすればいいですか？";
  assert(!isPatientComplaintContent(q), "method question not complaint");
});

await checkAsync("evening knowledge rejected on complaint", async () => {
  const q = "次の予約の説明もなかったし";
  const searched = await searchClinicKnowledge(q, { limit: 5 });
  assert(
    searched.detectedIntent === "patient_complaint",
    `intent=${searched.detectedIntent}`
  );
  const eveningHit = searched.hits.find(
    (h) =>
      h.item?.id === "evening-consultation-reservation" ||
      h.item?.service === "evening_consultation"
  );
  assert(!eveningHit, "evening knowledge must not win");
});

console.log(fail === 0 ? "\nALL PASS" : `\nFAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
