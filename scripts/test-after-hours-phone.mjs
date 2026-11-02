/**
 * 診療時間外の電話問い合わせ
 * 症状の聞き返しをせず、明示された緊急症状は安全案内を優先する。
 */
import {
  AFTER_HOURS_PHONE_ANSWER,
  AFTER_HOURS_SYMPTOM_PROBES,
  buildAfterHoursPhoneAnswer,
  hasExplicitEmergencySymptom,
  isAfterHoursPhoneQuery,
} from "../data/after-hours-phone.js";
import { isClinicHoursQuery } from "../data/clinic-hours.js";
import { buildLaborHospitalContactAnswer } from "../data/labor-contact.js";
import { detectClinicIntent, searchClinicKnowledge } from "../api/_clinicKnowledge.js";
import { detectStandaloneIntent } from "../data/conversation-topic.js";
import { detectEmergency } from "../api/chat.js";

const phoneCases = [
  "電話したら時間外と言われた",
  "日曜日で電話がつながらない",
  "電話がつながらない、どうしたらいい？",
  "診療時間外ですが相談できますか？",
];

let fail = 0;

function check(q, problems) {
  if (problems.length) {
    fail++;
    console.log("FAIL", q, problems.join(" / "));
  } else {
    console.log("OK  ", q);
  }
}

for (const q of phoneCases) {
  const problems = [];
  const built = buildAfterHoursPhoneAnswer(q);
  const answer = built?.answer || "";
  if (!isAfterHoursPhoneQuery(q)) problems.push("時間外判定ではない");
  if (isClinicHoursQuery(q)) problems.push("診療時間表に吸われた");
  if (hasExplicitEmergencySymptom(q)) problems.push("症状なしなのに緊急症状扱い");
  if (detectEmergency(q)) problems.push("緊急回答が発動した");
  if (answer !== AFTER_HOURS_PHONE_ANSWER) problems.push("回答文が違う");
  if (!answer.includes("診療時間内に改めてご連絡")) problems.push("再連絡案内がない");
  if (!answer.includes("救急医療機関")) problems.push("救急案内がない");
  if (/[？?]/.test(answer)) problems.push("質問で終わっている");
  for (const probe of AFTER_HOURS_SYMPTOM_PROBES) {
    if (answer.includes(probe)) problems.push(`聞き返し: ${probe}`);
  }
  if (/06-6931-2391/.test(answer)) problems.push("電話番号を出している");
  if (built?.referencedPages?.[0]?.url !== "https://kanai.or.jp/beginner/") {
    problems.push("診療時間ページがない");
  }
  if (detectStandaloneIntent(q) !== "after_hours_phone") {
    problems.push(`topic ${detectStandaloneIntent(q)}`);
  }
  if (detectClinicIntent(q) !== "after_hours_phone") {
    problems.push(`intent ${detectClinicIntent(q)}`);
  }
  const found = await searchClinicKnowledge(q, { topK: 3 });
  if (found.hits?.[0]?.item?.id !== "after-hours-phone") {
    problems.push(`hit ${found.hits?.[0]?.item?.id}`);
  }
  check(q, problems);
}

const urgentCases = [
  {
    q: "破水したかもしれない",
    must: ["すぐに当院へお電話", "清潔なナプキン"],
  },
  {
    q: "大量に出血している",
    must: ["すぐに当院へお電話", "判断はこちらではできません"],
  },
];

for (const c of urgentCases) {
  const problems = [];
  if (isAfterHoursPhoneQuery(c.q)) problems.push("時間外案内に吸われた");
  const labor = buildLaborHospitalContactAnswer(c.q);
  const answer = labor?.answer || "";
  if (labor?.medicalSafetyLevel !== "urgent") problems.push(`level ${labor?.medicalSafetyLevel}`);
  for (const s of c.must) if (!answer.includes(s)) problems.push(`missing ${s}`);
  if (answer === AFTER_HOURS_PHONE_ANSWER) problems.push("時間外文面");
  for (const probe of AFTER_HOURS_SYMPTOM_PROBES) {
    if (answer.includes(probe)) problems.push(`聞き返し: ${probe}`);
  }
  check(c.q, problems);
}

const hoursQ = "診療時間を教えてください";
if (isAfterHoursPhoneQuery(hoursQ) || !isClinicHoursQuery(hoursQ)) {
  fail++;
  console.log("FAIL", hoursQ, "診療時間の質問が時間外電話になった");
} else {
  console.log("OK  ", hoursQ);
}

if (fail) {
  console.log(`\n${fail} failed`);
  process.exit(1);
}
console.log("\nall passed");
