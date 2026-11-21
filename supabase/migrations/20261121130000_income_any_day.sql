BEGIN;

-- Allows weekday dates only inside the dedicated savings-income RPCs.
-- Other uses of fn_verificar_periodo_abierto continue to require Saturday.
CREATE OR REPLACE FUNCTION public.fn_verificar_periodo_abierto(
    p_owner uuid, p_ciclo_id uuid, p_fecha date
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_inicio date; v_fin date; v_activo boolean;
BEGIN
    IF p_owner IS NULL OR p_owner IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'No autenticado o propietario invalido.';
    END IF;
    IF p_fecha IS NULL OR (
        EXTRACT(DOW FROM p_fecha) <> 6
        AND pg_catalog.current_setting('mi_caja.aportacion_owner', true) IS DISTINCT FROM p_owner::text
    ) THEN
        RAISE EXCEPTION 'La fecha de operacion debe ser sabado, salvo en un ingreso a caja autorizado.';
    END IF;
    IF p_fecha > public.fn_hoy_mx() THEN
        RAISE EXCEPTION 'No se permiten operaciones futuras.';
    END IF;
    SELECT c.fecha_inicio, c.fecha_fin, c.activo
      INTO v_inicio, v_fin, v_activo
      FROM public.ciclos c
     WHERE c.id = p_ciclo_id AND c.owner_id = p_owner;
    IF NOT FOUND OR v_activo IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'No se encontro un ciclo activo para este propietario.';
    END IF;
    IF p_fecha < v_inicio OR p_fecha > v_fin THEN
        RAISE EXCEPTION 'La fecha queda fuera del ciclo.';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.arqueos_semanales a
         WHERE a.owner_id = p_owner AND a.ciclo_id = p_ciclo_id
           AND a.fecha_sabado >= p_fecha
    ) THEN
        RAISE EXCEPTION 'El periodo ya fue cerrado por un arqueo.';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.registrar_aportacion_cualquier_dia(
    p_ciclo_id uuid,
    p_monto numeric,
    p_metodo_pago text,
    p_fecha_operacion date,
    p_participante_id uuid,
    p_id uuid,
    p_nota text DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_owner uuid := auth.uid();
BEGIN
    IF v_owner IS NULL THEN RAISE EXCEPTION 'No autenticado.'; END IF;
    PERFORM pg_catalog.set_config('mi_caja.aportacion_owner', v_owner::text, true);
    RETURN public.registrar_transaccion(
        p_ciclo_id, 'ahorro_semanal', p_monto, p_metodo_pago,
        p_fecha_operacion, p_participante_id, NULL, p_nota, p_id
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.anular_aportacion_cualquier_dia(
    p_transaccion_id uuid, p_motivo text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_owner uuid := auth.uid();
    v_tipo text;
BEGIN
    IF v_owner IS NULL THEN RAISE EXCEPTION 'No autenticado.'; END IF;
    SELECT t.tipo_movimiento INTO v_tipo
      FROM public.transacciones t
     WHERE t.id = p_transaccion_id AND t.owner_id = v_owner;
    IF NOT FOUND THEN RAISE EXCEPTION 'Transaccion no encontrada.'; END IF;
    IF v_tipo IS DISTINCT FROM 'ahorro_semanal' THEN
        RAISE EXCEPTION 'Esta funcion solo anula ingresos a caja.';
    END IF;
    PERFORM pg_catalog.set_config('mi_caja.aportacion_owner', v_owner::text, true);
    RETURN public.anular_transaccion(p_transaccion_id, p_motivo);
END;
$$;

-- Bucket weekday contributions under the Saturday closing that follows them.
CREATE OR REPLACE VIEW public.v_flujo_semanal
WITH (security_invoker = true)
AS
WITH sabados AS (
    SELECT c.owner_id,c.id AS ciclo_id,gs::date AS semana_sabado
      FROM public.ciclos c
      CROSS JOIN LATERAL pg_catalog.generate_series(
          c.fecha_inicio::timestamp,
          LEAST(
              c.fecha_fin,
              public.fn_hoy_mx() + ((6 - EXTRACT(DOW FROM public.fn_hoy_mx())::integer + 7) % 7)
          )::timestamp,
          interval '7 days'
      ) AS gs
),
movimientos AS (
    SELECT t.owner_id,t.ciclo_id,
           (t.fecha_operacion + ((6 - EXTRACT(DOW FROM t.fecha_operacion)::integer + 7) % 7)) AS semana_sabado,
           SUM(t.monto) FILTER (WHERE t.tipo_movimiento='ahorro_semanal') AS ahorro,
           SUM(t.capital_aplicado) FILTER (WHERE t.tipo_movimiento='abono_prestamo') AS abono_capital,
           SUM(t.interes_aplicado) FILTER (WHERE t.tipo_movimiento='abono_prestamo') AS abono_interes,
           SUM(t.monto) FILTER (WHERE t.tipo_movimiento='pago_multa') AS multas,
           SUM(t.monto) FILTER (WHERE t.tipo_movimiento='ajuste_ingreso') AS ajuste_ingreso,
           SUM(t.monto) FILTER (WHERE t.tipo_movimiento='desembolso_prestamo') AS desembolsos,
           SUM(t.monto) FILTER (WHERE t.tipo_movimiento='gasto') AS gastos,
           SUM(t.monto) FILTER (WHERE t.tipo_movimiento='retiro_caja') AS retiros,
           SUM(t.monto) FILTER (WHERE t.tipo_movimiento='ajuste_egreso') AS ajuste_egreso
      FROM public.transacciones t
     WHERE t.anulado=false
     GROUP BY t.owner_id,t.ciclo_id,
              (t.fecha_operacion + ((6 - EXTRACT(DOW FROM t.fecha_operacion)::integer + 7) % 7))
)
SELECT s.owner_id,s.ciclo_id,s.semana_sabado,
       COALESCE(m.ahorro,0)::numeric(12,2) AS ahorro,
       COALESCE(m.abono_capital,0)::numeric(12,2) AS abono_capital,
       COALESCE(m.abono_interes,0)::numeric(12,2) AS abono_interes,
       COALESCE(m.multas,0)::numeric(12,2) AS multas,
       COALESCE(m.ajuste_ingreso,0)::numeric(12,2) AS ajuste_ingreso,
       COALESCE(m.desembolsos,0)::numeric(12,2) AS desembolsos,
       COALESCE(m.gastos,0)::numeric(12,2) AS gastos,
       COALESCE(m.retiros,0)::numeric(12,2) AS retiros,
       COALESCE(m.ajuste_egreso,0)::numeric(12,2) AS ajuste_egreso,
       (
          COALESCE(m.ahorro,0)+COALESCE(m.abono_capital,0)+COALESCE(m.abono_interes,0)
          +COALESCE(m.multas,0)+COALESCE(m.ajuste_ingreso,0)-COALESCE(m.desembolsos,0)
          -COALESCE(m.gastos,0)-COALESCE(m.retiros,0)-COALESCE(m.ajuste_egreso,0)
       )::numeric(12,2) AS flujo_neto,
       a.efectivo_teorico,a.efectivo_fisico_real,a.saldo_banco_real,
       a.diferencia,a.diferencia_banco,a.estatus_cierre
  FROM sabados s
  LEFT JOIN movimientos m
    ON m.owner_id=s.owner_id AND m.ciclo_id=s.ciclo_id AND m.semana_sabado=s.semana_sabado
  LEFT JOIN public.arqueos_semanales a
    ON a.owner_id=s.owner_id AND a.ciclo_id=s.ciclo_id AND a.fecha_sabado=s.semana_sabado;

REVOKE ALL ON FUNCTION public.registrar_aportacion_cualquier_dia(uuid,numeric,text,date,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anular_aportacion_cualquier_dia(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registrar_aportacion_cualquier_dia(uuid,numeric,text,date,uuid,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.anular_aportacion_cualquier_dia(uuid,text) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
