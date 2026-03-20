
-- Create import_jobs table
CREATE TABLE IF NOT EXISTS public.import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name text NOT NULL DEFAULT 'chemistwarehouse',
  file_name text NOT NULL,
  status text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','parsed','review','importing','completed','failed')),
  total_rows integer NOT NULL DEFAULT 0,
  matched_rows integer NOT NULL DEFAULT 0,
  new_rows integer NOT NULL DEFAULT 0,
  ambiguous_rows integer NOT NULL DEFAULT 0,
  invalid_rows integer NOT NULL DEFAULT 0,
  skipped_rows integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  error_summary text NULL
);

CREATE INDEX IF NOT EXISTS idx_import_jobs_created_by ON public.import_jobs(created_by);
CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON public.import_jobs(status);
CREATE INDEX IF NOT EXISTS idx_import_jobs_created_at ON public.import_jobs(created_at DESC);

-- Create import_rows table
CREATE TABLE IF NOT EXISTS public.import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_job_id uuid NOT NULL REFERENCES public.import_jobs(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  source_name text NOT NULL DEFAULT 'chemistwarehouse',
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_url text NULL,
  source_product_id text NULL,
  source_sku text NULL,
  source_slug text NULL,
  source_name_raw text NULL,
  source_brand text NULL,
  source_current_price numeric NULL,
  source_rrp numeric NULL,
  source_currency text NULL,
  source_in_stock boolean NULL,
  source_category_path text NULL,
  source_image_url text NULL,
  source_review_rating numeric NULL,
  source_review_count integer NULL,
  source_updated_at timestamptz NULL,
  source_meta_json jsonb NULL,
  normalized_name text NULL,
  normalized_brand text NULL,
  normalized_slug text NULL,
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  match_status text NOT NULL DEFAULT 'new' CHECK (match_status IN ('matched','new','ambiguous','invalid','skipped')),
  match_method text NULL,
  match_confidence numeric NULL,
  matched_product_id uuid NULL,
  candidate_matches jsonb NOT NULL DEFAULT '[]'::jsonb,
  resolution_action text NULL CHECK (resolution_action IN ('update','create','skip','manual_link')),
  resolved_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_import_rows_job_id ON public.import_rows(import_job_id);
CREATE INDEX IF NOT EXISTS idx_import_rows_job_status ON public.import_rows(import_job_id, match_status);
CREATE INDEX IF NOT EXISTS idx_import_rows_source_url ON public.import_rows(source_url);
CREATE INDEX IF NOT EXISTS idx_import_rows_source_sku ON public.import_rows(source_sku);
CREATE INDEX IF NOT EXISTS idx_import_rows_source_product_id ON public.import_rows(source_product_id);
CREATE INDEX IF NOT EXISTS idx_import_rows_normalized_name ON public.import_rows(normalized_name);
CREATE INDEX IF NOT EXISTS idx_import_rows_normalized_brand ON public.import_rows(normalized_brand);
CREATE INDEX IF NOT EXISTS idx_import_rows_normalized_slug ON public.import_rows(normalized_slug);

-- Create product_sources table
CREATE TABLE IF NOT EXISTS public.product_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  source_name text NOT NULL,
  source_url text NULL,
  source_product_id text NULL,
  source_sku text NULL,
  source_slug text NULL,
  source_name_raw text NULL,
  source_brand text NULL,
  source_current_price numeric NULL,
  source_rrp numeric NULL,
  source_currency text NULL,
  source_in_stock boolean NULL,
  source_category_path text NULL,
  source_image_url text NULL,
  source_review_rating numeric NULL,
  source_review_count integer NULL,
  source_updated_at timestamptz NULL,
  source_meta_json jsonb NULL,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_sources_url ON public.product_sources(source_name, source_url) WHERE source_url IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_sources_sku ON public.product_sources(source_name, source_sku) WHERE source_sku IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_sources_pid ON public.product_sources(source_name, source_product_id) WHERE source_product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_product_sources_product_id ON public.product_sources(product_id);
CREATE INDEX IF NOT EXISTS idx_product_sources_source_name ON public.product_sources(source_name);

-- Reusable updated_at trigger function
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_import_jobs_updated_at BEFORE UPDATE ON public.import_jobs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_import_rows_updated_at BEFORE UPDATE ON public.import_rows FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_product_sources_updated_at BEFORE UPDATE ON public.product_sources FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS
ALTER TABLE public.import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_sources ENABLE ROW LEVEL SECURITY;

-- import_jobs RLS
CREATE POLICY "Users can select own import_jobs" ON public.import_jobs FOR SELECT TO authenticated USING (created_by = auth.uid());
CREATE POLICY "Users can insert own import_jobs" ON public.import_jobs FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
CREATE POLICY "Users can update own import_jobs" ON public.import_jobs FOR UPDATE TO authenticated USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
CREATE POLICY "Users can delete own import_jobs" ON public.import_jobs FOR DELETE TO authenticated USING (created_by = auth.uid());

-- import_rows RLS
CREATE POLICY "Users can select own import_rows" ON public.import_rows FOR SELECT TO authenticated USING (import_job_id IN (SELECT id FROM public.import_jobs WHERE created_by = auth.uid()));
CREATE POLICY "Users can insert own import_rows" ON public.import_rows FOR INSERT TO authenticated WITH CHECK (import_job_id IN (SELECT id FROM public.import_jobs WHERE created_by = auth.uid()));
CREATE POLICY "Users can update own import_rows" ON public.import_rows FOR UPDATE TO authenticated USING (import_job_id IN (SELECT id FROM public.import_jobs WHERE created_by = auth.uid())) WITH CHECK (import_job_id IN (SELECT id FROM public.import_jobs WHERE created_by = auth.uid()));
CREATE POLICY "Users can delete own import_rows" ON public.import_rows FOR DELETE TO authenticated USING (import_job_id IN (SELECT id FROM public.import_jobs WHERE created_by = auth.uid()));

-- product_sources RLS (match products table pattern - all authenticated)
CREATE POLICY "Authenticated can read product_sources" ON public.product_sources FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert product_sources" ON public.product_sources FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update product_sources" ON public.product_sources FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
