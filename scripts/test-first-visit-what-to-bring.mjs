/**
 * 初診の持ち物 vs 初診料・予約・受付時間の意図分離テスト
 */
import {
  isFirstVisitWhatToBringQuery,
  buildFirstVisitWhatToBringAnswer,
} from "../data/first-visit-what-to-bring.js";
import { isFirstVisitFeeQuery } from "../data/first-visit-fee.js";
import { isHospitalBagQuery } from "../data/site-route-map.js";
import { resolveConversationTopic } from "../data/conversation-topic.js";
import {
  detectClinicIntent,
  searchClinicKnowledge,
} from "../api/_clinicKnowledge.js";

const cases = [
  {
    q: "初診に必要な持ち物って何ですか？",
    expectIntent: "first_visit_what_to_bring",
    expectFee: false,
    expectBag: false,
    expectBelongings: true,
    answerMust: ["健康保険証", "医療証", "紹介状"],
    answerMustNot: ["1,080", "1080", "初診料"],
  },
  {
    q: "初めて行くとき何を持っていけばいい？",
    expectIntent: "first_visit_what_to_bring",
    expectFee: false,
    expectBag: false,
    expectBelongings: true,
    answerMust: ["健康保険証"],
    answerMustNot: ["1,080", "初診料"],
  },
  {
    q: "初診の料金はいくらですか？",
    expectIntent: "first_visit_fee",
    expectFee: true,
    expectBag: false,
    expectBelongings: false,
  },
  {
    q: "初診は予約できますか？",
    expectIntent: "first_visit_reservation",
    expectFee: false,
    expectBag: false,
    expectBelongings: false,
    forbidIntents: ["first_visit_fee", "first_visit_what_to_bring"],
  },
  {
    q: "初診は何時まで受け付けていますか？",
    expectFee: false,
    expectBag: false,
    expectBelongings: false,
    forbidIntents: [
      "first_visit_fee",
      "first_visit_what_to_bring",
      "hospital_bag",
    ],
  },
  {
    q: "紹介状は必要ですか？",
    expectIntent: "first_visit_what_to_bring",
    expectFee: false,
    expectBag: false,
    expectBelongings: true,
    answerMust: ["紹介状"],
    answerMustNot: ["1,080", "初診料"],
  },
];

let fail = 0;

for (const c of cases) {
  const belongings = isFirstVisitWhatToBringQuery(c.q);
  const fee = isFirstVisitFeeQuery(c.q);
  const bag = isHospitalBagQuery(c.q);
  const topic = resolveConversationTopic(c.q, []).detectedIntent;
  const intent = detectClinicIntent(c.q);
  const searched = await searchClinicKnowledge(c.q, { limit: 5 });
  const topId = searched.hits[0]?.item?.id || null;
  const topIntent = searched.hits[0]?.item?.intent || searched.detectedIntent;

  const built = buildFirstVisitWhatToBringAnswer(c.q);
  const answer = built?.answer || "";

  const problems = [];

  if (c.expectBelongings !== belongings) {
    problems.push(`belongings=${belongings} want ${c.expectBelongings}`);
  }
  if (c.expectFee !== fee) {
    problems.push(`fee=${fee} want ${c.expectFee}`);
  }
  if (c.expectBag !== bag) {
    problems.push(`hospitalBag=${bag} want ${c.expectBag}`);
  }
  if (
    c.expectIntent &&
    intent !== c.expectIntent &&
    topic !== c.expectIntent
  ) {
    problems.push(`intent=${intent} topic=${topic} want ${c.expectIntent}`);
  }
  if (c.forbidIntents) {
    for (const fi of c.forbidIntents) {
      if (intent === fi || topic === fi) {
        problems.push(`forbidden intent/topic ${fi}`);
      }
    }
  }
  if (
    c.expectBelongings &&
    (topId === "clinic-first-visit-fee" || topIntent === "first_visit_fee")
  ) {
    problems.push(`knowledge top is fee: ${topId}`);
  }
  if (
    c.expectBelongings &&
    searched.rejected?.some((r) => r.id === "first-visit-what-to-bring")
  ) {
    problems.push("first-visit-what-to-bring was rejected");
  }
  if (c.expectBelongings && c.answerMust) {
    for (const m of c.answerMust) {
      if (!answer.includes(m)) problems.push(`built answer missing ${m}`);
    }
  }
  if (c.expectBelongings && c.answerMustNot) {
    for (const m of c.answerMustNot) {
      if (answer.includes(m)) problems.push(`built answer has forbidden ${m}`);
    }
  }
  if (c.expectBelongings && !built?.referencedPages?.[0]?.url?.includes("beginner")) {
    problems.push("missing beginner chip url");
  }

  const ok = problems.length === 0;
  if (!ok) fail += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${c.q}\n  intent=${intent} topic=${topic} top=${topId}\n  belongings=${belongings} fee=${fee} bag=${bag}` +
      (problems.length ? `\n  ${problems.join("; ")}` : "")
  );
}

{
  const q = "初診に必要な持ち物は？";
  if (isFirstVisitFeeQuery(q) || !isFirstVisitWhatToBringQuery(q)) {
    fail += 1;
    console.log("FAIL regression 必要な持ち物→費用");
  } else {
    console.log("PASS regression 必要な持ち物≠費用");
  }
}

console.log(`\n${fail === 0 ? "ALL PASS" : `FAIL=${fail}`}`);
process.exit(fail === 0 ? 0 : 1);
