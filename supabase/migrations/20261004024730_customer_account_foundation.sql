-- Account foundation only. No legacy rows are deleted and no payment entitlement is granted.
-- BFF-only access: browser roles receive neither table access nor RPC execution.
create table public.customer_accounts (
  user_id uuid primary key references auth.users(id),
  state text not null default 'ACTIVE' check (state in ('ACTIVE', 'SUSPENDED')),
  created_at timestamptz not null default now()
);
create table public.customer_trial_grants (
  user_id uuid primary key references public.customer_accounts(user_id),
  granted_seconds integer not null default 900 check (granted_seconds = 900),
  created_at timestamptz not null default now()
);
create table public.customer_request_limits (
  bucket_hash text primary key check (bucket_hash ~ '^[a-f0-9]{64}$'),
  hits integer not null check (hits > 0),
  expires_at timestamptz not null
);
create index customer_request_limits_expiry on public.customer_request_limits(expires_at);
alter table public.customer_accounts enable row level security;
alter table public.customer_trial_grants enable row level security;
alter table public.customer_request_limits enable row level security;
revoke all on public.customer_accounts, public.customer_trial_grants, public.customer_request_limits
  from public, anon, authenticated, service_role;

-- Parameters come only from a server-verified Supabase user/token, never a browser body.
-- Checking auth.sessions prevents a logged-out access JWT from continuing until JWT expiry.
create function public.customer_authorize(p_user_id uuid, p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare account_state text;
begin
  if not exists(select 1 from auth.users u join auth.sessions s on s.user_id = u.id
    where u.id = p_user_id and u.email_confirmed_at is not null and u.email is not null
      and s.id = p_session_id and (s.not_after is null or s.not_after > now())) then
    return jsonb_build_object('code', 'UNAUTHENTICATED');
  end if;
  select state into account_state from public.customer_accounts where user_id = p_user_id;
  if not found then
    insert into public.customer_accounts(user_id) values(p_user_id) on conflict do nothing;
    select state into account_state from public.customer_accounts where user_id = p_user_id;
  end if;
  if account_state <> 'ACTIVE' then return jsonb_build_object('code', 'SUSPENDED'); end if;
  -- At most one forever per Auth UUID; sign-in, password recovery and linked Google
  -- identities cannot replenish it. No periodic renewal or client-provided amount.
  if not exists(select 1 from public.customer_trial_grants where user_id = p_user_id) then
    insert into public.customer_trial_grants(user_id) values(p_user_id) on conflict do nothing;
  end if;
  return jsonb_build_object('code', 'ACTIVE', 'userId', p_user_id,
    'trialSecondsGranted', 900, 'remoteDesktop', false);
end $$;

create function public.customer_auth_rate_limit(p_bucket_hash text, p_maximum integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare total integer;
begin
  if p_bucket_hash is null or p_bucket_hash !~ '^[a-f0-9]{64}$'
    or p_maximum is null or p_maximum < 1 or p_maximum > 120 then return false; end if;
  insert into public.customer_request_limits(bucket_hash, hits, expires_at)
    values(p_bucket_hash, 1, now() + interval '15 minutes')
    on conflict (bucket_hash) do update set
      hits = case when customer_request_limits.expires_at <= now() then 1
                  else least(customer_request_limits.hits + 1, 121) end,
      expires_at = case when customer_request_limits.expires_at <= now()
                        then now() + interval '15 minutes' else customer_request_limits.expires_at end
    returning hits into total;
  return total <= p_maximum;
end $$;
revoke all on function public.customer_authorize(uuid,uuid) from public, anon, authenticated;
revoke all on function public.customer_auth_rate_limit(text,integer) from public, anon, authenticated;
grant execute on function public.customer_authorize(uuid,uuid) to service_role;
grant execute on function public.customer_auth_rate_limit(text,integer) to service_role;
