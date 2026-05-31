-- ============================================================================
-- Verrouillage des privilèges du rôle anon (clé publique exposée dans /activites)
-- ----------------------------------------------------------------------------
-- Contexte : la clé anon est livrée dans le HTML public. Tout ce que le rôle
-- anon peut faire est accessible à n'importe qui. Avant ce verrou, anon pouvait
-- SELECT/UPDATE/DELETE/INSERT sur les tables opérationnelles (fuite de courriels
-- + défaçage + suppression de données).
--
-- Approche : REVOKE des privilèges de table au rôle `anon`. C'est plus
-- déterministe que de manipuler les politiques RLS : un privilège retiré est
-- refusé quelles que soient les politiques existantes. Tout est dans UN SEUL
-- bloc DO, qui ne touche que des tables existantes et n'échoue pas (REVOKE d'un
-- privilège non accordé = no-op). Aucune transaction ne peut tout annuler par
-- effet de bord.
--
-- Modèle cible pour anon :
--   • Tables d'affichage (nouvelles_*, activites) ............ SELECT seul
--   • Self-service public (inscriptions_activites, members) .. INSERT seul
--   • PII / interne (commentaires, push, healthcheck, history)  AUCUN accès
--
-- Le service_role (fonctions Netlify) bypasse tout ceci et garde l'accès complet.
--
-- ⚠️  PRÉREQUIS : déployer le code AVANT d'exécuter ce SQL. Sinon, le cron
--     envoyer-rappels et le GET de nouvelles-commentaire (encore en clé anon)
--     perdront leur accès. Les versions corrigées utilisent la service key.
--
-- ⚠️  IMPACT : la gestion des activités dans le navigateur (ajout/modif/
--     suppression sur /activites) cessera de fonctionner (elle écrivait via anon).
--     À remplacer par une fonction authentifiée (étape suivante). Calendrier,
--     inscription rappels, adhésion et /nouvelles continuent de fonctionner.
-- ============================================================================

do $$
declare t text;
begin
  -- ── 1. Tables d'affichage : anon garde SELECT, perd toute écriture ────────
  for t in
    select tablename from pg_tables
    where schemaname = 'public'
      and (tablename like 'nouvelles\_%' or tablename = 'activites')
      and tablename not in (
        'nouvelles_commentaires',     -- PII (courriels) → traité en section 3
        'nouvelles_healthcheck',      -- interne          → traité en section 3
        'nouvelles_finances_history'  -- interne          → traité en section 3
      )
  loop
    execute format('revoke insert, update, delete on public.%I from anon', t);
    raise notice 'Affichage (SELECT seul) : %', t;
  end loop;

  -- ── 2. Self-service public : anon garde INSERT, perd lecture + MAJ + suppr ─
  foreach t in array array['inscriptions_activites', 'members']
  loop
    if exists (select 1 from pg_tables where schemaname='public' and tablename=t) then
      execute format('revoke select, update, delete on public.%I from anon', t);
      raise notice 'Self-service (INSERT seul) : %', t;
    end if;
  end loop;

  -- ── 3. PII / interne : anon perd tout accès ───────────────────────────────
  foreach t in array array[
    'nouvelles_commentaires',
    'push_subscriptions',
    'nouvelles_healthcheck',
    'nouvelles_finances_history'
  ]
  loop
    if exists (select 1 from pg_tables where schemaname='public' and tablename=t) then
      execute format('revoke all on public.%I from anon', t);
      raise notice 'Privé (aucun accès anon) : %', t;
    end if;
  end loop;
end $$;

-- ── Vérification (lance ceci séparément après coup) ──────────────────────────
-- select table_name, string_agg(privilege_type, ', ' order by privilege_type) as anon_privs
-- from information_schema.role_table_grants
-- where grantee = 'anon' and table_schema = 'public'
-- group by table_name order by table_name;
