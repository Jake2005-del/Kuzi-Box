alter table public.profiles
    add column if not exists last_spin_time timestamptz;

create or replace function public.claim_lucky_spin()
returns table (
    allowed boolean,
    last_spin_time timestamptz,
    server_now timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
    current_user_id uuid := auth.uid();
    previous_spin timestamptz;
    current_server_time timestamptz := clock_timestamp();
begin
    if current_user_id is null then
        raise exception 'Authentication required';
    end if;

    select profiles.last_spin_time
      into previous_spin
      from public.profiles
     where profiles.id = current_user_id
     for update;

    if not found then
        raise exception 'Profile not found';
    end if;

    if previous_spin is not null
       and previous_spin > current_server_time - interval '24 hours' then
        return query select false, previous_spin, current_server_time;
        return;
    end if;

    update public.profiles
       set last_spin_time = current_server_time
     where profiles.id = current_user_id;

    return query select true, current_server_time, current_server_time;
end;
$$;

revoke all on function public.claim_lucky_spin() from public;
grant execute on function public.claim_lucky_spin() to authenticated;
