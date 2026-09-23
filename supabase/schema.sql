-- Revision Tracker database. Run this once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Safe to run again later (it only creates what's missing and replaces the functions).
--
-- How access works:
--   * Each tracker is one JSON document, stored under the SHA-256 hash of its code, never the
--     code itself.
--   * Row level security is ON with no policies, so the tables cannot be read or written
--     directly with the public (anon/publishable) key.
--   * The website can only call the functions below, and every one of them needs the code.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.trackers (
  code_hash  text primary key,
  data       jsonb not null,
  version    integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tracker_backups (
  id         bigserial primary key,
  code_hash  text not null references public.trackers(code_hash) on delete cascade,
  kind       text not null check (kind in ('daily', 'pre-restore')),
  day        date not null,
  data       jsonb not null,
  saved_at   timestamptz not null default now()
);
create unique index if not exists tracker_backups_one_daily
  on public.tracker_backups (code_hash, day) where kind = 'daily';

alter table public.trackers enable row level security;
alter table public.tracker_backups enable row level security;
revoke all on public.trackers, public.tracker_backups from anon, authenticated;
revoke all on sequence public.tracker_backups_id_seq from anon, authenticated;

-- Codes look like ABCD-EFGH-JKLM. Case, spaces and dashes are ignored when typing one in.
create or replace function public.rt_hash(p_code text) returns text
language sql immutable
set search_path = public, extensions
as $$
  select encode(extensions.digest(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), 'sha256'), 'hex')
$$;

create or replace function public.rt_check(p_data jsonb) returns void
language plpgsql immutable
as $$
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' or p_data->>'format' is distinct from 'revision-tracker' then
    raise exception 'invalid_data';
  end if;
  if octet_length(p_data::text) > 5000000 then
    raise exception 'too_large';
  end if;
end
$$;

-- New tracker: generates a random 12-character code (about 59 bits) and returns it.
-- The site is capped at 500 trackers so a stranger can't fill up the free database.
create or replace function public.create_tracker(p_data jsonb) returns text
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';  -- no I, L, O, 0 or 1
  v_bytes bytea;
  v_code text;
begin
  perform public.rt_check(p_data);
  if (select count(*) from public.trackers) >= 500 then
    raise exception 'This site is full: no more trackers can be created.';
  end if;
  loop
    v_bytes := extensions.gen_random_bytes(12);
    v_code := '';
    for i in 0..11 loop
      v_code := v_code || substr(v_alphabet, 1 + (get_byte(v_bytes, i) % length(v_alphabet)), 1);
    end loop;
    begin
      insert into public.trackers (code_hash, data) values (public.rt_hash(v_code), p_data);
      exit;
    exception when unique_violation then
      -- astronomically unlikely; just pick another code
    end;
  end loop;
  return substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4) || '-' || substr(v_code, 9, 4);
end
$$;

-- Returns {"data": ..., "version": n}, or null if there's no tracker with that code.
create or replace function public.load_tracker(p_code text) returns jsonb
language sql stable security definer
set search_path = public, extensions
as $$
  select jsonb_build_object('data', data, 'version', version)
  from public.trackers where code_hash = public.rt_hash(p_code)
$$;

-- Saves a new version and returns {"version": n}. p_version must be the version you loaded;
-- if another device has saved in the meantime nothing is saved and this returns
-- {"conflict": true, "version": <current>} (the website then merges and retries). That's a
-- normal answer rather than an error, since it happens whenever two devices are in use.
-- The first save of each day keeps a copy of the previous state as that day's backup (14 days kept).
drop function if exists public.save_tracker(text, jsonb, integer);
create or replace function public.save_tracker(p_code text, p_data jsonb, p_version integer) returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_hash text := public.rt_hash(p_code);
  v_row public.trackers%rowtype;
begin
  perform public.rt_check(p_data);
  select * into v_row from public.trackers where code_hash = v_hash for update;
  if not found then
    raise exception 'tracker_not_found';
  end if;
  if v_row.version <> p_version then
    return jsonb_build_object('conflict', true, 'version', v_row.version);
  end if;
  insert into public.tracker_backups (code_hash, kind, day, data)
    values (v_hash, 'daily', current_date, v_row.data)
    on conflict (code_hash, day) where kind = 'daily' do nothing;
  delete from public.tracker_backups where code_hash = v_hash and day < current_date - 14;
  update public.trackers set data = p_data, version = version + 1, updated_at = now()
    where code_hash = v_hash;
  return jsonb_build_object('version', v_row.version + 1);
end
$$;

create or replace function public.list_backups(p_code text) returns jsonb
language sql stable security definer
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'day', day, 'saved_at', saved_at,
                                               'size', octet_length(data::text))
                            order by saved_at desc), '[]'::jsonb)
  from public.tracker_backups where code_hash = public.rt_hash(p_code)
$$;

-- Restores a backup (the current state is kept as a 'pre-restore' backup first).
create or replace function public.restore_backup(p_code text, p_backup_id bigint) returns integer
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_hash text := public.rt_hash(p_code);
  v_row public.trackers%rowtype;
  v_backup jsonb;
begin
  select * into v_row from public.trackers where code_hash = v_hash for update;
  if not found then
    raise exception 'tracker_not_found';
  end if;
  select data into v_backup from public.tracker_backups where id = p_backup_id and code_hash = v_hash;
  if v_backup is null then
    raise exception 'backup_not_found';
  end if;
  insert into public.tracker_backups (code_hash, kind, day, data) values (v_hash, 'pre-restore', current_date, v_row.data);
  update public.trackers set data = v_backup, version = version + 1, updated_at = now() where code_hash = v_hash;
  return v_row.version + 1;
end
$$;

revoke all on function public.rt_check(jsonb) from public, anon, authenticated;
grant execute on function public.create_tracker(jsonb) to anon, authenticated;
grant execute on function public.load_tracker(text) to anon, authenticated;
grant execute on function public.save_tracker(text, jsonb, integer) to anon, authenticated;
grant execute on function public.list_backups(text) to anon, authenticated;
grant execute on function public.restore_backup(text, bigint) to anon, authenticated;
