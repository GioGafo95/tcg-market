# TCG Market

Mercado entre usuarios para cartas de **Pokémon** y **Yu-Gi-Oh!**: cada usuario crea su cuenta,
publica las cartas que vende y todos pueden ver qué cartas están en circulación.

## Cómo ejecutarla en local

Requiere Node.js 22.5 o superior (usa el SQLite integrado en Node).

```
npm install
npm start
```

Abre http://localhost:3000. En local los datos van a `data/tcg.db` (SQLite) y las fotos a `uploads/`.

## Qué incluye

- Registro e inicio de sesión (contraseñas con scrypt, sesión por cookie httpOnly).
- Catálogo público con filtro por juego, búsqueda, estado de la carta y orden por precio.
- Publicar / editar / borrar cartas, marcar como vendida.
- Fotos reales obligatorias (1 a 6 por carta), comprimidas en el navegador antes de subirlas.
- Búsqueda de la carta exacta (edición y rareza) que rellena datos, imagen oficial y
  **precio estimado de mercado** (TCGplayer, USD) desde pokemontcg.io (respaldo: tcgdex.net) y ygoprodeck.com.
  Collectr no tiene API pública, por eso se usa TCGplayer como referencia.
- Precios en **pesos mexicanos (MXN)**: el vendedor captura su precio en MXN y el precio de mercado (USD) se
  convierte con el tipo de cambio del día (Banco Central Europeo vía Frankfurter; respaldo open.er-api.com),
  guardado en caché 6 horas. Consulta el tipo de cambio en `GET /api/fx`.
  El precio se consulta en el servidor al guardar, así el vendedor no puede falsearlo.
- Portada ilustrada (castillo, dragón, atardecer) y efecto holográfico 3D en las cartas.
- Perfil público de cada vendedor con su contacto y sus cartas.

## Ambiente QA en AWS (serverless)

| Pieza | Servicio | Costo |
|---|---|---|
| App (Express) | AWS Lambda **Web Function**, endpoint HTTPS `qa` | Pago por uso; se apaga sola sin tráfico |
| Datos | Amazon **DynamoDB** (tabla única, bajo demanda) | Pago por petición, sin costo fijo |
| Fotos e imágenes oficiales | Amazon **S3** (bucket privado, URLs firmadas) | Centavos por GB |
| Logs | CloudWatch Logs, retención 14 días | Mínimo |

Topes de seguridad del endpoint: máximo 2 entornos en paralelo y 100 peticiones/segundo.

**Despliegue automático:** cada push a `main` ejecuta [.github/workflows/deploy-qa.yml](.github/workflows/deploy-qa.yml):
prueba la app en local (SQLite), y si pasa despliega a QA y verifica que responde. GitHub entra a AWS por OIDC
con el rol de `infra/github-deploy-role.yaml` (sin claves guardadas); solo el environment `qa`, limitado a `main`,
puede usarlo. Variables del repo: `AWS_QA_ROLE_ARN` y `QA_URL`. También se puede lanzar a mano desde la pestaña Actions.

**Desplegar / actualizar QA a mano** (requiere AWS CLI v2 reciente con credenciales):

```
node scripts/deploy-qa.mjs
```

El script crea o actualiza la infraestructura (`infra/qa.yaml`), empaqueta la app y publica una nueva
revisión; el endpoint `qa` sirve automáticamente la última revisión.

**Probar un ambiente de punta a punta:**

```
node scripts/smoke-test.mjs https://<endpoint-de-qa>
```

El almacenamiento se elige con la variable `STORAGE`: `aws` (DynamoDB `TABLE_NAME` + S3 `BUCKET_NAME`)
o, por defecto, local (SQLite + carpeta `uploads/`).

## Estructura

- `server.js` — API REST (Express)
- `cards.js` — búsqueda de cartas y precios de mercado
- `storage/` — datos (`sqlite.js` local, `dynamo.js` AWS) y archivos (`files.js`)
- `public/` — frontend (HTML/CSS/JS sin framework)
- `infra/qa.yaml` — CloudFormation del ambiente QA
- `scripts/` — despliegue y prueba de humo

## API

| Método | Ruta | Descripción |
|---|---|---|
| POST | /api/auth/register | Crear usuario |
| POST | /api/auth/login | Iniciar sesión (`login` = usuario o correo) |
| POST | /api/auth/logout | Cerrar sesión |
| GET/PUT | /api/auth/me | Usuario actual / editar perfil |
| GET | /api/lookup?game=&q= | Buscar carta en bases públicas (con precio estimado) |
| GET | /api/listings?game=&q=&condition=&sort= | Cartas en circulación |
| GET | /api/listings/mine | Mis cartas |
| POST/PUT/DELETE | /api/listings/:id | Gestionar mis cartas |
| PATCH | /api/listings/:id/status | Marcar vendida / disponible |
| GET | /api/users/:username | Perfil público y sus cartas |
| GET | /api/stats | Totales por juego |
| GET | /healthz | Salud del servicio |
