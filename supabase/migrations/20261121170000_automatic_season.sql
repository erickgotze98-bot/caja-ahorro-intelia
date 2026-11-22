BEGIN;

-- Creates a December–November season on the first financial operation.
-- Authenticated users can call this RPC; the owner is always taken from auth.uid().
CREATE OR REPLACE FUNCTION public.asegurar_caja_automatica()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_owner uuid := auth.uid();
    v_hoy date := public.fn_hoy_mx();
    v_anio integer;
    v_inicio date;
    v_fin date;
    v_ciclo_id uuid;
    v_diciembre date;
BEGIN
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'No autenticado.';
    END IF;

    SELECT c.id
      INTO v_ciclo_id
      FROM public.ciclos c
     WHERE c.owner_id = v_owner AND c.activo IS TRUE
     ORDER BY c.fecha_inicio DESC
     LIMIT 1
     FOR UPDATE;
    IF FOUND THEN
        RETURN v_ciclo_id;
    END IF;

    v_anio := EXTRACT(YEAR FROM v_hoy)::integer
              - CASE WHEN EXTRACT(MONTH FROM v_hoy) = 12 THEN 0 ELSE 1 END;
    v_diciembre := pg_catalog.make_date(v_anio, 12, 1);
    v_inicio := v_diciembre
                + ((6 - EXTRACT(DOW FROM v_diciembre)::integer + 7) % 7);
    v_fin := pg_catalog.make_date(v_anio + 1, 12, 1) - 1;
    v_fin := v_fin - ((EXTRACT(DOW FROM v_fin)::integer + 1) % 7);

    IF v_hoy > v_fin THEN
        v_anio := v_anio + 1;
        v_diciembre := pg_catalog.make_date(v_anio, 12, 1);
        v_inicio := v_diciembre
                    + ((6 - EXTRACT(DOW FROM v_diciembre)::integer + 7) % 7);
        v_fin := pg_catalog.make_date(v_anio + 1, 12, 1) - 1;
        v_fin := v_fin - ((EXTRACT(DOW FROM v_fin)::integer + 1) % 7);
    END IF;

    IF v_hoy < v_inicio THEN
        RAISE EXCEPTION 'La siguiente temporada comienza el %.', v_inicio;
    END IF;
    IF v_hoy > v_fin THEN
        RAISE EXCEPTION 'La fecha actual queda fuera de la temporada diciembre–noviembre.';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM public.ciclos c
         WHERE c.owner_id = v_owner
           AND daterange(c.fecha_inicio, c.fecha_fin, '[]')
               && daterange(v_inicio, v_fin, '[]')
    ) THEN
        RAISE EXCEPTION 'Ya existe una caja registrada para esta temporada. Revisa el historial.';
    END IF;

    BEGIN
        INSERT INTO public.ciclos (
            owner_id, nombre, fecha_inicio, fecha_fin,
            saldo_inicial_efectivo, saldo_inicial_transferencias,
            reserva_minima, activo
        ) VALUES (
            v_owner,
            pg_catalog.format('Temporada %s–%s', v_anio, v_anio + 1),
            v_inicio, v_fin, 0, 0, 0, TRUE
        )
        RETURNING id INTO v_ciclo_id;
    EXCEPTION WHEN exclusion_violation THEN
        SELECT c.id
          INTO v_ciclo_id
          FROM public.ciclos c
         WHERE c.owner_id = v_owner AND c.activo IS TRUE
         ORDER BY c.fecha_inicio DESC
         LIMIT 1;
        IF FOUND THEN
            RETURN v_ciclo_id;
        END IF;
        RAISE EXCEPTION 'No se pudo abrir la temporada porque coincide con otra caja.';
    END;

    RETURN v_ciclo_id;
END;
$$;

REVOKE ALL ON FUNCTION public.asegurar_caja_automatica() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.asegurar_caja_automatica() TO authenticated;
COMMENT ON FUNCTION public.asegurar_caja_automatica() IS
    'Devuelve la caja activa o crea la temporada diciembre–noviembre para la primera operación del usuario autenticado.';

NOTIFY pgrst, 'reload schema';
COMMIT;
