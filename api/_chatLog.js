/**
 * チャットログ（Supabase）
 * テーブル: chat_logs
 * 日付: ymd_jst（参考）＋ created_at の JST 1日分レンジで取得
 */

const MAX_CLIENT_ID_LEN = 64;

export function getSupabaseConfig() {
  const url = String(process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const key = String(
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""
  ).trim();
  return { url, key, ok: Boolean(url && key) };
}

export const hasSupabaseConfig = () => getSupabaseConfig().ok;

/** @returns {string} YYYY-MM-DD in Asia/Tokyo */
export function getJstYmd(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

/** 前日（JST 暦日）の YYYY-MM-DD */
export function getYesterdayJstYmd(date = new Date()) {
  const today = getJstYmd(date);
  const [y, m, d] = today.split("-").map(Number);
  const noonJstAsUtc = Date.UTC(y, m - 1, d, 3, 0, 0);
  return getJstYmd(new Date(noonJstAsUtc - 24 * 60 * 60 * 1000));
}

/**
 * JST の暦日 0:00〜24:00 を UTC ISO の半開区間 [start, end) に変換
 * @param {string} ymd YYYY-MM-DD
 */
export function jstDayRangeUtc(ymd) {
  const start = new Date(`${ymd}T00:00:00+09:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

export function normalizeClientId(raw) {
  const s = String(raw || "")
    .trim()
    .slice(0, MAX_CLIENT_ID_LEN);
  if (!s) return "anonymous";
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return "anonymous";
  return s;
}

/** ログ／レポート用に HTML・制御マーカーを除いたプレーンテキストへ */
export function toPlainTextForLog(input) {
  let s = String(input ?? "");
  if (!s) return "";

  s = s.replace(/\[\[\[(?:\/)?RICH_HTML\]\]\]+/gi, "");
  s = s.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  s = s.replace(/<\s*\/\s*(p|div|tr|li|h[1-6]|section|table)\s*>/gi, "\n");
  s = s.replace(/<\s*(p|div|tr|li|h[1-6]|section|table|thead|tbody)\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    });
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

/**
 * @param {{ message: string, answer: string, clientId?: string, meta?: object }} entry
 */
export async function appendChatLog(entry) {
  const { url, key, ok } = getSupabaseConfig();
  if (!ok) return { ok: false, reason: "no_supabase" };

  const now = new Date();
  const ymd = getJstYmd(now);
  const row = {
    created_at: now.toISOString(),
    time_jst: now.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false }),
    ymd_jst: ymd,
    client_id: normalizeClientId(entry.clientId),
    message: String(entry.message || "").slice(0, 500),
    answer: toPlainTextForLog(entry.answer).slice(0, 8000),
    meta: entry.meta && typeof entry.meta === "object" ? entry.meta : null,
  };

  try {
    const res = await fetch(`${url}/rest/v1/chat_logs`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("appendChatLog supabase error:", res.status, text.slice(0, 300));
      return { ok: false, reason: "supabase_error", status: res.status };
    }
    return { ok: true, ymd };
  } catch (e) {
    console.error("appendChatLog error:", e?.message || e);
    return { ok: false, reason: "network_error" };
  }
}

/**
 * @param {string} ymd YYYY-MM-DD (JST)
 * @returns {Promise<Array<{ time: string, timeJst: string, clientId: string, message: string, answer: string }>>}
 */
export async function getChatLogsForYmd(ymd) {
  const { url, key, ok } = getSupabaseConfig();
  if (!ok) return [];

  const { startIso, endIso } = jstDayRangeUtc(ymd);

  try {
    // created_at の JST 1日分で取得（ymd_jst が空でも拾える）
    const qs = new URLSearchParams();
    qs.set("select", "created_at,time_jst,ymd_jst,client_id,message,answer,meta");
    qs.set("created_at", `gte.${startIso}`);
    qs.append("created_at", `lt.${endIso}`);
    qs.set("order", "created_at.asc");
    qs.set("limit", "2000");

    const res = await fetch(`${url}/rest/v1/chat_logs?${qs.toString()}`, {
      method: "GET",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("getChatLogsForYmd supabase error:", res.status, text.slice(0, 500));
      return [];
    }
    const data = await res.json();
    if (!Array.isArray(data)) return [];

    // フォールバック: created_at で0件なら ymd_jst 一致でも試す
    if (data.length === 0) {
      const qs2 = new URLSearchParams({
        select: "created_at,time_jst,ymd_jst,client_id,message,answer,meta",
        ymd_jst: `eq.${ymd}`,
        order: "created_at.asc",
        limit: "2000",
      });
      const res2 = await fetch(`${url}/rest/v1/chat_logs?${qs2.toString()}`, {
        method: "GET",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
      });
      if (res2.ok) {
        const data2 = await res2.json();
        if (Array.isArray(data2) && data2.length > 0) {
          return data2.map(mapLogRow);
        }
      }
    }

    return data.map(mapLogRow);
  } catch (e) {
    console.error("getChatLogsForYmd error:", e?.message || e);
    return [];
  }
}

function mapLogRow(r) {
  return {
    time: r.created_at || "",
    timeJst: r.time_jst || "",
    clientId: r.client_id || "",
    message: r.message || "",
    answer: toPlainTextForLog(r.answer || ""),
    meta: r.meta || null,
  };
}
