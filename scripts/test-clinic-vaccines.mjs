/**
 * ワクチン全般と個別ワクチンの分離
 */
import {
  buildClinicVaccineAnswer,
  classifyClinicVaccineQuery,
} from "../data/clinic-vaccines.js";
import {
  buildHpvVaccineAnswer,
  HPV_VACCINE_REF_PAGE,
} from "../data/hpv-vaccine.js";
import {
  buildCervicalCancerScreeningAnswer,
  CERVICAL_SCREENING_REF_PAGE,
} from "../data/cervical-cancer-screening.js";
import { detectClinicIntent, searchClinicKnowledge } from "../api/_clinicKnowledge.js";
import { detectClinicService, preferredUrlsForMessage } from "../data/site-route-map.js";
import { resolveConversationTopic } from "../data/conversation-topic.js";

const OB = "https://kanai.or.jp/obstetrics/vaccine/";
const HPV = "https://kanai.or.jp/gynecology/#cervical_cancer";
const SCREEN = "https://kanai.or.jp/gynecology/#gyne_cancer";

const cases = [
  {
    q: "ワクチンは打てますか？",
    focus: "general",
    intent: "clinic_vaccination",
    must: ["RSウイルスワクチン", "インフルエンザワクチン", "子宮頸がん予防ワクチン", "HPVワクチン"],
    mustNot: ["子宮頸がん検診", "子宮がん検診", "#gyne_cancer", "30,800", "3,520"],
    chips: [OB, HPV],
    hitIds: [
      "clinic-vaccination-overview",
      "obstetric-rsv-vaccine",
      "obstetric-influenza-vaccine",
      "cervical-cancer-hpv-vaccine",
    ],
    hitNot: ["cervical-cancer-screening", "child-vaccination-not-offered"],
    urls: [OB, HPV],
  },
  {
    q: "どんな予防接種がありますか？",
    focus: "general",
    intent: "clinic_vaccination",
    must: ["RSウイルスワクチン", "インフルエンザワクチン", "子宮頸がん予防ワクチン"],
    mustNot: ["子宮がん検診", "#gyne_cancer"],
    chips: [OB, HPV],
    hitIds: ["obstetric-rsv-vaccine", "obstetric-influenza-vaccine", "cervical-cancer-hpv-vaccine"],
    hitNot: ["cervical-cancer-screening"],
    urls: [OB, HPV],
  },
  {
    q: "子宮頸がんワクチンはありますか？",
    focus: "hpv",
    intent: "hpv_vaccination",
    hpv: true,
    must: ["子宮頸がんワクチン", "HPVワクチン", "完全予約制"],
    mustNot: ["インフルエンザ", "RSウイルス", "子宮がん検診", "#gyne_cancer"],
    chips: [HPV_VACCINE_REF_PAGE.url],
    hitIds: ["cervical-cancer-hpv-vaccine"],
    hitNot: [
      "obstetric-rsv-vaccine",
      "obstetric-influenza-vaccine",
      "clinic-vaccination-overview",
      "cervical-cancer-screening",
    ],
    urls: [HPV],
  },
  {
    q: "HPVワクチンは予約が必要ですか？",
    focus: "hpv",
    intent: "hpv_vaccination",
    hpv: true,
    must: ["完全予約制", "13:00", "午前診"],
    mustNot: ["インフルエンザ", "RSウイルス", "#gyne_cancer"],
    chips: [HPV],
    hitIds: ["cervical-cancer-hpv-vaccine"],
    hitNot: ["cervical-cancer-screening", "obstetric-influenza-vaccine"],
  },
  {
    q: "妊婦向けのワクチンはありますか？",
    focus: "pregnant",
    intent: "obstetric_vaccination",
    must: ["RSウイルスワクチン", "インフルエンザワクチン"],
    mustNot: ["子宮頸がん", "HPV", "検診"],
    chips: [OB],
    hitIds: ["obstetric-rsv-vaccine", "obstetric-influenza-vaccine"],
    hitNot: ["cervical-cancer-hpv-vaccine", "cervical-cancer-screening", "clinic-vaccination-overview"],
    urls: [OB],
    urlsNot: [HPV],
  },
  {
    q: "インフルエンザの予防接種はできますか？",
    focus: "flu",
    intent: "influenza_vaccination",
    must: ["インフルエンザワクチン", "3,520円", "妊婦健診", "夜診"],
    mustNot: ["子宮頸がん", "HPV", "30,800", "#gyne_cancer"],
    chips: [OB],
    hitIds: ["obstetric-influenza-vaccine"],
    hitNot: [
      "cervical-cancer-hpv-vaccine",
      "obstetric-rsv-vaccine",
      "cervical-cancer-screening",
      "clinic-vaccination-overview",
    ],
    urls: [OB],
    urlsNot: [HPV],
  },
  {
    q: "妊婦でもインフルエンザワクチンは打てますか？",
    focus: "flu",
    intent: "influenza_vaccination",
    must: ["インフルエンザワクチン", "妊婦健診"],
    mustNot: ["子宮頸がん", "RSウイルスワクチン", "30,800"],
    chips: [OB],
    hitIds: ["obstetric-influenza-vaccine"],
    hitNot: ["cervical-cancer-hpv-vaccine", "obstetric-rsv-vaccine"],
  },
  {
    q: "RSウイルスワクチンの料金は？",
    focus: "rsv",
    intent: "rsv_vaccination",
    must: ["30,800円", "無料", "大阪市"],
    mustNot: ["3,520", "子宮頸がん", "HPV", "インフルエンザ"],
    chips: [OB],
    hitIds: ["obstetric-rsv-vaccine"],
    hitNot: [
      "obstetric-influenza-vaccine",
      "cervical-cancer-hpv-vaccine",
      "cervical-cancer-screening",
    ],
    urls: [OB],
    urlsNot: [HPV],
  },
  {
    q: "赤ちゃんのワクチンは打てますか？",
    focus: "child",
    intent: "vaccination_availability",
    child: true,
    must: [],
    chips: [],
    hitIds: ["child-vaccination-not-offered"],
    hitNot: [
      "obstetric-rsv-vaccine",
      "obstetric-influenza-vaccine",
      "cervical-cancer-hpv-vaccine",
      "clinic-vaccination-overview",
    ],
    urlsNot: [OB, HPV],
  },
  {
    q: "子宮頸がん検診は受けられますか？",
    focus: null,
    intent: "cervical_cancer_screening",
    screening: true,
    must: ["子宮頸がん", "検診"],
    mustNot: ["完全予約制", "HPVワクチン", "RSウイルス", "インフルエンザワクチン"],
    chips: [SCREEN],
    chipNot: [HPV],
    hitIds: ["cervical-cancer-screening"],
    hitNot: [
      "cervical-cancer-hpv-vaccine",
      "obstetric-rsv-vaccine",
      "obstetric-influenza-vaccine",
      "clinic-vaccination-overview",
    ],
    urls: [CERVICAL_SCREENING_REF_PAGE.url],
    urlsNot: [OB, HPV],
  },
];

function urlsOf(pages) {
  return (pages || []).map((p) => p.url);
}

let fail = 0;

for (const c of cases) {
  const problems = [];
  const cls = classifyClinicVaccineQuery(c.q);
  const focus = cls?.focus || null;
  if (focus !== c.focus) problems.push(`focus=${focus} want ${c.focus}`);

  const intent = detectClinicIntent(c.q);
  if (intent !== c.intent) problems.push(`intent=${intent} want ${c.intent}`);

  const topic = resolveConversationTopic(c.q, []);
  if (topic.detectedIntent !== c.intent) {
    problems.push(`topic=${topic.detectedIntent} want ${c.intent}`);
  }

  let built = null;
  if (c.child) {
    if (buildClinicVaccineAnswer(c.q) || buildHpvVaccineAnswer(c.q)) {
      problems.push("child query used a vaccine answer");
    }
  } else if (c.screening) built = buildCervicalCancerScreeningAnswer(c.q);
  else if (c.hpv) built = buildHpvVaccineAnswer(c.q);
  else built = buildClinicVaccineAnswer(c.q);

  const answer = built?.answer || "";
  if (!c.child && !answer) problems.push("answer empty");
  for (const s of c.must || []) {
    if (!answer.includes(s)) problems.push(`answer missing 「${s}」`);
  }
  for (const s of c.mustNot || []) {
    if (answer.includes(s)) problems.push(`answer has 「${s}」`);
  }

  const chips = urlsOf(built?.referencedPages);
  for (const u of c.chips || []) {
    if (!chips.includes(u)) problems.push(`chip missing ${u} got ${chips.join(",")}`);
  }
  for (const u of c.chipNot || []) {
    if (chips.includes(u)) problems.push(`chip has ${u}`);
  }
  if (c.focus === "general" && chips.length !== 2) {
    problems.push(`general chips=${chips.length} want 2`);
  }
  if (c.focus === "general") {
    const titles = (built.referencedPages || []).map((p) => p.title);
    if (titles[0] !== "妊婦さま向けワクチンのご案内") {
      problems.push(`chip1 title=${titles[0]}`);
    }
    if (titles[1] !== "子宮頸がんワクチンのご案内") {
      problems.push(`chip2 title=${titles[1]}`);
    }
  }

  const searched = await searchClinicKnowledge(c.q);
  const ids = searched.hits.map((h) => h.item.id);
  for (const id of c.hitIds || []) {
    if (!ids.includes(id)) problems.push(`hit missing ${id} got ${ids.join(",")}`);
  }
  for (const id of c.hitNot || []) {
    if (ids.includes(id)) problems.push(`hit has ${id}`);
  }
  if (searched.detectedIntent !== c.intent) {
    problems.push(`search intent=${searched.detectedIntent}`);
  }

  if (c.urls || c.urlsNot) {
    const urls = preferredUrlsForMessage(c.q);
    for (const u of c.urls || []) {
      if (!urls.includes(u)) problems.push(`route missing ${u} got ${urls.join(",")}`);
    }
    for (const u of c.urlsNot || []) {
      if (urls.includes(u)) problems.push(`route has ${u}`);
    }
  }

  if (c.focus === "general" && detectClinicService(c.q)) {
    problems.push(`general service should be empty, got ${detectClinicService(c.q)}`);
  }

  if (problems.length) {
    fail += 1;
    console.log("FAIL", c.q);
    for (const p of problems) console.log("  -", p);
  } else {
    console.log("OK", c.q);
    console.log("  chips:", chips.join(" | "));
    console.log("  hits:", ids.join(", "));
  }
}

if (fail) {
  console.error(`\n${fail} failed`);
  process.exit(1);
}
console.log("\nall vaccine cases passed");
