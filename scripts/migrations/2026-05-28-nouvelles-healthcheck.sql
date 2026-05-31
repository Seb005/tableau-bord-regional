-- Migration : table d'état du health-check du tableau de bord /nouvelles
-- À appliquer manuellement via Supabase SQL editor.
-- Voir docs/superpowers/specs/2026-05-28-nouvelles-healthcheck-design.md

create table if not exists public.nouvelles_healthcheck (
  id text primary key default 'main',
  dernier_check timestamptz not null default now(),
  statut text not null check (statut in ('ok', 'ko')),
  ko_depuis timestamptz,
  derniere_alerte timestamptz,
  details jsonb not null default '[]'::jsonb
);

-- Seul le service role peut lire/écrire (table interne, non publique)
alter table public.nouvelles_healthcheck enable row level security;

-- Initialisation : un seul enregistrement, état 'ok'
insert into public.nouvelles_healthcheck (id, statut)
values ('main', 'ok')
on conflict (id) do nothing;
