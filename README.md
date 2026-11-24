# TCG Market

Mercado entre usuarios para cartas de **Pokémon** y **Yu-Gi-Oh!**: cada usuario crea su cuenta,
publica las cartas que vende y todos pueden ver qué cartas están en circulación.

## Cómo ejecutarla

Requiere Node.js 22.5 o superior (usa el SQLite integrado en Node).

```
npm install
npm start
```

Abre http://localhost:3000

## Qué incluye

- Registro e inicio de sesión (contraseñas con scrypt, sesión por cookie httpOnly).
- Catálogo público con filtro por juego, búsqueda, estado de la carta y orden por precio.
- Publicar / editar / borrar cartas, marcar como vendida.
- Fotos reales obligatorias (1 a 6 por carta), comprimidas en el navegador y guardadas en `uploads/photos`.
- Búsqueda de la carta exacta (edición y rareza) que rellena datos, imagen oficial y
  **precio estimado de mercado** (TCGplayer, USD) desde pokemontcg.io (respaldo: tcgdex.net) y ygoprodeck.com.
  Collectr no tiene API pública, por eso se usa TCGplayer como referencia.
  El precio se consulta en el servidor al guardar, así el vendedor no puede falsearlo.
- Estilo visual de taberna de fantasía (pergamino, madera, oro).
- Perfil público de cada vendedor con su contacto y sus cartas.

## Estructura

- `server.js` — API REST (Express)
- `db.js` — esquema SQLite (`data/tcg.db`)
- `public/` — frontend (HTML/CSS/JS sin framework)

## API

| Método | Ruta | Descripción |
|---|---|---|
| POST | /api/auth/register | Crear usuario |
| POST | /api/auth/login | Iniciar sesión (`login` = usuario o correo) |
| POST | /api/auth/logout | Cerrar sesión |
| GET/PUT | /api/auth/me | Usuario actual / editar perfil |
| GET | /api/listings?game=&q=&condition=&sort= | Cartas en circulación |
| GET | /api/listings/mine | Mis cartas |
| POST/PUT/DELETE | /api/listings/:id | Gestionar mis cartas |
| GET | /api/users/:username | Perfil público y sus cartas |
| GET | /api/stats | Totales por juego |
