/**
 * 母体搬送・新生児搬送（救急搬送体制）
 *
 * 公式: https://kanai.or.jp/about/feature/
 * 「安心安全のためのシステム」「母体搬送および新生児搬送」
 * 母体搬送=OGCS、新生児搬送=NMCS。搬送先の確約・必ず搬送できる保証はしない。
 * 院内NICUの有無と搬送体制を混同しない。
 */

export const EMERGENCY_TRANSFER_REF_PAGE = {
  url: "https://kanai.or.jp/about/feature/",
  title: "当院の特長・緊急時の対応",
};

export const EMERGENCY_TRANSFER_ANSWER = [
  "はい。出産時にお母さんや赤ちゃんに",
  "高度な医療が必要と判断された場合は、",
  "連携する医療機関へ救急搬送を行います。",
  "",
  "当院では、お母さんの搬送にはOGCS、",
  "赤ちゃんの搬送にはNMCSという",
  "医療機関の連携システムを利用し、",
  "緊急時に対応できる体制を整えています。",
  "",
  "搬送先は、その時の状況に応じて判断されます。",
  "詳しくは下記のページでもご案内しています。",
].join("\n");

/** 搬送先を尋ねられたとき（病院名を確約しない） */
export const EMERGENCY_TRANSFER_DESTINATION_ANSWER = [
  "高次医療が必要と判断された場合は、",
  "OGCS（母体搬送）・NMCS（新生児搬送）の",
  "受入れ施設と連携して救急搬送に対応しています。",
  "",
  "搬送先は、その時の状況に応じて判断されるため、",
  "あらかじめ特定の病院へ搬送するとお約束することはできません。",
  "",
  "詳しくは下記のページでもご案内しています。",
].join("\n");

/**
 * NICU質問：院内NICUの有無を断定せず、新生児搬送体制（NMCS）を案内
 * （公式に院内NICU設置の記載はない／搬送体制と混同しない）
 */
export const EMERGENCY_TRANSFER_NICU_ANSWER = [
  "当院では、赤ちゃんに高度な医療が必要と判断された場合、",
  "NMCS（新生児診療相互援助システム）の受入れ施設と連携し、",
  "新生児の救急搬送に対応しています。",
  "",
  "院内にNICUがあるかどうかとは別に、",
  "緊急時には連携する医療機関へ搬送できる体制を整えています。",
  "",
  "搬送の要否や搬送先は、その時の状況に応じて判断されます。",
  "詳しくは下記のページでもご案内しています。",
].join("\n");

/**
 * @param {string} userMessage
 */
export function isEmergencyMaternalNeonatalTransferQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;

  // 陣痛の連絡タイミング・一般救急とは分離
  if (
    /陣痛が|何分間隔|破水した|胎動が/.test(msg) &&
    !/搬送|OGCS|NMCS|NICU|高次医療|他の病院|他院/.test(msg)
  ) {
    return false;
  }
  // 産後ケア・外来アクセス等は除外
  if (/産後ケア|母乳ケア|駐車場|診療時間|初診料/.test(msg)) return false;

  if (/OGCS|NMCS|母体搬送|新生児搬送/.test(msg)) return true;

  if (/NICU|ＧＣＵ|GCU|未熟児センター|新生児集中/.test(msg)) return true;

  // 搬送先・救急搬送体制そのもの（出産文脈語がなくても）
  if (
    /(?:どこ|どの病院|搬送先).{0,12}搬送|搬送.{0,12}(?:どこ|どの病院|先)|救急搬送の体制|搬送の体制/.test(
      msg
    )
  ) {
    return true;
  }

  const transferCue =
    /搬送|救急搬送|転院|他の病院|他院に|高次医療|連携.*病院|病院に連れて|送られ/.test(
      msg
    );
  const birthOrBabyCue =
    /出産|分娩|お産|帝王切開|母体|赤ちゃん|新生児|胎児|もし.{0,8}何か|緊急時|何かあった|金井/.test(
      msg
    );

  if (transferCue && birthOrBabyCue) return true;

  // 「出産中に何かあったらどうなりますか」（搬送語なしでも緊急時対応）
  if (
    /(?:出産|分娩|お産)中?.{0,16}(?:何か|異常|緊急)/.test(msg) ||
    /(?:もし|万が一).{0,12}(?:出産|分娩|お産).{0,16}(?:何か|異常)/.test(msg)
  ) {
    return true;
  }

  // 「赤ちゃんに異常があったら」「連携している病院は」
  if (
    /(?:赤ちゃん|新生児|胎児).{0,16}(?:異常|具合|何か|具合が悪|具合悪)/.test(msg) ||
    /(?:異常|具合が悪).{0,12}(?:赤ちゃん|新生児)/.test(msg)
  ) {
    return true;
  }
  if (
    /連携(?:している|してる)?病院|関連病院|提携病院|バックアップ病院/.test(msg) &&
    /(?:出産|分娩|お産|緊急|搬送|産婦人科|当院|金井)/.test(msg)
  ) {
    return true;
  }
  if (/連携(?:している|してる)?病院|関連病院はありますか/.test(msg)) {
    return true;
  }

  // 「帝王切開でも対応できない場合」
  if (/帝王切開.{0,16}(?:対応でき|できな|無理|搬送)|対応できない場合/.test(msg)) {
    return true;
  }

  return false;
}

/**
 * @param {string} userMessage
 * @returns {{
 *   answer: string,
 *   intent: string,
 *   focus: string,
 *   useExactAnswer: boolean,
 *   referencedPages: Array<{url:string,title:string}>,
 * }|null}
 */
export function buildEmergencyMaternalNeonatalTransferAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isEmergencyMaternalNeonatalTransferQuery(msg)) return null;

  const ref = [EMERGENCY_TRANSFER_REF_PAGE];

  // NICU（院内設備と搬送体制を混同しない）
  if (/NICU|ＧＣＵ|GCU|未熟児センター|新生児集中/.test(msg)) {
    return {
      answer: EMERGENCY_TRANSFER_NICU_ANSWER,
      intent: "emergency_maternal_neonatal_transfer",
      focus: "nicu_vs_transfer",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  // 搬送先の病院名
  if (
    /どこ(?:の病院|へ|に)|どの病院|搬送先|どこの病院|どの施設/.test(msg)
  ) {
    return {
      answer: EMERGENCY_TRANSFER_DESTINATION_ANSWER,
      intent: "emergency_maternal_neonatal_transfer",
      focus: "destination",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  // 母体搬送にフォーカス
  let focus = "overview";
  if (/母体搬送|お母さんの搬送|ママの搬送|OGCS/.test(msg) && !/NMCS|赤ちゃん|新生児|NICU/.test(msg)) {
    focus = "maternal_ogcs";
  } else if (
    /新生児搬送|赤ちゃん.{0,8}搬送|NMCS|赤ちゃんに異常/.test(msg) &&
    !/母体|OGCS|お母さん/.test(msg)
  ) {
    focus = "neonatal_nmcs";
  }

  return {
    answer: EMERGENCY_TRANSFER_ANSWER,
    intent: "emergency_maternal_neonatal_transfer",
    focus,
    useExactAnswer: true,
    referencedPages: ref,
  };
}
