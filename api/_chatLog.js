/**
 * チャットログ（Supabase）
 * テーブル: chat_logs
 * 日付キー: ymd_jst（Asia/Tokyo の YYYY-MM-DD）
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
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** 前日（JST 暦日）の YYYY-MM-DD */
export function getYesterdayJstYmd(date = new Date()) {
  const today = getJstYmd(date);
  const [y, m, d] = today.split("-").map(Number);
  const noonJstAsUtc = Date.UTC(y, m - 1, d, 3, 0, 0);
  return getJstYmd(new Date(noonJstAsUtc - 24 * 60 * 60 * 1000));
}

export function normalizeClientId(raw) {
  const s = String(raw || "")
    .trim()
    .slice(0, MAX_CLIENT_ID_LEN);
  if (!s) return "anonymous";
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return "anonymous";
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
    answer: String(entry.answer || "").slice(0, 8000),
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

  try {
    const qs = new URLSearchParams({
      select: "created_at,time_jst,client_id,message,answer,meta",
      ymd_jst: `eq.${ymd}`,
      order: "created_at.asc",
      limit: "2000",
    });
    const res = await fetch(`${url}/rest/v1/chat_logs?${qs.toString()}`, {
      method: "GET",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("getChatLogsForYmd supabase error:", res.status, text.slice(0, 300));
      return [];
    }
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.map((r) => ({
      time: r.created_at || "",
      timeJst: r.time_jst || "",
      clientId: r.client_id || "",
      message: r.message || "",
      answer: r.answer || "",
      meta: r.meta || null,
    }));
  } catch (e) {
    console.error("getChatLogsForYmd error:", e?.message || e);
    return [];
  }
}
