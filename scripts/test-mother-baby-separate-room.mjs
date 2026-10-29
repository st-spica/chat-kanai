/**
 * 母子別室と、未確認サービスの丁寧な案内
 */
import {
  buildMotherBabyRoomingInAnswer,
  buildMotherBabySeparateRoomAnswer,
  isMotherBabyRoomingInQuery,
  isMotherBabySeparateRoomQuery,
  MOTHER_BABY_SEPARATE_ROOM_ANSWER,
} from "../data/mother-baby-rooming-in.js";
import { detectClinicIntent, searchClinicKnowledge } from "../api/_clinicKnowledge.js";
import { detectClinicService } from "../data/site-route-map.js";
import { buildUnconfirmedClinicServiceAnswer } from "../data/clinic-service-availability.js";
import { buildPrepapaClassAnswer, isPrepapaClassQuery } from "../data/prenatal-classes.js";

const separateMust = ["母児同室", "体調", "スタッフと相談", "ご相談くださいね"];
const separateMustNot = [
  "実施しているか確認できません",
  "詳しいご案内ができません",
  "別室をご用意できます",
  "必ず別室",
  "産後1日目",
];

const cases = [
  "母子別室できますか？",
  "母児別室は可能ですか？",
  "赤ちゃんを預かってもらえますか？",
  "夜は赤ちゃんを預けられますか？",
  "母子同室じゃないとダメですか？",
  "出産後、赤ちゃんと別々に過ごせますか？",
  "母児同室は必須ですか？",
  "夜間は赤ちゃんを預かってもらえますか？",
];

let fail = 0;

for (const q of cases) {
  const problems = [];
  if (!isMotherBabySeparateRoomQuery(q)) problems.push("別室判定ではない");
  if (isMotherBabyRoomingInQuery(q)) problems.push("開始時期判定に吸われた");
  const built = buildMotherBabySeparateRoomAnswer(q);
  const answer = built?.answer || "";
  if (answer !== MOTHER_BABY_SEPARATE_ROOM_ANSWER) problems.push("回答文が違う");
  for (const s of separateMust) if (!answer.includes(s)) problems.push(`missing ${s}`);
  for (const s of separateMustNot) if (answer.includes(s)) problems.push(`has ${s}`);
  const chip = built?.referencedPages?.[0]?.url || "";
  if (chip !== "https://kanai.or.jp/obstetrics/hospitalization/") {
    problems.push(`chip ${chip}`);
  }
  if (detectClinicIntent(q) !== "mother_baby_separate_room") {
    problems.push(`intent ${detectClinicIntent(q)}`);
  }
  if (detectClinicService(q) !== "mother_baby_separate_room") {
    problems.push(`service ${detectClinicService(q)}`);
  }
  const found = await searchClinicKnowledge(q, { topK: 3 });
  const top = found.hits?.[0]?.item?.id;
  if (top !== "mother-baby-separate-room") problems.push(`hit ${top}`);
  if (problems.length) {
    fail++;
    console.log("FAIL", q, problems.join(" / "));
  } else {
    console.log("OK  ", q);
  }
}

const startQ = "母子同室はいつから始まりますか？";
const start = buildMotherBabyRoomingInAnswer(startQ);
const startProblems = [];
if (isMotherBabySeparateRoomQuery(startQ)) startProblems.push("別室に誤判定");
if (!isMotherBabyRoomingInQuery(startQ)) startProblems.push("開始時期ではない");
if (!String(start?.answer || "").includes("産後1日目")) startProblems.push("開始時期の回答がない");
if (String(start?.answer || "").includes("ご状況に合わせて")) {
  startProblems.push("別室回答と混同");
}
if (detectClinicIntent(startQ) !== "mother_baby_rooming_in") {
  startProblems.push(`intent ${detectClinicIntent(startQ)}`);
}
if (startProblems.length) {
  fail++;
  console.log("FAIL", startQ, startProblems.join(" / "));
} else {
  console.log("OK  ", startQ);
}

const nightTogether = "夜も赤ちゃんと一緒に過ごしますか？";
if (
  isMotherBabySeparateRoomQuery(nightTogether) ||
  buildMotherBabyRoomingInAnswer(nightTogether)?.focus !== "night_rooming_in"
) {
  fail++;
  console.log("FAIL", nightTogether, "夜間同室の開始と混同");
} else {
  console.log("OK  ", nightTogether);
}

const prepapa = "プレパパ教室はありますか？";
const prepapaAnswer = isPrepapaClassQuery(prepapa)
  ? buildPrepapaClassAnswer(prepapa)?.answer || ""
  : "";
if (!prepapaAnswer.includes("実施しておりません") || prepapaAnswer.includes("詳しいご案内ができません")) {
  fail++;
  console.log("FAIL", prepapa, prepapaAnswer.slice(0, 80));
} else {
  console.log("OK  ", prepapa);
}

const unknownQs = [
  "公式サイトに記載のないサービスはありますか？",
  "アロマ分娩はできますか？",
];
for (const q of unknownQs) {
  const answer = buildUnconfirmedClinicServiceAnswer(q, "アロマ分娩");
  const problems = [];
  if (!answer.includes("申し訳ありませんが")) problems.push("丁寧さ不足");
  if (!answer.includes("詳しいご案内ができません")) problems.push("未確認文がない");
  if (!answer.includes("スタッフまで")) problems.push("問い合わせ案内がない");
  if (/実施していません|実施しておりません|実施しています/.test(answer)) {
    problems.push("実施の断定がある");
  }
  if (answer.includes("実施しているか確認できません")) problems.push("冷たい旧文");
  if (problems.length) {
    fail++;
    console.log("FAIL", q, problems.join(" / "));
  } else {
    console.log("OK  ", q);
  }
}

if (fail) {
  console.log(`\n${fail} failed`);
  process.exit(1);
}
console.log("\nall passed");
