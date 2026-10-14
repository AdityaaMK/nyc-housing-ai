-- Additive, transactional migration for PostgreSQL and Supabase HTTPS.
CREATE TABLE IF NOT EXISTS public.commute_control (
    id integer PRIMARY KEY CHECK (id = 1), revision bigint NOT NULL DEFAULT 0,
    attempts text NOT NULL DEFAULT '[]', disabled_config text, pause_until bigint NOT NULL DEFAULT 0
);
ALTER TABLE public.commute_control ENABLE ROW LEVEL SECURITY;
INSERT INTO public.commute_control (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.housing_commute_state() RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
    SELECT to_jsonb(c) FROM public.commute_control c WHERE id = 1;
$$;
CREATE OR REPLACE FUNCTION public.housing_commute_exchange(
    p_revision bigint, p_attempts text, p_disabled_config text, p_pause_until bigint
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
    IF jsonb_typeof(p_attempts::jsonb) <> 'array' OR jsonb_array_length(p_attempts::jsonb) > 9000
       OR p_pause_until < 0 THEN RAISE EXCEPTION 'Invalid accounting metadata'; END IF;
    UPDATE public.commute_control SET revision = revision + 1, attempts = p_attempts,
        disabled_config = p_disabled_config, pause_until = p_pause_until
    WHERE id = 1 AND revision = p_revision;
    RETURN FOUND;
END $$;
REVOKE ALL ON TABLE public.commute_control FROM PUBLIC;
REVOKE ALL ON FUNCTION public.housing_commute_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.housing_commute_exchange(bigint,text,text,bigint) FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
            EXECUTE format('REVOKE ALL ON TABLE public.commute_control FROM %I', role_name);
            EXECUTE format('REVOKE ALL ON FUNCTION public.housing_commute_state() FROM %I', role_name);
            EXECUTE format('REVOKE ALL ON FUNCTION public.housing_commute_exchange(bigint,text,text,bigint) FROM %I', role_name);
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT SELECT, UPDATE ON public.commute_control TO service_role;
        GRANT EXECUTE ON FUNCTION public.housing_commute_state() TO service_role;
        GRANT EXECUTE ON FUNCTION public.housing_commute_exchange(bigint,text,text,bigint) TO service_role;
    END IF;
END $$;
NOTIFY pgrst, 'reload schema';
