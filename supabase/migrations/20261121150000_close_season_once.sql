BEGIN;

-- The season is reconciled once, on its final Saturday. This function stores that
-- final cash/bank count and reuses the existing proportional distribution logic.
CREATE OR REPLACE FUNCTION public.cerrar_temporada_final(
    p_ciclo_id uuid,
    p_efectivo_fisico_real numeric,
    p_saldo_banco_real numeric,
    p_nota_ajuste text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_owner uuid := auth.uid();
    v_inicio date;
    v_fin date;
    v_activo boolean;
    v_efectivo_teorico numeric(12,2);
    v_banco_teorico numeric(12,2);
    v_diferencia numeric(12,2);
    v_diferencia_banco numeric(12,2);
    v_estatus text;
    v_arqueo public.arqueos_semanales%ROWTYPE;
    v_cierre_id uuid;
    c_tolerancia constant numeric(12,2) := 10.00;
BEGIN
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'No autenticado.';
    END IF;

    SELECT cc.id INTO v_cierre_id
      FROM public.cierres_ciclo cc
     WHERE cc.owner_id = v_owner AND cc.ciclo_id = p_ciclo_id;
    IF FOUND THEN
        RETURN v_cierre_id;
    END IF;

    SELECT c.fecha_inicio,c.fecha_fin,c.activo
      INTO v_inicio,v_fin,v_activo
      FROM public.ciclos c
     WHERE c.id = p_ciclo_id AND c.owner_id = v_owner
     FOR UPDATE;
    IF NOT FOUND OR v_activo IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'No se encontro una caja abierta para entregar.';
    END IF;
    IF v_fin IS NULL OR EXTRACT(DOW FROM v_fin) <> 6 THEN
        RAISE EXCEPTION 'La entrega debe programarse para el ultimo sabado de la temporada.';
    END IF;
    IF v_fin > public.fn_hoy_mx() THEN
        RAISE EXCEPTION 'La fecha final de la temporada todavía no llega.';
    END IF;
    IF p_efectivo_fisico_real IS NULL OR p_efectivo_fisico_real < 0
       OR p_efectivo_fisico_real > 9999999999.99
       OR p_efectivo_fisico_real <> pg_catalog.round(p_efectivo_fisico_real,2) THEN
        RAISE EXCEPTION 'El efectivo debe ser cero o mayor y tener máximo dos decimales.';
    END IF;
    IF p_saldo_banco_real IS NULL OR p_saldo_banco_real < 0
       OR p_saldo_banco_real > 9999999999.99
       OR p_saldo_banco_real <> pg_catalog.round(p_saldo_banco_real,2) THEN
        RAISE EXCEPTION 'El saldo bancario debe ser cero o mayor y tener máximo dos decimales.';
    END IF;
    IF p_nota_ajuste IS NOT NULL AND pg_catalog.length(p_nota_ajuste) > 1000 THEN
        RAISE EXCEPTION 'La explicación no puede exceder 1000 caracteres.';
    END IF;

    v_efectivo_teorico := COALESCE(public.fn_efectivo_disponible(p_ciclo_id,v_fin),0);
    v_banco_teorico := COALESCE(public.fn_saldo_transferencias(p_ciclo_id,v_fin),0);
    IF v_efectivo_teorico < 0 OR v_banco_teorico < 0 THEN
        RAISE EXCEPTION 'Los saldos esperados no pueden ser negativos. Revisa los movimientos antes de entregar.';
    END IF;
    v_diferencia := p_efectivo_fisico_real-v_efectivo_teorico;
    v_diferencia_banco := p_saldo_banco_real-v_banco_teorico;

    IF pg_catalog.abs(v_diferencia) > c_tolerancia
       OR pg_catalog.abs(v_diferencia_banco) > c_tolerancia THEN
        IF p_nota_ajuste IS NULL OR pg_catalog.length(pg_catalog.btrim(p_nota_ajuste)) < 5 THEN
            RAISE EXCEPTION 'La diferencia supera $10. Escribe una explicación de al menos cinco caracteres.';
        END IF;
        v_estatus := 'cerrado_con_discrepancia';
    ELSE
        v_estatus := 'cerrado';
    END IF;

    SELECT a.* INTO v_arqueo
      FROM public.arqueos_semanales a
     WHERE a.owner_id = v_owner AND a.ciclo_id = p_ciclo_id AND a.fecha_sabado = v_fin
     FOR UPDATE;
    IF FOUND THEN
        IF v_arqueo.efectivo_fisico_real <> p_efectivo_fisico_real
           OR v_arqueo.saldo_banco_real <> p_saldo_banco_real THEN
            RAISE EXCEPTION 'Ya existe un conteo final con cantidades distintas. Revisa el historial antes de continuar.';
        END IF;
    ELSE
        INSERT INTO public.arqueos_semanales(
            owner_id,ciclo_id,fecha_sabado,efectivo_teorico,efectivo_fisico_real,diferencia,
            banco_teorico,saldo_banco_real,diferencia_banco,estatus_cierre,nota_ajuste
        ) VALUES (
            v_owner,p_ciclo_id,v_fin,v_efectivo_teorico,p_efectivo_fisico_real,v_diferencia,
            v_banco_teorico,p_saldo_banco_real,v_diferencia_banco,v_estatus,p_nota_ajuste
        );
    END IF;

    RETURN public.cerrar_ciclo(p_ciclo_id);
END;
$$;

REVOKE ALL ON FUNCTION public.cerrar_temporada_final(uuid,numeric,numeric,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cerrar_temporada_final(uuid,numeric,numeric,text) FROM anon;
GRANT EXECUTE ON FUNCTION public.cerrar_temporada_final(uuid,numeric,numeric,text) TO authenticated;

COMMIT;
