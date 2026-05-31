-- ============================================================================
-- Phase 3 — Widgets supplémentaires
-- ----------------------------------------------------------------------------
-- Tables rétro-ingénierie depuis les Netlify functions correspondantes.
-- Chaque table single-row utilise le pattern id=1 + CONSTRAINT single_row_*.
-- RLS activée + policy "Allow public read" (SELECT) sur chaque table.
--
-- Fonctions sources :
--   nouvelles_activites_loisirs   ← netlify/functions/nouvelles-loisirs-ao.js
--   nouvelles_air                 ← netlify/functions/nouvelles-air.js
--   nouvelles_aurores             ← netlify/functions/nouvelles-aurores.js
--   nouvelles_bornes_electriques  ← netlify/functions/nouvelles-bornes.js
--   nouvelles_cciao               ← netlify/functions/nouvelles-cciao.js
--   nouvelles_eau                 ← netlify/functions/nouvelles-eau.js
--   nouvelles_internet            ← netlify/functions/nouvelles-internet.js
--   nouvelles_transport           ← netlify/functions/nouvelles-transport.js
--   nouvelles_commentaires (multi-row) ← netlify/functions/nouvelles-commentaire.js
--   nouvelles_healthcheck  (multi-row, id text) ← netlify/functions/nouvelles-healthcheck.js
-- ============================================================================

-- ── Activités loisirs (Loisirs Abitibi-Ouest, agrégat single-row) ──────────
CREATE TABLE IF NOT EXISTS nouvelles_activites_loisirs (
  id int PRIMARY KEY DEFAULT 1,
  activites jsonb DEFAULT '[]'::jsonb,
  mis_a_jour timestamptz DEFAULT now(),
  CONSTRAINT single_row_activites_loisirs CHECK (id = 1)
);

-- ── Qualité de l'air (Open-Meteo Air Quality) ──────────────────────────────
CREATE TABLE IF NOT EXISTS nouvelles_air (
  id int PRIMARY KEY DEFAULT 1,
  aqi int,
  niveau text,
  pm25 float,
  pm10 float,
  o3 float,
  no2 float,
  mis_a_jour timestamptz DEFAULT now(),
  CONSTRAINT single_row_air CHECK (id = 1)
);

-- ── Aurores boréales / ciel nocturne (NOAA Kp + phase lunaire + météores) ──
CREATE TABLE IF NOT EXISTS nouvelles_aurores (
  id int PRIMARY KEY DEFAULT 1,
  kp_index float,
  probabilite_pct int,
  niveau text,
  visible_quebec boolean DEFAULT false,
  lune_phase text,
  lune_illumination float,
  lune_emoji text,
  meteore_nom text,
  meteore_taux_horaire int,
  meteore_pic_debut text,
  meteore_pic_fin text,
  mis_a_jour timestamptz DEFAULT now(),
  CONSTRAINT single_row_aurores CHECK (id = 1)
);

-- ── Bornes de recharge électrique (agrégat des sites) ──────────────────────
CREATE TABLE IF NOT EXISTS nouvelles_bornes_electriques (
  id int PRIMARY KEY DEFAULT 1,
  bornes jsonb DEFAULT '[]'::jsonb,
  total_bornes int DEFAULT 0,
  total_disponibles int DEFAULT 0,
  mis_a_jour timestamptz DEFAULT now(),
  CONSTRAINT single_row_bornes_electriques CHECK (id = 1)
);

-- ── Chambre de commerce et d'industrie Abitibi-Ouest (CCIAO) ───────────────
CREATE TABLE IF NOT EXISTS nouvelles_cciao (
  id int PRIMARY KEY DEFAULT 1,
  activites jsonb DEFAULT '[]'::jsonb,
  mis_a_jour timestamptz DEFAULT now(),
  CONSTRAINT single_row_cciao CHECK (id = 1)
);

-- ── Niveaux d'eau (stations hydrométriques) ────────────────────────────────
CREATE TABLE IF NOT EXISTS nouvelles_eau (
  id int PRIMARY KEY DEFAULT 1,
  stations jsonb DEFAULT '[]'::jsonb,
  mis_a_jour timestamptz DEFAULT now(),
  CONSTRAINT single_row_eau CHECK (id = 1)
);

-- ── Internet (médianes Ookla / BigQuery, par fournisseur) ──────────────────
CREATE TABLE IF NOT EXISTS nouvelles_internet (
  id int PRIMARY KEY DEFAULT 1,
  fournisseurs jsonb DEFAULT '[]'::jsonb,
  mediane_download_mbps float,
  mediane_upload_mbps float,
  mediane_latence_ms float,
  nb_tests int DEFAULT 0,
  periode_jours int,
  comparaison_qc jsonb DEFAULT '{}'::jsonb,
  mis_a_jour timestamptz DEFAULT now(),
  CONSTRAINT single_row_internet CHECK (id = 1)
);

-- ── Transport scolaire (alerte unique CSSLA) ───────────────────────────────
CREATE TABLE IF NOT EXISTS nouvelles_transport (
  id int PRIMARY KEY DEFAULT 1,
  alerte boolean DEFAULT false,
  message text,
  source_url text,
  mis_a_jour timestamptz DEFAULT now(),
  CONSTRAINT single_row_transport CHECK (id = 1)
);

-- ── Commentaires publics (multi-row, contient PII : courriels) ─────────────
CREATE TABLE IF NOT EXISTS nouvelles_commentaires (
  id serial PRIMARY KEY,
  nom text NOT NULL,
  courriel text,
  message text NOT NULL,
  statut text NOT NULL DEFAULT 'publie',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_commentaires_statut_date
  ON nouvelles_commentaires(statut, created_at DESC);

-- ── Healthcheck (singleton id='main' text, état machine d'alerte) ──────────
CREATE TABLE IF NOT EXISTS nouvelles_healthcheck (
  id text PRIMARY KEY,
  dernier_check timestamptz,
  statut text,
  ko_depuis timestamptz,
  derniere_alerte timestamptz,
  details jsonb DEFAULT '[]'::jsonb
);

-- ============================================================================
-- RLS : lecture publique pour les widgets d'affichage.
-- nouvelles_commentaires et nouvelles_healthcheck sont verrouillées au rôle
-- anon dans la migration 20260528_verrouiller_rls_anon.sql (PII / interne).
-- ============================================================================

ALTER TABLE nouvelles_activites_loisirs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE nouvelles_air                ENABLE ROW LEVEL SECURITY;
ALTER TABLE nouvelles_aurores            ENABLE ROW LEVEL SECURITY;
ALTER TABLE nouvelles_bornes_electriques ENABLE ROW LEVEL SECURITY;
ALTER TABLE nouvelles_cciao              ENABLE ROW LEVEL SECURITY;
ALTER TABLE nouvelles_eau                ENABLE ROW LEVEL SECURITY;
ALTER TABLE nouvelles_internet           ENABLE ROW LEVEL SECURITY;
ALTER TABLE nouvelles_transport          ENABLE ROW LEVEL SECURITY;
ALTER TABLE nouvelles_commentaires       ENABLE ROW LEVEL SECURITY;
ALTER TABLE nouvelles_healthcheck        ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='nouvelles_activites_loisirs' AND policyname='Allow public read') THEN
    CREATE POLICY "Allow public read" ON nouvelles_activites_loisirs FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='nouvelles_air' AND policyname='Allow public read') THEN
    CREATE POLICY "Allow public read" ON nouvelles_air FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='nouvelles_aurores' AND policyname='Allow public read') THEN
    CREATE POLICY "Allow public read" ON nouvelles_aurores FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='nouvelles_bornes_electriques' AND policyname='Allow public read') THEN
    CREATE POLICY "Allow public read" ON nouvelles_bornes_electriques FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='nouvelles_cciao' AND policyname='Allow public read') THEN
    CREATE POLICY "Allow public read" ON nouvelles_cciao FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='nouvelles_eau' AND policyname='Allow public read') THEN
    CREATE POLICY "Allow public read" ON nouvelles_eau FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='nouvelles_internet' AND policyname='Allow public read') THEN
    CREATE POLICY "Allow public read" ON nouvelles_internet FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='nouvelles_transport' AND policyname='Allow public read') THEN
    CREATE POLICY "Allow public read" ON nouvelles_transport FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='nouvelles_commentaires' AND policyname='Allow public read') THEN
    CREATE POLICY "Allow public read" ON nouvelles_commentaires FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='nouvelles_healthcheck' AND policyname='Allow public read') THEN
    CREATE POLICY "Allow public read" ON nouvelles_healthcheck FOR SELECT USING (true);
  END IF;
END $$;
