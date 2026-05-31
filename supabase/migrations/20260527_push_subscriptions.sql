-- Table des abonnements aux notifications push (Web Push API)
-- Chaque ligne = une installation PWA d'un visiteur ayant accepté les alertes.
-- L'endpoint est l'URL unique fournie par le navigateur (FCM, APNs, Mozilla...).

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  last_error text,
  last_error_at timestamptz
);

create index if not exists push_subscriptions_active_idx
  on public.push_subscriptions(active)
  where active = true;

-- RLS activée — seul le service_role (Netlify functions) accède à cette table.
alter table public.push_subscriptions enable row level security;
