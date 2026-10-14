# willfolks-BE

API mínima de WillFolks (NestJS 12 + TypeORM + PostgreSQL) para que la app Expo funcione de
punta a punta y se puedan hacer pruebas e2e de navegación y llenado de datos.

## Arranque

```bash
(cd ../willfolks-database && docker compose up --detach --wait)   # la base
cp .env.example .env
npm install
npm run start:dev          # http://127.0.0.1:3000 · Swagger en /docs
npm run test:e2e           # 29 pruebas contra la base local
```

La app en el emulador de Android llega a la API por `http://10.0.2.2:3000` (ya es su valor por
defecto). En un teléfono por USB: `adb reverse tcp:3000 tcp:3000` y `EXPO_PUBLIC_API_URL=http://localhost:3000`.
En un teléfono por Wi-Fi: `HOST=0.0.0.0` aquí y la IP de tu máquina en `EXPO_PUBLIC_API_URL`.

## Qué es real y qué está simulado

| Área | Estado |
| --- | --- |
| Usuarios, perfil, ajustes, amigos, metas, controles, evidencias, buzón, mascota, uso de apps, dispositivos | Real, persistido en Postgres. |
| Reglas de negocio (saldo suficiente, intentos, penalización, reparto `vs`, cierre por fecha) | Reales, en `GoalsService`, dentro de transacciones. |
| **Login** | Simulado: `POST /auth/login` entra con solo un correo (`AUTH_DEV_LOGIN=true`). Sustituye a OAuth; **no exponer fuera de tu máquina**. |
| **Depósitos, retiros y custodia** | Simulados: se confirman al instante y el `txHash` es aleatorio. No hay cadena ni procesador de pagos. |
| **Juez IA** | Simulado: con `AI_VERIFIER_MODE=auto-approve` toda evidencia con foto se aprueba. Con `manual` queda pendiente y su autor la resuelve con `PATCH /proofs/:id` (para probar rechazos). El juez amigo sí es real. |
| Confianza en el teléfono | Los controles de alarma, uso y "no llegué" los reporta el dispositivo y el servidor los cree. La ubicación (distancia al punto) y el límite de minutos sí los decide el servidor. |

## Endpoints

Todos requieren `Authorization: Bearer <token>` salvo `/health` y `/auth/login`.

| Recurso | Rutas |
| --- | --- |
| Salud | `GET /health` |
| Sesión | `POST /auth/login` |
| Usuario | `GET/PATCH/DELETE /users/me` · `POST /users/me/avatar` · `GET/PUT /users/me/settings` · `GET /users/search?q=` |
| Dispositivo | `GET/PUT /devices` |
| Amigos | `GET/POST /friends` · `PATCH/DELETE /friends/:id` |
| Metas | `GET/POST /goals` · `GET/PATCH/DELETE /goals/:id` · `PATCH /goals/:id/invitation` |
| Controles | `GET/POST /goals/:id/checkins` |
| Evidencias | `GET/POST /goals/:id/proofs` · `GET /proofs/reviews` · `PATCH /proofs/:id` |
| Billetera | `GET /wallet` · `GET /wallet/transactions[/:id]` · `POST /wallet/deposits` · `POST /wallet/withdrawals` |
| Buzón | `GET /notifications` · `PATCH /notifications/:id/read` · `POST /notifications/read-all` · `DELETE /notifications/:id` |
| Mascota | `GET/PATCH /pet` · `POST /pet/actions` |
| Uso de apps | `GET/PUT /usage` |
| Inicio | `GET /dashboard` (saldo, mascota, sin leer, metas activas y actividad reciente) |

Los errores de negocio llevan un `code` estable que la app traduce: `INSUFFICIENT_FUNDS`,
`USERNAME_TAKEN`, `TOO_FAR`, `NOT_FRIENDS`, `GOAL_NOT_ACTIVE`, `GOAL_CLOSED`, `ALREADY_RESOLVED`.

### Reglas de una meta

- Crear una meta bloquea la apuesta (`stake_lock`); sin saldo responde `400 INSUFFICIENT_FUNDS`.
- Un control por meta, usuario y día. Repetirlo devuelve el guardado; solo el uso de una app
  puede empeorar de superado a fallado durante el mismo día.
- Al llegar a `maxAttempts` fallos el participante pierde su apuesta (`penalty`, más `donation`
  si hay propina). En modo `vs` el monto va como `reward` a los rivales. Si quien pierde es el
  dueño, la meta pasa a `failed` y los demás recuperan lo suyo.
- Cancelar (`DELETE`) o superar `endDate` libera las apuestas que sigan en custodia. El cierre
  por fecha se hace de forma perezosa al listar metas o pedir el dashboard: no hay cron.

## Estructura

```
src/
  main.ts · setup.ts · app.module.ts · env.ts
  common/        guard JWT, utilidades de base, subida de imágenes, serializadores
  entities/      entidades TypeORM sobre el esquema de willfolks-database (synchronize: false)
  auth/ users/ friends/ goals/ wallet/ notifications/ pet/ usage/ devices/ dashboard/
test/app.e2e-spec.ts
uploads/         avatares y evidencias (públicos por URL, nombres aleatorios; fuera de git)
```

El esquema vive en `willfolks-database/sql`; la API nunca lo modifica. Si cambias una tabla,
actualiza la entidad a mano.

## Pendiente conocido

- OAuth real (Google) y derivación de la billetera, relayer y contrato de custodia, pagos fiat.
- Verificación con Gemini/ADK en lugar del juez simulado.
- Notificaciones push (hoy la app consulta el buzón y programa recordatorios locales).
- Migraciones, límites de peticiones y limpieza de archivos subidos huérfanos.
- Las pruebas corren el código con el transformador de Vitest, no con el build de `nest build`;
  una diferencia entre ambos (campos de clase sin inicializar) ya ocultó un bug una vez.


## Escrow on-chain (fase 1, Monad testnet)

Con `CHAIN_ENABLED=true` el backend deja de simular el stake: el usuario lo bloquea en el contrato
`WillFolksEscrow` con la wallet de su teléfono y el backend actúa como **atestador** y como
**relayer**. Con `CHAIN_ENABLED=false` (el valor por defecto) todo sigue simulado.

### Flujo

| Paso | Quién | Cómo |
| --- | --- | --- |
| Vincular wallet | App | Firma `WillFolks wallet link\nuser:<id>`; `POST /chain/wallet` verifica la firma. El login **no** puede fijar la wallet. |
| Fondos de prueba | Backend | `POST /chain/faucet` envía USDC y gas desde la tesorería, una vez cada 24 h. |
| Crear meta | App + backend | `POST /goals` deja un borrador con `escrowParams`; la app firma `approve` y `createGoal`; `POST /goals/:id/escrow {txHash}` verifica el recibo contra lo preparado. |
| Controles | App → backend | Igual que antes (alarma, uso, ubicación, evidencia). |
| Veredicto | Backend | Al terminar la meta (o al agotar intentos) firma un veredicto EIP-712 y envía `resolve`. |
| Devolución | Backend | `claim` al terminar el bloqueo; `reclaim` si nadie resolvió dentro del plazo de gracia. |
| Cancelar | App + backend | Antes de empezar, la wallet llama `cancel`; `POST /goals/:id/escrow/cancel {txHash}` lo confirma. |

El backend nunca mueve el stake: el contrato solo lo devuelve a su creador. Lo que el backend
puede decidir es el veredicto, y por eso `resolve` solo acepta firmas de atestadores autorizados.

### Variables

| Variable | Qué es |
| --- | --- |
| `CHAIN_ENABLED`, `CHAIN_NAME`, `CHAIN_ID`, `CHAIN_RPC_URL`, `CHAIN_EXPLORER_URL` | Red |
| `USDC_ADDRESS`, `ESCROW_ADDRESS` | Token y contrato (ver `willfolks-smartcontracts/deployments/`) |
| `ATTESTOR_PRIVATE_KEY` | Firma los veredictos; su dirección debe estar en el contrato |
| `TREASURY_PRIVATE_KEY` | Paga el gas de `resolve`/`claim`/`reclaim` y entrega el faucet |
| `FAUCET_USDC`, `FAUCET_GAS_MON`, `FAUCET_COOLDOWN_HOURS` | Faucet de prueba |
| `CHAIN_GOAL_SECONDS` | Si es mayor que 0, las metas duran N segundos (más 2 minutos) en vez de llegar a `endDate`: para demos |
| `CHAIN_SWEEP_MS` | Período del barrendero de liquidación |

Las llaves viven solo en `.env` (ignorado por git). Son de testnet: no reutilizar en mainnet.

### Pruebas

```bash
npm run test:e2e      # 29 pruebas sobre Postgres con el libro simulado
npm run test:chain    # 13 pruebas con Anvil: despliega, firma con llaves de usuario, viaja en el tiempo
API_URL=http://127.0.0.1:3000 node scripts/monad-smoke.mjs   # ciclo completo en la red real (≈ 6 min)
```

`test:chain` necesita `anvil` y `forge` y el repo `../willfolks-smartcontracts`.

### Qué hay que saber

- La hora que manda es la de la cadena: ventanas de meta y caducidad de firmas usan
  `block.timestamp`, no el reloj del servidor.
- Los RPC públicos balancean carga entre nodos; las escrituras reintentan y la app espera a ver
  el `allowance` antes de llamar a `createGoal`.
- Monad cobra el límite de gas, no el gas usado: cada usuario necesita ≈ 0,05 MON por meta.
- Metas compartidas, propina al desarrollador y rendimiento quedan fuera hasta que el contrato
  los soporte (`GROUP_NOT_SUPPORTED`).
- El juez de IA sigue siendo un stub (`AI_VERIFIER_MODE=auto-approve`) y el servidor confía en lo
  que el teléfono reporta de alarma y uso de apps. El atestador es una sola llave: es la fase 1.

## TilcAI (tilcai-sdk)

Con `TILCAI_ENABLED=true` el backend usa [`tilcai-sdk`](https://www.npmjs.com/package/tilcai-sdk) ([código](https://github.com/TilcAI/tilcai-sdk)) para cuatro cosas. Cada una se
enciende sola cuando tiene su credencial y se apaga con su variable (ver `.env.example`); con
`TILCAI_ENABLED=false` nada de esto corre y el backend se comporta como antes.

| Capacidad | Qué cambia | Quién firma |
| --- | --- | --- |
| **Faucet y depósitos fiat** | El USDC sale del vault de TilcAI en Monad (`sdk.vault.disburse`), no de la tesorería. El depósito fiat sigue simulando el cobro por QR, pero el USDC que llega a la wallet es real y trae su `txHash`. | El relayer de TilcAI envía `disburse`; el contrato limita topes y paga cada `reference` una vez. |
| **Validación del escrow** | `resolve`, `claim` y `reclaim` los envía el relayer de TilcAI (`EvmRelayer`), que paga el gas. | El veredicto EIP-712 lo sigue firmando **este backend** con `ATTESTOR_PRIVATE_KEY`; el contrato solo acepta atestadores autorizados, así que quién envía la transacción no importa. |
| **Juez de IA por x402** | Con `TILCAI_AI_JUDGE=true`, `POST /judge/verify` queda detrás de un `Paywall` (0.01 USDC en Monad, liquidado por el facilitador de TilcAI) y el backend compra cada veredicto desde la tesorería con `x402Fetch`. El modelo sigue siendo un stub; lo que sí es real es el cobro. Si el juez no responde, la prueba queda pendiente (nunca se pierde un stake por un pago fallido). | La tesorería firma la autorización EIP-3009 del pago. |
| **Cuenta inteligente** | `POST /chain/account` emite una SCA en Monad con la passkey P-256 que la app genera y guarda en el teléfono (`sdk.accounts`); `GET /chain/account` la consulta. TilcAI es el registro (por `externalRef` = id de usuario): no hay tabla nueva. | La passkey del teléfono. TilcAI paga el despliegue y nunca es firmante. |

`GET /tilcai/status` (público) dice qué capacidades están activas y si TilcAI responde. Un error de TilcAI llega
a la app con su código (`TILCAI_VAULT_BUDGET`, `TILCAI_RELAY_RELAYED_TX_FAILED`…).

### Instalación del SDK

`tilcai-sdk` se instala desde npm (`"tilcai-sdk": "^0.1.0"`; el código importa `tilcai-sdk` y `tilcai-sdk/x402`). Sus
pares opcionales (`viem`, `@stellar/stellar-sdk`) solo se cargan si se usan; el backend ya depende de `viem`. Requiere Node.js ≥ 20.

### Pruebas

```bash
npm run test:e2e                  # incluye test/tilcai.e2e-spec.ts (relayer, vault y banderas con servidores simulados)
API_URL=http://127.0.0.1:3000 node scripts/tilcai-smoke.mjs   # ciclo real en Monad (≈ 6 min): faucet, depósito, SCA, juez x402, resolve por el relayer
```

El e2e desde la app de Android (Maestro) vive en `../willfolks-expo-app/e2e/onchain-tilcai.yaml`.

