'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /comisiones — piezas de presentación compartidas por las tablas («Libro
// mayor»). Sin estado propio y sin handlers propios: todo lo que cambia un
// número llega por props desde page.tsx.
//
// POR QUÉ (2026-10-12): la receta del input de una celda
// (`w-28 px-2 py-1 … focus:ring-2 focus:ring-[var(--color-secondary)]`)
// estaba copiada 9 veces en page.tsx, el rótulo de procedencia del ND usaba
// `text-[10px]` y verde para «CRM», y cada tabla repetía nombre + GLOBAL +
// despedido + email. Acá:
//   · el input es el `Input` del sistema en tamaño compacto (32 px, spec
//     §5.6), con el foco global — ninguna receta de foco propia;
//   · la procedencia usa la etiqueta de fuente de Movimientos (`SourceTag`:
//     CRM = `info`, el resto neutro) — sin ámbar para «manual», que no es
//     algo que alguien tenga que resolver (spec §2.1);
//   · rol, GLOBAL, Master IB y «Especial» son etiquetas NEUTRAS: no
//     significan dinero ni estado. El violeta/púrpura/ámbar de antes era color
//     sin significado.
//
// DESCARTADO:
//   · El ámbar de «Master IB» (dueño, 2026-09-06: «el mismo ámbar de Fuerza
//     Comercial»): en el sistema nuevo ámbar = `pend` = «requiere acción», y un
//     master no requiere nada. Se distingue por el texto de la etiqueta.
//   · Ancho del input por `className` (`w-28`): `Input` trae `w-full` y `cn`
//     es clsx sin tailwind-merge; el ancho lo da un contenedor.
//   · Promover `SourceTag` a src/components/ui: lo usan Movimientos y ahora
//     Comisiones; moverlo toca dos pantallas ajenas a esta tanda. Queda
//     importado desde movimientos/ (una sola copia) y anotado en el reporte.
// ─────────────────────────────────────────────────────────────────────────────

import { FileText, Loader2, Save, Search, X } from 'lucide-react';
import { Input } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import { FiredBadge, firedNameClass } from '@/components/fired-badge';
import type { CommercialProfile } from '@/lib/types';
import type { NetDepositSource } from '@/lib/hr/net-deposit-input';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { SourceTag } from '../movimientos/source-tag';
import { isPctManual, ndSourceTag, roleLabel } from './commission-view';

/** Etiqueta neutra (rol, GLOBAL, Especial…): el mismo dibujo que la fuente «Manual». */
export function PlainTag({ label, title }: { label: string; title?: string }) {
  return (
    <span title={title} className="inline-flex">
      <SourceTag kind="manual" label={label} />
    </span>
  );
}

/** Nombre de la persona + etiquetas a su lado (GLOBAL, Especial, despedido). */
export function PersonName({
  profile,
  tags,
}: {
  profile: CommercialProfile;
  tags?: React.ReactNode;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className={cn('truncate', firedNameClass(profile))}>{profile.name}</span>
      {tags}
      <FiredBadge profile={profile} />
    </span>
  );
}

/** Metadato bajo el nombre: «HEAD · ana@…». Un Master IB se rotula como tal, no como BDM. */
export function personMeta(profile: CommercialProfile, masterLabel: string): string {
  const role = profile.is_master_ib ? masterLabel : roleLabel(profile.role);
  return profile.email ? `${role} · ${profile.email}` : role;
}

/** Procedencia del insumo (CRM / manual / cerrado / sin datos). */
export function NdSourceTag({ source }: { source: NetDepositSource }) {
  const { t } = useI18n();
  const spec = ndSourceTag(source);
  if (spec.kind === 'none') {
    return <span className="whitespace-nowrap text-[12px] text-text-3">{t(spec.labelKey)}</span>;
  }
  return (
    <span className="inline-flex" title={spec.kind === 'manual' && spec.showAuto ? t('comm.ndOverrideHint') : undefined}>
      <SourceTag kind={spec.kind} label={t(spec.labelKey)} />
    </span>
  );
}

/**
 * Celda editable de un insumo (net deposit, PnL o lotes): etiqueta de
 * procedencia + input compacto a la derecha y, si el valor es un override,
 * el automático debajo («quien corrige a mano ve contra qué corrige»).
 */
export function NdInputCell({
  value,
  onChange,
  source,
  auto,
  ariaLabel,
  width = 'w-28',
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  source: NetDepositSource;
  /** El automático del mes. `null` = no hay (no se muestra un $0). */
  auto: number | null;
  ariaLabel: string;
  width?: 'w-28' | 'w-24';
  /** Contexto extra bajo el input (red del CRM, sin dato CRM). */
  children?: React.ReactNode;
}) {
  const { t } = useI18n();
  const spec = ndSourceTag(source);
  return (
    <div className="flex flex-col items-end gap-0.5 py-0.5">
      <div className="flex items-center justify-end gap-1.5">
        <NdSourceTag source={source} />
        <span className={cn('block shrink-0', width)}>
          <Input
            compact
            type="number"
            inputMode="decimal"
            aria-label={ariaLabel}
            placeholder={t('comm.ndPlaceholder')}
            title={t('comm.ndOverrideHint')}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={(e) => e.target.select()}
            className="text-right tabular-nums"
          />
        </span>
      </div>
      {spec.showAuto && auto !== null && (
        <span className="whitespace-nowrap text-[12px] leading-4 text-text-3">
          {t('comm.ndAutoRef')} <Money value={auto} />
        </span>
      )}
      {children}
    </div>
  );
}

/**
 * El % manual del mes de una fila de NET DEPOSIT. Vacío = automático (el
 * placeholder lo muestra); un 0 tecleado es un 0 de verdad (§1.3). En período
 * cerrado no se edita.
 */
export function PctOverrideInput({
  value,
  auto,
  disabled,
  onChange,
}: {
  value: string;
  auto: number;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const { t } = useI18n();
  const manual = isPctManual(value);
  return (
    <span className="inline-flex items-center gap-1">
      <span className="block w-16 shrink-0">
        <Input
          compact
          type="number"
          step="0.01"
          inputMode="decimal"
          aria-label={t('comm.pctOverrideAria')}
          title={t('comm.pctOverrideHint')}
          placeholder={String(auto)}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onFocus={(e) => e.target.select()}
          className={cn('text-right tabular-nums', manual && 'font-semibold')}
          data-manual={manual || undefined}
        />
      </span>
      <span className="text-[12px] text-text-3">%</span>
      {manual && <SourceTag kind="manual" label={t('comm.ndSourceManual')} />}
    </span>
  );
}

/** Contexto del PnL del CRM bajo el input: tamaño de la red, o que no hay cruce. */
export function PnlCrmHint({ info }: { info: { usuariosRed: number | null; sinDatoCrm: boolean } | undefined }) {
  const { t } = useI18n();
  if (!info) return null;
  if (info.sinDatoCrm) {
    // `pend`: falta un cruce con el CRM — alguien tiene que crear el usuario.
    return (
      <span className="whitespace-nowrap text-[12px] leading-4 text-pend" title={t('comm.pnlNoCrmData')}>
        {t('comm.pnlNoCrmDataShort')}
      </span>
    );
  }
  if (info.usuariosRed === null) return null;
  return (
    <span className="whitespace-nowrap text-[12px] leading-4 text-text-3">
      {t('comm.pnlNetworkUsers', { n: info.usuariosRed.toLocaleString('es-AR') })}
    </span>
  );
}

/**
 * Deuda arrastrada de una fila (el `bonus` negativo del mes anterior). Sin
 * deuda no se muestra un $0 — «sin deuda» no es un monto, y la columna quedaría
 * llena de ceros que esconden los pocos que importan.
 */
export function DebtCell({ prevDebt }: { prevDebt: number }) {
  const { t } = useI18n();
  if (prevDebt < 0) return <Money value={prevDebt} signed className="font-medium" />;
  return (
    <span className="text-text-3" title={t('comm.prevDebtNone')}>
      <span aria-hidden>—</span>
      <span className="sr-only">{t('comm.prevDebtNone')}</span>
    </span>
  );
}

/** «$1,200.00 − $300.00 lotes»: de dónde sale un pago real con lotes restados. */
export function LotsBreakdown({ base, lots }: { base: number; lots: number }) {
  const { t } = useI18n();
  return (
    <span className="whitespace-nowrap text-[12px] leading-4 text-text-3">
      <Money value={base} /> − <Money value={lots} /> {t('comm.lotsWord')}
    </span>
  );
}

const ICON_BTN =
  'inline-flex size-8 items-center justify-center rounded-ui-md text-text-2 hover:bg-surface-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-50 [@media(pointer:coarse)]:size-10';

/** Guardar la fila + PDF individual. Los handlers vienen de page.tsx tal cual. */
export function RowActionButtons({
  saving,
  onSave,
  onPdf,
}: {
  saving: boolean;
  onSave: () => void;
  onPdf: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <button
        type="button"
        onClick={onSave}
        disabled={saving}
        aria-label={t('comm.saveBdm')}
        title={t('comm.saveBdm')}
        className={ICON_BTN}
      >
        {saving ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Save aria-hidden className="size-4" />}
      </button>
      <button type="button" onClick={onPdf} aria-label={t('comm.downloadPdf')} title={t('comm.downloadPdf')} className={ICON_BTN}>
        <FileText aria-hidden className="size-4" />
      </button>
    </>
  );
}

/** Buscador libre de cada pestaña: filtra filas, nunca totales. */
export function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="relative flex w-full min-w-[220px] max-w-[320px] items-center max-sm:max-w-none">
      <Search aria-hidden className="pointer-events-none absolute left-2.5 size-[15px] text-text-3" />
      <Input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('comm.searchPlaceholder')}
        aria-label={t('comm.searchPlaceholder')}
        className="pl-8 pr-8"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="absolute right-1.5 inline-flex size-6 items-center justify-center rounded-ui-sm text-text-3 hover:text-foreground"
          aria-label={t('comm.clearSearch')}
        >
          <X aria-hidden className="size-3.5" />
        </button>
      )}
    </div>
  );
}
