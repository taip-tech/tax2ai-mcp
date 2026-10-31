-- 사무소 프로필 (자료요청문·채용공고 자동 입력용).
-- MCP 서버는 서비스 키 없이 로그인 사용자의 액세스 토큰으로 접근하므로, RLS가 본인 행만 허용한다.
-- 고객 정보는 저장하지 않는다.

create table if not exists public.mcp_office_profiles (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  profile jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint mcp_office_profiles_size check (pg_column_size(profile) < 8192)
);

alter table public.mcp_office_profiles enable row level security;

drop policy if exists "own office profile read" on public.mcp_office_profiles;
create policy "own office profile read" on public.mcp_office_profiles
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "own office profile insert" on public.mcp_office_profiles;
create policy "own office profile insert" on public.mcp_office_profiles
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "own office profile update" on public.mcp_office_profiles;
create policy "own office profile update" on public.mcp_office_profiles
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "own office profile delete" on public.mcp_office_profiles;
create policy "own office profile delete" on public.mcp_office_profiles
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.mcp_office_profiles from anon;
grant select, insert, update, delete on public.mcp_office_profiles to authenticated;
