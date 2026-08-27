// ─────────────────────────────────────────────────────────────────────────────
// GET    /api/assistant/chats           → mis conversaciones (sólo las MÍAS)
// GET    /api/assistant/chats?id=<uuid> → los mensajes de una conversación mía
// DELETE /api/assistant/chats?id=<uuid> → borrar una conversación mía
//
// ── POR QUÉ EL FILTRO LLEVA user_id ADEMÁS DE company_id ──────────────────
// El chat es privado por diseño: nadie lee la conversación de otro, tampoco el
// admin de la empresa ni el superadmin. La RLS de la migración 101 ya lo
// impone para la sesión del navegador, pero acá se consulta con el admin
// client (service_role), y con service_role la RLS NO aplica. El
// `.eq('user_id', …)` es entonces lo único que separa mi chat del de mi
// compañero de escritorio — igual que el `.eq('company_id', …)` es lo único
// que separa un bróker de otro (§4.2).
//
// Un id ajeno y un id inexistente devuelven exactamente lo mismo: distinguir
// "no existe" de "no es tuyo" ya confirma que el chat existe.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/api-auth';
import { ASSISTANT_ROLES } from '@/lib/roles';
import { createAdminClient } from '@/lib/supabase/admin';
import { apiError } from '@/lib/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Tope de conversaciones listadas. Con aviso de recorte, como manda la casa. */
const MAX_CHATS = 50;
/** Tope de mensajes de una conversación. */
const MAX_MENSAJES = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, {
      roles: ASSISTANT_ROLES,
      modules: ['assistant'],
    });
    if (auth instanceof NextResponse) return auth;

    const db = createAdminClient();
    const id = request.nextUrl.searchParams.get('id');

    if (id) {
      if (!UUID.test(id)) {
        return NextResponse.json({ success: false, error: 'Id inválido.' }, { status: 400 });
      }
      const { data, error } = await db
        .from('ai_chat_messages')
        .select('id, role, content, tool_calls, created_at')
        .eq('chat_id', id)
        .eq('company_id', auth.companyId)
        .eq('user_id', auth.userId)
        .order('created_at', { ascending: true })
        .limit(MAX_MENSAJES + 1);
      if (error) throw error;
      const filas = data ?? [];
      return NextResponse.json({
        success: true,
        messages: filas.slice(0, MAX_MENSAJES),
        truncated: filas.length > MAX_MENSAJES,
      });
    }

    const { data, error } = await db
      .from('ai_chats')
      .select('id, title, created_at, updated_at')
      .eq('company_id', auth.companyId)
      .eq('user_id', auth.userId)
      .order('updated_at', { ascending: false })
      .limit(MAX_CHATS + 1);
    if (error) throw error;
    const filas = data ?? [];
    return NextResponse.json({
      success: true,
      chats: filas.slice(0, MAX_CHATS),
      truncated: filas.length > MAX_CHATS,
    });
  } catch (err) {
    return apiError('assistant/chats GET', err, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, {
      roles: ASSISTANT_ROLES,
      modules: ['assistant'],
    });
    if (auth instanceof NextResponse) return auth;

    const id = request.nextUrl.searchParams.get('id');
    if (!id || !UUID.test(id)) {
      return NextResponse.json({ success: false, error: 'Id inválido.' }, { status: 400 });
    }

    // Los mensajes se van por el ON DELETE CASCADE de la FK.
    const { error } = await createAdminClient()
      .from('ai_chats')
      .delete()
      .eq('id', id)
      .eq('company_id', auth.companyId)
      .eq('user_id', auth.userId);
    if (error) throw error;

    // Sin auditoría a propósito: `serverAuditLog` guarda quién hizo qué sobre
    // qué objeto, y el objeto acá es una conversación privada. Dejar rastro de
    // "Fulano borró el chat X" en un registro que otros leen contradice la
    // privacidad que la tabla entera existe para sostener. Y no hay dinero ni
    // permisos de por medio: nadie pierde nada auditable.
    return NextResponse.json({ success: true });
  } catch (err) {
    return apiError('assistant/chats DELETE', err, { status: 500 });
  }
}
