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
- Portada ilustrada (castillo gótico, un dragón que cruza el cielo y, tras él, un caballero calavera a caballo) y efecto holográfico 3D en las cartas.
- **Torneos locales Pokémon** (`#/torneos`): cada jugador vincula su ID de Play! Pokémon y se inscribe; quien organiza
  genera las rondas (emparejamiento suizo por puntos, sin revanchas, bye rotativo) y captura resultados. Cada jugador
  ve en un aviso fijo contra quién juega y en qué mesa, su récord, su racha actual y su historial. El ID de jugador
  solo lo ve quien organiza.
- **Importar torneos oficiales desde TOM** (`#/torneos/importar`): se sube el archivo `.tdf` que genera TOM (el mismo
  que va a Play! Tools). Quedan sus rondas, top cut, resultados y la clasificación oficial, y el torneo aparece en el
  historial de cada jugador con su ID vinculado. Subido a mitad del evento, cada jugador ve su rival y mesa de la ronda.
  No se guardan fechas de nacimiento; los jugadores sin cuenta se muestran con nombre e inicial del apellido.
- **Buscador de cartas**: páginas con "Ver más", búsqueda por número ("Pikachu 25"), expansión, código de
  Yu-Gi-Oh! ("LOB-EN001") y nombre de Pokémon en español. Pokémon se busca en **TCGdex** (más completo y estable;
  resultados de la expansión más nueva a la más vieja usando las fechas de su API GraphQL); si TCGdex falla, se usa
  pokemontcg.io.
- Perfil público de cada vendedor con su contacto y sus cartas.
- **Accesorios TCG** (`#/accesorios`): micas, deck boxes, tapetes, carpetas, toploaders, dados y más. Se publican
  como las cartas (fotos, contacto, editar, marcar vendido) con categoría, marca, estado (nuevo, como nuevo, usado)
  y para qué juego (Pokémon, Yu-Gi-Oh! o universal). No se mezclan con el catálogo de cartas.
- **Decks** (`#/decks`): cada usuario arma y guarda los decks que quiera (máximo 100) de Pokémon o Yu-Gi-Oh!.
  Se buscan cartas con el mismo buscador que al vender, se ajustan cantidades y, en Yu-Gi-Oh!, la sección (principal,
  Extra o Side; las de fusión, sincronía, XYZ y link van solas al Extra Deck). Avisa en vivo si el deck no es legal
  (Pokémon: 60 cartas y máximo 4 copias salvo energía básica; Yu-Gi-Oh!: principal 40-60, Extra y Side hasta 15,
  máximo 3 copias) pero se guarda igual. Muestra el valor estimado en pesos (TCGplayer). Se puede importar o copiar
  la lista en texto (formato de Pokémon TCG Live: "4 Pikachu ex SVI 57"). Los decks son privados; si se marcan como
  públicos, cualquiera con el enlace los ve y aparecen en el perfil. Reglas en [public/deck-rules.js](public/deck-rules.js),
  compartidas por el navegador y el servidor.
- **Administradores** (`#/admin`): pueden editar, marcar como vendida o borrar cualquier publicación (también desde
  el detalle de la carta), gestionar cualquier torneo, editar los datos de las cuentas, nombrar o quitar
  administradores, suspender cuentas (no pueden entrar y sus publicaciones dejan de verse) y borrar cuentas con sus
  publicaciones y fotos (si la cuenta participa en torneos se suspende en lugar de borrarse). Un administrador no
  puede quitarse el rol ni suspenderse a sí mismo. El **primer administrador** se nombra con un script:
  ```
  node scripts/make-admin.mjs <usuario>                       # local (SQLite)
  STORAGE=aws TABLE_NAME=tcg-market-qa BUCKET_NAME=<bucket> AWS_REGION=us-east-1 node scripts/make-admin.mjs <usuario>   # QA
  ```
  Con `--remove` se quita el rol. Después, los administradores nombran a otros desde el panel.

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

### Dominio propio: `tcg.macai.com.mx`

Los endpoints de las Web Functions no aceptan dominios propios, así que se pone **CloudFront** delante
([infra/qa-domain.yaml](infra/qa-domain.yaml)) con un certificado de **ACM**. Sin caché: cada petición pasa a la app
(se reenvían cookies y query string, pero no el `Host`, porque la Web Function enruta por su propio dominio).
El dominio se toma de la variable del repo `QA_DOMAIN` (por defecto `tcg.macai.com.mx`). Pasos, una sola vez:

1. **Dar permisos al rol de despliegue** (ACM y CloudFront), con credenciales de administrador:
   ```
   aws cloudformation deploy --stack-name tcg-market-qa-github-deploy --template-file infra/github-deploy-role.yaml --capabilities CAPABILITY_NAMED_IAM --parameter-overrides OidcProviderArn=<ARN del proveedor OIDC>
   ```
   (usa el mismo nombre de stack con el que se creó el rol la primera vez).
2. **Desplegar** (push a `main` o "Run workflow"). El log del paso *Desplegar* muestra un registro **CNAME de validación**.
3. **En GoDaddy** → DNS de `macai.com.mx` → agregar ese CNAME (nombre `_xxxx.tcg`, valor `_yyyy.acm-validations.aws`).
4. Cuando AWS lo valide (minutos a un par de horas), **volver a desplegar**: se crea CloudFront y el log muestra
   su dominio (`dxxxx.cloudfront.net`).
5. **En GoDaddy** → agregar un CNAME `tcg` → `dxxxx.cloudfront.net`. En unos minutos responde `https://tcg.macai.com.mx`.

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
| GET/POST | /api/decks | Mis decks / crear deck |
| GET/PUT/DELETE | /api/decks/:id | Ver (dueño, admin o público), editar y borrar un deck |
| GET | /api/admin/overview | (admin) Resumen, cuentas y todas las publicaciones |
| PUT/DELETE | /api/admin/users/:id | (admin) Editar perfil, rol `is_admin`, suspensión `blocked` / borrar cuenta |
| GET | /healthz | Salud del servicio |
