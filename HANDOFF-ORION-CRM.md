# Especificación — Integración Orion CRM ↔ Smart Dashboard

Contrato de API que necesitamos que Orion CRM exponga para alimentar las 4 secciones de reportes del dashboard que dependen del CRM.

---

## 0. Lo básico

### Autenticación
Una sola **API key por empresa (tenant)**, enviada como:

```
Authorization: Bearer <API_KEY>
Content-Type: application/json
Accept: application/json
```

No OAuth, no refresh tokens. La key es el bearer.

### Base URL
Cada empresa puede apuntar a su propia instancia. Nosotros guardamos `base_url` por tenant. Ejemplo de configuración:

```
base_url:  https://api.orion-crm.example.com
api_key:   ok_live_xxxxxxxxxxxxxxxxxxxxxxxx
```

### Convenciones
- Todos los endpoints son **POST JSON** con body `{ "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }`.
- Fechas en UTC, formato ISO corto (día completo de `from` 00:00 UTC hasta día completo de `to` 23:59 UTC).
- Responses: JSON. `200 OK` en éxito, `4xx/5xx` con `{ "error": "mensaje" }` en fallo.
- Timeouts: nuestro cliente aborta a los **12 segundos**. Si tu endpoint tarda más, mejor respondé rápido con datos parciales o cacheados.

### Endpoint de health (opcional pero recomendado)
```
GET /v1/ping      → 200 { "ok": true, "version": "..." }
```
Usamos esto para el botón "Probar conexión" en superadmin.

---

## 1. Endpoints requeridos

### 1.1 `POST /v1/users/summary` — Usuarios CRM

Alimenta la sección "Usuarios CRM" del reporte.

**Request:**
```json
{ "from": "2026-04-01", "to": "2026-04-22" }
```

**Response:**
```json
{
  "new_users_in_range":    85,
  "new_users_this_month": 120,
  "total_users":         3420
}
```

| Campo | Tipo | Qué significa |
|---|---|---|
| `new_users_in_range` | int | Usuarios que se registraron entre `from` y `to` inclusive |
| `new_users_this_month` | int | Usuarios que se registraron durante el mes calendario que contiene a `from` (el cliente siempre manda rangos dentro de un mismo mes o más cortos) |
| `total_users` | int | Headcount total actual de la plataforma (snapshot "ahora") |

---

### 1.2 `POST /v1/broker-pnl` — Broker P&L

Alimenta la sección "Broker P&L" del reporte.

**Request:**
```json
{ "from": "2026-04-01", "to": "2026-04-22" }
```

**Response:**
```json
{
  "pnl_range":       12450.75,
  "pnl_month":       28310.20,
  "pnl_prev_month": -4200.00
}
```

| Campo | Tipo | Qué significa |
|---|---|---|
| `pnl_range` | number (USD) | P&L acumulado en `[from, to]`. **Puede ser negativo** (pérdida) |
| `pnl_month` | number | P&L del mes calendario en curso (el que contiene `from`), running |
| `pnl_prev_month` | number | P&L final del mes calendario anterior |

Con esos 3 números el dashboard calcula automáticamente "% vs mes anterior" y "% del rango sobre el mes". No hace falta que Orion calcule variaciones.

---

### 1.3 `POST /v1/prop-trading` — Prop Trading Firm

Alimenta la sección "Prop Trading Firm" del reporte.

**Request:**
```json
{ "from": "2026-04-01", "to": "2026-04-22" }
```

**Response:**
```json
{
  "products": [
    { "name": "Challenge $10K",  "quantity": 18, "amount":  1602.00 },
    { "name": "Challenge $25K",  "quantity":  7, "amount":  1050.00 },
    { "name": "Challenge $50K",  "quantity":  3, "amount":   750.00 },
    { "name": "Challenge $100K", "quantity":  2, "amount":   900.00 }
  ],
  "total_sales_range":          4302.00,
  "total_sales_month":         14500.00,
  "prop_withdrawals_range":    1250.00,
  "prop_withdrawals_count_range": 4,
  "pnl_range":                 3052.00,
  "pnl_month":                 9800.00,
  "pnl_prev_month":            7400.00
}
```

| Campo | Tipo | Qué significa |
|---|---|---|
| `products[]` | array | Productos vendidos **en el rango**. Cada item: `{ name, quantity, amount }` donde `amount` = precio × cantidad en USD |
| `total_sales_range` | number | Suma de `amount` de todos los productos del rango |
| `total_sales_month` | number | Suma de ventas del mes calendario en curso |
| `prop_withdrawals_range` | number | Monto total retirado por traders fondeados en el rango |
| `prop_withdrawals_count_range` | int | Cantidad de retiros |
| `pnl_range` | number | `total_sales_range − prop_withdrawals_range` (podés mandar ya calculado) |
| `pnl_month` | number | Lo mismo pero para el mes |
| `pnl_prev_month` | number | Idem mes anterior |

---

### 1.4 `POST /v1/totals` — Totales agregados (Movimientos)

Alimenta la sección de Movimientos/Depósitos del dashboard — cuando una empresa usa Orion CRM como fuente de prop firm sales y P2P.

**Request:**
```json
{ "from": "2026-04-01", "to": "2026-04-22" }
```

**Response:**
```json
{
  "propFirmSales":  4302.00,
  "p2pTransfer":   28500.00,
  "lastSync":     "2026-04-22T18:00:00.000Z"
}
```

| Campo | Tipo | Qué significa |
|---|---|---|
| `propFirmSales` | number | Monto total de ventas de prop firm en el rango (overlap con `total_sales_range` del 1.3 — podés devolver el mismo valor) |
| `p2pTransfer` | number | Monto total de transferencias P2P (retiros) en el rango |
| `lastSync` | ISO 8601 | Timestamp del último dato sincronizado en el CRM (para que el dashboard muestre "actualizado hace X minutos") |

---

## 2. Errores

Ante cualquier error devolver status `4xx` / `5xx` con body:

```json
{ "error": "Mensaje legible en español o inglés" }
```

El dashboard maneja fallos con `Promise.allSettled` — si un endpoint falla, los otros siguen y el reporte marca esa sección como "no disponible" sin tumbar el resto.

---

## 3. Qué configuramos nosotros en el dashboard

Una vez que Orion nos dé `base_url` + `api_key` por empresa, el admin de cada empresa lo carga en:

**Superadmin → Empresa → APIs externas → Orion CRM**
- API key (se guarda cifrada con AES-256-GCM)
- Base URL (ej. `https://api.orion-crm.example.com`)

Del lado del dashboard todo ya está implementado y testeado contra mocks. Cuando Orion publique los endpoints reales, solo hay que:
1. Pegarle las credenciales por cada empresa
2. Apretar "Probar conexión" para validar
3. Los reportes automáticos (diario / semanal / mensual) ya los van a consumir

---

## 4. Consideraciones

### Zonas horarias
Nuestros rangos siempre llegan como **fechas UTC**. Si internamente Orion maneja hora local del trader, convertir a UTC antes de filtrar.

### Idempotencia
Los endpoints son solo de lectura (GET semántico en forma POST). Deben ser **idempotentes** y **cacheables**. Mismo `{from, to}` → mismo resultado (salvo que haya nuevos datos reales).

### Performance
- Rangos típicos: 1 día (reporte diario) o 7 días (semanal) o 1 mes (mensual).
- El dashboard puede hacer hasta **4 llamadas en paralelo** por cada generación de reporte (`/users/summary` + `/broker-pnl` + `/prop-trading` + `/totals`).
- Los crons corren a las 00:05 UTC. Si hay muchos tenants, se llaman en secuencia tenant-por-tenant.

### Volumen esperado
- **Manual**: 1-3 llamadas/día por empresa (cuando un admin abre el reporte).
- **Automático (cron)**: hasta 4 llamadas × 3 cadencias × N empresas. Con ~10 empresas: ~120 requests/día totales por endpoint.

### Seguridad
- API keys por tenant (no shared). Si una empresa rota su key, no afecta a las otras.
- HTTPS obligatorio.
- Ideal: rate-limit por API key (ej. 60 req/min) con `429 Too Many Requests` cuando se excede.

---

## 5. Checklist para el equipo de Orion

- [ ] `POST /v1/users/summary` con el shape de arriba
- [ ] `POST /v1/broker-pnl` con el shape de arriba
- [ ] `POST /v1/prop-trading` con el shape de arriba
- [ ] `POST /v1/totals` con el shape de arriba
- [ ] `GET /v1/ping` (health check, opcional pero muy útil)
- [ ] Autenticación por `Authorization: Bearer <key>`
- [ ] Una API key por empresa (VexPro, AP Markets, Exura, VONIX, etc.)
- [ ] Base URL accesible desde internet con HTTPS
- [ ] Timeouts < 12s por request
- [ ] Manejo de errores con body `{ "error": "..." }`
- [ ] Documentación / Postman collection que podamos pegar en el dashboard cuando pruebes la conexión

---

## 6. Ejemplo end-to-end

Admin de VexPro abre `/finanzas/reportes` a las 10:00 AM y selecciona "Últimos 7 días":

```
→ POST https://api.orion-crm.example.com/v1/users/summary
   Authorization: Bearer ok_live_abc123...
   Body: { "from": "2026-04-16", "to": "2026-04-22" }

← 200 OK
  { "new_users_in_range": 62, "new_users_this_month": 180, "total_users": 3420 }
```

(y 3 llamadas más en paralelo a los otros endpoints)

El reporte se renderiza en la página y queda disponible para PDF / email. Los crons automáticos de 00:05 UTC hacen exactamente lo mismo, sin intervención humana.

---

**Contacto del lado dashboard:** Kevin — equipo Horizon Consulting. Cualquier duda sobre el contrato, shape de datos, o autenticación, me escribís directo.
