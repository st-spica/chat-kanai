/**
 * 母子同室開始時期・入院スケジュールの回帰テスト
 */
import {
  isMotherBabyRoomingInQuery,
  buildMotherBabyRoomingInAnswer,
  MOTHER_BABY_ROOMING_IN_REF_PAGE,
} from "../data/mother-baby-rooming-in.js";
import { detectClinicIntent, searchClinicKnowledge } from "../api/_clinicKnowledge.js";
import { preferredUrlsForMessage } from "../data/site-route-map.js";

const cases = [
  {
    q: "赤ちゃんと同室になるのはいつですか？",
    focus: "start_day",
    must: ["産後1日目", "産後3日目"],
    mustNot: ["数時間以内", "出産直後"],
  },
  {
    q: "出産した日から母子同室ですか？",
    focus: "not_same_day",
    must: ["出産翌日", "産後1日目"],
    mustNot: ["数時間以内"],
  },
  {
    q: "帝王切開でも翌日から母子同室ですか？",
    focus: "cesarean",
    must: ["産後3日目"],
    mustNot: ["数時間以内"],
  },
  {
    q: "夜間の母子同室はいつから？",
    focus: "night_rooming_in",
    must: ["産後2〜4日目"],
    mustNot: ["数時間以内"],
  },
  {
    q: "出産後の入院スケジュールを教えてください。",
    focus: "schedule_overview",
    must: ["産後1日目", "夜間の母子同室"],
    mustNot: ["数時間以内"],
  },
];

let fail = 0;
for (const c of cases) {
  const problems = [];
  if (!isMotherBabyRoomingInQuery(c.q)) problems.push("detector");
  if (detectClinicIntent(c.q) !== "mother_baby_rooming_in") {
    problems.push(`intent=${detectClinicIntent(c.q)}`);
  }
  const built = buildMotherBabyRoomingInAnswer(c.q);
  if (!built) problems.push("no answer");
  else {
    if (built.focus !== c.focus) problems.push(`focus=${built.focus}`);
    for (const m of c.must) {
      if (!built.answer.includes(m)) problems.push(`missing ${m}`);
    }
    for (const m of c.mustNot) {
      if (built.answer.includes(m)) problems.push(`forbidden ${m}`);
    }
    if (built.referencedPages?.[0]?.url !== MOTHER_BABY_ROOMING_IN_REF_PAGE.url) {
      problems.push("chip");
    }
  }
  const searched = await searchClinicKnowledge(c.q, { limit: 2 });
  if (searched.hits[0]?.item?.id !== "mother-baby-rooming-in-schedule") {
    problems.push(`top=${searched.hits[0]?.item?.id}`);
  }
  if (!preferredUrlsForMessage(c.q).some((u) => /hospitalization/.test(u))) {
    problems.push("route");
  }
  const ok = problems.length === 0;
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.q}${problems.length ? `\n  ${problems.join("; ")}` : ""}`);
}

// サイト表：構造化抽出で行対応が残るか
try {
  const res = await fetch("https://kanai.or.jp/obstetrics/hospitalization/");
  const html = await res.text();
  const table = html.match(/<table[\s\S]*?産後1日目[\s\S]*?<\/table>/i)?.[0] || "";
  const row = [...table.matchAll(/<tr[\s\S]*?<\/tr>/gi)].find((r) =>
    /産後1日目/.test(r[0])
  );
  const cells = row
    ? [...row[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) =>
        c[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      )
    : [];
  const ok =
    cells[0]?.includes("産後1日目") &&
    /母子同室/.test(cells[1] || "") &&
    /帝王切開/.test(cells[1] || "");
  console.log(ok ? "PASS site table row pairing" : `FAIL site table ${JSON.stringify(cells)}`);
  if (!ok) fail += 1;
} catch (e) {
  console.log("WARN site fetch:", e.message);
}

console.log(fail === 0 ? "\nALL PASS" : `\nFAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
