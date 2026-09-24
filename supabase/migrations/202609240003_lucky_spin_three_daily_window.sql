alter table public.profiles
    add column if not exists daily_spin_count integer not null default 0,
    add column if not exists daily_spin_window_started_at timestamptz;

update public.profiles
   set daily_spin_count = 1,
       daily_spin_window_started_at = last_spin_time
 where daily_spin_count = 0
   and last_spin_time is not null
   and last_spin_time > now() - interval '24 hours';

drop function if exists public.claim_lucky_spin();

create function public.claim_lucky_spin()
returns table (
    allowed boolean,
    last_spin_time timestamptz,
    server_now timestamptz,
    spin_count integer,
    spin_window_started_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
    current_user_id uuid := auth.uid();
    previous_spin timestamptz;
    current_count integer;
    window_started_at timestamptz;
    current_server_time timestamptz := clock_timestamp();
begin
    if current_user_id is null then
        raise exception 'Authentication required';
    end if;

    select profiles.last_spin_time,
           profiles.daily_spin_count,
           profiles.daily_spin_window_started_at
      into previous_spin, current_count, window_started_at
      from public.profiles
     where profiles.id = current_user_id
     for update;

    if not found then
        raise exception 'Profile not found';
    end if;

    current_count := coalesce(current_count, 0);

    if window_started_at is null
       and previous_spin is not null
       and previous_spin > current_server_time - interval '24 hours' then
        window_started_at := previous_spin;
        current_count := greatest(current_count, 1);
    end if;

    if window_started_at is null
       or window_started_at <= current_server_time - interval '24 hours' then
        current_count := 0;
        window_started_at := current_server_time;
    end if;

    if current_count >= 3 then
        return query select false, previous_spin, current_server_time, current_count, window_started_at;
        return;
    end if;

    current_count := current_count + 1;

    update public.profiles
       set daily_spin_count = current_count,
           daily_spin_window_started_at = window_started_at,
           last_spin_time = current_server_time
     where profiles.id = current_user_id;

    return query select true, current_server_time, current_server_time, current_count, window_started_at;
end;
$$;

revoke all on function public.claim_lucky_spin() from public;
grant execute on function public.claim_lucky_spin() to authenticated;