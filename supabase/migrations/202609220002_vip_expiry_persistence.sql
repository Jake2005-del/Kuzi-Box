alter table public.profiles
    add column if not exists vip_activated_at timestamptz,
    add column if not exists vip_expires_at timestamptz;

update public.profiles
   set vip_activated_at = coalesce(vip_activated_at, now()),
       vip_expires_at = coalesce(vip_expires_at, now() + interval '7 days')
 where is_vip = true
   and vip_expires_at is null;
