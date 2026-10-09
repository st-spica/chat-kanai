/**
 * 交通アクセス・最寄駅・駐車場の確定案内
 *
 * 公式: https://kanai.or.jp/access/
 * 公式サイトで確認できる内容について、一般質問では電話問い合わせを勧めない。
 * 画像マップにしか無い情報や未確認の交通手段は推測しない。
 */

export const ACCESS_REF_PAGE = {
  url: "https://kanai.or.jp/access/",
  title: "交通アクセス・アクセスマップ",
};

/** 公式アクセスページで確認できた確定情報 */
export const CLINIC_ACCESS = {
  address: "大阪府大阪市城東区今福西１丁目２-８",
  addressDisplay: "大阪府大阪市城東区今福西1丁目2-8",
  metro: {
    station: "蒲生四丁目",
    lines: "長堀鶴見緑地線・今里筋線",
    exit: "3号出口",
    walk: "約3分",
    walkDetail: "3号出口から南へ徒歩約3分",
  },
  jr: {
    station: "鴫野",
    lines: "学研都市線・おおさか東線",
    walk: "約10分",
  },
  bus: {
    summary:
      "大阪シティバス21・35号系統『新喜多大橋』バス停（35号系統）下車すぐ",
    note: "JR鴫野駅前にも市バス35号系統のバス停があります。",
  },
  parking: {
    capacity: 5,
    hours: "8:30〜20:00",
    entrance: "今里筋側から出入り",
    closedNote:
      "20:00を過ぎると翌朝8:30まで閉鎖されます。",
    roadNote:
      "駐車場出入口より東側（奥側）は自転車歩行者専用道路で、居住者用車両を除く一般車両は通行禁止です。",
  },
};

export const ACCESS_STATIONS_ANSWER = [
  "当院の最寄駅は、以下の2つです。",
  "",
  "🚃 大阪メトロ『蒲生四丁目』駅",
  "長堀鶴見緑地線・今里筋線",
  "3号出口から南へ徒歩約3分",
  "",
  "🚃 JR『鴫野』駅",
  "学研都市線・おおさか東線",
  "徒歩約10分",
  "",
  "駅からの道順や詳しいアクセス方法は、",
  "下記のページでご案内しておりますので、",
  "ぜひご覧ください。",
].join("\n");

export const ACCESS_GAMOU_WALK_ANSWER = [
  "大阪メトロ『蒲生四丁目』駅の",
  "3号出口から南へ徒歩約3分です。",
  "",
  "詳しい道順は下記のページをご覧ください。",
].join("\n");

export const ACCESS_GAMOU_EXIT_ANSWER = [
  "大阪メトロ『蒲生四丁目』駅は、",
  "3号出口をご利用ください。",
  "",
  "3号出口から南へ徒歩約3分でお越しいただけます。",
  "",
  "詳しい道順は下記のページをご覧ください。",
].join("\n");

export const ACCESS_SHIGINO_ANSWER = [
  "はい、JR『鴫野』駅から",
  "徒歩約10分でお越しいただけます。",
  "",
  "詳しいアクセス方法は",
  "下記のページをご確認ください。",
].join("\n");

export const ACCESS_LOCATION_ANSWER = [
  `当院の所在地は、${CLINIC_ACCESS.addressDisplay}です。`,
  "",
  "最寄駅は、大阪メトロ『蒲生四丁目』駅（3号出口から南へ徒歩約3分）と、",
  "JR『鴫野』駅（徒歩約10分）です。",
  "",
  "詳しいアクセス方法は、下記のページをご確認ください。",
].join("\n");

export const ACCESS_PARKING_ANSWER = [
  "はい、駐車場がございます（5台）。",
  "",
  "ご利用時間は8:30〜20:00です。",
  "20:00を過ぎると翌朝8:30まで閉鎖されますのでご注意ください。",
  "",
  "駐車場の出入りは今里筋側から行ってください。",
  "出入口より東側（奥側）は自転車歩行者専用道路で、",
  "居住者用車両を除く一般車両は通行禁止です。",
  "",
  "詳しいアクセス方法は、下記のページをご確認ください。",
].join("\n");

export const ACCESS_CAR_ANSWER = [
  "はい、お車でもお越しいただけます。",
  "",
  "駐車場は5台分あり、ご利用時間は8:30〜20:00です。",
  "駐車場の出入りは今里筋側から行ってください。",
  "",
  "詳しいアクセス方法は、下記のページをご確認ください。",
].join("\n");

export const ACCESS_BUS_ANSWER = [
  "はい、バスでもお越しいただけます。",
  "",
  "大阪シティバス21・35号系統『新喜多大橋』バス停",
  "（35号系統／杭全方面・守口車庫前方面）下車すぐです。",
  "",
  "JR鴫野駅前にも市バス35号系統のバス停があります。",
  "",
  "詳しいアクセス方法は、下記のページをご確認ください。",
].join("\n");

export const ACCESS_BICYCLE_ANSWER = [
  "自転車での来院について、公式サイト上で確認できる駐輪場の詳細はありません。",
  "",
  "所在地や駅・バスからのアクセスは、",
  "下記のページでご案内しておりますのでご確認ください。",
].join("\n");

export const ACCESS_OVERVIEW_ANSWER = [
  "当院へのアクセス方法は、以下のとおりです。",
  "",
  "🚃 大阪メトロ『蒲生四丁目』駅",
  "長堀鶴見緑地線・今里筋線",
  "3号出口から南へ徒歩約3分",
  "",
  "🚃 JR『鴫野』駅",
  "学研都市線・おおさか東線",
  "徒歩約10分",
  "",
  "バスや駐車場のご案内も含め、詳しいアクセス方法は",
  "下記のページでご案内しております。",
].join("\n");

/**
 * 施設案内・予約など他トピックへ流さない
 * @param {string} msg
 */
function isOtherAccessAdjacentTopic(msg) {
  // 院内施設・部屋（アクセスではない）
  if (
    /院内施設|施設案内|入院部屋|病室|授乳スペース|授乳室|休憩スペース|休憩室/.test(
      msg
    )
  ) {
    return true;
  }
  // 診療時間・予約
  if (
    /診療時間|休診|予約|初診料|面会|立ち会い|立会い/.test(msg) &&
    !/アクセス|行き方|最寄|駅|駐車|バス|地図|住所|場所/.test(msg)
  ) {
    return true;
  }
  return false;
}

/**
 * @param {string} userMessage
 */
export function isClinicAccessQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  if (isOtherAccessAdjacentTopic(msg)) return false;

  if (/最寄(?:り)?駅|一番近い駅|何駅で降り|どの駅で降り/.test(msg)) {
    return true;
  }
  if (/蒲生四丁目|蒲生4丁目|がもうよん|ガモウ/.test(msg)) return true;
  if (/鴫野|しぎの|シギノ/.test(msg)) return true;
  if (/電車で行|電車で来|電車でお越|電車でのアクセス/.test(msg)) return true;
  if (
    /アクセス(?:方法|案内)?|行き方|道順|アクセスマップ|交通アクセス/.test(msg)
  ) {
    return true;
  }
  if (/病院の場所|医院の場所|クリニックの場所|所在地|住所を教えて|地図/.test(msg)) {
    return true;
  }
  if (/駐車場|パーキング/.test(msg)) return true;
  if (
    /(?:お)?車で(?:行|来|お越)|自動車で/.test(msg) &&
    !/電車/.test(msg)
  ) {
    return true;
  }
  if (/自転車で行|自転車で来|駐輪/.test(msg)) return true;
  if (/バスで行|バスで来|バス停|シティバス/.test(msg)) return true;
  if (/病院への行き方|病院まで(?:の)?(?:行き方|アクセス)|どうやって行/.test(msg)) {
    return true;
  }
  return false;
}

/**
 * @param {string} msg
 */
function isGamouFocus(msg) {
  return /蒲生四丁目|蒲生4丁目|がもうよん/.test(msg);
}

/**
 * @param {string} msg
 */
function isShiginoFocus(msg) {
  return /鴫野|しぎの/.test(msg);
}

/**
 * @param {string} msg
 */
function asksExit(msg) {
  return /何番出口|何号出口|出口は|どの出口|出口番号/.test(msg);
}

/**
 * @param {string} msg
 */
function isParkingFocus(msg) {
  return /駐車場|パーキング/.test(msg);
}

/**
 * @param {string} msg
 */
function isCarFocus(msg) {
  if (/電車/.test(msg)) return false;
  return (
    /(?:お)?車で(?:行|来|お越)|自動車で/.test(msg) && !isParkingFocus(msg)
  );
}

/**
 * @param {string} msg
 */
function isBusFocus(msg) {
  return /バスで行|バスで来|バス停|シティバス|バスで行け/.test(msg);
}

/**
 * @param {string} msg
 */
function isBicycleFocus(msg) {
  return /自転車で行|自転車で来|駐輪/.test(msg);
}

/**
 * @param {string} msg
 */
function isLocationFocus(msg) {
  return /病院の場所|医院の場所|クリニックの場所|所在地|住所/.test(msg);
}

/**
 * @param {string} msg
 */
function isStationOverview(msg) {
  return (
    /最寄(?:り)?駅|一番近い駅|何駅で降り|どの駅で降り|電車で行|電車で来/.test(
      msg
    ) && !isGamouFocus(msg) && !isShiginoFocus(msg)
  );
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
export function buildClinicAccessAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isClinicAccessQuery(msg)) return null;

  const ref = [ACCESS_REF_PAGE];

  if (isBicycleFocus(msg)) {
    return {
      answer: ACCESS_BICYCLE_ANSWER,
      intent: "clinic_access",
      focus: "bicycle",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  if (isBusFocus(msg)) {
    return {
      answer: ACCESS_BUS_ANSWER,
      intent: "clinic_access",
      focus: "bus",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  if (isParkingFocus(msg)) {
    return {
      answer: ACCESS_PARKING_ANSWER,
      intent: "clinic_access",
      focus: "parking",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  if (isCarFocus(msg)) {
    return {
      answer: ACCESS_CAR_ANSWER,
      intent: "clinic_access",
      focus: "car",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  if (isLocationFocus(msg)) {
    return {
      answer: ACCESS_LOCATION_ANSWER,
      intent: "clinic_access",
      focus: "location",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  if (isGamouFocus(msg)) {
    if (asksExit(msg)) {
      return {
        answer: ACCESS_GAMOU_EXIT_ANSWER,
        intent: "clinic_access",
        focus: "gamou_exit",
        useExactAnswer: true,
        referencedPages: ref,
      };
    }
    return {
      answer: ACCESS_GAMOU_WALK_ANSWER,
      intent: "clinic_access",
      focus: "gamou_walk",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  if (isShiginoFocus(msg)) {
    return {
      answer: ACCESS_SHIGINO_ANSWER,
      intent: "clinic_access",
      focus: "shigino",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  if (isStationOverview(msg)) {
    return {
      answer: ACCESS_STATIONS_ANSWER,
      intent: "clinic_access",
      focus: "stations",
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  // アクセス方法・行き方など一般
  return {
    answer: ACCESS_OVERVIEW_ANSWER,
    intent: "clinic_access",
    focus: "overview",
    useExactAnswer: true,
    referencedPages: ref,
  };
}
