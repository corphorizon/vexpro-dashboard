'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Info } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { AuthBrand } from '@/components/auth-brand';
import {
  ATLAS_HOST,
  ATLAS_URL,
  dismissAtlasNotice,
  isAtlasNoticeDismissed,
} from '@/lib/atlas-migration';
import { ARCHIVE_CUTOFF_DATE, archiveNoticeVisible } from '@/lib/archive-mode';

/** Sin empresa activa (superadmin en el panel) el «ya lo vi» va a esta llave. */
const NO_COMPANY_KEY = 'sin-empresa';

// ─────────────────────────────────────────────────────────────────────────────
// «Smart Dashboard está archivado» — banner fijo + modal al entrar.
//
// MODO ARCHIVO (2026-10-20, src/lib/archive-mode.ts): el aviso lo ven TODAS
// las empresas, incluidas Exura Prime y Exura Liquidez, y también el
// superadmin sin empresa activa. El texto lleva la fecha de corte. Lo de
// abajo describe el criterio anterior (sólo las 6 migradas), que vuelve a
// regir si alguna vez se apaga el modo archivo.
//
// «Nos mudamos a Atlas» — banner fijo + modal al entrar (2026-10-20).
//
// Decide por la empresa ACTIVA (`useData().company`): para un usuario normal
// es su empresa; para un superadmin, la que eligió en «Viendo como». Así quien
// ve varias empresas recibe el aviso sólo cuando mira una migrada. La lista y
// el porqué viven en src/lib/atlas-migration.ts (Exura Prime y Exura Liquidez
// no están ahí: no ven nada).
//
// · Banner: no se puede cerrar. Mientras la empresa siga migrada, el aviso es
//   tan cierto como la primera vez (mismo criterio que TruncatedDataBanner).
// · Modal: «Seguir aquí» lo oculta sólo durante la sesión (sessionStorage, se
//   borra al cerrar sesión). «Ir a Atlas» abre una pestaña nueva y también lo
//   cierra: quien vuelve a esta pestaña ya sabe adónde ir.
// ─────────────────────────────────────────────────────────────────────────────

/** Banner fijo arriba, dentro del contenedor sticky de la topbar. */
export function AtlasMigrationBanner() {
  const { company } = useData();
  if (!archiveNoticeVisible(company?.id)) return null;
  return <AtlasMigrationBannerView />;
}

/** Sólo la vista (sin contextos): la usa el banner y la muestra de diseño. */
export function AtlasMigrationBannerView() {
  const { t } = useI18n();
  return (
    <div
      role="status"
      data-testid="atlas-migration-banner"
      className="flex items-center justify-between gap-3 border-b border-info/35 bg-info-bg px-4 py-2 text-[13px] leading-5 text-foreground"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Info aria-hidden className="size-4 shrink-0 text-info" strokeWidth={2} />
        <span className="min-w-0">
          {t('atlasMigration.banner', { date: ARCHIVE_CUTOFF_DATE })}{' '}
          <a
            href={ATLAS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold underline underline-offset-2 hover:no-underline"
          >
            {ATLAS_HOST}
          </a>
        </span>
      </div>
      <a
        href={ATLAS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="hidden shrink-0 items-center gap-1 rounded-md border border-info/40 bg-card px-2.5 py-1 text-xs font-semibold hover:border-info sm:inline-flex"
      >
        {t('atlasMigration.goToAtlas')}
        <ArrowUpRight aria-hidden className="size-3.5" />
      </a>
    </div>
  );
}

/** Modal al iniciar sesión (y al entrar a una empresa migrada). */
export function AtlasMigrationModal() {
  const { user } = useAuth();
  const { company } = useData();
  const [open, setOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const userId = user?.id ?? null;
  const rawCompanyId = company?.id ?? null;
  // En modo archivo el aviso también sale sin empresa activa; la llave del
  // «ya lo vi» necesita algo estable.
  const companyId = rawCompanyId ?? NO_COMPANY_KEY;

  // sessionStorage sólo existe en el navegador: se decide en un effect para
  // no romper la hidratación.
  useEffect(() => {
    if (!userId || !archiveNoticeVisible(rawCompanyId)) {
      setOpen(false);
      return;
    }
    setOpen(!isAtlasNoticeDismissed(userId, companyId));
  }, [userId, companyId, rawCompanyId]);

  const close = () => {
    if (userId) dismissAtlasNotice(userId, companyId);
    setOpen(false);
  };

  // ESC = «Seguir aquí» + foco atrapado dentro del diálogo.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Tab' && cardRef.current) {
        const f = cardRef.current.querySelectorAll<HTMLElement>('button, [href]');
        if (f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
    // close depende sólo de userId/companyId, que ya disparan `open`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  return (
    <AtlasMigrationDialogView
      cardRef={cardRef}
      onStay={close}
      onGo={() => {
        window.open(ATLAS_URL, '_blank', 'noopener,noreferrer');
        close();
      }}
    />
  );
}

/** Sólo la vista del diálogo (sin contextos ni storage). */
export function AtlasMigrationDialogView({
  cardRef,
  onStay,
  onGo,
}: {
  cardRef?: React.Ref<HTMLDivElement>;
  onStay: () => void;
  onGo: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="atlas-migration-title"
      aria-describedby="atlas-migration-body"
      data-testid="atlas-migration-modal"
    >
      <div
        ref={cardRef}
        className="vex-pop-in w-full max-w-md overflow-hidden rounded-xl bg-card shadow-[var(--elevation-3)]"
      >
        <div className="flex items-center justify-center border-b border-border bg-surface-2/60 px-6 py-4">
          <AuthBrand className="size-20" />
        </div>
        <div className="p-6">
          <h2 id="atlas-migration-title" className="mb-2 text-lg font-semibold">
            {t('atlasMigration.title')}
          </h2>
          <p id="atlas-migration-body" className="mb-6 text-sm leading-6 text-text-2">
            {t('atlasMigration.body1', { date: ARCHIVE_CUTOFF_DATE })}{' '}
            <a
              href={ATLAS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-foreground underline underline-offset-2 hover:no-underline"
            >
              {ATLAS_HOST}
            </a>
            . {t('atlasMigration.body2')}
          </p>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button onClick={onStay}>{t('atlasMigration.stayHere')}</Button>
            <Button variant="primary" autoFocus onClick={onGo}>
              {t('atlasMigration.goToAtlas')}
              <ArrowUpRight aria-hidden className="size-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
