/**
 * 退院プレゼントとお土産は同じ案内。ないとは断定しない。
 */
import {
  buildDischargeGiftAnswer,
  DISCHARGE_GIFT_ANSWER,
  DISCHARGE_GIFT_PAGE,
  isDischargeGiftQuery,
} from "../data/discharge-gift.js";
import { detectClinicIntent, searchClinicKnowledge } from "../api/_clinicKnowledge.js";
import {
  detectClinicService,
  isDeliveryBenefitsFocusedMessage,
  matchSiteRoutes,
} from "../data/site-route-map.js";
import { isNewbornMaternityPhotoQuery } from "../data/newborn-maternity-photo.js";
import { resolveConversationTopic } from "../data/conversation-topic.js";
import {
  htmlToStructuredText,
  promoteNamedSection,
} from "../api/_siteKnowledge.js";

const cases = [
  "退院プレゼント",
  "おみやげ",
  "退院するとき何かもらえますか？",
  "出産の記念品はありますか？",
  "赤ちゃんの写真はもらえますか？",
  "退院祝いはありますか？",
  "お土産",
  "出産プレゼント",
];

let failed = 0;

for (const q of cases) {
  const built = buildDischargeGiftAnswer(q);
  const problems = [];
  if (!isDischargeGiftQuery(q)) problems.push("query判定がfalse");
  if (built?.answer !== DISCHARGE_GIFT_ANSWER) problems.push("回答が理想文と違う");
  if (detectClinicIntent(q) !== "discharge_gift") problems.push(`intent=${detectClinicIntent(q)}`);
  if (detectClinicService(q) !== "discharge_gift") problems.push(`service=${detectClinicService(q)}`);
  if (resolveConversationTopic(q, []).detectedIntent !== "discharge_gift") {
    problems.push(`topic=${resolveConversationTopic(q, []).detectedIntent}`);
  }
  if (isNewbornMaternityPhotoQuery(q)) problems.push("撮影サービスに吸われた");
  if (isDeliveryBenefitsFocusedMessage(q)) problems.push("分娩予約特典に吸われた");
  const routes = matchSiteRoutes(q).map((r) => r.id);
  if (!routes.includes("discharge_gift")) problems.push(`routeなし: ${routes.join(",")}`);
  if (routes.includes("newborn_maternity_photo")) problems.push("撮影ルートが付いた");
  if (routes.includes("delivery_reservation_benefits")) problems.push("特典ルートが付いた");
  const chip = (built?.referencedPages || []).map((p) => p.url);
  if (!chip.includes(DISCHARGE_GIFT_PAGE.url)) problems.push("チップURLがない");
  if ((built?.referencedPages || [])[0]?.title !== DISCHARGE_GIFT_PAGE.title) {
    problems.push("チップ名が違う");
  }
  const searched = await searchClinicKnowledge(q);
  const ids = (searched.hits || []).map((h) => h.item?.id);
  if (!ids.includes("discharge-gift")) problems.push(`hit不足: ${ids.join(",")}`);
  if (ids.includes("newborn-maternity-photo")) problems.push("撮影知識が混入");
  for (const bad of ["行っていない", "販売は行っておりません", "ありません"]) {
    if ((built?.answer || "").includes(bad)) problems.push(`禁止: ${bad}`);
  }
  if (!/臍帯箱/.test(built?.answer || "") || !/お写真/.test(built?.answer || "")) {
    problems.push("グッズか写真が欠けている");
  }
  if (problems.length) {
    failed += 1;
    console.log("NG", q);
    for (const p of problems) console.log("  ", p);
  } else {
    console.log("OK", q);
  }
}

if (isDischargeGiftQuery("おみやげ", "レストランのお食事は家族も食べられますか")) {
  failed += 1;
  console.log("NG レストランの続きのおみやげを退院プレゼントにした");
} else {
  console.log("OK 別のお土産の文脈は退院プレゼントにしない");
}

if (!isDischargeGiftQuery("ニューボーンフォトはありますか？") && isNewbornMaternityPhotoQuery("ニューボーンフォトはありますか？")) {
  console.log("OK ニューボーンは撮影サービスのまま");
} else {
  failed += 1;
  console.log("NG ニューボーンの振り分け");
}

const structured = htmlToStructuredText(
  `<h5>退院プレゼント</h5><p>当院オリジナルBébéグッズ （臍帯箱・フード付バスタオル・トートバッグ）、生まれて1日目の赤ちゃんのお写真などをお渡しします。</p><h2>退院後の健康診断</h2><p>別の節</p>`
);
const headAt = structured.indexOf("【退院プレゼント】");
const bodyAt = structured.indexOf("臍帯箱");
const nextAt = structured.indexOf("【退院後の健康診断】");
if (headAt < 0 || bodyAt < headAt || (nextAt >= 0 && bodyAt > nextAt)) {
  failed += 1;
  console.log("NG 見出しと本文が離れた", structured);
} else {
  console.log("OK 見出し【退院プレゼント】の直後に本文");
}

const buried = `${"あ".repeat(1500)}\n【退院プレゼント】\n臍帯箱と写真をお渡しします。\n【次】\n別`;
const promoted = promoteNamedSection(buried, "退院プレゼント");
if (!promoted.startsWith("【退院プレゼント】") || !promoted.includes("臍帯箱")) {
  failed += 1;
  console.log("NG 後ろにある節を先頭へ寄せられなかった");
} else {
  console.log("OK 後ろの退院プレゼント節は先頭に残る");
}

if (failed) {
  console.log(`failed ${failed}`);
  process.exit(1);
}
console.log("all passed");
