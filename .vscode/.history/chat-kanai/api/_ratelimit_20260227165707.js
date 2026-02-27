// api/_ratelimit.js
// Upstash Redis が設定されていない環境でも落ちないように、フォールバック付きでレート制限を提供する

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

let redis = null;
let ratelimit = null;

if (url && token) {
  // Upstash が設定されている場合のみ、本物のレートリミッタを使う
  redis = new Redis({ url, token });
  ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.fixedWindow(20, "60 s"),
    prefix: "chat-kanai",
  });
} else {
  // 環境変数がない場合は、常に success にするダミー実装
  ratelimit = {
    limit: async () => ({ success: true }),
  };
}

export { redis, ratelimit };