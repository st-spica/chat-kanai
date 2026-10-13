/**
 * アフターピル vs 妊娠中服薬の分離テスト
 */
import {
  isEmergencyContraceptionQuery,
  buildEmergencyContraceptionAnswer,
  EMERGENCY_CONTRACEPTION_REF_PAGE,
} from "../data/emergency-contraception.js";
import {
  isPregnancyMedicationQuery,
  buildPregnancyMedicationAnswer,
  pregnancyMedContextText,
} from "../data/pregnancy-medication.js";
import { detectClinicIntent, searchClinicKnowledge } from "../api/_clinicKnowledge.js";
import { resolveConversationTopic } from "../data/conversation-topic.js";

const cases = [
  {
    q: "アフターピルがほしいです",
    expectEc: true,
    expectPreg: false,
    must: ["アフターピル", "処方に対応", "診察が必要"],
    mustNot: ["妊娠中に使用できるか", "自己判断で服用せず"],
  },
  {
    q: "今日中に処方してもらえますか？",
    history: [{ role: "user", content: "アフターピルがほしいです" }],
    expectEc: true,
    expectPreg: false,
    must: ["処方に対応", "診療状況によって異なります"],
    mustNot: ["妊娠中に使用できるか"],
  },
  {
    q: "アフターピルがほしいです。すぐに処方してもらえますか？",
    expectEc: true,
    expectPreg: false,
    must: ["処方に対応", "診療状況によって異なります"],
    mustNot: ["妊娠中に使用できるか"],
  },
  {
    q: "避妊に失敗しました",
    expectEc: true,
    expectPreg: false,
    must: ["アフターピル", "できるだけ早く"],
    mustNot: ["妊娠中に使用できるか"],
  },
  {
    q: "緊急避妊薬はありますか？",
    expectEc: true,
    expectPreg: false,
    must: ["処方に対応"],
    mustNot: [],
  },
  {
    q: "妊娠中に風邪薬を飲んでも大丈夫ですか？",
    expectEc: false,
    expectPreg: true,
    mustPreg: ["風邪薬", "妊娠中"],
    mustNotEc: true,
  },
  {
    q: "アフターピルは何時間以内に飲むものですか？",
    expectEc: true,
    expectPreg: false,
    focus: "timing",
    must: ["できるだけ早く", "処方に対応"],
    mustNot: ["必ず今日", "72時間"],
  },
];

let fail = 0;

for (const c of cases) {
  const problems = [];
  const hist = c.history || [];
  const ec = isEmergencyContraceptionQuery(c.q, hist);
  const preg = isPregnancyMedicationQuery(c.q);
  if (c.expectEc !== ec) problems.push(`ec=${ec} want ${c.expectEc}`);
  if (c.expectPreg !== preg) problems.push(`preg=${preg} want ${c.expectPreg}`);

  if (c.expectEc) {
    const intent = detectClinicIntent(c.q);
    const topic = resolveConversationTopic(c.q, hist).detectedIntent;
    // フォローアップ「今日中に…」は履歴付きで ec、intent は単体では取れない場合あり
    if (
      !c.history &&
      intent !== "emergency_contraception_prescription"
    ) {
      problems.push(`intent=${intent}`);
    }
    if (topic !== "emergency_contraception_prescription" && !c.history) {
      problems.push(`topic=${topic}`);
    }
    if (c.history && !ec) problems.push("follow-up ec false");
    const built = buildEmergencyContraceptionAnswer(c.q, hist);
    if (!built) problems.push("no built");
    else {
      if (c.focus && built.focus !== c.focus) problems.push(`focus=${built.focus}`);
      for (const m of c.must || []) {
        if (!built.answer.includes(m)) problems.push(`missing ${m}`);
      }
      for (const m of c.mustNot || []) {
        if (built.answer.includes(m)) problems.push(`forbidden ${m}`);
      }
      if (built.referencedPages?.[0]?.url !== EMERGENCY_CONTRACEPTION_REF_PAGE.url) {
        problems.push("chip url");
      }
      if (/必ず今日|診察なしで処方|予約なしで必ず/.test(built.answer)) {
        problems.push("overpromise");
      }
    }
    if (!c.history) {
      const searched = await searchClinicKnowledge(c.q, { limit: 3 });
      const top = searched.hits[0]?.item?.id;
      if (top !== "emergency-contraception-prescription") {
        problems.push(`knowledge top=${top}`);
      }
      if (
        searched.hits.some((h) => h.item?.id === "gynecologic-medication-consult")
      ) {
        problems.push("gynecologic-medication-consult still ranked");
      }
    }
  }

  if (c.expectPreg) {
    const built = buildPregnancyMedicationAnswer(c.q, []);
    if (!built) problems.push("no preg built");
    else {
      for (const m of c.mustPreg || []) {
        if (!built.answer.includes(m)) problems.push(`preg missing ${m}`);
      }
    }
  }

  if (c.skipKnowledge && !c.expectEc && !c.expectPreg) {
    // ok as informational case
  }

  const ok = problems.length === 0;
  if (!ok) fail += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${c.q}` +
      (problems.length ? `\n  ${problems.join("; ")}` : "")
  );
}

// 履歴に妊娠中服薬があってもアフターピルは汚染されない
{
  const q = "アフターピルがほしいです。すぐに処方してもらえますか？";
  const hist = [
    { role: "user", content: "妊娠中のお薬について聞きたい" },
    { role: "assistant", content: "どのようなお薬についてのご相談でしょうか？" },
  ];
  const ctx = pregnancyMedContextText(hist, q);
  const problems = [];
  if (isPregnancyMedicationQuery(q, ctx)) {
    problems.push("still pregnancy med with hist");
  }
  if (!isEmergencyContraceptionQuery(q)) problems.push("ec false");
  const built = buildEmergencyContraceptionAnswer(q);
  if (/妊娠中に使用できるか/.test(built?.answer || "")) {
    problems.push("pregnancy wording");
  }
  const pregBuilt = buildPregnancyMedicationAnswer(q, hist);
  if (pregBuilt) problems.push("pregnancy builder still returns");
  console.log(
    problems.length === 0
      ? "PASS history pollution blocked"
      : `FAIL history pollution: ${problems.join("; ")}`
  );
  if (problems.length) fail += 1;
}

console.log(fail === 0 ? "\nALL PASS" : `\nFAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
