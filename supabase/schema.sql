-- Revision Tracker database. Run this once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Safe to run again later (it only creates what's missing and replaces the functions).
--
-- How access works:
--   * Each tracker is one JSON document, stored under the SHA-256 hash of its code, never the
--     code itself.
--   * Row level security is ON with no policies, so the tables cannot be read or written
--     directly with the public (anon/publishable) key.
--   * The website can only call the functions below, and every one of them needs the code.
--   * Photos/PDFs of questions are stored the same way (see "Question files" below).

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
  kind       text not null,
  day        date not null,
  data       jsonb not null,
  saved_at   timestamptz not null default now()
);
alter table public.tracker_backups drop constraint if exists tracker_backups_kind_check;
alter table public.tracker_backups add constraint tracker_backups_kind_check
  check (kind in ('daily', 'pre-restore', 'pre-import'));
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

-- Keeps a copy of the tracker as it is right now (the website calls this before an import).
create or replace function public.backup_tracker(p_code text) returns void
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_hash text := public.rt_hash(p_code);
begin
  insert into public.tracker_backups (code_hash, kind, day, data)
    select v_hash, 'pre-import', current_date, data from public.trackers where code_hash = v_hash;
  if not found then
    raise exception 'tracker_not_found';
  end if;
end
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

-- ---------------------------------------------------------------------------------------------
-- Question files (photos and PDFs of questions and model solutions)
--
-- Files are stored in the database, split into chunks of up to 1 MB, and are only reachable
-- through the functions below, which all need the tracker's code, just like the tracker itself.
-- Limits: 10 MB per file, 100 MB per tracker, 350 MB for the whole site (so files can never
-- fill the free database and stop trackers saving). Deleted files are kept for 14 days so a
-- restored backup still has its files.

create table if not exists public.tracker_files (
  code_hash  text not null references public.trackers(code_hash) on delete cascade,
  file_id    uuid not null,
  name       text not null,
  mime       text not null,
  size       integer not null check (size > 0),
  chunks     integer not null check (chunks between 1 and 12),
  complete   boolean not null default false,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (code_hash, file_id)
);

create table if not exists public.tracker_file_chunks (
  code_hash text not null,
  file_id   uuid not null,
  seq       integer not null,
  data      bytea not null,
  primary key (code_hash, file_id, seq),
  foreign key (code_hash, file_id) references public.tracker_files (code_hash, file_id) on delete cascade
);

alter table public.tracker_files enable row level security;
alter table public.tracker_file_chunks enable row level security;
revoke all on public.tracker_files, public.tracker_file_chunks from anon, authenticated;

-- Remove files deleted more than 14 days ago, and uploads that never finished.
create or replace function public.rt_purge_files() returns void
language sql security definer
set search_path = public, extensions
as $$
  delete from public.tracker_files
  where (deleted_at is not null and deleted_at < now() - interval '14 days')
     or (not complete and created_at < now() - interval '1 day')
$$;

create or replace function public.rt_tracker_hash(p_code text) returns text
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare
  v_hash text := public.rt_hash(p_code);
begin
  if not exists (select 1 from public.trackers where code_hash = v_hash) then
    raise exception 'tracker_not_found';
  end if;
  return v_hash;
end
$$;

create or replace function public.rt_ids(p_ids jsonb) returns uuid[]
language sql immutable
as $$
  select coalesce(array_agg(value::uuid), '{}') from jsonb_array_elements_text(coalesce(p_ids, '[]'::jsonb))
$$;

-- Upload one chunk (base64). Send chunks 0..p_chunks-1; the file becomes readable once all have
-- arrived. Re-sending a chunk (e.g. after a dropped connection) is fine.
create or replace function public.put_file_chunk(p_code text, p_file_id text, p_seq integer, p_chunks integer,
                                                 p_name text, p_mime text, p_size integer, p_data text) returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_hash text := public.rt_tracker_hash(p_code);
  v_id uuid := p_file_id::uuid;
  v_bytes bytea;
  v_file public.tracker_files%rowtype;
  v_have integer;
  v_total bigint;
begin
  if p_mime not in ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'application/pdf') then
    raise exception 'That type of file isn''t supported: use a photo (JPEG/PNG) or a PDF.';
  end if;
  if p_size is null or p_size <= 0 or p_size > 10485760 then
    raise exception 'Files can be at most 10 MB.';
  end if;
  if p_chunks is null or p_chunks < 1 or p_chunks > 12 or p_seq is null or p_seq < 0 or p_seq >= p_chunks then
    raise exception 'invalid_chunk';
  end if;
  v_bytes := decode(p_data, 'base64');
  if length(v_bytes) = 0 or length(v_bytes) > 1048576 then
    raise exception 'invalid_chunk';
  end if;
  select * into v_file from public.tracker_files where code_hash = v_hash and file_id = v_id for update;
  if not found then
    perform public.rt_purge_files();
    if (select coalesce(sum(size), 0) from public.tracker_files where code_hash = v_hash and deleted_at is null) + p_size > 104857600 then
      raise exception 'Your file storage is full (100 MB). Delete some questions to make room.';
    end if;
    if (select coalesce(sum(size), 0) from public.tracker_files) + p_size > 367001600 then
      raise exception 'The site''s file storage is full, so no more files can be uploaded.';
    end if;
    insert into public.tracker_files (code_hash, file_id, name, mime, size, chunks)
      values (v_hash, v_id, left(coalesce(nullif(p_name, ''), 'file'), 200), p_mime, p_size, p_chunks);
  elsif v_file.complete or v_file.deleted_at is not null then
    raise exception 'file_exists';
  elsif v_file.size <> p_size or v_file.chunks <> p_chunks or v_file.mime <> p_mime then
    raise exception 'invalid_chunk';
  end if;
  insert into public.tracker_file_chunks (code_hash, file_id, seq, data) values (v_hash, v_id, p_seq, v_bytes)
    on conflict (code_hash, file_id, seq) do update set data = excluded.data;
  select count(*), coalesce(sum(length(data)), 0) into v_have, v_total
    from public.tracker_file_chunks where code_hash = v_hash and file_id = v_id;
  if v_have = p_chunks then
    if v_total <> p_size then
      raise exception 'size_mismatch';
    end if;
    update public.tracker_files set complete = true where code_hash = v_hash and file_id = v_id;
  end if;
  return jsonb_build_object('complete', v_have = p_chunks, 'received', v_have);
end
$$;

-- One chunk of a finished file, as base64, with the file's details; null if there's no such file.
create or replace function public.get_file_chunk(p_code text, p_file_id text, p_seq integer) returns jsonb
language sql stable security definer
set search_path = public, extensions
as $$
  select jsonb_build_object('name', f.name, 'mime', f.mime, 'size', f.size, 'chunks', f.chunks,
                            'data', translate(encode(c.data, 'base64'), E'\n', ''))
  from public.tracker_files f
  join public.tracker_file_chunks c on c.code_hash = f.code_hash and c.file_id = f.file_id and c.seq = p_seq
  where f.code_hash = public.rt_hash(p_code) and f.file_id = p_file_id::uuid and f.complete
$$;

-- Several small single-chunk files at once (thumbnails): {"<id>": {"mime": ..., "data": base64}}.
create or replace function public.get_small_files(p_code text, p_file_ids jsonb) returns jsonb
language sql stable security definer
set search_path = public, extensions
as $$
  select coalesce(jsonb_object_agg(f.file_id::text,
           jsonb_build_object('mime', f.mime, 'data', translate(encode(c.data, 'base64'), E'\n', ''))), '{}'::jsonb)
  from public.tracker_files f
  join public.tracker_file_chunks c on c.code_hash = f.code_hash and c.file_id = f.file_id and c.seq = 0
  where f.code_hash = public.rt_hash(p_code) and f.complete and f.chunks = 1 and f.size <= 262144
    and f.file_id = any ((public.rt_ids(p_file_ids))[1:100])
$$;

-- Delete files (kept for 14 days in case a backup is restored). Returns how many were deleted.
create or replace function public.delete_files(p_code text, p_file_ids jsonb) returns integer
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_n integer;
begin
  update public.tracker_files set deleted_at = now()
    where code_hash = public.rt_tracker_hash(p_code) and file_id = any (public.rt_ids(p_file_ids)) and deleted_at is null;
  get diagnostics v_n = row_count;
  perform public.rt_purge_files();
  return v_n;
end
$$;

-- Bring back deleted files (after restoring a backup that still uses them).
create or replace function public.undelete_files(p_code text, p_file_ids jsonb) returns integer
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_n integer;
begin
  update public.tracker_files set deleted_at = null
    where code_hash = public.rt_tracker_hash(p_code) and file_id = any (public.rt_ids(p_file_ids)) and deleted_at is not null;
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- Every file this tracker has (for storage use and tidying up).
create or replace function public.list_files(p_code text) returns jsonb
language sql stable security definer
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(jsonb_build_object('file_id', file_id, 'name', name, 'mime', mime, 'size', size,
                                               'complete', complete, 'created_at', created_at, 'deleted_at', deleted_at)
                            order by created_at), '[]'::jsonb)
  from public.tracker_files where code_hash = public.rt_tracker_hash(p_code)
$$;

revoke all on function public.rt_check(jsonb) from public, anon, authenticated;
grant execute on function public.create_tracker(jsonb) to anon, authenticated;
grant execute on function public.load_tracker(text) to anon, authenticated;
grant execute on function public.save_tracker(text, jsonb, integer) to anon, authenticated;
grant execute on function public.list_backups(text) to anon, authenticated;
grant execute on function public.backup_tracker(text) to anon, authenticated;
grant execute on function public.restore_backup(text, bigint) to anon, authenticated;
revoke all on function public.rt_purge_files() from public, anon, authenticated;
revoke all on function public.rt_tracker_hash(text) from public, anon, authenticated;
grant execute on function public.put_file_chunk(text, text, integer, integer, text, text, integer, text) to anon, authenticated;
grant execute on function public.get_file_chunk(text, text, integer) to anon, authenticated;
grant execute on function public.get_small_files(text, jsonb) to anon, authenticated;
grant execute on function public.delete_files(text, jsonb) to anon, authenticated;
grant execute on function public.undelete_files(text, jsonb) to anon, authenticated;
grant execute on function public.list_files(text) to anon, authenticated;
