'use client';

import { useAuth } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { useI18n } from '@/lib/i18n';
import { PageHeader } from '@/components/ui/page-header';
import { QuickAccess } from './quick-access';

// ─────────────────────────────────────────────────────────────────────────────
// TeamMemberHome — most restricted view.
//
// No financial numbers. No audit feed. Only module shortcuts the member can
// reach. Aimed at roles like `invitado` / external team-members who still
// need dashboard access but shouldn't see company KPIs.
//
// 2026-10-12 («Libro mayor»): cabecera con PageHeader (h1 22/650) y textos en
// i18n — eran castellano fijo («Hola», «Bienvenido», «Tus accesos»).
// ─────────────────────────────────────────────────────────────────────────────

export function TeamMemberHome() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { company } = useData();

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('home.greeting', { name: user?.name?.split(' ')[0] ?? '' })}
        subtitle={company?.name ? t('home.welcomeTo', { company: company.name }) : t('home.welcome')}
      />
      <QuickAccess heading={t('home.yourAccess')} />
    </div>
  );
}
