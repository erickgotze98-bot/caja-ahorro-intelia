BEGIN;

-- Interest is accrued using each outstanding principal balance. Annulling an
-- older loan payment after a later payment can change the principal history
-- behind interest already accrued by registrar_transaccion. Require reverse
-- chronological corrections so stored interest remains consistent.
CREATE OR REPLACE FUNCTION public.anular_transaccion(
  p_transaccion_id uuid,
  p_motivo text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid := auth.uid();
  v_ciclo_id uuid;
  v_tx public.transacciones%ROWTYPE;
  v_log_id uuid;
  v_hay_abonos boolean;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'No autenticado.'; END IF;
  IF p_motivo IS NULL OR pg_catalog.length(pg_catalog.btrim(p_motivo)) < 5 THEN
    RAISE EXCEPTION 'El motivo debe tener al menos cinco caracteres.';
  END IF;

  SELECT t.ciclo_id INTO v_ciclo_id
    FROM public.transacciones t
   WHERE t.id = p_transaccion_id AND t.owner_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaccion no encontrada.'; END IF;

  PERFORM 1 FROM public.ciclos c
   WHERE c.id = v_ciclo_id AND c.owner_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ciclo no encontrado.'; END IF;

  SELECT t.* INTO v_tx FROM public.transacciones t
   WHERE t.id = p_transaccion_id AND t.owner_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaccion no encontrada.'; END IF;

  IF v_tx.anulado THEN
    SELECT b.id INTO v_log_id FROM public.bitacora_anulaciones b
     WHERE b.owner_id = v_owner AND b.transaccion_id = p_transaccion_id;
    RETURN v_log_id;
  END IF;

  PERFORM public.fn_verificar_periodo_abierto(v_owner,v_tx.ciclo_id,v_tx.fecha_operacion);

  IF v_tx.tipo_movimiento = 'desembolso_prestamo' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.transacciones t
       WHERE t.owner_id = v_owner AND t.prestamo_id = v_tx.prestamo_id
         AND t.tipo_movimiento = 'abono_prestamo' AND t.anulado = false
    ) INTO v_hay_abonos;
    IF v_hay_abonos THEN
      RAISE EXCEPTION 'No se puede anular un desembolso con abonos registrados.';
    END IF;
  ELSIF v_tx.tipo_movimiento = 'abono_prestamo' THEN
    IF EXISTS (
      SELECT 1 FROM public.transacciones t
       WHERE t.owner_id = v_owner AND t.prestamo_id = v_tx.prestamo_id
         AND t.tipo_movimiento = 'abono_prestamo'
         AND (t.fecha_operacion,t.creado_at,t.id) > (v_tx.fecha_operacion,v_tx.creado_at,v_tx.id)
    ) THEN
      RAISE EXCEPTION 'No se puede anular este abono porque hay pagos posteriores. Anula primero los pagos más recientes.';
    END IF;
  END IF;

  PERFORM pg_catalog.set_config('app.anulando','on',true);
  UPDATE public.transacciones
     SET anulado = true, anulado_at = pg_catalog.now()
   WHERE id = p_transaccion_id AND owner_id = v_owner;

  INSERT INTO public.bitacora_anulaciones(owner_id,transaccion_id,motivo,usuario_id)
  VALUES (v_owner,p_transaccion_id,pg_catalog.btrim(p_motivo),v_owner)
  RETURNING id INTO v_log_id;

  IF v_tx.tipo_movimiento = 'desembolso_prestamo' THEN
    PERFORM pg_catalog.set_config('app.estado_prestamo','on',true);
    UPDATE public.prestamos SET estado = 'anulado'
     WHERE id = v_tx.prestamo_id AND owner_id = v_owner;
  ELSIF v_tx.tipo_movimiento = 'abono_prestamo' THEN
    PERFORM public.fn_actualizar_estado_prestamo(v_owner,v_tx.prestamo_id);
  END IF;

  PERFORM public.fn_validar_saldos(v_owner,v_tx.ciclo_id);
  RETURN v_log_id;
END;
$$;

REVOKE ALL ON FUNCTION public.anular_transaccion(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anular_transaccion(uuid,text) TO authenticated;
COMMENT ON FUNCTION public.anular_transaccion(uuid,text) IS
  'Anula movimientos y registra el motivo en bitacora; los abonos de prestamos solo pueden anularse en orden inverso a su registro.';

NOTIFY pgrst, 'reload schema';
COMMIT;
