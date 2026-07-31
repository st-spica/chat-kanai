-- Supabase SQL Editor で実行してください
-- チャットログテーブル（日次レポート用）

create table if not exists public.chat_logs (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  time_jst text,
  ymd_jst text not null,
  client_id text not null default 'anonymous',
  message text not null,
  answer text not null,
  meta jsonb
);

create index if not exists chat_logs_ymd_jst_idx on public.chat_logs (ymd_jst);
create index if not exists chat_logs_created_at_idx on public.chat_logs (created_at desc);

-- API は service_role で書き込む想定。anon からの直接アクセスは拒否
alter table public.chat_logs enable row level security;

-- 既存ポリシーがあれば消してから作り直す場合:
-- drop policy if exists "deny all for anon" on public.chat_logs;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'chat_logs'
      and policyname = 'service_role_all'
  ) then
    -- service_role は RLS をバイパスするため、明示ポリシーは任意。
    -- anon/authenticated には何も許可しない（ポリシーなし = 拒否）
    null;
  end if;
end $$;

comment on table public.chat_logs is 'AI相談チャットの日次レポート用ログ';
