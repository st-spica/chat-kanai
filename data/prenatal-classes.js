/**
 * 産前産後教室の確定案内
 *
 * 公式: https://kanai.or.jp/lesson/
 * 質問された教室を優先。未確認の教室は推測しない。
 * 開催日時・料金の最新は公式ページ優先。医学的な参加可否はAIが判断しない。
 */

export const PRENATAL_CLASSES_REF_PAGE = {
  url: "https://kanai.or.jp/lesson/",
  title: "産前産後教室のご案内",
};

/**
 * 公式ページで確認できた教室（実施中）
 * 前期クラスは休止中のため一覧に含めない
 */
export const PRENATAL_CLASSES = [
  {
    id: "late_class",
    name: "後期クラス",
    aliases: [/後期クラス/, /後期の?教室/],
    category: "basic",
    prenatal: true,
    postnatal: false,
    feeYen: 0,
    feeNote: "基本コース（無料）",
    scheduleSummary: "第2・4火曜日 10:00（妊娠33〜36週）",
    reservation: "internet",
    notes: "当院で分娩予定の方は必ず受講。参加者は妊婦さまご本人のみ。",
  },
  {
    id: "maternity_aerobics",
    name: "マタニティビクス",
    aliases: [
      /マタニティ\s*ビクス/,
      /マタニティー?ビクス/,
      /マタニティエアロ/,
    ],
    category: "optional_prenatal",
    prenatal: true,
    postnatal: false,
    feeYen: 1000,
    feeNote: "選択コース 1名につき1,000円／回",
    scheduleSummary: "木曜 09:30〜／火曜 14:40〜（妊娠13週以降）",
    reservation: "internet",
    notes: "医師の許可が必要（健診時に医師へ相談）。",
  },
  {
    id: "maternity_yoga",
    name: "マタニティヨーガ",
    aliases: [
      /マタニティ\s*ヨーガ/,
      /マタニティ\s*ヨガ/,
      /マタニティー?(?:ヨーガ|ヨガ)/,
    ],
    category: "optional_prenatal",
    prenatal: true,
    postnatal: false,
    feeYen: 1000,
    feeNote: "選択コース 1名につき1,000円／回",
    scheduleSummary: "木曜 13:00〜（妊娠16週以降）",
    reservation: "internet",
    notes: null,
  },
  {
    id: "mama_fit",
    name: "ママフィット withベビー",
    aliases: [/ママフィット/, /ママ\s*フィット/],
    category: "optional_postnatal",
    prenatal: false,
    postnatal: true,
    feeYen: 1000,
    feeNote: "選択コース 1名につき1,000円／回",
    scheduleSummary: "木曜 11:00〜（1ヵ月健診以降）",
    reservation: "internet",
    notes: null,
  },
  {
    id: "mama_yoga",
    name: "ママヨガ withベビー",
    aliases: [/ママヨガ/, /ママ\s*ヨーガ/, /ママ\s*ヨガ/],
    category: "optional_postnatal",
    prenatal: false,
    postnatal: true,
    feeYen: 1000,
    feeNote: "選択コース 1名につき1,000円／回",
    scheduleSummary: "火曜 13:00〜（1ヵ月健診以降）",
    reservation: "internet",
    notes: null,
  },
];

const CLASS_LIST_FOR_OVERVIEW = PRENATAL_CLASSES.map((c) => c.name).join("、");

/**
 * @param {string} msg
 */
function findMentionedClass(msg) {
  const text = String(msg || "");
  for (const c of PRENATAL_CLASSES) {
    if (c.aliases.some((re) => re.test(text))) return c;
  }
  return null;
}

/**
 * 医学的に教室案内より受診・医師確認を優先すべきか
 * @param {string} msg
 */
export function hasPrenatalClassMedicalConcern(msg) {
  const t = String(msg || "");
  return (
    /出血|お腹の張り|おなかの張り|切迫早産|安静指示|安静に|入院指示|破水|強い腹痛|胎動が少/.test(
      t
    ) ||
    /運動して(?:大丈夫|いい|良い)|運動(?:して)?も(?:大丈夫|いい|良い)|参加して(?:大丈夫|いい)|やって(?:大丈夫|いい)/.test(
      t
    )
  );
}

/**
 * @param {string} userMessage
 */
export function isPrenatalClassesQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;

  // ニューボーン／マタニティフォトは別
  if (/マタニティフォト|ニューボーン|マタニティ写真/.test(msg)) return false;
  // 体重・BMI主体（教室名なし）
  if (
    /BMI|体重増加|太りすぎ|ダイエット|何\s*(?:kg|キロ)/.test(msg) &&
    !findMentionedClass(msg) &&
    !/教室|ヨーガ|ヨガ|ビクス|ママフィット/.test(msg)
  ) {
    return false;
  }

  if (findMentionedClass(msg)) return true;
  if (/産前教室|産後教室|産前産後教室|母親教室|アクティブクラス/.test(msg)) {
    return true;
  }
  if (/妊婦向け.{0,8}(?:教室|運動)|妊娠中.{0,8}(?:教室|参加できる教室)/.test(msg)) {
    return true;
  }
  if (
    /(?:教室).{0,12}(?:種類|どんな|ある|開催|予約|料金|日時|いつ)/.test(msg) ||
    /(?:どんな|どの).{0,8}教室/.test(msg)
  ) {
    return true;
  }
  if (/教室について|教室を教えて|教室の案内/.test(msg)) return true;
  // 妊娠中の運動可否（医学判断はしない。教室案内＋医師確認）
  if (
    /妊娠中.{0,12}運動.{0,12}(?:大丈夫|いい|良い)|運動して(?:大丈夫|いい|良い)|運動しても(?:大丈夫|いい|良い)/.test(
      msg
    )
  ) {
    return true;
  }
  return false;
}

/**
 * @param {string} msg
 */
function asksSchedule(msg) {
  return /いつ|日時|曜日|時間|開催|スケジュール|日程/.test(msg);
}

/**
 * @param {string} msg
 */
function asksReservation(msg) {
  return /予約|申し込み|申込|どうやって参加|参加方法|どうしたらいい/.test(msg);
}

/**
 * @param {string} msg
 */
function asksFee(msg) {
  return /料金|費用|いくら|値段|価格|円/.test(msg);
}

/**
 * @param {string} msg
 */
function asksOverview(msg) {
  return (
    /どんな教室|教室にはどんな|教室の種類|どんな種類|産前教室について|産後教室について|産前産後教室について|妊婦向けの教室|妊娠中に参加できる教室|母親教室/.test(
      msg
    ) ||
    (/教室/.test(msg) && /教えて|知りたい|ある/.test(msg) && !findMentionedClass(msg))
  );
}

/**
 * @param {typeof PRENATAL_CLASSES[0]} klass
 */
function availabilityAnswer(klass) {
  return [
    `はい、当院では${klass.name}を実施しています。`,
    "",
    "開催日時や参加方法などの詳細は、下記のページでご案内しておりますので、ぜひご覧ください。",
  ].join("\n");
}

/**
 * @param {typeof PRENATAL_CLASSES[0]} klass
 * @param {string} msg
 */
function detailAnswer(klass, msg) {
  const lines = [`はい、当院では${klass.name}を実施しています。`, ""];

  if (asksSchedule(msg) && klass.scheduleSummary) {
    lines.push(`開催の目安は、${klass.scheduleSummary}です。`);
    lines.push("最新の開催日時は、下記のページでご確認ください。");
  } else if (asksReservation(msg)) {
    lines.push(
      "各クラスは完全予約制で、インターネット予約ページからご予約いただけます。"
    );
    lines.push("当日は直接２階Bébéホールまでお越しください。");
    lines.push("詳細は下記のページをご確認ください。");
  } else if (asksFee(msg)) {
    if (klass.feeYen === 0) {
      lines.push(`${klass.name}は基本コースのため、受講料はかかりません。`);
    } else {
      lines.push(
        `${klass.name}は選択コースで、1名につき${klass.feeYen.toLocaleString("ja-JP")}円／回です。`
      );
      lines.push("受講料は２階受付でお支払いください。");
    }
    lines.push("詳細は下記のページをご確認ください。");
  } else {
    lines.push(
      "開催日時や参加方法などの詳細は、下記のページでご案内しておりますので、ぜひご覧ください。"
    );
  }

  // ページ記載の参加条件（推測で広げない）
  if (
    klass.id === "maternity_aerobics" &&
    (asksReservation(msg) || /参加|受けたい|やりたい/.test(msg))
  ) {
    lines.push("", "※医師の許可が必要です。健診時にご相談ください。");
  }

  return lines.filter(Boolean).join("\n");
}

/**
 * @param {string} userMessage
 * @returns {{
 *   answer: string,
 *   intent: string,
 *   focus: string,
 *   classId: string|null,
 *   useExactAnswer: boolean,
 *   referencedPages: Array<{url:string,title:string}>,
 * }|null}
 */
export function buildPrenatalClassesAnswer(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!isPrenatalClassesQuery(msg)) return null;

  const ref = [PRENATAL_CLASSES_REF_PAGE];

  // 医学的参加可否・症状 → 判断せず医師確認＋ページ案内
  if (hasPrenatalClassMedicalConcern(msg)) {
    const klass = findMentionedClass(msg);
    const head = klass
      ? `当院では${klass.name}を実施しています。`
      : "当院では産前産後教室を実施しています。";
    return {
      answer: [
        head,
        "",
        "ご自身の妊娠経過で参加してよいかは、AIでは判断できません。",
        "出血やお腹の張り、安静指示がある場合などは、参加前に必ず医師へご確認ください。",
        "",
        "教室の詳細は、下記のページでご案内しております。",
      ].join("\n"),
      intent: "prenatal_classes",
      focus: "medical_caution",
      classId: klass?.id || null,
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  const klass = findMentionedClass(msg);
  if (klass) {
    const needsDetail = asksSchedule(msg) || asksReservation(msg) || asksFee(msg);
    return {
      answer: needsDetail ? detailAnswer(klass, msg) : availabilityAnswer(klass),
      intent: "prenatal_classes",
      focus: needsDetail
        ? asksSchedule(msg)
          ? "schedule"
          : asksReservation(msg)
            ? "reservation"
            : "fee"
        : "availability",
      classId: klass.id,
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  // 母親教室など公式に同名がない場合も、産前産後教室へ誘導（名称を捏造しない）
  if (/母親教室/.test(msg)) {
    return {
      answer: [
        "当院では産前産後教室を実施しています。",
        "",
        "後期クラスやマタニティビクス・マタニティヨーガなどの教室をご用意しています。",
        "",
        "開催日時や参加方法などの詳細は、下記のページでご案内しておりますので、ぜひご覧ください。",
      ].join("\n"),
      intent: "prenatal_classes",
      focus: "mother_class_alias",
      classId: null,
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  if (asksOverview(msg) || /産前教室|産後教室|産前産後教室|妊婦向け/.test(msg)) {
    const lines = [
      "はい、当院では産前産後教室を実施しています。",
      "",
      `教室には、${CLASS_LIST_FOR_OVERVIEW}などがあります。`,
      "",
    ];
    if (asksReservation(msg)) {
      lines.push(
        "各クラスは完全予約制で、インターネット予約ページからご予約いただけます。"
      );
    } else if (asksFee(msg)) {
      lines.push(
        "基本コース（後期クラス）は無料、選択コースは1名につき1,000円／回です。"
      );
    } else if (asksSchedule(msg)) {
      lines.push("開催日時については、下記のページでご案内しています。");
    } else {
      lines.push(
        "開催日時や参加方法などの詳細は、下記のページでご案内しておりますので、ぜひご覧ください。"
      );
    }
    return {
      answer: lines.join("\n"),
      intent: "prenatal_classes",
      focus: "overview",
      classId: null,
      useExactAnswer: true,
      referencedPages: ref,
    };
  }

  return {
    answer: [
      "はい、当院では産前産後教室を実施しています。",
      "",
      "開催日時や参加方法などの詳細は、下記のページでご案内しておりますので、ぜひご覧ください。",
    ].join("\n"),
    intent: "prenatal_classes",
    focus: "general",
    classId: null,
    useExactAnswer: true,
    referencedPages: ref,
  };
}
