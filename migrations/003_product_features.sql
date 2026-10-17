-- Additive feature storage. Apply in a transaction after a private backup.
CREATE TABLE IF NOT EXISTS public.feature_records (
    collection text NOT NULL, id text NOT NULL, data text NOT NULL,
    revision integer NOT NULL DEFAULT 1, updated_at text NOT NULL,
    PRIMARY KEY (collection,id)
);
CREATE INDEX IF NOT EXISTS feature_records_updated ON public.feature_records(collection,updated_at);
ALTER TABLE public.feature_records ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION public.housing_feature_version() RETURNS integer
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$ SELECT 1; $$;
CREATE OR REPLACE FUNCTION public.housing_feature_exchange(
    p_collection text,p_id text,p_data text,p_revision bigint,p_remove boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE result public.feature_records;
BEGIN
    IF p_collection !~ '^[a-z][a-z0-9_]{0,63}$' OR length(p_id) NOT BETWEEN 1 AND 2048 OR p_revision < 0 THEN
        RAISE EXCEPTION 'Invalid record key or revision';
    END IF;
    IF NOT p_remove AND (p_data IS NULL OR length(p_data)>250000 OR jsonb_typeof(p_data::jsonb) NOT IN ('object','array')) THEN
        RAISE EXCEPTION 'Invalid record data';
    END IF;
    IF p_remove THEN
        DELETE FROM public.feature_records WHERE collection=p_collection AND id=p_id AND revision=p_revision RETURNING * INTO result;
    ELSIF p_revision=0 THEN
        INSERT INTO public.feature_records(collection,id,data,revision,updated_at)
            VALUES(p_collection,p_id,p_data,1,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
            ON CONFLICT(collection,id) DO NOTHING RETURNING * INTO result;
    ELSE
        UPDATE public.feature_records SET data=p_data,revision=revision+1,
            updated_at=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            WHERE collection=p_collection AND id=p_id AND revision=p_revision RETURNING * INTO result;
    END IF;
    IF NOT FOUND THEN RETURN NULL; END IF;
    RETURN to_jsonb(result);
END $$;
CREATE OR REPLACE FUNCTION public.housing_requeue_evaluation(p_id text) RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE changed integer;
BEGIN
    UPDATE public.listings SET is_evaluated=false,evaluation_status='pending',evaluation_attempts=0,
        evaluation_next_at=NULL,evaluation_last_error=NULL,evaluation_claim_token=NULL,evaluation_claim_expires_at=NULL
        WHERE id=p_id AND is_evaluated=true AND status<>'passed' AND evaluation_status<>'processing';
    GET DIAGNOSTICS changed=ROW_COUNT;
    RETURN changed;
END $$;
REVOKE ALL ON TABLE public.feature_records FROM PUBLIC;
REVOKE ALL ON FUNCTION public.housing_feature_version() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.housing_feature_exchange(text,text,text,bigint,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.housing_requeue_evaluation(text) FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
        IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
            EXECUTE format('REVOKE ALL ON TABLE public.feature_records FROM %I',role_name);
            EXECUTE format('REVOKE ALL ON FUNCTION public.housing_feature_version() FROM %I',role_name);
            EXECUTE format('REVOKE ALL ON FUNCTION public.housing_feature_exchange(text,text,text,bigint,boolean) FROM %I',role_name);
            EXECUTE format('REVOKE ALL ON FUNCTION public.housing_requeue_evaluation(text) FROM %I',role_name);
        END IF;
    END LOOP;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
        GRANT SELECT,INSERT,UPDATE,DELETE ON public.feature_records TO service_role;
        GRANT EXECUTE ON FUNCTION public.housing_feature_version() TO service_role;
        GRANT EXECUTE ON FUNCTION public.housing_feature_exchange(text,text,text,bigint,boolean) TO service_role;
        GRANT EXECUTE ON FUNCTION public.housing_requeue_evaluation(text) TO service_role;
    END IF;
END $$;
NOTIFY pgrst,'reload schema';
