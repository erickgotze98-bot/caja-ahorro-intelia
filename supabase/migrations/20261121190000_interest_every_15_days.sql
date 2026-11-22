BEGIN;

-- 5% simple interest for every complete 15-day period, calculated on the
-- outstanding principal. Interest is not capitalized; capital payments lower
-- the principal used by subsequent periods. Existing deployments must review
-- any pre-existing loans before first application of this migration.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'prestamos'
       AND column_name = 'periodos_interes_calculados'
  ) AND EXISTS (SELECT 1 FROM public.prestamos) THEN
    RAISE EXCEPTION 'Hay préstamos existentes. Revisa y reconcilia sus réditos antes de activar el cálculo quincenal.';
  END IF;
END;
$$;

ALTER TABLE public.prestamos
  ADD COLUMN IF NOT EXISTS periodos_interes_calculados integer NOT NULL DEFAULT 0;

ALTER TABLE public.prestamos
  DROP CONSTRAINT IF EXISTS prestamos_periodos_interes_calculados_check;
ALTER TABLE public.prestamos
  ADD CONSTRAINT prestamos_periodos_interes_calculados_check
  CHECK (periodos_interes_calculados >= 0);

COMMENT ON COLUMN public.prestamos.periodos_interes_calculados IS
  'Cantidad de periodos completos de 15 días ya incorporados a interes_total por la RPC de abonos.';

-- Keep loan data immutable to clients. Only the SECURITY DEFINER payment RPC
-- can update the accrued-interest fields, and only for the authenticated owner.
CREATE OR REPLACE FUNCTION public.fn_proteger_prestamo()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.owner_id IS DISTINCT FROM NEW.owner_id
     OR OLD.ciclo_id IS DISTINCT FROM NEW.ciclo_id
     OR OLD.participante_id IS DISTINCT FROM NEW.participante_id
     OR OLD.fecha_desembolso IS DISTINCT FROM NEW.fecha_desembolso
     OR OLD.fecha_vencimiento IS DISTINCT FROM NEW.fecha_vencimiento
     OR OLD.capital_original IS DISTINCT FROM NEW.capital_original
     OR OLD.plazo_semanas IS DISTINCT FROM NEW.plazo_semanas
     OR OLD.tasa_interes IS DISTINCT FROM NEW.tasa_interes
     OR OLD.metodo_pago_desembolso IS DISTINCT FROM NEW.metodo_pago_desembolso
     OR OLD.nota IS DISTINCT FROM NEW.nota
     OR OLD.p_id IS DISTINCT FROM NEW.p_id
     OR OLD.creado_at IS DISTINCT FROM NEW.creado_at THEN
    RAISE EXCEPTION 'Los datos originales del prestamo son inmutables.';
  END IF;

  IF OLD.interes_total IS DISTINCT FROM NEW.interes_total
     OR OLD.periodos_interes_calculados IS DISTINCT FROM NEW.periodos_interes_calculados THEN
    IF pg_catalog.current_setting('mi_caja.interes_prestamo', true) IS DISTINCT FROM 'on'
       OR auth.uid() IS DISTINCT FROM OLD.owner_id THEN
      RAISE EXCEPTION 'Los réditos solo se actualizan desde la RPC autorizada.';
    END IF;
  END IF;

  IF OLD.estado IS DISTINCT FROM NEW.estado
     AND pg_catalog.current_setting('app.estado_prestamo', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'El estado del prestamo solo cambia desde una RPC autorizada.';
  END IF;
  IF OLD.estado = 'anulado' AND NEW.estado IS DISTINCT FROM 'anulado' THEN
    RAISE EXCEPTION 'Un prestamo anulado no puede reactivarse.';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.fn_proteger_prestamo() IS
  'Protege los datos inmutables del préstamo; únicamente la RPC autenticada incorpora réditos quincenales.';

-- New loans start with zero accrued interest. The first 5% period is due only
-- after 15 complete days, then it is accrued before the next loan payment.
CREATE OR REPLACE FUNCTION public.crear_prestamo(
  p_ciclo_id uuid,
  p_participante_id uuid,
  p_capital numeric,
  p_plazo_semanas integer,
  p_fecha_desembolso date,
  p_metodo_pago text,
  p_id uuid,
  p_nota text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid := auth.uid();
  v_participante public.socios_y_clientes%ROWTYPE;
  v_activo boolean;
  v_tasa numeric(6,4);
  v_vencimiento date;
  v_id uuid;
  v_existente public.prestamos%ROWTYPE;
  v_credito_pendiente numeric(14,2);
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'No autenticado.'; END IF;
  IF p_id IS NULL THEN RAISE EXCEPTION 'p_id es obligatorio para crear un prestamo.'; END IF;
  IF p_capital IS NULL OR p_capital <= 0 OR p_capital <> pg_catalog.round(p_capital,2) THEN
    RAISE EXCEPTION 'El capital debe ser positivo y tener maximo dos decimales.';
  END IF;
  IF p_plazo_semanas IS NULL OR p_plazo_semanas <= 0 THEN RAISE EXCEPTION 'El plazo debe ser mayor a cero.'; END IF;
  IF p_metodo_pago IS NULL OR p_metodo_pago NOT IN ('efectivo','transferencia') THEN
    RAISE EXCEPTION 'Metodo de desembolso invalido.';
  END IF;
  IF p_nota IS NOT NULL AND pg_catalog.length(p_nota) > 1000 THEN RAISE EXCEPTION 'La nota no puede exceder 1000 caracteres.'; END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_owner::text || p_id::text,1));
  SELECT p.* INTO v_existente FROM public.prestamos p WHERE p.owner_id = v_owner AND p.p_id = p_id;
  IF FOUND THEN
    IF v_existente.ciclo_id IS DISTINCT FROM p_ciclo_id
       OR v_existente.participante_id IS DISTINCT FROM p_participante_id
       OR v_existente.capital_original IS DISTINCT FROM p_capital
       OR v_existente.plazo_semanas IS DISTINCT FROM p_plazo_semanas
       OR v_existente.fecha_desembolso IS DISTINCT FROM p_fecha_desembolso
       OR v_existente.nota IS DISTINCT FROM p_nota
       OR v_existente.metodo_pago_desembolso IS DISTINCT FROM p_metodo_pago THEN
      RAISE EXCEPTION 'p_id ya fue usado con datos diferentes.';
    END IF;
    RETURN v_existente.id;
  END IF;

  PERFORM public.fn_verificar_periodo_abierto(v_owner,p_ciclo_id,p_fecha_desembolso);
  SELECT c.activo INTO v_activo FROM public.ciclos c
   WHERE c.id = p_ciclo_id AND c.owner_id = v_owner FOR UPDATE;
  IF NOT FOUND OR v_activo IS DISTINCT FROM true THEN RAISE EXCEPTION 'Ciclo activo no encontrado.'; END IF;
  SELECT s.* INTO v_participante FROM public.socios_y_clientes s
   WHERE s.id = p_participante_id AND s.owner_id = v_owner FOR UPDATE;
  IF NOT FOUND OR v_participante.estatus <> 'activo' THEN RAISE EXCEPTION 'Participante activo no encontrado.'; END IF;

  v_tasa := 0.0500;
  v_vencimiento := p_fecha_desembolso + (p_plazo_semanas * 7);
  IF v_participante.tipo = 'externo' THEN
    SELECT COALESCE(SUM(GREATEST(p.capital_original - COALESCE(pagos.capital_pagado,0),0)),0)
      INTO v_credito_pendiente
      FROM public.prestamos p
      LEFT JOIN (
        SELECT t.prestamo_id,SUM(t.capital_aplicado) AS capital_pagado
          FROM public.transacciones t
         WHERE t.owner_id = v_owner AND t.tipo_movimiento = 'abono_prestamo' AND t.anulado = false
         GROUP BY t.prestamo_id
      ) pagos ON pagos.prestamo_id = p.id
     WHERE p.owner_id = v_owner AND p.participante_id = p_participante_id AND p.estado = 'activo';
    IF COALESCE(v_credito_pendiente,0) + p_capital > v_participante.limite_credito THEN
      RAISE EXCEPTION 'El prestamo excede el limite de credito externo.';
    END IF;
  END IF;

  INSERT INTO public.prestamos (
    owner_id,ciclo_id,participante_id,fecha_desembolso,fecha_vencimiento,
    capital_original,plazo_semanas,tasa_interes,interes_total,periodos_interes_calculados,
    metodo_pago_desembolso,estado,nota,p_id
  ) VALUES (
    v_owner,p_ciclo_id,p_participante_id,p_fecha_desembolso,v_vencimiento,
    p_capital,p_plazo_semanas,v_tasa,0,0,p_metodo_pago,'activo',p_nota,p_id
  ) ON CONFLICT ON CONSTRAINT uq_prestamos_owner_pid DO NOTHING RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT p.* INTO v_existente FROM public.prestamos p WHERE p.owner_id = v_owner AND p.p_id = p_id;
    IF NOT FOUND OR v_existente.ciclo_id IS DISTINCT FROM p_ciclo_id
       OR v_existente.participante_id IS DISTINCT FROM p_participante_id
       OR v_existente.capital_original IS DISTINCT FROM p_capital
       OR v_existente.plazo_semanas IS DISTINCT FROM p_plazo_semanas
       OR v_existente.fecha_desembolso IS DISTINCT FROM p_fecha_desembolso
       OR v_existente.nota IS DISTINCT FROM p_nota
       OR v_existente.metodo_pago_desembolso IS DISTINCT FROM p_metodo_pago THEN
      RAISE EXCEPTION 'p_id ya fue usado con datos diferentes.';
    END IF;
    RETURN v_existente.id;
  END IF;

  INSERT INTO public.transacciones (
    owner_id,ciclo_id,participante_id,prestamo_id,fecha_operacion,
    tipo_movimiento,monto,metodo_pago,nota
  ) VALUES (
    v_owner,p_ciclo_id,p_participante_id,v_id,p_fecha_desembolso,
    'desembolso_prestamo',p_capital,p_metodo_pago,p_nota
  );
  PERFORM public.fn_validar_saldos(v_owner,p_ciclo_id);
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.crear_prestamo(uuid,uuid,numeric,integer,date,text,uuid,text) IS
  'Crea préstamos con tasa simple de 5% por cada periodo completo de 15 días sobre el capital pendiente; el primer periodo no se cobra al desembolso.';

-- Preserve transaction idempotency before any accrual side effect. The period
-- count advances only when an abono arrives; balances shown in the client also
-- include unposted full periods so the user sees the amount currently due.
CREATE OR REPLACE FUNCTION public.registrar_transaccion(
  p_ciclo_id uuid,
  p_tipo_movimiento text,
  p_monto numeric,
  p_metodo_pago text,
  p_fecha_operacion date,
  p_participante_id uuid DEFAULT NULL,
  p_prestamo_id uuid DEFAULT NULL,
  p_nota text DEFAULT NULL,
  p_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid := auth.uid();
  v_id uuid;
  v_existente public.transacciones%ROWTYPE;
  v_prestamo public.prestamos%ROWTYPE;
  v_participante public.socios_y_clientes%ROWTYPE;
  v_activo boolean;
  v_interes_pagado numeric(12,2);
  v_capital_pagado numeric(12,2);
  v_interes_pendiente numeric(12,2);
  v_capital_pendiente numeric(12,2);
  v_interes_aplicado numeric(12,2) := 0;
  v_capital_aplicado numeric(12,2) := 0;
  v_periodos_vencidos integer;
  v_periodos_nuevos integer;
  v_interes_nuevo numeric(12,2);
  v_ultima_fecha_abono date;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'No autenticado.'; END IF;
  IF p_id IS NULL THEN RAISE EXCEPTION 'p_id es obligatorio para garantizar idempotencia.'; END IF;
  IF p_tipo_movimiento = 'abono_prestamo' AND p_participante_id IS NULL THEN
    RAISE EXCEPTION 'Un abono requiere participante_id para conservar la idempotencia.';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_owner::text || p_id::text,0));
  SELECT t.* INTO v_existente FROM public.transacciones t WHERE t.owner_id = v_owner AND t.p_id = p_id;
  IF FOUND THEN
    IF v_existente.ciclo_id IS DISTINCT FROM p_ciclo_id
       OR v_existente.tipo_movimiento IS DISTINCT FROM p_tipo_movimiento
       OR v_existente.monto IS DISTINCT FROM p_monto
       OR v_existente.metodo_pago IS DISTINCT FROM p_metodo_pago
       OR v_existente.fecha_operacion IS DISTINCT FROM p_fecha_operacion
       OR v_existente.participante_id IS DISTINCT FROM p_participante_id
       OR v_existente.prestamo_id IS DISTINCT FROM p_prestamo_id
       OR v_existente.nota IS DISTINCT FROM p_nota THEN
      RAISE EXCEPTION 'p_id ya fue usado con datos diferentes.';
    END IF;
    RETURN v_existente.id;
  END IF;

  IF p_tipo_movimiento = 'abono_prestamo' THEN
    IF p_prestamo_id IS NULL THEN RAISE EXCEPTION 'Un abono requiere prestamo_id.'; END IF;
    SELECT p.* INTO v_prestamo FROM public.prestamos p
     WHERE p.id = p_prestamo_id AND p.owner_id = v_owner AND p.ciclo_id = p_ciclo_id
     FOR UPDATE;
    IF NOT FOUND OR v_prestamo.estado <> 'activo' THEN RAISE EXCEPTION 'Prestamo activo no encontrado en el ciclo.'; END IF;
    IF p_participante_id IS DISTINCT FROM v_prestamo.participante_id THEN
      RAISE EXCEPTION 'El participante no coincide con el prestamo.';
    END IF;

    SELECT COALESCE(SUM(t.interes_aplicado) FILTER (WHERE t.anulado = false),0),
           COALESCE(SUM(t.capital_aplicado) FILTER (WHERE t.anulado = false),0),
           MAX(t.fecha_operacion)
      INTO v_interes_pagado,v_capital_pagado,v_ultima_fecha_abono
      FROM public.transacciones t
     WHERE t.owner_id = v_owner AND t.prestamo_id = p_prestamo_id
       AND t.tipo_movimiento = 'abono_prestamo';
    IF v_ultima_fecha_abono IS NOT NULL AND p_fecha_operacion < v_ultima_fecha_abono THEN
      RAISE EXCEPTION 'No se permite registrar un abono anterior a otro ya guardado para este préstamo.';
    END IF;
    v_capital_pendiente := GREATEST(v_prestamo.capital_original - COALESCE(v_capital_pagado,0),0);
    v_periodos_vencidos := GREATEST(
      0,
      FLOOR(GREATEST(p_fecha_operacion - v_prestamo.fecha_desembolso,0)::numeric / 15)::integer
    );
    v_periodos_nuevos := GREATEST(v_periodos_vencidos - COALESCE(v_prestamo.periodos_interes_calculados,0),0);
    IF v_periodos_nuevos > 0 AND v_capital_pendiente > 0 THEN
      v_interes_nuevo := pg_catalog.round(v_capital_pendiente * v_prestamo.tasa_interes * v_periodos_nuevos,2);
      PERFORM pg_catalog.set_config('mi_caja.interes_prestamo','on',true);
      UPDATE public.prestamos
         SET interes_total = interes_total + v_interes_nuevo,
             periodos_interes_calculados = periodos_interes_calculados + v_periodos_nuevos
       WHERE id = p_prestamo_id AND owner_id = v_owner;
      PERFORM pg_catalog.set_config('mi_caja.interes_prestamo','off',true);
      v_prestamo.interes_total := v_prestamo.interes_total + v_interes_nuevo;
      v_prestamo.periodos_interes_calculados := v_prestamo.periodos_interes_calculados + v_periodos_nuevos;
    END IF;

    v_interes_pendiente := GREATEST(v_prestamo.interes_total - COALESCE(v_interes_pagado,0),0);
    v_capital_pendiente := GREATEST(v_prestamo.capital_original - COALESCE(v_capital_pagado,0),0);
    IF p_monto > v_interes_pendiente + v_capital_pendiente THEN RAISE EXCEPTION 'El abono excede el saldo pendiente.'; END IF;
    v_interes_aplicado := LEAST(p_monto,v_interes_pendiente);
    v_capital_aplicado := p_monto - v_interes_aplicado;
    IF v_capital_aplicado > v_capital_pendiente THEN RAISE EXCEPTION 'El abono excede el capital pendiente.'; END IF;
  ELSIF p_prestamo_id IS NOT NULL THEN
    RAISE EXCEPTION 'prestamo_id solo se usa para abono_prestamo.';
  END IF;

  IF p_tipo_movimiento IS NULL OR p_tipo_movimiento NOT IN (
    'ahorro_semanal','abono_prestamo','pago_multa','retiro_caja','gasto','ajuste_ingreso','ajuste_egreso'
  ) THEN RAISE EXCEPTION 'Tipo de movimiento no permitido en esta funcion.'; END IF;
  IF p_monto IS NULL OR p_monto <= 0 OR p_monto <> pg_catalog.round(p_monto,2) THEN
    RAISE EXCEPTION 'El monto debe ser mayor que cero y tener maximo dos decimales.';
  END IF;
  IF p_metodo_pago IS NULL OR p_metodo_pago NOT IN ('efectivo','transferencia') THEN RAISE EXCEPTION 'Metodo de pago invalido.'; END IF;
  IF p_nota IS NOT NULL AND pg_catalog.length(p_nota) > 1000 THEN RAISE EXCEPTION 'La nota no puede exceder 1000 caracteres.'; END IF;

  SELECT c.activo INTO v_activo FROM public.ciclos c
   WHERE c.id = p_ciclo_id AND c.owner_id = v_owner FOR UPDATE;
  IF NOT FOUND OR v_activo IS DISTINCT FROM true THEN RAISE EXCEPTION 'No se encontro un ciclo activo para este propietario.'; END IF;
  PERFORM public.fn_verificar_periodo_abierto(v_owner,p_ciclo_id,p_fecha_operacion);

  IF p_tipo_movimiento IN ('ahorro_semanal','abono_prestamo','pago_multa') AND p_participante_id IS NULL THEN
    RAISE EXCEPTION 'Este movimiento requiere participante_id.';
  END IF;
  IF p_participante_id IS NOT NULL THEN
    SELECT s.* INTO v_participante FROM public.socios_y_clientes s
     WHERE s.id = p_participante_id AND s.owner_id = v_owner FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Participante no encontrado.'; END IF;
    IF v_participante.estatus = 'inactivo' THEN RAISE EXCEPTION 'Un participante inactivo no puede operar.'; END IF;
    IF v_participante.estatus = 'cartera_vencida' AND p_tipo_movimiento NOT IN ('abono_prestamo','pago_multa') THEN
      RAISE EXCEPTION 'Cartera vencida solo permite abonos y pago de multas.';
    END IF;
    IF p_tipo_movimiento = 'ahorro_semanal' AND v_participante.tipo <> 'socio' THEN
      RAISE EXCEPTION 'Los externos no pueden registrar ahorro semanal.';
    END IF;
  END IF;

  INSERT INTO public.transacciones (
    owner_id,ciclo_id,participante_id,prestamo_id,fecha_operacion,tipo_movimiento,
    monto,metodo_pago,capital_aplicado,interes_aplicado,nota,p_id
  ) VALUES (
    v_owner,p_ciclo_id,p_participante_id,p_prestamo_id,p_fecha_operacion,p_tipo_movimiento,
    p_monto,p_metodo_pago,v_capital_aplicado,v_interes_aplicado,p_nota,p_id
  ) ON CONFLICT ON CONSTRAINT uq_transacciones_owner_pid DO NOTHING RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT t.* INTO v_existente FROM public.transacciones t WHERE t.owner_id = v_owner AND t.p_id = p_id;
    IF NOT FOUND OR v_existente.ciclo_id IS DISTINCT FROM p_ciclo_id
       OR v_existente.tipo_movimiento IS DISTINCT FROM p_tipo_movimiento
       OR v_existente.monto IS DISTINCT FROM p_monto
       OR v_existente.metodo_pago IS DISTINCT FROM p_metodo_pago
       OR v_existente.fecha_operacion IS DISTINCT FROM p_fecha_operacion
       OR v_existente.participante_id IS DISTINCT FROM p_participante_id
       OR v_existente.prestamo_id IS DISTINCT FROM p_prestamo_id
       OR v_existente.nota IS DISTINCT FROM p_nota THEN
      RAISE EXCEPTION 'p_id ya fue usado con datos diferentes.';
    END IF;
    RETURN v_existente.id;
  END IF;

  IF p_tipo_movimiento = 'abono_prestamo' THEN PERFORM public.fn_actualizar_estado_prestamo(v_owner,p_prestamo_id); END IF;
  PERFORM public.fn_validar_saldos(v_owner,p_ciclo_id);
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.registrar_transaccion(uuid,text,numeric,text,date,uuid,uuid,text,uuid) IS
  'Registra movimientos con p_id idempotente; al abonar un préstamo incorpora periodos completos de 15 días al 5% simple sobre el capital pendiente.';

REVOKE ALL ON FUNCTION public.crear_prestamo(uuid,uuid,numeric,integer,date,text,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crear_prestamo(uuid,uuid,numeric,integer,date,text,uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION public.registrar_transaccion(uuid,text,numeric,text,date,uuid,uuid,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registrar_transaccion(uuid,text,numeric,text,date,uuid,uuid,text,uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
