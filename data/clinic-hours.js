/**
 * 金井産婦人科の診療時間・休診日（確定データ）
 *
 * AIによる推測禁止。回答は本モジュールの確定データからプログラム生成する。
 * 臨時休診は usual schedule とは別に temporaryClosures で管理する。
 */

/** @typedef {"morning"|"afternoon"|"evening"} ClinicSessionId */
/** @typedef {0|1|2|3|4|5|6} WeekdayIndex */ // 0=日 … 6=土

export const CLINIC_HOURS_REF_PAGE = {
  url: "https://kanai.or.jp/beginner/",
  title: "診療時間のご案内",
};

export const CLINIC_SESSIONS = {
  morning: {
    id: "morning",
    label: "午前診",
    start: "09:00",
    end: "11:30",
    weekdays: /** @type {WeekdayIndex[]} */ ([1, 2, 3, 4, 5, 6]),
  },
  afternoon: {
    id: "afternoon",
    label: "午後診",
    start: "13:00",
    end: "14:30",
    weekdays: /** @type {WeekdayIndex[]} */ ([1, 3, 4, 5]),
  },
  evening: {
    id: "evening",
    label: "夜診",
    start: "17:30",
    end: "19:00",
    weekdays: /** @type {WeekdayIndex[]} */ ([1, 3]),
  },
};

/** 休診条件（通常） */
export const CLINIC_CLOSED_RULES = {
  sunday: true,
  holidays: true,
  /** 土曜日のうち休診となる「第n」 */
  saturdayClosedOrdinals: /** @type {number[]} */ ([3, 5]),
};

/**
 * 臨時休診（通常スケジュールとは別管理）
 * @type {{ date: string, label?: string, note?: string }[]}
 * date は YYYY-MM-DD（Asia/Tokyo）
 */
export const CLINIC_TEMPORARY_CLOSURES = [];

export const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

/** 単独の「日」「月」は「曜日」「祝日」等に誤反応するため使わない */
const WEEKDAY_DETECT_PATTERNS = [
  [/日曜日|日曜/, 0],
  [/月曜日|月曜/, 1],
  [/火曜日|火曜/, 2],
  [/水曜日|水曜/, 3],
  [/木曜日|木曜/, 4],
  [/金曜日|金曜/, 5],
  [/土曜日|土曜/, 6],
];

const SESSION_ALIASES = {
  morning: /午前診|午前|朝/,
  afternoon: /午後診|午後/,
  evening: /夜診|夜の診察|夕方の診察|夜間診|夜の外来/,
};

/**
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} n 第n月曜
 */
function nthMondayOfMonth(year, month, n) {
  const first = new Date(Date.UTC(year, month - 1, 1, 12));
  const dow = first.getUTCDay(); // 0=Sun
  const firstMon = dow === 1 ? 1 : ((8 - dow) % 7) + 1;
  return firstMon + (n - 1) * 7;
}

function vernalEquinoxDay(year) {
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

function autumnalEquinoxDay(year) {
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

/**
 * 日本の祝日（振替休日・国民の休日含む）
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} day
 */
export function isJapaneseHoliday(year, month, day) {
  const set = japaneseHolidaySet(year);
  return set.has(`${month}-${day}`);
}

/** @param {number} year */
function japaneseHolidaySet(year) {
  /** @type {Set<string>} */
  const fixed = new Set();
  const add = (m, d) => fixed.add(`${m}-${d}`);

  add(1, 1); // 元日
  add(1, nthMondayOfMonth(year, 1, 2)); // 成人の日
  add(2, 11); // 建国記念の日
  add(2, 23); // 天皇誕生日
  add(3, vernalEquinoxDay(year)); // 春分の日
  add(4, 29); // 昭和の日
  add(5, 3); // 憲法記念日
  add(5, 4); // みどりの日
  add(5, 5); // こどもの日
  add(7, nthMondayOfMonth(year, 7, 3)); // 海の日
  add(8, 11); // 山の日
  add(9, nthMondayOfMonth(year, 9, 3)); // 敬老の日
  add(9, autumnalEquinoxDay(year)); // 秋分の日
  add(10, nthMondayOfMonth(year, 10, 2)); // スポーツの日
  add(11, 3); // 文化の日
  add(11, 23); // 勤労感謝の日

  // 振替休日・国民の休日
  /** @type {Set<string>} */
  const all = new Set(fixed);
  const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0, 12)).getUTCDate();

  for (const key of [...fixed]) {
    const [m, d] = key.split("-").map(Number);
    const dow = new Date(Date.UTC(year, m - 1, d, 12)).getUTCDay();
    if (dow === 0) {
      // 翌月曜が振替（既に祝日ならさらに翌へ）
      let nm = m;
      let nd = d + 1;
      while (true) {
        const dim = daysInMonth(year, nm);
        if (nd > dim) {
          nm += 1;
          nd = 1;
        }
        if (nm > 12) break;
        const k = `${nm}-${nd}`;
        if (!all.has(k)) {
          all.add(k);
          break;
        }
        nd += 1;
      }
    }
  }

  // 国民の休日: 祝日に挟まれた平日
  for (let m = 1; m <= 12; m++) {
    const dim = daysInMonth(year, m);
    for (let d = 1; d <= dim; d++) {
      const prev = d === 1 ? null : `${m}-${d - 1}`;
      const next = d === dim ? null : `${m}-${d + 1}`;
      const cur = `${m}-${d}`;
      if (prev && next && all.has(prev) && all.has(next) && !all.has(cur)) {
        const dow = new Date(Date.UTC(year, m - 1, d, 12)).getUTCDay();
        if (dow !== 0 && dow !== 6) all.add(cur);
      }
    }
  }

  return all;
}

/**
 * その月の第何曜日か（1始まり）
 * @param {number} day 1-31
 */
export function weekdayOrdinalInMonth(day) {
  return Math.ceil(Number(day) / 7);
}

/**
 * @param {ClinicSessionId} sessionId
 * @param {WeekdayIndex} weekday
 */
export function sessionRunsOnWeekday(sessionId, weekday) {
  const session = CLINIC_SESSIONS[sessionId];
  if (!session) return false;
  return session.weekdays.includes(weekday);
}

/**
 * 通常ルールでの休診理由（臨時休診は含めない）
 * @param {{ year: number, month: number, day: number, weekday?: WeekdayIndex }} date
 * @returns {{ closed: boolean, reasons: string[] }}
 */
export function getRegularClosedReasons(date) {
  const year = Number(date.year);
  const month = Number(date.month);
  const day = Number(date.day);
  const weekday =
    date.weekday != null
      ? date.weekday
      : /** @type {WeekdayIndex} */ (
          new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay()
        );
  /** @type {string[]} */
  const reasons = [];
  if (CLINIC_CLOSED_RULES.sunday && weekday === 0) reasons.push("sunday");
  if (CLINIC_CLOSED_RULES.holidays && isJapaneseHoliday(year, month, day)) {
    reasons.push("holiday");
  }
  if (
    weekday === 6 &&
    CLINIC_CLOSED_RULES.saturdayClosedOrdinals.includes(
      weekdayOrdinalInMonth(day)
    )
  ) {
    reasons.push(`saturday_nth_${weekdayOrdinalInMonth(day)}`);
  }
  return { closed: reasons.length > 0, reasons };
}

/**
 * @param {string} ymd YYYY-MM-DD
 */
export function findTemporaryClosure(ymd) {
  const key = String(ymd || "").trim();
  if (!key) return null;
  return (
    CLINIC_TEMPORARY_CLOSURES.find((x) => String(x.date).trim() === key) || null
  );
}

/**
 * 指定日の通常診療枠（休診なら空）
 * @param {{ year: number, month: number, day: number, weekday?: WeekdayIndex }} date
 * @returns {{ closed: boolean, reasons: string[], sessions: typeof CLINIC_SESSIONS[ClinicSessionId][], temporary: object|null }}
 */
export function getSessionsForDate(date) {
  const year = Number(date.year);
  const month = Number(date.month);
  const day = Number(date.day);
  const weekday =
    date.weekday != null
      ? date.weekday
      : /** @type {WeekdayIndex} */ (
          new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay()
        );
  const ymd = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const temporary = findTemporaryClosure(ymd);
  const regular = getRegularClosedReasons({ year, month, day, weekday });
  if (temporary) {
    return {
      closed: true,
      reasons: ["temporary", ...regular.reasons],
      sessions: [],
      temporary,
    };
  }
  if (regular.closed) {
    return { closed: true, reasons: regular.reasons, sessions: [], temporary: null };
  }
  /** @type {typeof CLINIC_SESSIONS[ClinicSessionId][]} */
  const sessions = [];
  for (const id of /** @type {ClinicSessionId[]} */ ([
    "morning",
    "afternoon",
    "evening",
  ])) {
    if (sessionRunsOnWeekday(id, weekday)) sessions.push(CLINIC_SESSIONS[id]);
  }
  return { closed: false, reasons: [], sessions, temporary: null };
}

/**
 * 曜日だけの通常枠（日付・祝日・第n土曜は考慮しない）
 * @param {WeekdayIndex} weekday
 */
export function getSessionsForWeekday(weekday) {
  if (weekday === 0) {
    return { closed: true, reasons: ["sunday"], sessions: [] };
  }
  /** @type {typeof CLINIC_SESSIONS[ClinicSessionId][]} */
  const sessions = [];
  for (const id of /** @type {ClinicSessionId[]} */ ([
    "morning",
    "afternoon",
    "evening",
  ])) {
    if (sessionRunsOnWeekday(id, weekday)) sessions.push(CLINIC_SESSIONS[id]);
  }
  return { closed: sessions.length === 0, reasons: [], sessions };
}

function formatSessionRange(session) {
  return `${session.label} ${session.start}〜${session.end}`;
}

function formatWeekdayList(weekdays) {
  return weekdays.map((w) => `${WEEKDAY_LABELS[w]}曜日`).join("・");
}

function formatSessionsPlain(sessions) {
  if (!sessions.length) return "休診";
  return sessions.map(formatSessionRange).join("、");
}

/**
 * 全診療時間表（リッチHTML）
 */
export function buildFullHoursRichHtml() {
  const days = [1, 2, 3, 4, 5, 6, 0];
  const sessionOrder = /** @type {ClinicSessionId[]} */ ([
    "morning",
    "afternoon",
    "evening",
  ]);
  const head = days
    .map((d) => `<th>${WEEKDAY_LABELS[d]}</th>`)
    .join("");
  const rows = sessionOrder
    .map((sid) => {
      const s = CLINIC_SESSIONS[sid];
      const cells = days
        .map((d) => {
          if (d === 0) return `<td>休診</td>`;
          return `<td>${sessionRunsOnWeekday(sid, /** @type {WeekdayIndex} */ (d)) ? "●" : ""}</td>`;
        })
        .join("");
      return `<tr><th>${s.label} ${s.start}〜${s.end}</th>${cells}</tr>`;
    })
    .join("");

  return [
    "[[[RICH_HTML]]]",
    '<div class="chat-card">',
    '<div class="chat-card-head"><span class="chat-card-icon"></span><h3 class="chat-card-title">診療時間</h3></div>',
    `<table class="chat-table"><thead><tr><th>診療時間</th>${head}</tr></thead><tbody>${rows}</tbody></table>`,
    '<p class="chat-note">休診日：日曜日・祝日・第3土曜日・第5土曜日</p>',
    '<p class="chat-note">※第1・第2・第4土曜日は、祝日や臨時休診に該当しない限り午前診のみです。</p>',
    '<p class="chat-note">※夜診は予約制ではなく、受付順での診察となります。</p>',
    "</div>",
  ].join("");
}

/**
 * @param {string} msg
 * @returns {WeekdayIndex|null}
 */
export function detectWeekdayInMessage(msg) {
  const text = String(msg || "");
  for (const [re, idx] of WEEKDAY_DETECT_PATTERNS) {
    if (re.test(text)) return /** @type {WeekdayIndex} */ (idx);
  }
  return null;
}

/**
 * @param {string} msg
 * @returns {ClinicSessionId|null}
 */
export function detectSessionInMessage(msg) {
  const text = String(msg || "");
  if (SESSION_ALIASES.evening.test(text)) return "evening";
  if (SESSION_ALIASES.afternoon.test(text)) return "afternoon";
  if (SESSION_ALIASES.morning.test(text)) return "morning";
  return null;
}

/**
 * @param {string} msg
 * @returns {number|null} 第n
 */
export function detectSaturdayOrdinalInMessage(msg) {
  const text = String(msg || "");
  const m = text.match(/第\s*([1-5１-５一二三四五])\s*土曜/);
  if (!m) return null;
  const map = {
    "1": 1,
    "2": 2,
    "3": 3,
    "4": 4,
    "5": 5,
    "１": 1,
    "２": 2,
    "３": 3,
    "４": 4,
    "５": 5,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
  };
  return map[m[1]] || null;
}

/**
 * 診療時間・休診に関する質問か（夜診の予約可否は除外）
 * @param {string} userMessage
 */
/**
 * 土日・週末をまとめて聞いているか
 * @param {string} msg
 */
export function isWeekendHoursQuery(msg) {
  const text = String(msg || "");
  return /土日|週末|土・日|土と日/.test(text);
}

/**
 * 緊急性のある症状を伴うか（診療時間案内より医療安全を優先）
 * @param {string} msg
 */
export function hasUrgentObstetricSymptomsForHours(msg) {
  return /大量.{0,4}出血|出血が止ま|強い腹痛|破水|胎動が少|胎動が減|規則的な.{0,6}張り/.test(
    String(msg || "")
  );
}

export function isClinicHoursQuery(userMessage) {
  const msg = String(userMessage || "").trim();
  if (!msg) return false;
  // 緊急性のある症状は診療時間ハンドラに流さない
  if (hasUrgentObstetricSymptomsForHours(msg)) return false;
  // 不妊・妊活などサービス可否は診療時間ではない（「やっていますか」の誤反応防止）
  if (
    /不妊|妊活|タイミング療法|排卵誘発|体外受精|人工授精|顕微授精|ART|IVF/.test(
      msg
    )
  ) {
    return false;
  }
  // 予約可否は別ハンドラ
  if (
    /夜診|夜の診察|夕方の診察/.test(msg) &&
    /予約|受付順|予約なし|予約無し/.test(msg)
  ) {
    return false;
  }
  // 土日・週末（「土日診療」「週末に受診」など）
  if (
    isWeekendHoursQuery(msg) &&
    /診療|診察|受診|開い|やって|診て|何時|休診|午後|午前|夜診/.test(msg)
  ) {
    return true;
  }
  // 明示的な診療時間・枠・休診
  if (
    /診療時間|診察時間|受付時間|休診|午前診|午後診|何時から|何時まで/.test(msg)
  ) {
    return true;
  }
  // 夜診の時間・曜日（予約以外）
  if (
    /夜診/.test(msg) &&
    /何時|時間|曜日|ありますか|開い|やって/.test(msg) &&
    !/予約/.test(msg)
  ) {
    return true;
  }
  if (/開いてい|開いてます|開いてる/.test(msg)) return true;
  // 「診察していますか」は日付・曜日・土日文脈があるときだけ
  if (
    /(診察|診療)して(い|る|ます)|受診できますか/.test(msg) &&
    (detectWeekdayInMessage(msg) != null ||
      isWeekendHoursQuery(msg) ||
      /今日|本日|明日|明後日|祝日|土曜|日曜|平日/.test(msg))
  ) {
    return true;
  }
  if (
    detectWeekdayInMessage(msg) != null &&
    /診察|診療|開い|やって|診て|午前|午後|夜診|何時|休診|受診/.test(msg)
  ) {
    return true;
  }
  if (/祝日/.test(msg) && /診察|診療|休診|開い|やって|診て|受診/.test(msg)) {
    return true;
  }
  if (/平日/.test(msg) && /何時|診療|診察|開い/.test(msg)) return true;
  if (/第\s*[1-5１-５一二三四五]\s*土曜/.test(msg)) return true;
  return false;
}

/**
 * @param {string} userMessage
 * @param {{ nowParts?: { year: number, month: number, day: number, weekdayJa?: string } }} [opts]
 * @returns {{ answer: string, intent: string, scheduleData: object, referencedPages: {url:string,title:string}[] }|null}
 */
export function buildClinicHoursAnswer(userMessage, opts = {}) {
  const msg = String(userMessage || "").trim();
  if (!isClinicHoursQuery(msg)) return null;

  const ref = [CLINIC_HOURS_REF_PAGE];
  const weekday = detectWeekdayInMessage(msg);
  const session = detectSessionInMessage(msg);
  const satOrdinal = detectSaturdayOrdinalInMessage(msg);
  const wantsFull =
    /全部|すべて|全て|一式|一覧|表|教えて/.test(msg) &&
    /診療時間|診察時間|スケジュール|時間割/.test(msg);
  const wantsFullAlt = /診療時間を?(全部|すべて|全て)?(教え|知り|見せ)/.test(msg);

  // 全表
  if (wantsFull || wantsFullAlt || /^診療時間[をは]?$/.test(msg)) {
    return {
      answer: buildFullHoursRichHtml(),
      intent: "clinic_hours_full",
      scheduleData: {
        sessions: CLINIC_SESSIONS,
        closedRules: CLINIC_CLOSED_RULES,
      },
      referencedPages: ref,
    };
  }

  // 土日・週末（土曜と日曜の両方を案内。全表にフォールバックしない）
  if (isWeekendHoursQuery(msg) && satOrdinal == null) {
    const m = CLINIC_SESSIONS.morning;
    return {
      answer: [
        "はい、当院では土曜日の午前診療を行っております。",
        "",
        "ただし、第3・第5土曜日と日曜日は休診です。",
        `土曜日の診療時間は${m.start}〜${m.end}です。`,
      ].join("\n"),
      intent: "clinic_hours_weekend",
      scheduleData: {
        weekend: true,
        saturdaySessions: [CLINIC_SESSIONS.morning],
        sundayClosed: true,
        closedRules: CLINIC_CLOSED_RULES,
      },
      referencedPages: ref,
    };
  }

  // 祝日（「祝日」内の「日」を日曜判定に使わない）
  if (/祝日/.test(msg) && !/日曜/.test(msg) && satOrdinal == null && weekday == null) {
    return {
      answer:
        "祝日は休診です。通常の休診日は、日曜日・祝日・第3土曜日・第5土曜日です。",
      intent: "clinic_hours_holiday",
      scheduleData: { closedRules: CLINIC_CLOSED_RULES },
      referencedPages: ref,
    };
  }

  // 休診日一覧
  if (/休診日/.test(msg) && weekday == null && satOrdinal == null) {
    return {
      answer:
        "休診日は、日曜日・祝日・第3土曜日・第5土曜日です。第1・第2・第4土曜日は午前診のみです。",
      intent: "clinic_hours_closed_days",
      scheduleData: { closedRules: CLINIC_CLOSED_RULES },
      referencedPages: ref,
    };
  }

  // 第n土曜日
  if (satOrdinal != null) {
    const closed =
      CLINIC_CLOSED_RULES.saturdayClosedOrdinals.includes(satOrdinal);
    if (closed) {
      return {
        answer: `はい、第${satOrdinal}土曜日は休診です。第1・第2・第4土曜日は、祝日に該当しない限り午前診（${CLINIC_SESSIONS.morning.start}〜${CLINIC_SESSIONS.morning.end}）のみです。`,
        intent: "clinic_hours_saturday_nth",
        scheduleData: {
          saturdayOrdinal: satOrdinal,
          closed: true,
          closedRules: CLINIC_CLOSED_RULES,
        },
        referencedPages: ref,
      };
    }
    return {
      answer: `第${satOrdinal}土曜日は、祝日に該当しない限り午前診（${CLINIC_SESSIONS.morning.start}〜${CLINIC_SESSIONS.morning.end}）のみです。第3・第5土曜日は休診です。`,
      intent: "clinic_hours_saturday_nth",
      scheduleData: {
        saturdayOrdinal: satOrdinal,
        closed: false,
        sessions: [CLINIC_SESSIONS.morning],
      },
      referencedPages: ref,
    };
  }

  // 土曜日全般
  if (weekday === 6 && /土曜/.test(msg)) {
    const m = CLINIC_SESSIONS.morning;
    // 土曜の午後
    if (/午後/.test(msg)) {
      return {
        answer: `土曜日に午後診はありません。土曜日は${m.start}〜${m.end}の午前診のみです。ただし、第3・第5土曜日と祝日は休診です。`,
        intent: "clinic_hours_saturday_afternoon",
        scheduleData: {
          weekday: 6,
          afternoon: false,
          sessions: [CLINIC_SESSIONS.morning],
        },
        referencedPages: ref,
      };
    }
    return {
      answer: `はい、土曜日は${m.start}〜${m.end}に診療しています。ただし、第3・第5土曜日と祝日は休診です。`,
      intent: "clinic_hours_saturday",
      scheduleData: {
        weekday: 6,
        sessions: [CLINIC_SESSIONS.morning],
        closedRules: CLINIC_CLOSED_RULES,
      },
      referencedPages: ref,
    };
  }

  // 日曜日
  if (weekday === 0) {
    const m = CLINIC_SESSIONS.morning;
    return {
      answer: [
        "日曜日は休診日となっております。",
        `土曜日は午前診療（${m.start}〜${m.end}）を行っていますが、第3・第5土曜日は休診です。`,
      ].join("\n"),
      intent: "clinic_hours_sunday",
      scheduleData: { weekday: 0, closed: true },
      referencedPages: ref,
    };
  }

  // 特定曜日 × 特定枠の有無（夜診の曜日一覧より先に判定）
  if (weekday != null && session != null) {
    const runs = sessionRunsOnWeekday(session, weekday);
    const s = CLINIC_SESSIONS[session];
    const dayLabel = `${WEEKDAY_LABELS[weekday]}曜日`;
    if (runs) {
      return {
        answer: `はい。${dayLabel}は${formatSessionRange(s)}があります。`,
        intent: "clinic_hours_weekday_session",
        scheduleData: { weekday, session: s, available: true },
        referencedPages: ref,
      };
    }
    const usual = getSessionsForWeekday(weekday);
    const usualText = formatSessionsPlain(usual.sessions);
    if (session === "evening") {
      return {
        answer: `${dayLabel}に夜診はありません。${dayLabel}は${usualText}です。`,
        intent: "clinic_hours_weekday_session",
        scheduleData: {
          weekday,
          session: s,
          available: false,
          usualSessions: usual.sessions,
        },
        referencedPages: ref,
      };
    }
    if (session === "afternoon") {
      return {
        answer: `${dayLabel}に午後診はありません。${dayLabel}は${usualText}です。`,
        intent: "clinic_hours_weekday_session",
        scheduleData: {
          weekday,
          session: s,
          available: false,
          usualSessions: usual.sessions,
        },
        referencedPages: ref,
      };
    }
    return {
      answer: `${dayLabel}に${s.label}はありません。${dayLabel}は${usualText}です。`,
      intent: "clinic_hours_weekday_session",
      scheduleData: {
        weekday,
        session: s,
        available: false,
        usualSessions: usual.sessions,
      },
      referencedPages: ref,
    };
  }

  // 夜診の曜日（特定曜日の指定がない場合）
  if (
    session === "evening" &&
    weekday == null &&
    (/何曜日|どの曜日|曜日|いつ/.test(msg) ||
      /ありますか|やって|開い|実施|何時/.test(msg))
  ) {
    const days = CLINIC_SESSIONS.evening.weekdays;
    return {
      answer: `夜診は月曜日と水曜日の${CLINIC_SESSIONS.evening.start}〜${CLINIC_SESSIONS.evening.end}に行っています。`,
      intent: "clinic_hours_evening_weekdays",
      scheduleData: { session: CLINIC_SESSIONS.evening },
      referencedPages: ref,
    };
  }

  // 特定曜日の終了時刻・診療内容
  if (weekday != null) {
    const usual = getSessionsForWeekday(weekday);
    const dayLabel = `${WEEKDAY_LABELS[weekday]}曜日`;
    if (usual.closed) {
      return {
        answer: `${dayLabel}は休診です。`,
        intent: "clinic_hours_weekday",
        scheduleData: { weekday, closed: true },
        referencedPages: ref,
      };
    }
    const until = usual.sessions[usual.sessions.length - 1];
    if (/何時まで|いつまで|終了|終わり/.test(msg)) {
      return {
        answer: `${dayLabel}は${formatSessionsPlain(usual.sessions)}です。${until.label}は${until.end}までです。`,
        intent: "clinic_hours_weekday_until",
        scheduleData: { weekday, sessions: usual.sessions },
        referencedPages: ref,
      };
    }
    return {
      answer: `${dayLabel}は${formatSessionsPlain(usual.sessions)}です。`,
      intent: "clinic_hours_weekday",
      scheduleData: { weekday, sessions: usual.sessions },
      referencedPages: ref,
    };
  }

  // 今日／明日など日付つき
  if (/今日|本日|明日|明後日/.test(msg) && opts.nowParts) {
    const base = opts.nowParts;
    let delta = 0;
    if (/明日/.test(msg)) delta = 1;
    if (/明後日/.test(msg)) delta = 2;
    const utc = Date.UTC(base.year, base.month - 1, base.day + delta, 12);
    const dt = new Date(utc);
    const year = dt.getUTCFullYear();
    const month = dt.getUTCMonth() + 1;
    const day = dt.getUTCDate();
    const wd = /** @type {WeekdayIndex} */ (dt.getUTCDay());
    const info = getSessionsForDate({ year, month, day, weekday: wd });
    const label =
      delta === 0 ? "本日" : delta === 1 ? "明日" : "明後日";
    const dateJa = `${year}年${month}月${day}日（${WEEKDAY_LABELS[wd]}）`;
    const hasTempData = CLINIC_TEMPORARY_CLOSURES.length > 0;

    if (info.temporary) {
      return {
        answer: `${label}（${dateJa}）は臨時休診です。`,
        intent: "clinic_hours_dated",
        scheduleData: { date: `${year}-${month}-${day}`, ...info },
        referencedPages: ref,
      };
    }
    if (info.closed) {
      const reasonText = info.reasons.includes("holiday")
        ? "祝日のため休診"
        : info.reasons.some((r) => r.startsWith("saturday_nth_"))
          ? "第3または第5土曜日のため休診"
          : "休診";
      return {
        answer: `${label}（${dateJa}）は、通常の診療予定では${reasonText}です。${
          hasTempData
            ? ""
            : "臨時休診の有無は、公式サイトまたはお電話でご確認ください。"
        }`.trim(),
        intent: "clinic_hours_dated",
        scheduleData: { date: `${year}-${month}-${day}`, ...info },
        referencedPages: ref,
      };
    }
    return {
      answer: `${label}（${dateJa}）は、通常の診療予定では${formatSessionsPlain(
        info.sessions
      )}です。${
        hasTempData
          ? ""
          : "臨時休診の有無は、公式サイトまたはお電話でご確認ください。"
      }`.trim(),
      intent: "clinic_hours_dated",
      scheduleData: { date: `${year}-${month}-${day}`, ...info },
      referencedPages: ref,
    };
  }

  // 夜診の時間のみ（曜日指定なし）
  if (session === "evening") {
    const e = CLINIC_SESSIONS.evening;
    return {
      answer: `夜診は月曜日と水曜日の${e.start}〜${e.end}に行っています。`,
      intent: "clinic_hours_evening",
      scheduleData: { session: e },
      referencedPages: ref,
    };
  }

  // 平日の終了時刻
  if (/平日/.test(msg) && /何時|終了|終わり|まで/.test(msg)) {
    const e = CLINIC_SESSIONS.evening;
    return {
      answer: [
        `平日の診療は、午前診 ${CLINIC_SESSIONS.morning.start}〜${CLINIC_SESSIONS.morning.end}、午後診 ${CLINIC_SESSIONS.afternoon.start}〜${CLINIC_SESSIONS.afternoon.end}（火を除く）、夜診 ${e.start}〜${e.end}（月・水）です。`,
        "火曜は午前診のみ、木・金に夜診はありません。",
      ].join("\n"),
      intent: "clinic_hours_weekday_general",
      scheduleData: { sessions: CLINIC_SESSIONS },
      referencedPages: ref,
    };
  }

  // フォールバック：全表
  return {
    answer: buildFullHoursRichHtml(),
    intent: "clinic_hours_full",
    scheduleData: {
      sessions: CLINIC_SESSIONS,
      closedRules: CLINIC_CLOSED_RULES,
    },
    referencedPages: ref,
  };
}
