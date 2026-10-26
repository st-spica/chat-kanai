/**
 * 未確認サービスを実施中と断定しない
 * プレパパ教室は未実施（確定）
 */
import {
  buildFatherClassParticipationAnswer,
  buildPrepapaClassAnswer,
  buildPrenatalClassesAnswer,
  isPrepapaClassQuery,
  isPrenatalClassesQuery,
  PRENATAL_CLASSES_REF_PAGE,
  PREPAPA_CLASS_UNAVAILABLE_ANSWER,
} from "../data/prenatal-classes.js";
import {
  buildUnconfirmedClinicServiceAnswer,
  pageConfirmsNamedService,
} from "../data/clinic-service-availability.js";
import { detectClinicIntent, searchClinicKnowledge } from "../api/_clinicKnowledge.js";
import {
  gynecologicSurgerySubject,
  isChildVaccinationQuery,
  isGynecologicSurgeryQuery,
} from "../data/site-route-map.js";
import { resolveConversationTopic } from "../data/conversation-topic.js";

const LESSON = `
産前産後教室
後期クラス マタニティビクス マタニティヨーガ ママフィット ママヨガ
後期クラスの参加は妊婦さまご本人のみ
`;

const cases = [
  {
    q: "プレパパはありますか？",
    kind: "prepapa",
    must: ["実施しておりません", "妊娠中の方を対象とした教室"],
    mustNot: ["プレパパ教室を実施しています", "実施しています。"],
  },
  {
    q: "プレパパ教室を予約したいです",
    kind: "prepapa",
    must: ["実施しておりません"],
    mustNot: ["予約いただけます", "実施しています"],
  },
  {
    q: "パパ向けの教室はありますか？",
    kind: "prepapa",
    must: ["実施しておりません"],
    mustNot: ["実施しています"],
  },
  {
    q: "父親向けの両親学級はありますか？",
    kind: "prepapa",
    must: ["実施しておりません"],
    mustNot: ["実施しています"],
  },
  {
    q: "産前産後教室はありますか？",
    kind: "classes",
    must: ["産前産後教室を実施しています", "後期クラス"],
    mustNot: ["プレパパ", "実施しておりません"],
  },
  {
    q: "子どもの予防接種はできますか？",
    kind: "child",
  },
  {
    q: "婦人科の手術はできますか？",
    kind: "surgery",
    subject: "婦人科の手術",
  },
  {
    q: "子宮筋腫の手術はできますか？",
    kind: "surgery",
    subject: "子宮筋腫の手術",
  },
  {
    q: "公式サイトに記載のないサービスはありますか？",
    kind: "unknown",
    mustNot: ["実施しています", "実施しておりません"],
    must: ["実施しているか確認できません", "ご案内できません"],
  },
  {
    q: "アクアビクス教室はありますか？",
    kind: "unknown-class",
    must: ["実施しているか確認できません"],
    mustNot: ["実施しています", "実施しておりません"],
  },
  {
    q: "父親も教室に参加できますか？",
    kind: "father",
    must: ["妊婦さまご本人のみ"],
    mustNot: ["プレパパ教室は実施しておりません", "参加できます。"],
  },
];

let fail = 0;

function checkText(answer, c, problems) {
  for (const s of c.must || []) {
    if (!answer.includes(s)) problems.push(`missing 「${s}」`);
  }
  for (const s of c.mustNot || []) {
    if (answer.includes(s)) problems.push(`has 「${s}」`);
  }
}

for (const c of cases) {
  const problems = [];

  if (c.kind === "prepapa") {
    if (!isPrepapaClassQuery(c.q)) problems.push("not prepapa query");
    if (isPrenatalClassesQuery(c.q)) problems.push("treated as offered class");
    const built = buildPrepapaClassAnswer(c.q);
    checkText(built?.answer || "", c, problems);
    if (built?.answer !== PREPAPA_CLASS_UNAVAILABLE_ANSWER) {
      problems.push("answer drifted from confirmed text");
    }
    const chips = (built?.referencedPages || []).map((p) => p.url);
    if (!chips.includes(PRENATAL_CLASSES_REF_PAGE.url)) problems.push("missing lesson chip");
    if ((built?.referencedPages || []).some((p) => /プレパパ/.test(p.title || ""))) {
      problems.push("chip titled as prepapa");
    }
    if (detectClinicIntent(c.q) !== "prepapa_class") {
      problems.push(`intent=${detectClinicIntent(c.q)}`);
    }
    if (resolveConversationTopic(c.q, []).detectedIntent !== "prepapa_class") {
      problems.push("topic mismatch");
    }
    const searched = await searchClinicKnowledge(c.q);
    const ids = searched.hits.map((h) => h.item.id);
    if (!ids.includes("prenatal-class-prepapa-unavailable")) {
      problems.push(`hit missing prepapa: ${ids.join(",")}`);
    }
    if (ids.includes("prenatal-classes")) problems.push("offered-class knowledge leaked");
    if (pageConfirmsNamedService(c.q, LESSON)) {
      problems.push("lesson page counted as prepapa evidence");
    }
  }

  if (c.kind === "classes") {
    if (!isPrenatalClassesQuery(c.q)) problems.push("not class query");
    if (isPrepapaClassQuery(c.q)) problems.push("prepapa misfire");
    const built = buildPrenatalClassesAnswer(c.q);
    checkText(built?.answer || "", c, problems);
    const chips = (built?.referencedPages || []).map((p) => p.url);
    if (!chips.includes(PRENATAL_CLASSES_REF_PAGE.url)) problems.push("missing lesson chip");
    if (!pageConfirmsNamedService(c.q, LESSON)) {
      problems.push("lesson page should confirm 産前産後教室");
    }
    const searched = await searchClinicKnowledge(c.q);
    const ids = searched.hits.map((h) => h.item.id);
    if (!ids.includes("prenatal-classes")) problems.push(`hit missing classes: ${ids.join(",")}`);
    if (ids.includes("prenatal-class-prepapa-unavailable")) {
      problems.push("prepapa knowledge leaked");
    }
  }

  if (c.kind === "child") {
    if (!isChildVaccinationQuery(c.q)) problems.push("not child vaccination");
    const searched = await searchClinicKnowledge(c.q);
    const hit = searched.hits.find((h) => h.item.id === "child-vaccination-not-offered");
    if (!hit) problems.push("missing not-offered vaccination");
    else if (!/行っておりません|実施していません/.test(hit.item.answer || "")) {
      problems.push("vaccination answer is not unavailable");
    }
    if (pageConfirmsNamedService(c.q, LESSON)) problems.push("lesson page used as vaccination evidence");
  }

  if (c.kind === "surgery") {
    if (!isGynecologicSurgeryQuery(c.q)) problems.push("not surgery query");
    if (gynecologicSurgerySubject(c.q) !== c.subject) {
      problems.push(`subject=${gynecologicSurgerySubject(c.q)} want ${c.subject}`);
    }
    const searched = await searchClinicKnowledge(c.q);
    const hit = searched.hits.find((h) => h.item.availability === "unavailable" && /手術/.test(h.item.answer || ""));
    if (!hit) problems.push(`no unavailable surgery hit: ${searched.hits.map((h) => h.item.id).join(",")}`);
    else if (/実施しています/.test(hit.item.answer || "")) problems.push("surgery marked available");
  }

  if (c.kind === "unknown" || c.kind === "unknown-class") {
    const label = c.kind === "unknown-class" ? "アクアビクス教室" : "";
    const answer = buildUnconfirmedClinicServiceAnswer(c.q, label);
    checkText(answer, c, problems);
    if (isPrenatalClassesQuery(c.q)) problems.push("unknown class treated as offered");
    if (pageConfirmsNamedService(c.q, LESSON)) {
      problems.push("related lesson page confirmed an unlisted service");
    }
  }

  if (c.kind === "father") {
    if (isPrepapaClassQuery(c.q)) problems.push("father participation treated as prepapa class");
    const built = buildFatherClassParticipationAnswer(c.q);
    checkText(built?.answer || "", c, problems);
  }

  if (problems.length) {
    fail += 1;
    console.log("FAIL", c.q);
    for (const p of problems) console.log("  -", p);
  } else {
    console.log("OK", c.q);
  }
}

if (fail) {
  console.error(`\n${fail} failed`);
  process.exit(1);
}
console.log("\nall service-availability cases passed");
