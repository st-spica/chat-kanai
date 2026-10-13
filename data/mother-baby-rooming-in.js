/**
 * 母子同室の開始時期・入院スケジュール
 *
 * 公式: https://kanai.or.jp/obstetrics/hospitalization/ 「入院スケジュール」
 * ・産後1日目：体調に合わせて母子同室開始（帝王切開は3日目〜）
 * ・産後2〜4日目：夜間の母子同室開始
 * ・出産当日はゆっくり休む
 * 一般的な産院の「直後から同室」推測は禁止。
 */

export const MOTHER_BABY_ROOMING_IN_REF_PAGE = {
  url: "https://kanai.or.jp/obstetrics/hospitalization/",
  title: "入院中の生活・入院スケジュール",
};

export const MOTHER_BABY_ROOMING_IN_ANSWER = [
  "当院では、通常、出産翌日（産後1日目）から、",
  "お母さんの体調に合わせて母子同室を開始します。",
  "",
  "帝王切開の場合は、産後3日目からとなります。",
  "",
  "また、夜間の母子同室は、",
  "産後2〜4日目を目安に体調に合わせて始めていきます。",
  "",
  "詳しいスケジュールは、",
  "下記のページでもご案内しています。",
].join("\n");

export const MOTHER_BABY_ROOMING_IN_CESAREAN_ANSWER = [
  "帝王切開の場合、当院では産後3日目から、",
  "お母さんの体調に合わせて母子同室を開始します。",
  "",
  "経腟分娩の場合は、通常、出産翌日（産後1日目）からです。",
  "",
  "夜間の母子同室は、産後2〜4日目を目安に",
  "体調に合わせて始めていきます。",
  "",
  "詳しいスケジュールは、",
  "下記のページでもご案内しています。",
].join("\n");

export const MOTHER_BABY_ROOMING_IN_NIGHT_ANSWER = [
  "当院では、夜間の母子同室は、",
  "産後2〜4日目を目安に、お母さんの体調に合わせて開始します。",
  "",
  "日中の母子同室は、通常、出産翌日（産後1日目）から",
  "（帝王切開の場合は産後3日目から）始まります。",
  "",
  "詳しいスケジュールは、",
  "下記のページでもご案内しています。",
].join("\n");

export const MOTHER_BABY_ROOMING_IN_SAME_DAY_ANSWER = [
  "当院では、出産当日はゆっくりお休みいただき、",
  "母子同室は通常、出産翌日（産後1日目）から、",
  "お母さんの体調に合わせて開始します。",
  "",
  "帝王切開の場合は、産後3日目からとなります。",
  "",
  "夜間の母子同室は、産後2〜4日目を目安に",
  "体調に合わせて始めていきます。",
  "",
  "詳しいスケジュールは、",
  "下記のページでもご案内しています。",
].join("\n");

export const HOSPITALIZATION_SCHEDULE_OVERVIEW_ANSWER = [
  "当院の入院スケジュールの目安は次のとおりです。",
  "",
  "・出産当日：ゆっくりお休みください",
  "・産後1日目：体調に合わせて母子同室開始",
  "　（帝王切開の方は産後3日目から）",
  "・産後2〜4日目：体調に合わせて夜間の母子同室開始",
  "",
  "個人によりスケジュールは多少異なります。",
  "詳しくは下記のページでもご案内しています。",
].join("\n");

/**
 * @param {string} userMessage
 */
export function isMotherBabyRoomingInQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;

  // 面会・料金・持ち物・産後ケアは除外
  if (/面会|お見舞い|入院費|個室料金|持ち物|産後ケア|母乳ケア/.test(msg)) {
    return false;
  }

  if (/母子同室|同室になる|同室です|赤ちゃんと(?:一緒|同室)/.test(msg)) {
    return true;
  }
  if (
    /(?:赤ちゃん|ベビー).{0,12}(?:同室|一緒に(?:過ご|寝|いる))/.test(msg) ||
    /(?:同室|一緒).{0,12}(?:赤ちゃん|ベビー)/.test(msg)
  ) {
    return true;
  }
  // 入院スケジュール全般
  if (/入院スケジュール|出産後の(?:入院)?スケジュール|入院中のスケジュール/.test(msg)) {
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
export function buildMotherBabyRoomingInAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isMotherBabyRoomingInQuery(msg)) return null;

  const ref = [MOTHER_BABY_ROOMING_IN_REF_PAGE];

  // 入院スケジュール全体
  if (
    /入院スケジュール|出産後の(?:入院)?スケジュール|入院中のスケジュール/.test(
      msg
    ) &&
    !/母子同室|同室|夜間/.test(msg)
  ) {
    return {
      answer: HOSPITALIZATION_SCHEDULE_OVERVIEW_ANSWER,
      intent: "mother_baby_rooming_in",
      focus: "schedule_overview",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  // 夜間の母子同室
  if (/夜間|夜も|夜は|夜の同室|夜に同室/.test(msg)) {
    return {
      answer: MOTHER_BABY_ROOMING_IN_NIGHT_ANSWER,
      intent: "mother_baby_rooming_in",
      focus: "night_rooming_in",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  // 帝王切開
  if (/帝王切開|帝切|シーエス|ＣＳ|CS切開/.test(msg)) {
    return {
      answer: MOTHER_BABY_ROOMING_IN_CESAREAN_ANSWER,
      intent: "mother_baby_rooming_in",
      focus: "cesarean",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  // 出産当日・翌日からか
  if (
    /出産した日|出産当日|当日から|直後|すぐ|その日|産んだ日|出産した日から/.test(
      msg
    )
  ) {
    return {
      answer: MOTHER_BABY_ROOMING_IN_SAME_DAY_ANSWER,
      intent: "mother_baby_rooming_in",
      focus: "not_same_day",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  return {
    answer: MOTHER_BABY_ROOMING_IN_ANSWER,
    intent: "mother_baby_rooming_in",
    focus: "start_day",
    useExactAnswer: true,
    referencedPages: ref,
  };
}
