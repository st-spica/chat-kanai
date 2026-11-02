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
import { explainEmergencyKeywords } from "../data/emergency-screen.js";
import { isLaborHospitalContactQuery } from "../data/labor-contact.js";

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

const reproduced =
  "06-6931-2391この番号にかけたら\n今は時間外だと言われたどうしたらいい？";
const poisonedHistory = [
  {
    role: "assistant",
    content:
      "⚠️ 現在の症状からは、緊急性が高い可能性があります。大量の出血 破水した 39度 119番",
  },
  { role: "user", content: "前回は別の相談でした" },
];

function checkTurn(q, history, expect) {
  const problems = [];
  const screened = explainEmergencyKeywords(q);
  const emergency = detectEmergency(q);
  const afterHours = isAfterHoursPhoneQuery(q);
  const labor = buildLaborHospitalContactAnswer(q, history);
  if (q.includes("39") && screened.rejected.some((r) => r.reason === "embedded_in_longer_number")) {
    if (screened.rule === "39" || screened.rule === "temperature_39") {
      problems.push("電話番号内の39を熱と判定した");
    }
  }
  if (expect.emergency) {
    if (!emergency && labor?.medicalSafetyLevel !== "urgent") {
      problems.push("緊急対応にならない");
    }
    if (afterHours) problems.push("時間外案内に吸われた");
    if (String(labor?.answer || "").includes("現在の症状からは") && !emergency) {
      problems.push("症状一覧の定型だけ");
    }
  } else {
    if (emergency) problems.push(`緊急発動 rule=${screened.rule}`);
    if (labor?.medicalSafetyLevel === "urgent") problems.push("陣痛緊急に吸われた");
    if (isLaborHospitalContactQuery(q, poisonedHistory.map((h) => h.content).join("\n"))) {
      problems.push("履歴の緊急語で陣痛判定");
    }
  }
  if (expect.afterHours) {
    const built = buildAfterHoursPhoneAnswer(q);
    if (built?.answer !== AFTER_HOURS_PHONE_ANSWER) problems.push("時間外文面ではない");
    if (/[？?]/.test(built?.answer || "")) problems.push("症状を質問している");
    for (const probe of AFTER_HOURS_SYMPTOM_PROBES) {
      if ((built?.answer || "").includes(probe)) problems.push("聞き返し");
    }
  }
  if (expect.notAfterHours && afterHours) problems.push("時間外案内になった");
  check(`${q.replace(/\n/g, " / ")} / history=${history.length}`, problems);
}

const matrix = [
  {
    q: reproduced,
    emergency: false,
    afterHours: true,
  },
  { q: "電話したら時間外でした", emergency: false, afterHours: true },
  { q: "日曜日に電話がつながりません", emergency: false, afterHours: true },
  { q: "06-6931-2391", emergency: false, afterHours: false, notAfterHours: true },
  { q: "時間外で破水したかもしれません", emergency: true, afterHours: false },
  { q: "大量に出血しています", emergency: true, afterHours: false },
  {
    q: "お腹は痛くありません。電話がつながらないだけです",
    emergency: false,
    afterHours: true,
  },
];

for (const c of matrix) {
  checkTurn(c.q, [], c);
  checkTurn(c.q, poisonedHistory, c);
}

const legacy = explainEmergencyKeywords(reproduced);
if (!reproduced.includes("39") || !legacy.rejected.some((r) => r.rule === "39")) {
  fail++;
  console.log("FAIL 再現文の39が長い数字の一部として記録されていない", legacy);
} else if (legacy.emergency) {
  fail++;
  console.log("FAIL 再現文がまだ緊急", legacy);
} else {
  console.log("OK   再現文の39は embedded_in_longer_number として除外");
}

const fever = explainEmergencyKeywords("熱が39.2度あります");
if (!fever.emergency || fever.rule !== "temperature_39") {
  fail++;
  console.log("FAIL 39度が緊急にならない", fever);
} else {
  console.log("OK   熱が39.2度");
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
